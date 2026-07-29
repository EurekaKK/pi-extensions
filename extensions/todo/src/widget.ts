import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { TODO_WIDGET_KEY } from "./constants.js";
import type { ActiveTodoList, TodoItem, TodoStatus } from "./domain.js";
import { getTodoCounts } from "./domain.js";

const STATUS_ORDER: Readonly<Record<TodoStatus, number>> = Object.freeze({
	in_progress: 0,
	pending: 1,
	completed: 2,
	cancelled: 3,
});

const STATUS_MARK: Readonly<Record<TodoStatus, string>> = Object.freeze({
	in_progress: "◐",
	pending: "○",
	completed: "✓",
	cancelled: "–",
});

function orderedTodos(list: ActiveTodoList): readonly TodoItem[] {
	return [...list.todos].sort((left, right) => {
		const statusDifference = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
		return statusDifference === 0 ? left.id - right.id : statusDifference;
	});
}

export function buildTodoWidgetLines(list: ActiveTodoList): string[] {
	const counts = getTodoCounts(list);
	const visible = orderedTodos(list).slice(0, 5);
	const hidden = list.todos.length - visible.length;
	const hiddenLabel = hidden > 0 ? ` · … +${hidden}` : "";
	const lines = [
		`Todos · ${counts.completed} completed · ${counts.cancelled} cancelled · ${counts.unresolved} unresolved${hiddenLabel}`,
	];

	for (const todo of visible) {
		const reason = todo.status === "cancelled" ? `：${todo.cancellationReason}` : "";
		lines.push(`${STATUS_MARK[todo.status]} #${todo.id} ${todo.text}${reason}`);
	}
	return lines;
}

export class TodoWidgetComponent implements Component {
	readonly #list: ActiveTodoList;
	readonly #theme: Theme;

	constructor(list: ActiveTodoList, theme: Theme) {
		this.#list = list;
		this.#theme = theme;
	}

	render(width: number): string[] {
		const plainLines = buildTodoWidgetLines(this.#list);
		const header = plainLines[0] ?? "Todos";
		const rendered = [this.#theme.fg("accent", this.#theme.bold(header))];
		const ordered = orderedTodos(this.#list).slice(0, 5);
		for (const todo of ordered) {
			const mark = this.#theme.fg(statusColor(todo.status), STATUS_MARK[todo.status]);
			const id = this.#theme.fg("accent", `#${todo.id}`);
			const suffix = todo.status === "cancelled" ? `：${todo.cancellationReason}` : "";
			const rawText = `${todo.text}${suffix}`;
			const text =
				todo.status === "completed" || todo.status === "cancelled"
					? this.#theme.fg("muted", this.#theme.strikethrough(rawText))
					: this.#theme.fg("text", rawText);
			rendered.push(`${mark} ${id} ${text}`);
		}
		return rendered.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {}
}

function statusColor(status: TodoStatus): "warning" | "dim" | "success" | "muted" {
	switch (status) {
		case "in_progress":
			return "warning";
		case "pending":
			return "dim";
		case "completed":
			return "success";
		case "cancelled":
			return "muted";
	}
}

/**
 * TUI gets a width-aware component; RPC receives the same bounded semantic
 * model as plain lines because its bridge cannot serialize component factories.
 */
export function projectTodoWidget(context: ExtensionContext, list: ActiveTodoList | null): void {
	if (!context.hasUI || (context.mode !== "tui" && context.mode !== "rpc")) return;
	if (list === null) {
		context.ui.setWidget(TODO_WIDGET_KEY, undefined);
		return;
	}
	if (context.mode === "tui") {
		context.ui.setWidget(TODO_WIDGET_KEY, (_tui, theme) => new TodoWidgetComponent(list, theme));
		return;
	}
	context.ui.setWidget(TODO_WIDGET_KEY, buildTodoWidgetLines(list));
}

export function tryProjectTodoWidget(context: ExtensionContext, list: ActiveTodoList | null): boolean {
	try {
		projectTodoWidget(context, list);
		return true;
	} catch {
		return false;
	}
}
