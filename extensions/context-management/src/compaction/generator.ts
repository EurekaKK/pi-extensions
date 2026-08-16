import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type Provider,
	type ProviderHeaders,
	retryAssistantCall,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_SYSTEM_PROMPT,
	COMPACTION_GENERATION_MARGIN_TOKENS,
	COMPACTOR_REQUEST_TIMEOUT_MS,
	COMPACTOR_TRANSPORT_MAX_RETRIES,
	COMPACTOR_TRANSPORT_RETRY_BASE_DELAY_MS,
} from "../constants.js";
import { ContextManagementError, throwIfAborted } from "../errors.js";
import { deriveContextBudget, estimateTextTokens } from "../runtime/budget.js";
import { COMPACTOR_SOURCE_PREAMBLE, estimateCompactorPromptOverhead } from "./prompt.js";
import type { NormalizedCompactorSource } from "./source.js";
import { validateCheckpointResponse } from "./validation.js";

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

function compactorSuffix(focus?: string, correction?: string): string {
	return [
		focus === undefined || focus.trim().length === 0 ? undefined : `Compaction focus:\n${focus.trim()}`,
		correction === undefined ? undefined : `The prior candidate was mechanically rejected: ${correction}`,
	]
		.filter((part): part is string => part !== undefined)
		.join("\n\n");
}

function compactorContext(source: NormalizedCompactorSource, suffix: string): Context {
	const content = [
		{ type: "text" as const, text: COMPACTOR_SOURCE_PREAMBLE },
		...source.content,
		...(suffix.length === 0 ? [] : [{ type: "text" as const, text: `\n${suffix}` }]),
	];
	return {
		systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
		messages: [{ role: "user", content, timestamp: Date.now() }],
		tools: [],
	};
}

async function requestCheckpoint(input: {
	readonly extensionContext: ExtensionContext;
	readonly model: Model<Api>;
	readonly provider: Provider;
	readonly source: NormalizedCompactorSource;
	readonly hardLimit: number;
	readonly signal?: AbortSignal;
	readonly apiKey?: string;
	readonly headers?: ProviderHeaders;
	readonly env?: Record<string, string>;
	readonly focus?: string;
	readonly correction?: string;
}): Promise<AssistantMessage> {
	throwIfAborted(input.signal);
	const maxTokens = Math.min(input.model.maxTokens, input.hardLimit + COMPACTION_GENERATION_MARGIN_TOKENS);
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
		throw new ContextManagementError(
			"context_management.compaction_infeasible",
			"The active model has no usable checkpoint output budget.",
		);
	}
	const variablePrompt = compactorSuffix(input.focus, input.correction);
	const budget = deriveContextBudget(input.model.contextWindow);
	const estimatedCapacity =
		input.source.estimatedTokens +
		estimateCompactorPromptOverhead() +
		estimateTextTokens(variablePrompt.length === 0 ? "" : `\n${variablePrompt}`) +
		maxTokens +
		budget.estimationMargin;
	if (estimatedCapacity > input.model.contextWindow) {
		throw new ContextManagementError(
			"context_management.compaction_infeasible",
			`Compactor request estimate ${estimatedCapacity} exceeds model context window ${input.model.contextWindow}.`,
		);
	}
	const thinking = input.extensionContext.thinkingLevel;
	const requestContext = compactorContext(input.source, variablePrompt);
	const sessionId = `context-management-compactor-${randomUUID()}`;
	const response = await retryAssistantCall(
		async () =>
			await input.provider
				.streamSimple(input.model, requestContext, {
					cacheRetention: "none",
					maxTokens,
					maxRetries: 0,
					timeoutMs: COMPACTOR_REQUEST_TIMEOUT_MS,
					sessionId,
					...(input.signal === undefined ? {} : { signal: input.signal }),
					...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
					...(input.headers === undefined ? {} : { headers: input.headers }),
					...(input.env === undefined ? {} : { env: input.env }),
					...(thinking === undefined || thinking === "off" ? {} : { reasoning: thinking }),
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
	readonly source: NormalizedCompactorSource;
	readonly hardLimit: number;
	readonly signal?: AbortSignal;
	readonly focus?: string;
	readonly regenerateOnce: boolean;
}): Promise<GeneratedCheckpoint> {
	throwIfAborted(input.signal);
	const model = input.context.model;
	if (model === undefined) {
		throw new ContextManagementError("context_management.compaction_infeasible", "No active model is selected.");
	}
	const auth = await resolveProvider(input.context, model);
	throwIfAborted(input.signal);
	let correction: string | undefined;
	const attempts = input.regenerateOnce ? 2 : 1;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		throwIfAborted(input.signal);
		let response: AssistantMessage;
		try {
			response = await requestCheckpoint({
				extensionContext: input.context,
				model,
				provider: auth.provider,
				source: input.source,
				hardLimit: input.hardLimit,
				...(input.signal === undefined ? {} : { signal: input.signal }),
				...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
				...(auth.headers === undefined ? {} : { headers: auth.headers }),
				...(auth.env === undefined ? {} : { env: auth.env }),
				...(input.focus === undefined ? {} : { focus: input.focus }),
				...(correction === undefined ? {} : { correction }),
			});
		} catch (error) {
			if (error instanceof ContextManagementError) throw error;
			throw new ContextManagementError(
				"context_management.compactor_transport_failure",
				error instanceof Error ? error.message : String(error),
			);
		}
		const validation = validateCheckpointResponse(response, input.hardLimit, input.source.allowedEvidenceReferences);
		if (validation.ok) {
			return Object.freeze({
				summary: validation.text,
				usage: structuredClone(response.usage),
				sourceEstimatedTokens: input.source.estimatedTokens,
			});
		}
		correction = validation.reason;
	}
	throw new ContextManagementError(
		"context_management.checkpoint_validation_failure",
		correction ?? "Checkpoint validation failed.",
	);
}
