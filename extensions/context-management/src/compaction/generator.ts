import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	Provider,
	ProviderHeaders,
	ThinkingLevel,
	Usage,
} from "@earendil-works/pi-ai";
import { retryAssistantCall } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_INSTRUCTION,
	COMPACTOR_REQUEST_TIMEOUT_MS,
	COMPACTOR_TRANSPORT_MAX_RETRIES,
	COMPACTOR_TRANSPORT_RETRY_BASE_DELAY_MS,
} from "../constants.js";
import { ContextManagementError, throwIfAborted } from "../errors.js";
import { correctedEstimate, estimateFixedEnvelope, estimateProjection, estimateTextTokens } from "../runtime/budget.js";
import { estimateInstructionTokens, frameCheckpoint } from "./prompt.js";
import { validateCheckpointResponse } from "./validation.js";

type AgentMessage = ContextEvent["messages"][number];

export interface GeneratedCheckpoint {
	readonly summary: string;
	readonly usage: Usage;
	readonly sourceEstimatedTokens: number;
}

async function resolveProvider(
	context: ExtensionContext,
	model: Model<Api>,
): Promise<{
	readonly provider: Provider;
	readonly apiKey?: string;
	readonly headers?: ProviderHeaders;
	readonly env?: Record<string, string>;
}> {
	const provider = context.modelRegistry.getProvider(model.provider);
	if (provider === undefined) {
		throw new ContextManagementError(
			"context_management.compactor_auth_failure",
			`Active provider ${model.provider} is unavailable.`,
		);
	}
	const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new ContextManagementError("context_management.compactor_auth_failure", auth.error);
	}
	return {
		provider,
		...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
		...(auth.headers === undefined ? {} : { headers: auth.headers }),
		...(auth.env === undefined ? {} : { env: auth.env }),
	};
}

function summarizerContext(input: {
	readonly systemPrompt: string;
	readonly messages: readonly AgentMessage[];
}): Context {
	return {
		systemPrompt: input.systemPrompt,
		messages: [
			...convertToLlm([...input.messages]),
			{
				role: "user",
				content: [{ type: "text", text: COMPACTION_INSTRUCTION }],
				timestamp: Date.now(),
			},
		],
		tools: [],
	};
}

async function requestCheckpoint(input: {
	readonly extensionContext: ExtensionContext;
	readonly pi: ExtensionAPI;
	readonly model: Model<Api>;
	readonly provider: Provider;
	readonly messages: readonly AgentMessage[];
	readonly maxTokens: number;
	readonly signal?: AbortSignal;
	readonly apiKey?: string;
	readonly headers?: ProviderHeaders;
	readonly env?: Record<string, string>;
}): Promise<AssistantMessage> {
	throwIfAborted(input.signal);
	const systemPrompt = input.extensionContext.getSystemPrompt();
	const capacity =
		estimateFixedEnvelope(systemPrompt, []) +
		estimateProjection(input.messages) +
		estimateInstructionTokens() +
		8 +
		input.maxTokens;
	if (capacity > input.model.contextWindow) {
		throw new ContextManagementError(
			"context_management.compaction_infeasible",
			`Compactor request estimate ${capacity} exceeds model context window ${input.model.contextWindow}.`,
		);
	}
	const requestContext = summarizerContext({
		systemPrompt,
		messages: input.messages,
	});
	const sessionId = input.extensionContext.sessionManager.getSessionId();
	const selectedReasoning = input.extensionContext.thinkingLevel ?? input.pi.getThinkingLevel?.();
	const reasoning: ThinkingLevel | undefined =
		selectedReasoning === undefined || selectedReasoning === "off" ? undefined : selectedReasoning;
	const response = await retryAssistantCall(
		async () =>
			await input.provider
				.streamSimple(input.model, requestContext, {
					maxTokens: input.maxTokens,
					maxRetries: 0,
					...(reasoning === undefined ? {} : { reasoning }),
					timeoutMs: COMPACTOR_REQUEST_TIMEOUT_MS,
					sessionId,
					...(input.signal === undefined ? {} : { signal: input.signal }),
					...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
					...(input.headers === undefined ? {} : { headers: input.headers }),
					...(input.env === undefined ? {} : { env: input.env }),
				})
				.result(),
		{
			enabled: true,
			maxRetries: COMPACTOR_TRANSPORT_MAX_RETRIES,
			baseDelayMs: COMPACTOR_TRANSPORT_RETRY_BASE_DELAY_MS,
		},
		input.signal,
	);
	throwIfAborted(input.signal);
	if (response.stopReason === "error") {
		throw new ContextManagementError(
			"context_management.compactor_transport_failure",
			response.errorMessage ?? "Compactor provider request failed.",
		);
	}
	if (response.stopReason === "aborted") {
		throw new ContextManagementError("context_management.operation_aborted", "Compactor provider request was aborted.");
	}
	return response;
}

export async function generateCheckpoint(input: {
	readonly context: ExtensionContext;
	readonly pi: ExtensionAPI;
	readonly messages: readonly AgentMessage[];
	readonly shadowedTokenCount: number;
	readonly maxTokens: number;
	readonly calibration: number;
	readonly signal?: AbortSignal;
	readonly regenerateOnce: boolean;
}): Promise<GeneratedCheckpoint> {
	throwIfAborted(input.signal);
	const model = input.context.model;
	if (model === undefined) {
		throw new ContextManagementError("context_management.compaction_infeasible", "No active model is selected.");
	}
	const maxTokens = Math.min(input.maxTokens, model.maxTokens);
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
		throw new ContextManagementError(
			"context_management.compaction_infeasible",
			"The active model has no usable checkpoint output budget.",
		);
	}
	const auth = await resolveProvider(input.context, model);
	throwIfAborted(input.signal);
	let correction: string | undefined;
	const attempts = input.regenerateOnce ? 2 : 1;
	const sourceEstimatedTokens = estimateProjection(input.messages);
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		throwIfAborted(input.signal);
		let response: AssistantMessage;
		try {
			response = await requestCheckpoint({
				extensionContext: input.context,
				pi: input.pi,
				model,
				provider: auth.provider,
				messages: input.messages,
				maxTokens,
				...(input.signal === undefined ? {} : { signal: input.signal }),
				...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
				...(auth.headers === undefined ? {} : { headers: auth.headers }),
				...(auth.env === undefined ? {} : { env: auth.env }),
			});
		} catch (error) {
			if (error instanceof ContextManagementError) throw error;
			throw new ContextManagementError(
				"context_management.compactor_transport_failure",
				error instanceof Error ? error.message : String(error),
			);
		}
		const validation = validateCheckpointResponse(response);
		if (!validation.ok) {
			correction = validation.reason;
			continue;
		}
		const framed = frameCheckpoint(validation.text);
		const framedTokens = correctedEstimate(estimateTextTokens(framed), input.calibration);
		if (framedTokens >= input.shadowedTokenCount) {
			correction = `summary is not smaller than the shadowed content (${framedTokens} >= ${input.shadowedTokenCount})`;
			continue;
		}
		return Object.freeze({
			summary: framed,
			usage: structuredClone(response.usage),
			sourceEstimatedTokens,
		});
	}
	throw new ContextManagementError(
		"context_management.checkpoint_validation_failure",
		correction ?? "Checkpoint validation failed.",
	);
}
