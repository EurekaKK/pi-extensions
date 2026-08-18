import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIRECTORY_MODE,
	CONFIG_DIRECTORY_NAME,
	CONFIG_FILE_MODE,
	CONFIG_FILE_NAME,
	CONFIG_VERSION,
	MAX_CONFIG_BYTES,
} from "./constants.js";

export type SearchDepth = "basic" | "advanced" | "fast" | "ultra-fast";
export type ExtractDepth = "basic" | "advanced";

export interface TavilyConfigV1 {
	readonly version: 1;
	readonly searchDepth: SearchDepth;
	readonly extractDepth: ExtractDepth;
	readonly maxResults: number;
	readonly searchTimeoutMs: number;
	readonly extractTimeoutMs: number;
}

export type FileMutationQueue = <T>(filePath: string, mutation: () => Promise<T>) => Promise<T>;

export interface InitializeTavilyConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export interface InitializedTavilyConfig {
	readonly configDir: string;
	readonly configPath: string;
	readonly config: TavilyConfigV1;
	readonly created: boolean;
}

export const DEFAULT_CONFIG: TavilyConfigV1 = Object.freeze({
	version: CONFIG_VERSION,
	searchDepth: "basic",
	extractDepth: "basic",
	maxResults: 5,
	searchTimeoutMs: 40_000,
	extractTimeoutMs: 40_000,
});

const PACKAGE_DEFAULT_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../defaults/config.json");
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const SEARCH_DEPTHS: readonly SearchDepth[] = ["basic", "advanced", "fast", "ultra-fast"];
const EXTRACT_DEPTHS: readonly ExtractDepth[] = ["basic", "advanced"];
const CONFIG_KEYS = ["extractDepth", "extractTimeoutMs", "maxResults", "searchDepth", "searchTimeoutMs", "version"];

export class TavilyConfigurationError extends Error {
	readonly configPath: string;

	constructor(configPath: string, reason: string) {
		super(`${configPath}: ${reason}`);
		this.name = "TavilyConfigurationError";
		this.configPath = configPath;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const keys = [...expected].sort();
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		actual.length === keys.length &&
		actual.every((key, index) => key === keys[index])
	);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function describeIoError(error: unknown): string {
	if (isNodeError(error) && typeof error.code === "string") return `filesystem error ${error.code}`;
	return "filesystem operation failed";
}

function fail(configPath: string, reason: string): never {
	throw new TavilyConfigurationError(configPath, reason);
}

function isSearchDepth(value: unknown): value is SearchDepth {
	return typeof value === "string" && SEARCH_DEPTHS.includes(value as SearchDepth);
}

function isExtractDepth(value: unknown): value is ExtractDepth {
	return typeof value === "string" && EXTRACT_DEPTHS.includes(value as ExtractDepth);
}

export function validateTavilyConfig(value: unknown, configPath: string): TavilyConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, CONFIG_KEYS)) {
		fail(configPath, "top-level config contains unknown or missing fields");
	}
	if (value.version !== CONFIG_VERSION) fail(configPath, `version must equal ${CONFIG_VERSION}`);
	if (!isSearchDepth(value.searchDepth)) fail(configPath, "searchDepth must be basic, advanced, fast, or ultra-fast");
	if (!isExtractDepth(value.extractDepth)) fail(configPath, "extractDepth must be basic or advanced");
	if (
		typeof value.maxResults !== "number" ||
		!Number.isSafeInteger(value.maxResults) ||
		value.maxResults < 1 ||
		value.maxResults > 20
	) {
		fail(configPath, "maxResults must be a safe integer from 1 to 20");
	}
	if (
		typeof value.searchTimeoutMs !== "number" ||
		!Number.isSafeInteger(value.searchTimeoutMs) ||
		value.searchTimeoutMs < 1
	) {
		fail(configPath, "searchTimeoutMs must be a positive safe integer");
	}
	if (
		typeof value.extractTimeoutMs !== "number" ||
		!Number.isSafeInteger(value.extractTimeoutMs) ||
		value.extractTimeoutMs < 1
	) {
		fail(configPath, "extractTimeoutMs must be a positive safe integer");
	}
	return Object.freeze({
		version: CONFIG_VERSION,
		searchDepth: value.searchDepth,
		extractDepth: value.extractDepth,
		maxResults: value.maxResults,
		searchTimeoutMs: value.searchTimeoutMs,
		extractTimeoutMs: value.extractTimeoutMs,
	});
}

async function readStrictJson(configPath: string): Promise<unknown> {
	let before: Awaited<ReturnType<typeof lstat>>;
	try {
		before = await lstat(configPath);
	} catch (error) {
		fail(configPath, `cannot inspect config (${describeIoError(error)})`);
	}
	if (!before.isFile()) fail(configPath, "config path must be a regular file");
	if (before.size > MAX_CONFIG_BYTES) fail(configPath, `file exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`);

	let bytes: Uint8Array;
	try {
		bytes = await readFile(configPath);
	} catch (error) {
		fail(configPath, `cannot read config (${describeIoError(error)})`);
	}
	if (bytes.byteLength > MAX_CONFIG_BYTES) fail(configPath, `file exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`);

	let after: Awaited<ReturnType<typeof lstat>>;
	try {
		after = await lstat(configPath);
	} catch (error) {
		fail(configPath, `cannot re-check config (${describeIoError(error)})`);
	}
	if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
		fail(configPath, "config changed while it was being read");
	}

	let text: string;
	try {
		text = TEXT_DECODER.decode(bytes);
	} catch {
		fail(configPath, "file is not valid UTF-8");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return fail(configPath, "file is not strict JSON");
	}
}

async function createDefaultConfig(configPath: string): Promise<boolean> {
	let packaged: string;
	try {
		packaged = await readFile(PACKAGE_DEFAULT_CONFIG_PATH, "utf8");
	} catch (error) {
		return fail(configPath, `cannot read package default config (${describeIoError(error)})`);
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(configPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, CONFIG_FILE_MODE);
		await handle.writeFile(packaged, "utf8");
		await handle.sync();
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") return false;
		return fail(configPath, `cannot create default config (${describeIoError(error)})`);
	} finally {
		await handle?.close();
	}
}

export async function initializeTavilyConfig(options: InitializeTavilyConfigOptions): Promise<InitializedTavilyConfig> {
	const configDir = join(options.agentDir, CONFIG_DIRECTORY_NAME);
	const configPath = join(configDir, CONFIG_FILE_NAME);
	return options.withFileMutationQueue(configPath, async () => {
		try {
			await mkdir(configDir, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
			await chmod(configDir, CONFIG_DIRECTORY_MODE);
		} catch (error) {
			fail(configPath, `cannot prepare config directory (${describeIoError(error)})`);
		}
		const created = await createDefaultConfig(configPath);
		const parsed = await readStrictJson(configPath);
		const config = validateTavilyConfig(parsed, configPath);
		return Object.freeze({ configDir, configPath, config, created });
	});
}
