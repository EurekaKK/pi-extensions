import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type ContextManagementConfigV1, type FileMutationQueue, initializeContextManagementConfig } from "./config.js";
import { STATUS_COMMAND } from "./constants.js";
import { ContextCoordinator } from "./runtime/coordinator.js";
import { createRuntimeState, type RuntimeState } from "./runtime/state.js";
import { renderContextStatus } from "./runtime/status.js";
import { maybeSpillToolResult } from "./spill.js";

export interface LoadContextManagementDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

function notify(context: ExtensionContext, message: string, type: "info" | "warning" | "error" = "warning"): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(message, type);
	} catch {
		// Advisory UI only.
	}
}

export function registerContextManagementExtension(
	pi: ExtensionAPI,
	config: ContextManagementConfigV1,
	dependencies: LoadContextManagementDependencies,
): RuntimeState {
	const state = createRuntimeState();
	const coordinator = new ContextCoordinator(pi, state, config);

	pi.registerCommand(STATUS_COMMAND, {
		description: "Show context budget, compaction, and prune status",
		async handler(_argumentsText, context) {
			notify(context, renderContextStatus(state, context), "info");
		},
	});

	pi.on("session_start", (_event, context) => {
		coordinator.sessionStart(context);
	});
	pi.on("before_agent_start", (event, context) => {
		coordinator.beforeAgentStart(event.prompt, context);
	});
	pi.on("context", (event, context) => coordinator.context(event, context));
	pi.on("agent_end", (event) => coordinator.agentEnd(event));
	pi.on("agent_settled", (_event, context) => coordinator.agentSettled(context));
	pi.on("session_before_compact", (event, context) => coordinator.beforeCompact(event, context));
	pi.on("session_compact", (event, context) => coordinator.sessionCompact(event, context));
	pi.on("session_tree", (_event, context) => coordinator.sessionTree(context));
	pi.on("session_shutdown", (_event, context) => coordinator.shutdown(context));
	pi.on("tool_result", async (event, context) => {
		try {
			return await maybeSpillToolResult({
				event,
				sessionId: context.sessionManager.getSessionId(),
				agentDir: dependencies.agentDir,
				maxInlineBytes: config.spill.maxInlineBytes,
				withFileMutationQueue: dependencies.withFileMutationQueue,
			});
		} catch {
			return undefined;
		}
	});
	return state;
}

function registerDisabledContextManagement(pi: ExtensionAPI, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	let shown = false;
	pi.on("session_start", (_event, context) => {
		if (shown || !context.hasUI) return;
		shown = true;
		notify(context, `context-management is disabled: ${message}`);
	});
}

export async function loadContextManagementExtension(
	pi: ExtensionAPI,
	dependencies: LoadContextManagementDependencies,
): Promise<void> {
	try {
		const initialized = await initializeContextManagementConfig(dependencies);
		registerContextManagementExtension(pi, initialized.config, dependencies);
	} catch (error) {
		registerDisabledContextManagement(pi, error);
	}
}

export default async function contextManagement(pi: ExtensionAPI): Promise<void> {
	await loadContextManagementExtension(pi, {
		agentDir: getAgentDir(),
		withFileMutationQueue,
	});
}

export { DEFAULT_CONFIG } from "./config.js";
export type { ContextManagementConfigV1 };
