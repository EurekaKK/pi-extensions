import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StrictConfigError } from "config-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, initializePlanConfig, validatePlanConfig } from "../src/config.js";

describe("plan v1 config", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "plan-config-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("creates a default private config on first use", async () => {
		const initialized = await initializePlanConfig({ agentDir, withFileMutationQueue });
		expect(initialized.created).toBe(true);
		expect(initialized.config).toEqual(DEFAULT_CONFIG);
		expect((await stat(initialized.configDir)).mode & 0o777).toBe(0o700);
		expect((await stat(initialized.configPath)).mode & 0o777).toBe(0o600);
	});

	it("preserves an existing valid config", async () => {
		const dir = join(agentDir, "plan");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const withTools = { ...DEFAULT_CONFIG, additionalReadOnlyTools: ["my_research_tool"] };
		await writeFile(join(dir, "config.json"), JSON.stringify(withTools, null, 2), { mode: 0o600 });
		const initialized = await initializePlanConfig({ agentDir, withFileMutationQueue });
		expect(initialized.created).toBe(false);
		expect(initialized.config.additionalReadOnlyTools).toEqual(["my_research_tool"]);
		expect(await readFile(initialized.configPath, "utf8")).toContain("my_research_tool");
	});

	it("rejects invalid shapes", () => {
		expect(() => validatePlanConfig({ version: 2 }, "p.json")).toThrow(StrictConfigError);
		expect(() => validatePlanConfig({ version: 1, additionalReadOnlyTools: ["a", "a"] }, "p.json")).toThrow(
			StrictConfigError,
		);
		expect(() => validatePlanConfig({ version: 1, additionalReadOnlyTools: ["  "] }, "p.json")).toThrow(
			StrictConfigError,
		);
		expect(() => validatePlanConfig({ version: 1, additionalReadOnlyTools: "read" }, "p.json")).toThrow(
			StrictConfigError,
		);
	});
});
