import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GoalError, type GoalView } from "./domain.js";
import type { GoalService } from "./service.js";

const USAGE = "Usage: /goal [<objective>|clear|edit <objective>|pause|resume]";

function commandHint(goal: GoalView): string {
	if (goal.phase === "active") {
		return goal.activation === "armed"
			? "/goal edit <objective>, /goal pause, /goal clear"
			: "/goal edit <objective>, /goal resume, /goal clear";
	}
	if (goal.phase === "complete") return "/goal <objective>, /goal clear";
	return "/goal edit <objective>, /goal resume, /goal clear";
}

export function renderGoalCommand(goal: GoalView, title = "Goal"): string {
	const blocker =
		goal.blockedReason === undefined ? [] : [`Blocker: ${goal.blockedReason.code}: ${goal.blockedReason.message}`];
	return [
		title,
		`Status: ${goal.phase}`,
		...blocker,
		`Objective: ${goal.objective}`,
		`Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
		`Activation: ${goal.activation}`,
		"",
		`Commands: ${commandHint(goal)}`,
	].join("\n");
}

export function executeGoalCommand(service: GoalService, context: ExtensionContext, rawInput: string): string {
	const input = rawInput.trim();
	const control = input.toLowerCase();
	try {
		const current = service.get(context);
		if (input.length === 0) {
			return current === undefined ? `No goal is currently set.\n${USAGE}` : renderGoalCommand(current);
		}
		if (control === "clear") {
			if (current === undefined) return "No goal to clear.";
			service.clear(context, { id: current.id, revision: current.revision });
			return "Goal cleared.";
		}
		if (control === "pause") {
			if (current === undefined) return `No goal is currently set; /goal pause requires one. ${USAGE}`;
			return renderGoalCommand(service.pause(context, { id: current.id, revision: current.revision }), "Goal paused");
		}
		if (control === "resume") {
			if (current === undefined) return `No goal is currently set; /goal resume requires one. ${USAGE}`;
			return renderGoalCommand(service.resume(context, { id: current.id, revision: current.revision }), "Goal resumed");
		}
		if (control === "edit") return `Goal editing requires a replacement objective.\n${USAGE}`;
		if (/^edit\s+/iu.test(input)) {
			const objective = input.slice(4).trim();
			if (current === undefined) return `No goal is currently set; /goal edit requires one. ${USAGE}`;
			if (current.phase === "complete") {
				return renderGoalCommand(service.create(context, objective), "Goal created");
			}
			return renderGoalCommand(
				service.edit(context, { id: current.id, revision: current.revision }, objective),
				"Goal updated",
			);
		}
		if (current !== undefined && current.phase !== "complete") {
			return `A goal is already ${current.phase}. Use /goal edit <objective> to change it or /goal clear before replacing it.`;
		}
		return renderGoalCommand(service.create(context, input), "Goal created");
	} catch (error) {
		if (error instanceof GoalError) {
			return "The goal command is not valid for the current state. Run /goal to view available commands.";
		}
		throw error;
	}
}
