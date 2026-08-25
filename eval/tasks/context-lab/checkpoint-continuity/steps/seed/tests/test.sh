#!/usr/bin/env bash
set -euo pipefail

reward=0
if [[ -f /app/.context-lab/checkpoint-history.json ]] \
  && rg --fixed-strings '"bytes_per_chunk":100000' /app/.context-lab/checkpoint-history.json >/dev/null \
  && rg --fixed-strings '"chunks":9' /app/.context-lab/checkpoint-history.json >/dev/null \
  && rg --fixed-strings '"total_bytes":900000' /app/.context-lab/checkpoint-history.json >/dev/null; then
  reward=1
fi
printf '%s\n' "${reward}" > /logs/verifier/reward.txt
