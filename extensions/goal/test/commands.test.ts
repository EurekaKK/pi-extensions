import { describe, expect, it } from "vitest";
import { parseGoalCommand } from "../src/commands.js";
import { GOAL_COMMAND_USAGE } from "../src/constants.js";

describe("parseGoalCommand", () => {
	it.each([
		["", "create"],
		["  \n", "create"],
		["resume", "resume"],
		["  resume  ", "resume"],
		["cancel", "cancel"],
	] as const)("maps %j to %s", (input, command) => {
		expect(parseGoalCommand(input)).toEqual({ ok: true, command });
	});

	it.each(["status", "pause", "create something", "resume now", "cancel now"])(
		"rejects unsupported arguments %j with the fixed usage",
		(input) => {
			expect(parseGoalCommand(input)).toEqual({ ok: false, message: GOAL_COMMAND_USAGE });
		},
	);
});
