import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONFIG_DIRECTORY_MODE,
	CONFIG_FILE_MODE,
	ConfigurationError,
	type FileMutationQueue,
	getConfigPath,
	initializeConfig,
	MAX_CONFIG_BYTES,
	validateConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "sub-agent-config-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const directMutationQueue: FileMutationQueue = async <T>(_path: string, mutation: () => Promise<T>): Promise<T> =>
	mutation();

async function expectConfigurationError(action: () => Promise<unknown>, field: string): Promise<void> {
	try {
		await action();
		throw new Error("expected configuration validation to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigurationError);
		expect((error as ConfigurationError).field).toBe(field);
	}
}

describe("sub-agent config initialization", () => {
	it("creates the default once with private directory and file modes inside the mutation queue", async () => {
		const agentDir = await temporaryDirectory();
		const queuedPaths: string[] = [];
		const result = await initializeConfig({
			agentDir,
			withFileMutationQueue: async <T>(filePath: string, mutation: () => Promise<T>): Promise<T> => {
				queuedPaths.push(filePath);
				return mutation();
			},
		});

		expect(result.created).toBe(true);
		expect(result.configPath).toBe(getConfigPath(agentDir));
		expect(queuedPaths).toEqual([result.configPath]);
		expect(result.config).toEqual({
			version: 1,
			model: "inherit",
			thinkingLevel: "inherit",
			requiredExtensionPaths: [],
		});
		expect((await lstat(result.configDir)).mode & 0o777).toBe(CONFIG_DIRECTORY_MODE);
		expect((await lstat(result.configPath)).mode & 0o777).toBe(CONFIG_FILE_MODE);

		const second = await initializeConfig({ agentDir, withFileMutationQueue: directMutationQueue });
		expect(second.created).toBe(false);
	});

	it("never overwrites, migrates, or reformats an existing valid file", async () => {
		const agentDir = await temporaryDirectory();
		const configPath = getConfigPath(agentDir);
		await mkdir(join(agentDir, "sub-agent"), { recursive: true });
		const original =
			'{\n  "requiredExtensionPaths": [],\n  "thinkingLevel": "low",\n  "model": "inherit",\n  "version": 1\n}\n';
		await writeFile(configPath, original, { mode: 0o600 });

		const result = await initializeConfig({ agentDir, withFileMutationQueue: directMutationQueue });
		expect(result.created).toBe(false);
		expect(result.config.thinkingLevel).toBe("low");
		expect(await readFile(configPath, "utf8")).toBe(original);
	});

	it("normalizes required extension paths to unique canonical regular files", async () => {
		const root = await temporaryDirectory();
		const extensionEntry = join(root, "extension.ts");
		await writeFile(extensionEntry, "export default () => {};\n");
		const validated = await validateConfig(
			{
				version: 1,
				model: { provider: "fixture", id: "model" },
				thinkingLevel: "max",
				requiredExtensionPaths: [extensionEntry],
			},
			join(root, "config.json"),
		);
		expect(validated).toEqual({
			version: 1,
			model: { provider: "fixture", id: "model" },
			thinkingLevel: "max",
			requiredExtensionPaths: [await realpath(extensionEntry)],
		});

		const alias = join(root, "alias.ts");
		await symlink(extensionEntry, alias);
		await expectConfigurationError(
			() =>
				validateConfig(
					{
						version: 1,
						model: "inherit",
						thinkingLevel: "inherit",
						requiredExtensionPaths: [extensionEntry, alias],
					},
					join(root, "config.json"),
				),
			"requiredExtensionPaths",
		);
	});
});

describe("strict config validation", () => {
	it("rejects unknown, missing, wrong-version, model, thinking, and path fields", async () => {
		const configPath = "/tmp/sub-agent-test-config.json";
		await expectConfigurationError(
			() =>
				validateConfig(
					{ version: 1, model: "inherit", thinkingLevel: "inherit", requiredExtensionPaths: [], extra: true },
					configPath,
				),
			"$.extra",
		);
		await expectConfigurationError(
			() => validateConfig({ version: 1, model: "inherit", thinkingLevel: "inherit" }, configPath),
			"$.requiredExtensionPaths",
		);
		await expectConfigurationError(
			() =>
				validateConfig(
					{ version: 2, model: "inherit", thinkingLevel: "inherit", requiredExtensionPaths: [] },
					configPath,
				),
			"version",
		);
		await expectConfigurationError(
			() =>
				validateConfig(
					{
						version: 1,
						model: { provider: "fixture", id: "model", fallback: true },
						thinkingLevel: "inherit",
						requiredExtensionPaths: [],
					},
					configPath,
				),
			"model.fallback",
		);
		await expectConfigurationError(
			() =>
				validateConfig({ version: 1, model: "inherit", thinkingLevel: "auto", requiredExtensionPaths: [] }, configPath),
			"thinkingLevel",
		);
		await expectConfigurationError(
			() =>
				validateConfig(
					{ version: 1, model: "inherit", thinkingLevel: "inherit", requiredExtensionPaths: ["relative.ts"] },
					configPath,
				),
			"requiredExtensionPaths[0]",
		);
	});

	it("rejects invalid UTF-8, non-JSON, oversized, and non-regular config files without echoing content", async () => {
		const agentDir = await temporaryDirectory();
		const configDir = join(agentDir, "sub-agent");
		const configPath = getConfigPath(agentDir);
		await mkdir(configDir, { recursive: true });

		await writeFile(configPath, Uint8Array.from([0xff, 0xfe]), { mode: 0o600 });
		await expectConfigurationError(
			() => initializeConfig({ agentDir, withFileMutationQueue: directMutationQueue }),
			"$",
		);

		await writeFile(configPath, "{ secret-value", { mode: 0o600 });
		try {
			await initializeConfig({ agentDir, withFileMutationQueue: directMutationQueue });
			throw new Error("expected invalid JSON");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigurationError);
			expect((error as Error).message).not.toContain("secret-value");
		}

		await writeFile(configPath, " ".repeat(MAX_CONFIG_BYTES + 1), { mode: 0o600 });
		await expectConfigurationError(
			() => initializeConfig({ agentDir, withFileMutationQueue: directMutationQueue }),
			"$",
		);

		await rm(configPath);
		await mkdir(configPath);
		await expectConfigurationError(
			() => initializeConfig({ agentDir, withFileMutationQueue: directMutationQueue }),
			"$",
		);
	});

	it("repairs only the private directory mode, not the contents of an existing config", async () => {
		const agentDir = await temporaryDirectory();
		const configDir = join(agentDir, "sub-agent");
		const configPath = getConfigPath(agentDir);
		await mkdir(configDir, { recursive: true, mode: 0o755 });
		await chmod(configDir, 0o755);
		const original = JSON.stringify({
			version: 1,
			model: "inherit",
			thinkingLevel: "inherit",
			requiredExtensionPaths: [],
		});
		await writeFile(configPath, original, { mode: 0o644 });

		await initializeConfig({ agentDir, withFileMutationQueue: directMutationQueue });
		expect((await lstat(configDir)).mode & 0o777).toBe(0o700);
		expect((await lstat(configPath)).mode & 0o777).toBe(0o644);
		expect(await readFile(configPath, "utf8")).toBe(original);
	});
});
