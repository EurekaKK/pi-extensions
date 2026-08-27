import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type MemoryConfigV1 } from "../src/config.js";
import { MEMORY_READ_COMMAND, MEMORY_READ_TOOL, MEMORY_RECORD_NOT_FOUND, MEMORY_WRITE_TOOL } from "../src/constants.js";
import { MemoryError } from "../src/errors.js";
import { registerMemoryExtension } from "../src/index.js";
import { getMemoryStorePath } from "../src/store-layout.js";

interface WriteResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
}

interface ReadResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
}

function asRecord(record: unknown): Record<string, unknown> {
	if (typeof record !== "object" || record === null) throw new Error(`not an object: ${String(record)}`);
	return record as Record<string, unknown>;
}

async function seedFile(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents, "utf8");
}

class MemoryHarness {
	readonly host: FakePiHost;
	readonly cwd: string;

	constructor(cwd: string, config: MemoryConfigV1 = DEFAULT_CONFIG) {
		this.cwd = cwd;
		this.host = new FakePiHost({ cwd, mode: "tui", hasUI: true, sessionId: "session-1" });
		registerMemoryExtension(this.host.api, config);
	}

	async writeSummaryContent(summary: string, content: string): Promise<string> {
		await this.host.emit("input", { type: "input", source: "interactive", text: "remember" });
		const tool = this.host.tools.find((candidate) => candidate.name === MEMORY_WRITE_TOOL);
		if (tool === undefined) throw new Error("missing write tool");
		const result = (await tool.execute(
			"call-w",
			{ operation: "add", summary, content } as never,
			undefined,
			undefined,
			this.host.context,
		)) as WriteResult;
		return String(asRecord(asRecord(result.details).record).id);
	}

	async read(id: string): Promise<ReadResult> {
		const tool = this.host.tools.find((candidate) => candidate.name === MEMORY_READ_TOOL);
		if (tool === undefined) throw new Error("missing read tool");
		return (await tool.execute("call-r", { id } as never, undefined, undefined, this.host.context)) as ReadResult;
	}
}

async function tempCwd(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-read-"));
}

describe("memory_read tool at the loaded seam", () => {
	it("reads the exact persisted record with full content and provenance", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		const id = await h.writeSummaryContent(
			"Build uses npm workspaces",
			"The monorepo uses npm workspaces; never mix pnpm.",
		);

		const result = await h.read(id);

		const details = asRecord(result.details);
		expect(details.found).toBe(true);
		expect(asRecord(details.record).id).toBe(id);
		expect(asRecord(details.record).content).toBe("The monorepo uses npm workspaces; never mix pnpm.");
		const text = String((result.content[0] as { text?: string }).text ?? "");
		expect(text).toContain("memory_read · exact record");
		expect(text).toContain("The monorepo uses npm workspaces; never mix pnpm.");
	});

	it("fails with a stable not-found error for an unknown id or revision", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		const id = await h.writeSummaryContent("s", "content");

		await expect(h.read("memory-ffffffffffffffffffffffff")).rejects.toMatchObject({
			code: MEMORY_RECORD_NOT_FOUND,
		});

		const tool = h.host.tools.find((candidate) => candidate.name === MEMORY_READ_TOOL);
		if (tool === undefined) throw new Error("missing read tool");
		await expect(
			tool.execute("call-r2", { id, revision: 9 } as never, undefined, undefined, h.host.context),
		).rejects.toMatchObject({ code: MEMORY_RECORD_NOT_FOUND });
	});

	it("fails with not-found when no Store exists", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);

		await expect(h.read("memory-anything")).rejects.toMatchObject({ code: MEMORY_RECORD_NOT_FOUND });
	});

	it("fails closed on a corrupt Store without modifying it", async () => {
		const cwd = await tempCwd();
		await seedFile(getMemoryStorePath(cwd), "{not json");

		const h = new MemoryHarness(cwd);
		let code = "";
		let message = "";
		try {
			await h.read("memory-anything");
		} catch (error) {
			if (error instanceof MemoryError) {
				code = error.code;
				message = error.message;
			} else {
				throw error;
			}
		}
		expect(code).toBe("MEMORY_STORE_CORRUPT");
		expect(message).toContain("not strict JSON");
		await expect(readFile(getMemoryStorePath(cwd), "utf8")).resolves.toBe("{not json");
	});

	it("stays readable in a subagent context without write authority checks", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		const id = await h.writeSummaryContent("s", "content");
		h.host.api.appendEntry("subagent:descriptor", { version: 1, depth: 1 });

		await expect(h.read(id)).resolves.toMatchObject({ details: { found: true } });
	});
});

describe("memory-read command at the loaded seam", () => {
	it("prints full content for an exact id and reports errors for unknown ids", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		const id = await h.writeSummaryContent(
			"Build uses npm workspaces",
			"The monorepo uses npm workspaces; never mix pnpm.",
		);

		const command = h.host.commands.get(MEMORY_READ_COMMAND);
		if (command === undefined) throw new Error("missing command");

		await command.handler(id, h.host.context);
		const lastNotify = h.host.ui.notify.mock.calls.at(-1);
		expect(String(lastNotify?.[0] ?? "")).toContain("The monorepo uses npm workspaces; never mix pnpm.");
		expect(lastNotify?.[1]).toBe("info");

		await command.handler("memory-unknown", h.host.context);
		const errorNotify = h.host.ui.notify.mock.calls.at(-1);
		expect(String(errorNotify?.[0] ?? "")).toContain("was not found");
		expect(errorNotify?.[1]).toBe("error");
	});

	it("enforces a stable usage contract for zero or many arguments", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		const command = h.host.commands.get(MEMORY_READ_COMMAND);
		if (command === undefined) throw new Error("missing command");

		await command.handler("", h.host.context);
		expect(String(h.host.ui.notify.mock.calls.at(-1)?.[0] ?? "")).toContain("Usage:");
		await command.handler("a b c", h.host.context);
		expect(String(h.host.ui.notify.mock.calls.at(-1)?.[0] ?? "")).toContain("Usage:");
	});

	it("reads silently without UI in json and print modes", async () => {
		for (const mode of ["json", "print"] as const) {
			const cwd = await tempCwd();
			const host = new FakePiHost({ cwd, mode, hasUI: false });
			registerMemoryExtension(host.api, DEFAULT_CONFIG);
			const command = host.commands.get(MEMORY_READ_COMMAND);
			if (command === undefined) throw new Error("missing command");

			await expect(command.handler("memory-unknown", host.context)).resolves.toBeUndefined();
			expect(host.ui.notify).not.toHaveBeenCalled();
		}
	});
});
