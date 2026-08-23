import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PROGRESS_WIDGET_ATTACH_EVENT, PROGRESS_WIDGET_STATE_EVENT } from "progress-widget-protocol";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { GOAL_STATUS_KEY } from "../src/constants.js";
import { registerGoalExtension } from "../src/index.js";
import { renderGoalRoundMessage } from "../src/message-renderer.js";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

interface RenderableTool {
	readonly name: string;
	execute(
		toolCallId: string,
		parameters: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<{
		readonly content: readonly { readonly type: string; readonly text?: string }[];
		readonly details?: unknown;
	}>;
	renderResult(
		result: {
			readonly content: readonly { readonly type: string; readonly text?: string }[];
			readonly details?: unknown;
		},
		options: { readonly expanded: boolean; readonly isPartial: boolean },
		theme: Theme,
		context: { readonly isError: boolean },
	): { render(width: number): string[] };
}

describe("goal compact UI", () => {
	it("collapses goal round instructions and expands the original content", () => {
		const message = {
			content: '<goal_round>\nObjective: "Ship"\nRound: 2/8\n\nInternal continuation instructions\n</goal_round>',
			details: { round: 2, maxGoalRounds: 8, objective: "Ship" },
		};
		expect(renderGoalRoundMessage(message, { expanded: false, outputPad: 1 }, theme).render(120)).toEqual([
			"Goal round 2/8 · Ship",
		]);
		expect(renderGoalRoundMessage(message, { expanded: true, outputPad: 1 }, theme).render(120).join("\n")).toContain(
			"Internal continuation instructions",
		);
	});

	it("renders semantic goal tool results instead of raw JSON when collapsed", async () => {
		const host = new FakePiHost();
		registerGoalExtension(host.api, DEFAULT_CONFIG);
		await host.emit("session_start");
		await host.emit("input", { source: "interactive" });
		const create = host.tools.find((tool) => tool.name === "create_goal") as unknown as RenderableTool;
		const result = await create.execute("create-1", { objective: "Ship" } as never, undefined, undefined, host.context);
		const collapsed = create
			.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false })
			.render(120)
			.join("\n");
		expect(collapsed).toContain("Goal · active");
		expect(collapsed).toContain("Ship");
		expect(collapsed).not.toContain('{"goal"');
		expect(
			create
				.renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false })
				.render(120)
				.join("\n"),
		).toContain('{"goal"');
		const narrow = create
			.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false })
			.render(20);
		expect(narrow).toHaveLength(2);
		expect(narrow.every((line) => visibleWidth(line) <= 20)).toBe(true);
	});

	it("hands widget ownership to progress-widget and publishes goal snapshots", async () => {
		const host = new FakePiHost({ mode: "rpc" });
		const snapshots: unknown[] = [];
		host.api.events.on(PROGRESS_WIDGET_STATE_EVENT, (value) => snapshots.push(value));
		registerGoalExtension(host.api, DEFAULT_CONFIG);
		host.emitBus(PROGRESS_WIDGET_ATTACH_EVENT, { version: 1, sessionId: "session-1" });
		await host.emit("session_start");
		await host.emit("input", { source: "rpc" });
		const create = host.tools.find((tool) => tool.name === "create_goal");
		if (create === undefined) throw new Error("missing create_goal");
		await create.execute("create-1", { objective: "Ship" } as never, undefined, undefined, host.context);

		expect(host.ui.setWidget).toHaveBeenCalledWith(GOAL_STATUS_KEY, undefined, { placement: "aboveEditor" });
		expect(snapshots.at(-1)).toMatchObject({
			version: 1,
			source: "goal",
			sessionId: "session-1",
			goal: { objective: "Ship", phase: "active" },
		});
	});
});
