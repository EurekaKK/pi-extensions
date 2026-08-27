import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { MEMORY_ABORTED, MEMORY_STORE_UNSUPPORTED_VERSION } from "../src/constants.js";
import { MemoryError } from "../src/errors.js";
import {
	classifyMemoryStore,
	type MemoryRecordV1,
	type StoreClassification,
	validateMemoryStoreDocument,
} from "../src/store.js";
import { getMemoryStorePath } from "../src/store-layout.js";
import { provenanceFixture, recordFixture, storeFixture } from "./fixtures.js";

const DEFAULT_LIMITS = DEFAULT_CONFIG.store;

async function tempCwd(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-store-"));
}

async function writeStore(cwd: string, fixture: object): Promise<string> {
	const storePath = getMemoryStorePath(cwd);
	await mkdir(dirname(storePath), { recursive: true });
	await writeFile(storePath, JSON.stringify(fixture, null, 2), "utf8");
	return storePath;
}

function classify(cwd: string, limits = DEFAULT_LIMITS): Promise<StoreClassification> {
	return classifyMemoryStore({ storePath: getMemoryStorePath(cwd), limits });
}

describe("Memory Store classification", () => {
	it("distinguishes missing from healthy-empty and healthy Stores", async () => {
		const cwd = await tempCwd();
		await expect(classify(cwd)).resolves.toEqual({ kind: "missing" });

		await writeStore(cwd, storeFixture({ revision: 0 }, []));
		await expect(classify(cwd)).resolves.toMatchObject({ kind: "healthy" });
		const healthy = (await classify(cwd)) as Extract<StoreClassification, { kind: "healthy" }>;
		expect(healthy.store.records).toHaveLength(0);
		expect(healthy.store.revision).toBe(0);
	});

	it("parses a healthy Store with a valid supersession chain (older superseded, leaf active)", async () => {
		const cwd = await tempCwd();
		const older = recordFixture({ id: "rec-1", revision: 1, state: "superseded", supersedes: null });
		const newer = recordFixture({
			id: "rec-2",
			revision: 2,
			state: "active",
			summary: "npm workspaces superseded",
			supersedes: { id: "rec-1", revision: 1 },
			provenance: provenanceFixture({ entryId: "entry-42" }),
		});
		await writeStore(cwd, storeFixture({ revision: 2 }, [older, newer]));

		const classification = await classify(cwd);

		expect(classification).toMatchObject({ kind: "healthy" });
		if (classification.kind !== "healthy") throw new Error("expected healthy store");
		expect(classification.store.records).toHaveLength(2);
		expect(classification.store.records[0]?.state).toBe("superseded");
		expect(classification.store.records[1]?.state).toBe("active");
		expect(classification.store.records[1]?.supersedes).toEqual({ id: "rec-1", revision: 1 });
		expect(classification.store.records[1]?.provenance.entryId).toBe("entry-42");
	});

	it("parses a healthy multi-step chain with only the leaf active", async () => {
		const cwd = await tempCwd();
		const chain = [
			recordFixture({ id: "rec-1", revision: 1, state: "superseded", supersedes: null }),
			recordFixture({ id: "rec-2", revision: 2, state: "superseded", supersedes: { id: "rec-1", revision: 1 } }),
			recordFixture({ id: "rec-3", revision: 3, state: "active", supersedes: { id: "rec-2", revision: 2 } }),
		];
		await writeStore(cwd, storeFixture({ revision: 3 }, chain));

		const classification = await classify(cwd);

		expect(classification).toMatchObject({ kind: "healthy" });
		if (classification.kind !== "healthy") throw new Error("expected healthy store");
		expect(classification.store.records.map((record) => record.state)).toEqual(["superseded", "superseded", "active"]);
	});

	it("classifies an unsupported Store version without reading it as empty", async () => {
		const cwd = await tempCwd();
		await writeStore(cwd, { ...storeFixture(), version: 2 });

		await expect(classify(cwd)).resolves.toMatchObject({
			kind: "unsupported",
			reason: expect.stringContaining("version 2"),
		});
	});

	it.each([
		["not valid JSON", "{oops"],
		["non-object document", "[1, 2, 3]"],
		["unknown top-level field", { ...storeFixture(), extra: true }],
		["missing records field", { ...storeFixture(), records: undefined }],
		["store revision negative", { ...storeFixture(), revision: -1 }],
	])("classifies corrupt Stores (%s)", async (_name, fixture) => {
		const cwd = await tempCwd();
		await writeStore(cwd, fixture as object);

		await expect(classify(cwd)).resolves.toMatchObject({ kind: "corrupt" });
	});

	it("rejects invalid UTF-8 as corrupt", async () => {
		const cwd = await tempCwd();
		const storePath = getMemoryStorePath(cwd);
		await mkdir(dirname(storePath), { recursive: true });
		await writeFile(storePath, Buffer.from([0xff, 0xfe, 0x00, 0x7b]));

		await expect(classify(cwd)).resolves.toMatchObject({ kind: "corrupt", reason: expect.stringContaining("UTF-8") });
	});

	it("rejects duplicate record identities", async () => {
		const cwd = await tempCwd();
		const records = [
			recordFixture({ id: "rec-1", revision: 1 }),
			recordFixture({ id: "rec-1", revision: 2, summary: "duplicate identity" }),
		];
		await writeStore(cwd, storeFixture({ revision: 3 }, records));

		await expect(classify(cwd)).resolves.toMatchObject({
			kind: "corrupt",
			reason: expect.stringContaining("duplicate record identity"),
		});
	});

	it.each([
		[
			"supersedes a missing record",
			[recordFixture({ id: "rec-2", revision: 2, state: "active", supersedes: { id: "ghost", revision: 1 } })],
		],
		[
			"supersedes with a stale revision",
			[
				recordFixture({ id: "rec-1", revision: 1, state: "superseded", supersedes: null }),
				recordFixture({ id: "rec-2", revision: 2, state: "active", supersedes: { id: "rec-1", revision: 9 } }),
			],
		],
		[
			"a successor revision that is not target revision + 1",
			[
				recordFixture({ id: "rec-1", revision: 1, state: "superseded", supersedes: null }),
				recordFixture({ id: "rec-2", revision: 5, state: "active", supersedes: { id: "rec-1", revision: 1 } }),
			],
		],
		[
			"an active record with an incoming successor",
			[
				recordFixture({ id: "rec-1", revision: 1, state: "active", supersedes: null }),
				recordFixture({ id: "rec-2", revision: 2, state: "active", supersedes: { id: "rec-1", revision: 1 } }),
			],
		],
		[
			"a superseded record without an incoming successor",
			[recordFixture({ id: "rec-1", revision: 1, state: "superseded", supersedes: null })],
		],
		[
			"a record superseded more than once",
			[
				recordFixture({ id: "rec-1", revision: 1, state: "superseded", supersedes: null }),
				recordFixture({ id: "rec-2", revision: 2, state: "active", supersedes: { id: "rec-1", revision: 1 } }),
				recordFixture({ id: "rec-3", revision: 3, state: "active", supersedes: { id: "rec-1", revision: 1 } }),
			],
		],
		[
			"a self-supersession cycle",
			[recordFixture({ id: "rec-1", revision: 1, state: "superseded", supersedes: { id: "rec-1", revision: 1 } })],
		],
		[
			"a two-record supersession cycle",
			[
				recordFixture({ id: "rec-1", revision: 1, state: "superseded", supersedes: { id: "rec-2", revision: 1 } }),
				recordFixture({ id: "rec-2", revision: 1, state: "superseded", supersedes: { id: "rec-1", revision: 1 } }),
			],
		],
	])("rejects invalid supersession graphs (%s)", async (_name, records) => {
		const cwd = await tempCwd();
		await writeStore(cwd, storeFixture({ revision: records.length }, records));

		await expect(classify(cwd)).resolves.toMatchObject({ kind: "corrupt" });
	});

	it.each([
		["blank summary", recordFixture({ summary: "   " })],
		["invalid createdAt", recordFixture({ createdAt: "not a date" })],
		["invalid updatedAt", recordFixture({ updatedAt: "2025-99-99T00:00:00.000Z" })],
		["control character in id", recordFixture({ id: "rec-\u0001" })],
		["missing provenance author", recordFixture({ provenance: provenanceFixture({ author: "" }) })],
		["non-primary provenance author", recordFixture({ provenance: provenanceFixture({ author: "secondary-agent" }) })],
		[
			"control character in provenance entryId",
			recordFixture({ provenance: provenanceFixture({ entryId: "entry-\u0001" }) }),
		],
		["negative record revision", recordFixture({ revision: 0 })],
		["unknown record field", { ...recordFixture(), extra: "junk" }],
	])("rejects malformed records (%s)", async (_name, record) => {
		const cwd = await tempCwd();
		await writeStore(cwd, storeFixture({ revision: 1 }, [record as MemoryRecordV1]));

		await expect(classify(cwd)).resolves.toMatchObject({ kind: "corrupt" });
	});

	it("rejects over-limit documents by file size, record count, content, and summary", async () => {
		const cwd = await tempCwd();

		const tinyLimits = { maxStoreBytes: 4096, maxRecords: 2, maxContentChars: 12, maxSummaryChars: 6 };

		const bulky = recordFixture({ content: "x".repeat(5_000), summary: "y".repeat(40) });
		await writeStore(cwd, storeFixture({ revision: 1 }, [bulky]));
		await expect(classify(cwd, tinyLimits)).resolves.toMatchObject({
			kind: "over-limit",
			reason: expect.stringContaining("exceeds"),
		});

		const overRecords = [
			recordFixture({ id: "rec-1", content: "ok", summary: "ok" }),
			recordFixture({ id: "rec-2", content: "ok", summary: "ok" }),
			recordFixture({ id: "rec-3", content: "ok", summary: "ok" }),
		];
		await writeStore(cwd, storeFixture({ revision: 3 }, overRecords));
		await expect(classify(cwd, tinyLimits)).resolves.toMatchObject({
			kind: "over-limit",
			reason: expect.stringContaining("record count"),
		});

		await writeStore(cwd, storeFixture({ revision: 1 }, [recordFixture({ content: "a".repeat(50), summary: "ok" })]));
		await expect(classify(cwd, tinyLimits)).resolves.toMatchObject({
			kind: "over-limit",
			reason: expect.stringContaining("content exceeds"),
		});

		await writeStore(cwd, storeFixture({ revision: 1 }, [recordFixture({ content: "ok", summary: "b".repeat(20) })]));
		await expect(classify(cwd, tinyLimits)).resolves.toMatchObject({
			kind: "over-limit",
			reason: expect.stringContaining("summary exceeds"),
		});
	});

	it("classifies an unreadable non-regular path", async () => {
		const cwd = await tempCwd();
		const storePath = getMemoryStorePath(cwd);
		await mkdir(storePath, { recursive: true });

		await expect(classify(cwd)).resolves.toMatchObject({
			kind: "unreadable",
			reason: expect.stringContaining("must be a regular file"),
		});
	});

	it("classifies an unreadable file on permission failure where the platform enforces it", async () => {
		if (process.platform === "win32") return;
		const cwd = await tempCwd();
		const storePath = await writeStore(cwd, storeFixture());
		await chmod(storePath, 0o000);
		try {
			await readFile(storePath);
			// Running as a privileged user; the platform does not enforce the
			// permission here, so there is nothing meaningful to assert.
			return;
		} catch {
			await expect(classify(cwd)).resolves.toMatchObject({
				kind: "unreadable",
				reason: expect.stringContaining("cannot read memory store"),
			});
		}
	});

	it("aborts classification on a pre-aborted signal", async () => {
		const cwd = await tempCwd();
		await writeStore(cwd, storeFixture());

		const promise = classifyMemoryStore({
			storePath: getMemoryStorePath(cwd),
			limits: DEFAULT_LIMITS,
			signal: AbortSignal.abort(),
		});
		await expect(promise).rejects.toBeInstanceOf(MemoryError);
		await expect(promise).rejects.toMatchObject({ code: MEMORY_ABORTED });
	});

	it("never writes during classification, even for failure states", async () => {
		const cwd = await tempCwd();
		await writeStore(cwd, { ...storeFixture(), version: 2 });
		const storePath = getMemoryStorePath(cwd);
		const before = await readFile(storePath);

		const classification = await classify(cwd);

		expect(classification.kind).toBe("unsupported");
		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(readdir(dirname(storePath))).resolves.toEqual(["store.json"]);
	});

	it("creates nothing when the Store is missing", async () => {
		const cwd = await tempCwd();

		await expect(classify(cwd)).resolves.toEqual({ kind: "missing" });
		await expect(readdir(cwd)).resolves.toEqual([]);
	});

	it("validates documents through the standalone validator with stable error codes", () => {
		try {
			validateMemoryStoreDocument({ ...storeFixture(), version: 9 }, DEFAULT_LIMITS);
			throw new Error("expected validation to reject the unsupported version");
		} catch (error) {
			expect(error).toBeInstanceOf(MemoryError);
			if (error instanceof MemoryError) expect(error.code).toBe(MEMORY_STORE_UNSUPPORTED_VERSION);
		}
	});
});
