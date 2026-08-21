import { join } from "node:path";
import {
	CONFIG_DIRECTORY_MODE,
	CONFIG_FILE_MODE,
	type FileMutationQueue,
	hasExactKeys,
	initializeStrictConfig,
	isRecord,
	MAX_CONFIG_BYTES,
	StrictConfigError,
	type StrictConfigResult,
} from "config-store";
import { CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME, CONFIG_VERSION, PRUNE_MARKER } from "./constants.js";

export type { FileMutationQueue };
export { CONFIG_DIRECTORY_MODE, CONFIG_FILE_MODE, MAX_CONFIG_BYTES };

export interface PruneConfigV1 {
	readonly thresholdChars: number;
	readonly headChars: number;
	readonly tailChars: number;
}

export interface SpillConfigV1 {
	readonly maxInlineBytes: number;
}

export interface ContextManagementConfigV1 {
	readonly version: 1;
	readonly auto: boolean;
	readonly thresholdRatio: number;
	readonly retainRatio: number;
	readonly maxTokens: number;
	readonly compactionRetries: number;
	readonly prune: PruneConfigV1;
	readonly spill: SpillConfigV1;
}

export interface InitializeContextManagementConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export type InitializedContextManagementConfig = StrictConfigResult<ContextManagementConfigV1>;

export const DEFAULT_CONFIG: ContextManagementConfigV1 = Object.freeze({
	version: CONFIG_VERSION,
	auto: true,
	thresholdRatio: 0.8,
	retainRatio: 0.16,
	maxTokens: 8_192,
	compactionRetries: 1,
	prune: Object.freeze({
		thresholdChars: 8_192,
		headChars: 4_096,
		tailChars: 1_024,
	}),
	spill: Object.freeze({
		maxInlineBytes: 50_000,
	}),
});

const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

function fail(configPath: string, reason: string): never {
	throw new StrictConfigError(configPath, reason);
}

function assertRatio(configPath: string, field: string, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
		fail(configPath, `${field} must be a number in (0, 1]`);
	}
}

function assertNonNegativeInteger(configPath: string, field: string, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail(configPath, `${field} must be a non-negative safe integer`);
	}
}

function assertPositiveInteger(configPath: string, field: string, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		fail(configPath, `${field} must be a positive safe integer`);
	}
}

function validatePruneConfig(value: unknown, configPath: string): PruneConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["headChars", "tailChars", "thresholdChars"])) {
		fail(configPath, "prune must contain exactly thresholdChars, headChars, and tailChars");
	}
	assertPositiveInteger(configPath, "prune.thresholdChars", value.thresholdChars);
	assertNonNegativeInteger(configPath, "prune.headChars", value.headChars);
	assertNonNegativeInteger(configPath, "prune.tailChars", value.tailChars);
	const emittedChars = value.headChars + Array.from(PRUNE_MARKER).length + value.tailChars;
	if (emittedChars > value.thresholdChars) {
		fail(
			configPath,
			`prune.headChars + marker + prune.tailChars (${emittedChars}) must be at most prune.thresholdChars (${value.thresholdChars})`,
		);
	}
	return Object.freeze({
		thresholdChars: value.thresholdChars,
		headChars: value.headChars,
		tailChars: value.tailChars,
	});
}

function validateSpillConfig(value: unknown, configPath: string): SpillConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["maxInlineBytes"])) {
		fail(configPath, "spill must contain exactly maxInlineBytes");
	}
	assertNonNegativeInteger(configPath, "spill.maxInlineBytes", value.maxInlineBytes);
	return Object.freeze({ maxInlineBytes: value.maxInlineBytes });
}

export function validateContextManagementConfig(value: unknown, configPath: string): ContextManagementConfigV1 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"auto",
			"compactionRetries",
			"maxTokens",
			"prune",
			"retainRatio",
			"spill",
			"thresholdRatio",
			"version",
		])
	) {
		fail(configPath, "top-level config contains unknown or missing fields");
	}
	if (value.version !== CONFIG_VERSION) fail(configPath, `version must equal ${CONFIG_VERSION}`);
	if (typeof value.auto !== "boolean") fail(configPath, "auto must be a boolean");
	assertRatio(configPath, "thresholdRatio", value.thresholdRatio);
	assertRatio(configPath, "retainRatio", value.retainRatio);
	if (value.retainRatio >= value.thresholdRatio) {
		fail(configPath, "retainRatio must be less than thresholdRatio");
	}
	assertPositiveInteger(configPath, "maxTokens", value.maxTokens);
	assertNonNegativeInteger(configPath, "compactionRetries", value.compactionRetries);
	const prune = validatePruneConfig(value.prune, configPath);
	const spill = validateSpillConfig(value.spill, configPath);
	return Object.freeze({
		version: CONFIG_VERSION,
		auto: value.auto,
		thresholdRatio: value.thresholdRatio,
		retainRatio: value.retainRatio,
		maxTokens: value.maxTokens,
		compactionRetries: value.compactionRetries,
		prune,
		spill,
	});
}

export function getContextManagementConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

export async function initializeContextManagementConfig(
	options: InitializeContextManagementConfigOptions,
): Promise<InitializedContextManagementConfig> {
	return initializeStrictConfig({
		agentDir: options.agentDir,
		directoryName: CONFIG_DIRECTORY_NAME,
		fileName: CONFIG_FILE_NAME,
		defaultText: DEFAULT_CONFIG_TEXT,
		validate: validateContextManagementConfig,
		withFileMutationQueue: options.withFileMutationQueue,
	});
}
