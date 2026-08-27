// new-requirement.mjs — 为仓库分配顺序需求 ID、写入 Markdown 记录并创建对应分支。
//
// CLI：
//   node scripts/new-requirement.mjs --slug <word[-word]> <description>
//
// 分支固定为 req-NNNN-<slug>。脚本只允许从干净的 main 分支执行；分配时同时检查
// requirements/ 记录、可达 Git 历史和本地/远端分支名，避免未合并需求重复使用 ID。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REQUIREMENT_FILE_PATTERN = /^REQ-(\d{4,})\.md$/;
const REQUIREMENT_BRANCH_PATTERN = /(?:^|\/)req-(\d{4,})-[a-z0-9]+(?:-[a-z0-9]+)?$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)?$/;

function commandError(result, fallback) {
	const detail = result.stderr?.trim() || result.stdout?.trim();
	return new Error(detail ? `${fallback}: ${detail}` : fallback);
}

/**
 * 运行仓库内的 Git 命令。
 * @param {string} repoRoot
 * @param {string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
export function runGit(repoRoot, args, { allowFailure = false } = {}) {
	const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
	if (result.error) throw new Error(`cannot run git: ${result.error.message}`);
	const response = {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
	if (!response.ok && !allowFailure) {
		throw commandError(response, `git ${args.join(" ")} failed`);
	}
	return response;
}

/** @param {number} number */
export function formatRequirementId(number) {
	return `REQ-${String(number).padStart(4, "0")}`;
}

/** @param {number} number @param {string} slug */
export function formatBranchName(number, slug) {
	return `${formatRequirementId(number).toLowerCase()}-${slug}`;
}

/** @param {string} slug */
export function validateSlug(slug) {
	return SLUG_PATTERN.test(slug);
}

function collectNumber(value, pattern, numbers) {
	const match = pattern.exec(value);
	if (match) numbers.add(Number.parseInt(match[1], 10));
}

/**
 * 收集当前工作树、全部可达历史和分支名中已经用过的需求编号。
 * @param {string} repoRoot
 * @returns {Set<number>}
 */
export function collectRequirementNumbers(repoRoot) {
	const numbers = new Set();
	const requirementsDir = path.join(repoRoot, "requirements");
	try {
		for (const entry of fs.readdirSync(requirementsDir, { withFileTypes: true })) {
			if (entry.isFile()) collectNumber(entry.name, REQUIREMENT_FILE_PATTERN, numbers);
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}

	const history = runGit(repoRoot, [
		"log",
		"--all",
		"--name-only",
		"--pretty=format:",
		"--",
		"requirements",
	]);
	for (const line of history.stdout.split("\n")) {
		collectNumber(path.basename(line.trim()), REQUIREMENT_FILE_PATTERN, numbers);
	}

	const refs = runGit(repoRoot, [
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads",
		"refs/remotes",
	]);
	for (const line of refs.stdout.split("\n")) {
		collectNumber(line.trim(), REQUIREMENT_BRANCH_PATTERN, numbers);
	}
	return numbers;
}

/** @param {Set<number>} numbers */
export function nextRequirementNumber(numbers) {
	let largest = 0;
	for (const number of numbers) {
		if (Number.isSafeInteger(number) && number > largest) largest = number;
	}
	return largest + 1;
}

/**
 * @param {{ id: string, created: string, branch: string, description: string }} requirement
 */
export function renderRequirement(requirement) {
	return `# ${requirement.id}\n\n- 创建日期：${requirement.created}\n- 分支：\`${requirement.branch}\`\n\n## 描述\n\n${requirement.description.trim()}\n`;
}

/**
 * @param {string[]} argv
 * @returns {{ help: boolean, slug?: string, description?: string }}
 */
export function parseArgs(argv) {
	let slug;
	let positionalOnly = false;
	const descriptionParts = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (!positionalOnly && (arg === "--help" || arg === "-h")) return { help: true };
		if (!positionalOnly && arg === "--") {
			positionalOnly = true;
			continue;
		}
		if (!positionalOnly && (arg === "--slug" || arg.startsWith("--slug="))) {
			if (slug !== undefined) throw new Error("--slug may only be specified once");
			slug = arg === "--slug" ? argv[++index] : arg.slice("--slug=".length);
			if (!slug) throw new Error("--slug requires a value");
			continue;
		}
		if (!positionalOnly && arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
		descriptionParts.push(arg);
	}
	const description = descriptionParts.join(" ").trim();
	if (slug === undefined) throw new Error("missing --slug");
	if (!validateSlug(slug)) {
		throw new Error("slug must contain one or two lowercase words separated by one hyphen");
	}
	if (!description) throw new Error("requirement description must not be empty");
	return { help: false, slug, description };
}

function usage(stream) {
	stream.write(
		"usage: node scripts/new-requirement.mjs --slug <word[-word]> <description>\n",
	);
}

function repositoryRoot(cwd) {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	if (result.error) throw new Error(`cannot run git: ${result.error.message}`);
	if (result.status !== 0) throw commandError(result, "current directory is not a Git repository");
	return path.resolve(result.stdout.trim());
}

function assertReady(repoRoot) {
	const branch = runGit(repoRoot, ["branch", "--show-current"]).stdout.trim();
	if (branch !== "main") {
		throw new Error(`requirements must be created from main (current branch: ${branch || "detached HEAD"})`);
	}
	const trackedStatus = runGit(repoRoot, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
	if (trackedStatus) {
		throw new Error("tracked files are not clean; commit or stash them before creating a requirement");
	}
}

function acquireLock(repoRoot) {
	const commonDirValue = runGit(repoRoot, ["rev-parse", "--git-common-dir"]).stdout.trim();
	const commonDir = path.resolve(repoRoot, commonDirValue);
	const lockPath = path.join(commonDir, "new-requirement.lock");
	try {
		fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new Error(
				`another requirement allocation is already running; if no process is running, remove ${lockPath}`,
			);
		}
		throw error;
	}
	return () => fs.rmSync(lockPath, { force: true });
}

function rollbackBranchCreation(repoRoot, branch, absoluteRecord) {
	fs.rmSync(absoluteRecord, { force: true });
	try {
		let current = runGit(repoRoot, ["branch", "--show-current"], { allowFailure: true }).stdout.trim();
		if (current === branch) {
			runGit(repoRoot, ["switch", "main"], { allowFailure: true });
			current = runGit(repoRoot, ["branch", "--show-current"], { allowFailure: true }).stdout.trim();
		}
		const branchExists = runGit(
			repoRoot,
			["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
			{ allowFailure: true },
		).ok;
		if (branchExists && current !== branch) {
			const deleted = runGit(repoRoot, ["branch", "-D", branch], { allowFailure: true });
			if (deleted.ok) return "";
		}
		if (branchExists) return `; branch ${branch} must be removed manually`;
		return "";
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return `; branch rollback could not be verified: ${detail}`;
	}
}

/**
 * @param {{ repoRoot: string, slug: string, description: string, now?: Date }} input
 * @returns {{ id: string, branch: string, recordPath: string }}
 */
export function createRequirement({ repoRoot, slug, description, now = new Date() }) {
	if (!validateSlug(slug)) {
		throw new Error("slug must contain one or two lowercase words separated by one hyphen");
	}
	if (!description.trim()) throw new Error("requirement description must not be empty");
	assertReady(repoRoot);
	const releaseLock = acquireLock(repoRoot);
	let absoluteRecord;
	try {
		const number = nextRequirementNumber(collectRequirementNumbers(repoRoot));
		const id = formatRequirementId(number);
		const branch = formatBranchName(number, slug);
		const requirementsDir = path.join(repoRoot, "requirements");
		const recordPath = path.join("requirements", `${id}.md`);
		absoluteRecord = path.join(repoRoot, recordPath);

		const existingBranch = runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
			allowFailure: true,
		});
		if (existingBranch.ok) throw new Error(`branch already exists: ${branch}`);

		fs.mkdirSync(requirementsDir, { recursive: true });
		try {
			fs.writeFileSync(
				absoluteRecord,
				renderRequirement({
					id,
					created: now.toISOString().slice(0, 10),
					branch,
					description,
				}),
				{ flag: "wx" },
			);
		} catch (error) {
			if (error?.code !== "EEXIST") fs.rmSync(absoluteRecord, { force: true });
			throw error;
		}

		let switched;
		try {
			switched = runGit(repoRoot, ["switch", "-c", branch], { allowFailure: true });
		} catch (error) {
			const rollbackNote = rollbackBranchCreation(repoRoot, branch, absoluteRecord);
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`could not create branch ${branch}; requirement record was rolled back${rollbackNote}: ${detail}`,
				{ cause: error },
			);
		}
		if (!switched.ok) {
			const rollbackNote = rollbackBranchCreation(repoRoot, branch, absoluteRecord);
			throw commandError(
				switched,
				`could not create branch ${branch}; requirement record was rolled back${rollbackNote}`,
			);
		}
		return { id, branch, recordPath };
	} finally {
		releaseLock();
	}
}

export function main(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
	try {
		const args = parseArgs(argv);
		if (args.help) {
			usage(stdout);
			return 0;
		}
		const result = createRequirement({
			repoRoot: repositoryRoot(cwd),
			slug: args.slug,
			description: args.description,
		});
		stdout.write(`created requirement: ${result.id}\n`);
		stdout.write(`record: ${result.recordPath}\n`);
		stdout.write(`branch: ${result.branch}\n`);
		return 0;
	} catch (error) {
		stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

const invokedAsCli =
	process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) process.exitCode = main(process.argv.slice(2));
