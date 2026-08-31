import { createTodoSnapshotV3, foldTodoSnapshots, normalizeTodoList, type TodoItemV3 } from "todo-protocol";

export type { TodoSnapshotParseResult } from "todo-protocol";
export {
	parseTodoSnapshot,
	TODO_STATUSES,
	type TodoItemV3,
	type TodoSourceV1,
	type TodoStatus,
} from "todo-protocol";

export type TodoItem = TodoItemV3;

export interface TodoCounts {
	readonly pending: number;
	readonly inProgress: number;
	readonly completed: number;
}

/**
 * 校验一个 todo_write payload 并构造规范化列表。schema 已拒绝未知字段与非法
 * 枚举；此处复核领域不变量并执行部署级并行策略。
 */
export function normalizeTodoItems(raw: readonly unknown[], allowParallelInProgress: boolean): readonly TodoItem[] {
	const todos = normalizeTodoList(raw);
	let active = 0;
	for (const todo of todos) {
		if (todo.status === "in_progress") active += 1;
	}
	if (!allowParallelInProgress && active > 1) {
		throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`);
	}
	return todos;
}

/**
 * 在 content 完全一致时保留已持久化 Todo 的 Plan Step source；新内容或改写
 * 内容成为无 source 的 unlinked Todo。
 */
export function preserveSources(
	entries: readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[],
	submitted: readonly TodoItem[],
): readonly TodoItem[] {
	const latest = foldTodoSnapshots(entries);
	const sourcesByContent = new Map<string, TodoItem["source"]>();
	for (const todo of latest.todos) {
		if (todo.source !== undefined) sourcesByContent.set(todo.content, todo.source);
	}
	return Object.freeze(
		submitted.map((todo) => {
			const source = sourcesByContent.get(todo.content);
			return Object.freeze(
				source === undefined
					? { content: todo.content, status: todo.status }
					: { content: todo.content, status: todo.status, source },
			);
		}),
	);
}

/**
 * 非空且全部 completed 的列表是计划终态：调用方按空列表落盘并清除 widget。
 */
export function isFullyCompleted(todos: readonly TodoItem[]): boolean {
	return todos.length > 0 && todos.every((todo) => todo.status === "completed");
}

export function createTodoSnapshot(todos: readonly TodoItem[]) {
	return createTodoSnapshotV3(todos);
}

export function countTodos(todos: readonly TodoItem[]): TodoCounts {
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const todo of todos) {
		switch (todo.status) {
			case "pending":
				pending += 1;
				break;
			case "in_progress":
				inProgress += 1;
				break;
			case "completed":
				completed += 1;
				break;
		}
	}
	return Object.freeze({ pending, inProgress, completed });
}
