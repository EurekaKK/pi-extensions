#!/usr/bin/env bash
set -euo pipefail

reward=0
if [[ -f /app/context-result.txt ]] \
  && rg --fixed-strings --line-regexp 'phase=final' /app/context-result.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'CTX_CANARY_BASIC_ALPHA' /app/context-result.txt >/dev/null; then
  reward=1
fi
printf '%s\n' "${reward}" > /logs/verifier/reward.txt
