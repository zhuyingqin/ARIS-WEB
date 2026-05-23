from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .agent_configs import dump_model, dump_updates, relative_config_path, slugify
from .models import TeamConfig, TeamConfigRequest, TeamEdge, TeamRoleSpec, UpdateTeamConfigRequest
from .storage import utc_now, web_dir
from .team_protocol import normalize_role_protocol


def team_configs_dir(workspace: Path) -> Path:
    return web_dir(workspace) / "team-configs"


def team_config_path(workspace: Path, team_id: str) -> Path:
    safe_id = slugify(team_id)
    return team_configs_dir(workspace) / f"{safe_id}.json"


def _validate_team_parts(roles: list[TeamRoleSpec], edges: list[TeamEdge]) -> None:
    role_ids: set[str] = set()
    for role in roles:
        role_id = slugify(role.id)
        if role_id in role_ids:
            raise ValueError(f"Duplicate team role id: {role_id}")
        role_ids.add(role_id)
    for edge in edges:
        if edge.source not in role_ids or edge.target not in role_ids:
            raise ValueError(f"Team edge references an unknown role: {edge.source} -> {edge.target}")
        if edge.source == edge.target:
            raise ValueError(f"Team edge cannot point to itself: {edge.source}")


def _normalize_roles(roles: list[TeamRoleSpec]) -> list[TeamRoleSpec]:
    normalized: list[TeamRoleSpec] = []
    for role in roles:
        role_id = slugify(role.id)
        protocol = normalize_role_protocol(
            role,
            id_text=role_id,
            name=role.name,
            role=role.role,
            prompt=role.prompt,
            skill=role.skill,
            kind_field="kind",
        )
        update = {"id": role_id, **protocol}
        normalized.append(
            role.model_copy(update=update) if hasattr(role, "model_copy")
            else role.copy(update=update)
        )
    return normalized


def _normalize_edges(edges: list[TeamEdge]) -> list[TeamEdge]:
    normalized: list[TeamEdge] = []
    for edge in edges:
        source = slugify(edge.source)
        target = slugify(edge.target)
        edge_id = edge.id or f"{source}->{target}"
        normalized.append(
            edge.model_copy(update={"id": edge_id, "source": source, "target": target}) if hasattr(edge, "model_copy")
            else edge.copy(update={"id": edge_id, "source": source, "target": target})
        )
    return normalized


def _config_from_path(workspace: Path, path: Path) -> TeamConfig:
    data = json.loads(path.read_text(encoding="utf-8"))
    now = utc_now()
    config_id = slugify(str(data.get("id") or path.stem))
    raw_roles = data.get("roles") if isinstance(data.get("roles"), list) else []
    raw_edges = data.get("default_edges") if isinstance(data.get("default_edges"), list) else []
    roles = _normalize_roles([TeamRoleSpec(**item) if isinstance(item, dict) else item for item in raw_roles])
    edges = _normalize_edges([TeamEdge(**item) if isinstance(item, dict) else item for item in raw_edges])
    _validate_team_parts(roles, edges)
    return TeamConfig(
        id=config_id,
        workspace=str(workspace),
        path=relative_config_path(workspace, path),
        name=str(data.get("name") or config_id),
        description=str(data.get("description") or ""),
        roles=roles,
        default_edges=edges,
        created_at=str(data.get("created_at") or now),
        updated_at=str(data.get("updated_at") or now),
    )


def list_team_configs(workspace: Path) -> list[TeamConfig]:
    root = team_configs_dir(workspace)
    if not root.exists():
        return []
    configs: list[TeamConfig] = []
    for path in sorted(root.glob("*.json")):
        try:
            configs.append(_config_from_path(workspace, path))
        except Exception:
            continue
    return configs


def get_team_config(workspace: Path, team_id_or_path: str) -> TeamConfig | None:
    raw = team_id_or_path.strip()
    if not raw:
        return None
    candidates = [team_config_path(workspace, raw)]
    if raw.endswith(".json"):
        candidate = (workspace / raw).resolve()
        try:
            candidate.relative_to(workspace.resolve())
            candidates.insert(0, candidate)
        except ValueError:
            return None
    for path in candidates:
        if path.exists() and path.is_file():
            return _config_from_path(workspace, path)
    return None


def save_team_config(workspace: Path, request: TeamConfigRequest) -> TeamConfig:
    config_id = slugify(request.id or request.name)
    roles = _normalize_roles(request.roles)
    edges = _normalize_edges(request.default_edges)
    _validate_team_parts(roles, edges)
    root = team_configs_dir(workspace)
    root.mkdir(parents=True, exist_ok=True)
    path = team_config_path(workspace, config_id)
    created_at = utc_now()
    if path.exists():
        try:
            created_at = _config_from_path(workspace, path).created_at
        except Exception:
            pass
    config = TeamConfig(
        id=config_id,
        workspace=str(workspace),
        path=relative_config_path(workspace, path),
        name=request.name,
        description=request.description,
        roles=roles,
        default_edges=edges,
        created_at=created_at,
        updated_at=utc_now(),
    )
    path.write_text(json.dumps(dump_model(config), ensure_ascii=False, indent=2), encoding="utf-8")
    return config


def update_team_config(workspace: Path, team_id: str, request: UpdateTeamConfigRequest) -> TeamConfig:
    current = get_team_config(workspace, team_id)
    if current is None:
        raise ValueError("Team config not found")
    data = dump_model(current)
    updates = dump_updates(request)
    for key, value in updates.items():
        if key not in {"workspace", "path", "id", "created_at", "updated_at"}:
            data[key] = value
    roles = _normalize_roles([TeamRoleSpec(**item) if isinstance(item, dict) else item for item in data.get("roles", [])])
    edges = _normalize_edges([TeamEdge(**item) if isinstance(item, dict) else item for item in data.get("default_edges", [])])
    _validate_team_parts(roles, edges)
    data["roles"] = [dump_model(role) for role in roles]
    data["default_edges"] = [dump_model(edge) for edge in edges]
    data["updated_at"] = utc_now()
    config = TeamConfig(**data)
    path = team_config_path(workspace, config.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dump_model(config), ensure_ascii=False, indent=2), encoding="utf-8")
    return _config_from_path(workspace, path)


def delete_team_config(workspace: Path, team_id: str) -> None:
    config = get_team_config(workspace, team_id)
    if config is None:
        raise ValueError("Team config not found")
    path = (workspace / config.path).resolve()
    path.unlink()
