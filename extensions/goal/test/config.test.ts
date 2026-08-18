import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	GoalConfigurationError,
	getGoalConfigPath,
	initializeGoalConfig,
	validateGoalConfig,
} from "../src/config.js";

describe("goal v2 config", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "goal-config-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("creates private dsh-style defaults", async () => {
		const initialized = await initializeGoalConfig({ agentDir, withFileMutationQueue });
		expect(initialized.created).toBe(true);
		expect(initialized.config).toEqual(DEFAULT_CONFIG);
		expect(await readFile(initialized.configPath, "utf8")).toBe(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
		expect((await stat(initialized.configDir)).mode & 0o777).toBe(0o700);
		expect((await stat(initialized.configPath)).mode & 0o777).toBe(0o600);
	});

	it("rejects invalid limits", async () => {
		expect(() =>
			validateGoalConfig({ version: 1, defaultMaxGoalRounds: 0, blockedAfterConsecutiveRounds: 3 }, "test.json"),
		).toThrow(GoalConfigurationError);
		expect(() =>
			validateGoalConfig({ version: 1, defaultMaxGoalRounds: 256, blockedAfterConsecutiveRounds: 0 }, "test.json"),
		).toThrow(GoalConfigurationError);
	});

	it("rejects unknown fields and old versions", async () => {
		const configDir = join(agentDir, "goal");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(
			getGoalConfigPath(agentDir),
			'{"version":0,"defaultMaxGoalRounds":1,"blockedAfterConsecutiveRounds":1}',
			{ mode: 0o600 },
		);
		await expect(initializeGoalConfig({ agentDir, withFileMutationQueue })).rejects.toBeInstanceOf(
			GoalConfigurationError,
		);
	});
});
