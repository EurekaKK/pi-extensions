import type { MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	PLAN_KICKOFF_MESSAGE_TYPE,
	PLAN_PROPOSAL_CARD_MESSAGE_TYPE,
	PLAN_REVISE_REQUEST_MESSAGE_TYPE,
	PLAN_START_MESSAGE_TYPE,
} from "./constants.js";
import type { PlanProposalV1 } from "./domain.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactText(customType: string, content: string, theme: Theme): Text {
	const first = content.split("\n").slice(0, 3).join("\n");
	return new Text(
		theme.fg(
			customType === PLAN_KICKOFF_MESSAGE_TYPE ? "success" : "accent",
			`[${shortLabel(customType)}] ${truncateToWidth(first, 200)}`,
		),
		0,
		0,
	);
}

function shortLabel(customType: string): string {
	switch (customType) {
		case PLAN_START_MESSAGE_TYPE:
			return "plan started";
		case PLAN_PROPOSAL_CARD_MESSAGE_TYPE:
			return "plan proposal";
		case PLAN_REVISE_REQUEST_MESSAGE_TYPE:
			return "plan revision requested";
		case PLAN_KICKOFF_MESSAGE_TYPE:
			return "plan handoff complete";
		default:
			return "plan";
	}
}

function expandedText(customType: string, content: string, details: unknown, theme: Theme): Text {
	if (customType === PLAN_PROPOSAL_CARD_MESSAGE_TYPE && isRecord(details)) {
		const proposal = details as unknown as PlanProposalV1;
		if (proposal.planId !== undefined && Array.isArray(proposal.steps)) {
			const lines = [
				`Plan Proposal · ${proposal.planId} · revision ${proposal.revision}`,
				`Objective: ${proposal.objective}`,
				"",
				proposal.overview,
				"",
				"Steps:",
				...proposal.steps.map((step, index) => `${index + 1}. ${step.title}\n\n${step.details}`),
			];
			return new Text(theme.fg("text", lines.join("\n")), 0, 0);
		}
	}
	return new Text(theme.fg("text", content), 0, 0);
}

export function renderPlanMessage(
	customType: string,
	message: { readonly content: string; readonly details?: unknown },
	options: MessageRenderOptions,
	theme: Theme,
): Text {
	const { expanded } = options;
	return expanded
		? expandedText(customType, message.content, message.details, theme)
		: compactText(customType, message.content, theme);
}
