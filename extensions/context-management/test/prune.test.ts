import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { PRUNE_MARKER } from "../src/constants.js";
import { applyPruneToMessages, codePointLength, measureContent, pruneContent } from "../src/prune.js";

describe("tool-result pruner", () => {
	it("keeps content at or below the threshold", () => {
		expect(pruneContent([{ type: "text", text: "short" }], DEFAULT_CONFIG.prune)).toBeNull();
	});

	it("replaces an oversized middle with a fixed marker and is idempotent", () => {
		const text = `${"H".repeat(4_096)}${"M".repeat(8_000)}${"T".repeat(1_024)}`;
		const pruned = pruneContent([{ type: "text", text }], DEFAULT_CONFIG.prune);
		expect(pruned).not.toBeNull();
		const combined = pruned?.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
		expect(combined.startsWith("H".repeat(4_096))).toBe(true);
		expect(combined.endsWith("T".repeat(1_024))).toBe(true);
		expect(combined).toContain(PRUNE_MARKER);
		expect(measureContent(pruned ?? [])).toBeLessThanOrEqual(DEFAULT_CONFIG.prune.thresholdChars);
		expect(pruneContent(pruned ?? [], DEFAULT_CONFIG.prune)).toBeNull();
	});

	it("does not split surrogate pairs", () => {
		const emoji = "\uD83D\uDE00";
		const text = `${"a".repeat(4_096)}${emoji.repeat(4_000)}${"b".repeat(1_024)}`;
		const pruned = pruneContent([{ type: "text", text }], DEFAULT_CONFIG.prune);
		expect(pruned).not.toBeNull();
		const combined = pruned?.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
		expect(codePointLength(combined)).toBe(measureContent(pruned ?? []));
	});

	it("only prunes oversized results after pressure, then remembers them", () => {
		const text = `${"x".repeat(10_000)}`;
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text" as const, text }],
				isError: false,
				timestamp: 1,
			},
		];
		const idle = applyPruneToMessages(messages, DEFAULT_CONFIG.prune, new Set(), false);
		expect(idle.newlyPrunedIds).toEqual([]);
		expect(idle.messages[0]).toMatchObject({ content: [{ type: "text", text }] });

		const pressure = applyPruneToMessages(messages, DEFAULT_CONFIG.prune, new Set(), true);
		expect(pressure.newlyPrunedIds).toEqual(["call-1"]);
		const remembered = applyPruneToMessages(messages, DEFAULT_CONFIG.prune, new Set(["call-1"]), false);
		expect(remembered.messages[0]?.role === "toolResult" && remembered.messages[0].content[0]?.type === "text").toBe(
			true,
		);
		if (remembered.messages[0]?.role === "toolResult" && remembered.messages[0].content[0]?.type === "text") {
			expect(remembered.messages[0].content[0].text).toContain(PRUNE_MARKER);
		}
	});
});
