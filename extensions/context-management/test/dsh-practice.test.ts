import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { CHECKPOINT_PREAMBLE, COMPACTION_INSTRUCTION, PRUNE_MARKER, SPILL_RETRIEVAL_HINT } from "../src/constants.js";
import { ContextHarness, structuredCheckpointText } from "./harness.js";

const DSH_SECTIONS = [
	"## Primary Request and Intent",
	"## Key Technical Concepts",
	"## Files and Code",
	"## Errors and Fixes",
	"## Pending Jobs",
	"## Current Work",
	"## Next Step",
	"## Critical Context",
] as const;

describe("dsh practice in the Pi host", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "cm-dsh-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("ships dsh default ratios, prune cuts, spill cap, and retrieval wording", () => {
		expect(DEFAULT_CONFIG).toMatchObject({
			auto: true,
			thresholdRatio: 0.8,
			retainRatio: 0.16,
			maxTokens: 8_192,
			compactionRetries: 1,
			prune: { thresholdChars: 8_192, headChars: 4_096, tailChars: 1_024 },
			spill: { maxInlineBytes: 50_000 },
		});
		expect(PRUNE_MARKER).toBe("\n\n[... tool result middle pruned ...]\n\n");
		expect(SPILL_RETRIEVAL_HINT).toBe("Use read with offset/limit, or grep this path to search within it.");
		expect(CHECKPOINT_PREAMBLE).toBe(
			"This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.",
		);
		let cursor = -1;
		for (const section of DSH_SECTIONS) {
			const index = COMPACTION_INSTRUCTION.indexOf(section);
			expect(index).toBeGreaterThan(cursor);
			cursor = index;
		}
	});

	it("maps native compact reasons like dsh retainTokens 0 vs retainRatio on the same history", async () => {
		const manual = new ContextHarness(128_000, agentDir);
		const overflow = new ContextHarness(128_000, agentDir);
		const threshold = new ContextHarness(128_000, agentDir);
		const manualKept = seedCompactableBelowPressure(manual);
		const overflowKept = seedCompactableBelowPressure(overflow);
		const thresholdFirst = seedCompactableBelowPressure(threshold).first;

		const [manualResult, overflowResult, thresholdResult] = await Promise.all([
			manual.beforeCompact("manual", manualKept.first),
			overflow.beforeCompact("overflow", overflowKept.first),
			threshold.beforeCompact("threshold", thresholdFirst),
		]);

		expect(manualResult.cancel).toBeUndefined();
		expect(manualResult.compaction?.firstKeptEntryId).toBe(manualKept.kept);
		expect(overflowResult.cancel).toBeUndefined();
		expect(overflowResult.compaction?.firstKeptEntryId).toBe(overflowKept.kept);
		expect(thresholdResult).toEqual({ cancel: true });
		expect(threshold.faux.state.callCount).toBe(0);
	});

	it("still compactes with auto disabled, the same way dsh compactNow ignores auto:false", async () => {
		const harness = new ContextHarness(128_000, agentDir, { auto: false });
		const { first, kept } = seedCompactableBelowPressure(harness);
		const result = await harness.beforeCompact("manual", first);
		expect(result.cancel).toBeUndefined();
		expect(result.compaction?.firstKeptEntryId).toBe(kept);
	});

	it("ignores Pi focus text and keepRecentTokens when fulfilling /compact", async () => {
		const harness = new ContextHarness(128_000, agentDir);
		const { first, kept } = seedCompactableBelowPressure(harness);
		const result = await harness.beforeCompact("manual", first, {
			customInstructions: "FOCUS ON SECRETS ONLY — discard everything else",
		});
		expect(result.compaction?.firstKeptEntryId).toBe(kept);
		expect(result.compaction?.summary).toContain("<compacted-summary>");
		expect(result.compaction?.summary).toContain("Primary Request and Intent");
		expect(result.compaction?.summary).not.toContain("SECRETS");
		expect(result.compaction?.summary.startsWith(CHECKPOINT_PREAMBLE)).toBe(true);
	});

	it("preserves the newest whole tool pair during overflow and omits it from the summarizer prefix", async () => {
		const { harness, payload } = capturingHarness(agentDir);
		const first = harness.addUser(`older:${"x".repeat(8_000)}`);
		harness.addToolResult("call-old", "old-result");
		const kept = harness.addUser("kept");
		harness.addToolResult("call-kept", "kept-result");
		const result = await harness.beforeCompact("overflow", first);
		expect(result.compaction?.firstKeptEntryId).toBe(kept);
		expect(payload()).toContain("old-result");
		expect(payload()).not.toContain("kept-result");
	});

	it("declines overflow and manual compact when the surface is one tool pair", async () => {
		const overflow = new ContextHarness(128_000, agentDir);
		overflow.addUser("only");
		overflow.addToolResult("call-only", "result");
		expect(await overflow.beforeCompact("overflow", "entry-1")).toEqual({ cancel: true });

		const manual = new ContextHarness(128_000, agentDir);
		manual.addUser("only");
		manual.addToolResult("call-only", "result");
		expect(await manual.beforeCompact("manual", "entry-1")).toEqual({ cancel: true });
	});

	it("prunes oversized tool results on the native compact path before summarization", async () => {
		const { harness, payload } = capturingHarness(agentDir);
		const first = harness.addUser("old");
		harness.addToolResult("call-old", "x".repeat(20_000));
		harness.addUser("kept");
		const result = await harness.beforeCompact("manual", first);
		expect(result.cancel).toBeUndefined();
		expect(payload()).toContain("tool result middle pruned");
		expect(payload()).not.toContain("x".repeat(5_000));
	});

	it("does not summarize below the dsh pressure threshold even when a compactable prefix exists", async () => {
		const harness = new ContextHarness(10_000, agentDir);
		harness.faux.setResponses([]);
		for (let index = 0; index < 4; index += 1) harness.addUser(`turn-${index}:${"x".repeat(4_000)}`);
		const result = await harness.project();
		expect(result.messages).toHaveLength(4);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.notify).not.toHaveBeenCalled();
	});
});

function seedCompactableBelowPressure(harness: ContextHarness): { readonly first: string; readonly kept: string } {
	const first = harness.addUser(`history:${"x".repeat(8_000)}`);
	harness.addUser("middle");
	const kept = harness.addUser("kept");
	return { first, kept };
}

function capturingHarness(agentDir: string): { readonly harness: ContextHarness; readonly payload: () => string } {
	const harness = new ContextHarness(128_000, agentDir);
	let payload = "";
	harness.faux.setResponses([
		(request) => {
			payload = JSON.stringify(request.messages);
			return fauxAssistantMessage(structuredCheckpointText());
		},
	]);
	return { harness, payload: () => payload };
}
