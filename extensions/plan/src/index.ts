import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
	PROGRESS_WIDGET_ATTACH_EVENT,
	PROGRESS_WIDGET_RELEASE_EVENT,
	PROGRESS_WIDGET_STATE_EVENT,
	type ProgressWidgetPlanStateV1,
	parseProgressWidgetAttach,
	parseProgressWidgetRelease,
} from "progress-widget-protocol";
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
} from "./constants.js";
import { PlanGate } from "./gate.js";
import { renderPlanMessage } from "./message-renderer.js";
import { PlanService } from "./service.js";
import { registerPlanTools } from "./tools.js";
import { tryProjectPlanWidget } from "./widget.js";

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
	let attachedSessionId: string | undefined;
	let planningArmed = false;
	let flagWarningShown = false;

	function readPlanProjection(context: ExtensionContext): ProgressWidgetPlanStateV1 | null {
		const active = service.state(context).active;
		if (active === undefined) return null;
		return {
			planId: active.planId,
			phase: active.phase,
			...(active.revision === undefined ? {} : { revision: active.revision }),
		};
	}

	function projectStatus(context: ExtensionContext): void {
		currentContext = context;
		try {
			const sessionId = context.sessionManager.getSessionId();
			const plan = readPlanProjection(context);
			if (attachedSessionId === sessionId) {
				tryProjectPlanWidget(context, null);
				pi.events.emit(PROGRESS_WIDGET_STATE_EVENT, {
					version: 1,
					source: "plan",
					sessionId,
					plan,
				});
				return;
			}
			tryProjectPlanWidget(context, plan);
		} catch {
			// Advisory UI projection and branch reads must not change Plan semantics.
		}
	}

	function clearStatus(context: ExtensionContext): void {
		try {
			const sessionId = context.sessionManager.getSessionId();
			tryProjectPlanWidget(context, null);
			if (attachedSessionId === sessionId) {
				pi.events.emit(PROGRESS_WIDGET_STATE_EVENT, {
					version: 1,
					source: "plan",
					sessionId,
					plan: null,
				});
			}
		} catch {
			// Advisory UI projection must not change Plan transitions.
		}
	}

	pi.events.on(PROGRESS_WIDGET_ATTACH_EVENT, (value) => {
		const attached = parseProgressWidgetAttach(value);
		if (attached === null) return;
		attachedSessionId = attached.sessionId;
		if (currentContext?.sessionManager.getSessionId() === attached.sessionId) projectStatus(currentContext);
	});

	pi.events.on(PROGRESS_WIDGET_RELEASE_EVENT, (value) => {
		const released = parseProgressWidgetRelease(value);
		if (released === null || attachedSessionId !== released.sessionId) return;
		attachedSessionId = undefined;
		if (currentContext?.sessionManager.getSessionId() === released.sessionId) projectStatus(currentContext);
	});

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
			clearStatus(context);
			return;
		}
		if (active.phase === "handoff_pending" && active.handoffId !== undefined) {
			if (hasCommittedHandoff(context.sessionManager.getBranch(), active.handoffId)) {
				// 崩溃窗口恢复：Todo 已提交但缺少 handoff-complete。视为已生效完成，
				// 不自动重发 kickoff，不自动启动执行。
				gate.restore();
				gate.reset();
				clearStatus(context);
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
		projectStatus(context);
	}

	const runtime: PlanCommandRuntime = {
		pi,
		service,
		gate,
		applyGateIfNeeded,
		projectStatus,
		clearStatus,
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
		onSubmitted() {
			if (currentContext !== undefined) projectStatus(currentContext);
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
			projectStatus(context);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(context, `Could not start Planning Mode: ${message}`, "error");
		}
	});

	pi.on("session_start", (_event, context) => {
		currentContext = context;
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
		planningArmed = false;
		tryProjectPlanWidget(context, null);
		attachedSessionId = undefined;
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
