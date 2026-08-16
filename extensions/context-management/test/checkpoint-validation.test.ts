import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { validateCheckpointResponse } from "../src/compaction/validation.js";

describe("checkpoint mechanical validation", () => {
	it("accepts free CommonMark, ignores thinking, and trims only the visible boundary", () => {
		const response = fauxAssistantMessage([fauxThinking("private chain"), fauxText("  # State\n\n**Done.**  ")]);
		expect(validateCheckpointResponse(response, 100, new Set())).toEqual({
			ok: true,
			text: "# State\n\n**Done.**",
		});
	});

	it.each([
		["empty", fauxAssistantMessage("   "), /no visible checkpoint text/],
		["length stop", fauxAssistantMessage("partial", { stopReason: "length" }), /length limit/],
		[
			"tool use",
			fauxAssistantMessage([fauxText("partial"), fauxToolCall("read", {})], { stopReason: "stop" }),
			/unexpected tool call/,
		],
	] as const)("rejects %s output", (_label, response, reason) => {
		const result = validateCheckpointResponse(response, 100, new Set());
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.reason).toMatch(reason);
	});

	it("rejects output one token over the hard limit", () => {
		const result = validateCheckpointResponse(fauxAssistantMessage("x".repeat(17)), 4, new Set());
		expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/exceeds hard limit/) });
	});

	it("rejects forged references and accepts a reachable canonical reference", () => {
		const reference = "cm-evidence:v1:result-entry";
		const response = fauxAssistantMessage(`Verified by ${reference}`);
		expect(validateCheckpointResponse(response, 100, new Set())).toMatchObject({
			ok: false,
			reason: expect.stringContaining(reference),
		});
		expect(validateCheckpointResponse(response, 100, new Set([reference]))).toEqual({
			ok: true,
			text: `Verified by ${reference}`,
		});
	});
});
