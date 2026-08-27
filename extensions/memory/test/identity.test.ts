import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY_DIRECTORY_IDENTITY_FAILED } from "../src/constants.js";
import { MemoryError } from "../src/errors.js";
import { resolveDirectoryIdentity } from "../src/identity.js";
import { getMemoryStorePath } from "../src/store-layout.js";

async function tempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

describe("Directory Identity", () => {
	it("resolves the exact canonical real path of a real directory", async () => {
		const cwd = await tempDir("memory-id-");

		const identity = await resolveDirectoryIdentity(cwd);

		expect(identity).toBe(await realpath(cwd));
	});

	it("converges symlink aliases of the same directory onto one identity", async () => {
		const root = await tempDir("memory-symlink-");
		const real = join(root, "real");
		const alias = join(root, "alias");
		await mkdir(real);
		await symlink(real, alias);

		await expect(resolveDirectoryIdentity(alias)).resolves.toBe(await resolveDirectoryIdentity(real));
	});

	it("keeps parent, child, and sibling directories distinct", async () => {
		const root = await tempDir("memory-tree-");
		const parent = join(root, "parent");
		const child = join(parent, "child");
		const sibling = join(parent, "sibling");
		await mkdir(child, { recursive: true });
		await mkdir(sibling);

		const identities = {
			parent: await resolveDirectoryIdentity(parent),
			child: await resolveDirectoryIdentity(child),
			sibling: await resolveDirectoryIdentity(sibling),
		};

		expect(new Set(Object.values(identities)).size).toBe(3);
		expect(identities.parent).toBe(await realpath(parent));
		expect(identities.child).toBe(await realpath(child));
		expect(identities.sibling).toBe(await realpath(sibling));
	});

	it("carries the Store naturally when the directory moves, without any registry", async () => {
		const root = await tempDir("memory-move-");
		const before = join(root, "before");
		const after = join(root, "after");
		await mkdir(before);
		const storePathBefore = getMemoryStorePath(before);
		await mkdir(dirname(storePathBefore), { recursive: true });
		await writeFile(storePathBefore, '{"version":1}', "utf8");

		await rename(before, after);

		await expect(resolveDirectoryIdentity(after)).resolves.toBe(await realpath(after));
		const storePathAfter = getMemoryStorePath(after);
		expect(storePathAfter).not.toBe(storePathBefore);
		// The Store document travelled with the directory; no agent-global
		// migration registry exists to consult.
		await expect(readFile(storePathAfter, "utf8")).resolves.toBe('{"version":1}');
	});

	it("fails with a stable code when the Working Directory does not exist", async () => {
		const root = await tempDir("memory-missing-");
		const cwd = join(root, "absent");

		const promise = resolveDirectoryIdentity(cwd);
		await expect(promise).rejects.toBeInstanceOf(MemoryError);
		await expect(promise).rejects.toMatchObject({ code: MEMORY_DIRECTORY_IDENTITY_FAILED });
		await rm(root, { recursive: true, force: true });
	});
});
