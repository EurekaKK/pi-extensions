import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	getTodoConfigPath,
	initializeTodoConfig,
	MAX_CONFIG_BYTES,
	TodoConfigurationError,
	validateTodoConfig,
} from "../src/config.js";

describe("Todo config", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "todo-config-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("creates a private default config on first use", async () => {
		const initialized = await initializeTodoConfig({ agentDir, withFileMutationQueue });

		expect(initialized.created).toBe(true);
		expect(initialized.config).toEqual(DEFAULT_CONFIG);
		expect(await readFile(initialized.configPath, "utf8")).toBe(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
		const dirMode = (await stat(initialized.configDir)).mode & 0o777;
		const fileMode = (await stat(initialized.configPath)).mode & 0o777;
		expect(dirMode).toBe(0o700);
		expect(fileMode).toBe(0o600);
	});

	it("never overwrites an existing config and reads the configured value", async () => {
		const configDir = join(agentDir, "todo");
		const configPath = getTodoConfigPath(agentDir);
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		const existing = `{\n  "version": 1,\n  "allowParallelInProgress": true\n}\n`;
		await writeFile(configPath, existing, { mode: 0o600 });

		const initialized = await initializeTodoConfig({ agentDir, withFileMutationQueue });

		expect(initialized.created).toBe(false);
		expect(initialized.config.allowParallelInProgress).toBe(true);
		expect(await readFile(configPath, "utf8")).toBe(existing);
	});

	it.each([
		["unknown field", '{"version":1,"allowParallelInProgress":false,"extra":true}'],
		["missing policy", '{"version":1}'],
		["wrong version", '{"version":2,"allowParallelInProgress":false}'],
		["non-boolean policy", '{"version":1,"allowParallelInProgress":"yes"}'],
		["invalid JSON", "{version:1}"],
		["wrong root type", "[]"],
	])("rejects %s", async (_label, contents) => {
		const configDir = join(agentDir, "todo");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(getTodoConfigPath(agentDir), contents, { mode: 0o600 });

		await expect(initializeTodoConfig({ agentDir, withFileMutationQueue })).rejects.toBeInstanceOf(
			TodoConfigurationError,
		);
	});

	it("rejects files larger than the configured limit", async () => {
		const configDir = join(agentDir, "todo");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(getTodoConfigPath(agentDir), `"${"a".repeat(MAX_CONFIG_BYTES + 1)}"`, { mode: 0o600 });

		await expect(initializeTodoConfig({ agentDir, withFileMutationQueue })).rejects.toMatchObject({
			message: expect.stringContaining("exceeds"),
		});
	});

	it("validates a parsed value with an explicit path", () => {
		expect(validateTodoConfig({ version: 1, allowParallelInProgress: true }, "test.json")).toEqual({
			version: 1,
			allowParallelInProgress: true,
		});
		expect(() => validateTodoConfig({ version: 1, allowParallelInProgress: false, x: 1 }, "test.json")).toThrow(
			TodoConfigurationError,
		);
	});
});
