from __future__ import annotations

import base64
import mimetypes
import os
from datetime import datetime, timezone
from pathlib import Path

from .models import ArtifactInfo


ARTIFACT_SUFFIXES = {
    ".md",
    ".json",
    ".jsonl",
    ".html",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".svg",
    ".txt",
    ".tex",
    ".bib",
    ".csv",
    ".tsv",
    ".log",
}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache"}


def encode_artifact_id(relative_path: str) -> str:
    return base64.urlsafe_b64encode(relative_path.encode("utf-8")).decode("ascii").rstrip("=")


def decode_artifact_id(artifact_id: str) -> str:
    padding = "=" * (-len(artifact_id) % 4)
    return base64.urlsafe_b64decode((artifact_id + padding).encode("ascii")).decode("utf-8")


def ensure_inside(base: Path, target: Path) -> Path:
    base_resolved = base.resolve()
    target_resolved = target.resolve()
    try:
        target_resolved.relative_to(base_resolved)
    except ValueError as exc:
        raise ValueError("Path is outside the workspace") from exc
    return target_resolved


def resolve_workspace_file(workspace: Path, relative_path: str) -> Path:
    rel = Path(relative_path)
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError("Only relative paths inside the workspace are allowed")
    return ensure_inside(workspace, workspace / rel)


def resolve_artifact(workspace: Path, artifact_id: str) -> Path:
    return resolve_workspace_file(workspace, decode_artifact_id(artifact_id))


def artifact_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".md", ".tex", ".bib"}:
        return "document"
    if suffix in {".json", ".jsonl", ".csv", ".tsv"}:
        return "data"
    if suffix == ".html":
        return "html"
    if suffix == ".pdf":
        return "pdf"
    if suffix in {".png", ".jpg", ".jpeg", ".svg"}:
        return "image"
    return "text"


def guess_media_type(path: Path) -> str:
    media_type, _ = mimetypes.guess_type(path.name)
    return media_type or "application/octet-stream"


def list_artifacts(workspace: Path, limit: int = 500) -> list[ArtifactInfo]:
    workspace = workspace.resolve()
    aris_web = workspace / ".aris" / "web"
    aris_workflows = aris_web / "workflows"
    artifacts: list[ArtifactInfo] = []
    for root, dirs, files in os.walk(workspace):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        root_path = Path(root)
        if root_path == aris_web:
            dirs[:] = [d for d in dirs if d == "workflows"]
        elif root_path.parent == aris_web:
            dirs[:] = [d for d in dirs if root_path == aris_workflows]
        for file_name in files:
            if root_path == aris_web or root_path == aris_workflows:
                continue
            if root_path.parent == aris_workflows and file_name == "events.jsonl":
                continue
            path = root_path / file_name
            if path.suffix.lower() not in ARTIFACT_SUFFIXES:
                continue
            try:
                stat = path.stat()
                rel = path.resolve().relative_to(workspace).as_posix()
            except (OSError, ValueError):
                continue
            artifacts.append(
                ArtifactInfo(
                    id=encode_artifact_id(rel),
                    workspace=str(workspace),
                    path=rel,
                    name=path.name,
                    kind=artifact_kind(path),
                    size=stat.st_size,
                    modified_at=datetime.fromtimestamp(stat.st_mtime, timezone.utc).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    ),
                )
            )
    return sorted(artifacts, key=lambda item: item.modified_at, reverse=True)[:limit]

