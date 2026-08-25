#!/usr/bin/env bash
set -euo pipefail

reward=0
if [[ -f /app/large-output-result.txt ]] \
  && [[ -f /app/.context-lab/CTX_CANARY_LARGE_PAYLOAD.json ]] \
  && rg --fixed-strings '"bytes":250000' /app/.context-lab/CTX_CANARY_LARGE_PAYLOAD.json >/dev/null \
  && rg --fixed-strings --line-regexp 'burst=complete' /app/large-output-result.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'CTX_CANARY_LARGE_PAYLOAD' /app/large-output-result.txt >/dev/null; then
  reward=1
fi
printf '%s\n' "${reward}" > /logs/verifier/reward.txt
