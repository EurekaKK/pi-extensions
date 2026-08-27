// new-requirement.mjs 的端到端测试：使用临时 Git 仓库验证 ID 分配、记录写入、分支创建和失败守卫。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	formatBranchName,
	formatRequirementId,
	nextRequirementNumber,
	parseArgs,
	validateSlug,
} from "../new-requirement.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REQUIREMENT_SCRIPT = path.join(REPO_ROOT, "scripts", "new-requirement.mjs");

function run(command, args, cwd) {
	return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function git(repo, ...args) {
	const result = run("git", args, repo);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function makeGitRepo(t) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-requirement-test-"));
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	git(repo, "init", "--initial-branch=main");
	git(repo, "config", "user.name", "Requirement Test");
	git(repo, "config", "user.email", "requirements@example.invalid");
	fs.mkdirSync(path.join(repo, "requirements"));
	fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
	fs.writeFileSync(path.join(repo, "requirements", "README.md"), "# Requirements\n");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "fixture");
	return repo;
}

function runRequirement(repo, ...args) {
	return run(process.execPath, [REQUIREMENT_SCRIPT, ...args], repo);
}

test("格式化 ID、分支名并只接受一至两个 slug 单词", () => {
	assert.equal(formatRequirementId(7), "REQ-0007");
	assert.equal(formatBranchName(7, "memory-export"), "req-0007-memory-export");
	assert.equal(nextRequirementNumber(new Set([1, 9, 3])), 10);
	assert.equal(validateSlug("memory"), true);
	assert.equal(validateSlug("memory-export"), true);
	assert.equal(validateSlug("memory-export-tool"), false);
	assert.equal(validateSlug("Memory"), false);
	assert.deepEqual(parseArgs(["--slug", "memory-export", "增加", "导出功能"]), {
		help: false,
		slug: "memory-export",
		description: "增加 导出功能",
	});
});

test("创建需求记录并切换到 ID 对应分支，未跟踪文件不阻塞", (t) => {
	const repo = makeGitRepo(t);
	fs.writeFileSync(path.join(repo, "local-notes.txt"), "untracked\n");

	const result = runRequirement(repo, "--slug", "memory-export", "增加 Memory 导出功能");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /created requirement: REQ-0001/);
	assert.equal(git(repo, "branch", "--show-current"), "req-0001-memory-export");

	const record = fs.readFileSync(path.join(repo, "requirements", "REQ-0001.md"), "utf8");
	assert.match(record, /^# REQ-0001/m);
	assert.match(record, /分支：`req-0001-memory-export`/);
	assert.match(record, /增加 Memory 导出功能/);
	assert.equal(fs.existsSync(path.join(repo, "local-notes.txt")), true);
});

test("未合并需求只存在于其他分支时，仍从分支 ref 分配下一个 ID", (t) => {
	const repo = makeGitRepo(t);
	const first = runRequirement(repo, "--slug", "memory-export", "第一个需求");
	assert.equal(first.status, 0, first.stderr);
	git(repo, "add", "requirements/REQ-0001.md");
	git(repo, "commit", "-m", "record first requirement");
	git(repo, "switch", "main");
	assert.equal(fs.existsSync(path.join(repo, "requirements", "REQ-0001.md")), false);

	const second = runRequirement(repo, "--slug", "goal", "第二个需求");
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /created requirement: REQ-0002/);
	assert.equal(git(repo, "branch", "--show-current"), "req-0002-goal");
	assert.equal(fs.existsSync(path.join(repo, "requirements", "REQ-0002.md")), true);
});

test("历史中出现后又删除的记录不会导致 ID 被复用", (t) => {
	const repo = makeGitRepo(t);
	fs.writeFileSync(path.join(repo, "requirements", "REQ-0004.md"), "# REQ-0004\n");
	git(repo, "add", "requirements/REQ-0004.md");
	git(repo, "commit", "-m", "add old requirement");
	git(repo, "rm", "requirements/REQ-0004.md");
	git(repo, "commit", "-m", "remove old requirement");

	const result = runRequirement(repo, "--slug", "search", "不要复用旧 ID");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /created requirement: REQ-0005/);
	assert.equal(git(repo, "branch", "--show-current"), "req-0005-search");
});

test("已跟踪文件不干净时拒绝创建且没有需求或分支副作用", (t) => {
	const repo = makeGitRepo(t);
	fs.appendFileSync(path.join(repo, "README.md"), "dirty\n");

	const result = runRequirement(repo, "--slug", "memory", "不能创建");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /tracked files are not clean/);
	assert.equal(git(repo, "branch", "--show-current"), "main");
	assert.equal(fs.existsSync(path.join(repo, "requirements", "REQ-0001.md")), false);
	assert.equal(git(repo, "branch", "--list", "req-0001-memory"), "");
});

test("非 main 分支和非法 slug 都在写入前失败", (t) => {
	const repo = makeGitRepo(t);
	const invalid = runRequirement(repo, "--slug", "too-many-words", "非法 slug");
	assert.notEqual(invalid.status, 0);
	assert.match(invalid.stderr, /one or two lowercase words/);
	assert.equal(fs.existsSync(path.join(repo, "requirements", "REQ-0001.md")), false);

	git(repo, "switch", "-c", "feat/existing");
	const wrongBase = runRequirement(repo, "--slug", "memory", "错误起点");
	assert.notEqual(wrongBase.status, 0);
	assert.match(wrongBase.stderr, /must be created from main/);
	assert.equal(fs.existsSync(path.join(repo, "requirements", "REQ-0001.md")), false);
});

test("并发分配锁存在时 fail-closed 且不写记录", (t) => {
	const repo = makeGitRepo(t);
	const lockPath = path.join(repo, ".git", "new-requirement.lock");
	fs.writeFileSync(lockPath, `${process.pid}\n`);

	const result = runRequirement(repo, "--slug", "memory", "并发需求");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /another requirement allocation is already running/);
	assert.equal(fs.existsSync(path.join(repo, "requirements", "REQ-0001.md")), false);
	assert.equal(git(repo, "branch", "--show-current"), "main");
});

test("Git 分支创建失败时回滚需求记录并释放分配锁", (t) => {
	const repo = makeGitRepo(t);
	const tooLongSlug = "x".repeat(300);

	const result = runRequirement(repo, "--slug", tooLongSlug, "分支创建会失败");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /requirement record was rolled back/);
	assert.equal(fs.existsSync(path.join(repo, "requirements", "REQ-0001.md")), false);
	assert.equal(fs.existsSync(path.join(repo, ".git", "new-requirement.lock")), false);
	assert.equal(git(repo, "branch", "--show-current"), "main");
});

test("post-checkout hook 报错时回到 main 并删除已创建的孤儿分支", (t) => {
	const repo = makeGitRepo(t);
	const hook = path.join(repo, ".git", "hooks", "post-checkout");
	fs.writeFileSync(hook, "#!/bin/sh\nexit 7\n");
	fs.chmodSync(hook, 0o755);

	const result = runRequirement(repo, "--slug", "memory", "hook 会让 switch 返回失败");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /requirement record was rolled back/);
	assert.equal(git(repo, "branch", "--show-current"), "main");
	assert.equal(git(repo, "branch", "--list", "req-0001-memory"), "");
	assert.equal(fs.existsSync(path.join(repo, "requirements", "REQ-0001.md")), false);
	assert.equal(fs.existsSync(path.join(repo, ".git", "new-requirement.lock")), false);
});

test("脚本语法与帮助信息可用", () => {
	const syntax = run(process.execPath, ["--check", REQUIREMENT_SCRIPT], REPO_ROOT);
	assert.equal(syntax.status, 0, syntax.stderr);
	const help = runRequirement(REPO_ROOT, "--help");
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--slug <word\[-word\]>/);
});
