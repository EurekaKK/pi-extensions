import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ResultSpoolMetadata } from "../sidecar/protocol.js";

export const MAX_REPORT_BYTES = 256 * 1024;

export class SpoolIntegrityError extends Error {
	constructor(message = "Sub-agent result spool integrity validation failed.") {
		super(message);
		this.name = "SpoolIntegrityError";
	}
}

export interface VerifiedSpool {
	path: string;
	basename: string;
	byteSize: number;
	digest: string;
	bytes: Buffer;
}

export function spoolBasenameForDelivery(deliveryId: string): string {
	return `${deliveryId}.report`;
}

export async function createSessionSpoolDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-sub-agent-"));
	await chmod(directory, 0o700);
	return await realpath(directory);
}

function isExpectedMode(mode: number, expected: number): boolean {
	return (mode & 0o777) === expected;
}

function assertSafeBasename(deliveryId: string, candidate: string): void {
	const expected = spoolBasenameForDelivery(deliveryId);
	if (candidate !== expected || basename(candidate) !== candidate || candidate.includes(sep)) {
		throw new SpoolIntegrityError();
	}
}

async function assertTrustedSpoolRoot(spoolRoot: string): Promise<string> {
	const rootPath = resolve(spoolRoot);
	const info = await lstat(rootPath);
	if (!info.isDirectory() || info.isSymbolicLink() || !isExpectedMode(info.mode, 0o700)) {
		throw new SpoolIntegrityError();
	}
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
		throw new SpoolIntegrityError();
	}
	// macOS commonly exposes /var through the /private/var symlink. The spool
	// directory itself must not be a symlink, but its trusted OS temporary
	// directory ancestors may be.
	await realpath(rootPath);
	return rootPath;
}

export async function readVerifiedResultSpool(
	spoolRoot: string,
	deliveryId: string,
	metadata: ResultSpoolMetadata,
): Promise<VerifiedSpool> {
	assertSafeBasename(deliveryId, metadata.basename);
	if (!Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 0 || metadata.byteSize > MAX_REPORT_BYTES) {
		throw new SpoolIntegrityError();
	}
	if (!/^[a-f0-9]{64}$/u.test(metadata.digest)) throw new SpoolIntegrityError();

	const rootPath = await assertTrustedSpoolRoot(spoolRoot);
	const filePath = resolve(rootPath, metadata.basename);
	if (dirname(filePath) !== rootPath) throw new SpoolIntegrityError();

	const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || !isExpectedMode(info.mode, 0o600)) throw new SpoolIntegrityError();
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new SpoolIntegrityError();
		if (!Number.isSafeInteger(info.size) || info.size !== metadata.byteSize || info.size > MAX_REPORT_BYTES) {
			throw new SpoolIntegrityError();
		}
		const bytes = await handle.readFile();
		if (bytes.byteLength !== metadata.byteSize) throw new SpoolIntegrityError();
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== metadata.digest) throw new SpoolIntegrityError();
		return {
			path: filePath,
			basename: metadata.basename,
			byteSize: bytes.byteLength,
			digest,
			bytes,
		};
	} finally {
		await handle.close();
	}
}

export async function verifyResultSpoolCommit(
	spoolRoot: string,
	deliveryId: string,
	metadata: ResultSpoolMetadata,
): Promise<void> {
	await readVerifiedResultSpool(spoolRoot, deliveryId, metadata);
}

export async function removeResultSpool(spoolRoot: string, deliveryId: string): Promise<void> {
	const rootPath = resolve(spoolRoot);
	const filePath = resolve(rootPath, spoolBasenameForDelivery(deliveryId));
	if (dirname(filePath) !== rootPath) return;
	try {
		await unlink(filePath);
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			(error as { code?: unknown }).code !== "ENOENT"
		) {
			throw error;
		}
	}
}

export async function listSpoolBasenames(spoolRoot: string): Promise<string[]> {
	try {
		return await readdir(spoolRoot);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT"
		) {
			return [];
		}
		throw error;
	}
}

export async function cleanupOrphanSpools(spoolRoot: string, retainedBasenames: ReadonlySet<string>): Promise<void> {
	for (const entry of await listSpoolBasenames(spoolRoot)) {
		if (retainedBasenames.has(entry)) continue;
		const candidate = resolve(spoolRoot, entry);
		if (dirname(candidate) !== resolve(spoolRoot)) continue;
		try {
			const info = await lstat(candidate);
			if (info.isFile() || info.isSymbolicLink()) await unlink(candidate);
		} catch {
			// Session cleanup retries by removing the whole private directory.
		}
	}
}

export async function removeSessionSpoolDirectory(spoolRoot: string): Promise<void> {
	const rootPath = resolve(spoolRoot);
	const temporaryRoot = await realpath(resolve(tmpdir()));
	let canonicalRoot: string;
	try {
		canonicalRoot = await realpath(rootPath);
		const info = await stat(canonicalRoot);
		if (!info.isDirectory()) throw new Error("Spool root is not a directory.");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
	if (canonicalRoot === temporaryRoot || !canonicalRoot.startsWith(`${temporaryRoot}${sep}`)) {
		throw new Error("Refusing to remove a spool directory outside the OS temporary directory.");
	}
	const lexicalInfo = await lstat(rootPath);
	if (
		!lexicalInfo.isDirectory() ||
		lexicalInfo.isSymbolicLink() ||
		!isExpectedMode(lexicalInfo.mode, 0o700) ||
		(typeof process.getuid === "function" && lexicalInfo.uid !== process.getuid())
	) {
		throw new Error("Refusing to remove an untrusted spool directory.");
	}
	await rm(canonicalRoot, { recursive: true, force: true });
}
