import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { MemoryWriteAuthority } from "./authority.js";
import { type FileMutationQueue, initializeMemoryConfig, type MemoryConfigV1 } from "./config.js";
import { MEMORY_STATUS_COMMAND } from "./constants.js";
import { registerMemoryForgetCommand, registerMemoryForgetTool } from "./forget.js";
import { registerMemoryReadCommand, registerMemoryReadTool } from "./read.js";
import { MemoryRecall, registerRecallMessageRenderer } from "./recall.js";
import { registerMemoryListCommand, registerMemorySearchCommand, registerMemorySearchTool } from "./search.js";
import { MemoryService } from "./service.js";
import { buildMemoryStatusReport, renderMemoryStatusFailure } from "./status.js";
import type { MemoryStoreFs } from "./store-io.js";
import { registerMemoryWriteTool } from "./write.js";

export interface LoadMemoryDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
	/** Filesystem boundary for fault-injection through the loaded extension seam. */
	readonly storeFs?: MemoryStoreFs;
}

export interface RegisterMemoryDependencies {
	readonly withFileMutationQueue: FileMutationQueue;
	readonly storeFs?: MemoryStoreFs;
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
 * Register the #7 + #8 + #9 + #10 + #11 + #12 surface: foreground `memory_write`
 * (add and auditable supersede), exact `memory_read` plus the `memory-read`
 * command, bounded ranked `memory_search` plus the `memory-search` and
 * `memory-list` commands, direct-human-authorized `memory_forget` plus the
 * `memory-forget` command, the read-only diagnostics command, and automatic
 * Memory Recall (`memory:recall-receipt`) before each eligible direct human
 * run. All Store behavior shares ONE validated Store service; every write and
 * forget is bounded by the SAME withFileMutationQueue transaction, and
 * search/list/read/recall exercise read-only paths with no write authority.
 */
export function registerMemoryExtension(
	pi: ExtensionAPI,
	config: MemoryConfigV1,
	dependencies: RegisterMemoryDependencies = { withFileMutationQueue },
): void {
	const service = new MemoryService({
		config,
		withFileMutationQueue: dependencies.withFileMutationQueue,
		...(dependencies.storeFs === undefined ? {} : { fs: dependencies.storeFs }),
	});
	const authority = new MemoryWriteAuthority(pi, config);
	new MemoryRecall(pi, {
		config,
		service,
		onMessagePrepared: (content) => authority.expectRecallMessage(content),
	});
	registerRecallMessageRenderer(pi);

	registerMemoryWriteTool(pi, { service, authority });
	registerMemoryForgetTool(pi, { service, authority });
	registerMemoryReadTool(pi, service);
	registerMemoryReadCommand(pi, service);
	registerMemorySearchTool(pi, { service, charBudget: config.recall.maxChars });
	registerMemorySearchCommand(pi, { service, charBudget: config.recall.maxChars });
	registerMemoryListCommand(pi, { service, charBudget: config.recall.maxChars });
	registerMemoryForgetCommand(pi, { service });

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
		registerMemoryExtension(pi, initialized.config, {
			withFileMutationQueue: dependencies.withFileMutationQueue,
			...(dependencies.storeFs === undefined ? {} : { storeFs: dependencies.storeFs }),
		});
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
