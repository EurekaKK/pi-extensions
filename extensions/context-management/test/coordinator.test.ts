import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { PRUNE_MARKER, STATUS_COMMAND } from "../src/constants.js";
import { ContextHarness, structuredCheckpointText, userMessage } from "./harness.js";

const CANDIDATE_OBSERVER_SYMBOL = Symbol.for("pi.context-management.candidate-lifecycle.v1");

describe("context coordinator", () => {
	let agentDir: string;
	let harness: ContextHarness;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "cm-coord-"));
	});

	afterEach(async () => {
		Reflect.deleteProperty(globalThis, CANDIDATE_OBSERVER_SYMBOL);
		await rm(agentDir, { recursive: true, force: true });
	});

	it("registers no LLM tools and a status command", async () => {
		harness = new ContextHarness(128_000, agentDir);
		expect(harness.registeredTools).toEqual([]);
		expect(harness.registeredCommands.map((command) => command.name)).toEqual([STATUS_COMMAND]);
	});

	it("clones messages when no model is selected", async () => {
		harness = new ContextHarness(128_000, agentDir);
		(harness.context as { model: unknown }).model = undefined;
		harness.addUser("hello");
		const result = await harness.project();
		expect(result.messages).toEqual(harness.messages());
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("prunes oversized tool results under pressure and skips summarization", async () => {
		harness = new ContextHarness(6_000, agentDir);
		harness.faux.setResponses([]);
		harness.addUser("old");
		harness.addToolResult("call-1", "x".repeat(20_000));
		harness.addUser("new");
		const result = await harness.project();
		const tool = result.messages.find((message) => message.role === "toolResult");
		expect(
			tool?.role === "toolResult" && tool.content[0]?.type === "text" && tool.content[0].text.includes(PRUNE_MARKER),
		).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("warns and continues the turn when pressure summarization fails", async () => {
		harness = new ContextHarness(8_000, agentDir);
		harness.faux.setResponses([]);
		for (let index = 0; index < 12; index += 1) harness.addUser(`turn-${index}:${"x".repeat(3_000)}`);
		const result = await harness.project();
		expect(result.messages.length).toBeGreaterThan(0);
		expect(String(harness.notify.mock.calls[0]?.[0])).toMatch(/Step compaction failed/);
		expect(harness.notify.mock.calls[0]?.[1]).toBe("warning");
	});

	it("prepares one settled prefix and installs it at pressure without a second compactor call", async () => {
		const candidatePhases: string[] = [];
		Reflect.set(globalThis, CANDIDATE_OBSERVER_SYMBOL, (event: { phase: string }) => {
			candidatePhases.push(event.phase);
		});
		harness = new ContextHarness(50_000, agentDir);
		for (let index = 0; index < 9; index += 1) {
			harness.addUser(`history-${index}:${"x".repeat(15_000)}`);
			harness.addAssistant(`ack-${index}`);
		}
		const belowPressure = await harness.project();
		expect(belowPressure.messages[0]?.role).not.toBe("compactionSummary");
		expect(harness.state.metrics?.finalEstimate).toBeGreaterThanOrEqual(
			(harness.state.metrics?.thresholdTokens ?? 0) - (harness.state.metrics?.retainTokens ?? 0),
		);
		expect(harness.state.metrics?.overThreshold).toBe(false);
		expect(harness.state.metrics?.compactableEstimate).toBeGreaterThan(0);

		await harness.settle();
		await vi.waitFor(() => expect(["ready", "failed"]).toContain(harness.state.candidateLifecycle.phase));
		expect(harness.state.candidateLifecycle).toEqual({ phase: "ready", detail: null });
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));

		for (let index = 0; index < 3; index += 1) harness.addUser(`later-${index}:${"y".repeat(15_000)}`);
		const atPressure = await harness.project();
		expect(atPressure.messages[0]?.role).toBe("compactionSummary");
		expect(harness.faux.state.callCount).toBe(1);
		expect(candidatePhases).toEqual(["started", "ready", "installed"]);
	});

	it("discards a ready candidate when the session tree changes", async () => {
		const candidatePhases: string[] = [];
		Reflect.set(globalThis, CANDIDATE_OBSERVER_SYMBOL, (event: { phase: string }) => {
			candidatePhases.push(event.phase);
		});
		harness = new ContextHarness(50_000, agentDir);
		for (let index = 0; index < 9; index += 1) {
			harness.addUser(`history-${index}:${"x".repeat(15_000)}`);
			harness.addAssistant(`ack-${index}`);
		}
		await harness.project();
		await harness.settle();
		await vi.waitFor(() => expect(harness.state.candidateLifecycle.phase).toBe("ready"));

		await harness.tree();

		expect(harness.state.preparedCheckpoint).toBeUndefined();
		expect(harness.state.candidateLifecycle).toEqual({
			phase: "discarded",
			detail: "session tree changed",
		});
		expect(candidatePhases).toEqual(["started", "ready", "discarded"]);
	});

	it("starts the next preparation cycle after checkpoint commit when new history qualifies", async () => {
		harness = new ContextHarness(100_000, agentDir);
		for (let index = 0; index < 9; index += 1) {
			harness.addUser(`first-${index}:${"x".repeat(30_000)}`);
			harness.addAssistant(`first-ack-${index}`);
		}
		await harness.project();
		await harness.settle();
		await vi.waitFor(() => expect(harness.state.candidateLifecycle.phase).toBe("ready"));
		for (let index = 0; index < 3; index += 1) harness.addUser(`pressure-${index}:${"y".repeat(30_000)}`);
		await harness.project();
		expect(harness.faux.state.callCount).toBe(1);
		let secondRequest = "";

		for (let index = 0; index < 9; index += 1) {
			harness.addUser(`second-${index}:${"z".repeat(30_000)}`);
			harness.addAssistant(`second-ack-${index}`);
		}
		harness.faux.setResponses([
			(request) => {
				secondRequest = JSON.stringify(request.messages);
				return fauxAssistantMessage(structuredCheckpointText());
			},
		]);
		await harness.commitPending();

		expect(harness.state.metrics?.finalEstimate).toBeGreaterThanOrEqual(
			(harness.state.metrics?.thresholdTokens ?? 0) - (harness.state.metrics?.retainTokens ?? 0),
		);
		expect(harness.state.metrics?.compactableEstimate).toBeGreaterThan(0);
		await vi.waitFor(() => expect(["ready", "failed"]).toContain(harness.state.candidateLifecycle.phase));
		expect(harness.state.candidateLifecycle).toEqual({ phase: "ready", detail: null });
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(2));
		await vi.waitFor(() => expect(harness.state.candidateLifecycle.phase).toBe("ready"));
		expect(secondRequest).toContain("## Primary Request and Intent");
	});

	it("aborts an in-flight preparation before native synchronous compaction", async () => {
		harness = new ContextHarness(50_000, agentDir);
		for (let index = 0; index < 9; index += 1) {
			harness.addUser(`history-${index}:${"x".repeat(15_000)}`);
			harness.addAssistant(`ack-${index}`);
		}
		await harness.project();
		let backgroundAborted = false;
		harness.faux.setResponses([
			(_request, options) =>
				new Promise<never>((_resolve, reject) => {
					const signal = options?.signal;
					if (signal === undefined) return reject(new Error("missing signal"));
					signal.addEventListener(
						"abort",
						() => {
							backgroundAborted = true;
							reject(new Error("background aborted"));
						},
						{ once: true },
					);
				}),
			() => fauxAssistantMessage(structuredCheckpointText()),
		]);
		await harness.settle();
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		expect(harness.state.candidateLifecycle.phase).toBe("preparing");

		const result = await harness.beforeCompact("manual", "ignored-by-extension");

		expect(result.compaction).toBeDefined();
		expect(backgroundAborted).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.state.preparedCheckpoint).toBeUndefined();
		expect(harness.state.candidateLifecycle.phase).toBe("discarded");
	});

	it("uses the current event projection when context compilation fails", async () => {
		harness = new ContextHarness(50_000, agentDir);
		harness.addUser("historical-input");
		await harness.project();
		Object.defineProperty(harness.context.sessionManager, "buildContextEntries", {
			value: () => {
				throw new Error("session context unavailable");
			},
		});

		const result = await harness.project([userMessage("current-input")]);

		expect(JSON.stringify(result.messages)).toContain("current-input");
		expect(JSON.stringify(result.messages)).not.toContain("historical-input");
	});

	it("cancels native compaction when overflow summarization fails", async () => {
		harness = new ContextHarness(128_000, agentDir);
		harness.faux.setResponses([]);
		harness.addUser("older");
		harness.addUser("kept");
		const result = await harness.beforeCompact("overflow", "entry-1");
		expect(result).toEqual({ cancel: true });
		expect(String(harness.notify.mock.calls[0]?.[0])).toMatch(/Compaction cancelled/);
	});

	it("returns a framed checkpoint for manual /compact and keeps only the last unit", async () => {
		harness = new ContextHarness(128_000, agentDir);
		const first = harness.addUser(`history:${"x".repeat(8_000)}`);
		harness.addUser("middle");
		const kept = harness.addUser("kept");
		const result = await harness.beforeCompact("manual", first);
		expect(result.cancel).toBeUndefined();
		expect(result.compaction?.firstKeptEntryId).toBe(kept);
		expect(result.compaction?.summary).toContain("<compacted-summary>");
		expect(result.compaction?.summary).toContain("Primary Request and Intent");
	});

	it("overflow compaction also keeps only the last unit", async () => {
		harness = new ContextHarness(128_000, agentDir);
		const first = harness.addUser(`older:${"x".repeat(8_000)}`);
		const kept = harness.addUser("kept");
		const result = await harness.beforeCompact("overflow", first);
		expect(result.cancel).toBeUndefined();
		expect(result.compaction?.firstKeptEntryId).toBe(kept);
	});

	it("cancels threshold compaction when the retainRatio tail already covers the session", async () => {
		harness = new ContextHarness(128_000, agentDir);
		const first = harness.addUser("a");
		harness.addUser("b");
		harness.addUser("c");
		const result = await harness.beforeCompact("threshold", first);
		expect(result).toEqual({ cancel: true });
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("cancels manual compact when only the last unit exists", async () => {
		harness = new ContextHarness(128_000, agentDir);
		const only = harness.addUser("only");
		const result = await harness.beforeCompact("manual", only);
		expect(result).toEqual({ cancel: true });
	});

	it("cancels non-manual compaction when auto is disabled", async () => {
		harness = new ContextHarness(128_000, agentDir, { auto: false });
		harness.addUser("older");
		const kept = harness.addUser("kept");
		const result = await harness.beforeCompact("threshold", kept);
		expect(result).toEqual({ cancel: true });
	});

	it("spills oversized bash results and leaves read results inline", async () => {
		harness = new ContextHarness(128_000, agentDir);
		const oversized = "z".repeat(DEFAULT_CONFIG.spill.maxInlineBytes + 50);
		const bash = await harness.toolResult({
			type: "tool_result",
			toolCallId: "c-bash",
			toolName: "bash",
			input: { command: "echo" },
			content: [{ type: "text", text: oversized }],
			isError: false,
			details: undefined,
		});
		const read = await harness.toolResult({
			type: "tool_result",
			toolCallId: "c-read",
			toolName: "read",
			input: { path: "a.ts" },
			content: [{ type: "text", text: oversized }],
			isError: false,
			details: undefined,
		});
		expect(bash).toMatchObject({ content: [{ type: "text" }] });
		expect(read).toBeUndefined();
	});
});
