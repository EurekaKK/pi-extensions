"""Configurable Harbor Installed Agent that runs Pi through its TUI."""

from __future__ import annotations

import base64
import re
import shlex
from pathlib import Path
from secrets import token_hex
from typing import override

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    ApiUsageLimitError,
    BaseInstalledAgent,
    CliFlag,
    ErrorPattern,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from pi_eval_harness.constants import (
    ISOLATION_FLAGS,
    NODE_VERSION,
    NVM_VERSION,
    PI_PACKAGE,
    PI_VERSION,
    PROVIDER_KEY_ENV,
    REMOTE_AGENT_DIR,
    REMOTE_CONTEXT_TRACE,
    REMOTE_EXTENSION_INSTALLER,
    REMOTE_EXTENSION_REPO_ROOT,
    REMOTE_EXTENSION_ROOT,
    REMOTE_EXTENSION_SOURCE_ROOT,
    REMOTE_MODEL_KEY_FILE,
    REMOTE_TAVILY_KEY_FILE,
    REMOTE_TUI_DRIVER,
    TAVILY_EXTENSION,
    THINKING_LEVELS,
)
from pi_eval_harness.context_trace import analyze_trace, read_trace
from pi_eval_harness.usage import (
    float_value,
    int_value,
    raise_for_terminal_pi_error,
    read_session_usage,
)

_EXTENSION_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_KEY_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
_EVAL_VARIANT = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class PiTuiAgent(BaseInstalledAgent):
    """Run pinned Pi through its real TUI with a configurable extension list."""

    SUPPORTS_RESUME = True

    CLI_FLAGS = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=list(THINKING_LEVELS),
            default="high",
        )
    ]

    ERROR_PATTERNS = [
        ErrorPattern(
            r"API_KEY.*(?:missing|not set)|authentication_error|"
            r"api key.*(?:invalid|expired)|unauthorized|\b401\b",
            AgentAuthenticationError,
        ),
        ErrorPattern(
            r"\b402\b|insufficient (?:account )?balance|balance is insufficient|"
            r"please recharge|余额不足",
            ApiUsageLimitError,
        ),
        *BaseInstalledAgent.ERROR_PATTERNS,
    ]

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        version: str | None = PI_VERSION,
        extra_env: dict[str, str] | None = None,
        extensions: list[str] | None = None,
        append_system_prompt: str | None = None,
        context_trace: bool = False,
        context_trace_strict: bool = False,
        context_trace_expect_spill: bool = False,
        context_trace_expect_prune: bool = False,
        context_trace_expect_checkpoint: bool = False,
        context_trace_expect_prepared_checkpoint: bool = False,
        context_trace_expect_rolling_checkpoint: bool = False,
        context_scenario_tools: bool = False,
        context_background_followup: str | None = None,
        context_background_followups: list[str] | None = None,
        eval_variant: str | None = None,
        **kwargs: object,
    ) -> None:
        if extra_env:
            for key in extra_env:
                if key.endswith("_API_KEY") or "TOKEN" in key:
                    raise ValueError(
                        "Direct API key agent env is disabled because Harbor "
                        "passes agent env values through host process arguments; "
                        "mount the project key at the pinned secret-file path instead"
                    )

        if version not in {None, PI_VERSION}:
            raise ValueError(
                f"Pi TUI adapter requires version {PI_VERSION!r}; got {version!r}"
            )

        if not isinstance(model_name, str) or "/" not in model_name:
            raise ValueError("Pi TUI adapter requires model_name in 'provider/id' form")
        provider, model_id = model_name.split("/", maxsplit=1)
        if provider not in PROVIDER_KEY_ENV:
            raise ValueError(f"Unknown model provider {provider!r}")
        if not model_id:
            raise ValueError("Model id must not be empty")

        names = list(extensions or [])
        for name in names:
            if not _EXTENSION_NAME.fullmatch(name):
                raise ValueError(f"Invalid extension name {name!r}")

        prompt = append_system_prompt or ""
        if "\x00" in prompt:
            raise ValueError("append_system_prompt must not contain NUL bytes")
        if not isinstance(context_trace, bool):
            raise ValueError("context_trace must be a boolean")
        if not isinstance(context_trace_strict, bool):
            raise ValueError("context_trace_strict must be a boolean")
        if context_trace_strict and not context_trace:
            raise ValueError("context_trace_strict requires context_trace")
        if not isinstance(context_trace_expect_spill, bool):
            raise ValueError("context_trace_expect_spill must be a boolean")
        if context_trace_expect_spill and not context_trace:
            raise ValueError("context_trace_expect_spill requires context_trace")
        if not isinstance(context_trace_expect_prune, bool):
            raise ValueError("context_trace_expect_prune must be a boolean")
        if context_trace_expect_prune and not context_trace:
            raise ValueError("context_trace_expect_prune requires context_trace")
        if not isinstance(context_trace_expect_checkpoint, bool):
            raise ValueError("context_trace_expect_checkpoint must be a boolean")
        if context_trace_expect_checkpoint and not context_trace:
            raise ValueError("context_trace_expect_checkpoint requires context_trace")
        if not isinstance(context_trace_expect_prepared_checkpoint, bool):
            raise ValueError(
                "context_trace_expect_prepared_checkpoint must be a boolean"
            )
        if context_trace_expect_prepared_checkpoint and not context_trace:
            raise ValueError(
                "context_trace_expect_prepared_checkpoint requires context_trace"
            )
        if not isinstance(context_trace_expect_rolling_checkpoint, bool):
            raise ValueError(
                "context_trace_expect_rolling_checkpoint must be a boolean"
            )
        if context_trace_expect_rolling_checkpoint and not context_trace:
            raise ValueError(
                "context_trace_expect_rolling_checkpoint requires context_trace"
            )
        if not isinstance(context_scenario_tools, bool):
            raise ValueError("context_scenario_tools must be a boolean")
        if (
            context_background_followup is not None
            and context_background_followups is not None
        ):
            raise ValueError(
                "context_background_followup and context_background_followups "
                "are mutually exclusive"
            )
        if context_background_followups is not None and (
            not isinstance(context_background_followups, list)
            or not 1 <= len(context_background_followups) <= 3
        ):
            raise ValueError(
                "context_background_followups must contain one to three prompts"
            )
        followups = (
            list(context_background_followups)
            if isinstance(context_background_followups, list)
            else (
                []
                if context_background_followup is None
                else [context_background_followup]
            )
        )
        for followup in followups:
            if (
                not isinstance(followup, str)
                or not followup.strip()
                or "\x00" in followup
            ):
                raise ValueError(
                    "context background follow-ups must be non-empty text without NUL"
                )
        if followups and (
            not context_trace
            or not context_scenario_tools
            or "context-management" not in names
        ):
            raise ValueError(
                "context_background_followup requires context trace, scenario "
                "tools, and context-management"
            )
        if eval_variant is not None and (
            not isinstance(eval_variant, str)
            or not _EVAL_VARIANT.fullmatch(eval_variant)
        ):
            raise ValueError("eval_variant must be a kebab-case name")

        self._provider = provider
        self._model_id = model_id
        self._extensions = names
        self._append_system_prompt = prompt
        self._context_trace = context_trace
        self._context_trace_strict = context_trace_strict
        self._context_trace_expect_spill = context_trace_expect_spill
        self._context_trace_expect_prune = context_trace_expect_prune
        self._context_trace_expect_checkpoint = context_trace_expect_checkpoint
        self._context_trace_expect_prepared_checkpoint = (
            context_trace_expect_prepared_checkpoint
        )
        self._context_trace_expect_rolling_checkpoint = (
            context_trace_expect_rolling_checkpoint
        )
        self._context_scenario_tools = context_scenario_tools
        self._context_background_followup = context_background_followup
        self._context_background_followups = followups
        self._eval_variant = eval_variant
        self._context_trace_hmac_key = token_hex(32) if context_trace else None
        self._model_key_env = PROVIDER_KEY_ENV[provider]
        if not _KEY_ENV_NAME.fullmatch(self._model_key_env):
            raise ValueError(f"Invalid provider key env {self._model_key_env!r}")

        super().__init__(
            logs_dir=logs_dir,
            model_name=model_name,
            version=PI_VERSION,
            extra_env=extra_env,
            **kwargs,
        )

    @staticmethod
    @override
    def name() -> str:
        return "pi-tui"

    @override
    def to_agent_info(self):
        info = super().to_agent_info()
        if self._eval_variant is None:
            return info
        return info.model_copy(update={"name": f"{info.name}-{self._eval_variant}"})

    @override
    def get_version_command(self) -> str:
        return '. "$HOME/.nvm/nvm.sh"; pi --version'

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    def _runtime_env(self, *, resume: bool = False) -> dict[str, str]:
        env = {
            "PI_EVAL_MODEL_KEY_FILE": REMOTE_MODEL_KEY_FILE,
            "PI_EVAL_PROVIDER": self._provider,
            "PI_EVAL_MODEL": self._model_id,
            "PI_EVAL_THINKING": str(self._resolved_flags.get("thinking", "high")),
            "PI_EVAL_PI_VERSION": PI_VERSION,
            "PI_EVAL_EXTENSIONS": "\n".join(
                f"{REMOTE_EXTENSION_ROOT}/{name}/index.ts" for name in self._extensions
            ),
            "PI_CODING_AGENT_DIR": REMOTE_AGENT_DIR,
            "PI_OFFLINE": "1",
            "PI_TELEMETRY": "0",
        }
        if TAVILY_EXTENSION in self._extensions:
            env["PI_EVAL_TAVILY_KEY_FILE"] = REMOTE_TAVILY_KEY_FILE
        if self._context_trace:
            env["PI_EVAL_CONTEXT_TRACE"] = REMOTE_CONTEXT_TRACE
            assert self._context_trace_hmac_key is not None
            env["PI_EVAL_CONTEXT_TRACE_KEY"] = self._context_trace_hmac_key
        if self._context_scenario_tools:
            env["PI_EVAL_CONTEXT_SCENARIO_TOOLS"] = "1"
        if self._context_background_followup is not None:
            env["PI_EVAL_BACKGROUND_FOLLOWUP_BASE64"] = base64.b64encode(
                self._context_background_followup.encode()
            ).decode("ascii")
        elif self._context_background_followups:
            env["PI_EVAL_BACKGROUND_FOLLOWUP_COUNT"] = str(
                len(self._context_background_followups)
            )
            for index, followup in enumerate(
                self._context_background_followups,
                start=1,
            ):
                env[f"PI_EVAL_BACKGROUND_FOLLOWUP_{index}_BASE64"] = base64.b64encode(
                    followup.encode()
                ).decode("ascii")
        if resume:
            env["PI_EVAL_RESUME"] = "1"
        return env

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && "
                "apt-get install -y --no-install-recommends "
                "bash ca-certificates curl git ripgrep rsync && "
                "rm -rf /var/lib/apt/lists/*"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        package_spec = shlex.quote(f"{PI_PACKAGE}@{PI_VERSION}")
        install_extensions = ""
        if self._extensions:
            steps: list[str] = []
            for name in self._extensions:
                package = f"{REMOTE_EXTENSION_SOURCE_ROOT}/{name}"
                steps.append(
                    f"test -f {shlex.quote(f'{package}/package.json')}; "
                    f"test -f {shlex.quote(f'{package}/index.ts')}"
                )
            requested = " ".join(shlex.quote(name) for name in self._extensions)
            steps.extend(
                [
                    f"test -f {shlex.quote(REMOTE_EXTENSION_INSTALLER)}",
                    (
                        "PI_EXTENSIONS_REPO_ROOT="
                        f"{shlex.quote(REMOTE_EXTENSION_REPO_ROOT)} "
                        f"PI_AGENT_DIR={shlex.quote(REMOTE_AGENT_DIR)} "
                        f"bash {shlex.quote(REMOTE_EXTENSION_INSTALLER)} {requested}"
                    ),
                ]
            )
            install_extensions = "; ".join(steps) + "; "

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export NVM_DIR="$HOME/.nvm"; '
                "curl --fail --show-error --silent --location "
                "https://raw.githubusercontent.com/nvm-sh/nvm/"
                f"{NVM_VERSION}/install.sh "
                "| bash; "
                '. "$NVM_DIR/nvm.sh"; '
                f"nvm install {shlex.quote(NODE_VERSION)}; "
                f"nvm alias default {shlex.quote(NODE_VERSION)}; "
                f"nvm use {shlex.quote(NODE_VERSION)}; "
                f"npm install -g --ignore-scripts {package_spec}; "
                f'test "$(node --version)" = "v{NODE_VERSION}"; '
                f'test "$(pi --version | tail -n 1)" = "{PI_VERSION}"; '
                f"{install_extensions}"
            ),
            env=self._runtime_env(),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._run_instruction(instruction, environment, context, resume=False)

    @override
    @with_prompt_template
    async def resume(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._run_instruction(instruction, environment, context, resume=True)

    async def _run_instruction(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
        *,
        resume: bool,
    ) -> None:
        submitted = instruction.strip()
        if not submitted:
            raise ValueError("Benchmark instruction must not be empty")
        if "\x00" in submitted:
            raise ValueError("Benchmark instruction must not contain NUL bytes")

        instruction_b64 = base64.b64encode(submitted.encode()).decode("ascii")
        prompt_b64 = base64.b64encode(self._append_system_prompt.encode()).decode(
            "ascii"
        )
        key_env = self._model_key_env
        tavily_export = ""
        if TAVILY_EXTENSION in self._extensions:
            tavily_export = (
                'if [[ ! -s "$PI_EVAL_TAVILY_KEY_FILE" ]]; then '
                "echo 'TAVILY_API_KEY secret file missing or empty' >&2; "
                "exit 78; fi; "
                'export TAVILY_API_KEY="$(<"$PI_EVAL_TAVILY_KEY_FILE")"; '
            )

        result = await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'if [[ ! -s "$PI_EVAL_MODEL_KEY_FILE" ]]; then '
                "echo 'Model API key secret file missing or empty' >&2; "
                "exit 78; fi; "
                f'export {key_env}="$(<"$PI_EVAL_MODEL_KEY_FILE")"; '
                f"{tavily_export}"
                '. "$HOME/.nvm/nvm.sh"; '
                f"bash {shlex.quote(REMOTE_TUI_DRIVER)} "
                f"{shlex.quote(instruction_b64)} {shlex.quote(prompt_b64)}"
            ),
            env=self._runtime_env(resume=resume),
        )
        raise_for_terminal_pi_error(result.stdout or "")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        usage_records, usage_source = read_session_usage(self.logs_dir)
        thinking = str(self._resolved_flags.get("thinking", "high"))
        has_subagent = "sub-agent" in self._extensions
        metadata: dict[str, object] = {
            **(context.metadata or {}),
            "agent_package": PI_PACKAGE,
            "agent_version": PI_VERSION,
            "provider": self._provider,
            "model": self.model_name,
            "thinking": thinking,
            "parent_mode": "tui",
            "instruction_delivery": "tui_bracketed_paste",
            "extension_bundle": list(self._extensions),
            "context_trace_enabled": self._context_trace,
            "context_trace_strict": self._context_trace_strict,
            "context_trace_expect_spill": self._context_trace_expect_spill,
            "context_trace_expect_prune": self._context_trace_expect_prune,
            "context_trace_expect_checkpoint": self._context_trace_expect_checkpoint,
            "context_trace_expect_prepared_checkpoint": (
                self._context_trace_expect_prepared_checkpoint
            ),
            "context_trace_expect_rolling_checkpoint": (
                self._context_trace_expect_rolling_checkpoint
            ),
            "context_scenario_tools": self._context_scenario_tools,
            "context_background_followup": self._context_background_followup
            is not None,
            "context_background_followup_count": len(
                self._context_background_followups
            ),
            "eval_variant": self._eval_variant,
            "isolation_flags": list(ISOLATION_FLAGS),
            "usage_accounting_scope": (
                "main_pi_session_only" if has_subagent else "main_pi_session"
            ),
            "usage_accounting_complete": not has_subagent,
        }
        if has_subagent:
            metadata["unaccounted_model_activity"] = ["sub-agent_child_sessions"]

        if usage_records:
            input_tokens = 0
            output_tokens = 0
            cache_read_tokens = 0
            cache_write_tokens = 0
            total_cost = 0.0
            assistant_model_turns = 0
            for kind, usage in usage_records:
                input_tokens += int_value(usage.get("input"))
                output_tokens += int_value(usage.get("output"))
                cache_read_tokens += int_value(usage.get("cacheRead"))
                cache_write_tokens += int_value(usage.get("cacheWrite"))
                cost = usage.get("cost")
                if isinstance(cost, dict):
                    total_cost += float_value(cost.get("total"))
                if kind == "assistant":
                    assistant_model_turns += 1
            context.n_input_tokens = (
                input_tokens + cache_read_tokens + cache_write_tokens
            )
            context.n_output_tokens = output_tokens
            context.n_cache_tokens = cache_read_tokens
            context.cost_usd = total_cost if total_cost > 0 else None
            metadata["assistant_model_turns"] = assistant_model_turns
            metadata["usage_source"] = usage_source

        if self._context_trace:
            trace_records = read_trace(self.logs_dir)
            metadata["context_trace"] = analyze_trace(
                trace_records,
                expect_spill=self._context_trace_expect_spill,
                expect_prune=self._context_trace_expect_prune,
                expect_checkpoint=self._context_trace_expect_checkpoint,
                expect_prepared_checkpoint=self._context_trace_expect_prepared_checkpoint,
                expect_rolling_checkpoint=self._context_trace_expect_rolling_checkpoint,
            )
            metadata["context_trace_records"] = len(trace_records)

        context.metadata = metadata
        if self._context_trace_strict:
            analysis = metadata.get("context_trace")
            invariants = (
                analysis.get("invariants") if isinstance(analysis, dict) else None
            )
            if not isinstance(invariants, dict) or invariants.get("passed") is not True:
                raise RuntimeError("Context trace invariants failed")
