import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { TODO_WIDGET_KEY } from "./constants.js";
import { countTodos, type TodoItem, type TodoStatus } from "./domain.js";

const STATUS_MARK: Readonly<Record<TodoStatus, string>> = Object.freeze({
	in_progress: "◐",
	pending: "○",
	completed: "✓",
});

function orderedTodos(todos: readonly TodoItem[]): readonly TodoItem[] {
	return [
		...todos.filter((todo) => todo.status === "in_progress"),
		...todos.filter((todo) => todo.status === "pending"),
		...todos.filter((todo) => todo.status === "completed"),
	];
}

export function buildTodoWidgetLines(todos: readonly TodoItem[]): string[] {
	const counts = countTodos(todos);
	const ordered = orderedTodos(todos);
	const visible = ordered.slice(0, 5);
	const hidden = todos.length - visible.length;
	const hiddenLabel = hidden > 0 ? ` · … +${hidden}` : "";
	const header = `Todos · ${counts.inProgress} in progress · ${counts.pending} pending · ${counts.completed} completed${hiddenLabel}`;
	return [header, ...visible.map((todo) => `${STATUS_MARK[todo.status]} ${todo.content}`)];
}

export class TodoWidgetComponent implements Component {
	readonly #todos: readonly TodoItem[];
	readonly #theme: Theme;

	constructor(todos: readonly TodoItem[], theme: Theme) {
		this.#todos = todos;
		this.#theme = theme;
	}

	render(width: number): string[] {
		const plainLines = buildTodoWidgetLines(this.#todos);
		const header = plainLines[0] ?? "Todos";
		const rendered = [this.#theme.fg("accent", this.#theme.bold(header))];
		for (const todo of orderedTodos(this.#todos).slice(0, 5)) {
			const mark = this.#theme.fg(statusColor(todo.status), STATUS_MARK[todo.status]);
			const text =
				todo.status === "completed"
					? this.#theme.fg("muted", this.#theme.strikethrough(todo.content))
					: this.#theme.fg("text", todo.content);
			rendered.push(`${mark} ${text}`);
		}
		return rendered.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {}
}

function statusColor(status: TodoStatus): "warning" | "dim" | "success" {
	switch (status) {
		case "in_progress":
			return "warning";
		case "pending":
			return "dim";
		case "completed":
			return "success";
	}
}

/**
 * TUI gets a width-aware component; RPC receives the same bounded semantic
 * model as plain lines because its bridge cannot serialize component factories.
 */
export function projectTodoWidget(context: ExtensionContext, todos: readonly TodoItem[] | null): void {
	if (!context.hasUI || (context.mode !== "tui" && context.mode !== "rpc")) return;
	if (todos === null || todos.length === 0) {
		context.ui.setWidget(TODO_WIDGET_KEY, undefined);
		return;
	}
	if (context.mode === "tui") {
		context.ui.setWidget(TODO_WIDGET_KEY, (_tui, theme) => new TodoWidgetComponent(todos, theme));
		return;
	}
	context.ui.setWidget(TODO_WIDGET_KEY, buildTodoWidgetLines(todos));
}

export function tryProjectTodoWidget(context: ExtensionContext, todos: readonly TodoItem[] | null): boolean {
	try {
		projectTodoWidget(context, todos);
		return true;
	} catch {
		return false;
	}
}
