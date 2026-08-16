import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_STORE_BYTE_LIMIT } from "../src/constants.js";
import type { RepositoryIdentity } from "../src/memory/identity.js";
import {
	createMemoryFingerprint,
	createMemoryId,
	type MemoryAuthorFields,
	type MemoryEnvelope,
	type MemoryOrigin,
	serializeMemoryEnvelope,
} from "../src/memory/schema.js";
import { MemoryStore } from "../src/memory/store.js";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
	}
});

async function fixture(): Promise<MemoryStore> {
	const root = await mkdtemp(join(tmpdir(), "context-management-store-"));
	directories.push(root);
	const identity: RepositoryIdentity = {
		key: "git-test",
		identityKind: "git-common-dir",
		canonicalPath: join(root, ".git"),
		repositoryRoot: root,
		branch: "main",
		head: "abc",
	};
	const directory = join(root, "agent", "context-management", "repositories", identity.key);
	return new MemoryStore(identity, {
		directory,
		memoryFile: join(directory, "memory.json"),
		lockDirectory: join(directory, "memory.json.lock"),
	});
}

const origin: MemoryOrigin = {
	sessionId: "session",
	entryId: "entry",
	gitBranch: "main",
	gitHead: "abc",
	trigger: "primary-agent-tool",
};

function fields(title: string, supersedes: readonly string[] = []): MemoryAuthorFields {
	return {
		kind: "decision",
		title,
		summary: `${title} summary`,
		contentMarkdown: `## Decision\n\n${title}`,
		scope: { kind: "repository", paths: [] },
		supersedes,
	};
}

describe("MemoryStore", () => {
	it("writes deterministically and reuses an exact active fingerprint without rewriting", async () => {
		const store = await fixture();
		const first = await store.write({ fields: fields("One"), origin, now: new Date("2026-01-01T00:00:00Z") });
		const before = await readFile(store.paths.memoryFile, "utf8");
		const identityBefore = store.snapshot.fileIdentity;
		const second = await store.write({ fields: fields("One"), origin, now: new Date("2026-02-01T00:00:00Z") });
		expect(second.value.reused).toBe(true);
		expect(second.value.record.id).toBe(first.value.record.id);
		expect(await readFile(store.paths.memoryFile, "utf8")).toBe(before);
		expect(store.snapshot.fileIdentity).toEqual(identityBefore);
	});

	it("supersedes reciprocally and refuses relationship-breaking forget", async () => {
		const store = await fixture();
		const old = await store.write({ fields: fields("Old"), origin });
		const replacement = await store.write({ fields: fields("New", [old.value.record.id]), origin });
		expect(replacement.value.record.supersedes).toEqual([old.value.record.id]);
		expect(store.snapshot.envelope?.records.find((record) => record.id === old.value.record.id)?.supersededBy).toBe(
			replacement.value.record.id,
		);
		await expect(store.forget(old.value.record.id)).rejects.toMatchObject({
			code: "context_management.memory_forget_conflict",
		});
	});

	it("physically forgets an unrelated exact record without a tombstone", async () => {
		const store = await fixture();
		const created = await store.write({ fields: fields("Temporary"), origin });
		await store.forget(created.value.record.id);
		expect(store.snapshot.envelope?.records).toEqual([]);
		expect(await readFile(store.paths.memoryFile, "utf8")).not.toContain(created.value.record.id);
	});

	it("marks corrupt or symlink stores unavailable without replacing them", async () => {
		const store = await fixture();
		await import("node:fs/promises").then(({ mkdir }) => mkdir(store.paths.directory, { recursive: true }));
		await writeFile(store.paths.memoryFile, "{broken\n", "utf8");
		expect((await store.load(true)).available).toBe(false);
		expect(await readFile(store.paths.memoryFile, "utf8")).toBe("{broken\n");

		const other = await fixture();
		await import("node:fs/promises").then(({ mkdir }) => mkdir(other.paths.directory, { recursive: true }));
		const target = join(other.paths.directory, "target.json");
		await writeFile(target, "{}", "utf8");
		await symlink(target, other.paths.memoryFile);
		expect((await other.load(true)).available).toBe(false);
	});

	it("honors an aborted signal without disabling an otherwise healthy store", async () => {
		const store = await fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(store.load(true, controller.signal)).rejects.toMatchObject({
			code: "context_management.operation_aborted",
		});
		expect(store.snapshot.available).toBe(true);
	});

	it("re-reads under the lock so independent stale instances do not lose concurrent updates", async () => {
		const first = await fixture();
		const second = new MemoryStore(first.identity, first.paths);
		await Promise.all([first.load(), second.load()]);
		await Promise.all([
			first.write({ fields: fields("First"), origin }),
			second.write({ fields: fields("Second"), origin }),
		]);
		await first.load(true);
		expect(first.snapshot.envelope?.records.map((record) => record.title).sort()).toEqual(["First", "Second"]);
		expect((await readdir(first.paths.directory)).sort()).toEqual(["memory.json"]);
	});

	it("atomically rejects an over-8-MiB mutation and preserves the exact prior file", async () => {
		const store = await fixture();
		const author: MemoryAuthorFields = {
			kind: "learning",
			title: "x",
			summary: "near the store boundary",
			contentMarkdown: "body",
			scope: { kind: "repository", paths: [] },
			supersedes: [],
		};
		const baseRecord = {
			id: createMemoryId(1),
			...author,
			origin,
			createdAt: "2026-08-16T00:00:00.000Z",
			fingerprint: createMemoryFingerprint(author),
			supersededBy: null,
		};
		const base: MemoryEnvelope = {
			schemaVersion: 1,
			repository: {
				key: store.identity.key,
				identityKind: store.identity.identityKind,
				canonicalPath: store.identity.canonicalPath,
				createdAt: "2026-08-16T00:00:00.000Z",
			},
			records: [baseRecord],
		};
		const targetBytes = MEMORY_STORE_BYTE_LIMIT - 64;
		const padding = targetBytes - Buffer.byteLength(serializeMemoryEnvelope(base), "utf8");
		const title = `${author.title}${"x".repeat(padding)}`;
		const paddedAuthor = { ...author, title };
		const nearLimit: MemoryEnvelope = {
			...base,
			records: [{ ...baseRecord, title, fingerprint: createMemoryFingerprint(paddedAuthor) }],
		};
		const before = serializeMemoryEnvelope(nearLimit);
		expect(Buffer.byteLength(before, "utf8")).toBe(targetBytes);
		await mkdir(store.paths.directory, { recursive: true });
		await writeFile(store.paths.memoryFile, before, { encoding: "utf8", mode: 0o600 });
		await store.load(true);

		await expect(store.write({ fields: fields("Would overflow"), origin })).rejects.toMatchObject({
			code: "context_management.memory_store_too_large",
			message: expect.stringContaining("No record was written or deleted"),
		});
		expect(await readFile(store.paths.memoryFile, "utf8")).toBe(before);
		expect(await readdir(store.paths.directory)).toEqual(["memory.json"]);
	});
});
