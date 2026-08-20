"""Resolve and prefetch the Docker images Harbor will start for a job."""

from __future__ import annotations

import argparse
import asyncio
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import yaml
from harbor.models.job.config import JobConfig
from harbor.models.task.id import PackageTaskId
from harbor.registry.client.package import PackageDatasetClient
from harbor.tasks.client import TaskClient

_FROM_INSTRUCTION = re.compile(
    r"^\s*FROM\s+(?:--platform=\S+\s+)?(?P<image>\S+)",
    re.IGNORECASE | re.MULTILINE,
)
_SKIP_FROM = {"scratch"}


def unique_images(images: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for image in images:
        if image in seen:
            continue
        seen.add(image)
        ordered.append(image)
    return ordered


def _add_image(images: list[str], value: object) -> None:
    if not isinstance(value, str):
        return
    image = value.strip()
    if not image or image.startswith("$") or image in _SKIP_FROM:
        return
    images.append(image)


def docker_images_from_task_dir(task_dir: Path) -> list[str]:
    """Return the image Harbor will actually start for this cached task."""
    images: list[str] = []
    task_toml = task_dir / "task.toml"
    if task_toml.is_file():
        payload = tomllib.loads(task_toml.read_text())
        environment = payload.get("environment")
        if isinstance(environment, dict):
            _add_image(images, environment.get("docker_image"))

    if images:
        return unique_images(images)

    dockerfile = task_dir / "environment" / "Dockerfile"
    if dockerfile.is_file():
        for match in _FROM_INSTRUCTION.finditer(dockerfile.read_text()):
            _add_image(images, match.group("image"))

    compose_path = task_dir / "environment" / "docker-compose.yaml"
    if compose_path.is_file():
        compose = yaml.safe_load(compose_path.read_text()) or {}
        services = compose.get("services") if isinstance(compose, dict) else None
        if isinstance(services, dict):
            for service in services.values():
                if isinstance(service, dict):
                    _add_image(images, service.get("image"))

    return unique_images(images)


def load_job_config(config_path: Path) -> JobConfig:
    payload = yaml.safe_load(config_path.read_text())
    return JobConfig.model_validate(payload)


async def download_job_task_dirs(config: JobConfig) -> list[Path]:
    package_client = PackageDatasetClient()
    task_client = TaskClient()
    dirs: list[Path] = []
    for dataset in config.datasets:
        if not dataset.name or not dataset.ref:
            raise ValueError("Job datasets must pin name and ref")
        metadata = await package_client.get_dataset_metadata(
            f"{dataset.name}@{dataset.ref}"
        )
        by_name = {task.get_name(): task for task in metadata.task_ids}
        names = dataset.task_names or sorted(by_name)
        missing = [name for name in names if name not in by_name]
        if missing:
            raise ValueError("Unknown dataset tasks: " + ", ".join(missing))
        task_ids: list[PackageTaskId] = []
        for name in names:
            task = by_name[name]
            if not isinstance(task, PackageTaskId):
                raise ValueError(f"Task {name} is not a package task")
            task_ids.append(task)
        batch = await task_client.download_tasks(task_ids, export=False)
        dirs.extend(batch.paths)
    return dirs


async def docker_images_for_job(config: JobConfig) -> list[str]:
    images: list[str] = []
    for task_dir in await download_job_task_dirs(config):
        found = docker_images_from_task_dir(task_dir)
        if not found:
            raise ValueError(f"No Docker image declared for task at {task_dir}")
        images.extend(found)
    return unique_images(images)


def image_is_cached(image: str) -> bool:
    inspect = subprocess.run(
        ["docker", "image", "inspect", image],
        check=False,
        capture_output=True,
    )
    return inspect.returncode == 0


def pull_image(image: str) -> None:
    print(f"Pulling {image}", flush=True)
    subprocess.run(["docker", "pull", image], check=True)


def prefetch_images(images: list[str]) -> None:
    for image in images:
        if image_is_cached(image):
            print(f"Cached {image}", flush=True)
            continue
        pull_image(image)
        if not image_is_cached(image):
            raise RuntimeError(f"Docker image still missing after pull: {image}")


async def async_main(config_path: Path) -> None:
    images = await docker_images_for_job(load_job_config(config_path))
    if not images:
        raise RuntimeError(f"No Docker images to prefetch for {config_path}")
    prefetch_images(images)
    print(f"Prefetched {len(images)} task image(s)", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Pull Harbor task Docker images before a job starts."
    )
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        asyncio.run(async_main(args.config))
    except (
        OSError,
        RuntimeError,
        ValueError,
        subprocess.CalledProcessError,
    ) as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
