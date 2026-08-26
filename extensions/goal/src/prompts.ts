import type { GoalView } from "./domain.js";

export function goalPolicyGuideline(blockedAfterConsecutiveRounds: number): string {
	return (
		"Use goal tools only for a goal the user explicitly created or explicitly asked the model to create or use. " +
		"Never call create_goal merely because a request seems long-running, complex, multi-step, or suitable for autonomous rounds. " +
		"create_goal is allowed only when the current direct human request explicitly asks to use Goal; do not infer goal intent. " +
		"The /goal command is the user's direct non-model path. Call get_goal before update_goal and copy its " +
		"exact goal_id and revision. After session resume or fork, an active goal is disarmed: when " +
		"a human asks to continue or resume in any wording or language, use update_goal action " +
		"resume to rearm it. Mark complete only when the objective is actually achieved. Mark " +
		`blocked only after the same blocking condition persists for at least ${blockedAfterConsecutiveRounds} ` +
		"consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, " +
		"or useful remaining work is not blocked."
	);
}

export function renderGoalRoundPrompt(goal: GoalView, round: number): string {
	return (
		"<goal_round>\n" +
		`Objective: ${JSON.stringify(goal.objective)}\n` +
		`Round: ${round}/${goal.maxGoalRounds}\n\n` +
		"Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; " +
		"inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, " +
		"gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. " +
		"Follow the configured goal-tool policy before reporting a blocker.\n" +
		"</goal_round>"
	);
}
