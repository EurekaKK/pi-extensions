import { describe, expect, it } from "vitest";
import {
	buildActiveGoalContract,
	buildEvaluatorSystemPrompt,
	buildGoalContinuationKickoffMessage,
	buildGoalEvaluationKickoffMessage,
	buildGoalEvaluationMessage,
	GOAL_CONTINUATION_MESSAGE,
	GOAL_EVALUATOR_CORRECTION_PROMPT,
} from "../src/prompts.js";

describe("goal prompt contracts", () => {
	it("builds the exact hidden continuation and an explicit correction prompt", () => {
		expect(GOAL_CONTINUATION_MESSAGE).toBe(`<goal_control version="1">
Continue working on the active immutable goal. This run follows an interruption,
restart, or committed evaluation. Inspect the current project/session state and
prior side effects before retrying any operation. Use the latest evaluation guidance
when it remains valid, but deviate when concrete new evidence supports a better path.
</goal_control>`);
		expect(GOAL_EVALUATOR_CORRECTION_PROMPT).toContain("This is the only format-correction opportunity.");
		expect(GOAL_EVALUATOR_CORRECTION_PROMPT).toContain(
			"exactly these five snake_case fields: decision,\n  progress, reason, next_action, and evidence",
		);
		expect(GOAL_EVALUATOR_CORRECTION_PROMPT).toContain('"decision":"continue"');
		expect(GOAL_EVALUATOR_CORRECTION_PROMPT).toContain('"decision":"complete"');
		expect(GOAL_EVALUATOR_CORRECTION_PROMPT).toContain('"next_action":null');
		expect(GOAL_EVALUATOR_CORRECTION_PROMPT).toContain(
			"Submit exactly one valid goal_submit_evaluation call now. Do not answer in free text.",
		);
	});

	it("JSON-serializes every dynamic active-goal string", () => {
		const result = buildActiveGoalContract({
			goalId: 'goal"1',
			goalText: "first\nsecond",
			creationContextSnapshotPath: "/tmp/a b/context.jsonl",
		});
		expect(result).toContain('goal_id_json: "goal\\"1"');
		expect(result).toContain('goal_text_json: "first\\nsecond"');
		expect(result).toContain('creation_context_snapshot_path_json: "/tmp/a b/context.jsonl"');
		expect(result).toContain("The evaluator decides continue,\n   complete, or fail.");
		expect(result.endsWith("</active_goal_contract>")).toBe(true);
	});

	it("includes count and active duration as soft evaluator pressure signals", () => {
		const result = buildEvaluatorSystemPrompt({
			goalText: "finish safely",
			evaluationNumber: 7,
			activeElapsedMs: 12_345,
			snapshotRoot: "/tmp/snapshot",
		});
		expect(result).toContain('- goal_text_json: "finish safely"');
		expect(result).toContain("- evaluation_number: 7");
		expect(result).toContain("- active_elapsed_ms: 12345");
		expect(result).toContain('- snapshot_root_json: "/tmp/snapshot"');
		expect(result).toContain("Never use count or duration alone as a reason to fail.");
		expect(result).toContain("Valid continue arguments:");
		expect(result).toContain("Valid terminal arguments:");
		expect(result).toContain('not an omitted field and not the\n  string "null"');
		expect(result.endsWith("Call goal_submit_evaluation exactly once.")).toBe(true);
	});

	it("renders safe complete and continue evaluation messages", () => {
		const continued = buildGoalEvaluationMessage({
			evaluationNumber: 3,
			report: {
				decision: "continue",
				progress: "read\nfiles",
				reason: "tests remain",
				next_action: "run the suite",
				evidence: ['file "a"'],
			},
		});
		expect(continued).toContain('<goal_evaluation version="1" number="3">');
		expect(continued).toContain('progress:\n"read\\nfiles"');
		expect(continued).toContain('- "file \\"a\\""');
		expect(continued).toContain("Treat next_action as strong route guidance");

		const completed = buildGoalEvaluationMessage({
			evaluationNumber: 4,
			report: {
				decision: "complete",
				progress: "done",
				reason: "verified",
				next_action: null,
				evidence: ["tests pass"],
			},
		});
		expect(completed).toContain("next_action:\nnull");
		expect(completed).not.toContain("Continue the immutable goal");
	});

	it("carries the full immutable contract in every automatic kickoff message", () => {
		const contract = {
			goalId: "goal-1",
			goalText: "ship the verified feature",
			creationContextSnapshotPath: "/tmp/goal/context.jsonl",
		};
		const continuation = buildGoalContinuationKickoffMessage(contract);
		expect(continuation).toContain('<active_goal_contract version="1">');
		expect(continuation).toContain('<goal_control version="1">');

		const evaluation = buildGoalEvaluationKickoffMessage({
			...contract,
			evaluationNumber: 2,
			report: {
				decision: "continue",
				progress: "unit tests pass",
				reason: "manual smoke remains",
				next_action: "run the smoke test",
				evidence: ["npm test passed"],
			},
		});
		expect(evaluation).toContain('<active_goal_contract version="1">');
		expect(evaluation).toContain('<goal_evaluation version="1" number="2">');
		expect(() =>
			buildGoalEvaluationKickoffMessage({
				...contract,
				evaluationNumber: 2,
				report: {
					decision: "complete",
					progress: "done",
					reason: "verified",
					next_action: null,
					evidence: ["smoke passed"],
				},
			}),
		).toThrow("Only a continue evaluation");
	});
});
