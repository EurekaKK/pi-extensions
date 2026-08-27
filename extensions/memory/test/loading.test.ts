import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMemoryConfigPath } from "../src/config.js";
import { MEMORY_STATUS_COMMAND } from "../src/constants.js";
import { loadMemoryExtension } from "../src/index.js";

class LoadingHarness {
	readonly host = new FakePiHost({ mode: "tui", hasUI: true });

	async load(agentDir: string): Promise<void> {
		await loadMemoryExtension(this.host.api, { agentDir, withFileMutationQueue });
	}

	async sessionStart(): Promise<void> {
		await this.host.emit("session_start", { type: "session_start", reason: "startup" });
	}
}

describe("memory extension loading", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "memory-load-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("loads the strict default config, creates it, and registers the #7 + #8 + #9 + #12 surface", async () => {
		const harness = new LoadingHarness();
		await harness.load(agentDir);

		await expect(readFile(getMemoryConfigPath(agentDir), "utf8")).resolves.toContain('"proactiveWrites": true');
		expect(harness.host.tools.map((tool) => tool.name).sort()).toEqual([
			"memory_forget",
			"memory_read",
			"memory_search",
			"memory_write",
		]);
		expect(harness.host.commands.has(MEMORY_STATUS_COMMAND)).toBe(true);
		expect(harness.host.commands.has("memory-read")).toBe(true);
		expect(harness.host.commands.has("memory-search")).toBe(true);
		expect(harness.host.commands.has("memory-list")).toBe(true);
		expect(harness.host.commands.has("memory-forget")).toBe(true);
		expect(harness.host.commands.size).toBe(5);
		await harness.sessionStart();
		expect(harness.host.ui.notify).not.toHaveBeenCalled();
	});

	it.each([
		["malformed JSON", "{not json"],
		["wrong version", JSON.stringify({ version: 99 })],
		["unknown fields", JSON.stringify({ version: 1 })],
		["invalid limits", JSON.stringify({ version: 1, store: { maxRecords: 0 } })],
		["oversized file", JSON.stringify({ pad: "x".repeat(70_000) })],
		["invalid UTF-8", "\uFFFD"],
	])("fail-closes with no registered behavior on %s", async (_name, contents) => {
		const configDir = join(agentDir, "memory");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		if (contents === "\uFFFD") {
			await writeFile(join(configDir, "config.json"), Buffer.from([0xff, 0xfe, 0x00]));
		} else {
			await writeFile(join(configDir, "config.json"), contents, { mode: 0o600 });
		}

		const harness = new LoadingHarness();
		await harness.load(agentDir);

		expect(harness.host.tools).toHaveLength(0);
		expect(harness.host.commands.size).toBe(0);
		await harness.sessionStart();
		expect(harness.host.ui.notify).toHaveBeenCalledTimes(1);
		expect(String(harness.host.ui.notify.mock.calls[0]?.[0])).toContain("memory is disabled");
		await harness.sessionStart();
		expect(harness.host.ui.notify).toHaveBeenCalledTimes(1);
	});

	it("fail-closes on a non-regular config path", async () => {
		await mkdir(join(agentDir, "memory", "config.json"), { recursive: true, mode: 0o700 });

		const harness = new LoadingHarness();
		await harness.load(agentDir);

		expect(harness.host.commands.size).toBe(0);
		await harness.sessionStart();
		expect(String(harness.host.ui.notify.mock.calls[0]?.[0])).toContain("memory is disabled");
	});

	it("fail-closes on an I/O failure while preparing the config directory", async () => {
		await writeFile(join(agentDir, "memory"), "a plain file blocks the config directory", "utf8");

		const harness = new LoadingHarness();
		await harness.load(agentDir);

		expect(harness.host.commands.size).toBe(0);
		await harness.sessionStart();
		expect(harness.host.ui.notify).toHaveBeenCalledTimes(1);
		expect(String(harness.host.ui.notify.mock.calls[0]?.[0])).toContain("memory is disabled");
	});

	it("keeps the fail-closed warning silent in modes without UI", async () => {
		const configDir = join(agentDir, "memory");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(join(configDir, "config.json"), "{not json", { mode: 0o600 });

		const host = new FakePiHost({ mode: "json", hasUI: false });
		await loadMemoryExtension(host.api, { agentDir, withFileMutationQueue });
		await host.emit("session_start", { type: "session_start" });

		expect(host.ui.notify).not.toHaveBeenCalled();
		expect(host.commands.size).toBe(0);
	});
});
