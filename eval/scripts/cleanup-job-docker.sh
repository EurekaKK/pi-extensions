#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
eval_root="$(cd "${script_dir}/.." && pwd)"
cd "${eval_root}"
export PYTHONPATH="${eval_root}${PYTHONPATH:+:${PYTHONPATH}}"
exec uv run python -m pi_eval_harness.job_docker "$@"
