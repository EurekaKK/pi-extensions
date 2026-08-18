import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ContextManagementConfigurationError,
	DEFAULT_CONFIG,
	getContextManagementConfigPath,
	initializeContextManagementConfig,
	validateContextManagementConfig,
} from "../src/config.js";

describe("context-management config", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "cm-config-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("creates private dsh-style defaults", async () => {
		const initialized = await initializeContextManagementConfig({ agentDir, withFileMutationQueue });
		expect(initialized.created).toBe(true);
		expect(initialized.config).toEqual(DEFAULT_CONFIG);
		expect(await readFile(initialized.configPath, "utf8")).toBe(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
		expect((await stat(initialized.configDir)).mode & 0o777).toBe(0o700);
		expect((await stat(initialized.configPath)).mode & 0o777).toBe(0o600);
	});

	it("rejects retainRatio that is not below thresholdRatio", () => {
		expect(() =>
			validateContextManagementConfig({ ...DEFAULT_CONFIG, thresholdRatio: 0.5, retainRatio: 0.5 }, "test.json"),
		).toThrow(ContextManagementConfigurationError);
	});

	it("rejects unknown fields and old versions", async () => {
		const configDir = join(agentDir, "context-management");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(getContextManagementConfigPath(agentDir), '{"version":0,"auto":true}', { mode: 0o600 });
		await expect(initializeContextManagementConfig({ agentDir, withFileMutationQueue })).rejects.toBeInstanceOf(
			ContextManagementConfigurationError,
		);
	});
});
