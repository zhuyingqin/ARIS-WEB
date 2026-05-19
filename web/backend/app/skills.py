from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .config import SKILLS_DIR
from .models import SkillInfo

try:
    import yaml
except Exception:  # pragma: no cover - exercised only without PyYAML installed
    yaml = None


FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
EXCLUDED_PARTS = {".git", "__pycache__"}


def _simple_yaml(data: str) -> dict[str, Any]:
    """Tiny frontmatter fallback for key: value fields."""
    parsed: dict[str, Any] = {}
    for line in data.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        value = value.strip().strip("\"'")
        parsed[key.strip()] = value
    return parsed


def parse_skill_frontmatter(text: str) -> dict[str, Any]:
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}
    raw = match.group(1)
    if yaml is not None:
        loaded = yaml.safe_load(raw) or {}
        return loaded if isinstance(loaded, dict) else {}
    return _simple_yaml(raw)


def _skill_id(skill_file: Path, skills_dir: Path) -> tuple[str, str, str]:
    rel_parent = skill_file.parent.relative_to(skills_dir)
    parts = rel_parent.parts
    name = parts[-1]
    if len(parts) == 1:
        return name, name, "skills"
    package = "/".join(parts[:-1])
    return "/".join(parts), name, package


def scan_skills(skills_dir: Path = SKILLS_DIR) -> list[SkillInfo]:
    if not skills_dir.exists():
        return []

    skills: list[SkillInfo] = []
    for skill_file in sorted(skills_dir.rglob("SKILL.md")):
        if any(part in EXCLUDED_PARTS for part in skill_file.parts):
            continue
        text = skill_file.read_text(encoding="utf-8")
        meta = parse_skill_frontmatter(text)
        skill_id, fallback_name, package = _skill_id(skill_file, skills_dir)
        name = str(meta.get("name") or fallback_name)
        description = str(meta.get("description") or "").strip()
        argument_hint = str(meta.get("argument-hint") or meta.get("argument_hint") or "").strip()
        if not description:
            description = f"ARIS skill: {name}"
        skills.append(
            SkillInfo(
                id=skill_id,
                name=name,
                description=description,
                argument_hint=argument_hint,
                source_path=str(skill_file),
                package=package,
            )
        )
    return skills


def get_skill(skill_id: str, skills_dir: Path = SKILLS_DIR) -> SkillInfo | None:
    for skill in scan_skills(skills_dir):
        if skill.id == skill_id or skill.name == skill_id:
            return skill
    return None

