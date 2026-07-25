import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	type AgentToolResult,
	DefaultPackageManager,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getPackageDir,
	SettingsManager,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "../sidecar/protocol.js";
import { initializeConfig } from "./config.js";
import {
	cancelTransportSchema,
	createErrorResult,
	createSuccessResult,
	InputValidationError,
	isErrorCodeForOperation,
	killTransportSchema,
	listTransportSchema,
	type ManagementErrorCodeV1,
	type OperationV1,
	prepareCancelArguments,
	prepareKillArguments,
	prepareListArguments,
	prepareSendArguments,
	prepareSpawnArguments,
	prepareWaitArguments,
	SUBAGENT_TOOL_NAMES,
	sendTransportSchema,
	spawnTransportSchema,
	TOOL_DESCRIPTIONS,
	validateCancelInput,
	validateKillInput,
	validateListInput,
	validateSendInput,
	validateSpawnInput,
	validateWaitInput,
	waitTransportSchema,
} from "./contracts.js";
import {
	canonicalizeCandidateExtensionPaths,
	ManagerOperationError,
	type ManagerToolResult,
	type ParentRuntimeSnapshot,
	SubagentManager,
} from "./manager.js";
import { buildParentTransientStatus } from "./prompts.js";

const STATUS_KEY = "sub-agent";
const SELF_EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type ToolResult = AgentToolResult<unknown> & { isError: boolean };

interface SessionRuntime {
	mode: ExtensionContext["mode"] | undefined;
	context: ExtensionContext | undefined;
	manager: SubagentManager | undefined;
	startupError:
		| {
				code: ManagementErrorCodeV1;
				message: string;
		  }
		| undefined;
	configPath: string | undefined;
	configError: string | undefined;
	projectContextCaptured: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSettings(
	globalSettings: Record<string, unknown>,
	projectSettings: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...globalSettings, ...projectSettings };
	for (const key of Object.keys(merged)) {
		const globalValue = globalSettings[key];
		const projectValue = projectSettings[key];
		if (isPlainRecord(globalValue) && isPlainRecord(projectValue)) {
			merged[key] = { ...globalValue, ...projectValue };
		}
	}
	return merged;
}

function toJsonObject(value: unknown): JsonObject {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return {};
	const parsed: unknown = JSON.parse(serialized);
	return isPlainRecord(parsed) ? (parsed as JsonObject) : {};
}

function currentParentSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	projectContext: Array<{ path: string; content: string }>,
	candidateExtensionPaths: string[],
	parentToolSources: Array<{ name: string; path?: string }>,
): ParentRuntimeSnapshot {
	const model = ctx.model;
	const thinking = pi.getThinkingLevel();
	return {
		model: {
			provider: typeof model?.provider === "string" ? model.provider : "",
			id: typeof model?.id === "string" ? model.id : "",
		},
		thinkingLevel: THINKING_LEVELS.has(thinking) ? (thinking as ParentRuntimeSnapshot["thinkingLevel"]) : "off",
		projectContext: projectContext.map((entry) => ({ ...entry })),
		candidateExtensionPaths: [...candidateExtensionPaths],
		parentToolNames: pi.getAllTools().map((tool) => tool.name),
		parentToolSources: parentToolSources.map((source) => ({ ...source })),
		parentActiveToolNames: pi.getActiveTools(),
	};
}

async function discoverCandidates(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settingsManager: SettingsManager,
): Promise<{
	paths: string[];
	toolSources: Array<{ name: string; path?: string }>;
}> {
	const packageManager = new DefaultPackageManager({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager,
	});
	const resolved = await packageManager.resolve(async () => "skip");
	const rawPaths = resolved.extensions.filter((extension) => extension.enabled).map((extension) => extension.path);
	for (const tool of pi.getAllTools()) rawPaths.push(tool.sourceInfo.path);
	for (const command of pi.getCommands()) {
		if (command.source === "extension") rawPaths.push(command.sourceInfo.path);
	}
	const paths = await canonicalizeCandidateExtensionPaths(rawPaths, SELF_EXTENSION_PATH);
	const toolSources = await Promise.all(
		pi.getAllTools().map(async (tool) => {
			try {
				return { name: tool.name, path: await realpath(tool.sourceInfo.path) };
			} catch {
				return { name: tool.name };
			}
		}),
	);
	return { paths, toolSources };
}

function branchHasToolResult(ctx: ExtensionContext, toolCallId: string): boolean {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!isPlainRecord(entry) || entry.type !== "message" || !isPlainRecord(entry.message)) continue;
		if (entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId) return true;
	}
	return false;
}

function desiredIsError(details: unknown): boolean | undefined {
	if (!isPlainRecord(details) || details.schemaVersion !== 1 || typeof details.operation !== "string") {
		return undefined;
	}
	if ("code" in details && typeof details.code === "string") return true;
	if (details.operation === "wait" && details.status === "DELIVERED" && Array.isArray(details.deliveries)) {
		return details.deliveries.some((delivery) => isPlainRecord(delivery) && delivery.outcome !== "RESULT");
	}
	return false;
}

function startupManager(runtime: SessionRuntime, operation: OperationV1): SubagentManager {
	if (runtime.mode !== "tui") {
		throw new ManagerOperationError("SUBAGENT_UNSUPPORTED_MODE");
	}
	if (runtime.startupError) {
		throw new ManagerOperationError(runtime.startupError.code, {}, runtime.startupError.message);
	}
	if (!runtime.manager) {
		throw new ManagerOperationError(
			operation === "spawn" ? "SUBAGENT_WORKER_START_FAILED" : "SUBAGENT_PI_API_UNSUPPORTED",
		);
	}
	return runtime.manager;
}

async function executeOperation(
	runtime: SessionRuntime,
	operation: OperationV1,
	action: (manager: SubagentManager) => Promise<ManagerToolResult> | ManagerToolResult,
): Promise<ToolResult> {
	try {
		const result = await action(startupManager(runtime, operation));
		return createSuccessResult(result.details, result.content);
	} catch (error) {
		let code: ManagementErrorCodeV1 = "SUBAGENT_PI_API_UNSUPPORTED";
		let metadata = {};
		if (error instanceof InputValidationError) code = error.code;
		else if (error instanceof ManagerOperationError) {
			code = error.code;
			metadata = error.metadata;
		}
		if (!isErrorCodeForOperation(operation, code)) code = "SUBAGENT_PI_API_UNSUPPORTED";
		return createErrorResult(operation, code, metadata);
	}
}

function resultFromValidation(
	runtime: SessionRuntime,
	operation: OperationV1,
	validateAndRun: (manager: SubagentManager) => Promise<ManagerToolResult> | ManagerToolResult,
): Promise<ToolResult> {
	return executeOperation(runtime, operation, validateAndRun);
}

export function registerSubagent(pi: ExtensionAPI): void {
	const runtime: SessionRuntime = {
		mode: undefined,
		context: undefined,
		manager: undefined,
		startupError: undefined,
		configPath: undefined,
		configError: undefined,
		projectContextCaptured: false,
	};
	let lifecycleGeneration = 0;
	let projectContext: Array<{ path: string; content: string }> = [];
	let candidatePaths: string[] = [];
	let parentToolSources: Array<{ name: string; path?: string }> = [];

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++lifecycleGeneration;
		const previous = runtime.manager;
		runtime.manager = undefined;
		runtime.context = ctx;
		runtime.mode = ctx.mode;
		runtime.startupError = undefined;
		runtime.configError = undefined;
		runtime.projectContextCaptured = false;
		projectContext = [];
		candidatePaths = [];
		parentToolSources = [];
		await previous?.shutdown();
		ctx.ui.setStatus(STATUS_KEY, undefined);

		if (ctx.mode !== "tui") return;
		if (process.platform === "win32") {
			runtime.startupError = {
				code: "SUBAGENT_UNSUPPORTED_PLATFORM",
				message: "The sub-agent sidecar requires POSIX process-group semantics.",
			};
			return;
		}

		try {
			const agentDir = getAgentDir();
			const packageDirValue: unknown = getPackageDir();
			if (typeof packageDirValue !== "string" || packageDirValue.length === 0) {
				throw new ManagerOperationError("SUBAGENT_PI_API_UNSUPPORTED");
			}
			const initialized = await initializeConfig({
				agentDir,
				withFileMutationQueue,
			});
			runtime.configPath = initialized.configPath;
			const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const settingsSnapshot = toJsonObject(
				mergeSettings(
					settingsManager.getGlobalSettings() as unknown as Record<string, unknown>,
					settingsManager.getProjectSettings() as unknown as Record<string, unknown>,
				),
			);
			const candidates = await discoverCandidates(pi, ctx, settingsManager);
			if (generation !== lifecycleGeneration) return;
			candidatePaths = candidates.paths;
			parentToolSources = candidates.toolSources;
			runtime.manager = new SubagentManager({
				cwd: ctx.cwd,
				agentDir,
				piPackageDir: packageDirValue,
				selfExtensionPath: SELF_EXTENSION_PATH,
				settingsSnapshot,
				projectTrusted: ctx.isProjectTrusted(),
				config: initialized.config,
				parent: currentParentSnapshot(pi, ctx, projectContext, candidatePaths, parentToolSources),
			});
			if (initialized.created && ctx.hasUI) {
				ctx.ui.notify(`Created sub-agent config at ${initialized.configPath}`, "info");
			}
		} catch (error) {
			if (generation !== lifecycleGeneration) return;
			const code =
				error instanceof ManagerOperationError
					? error.code
					: error instanceof Error && error.name === "ConfigurationError"
						? "SUBAGENT_CONFIG_INVALID"
						: "SUBAGENT_PI_API_UNSUPPORTED";
			const message = error instanceof Error ? error.message : String(error);
			runtime.startupError = { code, message };
			if (code === "SUBAGENT_CONFIG_INVALID") runtime.configError = message;
			ctx.ui.setStatus(STATUS_KEY, "sub-agent: disabled");
			if (ctx.hasUI) ctx.ui.notify(`sub-agent initialization failed: ${message}`, "error");
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!runtime.projectContextCaptured) {
			runtime.projectContextCaptured = true;
			projectContext = ctx.isProjectTrusted()
				? (event.systemPromptOptions.contextFiles ?? []).map((file) => ({ path: file.path, content: file.content }))
				: [];
		}
		runtime.manager?.updateParentSnapshot(
			currentParentSnapshot(pi, ctx, projectContext, candidatePaths, parentToolSources),
		);
		const status = runtime.manager ? buildParentTransientStatus(runtime.manager.parentTransientSnapshot()) : undefined;
		if (status) {
			return {
				message: {
					customType: "sub-agent-parent-state",
					content: status,
					display: false,
				},
			};
		}
	});

	pi.on("model_select", (_event, ctx) => {
		if (runtime.manager) {
			runtime.manager.updateParentSnapshot(
				currentParentSnapshot(pi, ctx, projectContext, candidatePaths, parentToolSources),
			);
		}
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (runtime.manager) {
			runtime.manager.updateParentSnapshot(
				currentParentSnapshot(pi, ctx, projectContext, candidatePaths, parentToolSources),
			);
		}
	});

	pi.on("tool_result", (event) => {
		if (!SUBAGENT_TOOL_NAMES.some((name) => name === event.toolName)) return;
		const isError = desiredIsError(event.details);
		if (isError === undefined || isError === event.isError) return;
		return { isError };
	});

	pi.on("turn_end", async (event, ctx) => {
		const manager = runtime.manager;
		if (!manager) return;
		const inTurn = new Set(event.toolResults.map((result) => result.toolCallId));
		for (const toolCallId of manager.pendingPersistenceToolCallIds()) {
			if (!inTurn.has(toolCallId)) continue;
			await manager.reconcileWait(toolCallId, branchHasToolResult(ctx, toolCallId));
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const manager = runtime.manager;
		if (!manager) return;
		for (const toolCallId of manager.pendingPersistenceToolCallIds()) {
			await manager.reconcileWait(toolCallId, branchHasToolResult(ctx, toolCallId));
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lifecycleGeneration++;
		const manager = runtime.manager;
		runtime.manager = undefined;
		await manager?.shutdown();
		runtime.context = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerTool({
		name: "subagent_spawn",
		label: "Spawn sub-agent",
		description: TOOL_DESCRIPTIONS.subagent_spawn,
		parameters: spawnTransportSchema,
		prepareArguments: prepareSpawnArguments,
		executionMode: "parallel",
		async execute(_toolCallId, raw, signal) {
			return await resultFromValidation(runtime, "spawn", async (manager) => {
				const input = validateSpawnInput(raw);
				return await manager.spawn(input, signal);
			});
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Send to sub-agent",
		description: TOOL_DESCRIPTIONS.subagent_send,
		parameters: sendTransportSchema,
		prepareArguments: prepareSendArguments,
		executionMode: "parallel",
		async execute(_toolCallId, raw, signal) {
			return await resultFromValidation(runtime, "send", async (manager) => {
				const input = validateSendInput(raw);
				return await manager.send(input, signal);
			});
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for sub-agent",
		description: TOOL_DESCRIPTIONS.subagent_wait,
		parameters: waitTransportSchema,
		prepareArguments: prepareWaitArguments,
		executionMode: "parallel",
		async execute(toolCallId, raw, signal) {
			return await resultFromValidation(runtime, "wait", async (manager) => {
				const input = validateWaitInput(raw);
				try {
					return await manager.wait(input, toolCallId, signal);
				} catch (error) {
					manager.rollbackWait(toolCallId);
					throw error;
				}
			});
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "List sub-agents",
		description: TOOL_DESCRIPTIONS.subagent_list,
		parameters: listTransportSchema,
		prepareArguments: prepareListArguments,
		executionMode: "parallel",
		async execute(_toolCallId, raw) {
			return await resultFromValidation(runtime, "list", (manager) => manager.list(validateListInput(raw)));
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Cancel sub-agent run",
		description: TOOL_DESCRIPTIONS.subagent_cancel,
		parameters: cancelTransportSchema,
		prepareArguments: prepareCancelArguments,
		executionMode: "parallel",
		async execute(_toolCallId, raw, signal) {
			return await resultFromValidation(runtime, "cancel", async (manager) =>
				manager.cancel(validateCancelInput(raw), signal),
			);
		},
	});

	pi.registerTool({
		name: "subagent_kill",
		label: "Kill idle sub-agent",
		description: TOOL_DESCRIPTIONS.subagent_kill,
		parameters: killTransportSchema,
		prepareArguments: prepareKillArguments,
		executionMode: "parallel",
		async execute(_toolCallId, raw, signal) {
			return await resultFromValidation(runtime, "kill", async (manager) =>
				manager.kill(validateKillInput(raw), signal),
			);
		},
	});

	pi.registerCommand("subagent", {
		description: "Inspect or manage sub-agents: list, cancel, kill, config",
		async handler(argumentsText, ctx) {
			const [command, ...args] = argumentsText.trim().split(/\s+/u);
			try {
				if (command === "config") {
					const detail = runtime.configError
						? `${runtime.configPath ?? "<unknown>"}\n${runtime.configError}`
						: (runtime.configPath ?? "Configuration is unavailable in this mode.");
					ctx.ui.notify(detail, runtime.configError ? "error" : "info");
					return;
				}
				const manager = startupManager(runtime, command === "cancel" ? "cancel" : command === "kill" ? "kill" : "list");
				const [agentId, runId] = args;
				if (command === "cancel" && args.length === 2 && agentId && runId) {
					const result = await manager.cancel({
						agentId,
						expectedRunId: runId,
						reason: "Cancelled with /subagent cancel.",
					});
					ctx.ui.notify(result.content, "info");
					return;
				}
				if (command === "kill" && args.length === 2 && agentId && runId) {
					const result = await manager.kill({ agentId, expectedLastRunId: runId });
					ctx.ui.notify(result.content, "info");
					return;
				}
				if (command === "list" || command === "") {
					const result = manager.list({ view: "agents", limit: 16 });
					ctx.ui.notify(JSON.stringify(result.details, null, 2), "info");
					return;
				}
				ctx.ui.notify(
					"Usage: /subagent list | cancel <agentId> <runId> | kill <agentId> <lastRunId> | config",
					"warning",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

export default function subAgent(pi: ExtensionAPI): void {
	registerSubagent(pi);
}
