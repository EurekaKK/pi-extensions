#!/usr/bin/env python3
"""Summarize and grade one Context Lab agent log directory."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

EVAL_ROOT = Path(__file__).resolve().parents[1]
if str(EVAL_ROOT) not in sys.path:
    sys.path.insert(0, str(EVAL_ROOT))


def main() -> int:
    from pi_eval_harness.context_trace import analyze_trace, read_trace

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "agent_logs_dir",
        type=Path,
        help="Trial agent log directory containing pi/context-probe/probe.ndjson",
    )
    parser.add_argument(
        "--expect-spill",
        action="store_true",
        help="Enforce the managed 70,000-byte spill scenario contract",
    )
    parser.add_argument(
        "--expect-prune",
        action="store_true",
        help="Enforce a managed repeated-spill pressure/prune contract",
    )
    parser.add_argument(
        "--expect-checkpoint",
        action="store_true",
        help="Enforce one managed rolling-checkpoint continuity contract",
    )
    parser.add_argument(
        "--expect-prepared-checkpoint",
        action="store_true",
        help="Enforce a ready-before-pressure background checkpoint contract",
    )
    parser.add_argument(
        "--expect-rolling-checkpoint",
        action="store_true",
        help="Enforce two background rolling-checkpoint cycles",
    )
    args = parser.parse_args()

    analysis = analyze_trace(
        read_trace(args.agent_logs_dir),
        expect_spill=args.expect_spill,
        expect_prune=args.expect_prune,
        expect_checkpoint=args.expect_checkpoint,
        expect_prepared_checkpoint=args.expect_prepared_checkpoint,
        expect_rolling_checkpoint=args.expect_rolling_checkpoint,
    )
    print(json.dumps(analysis, indent=2, sort_keys=True))
    invariants = analysis["invariants"]
    return 0 if isinstance(invariants, dict) and invariants.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
