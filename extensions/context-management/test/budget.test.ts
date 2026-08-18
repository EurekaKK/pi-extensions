import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
	correctedEstimate,
	deriveContextBudget,
	EstimatorCalibration,
	estimateFixedEnvelope,
	estimateProjection,
	estimateToolEnvelope,
} from "../src/runtime/budget.js";

describe("context budget", () => {
	it("scales dsh ratios against the routed context window", () => {
		expect(deriveContextBudget(128_000, DEFAULT_CONFIG)).toEqual({
			contextWindow: 128_000,
			thresholdTokens: 102_400,
			retainTokens: 20_480,
		});
		expect(deriveContextBudget(1_000_000, DEFAULT_CONFIG)).toEqual({
			contextWindow: 1_000_000,
			thresholdTokens: 800_000,
			retainTokens: 160_000,
		});
	});

	it("rejects windows that cannot separate retain from threshold", () => {
		expect(() => deriveContextBudget(0, DEFAULT_CONFIG)).toThrow(/positive integer/);
		expect(() => deriveContextBudget(128_000, { thresholdRatio: 0.1, retainRatio: 0.1 })).toThrow(/must be less than/);
	});

	it("estimates the complete fixed envelope including tool schemas", () => {
		const tool = {
			name: "context_management_fixture",
			description: "fixture tool",
			parameters: { type: "object" as const, properties: { value: { type: "string" as const } } },
			promptGuidelines: ["Use exact values."],
			sourceInfo: { path: "/fixture", source: "fixture", scope: "temporary", origin: "top-level" },
		} as ToolInfo;
		expect(estimateToolEnvelope([tool])).toBeGreaterThan(0);
		expect(estimateFixedEnvelope("system", [tool])).toBeGreaterThan(estimateFixedEnvelope("system", []));
		expect(
			estimateProjection([{ role: "user", content: [{ type: "text", text: "visible" }], timestamp: 1 }]),
		).toBeGreaterThan(2);
	});
});

describe("estimator calibration", () => {
	it("only corrects upward and retains the newest eight samples", () => {
		const calibration = new EstimatorCalibration();
		expect(calibration.get("p", "m")).toBe(1);
		calibration.record("p", "m", 100, 1_000);
		for (let sample = 0; sample < 8; sample += 1) calibration.record("p", "m", 100, 200);
		expect(calibration.get("p", "m")).toBe(2);
		expect(correctedEstimate(101, calibration.get("p", "m"))).toBe(202);
		calibration.clear();
		expect(calibration.get("p", "m")).toBe(1);
	});
});
