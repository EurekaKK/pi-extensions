from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "eval" / "pi_eval_harness" / "runtime" / "context-probe" / "index.mjs"


def run_probe_helper(expression: str) -> dict[str, object]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is unavailable")
    source = (
        f"import {{ inspectContextManagementState, summarizeValue }} "
        f"from {json.dumps(PROBE.as_uri())}; "
        f"console.log(JSON.stringify({expression}));"
    )
    result = subprocess.run(
        [node, "--input-type=module", "--eval", source],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    value = json.loads(result.stdout)
    assert isinstance(value, dict)
    return value


def test_probe_summarizes_shape_without_retaining_text() -> None:
    summary = run_probe_helper(
        "summarizeValue([{role:'user',content:[{type:'text',"
        "text:'secret CTX_CANARY_ALPHA'}]}])"
    )

    assert summary["role_counts"] == {"user": 1}
    assert summary["type_counts"] == {"text": 1}
    assert summary["canaries"] == ["CTX_CANARY_ALPHA"]
    assert summary["string_bytes"] > 0
    assert "secret" not in json.dumps(summary)
    assert str(summary["fingerprint"]).startswith("sha256:")


def test_probe_fingerprint_changes_with_content() -> None:
    first = run_probe_helper("summarizeValue({role:'user',content:'first'})")
    second = run_probe_helper("summarizeValue({role:'user',content:'second'})")

    assert first["fingerprint"] != second["fingerprint"]


def test_probe_reports_context_management_state_without_file_names(
    tmp_path: Path,
) -> None:
    state_dir = tmp_path / "context-management"
    spill_dir = state_dir / "spill" / "session-hash"
    spill_dir.mkdir(parents=True)
    (state_dir / "config.json").write_text("{}\n")
    (spill_dir / "context_burst-secret-name.txt").write_text("secret payload")

    state = run_probe_helper(
        f"inspectContextManagementState({json.dumps(str(tmp_path))}, true)"
    )

    assert state == {
        "command_registered": True,
        "config_present": True,
        "spill_bytes": 14,
        "spill_files": 1,
        "unsafe_entries": 0,
    }
    serialized = json.dumps(state)
    assert "secret" not in serialized
    assert str(tmp_path) not in serialized
