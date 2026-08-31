import { describe, expect, it } from "vitest";
import {
	createTodoSnapshotV3,
	foldTodoSnapshots,
	hasCommittedHandoff,
	normalizeTodoList,
	parseTodoReplaceRequest,
	parseTodoReplaceResult,
	parseTodoSnapshot,
	TODO_REPLACE_REQUEST_EVENT,
	TODO_SNAPSHOT_ENTRY_TYPE,
	TODO_SNAPSHOT_VERSION,
} from "../src/index.js";

const SOURCE = Object.freeze({
	kind: "plan-step",
	ref: Object.freeze({ planId: "plan-1", planRevision: 2, stepId: "step-3" }),
});

function snapshotEntry(data: unknown): { type: string; customType: string; data: unknown } {
	return { type: "custom", customType: TODO_SNAPSHOT_ENTRY_TYPE, data };
}

describe("todo-protocol snapshot parsing", () => {
	it("parses a valid v3 snapshot with sources and handoff origin", () => {
		const result = parseTodoSnapshot({
			version: 3,
			todos: [
				{ content: "a", status: "pending", source: SOURCE },
				{ content: "b", status: "completed" },
			],
			handoffOrigin: { handoffId: "handoff-1" },
		});
		expect(result.status).toBe("valid");
		if (result.status !== "valid") throw new Error("unreachable");
		expect(result.todos[0]?.source?.ref.planRevision).toBe(2);
		expect(result.handoffOrigin?.handoffId).toBe("handoff-1");
	});

	it("accepts v2 as valid unlinked state", () => {
		const result = parseTodoSnapshot({
			version: 2,
			todos: [
				{ content: "a", status: "in_progress" },
				{ content: "b", status: "pending" },
			],
		});
		expect(result.status).toBe("valid");
		if (result.status !== "valid") throw new Error("unreachable");
		expect(result.todos[0]?.source).toBeUndefined();
		expect(result.handoffOrigin).toBeUndefined();
	});

	it("ignores version 1 and unknown versions silently", () => {
		expect(parseTodoSnapshot({ version: 1, todos: [] }).status).toBe("ignored");
		expect(parseTodoSnapshot({ version: 4, todos: [] }).status).toBe("ignored");
		expect(parseTodoSnapshot("nonsense").status).toBe("invalid");
	});

	it("rejects malformed v3 shapes", () => {
		expect(parseTodoSnapshot({ version: 3, todos: "nope" }).status).toBe("invalid");
		expect(parseTodoSnapshot({ version: 3, todos: [{ content: "", status: "pending" }] }).status).toBe("invalid");
		expect(parseTodoSnapshot({ version: 3, todos: [{ content: "x", status: "done" }] }).status).toBe("invalid");
		expect(
			parseTodoSnapshot({ version: 3, todos: [{ content: "x", status: "pending", source: { kind: "other" } }] }).status,
		).toBe("invalid");
		expect(
			parseTodoSnapshot({
				version: 3,
				todos: [
					{ content: "x", status: "pending" },
					{ content: " x ", status: "pending" },
				],
			}).status,
		).toBe("invalid");
		expect(parseTodoSnapshot({ version: 3, todos: [], handoffOrigin: { handoffId: "" } }).status).toBe("invalid");
	});

	it("creates deeply frozen snapshots", () => {
		const snapshot = createTodoSnapshotV3([{ content: "a", status: "pending", source: SOURCE }], {
			handoffId: "h-1",
		});
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.todos[0])).toBe(true);
		expect(() => {
			(snapshot.todos[0] as { content: string }).content = "changed";
		}).toThrow();
	});
});

describe("todo-protocol normalization", () => {
	it("trims, rejects blanks and duplicates with stable errors", () => {
		expect(() => normalizeTodoList([{ content: "", status: "pending" }])).toThrow(
			"invalid todo: `content` must be a non-empty string",
		);
		expect(() => normalizeTodoList([{ content: "  ", status: "pending" }])).toThrow(
			"invalid todo: `content` must be a non-empty string",
		);
		expect(() =>
			normalizeTodoList([
				{ content: "a", status: "pending" },
				{ content: "a", status: "completed" },
			]),
		).toThrow('invalid todos: duplicate content "a"');
		expect(() => normalizeTodoList([{ content: "a", status: "pending", source: { kind: "plan-step" } }])).toThrow(
			"invalid todo: `source` must be a plan step reference",
		);
	});

	it("normalizes and preserves valid sources", () => {
		const todos = normalizeTodoList([
			{ content: "  a  ", status: "pending", source: SOURCE },
			{ content: "b", status: "completed" },
		]);
		expect(todos[0]).toEqual({ content: "a", status: "pending", source: SOURCE });
		expect(todos[1]?.source).toBeUndefined();
	});
});

describe("todo-protocol folding", () => {
	it("last-write-wins over reachable snapshots and reports invalid", () => {
		const state = foldTodoSnapshots([
			snapshotEntry({ version: 3, todos: [{ content: "first", status: "pending" }] }),
			snapshotEntry({ version: 3, todos: [{ content: "broken" }] }),
			snapshotEntry({
				version: 3,
				todos: [{ content: "second", status: "in_progress" }],
				handoffOrigin: { handoffId: "h-1" },
			}),
			snapshotEntry({ version: 1, todos: [] }),
		]);
		expect(state.foundInvalid).toBe(true);
		expect(state.todos[0]).toEqual({ content: "second", status: "in_progress" });
		expect(state.handoffOrigin?.handoffId).toBe("h-1");
	});

	it("detects a committed handoff on any reachable snapshot", () => {
		const entries = [
			snapshotEntry({ version: 3, todos: [{ content: "a", status: "pending" }], handoffOrigin: { handoffId: "h-9" } }),
			snapshotEntry({ version: 3, todos: [{ content: "b", status: "completed" }] }),
		];
		expect(hasCommittedHandoff(entries, "h-9")).toBe(true);
		expect(hasCommittedHandoff(entries, "h-other")).toBe(false);
	});
});

describe("todo-protocol handoff envelope", () => {
	it("validates replace requests strictly", () => {
		const request = parseTodoReplaceRequest({
			version: 1,
			requestId: "req-1",
			sessionId: "session-1",
			handoffId: "h-1",
			todos: [{ content: "a", status: "pending", source: SOURCE }],
		});
		expect(request).not.toBeNull();
		expect(request?.todos[0]?.source?.ref.stepId).toBe("step-3");
		expect(
			parseTodoReplaceRequest({ version: 1, requestId: "", sessionId: "s", handoffId: "h", todos: [] }),
		).toBeNull();
		expect(
			parseTodoReplaceRequest({ version: 2, requestId: "r", sessionId: "s", handoffId: "h", todos: [] }),
		).toBeNull();
		expect(
			parseTodoReplaceRequest({
				version: 1,
				requestId: "r",
				sessionId: "s",
				handoffId: "h",
				todos: [
					{ content: "x", status: "pending" },
					{ content: "x", status: "pending" },
				],
			}),
		).toBeNull();
		expect(TODO_REPLACE_REQUEST_EVENT).toBe("todo:replace-request");
	});

	it("validates replace results", () => {
		expect(parseTodoReplaceResult({ version: 1, requestId: "r", applied: true })).not.toBeNull();
		expect(parseTodoReplaceResult({ version: 1, requestId: "r", applied: false, error: "boom" })).not.toBeNull();
		expect(parseTodoReplaceResult({ version: 1, requestId: "r", applied: "yes" })).toBeNull();
	});

	it("keeps the canonical snapshot version at 3", () => {
		expect(TODO_SNAPSHOT_VERSION).toBe(3);
	});
});
