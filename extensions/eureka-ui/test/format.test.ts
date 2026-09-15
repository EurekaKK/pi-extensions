import { describe, expect, it } from "vitest";
import {
	clip,
	countNonEmptyLines,
	extractExitCode,
	failureDetail,
	formatActivityFailed,
	formatActivityRan,
	formatActivityRunning,
	formatCallLine,
	formatEditStats,
	formatResultSummary,
	formatToolFocus,
	type ToolResultLike,
} from "../src/format.js";

function textResult(text: string): ToolResultLike {
	return { content: [{ type: "text", text }] };
}

describe("eureka-ui formatting", () => {
	it("clips long focus text to one line", () => {
		const long = "x".repeat(120);
		expect(clip(long).length).toBeLessThanOrEqual(60);
		expect(clip("a  b\nc")).toBe("a b c");
	});

	it("formats call lines per tool", () => {
		expect(formatCallLine("bash", { command: "npm test" })).toBe("$ npm test");
		expect(formatCallLine("read", { path: "src/index.ts", offset: 1, limit: 200 })).toBe("read src/index.ts:1-200");
		expect(formatCallLine("grep", { pattern: "needle" })).toBe("grep /needle/");
		expect(formatCallLine("edit", { path: "src/index.ts" })).toBe("edit src/index.ts");
		expect(formatCallLine("ls", {})).toBe("ls …");
	});

	it("formats tool focus for the activity line", () => {
		expect(formatToolFocus("bash", { command: "npm test" })).toBe("npm test");
		expect(formatToolFocus("read", { path: "src/index.ts" })).toBe("src/index.ts");
		expect(formatToolFocus("todo_write", { items: [] })).toBe("");
	});

	it("summarizes results with counts and duration", () => {
		expect(formatResultSummary("bash", {}, textResult("a\nb\n"), false, 1234)).toBe("✓ 2 lines · 1.2s");
		expect(formatResultSummary("read", {}, textResult("a\nb\nc"), false, undefined)).toBe("✓ 3 lines");
		expect(formatResultSummary("grep", {}, textResult("a:1\nb:2"), false, undefined)).toBe("✓ 2 matches");
		expect(formatResultSummary("find", {}, textResult("a\nb\nc"), false, undefined)).toBe("✓ 3 files");
		expect(formatResultSummary("ls", {}, textResult("a"), false, undefined)).toBe("✓ 1 entry");
		expect(formatResultSummary("write", { content: "a\nb" }, textResult(""), false, undefined)).toBe("✓ 2 lines");
	});

	it("summarizes edits from the diff", () => {
		expect(formatEditStats({ diff: "@@\n+one\n-two\n-core\n" })).toBe("+1 -2");
		expect(formatResultSummary("edit", {}, { details: { diff: "+one\n-two" } }, false, undefined)).toBe("✓ +1 -1");
		expect(formatResultSummary("edit", {}, { details: {} }, false, undefined)).toBe("✓ edited");
	});

	it("reports failures with the exit code Pi provides", () => {
		const result = textResult("boom\n\nCommand exited with code 2");
		expect(extractExitCode("Command exited with code 2")).toBe(2);
		expect(formatResultSummary("bash", {}, result, true, undefined)).toBe("✗ exit 2");
		expect(failureDetail(result)).toBe("exit 2");
	});

	it("falls back to the first output line for failures without an exit code", () => {
		const result = textResult("Error: file is missing\nmore");
		expect(failureDetail(result)).toBe("Error: file is missing");
		expect(formatResultSummary("read", { path: "x" }, result, true, undefined)).toBe("✗ Error: file is missing");
	});

	it("counts non-empty lines", () => {
		expect(countNonEmptyLines("")).toBe(0);
		expect(countNonEmptyLines("a\n\n  \nb")).toBe(2);
	});

	it("describes running, finished and failed activity", () => {
		expect(
			formatActivityRunning([
				{ toolName: "bash", args: { command: "npm test" } },
				{ toolName: "read", args: { path: "src/auth.ts" } },
			]),
		).toBe("Running npm test, src/auth.ts…");
		expect(
			formatActivityRunning([
				{ toolName: "bash", args: { command: "npm test" } },
				{ toolName: "read", args: { path: "src/auth.ts" } },
				{ toolName: "grep", args: { pattern: "token" } },
			]),
		).toBe("Running npm test, src/auth.ts… (+1)");
		expect(formatActivityRan({ toolName: "bash", args: { command: "npm test" } }, 300)).toBe("Ran npm test · 0.3s");
		expect(formatActivityFailed({ toolName: "bash", args: { command: "npm test" } }, "exit 1")).toBe(
			"Failed npm test · exit 1",
		);
		expect(formatActivityFailed({ toolName: "bash", args: { command: "npm test" } }, undefined)).toBe(
			"Failed npm test",
		);
	});
});
