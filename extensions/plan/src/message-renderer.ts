import { getMarkdownTheme, type MessageRenderOptions, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	PLAN_KICKOFF_MESSAGE_TYPE,
	PLAN_PROPOSAL_CARD_MESSAGE_TYPE,
	PLAN_REVISE_REQUEST_MESSAGE_TYPE,
	PLAN_START_MESSAGE_TYPE,
} from "./constants.js";
import type { PlanProposalV1, PlanStepV1 } from "./domain.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanStep(value: unknown): value is PlanStepV1 {
	return (
		isRecord(value) &&
		typeof value.stepId === "string" &&
		typeof value.title === "string" &&
		typeof value.details === "string"
	);
}

function isPlanProposal(value: unknown): value is PlanProposalV1 {
	return (
		isRecord(value) &&
		typeof value.planId === "string" &&
		typeof value.revision === "number" &&
		typeof value.objective === "string" &&
		typeof value.overview === "string" &&
		Array.isArray(value.steps) &&
		value.steps.every(isPlanStep)
	);
}

function readProposalDetails(
	details: unknown,
): { readonly proposal: PlanProposalV1; readonly replaceWarning?: string } | undefined {
	if (isPlanProposal(details)) return { proposal: details };
	if (!isRecord(details) || !isPlanProposal(details.proposal)) return undefined;
	const replaceWarning =
		typeof details.replaceWarning === "string" && details.replaceWarning.trim().length > 0
			? details.replaceWarning
			: undefined;
	return {
		proposal: details.proposal,
		...(replaceWarning === undefined ? {} : { replaceWarning }),
	};
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

function proposalMarkdown(content: string, details: unknown, options: MessageRenderOptions): Markdown {
	const parsed = readProposalDetails(details);
	if (parsed === undefined) return new Markdown(content, options.outputPad, 0, getMarkdownTheme());
	const { proposal, replaceWarning } = parsed;
	const lines = [
		"## Plan Proposal",
		`${proposal.planId} · revision ${proposal.revision}`,
		"",
		`**Objective:** ${proposal.objective}`,
		"",
		proposal.overview,
		"",
		"### Steps",
		...proposal.steps.flatMap((step, index) => [`#### ${index + 1}. ${step.title}`, "", step.details, ""]),
		...(replaceWarning === undefined ? [] : [`> ${replaceWarning}`, ""]),
		"**Decision:** `/plan approve` · `/plan revise [feedback]` · `/plan cancel`",
	];
	return new Markdown(lines.join("\n"), options.outputPad, 0, getMarkdownTheme());
}

function expandedText(content: string, theme: Theme): Text {
	return new Text(theme.fg("text", content), 0, 0);
}

export function renderPlanMessage(
	customType: string,
	message: { readonly content: string; readonly details?: unknown },
	options: MessageRenderOptions,
	theme: Theme,
): Component {
	if (customType === PLAN_PROPOSAL_CARD_MESSAGE_TYPE) {
		return proposalMarkdown(message.content, message.details, options);
	}
	return options.expanded ? expandedText(message.content, theme) : compactText(customType, message.content, theme);
}
