import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_CHANGE_ENTRY_TYPE } from "./constants.js";
import {
	type FoldedPlanState,
	foldPlanChanges,
	normalizeProposalInput,
	type PlanChange,
	PlanError,
	type PlanProposalV1,
	type PlanStepV1,
} from "./domain.js";

export interface PlanServiceOptions {
	readonly pi: Pick<ExtensionAPI, "appendEntry">;
	readonly now?: () => number;
}

/**
 * PlanService：事件溯源状态访问 + mutation。所有 mutation 先构造完整 change 再
 * append；append 失败直接抛错，不修改任何派生状态。
 */
export class PlanService {
	readonly #pi: Pick<ExtensionAPI, "appendEntry">;
	readonly #now: () => number;

	constructor(options: PlanServiceOptions) {
		this.#pi = options.pi;
		this.#now = options.now ?? Date.now;
	}

	state(context: Pick<ExtensionContext, "sessionManager">): FoldedPlanState {
		return foldPlanChanges(context.sessionManager.getBranch());
	}

	start(context: Pick<ExtensionContext, "sessionManager">, objective: string): { readonly planId: string } {
		const state = this.state(context);
		if (state.active !== undefined) {
			throw new PlanError(`a planning workflow is already ${state.active.phase}`, "PLAN_ALREADY_ACTIVE");
		}
		const planId = `plan-${randomUUID()}`;
		const change: PlanChange = {
			kind: "plan/change",
			version: 1,
			operation: "start",
			planId,
			objective: objective.trim(),
			startedAt: this.#now(),
		};
		this.append(context, change);
		return { planId };
	}

	submit(
		context: Pick<ExtensionContext, "sessionManager">,
		input: {
			readonly objective: string;
			readonly overview: string;
			readonly steps: readonly { readonly title: string; readonly details: string }[];
		},
	): PlanProposalV1 {
		const state = this.state(context);
		const active = state.active;
		if (active === undefined || active.phase !== "drafting") {
			throw new PlanError(
				"plan_submit requires an active drafting workflow; use /plan start <objective>",
				"PLAN_INVALID_PHASE",
			);
		}
		const normalized = normalizeProposalInput(input);
		const revision = (active.revision ?? 0) + 1;
		const steps: PlanStepV1[] = normalized.steps.map((step) => ({
			...step,
			stepId: `step-${randomUUID()}`,
		}));
		const proposal: PlanProposalV1 = {
			planId: active.planId,
			revision,
			objective: normalized.objective,
			overview: normalized.overview,
			steps: Object.freeze(steps),
		};
		const change: PlanChange = {
			kind: "plan/change",
			version: 1,
			operation: "submit",
			proposal,
			submittedAt: this.#now(),
		};
		this.append(context, change);
		return proposal;
	}

	reviseRequest(
		context: Pick<ExtensionContext, "sessionManager">,
		options: { readonly planId: string; readonly sourceRevision: number; readonly feedback?: string },
	): void {
		const change: PlanChange = {
			kind: "plan/change",
			version: 1,
			operation: "revise-request",
			planId: options.planId,
			sourceRevision: options.sourceRevision,
			...(options.feedback === undefined ? {} : { feedback: options.feedback }),
			requestedAt: this.#now(),
		};
		this.append(context, change);
	}

	approve(context: Pick<ExtensionContext, "sessionManager">): { readonly planId: string; readonly handoffId: string } {
		const active = this.state(context).active;
		if (active === undefined || active.phase !== "reviewing" || active.revision === undefined) {
			throw new PlanError("approval requires a reviewing Plan Proposal", "PLAN_INVALID_PHASE");
		}
		const handoffId = `handoff-${randomUUID()}`;
		const change: PlanChange = {
			kind: "plan/change",
			version: 1,
			operation: "approve",
			planId: active.planId,
			revision: active.revision,
			handoffId,
			approvedAt: this.#now(),
		};
		this.append(context, change);
		return { planId: active.planId, handoffId };
	}

	completeHandoff(
		context: Pick<ExtensionContext, "sessionManager">,
		options: { readonly planId: string; readonly revision: number; readonly handoffId: string },
	): void {
		const change: PlanChange = {
			kind: "plan/change",
			version: 1,
			operation: "handoff-complete",
			planId: options.planId,
			revision: options.revision,
			handoffId: options.handoffId,
			completedAt: this.#now(),
		};
		this.append(context, change);
	}

	cancel(context: Pick<ExtensionContext, "sessionManager">): void {
		const active = this.state(context).active;
		if (active === undefined) throw new PlanError("no active planning workflow to cancel", "PLAN_INVALID_PHASE");
		const change: PlanChange = {
			kind: "plan/change",
			version: 1,
			operation: "cancel",
			planId: active.planId,
			cancelledAt: this.#now(),
		};
		this.append(context, change);
	}

	append(_context: Pick<ExtensionContext, "sessionManager">, change: PlanChange): void {
		try {
			this.#pi.appendEntry(PLAN_CHANGE_ENTRY_TYPE, change);
		} catch (error) {
			throw new PlanError(
				`plan persistence failed: ${error instanceof Error ? error.message : String(error)}`,
				"PLAN_PERSISTENCE_FAILED",
			);
		}
	}
}
