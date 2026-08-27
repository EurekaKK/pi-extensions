import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileMutationQueue, MemoryConfigV1 } from "./config.js";
import {
	MEMORY_IDENTITY_COLLISION,
	MEMORY_INPUT_REJECTED,
	MEMORY_PRIMARY_AGENT_AUTHOR,
	MEMORY_RECORD_NOT_FOUND,
	MEMORY_SEARCH_INPUT_REJECTED,
	MEMORY_STORE_CORRUPT,
	MEMORY_STORE_OVER_LIMIT,
	MEMORY_STORE_SCHEMA,
	MEMORY_STORE_UNAVAILABLE,
	MEMORY_STORE_UNSUPPORTED_VERSION,
	MEMORY_STORE_VERSION,
	MEMORY_TARGET_INACTIVE,
	MEMORY_TARGET_NOT_FOUND,
	MEMORY_TARGET_STALE,
} from "./constants.js";
import { MemoryError } from "./errors.js";
import { resolveDirectoryIdentity } from "./identity.js";
import { characterLength, hasRejectedControlCharacters, isSecretLike, normalizeRecordText } from "./normalize.js";
import { compareRecency, countTokenOccurrences, extractSearchTokens, scoreSearchTokens } from "./ranking.js";
import {
	classifyMemoryStore,
	type MemoryProvenanceV1,
	type MemoryRecordV1,
	type MemoryStoreV1,
	type StoreClassification,
	validateMemoryStoreDocument,
} from "./store.js";
import {
	atomicWriteStoreFile,
	createMemoryStoreFs,
	ensureMemoryStoreDirectory,
	ensureMemoryStoreFileMode,
	ensureScopedIgnoreMarker,
	type IgnoreMarkerState,
	type MemoryStoreFs,
	serializeMemoryStoreDocument,
} from "./store-io.js";
import { getMemoryStoreDirectory, getMemoryStorePath } from "./store-layout.js";

export interface MemoryAddInput {
	readonly content: string;
	readonly summary: string;
}

export interface MemorySupersedeInput {
	readonly content: string;
	readonly summary: string;
	readonly targetId: string;
	readonly targetRevision: number;
}

/**
 * Loose single-object shape accepted by the shared `write` pipeline. The
 * TypeBox schema allows optional target fields; semantic validation narrows
 * them per operation here (add rejects targets, supersede requires both).
 */
export interface MemoryWriteInput {
	readonly operation: "add" | "supersede";
	readonly summary: string;
	readonly content: string;
	readonly targetId?: string;
	readonly targetRevision?: number;
}

export type MemoryWriteOutcome =
	| {
			readonly kind: "added";
			readonly record: MemoryRecordV1;
			readonly previousStoreRevision: number;
			readonly storeRevision: number;
			readonly ignoreMarker: IgnoreMarkerState | null;
	  }
	| {
			readonly kind: "no-op";
			readonly record: MemoryRecordV1;
			readonly storeRevision: number;
	  }
	| {
			readonly kind: "superseded";
			/** The new active leaf of the corrected chain. */
			readonly record: MemoryRecordV1;
			/** The exact target revision, now inactive but preserved for audit. */
			readonly replaced: MemoryRecordV1;
			readonly previousStoreRevision: number;
			readonly storeRevision: number;
			readonly ignoreMarker: IgnoreMarkerState | null;
	  };

export interface MemoryReadInput {
	readonly id: string;
	readonly revision?: number;
}

export type MemoryReadOutcome = { readonly kind: "found"; readonly record: MemoryRecordV1 };

/** Bounded lexical search input; `limit` is capped by the configured recall budget. */
export interface MemorySearchInput {
	readonly query: string;
	readonly limit?: number;
}

export interface MemorySearchOutcome {
	readonly kind: "ok";
	readonly query: string;
	readonly requestedLimit?: number;
	/** The applied record budget: `min(requestedLimit, recall.maxRecords)`. */
	readonly appliedLimit: number;
	/** All active records with a non-zero lexical score (before the cap). */
	readonly matchedCount: number;
	/** Ranked active matches, score descending, capped by `appliedLimit`. */
	readonly hits: readonly { readonly record: MemoryRecordV1; readonly score: number }[];
}

/**
 * Uncapped ranked outcome for automatic Recall deduplication (#11). The exact
 * same engine that ranks `MemorySearchOutcome.hits` ranks every active match;
 * Recall filters visible fingerprints and applies its own record budget on top.
 */
export interface MemorySearchAllOutcome {
	readonly kind: "ok";
	readonly query: string;
	/** The applied recall record budget (`recall.maxRecords`). */
	readonly appliedLimit: number;
	/** Every active record with a non-zero lexical score, fully ranked. */
	readonly matchedCount: number;
	/** The full ranked hit list (score descending, recency tie-break), uncapped. */
	readonly ranked: readonly { readonly record: MemoryRecordV1; readonly score: number }[];
}

/** Active listing input; `limit` is capped by the configured recall budget. */
export interface MemoryListInput {
	readonly limit?: number;
}

export interface MemoryListOutcome {
	readonly kind: "ok";
	readonly requestedLimit?: number;
	readonly appliedLimit: number;
	/** All active records in the Store (before the cap). */
	readonly totalActive: number;
	/** Active records ordered by recency and capped by `appliedLimit`. */
	readonly records: readonly MemoryRecordV1[];
}

export interface MemoryServiceOptions {
	readonly config: MemoryConfigV1;
	readonly withFileMutationQueue: FileMutationQueue;
	readonly fs?: MemoryStoreFs;
	/** Injectable clock for deterministic timestamps in tests. */
	readonly now?: () => string;
}

/** Stable deterministic record identity derived from exact normalized content+summary. */
export function deriveRecordId(content: string, summary: string): string {
	const digest = createHash("sha256").update(content).update("\u0000").update(summary).digest("hex");
	return `memory-${digest.slice(0, 24)}`;
}

function storeFailureError(
	classification: Extract<StoreClassification, { kind: "corrupt" | "unreadable" | "over-limit" | "unsupported" }>,
): MemoryError {
	switch (classification.kind) {
		case "corrupt":
			return new MemoryError(MEMORY_STORE_CORRUPT, classification.reason);
		case "unreadable":
			return new MemoryError(MEMORY_STORE_UNAVAILABLE, classification.reason);
		case "over-limit":
			return new MemoryError(MEMORY_STORE_OVER_LIMIT, classification.reason);
		case "unsupported":
			return new MemoryError(MEMORY_STORE_UNSUPPORTED_VERSION, classification.reason);
	}
}

/**
 * Capture-policy validation over already-normalized summary/content. Mutations
 * never happen on a rejected input.
 */
function validateRecordInput(content: string, summary: string, config: MemoryConfigV1): void {
	const { maxContentChars, maxSummaryChars } = config.store;
	if (content.trim().length === 0) {
		throw new MemoryError(MEMORY_INPUT_REJECTED, "memory content must not be blank");
	}
	if (summary.trim().length === 0) {
		throw new MemoryError(MEMORY_INPUT_REJECTED, "memory summary must not be blank");
	}
	if (characterLength(content) > maxContentChars) {
		throw new MemoryError(MEMORY_INPUT_REJECTED, `memory content exceeds the ${maxContentChars} character limit`);
	}
	if (characterLength(summary) > maxSummaryChars) {
		throw new MemoryError(MEMORY_INPUT_REJECTED, `memory summary exceeds the ${maxSummaryChars} character limit`);
	}
	if (hasRejectedControlCharacters(content)) {
		throw new MemoryError(MEMORY_INPUT_REJECTED, "memory content contains unsupported control characters");
	}
	if (hasRejectedControlCharacters(summary)) {
		throw new MemoryError(MEMORY_INPUT_REJECTED, "memory summary contains unsupported control characters");
	}
	if (isSecretLike(content) || isSecretLike(summary)) {
		throw new MemoryError(MEMORY_INPUT_REJECTED, "memory content looks like a secret or credential and was rejected");
	}
}

function emptyStore(identity: string): MemoryStoreV1 {
	return Object.freeze({
		version: MEMORY_STORE_VERSION,
		schema: MEMORY_STORE_SCHEMA,
		revision: 0,
		directory: Object.freeze({ id: identity }),
		records: Object.freeze([]),
	});
}

function buildRecord(
	identity: string,
	sessionId: string,
	leafId: string | null,
	content: string,
	summary: string,
	timestamp: string,
	revision: number,
	supersedes: { readonly id: string; readonly revision: number } | null,
): MemoryRecordV1 {
	const provenance: MemoryProvenanceV1 = Object.freeze({
		sessionId,
		directoryId: identity,
		author: MEMORY_PRIMARY_AGENT_AUTHOR,
		...(leafId === null ? {} : { entryId: leafId }),
	});
	return Object.freeze({
		id: deriveRecordId(content, summary),
		revision,
		state: "active",
		summary,
		content,
		supersedes,
		provenance,
		createdAt: timestamp,
		updatedAt: timestamp,
	});
}

/**
 * Semantic target-field validation for the shared write pipeline. Returns a
 * discriminated value so the caller narrows the add/supersede paths safely
 * without casts. Rejections carry the stable input-rejected code and never
 * touch the Store.
 */
type ResolvedOperation = "add" | { readonly targetId: string; readonly targetRevision: number };

function validateOperationInput(input: MemoryWriteInput): ResolvedOperation {
	if (input.operation === "add") {
		if (input.targetId !== undefined || input.targetRevision !== undefined) {
			throw new MemoryError(
				MEMORY_INPUT_REJECTED,
				"memory_write add does not accept targetId or targetRevision (supersede is the operation for corrections)",
			);
		}
		return "add";
	}
	if (input.targetId === undefined || input.targetRevision === undefined) {
		throw new MemoryError(
			MEMORY_INPUT_REJECTED,
			"memory_write supersede requires both targetId and targetRevision of the active record to correct",
		);
	}
	if (input.targetId.trim().length === 0 || hasRejectedControlCharacters(input.targetId)) {
		throw new MemoryError(
			MEMORY_INPUT_REJECTED,
			"memory_write supersede targetId must be a non-empty record identity without control characters",
		);
	}
	if (!Number.isSafeInteger(input.targetRevision) || input.targetRevision < 1) {
		throw new MemoryError(
			MEMORY_INPUT_REJECTED,
			"memory_write supersede targetRevision must be a positive safe integer",
		);
	}
	return { targetId: input.targetId, targetRevision: input.targetRevision };
}

/**
 * Rank every active record against one normalized query with the pure lexical
 * engine: score descending, then the deterministic recency (and id/revision)
 * tie-break. `MemoryService.search` slices from this list under the record
 * budget; `MemoryService.searchAll` exposes it uncapped for Recall.
 */
function rankActiveMatches(
	store: MemoryStoreV1,
	query: string,
): readonly { readonly record: MemoryRecordV1; readonly score: number }[] {
	const queryCounts = countTokenOccurrences(extractSearchTokens(query));
	const scored: { readonly record: MemoryRecordV1; readonly score: number }[] = [];
	for (const record of store.records) {
		if (record.state !== "active") continue;
		const summaryCounts = countTokenOccurrences(extractSearchTokens(record.summary));
		const contentCounts = countTokenOccurrences(extractSearchTokens(record.content));
		const score = scoreSearchTokens(queryCounts, summaryCounts, contentCounts);
		if (score === 0) continue;
		scored.push({ record, score });
	}
	// Relevance first: score descending; recency (and then id/revision) is
	// only a deterministic tie-breaker, never a promotion mechanism.
	scored.sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		return compareRecency(a.record, b.record);
	});
	return scored;
}

/**
 * Search-query capture policy: NFC-folded, non-blank, free of every control
 * character (the query is rerendered into tool/command output, so even tab and
 * newline would break the compact layout), and bounded by the summary scale.
 */
function validateSearchQuery(query: string, maxChars: number): string {
	const normalized = query.normalize("NFC").trim();
	if (normalized.length === 0) {
		throw new MemoryError(MEMORY_SEARCH_INPUT_REJECTED, "memory_search query must not be blank");
	}
	if (hasRejectedControlCharacters(normalized) || /[\t\n\r]/u.test(normalized)) {
		throw new MemoryError(MEMORY_SEARCH_INPUT_REJECTED, "memory_search query contains unsupported control characters");
	}
	if (characterLength(normalized) > maxChars) {
		throw new MemoryError(MEMORY_SEARCH_INPUT_REJECTED, `memory_search query exceeds the ${maxChars} character limit`);
	}
	return normalized;
}

/**
 * Resolve the effective record budget: an explicit limit must be a positive
 * safe integer and is capped by the configured recall budget.
 */
function resolveRecordLimit(
	limit: number | undefined,
	maxRecords: number,
): { readonly applied: number; readonly requested: number | undefined } {
	if (limit === undefined) return { applied: maxRecords, requested: undefined };
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new MemoryError(MEMORY_SEARCH_INPUT_REJECTED, "memory search limit must be a positive safe integer");
	}
	return { applied: Math.min(limit, maxRecords), requested: limit };
}

/**
 * Resolve and validate the exact active supersession target. Missing targets,
 * stale revisions, and already-superseded targets fail closed with their own
 * stable codes; the caller runs this before any filesystem mutation.
 */
function resolveSupersedeTarget(
	records: readonly MemoryRecordV1[],
	targetId: string,
	targetRevision: number,
): MemoryRecordV1 {
	const target = records.find((candidate) => candidate.id === targetId);
	if (target === undefined) {
		throw new MemoryError(MEMORY_TARGET_NOT_FOUND, `memory supersede target "${targetId}" was not found`);
	}
	if (target.revision !== targetRevision) {
		throw new MemoryError(
			MEMORY_TARGET_STALE,
			`memory supersede target "${targetId}" is at revision ${target.revision}, not ${targetRevision}`,
		);
	}
	if (target.state !== "active") {
		throw new MemoryError(
			MEMORY_TARGET_INACTIVE,
			`memory supersede target "${targetId}" revision ${targetRevision} is already superseded and cannot be corrected again`,
		);
	}
	return target;
}

/**
 * Owns the single real Store transaction for add and exact read. All mutating
 * work runs inside Pi's `withFileMutationQueue` on the real Store path so
 * concurrent writes serialize and never lose updates.
 */
export class MemoryService {
	readonly #config: MemoryConfigV1;
	readonly #withFileMutationQueue: FileMutationQueue;
	readonly #fs: MemoryStoreFs;
	readonly #now: () => string;

	constructor(options: MemoryServiceOptions) {
		this.#config = options.config;
		this.#withFileMutationQueue = options.withFileMutationQueue;
		this.#fs = options.fs ?? createMemoryStoreFs();
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	async add(context: ExtensionContext, input: MemoryAddInput, signal?: AbortSignal): Promise<MemoryWriteOutcome> {
		return this.write(context, { operation: "add", ...input }, signal);
	}

	async supersede(
		context: ExtensionContext,
		input: MemorySupersedeInput,
		signal?: AbortSignal,
	): Promise<MemoryWriteOutcome> {
		return this.write(context, { operation: "supersede", ...input }, signal);
	}

	/**
	 * Single real Store transaction behind both `add` and `supersede`. All
	 * mutating work runs inside Pi's `withFileMutationQueue` on the real Store
	 * path so concurrent writes serialize and never lose updates.
	 */
	async write(context: ExtensionContext, input: MemoryWriteInput, signal?: AbortSignal): Promise<MemoryWriteOutcome> {
		const content = normalizeRecordText(input.content);
		const summary = normalizeRecordText(input.summary);
		validateRecordInput(content, summary, this.#config);
		const resolved = validateOperationInput(input);

		const identity = await resolveDirectoryIdentity(context.cwd);
		const storePath = getMemoryStorePath(identity);
		const storeDir = getMemoryStoreDirectory(identity);
		const sessionId = context.sessionManager.getSessionId();
		let leafId: string | null = null;
		try {
			leafId = context.sessionManager.getLeafId?.() ?? null;
		} catch {
			// Provenance entry is recorded only when available; never fails the write.
		}

		return this.#withFileMutationQueue(storePath, async () => {
			const classification = await classifyMemoryStore({
				storePath,
				limits: this.#config.store,
				...(signal === undefined ? {} : { signal }),
			});

			let store: MemoryStoreV1;
			const storeExists = classification.kind === "healthy";
			if (classification.kind === "missing") {
				store = emptyStore(identity);
			} else if (classification.kind === "healthy") {
				store = classification.store;
			} else {
				throw storeFailureError(classification);
			}

			// Resolve the exact active supersession target BEFORE any filesystem
			// mutation, so rejected corrections leave the directory byte-for-byte
			// untouched. A missing Store classifies as empty and rejects here.
			let plan: { readonly kind: "add" } | { readonly kind: "supersede"; readonly target: MemoryRecordV1 };
			if (resolved === "add") {
				plan = { kind: "add" };
			} else {
				plan = {
					kind: "supersede",
					target: resolveSupersedeTarget(store.records, resolved.targetId, resolved.targetRevision),
				};
			}

			let noOpRecord: MemoryRecordV1 | undefined;
			if (plan.kind === "add") {
				noOpRecord = store.records.find((record) => record.content === content && record.summary === summary);
			} else {
				const derivedId = deriveRecordId(content, summary);
				if (derivedId === plan.target.id) {
					// An exact normalized duplicate correction follows the idempotent
					// no-op policy rather than creating a noise successor.
					noOpRecord = plan.target;
				} else if (store.records.some((record) => record.id === derivedId)) {
					throw new MemoryError(
						MEMORY_IDENTITY_COLLISION,
						`memory supersede replacement content and summary already exist as record "${derivedId}"`,
					);
				}
			}

			if (noOpRecord === undefined && store.records.length >= this.#config.store.maxRecords) {
				throw new MemoryError(
					MEMORY_STORE_OVER_LIMIT,
					`memory store already holds ${this.#config.store.maxRecords} records (the configured limit)`,
				);
			}

			await ensureMemoryStoreDirectory(this.#fs, storeDir, signal);
			if (storeExists) await ensureMemoryStoreFileMode(this.#fs, storePath, signal);
			const ignoreMarker: IgnoreMarkerState = await ensureScopedIgnoreMarker(this.#fs, storeDir, signal);
			if (noOpRecord !== undefined) {
				return { kind: "no-op", record: noOpRecord, storeRevision: store.revision };
			}

			const timestamp = this.#now();
			const replaced =
				plan.kind === "supersede"
					? Object.freeze({ ...plan.target, state: "superseded" as const, updatedAt: timestamp })
					: null;
			const record =
				replaced === null
					? buildRecord(identity, sessionId, leafId, content, summary, timestamp, 1, null)
					: buildRecord(identity, sessionId, leafId, content, summary, timestamp, replaced.revision + 1, {
							id: replaced.id,
							revision: replaced.revision,
						});
			const records =
				replaced === null
					? store.records
					: store.records.map((candidate) => (candidate.id === replaced.id ? replaced : candidate));
			const nextStore: MemoryStoreV1 = Object.freeze({
				version: MEMORY_STORE_VERSION,
				schema: MEMORY_STORE_SCHEMA,
				revision: store.revision + 1,
				directory: Object.freeze({ id: identity }),
				records: Object.freeze([...records, record]),
			});
			const text = serializeMemoryStoreDocument(nextStore, this.#config.store);
			// Revalidate the exact serialized document before it is persisted.
			validateMemoryStoreDocument(JSON.parse(text) as unknown, this.#config.store);
			await atomicWriteStoreFile(this.#fs, storePath, text, signal);

			if (replaced !== null) {
				return {
					kind: "superseded",
					record,
					// The persisted and returned views share the same transitioned target;
					// its historical content/provenance are preserved byte-for-byte.
					replaced,
					previousStoreRevision: store.revision,
					storeRevision: nextStore.revision,
					ignoreMarker,
				};
			}
			return {
				kind: "added",
				record,
				previousStoreRevision: store.revision,
				storeRevision: nextStore.revision,
				ignoreMarker,
			};
		});
	}

	async read(context: ExtensionContext, input: MemoryReadInput, signal?: AbortSignal): Promise<MemoryReadOutcome> {
		const identity = await resolveDirectoryIdentity(context.cwd);
		const storePath = getMemoryStorePath(identity);
		const classification = await classifyMemoryStore({
			storePath,
			limits: this.#config.store,
			...(signal === undefined ? {} : { signal }),
		});
		if (classification.kind === "missing") {
			throw new MemoryError(
				MEMORY_RECORD_NOT_FOUND,
				`memory record "${input.id}" was not found (no memory store exists yet)`,
			);
		}
		if (classification.kind !== "healthy") {
			throw storeFailureError(classification);
		}
		const record = classification.store.records.find(
			(candidate) =>
				candidate.id === input.id && (input.revision === undefined || candidate.revision === input.revision),
		);
		if (record === undefined) {
			const revision = input.revision === undefined ? "" : ` revision ${input.revision}`;
			throw new MemoryError(MEMORY_RECORD_NOT_FOUND, `memory record "${input.id}"${revision} was not found`);
		}
		return { kind: "found", record };
	}

	async search(
		context: ExtensionContext,
		input: MemorySearchInput,
		signal?: AbortSignal,
	): Promise<MemorySearchOutcome> {
		const query = validateSearchQuery(input.query, this.#config.store.maxSummaryChars);
		const { applied, requested } = resolveRecordLimit(input.limit, this.#config.recall.maxRecords);
		const store = await this.#readStore(context.cwd, signal);
		const scored = rankActiveMatches(store, query);
		return {
			kind: "ok",
			query,
			...(requested === undefined ? {} : { requestedLimit: requested }),
			appliedLimit: applied,
			matchedCount: scored.length,
			hits: scored.slice(0, applied),
		};
	}

	/**
	 * Uncapped ranked search for automatic Recall. Uses the exact same pure
	 * ranking engine as `search`; Recall layers visible-fingerprint filtering
	 * and its own record budget on top of the full ranked list.
	 */
	async searchAll(
		context: ExtensionContext,
		input: { readonly query: string },
		signal?: AbortSignal,
	): Promise<MemorySearchAllOutcome> {
		const query = validateSearchQuery(input.query, this.#config.store.maxSummaryChars);
		const store = await this.#readStore(context.cwd, signal);
		const ranked = rankActiveMatches(store, query);
		return { kind: "ok", query, appliedLimit: this.#config.recall.maxRecords, matchedCount: ranked.length, ranked };
	}

	async listActive(
		context: ExtensionContext,
		input: MemoryListInput,
		signal?: AbortSignal,
	): Promise<MemoryListOutcome> {
		const { applied, requested } = resolveRecordLimit(input.limit, this.#config.recall.maxRecords);
		const store = await this.#readStore(context.cwd, signal);
		const active = store.records.filter((record) => record.state === "active").sort(compareRecency);
		return {
			kind: "ok",
			...(requested === undefined ? {} : { requestedLimit: requested }),
			appliedLimit: applied,
			totalActive: active.length,
			records: active.slice(0, applied),
		};
	}

	/** Shared read-only Store classification for search/list; never mutates anything. */
	async #readStore(cwd: string, signal?: AbortSignal): Promise<MemoryStoreV1> {
		const identity = await resolveDirectoryIdentity(cwd);
		const classification = await classifyMemoryStore({
			storePath: getMemoryStorePath(identity),
			limits: this.#config.store,
			...(signal === undefined ? {} : { signal }),
		});
		if (classification.kind === "missing") return emptyStore(identity);
		if (classification.kind !== "healthy") throw storeFailureError(classification);
		return classification.store;
	}
}
