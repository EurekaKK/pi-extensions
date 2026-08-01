import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { GOAL_COMMAND_USAGE, GOAL_ERROR_MESSAGE_TYPE, GOAL_EVALUATION_MESSAGE_TYPE } from "../src/constants.js";
import { registerGoalExtension } from "../src/index.js";

type Hook = (event: unknown, context: unknown) => unknown;

interface CapturedCommand {
	readonly description?: string;
	handler(args: string, context: ExtensionCommandContext): Promise<void> | void;
}

class RegistrationHarness {
	readonly commands = new Map<string, CapturedCommand>();
	readonly messageRenderers = new Map<string, MessageRenderer<unknown>>();
	readonly entryRenderers = new Map<string, EntryRenderer<unknown>>();
	readonly hooks = new Map<string, Hook[]>();
	readonly tools: string[] = [];
	readonly api: ExtensionAPI;

	constructor() {
		this.api = {
			registerCommand: (name: string, command: CapturedCommand) => this.commands.set(name, command),
			registerMessageRenderer: (customType: string, renderer: MessageRenderer<unknown>) =>
				this.messageRenderers.set(customType, renderer),
			registerEntryRenderer: (customType: string, renderer: EntryRenderer<unknown>) =>
				this.entryRenderers.set(customType, renderer),
			registerTool: (tool: { name: string }) => this.tools.push(tool.name),
			on: (event: string, handler: Hook) => {
				const handlers = this.hooks.get(event) ?? [];
				handlers.push(handler);
				this.hooks.set(event, handlers);
			},
		} as unknown as ExtensionAPI;
	}
}

function render(component: { render(width: number): string[] }): string {
	return component
		.render(40_000)
		.map((line) => line.trimEnd())
		.join("\n");
}

const theme = {
	fg: (_color: string, text: string) => text,
};

describe("goal extension registration", () => {
	it("registers one public command, two renderers, lifecycle hooks, and no main-agent tools", () => {
		const harness = new RegistrationHarness();
		registerGoalExtension(harness.api);

		expect([...harness.commands.keys()]).toEqual(["goal"]);
		expect([...harness.messageRenderers.keys()]).toEqual([GOAL_EVALUATION_MESSAGE_TYPE]);
		expect([...harness.entryRenderers.keys()]).toEqual([GOAL_ERROR_MESSAGE_TYPE]);
		expect(harness.tools).toEqual([]);
		expect([...harness.hooks.keys()].sort()).toEqual(
			[
				"agent_end",
				"agent_settled",
				"agent_start",
				"before_agent_start",
				"input",
				"session_before_fork",
				"session_before_switch",
				"session_before_tree",
				"session_shutdown",
				"session_start",
				"session_tree",
				"tool_call",
			].sort(),
		);
	});

	it("returns the fixed usage for every unsupported /goal argument", async () => {
		const harness = new RegistrationHarness();
		registerGoalExtension(harness.api);
		const notify = vi.fn();
		const context = { ui: { notify } } as unknown as ExtensionCommandContext;

		await harness.commands.get("goal")?.handler("status now", context);

		expect(notify).toHaveBeenCalledWith(GOAL_COMMAND_USAGE, "error");
	});

	it("renders accepted evaluations in collapsed and expanded form", () => {
		const harness = new RegistrationHarness();
		registerGoalExtension(harness.api);
		const renderer = harness.messageRenderers.get(GOAL_EVALUATION_MESSAGE_TYPE);
		if (renderer === undefined) throw new Error("Missing evaluation renderer.");
		const details = {
			schemaVersion: 1,
			ownerSessionId: "session",
			goalId: "goal",
			evaluationId: "evaluation",
			evaluationNumber: 2,
			report: {
				decision: "continue",
				progress: "implemented",
				reason: "verification remains",
				next_action: "run tests",
				evidence: ["source diff"],
			},
		};

		const collapsed = renderer(
			{ customType: GOAL_EVALUATION_MESSAGE_TYPE, content: "ignored", display: true, details } as never,
			{ expanded: false, outputPad: 0 },
			theme as never,
		);
		const expanded = renderer(
			{ customType: GOAL_EVALUATION_MESSAGE_TYPE, content: "ignored", display: true, details } as never,
			{ expanded: true, outputPad: 0 },
			theme as never,
		);
		if (collapsed === undefined || expanded === undefined)
			throw new Error("Evaluation renderer returned no component.");

		expect(render(collapsed)).toBe("Evaluation #2: continue — verification remains");
		expect(render(expanded)).toContain("Next action:\nrun tests");
	});

	it("renders sanitized persistent error details", () => {
		const harness = new RegistrationHarness();
		registerGoalExtension(harness.api);
		const renderer = harness.entryRenderers.get(GOAL_ERROR_MESSAGE_TYPE);
		if (renderer === undefined) throw new Error("Missing error renderer.");
		const component = renderer(
			{
				type: "custom",
				customType: GOAL_ERROR_MESSAGE_TYPE,
				data: {
					schemaVersion: 1,
					ownerSessionId: "session",
					goalId: "goal",
					phase: "evaluation",
					message: "provider unavailable",
					timestamp: 1,
				},
			} as never,
			{ expanded: true } as never,
			theme as never,
		);
		if (component === undefined) throw new Error("Error renderer rejected valid details.");

		expect(render(component)).toContain("Goal evaluation error\n\nprovider unavailable");
		expect(render(component)).toContain("/goal resume");
	});
});
