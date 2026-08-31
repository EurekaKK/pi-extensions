import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { foldTodoSnapshots } from "todo-protocol";
import { type Static, Type } from "typebox";
import { PLAN_TOOL_READ_NAME, PLAN_TOOL_SUBMIT_NAME } from "./constants.js";
import { type FoldedPlanState, PlanError, type PlanProposalV1 } from "./domain.js";
import { sendProposalCardMessage } from "./messages.js";
import type { PlanService } from "./service.js";

export const PlanSubmitParameters = Type.Object(
	{
		objective: Type.String(),
		overview: Type.String(),
		steps: Type.Array(
			Type.Object(
				{
					title: Type.String(),
					details: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type PlanSubmitParameters = Static<typeof PlanSubmitParameters>;

export const PlanReadParameters = Type.Object(
	{
		plan_id: Type.Optional(Type.String()),
		revision: Type.Optional(Type.Integer({ minimum: 1 })),
		step_id: Type.Optional(Type.String()),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		limit: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);
export type PlanReadParameters = Static<typeof PlanReadParameters>;

export const PLAN_SUGGESTION_GUIDELINE =
	"Use plan tools when a plan already exists or the user explicitly asked for planning. When a request has " +
	"architectural ambiguity, high blast radius, or genuine review value, briefly suggest `/plan start <objective>` " +
	"once BEFORE any Workspace Mutation and wait for the user to enter Plan or to explicitly choose direct " +
	"execution. Do not suggest Plan merely because work has multiple steps, do not repeat the suggestion after " +
	"a decline for the same request, never start or approve a Planning Workflow yourself, and never mutate Plan or " +
	"Todo entries except through the provided tools.";

class BoundedLines implements Component {
	readonly #lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	render(width: number): string[] {
		return this.#lines.map((line) =>
			Array.from(line).length > width
				? `${Array.from(line)
						.slice(0, Math.max(1, width - 3))
						.join("")}...`
				: line,
		);
	}

	invalidate(): void {}
}

export interface PlanToolRuntime {
	readonly pi: ExtensionAPI;
	readonly service: PlanService;
	readonly onSubmitted: (proposal: PlanProposalV1) => void;
}

export function registerPlanTools(pi: ExtensionAPI, runtime: PlanToolRuntime): void {
	pi.registerTool(
		defineTool({
			name: PLAN_TOOL_SUBMIT_NAME,
			label: "Submit plan",
			description:
				"Submit the next immutable Plan Revision for a workflow that is currently drafting (started by the user with /plan start). " +
				"Send objective, a Markdown overview of rationale/trade-offs/risks/verification, and detailed steps with unique concise titles. " +
				"After submitting, stop planning and wait for direct-human Approve, Revise, or Cancel.",
			parameters: PlanSubmitParameters,
			executionMode: "sequential",
			execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const proposal = runtime.service.submit(context, {
					objective: parameters.objective,
					overview: parameters.overview,
					steps: parameters.steps.map((step) => ({ title: step.title, details: step.details })),
				});
				sendProposalCardMessage(pi, proposal);
				runtime.onSubmitted(proposal);
				return Promise.resolve({
					content: [
						{
							type: "text" as const,
							text: `Submitted ${proposal.planId} revision ${proposal.revision} (${proposal.steps.length} steps). Awaiting your approval; use /plan approve, /plan revise, or /plan cancel.`,
						},
					],
					details: {
						planId: proposal.planId,
						revision: proposal.revision,
						steps: proposal.steps.map((step) => step.title),
					},
					terminate: true,
				} satisfies AgentToolResult<unknown>);
			},
			renderCall(args, theme) {
				const stepCount = Array.isArray(args.steps) ? args.steps.length : 0;
				return new Text(
					`${theme.fg("toolTitle", theme.bold("plan_submit"))} ${theme.fg("muted", `· ${stepCount} steps`)}`,
					0,
					0,
				);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: PLAN_TOOL_READ_NAME,
			label: "Read plan",
			description:
				"Read current Plan status, one exact Plan Revision, or one exact Plan Step. " +
				"With no identity fields, return the current workflow and latest Approved Plan summary. " +
				"`plan_id` plus `revision` selects an exact revision; adding `step_id` selects one Step. " +
				"Optional `offset` (unicode code points) and `limit` paginate the rendered result; the reply reports the returned range and nextOffset. " +
				"For approved revisions, join the current Todo list read-only: linked status, missing linked items, and discovered (unlinked) Todo summaries. Todo is the execution authority; never write Plan or Todo progress here.",
			parameters: PlanReadParameters,
			executionMode: "parallel",
			promptGuidelines: [PLAN_SUGGESTION_GUIDELINE],
			execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const state = runtime.service.state(context);
				const text = renderPlanRead(state, parameters, context);
				const { visible, nextOffset } = paginate(text, parameters.offset, parameters.limit);
				const blocks = [{ type: "text" as const, text: visible }];
				if (nextOffset !== undefined) {
					blocks.push({
						type: "text" as const,
						text: `\n[plan_read pagination: nextOffset=${nextOffset}]`,
					});
				}
				return Promise.resolve({
					content: blocks,
					details: { ...parameters, nextOffset },
				} satisfies AgentToolResult<unknown>);
			},
			renderCall(_args, theme) {
				return new BoundedLines([theme.fg("toolTitle", theme.bold(PLAN_TOOL_READ_NAME))]);
			},
			renderResult(result, { expanded }, theme) {
				const text = result.content
					.filter((block): block is { readonly type: "text"; readonly text: string } => block.type === "text")
					.map((block) => block.text)
					.join("");
				if (expanded) return new Text(theme.fg("text", text), 0, 0);
				return new BoundedLines([theme.fg("text", text.split("\n")[0] ?? "")]);
			},
		}),
	);
}

function paginate(
	text: string,
	offset: number | undefined,
	limit: number | undefined,
): {
	readonly visible: string;
	readonly nextOffset?: number;
} {
	if (offset === undefined && limit === undefined) return { visible: text };
	const chars = Array.from(text);
	const start = offset ?? 0;
	const end = limit === undefined ? chars.length : start + limit;
	const visible = chars.slice(start, end).join("");
	const nextOffset = end < chars.length ? end : undefined;
	return { visible, ...(nextOffset === undefined ? {} : { nextOffset }) };
}

function renderPlanRead(state: FoldedPlanState, parameters: PlanReadParameters, context: ExtensionContext): string {
	if (parameters.plan_id === undefined && parameters.revision === undefined && parameters.step_id === undefined) {
		return renderStatus(state);
	}
	if (parameters.plan_id === undefined || parameters.revision === undefined) {
		throw new PlanError("plan_id and revision must be provided together", "PLAN_INVALID_REFERENCE");
	}
	const proposal = state.proposalsByRef.get(`${parameters.plan_id}#${parameters.revision}`);
	if (proposal === undefined) {
		throw new PlanError(
			`no Plan Revision ${parameters.plan_id} revision ${parameters.revision} on this branch`,
			"PLAN_NOT_FOUND",
		);
	}
	const approved = state.approvedByPlan.get(proposal.planId) === proposal.revision;
	const label = approved
		? "approved"
		: state.active?.planId === proposal.planId &&
				state.active?.phase === "reviewing" &&
				state.active.revision === proposal.revision
			? "awaiting review"
			: "historical";
	if (parameters.step_id !== undefined) {
		const step = proposal.steps.find((candidate) => candidate.stepId === parameters.step_id);
		if (step === undefined) {
			throw new PlanError(
				`no step ${parameters.step_id} in ${parameters.plan_id} revision ${parameters.revision}`,
				"PLAN_STEP_NOT_FOUND",
			);
		}
		const lines = [
			`Plan Step · ${proposal.planId} · revision ${proposal.revision} · ${step.stepId} · ${label}`,
			`Title: ${step.title}`,
			"",
			step.details,
		];
		if (approved) lines.push("", joinStepTodo(context, proposal, step.stepId));
		return lines.join("\n");
	}
	const lines = [
		`Plan Revision · ${proposal.planId} · revision ${proposal.revision} · ${label}`,
		`Objective: ${proposal.objective}`,
		"",
		proposal.overview,
		"",
		"Steps:",
		...proposal.steps.map((step, index) => `${index + 1}. ${step.stepId} · ${step.title}`),
	];
	if (approved) lines.push("", joinRevisionTodo(context, proposal));
	return lines.join("\n");
}

function renderStatus(state: FoldedPlanState): string {
	const lines: string[] = [];
	if (state.active !== undefined) {
		lines.push(
			`Plan status: ${state.active.phase} · ${state.active.planId}${state.active.revision === undefined ? "" : ` · revision ${state.active.revision}`}`,
			"Workspace mutations are blocked while the Planning Workflow is active.",
		);
	} else {
		lines.push("Plan status: no active workflow.");
	}
	if (state.latestApproved !== undefined) {
		const proposal = state.latestApproved.proposal;
		lines.push(
			"",
			`Latest Approved Plan: ${proposal.planId} revision ${proposal.revision}`,
			`Objective: ${proposal.objective}`,
			`Steps: ${proposal.steps.length}`,
		);
	}
	return lines.join("\n");
}

function joinStepTodo(context: ExtensionContext, proposal: PlanProposalV1, stepId: string): string {
	const todo = foldTodoSnapshots(context.sessionManager.getBranch());
	const linked = todo.todos.filter(
		(item) =>
			item.source?.kind === "plan-step" &&
			item.source.ref.planId === proposal.planId &&
			item.source.ref.planRevision === proposal.revision &&
			item.source.ref.stepId === stepId,
	);
	if (linked.length === 0) return "Todo: missing linked execution item.";
	const statuses = linked.map((item) => `${item.content} [${item.status}]`).join(", ");
	return `Todo: ${statuses}`;
}

function joinRevisionTodo(context: ExtensionContext, proposal: PlanProposalV1): string {
	const todo = foldTodoSnapshots(context.sessionManager.getBranch());
	const linked = todo.todos.filter(
		(item) =>
			item.source?.kind === "plan-step" &&
			item.source.ref.planId === proposal.planId &&
			item.source.ref.planRevision === proposal.revision,
	);
	const byStep = new Map<string, string>();
	for (const item of linked) {
		if (item.source?.kind === "plan-step") byStep.set(item.source.ref.stepId, item.status);
	}
	const stepLines = proposal.steps.map((step) => `${step.title} [${byStep.get(step.stepId) ?? "missing"}]`);
	const discovered = todo.todos
		.filter((item) => item.source === undefined)
		.map((item) => `${item.content} [${item.status}]`);
	const lines = ["Todo projection (Todo is the authority):", ...stepLines];
	if (discovered.length > 0) lines.push("", `Discovered (unlinked) Todos: ${discovered.join(", ")}`);
	return lines.join("\n");
}
