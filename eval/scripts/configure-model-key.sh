#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  echo "Run this script as an executable; do not source it." >&2
  return 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/sources.sh
source "${script_dir}/lib/sources.sh"
# shellcheck source=scripts/lib/secrets.sh
source "${script_dir}/lib/secrets.sh"

eval_root="$(eval_root_from_lib "${script_dir}/lib")"
require_eval_root "${eval_root}"

replace=false
case "${1:-}" in
  "") ;;
  --replace) replace=true ;;
  --help|-h)
    echo "Usage: $0 [--replace]"
    echo "Prompts securely for the model provider API key used by Harbor runtime jobs."
    exit 0
    ;;
  *)
    echo "Usage: $0 [--replace]" >&2
    exit 2
    ;;
esac

write_secret_file \
  "${eval_root}/.secrets" \
  "${eval_root}/.secrets/model_api_key" \
  "model_api_key" \
  "${replace}" \
  "Model provider API key: "

echo "Model provider key stored at eval/.secrets/model_api_key (mode 600)."
