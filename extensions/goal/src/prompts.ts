import type { GoalView } from "./domain.js";

export function goalPolicyGuideline(blockedAfterConsecutiveRounds: number): string {
	return (
		"Use goal tools for one long-running completion objective in the current session. " +
		"create_goal may infer goal intent from a direct human request in any language; do not " +
		"create a goal for routine single-turn work. Call get_goal before update_goal and copy its " +
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

export function renderGoalStatus(view: GoalView | undefined): string {
	if (view === undefined) return "";
	const reason = view.blockedReason === undefined ? "" : ` · blocked: ${view.blockedReason.code}`;
	return `Goal: ${view.phase}${reason} · round ${view.roundsStarted}/${view.maxGoalRounds} · ${view.activation}`;
}
