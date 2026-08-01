import { describe, expect, it } from "vitest";
import { formatGoalElapsed, renderGoalErrorText, renderGoalEvaluationText, renderGoalStatusLine } from "../src/ui.js";

describe("goal UI text", () => {
	it("formats all five fixed-width status lines", () => {
		for (const [status, expected] of [
			["running", "Goal: running     00:00:01  ship release"],
			["evaluating", "Goal: evaluating  00:00:01  ship release"],
			["paused", "Goal: paused      00:00:01  ship release"],
			["failed", "Goal: failed      00:00:01  ship release"],
			["error", "Goal: error       00:00:01  ship release"],
		] as const) {
			expect(renderGoalStatusLine({ status, activeElapsedMs: 1_999, goalSummary: " ship\n release " })).toBe(expected);
		}
	});

	it("allows hours beyond two digits and floors partial seconds", () => {
		expect(formatGoalElapsed(123 * 3_600_000 + 4 * 60_000 + 5_999)).toBe("123:04:05");
	});

	it("follows the supplied expanded state for evaluation text", () => {
		const report = {
			decision: "continue",
			progress: "Parser implemented.",
			reason: "One integration test remains.\nIt is runnable.",
			next_action: "Run the integration test.",
			evidence: ["unit tests pass", "typecheck passes"],
		} as const;
		expect(renderGoalEvaluationText({ evaluationNumber: 3, report, expanded: false })).toBe(
			"Evaluation #3: continue — One integration test remains. It is runnable.",
		);
		expect(renderGoalEvaluationText({ evaluationNumber: 3, report, expanded: true })).toBe(`Evaluation #3: continue

Progress:
Parser implemented.

Reason:
One integration test remains.
It is runnable.

Next action:
Run the integration test.

Evidence:
- unit tests pass
- typecheck passes`);
	});

	it("renders compact and expanded sanitized infrastructure errors", () => {
		expect(
			renderGoalErrorText({ phase: "evaluation", sanitizedMessage: " provider\n unavailable ", expanded: false }),
		).toBe("Goal evaluation error — provider unavailable");
		expect(renderGoalErrorText({ phase: "main", sanitizedMessage: "", expanded: true })).toContain(
			"Unknown infrastructure failure.",
		);
		expect(renderGoalErrorText({ phase: "main", sanitizedMessage: "safe", expanded: true })).toContain("/goal resume");
	});
});
