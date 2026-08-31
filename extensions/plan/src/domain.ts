import { hasExactKeys, isRecord } from "config-store";
import { PLAN_CHANGE_ENTRY_TYPE, PLAN_CHANGE_VERSION } from "./constants.js";

/**
 * 状态机（从审阅通过的 prototype 提取）：
 *
 *   inactive → drafting → reviewing → handoff_pending → inactive
 *                   ↑          │
 *                   └─ revise ─┘
 *
 * `/plan start` 走 inactive→drafting（新 identity）；`/plan revise` 在
 * reviewing 内回到 drafting，或存在最新 Approved Plan 时从 inactive 进入
 * drafting 并延续 lineage。
 */

export type PlanPhase = "drafting" | "reviewing" | "handoff_pending";

export interface PlanStepV1 {
	readonly stepId: string;
	readonly title: string;
	readonly details: string;
}

export interface PlanProposalV1 {
	readonly planId: string;
	readonly revision: number;
	readonly objective: string;
	readonly overview: string;
	readonly steps: readonly PlanStepV1[];
}

export interface PlanHandoffRefV1 {
	readonly planId: string;
	readonly revision: number;
	readonly handoffId: string;
}

export type PlanChange =
	| {
			readonly kind: "plan/change";
			readonly version: 1;
			readonly operation: "start";
			readonly planId: string;
			readonly objective: string;
			readonly startedAt: number;
	  }
	| {
			readonly kind: "plan/change";
			readonly version: 1;
			readonly operation: "submit";
			readonly proposal: PlanProposalV1;
			readonly submittedAt: number;
	  }
	| {
			readonly kind: "plan/change";
			readonly version: 1;
			readonly operation: "revise-request";
			readonly planId: string;
			readonly sourceRevision: number;
			readonly feedback?: string;
			readonly requestedAt: number;
	  }
	| {
			readonly kind: "plan/change";
			readonly version: 1;
			readonly operation: "approve";
			readonly planId: string;
			readonly revision: number;
			readonly handoffId: string;
			readonly approvedAt: number;
	  }
	| {
			readonly kind: "plan/change";
			readonly version: 1;
			readonly operation: "handoff-complete";
			readonly planId: string;
			readonly revision: number;
			readonly handoffId: string;
			readonly completedAt: number;
	  }
	| {
			readonly kind: "plan/change";
			readonly version: 1;
			readonly operation: "cancel";
			readonly planId: string;
			readonly cancelledAt: number;
	  };

export type PlanChangeParseResult =
	| { readonly status: "valid"; readonly change: PlanChange }
	| { readonly status: "invalid" }
	| { readonly status: "ignored" };

export interface FoldedPlanState {
	/** 活动工作流；undefined 表示 inactive。 */
	readonly active:
		| {
				readonly planId: string;
				readonly phase: PlanPhase;
				readonly revision?: number;
				readonly handoffId?: string;
		  }
		| undefined;
	/** 每个 planId 最后一次提交的 proposal（含历史 revision 查询用 map）。 */
	readonly proposalsByRef: ReadonlyMap<string, PlanProposalV1>;
	/** planId → 最新批准 revision。 */
	readonly approvedByPlan: ReadonlyMap<string, number>;
	/** 最新批准的计划（用于 inactive 时 re-plan lineage 与 status 显示）。 */
	readonly latestApproved?: { readonly planId: string; readonly revision: number; readonly proposal: PlanProposalV1 };
	/** 存在形状损坏的当前版本 entry。 */
	readonly foundInvalid: boolean;
}

export class PlanError extends Error {
	constructor(
		message: string,
		readonly code: string = "PLAN_ERROR",
	) {
		super(message);
		this.name = "PlanError";
	}
}

const CONTROL_WORDS = new Set(["start", "approve", "revise", "cancel", "retry"]);

export function parsePlanCommandArgs(argumentsText: string):
	| {
			readonly kind: "status";
	  }
	| { readonly kind: "start"; readonly objective: string }
	| {
			readonly kind: "approve";
	  }
	| { readonly kind: "revise"; readonly feedback?: string }
	| { readonly kind: "cancel" }
	| {
			readonly kind: "retry";
	  } {
	const text = argumentsText.trim();
	if (text.length === 0) return { kind: "status" };
	const [first, ...rest] = text.split(/\s+/);
	const control = first?.toLowerCase();
	if (control !== undefined && CONTROL_WORDS.has(control)) {
		if (control === "start") {
			const objective = rest.join(" ").trim();
			if (objective.length === 0)
				throw new PlanError("objective must be a non-empty string", "PLAN_OBJECTIVE_REQUIRED");
			return { kind: "start", objective };
		}
		if (control === "approve") return { kind: "approve" };
		if (control === "revise") {
			const feedback = rest.join(" ").trim();
			return feedback.length === 0 ? { kind: "revise" } : { kind: "revise", feedback };
		}
		if (control === "cancel") return { kind: "cancel" };
		return { kind: "retry" };
	}
	// shorthand：/plan <objective>
	return { kind: "start", objective: text };
}

export function normalizeProposalInput(input: {
	readonly objective: string;
	readonly overview: string;
	readonly steps: readonly { readonly title: string; readonly details: string }[];
}): { readonly objective: string; readonly overview: string; readonly steps: readonly PlanStepV1[] } {
	const objective = input.objective.trim();
	if (objective.length === 0)
		throw new PlanError("plan objective must be a non-empty string", "PLAN_INVALID_OBJECTIVE");
	const overview = input.overview.trim();
	if (overview.length === 0) throw new PlanError("plan overview must be a non-empty string", "PLAN_INVALID_OVERVIEW");
	if (input.steps.length === 0) throw new PlanError("plan must contain at least one step", "PLAN_INVALID_STEPS");
	const steps: PlanStepV1[] = [];
	const seenTitles = new Set<string>();
	for (const [index, step] of input.steps.entries()) {
		const title = step.title.trim();
		const details = step.details.trim();
		if (title.length === 0)
			throw new PlanError(`step ${index + 1} title must be a non-empty string`, "PLAN_INVALID_STEP");
		if (details.length === 0) {
			throw new PlanError(`step ${index + 1} details must be a non-empty string`, "PLAN_INVALID_STEP");
		}
		if (seenTitles.has(title)) {
			throw new PlanError(`duplicate step title ${JSON.stringify(title)}`, "PLAN_DUPLICATE_STEP_TITLE");
		}
		seenTitles.add(title);
		steps.push({ stepId: "", title, details });
	}
	return { objective, overview, steps };
}

function freezeProposal(proposal: PlanProposalV1): PlanProposalV1 {
	return Object.freeze({
		planId: proposal.planId,
		revision: proposal.revision,
		objective: proposal.objective,
		overview: proposal.overview,
		steps: Object.freeze(
			proposal.steps.map((step) => Object.freeze({ stepId: step.stepId, title: step.title, details: step.details })),
		),
	});
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function parsePlanChange(value: unknown): PlanChangeParseResult {
	if (!isRecord(value)) return { status: "invalid" };
	if (value.kind !== "plan/change" || value.version !== PLAN_CHANGE_VERSION) return { status: "ignored" };
	if (typeof value.operation !== "string") return { status: "invalid" };
	try {
		switch (value.operation) {
			case "start": {
				if (!hasExactKeys(value, ["kind", "objective", "operation", "planId", "startedAt", "version"])) {
					return { status: "invalid" };
				}
				if (!isNonEmptyString(value.planId) || !isNonEmptyString(value.objective)) return { status: "invalid" };
				if (!isPositiveSafeInteger(value.startedAt)) return { status: "invalid" };
				return {
					status: "valid",
					change: {
						kind: "plan/change",
						version: 1,
						operation: "start",
						planId: value.planId,
						objective: value.objective,
						startedAt: value.startedAt,
					},
				};
			}
			case "submit": {
				if (!hasExactKeys(value, ["kind", "operation", "proposal", "submittedAt", "version"])) {
					return { status: "invalid" };
				}
				const proposal = parseProposal(value.proposal);
				if (proposal === null || !isPositiveSafeInteger(value.submittedAt)) return { status: "invalid" };
				return {
					status: "valid",
					change: { kind: "plan/change", version: 1, operation: "submit", proposal, submittedAt: value.submittedAt },
				};
			}
			case "revise-request": {
				const allowedKeys = ["feedback", "kind", "operation", "planId", "requestedAt", "sourceRevision", "version"];
				if (!Object.keys(value).every((key) => allowedKeys.includes(key))) return { status: "invalid" };
				if (
					!Object.hasOwn(value, "planId") ||
					!Object.hasOwn(value, "sourceRevision") ||
					!Object.hasOwn(value, "requestedAt")
				) {
					return { status: "invalid" };
				}
				if (
					!isNonEmptyString(value.planId) ||
					!isPositiveSafeInteger(value.sourceRevision) ||
					!isPositiveSafeInteger(value.requestedAt)
				) {
					return { status: "invalid" };
				}
				if (value.feedback !== undefined && typeof value.feedback !== "string") return { status: "invalid" };
				return {
					status: "valid",
					change: {
						kind: "plan/change",
						version: 1,
						operation: "revise-request",
						planId: value.planId,
						sourceRevision: value.sourceRevision,
						...(value.feedback === undefined ? {} : { feedback: value.feedback }),
						requestedAt: value.requestedAt,
					},
				};
			}
			case "approve": {
				if (!hasExactKeys(value, ["approvedAt", "handoffId", "kind", "operation", "planId", "revision", "version"])) {
					return { status: "invalid" };
				}
				if (
					!isNonEmptyString(value.planId) ||
					!isPositiveSafeInteger(value.revision) ||
					!isNonEmptyString(value.handoffId) ||
					!isPositiveSafeInteger(value.approvedAt)
				) {
					return { status: "invalid" };
				}
				return {
					status: "valid",
					change: {
						kind: "plan/change",
						version: 1,
						operation: "approve",
						planId: value.planId,
						revision: value.revision,
						handoffId: value.handoffId,
						approvedAt: value.approvedAt,
					},
				};
			}
			case "handoff-complete": {
				if (!hasExactKeys(value, ["completedAt", "handoffId", "kind", "operation", "planId", "revision", "version"])) {
					return { status: "invalid" };
				}
				if (
					!isNonEmptyString(value.planId) ||
					!isPositiveSafeInteger(value.revision) ||
					!isNonEmptyString(value.handoffId) ||
					!isPositiveSafeInteger(value.completedAt)
				) {
					return { status: "invalid" };
				}
				return {
					status: "valid",
					change: {
						kind: "plan/change",
						version: 1,
						operation: "handoff-complete",
						planId: value.planId,
						revision: value.revision,
						handoffId: value.handoffId,
						completedAt: value.completedAt,
					},
				};
			}
			case "cancel": {
				if (!hasExactKeys(value, ["cancelledAt", "kind", "operation", "planId", "version"])) {
					return { status: "invalid" };
				}
				if (!isNonEmptyString(value.planId) || !isPositiveSafeInteger(value.cancelledAt)) return { status: "invalid" };
				return {
					status: "valid",
					change: {
						kind: "plan/change",
						version: 1,
						operation: "cancel",
						planId: value.planId,
						cancelledAt: value.cancelledAt,
					},
				};
			}
			default:
				return { status: "invalid" };
		}
	} catch {
		return { status: "invalid" };
	}
}

function parseProposal(value: unknown): PlanProposalV1 | null {
	if (!isRecord(value)) return null;
	const allowedKeys = ["objective", "overview", "planId", "revision", "steps"];
	if (!Object.keys(value).every((key) => allowedKeys.includes(key))) return null;
	if (
		!Object.hasOwn(value, "planId") ||
		!Object.hasOwn(value, "revision") ||
		!Object.hasOwn(value, "objective") ||
		!Object.hasOwn(value, "overview") ||
		!Object.hasOwn(value, "steps")
	) {
		return null;
	}
	if (!isNonEmptyString(value.planId) || !isPositiveSafeInteger(value.revision)) return null;
	if (!isNonEmptyString(value.objective) || typeof value.overview !== "string") return null;
	if (!Array.isArray(value.steps) || value.steps.length === 0) return null;
	const steps: PlanStepV1[] = [];
	const seenTitles = new Set<string>();
	for (const candidate of value.steps) {
		if (!isRecord(candidate) || !hasExactKeys(candidate, ["details", "stepId", "title"])) return null;
		if (!isNonEmptyString(candidate.stepId) || !isNonEmptyString(candidate.title)) return null;
		if (typeof candidate.details !== "string") return null;
		if (seenTitles.has(candidate.title)) return null;
		seenTitles.add(candidate.title);
		steps.push(Object.freeze({ stepId: candidate.stepId, title: candidate.title, details: candidate.details }));
	}
	return freezeProposal({
		planId: value.planId,
		revision: value.revision,
		objective: value.objective,
		overview: value.overview,
		steps: Object.freeze(steps),
	});
}

export function foldPlanChanges(
	entries: readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[],
): FoldedPlanState {
	let active: FoldedPlanState["active"];
	const proposalsByRef = new Map<string, PlanProposalV1>();
	const latestByPlan = new Map<string, PlanProposalV1>();
	const approvedByPlan = new Map<string, number>();
	let foundInvalid = false;

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PLAN_CHANGE_ENTRY_TYPE) continue;
		const parsed = parsePlanChange(entry.data);
		if (parsed.status === "ignored") continue;
		if (parsed.status === "invalid") {
			foundInvalid = true;
			continue;
		}
		const change = parsed.change;
		switch (change.operation) {
			case "start":
				active = { planId: change.planId, phase: "drafting" };
				break;
			case "submit": {
				const { proposal } = change;
				proposalsByRef.set(`${proposal.planId}#${proposal.revision}`, proposal);
				latestByPlan.set(proposal.planId, proposal);
				if (active?.planId === proposal.planId && active.phase === "drafting") {
					active = { planId: proposal.planId, phase: "reviewing", revision: proposal.revision };
				}
				break;
			}
			case "revise-request": {
				if (active?.planId === change.planId && (active.phase === "reviewing" || active.phase === "drafting")) {
					active = { planId: change.planId, phase: "drafting", revision: change.sourceRevision };
				} else if (active === undefined && approvedByPlan.has(change.planId)) {
					active = { planId: change.planId, phase: "drafting", revision: change.sourceRevision };
				}
				break;
			}
			case "approve": {
				if (active?.planId === change.planId && active.phase === "reviewing" && active.revision === change.revision) {
					active = {
						planId: change.planId,
						phase: "handoff_pending",
						revision: change.revision,
						handoffId: change.handoffId,
					};
					approvedByPlan.set(change.planId, change.revision);
				}
				break;
			}
			case "handoff-complete": {
				if (
					active?.planId === change.planId &&
					active.phase === "handoff_pending" &&
					active.handoffId === change.handoffId
				) {
					active = undefined;
				}
				break;
			}
			case "cancel": {
				if (active?.planId === change.planId) active = undefined;
				break;
			}
		}
	}

	let latestApproved: FoldedPlanState["latestApproved"];
	for (const [planId, revision] of approvedByPlan) {
		const proposal = latestByPlan.get(planId);
		if (proposal !== undefined) latestApproved = { planId, revision, proposal };
	}

	return Object.freeze({
		active,
		proposalsByRef,
		approvedByPlan,
		...(latestApproved === undefined ? {} : { latestApproved }),
		foundInvalid,
	});
}
