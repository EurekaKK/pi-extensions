import { fauxAssistantMessage, fauxProvider, type Model } from "@earendil-works/pi-ai";
import {
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type InputEvent,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOAL_EVALUATION_ENTRY_TYPE, GOAL_LIFECYCLE_ENTRY_TYPE } from "../src/constants.js";
import { GoalCoordinator } from "../src/coordinator.js";
import type { GoalEvaluationReportV1 } from "../src/domain.js";
import type { RunGoalEvaluationInput } from "../src/evaluator.js";
import type { CreateGoalMainRunSnapshotInput, GoalMainRunSnapshotBundle } from "../src/snapshots.js";

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	resolve(value: Value): void;
	reject(error: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
	let resolvePromise!: (value: Value) => void;
	let rejectPromise!: (error: unknown) => void;
	const promise = new Promise<Value>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const CONTINUE_REPORT: GoalEvaluationReportV1 = {
	decision: "continue",
	progress: "The first verified step is complete.",
	reason: "A concrete untried path remains.",
	next_action: "Take the next verified step.",
	evidence: ["test evidence"],
};

const COMPLETE_REPORT: GoalEvaluationReportV1 = {
	decision: "complete",
	progress: "All required work is verified.",
	reason: "The immutable success criteria are satisfied.",
	next_action: null,
	evidence: ["completion evidence"],
};

const FAIL_REPORT: GoalEvaluationReportV1 = {
	decision: "fail",
	progress: "All safe paths were exhausted.",
	reason: "No achievable path remains within the current authority boundary.",
	next_action: null,
	evidence: ["verified barrier"],
};

interface SentMessage {
	readonly message: {
		readonly customType: string;
		readonly content: string | readonly unknown[];
		readonly display: boolean;
		readonly details?: unknown;
	};
	readonly options: { readonly triggerTurn?: boolean } | undefined;
}

class GoalHarness {
	manager = SessionManager.inMemory("/test/project");
	readonly model: Model<string>;
	readonly snapshots: Array<{
		readonly bundle: GoalMainRunSnapshotBundle;
		readonly cleanup: ReturnType<typeof vi.fn>;
	}> = [];
	readonly snapshotInputs: CreateGoalMainRunSnapshotInput[] = [];
	readonly evaluationInputs: RunGoalEvaluationInput[] = [];
	readonly evaluationQueue: Deferred<GoalEvaluationReportV1>[] = [];
	readonly sentMessages: SentMessage[] = [];
	readonly sentUserMessages: string[] = [];
	readonly appended: Array<{ readonly customType: string; readonly data: unknown }> = [];
	readonly notifications: Array<{ readonly message: string; readonly type: string }> = [];
	readonly statusValues: Array<string | undefined> = [];
	readonly terminalHandlers = new Set<(data: string) => unknown>();
	readonly abort = vi.fn();
	readonly cleanupStale = vi.fn(async () => 0);
	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly coordinator: GoalCoordinator;
	editorValue: string | undefined = "ship\nthe result";
	idle = true;
	mode: ExtensionContext["mode"] = "tui";
	wall = 1_000;
	monotonic = 0;
	failNextAppend = false;
	failSend = false;

	constructor() {
		const faux = fauxProvider({ provider: "goal-coordinator-faux", models: [{ id: "main" }] });
		this.model = faux.getModel();
		const harness = this;
		this.api = {
			appendEntry: (customType: string, data?: unknown) => {
				if (this.failNextAppend) {
					this.failNextAppend = false;
					throw new Error("append unavailable");
				}
				this.appended.push({ customType, data });
				this.manager.appendCustomEntry(customType, data);
			},
			sendUserMessage: (content: string | readonly unknown[]) => {
				if (this.failSend) throw new Error("send unavailable");
				if (typeof content !== "string") throw new Error("Unexpected non-text goal message.");
				this.sentUserMessages.push(content);
				this.manager.appendMessage({ role: "user", content, timestamp: this.wall });
			},
			sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
				if (this.failSend) throw new Error("send unavailable");
				this.sentMessages.push({ message, options });
				this.manager.appendCustomMessageEntry(
					message.customType,
					message.content as string,
					message.display,
					message.details,
				);
			},
			getThinkingLevel: () => "minimal",
			getActiveTools: () => ["read"],
			getAllTools: () => [],
		} as unknown as ExtensionAPI;
		this.context = {
			get mode() {
				return harness.mode;
			},
			hasUI: true,
			cwd: "/test/project",
			ui: {
				editor: vi.fn(async () => this.editorValue),
				notify: (message: string, type: string) => this.notifications.push({ message, type }),
				setStatus: (_key: string, value: string | undefined) => this.statusValues.push(value),
				onTerminalInput: (handler: (data: string) => unknown) => {
					this.terminalHandlers.add(handler);
					return () => this.terminalHandlers.delete(handler);
				},
			},
			get sessionManager() {
				return harness.manager;
			},
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "fixture" })),
			},
			model: this.model,
			thinkingLevel: "high",
			isIdle: () => this.idle,
			isProjectTrusted: () => true,
			signal: undefined,
			abort: this.abort,
			hasPendingMessages: () => false,
			shutdown: vi.fn(),
			getContextUsage: () => undefined,
			compact: vi.fn(),
			getSystemPrompt: () => "base system",
		} as unknown as ExtensionContext;
		this.coordinator = new GoalCoordinator(this.api, {
			wallNow: () => this.wall,
			monotonicNow: () => this.monotonic,
			createMainRunSnapshot: async (input) => {
				this.snapshotInputs.push(input);
				input.signal?.throwIfAborted();
				const cleanup = vi.fn(async () => undefined);
				const index = this.snapshots.length + 1;
				const bundle: GoalMainRunSnapshotBundle = {
					kind: "main",
					ownerSessionId: input.ownerSessionId,
					root: `/tmp/pi-goal-test-${index}`,
					files: {
						readme: `/tmp/pi-goal-test-${index}/README.md`,
						creationContext: `/tmp/pi-goal-test-${index}/creation-context.jsonl`,
						imageManifest: `/tmp/pi-goal-test-${index}/images/manifest.json`,
					},
					images: [],
					cleanup,
				};
				this.snapshots.push({ bundle, cleanup });
				return bundle;
			},
			runEvaluation: (input) => {
				this.evaluationInputs.push(input);
				const result = deferred<GoalEvaluationReportV1>();
				this.evaluationQueue.push(result);
				return result.promise;
			},
			cleanupStaleSnapshots: this.cleanupStale,
		});
	}

	async create(): Promise<void> {
		await this.coordinator.create(this.context);
	}

	startMain(): void {
		this.idle = false;
		this.coordinator.handleBeforeAgentStart({ systemPrompt: "base" } as never, this.context);
		this.coordinator.handleAgentStart(this.context);
	}

	async settleMain(stopReason: "stop" | "length" | "error" | "aborted" = "stop"): Promise<void> {
		const assistant = fauxAssistantMessage("main result", {
			stopReason,
			...(stopReason === "error" ? { errorMessage: "provider exhausted" } : {}),
		});
		this.manager.appendMessage(assistant);
		this.coordinator.handleAgentEnd({ messages: [assistant] } as AgentEndEvent);
		this.idle = true;
		await this.coordinator.handleAgentSettled(this.context);
	}

	async resolveEvaluation(report: GoalEvaluationReportV1): Promise<void> {
		const pending = this.evaluationQueue.shift();
		if (pending === undefined) throw new Error("No pending evaluator.");
		pending.resolve(report);
		for (let index = 0; index < 12; index += 1) await Promise.resolve();
	}

	async rejectEvaluation(error: unknown): Promise<void> {
		const pending = this.evaluationQueue.shift();
		if (pending === undefined) throw new Error("No pending evaluator.");
		pending.reject(error);
		for (let index = 0; index < 12; index += 1) await Promise.resolve();
	}

	terminalInput(data: string): unknown[] {
		return [...this.terminalHandlers].map((handler) => handler(data));
	}

	async shutdown(): Promise<void> {
		await this.coordinator.handleSessionShutdown(this.context);
	}
}

const harnesses: GoalHarness[] = [];

function createHarness(): GoalHarness {
	const harness = new GoalHarness();
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.shutdown();
});

describe("GoalCoordinator commands", () => {
	it("creates an exact multiline goal through the editor and sends the same first user message", async () => {
		const harness = createHarness();
		harness.editorValue = "first line\n  second line";

		await harness.create();

		expect(harness.coordinator.state).toMatchObject({
			status: "running",
			goalText: "first line\n  second line",
			goalSummary: "first line second line",
		});
		expect(harness.sentUserMessages).toEqual(["first line\n  second line"]);
		expect(harness.snapshotInputs).toHaveLength(1);
		expect(harness.appended[0]?.customType).toBe(GOAL_LIFECYCLE_ENTRY_TYPE);
	});

	it("does not replace state for editor cancel or whitespace-only input", async () => {
		const cancelled = createHarness();
		cancelled.editorValue = undefined;
		await cancelled.create();
		expect(cancelled.coordinator.state).toBeNull();

		const whitespace = createHarness();
		whitespace.editorValue = " \n\t ";
		await whitespace.create();
		expect(whitespace.coordinator.state).toBeNull();
		expect(whitespace.notifications.at(-1)?.message).toContain("cannot be empty");
	});

	it("enforces idle and TUI gates before opening the editor", async () => {
		const busy = createHarness();
		busy.idle = false;
		await busy.create();
		expect(busy.context.ui.editor).not.toHaveBeenCalled();

		const print = createHarness();
		print.mode = "print";
		await print.create();
		expect(print.context.ui.editor).not.toHaveBeenCalled();
		expect(print.notifications.at(-1)?.message).toContain("TUI");
	});

	it("keeps a failed goal until a replacement is successfully submitted", async () => {
		const harness = createHarness();
		await harness.create();
		harness.startMain();
		await harness.settleMain();
		await harness.resolveEvaluation(FAIL_REPORT);
		expect(harness.coordinator.state?.status).toBe("failed");

		harness.editorValue = undefined;
		await harness.create();
		expect(harness.coordinator.state?.status).toBe("failed");

		harness.editorValue = "replacement goal";
		await harness.create();
		expect(harness.coordinator.state).toMatchObject({ status: "running", goalText: "replacement goal" });
	});

	it("dismisses failed with cancel and rejects resume outside paused/error", async () => {
		const harness = createHarness();
		await harness.create();
		harness.startMain();
		await harness.settleMain();
		await harness.resolveEvaluation(FAIL_REPORT);

		await harness.coordinator.resume(harness.context);
		expect(harness.coordinator.state?.status).toBe("failed");
		expect(harness.notifications.at(-1)?.message).toContain("No paused or errored");

		await harness.coordinator.cancel(harness.context);
		expect(harness.coordinator.state?.status).toBe("dismissed");
		expect(harness.statusValues.at(-1)).toBeUndefined();
	});
});

describe("GoalCoordinator main and evaluation loop", () => {
	it("evaluates only after settled and starts exactly one contract-carrying continuation", async () => {
		const harness = createHarness();
		await harness.create();
		const before = harness.coordinator.handleBeforeAgentStart(
			{ systemPrompt: "base system" } as never,
			harness.context,
		);
		expect(before?.systemPrompt).toContain('goal_text_json: "ship\\nthe result"');
		expect(before?.systemPrompt).toContain("immutable goal");

		harness.startMain();
		expect(harness.evaluationInputs).toHaveLength(0);
		await harness.settleMain();
		expect(harness.coordinator.state?.status).toBe("evaluating");
		expect(harness.evaluationInputs).toHaveLength(1);

		await harness.resolveEvaluation(CONTINUE_REPORT);
		expect(harness.coordinator.state).toMatchObject({ status: "running", evaluationCount: 1 });
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.options).toEqual({ triggerTurn: true });
		expect(harness.sentMessages[0]?.message.content).toContain("active_goal_contract");
		expect(harness.sentMessages[0]?.message.content).toContain("Take the next verified step");
	});

	it.each([
		[COMPLETE_REPORT, "completed"],
		[FAIL_REPORT, "failed"],
	] as const)("commits %s without starting a wrap-up run", async (report, expectedStatus) => {
		const harness = createHarness();
		await harness.create();
		harness.startMain();
		await harness.settleMain();
		await harness.resolveEvaluation(report);

		expect(harness.coordinator.state?.status).toBe(expectedStatus);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.options).toBeUndefined();
		expect(harness.sentMessages[0]?.message.display).toBe(true);
	});

	it("pauses an aborted main run and never evaluates it", async () => {
		const harness = createHarness();
		await harness.create();
		harness.startMain();
		expect(harness.terminalInput("\u001b")).toEqual([undefined]);
		await harness.settleMain("aborted");

		expect(harness.coordinator.state).toMatchObject({ status: "paused", resumePhase: "main" });
		expect(harness.evaluationInputs).toHaveLength(0);
	});

	it("maps final main provider failure to resumable error(main)", async () => {
		const harness = createHarness();
		await harness.create();
		harness.startMain();
		await harness.settleMain("error");

		expect(harness.coordinator.state).toMatchObject({ status: "error", resumePhase: "main" });
		expect(harness.evaluationInputs).toHaveLength(0);
		expect(harness.appended.some((entry) => entry.customType.includes("error"))).toBe(true);
	});

	it("maps evaluator infrastructure failure to error(evaluation), never semantic fail", async () => {
		const harness = createHarness();
		await harness.create();
		harness.startMain();
		await harness.settleMain();
		await harness.rejectEvaluation(new Error("evaluator provider exhausted"));

		expect(harness.coordinator.state).toMatchObject({
			status: "error",
			resumePhase: "evaluation",
			evaluationCount: 0,
		});
	});

	it("invalidates an evaluation for ordinary input and discards its late report", async () => {
		const harness = createHarness();
		await harness.create();
		harness.startMain();
		await harness.settleMain();
		const evaluationSignal = harness.evaluationInputs[0]?.signal;

		const result = await harness.coordinator.handleInput(
			{ text: "try the other route", source: "interactive" } as InputEvent,
			harness.context,
		);
		expect(result).toEqual({ action: "continue" });
		expect(evaluationSignal?.aborted).toBe(true);
		expect(harness.coordinator.state).toMatchObject({ status: "running", evaluationCount: 0 });

		await harness.resolveEvaluation(CONTINUE_REPORT);
		expect(harness.coordinator.state).toMatchObject({ status: "running", evaluationCount: 0 });
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("consumes Escape during evaluation and ignores a late evaluator result", async () => {
		const harness = createHarness();
		await harness.create();
		harness.startMain();
		await harness.settleMain();
		const evaluationSignal = harness.evaluationInputs[0]?.signal;

		expect(harness.terminalInput("\u001b")).toEqual([{ consume: true }]);
		expect(evaluationSignal?.aborted).toBe(true);
		expect(harness.coordinator.state).toMatchObject({ status: "paused", resumePhase: "evaluation" });
		await harness.resolveEvaluation(COMPLETE_REPORT);
		expect(harness.coordinator.state?.status).toBe("paused");
	});

	it("makes cancel win over late tools, settlement, and evaluator completion", async () => {
		const running = createHarness();
		await running.create();
		running.startMain();
		await running.coordinator.cancel(running.context);
		expect(running.coordinator.state?.status).toBe("cancelled");
		expect(running.abort).toHaveBeenCalledOnce();
		expect(running.coordinator.handleToolCall()).toMatchObject({ block: true });
		await running.settleMain("aborted");
		expect(running.coordinator.state?.status).toBe("cancelled");

		const evaluating = createHarness();
		await evaluating.create();
		evaluating.startMain();
		await evaluating.settleMain();
		await evaluating.coordinator.cancel(evaluating.context);
		await evaluating.resolveEvaluation(COMPLETE_REPORT);
		expect(evaluating.coordinator.state?.status).toBe("cancelled");
	});

	it("blocks ordinary prompts while paused/error but allows them after fail", async () => {
		const paused = createHarness();
		await paused.create();
		paused.startMain();
		await paused.settleMain("aborted");
		expect(
			await paused.coordinator.handleInput({ text: "hello", source: "interactive" } as InputEvent, paused.context),
		).toEqual({ action: "handled" });

		const failed = createHarness();
		await failed.create();
		failed.startMain();
		await failed.settleMain();
		await failed.resolveEvaluation(FAIL_REPORT);
		expect(
			await failed.coordinator.handleInput({ text: "hello", source: "interactive" } as InputEvent, failed.context),
		).toEqual({ action: "continue" });
	});

	it("resumes the interrupted phase without duplicating completed work", async () => {
		const main = createHarness();
		await main.create();
		main.startMain();
		await main.settleMain("aborted");
		await main.coordinator.resume(main.context);
		expect(main.coordinator.state).toMatchObject({ status: "running", resumePhase: null });
		expect(main.sentMessages.at(-1)?.message.content).toContain("prior side effects");

		const evaluation = createHarness();
		await evaluation.create();
		evaluation.startMain();
		await evaluation.settleMain();
		evaluation.terminalInput("\u001b");
		await evaluation.coordinator.resume(evaluation.context);
		expect(evaluation.coordinator.state).toMatchObject({ status: "evaluating", evaluationCount: 0 });
		expect(evaluation.evaluationInputs).toHaveLength(2);
		expect(evaluation.sentMessages).toHaveLength(0);
	});

	it("blocks history navigation only while the goal is active", async () => {
		const harness = createHarness();
		await harness.create();
		expect(harness.coordinator.guardNavigation(harness.context)).toEqual({ cancel: true });
		harness.startMain();
		await harness.settleMain("aborted");
		expect(harness.coordinator.guardNavigation(harness.context)).toBeUndefined();
	});
});

describe("GoalCoordinator persistence and recovery", () => {
	it("folds active time at checkpoints and freezes it while paused", async () => {
		const harness = createHarness();
		await harness.create();
		harness.monotonic = 1_000;
		harness.startMain();
		harness.monotonic = 4_000;
		await harness.settleMain("aborted");

		expect(harness.coordinator.state?.activeElapsedMs).toBe(4_000);
		harness.monotonic = 40_000;
		expect(harness.coordinator.state?.activeElapsedMs).toBe(4_000);
	});

	it("enters a visible in-memory error when lifecycle persistence fails", async () => {
		const harness = createHarness();
		await harness.create();
		harness.startMain();
		harness.failNextAppend = true;
		await harness.settleMain();

		expect(harness.coordinator.state).toMatchObject({ status: "error", resumePhase: "main" });
		expect(harness.appended.some((entry) => entry.customType.includes("error"))).toBe(true);
	});

	it("enters error(main) when the initial user-message dispatch throws after creation commits", async () => {
		const harness = createHarness();
		harness.failSend = true;
		await harness.create();

		expect(harness.coordinator.state).toMatchObject({ status: "error", resumePhase: "main" });
		expect(harness.sentUserMessages).toHaveLength(0);
	});

	it("recovers a successful uncheckpointed main response directly into evaluation", async () => {
		const original = createHarness();
		await original.create();
		original.startMain();
		const assistant = fauxAssistantMessage("finished before crash", { stopReason: "length" });
		original.manager.appendMessage(assistant);

		const recovered = createHarness();
		recovered.manager = original.manager;
		await recovered.coordinator.handleSessionStart(recovered.context);
		await recovered.coordinator.handleSessionStart(recovered.context);

		expect(recovered.coordinator.state?.status).toBe("evaluating");
		expect(recovered.evaluationInputs).toHaveLength(1);
		expect(recovered.sentMessages).toHaveLength(0);
	});

	it("restores running with a hidden side-effect-aware continuation and cleans stale snapshots once", async () => {
		const original = createHarness();
		await original.create();

		const recovered = createHarness();
		recovered.manager = original.manager;
		await recovered.coordinator.handleSessionStart(recovered.context);
		await recovered.coordinator.handleSessionStart(recovered.context);

		expect(recovered.coordinator.state?.status).toBe("running");
		expect(recovered.sentMessages).toHaveLength(1);
		expect(recovered.sentMessages[0]?.message.content).toContain("prior side effects");
		expect(recovered.cleanupStale).toHaveBeenCalledOnce();
	});

	it("checkpoints shutdown once, excludes offline/startup coordination time, and resumes automatically", async () => {
		const original = createHarness();
		await original.create();
		original.monotonic = 5_000;
		await original.coordinator.handleSessionShutdown(original.context);
		const checkpointsAfterFirstShutdown = original.appended.filter(
			(entry) =>
				entry.customType === GOAL_LIFECYCLE_ENTRY_TYPE &&
				(entry.data as { kind?: string }).kind === "shutdown-checkpoint",
		).length;
		await original.coordinator.handleSessionShutdown(original.context);
		expect(
			original.appended.filter(
				(entry) =>
					entry.customType === GOAL_LIFECYCLE_ENTRY_TYPE &&
					(entry.data as { kind?: string }).kind === "shutdown-checkpoint",
			).length,
		).toBe(checkpointsAfterFirstShutdown);
		expect(original.coordinator.state?.activeElapsedMs).toBe(5_000);

		const recovered = createHarness();
		recovered.manager = original.manager;
		recovered.monotonic = 100_000;
		await recovered.coordinator.handleSessionStart(recovered.context);
		expect(recovered.coordinator.state).toMatchObject({ status: "running", activeElapsedMs: 5_000 });
		expect(recovered.sentMessages).toHaveLength(1);
	});

	it("restores evaluating without repeating the preceding main run", async () => {
		const original = createHarness();
		await original.create();
		original.startMain();
		await original.settleMain();

		const recovered = createHarness();
		recovered.manager = original.manager;
		await recovered.coordinator.handleSessionStart(recovered.context);

		expect(recovered.coordinator.state?.status).toBe("evaluating");
		expect(recovered.evaluationInputs).toHaveLength(1);
		expect(recovered.sentMessages).toHaveLength(0);
	});

	it("loads active state without timers or automatic work outside TUI", async () => {
		const original = createHarness();
		await original.create();
		const loaded = createHarness();
		loaded.manager = original.manager;
		loaded.mode = "print";
		await loaded.coordinator.handleSessionStart(loaded.context);

		expect(loaded.coordinator.state?.status).toBe("running");
		expect(loaded.sentMessages).toHaveLength(0);
		expect(loaded.evaluationInputs).toHaveLength(0);
		expect(loaded.terminalHandlers.size).toBe(0);
	});

	it("recovers a missing terminal projection exactly once when the message is present thereafter", async () => {
		const original = createHarness();
		await original.create();
		original.startMain();
		await original.settleMain();
		const evaluation = original.coordinator.state?.pendingEvaluation;
		if (evaluation === null || evaluation === undefined || evaluation.evaluationAttemptId === null) {
			throw new Error("Missing evaluation attempt.");
		}
		original.manager.appendCustomEntry(GOAL_EVALUATION_ENTRY_TYPE, {
			schemaVersion: 1,
			ownerSessionId: original.manager.getSessionId(),
			goalId: original.coordinator.state?.goalId,
			sequence: (original.coordinator.state?.lastSequence ?? 0) + 1,
			timestamp: 2_000,
			activeElapsedMs: original.coordinator.state?.activeElapsedMs ?? 0,
			evaluationId: "evaluation-terminal",
			evaluationNumber: evaluation.evaluationNumber,
			evaluationAttemptId: evaluation.evaluationAttemptId,
			precedingMainRunId: evaluation.precedingMainRunId,
			report: COMPLETE_REPORT,
		});

		const recovered = createHarness();
		recovered.manager = original.manager;
		await recovered.coordinator.handleSessionStart(recovered.context);
		await recovered.coordinator.handleSessionStart(recovered.context);

		expect(recovered.coordinator.state?.status).toBe("completed");
		expect(recovered.sentMessages).toHaveLength(1);
	});
});
