import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_CONFIG_BYTES = 64 * 1024;
export const CONFIG_DIRECTORY_MODE = 0o700;
export const CONFIG_FILE_MODE = 0o600;

export type FileMutationQueue = <T>(filePath: string, mutation: () => Promise<T>) => Promise<T>;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Stable, machine-readable failures raised by {@link readStrictJsonFile} and
 * reused by every strict-JSON consumer for classification without parsing
 * human-readable messages. `invalid` is the catch-all default for schema
 * validation errors raised by callers' `validate` functions.
 */
export type StrictConfigErrorReason =
	| "missing"
	| "inspect-failed"
	| "not-regular-file"
	| "over-limit"
	| "read-failed"
	| "changed-during-read"
	| "invalid-utf8"
	| "invalid-json"
	| "aborted"
	| "invalid";

/**
 * Raised for every rejected config file. `message` always starts with the
 * config path followed by a stable, test-asserted reason. `reason` carries the
 * machine-readable failure kind for callers that must classify errors.
 */
export class StrictConfigError extends Error {
	readonly configPath: string;
	readonly reason: StrictConfigErrorReason;

	constructor(configPath: string, message: string, reason: StrictConfigErrorReason = "invalid") {
		super(`${configPath}: ${message}`);
		this.name = "StrictConfigError";
		this.configPath = configPath;
		this.reason = reason;
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

function abort(filePath: string, signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) {
		throw new StrictConfigError(filePath, "read was aborted", "aborted");
	}
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof Error && error.name === "AbortError") ||
		(isNodeError(error) && (error.code === "ABORT_ERR" || error.code === "ECANCELED"))
	);
}

/**
 * Additive, generic strict-JSON reader shared by every config/store consumer.
 *
 * Reads one regular file with bounded bytes (stat before + byte-length after),
 * guards against replacement while reading via a second stat, decodes with
 * fatal UTF-8, and requires strict JSON. Failures throw {@link StrictConfigError}
 * with a stable `reason` so callers can classify missing / unreadable / corrupt
 * / over-limit / aborted without parsing messages. `signal`, when provided, is
 * honored at every await boundary.
 */
export interface ReadStrictJsonFileOptions {
	readonly filePath: string;
	readonly maxBytes: number;
	/** Human label used in diagnostic messages; defaults to `"config"`. */
	readonly label?: string;
	readonly signal?: AbortSignal;
}

export async function readStrictJsonFile(options: ReadStrictJsonFileOptions): Promise<unknown> {
	const { filePath, maxBytes, signal } = options;
	const label = options.label ?? "config";
	abort(filePath, signal);

	let before: Awaited<ReturnType<typeof lstat>>;
	try {
		before = await lstat(filePath);
	} catch (error) {
		if (signal?.aborted === true || isAbortError(error)) {
			throw new StrictConfigError(filePath, "read was aborted", "aborted");
		}
		if (isNodeError(error) && error.code === "ENOENT") {
			throw new StrictConfigError(filePath, `cannot inspect ${label} (filesystem error ENOENT)`, "missing");
		}
		throw new StrictConfigError(filePath, `cannot inspect ${label} (${describeIoError(error)})`, "inspect-failed");
	}
	if (!before.isFile())
		throw new StrictConfigError(filePath, `${label} path must be a regular file`, "not-regular-file");
	if (before.size > maxBytes)
		throw new StrictConfigError(filePath, `file exceeds ${maxBytes} UTF-8 bytes`, "over-limit");
	abort(filePath, signal);

	let bytes: Uint8Array;
	try {
		bytes = signal === undefined ? await readFile(filePath) : await readFile(filePath, { signal });
	} catch (error) {
		if (signal?.aborted === true || isAbortError(error)) {
			throw new StrictConfigError(filePath, "read was aborted", "aborted");
		}
		throw new StrictConfigError(filePath, `cannot read ${label} (${describeIoError(error)})`, "read-failed");
	}
	if (bytes.byteLength > maxBytes)
		throw new StrictConfigError(filePath, `file exceeds ${maxBytes} UTF-8 bytes`, "over-limit");
	abort(filePath, signal);

	let after: Awaited<ReturnType<typeof lstat>>;
	try {
		after = await lstat(filePath);
	} catch (error) {
		if (signal?.aborted === true || isAbortError(error)) {
			throw new StrictConfigError(filePath, "read was aborted", "aborted");
		}
		throw new StrictConfigError(filePath, `cannot re-check ${label} (${describeIoError(error)})`, "inspect-failed");
	}
	abort(filePath, signal);
	if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
		throw new StrictConfigError(filePath, `${label} changed while it was being read`, "changed-during-read");
	}

	let text: string;
	try {
		text = TEXT_DECODER.decode(bytes);
	} catch {
		throw new StrictConfigError(filePath, "file is not valid UTF-8", "invalid-utf8");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new StrictConfigError(filePath, "file is not strict JSON", "invalid-json");
	}
}

/**
 * Bounded strict-JSON read for a config file, applying the config byte budget
 * and the default `config` label for stable, unchanged diagnostics.
 */
async function readStrictJson(configPath: string): Promise<unknown> {
	return readStrictJsonFile({ filePath: configPath, maxBytes: MAX_CONFIG_BYTES });
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
