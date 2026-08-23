import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
	PROGRESS_WIDGET_ATTACH_EVENT,
	PROGRESS_WIDGET_RELEASE_EVENT,
	PROGRESS_WIDGET_STATE_EVENT,
	parseProgressWidgetAttach,
	parseProgressWidgetRelease,
} from "progress-widget-protocol";
import { executeGoalCommand } from "./commands.js";
import { type FileMutationQueue, type GoalConfigV1, initializeGoalConfig } from "./config.js";
import { GoalDriver } from "./driver.js";
import { renderGoalRoundMessage } from "./message-renderer.js";
import { GoalService } from "./service.js";
import { registerGoalTools } from "./tools.js";
import { tryProjectGoalWidget } from "./widget.js";

export interface LoadGoalDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

function notify(context: ExtensionContext, message: string): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(message, "info");
	} catch {
		// Advisory UI only.
	}
}

export function registerGoalExtension(pi: ExtensionAPI, config: GoalConfigV1): void {
	const service = new GoalService(pi, config.defaultMaxGoalRounds);
	let currentContext: ExtensionContext | undefined;
	let attachedSessionId: string | undefined;

	function projectStatus(context: ExtensionContext): void {
		currentContext = context;
		try {
			const goal = service.get(context);
			const sessionId = context.sessionManager.getSessionId();
			if (attachedSessionId === sessionId) {
				tryProjectGoalWidget(context, undefined);
				pi.events.emit(PROGRESS_WIDGET_STATE_EVENT, {
					version: 1,
					source: "goal",
					sessionId,
					goal:
						goal === undefined
							? null
							: {
									id: goal.id,
									objective: goal.objective,
									phase: goal.phase,
									roundsStarted: goal.roundsStarted,
									maxGoalRounds: goal.maxGoalRounds,
									activation: goal.activation,
									...(goal.blockedReason === undefined
										? {}
										: {
												blockedReason: {
													code: goal.blockedReason.code,
													message: goal.blockedReason.message,
												},
											}),
								},
				});
				return;
			}
			tryProjectGoalWidget(context, goal);
		} catch {
			// UI projection and branch-read failures must not change Goal semantics.
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

	const driver = new GoalDriver(pi, service, {
		onSettled: (context) => projectStatus(context),
	});

	pi.registerMessageRenderer("goal:round", renderGoalRoundMessage);

	pi.registerCommand("goal", {
		description: "Create, edit, pause, resume, clear, or view the same-session goal",
		async handler(argumentsText, context) {
			const text = executeGoalCommand(service, context, argumentsText);
			notify(context, text);
			projectStatus(context);
		},
	});

	registerGoalTools(pi, {
		service,
		config,
		onChanged(context) {
			projectStatus(context);
		},
		authority(context) {
			return driver.authority(context);
		},
	});

	pi.on("session_start", (_event, context) => {
		currentContext = context;
		service.disarm(context.sessionManager.getSessionId());
		projectStatus(context);
	});

	pi.on("session_tree", (_event, context) => {
		currentContext = context;
		service.disarm(context.sessionManager.getSessionId());
		projectStatus(context);
	});

	pi.on("session_shutdown", (_event, context) => {
		tryProjectGoalWidget(context, undefined);
		currentContext = undefined;
		attachedSessionId = undefined;
	});
}

function registerDisabledGoal(pi: ExtensionAPI, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	let shown = false;
	pi.on("session_start", (_event, context) => {
		if (shown || !context.hasUI) return;
		shown = true;
		notify(context, `goal is disabled: ${message}`);
	});
}

export async function loadGoal(pi: ExtensionAPI, dependencies: LoadGoalDependencies): Promise<void> {
	try {
		const initialized = await initializeGoalConfig(dependencies);
		registerGoalExtension(pi, initialized.config);
	} catch (error) {
		registerDisabledGoal(pi, error);
	}
}

export default async function goal(pi: ExtensionAPI): Promise<void> {
	await loadGoal(pi, {
		agentDir: getAgentDir(),
		withFileMutationQueue,
	});
}

export type { GoalConfigV1 };
