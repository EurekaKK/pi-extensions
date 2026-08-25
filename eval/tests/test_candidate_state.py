from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "pi_eval_harness" / "runtime" / "candidate-state.mjs"


def test_candidate_state_reports_the_latest_lifecycle_phase(tmp_path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is unavailable")
    trace = tmp_path / "probe.ndjson"
    trace.write_text(
        "".join(
            f"{json.dumps(record)}\n"
            for record in [
                {
                    "event": "candidate_lifecycle",
                    "data": {"detail": None, "phase": "started"},
                },
                {"event": "context", "data": {}},
                {
                    "event": "candidate_lifecycle",
                    "data": {"detail": None, "phase": "ready"},
                },
            ]
        )
    )

    result = subprocess.run(
        [node, str(SCRIPT), str(trace)],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ready"
