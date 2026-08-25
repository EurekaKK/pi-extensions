#!/usr/bin/env bash
set -euo pipefail

reward=0
if [[ -f /app/.context-lab/checkpoint-history.json ]] \
  && [[ -f /app/prepared-checkpoint-recalled.txt ]] \
  && rg --fixed-strings '"bytes_per_chunk":100000' /app/.context-lab/checkpoint-history.json >/dev/null \
  && rg --fixed-strings '"chunks":9' /app/.context-lab/checkpoint-history.json >/dev/null \
  && rg --fixed-strings '"total_bytes":900000' /app/.context-lab/checkpoint-history.json >/dev/null \
  && rg --fixed-strings --line-regexp 'checkpoint=complete' /app/prepared-checkpoint-recalled.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'persistent=CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M' /app/prepared-checkpoint-recalled.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'tail=CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R' /app/prepared-checkpoint-recalled.txt >/dev/null; then
  reward=1
fi
printf '%s\n' "${reward}" > /logs/verifier/reward.txt
