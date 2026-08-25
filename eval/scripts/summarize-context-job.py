#!/usr/bin/env python3
"""Re-grade and aggregate repeated Context Lab trials across Harbor jobs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

EVAL_ROOT = Path(__file__).resolve().parents[1]
if str(EVAL_ROOT) not in sys.path:
    sys.path.insert(0, str(EVAL_ROOT))


def main() -> int:
    from pi_eval_harness.context_job import summarize_context_jobs

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "job_dirs",
        type=Path,
        nargs="+",
        help="Harbor job directories containing direct trial result directories",
    )
    parser.add_argument(
        "--expect-attempts",
        type=int,
        help="Require this many non-infrastructure trials per eval_variant",
    )
    parser.add_argument(
        "--expect-model",
        help="Require every trial to use this exact provider/model identifier",
    )
    args = parser.parse_args()
    if args.expect_attempts is not None and args.expect_attempts < 1:
        parser.error("--expect-attempts must be positive")

    analysis = summarize_context_jobs(
        args.job_dirs,
        expect_attempts=args.expect_attempts,
        expect_model=args.expect_model,
    )
    print(json.dumps(analysis, indent=2, sort_keys=True))
    invariants = analysis["invariants"]
    return 0 if isinstance(invariants, dict) and invariants.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
