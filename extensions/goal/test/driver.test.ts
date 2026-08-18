import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { GOAL_ROUND_ENTRY_TYPE, GOAL_ROUND_MESSAGE_TYPE } from "../src/constants.js";
import { GoalDriver } from "../src/driver.js";
import { GoalService } from "../src/service.js";

class Harness {
	readonly entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
	readonly sent: Array<Record<string, unknown>> = [];
	readonly service: GoalService;
	readonly driver: GoalDriver;
	failSend = false;

	constructor(maxRounds = 256) {
		const pi = {
			appendEntry: (customType: string, data: unknown) => {
				this.entries.push({ type: "custom", customType, data });
			},
			sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
				if (this.failSend) throw new Error("send failed");
				this.sent.push({ message, options });
			},
		} as unknown as ExtensionAPI;
		this.service = new GoalService(pi, maxRounds, () => this.entries.length + 10);
		this.driver = new GoalDriver(pi, this.service);
	}

	context() {
		const entries = this.entries;
		return {
			mode: "tui",
			hasUI: true,
			sessionManager: { getSessionId: () => "s", getBranch: () => entries },
		} as unknown as ExtensionContext;
	}
}

describe("GoalRoundDriver", () => {
	it("admits a round and sends a goal_round message", async () => {
		const h = new Harness();
		const goal = h.service.create(h.context(), "ship");
		await h.driver.maybeDrive(h.context());

		expect(h.entries.some((entry) => entry.customType === GOAL_ROUND_ENTRY_TYPE)).toBe(true);
		expect(h.sent).toHaveLength(1);
		const first = h.sent[0];
		expect(first).toBeDefined();
		if (first === undefined) throw new Error("missing sent message");
		expect((first.message as { customType: string }).customType).toBe(GOAL_ROUND_MESSAGE_TYPE);
		expect(h.service.get(h.context())?.roundsStarted).toBe(1);
		expect(goal.phase).toBe("active");
	});

	it("blocks round-limit when the cap is exhausted", async () => {
		const h = new Harness(1);
		h.service.create(h.context(), "ship");
		await h.driver.maybeDrive(h.context());
		await h.driver.maybeDrive(h.context());
		const goal = h.service.get(h.context());
		expect(goal?.phase).toBe("blocked");
		expect(goal?.blockedReason?.code).toBe("round-limit");
	});

	it("blocks queue-failed when sendMessage throws", async () => {
		const h = new Harness();
		h.service.create(h.context(), "ship");
		h.failSend = true;
		await h.driver.maybeDrive(h.context());
		const goal = h.service.get(h.context());
		expect(goal?.phase).toBe("blocked");
		expect(goal?.blockedReason?.code).toBe("queue-failed");
	});

	it("does not drive a disarmed active goal", async () => {
		const h = new Harness();
		h.service.create(h.context(), "ship");
		h.service.disarm("s");
		await h.driver.maybeDrive(h.context());
		expect(h.sent).toHaveLength(0);
		expect(h.service.get(h.context())?.roundsStarted).toBe(0);
	});
});
