import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	PROGRESS_WIDGET_ATTACH_EVENT,
	PROGRESS_WIDGET_KEY,
	PROGRESS_WIDGET_RELEASE_EVENT,
	PROGRESS_WIDGET_SHORTCUT,
	PROGRESS_WIDGET_STATE_EVENT,
} from "progress-widget-protocol";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import progressWidget from "../src/index.js";
import { buildProgressWidgetLines, ProgressWidgetComponent, type ProgressWidgetState } from "../src/widget.js";

function taggedTheme(variant: () => string = () => ""): Theme {
	const tag = (name: string, text: string) => `<${variant()}${name}>${text}</${variant()}${name}>`;
	const partial: Pick<Theme, "fg" | "bold" | "strikethrough"> = {
		fg: (color: ThemeColor, text: string) => tag(color, text),
		bold: (text: string) => tag("bold", text),
		strikethrough: (text: string) => tag("strike", text),
	};
	return partial as unknown as Theme;
}

const state: ProgressWidgetState = {
	goal: {
		id: "goal-1",
		objective: "Ship the UI",
		phase: "active",
		roundsStarted: 2,
		maxGoalRounds: 8,
		activation: "armed",
	},
	todos: [
		{ content: "Implement dashboard", status: "in_progress" },
		{ content: "Run tests", status: "pending" },
	],
	agents: [
		{ id: "child-1", description: "Review UI", status: "running" },
		{ id: "child-2", description: "Audit tests", status: "completed" },
	],
};

describe("progress widget lines", () => {
	it("builds the bounded compact view in fixed section order", () => {
		expect(buildProgressWidgetLines(state, "compact")).toEqual([
			"Subagents · 1 running · 0 interrupting · 1 completed · 0 interrupted · 0 failed",
			"Todos · 1 in progress · 1 pending · 0 completed",
			"◐ Implement dashboard",
			"Goal · active · round 2/8 · armed",
			"◐ Ship the UI",
		]);
	});

	it("shows complete entities in the full view", () => {
		expect(buildProgressWidgetLines(state, "full")).toEqual([
			"Subagents · 1 running · 0 interrupting · 1 completed · 0 interrupted · 0 failed",
			"◐ running · child-1 · Review UI",
			"✓ completed · child-2 · Audit tests",
			"Todos · 1 in progress · 1 pending · 0 completed",
			"◐ Implement dashboard",
			"○ Run tests",
			"Goal · active · round 2/8 · armed",
			"Objective: Ship the UI",
		]);
	});

	it("hides subagents when every latest run is settled", () => {
		const settled = {
			...state,
			agents: [{ id: "child-1", description: "Review UI", status: "completed" as const }],
		};
		expect(buildProgressWidgetLines(settled, "compact").some((line) => line.startsWith("Subagents"))).toBe(false);
	});
});

describe("progress widget TUI styling", () => {
	const stylingState: ProgressWidgetState = {
		goal: {
			id: "goal-1",
			objective: "Ship the UI",
			phase: "blocked",
			roundsStarted: 2,
			maxGoalRounds: 8,
			activation: "armed",
			blockedReason: { code: "dependency", message: "Waiting for API" },
		},
		todos: [
			{ content: "Implement dashboard", status: "in_progress" },
			{ content: "Run tests", status: "pending" },
			{ content: "Check theme", status: "completed" },
		],
		agents: [
			{ id: "run-1", description: "Implement UI", status: "running" },
			{ id: "run-2", description: "Stopping work", status: "interrupting" },
			{ id: "run-3", description: "Reviewed UI", status: "completed" },
			{ id: "run-4", description: "Stopped work", status: "interrupted" },
			{ id: "run-5", description: "Audit failed", status: "failed" },
		],
	};

	it("styles titles, metadata, status, IDs, and body text as separate segments", () => {
		const rendered = new ProgressWidgetComponent(stylingState, "full", taggedTheme()).render(1_000);

		expect(rendered[0]).toBe(
			"<accent><bold>Subagents</bold></accent><accent> · 1 running · 1 interrupting · 1 completed · 1 interrupted · 1 failed</accent>",
		);
		expect(rendered[1]).toBe(
			"<accent>◐ running</accent><muted> · </muted><dim>run-1</dim><muted> · </muted><text>Implement UI</text>",
		);
		expect(rendered[2]).toBe(
			"<warning>… interrupting</warning><muted> · </muted><dim>run-2</dim><muted> · </muted><text>Stopping work</text>",
		);
		expect(rendered[3]).toBe(
			"<success>✓ completed</success><muted> · </muted><dim>run-3</dim><muted> · </muted><muted>Reviewed UI</muted>",
		);
		expect(rendered[4]).toBe(
			"<muted>■ interrupted</muted><muted> · </muted><dim>run-4</dim><muted> · </muted><muted>Stopped work</muted>",
		);
		expect(rendered[5]).toBe(
			"<error>! failed</error><muted> · </muted><dim>run-5</dim><muted> · </muted><text>Audit failed</text>",
		);
		expect(rendered[7]).toBe("<accent>◐</accent> <text>Implement dashboard</text>");
		expect(rendered[8]).toBe("<muted>○</muted> <muted>Run tests</muted>");
		expect(rendered[9]).toBe("<success>✓</success> <muted><strike>Check theme</strike></muted>");
		expect(rendered[11]).toBe("<accent>Objective:</accent> <text>Ship the UI</text>");
		expect(rendered[12]).toBe("<error>Blocker: dependency</error><text>: Waiting for API</text>");
		expect(rendered.join("\n").match(/<bold>/g)).toHaveLength(3);
	});

	it.each([
		["active", "<accent>◐</accent> <text>Ship the UI</text>"],
		["paused", "<muted>Ⅱ</muted> <muted>Ship the UI</muted>"],
		["blocked", "<error>!</error> <text>Ship the UI</text>"],
		["complete", "<success>✓</success> <muted><strike>Ship the UI</strike></muted>"],
	] as const)("styles the %s Goal phase without coloring its whole objective", (phase, expected) => {
		const phaseState: ProgressWidgetState = {
			goal: {
				id: "goal-1",
				objective: "Ship the UI",
				phase,
				roundsStarted: 2,
				maxGoalRounds: 8,
				activation: "armed",
			},
			todos: [],
			agents: [],
		};

		expect(new ProgressWidgetComponent(phaseState, "compact", taggedTheme()).render(1_000)[1]).toBe(expected);
	});

	it("recomputes semantic colors after a theme change invalidates the component", () => {
		let variant = "light:";
		const component = new ProgressWidgetComponent(
			state,
			"compact",
			taggedTheme(() => variant),
		);

		expect(component.render(1_000)[2]).toContain("<light:accent>◐</light:accent> <light:text>Implement dashboard");
		variant = "dark:";
		component.invalidate();
		expect(component.render(1_000)[2]).toContain("<dark:accent>◐</dark:accent> <dark:text>Implement dashboard");
	});
});

describe("progress widget extension", () => {
	it("claims projection ownership and renders snapshots through one RPC widget", async () => {
		const host = new FakePiHost({ mode: "rpc" });
		const ownership: unknown[] = [];
		host.api.events.on(PROGRESS_WIDGET_ATTACH_EVENT, (value) => ownership.push(value));
		progressWidget(host.api);

		await host.emit("session_start");
		expect(ownership).toEqual([{ version: 1, sessionId: "session-1" }]);

		host.emitBus(PROGRESS_WIDGET_STATE_EVENT, {
			version: 1,
			source: "goal",
			sessionId: "session-1",
			goal: state.goal,
		});
		host.emitBus(PROGRESS_WIDGET_STATE_EVENT, {
			version: 1,
			source: "todo",
			sessionId: "session-1",
			todos: state.todos,
		});

		expect(host.ui.setWidget).toHaveBeenLastCalledWith(
			PROGRESS_WIDGET_KEY,
			[
				"Todos · 1 in progress · 1 pending · 0 completed",
				"◐ Implement dashboard",
				"Goal · active · round 2/8 · armed",
				"◐ Ship the UI",
			],
			{ placement: "aboveEditor" },
		);
	});

	it("switches view with ctrl+alt+o and resets to compact on session start", async () => {
		const host = new FakePiHost({ mode: "rpc" });
		progressWidget(host.api);
		await host.emit("session_start");
		host.emitBus(PROGRESS_WIDGET_STATE_EVENT, {
			version: 1,
			source: "todo",
			sessionId: "session-1",
			todos: state.todos,
		});

		await host.invokeShortcut(PROGRESS_WIDGET_SHORTCUT);
		expect(host.ui.setWidget.mock.calls.at(-1)?.[1]).toEqual([
			"Todos · 1 in progress · 1 pending · 0 completed",
			"◐ Implement dashboard",
			"○ Run tests",
		]);

		await host.emit("session_start");
		host.emitBus(PROGRESS_WIDGET_STATE_EVENT, {
			version: 1,
			source: "todo",
			sessionId: "session-1",
			todos: state.todos,
		});
		expect(host.ui.setWidget.mock.calls.at(-1)?.[1]).toEqual([
			"Todos · 1 in progress · 1 pending · 0 completed",
			"◐ Implement dashboard",
		]);
	});

	it("releases ownership when combined widget projection fails", async () => {
		const host = new FakePiHost({ mode: "rpc" });
		const releases: unknown[] = [];
		host.api.events.on(PROGRESS_WIDGET_RELEASE_EVENT, (value) => releases.push(value));
		progressWidget(host.api);
		await host.emit("session_start");
		host.ui.setWidget.mockImplementation((_key, component) => {
			if (component !== undefined) throw new Error("render failed");
		});

		host.emitBus(PROGRESS_WIDGET_STATE_EVENT, {
			version: 1,
			source: "todo",
			sessionId: "session-1",
			todos: state.todos,
		});

		expect(releases).toEqual([{ version: 1, sessionId: "session-1" }]);

		host.ui.setWidget.mockImplementation(() => undefined);
		await host.invokeShortcut(PROGRESS_WIDGET_SHORTCUT);
		expect(host.ui.setWidget).toHaveBeenLastCalledWith(
			PROGRESS_WIDGET_KEY,
			["Todos · 1 in progress · 1 pending · 0 completed", "◐ Implement dashboard", "○ Run tests"],
			{ placement: "aboveEditor" },
		);
	});

	it("uses switch rather than toggle in the command interface", async () => {
		const host = new FakePiHost({ mode: "rpc" });
		progressWidget(host.api);
		await host.emit("session_start");
		const command = host.commands.get("progress-widget");
		expect(command).toBeDefined();
		await command?.handler("toggle", host.context);
		expect(host.ui.notify).toHaveBeenLastCalledWith("Usage: /progress-widget [compact|full|switch]", "warning");
	});
});
