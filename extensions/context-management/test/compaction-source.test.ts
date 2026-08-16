import type { TextContent } from "@earendil-works/pi-ai";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildNormalizedCompactorSource } from "../src/compaction/source.js";
import type { FinalizedToolPair } from "../src/evidence/references.js";

type AgentMessage = ContextEvent["messages"][number];

function pair(entryId: string, toolCallId: string): FinalizedToolPair {
	return {
		entryId,
		reference: `cm-evidence:v1:${entryId}`,
		branchIndex: 0,
		toolCallId,
		toolName: "read",
		input: { path: "a.ts" },
		content: [{ type: "text", text: "raw" }],
		isError: false,
		details: {},
		usage: undefined,
		addedToolNames: undefined,
		timestamp: 1,
		fingerprint: "fingerprint",
	};
}

describe("normalized compactor source", () => {
	it("drops thinking and only permits evidence references present in the covered source", () => {
		const included = pair("result-1", "call-1");
		const unrelated = pair("result-2", "call-2");
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private", thinkingSignature: "sig" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				],
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
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "raw" }],
				details: {},
				isError: false,
				timestamp: 2,
			},
		];
		const source = buildNormalizedCompactorSource({
			messages,
			evidencePairs: [included, unrelated],
			supportsImages: true,
		});
		const text = source.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).not.toContain("private");
		expect(source.allowedEvidenceReferences).toEqual(new Set([included.reference]));
		expect(source.allowedEvidenceReferences.has(unrelated.reference)).toBe(false);
	});

	it("retains only reachable evidence references carried by a previous checkpoint", () => {
		const included = pair("result-1", "call-1");
		const source = buildNormalizedCompactorSource({
			messages: [],
			previousCheckpoint: `keep ${included.reference} and cm-evidence:v1:missing`,
			evidencePairs: [included],
			supportsImages: false,
		});
		expect(source.allowedEvidenceReferences).toEqual(new Set([included.reference]));
	});

	it("allows a reachable replacement reference that is actually visible in a reduced stub", () => {
		const old = pair("result-1", "call-1");
		const replacement = pair("result-2", "call-2");
		const source = buildNormalizedCompactorSource({
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [
						{
							type: "text",
							text: `[context-management: evidence ${old.reference} superseded by ${replacement.reference}]`,
						},
					],
					isError: false,
					timestamp: 1,
				},
			],
			evidencePairs: [old, replacement],
			supportsImages: false,
		});
		expect(source.allowedEvidenceReferences).toEqual(new Set([old.reference, replacement.reference]));
	});

	it("keeps mixed user content in source order and fingerprints image bytes without serializing them as text", () => {
		const source = buildNormalizedCompactorSource({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "before" },
						{ type: "image", mimeType: "image/png", data: "BASE64-SECRET" },
						{ type: "text", text: "after" },
					],
					timestamp: 1,
				},
			],
			evidencePairs: [],
			supportsImages: true,
		});
		expect(source.content.map((block) => block.type)).toEqual(["text", "text", "image", "text"]);
		const visibleText = source.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(visibleText.indexOf("before")).toBeLessThan(visibleText.indexOf("image content"));
		expect(visibleText.indexOf("image content")).toBeLessThan(visibleText.indexOf("after"));
		expect(visibleText).not.toContain("BASE64-SECRET");
		expect(source.fingerprintInput).not.toContain("BASE64-SECRET");
	});
});
