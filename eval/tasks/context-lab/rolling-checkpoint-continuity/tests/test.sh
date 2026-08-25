#!/usr/bin/env bash
set -euo pipefail

reward=0
if [[ -f /app/.context-lab/checkpoint-history.json ]] \
  && [[ -f /app/.context-lab/checkpoint-history-2.json ]] \
  && rg --fixed-strings '"cycle":1' /app/.context-lab/checkpoint-history.json >/dev/null \
  && rg --fixed-strings '"cycle":2' /app/.context-lab/checkpoint-history-2.json >/dev/null \
  && [[ -f /app/rolling-checkpoint-1.txt ]] \
  && [[ -f /app/rolling-checkpoint-2.txt ]] \
  && rg --fixed-strings --line-regexp 'cycle=1' /app/rolling-checkpoint-1.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'persistent=CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M' /app/rolling-checkpoint-1.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'tail=CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R' /app/rolling-checkpoint-1.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'cycle=2' /app/rolling-checkpoint-2.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'previous=CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M' /app/rolling-checkpoint-2.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'persistent=CTX_CANARY_CHECKPOINT_PERSIST_BETA_4N8V' /app/rolling-checkpoint-2.txt >/dev/null \
  && rg --fixed-strings --line-regexp 'tail=CTX_CANARY_CHECKPOINT_TAIL_SIGMA_6P3D' /app/rolling-checkpoint-2.txt >/dev/null; then
  reward=1
fi
printf '%s\n' "${reward}" > /logs/verifier/reward.txt
