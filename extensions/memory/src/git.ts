import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Advisory Git tracking diagnostics for the Memory Store.
 *
 * The check is read-only: it never modifies repository-level ignore or exclude
 * files. Every git invocation has a short timeout, propagates an AbortSignal
 * where available, and a failure or timeout degrades to a reported state
 * instead of blocking or failing status inspection.
 */
export type GitTrackState =
	| { readonly kind: "non-git" }
	| { readonly kind: "unavailable"; readonly reason: string }
	| { readonly kind: "timed-out" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "tracked" }
	| { readonly kind: "ignored" }
	| { readonly kind: "untracked" };

export type GitCommandResult =
	| { readonly status: "ok"; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
	| { readonly status: "timed-out" }
	| { readonly status: "cancelled" }
	| { readonly status: "error"; readonly reason: string };

export interface GitCommandInput {
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export type GitCommandRunner = (args: readonly string[], input: GitCommandInput) => Promise<GitCommandResult>;

function classifyRunnerError(error: unknown, signal: AbortSignal | undefined): GitCommandResult {
	if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
		return { status: "cancelled" };
	}
	if (typeof error !== "object" || error === null) return { status: "error", reason: "git command failed" };
	const candidate = error as Record<string, unknown>;
	if (candidate.code === "ABORT_ERR") return { status: "cancelled" };
	if (typeof candidate.code === "number") {
		return {
			status: "ok",
			exitCode: candidate.code,
			stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
			stderr: typeof candidate.stderr === "string" ? candidate.stderr : "",
		};
	}
	if (candidate.code === "ENOENT") return { status: "error", reason: "git is not available on this machine" };
	if (candidate.killed === true) return { status: "timed-out" };
	if (typeof candidate.stderr === "string" && candidate.stderr.trim().length > 0) {
		return { status: "error", reason: candidate.stderr.trim().split("\n", 1)[0] ?? "git command failed" };
	}
	return { status: "error", reason: "git command failed" };
}

/**
 * Runner over the real `git` binary. The command name is injectable so tests
 * can exercise timeout and cancellation against any executable.
 */
export function createGitCommandRunner(command = "git"): GitCommandRunner {
	return async (args, input) => {
		try {
			const result = await execFileAsync(command, [...args], {
				cwd: input.cwd,
				timeout: input.timeoutMs,
				signal: input.signal,
				windowsHide: true,
				maxBuffer: 1_048_576,
			});
			return { status: "ok", exitCode: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			return classifyRunnerError(error, input.signal);
		}
	};
}

export interface CheckMemoryStoreGitTrackingOptions {
	readonly cwd: string;
	/** Store paths relative to `cwd` to probe for tracked/ignored status. */
	readonly paths: readonly string[];
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	readonly runner?: GitCommandRunner;
}

function toGitPath(value: string): string {
	return value.split(/[\\/]+/u).join("/");
}

function firstLine(value: string): string {
	return value.trim().split("\n", 1)[0] ?? "git command failed";
}

/**
 * Determine the advisory Git tracking state of the Store paths. Never writes
 * anything; never edits repository-level ignore or exclude files.
 */
export async function checkMemoryStoreGitTracking(options: CheckMemoryStoreGitTrackingOptions): Promise<GitTrackState> {
	const runner = options.runner ?? createGitCommandRunner();
	const input: GitCommandInput = {
		cwd: options.cwd,
		timeoutMs: options.timeoutMs,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	};
	const paths = options.paths.map(toGitPath);

	const inside = await runner(["rev-parse", "--is-inside-work-tree"], input);
	if (inside.status === "timed-out") return { kind: "timed-out" };
	if (inside.status === "cancelled") return { kind: "cancelled" };
	if (inside.status === "error") return { kind: "unavailable", reason: inside.reason };
	if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
		const stderr = inside.stderr.trim();
		if (stderr.length > 0 && !/not a git repository/iu.test(stderr)) {
			return { kind: "unavailable", reason: firstLine(stderr) };
		}
		return { kind: "non-git" };
	}

	const tracked = await runner(["ls-files", "--", ...paths], input);
	if (tracked.status === "timed-out") return { kind: "timed-out" };
	if (tracked.status === "cancelled") return { kind: "cancelled" };
	if (tracked.status === "error") return { kind: "unavailable", reason: tracked.reason };
	if (tracked.exitCode === 0 && tracked.stdout.trim().length > 0) return { kind: "tracked" };

	const ignored = await runner(["check-ignore", "--", ...paths], input);
	if (ignored.status === "timed-out") return { kind: "timed-out" };
	if (ignored.status === "cancelled") return { kind: "cancelled" };
	if (ignored.status === "error") return { kind: "unavailable", reason: ignored.reason };
	if (ignored.exitCode === 0 && ignored.stdout.trim().length > 0) return { kind: "ignored" };

	return { kind: "untracked" };
}
