import { describe, expect, it } from "vitest";
import { PLAN_CHANGE_ENTRY_TYPE } from "../src/constants.js";
import type { PlanProposalV1 } from "../src/domain.js";
import { foldPlanChanges, normalizeProposalInput, parsePlanChange, parsePlanCommandArgs } from "../src/domain.js";

function change(data: Record<string, unknown>): { type: string; customType: string; data: unknown } {
	return { type: "custom", customType: PLAN_CHANGE_ENTRY_TYPE, data };
}

function proposal(planId: string, revision: number): PlanProposalV1 {
	return {
		planId,
		revision,
		objective: "objective",
		overview: "overview",
		steps: [{ stepId: "step-1", title: "title", details: "details" }],
	};
}

describe("plan domain parse", () => {
	it("parses every change operation strictly", () => {
		expect(
			parsePlanChange({
				kind: "plan/change",
				version: 1,
				operation: "start",
				planId: "p",
				objective: "o",
				startedAt: 1,
			}),
		).toMatchObject({ status: "valid" });
		expect(
			parsePlanChange({
				kind: "plan/change",
				version: 1,
				operation: "submit",
				proposal: proposal("p", 1),
				submittedAt: 2,
			}),
		).toMatchObject({ status: "valid" });
		expect(
			parsePlanChange({
				kind: "plan/change",
				version: 1,
				operation: "revise-request",
				planId: "p",
				sourceRevision: 1,
				requestedAt: 3,
			}),
		).toMatchObject({ status: "valid" });
		expect(
			parsePlanChange({
				kind: "plan/change",
				version: 1,
				operation: "revise-request",
				planId: "p",
				sourceRevision: 1,
				objective: "keep the goal",
				requestedAt: 3,
			}),
		).toMatchObject({ status: "valid", change: { objective: "keep the goal" } });
		expect(
			parsePlanChange({
				kind: "plan/change",
				version: 1,
				operation: "revise-request",
				planId: "p",
				sourceRevision: 1,
				objective: "",
				requestedAt: 3,
			}).status,
		).toBe("invalid");
		expect(
			parsePlanChange({
				kind: "plan/change",
				version: 1,
				operation: "approve",
				planId: "p",
				revision: 1,
				handoffId: "h",
				approvedAt: 4,
			}),
		).toMatchObject({ status: "valid" });
		expect(
			parsePlanChange({
				kind: "plan/change",
				version: 1,
				operation: "handoff-complete",
				planId: "p",
				revision: 1,
				handoffId: "h",
				completedAt: 5,
			}),
		).toMatchObject({ status: "valid" });
		expect(
			parsePlanChange({ kind: "plan/change", version: 1, operation: "cancel", planId: "p", cancelledAt: 6 }),
		).toMatchObject({ status: "valid" });
		expect(
			parsePlanChange({ kind: "plan/change", version: 1, operation: "start", planId: "", objective: "o", startedAt: 1 })
				.status,
		).toBe("invalid");
		expect(parsePlanChange({ kind: "other", version: 1 }).status).toBe("ignored");
		expect(parsePlanChange({ kind: "plan/change", version: 2, operation: "start" }).status).toBe("ignored");
	});

	it("folds the full state machine", () => {
		const entries = [
			change({ kind: "plan/change", version: 1, operation: "start", planId: "p1", objective: "goal", startedAt: 1 }),
			change({ kind: "plan/change", version: 1, operation: "submit", proposal: proposal("p1", 1), submittedAt: 2 }),
			change({
				kind: "plan/change",
				version: 1,
				operation: "approve",
				planId: "p1",
				revision: 1,
				handoffId: "h1",
				approvedAt: 3,
			}),
			change({
				kind: "plan/change",
				version: 1,
				operation: "handoff-complete",
				planId: "p1",
				revision: 1,
				handoffId: "h1",
				completedAt: 4,
			}),
		];
		const state = foldPlanChanges(entries);
		expect(state.active).toBeUndefined();
		expect(state.latestApproved?.planId).toBe("p1");
		expect(state.latestApproved?.revision).toBe(1);
		expect(state.proposalsByRef.get("p1#1")?.steps[0]?.title).toBe("title");
	});

	it("folds drafting, reviewing, revise and pending transitions", () => {
		const entries = [
			change({ kind: "plan/change", version: 1, operation: "start", planId: "p1", objective: "goal", startedAt: 1 }),
			change({ kind: "plan/change", version: 1, operation: "submit", proposal: proposal("p1", 1), submittedAt: 2 }),
			change({
				kind: "plan/change",
				version: 1,
				operation: "revise-request",
				planId: "p1",
				sourceRevision: 1,
				feedback: "wider scope",
				requestedAt: 3,
			}),
		];
		const state = foldPlanChanges(entries);
		expect(state.active).toMatchObject({ planId: "p1", phase: "drafting", revision: 1 });
		// 未批准的 proposal 不入 approved
		expect(state.latestApproved).toBeUndefined();
	});

	it("folds inactive re-plan from an approved lineage", () => {
		const entries = [
			change({ kind: "plan/change", version: 1, operation: "start", planId: "p1", objective: "goal", startedAt: 1 }),
			change({ kind: "plan/change", version: 1, operation: "submit", proposal: proposal("p1", 1), submittedAt: 2 }),
			change({
				kind: "plan/change",
				version: 1,
				operation: "approve",
				planId: "p1",
				revision: 1,
				handoffId: "h1",
				approvedAt: 3,
			}),
			change({
				kind: "plan/change",
				version: 1,
				operation: "handoff-complete",
				planId: "p1",
				revision: 1,
				handoffId: "h1",
				completedAt: 4,
			}),
			change({
				kind: "plan/change",
				version: 1,
				operation: "revise-request",
				planId: "p1",
				sourceRevision: 1,
				requestedAt: 5,
			}),
		];
		const state = foldPlanChanges(entries);
		expect(state.active).toMatchObject({ planId: "p1", phase: "drafting", revision: 1 });
		expect(state.latestApproved?.revision).toBe(1);
	});

	it("folds an objective default for inactive re-plan from the approved lineage", () => {
		const entries = [
			change({ kind: "plan/change", version: 1, operation: "start", planId: "p1", objective: "goal", startedAt: 1 }),
			change({ kind: "plan/change", version: 1, operation: "submit", proposal: proposal("p1", 1), submittedAt: 2 }),
			change({
				kind: "plan/change",
				version: 1,
				operation: "approve",
				planId: "p1",
				revision: 1,
				handoffId: "h1",
				approvedAt: 3,
			}),
			change({
				kind: "plan/change",
				version: 1,
				operation: "handoff-complete",
				planId: "p1",
				revision: 1,
				handoffId: "h1",
				completedAt: 4,
			}),
			change({
				kind: "plan/change",
				version: 1,
				operation: "revise-request",
				planId: "p1",
				sourceRevision: 1,
				objective: "goal",
				requestedAt: 5,
			}),
		];
		const state = foldPlanChanges(entries);
		expect(state.active).toMatchObject({ planId: "p1", phase: "drafting", revision: 1, defaultObjective: "goal" });
	});

	it("reports invalid current-version entries but stays usable", () => {
		const entries = [
			change({ kind: "plan/change", version: 1, operation: "start", planId: "p1", objective: "goal", startedAt: 1 }),
			change({ kind: "plan/change", version: 1, operation: "start", planId: "" }),
		];
		const state = foldPlanChanges(entries);
		expect(state.foundInvalid).toBe(true);
		expect(state.active?.planId).toBe("p1");
	});
});

describe("plan proposal normalization", () => {
	it("trims and rejects blank fields and duplicate titles", () => {
		const ok = normalizeProposalInput({
			objective: "  build  ",
			overview: " overview ",
			steps: [{ title: " one ", details: " do it " }],
		});
		expect(ok.objective).toBe("build");
		expect(ok.steps[0]?.title).toBe("one");
		expect(() =>
			normalizeProposalInput({ objective: "", overview: "o", steps: [{ title: "t", details: "d" }] }),
		).toThrow();
		expect(() =>
			normalizeProposalInput({ objective: "o", overview: "", steps: [{ title: "t", details: "d" }] }),
		).toThrow();
		expect(() => normalizeProposalInput({ objective: "o", overview: "v", steps: [] })).toThrow();
		expect(() =>
			normalizeProposalInput({
				objective: "o",
				overview: "v",
				steps: [
					{ title: "same", details: "a" },
					{ title: " same ", details: "b" },
				],
			}),
		).toThrow(/duplicate step title/);
	});
});

describe("plan command args", () => {
	it("parses every command form", () => {
		expect(parsePlanCommandArgs("")).toEqual({ kind: "status" });
		expect(parsePlanCommandArgs("  ")).toEqual({ kind: "status" });
		expect(parsePlanCommandArgs("start build the thing")).toEqual({ kind: "start", objective: "build the thing" });
		expect(parsePlanCommandArgs("build the thing")).toEqual({ kind: "start", objective: "build the thing" });
		expect(parsePlanCommandArgs("approve")).toEqual({ kind: "approve" });
		expect(parsePlanCommandArgs("revise")).toEqual({ kind: "revise" });
		expect(parsePlanCommandArgs("revise focus on tests")).toEqual({ kind: "revise", feedback: "focus on tests" });
		expect(parsePlanCommandArgs("cancel")).toEqual({ kind: "cancel" });
		expect(parsePlanCommandArgs("retry")).toEqual({ kind: "retry" });
		expect(() => parsePlanCommandArgs("start  ")).toThrow();
	});
});
