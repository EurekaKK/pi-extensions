import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	initializePolicy,
	MAX_CONFIG_FILE_BYTES,
	MAX_PATTERN_LENGTH,
	MAX_RULES_PER_FILE,
	validateRedConfig,
	validateYellowConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];

const validYellow = {
	version: 1,
	rules: [
		{
			name: "危险示例",
			pattern: "danger",
			type: "review",
			message: "需要复审。",
		},
	],
};

const validRed = {
	version: 1,
	rules: [
		{
			name: "灾难示例",
			pattern: "disaster",
			message: "必须拒绝。",
		},
	],
};

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "bash-permissions-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeDefaults(defaultsDir: string): Promise<{ readonly yellow: string; readonly red: string }> {
	await mkdir(defaultsDir, { recursive: true });
	const yellow = `${JSON.stringify(validYellow, null, 2)}\n`;
	const red = `${JSON.stringify(validRed, null, 2)}\n`;
	await Promise.all([
		writeFile(join(defaultsDir, "yellow.json"), yellow),
		writeFile(join(defaultsDir, "red.json"), red),
	]);
	return { yellow, red };
}

const directMutationQueue = async <T>(_filePath: string, mutation: () => Promise<T>): Promise<T> => mutation();

async function initializeWithYellowContents(contents: string | Uint8Array): Promise<unknown> {
	const root = await makeTemporaryDirectory();
	const agentDir = join(root, "agent");
	const configDir = join(agentDir, "bash-permissions");
	await mkdir(configDir, { recursive: true });
	await Promise.all([
		writeFile(join(configDir, "yellow.json"), contents),
		writeFile(join(configDir, "red.json"), JSON.stringify(validRed)),
	]);
	return initializePolicy({
		agentDir,
		defaultsDir: join(root, "unused-defaults"),
		cwd: "/work/project",
		home: "/users/test",
		withFileMutationQueue: directMutationQueue,
	});
}

describe("initializePolicy", () => {
	it("creates both missing user files from package defaults", async () => {
		const root = await makeTemporaryDirectory();
		const agentDir = join(root, "agent");
		const defaultsDir = join(root, "defaults");
		const defaults = await writeDefaults(defaultsDir);

		const result = await initializePolicy({
			agentDir,
			defaultsDir,
			cwd: "/work/project",
			home: "/users/test",
			withFileMutationQueue: directMutationQueue,
		});

		expect(result.createdFiles).toEqual([
			join(agentDir, "bash-permissions", "yellow.json"),
			join(agentDir, "bash-permissions", "red.json"),
		]);
		await expect(readFile(result.createdFiles[0] ?? "", "utf8")).resolves.toBe(defaults.yellow);
		await expect(readFile(result.createdFiles[1] ?? "", "utf8")).resolves.toBe(defaults.red);
		expect(result.snapshot.yellowRules).toHaveLength(1);
		expect(result.snapshot.redRules).toHaveLength(1);
	});

	it("creates only the missing file and preserves the existing file byte-for-byte", async () => {
		const root = await makeTemporaryDirectory();
		const agentDir = join(root, "agent");
		const configDir = join(agentDir, "bash-permissions");
		const defaultsDir = join(root, "defaults");
		await writeDefaults(defaultsDir);
		await mkdir(configDir, { recursive: true });
		const existingYellow = `  ${JSON.stringify(validYellow)}\n`;
		await writeFile(join(configDir, "yellow.json"), existingYellow);

		const result = await initializePolicy({
			agentDir,
			defaultsDir,
			cwd: "/work/project",
			home: "/users/test",
			withFileMutationQueue: directMutationQueue,
		});

		expect(result.createdFiles).toEqual([join(configDir, "red.json")]);
		await expect(readFile(join(configDir, "yellow.json"), "utf8")).resolves.toBe(existingYellow);
	});

	it("does not overwrite user configuration on later starts", async () => {
		const root = await makeTemporaryDirectory();
		const agentDir = join(root, "agent");
		const defaultsDir = join(root, "defaults");
		await writeDefaults(defaultsDir);
		const options = {
			agentDir,
			defaultsDir,
			cwd: "/work/project",
			home: "/users/test",
			withFileMutationQueue: directMutationQueue,
		};
		await initializePolicy(options);
		const yellowPath = join(agentDir, "bash-permissions", "yellow.json");
		const customized = `${JSON.stringify({ ...validYellow, rules: [] })}\n`;
		await writeFile(yellowPath, customized);

		const restarted = await initializePolicy(options);

		expect(restarted.createdFiles).toEqual([]);
		await expect(readFile(yellowPath, "utf8")).resolves.toBe(customized);
		expect(restarted.snapshot.yellowRules).toEqual([]);
	});

	it("reports newly created file paths even when another configuration is invalid", async () => {
		const root = await makeTemporaryDirectory();
		const agentDir = join(root, "agent");
		const configDir = join(agentDir, "bash-permissions");
		const defaultsDir = join(root, "defaults");
		await writeDefaults(defaultsDir);
		await mkdir(configDir, { recursive: true });
		await writeFile(join(configDir, "yellow.json"), "not json");

		await expect(
			initializePolicy({
				agentDir,
				defaultsDir,
				cwd: "/work/project",
				home: "/users/test",
				withFileMutationQueue: directMutationQueue,
			}),
		).rejects.toThrow(new RegExp(`已创建用户配置：[\\s\\S]*${join(configDir, "red.json")}[\\s\\S]*yellow\\.json`));
		await expect(readFile(join(configDir, "red.json"), "utf8")).resolves.toContain('"version": 1');
	});

	it("reports a path when its newly copied template cannot be read as configuration", async () => {
		const root = await makeTemporaryDirectory();
		const agentDir = join(root, "agent");
		const defaultsDir = join(root, "defaults");
		await mkdir(defaultsDir, { recursive: true });
		await Promise.all([
			writeFile(join(defaultsDir, "yellow.json"), "not json"),
			writeFile(join(defaultsDir, "red.json"), JSON.stringify(validRed)),
		]);
		const yellowPath = join(agentDir, "bash-permissions", "yellow.json");
		const redPath = join(agentDir, "bash-permissions", "red.json");

		await expect(
			initializePolicy({
				agentDir,
				defaultsDir,
				cwd: "/work/project",
				home: "/users/test",
				withFileMutationQueue: directMutationQueue,
			}),
		).rejects.toThrow(new RegExp(`已创建用户配置：[\\s\\S]*${redPath}[\\s\\S]*${yellowPath}`));
		await expect(readFile(yellowPath, "utf8")).resolves.toBe("not json");
	});

	it("keeps an existing snapshot unchanged until initialization runs again", async () => {
		const root = await makeTemporaryDirectory();
		const agentDir = join(root, "agent");
		const defaultsDir = join(root, "defaults");
		await writeDefaults(defaultsDir);
		const options = {
			agentDir,
			defaultsDir,
			cwd: "/work/project",
			home: "/users/test",
			withFileMutationQueue: directMutationQueue,
		};
		const first = await initializePolicy(options);
		const yellowPath = join(agentDir, "bash-permissions", "yellow.json");
		await writeFile(yellowPath, JSON.stringify({ ...validYellow, rules: [] }));

		expect(first.snapshot.yellowRules).toHaveLength(1);
		const reloaded = await initializePolicy(options);
		expect(first.snapshot.yellowRules).toHaveLength(1);
		expect(reloaded.snapshot.yellowRules).toHaveLength(0);
	});

	it("runs each create operation inside the mutation queue", async () => {
		const root = await makeTemporaryDirectory();
		const agentDir = join(root, "agent");
		const defaultsDir = join(root, "defaults");
		await writeDefaults(defaultsDir);
		const queuedPaths: string[] = [];

		await initializePolicy({
			agentDir,
			defaultsDir,
			cwd: "/work/project",
			home: "/users/test",
			withFileMutationQueue: async <T>(filePath: string, mutation: () => Promise<T>): Promise<T> => {
				queuedPaths.push(filePath);
				return mutation();
			},
		});

		expect(queuedPaths).toEqual(
			expect.arrayContaining([
				join(agentDir, "bash-permissions", "yellow.json"),
				join(agentDir, "bash-permissions", "red.json"),
			]),
		);
	});

	it("rejects a file that exceeds the byte limit", async () => {
		const root = await makeTemporaryDirectory();
		const agentDir = join(root, "agent");
		const configDir = join(agentDir, "bash-permissions");
		const defaultsDir = join(root, "defaults");
		await writeDefaults(defaultsDir);
		await mkdir(configDir, { recursive: true });
		await Promise.all([
			writeFile(join(configDir, "yellow.json"), "x".repeat(MAX_CONFIG_FILE_BYTES + 1)),
			writeFile(join(configDir, "red.json"), JSON.stringify(validRed)),
		]);

		await expect(
			initializePolicy({
				agentDir,
				defaultsDir,
				cwd: "/work/project",
				home: "/users/test",
				withFileMutationQueue: directMutationQueue,
			}),
		).rejects.toThrow(new RegExp(`yellow\\.json.*${MAX_CONFIG_FILE_BYTES}`));
	});

	it.each([
		["byte-order mark", `\uFEFF${JSON.stringify(validYellow)}`],
		["comment", '{"version": 1, "rules": [/* no comments */]}'],
		["trailing comma", '{"version": 1, "rules": [],}'],
	])("rejects strict-JSON violation: %s", async (_name, contents) => {
		await expect(initializeWithYellowContents(contents)).rejects.toThrow(/yellow\.json.*JSON 语法错误/);
	});

	it("rejects invalid UTF-8 before JSON parsing", async () => {
		await expect(initializeWithYellowContents(Uint8Array.of(0xff))).rejects.toThrow(/yellow\.json.*不是有效的 UTF-8/);
	});
});

describe("strict configuration validation", () => {
	it.each([
		["unknown top-level field", { ...validYellow, extra: true }, /顶层配置.*字段 "extra".*未知字段/],
		["missing top-level field", { version: 1 }, /顶层配置.*字段 "rules".*必填字段/],
		["unsupported version", { ...validYellow, version: 2 }, /字段 "version".*只支持版本 1/],
		["string version", { ...validYellow, version: "1" }, /字段 "version".*实际为 "1"/],
		["non-array rules", { version: 1, rules: null }, /字段 "rules".*必须是数组/],
		["non-object rule", { version: 1, rules: [null] }, /规则 1.*必须是 JSON 对象/],
		[
			"unknown rule field",
			{ version: 1, rules: [{ ...validYellow.rules[0], flags: "i" }] },
			/规则 1.*危险示例.*字段 "flags".*未知字段/,
		],
		[
			"empty required string",
			{ version: 1, rules: [{ ...validYellow.rules[0], message: "  " }] },
			/规则 1.*危险示例.*字段 "message".*非空字符串/,
		],
		[
			"invalid yellow type",
			{ version: 1, rules: [{ ...validYellow.rules[0], type: "allow" }] },
			/规则 1.*字段 "type".*suggest.*review/,
		],
		[
			"missing suggestion",
			{ version: 1, rules: [{ ...validYellow.rules[0], type: "suggest" }] },
			/规则 1.*字段 "suggestedCommand".*字符串/,
		],
		[
			"suggestion on review",
			{ version: 1, rules: [{ ...validYellow.rules[0], suggestedCommand: "safe" }] },
			/规则 1.*字段 "suggestedCommand".*禁止出现/,
		],
		[
			"invalid regexp",
			{ version: 1, rules: [{ ...validYellow.rules[0], pattern: "[" }] },
			/规则 1.*字段 "pattern".*不是有效.*正则表达式/,
		],
		[
			"unknown placeholder",
			{ version: 1, rules: [{ ...validYellow.rules[0], pattern: "{{project}}" }] },
			/规则 1.*字段 "pattern".*不支持的占位符.*project/,
		],
		[
			"malformed placeholder",
			{ version: 1, rules: [{ ...validYellow.rules[0], pattern: "{{cwd}" }] },
			/字段 "pattern".*双花括号占位符/,
		],
		[
			"extra opening brace around placeholder",
			{ version: 1, rules: [{ ...validYellow.rules[0], pattern: "{{{cwd}}}" }] },
			/字段 "pattern".*不支持的占位符/,
		],
		[
			"extra closing brace around placeholder",
			{ version: 1, rules: [{ ...validYellow.rules[0], pattern: "{{cwd}}}" }] },
			/字段 "pattern".*无效的双花括号占位符/,
		],
	] as const)("rejects %s", (_name, value, expected) => {
		expect(() => validateYellowConfig(value, "/config/yellow.json", "/work", "/home/test")).toThrow(expected);
	});

	it("rejects fields that do not belong to red rules", () => {
		const value = { version: 1, rules: [{ ...validRed.rules[0], type: "review" }] };
		expect(() => validateRedConfig(value, "/config/red.json", "/work", "/home/test")).toThrow(
			/规则 1.*灾难示例.*字段 "type".*未知字段/,
		);
	});

	it("enforces the rule-count and pattern-length limits", () => {
		const tooManyRules = Array.from({ length: MAX_RULES_PER_FILE + 1 }, () => validRed.rules[0]);
		expect(() => validateRedConfig({ version: 1, rules: tooManyRules }, "/red.json", "/work", "/home")).toThrow(
			new RegExp(`规则数量.*${MAX_RULES_PER_FILE}`),
		);

		const longPattern = "x".repeat(MAX_PATTERN_LENGTH + 1);
		expect(() =>
			validateRedConfig(
				{ version: 1, rules: [{ ...validRed.rules[0], pattern: longPattern }] },
				"/red.json",
				"/work",
				"/home",
			),
		).toThrow(new RegExp(`长度.*${MAX_PATTERN_LENGTH}`));
	});

	it("expands every cwd/home placeholder as a regex literal and keeps matching case-sensitive", () => {
		const cwd = "/work/a.+[project](one)$";
		const home = "/users/test+dev";
		const [rule] = validateRedConfig(
			{
				version: 1,
				rules: [
					{
						name: "路径",
						pattern: "^{{cwd}}:{{cwd}}:{{home}}$",
						message: "路径测试",
					},
				],
			},
			"/red.json",
			cwd,
			home,
		);

		expect(rule?.regexp.test(`${cwd}:${cwd}:${home}`)).toBe(true);
		expect(rule?.regexp.test(`${cwd.toUpperCase()}:${cwd}:${home}`)).toBe(false);
	});

	it("accepts limits exactly and freezes the resulting rule arrays", () => {
		const rules = Array.from({ length: MAX_RULES_PER_FILE }, (_, index) => ({
			name: `规则 ${index}`,
			pattern: index === 0 ? "x".repeat(MAX_PATTERN_LENGTH) : "x",
			message: "说明",
		}));
		const compiled = validateRedConfig({ version: 1, rules }, "/red.json", "/work", "/home");

		expect(compiled).toHaveLength(MAX_RULES_PER_FILE);
		expect(Object.isFrozen(compiled)).toBe(true);
		expect(Object.isFrozen(compiled[0])).toBe(true);
		expect(Object.isFrozen(compiled[0]?.regexp)).toBe(true);
	});
});
