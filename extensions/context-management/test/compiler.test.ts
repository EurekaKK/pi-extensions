import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createCompactionDetails } from "../src/compaction/details.js";
import type { CheckpointCandidate } from "../src/compaction/lifecycle.js";
import { compileContext } from "../src/runtime/compiler.js";
import { createRuntimeState } from "../src/runtime/state.js";

type AgentMessage = ContextEvent["messages"][number];

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
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

function entries(messages: readonly AgentMessage[]): SessionEntry[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date(index * 1_000).toISOString(),
		message,
	}));
}

function model(contextWindow = 200_000): Model<Api> {
	return {
		id: "test",
		name: "Test",
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 32_000,
	};
}

function harness(messages: readonly AgentMessage[], contextWindow = 200_000) {
	const branch = entries(messages);
	const pi = {
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const context = {
		model: model(contextWindow),
		getSystemPrompt: () => "system",
		sessionManager: {
			buildContextEntries: () => [...branch],
			getBranch: () => [...branch],
		},
	} as unknown as ExtensionContext;
	return { branch, context, pi };
}

const usage: Usage = {
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("Context Compiler", () => {
	it("inserts a frozen Memory Pack immediately before the current run root", () => {
		const messages = [user("old", 1), assistant("answer", 2), user("current", 3)];
		const { branch, context, pi } = harness(messages);
		const state = createRuntimeState();
		state.currentRunEntryId = branch[2]?.id ?? null;
		state.runTimestamp = 1234;
		state.memoryPack = {
			items: [{ id: "mem_test", representation: "full", text: "memory-body", estimatedTokens: 4 }],
			text: "memory-body",
			estimatedTokens: 4,
		};
		const compiled = compileContext({ pi, context, eventMessages: messages, state });
		expect(compiled.messages.map((message) => message.role)).toEqual(["user", "assistant", "custom", "user"]);
		const pack = compiled.messages[2];
		expect(pack?.role).toBe("custom");
		if (pack?.role === "custom") {
			expect(pack.content).toBe("memory-body");
			expect(pack.timestamp).toBe(1234);
		}
		expect(compiled.fits).toBe(true);
	});

	it("projects one pending checkpoint and retains raw messages from firstKeptEntryId", () => {
		const messages = [user("old", 1), assistant("old answer", 2), user("kept", 3), assistant("kept answer", 4)];
		const { branch, context, pi } = harness(messages);
		const state = createRuntimeState();
		const details = createCompactionDetails({
			summary: "checkpoint",
			coveredThroughEntryId: branch[1]?.id ?? "missing",
			firstKeptEntryId: branch[2]?.id ?? "missing",
			sourceFingerprint: "source",
			evidenceReferences: [],
			now: new Date("2026-01-01T00:00:00Z"),
		});
		const candidate: CheckpointCandidate = {
			snapshot: {
				runtimeGeneration: state.runtimeGeneration,
				branchEpoch: 0,
				installedCheckpointEntryId: null,
				coverageEntryIds: [branch[0]?.id ?? "", branch[1]?.id ?? ""],
				firstKeptEntryId: branch[2]?.id ?? "",
				sourceFingerprint: "source",
				focus: null,
			},
			summary: "checkpoint",
			firstKeptEntryId: branch[2]?.id ?? "",
			tokensBefore: 100,
			usage,
			details,
		};
		state.pendingCheckpoint = candidate;
		const compiled = compileContext({ pi, context, eventMessages: messages, state });
		expect(compiled.messages.map((message) => message.role)).toEqual(["compactionSummary", "user", "assistant"]);
		expect(compiled.messages[0]).toMatchObject({ role: "compactionSummary", summary: "checkpoint" });
		expect(
			compiled.messages.some((message) => message.role === "user" && JSON.stringify(message).includes("old")),
		).toBe(false);
	});

	it("fails preflight when the complete request exceeds safe input", () => {
		const messages = [user("x".repeat(8_000), 1)];
		const { context, pi } = harness(messages, 21_000);
		const compiled = compileContext({ pi, context, eventMessages: messages, state: createRuntimeState() });
		expect(compiled.budget.safeInput).toBe(1_000);
		expect(compiled.fits).toBe(false);
	});
});
