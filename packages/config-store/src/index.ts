import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_CONFIG_BYTES = 64 * 1024;
export const CONFIG_DIRECTORY_MODE = 0o700;
export const CONFIG_FILE_MODE = 0o600;

export type FileMutationQueue = <T>(filePath: string, mutation: () => Promise<T>) => Promise<T>;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Raised for every rejected config file. `message` always starts with the
 * config path followed by a stable, test-asserted reason.
 */
export class StrictConfigError extends Error {
	readonly configPath: string;

	constructor(configPath: string, reason: string) {
		super(`${configPath}: ${reason}`);
		this.name = "StrictConfigError";
		this.configPath = configPath;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function describeIoError(error: unknown): string {
	if (isNodeError(error) && typeof error.code === "string") return `filesystem error ${error.code}`;
	return "filesystem operation failed";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeysOnly(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const keys = [...expected].sort();
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		actual.length === keys.length &&
		actual.every((key, index) => key === keys[index])
	);
}

/**
 * Shared record/key checks for schema validators. Kept next to the reader so
 * every package validates JSON shapes with identical semantics.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value);
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return hasExactKeysOnly(value, expected);
}

function fail(configPath: string, reason: string): never {
	throw new StrictConfigError(configPath, reason);
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

async function writeDefaultConfig(configPath: string, defaultText: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(configPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, CONFIG_FILE_MODE);
		await handle.writeFile(defaultText, "utf8");
		await handle.sync();
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") return false;
		return fail(configPath, `cannot create default config (${describeIoError(error)})`);
	} finally {
		await handle?.close();
	}
}

export interface InitializeStrictConfigOptions<T> {
	readonly agentDir: string;
	readonly directoryName: string;
	readonly fileName?: string;
	/** Inline default file contents; exactly one of defaultText/defaultTextFile must be set. */
	readonly defaultText?: string;
	/** Default file contents are read from this packaged path when defaultText is absent. */
	readonly defaultTextFile?: string;
	readonly validate: (value: unknown, configPath: string) => T;
	readonly withFileMutationQueue: FileMutationQueue;
}

export interface StrictConfigResult<T> {
	readonly configDir: string;
	readonly configPath: string;
	readonly config: T;
	readonly created: boolean;
}

/**
 * Prepare, create, read, and validate one extension's strict JSON config in a
 * single serialized mutation: directory with 0700, default file created
 * exclusively with 0600 when absent, then a TOCTOU-guarded strict-JSON read
 * handed to `validate`.
 */
export async function initializeStrictConfig<T>(
	options: InitializeStrictConfigOptions<T>,
): Promise<StrictConfigResult<T>> {
	const fileName = options.fileName ?? "config.json";
	const configDir = join(options.agentDir, options.directoryName);
	const configPath = join(configDir, fileName);

	return options.withFileMutationQueue(configPath, async () => {
		try {
			await mkdir(configDir, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
			await chmod(configDir, CONFIG_DIRECTORY_MODE);
		} catch (error) {
			fail(configPath, `cannot prepare config directory (${describeIoError(error)})`);
		}

		let defaultText: string;
		if (options.defaultText !== undefined) {
			defaultText = options.defaultText;
		} else if (options.defaultTextFile !== undefined) {
			try {
				defaultText = await readFile(options.defaultTextFile, "utf8");
			} catch (error) {
				fail(configPath, `cannot read package default config (${describeIoError(error)})`);
			}
		} else {
			fail(configPath, "one of defaultText or defaultTextFile is required");
		}

		const created = await writeDefaultConfig(configPath, defaultText);
		const parsed = await readStrictJson(configPath);
		const config = options.validate(parsed, configPath);
		return Object.freeze({ configDir, configPath, config, created });
	});
}
