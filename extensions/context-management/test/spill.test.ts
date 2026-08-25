import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SPILL_RETRIEVAL_HINT } from "../src/constants.js";
import { maybeSpillToolResult, spillRoot } from "../src/spill.js";

describe("tool-result spill", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "cm-spill-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("skips the read tool to avoid a read-spill-read loop", async () => {
		const text = "x".repeat(DEFAULT_CONFIG.spill.maxInlineBytes + 10);
		const result = await maybeSpillToolResult({
			event: {
				type: "tool_result",
				toolCallId: "c1",
				toolName: "read",
				input: { path: "a.ts" },
				content: [{ type: "text", text }],
				isError: false,
				details: undefined,
			},
			sessionId: "session",
			agentDir,
			maxInlineBytes: DEFAULT_CONFIG.spill.maxInlineBytes,
			withFileMutationQueue,
		});
		expect(result).toBeUndefined();
	});

	it("writes oversized plain text and returns a preview with a retrieval path", async () => {
		const text = "y".repeat(DEFAULT_CONFIG.spill.maxInlineBytes + 200);
		const result = await maybeSpillToolResult({
			event: {
				type: "tool_result",
				toolCallId: "c2",
				toolName: "bash",
				input: { command: "echo" },
				content: [{ type: "text", text }],
				isError: false,
				details: undefined,
			},
			sessionId: "session-a",
			agentDir,
			maxInlineBytes: DEFAULT_CONFIG.spill.maxInlineBytes,
			withFileMutationQueue,
		});
		expect(result?.content?.[0]?.type).toBe("text");
		const replaced = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
		expect(replaced).toContain(SPILL_RETRIEVAL_HINT);
		expect(replaced).toContain(spillRoot(agentDir));
		const locator = replaced.match(/stored at: (.+)\. Use read/)?.[1];
		expect(locator).toBeDefined();
		if (locator === undefined) throw new Error("Expected a spill locator.");
		expect(await readFile(locator, "utf8")).toBe(text);
		expect(Buffer.byteLength(replaced, "utf8")).toBeLessThanOrEqual(DEFAULT_CONFIG.spill.maxInlineBytes);
	});

	it("bounds a 70,000-byte result when omission counts keep the same digit width", async () => {
		const text = "z".repeat(70_000);
		const result = await maybeSpillToolResult({
			event: {
				type: "tool_result",
				toolCallId: "c-large",
				toolName: "context_burst",
				input: {},
				content: [{ type: "text", text }],
				isError: false,
				details: undefined,
			},
			sessionId: "session-large",
			agentDir,
			maxInlineBytes: DEFAULT_CONFIG.spill.maxInlineBytes,
			withFileMutationQueue,
		});

		expect(result?.content[0]?.type).toBe("text");
		const replaced = result?.content[0]?.type === "text" ? result.content[0].text : "";
		expect(replaced).not.toBe(text);
		expect(Buffer.byteLength(replaced, "utf8")).toBeLessThanOrEqual(DEFAULT_CONFIG.spill.maxInlineBytes);
	});

	it("leaves mixed image results inline", async () => {
		const result = await maybeSpillToolResult({
			event: {
				type: "tool_result",
				toolCallId: "c3",
				toolName: "bash",
				input: { command: "echo" },
				content: [
					{ type: "text", text: "x".repeat(DEFAULT_CONFIG.spill.maxInlineBytes + 10) },
					{ type: "image", mimeType: "image/png", data: "aaaa" },
				],
				isError: false,
				details: undefined,
			},
			sessionId: "session",
			agentDir,
			maxInlineBytes: DEFAULT_CONFIG.spill.maxInlineBytes,
			withFileMutationQueue,
		});
		expect(result).toBeUndefined();
	});
});
