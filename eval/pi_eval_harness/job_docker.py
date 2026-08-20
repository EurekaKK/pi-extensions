"""Tear down leftover Harbor trial containers after a job. Does not delete images."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from pi_eval_harness.task_images import load_job_config

_COMPOSE_PROJECT_LABEL = "com.docker.compose.project"


@dataclass(frozen=True)
class ContainerSnapshot:
    container_id: str
    name: str
    compose_project: str | None
    mount_sources: tuple[str, ...]


class DockerRuntime(Protocol):
    def list_containers(self) -> list[ContainerSnapshot]: ...

    def remove_containers(self, container_ids: list[str]) -> None: ...

    def list_network_ids(self, compose_project: str) -> list[str]: ...

    def remove_networks(self, network_ids: list[str]) -> None: ...


def harbor_compose_project(trial_name: str) -> str:
    return f"{trial_name.lower()}__env"


def resolve_jobs_dir(eval_root: Path, jobs_dir: Path) -> Path:
    if jobs_dir.is_absolute():
        return jobs_dir.resolve()
    return (eval_root / jobs_dir).resolve()


def job_run_dir(jobs_dir: Path, job_name: str) -> Path:
    return (jobs_dir / job_name).resolve()


def job_has_finished(job_dir: Path) -> bool:
    result_path = job_dir / "result.json"
    if not result_path.is_file():
        return False
    try:
        payload = json.loads(result_path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(payload, dict):
        return False
    finished = payload.get("finished_at")
    return finished not in (None, "")


def trial_names_in_job_dir(job_dir: Path) -> list[str]:
    if not job_dir.is_dir():
        return []
    names: list[str] = []
    for child in job_dir.iterdir():
        if child.is_dir() and (child / "config.json").is_file():
            names.append(child.name)
    return sorted(names)


def mount_belongs_to_job(source: str, job_dir: Path) -> bool:
    try:
        resolved = Path(source).resolve()
        root = job_dir.resolve()
    except OSError:
        return False
    return resolved == root or root in resolved.parents


def job_dirs_to_sweep(jobs_dir: Path, job_name: str) -> list[Path]:
    """Current job plus sibling jobs whose result.json already has finished_at."""
    jobs_dir = jobs_dir.resolve()
    ordered: list[Path] = []
    seen: set[Path] = set()

    def add(path: Path) -> None:
        resolved = path.resolve()
        if resolved in seen:
            return
        seen.add(resolved)
        ordered.append(resolved)

    add(job_run_dir(jobs_dir, job_name))
    if jobs_dir.is_dir():
        for child in sorted(jobs_dir.iterdir()):
            if not child.is_dir() or child.name == job_name:
                continue
            if job_has_finished(child):
                add(child)
    return ordered


def compose_projects_for_job_dirs(job_dirs: list[Path]) -> set[str]:
    projects: set[str] = set()
    for job_dir in job_dirs:
        for trial_name in trial_names_in_job_dir(job_dir):
            projects.add(harbor_compose_project(trial_name))
    return projects


def containers_to_remove(
    snapshots: list[ContainerSnapshot],
    job_dirs: list[Path],
) -> list[ContainerSnapshot]:
    projects = compose_projects_for_job_dirs(job_dirs)
    selected: list[ContainerSnapshot] = []
    seen_ids: set[str] = set()
    for snapshot in snapshots:
        belongs = False
        if snapshot.compose_project and snapshot.compose_project in projects:
            belongs = True
        else:
            for source in snapshot.mount_sources:
                if any(mount_belongs_to_job(source, job_dir) for job_dir in job_dirs):
                    belongs = True
                    break
        if not belongs or snapshot.container_id in seen_ids:
            continue
        seen_ids.add(snapshot.container_id)
        selected.append(snapshot)
    return selected


def snapshot_from_inspect(payload: object) -> ContainerSnapshot:
    if not isinstance(payload, dict):
        raise ValueError("docker inspect entry must be an object")
    config = payload.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    project: str | None = None
    if isinstance(labels, dict):
        raw_project = labels.get(_COMPOSE_PROJECT_LABEL)
        if isinstance(raw_project, str) and raw_project:
            project = raw_project
    sources: list[str] = []
    mounts = payload.get("Mounts")
    if isinstance(mounts, list):
        for mount in mounts:
            if isinstance(mount, dict):
                source = mount.get("Source")
                if isinstance(source, str) and source:
                    sources.append(source)
    container_id = payload.get("Id")
    if not isinstance(container_id, str) or not container_id:
        raise ValueError("docker inspect entry is missing Id")
    name = payload.get("Name")
    display_name = name.lstrip("/") if isinstance(name, str) else container_id[:12]
    return ContainerSnapshot(
        container_id=container_id,
        name=display_name,
        compose_project=project,
        mount_sources=tuple(sources),
    )


class SubprocessDockerRuntime:
    def list_containers(self) -> list[ContainerSnapshot]:
        listed = subprocess.run(
            ["docker", "ps", "-aq"],
            check=False,
            capture_output=True,
            text=True,
        )
        if listed.returncode != 0:
            raise RuntimeError(listed.stderr.strip() or "docker ps failed")
        ids = listed.stdout.split()
        if not ids:
            return []
        inspected = subprocess.run(
            ["docker", "inspect", *ids],
            check=False,
            capture_output=True,
            text=True,
        )
        if inspected.returncode != 0:
            raise RuntimeError(inspected.stderr.strip() or "docker inspect failed")
        payload = json.loads(inspected.stdout)
        entries = payload if isinstance(payload, list) else [payload]
        return [snapshot_from_inspect(entry) for entry in entries]

    def remove_containers(self, container_ids: list[str]) -> None:
        if not container_ids:
            return
        removed = subprocess.run(
            ["docker", "rm", "-f", *container_ids],
            check=False,
            capture_output=True,
            text=True,
        )
        if removed.returncode != 0:
            raise RuntimeError(removed.stderr.strip() or "docker rm failed")

    def list_network_ids(self, compose_project: str) -> list[str]:
        listed = subprocess.run(
            [
                "docker",
                "network",
                "ls",
                "--filter",
                f"label={_COMPOSE_PROJECT_LABEL}={compose_project}",
                "-q",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if listed.returncode != 0:
            raise RuntimeError(listed.stderr.strip() or "docker network ls failed")
        return listed.stdout.split()

    def remove_networks(self, network_ids: list[str]) -> None:
        if not network_ids:
            return
        removed = subprocess.run(
            ["docker", "network", "rm", *network_ids],
            check=False,
            capture_output=True,
            text=True,
        )
        if removed.returncode != 0:
            raise RuntimeError(removed.stderr.strip() or "docker network rm failed")


def cleanup_job_docker(
    *,
    eval_root: Path,
    config_path: Path,
    job_name: str,
    runtime: DockerRuntime,
) -> list[ContainerSnapshot]:
    config = load_job_config(config_path)
    jobs_dir = resolve_jobs_dir(eval_root, config.jobs_dir)
    job_dirs = job_dirs_to_sweep(jobs_dir, job_name)
    selected = containers_to_remove(runtime.list_containers(), job_dirs)
    if selected:
        runtime.remove_containers([item.container_id for item in selected])
    projects = {
        item.compose_project for item in selected if item.compose_project
    } | compose_projects_for_job_dirs(job_dirs)
    network_ids: list[str] = []
    seen_networks: set[str] = set()
    for project in sorted(projects):
        for network_id in runtime.list_network_ids(project):
            if network_id in seen_networks:
                continue
            seen_networks.add(network_id)
            network_ids.append(network_id)
    runtime.remove_networks(network_ids)
    return selected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Remove leftover Harbor trial containers for a job. Does not delete images."
        )
    )
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--job-name", required=True)
    parser.add_argument("--eval-root", type=Path, default=None)
    args = parser.parse_args(argv)
    eval_root = (args.eval_root or Path.cwd()).resolve()
    try:
        removed = cleanup_job_docker(
            eval_root=eval_root,
            config_path=args.config,
            job_name=args.job_name,
            runtime=SubprocessDockerRuntime(),
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(exc, file=sys.stderr)
        return 1
    if not removed:
        print("No leftover Harbor trial containers", flush=True)
        return 0
    print(f"Removed {len(removed)} leftover Harbor trial container(s)", flush=True)
    for item in removed:
        print(f"  {item.name}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
