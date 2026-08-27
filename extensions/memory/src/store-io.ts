import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MemoryStoreConfigV1 } from "./config.js";
import {
	MEMORY_ABORTED,
	MEMORY_IGNORE_MARKER_FAILED,
	MEMORY_STORE_IGNORE_CONTENT,
	MEMORY_STORE_IGNORE_FILE_NAME,
	MEMORY_STORE_INIT_FAILED,
	MEMORY_STORE_OVER_LIMIT,
	MEMORY_WRITE_FAILED,
} from "./constants.js";
import { isErrnoException, MemoryError } from "./errors.js";

/**
 * Narrow filesystem seam owned by the Store commit path. Fault injection in
 * tests replaces individual primitives; Store/provider internals stay private
 * and tests observe files and tool/command results.
 */
export interface MemoryFileHandle {
	readonly writeFile: (data: string, encoding: "utf8") => Promise<void>;
	readonly sync: () => Promise<void>;
	readonly close: () => Promise<void>;
}

export interface MemoryStoreFs {
	readonly mkdir: (path: string, options: { readonly recursive?: boolean; readonly mode?: number }) => Promise<unknown>;
	readonly chmod: (path: string, mode: number) => Promise<unknown>;
	readonly readFileText: (path: string) => Promise<string>;
	/** Create a file exclusively (O_CREAT|O_EXCL|O_WRONLY) with owner-only mode. */
	readonly openExclusive: (path: string) => Promise<MemoryFileHandle>;
	readonly rename: (from: string, to: string) => Promise<unknown>;
	readonly remove: (path: string) => Promise<unknown>;
}

export function createMemoryStoreFs(): MemoryStoreFs {
	return {
		mkdir: (path, options) => mkdir(path, options),
		chmod: (path, mode) => chmod(path, mode),
		readFileText: (path) => readFile(path, "utf8"),
		openExclusive: async (path) => {
			const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
			return {
				writeFile: (data, encoding) => handle.writeFile(data, encoding),
				sync: () => handle.sync(),
				close: () => handle.close(),
			};
		},
		rename: (from, to) => rename(from, to),
		remove: (path) => rm(path, { force: true }),
	};
}

export const MEMORY_STORE_DIRECTORY_MODE = 0o700;
export const MEMORY_STORE_FILE_MODE = 0o600;

function describeIo(error: unknown): string {
	if (isErrnoException(error) && typeof error.code === "string") return `filesystem error ${error.code}`;
	return "filesystem operation failed";
}

function isNotFound(error: unknown): boolean {
	return isErrnoException(error) && error.code === "ENOENT";
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof Error && error.name === "AbortError") || (isErrnoException(error) && error.code === "ABORT_ERR")
	);
}

function abort(path: string, signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) {
		throw new MemoryError(MEMORY_ABORTED, `memory operation was aborted before touching ${path}`);
	}
}

/**
 * Prepare the Memory Store directory with owner-only permissions. Idempotent;
 * used only inside the stored commit transaction.
 */
export async function ensureMemoryStoreDirectory(
	fs: MemoryStoreFs,
	storeDir: string,
	signal?: AbortSignal,
): Promise<void> {
	abort(storeDir, signal);
	try {
		await fs.mkdir(storeDir, { recursive: true, mode: MEMORY_STORE_DIRECTORY_MODE });
		await fs.chmod(storeDir, MEMORY_STORE_DIRECTORY_MODE);
	} catch (error) {
		throw new MemoryError(MEMORY_STORE_INIT_FAILED, `cannot prepare memory store directory (${describeIo(error)})`);
	}
}

/** Tighten an existing Store file to owner-only permissions before a no-op or replacement. */
export async function ensureMemoryStoreFileMode(
	fs: MemoryStoreFs,
	storePath: string,
	signal?: AbortSignal,
): Promise<void> {
	abort(storePath, signal);
	try {
		await fs.chmod(storePath, MEMORY_STORE_FILE_MODE);
	} catch (error) {
		throw new MemoryError(MEMORY_WRITE_FAILED, `cannot secure memory store permissions (${describeIo(error)})`);
	}
}

export type IgnoreMarkerState = "created" | "preserved";

/**
 * Ensure the scoped ignore marker inside the Memory Store directory exists
 * without ever overwriting a user-maintained marker. Existing content is
 * preserved; a missing marker is created with `*` (owner-only where the
 * platform supports POSIX modes).
 */
export async function ensureScopedIgnoreMarker(
	fs: MemoryStoreFs,
	storeDir: string,
	signal?: AbortSignal,
): Promise<IgnoreMarkerState> {
	const markerPath = join(storeDir, MEMORY_STORE_IGNORE_FILE_NAME);
	abort(markerPath, signal);
	try {
		await fs.readFileText(markerPath);
		return "preserved";
	} catch (error) {
		if (isNotFound(error)) {
			// Fall through to create the marker below.
		} else if (isAbortError(error)) {
			throw new MemoryError(MEMORY_ABORTED, "memory ignore-marker inspection was aborted");
		} else {
			throw new MemoryError(MEMORY_IGNORE_MARKER_FAILED, `cannot inspect memory ignore marker (${describeIo(error)})`);
		}
	}

	let handle: MemoryFileHandle | undefined;
	try {
		handle = await fs.openExclusive(markerPath);
		await handle.writeFile(`${MEMORY_STORE_IGNORE_CONTENT}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		return "created";
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (error instanceof MemoryError) throw error;
		if (isErrnoException(error) && error.code === "EEXIST") return "preserved";
		// Never leave a partial marker behind; the retry can start clean.
		await fs.remove(markerPath).catch(() => undefined);
		throw new MemoryError(MEMORY_IGNORE_MARKER_FAILED, `cannot create memory ignore marker (${describeIo(error)})`);
	}
}

/**
 * Commit one Store document atomically: write to an exclusive temporary file
 * in the Store directory, flush to disk, then rename over the Store path.
 *
 * On any failure the temporary file is removed and the prior Store bytes
 * remain authoritative. No partial or interleaved commit is observable.
 */
export async function atomicWriteStoreFile(
	fs: MemoryStoreFs,
	storePath: string,
	text: string,
	signal?: AbortSignal,
): Promise<void> {
	const dir = dirname(storePath);
	abort(dir, signal);
	const tempPath = join(dir, `.${basename(storePath)}.${randomBytes(6).toString("hex")}.tmp`);
	let handle: MemoryFileHandle | undefined;
	try {
		handle = await fs.openExclusive(tempPath);
		await handle.writeFile(text, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		abort(storePath, signal);
		await fs.rename(tempPath, storePath);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.remove(tempPath).catch(() => undefined);
		if (isAbortError(error) || signal?.aborted === true) {
			throw new MemoryError(MEMORY_ABORTED, "memory write was aborted before its Store commit completed");
		}
		throw new MemoryError(MEMORY_WRITE_FAILED, `cannot commit memory store (${describeIo(error)})`);
	}
}

/**
 * Serialize a full Store document to the exact bytes that land on disk, after
 * verifying it stays within the configured byte budget. Used by the commit
 * path so the persisted file is always bounded.
 */
export function serializeMemoryStoreDocument(value: object, limits: MemoryStoreConfigV1): string {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(text, "utf8") > limits.maxStoreBytes) {
		throw new MemoryError(
			MEMORY_STORE_OVER_LIMIT,
			`memory store document is ${Buffer.byteLength(text, "utf8")} bytes, exceeding the ${limits.maxStoreBytes} byte limit`,
		);
	}
	return text;
}
