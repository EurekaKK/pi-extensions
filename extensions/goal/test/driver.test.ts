import { describe, expect, it } from "vitest";
import { GOAL_ROUND_ENTRY_TYPE, GOAL_ROUND_MESSAGE_TYPE } from "../src/constants.js";
import { GoalDriver } from "../src/driver.js";
import { GoalService } from "../src/service.js";
import { FakePiHost } from "./fake-pi-host.js";

interface DriverFixture {
	readonly host: FakePiHost;
	readonly service: GoalService;
	readonly driver: GoalDriver;
	settledCount(): number;
}

function makeDriver(maxRounds = 256): DriverFixture {
	const host = new FakePiHost();
	let settled = 0;
	const service = new GoalService(host.api, maxRounds, () => 10);
	const driver = new GoalDriver(host.api, service, {
		onSettled: () => {
			settled += 1;
		},
	});
	return { host, service, driver, settledCount: () => settled };
}

describe("Goal Round Driver", () => {
	it("admits a round and sends a goal_round message when a run settles", async () => {
		const f = makeDriver();
		f.service.create(f.host.context, "ship");

		await f.host.emit("agent_settled", { type: "agent_settled" });

		expect(f.host.appendedEntries.some((entry) => entry.customType === GOAL_ROUND_ENTRY_TYPE)).toBe(true);
		expect(f.host.sentMessages).toHaveLength(1);
		const first = f.host.sentMessages[0];
		if (first === undefined) throw new Error("missing sent message");
		expect((first.message as { customType: string }).customType).toBe(GOAL_ROUND_MESSAGE_TYPE);
		expect(first?.options).toMatchObject({ triggerTurn: true });
		expect(f.service.get(f.host.context)?.roundsStarted).toBe(1);
		expect(f.settledCount()).toBe(1);
	});

	it("blocks round-limit when the cap is exhausted", async () => {
		const f = makeDriver(1);
		f.service.create(f.host.context, "ship");

		await f.host.emit("agent_settled", { type: "agent_settled" });
		await f.host.emit("agent_settled", { type: "agent_settled" });

		const goal = f.service.get(f.host.context);
		expect(goal?.phase).toBe("blocked");
		expect(goal?.blockedReason?.code).toBe("round-limit");
	});

	it("blocks queue-failed when sending the round message throws", async () => {
		const f = makeDriver();
		f.service.create(f.host.context, "ship");
		f.host.failSend = true;

		await f.host.emit("agent_settled", { type: "agent_settled" });

		const goal = f.service.get(f.host.context);
		expect(goal?.phase).toBe("blocked");
		expect(goal?.blockedReason?.code).toBe("queue-failed");
	});

	it("does not drive a disarmed active goal but still reports settlement", async () => {
		const f = makeDriver();
		f.service.create(f.host.context, "ship");
		f.service.disarm("session-1");

		await f.host.emit("agent_settled", { type: "agent_settled" });

		expect(f.host.sentMessages).toHaveLength(0);
		expect(f.service.get(f.host.context)?.roundsStarted).toBe(0);
		expect(f.settledCount()).toBe(1);
	});

	it("grants direct-human authority to interactive and rpc inputs", async () => {
		const f = makeDriver();

		await f.host.emit("input", { source: "interactive" });
		expect(f.driver.authority(f.host.context)).toEqual({ kind: "direct-human" });

		await f.host.emit("input", { source: "rpc" });
		expect(f.driver.authority(f.host.context)).toEqual({ kind: "direct-human" });
	});

	it("ignores inputs from other sources", async () => {
		const f = makeDriver();

		await f.host.emit("input", { source: "cli" });

		expect(() => f.driver.authority(f.host.context)).toThrowError(/require a direct human turn/);
	});

	it("recognizes a queued goal round on its way back and grants goal-round authority", async () => {
		const f = makeDriver();
		f.service.create(f.host.context, "ship");

		await f.host.emit("agent_settled", { type: "agent_settled" });
		await f.host.emit("message_start", {
			type: "message_start",
			message: {
				role: "custom",
				customType: GOAL_ROUND_MESSAGE_TYPE,
				content: "<goal_round> continuation",
				timestamp: 1,
			},
		});

		const authority = f.driver.authority(f.host.context);
		expect(authority).toMatchObject({ kind: "goal-round" });
		if (authority.kind === "goal-round") expect(authority.goal.roundsStarted).toBe(1);
	});

	it("returns authority to the human after an ordinary message", async () => {
		const f = makeDriver();
		f.service.create(f.host.context, "ship");
		await f.host.emit("agent_settled", { type: "agent_settled" });
		await f.host.emit("message_start", {
			message: { role: "custom", customType: GOAL_ROUND_MESSAGE_TYPE, content: "<goal_round> continuation" },
		});

		await f.host.emit("message_start", { message: { role: "user", content: "stop, I will take over" } });

		expect(f.driver.authority(f.host.context)).toEqual({ kind: "direct-human" });
	});

	it("denies authority when neither a human turn nor the current round is active", async () => {
		const f = makeDriver();
		f.service.create(f.host.context, "ship");

		expect(() => f.driver.authority(f.host.context)).toThrowError(/require a direct human turn/);
	});

	it("resets turn state on session boundaries", async () => {
		const f = makeDriver();
		f.service.create(f.host.context, "ship");
		await f.host.emit("agent_settled", { type: "agent_settled" });
		await f.host.emit("message_start", {
			message: { role: "custom", customType: GOAL_ROUND_MESSAGE_TYPE, content: "<goal_round> continuation" },
		});
		expect(f.driver.authority(f.host.context)).toMatchObject({ kind: "goal-round" });

		await f.host.emit("session_start", { type: "session_start" });

		expect(() => f.driver.authority(f.host.context)).toThrowError(/require a direct human turn/);
	});

	it("disarms the goal when a run ends truncated or errored", async () => {
		const f = makeDriver();
		f.service.create(f.host.context, "ship");

		await f.host.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "length", content: [], timestamp: 1 }],
		});
		await f.host.emit("agent_settled", { type: "agent_settled" });

		expect(f.service.activation("session-1")).toBe("disarmed");
		expect(f.host.sentMessages).toHaveLength(0);
	});
});
