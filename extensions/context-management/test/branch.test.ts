import { type ContextEvent, type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { selectCompactable } from "../src/compaction/selection.js";
import { conversationUnits, selectProtectedTail } from "../src/runtime/branch.js";

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

	it("keeps only the newest conversation unit when retainTokens is 0", () => {
		const messages = [user("first"), user("second"), user("third")];
		const tail = selectProtectedTail(messages, 0);
		expect(tail.startIndex).toBe(2);
		expect(tail.messages).toEqual([messages[2]]);
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

	it("declines when the whole surface is one tool pair", () => {
		const messages = [user("only"), ...toolTurn("result")];
		expect(
			selectCompactable({
				messages,
				contextEntries: entriesFrom(messages),
				tailTarget: 0,
				currentRunEntryId: null,
			}),
		).toBeNull();
	});

	it("maps retainTokens 0 to the newest unit and a pressure retain budget to no compactable prefix", () => {
		const messages = [user("first"), user("second"), user("third")];
		const compactNow = selectCompactable({
			messages,
			contextEntries: entriesFrom(messages),
			tailTarget: 0,
			currentRunEntryId: null,
		});
		expect(compactNow?.firstKeptEntryId).toBe("entry-2");
		expect(compactNow?.newlyEligibleMessages).toHaveLength(2);
		expect(
			selectCompactable({
				messages,
				contextEntries: entriesFrom(messages),
				tailTarget: 1_000_000,
				currentRunEntryId: null,
			}),
		).toBeNull();
	});

	it("keeps the newest whole tool-call/result pair when retainTokens is 0", () => {
		const messages = [user("old"), ...toolTurn("old-result"), user("kept"), ...toolTurn("kept-result")];
		const selection = selectCompactable({
			messages,
			contextEntries: entriesFrom(messages),
			tailTarget: 0,
			currentRunEntryId: null,
		});
		expect(selection?.firstKeptEntryId).toBe("entry-3");
		expect(selection?.tail.messages.at(-1)).toMatchObject({ role: "toolResult" });
		const eligible = JSON.stringify(selection?.newlyEligibleMessages);
		expect(eligible).toContain("old-result");
		expect(eligible).not.toContain("kept-result");
	});

	it("starts rolling coverage at the previous compaction's retained boundary", () => {
		const previous = user("previous retained tail");
		const newer = user("newer history");
		const kept = user("kept");
		const contextEntries: SessionEntry[] = [
			{
				type: "compaction",
				id: "checkpoint",
				parentId: "previous-kept",
				timestamp: new Date(2).toISOString(),
				summary: "old checkpoint",
				firstKeptEntryId: "previous-kept",
				tokensBefore: 100,
			},
			{
				type: "message",
				id: "previous-kept",
				parentId: "old",
				timestamp: new Date(1).toISOString(),
				message: previous,
			},
			{
				type: "message",
				id: "newer",
				parentId: "checkpoint",
				timestamp: new Date(3).toISOString(),
				message: newer,
			},
			{
				type: "message",
				id: "kept",
				parentId: "newer",
				timestamp: new Date(4).toISOString(),
				message: kept,
			},
		];
		const selection = selectCompactable({
			messages: contextEntries.flatMap((entry) => sessionEntryToContextMessages(entry)),
			contextEntries,
			tailTarget: 0,
			currentRunEntryId: null,
		});
		expect(selection?.firstKeptEntryId).toBe("kept");
		expect(selection?.firstEligibleEntryId).toBe("previous-kept");
		expect(selection?.coveredThroughEntryId).toBe("newer");
		expect(selection?.previousCheckpoint).toBe("old checkpoint");
	});
});

function entriesFrom(messages: readonly AgentMessage[]): SessionEntry[] {
	return messages.map((message, index) => ({
		type: "message" as const,
		id: `entry-${index}`,
		parentId: index === 0 ? null : `entry-${index - 1}`,
		timestamp: new Date(index * 1_000).toISOString(),
		message,
	}));
}
