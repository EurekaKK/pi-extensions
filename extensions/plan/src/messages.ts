import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PLAN_KICKOFF_MESSAGE_TYPE,
	PLAN_PROPOSAL_CARD_MESSAGE_TYPE,
	PLAN_REVISE_REQUEST_MESSAGE_TYPE,
	PLAN_START_MESSAGE_TYPE,
} from "./constants.js";
import type { PlanProposalV1 } from "./domain.js";

type KickoffPlan = Pick<PlanProposalV1, "planId" | "revision"> & {
	readonly steps: readonly { readonly stepId: string; readonly title: string }[];
};

export function sendPlanStartMessage(pi: ExtensionAPI, objective: string): void {
	pi.sendMessage(
		{
			customType: PLAN_START_MESSAGE_TYPE,
			content: `Planning Workflow started.\nObjective: ${objective}\n\nUse plan_submit to submit a structured Plan Proposal for direct-human review. Do not mutate the Working Directory while planning.`,
			display: true,
		},
		{ triggerTurn: true },
	);
}

export function sendProposalCardMessage(pi: ExtensionAPI, proposal: PlanProposalV1): void {
	const summary = [
		`Plan Proposal · ${proposal.planId} · revision ${proposal.revision}`,
		`Objective: ${proposal.objective}`,
		"",
		...proposal.steps.map((step, index) => `${index + 1}. ${step.title}`),
		"",
		"Awaiting your decision: /plan approve, /plan revise, or /plan cancel.",
	].join("\n");
	pi.sendMessage(
		{
			customType: PLAN_PROPOSAL_CARD_MESSAGE_TYPE,
			content: summary,
			display: true,
			details: proposal,
		},
		{ triggerTurn: false },
	);
}

export function sendReviseRequestMessage(
	pi: ExtensionAPI,
	options: { readonly planId: string; readonly feedback?: string },
): void {
	const feedback = options.feedback === undefined ? "" : `\nFeedback: ${options.feedback}`;
	pi.sendMessage(
		{
			customType: PLAN_REVISE_REQUEST_MESSAGE_TYPE,
			content: `Plan ${options.planId} requires revision.${feedback}\n\nSubmit the next revision with plan_submit; it must cover all remaining work from the current state.`,
			display: true,
			details: options,
		},
		{ triggerTurn: true },
	);
}

export function sendKickoffMessage(pi: ExtensionAPI, proposal: KickoffPlan): void {
	const mapping = proposal.steps.map((step, index) => `${index + 1}. ${step.title} → todo "${step.title}"`).join("\n");
	pi.sendMessage(
		{
			customType: PLAN_KICKOFF_MESSAGE_TYPE,
			content: [
				`Approved Plan ${proposal.planId} revision ${proposal.revision} handed off to Todo.`,
				"Execute the linked Todo list. Do not edit the Plan or Plan entries.",
				"",
				"Step/Todo mapping:",
				mapping,
				"",
				"Start by reading the first step with plan_read({ plan_id, revision, step_id }), then use todo_write to mark the first item in_progress.",
			].join("\n"),
			display: true,
			details: { planId: proposal.planId, revision: proposal.revision },
		},
		{ triggerTurn: true },
	);
}
