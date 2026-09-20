import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createCompactionDetails } from "../src/compaction/details.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { compileContext } from "../src/runtime/compiler.js";
import { createRuntimeState } from "../src/runtime/state.js";
import { userMessage } from "./harness.js";

type AgentMessage = ContextEvent["messages"][number];

describe("context compiler", () => {
	it("marks a projection over the dsh threshold", () => {
		const messages = [userMessage(`pad:${"x".repeat(20_000)}`)];
		const compiled = compileFixture(messages, 1_000);
		expect(compiled.overThreshold).toBe(true);
		expect(compiled.budget).toEqual({
			contextWindow: 1_000,
			thresholdTokens: 800,
			retainTokens: 160,
		});
		expect(compiled.compactable).toBeNull();
	});

	it("can select a compactable prefix without crossing the dsh pressure threshold", () => {
		const messages = [0, 1, 2, 3].map((index) => userMessage(`turn-${index}:${"x".repeat(4_000)}`));
		const compiled = compileFixture(messages, 10_000);
		expect(compiled.budget).toEqual({
			contextWindow: 10_000,
			thresholdTokens: 8_000,
			retainTokens: 1_600,
		});
		expect(compiled.overThreshold).toBe(false);
		expect(compiled.compactable).not.toBeNull();
	});

	it("projects a pending checkpoint in place of the shadowed prefix", () => {
		const old = userMessage("old");
		const kept = userMessage("kept");
		const entries = [messageEntry("old", null, old), messageEntry("kept", "old", kept)];
		const state = createRuntimeState();
		const summary =
			"This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>\n# State\n</compacted-summary>";
		state.pendingCheckpoint = {
			snapshot: {
				runtimeGeneration: state.runtimeGeneration,
				branchEpoch: state.branchEpoch,
				installedCheckpointEntryId: null,
				coverageEntryIds: Object.freeze(["old"]),
				firstKeptEntryId: "kept",
				sourceFingerprint: "source",
			},
			summary,
			firstKeptEntryId: "kept",
			tokensBefore: 1_000,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			details: createCompactionDetails({
				summary,
				coveredThroughEntryId: "old",
				firstKeptEntryId: "kept",
				sourceFingerprint: "ab".repeat(32),
			}),
		};
		const compiled = compileFixture([old, kept], 128_000, entries, state);
		expect(compiled.messages[0]).toMatchObject({ role: "compactionSummary", summary });
		expect(compiled.messages[1]).toMatchObject({ role: "user" });
		if (compiled.messages[1]?.role === "user") {
			expect(compiled.messages[1].content[0]).toMatchObject({ type: "text", text: "kept" });
		}
	});

	it("keeps the resolved system message when projecting a pending checkpoint", () => {
		const system = systemMessage("system prompt");
		const old = userMessage("old");
		const kept = userMessage("kept");
		const entries = [
			messageEntry("sys", null, system),
			messageEntry("old", "sys", old),
			messageEntry("kept", "old", kept),
		];
		const state = createRuntimeState();
		state.pendingCheckpoint = pendingCheckpointFor(state, CHECKPOINT_SUMMARY, "kept", "old");
		const compiled = compileFixture([system, old, kept], 128_000, entries, state);
		// 0.86.0 的 prompt 与工具装载存在 system 消息里：投影必须像安装后那样保留它。
		expect(compiled.messages[0]).toMatchObject({ role: "system", content: "system prompt" });
		expect(compiled.messages[1]).toMatchObject({ role: "compactionSummary", summary: CHECKPOINT_SUMMARY });
		expect(compiled.messages[2]).toMatchObject({ role: "user" });
		// 合成 compaction entry 必须携带同一份 system 消息，否则 entry↔message 映射会错位。
		const synthetic = compiled.contextEntries[0];
		expect(synthetic?.type).toBe("compaction");
		if (synthetic?.type === "compaction") {
			expect(synthetic.systemMessage).toMatchObject({ role: "system", content: "system prompt" });
		}
	});

	it("keeps the rolling merge when an installed checkpoint carries a system message", () => {
		const system = systemMessage("system prompt");
		const turns = [0, 1, 2, 3].map((index) => userMessage(`turn-${index}:${"x".repeat(4_000)}`));
		const entries: SessionEntry[] = [
			compactionEntryWithSystemMessage("c1", null, CHECKPOINT_SUMMARY, "e0", system),
			...turns.map((message, index) => messageEntry(`e${index}`, index === 0 ? "c1" : `e${index - 1}`, message)),
		];
		const compiled = compileFixture([system, compactionSummaryMessage(CHECKPOINT_SUMMARY), ...turns], 10_000, entries);
		// system 消息与摘要属于 checkpoint 前缀，不能算作新可压缩内容，且必须恢复滚动合并。
		expect(compiled.compactable?.previousCheckpoint).toBe(CHECKPOINT_SUMMARY);
		expect(compiled.compactable?.newlyEligibleMessages.map((message) => message.role)).toEqual(["user", "user"]);
		expect(compiled.compactable?.firstEligibleEntryId).toBe("e0");
	});
});

function compileFixture(
	messages: readonly AgentMessage[],
	contextWindow: number,
	entries?: readonly SessionEntry[],
	state = createRuntimeState(),
) {
	const pi = {
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const context = {
		model: {
			id: "faux-1",
			provider: "faux",
			contextWindow,
			maxTokens: 16_384,
		},
		getSystemPrompt: () => "",
		sessionManager: {
			buildContextEntries: () => [
				...(entries ??
					messages.map((message, index) =>
						messageEntry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, message),
					)),
			],
		},
	} as unknown as ExtensionContext;
	return compileContext({
		pi,
		context,
		eventMessages: messages,
		state,
		config: DEFAULT_CONFIG,
	});
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-16T00:00:00.000Z",
		message,
	};
}

const CHECKPOINT_SUMMARY =
	"This is an automatically generated checkpoint condensing an earlier span of the conversation.";

type SystemAgentMessage = Extract<AgentMessage, { role: "system" }>;
type CompactionSummaryAgentMessage = Extract<AgentMessage, { role: "compactionSummary" }>;

function systemMessage(content: string): SystemAgentMessage {
	return { role: "system", content, timestamp: 0 };
}

function compactionSummaryMessage(summary: string): CompactionSummaryAgentMessage {
	return { role: "compactionSummary", summary, tokensBefore: 1_000, timestamp: 0 };
}

function compactionEntryWithSystemMessage(
	id: string,
	parentId: string | null,
	summary: string,
	firstKeptEntryId: string,
	system: SystemAgentMessage,
): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-08-16T00:00:00.000Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1_000,
		systemMessage: system,
	};
}

function pendingCheckpointFor(
	state: ReturnType<typeof createRuntimeState>,
	summary: string,
	firstKeptEntryId: string,
	coveredThroughEntryId: string,
) {
	return {
		snapshot: {
			runtimeGeneration: state.runtimeGeneration,
			branchEpoch: state.branchEpoch,
			installedCheckpointEntryId: null,
			coverageEntryIds: Object.freeze([coveredThroughEntryId]),
			firstKeptEntryId,
			sourceFingerprint: "source",
		},
		summary,
		firstKeptEntryId,
		tokensBefore: 1_000,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		details: createCompactionDetails({
			summary,
			coveredThroughEntryId,
			firstKeptEntryId,
			sourceFingerprint: "ab".repeat(32),
		}),
	};
}
