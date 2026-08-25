#!/usr/bin/env bash
set -euo pipefail

reward=0
if [[ -f /app/seed-complete ]] \
  && [[ "$(tr -d '\r\n' < /app/seed-complete)" == "ready" ]] \
  && [[ -f /app/recalled.txt ]] \
  && [[ "$(tr -d '\r\n' < /app/recalled.txt)" == "CTX_CANARY_PERSIST_RESUME_ALPHA" ]]; then
  reward=1
fi
printf '%s\n' "${reward}" > /logs/verifier/reward.txt
