import { describe, expect, it } from "vitest";
import {
	beginActiveElapsed,
	createGoalCreatedEvent,
	createGoalEvaluationEntry,
	foldActiveElapsed,
	parseGoalEvaluationReport,
	readActiveElapsed,
	summarizeGoalText,
} from "../src/domain.js";

describe("goal domain primitives", () => {
	it("mechanically collapses all goal whitespace without rewriting content", () => {
		expect(summarizeGoalText("  ship\n\t the\u00a0feature  ")).toBe("ship the feature");
	});

	it("strictly validates discriminated evaluation reports", () => {
		const valid = parseGoalEvaluationReport({
			decision: "continue",
			progress: "Inspected the failing test.",
			reason: "A concrete fix remains.",
			next_action: "Patch the parser.",
			evidence: ["test/parser.test.ts fails"],
		});
		expect(valid).toEqual({
			decision: "continue",
			progress: "Inspected the failing test.",
			reason: "A concrete fix remains.",
			next_action: "Patch the parser.",
			evidence: ["test/parser.test.ts fails"],
		});
		expect(Object.isFrozen(valid)).toBe(true);
		expect(Object.isFrozen(valid?.evidence)).toBe(true);

		expect(parseGoalEvaluationReport({ ...valid, next_action: null })).toBeNull();
		expect(parseGoalEvaluationReport({ ...valid, unexpected: true })).toBeNull();
		expect(parseGoalEvaluationReport({ ...valid, evidence: [] })).toBeNull();
		expect(
			parseGoalEvaluationReport({
				...valid,
				decision: "complete",
				next_action: "one more task",
			}),
		).toBeNull();
		expect(
			parseGoalEvaluationReport({
				...valid,
				decision: "fail",
				next_action: null,
			}),
		).toMatchObject({ decision: "fail", next_action: null });
	});

	it("counts report bounds as Unicode code points", () => {
		const report = {
			decision: "continue",
			progress: "ok",
			reason: "reason",
			next_action: "😀".repeat(2_000),
			evidence: ["evidence"],
		} as const;
		expect(parseGoalEvaluationReport(report)).not.toBeNull();
		expect(parseGoalEvaluationReport({ ...report, next_action: `${report.next_action}😀` })).toBeNull();
	});

	it("creates immutable creation and evaluation entries while preserving exact goal text", () => {
		const created = createGoalCreatedEvent({
			ownerSessionId: "session-1",
			goalId: "goal-1",
			sequence: 1,
			timestamp: 100,
			activeElapsedMs: 0,
			goalText: "  exact\ntext  ",
			creationAnchorEntryId: "anchor-1",
		});
		expect(created.goalText).toBe("  exact\ntext  ");
		expect(created.goalSummary).toBe("exact text");
		expect(created.createdAt).toBe(100);

		const evaluation = createGoalEvaluationEntry({
			ownerSessionId: "session-1",
			goalId: "goal-1",
			sequence: 4,
			timestamp: 140,
			activeElapsedMs: 40,
			evaluationId: "evaluation-1",
			evaluationNumber: 1,
			evaluationAttemptId: "attempt-1",
			precedingMainRunId: "run-1",
			report: {
				decision: "complete",
				progress: "done",
				reason: "verified",
				next_action: null,
				evidence: ["tests pass"],
			},
		});
		expect(evaluation.report.decision).toBe("complete");
		expect(Object.isFrozen(evaluation)).toBe(true);
	});

	it("accumulates only an explicit monotonic active segment", () => {
		const running = beginActiveElapsed(1_000, 50);
		expect(readActiveElapsed(running, 275)).toBe(1_225);
		const folded = foldActiveElapsed(running, 275);
		expect(folded).toEqual({ activeElapsedMs: 1_225, segmentStartedAt: null });
		expect(readActiveElapsed(folded, 9_999)).toBe(1_225);
		expect(readActiveElapsed(running, 25)).toBe(1_000);
	});
});
