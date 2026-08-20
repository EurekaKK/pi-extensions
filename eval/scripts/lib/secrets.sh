#!/usr/bin/env bash

# Secret helpers. Never print key contents.

secret_mode() {
  local path="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%Lp' "${path}"
  else
    stat -c '%a' "${path}"
  fi
}

require_secret_file() {
  local secret_file="$1"
  local label="$2"
  local file_mode
  local file_bytes

  if [[ -L "$(dirname "${secret_file}")" || -L "${secret_file}" ]]; then
    echo "Refusing to read a symlinked ${label} path" >&2
    return 3
  fi
  if [[ ! -f "${secret_file}" || ! -O "${secret_file}" ]]; then
    echo "${label} is not configured at ${secret_file}" >&2
    return 3
  fi

  file_mode="$(secret_mode "${secret_file}")"
  if [[ "${file_mode}" != "600" ]]; then
    echo "${label} must have mode 600; found ${file_mode}" >&2
    return 3
  fi

  file_bytes="$(wc -c <"${secret_file}" | tr -d '[:space:]')"
  if [[ -z "${file_bytes}" || "${file_bytes}" -lt 21 || "${file_bytes}" -gt 513 ]]; then
    echo "${label} is empty or has an unexpected length" >&2
    return 3
  fi
}

write_secret_file() {
  local secret_dir="$1"
  local secret_file="$2"
  local label="$3"
  local replace="$4"
  local prompt="$5"
  local key
  local temp_file

  if [[ -L "${secret_dir}" || -L "${secret_file}" ]]; then
    echo "Refusing to write through a symlinked ${label} path" >&2
    return 1
  fi
  if [[ -e "${secret_file}" && "${replace}" != true ]]; then
    echo "${label} already exists. Use --replace to rotate it." >&2
    return 4
  fi

  read -r -s -p "${prompt}" key
  printf '\n'
  if [[ -z "${key}" || ${#key} -lt 20 || ${#key} -gt 512 ]]; then
    echo "Key is empty or has an unexpected length" >&2
    return 3
  fi
  if [[ "${key}" == *$'\n'* || "${key}" == *$'\r'* ]]; then
    echo "Key must contain exactly one line" >&2
    return 3
  fi

  umask 077
  mkdir -p "${secret_dir}"
  chmod 700 "${secret_dir}"
  temp_file="$(mktemp "${secret_dir}/.${label}.XXXXXX")"
  if [[ -z "${temp_file}" || "${temp_file}" != "${secret_dir}/"* ]]; then
    echo "Failed to create a safe temporary secret file" >&2
    unset key
    return 1
  fi
  trap '[[ -n "${temp_file:-}" && -f "${temp_file}" ]] && rm -f -- "${temp_file}"' EXIT
  printf '%s\n' "${key}" >"${temp_file}"
  chmod 600 "${temp_file}"
  mv -f -- "${temp_file}" "${secret_file}"
  temp_file=""
  unset key
  trap - EXIT
}

export_model_key_file() {
  local eval_root="$1"
  local secret_file="${eval_root}/.secrets/model_api_key"
  require_secret_file "${secret_file}" "Model API key" || return $?
  export PI_EVAL_MODEL_KEY_FILE="${secret_file}"
  unset DEEPSEEK_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY OPENCODE_API_KEY
}

export_tavily_key_file() {
  local eval_root="$1"
  local secret_file="${eval_root}/.secrets/tavily_api_key"
  require_secret_file "${secret_file}" "Tavily API key" || return $?
  export PI_EVAL_TAVILY_KEY_FILE="${secret_file}"
  unset TAVILY_API_KEY
}
