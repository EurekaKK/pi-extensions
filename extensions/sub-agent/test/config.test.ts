import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StrictConfigError } from "config-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	getSubAgentConfigPath,
	initializeSubAgentConfig,
	validateSubAgentConfig,
} from "../src/config.js";

describe("sub-agent v2 config", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "sub-agent-config-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("creates the private v2 default config with subagent, subagent_fork and subagent_plan", async () => {
		const initialized = await initializeSubAgentConfig({ agentDir, withFileMutationQueue });

		expect(initialized.created).toBe(true);
		expect(initialized.config.delegationTools.map((tool) => tool.toolName)).toEqual([
			"subagent",
			"subagent_fork",
			"subagent_plan",
		]);
		expect(await readFile(initialized.configPath, "utf8")).toBe(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
		expect((await stat(initialized.configDir)).mode & 0o777).toBe(0o700);
		expect((await stat(initialized.configPath)).mode & 0o777).toBe(0o600);
	});

	it("preserves an existing valid config", async () => {
		const configDir = join(agentDir, "sub-agent");
		const configPath = getSubAgentConfigPath(agentDir);
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		const existing = {
			...DEFAULT_CONFIG,
			delegationTools: [{ ...DEFAULT_CONFIG.delegationTools[0], maxDepth: 2 }, DEFAULT_CONFIG.delegationTools[1]],
			reportDelivery: "quiet",
		};
		await writeFile(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });

		const initialized = await initializeSubAgentConfig({ agentDir, withFileMutationQueue });

		expect(initialized.created).toBe(false);
		expect(initialized.config.delegationTools[0]?.maxDepth).toBe(2);
		expect(initialized.config.reportDelivery).toBe("quiet");
	});

	it("rejects v1 configs and unknown fields", async () => {
		const configDir = join(agentDir, "sub-agent");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(getSubAgentConfigPath(agentDir), '{"version":1,"model":"inherit"}', {
			mode: 0o600,
		});

		await expect(initializeSubAgentConfig({ agentDir, withFileMutationQueue })).rejects.toBeInstanceOf(
			StrictConfigError,
		);
	});

	it("validates per-tool depth, toolFilter, persona and duplicate names", () => {
		const baseTool = DEFAULT_CONFIG.delegationTools[0];
		if (baseTool === undefined) throw new Error("missing default tool");
		expect(() =>
			validateSubAgentConfig(
				{
					...DEFAULT_CONFIG,
					delegationTools: [{ ...baseTool, maxDepth: -1 }],
				},
				"test.json",
			),
		).toThrow(StrictConfigError);
		expect(() =>
			validateSubAgentConfig(
				{
					...DEFAULT_CONFIG,
					delegationTools: [{ ...baseTool, toolFilter: { allow: [], deny: [] } }],
				},
				"test.json",
			),
		).toThrow(StrictConfigError);
		expect(() =>
			validateSubAgentConfig(
				{
					...DEFAULT_CONFIG,
					delegationTools: [{ ...baseTool, persona: "   " }],
				},
				"test.json",
			),
		).toThrow(StrictConfigError);
		expect(() =>
			validateSubAgentConfig(
				{
					...DEFAULT_CONFIG,
					delegationTools: [baseTool, { ...baseTool, provider: "fork" }],
				},
				"test.json",
			),
		).toThrow(/duplicate delegation tool name/);
		expect(() => validateSubAgentConfig({ ...DEFAULT_CONFIG, reportDelivery: "loud" }, "test.json")).toThrow();
	});
});
