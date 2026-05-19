from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .models import AgentConfig, AgentConfigRequest, UpdateAgentConfigRequest
from .storage import utc_now, web_dir


def dump_model(model: Any) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def dump_updates(model: Any) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_unset=True)
    return model.dict(exclude_unset=True)


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "agent-config"


def agent_configs_dir(workspace: Path) -> Path:
    return web_dir(workspace) / "agent-configs"


def agent_config_path(workspace: Path, config_id: str) -> Path:
    safe_id = slugify(config_id)
    return agent_configs_dir(workspace) / f"{safe_id}.json"


def relative_config_path(workspace: Path, path: Path) -> str:
    return path.resolve().relative_to(workspace.resolve()).as_posix()


def _config_from_path(workspace: Path, path: Path) -> AgentConfig:
    data = json.loads(path.read_text(encoding="utf-8"))
    now = utc_now()
    config_id = path.stem
    raw_timeout = data.get("timeout_seconds")
    timeout_seconds: int | None
    if raw_timeout is None:
        timeout_seconds = None
    else:
        try:
            timeout_seconds = int(raw_timeout)
        except (TypeError, ValueError):
            timeout_seconds = None
    return AgentConfig(
        id=str(data.get("id") or config_id),
        workspace=str(workspace),
        path=relative_config_path(workspace, path),
        name=str(data.get("name") or config_id),
        role=str(data.get("role") or ""),
        skill=data.get("skill") or None,
        model=data.get("model") or None,
        effort=data.get("effort") or None,
        system_prompt=str(data.get("system_prompt") or ""),
        prompt_prefix=str(data.get("prompt_prefix") or ""),
        output_contract=str(data.get("output_contract") or ""),
        timeout_seconds=timeout_seconds,
        created_at=str(data.get("created_at") or now),
        updated_at=str(data.get("updated_at") or now),
    )


def list_agent_configs(workspace: Path) -> list[AgentConfig]:
    root = agent_configs_dir(workspace)
    if not root.exists():
        return []
    configs: list[AgentConfig] = []
    for path in sorted(root.glob("*.json")):
        try:
            configs.append(_config_from_path(workspace, path))
        except Exception:
            continue
    return configs


def get_agent_config(workspace: Path, config_id_or_path: str) -> AgentConfig | None:
    raw = config_id_or_path.strip()
    if not raw:
        return None
    candidates = [agent_config_path(workspace, raw)]
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


def save_agent_config(workspace: Path, request: AgentConfigRequest) -> AgentConfig:
    config_id = slugify(request.id or request.name)
    root = agent_configs_dir(workspace)
    root.mkdir(parents=True, exist_ok=True)
    path = agent_config_path(workspace, config_id)
    created_at = utc_now()
    if path.exists():
        try:
            created_at = _config_from_path(workspace, path).created_at
        except Exception:
            pass
    config = AgentConfig(
        id=config_id,
        workspace=str(workspace),
        path=relative_config_path(workspace, path),
        name=request.name,
        role=request.role,
        skill=request.skill or None,
        model=request.model or None,
        effort=request.effort or None,
        system_prompt=request.system_prompt,
        prompt_prefix=request.prompt_prefix,
        output_contract=request.output_contract,
        timeout_seconds=request.timeout_seconds,
        created_at=created_at,
        updated_at=utc_now(),
    )
    path.write_text(json.dumps(dump_model(config), ensure_ascii=False, indent=2), encoding="utf-8")
    return config


def update_agent_config(workspace: Path, config_id: str, request: UpdateAgentConfigRequest) -> AgentConfig:
    current = get_agent_config(workspace, config_id)
    if current is None:
        raise ValueError("Agent config not found")
    data = dump_model(current)
    updates = dump_updates(request)
    for key, value in updates.items():
        if key not in {"workspace", "path", "id", "created_at", "updated_at"}:
            data[key] = value
    data["updated_at"] = utc_now()
    config = AgentConfig(**data)
    path = agent_config_path(workspace, config.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dump_model(config), ensure_ascii=False, indent=2), encoding="utf-8")
    return _config_from_path(workspace, path)


def delete_agent_config(workspace: Path, config_id: str) -> None:
    config = get_agent_config(workspace, config_id)
    if config is None:
        raise ValueError("Agent config not found")
    path = (workspace / config.path).resolve()
    path.unlink()
