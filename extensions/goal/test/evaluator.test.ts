import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GOAL_LIFECYCLE_ENTRY_TYPE,
	GOAL_SNAPSHOT_IMAGE_TOOL,
	GOAL_SNAPSHOT_READ_TOOL,
	GOAL_SNAPSHOT_SEARCH_TOOL,
	GOAL_SUBMIT_EVALUATION_TOOL,
} from "../src/constants.js";
import {
	createGoalCreatedEvent,
	createGoalLifecycleEvent,
	type GoalEvaluationReportV1,
	restoreGoalSessionState,
} from "../src/domain.js";
import { GoalEvaluatorFormatError, GoalEvaluatorInfrastructureError, runGoalEvaluation } from "../src/evaluator.js";

const settingsFixture = vi.hoisted(() => ({
	agentDir: "/tmp/goal-evaluator-agent-uninitialized",
	retryEnabled: false,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		getAgentDir: () => settingsFixture.agentDir,
		SettingsManager: {
			create: (_cwd: string, _agentDir: string, options: { projectTrusted?: boolean }) =>
				actual.SettingsManager.inMemory(
					{
						retry: {
							enabled: settingsFixture.retryEnabled,
							maxRetries: 1,
							baseDelayMs: 0,
						},
					},
					options,
				),
		},
	};
});

const CONTINUE_REPORT: GoalEvaluationReportV1 = {
	decision: "continue",
	progress: "A verified milestone exists.",
	reason: "One concrete path remains.",
	next_action: "Run the remaining verification.",
	evidence: ["current-context.jsonl"],
};

const COMPLETE_REPORT: GoalEvaluationReportV1 = {
	decision: "complete",
	progress: "The required result is implemented and verified.",
	reason: "All explicit completion criteria have evidence.",
	next_action: null,
	evidence: ["verification output"],
};

const FAIL_REPORT: GoalEvaluationReportV1 = {
	decision: "fail",
	progress: "Every permitted route was checked.",
	reason: "The required authority is unavailable and there is no safe alternative.",
	next_action: null,
	evidence: ["capability boundary"],
};

interface EvaluatorFixture {
	readonly manager: SessionManager;
	readonly goal: NonNullable<ReturnType<typeof restoreGoalSessionState>["goal"]>;
	readonly context: ExtensionContext;
	readonly pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel">;
	readonly model: Model<string>;
}

const temporaryRoots: string[] = [];

beforeEach(async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-evaluator-test-"));
	temporaryRoots.push(root);
	settingsFixture.agentDir = join(root, "agent");
	settingsFixture.retryEnabled = false;
	await mkdir(settingsFixture.agentDir, { recursive: true });
});

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function appendEvaluationReadyGoal(manager: SessionManager): NonNullable<EvaluatorFixture["goal"]> {
	const ownerSessionId = manager.getSessionId();
	manager.appendCustomEntry(
		GOAL_LIFECYCLE_ENTRY_TYPE,
		createGoalCreatedEvent({
			ownerSessionId,
			goalId: "goal-evaluator-fixture",
			sequence: 1,
			timestamp: 1_000,
			activeElapsedMs: 0,
			goalText: "Deliver the verified fixture result.",
			creationAnchorEntryId: null,
		}),
	);
	manager.appendCustomEntry(
		GOAL_LIFECYCLE_ENTRY_TYPE,
		createGoalLifecycleEvent({
			ownerSessionId,
			goalId: "goal-evaluator-fixture",
			sequence: 2,
			timestamp: 1_100,
			activeElapsedMs: 100,
			kind: "main-started",
			mainRunId: "main-run-1",
			cause: "creation",
		}),
	);
	manager.appendCustomEntry(
		GOAL_LIFECYCLE_ENTRY_TYPE,
		createGoalLifecycleEvent({
			ownerSessionId,
			goalId: "goal-evaluator-fixture",
			sequence: 3,
			timestamp: 1_200,
			activeElapsedMs: 200,
			kind: "main-settled",
			mainRunId: "main-run-1",
		}),
	);
	manager.appendCustomEntry(
		GOAL_LIFECYCLE_ENTRY_TYPE,
		createGoalLifecycleEvent({
			ownerSessionId,
			goalId: "goal-evaluator-fixture",
			sequence: 4,
			timestamp: 1_300,
			activeElapsedMs: 300,
			kind: "evaluation-started",
			evaluationNumber: 1,
			evaluationAttemptId: "evaluation-attempt-1",
			precedingMainRunId: "main-run-1",
			model: { provider: "goal-evaluator-faux", id: "judge" },
			thinkingLevel: "xhigh",
		}),
	);
	const restored = restoreGoalSessionState(manager.getEntries(), ownerSessionId).goal;
	if (restored === null) throw new Error("Failed to build evaluator fixture goal.");
	return restored;
}

function createFixture(
	responseFactory: (context: Context, options: StreamOptions | undefined) => ReturnType<typeof fauxAssistantMessage>,
): EvaluatorFixture {
	const faux = fauxProvider({
		provider: "goal-evaluator-faux",
		models: [{ id: "judge", reasoning: true, input: ["text", "image"] }],
	});
	const model = faux.getModel();
	faux.setResponses(
		Array.from(
			{ length: 4 },
			() => (context: Context, options: StreamOptions | undefined) => responseFactory(context, options),
		),
	);
	const manager = SessionManager.inMemory(join(settingsFixture.agentDir, "project"));
	const goal = appendEvaluationReadyGoal(manager);
	const context = {
		mode: "tui",
		hasUI: true,
		cwd: join(settingsFixture.agentDir, "project"),
		sessionManager: manager,
		model,
		thinkingLevel: "high",
		modelRegistry: {
			getProvider: () => faux.provider,
			getProviderAuth: vi.fn(async () => ({ auth: { apiKey: "fixture-secret" }, source: "test" })),
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true,
				apiKey: "fixture-secret",
				headers: { "x-evaluator": "yes" },
				env: { GOAL_FIXTURE: "yes" },
			})),
		},
		isProjectTrusted: () => true,
		isIdle: () => true,
	} as unknown as ExtensionContext;
	const activeTool: ToolInfo = {
		name: "read",
		description: "Read a project file.",
		parameters: { type: "object", properties: {} } as never,
		promptGuidelines: [],
		sourceInfo: { path: "/fixture/read.ts", type: "builtin" } as never,
	};
	const pi = {
		getActiveTools: () => ["read"],
		getAllTools: () => [activeTool],
		getThinkingLevel: () => "minimal" as const,
	};
	return { manager, goal, context, pi, model };
}

async function evaluate(
	fixture: EvaluatorFixture,
	signal = new AbortController().signal,
): Promise<GoalEvaluationReportV1> {
	return await runGoalEvaluation({
		pi: fixture.pi,
		context: fixture.context,
		goal: fixture.goal,
		evaluationNumber: 1,
		activeElapsedMs: 12_345,
		signal,
	});
}

function reportResponse(report: GoalEvaluationReportV1): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(fauxToolCall(GOAL_SUBMIT_EVALUATION_TOOL, report), { stopReason: "toolUse" });
}

describe("isolated goal evaluator", () => {
	it.each([CONTINUE_REPORT, COMPLETE_REPORT, FAIL_REPORT])("accepts a structured $decision report", async (report) => {
		const fixture = createFixture(() => reportResponse(report));
		await expect(evaluate(fixture)).resolves.toEqual(report);
	});

	it("inherits the active model/thinking and exposes only the four evaluator tools", async () => {
		let observedContext: Context | undefined;
		let observedOptions: StreamOptions | undefined;
		const fixture = createFixture((context, options) => {
			observedContext = context;
			observedOptions = options;
			return reportResponse(CONTINUE_REPORT);
		});

		await evaluate(fixture);

		expect(observedContext?.tools?.map((tool) => tool.name)).toEqual([
			GOAL_SNAPSHOT_READ_TOOL,
			GOAL_SNAPSHOT_SEARCH_TOOL,
			GOAL_SNAPSHOT_IMAGE_TOOL,
			GOAL_SUBMIT_EVALUATION_TOOL,
		]);
		expect(observedContext?.systemPrompt).toContain("independent evaluator");
		expect(observedContext?.systemPrompt).toContain("evaluation_number: 1");
		expect(observedOptions).toMatchObject({ reasoning: "high" });
		expect(fixture.model.id).toBe("judge");
	});

	it("allows multiple snapshot inspection turns before a valid report", async () => {
		let calls = 0;
		const fixture = createFixture(() => {
			calls += 1;
			if (calls === 1) {
				return fauxAssistantMessage(fauxToolCall(GOAL_SNAPSHOT_READ_TOOL, { path: "README.md" }), {
					stopReason: "toolUse",
				});
			}
			if (calls === 2) {
				return fauxAssistantMessage(fauxToolCall(GOAL_SNAPSHOT_SEARCH_TOOL, { query: "fixture" }), {
					stopReason: "toolUse",
				});
			}
			return reportResponse(COMPLETE_REPORT);
		});

		await expect(evaluate(fixture)).resolves.toEqual(COMPLETE_REPORT);
		expect(calls).toBe(3);
	});

	it("allows exactly one correction after a free-text response", async () => {
		let calls = 0;
		const fixture = createFixture(() => {
			calls += 1;
			return calls === 1 ? fauxAssistantMessage("free text is invalid") : reportResponse(COMPLETE_REPORT);
		});
		await expect(evaluate(fixture)).resolves.toEqual(COMPLETE_REPORT);
		expect(calls).toBe(2);
	});

	it("counts a semantic tool validation failure once before accepting its correction", async () => {
		let calls = 0;
		let correctionContext: Context | undefined;
		const fixture = createFixture((context) => {
			calls += 1;
			if (calls === 1) {
				return fauxAssistantMessage(
					fauxToolCall(GOAL_SUBMIT_EVALUATION_TOOL, { ...CONTINUE_REPORT, progress: "   " }),
					{ stopReason: "toolUse" },
				);
			}
			correctionContext = context;
			return reportResponse(COMPLETE_REPORT);
		});

		await expect(evaluate(fixture)).resolves.toEqual(COMPLETE_REPORT);
		expect(calls).toBe(2);
		expect(JSON.stringify(correctionContext)).toContain("progress must be non-blank and at most 4000 characters.");
	});

	it("rejects two free-text responses as a format error", async () => {
		let calls = 0;
		const fixture = createFixture(() => {
			calls += 1;
			return fauxAssistantMessage("still not a tool report");
		});

		await expect(evaluate(fixture)).rejects.toBeInstanceOf(GoalEvaluatorFormatError);
		expect(calls).toBe(2);
	});

	it("does not grant a third response after an invalid submit tool call and one correction", async () => {
		let calls = 0;
		const fixture = createFixture(() => {
			calls += 1;
			if (calls === 1) {
				return fauxAssistantMessage(
					fauxToolCall(GOAL_SUBMIT_EVALUATION_TOOL, {
						decision: "continue",
						progress: "partial",
						reason: "path remains",
						next_action: null,
						evidence: ["evidence"],
					}),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("the single correction is also invalid");
		});

		await expect(evaluate(fixture)).rejects.toBeInstanceOf(GoalEvaluatorFormatError);
		expect(calls).toBe(2);
	});

	it("keeps provider failure separate from semantic fail", async () => {
		const fixture = createFixture(() =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture provider unavailable" }),
		);

		await expect(evaluate(fixture)).rejects.toMatchObject({
			name: GoalEvaluatorInfrastructureError.name,
			message: "fixture provider unavailable",
		});
	});

	it("honors an already-aborted evaluation signal without calling the provider", async () => {
		let calls = 0;
		const fixture = createFixture(() => {
			calls += 1;
			return reportResponse(CONTINUE_REPORT);
		});
		const controller = new AbortController();
		controller.abort();

		await expect(evaluate(fixture, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(0);
	});
});
