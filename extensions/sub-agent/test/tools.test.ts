import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { SubagentManager } from "../src/runtime.js";
import { registerParentTools } from "../src/tools.js";

interface CapturedTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly promptGuidelines?: readonly string[];
	readonly parameters: unknown;
	execute(
		toolCallId: string,
		parameters: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}

function toolAt(tools: readonly CapturedTool[], index: number): CapturedTool {
	const tool = tools[index];
	if (tool === undefined) throw new Error(`missing tool at ${index}`);
	return tool;
}

function captureTools(manager: SubagentManager): CapturedTool[] {
	const tools: CapturedTool[] = [];
	registerParentTools(
		{ registerTool: (tool: unknown) => tools.push(tool as CapturedTool) },
		{ manager: () => manager },
		DEFAULT_CONFIG,
	);
	return tools;
}

function context(mode: ExtensionContext["mode"]): ExtensionContext {
	return { mode, hasUI: mode === "tui" || mode === "rpc" } as unknown as ExtensionContext;
}

function text(result: { content: Array<{ type: "text"; text: string }> }): string {
	return result.content.map((block) => block.text).join("");
}

describe("sub-agent v2 parent tools", () => {
	it("registers the five dsh-aligned tools", () => {
		const manager = {} as SubagentManager;
		expect(captureTools(manager).map((tool) => tool.name)).toEqual([
			"subagent",
			"subagent_fork",
			"send_message",
			"interrupt_agent",
			"list_agents",
		]);
	});

	it("adds the dsh background guideline only on continuable delegation tools", () => {
		const tools = captureTools({} as SubagentManager);
		const subagent = toolAt(tools, 0);
		const fork = toolAt(tools, 1);
		expect(subagent.promptGuidelines).toEqual([
			"Use subagent in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. " +
				"Set `run_in_background: false` only when your next action depends on that subagent's result. " +
				"When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.",
		]);
		expect(fork.promptGuidelines).toBeUndefined();
		expect(toolAt(tools, 2).promptGuidelines).toBeUndefined();
	});

	it("defaults continuable tools to background and supports foreground override", async () => {
		const manager = {
			start: vi.fn(async (_policy, _label, _prompt, runInBackground: boolean) =>
				runInBackground
					? { childId: "child-1", foreground: false }
					: { childId: "child-2", foreground: true, output: "final" },
			),
		} as unknown as SubagentManager;
		const subagent = toolAt(captureTools(manager), 0);

		const background = await subagent.execute(
			"c1",
			{ description: "d", prompt: "p" } as never,
			undefined,
			undefined,
			context("tui"),
		);
		expect(text(background)).toBe("started subagent child-1");

		const foreground = await subagent.execute(
			"c2",
			{ description: "d", prompt: "p", run_in_background: false } as never,
			undefined,
			undefined,
			context("tui"),
		);
		expect(text(foreground)).toBe("final");
	});

	it("rejects background subagent in print mode", async () => {
		const manager = {} as SubagentManager;
		const subagent = toolAt(captureTools(manager), 0);
		await expect(
			subagent.execute("c1", { description: "d", prompt: "p" } as never, undefined, undefined, context("print")),
		).rejects.toThrow("SUBAGENT_UNSUPPORTED_MODE");
	});

	it("keeps one-shot fork foreground by default", async () => {
		const manager = {
			start: vi.fn(async (_policy, _label, _prompt, runInBackground: boolean) => {
				if (runInBackground) throw new Error("delegation tool subagent_fork does not support background one-shot jobs");
				return { childId: "fork-1", foreground: true, output: "forked" };
			}),
		} as unknown as SubagentManager;
		const fork = toolAt(captureTools(manager), 1);

		await expect(
			fork.execute(
				"c1",
				{ description: "d", prompt: "p", run_in_background: true } as never,
				undefined,
				undefined,
				context("tui"),
			),
		).rejects.toThrow("does not support background one-shot jobs");

		const result = await fork.execute(
			"c2",
			{ description: "d", prompt: "p" } as never,
			undefined,
			undefined,
			context("tui"),
		);
		expect(text(result)).toBe("forked");
	});

	it("routes control tools through the manager", async () => {
		const manager = {
			sendMessage: vi.fn(async () => "message queued as the next turn for subagent child-1"),
			interrupt: vi.fn(),
			list: vi.fn(() => [{ childId: "child-1", label: "worker", status: "ready", parentSessionId: "root", depth: 1 }]),
		} as unknown as SubagentManager;
		const tools = captureTools(manager);
		const send = toolAt(tools, 2);
		const interrupt = toolAt(tools, 3);
		const list = toolAt(tools, 4);

		const sent = await send.execute(
			"c1",
			{ subagent_id: "child-1", message: "more" } as never,
			undefined,
			undefined,
			context("tui"),
		);
		expect(text(sent)).toContain("message queued");

		const interrupted = await interrupt.execute(
			"c2",
			{ agent_id: "child-1" } as never,
			undefined,
			undefined,
			context("tui"),
		);
		expect(text(interrupted)).toBe("interrupt requested for agent child-1");

		const listed = await list.execute("c3", { scope: "children" } as never, undefined, undefined, context("tui"));
		expect(text(listed)).toContain("child-1 [ready]");
	});
});
