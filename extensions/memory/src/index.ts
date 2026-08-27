import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type FileMutationQueue, initializeMemoryConfig, type MemoryConfigV1 } from "./config.js";
import { MEMORY_STATUS_COMMAND } from "./constants.js";
import { buildMemoryStatusReport, renderMemoryStatusFailure } from "./status.js";

export interface LoadMemoryDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

function notify(context: ExtensionContext, message: string, type: "info" | "warning" | "error" = "warning"): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(message, type);
	} catch {
		// Advisory UI projection must never change Memory semantics.
	}
}

/**
 * Register the read-only diagnostics surface. In this issue the extension
 * exposes exactly one user command (`memory-status`) and no LLM tools; writes,
 * search/read, and automatic recall arrive in later issues.
 */
export function registerMemoryExtension(pi: ExtensionAPI, config: MemoryConfigV1): void {
	pi.registerCommand(MEMORY_STATUS_COMMAND, {
		description:
			"Report Directory Identity, Store health (never writing), revision, record counts, configured recall budget, and advisory Git tracking state for this Working Directory",
		async handler(_argumentsText, context) {
			try {
				const report = await buildMemoryStatusReport({
					cwd: context.cwd,
					config,
					...(context.signal === undefined ? {} : { signal: context.signal }),
				});
				notify(context, report.text, report.isError ? "error" : "info");
			} catch (error) {
				notify(context, renderMemoryStatusFailure(error), "error");
			}
		},
	});
}

/**
 * Fail-closed disabled registration: no Store behavior, no command, no tool —
 * at most one sanitized warning once a UI exists.
 */
function registerDisabledMemory(pi: ExtensionAPI, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	let shown = false;
	pi.on("session_start", (_event, context) => {
		if (shown || !context.hasUI) return;
		shown = true;
		notify(context, `memory is disabled: ${message}`, "warning");
	});
}

export async function loadMemoryExtension(pi: ExtensionAPI, dependencies: LoadMemoryDependencies): Promise<void> {
	try {
		const initialized = await initializeMemoryConfig(dependencies);
		registerMemoryExtension(pi, initialized.config);
	} catch (error) {
		registerDisabledMemory(pi, error);
	}
}

export default async function memory(pi: ExtensionAPI): Promise<void> {
	await loadMemoryExtension(pi, {
		agentDir: getAgentDir(),
		withFileMutationQueue,
	});
}

export { DEFAULT_CONFIG } from "./config.js";
export type { MemoryConfigV1 };
