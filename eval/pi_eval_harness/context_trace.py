"""Parse and grade privacy-preserving Context Lab probe traces."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

TRACE_SCHEMA = "pi-context-trace.v1"
TRACE_RELATIVE_PATH = Path("pi/context-probe/probe.ndjson")
SPILL_EXPECTATION_CANARY = "CTX_CANARY_EXPECT_SPILL"
SPILL_EXPECTATION_CANARY_PREFIX = "CTX_CANARY_EXPECT_SPILL_BYTES_"
SPILL_PAYLOAD_CANARY = "CTX_CANARY_LARGE_PAYLOAD"
SPILL_LEGACY_EXPECTED_BYTES = 70_000
SPILL_MAX_INLINE_BYTES = 50_000
SPILL_TOOL_NAME = "context_burst"
PRUNE_EXPECTATION_CANARY_PREFIX = "CTX_CANARY_EXPECT_PRUNE_SPILLS_"
PRUNE_MAX_VISIBLE_CHARS = 8_192
CHECKPOINT_EXPECTATION_CANARY_PREFIX = "CTX_CANARY_EXPECT_CHECKPOINT_CHUNKS_"
CHECKPOINT_PERSIST_CANARY = "CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M"
CHECKPOINT_TAIL_CANARY = "CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R"
CHECKPOINT_SECOND_PERSIST_CANARY = "CTX_CANARY_CHECKPOINT_PERSIST_BETA_4N8V"
CHECKPOINT_SECOND_TAIL_CANARY = "CTX_CANARY_CHECKPOINT_TAIL_SIGMA_6P3D"
PREPARED_CHECKPOINT_EXPECTATION_PREFIX = (
    "CTX_CANARY_EXPECT_PREPARED_CHECKPOINT_BASELINE_MS_"
)
ROLLING_CHECKPOINT_EXPECTATION_PREFIX = "CTX_CANARY_EXPECT_ROLLING_CHECKPOINT_CYCLE_"

_ENVELOPE_KEYS = {
    "data",
    "event",
    "leaf_hash",
    "run_id",
    "schema",
    "seq",
    "session_hash",
    "timestamp",
}
_SUMMARY_KEYS = {
    "array_count",
    "binary_bytes",
    "binary_count",
    "canaries",
    "circular_nodes",
    "fingerprint",
    "max_string_bytes",
    "object_count",
    "role_counts",
    "string_bytes",
    "string_count",
    "truncated_nodes",
    "type_counts",
}
_SUMMARY_FIELDS = {
    "content",
    "input",
    "message",
    "messages",
    "messages_to_summarize",
    "payload",
    "prompt",
    "session_context",
    "summary",
    "system_prompt",
    "turn_prefix",
}
_EVENT_FIELDS = {
    "before_agent_start": {"images", "model", "prompt", "system_prompt"},
    "context": {"context_usage", "message_count", "messages", "model"},
    "before_provider_request": {"model", "payload"},
    "candidate_lifecycle": {"detail", "phase"},
    "after_provider_response": {"status"},
    "tool_call": {"input", "tool_call_hash", "tool_name"},
    "tool_result": {
        "content",
        "input",
        "is_error",
        "tool_call_hash",
        "tool_name",
    },
    "session_before_compact": {
        "custom_instructions",
        "first_kept_hash",
        "messages_to_summarize",
        "reason",
        "tokens_before",
        "turn_prefix",
        "will_retry",
    },
    "session_compact": {
        "first_kept_hash",
        "from_extension",
        "reason",
        "summary",
        "tokens_before",
        "usage",
        "will_retry",
    },
    "message_end": {"message", "role", "stop_reason", "usage"},
    "agent_end": {"messages", "usage"},
    "agent_settled": set(),
    "session_shutdown": {"reason"},
    "session_tree": {"new_leaf_hash", "old_leaf_hash"},
    "model_select": {"model", "previous_model", "source"},
}
_OPTIONAL_EVENT_FIELDS = {
    "agent_settled": {"context_management"},
    "before_agent_start": {"context_management", "session_context"},
}
_CONTEXT_MANAGEMENT_STATE_KEYS = {
    "command_registered",
    "config_present",
    "spill_bytes",
    "spill_files",
    "unsafe_entries",
}
_CANDIDATE_LIFECYCLE_PHASES = {
    "started",
    "ready",
    "installed",
    "discarded",
    "failed",
}


class TraceFormatError(ValueError):
    """Raised when a probe trace violates its versioned contract."""


@dataclass(frozen=True)
class TraceRecord:
    run_id: str
    seq: int
    timestamp: str
    event: str
    session_hash: str | None
    leaf_hash: str | None
    data: dict[str, object]


def trace_path(logs_dir: Path) -> Path:
    return logs_dir / TRACE_RELATIVE_PATH


def _require_summary(value: object, line_number: int, field: str) -> None:
    if not isinstance(value, dict) or set(value) != _SUMMARY_KEYS:
        raise TraceFormatError(
            f"line {line_number}: {field} must be a redacted value summary"
        )
    canaries = value.get("canaries")
    if not isinstance(canaries, list) or not all(
        isinstance(item, str) and item.startswith("CTX_CANARY_") for item in canaries
    ):
        raise TraceFormatError(f"line {line_number}: invalid canary list in {field}")
    for counter in ("role_counts", "type_counts"):
        counts = value.get(counter)
        if not isinstance(counts, dict) or not all(
            isinstance(key, str)
            and isinstance(count, int)
            and not isinstance(count, bool)
            and count >= 0
            for key, count in counts.items()
        ):
            raise TraceFormatError(f"line {line_number}: invalid {counter} in {field}")
    for counter in (
        "array_count",
        "binary_bytes",
        "binary_count",
        "circular_nodes",
        "max_string_bytes",
        "object_count",
        "string_bytes",
        "string_count",
        "truncated_nodes",
    ):
        item = value.get(counter)
        if not isinstance(item, int) or isinstance(item, bool) or item < 0:
            raise TraceFormatError(f"line {line_number}: invalid {counter} in {field}")
    fingerprint = value.get("fingerprint")
    if not isinstance(fingerprint, str) or not fingerprint.startswith("sha256:"):
        raise TraceFormatError(f"line {line_number}: invalid fingerprint in {field}")


def _parse_record(value: object, line_number: int) -> TraceRecord:
    if not isinstance(value, dict) or set(value) != _ENVELOPE_KEYS:
        raise TraceFormatError(f"line {line_number}: invalid trace envelope")
    if value.get("schema") != TRACE_SCHEMA:
        raise TraceFormatError(f"line {line_number}: unsupported trace schema")
    event = value.get("event")
    if not isinstance(event, str) or event not in _EVENT_FIELDS:
        raise TraceFormatError(f"line {line_number}: unknown event {event!r}")
    run_id = value.get("run_id")
    seq = value.get("seq")
    timestamp = value.get("timestamp")
    data = value.get("data")
    if not isinstance(run_id, str) or not run_id:
        raise TraceFormatError(f"line {line_number}: run_id must be non-empty")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
        raise TraceFormatError(f"line {line_number}: seq must be a positive integer")
    if not isinstance(timestamp, str) or not timestamp:
        raise TraceFormatError(f"line {line_number}: timestamp must be non-empty")
    required_fields = _EVENT_FIELDS[event]
    allowed_fields = required_fields | _OPTIONAL_EVENT_FIELDS.get(event, set())
    if (
        not isinstance(data, dict)
        or not required_fields.issubset(data)
        or not set(data).issubset(allowed_fields)
    ):
        raise TraceFormatError(f"line {line_number}: invalid fields for event {event}")
    state = data.get("context_management")
    if state is not None:
        if not isinstance(state, dict) or set(state) != _CONTEXT_MANAGEMENT_STATE_KEYS:
            raise TraceFormatError(
                f"line {line_number}: invalid context_management state"
            )
        if not isinstance(state.get("command_registered"), bool) or not isinstance(
            state.get("config_present"), bool
        ):
            raise TraceFormatError(
                f"line {line_number}: invalid context_management booleans"
            )
        for key in ("spill_bytes", "spill_files", "unsafe_entries"):
            item = state.get(key)
            if not isinstance(item, int) or isinstance(item, bool) or item < 0:
                raise TraceFormatError(
                    f"line {line_number}: invalid context_management {key}"
                )
    if event == "candidate_lifecycle":
        phase = data.get("phase")
        detail = data.get("detail")
        if phase not in _CANDIDATE_LIFECYCLE_PHASES:
            raise TraceFormatError(
                f"line {line_number}: invalid candidate lifecycle phase"
            )
        if detail is not None and not isinstance(detail, str):
            raise TraceFormatError(
                f"line {line_number}: invalid candidate lifecycle detail"
            )
    for field in _SUMMARY_FIELDS.intersection(data):
        _require_summary(data[field], line_number, field)
    for field in ("session_hash", "leaf_hash"):
        item = value.get(field)
        if item is not None and not isinstance(item, str):
            raise TraceFormatError(f"line {line_number}: {field} must be text or null")
    return TraceRecord(
        run_id=run_id,
        seq=seq,
        timestamp=timestamp,
        event=event,
        session_hash=value.get("session_hash"),
        leaf_hash=value.get("leaf_hash"),
        data=data,
    )


def parse_trace_jsonl(text: str) -> list[TraceRecord]:
    records: list[TraceRecord] = []
    next_seq: dict[str, int] = {}
    lines = text.splitlines()
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            if line_number == len(lines) and not text.endswith("\n"):
                break
            raise TraceFormatError(f"line {line_number}: invalid JSON") from error
        record = _parse_record(value, line_number)
        expected = next_seq.get(record.run_id, 1)
        if record.seq != expected:
            raise TraceFormatError(
                f"line {line_number}: run {record.run_id!r} expected seq {expected}, "
                f"got {record.seq}"
            )
        next_seq[record.run_id] = expected + 1
        records.append(record)
    return records


def read_trace(logs_dir: Path) -> list[TraceRecord]:
    path = trace_path(logs_dir)
    if not path.exists():
        return []
    return parse_trace_jsonl(path.read_text())


def _canaries(summary: object) -> set[str]:
    if not isinstance(summary, dict):
        return set()
    value = summary.get("canaries")
    return (
        {item for item in value if isinstance(item, str)}
        if isinstance(value, list)
        else set()
    )


def _usage(value: object) -> dict[str, int]:
    if not isinstance(value, dict):
        return {key: 0 for key in ("input", "output", "cache_read", "cache_write")}
    return {
        key: item
        if isinstance(item := value.get(key), int) and not isinstance(item, bool)
        else 0
        for key in ("input", "output", "cache_read", "cache_write")
    }


def _timestamp_millis(value: str) -> int | None:
    try:
        return round(
            datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1_000
        )
    except ValueError:
        return None


def _prune_expectation(canary: str) -> tuple[int, int] | None:
    if not canary.startswith(PRUNE_EXPECTATION_CANARY_PREFIX):
        return None
    suffix = canary.removeprefix(PRUNE_EXPECTATION_CANARY_PREFIX)
    spill_count_text, separator, spill_bytes_text = suffix.partition("_BYTES_")
    if (
        separator == ""
        or not spill_count_text.isdigit()
        or not spill_bytes_text.isdigit()
    ):
        return None
    spill_count = int(spill_count_text)
    spill_bytes = int(spill_bytes_text)
    return (spill_count, spill_bytes) if spill_count > 0 and spill_bytes > 0 else None


def _checkpoint_expectation(canary: str) -> tuple[int, int] | None:
    if not canary.startswith(CHECKPOINT_EXPECTATION_CANARY_PREFIX):
        return None
    suffix = canary.removeprefix(CHECKPOINT_EXPECTATION_CANARY_PREFIX)
    chunks_text, separator, bytes_text = suffix.partition("_BYTES_")
    if separator == "" or not chunks_text.isdigit() or not bytes_text.isdigit():
        return None
    chunks = int(chunks_text)
    bytes_per_chunk = int(bytes_text)
    return (chunks, bytes_per_chunk) if chunks > 0 and bytes_per_chunk > 0 else None


def _prepared_checkpoint_baseline(canary: str) -> int | None:
    if not canary.startswith(PREPARED_CHECKPOINT_EXPECTATION_PREFIX):
        return None
    value = canary.removeprefix(PREPARED_CHECKPOINT_EXPECTATION_PREFIX)
    return int(value) if value.isdigit() and int(value) > 0 else None


def _rolling_checkpoint_expectation(canary: str) -> tuple[int, int, int] | None:
    if not canary.startswith(ROLLING_CHECKPOINT_EXPECTATION_PREFIX):
        return None
    suffix = canary.removeprefix(ROLLING_CHECKPOINT_EXPECTATION_PREFIX)
    cycle_text, separator, remainder = suffix.partition("_OF_")
    total_text, baseline_separator, baseline_text = remainder.partition("_BASELINE_MS_")
    if (
        separator == ""
        or baseline_separator == ""
        or not cycle_text.isdigit()
        or not total_text.isdigit()
        or not baseline_text.isdigit()
    ):
        return None
    cycle = int(cycle_text)
    total = int(total_text)
    baseline = int(baseline_text)
    if not 1 <= cycle <= total or baseline <= 0:
        return None
    return cycle, total, baseline


def summarize_trace(records: list[TraceRecord]) -> dict[str, object]:
    event_counts = Counter(record.event for record in records)
    tool_names: Counter[str] = Counter()
    tool_result_bytes = 0
    max_tool_result_bytes = 0
    tool_errors = 0
    foreground_usage = Counter[str]()
    compaction_usage = Counter[str]()
    reasons: Counter[str] = Counter()
    max_context_bytes = 0
    max_reported_context_tokens = 0
    max_reported_context_percent = 0.0
    max_payload_bytes = 0
    max_summary_bytes = 0
    all_canaries: set[str] = set()
    models: set[str] = set()
    context_management: dict[str, bool | int] = {
        "command_registered": False,
        "config_present": False,
        "observed": False,
        "spill_bytes": 0,
        "spill_files": 0,
        "unsafe_entries": 0,
    }
    candidate_phases: list[str] = []
    candidate_started_millis: dict[str, int] = {}
    candidate_prepare_ms: list[int] = []
    run_start_millis: dict[str, int] = {}
    pending_agent_start_millis: dict[str, int] = {}
    first_context_seen: set[str] = set()
    first_context_ms_by_run: list[int] = []
    context_block_ms_by_agent_start: list[int] = []

    for record in records:
        data = record.data
        timestamp_millis = _timestamp_millis(record.timestamp)
        if record.event == "candidate_lifecycle":
            phase = str(data["phase"])
            candidate_phases.append(phase)
            if phase == "started" and timestamp_millis is not None:
                candidate_started_millis[record.run_id] = timestamp_millis
            elif phase == "ready" and timestamp_millis is not None:
                started = candidate_started_millis.pop(record.run_id, None)
                if started is not None:
                    candidate_prepare_ms.append(max(0, timestamp_millis - started))
            elif phase in {"discarded", "failed"}:
                candidate_started_millis.pop(record.run_id, None)
        if record.event == "before_agent_start" and timestamp_millis is not None:
            if record.run_id not in run_start_millis:
                run_start_millis[record.run_id] = timestamp_millis
            pending_agent_start_millis[record.run_id] = timestamp_millis
        elif record.event == "context" and timestamp_millis is not None:
            pending_start = pending_agent_start_millis.pop(record.run_id, None)
            if pending_start is not None:
                context_block_ms_by_agent_start.append(
                    max(0, timestamp_millis - pending_start)
                )
            if (
                record.run_id in run_start_millis
                and record.run_id not in first_context_seen
            ):
                first_context_seen.add(record.run_id)
                first_context_ms_by_run.append(
                    max(0, timestamp_millis - run_start_millis[record.run_id])
                )
        model = data.get("model")
        if isinstance(model, dict):
            provider = model.get("provider")
            model_id = model.get("id")
            if isinstance(provider, str) and isinstance(model_id, str):
                models.add(f"{provider}/{model_id}")
        for field in _SUMMARY_FIELDS.intersection(data):
            all_canaries.update(_canaries(data[field]))
        state = data.get("context_management")
        if isinstance(state, dict):
            context_management["observed"] = True
            for key in ("command_registered", "config_present"):
                context_management[key] = bool(context_management[key]) or bool(
                    state.get(key)
                )
            for key in ("spill_bytes", "spill_files", "unsafe_entries"):
                item = state.get(key)
                if isinstance(item, int) and not isinstance(item, bool):
                    context_management[key] = max(int(context_management[key]), item)
        if record.event == "context":
            messages = data["messages"]
            if isinstance(messages, dict):
                max_context_bytes = max(
                    max_context_bytes, int(messages["string_bytes"])
                )
            context_usage = data["context_usage"]
            if isinstance(context_usage, dict):
                tokens = context_usage.get("tokens")
                percent = context_usage.get("percent")
                if isinstance(tokens, int) and not isinstance(tokens, bool):
                    max_reported_context_tokens = max(
                        max_reported_context_tokens, tokens
                    )
                if isinstance(percent, (int, float)) and not isinstance(percent, bool):
                    max_reported_context_percent = max(
                        max_reported_context_percent, float(percent)
                    )
        elif record.event == "before_provider_request":
            payload = data["payload"]
            if isinstance(payload, dict):
                max_payload_bytes = max(max_payload_bytes, int(payload["string_bytes"]))
        elif record.event == "tool_result":
            tool_names[str(data["tool_name"])] += 1
            content = data["content"]
            if isinstance(content, dict):
                size = int(content["string_bytes"])
                tool_result_bytes += size
                max_tool_result_bytes = max(max_tool_result_bytes, size)
            tool_errors += int(data["is_error"] is True)
        elif record.event == "message_end" and data["role"] == "assistant":
            foreground_usage.update(_usage(data["usage"]))
        elif record.event == "session_compact":
            reasons[str(data["reason"])] += 1
            compaction_usage.update(_usage(data["usage"]))
            summary = data["summary"]
            if isinstance(summary, dict):
                max_summary_bytes = max(max_summary_bytes, int(summary["string_bytes"]))

    return {
        "schema": TRACE_SCHEMA,
        "records": len(records),
        "runs": len({record.run_id for record in records}),
        "models": sorted(models),
        "sessions": len(
            {
                record.session_hash
                for record in records
                if record.session_hash is not None
            }
        ),
        "event_counts": dict(sorted(event_counts.items())),
        "requests": {
            "contexts": event_counts["context"],
            "provider_requests": event_counts["before_provider_request"],
            "max_context_string_bytes": max_context_bytes,
            "max_payload_string_bytes": max_payload_bytes,
            "max_reported_context_tokens": max_reported_context_tokens,
            "max_reported_context_percent": max_reported_context_percent,
        },
        "latency": {
            "context_block_ms_by_agent_start": context_block_ms_by_agent_start,
            "first_context_ms_by_run": first_context_ms_by_run,
            "max_first_context_ms": max(first_context_ms_by_run, default=0),
        },
        "tools": {
            "calls": event_counts["tool_call"],
            "results": event_counts["tool_result"],
            "errors": tool_errors,
            "result_string_bytes": tool_result_bytes,
            "max_result_string_bytes": max_tool_result_bytes,
            "by_name": dict(sorted(tool_names.items())),
        },
        "compactions": {
            "attempts": event_counts["session_before_compact"],
            "installed": event_counts["session_compact"],
            "by_reason": dict(sorted(reasons.items())),
            "max_summary_string_bytes": max_summary_bytes,
        },
        "foreground_usage": dict(foreground_usage),
        "compaction_usage": dict(compaction_usage),
        "context_management": context_management,
        "candidate_lifecycle": {
            "by_phase": dict(sorted(Counter(candidate_phases).items())),
            "phases": candidate_phases,
            "prepare_ms": candidate_prepare_ms,
        },
        "canaries": sorted(all_canaries),
        "probe_limitations": [
            "context-management custom compactor payload bypasses "
            "before_provider_request",
            "session_before_compact exposes Pi preparation, not an extension-owned "
            "replacement selection",
        ],
    }


def grade_invariants(
    records: list[TraceRecord],
    *,
    expect_spill: bool = False,
    expect_prune: bool = False,
    expect_checkpoint: bool = False,
    expect_prepared_checkpoint: bool = False,
    expect_rolling_checkpoint: bool = False,
) -> list[dict[str, object]]:
    violations: list[dict[str, object]] = []
    current_canaries: dict[str, set[str]] = {}
    persistent: set[str] = set()
    calls: set[tuple[str, str]] = set()
    results: set[tuple[str, str]] = set()
    pending_checkpoint_canaries: set[str] = set()
    required_tools: set[str] = set()
    observed_tools: set[str] = set()
    spill_expected_runs: dict[str, int] = {}
    prune_expected_runs: dict[str, tuple[int, int]] = {}
    checkpoint_expected_runs: dict[str, tuple[int, int, int]] = {}
    prepared_checkpoint_expected_runs: dict[str, tuple[int, int]] = {}
    rolling_checkpoint_expected_runs: dict[str, list[tuple[int, int, int, int]]] = {}

    if not records:
        return [
            {
                "check": "trace_present",
                "event": "trace_end",
                "run_id": None,
                "seq": None,
                "detail": "probe trace is missing or empty",
            }
        ]

    def fail(check: str, record: TraceRecord, detail: str) -> None:
        violations.append(
            {
                "check": check,
                "event": record.event,
                "run_id": record.run_id,
                "seq": record.seq,
                "detail": detail,
            }
        )

    for record in records:
        data = record.data
        if record.event == "before_agent_start":
            prompt_canaries = _canaries(data["prompt"])
            if expect_spill:
                spill_expectations = {
                    int(suffix)
                    for canary in prompt_canaries
                    if canary.startswith(SPILL_EXPECTATION_CANARY_PREFIX)
                    and (
                        suffix := canary.removeprefix(SPILL_EXPECTATION_CANARY_PREFIX)
                    ).isdigit()
                    and int(suffix) > 0
                }
                if SPILL_EXPECTATION_CANARY in prompt_canaries:
                    spill_expectations.add(SPILL_LEGACY_EXPECTED_BYTES)
                if len(spill_expectations) > 1:
                    fail(
                        "spill_effective",
                        record,
                        "conflicting spill byte expectations "
                        f"{sorted(spill_expectations)!r}",
                    )
                elif spill_expectations:
                    spill_expected_runs[record.run_id] = next(iter(spill_expectations))
            if expect_prune:
                prune_expectations = {
                    expectation
                    for canary in prompt_canaries
                    if (expectation := _prune_expectation(canary)) is not None
                }
                if len(prune_expectations) > 1:
                    fail(
                        "prune_effective",
                        record,
                        "conflicting prune expectations "
                        f"{sorted(prune_expectations)!r}",
                    )
                elif prune_expectations:
                    prune_expected_runs[record.run_id] = next(iter(prune_expectations))
            if expect_checkpoint:
                checkpoint_expectations = {
                    expectation
                    for canary in prompt_canaries
                    if (expectation := _checkpoint_expectation(canary)) is not None
                }
                if len(checkpoint_expectations) > 1:
                    fail(
                        "checkpoint_effective",
                        record,
                        "conflicting checkpoint expectations "
                        f"{sorted(checkpoint_expectations)!r}",
                    )
                elif checkpoint_expectations:
                    chunks, bytes_per_chunk = next(iter(checkpoint_expectations))
                    checkpoint_expected_runs[record.run_id] = (
                        chunks,
                        bytes_per_chunk,
                        record.seq,
                    )
            if expect_prepared_checkpoint:
                prepared_baselines = {
                    baseline
                    for canary in prompt_canaries
                    if (baseline := _prepared_checkpoint_baseline(canary)) is not None
                }
                if len(prepared_baselines) > 1:
                    fail(
                        "prepared_checkpoint_effective",
                        record,
                        "conflicting prepared checkpoint baselines "
                        f"{sorted(prepared_baselines)!r}",
                    )
                elif prepared_baselines:
                    prepared_checkpoint_expected_runs[record.run_id] = (
                        next(iter(prepared_baselines)),
                        record.seq,
                    )
            if expect_rolling_checkpoint:
                rolling_expectations = {
                    expectation
                    for canary in prompt_canaries
                    if (expectation := _rolling_checkpoint_expectation(canary))
                    is not None
                }
                if len(rolling_expectations) > 1:
                    fail(
                        "rolling_checkpoint_effective",
                        record,
                        "conflicting rolling checkpoint expectations "
                        f"{sorted(rolling_expectations)!r}",
                    )
                elif rolling_expectations:
                    cycle, total, baseline = next(iter(rolling_expectations))
                    rolling_checkpoint_expected_runs.setdefault(
                        record.run_id, []
                    ).append((cycle, total, baseline, record.seq))
            current_canaries[record.run_id] = prompt_canaries
            persistent.update(
                canary
                for canary in prompt_canaries
                if canary.startswith("CTX_CANARY_PERSIST_")
            )
            required_tools.update(
                canary.removeprefix("CTX_CANARY_REQUIRE_TOOL_").lower()
                for canary in prompt_canaries
                if canary.startswith("CTX_CANARY_REQUIRE_TOOL_")
            )
        elif record.event in {"context", "before_provider_request"}:
            summary = data["messages"] if record.event == "context" else data["payload"]
            visible = _canaries(summary)
            required = current_canaries.get(record.run_id, set())
            missing_current = required.difference(visible)
            if missing_current:
                fail(
                    "current_input_canary",
                    record,
                    f"missing {sorted(missing_current)!r}",
                )
            missing_persistent = persistent.difference(visible)
            if missing_persistent:
                fail(
                    "persistent_canary",
                    record,
                    f"missing {sorted(missing_persistent)!r}",
                )
        elif record.event == "tool_call":
            observed_tools.add(str(data["tool_name"]))
            call_hash = data["tool_call_hash"]
            if isinstance(call_hash, str):
                calls.add((record.run_id, call_hash))
        elif record.event == "tool_result":
            call_hash = data["tool_call_hash"]
            if not isinstance(call_hash, str):
                continue
            key = (record.run_id, call_hash)
            if key not in calls:
                fail("tool_pair_integrity", record, "result has no observed call")
            if key in results:
                fail("tool_pair_integrity", record, "duplicate result")
            results.add(key)
        elif record.event == "session_before_compact":
            source_canaries = _canaries(data["messages_to_summarize"])
            pending_checkpoint_canaries = {
                item
                for item in source_canaries
                if item.startswith("CTX_CANARY_PERSIST_")
            }
        elif record.event == "session_compact":
            if data["from_extension"] is not True:
                visible = _canaries(data["summary"])
                missing = pending_checkpoint_canaries.difference(visible)
                if missing:
                    fail("checkpoint_canary", record, f"missing {sorted(missing)!r}")
            pending_checkpoint_canaries = set()

    for run_id, call_hash in sorted(calls.difference(results)):
        violations.append(
            {
                "check": "tool_pair_integrity",
                "event": "trace_end",
                "run_id": run_id,
                "seq": None,
                "detail": f"call {call_hash} has no observed result",
            }
        )
    event_names = {record.event for record in records}
    missing_tools = required_tools.difference(observed_tools)
    if missing_tools:
        violations.append(
            {
                "check": "required_tools",
                "event": "trace_end",
                "run_id": None,
                "seq": None,
                "detail": f"missing required tools {sorted(missing_tools)!r}",
            }
        )
    session_hashes = {
        record.session_hash for record in records if record.session_hash is not None
    }
    if len(session_hashes) > 1:
        violations.append(
            {
                "check": "session_continuity",
                "event": "trace_end",
                "run_id": None,
                "seq": None,
                "detail": f"trace contains {len(session_hashes)} session identities",
            }
        )
    for required_event, check in (
        ("context", "context_observed"),
        ("before_provider_request", "provider_request_observed"),
    ):
        if required_event not in event_names:
            violations.append(
                {
                    "check": check,
                    "event": "trace_end",
                    "run_id": None,
                    "seq": None,
                    "detail": f"no {required_event} event was observed",
                }
            )
    for run_id, expected_spill_bytes in sorted(spill_expected_runs.items()):
        run_records = [record for record in records if record.run_id == run_id]
        anchor = run_records[-1]
        states = [
            state
            for record in run_records
            if isinstance(state := record.data.get("context_management"), dict)
        ]
        command_registered = any(
            state.get("command_registered") is True for state in states
        )
        config_present = any(state.get("config_present") is True for state in states)
        spill_files = max(
            (int(state["spill_files"]) for state in states),
            default=0,
        )
        spill_bytes = max(
            (int(state["spill_bytes"]) for state in states),
            default=0,
        )
        unsafe_entries = max(
            (int(state["unsafe_entries"]) for state in states),
            default=0,
        )
        if not command_registered or not config_present:
            fail(
                "spill_effective",
                anchor,
                "context-management command or config was not observed",
            )
        if (
            spill_files != 1
            or spill_bytes != expected_spill_bytes
            or unsafe_entries != 0
        ):
            fail(
                "spill_effective",
                anchor,
                f"expected one safe {expected_spill_bytes}-byte spill artifact; "
                f"observed files={spill_files}, bytes={spill_bytes}, "
                f"unsafe_entries={unsafe_entries}",
            )

        burst_results = [
            record
            for record in run_records
            if record.event == "tool_result"
            and record.data.get("tool_name") == SPILL_TOOL_NAME
            and SPILL_PAYLOAD_CANARY in _canaries(record.data.get("content"))
        ]
        if len(burst_results) != 1:
            fail(
                "spill_effective",
                anchor,
                f"expected one canary-bearing {SPILL_TOOL_NAME} result; "
                f"observed {len(burst_results)}",
            )
            continue
        burst_result = burst_results[0]
        content = burst_result.data["content"]
        if (
            isinstance(content, dict)
            and int(content["max_string_bytes"]) > SPILL_MAX_INLINE_BYTES
        ):
            fail(
                "spill_effective",
                burst_result,
                "model-visible tool result exceeds the 50000-byte spill cap",
            )

        later_surfaces = [
            record
            for record in run_records
            if record.seq > burst_result.seq
            and record.event in {"context", "before_provider_request"}
        ]
        if not any(
            record.event == "before_provider_request" for record in later_surfaces
        ):
            fail(
                "spill_effective",
                anchor,
                "no provider request was observed after the spilled tool result",
            )
        for record in later_surfaces:
            summary = (
                record.data["messages"]
                if record.event == "context"
                else record.data["payload"]
            )
            if (
                isinstance(summary, dict)
                and int(summary["max_string_bytes"]) > SPILL_MAX_INLINE_BYTES
            ):
                fail(
                    "spill_effective",
                    record,
                    "a post-spill model surface still contains a string over "
                    "50000 bytes",
                )
    for run_id, (expected_spill_files, expected_spill_bytes) in sorted(
        prune_expected_runs.items()
    ):
        run_records = [record for record in records if record.run_id == run_id]
        anchor = run_records[-1]
        states = [
            state
            for record in run_records
            if isinstance(state := record.data.get("context_management"), dict)
        ]
        command_registered = any(
            state.get("command_registered") is True for state in states
        )
        config_present = any(state.get("config_present") is True for state in states)
        spill_files = max(
            (int(state["spill_files"]) for state in states),
            default=0,
        )
        spill_bytes = max(
            (int(state["spill_bytes"]) for state in states),
            default=0,
        )
        unsafe_entries = max(
            (int(state["unsafe_entries"]) for state in states),
            default=0,
        )
        expected_total_bytes = expected_spill_files * expected_spill_bytes
        if not command_registered or not config_present:
            fail(
                "prune_effective",
                anchor,
                "context-management command or config was not observed",
            )
        if (
            spill_files != expected_spill_files
            or spill_bytes != expected_total_bytes
            or unsafe_entries != 0
        ):
            fail(
                "prune_effective",
                anchor,
                f"expected {expected_spill_files} safe {expected_spill_bytes}-byte "
                f"spill artifacts; observed files={spill_files}, bytes={spill_bytes}, "
                f"unsafe_entries={unsafe_entries}",
            )

        burst_results = [
            record
            for record in run_records
            if record.event == "tool_result"
            and record.data.get("tool_name") == SPILL_TOOL_NAME
        ]
        if len(burst_results) != expected_spill_files:
            fail(
                "prune_effective",
                anchor,
                f"expected {expected_spill_files} {SPILL_TOOL_NAME} results; "
                f"observed {len(burst_results)}",
            )
            continue
        for record in burst_results:
            content = record.data["content"]
            if (
                isinstance(content, dict)
                and int(content["max_string_bytes"]) > SPILL_MAX_INLINE_BYTES
            ):
                fail(
                    "prune_effective",
                    record,
                    "a burst result exceeded the 50000-byte spill cap",
                )

        final_burst_seq = max(record.seq for record in burst_results)
        later_surfaces = [
            record
            for record in run_records
            if record.seq > final_burst_seq
            and record.event in {"context", "before_provider_request"}
        ]
        if not any(record.event == "context" for record in later_surfaces) or not any(
            record.event == "before_provider_request" for record in later_surfaces
        ):
            fail(
                "prune_effective",
                anchor,
                "context and provider request were not both observed after final burst",
            )
        for record in later_surfaces:
            summary = (
                record.data["messages"]
                if record.event == "context"
                else record.data["payload"]
            )
            if (
                isinstance(summary, dict)
                and int(summary["max_string_bytes"]) > PRUNE_MAX_VISIBLE_CHARS
            ):
                fail(
                    "prune_effective",
                    record,
                    "a post-pressure model surface still contains a string over "
                    "8192 bytes",
                )
        if any(record.event == "session_compact" for record in run_records):
            fail(
                "prune_effective",
                anchor,
                "pressure scenario installed a compaction instead of resolving "
                "by prune",
            )
    for run_id, (
        expected_chunks,
        expected_bytes_per_chunk,
        expectation_start_seq,
    ) in sorted(checkpoint_expected_runs.items()):
        run_records = [record for record in records if record.run_id == run_id]
        anchor = run_records[-1]
        session_hashes = {
            record.session_hash
            for record in run_records
            if record.session_hash is not None
        }
        session_records = [
            record
            for record in records
            if not session_hashes or record.session_hash in session_hashes
        ]
        start_record = next(
            (
                record
                for record in run_records
                if record.event == "before_agent_start"
                and record.seq == expectation_start_seq
            ),
            anchor,
        )
        seeded_session = start_record.data.get("session_context")
        if not isinstance(seeded_session, dict):
            fail(
                "checkpoint_effective",
                start_record,
                "pre-compaction session context was not observed",
            )
        else:
            type_counts = seeded_session.get("type_counts")
            custom_messages = (
                type_counts.get("custom_message", 0)
                if isinstance(type_counts, dict)
                else 0
            )
            if custom_messages != expected_chunks:
                fail(
                    "checkpoint_effective",
                    start_record,
                    f"expected {expected_chunks} seeded custom messages; "
                    f"observed {custom_messages}",
                )
            if int(seeded_session["max_string_bytes"]) != expected_bytes_per_chunk:
                fail(
                    "checkpoint_effective",
                    start_record,
                    f"seeded messages are not exactly {expected_bytes_per_chunk} bytes",
                )
            expected_seed_bytes = expected_chunks * expected_bytes_per_chunk
            if int(seeded_session["string_bytes"]) < expected_seed_bytes:
                fail(
                    "checkpoint_effective",
                    start_record,
                    f"seeded session contains fewer than {expected_seed_bytes} bytes",
                )
            seed_canaries = _canaries(seeded_session)
            for canary in (CHECKPOINT_PERSIST_CANARY, CHECKPOINT_TAIL_CANARY):
                if canary not in seed_canaries:
                    fail(
                        "checkpoint_effective",
                        start_record,
                        f"seeded history is missing {canary}",
                    )

        compactions = [
            record for record in session_records if record.event == "session_compact"
        ]
        if len(compactions) != 1:
            fail(
                "checkpoint_effective",
                anchor,
                f"expected one installed checkpoint; observed {len(compactions)}",
            )
            continue
        compaction = compactions[0]
        if compaction.data.get("from_extension") is not True:
            fail(
                "checkpoint_effective",
                compaction,
                "installed checkpoint was not produced by context-management",
            )
        summary_canaries = _canaries(compaction.data.get("summary"))
        if CHECKPOINT_PERSIST_CANARY not in summary_canaries:
            fail(
                "checkpoint_effective",
                compaction,
                f"checkpoint summary is missing {CHECKPOINT_PERSIST_CANARY}",
            )
        if CHECKPOINT_TAIL_CANARY in summary_canaries:
            fail(
                "checkpoint_effective",
                compaction,
                "checkpoint summary absorbed the protected-tail canary",
            )

        forbidden_tools = {
            str(record.data.get("tool_name"))
            for record in run_records
            if record.event == "tool_call"
            and record.seq > expectation_start_seq
            and record.data.get("tool_name") != "write"
        }
        if forbidden_tools:
            fail(
                "checkpoint_effective",
                anchor,
                f"checkpoint recall used forbidden tools {sorted(forbidden_tools)!r}",
            )

        visible_surfaces = [
            record
            for record in run_records
            if record.seq > expectation_start_seq
            and record.event in {"context", "before_provider_request"}
        ]
        if not visible_surfaces:
            fail(
                "checkpoint_effective",
                anchor,
                "no post-checkpoint model surface was observed",
            )
        for record in visible_surfaces:
            summary = (
                record.data["messages"]
                if record.event == "context"
                else record.data["payload"]
            )
            visible_canaries = _canaries(summary)
            missing = {
                CHECKPOINT_PERSIST_CANARY,
                CHECKPOINT_TAIL_CANARY,
            }.difference(visible_canaries)
            if missing:
                fail(
                    "checkpoint_effective",
                    record,
                    f"post-checkpoint surface is missing {sorted(missing)!r}",
                )
    for run_id, (baseline_ms, expectation_start_seq) in sorted(
        prepared_checkpoint_expected_runs.items()
    ):
        run_records = [record for record in records if record.run_id == run_id]
        anchor = run_records[-1]
        lifecycle = [
            record for record in run_records if record.event == "candidate_lifecycle"
        ]
        phases = [str(record.data.get("phase")) for record in lifecycle]
        if any(phase in {"failed", "discarded"} for phase in phases):
            fail(
                "prepared_checkpoint_effective",
                anchor,
                f"candidate lifecycle contains terminal failure {phases!r}",
            )
        try:
            started_index = phases.index("started")
            ready_index = phases.index("ready", started_index + 1)
            installed_index = phases.index("installed", ready_index + 1)
        except ValueError:
            fail(
                "prepared_checkpoint_effective",
                anchor,
                f"candidate lifecycle is not started → ready → installed: {phases!r}",
            )
            continue

        start_record = next(
            (
                record
                for record in run_records
                if record.event == "before_agent_start"
                and record.seq == expectation_start_seq
            ),
            anchor,
        )
        first_context = next(
            (
                record
                for record in run_records
                if record.event == "context" and record.seq > expectation_start_seq
            ),
            None,
        )
        ready_record = lifecycle[ready_index]
        installed_record = lifecycle[installed_index]
        if ready_record.seq >= expectation_start_seq:
            fail(
                "prepared_checkpoint_effective",
                ready_record,
                "candidate was not ready before the pressure follow-up",
            )
        if first_context is None or not (
            expectation_start_seq < installed_record.seq < first_context.seq
        ):
            fail(
                "prepared_checkpoint_effective",
                installed_record,
                "ready candidate was not installed at the pressure context boundary",
            )

        start_millis = _timestamp_millis(start_record.timestamp)
        context_millis = (
            None
            if first_context is None
            else _timestamp_millis(first_context.timestamp)
        )
        if start_millis is None or context_millis is None:
            fail(
                "prepared_checkpoint_effective",
                anchor,
                "prepared checkpoint latency timestamps are unavailable",
            )
        else:
            blocking_ms = max(0, context_millis - start_millis)
            limit_ms = max(1, baseline_ms // 10)
            if blocking_ms >= limit_ms:
                fail(
                    "prepared_checkpoint_effective",
                    first_context,
                    f"pressure blocking {blocking_ms}ms is not below {limit_ms}ms",
                )
    for run_id, raw_expectations in sorted(rolling_checkpoint_expected_runs.items()):
        expectations = sorted(raw_expectations)
        run_records = [record for record in records if record.run_id == run_id]
        anchor = run_records[-1]
        totals = {total for _cycle, total, _baseline, _seq in expectations}
        expected_total = next(iter(totals)) if len(totals) == 1 else 0
        expected_cycles = list(range(1, expected_total + 1))
        observed_cycles = [cycle for cycle, _total, _baseline, _seq in expectations]
        if expected_total == 0 or observed_cycles != expected_cycles:
            fail(
                "rolling_checkpoint_effective",
                anchor,
                f"rolling cycle expectations are incomplete: {observed_cycles!r}",
            )
            continue

        lifecycle = [
            record for record in run_records if record.event == "candidate_lifecycle"
        ]
        if any(
            record.data.get("phase") in {"failed", "discarded"} for record in lifecycle
        ):
            fail(
                "rolling_checkpoint_effective",
                anchor,
                "rolling candidate lifecycle contains failed or discarded",
            )
        compactions = [
            record for record in run_records if record.event == "session_compact"
        ]
        if len(compactions) != expected_total:
            fail(
                "rolling_checkpoint_effective",
                anchor,
                f"expected {expected_total} installed checkpoints; "
                f"observed {len(compactions)}",
            )
            continue

        previous_installed_seq = 0
        for index, (cycle, _total, baseline_ms, start_seq) in enumerate(expectations):
            next_start_seq = (
                expectations[index + 1][3] if index + 1 < len(expectations) else 1 << 30
            )
            start_record = next(
                (
                    record
                    for record in run_records
                    if record.event == "before_agent_start" and record.seq == start_seq
                ),
                anchor,
            )
            ready_candidates = [
                record
                for record in lifecycle
                if record.data.get("phase") == "ready"
                and previous_installed_seq < record.seq < start_seq
            ]
            ready_record = ready_candidates[-1] if ready_candidates else None
            started_candidates = [
                record
                for record in lifecycle
                if record.data.get("phase") == "started"
                and previous_installed_seq < record.seq
                and (ready_record is None or record.seq < ready_record.seq)
            ]
            first_context = next(
                (
                    record
                    for record in run_records
                    if record.event == "context"
                    and start_seq < record.seq < next_start_seq
                ),
                None,
            )
            installed_record = next(
                (
                    record
                    for record in lifecycle
                    if record.data.get("phase") == "installed"
                    and start_seq < record.seq
                    and (first_context is None or record.seq < first_context.seq)
                ),
                None,
            )
            if (
                not started_candidates
                or ready_record is None
                or installed_record is None
            ):
                fail(
                    "rolling_checkpoint_effective",
                    start_record,
                    f"cycle {cycle} is missing started/ready/installed lifecycle",
                )
                continue
            started_record = started_candidates[-1]
            expected_started_detail = (
                "fresh prefix" if cycle == 1 else "includes predecessor checkpoint"
            )
            if started_record.data.get("detail") != expected_started_detail:
                fail(
                    "rolling_checkpoint_effective",
                    started_record,
                    f"cycle {cycle} started without {expected_started_detail!r}",
                )
            previous_installed_seq = installed_record.seq

            start_millis = _timestamp_millis(start_record.timestamp)
            context_millis = (
                None
                if first_context is None
                else _timestamp_millis(first_context.timestamp)
            )
            if start_millis is None or context_millis is None:
                fail(
                    "rolling_checkpoint_effective",
                    start_record,
                    f"cycle {cycle} latency timestamps are unavailable",
                )
            else:
                blocking_ms = max(0, context_millis - start_millis)
                limit_ms = max(1, baseline_ms // 10)
                if blocking_ms >= limit_ms:
                    fail(
                        "rolling_checkpoint_effective",
                        first_context or start_record,
                        f"cycle {cycle} blocking {blocking_ms}ms is not below "
                        f"{limit_ms}ms",
                    )

            compaction = compactions[cycle - 1]
            if compaction.data.get("from_extension") is not True:
                fail(
                    "rolling_checkpoint_effective",
                    compaction,
                    f"cycle {cycle} checkpoint was not produced by context-management",
                )
            summary_canaries = _canaries(compaction.data.get("summary"))
            required_summary = (
                {CHECKPOINT_PERSIST_CANARY}
                if cycle == 1
                else {CHECKPOINT_PERSIST_CANARY, CHECKPOINT_SECOND_PERSIST_CANARY}
            )
            missing_summary = required_summary.difference(summary_canaries)
            if missing_summary:
                fail(
                    "rolling_checkpoint_effective",
                    compaction,
                    f"cycle {cycle} summary is missing {sorted(missing_summary)!r}",
                )
            forbidden_tail = (
                CHECKPOINT_TAIL_CANARY if cycle == 1 else CHECKPOINT_SECOND_TAIL_CANARY
            )
            if forbidden_tail in summary_canaries:
                fail(
                    "rolling_checkpoint_effective",
                    compaction,
                    f"cycle {cycle} summary absorbed protected tail {forbidden_tail}",
                )

            visible_required = (
                {CHECKPOINT_PERSIST_CANARY, CHECKPOINT_TAIL_CANARY}
                if cycle == 1
                else {
                    CHECKPOINT_PERSIST_CANARY,
                    CHECKPOINT_SECOND_PERSIST_CANARY,
                    CHECKPOINT_SECOND_TAIL_CANARY,
                }
            )
            cycle_surfaces = [
                record
                for record in run_records
                if start_seq < record.seq < next_start_seq
                and record.event in {"context", "before_provider_request"}
            ]
            for record in cycle_surfaces:
                summary = (
                    record.data["messages"]
                    if record.event == "context"
                    else record.data["payload"]
                )
                missing_visible = visible_required.difference(_canaries(summary))
                if missing_visible:
                    fail(
                        "rolling_checkpoint_effective",
                        record,
                        f"cycle {cycle} surface is missing {sorted(missing_visible)!r}",
                    )
    return violations


def analyze_trace(
    records: list[TraceRecord],
    *,
    expect_spill: bool = False,
    expect_prune: bool = False,
    expect_checkpoint: bool = False,
    expect_prepared_checkpoint: bool = False,
    expect_rolling_checkpoint: bool = False,
) -> dict[str, object]:
    violations = grade_invariants(
        records,
        expect_spill=expect_spill,
        expect_prune=expect_prune,
        expect_checkpoint=expect_checkpoint,
        expect_prepared_checkpoint=expect_prepared_checkpoint,
        expect_rolling_checkpoint=expect_rolling_checkpoint,
    )
    return {
        "summary": summarize_trace(records),
        "invariants": {"passed": not violations, "violations": violations},
    }
