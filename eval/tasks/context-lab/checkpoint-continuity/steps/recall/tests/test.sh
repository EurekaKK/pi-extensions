#!/usr/bin/env bash
set -euo pipefail

reward=0
if [[ -f /app/.context-lab/checkpoint-history.json ]] \
  && [[ -f /app/checkpoint-recalled.txt ]] \
  && rg --fixed-strings --line-regexp 'checkpoint=complete' /app/checkpoint-recalled.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'persistent=CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M' /app/checkpoint-recalled.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'tail=CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R' /app/checkpoint-recalled.txt >/dev/null; then
  reward=1
fi
printf '%s\n' "${reward}" > /logs/verifier/reward.txt
