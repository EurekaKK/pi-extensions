import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createEmptyRuntimeState, createTodoList, type RuntimeState, updateTodos } from "../src/domain.js";
import { buildTodoWidgetLines, projectTodoWidget, TodoWidgetComponent } from "../src/widget.js";

function createState(): RuntimeState {
	const created = createTodoList(createEmptyRuntimeState(), [
		"done",
		"working",
		"pending-a",
		"cancelled",
		"pending-b",
		"done-too",
		"pending-c",
	]);
	if (!created.ok) throw new Error(created.error.message);
	const updated = updateTodos(created.state, [
		{ id: 1, status: "completed" },
		{ id: 2, status: "in_progress" },
		{ id: 4, status: "cancelled", reason: "covered elsewhere" },
		{ id: 6, status: "completed" },
	]);
	if (!updated.ok) throw new Error(updated.error.message);
	return updated.state;
}

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

function fakeContext(mode: ExtensionContext["mode"], hasUI: boolean) {
	const setWidget = vi.fn();
	return {
		context: {
			mode,
			hasUI,
			ui: { setWidget },
		} as unknown as ExtensionContext,
		setWidget,
	};
}

describe("Todo status widget", () => {
	it("orders by status then ID, displays five items, and reports hidden items", () => {
		const list = createState().activeList;
		if (list === null) throw new Error("Expected an active list.");

		expect(buildTodoWidgetLines(list)).toEqual([
			"Todos · 2 completed · 1 cancelled · 4 unresolved · … +2",
			"◐ #2 working",
			"○ #3 pending-a",
			"○ #5 pending-b",
			"○ #7 pending-c",
			"✓ #1 done",
		]);
	});

	it("shows the cancellation reason when a cancelled row is visible", () => {
		const created = createTodoList(createEmptyRuntimeState(), ["open", "obsolete"]);
		if (!created.ok) throw new Error(created.error.message);
		const updated = updateTodos(created.state, [{ id: 2, status: "cancelled", reason: "not needed" }]);
		if (!updated.ok || updated.state.activeList === null) throw new Error("Expected an active list.");

		expect(buildTodoWidgetLines(updated.state.activeList)).toContain("– #2 obsolete：not needed");
		expect(buildTodoWidgetLines(updated.state.activeList).join("\n")).not.toContain("reminder");
	});

	it("keeps every TUI row within a narrow width", () => {
		const list = createState().activeList;
		if (list === null) throw new Error("Expected an active list.");
		const component = new TodoWidgetComponent(list, fakeTheme());

		const lines = component.render(16);
		expect(lines).toHaveLength(6);
		expect(lines.every((line) => visibleWidth(line) <= 16)).toBe(true);
	});

	it("uses a component factory in TUI, plain lines in RPC, and no UI in headless modes", () => {
		const list = createState().activeList;
		if (list === null) throw new Error("Expected an active list.");

		const tui = fakeContext("tui", true);
		projectTodoWidget(tui.context, list);
		expect(typeof tui.setWidget.mock.calls[0]?.[1]).toBe("function");

		const rpc = fakeContext("rpc", true);
		projectTodoWidget(rpc.context, list);
		expect(Array.isArray(rpc.setWidget.mock.calls[0]?.[1])).toBe(true);

		for (const mode of ["json", "print"] as const) {
			const headless = fakeContext(mode, false);
			projectTodoWidget(headless.context, list);
			expect(headless.setWidget).not.toHaveBeenCalled();
		}
	});

	it("clears the canonical widget key when the active list closes", () => {
		const tui = fakeContext("tui", true);
		projectTodoWidget(tui.context, null);
		expect(tui.setWidget).toHaveBeenCalledWith("todo:status", undefined);
	});
});
