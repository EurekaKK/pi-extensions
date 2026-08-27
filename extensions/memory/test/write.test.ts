import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";

type Executor = (
	toolCallId: string,
	parameters: never,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	context: ExtensionContext,
) => Promise<unknown>;

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type MemoryConfigV1 } from "../src/config.js";
import {
	MEMORY_ABORTED,
	MEMORY_IDENTITY_COLLISION,
	MEMORY_INPUT_REJECTED,
	MEMORY_STATUS_COMMAND,
	MEMORY_STORE_IGNORE_CONTENT,
	MEMORY_STORE_IGNORE_FILE_NAME,
	MEMORY_TARGET_INACTIVE,
	MEMORY_TARGET_NOT_FOUND,
	MEMORY_TARGET_STALE,
	MEMORY_WRITE_DENIED,
	MEMORY_WRITE_TOOL,
} from "../src/constants.js";
import { MemoryError } from "../src/errors.js";
import { registerMemoryExtension } from "../src/index.js";
import { createMemoryStoreFs, type MemoryStoreFs } from "../src/store-io.js";
import { getMemoryStoreDirectory, getMemoryStorePath } from "../src/store-layout.js";
import { storeFixture } from "./fixtures.js";

interface WriteParms {
	readonly operation: "add" | "supersede";
	readonly summary: string;
	readonly content: string;
	readonly targetId?: string;
	readonly targetRevision?: number;
}

interface WriteResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
}

function asRecord(record: unknown): Record<string, unknown> {
	if (typeof record !== "object" || record === null) throw new Error(`not an object: ${String(record)}`);
	return record as Record<string, unknown>;
}

interface PersistedStore {
	readonly revision: number;
	readonly records: readonly Record<string, unknown>[];
}

async function storeJson(cwd: string): Promise<PersistedStore> {
	const text = await readFile(getMemoryStorePath(cwd), "utf8");
	return JSON.parse(text) as PersistedStore;
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
		await this.host.emit("input", { type: "input", source, text: "remember something" });
	}

	writeTool(): { execute: Executor } {
		const tool = this.host.tools.find((candidate) => candidate.name === MEMORY_WRITE_TOOL);
		if (tool === undefined) throw new Error(`missing tool ${MEMORY_WRITE_TOOL}`);
		return tool as unknown as { execute: Executor };
	}

	async write(params: WriteParms): Promise<WriteResult> {
		return (await this.writeTool().execute(
			"call-1",
			params as never,
			undefined,
			undefined,
			this.host.context,
		)) as WriteResult;
	}

	async add(summary: string, content: string): Promise<{ id: string; revision: number }> {
		const result = await this.write({ operation: "add", summary, content });
		const record = asRecord(asRecord(result.details).record);
		return { id: String(record.id), revision: Number(record.revision) };
	}

	async statusText(): Promise<string> {
		const command = this.host.commands.get(MEMORY_STATUS_COMMAND);
		if (command === undefined) throw new Error(`missing command ${MEMORY_STATUS_COMMAND}`);
		await command.handler("", this.host.context);
		const call = this.host.ui.notify.mock.calls.at(-1);
		if (call === undefined) throw new Error("no status notification was emitted");
		return String(call[0]);
	}

	async read(id: string, revision?: number): Promise<WriteResult> {
		const tool = this.host.tools.find((candidate) => candidate.name === "memory_read");
		if (tool === undefined) throw new Error("missing read tool");
		return (await tool.execute(
			"call-r",
			{ id, ...(revision === undefined ? {} : { revision }) } as never,
			undefined,
			undefined,
			this.host.context,
		)) as WriteResult;
	}
}

async function tempCwd(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-write-"));
}

describe("memory_write authority at the loaded seam", () => {
	it("denies before any direct human input and after the run settles", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);

		await expect(h.write({ operation: "add", summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_WRITE_DENIED,
		});

		await h.input("interactive");
		await expect(h.write({ operation: "add", summary: "s", content: "c" })).resolves.toBeDefined();

		await h.host.emit("agent_settled", { type: "agent_settled" });
		await expect(h.write({ operation: "add", summary: "s2", content: "c2" })).rejects.toMatchObject({
			code: MEMORY_WRITE_DENIED,
		});
	});

	it("grants interactive and rpc inputs but extension input revokes inherited authority", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);

		await h.input("interactive");
		await h.input("extension");
		await expect(h.write({ operation: "add", summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_WRITE_DENIED,
		});

		await h.input("rpc");
		await expect(h.write({ operation: "add", summary: "s", content: "c" })).resolves.toBeDefined();
	});

	it("revokes authority when an extension custom message starts a follow-up turn", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.host.emit("message_start", {
			type: "message_start",
			message: { role: "custom", customType: "test:follow-up", content: "continue", timestamp: Date.now() },
		});

		await expect(h.write({ operation: "add", summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_WRITE_DENIED,
		});
	});

	it.each(["session_start", "session_tree", "session_shutdown"] as const)("resets fail-closed at %s", async (event) => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await expect(h.write({ operation: "add", summary: "s", content: "c" })).resolves.toBeDefined();

		await h.host.emit(event, { type: event });

		await expect(h.write({ operation: "add", summary: "s2", content: "c2" })).rejects.toMatchObject({
			code: MEMORY_WRITE_DENIED,
		});
	});

	it("denies proactively when proactiveWrites is disabled by config", async () => {
		const cwd = await tempCwd();
		const config = { ...DEFAULT_CONFIG, proactiveWrites: false };
		const h = new MemoryHarness(cwd, config);
		await h.input("interactive");

		await expect(h.write({ operation: "add", summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_WRITE_DENIED,
		});
	});

	it("denies durably when the branch carries a subagent:descriptor entry (reads stay allowed)", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await expect(
			h.write({ operation: "add", summary: "verified", content: "parent knowledge" }),
		).resolves.toBeDefined();
		const recordId = String((await storeJson(cwd)).records[0]?.id);

		// A durable subagent descriptor is persisted on the branch; the denial
		// survives a lifecycle reset because it is re-read from the branch.
		h.host.api.appendEntry("subagent:descriptor", { version: 1, depth: 1 });
		await h.host.emit("agent_settled", { type: "agent_settled" });

		await expect(h.write({ operation: "add", summary: "child", content: "child knowledge" })).rejects.toMatchObject({
			code: MEMORY_WRITE_DENIED,
		});

		const readTool = h.host.tools.find((tool) => tool.name === "memory_read");
		if (readTool === undefined) throw new Error("missing read tool");
		await expect(
			readTool.execute("call-2", { id: recordId } as never, undefined, undefined, h.host.context),
		).resolves.toMatchObject({ details: { found: true } });
	});
});

describe("memory_write first write and receipt", () => {
	it("creates the Store directory, scoped ignore marker, and store.json with a full-content receipt", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		const result = await h.write({
			operation: "add",
			summary: "Build uses npm workspaces",
			content: "The monorepo is managed with npm workspaces; never mix pnpm or Yarn.",
		});

		const receipt = asRecord(result.details);
		expect(receipt.outcome).toBe("added");
		expect(receipt.storeRevision).toBe(1);
		const record = asRecord(receipt.record);
		expect(record.id).toMatch(/^memory-[0-9a-f]{24}$/u);
		expect(record.revision).toBe(1);
		expect(record.state).toBe("active");
		expect(record.content).toBe("The monorepo is managed with npm workspaces; never mix pnpm or Yarn.");
		const provenance = asRecord(record.provenance);
		expect(provenance.author).toBe("primary-agent");
		expect(provenance.sessionId).toBe("session-1");
		expect(provenance.directoryId).toBe(await realpath(cwd));
		// No branch entries exist yet: `entryId` is omitted rather than null.
		expect(provenance.entryId).toBeUndefined();

		const contentText = String((result.content[0] as { text?: string }).text ?? "");
		expect(contentText).toContain("memory_write · added");
		expect(contentText).toContain("The monorepo is managed with npm workspaces; never mix pnpm or Yarn.");

		const storeDir = getMemoryStoreDirectory(cwd);
		await expect(readFile(join(storeDir, MEMORY_STORE_IGNORE_FILE_NAME), "utf8")).resolves.toBe(
			`${MEMORY_STORE_IGNORE_CONTENT}\n`,
		);
		await expect(readdir(storeDir).then((entries) => entries.sort())).resolves.toEqual([
			MEMORY_STORE_IGNORE_FILE_NAME,
			"store.json",
		]);
		if (process.platform !== "win32") {
			expect((await lstat(storeDir)).mode & 0o777).toBe(0o700);
			expect((await lstat(getMemoryStorePath(cwd))).mode & 0o777).toBe(0o600);
		}
		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(1);
		expect(persisted.records).toHaveLength(1);
	});

	it("creates a missing scoped ignore marker before appending to an existing healthy Store", async () => {
		const cwd = await tempCwd();
		await seedFile(
			getMemoryStorePath(cwd),
			JSON.stringify({ version: 1, schema: "memory.store.v1", revision: 0, directory: { id: cwd }, records: [] }),
		);
		const markerPath = join(getMemoryStoreDirectory(cwd), MEMORY_STORE_IGNORE_FILE_NAME);
		await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await h.write({ operation: "add", summary: "s", content: "content" });

		await expect(readFile(markerPath, "utf8")).resolves.toBe(`${MEMORY_STORE_IGNORE_CONTENT}\n`);
	});

	it("preserves a user-maintained ignore marker and reports a no-op duplicate without touching the Store", async () => {
		const cwd = await tempCwd();
		const storeDir = getMemoryStoreDirectory(cwd);
		await seedFile(join(storeDir, MEMORY_STORE_IGNORE_FILE_NAME), "# user marker\n");

		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const params = { operation: "add" as const, summary: "s", content: "first content" };
		await h.write(params);
		await expect(readFile(join(storeDir, MEMORY_STORE_IGNORE_FILE_NAME), "utf8")).resolves.toBe("# user marker\n");

		const storePath = getMemoryStorePath(cwd);
		if (process.platform !== "win32") await chmod(storePath, 0o644);
		const before = await readFile(storePath);
		const duplicate = await h.write(params);

		expect(asRecord(duplicate.details).outcome).toBe("no-op");
		await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 1 });
		await expect(readFile(storePath)).resolves.toEqual(before);
		if (process.platform !== "win32") expect((await lstat(storePath)).mode & 0o777).toBe(0o600);
	});

	it("records immutable provenance with the current leaf entry when available", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		h.host.appendCustomMessageEntry("test:seed", "seed context", false);
		const leafBefore = h.host.context.sessionManager.getLeafId();
		await h.input("interactive");

		const result = await h.write({ operation: "add", summary: "s", content: "c" });

		const provenance = asRecord(asRecord(asRecord(result.details).record).provenance);
		expect(provenance.entryId).toBe(leafBefore);
	});
});

describe("memory_write capture policy", () => {
	async function rejection(content: string, summary: string): Promise<Record<string, unknown>> {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		try {
			await h.write({ operation: "add", summary, content });
			throw new Error("expected rejection");
		} catch (error) {
			if (error instanceof MemoryError) return { code: error.code, message: error.message };
			throw error;
		}
	}

	it("rejects blank content and summary", async () => {
		expect((await rejection("   ", "s")).code).toBe(MEMORY_INPUT_REJECTED);
		expect((await rejection("c", "   ")).code).toBe(MEMORY_INPUT_REJECTED);
	});

	it("rejects unsupported control characters", async () => {
		expect((await rejection("a\u0000b", "s")).code).toBe(MEMORY_INPUT_REJECTED);
		expect((await rejection("a\u001bb", "s")).code).toBe(MEMORY_INPUT_REJECTED);
		expect((await rejection("s", "a\u0007b")).code).toBe(MEMORY_INPUT_REJECTED);
	});

	it("allows tab and newline in content", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await expect(h.write({ operation: "add", summary: "s", content: "line one\n\tline two" })).resolves.toMatchObject({
			details: { outcome: "added" },
		});
	});

	it("rejects secret-like content conservatively", async () => {
		expect((await rejection("use key sk-abcDEF1234ghIJK5678xyz123456789 here", "s")).code).toBe(MEMORY_INPUT_REJECTED);
		expect((await rejection("creds", "token AKIAIOSFODNN7EXAMPLE")).code).toBe(MEMORY_INPUT_REJECTED);
	});

	it("rejects content and summary beyond configured char limits", async () => {
		expect((await rejection("x".repeat(DEFAULT_CONFIG.store.maxContentChars + 1), "s")).code).toBe(
			MEMORY_INPUT_REJECTED,
		);
		expect((await rejection("c", "y".repeat(DEFAULT_CONFIG.store.maxSummaryChars + 1))).code).toBe(
			MEMORY_INPUT_REJECTED,
		);
	});
});

describe("memory_write normalization and idempotence", () => {
	it("treats CRLF/CR and precomposed/decomposed Unicode as exact duplicates", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		const first = await h.write({ operation: "add", summary: "s", content: "a\r\nb e\u0301" });
		expect(asRecord(first.details).outcome).toBe("added");

		const second = await h.write({ operation: "add", summary: "s", content: "a\nb \u00e9" });
		expect(asRecord(second.details).outcome).toBe("no-op");

		const storeFile = await readFile(getMemoryStorePath(cwd));
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(storeFile);
		await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 1 });
	});

	it("adds a distinct record when the content or summary differs", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await h.write({ operation: "add", summary: "s", content: "content A" });
		await h.write({ operation: "add", summary: "s", content: "content B" });
		await h.write({ operation: "add", summary: "other", content: "content A" });

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(3);
		expect(persisted.records).toHaveLength(3);
	});
});

describe("memory_write fail-closed Store handling", () => {
	it("fails closed on a corrupt Store and never treats it as empty", async () => {
		const cwd = await tempCwd();
		await seedFile(getMemoryStorePath(cwd), "{not json");

		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		let code = "";
		try {
			await h.write({ operation: "add", summary: "s", content: "c" });
		} catch (error) {
			code = error instanceof MemoryError ? error.code : "";
		}
		expect(code).toBe("MEMORY_STORE_CORRUPT");
		await expect(readFile(getMemoryStorePath(cwd), "utf8")).resolves.toBe("{not json");
	});

	it("fails closed on an unsupported Store version", async () => {
		const cwd = await tempCwd();
		await seedFile(getMemoryStorePath(cwd), JSON.stringify({ ...storeFixture(), version: 2 }));
		const before = await readFile(getMemoryStorePath(cwd));

		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		let code = "";
		try {
			await h.write({ operation: "add", summary: "s", content: "c" });
		} catch (error) {
			code = error instanceof MemoryError ? error.code : "";
		}
		expect(code).toBe("MEMORY_STORE_UNSUPPORTED_VERSION");
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
	});

	it("continues writing after the Directory moves and refreshes its canonical metadata", async () => {
		const cwd = await tempCwd();
		const formerIdentity = await mkdtemp(join(tmpdir(), "memory-former-"));
		await seedFile(
			getMemoryStorePath(cwd),
			JSON.stringify({
				version: 1,
				schema: "memory.store.v1",
				revision: 0,
				directory: { id: formerIdentity },
				records: [],
			}),
		);

		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await expect(h.write({ operation: "add", summary: "s", content: "c" })).resolves.toMatchObject({
			details: { outcome: "added", storeRevision: 1 },
		});
		const persisted = JSON.parse(await readFile(getMemoryStorePath(cwd), "utf8")) as {
			readonly directory: { readonly id: string };
		};
		expect(persisted.directory.id).toBe(await realpath(cwd));
	});

	it("keeps the prior Store authoritative when a loaded-extension commit fails", async () => {
		const cwd = await tempCwd();
		const first = new MemoryHarness(cwd);
		await first.input("interactive");
		await first.write({ operation: "add", summary: "one", content: "first" });
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

		await expect(failing.write({ operation: "add", summary: "two", content: "second" })).rejects.toMatchObject({
			code: "MEMORY_WRITE_FAILED",
		});
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
		expect((await readdir(getMemoryStoreDirectory(cwd))).some((entry) => entry.endsWith(".tmp"))).toBe(false);
	});

	it("rejects over the configured record-count limit", async () => {
		const cwd = await tempCwd();
		const config = { ...DEFAULT_CONFIG, store: { ...DEFAULT_CONFIG.store, maxRecords: 1 } };
		const h = new MemoryHarness(cwd, config);
		await h.input("interactive");

		await expect(h.write({ operation: "add", summary: "one", content: "1" })).resolves.toMatchObject({
			details: { outcome: "added" },
		});
		let code = "";
		try {
			await h.write({ operation: "add", summary: "two", content: "2" });
		} catch (error) {
			code = error instanceof MemoryError ? error.code : "";
		}
		expect(code).toBe("MEMORY_STORE_OVER_LIMIT");
		await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 1 });
	});

	it("aborts before touching the Store on a pre-aborted signal", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await expect(
			h
				.writeTool()
				.execute(
					"call-1",
					{ operation: "add", summary: "s", content: "c" } as never,
					AbortSignal.abort(),
					undefined,
					h.host.context,
				),
		).rejects.toMatchObject({ code: MEMORY_ABORTED });

		await expect(realpath(cwd).then((p) => p)).resolves.toBeDefined();
		const { readdir: readdirAsync } = await import("node:fs/promises");
		await expect(readdirAsync(cwd)).resolves.toEqual([]);
	});
});

describe("memory_write concurrency", () => {
	it("serializes concurrent writes so no update is lost", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const tool = h.writeTool();

		const first = tool.execute(
			"a",
			{ operation: "add", summary: "a", content: "alpha" } as never,
			undefined,
			undefined,
			h.host.context,
		);
		const second = tool.execute(
			"b",
			{ operation: "add", summary: "b", content: "beta" } as never,
			undefined,
			undefined,
			h.host.context,
		);
		const [ra, rb] = await Promise.all([first, second]);

		expect(asRecord((ra as { details?: unknown }).details).outcome).toBe("added");
		expect(asRecord((rb as { details?: unknown }).details).outcome).toBe("added");

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(2);
		expect(persisted.records).toHaveLength(2);
	});
});

describe("memory_write directory identity", () => {
	it("writes through a symlink alias into the canonical Store and provenance", async () => {
		const root = await tempCwd();
		const real = join(root, "real");
		const alias = join(root, "alias");
		await mkdir(real);
		await symlink(real, alias);

		const h = new MemoryHarness(alias);
		await h.input("interactive");
		const result = await h.write({ operation: "add", summary: "s", content: "alias content" });

		expect(asRecord(result.details).outcome).toBe("added");
		const provenance = asRecord(asRecord(asRecord(result.details).record).provenance);
		expect(provenance.directoryId).toBe(await realpath(real));
		await expect(readFile(join(real, ".pi", "memory", "store.json"), "utf8")).resolves.toContain("alias content");
		expect((await storeJson(real)).records).toHaveLength(1);
	});

	it("fails with a stable identity error when the Working Directory is missing", async () => {
		const root = await tempCwd();
		const cwd = join(root, "absent");
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await expect(h.write({ operation: "add", summary: "s", content: "c" })).rejects.toMatchObject({
			code: "MEMORY_DIRECTORY_IDENTITY_FAILED",
		});
	});
});

describe("memory_write mode safety", () => {
	it("writes in json/print modes without waiting for UI", async () => {
		for (const mode of ["tui", "rpc", "json", "print"] as const) {
			const cwd = await tempCwd();
			const hasUI = mode === "tui" || mode === "rpc";
			const host = new FakePiHost({ cwd, mode, hasUI });
			registerMemoryExtension(host.api, DEFAULT_CONFIG);
			await host.emit("input", { type: "input", source: "interactive", text: "remember" });

			const tool = host.tools.find((candidate) => candidate.name === MEMORY_WRITE_TOOL);
			if (tool === undefined) throw new Error("missing write tool");
			const result = (await tool.execute(
				"call-1",
				{ operation: "add", summary: "s", content: `content in ${mode}` } as never,
				undefined,
				undefined,
				host.context,
			)) as WriteResult;

			expect(asRecord(result.details).outcome).toBe("added");
			const persisted = await storeJson(cwd);
			expect(persisted.records[0]?.content).toBe(`content in ${mode}`);
			await expect(readdir(getMemoryStoreDirectory(cwd))).resolves.toContain("store.json");
		}
	});
});

describe("memory_write supersede at the loaded seam", () => {
	it("appends an immutable successor, supersedes only the target, and returns a dual-record receipt", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id: targetId, revision: targetRevision } = await h.add(
			"npm workspaces",
			"The monorepo is managed with npm workspaces; never mix pnpm or Yarn.",
		);

		const result = await h.write({
			operation: "supersede",
			targetId,
			targetRevision,
			summary: "npm workspaces (corrected)",
			content: "The monorepo is managed with npm workspaces; pnpm is allowed in strict mode.",
		});

		const receipt = asRecord(result.details);
		expect(receipt.operation).toBe("supersede");
		expect(receipt.outcome).toBe("superseded");
		expect(receipt.previousStoreRevision).toBe(1);
		expect(receipt.storeRevision).toBe(2);

		const record = asRecord(receipt.record);
		expect(record.id).toMatch(/^memory-[0-9a-f]{24}$/u);
		expect(record.id).not.toBe(targetId);
		expect(record.revision).toBe(2);
		expect(record.state).toBe("active");
		expect(record.supersedes).toEqual({ id: targetId, revision: 1 });
		expect(asRecord(record.provenance).author).toBe("primary-agent");

		// The receipt identifies both the replacement and the replaced record.
		const replaced = asRecord(receipt.replaced);
		expect(replaced.id).toBe(targetId);
		expect(replaced.revision).toBe(1);
		expect(replaced.state).toBe("superseded");
		expect(replaced.content).toBe("The monorepo is managed with npm workspaces; never mix pnpm or Yarn.");

		const contentText = String((result.content[0] as { text?: string }).text ?? "");
		expect(contentText).toContain("memory_write · superseded");
		expect(contentText).toContain("The monorepo is managed with npm workspaces; never mix pnpm or Yarn.");
		expect(contentText).toContain("The monorepo is managed with npm workspaces; pnpm is allowed in strict mode.");
		expect(contentText).toContain(`Supersedes: ${targetId} revision 1`);
		expect(contentText).toContain("Replaced record");

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(2);
		expect(persisted.records).toHaveLength(2);
		const oldRecord = persisted.records.find((candidate) => candidate.id === targetId);
		if (oldRecord === undefined) throw new Error("target record missing");
		expect(asRecord(oldRecord).state).toBe("superseded");
		// Historical content and provenance are preserved untouched.
		expect(asRecord(oldRecord).content).toBe("The monorepo is managed with npm workspaces; never mix pnpm or Yarn.");
	});

	it("builds a multi-step chain where only the leaf stays active and revision is monotonic", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const first = await h.add("base", "base content");
		const second = await h.write({
			operation: "supersede",
			targetId: first.id,
			targetRevision: first.revision,
			summary: "second",
			content: "second content",
		});
		const secondRecord = asRecord(asRecord(second.details).record);
		const third = await h.write({
			operation: "supersede",
			targetId: String(secondRecord.id),
			targetRevision: Number(secondRecord.revision),
			summary: "third",
			content: "third content",
		});
		const thirdRecord = asRecord(asRecord(third.details).record);
		expect(thirdRecord.revision).toBe(3);

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(3);
		expect(persisted.records).toHaveLength(3);
		const states = new Map(persisted.records.map((record) => [String(asRecord(record).id), asRecord(record).state]));
		expect(states.get(first.id)).toBe("superseded");
		expect(states.get(String(secondRecord.id))).toBe("superseded");
		expect(states.get(String(thirdRecord.id))).toBe("active");

		const statusText = await h.statusText();
		expect(statusText).toContain("Store revision: 3");
		expect(statusText).toContain("Records: 1 active · 2 superseded");
	});

	it("treats an identical normalized replacement as a transactional no-op", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id: targetId } = await h.add(
			"npm workspaces",
			"The monorepo uses npm workspaces; never mix pnpm.\nKeep going.",
		);
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		// CRLF folding normalizes to the exact target text (\n vs \r\n).
		const result = await h.write({
			operation: "supersede",
			targetId,
			targetRevision: 1,
			summary: "npm workspaces",
			content: "The monorepo uses npm workspaces; never mix pnpm.\r\nKeep going.",
		});

		const receipt = asRecord(result.details);
		expect(receipt.operation).toBe("supersede");
		expect(receipt.outcome).toBe("no-op");
		expect(receipt.record).toMatchObject({ id: targetId, revision: 1, state: "active" });
		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(storeJson(cwd)).resolves.toMatchObject({ revision: 1 });
		const contentText = String((result.content[0] as { text?: string }).text ?? "");
		expect(contentText).toContain("identical");
	});

	it("rejects a missing target with a stable error and no byte changes", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "content");
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await expect(
			h.write({
				operation: "supersede",
				targetId: "memory-000000000000000000000000",
				targetRevision: 1,
				summary: "s",
				content: "replacement",
			}),
		).rejects.toMatchObject({ code: MEMORY_TARGET_NOT_FOUND });
		await expect(readFile(storePath)).resolves.toEqual(before);
	});

	it("rejects a stale revision of an existing target with no byte changes", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id: targetId } = await h.add("base", "content A");
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await expect(
			h.write({
				operation: "supersede",
				targetId,
				targetRevision: 9,
				summary: "other",
				content: "content B",
			}),
		).rejects.toMatchObject({ code: MEMORY_TARGET_STALE });
		await expect(readFile(storePath)).resolves.toEqual(before);
	});

	it("rejects an already-superseded target with no byte changes", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id: targetId } = await h.add("base", "content A");
		await h.write({
			operation: "supersede",
			targetId,
			targetRevision: 1,
			summary: "corrected",
			content: "content B",
		});
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await expect(
			h.write({
				operation: "supersede",
				targetId,
				targetRevision: 1,
				summary: "again",
				content: "content C",
			}),
		).rejects.toMatchObject({ code: MEMORY_TARGET_INACTIVE });
		await expect(readFile(storePath)).resolves.toEqual(before);
	});

	it("rejects a replacement whose derived identity already exists under another record", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id: targetId } = await h.add("A", "alpha content");
		await h.add("B", "beta content");
		const storePath = getMemoryStorePath(cwd);
		const markerPath = join(getMemoryStoreDirectory(cwd), MEMORY_STORE_IGNORE_FILE_NAME);
		await rm(markerPath);
		const before = await readFile(storePath);

		// The normalized replacement equals the sibling record's text, so its
		// derived identity would collide; the mutation is rejected as ambiguous.
		await expect(
			h.write({
				operation: "supersede",
				targetId,
				targetRevision: 1,
				summary: "B",
				content: "beta content",
			}),
		).rejects.toMatchObject({ code: MEMORY_IDENTITY_COLLISION });
		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects add that carries target fields through semantic validation", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await expect(
			h.write({
				operation: "add",
				summary: "s",
				content: "c",
				targetId: "memory-000000000000000000000000",
			}),
		).rejects.toMatchObject({ code: MEMORY_INPUT_REJECTED });
		await expect(
			h.write({
				operation: "add",
				summary: "s",
				content: "c",
				targetRevision: 1,
			}),
		).rejects.toMatchObject({ code: MEMORY_INPUT_REJECTED });
		await expect(readdir(cwd)).resolves.toEqual([]);
	});

	it("requires both target fields for supersede through semantic validation", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		await h.add("s", "content");
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await expect(h.write({ operation: "supersede", targetId: "x", summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_INPUT_REJECTED,
		});
		await expect(
			h.write({ operation: "supersede", targetRevision: 1, summary: "s", content: "c" }),
		).rejects.toMatchObject({ code: MEMORY_INPUT_REJECTED });
		await expect(readFile(storePath)).resolves.toEqual(before);
	});

	it("applies capture policy to replacement content and summary", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id: targetId } = await h.add("s", "content");
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		await expect(
			h.write({
				operation: "supersede",
				targetId,
				targetRevision: 1,
				summary: "s",
				content: "use key sk-abcDEF1234ghIJK5678xyz123456789",
			}),
		).rejects.toMatchObject({ code: MEMORY_INPUT_REJECTED });
		await expect(
			h.write({
				operation: "supersede",
				targetId,
				targetRevision: 1,
				summary: "   ",
				content: "replacement",
			}),
		).rejects.toMatchObject({ code: MEMORY_INPUT_REJECTED });
		await expect(readFile(storePath)).resolves.toEqual(before);
	});

	it("fails closed on targets when no Store exists yet", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");

		await expect(
			h.write({
				operation: "supersede",
				targetId: "memory-000000000000000000000000",
				targetRevision: 1,
				summary: "s",
				content: "c",
			}),
		).rejects.toMatchObject({ code: MEMORY_TARGET_NOT_FOUND });
		await expect(readdir(cwd)).resolves.toEqual([]);
	});

	it("serializes concurrent supersedes of one target so only one commits", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id: targetId, revision: targetRevision } = await h.add("base", "content A");
		const tool = h.writeTool();

		const first = tool.execute(
			"a",
			{ operation: "supersede", targetId, targetRevision, summary: "alpha", content: "content B" } as never,
			undefined,
			undefined,
			h.host.context,
		);
		const second = tool.execute(
			"b",
			{ operation: "supersede", targetId, targetRevision, summary: "beta", content: "content C" } as never,
			undefined,
			undefined,
			h.host.context,
		);
		const [ra, rb] = await Promise.allSettled([first, second]);

		const fulfilled = ra.status === "fulfilled" ? ra.value : rb.status === "fulfilled" ? rb.value : undefined;
		const rejected = ra.status === "rejected" ? ra.reason : rb.status === "rejected" ? rb.reason : undefined;
		expect(fulfilled).toBeDefined();
		expect(rejected).toBeDefined();
		if (fulfilled !== undefined) expect(asRecord(asRecord(fulfilled).details).outcome).toBe("superseded");
		if (rejected !== undefined) {
			if (!(rejected instanceof MemoryError)) throw rejected;
			expect(rejected.code).toBe(MEMORY_TARGET_INACTIVE);
		}

		const persisted = await storeJson(cwd);
		expect(persisted.revision).toBe(2);
		expect(persisted.records).toHaveLength(2);
		const active = persisted.records.filter((record) => asRecord(record).state === "active");
		expect(active).toHaveLength(1);
	});

	it("keeps the prior Store bytes authoritative when a supersession commit fails at the loaded seam", async () => {
		const cwd = await tempCwd();
		const first = new MemoryHarness(cwd);
		await first.input("interactive");
		const { id: targetId } = await first.add("base", "content A");
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

		await expect(
			failing.write({
				operation: "supersede",
				targetId,
				targetRevision: 1,
				summary: "corrected",
				content: "content B",
			}),
		).rejects.toMatchObject({ code: "MEMORY_WRITE_FAILED" });
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
		await expect(readdir(getMemoryStoreDirectory(cwd)).then((entries) => entries.sort())).resolves.toEqual([
			MEMORY_STORE_IGNORE_FILE_NAME,
			"store.json",
		]);
	});

	it("aborts a supersession before any byte change on a pre-aborted signal", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id: targetId } = await h.add("base", "content A");
		const before = await readFile(getMemoryStorePath(cwd));

		await expect(
			h
				.writeTool()
				.execute(
					"call-1",
					{ operation: "supersede", targetId, targetRevision: 1, summary: "s", content: "c" } as never,
					AbortSignal.abort(),
					undefined,
					h.host.context,
				),
		).rejects.toMatchObject({ code: MEMORY_ABORTED });
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
	});

	it("lets exact reads inspect the active leaf and an explicitly addressed superseded revision", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		await h.input("interactive");
		const { id: targetId } = await h.add("npm workspaces", "The monorepo uses npm workspaces; never mix pnpm.");
		const supersededResult = await h.write({
			operation: "supersede",
			targetId,
			targetRevision: 1,
			summary: "npm workspaces (corrected)",
			content: "The monorepo uses npm workspaces; pnpm is allowed in strict mode.",
		});
		const leafId = String(asRecord(asRecord(supersededResult.details).record).id);

		// Exact read of the superseded revision preserves its historical state and content.
		const historical = await h.read(targetId, 1);
		const historicalDetails = asRecord(historical.details);
		expect(asRecord(historicalDetails.record).state).toBe("superseded");
		expect(asRecord(historicalDetails.record).revision).toBe(1);
		expect(asRecord(historicalDetails.record).content).toBe("The monorepo uses npm workspaces; never mix pnpm.");

		// The active leaf carries its relationship metadata.
		const leaf = await h.read(leafId);
		const leafDetails = asRecord(leaf.details);
		expect(asRecord(leafDetails.record).state).toBe("active");
		expect(asRecord(leafDetails.record).revision).toBe(2);
		expect(asRecord(leafDetails.record).supersedes).toEqual({ id: targetId, revision: 1 });
	});
});
