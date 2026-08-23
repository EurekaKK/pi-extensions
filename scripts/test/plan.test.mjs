// install-plan.mjs 的单元测试：纯解析核心 + registry/CLI 适配层。
// 全部使用内存 registry 或临时 fixture，不访问真实 ~/.pi。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
	PI_EXTENSION_DEPS_FIELD,
	readManifest,
	readRegistry,
	resolvePlan,
	resolvePackageClosure,
	topoSort,
	findCycles,
} from "../install-plan.mjs";
import { makeTempDir, makeFixtureRepo, PLAN_MODULE } from "./helpers.mjs";

const manifest = (fields = {}) => ({ name: "x", ...fields });

function registry(extensions = {}, packages = {}) {
	return {
		extensions: new Map(Object.entries(extensions)),
		packages: new Map(Object.entries(packages)),
	};
}

test("依赖链按依赖优先顺序输出，root 标记正确", () => {
	const res = resolvePlan({
		...registry(
			{ a: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["b"] }), b: manifest({}) },
			{},
		),
		requested: ["a"],
	});
	assert.equal(res.ok, true);
	assert.deepEqual(
		res.plan.map((e) => e.name),
		["b", "a"],
	);
	assert.equal(res.plan[0].root, false);
	assert.equal(res.plan[1].root, true);
	assert.deepEqual(res.plan[1].extensionDeps, ["b"]);
});

test("菱形依赖去重：每个 extension 只出现一次", () => {
	const res = resolvePlan({
		...registry(
			{
				a: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["b", "c"] }),
				b: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["d"] }),
				c: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["d"] }),
				d: manifest({}),
			},
			{},
		),
		requested: ["a"],
	});
	assert.equal(res.ok, true);
	assert.deepEqual(
		res.plan.map((e) => e.name),
		["d", "b", "c", "a"],
	);
	assert.equal(new Set(res.plan.map((e) => e.name)).size, res.plan.length);
});

test("多根去重：两个根共享同一依赖时只安装一次", () => {
	const res = resolvePlan({
		...registry(
			{
				a: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["b"] }),
				b: manifest({}),
				c: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["b"] }),
			},
			{},
		),
		requested: ["a", "c"],
	});
	assert.equal(res.ok, true);
	assert.deepEqual(
		res.plan.map((e) => e.name),
		["b", "a", "c"],
	);
	assert.deepEqual(res.plan.filter((e) => e.root).map((e) => e.name).sort(), ["a", "c"]);
});

test("重复请求同一根只输出一次", () => {
	const res = resolvePlan({
		...registry({ a: manifest({}), b: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["a"] }) }, {}),
		requested: ["b", "b", "b"],
	});
	assert.equal(res.ok, true);
	assert.deepEqual(
		res.plan.map((e) => e.name),
		["a", "b"],
	);
});

test("unknown：请求不存在的根", () => {
	const res = resolvePlan({
		...registry({ a: manifest({}) }, {}),
		requested: ["nope"],
	});
	assert.equal(res.ok, false);
	assert.ok(res.errors.some((e) => e.includes("unknown extension: nope")));
});

test("unknown：依赖声明引用不存在的 extension", () => {
	const res = resolvePlan({
		...registry({ a: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["ghost"] }) }, {}),
		requested: ["a"],
	});
	assert.equal(res.ok, false);
	assert.ok(res.errors.some((e) => e.includes("unknown extension dependency: a -> ghost")));
});

test("self：依赖自己", () => {
	const res = resolvePlan({
		...registry({ a: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["a"] }) }, {}),
		requested: ["a"],
	});
	assert.equal(res.ok, false);
	assert.ok(res.errors.some((e) => e.includes("self dependency: a -> a")));
});

test("cycle：extension 依赖环", () => {
	const res = resolvePlan({
		...registry(
			{
				a: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["b"] }),
				b: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["a"] }),
			},
			{},
		),
		requested: ["a"],
	});
	assert.equal(res.ok, false);
	assert.ok(res.errors.some((e) => e.includes("extension dependency cycle: a -> b -> a")));
});

test("cycle：间接环（b -> c -> b）", () => {
	const res = resolvePlan({
		...registry(
			{
				a: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["b"] }),
				b: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["c"] }),
				c: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["b"] }),
			},
			{},
		),
		requested: ["a"],
	});
	assert.equal(res.ok, false);
	assert.ok(res.errors.some((e) => e.includes("extension dependency cycle: b -> c -> b")));
});

test("字段类型错误：piExtensionDependencies 不是字符串数组", () => {
	const bad = [
		manifest({ [PI_EXTENSION_DEPS_FIELD]: "goal" }),
		manifest({ [PI_EXTENSION_DEPS_FIELD]: ["goal", 7] }),
	];
	for (const m of bad) {
		const res = resolvePlan({ ...registry({ a: m }, {}), requested: ["a"] });
		assert.equal(res.ok, false);
		assert.ok(
			res.errors.some((e) => e.includes(`invalid ${PI_EXTENSION_DEPS_FIELD} in a`)),
			`expected invalid-field error, got ${JSON.stringify(res.errors)}`,
		);
	}
});

test("内部 package 闭包：传递依赖按依赖优先平铺", () => {
	const res = resolvePlan({
		...registry(
			{ a: manifest({ dependencies: { p: "*" } }) },
			{ p: manifest({ dependencies: { q: "*" } }), q: manifest({}) },
		),
		requested: ["a"],
	});
	assert.equal(res.ok, true);
	assert.deepEqual(res.plan[0].packages, ["q", "p"]);
});

test("内部 package 闭包：菱形去重", () => {
	const ext = registry(
		{ a: manifest({ dependencies: { p: "*", r: "*" } }) },
		{
			p: manifest({ dependencies: { q: "*" } }),
			r: manifest({ dependencies: { q: "*" } }),
			q: manifest({}),
		},
	);
	const closure = resolvePackageClosure(ext.packages, ext.extensions.get("a"));
	assert.deepEqual(closure.order, ["q", "p", "r"]);
	assert.deepEqual(closure.errors, []);
});

test("内部 package 闭包：循环检测", () => {
	const res = resolvePlan({
		...registry(
			{ a: manifest({ dependencies: { p: "*" } }) },
			{
				p: manifest({ dependencies: { q: "*" } }),
				q: manifest({ dependencies: { p: "*" } }),
			},
		),
		requested: ["a"],
	});
	assert.equal(res.ok, false);
	assert.ok(res.errors.some((e) => e.includes("a: package dependency cycle: p -> q -> p")));
});

test("内部 package 闭包：目录存在但 package.json 缺失", () => {
	const res = resolvePlan({
		...registry({ a: manifest({ dependencies: { p: "*" } }) }, { p: null }),
		requested: ["a"],
	});
	assert.equal(res.ok, false);
	assert.ok(res.errors.some((e) => e.includes("a: missing package.json: packages/p")));
});

test("外部 dependencies 不被误当 extension 或 internal package", () => {
	const res = resolvePlan({
		...registry(
			{ a: manifest({ dependencies: { lodash: "^4.17.0", "@earendil-works/pi-ai": "*" } }) },
			{},
		),
		requested: ["a"],
	});
	assert.equal(res.ok, true);
	assert.deepEqual(res.plan.map((e) => e.name), ["a"]);
	assert.deepEqual(res.plan[0].packages, []);
});

test("dependencies 不得冒充 extension 安装依赖", () => {
	const res = resolvePlan({
		...registry({ a: manifest({ dependencies: { b: "*" } }), b: manifest({}) }, {}),
		requested: ["a"],
	});
	assert.equal(res.ok, false);
	assert.ok(res.errors.some((error) => error.includes("must be declared in piExtensionDependencies")));
});

test("同一 extension 依赖重复声明时归一化", () => {
	const res = resolvePlan({
		...registry(
			{ a: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["b", "b"] }), b: manifest({}) },
			{},
		),
		requested: ["a"],
	});
	assert.equal(res.ok, true);
	assert.deepEqual(res.plan.find((entry) => entry.name === "a").extensionDeps, ["b"]);
});

test("依赖声明顺序与请求顺序不影响稳定排序", () => {
	const exts = { z: manifest({}), a: manifest({}), m: manifest({}) };
	const one = resolvePlan({ ...registry(exts, {}), requested: ["z", "a"] });
	const two = resolvePlan({ ...registry(exts, {}), requested: ["a", "z"] });
	assert.equal(one.ok, true);
	// 只安装请求根及其传递依赖；同层按名称字母序
	assert.deepEqual(one.plan.map((e) => e.name), ["a", "z"]);
	assert.deepEqual(two.plan.map((e) => e.name), ["a", "z"]);
});

test("非法名字（路径穿越）被拒绝", () => {
	const badRoot = resolvePlan({ ...registry({ a: manifest({}) }, {}), requested: ["../evil"] });
	assert.equal(badRoot.ok, false);
	assert.ok(badRoot.errors.some((e) => e.includes("unknown extension: ../evil")));

	const badDep = resolvePlan({
		...registry({ a: manifest({ [PI_EXTENSION_DEPS_FIELD]: ["../secret"] }) }, {}),
		requested: ["a"],
	});
	assert.equal(badDep.ok, false);
	assert.ok(badDep.errors.some((e) => e.includes("a -> ../secret")));
});

test("topoSort 与 findCycles 的确定性", () => {
	const names = new Set(["a", "b", "c"]);
	const deps = new Map([
		["a", ["b"]],
		["b", []],
		["c", []],
	]);
	for (let i = 0; i < 5; i++) {
		assert.deepEqual(topoSort(names, deps), ["b", "a", "c"]);
	}
	assert.deepEqual(findCycles(new Set(["a", "b"]), new Map([["a", ["b"]], ["b", ["a"]]])), [
		["a", "b", "a"],
	]);
});

test("readRegistry：扫描 extensions/ 与 packages/，区分缺失 manifest", (t) => {
	const root = makeFixtureRepo(
		t,
		{
			extensions: { ok: { [PI_EXTENSION_DEPS_FIELD]: [] }, broken: {} },
			packages: { lib: {}, broken: {} },
		},
	);
	const broken = path.join(root, "extensions", "broken");
	fs.rmSync(path.join(broken, "package.json"));
	fs.writeFileSync(path.join(root, "packages", "broken", "package.json"), "not json {{{");
	fs.mkdirSync(path.join(root, "extensions", "plain-dir"));
	fs.writeFileSync(path.join(root, "extensions", "plain-dir", "readme.txt"), "x");

	const { extensions, packages } = readRegistry(root);
	assert.ok(extensions.has("ok"));
	assert.ok(packages.has("lib"));
	assert.equal(packages.get("lib").name, "lib");
	assert.equal(extensions.get("broken"), null);
	assert.equal(packages.get("broken"), null);
	// 目录存在但没有 package.json：registry 记录为 null（缺失），而非不存在
	assert.equal(extensions.has("plain-dir"), true);
	assert.equal(extensions.get("plain-dir"), null);
	// 不存在的根 → unknown
	const res = resolvePlan({ extensions, packages, requested: ["missing"] });
	assert.equal(res.ok, false);
	assert.ok(res.errors[0].includes("unknown extension: missing"));
});

test("CLI：成功输出计划 JSON，失败输出 error 并 exit 1", (t) => {
	const repo = makeFixtureRepo(t, {
		extensions: {
			a: { [PI_EXTENSION_DEPS_FIELD]: ["b"], dependencies: { p: "*" } },
			b: {},
		},
		packages: { p: { dependencies: { q: "*" } }, q: {} },
	});
	const agent = path.join(makeTempDir(t), "agent");

	const ok = spawnSync("node", [PLAN_MODULE, "--repo", repo, "--agent", agent, "a"], {
		encoding: "utf8",
	});
	assert.equal(ok.status, 0, ok.stderr);
	const plan = JSON.parse(ok.stdout);
	// extension 计划条目与内部 package 闭包是两回事
	assert.deepEqual(
		plan.extensions.map((e) => e.name),
		["b", "a"],
	);
	const a = plan.extensions.find((e) => e.name === "a");
	assert.equal(a.src, path.join(repo, "extensions", "a"));
	assert.equal(a.dest, path.join(agent, "my-extensions", "a"));
	assert.deepEqual(a.packages, ["q", "p"]);
	assert.deepEqual(plan.extensions.find((e) => e.name === "b").packages, []);

	const bad = spawnSync("node", [PLAN_MODULE, "--repo", repo, "--agent", agent, "ghost"], {
		encoding: "utf8",
	});
	assert.equal(bad.status, 1);
	assert.ok(bad.stderr.includes("error: unknown extension: ghost"));
	assert.equal(bad.stdout, "");

	const noArgs = spawnSync("node", [PLAN_MODULE, "--repo", repo], { encoding: "utf8" });
	assert.equal(noArgs.status, 1);
	assert.ok(noArgs.stderr.includes("usage:"));
});

// readManifest 的边界输入测试（临时文件由本测试自管注册清理）。
test("readManifest 对损坏 JSON 返回 null", (t) => {
	const dir = makeTempDir(t);
	const file = path.join(dir, "package.json");
	fs.writeFileSync(file, "{oops");
	assert.equal(readManifest(file), null);
	fs.writeFileSync(file, JSON.stringify([1, 2]));
	assert.equal(readManifest(file), null);
	fs.writeFileSync(file, JSON.stringify({ name: "x" }));
	assert.deepEqual(readManifest(file), { name: "x" });
	assert.equal(readManifest(path.join(dir, "absent.json")), null);
});