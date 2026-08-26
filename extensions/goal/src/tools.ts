import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { GoalConfigV1 } from "./config.js";
import { GoalError, type GoalRef, type GoalView } from "./domain.js";
import { goalPolicyGuideline } from "./prompts.js";
import type { GoalService } from "./service.js";

export type GoalToolAuthority =
	| { readonly kind: "direct-human" }
	| { readonly kind: "goal-round"; readonly goal: GoalView };

export interface GoalToolRuntime {
	readonly service: GoalService;
	readonly config: GoalConfigV1;
	onChanged(context: ExtensionContext): void;
	authority(context: ExtensionContext): GoalToolAuthority;
}

function goalRef(goalId: string, revision: number): GoalRef {
	if (goalId.length === 0 || goalId !== goalId.trim() || !Number.isSafeInteger(revision) || revision < 1) {
		throw new GoalError(
			"goal_id must be non-empty and revision must be a positive safe integer",
			"GOAL_TOOL_INVALID_UPDATE",
		);
	}
	return { id: goalId, revision };
}

function goalValue(goal: GoalView | undefined) {
	if (goal === undefined) return { goal: null };
	return {
		goal: {
			id: goal.id,
			revision: goal.revision,
			objective: goal.objective,
			phase: goal.phase,
			roundsStarted: goal.roundsStarted,
			maxGoalRounds: goal.maxGoalRounds,
			...(goal.blockedReason === undefined
				? {}
				: { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } }),
		},
		activation: goal.activation,
	};
}

function resultFor(goal: GoalView | undefined) {
	const value = goalValue(goal);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: value,
	};
}

function mutationResult(runtime: GoalToolRuntime, context: ExtensionContext, goal: GoalView) {
	runtime.onChanged(context);
	return Promise.resolve(resultFor(goal));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultText(result: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
	return result.content
		.filter(
			(block): block is { readonly type: "text"; readonly text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function compactGoalLines(details: unknown): string[] | null {
	if (!isRecord(details) || !("goal" in details)) return null;
	if (details.goal === null) return ["No goal is currently set."];
	if (!isRecord(details.goal) || typeof details.activation !== "string") return null;
	const goal = details.goal;
	if (
		typeof goal.objective !== "string" ||
		typeof goal.phase !== "string" ||
		typeof goal.roundsStarted !== "number" ||
		typeof goal.maxGoalRounds !== "number"
	)
		return null;
	let blocker = "";
	if (isRecord(goal.blockedReason) && typeof goal.blockedReason.code === "string") {
		blocker = ` · ${goal.blockedReason.code}`;
	}
	const mark = goal.phase === "complete" ? "✓" : goal.phase === "blocked" ? "!" : goal.phase === "paused" ? "Ⅱ" : "◐";
	return [
		`Goal · ${goal.phase} · round ${goal.roundsStarted}/${goal.maxGoalRounds} · ${details.activation}${blocker}`,
		`${mark} ${goal.objective}`,
	];
}

class BoundedLinesComponent implements Component {
	readonly #lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	render(width: number): string[] {
		return this.#lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {}
}

function renderGoalResult(
	result: {
		readonly content: readonly { readonly type: string; readonly text?: string }[];
		readonly details?: unknown;
	},
	expanded: boolean,
	theme: Theme,
	isError: boolean,
): Component {
	const raw = resultText(result);
	if (isError) {
		if (expanded) return new Text(theme.fg("error", raw), 0, 0);
		return new BoundedLinesComponent([theme.fg("error", raw.split("\n", 1)[0] ?? "Goal operation failed")]);
	}
	if (expanded) return new Text(theme.fg("text", raw), 0, 0);
	const compact = compactGoalLines(result.details);
	return new BoundedLinesComponent(
		(compact ?? [raw]).map((line) => theme.fg(compact === null ? "muted" : "success", line)),
	);
}

export function registerGoalTools(pi: { registerTool(tool: unknown): void }, runtime: GoalToolRuntime): void {
	const promptGuidelines = [goalPolicyGuideline(runtime.config.blockedAfterConsecutiveRounds)];
	pi.registerTool(
		defineTool({
			name: "get_goal",
			label: "Get goal",
			description:
				"Read the current same-session goal, including its exact id/revision, objective, phase, completed continuation rounds, round limit, blocker reason when present, and whether another continuation is armed. Call this before updating a goal.",
			parameters: Type.Object({}, { additionalProperties: false }),
			promptGuidelines,
			execute(_toolCallId, _parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				return Promise.resolve(resultFor(runtime.service.get(context)));
			},
			renderCall(_args, theme) {
				return new BoundedLinesComponent([theme.fg("toolTitle", theme.bold("get_goal"))]);
			},
			renderResult(result, { expanded }, theme, context) {
				return renderGoalResult(result, expanded, theme, context.isError);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "create_goal",
			label: "Create goal",
			description:
				"Create one persisted same-session completion goal only when the current direct human request explicitly asks to create or use Goal. Never infer Goal intent from task length, complexity, number of steps, or suitability for autonomous rounds. User /goal commands are handled directly without this tool.",
			parameters: Type.Object(
				{
					objective: Type.String(),
					max_goal_rounds: Type.Optional(Type.Integer({ minimum: 1 })),
				},
				{ additionalProperties: false },
			),
			promptGuidelines,
			execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				runtime.authority(context);
				const view = runtime.service.create(context, parameters.objective, parameters.max_goal_rounds);
				return mutationResult(runtime, context, view);
			},
			renderCall(args, theme) {
				const objective = args.objective.trim();
				return new BoundedLinesComponent([
					`${theme.fg("toolTitle", theme.bold("create_goal"))}${objective.length === 0 ? "" : ` ${theme.fg("muted", `· ${objective}`)}`}`,
				]);
			},
			renderResult(result, { expanded }, theme, context) {
				return renderGoalResult(result, expanded, theme, context.isError);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "update_goal",
			label: "Update goal",
			description:
				"Update the exact current goal revision. edit, pause, and resume require a direct top-level human request. During an automatic continuation of the current goal, complete and blocked are also allowed.",
			parameters: Type.Object(
				{
					goal_id: Type.String(),
					revision: Type.Integer({ minimum: 1 }),
					action: StringEnum(["edit", "pause", "resume", "complete", "blocked"] as const),
					objective: Type.Optional(Type.String()),
					max_goal_rounds: Type.Optional(Type.Integer({ minimum: 1 })),
					blocked_reason: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
			promptGuidelines,
			execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const authority = runtime.authority(context);
				const ref = goalRef(parameters.goal_id, parameters.revision);
				const hasObjective = parameters.objective !== undefined && parameters.objective !== "";
				const hasRounds = parameters.max_goal_rounds !== undefined && parameters.max_goal_rounds !== 0;
				const hasReason = parameters.blocked_reason !== undefined && parameters.blocked_reason !== "";

				if (parameters.action === "edit") {
					if (authority.kind !== "direct-human") {
						throw new GoalError("this goal operation requires a direct human turn");
					}
					if (hasReason) {
						throw new GoalError("blocked_reason is valid only with action blocked", "GOAL_TOOL_INVALID_UPDATE");
					}
					const view = runtime.service.edit(
						context,
						ref,
						hasObjective ? parameters.objective : undefined,
						hasRounds ? parameters.max_goal_rounds : undefined,
					);
					return mutationResult(runtime, context, view);
				}

				if (parameters.action === "pause" || parameters.action === "resume") {
					if (authority.kind !== "direct-human") {
						throw new GoalError("this goal operation requires a direct human turn");
					}
					if (hasObjective || hasRounds || hasReason) {
						throw new GoalError(
							"objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked",
							"GOAL_TOOL_INVALID_UPDATE",
						);
					}
					const view =
						parameters.action === "pause" ? runtime.service.pause(context, ref) : runtime.service.resume(context, ref);
					return mutationResult(runtime, context, view);
				}

				if (hasObjective || hasRounds) {
					throw new GoalError(
						"objective and max_goal_rounds are valid only with action edit",
						"GOAL_TOOL_INVALID_UPDATE",
					);
				}
				if (parameters.action === "complete") {
					if (hasReason) {
						throw new GoalError("blocked_reason is valid only with action blocked", "GOAL_TOOL_INVALID_UPDATE");
					}
					return mutationResult(runtime, context, runtime.service.complete(context, ref));
				}
				if (!hasReason)
					throw new GoalError("blocked_reason is required with action blocked", "GOAL_TOOL_INVALID_UPDATE");
				if (
					authority.kind === "goal-round" &&
					authority.goal.roundsStarted < runtime.config.blockedAfterConsecutiveRounds
				) {
					throw new GoalError(
						`blocked requires at least ${runtime.config.blockedAfterConsecutiveRounds} consecutive goal rounds; current round is ${authority.goal.roundsStarted}`,
						"GOAL_TOOL_BLOCK_THRESHOLD",
					);
				}
				const view = runtime.service.block(context, ref, {
					code: "model-reported",
					message: parameters.blocked_reason as string,
				});
				return mutationResult(runtime, context, view);
			},
			renderCall(args, theme) {
				return new BoundedLinesComponent([
					`${theme.fg("toolTitle", theme.bold("update_goal"))} ${theme.fg("muted", `· ${args.action}`)}`,
				]);
			},
			renderResult(result, { expanded }, theme, context) {
				return renderGoalResult(result, expanded, theme, context.isError);
			},
		}),
	);
}
