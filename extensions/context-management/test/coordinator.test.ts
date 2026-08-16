import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ContextCoordinator } from "../src/runtime/coordinator.js";
import { createRuntimeState } from "../src/runtime/state.js";
import { renderContextStatus } from "../src/runtime/status.js";

function fakeContext(abort = vi.fn()): ExtensionContext {
	return {
		mode: "json",
		hasUI: false,
		cwd: process.cwd(),
		model: undefined,
		abort,
		signal: undefined,
		isIdle: () => false,
		ui: { notify: vi.fn(), setWorkingMessage: vi.fn() },
		sessionManager: {
			getBranch: () => [],
			buildContextEntries: () => [],
			getSessionId: () => "session",
			getLeafId: () => null,
		},
		getSystemPrompt: () => "secret-system-prompt",
	} as unknown as ExtensionContext;
}

function reductionFixture(): { messages: ContextEvent["messages"]; branch: SessionEntry[] } {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const messages: ContextEvent["messages"] = [
		{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-old", name: "read", arguments: { path: "a.ts" } }],
			api: "openai-responses",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-old",
			toolName: "read",
			content: [{ type: "text", text: "old observation" }],
			isError: false,
			timestamp: 3,
		},
		{ role: "user", content: [{ type: "text", text: "refresh" }], timestamp: 4 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-new", name: "read", arguments: { path: "a.ts" } }],
			api: "openai-responses",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 5,
		},
		{
			role: "toolResult",
			toolCallId: "call-new",
			toolName: "read",
			content: [{ type: "text", text: "new observation" }],
			isError: false,
			timestamp: 6,
		},
		{ role: "user", content: [{ type: "text", text: "tail".repeat(25_000) }], timestamp: 7 },
	];
	return {
		messages,
		branch: messages.map((message, index) => ({
			type: "message",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: new Date(index * 1_000).toISOString(),
			message,
		})),
	};
}

describe("ContextCoordinator failure boundaries", () => {
	it("aborts and returns a closed clone when final projection cannot be compiled", async () => {
		const abort = vi.fn();
		const context = fakeContext(abort);
		const api = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
		const coordinator = new ContextCoordinator(api, createRuntimeState());
		const messages: ContextEvent["messages"] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		];
		const result = await coordinator.context({ type: "context", messages }, context);
		expect(abort).toHaveBeenCalledOnce();
		expect(result.messages).toEqual(messages);
		expect(result.messages).not.toBe(messages);
		expect(context.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("context_management.context_estimate_failure"),
			"error",
		);
	});

	it("returns the last safe projection when a later compilation fails closed", async () => {
		const abort = vi.fn();
		const context = fakeContext(abort);
		context.model = {
			id: "test",
			name: "Test",
			api: "openai-responses",
			provider: "test",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		} satisfies Model<Api>;
		const api = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
		const coordinator = new ContextCoordinator(api, createRuntimeState());
		const safe: ContextEvent["messages"] = [{ role: "user", content: [{ type: "text", text: "safe" }], timestamp: 1 }];
		expect((await coordinator.context({ type: "context", messages: safe }, context)).messages).toEqual(safe);

		context.model = undefined;
		const unsafe: ContextEvent["messages"] = [
			{ role: "user", content: [{ type: "text", text: "unsafe" }], timestamp: 2 },
		];
		const result = await coordinator.context({ type: "context", messages: unsafe }, context);
		expect(abort).toHaveBeenCalledOnce();
		expect(result.messages).toEqual(safe);
		expect(result.messages).not.toBe(coordinator.state.lastSafeProjection);
	});

	it("always cancels native compaction on internal failure instead of falling through", async () => {
		const context = fakeContext();
		const api = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
		const coordinator = new ContextCoordinator(api, createRuntimeState());
		const event = {
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "kept",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
			},
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		} satisfies SessionBeforeCompactEvent;
		expect(await coordinator.beforeCompact(event, context)).toEqual({ cancel: true });
	});

	it("status exposes counts and paths but not pack bodies or prompts", () => {
		const state = createRuntimeState();
		state.memoryPack = {
			items: [{ id: "mem_secret", representation: "full", text: "TOP-SECRET-BODY", estimatedTokens: 3 }],
			text: "TOP-SECRET-BODY",
			estimatedTokens: 3,
		};
		const status = renderContextStatus(state, fakeContext());
		expect(status).toContain("1 full");
		expect(status).not.toContain("TOP-SECRET-BODY");
		expect(status).not.toContain("secret-system-prompt");
		expect(status).not.toContain("mem_secret");
	});

	it("shutdown is idempotent and aborts later memory work", async () => {
		const context = fakeContext();
		const api = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
		const coordinator = new ContextCoordinator(api, createRuntimeState());
		coordinator.shutdown(context);
		coordinator.shutdown(context);
		await expect(coordinator.state.memory.refresh(context.cwd)).rejects.toMatchObject({
			code: "context_management.operation_aborted",
		});
		expect(context.ui.setWorkingMessage).toHaveBeenCalledTimes(2);
	});

	it("commits only the newest asynchronously built Memory Pack", async () => {
		const context = fakeContext();
		const api = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
		const state = createRuntimeState();
		const resolvers = new Map<string, (pack: { items: []; text: string; estimatedTokens: number }) => void>();
		vi.spyOn(state.memory, "buildPack").mockImplementation(
			async (_cwd, prompt) =>
				await new Promise((resolve) => {
					resolvers.set(prompt, resolve);
				}),
		);
		const activate = vi.spyOn(state.memory, "setActivationPrompt");
		const coordinator = new ContextCoordinator(api, state);
		const older = coordinator.beforeAgentStart("older", context);
		const newer = coordinator.beforeAgentStart("newer", context);
		resolvers.get("newer")?.({ items: [], text: "newer-pack", estimatedTokens: 3 });
		await newer;
		resolvers.get("older")?.({ items: [], text: "older-pack", estimatedTokens: 3 });
		await older;
		expect(state.memoryPack?.text).toBe("newer-pack");
		expect(activate).toHaveBeenCalledOnce();
		expect(activate).toHaveBeenCalledWith("newer");
	});

	it("uses a transient supersession marker before materializing one stable reduction epoch", async () => {
		const fixture = reductionFixture();
		const context = {
			...fakeContext(),
			model: {
				id: "test",
				name: "Test",
				api: "openai-responses",
				provider: "test",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			} satisfies Model<Api>,
			sessionManager: {
				getBranch: () => fixture.branch,
				buildContextEntries: () => fixture.branch,
				getSessionId: () => "session",
				getLeafId: () => "entry-6",
			},
		} as unknown as ExtensionContext;
		const api = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
		const coordinator = new ContextCoordinator(api, createRuntimeState());
		const marked = await coordinator.context({ type: "context", messages: fixture.messages }, context);
		expect(coordinator.state.reductionStats.supersessionCount).toBe(1);
		expect(coordinator.state.activeReductions).toHaveLength(0);
		expect(coordinator.state.pendingSupersessions).toHaveLength(1);
		expect(JSON.stringify(marked.messages)).toContain("cm-evidence:v1:entry-2 is superseded by cm-evidence:v1:entry-5");
		expect(JSON.stringify(marked.messages)).toContain("old observation");

		const materialized = await coordinator.context({ type: "context", messages: fixture.messages }, context);
		const epoch = coordinator.state.projectionEpoch;
		const savings = coordinator.state.reductionStats.estimatedSavings;
		expect(coordinator.state.activeReductions).toHaveLength(1);
		expect(coordinator.state.pendingSupersessions).toHaveLength(0);
		expect(JSON.stringify(materialized.messages)).toContain(
			"evidence cm-evidence:v1:entry-2 superseded by cm-evidence:v1:entry-5",
		);
		expect(JSON.stringify(materialized.messages)).not.toContain("old observation");

		await coordinator.context({ type: "context", messages: fixture.messages }, context);
		expect(coordinator.state.projectionEpoch).toBe(epoch);
		expect(coordinator.state.reductionStats.estimatedSavings).toBe(savings);
		expect(coordinator.state.reductionStats.supersessionCount).toBe(1);
	});

	it("keeps a supersession marker stable while the old observation remains in the protected tail", async () => {
		const full = reductionFixture();
		const messages = full.messages.slice(0, 6);
		const branch = full.branch.slice(0, 6);
		const context = {
			...fakeContext(),
			model: {
				id: "test",
				name: "Test",
				api: "openai-responses",
				provider: "test",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			} satisfies Model<Api>,
			sessionManager: {
				getBranch: () => branch,
				buildContextEntries: () => branch,
				getSessionId: () => "session",
				getLeafId: () => "entry-5",
			},
		} as unknown as ExtensionContext;
		const api = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
		const coordinator = new ContextCoordinator(api, createRuntimeState());
		for (let barrier = 0; barrier < 2; barrier += 1) {
			const projected = await coordinator.context({ type: "context", messages }, context);
			expect(JSON.stringify(projected.messages)).toContain(
				"cm-evidence:v1:entry-2 is superseded by cm-evidence:v1:entry-5",
			);
			expect(coordinator.state.activeReductions).toHaveLength(0);
			expect(coordinator.state.pendingSupersessions).toHaveLength(1);
		}
		expect(coordinator.state.reductionStats.supersessionCount).toBe(1);
	});

	it("suppresses only the whole automatic Memory Pack when no compactable prefix remains", async () => {
		const abort = vi.fn();
		const message: ContextEvent["messages"][number] = {
			role: "user",
			content: [{ type: "text", text: "u".repeat(3_000) }],
			timestamp: 1,
		};
		const branch: SessionEntry[] = [
			{
				type: "message",
				id: "current",
				parentId: null,
				timestamp: "2026-08-16T00:00:00.000Z",
				message,
			},
		];
		const context = {
			...fakeContext(abort),
			model: {
				id: "small",
				name: "Small",
				api: "openai-responses",
				provider: "test",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 21_000,
				maxTokens: 1_000,
			} satisfies Model<Api>,
			sessionManager: {
				getBranch: () => branch,
				buildContextEntries: () => branch,
				getSessionId: () => "session",
				getLeafId: () => "current",
			},
		} as unknown as ExtensionContext;
		const state = createRuntimeState();
		state.memoryPack = {
			items: [{ id: "mem_pack", representation: "full", text: "m".repeat(1_600), estimatedTokens: 404 }],
			text: "m".repeat(1_600),
			estimatedTokens: 404,
		};
		const api = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
		const coordinator = new ContextCoordinator(api, state);
		const result = await coordinator.context({ type: "context", messages: [message] }, context);
		expect(result.messages).toEqual([message]);
		expect(state.memoryPackSuppressed).toBe(true);
		expect(state.memoryPack).not.toBeNull();
		expect(abort).not.toHaveBeenCalled();

		coordinator.agentSettled(context);
		expect(state.memoryPackSuppressed).toBe(false);
		expect(state.memoryPack).toBeNull();
		vi.spyOn(state.memory, "buildPack").mockResolvedValue({
			items: [],
			text: "rebuilt-next-run",
			estimatedTokens: 0,
		});
		await coordinator.beforeAgentStart("next run", context);
		expect(state.memoryPackSuppressed).toBe(false);
		expect(state.memoryPack?.text).toBe("rebuilt-next-run");
	});
});
