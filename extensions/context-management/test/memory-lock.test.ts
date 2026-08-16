import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireMemoryLock } from "../src/memory/lock.js";

const directories: string[] = [];

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function lockPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "context-management-lock-"));
	directories.push(root);
	return join(root, "memory.json.lock");
}

describe("memory advisory lock", () => {
	it("rejects an already-aborted contender and preserves the current owner", async () => {
		const path = await lockPath();
		const first = await acquireMemoryLock(path);
		const controller = new AbortController();
		controller.abort();
		await expect(acquireMemoryLock(path, controller.signal)).rejects.toMatchObject({
			code: "context_management.operation_aborted",
		});
		first.assertHealthy();
		await first.release();
	});

	it("normalizes abort while actively waiting for a contended lock", async () => {
		const path = await lockPath();
		const first = await acquireMemoryLock(path);
		const controller = new AbortController();
		const waiting = acquireMemoryLock(path, controller.signal);
		setTimeout(() => controller.abort(), 10);
		await expect(waiting).rejects.toMatchObject({ code: "context_management.operation_aborted" });
		first.assertHealthy();
		await first.release();
	});

	it("reclaims only a stale same-host owner whose pid is definitely dead", async () => {
		const path = await lockPath();
		await mkdir(path, { mode: 0o700 });
		const stale = new Date(Date.now() - 180_000).toISOString();
		await writeFile(
			join(path, "owner.json"),
			`${JSON.stringify({ pid: 2_147_483_647, hostname: hostname(), nonce: "dead", createdAt: stale, heartbeatAt: stale })}\n`,
			{ mode: 0o600 },
		);
		const replacement = await acquireMemoryLock(path);
		expect(replacement.owner.nonce).not.toBe("dead");
		await replacement.release();
	});
});
