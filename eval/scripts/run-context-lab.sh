#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly eval_dir="$(cd -- "${script_dir}/.." && pwd)"

cd "${eval_dir}"
export PI_EVAL_SKIP_IMAGE_PREFETCH=1
exec "${script_dir}/run-harbor-job.sh" --config configs/harbor/context-lab.yaml "$@"
