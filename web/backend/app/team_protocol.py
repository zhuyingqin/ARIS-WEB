from __future__ import annotations

import re
from typing import Any


ROLE_KIND_VALUES = {"planner", "reviewer", "literature", "writer", "citation", "worker", "gate"}


def infer_role_kind(
    *,
    text: str = "",
    node_type: str = "",
    task_type: str = "",
    skill: str | None = None,
) -> str:
    haystack = f"{text} {node_type} {task_type} {skill or ''}".lower()
    if node_type == "human_gate" or task_type == "gate" or re.search(r"\b(gate|approval|checkpoint)\b|人工|审批", haystack):
        return "gate"
    if re.search(r"\b(planner|manager|coordinator|plan|outline)\b|规划|计划", haystack):
        return "planner"
    if re.search(r"\b(review|reviewer|critic|audit)\b|审查|审阅", haystack):
        return "reviewer"
    if re.search(r"\b(citation|reference|bibliography|bibtex)\b|引用|插文献", haystack):
        return "citation"
    if re.search(r"\b(literature|research-lit|openalex|search|scout|survey)\b|文献|调研", haystack):
        return "literature"
    if re.search(r"\b(write|writer|draft|author|paper-write|revision)\b|写作|撰写|改写", haystack):
        return "writer"
    return "worker"


def default_scope_for_kind(kind: str) -> str:
    if kind == "planner":
        return "Explain the problem in chat, split work, read human-language updates, and route the next task."
    if kind == "reviewer":
        return "Raise quality questions, evidence gaps, and rework suggestions; leave routing decisions to the planner."
    if kind == "literature":
        return "Search and organize literature evidence, then report concise findings with artifact references."
    if kind == "writer":
        return "Write or revise paper text from available materials, reporting results, risks, and artifact links."
    if kind == "citation":
        return "Insert and verify citations and bibliography formatting from confirmed sources."
    if kind == "gate":
        return "Record human approval, pause, or rework decisions."
    return "Autonomously complete assigned work and report concise status with artifact references."


def protocol_defaults(kind: str) -> dict[str, bool]:
    if kind == "planner":
        return {
            "can_ask_questions": True,
            "can_clone_workers": False,
            "can_call_planner": False,
            "peer_access": True,
            "reports_to_chat": True,
        }
    if kind == "reviewer":
        return {
            "can_ask_questions": True,
            "can_clone_workers": False,
            "can_call_planner": False,
            "peer_access": True,
            "reports_to_chat": True,
        }
    if kind == "gate":
        return {
            "can_ask_questions": True,
            "can_clone_workers": False,
            "can_call_planner": False,
            "peer_access": False,
            "reports_to_chat": True,
        }
    return {
        "can_ask_questions": False,
        "can_clone_workers": True,
        "can_call_planner": False,
        "peer_access": True,
        "reports_to_chat": True,
    }


def _explicit_fields(value: Any) -> set[str]:
    fields = getattr(value, "model_fields_set", None)
    if fields is not None:
        return set(fields)
    fields = getattr(value, "__fields_set__", None)
    if fields is not None:
        return set(fields)
    return set()


def normalize_role_protocol(
    value: Any,
    *,
    id_text: str = "",
    name: str = "",
    role: str = "",
    prompt: str = "",
    node_type: str = "",
    task_type: str = "",
    skill: str | None = None,
    kind_field: str = "kind",
) -> dict[str, Any]:
    explicit = _explicit_fields(value)
    raw_kind = getattr(value, kind_field, None)
    if raw_kind in ROLE_KIND_VALUES and kind_field in explicit:
        kind = raw_kind
    else:
        kind = infer_role_kind(
            text=f"{id_text} {name} {role} {prompt}",
            node_type=node_type,
            task_type=task_type,
            skill=skill,
        )
    scope = str(getattr(value, "scope", "") or "").strip() or default_scope_for_kind(kind)
    defaults = protocol_defaults(kind)
    return {
        kind_field: kind,
        "scope": scope,
        "can_ask_questions": getattr(value, "can_ask_questions", None)
        if getattr(value, "can_ask_questions", None) is not None
        else defaults["can_ask_questions"],
        "can_clone_workers": getattr(value, "can_clone_workers", None)
        if getattr(value, "can_clone_workers", None) is not None
        else defaults["can_clone_workers"],
        "can_call_planner": getattr(value, "can_call_planner", None)
        if getattr(value, "can_call_planner", None) is not None
        else defaults["can_call_planner"],
        "peer_access": getattr(value, "peer_access", None)
        if getattr(value, "peer_access", None) is not None
        else defaults["peer_access"],
        "reports_to_chat": getattr(value, "reports_to_chat", None)
        if getattr(value, "reports_to_chat", None) is not None
        else defaults["reports_to_chat"],
    }


def normalize_node_protocol(value: Any, *, skill: str | None = None, config_file: str | None = None) -> dict[str, Any]:
    text = " ".join(
        str(item or "")
        for item in (
            getattr(value, "team_role_id", ""),
            getattr(value, "assignee_role", ""),
            getattr(value, "role", ""),
            getattr(value, "name", ""),
            getattr(value, "objective", ""),
            config_file,
        )
    )
    return normalize_role_protocol(
        value,
        id_text=str(getattr(value, "id", "")),
        name=str(getattr(value, "name", "")),
        role=text,
        prompt=str(getattr(value, "prompt", "")),
        node_type=str(getattr(value, "type", "")),
        task_type=str(getattr(value, "task_type", "")),
        skill=skill or getattr(value, "skill", None),
        kind_field="team_role_kind",
    )
