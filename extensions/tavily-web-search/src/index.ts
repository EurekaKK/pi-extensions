import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SourceInfo,
	type ToolInfo,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { TavilyBudgetLedger, TavilyLedgerCorruptionError } from "./budgets.js";
import { ConfigurationError, loadOrCreateConfig } from "./config.js";
import { EXTENSION_ID, OPEN_TOOL_NAME, SEARCH_TOOL_NAME, TAVILY_TOOL_NAMES } from "./constants.js";
import { disabledError, type TavilyTool } from "./errors.js";
import {
	createTavilyToolDefinitions,
	recoverRefsFromBranch,
	type TavilyCircuitState,
	type TavilyToolExecutors,
	TavilyToolService,
} from "./tools.js";
import type { RefRecord, TavilyWebSearchConfig } from "./types.js";

const DEFAULTS_CONFIG_PATH = fileURLToPath(new URL("../defaults/config.json", import.meta.url));
const PACKAGE_ENTRY_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));

type PairState = "both" | "neither" | "xor";
type GuardResult = "ok" | "inactive" | "incomplete" | "collision" | "disabled";
type CircuitReason = "auth" | "quota" | "credit";

interface SourceFingerprint {
	readonly path: string;
	readonly source: string;
	readonly scope: SourceInfo["scope"];
	readonly origin: SourceInfo["origin"];
	readonly baseDir?: string;
}

interface RuntimeState {
	enabled: boolean;
	toolsRegistered: boolean;
	startupSnapshotReady: boolean;
	generation: number;
	activationIntent: boolean;
	service: TavilyToolService | undefined;
	budget: TavilyBudgetLedger | undefined;
	config: TavilyWebSearchConfig | undefined;
	apiKey: string | undefined;
	owner: SourceFingerprint | undefined;
	context: ExtensionContext | undefined;
	ownershipFailed: boolean;
	abortPendingRun: boolean;
	readonly notifiedConfigPaths: Set<string>;
	readonly notices: Set<string>;
}

export interface TavilyExtensionDependencies {
	readonly getAgentDir: () => string;
	readonly defaultsConfigPath: string;
	readonly withFileMutationQueue: <T>(path: string, mutation: () => Promise<T>) => Promise<T>;
	readonly fetch: typeof globalThis.fetch;
	readonly now: () => number;
	readonly randomId: () => string;
	readonly readApiKey: () => string | undefined;
	readonly retryEnabled: boolean;
	readonly extensionSourcePath: string;
}

const DEFAULT_DEPENDENCIES: TavilyExtensionDependencies = Object.freeze({
	getAgentDir,
	defaultsConfigPath: DEFAULTS_CONFIG_PATH,
	withFileMutationQueue,
	fetch: globalThis.fetch,
	now: Date.now,
	randomId: randomUUID,
	readApiKey: () => process.env.TAVILY_API_KEY,
	retryEnabled: true,
	extensionSourcePath: PACKAGE_ENTRY_PATH,
});

/**
 * Register the extension lifecycle. The factory intentionally performs no I/O,
 * reads no credential, and does not register either tool before session_start.
 */
export function registerTavilyWebSearch(
	pi: ExtensionAPI,
	dependencies: TavilyExtensionDependencies = DEFAULT_DEPENDENCIES,
): void {
	const runtime: RuntimeState = {
		enabled: false,
		toolsRegistered: false,
		startupSnapshotReady: false,
		generation: 0,
		activationIntent: false,
		service: undefined,
		budget: undefined,
		config: undefined,
		apiKey: undefined,
		owner: undefined,
		context: undefined,
		ownershipFailed: false,
		abortPendingRun: false,
		notifiedConfigPaths: new Set(),
		notices: new Set(),
	};

	const executors: TavilyToolExecutors = {
		executeSearch: async (input, signal) => executableService("search").executeSearch(input, signal),
		executeOpen: async (input, signal) => executableService("open").executeOpen(input, signal),
	};
	const [searchDefinition, openDefinition] = createTavilyToolDefinitions(executors);

	function executableService(tool: TavilyTool): TavilyToolService {
		const result = checkRuntimeInvariant();
		if (result !== "ok" || runtime.service === undefined) throw disabledError(tool);
		return runtime.service;
	}

	function checkRuntimeInvariant(): GuardResult {
		if (!runtime.enabled) {
			if (activePairState(pi.getActiveTools()) !== "neither") {
				removeTavilyFromActiveSet();
				return "incomplete";
			}
			return "disabled";
		}
		if (!validateVisibleOwnership()) {
			disableForCollision(true);
			return "collision";
		}
		const pair = activePairState(pi.getActiveTools());
		if (pair === "xor") {
			removeTavilyFromActiveSet();
			notifyOnce("incomplete-pair", "The Tavily tool pair was incomplete, so both tools were disabled.", "warning");
			return "incomplete";
		}
		return pair === "both" ? "ok" : "inactive";
	}

	function validateVisibleOwnership(): boolean {
		const visible = canonicalToolInfos(pi.getAllTools());
		for (const info of visible) {
			if (!sourceBelongsToExtension(info.sourceInfo, dependencies.extensionSourcePath)) return false;
			const fingerprint = fingerprintSource(info.sourceInfo);
			if (runtime.owner === undefined) runtime.owner = fingerprint;
			else if (!sameFingerprint(runtime.owner, fingerprint)) return false;
		}
		return true;
	}

	function validateRegistration(name: string): void {
		const info = pi.getAllTools().find((candidate) => candidate.name === name);
		if (info === undefined) return;
		if (!sourceBelongsToExtension(info.sourceInfo, dependencies.extensionSourcePath)) {
			throw safeInitializationError(`canonical tool ownership could not be verified for ${name}`);
		}
		const fingerprint = fingerprintSource(info.sourceInfo);
		if (runtime.owner === undefined) runtime.owner = fingerprint;
		else if (!sameFingerprint(runtime.owner, fingerprint)) {
			throw safeInitializationError("the Tavily tool definitions have different owners");
		}
	}

	function disableForCollision(abortRun: boolean): void {
		removeTavilyFromActiveSet();
		runtime.enabled = false;
		runtime.ownershipFailed = true;
		runtime.generation += 1;
		runtime.service?.shutdown();
		runtime.service = undefined;
		runtime.budget = undefined;
		runtime.startupSnapshotReady = false;
		runtime.config = undefined;
		runtime.apiKey = undefined;
		const context = runtime.context;
		if (context?.hasUI) {
			context.ui.setStatus(EXTENSION_ID, `${EXTENSION_ID}: disabled`);
			notifyOnce(
				"ownership-collision",
				"Tavily web search was disabled because a canonical tool name is owned by another source.",
				"error",
			);
		}
		if (abortRun) context?.abort();
	}

	function notifyOnce(key: string, message: string, level: "info" | "warning" | "error"): void {
		if (runtime.notices.has(key)) return;
		runtime.notices.add(key);
		const context = runtime.context;
		if (context?.hasUI) context.ui.notify(message, level);
	}

	function removeTavilyFromActiveSet(): string[] {
		const active = pi.getActiveTools();
		const baseline = active.filter((name) => !isTavilyToolName(name));
		if (baseline.length !== active.length) pi.setActiveTools(baseline);
		return baseline;
	}

	function createBranchState(
		config: TavilyWebSearchConfig,
		apiKey: string,
		context: ExtensionContext,
		generation: number,
	): {
		readonly budget: TavilyBudgetLedger;
		readonly service: TavilyToolService;
		readonly refs: readonly RefRecord[];
	} {
		const branch = context.sessionManager.getBranch();
		const recovered = recoverRefsFromBranch(branch, config);
		const circuitEpoch = sessionCircuit.epoch;
		const budget = new TavilyBudgetLedger({
			limits: config.budgets,
			currentBranch: branch,
			randomId: dependencies.randomId,
			appendEntry: (customType, data) => {
				if (runtime.generation !== generation || !runtime.startupSnapshotReady) {
					throw new Error("The Tavily lifecycle changed before ledger persistence.");
				}
				pi.appendEntry(customType, data);
			},
		});
		const service = new TavilyToolService({
			config,
			apiKey,
			budget,
			dependencies: {
				fetch: dependencies.fetch,
				now: dependencies.now,
				randomId: dependencies.randomId,
				retryEnabled: dependencies.retryEnabled,
			},
			generation,
			initialRefs: recovered.refs,
			initialNextRef: recovered.nextRef,
			circuitState: {
				read: () => (sessionCircuit.epoch === circuitEpoch ? sessionCircuit.reason : "credit"),
				open: (reason) => {
					if (
						sessionCircuit.epoch !== circuitEpoch ||
						runtime.generation !== generation ||
						runtime.service !== service ||
						sessionCircuit.reason !== "none"
					) {
						return;
					}
					sessionCircuit.reason = reason;
					showCircuitState(reason, true);
				},
			} satisfies TavilyCircuitState,
		});
		return { budget, service, refs: recovered.refs };
	}

	function showCircuitState(reason: CircuitReason, notify: boolean): void {
		const context = runtime.context;
		if (!context?.hasUI) return;
		const label = reason;
		context.ui.setStatus(EXTENSION_ID, `${EXTENSION_ID}: offline (${label})`);
		if (notify) context.ui.notify(`Tavily web search is offline for this session (${label}).`, "error");
	}

	const sessionCircuit: { reason: "none" | CircuitReason; epoch: number } = { reason: "none", epoch: 0 };

	pi.on("session_start", async (_event, context) => {
		runtime.context = context;
		const previousPair = activePairState(pi.getActiveTools());
		if (runtime.enabled) runtime.activationIntent = previousPair === "both";
		const inactiveBaseline = removeTavilyFromActiveSet();
		runtime.enabled = false;
		runtime.startupSnapshotReady = false;
		runtime.ownershipFailed = false;
		runtime.abortPendingRun = false;
		sessionCircuit.epoch += 1;
		sessionCircuit.reason = "none";
		runtime.generation += 1;
		const generation = runtime.generation;
		runtime.service?.shutdown();
		runtime.service = undefined;
		runtime.budget = undefined;

		let provisionalService: TavilyToolService | undefined;
		try {
			const configPath = join(dependencies.getAgentDir(), EXTENSION_ID, "config.json");
			const loaded = await loadOrCreateConfig(
				configPath,
				dependencies.defaultsConfigPath,
				dependencies.withFileMutationQueue,
			);
			if (runtime.generation !== generation) return;
			if (loaded.created && context.hasUI && !runtime.notifiedConfigPaths.has(configPath)) {
				runtime.notifiedConfigPaths.add(configPath);
				context.ui.notify(`Created Tavily web search config at ${configPath}`, "info");
			}

			const rawApiKey = dependencies.readApiKey();
			if (rawApiKey === undefined || rawApiKey.trim().length === 0) {
				throw safeInitializationError("TAVILY_API_KEY is missing or empty; restart Pi after setting it");
			}
			const apiKey = rawApiKey;

			// Mark the generation restorable before constructing its ledger so only
			// this generation may append entries after initialization commits.
			runtime.startupSnapshotReady = true;
			const branchState = createBranchState(loaded.config, apiKey, context, generation);
			provisionalService = branchState.service;

			const visibleCanonical = canonicalToolInfos(pi.getAllTools());
			if (!runtime.toolsRegistered && visibleCanonical.length > 0) {
				throw safeInitializationError("a canonical Tavily tool name is already registered");
			}
			if (runtime.toolsRegistered && !validateVisibleOwnership()) {
				throw safeInitializationError("canonical Tavily tool ownership changed");
			}

			const pending = new Set<string>();
			if (runtime.toolsRegistered) {
				if (runtime.activationIntent) {
					pending.add(SEARCH_TOOL_NAME);
					pending.add(OPEN_TOOL_NAME);
				}
			} else {
				// Pi has no unregister or atomic batch registration. All predictable
				// failures are above this synchronous barrier; a host mutation-then-throw
				// fault can only be contained by restoring the inactive baseline.
				pi.registerTool(searchDefinition);
				if (pi.getActiveTools().includes(SEARCH_TOOL_NAME)) pending.add(SEARCH_TOOL_NAME);
				pi.setActiveTools(inactiveBaseline);
				validateRegistration(SEARCH_TOOL_NAME);

				pi.registerTool(openDefinition);
				if (pi.getActiveTools().includes(OPEN_TOOL_NAME)) pending.add(OPEN_TOOL_NAME);
				pi.setActiveTools(inactiveBaseline);
				validateRegistration(OPEN_TOOL_NAME);
				runtime.toolsRegistered = true;
			}

			if (runtime.generation !== generation) {
				provisionalService.shutdown();
				return;
			}
			runtime.config = loaded.config;
			runtime.apiKey = apiKey;
			runtime.budget = branchState.budget;
			runtime.service = provisionalService;
			provisionalService = undefined;
			runtime.enabled = true;
			runtime.activationIntent = pending.has(SEARCH_TOOL_NAME) && pending.has(OPEN_TOOL_NAME);
			if (runtime.activationIntent) pi.setActiveTools([...inactiveBaseline, ...TAVILY_TOOL_NAMES]);
			else {
				pi.setActiveTools(inactiveBaseline);
				if (pending.size === 1) {
					notifyOnce(
						"startup-incomplete-pair",
						"Only one Tavily tool was allowed by the host, so the capability remains inactive.",
						"warning",
					);
				}
			}
			if (activePairState(pi.getActiveTools()) === "xor") {
				removeTavilyFromActiveSet();
				runtime.activationIntent = false;
				notifyOnce(
					"startup-commit-incomplete",
					"The host could not activate the complete Tavily tool pair, so both tools remain inactive.",
					"warning",
				);
			}
			if (context.hasUI) context.ui.setStatus(EXTENSION_ID, undefined);
		} catch (error) {
			provisionalService?.shutdown();
			if (runtime.generation !== generation) return;
			pi.setActiveTools(inactiveBaseline);
			runtime.enabled = false;
			runtime.startupSnapshotReady = false;
			runtime.service = undefined;
			runtime.budget = undefined;
			runtime.config = undefined;
			runtime.apiKey = undefined;
			const sanitized = sanitizeInitializationFailure(error);
			if (context.hasUI) {
				context.ui.setStatus(EXTENSION_ID, `${EXTENSION_ID}: disabled`);
				context.ui.notify(sanitized.message, "error");
			}
			throw sanitized;
		}
	});

	pi.on("session_shutdown", (_event, context) => {
		runtime.context = context;
		removeTavilyFromActiveSet();
		runtime.enabled = false;
		runtime.startupSnapshotReady = false;
		runtime.abortPendingRun = false;
		runtime.generation += 1;
		runtime.service?.shutdown();
		runtime.service = undefined;
		runtime.budget = undefined;
		runtime.config = undefined;
		runtime.apiKey = undefined;
		if (context.hasUI) context.ui.setStatus(EXTENSION_ID, undefined);
	});

	pi.on("session_tree", async (_event, context) => {
		runtime.context = context;
		if (
			!runtime.toolsRegistered ||
			!runtime.startupSnapshotReady ||
			runtime.config === undefined ||
			runtime.apiKey === undefined
		) {
			removeTavilyFromActiveSet();
			runtime.enabled = false;
			runtime.generation += 1;
			runtime.service?.shutdown();
			runtime.service = undefined;
			runtime.budget = undefined;
			return;
		}
		if (runtime.enabled) runtime.activationIntent = activePairState(pi.getActiveTools()) === "both";
		const inactiveBaseline = removeTavilyFromActiveSet();
		runtime.enabled = false;
		runtime.generation += 1;
		const generation = runtime.generation;
		runtime.service?.shutdown();
		runtime.service = undefined;
		runtime.budget = undefined;

		let provisionalService: TavilyToolService | undefined;
		try {
			if (runtime.ownershipFailed || !validateVisibleOwnership()) {
				throw safeInitializationError("canonical Tavily tool ownership changed");
			}
			const branchState = createBranchState(runtime.config, runtime.apiKey, context, generation);
			provisionalService = branchState.service;
			if (runtime.generation !== generation) {
				provisionalService.shutdown();
				return;
			}
			runtime.budget = branchState.budget;
			runtime.service = provisionalService;
			provisionalService = undefined;
			runtime.enabled = true;
			if (runtime.activationIntent) pi.setActiveTools([...inactiveBaseline, ...TAVILY_TOOL_NAMES]);
			else pi.setActiveTools(inactiveBaseline);
			if (activePairState(pi.getActiveTools()) === "xor") {
				removeTavilyFromActiveSet();
				notifyOnce(
					"branch-incomplete-pair",
					"The complete Tavily tool pair could not be restored on this branch, so both tools remain inactive.",
					"warning",
				);
			}
			if (sessionCircuit.reason === "none") {
				if (context.hasUI) context.ui.setStatus(EXTENSION_ID, undefined);
			} else {
				showCircuitState(sessionCircuit.reason, false);
			}
		} catch (error) {
			provisionalService?.shutdown();
			if (runtime.generation !== generation) return;
			pi.setActiveTools(inactiveBaseline);
			runtime.enabled = false;
			runtime.service = undefined;
			runtime.budget = undefined;
			const sanitized = sanitizeInitializationFailure(error);
			if (context.hasUI) {
				context.ui.setStatus(EXTENSION_ID, `${EXTENSION_ID}: disabled`);
				context.ui.notify(sanitized.message, "error");
			}
			throw sanitized;
		}
	});

	pi.on("input", (_event, context) => {
		runtime.context = context;
		runtime.abortPendingRun = false;
		const result = checkRuntimeInvariant();
		if (result === "collision") {
			// Pi emits input before it creates Agent.activeRun, so ctx.abort() from
			// disableForCollision() is not sufficient at this barrier. Preserve the
			// decision until agent_start, where abort can stop the provider run.
			runtime.abortPendingRun = true;
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", (_event, context) => {
		runtime.context = context;
		const result = checkRuntimeInvariant();
		if (result === "collision") {
			// A collision disables the runtime and must cancel this provider run.
			// An xor-active pair is different: setActiveTools() synchronously
			// rebuilds Pi's base prompt at this barrier, so it can safely continue
			// with both Tavily definitions and prompt text absent.
			runtime.abortPendingRun = true;
			context.abort();
		}
	});

	pi.on("agent_start", async (_event, context) => {
		runtime.context = context;
		if (runtime.abortPendingRun) {
			runtime.abortPendingRun = false;
			context.abort();
			return;
		}
		const result = checkRuntimeInvariant();
		if (result === "collision" || result === "incomplete") {
			context.abort();
			return;
		}
		if (runtime.enabled) await runtime.budget?.onAgentStart();
	});

	pi.on("agent_settled", async (_event, context) => {
		runtime.context = context;
		runtime.abortPendingRun = false;
		await runtime.budget?.onAgentSettled();
	});

	pi.on("turn_start", async (_event, context) => {
		runtime.context = context;
		const result = checkRuntimeInvariant();
		if (result === "collision" || result === "incomplete") {
			context.abort();
			return;
		}
		if (runtime.enabled) await runtime.budget?.onTurnStart();
	});
}

function activePairState(activeTools: readonly string[]): PairState {
	const search = activeTools.includes(SEARCH_TOOL_NAME);
	const open = activeTools.includes(OPEN_TOOL_NAME);
	if (search && open) return "both";
	if (!search && !open) return "neither";
	return "xor";
}

function canonicalToolInfos(tools: readonly ToolInfo[]): ToolInfo[] {
	return tools.filter((tool) => isTavilyToolName(tool.name));
}

function isTavilyToolName(name: string): boolean {
	return name === SEARCH_TOOL_NAME || name === OPEN_TOOL_NAME;
}

function fingerprintSource(source: SourceInfo): SourceFingerprint {
	return {
		path: source.path,
		source: source.source,
		scope: source.scope,
		origin: source.origin,
		...(source.baseDir === undefined ? {} : { baseDir: source.baseDir }),
	};
}

function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
	return (
		left.path === right.path &&
		left.source === right.source &&
		left.scope === right.scope &&
		left.origin === right.origin &&
		left.baseDir === right.baseDir
	);
}

function sourceBelongsToExtension(source: SourceInfo, expectedSourcePath: string): boolean {
	const expectedFile = canonicalFilesystemPath(expectedSourcePath);
	const expectedDirectory = canonicalFilesystemPath(dirname(expectedSourcePath));
	const sourcePath = canonicalFilesystemPath(source.path);
	const sourceBase = source.baseDir === undefined ? undefined : canonicalFilesystemPath(source.baseDir);
	return sourcePath === expectedFile || sourcePath === expectedDirectory || sourceBase === expectedDirectory;
}

function canonicalFilesystemPath(path: string): string {
	if (path.startsWith("<") && path.endsWith(">")) return path;
	const absolute = isAbsolute(path) ? resolve(path) : resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function safeInitializationError(reason: string): Error {
	return new Error(`Tavily web search initialization failed: ${reason}.`);
}

function sanitizeInitializationFailure(error: unknown): Error {
	if (error instanceof ConfigurationError || error instanceof TavilyLedgerCorruptionError) {
		return safeInitializationError(error.message);
	}
	if (error instanceof Error && error.message.startsWith("Tavily web search initialization failed:")) return error;
	return safeInitializationError("an internal initialization check failed");
}

export default registerTavilyWebSearch;
