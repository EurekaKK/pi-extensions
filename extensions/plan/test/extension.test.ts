import type { AgentToolResult, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type CapturedTool, FakePiHost } from "test-host";
import { TODO_SNAPSHOT_ENTRY_TYPE } from "todo-protocol";
import { describe, expect, it } from "vitest";
import { registerTodoExtension } from "../../todo/src/index.js";
import type { PlanConfigV1 } from "../src/config.js";
import {
	PLAN_CHANGE_ENTRY_TYPE,
	PLAN_KICKOFF_MESSAGE_TYPE,
	PLAN_START_MESSAGE_TYPE,
	PLAN_TOOL_READ_NAME,
	PLAN_TOOL_SUBMIT_NAME,
} from "../src/constants.js";
import { registerPlanExtension } from "../src/index.js";

const CONFIG: PlanConfigV1 = Object.freeze({ version: 1, additionalReadOnlyTools: Object.freeze([]) });

interface ToolMessage {
	readonly isError: boolean;
	readonly text: string;
}

class PlanTodoHarness {
	readonly host: FakePiHost;
	readonly context: ExtensionContext;

	constructor(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
		this.host = new FakePiHost({ mode, hasUI });
		this.context = this.host.context;
		registerTodoExtension(this.host.api, { version: 1, allowParallelInProgress: false });
		registerPlanExtension(this.host.api, CONFIG);
	}

	async command(text: string): Promise<void> {
		const command = this.host.commands.get("plan");
		if (command === undefined) throw new Error("plan command not registered");
		await command.handler(text, this.context);
	}

	async lifecycle(
		event: "session_start" | "session_tree" | "session_shutdown",
		payload: Record<string, unknown> = { type: event },
	): Promise<void> {
		await this.host.emit(event, payload);
	}

	async invokeTool(toolName: string, parameters: unknown): Promise<ToolMessage> {
		const tool = this.host.tools.find((candidate) => candidate.name === toolName);
		if (tool === undefined) throw new Error(`tool ${toolName} not registered`);
		try {
			const result = (await tool.execute(
				"call-1",
				parameters as never,
				undefined,
				undefined,
				this.context,
			)) as AgentToolResult<unknown>;
			return {
				isError: false,
				text: result.content
					.filter((block): block is { readonly type: "text"; readonly text: string } => block.type === "text")
					.map((block) => block.text)
					.join(""),
			};
		} catch (error) {
			return { isError: true, text: error instanceof Error ? error.message : String(error) };
		}
	}

	planTool(name: string): CapturedTool {
		const tool = this.host.tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`plan tool ${name} not registered`);
		return tool;
	}

	async submitProposal(): Promise<ToolMessage> {
		return this.invokeTool(PLAN_TOOL_SUBMIT_NAME, {
			objective: "integrate plan and todo",
			overview: "Plan owns strategy; Todo owns execution progress.",
			steps: [
				{ title: "Define Todo Protocol seam", details: "Add v3 snapshot and replace interface." },
				{ title: "Implement Planning Workflow", details: "Add drafting/reviewing/handoff_pending folding." },
			],
		});
	}

	appendedChanges(): readonly string[] {
		return this.host.appendedEntries
			.filter((entry) => entry.customType === PLAN_CHANGE_ENTRY_TYPE)
			.map((entry) => (entry.data as { operation: string }).operation);
	}

	latestPlanChange(): unknown {
		return [...this.host.appendedEntries].reverse().find((entry) => entry.customType === PLAN_CHANGE_ENTRY_TYPE)?.data;
	}
}

describe("plan extension happy path", () => {
	it("registers plan tools, command, flag, renderers and status key", () => {
		const harness = new PlanTodoHarness();
		expect(harness.planTool(PLAN_TOOL_SUBMIT_NAME).executionMode).toBe("sequential");
		expect(harness.planTool(PLAN_TOOL_READ_NAME).executionMode).toBe("parallel");
		expect(harness.planTool(PLAN_TOOL_READ_NAME).promptGuidelines).toEqual([expect.stringContaining("/plan start")]);
		expect(harness.host.commands.has("plan")).toBe(true);
		expect(harness.host.flags.get("plan")?.type).toBe("boolean");
		expect(harness.host.messageRenderers.has(PLAN_START_MESSAGE_TYPE)).toBe(true);
		expect(harness.host.messageRenderers.has(PLAN_KICKOFF_MESSAGE_TYPE)).toBe(true);
	});

	it("walks start → submit → approve → handoff → kickoff through one seam", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");

		await harness.command("start build the integration");
		expect(harness.appendedChanges()).toEqual(["start"]);
		expect(harness.host.sentMessages.at(-1)?.message).toMatchObject({
			customType: PLAN_START_MESSAGE_TYPE,
			display: true,
		});
		// Planning allowlist: write tools removed, read tools present
		expect(harness.host.activeTools).toEqual(expect.arrayContaining(["read", "plan_submit", "plan_read"]));
		expect(harness.host.activeTools).not.toEqual(expect.arrayContaining(["edit", "write", "bash", "todo_write"]));
		expect(harness.host.ui.setStatus).toHaveBeenCalledWith("plan:status", expect.stringContaining("DRAFTING"));

		const submitted = await harness.submitProposal();
		expect(submitted.isError).toBe(false);
		expect(submitted.text).toContain("revision 1");
		expect(harness.appendedChanges()).toEqual(["start", "submit"]);
		expect(harness.host.ui.setStatus).toHaveBeenLastCalledWith("plan:status", expect.stringContaining("REVIEWING"));
		// proposal card message
		expect(harness.host.sentMessages.some((entry) => entry.message.customType === "plan:proposal-card")).toBe(true);

		// 模型再次调用 plan_submit 应被拒绝（已 reviewing）
		const resubmit = await harness.invokeTool(PLAN_TOOL_SUBMIT_NAME, {
			objective: "x",
			overview: "y",
			steps: [{ title: "t", details: "d" }],
		});
		expect(resubmit.isError).toBe(true);

		await harness.command("approve");
		expect(harness.appendedChanges()).toEqual(["start", "submit", "approve", "handoff-complete"]);
		// Todo snapshot written by Todo itself with handoff origin
		const todoSnapshot = [...harness.host.appendedEntries]
			.reverse()
			.find((entry) => entry.customType === TODO_SNAPSHOT_ENTRY_TYPE);
		expect(todoSnapshot?.data).toMatchObject({
			version: 3,
			handoffOrigin: { handoffId: expect.any(String) },
		});
		if (todoSnapshot === undefined || !("todos" in (todoSnapshot.data as object))) {
			throw new Error("missing todo snapshot");
		}
		const todos = (todoSnapshot.data as { todos: unknown[] }).todos;
		expect(todos).toHaveLength(2);
		expect(todos[0]).toMatchObject({
			content: "Define Todo Protocol seam",
			status: "pending",
			source: { kind: "plan-step" },
		});
		// gate restored + footer cleared + kickoff queued
		expect(harness.host.activeTools).toEqual(expect.arrayContaining(["edit", "write", "bash"]));
		expect(harness.host.ui.setStatus).toHaveBeenLastCalledWith("plan:status", undefined);
		expect(harness.host.sentMessages.at(-1)?.message).toMatchObject({ customType: PLAN_KICKOFF_MESSAGE_TYPE });
	});

	it("keeps handoff pending and allows retry when Todo rejects", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		await harness.command("start x");
		await harness.submitProposal();

		// 模拟 Todo 拒绝：先移除 todo_write（计划侧 preflight 失败）
		(harness.host.tools as CapturedTool[]) = harness.host.tools.filter((tool) => tool.name !== "todo_write");
		await harness.command("approve");
		expect(harness.appendedChanges()).toEqual(["start", "submit", "approve"]);
		expect(harness.host.ui.setStatus).toHaveBeenLastCalledWith(
			"plan:status",
			expect.stringContaining("HANDOFF PENDING"),
		);
		expect(harness.host.sentMessages.some((entry) => entry.message.customType === PLAN_KICKOFF_MESSAGE_TYPE)).toBe(
			false,
		);

		// 恢复 todo_write 后 retry 成功
		registerTodoExtension(harness.host.api, { version: 1, allowParallelInProgress: false });
		await harness.command("retry");
		expect(harness.appendedChanges()).toEqual(["start", "submit", "approve", "handoff-complete"]);
		expect(harness.host.sentMessages.at(-1)?.message).toMatchObject({ customType: PLAN_KICKOFF_MESSAGE_TYPE });
	});

	it("retries idempotently when the Todo snapshot is already committed", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		await harness.command("start x");
		await harness.submitProposal();
		await harness.command("approve");
		// 手工制造“committed 但缺少 handoff-complete”的崩溃窗口
		const branch = [...harness.host.branch()];
		const withoutComplete = branch.filter(
			(entry) =>
				!(
					entry.type === "custom" &&
					entry.customType === PLAN_CHANGE_ENTRY_TYPE &&
					(entry.data as { operation?: string }).operation === "handoff-complete"
				),
		);
		harness.host.setBranch(withoutComplete);
		await harness.command("retry");
		expect(harness.appendedChanges().filter((op) => op === "handoff-complete")).toHaveLength(2);
		// 快照未重复
		expect(harness.host.appendedEntries.filter((entry) => entry.customType === TODO_SNAPSHOT_ENTRY_TYPE)).toHaveLength(
			1,
		);
	});

	it("revises from reviewing and can re-plan from the approved lineage", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		await harness.command("start x");
		await harness.submitProposal();
		await harness.command("revise focus on tests");
		expect(harness.latestPlanChange()).toMatchObject({
			operation: "revise-request",
			sourceRevision: 1,
			feedback: "focus on tests",
		});
		expect(harness.host.sentMessages.at(-1)?.message).toMatchObject({ customType: "plan:revise-request" });

		const revise = await harness.submitProposal();
		expect(revise.isError).toBe(false);
		expect(harness.latestPlanChange()).toMatchObject({ operation: "submit", proposal: { revision: 2 } });

		await harness.command("approve");
		expect(harness.appendedChanges().at(-1)).toBe("handoff-complete");
		expect(harness.host.activeTools).toEqual(expect.arrayContaining(["edit", "write", "bash"]));

		// inactive 时 revise 延续 lineage，objective 默认从已批准 revision 带出
		await harness.command("revise revisit");
		expect(harness.appendedChanges().at(-1)).toBe("revise-request");
		expect(harness.latestPlanChange()).toMatchObject({
			planId: expect.stringContaining("plan-"),
			sourceRevision: 2,
			objective: "integrate plan and todo",
		});
		// 默认 objective 呈现在消息、命令反馈与只读状态中
		expect(harness.host.sentMessages.at(-1)?.message).toMatchObject({
			customType: "plan:revise-request",
			content: expect.stringContaining("Objective (defaulted from the approved Plan): integrate plan and todo"),
		});
		expect(harness.host.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("objective defaults to"), "info");
		const stateRead = await harness.invokeTool(PLAN_TOOL_READ_NAME, {});
		expect(stateRead.text).toContain("Objective (default): integrate plan and todo");
	});

	it("rejects cancel after durable handoff commit", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		await harness.command("start x");
		await harness.submitProposal();
		await harness.command("approve");
		// 移除 todo listener 响应后的完成 append 再制造 pending+committed 窗口
		const branch = [...harness.host.branch()];
		const pendingEntries = branch.filter(
			(entry) =>
				!(
					entry.type === "custom" &&
					entry.customType === PLAN_CHANGE_ENTRY_TYPE &&
					(entry.data as { operation?: string }).operation === "handoff-complete"
				),
		);
		harness.host.setBranch(pendingEntries);
		await harness.lifecycle("session_tree");
		expect(harness.host.ui.setStatus).toHaveBeenLastCalledWith("plan:status", undefined);
		await harness.command("cancel");
		expect(harness.appendedChanges().at(-1)).not.toEqual("cancel");
	});

	it("plan_read reads revisions, paginates, and joins Todo for approved plans", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		await harness.command("start x");
		await harness.submitProposal();
		await harness.command("approve");

		const stateRead = await harness.invokeTool(PLAN_TOOL_READ_NAME, {});
		expect(stateRead.text).toContain("Latest Approved Plan");

		const revisionRead = await harness.invokeTool(PLAN_TOOL_READ_NAME, { plan_id: "unknown", revision: 1 });
		expect(revisionRead.isError).toBe(true);

		const submitChange = [...harness.host.appendedEntries]
			.reverse()
			.find(
				(entry) =>
					entry.customType === PLAN_CHANGE_ENTRY_TYPE && (entry.data as { operation?: string }).operation === "submit",
			);
		const submittedProposal = (
			submitChange?.data as { proposal?: { planId: string; revision: number; steps: { stepId: string }[] } } | undefined
		)?.proposal;
		if (!submittedProposal) throw new Error("missing proposal");
		const ok = await harness.invokeTool(PLAN_TOOL_READ_NAME, { plan_id: submittedProposal.planId, revision: 1 });
		expect(ok.text).toContain("Todo projection");
		expect(ok.text).toContain("Define Todo Protocol seam [pending]");

		const stepRead = await harness.invokeTool(PLAN_TOOL_READ_NAME, {
			plan_id: submittedProposal.planId,
			revision: 1,
			step_id: submittedProposal.steps[0]?.stepId,
		});
		expect(stepRead.text).toContain("Add v3 snapshot and replace interface.");

		// 分页：把选中 step 的详情切成两段读取
		await harness.command("start y");
		await harness.invokeTool(PLAN_TOOL_SUBMIT_NAME, {
			objective: "long",
			overview: "v".repeat(100),
			steps: [{ title: "big", details: "x".repeat(5000) }],
		});
		const bigChange = [...harness.host.appendedEntries]
			.reverse()
			.find(
				(entry) =>
					entry.customType === PLAN_CHANGE_ENTRY_TYPE && (entry.data as { operation?: string }).operation === "submit",
			);
		const bigProposal = (
			bigChange?.data as { proposal: { planId: string; revision: number; steps: { stepId: string }[] } } | undefined
		)?.proposal;
		if (!bigProposal) throw new Error("missing big proposal");
		const paged = await harness.invokeTool(PLAN_TOOL_READ_NAME, {
			plan_id: bigProposal.planId,
			revision: 1,
			step_id: bigProposal.steps[0]?.stepId,
			offset: 0,
			limit: 100,
		});
		expect(paged.text).toContain("nextOffset=");
	});
});

describe("plan gate and recovery", () => {
	it("blocks denied tool calls through the second guard even after reactivation", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		await harness.command("start x");
		// 其他 extension 重新激活写工具
		harness.host.api.setActiveTools([...harness.host.activeTools, "edit", "write", "bash"]);
		const results = await harness.host.emitResults("tool_call", {
			type: "tool_call",
			toolName: "write",
			toolCallId: "c1",
			input: { path: "x", content: "y" },
		});
		expect(results[0]).toMatchObject({ block: true });
		const readResults = await harness.host.emitResults("tool_call", {
			type: "tool_call",
			toolName: "read",
			toolCallId: "c2",
			input: { path: "x" },
		});
		expect(readResults[0]).toBeUndefined();
	});

	it("applies configured additional read-only tools", () => {
		const host = new FakePiHost();
		registerTodoExtension(host.api, { version: 1, allowParallelInProgress: false });
		registerPlanExtension(host.api, { version: 1, additionalReadOnlyTools: ["my_research_tool"] });
		host.api.registerTool({
			name: "my_research_tool",
			label: "R",
			description: "r",
			parameters: {},
			execute: async () => ({ content: [], details: {} }),
		});
		host.commands.get("plan")?.handler("start x", host.context);
		expect(host.activeTools).toContain("my_research_tool");
	});

	it("--plan arms the first direct prompt and starts a drafting workflow", async () => {
		const harness = new PlanTodoHarness();
		harness.host.setFlagValue("plan", true);
		await harness.lifecycle("session_start");
		await harness.host.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "design the new adapter",
			systemPrompt: "",
		});
		expect(harness.appendedChanges()).toEqual(["start"]);
		expect(harness.latestPlanChange()).toMatchObject({ objective: "design the new adapter" });
		expect(harness.host.activeTools).not.toContain("write");
	});

	it("--plan on a branch with an active workflow restores the gate instead of starting a duplicate", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		await harness.command("start x");
		await harness.submitProposal();
		const branch = harness.host.branch();
		await harness.lifecycle("session_shutdown");

		// 恢复会话 + --plan：分支已有 reviewing workflow，不得启动新 workflow，门禁必须重放
		harness.host.setBranch(branch);
		harness.host.setFlagValue("plan", true);
		await harness.lifecycle("session_start");
		expect(harness.host.activeTools).not.toContain("write");
		expect(harness.host.ui.setStatus).toHaveBeenLastCalledWith("plan:status", expect.stringContaining("REVIEWING"));
		expect(harness.host.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("--plan will not start another"),
			"warning",
		);

		// 首个 direct prompt 不得触发重复 start；写工具仍被封锁
		await harness.host.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "do work",
			systemPrompt: "",
		});
		expect(harness.appendedChanges().filter((op) => op === "start")).toHaveLength(1);
		expect(harness.host.activeTools).not.toContain("write");
	});

	it("warns once per session about malformed Plan entries and stays usable", async () => {
		const harness = new PlanTodoHarness();
		const malformed = {
			id: "c1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			type: "custom",
			customType: PLAN_CHANGE_ENTRY_TYPE,
			data: { kind: "plan/change", version: 1, operation: "start", planId: "", objective: "x", startedAt: 1 },
		} as SessionEntry;
		harness.host.setBranch([malformed]);
		await harness.lifecycle("session_start");
		expect(harness.host.ui.notify).toHaveBeenCalledTimes(1);
		expect(harness.host.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Skipped malformed Plan entries"),
			"warning",
		);
		// 同一 session 再次 navigation 不再重复警告
		await harness.lifecycle("session_tree");
		expect(harness.host.ui.notify).toHaveBeenCalledTimes(1);
	});

	it("discloses Todo replacement only when a prior non-empty list exists, with the prior count", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		// 预先存在非空 Todo 列表
		const seeded = await harness.invokeTool("todo_write", { todos: [{ content: "existing work", status: "pending" }] });
		expect(seeded.isError).toBe(false);
		await harness.command("start x");
		await harness.submitProposal();
		await harness.command("approve");
		expect(harness.appendedChanges().at(-1)).toBe("handoff-complete");
		// 披露替换时使用替换前的计数（1），而不是新列表大小（2）
		expect(harness.host.ui.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("previous Todo list (1 item);"),
			"info",
		);

		// 无既有列表时不披露替换
		const clean = new PlanTodoHarness();
		await clean.lifecycle("session_start");
		await clean.command("start y");
		await clean.submitProposal();
		await clean.command("approve");
		expect(clean.appendedChanges().at(-1)).toBe("handoff-complete");
		expect(clean.host.ui.notify).toHaveBeenLastCalledWith(expect.not.stringContaining("previous Todo list"), "info");
	});

	it("resumes an active workflow with gate and footer, and an effective-complete handoff without gate", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		await harness.command("start x");
		await harness.submitProposal();
		const branch = harness.host.branch();
		await harness.lifecycle("session_shutdown");
		expect(harness.host.activeTools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));

		harness.host.setBranch(branch);
		await harness.lifecycle("session_start");
		expect(harness.host.activeTools).not.toContain("edit");
		expect(harness.host.ui.setStatus).toHaveBeenLastCalledWith("plan:status", expect.stringContaining("REVIEWING"));

		// 清理 pendingReview 不触发任何自动 UI（无 agent_end 事件）
		await harness.lifecycle("session_tree");
		expect(harness.host.ui.custom).not.toHaveBeenCalled();
	});
});

describe("plan review overlay and crash recovery", () => {
	it("opens the review overlay once at agent_end and executes the chosen action", async () => {
		const harness = new PlanTodoHarness();
		await harness.lifecycle("session_start");
		await harness.command("start review me");
		await harness.submitProposal();
		expect(harness.host.ui.custom).not.toHaveBeenCalled();

		harness.host.ui.custom.mockResolvedValueOnce("approve");
		await harness.host.emit("agent_end", { type: "agent_end", messages: [] });

		expect(harness.host.ui.custom).toHaveBeenCalledTimes(1);
		expect(harness.host.ui.custom.mock.calls[0]?.[1]).toMatchObject({ overlay: true });
		expect(harness.appendedChanges()).toEqual(["start", "submit", "approve", "handoff-complete"]);
		expect(harness.host.sentMessages.at(-1)?.message).toMatchObject({ customType: PLAN_KICKOFF_MESSAGE_TYPE });

		// 第二次 agent_end 不再打开 overlay（pendingReview 已消费）
		await harness.host.emit("agent_end", { type: "agent_end", messages: [] });
		expect(harness.host.ui.custom).toHaveBeenCalledTimes(1);
	});

	it("restores an effective-complete handoff without gate or auto-run, with one notice", async () => {
		const harness = new PlanTodoHarness();
		const root = {
			id: "r1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			type: "message",
			message: { role: "user", content: "go", timestamp: 1 },
		} as SessionEntry;
		const startChange = {
			id: "c1",
			parentId: "r1",
			timestamp: "2026-01-01T00:00:01.000Z",
			type: "custom",
			customType: PLAN_CHANGE_ENTRY_TYPE,
			data: { kind: "plan/change", version: 1, operation: "start", planId: "plan-9", objective: "x", startedAt: 1 },
		} as SessionEntry;
		const submitChange = {
			id: "c2",
			parentId: "c1",
			timestamp: "2026-01-01T00:00:02.000Z",
			type: "custom",
			customType: PLAN_CHANGE_ENTRY_TYPE,
			data: {
				kind: "plan/change",
				version: 1,
				operation: "submit",
				proposal: {
					planId: "plan-9",
					revision: 1,
					objective: "x",
					overview: "v",
					steps: [{ stepId: "step-1", title: "t", details: "d" }],
				},
				submittedAt: 2,
			},
		} as SessionEntry;
		const approveChange = {
			id: "c3",
			parentId: "c2",
			timestamp: "2026-01-01T00:00:03.000Z",
			type: "custom",
			customType: PLAN_CHANGE_ENTRY_TYPE,
			data: {
				kind: "plan/change",
				version: 1,
				operation: "approve",
				planId: "plan-9",
				revision: 1,
				handoffId: "handoff-9",
				approvedAt: 3,
			},
		} as SessionEntry;
		const committedTodo = {
			id: "t1",
			parentId: "c3",
			timestamp: "2026-01-01T00:00:04.000Z",
			type: "custom",
			customType: TODO_SNAPSHOT_ENTRY_TYPE,
			data: {
				version: 3,
				todos: [
					{
						content: "t",
						status: "pending",
						source: { kind: "plan-step", ref: { planId: "plan-9", planRevision: 1, stepId: "step-1" } },
					},
				],
				handoffOrigin: { handoffId: "handoff-9" },
			},
		} as SessionEntry;

		harness.host.setBranch([root, startChange, submitChange, approveChange, committedTodo]);
		await harness.lifecycle("session_start");

		expect(harness.host.activeTools).toEqual(expect.arrayContaining(["edit", "write", "bash"]));
		expect(harness.host.ui.setStatus).toHaveBeenLastCalledWith("plan:status", undefined);
		expect(harness.host.sentMessages).toHaveLength(0);
		expect(harness.host.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already committed"), "info");
	});
});
