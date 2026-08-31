import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type MemoryConfigV1 } from "../src/config.js";
import {
	MEMORY_ABORTED,
	MEMORY_LIST_COMMAND,
	MEMORY_READ_TOOL,
	MEMORY_SEARCH_COMMAND,
	MEMORY_SEARCH_INPUT_REJECTED,
	MEMORY_SEARCH_TOOL,
	MEMORY_STORE_CORRUPT,
	MEMORY_STORE_OVER_LIMIT,
	MEMORY_STORE_UNAVAILABLE,
	MEMORY_STORE_UNSUPPORTED_VERSION,
	MEMORY_WRITE_DENIED,
	MEMORY_WRITE_TOOL,
} from "../src/constants.js";
import { MemoryError } from "../src/errors.js";
import { registerMemoryExtension } from "../src/index.js";
import { getMemoryStorePath } from "../src/store-layout.js";

interface ToolResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
}

function asRecord(record: unknown): Record<string, unknown> {
	if (typeof record !== "object" || record === null) throw new Error(`not an object: ${String(record)}`);
	return record as Record<string, unknown>;
}

interface SeedRecordSpec {
	readonly id: string;
	readonly revision?: number;
	readonly state?: "active" | "superseded";
	readonly summary: string;
	readonly content: string;
	readonly supersedes?: { readonly id: string; readonly revision: number } | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

function seededRecord(spec: SeedRecordSpec, directoryId: string): Record<string, unknown> {
	return {
		id: spec.id,
		revision: spec.revision ?? 1,
		state: spec.state ?? "active",
		summary: spec.summary,
		content: spec.content,
		supersedes: spec.supersedes ?? null,
		provenance: { author: "primary-agent", directoryId, sessionId: "session-1" },
		createdAt: spec.createdAt,
		updatedAt: spec.updatedAt,
	};
}

async function seedStore(
	cwd: string,
	specs: readonly SeedRecordSpec[],
	options: { readonly revision?: number } = {},
): Promise<void> {
	const directoryId = await realpath(cwd);
	const store = {
		version: 1,
		schema: "memory.store.v1",
		revision: options.revision ?? Math.max(0, specs.length),
		directory: { id: directoryId },
		records: specs.map((spec) => seededRecord(spec, directoryId)),
	};
	await mkdir(dirname(getMemoryStorePath(cwd)), { recursive: true });
	await writeFile(getMemoryStorePath(cwd), JSON.stringify(store, null, 2), "utf8");
}

async function seedRawStore(cwd: string, contents: string): Promise<void> {
	await mkdir(dirname(getMemoryStorePath(cwd)), { recursive: true });
	await writeFile(getMemoryStorePath(cwd), contents, "utf8");
}

function withRecall(config: MemoryConfigV1, overrides: Partial<MemoryConfigV1["recall"]>): MemoryConfigV1 {
	return { ...config, recall: { ...config.recall, ...overrides } };
}

function withStoreBytes(config: MemoryConfigV1, maxStoreBytes: number): MemoryConfigV1 {
	return { ...config, store: { ...config.store, maxStoreBytes } };
}

class MemoryHarness {
	readonly host: FakePiHost;
	readonly cwd: string;

	constructor(cwd: string, config: MemoryConfigV1 = DEFAULT_CONFIG) {
		this.cwd = cwd;
		this.host = new FakePiHost({ cwd, mode: "tui", hasUI: true, sessionId: "session-1" });
		registerMemoryExtension(this.host.api, config);
	}

	async add(summary: string, content: string): Promise<string> {
		await this.host.emit("input", { type: "input", source: "interactive", text: "remember" });
		const tool = this.host.tools.find((candidate) => candidate.name === MEMORY_WRITE_TOOL);
		if (tool === undefined) throw new Error("missing write tool");
		const result = (await tool.execute(
			"call-w",
			{ operation: "add", summary, content } as never,
			undefined,
			undefined,
			this.host.context,
		)) as ToolResult;
		return String(asRecord(asRecord(result.details).record).id);
	}

	async search(query: string, limit?: number): Promise<ToolResult> {
		return this.searchWithSignal(query, limit, undefined);
	}

	async searchWithSignal(
		query: string,
		limit: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		const tool = this.host.tools.find((candidate) => candidate.name === MEMORY_SEARCH_TOOL);
		if (tool === undefined) throw new Error("missing search tool");
		return (await tool.execute(
			"call-s",
			{ query, ...(limit === undefined ? {} : { limit }) } as never,
			signal,
			undefined,
			this.host.context,
		)) as ToolResult;
	}

	async read(id: string, revision?: number): Promise<ToolResult> {
		const tool = this.host.tools.find((candidate) => candidate.name === MEMORY_READ_TOOL);
		if (tool === undefined) throw new Error("missing read tool");
		return (await tool.execute(
			"call-r",
			{ id, ...(revision === undefined ? {} : { revision }) } as never,
			undefined,
			undefined,
			this.host.context,
		)) as ToolResult;
	}

	async storeBytes(): Promise<string> {
		return readFile(getMemoryStorePath(this.cwd), "utf8");
	}
}

async function tempCwd(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-search-"));
}

function failureCode(promise: Promise<unknown>): Promise<string> {
	return promise.then(
		() => {
			throw new Error("expected the operation to fail");
		},
		(error) => {
			if (error instanceof MemoryError) return error.code;
			throw error;
		},
	);
}

describe("memory_search prompt metadata", () => {
	it("uses a lexical pointer, a deliberate recall workflow, and field-local query guidance", async () => {
		const h = new MemoryHarness(await tempCwd());
		const tool = h.host.tools.find((candidate) => candidate.name === MEMORY_SEARCH_TOOL);
		if (tool === undefined) throw new Error(`missing tool ${MEMORY_SEARCH_TOOL}`);

		expect(String(tool.description)).toBe(
			"Search active records in the current Working Directory's Memory Store using deterministic lexical ranking. Returns compact metadata; superseded records are retrievable only through exact `memory_read`.",
		);
		expect(tool.promptGuidelines ?? []).toEqual([
			"Use memory_search when prior directory knowledge may affect the task but is not already in context; call memory_read on each hit you intend to rely on.",
		]);

		const properties = asRecord(asRecord(tool.parameters).properties);
		expect(String(asRecord(properties.query).description)).toBe(
			"Distinctive keywords likely to appear in the record summary or content; matching is lexical, not semantic.",
		);
		expect(String(asRecord(properties.limit).description)).toBe(
			"Maximum matches to return; deployment configuration may apply a lower cap.",
		);
	});
});

describe("memory_search tool at the loaded seam", () => {
	it("searches active records with ranked compact hits carrying identity, revision, summary, provenance, score, and timestamps but never full content", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-npm",
				revision: 1,
				summary: "Build uses npm workspaces",
				content: "The monorepo is managed with npm workspaces; never mix pnpm or Yarn.",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd);

		const result = await h.search("npm");

		const details = asRecord(result.details);
		expect(details.kind).toBe("memory:search-result");
		expect(details.version).toBe(1);
		expect(details.query).toBe("npm");
		expect(details.matchedCount).toBe(1);
		expect(details.returnedCount).toBe(1);
		expect(details.omittedCount).toBe(0);
		expect(details.truncated).toBe(false);
		const hits = details.hits as readonly Record<string, unknown>[];
		expect(hits).toHaveLength(1);
		const hit = asRecord(hits[0]);
		expect(hit.id).toBe("rec-npm");
		expect(hit.revision).toBe(1);
		expect(hit.state).toBe("active");
		expect(hit.summary).toBe("Build uses npm workspaces");
		expect(hit.score).toBeGreaterThan(0);
		expect(asRecord(hit.provenance).author).toBe("primary-agent");
		expect(typeof hit.createdAt).toBe("string");
		expect(typeof hit.updatedAt).toBe("string");
		expect("content" in hit).toBe(false);

		const text = String((result.content[0] as { text?: string }).text ?? "");
		expect(text).toContain("memory_search");
		expect(text).toContain("1 matches");
		expect(text).toContain("rec-npm");
		expect(text).toContain("Build uses npm workspaces");
		expect(text).not.toContain("never mix pnpm");
	});

	it("returns zero matches for a query with no lexical overlap instead of filling the budget with recent records", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-recent",
				revision: 1,
				summary: "recent unrelated",
				content: "nothing in common",
				createdAt: "2025-02-01T00:00:00.000Z",
				updatedAt: "2025-02-01T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd);

		const result = await h.search("zzzz");
		const details = asRecord(result.details);
		expect(details.matchedCount).toBe(0);
		expect(details.hits).toEqual([]);
		expect(String((result.content[0] as { text?: string }).text ?? "")).toContain("0 matches");
	});

	it("orders by relevance first and uses recency only as a deterministic tie-breaker", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-old-summary",
				revision: 1,
				summary: "npm workspaces build",
				content: "unrelated body",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				id: "rec-new-content",
				revision: 1,
				summary: "unrelated topic",
				content: "npm workspaces",
				createdAt: "2025-01-03T00:00:00.000Z",
				updatedAt: "2025-01-03T00:00:00.000Z",
			},
			{
				id: "rec-mid-summary",
				revision: 1,
				summary: "npm registry",
				content: "unrelated body",
				createdAt: "2025-01-02T00:00:00.000Z",
				updatedAt: "2025-01-02T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd);

		const result = await h.search("npm");
		const hits = (asRecord(result.details).hits as readonly Record<string, unknown>[]).map((hit) =>
			String(asRecord(hit).id),
		);
		// Summary matches (score 2) beat content-only matches (score 1) even when
		// much older; equal scores fall back to recency (mid beats old), and the
		// recent content-only record cannot be promoted over an older summary match.
		expect(hits).toEqual(["rec-mid-summary", "rec-old-summary", "rec-new-content"]);
	});

	it("never returns superseded records while exact reads can still inspect them", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-old",
				revision: 1,
				state: "superseded",
				summary: "npm workspaces",
				content: "The monorepo uses npm workspaces; never mix pnpm.",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				id: "rec-new",
				revision: 2,
				summary: "npm workspaces (corrected)",
				content: "The monorepo uses npm workspaces; pnpm is allowed in strict mode.",
				supersedes: { id: "rec-old", revision: 1 },
				createdAt: "2025-01-02T00:00:00.000Z",
				updatedAt: "2025-01-02T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd);

		const result = await h.search("workspaces");
		const hits = (asRecord(result.details).hits as readonly Record<string, unknown>[]).map((hit) =>
			String(asRecord(hit).id),
		);
		expect(hits).toEqual(["rec-new"]);

		const historical = await h.read("rec-old", 1);
		const historicalRecord = asRecord(asRecord(historical.details).record);
		expect(historicalRecord.state).toBe("superseded");
		expect(historicalRecord.content).toBe("The monorepo uses npm workspaces; never mix pnpm.");
	});

	it("supports Chinese and mixed CJK/Latin queries", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-zh",
				revision: 1,
				summary: "测试记忆",
				content: "中文记忆的测试内容",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				id: "rec-mixed",
				revision: 1,
				summary: "TDD的测试",
				content: "mixed CJK Latin content",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				id: "rec-en",
				revision: 1,
				summary: "TDD workflow",
				content: "plain latin",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd);

		// Per-character tokens give partial credit for shared characters, so the
		// exactly-matching record ranks first and the partially-overlapping
		// mixed record follows — deterministic, never recency-driven.
		const zh = await h.search("测试记忆");
		const zhHits = (asRecord(zh.details).hits as readonly Record<string, unknown>[]).map((hit) =>
			String(asRecord(hit).id),
		);
		expect(zhHits).toEqual(["rec-zh", "rec-mixed"]);

		// "TDD的" partial tokens (tdd, 的) hit every record deterministically:
		// the summary-covered mixed record first, then the Latin tdd match, then
		// the content-only 的 match — partial-match scoring, never recency.
		const mixed = await h.search("TDD的");
		const mixedHits = (asRecord(mixed.details).hits as readonly Record<string, unknown>[]).map((hit) =>
			String(asRecord(hit).id),
		);
		expect(mixedHits).toEqual(["rec-mixed", "rec-en", "rec-zh"]);
	});

	it("bounds returned records by the configured recall budget and an explicit limit with explicit omitted counts", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-a",
				revision: 1,
				summary: "npm one",
				content: "x",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				id: "rec-b",
				revision: 1,
				summary: "npm two",
				content: "x",
				createdAt: "2025-01-02T00:00:00.000Z",
				updatedAt: "2025-01-02T00:00:00.000Z",
			},
			{
				id: "rec-c",
				revision: 1,
				summary: "npm three",
				content: "x",
				createdAt: "2025-01-03T00:00:00.000Z",
				updatedAt: "2025-01-03T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd, withRecall(DEFAULT_CONFIG, { maxRecords: 2 }));

		const capped = await h.search("npm");
		const cappedDetails = asRecord(capped.details);
		expect(cappedDetails.appliedLimit).toBe(2);
		expect(cappedDetails.returnedCount).toBe(2);
		expect(cappedDetails.omittedCount).toBe(1);
		expect(String((capped.content[0] as { text?: string }).text ?? "")).toContain("1 omitted");

		const requested = await h.search("npm", 1);
		const requestedDetails = asRecord(requested.details);
		expect(requestedDetails.requestedLimit).toBe(1);
		expect(requestedDetails.appliedLimit).toBe(1);
		expect(requestedDetails.returnedCount).toBe(1);
		expect(requestedDetails.omittedCount).toBe(2);

		const clamped = await h.search("npm", 99);
		const clampedDetails = asRecord(clamped.details);
		expect(clampedDetails.requestedLimit).toBe(99);
		expect(clampedDetails.appliedLimit).toBe(2);
		expect(clampedDetails.returnedCount).toBe(2);
	});

	it("truncates the rendered text at the configured character budget with explicit truncated counts", async () => {
		const cwd = await tempCwd();
		const longSummary = "npm ".repeat(40).trim();
		await seedStore(cwd, [
			{
				id: "rec-a",
				revision: 1,
				summary: longSummary,
				content: "x",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				id: "rec-b",
				revision: 1,
				summary: longSummary,
				content: "x",
				createdAt: "2025-01-02T00:00:00.000Z",
				updatedAt: "2025-01-02T00:00:00.000Z",
			},
			{
				id: "rec-c",
				revision: 1,
				summary: longSummary,
				content: "x",
				createdAt: "2025-01-03T00:00:00.000Z",
				updatedAt: "2025-01-03T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd, withRecall(DEFAULT_CONFIG, { maxChars: 300 }));

		const result = await h.search("npm");
		const details = asRecord(result.details);
		expect(details.returnedCount).toBe(3);
		expect(details.omittedCount).toBe(0);
		expect(details.truncated).toBe(true);
		expect(Number(details.truncatedCount)).toBe(3);
		const text = String((result.content[0] as { text?: string }).text ?? "");
		expect(Array.from(text).length).toBeLessThanOrEqual(300);
		// Every entry is independently larger than this deterministic budget, so
		// the environment-dependent Directory path length cannot change the count.
		expect(text).not.toContain("1. rec-");
		expect(text).toContain("3 more matches not shown (character budget 300)");
	});

	it("keeps even an overlong header inside a tiny configured character budget", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-a",
				revision: 1,
				summary: "npm workspaces",
				content: "npm content",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd, withRecall(DEFAULT_CONFIG, { maxChars: 20 }));

		const result = await h.search("npm workspaces");
		const text = String((result.content[0] as { text?: string }).text ?? "");
		expect(Array.from(text)).toHaveLength(20);
		expect(text.endsWith("…")).toBe(true);
		expect(asRecord(result.details).truncatedCount).toBe(1);
	});

	it("rejects invalid queries and limits with a stable prefixed error and no Store mutation", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-a",
				revision: 1,
				summary: "npm workspaces",
				content: "x",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd);
		const before = await h.storeBytes();

		await expect(failureCode(h.search("   "))).resolves.toBe(MEMORY_SEARCH_INPUT_REJECTED);
		await expect(failureCode(h.search("a\tb"))).resolves.toBe(MEMORY_SEARCH_INPUT_REJECTED);
		await expect(failureCode(h.search("a\nb"))).resolves.toBe(MEMORY_SEARCH_INPUT_REJECTED);
		await expect(failureCode(h.search("a\u0085b"))).resolves.toBe(MEMORY_SEARCH_INPUT_REJECTED);
		await expect(failureCode(h.search("x".repeat(201)))).resolves.toBe(MEMORY_SEARCH_INPUT_REJECTED);
		// FakePiHost does not run TypeBox validation, so invalid limits reach the
		// service-level guard (defense in depth behind the tool schema).
		await expect(failureCode(h.search("npm", 0))).resolves.toBe(MEMORY_SEARCH_INPUT_REJECTED);
		await expect(failureCode(h.search("npm", 1.5))).resolves.toBe(MEMORY_SEARCH_INPUT_REJECTED);
		await expect(h.storeBytes()).resolves.toBe(before);
	});

	it("fails closed on corrupt, over-byte-limit, unsupported-version, and unreadable Stores without modifying them", async () => {
		const corruptCwd = await tempCwd();
		await seedRawStore(corruptCwd, "{not json");
		const corrupt = new MemoryHarness(corruptCwd);
		await expect(failureCode(corrupt.search("npm"))).resolves.toBe(MEMORY_STORE_CORRUPT);
		await expect(corrupt.storeBytes()).resolves.toBe("{not json");

		const bigCwd = await tempCwd();
		await seedStore(bigCwd, [
			{
				id: "rec-huge",
				revision: 1,
				summary: "npm workspaces",
				content: "c".repeat(1_500),
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
		]);
		const big = new MemoryHarness(bigCwd, withStoreBytes(DEFAULT_CONFIG, 1_024));
		const bigBefore = await big.storeBytes();
		await expect(failureCode(big.search("npm"))).resolves.toBe(MEMORY_STORE_OVER_LIMIT);
		await expect(big.storeBytes()).resolves.toBe(bigBefore);

		const unsupportedCwd = await tempCwd();
		await seedRawStore(
			unsupportedCwd,
			JSON.stringify({
				version: 99,
				schema: "memory.store.v99",
				revision: 0,
				directory: { id: await realpath(unsupportedCwd) },
				records: [],
			}),
		);
		const unsupported = new MemoryHarness(unsupportedCwd);
		await expect(failureCode(unsupported.search("npm"))).resolves.toBe(MEMORY_STORE_UNSUPPORTED_VERSION);

		const unreadableCwd = await tempCwd();
		await mkdir(getMemoryStorePath(unreadableCwd), { recursive: true });
		const unreadable = new MemoryHarness(unreadableCwd);
		await expect(failureCode(unreadable.search("npm"))).resolves.toBe(MEMORY_STORE_UNAVAILABLE);
	});

	it("aborts on a pre-aborted signal without touching the Store", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-a",
				revision: 1,
				summary: "npm workspaces",
				content: "x",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd);
		const before = await h.storeBytes();
		const aborted = new AbortController();
		aborted.abort();

		await expect(failureCode(h.searchWithSignal("npm", undefined, aborted.signal))).resolves.toBe(MEMORY_ABORTED);
		await expect(h.storeBytes()).resolves.toBe(before);
	});

	it("searches and reads in subagent contexts while writes stay denied", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);
		const id = await h.add("npm workspaces", "monorepo build knowledge");
		h.host.api.appendEntry("subagent:descriptor", { version: 1, depth: 1 });

		const result = await h.search("npm");
		const hits = (asRecord(result.details).hits as readonly Record<string, unknown>[]).map((hit) =>
			String(asRecord(hit).id),
		);
		expect(hits).toContain(id);

		const read = await h.read(id);
		expect(asRecord(asRecord(read.details).record).content).toBe("monorepo build knowledge");

		const write = h.host.tools.find((candidate) => candidate.name === MEMORY_WRITE_TOOL);
		if (write === undefined) throw new Error("missing write tool");
		await expect(
			write.execute(
				"call-w",
				{ operation: "add", summary: "s", content: "c" } as never,
				undefined,
				undefined,
				h.host.context,
			),
		).rejects.toMatchObject({ code: MEMORY_WRITE_DENIED });
	});

	it("returns the same structured contract in tui, rpc, json, and print modes without waiting for UI", async () => {
		for (const mode of ["tui", "rpc", "json", "print"] as const) {
			const cwd = await tempCwd();
			await seedStore(cwd, [
				{
					id: "rec-a",
					revision: 1,
					summary: "npm workspaces",
					content: "monorepo knowledge",
					createdAt: "2025-01-01T00:00:00.000Z",
					updatedAt: "2025-01-01T00:00:00.000Z",
				},
			]);
			const host = new FakePiHost({ cwd, mode, hasUI: false });
			registerMemoryExtension(host.api, DEFAULT_CONFIG);
			const tool = host.tools.find((candidate) => candidate.name === MEMORY_SEARCH_TOOL);
			if (tool === undefined) throw new Error("missing search tool");

			const result = (await tool.execute(
				"call-s",
				{ query: "npm" } as never,
				undefined,
				undefined,
				host.context,
			)) as ToolResult;
			const details = asRecord(result.details);
			expect(details.kind).toBe("memory:search-result");
			expect((asRecord(details).hits as readonly Record<string, unknown>[])[0]?.id).toBe("rec-a");
			expect(String((result.content[0] as { text?: string }).text ?? "")).toContain("rec-a");
		}
	});
});

describe("memory-search command at the loaded seam", () => {
	async function commandHost(cwd: string): Promise<{ host: FakePiHost; handler: (args: string) => unknown }> {
		const host = new FakePiHost({ cwd, mode: "tui", hasUI: true });
		registerMemoryExtension(host.api, DEFAULT_CONFIG);
		const command = host.commands.get(MEMORY_SEARCH_COMMAND);
		if (command === undefined) throw new Error("missing command");
		return { host, handler: (args) => command.handler(args, host.context) };
	}

	function lastNotify(host: FakePiHost): string {
		const call = host.ui.notify.mock.calls.at(-1);
		if (call === undefined) throw new Error("no notification was emitted");
		return String(call[0]);
	}

	it("searches a multi-word query and an explicit --limit flag through the shared Store path", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-a",
				revision: 1,
				summary: "npm workspaces build",
				content: "x",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				id: "rec-b",
				revision: 1,
				summary: "npm registry",
				content: "x",
				createdAt: "2025-01-02T00:00:00.000Z",
				updatedAt: "2025-01-02T00:00:00.000Z",
			},
			{
				id: "rec-c",
				revision: 1,
				summary: "registry configuration",
				content: "x",
				createdAt: "2025-01-03T00:00:00.000Z",
				updatedAt: "2025-01-03T00:00:00.000Z",
			},
		]);
		const { host, handler } = await commandHost(cwd);

		await handler("npm");
		const text = lastNotify(host);
		expect(text).toContain("2 matches");
		expect(text).toContain("rec-a");

		await handler("npm workspaces");
		const multi = lastNotify(host);
		// OR-over-tokens: the record containing only "npm" still matches, ranked
		// below the record containing both terms; the registry-only record does not.
		expect(multi).toContain("2 matches");
		expect(multi.indexOf("1. rec-a")).toBeLessThan(multi.indexOf("2. rec-b"));
		expect(multi).not.toContain("rec-c");

		await handler("npm --limit 1");
		const limited = lastNotify(host);
		expect(limited).toContain("(limit 1");
		expect(limited).toContain("1 omitted");
	});

	it("treats numeric query tokens as query text, not limits (no positional ambiguity)", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-a",
				revision: 1,
				summary: "issue 42",
				content: "x",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
		]);
		const { host, handler } = await commandHost(cwd);

		await handler("issue 42");
		const text = lastNotify(host);
		expect(text).toContain('for "issue 42"');
		expect(text).toContain("1 matches");
	});

	it("reports a stable usage contract for empty, dangling, duplicate, and invalid --limit arguments", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-a",
				revision: 1,
				summary: "npm workspaces",
				content: "x",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
		]);
		const { host, handler } = await commandHost(cwd);

		for (const args of ["", "--limit", "--limit x", "--limit 1 --limit 2"]) {
			await handler(args);
			expect(lastNotify(host)).toContain("Usage:");
		}
	});

	it("reports stable Store failures through notify", async () => {
		const cwd = await tempCwd();
		await seedRawStore(cwd, "{not json");
		const { host, handler } = await commandHost(cwd);

		await handler("npm");
		const call = host.ui.notify.mock.calls.at(-1);
		expect(String(call?.[0] ?? "")).toContain("not strict JSON");
		expect(call?.[1]).toBe("error");
	});
});

describe("memory-list command at the loaded seam", () => {
	async function commandHost(
		cwd: string,
		config: MemoryConfigV1 = DEFAULT_CONFIG,
	): Promise<{ host: FakePiHost; handler: (args: string) => unknown }> {
		const host = new FakePiHost({ cwd, mode: "tui", hasUI: true });
		registerMemoryExtension(host.api, config);
		const command = host.commands.get(MEMORY_LIST_COMMAND);
		if (command === undefined) throw new Error("missing command");
		return { host, handler: (args) => command.handler(args, host.context) };
	}

	function lastNotify(host: FakePiHost): string {
		const call = host.ui.notify.mock.calls.at(-1);
		if (call === undefined) throw new Error("no notification was emitted");
		return String(call[0]);
	}

	it("lists only active records, most recently updated first, without full content", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-old",
				revision: 1,
				state: "superseded",
				summary: "npm workspaces",
				content: "superseded content that must stay out of the listing",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				id: "rec-mid",
				revision: 1,
				summary: "build system",
				content: "mid content",
				createdAt: "2025-01-02T00:00:00.000Z",
				updatedAt: "2025-01-02T00:00:00.000Z",
			},
			{
				id: "rec-new",
				revision: 2,
				summary: "npm workspaces (corrected)",
				content: "new content",
				supersedes: { id: "rec-old", revision: 1 },
				createdAt: "2025-01-03T00:00:00.000Z",
				updatedAt: "2025-01-03T00:00:00.000Z",
			},
		]);
		const { host, handler } = await commandHost(cwd);

		await handler("");
		const text = lastNotify(host);
		expect(text).toContain("2 active records");
		expect(text.indexOf("rec-new")).toBeLessThan(text.indexOf("rec-mid"));
		expect(text).not.toContain("rec-old");
		expect(text).not.toContain("superseded content");
	});

	it("applies an explicit limit with explicit omitted counts and rejects invalid usage", async () => {
		const cwd = await tempCwd();
		const specs = [1, 2, 3].map((n) => ({
			id: `rec-${n}`,
			revision: 1,
			summary: `record ${n}`,
			content: "x",
			createdAt: `2025-01-0${n}T00:00:00.000Z`,
			updatedAt: `2025-01-0${n}T00:00:00.000Z`,
		}));
		await seedStore(cwd, specs);
		const { host, handler } = await commandHost(cwd, withRecall(DEFAULT_CONFIG, { maxRecords: 2 }));

		await handler("1");
		const limited = lastNotify(host);
		expect(limited).toContain("3 active records");
		expect(limited).toContain("(limit 1");
		expect(limited).toContain("2 omitted");

		await handler("1 2");
		expect(lastNotify(host)).toContain("Usage:");
		await handler("x");
		expect(lastNotify(host)).toContain("Usage:");
	});

	it("fails closed on a corrupt Store with a stable error", async () => {
		const cwd = await tempCwd();
		await seedRawStore(cwd, "{not json");
		const { host, handler } = await commandHost(cwd);

		await handler("");
		const call = host.ui.notify.mock.calls.at(-1);
		expect(String(call?.[0] ?? "")).toContain("not strict JSON");
		expect(call?.[1]).toBe("error");
	});

	it("completes silently without UI in json and print modes", async () => {
		for (const mode of ["json", "print"] as const) {
			const cwd = await tempCwd();
			await seedStore(cwd, [
				{
					id: "rec-a",
					revision: 1,
					summary: "npm workspaces",
					content: "x",
					createdAt: "2025-01-01T00:00:00.000Z",
					updatedAt: "2025-01-01T00:00:00.000Z",
				},
			]);
			const host = new FakePiHost({ cwd, mode, hasUI: false });
			registerMemoryExtension(host.api, DEFAULT_CONFIG);
			const command = host.commands.get(MEMORY_LIST_COMMAND);
			if (command === undefined) throw new Error("missing command");

			await expect(command.handler("", host.context)).resolves.toBeUndefined();
			await expect(command.handler("1", host.context)).resolves.toBeUndefined();
			expect(host.ui.notify).not.toHaveBeenCalled();
		}
	});
});

describe("memory_search compact/expanded TUI renderers", () => {
	const theme = {
		fg: (_color: string, value: string) => value,
		bold: (value: string) => value,
	} as unknown as Theme;

	interface RenderableSearchTool {
		renderCall(args: Record<string, unknown>, theme: Theme, context: unknown): { render(width: number): string[] };
		renderResult(
			result: ToolResult,
			options: { readonly expanded: boolean; readonly isPartial: boolean },
			theme: Theme,
			context: { readonly isError: boolean },
		): { render(width: number): string[] };
	}

	function searchTool(host: FakePiHost): RenderableSearchTool {
		const tool = host.tools.find((candidate) => candidate.name === MEMORY_SEARCH_TOOL);
		if (tool === undefined) throw new Error("missing search tool");
		return tool as unknown as RenderableSearchTool;
	}

	it("renders a compact single-line call and bounded compact results, with full text only when expanded", async () => {
		const cwd = await tempCwd();
		await seedStore(cwd, [
			{
				id: "rec-a",
				revision: 1,
				summary: "npm workspaces build",
				content: "The monorepo is managed with npm workspaces; never mix pnpm or Yarn.",
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
		]);
		const h = new MemoryHarness(cwd);
		const tool = searchTool(h.host);

		const callLines = tool.renderCall({ query: "npm", limit: 3 }, theme, h.host.context).render(120);
		const callText = callLines.join("\n");
		expect(callText).toContain("memory_search");
		expect(callText).toContain("npm");
		expect(callText).toContain("limit 3");

		const result = await h.search("npm");
		const expanded = tool
			.renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false })
			.render(200);
		const expandedText = expanded.join("\n");
		expect(expandedText).toContain("rec-a");
		expect(expandedText).toContain("score");
		expect(expandedText).toContain("npm workspaces build");
		expect(expandedText).toContain("Provenance:");

		const collapsed = tool
			.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false })
			.render(40);
		expect(collapsed.length).toBeLessThanOrEqual(4);
		expect(collapsed.join("\n")).toContain("memory_search");
		expect(collapsed.join("\n")).not.toContain("never mix pnpm");
	});
});

describe("memory search/list shared read-only boundary", () => {
	it("never creates a Store or any file for pure search/list on an empty directory", async () => {
		const cwd = await tempCwd();
		const h = new MemoryHarness(cwd);

		const result = await h.search("npm");
		expect(asRecord(result.details).matchedCount).toBe(0);

		const host = new FakePiHost({ cwd, mode: "tui", hasUI: true });
		registerMemoryExtension(host.api, DEFAULT_CONFIG);
		const command = host.commands.get(MEMORY_LIST_COMMAND);
		if (command === undefined) throw new Error("missing command");
		await command.handler("", host.context);

		await expect(readFile(getMemoryStorePath(cwd), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		// Even the Store directory itself must never be created by read-only search/list.
		await expect(lstat(dirname(getMemoryStorePath(cwd)))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
