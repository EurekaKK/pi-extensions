import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STATUS_COMMAND } from "./constants.js";
import { registerEvidenceTool } from "./evidence/tool.js";
import { registerMemoryTools } from "./memory/tools.js";
import { ContextCoordinator } from "./runtime/coordinator.js";
import { createRuntimeState } from "./runtime/state.js";
import { renderContextStatus } from "./runtime/status.js";

export function registerContextManagementExtension(pi: ExtensionAPI): void {
	const state = createRuntimeState();
	const coordinator = new ContextCoordinator(pi, state);

	registerMemoryTools(pi, state.memory);
	registerEvidenceTool(pi, state.evidence);

	pi.registerCommand(STATUS_COMMAND, {
		description: "Show context budget, compaction, evidence, and repository-memory status",
		async handler(_argumentsText, context) {
			context.ui.notify(renderContextStatus(state, context), "info");
		},
	});

	pi.on("session_start", async (_event, context) => {
		try {
			await coordinator.sessionStart(context);
		} catch (error) {
			if (context.mode === "tui") {
				context.ui.notify(`Context management started without Repository Memory: ${String(error)}`, "warning");
			}
		}
	});
	pi.on("before_agent_start", async (event, context) => {
		await coordinator.beforeAgentStart(event.prompt, context);
	});
	pi.on("context", (event, context) => coordinator.context(event, context));
	pi.on("agent_end", (event) => coordinator.agentEnd(event));
	pi.on("agent_settled", (_event, context) => coordinator.agentSettled(context));
	pi.on("session_before_compact", (event, context) => coordinator.beforeCompact(event, context));
	pi.on("session_compact", (event, context) => coordinator.sessionCompact(event, context));
	pi.on("session_tree", (_event, context) => coordinator.sessionTree(context));
	pi.on("session_shutdown", (_event, context) => coordinator.shutdown(context));
}

export default registerContextManagementExtension;
