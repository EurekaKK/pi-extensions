import { join } from "node:path";
import {
	type FileMutationQueue,
	hasExactKeys,
	initializeStrictConfig,
	isRecord,
	MAX_CONFIG_BYTES,
	StrictConfigError,
	type StrictConfigResult,
} from "config-store";
import {
	BUILT_IN_TOOL_NAMES,
	type BuiltInToolName,
	DISPLAY_MODES,
	type DisplayMode,
	type EurekaUiConfigV1,
	isBuiltInToolName,
	isDisplayMode,
	type ToolDisplayConfig,
} from "./domain.js";

export const CONFIG_DIRECTORY_NAME = "eureka-ui";
export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_VERSION = 1;

export type { FileMutationQueue };
export { MAX_CONFIG_BYTES, StrictConfigError };

export interface InitializeEurekaUiConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export type InitializedEurekaUiConfig = StrictConfigResult<EurekaUiConfigV1>;

const DEFAULT_TOOL_MODES: Readonly<Record<BuiltInToolName, DisplayMode>> = Object.freeze({
	read: "hidden",
	bash: "line",
	powershell: "native",
	edit: "line",
	write: "line",
	grep: "hidden",
	find: "hidden",
	ls: "hidden",
});

function defaultTools(): Readonly<Record<BuiltInToolName, ToolDisplayConfig>> {
	const tools: Partial<Record<BuiltInToolName, ToolDisplayConfig>> = {};
	for (const name of BUILT_IN_TOOL_NAMES) {
		tools[name] = Object.freeze({ mode: DEFAULT_TOOL_MODES[name] });
	}
	return Object.freeze(tools) as Readonly<Record<BuiltInToolName, ToolDisplayConfig>>;
}

export const DEFAULT_CONFIG: EurekaUiConfigV1 = Object.freeze({
	version: CONFIG_VERSION,
	tools: defaultTools(),
});

export const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

function fail(configPath: string, message: string): never {
	throw new StrictConfigError(configPath, message, "invalid");
}

function validateToolConfig(value: unknown, name: BuiltInToolName, configPath: string): ToolDisplayConfig {
	const field = `tools.${name}`;
	if (!isRecord(value) || !hasExactKeys(value, ["mode"])) {
		fail(configPath, `${field} must contain exactly mode`);
	}
	const mode = value.mode;
	if (typeof mode !== "string" || !isDisplayMode(mode)) {
		fail(configPath, `${field}.mode must be one of ${DISPLAY_MODES.join(", ")}`);
	}
	return Object.freeze({ mode });
}

export function validateEurekaUiConfig(value: unknown, configPath: string): EurekaUiConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "tools"])) {
		fail(configPath, "config must contain exactly version and tools");
	}
	if (value.version !== CONFIG_VERSION) {
		fail(configPath, `version must equal ${CONFIG_VERSION}`);
	}
	const rawTools = value.tools;
	if (!isRecord(rawTools) || !hasExactKeys(rawTools, [...BUILT_IN_TOOL_NAMES])) {
		fail(configPath, `tools must contain exactly ${BUILT_IN_TOOL_NAMES.join(", ")}`);
	}
	const tools: Partial<Record<BuiltInToolName, ToolDisplayConfig>> = {};
	for (const key of Object.keys(rawTools)) {
		if (!isBuiltInToolName(key)) fail(configPath, `tools.${key} is not a built-in tool`);
		tools[key] = validateToolConfig(rawTools[key], key, configPath);
	}
	return Object.freeze({ version: CONFIG_VERSION, tools: Object.freeze(tools) as EurekaUiConfigV1["tools"] });
}

export function getEurekaUiConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

export function initializeEurekaUiConfig(options: InitializeEurekaUiConfigOptions): Promise<InitializedEurekaUiConfig> {
	return initializeStrictConfig({
		agentDir: options.agentDir,
		directoryName: CONFIG_DIRECTORY_NAME,
		fileName: CONFIG_FILE_NAME,
		defaultText: DEFAULT_CONFIG_TEXT,
		validate: validateEurekaUiConfig,
		withFileMutationQueue: options.withFileMutationQueue,
	});
}
