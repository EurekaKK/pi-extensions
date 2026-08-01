import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	SessionEntry,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import {
	GOAL_CONTROL_MESSAGE_TYPE,
	GOAL_ERROR_MESSAGE_TYPE,
	GOAL_EVALUATION_ENTRY_TYPE,
	GOAL_EVALUATION_MESSAGE_TYPE,
	GOAL_LIFECYCLE_ENTRY_TYPE,
	GOAL_STATUS_KEY,
} from "./constants.js";
import {
	canCreateGoalAfter,
	createGoalCreatedEvent,
	createGoalEvaluationEntry,
	createGoalLifecycleEvent,
	type GoalEvaluationEntryV1,
	type GoalEvaluationReportV1,
	type GoalMainRunCause,
	type GoalPhase,
	type GoalStateStatus,
	isGoalActiveStatus,
	type RestoredGoalStateV1,
	restoreGoalSessionState,
} from "./domain.js";
import { sanitizeGoalError } from "./errors.js";
import { type RunGoalEvaluationInput, runGoalEvaluation } from "./evaluator.js";
import {
	buildActiveGoalContract,
	buildGoalContinuationKickoffMessage,
	buildGoalEvaluationKickoffMessage,
	buildGoalEvaluationMessage,
} from "./prompts.js";
import { cleanupStaleGoalSnapshots, createGoalMainRunSnapshot, type GoalMainRunSnapshotBundle } from "./snapshots.js";
import { renderGoalStatusLine } from "./ui.js";

const INVALID_PHASE_INPUT = "Goal is paused/error. Use /goal resume or /goal cancel.";

export interface GoalEvaluationMessageDetailsV1 {
	readonly schemaVersion: 1;
	readonly ownerSessionId: string;
	readonly goalId: string;
	readonly evaluationId: string;
	readonly evaluationNumber: number;
	readonly report: GoalEvaluationReportV1;
}

export interface GoalErrorEntryV1 {
	readonly schemaVersion: 1;
	readonly ownerSessionId: string;
	readonly goalId: string;
	readonly phase: GoalPhase;
	readonly message: string;
	readonly timestamp: number;
}

export interface GoalCoordinatorDependencies {
	readonly wallNow?: () => number;
	readonly monotonicNow?: () => number;
	readonly createMainRunSnapshot?: typeof createGoalMainRunSnapshot;
	readonly runEvaluation?: (input: RunGoalEvaluationInput) => Promise<GoalEvaluationReportV1>;
	readonly cleanupStaleSnapshots?: typeof cleanupStaleGoalSnapshots;
}

interface PreparedMainRun {
	readonly ownerSessionId: string;
	readonly goalId: string;
	readonly goalText: string;
	readonly mainRunId: string;
	readonly cause: GoalMainRunCause;
	readonly snapshot: GoalMainRunSnapshotBundle | null;
	readonly creationContextPath: string;
	readonly started: boolean;
}

interface MainSnapshotIdentity {
	readonly ownerSessionId: string;
	readonly goalId: string;
	readonly goalText: string;
	readonly creationAnchorEntryId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLastAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (isRecord(message) && message.role === "assistant") return message as unknown as AssistantMessage;
	}
	return undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.message === "This operation was aborted");
}

function isEvaluationProjection(entry: SessionEntry, evaluationId: string): boolean {
	if (
		entry.type !== "custom_message" ||
		entry.customType !== GOAL_EVALUATION_MESSAGE_TYPE ||
		!isRecord(entry.details)
	) {
		return false;
	}
	return entry.details.evaluationId === evaluationId;
}

export function parseGoalErrorEntry(value: unknown): GoalErrorEntryV1 | null {
	if (!isRecord(value)) return null;
	const keys = Object.keys(value).sort();
	const expected = ["goalId", "message", "ownerSessionId", "phase", "schemaVersion", "timestamp"].sort();
	if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return null;
	if (
		value.schemaVersion !== 1 ||
		typeof value.ownerSessionId !== "string" ||
		value.ownerSessionId.length === 0 ||
		typeof value.goalId !== "string" ||
		value.goalId.length === 0 ||
		(value.phase !== "main" && value.phase !== "evaluation") ||
		typeof value.message !== "string" ||
		typeof value.timestamp !== "number" ||
		!Number.isFinite(value.timestamp)
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		ownerSessionId: value.ownerSessionId,
		goalId: value.goalId,
		phase: value.phase,
		message: value.message,
		timestamp: value.timestamp,
	};
}

export class GoalCoordinator {
	readonly #pi: ExtensionAPI;
	readonly #wallNow: () => number;
	readonly #monotonicNow: () => number;
	readonly #createMainRunSnapshot: typeof createGoalMainRunSnapshot;
	readonly #runEvaluation: (input: RunGoalEvaluationInput) => Promise<GoalEvaluationReportV1>;
	readonly #cleanupStaleSnapshots: typeof cleanupStaleGoalSnapshots;

	#state: RestoredGoalStateV1 | null = null;
	#generation = 0;
	#segmentStartedAt: number | null = null;
	#statusTimer: NodeJS.Timeout | null = null;
	#terminalInputCleanup: (() => void) | null = null;
	#preparedMain: PreparedMainRun | null = null;
	#preparationController: AbortController | null = null;
	#evaluatorController: AbortController | null = null;
	#lastAssistant: AssistantMessage | undefined;
	#pauseRequested = false;
	#cancelPending = false;
	#shutdown = false;
	#corruptionWarningShown = false;
	#staleCleanupSessionId: string | null = null;
	#staleCleanupPromise: Promise<void> | null = null;

	constructor(pi: ExtensionAPI, dependencies: GoalCoordinatorDependencies = {}) {
		this.#pi = pi;
		this.#wallNow = dependencies.wallNow ?? Date.now;
		this.#monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
		this.#createMainRunSnapshot = dependencies.createMainRunSnapshot ?? createGoalMainRunSnapshot;
		this.#runEvaluation = dependencies.runEvaluation ?? runGoalEvaluation;
		this.#cleanupStaleSnapshots = dependencies.cleanupStaleSnapshots ?? cleanupStaleGoalSnapshots;
	}

	get state(): RestoredGoalStateV1 | null {
		return this.#state;
	}

	async create(context: ExtensionContext): Promise<void> {
		if (context.mode !== "tui") {
			this.#notify(context, "Goal commands are only supported in TUI mode.", "error");
			return;
		}
		if (!context.isIdle()) {
			this.#notify(context, "Pi must be idle before creating a goal.", "error");
			return;
		}
		if (!canCreateGoalAfter(this.#state?.status ?? null)) {
			this.#notify(context, "A goal already exists. Use /goal resume or /goal cancel.", "error");
			return;
		}

		const goalText = await context.ui.editor("Create goal");
		if (goalText === undefined) return;
		if (goalText.trim().length === 0) {
			this.#notify(context, "Goal text cannot be empty.", "error");
			return;
		}
		if (!context.isIdle() || !canCreateGoalAfter(this.#state?.status ?? null)) {
			this.#notify(context, "Pi became busy or another goal was created before submission.", "error");
			return;
		}

		const generation = this.#invalidateBackgroundWork();
		const ownerSessionId = context.sessionManager.getSessionId();
		const goalId = randomUUID();
		const creationAnchorEntryId = context.sessionManager.getLeafId();
		try {
			await this.#preflightMain(context);
			const prepared = await this.#prepareMainRun(
				context,
				{ ownerSessionId, goalId, goalText, creationAnchorEntryId },
				"creation",
				generation,
			);
			if (prepared === null || generation !== this.#generation || !context.isIdle()) {
				await prepared?.snapshot?.cleanup();
				return;
			}

			const now = this.#wallNow();
			const event = createGoalCreatedEvent({
				ownerSessionId,
				goalId,
				sequence: 1,
				timestamp: now,
				activeElapsedMs: 0,
				goalText,
				creationAnchorEntryId,
				createdAt: now,
			});
			this.#preparedMain = prepared;
			this.#pi.appendEntry(GOAL_LIFECYCLE_ENTRY_TYPE, event);
			this.#restoreFromSession(context);
			this.#pauseRequested = false;
			this.#pi.sendUserMessage(goalText);
		} catch (error) {
			await this.#discardPreparedMain(context);
			if (this.#state?.status === "running" && this.#state.goalId === goalId) {
				this.#enterError(context, "main", error);
			} else {
				this.#notify(context, `Goal could not be created: ${sanitizeGoalError(error)}`, "error");
			}
		}
	}

	async resume(context: ExtensionContext): Promise<void> {
		const goal = this.#state;
		if (context.mode !== "tui") {
			this.#notify(context, "Goal commands are only supported in TUI mode.", "error");
			return;
		}
		if (goal === null || (goal.status !== "paused" && goal.status !== "error") || goal.resumePhase === null) {
			this.#notify(context, "No paused or errored goal can be resumed.", "error");
			return;
		}
		if (!context.isIdle()) {
			this.#notify(context, "Pi must be idle before resuming a goal.", "error");
			return;
		}

		const phase = goal.resumePhase;
		const generation = this.#invalidateBackgroundWork();
		if (phase === "main") {
			try {
				await this.#preflightMain(context);
				const prepared = await this.#prepareMainRun(context, goal, "resume", generation);
				if (prepared === null || generation !== this.#generation) {
					await prepared?.snapshot?.cleanup();
					return;
				}
				this.#preparedMain = prepared;
				this.#appendLifecycle(context, { kind: "resumed", resumePhase: "main" });
				this.#sendContinuation(prepared);
			} catch (error) {
				await this.#discardPreparedMain(context);
				if (this.#state?.status === "running") this.#enterError(context, "main", error);
				else this.#notify(context, `Goal could not resume: ${sanitizeGoalError(error)}`, "error");
			}
			return;
		}

		try {
			this.#appendLifecycle(context, { kind: "resumed", resumePhase: "evaluation" });
			this.#startEvaluation(context);
		} catch (error) {
			this.#notify(context, `Goal could not resume: ${sanitizeGoalError(error)}`, "error");
		}
	}

	async cancel(context: ExtensionContext): Promise<void> {
		const goal = this.#state;
		if (context.mode !== "tui") {
			this.#notify(context, "Goal commands are only supported in TUI mode.", "error");
			return;
		}
		if (goal === null || goal.status === "completed" || goal.status === "cancelled" || goal.status === "dismissed") {
			this.#notify(context, "No current goal can be cancelled.", "error");
			return;
		}
		this.#invalidateBackgroundWork();

		const wasRunning = goal.status === "running";
		this.#cancelPending = wasRunning && (this.#preparedMain?.started === true || !context.isIdle());
		try {
			this.#appendLifecycle(context, goal.status === "failed" ? { kind: "dismissed" } : { kind: "cancelled" });
		} catch (error) {
			if (goal.status === "running" || goal.status === "evaluating") {
				this.#enterError(context, goal.status === "running" ? "main" : "evaluation", error);
			} else {
				this.#notify(context, `Goal could not be cancelled: ${sanitizeGoalError(error)}`, "error");
			}
		}
		if (wasRunning) context.abort();
		await this.#discardPreparedMain(context);
	}

	async handleSessionStart(context: ExtensionContext): Promise<void> {
		this.#shutdown = false;
		this.#cancelPending = false;
		this.#corruptionWarningShown = false;
		const ownerSessionId = context.sessionManager.getSessionId();
		const duplicatePendingKickoff =
			context.mode === "tui" &&
			this.#state?.ownerSessionId === ownerSessionId &&
			this.#state.status === "running" &&
			this.#preparedMain?.ownerSessionId === ownerSessionId &&
			this.#preparedMain.goalId === this.#state.goalId &&
			!this.#preparedMain.started;
		const duplicateActiveEvaluation =
			context.mode === "tui" &&
			this.#state?.ownerSessionId === ownerSessionId &&
			this.#state.status === "evaluating" &&
			this.#evaluatorController !== null &&
			!this.#evaluatorController.signal.aborted;
		if (duplicatePendingKickoff || duplicateActiveEvaluation) {
			this.#projectUi(context);
			return;
		}
		const generation = this.#invalidateBackgroundWork();
		this.#restoreFromSession(context, false);
		if (context.mode !== "tui") return;
		if (this.#state?.status === "evaluating" && !this.#checkpointEvaluationStart(context, false)) return;
		await this.#cleanupStaleSnapshotsOnce(ownerSessionId);
		if (generation !== this.#generation || this.#shutdown) return;

		const goal = this.#state;
		if (goal === null) return;
		try {
			await this.#ensureTerminalProjection(context, goal);
		} catch (error) {
			this.#notify(context, `Goal evaluation display failed: ${sanitizeGoalError(error)}`, "error");
		}
		if (generation !== this.#generation || this.#shutdown) return;
		if (goal.status === "evaluating") {
			this.#startEvaluation(context, generation);
			return;
		}
		if (goal.status !== "running") return;

		if (goal.mainRunInProgress) {
			try {
				if (await this.#recoverInterruptedMain(context, goal)) return;
			} catch (error) {
				this.#enterError(context, "main", error);
				return;
			}
		}
		if (generation !== this.#generation || this.#shutdown) return;
		try {
			await this.#preflightMain(context);
			const prepared = await this.#prepareMainRun(context, goal, "startup-resume", generation);
			if (prepared === null || generation !== this.#generation) {
				await prepared?.snapshot?.cleanup();
				return;
			}
			this.#preparedMain = prepared;
			const latestEvaluation = goal.evaluationHistory.at(-1);
			if (latestEvaluation !== undefined && !this.#hasEvaluationProjection(context, latestEvaluation.evaluationId)) {
				this.#sendEvaluationProjection(prepared, latestEvaluation, true);
			} else {
				this.#sendContinuation(prepared);
			}
		} catch (error) {
			if (generation !== this.#generation || isAbortError(error)) return;
			this.#enterError(context, "main", error);
		}
	}

	handleSessionTree(context: ExtensionContext): void {
		const previousGoalId = this.#state?.goalId;
		const previousStatus = this.#state?.status;
		const previousSegmentStartedAt = this.#segmentStartedAt;
		this.#restoreFromSession(context, false);
		if (context.mode === "tui" && this.#state !== null && isGoalActiveStatus(this.#state.status)) {
			this.#segmentStartedAt =
				this.#state.goalId === previousGoalId &&
				previousStatus !== undefined &&
				isGoalActiveStatus(previousStatus) &&
				previousSegmentStartedAt !== null
					? previousSegmentStartedAt
					: this.#monotonicNow();
			this.#projectUi(context);
		}
	}

	async handleSessionShutdown(context: ExtensionContext): Promise<void> {
		if (this.#shutdown) {
			await this.#discardPreparedMain(context);
			this.#clearUi(context);
			return;
		}
		this.#shutdown = true;
		this.#invalidateBackgroundWork();
		const goal = this.#state;
		if (goal !== null && isGoalActiveStatus(goal.status)) {
			try {
				this.#appendLifecycle(context, {
					kind: "shutdown-checkpoint",
					phase: goal.status === "running" ? "main" : "evaluation",
				});
			} catch {
				// Pi is already tearing down; best effort is the only available path.
			}
		}
		this.#segmentStartedAt = null;
		this.#evaluatorController?.abort();
		await this.#discardPreparedMain(context);
		this.#clearUi(context);
	}

	guardNavigation(context: ExtensionContext): { readonly cancel?: boolean } | undefined {
		if (this.#state !== null && isGoalActiveStatus(this.#state.status)) {
			this.#notify(context, "Press Escape to pause the active goal before changing session history.", "warning");
			return { cancel: true };
		}
		return undefined;
	}

	handleBeforeAgentStart(
		event: BeforeAgentStartEvent,
		context: ExtensionContext,
	): BeforeAgentStartEventResult | undefined {
		const goal = this.#state;
		if (goal?.status !== "running") return undefined;
		let prepared = this.#preparedMain;
		if (prepared === null || prepared.goalId !== goal.goalId) {
			prepared = {
				ownerSessionId: goal.ownerSessionId,
				goalId: goal.goalId,
				goalText: goal.goalText,
				mainRunId: randomUUID(),
				cause: "user-steering",
				snapshot: null,
				creationContextPath: "unavailable",
				started: false,
			};
			this.#preparedMain = prepared;
			this.#notify(
				context,
				"Goal context snapshot was unavailable; the immutable goal contract is still active.",
				"warning",
			);
		}
		const contract = buildActiveGoalContract({
			goalId: goal.goalId,
			goalText: goal.goalText,
			creationContextSnapshotPath: prepared.creationContextPath,
		});
		return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
	}

	handleAgentStart(context: ExtensionContext): void {
		if (this.#cancelPending) {
			context.abort();
			return;
		}
		const goal = this.#state;
		const prepared = this.#preparedMain;
		if (goal?.status !== "running" || prepared === null || prepared.goalId !== goal.goalId || prepared.started) return;
		try {
			this.#appendLifecycle(context, {
				kind: "main-started",
				mainRunId: prepared.mainRunId,
				cause: prepared.cause,
			});
			this.#preparedMain = { ...prepared, started: true };
			this.#lastAssistant = undefined;
			this.#pauseRequested = false;
		} catch (error) {
			this.#enterError(context, "main", error);
			context.abort();
		}
	}

	handleAgentEnd(event: AgentEndEvent): void {
		if (this.#preparedMain?.started !== true) return;
		this.#lastAssistant = findLastAssistant(event.messages);
	}

	async handleAgentSettled(context: ExtensionContext): Promise<void> {
		if (this.#cancelPending) {
			this.#cancelPending = false;
			await this.#discardPreparedMain(context);
			return;
		}
		if (this.#shutdown) return;
		const goal = this.#state;
		const prepared = this.#preparedMain;
		if (goal?.status !== "running" || prepared?.started !== true || goal.lastMainRunId !== prepared.mainRunId) return;

		const assistant = this.#lastAssistant;
		if (assistant === undefined) {
			this.#enterError(context, "main", "The main run settled without a final assistant message.");
			await this.#discardPreparedMain(context);
			return;
		}
		if (this.#pauseRequested || assistant?.stopReason === "aborted") {
			try {
				this.#appendLifecycle(context, { kind: "paused", interruptedPhase: "main" });
			} catch (error) {
				this.#enterError(context, "main", error);
			}
			await this.#discardPreparedMain(context);
			return;
		}
		if (assistant?.stopReason === "error") {
			this.#enterError(context, "main", assistant.errorMessage ?? "The main model failed after Pi retries.");
			await this.#discardPreparedMain(context);
			return;
		}

		try {
			this.#appendLifecycle(context, { kind: "main-settled", mainRunId: prepared.mainRunId });
		} catch (error) {
			this.#enterError(context, "main", error);
			await this.#discardPreparedMain(context);
			return;
		}
		void this.#discardPreparedMain(context, "evaluation");
		this.#startEvaluation(context);
	}

	async handleInput(_event: InputEvent, context: ExtensionContext): Promise<InputEventResult | undefined> {
		const goal = this.#state;
		if (goal === null) return undefined;
		if (goal.status === "paused" || goal.status === "error") {
			this.#notify(context, INVALID_PHASE_INPUT, "warning");
			return { action: "handled" };
		}
		if (goal.status === "running") {
			if (context.mode !== "tui" || !context.isIdle() || this.#preparedMain !== null) {
				return { action: "continue" };
			}
			const generation = this.#invalidateBackgroundWork();
			try {
				await this.#preflightMain(context);
				const prepared = await this.#prepareMainRun(context, goal, "user-steering", generation);
				if (prepared === null || generation !== this.#generation) {
					await prepared?.snapshot?.cleanup();
					return { action: "handled" };
				}
				this.#preparedMain = prepared;
				return { action: "continue" };
			} catch (error) {
				if (generation !== this.#generation || isAbortError(error)) return { action: "handled" };
				this.#enterError(context, "main", error);
				return { action: "handled" };
			}
		}
		if (goal.status !== "evaluating") return { action: "continue" };
		const pending = goal.pendingEvaluation;
		if (pending?.evaluationAttemptId === null || pending === null) {
			this.#notify(context, "Goal evaluation is starting; retry the message after it becomes responsive.", "warning");
			return { action: "handled" };
		}

		const generation = this.#invalidateBackgroundWork();
		this.#evaluatorController?.abort();
		try {
			await this.#preflightMain(context);
			const prepared = await this.#prepareMainRun(context, goal, "user-steering", generation);
			if (prepared === null || generation !== this.#generation) {
				await prepared?.snapshot?.cleanup();
				return { action: "handled" };
			}
			this.#preparedMain = prepared;
			this.#appendLifecycle(context, {
				kind: "evaluation-invalidated",
				evaluationAttemptId: pending.evaluationAttemptId,
			});
			return { action: "continue" };
		} catch (error) {
			if (generation !== this.#generation || isAbortError(error)) return { action: "handled" };
			this.#enterError(context, "evaluation", error);
			return { action: "handled" };
		}
	}

	handleToolCall(): ToolCallEventResult | undefined {
		if (!this.#cancelPending) return undefined;
		return { block: true, reason: "The active goal was cancelled." };
	}

	#currentElapsed(): number {
		const base = this.#state?.activeElapsedMs ?? 0;
		if (this.#segmentStartedAt === null) return base;
		return base + Math.max(0, this.#monotonicNow() - this.#segmentStartedAt);
	}

	#nextEventBase(): {
		readonly ownerSessionId: string;
		readonly goalId: string;
		readonly sequence: number;
		readonly timestamp: number;
		readonly activeElapsedMs: number;
	} {
		const goal = this.#state;
		if (goal === null) throw new Error("No current goal exists.");
		return {
			ownerSessionId: goal.ownerSessionId,
			goalId: goal.goalId,
			sequence: goal.lastSequence + 1,
			timestamp: this.#wallNow(),
			activeElapsedMs: this.#currentElapsed(),
		};
	}

	#appendLifecycle(
		context: ExtensionContext,
		event:
			| { readonly kind: "main-started"; readonly mainRunId: string; readonly cause: GoalMainRunCause }
			| { readonly kind: "main-settled"; readonly mainRunId: string }
			| {
					readonly kind: "evaluation-started";
					readonly evaluationNumber: number;
					readonly evaluationAttemptId: string;
					readonly precedingMainRunId: string;
					readonly model: { readonly provider: string; readonly id: string };
					readonly thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
			  }
			| { readonly kind: "evaluation-invalidated"; readonly evaluationAttemptId: string }
			| { readonly kind: "paused"; readonly interruptedPhase: GoalPhase }
			| { readonly kind: "error"; readonly failedPhase: GoalPhase }
			| { readonly kind: "resumed"; readonly resumePhase: GoalPhase }
			| { readonly kind: "shutdown-checkpoint"; readonly phase: GoalPhase }
			| { readonly kind: "cancelled" }
			| { readonly kind: "dismissed" },
		startActiveSegment = true,
	): void {
		const lifecycle = createGoalLifecycleEvent({ ...this.#nextEventBase(), ...event });
		this.#pi.appendEntry(GOAL_LIFECYCLE_ENTRY_TYPE, lifecycle);
		this.#restoreFromSession(context, startActiveSegment);
	}

	#appendEvaluation(context: ExtensionContext, report: GoalEvaluationReportV1): GoalEvaluationEntryV1 {
		const goal = this.#state;
		const pending = goal?.pendingEvaluation;
		if (
			goal?.status !== "evaluating" ||
			pending === null ||
			pending === undefined ||
			pending.evaluationAttemptId === null
		) {
			throw new Error("No active evaluation can be committed.");
		}
		const evaluation = createGoalEvaluationEntry({
			...this.#nextEventBase(),
			evaluationId: randomUUID(),
			evaluationNumber: pending.evaluationNumber,
			evaluationAttemptId: pending.evaluationAttemptId,
			precedingMainRunId: pending.precedingMainRunId,
			report,
		});
		this.#pi.appendEntry(GOAL_EVALUATION_ENTRY_TYPE, evaluation);
		this.#restoreFromSession(context);
		return evaluation;
	}

	#restoreFromSession(context: ExtensionContext, startActiveSegment = true): void {
		const restored = restoreGoalSessionState(
			context.sessionManager.getEntries(),
			context.sessionManager.getSessionId(),
		);
		this.#state = restored.goal;
		this.#segmentStartedAt =
			startActiveSegment && context.mode === "tui" && this.#state !== null && isGoalActiveStatus(this.#state.status)
				? this.#monotonicNow()
				: null;
		if (restored.foundCorruptEntry && !this.#corruptionWarningShown) {
			this.#corruptionWarningShown = true;
			this.#notify(context, "Goal skipped invalid session state and restored the latest valid state.", "warning");
		}
		this.#projectUi(context);
	}

	#projectUi(context: ExtensionContext): void {
		this.#stopStatusTimer();
		this.#terminalInputCleanup?.();
		this.#terminalInputCleanup = null;
		if (context.mode !== "tui") return;

		this.#renderStatus(context);
		const status = this.#state?.status;
		if (status === "running" || status === "evaluating") {
			this.#statusTimer = setInterval(() => this.#renderStatus(context), 1_000);
			this.#statusTimer.unref();
		}
		if (status === "running") {
			this.#terminalInputCleanup = context.ui.onTerminalInput((data) => {
				if (isKeyRelease(data) || !matchesKey(data, Key.escape)) return undefined;
				this.#pauseRequested = true;
				if (context.isIdle() && this.#preparedMain?.started !== true) {
					this.#invalidateBackgroundWork();
					try {
						this.#appendLifecycle(context, { kind: "paused", interruptedPhase: "main" });
					} catch (error) {
						this.#enterError(context, "main", error);
					}
					void this.#discardPreparedMain(context);
				}
				return undefined;
			});
		}
		if (status === "evaluating") {
			this.#terminalInputCleanup = context.ui.onTerminalInput((data) => {
				if (isKeyRelease(data) || !matchesKey(data, Key.escape)) return undefined;
				this.#invalidateBackgroundWork();
				this.#evaluatorController?.abort();
				try {
					this.#appendLifecycle(context, { kind: "paused", interruptedPhase: "evaluation" });
				} catch (error) {
					this.#enterError(context, "evaluation", error);
				}
				return { consume: true };
			});
		}
	}

	#renderStatus(context: ExtensionContext): void {
		const goal = this.#state;
		if (goal === null || goal.status === "completed" || goal.status === "cancelled" || goal.status === "dismissed") {
			context.ui.setStatus(GOAL_STATUS_KEY, undefined);
			return;
		}
		context.ui.setStatus(
			GOAL_STATUS_KEY,
			renderGoalStatusLine({
				status: goal.status,
				activeElapsedMs: this.#currentElapsed(),
				goalSummary: goal.goalSummary,
			}),
		);
	}

	#clearUi(context: ExtensionContext): void {
		this.#stopStatusTimer();
		this.#terminalInputCleanup?.();
		this.#terminalInputCleanup = null;
		if (context.mode === "tui") context.ui.setStatus(GOAL_STATUS_KEY, undefined);
	}

	#stopStatusTimer(): void {
		if (this.#statusTimer !== null) clearInterval(this.#statusTimer);
		this.#statusTimer = null;
	}

	#invalidateBackgroundWork(): number {
		this.#generation += 1;
		this.#preparationController?.abort();
		this.#preparationController = null;
		this.#evaluatorController?.abort();
		return this.#generation;
	}

	async #preflightMain(context: ExtensionContext): Promise<void> {
		if (context.model === undefined) throw new Error("No active model is selected.");
		const auth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
		if (!auth.ok) throw new Error(auth.error);
	}

	async #prepareMainRun(
		context: ExtensionContext,
		identity: MainSnapshotIdentity,
		cause: GoalMainRunCause,
		generation: number,
	): Promise<PreparedMainRun | null> {
		const controller = new AbortController();
		this.#preparationController = controller;
		let snapshot: GoalMainRunSnapshotBundle;
		try {
			snapshot = await this.#createMainRunSnapshot({
				ownerSessionId: identity.ownerSessionId,
				entries: context.sessionManager.getEntries(),
				creationAnchorEntryId: identity.creationAnchorEntryId,
				signal: controller.signal,
			});
		} finally {
			if (this.#preparationController === controller) this.#preparationController = null;
		}
		if (generation !== this.#generation || controller.signal.aborted) {
			await snapshot.cleanup();
			return null;
		}
		return {
			ownerSessionId: identity.ownerSessionId,
			goalId: identity.goalId,
			goalText: identity.goalText,
			mainRunId: randomUUID(),
			cause,
			snapshot,
			creationContextPath: snapshot.files.creationContext,
			started: false,
		};
	}

	async #discardPreparedMain(context?: ExtensionContext, cleanupFailurePhase?: GoalPhase): Promise<void> {
		const prepared = this.#preparedMain;
		this.#preparedMain = null;
		this.#lastAssistant = undefined;
		this.#pauseRequested = false;
		if (prepared?.snapshot === null || prepared?.snapshot === undefined) return;
		try {
			await prepared.snapshot.cleanup();
		} catch (error) {
			if (context === undefined) return;
			if (cleanupFailurePhase !== undefined) this.#enterError(context, cleanupFailurePhase, error);
			else this.#notify(context, `Goal snapshot cleanup failed: ${sanitizeGoalError(error)}`, "error");
		}
	}

	async #cleanupStaleSnapshotsOnce(ownerSessionId: string): Promise<void> {
		if (this.#staleCleanupSessionId !== ownerSessionId || this.#staleCleanupPromise === null) {
			this.#staleCleanupSessionId = ownerSessionId;
			this.#staleCleanupPromise = this.#cleanupStaleSnapshots(ownerSessionId)
				.then(() => undefined)
				.catch(() => undefined);
		}
		await this.#staleCleanupPromise;
	}

	#checkpointEvaluationStart(context: ExtensionContext, startActiveSegment: boolean): boolean {
		const goal = this.#state;
		if (goal?.status !== "evaluating" || goal.pendingEvaluation === null) return false;
		if (goal.pendingEvaluation.evaluationAttemptId !== null) return true;
		if (context.model === undefined) {
			this.#enterError(context, "evaluation", "No active model is selected.");
			return false;
		}
		try {
			this.#appendLifecycle(
				context,
				{
					kind: "evaluation-started",
					evaluationNumber: goal.pendingEvaluation.evaluationNumber,
					evaluationAttemptId: randomUUID(),
					precedingMainRunId: goal.pendingEvaluation.precedingMainRunId,
					model: { provider: context.model.provider, id: context.model.id },
					thinkingLevel: context.thinkingLevel ?? this.#pi.getThinkingLevel(),
				},
				startActiveSegment,
			);
			return true;
		} catch (error) {
			this.#enterError(context, "evaluation", error);
			return false;
		}
	}

	#startEvaluation(context: ExtensionContext, expectedGeneration = this.#generation): void {
		if (expectedGeneration !== this.#generation || this.#shutdown) return;
		if (!this.#checkpointEvaluationStart(context, true)) return;
		const goal = this.#state;
		if (
			goal?.status !== "evaluating" ||
			goal.pendingEvaluation === null ||
			goal.pendingEvaluation.evaluationAttemptId === null
		) {
			return;
		}
		if (this.#segmentStartedAt === null && context.mode === "tui") {
			this.#segmentStartedAt = this.#monotonicNow();
			this.#renderStatus(context);
		}

		const controller = new AbortController();
		this.#evaluatorController = controller;
		const generation = expectedGeneration;
		const evaluationNumber = goal.pendingEvaluation.evaluationNumber;
		void this.#runEvaluation({
			pi: this.#pi,
			context,
			goal,
			evaluationNumber,
			activeElapsedMs: this.#currentElapsed(),
			signal: controller.signal,
		})
			.then((report) => this.#acceptEvaluation(context, goal, report, generation))
			.catch((error: unknown) => {
				if (generation !== this.#generation || controller.signal.aborted || isAbortError(error)) return;
				this.#enterError(context, "evaluation", error);
			})
			.finally(() => {
				if (this.#evaluatorController === controller) this.#evaluatorController = null;
			});
	}

	async #acceptEvaluation(
		context: ExtensionContext,
		startedGoal: RestoredGoalStateV1,
		report: GoalEvaluationReportV1,
		generation: number,
	): Promise<void> {
		if (
			generation !== this.#generation ||
			this.#state?.goalId !== startedGoal.goalId ||
			this.#state.status !== "evaluating"
		) {
			return;
		}

		let prepared: PreparedMainRun | null = null;
		if (report.decision === "continue") {
			try {
				await this.#preflightMain(context);
				prepared = await this.#prepareMainRun(context, this.#state, "evaluation-continue", generation);
				if (prepared === null || generation !== this.#generation) {
					await prepared?.snapshot?.cleanup();
					return;
				}
				this.#preparedMain = prepared;
			} catch (error) {
				if (generation !== this.#generation || isAbortError(error)) return;
				this.#enterError(context, "evaluation", error);
				return;
			}
		}

		let evaluation: GoalEvaluationEntryV1;
		try {
			evaluation = this.#appendEvaluation(context, report);
		} catch (error) {
			this.#enterError(context, "evaluation", error);
			return;
		}
		try {
			if (report.decision === "continue" && prepared !== null) {
				this.#sendEvaluationProjection(prepared, evaluation, true);
				return;
			}
			this.#sendEvaluationProjection(null, evaluation, false);
		} catch (error) {
			if (report.decision === "continue") this.#enterError(context, "main", error);
			else this.#notify(context, `Goal evaluation display failed: ${sanitizeGoalError(error)}`, "error");
		}
	}

	#sendContinuation(prepared: PreparedMainRun): void {
		this.#pi.sendMessage(
			{
				customType: GOAL_CONTROL_MESSAGE_TYPE,
				content: buildGoalContinuationKickoffMessage({
					goalId: prepared.goalId,
					goalText: prepared.goalText,
					creationContextSnapshotPath: prepared.creationContextPath,
				}),
				display: false,
				details: { schemaVersion: 1, goalId: prepared.goalId, mainRunId: prepared.mainRunId },
			},
			{ triggerTurn: true },
		);
	}

	#sendEvaluationProjection(
		prepared: PreparedMainRun | null,
		evaluation: GoalEvaluationEntryV1,
		triggerTurn: boolean,
	): void {
		const details: GoalEvaluationMessageDetailsV1 = {
			schemaVersion: 1,
			ownerSessionId: evaluation.ownerSessionId,
			goalId: evaluation.goalId,
			evaluationId: evaluation.evaluationId,
			evaluationNumber: evaluation.evaluationNumber,
			report: evaluation.report,
		};
		const content =
			triggerTurn && prepared !== null
				? buildGoalEvaluationKickoffMessage({
						goalId: prepared.goalId,
						goalText: prepared.goalText,
						creationContextSnapshotPath: prepared.creationContextPath,
						evaluationNumber: evaluation.evaluationNumber,
						report: evaluation.report,
					})
				: buildGoalEvaluationMessage({
						evaluationNumber: evaluation.evaluationNumber,
						report: evaluation.report,
					});
		this.#pi.sendMessage(
			{ customType: GOAL_EVALUATION_MESSAGE_TYPE, content, display: true, details },
			triggerTurn ? { triggerTurn: true } : undefined,
		);
	}

	#hasEvaluationProjection(context: ExtensionContext, evaluationId: string): boolean {
		return context.sessionManager.getEntries().some((entry) => isEvaluationProjection(entry, evaluationId));
	}

	async #ensureTerminalProjection(context: ExtensionContext, goal: RestoredGoalStateV1): Promise<void> {
		const evaluation = goal.evaluationHistory.at(-1);
		if (
			evaluation === undefined ||
			evaluation.report.decision === "continue" ||
			this.#hasEvaluationProjection(context, evaluation.evaluationId)
		) {
			return;
		}
		this.#sendEvaluationProjection(null, evaluation, false);
	}

	#enterError(context: ExtensionContext, phase: GoalPhase, error: unknown): void {
		const goal = this.#state;
		const expected: GoalStateStatus = phase === "main" ? "running" : "evaluating";
		if (goal === null || goal.status !== expected) {
			this.#notify(context, sanitizeGoalError(error), "error");
			return;
		}
		this.#invalidateBackgroundWork();
		void this.#discardPreparedMain(context);
		const message = sanitizeGoalError(error);
		try {
			this.#appendLifecycle(context, { kind: "error", failedPhase: phase });
		} catch {
			this.#state = Object.freeze({
				...goal,
				status: "error",
				resumePhase: phase,
				activeElapsedMs: this.#currentElapsed(),
				mainRunInProgress: false,
				pendingEvaluation:
					phase === "evaluation" && goal.pendingEvaluation !== null
						? Object.freeze({
								...goal.pendingEvaluation,
								evaluationAttemptId: null,
								model: null,
								thinkingLevel: null,
							})
						: goal.pendingEvaluation,
			});
			this.#segmentStartedAt = null;
			this.#projectUi(context);
			this.#notify(context, `Goal entered an in-memory error: ${message}`, "error");
			return;
		}
		const detail: GoalErrorEntryV1 = {
			schemaVersion: 1,
			ownerSessionId: goal.ownerSessionId,
			goalId: goal.goalId,
			phase,
			message,
			timestamp: this.#wallNow(),
		};
		try {
			this.#pi.appendEntry(GOAL_ERROR_MESSAGE_TYPE, detail);
		} catch {
			this.#notify(context, `Goal entered error: ${message}`, "error");
		}
	}

	async #recoverInterruptedMain(context: ExtensionContext, goal: RestoredGoalStateV1): Promise<boolean> {
		const mainRunId = goal.lastMainRunId;
		if (mainRunId === null) return false;
		const entries = context.sessionManager.getEntries();
		const startedIndex = entries.findLastIndex(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === GOAL_LIFECYCLE_ENTRY_TYPE &&
				isRecord(entry.data) &&
				entry.data.kind === "main-started" &&
				entry.data.mainRunId === mainRunId,
		);
		if (startedIndex < 0) return false;
		let assistant: AssistantMessage | undefined;
		for (const entry of entries.slice(startedIndex + 1)) {
			if (entry.type === "message" && entry.message.role === "assistant") assistant = entry.message;
		}
		if (assistant !== undefined && assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
			this.#appendLifecycle(context, { kind: "main-settled", mainRunId });
			this.#startEvaluation(context);
			return true;
		}
		if (assistant?.stopReason === "error") {
			this.#enterError(context, "main", assistant.errorMessage ?? "The interrupted main run failed.");
			return true;
		}
		if (assistant?.stopReason === "aborted") {
			this.#appendLifecycle(context, { kind: "paused", interruptedPhase: "main" });
			return true;
		}
		return false;
	}

	#notify(context: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
		if (!context.hasUI) return;
		try {
			context.ui.notify(message, type);
		} catch {
			// UI projection must not change goal semantics.
		}
	}
}
