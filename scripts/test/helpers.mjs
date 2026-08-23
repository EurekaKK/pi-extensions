// helpers.mjs — scripts/ 安装脚本的测试工具：临时 fixture 仓库、fake pi、进程封装。
// 所有测试只访问临时目录，绝不触碰真实 ~/.pi。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install-extension.sh");
export const PLAN_MODULE = path.join(REPO_ROOT, "scripts", "install-plan.mjs");

/** 创建一次性临时目录，并在测试结束后递归删除；t 缺省时不注册清理（仅测试内自管时用）。 */
export function makeTempDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-script-test-"));
	if (t && typeof t.after === "function") t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * 在临时目录里构造 fixture 仓库。
 * extensions/packages 各是一个 { name: manifest 附加字段 } 映射；manifest 自动补全
 * name/version/private/type。返回仓库根目录绝对路径。
 */
export function makeFixtureRepo(t, { extensions = {}, packages = {} } = {}) {
	const root = makeTempDir(t);
	const write = (sub, name, fields) => {
		const dir = path.join(root, sub, name);
		fs.mkdirSync(dir, { recursive: true });
		const manifest = { name, version: "0.1.0", private: true, type: "module", ...fields };
		fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	};
	for (const [name, fields] of Object.entries(extensions)) write("extensions", name, fields);
	for (const [name, fields] of Object.entries(packages)) write("packages", name, fields);
	return root;
}

/**
 * 创建 fake pi：把每条调用参数写入 logFile，并要求 install 目标存在 package.json。
 * 返回应置于 PATH 最前的目录。
 */
export function makeFakePi(t, logFile) {
	const dir = makeTempDir(t);
	const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${FAKE_PI_LOG:?}"
dest=
for a in "$@"; do dest="$a"; done
if [ ! -f "$dest/package.json" ]; then
	echo "fake pi: install target has no package.json: $dest" >&2
	exit 1
fi
`;
	fs.writeFileSync(path.join(dir, "pi"), script);
	fs.chmodSync(path.join(dir, "pi"), 0o755);
	return dir;
}

/**
 * 在隔离环境里运行真实的 scripts/install-extension.sh：
 * PATH 前置 fake pi 目录；HOME、PI_AGENT_DIR、PI_EXTENSIONS_REPO_ROOT 全部指向临时路径。
 * 返回 { status, stdout, stderr, logFile, agentDir }。
 */
export function runInstallScript(t, { repoRoot, agentDir, args = [] }) {
	const sandbox = makeTempDir(t);
	const logFile = path.join(sandbox, "pi.log");
	const fakeBin = makeFakePi(t, logFile);
	const proc = spawnSync("bash", [INSTALL_SCRIPT, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH}`,
			HOME: sandbox,
			PI_AGENT_DIR: agentDir,
			PI_EXTENSIONS_REPO_ROOT: repoRoot,
			FAKE_PI_LOG: logFile,
		},
	});
	return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, logFile, agentDir };
}

/** 读取 fake pi 的调用日志（每行一条完整参数串）。 */
export function readPiLog(logFile) {
	if (!fs.existsSync(logFile)) return [];
	return fs
		.readFileSync(logFile, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}