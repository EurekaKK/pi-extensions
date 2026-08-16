import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyEvidenceReductions, applySupersessionMarkers } from "../src/evidence/projection.js";
import { evidenceStubText, normalizeBuiltInInput, planEvidenceReductions } from "../src/evidence/reducers.js";
import { findEvidence, indexFinalizedToolPairs } from "../src/evidence/references.js";
import { EvidenceState } from "../src/evidence/state.js";

function assistant(callId: string, input: Record<string, unknown>, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "read", arguments: input }],
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
		stopReason: "toolUse",
		timestamp,
	};
}

function result(callId: string, text: string, timestamp: number, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text }],
		details: { stable: true },
		isError,
		timestamp,
	};
}

function entry(id: string, message: AssistantMessage | ToolResultMessage, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

function branch(secondText = "same", secondError = false): SessionEntry[] {
	return [
		entry("call-entry-1", assistant("call-1", { path: "a.ts" }, 1), null),
		entry("result-entry-1", result("call-1", "same", 2), "call-entry-1"),
		entry("call-entry-2", assistant("call-2", { path: "a.ts" }, 3), "result-entry-1"),
		entry("result-entry-2", result("call-2", secondText, 4, secondError), "call-entry-2"),
	];
}

describe("Evidence", () => {
	it("indexes finalized branch-local pairs and rejects off-branch references", () => {
		const entries = branch();
		const pairs = indexFinalizedToolPairs(entries);
		expect(pairs.map((pair) => pair.reference)).toEqual([
			"cm-evidence:v1:result-entry-1",
			"cm-evidence:v1:result-entry-2",
		]);
		expect(findEvidence(entries, pairs[0]?.reference ?? "").toolCallId).toBe("call-1");
		expect(() => findEvidence(entries.slice(2), "cm-evidence:v1:result-entry-1")).toThrow(
			/not a finalized tool result/,
		);
	});

	it("does not expose a reference when the complete pair cannot be stably serialized", () => {
		const entries = branch();
		const target = entries[1];
		if (target?.type !== "message" || target.message.role !== "toolResult") {
			throw new Error("Expected a tool result fixture.");
		}
		target.message.details = new Date();
		expect(indexFinalizedToolPairs(entries).map((pair) => pair.entryId)).not.toContain("result-entry-1");
	});

	it("keeps every occurrence raw when a toolCallId is reused", () => {
		const entries = branch();
		const secondCall = entries[2];
		const secondResult = entries[3];
		if (
			secondCall?.type !== "message" ||
			secondCall.message.role !== "assistant" ||
			secondResult?.type !== "message" ||
			secondResult.message.role !== "toolResult"
		) {
			throw new Error("Expected a second finalized pair fixture.");
		}
		const call = secondCall.message.content.find((block) => block.type === "toolCall");
		if (call === undefined) throw new Error("Expected a tool call fixture.");
		call.id = "call-1";
		secondResult.message.toolCallId = "call-1";
		expect(indexFinalizedToolPairs(entries)).toEqual([]);
	});

	it("normalizes omitted read offset to one and proves exact duplicates", async () => {
		const pairs = indexFinalizedToolPairs(branch());
		const first = pairs[0];
		const second = pairs[1];
		if (first === undefined || second === undefined) throw new Error("Expected two finalized pairs.");
		expect(await normalizeBuiltInInput(first, process.cwd())).toBe(
			await normalizeBuiltInInput({ ...second, input: { path: "a.ts", offset: 1 } }, process.cwd()),
		);
		const reductions = await planEvidenceReductions(pairs, new Set(), process.cwd());
		expect(reductions).toHaveLength(1);
		expect(reductions[0]?.kind).toBe("duplicate");
		const reduction = reductions[0];
		if (reduction === undefined) throw new Error("Expected one reduction.");
		expect(evidenceStubText(reduction)).toBe("[context-management: duplicate evidence cm-evidence:v1:result-entry-1]");
	});

	it("expands the current grep, find, and ls defaults and rejects unknown fields", async () => {
		const pair = indexFinalizedToolPairs(branch())[0];
		if (pair === undefined) throw new Error("Expected a finalized pair fixture.");
		const cwd = process.cwd();
		expect(await normalizeBuiltInInput({ ...pair, toolName: "grep", input: { pattern: "x" } }, cwd)).toBe(
			await normalizeBuiltInInput(
				{
					...pair,
					toolName: "grep",
					input: { pattern: "x", context: 0, ignoreCase: false, literal: false, limit: 100 },
				},
				cwd,
			),
		);
		expect(await normalizeBuiltInInput({ ...pair, toolName: "find", input: { pattern: "*.ts" } }, cwd)).toBe(
			await normalizeBuiltInInput({ ...pair, toolName: "find", input: { pattern: "*.ts", limit: 1_000 } }, cwd),
		);
		expect(await normalizeBuiltInInput({ ...pair, toolName: "ls", input: {} }, cwd)).toBe(
			await normalizeBuiltInInput({ ...pair, toolName: "ls", input: { limit: 500 } }, cwd),
		);
		expect(await normalizeBuiltInInput({ ...pair, input: { path: "a.ts", unknown: true } }, cwd)).toBeNull();
	});

	it.each(["grep", "find", "ls"])("rejects a non-string path for %s reductions", async (toolName) => {
		const pair = indexFinalizedToolPairs(branch())[0];
		if (pair === undefined) throw new Error("Expected a finalized pair fixture.");
		const input = toolName === "ls" ? { path: 42 } : { path: 42, pattern: "x" };
		expect(await normalizeBuiltInInput({ ...pair, toolName, input }, process.cwd())).toBeNull();
	});

	it("uses every semantic call/result field for exact duplicate identity", async () => {
		const mutations: Array<(entries: SessionEntry[]) => void> = [
			(entries) => {
				const message = entries[1]?.type === "message" ? entries[1].message : undefined;
				if (message?.role === "toolResult") message.details = { changed: true };
			},
			(entries) => {
				const message = entries[1]?.type === "message" ? entries[1].message : undefined;
				if (message?.role === "toolResult")
					message.usage = {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
			},
			(entries) => {
				const message = entries[1]?.type === "message" ? entries[1].message : undefined;
				if (message?.role === "toolResult") message.isError = true;
			},
			(entries) => {
				const message = entries[0]?.type === "message" ? entries[0].message : undefined;
				if (message?.role === "assistant") {
					const call = message.content.find((block) => block.type === "toolCall");
					if (call !== undefined) call.arguments = { path: "different.ts" };
				}
			},
		];
		for (const mutate of mutations) {
			const entries = branch();
			mutate(entries);
			const reductions = await planEvidenceReductions(indexFinalizedToolPairs(entries), new Set(), process.cwd());
			expect(reductions.some((candidate) => candidate.kind === "duplicate")).toBe(false);
		}
	});

	it("does not semantically supersede images or extension-defined tools", async () => {
		const imageEntries = branch("new text");
		const firstImage = imageEntries[1]?.type === "message" ? imageEntries[1].message : undefined;
		if (firstImage?.role !== "toolResult") throw new Error("Expected a tool result fixture.");
		firstImage.content = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
		expect(await planEvidenceReductions(indexFinalizedToolPairs(imageEntries), new Set(), process.cwd())).toEqual([]);

		const customEntries = branch("new text");
		for (const entry of customEntries) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "assistant") {
				for (const block of entry.message.content) if (block.type === "toolCall") block.name = "custom_read";
			} else if (entry.message.role === "toolResult") entry.message.toolName = "custom_read";
		}
		expect(await planEvidenceReductions(indexFinalizedToolPairs(customEntries), new Set(), process.cwd())).toEqual([]);
	});

	it("uses supersession for same normalized input with different successful text", async () => {
		const entries = branch("new observation");
		const original = entries[1];
		if (original?.type !== "message" || original.message.role !== "toolResult") {
			throw new Error("Expected an original tool result fixture.");
		}
		original.message.addedToolNames = ["later_tool"];
		const pairs = indexFinalizedToolPairs(entries);
		const reductions = await planEvidenceReductions(pairs, new Set(), process.cwd());
		expect(reductions).toHaveLength(1);
		expect(reductions[0]?.kind).toBe("superseded");
		const reduction = reductions[0];
		if (reduction === undefined) throw new Error("Expected one supersession reduction.");
		const rawMessages = entries.flatMap((candidate) => (candidate.type === "message" ? [candidate.message] : []));
		const marked = applySupersessionMarkers(rawMessages, [reduction]);
		const markedOld = marked.find((message) => message.role === "toolResult" && message.toolCallId === "call-1");
		const markedNew = marked.find((message) => message.role === "toolResult" && message.toolCallId === "call-2");
		expect(markedOld).toEqual(original.message);
		expect(markedNew).toMatchObject({
			role: "toolResult",
			content: expect.arrayContaining([
				{
					type: "text",
					text: "\n\n[context-management: cm-evidence:v1:result-entry-1 is superseded by cm-evidence:v1:result-entry-2]",
				},
			]),
		});
		const projected = applyEvidenceReductions(rawMessages, reductions);
		const old = projected.find((message) => message.role === "toolResult" && message.toolCallId === "call-1");
		expect(old).toMatchObject({
			role: "toolResult",
			toolCallId: "call-1",
			isError: false,
			content: [
				{
					text: "[context-management: evidence cm-evidence:v1:result-entry-1 superseded by cm-evidence:v1:result-entry-2]",
				},
			],
		});
		expect(old).not.toHaveProperty("details");
		expect(old).not.toHaveProperty("usage");
		expect(old).toHaveProperty("addedToolNames", ["later_tool"]);
	});

	it("appends every transient marker when one newest result supersedes several observations", async () => {
		const entries = branch("middle observation");
		entries.push(
			entry("call-entry-3", assistant("call-3", { path: "a.ts" }, 5), "result-entry-2"),
			entry("result-entry-3", result("call-3", "newest observation", 6), "call-entry-3"),
		);
		const reductions = await planEvidenceReductions(indexFinalizedToolPairs(entries), new Set(), process.cwd());
		expect(reductions.filter((reduction) => reduction.kind === "superseded")).toHaveLength(2);
		const marked = applySupersessionMarkers(
			entries.flatMap((candidate) => (candidate.type === "message" ? [candidate.message] : [])),
			reductions,
		);
		const newest = marked.find((message) => message.role === "toolResult" && message.toolCallId === "call-3");
		if (newest?.role !== "toolResult") throw new Error("Expected the newest tool result.");
		expect(
			newest.content.filter((block) => block.type === "text" && block.text.includes("is superseded by")),
		).toHaveLength(2);
	});

	it("never supersedes errors or protected tool calls", async () => {
		const errored = indexFinalizedToolPairs(branch("failed", true));
		expect(await planEvidenceReductions(errored, new Set(), process.cwd())).toEqual([]);
		const successful = indexFinalizedToolPairs(branch("new"));
		expect(await planEvidenceReductions(successful, new Set(["call-1"]), process.cwd())).toEqual([]);
	});

	it("keeps same-content pairs raw when deferred tool availability prevents exact duplication", async () => {
		const entries = branch();
		const firstResult = entries[1];
		if (firstResult?.type !== "message" || firstResult.message.role !== "toolResult") {
			throw new Error("Expected a tool result fixture.");
		}
		firstResult.message.addedToolNames = ["later_tool"];
		const pairs = indexFinalizedToolPairs(entries);
		const reductions = await planEvidenceReductions(pairs, new Set(), process.cwd());
		expect(reductions).toEqual([]);
	});

	it("orders pending admission by evidence-read call order rather than target history order", () => {
		const entries = branch();
		const pairs = indexFinalizedToolPairs(entries);
		const evidence = new EvidenceState();
		evidence.request("read-newer", entries, pairs[1]?.reference ?? "");
		evidence.request("read-older", entries, pairs[0]?.reference ?? "");
		expect(evidence.pending.map((candidate) => candidate.requestToolCallId)).toEqual(["read-newer", "read-older"]);
	});
});
