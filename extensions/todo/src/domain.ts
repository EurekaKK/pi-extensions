import { TODO_SNAPSHOT_VERSION } from "./constants.js";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
	readonly content: string;
	readonly status: TodoStatus;
}

export interface TodoCounts {
	readonly pending: number;
	readonly inProgress: number;
	readonly completed: number;
}

export interface TodoSnapshotV2 {
	readonly version: 2;
	readonly todos: readonly TodoItem[];
}

export type TodoSnapshotParseResult =
	| { readonly status: "valid"; readonly todos: readonly TodoItem[] }
	| { readonly status: "ignored" }
	| { readonly status: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const keys = [...expected].sort();
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		actual.length === keys.length &&
		actual.every((key, index) => key === keys[index])
	);
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && TODO_STATUSES.some((status) => status === value);
}

function freezeTodoItem(item: TodoItem): TodoItem {
	return Object.freeze({ content: item.content, status: item.status });
}

/**
 * Validate one todo_write payload and build the canonical persisted list.
 *
 * Schema validation has already rejected unknown keys and invalid enum values.
 * This boundary still re-checks the domain invariants so the function is safe
 * for direct unit testing, then trims content and enforces the deployment's
 * in-progress policy.
 */
export function normalizeTodoItems(raw: readonly unknown[], allowParallelInProgress: boolean): readonly TodoItem[] {
	const todos: TodoItem[] = [];
	const seen = new Set<string>();
	let active = 0;

	for (const candidate of raw) {
		if (!isRecord(candidate)) {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		const { content, status } = candidate;
		if (typeof content !== "string" || !isTodoStatus(status)) {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		const trimmed = content.trim();
		if (trimmed.length === 0) {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		if (seen.has(trimmed)) {
			throw new Error(`invalid todos: duplicate content ${JSON.stringify(trimmed)}`);
		}
		seen.add(trimmed);
		if (status === "in_progress") active += 1;
		todos.push(freezeTodoItem({ content: trimmed, status }));
	}

	if (!allowParallelInProgress && active > 1) {
		throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`);
	}

	return Object.freeze(todos);
}

/**
 * A non-empty list whose every item is completed is the plan's terminal
 * state: nothing remains to show or resume, so callers retire it.
 */
export function isFullyCompleted(todos: readonly TodoItem[]): boolean {
	return todos.length > 0 && todos.every((todo) => todo.status === "completed");
}

export function createTodoSnapshot(todos: readonly TodoItem[]): TodoSnapshotV2 {
	return Object.freeze({
		version: TODO_SNAPSHOT_VERSION,
		todos: Object.freeze(todos.map(freezeTodoItem)),
	});
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

/**
 * Classify one persisted `todo:snapshot` data value.
 *
 * Version 1 snapshots are intentionally ignored without being treated as
 * corruption. Only a value that claims version 2 but violates its shape is
 * reported as invalid.
 */
export function parseTodoSnapshot(value: unknown): TodoSnapshotParseResult {
	if (!isRecord(value)) return { status: "invalid" };
	if (!Object.hasOwn(value, "version") || value.version !== TODO_SNAPSHOT_VERSION) {
		return { status: "ignored" };
	}
	if (!hasExactKeys(value, ["version", "todos"]) || !Array.isArray(value.todos)) {
		return { status: "invalid" };
	}

	const todos: TodoItem[] = [];
	const seen = new Set<string>();
	for (const candidate of value.todos) {
		if (!isRecord(candidate) || !hasExactKeys(candidate, ["content", "status"])) {
			return { status: "invalid" };
		}
		if (
			typeof candidate.content !== "string" ||
			candidate.content.length === 0 ||
			candidate.content !== candidate.content.trim() ||
			!isTodoStatus(candidate.status)
		) {
			return { status: "invalid" };
		}
		if (seen.has(candidate.content)) return { status: "invalid" };
		seen.add(candidate.content);
		todos.push(freezeTodoItem({ content: candidate.content, status: candidate.status }));
	}

	return { status: "valid", todos: Object.freeze(todos) };
}
