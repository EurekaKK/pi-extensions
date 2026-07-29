export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];
export type ReminderCount = 0 | 1 | 2 | 3 | 4;

interface TodoItemBase {
	readonly id: number;
	readonly text: string;
}

export interface PendingTodoItem extends TodoItemBase {
	readonly status: "pending";
}

export interface InProgressTodoItem extends TodoItemBase {
	readonly status: "in_progress";
}

export interface CompletedTodoItem extends TodoItemBase {
	readonly status: "completed";
}

export interface CancelledTodoItem extends TodoItemBase {
	readonly status: "cancelled";
	readonly cancellationReason: string;
}

export type TodoItem = PendingTodoItem | InProgressTodoItem | CompletedTodoItem | CancelledTodoItem;

export interface ActiveTodoList {
	readonly nextId: number;
	readonly todos: readonly TodoItem[];
}

export interface RuntimeState {
	readonly activeList: ActiveTodoList | null;
	readonly reminderCount: ReminderCount;
}

export interface TodoUpdate {
	readonly id: number;
	readonly status: TodoStatus;
	readonly reason?: string;
}

export interface TodoCounts {
	readonly total: number;
	readonly pending: number;
	readonly inProgress: number;
	readonly completed: number;
	readonly cancelled: number;
	readonly unresolved: number;
}

export type TodoErrorCode =
	| "todo_active_list_exists"
	| "todo_no_active_list"
	| "todo_invalid_arguments"
	| "todo_duplicate_update_id"
	| "todo_not_found"
	| "todo_invalid_transition"
	| "todo_no_state_change"
	| "todo_cancellation_reason_required"
	| "todo_cancellation_reason_forbidden"
	| "todo_persistence_failed";

export interface TodoMutationError {
	readonly code: TodoErrorCode;
	readonly message: string;
	readonly todoId?: number;
}

export type TodoMutationOutcome = "created" | "added" | "updated" | "closed";

export interface TodoMutationSuccess {
	readonly ok: true;
	readonly outcome: TodoMutationOutcome;
	readonly state: RuntimeState;
	readonly changedTodos: readonly TodoItem[];
	readonly todos: readonly TodoItem[];
	readonly unresolvedTodos: readonly TodoItem[];
	readonly counts: TodoCounts;
}

export interface TodoMutationFailure {
	readonly ok: false;
	readonly state: RuntimeState;
	readonly error: TodoMutationError;
}

export type TodoMutationResult = TodoMutationSuccess | TodoMutationFailure;

type JsonRecord = Record<string, unknown>;

type ValidatedTodoUpdate =
	| {
			readonly id: number;
			readonly status: "cancelled";
			readonly cancellationReason: string;
	  }
	| {
			readonly id: number;
			readonly status: Exclude<TodoStatus, "cancelled">;
	  };

interface TextValidationSuccess {
	readonly ok: true;
	readonly texts: readonly string[];
}

interface ValidationFailure {
	readonly ok: false;
	readonly message: string;
}

type TextValidationResult = TextValidationSuccess | ValidationFailure;
type UpdateValidationResult =
	| {
			readonly ok: true;
			readonly updates: readonly ValidatedTodoUpdate[];
	  }
	| ValidationFailure
	| {
			readonly ok: false;
			readonly message: string;
			readonly code:
				| "todo_duplicate_update_id"
				| "todo_cancellation_reason_required"
				| "todo_cancellation_reason_forbidden";
			readonly todoId: number;
	  };

const EMPTY_RUNTIME_STATE: RuntimeState = Object.freeze({
	activeList: null,
	reminderCount: 0,
});

export function createEmptyRuntimeState(): RuntimeState {
	return EMPTY_RUNTIME_STATE;
}

/**
 * Reconstructs an immutable runtime state from already-persisted data.
 *
 * `null` means validation failed. A valid empty state is represented by a
 * non-null RuntimeState whose activeList is null.
 */
export function createRuntimeState(activeList: unknown, reminderCount: unknown): RuntimeState | null {
	if (!isReminderCount(reminderCount)) {
		return null;
	}
	if (activeList === null) {
		return reminderCount === 0 ? createEmptyRuntimeState() : null;
	}
	if (!isValidActiveTodoList(activeList)) {
		return null;
	}
	return freezeRuntimeState(cloneActiveTodoList(activeList), reminderCount);
}

export function createTodoList(state: RuntimeState, items: readonly string[]): TodoMutationResult {
	const validatedTexts = normalizeTexts(items);
	if (!validatedTexts.ok) {
		return reject(state, "todo_invalid_arguments", validatedTexts.message);
	}
	if (state.activeList !== null) {
		return reject(
			state,
			"todo_active_list_exists",
			"Cannot create a Todo List while another list still has unresolved Todos.",
		);
	}

	const todos = validatedTexts.texts.map((text, index) => freezeTodoItem(index + 1, text, "pending"));
	const activeList = freezeActiveTodoList(todos.length + 1, todos);
	const nextState = freezeRuntimeState(activeList, 0);
	return succeed("created", nextState, activeList.todos, activeList.todos);
}

export function addTodos(state: RuntimeState, items: readonly string[]): TodoMutationResult {
	const validatedTexts = normalizeTexts(items);
	if (!validatedTexts.ok) {
		return reject(state, "todo_invalid_arguments", validatedTexts.message);
	}
	if (state.activeList === null) {
		return reject(state, "todo_no_active_list", "Cannot add Todos because there is no active Todo List.");
	}
	const currentList = state.activeList;
	if (!canAllocateIds(currentList.nextId, validatedTexts.texts.length)) {
		return reject(state, "todo_invalid_arguments", "Cannot allocate safe integer IDs for the requested Todos.");
	}

	const addedTodos = validatedTexts.texts.map((text, index) =>
		freezeTodoItem(currentList.nextId + index, text, "pending"),
	);
	const allTodos = [...currentList.todos, ...addedTodos];
	const activeList = freezeActiveTodoList(currentList.nextId + addedTodos.length, allTodos);
	const nextState = freezeRuntimeState(activeList, 0);
	const changedTodos = activeList.todos.slice(currentList.todos.length);
	return succeed("added", nextState, activeList.todos, changedTodos);
}

export function updateTodos(state: RuntimeState, updates: readonly TodoUpdate[]): TodoMutationResult {
	const validatedUpdates = validateUpdates(updates);
	if (!validatedUpdates.ok) {
		if ("code" in validatedUpdates) {
			return reject(state, validatedUpdates.code, validatedUpdates.message, validatedUpdates.todoId);
		}
		return reject(state, "todo_invalid_arguments", validatedUpdates.message);
	}
	if (state.activeList === null) {
		return reject(state, "todo_no_active_list", "Cannot update Todos because there is no active Todo List.");
	}

	const todosById = new Map(state.activeList.todos.map((todo) => [todo.id, todo]));
	for (const update of validatedUpdates.updates) {
		const current = todosById.get(update.id);
		if (current === undefined) {
			return reject(
				state,
				"todo_not_found",
				`Todo #${update.id} does not exist; no Todo was changed and the reminder counter was not reset.`,
				update.id,
			);
		}
		if (current.status === update.status) {
			return reject(
				state,
				"todo_no_state_change",
				`Todo #${update.id} is already ${update.status}; no Todo was changed and the reminder counter was not reset.`,
				update.id,
			);
		}
		if (!isAllowedTransition(current.status, update.status)) {
			return reject(
				state,
				"todo_invalid_transition",
				`Todo #${update.id} cannot move from ${current.status} to ${update.status}; no Todo was changed and the reminder counter was not reset.`,
				update.id,
			);
		}
	}

	const updatesById = new Map(validatedUpdates.updates.map((update) => [update.id, update]));
	const nextTodos = state.activeList.todos.map((todo) => {
		const update = updatesById.get(todo.id);
		if (update === undefined) {
			return cloneTodoItem(todo);
		}
		return update.status === "cancelled"
			? freezeTodoItem(todo.id, todo.text, "cancelled", update.cancellationReason)
			: freezeTodoItem(todo.id, todo.text, update.status);
	});
	const frozenTodos = freezeTodoItems(nextTodos);
	const nextById = new Map(frozenTodos.map((todo) => [todo.id, todo]));
	const changedTodos = validatedUpdates.updates.map((update) => {
		const changed = nextById.get(update.id);
		if (changed === undefined) {
			throw new Error(`Todo domain invariant failed for #${update.id}.`);
		}
		return changed;
	});
	const unresolvedTodos = unresolvedFromTodos(frozenTodos);
	if (unresolvedTodos.length === 0) {
		const nextState = createEmptyRuntimeState();
		return succeed("closed", nextState, frozenTodos, changedTodos);
	}

	const activeList = freezeActiveTodoList(state.activeList.nextId, frozenTodos);
	const nextState = freezeRuntimeState(activeList, 0);
	return succeed("updated", nextState, activeList.todos, changedTodos);
}

export function getUnresolvedTodos(list: ActiveTodoList | null): readonly TodoItem[] {
	return list === null ? Object.freeze([]) : unresolvedFromTodos(list.todos);
}

export function getTodoCounts(list: ActiveTodoList): TodoCounts;
export function getTodoCounts(todos: readonly TodoItem[]): TodoCounts;
export function getTodoCounts(source: ActiveTodoList | readonly TodoItem[]): TodoCounts {
	const todos = isTodoCollection(source) ? source.todos : source;
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	let cancelled = 0;
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
			case "cancelled":
				cancelled += 1;
				break;
		}
	}
	return Object.freeze({
		total: todos.length,
		pending,
		inProgress,
		completed,
		cancelled,
		unresolved: pending + inProgress,
	});
}

export function isValidActiveTodoList(value: unknown): value is ActiveTodoList {
	if (!isPlainJsonObject(value) || !hasExactKeys(value, ["nextId", "todos"]) || !Array.isArray(value.todos)) {
		return false;
	}
	if (!Number.isSafeInteger(value.nextId) || value.nextId !== value.todos.length + 1 || value.todos.length === 0) {
		return false;
	}

	let hasUnresolved = false;
	for (const [index, item] of value.todos.entries()) {
		if (!isPlainJsonObject(item) || item.id !== index + 1 || !isNormalizedNonBlankString(item.text)) {
			return false;
		}
		if (!isTodoStatus(item.status)) {
			return false;
		}
		if (item.status === "cancelled") {
			if (
				!hasExactKeys(item, ["id", "text", "status", "cancellationReason"]) ||
				!isNormalizedNonBlankString(item.cancellationReason)
			) {
				return false;
			}
		} else {
			if (!hasExactKeys(item, ["id", "text", "status"])) {
				return false;
			}
			hasUnresolved ||= item.status === "pending" || item.status === "in_progress";
		}
	}
	return hasUnresolved;
}

function normalizeTexts(items: readonly string[]): TextValidationResult {
	if (!Array.isArray(items) || items.length === 0) {
		return { ok: false, message: "items must contain at least one Todo text." };
	}
	const normalized: string[] = [];
	for (const [index, text] of items.entries()) {
		if (typeof text !== "string" || text.trim().length === 0) {
			return { ok: false, message: `items[${index}] must be a non-blank string.` };
		}
		normalized.push(text.trim());
	}
	return { ok: true, texts: Object.freeze(normalized) };
}

function validateUpdates(updates: readonly TodoUpdate[]): UpdateValidationResult {
	if (!Array.isArray(updates) || updates.length === 0) {
		return { ok: false, message: "updates must contain at least one Todo update." };
	}

	const seenIds = new Set<number>();
	const validated: ValidatedTodoUpdate[] = [];
	for (const [index, update] of updates.entries()) {
		if (
			!isPlainJsonObject(update) ||
			!hasOnlyAllowedKeys(update, ["id", "status", "reason"]) ||
			!Object.hasOwn(update, "id") ||
			!Object.hasOwn(update, "status") ||
			!Number.isSafeInteger(update.id) ||
			typeof update.id !== "number" ||
			update.id <= 0 ||
			!isTodoStatus(update.status)
		) {
			return { ok: false, message: `updates[${index}] has invalid fields.` };
		}
		if (seenIds.has(update.id)) {
			return {
				ok: false,
				code: "todo_duplicate_update_id",
				message: `Todo #${update.id} appears more than once in the same update batch.`,
				todoId: update.id,
			};
		}
		seenIds.add(update.id);

		const hasReason = Object.hasOwn(update, "reason");
		if (update.status === "cancelled") {
			if (!hasReason || typeof update.reason !== "string" || update.reason.trim().length === 0) {
				return {
					ok: false,
					code: "todo_cancellation_reason_required",
					message: `Cancelling Todo #${update.id} requires a specific non-blank reason.`,
					todoId: update.id,
				};
			}
			validated.push({
				id: update.id,
				status: update.status,
				cancellationReason: update.reason.trim(),
			});
			continue;
		}
		if (hasReason) {
			return {
				ok: false,
				code: "todo_cancellation_reason_forbidden",
				message: `Todo #${update.id} may include a reason only when its target status is cancelled.`,
				todoId: update.id,
			};
		}
		validated.push({ id: update.id, status: update.status });
	}
	return { ok: true, updates: Object.freeze(validated) };
}

function isAllowedTransition(current: TodoStatus, target: TodoStatus): boolean {
	if (current === "pending") {
		return target === "in_progress" || target === "completed" || target === "cancelled";
	}
	if (current === "in_progress") {
		return target === "completed" || target === "cancelled";
	}
	return false;
}

function succeed(
	outcome: TodoMutationOutcome,
	state: RuntimeState,
	todos: readonly TodoItem[],
	changedTodos: readonly TodoItem[],
): TodoMutationSuccess {
	const immutableTodos = Object.freeze([...todos]);
	return Object.freeze({
		ok: true,
		outcome,
		state,
		changedTodos: Object.freeze([...changedTodos]),
		todos: immutableTodos,
		unresolvedTodos: unresolvedFromTodos(immutableTodos),
		counts: getTodoCounts(immutableTodos),
	});
}

function reject(state: RuntimeState, code: TodoErrorCode, message: string, todoId?: number): TodoMutationFailure {
	const error: TodoMutationError =
		todoId === undefined ? Object.freeze({ code, message }) : Object.freeze({ code, message, todoId });
	return Object.freeze({ ok: false, state, error });
}

function cloneActiveTodoList(list: ActiveTodoList): ActiveTodoList {
	return freezeActiveTodoList(list.nextId, list.todos);
}

function freezeActiveTodoList(nextId: number, todos: readonly TodoItem[]): ActiveTodoList {
	return Object.freeze({
		nextId,
		todos: freezeTodoItems(todos),
	});
}

function freezeRuntimeState(activeList: ActiveTodoList | null, reminderCount: ReminderCount): RuntimeState {
	return Object.freeze({ activeList, reminderCount });
}

function freezeTodoItems(todos: readonly TodoItem[]): readonly TodoItem[] {
	return Object.freeze(todos.map(cloneTodoItem));
}

function cloneTodoItem(todo: TodoItem): TodoItem {
	return todo.status === "cancelled"
		? freezeTodoItem(todo.id, todo.text, todo.status, todo.cancellationReason)
		: freezeTodoItem(todo.id, todo.text, todo.status);
}

function freezeTodoItem(id: number, text: string, status: "cancelled", cancellationReason: string): CancelledTodoItem;
function freezeTodoItem(
	id: number,
	text: string,
	status: Exclude<TodoStatus, "cancelled">,
): PendingTodoItem | InProgressTodoItem | CompletedTodoItem;
function freezeTodoItem(id: number, text: string, status: TodoStatus, cancellationReason?: string): TodoItem {
	if (status === "cancelled") {
		if (cancellationReason === undefined) {
			throw new Error("Todo domain invariant failed: a cancelled Todo must have a reason.");
		}
		return Object.freeze({ id, text, status, cancellationReason });
	}
	return Object.freeze({ id, text, status });
}

function unresolvedFromTodos(todos: readonly TodoItem[]): readonly TodoItem[] {
	return Object.freeze(todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress"));
}

function canAllocateIds(nextId: number, itemCount: number): boolean {
	return (
		Number.isSafeInteger(nextId) &&
		nextId > 0 &&
		Number.isSafeInteger(itemCount) &&
		itemCount > 0 &&
		nextId + itemCount - 1 <= Number.MAX_SAFE_INTEGER
	);
}

function isReminderCount(value: unknown): value is ReminderCount {
	return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && TODO_STATUSES.some((status) => status === value);
}

function isTodoCollection(source: ActiveTodoList | readonly TodoItem[]): source is ActiveTodoList {
	return !Array.isArray(source);
}

function isPlainJsonObject(value: unknown): value is JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: JsonRecord, expectedKeys: readonly string[]): boolean {
	const actualKeys = Object.keys(value);
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		actualKeys.length === expectedKeys.length &&
		expectedKeys.every((key) => Object.hasOwn(value, key))
	);
}

function hasOnlyAllowedKeys(value: JsonRecord, allowedKeys: readonly string[]): boolean {
	return (
		Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).every((key) => allowedKeys.includes(key))
	);
}

function isNormalizedNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value === value.trim();
}
