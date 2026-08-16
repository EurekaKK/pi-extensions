import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRepositoryIdentity } from "../src/memory/identity.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function root(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "context-management-identity-"));
	directories.push(path);
	return path;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
	await execFileAsync("git", [...args], { cwd, encoding: "utf8", timeout: 10_000 });
}

describe("repository identity", () => {
	it("shares one key across worktrees but separates an independent clone", async () => {
		const base = await root();
		const repository = join(base, "repository");
		const worktree = join(base, "worktree");
		const clone = join(base, "clone");
		await mkdir(repository);
		await git(repository, ["init", "-q"]);
		await git(repository, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"--allow-empty",
			"-q",
			"-m",
			"initial",
		]);
		await git(repository, ["worktree", "add", "-q", "-b", "worktree-test", worktree]);
		await git(base, ["clone", "-q", repository, clone]);

		const mainIdentity = await discoverRepositoryIdentity(repository);
		const worktreeIdentity = await discoverRepositoryIdentity(worktree);
		const cloneIdentity = await discoverRepositoryIdentity(clone);
		expect(worktreeIdentity.key).toBe(mainIdentity.key);
		expect(worktreeIdentity.canonicalPath).toBe(mainIdentity.canonicalPath);
		expect(cloneIdentity.key).not.toBe(mainIdentity.key);
	});

	it("canonicalizes symlinked non-Git working directories", async () => {
		const base = await root();
		const project = join(base, "project");
		const link = join(base, "project-link");
		await mkdir(project);
		await symlink(project, link);
		const direct = await discoverRepositoryIdentity(project);
		const throughLink = await discoverRepositoryIdentity(link);
		expect(throughLink.identityKind).toBe("directory");
		expect(throughLink.key).toBe(direct.key);
		expect(throughLink.canonicalPath).toBe(await realpath(project));
	});
});
