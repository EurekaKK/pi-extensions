import { type Api, createFauxCore, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ContextCoordinator } from "../src/runtime/coordinator.js";
import { createRuntimeState } from "../src/runtime/state.js";

type AgentMessage = ContextEvent["messages"][number];

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "context-management-faux-api",
		provider: "context-management-faux",
		model: "fixture-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function messageEntries(messages: readonly AgentMessage[]): SessionEntry[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date(index * 1_000).toISOString(),
		message,
	}));
}

function harness(messages: readonly AgentMessage[], idle = false, mode: ExtensionContext["mode"] = "json") {
	const faux = createFauxCore({
		api: "context-management-faux-api",
		provider: "context-management-faux",
		models: [
			{
				id: "fixture-model",
				name: "Fixture model",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 200_000,
				maxTokens: 32_000,
			},
		],
		tokensPerSecond: 0,
	});
	const model = faux.getModel() as Model<Api>;
	let branch = messageEntries(messages);
	let isIdle = idle;
	const compact = vi.fn();
	const abort = vi.fn();
	const notify = vi.fn();
	const setWorkingMessage = vi.fn();
	const context = {
		mode,
		hasUI: false,
		cwd: process.cwd(),
		model,
		thinkingLevel: "high",
		abort,
		isIdle: () => isIdle,
		compact,
		ui: { notify, setWorkingMessage },
		modelRegistry: {
			getProvider: () => faux,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-key" }),
		},
		sessionManager: {
			getBranch: () => [...branch],
			buildContextEntries: () => [...branch],
			getSessionId: () => "session",
			getLeafId: () => branch.at(-1)?.id ?? null,
		},
		getSystemPrompt: () => "system",
	} as unknown as ExtensionContext;
	const api = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
	return {
		abort,
		compact,
		context,
		faux,
		notify,
		setWorkingMessage,
		setBranch: (next: readonly SessionEntry[]) => {
			branch = [...next];
		},
		setIdle: (next: boolean) => {
			isIdle = next;
		},
		coordinator: new ContextCoordinator(api, createRuntimeState()),
	};
}

describe("ContextCoordinator compaction lifecycle", () => {
	it("anchors run-scoped packs after prior history when Pi emits agent_start before persisting the new user", async () => {
		const historical = [user("old", 1), assistant("old answer", 2)];
		const current = [...historical, user("current", 3)];
		const test = harness(historical);
		vi.spyOn(test.coordinator.state.memory, "buildPack").mockResolvedValue({
			items: [{ id: "mem_test", representation: "full", text: "memory-body", estimatedTokens: 4 }],
			text: "memory-body",
			estimatedTokens: 4,
		});

		await test.coordinator.beforeAgentStart("current", test.context);
		test.setBranch(messageEntries(current));
		const projected = await test.coordinator.context({ type: "context", messages: current }, test.context);

		expect(projected.messages.map((message) => message.role)).toEqual(["user", "assistant", "custom", "user"]);
	});

	it("prepares above the lead threshold without blocking and installs only after the agent settles", async () => {
		const messages = [
			user(`old:${"x".repeat(520_000)}`, 1),
			assistant("old answer", 2),
			user(`tail:${"y".repeat(84_000)}`, 3),
		];
		const test = harness(messages);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		test.faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("# Checkpoint\n\nPrepared state.");
			},
		]);

		const projected = await test.coordinator.context({ type: "context", messages }, test.context);
		expect(projected.messages).toHaveLength(messages.length);
		expect(test.coordinator.state.preparation.kind).toBe("preparing");
		expect(test.compact).not.toHaveBeenCalled();
		expect(test.abort).not.toHaveBeenCalled();

		release?.();
		const preparing = test.coordinator.state.preparation;
		if (preparing.kind !== "preparing") throw new Error("Preparation did not start.");
		await preparing.promise;
		expect(test.coordinator.state.preparation.kind).toBe("ready");
		expect(test.compact).not.toHaveBeenCalled();

		test.setIdle(true);
		test.coordinator.agentSettled(test.context);
		expect(test.compact).toHaveBeenCalledOnce();
		expect(test.coordinator.state.preparation.kind).toBe("installing");
	});

	it("cancels a native wait without cancelling the session-scoped background preparation", async () => {
		const messages = [
			user(`old:${"x".repeat(520_000)}`, 1),
			assistant("old answer", 2),
			user(`tail:${"y".repeat(84_000)}`, 3),
		];
		const test = harness(messages);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		test.faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage("# Checkpoint\n\nPrepared state.");
			},
		]);
		await test.coordinator.context({ type: "context", messages }, test.context);
		const preparation = test.coordinator.state.preparation;
		if (preparation.kind !== "preparing") throw new Error("Preparation did not start.");

		const controller = new AbortController();
		controller.abort();
		const native = await test.coordinator.beforeCompact(
			{
				type: "session_before_compact",
				signal: controller.signal,
			} as unknown as SessionBeforeCompactEvent,
			test.context,
		);
		expect(native).toEqual({ cancel: true });
		expect(test.coordinator.state.preparation.kind).toBe("preparing");
		expect(test.faux.state.callCount).toBe(1);

		release?.();
		await preparation.promise;
		expect(test.coordinator.state.preparation.kind).toBe("ready");
	});

	it("records background failure code and time without an unsolicited notification", async () => {
		const messages = [
			user(`old:${"x".repeat(520_000)}`, 1),
			assistant("old answer", 2),
			user(`tail:${"y".repeat(84_000)}`, 3),
		];
		const test = harness(messages);
		test.faux.setResponses([fauxAssistantMessage("")]);
		await test.coordinator.context({ type: "context", messages }, test.context);
		const preparation = test.coordinator.state.preparation;
		if (preparation.kind !== "preparing") throw new Error("Preparation did not start.");
		await preparation.promise;
		const completed = test.coordinator.state.preparation;
		expect(completed.kind).toBe("idle");
		if (completed.kind !== "idle") throw new Error("Preparation did not finish.");
		expect(completed.lastFailure?.code).toBe("context_management.checkpoint_validation_failure");
		expect(Date.parse(completed.lastFailure?.at ?? "")).not.toBeNaN();
		expect(test.notify).not.toHaveBeenCalled();
		expect(test.abort).not.toHaveBeenCalled();
	});

	it("synchronously checkpoints an over-budget request and hands the exact candidate to native compaction", async () => {
		const messages = [
			user(`old:${"x".repeat(600_000)}`, 1),
			assistant("old answer", 2),
			user(`tail:${"y".repeat(140_000)}`, 3),
		];
		const test = harness(messages);
		test.faux.setResponses([fauxAssistantMessage("# Checkpoint\n\nRecovered state.")]);

		const projected = await test.coordinator.context({ type: "context", messages }, test.context);
		const pending = test.coordinator.state.pendingCheckpoint;
		expect(test.faux.state.callCount).toBe(1);
		expect(test.abort).not.toHaveBeenCalled();
		expect(pending).toBeDefined();
		expect(projected.messages[0]).toMatchObject({ role: "compactionSummary", summary: pending?.summary });
		expect(projected.messages.at(-1)).toEqual(messages.at(-1));

		const nativeEvent = {
			type: "session_before_compact",
			customInstructions: undefined,
			signal: new AbortController().signal,
		} as unknown as SessionBeforeCompactEvent;
		const native = await test.coordinator.beforeCompact(nativeEvent, test.context);
		expect(native.compaction).toMatchObject({
			summary: pending?.summary,
			firstKeptEntryId: pending?.firstKeptEntryId,
			details: pending?.details,
		});
		expect(test.faux.state.callCount).toBe(1);

		if (pending === undefined) throw new Error("Synchronous recovery did not create a checkpoint.");
		const compactionEntry: SessionEntry = {
			type: "compaction",
			id: pending.details.checkpointId,
			parentId: null,
			timestamp: pending.details.createdAt,
			summary: pending.summary,
			firstKeptEntryId: pending.firstKeptEntryId,
			tokensBefore: pending.tokensBefore,
			usage: pending.usage,
			details: pending.details,
			fromHook: true,
		};
		test.setBranch([compactionEntry]);
		test.coordinator.sessionCompact(
			{
				type: "session_compact",
				compactionEntry,
				fromExtension: true,
				reason: "overflow",
				willRetry: true,
			} satisfies SessionCompactEvent,
			test.context,
		);
		expect(test.coordinator.state.pendingCheckpoint).toBeUndefined();
		expect(test.coordinator.state.installedCheckpoint).toMatchObject({
			kind: "context-management",
			entryId: pending.details.checkpointId,
			summary: pending.summary,
		});
	});

	it("fails closed and cleans the working state when synchronous compaction cannot produce a valid checkpoint", async () => {
		const messages = [
			user(`old:${"x".repeat(600_000)}`, 1),
			assistant("old answer", 2),
			user(`tail:${"y".repeat(140_000)}`, 3),
		];
		const test = harness(messages, false, "tui");
		test.faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);

		const projected = await test.coordinator.context({ type: "context", messages }, test.context);
		expect(test.faux.state.callCount).toBe(2);
		expect(test.abort).toHaveBeenCalledOnce();
		expect(test.compact).not.toHaveBeenCalled();
		expect(projected.messages).toEqual(messages);
		expect(test.coordinator.state.blockingState).toBe("context_management.checkpoint_validation_failure");
		expect(test.setWorkingMessage).toHaveBeenLastCalledWith();
		expect(test.notify).toHaveBeenCalledWith(
			expect.stringContaining("context_management.checkpoint_validation_failure"),
			"error",
		);
	});
});
