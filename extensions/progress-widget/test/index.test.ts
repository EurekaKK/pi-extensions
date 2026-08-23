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
import { buildProgressWidgetLines, type ProgressWidgetState } from "../src/widget.js";

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
			"Goal · active · round 2/8 · armed",
			"◐ Ship the UI",
			"Subagents · 1 running · 0 interrupting · 1 completed · 0 interrupted · 0 failed",
			"Todos · 1 in progress · 1 pending · 0 completed",
			"◐ Implement dashboard",
		]);
	});

	it("shows complete entities in the full view", () => {
		expect(buildProgressWidgetLines(state, "full")).toEqual([
			"Goal · active · round 2/8 · armed",
			"Objective: Ship the UI",
			"Subagents · 1 running · 0 interrupting · 1 completed · 0 interrupted · 0 failed",
			"◐ running · child-1 · Review UI",
			"✓ completed · child-2 · Audit tests",
			"Todos · 1 in progress · 1 pending · 0 completed",
			"◐ Implement dashboard",
			"○ Run tests",
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
				"Goal · active · round 2/8 · armed",
				"◐ Ship the UI",
				"Todos · 1 in progress · 1 pending · 0 completed",
				"◐ Implement dashboard",
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
