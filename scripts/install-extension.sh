#!/usr/bin/env bash
# 以 npm 风格安装本仓库的 Pi extension：
#   1. 把 extensions/<name>/ 复制到 ~/.pi/agent/my-extensions/<name>/（精确镜像，排除 node_modules 等本机文件）
#   2. 对副本执行 pi install
#
# Pi 对本地路径包只登记不复制，因此必须先复制再登记，运行中的 Pi 才与开发工作树解耦。
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
	pi install "$dest"
	echo "installed: $name -> $dest"
done
