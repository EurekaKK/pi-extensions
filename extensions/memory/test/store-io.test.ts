import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { MEMORY_ABORTED, MEMORY_IGNORE_MARKER_FAILED, MEMORY_WRITE_FAILED } from "../src/constants.js";
import {
	atomicWriteStoreFile,
	createMemoryStoreFs,
	ensureScopedIgnoreMarker,
	type MemoryFileHandle,
	type MemoryStoreFs,
	serializeMemoryStoreDocument,
} from "../src/store-io.js";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-store-io-"));
}

function errorWithCode(code: string): Error {
	return Object.assign(new Error(`injected ${code}`), { code });
}

/** Fail at a chosen fs primitive while leaving the real implementation otherwise intact. */
function failingFs(override: Partial<MemoryStoreFs>): MemoryStoreFs {
	return { ...createMemoryStoreFs(), ...override };
}

function capturingHandle(inner: MemoryFileHandle, onSync: () => void): MemoryFileHandle {
	return {
		writeFile: (data, encoding) => inner.writeFile(data, encoding),
		sync: async () => {
			onSync();
			await inner.sync();
		},
		close: () => inner.close(),
	};
}

afterEach(async () => {
	const { readdirSync, rmSync } = await import("node:fs");
	for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name.startsWith("memory-store-io-")) {
			rmSync(join(tmpdir(), entry.name), { recursive: true, force: true });
		}
	}
});

describe("atomicWriteStoreFile", () => {
	it("writes exactly to the Store path and leaves no temporary files", async () => {
		const dir = await tempDir();
		const storePath = join(dir, "store.json");
		const fs = createMemoryStoreFs();

		await atomicWriteStoreFile(fs, storePath, '{"ok":true}\n');

		await expect(readFile(storePath, "utf8")).resolves.toBe('{"ok":true}\n');
		await expect(readdir(dir)).resolves.toEqual(["store.json"]);
	});

	it("replaces an existing Store atomically only after a successful commit", async () => {
		const dir = await tempDir();
		const storePath = join(dir, "store.json");
		await writeFile(storePath, "old bytes", "utf8");
		const fs = createMemoryStoreFs();

		await atomicWriteStoreFile(fs, storePath, '{"ok":true}\n');

		await expect(readFile(storePath, "utf8")).resolves.toBe('{"ok":true}\n');
		await expect(readdir(dir)).resolves.toEqual(["store.json"]);
	});

	it("keeps the prior Store authoritative and cleans up when rename fails", async () => {
		const dir = await tempDir();
		const storePath = join(dir, "store.json");
		await writeFile(storePath, "prior bytes", "utf8");
		const before = await readFile(storePath);
		const fs = failingFs({ rename: async () => Promise.reject(errorWithCode("EACCES")) });

		await expect(atomicWriteStoreFile(fs, storePath, "new bytes", undefined)).rejects.toMatchObject({
			code: MEMORY_WRITE_FAILED,
		});

		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(readdir(dir)).resolves.toEqual(["store.json"]);
	});

	it("keeps the prior Store authoritative and cleans up when sync fails", async () => {
		const dir = await tempDir();
		const storePath = join(dir, "store.json");
		await writeFile(storePath, "prior bytes", "utf8");
		const before = await readFile(storePath);
		const real = createMemoryStoreFs();
		const fs = failingFs({
			openExclusive: async (path) =>
				capturingHandle(await real.openExclusive(path), () => {
					throw errorWithCode("EIO");
				}),
		});

		await expect(atomicWriteStoreFile(fs, storePath, "new bytes", undefined)).rejects.toMatchObject({
			code: MEMORY_WRITE_FAILED,
		});

		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(readdir(dir)).resolves.toEqual(["store.json"]);
	});

	it("aborts mid-transaction on signal and leaves the prior Store untouched", async () => {
		const dir = await tempDir();
		const storePath = join(dir, "store.json");
		await writeFile(storePath, "prior bytes", "utf8");
		const before = await readFile(storePath);
		const controller = new AbortController();
		const real = createMemoryStoreFs();
		const fs = failingFs({
			openExclusive: async (path) => {
				controller.abort();
				return real.openExclusive(path);
			},
		});

		await expect(atomicWriteStoreFile(fs, storePath, "new bytes", controller.signal)).rejects.toMatchObject({
			code: MEMORY_ABORTED,
		});

		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(readdir(dir)).resolves.toEqual(["store.json"]);
	});

	it("fails cleanly when an exclusive temp path already exists", async () => {
		const dir = await tempDir();
		const storePath = join(dir, "store.json");
		await writeFile(storePath, "prior bytes", "utf8");
		const before = await readFile(storePath);
		const fs = failingFs({ openExclusive: async () => Promise.reject(errorWithCode("EEXIST")) });

		await expect(atomicWriteStoreFile(fs, storePath, "new bytes", undefined)).rejects.toMatchObject({
			code: MEMORY_WRITE_FAILED,
		});

		await expect(readFile(storePath)).resolves.toEqual(before);
		await expect(readdir(dir)).resolves.toEqual(["store.json"]);
	});
});

describe("ensureScopedIgnoreMarker", () => {
	it("creates the scoped marker when absent", async () => {
		const dir = await tempDir();
		const fs = createMemoryStoreFs();

		await expect(ensureScopedIgnoreMarker(fs, dir)).resolves.toBe("created");
		await expect(readFile(join(dir, ".gitignore"), "utf8")).resolves.toBe("*\n");
	});

	it("preserves a user-maintained marker verbatim", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, ".gitignore"), "# user marker\n", "utf8");
		const fs = createMemoryStoreFs();

		await expect(ensureScopedIgnoreMarker(fs, dir)).resolves.toBe("preserved");
		await expect(readFile(join(dir, ".gitignore"), "utf8")).resolves.toBe("# user marker\n");
	});

	it("fails closed when the marker cannot be inspected or created", async () => {
		const dir = await tempDir();
		const fs = failingFs({
			readFileText: async () => Promise.reject(errorWithCode("EACCES")),
		});

		await expect(ensureScopedIgnoreMarker(fs, dir)).rejects.toMatchObject({
			code: MEMORY_IGNORE_MARKER_FAILED,
		});
	});

	it("removes a partial marker when the create itself fails", async () => {
		const dir = await tempDir();
		const fs = failingFs({
			readFileText: async () => Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
			openExclusive: async () => {
				const markerPath = join(dir, ".gitignore");
				await writeFile(markerPath, "partial", "utf8");
				throw errorWithCode("EIO");
			},
		});

		await expect(ensureScopedIgnoreMarker(fs, dir)).rejects.toMatchObject({
			code: MEMORY_IGNORE_MARKER_FAILED,
		});
		await expect(readdir(dir)).resolves.toEqual([]);
	});
});

describe("serializeMemoryStoreDocument", () => {
	it("rejects a document beyond the byte budget", () => {
		const limits = { ...DEFAULT_CONFIG.store, maxStoreBytes: 64 };
		let code = "";
		try {
			serializeMemoryStoreDocument(
				{ version: 1, schema: "memory.store.v1", revision: 0, directory: { id: "x" }, records: [] },
				limits,
			);
		} catch (error) {
			code = error instanceof Error && "code" in error ? String((error as { code: string }).code) : "";
		}
		expect(code).toBe("MEMORY_STORE_OVER_LIMIT");
	});

	it("serializes bounded documents with a trailing newline", () => {
		const text = serializeMemoryStoreDocument(
			{ version: 1, schema: "memory.store.v1", revision: 0, directory: { id: "x" }, records: [] },
			DEFAULT_CONFIG.store,
		);
		expect(text.endsWith("\n")).toBe(true);
		expect(JSON.parse(text)).toMatchObject({ version: 1 });
	});
});
