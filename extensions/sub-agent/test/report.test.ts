import { describe, expect, it, vi } from "vitest";
import { createReportToolDefinition } from "../src/tools/report.js";

describe("child report tool", () => {
	it("delivers non-blank output and returns the parent message id", async () => {
		const onReport = vi.fn(async () => "msg-1");
		const tool = createReportToolDefinition(onReport);
		const result = await tool.execute("call-1", { output: "  done  " }, undefined, undefined, {
			sessionManager: { getSessionId: () => "child-1" },
		} as never);

		expect(onReport).toHaveBeenCalledWith("done");
		expect(result.content).toEqual([{ type: "text", text: "msg-1" }]);
	});

	it("rejects blank and oversized output", async () => {
		const onReport = vi.fn();
		const tool = createReportToolDefinition(onReport);
		await expect(tool.execute("call-1", { output: "   " }, undefined, undefined, {} as never)).rejects.toThrow(
			"non-empty",
		);
		await expect(
			tool.execute("call-1", { output: "x".repeat(256 * 1024 + 1) }, undefined, undefined, {} as never),
		).rejects.toThrow("exceeds");
	});
});
