import { GOAL_COMMAND_USAGE } from "./constants.js";

export type GoalCommand = "create" | "resume" | "cancel";

export type GoalCommandParseResult =
	| { readonly ok: true; readonly command: GoalCommand }
	| { readonly ok: false; readonly message: typeof GOAL_COMMAND_USAGE };

export function parseGoalCommand(argumentsText: string): GoalCommandParseResult {
	const normalized = argumentsText.trim();
	if (normalized.length === 0) return { ok: true, command: "create" };
	if (normalized === "resume") return { ok: true, command: "resume" };
	if (normalized === "cancel") return { ok: true, command: "cancel" };
	return { ok: false, message: GOAL_COMMAND_USAGE };
}
