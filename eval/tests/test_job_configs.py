from __future__ import annotations

from pathlib import Path

import yaml
from harbor.models.job.config import JobConfig

from pi_eval_harness.constants import (
    AGENT_IMPORT,
    REMOTE_EXTENSION_ROOT,
    REMOTE_MODEL_KEY_FILE,
    REMOTE_RUNTIME_DIR,
    REMOTE_TAVILY_KEY_FILE,
    TAVILY_EXTENSION,
)

ROOT = Path(__file__).resolve().parents[1]
REPO_EXTENSIONS = ROOT.parent / "extensions"
SMOKE_EXTENSIONS = [
    "context-management",
    "todo",
    "sub-agent",
]
DATASET_DIGEST = (
    "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
)
SMOKE_TASK = "terminal-bench/cancel-async-tasks"


def load_config(name: str) -> JobConfig:
    payload = yaml.safe_load((ROOT / "configs" / "harbor" / name).read_text())
    return JobConfig.model_validate(payload)


def mount_targets(config: JobConfig) -> list[str]:
    if config.environment.mounts is None:
        return []
    return [str(mount["target"]) for mount in config.environment.mounts]


def assert_agent(config: JobConfig, extensions: list[str]) -> None:
    assert len(config.agents) == 1
    agent = config.agents[0]
    assert agent.import_path == AGENT_IMPORT
    assert agent.model_name == "deepseek/deepseek-v4-flash"
    assert agent.kwargs["thinking"] == "high"
    assert agent.kwargs["extensions"] == extensions
    assert "version" not in agent.kwargs
    assert agent.env == {}


def test_install_only_needs_no_key_or_runtime_mount() -> None:
    config = load_config("install-only.yaml")

    assert config.install_only is True
    assert_agent(config, [])
    assert config.environment.mounts is None
    assert config.datasets[0].task_names == [SMOKE_TASK]
    assert config.datasets[0].ref == DATASET_DIGEST


def test_runtime_smoke_mounts_model_key_and_runtime_only() -> None:
    config = load_config("runtime-smoke.yaml")

    assert config.install_only is False
    assert_agent(config, [])
    assert mount_targets(config) == [REMOTE_MODEL_KEY_FILE, REMOTE_RUNTIME_DIR]
    assert REMOTE_TAVILY_KEY_FILE not in mount_targets(config)
    assert REMOTE_EXTENSION_ROOT not in mount_targets(config)
    for mount in config.environment.mounts or []:
        assert mount["read_only"] is True


def test_install_only_extensions_mounts_tree_without_keys() -> None:
    config = load_config("install-only-extensions.yaml")

    assert config.install_only is True
    assert_agent(config, SMOKE_EXTENSIONS)
    assert mount_targets(config) == [REMOTE_EXTENSION_ROOT]
    assert REMOTE_MODEL_KEY_FILE not in mount_targets(config)
    assert REMOTE_TAVILY_KEY_FILE not in mount_targets(config)


def test_runtime_smoke_extensions_mounts_tree_without_tavily_key() -> None:
    config = load_config("runtime-smoke-extensions.yaml")

    assert_agent(config, SMOKE_EXTENSIONS)
    targets = mount_targets(config)
    assert REMOTE_MODEL_KEY_FILE in targets
    assert REMOTE_RUNTIME_DIR in targets
    assert REMOTE_EXTENSION_ROOT in targets
    assert REMOTE_TAVILY_KEY_FILE not in targets
    for name in SMOKE_EXTENSIONS:
        assert (REPO_EXTENSIONS / name / "package.json").is_file()
        assert (REPO_EXTENSIONS / name / "index.ts").is_file()


def test_runtime_smoke_tavily_mounts_second_key() -> None:
    config = load_config("runtime-smoke-tavily.yaml")

    assert_agent(config, [TAVILY_EXTENSION])
    targets = mount_targets(config)
    assert REMOTE_MODEL_KEY_FILE in targets
    assert REMOTE_TAVILY_KEY_FILE in targets
    assert REMOTE_RUNTIME_DIR in targets
    assert REMOTE_EXTENSION_ROOT in targets
    assert (REPO_EXTENSIONS / TAVILY_EXTENSION / "package.json").is_file()
    assert (REPO_EXTENSIONS / TAVILY_EXTENSION / "index.ts").is_file()
