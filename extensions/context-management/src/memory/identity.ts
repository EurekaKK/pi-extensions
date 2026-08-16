import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { throwIfAborted } from "../errors.js";
import { sha256Hex } from "../stable-json.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 64 * 1024;

export interface RepositoryIdentity {
	readonly key: string;
	readonly identityKind: "git-common-dir" | "directory";
	readonly canonicalPath: string;
	readonly repositoryRoot: string;
	readonly branch: string | null;
	readonly head: string | null;
}

export interface RepositoryPaths {
	readonly directory: string;
	readonly memoryFile: string;
	readonly lockDirectory: string;
}

async function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string | null> {
	throwIfAborted(signal);
	try {
		const { stdout } = await execFileAsync("git", [...args], {
			cwd,
			encoding: "utf8",
			maxBuffer: GIT_MAX_BUFFER,
			signal,
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
		});
		const value = stdout.trim();
		return value.length === 0 ? null : value;
	} catch {
		throwIfAborted(signal);
		return null;
	}
}

async function existingDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function discoverRepositoryIdentity(cwd: string, signal?: AbortSignal): Promise<RepositoryIdentity> {
	const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
	if (commonDir !== null && (await existingDirectory(commonDir))) {
		const [canonicalPath, rootText, branch, head] = await Promise.all([
			realpath(commonDir),
			git(cwd, ["rev-parse", "--show-toplevel"], signal),
			git(cwd, ["branch", "--show-current"], signal),
			git(cwd, ["rev-parse", "HEAD"], signal),
		]);
		const repositoryRoot = rootText === null ? await realpath(cwd) : await realpath(rootText);
		return Object.freeze({
			key: `git-${sha256Hex(canonicalPath)}`,
			identityKind: "git-common-dir",
			canonicalPath,
			repositoryRoot,
			branch,
			head,
		});
	}
	throwIfAborted(signal);
	const canonicalPath = await realpath(cwd);
	return Object.freeze({
		key: `dir-${sha256Hex(canonicalPath)}`,
		identityKind: "directory",
		canonicalPath,
		repositoryRoot: canonicalPath,
		branch: null,
		head: null,
	});
}

export function repositoryPaths(agentDirectory: string, identity: RepositoryIdentity): RepositoryPaths {
	const directory = join(agentDirectory, "context-management", "repositories", identity.key);
	const memoryFile = join(directory, "memory.json");
	return Object.freeze({ directory, memoryFile, lockDirectory: `${memoryFile}.lock` });
}
