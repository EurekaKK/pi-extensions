import { describe, expect, it } from "vitest";
import { goalPolicyGuideline } from "../src/prompts.js";

describe("goal policy guideline", () => {
	it("uses the deployment blocked threshold and excludes difficulty as blocked", () => {
		expect(goalPolicyGuideline(3)).toBe(
			"Use goal tools only for a goal the user explicitly created or explicitly asked the model to create or use. " +
				"Never call create_goal merely because a request seems long-running, complex, multi-step, or suitable for autonomous rounds. " +
				"create_goal is allowed only when the current direct human request explicitly asks to use Goal; do not infer goal intent. " +
				"The /goal command is the user's direct non-model path. Call get_goal before update_goal and copy its " +
				"exact goal_id and revision. After session resume or fork, an active goal is disarmed: when " +
				"a human asks to continue or resume in any wording or language, use update_goal action " +
				"resume to rearm it. Mark complete only when the objective is actually achieved. Mark " +
				"blocked only after the same blocking condition persists for at least 3 " +
				"consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, " +
				"or useful remaining work is not blocked.",
		);
		expect(goalPolicyGuideline(5)).toContain("at least 5 consecutive goal rounds");
		expect(goalPolicyGuideline(5)).toContain("do not infer goal intent");
		expect(goalPolicyGuideline(5)).not.toContain("configured number");
	});
});
