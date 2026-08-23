// install-plan.mjs — 安装计划的纯解析模块（无副作用：只读取仓库 manifest，不写入任何文件）。
//
// scripts/install-extension.sh 只负责“执行本模块生成的计划”；解析、校验（unknown / self /
// cycle / missing）、闭包收集与稳定拓扑排序全部在这里完成，便于用 node:test 直接测试。
//
// 语义：
//   - `piExtensionDependencies: string[]`（package.json 自定义字段）声明对其他 extension 的
//     安装期依赖：只允许引用 `extensions/` 下真实存在的目录名，必须无环，不允许自依赖。
//     该字段只影响安装顺序与去重，不构成源码依赖（源码仍禁止 import 兄弟 extension）。
//   - `dependencies` 中命中 `packages/*`（存在对应目录）的条目是内部 package 代码依赖，
//     按 package 之间的依赖递归解析闭包（检测缺失 / 循环）；扩展的“完整 package 闭包”
//     平铺去重后由脚本 vendor 进副本的 node_modules。其他 dependencies（第三方、peer scope）
//     命中 extensions/* 名字的误写会被拒绝；其余视为外部依赖，不会被 vendor。
//
// CLI：
//   node scripts/install-plan.mjs [--repo <repo-root>] [--agent <agent-dir>] <extension-name>...
//
//   成功：stdout 输出计划 JSON（拓扑序，依赖在前），exit 0。
//   失败：stderr 逐行输出 error 信息，exit 1；调用方必须保证此时尚未写入任何目标文件。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_EXTENSION_DEPS_FIELD = "piExtensionDependencies";
export const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

// 目录名用作 package 标识时允许的字符集（kebab-case 为仓库约定，这里同时挡住路径穿越）。
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 读取一个 package.json，返回解析后的对象；文件缺失、JSON 损坏或顶层不是对象时返回 null。
 * @param {string} file
 * @returns {object | null}
 */
export function readManifest(file) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			return value;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * 扫描 repoRoot 下的 extensions/ 与 packages/，构建 registry。
 * registry 值为 manifest（存在且有效）或 null（目录存在但没有有效 package.json）；
 * 目录不存在或名字不合法时不含条目。
 * @param {string} repoRoot
 * @returns {{ extensions: Map<string, object|null>, packages: Map<string, object|null> }}
 */
export function readRegistry(repoRoot) {
	const extensions = new Map();
	const packages = new Map();
	for (const [sub, map] of [
		["extensions", extensions],
		["packages", packages],
	]) {
		const dir = path.join(repoRoot, sub);
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			// 目录不存在：registry 为空
		}
		for (const ent of entries) {
			if (!ent.isDirectory() || !SAFE_NAME.test(ent.name)) continue;
			map.set(ent.name, readManifest(path.join(dir, ent.name, "package.json")));
		}
	}
	return { extensions, packages };
}

/**
 * 在有向图（依赖边：extension -> 依赖的 extension）上找环；同一实体的环只报一条。
 * @param {Set<string>} names
 * @param {Map<string, string[]>} deps
 * @returns {string[][]} 每条环是从环上某节点出发回到自身的路径
 */
export function findCycles(names, deps) {
	const cycles = [];
	const state = new Map(); // 1 = 在访问路径上, 2 = 已完成
	const path = [];
	const visit = (n) => {
		state.set(n, 1);
		path.push(n);
		for (const d of deps.get(n) ?? []) {
			if (!names.has(d)) continue;
			const s = state.get(d);
			if (s === 1) {
				cycles.push([...path.slice(path.indexOf(d)), d]);
			} else if (s === undefined) {
				visit(d);
			}
		}
		path.pop();
		state.set(n, 2);
	};
	for (const n of [...names].sort()) {
		if (state.get(n) === undefined) visit(n);
	}
	return cycles;
}

/**
 * Kahn 拓扑排序：依赖优先（先出现不依赖任何成员的节点），同层按名称字母序，结果确定可复现。
 * @param {Set<string>} names
 * @param {Map<string, string[]>} deps
 * @returns {string[]}
 */
export function topoSort(names, deps) {
	const indegree = new Map();
	const dependents = new Map();
	for (const n of names) {
		indegree.set(n, 0);
		dependents.set(n, []);
	}
	for (const n of names) {
		for (const d of deps.get(n) ?? []) {
			if (!names.has(d)) continue;
			// n 依赖 d：d 必须先于 n 放置，所以入度记在依赖者 n 上
			indegree.set(n, indegree.get(n) + 1);
			dependents.get(d).push(n);
		}
	}
	const ready = [...names].filter((n) => indegree.get(n) === 0).sort();
	const order = [];
	while (ready.length > 0) {
		const n = ready.shift();
		order.push(n);
		for (const m of dependents.get(n)) {
			const v = indegree.get(m) - 1;
			indegree.set(m, v);
			if (v === 0) {
				ready.push(m);
				ready.sort(); // 保持确定顺序（success 路径上无环，必然能排完）
			}
		}
	}
	return order;
}

/**
 * 从某个 manifest 的 dependencies 出发，仅跟随命中 packages/* 的内部包，返回
 * 依赖优先、平铺去重（菱形只出现一次）的闭包顺序；同时报告缺失 / 循环。
 * 不命中 packages/ 的依赖视为外部依赖并忽略——绝不会被当成 extension 或 vendor 对象。
 * @param {Map<string, object|null>} packages
 * @param {object | null} manifest
 * @returns {{ order: string[], errors: string[] }}
 */
export function resolvePackageClosure(packages, manifest) {
	const errors = [];
	const order = [];
	const done = new Set();
	const visiting = [];
	const visit = (name) => {
		if (done.has(name)) return;
		const entry = packages.get(name);
		if (entry === undefined) return; // 外部依赖（packages/ 下无此目录），忽略
		if (entry === null) {
			errors.push(`missing package.json: packages/${name}`);
			return;
		}
		const at = visiting.indexOf(name);
		if (at !== -1) {
			errors.push(`package dependency cycle: ${[...visiting.slice(at), name].join(" -> ")}`);
			return;
		}
		visiting.push(name);
		for (const dep of Object.keys(entry.dependencies ?? {})) {
			if (packages.has(dep)) visit(dep);
		}
		visiting.pop();
		done.add(name);
		order.push(name);
	};
	for (const dep of Object.keys(manifest?.dependencies ?? {})) {
		if (packages.has(dep)) visit(dep);
	}
	return { order, errors };
}

/**
 * 纯解析核心：不触碰文件系统，registry 由调用方注入，便于单测。
 * @param {{ extensions: Map<string, object|null>, packages: Map<string, object|null>, requested: string[] }} input
 * @returns {{ ok: boolean, errors: string[], plan: Array<{name: string, root: boolean, extensionDeps: string[], packages: string[]}> }}
 */
export function resolvePlan({ extensions, packages, requested }) {
	const errors = [];
	const fail = (msg) => errors.push(msg);

	// 1) 校验命令行请求的根
	for (const name of requested) {
		if (!SAFE_NAME.test(name) || !extensions.has(name)) {
			fail(`unknown extension: ${name} (not found under extensions/)`);
		} else if (extensions.get(name) === null) {
			fail(`missing package.json: extensions/${name}`);
		}
	}
	if (errors.length > 0) {
		return { ok: false, errors: [...new Set(errors)], plan: [] };
	}

	// 2) 从所有根出发 BFS，收集涉及的全部 extension 并校验依赖声明
	const involved = new Set();
	const extDeps = new Map();
	const queue = [...new Set(requested)];
	for (let i = 0; i < queue.length; i++) {
		const name = queue[i];
		if (involved.has(name)) continue;
		involved.add(name);
		const manifest = extensions.get(name);
		const raw = manifest?.[PI_EXTENSION_DEPS_FIELD];
		if (raw === undefined) {
			extDeps.set(name, []);
			continue;
		}
		if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) {
			fail(`invalid ${PI_EXTENSION_DEPS_FIELD} in ${name}: must be an array of extension names`);
			extDeps.set(name, []);
			continue;
		}
		const deps = [];
		for (const dep of raw) {
			if (dep === name) {
				fail(`self dependency: ${name} -> ${name}`);
				continue;
			}
			if (!SAFE_NAME.test(dep) || !extensions.has(dep)) {
				fail(`unknown extension dependency: ${name} -> ${dep} (not found under extensions/)`);
				continue;
			}
			if (extensions.get(dep) === null) {
				fail(`missing package.json: extensions/${dep}`);
				continue;
			}
			if (!deps.includes(dep)) deps.push(dep);
			if (!involved.has(dep)) queue.push(dep);
		}
		extDeps.set(name, deps);
	}

	// 3) extension 依赖环检测
	for (const cycle of findCycles(involved, extDeps)) {
		fail(`extension dependency cycle: ${cycle.join(" -> ")}`);
	}

	// 4) 每个 extension 的完整内部 package 闭包（依赖优先、平铺去重）
	const packageClosures = new Map();
	for (const name of involved) {
		const manifest = extensions.get(name);
		for (const dependency of Object.keys(manifest?.dependencies ?? {})) {
			if (extensions.has(dependency)) {
				fail(
					`${name}: extension dependency ${dependency} must be declared in ${PI_EXTENSION_DEPS_FIELD}, not dependencies`,
				);
			}
		}
		const res = resolvePackageClosure(packages, manifest);
		for (const e of res.errors) fail(`${name}: ${e}`);
		packageClosures.set(name, res.order);
	}

	const uniqueErrors = [...new Set(errors)];
	if (uniqueErrors.length > 0) {
		return { ok: false, errors: uniqueErrors, plan: [] };
	}

	// 5) 依赖优先、稳定的拓扑排序（多根 / 菱形自然去重）
	return {
		ok: true,
		errors: [],
		plan: topoSort(involved, extDeps).map((name) => ({
			name,
			root: requested.includes(name),
			extensionDeps: extDeps.get(name) ?? [],
			packages: packageClosures.get(name) ?? [],
		})),
	};
}

/**
 * 文件系统适配层：读 registry 并补齐 src/dest 路径。
 * @param {{ repoRoot: string, agentDir: string, requested: string[] }} input
 * @returns {{ ok: boolean, errors: string[], plan: Array<{name, root, extensionDeps, packages, src, dest}> }}
 */
export function buildPlan({ repoRoot, agentDir, requested }) {
	const { extensions, packages } = readRegistry(repoRoot);
	const res = resolvePlan({ extensions, packages, requested });
	if (!res.ok) return res;
	return {
		ok: true,
		errors: [],
		plan: res.plan.map((e) => ({
			...e,
			src: path.join(repoRoot, "extensions", e.name),
			dest: path.join(agentDir, "my-extensions", e.name),
		})),
	};
}

function usage(out) {
	out.write(`usage: node scripts/install-plan.mjs [--repo <repo-root>] [--agent <agent-dir>] <extension-name>...\n`);
}

function main(argv) {
	let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	let agentDir = process.env.PI_AGENT_DIR ?? DEFAULT_AGENT_DIR;
	const requested = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--repo" || arg === "--agent") {
			const value = argv[++i];
			if (value === undefined) {
				usage(process.stderr);
				return 1;
			}
			if (arg === "--repo") repoRoot = path.resolve(value);
			else agentDir = path.resolve(value);
		} else if (arg.startsWith("--repo=")) {
			repoRoot = path.resolve(arg.slice("--repo=".length));
		} else if (arg.startsWith("--agent=")) {
			agentDir = path.resolve(arg.slice("--agent=".length));
		} else if (arg === "--help" || arg === "-h") {
			usage(process.stdout);
			return 0;
		} else {
			requested.push(arg);
		}
	}
	if (requested.length === 0) {
		usage(process.stderr);
		return 1;
	}
	const res = buildPlan({ repoRoot, agentDir, requested });
	if (!res.ok) {
		for (const e of res.errors) process.stderr.write(`error: ${e}\n`);
		return 1;
	}
	const out = { repoRoot, agentDir, extensions: res.plan };
	process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
	return 0;
}

const invokedAsCli =
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
	process.exitCode = main(process.argv.slice(2));
}