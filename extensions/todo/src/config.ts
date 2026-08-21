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

export const TODO_CONFIG_DIRECTORY_NAME = "todo";
export const TODO_CONFIG_FILE_NAME = "config.json";
export const TODO_CONFIG_VERSION = 1;

export type { FileMutationQueue };
export { MAX_CONFIG_BYTES };

export interface TodoConfigV1 {
	readonly version: 1;
	readonly allowParallelInProgress: boolean;
}

export interface InitializeTodoConfigOptions {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export type InitializedTodoConfig = StrictConfigResult<TodoConfigV1>;

export const DEFAULT_CONFIG: TodoConfigV1 = Object.freeze({
	version: TODO_CONFIG_VERSION,
	allowParallelInProgress: false,
});

const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

function fail(configPath: string, reason: string): never {
	throw new StrictConfigError(configPath, reason);
}

export function validateTodoConfig(value: unknown, configPath: string): TodoConfigV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "allowParallelInProgress"])) {
		fail(configPath, "top-level config must contain exactly version and allowParallelInProgress");
	}
	if (value.version !== TODO_CONFIG_VERSION) {
		fail(configPath, `version must equal ${TODO_CONFIG_VERSION}`);
	}
	if (typeof value.allowParallelInProgress !== "boolean") {
		fail(configPath, "allowParallelInProgress must be a boolean");
	}
	return Object.freeze({
		version: TODO_CONFIG_VERSION,
		allowParallelInProgress: value.allowParallelInProgress,
	});
}

export function getTodoConfigPath(agentDir: string): string {
	return join(agentDir, TODO_CONFIG_DIRECTORY_NAME, TODO_CONFIG_FILE_NAME);
}

export async function initializeTodoConfig(options: InitializeTodoConfigOptions): Promise<InitializedTodoConfig> {
	return initializeStrictConfig({
		agentDir: options.agentDir,
		directoryName: TODO_CONFIG_DIRECTORY_NAME,
		fileName: TODO_CONFIG_FILE_NAME,
		defaultText: DEFAULT_CONFIG_TEXT,
		validate: validateTodoConfig,
		withFileMutationQueue: options.withFileMutationQueue,
	});
}
