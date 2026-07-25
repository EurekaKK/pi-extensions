import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ThinkingLevelV1 } from "./contracts.js";

export const CONFIG_DIRECTORY_NAME = "sub-agent";
export const CONFIG_FILE_NAME = "config.json";
export const MAX_CONFIG_BYTES = 64 * 1024;
export const CONFIG_DIRECTORY_MODE = 0o700;
export const CONFIG_FILE_MODE = 0o600;

export interface FixedModelConfigV1 {
	provider: string;
	id: string;
}

export type ModelConfigV1 = "inherit" | FixedModelConfigV1;
export type ThinkingConfigV1 = "inherit" | ThinkingLevelV1;

export interface SubagentConfigV1 {
	version: 1;
	model: ModelConfigV1;
	thinkingLevel: ThinkingConfigV1;
	requiredExtensionPaths: string[];
}

const EMPTY_REQUIRED_EXTENSION_PATHS: string[] = [];
Object.freeze(EMPTY_REQUIRED_EXTENSION_PATHS);

export const DEFAULT_CONFIG: SubagentConfigV1 = Object.freeze({
	version: 1,
	model: "inherit",
	thinkingLevel: "inherit",
	requiredExtensionPaths: EMPTY_REQUIRED_EXTENSION_PATHS,
});

const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type FileMutationQueue = <T>(filePath: string, mutation: () => Promise<T>) => Promise<T>;
export type CanonicalizePath = (filePath: string) => Promise<string>;

export interface InitializeConfigOptions {
	agentDir: string;
	withFileMutationQueue: FileMutationQueue;
	canonicalizePath?: CanonicalizePath;
}

export interface InitializedConfig {
	configDir: string;
	configPath: string;
	config: SubagentConfigV1;
	created: boolean;
}

export class ConfigurationError extends Error {
	readonly configPath: string;
	readonly field: string;
	readonly reason: string;

	constructor(configPath: string, field: string, reason: string) {
		super(`${configPath}: ${field}: ${reason}`);
		this.name = "ConfigurationError";
		this.configPath = configPath;
		this.field = field;
		this.reason = reason;
	}
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function describeIoError(error: unknown): string {
	if (isNodeError(error) && typeof error.code === "string") return `filesystem error ${error.code}`;
	return "filesystem operation failed";
}

function fail(configPath: string, field: string, reason: string): never {
	throw new ConfigurationError(configPath, field, reason);
}

function requireExactObject(
	value: unknown,
	configPath: string,
	field: string,
	requiredKeys: readonly string[],
): JsonRecord {
	if (!isJsonRecord(value)) fail(configPath, field, "must be a JSON object");
	for (const key of Object.keys(value)) {
		if (!requiredKeys.includes(key)) fail(configPath, `${field}.${key}`, "unknown field");
	}
	for (const key of requiredKeys) {
		if (!Object.hasOwn(value, key)) fail(configPath, `${field}.${key}`, "required field is missing");
	}
	return value;
}

function requireNonBlankString(value: unknown, configPath: string, field: string): string {
	if (typeof value !== "string") fail(configPath, field, "must be a string");
	if (value.trim().length === 0) fail(configPath, field, "must be non-blank after trimming");
	return value;
}

function validateModel(value: unknown, configPath: string): ModelConfigV1 {
	if (value === "inherit") return value;
	const model = requireExactObject(value, configPath, "model", ["provider", "id"]);
	return Object.freeze({
		provider: requireNonBlankString(model.provider, configPath, "model.provider"),
		id: requireNonBlankString(model.id, configPath, "model.id"),
	});
}

function validateThinking(value: unknown, configPath: string): ThinkingConfigV1 {
	if (value === "inherit") return value;
	if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
		fail(
			configPath,
			"thinkingLevel",
			'must be "inherit", "off", "minimal", "low", "medium", "high", "xhigh", or "max"',
		);
	}
	return value as ThinkingLevelV1;
}

async function validateRequiredPaths(
	value: unknown,
	configPath: string,
	canonicalizePath: CanonicalizePath,
): Promise<string[]> {
	if (!Array.isArray(value)) fail(configPath, "requiredExtensionPaths", "must be an array");
	const literalPaths = value.map((candidate, index) =>
		requireNonBlankString(candidate, configPath, `requiredExtensionPaths[${index}]`),
	);
	if (new Set(literalPaths).size !== literalPaths.length) {
		fail(configPath, "requiredExtensionPaths", "must not contain duplicate paths");
	}

	const canonicalPaths: string[] = [];
	for (const [index, filePath] of literalPaths.entries()) {
		const field = `requiredExtensionPaths[${index}]`;
		if (!isAbsolute(filePath)) fail(configPath, field, "must be an absolute path");
		let canonicalPath: string;
		try {
			canonicalPath = await canonicalizePath(filePath);
		} catch (error) {
			fail(configPath, field, `cannot canonicalize an existing path (${describeIoError(error)})`);
		}
		let metadata: Awaited<ReturnType<typeof stat>>;
		try {
			metadata = await stat(canonicalPath);
		} catch (error) {
			fail(configPath, field, `cannot inspect the canonical path (${describeIoError(error)})`);
		}
		if (!metadata.isFile()) fail(configPath, field, "must resolve to a regular file-backed extension entry");
		canonicalPaths.push(canonicalPath);
	}

	if (new Set(canonicalPaths).size !== canonicalPaths.length) {
		fail(configPath, "requiredExtensionPaths", "contains paths that resolve to the same canonical entry");
	}
	return Object.freeze(canonicalPaths) as string[];
}

export async function validateConfig(
	value: unknown,
	configPath = CONFIG_FILE_NAME,
	canonicalizePath: CanonicalizePath = realpath,
): Promise<SubagentConfigV1> {
	const root = requireExactObject(value, configPath, "$", [
		"version",
		"model",
		"thinkingLevel",
		"requiredExtensionPaths",
	]);
	if (root.version !== 1) fail(configPath, "version", "must equal 1");
	const model = validateModel(root.model, configPath);
	const thinkingLevel = validateThinking(root.thinkingLevel, configPath);
	const requiredExtensionPaths = await validateRequiredPaths(root.requiredExtensionPaths, configPath, canonicalizePath);
	return Object.freeze({
		version: 1,
		model,
		thinkingLevel,
		requiredExtensionPaths,
	});
}

async function readStrictJson(configPath: string): Promise<unknown> {
	let before: Awaited<ReturnType<typeof lstat>>;
	try {
		before = await lstat(configPath);
	} catch (error) {
		throw new ConfigurationError(configPath, "$", `cannot inspect config (${describeIoError(error)})`);
	}
	if (!before.isFile()) fail(configPath, "$", "config path must be a regular file");
	if (before.size > MAX_CONFIG_BYTES) fail(configPath, "$", `file exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`);

	let bytes: Uint8Array;
	try {
		bytes = await readFile(configPath);
	} catch (error) {
		throw new ConfigurationError(configPath, "$", `cannot read config (${describeIoError(error)})`);
	}
	if (bytes.byteLength > MAX_CONFIG_BYTES) fail(configPath, "$", `file exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`);

	let after: Awaited<ReturnType<typeof lstat>>;
	try {
		after = await lstat(configPath);
	} catch (error) {
		throw new ConfigurationError(configPath, "$", `cannot re-check config (${describeIoError(error)})`);
	}
	if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
		fail(configPath, "$", "config changed while it was being read");
	}

	let text: string;
	try {
		text = TEXT_DECODER.decode(bytes);
	} catch {
		fail(configPath, "$", "file is not valid UTF-8");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		fail(configPath, "$", "file is not strict JSON");
	}
	return parsed;
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
		throw new ConfigurationError(configPath, "$", `cannot create default config (${describeIoError(error)})`);
	} finally {
		await handle?.close();
	}
}

export function getConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

export async function initializeConfig(options: InitializeConfigOptions): Promise<InitializedConfig> {
	const configDir = join(options.agentDir, CONFIG_DIRECTORY_NAME);
	const configPath = join(configDir, CONFIG_FILE_NAME);
	const canonicalizePath = options.canonicalizePath ?? realpath;

	return options.withFileMutationQueue(configPath, async () => {
		try {
			await mkdir(configDir, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
			await chmod(configDir, CONFIG_DIRECTORY_MODE);
		} catch (error) {
			throw new ConfigurationError(configPath, "$", `cannot prepare config directory (${describeIoError(error)})`);
		}

		const created = await createDefaultConfig(configPath);
		const parsed = await readStrictJson(configPath);
		const config = await validateConfig(parsed, configPath, canonicalizePath);
		return Object.freeze({ configDir, configPath, config, created });
	});
}
