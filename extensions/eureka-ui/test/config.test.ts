import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONFIG_VERSION,
	DEFAULT_CONFIG,
	getEurekaUiConfigPath,
	initializeEurekaUiConfig,
	StrictConfigError,
	validateEurekaUiConfig,
} from "../src/config.js";

const temporaryDirectories: string[] = [];

async function temporaryAgentDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "eureka-ui-config-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const VALID_CONFIG = {
	version: CONFIG_VERSION,
	tools: {
		read: { mode: "hidden" },
		bash: { mode: "line" },
		powershell: { mode: "native" },
		edit: { mode: "line" },
		write: { mode: "line" },
		grep: { mode: "hidden" },
		find: { mode: "hidden" },
		ls: { mode: "hidden" },
	},
};

describe("eureka-ui config", () => {
	it("creates the default config on first run and reads it back", async () => {
		const agentDir = await temporaryAgentDir();
		const initialized = await initializeEurekaUiConfig({ agentDir, withFileMutationQueue });

		expect(initialized.created).toBe(true);
		expect(initialized.config).toEqual(DEFAULT_CONFIG);

		const text = await readFile(getEurekaUiConfigPath(agentDir), "utf8");
		expect(JSON.parse(text)).toEqual(DEFAULT_CONFIG);
	});

	it("reuses an existing config instead of overwriting it", async () => {
		const agentDir = await temporaryAgentDir();
		await initializeEurekaUiConfig({ agentDir, withFileMutationQueue });

		const customized = { ...VALID_CONFIG, tools: { ...VALID_CONFIG.tools, read: { mode: "line" } } };
		await writeFile(getEurekaUiConfigPath(agentDir), `${JSON.stringify(customized, null, 2)}\n`);

		const initialized = await initializeEurekaUiConfig({ agentDir, withFileMutationQueue });
		expect(initialized.created).toBe(false);
		expect(initialized.config.tools.read).toEqual({ mode: "line" });
	});

	it("fails closed on a corrupt config and leaves the file untouched", async () => {
		const agentDir = await temporaryAgentDir();
		await initializeEurekaUiConfig({ agentDir, withFileMutationQueue });
		const configPath = getEurekaUiConfigPath(agentDir);
		await writeFile(configPath, "{ not json");

		await expect(initializeEurekaUiConfig({ agentDir, withFileMutationQueue })).rejects.toBeInstanceOf(
			StrictConfigError,
		);
		expect(await readFile(configPath, "utf8")).toBe("{ not json");
	});

	it("accepts the documented shape", () => {
		expect(validateEurekaUiConfig(VALID_CONFIG, "config.json")).toEqual(VALID_CONFIG);
	});

	it("rejects unknown keys, versions, tools and modes", () => {
		expect(() => validateEurekaUiConfig({ ...VALID_CONFIG, extra: true }, "config.json")).toThrow(StrictConfigError);
		expect(() => validateEurekaUiConfig({ ...VALID_CONFIG, version: 2 }, "config.json")).toThrow(StrictConfigError);
		expect(() =>
			validateEurekaUiConfig(
				{ ...VALID_CONFIG, tools: { ...VALID_CONFIG.tools, bash: { mode: "loud" } } },
				"config.json",
			),
		).toThrow(StrictConfigError);
		expect(() =>
			validateEurekaUiConfig(
				{ ...VALID_CONFIG, tools: { ...VALID_CONFIG.tools, write: { mode: "line", lines: 3 } } },
				"config.json",
			),
		).toThrow(StrictConfigError);
		const { bash: _dropped, ...withoutBash } = VALID_CONFIG.tools;
		expect(() => validateEurekaUiConfig({ ...VALID_CONFIG, tools: withoutBash }, "config.json")).toThrow(
			StrictConfigError,
		);
	});
});
