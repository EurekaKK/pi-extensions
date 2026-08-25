from __future__ import annotations

import json
import re
from pathlib import Path

import yaml
from harbor.models.job.config import JobConfig
from harbor.models.task.task import Task

from pi_eval_harness.constants import (
    AGENT_IMPORT,
    REMOTE_EXTENSION_REPO_ROOT,
    REMOTE_EXTENSION_SOURCE_ROOT,
    REMOTE_MODEL_KEY_FILE,
    REMOTE_PACKAGE_SOURCE_ROOT,
    REMOTE_REPO_SCRIPTS_ROOT,
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
EXTENSION_REPO_MOUNT_TARGETS = [
    REMOTE_EXTENSION_SOURCE_ROOT,
    REMOTE_PACKAGE_SOURCE_ROOT,
    REMOTE_REPO_SCRIPTS_ROOT,
]


def load_config(name: str) -> JobConfig:
    payload = yaml.safe_load((ROOT / "configs" / "harbor" / name).read_text())
    return JobConfig.model_validate(payload)


def mount_targets(config: JobConfig) -> list[str]:
    if config.environment.mounts is None:
        return []
    return [str(mount["target"]) for mount in config.environment.mounts]


def assert_extension_repo_mounts(targets: list[str]) -> None:
    assert REMOTE_EXTENSION_REPO_ROOT not in targets
    for target in EXTENSION_REPO_MOUNT_TARGETS:
        assert target in targets


def assert_agent(
    config: JobConfig,
    extensions: list[str],
    model_name: str = "deepseek/deepseek-v4-flash",
    thinking: str = "high",
) -> None:
    assert len(config.agents) == 1
    agent = config.agents[0]
    assert agent.import_path == AGENT_IMPORT
    assert agent.model_name == model_name
    assert agent.kwargs["thinking"] == thinking
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
    assert_agent(config, [], model_name="opencode-go/mimo-v2.5")
    assert config.agents[0].extra_allowed_hosts == ["opencode.ai"]
    assert mount_targets(config) == [REMOTE_MODEL_KEY_FILE, REMOTE_RUNTIME_DIR]
    assert REMOTE_TAVILY_KEY_FILE not in mount_targets(config)
    assert not set(EXTENSION_REPO_MOUNT_TARGETS).intersection(mount_targets(config))
    for mount in config.environment.mounts or []:
        assert mount["read_only"] is True


def test_install_only_extensions_mounts_tree_without_keys() -> None:
    config = load_config("install-only-extensions.yaml")

    assert config.install_only is True
    assert_agent(config, SMOKE_EXTENSIONS)
    assert mount_targets(config) == EXTENSION_REPO_MOUNT_TARGETS
    assert REMOTE_MODEL_KEY_FILE not in mount_targets(config)
    assert REMOTE_TAVILY_KEY_FILE not in mount_targets(config)


def test_runtime_smoke_extensions_mounts_tree_without_tavily_key() -> None:
    config = load_config("runtime-smoke-extensions.yaml")

    assert_agent(config, SMOKE_EXTENSIONS)
    targets = mount_targets(config)
    assert REMOTE_MODEL_KEY_FILE in targets
    assert REMOTE_RUNTIME_DIR in targets
    assert_extension_repo_mounts(targets)
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
    assert_extension_repo_mounts(targets)
    assert (REPO_EXTENSIONS / TAVILY_EXTENSION / "package.json").is_file()
    assert (REPO_EXTENSIONS / TAVILY_EXTENSION / "index.ts").is_file()


FOUR_EXTENSIONS = [
    "todo",
    "goal",
    "sub-agent",
    "context-management",
]


def test_runtime_smoke_four_ext_mounts_named_packages_without_tavily() -> None:
    config = load_config("runtime-smoke-four-ext.yaml")

    assert_agent(config, FOUR_EXTENSIONS, model_name="opencode-go/mimo-v2.5")
    assert config.agents[0].extra_allowed_hosts == ["opencode.ai"]
    targets = mount_targets(config)
    assert REMOTE_MODEL_KEY_FILE in targets
    assert REMOTE_RUNTIME_DIR in targets
    assert_extension_repo_mounts(targets)
    assert REMOTE_TAVILY_KEY_FILE not in targets
    for name in FOUR_EXTENSIONS:
        assert (REPO_EXTENSIONS / name / "package.json").is_file()
        assert (REPO_EXTENSIONS / name / "index.ts").is_file()


def test_context_lab_is_a_fair_local_ab_matrix() -> None:
    config = load_config("context-lab.yaml")

    assert config.datasets == []
    assert config.n_attempts == 1
    assert config.n_concurrent_trials == 1
    assert len(config.agents) == 2
    native, managed = config.agents
    assert native.model_name == managed.model_name == "opencode-go/ox-alpha-free"
    assert native.resume_trajectory is True
    assert managed.resume_trajectory is True
    assert native.kwargs["thinking"] == managed.kwargs["thinking"] == "high"
    assert native.kwargs["context_trace"] is True
    assert managed.kwargs["context_trace"] is True
    assert native.kwargs["context_trace_strict"] is True
    assert managed.kwargs["context_trace_strict"] is True
    assert native.kwargs.get("context_trace_expect_spill") is not True
    assert managed.kwargs["context_trace_expect_spill"] is True
    assert native.kwargs["context_scenario_tools"] is True
    assert managed.kwargs["context_scenario_tools"] is True
    assert native.kwargs["eval_variant"] == "native"
    assert managed.kwargs["eval_variant"] == "context-management"
    assert native.kwargs["extensions"] == []
    assert managed.kwargs["extensions"] == ["context-management"]
    assert_extension_repo_mounts(mount_targets(config))
    assert len(config.tasks) == 3
    for task in config.tasks:
        assert task.path is not None
        task_path = ROOT / task.path
        assert Task.is_valid_dir(task_path)


def test_context_large_output_smoke_is_the_narrow_two_arm_probe() -> None:
    config = load_config("context-large-output-smoke.yaml")

    assert config.datasets == []
    assert config.n_attempts == 1
    assert config.n_concurrent_trials == 1
    assert len(config.agents) == 2
    native, managed = config.agents
    assert native.model_name == managed.model_name == "opencode-go/ox-alpha-free"
    assert native.kwargs["eval_variant"] == "native"
    assert managed.kwargs["eval_variant"] == "context-management"
    assert native.kwargs["extensions"] == []
    assert managed.kwargs["extensions"] == ["context-management"]
    assert native.kwargs["context_trace_strict"] is True
    assert managed.kwargs["context_trace_strict"] is True
    assert native.kwargs.get("context_trace_expect_spill") is not True
    assert managed.kwargs["context_trace_expect_spill"] is True
    assert_extension_repo_mounts(mount_targets(config))
    assert len(config.tasks) == 1
    task = config.tasks[0]
    assert task.path == Path("tasks/context-lab/large-tool-output")
    assert Task.is_valid_dir(ROOT / task.path)
    instruction = (ROOT / task.path / "instruction.md").read_text()
    assert "CTX_CANARY_EXPECT_SPILL_BYTES_70000" in instruction


def test_context_large_output_250k_smoke_is_the_effectiveness_ab() -> None:
    config = load_config("context-large-output-250k-smoke.yaml")

    assert config.datasets == []
    assert config.n_attempts == 1
    assert config.n_concurrent_trials == 1
    assert len(config.agents) == 2
    native, managed = config.agents
    assert native.model_name == managed.model_name == "opencode-go/ox-alpha-free"
    assert native.kwargs["eval_variant"] == "native"
    assert managed.kwargs["eval_variant"] == "context-management"
    assert native.kwargs["extensions"] == []
    assert managed.kwargs["extensions"] == ["context-management"]
    assert native.kwargs.get("context_trace_expect_spill") is not True
    assert managed.kwargs["context_trace_expect_spill"] is True
    assert native.kwargs["context_trace_strict"] is True
    assert managed.kwargs["context_trace_strict"] is True
    assert_extension_repo_mounts(mount_targets(config))
    assert len(config.tasks) == 1
    task = config.tasks[0]
    assert task.path == Path("tasks/context-lab/large-tool-output-250k")
    assert Task.is_valid_dir(ROOT / task.path)
    instruction = (ROOT / task.path / "instruction.md").read_text()
    assert "CTX_CANARY_EXPECT_SPILL_BYTES_250000" in instruction
    assert "`bytes`: `250000`" in instruction
    verifier = (ROOT / task.path / "tests" / "test.sh").read_text()
    assert '"bytes":250000' in verifier


def test_context_prune_pressure_smoke_is_managed_only() -> None:
    config = load_config("context-prune-pressure-smoke.yaml")

    assert config.datasets == []
    assert config.n_attempts == 1
    assert config.n_concurrent_trials == 1
    assert len(config.agents) == 1
    agent = config.agents[0]
    assert agent.model_name == "opencode-go/ox-alpha-free"
    assert agent.kwargs["eval_variant"] == "context-management"
    assert agent.kwargs["extensions"] == ["context-management"]
    assert agent.kwargs["context_trace_strict"] is True
    assert agent.kwargs["context_trace_expect_prune"] is True
    assert agent.kwargs.get("context_trace_expect_spill") is not True
    assert_extension_repo_mounts(mount_targets(config))
    assert len(config.tasks) == 1
    task = config.tasks[0]
    assert task.path == Path("tasks/context-lab/repeated-spill-prune")
    assert Task.is_valid_dir(ROOT / task.path)
    instruction = (ROOT / task.path / "instruction.md").read_text()
    assert "CTX_CANARY_EXPECT_PRUNE_SPILLS_17_BYTES_250000" in instruction
    labels = re.findall(r"`CTX_CANARY_PRESSURE_\d{2}`", instruction)
    assert len(labels) == 17
    assert len(set(labels)) == 17
    verifier = (ROOT / task.path / "tests" / "test.sh").read_text()
    assert "for index in {01..17}" in verifier
    assert '"bytes":250000' in verifier


def test_context_checkpoint_smoke_is_two_step_managed_continuity() -> None:
    config = load_config("context-checkpoint-smoke.yaml")

    assert config.datasets == []
    assert config.n_attempts == 1
    assert config.n_concurrent_trials == 1
    assert len(config.agents) == 1
    agent = config.agents[0]
    assert agent.model_name == "opencode-go/ox-alpha-free"
    assert agent.resume_trajectory is True
    assert agent.kwargs["eval_variant"] == "context-management"
    assert agent.kwargs["extensions"] == ["context-management"]
    assert agent.kwargs["context_trace_strict"] is True
    assert agent.kwargs["context_trace_expect_checkpoint"] is True
    assert_extension_repo_mounts(mount_targets(config))
    assert len(config.tasks) == 1
    task = config.tasks[0]
    assert task.path == Path("tasks/context-lab/checkpoint-continuity")
    assert Task.is_valid_dir(ROOT / task.path)

    seed = (ROOT / task.path / "steps" / "seed" / "instruction.md").read_text()
    recall = (ROOT / task.path / "steps" / "recall" / "instruction.md").read_text()
    verifier = (ROOT / task.path / "steps" / "recall" / "tests" / "test.sh").read_text()
    assert "CTX_CANARY_REQUIRE_TOOL_CONTEXT_SEED_HISTORY" in seed
    assert "CTX_CANARY_REQUIRE_TOOL_WRITE" not in seed
    assert "CTX_CANARY_EXPECT_CHECKPOINT_CHUNKS_9_BYTES_100000" in recall
    for canary in (
        "CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M",
        "CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R",
    ):
        assert canary not in recall
        assert canary in verifier


def test_context_prepared_checkpoint_smoke_is_same_process_followup() -> None:
    config = load_config("context-prepared-checkpoint-smoke.yaml")

    assert config.datasets == []
    assert config.n_attempts == 1
    assert config.n_concurrent_trials == 1
    assert len(config.agents) == 1
    agent = config.agents[0]
    assert agent.model_name == "opencode-go/ox-alpha-free"
    assert agent.resume_trajectory is False
    assert agent.kwargs["extensions"] == ["context-management"]
    assert agent.kwargs["context_trace_strict"] is True
    assert agent.kwargs["context_trace_expect_checkpoint"] is True
    assert agent.kwargs["context_trace_expect_prepared_checkpoint"] is True
    followup = agent.kwargs["context_background_followup"]
    assert isinstance(followup, str)
    assert "CTX_CANARY_EXPECT_CHECKPOINT_CHUNKS_9_BYTES_100000" in followup
    assert "CTX_CANARY_EXPECT_PREPARED_CHECKPOINT_BASELINE_MS_36962" in followup
    assert "CTX_CANARY_REQUIRE_TOOL_WRITE" in followup
    assert_extension_repo_mounts(mount_targets(config))
    assert len(config.tasks) == 1
    task = config.tasks[0]
    assert task.path == Path("tasks/context-lab/prepared-checkpoint-continuity")
    assert Task.is_valid_dir(ROOT / task.path)
    instruction = (ROOT / task.path / "instruction.md").read_text()
    assert "CTX_CANARY_REQUIRE_TOOL_CONTEXT_SEED_HISTORY" in instruction
    verifier = (ROOT / task.path / "tests" / "test.sh").read_text()
    for canary in (
        "CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M",
        "CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R",
    ):
        assert canary not in instruction
        assert canary not in followup
        assert canary in verifier


def test_context_rolling_checkpoint_smoke_has_two_ready_gated_cycles() -> None:
    config = load_config("context-rolling-checkpoint-smoke.yaml")

    assert config.datasets == []
    assert config.n_attempts == 1
    assert config.n_concurrent_trials == 1
    assert len(config.agents) == 1
    agent = config.agents[0]
    assert agent.model_name == "opencode-go/ox-alpha-free"
    assert agent.resume_trajectory is False
    assert agent.kwargs["extensions"] == ["context-management"]
    assert agent.kwargs["context_trace_strict"] is True
    assert agent.kwargs["context_trace_expect_rolling_checkpoint"] is True
    followups = agent.kwargs["context_background_followups"]
    assert isinstance(followups, list)
    assert len(followups) == 2
    assert (
        "CTX_CANARY_EXPECT_ROLLING_CHECKPOINT_CYCLE_1_OF_2_BASELINE_MS_36962"
        in followups[0]
    )
    assert (
        "CTX_CANARY_EXPECT_ROLLING_CHECKPOINT_CYCLE_2_OF_2_BASELINE_MS_36962"
        in followups[1]
    )
    assert "CTX_CANARY_REQUIRE_TOOL_CONTEXT_SEED_HISTORY" in followups[0]
    assert "CTX_CANARY_REQUIRE_TOOL_WRITE" in followups[0]
    assert "CTX_CANARY_REQUIRE_TOOL_WRITE" in followups[1]
    assert_extension_repo_mounts(mount_targets(config))
    assert len(config.tasks) == 1
    task = config.tasks[0]
    assert task.path == Path("tasks/context-lab/rolling-checkpoint-continuity")
    assert Task.is_valid_dir(ROOT / task.path)
    instruction = (ROOT / task.path / "instruction.md").read_text()
    verifier = (ROOT / task.path / "tests" / "test.sh").read_text()
    for canary in (
        "CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M",
        "CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R",
        "CTX_CANARY_CHECKPOINT_PERSIST_BETA_4N8V",
        "CTX_CANARY_CHECKPOINT_TAIL_SIGMA_6P3D",
    ):
        assert canary not in instruction
        assert all(canary not in followup for followup in followups)
        assert canary in verifier


VISION_TASKS = {
    "terminal-bench/chess-best-move",
    "terminal-bench/code-from-image",
    "terminal-bench/extract-moves-from-video",
    "terminal-bench/financial-document-processor",
    "terminal-bench/path-tracing",
}

DEV16_TASKS = [
    "terminal-bench/configure-git-webserver",
    "terminal-bench/extract-elf",
    "terminal-bench/feal-differential-cryptanalysis",
    "terminal-bench/hf-model-inference",
    "terminal-bench/install-windows-3.11",
    "terminal-bench/kv-store-grpc",
    "terminal-bench/llm-inference-batching-scheduler",
    "terminal-bench/mcmc-sampling-stan",
    "terminal-bench/merge-diff-arc-agi-task",
    "terminal-bench/modernize-scientific-stack",
    "terminal-bench/multi-source-data-merger",
    "terminal-bench/password-recovery",
    "terminal-bench/polyglot-c-py",
    "terminal-bench/pypi-server",
    "terminal-bench/schemelike-metacircular-eval",
    "terminal-bench/train-fasttext",
]


DEV12_EASY = [
    "terminal-bench/crack-7z-hash",
    "terminal-bench/fix-git",
    "terminal-bench/prove-plus-comm",
    "terminal-bench/raman-fitting",
]
DEV12_MEDIUM = [
    "terminal-bench/build-cython-ext",
    "terminal-bench/extract-elf",
    "terminal-bench/schemelike-metacircular-eval",
    "terminal-bench/tune-mjcf",
]
DEV12_HARD = [
    "terminal-bench/cancel-async-tasks",
    "terminal-bench/mcmc-sampling-stan",
    "terminal-bench/regex-chess",
    "terminal-bench/sparql-university",
]
DEV12_TASKS = DEV12_EASY + DEV12_MEDIUM + DEV12_HARD

MED16_TASKS = [
    "terminal-bench/build-cython-ext",
    "terminal-bench/build-pmars",
    "terminal-bench/constraints-scheduling",
    "terminal-bench/extract-elf",
    "terminal-bench/gcode-to-text",
    "terminal-bench/git-multibranch",
    "terminal-bench/hf-model-inference",
    "terminal-bench/merge-diff-arc-agi-task",
    "terminal-bench/multi-source-data-merger",
    "terminal-bench/nginx-request-logging",
    "terminal-bench/polyglot-c-py",
    "terminal-bench/pytorch-model-cli",
    "terminal-bench/pytorch-model-recovery",
    "terminal-bench/qemu-alpine-ssh",
    "terminal-bench/qemu-startup",
    "terminal-bench/query-optimize",
]
MED16_DROPPED_FOR_TIMEOUT = [
    "terminal-bench/crack-7z-hash",
    "terminal-bench/custom-memory-heap-crash",
    "terminal-bench/distribution-search",
    "terminal-bench/portfolio-optimization",
    "terminal-bench/reshard-c4-data",
    "terminal-bench/rstan-to-pystan",
    "terminal-bench/schemelike-metacircular-eval",
]


def test_dev12_is_four_easy_four_medium_four_hard() -> None:
    native = load_config("dev12.yaml")
    four_ext = load_config("dev12-four-ext.yaml")
    spec = json.loads((ROOT / "configs" / "tb21-dev12.json").read_text())

    assert spec["easy"] == DEV12_EASY
    assert spec["medium"] == DEV12_MEDIUM
    assert spec["hard"] == DEV12_HARD
    assert spec["easy_official"] == [
        "terminal-bench/fix-git",
        "terminal-bench/prove-plus-comm",
    ]
    assert spec["easy_promoted_from_medium"] == [
        "terminal-bench/crack-7z-hash",
        "terminal-bench/raman-fitting",
    ]
    assert native.n_attempts == 1
    assert native.n_concurrent_trials == 2
    assert native.datasets[0].ref == DATASET_DIGEST
    assert native.datasets[0].task_names == DEV12_TASKS
    assert four_ext.datasets[0].task_names == DEV12_TASKS
    assert len(DEV12_TASKS) == 12
    assert len(set(DEV12_TASKS)) == 12
    assert VISION_TASKS.isdisjoint(DEV12_TASKS)
    assert_agent(native, [], model_name="opencode-go/mimo-v2.5")
    assert_agent(
        four_ext,
        FOUR_EXTENSIONS,
        model_name="opencode-go/deepseek-v4-flash",
        thinking="max",
    )
    assert "append_system_prompt" not in native.agents[0].kwargs
    assert "append_system_prompt" not in four_ext.agents[0].kwargs
    assert native.agents[0].extra_allowed_hosts == ["opencode.ai"]
    assert four_ext.agents[0].extra_allowed_hosts == ["opencode.ai"]
    assert mount_targets(native) == [REMOTE_MODEL_KEY_FILE, REMOTE_RUNTIME_DIR]
    four_targets = mount_targets(four_ext)
    assert REMOTE_MODEL_KEY_FILE in four_targets
    assert REMOTE_TAVILY_KEY_FILE not in four_targets
    assert REMOTE_RUNTIME_DIR in four_targets
    assert_extension_repo_mounts(four_targets)


def test_med16_is_sixteen_medium_tasks_under_timeout() -> None:
    native = load_config("med16.yaml")
    four_ext = load_config("med16-four-ext.yaml")
    spec = json.loads((ROOT / "configs" / "tb21-med16.json").read_text())

    assert spec["tasks"] == MED16_TASKS
    assert spec["dropped_for_timeout"] == MED16_DROPPED_FOR_TIMEOUT
    assert spec["algorithm"]["salt"] == "pi-extensions/eval/tb21-med16/v1"
    assert spec["algorithm"]["dataset_digest"] == DATASET_DIGEST
    assert native.n_attempts == 1
    assert native.n_concurrent_trials == 2
    assert native.jobs_dir == Path("runs/med16")
    assert four_ext.jobs_dir == Path("runs/med16")
    assert native.datasets[0].ref == DATASET_DIGEST
    assert native.datasets[0].task_names == MED16_TASKS
    assert four_ext.datasets[0].task_names == MED16_TASKS
    assert len(MED16_TASKS) == 16
    assert len(set(MED16_TASKS)) == 16
    assert VISION_TASKS.isdisjoint(MED16_TASKS)
    assert set(MED16_TASKS).isdisjoint(MED16_DROPPED_FOR_TIMEOUT)
    assert_agent(
        native,
        [],
        model_name="opencode-go/deepseek-v4-flash",
        thinking="max",
    )
    assert_agent(
        four_ext,
        FOUR_EXTENSIONS,
        model_name="opencode-go/deepseek-v4-flash",
        thinking="max",
    )
    assert "append_system_prompt" not in native.agents[0].kwargs
    assert "append_system_prompt" not in four_ext.agents[0].kwargs
    assert native.agents[0].extra_allowed_hosts == ["opencode.ai"]
    assert four_ext.agents[0].extra_allowed_hosts == ["opencode.ai"]
    assert mount_targets(native) == [REMOTE_MODEL_KEY_FILE, REMOTE_RUNTIME_DIR]
    four_targets = mount_targets(four_ext)
    assert REMOTE_MODEL_KEY_FILE in four_targets
    assert REMOTE_TAVILY_KEY_FILE not in four_targets
    assert REMOTE_RUNTIME_DIR in four_targets
    assert_extension_repo_mounts(four_targets)


def test_dev16_is_sixteen_nonvisual_tasks() -> None:
    native = load_config("dev16.yaml")
    four_ext = load_config("dev16-four-ext.yaml")

    assert native.n_attempts == 1
    assert native.n_concurrent_trials == 2
    assert native.datasets[0].ref == DATASET_DIGEST
    assert native.datasets[0].task_names == DEV16_TASKS
    assert four_ext.datasets[0].task_names == DEV16_TASKS
    assert len(DEV16_TASKS) == 16
    assert len(set(DEV16_TASKS)) == 16
    assert VISION_TASKS.isdisjoint(DEV16_TASKS)
    assert_agent(native, [], model_name="opencode-go/mimo-v2.5")
    assert_agent(
        four_ext,
        FOUR_EXTENSIONS,
        model_name="opencode-go/deepseek-v4-flash",
        thinking="max",
    )
    assert "append_system_prompt" not in native.agents[0].kwargs
    assert "append_system_prompt" not in four_ext.agents[0].kwargs
    assert native.agents[0].extra_allowed_hosts == ["opencode.ai"]
    assert four_ext.agents[0].extra_allowed_hosts == ["opencode.ai"]
    assert mount_targets(native) == [REMOTE_MODEL_KEY_FILE, REMOTE_RUNTIME_DIR]
    retry = load_config("dev16-retry-fail6.yaml")
    retry_tasks = retry.datasets[0].task_names or []
    assert retry.datasets[0].ref == DATASET_DIGEST
    assert retry.n_concurrent_trials == 2
    assert len(retry_tasks) == 6
    assert retry_tasks == [
        "terminal-bench/feal-differential-cryptanalysis",
        "terminal-bench/install-windows-3.11",
        "terminal-bench/password-recovery",
        "terminal-bench/polyglot-c-py",
        "terminal-bench/schemelike-metacircular-eval",
        "terminal-bench/train-fasttext",
    ]
    assert set(retry_tasks).issubset(DEV16_TASKS)
    assert_agent(retry, [], model_name="opencode-go/mimo-v2.5")
    assert mount_targets(retry) == [REMOTE_MODEL_KEY_FILE, REMOTE_RUNTIME_DIR]
    four_targets = mount_targets(four_ext)
    assert REMOTE_MODEL_KEY_FILE in four_targets
    assert REMOTE_TAVILY_KEY_FILE not in four_targets
    assert REMOTE_RUNTIME_DIR in four_targets
    assert_extension_repo_mounts(four_targets)
    probe = load_config("dev16-four-ext-probe2.yaml")
    probe_tasks = probe.datasets[0].task_names or []
    assert probe_tasks == [
        "terminal-bench/extract-elf",
        "terminal-bench/pypi-server",
    ]
    assert set(probe_tasks).issubset(DEV16_TASKS)
    assert_agent(
        probe,
        FOUR_EXTENSIONS,
        model_name="opencode-go/deepseek-v4-flash",
        thinking="max",
    )
    assert "append_system_prompt" not in probe.agents[0].kwargs
    assert mount_targets(probe) == four_targets
