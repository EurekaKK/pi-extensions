#!/usr/bin/env bash
# sub-agent E2E / Phase H：非交互（print）模式必须快速失败且无副作用。
# 显式触发：bash test/e2e/headless-mode.sh
# 需要本机 pi 已启用 sub-agent package；会产生一次真实模型调用。
# 注意：本脚本只断言 print 调用“不新增”副作用，允许同机其他交互式会话
# 已经存在的 guardian/worker 进程。
set -euo pipefail

cd "$(dirname "$0")/.."

before_files="$(mktemp -t subagent-e2e-files-before)"
after_files="$(mktemp -t subagent-e2e-files-after)"
before_procs="$(mktemp -t subagent-e2e-procs-before)"
after_procs="$(mktemp -t subagent-e2e-procs-after)"
trap 'rm -f "$before_files" "$after_files" "$before_procs" "$after_procs"' EXIT

guardian_pids() {
	pgrep -f "sub-agent/dist/sidecar/guardian.js" 2>/dev/null | sort || true
}

ls "$HOME/.pi/agent/sub-agent" 2>/dev/null | sort >"$before_files" || true
guardian_pids >"$before_procs"

output="$(pi --print \
	'Call the subagent_list tool exactly once with no arguments, then quote the tool result text verbatim and stop.' \
	2>&1 || true)"

echo "---- pi --print output ----"
echo "$output"
echo "---------------------------"

if ! grep -q "interactive parent session" <<<"$output"; then
	echo "FAIL: expected SUBAGENT_UNSUPPORTED_MODE message in print mode" >&2
	exit 1
fi

ls "$HOME/.pi/agent/sub-agent" 2>/dev/null | sort >"$after_files" || true
if ! diff -q "$before_files" "$after_files" >/dev/null; then
	echo "FAIL: print-mode call mutated <agent-dir>/sub-agent" >&2
	exit 1
fi

guardian_pids >"$after_procs"
if ! diff -q "$before_procs" "$after_procs" >/dev/null; then
	echo "FAIL: print-mode call spawned a new guardian process" >&2
	exit 1
fi

echo "PASS: print mode fails fast with SUBAGENT_UNSUPPORTED_MODE and no new side effects"
