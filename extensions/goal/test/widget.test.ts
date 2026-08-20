import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { GOAL_STATUS_KEY } from "../src/constants.js";
import type { GoalView } from "../src/domain.js";
import { buildGoalWidgetLines, GoalWidgetComponent, projectGoalWidget } from "../src/widget.js";

const view: GoalView = {
	id: "goal-1",
	revision: 1,
	objective: "Ship readable progress",
	phase: "active",
	maxGoalRounds: 30,
	roundsStarted: 7,
	createdAt: 1,
	updatedAt: 2,
	activation: "armed",
};

describe("goal v2 widget", () => {
	it("shows phase, rounds, activation and objective", () => {
		expect(buildGoalWidgetLines(view)).toEqual(["Goal · active · round 7/30 · armed", "◐ Ship readable progress"]);
	});

	it("renders a width-truncated component", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			strikethrough: (text: string) => text,
		} as unknown as Theme;
		const [header, objective] = new GoalWidgetComponent(view, theme).render(24);

		expect(header).toMatch(/^Goal · active · round/);
		expect(header).not.toContain("7/30");
		expect(objective).toBe("◐ Ship readable progress");
	});

	it("projects above the editor in TUI and RPC, and clears explicitly", () => {
		const setWidget = vi.fn();
		const base = { hasUI: true, ui: { setWidget } } as unknown as ExtensionContext;

		projectGoalWidget({ ...base, mode: "tui" } as ExtensionContext, view);
		expect(setWidget).toHaveBeenLastCalledWith(GOAL_STATUS_KEY, expect.any(Function), {
			placement: "aboveEditor",
		});

		projectGoalWidget({ ...base, mode: "rpc" } as ExtensionContext, view);
		expect(setWidget).toHaveBeenLastCalledWith(GOAL_STATUS_KEY, buildGoalWidgetLines(view), {
			placement: "aboveEditor",
		});

		projectGoalWidget({ ...base, mode: "tui" } as ExtensionContext, undefined);
		expect(setWidget).toHaveBeenLastCalledWith(GOAL_STATUS_KEY, undefined, { placement: "aboveEditor" });
	});

	it("does not call UI in print or JSON mode", () => {
		const setWidget = vi.fn();
		const base = { hasUI: true, ui: { setWidget } } as unknown as ExtensionContext;

		projectGoalWidget({ ...base, mode: "print" } as ExtensionContext, view);
		projectGoalWidget({ ...base, mode: "json" } as ExtensionContext, view);
		expect(setWidget).not.toHaveBeenCalled();
	});
});
