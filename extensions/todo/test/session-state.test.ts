import { describe, expect, it } from "vitest";
import { createEmptyRuntimeState, createTodoList, type RuntimeState, updateTodos } from "../src/domain.js";
import {
	createTodoCounter,
	createTodoSnapshot,
	restoreTodoState,
	TodoLifecycleChangedError,
	TodoOperationAbortedError,
	TodoStateCoordinator,
	withReminderCount,
} from "../src/session-state.js";

function activeState(items: readonly string[] = ["first", "second"]): RuntimeState {
	const result = createTodoList(createEmptyRuntimeState(), items);
	if (!result.ok) throw new Error(result.error.message);
	return result.state;
}

function custom(customType: string, data: unknown): unknown {
	return { type: "custom", customType, data };
}

describe("Todo session entries", () => {
	it("replays snapshots and counters in branch order", () => {
		const created = activeState();
		const updated = updateTodos(created, [{ id: 1, status: "in_progress" }]);
		if (!updated.ok) throw new Error(updated.error.message);

		const restored = restoreTodoState([
			custom("todo:snapshot", createTodoSnapshot(created)),
			custom("todo:counter", createTodoCounter(2)),
			custom("unrelated", { value: true }),
			custom("todo:snapshot", createTodoSnapshot(updated.state)),
			custom("todo:counter", createTodoCounter(3)),
		]);

		expect(restored.foundCorruptEntry).toBe(false);
		expect(restored.state.reminderCount).toBe(3);
		expect(restored.state.activeList?.todos[0]?.status).toBe("in_progress");
	});

	it("ignores orphaned counters after a null snapshot", () => {
		const restored = restoreTodoState([
			custom("todo:snapshot", createTodoSnapshot(activeState())),
			custom("todo:counter", createTodoCounter(4)),
			custom("todo:snapshot", { version: 1, activeList: null }),
			custom("todo:counter", createTodoCounter(3)),
		]);

		expect(restored.state).toEqual({ activeList: null, reminderCount: 0 });
		expect(restored.foundCorruptEntry).toBe(false);
	});

	it("skips malformed recognized entries and retains the latest valid state", () => {
		const valid = activeState();
		const restored = restoreTodoState([
			custom("todo:snapshot", createTodoSnapshot(valid)),
			custom("todo:counter", { version: 1, count: 2, extra: true }),
			custom("todo:snapshot", {
				version: 1,
				activeList: {
					nextId: 2,
					todos: [{ id: 1, text: "terminal only", status: "completed" }],
				},
			}),
			custom("todo:snapshot", { version: 2, activeList: null }),
			custom("todo:counter", createTodoCounter(4)),
		]);

		expect(restored.foundCorruptEntry).toBe(true);
		expect(restored.state.activeList).toEqual(valid.activeList);
		expect(restored.state.reminderCount).toBe(4);
	});

	it("uses only the entries supplied for the selected branch", () => {
		const branchPoint = activeState(["branch work"]);
		const completed = updateTodos(branchPoint, [{ id: 1, status: "completed" }]);
		if (!completed.ok) throw new Error(completed.error.message);

		const closedBranch = restoreTodoState([
			custom("todo:snapshot", createTodoSnapshot(branchPoint)),
			custom("todo:snapshot", createTodoSnapshot(completed.state)),
		]);
		const historicalBranch = restoreTodoState([custom("todo:snapshot", createTodoSnapshot(branchPoint))]);

		expect(closedBranch.state.activeList).toBeNull();
		expect(historicalBranch.state.activeList?.todos[0]?.status).toBe("pending");
	});

	it("creates a detached, deeply frozen snapshot", () => {
		const state = activeState();
		const snapshot = createTodoSnapshot(state);

		expect(snapshot).toEqual({ version: 1, activeList: state.activeList });
		expect(snapshot.activeList).not.toBe(state.activeList);
		expect(snapshot.activeList?.todos).not.toBe(state.activeList?.todos);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.activeList)).toBe(true);
		expect(Object.isFrozen(snapshot.activeList?.todos)).toBe(true);
		expect(snapshot.activeList?.todos.every(Object.isFrozen)).toBe(true);
	});
});

describe("Todo state coordinator", () => {
	it("refuses a non-zero counter without an active list", () => {
		expect(() => withReminderCount(createEmptyRuntimeState(), 1)).toThrow("requires an active Todo List");
	});

	it("serializes operations in FIFO order", async () => {
		const coordinator = new TodoStateCoordinator();
		const generation = coordinator.invalidateLifecycle();
		const trace: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = coordinator.run(generation, undefined, async (_state, commit) => {
			trace.push("first:start");
			await gate;
			commit(activeState(["first"]));
			trace.push("first:end");
		});
		const second = coordinator.run(generation, undefined, (state, commit) => {
			trace.push("second:start");
			commit(withReminderCount(state, 1));
			trace.push("second:end");
		});

		await Promise.resolve();
		expect(trace).toEqual(["first:start"]);
		releaseFirst?.();
		await Promise.all([first, second]);

		expect(trace).toEqual(["first:start", "first:end", "second:start", "second:end"]);
		expect(coordinator.state.reminderCount).toBe(1);
	});

	it("honors an AbortSignal while an operation waits in the queue", async () => {
		const coordinator = new TodoStateCoordinator();
		const generation = coordinator.invalidateLifecycle();
		let releaseFirst: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = coordinator.run(generation, undefined, async () => {
			await gate;
		});
		const controller = new AbortController();
		let entered = false;
		const cancelled = coordinator.run(generation, controller.signal, () => {
			entered = true;
		});

		controller.abort();
		releaseFirst?.();
		await first;
		await expect(cancelled).rejects.toBeInstanceOf(TodoOperationAbortedError);
		expect(entered).toBe(false);
	});

	it("prevents a stale generation from committing after lifecycle replacement", async () => {
		const coordinator = new TodoStateCoordinator();
		const oldGeneration = coordinator.invalidateLifecycle();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stale = coordinator.run(oldGeneration, undefined, async (_state, commit) => {
			await gate;
			commit(activeState(["stale"]));
		});
		await Promise.resolve();

		const currentGeneration = coordinator.invalidateLifecycle();
		const replacement = coordinator.run(currentGeneration, undefined, (_state, commit) => {
			commit(activeState(["current"]));
		});
		release?.();

		await expect(stale).rejects.toBeInstanceOf(TodoLifecycleChangedError);
		await replacement;
		expect(coordinator.state.activeList?.todos[0]?.text).toBe("current");
	});
});
