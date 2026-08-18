import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SubAgentConfigV2, SubagentDelegationToolConfigV2 } from "./domain.js";

export const CONFIG_DIRECTORY_NAME = "sub-agent";
export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_VERSION = 2;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const CONFIG_DIRECTORY_MODE = 0o700;
export const CONFIG_FILE_MODE = 0o600;

export type FileMutationQueue = <T>(filePath: string, mutation: () => Promise<T>) => Promise<T>;

export interface InitializeSubAgentConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export interface InitializedSubAgentConfig {
	readonly configDir: string;
	readonly configPath: string;
	readonly config: SubAgentConfigV2;
	readonly created: boolean;
}

const THINKING_LEVELS = new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

const DEFAULT_AGENT_OPTIONS = Object.freeze({
	model: "inherit",
	thinkingLevel: "inherit",
}) as SubagentDelegationToolConfigV2["agentOptions"];

export const DEFAULT_CONFIG: SubAgentConfigV2 = Object.freeze({
	version: CONFIG_VERSION,
	delegationTools: Object.freeze([
		Object.freeze({
			toolName: "subagent",
			provider: "spawn",
			backgroundMode: "continuable",
			maxDepth: 3,
			agentOptions: DEFAULT_AGENT_OPTIONS,
			toolFilter: null,
			persona: null,
		}),
		Object.freeze({
			toolName: "subagent_fork",
			provider: "fork",
			backgroundMode: "one-shot",
			maxDepth: 3,
			agentOptions: DEFAULT_AGENT_OPTIONS,
			toolFilter: null,
			persona: null,
		}),
	]),
	reportDelivery: "wakeup",
});

const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

export class SubAgentConfigurationError extends Error {
	readonly configPath: string;

	constructor(configPath: string, reason: string) {
		super(`${configPath}: ${reason}`);
		this.name = "SubAgentConfigurationError";
		this.configPath = configPath;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const keys = [...expected].sort();
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		actual.length === keys.length &&
		actual.every((key, index) => key === keys[index])
	);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function describeIoError(error: unknown): string {
	if (isNodeError(error) && typeof error.code === "string") return `filesystem error ${error.code}`;
	return "filesystem operation failed";
}

function fail(configPath: string, reason: string): never {
	throw new SubAgentConfigurationError(configPath, reason);
}

function requireNonBlankString(value: unknown, field: string, configPath: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		fail(configPath, `${field} must be a non-blank string`);
	}
	return value;
}

function validateUniqueStrings(value: unknown, field: string, configPath: string, absolute = false): readonly string[] {
	if (!Array.isArray(value)) fail(configPath, `${field} must be an array`);
	const result: string[] = [];
	for (const [index, candidate] of value.entries()) {
		const item = requireNonBlankString(candidate, `${field}[${index}]`, configPath);
		if (absolute && !isAbsolute(item)) fail(configPath, `${field}[${index}] must be an absolute path`);
		result.push(item);
	}
	if (new Set(result).size !== result.length) fail(configPath, `${field} must not contain duplicates`);
	return Object.freeze(result);
}

function validateModel(value: unknown, configPath: string): SubagentDelegationToolConfigV2["agentOptions"]["model"] {
	if (value === "inherit") return "inherit";
	if (!isRecord(value) || !hasExactKeys(value, ["provider", "id"])) {
		fail(configPath, 'agentOptions.model must be "inherit" or an object with provider and id');
	}
	return Object.freeze({
		provider: requireNonBlankString(value.provider, "agentOptions.model.provider", configPath),
		id: requireNonBlankString(value.id, "agentOptions.model.id", configPath),
	});
}

function validateToolFilter(value: unknown, configPath: string): SubagentDelegationToolConfigV2["toolFilter"] {
	if (value === null) return null;
	if (!isRecord(value) || !hasExactKeys(value, ["allow", "deny"])) {
		fail(configPath, "toolFilter must be null or an object containing only allow and deny");
	}
	const allow =
		value.allow === undefined ? undefined : validateUniqueStrings(value.allow, "toolFilter.allow", configPath);
	const deny = value.deny === undefined ? undefined : validateUniqueStrings(value.deny, "toolFilter.deny", configPath);
	if (allow === undefined && deny === undefined) fail(configPath, "toolFilter must provide allow or deny");
	if (allow !== undefined && allow.length === 0 && deny !== undefined && deny.length === 0) {
		fail(configPath, "toolFilter must not provide empty allow and deny lists");
	}
	if (allow === undefined && deny?.length === 0) fail(configPath, "toolFilter must not provide an empty deny list");
	if (allow?.length === 0 && deny === undefined) fail(configPath, "toolFilter must not provide an empty allow list");
	return Object.freeze({
		...(allow === undefined ? {} : { allow }),
		...(deny === undefined ? {} : { deny }),
	});
}

function validateDelegationTool(value: unknown, field: string, configPath: string): SubagentDelegationToolConfigV2 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"toolName",
			"provider",
			"backgroundMode",
			"maxDepth",
			"agentOptions",
			"toolFilter",
			"persona",
		])
	) {
		fail(configPath, `${field} contains unknown or missing fields`);
	}
	const toolName = requireNonBlankString(value.toolName, `${field}.toolName`, configPath);
	if (value.provider !== "spawn" && value.provider !== "fork") {
		fail(configPath, `${field}.provider must be "spawn" or "fork"`);
	}
	if (value.backgroundMode !== "one-shot" && value.backgroundMode !== "continuable") {
		fail(configPath, `${field}.backgroundMode must be "one-shot" or "continuable"`);
	}
	if (typeof value.maxDepth !== "number" || !Number.isSafeInteger(value.maxDepth) || value.maxDepth < 0) {
		fail(configPath, `${field}.maxDepth must be a non-negative safe integer`);
	}
	if (!isRecord(value.agentOptions) || !hasExactKeys(value.agentOptions, ["model", "thinkingLevel"])) {
		fail(configPath, `${field}.agentOptions must contain exactly model and thinkingLevel`);
	}
	if (typeof value.agentOptions.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.agentOptions.thinkingLevel)) {
		fail(configPath, `${field}.agentOptions.thinkingLevel is invalid`);
	}
	const persona =
		value.persona === null ? null : requireNonBlankString(value.persona, `${field}.persona`, configPath).trim();

	return Object.freeze({
		toolName,
		provider: value.provider,
		backgroundMode: value.backgroundMode,
		maxDepth: value.maxDepth,
		agentOptions: Object.freeze({
			model: validateModel(value.agentOptions.model, configPath),
			thinkingLevel: value.agentOptions
				.thinkingLevel as SubagentDelegationToolConfigV2["agentOptions"]["thinkingLevel"],
		}),
		toolFilter: validateToolFilter(value.toolFilter, configPath),
		persona,
	});
}

export function validateSubAgentConfig(value: unknown, configPath: string): SubAgentConfigV2 {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "delegationTools", "reportDelivery"])) {
		fail(configPath, "top-level config contains unknown or missing fields");
	}
	if (value.version !== CONFIG_VERSION) fail(configPath, `version must equal ${CONFIG_VERSION}`);
	if (
		typeof value.reportDelivery !== "string" ||
		(value.reportDelivery !== "wakeup" && value.reportDelivery !== "quiet")
	) {
		fail(configPath, 'reportDelivery must be "wakeup" or "quiet"');
	}
	if (!Array.isArray(value.delegationTools) || value.delegationTools.length === 0) {
		fail(configPath, "delegationTools must be a non-empty array");
	}

	const tools = value.delegationTools.map((candidate, index) =>
		validateDelegationTool(candidate, `delegationTools[${index}]`, configPath),
	);
	const toolNames = new Set<string>();
	for (const tool of tools) {
		if (toolNames.has(tool.toolName))
			fail(configPath, `duplicate delegation tool name ${JSON.stringify(tool.toolName)}`);
		toolNames.add(tool.toolName);
	}

	return Object.freeze({
		version: CONFIG_VERSION,
		delegationTools: Object.freeze(tools),
		reportDelivery: value.reportDelivery,
	});
}

async function readStrictJson(configPath: string): Promise<unknown> {
	let before: Awaited<ReturnType<typeof lstat>>;
	try {
		before = await lstat(configPath);
	} catch (error) {
		fail(configPath, `cannot inspect config (${describeIoError(error)})`);
	}
	if (!before.isFile()) fail(configPath, "config path must be a regular file");
	if (before.size > MAX_CONFIG_BYTES) fail(configPath, `file exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`);

	let bytes: Uint8Array;
	try {
		bytes = await readFile(configPath);
	} catch (error) {
		fail(configPath, `cannot read config (${describeIoError(error)})`);
	}
	if (bytes.byteLength > MAX_CONFIG_BYTES) fail(configPath, `file exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`);

	let after: Awaited<ReturnType<typeof lstat>>;
	try {
		after = await lstat(configPath);
	} catch (error) {
		fail(configPath, `cannot re-check config (${describeIoError(error)})`);
	}
	if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
		fail(configPath, "config changed while it was being read");
	}

	let text: string;
	try {
		text = TEXT_DECODER.decode(bytes);
	} catch {
		fail(configPath, "file is not valid UTF-8");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return fail(configPath, "file is not strict JSON");
	}
}

async function createDefaultConfig(configPath: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(configPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, CONFIG_FILE_MODE);
		await handle.writeFile(DEFAULT_CONFIG_TEXT, "utf8");
		await handle.sync();
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "EEXIST") return false;
		return fail(configPath, `cannot create default config (${describeIoError(error)})`);
	} finally {
		await handle?.close();
	}
}

export function getSubAgentConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

export async function initializeSubAgentConfig(
	options: InitializeSubAgentConfigOptions,
): Promise<InitializedSubAgentConfig> {
	const configDir = join(options.agentDir, CONFIG_DIRECTORY_NAME);
	const configPath = join(configDir, CONFIG_FILE_NAME);

	return options.withFileMutationQueue(configPath, async () => {
		try {
			await mkdir(configDir, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
			await chmod(configDir, CONFIG_DIRECTORY_MODE);
		} catch (error) {
			fail(configPath, `cannot prepare config directory (${describeIoError(error)})`);
		}

		const created = await createDefaultConfig(configPath);
		const parsed = await readStrictJson(configPath);
		const config = validateSubAgentConfig(parsed, configPath);
		return Object.freeze({ configDir, configPath, config, created });
	});
}
