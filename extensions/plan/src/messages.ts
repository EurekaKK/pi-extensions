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

export function sendProposalCardMessage(
	pi: ExtensionAPI,
	proposal: PlanProposalV1,
	options: { readonly replaceWarning?: string } = {},
): void {
	const summary = [
		`Plan Proposal · ${proposal.planId} · revision ${proposal.revision}`,
		`Objective: ${proposal.objective}`,
		"Decision: /plan approve · /plan revise [feedback] · /plan cancel",
		...(options.replaceWarning === undefined ? [] : [options.replaceWarning]),
		"",
		...proposal.steps.map((step, index) => `${index + 1}. ${step.title}`),
	].join("\n");
	pi.sendMessage(
		{
			customType: PLAN_PROPOSAL_CARD_MESSAGE_TYPE,
			content: summary,
			display: true,
			details: { proposal, ...options },
		},
		{ triggerTurn: false },
	);
}

export function sendReviseRequestMessage(
	pi: ExtensionAPI,
	options: { readonly planId: string; readonly objective?: string; readonly feedback?: string },
): void {
	const lines = [`Plan ${options.planId} requires revision.`];
	if (options.objective !== undefined) {
		lines.push(`Objective (defaulted from the approved Plan): ${options.objective}`);
	}
	if (options.feedback !== undefined) {
		lines.push(`Feedback: ${options.feedback}`);
	}
	lines.push("", "Submit the next revision with plan_submit; it must cover all remaining work from the current state.");
	pi.sendMessage(
		{
			customType: PLAN_REVISE_REQUEST_MESSAGE_TYPE,
			content: lines.join("\n"),
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
