import type { Api, AssistantMessage, Context, Model, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { ModelsError, retryAssistantCall } from "@earendil-works/pi-ai";
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

/**
 * 通过 session 的 model registry 发起 compactor 请求。
 *
 * Pi 0.86.0 起 `Provider.streamSimple` 只接受 `normalizeContext()` 产出的 `TranscriptContext`，
 * 而 `ModelRegistry.streamSimple` 接收裸 `Context`，并负责 transcript 归一化、凭据解析与
 * `auth.baseUrl` 覆盖，因此 compactor 不再自己解析 provider 与凭据，也不再直接触达 provider 层。
 */
async function streamCompactorRequest(input: {
	readonly extensionContext: ExtensionContext;
	readonly model: Model<Api>;
	readonly context: Context;
	readonly maxTokens: number;
	readonly reasoning: ThinkingLevel | undefined;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
}): Promise<AssistantMessage> {
	try {
		return await input.extensionContext.modelRegistry
			.streamSimple(input.model, input.context, {
				maxTokens: input.maxTokens,
				maxRetries: 0,
				...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
				timeoutMs: COMPACTOR_REQUEST_TIMEOUT_MS,
				sessionId: input.sessionId,
				...(input.signal === undefined ? {} : { signal: input.signal }),
			})
			.result();
	} catch (error) {
		if (
			error instanceof ModelsError &&
			(error.code === "auth" || error.code === "oauth" || error.code === "provider")
		) {
			throw new ContextManagementError(
				"context_management.compactor_auth_failure",
				`Compactor request was rejected by the model registry: ${error.message}`,
			);
		}
		throw error;
	}
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
	readonly messages: readonly AgentMessage[];
	readonly maxTokens: number;
	readonly signal?: AbortSignal;
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
		() =>
			streamCompactorRequest({
				extensionContext: input.extensionContext,
				model: input.model,
				context: requestContext,
				maxTokens: input.maxTokens,
				reasoning,
				sessionId,
				...(input.signal === undefined ? {} : { signal: input.signal }),
			}),
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
				messages: input.messages,
				maxTokens,
				...(input.signal === undefined ? {} : { signal: input.signal }),
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
