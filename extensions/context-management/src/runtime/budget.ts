import { type ContextEvent, convertToLlm, estimateTokens, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { ESTIMATOR_SAMPLE_LIMIT } from "../constants.js";
import { stableJson } from "../stable-json.js";

export type AgentMessage = ContextEvent["messages"][number];

export interface ContextBudget {
	readonly contextWindow: number;
	readonly thresholdTokens: number;
	readonly retainTokens: number;
}

export function deriveContextBudget(
	contextWindow: number,
	policy: { readonly thresholdRatio: number; readonly retainRatio: number },
): ContextBudget {
	if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
		throw new RangeError(`Model context window must be a positive integer; received ${contextWindow}.`);
	}
	const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
	const retainTokens = Math.floor(contextWindow * policy.retainRatio);
	if (retainTokens >= thresholdTokens) {
		throw new RangeError(
			`retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens} for window ${contextWindow}.`,
		);
	}
	return Object.freeze({ contextWindow, thresholdTokens, retainTokens });
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
