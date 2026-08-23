import { join } from "node:path";
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
import { createPiChildSessionFactory } from "./child-session.js";
import { type FileMutationQueue, initializeSubAgentConfig } from "./config.js";
import {
	CHILD_SESSIONS_DIRECTORY_NAME,
	DESCRIPTOR_ENTRY_TYPE,
	REPORT_MESSAGE_TYPE,
	SETTLEMENT_MESSAGE_TYPE,
} from "./constants.js";
import type { SubAgentConfigV2, SubAgentDescriptorV1 } from "./domain.js";
import { renderSubagentMessage } from "./message-renderer.js";
import { SubagentManager, type SubagentUiEntry } from "./runtime.js";
import { registerParentTools } from "./tools.js";
import { tryProjectSubagentWidget } from "./widget.js";

export interface LoadSubAgentDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

interface SessionRuntimeState {
	manager: SubagentManager | undefined;
	sessionId: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function parseDescriptor(value: unknown): Pick<SubAgentDescriptorV1, "depth"> | null {
	if (!isRecord(value) || value.version !== 1) return null;
	if (typeof value.parentSessionId !== "string" || value.parentSessionId.length === 0) return null;
	if (!Number.isSafeInteger(value.depth) || typeof value.depth !== "number" || value.depth < 0) return null;
	return { depth: value.depth };
}

function readDescriptor(context: ExtensionContext): Pick<SubAgentDescriptorV1, "depth"> | null {
	let latest: Pick<SubAgentDescriptorV1, "depth"> | null = null;
	try {
		for (const entry of context.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== DESCRIPTOR_ENTRY_TYPE) continue;
			const parsed = parseDescriptor(entry.data);
			if (parsed !== null) latest = parsed;
		}
	} catch {
		return null;
	}
	return latest;
}

function forkBoundary(context: ExtensionContext): string | undefined {
	try {
		const branch = context.sessionManager.getBranch();
		let lastUserIndex = -1;
		for (const [index, entry] of branch.entries()) {
			if (entry.type === "message" && entry.message.role === "user") lastUserIndex = index;
		}
		return branch[lastUserIndex - 1]?.id;
	} catch {
		return undefined;
	}
}

function notify(context: ExtensionContext, message: string): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(message, "warning");
	} catch {
		// Advisory UI only.
	}
}

export function registerSubAgent(pi: ExtensionAPI, config: SubAgentConfigV2): void {
	const state: SessionRuntimeState = { manager: undefined, sessionId: undefined };
	let currentContext: ExtensionContext | undefined;
	let attachedSessionId: string | undefined;
	let currentAgents: readonly SubagentUiEntry[] = Object.freeze([]);

	function projectAgents(context: ExtensionContext, agents: readonly SubagentUiEntry[]): void {
		currentContext = context;
		currentAgents = agents;
		const sessionId = context.sessionManager.getSessionId();
		if (attachedSessionId === sessionId) {
			tryProjectSubagentWidget(context, []);
			pi.events.emit(PROGRESS_WIDGET_STATE_EVENT, {
				version: 1,
				source: "sub-agent",
				sessionId,
				agents: agents.map((agent) => ({
					id: agent.childId,
					description: agent.label,
					status: agent.status,
				})),
			});
			return;
		}
		tryProjectSubagentWidget(context, agents);
	}

	pi.events.on(PROGRESS_WIDGET_ATTACH_EVENT, (value) => {
		const attached = parseProgressWidgetAttach(value);
		if (attached === null) return;
		attachedSessionId = attached.sessionId;
		if (currentContext?.sessionManager.getSessionId() === attached.sessionId) {
			projectAgents(currentContext, currentAgents);
		}
	});

	pi.events.on(PROGRESS_WIDGET_RELEASE_EVENT, (value) => {
		const released = parseProgressWidgetRelease(value);
		if (released === null || attachedSessionId !== released.sessionId) return;
		attachedSessionId = undefined;
		if (currentContext?.sessionManager.getSessionId() === released.sessionId) {
			projectAgents(currentContext, currentAgents);
		}
	});

	pi.registerMessageRenderer(REPORT_MESSAGE_TYPE, (message, options, theme) =>
		renderSubagentMessage(REPORT_MESSAGE_TYPE, message, options, theme),
	);
	pi.registerMessageRenderer(SETTLEMENT_MESSAGE_TYPE, (message, options, theme) =>
		renderSubagentMessage(SETTLEMENT_MESSAGE_TYPE, message, options, theme),
	);

	function ensureManager(context: ExtensionContext): SubagentManager {
		const sessionId = context.sessionManager.getSessionId();
		if (state.manager !== undefined && state.sessionId === sessionId) return state.manager;

		const descriptor = readDescriptor(context);
		const model = context.model;
		if (model === undefined) throw new Error("sub-agent requires an active model");
		const manager = new SubagentManager({
			config,
			pi,
			childFactory: createPiChildSessionFactory(context),
			ownerSessionId: sessionId,
			cwd: context.cwd,
			depth: descriptor?.depth ?? 0,
			...(context.sessionManager.getSessionFile() === undefined
				? {}
				: { parentSessionFile: context.sessionManager.getSessionFile() }),
			parentModel: { provider: model.provider, id: model.id },
			parentThinkingLevel: context.thinkingLevel ?? pi.getThinkingLevel(),
			parentToolNames: pi.getActiveTools(),
			childSessionDir: join(getAgentDir(), CHILD_SESSIONS_DIRECTORY_NAME, sessionId),
			getForkBoundary: () => forkBoundary(context),
			onStateChanged(agents) {
				projectAgents(currentContext ?? context, agents);
			},
		});
		state.manager = manager;
		state.sessionId = sessionId;
		return manager;
	}

	pi.on("session_start", async (_event, context) => {
		state.sessionId = undefined;
		const previous = state.manager;
		state.manager = undefined;
		if (previous !== undefined) await previous.shutdown();
		currentContext = context;
		currentAgents = Object.freeze([]);
		projectAgents(context, currentAgents);
	});

	pi.on("session_shutdown", async (_event, context) => {
		state.sessionId = undefined;
		const previous = state.manager;
		state.manager = undefined;
		if (previous !== undefined) await previous.shutdown();
		tryProjectSubagentWidget(context, []);
		currentContext = undefined;
		currentAgents = Object.freeze([]);
		attachedSessionId = undefined;
	});

	registerParentTools(
		pi,
		{
			manager(context) {
				return ensureManager(context);
			},
		},
		config,
	);
}

function registerDisabledSubAgent(pi: ExtensionAPI, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	let warningShown = false;
	pi.on("session_start", (_event, context) => {
		if (warningShown || !context.hasUI) return;
		warningShown = true;
		notify(context, `sub-agent is disabled: ${message}`);
	});
}

export async function loadSubAgent(pi: ExtensionAPI, dependencies: LoadSubAgentDependencies): Promise<void> {
	try {
		const initialized = await initializeSubAgentConfig(dependencies);
		registerSubAgent(pi, initialized.config);
	} catch (error) {
		registerDisabledSubAgent(pi, error);
	}
}

export default async function subAgent(pi: ExtensionAPI): Promise<void> {
	await loadSubAgent(pi, {
		agentDir: getAgentDir(),
		withFileMutationQueue,
	});
}

export type { SubAgentConfigV2 };
