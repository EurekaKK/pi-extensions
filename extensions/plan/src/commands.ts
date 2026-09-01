import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { foldTodoSnapshots, hasCommittedHandoff, type TodoItemV3 } from "todo-protocol";
import { type FoldedPlanState, PlanError, parsePlanCommandArgs } from "./domain.js";
import type { PlanGate } from "./gate.js";
import { requestTodoReplace } from "./handoff.js";
import { sendKickoffMessage, sendPlanStartMessage, sendReviseRequestMessage } from "./messages.js";
import type { PlanService } from "./service.js";

export interface PlanCommandRuntime {
	readonly pi: ExtensionAPI;
	readonly service: PlanService;
	readonly gate: PlanGate;
	readonly applyGateIfNeeded: (context: ExtensionContext) => void;
	readonly projectFooter: (context: ExtensionContext) => void;
	readonly clearFooter: (context: ExtensionContext) => void;
	readonly notify: (context: ExtensionContext, message: string, level?: "info" | "warning" | "error") => void;
}

export async function executePlanCommand(
	runtime: PlanCommandRuntime,
	argumentsText: string,
	context: ExtensionContext,
): Promise<string> {
	const parsed = parsePlanCommandArgs(argumentsText);
	switch (parsed.kind) {
		case "status":
			return renderStatus(runtime.service.state(context));
		case "start": {
			const state = runtime.service.state(context);
			if (state.active !== undefined) {
				throw new PlanError(`a planning workflow is already ${state.active.phase}`, "PLAN_ALREADY_ACTIVE");
			}
			const { planId } = runtime.service.start(context, parsed.objective);
			runtime.applyGateIfNeeded(context);
			runtime.projectFooter(context);
			sendPlanStartMessage(runtime.pi, parsed.objective);
			return `Planning Workflow started: ${planId}. Draft the Proposal with plan_submit.`;
		}
		case "approve": {
			const state = runtime.service.state(context);
			if (state.active?.phase !== "reviewing" || state.active.revision === undefined) {
				throw new PlanError("approval requires a reviewing Plan Proposal", "PLAN_INVALID_PHASE");
			}
			return approveFlow(runtime, context);
		}
		case "revise":
			return reviseFlow(runtime, context, parsed.feedback);
		case "cancel":
			return cancelFlow(runtime, context);
		case "retry":
			return retryFlow(runtime, context);
	}
}

export function approveFlow(runtime: PlanCommandRuntime, context: ExtensionContext): string {
	const state = runtime.service.state(context);
	const active = state.active;
	if (active?.phase !== "reviewing" || active.revision === undefined) {
		throw new PlanError("approval requires a reviewing Plan Proposal", "PLAN_INVALID_PHASE");
	}
	const proposal = state.proposalsByRef.get(`${active.planId}#${active.revision}`);
	if (proposal === undefined) throw new PlanError("reviewing Proposal not found on this branch", "PLAN_NOT_FOUND");
	const { handoffId } = runtime.service.approve(context);
	runtime.applyGateIfNeeded(context);
	return finishHandoff(runtime, context, proposal, handoffId);
}

export function retryFlow(runtime: PlanCommandRuntime, context: ExtensionContext): string {
	const state = runtime.service.state(context);
	const active = state.active;
	if (active?.phase !== "handoff_pending" || active.handoffId === undefined || active.revision === undefined) {
		throw new PlanError("handoff retry requires a pending handoff", "PLAN_INVALID_PHASE");
	}
	const committed = hasCommittedHandoff(context.sessionManager.getBranch(), active.handoffId);
	if (committed) {
		const proposal = state.proposalsByRef.get(`${active.planId}#${active.revision}`);
		if (proposal === undefined) throw new PlanError("approved Proposal not found on this branch", "PLAN_NOT_FOUND");
		runtime.service.completeHandoff(context, {
			planId: active.planId,
			revision: active.revision,
			handoffId: active.handoffId,
		});
		runtime.gate.restore();
		runtime.clearFooter(context);
		sendKickoffMessage(runtime.pi, proposal);
		return "Handoff was already committed; workflow closed and execution started.";
	}
	const proposal = state.proposalsByRef.get(`${active.planId}#${active.revision}`);
	if (proposal === undefined) throw new PlanError("approved Proposal not found on this branch", "PLAN_NOT_FOUND");
	return finishHandoff(runtime, context, proposal, active.handoffId);
}

function finishHandoff(
	runtime: PlanCommandRuntime,
	context: ExtensionContext,
	proposal: {
		readonly planId: string;
		readonly revision: number;
		readonly steps: readonly { readonly stepId: string; readonly title: string }[];
	},
	handoffId: string,
): string {
	const todos: TodoItemV3[] = proposal.steps.map((step) => ({
		content: step.title,
		status: "pending",
		source: {
			kind: "plan-step",
			ref: { planId: proposal.planId, planRevision: proposal.revision, stepId: step.stepId },
		},
	}));
	// 在替换发生前统计既有列表：只有非空旧列表才披露替换，且计数必须来自替换前。
	const priorCount = foldTodoSnapshots(context.sessionManager.getBranch()).todos.length;
	const outcome = requestTodoReplace(runtime.pi, context, { requestId: `req-${handoffId}`, handoffId, todos });
	if (!outcome.ok) {
		runtime.projectFooter(context);
		throw new PlanError(
			`handoff failed and remains pending: ${outcome.error}. Use /plan retry after fixing Todo.`,
			"PLAN_HANDOFF_FAILED",
		);
	}
	runtime.service.completeHandoff(context, { planId: proposal.planId, revision: proposal.revision, handoffId });
	runtime.gate.restore();
	runtime.clearFooter(context);
	sendKickoffMessage(runtime.pi, proposal);
	const replaceNote =
		priorCount > 0
			? `\nNote: approval replaced the previous Todo list (${priorCount} item${priorCount === 1 ? "" : "s"}); its history remains only in the session.`
			: "";
	return `Plan approved and handed off; ${todos.length} linked Todos created (all pending). Execution started.${replaceNote}`;
}

export function reviseFlow(runtime: PlanCommandRuntime, context: ExtensionContext, feedback?: string): string {
	const state = runtime.service.state(context);
	const active = state.active;
	if (active !== undefined && active.phase === "drafting") {
		throw new PlanError("the workflow is already drafting", "PLAN_INVALID_PHASE");
	}
	if (active !== undefined && (active.phase === "reviewing" || active.phase === "handoff_pending")) {
		if (active.phase === "handoff_pending") {
			throw new PlanError("cannot revise while handoff is pending", "PLAN_INVALID_PHASE");
		}
		if (active.revision === undefined) throw new PlanError("reviewing revision is unknown", "PLAN_INVALID_PHASE");
		runtime.service.reviseRequest(context, {
			planId: active.planId,
			sourceRevision: active.revision,
			...(feedback === undefined ? {} : { feedback }),
		});
		runtime.projectFooter(context);
		sendReviseRequestMessage(runtime.pi, { planId: active.planId, ...(feedback === undefined ? {} : { feedback }) });
		return `Revision requested for ${active.planId}; drafting revision ${active.revision + 1}.`;
	}
	const approved = state.latestApproved;
	if (approved === undefined) {
		throw new PlanError("no approved Plan to revise; use /plan start <objective>", "PLAN_NO_APPROVED_PLAN");
	}
	// spec：inactive→drafting 延续 lineage 时，objective 默认沿用已批准 revision 的 objective。
	const objective = approved.proposal.objective;
	runtime.service.reviseRequest(context, {
		planId: approved.planId,
		sourceRevision: approved.revision,
		objective,
		...(feedback === undefined ? {} : { feedback }),
	});
	runtime.applyGateIfNeeded(context);
	runtime.projectFooter(context);
	sendReviseRequestMessage(runtime.pi, {
		planId: approved.planId,
		objective,
		...(feedback === undefined ? {} : { feedback }),
	});
	return `Re-planning approved ${approved.planId} from revision ${approved.revision}; objective defaults to ${JSON.stringify(objective)}. The new revision must cover all remaining work.`;
}

export function cancelFlow(runtime: PlanCommandRuntime, context: ExtensionContext): string {
	const state = runtime.service.state(context);
	const active = state.active;
	if (active === undefined) throw new PlanError("no active planning workflow to cancel", "PLAN_INVALID_PHASE");
	if (active.phase === "handoff_pending" && active.handoffId !== undefined) {
		if (hasCommittedHandoff(context.sessionManager.getBranch(), active.handoffId)) {
			throw new PlanError(
				"handoff is already durably committed; execution control belongs to Todo",
				"PLAN_HANDOFF_COMMITTED",
			);
		}
	}
	runtime.service.cancel(context);
	runtime.gate.restore();
	runtime.clearFooter(context);
	return `Planning Workflow ${active.planId} cancelled; no execution list was created.`;
}

export function renderStatus(state: FoldedPlanState): string {
	const lines: string[] = [];
	if (state.active !== undefined) {
		lines.push(
			`Status: ${state.active.phase}`,
			`Plan: ${state.active.planId}${state.active.revision === undefined ? "" : ` · revision ${state.active.revision}`}`,
		);
		if (state.active.phase === "drafting" && state.active.defaultObjective !== undefined) {
			lines.push(`Objective (default): ${state.active.defaultObjective}`);
		}
		lines.push("Workspace mutations are blocked while the Planning Workflow is active.");
	} else {
		lines.push("Status: no active planning workflow.");
	}
	if (state.latestApproved !== undefined) {
		lines.push(
			"",
			`Latest Approved Plan: ${state.latestApproved.planId} · revision ${state.latestApproved.revision}`,
			`Objective: ${state.latestApproved.proposal.objective}`,
			`Steps: ${state.latestApproved.proposal.steps.length}`,
		);
	}
	lines.push(
		"",
		"Commands: /plan start <objective>, /plan approve, /plan revise [feedback], /plan cancel, /plan retry",
	);
	return lines.join("\n");
}
