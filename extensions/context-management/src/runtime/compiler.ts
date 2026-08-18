import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type CompactableSelection, messageIndexForEntry, selectCompactable } from "../compaction/selection.js";
import type { ContextManagementConfigV1 } from "../config.js";
import {
	type ContextBudget,
	correctedEstimate,
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
	readonly overThreshold: boolean;
	readonly compactable: CompactableSelection | null;
	readonly compactableEstimate: number;
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

export function compileContext(input: {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly eventMessages: readonly AgentMessage[];
	readonly state: RuntimeState;
	readonly config: ContextManagementConfigV1;
}): CompiledContext {
	const model = input.context.model;
	if (model === undefined) throw new RangeError("No active model is selected.");
	const budget = deriveContextBudget(model.contextWindow, input.config);
	const contextEntries = input.context.sessionManager.buildContextEntries();
	const pending = pendingProjection(input.eventMessages, contextEntries, input.state);
	const messages = pending.messages;
	const projectedEntries = pending.entries;
	const tools = activeTools(input.pi);
	const fixedEstimate = estimateFixedEnvelope(input.context.getSystemPrompt(), tools);
	const projectionEstimate = estimateProjection(messages);
	const rawEstimate = fixedEstimate + projectionEstimate;
	const calibration = input.state.calibration.get(model.provider, model.id);
	const finalEstimate = correctedEstimate(rawEstimate, calibration);
	const compactable = selectCompactable({
		messages,
		contextEntries: projectedEntries,
		tailTarget: budget.retainTokens,
		currentRunEntryId: input.state.currentRunEntryId,
	});
	const compactableEstimate =
		compactable === null ? 0 : correctedEstimate(estimateProjection(compactable.newlyEligibleMessages), calibration);
	const checkpointEstimate = messages[0]?.role === "compactionSummary" ? estimateProjection([messages[0]]) : 0;
	const tailEstimate = compactable?.tail.estimatedTokens ?? estimateProjection(messages);
	input.state.metrics = {
		model: `${model.provider}/${model.id}`,
		contextWindow: budget.contextWindow,
		thresholdTokens: budget.thresholdTokens,
		retainTokens: budget.retainTokens,
		finalEstimate,
		remaining: budget.thresholdTokens - finalEstimate,
		fixedEstimate,
		checkpointEstimate,
		tailEstimate,
		tailRange: compactable === null ? "all" : `${compactable.firstKeptEntryId}..leaf`,
		compactableEstimate,
		prunedToolResults: input.state.prunedToolCallIds.size,
		overThreshold: finalEstimate >= budget.thresholdTokens,
	};
	return Object.freeze({
		messages,
		rawEstimate,
		correctedEstimate: finalEstimate,
		budget,
		overThreshold: finalEstimate >= budget.thresholdTokens,
		compactable,
		compactableEstimate,
		contextEntries: projectedEntries,
	});
}
