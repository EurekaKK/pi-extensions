import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME, CONFIG_VERSION, PRUNE_MARKER } from "./constants.js";

export const MAX_CONFIG_BYTES = 64 * 1024;
export const CONFIG_DIRECTORY_MODE = 0o700;
export const CONFIG_FILE_MODE = 0o600;

export interface PruneConfigV1 {
	readonly thresholdChars: number;
	readonly headChars: number;
	readonly tailChars: number;
}

export interface SpillConfigV1 {
	readonly maxInlineBytes: number;
}

export interface ContextManagementConfigV1 {
	readonly version: 1;
	readonly auto: boolean;
	readonly thresholdRatio: number;
	readonly retainRatio: number;
	readonly maxTokens: number;
	readonly compactionRetries: number;
	readonly prune: PruneConfigV1;
	readonly spill: SpillConfigV1;
}

export type FileMutationQueue = <T>(filePath: string, mutation: () => Promise<T>) => Promise<T>;

export interface InitializeContextManagementConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export interface InitializedContextManagementConfig {
	readonly configDir: string;
	readonly configPath: string;
	readonly config: ContextManagementConfigV1;
	readonly created: boolean;
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export const DEFAULT_CONFIG: ContextManagementConfigV1 = Object.freeze({
	version: CONFIG_VERSION,
	auto: true,
	thresholdRatio: 0.8,
	retainRatio: 0.16,
	maxTokens: 8_192,
	compactionRetries: 1,
	prune: Object.freeze({
		thresholdChars: 8_192,
		headChars: 4_096,
		tailChars: 1_024,
	}),
	spill: Object.freeze({
		maxInlineBytes: 50_000,
	}),
});

const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

export class ContextManagementConfigurationError extends Error {
	readonly configPath: string;

	constructor(configPath: string, reason: string) {
		super(`${configPath}: ${reason}`);
		this.name = "ContextManagementConfigurationError";
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
	throw new ContextManagementConfigurationError(configPath, reason);
}

function assertRatio(configPath: string, field: string, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
		fail(configPath, `${field} must be a number in (0, 1]`);
	}
}

function assertNonNegativeInteger(configPath: string, field: string, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail(configPath, `${field} must be a non-negative safe integer`);
	}
}

function assertPositiveInteger(configPath: string, field: string, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		fail(configPath, `${field} must be a positive safe integer`);
	}
}

function validatePruneConfig(value: unknown, configPath: string): PruneConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["headChars", "tailChars", "thresholdChars"])) {
		fail(configPath, "prune must contain exactly thresholdChars, headChars, and tailChars");
	}
	assertPositiveInteger(configPath, "prune.thresholdChars", value.thresholdChars);
	assertNonNegativeInteger(configPath, "prune.headChars", value.headChars);
	assertNonNegativeInteger(configPath, "prune.tailChars", value.tailChars);
	const emittedChars = value.headChars + Array.from(PRUNE_MARKER).length + value.tailChars;
	if (emittedChars > value.thresholdChars) {
		fail(
			configPath,
			`prune.headChars + marker + prune.tailChars (${emittedChars}) must be at most prune.thresholdChars (${value.thresholdChars})`,
		);
	}
	return Object.freeze({
		thresholdChars: value.thresholdChars,
		headChars: value.headChars,
		tailChars: value.tailChars,
	});
}

function validateSpillConfig(value: unknown, configPath: string): SpillConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["maxInlineBytes"])) {
		fail(configPath, "spill must contain exactly maxInlineBytes");
	}
	assertNonNegativeInteger(configPath, "spill.maxInlineBytes", value.maxInlineBytes);
	return Object.freeze({ maxInlineBytes: value.maxInlineBytes });
}

export function validateContextManagementConfig(value: unknown, configPath: string): ContextManagementConfigV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"auto",
			"compactionRetries",
			"maxTokens",
			"prune",
			"retainRatio",
			"spill",
			"thresholdRatio",
			"version",
		])
	) {
		fail(configPath, "top-level config contains unknown or missing fields");
	}
	if (value.version !== CONFIG_VERSION) fail(configPath, `version must equal ${CONFIG_VERSION}`);
	if (typeof value.auto !== "boolean") fail(configPath, "auto must be a boolean");
	assertRatio(configPath, "thresholdRatio", value.thresholdRatio);
	assertRatio(configPath, "retainRatio", value.retainRatio);
	if (value.retainRatio >= value.thresholdRatio) {
		fail(configPath, "retainRatio must be less than thresholdRatio");
	}
	assertPositiveInteger(configPath, "maxTokens", value.maxTokens);
	assertNonNegativeInteger(configPath, "compactionRetries", value.compactionRetries);
	const prune = validatePruneConfig(value.prune, configPath);
	const spill = validateSpillConfig(value.spill, configPath);
	return Object.freeze({
		version: CONFIG_VERSION,
		auto: value.auto,
		thresholdRatio: value.thresholdRatio,
		retainRatio: value.retainRatio,
		maxTokens: value.maxTokens,
		compactionRetries: value.compactionRetries,
		prune,
		spill,
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
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(configPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, CONFIG_FILE_MODE);
		await handle.writeFile(DEFAULT_CONFIG_TEXT, "utf8");
		await handle.sync();
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") return false;
		return fail(configPath, `cannot create default config (${describeIoError(error)})`);
	} finally {
		await handle?.close();
	}
}

export function getContextManagementConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

export async function initializeContextManagementConfig(
	options: InitializeContextManagementConfigOptions,
): Promise<InitializedContextManagementConfig> {
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
		const config = validateContextManagementConfig(parsed, configPath);
		return Object.freeze({ configDir, configPath, config, created });
	});
}
