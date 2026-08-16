import { describe, expect, it } from "vitest";
import { estimateCompactorPromptOverhead } from "../src/compaction/prompt.js";
import {
	correctedEstimate,
	deriveCompactionThresholds,
	deriveContextBudget,
	EstimatorCalibration,
	estimateFixedEnvelope,
	estimateProjection,
	estimateToolEnvelope,
	evidenceNetSavingsGate,
} from "../src/runtime/budget.js";

describe("context budget", () => {
	it("measures compactor fixed prompt and wrapper overhead deterministically", () => {
		const first = estimateCompactorPromptOverhead();
		expect(first).toBeGreaterThan(0);
		expect(estimateCompactorPromptOverhead()).toBe(first);
	});

	it("derives the fixed 200k reference values", () => {
		const budget = deriveContextBudget(200_000);
		expect(budget.safeInput).toBe(180_000);
		expect(budget.protectedTailTarget).toBe(20_000);
		expect(budget.estimationMargin).toBe(1_024);
		expect(deriveCompactionThresholds(budget, 0)).toEqual({ blocking: 158_976, preparation: 126_208 });
	});

	it("derives the fixed 1m reference values", () => {
		const budget = deriveContextBudget(1_000_000);
		expect(budget.safeInput).toBe(980_000);
		expect(budget.protectedTailTarget).toBe(64_000);
		expect(budget.estimationMargin).toBe(4_096);
		expect(deriveCompactionThresholds(budget, 0)).toEqual({ blocking: 911_904, preparation: 811_904 });
	});

	it("rejects windows with no generation headroom", () => {
		expect(() => deriveContextBudget(20_000)).toThrow(/greater than 20000/);
	});

	it("clamps protected-tail and estimation margins at both bounds", () => {
		expect(deriveContextBudget(20_001)).toMatchObject({ protectedTailTarget: 20_000, estimationMargin: 1_024 });
		expect(deriveContextBudget(10_000_000)).toMatchObject({ protectedTailTarget: 64_000, estimationMargin: 4_096 });
	});

	it("subtracts measured prompt overhead dynamically from both thresholds", () => {
		const budget = deriveContextBudget(200_000);
		const base = deriveCompactionThresholds(budget, 0);
		const measured = deriveCompactionThresholds(budget, 321);
		expect(measured.blocking).toBe(base.blocking - 321);
		expect(measured.preparation).toBe(base.preparation - 321);
	});

	it("estimates the complete fixed envelope including tool schemas", () => {
		const tool = {
			name: "context_management_fixture",
			description: "fixture tool",
			parameters: { type: "object" as const, properties: { value: { type: "string" as const } } },
			promptGuidelines: ["Use exact values."],
			sourceInfo: { path: "/fixture", source: "fixture", scope: "temporary" as const, origin: "top-level" as const },
		};
		expect(estimateToolEnvelope([tool])).toBeGreaterThan(0);
		expect(estimateFixedEnvelope("system", [tool])).toBeGreaterThan(estimateFixedEnvelope("system", []));
		expect(estimateProjection([{ role: "user", content: [{ type: "text", text: "visible" }], timestamp: 1 }])).toBe(8);
	});

	it("includes Pi's provider-visible compaction summary wrapper", () => {
		const providerText =
			"The conversation history before this point was compacted into the following summary:\n\n<summary>\nstate\n</summary>";
		expect(estimateProjection([{ role: "compactionSummary", summary: "state", tokensBefore: 10, timestamp: 1 }])).toBe(
			Math.ceil(providerText.length / 4) + 6,
		);
	});

	it("uses the low deterministic reduction gate", () => {
		expect(evidenceNetSavingsGate(20_000)).toBe(2_048);
		expect(evidenceNetSavingsGate(100_000)).toBe(5_000);
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

	it("ignores invalid usage samples", () => {
		const calibration = new EstimatorCalibration();
		expect(calibration.record("p", "m", 0, 10)).toBe(false);
		expect(calibration.record("p", "m", 10, 0)).toBe(false);
	});
});
