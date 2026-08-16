import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateCompactorPromptOverhead } from "../compaction/prompt.js";
import { type CompactableSelection, messageIndexForEntry, selectCompactable } from "../compaction/selection.js";
import { buildNormalizedCompactorSource } from "../compaction/source.js";
import { MEMORY_RECALL_CUSTOM_TYPE } from "../constants.js";
import { applyEvidenceReductions, applySupersessionMarkers } from "../evidence/projection.js";
import { indexFinalizedToolPairs } from "../evidence/references.js";
import type { EvidenceAdmissionCandidate } from "../evidence/state.js";
import {
	type ContextBudget,
	correctedEstimate,
	deriveCompactionThresholds,
	deriveContextBudget,
	estimateFixedEnvelope,
	estimateProjection,
} from "./budget.js";
import type { RuntimeState } from "./state.js";

type AgentMessage = ContextEvent["messages"][number];

export interface CompiledContext {
	readonly messages: AgentMessage[];
	readonly rawEstimate: number;
	readonly correctedEstimate: number;
	readonly budget: ContextBudget;
	readonly fits: boolean;
	readonly compactable: CompactableSelection | null;
	readonly compactableEstimate: number;
	readonly prepareThreshold: number;
	readonly blockingThreshold: number;
	readonly crossesBlocking: boolean;
	readonly contextEntries: readonly SessionEntry[];
}

function activeTools(pi: ExtensionAPI) {
	const names = new Set(pi.getActiveTools());
	return pi.getAllTools().filter((tool) => names.has(tool.name));
}

function pendingProjection(
	messages: readonly AgentMessage[],
	entries: readonly SessionEntry[],
	state: RuntimeState,
): { readonly messages: AgentMessage[]; readonly entries: readonly SessionEntry[] } {
	const pending = state.pendingCheckpoint;
	if (pending === undefined) {
		return { messages: messages.map((message) => structuredClone(message)), entries };
	}
	const boundary = messageIndexForEntry(entries, pending.firstKeptEntryId);
	const entryBoundary = entries.findIndex((entry) => entry.id === pending.firstKeptEntryId);
	if (boundary === null || entryBoundary < 0) {
		return { messages: messages.map((message) => structuredClone(message)), entries };
	}
	const syntheticEntry: SessionEntry = {
		type: "compaction",
		id: pending.details.checkpointId,
		parentId: entries[entryBoundary - 1]?.id ?? null,
		timestamp: pending.details.createdAt,
		summary: pending.summary,
		firstKeptEntryId: pending.firstKeptEntryId,
		tokensBefore: pending.tokensBefore,
		details: pending.details,
		usage: pending.usage,
		fromHook: true,
	};
	return {
		messages: [
			{
				role: "compactionSummary",
				summary: pending.summary,
				tokensBefore: pending.tokensBefore,
				timestamp: Date.parse(pending.details.createdAt),
			},
			...messages.slice(boundary).map((message) => structuredClone(message)),
		],
		entries: Object.freeze([syntheticEntry, ...entries.slice(entryBoundary)]),
	};
}

function packAnchor(projected: readonly AgentMessage[], entries: readonly SessionEntry[], state: RuntimeState): number {
	const rawIndex = messageIndexForEntry(entries, state.currentRunEntryId);
	if (rawIndex !== null) {
		return Math.min(rawIndex, projected.length);
	}
	for (let index = projected.length - 1; index >= 0; index -= 1) {
		if (projected[index]?.role === "user") return index;
	}
	return projected.length;
}

function memoryMessage(state: RuntimeState): AgentMessage | null {
	if (state.memoryPackSuppressed || state.memoryPack === null || state.memoryPack.items.length === 0) return null;
	return {
		role: "custom",
		customType: MEMORY_RECALL_CUSTOM_TYPE,
		content: state.memoryPack.text,
		display: false,
		timestamp: state.runTimestamp,
	};
}

function insertPacks(
	messages: readonly AgentMessage[],
	anchor: number,
	state: RuntimeState,
	extraEvidence?: EvidenceAdmissionCandidate,
): AgentMessage[] {
	const memory = memoryMessage(state);
	const evidence = state.evidence.projectMessage(extraEvidence);
	const packs = [memory, evidence].filter((message): message is AgentMessage => message !== null);
	return [
		...messages.slice(0, anchor).map((message) => structuredClone(message)),
		...packs,
		...messages.slice(anchor).map((message) => structuredClone(message)),
	];
}

export function compileContext(input: {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly eventMessages: readonly AgentMessage[];
	readonly state: RuntimeState;
	readonly extraEvidence?: EvidenceAdmissionCandidate;
}): CompiledContext {
	const model = input.context.model;
	if (model === undefined) throw new RangeError("No active model is selected.");
	const budget = deriveContextBudget(model.contextWindow);
	const contextEntries = input.context.sessionManager.buildContextEntries();
	const pending = pendingProjection(input.eventMessages, contextEntries, input.state);
	const reduced = applyEvidenceReductions(pending.messages, input.state.activeReductions);
	const marked = applySupersessionMarkers(reduced, input.state.pendingSupersessions);
	const withFailures = input.state.evidence.applyFailures(marked);
	const projectedEntries = pending.entries;
	const anchor = packAnchor(withFailures, projectedEntries, input.state);
	const messages = insertPacks(withFailures, anchor, input.state, input.extraEvidence);
	const tools = activeTools(input.pi);
	const fixedEstimate = estimateFixedEnvelope(input.context.getSystemPrompt(), tools);
	const projectionEstimate = estimateProjection(messages);
	const rawEstimate = fixedEstimate + projectionEstimate;
	const calibration = input.state.calibration.get(model.provider, model.id);
	const finalEstimate = correctedEstimate(rawEstimate, calibration);

	const compactable = selectCompactable({
		messages: withFailures,
		contextEntries: projectedEntries,
		tailTarget: budget.protectedTailTarget,
		currentRunEntryId: input.state.currentRunEntryId,
	});
	const evidencePairs = indexFinalizedToolPairs(input.context.sessionManager.getBranch());
	let compactableEstimate = 0;
	if (compactable !== null) {
		compactableEstimate = correctedEstimate(
			buildNormalizedCompactorSource({
				messages: compactable.newlyEligibleMessages,
				...(compactable.previousCheckpoint === undefined ? {} : { previousCheckpoint: compactable.previousCheckpoint }),
				evidencePairs,
				supportsImages: model.input.includes("image"),
			}).estimatedTokens,
			calibration,
		);
	}
	const compactorOverhead = correctedEstimate(estimateCompactorPromptOverhead(), calibration);
	const thresholds = deriveCompactionThresholds(budget, compactorOverhead);
	const rootIndex = packAnchor(withFailures, projectedEntries, input.state);
	const currentRunEstimate = estimateProjection(withFailures.slice(rootIndex));
	const checkpointEstimate = withFailures[0]?.role === "compactionSummary" ? estimateProjection([withFailures[0]]) : 0;
	const tailEstimate = compactable?.tail.estimatedTokens ?? estimateProjection(withFailures);
	input.state.metrics = {
		model: `${model.provider}/${model.id}`,
		contextWindow: model.contextWindow,
		safeInput: budget.safeInput,
		finalEstimate,
		remaining: budget.safeInput - finalEstimate,
		fixedEstimate,
		checkpointEstimate,
		tailEstimate,
		tailTarget: budget.protectedTailTarget,
		tailRange: compactable === null ? "all" : `${compactable.firstKeptEntryId}..leaf`,
		memoryEstimate: memoryMessage(input.state) === null ? 0 : (input.state.memoryPack?.estimatedTokens ?? 0),
		evidenceEstimate:
			input.state.evidence.projectMessage(input.extraEvidence) === null
				? 0
				: estimateProjection([input.state.evidence.projectMessage(input.extraEvidence) as AgentMessage]),
		currentRunEstimate,
		compactableEstimate,
		prepareThreshold: thresholds.preparation,
		blockingThreshold: thresholds.blocking,
	};
	return Object.freeze({
		messages,
		rawEstimate,
		correctedEstimate: finalEstimate,
		budget,
		fits: finalEstimate <= budget.safeInput,
		compactable,
		compactableEstimate,
		prepareThreshold: thresholds.preparation,
		blockingThreshold: thresholds.blocking,
		crossesBlocking: compactable !== null && compactableEstimate >= thresholds.blocking,
		contextEntries: projectedEntries,
	});
}
