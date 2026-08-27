import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { checkMemoryStoreGitTracking, createGitCommandRunner, type GitCommandRunner } from "../src/git.js";

const run = promisify(execFile);
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "memory test",
	GIT_AUTHOR_EMAIL: "memory-test@example.com",
	GIT_COMMITTER_NAME: "memory test",
	GIT_COMMITTER_EMAIL: "memory-test@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(cwd: string, args: readonly string[]): Promise<void> {
	await run("git", [...args], { cwd, env: GIT_ENV });
}

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-git-"));
}

async function gitRepo(): Promise<string> {
	const cwd = await tempDir();
	await git(cwd, ["init", "-q"]);
	return cwd;
}

const STORE_PATHS = [join(".pi", "memory"), join(".pi", "memory", "store.json")];

describe("advisory Git tracking diagnostics", () => {
	afterEach(async () => {
		const { readdirSync } = await import("node:fs");
		for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
			if (entry.name.startsWith("memory-git-") && entry.isDirectory()) {
				await rm(join(tmpdir(), entry.name), { recursive: true, force: true });
			}
		}
	});

	it("reports non-git directories without running extra diagnostics", async () => {
		const cwd = await tempDir();

		await expect(checkMemoryStoreGitTracking({ cwd, paths: STORE_PATHS, timeoutMs: 2_000 })).resolves.toEqual({
			kind: "non-git",
		});
	});

	it("reports untracked Store paths inside a fresh git repository", async () => {
		const cwd = await gitRepo();

		await expect(checkMemoryStoreGitTracking({ cwd, paths: STORE_PATHS, timeoutMs: 2_000 })).resolves.toEqual({
			kind: "untracked",
		});
	});

	it("reports a git-tracked Store and never edits ignore or exclude files", async () => {
		const cwd = await gitRepo();
		const storePath = join(cwd, ".pi", "memory", "store.json");
		await mkdir(join(storePath, ".."), { recursive: true });
		await writeFile(storePath, "{}", "utf8");
		await git(cwd, ["add", ".pi/memory/store.json"]);
		await git(cwd, ["commit", "-qm", "initial"]);

		await expect(checkMemoryStoreGitTracking({ cwd, paths: STORE_PATHS, timeoutMs: 2_000 })).resolves.toEqual({
			kind: "tracked",
		});

		await expect(readFile(join(cwd, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(cwd, ".git", "info", "exclude"), "utf8")).resolves.not.toContain(".pi/memory");
	});

	it("reports ignored Store paths when a scoped marker exists", async () => {
		const cwd = await gitRepo();
		const markerPath = join(cwd, ".pi", "memory", ".gitignore");
		await mkdir(join(markerPath, ".."), { recursive: true });
		await writeFile(markerPath, "*\n", "utf8");
		const storePath = join(cwd, ".pi", "memory", "store.json");
		await writeFile(storePath, "{}", "utf8");

		await expect(checkMemoryStoreGitTracking({ cwd, paths: STORE_PATHS, timeoutMs: 2_000 })).resolves.toEqual({
			kind: "ignored",
		});
	});

	it("reports tracked precedence over an ignore marker", async () => {
		const cwd = await gitRepo();
		const storePath = join(cwd, ".pi", "memory", "store.json");
		await mkdir(join(storePath, ".."), { recursive: true });
		await writeFile(storePath, "{}", "utf8");
		await git(cwd, ["add", "-f", ".pi/memory/store.json"]);
		await git(cwd, ["commit", "-qm", "forced"]);
		const markerPath = join(cwd, ".pi", "memory", ".gitignore");
		await writeFile(markerPath, "*\n", "utf8");

		await expect(checkMemoryStoreGitTracking({ cwd, paths: STORE_PATHS, timeoutMs: 2_000 })).resolves.toEqual({
			kind: "tracked",
		});
	});

	it("reports git unavailable when the binary is missing", async () => {
		const cwd = await tempDir();
		const runner = createGitCommandRunner("definitely-not-a-git-binary-xyz");

		await expect(
			checkMemoryStoreGitTracking({ cwd, paths: STORE_PATHS, timeoutMs: 2_000, runner }),
		).resolves.toMatchObject({ kind: "unavailable" });
	});

	it("times out slow diagnostics and reports the timeout advisories", async () => {
		const runner = createGitCommandRunner(process.execPath);

		await expect(runner(["-e", "setTimeout(() => {}, 60_000)"], { cwd: tmpdir(), timeoutMs: 200 })).resolves.toEqual({
			status: "timed-out",
		});
		const cancelled = await runner(["-e", "setTimeout(() => {}, 60_000)"], {
			cwd: tmpdir(),
			timeoutMs: 60_000,
			signal: AbortSignal.abort(),
		});
		expect(cancelled).toEqual({ status: "cancelled" });
	});

	it("reports a mid-flight abort as cancellation rather than timeout", async () => {
		const runner = createGitCommandRunner(process.execPath);
		const controller = new AbortController();
		const running = runner(["-e", "setTimeout(() => {}, 60_000)"], {
			cwd: tmpdir(),
			timeoutMs: 60_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 25);

		await expect(running).resolves.toEqual({ status: "cancelled" });
	});

	it("propagates cancellation through the full diagnostic", async () => {
		const cwd = await tempDir();

		await expect(
			checkMemoryStoreGitTracking({
				cwd,
				paths: STORE_PATHS,
				timeoutMs: 60_000,
				signal: AbortSignal.abort(),
			}),
		).resolves.toEqual({ kind: "cancelled" });
	});

	it("propagates a timeout through the full diagnostic without blocking", async () => {
		const runner: GitCommandRunner = async () => ({ status: "timed-out" });
		const cwd = await tempDir();

		await expect(checkMemoryStoreGitTracking({ cwd, paths: STORE_PATHS, timeoutMs: 5, runner })).resolves.toEqual({
			kind: "timed-out",
		});
	});

	it("applies the decision rules over a scripted runner", async () => {
		function scripted(results: readonly { stdout?: string; stderr?: string; exitCode?: number }[]): GitCommandRunner {
			let callIndex = 0;
			return async (args) => {
				void args;
				const result = results[callIndex] ?? { stdout: "", exitCode: 0 };
				callIndex++;
				return {
					status: "ok",
					exitCode: result.exitCode ?? 0,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
				};
			};
		}

		// Not inside a work tree (rev-parse fails with the standard message).
		await expect(
			checkMemoryStoreGitTracking({
				cwd: "/tmp",
				paths: STORE_PATHS,
				timeoutMs: 1_000,
				runner: scripted([{ exitCode: 128, stderr: "fatal: not a git repository" }]),
			}),
		).resolves.toEqual({ kind: "non-git" });

		// Inside a work tree with nothing tracked or ignored.
		await expect(
			checkMemoryStoreGitTracking({
				cwd: "/tmp",
				paths: STORE_PATHS,
				timeoutMs: 1_000,
				runner: scripted([{ stdout: "true" }, { stdout: "" }, { stdout: "" }]),
			}),
		).resolves.toEqual({ kind: "untracked" });

		// Tracked wins before the ignore probe.
		await expect(
			checkMemoryStoreGitTracking({
				cwd: "/tmp",
				paths: STORE_PATHS,
				timeoutMs: 1_000,
				runner: scripted([{ stdout: "true" }, { stdout: ".pi/memory/store.json" }]),
			}),
		).resolves.toEqual({ kind: "tracked" });

		// Ignored when ls-files is empty and check-ignore matches.
		await expect(
			checkMemoryStoreGitTracking({
				cwd: "/tmp",
				paths: STORE_PATHS,
				timeoutMs: 1_000,
				runner: scripted([{ stdout: "true" }, { stdout: "" }, { stdout: ".pi/memory/store.json" }]),
			}),
		).resolves.toEqual({ kind: "ignored" });

		// Fatal errors degrade to unavailable.
		const failedRunner: GitCommandRunner = async () => ({ status: "error", reason: "dubious ownership" });
		await expect(
			checkMemoryStoreGitTracking({ cwd: "/tmp", paths: STORE_PATHS, timeoutMs: 1_000, runner: failedRunner }),
		).resolves.toEqual({ kind: "unavailable", reason: "dubious ownership" });
	});

	it("never edits repository-level ignore or exclude files even for tracked Stores", async () => {
		const cwd = await gitRepo();
		const storePath = join(cwd, ".pi", "memory", "store.json");
		await mkdir(join(storePath, ".."), { recursive: true });
		await writeFile(storePath, "{}", "utf8");

		await checkMemoryStoreGitTracking({ cwd, paths: STORE_PATHS, timeoutMs: 2_000 });

		const status = await run("git", ["status", "--porcelain"], { cwd, env: GIT_ENV });
		expect(status.stdout).toBe("?? .pi/\n");
	});
});
