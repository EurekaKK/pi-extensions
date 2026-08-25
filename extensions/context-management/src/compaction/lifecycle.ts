import type { Usage } from "@earendil-works/pi-ai";
import type { CompactionResult, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { throwIfAborted } from "../errors.js";
import { estimateProjection } from "../runtime/budget.js";
import { stableFingerprint } from "../stable-json.js";
import { type ContextManagementCompactionDetailsV1, createCompactionDetails } from "./details.js";
import { generateCheckpoint } from "./generator.js";
import type { CompactableSelection } from "./selection.js";

export interface PreparationSnapshot {
	readonly runtimeGeneration: number;
	readonly branchEpoch: number;
	readonly installedCheckpointEntryId: string | null;
	readonly coverageEntryIds: readonly string[];
	readonly firstKeptEntryId: string;
	readonly sourceFingerprint: string;
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

function compactorSource(selection: CompactableSelection): CompactableSelection["newlyEligibleMessages"] {
	return Object.freeze([
		...(selection.previousCheckpoint === undefined
			? []
			: [
					{
						role: "compactionSummary" as const,
						summary: selection.previousCheckpoint,
						tokensBefore: 0,
						timestamp: 0,
					},
				]),
		...selection.newlyEligibleMessages.map((message) => structuredClone(message)),
	]);
}

export async function createCheckpointCandidate(input: {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly selection: CompactableSelection;
	readonly contextEntries: readonly SessionEntry[];
	readonly runtimeGeneration: number;
	readonly branchEpoch: number;
	readonly installedCheckpointEntryId: string | null;
	readonly tokensBefore: number;
	readonly maxTokens: number;
	readonly calibration: number;
	readonly signal?: AbortSignal;
	readonly regenerateOnce: boolean;
}): Promise<CheckpointCandidate> {
	throwIfAborted(input.signal);
	const sourceMessages = compactorSource(input.selection);
	const sourceFingerprint = stableFingerprint(
		sourceMessages.map((message) => {
			if (message.role === "toolResult") {
				return { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName };
			}
			if (message.role === "compactionSummary" || message.role === "branchSummary") {
				return { role: message.role, summary: message.summary };
			}
			return { role: message.role };
		}),
	);
	const generated = await generateCheckpoint({
		context: input.context,
		pi: input.pi,
		messages: sourceMessages,
		shadowedTokenCount: Math.max(1, estimateProjection(sourceMessages)),
		maxTokens: input.maxTokens,
		calibration: input.calibration,
		...(input.signal === undefined ? {} : { signal: input.signal }),
		regenerateOnce: input.regenerateOnce,
	});
	const snapshot: PreparationSnapshot = Object.freeze({
		runtimeGeneration: input.runtimeGeneration,
		branchEpoch: input.branchEpoch,
		installedCheckpointEntryId: input.installedCheckpointEntryId,
		coverageEntryIds: coverageIds(input.contextEntries, input.selection),
		firstKeptEntryId: input.selection.firstKeptEntryId,
		sourceFingerprint,
	});
	const details = createCompactionDetails({
		summary: generated.summary,
		coveredThroughEntryId: input.selection.coveredThroughEntryId,
		firstKeptEntryId: input.selection.firstKeptEntryId,
		sourceFingerprint,
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
}): boolean {
	const snapshot = input.candidate.snapshot;
	if (
		snapshot.runtimeGeneration !== input.runtimeGeneration ||
		snapshot.branchEpoch !== input.branchEpoch ||
		snapshot.installedCheckpointEntryId !== input.installedCheckpointEntryId
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
