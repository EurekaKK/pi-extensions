import { randomUUID } from "node:crypto";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { COMPACTION_DETAILS_SCHEMA } from "../constants.js";
import { parseEvidenceReference } from "../evidence/references.js";
import { sha256Hex } from "../stable-json.js";

export interface ContextManagementCompactionDetailsV1 {
	readonly type: typeof COMPACTION_DETAILS_SCHEMA;
	readonly schemaVersion: 1;
	readonly checkpointId: string;
	readonly coveredThroughEntryId: string;
	readonly firstKeptEntryId: string;
	readonly sourceFingerprint: string;
	readonly checkpointFingerprint: string;
	readonly createdAt: string;
	readonly evidenceReferences: readonly string[];
}

export interface InstalledCheckpoint {
	readonly kind: "context-management" | "legacy";
	readonly entryId: string;
	readonly summary: string;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
	readonly details?: ContextManagementCompactionDetailsV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCompactionDetails(value: unknown): ContextManagementCompactionDetailsV1 | null {
	if (!isRecord(value) || value.type !== COMPACTION_DETAILS_SCHEMA || value.schemaVersion !== 1) return null;
	if (
		typeof value.checkpointId !== "string" ||
		value.checkpointId.length === 0 ||
		typeof value.coveredThroughEntryId !== "string" ||
		value.coveredThroughEntryId.length === 0 ||
		typeof value.firstKeptEntryId !== "string" ||
		value.firstKeptEntryId.length === 0 ||
		typeof value.sourceFingerprint !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(value.sourceFingerprint) ||
		typeof value.checkpointFingerprint !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(value.checkpointFingerprint) ||
		typeof value.createdAt !== "string" ||
		!Number.isFinite(Date.parse(value.createdAt)) ||
		!Array.isArray(value.evidenceReferences)
	) {
		return null;
	}
	const references: string[] = [];
	for (const reference of value.evidenceReferences) {
		if (typeof reference !== "string") return null;
		try {
			parseEvidenceReference(reference);
		} catch {
			return null;
		}
		references.push(reference);
	}
	if (new Set(references).size !== references.length) return null;
	return Object.freeze({
		type: COMPACTION_DETAILS_SCHEMA,
		schemaVersion: 1,
		checkpointId: value.checkpointId,
		coveredThroughEntryId: value.coveredThroughEntryId,
		firstKeptEntryId: value.firstKeptEntryId,
		sourceFingerprint: value.sourceFingerprint,
		checkpointFingerprint: value.checkpointFingerprint,
		createdAt: value.createdAt,
		evidenceReferences: Object.freeze([...references].sort()),
	});
}

export function createCompactionDetails(input: {
	readonly summary: string;
	readonly coveredThroughEntryId: string;
	readonly firstKeptEntryId: string;
	readonly sourceFingerprint: string;
	readonly evidenceReferences: readonly string[];
	readonly now?: Date;
}): ContextManagementCompactionDetailsV1 {
	const sourceHash = /^[0-9a-f]{64}$/.test(input.sourceFingerprint)
		? input.sourceFingerprint
		: sha256Hex(input.sourceFingerprint);
	return Object.freeze({
		type: COMPACTION_DETAILS_SCHEMA,
		schemaVersion: 1,
		checkpointId: `checkpoint_${randomUUID()}`,
		coveredThroughEntryId: input.coveredThroughEntryId,
		firstKeptEntryId: input.firstKeptEntryId,
		sourceFingerprint: `sha256:${sourceHash}`,
		checkpointFingerprint: `sha256:${sha256Hex(input.summary)}`,
		createdAt: (input.now ?? new Date()).toISOString(),
		evidenceReferences: Object.freeze([...new Set(input.evidenceReferences)].sort()),
	});
}

function restored(entry: CompactionEntry): InstalledCheckpoint {
	const details = parseCompactionDetails(entry.details);
	if (
		details !== null &&
		details.firstKeptEntryId === entry.firstKeptEntryId &&
		details.checkpointFingerprint === `sha256:${sha256Hex(entry.summary)}`
	) {
		return Object.freeze({
			kind: "context-management",
			entryId: entry.id,
			summary: entry.summary,
			firstKeptEntryId: entry.firstKeptEntryId,
			tokensBefore: entry.tokensBefore,
			details,
		});
	}
	return Object.freeze({
		kind: "legacy",
		entryId: entry.id,
		summary: entry.summary,
		firstKeptEntryId: entry.firstKeptEntryId,
		tokensBefore: entry.tokensBefore,
	});
}

export function restoreLatestCheckpoint(entries: readonly SessionEntry[]): InstalledCheckpoint | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "compaction") return restored(entry);
	}
	return undefined;
}

export function coveredThroughEntryId(entries: readonly SessionEntry[], firstKeptEntryId: string): string | null {
	const keptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (keptIndex <= 0) return null;
	return entries[keptIndex - 1]?.id ?? null;
}
