import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type MemoryConfigV1 } from "../src/config.js";
import {
	MEMORY_ABORTED,
	MEMORY_RECORD_NOT_FOUND,
	MEMORY_STORE_INIT_FAILED,
	MEMORY_STORE_OVER_LIMIT,
	MEMORY_STORE_UNAVAILABLE,
	MEMORY_WRITE_FAILED,
} from "../src/constants.js";
import { MemoryService } from "../src/service.js";
import { createMemoryStoreFs, type MemoryStoreFs } from "../src/store-io.js";
import { getMemoryStorePath } from "../src/store-layout.js";
import { recordFixture } from "./fixtures.js";

const TIMESTAMP = "2025-01-01T00:00:00.000Z";

function errorWithCode(code: string): Error {
	return Object.assign(new Error(`injected ${code}`), { code });
}

function failingFs(override: Partial<MemoryStoreFs>): MemoryStoreFs {
	return { ...createMemoryStoreFs(), ...override };
}

function context(cwd: string, leafId: string | null = "entry-7"): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => "session-1",
			getLeafId: () => leafId,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
}

function service(config: MemoryConfigV1 = DEFAULT_CONFIG, fs?: MemoryStoreFs): MemoryService {
	return new MemoryService({
		config,
		withFileMutationQueue,
		now: () => TIMESTAMP,
		...(fs === undefined ? {} : { fs }),
	});
}

async function tempCwd(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-service-"));
}

async function writeStore(path: string, fixture: object): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(fixture, null, 2), "utf8");
}

/** Seed a healthy Store whose directory identity matches the caller's canonical path. */
async function seedStoreAt(cwd: string, records: readonly unknown[] = [], revision = records.length): Promise<void> {
	await writeStore(getMemoryStorePath(cwd), {
		version: 1,
		schema: "memory.store.v1",
		revision,
		directory: { id: await realpath(cwd) },
		records,
	});
}

describe("MemoryService.add", () => {
	it("initializes a missing Store with immutable provenance and the canonical Directory Identity", async () => {
		const cwd = await tempCwd();
		const svc = service();

		const outcome = await svc.add(context(cwd), { summary: "s", content: "content" });

		expect(outcome.kind).toBe("added");
		if (outcome.kind !== "added") return;
		expect(outcome.record.provenance.author).toBe("primary-agent");
		expect(outcome.record.provenance.sessionId).toBe("session-1");
		expect(outcome.record.provenance.directoryId).toBe(await realpath(cwd));
		expect(outcome.record.provenance.entryId).toBe("entry-7");
		expect(outcome.record.createdAt).toBe(TIMESTAMP);
		expect(outcome.record.updatedAt).toBe(TIMESTAMP);
		expect(outcome.storeRevision).toBe(1);
		expect(outcome.previousStoreRevision).toBe(0);
		expect(outcome.ignoreMarker).toBe("created");
	});

	it("appends to an existing healthy Store and increments the revision", async () => {
		const cwd = await tempCwd();
		await seedStoreAt(cwd, [recordFixture()], 1);
		const svc = service();

		const outcome = await svc.add(context(cwd), { summary: "other", content: "other content" });

		expect(outcome.kind).toBe("added");
		if (outcome.kind !== "added") return;
		expect(outcome.storeRevision).toBe(2);
		expect(outcome.previousStoreRevision).toBe(1);
		expect(outcome.ignoreMarker).toBe("created");
		const persisted = JSON.parse(await readFile(getMemoryStorePath(cwd), "utf8")) as {
			revision: number;
			records: unknown[];
		};
		expect(persisted.revision).toBe(2);
		expect(persisted.records).toHaveLength(2);
	});

	it("treats an exact duplicate as a no-op that leaves the Store bytes untouched", async () => {
		const cwd = await tempCwd();
		const svc = service();
		const ctx = context(cwd);
		await svc.add(ctx, { summary: "s", content: "content" });
		const before = await readFile(getMemoryStorePath(cwd));

		const outcome = await svc.add(ctx, { summary: "s", content: "content" });

		expect(outcome.kind).toBe("no-op");
		expect(outcome.storeRevision).toBe(1);
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
	});

	it("adopts the current canonical Directory metadata after a Store moves", async () => {
		const cwd = await tempCwd();
		const formerIdentity = await mkdtemp(join(tmpdir(), "memory-service-former-"));
		await writeStore(getMemoryStorePath(cwd), {
			version: 1,
			schema: "memory.store.v1",
			revision: 0,
			directory: { id: formerIdentity },
			records: [],
		});

		await expect(service().add(context(cwd), { summary: "s", content: "c" })).resolves.toMatchObject({
			kind: "added",
			storeRevision: 1,
		});
		const persisted = JSON.parse(await readFile(getMemoryStorePath(cwd), "utf8")) as {
			readonly directory: { readonly id: string };
		};
		expect(persisted.directory.id).toBe(await realpath(cwd));
	});

	it("fails closed on an unreadable Store and never overwrites it", async () => {
		const cwd = await tempCwd();
		await mkdir(getMemoryStorePath(cwd), { recursive: true });

		await expect(service().add(context(cwd), { summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_STORE_UNAVAILABLE,
		});
	});

	it("rejects when the record count would exceed the configured limit", async () => {
		const cwd = await tempCwd();
		const config = { ...DEFAULT_CONFIG, store: { ...DEFAULT_CONFIG.store, maxRecords: 1 } };
		await seedStoreAt(cwd, [recordFixture()], 1);

		await expect(service(config).add(context(cwd), { summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_STORE_OVER_LIMIT,
		});
	});

	it("keeps the prior Store byte-for-byte authoritative when the final rename fails", async () => {
		const cwd = await tempCwd();
		await seedStoreAt(cwd, []);
		const before = await readFile(getMemoryStorePath(cwd));
		const svc = service(DEFAULT_CONFIG, failingFs({ rename: async () => Promise.reject(errorWithCode("EACCES")) }));

		await expect(svc.add(context(cwd), { summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_WRITE_FAILED,
		});
		await expect(readFile(getMemoryStorePath(cwd))).resolves.toEqual(before);
		await expect(readdir(dirname(getMemoryStorePath(cwd))).then((entries) => entries.sort())).resolves.toEqual([
			".gitignore",
			"store.json",
		]);
	});

	it("fails closed on a missing Store when the directory cannot be prepared", async () => {
		const cwd = await tempCwd();
		const svc = service(DEFAULT_CONFIG, failingFs({ mkdir: async () => Promise.reject(errorWithCode("EACCES")) }));

		await expect(svc.add(context(cwd), { summary: "s", content: "c" })).rejects.toMatchObject({
			code: MEMORY_STORE_INIT_FAILED,
		});
		await expect(readdir(cwd)).resolves.toEqual([]);
	});

	it("aborts on a pre-aborted signal before creating anything", async () => {
		const cwd = await tempCwd();

		await expect(
			service().add(context(cwd), { summary: "s", content: "c" }, AbortSignal.abort()),
		).rejects.toMatchObject({ code: MEMORY_ABORTED });
		await expect(readdir(cwd)).resolves.toEqual([]);
	});

	it("serializes concurrent adds through the real mutation queue without losing updates", async () => {
		const cwd = await tempCwd();
		const svc = service();
		const ctx = context(cwd);

		const [a, b] = await Promise.all([
			svc.add(ctx, { summary: "a", content: "alpha" }),
			svc.add(ctx, { summary: "b", content: "beta" }),
		]);

		expect(a.kind).toBe("added");
		expect(b.kind).toBe("added");
		const persisted = JSON.parse(await readFile(getMemoryStorePath(cwd), "utf8")) as {
			revision: number;
			records: unknown[];
		};
		expect(persisted.revision).toBe(2);
		expect(persisted.records).toHaveLength(2);
	});
});

describe("MemoryService.read", () => {
	it("finds an exact record and its full content by id", async () => {
		const cwd = await tempCwd();
		const id = "rec-1";
		await seedStoreAt(cwd, [recordFixture({ id })], 1);

		const outcome = await service().read(context(cwd), { id });

		expect(outcome.kind).toBe("found");
		if (outcome.kind === "found") expect(outcome.record.content).toBe(recordFixture().content);
	});

	it("requires the exact revision when requested", async () => {
		const cwd = await tempCwd();
		const id = "rec-1";
		await seedStoreAt(cwd, [recordFixture({ id })], 1);

		await expect(service().read(context(cwd), { id })).resolves.toMatchObject({ kind: "found" });
		await expect(service().read(context(cwd), { id, revision: 9 })).rejects.toMatchObject({
			code: MEMORY_RECORD_NOT_FOUND,
		});
	});

	it("fails with not-found on a missing Store", async () => {
		const cwd = await tempCwd();

		await expect(service().read(context(cwd), { id: "rec-1" })).rejects.toMatchObject({
			code: MEMORY_RECORD_NOT_FOUND,
		});
	});
});
