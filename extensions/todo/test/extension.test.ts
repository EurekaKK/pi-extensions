import { type Tool, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	TODO_COUNTER_ENTRY_TYPE,
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
	TODO_SNAPSHOT_ENTRY_TYPE,
} from "../src/constants.js";
import { createEmptyRuntimeState, createTodoList } from "../src/domain.js";
import registerTodoExtension from "../src/index.js";
import { createTodoCounter, createTodoSnapshot } from "../src/session-state.js";
import type { TodoToolDetailsV1 } from "../src/tool.js";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown | Promise<unknown>;

interface CapturedTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: readonly string[];
	readonly parameters: unknown;
	readonly executionMode?: string;
	readonly prepareArguments?: (parameters: unknown) => Record<string, unknown>;
	execute(
		toolCallId: string,
		parameters: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<AgentToolResult<TodoToolDetailsV1>>;
}

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
	readonly usage?: unknown;
	readonly timestamp: number;
}

class TodoHarness {
	readonly registeredTools: CapturedTool[] = [];
	readonly appendedEntries: AppendedEntry[] = [];
	readonly setWidget = vi.fn();
	readonly notify = vi.fn();
	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;
	#branch: SessionEntry[] = [];
	#handlers = new Map<string, Handler[]>();
	#nextId = 1;
	failAppend = false;
	failBranchRead = false;

	constructor(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
		this.context = {
			mode,
			hasUI,
			ui: {
				setWidget: this.setWidget,
				notify: this.notify,
			},
			sessionManager: {
				getBranch: () => {
					if (this.failBranchRead) throw new Error("branch unavailable");
					return [...this.#branch];
				},
			},
		} as unknown as ExtensionContext;
		this.api = {
			on: (event: string, handler: Handler) => {
				const handlers = this.#handlers.get(event) ?? [];
				handlers.push(handler);
				this.#handlers.set(event, handlers);
			},
			registerTool: (tool: CapturedTool) => {
				this.registeredTools.push(tool);
			},
			appendEntry: (customType: string, data: unknown) => {
				const entry: SessionEntry = {
					type: "custom",
					id: `entry-${this.#nextId++}`,
					parentId: this.#branch.at(-1)?.id ?? null,
					timestamp: new Date().toISOString(),
					customType,
					data,
				};
				this.#branch.push(entry);
				if (this.failAppend) throw new Error("disk unavailable");
				this.appendedEntries.push({ customType, data });
			},
		} as unknown as ExtensionAPI;
		registerTodoExtension(this.api);
	}

	get tool(): CapturedTool {
		const tool = this.registeredTools[0];
		if (tool === undefined) throw new Error("Todo tool was not registered.");
		return tool;
	}

	setBranch(entries: readonly SessionEntry[]): void {
		this.#branch = [...entries];
	}

	branch(): readonly SessionEntry[] {
		return [...this.#branch];
	}

	async lifecycle(event: "session_start" | "session_tree" | "session_shutdown"): Promise<void> {
		await this.emit(event, { type: event });
	}

	async invokeTodo(parameters: unknown, toolCallId = `todo-${this.#nextId++}`): Promise<ToolMessage> {
		await this.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId,
			toolName: "todo",
			args: parameters,
		});
		let result: AgentToolResult<TodoToolDetailsV1>;
		let isError = false;
		try {
			const prepared = this.tool.prepareArguments?.(parameters) ?? parameters;
			const preparedRecord = isRecord(prepared) ? prepared : {};
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
					arguments: preparedRecord,
				} as ToolCall,
			);
			result = await this.tool.execute(toolCallId, validatedParameters, undefined, undefined, this.context);
		} catch (error) {
			isError = true;
			result = {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				details: {} as TodoToolDetailsV1,
			};
		}

		for (const patch of await this.emitAll("tool_result", {
			type: "tool_result",
			toolCallId,
			toolName: "todo",
			input: parameters,
			content: result.content,
			details: result.details,
			isError,
		})) {
			if (!isRecord(patch)) continue;
			if (typeof patch.isError === "boolean") isError = patch.isError;
			if (Array.isArray(patch.content)) result = { ...result, content: patch.content as typeof result.content };
			if (Object.hasOwn(patch, "details")) result = { ...result, details: patch.details as TodoToolDetailsV1 };
		}

		await this.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId,
			toolName: "todo",
			result,
			isError,
		});
		return await this.finishMessage({
			role: "toolResult",
			toolCallId,
			toolName: "todo",
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		});
	}

	async startExternal(toolCallId: string, toolName = "bash"): Promise<void> {
		await this.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId,
			toolName,
			args: {},
		});
	}

	async endExternal(
		toolCallId: string,
		options: {
			readonly toolName?: string;
			readonly isError?: boolean;
			readonly content?: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
			readonly details?: unknown;
			readonly usage?: unknown;
		} = {},
	): Promise<ToolMessage> {
		const toolName = options.toolName ?? "bash";
		const content = options.content ?? [{ type: "text" as const, text: `result:${toolCallId}` }];
		const details = options.details ?? { source: toolCallId };
		const isError = options.isError ?? false;
		await this.emit("tool_execution_end", {
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: { content, details, usage: options.usage },
			isError,
		});
		return await this.finishMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content,
			details,
			isError,
			...(options.usage === undefined ? {} : { usage: options.usage }),
			timestamp: Date.now(),
		});
	}

	async external(toolCallId: string, options: Parameters<TodoHarness["endExternal"]>[1] = {}): Promise<ToolMessage> {
		await this.startExternal(toolCallId, options.toolName);
		return await this.endExternal(toolCallId, options);
	}

	async finishMessage(message: ToolMessage): Promise<ToolMessage> {
		let current: ToolMessage = message;
		for (const replacement of await this.emitAll("message_end", {
			type: "message_end",
			message: current,
		})) {
			if (isRecord(replacement) && isRecord(replacement.message)) {
				current = replacement.message as unknown as ToolMessage;
			}
		}
		return current;
	}

	async emit(event: string, payload: Record<string, unknown>): Promise<unknown> {
		const results = await this.emitAll(event, payload);
		return results.at(-1);
	}

	async emitAll(event: string, payload: Record<string, unknown>): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.#handlers.get(event) ?? []) {
			results.push(await handler(payload, this.context));
		}
		return results;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(message: ToolMessage): string {
	return message.content.map((block) => block.text ?? "").join("\n");
}

function sessionEntry(index: number, customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id: `seed-${index}`,
		parentId: index === 1 ? null : `seed-${index - 1}`,
		timestamp: new Date(2026, 0, index).toISOString(),
		customType,
		data,
	};
}

describe("Todo extension registration and mutations", () => {
	let harness: TodoHarness;

	beforeEach(async () => {
		harness = new TodoHarness();
		await harness.lifecycle("session_start");
	});

	it("registers one parallel-capable Todo tool with the confirmed prompt metadata", () => {
		expect(harness.registeredTools).toHaveLength(1);
		expect(harness.tool.name).toBe("todo");
		expect(harness.tool.promptSnippet).toBe(TODO_PROMPT_SNIPPET);
		expect(harness.tool.promptGuidelines).toEqual(TODO_PROMPT_GUIDELINES);
		expect(harness.tool.executionMode).toBeUndefined();
	});

	it("creates, adds, lists, atomically updates, and automatically closes a list", async () => {
		const created = await harness.invokeTodo({ action: "create", items: [" one ", "two"] });
		expect(created.isError).toBe(false);
		expect(created.details).toMatchObject({ version: 1, action: "create", outcome: "created", changedIds: [1, 2] });
		expect(text(created)).toContain("- [pending] #1 one");
		expect(harness.appendedEntries.at(-1)?.customType).toBe(TODO_SNAPSHOT_ENTRY_TYPE);

		const added = await harness.invokeTodo({ action: "add", items: ["three"] });
		expect(added.details).toMatchObject({ outcome: "added", changedIds: [3] });

		const listed = await harness.invokeTodo({ action: "list" });
		expect(text(listed)).toContain("#1 one");
		expect(text(listed)).toContain("#2 two");
		expect(text(listed)).toContain("#3 three");
		const entriesBeforeUpdate = harness.appendedEntries.length;

		const rejectedBatch = await harness.invokeTodo({
			action: "update",
			updates: [
				{ id: 1, status: "completed" },
				{ id: 99, status: "completed" },
			],
		});
		expect(rejectedBatch.isError).toBe(true);
		expect(rejectedBatch.details).toMatchObject({ outcome: "rejected", errorCode: "todo_not_found" });
		expect(harness.appendedEntries).toHaveLength(entriesBeforeUpdate);
		expect(text(rejectedBatch)).toContain("- [pending] #1 one");

		const closed = await harness.invokeTodo({
			action: "update",
			updates: [
				{ id: 1, status: "completed" },
				{ id: 2, status: "cancelled", reason: " no longer needed " },
				{ id: 3, status: "completed" },
			],
		});
		expect(closed.isError).toBe(false);
		expect(closed.details).toMatchObject({ action: "update", outcome: "closed", changedIds: [1, 2, 3] });
		expect(text(closed)).toContain("2 completed, 1 cancelled, 0 unresolved");
		expect(harness.appendedEntries.at(-1)).toEqual({
			customType: TODO_SNAPSHOT_ENTRY_TYPE,
			data: { version: 1, activeList: null },
		});
		expect(harness.setWidget).toHaveBeenLastCalledWith("todo:status", undefined);

		const empty = await harness.invokeTodo({ action: "list" });
		expect(text(empty)).toBe("No active Todo List.");
	});

	it("treats repeated updates and every other domain rejection as real tool errors", async () => {
		await harness.invokeTodo({ action: "create", items: ["work", "keep open"] });
		await harness.invokeTodo({ action: "update", updates: [{ id: 1, status: "in_progress" }] });
		const before = harness.appendedEntries.length;

		const repeated = await harness.invokeTodo({
			action: "update",
			updates: [{ id: 1, status: "in_progress" }],
		});
		expect(repeated.isError).toBe(true);
		expect(repeated.details).toMatchObject({
			outcome: "rejected",
			errorCode: "todo_no_state_change",
			changedIds: [],
		});
		expect(text(repeated)).toContain("No Todo was changed");
		expect(text(repeated)).toContain("#1 work");
		expect(text(repeated)).toContain("#2 keep open");
		expect(harness.appendedEntries).toHaveLength(before);
	});

	it("strictly rejects action-specific fields before changing state", async () => {
		for (const invalid of [
			{ action: "create", items: ["work"], updates: [] },
			{ action: "add", items: [] },
			{ action: "update", updates: [{ id: 1, status: "pending" }] },
			{ action: "list", items: ["unexpected"] },
		]) {
			const result = await harness.invokeTodo(invalid);
			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({ outcome: "rejected", errorCode: "todo_invalid_arguments" });
		}
		expect(harness.appendedEntries).toHaveLength(0);
	});

	it("does not report a mutation as successful when snapshot persistence fails", async () => {
		await harness.invokeTodo({ action: "create", items: ["durable"] });
		harness.failAppend = true;
		harness.failBranchRead = true;
		const failed = await harness.invokeTodo({ action: "add", items: ["not durable"] });

		expect(failed.isError).toBe(true);
		expect(failed.details).toMatchObject({ outcome: "rejected", errorCode: "todo_persistence_failed" });
		expect(harness.appendedEntries).toHaveLength(1);
		harness.failAppend = false;
		harness.failBranchRead = false;
		const listed = await harness.invokeTodo({ action: "list" });
		expect(text(listed)).toContain("#1 durable");
		expect(text(listed)).not.toContain("not durable");
		await harness.lifecycle("session_tree");
		expect(text(await harness.invokeTodo({ action: "list" }))).not.toContain("not durable");
	});

	it("serializes concurrent Todo mutations without losing additions", async () => {
		await harness.invokeTodo({ action: "create", items: ["seed"] });
		const [left, right] = await Promise.all([
			harness.invokeTodo({ action: "add", items: ["left"] }, "parallel-left"),
			harness.invokeTodo({ action: "add", items: ["right"] }, "parallel-right"),
		]);

		expect(left.isError).toBe(false);
		expect(right.isError).toBe(false);
		const listed = await harness.invokeTodo({ action: "list" });
		expect(text(listed)).toContain("#2 left");
		expect(text(listed)).toContain("#3 right");
	});

	it("does not let a Todo call started on an old lifecycle write into the new branch", async () => {
		await harness.startExternal("stale-todo", "todo");
		await harness.lifecycle("session_tree");

		await expect(
			harness.tool.execute("stale-todo", { action: "create", items: ["stale"] }, undefined, undefined, harness.context),
		).rejects.toMatchObject({ name: "TodoLifecycleChangedError" });
		expect(harness.appendedEntries).toHaveLength(0);
	});
});

describe("Todo reminder cadence", () => {
	it("counts successful and failed results, appends on the fifth, and preserves the original result", async () => {
		const harness = new TodoHarness("print", false);
		await harness.lifecycle("session_start");
		await harness.invokeTodo({ action: "create", items: ["first", "second"] });

		for (let index = 1; index <= 4; index += 1) {
			const result = await harness.external(`tool-${index}`, { isError: index % 2 === 0 });
			expect(text(result)).not.toContain("TODO REMINDER");
		}
		const originalDetails = { exitCode: 17 };
		const originalUsage = { input: 3, output: 4 };
		const fifth = await harness.external("tool-5", {
			isError: true,
			content: [{ type: "text", text: "original failure" }],
			details: originalDetails,
			usage: originalUsage,
		});

		expect(fifth.content[0]).toEqual({ type: "text", text: "original failure" });
		expect(fifth.content).toHaveLength(2);
		expect(text(fifth)).toContain("TODO REMINDER — generated by the Todo extension");
		expect(text(fifth)).toContain("- [pending] #1 first");
		expect(text(fifth)).toContain("- [pending] #2 second");
		expect(fifth.details).toBe(originalDetails);
		expect(fifth.usage).toBe(originalUsage);
		expect(fifth.isError).toBe(true);
		expect(
			harness.appendedEntries
				.filter((entry) => entry.customType === TODO_COUNTER_ENTRY_TYPE)
				.map((entry) => (entry.data as { count: number }).count),
		).toEqual([1, 2, 3, 4, 0]);
		expect(harness.setWidget).not.toHaveBeenCalled();
	});

	it("uses completion order for counting while attaching the reminder to the matching source-order message", async () => {
		const harness = new TodoHarness("print", false);
		await harness.lifecycle("session_start");
		await harness.invokeTodo({ action: "create", items: ["work"] });
		for (const id of ["a", "b", "c", "d", "e"]) await harness.startExternal(id);
		for (const id of ["b", "d", "a", "e", "c"]) {
			await harness.emit("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "bash",
				result: { content: [{ type: "text", text: id }], details: { id } },
				isError: false,
			});
		}

		const messages: ToolMessage[] = [];
		for (const id of ["a", "b", "c", "d", "e"]) {
			messages.push(
				await harness.finishMessage({
					role: "toolResult",
					toolCallId: id,
					toolName: "bash",
					content: [{ type: "text", text: id }],
					details: { id },
					isError: false,
					timestamp: Date.now(),
				}),
			);
		}

		expect(
			messages.filter((message) => text(message).includes("TODO REMINDER")).map((message) => message.toolCallId),
		).toEqual(["c"]);
	});

	it("resets only on successful mutations, not on list or rejected Todo calls", async () => {
		const harness = new TodoHarness("print", false);
		await harness.lifecycle("session_start");
		await harness.invokeTodo({ action: "create", items: ["work"] });
		for (let index = 1; index <= 3; index += 1) await harness.external(`pre-${index}`);
		const entriesBeforeQueries = harness.appendedEntries.length;

		await harness.invokeTodo({ action: "list" });
		await harness.invokeTodo({ action: "create", items: ["conflict"] });
		expect(harness.appendedEntries).toHaveLength(entriesBeforeQueries);

		expect(text(await harness.external("fourth"))).not.toContain("TODO REMINDER");
		expect(text(await harness.external("fifth"))).toContain("TODO REMINDER");

		for (let index = 1; index <= 3; index += 1) await harness.external(`again-${index}`);
		await harness.invokeTodo({ action: "add", items: ["new"] });
		for (let index = 1; index <= 4; index += 1) {
			expect(text(await harness.external(`after-reset-${index}`))).not.toContain("TODO REMINDER");
		}
		expect(text(await harness.external("after-reset-5"))).toContain("TODO REMINDER");
	});

	it("does not count or persist when no list is active", async () => {
		const harness = new TodoHarness("print", false);
		await harness.lifecycle("session_start");
		for (let index = 1; index <= 6; index += 1) {
			expect(text(await harness.external(`idle-${index}`, { isError: true }))).not.toContain("TODO REMINDER");
		}
		expect(harness.appendedEntries).toHaveLength(0);
	});

	it("retains the last committed count when counter persistence and branch recovery both fail", async () => {
		const harness = new TodoHarness("print", false);
		await harness.lifecycle("session_start");
		await harness.invokeTodo({ action: "create", items: ["work"] });
		for (let index = 1; index <= 3; index += 1) await harness.external(`before-failure-${index}`);

		harness.failAppend = true;
		harness.failBranchRead = true;
		expect(text(await harness.external("failed-counter-write"))).not.toContain("TODO REMINDER");
		harness.failAppend = false;
		harness.failBranchRead = false;

		expect(text(await harness.external("count-four"))).not.toContain("TODO REMINDER");
		expect(text(await harness.external("count-five"))).toContain("TODO REMINDER");
	});
});

describe("Todo session and branch lifecycle", () => {
	it("restores a count of three and reminds after two more results without an immediate reminder", async () => {
		const state = createTodoList(createEmptyRuntimeState(), ["resumed"]);
		if (!state.ok) throw new Error(state.error.message);
		const harness = new TodoHarness("print", false);
		harness.setBranch([
			sessionEntry(1, TODO_SNAPSHOT_ENTRY_TYPE, createTodoSnapshot(state.state)),
			sessionEntry(2, TODO_COUNTER_ENTRY_TYPE, createTodoCounter(3)),
		]);

		await harness.lifecycle("session_start");
		expect(harness.appendedEntries).toHaveLength(0);
		expect(text(await harness.external("resume-1"))).not.toContain("TODO REMINDER");
		expect(text(await harness.external("resume-2"))).toContain("TODO REMINDER");
	});

	it("restores the selected branch on tree navigation and clears on repeated shutdown", async () => {
		const active = createTodoList(createEmptyRuntimeState(), ["historical"]);
		if (!active.ok) throw new Error(active.error.message);
		const activeEntry = sessionEntry(1, TODO_SNAPSHOT_ENTRY_TYPE, createTodoSnapshot(active.state));
		const closedEntry = sessionEntry(2, TODO_SNAPSHOT_ENTRY_TYPE, { version: 1, activeList: null });
		const harness = new TodoHarness();

		harness.setBranch([activeEntry, closedEntry]);
		await harness.lifecycle("session_start");
		expect(text(await harness.invokeTodo({ action: "list" }))).toBe("No active Todo List.");

		harness.setBranch([activeEntry]);
		await harness.lifecycle("session_tree");
		expect(text(await harness.invokeTodo({ action: "list" }))).toContain("#1 historical");

		await harness.lifecycle("session_shutdown");
		await harness.lifecycle("session_shutdown");
		expect(harness.setWidget).toHaveBeenLastCalledWith("todo:status", undefined);
	});

	it("skips corrupt state and emits one sanitized warning per session", async () => {
		const harness = new TodoHarness();
		harness.setBranch([
			sessionEntry(1, TODO_SNAPSHOT_ENTRY_TYPE, { version: 99, activeList: null }),
			sessionEntry(2, TODO_COUNTER_ENTRY_TYPE, { version: 1, count: 99 }),
		]);

		await harness.lifecycle("session_start");
		await harness.lifecycle("session_tree");
		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(harness.notify.mock.calls[0]?.[0]).not.toContain("99");
	});
});
