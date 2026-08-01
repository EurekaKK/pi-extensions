import { describe, expect, it } from "vitest";
import {
	createGoalCreatedEvent,
	createGoalEvaluationEntry,
	createGoalLifecycleEvent,
	GOAL_EVALUATION_ENTRY_TYPE,
	GOAL_LIFECYCLE_ENTRY_TYPE,
	type GoalLifecycleEventV1,
	parseGoalLifecycleEvent,
	restoreGoalSessionState,
} from "../src/session-state.js";

const OWNER = "session-owner";
const GOAL = "goal-one";

function custom(customType: string, data: unknown, id: string): Record<string, unknown> {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-08-01T00:00:00.000Z",
		customType,
		data,
	};
}

function lifecycle(event: GoalLifecycleEventV1): Record<string, unknown> {
	return custom(GOAL_LIFECYCLE_ENTRY_TYPE, event, `${event.goalId}-${event.sequence}`);
}

function created(goalId = GOAL, ownerSessionId = OWNER): GoalLifecycleEventV1 {
	return createGoalCreatedEvent({
		ownerSessionId,
		goalId,
		sequence: 1,
		timestamp: 1,
		activeElapsedMs: 0,
		goalText: "  finish\nverified work  ",
		creationAnchorEntryId: "anchor-1",
	});
}

function mainStarted(sequence: number, runId: string, cause: "creation" | "evaluation-continue" | "resume") {
	return createGoalLifecycleEvent({
		kind: "main-started",
		ownerSessionId: OWNER,
		goalId: GOAL,
		sequence,
		timestamp: sequence,
		activeElapsedMs: sequence * 10,
		mainRunId: runId,
		cause,
	});
}

function mainSettled(sequence: number, runId: string) {
	return createGoalLifecycleEvent({
		kind: "main-settled",
		ownerSessionId: OWNER,
		goalId: GOAL,
		sequence,
		timestamp: sequence,
		activeElapsedMs: sequence * 10,
		mainRunId: runId,
	});
}

function evaluationStarted(sequence: number, number: number, runId: string, attemptId: string) {
	return createGoalLifecycleEvent({
		kind: "evaluation-started",
		ownerSessionId: OWNER,
		goalId: GOAL,
		sequence,
		timestamp: sequence,
		activeElapsedMs: sequence * 10,
		evaluationNumber: number,
		evaluationAttemptId: attemptId,
		precedingMainRunId: runId,
		model: { provider: "fixture", id: "model" },
		thinkingLevel: "high",
	});
}

function evaluation(
	sequence: number,
	number: number,
	runId: string,
	attemptId: string,
	decision: "continue" | "complete" | "fail",
) {
	return createGoalEvaluationEntry({
		ownerSessionId: OWNER,
		goalId: GOAL,
		sequence,
		timestamp: sequence,
		activeElapsedMs: sequence * 10,
		evaluationId: `evaluation-${number}`,
		evaluationNumber: number,
		evaluationAttemptId: attemptId,
		precedingMainRunId: runId,
		report:
			decision === "continue"
				? {
						decision,
						progress: "made progress",
						reason: "a concrete path remains",
						next_action: "take the next step",
						evidence: ["observed output"],
					}
				: {
						decision,
						progress: "finished work",
						reason: decision === "complete" ? "verified complete" : "no path remains",
						next_action: null,
						evidence: ["observed output"],
					},
	});
}

describe("goal session-global reducer", () => {
	it("restores a complete multi-run stream and full accepted evaluation history", () => {
		const entries = [
			lifecycle(created()),
			lifecycle(mainStarted(2, "run-1", "creation")),
			lifecycle(mainSettled(3, "run-1")),
			lifecycle(evaluationStarted(4, 1, "run-1", "attempt-1")),
			custom(GOAL_EVALUATION_ENTRY_TYPE, evaluation(5, 1, "run-1", "attempt-1", "continue"), "eval-1"),
			lifecycle(mainStarted(6, "run-2", "evaluation-continue")),
			lifecycle(mainSettled(7, "run-2")),
			lifecycle(evaluationStarted(8, 2, "run-2", "attempt-2")),
			custom(GOAL_EVALUATION_ENTRY_TYPE, evaluation(9, 2, "run-2", "attempt-2", "fail"), "eval-2"),
		];

		const restored = restoreGoalSessionState(entries, OWNER);
		expect(restored.foundCorruptEntry).toBe(false);
		expect(restored.goal).toMatchObject({
			goalId: GOAL,
			goalText: "  finish\nverified work  ",
			goalSummary: "finish verified work",
			status: "failed",
			evaluationCount: 2,
			lastSequence: 9,
			pendingEvaluation: null,
		});
		expect(restored.goal?.evaluationHistory.map((item) => item.report.decision)).toEqual(["continue", "fail"]);
	});

	it("keeps failed visible until dismiss, and permits a new created stream to replace it", () => {
		const failedStream = [
			lifecycle(created()),
			lifecycle(mainStarted(2, "run-1", "creation")),
			lifecycle(mainSettled(3, "run-1")),
			lifecycle(evaluationStarted(4, 1, "run-1", "attempt-1")),
			custom(GOAL_EVALUATION_ENTRY_TYPE, evaluation(5, 1, "run-1", "attempt-1", "fail"), "eval-1"),
		];
		expect(restoreGoalSessionState(failedStream, OWNER).goal?.status).toBe("failed");

		const dismissed = createGoalLifecycleEvent({
			kind: "dismissed",
			ownerSessionId: OWNER,
			goalId: GOAL,
			sequence: 6,
			timestamp: 6,
			activeElapsedMs: 50,
		});
		expect(restoreGoalSessionState([...failedStream, lifecycle(dismissed)], OWNER).goal?.status).toBe("dismissed");

		const replacement = created("goal-two");
		const replaced = restoreGoalSessionState([...failedStream, lifecycle(replacement)], OWNER);
		expect(replaced.foundCorruptEntry).toBe(false);
		expect(replaced.goal).toMatchObject({ goalId: "goal-two", status: "running", evaluationCount: 0 });
	});

	it("restores paused and error phases and only accepts a matching resume", () => {
		const paused = createGoalLifecycleEvent({
			kind: "paused",
			ownerSessionId: OWNER,
			goalId: GOAL,
			sequence: 3,
			timestamp: 3,
			activeElapsedMs: 20,
			interruptedPhase: "main",
		});
		const resumed = createGoalLifecycleEvent({
			kind: "resumed",
			ownerSessionId: OWNER,
			goalId: GOAL,
			sequence: 4,
			timestamp: 4,
			activeElapsedMs: 20,
			resumePhase: "main",
		});
		const mainEntries = [lifecycle(created()), lifecycle(mainStarted(2, "run-1", "creation")), lifecycle(paused)];
		expect(restoreGoalSessionState(mainEntries, OWNER).goal).toMatchObject({
			status: "paused",
			resumePhase: "main",
			mainRunInProgress: false,
		});
		expect(restoreGoalSessionState([...mainEntries, lifecycle(resumed)], OWNER).goal).toMatchObject({
			status: "running",
			resumePhase: null,
		});

		const evaluationError = createGoalLifecycleEvent({
			kind: "error",
			ownerSessionId: OWNER,
			goalId: GOAL,
			sequence: 5,
			timestamp: 5,
			activeElapsedMs: 40,
			failedPhase: "evaluation",
		});
		const evaluationEntries = [
			lifecycle(created()),
			lifecycle(mainStarted(2, "run-1", "creation")),
			lifecycle(mainSettled(3, "run-1")),
			lifecycle(evaluationStarted(4, 1, "run-1", "attempt-1")),
			lifecycle(evaluationError),
		];
		expect(restoreGoalSessionState(evaluationEntries, OWNER).goal).toMatchObject({
			status: "error",
			resumePhase: "evaluation",
			pendingEvaluation: { evaluationNumber: 1, evaluationAttemptId: null },
		});
	});

	it("invalidates an in-flight evaluation without accepting its later report", () => {
		const invalidated = createGoalLifecycleEvent({
			kind: "evaluation-invalidated",
			ownerSessionId: OWNER,
			goalId: GOAL,
			sequence: 5,
			timestamp: 5,
			activeElapsedMs: 40,
			evaluationAttemptId: "attempt-1",
		});
		const stale = evaluation(6, 1, "run-1", "attempt-1", "complete");
		const restored = restoreGoalSessionState(
			[
				lifecycle(created()),
				lifecycle(mainStarted(2, "run-1", "creation")),
				lifecycle(mainSettled(3, "run-1")),
				lifecycle(evaluationStarted(4, 1, "run-1", "attempt-1")),
				lifecycle(invalidated),
				custom(GOAL_EVALUATION_ENTRY_TYPE, stale, "stale-eval"),
			],
			OWNER,
		);
		expect(restored.goal).toMatchObject({ status: "running", evaluationCount: 0, pendingEvaluation: null });
		expect(restored.foundCorruptEntry).toBe(true);
	});

	it("strictly skips corrupt, non-monotonic, orphaned, and illegal transition entries", () => {
		const extraKey = { ...mainStarted(2, "run-1", "creation"), extra: true };
		expect(parseGoalLifecycleEvent(extraKey)).toBeNull();
		const orphanedSettle = mainSettled(3, "run-missing");
		const duplicateSequence = createGoalLifecycleEvent({
			kind: "main-started",
			ownerSessionId: OWNER,
			goalId: GOAL,
			sequence: 1,
			timestamp: 4,
			activeElapsedMs: 0,
			mainRunId: "run-duplicate",
			cause: "creation",
		});
		const restored = restoreGoalSessionState(
			[
				lifecycle(created()),
				custom(GOAL_LIFECYCLE_ENTRY_TYPE, extraKey, "extra"),
				lifecycle(orphanedSettle),
				lifecycle(duplicateSequence),
			],
			OWNER,
		);
		expect(restored.foundCorruptEntry).toBe(true);
		expect(restored.goal).toMatchObject({ status: "running", lastSequence: 1, lastMainRunId: null });
	});

	it("ignores valid copied entries owned by another session, preventing fork inheritance", () => {
		const copied = lifecycle(created(GOAL, "original-session"));
		expect(restoreGoalSessionState([copied], "fork-session")).toEqual({
			goal: null,
			foundCorruptEntry: false,
		});
	});

	it("uses file append order rather than branch parentage", () => {
		const start = lifecycle(mainStarted(2, "run-1", "creation"));
		start.parentId = "unrelated-branch-leaf";
		const restored = restoreGoalSessionState([lifecycle(created()), start], OWNER);
		expect(restored.goal).toMatchObject({ status: "running", mainRunInProgress: true, lastSequence: 2 });
	});
});
