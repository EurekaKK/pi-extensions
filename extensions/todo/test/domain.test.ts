import { describe, expect, it } from "vitest";
import { TODO_SNAPSHOT_VERSION } from "../src/constants.js";
import {
	countTodos,
	createTodoSnapshot,
	isFullyCompleted,
	normalizeTodoItems,
	parseTodoSnapshot,
} from "../src/domain.js";

describe("Todo v2 domain", () => {
	it("normalizes content, preserves order, and counts statuses", () => {
		const todos = normalizeTodoItems(
			[
				{ content: "  plan  ", status: "in_progress" },
				{ content: "build", status: "pending" },
				{ content: "verify", status: "pending" },
				{ content: "ship", status: "completed" },
			],
			true,
		);

		expect(todos).toEqual([
			{ content: "plan", status: "in_progress" },
			{ content: "build", status: "pending" },
			{ content: "verify", status: "pending" },
			{ content: "ship", status: "completed" },
		]);
		expect(countTodos(todos)).toEqual({ pending: 2, inProgress: 1, completed: 1 });
	});

	it("accepts an empty list", () => {
		expect(normalizeTodoItems([], false)).toEqual([]);
	});

	it("detects the fully completed terminal state", () => {
		expect(isFullyCompleted([{ content: "done", status: "completed" }])).toBe(true);
		expect(
			isFullyCompleted([
				{ content: "a", status: "completed" },
				{ content: "b", status: "completed" },
			]),
		).toBe(true);
		expect(isFullyCompleted([])).toBe(false);
		expect(
			isFullyCompleted([
				{ content: "done", status: "completed" },
				{ content: "left", status: "pending" },
			]),
		).toBe(false);
		expect(isFullyCompleted([{ content: "working", status: "in_progress" }])).toBe(false);
	});

	it.each([
		[[{ content: "   ", status: "pending" }], "non-empty"],
		[
			[
				{ content: "dup", status: "pending" },
				{ content: " dup ", status: "completed" },
			],
			"duplicate content",
		],
	])("rejects invalid content with dsh stable messages", (todos, fragment) => {
		expect(() => normalizeTodoItems(todos, true)).toThrowError(
			expect.objectContaining({ message: expect.stringContaining(fragment) }),
		);
	});

	it("applies allowParallelInProgress as a write-time policy", () => {
		const parallel = [
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "in_progress" },
		];
		expect(() => normalizeTodoItems(parallel, false)).toThrowError(
			"invalid todos: at most one task may be in_progress (got 2)",
		);
		expect(normalizeTodoItems(parallel, true)).toHaveLength(2);
	});

	it("creates immutable version 3 snapshots", () => {
		const snapshot = createTodoSnapshot([{ content: "work", status: "pending" }]);
		expect(snapshot.version).toBe(TODO_SNAPSHOT_VERSION);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.todos)).toBe(true);
		expect(Object.isFrozen(snapshot.todos[0])).toBe(true);
	});

	it("parses valid v2 and v3 snapshots", () => {
		const result = parseTodoSnapshot({
			version: 2,
			todos: [{ content: "work", status: "completed" }],
		});
		expect(result).toMatchObject({ status: "valid" });
		expect(
			parseTodoSnapshot({
				version: 3,
				todos: [
					{
						content: "work",
						status: "pending",
						source: { kind: "plan-step", ref: { planId: "p", planRevision: 1, stepId: "s" } },
					},
				],
			}),
		).toMatchObject({ status: "valid" });
	});

	it("ignores version 1 data without treating it as corruption", () => {
		expect(
			parseTodoSnapshot({
				version: 1,
				activeList: { nextId: 2, todos: [] },
			}),
		).toEqual({ status: "ignored" });
		expect(parseTodoSnapshot({ version: 1 })).toEqual({ status: "ignored" });
	});

	it.each([
		[undefined],
		[null],
		[{ version: 2 }],
		[{ version: 2, todos: "nope" }],
		[{ version: 2, todos: [{ content: "x", status: "pending", extra: 1 }] }],
		[{ version: 2, todos: [{ content: "x", status: "doing" }] }],
		[{ version: 2, todos: [{ content: " ", status: "pending" }] }],
		[
			{
				version: 2,
				todos: [
					{ content: "dup", status: "pending" },
					{ content: "dup", status: "completed" },
				],
			},
		],
	])("marks malformed v2 data invalid", (value) => {
		expect(parseTodoSnapshot(value)).toEqual({ status: "invalid" });
	});

	it("marks malformed v3 snapshots invalid", () => {
		expect(
			parseTodoSnapshot({ version: 3, todos: [{ content: "x", status: "pending", source: { kind: "nope" } }] }),
		).toEqual({
			status: "invalid",
		});
		expect(
			parseTodoSnapshot({ version: 3, todos: [{ content: "a", status: "pending" }], handoffOrigin: { handoffId: "" } }),
		).toEqual({ status: "invalid" });
	});
});
