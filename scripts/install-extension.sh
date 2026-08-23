#!/usr/bin/env bash
# 以 npm 风格安装本仓库的 Pi extension（规划 + 执行两步，规划阶段不写入任何目标文件）：
#
#   1. 调用 scripts/install-plan.mjs 递归解析全部请求根的安装 closure：
#      - package.json 自定义字段 `piExtensionDependencies: string[]` 声明对其他 extension 的
#        安装期依赖；检测 unknown / 自依赖 / 环，按「依赖优先」的稳定拓扑排序，多根与菱形去重
#      - `dependencies` 中命中 packages/* 的内部 package 代码依赖递归解析闭包（检测缺失/循环），
#        每个 extension 的完整闭包平铺 vendor 进副本的 node_modules；命中 extension 名字的
#        误写会被拒绝，其余 dependencies 视为外部依赖
#      计划失败时不写入任何文件，直接报错退出。
#   2. 按计划执行：对每个 extension（含依赖的 extension）：
#      - 把 extensions/<name>/ 复制到 ~/.pi/agent/my-extensions/<name>/（精确镜像，
#        排除 node_modules 等本机文件；--delete 保证已安装副本同步更新，-c 按内容比较，
#        避免同秒同大小的重写被 rsync 快速检查跳过）
#      - 清空并重建副本的 node_modules，vendor 该 extension 的完整 package 闭包
#      - 对副本执行 pi install（Pi 对本地路径只登记不复制、不运行 npm install）
#
# 重复执行即为更新；更新后重启 Pi 或在会话内 /reload 生效。卸载不在本脚本范围
# （pi remove + 删除副本，见各 extension README）。不提供 --no-deps 之类的跳过选项。
#
# 环境变量：
#   PI_AGENT_DIR            覆盖 agent 目录（默认 $HOME/.pi/agent）
#   PI_EXTENSIONS_REPO_ROOT 覆盖仓库根目录（测试/CI 指向 fixture 用；默认取脚本所在仓库）
#
# 用法: scripts/install-extension.sh <extension-name>...
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
REPO_ROOT="${PI_EXTENSIONS_REPO_ROOT:-$SCRIPT_DIR/..}"
if ! REPO_ROOT="$(cd "$REPO_ROOT" 2>/dev/null && pwd)"; then
	echo "error: repo root not found: $REPO_ROOT" >&2
	exit 1
fi
usage() {
	echo "usage: $0 <extension-name>..." >&2
	exit 1
}

[ $# -ge 1 ] || usage
command -v pi >/dev/null 2>&1 || { echo "error: pi not found in PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node not found in PATH" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo "error: rsync not found in PATH" >&2; exit 1; }

# 从计划 JSON 取字段：plan_get __names 输出全部 extension 名（计划顺序）；plan_get <field> <name>
# 输出单个 extension 的字段值，数组字段（packages）逐行输出。
plan_get() {
	node -e '
		const fs = require("node:fs");
		const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		const field = process.argv[2];
		if (field === "__names") {
			process.stdout.write(plan.extensions.map((e) => e.name).join("\n"));
			process.exit(0);
		}
		const ext = plan.extensions.find((e) => e.name === process.argv[3]);
		if (!ext) process.exit(2);
		const value = ext[field];
		if (Array.isArray(value)) process.stdout.write(value.join("\n"));
		else process.stdout.write(String(value));
	' "$PLAN_FILE" "$1" "${2:-}"
}

# ---- 阶段 1：解析与校验（此时不写入任何目标文件）----
PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/install-extension-plan.XXXXXX")"
trap 'rm -f "$PLAN_FILE"' EXIT

if ! node "$SCRIPT_DIR/install-plan.mjs" --repo "$REPO_ROOT" --agent "$AGENT_DIR" "$@" > "$PLAN_FILE"; then
	# 具体错误已由规划器逐行输出到 stderr
	echo "error: install plan failed; nothing was written" >&2
	exit 1
fi
[ -s "$PLAN_FILE" ] || { echo "error: install plan is empty" >&2; exit 1; }

names="$(plan_get __names)"
[ -n "$names" ] || { echo "error: install plan contains no extensions" >&2; exit 1; }

echo "plan: $(printf '%s' "$names" | tr '\n' ' ' | sed 's/ $//')"

# ---- 阶段 2：按计划执行 ----
while IFS= read -r name; do
	[ -n "$name" ] || continue
	src="$(plan_get src "$name")"
	dest="$(plan_get dest "$name")"
	expected_src="$REPO_ROOT/extensions/$name"
	if [ "$src" != "$expected_src" ]; then
		echo "error: unexpected source path for $name: $src" >&2
		exit 1
	fi

	mkdir -p "$dest"
	rsync -a -c --delete \
		--exclude 'node_modules/' \
		--exclude '.DS_Store' \
		"$src/" "$dest/"
	# 副本的 node_modules 完全由计划派生：清空后按闭包重建，避免残留过期 vendor
	rm -rf "$dest/node_modules"

	pkgs="$(plan_get packages "$name")"
	if [ -n "$pkgs" ]; then
		mkdir -p "$dest/node_modules"
		while IFS= read -r pkg; do
			[ -n "$pkg" ] || continue
			pkg_src="$REPO_ROOT/packages/$pkg"
			[ -d "$pkg_src" ] || { echo "error: internal package $pkg missing for $name" >&2; exit 1; }
			mkdir -p "$dest/node_modules/$pkg"
			rsync -a -c --delete \
				--exclude 'node_modules/' \
				--exclude '.DS_Store' \
				"$pkg_src/" "$dest/node_modules/$pkg/"
			echo "vendored: $pkg -> $dest/node_modules/$pkg"
		done <<< "$pkgs"
	fi

	pi install "$dest"
	echo "installed: $name -> $dest"
done <<< "$names"
