import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	GOAL_SNAPSHOT_IMAGE_TOOL,
	GOAL_SNAPSHOT_READ_TOOL,
	GOAL_SNAPSHOT_SEARCH_TOOL,
	GOAL_SUBMIT_EVALUATION_TOOL,
} from "./constants.js";
import { type GoalEvaluationReportV1, parseGoalEvaluationReport, type RestoredGoalStateV1 } from "./domain.js";
import { createGoalEvaluatorTools } from "./evaluator-tools.js";
import { buildEvaluatorSystemPrompt, GOAL_EVALUATOR_CORRECTION_PROMPT } from "./prompts.js";
import { createGoalProviderBridge } from "./provider-bridge.js";
import {
	createGoalEvaluationSnapshot,
	type GoalCapabilitiesSnapshot,
	type GoalEvaluationHistoryRecord,
} from "./snapshots.js";

const EVALUATOR_TOOL_NAMES = [
	GOAL_SNAPSHOT_READ_TOOL,
	GOAL_SNAPSHOT_SEARCH_TOOL,
	GOAL_SNAPSHOT_IMAGE_TOOL,
	GOAL_SUBMIT_EVALUATION_TOOL,
] as const;

const EVALUATOR_PROMPT =
	"Evaluate the active immutable goal now. Inspect the snapshot bundle as needed, then submit exactly one report.";

export class GoalEvaluatorInfrastructureError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "GoalEvaluatorInfrastructureError";
	}
}

export class GoalEvaluatorFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalEvaluatorFormatError";
	}
}

export interface RunGoalEvaluationInput {
	readonly pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel">;
	readonly context: ExtensionContext;
	readonly goal: RestoredGoalStateV1;
	readonly evaluationNumber: number;
	readonly activeElapsedMs: number;
	readonly signal: AbortSignal;
}

function activeModel(context: ExtensionContext): NonNullable<ExtensionContext["model"]> {
	if (context.model === undefined) throw new GoalEvaluatorInfrastructureError("No active model is selected.");
	return context.model;
}

function supportsImages(model: Model<string>): boolean {
	return model.input.includes("image");
}

function projectEvaluationHistory(goal: RestoredGoalStateV1): GoalEvaluationHistoryRecord[] {
	return goal.evaluationHistory.map((entry) => ({
		evaluationNumber: entry.evaluationNumber,
		decision: entry.report.decision,
		progress: entry.report.progress,
		reason: entry.report.reason,
		next_action: entry.report.next_action,
		evidence: entry.report.evidence,
		activeElapsedMs: entry.activeElapsedMs,
		mainRunId: entry.precedingMainRunId,
		timestamp: new Date(entry.timestamp).toISOString(),
	}));
}

function projectCapabilities(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel">,
	context: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
): GoalCapabilitiesSnapshot {
	const active = new Set(pi.getActiveTools());
	return {
		activeTools: pi
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				promptGuidelines: tool.promptGuidelines ?? [],
				sourceInfo: tool.sourceInfo,
			})),
		mode: context.mode,
		cwd: context.cwd,
		projectTrusted: context.isProjectTrusted(),
		model: { provider: model.provider, id: model.id },
		thinkingLevel: context.thinkingLevel ?? pi.getThinkingLevel(),
	};
}

function lastAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message === "object" && message !== null && "role" in message && message.role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return undefined;
}

function infrastructureMessage(message: AssistantMessage | undefined): string | undefined {
	if (message?.stopReason !== "error") return undefined;
	return message.errorMessage?.trim() || "The evaluator model failed after Pi retries.";
}

function requireAcceptedReport(value: unknown): GoalEvaluationReportV1 {
	const report = parseGoalEvaluationReport(value);
	if (report === null) throw new GoalEvaluatorFormatError("The evaluator submitted an invalid report.");
	return report;
}

export async function runGoalEvaluation(input: RunGoalEvaluationInput): Promise<GoalEvaluationReportV1> {
	input.signal.throwIfAborted();
	const model = activeModel(input.context);
	const snapshot = await createGoalEvaluationSnapshot({
		ownerSessionId: input.goal.ownerSessionId,
		entries: input.context.sessionManager.getEntries(),
		currentLeafId: input.context.sessionManager.getLeafId(),
		creationAnchorEntryId: input.goal.creationAnchorEntryId,
		evaluationHistory: projectEvaluationHistory(input.goal),
		capabilities: projectCapabilities(input.pi, input.context, model),
		signal: input.signal,
	});

	let evaluatorSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let unsubscribe: (() => void) | undefined;
	const abortEvaluator = () => {
		if (evaluatorSession !== undefined) void evaluatorSession.abort();
	};
	input.signal.addEventListener("abort", abortEvaluator, { once: true });

	try {
		const agentDirectory = getAgentDir();
		const settingsManager = SettingsManager.create(input.context.cwd, agentDirectory, {
			projectTrusted: input.context.isProjectTrusted(),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: snapshot.root,
			agentDir: agentDirectory,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: buildEvaluatorSystemPrompt({
				goalText: input.goal.goalText,
				evaluationNumber: input.evaluationNumber,
				activeElapsedMs: input.activeElapsedMs,
				snapshotRoot: snapshot.root,
			}),
		});
		await resourceLoader.reload();
		input.signal.throwIfAborted();

		const bridge = await createGoalProviderBridge(input.context.modelRegistry, model);
		const toolset = createGoalEvaluatorTools({ snapshot, supportsImages: supportsImages(model) });
		const created = await createAgentSession({
			cwd: snapshot.root,
			agentDir: agentDirectory,
			modelRuntime: bridge.modelRuntime,
			model,
			thinkingLevel: input.context.thinkingLevel ?? input.pi.getThinkingLevel(),
			tools: [...EVALUATOR_TOOL_NAMES],
			customTools: [...toolset.tools],
			resourceLoader,
			sessionManager: SessionManager.inMemory(snapshot.root),
			settingsManager,
		});
		evaluatorSession = created.session;

		let finalAssistant: AssistantMessage | undefined;
		const getFinalAssistant = (): AssistantMessage | undefined => finalAssistant;
		let formatExhausted = false;
		const submitFailureBaselines = new Map<string, number>();
		unsubscribe = evaluatorSession.subscribe((event) => {
			if (event.type === "agent_end") finalAssistant = lastAssistant(event.messages);
			if (event.type === "tool_execution_start" && event.toolName === GOAL_SUBMIT_EVALUATION_TOOL) {
				submitFailureBaselines.set(event.toolCallId, toolset.formatGuard.formatFailures);
				return;
			}
			if (event.type === "tool_execution_end" && event.toolName === GOAL_SUBMIT_EVALUATION_TOOL) {
				const failuresBeforeCall = submitFailureBaselines.get(event.toolCallId) ?? toolset.formatGuard.formatFailures;
				submitFailureBaselines.delete(event.toolCallId);
				if (toolset.acceptedReport !== undefined) {
					queueMicrotask(abortEvaluator);
					return;
				}
				if (event.isError) {
					if (toolset.formatGuard.formatFailures === failuresBeforeCall) {
						toolset.formatGuard.recordFormatFailure();
					}
					if (toolset.formatGuard.formatFailures >= 2) {
						formatExhausted = true;
						queueMicrotask(abortEvaluator);
					}
				}
				return;
			}
		});

		const runAttempt = async (prompt: string): Promise<void> => {
			finalAssistant = undefined;
			try {
				await evaluatorSession?.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
			} catch (error) {
				if (input.signal.aborted) input.signal.throwIfAborted();
				throw new GoalEvaluatorInfrastructureError("The evaluator session failed to run.", { cause: error });
			}
			if (toolset.acceptedReport !== undefined) return;
			input.signal.throwIfAborted();
			const assistant = getFinalAssistant();
			const providerFailure = infrastructureMessage(assistant);
			if (providerFailure !== undefined) throw new GoalEvaluatorInfrastructureError(providerFailure);
			if (assistant?.stopReason === "aborted") {
				if (formatExhausted) throw new GoalEvaluatorFormatError("The evaluator exhausted its format correction.");
				throw new GoalEvaluatorInfrastructureError("The evaluator stopped before submitting a report.");
			}
			formatExhausted = toolset.formatGuard.recordFormatFailure() === "exhausted";
		};

		await runAttempt(EVALUATOR_PROMPT);
		if (toolset.acceptedReport !== undefined) return requireAcceptedReport(toolset.acceptedReport);
		if (formatExhausted || toolset.formatGuard.formatFailures > 1) {
			throw new GoalEvaluatorFormatError("The evaluator did not submit a valid report.");
		}

		await runAttempt(GOAL_EVALUATOR_CORRECTION_PROMPT);
		if (toolset.acceptedReport !== undefined) return requireAcceptedReport(toolset.acceptedReport);
		throw new GoalEvaluatorFormatError("The evaluator did not submit a valid report after one correction.");
	} finally {
		input.signal.removeEventListener("abort", abortEvaluator);
		unsubscribe?.();
		evaluatorSession?.dispose();
		await snapshot.cleanup();
	}
}
