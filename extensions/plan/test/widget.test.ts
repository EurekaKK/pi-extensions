import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { buildPlanWidgetLines, PlanWidgetComponent } from "../src/widget.js";

const plan = { planId: "plan-1", phase: "reviewing" as const, revision: 2 };
const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

describe("Plan fallback widget", () => {
	it("keeps the prior status information in one above-editor-friendly line", () => {
		expect(buildPlanWidgetLines(plan)).toEqual(["Plan · reviewing · plan-1 · r2 · workspace mutations blocked"]);
	});

	it("bounds TUI output to the available terminal width", () => {
		const lines = new PlanWidgetComponent(plan, theme).render(24);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(24);
	});
});
