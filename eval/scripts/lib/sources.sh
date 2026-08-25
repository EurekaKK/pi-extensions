#!/usr/bin/env bash

# Shared by project runners. Never prints secret file contents.

eval_root_from_lib() {
  local lib_dir="$1"
  (cd "${lib_dir}/../.." && pwd)
}

repo_root_from_eval() {
  local eval_root="$1"
  (cd "${eval_root}/.." && pwd)
}

require_eval_root() {
  local eval_root="$1"
  if [[ -z "${eval_root}" || ! -f "${eval_root}/pyproject.toml" ]]; then
    echo "Could not resolve the eval package root" >&2
    return 1
  fi
  if ! grep -q '^name = "pi-eval-harness"$' "${eval_root}/pyproject.toml"; then
    echo "eval/pyproject.toml is not the pi-eval-harness package" >&2
    return 1
  fi
}

require_regular_path() {
  local path="$1"
  local label="$2"
  if [[ -L "${path}" ]]; then
    echo "Refusing to use a symlinked ${label}: ${path}" >&2
    return 3
  fi
}

export_runtime_dir() {
  local eval_root="$1"
  local runtime_dir="${eval_root}/pi_eval_harness/runtime"
  local driver="${runtime_dir}/run-pi-tui.sh"

  require_regular_path "${runtime_dir}" "runtime directory" || return $?
  require_regular_path "${driver}" "TUI driver" || return $?
  if [[ ! -f "${driver}" ]]; then
    echo "TUI driver is missing: ${driver}" >&2
    return 3
  fi
  if [[ ! -x "${driver}" ]]; then
    echo "TUI driver is not executable: ${driver}" >&2
    return 3
  fi
  export PI_EVAL_RUNTIME_DIR="${runtime_dir}"
}

export_extension_repo_sources() {
  local repo_root="$1"
  local extensions_dir="${repo_root}/extensions"
  local packages_dir="${repo_root}/packages"
  local repo_scripts_dir="${repo_root}/scripts"

  require_regular_path "${extensions_dir}" "extensions tree" || return $?
  require_regular_path "${packages_dir}" "packages tree" || return $?
  require_regular_path "${repo_scripts_dir}" "repository scripts tree" || return $?
  if [[ ! -d "${extensions_dir}" ]]; then
    echo "extensions/ tree is missing: ${extensions_dir}" >&2
    return 3
  fi
  if [[ ! -d "${packages_dir}" ]]; then
    echo "packages/ tree is missing: ${packages_dir}" >&2
    return 3
  fi
  if [[ ! -f "${repo_scripts_dir}/install-extension.sh" \
    || ! -f "${repo_scripts_dir}/install-plan.mjs" ]]; then
    echo "Repository extension installer is incomplete: ${repo_scripts_dir}" >&2
    return 3
  fi
  export PI_EVAL_EXTENSIONS_DIR="${extensions_dir}"
  export PI_EVAL_PACKAGES_DIR="${packages_dir}"
  export PI_EVAL_REPO_SCRIPTS_DIR="${repo_scripts_dir}"
}

job_extension_names() {
  local config_path="$1"
  uv run python -c '
import sys
import yaml
from pathlib import Path

payload = yaml.safe_load(Path(sys.argv[1]).read_text())
agents = payload.get("agents") or []
if not isinstance(agents, list) or not agents:
    raise SystemExit("jobs must declare at least one agent")
seen = set()
for index, agent in enumerate(agents):
    if not isinstance(agent, dict):
        raise SystemExit(f"agents[{index}] must be an object")
    kwargs = agent.get("kwargs") or {}
    if not isinstance(kwargs, dict):
        raise SystemExit(f"agents[{index}].kwargs must be an object")
    names = kwargs.get("extensions") or []
    if not isinstance(names, list):
        raise SystemExit(f"agents[{index}].kwargs.extensions must be a list")
    for name in names:
        if not isinstance(name, str) or not name.strip():
            raise SystemExit("extension names must be non-empty strings")
        if name not in seen:
            seen.add(name)
            print(name)
' "${config_path}"
}

require_named_extensions() {
  local extensions_dir="$1"
  shift
  local name path
  for name in "$@"; do
    if [[ ! "${name}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
      echo "Invalid extension name: ${name}" >&2
      return 3
    fi
    path="${extensions_dir}/${name}"
    require_regular_path "${path}" "extension ${name}" || return $?
    if [[ ! -f "${path}/package.json" || ! -f "${path}/index.ts" ]]; then
      echo "Unknown or incomplete extension: ${name}" >&2
      echo "Expected ${path}/package.json and ${path}/index.ts" >&2
      return 3
    fi
  done
}

job_lists_tavily() {
  local name
  for name in "$@"; do
    if [[ "${name}" == "tavily-web-search" ]]; then
      return 0
    fi
  done
  return 1
}

require_install_job_mounts() {
  local config_path="$1"
  uv run python -c '
import sys
import yaml
from pathlib import Path

payload = yaml.safe_load(Path(sys.argv[1]).read_text())
mounts = ((payload.get("environment") or {}).get("mounts")) or []
targets = [
    mount.get("target")
    for mount in mounts
    if isinstance(mount, dict)
]
required = [
    "/opt/pi-extension-repo/extensions",
    "/opt/pi-extension-repo/packages",
    "/opt/pi-extension-repo/scripts",
]
missing = [target for target in required if target not in targets]
if missing:
    raise SystemExit(
        "install-only jobs with extensions are missing mounts: "
        + ", ".join(missing)
    )
if "/run/secrets/pi-eval-model-api-key" in targets:
    raise SystemExit("install-only jobs must not mount the model API key")
if "/run/secrets/pi-eval-tavily-api-key" in targets:
    raise SystemExit("install-only jobs must not mount the Tavily API key")
' "${config_path}"
}

require_runtime_job_mounts() {
  local config_path="$1"
  local need_extensions="$2"
  local need_tavily="$3"
  uv run python -c '
import sys
import yaml
from pathlib import Path

payload = yaml.safe_load(Path(sys.argv[1]).read_text())
need_extensions = sys.argv[2] == "1"
need_tavily = sys.argv[3] == "1"
mounts = ((payload.get("environment") or {}).get("mounts")) or []
targets = [
    mount.get("target")
    for mount in mounts
    if isinstance(mount, dict)
]
required = [
    "/run/secrets/pi-eval-model-api-key",
    "/opt/pi-eval/runtime",
]
if need_extensions:
    required.extend(
        [
            "/opt/pi-extension-repo/extensions",
            "/opt/pi-extension-repo/packages",
            "/opt/pi-extension-repo/scripts",
        ]
    )
if need_tavily:
    required.append("/run/secrets/pi-eval-tavily-api-key")
missing = [target for target in required if target not in targets]
if missing:
    raise SystemExit("Job is missing required mounts: " + ", ".join(missing))
if not need_tavily and "/run/secrets/pi-eval-tavily-api-key" in targets:
    raise SystemExit(
        "Tavily key is mounted but tavily-web-search is not in kwargs.extensions"
    )
' "${config_path}" "${need_extensions}" "${need_tavily}"
}
