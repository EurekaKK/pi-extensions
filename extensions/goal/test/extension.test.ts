import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CapturedTool, FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { GOAL_ROUND_MESSAGE_TYPE, GOAL_STATUS_KEY } from "../src/constants.js";
import { registerGoalExtension } from "../src/index.js";

interface GoalDetails {
	readonly goal: { readonly id: string; readonly revision: number; readonly phase: string };
	readonly activation: string;
}

class GoalExtensionHarness {
	readonly host = new FakePiHost({ mode: "tui", hasUI: true });
	readonly context: ExtensionContext;

	constructor() {
		this.context = this.host.context;
		registerGoalExtension(this.host.api, DEFAULT_CONFIG);
	}

	async emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		await this.host.emit(event, payload);
	}

	tool(name: string): CapturedTool {
		const tool = this.host.tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`missing tool ${name}`);
		return tool;
	}
}

describe("goal v2 extension", () => {
	it("projects a persistent goal widget immediately after create_goal", async () => {
		const harness = new GoalExtensionHarness();
		await harness.emit("session_start");
		await harness.emit("input", { source: "interactive" });

		await harness
			.tool("create_goal")
			.execute("create-1", { objective: "Ship readable progress" } as never, undefined, undefined, harness.context);

		expect(harness.host.ui.setWidget).toHaveBeenLastCalledWith(GOAL_STATUS_KEY, expect.anything(), {
			placement: "aboveEditor",
		});
	});

	it("allows an automatic goal round to complete and disarm its goal", async () => {
		const harness = new GoalExtensionHarness();
		await harness.emit("session_start");
		await harness.emit("input", { source: "interactive" });
		await harness
			.tool("create_goal")
			.execute("create-1", { objective: "Finish autonomously" } as never, undefined, undefined, harness.context);

		await harness.emit("agent_settled");
		const round = harness.host.sentMessages[0]?.message;
		expect(round?.customType).toBe(GOAL_ROUND_MESSAGE_TYPE);
		if (round === undefined) throw new Error("missing queued goal round");
		await harness.emit("message_start", {
			type: "message_start",
			message: { role: "custom", ...round, timestamp: Date.now() },
		});

		const current = (
			await harness.tool("get_goal").execute("get-1", {} as never, undefined, undefined, harness.context)
		).details as GoalDetails;
		await harness
			.tool("update_goal")
			.execute(
				"complete-1",
				{ goal_id: current.goal.id, revision: current.goal.revision, action: "complete" } as never,
				undefined,
				undefined,
				harness.context,
			);
		const after = (await harness.tool("get_goal").execute("get-2", {} as never, undefined, undefined, harness.context))
			.details as GoalDetails;

		expect(after.goal.phase).toBe("complete");
		expect(after.activation).toBe("disarmed");
	});
});
