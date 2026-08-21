#!/usr/bin/env bash
# 以 npm 风格安装本仓库的 Pi extension：
#   1. 把 extensions/<name>/ 复制到 ~/.pi/agent/my-extensions/<name>/（精确镜像，排除 node_modules 等本机文件）
#   2. 把该 package 声明的本仓库内部依赖（packages/<dep>/）vendor 进副本的 node_modules/<dep>/
#      —— Pi 对本地路径包只登记不复制、不运行 npm install，跨包依赖必须随副本携带才能解析
#   3. 对副本执行 pi install
#
# 重复执行即为更新；更新后重启 Pi 或在会话内 /reload 生效。
#
# 用法: scripts/install-extension.sh <extension-name>...
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
DEST_PARENT="$AGENT_DIR/my-extensions"

usage() {
	echo "usage: $0 <extension-name>..." >&2
	exit 1
}

[ $# -ge 1 ] || usage
command -v pi >/dev/null 2>&1 || { echo "error: pi not found in PATH" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo "error: rsync not found in PATH" >&2; exit 1; }

# 列出 package.json 中指向本仓库 packages/ 的 dependencies 名称
list_workspace_deps() {
	node -e '
		const fs = require("node:fs");
		const path = require("node:path");
		const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		for (const name of Object.keys(pkg.dependencies ?? {})) {
			if (fs.existsSync(path.join(process.argv[2], name, "package.json"))) process.stdout.write(`${name}\n`);
		}
	' "$1" "$REPO_ROOT/packages"
}

for name in "$@"; do
	src="$REPO_ROOT/extensions/$name"
	dest="$DEST_PARENT/$name"
	if [ ! -f "$src/package.json" ]; then
		echo "error: $src is not an extension package" >&2
		exit 1
	fi
	mkdir -p "$dest"
	rsync -a --delete \
		--exclude 'node_modules/' \
		--exclude '.DS_Store' \
		"$src/" "$dest/"
	while IFS= read -r dep; do
		[ -n "$dep" ] || continue
		mkdir -p "$dest/node_modules/$dep"
		rsync -a --delete \
			--exclude 'node_modules/' \
			--exclude '.DS_Store' \
			"$REPO_ROOT/packages/$dep/" "$dest/node_modules/$dep/"
		echo "vendored: $dep -> $dest/node_modules/$dep"
	done < <(list_workspace_deps "$src/package.json")
	pi install "$dest"
	echo "installed: $name -> $dest"
done
