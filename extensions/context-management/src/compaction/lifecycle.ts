import type { Usage } from "@earendil-works/pi-ai";
import type { CompactionResult, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { throwIfAborted } from "../errors.js";
import type { FinalizedToolPair } from "../evidence/references.js";
import { stableFingerprint } from "../stable-json.js";
import { type ContextManagementCompactionDetailsV1, createCompactionDetails } from "./details.js";
import { generateCheckpoint } from "./generator.js";
import type { CompactableSelection } from "./selection.js";
import { buildNormalizedCompactorSource } from "./source.js";

export interface PreparationSnapshot {
	readonly runtimeGeneration: number;
	readonly branchEpoch: number;
	readonly installedCheckpointEntryId: string | null;
	readonly coverageEntryIds: readonly string[];
	readonly firstKeptEntryId: string;
	readonly sourceFingerprint: string;
	readonly focus: string | null;
}

export interface CheckpointCandidate {
	readonly snapshot: PreparationSnapshot;
	readonly summary: string;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
	readonly usage: Usage;
	readonly details: ContextManagementCompactionDetailsV1;
}

function coverageIds(entries: readonly SessionEntry[], selection: CompactableSelection): readonly string[] {
	const start = entries.findIndex((entry) => entry.id === selection.firstEligibleEntryId);
	const end = entries.findIndex((entry) => entry.id === selection.firstKeptEntryId);
	if (start < 0 || end <= start) return Object.freeze([]);
	return Object.freeze(entries.slice(start, end).map((entry) => entry.id));
}

export async function createCheckpointCandidate(input: {
	readonly context: ExtensionContext;
	readonly selection: CompactableSelection;
	readonly contextEntries: readonly SessionEntry[];
	readonly evidencePairs: readonly FinalizedToolPair[];
	readonly runtimeGeneration: number;
	readonly branchEpoch: number;
	readonly installedCheckpointEntryId: string | null;
	readonly hardLimit: number;
	readonly tokensBefore: number;
	readonly focus?: string;
	readonly signal?: AbortSignal;
	readonly regenerateOnce: boolean;
}): Promise<CheckpointCandidate> {
	throwIfAborted(input.signal);
	const model = input.context.model;
	const supportsImages = model?.input.includes("image") ?? false;
	const source = buildNormalizedCompactorSource({
		messages: input.selection.newlyEligibleMessages,
		...(input.selection.previousCheckpoint === undefined
			? {}
			: { previousCheckpoint: input.selection.previousCheckpoint }),
		evidencePairs: input.evidencePairs,
		supportsImages,
	});
	throwIfAborted(input.signal);
	const sourceFingerprint = stableFingerprint(source.fingerprintInput);
	const generated = await generateCheckpoint({
		context: input.context,
		source,
		hardLimit: input.hardLimit,
		...(input.signal === undefined ? {} : { signal: input.signal }),
		...(input.focus === undefined ? {} : { focus: input.focus }),
		regenerateOnce: input.regenerateOnce,
	});
	const snapshot: PreparationSnapshot = Object.freeze({
		runtimeGeneration: input.runtimeGeneration,
		branchEpoch: input.branchEpoch,
		installedCheckpointEntryId: input.installedCheckpointEntryId,
		coverageEntryIds: coverageIds(input.contextEntries, input.selection),
		firstKeptEntryId: input.selection.firstKeptEntryId,
		sourceFingerprint,
		focus: input.focus?.trim() || null,
	});
	const details = createCompactionDetails({
		summary: generated.summary,
		coveredThroughEntryId: input.selection.coveredThroughEntryId,
		firstKeptEntryId: input.selection.firstKeptEntryId,
		sourceFingerprint,
		evidenceReferences: [...source.allowedEvidenceReferences],
	});
	return Object.freeze({
		snapshot,
		summary: generated.summary,
		firstKeptEntryId: input.selection.firstKeptEntryId,
		tokensBefore: input.tokensBefore,
		usage: generated.usage,
		details,
	});
}

export function isCandidateCompatible(input: {
	readonly candidate: CheckpointCandidate;
	readonly runtimeGeneration: number;
	readonly branchEpoch: number;
	readonly installedCheckpointEntryId: string | null;
	readonly contextEntries: readonly SessionEntry[];
	readonly focus?: string;
}): boolean {
	const snapshot = input.candidate.snapshot;
	if (
		snapshot.runtimeGeneration !== input.runtimeGeneration ||
		snapshot.branchEpoch !== input.branchEpoch ||
		snapshot.installedCheckpointEntryId !== input.installedCheckpointEntryId ||
		snapshot.focus !== (input.focus?.trim() || null)
	) {
		return false;
	}
	const currentIds = input.contextEntries.map((entry) => entry.id);
	const firstKeptIndex = currentIds.indexOf(snapshot.firstKeptEntryId);
	if (firstKeptIndex < snapshot.coverageEntryIds.length) return false;
	return snapshot.coverageEntryIds.every(
		(id, index) => currentIds[firstKeptIndex - snapshot.coverageEntryIds.length + index] === id,
	);
}

export function candidateCompactionResult(candidate: CheckpointCandidate): CompactionResult {
	return Object.freeze({
		summary: candidate.summary,
		firstKeptEntryId: candidate.firstKeptEntryId,
		tokensBefore: candidate.tokensBefore,
		usage: structuredClone(candidate.usage),
		details: candidate.details,
	});
}
