import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type FileMutationQueue,
	hasExactKeys,
	initializeStrictConfig,
	isRecord,
	StrictConfigError,
	type StrictConfigResult,
} from "config-store";
import { CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME, CONFIG_VERSION } from "./constants.js";

export type SearchDepth = "basic" | "advanced" | "fast" | "ultra-fast";
export type ExtractDepth = "basic" | "advanced";

export interface TavilyConfigV1 {
	readonly version: 1;
	readonly searchDepth: SearchDepth;
	readonly extractDepth: ExtractDepth;
	readonly maxResults: number;
	readonly searchTimeoutMs: number;
	readonly extractTimeoutMs: number;
}

export type { FileMutationQueue };

export interface InitializeTavilyConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export type InitializedTavilyConfig = StrictConfigResult<TavilyConfigV1>;

export const DEFAULT_CONFIG: TavilyConfigV1 = Object.freeze({
	version: CONFIG_VERSION,
	searchDepth: "basic",
	extractDepth: "basic",
	maxResults: 5,
	searchTimeoutMs: 40_000,
	extractTimeoutMs: 40_000,
});

const PACKAGE_DEFAULT_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../defaults/config.json");
const SEARCH_DEPTHS: readonly SearchDepth[] = ["basic", "advanced", "fast", "ultra-fast"];
const EXTRACT_DEPTHS: readonly ExtractDepth[] = ["basic", "advanced"];
const CONFIG_KEYS = ["extractDepth", "extractTimeoutMs", "maxResults", "searchDepth", "searchTimeoutMs", "version"];

function fail(configPath: string, reason: string): never {
	throw new StrictConfigError(configPath, reason);
}

function isSearchDepth(value: unknown): value is SearchDepth {
	return typeof value === "string" && SEARCH_DEPTHS.includes(value as SearchDepth);
}

function isExtractDepth(value: unknown): value is ExtractDepth {
	return typeof value === "string" && EXTRACT_DEPTHS.includes(value as ExtractDepth);
}

export function validateTavilyConfig(value: unknown, configPath: string): TavilyConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, CONFIG_KEYS)) {
		fail(configPath, "top-level config contains unknown or missing fields");
	}
	if (value.version !== CONFIG_VERSION) fail(configPath, `version must equal ${CONFIG_VERSION}`);
	if (!isSearchDepth(value.searchDepth)) fail(configPath, "searchDepth must be basic, advanced, fast, or ultra-fast");
	if (!isExtractDepth(value.extractDepth)) fail(configPath, "extractDepth must be basic or advanced");
	if (
		typeof value.maxResults !== "number" ||
		!Number.isSafeInteger(value.maxResults) ||
		value.maxResults < 1 ||
		value.maxResults > 20
	) {
		fail(configPath, "maxResults must be a safe integer from 1 to 20");
	}
	if (
		typeof value.searchTimeoutMs !== "number" ||
		!Number.isSafeInteger(value.searchTimeoutMs) ||
		value.searchTimeoutMs < 1
	) {
		fail(configPath, "searchTimeoutMs must be a positive safe integer");
	}
	if (
		typeof value.extractTimeoutMs !== "number" ||
		!Number.isSafeInteger(value.extractTimeoutMs) ||
		value.extractTimeoutMs < 1
	) {
		fail(configPath, "extractTimeoutMs must be a positive safe integer");
	}
	return Object.freeze({
		version: CONFIG_VERSION,
		searchDepth: value.searchDepth,
		extractDepth: value.extractDepth,
		maxResults: value.maxResults,
		searchTimeoutMs: value.searchTimeoutMs,
		extractTimeoutMs: value.extractTimeoutMs,
	});
}

export async function initializeTavilyConfig(options: InitializeTavilyConfigOptions): Promise<InitializedTavilyConfig> {
	return initializeStrictConfig({
		agentDir: options.agentDir,
		directoryName: CONFIG_DIRECTORY_NAME,
		fileName: CONFIG_FILE_NAME,
		defaultTextFile: PACKAGE_DEFAULT_CONFIG_PATH,
		validate: validateTavilyConfig,
		withFileMutationQueue: options.withFileMutationQueue,
	});
}
