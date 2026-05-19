from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import REPO_ROOT, WEB_HOME
from .models import RunRecord, RunStatus, WorkspaceInfo


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_existing_dir(path: str | Path) -> Path:
    resolved = Path(path).expanduser().resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise ValueError(f"Workspace does not exist or is not a directory: {path}")
    return resolved


class WorkspaceStore:
    def __init__(self, home: Path = WEB_HOME, default_workspace: Path = REPO_ROOT):
        self.home = home
        self.path = home / "workspaces.json"
        self.default_workspace = default_workspace.resolve()

    def _read_raw(self) -> list[str]:
        if not self.path.exists():
            return [str(self.default_workspace)]
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return [str(self.default_workspace)]
        items = data.get("workspaces", []) if isinstance(data, dict) else []
        return [str(item) for item in items]

    def _write_raw(self, paths: list[str]) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"workspaces": paths}, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def list(self) -> list[WorkspaceInfo]:
        seen: set[str] = set()
        infos: list[WorkspaceInfo] = []
        for raw in self._read_raw():
            try:
                resolved = Path(raw).expanduser().resolve()
            except Exception:
                resolved = Path(raw)
            key = str(resolved)
            if key in seen:
                continue
            seen.add(key)
            infos.append(WorkspaceInfo(path=key, exists=resolved.exists() and resolved.is_dir()))
        if str(self.default_workspace) not in seen:
            infos.insert(0, WorkspaceInfo(path=str(self.default_workspace), exists=True))
        return infos

    def add(self, path: str | Path) -> WorkspaceInfo:
        resolved = resolve_existing_dir(path)
        current = [info.path for info in self.list() if info.exists]
        if str(resolved) not in current:
            current.append(str(resolved))
            self._write_raw(current)
        return WorkspaceInfo(path=str(resolved), exists=True)

    def require_allowed(self, path: str | Path) -> Path:
        resolved = resolve_existing_dir(path)
        allowed = {info.path for info in self.list() if info.exists}
        if str(resolved) not in allowed:
            raise ValueError(f"Workspace is not in the allowlist: {resolved}")
        return resolved


def web_dir(workspace: Path) -> Path:
    return workspace / ".aris" / "web"


def runs_dir(workspace: Path) -> Path:
    return web_dir(workspace) / "runs"


def db_path(workspace: Path) -> Path:
    return web_dir(workspace) / "runs.sqlite"


def ensure_workspace_state(workspace: Path) -> None:
    runs_dir(workspace).mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path(workspace)) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                workspace TEXT NOT NULL,
                skill TEXT NOT NULL,
                arguments TEXT NOT NULL,
                model TEXT,
                effort TEXT,
                assurance TEXT,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                exit_code INTEGER,
                command_json TEXT NOT NULL,
                last_message_path TEXT,
                error TEXT
            )
            """
        )
        conn.commit()


def run_path(workspace: Path, run_id: str) -> Path:
    return runs_dir(workspace) / run_id


def events_path(workspace: Path, run_id: str) -> Path:
    return run_path(workspace, run_id) / "events.jsonl"


def last_message_path(workspace: Path, run_id: str) -> Path:
    return run_path(workspace, run_id) / "last_message.md"


def node_output_path(workspace: Path, run_id: str) -> Path:
    """Structured per-run output written next to ``last_message.md``.

    Holds ``{"text": <last message body>, "json": <parsed-if-valid|null>}`` so
    downstream nodes and the workflow UI can consume a typed payload instead of
    re-parsing free-form text.
    """
    return run_path(workspace, run_id) / "node_output.json"


def insert_run(record: RunRecord) -> None:
    workspace = Path(record.workspace)
    ensure_workspace_state(workspace)
    run_path(workspace, record.id).mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path(workspace)) as conn:
        conn.execute(
            """
            INSERT INTO runs (
                id, workspace, skill, arguments, model, effort, assurance, status,
                created_at, updated_at, started_at, finished_at, exit_code,
                command_json, last_message_path, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.workspace,
                record.skill,
                record.arguments,
                record.model,
                record.effort,
                record.assurance,
                record.status,
                record.created_at,
                record.updated_at,
                record.started_at,
                record.finished_at,
                record.exit_code,
                json.dumps(record.command),
                record.last_message_path,
                record.error,
            ),
        )
        conn.commit()


def _record_from_row(row: sqlite3.Row) -> RunRecord:
    command = json.loads(row["command_json"] or "[]")
    return RunRecord(
        id=row["id"],
        workspace=row["workspace"],
        skill=row["skill"],
        arguments=row["arguments"],
        model=row["model"],
        effort=row["effort"],
        assurance=row["assurance"],
        status=row["status"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        exit_code=row["exit_code"],
        command=command,
        last_message_path=row["last_message_path"],
        error=row["error"],
    )


def list_runs(workspaces: list[WorkspaceInfo]) -> list[RunRecord]:
    records: list[RunRecord] = []
    for info in workspaces:
        workspace = Path(info.path)
        if not info.exists or not db_path(workspace).exists():
            continue
        with sqlite3.connect(db_path(workspace)) as conn:
            conn.row_factory = sqlite3.Row
            for row in conn.execute("SELECT * FROM runs ORDER BY created_at DESC"):
                records.append(_record_from_row(row))
    return sorted(records, key=lambda r: r.created_at, reverse=True)


def get_run(workspace: Path, run_id: str) -> RunRecord | None:
    ensure_workspace_state(workspace)
    with sqlite3.connect(db_path(workspace)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    return _record_from_row(row) if row else None


def update_run(
    workspace: Path,
    run_id: str,
    *,
    status: RunStatus | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
    exit_code: int | None = None,
    error: str | None = None,
) -> None:
    updates: dict[str, Any] = {"updated_at": utc_now()}
    if status is not None:
        updates["status"] = status
    if started_at is not None:
        updates["started_at"] = started_at
    if finished_at is not None:
        updates["finished_at"] = finished_at
    if exit_code is not None:
        updates["exit_code"] = exit_code
    if error is not None:
        updates["error"] = error

    keys = list(updates)
    assignments = ", ".join(f"{key} = ?" for key in keys)
    values = [updates[key] for key in keys]
    values.append(run_id)
    ensure_workspace_state(workspace)
    with sqlite3.connect(db_path(workspace)) as conn:
        conn.execute(f"UPDATE runs SET {assignments} WHERE id = ?", values)
        conn.commit()

