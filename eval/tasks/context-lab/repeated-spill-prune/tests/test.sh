#!/usr/bin/env bash
set -euo pipefail

markers_ok=1
for index in {01..17}; do
  marker="/app/.context-lab/CTX_CANARY_PRESSURE_${index}.json"
  if [[ ! -f "${marker}" ]] \
    || ! rg --fixed-strings '"bytes":250000' "${marker}" >/dev/null; then
    markers_ok=0
  fi
done

reward=0
if [[ "${markers_ok}" == "1" ]] \
  && [[ -f /app/prune-pressure-result.txt ]] \
  && rg --fixed-strings --line-regexp 'pressure=complete' /app/prune-pressure-result.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'CTX_CANARY_PRESSURE_COMPLETE' /app/prune-pressure-result.txt >/dev/null; then
  reward=1
fi
printf '%s\n' "${reward}" > /logs/verifier/reward.txt
