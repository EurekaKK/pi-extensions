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

export const GOAL_CONFIG_DIRECTORY_NAME = "goal";
export const GOAL_CONFIG_FILE_NAME = "config.json";
export const GOAL_CONFIG_VERSION = 1;

export type { FileMutationQueue };
export { MAX_CONFIG_BYTES };

export interface GoalConfigV1 {
	readonly version: 1;
	readonly defaultMaxGoalRounds: number;
	readonly blockedAfterConsecutiveRounds: number;
}

export interface InitializeGoalConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export type InitializedGoalConfig = StrictConfigResult<GoalConfigV1>;

export const DEFAULT_CONFIG: GoalConfigV1 = Object.freeze({
	version: GOAL_CONFIG_VERSION,
	defaultMaxGoalRounds: 256,
	blockedAfterConsecutiveRounds: 3,
});

const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

function fail(configPath: string, reason: string): never {
	throw new StrictConfigError(configPath, reason);
}

export function validateGoalConfig(value: unknown, configPath: string): GoalConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["blockedAfterConsecutiveRounds", "defaultMaxGoalRounds", "version"])) {
		fail(configPath, "top-level config contains unknown or missing fields");
	}
	if (value.version !== GOAL_CONFIG_VERSION) fail(configPath, `version must equal ${GOAL_CONFIG_VERSION}`);
	if (
		typeof value.defaultMaxGoalRounds !== "number" ||
		!Number.isSafeInteger(value.defaultMaxGoalRounds) ||
		value.defaultMaxGoalRounds < 1
	) {
		fail(configPath, "defaultMaxGoalRounds must be a positive safe integer");
	}
	if (
		typeof value.blockedAfterConsecutiveRounds !== "number" ||
		!Number.isSafeInteger(value.blockedAfterConsecutiveRounds) ||
		value.blockedAfterConsecutiveRounds < 1
	) {
		fail(configPath, "blockedAfterConsecutiveRounds must be a positive safe integer");
	}
	return Object.freeze({
		version: GOAL_CONFIG_VERSION,
		defaultMaxGoalRounds: value.defaultMaxGoalRounds,
		blockedAfterConsecutiveRounds: value.blockedAfterConsecutiveRounds,
	});
}

export function getGoalConfigPath(agentDir: string): string {
	return join(agentDir, GOAL_CONFIG_DIRECTORY_NAME, GOAL_CONFIG_FILE_NAME);
}

export async function initializeGoalConfig(options: InitializeGoalConfigOptions): Promise<InitializedGoalConfig> {
	return initializeStrictConfig({
		agentDir: options.agentDir,
		directoryName: GOAL_CONFIG_DIRECTORY_NAME,
		fileName: GOAL_CONFIG_FILE_NAME,
		defaultText: DEFAULT_CONFIG_TEXT,
		validate: validateGoalConfig,
		withFileMutationQueue: options.withFileMutationQueue,
	});
}
