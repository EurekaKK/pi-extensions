import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type MemoryConfigV1 } from "../src/config.js";
import {
	MEMORY_ABORTED,
	MEMORY_FORGET_COMMAND,
	MEMORY_FORGET_DENIED,
	MEMORY_FORGET_TARGET_NOT_FOUND,
	MEMORY_FORGET_TARGET_STALE,
	MEMORY_FORGET_TOOL,
	MEMORY_RECORD_NOT_FOUND,
	MEMORY_STORE_CORRUPT,
	MEMORY_STORE_IGNORE_FILE_NAME,
	MEMORY_STORE_UNAVAILABLE,
	MEMORY_STORE_UNSUPPORTED_VERSION,
	MEMORY_WRITE_DENIED,
	MEMORY_WRITE_FAILED,
	MEMORY_WRITE_TOOL,
} from "../src/constants.js";
import { MemoryError } from "../src/errors.js";
import { registerMemoryExtension } from "../src/index.js";
import { MEMORY_FORGET_CAVEAT } from "../src/receipt.js";
import { createMemoryStoreFs, type MemoryStoreFs } from "../src/store-io.js";
import { getMemoryStoreDirectory, getMemoryStorePath } from "../src/store-layout.js";
import { storeFixture } from "./fixtures.js";

type Executor = (
	toolCallId: string,
	parameters: never,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	context: ExtensionContext,
) => Promise<unknown>;

interface ForgetParams {
	readonly id: string;
	readonly revision?: number;
}

interface WriteParams {
	readonly operation: "add" | "supersede";
	readonly summary: string;
	readonly content: string;
	readonly targetId?: string;
	readonly targetRevision?: number;
}

interface ToolResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
}

function asRecord(record: unknown): Record<string, unknown> {
	if (typeof record !== "object" || record === null) throw new Error(`not an object: ${String(record)}`);
	return record as Record<string, unknown>;
}

async function storeJson(cwd: string): Promise<{
	revision: number;
	directory: { id: string };
	records: readonly Record<string, unknown>[];
}> {
	const text = await readFile(getMemoryStorePath(cwd), "utf8");
	return JSON.parse(text) as {
		revision: number;
		directory: { id: string };
		records: readonly Record<string, unknown>[];
	};
}

async function seedFile(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents, "utf8");
}

class MemoryHarness {
	readonly host: FakePiHost;
	readonly cwd: string;
	readonly sessionId: string;

	constructor(
		cwd: string,
		config: MemoryConfigV1 = DEFAULT_CONFIG,
		options: { readonly sessionId?: string; readonly storeFs?: MemoryStoreFs } = {},
	) {
		this.cwd = cwd;
		this.sessionId = options.sessionId ?? "session-1";
		this.host = new FakePiHost({ cwd, mode: "tui", hasUI: true, sessionId: this.sessionId });
		registerMemoryExtension(this.host.api, config, {
			withFileMutationQueue,
			...(options.storeFs === undefined ? {} : { storeFs: options.storeFs }),
		});
	}

	async input(source: "interactive" | "rpc" | "extension"): Promise<void> {
		await this.host.emit("input", { type: "input", source, text: "forget something" });
	}

	tool(name: string): { execute: Executor } {
		const tool = this.host.tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`missing tool ${name}`);
		return tool as unknown as { execute: Executor };
	}

	async forget(params: ForgetParams): Promise<ToolResult> {
		return (await this.tool(MEMORY_FORGET_TOOL).execute(
			"call-f",
			params as never,
			undefined,
			undefined,
			this.host.context,
		)) as ToolResult;
	}

	async write(params: WriteParams): Promise<ToolResult> {
		return (await this.tool(MEMORY_WRITE_TOOL).execute(
			"call-w",
			params as never,
			undefined,
			undefined,
			this.host.context,
		)) as ToolResult;
	}

	async add(summary: string, content: string): Promise<{ id: string; revision: number }> {
		const result = await this.write({ operation: "add", summary, content });
		const record = asRecord(asRecord(result.details).record);
		return { id: String(record.id), revision: Number(record.revision) };
	}

	async supersede(
		target: { id: string; revision: number },
		summary: string,
		content: string,
	): Promise<{ id: string; revision: number }> {
		const result = await this.write({
			operation: "supersede",
			targetId: target.id,
			targetRevision: target.revision,
			summary,
			content,
		});
		const record = asRecord(asRecord(result.details).record);
		return { id: String(record.id), revision: Number(record.revision) };
	}

	/** Build a three-member chain A ← B ← C through the real write path. */
	async buildChain(prefix: string): Promise<{
		a: { id: string; revision: number };
		b: { id: string; revision: number };
		c: { id: string; revision: number };
	}> {
		const a = await this.add(`${prefix} base`, `${prefix} base content`);
		const b = await this.supersede(a, `${prefix} second`, `${prefix} second content`);
		const c = await this.supersede(b, `${prefix} third`, `${prefix} third content`);
		return { a, b, c };
	}

	async forgetCommand(argumentsText: string): Promise<void> {
		const command = this.host.commands.get(MEMORY_FORGET_COMMAND);
		if (command === undefined) throw new Error(`missing command ${MEMORY_FORGET_COMMAND}`);
		await command.handler(argumentsText, this.host.context);
	}

	get lastNotify(): { text: string; level?: string } | undefined {
		const call = this.host.ui.notify.mock.calls.at(-1);
		if (call === undefined) return undefined;
		return { text: String(call[0]), level: String(call[1] ?? "") };
	}
}

async function tempCwd(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-forget-"));
}

describe("memory_forget authority at the loaded seam", () => {
	it("denies before any direct human input and after the run settles", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "secrets should be forgettable");
		const persisted = await storeJson(cwd);
		const id = String(asRecord(persisted.records[0]).id);

		const before = await readFile(getMemoryStorePath(cwd));
		await h.host.emit("agent_settled", { type: "agent_settled" });
		await expect(h.forget({ id })).rejects.toMatchObject({ code: MEMORY_FORGET_DENIED });
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);

		await h.input("interactive");
		await expect(h.forget({ id })).resolves.toBeDefined();
	});

	it("grants interactive and rpc inputs but extension input revokes inherited authority", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "content-A");
		const id = String((await storeJson(cwd)).records[0]?.id);

		await h.input("extension");
		await expect(h.forget({ id })).rejects.toMatchObject({ code: MEMORY_FORGET_DENIED });

		await h.input("rpc");
		await expect(h.forget({ id })).resolves.toMatchObject({ details: { outcome: "forgotten" } });
	});

	it("revokes authority when an extension custom message starts a follow-up turn", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "content");
		const id = String((await storeJson(cwd)).records[0]?.id);

		await h.host.emit("message_start", {
			type: "message_start",
			message: { role: "custom", customType: "test:follow-up", content: "continue", timestamp: Date.now() },
		});

		await expect(h.forget({ id })).rejects.toMatchObject({ code: MEMORY_FORGET_DENIED });
	});

	it.each(["session_start", "session_tree", "session_shutdown"] as const)("resets fail-closed at %s", async (event) => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "content");
		const id = String((await storeJson(cwd)).records[0]?.id);

		await h.host.emit(event, { type: event });

		await expect(h.forget({ id })).rejects.toMatchObject({ code: MEMORY_FORGET_DENIED });
	});

	it("denies durably when the branch carries a subagent:descriptor entry", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "content");
		const id = String((await storeJson(cwd)).records[0]?.id);

		h.host.api.appendEntry("subagent:descriptor", { version: 1, depth: 1 });
		await h.host.emit("agent_settled", { type: "agent_settled" });

		await expect(h.forget({ id })).rejects.toMatchObject({ code: MEMORY_FORGET_DENIED });
	});

	it("denies the command adapter inside a durable subagent session", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id } = await h.add("s", "content");
		const before = await readFile(getMemoryStorePath(cwd));
		h.host.api.appendEntry("subagent:descriptor", { version: 1, depth: 1 });

		await h.forgetCommand(id);

		expect(h.lastNotify?.level).toBe("error");
		expect(h.lastNotify?.text).toContain("not available to subagents");
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
	});

	it("allows forget even when proactiveWrites is disabled by config (write still denied)", async () => {
		const cwd = await tempCwd();
		const config = { ...DEFAULT_CONFIG, proactiveWrites: false };
		const h = new MemoryHarness(cwd, config);
		await h.input("interactive");

		// A config-off deployment cannot proactively write…
		await expect(h.write({ operation: "add", summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_WRITE_DENIED,
		});

		// …but an explicit human-directed forget is still authorized.
		await seedFile(
			getMemoryStorePath(cwd),
			JSON.stringify({
				version: 1,
				schema: "memory.store.v1",
				revision: 1,
				directory: { id: await realpath(cwd) },
				records: [
					{
						id: "rec-explicit",
						revision: 1,
						state: "active",
						summary: "explicit target",
						content: "private content that must be forgettable",
						supersedes: null,
						provenance: { sessionId: "session-1", directoryId: await realpath(cwd), author: "primary-agent" },
						createdAt: "2025-01-01T00:00:00.000Z",
						updatedAt: "2025-01-01T00:00:00.000Z",
					},
				],
			}),
		);

		const result = await h.forget({ id: "rec-explicit" });
		expect(asRecord(result.details).outcome).toBe("forgotten");
		await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 2, records: [] });
	});
});

describe("memory_forget tool surface", () => {
	it("registers strict parameters and guidelines that forbid proactive cleanup", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		const tool = h.host.tools.find((candidate) => candidate.name === MEMORY_FORGET_TOOL);
		if (tool === undefined) throw new Error(`missing tool ${MEMORY_FORGET_TOOL}`);

		expect(tool.label).toBe("Forget memory");
		expect(String(tool.description)).toContain("supersession chain");
		const parameters = asRecord(tool.parameters);
		expect(parameters.additionalProperties).toBe(false);
		const properties = asRecord(parameters.properties);
		const idSchema = asRecord(properties.id);
		expect(idSchema.minLength).toBe(1);
		const revisionSchema = asRecord(properties.revision);
		expect(revisionSchema.minimum).toBe(1);
		expect(properties.id).toBeDefined();
		expect(properties.revision).toBeDefined();

		const guidelines = tool.promptGuidelines ?? [];
		const joined = guidelines.join("\n");
		expect(joined).toContain("memory_forget");
		expect(joined).toContain("explicitly asks");
		expect(joined).toContain("Never use memory_forget proactively");
		expect(joined).toContain("cleanup");
	});
});

describe("memory_forget committed deletion", () => {
	it("removes a single active record, increments the Store revision once, and refreshes directory metadata", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id } = await h.add("npm workspaces", "The monorepo uses npm workspaces; never mix pnpm.");
		const storePath = getMemoryStorePath(cwd);
		if (process.platform !== "win32") await chmod(storePath, 0o644);

		const result = await h.forget({ id });

		const receipt = asRecord(result.details);
		expect(receipt.kind).toBe("memory:forget-receipt");
		expect(receipt.version).toBe(1);
		expect(receipt.outcome).toBe("forgotten");
		expect(receipt.count).toBe(1);
		expect(receipt.previousStoreRevision).toBe(1);
		expect(receipt.storeRevision).toBe(2);
		expect(receipt.removed).toEqual([{ id, revision: 1, state: "active" }]);

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(2);
		expect(persisted.records).toHaveLength(0);
		expect(persisted.directory.id).toBe(await realpath(cwd));
		if (process.platform !== "win32") expect((await lstat(storePath)).mode & 0o777).toBe(0o600);

		// The receipt never reproduces the deleted content.
		const text = String((result.content[0] as { text?: string }).text ?? "");
		expect(text).toContain(id);
		expect(text).toContain("memory_forget · forgotten");
		expect(text).not.toContain("npm workspaces");
		expect(text).not.toContain("never mix pnpm");
	});

	it("creates the scoped ignore marker during a committed forget when it was missing", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "content");
		const markerPath = join(getMemoryStoreDirectory(cwd), MEMORY_STORE_IGNORE_FILE_NAME);
		await rm(markerPath);
		const id = String((await storeJson(cwd)).records[0]?.id);

		const result = await h.forget({ id });

		expect(asRecord(result.details).ignoreMarker).toBe("created");
		await expect(readFile(markerPath, "utf8")).resolves.toBe("*\n");
	});
});

describe("memory_forget full-chain resolution", () => {
	it("removes every connected revision when targeting the active leaf", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const chain = await h.buildChain("leaf-target");
		const storeBefore = await readFile(getMemoryStorePath(cwd));

		const result = await h.forget({ id: chain.c.id, revision: chain.c.revision });

		const receipt = asRecord(result.details);
		expect(receipt.count).toBe(3);
		expect(receipt.previousStoreRevision).toBe(3);
		expect(receipt.storeRevision).toBe(4);
		// Root-to-leaf chain order in the receipt.
		expect(receipt.removed).toEqual([
			{ id: chain.a.id, revision: 1, state: "superseded" },
			{ id: chain.b.id, revision: 2, state: "superseded" },
			{ id: chain.c.id, revision: 3, state: "active" },
		]);

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(4);
		expect(persisted.records).toHaveLength(0);
		const storeText = await readFile(getMemoryStorePath(cwd), "utf8");
		for (const member of [chain.a, chain.b, chain.c]) {
			expect(storeText).not.toContain(member.id);
		}
		expect(storeText).not.toContain("base content");
		expect(storeText).not.toContain("third content");
		expect(storeBefore).not.toEqual(storeText);
	});

	it("removes the identical full chain when targeting a historical member", async () => {
		for (const which of ["root", "middle"] as const) {
			const cwd = await tempCwd();
			const h = new MemoryHarness(cwd);
			await h.input("interactive");
			const chain = await h.buildChain("historical-target");
			const member = which === "root" ? chain.a : chain.b;

			const result = await h.forget({ id: member.id, revision: member.revision });
			const receipt = asRecord(result.details);
			expect(receipt.count).toBe(3);
			expect(receipt.previousStoreRevision).toBe(3);
			expect(receipt.storeRevision).toBe(4);
			expect((receipt.removed as unknown[]).map((entry) => String(asRecord(entry).id))).toEqual([
				chain.a.id,
				chain.b.id,
				chain.c.id,
			]);
			await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 4, records: [] });
		}
	});

	it("preserves unrelated chains byte-for-byte while removing the addressed chain", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const doomed = await h.buildChain("doomed");
		const survivor = await h.add("survivor", "survivor content that must remain");

		const result = await h.forget({ id: doomed.a.id });

		const receipt = asRecord(result.details);
		expect(receipt.count).toBe(3);
		expect(receipt.storeRevision).toBe(5);

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(5);
		expect(persisted.records).toHaveLength(1);
		const remaining = asRecord(persisted.records[0]);
		expect(remaining.id).toBe(survivor.id);
		expect(remaining.revision).toBe(1);
		expect(remaining.state).toBe("active");
		expect(remaining.content).toBe("survivor content that must remain");
		const text = await readFile(getMemoryStorePath(cwd), "utf8");
		expect(text).not.toContain("doomed base content");
		expect(text).toContain("survivor content that must remain");
	});

	it("leaves no content-bearing tombstone: read and search are immediately absent", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const chain = await h.buildChain("vanishing");
		await h.forget({ id: chain.c.id });

		for (const member of [chain.a, chain.b, chain.c]) {
			const readTool = h.tool("memory_read");
			await expect(
				readTool.execute("r", { id: member.id } as never, undefined, undefined, h.host.context),
			).rejects.toMatchObject({ code: MEMORY_RECORD_NOT_FOUND });
		}

		const searchTool = h.tool("memory_search");
		const search = (await searchTool.execute(
			"s",
			{ query: "vanishing" } as never,
			undefined,
			undefined,
			h.host.context,
		)) as ToolResult;
		expect(asRecord(search.details).matchedCount).toBe(0);
		expect(String((search.content[0] as { text?: string }).text ?? "")).toContain("0 matches");
	});
});

describe("memory_forget missing/already-absent behavior", () => {
	it("returns a stable not-found for a missing identity with zero byte or revision mutation", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "content");
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await expect(h.forget({ id: "memory-000000000000000000000000" })).rejects.toMatchObject({
			code: MEMORY_FORGET_TARGET_NOT_FOUND,
		});
		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 1 });
	});

	it("returns a stable not-found when no Store exists without creating anything", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await expect(h.forget({ id: "memory-000000000000000000000000" })).rejects.toMatchObject({
			code: MEMORY_FORGET_TARGET_NOT_FOUND,
		});
		await expect(readdir(cwd)).resolves.toEqual([]);
	});

	it("returns a stable not-found when a chain was already forgotten and bytes stay unchanged", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const chain = await h.buildChain("twice");
		const first = await h.forget({ id: chain.c.id });
		expect(asRecord(first.details).outcome).toBe("forgotten");
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await expect(h.forget({ id: chain.a.id, revision: 1 })).rejects.toMatchObject({
			code: MEMORY_FORGET_TARGET_NOT_FOUND,
		});
		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 4 });
	});

	it("fails closed as stale/ambiguous when the id exists but the exact revision does not match", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id } = await h.add("s", "content");
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await expect(h.forget({ id, revision: 9 })).rejects.toMatchObject({
			code: MEMORY_FORGET_TARGET_STALE,
		});
		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 1 });
	});
});

describe("memory_forget fail-closed Store handling", () => {
	it("fails closed on a corrupt Store and never treats it as empty", async () => {
		const cwd = await tempCwd();
		await seedFile(getMemoryStorePath(cwd), "{not json");
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await expect(h.forget({ id: "rec-1" })).rejects.toMatchObject({ code: MEMORY_STORE_CORRUPT });
		await expect(readFile(getMemoryStorePath(cwd), "utf8")).resolves.toBe("{not json");
	});

	it("fails closed on an unsupported Store version", async () => {
		const cwd = await tempCwd();
		await seedFile(getMemoryStorePath(cwd), JSON.stringify({ ...storeFixture(), version: 2 }));
		const before = await readFile(getMemoryStorePath(cwd));
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await expect(h.forget({ id: "rec-1" })).rejects.toMatchObject({ code: MEMORY_STORE_UNSUPPORTED_VERSION });
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
	});

	it("fails closed on an unreadable Store path", async () => {
		const cwd = await tempCwd();
		await mkdir(getMemoryStorePath(cwd), { recursive: true });
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await expect(h.forget({ id: "rec-1" })).rejects.toMatchObject({ code: MEMORY_STORE_UNAVAILABLE });
	});

	it("keeps the prior Store authoritative when a forget commit fails at the loaded seam", async () => {
		const cwd = await tempCwd();
		const first = new MemoryHarness(cwd);
		await first.input("interactive");
		const chain = await first.buildChain("fault");
		const before = await readFile(getMemoryStorePath(cwd));

		const realFs = createMemoryStoreFs();
		const failingFs: MemoryStoreFs = {
			...realFs,
			rename: async () => {
				throw Object.assign(new Error("injected rename failure"), { code: "EACCES" });
			},
		};
		const failing = new MemoryHarness(cwd, DEFAULT_CONFIG, { storeFs: failingFs });
		await failing.input("interactive");

		await expect(failing.forget({ id: chain.c.id })).rejects.toMatchObject({ code: MEMORY_WRITE_FAILED });
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
		await expect(readdir(getMemoryStoreDirectory(cwd)).then((entries) => entries.sort())).resolves.toEqual([
			MEMORY_STORE_IGNORE_FILE_NAME,
			"store.json",
		]);
	});

	it("aborts before any byte change on a pre-aborted signal", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id } = await h.add("s", "content");
		const before = await readFile(getMemoryStorePath(cwd));

		await expect(
			h.tool(MEMORY_FORGET_TOOL).execute("call-1", { id } as never, AbortSignal.abort(), undefined, h.host.context),
		).rejects.toMatchObject({ code: MEMORY_ABORTED });
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
	});
});

describe("memory_forget concurrency", () => {
	it("serializes a forget with a concurrent add without losing either update", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const chain = await h.buildChain("race");

		const forgetCall = h
			.tool(MEMORY_FORGET_TOOL)
			.execute("f", { id: chain.b.id } as never, undefined, undefined, h.host.context);
		const addCall = h
			.tool(MEMORY_WRITE_TOOL)
			.execute(
				"a",
				{ operation: "add", summary: "racer", content: "racer content" } as never,
				undefined,
				undefined,
				h.host.context,
			);
		const [forgetResult, addResult] = await Promise.all([forgetCall, addCall]);

		expect(asRecord(asRecord(forgetResult).details).outcome).toBe("forgotten");
		expect(asRecord(asRecord(addResult).details).outcome).toBe("added");

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(5);
		expect(persisted.records).toHaveLength(1);
		expect(asRecord(persisted.records[0]).content).toBe("racer content");
	});

	it("serializes concurrent forgets of the same chain so exactly one commits", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const chain = await h.buildChain("double");

		const first = h
			.tool(MEMORY_FORGET_TOOL)
			.execute("f1", { id: chain.c.id } as never, undefined, undefined, h.host.context);
		const second = h
			.tool(MEMORY_FORGET_TOOL)
			.execute("f2", { id: chain.a.id, revision: 1 } as never, undefined, undefined, h.host.context);
		const settled = await Promise.allSettled([first, second]);

		const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
		const rejected = settled.filter((entry) => entry.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		if (rejected[0]?.status === "rejected") {
			if (!(rejected[0].reason instanceof MemoryError)) throw rejected[0].reason;
			expect(rejected[0].reason.code).toBe(MEMORY_FORGET_TARGET_NOT_FOUND);
		}
		if (fulfilled[0]?.status === "fulfilled") {
			expect(asRecord(asRecord(fulfilled[0].value).details).outcome).toBe("forgotten");
		}

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(4);
		expect(persisted.records).toHaveLength(0);
	});

	it("serializes a forget racing a supersede of the same chain into a coherent Store", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const chain = await h.buildChain("racing-supersede");

		const forgetCall = h
			.tool(MEMORY_FORGET_TOOL)
			.execute("f", { id: chain.c.id } as never, undefined, undefined, h.host.context);
		const supersedeCall = h.tool(MEMORY_WRITE_TOOL).execute(
			"w",
			{
				operation: "supersede",
				targetId: chain.c.id,
				targetRevision: chain.c.revision,
				summary: "racing replacement",
				content: "replacement content",
			} as never,
			undefined,
			undefined,
			h.host.context,
		);
		const settled = await Promise.allSettled([forgetCall, supersedeCall]);

		// Either ordering is coherent: if supersede won the race the forget
		// still removed the whole augmented chain; if forget won, the supersede
		// failed closed on a missing target.
		const persisted = await storeJson(cwd);
		const chainIds = new Set([chain.a.id, chain.b.id, chain.c.id]);
		expect(persisted.records.every((record) => !chainIds.has(String(asRecord(record).id)))).toBe(true);
		expect(persisted.revision).toBeGreaterThanOrEqual(3);
		expect(settled.some((entry) => entry.status === "fulfilled")).toBe(true);
	});
});

describe("memory-forget command adapter", () => {
	it("forgets through the same Store transaction without any model-turn authority", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		// No input event at all: invoking the command is the direct explicit user authority.
		const directoryId = await realpath(cwd);
		await seedFile(
			getMemoryStorePath(cwd),
			JSON.stringify({
				version: 1,
				schema: "memory.store.v1",
				revision: 2,
				directory: { id: directoryId },
				records: [
					{
						id: "rec-command-1",
						revision: 1,
						state: "superseded",
						summary: "command base",
						content: "command base content",
						supersedes: null,
						provenance: { sessionId: "session-1", directoryId, author: "primary-agent" },
						createdAt: "2025-01-01T00:00:00.000Z",
						updatedAt: "2025-01-01T00:00:00.000Z",
					},
					{
						id: "rec-command-2",
						revision: 2,
						state: "active",
						summary: "command leaf",
						content: "command leaf content",
						supersedes: { id: "rec-command-1", revision: 1 },
						provenance: { sessionId: "session-1", directoryId, author: "primary-agent" },
						createdAt: "2025-01-01T00:00:00.000Z",
						updatedAt: "2025-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await h.forgetCommand("rec-command-2");

		const notify = h.lastNotify;
		expect(notify).toBeDefined();
		expect(notify?.text).toContain("memory_forget · forgotten");
		expect(notify?.text).toContain("rec-command-1");
		expect(notify?.text).toContain("rec-command-2");
		expect(notify?.text).not.toContain("command leaf content");
		expect(notify?.text).not.toContain("command base content");
		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(3);
		expect(persisted.records).toHaveLength(0);
		expect(before).not.toEqual(await readFile(storePath));
	});

	it("reports usage errors without touching the Store", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const chain = await h.buildChain("usage");
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await h.forgetCommand("");
		await h.forgetCommand(`${chain.a.id} 1 extra`);
		await h.forgetCommand(`${chain.a.id} not-a-revision`);

		expect(h.lastNotify?.level).toBe("error");
		expect(h.lastNotify?.text).toContain(`Usage: /${MEMORY_FORGET_COMMAND}`);
		await expect(readFile(storePath)).resolves.toEqual(before);
	});

	it("reports not-found and Store errors through the command channel", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "content");

		await h.forgetCommand("memory-000000000000000000000000");
		expect(h.lastNotify?.level).toBe("error");
		expect(h.lastNotify?.text).toContain("was not found");

		await seedFile(getMemoryStorePath(cwd), "{not json");
		await h.forgetCommand("memory-000000000000000000000000");
		expect(h.lastNotify?.level).toBe("error");
		expect(h.lastNotify?.text).toContain("not strict JSON");
	});
});

describe("memory_forget receipt contract", () => {
	it("identifies only removed id/revision/state and always carries the honest caveat", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const chain = await h.buildChain("receipt");
		await h.add("unrelated", "unrelated content stays");

		const result = await h.forget({ id: chain.b.id });
		const details = asRecord(result.details);

		// No content-bearing fields anywhere in the structured receipt.
		const serialized = JSON.stringify(details);
		expect(serialized).not.toContain("base content");
		expect(serialized).not.toContain("third content");
		expect(serialized).not.toContain("session-1");
		expect(serialized).not.toContain("provenance");
		expect(serialized).not.toContain("unrelated content stays");

		expect(details.kind).toBe("memory:forget-receipt");
		expect(details.version).toBe(1);
		expect(details.outcome).toBe("forgotten");
		expect(details.count).toBe(3);
		expect(details.previousStoreRevision).toBe(4);
		expect(details.storeRevision).toBe(5);
		expect(details.removed).toEqual([
			{ id: chain.a.id, revision: 1, state: "superseded" },
			{ id: chain.b.id, revision: 2, state: "superseded" },
			{ id: chain.c.id, revision: 3, state: "active" },
		]);

		expect(String(details.caveat)).toBe(MEMORY_FORGET_CAVEAT);

		const text = String((result.content[0] as { text?: string }).text ?? "");
		expect(text).toContain(String(details.caveat));
		expect(text).toContain(chain.a.id);
		expect(text).not.toContain("base content");
	});

	it.each([
		"Pi sessions",
		"backups",
		"provider logs",
		"filesystem snapshots",
		"previously published documentation",
		"Git history",
	])("names %s in the deletion caveat", async (noun) => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id } = await h.add("s", "content");

		const result = await h.forget({ id });

		const caveat = String(asRecord(result.details).caveat);
		expect(caveat).toContain(noun);
		expect(String((result.content[0] as { text?: string }).text ?? "")).toContain(noun);
	});
});

describe("memory_forget mode safety", () => {
	it("forgets in json/print modes without waiting for UI via the tool", async () => {
		for (const mode of ["tui", "rpc", "json", "print"] as const) {
			const cwd = await tempCwd();
			const hasUI = mode === "tui" || mode === "rpc";
			const host = new FakePiHost({ cwd, mode, hasUI });
			registerMemoryExtension(host.api, DEFAULT_CONFIG);
			await host.emit("input", { type: "input", source: "interactive", text: "forget" });

			const write = host.tools.find((candidate) => candidate.name === MEMORY_WRITE_TOOL);
			if (write === undefined) throw new Error("missing write tool");
			await write.execute(
				"w",
				{ operation: "add", summary: "s", content: `content in ${mode}` } as never,
				undefined,
				undefined,
				host.context,
			);
			const id = String((await storeJson(cwd)).records[0]?.id);

			const forget = host.tools.find((candidate) => candidate.name === MEMORY_FORGET_TOOL);
			if (forget === undefined) throw new Error("missing forget tool");
			const result = (await forget.execute("f", { id } as never, undefined, undefined, host.context)) as ToolResult;

			expect(asRecord(result.details).outcome).toBe("forgotten");
			await expect(storeJson(cwd)).resolves.toMatchObject({ records: [] });
		}
	});

	it("runs the command in UI-free modes without notifying or waiting", async () => {
		for (const mode of ["json", "print"] as const) {
			const cwd = await tempCwd();
			const host = new FakePiHost({ cwd, mode, hasUI: false });
			registerMemoryExtension(host.api, DEFAULT_CONFIG);

			// Seed directly: the command carries its own direct user authority.
			await seedFile(
				getMemoryStorePath(cwd),
				JSON.stringify({
					version: 1,
					schema: "memory.store.v1",
					revision: 1,
					directory: { id: await realpath(cwd) },
					records: [
						{
							id: "rec-mode",
							revision: 1,
							state: "active",
							summary: "mode target",
							content: "mode content",
							supersedes: null,
							provenance: { sessionId: "session-1", directoryId: await realpath(cwd), author: "primary-agent" },
							createdAt: "2025-01-01T00:00:00.000Z",
							updatedAt: "2025-01-01T00:00:00.000Z",
						},
					],
				}),
			);

			const command = host.commands.get(MEMORY_FORGET_COMMAND);
			if (command === undefined) throw new Error("missing command");
			await expect(command.handler("rec-mode", host.context)).resolves.toBeUndefined();
			expect(host.ui.notify).not.toHaveBeenCalled();
			await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 2, records: [] });
		}
	});
});

describe("memory_forget TUI renderers", () => {
	const theme = {
		fg: (_color: string, value: string) => value,
		bold: (value: string) => value,
	} as unknown as Theme;

	it("renders compact forget calls and bounded results without raw JSON or deleted content", async () => {
		const cwd = await tempCwd();
		const host = new FakePiHost({ cwd, mode: "tui", hasUI: true });
		registerMemoryExtension(host.api, DEFAULT_CONFIG);
		await host.emit("input", { type: "input", source: "interactive", text: "forget" });
		const write = host.tools.find((candidate) => candidate.name === MEMORY_WRITE_TOOL);
		if (write === undefined) throw new Error("missing write tool");
		await write.execute(
			"w",
			{ operation: "add", summary: "npm workspaces", content: "PRIVATE CONTENT THAT MUST NEVER REAPPEAR" } as never,
			undefined,
			undefined,
			host.context,
		);
		const id = String((await storeJson(cwd)).records[0]?.id);
		const forget = host.tools.find((candidate) => candidate.name === MEMORY_FORGET_TOOL);
		if (forget === undefined) throw new Error("missing forget tool");
		const tool = forget as unknown as {
			renderCall(args: Record<string, unknown>, theme: Theme, context: unknown): { render(width: number): string[] };
			renderResult(
				result: ToolResult,
				options: { readonly expanded: boolean; readonly isPartial: boolean },
				theme: Theme,
				context: { readonly isError: boolean },
			): { render(width: number): string[] };
		};

		const callLines = tool.renderCall({ id, revision: 1 }, theme, host.context).render(120);
		expect(callLines.join("\n")).toContain("memory_forget");
		expect(callLines.join("\n")).toContain(id);
		expect(callLines.length).toBeLessThanOrEqual(2);

		const result = (await forget.execute("f", { id } as never, undefined, undefined, host.context)) as ToolResult;
		const expanded = tool
			.renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false })
			.render(200);
		const expandedText = expanded.join("\n");
		expect(expandedText).toContain(id);
		expect(expandedText).toContain("Pi sessions");
		expect(expandedText).toContain("Git history");
		expect(expandedText).not.toContain("PRIVATE CONTENT THAT MUST NEVER REAPPEAR");

		const collapsed = tool
			.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false })
			.render(40);
		expect(collapsed.length).toBeLessThanOrEqual(4);
		expect(collapsed.join("\n")).toContain("memory_forget");
	});
});

describe("MemoryService.forget boundary (service-level)", () => {
	it("refreshes canonical Directory metadata after a Store move", async () => {
		const cwd = await tempCwd();
		const formerIdentity = await mkdtemp(join(tmpdir(), "memory-forget-former-"));
		await seedFile(
			getMemoryStorePath(cwd),
			JSON.stringify({
				version: 1,
				schema: "memory.store.v1",
				revision: 1,
				directory: { id: formerIdentity },
				records: [
					{
						id: "rec-moved",
						revision: 1,
						state: "active",
						summary: "moved",
						content: "moved content",
						supersedes: null,
						provenance: { sessionId: "session-1", directoryId: formerIdentity, author: "primary-agent" },
						createdAt: "2025-01-01T00:00:00.000Z",
						updatedAt: "2025-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		const result = await h.forget({ id: "rec-moved" });

		expect(asRecord(result.details).outcome).toBe("forgotten");
		const persisted = await storeJson(cwd);
		expect(persisted.directory.id).toBe(await realpath(cwd));
		expect(persisted.revision).toBe(2);
	});
});
