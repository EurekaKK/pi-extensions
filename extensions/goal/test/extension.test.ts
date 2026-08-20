import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { GOAL_ROUND_MESSAGE_TYPE, GOAL_STATUS_KEY } from "../src/constants.js";
import { registerGoalExtension } from "../src/index.js";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown | Promise<unknown>;

interface CapturedTool {
	readonly name: string;
	execute(
		toolCallId: string,
		parameters: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<{ details?: unknown }>;
}

interface SentMessage {
	readonly customType: string;
	readonly content: unknown;
	readonly display: boolean;
	readonly details?: unknown;
}

interface GoalDetails {
	readonly goal: { readonly id: string; readonly revision: number; readonly phase: string };
	readonly activation: string;
}

class GoalExtensionHarness {
	readonly entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	readonly tools: CapturedTool[] = [];
	readonly setStatus = vi.fn();
	readonly setWidget = vi.fn();
	readonly sentMessages: SentMessage[] = [];
	readonly context: ExtensionContext;
	readonly api: ExtensionAPI;
	#handlers = new Map<string, Handler[]>();

	constructor() {
		this.context = {
			mode: "tui",
			hasUI: true,
			ui: { notify: vi.fn(), setStatus: this.setStatus, setWidget: this.setWidget },
			sessionManager: {
				getSessionId: () => "session-1",
				getBranch: () => this.entries,
			},
		} as unknown as ExtensionContext;
		this.api = {
			on: (event: string, handler: Handler) => {
				const handlers = this.#handlers.get(event) ?? [];
				handlers.push(handler);
				this.#handlers.set(event, handlers);
			},
			registerCommand: vi.fn(),
			registerTool: (tool: CapturedTool) => this.tools.push(tool),
			appendEntry: (customType: string, data: unknown) => {
				this.entries.push({ type: "custom", customType, data });
			},
			sendMessage: (message: SentMessage) => {
				this.sentMessages.push(message);
			},
		} as unknown as ExtensionAPI;
		registerGoalExtension(this.api, DEFAULT_CONFIG);
	}

	async emit(event: string, payload: Record<string, unknown>): Promise<void> {
		for (const handler of this.#handlers.get(event) ?? []) await handler(payload, this.context);
	}

	tool(name: string): CapturedTool {
		const tool = this.tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`missing tool ${name}`);
		return tool;
	}
}

describe("goal v2 extension", () => {
	it("projects a persistent goal widget immediately after create_goal", async () => {
		const harness = new GoalExtensionHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("input", { type: "input", source: "interactive" });

		await harness
			.tool("create_goal")
			.execute("create-1", { objective: "Ship readable progress" } as never, undefined, undefined, harness.context);

		expect(harness.setWidget).toHaveBeenLastCalledWith(GOAL_STATUS_KEY, expect.anything(), {
			placement: "aboveEditor",
		});
	});

	it("allows an automatic goal round to complete and disarm its goal", async () => {
		const harness = new GoalExtensionHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("input", { type: "input", source: "interactive" });
		await harness
			.tool("create_goal")
			.execute("create-1", { objective: "Finish autonomously" } as never, undefined, undefined, harness.context);

		await harness.emit("agent_settled", { type: "agent_settled" });
		const round = harness.sentMessages[0];
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
