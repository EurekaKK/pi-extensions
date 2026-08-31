import { type Tool, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	PROGRESS_WIDGET_ATTACH_EVENT,
	PROGRESS_WIDGET_RELEASE_EVENT,
	PROGRESS_WIDGET_STATE_EVENT,
} from "progress-widget-protocol";
import { type CapturedTool, FakePiHost } from "test-host";
import { TODO_REPLACE_REQUEST_EVENT } from "todo-protocol";
import { describe, expect, it } from "vitest";
import type { TodoConfigV1 } from "../src/config.js";
import { TODO_SNAPSHOT_ENTRY_TYPE, TODO_TOOL_NAME, TODO_WIDGET_KEY } from "../src/constants.js";
import { registerTodoExtension } from "../src/index.js";
import type { TodoWriteDetailsV2 } from "../src/tool.js";

interface AppendedEntry {
	readonly customType: string;
	readonly data: unknown;
}

interface ToolMessage {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
	readonly details: unknown;
	readonly isError: boolean;
	readonly timestamp: number;
}

class TodoHarness {
	readonly host: FakePiHost;
	readonly context: ExtensionContext;
	readonly config: TodoConfigV1;

	constructor(mode: ExtensionContext["mode"] = "tui", hasUI = true, config?: TodoConfigV1) {
		this.config = config ?? Object.freeze({ version: 1, allowParallelInProgress: false });
		this.host = new FakePiHost({ mode, hasUI });
		this.context = this.host.context;
		registerTodoExtension(this.host.api, this.config);
	}

	get tool(): CapturedTool {
		const tool = this.host.tools[0];
		if (tool === undefined) throw new Error("Todo tool was not registered.");
		return tool;
	}

	get appendedEntries(): readonly AppendedEntry[] {
		return this.host.appendedEntries;
	}

	get setWidget(): FakePiHost["ui"]["setWidget"] {
		return this.host.ui.setWidget;
	}

	get notify(): FakePiHost["ui"]["notify"] {
		return this.host.ui.notify;
	}

	get failAppend(): boolean {
		return this.host.failAppend;
	}

	set failAppend(value: boolean) {
		this.host.failAppend = value;
	}

	setBranch(entries: readonly SessionEntry[]): void {
		this.host.setBranch(entries);
	}

	async lifecycle(event: "session_start" | "session_tree" | "session_shutdown"): Promise<void> {
		await this.emit(event, { type: event });
	}

	async turnStart(): Promise<void> {
		await this.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });
	}

	async emit(event: string, payload: Record<string, unknown>): Promise<void> {
		await this.host.emit(event, payload);
	}

	async invokeTodo(
		parameters: unknown,
		toolCallId = `todo-${this.host.appendedEntries.length + 1}`,
	): Promise<ToolMessage> {
		let result: AgentToolResult<TodoWriteDetailsV2>;
		let isError = false;
		try {
			const validatedParameters: unknown = validateToolArguments(
				{
					name: this.tool.name,
					description: this.tool.description,
					parameters: this.tool.parameters,
				} as Tool,
				{
					type: "toolCall",
					id: toolCallId,
					name: this.tool.name,
					arguments: parameters,
				} as ToolCall,
			);
			result = (await this.tool.execute(
				toolCallId,
				validatedParameters as never,
				undefined,
				undefined,
				this.context,
			)) as AgentToolResult<TodoWriteDetailsV2>;
		} catch (error) {
			isError = true;
			result = {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				details: {} as TodoWriteDetailsV2,
			};
		}
		return {
			role: "toolResult",
			toolCallId,
			toolName: this.tool.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};
	}
}

function text(message: ToolMessage): string {
	return message.content.map((block) => block.text ?? "").join("\n");
}

function entry(id: string, parentId: string | null, entryData: Record<string, unknown>): SessionEntry {
	return { id, parentId, timestamp: new Date().toISOString(), ...entryData } as SessionEntry;
}

function userEntry(id: string, parentId: string | null): SessionEntry {
	return entry(id, parentId, {
		type: "message",
		message: { role: "user", content: "next turn", timestamp: Date.now() },
	});
}

function customEntry(id: string, parentId: string | null, data: unknown): SessionEntry {
	return entry(id, parentId, { type: "custom", customType: TODO_SNAPSHOT_ENTRY_TYPE, data });
}

const CONFIG_FALSE: TodoConfigV1 = Object.freeze({ version: 1, allowParallelInProgress: false });
const CONFIG_TRUE: TodoConfigV1 = Object.freeze({ version: 1, allowParallelInProgress: true });

describe("Todo v2 extension", () => {
	it("registers one parallel todo_write tool with a policy-driven description", () => {
		const harness = new TodoHarness("tui", true, CONFIG_FALSE);

		expect(harness.host.tools).toHaveLength(1);
		expect(harness.tool.name).toBe(TODO_TOOL_NAME);
		expect(harness.tool.label).toBe("Todo");
		expect(harness.tool.executionMode).toBe("parallel");
		expect(harness.tool.promptGuidelines).toBeUndefined();
		expect(harness.tool.description).toContain("Send the ENTIRE list every call");
		expect(harness.tool.description).toContain("Keep AT MOST ONE todo `in_progress`");
		expect(harness.tool.description).not.toContain("several at once when work genuinely runs in parallel");

		const parallel = new TodoHarness("tui", true, CONFIG_TRUE);
		expect(parallel.tool.description).toContain("several at once when work genuinely runs in parallel");
		expect(parallel.tool.description).not.toContain("AT MOST ONE");
	});

	it("persists the trimmed whole list and returns the dsh success text", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		await harness.lifecycle("session_start");

		const result = await harness.invokeTodo({
			todos: [
				{ content: "  plan  ", status: "in_progress" },
				{ content: "build", status: "pending" },
				{ content: "verify", status: "completed" },
			],
		});

		expect(result.isError).toBe(false);
		expect(text(result)).toBe("Updated todo list: 1 pending, 1 in progress, 1 completed.");
		expect(result.details).toEqual({
			version: 2,
			todos: [
				{ content: "plan", status: "in_progress" },
				{ content: "build", status: "pending" },
				{ content: "verify", status: "completed" },
			],
			counts: { pending: 1, inProgress: 1, completed: 1 },
		});
		expect(harness.appendedEntries.at(-1)).toEqual({
			customType: TODO_SNAPSHOT_ENTRY_TYPE,
			data: {
				version: 3,
				todos: [
					{ content: "plan", status: "in_progress" },
					{ content: "build", status: "pending" },
					{ content: "verify", status: "completed" },
				],
			},
		});
		expect(harness.setWidget).toHaveBeenLastCalledWith(TODO_WIDGET_KEY, expect.anything(), {
			placement: "aboveEditor",
		});
	});

	it("uses last-write-wins across successive writes", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		await harness.lifecycle("session_start");
		await harness.invokeTodo({ todos: [{ content: "first", status: "pending" }] });
		await harness.invokeTodo({ todos: [{ content: "second", status: "in_progress" }] });

		const last = harness.appendedEntries.at(-1);
		expect(last).toEqual({
			customType: TODO_SNAPSHOT_ENTRY_TYPE,
			data: {
				version: 3,
				todos: [{ content: "second", status: "in_progress" }],
			},
		});

		const cleared = await harness.invokeTodo({ todos: [] });
		expect(cleared.isError).toBe(false);
		expect(harness.appendedEntries.at(-1)?.data).toEqual({ version: 3, todos: [] });
		expect(harness.setWidget).toHaveBeenLastCalledWith(TODO_WIDGET_KEY, undefined, { placement: "aboveEditor" });
	});

	it("retires a fully completed list instead of keeping it visible", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		await harness.lifecycle("session_start");

		const result = await harness.invokeTodo({
			todos: [
				{ content: "investigate", status: "completed" },
				{ content: "implement", status: "completed" },
			],
		});

		expect(result.isError).toBe(false);
		expect(text(result)).toBe("All 2 todos completed. Todo list cleared.");
		expect(result.details).toEqual({
			version: 2,
			todos: [],
			counts: { pending: 0, inProgress: 0, completed: 0 },
		});
		expect(harness.appendedEntries.at(-1)?.data).toEqual({ version: 3, todos: [] });
		expect(harness.setWidget).toHaveBeenLastCalledWith(TODO_WIDGET_KEY, undefined, { placement: "aboveEditor" });
	});

	it("keeps a partially completed list visible", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		await harness.lifecycle("session_start");

		const result = await harness.invokeTodo({
			todos: [
				{ content: "done work", status: "completed" },
				{ content: "left work", status: "pending" },
			],
		});

		expect(result.isError).toBe(false);
		expect(text(result)).toBe("Updated todo list: 1 pending, 0 in progress, 1 completed.");
		expect(harness.appendedEntries.at(-1)?.data).toEqual({
			version: 3,
			todos: [
				{ content: "done work", status: "completed" },
				{ content: "left work", status: "pending" },
			],
		});
		expect(harness.setWidget).toHaveBeenLastCalledWith(TODO_WIDGET_KEY, expect.anything(), {
			placement: "aboveEditor",
		});
	});

	it("enforces allowParallelInProgress before writing anything", async () => {
		const strict = new TodoHarness("tui", true, CONFIG_FALSE);
		await strict.lifecycle("session_start");
		const parallelTodos = {
			todos: [
				{ content: "run subagent a", status: "in_progress" },
				{ content: "run subagent b", status: "in_progress" },
			],
		};

		const rejected = await strict.invokeTodo(parallelTodos);
		expect(rejected.isError).toBe(true);
		expect(text(rejected)).toBe("invalid todos: at most one task may be in_progress (got 2)");
		expect(strict.appendedEntries).toHaveLength(0);

		const parallel = new TodoHarness("tui", true, CONFIG_TRUE);
		await parallel.lifecycle("session_start");
		const accepted = await parallel.invokeTodo(parallelTodos);
		expect(accepted.isError).toBe(false);
		expect(text(accepted)).toBe("Updated todo list: 0 pending, 2 in progress, 0 completed.");
		expect(parallel.appendedEntries).toHaveLength(1);
	});

	it("rejects empty and duplicate content with dsh stable messages", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		await harness.lifecycle("session_start");

		const empty = await harness.invokeTodo({ todos: [{ content: "   ", status: "pending" }] });
		expect(empty.isError).toBe(true);
		expect(text(empty)).toBe("invalid todo: `content` must be a non-empty string");

		const duplicate = await harness.invokeTodo({
			todos: [
				{ content: "dup", status: "pending" },
				{ content: " dup ", status: "completed" },
			],
		});
		expect(duplicate.isError).toBe(true);
		expect(text(duplicate)).toBe('invalid todos: duplicate content "dup"');
		expect(harness.appendedEntries).toHaveLength(0);
	});

	it("rejects unknown item keys and invalid statuses at the schema boundary", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);

		const unknown = await harness.invokeTodo({ todos: [{ content: "x", status: "pending", extra: 1 }] });
		expect(unknown.isError).toBe(true);

		const invalidStatus = await harness.invokeTodo({ todos: [{ content: "x", status: "doing" }] });
		expect(invalidStatus.isError).toBe(true);
		expect(harness.appendedEntries).toHaveLength(0);
	});

	it("keeps the widget visible across turn boundaries until explicitly cleared", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		await harness.lifecycle("session_start");
		await harness.invokeTodo({ todos: [{ content: "work", status: "in_progress" }] });
		const callsBeforeBoundary = harness.setWidget.mock.calls.length;

		await harness.emit("turn_end", { type: "turn_end", turnIndex: 1, message: {}, toolResults: [] });
		expect(harness.setWidget.mock.calls.length).toBe(callsBeforeBoundary);

		await harness.turnStart();
		expect(harness.setWidget).toHaveBeenLastCalledWith(TODO_WIDGET_KEY, expect.anything(), {
			placement: "aboveEditor",
		});
	});

	it("restores the latest v2 snapshot even after a later user message", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		const root = userEntry("u1", null);
		const snapshot = customEntry("s1", "u1", {
			version: 2,
			todos: [{ content: "work", status: "in_progress" }],
		});

		harness.setBranch([root, snapshot]);
		await harness.lifecycle("session_start");
		expect(harness.setWidget).toHaveBeenLastCalledWith(TODO_WIDGET_KEY, expect.anything(), {
			placement: "aboveEditor",
		});

		const nextTurn = userEntry("u2", "s1");
		harness.setBranch([root, snapshot, nextTurn]);
		await harness.lifecycle("session_tree");
		expect(harness.setWidget).toHaveBeenLastCalledWith(TODO_WIDGET_KEY, expect.anything(), {
			placement: "aboveEditor",
		});
	});

	it("hides an all-completed snapshot on restore", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		const root = userEntry("u1", null);
		const finished = customEntry("s1", "u1", {
			version: 2,
			todos: [{ content: "work", status: "completed" }],
		});

		harness.setBranch([root, finished]);
		await harness.lifecycle("session_start");
		expect(harness.setWidget).toHaveBeenLastCalledWith(TODO_WIDGET_KEY, undefined, { placement: "aboveEditor" });
	});

	it("ignores v1 data and warns once for malformed v2 data", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_FALSE);
		const root = userEntry("u1", null);
		const old = customEntry("s1", "u1", { version: 1, activeList: null });
		const invalid = customEntry("s2", "s1", { version: 2, todos: "nope" });

		harness.setBranch([root, old, invalid]);
		await harness.lifecycle("session_start");

		expect(harness.setWidget).toHaveBeenLastCalledWith(TODO_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(String(harness.notify.mock.calls[0]?.[0])).toContain("invalid snapshot");
	});

	it("reports persistence failures as tool errors and never shows the unpersisted list", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		await harness.lifecycle("session_start");
		harness.setWidget.mockClear();
		harness.failAppend = true;

		const result = await harness.invokeTodo({ todos: [{ content: "not durable", status: "pending" }] });

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("todo_write persistence failed:");
		expect(harness.appendedEntries).toHaveLength(0);
		expect(harness.setWidget).not.toHaveBeenCalled();
	});

	it("hands widget ownership to progress-widget and publishes todo snapshots", async () => {
		const harness = new TodoHarness("rpc", true, CONFIG_TRUE);
		const snapshots: unknown[] = [];
		harness.host.api.events.on(PROGRESS_WIDGET_STATE_EVENT, (value) => snapshots.push(value));
		await harness.lifecycle("session_start");

		harness.host.emitBus(PROGRESS_WIDGET_ATTACH_EVENT, { version: 1, sessionId: "session-1" });
		await harness.invokeTodo({ todos: [{ content: "work", status: "in_progress" }] });

		expect(harness.setWidget).toHaveBeenCalledWith(TODO_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		expect(snapshots.at(-1)).toEqual({
			version: 1,
			source: "todo",
			sessionId: "session-1",
			todos: [{ content: "work", status: "in_progress" }],
		});

		harness.host.emitBus(PROGRESS_WIDGET_RELEASE_EVENT, { version: 1, sessionId: "session-1" });
		expect(harness.setWidget).toHaveBeenLastCalledWith(
			TODO_WIDGET_KEY,
			["Todos · 1 in progress · 0 pending · 0 completed", "◐ work"],
			{ placement: "aboveEditor" },
		);
	});

	it("never calls UI in non-UI modes", async () => {
		const harness = new TodoHarness("print", false, CONFIG_TRUE);
		await harness.lifecycle("session_start");
		await harness.invokeTodo({ todos: [{ content: "work", status: "pending" }] });

		expect(harness.setWidget).not.toHaveBeenCalled();
		expect(harness.notify).not.toHaveBeenCalled();
	});
});

describe("Todo v3 Plan integration", () => {
	it("preserves plan sources when content is unchanged and drops them when content changes", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		const root = userEntry("u1", null);
		const source = { kind: "plan-step", ref: { planId: "plan-1", planRevision: 1, stepId: "step-1" } };
		const seeded = customEntry("s1", "u1", {
			version: 3,
			todos: [
				{ content: "linked", status: "pending", source },
				{ content: "plain", status: "pending" },
			],
		});
		harness.setBranch([root, seeded]);
		await harness.lifecycle("session_start");

		await harness.invokeTodo({
			todos: [
				{ content: "linked", status: "in_progress" },
				{ content: "renamed work", status: "pending" },
			],
		});

		const last = harness.appendedEntries.at(-1);
		expect(last?.data).toEqual({
			version: 3,
			todos: [
				{ content: "linked", status: "in_progress", source },
				{ content: "renamed work", status: "pending" },
			],
		});
	});

	it("commits a Plan handoff through todo:replace-request exactly once", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		await harness.lifecycle("session_start");
		const source = { kind: "plan-step", ref: { planId: "plan-1", planRevision: 1, stepId: "step-2" } };
		let result: unknown;
		const respond = (value: unknown) => {
			result = value;
		};
		const request = {
			version: 1,
			requestId: "req-1",
			sessionId: "session-1",
			handoffId: "handoff-1",
			todos: [{ content: "linked", status: "pending", source }],
			respond,
		};

		harness.host.emitBus(TODO_REPLACE_REQUEST_EVENT, request as unknown);

		expect(result).toEqual({ version: 1, requestId: "req-1", applied: true });
		expect(harness.appendedEntries.at(-1)).toEqual({
			customType: TODO_SNAPSHOT_ENTRY_TYPE,
			data: {
				version: 3,
				todos: [{ content: "linked", status: "pending", source }],
				handoffOrigin: { handoffId: "handoff-1" },
			},
		});

		// 幂等：同一 handoffId 再次请求不重复落盘。
		const before = harness.appendedEntries.length;
		harness.host.emitBus(TODO_REPLACE_REQUEST_EVENT, request as unknown);
		expect(result).toEqual({ version: 1, requestId: "req-1", applied: false });
		expect(harness.appendedEntries).toHaveLength(before);
	});

	it("ignores handoff requests from another session and reports invalid envelopes", async () => {
		const harness = new TodoHarness("tui", true, CONFIG_TRUE);
		await harness.lifecycle("session_start");
		const results: unknown[] = [];
		harness.host.emitBus(TODO_REPLACE_REQUEST_EVENT, {
			version: 1,
			requestId: "req-x",
			sessionId: "other-session",
			handoffId: "h-x",
			todos: [],
			respond: (value: unknown) => results.push(value),
		});
		expect(results).toHaveLength(0);
		expect(harness.appendedEntries).toHaveLength(0);

		harness.host.emitBus(TODO_REPLACE_REQUEST_EVENT, { version: 9 });
		expect(results).toHaveLength(0);
		expect(harness.appendedEntries).toHaveLength(0);
	});
});
