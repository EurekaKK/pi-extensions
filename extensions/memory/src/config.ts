import { join } from "node:path";
import {
	type FileMutationQueue,
	hasExactKeys,
	initializeStrictConfig,
	isRecord,
	StrictConfigError,
	type StrictConfigResult,
} from "config-store";
import { MEMORY_CONFIG_SCHEMA, MEMORY_CONFIG_VERSION } from "./constants.js";

export type { FileMutationQueue };

export const MEMORY_CONFIG_DIRECTORY_NAME = "memory";
export const MEMORY_CONFIG_FILE_NAME = "config.json";

export interface MemoryStoreConfigV1 {
	readonly maxStoreBytes: number;
	readonly maxRecords: number;
	readonly maxContentChars: number;
	readonly maxSummaryChars: number;
}

export interface MemoryRecallConfigV1 {
	readonly maxRecords: number;
	readonly maxChars: number;
}

export interface MemoryGitConfigV1 {
	/** Advisory Git tracking diagnostic timeout in milliseconds. */
	readonly diagnosticTimeoutMs: number;
}

export interface MemoryConfigV1 {
	readonly version: 1;
	readonly schema: "memory.config.v1";
	/** Independent switch: proactive writes by the primary foreground Agent. */
	readonly proactiveWrites: boolean;
	/** Independent switch: automatic recall before direct human requests. */
	readonly automaticRecall: boolean;
	readonly store: MemoryStoreConfigV1;
	readonly recall: MemoryRecallConfigV1;
	readonly git: MemoryGitConfigV1;
}

export interface InitializeMemoryConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export type InitializedMemoryConfig = StrictConfigResult<MemoryConfigV1>;

/**
 * Initial experimental numeric defaults (documented in README; evaluated and
 * tunable without changing the public vocabulary).
 */
export const DEFAULT_CONFIG: MemoryConfigV1 = Object.freeze({
	version: MEMORY_CONFIG_VERSION,
	schema: MEMORY_CONFIG_SCHEMA,
	proactiveWrites: true,
	automaticRecall: true,
	store: Object.freeze({
		maxStoreBytes: 1_000_000,
		maxRecords: 500,
		maxContentChars: 2_000,
		maxSummaryChars: 200,
	}),
	recall: Object.freeze({
		maxRecords: 8,
		maxChars: 6_000,
	}),
	git: Object.freeze({
		diagnosticTimeoutMs: 2_000,
	}),
});

const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

function fail(configPath: string, reason: string): never {
	throw new StrictConfigError(configPath, reason);
}

function assertPositiveSafeInteger(configPath: string, field: string, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		fail(configPath, `${field} must be a positive safe integer`);
	}
}

function validateStoreConfig(value: unknown, configPath: string): MemoryStoreConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["maxContentChars", "maxRecords", "maxStoreBytes", "maxSummaryChars"])) {
		fail(configPath, "store must contain exactly maxContentChars, maxRecords, maxStoreBytes, and maxSummaryChars");
	}
	assertPositiveSafeInteger(configPath, "store.maxStoreBytes", value.maxStoreBytes);
	if (value.maxStoreBytes < 1024) fail(configPath, "store.maxStoreBytes must be at least 1024");
	assertPositiveSafeInteger(configPath, "store.maxRecords", value.maxRecords);
	assertPositiveSafeInteger(configPath, "store.maxContentChars", value.maxContentChars);
	assertPositiveSafeInteger(configPath, "store.maxSummaryChars", value.maxSummaryChars);
	if (value.maxSummaryChars > value.maxContentChars) {
		fail(configPath, "store.maxSummaryChars must be at most store.maxContentChars");
	}
	return Object.freeze({
		maxStoreBytes: value.maxStoreBytes,
		maxRecords: value.maxRecords,
		maxContentChars: value.maxContentChars,
		maxSummaryChars: value.maxSummaryChars,
	});
}

function validateRecallConfig(value: unknown, configPath: string): MemoryRecallConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["maxChars", "maxRecords"])) {
		fail(configPath, "recall must contain exactly maxChars and maxRecords");
	}
	assertPositiveSafeInteger(configPath, "recall.maxRecords", value.maxRecords);
	assertPositiveSafeInteger(configPath, "recall.maxChars", value.maxChars);
	return Object.freeze({ maxRecords: value.maxRecords, maxChars: value.maxChars });
}

function validateGitConfig(value: unknown, configPath: string): MemoryGitConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["diagnosticTimeoutMs"])) {
		fail(configPath, "git must contain exactly diagnosticTimeoutMs");
	}
	assertPositiveSafeInteger(configPath, "git.diagnosticTimeoutMs", value.diagnosticTimeoutMs);
	return Object.freeze({ diagnosticTimeoutMs: value.diagnosticTimeoutMs });
}

export function validateMemoryConfig(value: unknown, configPath: string): MemoryConfigV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["automaticRecall", "git", "proactiveWrites", "recall", "schema", "store", "version"])
	) {
		fail(configPath, "top-level config contains unknown or missing fields");
	}
	if (value.version !== MEMORY_CONFIG_VERSION) fail(configPath, `version must equal ${MEMORY_CONFIG_VERSION}`);
	if (value.schema !== MEMORY_CONFIG_SCHEMA) fail(configPath, `schema must equal ${MEMORY_CONFIG_SCHEMA}`);
	if (typeof value.proactiveWrites !== "boolean") fail(configPath, "proactiveWrites must be a boolean");
	if (typeof value.automaticRecall !== "boolean") fail(configPath, "automaticRecall must be a boolean");
	const store = validateStoreConfig(value.store, configPath);
	const recall = validateRecallConfig(value.recall, configPath);
	const git = validateGitConfig(value.git, configPath);
	return Object.freeze({
		version: MEMORY_CONFIG_VERSION,
		schema: MEMORY_CONFIG_SCHEMA,
		proactiveWrites: value.proactiveWrites,
		automaticRecall: value.automaticRecall,
		store,
		recall,
		git,
	});
}

export function getMemoryConfigPath(agentDir: string): string {
	return join(agentDir, MEMORY_CONFIG_DIRECTORY_NAME, MEMORY_CONFIG_FILE_NAME);
}

export async function initializeMemoryConfig(options: InitializeMemoryConfigOptions): Promise<InitializedMemoryConfig> {
	return initializeStrictConfig({
		agentDir: options.agentDir,
		directoryName: MEMORY_CONFIG_DIRECTORY_NAME,
		fileName: MEMORY_CONFIG_FILE_NAME,
		defaultText: DEFAULT_CONFIG_TEXT,
		validate: validateMemoryConfig,
		withFileMutationQueue: options.withFileMutationQueue,
	});
}
