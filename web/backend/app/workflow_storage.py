from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path
from typing import Any

from .models import ArtifactIndexEntry, PlannerDecisionRecord, WorkflowDeltaRecord, WorkflowEvent, WorkflowGraph, WorkflowRecord, WorkflowStatus
from .storage import utc_now, web_dir


def dump_model(model: Any) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def workflows_dir(workspace: Path) -> Path:
    return web_dir(workspace) / "workflows"


def workflow_db_path(workspace: Path) -> Path:
    return web_dir(workspace) / "workflows.sqlite"


def workflow_path(workspace: Path, workflow_id: str) -> Path:
    return workflows_dir(workspace) / workflow_id


def workflow_events_path(workspace: Path, workflow_id: str) -> Path:
    return workflow_path(workspace, workflow_id) / "events.jsonl"


def workflow_runtime_dir(workspace: Path, workflow_id: str) -> Path:
    return workflow_path(workspace, workflow_id) / "runtime"


def workflow_decisions_path(workspace: Path, workflow_id: str) -> Path:
    return workflow_runtime_dir(workspace, workflow_id) / "decisions.jsonl"


def workflow_deltas_path(workspace: Path, workflow_id: str) -> Path:
    return workflow_runtime_dir(workspace, workflow_id) / "deltas.jsonl"


def workflow_artifact_index_path(workspace: Path, workflow_id: str) -> Path:
    return workflow_runtime_dir(workspace, workflow_id) / "artifact_index.json"


def ensure_workflow_state(workspace: Path) -> None:
    workflows_dir(workspace).mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(workflow_db_path(workspace)) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workflows (
                id TEXT PRIMARY KEY,
                workspace TEXT NOT NULL,
                title TEXT NOT NULL,
                goal TEXT NOT NULL,
                status TEXT NOT NULL,
                graph_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                error TEXT
            )
            """
        )
        conn.commit()


def insert_workflow(record: WorkflowRecord) -> None:
    workspace = Path(record.workspace)
    ensure_workflow_state(workspace)
    workflow_path(workspace, record.id).mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(workflow_db_path(workspace)) as conn:
        conn.execute(
            """
            INSERT INTO workflows (
                id, workspace, title, goal, status, graph_json,
                created_at, updated_at, started_at, finished_at, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.workspace,
                record.title,
                record.goal,
                record.status,
                json.dumps(dump_model(record.graph_json), ensure_ascii=False),
                record.created_at,
                record.updated_at,
                record.started_at,
                record.finished_at,
                record.error,
            ),
        )
        conn.commit()


def _record_from_row(row: sqlite3.Row) -> WorkflowRecord:
    graph = WorkflowGraph(**json.loads(row["graph_json"] or "{}"))
    return WorkflowRecord(
        id=row["id"],
        workspace=row["workspace"],
        title=row["title"],
        goal=row["goal"],
        status=row["status"],
        graph_json=graph,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        error=row["error"],
    )


def get_workflow(workspace: Path, workflow_id: str) -> WorkflowRecord | None:
    ensure_workflow_state(workspace)
    with sqlite3.connect(workflow_db_path(workspace)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM workflows WHERE id = ?", (workflow_id,)).fetchone()
    return _record_from_row(row) if row else None


def list_workflows(workspaces: list[Any]) -> list[WorkflowRecord]:
    records: list[WorkflowRecord] = []
    for info in workspaces:
        workspace = Path(info.path)
        if not info.exists or not workflow_db_path(workspace).exists():
            continue
        with sqlite3.connect(workflow_db_path(workspace)) as conn:
            conn.row_factory = sqlite3.Row
            for row in conn.execute("SELECT * FROM workflows ORDER BY created_at DESC"):
                records.append(_record_from_row(row))
    return sorted(records, key=lambda item: item.updated_at, reverse=True)


def update_workflow(
    workspace: Path,
    workflow_id: str,
    *,
    title: str | None = None,
    goal: str | None = None,
    status: WorkflowStatus | None = None,
    graph_json: WorkflowGraph | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
    error: str | None = None,
    clear_error: bool = False,
) -> None:
    updates: dict[str, Any] = {"updated_at": utc_now()}
    if title is not None:
        updates["title"] = title
    if goal is not None:
        updates["goal"] = goal
    if status is not None:
        updates["status"] = status
    if graph_json is not None:
        updates["graph_json"] = json.dumps(dump_model(graph_json), ensure_ascii=False)
    if started_at is not None:
        updates["started_at"] = started_at
    if finished_at is not None:
        updates["finished_at"] = finished_at
    if clear_error:
        updates["error"] = None
    elif error is not None:
        updates["error"] = error

    keys = list(updates)
    assignments = ", ".join(f"{key} = ?" for key in keys)
    values = [updates[key] for key in keys]
    values.append(workflow_id)
    ensure_workflow_state(workspace)
    with sqlite3.connect(workflow_db_path(workspace)) as conn:
        conn.execute(f"UPDATE workflows SET {assignments} WHERE id = ?", values)
        conn.commit()


def delete_workflow(workspace: Path, workflow_id: str) -> None:
    ensure_workflow_state(workspace)
    with sqlite3.connect(workflow_db_path(workspace)) as conn:
        conn.execute("DELETE FROM workflows WHERE id = ?", (workflow_id,))
        conn.commit()
    shutil.rmtree(workflow_path(workspace, workflow_id), ignore_errors=True)


def append_workflow_event(workspace: Path, event: WorkflowEvent) -> None:
    path = workflow_events_path(workspace, event.workflow_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(dump_model(event), ensure_ascii=False) + "\n")


def _append_jsonl(path: Path, item: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(dump_model(item), ensure_ascii=False) + "\n")


def _read_jsonl(path: Path, model_type: Any) -> list[Any]:
    if not path.exists():
        return []
    items: list[Any] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            items.append(model_type(**json.loads(line)))
        except Exception:
            continue
    return items


def append_planner_decision(workspace: Path, record: PlannerDecisionRecord) -> None:
    _append_jsonl(workflow_decisions_path(workspace, record.workflow_id), record)


def list_planner_decisions(workspace: Path, workflow_id: str) -> list[PlannerDecisionRecord]:
    return _read_jsonl(workflow_decisions_path(workspace, workflow_id), PlannerDecisionRecord)


def append_workflow_delta(workspace: Path, record: WorkflowDeltaRecord) -> None:
    _append_jsonl(workflow_deltas_path(workspace, record.workflow_id), record)


def list_workflow_deltas(workspace: Path, workflow_id: str) -> list[WorkflowDeltaRecord]:
    return _read_jsonl(workflow_deltas_path(workspace, workflow_id), WorkflowDeltaRecord)


def write_artifact_index(workspace: Path, workflow_id: str, entries: list[ArtifactIndexEntry]) -> None:
    path = workflow_artifact_index_path(workspace, workflow_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([dump_model(item) for item in entries], ensure_ascii=False, indent=2), encoding="utf-8")


def read_artifact_index(workspace: Path, workflow_id: str) -> list[ArtifactIndexEntry]:
    path = workflow_artifact_index_path(workspace, workflow_id)
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(raw, list):
        return []
    entries: list[ArtifactIndexEntry] = []
    for item in raw:
        try:
            entries.append(ArtifactIndexEntry(**item))
        except Exception:
            continue
    return entries


def replay_workflow_events(workspace: Path, workflow_id: str) -> list[WorkflowEvent]:
    path = workflow_events_path(workspace, workflow_id)
    if not path.exists():
        return []
    events: list[WorkflowEvent] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            events.append(WorkflowEvent(**json.loads(line)))
        except Exception:
            continue
    return events
