"""Aggregate repeated Context Lab trials across Harbor jobs."""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from statistics import mean, median
from typing import cast

from pi_eval_harness.context_trace import analyze_trace, read_trace, trace_path


def _mapping(value: object) -> dict[str, object]:
    return cast(dict[str, object], value) if isinstance(value, dict) else {}


def _number(value: object) -> int | float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    return None


def _distribution(values: list[int | float]) -> dict[str, int | float]:
    ordered = sorted(values)
    if not ordered:
        return {"count": 0}
    p95_index = max(0, math.ceil(len(ordered) * 0.95) - 1)
    return {
        "count": len(ordered),
        "min": ordered[0],
        "median": median(ordered),
        "mean": round(mean(ordered), 3),
        "p95": ordered[p95_index],
        "max": ordered[-1],
    }


def _duration_ms(started_at: object, finished_at: object) -> int | None:
    if not isinstance(started_at, str) or not isinstance(finished_at, str):
        return None
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        finish = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, round((finish - start).total_seconds() * 1000))


def _agent_results(result: dict[str, object]) -> list[dict[str, object]]:
    top_level = result.get("agent_result")
    if isinstance(top_level, dict):
        return [cast(dict[str, object], top_level)]
    step_results = result.get("step_results")
    if not isinstance(step_results, list):
        return []
    agents: list[dict[str, object]] = []
    for step in step_results:
        agent_result = _mapping(_mapping(step).get("agent_result"))
        if agent_result:
            agents.append(agent_result)
    return agents


def _metadata(
    result: dict[str, object], agent_results: list[dict[str, object]]
) -> dict[str, object]:
    if agent_results:
        metadata = _mapping(agent_results[-1].get("metadata"))
        if metadata:
            return metadata
    agent = _mapping(_mapping(result.get("config")).get("agent"))
    return _mapping(agent.get("kwargs"))


def _usage(agent_results: list[dict[str, object]]) -> dict[str, int | float]:
    fields = {
        "input_tokens": "n_input_tokens",
        "cache_tokens": "n_cache_tokens",
        "output_tokens": "n_output_tokens",
        "cost_usd": "cost_usd",
    }
    usage: dict[str, int | float] = {}
    for output_name, source_name in fields.items():
        values = [
            item
            for agent_result in agent_results
            if (item := _number(agent_result.get(source_name))) is not None
        ]
        if values:
            usage[output_name] = sum(values)
    return usage


def _reward(result: dict[str, object]) -> int | float | None:
    verifier = _mapping(result.get("verifier_result"))
    return _number(_mapping(verifier.get("rewards")).get("reward"))


def _has_exception(result: dict[str, object]) -> bool:
    if result.get("exception_info") is not None:
        return True
    steps = result.get("step_results")
    return isinstance(steps, list) and any(
        _mapping(step).get("exception_info") is not None for step in steps
    )


def _exception(result: dict[str, object]) -> tuple[str, str] | None:
    candidates = [result.get("exception_info")]
    steps = result.get("step_results")
    if isinstance(steps, list):
        candidates.extend(_mapping(step).get("exception_info") for step in steps)
    for candidate in candidates:
        info = _mapping(candidate)
        exception_type = info.get("exception_type")
        message = info.get("exception_message")
        if isinstance(exception_type, str) and isinstance(message, str):
            return exception_type, message
    return None


def _infrastructure_failure(result: dict[str, object]) -> tuple[str, str] | None:
    exception = _exception(result)
    if exception is None:
        return None
    exception_type, message = exception
    if exception_type == "AgentSetupTimeoutError":
        return exception_type, "agent setup timeout"
    if (
        exception_type == "NonZeroAgentExitCodeError"
        and result.get("agent_execution") is None
        and (
            "gnutls_handshake() failed" in message
            or "Failed to clone nvm repo" in message
        )
    ):
        return exception_type, "agent setup network failure"
    if (
        exception_type == "NonZeroAgentExitCodeError"
        and "Exceeded recoverable model stream error limit" in message
    ):
        if "503" in message or "Endpoint is unavailable" in message:
            return exception_type, "provider temporarily unavailable"
        return exception_type, "provider stream recovery exhausted"
    return None


def _trace_logs_dir(trial_dir: Path, result: dict[str, object]) -> Path:
    top_level = trial_dir / "agent"
    if trace_path(top_level).is_file():
        return top_level
    steps = result.get("step_results")
    if isinstance(steps, list):
        for step in reversed(steps):
            step_name = _mapping(step).get("step_name")
            if not isinstance(step_name, str) or not step_name:
                continue
            candidate = trial_dir / "steps" / step_name / "agent"
            if trace_path(candidate).is_file():
                return candidate
    return top_level


def _trial(
    trial_dir: Path,
    *,
    expect_model: str | None,
) -> tuple[dict[str, object], list[dict[str, object]]]:
    result = cast(
        dict[str, object], json.loads((trial_dir / "result.json").read_text())
    )
    agent_results = _agent_results(result)
    metadata = _metadata(result, agent_results)
    config_agent = _mapping(_mapping(result.get("config")).get("agent"))
    config_kwargs = _mapping(config_agent.get("kwargs"))
    variant = metadata.get("eval_variant", config_kwargs.get("eval_variant"))
    if not isinstance(variant, str) or not variant:
        variant = "unknown"
    model = metadata.get("model", config_agent.get("model_name"))
    if not isinstance(model, str):
        model = "unknown"

    analysis = analyze_trace(
        read_trace(_trace_logs_dir(trial_dir, result)),
        expect_spill=bool(metadata.get("context_trace_expect_spill")),
        expect_prune=bool(metadata.get("context_trace_expect_prune")),
        expect_checkpoint=bool(metadata.get("context_trace_expect_checkpoint")),
        expect_prepared_checkpoint=bool(
            metadata.get("context_trace_expect_prepared_checkpoint")
        ),
        expect_rolling_checkpoint=bool(
            metadata.get("context_trace_expect_rolling_checkpoint")
        ),
    )
    trace_invariants = _mapping(analysis.get("invariants"))
    trace_summary = _mapping(analysis.get("summary"))
    reward = _reward(result)
    has_exception = _has_exception(result)
    infrastructure_failure = _infrastructure_failure(result)
    trace_passed = trace_invariants.get("passed") is True
    passed = reward == 1 and not has_exception and trace_passed
    if infrastructure_failure is not None:
        outcome = "infrastructure_failure"
        failure_kind = infrastructure_failure[1]
    elif passed:
        outcome = "passed"
        failure_kind = None
    else:
        outcome = "product_failure"
        failure_kind = None
    name = result.get("trial_name")
    if not isinstance(name, str):
        name = trial_dir.name

    violations: list[dict[str, object]] = []
    if expect_model is not None and model != expect_model:
        violations.append(
            {
                "check": "model",
                "trial": name,
                "detail": f"expected {expect_model!r}, observed {model!r}",
            }
        )
    if infrastructure_failure is None and not passed:
        violations.append(
            {
                "check": "trial_passed",
                "trial": name,
                "detail": (
                    f"reward={reward!r}, exception={has_exception}, "
                    f"trace_passed={trace_passed}"
                ),
            }
        )

    latency = _mapping(trace_summary.get("latency"))
    context_blocks = latency.get("context_block_ms_by_agent_start")
    if not isinstance(context_blocks, list):
        context_blocks = []
    compactions = _mapping(trace_summary.get("compactions"))
    lifecycle = _mapping(trace_summary.get("candidate_lifecycle"))
    phases = lifecycle.get("phases")
    if not isinstance(phases, list):
        phases = []
    candidate_prepare_ms = lifecycle.get("prepare_ms")
    if not isinstance(candidate_prepare_ms, list):
        candidate_prepare_ms = []

    return (
        {
            "name": name,
            "task": result.get("task_name"),
            "variant": variant,
            "model": model,
            "passed": passed,
            "outcome": outcome,
            "failure_kind": failure_kind,
            "reward": reward,
            "duration_ms": _duration_ms(
                result.get("started_at"), result.get("finished_at")
            ),
            "usage": _usage(agent_results),
            "context_block_ms_by_agent_start": context_blocks,
            "compactions_installed": compactions.get("installed", 0),
            "max_summary_string_bytes": compactions.get("max_summary_string_bytes", 0),
            "candidate_lifecycle": phases,
            "candidate_prepare_ms": candidate_prepare_ms,
        },
        violations,
    )


def _group_summary(trials: list[dict[str, object]]) -> dict[str, object]:
    valid_trials = [
        trial for trial in trials if trial["outcome"] != "infrastructure_failure"
    ]
    infrastructure_trials = [
        trial for trial in trials if trial["outcome"] == "infrastructure_failure"
    ]
    context_blocks: defaultdict[int, list[int | float]] = defaultdict(list)
    candidate_prepare_ms: defaultdict[int, list[int | float]] = defaultdict(list)
    lifecycle_counts: Counter[str] = Counter()
    for trial in valid_trials:
        blocks = trial["context_block_ms_by_agent_start"]
        if isinstance(blocks, list):
            for index, value in enumerate(blocks):
                number = _number(value)
                if number is not None:
                    context_blocks[index].append(number)
        phases = trial["candidate_lifecycle"]
        if isinstance(phases, list) and phases:
            lifecycle_counts[" → ".join(str(phase) for phase in phases)] += 1
        prepare_durations = trial["candidate_prepare_ms"]
        if isinstance(prepare_durations, list):
            for index, value in enumerate(prepare_durations):
                number = _number(value)
                if number is not None:
                    candidate_prepare_ms[index].append(number)

    usage: dict[str, dict[str, int | float]] = {}
    for field in ("input_tokens", "cache_tokens", "output_tokens", "cost_usd"):
        values = [
            number
            for trial in valid_trials
            if (number := _number(_mapping(trial["usage"]).get(field))) is not None
        ]
        usage[field] = _distribution(values)

    durations = [
        number
        for trial in valid_trials
        if (number := _number(trial.get("duration_ms"))) is not None
    ]
    installed = [
        number
        for trial in valid_trials
        if (number := _number(trial.get("compactions_installed"))) is not None
    ]
    summary_bytes = [
        number
        for trial in valid_trials
        if (number := _number(trial.get("max_summary_string_bytes"))) is not None
    ]
    passed = sum(trial["outcome"] == "passed" for trial in trials)
    infrastructure_failed = sum(
        trial["outcome"] == "infrastructure_failure" for trial in trials
    )
    product_failed = sum(trial["outcome"] == "product_failure" for trial in trials)
    valid_attempts = len(valid_trials)
    rewards = [
        number
        for trial in valid_trials
        if (number := _number(trial.get("reward"))) is not None
    ]
    infrastructure_durations = [
        number
        for trial in infrastructure_trials
        if (number := _number(trial.get("duration_ms"))) is not None
    ]
    return {
        "attempts": len(trials),
        "valid_attempts": valid_attempts,
        "passed": passed,
        "product_failed": product_failed,
        "infrastructure_failed": infrastructure_failed,
        "pass_rate": round(passed / valid_attempts, 3) if valid_attempts else 0.0,
        "reward": _distribution(rewards),
        "duration_ms": _distribution(durations),
        "infrastructure_duration_ms": _distribution(infrastructure_durations),
        "usage": usage,
        "context_block_ms_by_turn": [
            _distribution(context_blocks[index]) for index in sorted(context_blocks)
        ],
        "compactions_installed": _distribution(installed),
        "max_summary_string_bytes": _distribution(summary_bytes),
        "candidate_lifecycle_sequences": dict(sorted(lifecycle_counts.items())),
        "candidate_prepare_ms_by_cycle": [
            _distribution(candidate_prepare_ms[index])
            for index in sorted(candidate_prepare_ms)
        ],
    }


def summarize_context_jobs(
    job_dirs: list[Path],
    *,
    expect_attempts: int | None = None,
    expect_model: str | None = None,
) -> dict[str, object]:
    """Re-grade and aggregate direct trial directories from Harbor jobs."""
    trial_dirs = sorted(
        path
        for job_dir in job_dirs
        for path in job_dir.iterdir()
        if path.is_dir() and (path / "result.json").is_file()
    )
    trials: list[dict[str, object]] = []
    violations: list[dict[str, object]] = []
    for trial_dir in trial_dirs:
        trial, trial_violations = _trial(
            trial_dir,
            expect_model=expect_model,
        )
        trials.append(trial)
        violations.extend(trial_violations)

    groups: defaultdict[str, list[dict[str, object]]] = defaultdict(list)
    for trial in trials:
        groups[str(trial["variant"])].append(trial)
    if not trials:
        violations.append(
            {
                "check": "trials_present",
                "trial": None,
                "detail": "job contains no completed trial result directories",
            }
        )
    if expect_attempts is not None:
        for variant, grouped_trials in sorted(groups.items()):
            valid_attempts = sum(
                trial["outcome"] != "infrastructure_failure" for trial in grouped_trials
            )
            if valid_attempts != expect_attempts:
                violations.append(
                    {
                        "check": "valid_attempt_count",
                        "trial": None,
                        "detail": (
                            f"variant {variant!r}: expected {expect_attempts} valid "
                            f"attempts, observed {valid_attempts}"
                        ),
                    }
                )

    return {
        "summary": {
            "job_dirs": [str(job_dir.resolve()) for job_dir in job_dirs],
            "trials": len(trials),
            "models": sorted({str(trial["model"]) for trial in trials}),
            "groups": {
                variant: _group_summary(grouped_trials)
                for variant, grouped_trials in sorted(groups.items())
            },
            "trial_results": trials,
            "infrastructure_failures": [
                {
                    "trial": trial["name"],
                    "kind": trial["failure_kind"],
                }
                for trial in trials
                if trial["outcome"] == "infrastructure_failure"
            ],
        },
        "invariants": {
            "passed": not violations,
            "violations": violations,
        },
    }


def summarize_context_job(
    job_dir: Path,
    *,
    expect_attempts: int | None = None,
    expect_model: str | None = None,
) -> dict[str, object]:
    """Backward-compatible single-job wrapper."""
    return summarize_context_jobs(
        [job_dir],
        expect_attempts=expect_attempts,
        expect_model=expect_model,
    )
