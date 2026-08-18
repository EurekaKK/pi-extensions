import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { frameCheckpoint } from "../src/compaction/prompt.js";
import { validateCheckpointResponse } from "../src/compaction/validation.js";
import { CHECKPOINT_PREAMBLE, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG } from "../src/constants.js";

describe("checkpoint validation and framing", () => {
	it("accepts visible text, ignores thinking, and strips model-copied tags", () => {
		const response = fauxAssistantMessage([
			fauxThinking("private chain"),
			fauxText(`  ${SUMMARY_OPEN_TAG}\n# State\n\n**Done.**\n${SUMMARY_CLOSE_TAG}  `),
		]);
		expect(validateCheckpointResponse(response)).toEqual({
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
		const result = validateCheckpointResponse(response);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.reason).toMatch(reason);
	});

	it("frames a replacement checkpoint with the dsh preamble and tags", () => {
		const framed = frameCheckpoint("# State\n\n**Done.**");
		expect(framed.startsWith(CHECKPOINT_PREAMBLE)).toBe(true);
		expect(framed).toContain(`${SUMMARY_OPEN_TAG}\n# State\n\n**Done.**\n${SUMMARY_CLOSE_TAG}`);
	});
});
