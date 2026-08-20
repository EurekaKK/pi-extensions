#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${script_dir}/run-harbor-job.sh" \
  --config configs/harbor/runtime-smoke-tavily.yaml \
  "$@"
