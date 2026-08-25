from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from pi_eval_harness.context_job import summarize_context_job, summarize_context_jobs
from pi_eval_harness.context_trace import TRACE_SCHEMA

ROOT = Path(__file__).resolve().parents[1]


def _summary() -> dict[str, object]:
    return {
        "array_count": 1,
        "binary_bytes": 0,
        "binary_count": 0,
        "canaries": [],
        "circular_nodes": 0,
        "fingerprint": "sha256:test",
        "max_string_bytes": 10,
        "object_count": 1,
        "role_counts": {"user": 1},
        "string_bytes": 10,
        "string_count": 1,
        "truncated_nodes": 0,
        "type_counts": {"text": 1},
    }


def _record(seq: int, event: str, timestamp: str) -> dict[str, object]:
    data: dict[str, object]
    if event == "before_agent_start":
        data = {
            "images": 0,
            "model": {
                "api": "openai-completions",
                "context_window": 262_144,
                "id": "ox-alpha-free",
                "max_tokens": 65_536,
                "provider": "opencode-go",
            },
            "prompt": _summary(),
            "system_prompt": _summary(),
        }
    elif event == "context":
        data = {
            "context_usage": None,
            "message_count": 1,
            "messages": _summary(),
            "model": {
                "api": "openai-completions",
                "context_window": 262_144,
                "id": "ox-alpha-free",
                "max_tokens": 65_536,
                "provider": "opencode-go",
            },
        }
    else:
        data = {
            "model": {
                "api": "openai-completions",
                "context_window": 262_144,
                "id": "ox-alpha-free",
                "max_tokens": 65_536,
                "provider": "opencode-go",
            },
            "payload": _summary(),
        }
    return {
        "data": data,
        "event": event,
        "leaf_hash": "leaf",
        "run_id": "run",
        "schema": TRACE_SCHEMA,
        "seq": seq,
        "session_hash": "session",
        "timestamp": timestamp,
    }


def _write_trial(
    job_dir: Path,
    name: str,
    *,
    variant: str,
    context_block_ms: int,
    reward: float = 1.0,
    model: str = "opencode-go/ox-alpha-free",
) -> None:
    trial_dir = job_dir / name
    trace_path = trial_dir / "agent" / "pi" / "context-probe" / "probe.ndjson"
    trace_path.parent.mkdir(parents=True)
    trace_path.write_text(
        "\n".join(
            json.dumps(record)
            for record in (
                _record(1, "before_agent_start", "2026-08-25T00:00:00.000Z"),
                _record(
                    2,
                    "context",
                    f"2026-08-25T00:00:00.{context_block_ms:03d}Z",
                ),
                _record(
                    3,
                    "before_provider_request",
                    f"2026-08-25T00:00:00.{context_block_ms + 1:03d}Z",
                ),
            )
        )
        + "\n"
    )
    provider, model_id = model.split("/", 1)
    result = {
        "trial_name": name,
        "task_name": "large-tool-output",
        "started_at": "2026-08-25T00:00:00.000Z",
        "finished_at": "2026-08-25T00:00:10.000Z",
        "config": {
            "agent": {
                "model_name": model,
                "kwargs": {"eval_variant": variant},
            }
        },
        "agent_info": {
            "name": f"pi-tui-{variant}",
            "model_info": {"provider": provider, "name": model_id},
        },
        "agent_result": {
            "n_input_tokens": 100,
            "n_cache_tokens": 20,
            "n_output_tokens": 10,
            "cost_usd": 0.01,
            "metadata": {
                "model": model,
                "eval_variant": variant,
                "context_trace_expect_spill": False,
                "context_trace_expect_prune": False,
                "context_trace_expect_checkpoint": False,
                "context_trace_expect_prepared_checkpoint": False,
                "context_trace_expect_rolling_checkpoint": False,
            },
        },
        "step_results": [],
        "verifier_result": {"rewards": {"reward": reward}},
        "exception_info": None,
    }
    (trial_dir / "result.json").write_text(json.dumps(result))


def test_context_job_summary_groups_attempts_and_distributions(tmp_path: Path) -> None:
    for index, latency in enumerate((10, 20, 30), start=1):
        _write_trial(
            tmp_path,
            f"native-{index}",
            variant="native",
            context_block_ms=latency,
        )
        _write_trial(
            tmp_path,
            f"managed-{index}",
            variant="context-management",
            context_block_ms=latency + 5,
        )

    result = summarize_context_job(
        tmp_path,
        expect_attempts=3,
        expect_model="opencode-go/ox-alpha-free",
    )

    assert result["invariants"] == {"passed": True, "violations": []}
    assert result["summary"]["trials"] == 6
    managed = result["summary"]["groups"]["context-management"]
    assert managed["attempts"] == 3
    assert managed["passed"] == 3
    assert managed["context_block_ms_by_turn"] == [
        {"count": 3, "max": 35, "mean": 25.0, "median": 25, "min": 15, "p95": 35}
    ]
    assert managed["usage"]["input_tokens"]["mean"] == 100.0


def test_context_job_summary_rejects_wrong_model_and_failed_reward(
    tmp_path: Path,
) -> None:
    _write_trial(
        tmp_path,
        "failed",
        variant="context-management",
        context_block_ms=10,
        reward=0.0,
        model="other/model",
    )

    result = summarize_context_job(
        tmp_path,
        expect_attempts=2,
        expect_model="opencode-go/ox-alpha-free",
    )

    assert result["invariants"]["passed"] is False
    checks = {item["check"] for item in result["invariants"]["violations"]}
    assert checks == {"model", "trial_passed", "valid_attempt_count"}


def test_context_job_script_exits_nonzero_on_invariant_failure(tmp_path: Path) -> None:
    _write_trial(
        tmp_path,
        "failed",
        variant="context-management",
        context_block_ms=10,
        reward=0.0,
    )

    result = subprocess.run(
        [
            sys.executable,
            "scripts/summarize-context-job.py",
            str(tmp_path),
            "--expect-attempts",
            "1",
            "--expect-model",
            "opencode-go/ox-alpha-free",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 1
    assert json.loads(result.stdout)["invariants"]["passed"] is False


def test_context_job_reads_the_last_multi_step_trace(tmp_path: Path) -> None:
    _write_trial(
        tmp_path,
        "multi-step",
        variant="context-management",
        context_block_ms=25,
    )
    trial_dir = tmp_path / "multi-step"
    result_path = trial_dir / "result.json"
    result = json.loads(result_path.read_text())
    agent_result = result.pop("agent_result")
    result["step_results"] = [
        {
            "step_name": "recall",
            "agent_result": agent_result,
            "exception_info": None,
        }
    ]
    result_path.write_text(json.dumps(result))
    source = trial_dir / "agent" / "pi" / "context-probe" / "probe.ndjson"
    destination = (
        trial_dir
        / "steps"
        / "recall"
        / "agent"
        / "pi"
        / "context-probe"
        / "probe.ndjson"
    )
    destination.parent.mkdir(parents=True)
    source.rename(destination)

    analysis = summarize_context_job(
        tmp_path,
        expect_attempts=1,
        expect_model="opencode-go/ox-alpha-free",
    )

    assert analysis["invariants"]["passed"] is True
    trial = analysis["summary"]["trial_results"][0]
    assert trial["context_block_ms_by_agent_start"] == [25]


def test_context_job_classifies_provider_503_as_infrastructure_failure(
    tmp_path: Path,
) -> None:
    _write_trial(
        tmp_path,
        "provider-down",
        variant="context-management",
        context_block_ms=10,
    )
    result_path = tmp_path / "provider-down" / "result.json"
    result = json.loads(result_path.read_text())
    result["verifier_result"] = None
    result["exception_info"] = {
        "exception_type": "NonZeroAgentExitCodeError",
        "exception_message": (
            "Command failed (exit 75): Exceeded recoverable model stream error "
            "limit (3); 503 Endpoint is unavailable"
        ),
    }
    result_path.write_text(json.dumps(result))

    analysis = summarize_context_job(
        tmp_path,
        expect_attempts=1,
        expect_model="opencode-go/ox-alpha-free",
    )

    group = analysis["summary"]["groups"]["context-management"]
    assert group["attempts"] == 1
    assert group["valid_attempts"] == 0
    assert group["infrastructure_failed"] == 1
    assert group["product_failed"] == 0
    assert group["pass_rate"] == 0.0
    assert analysis["summary"]["infrastructure_failures"] == [
        {
            "trial": "provider-down",
            "kind": "provider temporarily unavailable",
        }
    ]
    assert analysis["invariants"]["violations"] == [
        {
            "check": "valid_attempt_count",
            "trial": None,
            "detail": (
                "variant 'context-management': expected 1 valid attempts, observed 0"
            ),
        },
    ]


def test_context_job_classifies_agent_setup_timeout_as_infrastructure_failure(
    tmp_path: Path,
) -> None:
    _write_trial(
        tmp_path,
        "setup-timeout",
        variant="context-management",
        context_block_ms=10,
    )
    result_path = tmp_path / "setup-timeout" / "result.json"
    result = json.loads(result_path.read_text())
    result["verifier_result"] = None
    result["exception_info"] = {
        "exception_type": "AgentSetupTimeoutError",
        "exception_message": "Agent setup timed out after 360.0 seconds",
    }
    result_path.write_text(json.dumps(result))

    analysis = summarize_context_job(tmp_path)

    trial = analysis["summary"]["trial_results"][0]
    assert trial["outcome"] == "infrastructure_failure"
    assert trial["failure_kind"] == "agent setup timeout"


def test_context_jobs_combine_replacement_trials_across_jobs(tmp_path: Path) -> None:
    first_job = tmp_path / "first"
    replacement_job = tmp_path / "replacement"
    _write_trial(
        first_job,
        "valid-1",
        variant="context-management",
        context_block_ms=10,
    )
    _write_trial(
        first_job,
        "valid-2",
        variant="context-management",
        context_block_ms=11,
    )
    _write_trial(
        first_job,
        "provider-down",
        variant="context-management",
        context_block_ms=12,
    )
    failed_path = first_job / "provider-down" / "result.json"
    failed = json.loads(failed_path.read_text())
    failed["verifier_result"] = None
    failed["exception_info"] = {
        "exception_type": "NonZeroAgentExitCodeError",
        "exception_message": (
            "Exceeded recoverable model stream error limit (3); "
            "503 Endpoint is unavailable"
        ),
    }
    failed_path.write_text(json.dumps(failed))
    _write_trial(
        replacement_job,
        "valid-3",
        variant="context-management",
        context_block_ms=13,
    )

    analysis = summarize_context_jobs(
        [first_job, replacement_job],
        expect_attempts=3,
        expect_model="opencode-go/ox-alpha-free",
    )

    assert analysis["invariants"] == {"passed": True, "violations": []}
    group = analysis["summary"]["groups"]["context-management"]
    assert group["attempts"] == 4
    assert group["valid_attempts"] == 3
    assert group["passed"] == 3
    assert group["infrastructure_failed"] == 1


def test_context_job_classifies_setup_tls_failure_as_infrastructure(
    tmp_path: Path,
) -> None:
    _write_trial(
        tmp_path,
        "setup-tls",
        variant="context-management",
        context_block_ms=10,
    )
    result_path = tmp_path / "setup-tls" / "result.json"
    result = json.loads(result_path.read_text())
    result["agent_execution"] = None
    result["verifier_result"] = None
    result["exception_info"] = {
        "exception_type": "NonZeroAgentExitCodeError",
        "exception_message": (
            "Failed to clone nvm repo: gnutls_handshake() failed: "
            "The TLS connection was non-properly terminated"
        ),
    }
    result_path.write_text(json.dumps(result))

    analysis = summarize_context_job(tmp_path)

    trial = analysis["summary"]["trial_results"][0]
    assert trial["outcome"] == "infrastructure_failure"
    assert trial["failure_kind"] == "agent setup network failure"
