import { describe, expect, it } from "vitest";
import {
	type ActiveTodoList,
	addTodos,
	createEmptyRuntimeState,
	createRuntimeState,
	createTodoList,
	getTodoCounts,
	getUnresolvedTodos,
	isValidActiveTodoList,
	type RuntimeState,
	type TodoMutationFailure,
	type TodoMutationResult,
	type TodoMutationSuccess,
	type TodoUpdate,
	updateTodos,
} from "../src/domain.js";

function mustSucceed(result: TodoMutationResult): TodoMutationSuccess {
	if (!result.ok) {
		throw new Error(`${result.error.code}: ${result.error.message}`);
	}
	return result;
}

function mustFail(result: TodoMutationResult): TodoMutationFailure {
	if (result.ok) {
		throw new Error(`Expected a rejection, received ${result.outcome}.`);
	}
	return result;
}

function createActive(items: readonly string[] = ["first", "second"]): TodoMutationSuccess {
	return mustSucceed(createTodoList(createEmptyRuntimeState(), items));
}

function withReminderCount(state: RuntimeState, reminderCount: 0 | 1 | 2 | 3 | 4): RuntimeState {
	const restored = createRuntimeState(state.activeList, reminderCount);
	if (restored === null) {
		throw new Error("Expected a valid runtime state.");
	}
	return restored;
}

describe("Todo List creation", () => {
	it("creates trimmed, immutable pending Todos with IDs starting at one", () => {
		const input = ["  investigate Pi  ", "implement state"];
		const result = mustSucceed(createTodoList(createEmptyRuntimeState(), input));

		expect(result.outcome).toBe("created");
		expect(result.state.reminderCount).toBe(0);
		expect(result.state.activeList).toEqual({
			nextId: 3,
			todos: [
				{ id: 1, text: "investigate Pi", status: "pending" },
				{ id: 2, text: "implement state", status: "pending" },
			],
		});
		expect(result.changedTodos).toEqual(result.todos);
		expect(result.unresolvedTodos).toEqual(result.todos);
		expect(result.counts).toEqual({
			total: 2,
			pending: 2,
			inProgress: 0,
			completed: 0,
			cancelled: 0,
			unresolved: 2,
		});
		expect(input).toEqual(["  investigate Pi  ", "implement state"]);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.state)).toBe(true);
		expect(Object.isFrozen(result.state.activeList)).toBe(true);
		expect(Object.isFrozen(result.todos)).toBe(true);
		expect(result.todos.every(Object.isFrozen)).toBe(true);
		expect(() => Object.defineProperty(result.todos[0], "text", { value: "rewritten" })).toThrow();
	});

	it("rejects empty and blank item batches", () => {
		for (const items of [[], ["ok", " \t\n "]] as const) {
			const state = createEmptyRuntimeState();
			const failure = mustFail(createTodoList(state, items));
			expect(failure.error.code).toBe("todo_invalid_arguments");
			expect(failure.state).toBe(state);
		}
	});

	it("allows duplicate text because distinct IDs represent distinct Todos", () => {
		const result = createActive(["same", " same "]);
		expect(result.todos).toEqual([
			{ id: 1, text: "same", status: "pending" },
			{ id: 2, text: "same", status: "pending" },
		]);
	});

	it("rejects a second list and returns the original state reference", () => {
		const original = createActive();
		const failure = mustFail(createTodoList(original.state, ["third"]));

		expect(failure.error.code).toBe("todo_active_list_exists");
		expect(failure.state).toBe(original.state);
		expect(failure.error.message).toContain("unresolved");
	});
});

describe("adding Todos", () => {
	it("allocates consecutive IDs while retaining terminal and unresolved items", () => {
		const created = createActive(["done soon", "still open"]);
		const partiallyUpdated = mustSucceed(updateTodos(created.state, [{ id: 1, status: "completed" }]));
		const countedState = withReminderCount(partiallyUpdated.state, 4);
		const added = mustSucceed(addTodos(countedState, [" new one ", "new two"]));

		expect(added.outcome).toBe("added");
		expect(added.state.reminderCount).toBe(0);
		expect(added.state.activeList?.nextId).toBe(5);
		expect(added.todos).toEqual([
			{ id: 1, text: "done soon", status: "completed" },
			{ id: 2, text: "still open", status: "pending" },
			{ id: 3, text: "new one", status: "pending" },
			{ id: 4, text: "new two", status: "pending" },
		]);
		expect(added.changedTodos.map((todo) => todo.id)).toEqual([3, 4]);
		expect(added.unresolvedTodos.map((todo) => todo.id)).toEqual([2, 3, 4]);
	});

	it("rejects add when no list is active", () => {
		const state = createEmptyRuntimeState();
		const failure = mustFail(addTodos(state, ["work"]));
		expect(failure.error.code).toBe("todo_no_active_list");
		expect(failure.state).toBe(state);
	});
});

describe("one-way status transitions", () => {
	it("supports every pending target and multiple simultaneous in-progress Todos", () => {
		const created = createActive(["a", "b", "c", "keep open"]);
		const result = mustSucceed(
			updateTodos(created.state, [
				{ id: 1, status: "in_progress" },
				{ id: 2, status: "in_progress" },
				{ id: 3, status: "cancelled", reason: "  superseded by #4  " },
			]),
		);

		expect(result.todos).toEqual([
			{ id: 1, text: "a", status: "in_progress" },
			{ id: 2, text: "b", status: "in_progress" },
			{ id: 3, text: "c", status: "cancelled", cancellationReason: "superseded by #4" },
			{ id: 4, text: "keep open", status: "pending" },
		]);
		expect(result.counts.inProgress).toBe(2);

		const terminal = mustSucceed(
			updateTodos(result.state, [
				{ id: 1, status: "completed" },
				{ id: 2, status: "cancelled", reason: "no longer needed" },
			]),
		);
		expect(terminal.todos[0]?.status).toBe("completed");
		expect(terminal.todos[1]).toEqual({
			id: 2,
			text: "b",
			status: "cancelled",
			cancellationReason: "no longer needed",
		});
	});

	it("allows a pending Todo to complete directly", () => {
		const created = createActive(["finish", "keep open"]);
		const result = mustSucceed(updateTodos(created.state, [{ id: 1, status: "completed" }]));
		expect(result.todos[0]?.status).toBe("completed");
	});

	it("rejects moving in-progress back to pending", () => {
		const created = createActive(["started", "keep open"]);
		const started = mustSucceed(updateTodos(created.state, [{ id: 1, status: "in_progress" }]));
		const failure = mustFail(updateTodos(started.state, [{ id: 1, status: "pending" }]));

		expect(failure.error.code).toBe("todo_invalid_transition");
		expect(failure.error.todoId).toBe(1);
		expect(failure.state).toBe(started.state);
	});

	it("rejects every change to terminal Todos", () => {
		const created = createActive(["completed", "cancelled", "keep open"]);
		const terminal = mustSucceed(
			updateTodos(created.state, [
				{ id: 1, status: "completed" },
				{ id: 2, status: "cancelled", reason: "obsolete" },
			]),
		);

		for (const update of [
			{ id: 1, status: "in_progress" },
			{ id: 1, status: "cancelled", reason: "changed mind" },
			{ id: 2, status: "completed" },
			{ id: 2, status: "pending" },
		] satisfies TodoUpdate[]) {
			const failure = mustFail(updateTodos(terminal.state, [update]));
			expect(failure.error.code).toBe("todo_invalid_transition");
			expect(failure.state).toBe(terminal.state);
		}
	});

	it("treats a repeated status as a rejected no-op", () => {
		const created = createActive(["started", "keep open"]);
		const started = mustSucceed(updateTodos(created.state, [{ id: 1, status: "in_progress" }]));
		const countedState = withReminderCount(started.state, 3);
		const failure = mustFail(updateTodos(countedState, [{ id: 1, status: "in_progress" }]));

		expect(failure.error.code).toBe("todo_no_state_change");
		expect(failure.error.message).toContain("no Todo was changed");
		expect(failure.error.message).toContain("reminder counter was not reset");
		expect(failure.state).toBe(countedState);
		expect(failure.state.reminderCount).toBe(3);
	});

	it("never edits Todo text and rejects an injected text field", () => {
		const created = createActive(["original", "keep open"]);
		const legal = mustSucceed(updateTodos(created.state, [{ id: 1, status: "completed" }]));
		expect(legal.todos[0]?.text).toBe("original");

		const illegalUpdates = [{ id: 2, status: "completed", text: "rewritten" }] as unknown as readonly TodoUpdate[];
		const failure = mustFail(updateTodos(legal.state, illegalUpdates));
		expect(failure.error.code).toBe("todo_invalid_arguments");
		expect(failure.state).toBe(legal.state);
		expect(legal.todos[1]?.text).toBe("keep open");
	});
});

describe("cancellation reasons", () => {
	it("requires a non-blank cancellation reason", () => {
		const state = createActive().state;
		for (const update of [
			{ id: 1, status: "cancelled" },
			{ id: 1, status: "cancelled", reason: " \t " },
			{ id: 1, status: "cancelled", reason: undefined },
		] as unknown as readonly TodoUpdate[]) {
			const failure = mustFail(updateTodos(state, [update]));
			expect(failure.error.code).toBe("todo_cancellation_reason_required");
			expect(failure.state).toBe(state);
		}
	});

	it("forbids a reason for every non-cancelled target", () => {
		const state = createActive().state;
		for (const status of ["pending", "in_progress", "completed"] as const) {
			const failure = mustFail(updateTodos(state, [{ id: 1, status, reason: "not allowed" }]));
			expect(failure.error.code).toBe("todo_cancellation_reason_forbidden");
			expect(failure.state).toBe(state);
		}
	});
});

describe("atomic update batches", () => {
	function atomicSource(): RuntimeState {
		const created = createActive(["started", "second", "third"]);
		const started = mustSucceed(updateTodos(created.state, [{ id: 1, status: "in_progress" }]));
		return withReminderCount(started.state, 4);
	}

	it("commits every valid update together and resets the reminder count", () => {
		const state = atomicSource();
		const result = mustSucceed(
			updateTodos(state, [
				{ id: 1, status: "completed" },
				{ id: 2, status: "cancelled", reason: "  unnecessary  " },
			]),
		);

		expect(result.outcome).toBe("updated");
		expect(result.state.reminderCount).toBe(0);
		expect(result.changedTodos.map((todo) => todo.id)).toEqual([1, 2]);
		expect(result.todos).toEqual([
			{ id: 1, text: "started", status: "completed" },
			{ id: 2, text: "second", status: "cancelled", cancellationReason: "unnecessary" },
			{ id: 3, text: "third", status: "pending" },
		]);
	});

	it.each([
		{
			name: "an unknown ID",
			code: "todo_not_found",
			updates: [
				{ id: 2, status: "completed" },
				{ id: 99, status: "completed" },
			] satisfies TodoUpdate[],
		},
		{
			name: "a duplicate ID",
			code: "todo_duplicate_update_id",
			updates: [
				{ id: 2, status: "completed" },
				{ id: 2, status: "cancelled", reason: "duplicate" },
			] satisfies TodoUpdate[],
		},
		{
			name: "one invalid transition",
			code: "todo_invalid_transition",
			updates: [
				{ id: 2, status: "completed" },
				{ id: 1, status: "pending" },
			] satisfies TodoUpdate[],
		},
		{
			name: "one repeated status",
			code: "todo_no_state_change",
			updates: [
				{ id: 2, status: "completed" },
				{ id: 1, status: "in_progress" },
			] satisfies TodoUpdate[],
		},
	])("rejects the whole batch when it contains $name", ({ code, updates }) => {
		const state = atomicSource();
		const before = JSON.stringify(state);
		const failure = mustFail(updateTodos(state, updates));

		expect(failure.error.code).toBe(code);
		expect(failure.state).toBe(state);
		expect(failure.state.reminderCount).toBe(4);
		expect(JSON.stringify(state)).toBe(before);
		expect(state.activeList?.todos).toEqual([
			{ id: 1, text: "started", status: "in_progress" },
			{ id: 2, text: "second", status: "pending" },
			{ id: 3, text: "third", status: "pending" },
		]);
	});

	it("rejects an empty update batch without touching state", () => {
		const state = atomicSource();
		const failure = mustFail(updateTodos(state, []));
		expect(failure.error.code).toBe("todo_invalid_arguments");
		expect(failure.state).toBe(state);
	});
});

describe("automatic close", () => {
	it("closes when the final unresolved Todo becomes terminal and reports final counts", () => {
		const created = createActive(["finish", "cancel"]);
		const first = mustSucceed(updateTodos(created.state, [{ id: 1, status: "completed" }]));
		const counted = withReminderCount(first.state, 3);
		const closed = mustSucceed(
			updateTodos(counted, [{ id: 2, status: "cancelled", reason: "  no longer required  " }]),
		);

		expect(closed.outcome).toBe("closed");
		expect(closed.state).toBe(createEmptyRuntimeState());
		expect(closed.state).toEqual({ activeList: null, reminderCount: 0 });
		expect(closed.unresolvedTodos).toEqual([]);
		expect(closed.counts).toEqual({
			total: 2,
			pending: 0,
			inProgress: 0,
			completed: 1,
			cancelled: 1,
			unresolved: 0,
		});
		expect(closed.todos).toEqual([
			{ id: 1, text: "finish", status: "completed" },
			{ id: 2, text: "cancel", status: "cancelled", cancellationReason: "no longer required" },
		]);
	});

	it("allows an unrelated new list after close and restarts IDs at one", () => {
		const original = createActive(["old"]);
		const closed = mustSucceed(updateTodos(original.state, [{ id: 1, status: "completed" }]));
		const noListFailure = mustFail(updateTodos(closed.state, [{ id: 1, status: "in_progress" }]));
		expect(noListFailure.error.code).toBe("todo_no_active_list");

		const next = mustSucceed(createTodoList(closed.state, ["new"]));
		expect(next.todos).toEqual([{ id: 1, text: "new", status: "pending" }]);
	});
});

describe("queries and persisted-state validation", () => {
	it("counts statuses and selects unresolved Todos without exposing mutable arrays", () => {
		const created = createActive(["a", "b", "c", "d"]);
		const updated = mustSucceed(
			updateTodos(created.state, [
				{ id: 1, status: "in_progress" },
				{ id: 2, status: "completed" },
				{ id: 3, status: "cancelled", reason: "obsolete" },
			]),
		);
		const list = updated.state.activeList;
		if (list === null) {
			throw new Error("Expected an active list.");
		}

		expect(getTodoCounts(list)).toEqual({
			total: 4,
			pending: 1,
			inProgress: 1,
			completed: 1,
			cancelled: 1,
			unresolved: 2,
		});
		expect(getTodoCounts(list.todos)).toEqual(getTodoCounts(list));
		expect(getUnresolvedTodos(list).map((todo) => todo.id)).toEqual([1, 4]);
		expect(Object.isFrozen(getUnresolvedTodos(list))).toBe(true);
		expect(getUnresolvedTodos(null)).toEqual([]);
	});

	it("accepts a valid active list, deep-copies it, and restores counts zero through four", () => {
		const raw = {
			nextId: 3,
			todos: [
				{ id: 1, text: "done", status: "completed" },
				{ id: 2, text: "work", status: "in_progress" },
			],
		};
		expect(isValidActiveTodoList(raw)).toBe(true);

		for (const count of [0, 1, 2, 3, 4] as const) {
			const restored = createRuntimeState(raw, count);
			expect(restored?.reminderCount).toBe(count);
			expect(restored?.activeList).toEqual(raw);
			expect(restored?.activeList).not.toBe(raw);
			expect(restored?.activeList?.todos).not.toBe(raw.todos);
			expect(Object.isFrozen(restored)).toBe(true);
			expect(Object.isFrozen(restored?.activeList)).toBe(true);
			expect(restored?.activeList?.todos.every(Object.isFrozen)).toBe(true);
		}

		const restored = createRuntimeState(raw, 2);
		raw.todos[1] = { id: 2, text: "mutated outside", status: "pending" };
		expect(restored?.activeList?.todos[1]?.text).toBe("work");
	});

	it.each([
		["unknown list field", { nextId: 2, todos: [{ id: 1, text: "x", status: "pending" }], extra: true }],
		["empty active list", { nextId: 1, todos: [] }],
		["incorrect nextId", { nextId: 3, todos: [{ id: 1, text: "x", status: "pending" }] }],
		[
			"non-contiguous IDs",
			{
				nextId: 3,
				todos: [
					{ id: 1, text: "x", status: "pending" },
					{ id: 3, text: "y", status: "pending" },
				],
			},
		],
		["blank text", { nextId: 2, todos: [{ id: 1, text: " ", status: "pending" }] }],
		["untrimmed text", { nextId: 2, todos: [{ id: 1, text: " x ", status: "pending" }] }],
		["unknown status", { nextId: 2, todos: [{ id: 1, text: "x", status: "blocked" }] }],
		["cancelled without reason", { nextId: 2, todos: [{ id: 1, text: "x", status: "cancelled" }] }],
		[
			"cancelled with blank reason",
			{
				nextId: 3,
				todos: [
					{ id: 1, text: "x", status: "cancelled", cancellationReason: " " },
					{ id: 2, text: "y", status: "pending" },
				],
			},
		],
		[
			"cancelled with untrimmed reason",
			{
				nextId: 3,
				todos: [
					{ id: 1, text: "x", status: "cancelled", cancellationReason: " obsolete " },
					{ id: 2, text: "y", status: "pending" },
				],
			},
		],
		[
			"reason on a non-cancelled Todo",
			{
				nextId: 2,
				todos: [{ id: 1, text: "x", status: "pending", cancellationReason: "forbidden" }],
			},
		],
		["unknown Todo field", { nextId: 2, todos: [{ id: 1, text: "x", status: "pending", priority: "high" }] }],
		[
			"all Todos terminal",
			{
				nextId: 3,
				todos: [
					{ id: 1, text: "x", status: "completed" },
					{ id: 2, text: "y", status: "cancelled", cancellationReason: "obsolete" },
				],
			},
		],
	] as const)("rejects persisted state with %s", (_name, value) => {
		expect(isValidActiveTodoList(value)).toBe(false);
		expect(createRuntimeState(value, 0)).toBeNull();
	});

	it("rejects invalid reminder counts and non-zero counts without an active list", () => {
		const validList: ActiveTodoList = createActive().state.activeList as ActiveTodoList;
		for (const count of [-1, 5, 1.5, "3", null]) {
			expect(createRuntimeState(validList, count)).toBeNull();
		}
		expect(createRuntimeState(null, 1)).toBeNull();
		expect(createRuntimeState(null, 0)).toBe(createEmptyRuntimeState());
	});
});
