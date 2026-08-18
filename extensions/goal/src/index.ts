import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { executeGoalCommand } from "./commands.js";
import { type FileMutationQueue, GoalConfigurationError, type GoalConfigV1, initializeGoalConfig } from "./config.js";
import { GOAL_STATUS_KEY } from "./constants.js";
import { GoalDriver } from "./driver.js";
import { renderGoalStatus } from "./prompts.js";
import { GoalService } from "./service.js";
import { registerGoalTools } from "./tools.js";

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

function projectStatus(context: ExtensionContext, service: GoalService): void {
	if (!context.hasUI) return;
	try {
		context.ui.setStatus(GOAL_STATUS_KEY, renderGoalStatus(service.get(context)));
	} catch {
		// Status is advisory.
	}
}

export function registerGoalExtension(pi: ExtensionAPI, config: GoalConfigV1): void {
	const service = new GoalService(pi, config.defaultMaxGoalRounds);
	const driver = new GoalDriver(pi, service);

	pi.registerCommand("goal", {
		description: "Create, edit, pause, resume, clear, or view the same-session goal",
		async handler(argumentsText, context) {
			const text = executeGoalCommand(service, context, argumentsText);
			notify(context, text);
			projectStatus(context, service);
		},
	});

	registerGoalTools(pi, {
		service,
		config,
		authority(context) {
			return driver.authority(context);
		},
	});

	pi.on("session_start", (_event, context) => {
		service.disarm(context.sessionManager.getSessionId());
		driver.resetTurn();
		projectStatus(context, service);
	});

	pi.on("session_tree", (_event, context) => {
		service.disarm(context.sessionManager.getSessionId());
		driver.resetTurn();
		projectStatus(context, service);
	});

	pi.on("session_shutdown", (_event, context) => {
		driver.resetTurn();
		if (context.hasUI) {
			try {
				context.ui.setStatus(GOAL_STATUS_KEY, undefined);
			} catch {
				// Status is advisory.
			}
		}
	});

	pi.on("input", (event) => {
		driver.notifyInput(event.source);
	});

	pi.on("turn_start", () => {
		driver.beginTurn();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "user") driver.observeGoalRoundMessage(event.message.content);
	});

	pi.on("agent_end", (event, context) => {
		driver.handleAgentEnd(event, context);
	});

	pi.on("agent_settled", async (_event, context) => {
		driver.finishRun();
		await driver.maybeDrive(context);
		projectStatus(context, service);
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
export { GoalConfigurationError };
