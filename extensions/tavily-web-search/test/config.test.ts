import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ConfigurationError, loadOrCreateConfig, validateConfig } from "../src/config.js";
import { MAX_CONFIG_BYTES } from "../src/constants.js";

const temporaryDirectories: string[] = [];

function validConfig() {
	return {
		version: 1,
		domains: { allow: [] as string[], deny: [] as string[] },
		retrieval: {
			searchDepth: "basic",
			extractDepth: "basic",
			maxSearchResults: 5,
			maxOutputCharacters: 12_000,
			maxDocumentBytes: 256 * 1_024,
		},
		budgets: {
			maxToolCallsPerTurn: 4,
			maxToolCallsPerAgentRun: 12,
			maxToolCallsPerBranchLineage: 60,
			maxTavilyCreditsPerAgentRun: 15,
			maxTavilyCreditsPerBranchLineage: 100,
			maxConcurrency: 2,
		},
		cache: {
			searchTtlSeconds: 300,
			extractTtlSeconds: 900,
			maxBytes: 4 * 1_024 * 1_024,
		},
	};
}

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "tavily-web-search-config-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function directMutationQueue<Value>(_path: string, mutation: () => Promise<Value>): Promise<Value> {
	return mutation();
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("validateConfig", () => {
	it("accepts, canonicalizes, and deeply freezes the exact v1 schema", () => {
		const input = validConfig();
		input.domains.allow = ["BÜCHER.Example.", "*.api.example.com"];
		input.domains.deny = ["**.internal.example.com"];

		const config = validateConfig(input, "/tmp/config.json");

		expect(config.domains.allow).toEqual(["xn--bcher-kva.example", "*.api.example.com"]);
		expect(config.domains.deny).toEqual(["**.internal.example.com"]);
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.domains.allow)).toBe(true);
		expect(Object.isFrozen(config.retrieval)).toBe(true);
		expect(Object.isFrozen(config.budgets)).toBe(true);
		expect(Object.isFrozen(config.cache)).toBe(true);
	});

	it("rejects missing and unknown fields with the precise path", () => {
		const missing = validConfig();
		const valueWithoutVersion = {
			domains: missing.domains,
			retrieval: missing.retrieval,
			budgets: missing.budgets,
			cache: missing.cache,
		};
		expect(() => validateConfig(valueWithoutVersion, "/agent/config.json")).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "version", path: "/agent/config.json" }),
		);

		const rootUnknown = Object.assign(validConfig(), { apiKey: "must-not-be-configurable" });
		expect(() => validateConfig(rootUnknown)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "apiKey" }),
		);

		const nestedUnknown = validConfig();
		const retrieval = Object.assign(nestedUnknown.retrieval, { timeout: 1 });
		nestedUnknown.retrieval = retrieval;
		expect(() => validateConfig(nestedUnknown)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "retrieval.timeout" }),
		);
	});

	it("rejects non-integers, out-of-range values, and cross-field violations", () => {
		const fractional = validConfig();
		fractional.retrieval.maxSearchResults = 1.5;
		expect(() => validateConfig(fractional)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "retrieval.maxSearchResults" }),
		);

		const nonFinite = validConfig();
		nonFinite.cache.searchTtlSeconds = Number.POSITIVE_INFINITY;
		expect(() => validateConfig(nonFinite)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "cache.searchTtlSeconds" }),
		);

		const runBelowTurn = validConfig();
		runBelowTurn.budgets.maxToolCallsPerTurn = 9;
		runBelowTurn.budgets.maxToolCallsPerAgentRun = 8;
		expect(() => validateConfig(runBelowTurn)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "budgets.maxToolCallsPerAgentRun" }),
		);

		const lineageBelowRun = validConfig();
		lineageBelowRun.budgets.maxToolCallsPerBranchLineage = 7;
		expect(() => validateConfig(lineageBelowRun)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "budgets.maxToolCallsPerBranchLineage" }),
		);

		const advancedWithoutCredit = validConfig();
		advancedWithoutCredit.retrieval.extractDepth = "advanced";
		advancedWithoutCredit.budgets.maxTavilyCreditsPerAgentRun = 1;
		expect(() => validateConfig(advancedWithoutCredit)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "budgets.maxTavilyCreditsPerAgentRun" }),
		);

		const creditLineageBelowRun = validConfig();
		creditLineageBelowRun.budgets.maxTavilyCreditsPerAgentRun = 21;
		creditLineageBelowRun.budgets.maxTavilyCreditsPerBranchLineage = 20;
		expect(() => validateConfig(creditLineageBelowRun)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "budgets.maxTavilyCreditsPerBranchLineage" }),
		);

		const cacheBelowDocument = validConfig();
		cacheBelowDocument.retrieval.maxDocumentBytes = 256 * 1_024;
		cacheBelowDocument.cache.maxBytes = 128 * 1_024;
		expect(() => validateConfig(cacheBelowDocument)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "cache.maxBytes" }),
		);
	});

	it("requires version 1, known depth enums, and at most 200 domain patterns", () => {
		const wrongVersion = validConfig();
		wrongVersion.version = 2;
		expect(() => validateConfig(wrongVersion)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "version" }),
		);

		const wrongDepth = validConfig();
		wrongDepth.retrieval.searchDepth = "auto";
		expect(() => validateConfig(wrongDepth)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "retrieval.searchDepth" }),
		);

		const tooManyDomains = validConfig();
		tooManyDomains.domains.allow = Array.from({ length: 201 }, (_, index) => `d${index}.example.com`);
		expect(() => validateConfig(tooManyDomains)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "domains.allow" }),
		);
	});

	it("accepts all numeric hard boundaries", () => {
		const minimums = validConfig();
		minimums.retrieval.maxSearchResults = 1;
		minimums.retrieval.maxOutputCharacters = 2_000;
		minimums.retrieval.maxDocumentBytes = 32 * 1_024;
		minimums.budgets.maxToolCallsPerTurn = 1;
		minimums.budgets.maxToolCallsPerAgentRun = 1;
		minimums.budgets.maxToolCallsPerBranchLineage = 1;
		minimums.budgets.maxTavilyCreditsPerAgentRun = 1;
		minimums.budgets.maxTavilyCreditsPerBranchLineage = 1;
		minimums.budgets.maxConcurrency = 1;
		minimums.cache.searchTtlSeconds = 0;
		minimums.cache.extractTtlSeconds = 60;
		minimums.cache.maxBytes = 1 * 1_024 * 1_024;
		expect(validateConfig(minimums)).toBeDefined();

		const maximums = validConfig();
		maximums.retrieval.maxSearchResults = 10;
		maximums.retrieval.maxOutputCharacters = 12_000;
		maximums.retrieval.maxDocumentBytes = 256 * 1_024;
		maximums.budgets.maxToolCallsPerTurn = 16;
		maximums.budgets.maxToolCallsPerAgentRun = 64;
		maximums.budgets.maxToolCallsPerBranchLineage = 500;
		maximums.budgets.maxTavilyCreditsPerAgentRun = 100;
		maximums.budgets.maxTavilyCreditsPerBranchLineage = 1_000;
		maximums.budgets.maxConcurrency = 8;
		maximums.cache.searchTtlSeconds = 3_600;
		maximums.cache.extractTtlSeconds = 3_600;
		maximums.cache.maxBytes = 16 * 1_024 * 1_024;
		expect(validateConfig(maximums)).toBeDefined();
	});

	it("rejects normalized duplicate domains but allows the same pattern across allow and deny", () => {
		const duplicate = validConfig();
		duplicate.domains.allow = ["EXAMPLE.com", "example.com."];
		expect(() => validateConfig(duplicate)).toThrowError(
			expect.objectContaining<Partial<ConfigurationError>>({ field: "domains.allow[1]" }),
		);

		const denyWinsAtRuntime = validConfig();
		denyWinsAtRuntime.domains.allow = ["**.example.com"];
		denyWinsAtRuntime.domains.deny = ["**.example.com"];
		expect(validateConfig(denyWinsAtRuntime).domains).toEqual({
			allow: ["**.example.com"],
			deny: ["**.example.com"],
		});
	});
});

describe("loadOrCreateConfig", () => {
	it("creates a missing config under the mutation queue and never overwrites it", async () => {
		const directory = await makeTemporaryDirectory();
		const defaultsPath = join(directory, "defaults.json");
		const configPath = join(directory, "agent", "tavily-web-search", "config.json");
		await writeFile(defaultsPath, JSON.stringify(validConfig()), "utf8");
		const queuedPaths: string[] = [];
		const mutationQueue = async <Value>(path: string, mutation: () => Promise<Value>): Promise<Value> => {
			queuedPaths.push(path);
			return mutation();
		};

		const created = await loadOrCreateConfig(configPath, defaultsPath, mutationQueue);
		expect(created.created).toBe(true);
		expect(created.config.retrieval.maxSearchResults).toBe(5);
		expect(queuedPaths).toEqual([configPath]);

		const userConfig = validConfig();
		userConfig.retrieval.maxSearchResults = 7;
		await writeFile(configPath, JSON.stringify(userConfig), "utf8");
		const changedDefault = validConfig();
		changedDefault.retrieval.maxSearchResults = 9;
		await writeFile(defaultsPath, JSON.stringify(changedDefault), "utf8");

		const loaded = await loadOrCreateConfig(configPath, defaultsPath, mutationQueue);
		expect(loaded.created).toBe(false);
		expect(loaded.config.retrieval.maxSearchResults).toBe(7);
		expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(userConfig);
	});

	it("rejects BOM, invalid UTF-8, JSONC, and files over 64 KiB", async () => {
		const directory = await makeTemporaryDirectory();
		const defaultsPath = join(directory, "defaults.json");
		await writeFile(defaultsPath, JSON.stringify(validConfig()), "utf8");

		const bomPath = join(directory, "bom.json");
		await writeFile(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));
		await expect(loadOrCreateConfig(bomPath, defaultsPath, directMutationQueue)).rejects.toMatchObject({
			field: "$",
			message: expect.stringContaining("BOM"),
		});

		const utf8Path = join(directory, "utf8.json");
		await writeFile(utf8Path, Uint8Array.from([0xff, 0xfe]));
		await expect(loadOrCreateConfig(utf8Path, defaultsPath, directMutationQueue)).rejects.toMatchObject({
			message: expect.stringContaining("valid UTF-8"),
		});

		const jsoncPath = join(directory, "jsonc.json");
		await writeFile(jsoncPath, '{ "version": 1 // comment\n}', "utf8");
		await expect(loadOrCreateConfig(jsoncPath, defaultsPath, directMutationQueue)).rejects.toMatchObject({
			message: expect.stringContaining("strict JSON"),
		});

		const oversizedPath = join(directory, "oversized.json");
		await writeFile(oversizedPath, Buffer.alloc(MAX_CONFIG_BYTES + 1, 0x20));
		await expect(loadOrCreateConfig(oversizedPath, defaultsPath, directMutationQueue)).rejects.toMatchObject({
			message: expect.stringContaining("64 KiB"),
		});
	});

	it("rejects symlinks and other non-ordinary config files", async () => {
		const directory = await makeTemporaryDirectory();
		const defaultsPath = join(directory, "defaults.json");
		const targetPath = join(directory, "target.json");
		const configPath = join(directory, "config.json");
		await writeFile(defaultsPath, JSON.stringify(validConfig()), "utf8");
		await writeFile(targetPath, JSON.stringify(validConfig()), "utf8");
		await symlink(targetPath, configPath);

		await expect(loadOrCreateConfig(configPath, defaultsPath, directMutationQueue)).rejects.toMatchObject({
			field: "$",
			message: expect.stringContaining("ordinary file"),
		});
	});
});
