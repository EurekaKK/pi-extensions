import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileMutationQueue } from "config-store";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, initializeMemoryConfig, validateMemoryConfig } from "../src/config.js";

function queue(): FileMutationQueue & { calls: string[] } {
	const calls: string[] = [];
	const run = <T>(filePath: string, mutation: () => Promise<T>) => {
		calls.push(filePath);
		return mutation();
	};
	return Object.assign(run, { calls });
}

async function tempAgentDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-config-"));
}

describe("memory deployment config", () => {
	it("creates the default config exclusively and validates it to the documented defaults", async () => {
		const agentDir = await tempAgentDir();
		const q = queue();

		const result = await initializeMemoryConfig({ agentDir, withFileMutationQueue: q });

		expect(result.created).toBe(true);
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.configDir).toBe(join(agentDir, "memory"));
		expect(result.configPath).toBe(join(agentDir, "memory", "config.json"));
		expect(await readFile(result.configPath, "utf8")).toBe(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
		if (process.platform !== "win32") {
			expect((await lstat(result.configPath)).mode & 0o777).toBe(0o600);
		}
		expect(q.calls).toEqual([result.configPath]);
	});

	it("keeps an existing config and applies its independent switches", async () => {
		const agentDir = await tempAgentDir();
		const options = { agentDir, withFileMutationQueue: queue() };
		await initializeMemoryConfig(options);

		const overridden = { ...DEFAULT_CONFIG, proactiveWrites: false, automaticRecall: false };
		await writeFile(join(agentDir, "memory", "config.json"), `${JSON.stringify(overridden, null, 2)}\n`, "utf8");

		const second = await initializeMemoryConfig(options);

		expect(second.created).toBe(false);
		expect(second.config.proactiveWrites).toBe(false);
		expect(second.config.automaticRecall).toBe(false);
	});

	it("rejects malformed JSON with a stable message", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "memory"), { recursive: true, mode: 0o700 });
		await writeFile(join(agentDir, "memory", "config.json"), "{not json", "utf8");

		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"not strict JSON",
		);
	});

	it("rejects a wrong config version", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "memory"), { recursive: true, mode: 0o700 });
		const wrong = { ...DEFAULT_CONFIG, version: 2 };
		await writeFile(join(agentDir, "memory", "config.json"), JSON.stringify(wrong), "utf8");

		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"version must equal 1",
		);
	});

	it("rejects unknown top-level fields", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "memory"), { recursive: true, mode: 0o700 });
		await writeFile(
			join(agentDir, "memory", "config.json"),
			JSON.stringify({ ...DEFAULT_CONFIG, extra: true }),
			"utf8",
		);

		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"unknown or missing fields",
		);
	});

	it("rejects missing fields and a bad schema", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "memory"), { recursive: true, mode: 0o700 });
		const { schema: _schema, ...missingSchema } = { ...DEFAULT_CONFIG };
		await writeFile(join(agentDir, "memory", "config.json"), JSON.stringify(missingSchema), "utf8");

		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"unknown or missing fields",
		);
	});

	it("rejects invalid store limits", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "memory"), { recursive: true, mode: 0o700 });

		const zeroRecords = { ...DEFAULT_CONFIG, store: { ...DEFAULT_CONFIG.store, maxRecords: 0 } };
		await writeFile(join(agentDir, "memory", "config.json"), JSON.stringify(zeroRecords), "utf8");
		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"store.maxRecords must be a positive safe integer",
		);

		const summaryAboveContent = {
			...DEFAULT_CONFIG,
			store: { ...DEFAULT_CONFIG.store, maxContentChars: 100, maxSummaryChars: 200 },
		};
		await writeFile(join(agentDir, "memory", "config.json"), JSON.stringify(summaryAboveContent), "utf8");
		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"store.maxSummaryChars must be at most store.maxContentChars",
		);
	});

	it("rejects invalid recall and git values", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "memory"), { recursive: true, mode: 0o700 });

		const badRecall = { ...DEFAULT_CONFIG, recall: { ...DEFAULT_CONFIG.recall, maxChars: -5 } };
		await writeFile(join(agentDir, "memory", "config.json"), JSON.stringify(badRecall), "utf8");
		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"recall.maxChars must be a positive safe integer",
		);

		const zeroTimeout = { ...DEFAULT_CONFIG, git: { diagnosticTimeoutMs: 0 } };
		await writeFile(join(agentDir, "memory", "config.json"), JSON.stringify(zeroTimeout), "utf8");
		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"git.diagnosticTimeoutMs must be a positive safe integer",
		);
	});

	it("rejects an oversized config file", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "memory"), { recursive: true, mode: 0o700 });
		await writeFile(join(agentDir, "memory", "config.json"), `{"pad":"${"x".repeat(70_000)}"}`, "utf8");

		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"exceeds 65536 UTF-8 bytes",
		);
	});

	it("rejects an invalid-UTF-8 config file", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "memory"), { recursive: true, mode: 0o700 });
		await writeFile(join(agentDir, "memory", "config.json"), Buffer.from([0xff, 0xfe, 0x00, 0x5b]));

		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"not valid UTF-8",
		);
	});

	it("rejects a non-regular config path", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "memory", "config.json"), { recursive: true, mode: 0o700 });

		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"config path must be a regular file",
		);
	});

	it("rejects an I/O failure while preparing the config directory", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "memory"), "a plain file blocks the config directory", "utf8");

		await expect(initializeMemoryConfig({ agentDir, withFileMutationQueue: queue() })).rejects.toThrow(
			"cannot prepare config directory",
		);
	});

	it("validates nested field shapes through the standalone validator", () => {
		const configPath = "/tmp/memory/config.json";
		const badStore = { ...DEFAULT_CONFIG, store: { maxRecords: 10 } };
		expect(() => validateMemoryConfig(badStore, configPath)).toThrow("store must contain exactly");

		const badProactive = { ...DEFAULT_CONFIG, proactiveWrites: "yes" };
		expect(() => validateMemoryConfig(badProactive, configPath)).toThrow("proactiveWrites must be a boolean");
	});
});
