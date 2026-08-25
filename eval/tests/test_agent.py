from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import pytest
from harbor.agents.installed.base import (
    AgentAuthenticationError,
    ApiUsageLimitError,
)
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from pi_eval_harness.agent import PiTuiAgent
from pi_eval_harness.constants import (
    ISOLATION_FLAGS,
    NODE_VERSION,
    PI_PACKAGE,
    PI_VERSION,
    REMOTE_AGENT_DIR,
    REMOTE_CONTEXT_SCENARIO_TOOLS,
    REMOTE_CONTEXT_TRACE,
    REMOTE_EXTENSION_INSTALLER,
    REMOTE_EXTENSION_REPO_ROOT,
    REMOTE_EXTENSION_ROOT,
    REMOTE_EXTENSION_SOURCE_ROOT,
    REMOTE_MODEL_KEY_FILE,
    REMOTE_TAVILY_KEY_FILE,
    REMOTE_TUI_DRIVER,
    TAVILY_EXTENSION,
)
from pi_eval_harness.context_trace import TRACE_SCHEMA, trace_path

INSTRUCTION = "Inspect the environment.\n\nComplete and verify the requested task."


class RecordingEnvironment:
    def __init__(self, stdout: str = "", return_code: int = 0) -> None:
        self.calls: list[dict[str, object]] = []
        self.stdout = stdout
        self.return_code = return_code

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        self.calls.append(
            {
                "command": command,
                "cwd": cwd,
                "env": env,
                "timeout_sec": timeout_sec,
                "user": user,
            }
        )
        return ExecResult(
            return_code=self.return_code, stdout=self.stdout, stderr=self.stdout
        )


def make_agent(tmp_path: Path, **kwargs: object) -> PiTuiAgent:
    return PiTuiAgent(
        logs_dir=tmp_path,
        model_name="deepseek/deepseek-v4-flash",
        thinking="high",
        **kwargs,
    )


def test_run_submits_original_instruction_to_tui(tmp_path: Path) -> None:
    environment = RecordingEnvironment()
    context = AgentContext()

    asyncio.run(make_agent(tmp_path).run(INSTRUCTION, environment, context))

    assert len(environment.calls) == 1
    command = str(environment.calls[0]["command"])
    assert REMOTE_TUI_DRIVER in command
    assert INSTRUCTION not in command
    assert base64.b64encode(INSTRUCTION.encode()).decode() in command
    assert "--print" not in command
    assert 'export DEEPSEEK_API_KEY="$(<"$PI_EVAL_MODEL_KEY_FILE")"' in command
    env = environment.calls[0]["env"]
    assert isinstance(env, dict)
    assert env["PI_EVAL_PROVIDER"] == "deepseek"
    assert env["PI_EVAL_MODEL"] == "deepseek-v4-flash"
    assert env["PI_EVAL_THINKING"] == "high"
    assert env["PI_EVAL_EXTENSIONS"] == ""
    assert env["PI_OFFLINE"] == "1"
    assert env["PI_TELEMETRY"] == "0"
    assert env["PI_CODING_AGENT_DIR"] == REMOTE_AGENT_DIR
    assert env["PI_EVAL_MODEL_KEY_FILE"] == REMOTE_MODEL_KEY_FILE
    assert "DEEPSEEK_API_KEY" not in env
    assert "PI_EVAL_APPEND_SYSTEM_PROMPT" not in env
    assert "PI_EVAL_CONTEXT_TRACE" not in env
    assert "PI_EVAL_RESUME" not in env
    assert "--no-context-files" not in command
    assert context.is_empty()


def test_resume_continues_the_previous_pi_session(tmp_path: Path) -> None:
    environment = RecordingEnvironment()
    context = AgentContext()
    instruction = "Recall CTX_CANARY_RESUME_ALPHA from the previous step."
    agent = make_agent(tmp_path)

    asyncio.run(agent.resume(instruction, environment, context))

    assert agent.SUPPORTS_RESUME is True
    assert len(environment.calls) == 1
    env = environment.calls[0]["env"]
    assert isinstance(env, dict)
    assert env["PI_EVAL_RESUME"] == "1"
    command = str(environment.calls[0]["command"])
    assert base64.b64encode(instruction.encode()).decode() in command


def test_context_trace_key_is_stable_across_run_and_resume(tmp_path: Path) -> None:
    agent = make_agent(tmp_path, context_trace=True)
    run_environment = RecordingEnvironment()
    resume_environment = RecordingEnvironment()

    asyncio.run(agent.run("first", run_environment, AgentContext()))
    asyncio.run(agent.resume("second", resume_environment, AgentContext()))

    run_env = run_environment.calls[0]["env"]
    resume_env = resume_environment.calls[0]["env"]
    assert isinstance(run_env, dict)
    assert isinstance(resume_env, dict)
    assert (
        run_env["PI_EVAL_CONTEXT_TRACE_KEY"] == resume_env["PI_EVAL_CONTEXT_TRACE_KEY"]
    )


def test_context_trace_is_opt_in_and_uses_agent_log_path(tmp_path: Path) -> None:
    environment = RecordingEnvironment()
    agent = make_agent(tmp_path, context_trace=True)

    asyncio.run(agent.run(INSTRUCTION, environment, AgentContext()))

    env = environment.calls[0]["env"]
    assert isinstance(env, dict)
    assert env["PI_EVAL_CONTEXT_TRACE"] == REMOTE_CONTEXT_TRACE
    assert isinstance(env["PI_EVAL_CONTEXT_TRACE_KEY"], str)
    assert len(env["PI_EVAL_CONTEXT_TRACE_KEY"]) == 64

    context = AgentContext()
    agent.populate_context_post_run(context)
    assert context.metadata is not None
    assert context.metadata["context_trace_enabled"] is True


def test_context_trace_rejects_non_boolean_values(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="context_trace"):
        make_agent(tmp_path, context_trace="yes")
    with pytest.raises(ValueError, match="context_trace_strict"):
        make_agent(tmp_path, context_trace_strict=True)
    with pytest.raises(ValueError, match="context_trace_expect_spill"):
        make_agent(tmp_path, context_trace_expect_spill=True)
    with pytest.raises(ValueError, match="context_trace_expect_spill"):
        make_agent(
            tmp_path,
            context_trace=True,
            context_trace_expect_spill="yes",
        )
    with pytest.raises(ValueError, match="context_trace_expect_prune"):
        make_agent(tmp_path, context_trace_expect_prune=True)
    with pytest.raises(ValueError, match="context_trace_expect_prune"):
        make_agent(
            tmp_path,
            context_trace=True,
            context_trace_expect_prune="yes",
        )
    with pytest.raises(ValueError, match="context_trace_expect_checkpoint"):
        make_agent(tmp_path, context_trace_expect_checkpoint=True)
    with pytest.raises(ValueError, match="context_trace_expect_checkpoint"):
        make_agent(
            tmp_path,
            context_trace=True,
            context_trace_expect_checkpoint="yes",
        )
    with pytest.raises(ValueError, match="context_trace_expect_prepared_checkpoint"):
        make_agent(tmp_path, context_trace_expect_prepared_checkpoint=True)
    with pytest.raises(ValueError, match="context_trace_expect_rolling_checkpoint"):
        make_agent(tmp_path, context_trace_expect_rolling_checkpoint=True)


def test_context_trace_analysis_is_added_to_post_run_metadata(tmp_path: Path) -> None:
    path = trace_path(tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "data": {},
                "event": "agent_settled",
                "leaf_hash": None,
                "run_id": "run-1",
                "schema": TRACE_SCHEMA,
                "seq": 1,
                "session_hash": "session",
                "timestamp": "2026-08-24T00:00:00.000Z",
            }
        )
        + "\n"
    )
    context = AgentContext()

    make_agent(tmp_path, context_trace=True).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["context_trace_records"] == 1
    analysis = context.metadata["context_trace"]
    assert isinstance(analysis, dict)
    invariants = analysis["invariants"]
    assert isinstance(invariants, dict)
    assert invariants["passed"] is False
    assert {item["check"] for item in invariants["violations"]} == {
        "context_observed",
        "provider_request_observed",
    }


def test_context_trace_records_spill_expectation_in_metadata(tmp_path: Path) -> None:
    context = AgentContext()

    make_agent(
        tmp_path,
        context_trace=True,
        context_trace_expect_spill=True,
    ).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["context_trace_expect_spill"] is True


def test_context_trace_records_prune_expectation_in_metadata(tmp_path: Path) -> None:
    context = AgentContext()

    make_agent(
        tmp_path,
        context_trace=True,
        context_trace_expect_prune=True,
    ).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["context_trace_expect_prune"] is True


def test_context_trace_records_checkpoint_expectation_in_metadata(
    tmp_path: Path,
) -> None:
    context = AgentContext()

    make_agent(
        tmp_path,
        context_trace=True,
        context_trace_expect_checkpoint=True,
    ).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["context_trace_expect_checkpoint"] is True


def test_context_trace_records_prepared_checkpoint_expectation_in_metadata(
    tmp_path: Path,
) -> None:
    context = AgentContext()

    make_agent(
        tmp_path,
        context_trace=True,
        context_trace_expect_prepared_checkpoint=True,
    ).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["context_trace_expect_prepared_checkpoint"] is True


def test_context_trace_records_rolling_checkpoint_expectation_in_metadata(
    tmp_path: Path,
) -> None:
    context = AgentContext()

    make_agent(
        tmp_path,
        context_trace=True,
        context_trace_expect_rolling_checkpoint=True,
    ).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["context_trace_expect_rolling_checkpoint"] is True


def test_strict_context_trace_fails_post_run_on_invariant_violation(
    tmp_path: Path,
) -> None:
    context = AgentContext()

    with pytest.raises(RuntimeError, match="invariants"):
        make_agent(
            tmp_path,
            context_trace=True,
            context_trace_strict=True,
        ).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["context_trace"]["invariants"]["passed"] is False


def test_context_scenario_tools_are_opt_in(tmp_path: Path) -> None:
    environment = RecordingEnvironment()
    agent = make_agent(tmp_path, context_scenario_tools=True)

    asyncio.run(agent.run(INSTRUCTION, environment, AgentContext()))

    env = environment.calls[0]["env"]
    assert isinstance(env, dict)
    assert env["PI_EVAL_CONTEXT_SCENARIO_TOOLS"] == "1"
    assert REMOTE_CONTEXT_SCENARIO_TOOLS.endswith("/context-scenario-tools/index.mjs")


def test_context_scenario_tools_reject_non_boolean_values(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="context_scenario_tools"):
        make_agent(tmp_path, context_scenario_tools="yes")


def test_background_followup_requires_checkpoint_eval_dependencies(
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match="context_background_followup"):
        make_agent(tmp_path, context_background_followup="follow up")


def test_background_followup_is_base64_encoded_in_runtime_env(tmp_path: Path) -> None:
    followup = "CTX_CANARY_EXPECT_PREPARED_CHECKPOINT_BASELINE_MS_54640"
    environment = RecordingEnvironment()
    agent = make_agent(
        tmp_path,
        extensions=["context-management"],
        context_trace=True,
        context_scenario_tools=True,
        context_background_followup=followup,
    )

    asyncio.run(agent.run(INSTRUCTION, environment, AgentContext()))

    env = environment.calls[0]["env"]
    assert isinstance(env, dict)
    assert (
        env["PI_EVAL_BACKGROUND_FOLLOWUP_BASE64"]
        == base64.b64encode(followup.encode()).decode()
    )
    assert followup not in str(environment.calls[0]["command"])


def test_background_followup_list_is_numbered_in_runtime_env(tmp_path: Path) -> None:
    followups = ["first follow-up", "second follow-up"]
    environment = RecordingEnvironment()
    agent = make_agent(
        tmp_path,
        extensions=["context-management"],
        context_trace=True,
        context_scenario_tools=True,
        context_background_followups=followups,
    )

    asyncio.run(agent.run(INSTRUCTION, environment, AgentContext()))

    env = environment.calls[0]["env"]
    assert isinstance(env, dict)
    assert env["PI_EVAL_BACKGROUND_FOLLOWUP_COUNT"] == "2"
    assert (
        env["PI_EVAL_BACKGROUND_FOLLOWUP_1_BASE64"]
        == base64.b64encode(followups[0].encode()).decode()
    )
    assert (
        env["PI_EVAL_BACKGROUND_FOLLOWUP_2_BASE64"]
        == base64.b64encode(followups[1].encode()).decode()
    )
    assert "PI_EVAL_BACKGROUND_FOLLOWUP_BASE64" not in env


def test_eval_variant_separates_harbor_agent_identity(tmp_path: Path) -> None:
    native = make_agent(tmp_path, eval_variant="native")
    managed = make_agent(tmp_path, eval_variant="context-management")

    assert native.to_agent_info().name == "pi-tui-native"
    assert managed.to_agent_info().name == "pi-tui-context-management"
    assert native.model_name == managed.model_name


def test_eval_variant_rejects_non_kebab_names(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="eval_variant"):
        make_agent(tmp_path, eval_variant="Not Valid")


def test_install_pins_pi_and_skips_extensions_when_list_is_empty(
    tmp_path: Path,
) -> None:
    environment = RecordingEnvironment()

    asyncio.run(make_agent(tmp_path).install(environment))

    assert len(environment.calls) == 2
    agent_command = str(environment.calls[-1]["command"])
    assert f"nvm install {NODE_VERSION}" in agent_command
    assert f"{PI_PACKAGE}@{PI_VERSION}" in agent_command
    assert "pi install" not in agent_command
    assert "config.json" not in agent_command
    assert "sidecar" not in agent_command


def test_install_and_run_load_named_extensions_in_order(tmp_path: Path) -> None:
    environment = RecordingEnvironment()
    extensions = [
        "context-management",
        "todo",
        "sub-agent",
    ]
    agent = make_agent(tmp_path, extensions=extensions)

    asyncio.run(agent.install(environment))
    install_command = str(environment.calls[-1]["command"])
    for name in extensions:
        package = f"{REMOTE_EXTENSION_SOURCE_ROOT}/{name}"
        assert f"test -f {package}/package.json" in install_command
        assert f"test -f {package}/index.ts" in install_command
    requested = " ".join(extensions)
    assert f"bash {REMOTE_EXTENSION_INSTALLER} {requested}" in install_command
    assert "pi install " not in install_command
    assert "goal" not in install_command
    assert TAVILY_EXTENSION not in install_command
    assert "config.json" not in install_command
    assert "sidecar" not in install_command
    assert "guardian" not in install_command

    environment.calls.clear()
    asyncio.run(agent.run(INSTRUCTION, environment, AgentContext()))
    run_env = environment.calls[0]["env"]
    assert isinstance(run_env, dict)
    expected_entries = "\n".join(
        f"{REMOTE_EXTENSION_ROOT}/{name}/index.ts" for name in extensions
    )
    assert run_env["PI_EVAL_EXTENSIONS"] == expected_entries
    run_command = str(environment.calls[0]["command"])
    assert "config.json" not in run_command
    assert TAVILY_EXTENSION not in run_command


def test_install_uses_repo_installer_for_internal_package_vendoring(
    tmp_path: Path,
) -> None:
    environment = RecordingEnvironment()
    agent = make_agent(tmp_path, extensions=["context-management"])

    asyncio.run(agent.install(environment))

    install_command = str(environment.calls[-1]["command"])
    assert f"PI_EXTENSIONS_REPO_ROOT={REMOTE_EXTENSION_REPO_ROOT}" in install_command
    assert f"PI_AGENT_DIR={REMOTE_AGENT_DIR}" in install_command
    assert f"{REMOTE_EXTENSION_INSTALLER} context-management" in install_command
    assert "pi install /opt/pi-extensions/context-management" not in install_command


def test_tavily_key_is_exported_only_when_that_extension_is_listed(
    tmp_path: Path,
) -> None:
    without_tavily = RecordingEnvironment()
    asyncio.run(make_agent(tmp_path).run(INSTRUCTION, without_tavily, AgentContext()))
    native_command = str(without_tavily.calls[0]["command"])
    native_env = without_tavily.calls[0]["env"]
    assert "TAVILY_API_KEY" not in native_command
    assert isinstance(native_env, dict)
    assert "PI_EVAL_TAVILY_KEY_FILE" not in native_env

    with_tavily = RecordingEnvironment()
    agent = make_agent(tmp_path, extensions=[TAVILY_EXTENSION])
    asyncio.run(agent.run(INSTRUCTION, with_tavily, AgentContext()))
    tavily_command = str(with_tavily.calls[0]["command"])
    tavily_env = with_tavily.calls[0]["env"]
    assert 'export TAVILY_API_KEY="$(<"$PI_EVAL_TAVILY_KEY_FILE")"' in tavily_command
    assert isinstance(tavily_env, dict)
    assert tavily_env["PI_EVAL_TAVILY_KEY_FILE"] == REMOTE_TAVILY_KEY_FILE
    assert "TAVILY_API_KEY" not in tavily_env


def test_direct_api_keys_in_extra_env_are_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="API key"):
        make_agent(tmp_path, extra_env={"DEEPSEEK_API_KEY": "not-a-real-key"})
    with pytest.raises(ValueError, match="API key"):
        make_agent(tmp_path, extra_env={"TAVILY_API_KEY": "not-a-real-key"})


def test_empty_instruction_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="empty"):
        asyncio.run(
            make_agent(tmp_path).run("  \n", RecordingEnvironment(), AgentContext())
        )


def test_run_classifies_402_as_usage_limit(tmp_path: Path) -> None:
    error_message = {
        "role": "assistant",
        "content": [],
        "stopReason": "error",
        "errorMessage": "402 Insufficient Balance",
    }
    stdout = "\n".join(
        [
            json.dumps({"type": "message_end", "message": error_message}),
            json.dumps({"type": "agent_end", "messages": [error_message]}),
        ]
    )

    with pytest.raises(ApiUsageLimitError):
        asyncio.run(
            make_agent(tmp_path).run(
                "task",
                RecordingEnvironment(stdout, return_code=74),
                AgentContext(),
            )
        )


def test_run_classifies_401_as_authentication_error(tmp_path: Path) -> None:
    error_message = {
        "role": "assistant",
        "content": [],
        "stopReason": "error",
        "errorMessage": "401 authentication_error",
    }
    stdout = json.dumps({"type": "agent_end", "messages": [error_message]})

    with pytest.raises(AgentAuthenticationError):
        asyncio.run(
            make_agent(tmp_path).run(
                "task", RecordingEnvironment(stdout), AgentContext()
            )
        )


def test_post_run_metadata_records_factors_and_isolation(tmp_path: Path) -> None:
    context = AgentContext()
    agent = make_agent(tmp_path, extensions=["todo", "sub-agent"])

    agent.populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["parent_mode"] == "tui"
    assert context.metadata["model"] == "deepseek/deepseek-v4-flash"
    assert context.metadata["thinking"] == "high"
    assert context.metadata["extension_bundle"] == ["todo", "sub-agent"]
    assert context.metadata["isolation_flags"] == list(ISOLATION_FLAGS)
    assert context.metadata["instruction_delivery"] == "tui_bracketed_paste"
    assert context.metadata["usage_accounting_scope"] == "main_pi_session_only"
    assert context.metadata["usage_accounting_complete"] is False


def test_unknown_extension_name_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="extension"):
        make_agent(tmp_path, extensions=["not a valid name"])


def test_unknown_provider_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="provider"):
        PiTuiAgent(
            logs_dir=tmp_path,
            model_name="not-a-provider/model",
            thinking="high",
        )


def test_run_follows_provider_model_and_thinking(tmp_path: Path) -> None:
    environment = RecordingEnvironment()
    agent = PiTuiAgent(
        logs_dir=tmp_path,
        model_name="openai/gpt-5",
        thinking="low",
    )

    asyncio.run(agent.run(INSTRUCTION, environment, AgentContext()))

    command = str(environment.calls[0]["command"])
    env = environment.calls[0]["env"]
    assert isinstance(env, dict)
    assert env["PI_EVAL_PROVIDER"] == "openai"
    assert env["PI_EVAL_MODEL"] == "gpt-5"
    assert env["PI_EVAL_THINKING"] == "low"
    assert 'export OPENAI_API_KEY="$(<"$PI_EVAL_MODEL_KEY_FILE")"' in command
    assert "DEEPSEEK_API_KEY" not in command
    assert "OPENAI_API_KEY" not in env


def test_opencode_go_exports_opencode_api_key(tmp_path: Path) -> None:
    environment = RecordingEnvironment()
    agent = PiTuiAgent(
        logs_dir=tmp_path,
        model_name="opencode-go/mimo-v2.5",
        thinking="high",
    )

    asyncio.run(agent.run(INSTRUCTION, environment, AgentContext()))

    command = str(environment.calls[0]["command"])
    env = environment.calls[0]["env"]
    assert isinstance(env, dict)
    assert env["PI_EVAL_PROVIDER"] == "opencode-go"
    assert env["PI_EVAL_MODEL"] == "mimo-v2.5"
    assert 'export OPENCODE_API_KEY="$(<"$PI_EVAL_MODEL_KEY_FILE")"' in command
    assert "OPENCODE_API_KEY" not in env
    assert "DEEPSEEK_API_KEY" not in command


def test_optional_system_prompt_is_base64_encoded(tmp_path: Path) -> None:
    prompt = "Prefer small, reversible edits."
    environment = RecordingEnvironment()

    asyncio.run(
        make_agent(tmp_path, append_system_prompt=prompt).run(
            INSTRUCTION, environment, AgentContext()
        )
    )

    command = str(environment.calls[0]["command"])
    env = environment.calls[0]["env"]
    assert prompt not in command
    assert base64.b64encode(prompt.encode()).decode() in command
    assert isinstance(env, dict)
    assert "PI_EVAL_APPEND_SYSTEM_PROMPT" not in env


def test_nul_instruction_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="NUL"):
        asyncio.run(
            make_agent(tmp_path).run(
                "task\x00hidden", RecordingEnvironment(), AgentContext()
            )
        )


def test_post_run_metadata_marks_native_usage_complete(tmp_path: Path) -> None:
    context = AgentContext()

    make_agent(tmp_path).populate_context_post_run(context)

    assert context.metadata is not None
    assert context.metadata["usage_accounting_scope"] == "main_pi_session"
    assert context.metadata["usage_accounting_complete"] is True
    assert context.metadata["instruction_delivery"] == "tui_bracketed_paste"
    assert context.metadata["isolation_flags"] == list(ISOLATION_FLAGS)
    assert "unaccounted_model_activity" not in context.metadata
