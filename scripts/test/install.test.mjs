// install-extension.sh 的端到端测试：临时 fixture 仓库 + fake pi，全程不访问真实 ~/.pi。
// 覆盖：依赖 closure 的镜像与安装顺序、多根/菱形去重、已安装副本同步更新、
// unknown / 环导致的零写入失败、外部 dependencies 不被误处理。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
	makeFixtureRepo,
	makeTempDir,
	runInstallScript,
	readPiLog,
	INSTALL_SCRIPT,
	PLAN_MODULE,
} from "./helpers.mjs";

const DEPS_FIELD = "piExtensionDependencies";

function baseFixture(t) {
	return makeFixtureRepo(t, {
		extensions: {
			a: { [DEPS_FIELD]: ["b"], dependencies: { p: "*", "some-external": "^1.0.0" } },
			b: {},
			c: { [DEPS_FIELD]: ["missing-ext"] },
			d: { [DEPS_FIELD]: ["b"] },
			e: { [DEPS_FIELD]: ["f"] },
			f: { [DEPS_FIELD]: ["e"] },
			g: { dependencies: { "external-only": "^9.9.9" } },
			h: { dependencies: { r: "*" } },
		},
		packages: {
			p: { dependencies: { q: "*" } },
			q: {},
			r: { dependencies: { s: "*" } },
			s: { dependencies: { r: "*" } },
		},
	});
}

test("依赖 extension 先镜像并分别 pi install（依赖优先顺序）", (t) => {
	const repo = baseFixture(t);
	fs.writeFileSync(path.join(repo, "extensions", "a", "lib.txt"), "v1");
	fs.writeFileSync(path.join(repo, "packages", "p", "impl.ts"), "export const p = 1;");
	fs.writeFileSync(path.join(repo, "packages", "q", "impl.ts"), "export const q = 1;");
	const agentDir = path.join(makeTempDir(t), "agent");

	const res = runInstallScript(t, { repoRoot: repo, agentDir, args: ["a"] });
	assert.equal(res.status, 0, res.stderr);

	const destA = path.join(agentDir, "my-extensions", "a");
	const destB = path.join(agentDir, "my-extensions", "b");

	// 两个 extension 都被镜像
	assert.equal(fs.readFileSync(path.join(destB, "package.json"), "utf8").includes('"name": "b"'), true);
	assert.equal(fs.readFileSync(path.join(destA, "lib.txt"), "utf8"), "v1");
	// 副本是隔离镜像，不包含源仓库无关文件
	assert.equal(fs.existsSync(path.join(destA, "some-external")), false);

	// a 的完整 package 闭包平铺 vendor；b 没有闭包则不建 node_modules
	assert.equal(fs.readFileSync(path.join(destA, "node_modules", "q", "impl.ts"), "utf8"), "export const q = 1;");
	assert.equal(fs.readFileSync(path.join(destA, "node_modules", "p", "impl.ts"), "utf8"), "export const p = 1;");
	assert.equal(fs.existsSync(path.join(destB, "node_modules")), false);

	// 依赖优先：b 先于 a 被 pi install
	assert.deepEqual(readPiLog(res.logFile), [`install ${destB}`, `install ${destA}`]);
	assert.ok(res.stdout.includes("plan: b a"));
	assert.ok(res.stdout.includes("installed: a ->"));
});

test("多根与菱形去重：共享依赖只镜像安装一次", (t) => {
	const repo = baseFixture(t);
	const agentDir = path.join(makeTempDir(t), "agent");

	const res = runInstallScript(t, { repoRoot: repo, agentDir, args: ["a", "d"] });
	assert.equal(res.status, 0, res.stderr);

	const log = readPiLog(res.logFile);
	assert.deepEqual(
		log.map((line) => line.replace(/^install /, "").split("/").pop()),
		["b", "a", "d"],
	);
	assert.equal(new Set(log).size, 3, "b 只能被安装一次");
	assert.ok(fs.existsSync(path.join(agentDir, "my-extensions", "b")));
});

test("已安装副本同步更新：重跑覆盖内容并清除过期文件", (t) => {
	const repo = baseFixture(t);
	fs.writeFileSync(path.join(repo, "extensions", "a", "lib.txt"), "v1");
	const agentDir = path.join(makeTempDir(t), "agent");

	const first = runInstallScript(t, { repoRoot: repo, agentDir, args: ["a"] });
	assert.equal(first.status, 0, first.stderr);

	const destA = path.join(agentDir, "my-extensions", "a");
	const destB = path.join(agentDir, "my-extensions", "b");
	// 源文件更新 + 副本出现过期文件
	fs.writeFileSync(path.join(repo, "extensions", "a", "lib.txt"), "v2");
	fs.writeFileSync(path.join(destA, "stale.txt"), "stale");
	fs.writeFileSync(path.join(destB, "stale.txt"), "stale");

	const second = runInstallScript(t, { repoRoot: repo, agentDir, args: ["a"] });
	assert.equal(second.status, 0, second.stderr);
	assert.equal(fs.readFileSync(path.join(destA, "lib.txt"), "utf8"), "v2");
	assert.equal(fs.existsSync(path.join(destA, "stale.txt")), false);
	assert.equal(fs.existsSync(path.join(destB, "stale.txt")), false);
	// 更新同样对全部涉及项重新 pi install
	assert.equal(readPiLog(second.logFile).length, 2);
});

test("unknown 依赖：计划失败且零写入", (t) => {
	const repo = baseFixture(t);
	const agentDir = path.join(makeTempDir(t), "agent");

	const res = runInstallScript(t, { repoRoot: repo, agentDir, args: ["c"] });
	assert.notEqual(res.status, 0);
	assert.ok(res.stderr.includes("unknown extension dependency: c -> missing-ext"), res.stderr);
	assert.ok(res.stderr.includes("nothing was written"), res.stderr);
	assert.equal(fs.existsSync(path.join(agentDir, "my-extensions")), false);
	assert.deepEqual(readPiLog(res.logFile), []);
});

test("extension 依赖环：计划失败且零写入", (t) => {
	const repo = baseFixture(t);
	const agentDir = path.join(makeTempDir(t), "agent");

	const res = runInstallScript(t, { repoRoot: repo, agentDir, args: ["e"] });
	assert.notEqual(res.status, 0);
	assert.ok(res.stderr.includes("extension dependency cycle: e -> f -> e"), res.stderr);
	assert.equal(fs.existsSync(path.join(agentDir, "my-extensions")), false);
	assert.deepEqual(readPiLog(res.logFile), []);
});

test("内部 package 依赖环：计划失败且零写入", (t) => {
	const repo = baseFixture(t);
	const agentDir = path.join(makeTempDir(t), "agent");

	const res = runInstallScript(t, { repoRoot: repo, agentDir, args: ["h"] });
	assert.notEqual(res.status, 0);
	assert.ok(res.stderr.includes("h: package dependency cycle: r -> s -> r"), res.stderr);
	assert.equal(fs.existsSync(path.join(agentDir, "my-extensions")), false);
	assert.deepEqual(readPiLog(res.logFile), []);
});

test("纯外部 dependencies：正常安装且不 vendor、不当作 extension", (t) => {
	const repo = baseFixture(t);
	const agentDir = path.join(makeTempDir(t), "agent");

	const res = runInstallScript(t, { repoRoot: repo, agentDir, args: ["g"] });
	assert.equal(res.status, 0, res.stderr);

	const destG = path.join(agentDir, "my-extensions", "g");
	assert.equal(fs.existsSync(path.join(destG, "node_modules")), false);
	assert.deepEqual(readPiLog(res.logFile), [`install ${destG}`]);
});

test("脚本语法检查：bash -n 与 node --check", () => {
	const bash = spawnSync("bash", ["-n", INSTALL_SCRIPT], { encoding: "utf8" });
	assert.equal(bash.status, 0, bash.stderr);
	const node = spawnSync("node", ["--check", PLAN_MODULE], { encoding: "utf8" });
	assert.equal(node.status, 0, node.stderr);
});