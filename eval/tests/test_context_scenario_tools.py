from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = (
    ROOT
    / "eval"
    / "pi_eval_harness"
    / "runtime"
    / "context-scenario-tools"
    / "index.mjs"
)


def test_context_burst_produces_exact_bytes_and_canaries() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is unavailable")
    source = (
        f"import {{ burstText }} from {json.dumps(TOOLS.as_uri())}; "
        "const value = burstText(4096, 'CTX_CANARY_BURST_ALPHA'); "
        "console.log(JSON.stringify({bytes: Buffer.byteLength(value), "
        "head: value.startsWith('HEAD CTX_CANARY_BURST_ALPHA'), "
        "tail: value.endsWith('TAIL CTX_CANARY_BURST_ALPHA')}));"
    )
    result = subprocess.run(
        [node, "--input-type=module", "--eval", source],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout) == {"bytes": 4096, "head": True, "tail": True}


def test_checkpoint_history_seeder_produces_exact_bounded_chunks() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is unavailable")
    source = (
        f"import {{ checkpointHistoryChunks }} from {json.dumps(TOOLS.as_uri())}; "
        "const values = checkpointHistoryChunks(9, 100000); "
        "console.log(JSON.stringify({"
        "count: values.length, "
        "totalBytes: values.reduce((n, value) => n + "
        "Buffer.byteLength(value.text), 0), "
        "uniqueLabels: new Set(values.map(value => value.label)).size, "
        "firstPersistent: values[0].text.includes("
        "'CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M'), "
        "lastTail: values[8].text.includes('CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R')"
        "}));"
    )
    result = subprocess.run(
        [node, "--input-type=module", "--eval", source],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "count": 9,
        "totalBytes": 900_000,
        "uniqueLabels": 9,
        "firstPersistent": True,
        "lastTail": True,
    }


def test_checkpoint_history_seeder_has_distinct_second_cycle_canaries() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is unavailable")
    source = (
        f"import {{ checkpointHistoryChunks }} from {json.dumps(TOOLS.as_uri())}; "
        "const values = checkpointHistoryChunks(9, 100000, 2); "
        "console.log(JSON.stringify({"
        "count: values.length, "
        "firstPersistent: values[0].text.includes("
        "'CTX_CANARY_CHECKPOINT_PERSIST_BETA_4N8V'), "
        "lastTail: values[8].text.includes("
        "'CTX_CANARY_CHECKPOINT_TAIL_SIGMA_6P3D')"
        "}));"
    )
    result = subprocess.run(
        [node, "--input-type=module", "--eval", source],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "count": 9,
        "firstPersistent": True,
        "lastTail": True,
    }
