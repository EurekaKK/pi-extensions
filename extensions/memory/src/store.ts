import { hasExactKeys, isRecord, readStrictJsonFile, StrictConfigError } from "config-store";
import type { MemoryConfigV1 } from "./config.js";
import {
	MEMORY_ABORTED,
	MEMORY_PRIMARY_AGENT_AUTHOR,
	MEMORY_STORE_CORRUPT,
	MEMORY_STORE_OVER_LIMIT,
	MEMORY_STORE_SCHEMA,
	MEMORY_STORE_UNSUPPORTED_VERSION,
	MEMORY_STORE_VERSION,
} from "./constants.js";
import { MemoryError } from "./errors.js";
import { characterLength } from "./normalize.js";

export interface MemoryProvenanceV1 {
	readonly sessionId: string;
	readonly directoryId: string;
	/** Exactly `primary-agent`: only the primary foreground Agent authors records. */
	readonly author: string;
	/** Optional Pi entry whose write produced this record (replaces the ambiguous `source`). */
	readonly entryId?: string;
}

export interface MemoryRecordV1 {
	readonly id: string;
	readonly revision: number;
	readonly state: "active" | "superseded";
	readonly summary: string;
	readonly content: string;
	readonly supersedes: { readonly id: string; readonly revision: number } | null;
	readonly provenance: MemoryProvenanceV1;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface MemoryStoreV1 {
	readonly version: 1;
	readonly schema: "memory.store.v1";
	/** Monotonic Store revision; 0 is an empty, never-mutated Store. */
	readonly revision: number;
	/** Canonical Directory metadata recorded when the Store's chain was created. */
	readonly directory: { readonly id: string };
	readonly records: readonly MemoryRecordV1[];
}

/**
 * Read-only classification of one Store document. Failure states are never
 * interpreted as an empty Store and are never overwritten by this inspection.
 */
export type StoreClassification =
	| { readonly kind: "missing" }
	| { readonly kind: "healthy"; readonly store: MemoryStoreV1 }
	| { readonly kind: "unreadable"; readonly reason: string }
	| { readonly kind: "corrupt"; readonly reason: string }
	| { readonly kind: "over-limit"; readonly reason: string }
	| { readonly kind: "unsupported"; readonly reason: string };

export interface ClassifyMemoryStoreOptions {
	readonly storePath: string;
	readonly limits: Pick<
		MemoryConfigV1["store"],
		"maxStoreBytes" | "maxRecords" | "maxContentChars" | "maxSummaryChars"
	>;
	readonly signal?: AbortSignal;
}

export const MAX_RECORD_ID_CHARS = 128;

function hasKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	const actual = Object.keys(value);
	return Object.getOwnPropertySymbols(value).length === 0 && actual.every((key) => allowed.has(key));
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function isNonEmptyString(value: unknown, maxChars: number, rejectControl: boolean): value is string {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (trimmed.length === 0 || value.length > maxChars) return false;
	if (rejectControl && hasControlCharacters(value)) return false;
	return true;
}

function isValidTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateProvenance(value: unknown, path: string): MemoryProvenanceV1 {
	if (!isRecord(value) || !hasKeys(value, ["author", "directoryId", "sessionId"], ["entryId"])) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.provenance has unsupported fields or is not an object`);
	}
	if (value.author !== MEMORY_PRIMARY_AGENT_AUTHOR) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.provenance.author must be "${MEMORY_PRIMARY_AGENT_AUTHOR}"`);
	}
	if (!isNonEmptyString(value.directoryId, 4_096, true)) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.provenance.directoryId must be a non-empty string`);
	}
	if (!isNonEmptyString(value.sessionId, 256, true)) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.provenance.sessionId must be a non-empty string`);
	}
	if (value.entryId !== undefined && !isNonEmptyString(value.entryId, 256, true)) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.provenance.entryId must be a non-empty string`);
	}
	return Object.freeze({
		author: value.author,
		directoryId: value.directoryId,
		sessionId: value.sessionId,
		...(value.entryId === undefined ? {} : { entryId: value.entryId }),
	});
}

function validateReference(value: unknown, path: string): { readonly id: string; readonly revision: number } {
	if (!isRecord(value) || !hasExactKeys(value, ["id", "revision"])) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.supersedes must contain exactly id and revision`);
	}
	if (!isNonEmptyString(value.id, MAX_RECORD_ID_CHARS, true)) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.supersedes.id must be a non-empty string`);
	}
	const rawRevision = value.revision;
	if (typeof rawRevision !== "number" || !Number.isSafeInteger(rawRevision) || rawRevision <= 0) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.supersedes.revision must be a positive safe integer`);
	}
	const revision = rawRevision;
	return Object.freeze({ id: value.id, revision });
}

function validateRecord(value: unknown, index: number, limits: ClassifyMemoryStoreOptions["limits"]): MemoryRecordV1 {
	const path = `records[${index}]`;
	if (!isRecord(value)) throw new MemoryError(MEMORY_STORE_CORRUPT, `${path} must be an object`);
	if (
		!hasExactKeys(value, [
			"content",
			"createdAt",
			"id",
			"provenance",
			"revision",
			"state",
			"summary",
			"supersedes",
			"updatedAt",
		])
	) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path} contains unknown or missing fields`);
	}
	if (!isNonEmptyString(value.id, MAX_RECORD_ID_CHARS, true)) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.id must be a non-empty string without control characters`);
	}
	const rawRevision = value.revision;
	if (typeof rawRevision !== "number" || !Number.isSafeInteger(rawRevision) || rawRevision <= 0) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.revision must be a positive safe integer`);
	}
	const revision = rawRevision;
	if (value.state !== "active" && value.state !== "superseded") {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.state must be "active" or "superseded"`);
	}
	const state = value.state;
	if (typeof value.summary !== "string" || characterLength(value.summary) > limits.maxSummaryChars) {
		throw new MemoryError(
			MEMORY_STORE_OVER_LIMIT,
			`${path}.summary exceeds the ${limits.maxSummaryChars} character limit`,
		);
	}
	if (value.summary.trim().length === 0) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.summary must not be blank`);
	}
	if (typeof value.content !== "string" || characterLength(value.content) > limits.maxContentChars) {
		throw new MemoryError(
			MEMORY_STORE_OVER_LIMIT,
			`${path}.content exceeds the ${limits.maxContentChars} character limit`,
		);
	}
	const supersedes = value.supersedes === null ? null : validateReference(value.supersedes, path);
	const provenance = validateProvenance(value.provenance, path);
	if (!isValidTimestamp(value.createdAt)) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.createdAt must be a valid timestamp`);
	}
	if (!isValidTimestamp(value.updatedAt)) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `${path}.updatedAt must be a valid timestamp`);
	}
	return Object.freeze({
		id: value.id,
		revision,
		state,
		summary: value.summary,
		content: value.content,
		supersedes,
		provenance,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	});
}

/**
 * Validate the directed supersession forest graph-wide.
 *
 * Chain semantics: only the leaf of a chain is `active`; a chain A <- B <- C
 * has C active while A and B are `superseded`. A correction may carry a
 * `supersedes` reference and still be `active` (the leaf); a root may be
 * `superseded` without carrying a `supersedes` reference. Each reference must
 * match its target's exact id/revision, the new record's revision must be the
 * target revision + 1, the graph must be acyclic, every target has at most one
 * direct successor, and a record's state must match the graph: with an
 * incoming successor it is `superseded`, without one it is `active`.
 */
function validateSupersessionGraph(records: readonly MemoryRecordV1[]): void {
	const byId = new Map<string, MemoryRecordV1>();
	for (const record of records) {
		if (byId.has(record.id)) {
			throw new MemoryError(MEMORY_STORE_CORRUPT, `duplicate record identity "${record.id}"`);
		}
		byId.set(record.id, record);
	}

	/** Direct successor of each target id (at most one per target). */
	const successor = new Map<string, MemoryRecordV1>();
	const visited = new Set<string>();
	const stack = new Set<string>();

	function visit(record: MemoryRecordV1): void {
		if (visited.has(record.id)) return;
		if (stack.has(record.id)) {
			throw new MemoryError(MEMORY_STORE_CORRUPT, `invalid supersession graph: cycle at record "${record.id}"`);
		}
		stack.add(record.id);
		if (record.supersedes !== null) {
			const target = byId.get(record.supersedes.id);
			if (target === undefined) {
				throw new MemoryError(
					MEMORY_STORE_CORRUPT,
					`invalid supersession graph: record "${record.id}" references missing record "${record.supersedes.id}"`,
				);
			}
			if (target.revision !== record.supersedes.revision) {
				throw new MemoryError(
					MEMORY_STORE_CORRUPT,
					`invalid supersession graph: record "${record.id}" references stale revision of "${target.id}"`,
				);
			}
			if (record.revision !== target.revision + 1) {
				throw new MemoryError(
					MEMORY_STORE_CORRUPT,
					`invalid supersession graph: record "${record.id}" revision ${record.revision} must be ${target.revision + 1} (target revision + 1)`,
				);
			}
			if (successor.has(target.id)) {
				throw new MemoryError(
					MEMORY_STORE_CORRUPT,
					`invalid supersession graph: record "${target.id}" is superseded more than once`,
				);
			}
			successor.set(target.id, record);
			visit(target);
		}
		stack.delete(record.id);
		visited.add(record.id);
	}

	for (const record of records) visit(record);
	for (const record of records) {
		const successorRecord = successor.get(record.id);
		if (successorRecord !== undefined && record.state !== "superseded") {
			throw new MemoryError(
				MEMORY_STORE_CORRUPT,
				`invalid supersession graph: record "${record.id}" is superseded by "${successorRecord.id}" but its state is "active"`,
			);
		}
		if (successorRecord === undefined && record.state !== "active") {
			throw new MemoryError(
				MEMORY_STORE_CORRUPT,
				`invalid supersession graph: record "${record.id}" has no successor but its state is "superseded"`,
			);
		}
	}
}

export function validateMemoryStoreDocument(
	value: unknown,
	limits: ClassifyMemoryStoreOptions["limits"],
): MemoryStoreV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["directory", "records", "revision", "schema", "version"])) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, "store document contains unknown or missing top-level fields");
	}
	if (value.version !== MEMORY_STORE_VERSION) {
		throw new MemoryError(
			MEMORY_STORE_UNSUPPORTED_VERSION,
			`store version ${String(value.version)} is not supported (expected ${MEMORY_STORE_VERSION})`,
		);
	}
	if (value.schema !== MEMORY_STORE_SCHEMA) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, `store schema must equal ${MEMORY_STORE_SCHEMA}`);
	}
	const rawRevision = value.revision;
	if (typeof rawRevision !== "number" || !Number.isSafeInteger(rawRevision) || rawRevision < 0) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, "store revision must be a non-negative safe integer");
	}
	const revision = rawRevision;
	if (
		!isRecord(value.directory) ||
		!hasExactKeys(value.directory, ["id"]) ||
		!isNonEmptyString(value.directory.id, 4_096, true)
	) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, "store directory must contain exactly a non-empty id");
	}
	if (!Array.isArray(value.records)) {
		throw new MemoryError(MEMORY_STORE_CORRUPT, "store records must be an array");
	}
	if (value.records.length > limits.maxRecords) {
		throw new MemoryError(
			MEMORY_STORE_OVER_LIMIT,
			`store record count ${value.records.length} exceeds the ${limits.maxRecords} limit`,
		);
	}
	const records = value.records.map((record, index) => validateRecord(record, index, limits));
	validateSupersessionGraph(records);
	const computedBytes = Buffer.byteLength(JSON.stringify(value));
	if (computedBytes > limits.maxStoreBytes) {
		throw new MemoryError(
			MEMORY_STORE_OVER_LIMIT,
			`store document is ${computedBytes} bytes, exceeding the ${limits.maxStoreBytes} byte limit`,
		);
	}
	return Object.freeze({
		version: MEMORY_STORE_VERSION,
		schema: MEMORY_STORE_SCHEMA,
		revision,
		directory: Object.freeze({ id: value.directory.id }),
		records,
	});
}

/**
 * Read and classify the Store for the exact Working Directory without writing
 * anything. Missing initializes a healthy-absent state; corrupt, unreadable,
 * over-limit, and unsupported Stores are reported as their own failure kind and
 * are never treated as empty. Reads go through the shared strict-JSON reader
 * from `config-store`, mapping its stable failure reasons back to these kinds.
 */
export async function classifyMemoryStore(options: ClassifyMemoryStoreOptions): Promise<StoreClassification> {
	const { storePath, limits, signal } = options;
	let parsed: unknown;
	try {
		parsed = await readStrictJsonFile({
			filePath: storePath,
			maxBytes: limits.maxStoreBytes,
			label: "memory store",
			...(signal === undefined ? {} : { signal }),
		});
	} catch (error) {
		if (error instanceof StrictConfigError) {
			switch (error.reason) {
				case "missing":
					return { kind: "missing" };
				case "aborted":
					throw new MemoryError(MEMORY_ABORTED, "memory status was aborted");
				case "over-limit":
					return { kind: "over-limit", reason: error.message };
				case "invalid-utf8":
				case "invalid-json":
					return { kind: "corrupt", reason: error.message };
				default:
					return { kind: "unreadable", reason: error.message };
			}
		}
		return { kind: "unreadable", reason: "filesystem operation failed" };
	}

	try {
		const store = validateMemoryStoreDocument(parsed, limits);
		return { kind: "healthy", store };
	} catch (error) {
		if (error instanceof MemoryError) {
			if (error.code === MEMORY_STORE_UNSUPPORTED_VERSION) {
				return { kind: "unsupported", reason: error.message };
			}
			if (error.code === MEMORY_STORE_OVER_LIMIT) {
				return { kind: "over-limit", reason: error.message };
			}
			return { kind: "corrupt", reason: error.message };
		}
		return { kind: "corrupt", reason: "store document failed validation" };
	}
}
