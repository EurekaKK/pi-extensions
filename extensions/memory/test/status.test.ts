import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type MemoryConfigV1 } from "../src/config.js";
import { MEMORY_STATUS_COMMAND } from "../src/constants.js";
import { loadMemoryExtension, registerMemoryExtension } from "../src/index.js";
import { getMemoryStorePath } from "../src/store-layout.js";
import { recordFixture, storeFixture } from "./fixtures.js";

async function tempCwd(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-status-"));
}

async function writeStore(cwd: string, fixture: object): Promise<string> {
	const storePath = getMemoryStorePath(cwd);
	await mkdir(dirname(storePath), { recursive: true });
	await writeFile(storePath, JSON.stringify(fixture, null, 2), "utf8");
	return storePath;
}

class StatusHarness {
	readonly host: FakePiHost;

	constructor(cwd: string, config: MemoryConfigV1 = DEFAULT_CONFIG) {
		this.host = new FakePiHost({ cwd, mode: "tui", hasUI: true });
		registerMemoryExtension(this.host.api, config);
	}

	async runStatus(): Promise<string> {
		const command = this.host.commands.get(MEMORY_STATUS_COMMAND);
		if (command === undefined) throw new Error(`missing command ${MEMORY_STATUS_COMMAND}`);
		await command.handler("", this.host.context);
		const call = this.host.ui.notify.mock.calls.at(-1);
		if (call === undefined) throw new Error("no status notification was emitted");
		return String(call[0]);
	}

	get lastNotifyLevel(): string | undefined {
		return this.host.ui.notify.mock.calls.at(-1)?.[1];
	}
}

describe("memory-status command", () => {
	it("reports Directory Identity, healthy Store revision, counts, and recall budget without exposing record content", async () => {
		const cwd = await tempCwd();
		const older = recordFixture({ id: "rec-1", revision: 1, state: "superseded" });
		const newer = recordFixture({
			id: "rec-2",
			revision: 2,
			state: "active",
			summary: "npm workspaces superseded",
			supersedes: { id: "rec-1", revision: 1 },
		});
		await writeStore(cwd, storeFixture({ revision: 2 }, [older, newer]));

		const harness = new StatusHarness(cwd);
		const text = await harness.runStatus();

		expect(text).toContain(`Directory: ${await realpath(cwd)}`);
		expect(text).toContain("Store health: healthy");
		expect(text).toContain("Store revision: 2");
		expect(text).toContain("Records: 1 active · 1 superseded");
		expect(text).toContain("Recall budget: 8 records · 6000 chars");
		expect(text).toContain("Git: not a git repository");
		expect(text).not.toContain("The monorepo is managed");
		expect(harness.lastNotifyLevel).toBe("info");
	});

	it("reports a missing Store without treating it as an error", async () => {
		const cwd = await tempCwd();
		const harness = new StatusHarness(cwd);

		const text = await harness.runStatus();

		expect(text).toContain("Store health: missing (no Store yet)");
		expect(harness.lastNotifyLevel).toBe("info");
	});

	it.each([
		["corrupt", { ...storeFixture(), extra: true }, "Store health: corrupt"],
		["unsupported", { ...storeFixture(), version: 2 }, "Store health: unsupported"],
	])("reports %s Stores as errors without reading them as empty", async (_name, fixture, expected) => {
		const cwd = await tempCwd();
		await writeStore(cwd, fixture as object);

		const harness = new StatusHarness(cwd);
		const text = await harness.runStatus();

		expect(text).toContain(expected);
		expect(harness.lastNotifyLevel).toBe("error");
	});

	it("reports an unreadable Store path", async () => {
		const cwd = await tempCwd();
		await mkdir(getMemoryStorePath(cwd), { recursive: true });

		const harness = new StatusHarness(cwd);
		const text = await harness.runStatus();

		expect(text).toContain("Store health: unreadable");
		expect(harness.lastNotifyLevel).toBe("error");
	});

	it("reports an over-limit Store using the configured limits", async () => {
		const cwd = await tempCwd();
		await writeStore(cwd, storeFixture({ version: 1 }, [recordFixture({ content: "x".repeat(100), summary: "ok" })]));
		const config = {
			...DEFAULT_CONFIG,
			store: { ...DEFAULT_CONFIG.store, maxContentChars: 10 },
		};

		const harness = new StatusHarness(cwd, config);
		const text = await harness.runStatus();

		expect(text).toContain("Store health: over-limit");
		expect(harness.lastNotifyLevel).toBe("error");
	});

	it("never writes during status for missing, healthy, or corrupt Stores", async () => {
		const cwd = await tempCwd();
		await expect(readdir(cwd)).resolves.toEqual([]);
		await new StatusHarness(cwd).runStatus();
		await expect(readdir(cwd)).resolves.toEqual([]);

		const healthyCwd = await tempCwd();
		const storePath = await writeStore(healthyCwd, storeFixture());
		const before = await readFile(storePath);
		await new StatusHarness(healthyCwd).runStatus();
		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(readdir(dirname(storePath))).resolves.toEqual(["store.json"]);

		const corruptCwd = await tempCwd();
		const corruptPath = await writeStore(corruptCwd, { ...storeFixture(), extra: true });
		const corruptBefore = await readFile(corruptPath);
		await new StatusHarness(corruptCwd).runStatus();
		await expect(readFile(corruptPath)).resolves.toEqual(corruptBefore);
		await expect(readdir(dirname(corruptPath))).resolves.toEqual(["store.json"]);
	});

	it("converges symlink aliases onto the canonical identity and Store", async () => {
		const root = await tempCwd();
		const real = join(root, "real");
		const alias = join(root, "alias");
		await mkdir(real);
		await symlink(real, alias);
		await writeStore(real, storeFixture());

		const harness = new StatusHarness(alias);
		const text = await harness.runStatus();

		expect(text).toContain(`Directory: ${await realpath(real)}`);
		expect(text).toContain(`Store: ${join(await realpath(real), CONFIG_DIR_NAME, "memory")}`);
		expect(text).toContain("Store health: healthy");
	});

	it("reports identity failures without throwing", async () => {
		const root = await tempCwd();
		const cwd = join(root, "absent");

		const harness = new StatusHarness(cwd);
		const text = await harness.runStatus();

		expect(text).toContain("Directory error:");
		expect(harness.lastNotifyLevel).toBe("error");
	});

	it("keeps working after the directory moves; the Store travels with it", async () => {
		const root = await tempCwd();
		const before = join(root, "before");
		const after = join(root, "after");
		await mkdir(before);
		await writeStore(before, storeFixture());
		await rename(before, after);

		const harness = new StatusHarness(after);
		const text = await harness.runStatus();

		expect(text).toContain(`Directory: ${await realpath(after)}`);
		expect(text).toContain("Store health: healthy");
	});

	it("reports advisory Git tracked state inside a real repository", async () => {
		const cwd = await tempCwd();
		await writeStore(cwd, storeFixture());
		await promisify(execFile)("git", ["init", "-q"], { cwd });

		const harness = new StatusHarness(cwd);
		const text = await harness.runStatus();

		expect(text).toContain("Git: untracked by git");
		expect(text).toContain("Store health: healthy");
	});

	it("runs the Git diagnostic from the canonical identity with relative pathspecs for symlink aliases", async () => {
		const root = await tempCwd();
		const real = join(root, "real");
		const alias = join(root, "alias");
		await mkdir(real);
		await symlink(real, alias);
		await writeStore(real, storeFixture());
		await promisify(execFile)("git", ["init", "-q"], { cwd: real });

		const harness = new StatusHarness(alias);
		const text = await harness.runStatus();

		expect(text).toContain(`Directory: ${await realpath(real)}`);
		expect(text).toContain(`Store: ${join(await realpath(real), CONFIG_DIR_NAME, "memory")}`);
		expect(text).toContain("Store health: healthy");
		expect(text).toContain("Git: untracked by git");
	});
});

describe("memory extension mode safety", () => {
	it("loads and runs status safely in every Pi mode without a model or UI", async () => {
		const cwd = await tempCwd();
		await writeStore(cwd, storeFixture());

		for (const mode of ["tui", "rpc", "json", "print"] as const) {
			const hasUI = mode === "tui" || mode === "rpc";
			const host = new FakePiHost({ cwd, mode, hasUI });
			await loadMemoryExtension(host.api, {
				agentDir: await tempCwd(),
				withFileMutationQueue,
			});

			expect(host.tools.map((tool) => tool.name).sort()).toEqual(["memory_read", "memory_search", "memory_write"]);
			expect(host.commands.has(MEMORY_STATUS_COMMAND)).toBe(true);
			expect(host.commands.size).toBe(4);
			expect(host.context.model).toBeUndefined();

			const command = host.commands.get(MEMORY_STATUS_COMMAND);
			if (command === undefined) throw new Error(`missing command ${MEMORY_STATUS_COMMAND}`);
			await expect(command.handler("", host.context)).resolves.toBeUndefined();
			expect(host.ui.notify).toHaveBeenCalledTimes(hasUI ? 1 : 0);
		}
	});
});
