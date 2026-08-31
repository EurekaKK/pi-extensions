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

export const PLAN_CONFIG_DIRECTORY_NAME = "plan";
export const PLAN_CONFIG_FILE_NAME = "config.json";
export const PLAN_CONFIG_VERSION = 1;

export type { FileMutationQueue };
export { MAX_CONFIG_BYTES };

export interface PlanConfigV1 {
	readonly version: 1;
	/** 部署者断言为只读、可在 Planning Mode 使用的额外工具名。 */
	readonly additionalReadOnlyTools: readonly string[];
}

export type InitializedPlanConfig = StrictConfigResult<PlanConfigV1>;

export const DEFAULT_CONFIG: PlanConfigV1 = Object.freeze({
	version: PLAN_CONFIG_VERSION,
	additionalReadOnlyTools: Object.freeze([]),
});

const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

function fail(configPath: string, reason: string): never {
	throw new StrictConfigError(configPath, reason);
}

function validateAdditionalTools(value: unknown, configPath: string): readonly string[] {
	if (!Array.isArray(value)) fail(configPath, "additionalReadOnlyTools must be an array");
	const tools: string[] = [];
	for (const [index, candidate] of value.entries()) {
		if (typeof candidate !== "string" || candidate.trim().length === 0) {
			fail(configPath, `additionalReadOnlyTools[${index}] must be a non-blank string`);
		}
		tools.push(candidate.trim());
	}
	if (new Set(tools).size !== tools.length) {
		fail(configPath, "additionalReadOnlyTools must not contain duplicates");
	}
	return Object.freeze(tools);
}

export function validatePlanConfig(value: unknown, configPath: string): PlanConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "additionalReadOnlyTools"])) {
		fail(configPath, "top-level config must contain exactly version and additionalReadOnlyTools");
	}
	if (value.version !== PLAN_CONFIG_VERSION) {
		fail(configPath, `version must equal ${PLAN_CONFIG_VERSION}`);
	}
	return Object.freeze({
		version: PLAN_CONFIG_VERSION,
		additionalReadOnlyTools: validateAdditionalTools(value.additionalReadOnlyTools, configPath),
	});
}

export function getPlanConfigPath(agentDir: string): string {
	return join(agentDir, PLAN_CONFIG_DIRECTORY_NAME, PLAN_CONFIG_FILE_NAME);
}

export async function initializePlanConfig(options: {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}): Promise<InitializedPlanConfig> {
	return initializeStrictConfig({
		agentDir: options.agentDir,
		directoryName: PLAN_CONFIG_DIRECTORY_NAME,
		fileName: PLAN_CONFIG_FILE_NAME,
		defaultText: DEFAULT_CONFIG_TEXT,
		validate: validatePlanConfig,
		withFileMutationQueue: options.withFileMutationQueue,
	});
}
