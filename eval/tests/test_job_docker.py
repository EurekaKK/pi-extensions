from __future__ import annotations

from pathlib import Path

from pi_eval_harness.job_docker import (
    ContainerSnapshot,
    cleanup_job_docker,
    compose_projects_for_job_dirs,
    containers_to_remove,
    harbor_compose_project,
    job_dirs_to_sweep,
    job_has_finished,
    mount_belongs_to_job,
    snapshot_from_inspect,
    trial_names_in_job_dir,
)


class RecordingDocker:
    def __init__(self, snapshots: list[ContainerSnapshot]) -> None:
        self.snapshots = snapshots
        self.removed_containers: list[str] = []
        self.removed_networks: list[str] = []
        self.networks_by_project: dict[str, list[str]] = {}

    def list_containers(self) -> list[ContainerSnapshot]:
        return list(self.snapshots)

    def remove_containers(self, container_ids: list[str]) -> None:
        self.removed_containers.extend(container_ids)

    def list_network_ids(self, compose_project: str) -> list[str]:
        return list(self.networks_by_project.get(compose_project, []))

    def remove_networks(self, network_ids: list[str]) -> None:
        self.removed_networks.extend(network_ids)


def test_harbor_compose_project_lowercases_trial_name() -> None:
    assert harbor_compose_project("feal-differential-cryptanalysis__LCA4HkE") == (
        "feal-differential-cryptanalysis__lca4hke__env"
    )


def test_trial_names_come_from_config_json_dirs(tmp_path: Path) -> None:
    trial = tmp_path / "feal-differential-cryptanalysis__LCA4HkE"
    trial.mkdir()
    (trial / "config.json").write_text("{}")
    (tmp_path / "result.json").write_text("{}")
    (tmp_path / "notes").mkdir()

    assert trial_names_in_job_dir(tmp_path) == [
        "feal-differential-cryptanalysis__LCA4HkE"
    ]


def test_mount_belongs_to_job_is_path_prefix(tmp_path: Path) -> None:
    job_dir = tmp_path / "pi-tui-native-dev16-mimo-20260819"
    agent_logs = job_dir / "feal-differential-cryptanalysis__LCA4HkE" / "agent"
    agent_logs.mkdir(parents=True)
    other = tmp_path / "other-job" / "agent"
    other.mkdir(parents=True)

    assert mount_belongs_to_job(str(agent_logs), job_dir)
    assert not mount_belongs_to_job(str(other), job_dir)


def test_job_dirs_to_sweep_keeps_running_siblings(tmp_path: Path) -> None:
    jobs_dir = tmp_path / "runs" / "dev16"
    current = jobs_dir / "retry6"
    finished = jobs_dir / "native"
    running = jobs_dir / "still-running"
    current.mkdir(parents=True)
    finished.mkdir()
    running.mkdir()
    (finished / "result.json").write_text('{"finished_at": "2026-08-19T16:39:21Z"}')
    (running / "result.json").write_text('{"finished_at": null}')

    swept = job_dirs_to_sweep(jobs_dir, "retry6")
    assert current.resolve() in swept
    assert finished.resolve() in swept
    assert running.resolve() not in swept
    assert job_has_finished(finished)
    assert not job_has_finished(running)


def test_containers_to_remove_matches_compose_project_and_mounts(
    tmp_path: Path,
) -> None:
    job_dir = tmp_path / "native"
    trial = job_dir / "feal-differential-cryptanalysis__LCA4HkE"
    trial.mkdir(parents=True)
    (trial / "config.json").write_text("{}")
    other_job = tmp_path / "still-running" / "train-fasttext__abc"
    other_job.mkdir(parents=True)

    leftover = ContainerSnapshot(
        container_id="leftover1",
        name="feal-differential-cryptanalysis__lca4hke__env-main-1",
        compose_project="feal-differential-cryptanalysis__lca4hke__env",
        mount_sources=(str(trial / "agent"),),
    )
    by_mount_only = ContainerSnapshot(
        container_id="mount1",
        name="orphan-without-project",
        compose_project=None,
        mount_sources=(str(trial / "verifier"),),
    )
    unrelated = ContainerSnapshot(
        container_id="other1",
        name="train-fasttext__abc__env-main-1",
        compose_project="train-fasttext__abc__env",
        mount_sources=(str(other_job / "agent"),),
    )

    selected = containers_to_remove(
        [leftover, by_mount_only, unrelated],
        [job_dir],
    )
    assert [item.container_id for item in selected] == ["leftover1", "mount1"]
    assert compose_projects_for_job_dirs([job_dir]) == {
        "feal-differential-cryptanalysis__lca4hke__env"
    }


def test_snapshot_from_inspect_reads_compose_project_and_bind_sources() -> None:
    snapshot = snapshot_from_inspect(
        {
            "Id": "abc123def456",
            "Name": "/feal-differential-cryptanalysis__lca4hke__env-main-1",
            "Config": {
                "Labels": {
                    "com.docker.compose.project": (
                        "feal-differential-cryptanalysis__lca4hke__env"
                    )
                }
            },
            "Mounts": [
                {
                    "Type": "bind",
                    "Source": "/tmp/job/trial/agent",
                    "Destination": "/logs/agent",
                }
            ],
        }
    )
    assert snapshot.name == "feal-differential-cryptanalysis__lca4hke__env-main-1"
    assert snapshot.compose_project == "feal-differential-cryptanalysis__lca4hke__env"
    assert snapshot.mount_sources == ("/tmp/job/trial/agent",)


def test_cleanup_job_docker_removes_finished_sibling_leftover(tmp_path: Path) -> None:
    eval_root = tmp_path
    jobs_dir = eval_root / "runs" / "dev16"
    current = jobs_dir / "retry6"
    finished = jobs_dir / "native"
    trial = finished / "feal-differential-cryptanalysis__LCA4HkE"
    trial.mkdir(parents=True)
    current.mkdir()
    (trial / "config.json").write_text("{}")
    (finished / "result.json").write_text('{"finished_at": "2026-08-19T16:39:21Z"}')
    (eval_root / "job.yaml").write_text(
        """
job_name: retry6
jobs_dir: runs/dev16
n_attempts: 1
n_concurrent_trials: 1
agents:
  - import_path: pi_eval_harness.agent:PiTuiAgent
    model_name: deepseek/deepseek-v4-flash
    kwargs:
      thinking: high
      extensions: []
datasets:
  - name: terminal-bench/terminal-bench-2-1
    ref: sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a
    task_names:
      - terminal-bench/cancel-async-tasks
""".lstrip()
    )
    leftover = ContainerSnapshot(
        container_id="leftover1",
        name="feal-differential-cryptanalysis__lca4hke__env-main-1",
        compose_project="feal-differential-cryptanalysis__lca4hke__env",
        mount_sources=(str(trial / "agent"),),
    )
    runtime = RecordingDocker([leftover])
    runtime.networks_by_project = {
        "feal-differential-cryptanalysis__lca4hke__env": ["net1"]
    }

    removed = cleanup_job_docker(
        eval_root=eval_root,
        config_path=eval_root / "job.yaml",
        job_name="retry6",
        runtime=runtime,
    )

    assert [item.container_id for item in removed] == ["leftover1"]
    assert runtime.removed_containers == ["leftover1"]
    assert runtime.removed_networks == ["net1"]
