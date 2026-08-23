import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { TODO_WIDGET_KEY } from "../src/constants.js";
import { buildTodoWidgetLines, projectTodoWidget, TodoWidgetComponent } from "../src/widget.js";

describe("Todo v2 widget", () => {
	it("shows counts and only the first in-progress item", () => {
		const lines = buildTodoWidgetLines([
			{ content: "c1", status: "completed" },
			{ content: "p1", status: "pending" },
			{ content: "i1", status: "in_progress" },
			{ content: "c2", status: "completed" },
			{ content: "p2", status: "pending" },
			{ content: "i2", status: "in_progress" },
		]);

		expect(lines).toEqual(["Todos · 2 in progress · 2 pending · 2 completed", "◐ i1"]);
	});

	it("falls back to the first pending item", () => {
		expect(
			buildTodoWidgetLines([
				{ content: "done", status: "completed" },
				{ content: "next", status: "pending" },
			]),
		).toEqual(["Todos · 0 in progress · 1 pending · 1 completed", "○ next"]);
	});

	it("renders a width-truncated component", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			strikethrough: (text: string) => text,
		} as unknown as Theme;
		const component = new TodoWidgetComponent([{ content: "work", status: "in_progress" }], theme);

		const [header, item] = component.render(20);
		expect(header).toMatch(/^Todos · 1 in prog/);
		expect(item).toBe("◐ work");
	});

	it("projects a TUI component and RPC lines, and ignores non-UI modes", () => {
		const setWidget = vi.fn();
		const base = { hasUI: true, ui: { setWidget } } as unknown as ExtensionContext;
		const list = [{ content: "work", status: "pending" }] as const;

		projectTodoWidget({ ...base, mode: "tui" } as ExtensionContext, list);
		expect(setWidget).toHaveBeenCalledWith(TODO_WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });

		setWidget.mockClear();
		projectTodoWidget({ ...base, mode: "rpc" } as ExtensionContext, list);
		expect(setWidget).toHaveBeenCalledWith(
			TODO_WIDGET_KEY,
			["Todos · 0 in progress · 1 pending · 0 completed", "○ work"],
			{ placement: "aboveEditor" },
		);

		setWidget.mockClear();
		projectTodoWidget({ ...base, mode: "print" } as ExtensionContext, list);
		expect(setWidget).not.toHaveBeenCalled();

		setWidget.mockClear();
		projectTodoWidget({ ...base, mode: "json", hasUI: false } as ExtensionContext, list);
		expect(setWidget).not.toHaveBeenCalled();
	});

	it("clears the widget for null and empty lists", () => {
		const setWidget = vi.fn();
		const context = {
			mode: "tui",
			hasUI: true,
			ui: { setWidget },
		} as unknown as ExtensionContext;

		projectTodoWidget(context, null);
		projectTodoWidget(context, []);
		expect(setWidget).toHaveBeenNthCalledWith(1, TODO_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		expect(setWidget).toHaveBeenNthCalledWith(2, TODO_WIDGET_KEY, undefined, { placement: "aboveEditor" });
	});
});
