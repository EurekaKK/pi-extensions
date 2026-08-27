import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type CustomMessageEntry,
	type ExtensionContext,
	type SessionEntry,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type MemoryConfigV1 } from "../src/config.js";
import { MEMORY_RECALL_CUSTOM_TYPE, MEMORY_WRITE_TOOL } from "../src/constants.js";
import { registerMemoryExtension } from "../src/index.js";
import type { MemoryRecallReceiptV1 } from "../src/recall.js";
import { MemoryRecall, recordFingerprint } from "../src/recall.js";
import type { MemoryRecordV1 } from "../src/store.js";
import { getMemoryStorePath } from "../src/store-layout.js";
import {
	collectVisibleRecallFingerprints,
	extractReceiptFingerprints,
	isStructuredRecallReceipt,
} from "../src/visible.js";
import { provenanceFixture, recordFixture } from "./fixtures.js";

interface RecallMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details?: MemoryRecallReceiptV1;
}

function recallMessageFromResult(value: unknown): RecallMessage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const message = (value as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) return undefined;
	const candidate = message as { customType?: unknown; content?: unknown; display?: unknown; details?: unknown };
	if (candidate.customType !== MEMORY_RECALL_CUSTOM_TYPE) return undefined;
	if (typeof candidate.content !== "string" || typeof candidate.display !== "boolean") return undefined;
	return {
		customType: candidate.customType,
		content: candidate.content,
		display: candidate.display,
		...(candidate.details === undefined ? {} : { details: candidate.details as MemoryRecallReceiptV1 }),
	};
}

async function tempCwd(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-recall-visible-"));
}

async function seedStoreAt(cwd: string, records: readonly MemoryRecordV1[] = []): Promise<void> {
	const path = getMemoryStorePath(cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		JSON.stringify(
			{
				version: 1,
				schema: "memory.store.v1",
				revision: records.length,
				directory: { id: await realpath(cwd) },
				records,
			},
			null,
			2,
		),
		"utf8",
	);
}

async function writeStoreAt(cwd: string, document: object): Promise<void> {
	const path = getMemoryStorePath(cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(document, null, 2), "utf8");
}

class RecallHarness {
	readonly host: FakePiHost;
	readonly cwd: string;
	readonly config: MemoryConfigV1;

	constructor(cwd: string, config: MemoryConfigV1 = DEFAULT_CONFIG, options: { readonly sessionId?: string } = {}) {
		this.cwd = cwd;
		this.config = config;
		this.host = new FakePiHost({
			cwd,
			mode: "tui",
			hasUI: true,
			sessionId: options.sessionId ?? "session-1",
		});
		registerMemoryExtension(this.host.api, config, { withFileMutationQueue });
	}

	async input(text: string): Promise<void> {
		await this.host.emit("input", { type: "input", source: "interactive", text });
	}

	async recall(prompt = "something"): Promise<RecallMessage | undefined> {
		const results = await this.host.emitResults("before_agent_start", {
			type: "before_agent_start",
			prompt,
			systemPrompt: "",
			systemPromptOptions: {},
		});
		for (const result of results) {
			const message = recallMessageFromResult(result);
			if (message !== undefined) return message;
		}
		return undefined;
	}

	async write(
		operation: "add" | "supersede",
		params: {
			readonly summary: string;
			readonly content: string;
			readonly targetId?: string;
			readonly targetRevision?: number;
		},
	): Promise<{ details?: { record?: MemoryRecordV1; replaced?: MemoryRecordV1 } }> {
		const tool = this.host.tools.find((candidate) => candidate.name === MEMORY_WRITE_TOOL);
		if (tool === undefined) throw new Error(`missing tool ${MEMORY_WRITE_TOOL}`);
		return (await tool.execute(
			"call-w",
			{ operation, ...params } as never,
			undefined,
			undefined,
			this.host.context,
		)) as { details?: { record?: MemoryRecordV1; replaced?: MemoryRecordV1 } };
	}
}

/** Emulate Pi persisting the before_agent_start handler-result message as session context. */
function persistRecallMessage(host: FakePiHost, message: RecallMessage): string {
	return host.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
}

/** Assert a recall message exists for the persisted-context fixtures. */
function expectRecall(message: RecallMessage | undefined): RecallMessage {
	if (message === undefined) throw new Error("expected a recall message");
	return message;
}

/** Cast one session entry into the fake host's raw append shape for tree fixtures. */
function asRecord(entry: SessionEntry): Record<string, unknown> {
	return entry as unknown as Record<string, unknown>;
}

function entryBase(
	id: string,
	parentId: string | null,
): { readonly id: string; readonly parentId: string | null; readonly timestamp: string } {
	return { id, parentId, timestamp: "2025-01-01T00:00:00.000Z" };
}

function messageEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		...entryBase(id, parentId),
		message: { role: "user", content: "continued", timestamp: 0 },
	} as SessionEntry;
}

function compactionEntry(id: string, parentId: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		...entryBase(id, parentId),
		summary: "compacted",
		firstKeptEntryId,
		tokensBefore: 1_000,
	} as SessionEntry;
}

function receiptEntry(id: string, parentId: string | null, message: RecallMessage): SessionEntry {
	return {
		type: "custom_message",
		...entryBase(id, parentId),
		customType: message.customType,
		content: message.content,
		display: message.display,
		details: message.details,
	} as SessionEntry;
}

describe("visible recall receipt details (pure helpers)", () => {
	it("recognizes only structured v1 recall receipts with the exact custom type", () => {
		const receipt = {
			kind: MEMORY_RECALL_CUSTOM_TYPE,
			version: 1,
			directory: "/tmp/memory-dir",
			query: "workspaces",
			ranking: { appliedLimit: 8, matchedCount: 1 },
			budgets: { maxRecords: 8, maxChars: 6_000 },
			selections: [
				{
					id: "rec-1",
					revision: 1,
					provenance: provenanceFixture(),
					summary: "Build uses npm workspaces",
					score: 4,
					fingerprint: "a".repeat(64),
				},
			],
			counts: { matched: 1, selected: 1, visibleOmitted: 0, recordOmitted: 0, characterOmitted: 0 },
			truncated: false,
		};
		expect(isStructuredRecallReceipt(receipt)).toBe(true);
		expect(isStructuredRecallReceipt({ ...receipt, kind: "memory:other-receipt" })).toBe(false);
		expect(isStructuredRecallReceipt({ ...receipt, version: 2 })).toBe(false);
		expect(isStructuredRecallReceipt({ ...receipt, directory: "" })).toBe(false);
		expect(isStructuredRecallReceipt({ ...receipt, query: 7 })).toBe(false);
		expect(isStructuredRecallReceipt({ ...receipt, selections: "nope" })).toBe(false);
		for (const value of [null, "text", 7, undefined, [], { kind: MEMORY_RECALL_CUSTOM_TYPE }]) {
			expect(isStructuredRecallReceipt(value)).toBe(false);
		}
	});

	it("extracts only valid sha256 fingerprints, skipping corrupt selection entries fail-soft", () => {
		const hex64 = "b".repeat(64);
		const valid = extractReceiptFingerprints({
			kind: MEMORY_RECALL_CUSTOM_TYPE,
			version: 1,
			directory: "/tmp/memory-dir",
			query: "q",
			selections: [
				{ fingerprint: hex64 },
				null,
				"not-an-object",
				{ fingerprint: "not-hex" },
				{ fingerprint: "abc" },
				{},
				{ fingerprint: hex64.toUpperCase() },
			],
		});
		expect(valid).toEqual([hex64]);
		expect(extractReceiptFingerprints("garbage")).toBeUndefined();
		expect(extractReceiptFingerprints({ kind: "other", version: 1, selections: [] })).toBeUndefined();
	});

	it("collects fingerprints across receipts while ignoring other custom types and plain custom entries", () => {
		const hex = "c".repeat(64);
		const hex2 = "d".repeat(64);
		const entries: SessionEntry[] = [
			messageEntry("e1", null),
			{
				type: "custom",
				...entryBase("e2", "e1"),
				customType: "another:extension",
				data: { kind: MEMORY_RECALL_CUSTOM_TYPE, version: 1, selections: [{ fingerprint: hex2 }] },
			} as SessionEntry,
			{
				type: "custom_message",
				...entryBase("e3", "e2"),
				customType: "another:extension",
				content: "looks like a recall receipt",
				display: true,
				details: { kind: MEMORY_RECALL_CUSTOM_TYPE, version: 1, selections: [{ fingerprint: hex2 }] },
			} as CustomMessageEntry,
			{
				type: "custom_message",
				...entryBase("e4", "e3"),
				customType: MEMORY_RECALL_CUSTOM_TYPE,
				content: "display text must never be parsed",
				display: true,
				details: {
					kind: MEMORY_RECALL_CUSTOM_TYPE,
					version: 1,
					directory: "/tmp/memory-dir",
					query: "q",
					selections: [{ fingerprint: hex }, { fingerprint: "garbage" }],
				},
			} as CustomMessageEntry,
		];
		expect([...collectVisibleRecallFingerprints(entries)]).toEqual([hex]);
	});
});

describe("automatic recall visible-fingerprint deduplication at the loaded seam", () => {
	it("omits an unchanged visible record after the handler-result message is persisted as context", async () => {
		const cwd = await tempCwd();
		await seedStoreAt(cwd, [recordFixture({ summary: "remember something", content: "remember something once" })]);
		const h = new RecallHarness(cwd);

		await h.input("remember something");
		const first = await h.recall();
		expect(first?.details?.counts).toEqual({
			matched: 1,
			selected: 1,
			visibleOmitted: 0,
			recordOmitted: 0,
			characterOmitted: 0,
		});
		persistRecallMessage(h.host, expectRecall(first));

		// The same prompt again: the unchanged fingerprint is already model-visible.
		await h.input("remember something");
		expect(await h.recall()).toBeUndefined();
		expect(h.host.ui.notify).not.toHaveBeenCalled();

		// A query that matches a NEW record still recalls that record.
		await h.write("add", { summary: "tortoises", content: "tortoises move slowly but steadily" });
		await h.input("tortoises");
		const second = await h.recall();
		expect(second?.details?.selections[0]?.summary).toBe("tortoises");
	});

	it("is silent when every relevant current fingerprint is already visible and reports deterministic counts otherwise", async () => {
		const cwd = await tempCwd();
		const records = [
			recordFixture({ id: "rec-1", summary: "build workspaces", content: "build workspaces one" }),
			recordFixture({ id: "rec-2", summary: "test workspaces", content: "test workspaces two" }),
			recordFixture({ id: "rec-3", summary: "deploy workspaces", content: "deploy workspaces three" }),
		];
		await seedStoreAt(cwd, records);
		const h = new RecallHarness(cwd);

		await h.input("workspaces");
		const first = await h.recall();
		expect(first?.details?.counts).toEqual({
			matched: 3,
			selected: 3,
			visibleOmitted: 0,
			recordOmitted: 0,
			characterOmitted: 0,
		});
		persistRecallMessage(h.host, expectRecall(first));

		await h.input("workspaces");
		expect(await h.recall()).toBeUndefined();
	});

	it("deduplicates before the record budget so unseen lower-ranked matches backfill", async () => {
		const cwd = await tempCwd();
		const records = [
			recordFixture({ id: "rec-1", summary: "build workspaces", content: "build workspaces one" }),
			recordFixture({ id: "rec-2", summary: "test workspaces", content: "test workspaces two" }),
			recordFixture({ id: "rec-3", summary: "deploy workspaces", content: "deploy workspaces three" }),
		];
		await seedStoreAt(cwd, records);
		const config = { ...DEFAULT_CONFIG, recall: { maxRecords: 2, maxChars: DEFAULT_CONFIG.recall.maxChars } };
		const h = new RecallHarness(cwd, config);

		await h.input("workspaces");
		const first = await h.recall();
		expect(first?.details?.counts).toEqual({
			matched: 3,
			selected: 2,
			visibleOmitted: 0,
			recordOmitted: 1,
			characterOmitted: 0,
		});
		expect(first?.details?.selections.map((s) => s.id).sort()).toEqual(["rec-1", "rec-2"]);
		persistRecallMessage(h.host, expectRecall(first));

		// rec-3 was ranked below the record budget; now that rec-1/rec-2 are
		// visible, the unseen rec-3 backfills into the budget instead of being
		// lost — visible omission is reported separately from the record budget.
		await h.input("workspaces");
		const second = await h.recall();
		expect(second?.details?.counts).toEqual({
			matched: 3,
			selected: 1,
			visibleOmitted: 2,
			recordOmitted: 0,
			characterOmitted: 0,
		});
		expect(second?.details?.selections.map((s) => s.id)).toEqual(["rec-3"]);
		expect(second?.content).toContain("deploy workspaces three");
		expect(second?.content).toContain("2 records already visible in context, omitted");
	});

	it("recalls a changed/tampered record fingerprint even while the older receipt stays visible", async () => {
		const cwd = await tempCwd();
		const original = recordFixture({
			id: "rec-tamper",
			summary: "npm workspaces",
			content: "only npm workspaces are allowed",
			provenance: provenanceFixture({ directoryId: await realpath(cwd) }),
		});
		await seedStoreAt(cwd, [original]);
		const h = new RecallHarness(cwd);

		await h.input("workspaces");
		const first = await h.recall();
		expect(first?.details?.selections[0]?.fingerprint).toBe(recordFingerprint(original));
		persistRecallMessage(h.host, expectRecall(first));

		// Tampering with a fingerprint-relevant field (updatedAt here) changes
		// the fingerprint; the same content must be recalled again.
		const tampered = { ...original, updatedAt: "2025-02-02T00:00:00.000Z" };
		await writeStoreAt(cwd, {
			version: 1,
			schema: "memory.store.v1",
			revision: 2,
			directory: { id: await realpath(cwd) },
			records: [tampered],
		});

		await h.input("workspaces");
		const second = await h.recall();
		expect(second?.details?.counts).toEqual({
			matched: 1,
			selected: 1,
			visibleOmitted: 0,
			recordOmitted: 0,
			characterOmitted: 0,
		});
		expect(second?.details?.selections[0]?.fingerprint).toBe(recordFingerprint(tampered));
		expect(second?.details?.selections[0]?.fingerprint).not.toBe(recordFingerprint(original));
	});

	it("recalls a new active Superseding Record while the superseded revision's receipt remains visible", async () => {
		const cwd = await tempCwd();
		await seedStoreAt(cwd, [
			recordFixture({
				id: "rec-root",
				revision: 1,
				state: "active",
				summary: "npm workspaces (v1)",
				content: "npm workspaces guidance version one",
				provenance: provenanceFixture({ directoryId: await realpath(cwd) }),
			}),
		]);
		const h = new RecallHarness(cwd);

		await h.input("workspaces");
		const first = await h.recall();
		expect(first?.details?.selections[0]?.id).toBe("rec-root");
		persistRecallMessage(h.host, expectRecall(first));

		// A real supersede through the tool seam: new active leaf, new fingerprint.
		const outcome = await h.write("supersede", {
			targetId: "rec-root",
			targetRevision: 1,
			summary: "npm workspaces (v2)",
			content: "npm workspaces guidance version two, corrected",
		});
		const leaf = outcome.details?.record;
		if (leaf === undefined) throw new Error("supersede produced no record");

		await h.input("workspaces");
		const second = await h.recall();
		expect(second?.details?.counts).toEqual({
			matched: 1,
			selected: 1,
			visibleOmitted: 0,
			recordOmitted: 0,
			characterOmitted: 0,
		});
		expect(second?.details?.selections[0]?.id).toBe(leaf.id);
		expect(second?.details?.selections[0]?.revision).toBe(2);
		expect(second?.details?.selections[0]?.fingerprint).not.toBe(first?.details?.selections[0]?.fingerprint);
		expect(second?.content).toContain("version two, corrected");
	});

	it("ignores corrupt receipt details fail-soft and still deduplicates valid receipts alongside", async () => {
		const cwd = await tempCwd();
		await seedStoreAt(cwd, [recordFixture({ summary: "remember something", content: "remember something once" })]);
		const h = new RecallHarness(cwd);

		const garbage: unknown[] = [
			"plain string",
			42,
			null,
			{ kind: "memory:recall-receipt" },
			{ kind: MEMORY_RECALL_CUSTOM_TYPE, version: 1, directory: "/tmp/x", query: "q", selections: "broken" },
			{
				kind: MEMORY_RECALL_CUSTOM_TYPE,
				version: 1,
				directory: "/tmp/x",
				query: "q",
				selections: [{ fingerprint: "not-a-fingerprint" }],
			},
		];
		for (const details of garbage) {
			h.host.appendCustomMessageEntry(MEMORY_RECALL_CUSTOM_TYPE, "corrupt receipt", true, details);
		}

		// Corrupt details never suppress recall and never crash the injection.
		await h.input("remember something");
		const first = await h.recall();
		expect(first?.details?.counts.matched).toBe(1);
		expect(first?.details?.counts.visibleOmitted).toBe(0);
		persistRecallMessage(h.host, expectRecall(first));

		// A valid persisted receipt suppresses, even with corrupt receipts around.
		await h.input("remember something");
		expect(await h.recall()).toBeUndefined();
	});

	it("treats the recall custom message as ordinary context: other custom types never suppress", async () => {
		const cwd = await tempCwd();
		await seedStoreAt(cwd, [recordFixture({ summary: "remember something", content: "remember something once" })]);
		const h = new RecallHarness(cwd);

		h.host.appendCustomMessageEntry("another:extension", "remember something once", true, { any: "details" });
		h.host.api.appendEntry("memory:other", { selections: [{ fingerprint: "e".repeat(64) }] });

		await h.input("remember something");
		const message = await h.recall();
		expect(message?.details?.counts).toEqual({
			matched: 1,
			selected: 1,
			visibleOmitted: 0,
			recordOmitted: 0,
			characterOmitted: 0,
		});
		expect(message?.content).toContain("remember something once");
	});

	it("keeps the Store byte-for-byte unchanged across dedup cycles", async () => {
		const cwd = await tempCwd();
		await seedStoreAt(cwd, [recordFixture({ summary: "remember something", content: "remember something once" })]);
		const h = new RecallHarness(cwd);
		const before = await readFile(getMemoryStorePath(cwd));

		await h.input("remember something");
		const first = await h.recall();
		persistRecallMessage(h.host, expectRecall(first));
		await h.input("remember something");
		await h.recall();
		await h.input("remember something");
		await h.recall();

		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
	});
});

describe("automatic recall branch, resume, fork, and tree navigation", () => {
	it("reconstructs visible fingerprints from the active branch after a branch switch", async () => {
		const cwd = await tempCwd();
		const directory = await realpath(cwd);
		await seedStoreAt(cwd, [
			recordFixture({
				id: "rec-a",
				summary: "branch knowledge",
				content: "branch A knowledge",
				provenance: provenanceFixture({ directoryId: directory }),
			}),
		]);
		const h = new RecallHarness(cwd);

		// Emulate a first run whose recall message lives on branch A.
		await h.input("branch knowledge");
		const first = await h.recall();
		expect(first).toBeDefined();

		// Build the session tree: branch A carries the receipt, branch B diverges before it.
		const entries: SessionEntry[] = [
			messageEntry("root", null),
			messageEntry("a1", "root"),
			receiptEntry("a2", "a1", expectRecall(first)),
			messageEntry("b1", "a1"),
			messageEntry("b2", "b1"),
		];
		h.host.setBranch(entries);

		// On branch B the receipt is not model-visible: recall injects again.
		await h.input("branch knowledge");
		const onB = await h.recall();
		expect(onB?.details?.counts.visibleOmitted).toBe(0);
		expect(onB?.content).toContain("branch A knowledge");

		// Tree navigation back onto branch A makes the receipt visible again.
		h.host.branchEntry("a3", "a2", asRecord(messageEntry("a3", "a2")));
		await h.input("branch knowledge");
		expect(await h.recall()).toBeUndefined();
	});

	it("resume and fork reconstruct dedup state from persisted context, not process memory", async () => {
		const cwd = await tempCwd();
		const directory = await realpath(cwd);
		await seedStoreAt(cwd, [
			recordFixture({
				id: "rec-resume",
				summary: "resume knowledge",
				content: "resume knowledge body",
				provenance: provenanceFixture({ directoryId: directory }),
			}),
		]);
		const original = new RecallHarness(cwd, DEFAULT_CONFIG, { sessionId: "session-a" });

		await original.input("resume knowledge");
		const first = await original.recall();
		persistRecallMessage(original.host, expectRecall(first));

		// Resume: a brand-new process/session reconstructs from persisted entries.
		const resumed = new RecallHarness(cwd, DEFAULT_CONFIG, { sessionId: "session-b" });
		resumed.host.setBranch([...original.host.branch()]);
		await resumed.input("resume knowledge");
		expect(await resumed.recall()).toBeUndefined();

		// Fork: a child branch copied into a new session carries the receipt too.
		const forkPath: SessionEntry[] = [
			messageEntry("root", null),
			messageEntry("a1", "root"),
			receiptEntry("a2", "a1", expectRecall(first)),
			messageEntry("f1", "a2"),
		];
		const fork = new RecallHarness(cwd, DEFAULT_CONFIG, { sessionId: "session-c" });
		fork.host.setBranch(forkPath);
		await fork.input("resume knowledge");
		expect(await fork.recall()).toBeUndefined();

		// And the same session still recalls a different record.
		await fork.write("add", { summary: "fork knowledge", content: "fork knowledge body" });
		await fork.input("fork");
		const recalled = await fork.recall();
		expect(recalled?.details?.counts.matched).toBe(1);
		expect(recalled?.details?.selections[0]?.summary).toBe("fork knowledge");
	});
});

describe("automatic recall compaction awareness", () => {
	it("re-recalls a record after a real Pi buildContextEntries compaction drops its receipt", async () => {
		const cwd = await tempCwd();
		const directory = await realpath(cwd);
		await seedStoreAt(cwd, [
			recordFixture({
				id: "rec-compact",
				summary: "compaction knowledge",
				content: "compaction knowledge body",
				provenance: provenanceFixture({ directoryId: directory }),
			}),
		]);
		const h = new RecallHarness(cwd);

		await h.input("compaction knowledge");
		const first = await h.recall();
		expect(first).toBeDefined();

		// Chain: root message -> receipt -> kept message; no compaction yet.
		const receipt = receiptEntry("e2", "e1", expectRecall(first));
		h.host.branchEntry("e1", null, asRecord(messageEntry("e1", null)));
		h.host.branchEntry("e2", "e1", asRecord(receipt));
		h.host.branchEntry("e3", "e2", asRecord(messageEntry("e3", "e2")));

		// Receipt still model-visible: silent.
		await h.input("compaction knowledge");
		expect(await h.recall()).toBeUndefined();

		// Real Pi compaction semantics: the receipt sits before firstKeptEntryId
		// and leaves the model-visible branch.
		h.host.branchEntry("comp", "e3", asRecord(compactionEntry("comp", "e3", "e3")));
		const visibleIds = h.host.context.sessionManager.buildContextEntries().map((entry) => entry.id);
		expect(visibleIds).not.toContain("e2");
		expect(visibleIds).toContain("comp");

		await h.input("compaction knowledge");
		const after = await h.recall();
		expect(after?.details?.counts.visibleOmitted).toBe(0);
		expect(after?.content).toContain("compaction knowledge body");

		// The Store never changed through any of this.
		await expect(readFile(getMemoryStorePath(cwd), "utf8")).resolves.toContain("compaction knowledge body");
	});
});

describe("automatic recall lifecycle safety", () => {
	it("clears pending state idempotently at repeated lifecycle events without suppressing future recall", async () => {
		const cwd = await tempCwd();
		await seedStoreAt(cwd, [recordFixture({ summary: "remember something", content: "remember something once" })]);
		const h = new RecallHarness(cwd);

		for (const event of ["session_start", "session_tree", "session_shutdown", "agent_settled"] as const) {
			await h.host.emit(event, { type: event });
		}
		// Pending query from an earlier input was discarded, not recalled later.
		await h.input("remember something");
		await h.host.emit("session_tree", { type: "session_tree" });
		await h.host.emit("session_start", { type: "session_start" });
		await h.host.emit("session_shutdown", { type: "session_shutdown" });
		expect(await h.recall()).toBeUndefined();

		// Idempotent: a fresh direct input after repeated lifecycle noise recalls.
		await h.input("remember something");
		const message = await h.recall();
		expect(message?.details?.counts.matched).toBe(1);
	});

	it("keeps deduplication reconstructing from context after lifecycle events (no in-memory cache)", async () => {
		const cwd = await tempCwd();
		await seedStoreAt(cwd, [recordFixture({ summary: "remember something", content: "remember something once" })]);
		const h = new RecallHarness(cwd);

		await h.input("remember something");
		const first = await h.recall();
		persistRecallMessage(h.host, expectRecall(first));

		// Session/tree events only clear pending query state; the visible
		// fingerprint set is rebuilt from the branch on every run.
		await h.host.emit("session_start", { type: "session_start" });
		await h.host.emit("session_tree", { type: "session_tree" });
		await h.input("remember something");
		expect(await h.recall()).toBeUndefined();

		// Without the persisted receipt the same record recalls again.
		h.host.setBranch([messageEntry("root", null)]);
		await h.input("remember something");
		expect((await h.recall())?.details?.counts.matched).toBe(1);
	});

	it("falls back to no deduplication when the branch context build fails", () => {
		const broken = {
			sessionManager: {
				buildContextEntries: () => {
					throw new Error("boom");
				},
			},
		} as unknown as ExtensionContext;
		expect([...MemoryRecall.visibleFingerprints(broken)]).toEqual([]);
	});
});
