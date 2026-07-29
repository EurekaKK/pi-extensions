import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { TODO_COUNTER_ENTRY_TYPE, TODO_SNAPSHOT_ENTRY_TYPE } from "./constants.js";
import {
	createEmptyRuntimeState,
	createRuntimeState,
	type ReminderCount,
	type RuntimeState,
	type TodoItem,
} from "./domain.js";

export interface TodoSnapshotV1 {
	readonly version: 1;
	readonly activeList: {
		readonly nextId: number;
		readonly todos: readonly TodoItem[];
	} | null;
}

export interface TodoCounterV1 {
	readonly version: 1;
	readonly count: ReminderCount;
}

export interface RestoredTodoState {
	readonly state: RuntimeState;
	readonly foundCorruptEntry: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function parseSnapshot(value: unknown): RuntimeState | null {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "activeList"]) || value.version !== 1) return null;
	if (value.activeList === null) return createEmptyRuntimeState();
	return createRuntimeState(value.activeList, 0);
}

function parseCounter(value: unknown): ReminderCount | null {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "count"]) || value.version !== 1) return null;
	const { count } = value;
	return Number.isInteger(count) && typeof count === "number" && count >= 0 && count <= 4
		? (count as ReminderCount)
		: null;
}

/**
 * Rebuild only from the entries reachable on the current root-to-leaf branch.
 * Recognized but malformed entries are skipped without discarding the last
 * valid state.
 */
export function restoreTodoState(entries: readonly SessionEntry[] | readonly unknown[]): RestoredTodoState {
	let state = createEmptyRuntimeState();
	let foundCorruptEntry = false;

	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || typeof entry.customType !== "string") continue;

		if (entry.customType === TODO_SNAPSHOT_ENTRY_TYPE) {
			const parsed = parseSnapshot(entry.data);
			if (parsed === null) {
				foundCorruptEntry = true;
				continue;
			}
			state = parsed;
			continue;
		}

		if (entry.customType === TODO_COUNTER_ENTRY_TYPE) {
			const count = parseCounter(entry.data);
			if (count === null) {
				foundCorruptEntry = true;
				continue;
			}
			if (state.activeList !== null) {
				const parsed = createRuntimeState(state.activeList, count);
				if (parsed !== null) state = parsed;
			}
		}
	}

	return { state, foundCorruptEntry };
}

export function createTodoSnapshot(state: RuntimeState): TodoSnapshotV1 {
	const activeList =
		state.activeList === null
			? null
			: Object.freeze({
					nextId: state.activeList.nextId,
					todos: Object.freeze(
						state.activeList.todos.map((todo) =>
							todo.status === "cancelled"
								? Object.freeze({
										id: todo.id,
										text: todo.text,
										status: todo.status,
										cancellationReason: todo.cancellationReason,
									})
								: Object.freeze({ id: todo.id, text: todo.text, status: todo.status }),
						),
					),
				});
	return Object.freeze({
		version: 1,
		activeList,
	});
}

export function createTodoCounter(count: ReminderCount): TodoCounterV1 {
	return Object.freeze({ version: 1, count });
}

export function withReminderCount(state: RuntimeState, reminderCount: ReminderCount): RuntimeState {
	if (state.activeList === null && reminderCount !== 0) {
		throw new Error("A reminder count requires an active Todo List.");
	}
	return Object.freeze({ activeList: state.activeList, reminderCount });
}

export class TodoOperationAbortedError extends Error {
	constructor() {
		super("Todo operation aborted.");
		this.name = "AbortError";
	}
}

export class TodoLifecycleChangedError extends Error {
	constructor() {
		super("Todo lifecycle changed before the operation could commit.");
		this.name = "TodoLifecycleChangedError";
	}
}

type CommitState = (state: RuntimeState) => void;
type CoordinatedOperation<T> = (state: RuntimeState, commit: CommitState) => T | Promise<T>;

/**
 * A single FIFO critical section for mutations, reminder accounting, lifecycle
 * replacement, persistence, and UI projection.
 */
export class TodoStateCoordinator {
	#state = createEmptyRuntimeState();
	#generation = 0;
	#tail: Promise<void> = Promise.resolve();

	get generation(): number {
		return this.#generation;
	}

	get state(): RuntimeState {
		return this.#state;
	}

	invalidateLifecycle(): number {
		this.#generation += 1;
		return this.#generation;
	}

	run<T>(expectedGeneration: number, signal: AbortSignal | undefined, operation: CoordinatedOperation<T>): Promise<T> {
		const task = this.#tail.then(async () => {
			this.#assertCurrent(expectedGeneration, signal);
			const commit: CommitState = (nextState) => {
				this.#assertCurrent(expectedGeneration, signal);
				this.#state = nextState;
			};
			return await operation(this.#state, commit);
		});
		this.#tail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	#assertCurrent(expectedGeneration: number, signal: AbortSignal | undefined): void {
		if (signal?.aborted) throw new TodoOperationAbortedError();
		if (expectedGeneration !== this.#generation) throw new TodoLifecycleChangedError();
	}
}
