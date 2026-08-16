import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { selectCompactable } from "../src/compaction/selection.js";
import { conversationUnits, selectProtectedTail } from "../src/runtime/branch.js";
import { selectionFromNative } from "../src/runtime/coordinator.js";

type AgentMessage = ContextEvent["messages"][number];

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function toolTurn(text: string): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: `call-${text}`, name: "read", arguments: { path: text } }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: `call-${text}`,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 3,
		},
	];
}

describe("protected tail", () => {
	it("keeps tool calls and results in the same conversation unit", () => {
		const messages = [user("first"), ...toolTurn("a"), user("second"), ...toolTurn("b")];
		const units = conversationUnits(messages);
		expect(units).toHaveLength(2);
		expect(units[1]).toMatchObject({ start: 3, end: 6 });
	});

	it("keeps an oversized current unit whole", () => {
		const messages = [user("old"), user("new"), ...toolTurn("x".repeat(10_000))];
		const tail = selectProtectedTail(messages, 10, 1);
		expect(tail.startIndex).toBe(1);
		expect(tail.messages[0]?.role).toBe("user");
		expect(tail.messages.at(-1)?.role).toBe("toolResult");
	});

	it("treats an LLM-visible custom message as a legal unit boundary", () => {
		const custom: AgentMessage = {
			role: "custom",
			customType: "test.visible",
			content: "contract",
			display: false,
			timestamp: 2,
		};
		const units = conversationUnits([user("old"), custom, user("new")]);
		expect(units.map((unit) => unit.start)).toEqual([0, 1, 2]);
	});

	it("never places an unfinished tool call in the compactable prefix", () => {
		const unfinished = toolTurn("unfinished")[0];
		if (unfinished === undefined) throw new Error("Expected a tool call fixture.");
		const messages = [user("old"), unfinished, user(`new:${"x".repeat(1_000)}`)];
		const entries = messages.map((message, index) => ({
			type: "message" as const,
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: new Date(index * 1_000).toISOString(),
			message,
		}));
		expect(
			selectCompactable({
				messages,
				contextEntries: entries,
				tailTarget: 10,
				currentRunEntryId: null,
			}),
		).toBeNull();
	});

	it("starts native rolling coverage at the previous compaction's retained boundary", () => {
		const previous = user("previous retained tail");
		const newer = user("newer history");
		const kept = user("kept");
		const branch = [
			{
				type: "message" as const,
				id: "old",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: user("old"),
			},
			{
				type: "message" as const,
				id: "previous-kept",
				parentId: "old",
				timestamp: new Date(1).toISOString(),
				message: previous,
			},
			{
				type: "compaction" as const,
				id: "checkpoint",
				parentId: "previous-kept",
				timestamp: new Date(2).toISOString(),
				summary: "old checkpoint",
				firstKeptEntryId: "previous-kept",
				tokensBefore: 100,
			},
			{
				type: "message" as const,
				id: "newer",
				parentId: "checkpoint",
				timestamp: new Date(3).toISOString(),
				message: newer,
			},
			{
				type: "message" as const,
				id: "kept",
				parentId: "newer",
				timestamp: new Date(4).toISOString(),
				message: kept,
			},
		];
		const selection = selectionFromNative({
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "kept",
				messagesToSummarize: [previous, newer],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				previousSummary: "old checkpoint",
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
			},
			branchEntries: branch,
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});
		expect(selection.firstEligibleEntryId).toBe("previous-kept");
		expect(selection.coveredThroughEntryId).toBe("newer");
		expect(selection.previousCheckpoint).toBe("old checkpoint");
	});
});
