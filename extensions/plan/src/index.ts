import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { hasCommittedHandoff } from "todo-protocol";
import { executePlanCommand, type PlanCommandRuntime } from "./commands.js";
import { type FileMutationQueue, initializePlanConfig, type PlanConfigV1 } from "./config.js";
import {
	PLAN_COMMAND_NAME,
	PLAN_FLAG_NAME,
	PLAN_KICKOFF_MESSAGE_TYPE,
	PLAN_PROPOSAL_CARD_MESSAGE_TYPE,
	PLAN_REVISE_REQUEST_MESSAGE_TYPE,
	PLAN_START_MESSAGE_TYPE,
	PLAN_STATUS_KEY,
} from "./constants.js";
import type { PlanProposalV1 } from "./domain.js";
import { PlanGate } from "./gate.js";
import { renderPlanMessage } from "./message-renderer.js";
import { registerReviewFlow } from "./review.js";
import { PlanService } from "./service.js";
import { registerPlanTools } from "./tools.js";

export interface LoadPlanDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

interface PlanSessionState {
	sessionId: string;
	effectiveCompleteNotified: boolean;
	fallbackNotified: boolean;
	invalidEntriesNotified: boolean;
}

function notify(context: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(message, level);
	} catch {
		// Advisory UI only.
	}
}

export function registerPlanExtension(pi: ExtensionAPI, config: PlanConfigV1): void {
	const service = new PlanService({ pi });
	const gate = new PlanGate(pi, config);
	let currentContext: ExtensionContext | undefined;
	let sessionState: PlanSessionState | undefined;
	let pendingReview: { readonly planId: string; readonly revision: number } | undefined;
	let planningArmed = false;
	let flagWarningShown = false;

	function projectFooter(context: ExtensionContext): void {
		const state = service.state(context);
		if (state.active === undefined) {
			clearFooter(context);
			return;
		}
		const phase = state.active.phase.toUpperCase().replace("_", " ");
		const ref = `${state.active.planId}${state.active.revision === undefined ? "" : ` · r${state.active.revision}`}`;
		const label = `PLAN · ${phase} · ${ref} · workspace mutations blocked`;
		if (!context.hasUI) return;
		try {
			context.ui.setStatus(PLAN_STATUS_KEY, label);
		} catch {
			// Advisory UI only.
		}
	}

	function clearFooter(context: ExtensionContext): void {
		if (!context.hasUI) return;
		try {
			context.ui.setStatus(PLAN_STATUS_KEY, undefined);
		} catch {
			// Advisory UI only.
		}
	}

	function applyGateIfNeeded(context: ExtensionContext): void {
		const state = service.state(context);
		if (state.active !== undefined && !gate.active) {
			// 恢复或续跑时按当前 runtime 的活动工具快照重新建立门禁。
			gate.apply(context);
		}
	}

	/** 每个 session 最多一次：跳过形状损坏的当前版本 plan:change 条目时给出 sanitized 警告。 */
	function warnAboutInvalidEntries(context: ExtensionContext): void {
		if (sessionState === undefined || sessionState.invalidEntriesNotified) return;
		if (!service.state(context).foundInvalid) return;
		sessionState.invalidEntriesNotified = true;
		notify(
			context,
			"Skipped malformed Plan entries on this branch; valid history remains usable. (one-time notice)",
			"warning",
		);
	}

	function reconcileActiveWorkflow(context: ExtensionContext): void {
		const state = service.state(context);
		const active = state.active;
		if (active === undefined) {
			gate.restore();
			gate.reset();
			clearFooter(context);
			return;
		}
		if (active.phase === "handoff_pending" && active.handoffId !== undefined) {
			if (hasCommittedHandoff(context.sessionManager.getBranch(), active.handoffId)) {
				// 崩溃窗口恢复：Todo 已提交但缺少 handoff-complete。视为已生效完成，
				// 不自动重发 kickoff，不自动启动执行。
				gate.restore();
				gate.reset();
				clearFooter(context);
				if (
					sessionState?.sessionId === context.sessionManager.getSessionId() &&
					!sessionState.effectiveCompleteNotified
				) {
					sessionState.effectiveCompleteNotified = true;
					notify(
						context,
						"Plan handoff was already committed before the workflow closed; execution is ready. Continue with a direct message.",
						"info",
					);
				}
				return;
			}
		}
		applyGateIfNeeded(context);
		projectFooter(context);
	}

	const runtime: PlanCommandRuntime = {
		pi,
		service,
		gate,
		applyGateIfNeeded,
		projectFooter,
		clearFooter,
		notify,
	};

	pi.registerFlag(PLAN_FLAG_NAME, {
		description: "Start in Planning Mode; pass the objective as a positional message before the flag",
		type: "boolean",
		default: false,
	});

	pi.registerCommand(PLAN_COMMAND_NAME, {
		description: "Start, show, approve, revise, cancel, or retry the Plan workflow",
		async handler(argumentsText, commandContext: ExtensionCommandContext) {
			currentContext = commandContext;
			try {
				const text = await executePlanCommand(runtime, argumentsText, commandContext);
				notify(commandContext, text, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(commandContext, message, "error");
			}
		},
	});

	registerPlanTools(pi, {
		pi,
		service,
		onSubmitted(proposal: PlanProposalV1) {
			pendingReview = { planId: proposal.planId, revision: proposal.revision };
			if (currentContext !== undefined) {
				projectFooter(currentContext);
			}
		},
	});

	for (const customType of [
		PLAN_START_MESSAGE_TYPE,
		PLAN_PROPOSAL_CARD_MESSAGE_TYPE,
		PLAN_REVISE_REQUEST_MESSAGE_TYPE,
		PLAN_KICKOFF_MESSAGE_TYPE,
	]) {
		pi.registerMessageRenderer(customType, (message, options, theme) =>
			renderPlanMessage(
				customType,
				{ content: typeof message.content === "string" ? message.content : "", details: message.details },
				options,
				theme,
			),
		);
	}

	gate.registerGuard(pi);
	registerReviewFlow(
		pi,
		runtime,
		() => pendingReview,
		() => {
			pendingReview = undefined;
		},
	);

	pi.on("before_agent_start", (_event, context) => {
		if (!planningArmed) return;
		planningArmed = false;
		currentContext = context;
		const objective = (
			typeof _event.prompt === "string" && _event.prompt.trim().length > 0 ? _event.prompt : "untitled planning request"
		).slice(0, 400);
		try {
			service.start(context, objective);
			applyGateIfNeeded(context);
			projectFooter(context);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(context, `Could not start Planning Mode: ${message}`, "error");
		}
	});

	pi.on("session_start", (_event, context) => {
		currentContext = context;
		pendingReview = undefined;
		const sessionId = context.sessionManager.getSessionId();
		sessionState = {
			sessionId,
			effectiveCompleteNotified: false,
			fallbackNotified: false,
			invalidEntriesNotified: false,
		};
		warnAboutInvalidEntries(context);
		if (pi.getFlag(PLAN_FLAG_NAME) === true) {
			const active = service.state(context).active;
			if (active !== undefined) {
				// 分支已有活动工作流（恢复会话）：--plan 不启动新 workflow；
				// 按当前 runtime 重放既有门禁，保持 fail-closed 的变更封锁。
				reconcileActiveWorkflow(context);
				if (!flagWarningShown && context.hasUI) {
					flagWarningShown = true;
					notify(
						context,
						`An active Planning Workflow (${active.phase}) exists on this branch; --plan will not start another. The existing gate is restored.`,
						"warning",
					);
				}
				return;
			}
			planningArmed = true;
			if (!flagWarningShown && context.hasUI) {
				flagWarningShown = true;
				notify(context, "Planning Mode armed for the first direct prompt (--plan).", "info");
			}
			return;
		}
		reconcileActiveWorkflow(context);
	});

	pi.on("session_tree", (_event, context) => {
		currentContext = context;
		pendingReview = undefined;
		if (sessionState?.sessionId !== context.sessionManager.getSessionId()) {
			sessionState = {
				sessionId: context.sessionManager.getSessionId(),
				effectiveCompleteNotified: false,
				fallbackNotified: false,
				invalidEntriesNotified: false,
			};
		}
		warnAboutInvalidEntries(context);
		reconcileActiveWorkflow(context);
	});

	pi.on("session_shutdown", (_event, context) => {
		gate.restore();
		gate.reset();
		pendingReview = undefined;
		planningArmed = false;
		clearFooter(context);
		currentContext = undefined;
		sessionState = undefined;
	});
}

function registerDisabledPlan(pi: ExtensionAPI, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	let shown = false;
	pi.on("session_start", (_event, context) => {
		if (shown || !context.hasUI) return;
		shown = true;
		notify(context, `plan is disabled: ${message}`, "warning");
	});
}

export async function loadPlan(pi: ExtensionAPI, dependencies: LoadPlanDependencies): Promise<void> {
	try {
		const initialized = await initializePlanConfig(dependencies);
		registerPlanExtension(pi, initialized.config);
	} catch (error) {
		registerDisabledPlan(pi, error);
	}
}

export default async function plan(pi: ExtensionAPI): Promise<void> {
	await loadPlan(pi, {
		agentDir: getAgentDir(),
		withFileMutationQueue,
	});
}

export type { PlanConfigV1 };
