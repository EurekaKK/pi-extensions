import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { type GoalToolRuntime, registerGoalTools } from "../src/tools.js";

interface CapturedTool {
	readonly name: string;
	readonly description?: string;
	readonly promptGuidelines?: readonly string[];
	execute(
		toolCallId: string,
		parameters: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}

function capture(runtime: GoalToolRuntime): CapturedTool[] {
	const tools: CapturedTool[] = [];
	registerGoalTools({ registerTool: (tool: unknown) => tools.push(tool as CapturedTool) }, runtime);
	return tools;
}

function toolAt(tools: readonly CapturedTool[], index: number): CapturedTool {
	const tool = tools[index];
	if (tool === undefined) throw new Error(`missing tool at ${index}`);
	return tool;
}

const context = { sessionManager: { getSessionId: () => "s", getBranch: () => [] } } as unknown as ExtensionContext;

describe("goal v2 model tools", () => {
	it("registers get_goal, create_goal and update_goal", () => {
		const runtime = {
			service: {},
			config: DEFAULT_CONFIG,
			authority: () => ({ kind: "direct-human" }),
		} as unknown as GoalToolRuntime;
		expect(capture(runtime).map((tool) => tool.name)).toEqual(["get_goal", "create_goal", "update_goal"]);
	});

	it("puts the configured blocked threshold on every goal tool guideline", () => {
		const runtime = {
			service: {},
			config: { ...DEFAULT_CONFIG, blockedAfterConsecutiveRounds: 4 },
			authority: () => ({ kind: "direct-human" }),
		} as unknown as GoalToolRuntime;
		const guidelines = capture(runtime).map((tool) => tool.promptGuidelines);
		expect(guidelines).toHaveLength(3);
		expect(new Set(guidelines.map((item) => item?.join("\n"))).size).toBe(1);
		expect(guidelines[0]?.join("")).toContain("at least 4 consecutive goal rounds");
		expect(guidelines[0]?.join("")).toContain("useful remaining work is not blocked");
		expect(guidelines[0]?.join("")).toContain("Never call create_goal merely because a request seems long-running");
	});

	it("describes create_goal as explicit user opt-in instead of inferred intent", () => {
		const runtime = {
			service: {},
			config: DEFAULT_CONFIG,
			authority: () => ({ kind: "direct-human" }),
		} as unknown as GoalToolRuntime;
		const create = toolAt(capture(runtime), 1);

		expect(create.description).toContain("explicitly asks to create or use Goal");
		expect(create.description).toContain("Never infer Goal intent");
		expect(create.description).toContain("/goal commands are handled directly");
	});

	it("create_goal requires direct-human authority", async () => {
		const runtime = {
			service: {},
			config: DEFAULT_CONFIG,
			authority: vi.fn(() => {
				throw new Error("this goal operation requires a direct human turn");
			}),
		} as unknown as GoalToolRuntime;
		const create = toolAt(capture(runtime), 1);
		let message = "";
		try {
			await create.execute("c", { objective: "ship" } as never, undefined, undefined, context);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("direct human turn");
		expect(runtime.authority).toHaveBeenCalled();
	});

	it("update_goal blocked enforces consecutive round threshold", async () => {
		const service = { block: vi.fn() };
		const runtime = {
			service,
			config: DEFAULT_CONFIG,
			authority: () => ({
				kind: "goal-round",
				goal: { id: "g", revision: 1, roundsStarted: 1 },
			}),
		} as unknown as GoalToolRuntime;
		const update = toolAt(capture(runtime), 2);
		let message = "";
		try {
			await update.execute(
				"c",
				{ goal_id: "g", revision: 1, action: "blocked", blocked_reason: "stuck" } as never,
				undefined,
				undefined,
				context,
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("blocked requires at least 3 consecutive goal rounds");
		expect(service.block).not.toHaveBeenCalled();
	});
});
