"""Session usage accounting and Pi terminal-error classification."""

from __future__ import annotations

import json
import re
from pathlib import Path

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    ApiInternalServerError,
    ApiOverloadedError,
    ApiRateLimitError,
    ApiUsageLimitError,
    UnknownApiError,
)


def int_value(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def float_value(value: object) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return 0.0


def read_json_lines(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        return []
    events: list[dict[str, object]] = []
    for line in path.read_text().splitlines():
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def read_session_usage(
    logs_dir: Path,
) -> tuple[list[tuple[str, dict[str, object]]], str | None]:
    records: list[tuple[str, dict[str, object]]] = []
    sessions_dir = logs_dir / "pi" / "sessions"
    for session_file in sorted(sessions_dir.rglob("*.jsonl")):
        for event in read_json_lines(session_file):
            kind: str | None = None
            usage: object = None
            if event.get("type") == "message":
                message = event.get("message")
                if not isinstance(message, dict):
                    continue
                role = message.get("role")
                if role == "assistant":
                    kind = "assistant"
                elif role == "toolResult":
                    kind = "tool_summary"
                usage = message.get("usage")
            elif event.get("type") in {"compaction", "branch_summary"}:
                kind = str(event["type"])
                usage = event.get("usage")

            if kind is not None and isinstance(usage, dict):
                records.append((kind, usage))
    return records, "pi_session" if records else None


def raise_for_terminal_pi_error(output: str) -> None:
    """Raise when Pi reports a terminal API error despite exiting with status 0."""
    final_message: dict[str, object] | None = None
    fallback_message: dict[str, object] | None = None

    for line in output.splitlines():
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(event, dict):
            continue

        if event.get("type") == "message_end":
            message = event.get("message")
            if isinstance(message, dict) and message.get("role") == "assistant":
                fallback_message = message

        if event.get("type") == "agent_end":
            messages = event.get("messages")
            if not isinstance(messages, list):
                continue
            assistants = [
                message
                for message in messages
                if isinstance(message, dict) and message.get("role") == "assistant"
            ]
            if assistants:
                final_message = assistants[-1]

    message = final_message or fallback_message
    if message is None or message.get("stopReason") not in {"error", "aborted"}:
        return

    detail = str(message.get("errorMessage") or message.get("stopReason"))
    normalized = detail.casefold()
    if re.search(
        r"\b401\b|authentication_error|api key.*(?:invalid|expired)", normalized
    ):
        raise AgentAuthenticationError(f"Pi reported an authentication error: {detail}")
    if re.search(r"\b429\b|rate.?limit|too many requests", normalized):
        raise ApiRateLimitError(f"Pi reported a rate-limit error: {detail}")
    if re.search(
        r"\b402\b|insufficient (?:account )?balance|balance is insufficient|"
        r"please recharge|余额不足|usage limit for this billing cycle|"
        r"purchase extra usage|upgrade your plan",
        normalized,
    ):
        raise ApiUsageLimitError(f"Pi reported an API usage-limit error: {detail}")
    if re.search(r"\b500\b|internal_server_error|internal server error", normalized):
        raise ApiInternalServerError(f"Pi reported an internal API error: {detail}")
    if re.search(r"\b529\b|overloaded", normalized):
        raise ApiOverloadedError(f"Pi reported an overloaded API error: {detail}")
    raise UnknownApiError(f"Pi reported a terminal API error: {detail}")
