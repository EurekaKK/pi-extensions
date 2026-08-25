#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  echo "Run this script as an executable; do not source it." >&2
  return 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/sources.sh
source "${script_dir}/lib/sources.sh"
# shellcheck source=scripts/lib/secrets.sh
source "${script_dir}/lib/secrets.sh"

usage() {
  echo "Usage: $0 --config <yaml> [--install-only] [--job-name <name>] [-- harbor-args...]" >&2
  echo "Launch a Harbor job for the Pi TUI adapter after checking sources and secrets." >&2
}

config_path=""
install_only=false
job_name=""
harbor_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      config_path="${2:-}"
      shift 2
      ;;
    --install-only)
      install_only=true
      shift
      ;;
    --job-name)
      job_name="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      harbor_args+=("$@")
      break
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "${config_path}" ]]; then
  usage
  exit 2
fi

eval_root="$(eval_root_from_lib "${script_dir}/lib")"
repo_root="$(repo_root_from_eval "${eval_root}")"
require_eval_root "${eval_root}"

if [[ "${config_path}" != /* ]]; then
  config_path="${eval_root}/${config_path}"
fi
if [[ ! -f "${config_path}" ]]; then
  echo "Job config not found: ${config_path}" >&2
  exit 2
fi

cd "${eval_root}"
export PYTHONPATH="${eval_root}${PYTHONPATH:+:${PYTHONPATH}}"
export_runtime_dir "${eval_root}"
export_extension_repo_sources "${repo_root}"

extension_names=()
while IFS= read -r name; do
  [[ -z "${name}" ]] && continue
  extension_names+=("${name}")
done < <(job_extension_names "${config_path}")

if ((${#extension_names[@]} > 0)); then
  require_named_extensions "${PI_EVAL_EXTENSIONS_DIR}" "${extension_names[@]}"
fi

if [[ "${install_only}" != true ]]; then
  export_model_key_file "${eval_root}"
  need_extensions=0
  need_tavily=0
  if ((${#extension_names[@]} > 0)); then
    need_extensions=1
  fi
  if job_lists_tavily "${extension_names[@]+"${extension_names[@]}"}"; then
    need_tavily=1
    export_tavily_key_file "${eval_root}"
  else
    unset PI_EVAL_TAVILY_KEY_FILE TAVILY_API_KEY
  fi
  require_runtime_job_mounts "${config_path}" "${need_extensions}" "${need_tavily}"
  if [[ "${PI_EVAL_SKIP_IMAGE_PREFETCH:-}" != "1" ]]; then
    "${script_dir}/prefetch-task-images.sh" --config "${config_path}"
  fi
else
  unset PI_EVAL_MODEL_KEY_FILE PI_EVAL_TAVILY_KEY_FILE
  unset DEEPSEEK_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY OPENCODE_API_KEY TAVILY_API_KEY
  if ((${#extension_names[@]} > 0)); then
    require_install_job_mounts "${config_path}"
  fi
fi

if [[ -z "${job_name}" ]]; then
  job_name="pi-tui-$(date +%Y%m%d-%H%M%S)"
fi

cleanup_job_docker() {
  if [[ "${PI_EVAL_SKIP_DOCKER_CLEANUP:-}" == "1" ]]; then
    return 0
  fi
  "${script_dir}/cleanup-job-docker.sh" \
    --config "${config_path}" \
    --job-name "${job_name}" \
    --eval-root "${eval_root}" \
    || echo "Harbor trial container cleanup failed" >&2
}

trap cleanup_job_docker EXIT

uv run harbor run \
  --config "${config_path}" \
  --job-name "${job_name}" \
  --yes \
  ${harbor_args[@]+"${harbor_args[@]}"}
