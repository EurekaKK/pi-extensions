import { type ContextEvent, convertToLlm, estimateTokens, type ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_GENERATION_MARGIN_TOKENS,
	ESTIMATOR_SAMPLE_LIMIT,
	GENERATION_HEADROOM_TOKENS,
	PREPARATION_MIN_LEAD_TOKENS,
} from "../constants.js";
import { stableJson } from "../stable-json.js";

export type AgentMessage = ContextEvent["messages"][number];

export interface ContextBudget {
	readonly contextWindow: number;
	readonly generationHeadroom: number;
	readonly safeInput: number;
	readonly protectedTailTarget: number;
	readonly checkpointHardLimit: number;
	readonly compactionGenerationMargin: number;
	readonly estimationMargin: number;
	readonly preparationLead: number;
}

export interface CompactionThresholds {
	readonly blocking: number;
	readonly preparation: number;
}

export function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function deriveContextBudget(contextWindow: number): ContextBudget {
	if (!Number.isSafeInteger(contextWindow) || contextWindow <= GENERATION_HEADROOM_TOKENS) {
		throw new RangeError(
			`Model context window must be an integer greater than ${GENERATION_HEADROOM_TOKENS}; received ${contextWindow}.`,
		);
	}
	const safeInput = contextWindow - GENERATION_HEADROOM_TOKENS;
	const protectedTailTarget = clamp(Math.floor(safeInput * 0.1), 20_000, 64_000);
	return Object.freeze({
		contextWindow,
		generationHeadroom: GENERATION_HEADROOM_TOKENS,
		safeInput,
		protectedTailTarget,
		checkpointHardLimit: protectedTailTarget,
		compactionGenerationMargin: COMPACTION_GENERATION_MARGIN_TOKENS,
		estimationMargin: clamp(Math.floor(contextWindow * 0.005), 1_024, 4_096),
		preparationLead: Math.max(PREPARATION_MIN_LEAD_TOKENS, Math.floor(contextWindow * 0.1)),
	});
}

export function deriveCompactionThresholds(
	budget: ContextBudget,
	correctedPromptOverhead: number,
): CompactionThresholds {
	if (!Number.isFinite(correctedPromptOverhead) || correctedPromptOverhead < 0) {
		throw new RangeError("Compaction prompt overhead must be a non-negative finite number.");
	}
	const blocking = Math.floor(
		budget.contextWindow -
			budget.checkpointHardLimit -
			budget.compactionGenerationMargin -
			correctedPromptOverhead -
			budget.estimationMargin,
	);
	return Object.freeze({
		blocking,
		preparation: Math.max(0, blocking - budget.preparationLead),
	});
}

export function evidenceNetSavingsGate(currentProjectionTokens: number): number {
	if (!Number.isFinite(currentProjectionTokens) || currentProjectionTokens < 0) {
		throw new RangeError("Projection token estimate must be a non-negative finite number.");
	}
	return Math.max(2_048, Math.floor(currentProjectionTokens * 0.05));
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function estimateToolEnvelope(tools: readonly ToolInfo[]): number {
	const stableTools = tools.map((tool) => ({
		description: tool.description,
		name: tool.name,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines ?? [],
	}));
	return estimateTextTokens(stableJson(stableTools));
}

export function estimateFixedEnvelope(systemPrompt: string, tools: readonly ToolInfo[]): number {
	return estimateTextTokens(systemPrompt) + estimateToolEnvelope(tools);
}

export function estimateProjection(messages: readonly AgentMessage[]): number {
	let total = 2;
	for (const message of convertToLlm([...messages])) total += estimateTokens(message) + 4;
	return total;
}

export function correctedEstimate(rawEstimate: number, calibration: number): number {
	if (!Number.isFinite(rawEstimate) || rawEstimate < 0) throw new RangeError("Raw estimate must be non-negative.");
	if (!Number.isFinite(calibration) || calibration < 1) throw new RangeError("Calibration must be at least one.");
	return Math.ceil(rawEstimate * calibration);
}

export class EstimatorCalibration {
	readonly #samples = new Map<string, number[]>();

	get(provider: string, modelId: string): number {
		const values = this.#samples.get(`${provider}\u0000${modelId}`);
		return values === undefined || values.length === 0 ? 1 : Math.max(1, ...values);
	}

	record(provider: string, modelId: string, rawEstimate: number, reportedPromptTokens: number): boolean {
		if (
			!Number.isFinite(rawEstimate) ||
			rawEstimate <= 0 ||
			!Number.isFinite(reportedPromptTokens) ||
			reportedPromptTokens <= 0
		) {
			return false;
		}
		const key = `${provider}\u0000${modelId}`;
		const values = this.#samples.get(key) ?? [];
		values.push(reportedPromptTokens / rawEstimate);
		if (values.length > ESTIMATOR_SAMPLE_LIMIT) values.splice(0, values.length - ESTIMATOR_SAMPLE_LIMIT);
		this.#samples.set(key, values);
		return true;
	}

	clear(): void {
		this.#samples.clear();
	}
}
