import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { executeGoalCommand } from "../src/commands.js";
import { GoalService } from "../src/service.js";

class Harness {
	readonly entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
	readonly service = new GoalService(
		{
			appendEntry: (customType, data) => {
				this.entries.push({ type: "custom", customType, data });
			},
		},
		256,
		() => this.entries.length + 10,
	);

	context() {
		const entries = this.entries;
		return { sessionManager: { getSessionId: () => "s", getBranch: () => entries } } as unknown as ExtensionContext;
	}
}

describe("goal v2 command", () => {
	it("creates, shows, edits, pauses, resumes and clears", () => {
		const h = new Harness();
		const created = executeGoalCommand(h.service, h.context(), "  ship it  ");
		expect(created).toContain("Status: active");
		expect(created).toContain("Objective: ship it");

		const shown = executeGoalCommand(h.service, h.context(), "");
		expect(shown).toContain("Rounds: 0/256");

		const edited = executeGoalCommand(h.service, h.context(), "edit ship it fast");
		expect(edited).toContain("Objective: ship it fast");

		expect(executeGoalCommand(h.service, h.context(), "pause")).toContain("Status: paused");
		expect(executeGoalCommand(h.service, h.context(), "resume")).toContain("Status: active");
		expect(executeGoalCommand(h.service, h.context(), "clear")).toBe("Goal cleared.");
		expect(executeGoalCommand(h.service, h.context(), "")).toContain("No goal is currently set.");
	});

	it("rejects replacement while a non-complete goal exists", () => {
		const h = new Harness();
		executeGoalCommand(h.service, h.context(), "ship it");
		expect(executeGoalCommand(h.service, h.context(), "other objective")).toContain("A goal is already active");
	});
});
