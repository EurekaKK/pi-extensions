import { describe, expect, it } from "vitest";
import { sanitizeGoalError } from "../src/errors.js";

describe("sanitizeGoalError", () => {
	it("uses Error messages without stacks", () => {
		const error = new Error("provider unavailable");
		error.stack = "secret stack";
		expect(sanitizeGoalError(error)).toBe("provider unavailable");
	});

	it("redacts common credentials", () => {
		expect(sanitizeGoalError("Authorization: abc123 Bearer token.value api_key=secret-value")).toBe(
			"Authorization: [redacted] Bearer [redacted] api_key=[redacted]",
		);
	});

	it("bounds output and handles unknown values", () => {
		expect([...sanitizeGoalError("x".repeat(600))]).toHaveLength(500);
		expect(sanitizeGoalError({ reason: "private" })).toBe("Unknown goal error.");
	});
});
