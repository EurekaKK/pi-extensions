from __future__ import annotations

from pathlib import Path

from pi_eval_harness.task_images import docker_images_from_task_dir, unique_images


def test_unique_images_keeps_first_occurrence() -> None:
    assert unique_images(["a", "b", "a", "c"]) == ["a", "b", "c"]


def test_prebuilt_docker_image_is_the_image_harbor_starts(tmp_path: Path) -> None:
    (tmp_path / "task.toml").write_text(
        """
[environment]
docker_image = "alexgshaw/feal-differential-cryptanalysis:20251031"
""".lstrip()
    )
    (tmp_path / "environment").mkdir()
    (tmp_path / "environment" / "Dockerfile").write_text(
        "FROM python:3.13-slim-bookworm\n"
    )

    assert docker_images_from_task_dir(tmp_path) == [
        "alexgshaw/feal-differential-cryptanalysis:20251031"
    ]


def test_dockerfile_from_is_used_when_no_prebuilt_image(tmp_path: Path) -> None:
    (tmp_path / "environment").mkdir()
    (tmp_path / "environment" / "Dockerfile").write_text(
        "FROM --platform=linux/amd64 python:3.13-slim-bookworm AS base\n"
        "FROM scratch\n"
        "FROM $NOT_AN_IMAGE\n"
        "FROM python:3.13-slim-bookworm\n"
    )

    assert docker_images_from_task_dir(tmp_path) == ["python:3.13-slim-bookworm"]


def test_compose_image_is_used_when_no_prebuilt_or_dockerfile_from(
    tmp_path: Path,
) -> None:
    (tmp_path / "environment").mkdir()
    (tmp_path / "environment" / "docker-compose.yaml").write_text(
        """
services:
  main:
    image: example/task:tag
  extra:
    image: example/sidecar:tag
""".lstrip()
    )

    assert docker_images_from_task_dir(tmp_path) == [
        "example/task:tag",
        "example/sidecar:tag",
    ]
