import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

export const GOAL_CONFIG_DIRECTORY_NAME = "goal";
export const GOAL_CONFIG_FILE_NAME = "config.json";
export const GOAL_CONFIG_VERSION = 1;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const CONFIG_DIRECTORY_MODE = 0o700;
export const CONFIG_FILE_MODE = 0o600;

export interface GoalConfigV1 {
	readonly version: 1;
	readonly defaultMaxGoalRounds: number;
	readonly blockedAfterConsecutiveRounds: number;
}

export type FileMutationQueue = <T>(filePath: string, mutation: () => Promise<T>) => Promise<T>;

export interface InitializeGoalConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export interface InitializedGoalConfig {
	readonly configDir: string;
	readonly configPath: string;
	readonly config: GoalConfigV1;
	readonly created: boolean;
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export const DEFAULT_CONFIG: GoalConfigV1 = Object.freeze({
	version: GOAL_CONFIG_VERSION,
	defaultMaxGoalRounds: 256,
	blockedAfterConsecutiveRounds: 3,
});

const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

export class GoalConfigurationError extends Error {
	readonly configPath: string;

	constructor(configPath: string, reason: string) {
		super(`${configPath}: ${reason}`);
		this.name = "GoalConfigurationError";
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
	throw new GoalConfigurationError(configPath, reason);
}

export function validateGoalConfig(value: unknown, configPath: string): GoalConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["blockedAfterConsecutiveRounds", "defaultMaxGoalRounds", "version"])) {
		fail(configPath, "top-level config contains unknown or missing fields");
	}
	if (value.version !== GOAL_CONFIG_VERSION) fail(configPath, `version must equal ${GOAL_CONFIG_VERSION}`);
	if (
		typeof value.defaultMaxGoalRounds !== "number" ||
		!Number.isSafeInteger(value.defaultMaxGoalRounds) ||
		value.defaultMaxGoalRounds < 1
	) {
		fail(configPath, "defaultMaxGoalRounds must be a positive safe integer");
	}
	if (
		typeof value.blockedAfterConsecutiveRounds !== "number" ||
		!Number.isSafeInteger(value.blockedAfterConsecutiveRounds) ||
		value.blockedAfterConsecutiveRounds < 1
	) {
		fail(configPath, "blockedAfterConsecutiveRounds must be a positive safe integer");
	}
	return Object.freeze({
		version: GOAL_CONFIG_VERSION,
		defaultMaxGoalRounds: value.defaultMaxGoalRounds,
		blockedAfterConsecutiveRounds: value.blockedAfterConsecutiveRounds,
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

export function getGoalConfigPath(agentDir: string): string {
	return join(agentDir, GOAL_CONFIG_DIRECTORY_NAME, GOAL_CONFIG_FILE_NAME);
}

export async function initializeGoalConfig(options: InitializeGoalConfigOptions): Promise<InitializedGoalConfig> {
	const configDir = join(options.agentDir, GOAL_CONFIG_DIRECTORY_NAME);
	const configPath = join(configDir, GOAL_CONFIG_FILE_NAME);
	return options.withFileMutationQueue(configPath, async () => {
		try {
			await mkdir(configDir, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
			await chmod(configDir, CONFIG_DIRECTORY_MODE);
		} catch (error) {
			fail(configPath, `cannot prepare config directory (${describeIoError(error)})`);
		}
		const created = await createDefaultConfig(configPath);
		const parsed = await readStrictJson(configPath);
		const config = validateGoalConfig(parsed, configPath);
		return Object.freeze({ configDir, configPath, config, created });
	});
}
