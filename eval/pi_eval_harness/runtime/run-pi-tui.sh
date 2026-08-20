#!/usr/bin/env bash
set -euo pipefail

readonly runtime_dir="/opt/pi-eval/runtime"
readonly sessions_dir="/logs/agent/pi/sessions"
readonly transcript_log="/logs/agent/pi-tui.typescript"
readonly stream_log="/logs/agent/pi-tui-stream.log"
readonly goal_settlement_js="${runtime_dir}/goal-settlement.mjs"
readonly goal_round_grace_sec=15

: "${PI_EVAL_PROVIDER:?PI_EVAL_PROVIDER is required}"
: "${PI_EVAL_MODEL:?PI_EVAL_MODEL is required}"
: "${PI_EVAL_THINKING:?PI_EVAL_THINKING is required}"
: "${PI_EVAL_PI_VERSION:?PI_EVAL_PI_VERSION is required}"

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "${HOME}/.nvm/nvm.sh"
fi

launch_pi() {
  local -a args=(
    --provider "${PI_EVAL_PROVIDER}"
    --model "${PI_EVAL_MODEL}"
    --thinking "${PI_EVAL_THINKING}"
    --session-dir "${sessions_dir}"
    --offline
    --approve
    --no-extensions
    --no-skills
    --no-prompt-templates
    --no-themes
  )
  local extension_path
  if [[ -n "${PI_EVAL_EXTENSIONS:-}" ]]; then
    while IFS= read -r extension_path; do
      if [[ -n "${extension_path}" ]]; then
        args+=(--extension "${extension_path}")
      fi
    done <<< "${PI_EVAL_EXTENSIONS}"
  fi
  if [[ -n "${PI_EVAL_APPEND_SYSTEM_PROMPT:-}" ]]; then
    args+=(--append-system-prompt "${PI_EVAL_APPEND_SYSTEM_PROMPT}")
  fi
  exec pi "${args[@]}"
}

if [[ "${1:-}" == "--launch" ]]; then
  launch_pi
fi

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  echo "usage: run-pi-tui.sh INSTRUCTION_BASE64 [PROMPT_BASE64]" >&2
  exit 64
fi

instruction_text="$(printf '%s' "$1" | base64 --decode)"
readonly instruction_text
if [[ -n "${2:-}" ]]; then
  export PI_EVAL_APPEND_SYSTEM_PROMPT="$(printf '%s' "$2" | base64 --decode)"
fi

if [[ -z "${instruction_text}" ]]; then
  echo "The benchmark instruction must be non-empty" >&2
  exit 65
fi

mkdir -p "${sessions_dir}"
: >"${transcript_log}"
: >"${stream_log}"

export TERM="xterm-256color"

driver_tmp_dir="$(mktemp -d /tmp/pi-tui-driver.XXXXXX)"
readonly driver_tmp_dir
readonly input_fifo="${driver_tmp_dir}/input.fifo"
mkfifo "${input_fifo}"
# Keep the FIFO open across automated keystrokes so Pi never sees an input EOF.
exec 3<>"${input_fifo}"

session_has() {
  local pattern="$1"
  rg --text --quiet --glob '*.jsonl' "${pattern}" "${sessions_dir}" 2>/dev/null
}

wait_for_prompt() {
  local deadline=$((SECONDS + 90))
  until rg --text --quiet --fixed-strings "v${PI_EVAL_PI_VERSION}" "${transcript_log}" 2>/dev/null; do
    if ! kill -0 "${script_pid}" 2>/dev/null; then
      echo "Pi exited before the prompt appeared" >&2
      return 71
    fi
    if ((SECONDS >= deadline)); then
      echo "Timed out waiting for the Pi prompt" >&2
      return 70
    fi
    sleep 0.25
  done

  local extension_path extension_name
  if [[ -n "${PI_EVAL_EXTENSIONS:-}" ]]; then
    while IFS= read -r extension_path; do
      [[ -z "${extension_path}" ]] && continue
      extension_name="$(basename "$(dirname "${extension_path}")")"
      deadline=$((SECONDS + 30))
      until rg --text --quiet --fixed-strings "${extension_name}" "${transcript_log}" 2>/dev/null; do
        if ! kill -0 "${script_pid}" 2>/dev/null; then
          echo "Pi exited before extension ${extension_name} appeared" >&2
          return 71
        fi
        if ((SECONDS >= deadline)); then
          echo "Timed out waiting for extension ${extension_name}" >&2
          return 70
        fi
        sleep 0.25
      done
    done <<< "${PI_EVAL_EXTENSIONS}"
  fi
}

working_count() {
  local count
  count="$(rg --text --count --fixed-strings "Working..." "${transcript_log}" 2>/dev/null || true)"
  printf '%s' "${count:-0}"
}

error_event_count() {
  local count
  count="$(
    rg --text --glob '*.jsonl' --count-matches \
      '"role":"assistant".*"stopReason":"(error|aborted)"' \
      "${sessions_dir}" 2>/dev/null \
      | awk -F: '{ total += $NF } END { print total + 0 }'
  )"
  printf '%s' "${count:-0}"
}

paste_user_text() {
  printf '\033[200~%s\033[201~\r' "$1" >&3
}

wait_for_working_after() {
  local previous="$1"
  local deadline=$((SECONDS + 30))
  local current
  current="$(working_count)"
  until ((current > previous)); do
    if ! kill -0 "${script_pid}" 2>/dev/null; then
      echo "Pi exited before acknowledging the benchmark instruction" >&2
      return 72
    fi
    if ((SECONDS >= deadline)); then
      return 73
    fi
    sleep 0.1
    current="$(working_count)"
  done
}

wait_for_submission() {
  wait_for_working_after 0 || {
    local status=$?
    if ((status == 73)); then
      echo "Timed out waiting for Pi to acknowledge the benchmark instruction" >&2
    fi
    return "${status}"
  }
}

last_error_line() {
  rg --text --glob '*.jsonl' --no-filename \
    '"role":"assistant".*"stopReason":"(error|aborted)"' \
    "${sessions_dir}" 2>/dev/null | tail -n 1 || true
}

is_hard_api_error() {
  printf '%s' "$1" | rg --text --quiet --ignore-case \
    '\b401\b|\b402\b|authentication_error|insufficient (account )?balance|余额不足|please recharge'
}

continue_after_stream_error() {
  local previous_working
  previous_working="$(working_count)"
  echo "Pi stream interrupted; continuing the same session" >&2
  sleep 1
  paste_user_text "The previous model stream ended before it finished. Continue the original task from your last complete work. Do not restart unless that work is unusable."
  wait_for_working_after "${previous_working}"
}

goal_settlement() {
  node "${goal_settlement_js}" "${sessions_dir}"
}

drive_instruction() {
  local handled_errors=0
  local errors
  local error_line
  local continue_status
  local settlement
  local armed_since=""
  wait_for_prompt || return $?
  paste_user_text "${instruction_text}"
  wait_for_submission || return $?

  while true; do
    errors="$(error_event_count)"
    if ((errors > handled_errors)); then
      error_line="$(last_error_line)"
      if is_hard_api_error "${error_line}"; then
        echo "Pi ended the instruction with an error" >&2
        return 74
      fi
      continue_status=0
      continue_after_stream_error || continue_status=$?
      if ((continue_status == 72)); then
        return 72
      fi
      if ((continue_status == 0)); then
        handled_errors="${errors}"
      else
        echo "Continue was not acknowledged yet; waiting for Harbor timeout or another stream event" >&2
        sleep 2
      fi
      continue
    fi
    settlement="$(goal_settlement)"
    case "${settlement}" in
      running)
        armed_since=""
        ;;
      driven)
        armed_since=""
        ;;
      quit)
        return 0
        ;;
      armed)
        if [[ -z "${armed_since}" ]]; then
          armed_since="${SECONDS}"
        fi
        if ((SECONDS - armed_since >= goal_round_grace_sec)); then
          echo "Active goal did not start another round; settling" >&2
          return 0
        fi
        ;;
      *)
        echo "Unexpected goal settlement: ${settlement}" >&2
        return 76
        ;;
    esac
    if ! kill -0 "${script_pid}" 2>/dev/null; then
      echo "Pi exited before the instruction settled" >&2
      return 76
    fi
    sleep 0.5
  done
}

script --quiet --return --flush \
  --command "bash ${runtime_dir}/run-pi-tui.sh --launch" \
  "${transcript_log}" <&3 >"${stream_log}" 2>&1 &
readonly script_pid=$!

set +e
drive_instruction
readonly driver_status=$?
if ((driver_status == 0 || driver_status == 74)); then
  printf '/quit\r' >&3
else
  printf '\003\003' >&3
fi
wait "${script_pid}"
readonly script_status=$?
exec 3>&-
set -e

if ((driver_status != 0)); then
  tail -n 120 "${stream_log}" >&2 || true
  rg --text '"role":"assistant".*"stopReason":"(error|aborted)"' \
    "${sessions_dir}" >&2 || true
  exit "${driver_status}"
fi
if ((script_status != 0)); then
  echo "Pi TUI exited with status ${script_status}" >&2
  tail -n 120 "${stream_log}" >&2 || true
  exit "${script_status}"
fi

if ! session_has '"role":"assistant".*"stopReason":"stop"'; then
  echo "Pi exited without a settled instruction response" >&2
  tail -n 120 "${stream_log}" >&2 || true
  exit 75
fi

echo "Pi TUI exited after the instruction settled"
