from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from pi_eval_harness.context_trace import (
    TRACE_SCHEMA,
    TraceFormatError,
    analyze_trace,
    parse_trace_jsonl,
)

SUMMARY = {
    "array_count": 1,
    "binary_bytes": 0,
    "binary_count": 0,
    "canaries": ["CTX_CANARY_INPUT_ALPHA", "CTX_CANARY_PERSIST_ALPHA"],
    "circular_nodes": 0,
    "fingerprint": "sha256:abc",
    "max_string_bytes": 20,
    "object_count": 2,
    "role_counts": {"user": 1},
    "string_bytes": 40,
    "string_count": 2,
    "truncated_nodes": 0,
    "type_counts": {"text": 1},
}
ROOT = Path(__file__).resolve().parents[1]


def record(seq: int, event: str, data: dict[str, object]) -> dict[str, object]:
    return {
        "data": data,
        "event": event,
        "leaf_hash": "leaf",
        "run_id": "run-1",
        "schema": TRACE_SCHEMA,
        "seq": seq,
        "session_hash": "session",
        "timestamp": "2026-08-24T00:00:00.000Z",
    }


def trace(*items: dict[str, object]) -> str:
    return "\n".join(json.dumps(item) for item in items)


def test_trace_analysis_summarizes_real_probe_events() -> None:
    records = parse_trace_jsonl(
        trace(
            record(
                1,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": SUMMARY,
                    "system_prompt": SUMMARY,
                },
            ),
            record(
                2,
                "context",
                {
                    "context_usage": None,
                    "message_count": 1,
                    "messages": SUMMARY,
                    "model": None,
                },
            ),
            record(
                3,
                "tool_call",
                {"input": SUMMARY, "tool_call_hash": "call", "tool_name": "bash"},
            ),
            record(
                4,
                "tool_result",
                {
                    "content": SUMMARY,
                    "input": SUMMARY,
                    "is_error": False,
                    "tool_call_hash": "call",
                    "tool_name": "bash",
                },
            ),
            record(
                5,
                "before_provider_request",
                {"model": None, "payload": SUMMARY},
            ),
            record(
                6,
                "message_end",
                {
                    "message": SUMMARY,
                    "role": "assistant",
                    "stop_reason": "stop",
                    "usage": {
                        "cache_read": 10,
                        "cache_write": 2,
                        "input": 100,
                        "output": 20,
                        "total_tokens": 132,
                    },
                },
            ),
        )
    )

    analysis = analyze_trace(records)
    assert analysis["invariants"] == {"passed": True, "violations": []}
    summary = analysis["summary"]
    assert summary["requests"]["provider_requests"] == 1
    assert summary["tools"]["by_name"] == {"bash": 1}
    assert summary["foreground_usage"] == {
        "cache_read": 10,
        "cache_write": 2,
        "input": 100,
        "output": 20,
    }


def test_trace_summarizes_first_context_blocking_latency_per_run() -> None:
    first_start = record(
        1,
        "before_agent_start",
        {
            "images": 0,
            "model": None,
            "prompt": SUMMARY,
            "system_prompt": SUMMARY,
        },
    )
    first_start["timestamp"] = "2026-08-24T00:00:00.000Z"
    first_context = record(
        2,
        "context",
        {
            "context_usage": None,
            "message_count": 1,
            "messages": SUMMARY,
            "model": None,
        },
    )
    first_context["timestamp"] = "2026-08-24T00:00:00.010Z"

    second_start = record(
        1,
        "before_agent_start",
        {
            "images": 0,
            "model": None,
            "prompt": SUMMARY,
            "system_prompt": SUMMARY,
        },
    )
    second_start["run_id"] = "run-2"
    second_start["timestamp"] = "2026-08-24T00:01:00.000Z"
    second_context = record(
        2,
        "context",
        {
            "context_usage": None,
            "message_count": 1,
            "messages": SUMMARY,
            "model": None,
        },
    )
    second_context["run_id"] = "run-2"
    second_context["timestamp"] = "2026-08-24T00:01:05.500Z"

    followup_start = record(
        3,
        "before_agent_start",
        {
            "images": 0,
            "model": None,
            "prompt": SUMMARY,
            "system_prompt": SUMMARY,
        },
    )
    followup_start["run_id"] = "run-2"
    followup_start["timestamp"] = "2026-08-24T00:02:00.000Z"
    followup_context = record(
        4,
        "context",
        {
            "context_usage": None,
            "message_count": 1,
            "messages": SUMMARY,
            "model": None,
        },
    )
    followup_context["run_id"] = "run-2"
    followup_context["timestamp"] = "2026-08-24T00:02:00.100Z"

    summary = analyze_trace(
        parse_trace_jsonl(
            trace(
                first_start,
                first_context,
                second_start,
                second_context,
                followup_start,
                followup_context,
            )
        )
    )["summary"]

    assert summary["latency"] == {
        "context_block_ms_by_agent_start": [10, 5_500, 100],
        "first_context_ms_by_run": [10, 5_500],
        "max_first_context_ms": 5_500,
    }


def test_analyzer_script_runs_directly_from_the_eval_root(tmp_path: Path) -> None:
    trace_file = tmp_path / "pi" / "context-probe" / "probe.ndjson"
    trace_file.parent.mkdir(parents=True)
    trace_file.write_text(
        trace(
            record(
                1,
                "context",
                {
                    "context_usage": None,
                    "message_count": 1,
                    "messages": SUMMARY,
                    "model": None,
                },
            ),
            record(
                2,
                "before_provider_request",
                {"model": None, "payload": SUMMARY},
            ),
        )
        + "\n"
    )

    result = subprocess.run(
        [
            sys.executable,
            "scripts/analyze-context-trace.py",
            str(tmp_path),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["invariants"]["passed"] is True


def test_trace_parser_rejects_unknown_event_and_sequence_gap() -> None:
    unknown = record(1, "unknown", {})
    with pytest.raises(TraceFormatError, match="unknown event"):
        parse_trace_jsonl(trace(unknown))

    first = record(1, "agent_settled", {})
    third = record(3, "agent_settled", {})
    with pytest.raises(TraceFormatError, match="expected seq 2"):
        parse_trace_jsonl(trace(first, third))


def test_trace_parser_ignores_only_one_incomplete_final_record() -> None:
    valid = trace(record(1, "agent_settled", {}))

    assert len(parse_trace_jsonl(valid + '\n{"schema":')) == 1
    with pytest.raises(TraceFormatError, match="invalid JSON"):
        parse_trace_jsonl(valid + '\n{"schema":\n')


def test_empty_trace_is_an_invariant_failure() -> None:
    analysis = analyze_trace([])

    assert analysis["invariants"]["passed"] is False
    assert analysis["invariants"]["violations"][0]["check"] == "trace_present"


def test_trace_summarizes_optional_context_management_state() -> None:
    records = parse_trace_jsonl(
        trace(
            record(
                1,
                "agent_settled",
                {
                    "context_management": {
                        "command_registered": True,
                        "config_present": True,
                        "spill_bytes": 70_000,
                        "spill_files": 1,
                        "unsafe_entries": 0,
                    }
                },
            )
        )
    )

    assert analyze_trace(records)["summary"]["context_management"] == {
        "command_registered": True,
        "config_present": True,
        "observed": True,
        "spill_bytes": 70_000,
        "spill_files": 1,
        "unsafe_entries": 0,
    }


def test_trace_summarizes_candidate_lifecycle_sequence() -> None:
    records = parse_trace_jsonl(
        trace(
            record(
                1,
                "candidate_lifecycle",
                {"detail": None, "phase": "started"},
            ),
            record(
                2,
                "candidate_lifecycle",
                {"detail": None, "phase": "ready"},
            ),
            record(
                3,
                "candidate_lifecycle",
                {"detail": None, "phase": "installed"},
            ),
        )
    )

    records[1] = type(records[1])(
        **{**records[1].__dict__, "timestamp": "2026-08-24T00:00:01.500Z"}
    )

    assert analyze_trace(records)["summary"]["candidate_lifecycle"] == {
        "by_phase": {"installed": 1, "ready": 1, "started": 1},
        "phases": ["started", "ready", "installed"],
        "prepare_ms": [1_500],
    }


@pytest.mark.parametrize("spill_bytes", [70_000, 250_000])
def test_spill_expectation_reads_source_bytes_from_task_canary(
    spill_bytes: int,
) -> None:
    expected_canaries = [
        f"CTX_CANARY_EXPECT_SPILL_BYTES_{spill_bytes}",
        "CTX_CANARY_LARGE_PAYLOAD",
        "CTX_CANARY_REQUIRE_TOOL_CONTEXT_BURST",
    ]
    prompt = {**SUMMARY, "canaries": expected_canaries}

    def spill_records(max_visible_bytes: int):
        projected = {
            **SUMMARY,
            "canaries": ["CTX_CANARY_LARGE_PAYLOAD"],
            "max_string_bytes": max_visible_bytes,
            "string_bytes": max_visible_bytes + 4,
        }
        visible_context = {
            **SUMMARY,
            "canaries": expected_canaries,
            "max_string_bytes": max_visible_bytes,
            "string_bytes": max_visible_bytes + 1_000,
        }
        return parse_trace_jsonl(
            trace(
                record(
                    1,
                    "before_agent_start",
                    {
                        "context_management": {
                            "command_registered": True,
                            "config_present": True,
                            "spill_bytes": 0,
                            "spill_files": 0,
                            "unsafe_entries": 0,
                        },
                        "images": 0,
                        "model": None,
                        "prompt": prompt,
                        "system_prompt": SUMMARY,
                    },
                ),
                record(
                    2,
                    "context",
                    {
                        "context_usage": None,
                        "message_count": 1,
                        "messages": prompt,
                        "model": None,
                    },
                ),
                record(
                    3,
                    "before_provider_request",
                    {"model": None, "payload": prompt},
                ),
                record(
                    4,
                    "tool_call",
                    {
                        "input": SUMMARY,
                        "tool_call_hash": "burst-call",
                        "tool_name": "context_burst",
                    },
                ),
                record(
                    5,
                    "tool_result",
                    {
                        "content": projected,
                        "input": SUMMARY,
                        "is_error": False,
                        "tool_call_hash": "burst-call",
                        "tool_name": "context_burst",
                    },
                ),
                record(
                    6,
                    "context",
                    {
                        "context_usage": None,
                        "message_count": 3,
                        "messages": visible_context,
                        "model": None,
                    },
                ),
                record(
                    7,
                    "before_provider_request",
                    {"model": None, "payload": visible_context},
                ),
                record(
                    8,
                    "agent_settled",
                    {
                        "context_management": {
                            "command_registered": True,
                            "config_present": True,
                            "spill_bytes": spill_bytes,
                            "spill_files": 1,
                            "unsafe_entries": 0,
                        }
                    },
                ),
            )
        )

    leaked = analyze_trace(spill_records(spill_bytes), expect_spill=True)
    bounded = analyze_trace(spill_records(50_000), expect_spill=True)

    assert any(
        item["check"] == "spill_effective"
        for item in leaked["invariants"]["violations"]
    )
    assert bounded["invariants"] == {"passed": True, "violations": []}


def test_prune_expectation_rejects_spill_only_and_accepts_pruned_surface() -> None:
    burst_count = 17
    burst_bytes = 250_000
    expectation = f"CTX_CANARY_EXPECT_PRUNE_SPILLS_{burst_count}_BYTES_{burst_bytes}"
    prompt = {
        **SUMMARY,
        "canaries": [expectation, "CTX_CANARY_REQUIRE_TOOL_CONTEXT_BURST"],
    }

    def pressure_records(max_post_burst_string_bytes: int):
        items = [
            record(
                1,
                "before_agent_start",
                {
                    "context_management": {
                        "command_registered": True,
                        "config_present": True,
                        "spill_bytes": 0,
                        "spill_files": 0,
                        "unsafe_entries": 0,
                    },
                    "images": 0,
                    "model": None,
                    "prompt": prompt,
                    "system_prompt": SUMMARY,
                },
            ),
            record(
                2,
                "context",
                {
                    "context_usage": None,
                    "message_count": 1,
                    "messages": prompt,
                    "model": None,
                },
            ),
            record(
                3,
                "before_provider_request",
                {"model": None, "payload": prompt},
            ),
        ]
        seq = 4
        for index in range(1, burst_count + 1):
            call_hash = f"burst-{index:02d}"
            payload_canary = f"CTX_CANARY_PRESSURE_{index:02d}"
            input_summary = {**SUMMARY, "canaries": [payload_canary]}
            content_summary = {
                **SUMMARY,
                "canaries": [payload_canary],
                "max_string_bytes": 50_000,
                "string_bytes": 50_004,
            }
            items.extend(
                [
                    record(
                        seq,
                        "tool_call",
                        {
                            "input": input_summary,
                            "tool_call_hash": call_hash,
                            "tool_name": "context_burst",
                        },
                    ),
                    record(
                        seq + 1,
                        "tool_result",
                        {
                            "content": content_summary,
                            "input": input_summary,
                            "is_error": False,
                            "tool_call_hash": call_hash,
                            "tool_name": "context_burst",
                        },
                    ),
                ]
            )
            seq += 2
        final_surface = {
            **SUMMARY,
            "canaries": prompt["canaries"],
            "max_string_bytes": max_post_burst_string_bytes,
            "string_bytes": max_post_burst_string_bytes * burst_count + 1_000,
        }
        items.extend(
            [
                record(
                    seq,
                    "context",
                    {
                        "context_usage": None,
                        "message_count": burst_count * 2 + 2,
                        "messages": final_surface,
                        "model": None,
                    },
                ),
                record(
                    seq + 1,
                    "before_provider_request",
                    {"model": None, "payload": final_surface},
                ),
                record(
                    seq + 2,
                    "agent_settled",
                    {
                        "context_management": {
                            "command_registered": True,
                            "config_present": True,
                            "spill_bytes": burst_count * burst_bytes,
                            "spill_files": burst_count,
                            "unsafe_entries": 0,
                        }
                    },
                ),
            ]
        )
        return parse_trace_jsonl(trace(*items))

    spill_only = analyze_trace(pressure_records(50_000), expect_prune=True)
    pruned = analyze_trace(pressure_records(8_192), expect_prune=True)

    assert any(
        item["check"] == "prune_effective"
        for item in spill_only["invariants"]["violations"]
    )
    assert pruned["invariants"] == {"passed": True, "violations": []}


def test_checkpoint_expectation_requires_persistent_summary_and_recent_tail() -> None:
    expectation = "CTX_CANARY_EXPECT_CHECKPOINT_CHUNKS_9_BYTES_100000"
    persistent = "CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M"
    tail = "CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R"
    labels = [
        persistent,
        *(f"CTX_CANARY_CHECKPOINT_FILLER_{index:02d}" for index in range(2, 9)),
        tail,
    ]
    plain = {**SUMMARY, "canaries": []}

    def checkpoint_records(
        summary_canaries: list[str], forbidden_tool: str | None = None
    ):
        run_one = [
            record(
                1,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": plain,
                    "system_prompt": plain,
                },
            ),
            record(
                2,
                "context",
                {
                    "context_usage": None,
                    "message_count": 1,
                    "messages": plain,
                    "model": None,
                },
            ),
            record(
                3,
                "before_provider_request",
                {"model": None, "payload": plain},
            ),
        ]

        prompt = {**SUMMARY, "canaries": [expectation]}
        seeded_session = {
            **SUMMARY,
            "canaries": labels,
            "max_string_bytes": 100_000,
            "string_bytes": 900_100,
            "type_counts": {"custom_message": 9},
        }
        visible = {
            **SUMMARY,
            "canaries": [expectation, persistent, tail],
            "max_string_bytes": 100_000,
            "string_bytes": 110_000,
        }
        checkpoint_summary = {
            **SUMMARY,
            "canaries": summary_canaries,
            "max_string_bytes": 4_000,
            "string_bytes": 4_100,
        }
        run_two = [
            record(
                1,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": prompt,
                    "session_context": seeded_session,
                    "system_prompt": SUMMARY,
                },
            ),
            record(
                2,
                "context",
                {
                    "context_usage": None,
                    "message_count": 4,
                    "messages": visible,
                    "model": None,
                },
            ),
            record(
                3,
                "before_provider_request",
                {"model": None, "payload": visible},
            ),
            record(
                4,
                "session_before_compact",
                {
                    "custom_instructions": False,
                    "first_kept_hash": "kept",
                    "messages_to_summarize": {
                        **SUMMARY,
                        "canaries": [persistent],
                    },
                    "reason": "manual",
                    "tokens_before": 220_000,
                    "turn_prefix": SUMMARY,
                    "will_retry": False,
                },
            ),
            record(
                5,
                "session_compact",
                {
                    "first_kept_hash": "kept",
                    "from_extension": True,
                    "reason": "manual",
                    "summary": checkpoint_summary,
                    "tokens_before": 220_000,
                    "usage": {
                        "cache_read": 0,
                        "cache_write": 0,
                        "input": 180_000,
                        "output": 4_000,
                        "total_tokens": 184_000,
                    },
                    "will_retry": False,
                },
            ),
            record(6, "agent_settled", {}),
        ]
        for item in run_two:
            item["run_id"] = "run-2"
        if forbidden_tool is not None:
            call = record(
                7,
                "tool_call",
                {
                    "input": SUMMARY,
                    "tool_call_hash": "forbidden-call",
                    "tool_name": forbidden_tool,
                },
            )
            result = record(
                8,
                "tool_result",
                {
                    "content": SUMMARY,
                    "input": SUMMARY,
                    "is_error": False,
                    "tool_call_hash": "forbidden-call",
                    "tool_name": forbidden_tool,
                },
            )
            for item in (call, result):
                item["run_id"] = "run-2"
            run_two.extend([call, result])
        return parse_trace_jsonl(trace(*run_one, *run_two))

    missing = analyze_trace(checkpoint_records([]), expect_checkpoint=True)
    preserved = analyze_trace(
        checkpoint_records([persistent]),
        expect_checkpoint=True,
    )
    cheated = analyze_trace(
        checkpoint_records([persistent], forbidden_tool="read"),
        expect_checkpoint=True,
    )

    assert any(
        item["check"] == "checkpoint_effective"
        for item in missing["invariants"]["violations"]
    )
    assert preserved["invariants"] == {"passed": True, "violations": []}
    assert any(
        item["check"] == "checkpoint_effective"
        for item in cheated["invariants"]["violations"]
    )


def test_prepared_checkpoint_expectation_requires_ready_hit_and_low_blocking() -> None:
    checkpoint_expectation = "CTX_CANARY_EXPECT_CHECKPOINT_CHUNKS_9_BYTES_100000"
    prepared_expectation = "CTX_CANARY_EXPECT_PREPARED_CHECKPOINT_BASELINE_MS_54640"
    persistent = "CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M"
    tail = "CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R"
    plain = {**SUMMARY, "canaries": []}
    seeded = {
        **SUMMARY,
        "canaries": [persistent, tail],
        "max_string_bytes": 100_000,
        "string_bytes": 900_100,
        "type_counts": {"custom_message": 9},
    }
    prompt = {
        **SUMMARY,
        "canaries": [
            checkpoint_expectation,
            prepared_expectation,
            "CTX_CANARY_REQUIRE_TOOL_WRITE",
        ],
    }
    visible = {
        **SUMMARY,
        "canaries": [*prompt["canaries"], persistent, tail],
        "max_string_bytes": 100_000,
        "string_bytes": 210_000,
    }

    def prepared_records(followup_block_ms: int):
        items = [
            record(
                1,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": plain,
                    "session_context": plain,
                    "system_prompt": plain,
                },
            ),
            record(
                2,
                "context",
                {
                    "context_usage": None,
                    "message_count": 1,
                    "messages": plain,
                    "model": None,
                },
            ),
            record(
                3,
                "candidate_lifecycle",
                {"detail": None, "phase": "started"},
            ),
            record(
                4,
                "candidate_lifecycle",
                {"detail": None, "phase": "ready"},
            ),
            record(
                5,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": prompt,
                    "session_context": seeded,
                    "system_prompt": SUMMARY,
                },
            ),
            record(
                6,
                "candidate_lifecycle",
                {"detail": None, "phase": "installed"},
            ),
            record(
                7,
                "context",
                {
                    "context_usage": None,
                    "message_count": 4,
                    "messages": visible,
                    "model": None,
                },
            ),
            record(
                8,
                "before_provider_request",
                {"model": None, "payload": visible},
            ),
            record(
                9,
                "session_before_compact",
                {
                    "custom_instructions": False,
                    "first_kept_hash": "kept",
                    "messages_to_summarize": {
                        **SUMMARY,
                        "canaries": [persistent],
                    },
                    "reason": "manual",
                    "tokens_before": 220_000,
                    "turn_prefix": SUMMARY,
                    "will_retry": False,
                },
            ),
            record(
                10,
                "session_compact",
                {
                    "first_kept_hash": "kept",
                    "from_extension": True,
                    "reason": "manual",
                    "summary": {
                        **SUMMARY,
                        "canaries": [persistent],
                        "max_string_bytes": 4_000,
                        "string_bytes": 4_100,
                    },
                    "tokens_before": 220_000,
                    "usage": {
                        "cache_read": 0,
                        "cache_write": 0,
                        "input": 180_000,
                        "output": 4_000,
                        "total_tokens": 184_000,
                    },
                    "will_retry": False,
                },
            ),
            record(
                11,
                "tool_call",
                {
                    "input": SUMMARY,
                    "tool_call_hash": "write-call",
                    "tool_name": "write",
                },
            ),
            record(
                12,
                "tool_result",
                {
                    "content": SUMMARY,
                    "input": SUMMARY,
                    "is_error": False,
                    "tool_call_hash": "write-call",
                    "tool_name": "write",
                },
            ),
        ]
        timestamps = {
            1: "2026-08-24T00:00:00.000Z",
            2: "2026-08-24T00:00:00.010Z",
            3: "2026-08-24T00:00:01.000Z",
            4: "2026-08-24T00:00:50.000Z",
            5: "2026-08-24T00:01:00.000Z",
            6: "2026-08-24T00:01:00.001Z",
            7: f"2026-08-24T00:01:{followup_block_ms / 1_000:06.3f}Z",
        }
        for item in items:
            if item["seq"] in timestamps:
                item["timestamp"] = timestamps[item["seq"]]
        return parse_trace_jsonl(trace(*items))

    hit = analyze_trace(
        prepared_records(100),
        expect_checkpoint=True,
        expect_prepared_checkpoint=True,
    )
    slow = analyze_trace(
        prepared_records(6_000),
        expect_checkpoint=True,
        expect_prepared_checkpoint=True,
    )

    assert hit["invariants"] == {"passed": True, "violations": []}
    assert any(
        item["check"] == "prepared_checkpoint_effective"
        for item in slow["invariants"]["violations"]
    )


def test_rolling_checkpoint_expectation_requires_previous_checkpoint_in_cycle_two() -> (
    None
):
    alpha = "CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M"
    omega = "CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R"
    beta = "CTX_CANARY_CHECKPOINT_PERSIST_BETA_4N8V"
    sigma = "CTX_CANARY_CHECKPOINT_TAIL_SIGMA_6P3D"
    cycle_one = "CTX_CANARY_EXPECT_ROLLING_CHECKPOINT_CYCLE_1_OF_2_BASELINE_MS_54640"
    cycle_two = "CTX_CANARY_EXPECT_ROLLING_CHECKPOINT_CYCLE_2_OF_2_BASELINE_MS_54640"
    plain = {**SUMMARY, "canaries": []}

    def rolling_records(second_summary_canaries: list[str]):
        seed_one = {
            **SUMMARY,
            "canaries": [alpha, omega],
            "max_string_bytes": 100_000,
            "string_bytes": 900_100,
            "type_counts": {"custom_message": 9},
        }
        seed_two = {
            **SUMMARY,
            "canaries": [alpha, beta, sigma],
            "max_string_bytes": 100_000,
            "string_bytes": 1_100_100,
            "type_counts": {"compaction": 1, "custom_message": 9},
        }
        prompt_one = {**SUMMARY, "canaries": [cycle_one]}
        prompt_two = {**SUMMARY, "canaries": [cycle_two]}
        visible_one = {
            **SUMMARY,
            "canaries": [cycle_one, alpha, omega],
            "max_string_bytes": 100_000,
            "string_bytes": 210_000,
        }
        visible_two = {
            **SUMMARY,
            "canaries": [cycle_two, alpha, beta, sigma],
            "max_string_bytes": 100_000,
            "string_bytes": 210_000,
        }
        items = [
            record(
                1,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": plain,
                    "session_context": plain,
                    "system_prompt": plain,
                },
            ),
            record(
                2,
                "context",
                {
                    "context_usage": None,
                    "message_count": 1,
                    "messages": plain,
                    "model": None,
                },
            ),
            record(
                3,
                "candidate_lifecycle",
                {"detail": "fresh prefix", "phase": "started"},
            ),
            record(4, "candidate_lifecycle", {"detail": None, "phase": "ready"}),
            record(
                5,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": prompt_one,
                    "session_context": seed_one,
                    "system_prompt": SUMMARY,
                },
            ),
            record(6, "candidate_lifecycle", {"detail": None, "phase": "installed"}),
            record(
                7,
                "context",
                {
                    "context_usage": None,
                    "message_count": 4,
                    "messages": visible_one,
                    "model": None,
                },
            ),
            record(
                8, "before_provider_request", {"model": None, "payload": visible_one}
            ),
            record(
                9,
                "session_compact",
                {
                    "first_kept_hash": "kept-1",
                    "from_extension": True,
                    "reason": "manual",
                    "summary": {
                        **SUMMARY,
                        "canaries": [alpha],
                        "max_string_bytes": 3_000,
                        "string_bytes": 3_100,
                    },
                    "tokens_before": 220_000,
                    "usage": None,
                    "will_retry": False,
                },
            ),
            record(
                10,
                "candidate_lifecycle",
                {
                    "detail": "includes predecessor checkpoint",
                    "phase": "started",
                },
            ),
            record(11, "candidate_lifecycle", {"detail": None, "phase": "ready"}),
            record(
                12,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": prompt_two,
                    "session_context": seed_two,
                    "system_prompt": SUMMARY,
                },
            ),
            record(13, "candidate_lifecycle", {"detail": None, "phase": "installed"}),
            record(
                14,
                "context",
                {
                    "context_usage": None,
                    "message_count": 4,
                    "messages": visible_two,
                    "model": None,
                },
            ),
            record(
                15, "before_provider_request", {"model": None, "payload": visible_two}
            ),
            record(
                16,
                "session_compact",
                {
                    "first_kept_hash": "kept-2",
                    "from_extension": True,
                    "reason": "manual",
                    "summary": {
                        **SUMMARY,
                        "canaries": second_summary_canaries,
                        "max_string_bytes": 3_000,
                        "string_bytes": 3_100,
                    },
                    "tokens_before": 220_000,
                    "usage": None,
                    "will_retry": False,
                },
            ),
        ]
        timestamps = {
            1: "2026-08-25T00:00:00.000Z",
            2: "2026-08-25T00:00:00.010Z",
            3: "2026-08-25T00:00:01.000Z",
            4: "2026-08-25T00:00:40.000Z",
            5: "2026-08-25T00:00:41.000Z",
            6: "2026-08-25T00:00:41.001Z",
            7: "2026-08-25T00:00:41.010Z",
            10: "2026-08-25T00:00:50.000Z",
            11: "2026-08-25T00:01:30.000Z",
            12: "2026-08-25T00:01:31.000Z",
            13: "2026-08-25T00:01:31.001Z",
            14: "2026-08-25T00:01:31.010Z",
        }
        for item in items:
            if item["seq"] in timestamps:
                item["timestamp"] = timestamps[item["seq"]]
        return parse_trace_jsonl(trace(*items))

    missing_previous = analyze_trace(
        rolling_records([beta]),
        expect_rolling_checkpoint=True,
    )
    rolled = analyze_trace(
        rolling_records([alpha, beta]),
        expect_rolling_checkpoint=True,
    )

    assert any(
        item["check"] == "rolling_checkpoint_effective"
        for item in missing_previous["invariants"]["violations"]
    )
    assert rolled["invariants"] == {"passed": True, "violations": []}


def test_grader_reports_session_change_across_resume_runs() -> None:
    first = record(
        1,
        "context",
        {"context_usage": None, "message_count": 1, "messages": SUMMARY, "model": None},
    )
    second = record(1, "before_provider_request", {"model": None, "payload": SUMMARY})
    second["run_id"] = "run-2"
    second["session_hash"] = "different-session"

    violations = analyze_trace(parse_trace_jsonl(trace(first, second)))["invariants"][
        "violations"
    ]

    assert any(item["check"] == "session_continuity" for item in violations)


def test_grader_reports_missing_current_and_persistent_canaries() -> None:
    missing = {**SUMMARY, "canaries": []}
    records = parse_trace_jsonl(
        trace(
            record(
                1,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": SUMMARY,
                    "system_prompt": SUMMARY,
                },
            ),
            record(
                2,
                "context",
                {
                    "context_usage": None,
                    "message_count": 1,
                    "messages": missing,
                    "model": None,
                },
            ),
        )
    )

    violations = analyze_trace(records)["invariants"]["violations"]
    assert {item["check"] for item in violations} >= {
        "current_input_canary",
        "persistent_canary",
    }


def test_grader_enforces_tools_declared_by_prompt_canaries() -> None:
    prompt = {**SUMMARY, "canaries": ["CTX_CANARY_REQUIRE_TOOL_BASH"]}
    records = parse_trace_jsonl(
        trace(
            record(
                1,
                "before_agent_start",
                {
                    "images": 0,
                    "model": None,
                    "prompt": prompt,
                    "system_prompt": SUMMARY,
                },
            ),
            record(
                2,
                "context",
                {
                    "context_usage": None,
                    "message_count": 1,
                    "messages": prompt,
                    "model": None,
                },
            ),
            record(3, "before_provider_request", {"model": None, "payload": prompt}),
        )
    )

    violations = analyze_trace(records)["invariants"]["violations"]
    assert any(item["check"] == "required_tools" for item in violations)


def test_grader_reports_tool_pair_and_checkpoint_canary_failures() -> None:
    checkpoint_source = {**SUMMARY, "canaries": ["CTX_CANARY_PERSIST_ALPHA"]}
    checkpoint_output = {**SUMMARY, "canaries": []}
    records = parse_trace_jsonl(
        trace(
            record(
                1,
                "tool_result",
                {
                    "content": SUMMARY,
                    "input": SUMMARY,
                    "is_error": False,
                    "tool_call_hash": "orphan",
                    "tool_name": "bash",
                },
            ),
            record(
                2,
                "session_before_compact",
                {
                    "custom_instructions": False,
                    "first_kept_hash": "kept",
                    "messages_to_summarize": checkpoint_source,
                    "reason": "threshold",
                    "tokens_before": 1000,
                    "turn_prefix": {**SUMMARY, "canaries": []},
                    "will_retry": False,
                },
            ),
            record(
                3,
                "session_compact",
                {
                    "first_kept_hash": "kept",
                    "from_extension": False,
                    "reason": "threshold",
                    "summary": checkpoint_output,
                    "tokens_before": 1000,
                    "usage": None,
                    "will_retry": False,
                },
            ),
        )
    )

    violations = analyze_trace(records)["invariants"]["violations"]
    assert {item["check"] for item in violations} >= {
        "checkpoint_canary",
        "tool_pair_integrity",
    }
