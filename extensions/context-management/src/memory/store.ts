import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { MEMORY_STORE_BYTE_LIMIT } from "../constants.js";
import { ContextManagementError, errorMessage, throwIfAborted } from "../errors.js";
import type { RepositoryIdentity, RepositoryPaths } from "./identity.js";
import { acquireMemoryLock } from "./lock.js";
import {
	createMemoryFingerprint,
	createMemoryId,
	type MemoryAuthorFields,
	type MemoryEnvelope,
	type MemoryOrigin,
	type MemoryRecord,
	parseMemoryEnvelope,
	type RepositoryMetadata,
	serializeMemoryEnvelope,
	validateMemoryAuthorFields,
} from "./schema.js";

export interface MemoryFileIdentity {
	readonly exists: boolean;
	readonly dev?: bigint;
	readonly ino?: bigint;
	readonly size?: bigint;
	readonly mtimeNs?: bigint;
}

export interface MemoryStoreSnapshot {
	readonly available: boolean;
	readonly unavailableReason: string | null;
	readonly envelope: MemoryEnvelope | null;
	readonly fileIdentity: MemoryFileIdentity;
	readonly serializedBytes: number;
}

export interface MemoryMutationResult<T> {
	readonly value: T;
	readonly currentBytes: number;
	readonly candidateBytes: number;
	/** The rename committed, but the parent-directory fsync could not be confirmed. */
	readonly durabilityWarning?: string;
}

export interface WriteMemoryInput {
	readonly fields: MemoryAuthorFields;
	readonly origin: MemoryOrigin;
	readonly now?: Date;
}

export interface WriteMemoryValue {
	readonly record: MemoryRecord;
	readonly reused: boolean;
}

function sameIdentity(left: MemoryFileIdentity, right: MemoryFileIdentity): boolean {
	return (
		left.exists === right.exists &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs
	);
}

async function inspectIdentity(path: string): Promise<MemoryFileIdentity> {
	try {
		const stat = await lstat(path, { bigint: true });
		return Object.freeze({
			exists: true,
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ exists: false });
		throw error;
	}
}

async function readValidated(
	path: string,
	repositoryKey: string,
	signal?: AbortSignal,
): Promise<{
	readonly envelope: MemoryEnvelope | null;
	readonly identity: MemoryFileIdentity;
	readonly bytes: number;
}> {
	throwIfAborted(signal);
	const before = await inspectIdentity(path);
	throwIfAborted(signal);
	if (!before.exists) return { envelope: null, identity: before, bytes: 0 };
	if ((before.size ?? 0n) > BigInt(MEMORY_STORE_BYTE_LIMIT)) {
		throw new ContextManagementError(
			"context_management.memory_unavailable",
			`Memory store ${path} is ${before.size?.toString()} bytes; limit is ${MEMORY_STORE_BYTE_LIMIT} bytes.`,
		);
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		throwIfAborted(signal);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) {
			throw new ContextManagementError(
				"context_management.memory_unavailable",
				`Memory store is not a regular file: ${path}.`,
			);
		}
		if (stat.size > BigInt(MEMORY_STORE_BYTE_LIMIT)) {
			throw new ContextManagementError(
				"context_management.memory_unavailable",
				`Memory store ${path} is ${stat.size.toString()} bytes; limit is ${MEMORY_STORE_BYTE_LIMIT} bytes.`,
			);
		}
		const text = await handle.readFile({ encoding: "utf8" });
		throwIfAborted(signal);
		const parsed = parseMemoryEnvelope(JSON.parse(text) as unknown, repositoryKey);
		return {
			envelope: parsed,
			identity: Object.freeze({
				exists: true,
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
			}),
			bytes: Buffer.byteLength(text, "utf8"),
		};
	} catch (error) {
		if (error instanceof ContextManagementError) throw error;
		throw new ContextManagementError(
			"context_management.memory_unavailable",
			`Memory store ${path} is unavailable: ${errorMessage(error)}`,
		);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function emptyEnvelope(identity: RepositoryIdentity, now: Date): MemoryEnvelope {
	const repository: RepositoryMetadata = Object.freeze({
		key: identity.key,
		identityKind: identity.identityKind,
		canonicalPath: identity.canonicalPath,
		createdAt: now.toISOString(),
	});
	return Object.freeze({ schemaVersion: 1, repository, records: Object.freeze([]) });
}

async function atomicWrite(path: string, text: string, signal?: AbortSignal): Promise<string | undefined> {
	const directory = dirname(path);
	const temp = join(directory, `.memory-${process.pid}-${randomBytes(10).toString("hex")}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let renamed = false;
	try {
		throwIfAborted(signal);
		handle = await open(temp, "wx", 0o600);
		await handle.writeFile(text, "utf8");
		throwIfAborted(signal);
		await handle.sync();
		await handle.close();
		handle = undefined;
		throwIfAborted(signal);
		if (Buffer.byteLength(text, "utf8") > MEMORY_STORE_BYTE_LIMIT) {
			throw new ContextManagementError(
				"context_management.memory_store_too_large",
				`Candidate memory store exceeds ${MEMORY_STORE_BYTE_LIMIT} bytes.`,
			);
		}
		await rename(temp, path);
		renamed = true;
		try {
			const directoryHandle = await open(directory, constants.O_RDONLY);
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch (error) {
			return `Memory write was applied, but crash durability could not be confirmed: ${errorMessage(error)}`;
		}
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
		if (!renamed) await unlink(temp).catch(() => undefined);
	}
}

function oversizedMessage(path: string, currentBytes: number, candidateBytes: number): string {
	return `Memory store limit exceeded. Current: ${currentBytes} bytes; candidate: ${candidateBytes} bytes; limit: ${MEMORY_STORE_BYTE_LIMIT} bytes; path: ${path}. No record was written or deleted. Use memory search/read or inspect the file, explicitly forget obsolete record IDs, then retry.`;
}

export class MemoryStore {
	readonly #identity: RepositoryIdentity;
	readonly #paths: RepositoryPaths;
	#snapshot: MemoryStoreSnapshot = Object.freeze({
		available: true,
		unavailableReason: null,
		envelope: null,
		fileIdentity: Object.freeze({ exists: false }),
		serializedBytes: 0,
	});

	constructor(identity: RepositoryIdentity, paths: RepositoryPaths) {
		this.#identity = identity;
		this.#paths = paths;
	}

	get identity(): RepositoryIdentity {
		return this.#identity;
	}

	get paths(): RepositoryPaths {
		return this.#paths;
	}

	get snapshot(): MemoryStoreSnapshot {
		return this.#snapshot;
	}

	async load(force = false, signal?: AbortSignal): Promise<MemoryStoreSnapshot> {
		try {
			throwIfAborted(signal);
			const identity = await inspectIdentity(this.#paths.memoryFile);
			throwIfAborted(signal);
			if (!force && sameIdentity(identity, this.#snapshot.fileIdentity)) return this.#snapshot;
			const loaded = await readValidated(this.#paths.memoryFile, this.#identity.key, signal);
			this.#snapshot = Object.freeze({
				available: true,
				unavailableReason: null,
				envelope: loaded.envelope,
				fileIdentity: loaded.identity,
				serializedBytes: loaded.bytes,
			});
		} catch (error) {
			if (error instanceof ContextManagementError && error.code === "context_management.operation_aborted") throw error;
			this.#snapshot = Object.freeze({
				available: false,
				unavailableReason: errorMessage(error),
				envelope: null,
				fileIdentity: await inspectIdentity(this.#paths.memoryFile).catch(() => Object.freeze({ exists: true })),
				serializedBytes: 0,
			});
		}
		return this.#snapshot;
	}

	async write(input: WriteMemoryInput, signal?: AbortSignal): Promise<MemoryMutationResult<WriteMemoryValue>> {
		const fields = validateMemoryAuthorFields(input.fields);
		return this.#mutate<WriteMemoryValue>(
			signal,
			(envelope, now) => {
				const fingerprint = createMemoryFingerprint(fields);
				const existing = envelope.records.find(
					(record) => record.supersededBy === null && record.fingerprint === fingerprint,
				);
				if (existing !== undefined) return { envelope, value: { record: existing, reused: true }, changed: false };
				for (const id of fields.supersedes) {
					const previous = envelope.records.find((record) => record.id === id);
					if (previous === undefined || previous.supersededBy !== null) {
						throw new ContextManagementError(
							"context_management.memory_supersession_conflict",
							`Cannot supersede missing or inactive Memory Record ${id}.`,
						);
					}
				}
				const id = createMemoryId(now.getTime());
				const record: MemoryRecord = Object.freeze({
					...fields,
					id,
					origin: Object.freeze({ ...input.origin }),
					createdAt: now.toISOString(),
					fingerprint,
					supersededBy: null,
				});
				const records = envelope.records.map((previous) =>
					fields.supersedes.includes(previous.id) ? Object.freeze({ ...previous, supersededBy: id }) : previous,
				);
				const next = Object.freeze({ ...envelope, records: Object.freeze([...records, record]) });
				return { envelope: next, value: { record, reused: false } };
			},
			input.now,
		);
	}

	async forget(
		id: string,
		signal?: AbortSignal,
	): Promise<MemoryMutationResult<{ readonly id: string; readonly title: string }>> {
		return this.#mutate(signal, (envelope) => {
			const record = envelope.records.find((candidate) => candidate.id === id);
			if (record === undefined) {
				throw new ContextManagementError(
					"context_management.memory_validation_failure",
					`Memory Record ${id} was not found.`,
				);
			}
			const related = envelope.records
				.filter(
					(candidate) => candidate.id !== id && (candidate.supersedes.includes(id) || candidate.supersededBy === id),
				)
				.map((candidate) => candidate.id)
				.sort();
			if (record.supersedes.length > 0 || record.supersededBy !== null || related.length > 0) {
				const ids = [
					...new Set([
						...record.supersedes,
						...(record.supersededBy === null ? [] : [record.supersededBy]),
						...related,
					]),
				];
				throw new ContextManagementError(
					"context_management.memory_forget_conflict",
					`Memory Record ${id} has supersession relations with: ${ids.sort().join(", ")}. Resolve them explicitly before forgetting it.`,
				);
			}
			return {
				envelope: Object.freeze({
					...envelope,
					records: Object.freeze(envelope.records.filter((candidate) => candidate.id !== id)),
				}),
				value: { id, title: record.title },
			};
		});
	}

	async #mutate<T>(
		signal: AbortSignal | undefined,
		mutation: (
			envelope: MemoryEnvelope,
			now: Date,
		) => { readonly envelope: MemoryEnvelope; readonly value: T; readonly changed?: boolean },
		now = new Date(),
	): Promise<MemoryMutationResult<T>> {
		throwIfAborted(signal);
		await mkdir(this.#paths.directory, { recursive: true, mode: 0o700 });
		return withFileMutationQueue(this.#paths.memoryFile, async () => {
			const lock = await acquireMemoryLock(this.#paths.lockDirectory, signal);
			try {
				throwIfAborted(signal);
				lock.assertHealthy();
				const loaded = await readValidated(this.#paths.memoryFile, this.#identity.key, signal);
				const current = loaded.envelope ?? emptyEnvelope(this.#identity, now);
				const result = mutation(current, now);
				if (result.changed === false) {
					this.#snapshot = Object.freeze({
						available: true,
						unavailableReason: null,
						envelope: loaded.envelope,
						fileIdentity: loaded.identity,
						serializedBytes: loaded.bytes,
					});
					return Object.freeze({
						value: result.value,
						currentBytes: loaded.bytes,
						candidateBytes: loaded.bytes,
					});
				}
				let text: string;
				try {
					text = serializeMemoryEnvelope(result.envelope);
				} catch (error) {
					if (error instanceof ContextManagementError && error.code === "context_management.memory_store_too_large") {
						const candidateBytes = Buffer.byteLength(`${JSON.stringify(result.envelope, null, 2)}\n`, "utf8");
						throw new ContextManagementError(
							"context_management.memory_store_too_large",
							oversizedMessage(this.#paths.memoryFile, loaded.bytes, candidateBytes),
							{ currentBytes: loaded.bytes, candidateBytes, limitBytes: MEMORY_STORE_BYTE_LIMIT },
						);
					}
					throw error;
				}
				const candidateBytes = Buffer.byteLength(text, "utf8");
				if (candidateBytes > MEMORY_STORE_BYTE_LIMIT) {
					throw new ContextManagementError(
						"context_management.memory_store_too_large",
						oversizedMessage(this.#paths.memoryFile, loaded.bytes, candidateBytes),
						{ currentBytes: loaded.bytes, candidateBytes, limitBytes: MEMORY_STORE_BYTE_LIMIT },
					);
				}
				lock.assertHealthy();
				throwIfAborted(signal);
				const durabilityWarning = await atomicWrite(this.#paths.memoryFile, text, signal);
				const refreshed = await readValidated(this.#paths.memoryFile, this.#identity.key);
				this.#snapshot = Object.freeze({
					available: true,
					unavailableReason: null,
					envelope: refreshed.envelope,
					fileIdentity: refreshed.identity,
					serializedBytes: refreshed.bytes,
				});
				return Object.freeze({
					value: result.value,
					currentBytes: loaded.bytes,
					candidateBytes,
					...(durabilityWarning === undefined ? {} : { durabilityWarning }),
				});
			} finally {
				await lock.release();
			}
		});
	}
}
