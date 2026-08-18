import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GoalConfigV1 } from "./config.js";
import { GoalError, type GoalRef, type GoalView } from "./domain.js";
import { GOAL_POLICY_GUIDELINE } from "./prompts.js";
import type { GoalService } from "./service.js";

export type GoalToolAuthority =
	| { readonly kind: "direct-human" }
	| { readonly kind: "goal-round"; readonly goal: GoalView };

export interface GoalToolRuntime {
	readonly service: GoalService;
	readonly config: GoalConfigV1;
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

export function registerGoalTools(pi: { registerTool(tool: unknown): void }, runtime: GoalToolRuntime): void {
	pi.registerTool(
		defineTool({
			name: "get_goal",
			label: "Get goal",
			description:
				"Read the current same-session goal, including its exact id/revision, objective, phase, completed continuation rounds, round limit, blocker reason when present, and whether another continuation is armed. Call this before updating a goal.",
			parameters: Type.Object({}, { additionalProperties: false }),
			promptGuidelines: [GOAL_POLICY_GUIDELINE],
			execute(_toolCallId, _parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				return Promise.resolve(resultFor(runtime.service.get(context)));
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "create_goal",
			label: "Create goal",
			description:
				"Create one persisted same-session completion goal when the current direct human request is a long-running objective that should continue across autonomous goal rounds. You may infer that intent without requiring the user to say 'create a goal'. Do not use this for trivial single-turn work.",
			parameters: Type.Object(
				{
					objective: Type.String(),
					max_goal_rounds: Type.Optional(Type.Integer({ minimum: 1 })),
				},
				{ additionalProperties: false },
			),
			promptGuidelines: [GOAL_POLICY_GUIDELINE],
			execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				runtime.authority(context);
				const view = runtime.service.create(context, parameters.objective, parameters.max_goal_rounds);
				return Promise.resolve(resultFor(view));
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
			promptGuidelines: [GOAL_POLICY_GUIDELINE],
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
					return Promise.resolve(resultFor(view));
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
					return Promise.resolve(resultFor(view));
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
					return Promise.resolve(resultFor(runtime.service.complete(context, ref)));
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
				return Promise.resolve(resultFor(view));
			},
		}),
	);
}
