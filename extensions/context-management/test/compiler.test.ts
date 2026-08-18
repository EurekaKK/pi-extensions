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
