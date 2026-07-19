import { constants, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const CONFIG_DIRECTORY_NAME = "bash-permissions";
export const MAX_CONFIG_FILE_BYTES = 256 * 1024;
export const MAX_RULES_PER_FILE = 256;
export const MAX_PATTERN_LENGTH = 4_096;

const SUPPORTED_VERSION = 1;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type FileMutationQueue = <T>(filePath: string, mutation: () => Promise<T>) => Promise<T>;

export interface CompiledRedRule {
	readonly name: string;
	readonly pattern: string;
	readonly message: string;
	readonly regexp: RegExp;
}

export type YellowRuleType = "suggest" | "review";

export interface CompiledYellowRule {
	readonly name: string;
	readonly pattern: string;
	readonly type: YellowRuleType;
	readonly message: string;
	readonly suggestedCommand?: string;
	readonly regexp: RegExp;
}

export interface PolicySnapshot {
	readonly yellowRules: readonly CompiledYellowRule[];
	readonly redRules: readonly CompiledRedRule[];
}

export interface InitializePolicyOptions {
	readonly agentDir: string;
	readonly defaultsDir: string;
	readonly cwd: string;
	readonly home: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export interface InitializePolicyResult {
	readonly configDir: string;
	readonly createdFiles: readonly string[];
	readonly snapshot: PolicySnapshot;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
	return isJsonObject(error) && error.code === code;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fail(filePath: string, location: string, field: string, reason: string): never {
	const fieldSuffix = field.length > 0 ? `，字段 ${JSON.stringify(field)}` : "";
	throw new Error(`${filePath}：${location}${fieldSuffix} ${reason}`);
}

function assertExactKeys(
	value: JsonObject,
	required: readonly string[],
	allowed: readonly string[],
	filePath: string,
	location: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			fail(filePath, location, key, "不允许出现未知字段。");
		}
	}

	for (const key of required) {
		if (!Object.hasOwn(value, key)) {
			fail(filePath, location, key, "是必填字段。");
		}
	}
}

function requireNonEmptyString(value: JsonObject, field: string, filePath: string, location: string): string {
	const candidate = value[field];
	if (typeof candidate !== "string") {
		fail(filePath, location, field, "必须是字符串。");
	}
	if (candidate.trim().length === 0) {
		fail(filePath, location, field, "必须是非空字符串。");
	}
	return candidate;
}

function escapeRegExpLiteral(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function expandPattern(pattern: string, cwd: string, home: string, filePath: string, location: string): string {
	let cursor = 0;
	let expanded = "";
	while (cursor < pattern.length) {
		if (pattern.startsWith("{{", cursor)) {
			const closing = pattern.indexOf("}}", cursor + 2);
			if (closing === -1) {
				fail(filePath, location, "pattern", "包含未闭合的双花括号占位符；只允许 {{cwd}} 和 {{home}}。");
			}

			const placeholder = pattern.slice(cursor, closing + 2);
			if (placeholder !== "{{cwd}}" && placeholder !== "{{home}}") {
				fail(filePath, location, "pattern", `包含不支持的占位符 ${JSON.stringify(placeholder)}。`);
			}
			if (pattern[closing + 2] === "}") {
				fail(filePath, location, "pattern", "包含无效的双花括号占位符；只允许 {{cwd}} 和 {{home}}。");
			}

			expanded += escapeRegExpLiteral(placeholder === "{{cwd}}" ? cwd : home);
			cursor = closing + 2;
			continue;
		}

		if (pattern.startsWith("}}", cursor)) {
			fail(filePath, location, "pattern", "包含无效的双花括号占位符；只允许 {{cwd}} 和 {{home}}。");
		}

		expanded += pattern[cursor];
		cursor += 1;
	}

	return expanded;
}

function compilePattern(pattern: string, cwd: string, home: string, filePath: string, location: string): RegExp {
	if (pattern.length > MAX_PATTERN_LENGTH) {
		fail(filePath, location, "pattern", `长度 ${pattern.length} 超过上限 ${MAX_PATTERN_LENGTH}。`);
	}

	const expanded = expandPattern(pattern, cwd, home, filePath, location);
	try {
		return Object.freeze(new RegExp(expanded));
	} catch (error) {
		fail(filePath, location, "pattern", `不是有效的 JavaScript 正则表达式：${describeError(error)}。`);
	}
}

async function readJsonFile(filePath: string): Promise<unknown> {
	let fileSize: number;
	try {
		const metadata = await stat(filePath);
		if (!metadata.isFile()) {
			throw new Error("路径不是普通文件");
		}
		fileSize = metadata.size;
	} catch (error) {
		throw new Error(`${filePath}：无法检查配置文件：${describeError(error)}。`);
	}
	if (fileSize > MAX_CONFIG_FILE_BYTES) {
		throw new Error(`${filePath}：文件大小 ${fileSize} 字节超过上限 ${MAX_CONFIG_FILE_BYTES} 字节。`);
	}

	let contents: Uint8Array;
	try {
		contents = await readFile(filePath);
	} catch (error) {
		throw new Error(`${filePath}：无法读取配置文件：${describeError(error)}。`);
	}

	if (contents.byteLength > MAX_CONFIG_FILE_BYTES) {
		throw new Error(`${filePath}：文件大小 ${contents.byteLength} 字节超过上限 ${MAX_CONFIG_FILE_BYTES} 字节。`);
	}

	let text: string;
	try {
		text = TEXT_DECODER.decode(contents);
	} catch (error) {
		throw new Error(`${filePath}：配置文件不是有效的 UTF-8：${describeError(error)}。`);
	}

	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${filePath}：JSON 语法错误：${describeError(error)}。`);
	}
}

function validateRoot(value: unknown, filePath: string): readonly unknown[] {
	if (!isJsonObject(value)) {
		fail(filePath, "顶层配置", "", "必须是 JSON 对象。");
	}
	assertExactKeys(value, ["version", "rules"], ["version", "rules"], filePath, "顶层配置");

	if (value.version !== SUPPORTED_VERSION) {
		fail(filePath, "顶层配置", "version", `只支持版本 ${SUPPORTED_VERSION}，实际为 ${JSON.stringify(value.version)}。`);
	}
	if (!Array.isArray(value.rules)) {
		fail(filePath, "顶层配置", "rules", "必须是数组。");
	}
	if (value.rules.length > MAX_RULES_PER_FILE) {
		fail(filePath, "顶层配置", "rules", `规则数量 ${value.rules.length} 超过上限 ${MAX_RULES_PER_FILE}。`);
	}
	return value.rules;
}

function ruleLocation(index: number, value: unknown): string {
	if (isJsonObject(value) && typeof value.name === "string" && value.name.trim().length > 0) {
		return `规则 ${index + 1}（${JSON.stringify(value.name)}）`;
	}
	return `规则 ${index + 1}`;
}

export function validateYellowConfig(
	value: unknown,
	filePath: string,
	cwd: string,
	home: string,
): readonly CompiledYellowRule[] {
	const rules = validateRoot(value, filePath);
	const compiled = rules.map((candidate, index): CompiledYellowRule => {
		const location = ruleLocation(index, candidate);
		if (!isJsonObject(candidate)) {
			fail(filePath, location, "", "必须是 JSON 对象。");
		}
		assertExactKeys(
			candidate,
			["name", "pattern", "type", "message"],
			["name", "pattern", "type", "message", "suggestedCommand"],
			filePath,
			location,
		);

		const name = requireNonEmptyString(candidate, "name", filePath, location);
		const pattern = requireNonEmptyString(candidate, "pattern", filePath, location);
		const message = requireNonEmptyString(candidate, "message", filePath, location);
		const type = candidate.type;
		if (type !== "suggest" && type !== "review") {
			fail(filePath, location, "type", '只能是 "suggest" 或 "review"。');
		}

		const regexp = compilePattern(pattern, cwd, home, filePath, location);
		if (type === "suggest") {
			const suggestedCommand = requireNonEmptyString(candidate, "suggestedCommand", filePath, location);
			return Object.freeze({ name, pattern, type, message, suggestedCommand, regexp });
		}
		if (Object.hasOwn(candidate, "suggestedCommand")) {
			fail(filePath, location, "suggestedCommand", "在 review 规则中禁止出现。");
		}
		return Object.freeze({ name, pattern, type, message, regexp });
	});

	return Object.freeze(compiled);
}

export function validateRedConfig(
	value: unknown,
	filePath: string,
	cwd: string,
	home: string,
): readonly CompiledRedRule[] {
	const rules = validateRoot(value, filePath);
	const compiled = rules.map((candidate, index): CompiledRedRule => {
		const location = ruleLocation(index, candidate);
		if (!isJsonObject(candidate)) {
			fail(filePath, location, "", "必须是 JSON 对象。");
		}
		assertExactKeys(candidate, ["name", "pattern", "message"], ["name", "pattern", "message"], filePath, location);

		const name = requireNonEmptyString(candidate, "name", filePath, location);
		const pattern = requireNonEmptyString(candidate, "pattern", filePath, location);
		const message = requireNonEmptyString(candidate, "message", filePath, location);
		const regexp = compilePattern(pattern, cwd, home, filePath, location);
		return Object.freeze({ name, pattern, message, regexp });
	});

	return Object.freeze(compiled);
}

async function loadConfigFile(
	defaultFile: string,
	configFile: string,
	withFileMutationQueue: FileMutationQueue,
): Promise<{ readonly created: boolean; readonly value: unknown }> {
	return withFileMutationQueue(configFile, async () => {
		let created = false;
		try {
			await stat(configFile);
		} catch (error) {
			if (!isFileSystemError(error, "ENOENT")) {
				throw new Error(`${configFile}：无法检查现有配置文件：${describeError(error)}。`);
			}

			try {
				await copyFile(defaultFile, configFile, constants.COPYFILE_EXCL);
				created = true;
			} catch (copyError) {
				if (!isFileSystemError(copyError, "EEXIST")) {
					throw new Error(`${configFile}：无法从默认模板 ${defaultFile} 创建配置：${describeError(copyError)}。`);
				}
			}
		}

		try {
			return Object.freeze({ created, value: await readJsonFile(configFile) });
		} catch (error) {
			if (created) {
				throw new Error(`已创建用户配置：\n${configFile}\n${describeError(error)}`);
			}
			throw error;
		}
	});
}

export async function initializePolicy(options: InitializePolicyOptions): Promise<InitializePolicyResult> {
	const configDir = join(options.agentDir, CONFIG_DIRECTORY_NAME);
	try {
		await mkdir(configDir, { recursive: true });
	} catch (error) {
		throw new Error(`${configDir}：无法创建配置目录：${describeError(error)}。`);
	}

	const yellowPath = join(configDir, "yellow.json");
	const redPath = join(configDir, "red.json");
	const yellowDefaultPath = join(options.defaultsDir, "yellow.json");
	const redDefaultPath = join(options.defaultsDir, "red.json");

	const [yellowResult, redResult] = await Promise.allSettled([
		loadConfigFile(yellowDefaultPath, yellowPath, options.withFileMutationQueue),
		loadConfigFile(redDefaultPath, redPath, options.withFileMutationQueue),
	]);
	const createdFiles = [
		yellowResult.status === "fulfilled" && yellowResult.value.created ? yellowPath : undefined,
		redResult.status === "fulfilled" && redResult.value.created ? redPath : undefined,
	].filter((path): path is string => path !== undefined);
	const creationNote = createdFiles.length > 0 ? `已创建用户配置：\n${createdFiles.join("\n")}\n` : "";

	if (yellowResult.status === "rejected" || redResult.status === "rejected") {
		const errors = [
			yellowResult.status === "rejected" ? describeError(yellowResult.reason) : undefined,
			redResult.status === "rejected" ? describeError(redResult.reason) : undefined,
		].filter((message): message is string => message !== undefined);
		throw new Error(`${creationNote}${errors.join("\n")}`);
	}

	let snapshot: PolicySnapshot;
	try {
		snapshot = Object.freeze({
			yellowRules: validateYellowConfig(yellowResult.value.value, yellowPath, options.cwd, options.home),
			redRules: validateRedConfig(redResult.value.value, redPath, options.cwd, options.home),
		});
	} catch (error) {
		throw new Error(`${creationNote}${describeError(error)}`);
	}

	return Object.freeze({ configDir, createdFiles: Object.freeze(createdFiles), snapshot });
}
