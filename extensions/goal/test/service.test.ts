import { describe, expect, it } from "vitest";
import { GOAL_CHANGE_ENTRY_TYPE, GOAL_ROUND_ENTRY_TYPE } from "../src/constants.js";
import { GoalService } from "../src/service.js";

class Harness {
	readonly entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
	readonly service: GoalService;

	constructor(defaultMaxGoalRounds = 256) {
		this.service = new GoalService(
			{
				appendEntry: (customType, data) => {
					this.entries.push({ type: "custom", customType, data });
				},
			},
			defaultMaxGoalRounds,
			() => this.entries.length + 10,
		);
	}

	context() {
		const entries = this.entries;
		return {
			sessionManager: {
				getSessionId: () => "session-1",
				getBranch: () => entries,
			},
		} as never;
	}
}

describe("GoalService v2", () => {
	it("creates, edits, pauses, resumes, blocks and clears with CAS", () => {
		const h = new Harness();
		const created = h.service.create(h.context(), "  ship it  ");
		expect(created.objective).toBe("ship it");
		expect(created.activation).toBe("armed");

		const edited = h.service.edit(h.context(), created, "ship it fast");
		expect(edited.revision).toBe(2);
		expect(edited.objective).toBe("ship it fast");

		const paused = h.service.pause(h.context(), edited);
		expect(paused.phase).toBe("paused");
		expect(paused.activation).toBe("disarmed");

		const resumed = h.service.resume(h.context(), paused);
		expect(resumed.phase).toBe("active");
		expect(resumed.activation).toBe("armed");

		const blocked = h.service.block(h.context(), resumed, { code: "model-reported", message: "blocked reason" });
		expect(blocked.phase).toBe("blocked");
		expect(blocked.blockedReason?.code).toBe("model-reported");

		h.service.clear(h.context(), blocked);
		expect(h.service.get(h.context())).toBeUndefined();
	});

	it("rejects stale revisions and invalid resume when exhausted", () => {
		const h = new Harness(1);
		const created = h.service.create(h.context(), "ship it");
		h.service.admitRound(h.context(), created, 1);
		const current = h.service.get(h.context());
		if (current === undefined) throw new Error("missing goal");
		h.service.disarm("session-1");
		expect(() => h.service.resume(h.context(), current)).toThrow(/exhausted/);
	});

	it("restores state from persisted entries and defaults to disarmed", () => {
		const h = new Harness();
		h.service.create(h.context(), "ship it");
		h.service.disarm("session-1");
		const restored = h.service.get(h.context());
		expect(restored?.phase).toBe("active");
		expect(restored?.activation).toBe("disarmed");
		expect(h.entries.some((entry) => entry.customType === GOAL_CHANGE_ENTRY_TYPE)).toBe(true);
		expect(h.entries.some((entry) => entry.customType === GOAL_ROUND_ENTRY_TYPE)).toBe(false);
	});
});
