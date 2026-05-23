from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import ssl
import urllib.error
import urllib.request
import uuid
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from .agent_configs import get_agent_config
from .artifacts import ARTIFACT_SUFFIXES, artifact_kind
from .global_settings import (
    build_runtime_env,
    effective_effort_override,
    effective_model_override,
    get_planner_llm_settings,
    planner_llm_summary,
    openai_compatible_settings,
)
from .models import (
    ArtifactIndexEntry,
    CreateRunRequest,
    NodeUsage,
    PlanSnapshot,
    PlannerDecision,
    PlannerDecisionRecord,
    PlannerDecisionType,
    PolicyResult,
    RuntimePolicy,
    RuntimeSummary,
    RunEvent,
    RetryPolicy,
    SessionRuntimeView,
    TaskBoardColumnSummary,
    TaskBoardResponse,
    TaskBoardTask,
    TaskClaimRequest,
    TaskReviewRequest,
    TeamMessage,
    WorkflowHandoff,
    WorkflowEdge,
    WorkflowDelta,
    WorkflowDeltaRecord,
    WorkflowEvent,
    WorkflowGraph,
    WorkflowNode,
    WorkflowRecord,
    WorkflowRuntimeResponse,
)
from .team_protocol import default_scope_for_kind, normalize_node_protocol, protocol_defaults
from .pricing import (
    estimate_cost_usd,
    extract_usage_from_payload,
    pricing_for_model,
)
from .runner import RunManager, build_aris_command, expand_codex_payload_events
from .skills import SkillInfo, get_skill, scan_skills
from .storage import get_run, last_message_path, node_output_path, utc_now
from .team_configs import get_team_config
from .workflow_storage import (
    append_workflow_event,
    append_planner_decision,
    append_workflow_delta,
    delete_workflow,
    get_workflow,
    insert_workflow,
    list_planner_decisions,
    list_workflows,
    list_workflow_deltas,
    read_artifact_index,
    replay_workflow_events,
    update_workflow,
    write_artifact_index,
)

try:
    import certifi
except Exception:  # pragma: no cover - certifi may be unavailable in minimal installs
    certifi = None


TERMINAL_NODE_STATUSES = {"succeeded", "skipped", "cancelled", "failed"}
SUCCESS_NODE_STATUSES = {"succeeded", "skipped"}
EXECUTABLE_NODE_TYPES = {"agent", "sub_agent"}
HANDOFF_PREVIEW_CHARS = 900

DEFAULT_SKILL_BY_TASK_TYPE = {
    "goal": "paper-plan",
    "planning": "paper-plan",
    "research": "research-lit",
    "analysis": "analyze-results",
    "writing": "paper-write",
    "review": "research-review",
}

DEFAULT_SKILL_BY_ROLE_HINT = [
    (("planner", "planning", "plan", "outline"), "paper-plan"),
    (("reviewer", "review", "critic", "审查", "审阅"), "research-review"),
    (("writer", "writing", "draft", "author", "写作"), "paper-write"),
    (("literature", "research", "search", "scout", "文献", "调研"), "research-lit"),
    (("analysis", "analyzer", "分析"), "analyze-results"),
]


@dataclass
class NodeRunResult:
    run_id: str | None
    succeeded: bool
    message: str = ""
    error: str | None = None


NodeRunner = Callable[[Path, WorkflowRecord, WorkflowNode], Awaitable[NodeRunResult]]
PlannerRunner = Callable[[Path, WorkflowRecord, str], Awaitable[PlannerDecision | dict[str, Any] | None]]


def model_dict(value):
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return value.dict()


def prompt_context_data(value):
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    if isinstance(value, list):
        return [prompt_context_data(item) for item in value]
    if isinstance(value, dict):
        return {key: prompt_context_data(item) for key, item in value.items()}
    return value


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _safe_node_slug(value: object, fallback: str) -> str:
    slug = _slug(str(value))
    return slug[:42].strip("-") or fallback


def default_skill_for_node(node: WorkflowNode, known_skills: set[str] | None = None) -> str | None:
    if node.type not in EXECUTABLE_NODE_TYPES:
        return None
    if node.team_role_kind == "planner":
        return None
    haystack = f"{node.role} {node.assignee_role or ''} {node.name} {node.objective}".lower()
    if re.search(r"\b(planner|manager)\b|规划员|计划员", haystack):
        return None
    if "openalex" in haystack and (known_skills is None or "openalex-search" in known_skills):
        return "openalex-search"
    candidate = DEFAULT_SKILL_BY_TASK_TYPE.get(node.task_type)
    if candidate and (known_skills is None or candidate in known_skills):
        return candidate
    for hints, skill_id in DEFAULT_SKILL_BY_ROLE_HINT:
        if any(hint in haystack for hint in hints) and (known_skills is None or skill_id in known_skills):
            return skill_id
    return None


def workflow_event_type_for_run_stream(stream: str) -> str:
    if stream == "codex":
        return "aris"
    if stream in {"thinking", "tool", "result"}:
        return stream
    if stream in {"stdout", "stderr"}:
        return stream
    return "run"


def expand_replayed_workflow_event(event: WorkflowEvent) -> list[WorkflowEvent]:
    if event.event_type != "aris" or not isinstance(event.payload, dict):
        return [event]
    expanded = expand_codex_payload_events(event.run_id or "", event.payload)
    if len(expanded) == 1 and expanded[0].stream == "codex":
        return [event]
    return [
        WorkflowEvent(
            workflow_id=event.workflow_id,
            timestamp=event.timestamp,
            event_type=workflow_event_type_for_run_stream(item.stream),
            node_id=event.node_id,
            run_id=event.run_id,
            message=item.message,
            payload=item.payload,
        )
        for item in expanded
    ]


def concrete_output_paths(outputs) -> list[Path]:
    """Collect file paths that an agent must produce.

    Accepts either the legacy ``list[str]`` form or the new ``list[PortSpec]``.
    A port contributes a path when:
      - ``port.type == "file"`` (explicit), OR
      - ``port.name`` ends with a known extension (legacy heuristic).
    Names containing " or " / "," are treated as descriptions, not paths.
    """
    paths: list[Path] = []
    for output in outputs:
        # PortSpec or legacy str — normalize to (name, port_type).
        if hasattr(output, "name") and hasattr(output, "type"):
            name = (output.name or "").strip()
            port_type = output.type
        else:
            name = str(output).strip()
            port_type = "text"
        if not name or " or " in name or "," in name:
            continue
        if port_type == "file":
            paths.append(Path(name))
            continue
        if re.search(r"\.(md|markdown|tex|html|pdf)$", name, flags=re.IGNORECASE):
            paths.append(Path(name))
    return paths


def node_attempt_dir(workspace: Path, workflow_id: str, node: WorkflowNode) -> Path:
    return workspace / ".aris" / "web" / "workflows" / workflow_id / "nodes" / node.id / f"attempt-{node.attempt + 1}"


def workflow_output_path(workspace: Path, workflow_id: str, node: WorkflowNode, output_path: Path) -> Path:
    if output_path.is_absolute():
        return output_path
    if output_path.parts and output_path.parts[0] == ".aris":
        return workspace / output_path
    return node_attempt_dir(workspace, workflow_id, node) / output_path


def workflow_output_relative_path(workspace: Path, workflow_id: str, node: WorkflowNode, output_path: Path) -> str:
    try:
        return workflow_output_path(workspace, workflow_id, node, output_path).resolve().relative_to(workspace.resolve()).as_posix()
    except ValueError:
        return output_path.as_posix()


def reconcile_declared_outputs(workspace: Path, workflow_id: str, node: WorkflowNode, *, not_before: str | None = None) -> list[dict[str, str]]:
    """Move declared outputs accidentally written at workspace root into the node attempt dir."""

    moved: list[dict[str, str]] = []
    workspace_root = workspace.resolve()
    for output_path in concrete_output_paths(node.outputs):
        if output_path.is_absolute() or (output_path.parts and output_path.parts[0] == ".aris"):
            continue
        expected = workflow_output_path(workspace, workflow_id, node, output_path).resolve()
        fallback = (workspace / output_path).resolve()
        if expected.exists() or not fallback.exists() or not fallback.is_file() or fallback == expected:
            continue
        if workspace_root not in [fallback, *fallback.parents] or workspace_root not in [expected, *expected.parents]:
            continue
        modified_at = time_from_stat(fallback.stat().st_mtime)
        if not_before and modified_at < not_before:
            continue
        expected.parent.mkdir(parents=True, exist_ok=True)
        fallback.replace(expected)
        moved.append(
            {
                "from": fallback.relative_to(workspace_root).as_posix(),
                "to": expected.relative_to(workspace_root).as_posix(),
                "modified_at": modified_at,
            }
        )
    return moved


def workflow_node_session_path(workspace: Path, workflow_id: str, node_id: str) -> Path:
    return workspace / ".aris" / "web" / "workflows" / workflow_id / "nodes" / node_id / "session.json"


def clear_workflow_node_sessions(workspace: Path, workflow_id: str, graph: WorkflowGraph) -> int:
    workspace_root = workspace.resolve()
    removed = 0
    candidates: set[Path] = set()
    for node in graph.nodes:
        candidates.add(workflow_node_session_path(workspace, workflow_id, node.id))
        if node.session_path:
            session_path = Path(node.session_path)
            candidates.add(session_path.resolve() if session_path.is_absolute() else (workspace / session_path).resolve())
    for path in candidates:
        try:
            resolved = path.resolve()
            if workspace_root not in [resolved, *resolved.parents] or not resolved.exists() or not resolved.is_file():
                continue
            resolved.unlink()
            removed += 1
        except OSError:
            continue
    return removed


def planner_session_path(workspace: Path, workflow_id: str) -> Path:
    return workspace / ".aris" / "web" / "workflows" / workflow_id / "planner" / "session.json"


def ensure_research_wiki(workspace: Path) -> Path:
    root = workspace / "research-wiki"
    for child in ("papers", "ideas", "experiments", "claims", "graph"):
        (root / child).mkdir(parents=True, exist_ok=True)
    log_path = root / "log.md"
    if not log_path.exists():
        log_path.write_text("# Research Wiki Log\n", encoding="utf-8")
    return root


def compact_research_wiki_pack(workspace: Path, *, limit: int = 8000) -> str:
    root = workspace / "research-wiki"
    if not root.exists():
        return "(research-wiki not initialized)"
    parts: list[str] = []
    for rel in ("README.md", "query_pack.md", "log.md"):
        path = root / rel
        if path.exists():
            try:
                parts.append(f"## {rel}\n{path.read_text(encoding='utf-8', errors='replace')[-limit // 3:]}")
            except OSError:
                continue
    paper_dir = root / "papers"
    if paper_dir.exists():
        papers = []
        for path in sorted(paper_dir.glob("*.md"), key=lambda item: item.stat().st_mtime if item.exists() else 0, reverse=True)[:12]:
            try:
                papers.append(f"### papers/{path.name}\n{path.read_text(encoding='utf-8', errors='replace')[:900]}")
            except OSError:
                continue
        if papers:
            parts.append("## Recent papers\n" + "\n\n".join(papers))
    text = "\n\n".join(parts).strip()
    return text[-limit:] if text else "(research-wiki empty)"


def compact_recent_artifact_pack(workspace: Path, workflow_id: str, *, limit: int = 10000) -> str:
    suffixes = {".md", ".markdown", ".json", ".txt", ".tex"}
    candidates: list[Path] = []
    try:
        for path in workspace.iterdir():
            if path.is_file() and path.suffix.lower() in suffixes:
                candidates.append(path)
    except OSError:
        pass

    node_root = workspace / ".aris" / "web" / "workflows" / workflow_id / "nodes"
    if node_root.exists():
        try:
            for path in node_root.rglob("*"):
                if path.is_file() and path.suffix.lower() in suffixes and path.name != "session.json":
                    candidates.append(path)
        except OSError:
            pass

    def mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    parts: list[str] = []
    seen: set[Path] = set()
    for path in sorted(candidates, key=mtime, reverse=True):
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if len(parts) >= 14:
            break
        try:
            if path.stat().st_size > 512_000:
                continue
            rel = resolved.relative_to(workspace.resolve()).as_posix()
            text = path.read_text(encoding="utf-8", errors="replace").strip()
        except (OSError, ValueError):
            continue
        if not text:
            continue
        parts.append(f"## {rel}\n{text[:1200]}")

    text = "\n\n".join(parts).strip()
    return text[-limit:] if text else "(no recent text artifacts found)"


def sync_literature_result_to_wiki(workspace: Path, workflow_id: str, node: WorkflowNode) -> None:
    if node.skill not in LITERATURE_SKILLS:
        return
    result_path = workflow_output_path(workspace, workflow_id, node, Path("literature_result.json"))
    if not result_path.exists():
        return
    try:
        raw = json.loads(result_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    wiki = ensure_research_wiki(workspace)
    query = str(raw.get("query") or research_query_from_request(node.research_request) or node.name).strip()
    findings = raw.get("findings")
    gaps = raw.get("gaps")
    papers = raw.get("papers")
    entry = {
        "node_id": node.id,
        "query": query,
        "result": result_path.resolve().relative_to(workspace.resolve()).as_posix(),
        "paper_count": len(papers) if isinstance(papers, list) else None,
    }
    with (wiki / "log.md").open("a", encoding="utf-8") as fh:
        fh.write("\n")
        fh.write(f"## Literature update: {node.id}\n")
        fh.write(json.dumps(entry, ensure_ascii=False, indent=2))
        fh.write("\n")
    pack_lines = [f"# Latest Literature Query Pack\n", f"## Query\n{query}\n"]
    if findings is not None:
        pack_lines.append(f"## Findings\n{_template_value_to_text(findings)}\n")
    if gaps is not None:
        pack_lines.append(f"## Gaps\n{_template_value_to_text(gaps)}\n")
    if papers is not None:
        pack_lines.append(f"## Papers\n{_template_value_to_text(papers)}\n")
    (wiki / "query_pack.md").write_text("\n".join(pack_lines), encoding="utf-8")


def dynamic_literature_node_id(caller_id: str | None, query: str) -> str:
    caller = _safe_node_slug(caller_id or "workflow", "workflow")
    query_slug = _safe_node_slug(query, "research")
    digest = hashlib.sha1(f"{caller_id or ''}\n{query}".encode("utf-8")).hexdigest()[:8]
    return f"lit-{caller}-{query_slug[:30]}-{digest}"


def research_query_from_request(request: dict[str, Any] | None) -> str:
    if not request:
        return ""
    for key in ("query", "topic", "question", "keywords"):
        value = request.get(key)
        if isinstance(value, list):
            text = ", ".join(str(item) for item in value if str(item).strip())
        else:
            text = str(value or "").strip()
        if text:
            return text
    return json.dumps(request, ensure_ascii=False, sort_keys=True)


GAP_MARKER_RE = re.compile(
    r"\[(?P<tag>LITERATURE_NEEDED|CITATION_NEEDED|EVIDENCE_NEEDED)\s*:?\s*(?P<body>[^\]\n]{0,240})\]",
    re.IGNORECASE,
)
GAP_PHRASES = (
    "literature needed",
    "citation needed",
    "evidence needed",
    "citation gap",
    "missing citation",
    "missing citations",
    "needs literature",
    "needs citation",
    "needs evidence",
    "unsupported claim",
    "unsupported claims",
    "引用需要核实",
    "需要文献",
    "缺少引用",
    "证据不足",
)
LITERATURE_SKILLS = {"research-lit", "openalex-search"}
PLANNER_CONTROL_PLANE_TOOLS = [
    "write",
    "edit",
    "TodoWrite",
    "Sleep",
    "SendUserMessage",
    "Config",
    "StructuredOutput",
]
ARTIFACT_WORKER_TOOLS = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "TodoWrite",
    "Skill",
    "Sleep",
    "SendUserMessage",
    "Config",
    "StructuredOutput",
]
REVIEWER_TOOLS = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "TodoWrite",
    "LlmReview",
    "Skill",
    "Sleep",
    "SendUserMessage",
    "Config",
    "StructuredOutput",
]
LITERATURE_WORKER_TOOLS = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "Skill",
    "ToolSearch",
    "Sleep",
    "SendUserMessage",
    "Config",
    "StructuredOutput",
]
CLONE_MARKER_RE = re.compile(
    r"\[(?P<tag>CLONE_WORKERS?|COPY_WORKERS?|复制员工)\s*:?\s*(?P<body>[^\]\n]{0,360})\]",
    re.IGNORECASE,
)
WORKER_QUESTION_RE = re.compile(
    r"\[(?P<tag>ASK_WORKER|QUESTION_FOR_WORKER|提问员工)\s*:?\s*(?P<body>[^\]\n]{0,520})\]",
    re.IGNORECASE,
)
QUESTION_LINE_RE = re.compile(
    r"(^|\n)\s*(?:"
    r"please\s+clarify|can\s+you|could\s+you|should\s+i|do\s+you\s+want|"
    r"请问|能否|是否要|要不要|需要你|你希望"
    r").{0,240}[?？]",
    re.IGNORECASE,
)


def _clean_gap_query(text: str, *, fallback: str) -> str:
    query = re.sub(r"\s+", " ", text).strip("`'\"[](){}:;,. -")
    if len(query) < 12:
        query = fallback
    query = re.sub(r"\s+", " ", query).strip("`'\"[](){}:;,. -")
    if len(query) > 180:
        query = query[:180].rsplit(" ", 1)[0].strip() or query[:180].strip()
    return query or fallback


def _node_gap_fallback_query(record: WorkflowRecord, node: WorkflowNode) -> str:
    basis = node.objective.strip() or node.prompt.strip() or node.name or record.goal
    return _clean_gap_query(basis, fallback=record.goal or node.name or "literature research")


def _split_gap_queries(body: str, *, fallback: str) -> list[str]:
    cleaned = _clean_gap_query(body, fallback=fallback)
    pieces = re.split(r"\s*(?:;|；|\n|\u2022|\||/)\s*", cleaned)
    queries: list[str] = []
    for piece in pieces:
        item = _clean_gap_query(piece, fallback="")
        if len(item) < 12:
            continue
        if item.lower() in {query.lower() for query in queries}:
            continue
        queries.append(item)
    return queries or [cleaned]


def detect_literature_gap_requests(record: WorkflowRecord, node: WorkflowNode, text: str) -> list[dict[str, str]]:
    fallback = _node_gap_fallback_query(record, node)
    requests: list[dict[str, str]] = []
    for marker in GAP_MARKER_RE.finditer(text):
        tag = marker.group("tag").lower()
        gap_type = "citation_gap" if "citation" in tag else "evidence_gap" if "evidence" in tag else "literature_gap"
        for body in _split_gap_queries(marker.group("body") or "", fallback=fallback):
            requests.append(
                {
                    "gap_type": gap_type,
                    "query": body,
                    "reason": f"{node.name} declared {marker.group('tag')}",
                }
            )
    if requests:
        return requests

    lowered = text.lower()
    if not any(phrase in lowered for phrase in GAP_PHRASES):
        return []
    for line in text.splitlines():
        if any(phrase in line.lower() for phrase in GAP_PHRASES):
            query = _clean_gap_query(line, fallback=fallback)
            return [
                {
                    "gap_type": "citation_gap" if "citation" in line.lower() or "引用" in line else "evidence_gap",
                    "query": query,
                    "reason": f"{node.name} reported a literature or evidence gap",
                }
            ]
    return [
        {
            "gap_type": "evidence_gap",
            "query": fallback,
            "reason": f"{node.name} reported a literature or evidence gap",
        }
    ]


def detect_literature_gap_request(record: WorkflowRecord, node: WorkflowNode, text: str) -> dict[str, str] | None:
    requests = detect_literature_gap_requests(record, node, text)
    return requests[0] if requests else None


def dynamic_clone_node_id(caller_id: str | None, objective: str) -> str:
    caller = _safe_node_slug(caller_id or "worker", "worker")
    objective_slug = _safe_node_slug(objective, "clone")
    digest = hashlib.sha1(f"{caller_id or ''}\n{objective}".encode("utf-8")).hexdigest()[:8]
    return f"clone-{caller}-{objective_slug[:28]}-{digest}"


def detect_worker_clone_request(node: WorkflowNode, text: str) -> dict[str, str] | None:
    if not node.can_clone_workers:
        return None
    marker = CLONE_MARKER_RE.search(text)
    if not marker:
        return None
    body = _clean_gap_query(marker.group("body") or "", fallback=node.objective or node.prompt or node.name)
    return {
        "objective": body,
        "reason": f"{node.name} requested a cloned worker",
    }


def dynamic_worker_question_node_id(caller_id: str | None, role: str, question: str) -> str:
    caller = _safe_node_slug(caller_id or "planner", "planner")
    role_slug = _safe_node_slug(role, "worker")
    question_slug = _safe_node_slug(question, "question")
    digest = hashlib.sha1(f"{caller_id or ''}\n{role}\n{question}".encode("utf-8")).hexdigest()[:8]
    return f"ask-{caller}-{role_slug[:16]}-{question_slug[:24]}-{digest}"


def _parse_worker_question_body(body: str) -> tuple[str, str]:
    cleaned = re.sub(r"\s+", " ", body).strip("`'\"[](){} ")
    role = "worker"
    question = cleaned
    for separator in ("|", "::", "：", ":"):
        if separator in cleaned:
            left, right = cleaned.split(separator, 1)
            if left.strip() and right.strip():
                role = left.strip()
                question = right.strip()
                break
    question = _clean_gap_query(question, fallback=cleaned or "answer the planner question")
    return role, question


def detect_worker_question_requests(node: WorkflowNode, text: str) -> list[dict[str, str]]:
    if not node.can_ask_questions:
        return []
    requests: list[dict[str, str]] = []
    for marker in WORKER_QUESTION_RE.finditer(text):
        role, question = _parse_worker_question_body(marker.group("body") or "")
        if not question:
            continue
        requests.append(
            {
                "role": role,
                "question": question,
                "reason": f"{node.name} asked {role} to answer a question",
            }
        )
    return requests


def worker_question_role_spec(target_role: str) -> dict[str, str | None]:
    text = target_role.lower()
    if "literature" in text or "research" in text or "文献" in text or "调研" in text:
        return {"role": "literature scout", "kind": "literature", "skill": "research-lit", "task_type": "research"}
    if "citation" in text or "reference" in text or "引用" in text or "插文献" in text:
        return {"role": "citation inserter", "kind": "citation", "skill": "paper-write", "task_type": "writing"}
    if "review" in text or "critic" in text or "审查" in text or "审阅" in text:
        return {"role": "reviewer", "kind": "reviewer", "skill": "research-review", "task_type": "review"}
    if "write" in text or "writer" in text or "author" in text or "写" in text or "改" in text:
        return {"role": "writer", "kind": "writer", "skill": "paper-write", "task_type": "writing"}
    return {"role": target_role.strip() or "worker", "kind": "worker", "skill": None, "task_type": "analysis"}


def output_has_disallowed_question(text: str) -> bool:
    if not text.strip():
        return False
    candidate_lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("[LITERATURE_NEEDED") or stripped.startswith("[EVIDENCE_NEEDED"):
            continue
        if stripped.endswith(("?", "？")):
            candidate_lines.append(stripped)
    if candidate_lines:
        return True
    return QUESTION_LINE_RE.search(text) is not None


def allowed_tools_for_role(role_kind: str, skill_id: str | None = None) -> list[str] | None:
    if role_kind == "planner":
        return PLANNER_CONTROL_PLANE_TOOLS
    if role_kind == "literature" or skill_id in LITERATURE_SKILLS:
        return LITERATURE_WORKER_TOOLS
    if role_kind == "reviewer":
        return REVIEWER_TOOLS
    if role_kind in {"writer", "citation"}:
        return ARTIFACT_WORKER_TOOLS
    return None


def stable_graph_hash(graph: WorkflowGraph) -> str:
    payload = json.dumps(model_dict(graph), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def plan_snapshot(graph: WorkflowGraph) -> PlanSnapshot:
    dynamic_nodes = [node for node in graph.nodes if node.dynamic_parent_id]
    blocked_nodes = [node for node in graph.nodes if node.status == "waiting_dynamic_dependency"]
    return PlanSnapshot(
        graph=graph,
        graph_hash=stable_graph_hash(graph),
        node_count=len(graph.nodes),
        edge_count=len(graph.edges),
        dynamic_node_count=len(dynamic_nodes),
        blocked_node_count=len(blocked_nodes),
    )


def planner_decision_type(decision: PlannerDecision) -> PlannerDecisionType:
    if decision.decision_type:
        return decision.decision_type
    if decision.complete:
        return "fail" if any(delta.action == "mark_policy_rejected" for delta in decision.deltas) else "noop"
    actions = {delta.action for delta in decision.deltas}
    if not actions or actions == {"mark_noop"}:
        return "noop"
    if "resume_node" in actions and actions <= {"resume_node", "mark_noop"}:
        return "resume"
    if "mark_policy_rejected" in actions:
        return "fail"
    return "mutate"


def _evidence_refs(decision: PlannerDecision, delta: WorkflowDelta) -> list[str]:
    refs: list[str] = []
    refs.extend(decision.gap_evidence_refs)
    refs.extend(delta.gap_evidence_refs)
    refs.extend(delta.source_event_refs)
    refs.extend(delta.source_artifact_refs)
    if isinstance(delta.research_request, dict):
        for key in ("gap_evidence_refs", "evidence_refs", "source_event_refs", "source_artifact_refs"):
            value = delta.research_request.get(key)
            if isinstance(value, list):
                refs.extend(str(item) for item in value if str(item).strip())
            elif isinstance(value, str) and value.strip():
                refs.append(value.strip())
    seen: set[str] = set()
    clean: list[str] = []
    for ref in refs:
        ref = str(ref).strip()
        if not ref or ref in seen:
            continue
        clean.append(ref)
        seen.add(ref)
    return clean


def _decision_refs(decision: PlannerDecision, delta: WorkflowDelta) -> tuple[list[str], list[str]]:
    event_refs = list(dict.fromkeys([*delta.source_event_refs]))
    artifact_refs = list(dict.fromkeys([*delta.source_artifact_refs]))
    for ref in decision.gap_evidence_refs:
        if ref.startswith("event:") and ref not in event_refs:
            event_refs.append(ref)
        elif ref.startswith("artifact:") and ref not in artifact_refs:
            artifact_refs.append(ref)
    return event_refs, artifact_refs


def graph_runtime_diff(before: WorkflowGraph, after: WorkflowGraph) -> dict[str, Any]:
    before_nodes = {node.id: node for node in before.nodes}
    after_nodes = {node.id: node for node in after.nodes}
    before_edges = {(edge.source, edge.target) for edge in before.edges}
    after_edges = {(edge.source, edge.target) for edge in after.edges}
    status_changes = []
    dependency_changes = []
    for node_id, node in after_nodes.items():
        previous = before_nodes.get(node_id)
        if previous is None:
            continue
        if previous.status != node.status:
            status_changes.append({"node_id": node_id, "before": previous.status, "after": node.status})
        if sorted(previous.depends_on) != sorted(node.depends_on):
            dependency_changes.append(
                {
                    "node_id": node_id,
                    "before": sorted(previous.depends_on),
                    "after": sorted(node.depends_on),
                }
            )
    return {
        "added_nodes": sorted(set(after_nodes) - set(before_nodes)),
        "removed_nodes": sorted(set(before_nodes) - set(after_nodes)),
        "added_edges": [f"{source}->{target}" for source, target in sorted(after_edges - before_edges)],
        "removed_edges": [f"{source}->{target}" for source, target in sorted(before_edges - after_edges)],
        "status_changes": status_changes,
        "dependency_changes": dependency_changes,
    }


def _session_id_for_node(workflow_id: str, node: WorkflowNode) -> str:
    return f"node:{workflow_id}:{node.id}"


def _planner_session_id(workflow_id: str) -> str:
    return f"planner:{workflow_id}"


def _safe_relative(workspace: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(workspace.resolve()).as_posix()
    except ValueError:
        return str(path)


def _truncate_handoff_preview(value: str, limit: int = HANDOFF_PREVIEW_CHARS) -> str:
    value = re.sub(r"\s+", " ", value.strip())
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)].rstrip() + "…"


def _latest_completed_node_run_id(workspace: Path, workflow_id: str, node_id: str) -> str | None:
    seen: set[str] = set()
    for event in reversed(replay_workflow_events(workspace, workflow_id)):
        if event.node_id != node_id or not event.run_id or event.run_id in seen:
            continue
        seen.add(event.run_id)
        run = get_run(workspace, event.run_id)
        if run and run.status == "succeeded" and (
            node_output_path(workspace, event.run_id).exists()
            or last_message_path(workspace, event.run_id).exists()
        ):
            return event.run_id
    return None


def _read_run_output_preview(workspace: Path, run_id: str) -> tuple[str, str, str | None, bool] | None:
    output_json_path = node_output_path(workspace, run_id)
    if output_json_path.exists():
        try:
            parsed = json.loads(output_json_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            parsed = None
        if isinstance(parsed, dict):
            structured = parsed.get("json")
            text = parsed.get("text")
            if structured is not None:
                preview = json.dumps(structured, ensure_ascii=False, indent=2)
                return _truncate_handoff_preview(preview), "json", _safe_relative(workspace, output_json_path), True
            if isinstance(text, str) and text.strip():
                return _truncate_handoff_preview(text), "text", _safe_relative(workspace, output_json_path), False

    message_path = last_message_path(workspace, run_id)
    if message_path.exists():
        try:
            text = message_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        if text.strip():
            return _truncate_handoff_preview(text), "text", _safe_relative(workspace, message_path), False

    return None


def _extract_node_output_preview(workspace: Path, workflow_id: str, node: WorkflowNode) -> tuple[str, str, str | None, bool, str | None]:
    run_ids = [node.run_id] if node.run_id else []
    fallback_run_id = _latest_completed_node_run_id(workspace, workflow_id, node.id)
    if fallback_run_id and fallback_run_id not in run_ids:
        run_ids.append(fallback_run_id)

    for run_id in run_ids:
        if not run_id:
            continue
        preview = _read_run_output_preview(workspace, run_id)
        if preview:
            return (*preview, run_id)

    if not run_ids:
        if node.status in {"queued", "blocked", "waiting_dynamic_dependency", "waiting_approval", "running"}:
            return f"{node.name} is {node.status}; no completed output is available yet.", "status", None, False, None
        return f"{node.name} has no run output.", "none", None, False, None

    return f"{node.name} is {node.status}; output has not been written.", "status", None, False, run_ids[0]


def build_handoff_index(workspace: Path, record: WorkflowRecord) -> list[WorkflowHandoff]:
    nodes_by_id = {node.id: node for node in record.graph_json.nodes}
    edge_pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add_pair(source: str | None, target: str | None) -> None:
        if not source or not target or source == target:
            return
        pair = (source, target)
        if pair in seen or source not in nodes_by_id or target not in nodes_by_id:
            return
        seen.add(pair)
        edge_pairs.append(pair)

    for edge in record.graph_json.edges:
        add_pair(edge.source, edge.target)
    for target in record.graph_json.nodes:
        for source in target.depends_on:
            add_pair(source, target.id)

    handoffs: list[WorkflowHandoff] = []
    for source_id, target_id in edge_pairs:
        source = nodes_by_id[source_id]
        target = nodes_by_id[target_id]
        preview, content_type, output_path, has_structured, source_run_id = _extract_node_output_preview(workspace, record.id, source)
        handoffs.append(
            WorkflowHandoff(
                source=source_id,
                target=target_id,
                source_name=source.name,
                target_name=target.name,
                source_run_id=source_run_id,
                target_run_id=target.run_id,
                source_status=source.status,
                content_type=content_type,  # type: ignore[arg-type]
                preview=preview,
                output_path=output_path,
                has_structured_output=has_structured,
            )
        )
    return handoffs


def _hash_file(path: Path, *, limit: int = 2_000_000) -> str | None:
    try:
        if path.stat().st_size > limit:
            return None
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _artifact_summary(path: Path) -> str:
    if path.suffix.lower() not in {".md", ".markdown", ".json", ".jsonl", ".txt", ".tex", ".bib", ".csv", ".tsv", ".log"}:
        return ""
    try:
        if path.stat().st_size > 512_000:
            return ""
        text = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""
    if not text:
        return ""
    return text[:480]


def build_artifact_index(workspace: Path, record: WorkflowRecord) -> list[ArtifactIndexEntry]:
    nodes = {node.id: node for node in record.graph_json.nodes}
    entries_by_path: dict[str, ArtifactIndexEntry] = {}
    workflow_node_root = workspace / ".aris" / "web" / "workflows" / record.id / "nodes"

    def infer_producer(path: Path) -> WorkflowNode | None:
        try:
            rel = path.resolve().relative_to(workflow_node_root.resolve())
        except ValueError:
            return None
        if len(rel.parts) < 3:
            return None
        node_id = rel.parts[0]
        return nodes.get(node_id)

    if workflow_node_root.exists():
        for root, _dirs, files in os.walk(workflow_node_root):
            root_path = Path(root)
            for file_name in files:
                if file_name in {"session.json", "events.jsonl", "runtime_events.jsonl"}:
                    continue
                path = root_path / file_name
                if path.suffix.lower() not in ARTIFACT_SUFFIXES:
                    continue
                producer = infer_producer(path)
                if producer is None:
                    continue
                try:
                    rel = path.resolve().relative_to(workspace.resolve()).as_posix()
                    stat = path.stat()
                except (OSError, ValueError):
                    continue
                entries_by_path[rel] = ArtifactIndexEntry(
                    id=hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16],
                    path=rel,
                    name=path.name,
                    kind=artifact_kind(path),
                    producer_node_id=producer.id,
                    run_id=producer.run_id,
                    session_id=_session_id_for_node(record.id, producer),
                    size=stat.st_size,
                    modified_at=time_from_stat(stat.st_mtime),
                    sha256=_hash_file(path),
                    summary=_artifact_summary(path),
                )

    # Include declared node outputs even when they live under hidden workflow dirs
    # that the general artifact browser normally suppresses.
    for node in record.graph_json.nodes:
        for output_path in concrete_output_paths(node.outputs):
            path = workflow_output_path(workspace, record.id, node, output_path)
            if not path.exists() or not path.is_file():
                continue
            try:
                rel = path.resolve().relative_to(workspace.resolve()).as_posix()
                stat = path.stat()
            except (OSError, ValueError):
                continue
            entries_by_path[rel] = ArtifactIndexEntry(
                id=hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16],
                path=rel,
                name=path.name,
                kind=artifact_kind(path),
                producer_node_id=node.id,
                run_id=node.run_id,
                session_id=_session_id_for_node(record.id, node),
                size=stat.st_size,
                modified_at=time_from_stat(stat.st_mtime),
                sha256=_hash_file(path),
                summary=_artifact_summary(path),
            )
    return sorted(entries_by_path.values(), key=lambda item: item.modified_at, reverse=True)


def _node_event_timestamp(events: list[WorkflowEvent], node_id: str, fallback: str) -> str:
    for event in reversed(events):
        if event.node_id == node_id:
            return event.timestamp
    return fallback


def _human_message_preview(text: str, *, limit: int = 900) -> str:
    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def build_team_chat_messages(workspace: Path, record: WorkflowRecord, artifacts: list[ArtifactIndexEntry] | None = None) -> list[TeamMessage]:
    artifacts = artifacts if artifacts is not None else build_artifact_index(workspace, record)
    artifacts_by_node: dict[str, list[ArtifactIndexEntry]] = {}
    for artifact in artifacts:
        if artifact.producer_node_id:
            artifacts_by_node.setdefault(artifact.producer_node_id, []).append(artifact)
    events = replay_workflow_events(workspace, record.id)
    messages: list[TeamMessage] = []
    for node in record.graph_json.nodes:
        if not node.run_id or node.reports_to_chat is False:
            continue
        path = last_message_path(workspace, node.run_id)
        message = ""
        if path.exists():
            try:
                message = _human_message_preview(path.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                message = ""
        if not message and node.status in TERMINAL_NODE_STATUSES:
            message = f"{node.name} finished with status {node.status}."
        if not message:
            continue
        role_kind = node.team_role_kind or "worker"
        role = node.assignee_role or node.role or node.team_role_id or role_kind
        messages.append(
            TeamMessage(
                workflow_id=record.id,
                timestamp=_node_event_timestamp(events, node.id, record.updated_at),
                node_id=node.id,
                run_id=node.run_id,
                role=role,
                role_kind=role_kind,  # type: ignore[arg-type]
                scope=node.scope or default_scope_for_kind(role_kind),
                message=message,
                artifact_refs=artifacts_by_node.get(node.id, []),
                can_ask_questions=bool(node.can_ask_questions),
                can_clone_workers=bool(node.can_clone_workers),
                can_call_planner=bool(node.can_call_planner),
                peer_access=True if node.peer_access is None else bool(node.peer_access),
            )
        )
    return sorted(messages, key=lambda item: item.timestamp)


def time_from_stat(value: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _render_port_summary(ports, *, kind: str) -> str:
    """Render a port list as a bulleted summary for the agent prompt.

    ``ports`` may be ``list[PortSpec]`` (modern) or ``list[str]`` (legacy);
    both are tolerated because validators auto-lift strings to ``PortSpec``
    when the data flows through Pydantic, but defensive code keeps the
    helper usable in tests and tooling that bypass validation.
    """
    if not ports:
        return f"(no {kind} declared)"
    lines: list[str] = []
    for port in ports:
        if hasattr(port, "name") and hasattr(port, "type"):
            name = (port.name or "").strip() or "(unnamed)"
            type_label = port.type
            required = getattr(port, "required", True)
            description = getattr(port, "description", "") or ""
        else:
            name = str(port).strip() or "(unnamed)"
            type_label = "text"
            required = True
            description = ""
        flag = "required" if required else "optional"
        suffix = f" — {description}" if description else ""
        lines.append(f"- {name} [{type_label}, {flag}]{suffix}")
    return "\n".join(lines)


TASK_BOARD_COLUMN_TITLES = {
    "backlog": "Backlog",
    "ready": "Ready",
    "running": "Running",
    "review": "Review",
    "rework": "Rework",
    "done": "Done",
    "blocked": "Blocked",
}


def task_board_column_for_node(node: WorkflowNode, nodes_by_id: dict[str, WorkflowNode]) -> str:
    if node.type == "input":
        return "done"
    if node.status in {"succeeded", "skipped", "cancelled"}:
        return "done"
    if node.status == "running":
        return "running"
    if node.status == "waiting_approval" or node.review_status == "pending":
        return "review"
    if node.status == "failed" or node.review_status == "rework":
        return "rework"
    if node.status in {"blocked", "waiting_dynamic_dependency"}:
        return "blocked"
    if node.status == "queued" and all(
        dep in nodes_by_id and nodes_by_id[dep].status in SUCCESS_NODE_STATUSES
        for dep in node.depends_on
    ):
        return "ready"
    return "backlog"


def task_objective(node: WorkflowNode) -> str:
    return node.objective.strip() or node.prompt.strip()


def missing_concrete_outputs(workspace: Path, workflow_id: str | WorkflowNode, node: WorkflowNode | None = None) -> list[str]:
    if node is None:
        node = workflow_id  # type: ignore[assignment]
        workflow_id = ""
    missing: list[str] = []
    for output_path in concrete_output_paths(node.outputs):
        resolved = (workflow_output_path(workspace, str(workflow_id), node, output_path) if workflow_id else workspace / output_path).resolve()
        if workspace.resolve() not in [resolved, *resolved.parents]:
            missing.append(output_path.as_posix())
            continue
        if not resolved.exists():
            missing.append(workflow_output_relative_path(workspace, str(workflow_id), node, output_path) if workflow_id else output_path.as_posix())
    return missing


def create_workflow_record(workspace: Path, title: str, goal: str, graph: WorkflowGraph) -> WorkflowRecord:
    now = utc_now()
    return WorkflowRecord(
        id=uuid.uuid4().hex[:12],
        workspace=str(workspace),
        title=title.strip() or "Untitled workflow",
        goal=goal.strip(),
        status="draft",
        graph_json=graph,
        created_at=now,
        updated_at=now,
    )


def normalize_workflow_graph(graph: WorkflowGraph, known_skills: set[str] | None = None) -> WorkflowGraph:
    node_ids: set[str] = set()
    normalized_nodes: list[WorkflowNode] = []
    for node in graph.nodes:
        node_id = node.id.strip()
        if not node_id:
            raise ValueError("Workflow node id must not be empty")
        if node_id in node_ids:
            raise ValueError(f"Duplicate workflow node id: {node_id}")
        node_ids.add(node_id)
        skill = node.skill.strip() if isinstance(node.skill, str) and node.skill.strip() else None
        config_file = node.config_file.strip() if isinstance(node.config_file, str) and node.config_file.strip() else None
        if node.type in {"input", "human_gate"}:
            skill = None
            config_file = None
        elif skill is None:
            skill = default_skill_for_node(node, known_skills)
        protocol_update = normalize_node_protocol(node, skill=skill, config_file=config_file)
        if protocol_update.get("team_role_kind") == "planner":
            skill = None
        if skill and known_skills is not None and skill not in known_skills:
            raise ValueError(f"Unknown skill for node {node_id}: {skill}")
        update = {"id": node_id, "skill": skill, "config_file": config_file}
        update.update(protocol_update)
        normalized_nodes.append(
            node.copy(update=update) if not hasattr(node, "model_copy")
            else node.model_copy(update=update)
        )

    edge_pairs: set[tuple[str, str]] = set()
    for edge in graph.edges:
        source = edge.source.strip()
        target = edge.target.strip()
        if source not in node_ids or target not in node_ids:
            raise ValueError(f"Workflow edge references an unknown node: {source} -> {target}")
        if source == target:
            raise ValueError(f"Workflow edge cannot point to itself: {source}")
        edge_pairs.add((source, target))
    for node in normalized_nodes:
        for dep in node.depends_on:
            if dep not in node_ids:
                raise ValueError(f"Node {node.id} depends on an unknown node: {dep}")
            if dep == node.id:
                raise ValueError(f"Node {node.id} cannot depend on itself")
            edge_pairs.add((dep, node.id))

    deps_by_node = {node.id: set(node.depends_on) for node in normalized_nodes}
    for source, target in edge_pairs:
        deps_by_node[target].add(source)
    normalized_nodes = [
        (
            node.copy(update={"depends_on": sorted(deps_by_node[node.id])})
            if not hasattr(node, "model_copy")
            else node.model_copy(update={"depends_on": sorted(deps_by_node[node.id])})
        )
        for node in normalized_nodes
    ]

    _assert_acyclic({node.id: set(node.depends_on) for node in normalized_nodes})
    normalized_edges = [
        WorkflowEdge(id=f"{source}->{target}", source=source, target=target)
        for source, target in sorted(edge_pairs)
    ]
    return WorkflowGraph(
        schema_version=2,
        nodes=normalized_nodes,
        edges=normalized_edges,
        max_concurrency=graph.max_concurrency,
        class_limits=graph.class_limits,
    )


def prepare_graph_for_task_board_run(graph: WorkflowGraph, *, restart: bool = False) -> WorkflowGraph:
    """Prepare a board-style run that flows until a real human checkpoint."""

    base = reset_workflow_execution_state(graph) if restart else graph
    nodes: list[WorkflowNode] = []
    for node in base.nodes:
        auto_after = node.auto_approve_after
        retry = node.retry
        if node.type in EXECUTABLE_NODE_TYPES and node.gate not in {"after", "both"}:
            auto_after = True
            if retry is None:
                retry = RetryPolicy(
                    max_attempts=3,
                    backoff_seconds=2.0,
                    on=[
                        "assistant stream produced no content",
                        "assistant stream ended",
                        "connection",
                        "rate limit",
                        "timeout",
                        "temporarily unavailable",
                    ],
                )
        update = {"auto_approve_after": auto_after, "retry": retry}
        nodes.append(node.copy(update=update) if not hasattr(node, "model_copy") else node.model_copy(update=update))
    return base.copy(update={"nodes": nodes}) if not hasattr(base, "model_copy") else base.model_copy(update={"nodes": nodes})


def _assert_acyclic(deps_by_node: dict[str, set[str]]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in visited:
            return
        if node_id in visiting:
            raise ValueError(f"Workflow graph contains a cycle at node: {node_id}")
        visiting.add(node_id)
        for dep in deps_by_node[node_id]:
            visit(dep)
        visiting.remove(node_id)
        visited.add(node_id)

    for node_id in deps_by_node:
        visit(node_id)


def research_template_graph(goal: str, known_skills: set[str] | None = None) -> WorkflowGraph:
    def skill(name: str) -> str | None:
        return name if known_skills is None or name in known_skills else None

    nodes = [
        WorkflowNode(
            id="planner",
            type="agent",
            name="Frame the research problem",
            role="planner",
            skill=skill("research-refine"),
            prompt=f"Turn this research goal into a focused problem statement, method direction, and decision list:\n{goal}",
            outputs=["problem framing", "method direction", "risks"],
            position={"x": 0, "y": 110},
        ),
        WorkflowNode(
            id="literature",
            type="sub_agent",
            name="Map related work",
            role="literature scout",
            skill=skill("research-lit"),
            prompt="Search and summarize the most relevant recent work. Save a concise literature map with gaps.",
            depends_on=["planner"],
            inputs=["problem framing"],
            outputs=["literature map"],
            position={"x": 260, "y": 0},
        ),
        WorkflowNode(
            id="experiment-plan",
            type="agent",
            name="Design experiments",
            role="experiment planner",
            skill=skill("experiment-plan"),
            prompt="Create a claim-driven experiment roadmap with datasets, metrics, ablations, expected artifacts, and stop criteria.",
            depends_on=["planner", "literature"],
            inputs=["problem framing", "literature map"],
            outputs=["experiment plan"],
            position={"x": 520, "y": 110},
        ),
        WorkflowNode(
            id="approve-implementation",
            type="human_gate",
            name="Approve implementation plan",
            role="checkpoint",
            prompt="Review the experiment plan and approve before launching implementation work.",
            depends_on=["experiment-plan"],
            position={"x": 740, "y": 110},
        ),
        WorkflowNode(
            id="implementation",
            type="sub_agent",
            name="Implement and run pilot",
            role="experiment executor",
            skill=skill("experiment-bridge"),
            prompt="Implement the first pilot experiment or bridge plan. Keep changes scoped and record commands, logs, and results.",
            depends_on=["approve-implementation"],
            inputs=["experiment plan"],
            outputs=["pilot results"],
            position={"x": 960, "y": 110},
        ),
        WorkflowNode(
            id="review",
            type="sub_agent",
            name="Adversarial review",
            role="reviewer",
            skill=skill("research-review"),
            prompt="Review the current evidence and artifacts independently. Identify unsupported claims, missing experiments, and next fixes.",
            depends_on=["implementation"],
            inputs=["pilot results"],
            outputs=["review report"],
            position={"x": 1180, "y": 0},
        ),
        WorkflowNode(
            id="approve-review",
            type="human_gate",
            name="Approve review outcome",
            role="checkpoint",
            prompt="Inspect the review report, decide whether the evidence is sufficient, and approve before drafting.",
            depends_on=["review"],
            position={"x": 1400, "y": 0},
        ),
        WorkflowNode(
            id="report",
            type="sub_agent",
            name="Write report or paper draft",
            role="writer",
            skill=skill("paper-writing"),
            prompt="Turn the validated results and review feedback into a structured report or paper draft with artifact links.",
            depends_on=["approve-review"],
            inputs=["review report"],
            outputs=["draft/report"],
            position={"x": 1620, "y": 110},
        ),
    ]
    return normalize_workflow_graph(WorkflowGraph(nodes=nodes), known_skills)


def paper_introduction_template_graph(goal: str, known_skills: set[str] | None = None) -> WorkflowGraph:
    def skill(name: str) -> str | None:
        return name if known_skills is None or name in known_skills else None

    planner_prompt = (
        "Act only as the Introduction control-plane planner. Do not read full paper materials or artifact contents. "
        "Use the team chat updates, task status, and artifact references available in the prompt. "
        "If you need content from a paper artifact, ask an employee with "
        "[ASK_WORKER: writer | concrete question] or [ASK_WORKER: literature scout | concrete question]. "
        "Write INTRO_PLAN.md as a compact routing plan: current understanding, open questions for employees, "
        "known artifact_refs, and next routing decision. If a concrete citation search is needed, write one marker per query "
        "as [LITERATURE_NEEDED: focused search query]. Mark non-literature support gaps as "
        "[ASK_WORKER: writer | focused evidence question]. "
        f"User goal:\n{goal}"
    )
    nodes = [
        WorkflowNode(
            id="intro-planner",
            type="agent",
            name="Plan introduction",
            role="planner",
            skill=None,
            task_type="planning",
            team_role_kind="planner",
            scope="Explain the Introduction problem, plan the paragraph arc, read worker updates, and route on-demand literature needs.",
            objective="Inventory existing paper materials and plan the Introduction arc while declaring any on-demand literature gaps.",
            acceptance_criteria=[
                "INTRO_PLAN.md lists core claims, current evidence, and a paragraph-level Introduction arc",
                "Missing citation needs are marked with LITERATURE_NEEDED and non-literature questions with ASK_WORKER",
                "No invented citations or unsupported related-work claims are introduced",
            ],
            assignee_role="planner",
            priority=1,
            prompt=planner_prompt,
            outputs=["INTRO_PLAN.md"],
            position={"x": 0, "y": 100},
        ),
        WorkflowNode(
            id="draft-introduction",
            type="sub_agent",
            name="Draft LaTeX introduction",
            role="writer",
            skill=skill("paper-write"),
            task_type="writing",
            team_role_kind="writer",
            scope="Write and revise Introduction text from approved plans, evidence, and artifact references.",
            objective="Draft the paper introduction from approved context, outline, and any dynamically inserted literature results.",
            acceptance_criteria=[
                "INTRODUCTION_DRAFT.md is written at the declared output path",
                "Claims are grounded in available evidence or explicitly marked as needing literature",
                "Citation placeholders are used only for known sources",
            ],
            assignee_role="writer",
            priority=2,
            prompt=(
                "Draft only the paper Introduction from INTRO_PLAN.md and any dynamic literature artifacts already connected upstream. "
                "You must write INTRODUCTION_DRAFT.md at the mapped node output path. "
                "Do not use WebSearch/WebFetch; citation discovery belongs to the literature scout. "
                "Use concrete claims grounded in available evidence, preserve citation placeholders only when the cited source is known, "
                "and avoid generic hype. If drafting needs literature that is not yet available, write [LITERATURE_NEEDED: focused search query] "
                "instead of filling in invented citations."
            ),
            depends_on=["intro-planner"],
            inputs=["INTRO_PLAN.md"],
            outputs=["INTRODUCTION_DRAFT.md"],
            position={"x": 320, "y": 100},
        ),
        WorkflowNode(
            id="review-introduction",
            type="sub_agent",
            name="Review introduction claims",
            role="reviewer",
            skill=skill("research-review"),
            task_type="review",
            team_role_kind="reviewer",
            scope="Raise evidence, novelty, motivation, and citation-gap questions for the planner to route.",
            objective="Review the introduction draft for evidence quality, novelty clarity, and citation gaps before revision.",
            acceptance_criteria=[
                "INTRO_REVIEW.md lists prioritized pass/rework findings",
                "Unsupported claims and citation gaps are tied to concrete text locations",
                "Follow-up work is expressed as focused ASK_WORKER questions for the planner to route",
                "Every non-passing review round contains at least one concrete planner-routed question",
            ],
            assignee_role="reviewer",
            priority=3,
            prompt=(
                "Review the drafted Introduction for unsupported claims, weak motivation, unclear novelty, citation gaps, "
                "and mismatch between evidence and promises. You must save INTRO_REVIEW.md with prioritized fixes. "
                "Do not directly assign the next worker and do not use WebSearch/WebFetch. "
                "If a fix requires fresh literature search, citation insertion, or writer revision, include explicit planner-routed "
                "questions in both INTRO_REVIEW.md and the final summary using "
                "[ASK_WORKER: literature scout | focused search query], [ASK_WORKER: citation inserter | concrete citation task], "
                "or [ASK_WORKER: writer | concrete revision task]. "
                "Keep asking concrete questions until the Introduction can pass without blocking evidence or citation gaps."
            ),
            depends_on=["draft-introduction"],
            inputs=["introduction draft"],
            outputs=["INTRO_REVIEW.md"],
            position={"x": 640, "y": 0},
        ),
        WorkflowNode(
            id="revise-introduction",
            type="sub_agent",
            name="Revise introduction",
            role="writer",
            skill=skill("paper-write"),
            task_type="writing",
            team_role_kind="writer",
            scope="Write and revise Introduction text from approved plans, evidence, and artifact references.",
            objective="Revise the introduction using review findings and any dynamically added literature evidence.",
            acceptance_criteria=[
                "INTRODUCTION_REVISED.md incorporates review fixes",
                "INTRO_REVISION_SUMMARY.md explains the changes and remaining risks",
                "Unsupported claims are removed, softened, or backed by available evidence",
            ],
            assignee_role="writer",
            priority=4,
            prompt=(
                "Revise the Introduction using INTRO_REVIEW.md. Keep changes local to the Introduction artifact, "
                "remove or soften unsupported claims, and write INTRODUCTION_REVISED.md plus INTRO_REVISION_SUMMARY.md explaining the changes. "
                "Do not use WebSearch/WebFetch; leave unresolved citation checks as [LITERATURE_NEEDED: focused query] for the planner to route."
            ),
            depends_on=["review-introduction"],
            inputs=["introduction draft", "INTRO_REVIEW.md"],
            outputs=["INTRODUCTION_REVISED.md", "INTRO_REVISION_SUMMARY.md"],
            position={"x": 960, "y": 100},
        ),
        WorkflowNode(
            id="final-review-introduction",
            type="sub_agent",
            name="Final review questions",
            role="reviewer",
            skill=skill("research-review"),
            task_type="review",
            team_role_kind="reviewer",
            scope="Continuously challenge the revised Introduction with evidence, citation, and clarity questions for planner routing.",
            objective="Review the revised Introduction and keep surfacing concrete questions until remaining blockers are routed.",
            acceptance_criteria=[
                "FINAL_INTRO_REVIEW.md states pass/rework status after revision",
                "Remaining blockers are phrased as ASK_WORKER questions for planner routing",
                "If no blocker remains, the review records pass status plus non-blocking watch items",
            ],
            assignee_role="reviewer",
            priority=5,
            prompt=(
                "Review INTRODUCTION_REVISED.md after the writer revision. You must save FINAL_INTRO_REVIEW.md. "
                "Act as the team's persistent reviewer: look for at least one concrete unresolved issue in citations, evidence, "
                "claim strength, or logical flow. If the issue blocks approval, write it as a planner-routed question using "
                "[ASK_WORKER: literature scout | focused search query], [ASK_WORKER: citation inserter | concrete citation task], "
                "or [ASK_WORKER: writer | concrete revision task] in both FINAL_INTRO_REVIEW.md and the final summary. "
                "If no blocking issue remains, state PASS and list only non-blocking watch items without ASK_WORKER markers."
            ),
            depends_on=["revise-introduction"],
            inputs=["INTRODUCTION_REVISED.md", "INTRO_REVISION_SUMMARY.md"],
            outputs=["FINAL_INTRO_REVIEW.md"],
            position={"x": 1280, "y": 0},
        ),
        WorkflowNode(
            id="approve-introduction",
            type="human_gate",
            name="Approve introduction",
            role="checkpoint",
            task_type="gate",
            objective="Human checkpoint for approving the revised introduction before using it downstream.",
            acceptance_criteria=[
                "Revised introduction is coherent and evidence-aware",
                "Review findings and revision summary have been inspected",
            ],
            assignee_role="human reviewer",
            priority=5,
            prompt=(
                "Inspect the revised Introduction, INTRO_REVIEW.md, and INTRO_REVISION_SUMMARY.md. "
                "Approve when the Introduction is coherent enough to feed the rest of the paper-writing flow."
            ),
            depends_on=["final-review-introduction"],
            position={"x": 1600, "y": 100},
        ),
    ]
    return normalize_workflow_graph(WorkflowGraph(nodes=nodes), known_skills)


def workflow_template_graph(template: str | None, goal: str, known_skills: set[str] | None = None) -> WorkflowGraph:
    if template == "paper_introduction":
        return paper_introduction_template_graph(goal, known_skills)
    return research_template_graph(goal, known_skills)


def build_workflow_generation_prompt(goal: str, skills: list[SkillInfo]) -> str:
    catalog = "\n".join(
        f"- {skill.id}: {skill.description[:180]}"
        for skill in skills
        if skill.id
    )
    return f"""You are designing an ARIS-Code multi-agent task board for the local web console.

The user goal starts as the initial top-level task. A Manager/Planner Agent decomposes it into traceable tasks. Each task should declare inputs, outputs, dependencies, an assigned role, and acceptance criteria. Role Agents may later claim or be assigned tasks. Reviewer tasks inspect evidence and acceptance criteria, then decide pass, rework, or follow-up tasks. The returned JSON is still the internal dependency graph used by the runtime.

Return ONLY valid JSON, with no Markdown fences or prose. The JSON must match:
{{
  "schema_version": 2,
  "title": "short workflow title",
  "goal": "user goal",
  "nodes": [
    {{
      "id": "stable-slug",
      "type": "input|agent|sub_agent|human_gate",
      "name": "human readable name",
	      "role": "planner|literature scout|experiment planner|executor|reviewer|writer",
	      "team_role_kind": "planner|reviewer|literature|writer|citation|worker|gate",
	      "scope": "core responsibility range, not a detailed flow",
	      "can_ask_questions": false,
	      "can_clone_workers": true,
	      "can_call_planner": false,
	      "peer_access": true,
	      "skill": "one skill id from the catalog or null",
      "task_type": "goal|planning|research|analysis|coding|writing|review|gate",
      "objective": "task objective written for the assigned role",
      "acceptance_criteria": ["observable criterion"],
      "assignee_role": "role expected to own this task",
      "priority": 1,
      "prompt": "optional supplemental instructions; prefer skill + objective over long prompts",
      "gate": "none|before|after|both",
      "inputs": [{{"name":"input name","type":"text","description":"where it comes from"}}],
      "outputs": [{{"name":"artifact.md","type":"file","description":"what must be written"}}],
      "depends_on": ["upstream-node-id"],
      "fanout": null,
      "position": {{"x": 0, "y": 0}}
    }}
  ],
  "edges": [{{"id": "source->target", "source": "source", "target": "target"}}]
}}

Use 5-7 tasks. Use type="input" for user-supplied global context nodes that every execution task should read.
Use type="agent" only for planning/manager tasks that decide what should happen next.
Use type="sub_agent" for independent role-agent tasks such as literature search, implementation, analysis, writing, or review.
	Use type="human_gate" for visible human checkpoints and set task_type="gate".
	Team protocol: keep scope as the role's core range only. Planner/manager reads human-language updates and routes work; workers must not call the planner. Literature, writing, and citation workers should set can_ask_questions=false and can_clone_workers=true. Reviewer tasks may ask questions but should not execute fixes.
	Include at least one reviewer task before a human checkpoint; reviewer tasks must have task_type="review" and acceptance criteria about evidence quality.
Include at least one human_gate before expensive implementation and one human_gate after review when the goal implies implementation or publication work.
For input and human_gate nodes set skill to null and gate to "none".
For executable nodes, prefer inheriting a skill over writing a long prompt: planning -> paper-plan, research -> research-lit, OpenAlex metadata/export search -> openalex-search, writing -> paper-write, review -> research-review.
Do not force every workflow through a fixed literature-search role. Add a static literature/search node only when literature review is itself a primary deliverable or must happen before any other task. Otherwise, instruct roles to emit [LITERATURE_NEEDED: focused query] or [EVIDENCE_NEEDED: focused question] in their artifacts; the runtime Manager can then insert a dynamic Literature task and resume the blocked role.
For sub_agent nodes, assume a fresh isolated run with no memory beyond declared upstream outputs and artifacts.
When a planner/keyword node produces a variable-length JSON array, create one template sub_agent with a fanout object:
  "fanout": {{"source": "keyword-node-id", "path": "keyword_groups", "name_template": "Literature search: {{{{item.name}}}}", "max_items": 12}}
The fanout template will expand at runtime into one independent SubAgent per JSON item. Downstream nodes depending on the template will wait for all generated SubAgents. Use prompt placeholders like {{{{item.name}}}}, {{{{item.keywords}}}}, {{{{item}}}}, {{{{index}}}}, and {{{{number}}}}.
The task dependency graph must be acyclic. Prefer research workflow skills from this catalog:
{catalog}

User goal:
{goal}
"""


WORKFLOW_PROMPT_RUNTIME_FIELDS = {
    "status",
    "run_id",
    "session_path",
    "error",
    "approved_before",
    "approved_after",
    "attempt",
    "usage",
    "fanout_parent_id",
    "fanout_item",
    "dynamic_parent_id",
    "dynamic_reason",
}

WORKFLOW_NODE_EXECUTION_FIELDS = [
    "id",
    "type",
    "role",
    "skill",
    "config_file",
    "prompt",
    "model",
    "effort",
    "gate",
    "depends_on",
    "inputs",
    "outputs",
    "timeout_seconds",
    "retry",
    "failure_policy",
    "concurrency_class",
    "fanout",
    "dynamic_parent_id",
    "dynamic_reason",
    "auto_approve_after",
    "research_request",
    "team_id",
    "team_instance_id",
    "team_role_id",
    "team_role_kind",
    "scope",
    "can_ask_questions",
    "can_clone_workers",
    "can_call_planner",
    "peer_access",
    "reports_to_chat",
    "task_type",
    "objective",
    "acceptance_criteria",
    "assignee_role",
    "assigned_to",
    "claimed_by",
    "review_status",
    "review_notes",
    "priority",
]

WORKFLOW_NODE_PRESERVED_RUNTIME_FIELDS = [
    "status",
    "run_id",
    "session_path",
    "error",
    "approved_before",
    "approved_after",
    "attempt",
    "usage",
    "fanout_parent_id",
    "fanout_item",
    "dynamic_parent_id",
    "dynamic_reason",
]


def workflow_graph_prompt_payload(graph: WorkflowGraph) -> dict:
    data = model_dict(graph)
    generated_parent_by_id = {
        node.id: node.fanout_parent_id
        for node in graph.nodes
        if node.fanout_parent_id
    }
    nodes = []
    for node in data.get("nodes", []):
        if not isinstance(node, dict):
            continue
        if node.get("id") in generated_parent_by_id:
            continue
        depends_on: list[str] = []
        for dep in node.get("depends_on") or []:
            next_dep = generated_parent_by_id.get(dep, dep)
            if next_dep not in depends_on:
                depends_on.append(next_dep)
        node["depends_on"] = depends_on
        for field in WORKFLOW_PROMPT_RUNTIME_FIELDS:
            node.pop(field, None)
        nodes.append(node)
    data["nodes"] = nodes
    data["edges"] = [
        {"id": f"{dep}->{node['id']}", "source": dep, "target": node["id"]}
        for node in nodes
        for dep in node.get("depends_on", [])
    ]
    return data


def reset_workflow_execution_state(graph: WorkflowGraph) -> WorkflowGraph:
    nodes: list[WorkflowNode] = []
    for node in graph.nodes:
        update = {
            "status": "queued",
            "run_id": None,
            "session_path": None,
            "error": None,
            "approved_before": False,
            "approved_after": False,
            "attempt": 0,
            "usage": None,
        }
        nodes.append(node.copy(update=update) if not hasattr(node, "model_copy") else node.model_copy(update=update))
    return (
        graph.copy(update={"nodes": nodes})
        if not hasattr(graph, "model_copy")
        else graph.model_copy(update={"nodes": nodes})
    )


def _node_execution_signature(node: WorkflowNode) -> str:
    data = model_dict(node)
    payload = {field: data.get(field) for field in WORKFLOW_NODE_EXECUTION_FIELDS}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def merge_workflow_execution_state(previous: WorkflowGraph, updated: WorkflowGraph) -> tuple[WorkflowGraph, int, int]:
    previous_by_id = {node.id: node for node in previous.nodes}
    nodes: list[WorkflowNode] = []
    preserved = 0
    reset = 0
    for node in updated.nodes:
        old = previous_by_id.get(node.id)
        if old is not None and _node_execution_signature(old) == _node_execution_signature(node):
            update = {field: getattr(old, field) for field in WORKFLOW_NODE_PRESERVED_RUNTIME_FIELDS}
            preserved += 1
        else:
            update = {
                "status": "queued",
                "run_id": None,
                "error": None,
                "approved_before": False,
                "approved_after": False,
                "attempt": 0,
                "usage": None,
            }
            reset += 1
        nodes.append(node.copy(update=update) if not hasattr(node, "model_copy") else node.model_copy(update=update))
    graph = updated.copy(update={"nodes": nodes}) if not hasattr(updated, "model_copy") else updated.model_copy(update={"nodes": nodes})
    return graph, preserved, reset


def build_workflow_refinement_prompt(
    workflow: WorkflowRecord,
    current_graph: WorkflowGraph,
    instructions: str,
    skills: list[SkillInfo],
) -> str:
    catalog = "\n".join(
        f"- {skill.id}: {skill.description[:180]}"
        for skill in skills
        if skill.id
    )
    current_graph_json = json.dumps(workflow_graph_prompt_payload(current_graph), ensure_ascii=False, indent=2)
    return f"""You are updating an existing ARIS-Code multi-agent task board for the local web console.

Return ONLY valid JSON, with no Markdown fences or prose. Return the complete updated task board graph, not a patch.
Return the complete updated workflow, not a patch.

Current task board title:
{workflow.title}

Current initial goal:
{workflow.goal}

Current internal dependency graph:
{current_graph_json}

New user requirements:
{instructions}

The JSON must match:
{{
  "schema_version": 2,
  "title": "short workflow title",
  "goal": "updated user goal",
  "nodes": [
    {{
      "id": "stable-slug",
      "type": "input|agent|sub_agent|human_gate",
      "name": "human readable name",
	      "role": "planner|literature scout|experiment planner|executor|reviewer|writer",
	      "team_role_kind": "planner|reviewer|literature|writer|citation|worker|gate",
	      "scope": "core responsibility range, not a detailed flow",
	      "can_ask_questions": false,
	      "can_clone_workers": true,
	      "can_call_planner": false,
	      "peer_access": true,
	      "skill": "one skill id from the catalog or null",
      "task_type": "goal|planning|research|analysis|coding|writing|review|gate",
      "objective": "task objective written for the assigned role",
      "acceptance_criteria": ["observable criterion"],
      "assignee_role": "role expected to own this task",
      "priority": 1,
      "prompt": "optional supplemental instructions; prefer skill + objective over long prompts",
      "gate": "none|before|after|both",
      "inputs": [{{"name":"input name","type":"text","description":"where it comes from"}}],
      "outputs": [{{"name":"artifact.md","type":"file","description":"what must be written"}}],
      "depends_on": ["upstream-node-id"],
      "fanout": null,
      "position": {{"x": 0, "y": 0}}
    }}
  ],
  "edges": [{{"id": "source->target", "source": "source", "target": "target"}}]
}}

Preserve stable node ids, positions, prompts, and edges when they still satisfy the new requirements.
Only add, remove, rename, or reorder nodes when the new requirements make that necessary.
Use type="agent" only for planning/manager tasks that decide what should happen next.
Use type="input" for user-supplied global context nodes that every execution task should read.
	Use type="sub_agent" for independent role-agent tasks such as literature search, implementation, analysis, writing, or review.
	Use type="human_gate" for visible human checkpoints and set task_type="gate".
	Team protocol: keep scope as the role's core range only. Planner/manager reads human-language updates and routes work; workers must not call the planner. Literature, writing, and citation workers should set can_ask_questions=false and can_clone_workers=true. Reviewer tasks may ask questions but should not execute fixes.
	Reviewer tasks must have task_type="review" and acceptance criteria about evidence quality, pass/rework decisions, or follow-up task creation.
For input and human_gate nodes set skill to null and gate to "none".
For executable nodes, prefer inheriting a skill over writing a long prompt: planning -> paper-plan, research -> research-lit, OpenAlex metadata/export search -> openalex-search, writing -> paper-write, review -> research-review.
Do not turn the graph into a mandatory linear literature-first pipeline unless the user explicitly asked for that. Keep literature/search as on-demand dynamic work when a role discovers missing citation or evidence needs; those roles should write [LITERATURE_NEEDED: focused query] or [EVIDENCE_NEEDED: focused question] into their declared artifacts.
For sub_agent nodes, assume a fresh isolated run with no memory beyond declared upstream outputs and artifacts.
When the new requirements need variable-length parallel work based on upstream output, use a fanout template sub_agent:
  "fanout": {{"source": "keyword-node-id", "path": "keyword_groups", "name_template": "Literature search: {{{{item.name}}}}", "max_items": 12}}
The template expands at runtime into one independent SubAgent per JSON item. Downstream nodes depending on the template will wait for all generated SubAgents. Use prompt placeholders like {{{{item.name}}}}, {{{{item.keywords}}}}, {{{{item}}}}, {{{{index}}}}, and {{{{number}}}}.
Do not include runtime fields such as status, run_id, error, approved_before, approved_after, attempt, or usage.
Do not include model, effort, or config_file unless the user explicitly asked for those overrides.
The task dependency graph must be acyclic. Prefer research workflow skills from this catalog:
{catalog}
"""


def parse_generated_workflow_text(text: str) -> tuple[str | None, str | None, WorkflowGraph]:
    candidates = []
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and isinstance(parsed.get("message"), str):
            candidates.append(parsed["message"])
        if isinstance(parsed, dict):
            candidates.append(stripped)
    candidates.append(text)

    for candidate in candidates:
        raw = _extract_json_blob(candidate)
        if raw is None:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        graph_data = data.get("graph_json") if isinstance(data.get("graph_json"), dict) else data
        if isinstance(graph_data, dict) and "nodes" in graph_data:
            graph_data = dict(graph_data)
            graph_data.setdefault("schema_version", 2)
            return data.get("title"), data.get("goal"), WorkflowGraph(**graph_data)
    raise ValueError("ARIS did not return a parseable workflow JSON object")


def _extract_json_blob(text: str) -> str | None:
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL)
    if fence:
        return fence.group(1)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return text[start : end + 1]


def parse_optimized_prompt_text(text: str) -> str:
    raw = _extract_json_blob(text)
    if raw is not None:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict):
            for key in ("prompt", "optimized_prompt", "result"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            for key in ("last_message", "message", "content"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    try:
                        return parse_optimized_prompt_text(value)
                    except ValueError:
                        return value.strip()
    cleaned = re.sub(r"^```(?:markdown|text)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE | re.DOTALL).strip()
    if not cleaned:
        raise ValueError("Prompt optimizer returned an empty response")
    return cleaned


def parse_planner_decision_text(text: str) -> PlannerDecision:
    candidates: list[str] = []
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and isinstance(parsed.get("message"), str):
            candidates.append(parsed["message"])
        if isinstance(parsed, dict):
            candidates.append(stripped)
    candidates.append(text)
    for candidate in candidates:
        raw = _extract_json_blob(candidate) or candidate
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return PlannerDecision(**data)
    raise ValueError("Planner did not return a parseable PlannerDecision JSON object")


def responses_api_url(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    if base.endswith("/responses"):
        return base
    if base.endswith("/v1"):
        return f"{base}/responses"
    return f"{base}/v1/responses"


def extract_responses_text(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text
    chunks: list[str] = []
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, str):
                chunks.append(content)
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    text = block.get("text") or block.get("content")
                    if isinstance(text, str):
                        chunks.append(text)
    choices = payload.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                chunks.append(message["content"])
    return "\n".join(chunk for chunk in chunks if chunk).strip()


def append_planner_llm_session(workspace: Path, workflow_id: str, turn: dict[str, Any]) -> None:
    path = workspace / ".aris" / "web" / "workflows" / workflow_id / "planner" / "responses-session.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    current: dict[str, Any] = {"kind": "openai_responses_planner", "turns": []}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and isinstance(loaded.get("turns"), list):
                current = loaded
        except (OSError, json.JSONDecodeError):
            pass
    current.setdefault("kind", "openai_responses_planner")
    current.setdefault("turns", [])
    current["turns"].append(turn)
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")


def build_node_prompt_optimization_prompt(
    record: WorkflowRecord,
    graph: WorkflowGraph,
    node: WorkflowNode,
    instructions: str | None = None,
) -> str:
    config = get_agent_config(Path(record.workspace), node.config_file) if node.type == "sub_agent" and node.config_file else None
    nodes_context = [
        {
            "id": item.id,
            "type": item.type,
            "name": item.name,
            "role": item.role,
            "skill": item.skill,
            "task_type": item.task_type,
            "objective": item.objective,
            "acceptance_criteria": item.acceptance_criteria,
            "depends_on": item.depends_on,
            "inputs": prompt_context_data(item.inputs),
            "outputs": prompt_context_data(item.outputs),
        }
        for item in graph.nodes
    ]
    target = {
        "id": node.id,
        "type": node.type,
        "name": node.name,
        "role": node.role,
        "skill": node.skill,
        "task_type": node.task_type,
        "objective": node.objective,
        "acceptance_criteria": node.acceptance_criteria,
        "assignee_role": node.assignee_role,
        "profile": prompt_context_data(config) if config else None,
        "model": node.model,
        "effort": node.effort,
        "depends_on": node.depends_on,
        "inputs": prompt_context_data(node.inputs),
        "outputs": prompt_context_data(node.outputs),
        "current_prompt": node.prompt,
    }
    focus = instructions.strip() if instructions else ""
    return "\n".join(
        [
            "You are optimizing a single task prompt for an ARIS Web task board.",
            "Return only valid JSON with this exact shape: {\"prompt\":\"...\"}.",
            "",
            "Optimization rules:",
            "- Preserve the task's intent, role, skill contract, dependencies, acceptance criteria, and required outputs.",
            "- Make the prompt concrete, executable, and self-contained for the assigned agent.",
            "- Include clear success criteria and expected artifacts when outputs imply files or reports.",
            "- Do not execute the task, do not invent completed results, and do not change the task board graph.",
            "- Keep the prompt in the same natural language as the current prompt unless the user asks otherwise.",
            "- Avoid vague wording; make inputs, constraints, and deliverables explicit.",
            "",
            f"Task board title: {record.title}",
            f"Initial goal: {record.goal}",
            f"User optimization focus: {focus or 'Improve clarity, completeness, and execution reliability.'}",
            "",
            "Task board tasks:",
            json.dumps(nodes_context, ensure_ascii=False, indent=2),
            "",
            "Target task:",
            json.dumps(target, ensure_ascii=False, indent=2),
        ]
    )


async def optimize_node_prompt_with_aris(
    workspace: Path,
    record: WorkflowRecord,
    graph: WorkflowGraph,
    node: WorkflowNode,
    instructions: str | None = None,
    model: str | None = None,
) -> str:
    prompt = build_node_prompt_optimization_prompt(record, graph, node, instructions)
    optimizer_model = str(model or "").strip() or node.model or effective_model_override()
    settings = openai_compatible_settings(model=optimizer_model)
    if settings is not None:
        raw = await asyncio.to_thread(_request_openai_compatible_workflow_json, settings, prompt)
        return parse_optimized_prompt_text(raw)

    command = build_aris_command(workspace, prompt, optimizer_model)
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(workspace),
        env=build_runtime_env(model=optimizer_model),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    output = stdout.decode("utf-8", errors="replace")
    if process.returncode != 0:
        detail = (stderr or stdout).decode("utf-8", errors="replace")[-2000:]
        raise ValueError(detail or f"ARIS exited with code {process.returncode}")
    return parse_optimized_prompt_text(output)


def _request_openai_compatible_workflow_json(settings: dict[str, str], prompt: str) -> str:
    payload = {
        "model": settings["model"],
        "messages": [
            {"role": "system", "content": "Return only valid JSON. Do not include Markdown fences or prose."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "stream": False,
    }
    if settings.get("effort"):
        payload["reasoning_effort"] = settings["effort"]
    request = urllib.request.Request(
        f"{settings['base_url']}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {settings['api_key']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    context = ssl.create_default_context(cafile=certifi.where()) if certifi is not None else None
    try:
        with urllib.request.urlopen(request, timeout=120, context=context) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ValueError(detail or str(exc)) from exc
    except Exception as exc:
        raise ValueError(f"Workflow generation API request failed: {exc}") from exc
    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices:
        raise ValueError("Workflow generation API did not return choices")
    message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Workflow generation API returned an empty message")
    return content


async def _generate_workflow_graph_direct(prompt: str) -> tuple[str | None, str | None, WorkflowGraph] | None:
    settings = openai_compatible_settings()
    if settings is None:
        return None
    raw = await asyncio.to_thread(_request_openai_compatible_workflow_json, settings, prompt)
    return parse_generated_workflow_text(raw)


async def generate_workflow_graph_from_prompt(workspace: Path, prompt: str) -> tuple[str | None, str | None, WorkflowGraph]:
    direct = await _generate_workflow_graph_direct(prompt)
    if direct is not None:
        return direct
    command = build_aris_command(workspace, prompt, effective_model_override())
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(workspace),
        env=build_runtime_env(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        detail = (stderr or stdout).decode("utf-8", errors="replace")[-2000:]
        raise ValueError(detail or f"ARIS exited with code {process.returncode}")
    return parse_generated_workflow_text(stdout.decode("utf-8", errors="replace"))


async def generate_workflow_graph_with_aris(workspace: Path, goal: str) -> tuple[str | None, str | None, WorkflowGraph]:
    return await generate_workflow_graph_from_prompt(workspace, build_workflow_generation_prompt(goal, scan_skills()))


async def refine_workflow_graph_with_aris(
    workspace: Path,
    workflow: WorkflowRecord,
    current_graph: WorkflowGraph,
    instructions: str,
) -> tuple[str | None, str | None, WorkflowGraph]:
    prompt = build_workflow_refinement_prompt(workflow, current_graph, instructions, scan_skills())
    return await generate_workflow_graph_from_prompt(workspace, prompt)


_MISSING = object()


def _json_path_get(root: Any, path: str) -> Any:
    if path in {"", ".", "$"}:
        return root
    current = root
    normalized = path[2:] if path.startswith("$.") else path
    for raw_part in normalized.split("."):
        part = raw_part.strip()
        if not part:
            continue
        if isinstance(current, dict):
            current = current.get(part, _MISSING)
        elif isinstance(current, list) and part.isdigit():
            index = int(part)
            current = current[index] if 0 <= index < len(current) else _MISSING
        else:
            return _MISSING
        if current is _MISSING:
            return _MISSING
    return current


def _coerce_fanout_items(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        items: list[dict[str, Any]] = []
        for key, item_value in value.items():
            if isinstance(item_value, dict):
                item = dict(item_value)
                item.setdefault("name", key)
                item.setdefault("key", key)
                items.append(item)
            else:
                items.append({"name": key, "key": key, "value": item_value, "keywords": item_value})
        return items
    return []


def _try_extract_json_value(text: str) -> Any | None:
    stripped = text.strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    raw = _extract_json_blob(stripped)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _json_file_candidates(workspace: Path, workflow_id: str, source_node: WorkflowNode) -> list[tuple[Path, Any]]:
    node_dir = workspace / ".aris" / "web" / "workflows" / workflow_id / "nodes" / source_node.id
    if not node_dir.exists():
        return []
    candidates: list[tuple[Path, Any]] = []
    for json_path in sorted(node_dir.glob("attempt-*/*.json")):
        try:
            candidates.append((json_path, json.loads(json_path.read_text(encoding="utf-8"))))
        except (json.JSONDecodeError, OSError):
            continue
    return candidates


def _split_keyword_cell(value: str) -> list[str]:
    text = re.sub(r"<br\s*/?>", ";", value, flags=re.IGNORECASE)
    text = text.replace("；", ";").replace("、", ";").replace("，", ";")
    parts = re.split(r";|,|\n", text)
    return [part.strip(" `\"'") for part in parts if part.strip(" `\"'")]


def _parse_markdown_keyword_groups(text: str) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if not (line.startswith("|") and line.endswith("|")):
            index += 1
            continue
        headers = [cell.strip().lower() for cell in line.strip("|").split("|")]
        if not headers or index + 1 >= len(lines):
            index += 1
            continue
        separator = lines[index + 1].strip()
        if not (separator.startswith("|") and re.fullmatch(r"[|\s:\-]+", separator)):
            index += 1
            continue

        header_text = " ".join(headers)
        has_group_col = any(token in header_text for token in ("组", "group", "topic", "name"))
        has_keyword_col = any(token in header_text for token in ("keyword", "关键词", "phrase"))
        if not (has_group_col and has_keyword_col):
            index += 2
            continue

        group_index = next(
            (i for i, header in enumerate(headers) if any(token in header for token in ("组", "group", "topic", "name"))),
            0,
        )
        keyword_indexes = [
            i
            for i, header in enumerate(headers)
            if any(token in header for token in ("keyword", "关键词", "phrase"))
        ]
        purpose_index = next((i for i, header in enumerate(headers) if any(token in header for token in ("用途", "purpose", "use"))), None)

        row_index = index + 2
        while row_index < len(lines) and lines[row_index].strip().startswith("|"):
            cells = [cell.strip() for cell in lines[row_index].strip().strip("|").split("|")]
            if len(cells) >= len(headers):
                name = cells[group_index].strip()
                keywords: list[str] = []
                for keyword_index in keyword_indexes:
                    if keyword_index < len(cells):
                        keywords.extend(_split_keyword_cell(cells[keyword_index]))
                if name and keywords:
                    item: dict[str, Any] = {
                        "name": re.sub(r"\s+", " ", name),
                        "keywords": list(dict.fromkeys(keywords)),
                    }
                    if purpose_index is not None and purpose_index < len(cells) and cells[purpose_index].strip():
                        item["purpose"] = cells[purpose_index].strip()
                    groups.append(item)
            row_index += 1
        index = row_index
    return groups


def _markdown_file_candidates(workspace: Path, workflow_id: str, source_node: WorkflowNode) -> list[tuple[Path, Any]]:
    node_dir = workspace / ".aris" / "web" / "workflows" / workflow_id / "nodes" / source_node.id
    if not node_dir.exists():
        return []
    candidates: list[tuple[Path, Any]] = []
    for markdown_path in sorted([*node_dir.glob("attempt-*/*.md"), *node_dir.glob("attempt-*/*.markdown")]):
        try:
            text = markdown_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        parsed_json = _try_extract_json_value(text)
        if parsed_json is not None:
            candidates.append((markdown_path, parsed_json))
        keyword_groups = _parse_markdown_keyword_groups(text)
        if keyword_groups:
            candidates.append((markdown_path, {"keyword_groups": keyword_groups}))
    return candidates


def _load_node_output_value(workspace: Path, workflow_id: str, source_node: WorkflowNode, path: str) -> Any:
    if not source_node.run_id:
        return _MISSING
    raw: Any = None
    output_path = node_output_path(workspace, source_node.run_id)
    if output_path.exists():
        try:
            raw = json.loads(output_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            raw = None
    if raw is None:
        message_path = last_message_path(workspace, source_node.run_id)
        if message_path.exists():
            text = message_path.read_text(encoding="utf-8", errors="replace")
            try:
                raw = json.loads(text)
            except json.JSONDecodeError:
                raw = {"text": text, "json": _try_extract_json_value(text)}
    if raw is None:
        return _MISSING

    roots: list[Any] = []
    if isinstance(raw, dict) and raw.get("json") is not None:
        roots.append(raw["json"])
    roots.append(raw)
    if isinstance(raw, dict) and isinstance(raw.get("text"), str):
        parsed_text = _try_extract_json_value(raw["text"])
        if parsed_text is not None:
            roots.append(parsed_text)

    for root in roots:
        value = _json_path_get(root, path)
        if value is not _MISSING:
            return value

    for json_path, root in _json_file_candidates(workspace, workflow_id, source_node):
        value = _json_path_get(root, path)
        if value is not _MISSING:
            return value
        if json_path.stem == path:
            return root
    for markdown_path, root in _markdown_file_candidates(workspace, workflow_id, source_node):
        value = _json_path_get(root, path)
        if value is not _MISSING:
            return value
        if markdown_path.stem == path:
            return root
    return _MISSING


def _template_value_to_text(value: Any) -> str:
    if value is _MISSING or value is None:
        return ""
    if isinstance(value, list) and all(not isinstance(item, (dict, list)) for item in value):
        return ", ".join(str(item) for item in value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _fanout_artifact_filename(path: str) -> str:
    normalized = (path or "fanout_items").strip()
    normalized = normalized[2:] if normalized.startswith("$.") else normalized
    normalized = normalized.strip(".") or "fanout_items"
    filename = re.sub(r"[^A-Za-z0-9_-]+", "_", normalized).strip("_") or "fanout_items"
    return f"{filename}.json"


def _fanout_output_requirements(graph: WorkflowGraph, source_node: WorkflowNode) -> str:
    lines: list[str] = []
    for template in graph.nodes:
        if template.fanout is None:
            continue
        source_id = template.fanout.source or (template.depends_on[0] if template.depends_on else "")
        if source_id != source_node.id:
            continue
        path = (template.fanout.path or "$").strip() or "$"
        filename = _fanout_artifact_filename(path)
        lines.append(
            "\n".join(
                [
                    f"- `{template.name}` ({template.id}) will fan out from JSON path `{path}`.",
                    f"  Write `ARIS_SUBAGENT_DIR/{filename}` before your final summary.",
                    f"  The JSON must make `{path}` resolve to a non-empty array.",
                    '  For `keyword_groups`, use objects like {"name":"...", "keywords":["..."], "query":"...", "rationale":"..."}.',
                ]
            )
        )
    return "\n".join(lines) if lines else "(none)"


def _template_lookup(item: Any, token: str, index: int) -> Any:
    if token == "index":
        return index
    if token == "number":
        return index + 1
    if token == "item":
        return item
    if token.startswith("item."):
        return _json_path_get(item, token[5:])
    if isinstance(item, dict):
        return _json_path_get(item, token)
    return _MISSING


def _render_fanout_template(template: str, item: Any, index: int) -> str:
    def replace(match: re.Match[str]) -> str:
        return _template_value_to_text(_template_lookup(item, match.group(1).strip(), index))

    return re.sub(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}", replace, template)


def _fanout_item_label(item: Any, index: int) -> str:
    if isinstance(item, dict):
        for key in ("name", "label", "title", "group", "key", "id"):
            value = item.get(key)
            if value is not None and str(value).strip():
                return str(value)
        keywords = item.get("keywords")
        if isinstance(keywords, list) and keywords:
            return str(keywords[0])
        if isinstance(keywords, str) and keywords.strip():
            return keywords
    elif item is not None and str(item).strip():
        return str(item)
    return f"item-{index + 1}"


def _render_port_templates(ports: list[Any], item: Any, index: int) -> list[Any]:
    rendered = []
    for port in ports:
        data = model_dict(port) if hasattr(port, "dict") or hasattr(port, "model_dump") else deepcopy(port)
        if isinstance(data, dict):
            for key in ("name", "description"):
                if isinstance(data.get(key), str):
                    data[key] = _render_fanout_template(data[key], item, index)
            rendered.append(data)
        elif isinstance(data, str):
            rendered.append(_render_fanout_template(data, item, index))
        else:
            rendered.append(data)
    return rendered


class WorkflowEventBus:
    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue[WorkflowEvent]]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, workflow_id: str) -> asyncio.Queue[WorkflowEvent]:
        queue: asyncio.Queue[WorkflowEvent] = asyncio.Queue()
        async with self._lock:
            self._subscribers.setdefault(workflow_id, set()).add(queue)
        return queue

    async def unsubscribe(self, workflow_id: str, queue: asyncio.Queue[WorkflowEvent]) -> None:
        async with self._lock:
            subscribers = self._subscribers.get(workflow_id)
            if not subscribers:
                return
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(workflow_id, None)

    async def publish(self, event: WorkflowEvent) -> None:
        async with self._lock:
            subscribers = list(self._subscribers.get(event.workflow_id, set()))
        for queue in subscribers:
            queue.put_nowait(event)


class WorkflowManager:
    def __init__(
        self,
        run_manager: RunManager,
        *,
        max_concurrency: int = 2,
        node_runner: NodeRunner | None = None,
        planner_runner: PlannerRunner | None = None,
    ) -> None:
        self.run_manager = run_manager
        self.max_concurrency = max_concurrency
        self.node_runner = node_runner
        self.planner_runner = planner_runner
        self.bus = WorkflowEventBus()
        self._active: dict[str, set[str]] = {}
        self._planning: set[str] = set()

    def list(self, workspaces: list[object]) -> list[WorkflowRecord]:
        return list_workflows(workspaces)

    def get(self, workspace: Path, workflow_id: str) -> WorkflowRecord | None:
        return get_workflow(workspace, workflow_id)

    def runtime_policy(self, _workspace: Path, _workflow_id: str) -> RuntimePolicy:
        return RuntimePolicy()

    def decisions(self, workspace: Path, workflow_id: str) -> list[PlannerDecisionRecord]:
        return list_planner_decisions(workspace, workflow_id)

    def deltas(self, workspace: Path, workflow_id: str) -> list[WorkflowDeltaRecord]:
        return list_workflow_deltas(workspace, workflow_id)

    def artifact_index(self, workspace: Path, workflow_id: str) -> list[ArtifactIndexEntry]:
        record = self._require(workspace, workflow_id)
        entries = build_artifact_index(workspace, record)
        write_artifact_index(workspace, workflow_id, entries)
        return entries

    def runtime(self, workspace: Path, workflow_id: str) -> WorkflowRuntimeResponse:
        record = self._require(workspace, workflow_id)
        decisions = list_planner_decisions(workspace, workflow_id)
        deltas = list_workflow_deltas(workspace, workflow_id)
        artifacts = build_artifact_index(workspace, record)
        write_artifact_index(workspace, workflow_id, artifacts)
        handoffs = build_handoff_index(workspace, record)
        team_messages = build_team_chat_messages(workspace, record, artifacts)
        events = replay_workflow_events(workspace, workflow_id)
        latest = decisions[-1] if decisions else None
        nodes_by_id = {node.id: node for node in record.graph_json.nodes}
        dynamic_nodes = [node for node in record.graph_json.nodes if node.dynamic_parent_id]
        planner_active = workflow_id in self._planning
        active_ids = sorted(
            node_id
            for node_id in {
                *self._active.get(workflow_id, set()),
                *[node.id for node in record.graph_json.nodes if node.status == "running"],
            }
            if node_id in nodes_by_id
        )
        waiting_approval_nodes = [node for node in record.graph_json.nodes if node.status == "waiting_approval"]
        waiting_dynamic_nodes = [node for node in record.graph_json.nodes if node.status == "waiting_dynamic_dependency"]
        queued_nodes = [node for node in record.graph_json.nodes if node.status == "queued"]
        failed_nodes = [node for node in record.graph_json.nodes if node.status == "failed"]
        terminal_nodes = [node for node in record.graph_json.nodes if node.status in TERMINAL_NODE_STATUSES]
        ready_nodes = [
            node
            for node in queued_nodes
            if all(
                dep in nodes_by_id and nodes_by_id[dep].status in SUCCESS_NODE_STATUSES
                for dep in node.depends_on
            )
        ]
        blocked_sessions = [
            {
                "node_id": node.id,
                "session_id": _session_id_for_node(workflow_id, node),
                "session_path": node.session_path,
                "blocked_by": [dep for dep in node.depends_on if any(item.id == dep and item.dynamic_parent_id for item in record.graph_json.nodes)],
                "reason": node.dynamic_reason or node.error or "waiting for dynamic dependency",
            }
            for node in record.graph_json.nodes
            if node.status == "waiting_dynamic_dependency"
        ]
        rejection_count = sum(1 for delta in deltas if not delta.policy_result.allowed)
        if planner_active:
            execution_state = "planning"
            next_action = "Planner is checking the current plan snapshot."
        elif record.status == "draft":
            execution_state = "draft"
            next_action = "Run the workflow to start execution."
        elif active_ids:
            execution_state = "running"
            next_action = f"Waiting for {len(active_ids)} active node(s) to finish."
        elif waiting_dynamic_nodes:
            execution_state = "waiting_dynamic_dependency"
            next_action = "Waiting for dynamic literature dependencies before resuming blocked sessions."
        elif waiting_approval_nodes:
            execution_state = "waiting_approval"
            next_action = "Human approval is required before downstream execution can continue."
        elif record.status in {"succeeded", "failed", "cancelled"}:
            execution_state = record.status
            next_action = f"Workflow is {record.status}."
        elif failed_nodes and record.status == "paused":
            execution_state = "failed"
            failed_names = ", ".join(node.name or node.id for node in failed_nodes[:3])
            suffix = "" if len(failed_nodes) <= 3 else f" (+{len(failed_nodes) - 3} more)"
            next_action = f"{len(failed_nodes)} node(s) failed: {failed_names}{suffix}. Rerun the failed role or restart the runtime."
        elif ready_nodes:
            execution_state = "ready"
            next_action = f"{len(ready_nodes)} queued node(s) are ready for the scheduler."
        elif queued_nodes and record.status == "running":
            execution_state = "scheduled"
            next_action = "Queued nodes are waiting for upstream dependencies or the next scheduler tick."
        elif record.status == "paused":
            execution_state = "paused"
            next_action = "Workflow is paused. Resume or approve the waiting item to continue."
        else:
            execution_state = "idle"
            next_action = "No active runtime work is currently scheduled."
        summary = RuntimeSummary(
            planner_session_id=_planner_session_id(workflow_id),
            planner_session_path=_safe_relative(workspace, planner_session_path(workspace, workflow_id)),
            execution_state=execution_state,
            next_action=next_action,
            planner_active=planner_active,
            latest_tick_id=latest.tick_id if latest else None,
            latest_decision_type=latest.decision_type if latest else None,
            latest_rationale=latest.rationale if latest else "",
            active_node_count=len(active_ids),
            active_node_ids=active_ids,
            waiting_approval_count=len(waiting_approval_nodes),
            waiting_approval_node_ids=[node.id for node in waiting_approval_nodes],
            waiting_dynamic_dependency_count=len(waiting_dynamic_nodes),
            waiting_dynamic_dependency_node_ids=[node.id for node in waiting_dynamic_nodes],
            queued_node_count=len(queued_nodes),
            ready_node_count=len(ready_nodes),
            ready_node_ids=[node.id for node in ready_nodes],
            failed_node_count=len(failed_nodes),
            failed_node_ids=[node.id for node in failed_nodes],
            terminal_node_count=len(terminal_nodes),
            dynamic_node_count=len(dynamic_nodes),
            blocked_session_count=len(blocked_sessions),
            artifact_count=len(artifacts),
            delta_count=len(deltas),
            decision_count=len(decisions),
            policy_rejection_count=rejection_count,
            last_event_at=events[-1].timestamp if events else None,
        )
        return WorkflowRuntimeResponse(
            workflow_id=workflow_id,
            runtime_policy=self.runtime_policy(workspace, workflow_id),
            runtime_summary=summary,
            plan_snapshot=plan_snapshot(record.graph_json),
            latest_decision=latest,
            blocked_sessions=blocked_sessions,
            dynamic_nodes=dynamic_nodes,
            artifact_index=artifacts,
            handoffs=handoffs,
            team_messages=team_messages,
        )

    def task_board(self, workspace: Path, workflow_id: str) -> TaskBoardResponse:
        record = self._require(workspace, workflow_id)
        runtime = self.runtime(workspace, workflow_id)
        artifacts_by_node: dict[str, list[ArtifactIndexEntry]] = {}
        for artifact in runtime.artifact_index:
            if artifact.producer_node_id:
                artifacts_by_node.setdefault(artifact.producer_node_id, []).append(artifact)
        nodes_by_id = {node.id: node for node in record.graph_json.nodes}
        tasks: list[TaskBoardTask] = []
        columns = [
            TaskBoardColumnSummary(id=column_id, title=title, task_ids=[])
            for column_id, title in TASK_BOARD_COLUMN_TITLES.items()
        ]
        columns_by_id = {column.id: column for column in columns}
        for node in sorted(record.graph_json.nodes, key=lambda item: (item.priority, item.position.get("x", 0), item.position.get("y", 0), item.id)):
            column = task_board_column_for_node(node, nodes_by_id)
            task = TaskBoardTask(
                id=node.id,
                name=node.name,
                task_type="input" if node.type == "input" else "gate" if node.type == "human_gate" else node.task_type,
                column=column,  # type: ignore[arg-type]
                status=node.status,
                role=node.role,
                skill=node.skill,
                objective=task_objective(node),
                prompt=node.prompt,
                inputs=node.inputs,
                outputs=node.outputs,
                depends_on=node.depends_on,
                acceptance_criteria=node.acceptance_criteria,
                assignee_role=node.assignee_role or node.role or node.team_role_id,
                assigned_to=node.assigned_to,
                claimed_by=node.claimed_by,
                review_status=node.review_status,
                review_notes=node.review_notes,
                priority=node.priority,
                artifact_refs=artifacts_by_node.get(node.id, []),
                dynamic_parent_id=node.dynamic_parent_id,
                dynamic_reason=node.dynamic_reason,
                team_id=node.team_id,
                team_role_id=node.team_role_id,
                team_role_kind=node.team_role_kind,
                scope=node.scope,
                can_ask_questions=node.can_ask_questions,
                can_clone_workers=node.can_clone_workers,
                can_call_planner=node.can_call_planner,
                peer_access=node.peer_access,
                reports_to_chat=node.reports_to_chat,
                run_id=node.run_id,
                error=node.error,
            )
            tasks.append(task)
            columns_by_id[task.column].task_ids.append(task.id)
        return TaskBoardResponse(
            id=record.id,
            workspace=record.workspace,
            title=record.title,
            goal=record.goal,
            status=record.status,
            tasks=tasks,
            columns=columns,
            dependencies=record.graph_json.edges,
            artifact_index=runtime.artifact_index,
            runtime_summary=runtime.runtime_summary,
        )

    def session_view(self, workspace: Path, workflow_id: str, session_id: str) -> SessionRuntimeView:
        record = self._require(workspace, workflow_id)
        artifacts = read_artifact_index(workspace, workflow_id) or build_artifact_index(workspace, record)
        events = replay_workflow_events(workspace, workflow_id)
        if session_id == _planner_session_id(workflow_id) or session_id == "planner":
            filtered = [event for event in events if event.event_type in {"planner", "delta"}]
            return SessionRuntimeView(
                session_id=_planner_session_id(workflow_id),
                workflow_id=workflow_id,
                kind="planner",
                session_path=_safe_relative(workspace, planner_session_path(workspace, workflow_id)),
                events=filtered,
                artifact_refs=[],
                resume_turns=[],
            )
        prefix = f"node:{workflow_id}:"
        node_id = session_id[len(prefix):] if session_id.startswith(prefix) else session_id
        node = self._find_node(record.graph_json, node_id)
        filtered = [event for event in events if event.node_id == node_id or (event.payload or {}).get("node_id") == node_id]
        node_artifacts = [artifact for artifact in artifacts if artifact.producer_node_id == node_id or artifact.session_id == _session_id_for_node(workflow_id, node)]
        resume_turns = [
            {
                "timestamp": event.timestamp,
                "message": event.message,
                "payload": event.payload,
            }
            for event in events
            if event.event_type in {"planner", "session", "delta"} and node_id in json.dumps(event.payload or {}, ensure_ascii=False)
        ]
        return SessionRuntimeView(
            session_id=_session_id_for_node(workflow_id, node),
            workflow_id=workflow_id,
            node_id=node_id,
            kind="node",
            session_path=node.session_path,
            events=filtered,
            artifact_refs=node_artifacts,
            resume_turns=resume_turns,
        )

    async def create(
        self,
        workspace: Path,
        title: str,
        goal: str,
        graph: WorkflowGraph | None = None,
        template: str | None = None,
    ) -> WorkflowRecord:
        skills = {skill.id for skill in scan_skills()}
        normalized = normalize_workflow_graph(graph or workflow_template_graph(template, goal, skills), skills)
        record = create_workflow_record(workspace, title, goal, normalized)
        insert_workflow(record)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=record.id,
                timestamp=utc_now(),
                event_type="workflow",
                message="Workflow created",
                payload={"status": record.status},
            ),
        )
        return record

    async def generate(self, workspace: Path, goal: str, title: str | None = None) -> WorkflowRecord:
        skills = {skill.id for skill in scan_skills()}
        generated_title, generated_goal, graph = await generate_workflow_graph_with_aris(workspace, goal)
        normalized = normalize_workflow_graph(graph, skills)
        return await self.create(
            workspace,
            title or generated_title or goal[:64] or "Generated workflow",
            generated_goal or goal,
            normalized,
        )

    async def refine(
        self,
        workspace: Path,
        workflow_id: str,
        instructions: str,
        *,
        title: str | None = None,
        graph: WorkflowGraph | None = None,
    ) -> WorkflowRecord:
        instructions = instructions.strip()
        if not instructions:
            raise ValueError("Refinement instructions must not be empty")
        record = self._require(workspace, workflow_id)
        if record.status == "running":
            raise ValueError("Pause or cancel the workflow before updating it with AI")

        skills = {skill.id for skill in scan_skills()}
        current_graph = normalize_workflow_graph(graph or record.graph_json, skills)
        generated_title, generated_goal, generated_graph = await refine_workflow_graph_with_aris(
            workspace,
            record,
            current_graph,
            instructions,
        )
        normalized, preserved_nodes, reset_nodes = merge_workflow_execution_state(
            record.graph_json,
            normalize_workflow_graph(generated_graph, skills),
        )
        next_status = record.status if record.status in {"draft", "paused"} else "draft"
        update_workflow(
            workspace,
            workflow_id,
            title=title or record.title or generated_title,
            goal=generated_goal or record.goal,
            status=next_status,
            graph_json=normalized,
            clear_error=True,
        )
        updated = self._require(workspace, workflow_id)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="workflow",
                message="Workflow updated from AI instructions",
                payload={"node_count": len(updated.graph_json.nodes), "preserved_nodes": preserved_nodes, "reset_nodes": reset_nodes},
            ),
        )
        return updated

    async def update(
        self,
        workspace: Path,
        workflow_id: str,
        *,
        title: str | None = None,
        goal: str | None = None,
        graph: WorkflowGraph | None = None,
        status: str | None = None,
    ) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        normalized = None
        if graph is not None:
            normalized = normalize_workflow_graph(graph, {skill.id for skill in scan_skills()})
        update_workflow(
            workspace,
            workflow_id,
            title=title,
            goal=goal,
            status=status,  # type: ignore[arg-type]
            graph_json=normalized,
        )
        updated = self._require(workspace, workflow_id)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="workflow",
                message="Workflow updated",
                payload={"status": updated.status, "previous_status": record.status},
            ),
        )
        return updated

    async def claim_task(
        self,
        workspace: Path,
        workflow_id: str,
        node_id: str,
        request: TaskClaimRequest,
    ) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        graph = record.graph_json
        node = self._find_node(graph, node_id)
        claimer = (request.agent_id or request.role or "").strip()
        if not claimer:
            raise ValueError("Task claim requires agent_id or role")
        node.claimed_by = claimer
        if request.role:
            node.assignee_role = request.role.strip() or node.assignee_role
        if not node.assigned_to:
            node.assigned_to = claimer
        update_workflow(workspace, workflow_id, graph_json=graph, clear_error=True)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="node",
                node_id=node_id,
                message=f"Task claimed: {node.name}",
                payload={"claimed_by": node.claimed_by, "assignee_role": node.assignee_role},
            ),
        )
        return self._require(workspace, workflow_id)

    async def review_task(
        self,
        workspace: Path,
        workflow_id: str,
        node_id: str,
        request: TaskReviewRequest,
    ) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        graph = record.graph_json
        node = self._find_node(graph, node_id)
        node.review_status = request.review_status
        node.review_notes = request.notes.strip()
        if request.acceptance_criteria is not None:
            node.acceptance_criteria = [item.strip() for item in request.acceptance_criteria if item.strip()]
        if request.review_status == "passed":
            if node.status == "waiting_approval" and node.type == "human_gate":
                node.status = "succeeded"
            elif node.status == "waiting_approval" and node.run_id:
                node.approved_after = True
                node.status = "succeeded"
            elif node.status == "failed":
                node.status = "succeeded"
            node.error = None
        else:
            if request.reset_for_rework:
                node.status = "queued"
                node.run_id = None
                node.session_path = None
                node.approved_after = False
                node.error = request.notes.strip() or "Reviewer requested rework"
        update_workflow(workspace, workflow_id, status="running", graph_json=graph, clear_error=True, clear_finished_at=True)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="approval",
                node_id=node_id,
                message=f"Task review recorded: {node.name}",
                payload={"review_status": node.review_status, "review_notes": node.review_notes},
            ),
        )
        if request.review_status == "passed":
            await self._tick(workspace, workflow_id)
        return self._require(workspace, workflow_id)

    async def optimize_node_prompt(
        self,
        workspace: Path,
        workflow_id: str,
        node_id: str,
        *,
        graph: WorkflowGraph | None = None,
        instructions: str | None = None,
        model: str | None = None,
    ) -> str:
        record = self._require(workspace, workflow_id)
        normalized = normalize_workflow_graph(graph or record.graph_json, {skill.id for skill in scan_skills()})
        node = self._find_node(normalized, node_id)
        if not node.prompt.strip():
            raise ValueError("Node prompt is empty")
        return await optimize_node_prompt_with_aris(workspace, record, normalized, node, instructions, model=model)

    async def expand_team(
        self,
        workspace: Path,
        workflow_id: str,
        *,
        team_id: str,
        prefix: str | None = None,
        position: dict[str, float] | None = None,
        depends_on: list[str] | None = None,
        connect_to: list[str] | None = None,
    ) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        team = get_team_config(workspace, team_id)
        if team is None:
            raise ValueError("Team config not found")
        if not team.roles:
            raise ValueError("Team config has no roles")

        graph = record.graph_json
        existing_ids = {node.id for node in graph.nodes}
        role_ids = {role.id for role in team.roles}
        dep_ids = [item.strip() for item in (depends_on or []) if item.strip()]
        target_ids = [item.strip() for item in (connect_to or []) if item.strip()]
        for node_id in [*dep_ids, *target_ids]:
            if node_id not in existing_ids:
                raise ValueError(f"Team expansion references an unknown workflow node: {node_id}")

        instance_id = _slug(prefix or team.id)
        if not instance_id:
            raise ValueError("Team expansion prefix must not be empty")
        generated_ids = {f"{instance_id}-{role.id}" for role in team.roles}
        conflicts = sorted(generated_ids & existing_ids)
        if conflicts:
            raise ValueError(f"Team expansion would overwrite existing node id(s): {', '.join(conflicts)}")

        incoming_roles = {edge.target for edge in team.default_edges}
        outgoing_roles = {edge.source for edge in team.default_edges}
        entry_roles = role_ids - incoming_roles or role_ids
        exit_roles = role_ids - outgoing_roles or role_ids
        base_x = float((position or {}).get("x", 120))
        base_y = float((position or {}).get("y", 140))

        new_nodes: list[WorkflowNode] = []
        new_edges: list[WorkflowEdge] = []
        for index, role in enumerate(team.roles):
            node_id = f"{instance_id}-{role.id}"
            offset_x = float(role.position_offset.get("x", index * 240))
            offset_y = float(role.position_offset.get("y", 0))
            node_depends_on = [f"{instance_id}-{edge.source}" for edge in team.default_edges if edge.target == role.id]
            if role.id in entry_roles:
                node_depends_on.extend(dep_id for dep_id in dep_ids if dep_id not in node_depends_on)
            new_nodes.append(
                WorkflowNode(
                    id=node_id,
                    type="sub_agent",
                    name=role.name,
                    role=role.role,
                    config_file=role.config_file,
                    skill=role.skill,
                    prompt=role.prompt,
                    model=role.model,
                    effort=role.effort,
                    inputs=role.inputs,
                    outputs=role.outputs,
                    gate=role.gate,
                    depends_on=node_depends_on,
                    failure_policy=role.failure_policy,
                    concurrency_class=role.concurrency_class,
                    position={"x": base_x + offset_x, "y": base_y + offset_y},
                    team_id=team.id,
                    team_instance_id=instance_id,
                    team_role_id=role.id,
                    team_role_kind=role.kind,
                    scope=role.scope,
                    can_ask_questions=role.can_ask_questions,
                    can_clone_workers=role.can_clone_workers,
                    can_call_planner=role.can_call_planner,
                    peer_access=role.peer_access,
                    reports_to_chat=role.reports_to_chat,
                )
            )

        for edge in team.default_edges:
            new_edges.append(
                WorkflowEdge(
                    id=f"{instance_id}-{edge.source}->{instance_id}-{edge.target}",
                    source=f"{instance_id}-{edge.source}",
                    target=f"{instance_id}-{edge.target}",
                )
            )
        for dep_id in dep_ids:
            for role_id in sorted(entry_roles):
                new_edges.append(
                    WorkflowEdge(
                        id=f"{dep_id}->{instance_id}-{role_id}",
                        source=dep_id,
                        target=f"{instance_id}-{role_id}",
                    )
                )
        for target_id in target_ids:
            target_node = next(node for node in graph.nodes if node.id == target_id)
            for role_id in sorted(exit_roles):
                source_id = f"{instance_id}-{role_id}"
                if source_id not in target_node.depends_on:
                    target_node.depends_on.append(source_id)
                new_edges.append(WorkflowEdge(id=f"{source_id}->{target_id}", source=source_id, target=target_id))

        next_graph = WorkflowGraph(
            schema_version=2,
            nodes=[*graph.nodes, *new_nodes],
            edges=[*graph.edges, *new_edges],
            max_concurrency=graph.max_concurrency,
            class_limits=graph.class_limits,
        )
        normalized = normalize_workflow_graph(next_graph, {skill.id for skill in scan_skills()})
        update_workflow(workspace, workflow_id, graph_json=normalized)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="workflow",
                message=f"Team expanded: {team.name}",
                payload={"team_id": team.id, "team_instance_id": instance_id, "nodes": sorted(generated_ids)},
            ),
        )
        return self._require(workspace, workflow_id)

    async def delete(self, workspace: Path, workflow_id: str) -> None:
        record = self._require(workspace, workflow_id)
        for node in record.graph_json.nodes:
            if node.status == "running" and node.run_id:
                await self.run_manager.cancel(workspace, node.run_id)
        self._active.pop(workflow_id, None)
        delete_workflow(workspace, workflow_id)

    async def execute(
        self,
        workspace: Path,
        workflow_id: str,
        *,
        auto_approve_executable: bool = False,
        restart: bool = False,
    ) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        ensure_research_wiki(workspace)
        if auto_approve_executable or restart:
            graph = (
                prepare_graph_for_task_board_run(record.graph_json, restart=restart)
                if auto_approve_executable
                else reset_workflow_execution_state(record.graph_json)
            )
            removed_sessions = clear_workflow_node_sessions(workspace, workflow_id, record.graph_json) if restart else 0
            update_workflow(workspace, workflow_id, graph_json=graph, clear_error=True, clear_finished_at=True)
        else:
            removed_sessions = 0
        started_at = utc_now() if restart else record.started_at or utc_now()
        update_workflow(workspace, workflow_id, status="running", started_at=started_at, finished_at=None, clear_error=True)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="workflow",
                message="Workflow execution restarted" if restart else "Workflow execution started",
                payload={"auto_approve_executable": auto_approve_executable, "restart": restart, "removed_sessions": removed_sessions},
            ),
        )
        await self._tick(workspace, workflow_id)
        return self._require(workspace, workflow_id)

    async def pause(self, workspace: Path, workflow_id: str) -> WorkflowRecord:
        self._require(workspace, workflow_id)
        update_workflow(workspace, workflow_id, status="paused")
        await self._append_event(
            workspace,
            WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="workflow", message="Workflow paused"),
        )
        return self._require(workspace, workflow_id)

    async def resume(self, workspace: Path, workflow_id: str) -> WorkflowRecord:
        self._require(workspace, workflow_id)
        update_workflow(workspace, workflow_id, status="running")
        await self._append_event(
            workspace,
            WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="workflow", message="Workflow resumed"),
        )
        await self._tick(workspace, workflow_id)
        return self._require(workspace, workflow_id)

    async def cancel(self, workspace: Path, workflow_id: str) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        graph = record.graph_json
        for node in graph.nodes:
            if node.status == "running" and node.run_id:
                await self.run_manager.cancel(workspace, node.run_id)
            if node.status in {"queued", "blocked", "waiting_dynamic_dependency", "waiting_approval", "running"}:
                node.status = "cancelled"
        update_workflow(workspace, workflow_id, status="cancelled", graph_json=graph, finished_at=utc_now())
        await self._append_event(
            workspace,
            WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="workflow", message="Workflow cancelled"),
        )
        return self._require(workspace, workflow_id)

    async def approve_node(self, workspace: Path, workflow_id: str, node_id: str) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        graph = record.graph_json
        node = self._find_node(graph, node_id)
        if node.status != "waiting_approval":
            raise ValueError(f"Node is not waiting for approval: {node_id}")
        if node.type == "human_gate":
            node.status = "succeeded"
        elif node.run_id:
            node.approved_after = True
            node.status = "succeeded"
        else:
            node.approved_before = True
            node.status = "queued"
        update_workflow(workspace, workflow_id, status="running", graph_json=graph, clear_error=True)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="node",
                node_id=node_id,
                message=f"Node approved: {node.name}",
                payload={"status": node.status},
            ),
        )
        await self._tick(workspace, workflow_id)
        return self._require(workspace, workflow_id)

    async def approve_batch(self, workspace: Path, workflow_id: str) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        graph = record.graph_json
        batch_nodes = [
            node
            for node in graph.nodes
            if node.type in EXECUTABLE_NODE_TYPES
            and node.status == "waiting_approval"
            and node.run_id
            and not node.approved_after
        ]
        if not batch_nodes:
            raise ValueError("No completed execution batch is waiting for approval")
        for node in batch_nodes:
            node.approved_after = True
            node.status = "succeeded"
            node.error = None
        update_workflow(workspace, workflow_id, status="running", graph_json=graph, clear_error=True)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="workflow",
                message=f"Batch approved: {len(batch_nodes)} node(s)",
                payload={"approved_nodes": [node.id for node in batch_nodes]},
            ),
        )
        await self._tick(workspace, workflow_id)
        return self._require(workspace, workflow_id)

    async def skip_node(self, workspace: Path, workflow_id: str, node_id: str) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        graph = record.graph_json
        node = self._find_node(graph, node_id)
        if node.status == "running" and node.run_id:
            await self.run_manager.cancel(workspace, node.run_id)
        node.status = "skipped"
        node.error = None
        update_workflow(workspace, workflow_id, status="running", graph_json=graph, clear_error=True)
        await self._append_event(
            workspace,
            WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node_id, message=f"Node skipped: {node.name}"),
        )
        await self._tick(workspace, workflow_id)
        return self._require(workspace, workflow_id)

    async def restore_node(
        self,
        workspace: Path,
        workflow_id: str,
        node_id: str,
        *,
        reset_downstream: bool = False,
    ) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        graph = record.graph_json
        node = self._find_node(graph, node_id)
        if node.status != "skipped":
            raise ValueError("Only skipped nodes can be restored")

        node.status = "queued"
        node.run_id = None
        node.error = None
        node.attempt = 0
        node.approved_after = False
        if node.gate in {"before", "both"} or node.type == "human_gate":
            node.approved_before = False

        restored_downstream: list[str] = []
        if reset_downstream:
            descendants = self._descendants(graph, node_id)
            for item in graph.nodes:
                if item.id in descendants and item.status == "skipped":
                    item.status = "queued"
                    item.run_id = None
                    item.error = None
                    item.attempt = 0
                    item.approved_before = False
                    item.approved_after = False
                    restored_downstream.append(item.id)

        update_workflow(
            workspace,
            workflow_id,
            status="paused",
            graph_json=graph,
            clear_error=True,
            clear_finished_at=True,
        )
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="node",
                node_id=node_id,
                message=f"Node restored: {node.name}",
                payload={"status": "queued", "restored_downstream": restored_downstream},
            ),
        )
        return self._require(workspace, workflow_id)

    async def rerun_node(self, workspace: Path, workflow_id: str, node_id: str, *, reset_downstream: bool = False) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        graph = record.graph_json
        node = self._find_node(graph, node_id)
        node.status = "queued"
        node.run_id = None
        node.error = None
        node.attempt = 0
        node.approved_after = False
        if node.gate in {"before", "both"}:
            node.approved_before = False
        if reset_downstream:
            descendants = self._descendants(graph, node_id)
            for item in graph.nodes:
                if item.id in descendants:
                    item.status = "queued"
                    item.run_id = None
                    item.error = None
                    item.attempt = 0
                    item.approved_before = False
                    item.approved_after = False
        update_workflow(workspace, workflow_id, status="running", graph_json=graph)
        await self._append_event(
            workspace,
            WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node_id, message=f"Node queued for rerun: {node.name}"),
        )
        await self._tick(workspace, workflow_id)
        return self._require(workspace, workflow_id)

    async def replay_events(self, workspace: Path, workflow_id: str, limit: int | None = None) -> list[WorkflowEvent]:
        events: list[WorkflowEvent] = []
        for event in replay_workflow_events(workspace, workflow_id, limit=limit):
            events.extend(expand_replayed_workflow_event(event))
        return events

    async def _expand_fanout_node(
        self,
        workspace: Path,
        workflow_id: str,
        graph: WorkflowGraph,
        node: WorkflowNode,
    ) -> bool:
        if node.type != "sub_agent" or node.fanout is None:
            return False
        nodes_by_id = {item.id: item for item in graph.nodes}
        source_id = node.fanout.source or (node.depends_on[0] if node.depends_on else "")
        source_node = nodes_by_id.get(source_id)
        if source_node is None:
            node.status = "failed"
            node.error = "Fan-out source node not found"
            update_workflow(workspace, workflow_id, graph_json=graph)
            await self._append_event(
                workspace,
                WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node.id, message=f"Fan-out failed: {node.error}"),
            )
            return True
        if source_node.status not in SUCCESS_NODE_STATUSES:
            node.status = "failed"
            node.error = f"Fan-out source is not complete: {source_id}"
            update_workflow(workspace, workflow_id, graph_json=graph)
            await self._append_event(
                workspace,
                WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node.id, message=f"Fan-out failed: {node.error}"),
            )
            return True

        value = _load_node_output_value(workspace, workflow_id, source_node, node.fanout.path.strip())
        items = [] if value is _MISSING else _coerce_fanout_items(value)
        max_items = max(0, int(node.fanout.max_items or 0))
        if max_items:
            items = items[:max_items]
        if not items:
            if node.fanout.empty_policy == "succeed":
                node.status = "succeeded"
                node.error = None
                update_workflow(workspace, workflow_id, graph_json=graph)
                await self._append_event(
                    workspace,
                    WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node.id, message=f"Fan-out produced no items: {node.name}"),
                )
                return True
            node.status = "failed"
            node.error = f"Fan-out found no items at path: {node.fanout.path or '(root)'}"
            update_workflow(workspace, workflow_id, graph_json=graph)
            await self._append_event(
                workspace,
                WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node.id, message=f"Fan-out failed: {node.error}"),
            )
            return True

        existing_children = {item.id for item in graph.nodes if item.fanout_parent_id == node.id}
        downstream_nodes = [
            item
            for item in graph.nodes
            if item.id != node.id and (node.id in item.depends_on or any(dep in existing_children for dep in item.depends_on))
        ]
        if existing_children:
            graph.nodes = [item for item in graph.nodes if item.id not in existing_children]
            downstream_ids = {item.id for item in downstream_nodes}
            for item in graph.nodes:
                if item.id not in downstream_ids:
                    item.depends_on = [dep for dep in item.depends_on if dep not in existing_children]

        existing_ids = {item.id for item in graph.nodes}
        generated_ids: list[str] = []
        base_x = float(node.position.get("x", 0))
        base_y = float(node.position.get("y", 0))
        for index, item in enumerate(items):
            label = _fanout_item_label(item, index)
            base_id = f"{node.id}-{_safe_node_slug(label, f'item-{index + 1}')}"
            child_id = base_id
            suffix = 2
            while child_id in existing_ids:
                child_id = f"{base_id}-{suffix}"
                suffix += 1
            existing_ids.add(child_id)
            generated_ids.append(child_id)
            rendered_name = _render_fanout_template(node.fanout.name_template or "{{item.name}}", item, index).strip()
            if not rendered_name:
                rendered_name = f"{node.name}: {label}"
            child = WorkflowNode(
                id=child_id,
                type="sub_agent",
                name=rendered_name,
                role=node.role,
                skill=node.skill,
                config_file=node.config_file,
                prompt=_render_fanout_template(node.prompt, item, index),
                model=node.model,
                effort=node.effort,
                gate=node.gate,
                depends_on=list(node.depends_on),
                inputs=_render_port_templates(node.inputs, item, index),
                outputs=_render_port_templates(node.outputs, item, index),
                position={"x": base_x + (index + 1) * 220, "y": base_y + 90},
                timeout_seconds=node.timeout_seconds,
                retry=deepcopy(node.retry),
                failure_policy=node.failure_policy,
                concurrency_class=node.concurrency_class,
                fanout_parent_id=node.id,
                fanout_item=item,
                team_id=node.team_id,
                team_instance_id=node.team_instance_id,
                team_role_id=node.team_role_id,
                team_role_kind=node.team_role_kind,
                scope=node.scope,
                can_ask_questions=node.can_ask_questions,
                can_clone_workers=node.can_clone_workers,
                can_call_planner=node.can_call_planner,
                peer_access=node.peer_access,
                reports_to_chat=node.reports_to_chat,
                task_type=node.task_type,
                objective=_render_fanout_template(node.objective, item, index) if node.objective else "",
                acceptance_criteria=[
                    _render_fanout_template(criteria, item, index)
                    for criteria in node.acceptance_criteria
                ],
                assignee_role=node.assignee_role,
                assigned_to=node.assigned_to,
                claimed_by=node.claimed_by,
                review_status=node.review_status,
                review_notes=node.review_notes,
                priority=node.priority,
            )
            graph.nodes.append(child)

        for item in downstream_nodes:
            next_deps: list[str] = []
            inserted_generated = False
            for dep in item.depends_on:
                if dep == node.id or dep in existing_children:
                    if inserted_generated:
                        continue
                    for child_id in generated_ids:
                        if child_id not in next_deps:
                            next_deps.append(child_id)
                    inserted_generated = True
                elif dep not in next_deps:
                    next_deps.append(dep)
            item.depends_on = next_deps

        node.status = "succeeded"
        node.error = None
        node.approved_after = True
        # Rebuild edges from the updated dependency lists so stale
        # template->downstream edges do not get reintroduced by normalization.
        next_graph = WorkflowGraph(
            schema_version=2,
            nodes=graph.nodes,
            edges=[],
            max_concurrency=graph.max_concurrency,
            class_limits=graph.class_limits,
        )
        normalized = normalize_workflow_graph(next_graph, {skill.id for skill in scan_skills()})
        update_workflow(workspace, workflow_id, graph_json=normalized)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="workflow",
                message=f"Fan-out expanded {node.name}: {len(generated_ids)} SubAgent node(s)",
                payload={"template_node": node.id, "source_node": source_id, "generated_nodes": generated_ids},
            ),
        )
        return True

    def _build_planner_prompt(self, workspace: Path, record: WorkflowRecord, trigger: str) -> str:
        nodes = [
            {
                "id": node.id,
                "type": node.type,
                "name": node.name,
                "role": node.role,
                "skill": node.skill,
                "status": node.status,
                "depends_on": node.depends_on,
                "run_id": node.run_id,
                "error": node.error,
                "dynamic_parent_id": node.dynamic_parent_id,
                "dynamic_reason": node.dynamic_reason,
                "research_request": node.research_request,
                "auto_approve_after": node.auto_approve_after,
                "task_type": node.task_type,
                "objective": node.objective,
                "acceptance_criteria": node.acceptance_criteria,
                "assignee_role": node.assignee_role or node.role or node.team_role_id,
                "assigned_to": node.assigned_to,
                "claimed_by": node.claimed_by,
                "review_status": node.review_status,
                "review_notes": node.review_notes,
                "priority": node.priority,
            }
            for node in record.graph_json.nodes
        ]
        recent_events = [
            {
                "event_type": event.event_type,
                "node_id": event.node_id,
                "message": event.message[-240:],
            }
            for event in replay_workflow_events(workspace, record.id)[-60:]
            if event.event_type in {"workflow", "node", "planner", "delta", "team_message", "session", "artifact"}
        ]
        recent_events = recent_events[-30:]
        artifacts = build_artifact_index(workspace, record)
        team_messages = [
            {
                "timestamp": item.timestamp,
                "node_id": item.node_id,
                "role": item.role,
                "role_kind": item.role_kind,
                "scope": item.scope,
                "message": item.message,
                "artifact_refs": [artifact.path for artifact in item.artifact_refs],
                "can_ask_questions": item.can_ask_questions,
                "can_clone_workers": item.can_clone_workers,
            }
            for item in build_team_chat_messages(workspace, record, artifacts)[-30:]
        ]
        artifact_refs = [
            {
                "path": artifact.path,
                "producer_node_id": artifact.producer_node_id,
                "kind": artifact.kind,
                "summary": artifact.summary[:240],
            }
            for artifact in artifacts[:40]
        ]
        return "\n".join(
            [
                "You are the persistent Manager/Planner Agent for an ARIS Web task board runtime.",
                "Return ONLY valid JSON. Do not include Markdown fences or prose.",
                "",
                "Your job is to inspect the current materialized task board and decide whether to dynamically add follow-up tasks, add dependencies, block tasks, resume tasks, or do nothing.",
                "Rules:",
                "- Keep the graph acyclic.",
                "- Only the Manager/Planner may change the task dependency graph.",
                "- New dynamic work must be a stateless sub_agent task with objective, assignee_role, acceptance_criteria, and expected artifacts.",
                "- Use skill research-lit for literature gaps, research-review for reviewer follow-up, paper-write for writing, and null/ad-hoc skill only when no bundled skill fits.",
                "- The dependency graph is only the current PlanSnapshot; history belongs to the EventLog and DeltaHistory.",
                "- Every tick must produce a Decision Card. Use decision_type=noop when no mutation is justified.",
                "- Dynamic add_node requests must cite gap_evidence_refs or source_artifact_refs; without evidence choose noop.",
                "- Planner context is control-plane only: use Team chat messages, task status, and artifact references. Do not request or rely on raw full artifact text.",
                "- When a planner/reviewer needs content details, route a worker question as a focused sub_agent instead of reading full text yourself.",
                "- Use add_node plus block_node when a task needs new evidence, rework, review, code, literature, or analysis before it can continue.",
                "- Use resume_node only when a waiting_dynamic_dependency task has all dynamic dependencies complete.",
                "- If a waiting_approval planning/writing/review task produced artifacts that explicitly mention evidence gaps, citation gaps, missing citations, literature needs, [EVIDENCE_NEEDED], unsupported claims, failed acceptance criteria, or reviewer-requested rework, insert a focused follow-up task and block that caller before human approval.",
                "- Do not add work only because a task is waiting for ordinary approval; require a concrete gap from events, artifacts, or the Research Wiki.",
                "- Do not delete static nodes, rewrite user static definitions, or bypass human gates.",
                "- Prefer no deltas when the current DAG can proceed.",
                "",
                "JSON schema:",
                "{",
                '  "decision_type": "noop|mutate|resume|fail",',
                '  "rationale": "short reason",',
                '  "confidence": 0.0,',
                '  "gap_type": "citation_gap|evidence_gap|literature_gap|method_gap|null",',
                '  "gap_evidence_refs": ["artifact:path.md", "event:node-id"],',
                '  "dynamic_reason": "why a dynamic worker is needed, when applicable",',
                '  "affected_session_ids": ["node:<workflow>:<caller>"],',
                '  "blocked_node_ids": ["caller"],',
                '  "expected_artifacts": ["artifact.md"],',
                '  "resume_plan": "how the caller session should continue after research",',
                '  "complete": false,',
                '  "deltas": [',
                '    {"action":"add_node","node":{"id":"follow-up-task","type":"sub_agent","name":"...","role":"...","skill":"research-lit|null","task_type":"research|analysis|coding|writing|review","objective":"...","acceptance_criteria":["..."],"assignee_role":"...","prompt":"...","outputs":[{"name":"artifact.md","type":"file"}],"dynamic_parent_id":"caller"},"research_request":{"query":"..."},"gap_evidence_refs":["artifact:..."],"expected_artifacts":["artifact.md"],"refresh":false},',
                '    {"action":"add_edge","source":"node-a","target":"node-b"},',
                '    {"action":"block_node","node_id":"caller","wait_for":["lit-node"],"reason":"...","resume_plan":"..."},',
                '    {"action":"resume_node","node_id":"caller","reason":"..."},',
                '    {"action":"mark_noop","reason":"existing literature node already covers the gap"}',
                "  ]",
                "}",
                "",
                f"Trigger: {trigger}",
                f"Task board title: {record.title}",
                f"Initial goal: {record.goal}",
                "",
                "Current tasks:",
                json.dumps(nodes, ensure_ascii=False, indent=2),
                "",
                "Recent events:",
                json.dumps(recent_events, ensure_ascii=False, indent=2),
                "",
                "Team chat messages (human-language updates only; use artifact_refs for large text):",
                json.dumps(team_messages, ensure_ascii=False, indent=2),
                "",
                "Artifact reference index (do not treat this as a full-text dump):",
                json.dumps(artifact_refs, ensure_ascii=False, indent=2),
                "",
                "Research Wiki state:",
                "initialized" if (workspace / "research-wiki").exists() else "not initialized",
                "",
                "Runtime policy:",
                json.dumps(model_dict(self.runtime_policy(workspace, record.id)), ensure_ascii=False, indent=2),
            ]
        )

    async def _run_planner(self, workspace: Path, record: WorkflowRecord, trigger: str) -> PlannerDecision | None:
        if self.planner_runner is not None:
            raw = await self.planner_runner(workspace, record, trigger)
            if raw is None:
                return None
            return raw if isinstance(raw, PlannerDecision) else PlannerDecision(**raw)

        planner_settings = get_planner_llm_settings() if self.node_runner is None else None
        if planner_settings and planner_settings.get("wire_api") == "responses":
            return await asyncio.to_thread(
                self._run_responses_planner,
                workspace,
                record,
                trigger,
                planner_settings,
            )

        if os.environ.get("ARIS_WEB_DYNAMIC_PLANNER") != "1":
            return None
        session_path = planner_session_path(workspace, record.id)
        command = build_aris_command(
            workspace,
            self._build_planner_prompt(workspace, record, trigger),
            effective_model_override(),
            session_path=str(session_path),
        )
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(workspace),
            env=build_runtime_env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            detail = (stderr or stdout).decode("utf-8", errors="replace")[-2000:]
            raise ValueError(detail or f"Planner exited with code {process.returncode}")
        return parse_planner_decision_text(stdout.decode("utf-8", errors="replace"))

    def _run_responses_planner(
        self,
        workspace: Path,
        record: WorkflowRecord,
        trigger: str,
        settings: dict[str, str],
    ) -> PlannerDecision:
        prompt = self._build_planner_prompt(workspace, record, trigger)
        body: dict[str, Any] = {
            "model": settings["model"],
            "input": prompt,
            "stream": False,
        }
        request = urllib.request.Request(
            responses_api_url(settings["base_url"]),
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "authorization": f"Bearer {settings['api_key']}",
                "content-type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                response_body = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[-2000:]
            raise ValueError(f"Planner Responses API error {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise ValueError(f"Planner Responses API request failed: {exc.reason}") from exc

        try:
            parsed = json.loads(response_body)
        except json.JSONDecodeError as exc:
            raise ValueError("Planner Responses API returned non-JSON response") from exc
        if not isinstance(parsed, dict):
            raise ValueError("Planner Responses API returned an unexpected response shape")
        text = extract_responses_text(parsed)
        if not text:
            raise ValueError("Planner Responses API returned no output text")
        decision = parse_planner_decision_text(text)
        append_planner_llm_session(
            workspace,
            record.id,
            {
                "timestamp": utc_now(),
                "trigger": trigger,
                "provider": settings.get("provider", "openai"),
                "model": settings["model"],
                "base_url": settings["base_url"],
                "wire_api": settings["wire_api"],
                "response_id": str(parsed.get("id") or ""),
                "output_text": text,
                "decision": model_dict(decision),
            },
        )
        return decision

    def _prepare_dynamic_literature_node(
        self,
        node: WorkflowNode | None,
        delta: WorkflowDelta,
        graph: WorkflowGraph,
    ) -> WorkflowNode:
        request = delta.research_request or (node.research_request if node else None) or {}
        caller_id = (
            (node.dynamic_parent_id if node else None)
            or delta.node_id
            or str(request.get("caller_id") or request.get("caller") or "").strip()
            or None
        )
        query = research_query_from_request(request) or delta.reason or "literature research"
        node_id = (node.id if node and node.id else "") or dynamic_literature_node_id(caller_id, query)
        existing_ids = {item.id for item in graph.nodes}
        if node_id in existing_ids and delta.refresh:
            base = node_id
            suffix = 2
            while node_id in existing_ids:
                node_id = f"{base}-{suffix}"
                suffix += 1

        prompt = (node.prompt if node and node.prompt.strip() else "").strip()
        if not prompt:
            prompt = "\n".join(
                [
                    "Run a focused, stateless literature research task for the workflow.",
                    f"Research query: {query}",
                    "This is one precise routed question. Do not broaden it into a general survey.",
                    "",
                    "Deliverables:",
                    "- Save literature_result.json with keys: query, papers, findings, gaps, sources, wiki_refs, artifact_refs.",
                    "- If searches fail or the requested citation cannot be verified after 3 search/fetch failures, still save literature_result.json with status='inconclusive', papers=[], gaps explaining the failure, and sources tried.",
                    "- If research-wiki/ exists, upsert the relevant paper metadata and findings into it.",
                    "- Return concise citations and source URLs where available. Do not invent citations.",
                    "- Final summary must be a short human-language update plus artifact path, not the full JSON.",
                ]
            )
        if request and "Research request JSON:" not in prompt:
            prompt = f"{prompt}\n\nResearch request JSON:\n{json.dumps(request, ensure_ascii=False, indent=2)}"
        requested_skill = (node.skill if node and node.skill in LITERATURE_SKILLS else None) or (
            "openalex-search" if "openalex" in query.lower() else "research-lit"
        )

        update = {
            "id": node_id,
            "type": "sub_agent",
            "name": (node.name if node and node.name.strip() else f"Literature research: {query[:48]}"),
            "role": (node.role if node and node.role.strip() else "literature scout"),
            "skill": requested_skill,
            "prompt": prompt,
            "depends_on": list(node.depends_on if node else []),
            "outputs": [{"name": "literature_result.json", "type": "file", "required": True}],
            "auto_approve_after": True,
            "dynamic_parent_id": caller_id,
            "dynamic_reason": delta.reason or (node.dynamic_reason if node else None) or "Planner requested literature research",
            "research_request": request or {"query": query},
            "concurrency_class": "literature",
            "failure_policy": "continue",
            "timeout_seconds": node.timeout_seconds if node and node.timeout_seconds is not None else 180,
            "position": (node.position if node and node.position else {"x": 120, "y": 320}),
        }
        update.update(protocol_defaults("literature"))
        update["team_role_kind"] = "literature"
        update["scope"] = default_scope_for_kind("literature")
        if node is None:
            return WorkflowNode(**update)
        data = model_dict(node)
        data.update(update)
        return WorkflowNode(**data)

    def _find_duplicate_literature_node(self, graph: WorkflowGraph, node: WorkflowNode) -> WorkflowNode | None:
        query = research_query_from_request(node.research_request)
        if not query:
            return None
        for item in graph.nodes:
            if item.id == node.id:
                continue
            if item.skill not in LITERATURE_SKILLS:
                continue
            if item.dynamic_parent_id != node.dynamic_parent_id:
                continue
            if research_query_from_request(item.research_request) == query:
                return item
        return None

    def _has_existing_literature_request(self, graph: WorkflowGraph, caller_id: str, query: str) -> bool:
        normalized_query = _clean_gap_query(query, fallback=query).lower()
        for item in graph.nodes:
            if item.dynamic_parent_id != caller_id or item.skill not in LITERATURE_SKILLS:
                continue
            existing_query = _clean_gap_query(research_query_from_request(item.research_request), fallback="").lower()
            if existing_query == normalized_query:
                return True
        return False

    def _caller_has_pending_dynamic_dependency(self, graph: WorkflowGraph, caller_id: str) -> bool:
        return any(
            item.dynamic_parent_id == caller_id
            and item.status not in TERMINAL_NODE_STATUSES
            and item.skill in LITERATURE_SKILLS
            for item in graph.nodes
        )

    def _caller_has_pending_dynamic_work(self, graph: WorkflowGraph, caller_id: str) -> bool:
        return any(
            item.dynamic_parent_id == caller_id
            and item.status not in TERMINAL_NODE_STATUSES
            for item in graph.nodes
        )

    def _local_worker_question_decision(self, workspace: Path, record: WorkflowRecord) -> PlannerDecision | None:
        graph = record.graph_json
        artifacts = build_artifact_index(workspace, record)
        artifacts_by_node: dict[str, list[ArtifactIndexEntry]] = {}
        for artifact in artifacts:
            if artifact.producer_node_id:
                artifacts_by_node.setdefault(artifact.producer_node_id, []).append(artifact)

        for node in graph.nodes:
            if node.type not in EXECUTABLE_NODE_TYPES or not node.run_id or not node.can_ask_questions:
                continue
            if node.status not in {"waiting_approval", "succeeded"}:
                continue
            if self._caller_has_pending_dynamic_work(graph, node.id):
                continue

            evidence_ref = ""
            requests: list[dict[str, str]] = []
            message_path = last_message_path(workspace, node.run_id)
            if message_path.exists():
                try:
                    requests = detect_worker_question_requests(node, message_path.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    requests = []
                if requests:
                    evidence_ref = f"event:{node.id}"
            if not requests:
                for artifact in artifacts_by_node.get(node.id, []):
                    path = workspace / artifact.path
                    try:
                        if path.stat().st_size > 512_000:
                            continue
                        text = path.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        continue
                    requests = detect_worker_question_requests(node, text)
                    if requests:
                        evidence_ref = f"artifact:{artifact.path}"
                        break
            if not requests:
                continue

            deltas: list[WorkflowDelta] = []
            wait_for: list[str] = []
            for request in requests[:3]:
                spec = worker_question_role_spec(request["role"])
                question = request["question"]
                answer_id = dynamic_worker_question_node_id(node.id, str(spec["role"]), question)
                if any(item.id == answer_id for item in graph.nodes):
                    continue
                kind = str(spec["kind"] or "worker")
                answer_name = f"Answer: {question[:56]}"
                answer_prompt = (
                    f"Answer this planner/reviewer question for the team chat: {question}\n"
                    "Read only the artifacts needed to answer. Do not ask follow-up questions. "
                    "Write WORKER_ANSWER.md with a concise answer, artifact references, assumptions, and remaining uncertainty. "
                    "End with a compact human-language summary; do not paste full artifacts."
                )
                answer_node = WorkflowNode(
                    id=answer_id,
                    name=answer_name,
                    type="sub_agent",
                    role=str(spec["role"] or "worker"),
                    skill=str(spec["skill"]) if spec["skill"] else None,
                    task_type=str(spec["task_type"] or "analysis"),  # type: ignore[arg-type]
                    team_role_kind=kind,  # type: ignore[arg-type]
                    scope=default_scope_for_kind(kind),
                    can_ask_questions=False,
                    can_clone_workers=True,
                    can_call_planner=False,
                    peer_access=True,
                    reports_to_chat=True,
                    auto_approve_after=True,
                    failure_policy="continue",
                    timeout_seconds=180,
                    objective=f"Answer the routed team question: {question}",
                    acceptance_criteria=[
                        "WORKER_ANSWER.md directly answers the routed question",
                        "Artifact paths and uncertainty are explicit",
                        "The final summary is concise and contains no full-text dump",
                    ],
                    assignee_role=str(spec["role"] or "worker"),
                    prompt=answer_prompt,
                    outputs=["WORKER_ANSWER.md"],
                    dynamic_parent_id=node.id,
                    dynamic_reason=request.get("reason") or "Planner asked a worker question",
                    position={
                        "x": float(node.position.get("x", 0)) + 160,
                        "y": float(node.position.get("y", 0)) + 240 + 80 * len(wait_for),
                    },
                )
                deltas.append(
                    WorkflowDelta(
                        action="add_node",
                        node=answer_node,
                        reason=request.get("reason") or "Planner asked a worker question",
                        gap_evidence_refs=[evidence_ref],
                        expected_artifacts=["WORKER_ANSWER.md"],
                    )
                )
                wait_for.append(answer_id)
            if not wait_for:
                continue
            deltas.append(
                WorkflowDelta(
                    action="block_node",
                    node_id=node.id,
                    wait_for=wait_for,
                    reason=f"{node.name} asked worker question(s)",
                    resume_plan=f"Resume {node.name} after worker answer(s) are available in team chat.",
                )
            )
            return PlannerDecision(
                rationale=f"{node.name} asked worker question(s)",
                decision_type="mutate",
                confidence=0.9,
                gap_type="method_gap",
                gap_evidence_refs=[evidence_ref],
                dynamic_reason="Planner routed question(s) to employees",
                affected_session_ids=[_session_id_for_node(record.id, node)],
                blocked_node_ids=[node.id],
                expected_artifacts=["WORKER_ANSWER.md"],
                resume_plan=f"Resume {node.name} after worker answer(s) are available in team chat.",
                deltas=deltas,
            )
        return None

    def _local_worker_clone_decision(self, workspace: Path, record: WorkflowRecord) -> PlannerDecision | None:
        graph = record.graph_json
        artifacts = build_artifact_index(workspace, record)
        artifacts_by_node: dict[str, list[ArtifactIndexEntry]] = {}
        for artifact in artifacts:
            if artifact.producer_node_id:
                artifacts_by_node.setdefault(artifact.producer_node_id, []).append(artifact)

        for node in graph.nodes:
            if node.type not in EXECUTABLE_NODE_TYPES or not node.run_id or not node.can_clone_workers:
                continue
            if self._caller_has_pending_dynamic_work(graph, node.id):
                continue
            is_review_waiting = node.status == "waiting_approval" and not node.approved_after
            is_auto_approved = node.status == "succeeded" and node.auto_approve_after and node.approved_after
            if not (is_review_waiting or is_auto_approved):
                continue

            request: dict[str, str] | None = None
            evidence_ref = ""
            for artifact in artifacts_by_node.get(node.id, []):
                path = workspace / artifact.path
                try:
                    if path.stat().st_size > 512_000:
                        continue
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                request = detect_worker_clone_request(node, text)
                if request:
                    evidence_ref = f"artifact:{artifact.path}"
                    break
            if request is None and node.run_id:
                message_path = last_message_path(workspace, node.run_id)
                if message_path.exists():
                    try:
                        request = detect_worker_clone_request(node, message_path.read_text(encoding="utf-8", errors="replace"))
                    except OSError:
                        request = None
                    if request:
                        evidence_ref = f"event:{node.id}"

            if request is None:
                continue

            objective = request["objective"]
            clone_id = dynamic_clone_node_id(node.id, objective)
            if any(item.id == clone_id for item in graph.nodes):
                continue
            role_kind = node.team_role_kind or "worker"
            clone_outputs = [{"name": f"{_safe_node_slug(objective, 'worker-result')}.md", "type": "file", "required": True}]
            clone = WorkflowNode(
                id=clone_id,
                name=f"{node.name} helper: {objective[:48]}",
                type="sub_agent",
                role=node.role,
                skill=node.skill,
                config_file=node.config_file,
                model=node.model,
                effort=node.effort,
                task_type=node.task_type,
                objective=f"Assist {node.name} with this delegated subtask: {objective}",
                acceptance_criteria=[
                    "Work autonomously without asking the planner or user questions",
                    "Write the declared helper artifact with concise findings or edits",
                    "Report only a human-language summary plus artifact references",
                ],
                assignee_role=node.assignee_role or node.role or node.team_role_id,
                prompt=(
                    f"You are a cloned helper for {node.name}. Complete this subtask autonomously:\n{objective}\n\n"
                    "Use upstream artifacts as context and write the declared helper artifact. "
                    "Do not call the planner; report concise status with artifact links."
                ),
                depends_on=[node.id],
                outputs=clone_outputs,
                dynamic_parent_id=node.id,
                dynamic_reason=request["reason"],
                team_id=node.team_id,
                team_instance_id=node.team_instance_id,
                team_role_id=node.team_role_id,
                team_role_kind=role_kind,  # type: ignore[arg-type]
                scope=node.scope or default_scope_for_kind(role_kind),
                can_ask_questions=False,
                can_clone_workers=node.can_clone_workers,
                can_call_planner=False,
                peer_access=node.peer_access,
                reports_to_chat=True,
                auto_approve_after=True,
                position={
                    "x": float(node.position.get("x", 0)) + 160,
                    "y": float(node.position.get("y", 0)) + 220,
                },
            )
            return PlannerDecision(
                rationale=request["reason"],
                decision_type="mutate",
                confidence=0.84,
                gap_type="worker_clone",
                gap_evidence_refs=[evidence_ref],
                dynamic_reason=request["reason"],
                affected_session_ids=[_session_id_for_node(record.id, node)],
                blocked_node_ids=[node.id],
                expected_artifacts=[clone_outputs[0]["name"]],
                resume_plan=f"Resume {node.name} after helper {clone_id} finishes, using the helper artifact as context.",
                deltas=[
                    WorkflowDelta(
                        action="add_node",
                        node=clone,
                        gap_type="worker_clone",
                        gap_evidence_refs=[evidence_ref],
                        expected_artifacts=[clone_outputs[0]["name"]],
                        reason=request["reason"],
                    ),
                    WorkflowDelta(
                        action="block_node",
                        node_id=node.id,
                        wait_for=[clone_id],
                        reason=request["reason"],
                        resume_plan=f"Resume {node.name} after {clone_id} succeeds.",
                    ),
                ],
            )
        return None

    def _local_literature_gap_decision(self, workspace: Path, record: WorkflowRecord) -> PlannerDecision | None:
        graph = record.graph_json
        policy = self.runtime_policy(workspace, record.id)
        artifacts = build_artifact_index(workspace, record)
        artifacts_by_node: dict[str, list[ArtifactIndexEntry]] = {}
        for artifact in artifacts:
            if artifact.producer_node_id:
                artifacts_by_node.setdefault(artifact.producer_node_id, []).append(artifact)

        for node in graph.nodes:
            if node.type not in EXECUTABLE_NODE_TYPES:
                continue
            if node.skill in LITERATURE_SKILLS:
                continue
            if not node.run_id:
                continue
            is_review_waiting = node.status == "waiting_approval" and not node.approved_after
            is_auto_approved = node.status == "succeeded" and node.auto_approve_after and node.approved_after
            if not (is_review_waiting or is_auto_approved):
                continue
            if self._caller_has_pending_dynamic_work(graph, node.id):
                continue
            caller_dynamic_count = sum(1 for item in graph.nodes if item.dynamic_parent_id == node.id)
            if caller_dynamic_count >= policy.max_dynamic_nodes_per_caller:
                continue

            evidence_ref = ""
            gaps: list[dict[str, str]] = []
            for artifact in artifacts_by_node.get(node.id, []):
                path = workspace / artifact.path
                try:
                    if path.stat().st_size > 512_000:
                        continue
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                gaps = detect_literature_gap_requests(record, node, text)
                if gaps:
                    evidence_ref = f"artifact:{artifact.path}"
                    break

            if not gaps and node.run_id:
                message_path = last_message_path(workspace, node.run_id)
                if message_path.exists():
                    try:
                        text = message_path.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        text = ""
                    gaps = detect_literature_gap_requests(record, node, text)
                    if gaps:
                        evidence_ref = f"event:{node.id}"

            if not gaps:
                continue
            deltas: list[WorkflowDelta] = []
            wait_for: list[str] = []
            expected_artifacts: list[str] = []
            gap_types: list[str] = []
            reason = gaps[0].get("reason") or f"{node.name} needs literature before downstream work can continue"
            for gap in gaps[:6]:
                query = gap["query"]
                if self._has_existing_literature_request(graph, node.id, query):
                    continue
                skill_id = "openalex-search" if "openalex" in query.lower() else "research-lit"
                lit_id = dynamic_literature_node_id(node.id, query)
                wait_for.append(lit_id)
                expected_artifacts.append("literature_result.json")
                gap_types.append(gap.get("gap_type") or "literature_gap")
                deltas.append(
                    WorkflowDelta(
                        action="add_node",
                        node=WorkflowNode(
                            id=lit_id,
                            name=f"Literature: {query[:64]}",
                            type="sub_agent",
                            role="literature scout",
                            skill=skill_id,
                            task_type="research",
                            objective=f"Search and summarize literature needed by {node.name}: {query}",
                            acceptance_criteria=[
                                "literature_result.json is written with query, papers, findings, gaps, and sources",
                                "Citations and source URLs are explicit; uncertain items are marked",
                                "Findings directly answer the blocked role's request",
                                "If search fails, write an inconclusive result instead of continuing indefinitely",
                            ],
                            assignee_role="literature scout",
                            dynamic_parent_id=node.id,
                            timeout_seconds=180,
                            failure_policy="continue",
                            position={
                                "x": float(node.position.get("x", 0)) + 120,
                                "y": float(node.position.get("y", 0)) + 220 + 80 * len(wait_for),
                            },
                        ),
                        research_request={"query": query, "caller_id": node.id, "source": "local-gap-detector"},
                        gap_type=gap.get("gap_type") or "literature_gap",
                        gap_evidence_refs=[evidence_ref],
                        expected_artifacts=["literature_result.json"],
                        reason=gap.get("reason") or reason,
                    )
                )
            if not wait_for:
                continue
            deltas.append(
                WorkflowDelta(
                    action="block_node",
                    node_id=node.id,
                    wait_for=wait_for,
                    reason=reason,
                    resume_plan=f"Resume {node.name} after dynamic worker answer(s) are available in team chat.",
                )
            )
            return PlannerDecision(
                rationale=reason,
                decision_type="mutate",
                confidence=0.86,
                gap_type=gap_types[0] if gap_types else "literature_gap",
                gap_evidence_refs=[evidence_ref],
                dynamic_reason=reason,
                affected_session_ids=[_session_id_for_node(record.id, node)],
                blocked_node_ids=[node.id],
                expected_artifacts=expected_artifacts,
                resume_plan=f"Resume {node.name} with the dynamic worker result(s), then regenerate only from team-chat summaries and artifact references.",
                deltas=deltas,
            )
        return None

    def _normalize_planner_decision(self, workflow_id: str, decision: PlannerDecision) -> PlannerDecision:
        if not decision.tick_id:
            decision.tick_id = f"tick-{uuid.uuid4().hex[:10]}"
        if not decision.decision_type:
            decision.decision_type = planner_decision_type(decision)
        if decision.confidence is not None:
            decision.confidence = max(0.0, min(1.0, float(decision.confidence)))
        return decision

    def _policy_validate_delta(
        self,
        graph: WorkflowGraph,
        decision: PlannerDecision,
        delta: WorkflowDelta,
        prepared_node: WorkflowNode | None,
        policy: RuntimePolicy,
    ) -> PolicyResult:
        if delta.action in {"mark_noop", "complete", "resume_node"}:
            return PolicyResult(allowed=True, reason="allowed")
        nodes_by_id = {node.id: node for node in graph.nodes}
        dynamic_nodes = [node for node in graph.nodes if node.dynamic_parent_id]
        if delta.action == "add_node":
            node = prepared_node or delta.node
            if node is None:
                return PolicyResult(allowed=False, reason="add_node requires a node or research_request")
            if node.id in nodes_by_id and not delta.refresh:
                return PolicyResult(allowed=True, reason="deduplicated existing node id")
            if node.type != "sub_agent":
                return PolicyResult(allowed=False, reason="Planner may only insert sub_agent nodes")
            if policy.allowed_dynamic_skills and node.skill not in policy.allowed_dynamic_skills:
                return PolicyResult(allowed=False, reason=f"Planner may only insert skills: {', '.join(policy.allowed_dynamic_skills)}")
            if policy.require_gap_evidence and not _evidence_refs(decision, delta):
                return PolicyResult(allowed=False, reason="dynamic task insertion requires gap evidence refs")
            if len(dynamic_nodes) >= policy.max_dynamic_nodes_total:
                return PolicyResult(allowed=False, reason="task board dynamic node cap reached")
            caller = node.dynamic_parent_id or str((node.research_request or {}).get("caller_id") or "").strip()
            if caller:
                caller_count = sum(1 for item in dynamic_nodes if item.dynamic_parent_id == caller)
                if caller_count >= policy.max_dynamic_nodes_per_caller:
                    return PolicyResult(allowed=False, reason=f"dynamic task cap reached for caller {caller}")
            if delta.refresh and not (delta.reason or decision.rationale):
                return PolicyResult(allowed=False, reason="refresh requires an explicit rationale")
            return PolicyResult(allowed=True, reason="allowed")
        if delta.action == "add_edge":
            if not delta.source or not delta.target:
                return PolicyResult(allowed=False, reason="add_edge requires source and target")
            if delta.source not in nodes_by_id or delta.target not in nodes_by_id:
                return PolicyResult(allowed=False, reason="add_edge references an unknown node")
            return PolicyResult(allowed=True, reason="allowed")
        if delta.action == "block_node":
            if not delta.node_id or delta.node_id not in nodes_by_id:
                return PolicyResult(allowed=False, reason="block_node references an unknown node")
            node = nodes_by_id[delta.node_id]
            if node.type == "human_gate" and not policy.allow_human_gate_bypass:
                return PolicyResult(allowed=False, reason="Planner may not block or bypass a human gate")
            unknown = [dep for dep in delta.wait_for if dep not in nodes_by_id]
            if unknown:
                return PolicyResult(allowed=False, reason=f"block_node waits for unknown node(s): {', '.join(unknown)}")
            return PolicyResult(allowed=True, reason="allowed")
        return PolicyResult(allowed=False, reason=f"unsupported planner delta action: {delta.action}")

    def _delta_record(
        self,
        *,
        workflow_id: str,
        tick_id: str,
        index: int,
        decision: PlannerDecision,
        delta: WorkflowDelta,
        before_graph: WorkflowGraph,
        after_graph: WorkflowGraph,
        policy_result: PolicyResult,
        applied: bool,
        rejected_reason: str | None,
        prepared_node: WorkflowNode | None = None,
    ) -> WorkflowDeltaRecord:
        node_id = delta.node_id or (prepared_node.id if prepared_node else None) or (delta.node.id if delta.node else None)
        event_refs, artifact_refs = _decision_refs(decision, delta)
        return WorkflowDeltaRecord(
            delta_id=f"{tick_id}-{index:03d}",
            tick_id=tick_id,
            workflow_id=workflow_id,
            timestamp=utc_now(),
            action=delta.action,
            delta=delta,
            node_id=node_id,
            source=delta.source,
            target=delta.target,
            reason=delta.reason,
            gap_type=delta.gap_type,
            gap_evidence_refs=_evidence_refs(decision, delta),
            before_graph_hash=stable_graph_hash(before_graph),
            after_graph_hash=stable_graph_hash(after_graph),
            before_graph_json=model_dict(before_graph),
            after_graph_json=model_dict(after_graph),
            policy_result=policy_result,
            applied=applied,
            rejected_reason=rejected_reason,
            source_event_refs=event_refs,
            source_artifact_refs=artifact_refs,
            affected_session_ids=delta.affected_session_ids,
            blocked_node_ids=delta.blocked_node_ids or ([delta.node_id] if delta.action == "block_node" and delta.node_id else []),
            expected_artifacts=delta.expected_artifacts,
            resume_plan=delta.resume_plan,
            graph_diff=graph_runtime_diff(before_graph, after_graph),
        )

    async def _record_delta_event(
        self,
        workspace: Path,
        record: WorkflowDeltaRecord,
        *,
        rationale: str,
    ) -> None:
        append_workflow_delta(workspace, record)
        message = "PlannerDeltaApplied" if record.applied else (
            "PlannerDeltaRejected" if not record.policy_result.allowed else "PlannerDeltaNoop"
        )
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=record.workflow_id,
                timestamp=record.timestamp,
                event_type="delta",
                node_id=record.node_id,
                message=message,
                payload={
                    "tick_id": record.tick_id,
                    "delta_id": record.delta_id,
                    "action": record.action,
                    "policy_result": model_dict(record.policy_result),
                    "rejected_reason": record.rejected_reason,
                    "rationale": rationale,
                    "graph_diff": record.graph_diff,
                },
            ),
        )

    async def _record_planner_decision(
        self,
        workspace: Path,
        workflow_id: str,
        *,
        trigger: str,
        decision: PlannerDecision,
        before_graph_hash: str,
        after_graph_hash: str,
        applied: bool,
        policy_result: PolicyResult,
    ) -> PlannerDecisionRecord:
        record = PlannerDecisionRecord(
            tick_id=decision.tick_id or f"tick-{uuid.uuid4().hex[:10]}",
            workflow_id=workflow_id,
            timestamp=utc_now(),
            trigger=trigger,
            decision=decision,
            decision_type=decision.decision_type or planner_decision_type(decision),
            rationale=decision.rationale,
            confidence=decision.confidence,
            policy_result=policy_result,
            applied=applied,
            before_graph_hash=before_graph_hash,
            after_graph_hash=after_graph_hash,
            source_event_refs=[],
            source_artifact_refs=decision.gap_evidence_refs,
        )
        append_planner_decision(workspace, record)
        event_message = "PlannerNoop" if record.decision_type == "noop" else "PlannerDecisionRecorded"
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=record.timestamp,
                event_type="planner",
                message=event_message,
                payload={
                    "tick_id": record.tick_id,
                    "trigger": trigger,
                    "decision_type": record.decision_type,
                    "rationale": record.rationale,
                    "confidence": record.confidence,
                    "policy_result": model_dict(policy_result),
                    "applied": applied,
                    "before_graph_hash": before_graph_hash,
                    "after_graph_hash": after_graph_hash,
                },
            ),
        )
        return record

    async def _apply_planner_decision(
        self,
        workspace: Path,
        workflow_id: str,
        graph: WorkflowGraph,
        decision: PlannerDecision,
    ) -> bool:
        if not decision.deltas and not decision.complete:
            return False
        policy = self.runtime_policy(workspace, workflow_id)
        changed = False
        applied_count = 0
        working = WorkflowGraph(**model_dict(graph))
        nodes_by_id = {node.id: node for node in working.nodes}
        for index, delta in enumerate(decision.deltas, start=1):
            if delta.action == "complete":
                continue
            before_graph = WorkflowGraph(**model_dict(working))
            prepared_node: WorkflowNode | None = None
            if delta.action == "add_node":
                raw_node = delta.node
                if raw_node is None and delta.research_request is None:
                    policy_result = PolicyResult(allowed=False, reason="add_node requires a node or research_request")
                    record = self._delta_record(
                        workflow_id=workflow_id,
                        tick_id=decision.tick_id or "tick-unknown",
                        index=index,
                        decision=decision,
                        delta=delta,
                        before_graph=before_graph,
                        after_graph=before_graph,
                        policy_result=policy_result,
                        applied=False,
                        rejected_reason=policy_result.reason,
                    )
                    await self._record_delta_event(workspace, record, rationale=decision.rationale)
                    continue
                if raw_node is None or raw_node.skill == "research-lit" or delta.research_request is not None:
                    prepared_node = self._prepare_dynamic_literature_node(raw_node, delta, working)
                else:
                    prepared_node = raw_node
            policy_result = self._policy_validate_delta(working, decision, delta, prepared_node, policy)
            if not policy_result.allowed:
                record = self._delta_record(
                    workflow_id=workflow_id,
                    tick_id=decision.tick_id or "tick-unknown",
                    index=index,
                    decision=decision,
                    delta=delta,
                    before_graph=before_graph,
                    after_graph=before_graph,
                    policy_result=policy_result,
                    applied=False,
                    rejected_reason=policy_result.reason,
                    prepared_node=prepared_node,
                )
                await self._record_delta_event(workspace, record, rationale=decision.rationale)
                continue
            delta_changed = False
            if delta.action == "add_node":
                new_node = prepared_node
                if new_node is None:
                    continue
                if new_node.id in nodes_by_id:
                    if delta.refresh:
                        new_node = self._prepare_dynamic_literature_node(new_node, delta, working)
                    else:
                        record = self._delta_record(
                            workflow_id=workflow_id,
                            tick_id=decision.tick_id or "tick-unknown",
                            index=index,
                            decision=decision,
                            delta=delta,
                            before_graph=before_graph,
                            after_graph=before_graph,
                            policy_result=PolicyResult(allowed=True, reason="deduplicated existing node id"),
                            applied=False,
                            rejected_reason=None,
                            prepared_node=new_node,
                        )
                        await self._record_delta_event(workspace, record, rationale=decision.rationale)
                        continue
                duplicate = self._find_duplicate_literature_node(working, new_node)
                if duplicate is not None and not delta.refresh:
                    record = self._delta_record(
                        workflow_id=workflow_id,
                        tick_id=decision.tick_id or "tick-unknown",
                        index=index,
                        decision=decision,
                        delta=delta,
                        before_graph=before_graph,
                        after_graph=before_graph,
                        policy_result=PolicyResult(allowed=True, reason=f"deduplicated existing literature node {duplicate.id}"),
                        applied=False,
                        rejected_reason=None,
                        prepared_node=duplicate,
                    )
                    await self._record_delta_event(workspace, record, rationale=decision.rationale)
                    continue
                working.nodes.append(new_node)
                nodes_by_id[new_node.id] = new_node
                delta_changed = True
            elif delta.action == "add_edge":
                if not delta.source or not delta.target or delta.target not in nodes_by_id or delta.source not in nodes_by_id:
                    continue
                target = nodes_by_id[delta.target]
                if delta.source not in target.depends_on:
                    target.depends_on.append(delta.source)
                    delta_changed = True
            elif delta.action == "block_node":
                if not delta.node_id or delta.node_id not in nodes_by_id:
                    continue
                node = nodes_by_id[delta.node_id]
                for dep in delta.wait_for:
                    if dep in nodes_by_id and dep not in node.depends_on:
                        node.depends_on.append(dep)
                        delta_changed = True
                if node.status != "waiting_dynamic_dependency":
                    node.status = "waiting_dynamic_dependency"
                    delta_changed = True
                reason = delta.reason or "Waiting for dynamic dependency"
                if node.dynamic_reason != reason:
                    node.dynamic_reason = reason
                    delta_changed = True
                node.error = reason
            elif delta.action == "resume_node":
                if not delta.node_id or delta.node_id not in nodes_by_id:
                    continue
                node = nodes_by_id[delta.node_id]
                if node.status == "waiting_dynamic_dependency":
                    deps_ready = all(nodes_by_id[dep].status in SUCCESS_NODE_STATUSES for dep in node.depends_on if dep in nodes_by_id)
                    if deps_ready:
                        node.status = "queued"
                        node.error = None
                        node.approved_after = False
                        delta_changed = True
            if not delta_changed:
                record = self._delta_record(
                    workflow_id=workflow_id,
                    tick_id=decision.tick_id or "tick-unknown",
                    index=index,
                    decision=decision,
                    delta=delta,
                    before_graph=before_graph,
                    after_graph=before_graph,
                    policy_result=policy_result,
                    applied=False,
                    rejected_reason=None,
                    prepared_node=prepared_node,
                )
                await self._record_delta_event(workspace, record, rationale=decision.rationale)
                continue
            try:
                normalized = normalize_workflow_graph(
                    WorkflowGraph(
                        schema_version=2,
                        nodes=working.nodes,
                        edges=[],
                        max_concurrency=working.max_concurrency,
                        class_limits=working.class_limits,
                    ),
                    {skill.id for skill in scan_skills()},
                )
            except ValueError as exc:
                working = before_graph
                nodes_by_id = {node.id: node for node in working.nodes}
                policy_result = PolicyResult(allowed=False, reason=f"graph validation rejected delta: {exc}")
                record = self._delta_record(
                    workflow_id=workflow_id,
                    tick_id=decision.tick_id or "tick-unknown",
                    index=index,
                    decision=decision,
                    delta=delta,
                    before_graph=before_graph,
                    after_graph=before_graph,
                    policy_result=policy_result,
                    applied=False,
                    rejected_reason=policy_result.reason,
                    prepared_node=prepared_node,
                )
                await self._record_delta_event(workspace, record, rationale=decision.rationale)
                continue
            working = normalized
            nodes_by_id = {node.id: node for node in working.nodes}
            changed = True
            applied_count += 1
            record = self._delta_record(
                workflow_id=workflow_id,
                tick_id=decision.tick_id or "tick-unknown",
                index=index,
                decision=decision,
                delta=delta,
                before_graph=before_graph,
                after_graph=working,
                policy_result=policy_result,
                applied=True,
                rejected_reason=None,
                prepared_node=prepared_node,
            )
            await self._record_delta_event(workspace, record, rationale=decision.rationale)
        if not changed:
            return False
        update_workflow(workspace, workflow_id, graph_json=working)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="planner",
                message="Planner updated dynamic DAG",
                payload={
                    "tick_id": decision.tick_id,
                    "rationale": decision.rationale,
                    "applied_delta_count": applied_count,
                    "deltas": [model_dict(delta) for delta in decision.deltas],
                },
            ),
        )
        return True

    async def _planner_tick(self, workspace: Path, workflow_id: str, trigger: str) -> bool:
        if workflow_id in self._planning:
            return False
        record = self._require(workspace, workflow_id)
        if record.status != "running":
            return False
        external_planner_enabled = self.node_runner is None and get_planner_llm_settings() is not None
        planner_enabled = (
            self.planner_runner is not None
            or external_planner_enabled
            or os.environ.get("ARIS_WEB_DYNAMIC_PLANNER") == "1"
        )
        tick_id = f"tick-{uuid.uuid4().hex[:10]}"
        before_hash = stable_graph_hash(record.graph_json)
        self._planning.add(workflow_id)
        try:
            if planner_enabled:
                await self._append_event(
                    workspace,
                    WorkflowEvent(
                        workflow_id=workflow_id,
                        timestamp=utc_now(),
                        event_type="planner",
                        message="PlannerTickStarted",
                        payload={
                            "tick_id": tick_id,
                            "trigger": trigger,
                            "plan_snapshot": model_dict(plan_snapshot(record.graph_json)),
                            "policy": model_dict(self.runtime_policy(workspace, workflow_id)),
                            "planner_llm": planner_llm_summary() or {"provider": "aris-runtime", "wire_api": "aris"},
                        },
                    ),
                )
            decision = await self._run_planner(workspace, record, trigger)
            if decision is None:
                decision = (
                    self._local_worker_question_decision(workspace, record)
                    or self._local_worker_clone_decision(workspace, record)
                    or self._local_literature_gap_decision(workspace, record)
                )
            if decision is None:
                if planner_enabled:
                    noop_decision = PlannerDecision(
                        tick_id=tick_id,
                        rationale="Planner did not request a graph mutation for this tick.",
                        decision_type="noop",
                        confidence=1.0,
                    )
                    await self._record_planner_decision(
                        workspace,
                        workflow_id,
                        trigger=trigger,
                        decision=noop_decision,
                        before_graph_hash=before_hash,
                        after_graph_hash=before_hash,
                        applied=False,
                        policy_result=PolicyResult(allowed=True, reason="noop"),
                    )
                    await self._append_event(
                        workspace,
                        WorkflowEvent(
                            workflow_id=workflow_id,
                            timestamp=utc_now(),
                            event_type="planner",
                            message="Planner checked dynamic DAG: no changes",
                            payload={"tick_id": tick_id, "trigger": trigger, "rationale": noop_decision.rationale},
                        ),
                    )
                return False
            decision.tick_id = tick_id
            decision = self._normalize_planner_decision(workflow_id, decision)
            latest = self._require(workspace, workflow_id)
            before_hash = stable_graph_hash(latest.graph_json)
            changed = await self._apply_planner_decision(workspace, workflow_id, latest.graph_json, decision)
            after = self._require(workspace, workflow_id)
            after_hash = stable_graph_hash(after.graph_json)
            tick_deltas = [delta for delta in list_workflow_deltas(workspace, workflow_id) if delta.tick_id == tick_id]
            rejected = [delta for delta in tick_deltas if not delta.policy_result.allowed]
            policy_result = (
                PolicyResult(allowed=False, reason="; ".join(delta.policy_result.reason for delta in rejected if delta.policy_result.reason))
                if rejected
                else PolicyResult(allowed=True, reason="allowed")
            )
            await self._record_planner_decision(
                workspace,
                workflow_id,
                trigger=trigger,
                decision=decision,
                before_graph_hash=before_hash,
                after_graph_hash=after_hash,
                applied=changed,
                policy_result=policy_result,
            )
            if not changed:
                await self._append_event(
                    workspace,
                    WorkflowEvent(
                        workflow_id=workflow_id,
                        timestamp=utc_now(),
                        event_type="planner",
                        message="Planner checked dynamic DAG: no applicable changes",
                        payload={
                            "tick_id": tick_id,
                            "trigger": trigger,
                            "rationale": decision.rationale,
                            "deltas": [model_dict(delta) for delta in decision.deltas],
                            "policy_result": model_dict(policy_result),
                        },
                    ),
                )
            return changed
        except Exception as exc:
            await self._append_event(
                workspace,
                WorkflowEvent(
                    workflow_id=workflow_id,
                    timestamp=utc_now(),
                    event_type="planner",
                    message=f"Planner skipped: {exc}",
                    payload={"tick_id": tick_id, "error": str(exc)},
                ),
            )
            return False
        finally:
            self._planning.discard(workflow_id)

    async def _resume_dynamic_dependencies(self, workspace: Path, workflow_id: str, graph: WorkflowGraph) -> bool:
        nodes_by_id = {node.id: node for node in graph.nodes}
        resumed: list[str] = []
        for node in graph.nodes:
            if node.status != "waiting_dynamic_dependency":
                continue
            if not node.depends_on:
                continue
            if all(nodes_by_id[dep].status in SUCCESS_NODE_STATUSES for dep in node.depends_on if dep in nodes_by_id):
                node.status = "queued"
                node.error = None
                node.approved_after = False
                resumed.append(node.id)
        if not resumed:
            return False
        update_workflow(workspace, workflow_id, graph_json=graph, clear_error=True)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="session",
                message=f"Resumed {len(resumed)} node(s) after dynamic dependencies completed",
                payload={
                    "nodes": resumed,
                    "resume_events": [
                        {
                            "node_id": node_id,
                            "session_id": _session_id_for_node(workflow_id, nodes_by_id[node_id]),
                            "session_path": nodes_by_id[node_id].session_path,
                            "resume_condition": "all dynamic dependencies succeeded or skipped",
                        }
                        for node_id in resumed
                    ],
                },
            ),
        )
        return True

    async def _tick(self, workspace: Path, workflow_id: str) -> None:
        record = self._require(workspace, workflow_id)
        if record.status != "running":
            return
        graph = record.graph_json
        active = self._active.setdefault(workflow_id, set())
        # Workflow termination: when every node has reached a terminal state and
        # nothing is still running, decide between succeeded and failed.
        # "skip_descendants" and "continue" failure policies rely on this to
        # finish the workflow without a manual unpause.
        if not active and all(node.status in TERMINAL_NODE_STATUSES for node in graph.nodes):
            if any(node.status == "failed" for node in graph.nodes):
                update_workflow(workspace, workflow_id, status="failed", finished_at=utc_now())
                await self._append_event(
                    workspace,
                    WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="workflow", message="Workflow finished with failures"),
                )
            else:
                update_workflow(workspace, workflow_id, status="succeeded", finished_at=utc_now())
                await self._append_event(
                    workspace,
                    WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="workflow", message="Workflow succeeded"),
                )
            return

        active = self._active.setdefault(workflow_id, set())
        if active:
            return

        if await self._resume_dynamic_dependencies(workspace, workflow_id, graph):
            await self._tick(workspace, workflow_id)
            return

        if await self._planner_tick(workspace, workflow_id, "scheduler_tick"):
            await self._tick(workspace, workflow_id)
            return

        ready = []
        nodes_by_id = {node.id: node for node in graph.nodes}
        completed_inputs = []
        for node in graph.nodes:
            if node.type == "input" and node.status == "queued":
                node.status = "succeeded"
                node.error = None
                completed_inputs.append(node.id)
        if completed_inputs:
            update_workflow(workspace, workflow_id, graph_json=graph)
            await self._append_event(
                workspace,
                WorkflowEvent(
                    workflow_id=workflow_id,
                    timestamp=utc_now(),
                    event_type="workflow",
                    message=f"Input context ready: {len(completed_inputs)} node(s)",
                    payload={"input_nodes": completed_inputs},
                ),
            )
            await self._tick(workspace, workflow_id)
            return
        for node in graph.nodes:
            if node.status != "queued":
                continue
            if not all(nodes_by_id[dep].status in SUCCESS_NODE_STATUSES for dep in node.depends_on):
                continue
            if node.fanout is not None:
                await self._expand_fanout_node(workspace, workflow_id, graph, node)
                await self._tick(workspace, workflow_id)
                return
            if node.type == "human_gate":
                node.status = "waiting_approval"
                update_workflow(workspace, workflow_id, status="paused", graph_json=graph)
                await self._append_event(
                    workspace,
                    WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node.id, message=f"Human checkpoint waiting: {node.name}"),
                )
                return
            if node.gate in {"before", "both"} and not node.approved_before:
                node.status = "waiting_approval"
                update_workflow(workspace, workflow_id, status="paused", graph_json=graph)
                await self._append_event(
                    workspace,
                    WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node.id, message=f"Node waiting for pre-run approval: {node.name}"),
                )
                return
            ready.append(node)

        if ready:
            for node in ready:
                node.status = "running"
                active.add(node.id)
                asyncio.create_task(self._run_node_task(workspace, workflow_id, node.id))
            update_workflow(workspace, workflow_id, graph_json=graph)
            return

        batch_waiting = [
            node
            for node in graph.nodes
            if node.type in EXECUTABLE_NODE_TYPES
            and node.status == "waiting_approval"
            and node.run_id
            and not node.approved_after
        ]
        if batch_waiting:
            if record.status != "paused":
                update_workflow(workspace, workflow_id, status="paused", graph_json=graph)
                await self._append_event(
                    workspace,
                    WorkflowEvent(
                        workflow_id=workflow_id,
                        timestamp=utc_now(),
                        event_type="workflow",
                        message=f"Execution batch waiting for approval: {len(batch_waiting)} node(s)",
                        payload={"nodes": [node.id for node in batch_waiting]},
                    ),
                )
            return

        # Deadlock detection: nothing scheduled this tick, nothing in flight,
        # nobody waiting on a human — yet some nodes are still queued. They
        # must be transitively blocked by a failed/cancelled dependency under
        # a non-halt failure_policy. Mark them skipped so the workflow can
        # conclude instead of sitting in "running" forever.
        if any(node.status == "waiting_approval" for node in graph.nodes):
            return
        nodes_by_id_post = {node.id: node for node in graph.nodes}

        def transitively_blocked(node: WorkflowNode) -> bool:
            for dep_id in node.depends_on:
                dep = nodes_by_id_post[dep_id]
                if dep.status in {"failed", "cancelled"}:
                    return True
                if dep.status == "skipped":
                    # Skipped via policy — treat as a blocker so downstream
                    # nodes that explicitly depend on the skipped output stop
                    # too. (User can rerun the parent to reactivate.)
                    return True
            return False

        blocked = [n for n in graph.nodes if n.status == "queued" and transitively_blocked(n)]
        if not blocked:
            return
        for node in blocked:
            node.status = "skipped"
            node.error = node.error or "Blocked by upstream failure"
        update_workflow(workspace, workflow_id, graph_json=graph)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=utc_now(),
                event_type="workflow",
                message=f"Auto-skipped {len(blocked)} node(s) blocked by upstream failure",
                payload={"skipped": [n.id for n in blocked]},
            ),
        )
        # Re-tick so the terminal-state check at the top can promote the
        # workflow to "failed".
        await self._tick(workspace, workflow_id)

    async def _run_node_task(self, workspace: Path, workflow_id: str, node_id: str) -> None:
        try:
            record = self._require(workspace, workflow_id)
            node = self._find_node(record.graph_json, node_id)
            await self._append_event(
                workspace,
                WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node_id, message=f"Node started: {node.name}"),
            )
            while True:
                # Reload before each attempt so the retry branch sees persisted
                # attempt counter and any concurrent graph edits.
                record = self._require(workspace, workflow_id)
                node = self._find_node(record.graph_json, node_id)
                node = self._ensure_node_session_path(workspace, workflow_id, record.graph_json, node)
                result = await self._run_node(workspace, record, node)
                latest = self._require(workspace, workflow_id)
                graph = latest.graph_json
                node = self._find_node(graph, node_id)
                if node.status == "cancelled":
                    return
                node.run_id = result.run_id or node.run_id

                # Unify the two failure modes (process failure, missing outputs)
                # so they share the same retry decision path.
                failure_error: str | None = None
                if not result.succeeded:
                    failure_error = result.error or result.message or "Node failed"
                else:
                    run_record = get_run(workspace, node.run_id) if node.run_id else None
                    moved_outputs = reconcile_declared_outputs(
                        workspace,
                        workflow_id,
                        node,
                        not_before=run_record.started_at or run_record.created_at if run_record else None,
                    )
                    if moved_outputs:
                        await self._append_event(
                            workspace,
                            WorkflowEvent(
                                workflow_id=workflow_id,
                                timestamp=utc_now(),
                                event_type="artifact",
                                node_id=node_id,
                                run_id=node.run_id,
                                message=f"Archived {len(moved_outputs)} declared output(s) from workspace root",
                                payload={"moved": moved_outputs},
                            ),
                        )
                    missing_outputs = missing_concrete_outputs(workspace, workflow_id, node)
                    if missing_outputs:
                        failure_error = "Missing expected output file(s): " + ", ".join(missing_outputs)
                    elif node.can_ask_questions is False and node.run_id:
                        message_path = last_message_path(workspace, node.run_id)
                        if message_path.exists():
                            try:
                                final_message = message_path.read_text(encoding="utf-8", errors="replace")
                            except OSError:
                                final_message = ""
                            if output_has_disallowed_question(final_message):
                                failure_error = (
                                    "Protocol violation: this worker role cannot ask questions. "
                                    "Rerun with assumptions stated as facts or evidence markers."
                                )

                if failure_error is None:
                    if node.auto_approve_after:
                        sync_literature_result_to_wiki(workspace, workflow_id, node)
                        node.status = "succeeded"
                        node.approved_after = True
                    else:
                        node.status = "waiting_approval"
                    node.error = None
                    update_workflow(workspace, workflow_id, graph_json=graph)
                    refreshed = self._require(workspace, workflow_id)
                    artifact_entries = build_artifact_index(workspace, refreshed)
                    write_artifact_index(workspace, workflow_id, artifact_entries)
                    message = (
                        f"Node completed and auto-approved: {node.name}"
                        if node.auto_approve_after
                        else f"Node completed and waiting for batch approval: {node.name}"
                    )
                    await self._append_event(
                        workspace,
                        WorkflowEvent(
                            workflow_id=workflow_id,
                            timestamp=utc_now(),
                            event_type="node",
                            node_id=node_id,
                            run_id=node.run_id,
                            message=message,
                            payload={"auto_approve_after": node.auto_approve_after},
                        ),
                    )
                    final_summary = ""
                    if node.run_id:
                        message_path = last_message_path(workspace, node.run_id)
                        if message_path.exists():
                            try:
                                final_summary = _human_message_preview(message_path.read_text(encoding="utf-8", errors="replace"))
                            except OSError:
                                final_summary = ""
                    if final_summary and node.reports_to_chat is not False:
                        await self._append_event(
                            workspace,
                            WorkflowEvent(
                                workflow_id=workflow_id,
                                timestamp=utc_now(),
                                event_type="team_message",
                                node_id=node_id,
                                run_id=node.run_id,
                                message=final_summary,
                                payload={
                                    "role": node.assignee_role or node.role or node.team_role_id,
                                    "role_kind": node.team_role_kind or "worker",
                                    "scope": node.scope,
                                    "artifact_refs": [
                                        item.path for item in artifact_entries if item.producer_node_id == node_id
                                    ],
                                    "can_ask_questions": node.can_ask_questions,
                                    "can_clone_workers": node.can_clone_workers,
                                },
                            ),
                        )
                    await self._append_event(
                        workspace,
                        WorkflowEvent(
                            workflow_id=workflow_id,
                            timestamp=utc_now(),
                            event_type="session",
                            node_id=node_id,
                            run_id=node.run_id,
                            message="SessionTurnCompleted",
                            payload={
                                "session_id": _session_id_for_node(workflow_id, node),
                                "session_path": node.session_path,
                                "artifact_refs": [
                                    item.path for item in artifact_entries if item.producer_node_id == node_id
                                ],
                                "auto_approve_after": node.auto_approve_after,
                            },
                        ),
                    )
                    return

                # Failure path: consult retry policy.
                policy = node.retry
                attempt = node.attempt + 1  # index of the attempt that just failed
                error_lower = failure_error.lower()
                should_retry = (
                    policy is not None
                    and attempt < policy.max_attempts
                    and (not policy.on or any(token.lower() in error_lower for token in policy.on))
                )
                if should_retry:
                    node.attempt = attempt
                    update_workflow(workspace, workflow_id, graph_json=graph)
                    backoff = max(0.0, policy.backoff_seconds * (2 ** (attempt - 1)))
                    await self._append_event(
                        workspace,
                        WorkflowEvent(
                            workflow_id=workflow_id,
                            timestamp=utc_now(),
                            event_type="node",
                            node_id=node_id,
                            run_id=node.run_id,
                            message=f"Node retry {attempt}/{policy.max_attempts - 1} in {backoff:.2f}s: {node.name}",
                            payload={
                                "reason": "retry",
                                "attempt": attempt,
                                "max_attempts": policy.max_attempts,
                                "backoff_seconds": backoff,
                                "error": failure_error,
                            },
                        ),
                    )
                    if backoff > 0:
                        await asyncio.sleep(backoff)
                    continue

                node.status = "failed"
                node.error = failure_error
                policy = node.failure_policy or "halt"
                if policy == "halt":
                    update_workflow(
                        workspace,
                        workflow_id,
                        status="paused",
                        graph_json=graph,
                        error=node.error,
                    )
                elif policy == "skip_descendants":
                    descendants = self._descendants(graph, node_id)
                    skipped_count = 0
                    for child in graph.nodes:
                        if child.id in descendants and child.status == "queued":
                            child.status = "skipped"
                            skipped_count += 1
                    update_workflow(
                        workspace,
                        workflow_id,
                        graph_json=graph,
                        error=node.error,
                    )
                    await self._append_event(
                        workspace,
                        WorkflowEvent(
                            workflow_id=workflow_id,
                            timestamp=utc_now(),
                            event_type="workflow",
                            message=f"Failure isolated at {node.name}: {skipped_count} descendant node(s) skipped",
                            payload={"node_id": node_id, "policy": policy, "skipped": skipped_count},
                        ),
                    )
                else:  # "continue"
                    update_workflow(
                        workspace,
                        workflow_id,
                        graph_json=graph,
                        error=node.error,
                    )
                await self._append_event(
                    workspace,
                    WorkflowEvent(
                        workflow_id=workflow_id,
                        timestamp=utc_now(),
                        event_type="node",
                        node_id=node_id,
                        run_id=node.run_id,
                        message=f"Node failed: {node.name}",
                        payload={"error": node.error, "attempts": attempt, "failure_policy": policy},
                    ),
                )
                return
        except Exception as exc:
            record = get_workflow(workspace, workflow_id)
            if record is None:
                return
            graph = record.graph_json
            node = self._find_node(graph, node_id)
            node.status = "failed"
            node.error = str(exc)
            update_workflow(workspace, workflow_id, status="paused", graph_json=graph, error=str(exc))
            await self._append_event(
                workspace,
                WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="node", node_id=node_id, message=f"Node failed: {exc}"),
            )
        finally:
            self._active.setdefault(workflow_id, set()).discard(node_id)
            latest = get_workflow(workspace, workflow_id)
            if latest and latest.status == "running":
                await self._tick(workspace, workflow_id)

    async def _run_node(self, workspace: Path, record: WorkflowRecord, node: WorkflowNode) -> NodeRunResult:
        if self.node_runner is not None:
            return await self.node_runner(workspace, record, node)
        return await self._run_node_with_aris(workspace, record, node)

    def _ensure_node_session_path(
        self,
        workspace: Path,
        workflow_id: str,
        graph: WorkflowGraph,
        node: WorkflowNode,
    ) -> WorkflowNode:
        if node.session_path:
            return node
        session_abs = workflow_node_session_path(workspace, workflow_id, node.id)
        session_abs.parent.mkdir(parents=True, exist_ok=True)
        try:
            session_rel = session_abs.resolve().relative_to(workspace.resolve()).as_posix()
        except ValueError:
            session_rel = str(session_abs)
        node.session_path = session_rel
        update_workflow(workspace, workflow_id, graph_json=graph)
        return node

    def _write_literature_inconclusive_result(
        self,
        workspace: Path,
        record: WorkflowRecord,
        node: WorkflowNode,
        run_id: str,
        subagent_dir: Path,
        failures: list[str],
    ) -> str:
        subagent_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = subagent_dir / "literature_result.json"
        try:
            artifact_rel = artifact_path.resolve().relative_to(workspace.resolve()).as_posix()
        except ValueError:
            artifact_rel = str(artifact_path)
        query = research_query_from_request(node.research_request) or node.objective or node.name
        payload = {
            "query": query,
            "status": "inconclusive",
            "papers": [],
            "findings": [],
            "gaps": [
                "Search/fetch failed repeatedly, so the requested literature evidence was not verified.",
                "Planner should route a narrower question, switch search source, or ask another worker if this evidence is still needed.",
            ],
            "sources": [],
            "wiki_refs": [],
            "artifact_refs": [],
            "tool_failures": failures[-5:],
            "workflow_id": record.id,
            "node_id": node.id,
        }
        artifact_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        summary = (
            "Literature scout stopped after repeated search/fetch failures.\n\n"
            f"- Question: {query}\n"
            f"- Status: inconclusive after {len(failures)} search/fetch failure(s)\n"
            f"- Artifact: `{artifact_rel}`\n"
            "- Routing note: planner should decide whether to narrow the query, use another source, or continue without this citation."
        )
        last_message_path(workspace, run_id).write_text(summary, encoding="utf-8")
        return summary

    async def _run_node_with_aris(self, workspace: Path, record: WorkflowRecord, node: WorkflowNode) -> NodeRunResult:
        config = get_agent_config(workspace, node.config_file) if node.type == "sub_agent" and node.config_file else None
        if node.type == "sub_agent" and node.config_file and config is None:
            raise ValueError(f"Agent config not found: {node.config_file}")
        effective_skill_id = node.skill or (config.skill if config else None)
        role_kind = node.team_role_kind or "worker"
        if role_kind == "planner":
            effective_skill_id = None
        effective_model = node.model or (config.model if config else None)
        effective_effort = node.effort or (config.effort if config else None) or effective_effort_override()
        # Prefer the node/config skill so web-launched sub-agents follow the
        # same ARIS skill contract as direct catalog runs. Fall back to a
        # compact generic executor only for ad-hoc nodes.
        fallback_skill = SkillInfo(
            id="workflow-agent",
            name="workflow-agent",
            description="Compact ARIS Web workflow node executor",
            source_path="(workflow node)",
        )
        skill = get_skill(effective_skill_id) if effective_skill_id else None
        if skill is None:
            skill = fallback_skill
        prompt = self._build_node_prompt(workspace, record, node)
        attempt_number = node.attempt + 1
        subagent_dir = workspace / ".aris" / "web" / "workflows" / record.id / "nodes" / node.id / f"attempt-{attempt_number}"
        subagent_dir.mkdir(parents=True, exist_ok=True)
        if node.session_path:
            candidate = Path(node.session_path)
            session_abs = candidate if candidate.is_absolute() else workspace / candidate
        else:
            session_abs = workflow_node_session_path(workspace, record.id, node.id)
        session_abs.parent.mkdir(parents=True, exist_ok=True)
        try:
            session_rel = session_abs.resolve().relative_to(workspace.resolve()).as_posix()
        except ValueError:
            session_rel = str(session_abs)
        if node.session_path != session_rel:
            node.session_path = session_rel
            update_workflow(workspace, record.id, graph_json=record.graph_json)
        request = CreateRunRequest(
            workspace=str(workspace),
            skill=effective_skill_id or skill.id,
            arguments=prompt,
            model=effective_model,
            effort=effective_effort,
            session_path=str(session_abs),
            allowed_tools=allowed_tools_for_role(role_kind, effective_skill_id or skill.id),
            env_overrides={
                "ARIS_WORKFLOW_ID": record.id,
                "ARIS_NODE_ID": node.id,
                "ARIS_NODE_ATTEMPT": str(attempt_number),
                "ARIS_SUBAGENT_DIR": str(subagent_dir),
                "ARIS_NODE_SESSION": str(session_abs),
            },
        )
        # Effective timeout: node-level overrides config-level; None disables.
        effective_timeout = node.timeout_seconds if node.timeout_seconds is not None else (
            config.timeout_seconds if config else None
        )
        if effective_timeout is not None and effective_timeout <= 0:
            effective_timeout = None
        run = await self.run_manager.create_run(request, skill, workspace)
        self._set_node_run_id(workspace, record.id, node.id, run.id)
        run_model = run.model or effective_model or "runtime default"
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=record.id,
                timestamp=utc_now(),
                event_type="node",
                node_id=node.id,
                run_id=run.id,
                message=f"Node attached to run {run.id} (model: {run_model})",
                payload={
                    "timeout_seconds": effective_timeout,
                    "subagent_dir": subagent_dir.resolve().relative_to(workspace.resolve()).as_posix(),
                    "attempt": attempt_number,
                    "model": run_model,
                    "skill": skill.id,
                    "effort": effective_effort,
                },
            ),
        )

        loop = asyncio.get_running_loop()
        deadline = loop.time() + effective_timeout if effective_timeout else None

        queue = await self.run_manager.bus.subscribe(run.id)
        forwarded_event_keys: set[tuple[str, str, str, str]] = set()
        search_failure_messages: list[str] = []
        enforce_search_failure_cap = role_kind == "literature" or skill.id in LITERATURE_SKILLS
        started_at = loop.time()
        heartbeat_interval = 15.0
        next_heartbeat_at = started_at + heartbeat_interval

        def event_key(event: RunEvent) -> tuple[str, str, str, str]:
            payload_key = ""
            if event.payload is not None:
                payload_key = json.dumps(event.payload, ensure_ascii=False, sort_keys=True, default=str)
            return (event.timestamp, event.stream, event.message, payload_key)

        async def forward_once(event: RunEvent) -> None:
            key = event_key(event)
            if key in forwarded_event_keys:
                return
            forwarded_event_keys.add(key)
            await self._forward_run_event(workspace, record.id, node.id, event)
            if (
                enforce_search_failure_cap
                and event.stream == "stderr"
                and "Tool failed:" in event.message
                and ("WebSearch" in event.message or "WebFetch" in event.message)
            ):
                search_failure_messages.append(event.message.strip())

        async def flush_run_events() -> None:
            for event in await self.run_manager.replay_events(workspace, run.id):
                await forward_once(event)
            while True:
                try:
                    event = queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                await forward_once(event)

        async def append_heartbeat() -> None:
            elapsed = int(loop.time() - started_at)
            await self._append_event(
                workspace,
                WorkflowEvent(
                    workflow_id=record.id,
                    timestamp=utc_now(),
                    event_type="run",
                    node_id=node.id,
                    run_id=run.id,
                    message=f"Run still active: {node.name} ({elapsed}s elapsed, model: {run_model})",
                    payload={
                        "kind": "heartbeat",
                        "elapsed_seconds": elapsed,
                        "model": run_model,
                        "skill": skill.id,
                        "effort": effective_effort,
                    },
                ),
            )

        async def maybe_stop_after_search_failures() -> NodeRunResult | None:
            if not enforce_search_failure_cap or len(search_failure_messages) < 3:
                return None
            summary = self._write_literature_inconclusive_result(
                workspace,
                record,
                node,
                run.id,
                subagent_dir,
                search_failure_messages,
            )
            await self._append_event(
                workspace,
                WorkflowEvent(
                    workflow_id=record.id,
                    timestamp=utc_now(),
                    event_type="node",
                    node_id=node.id,
                    run_id=run.id,
                    message=f"Literature search stopped after repeated tool failures: {node.name}",
                    payload={"reason": "search_failure_cap", "failure_count": len(search_failure_messages)},
                ),
            )
            try:
                await self.run_manager.cancel(workspace, run.id)
            except Exception:
                pass
            last_message_path(workspace, run.id).write_text(summary, encoding="utf-8")
            return NodeRunResult(run_id=run.id, succeeded=True, message=summary, error=None)

        try:
            await flush_run_events()
            cap_result = await maybe_stop_after_search_failures()
            if cap_result is not None:
                return cap_result
            while True:
                current = get_run(workspace, run.id)
                if current and current.status in {"succeeded", "failed", "cancelled"}:
                    await flush_run_events()
                    # ``RunManager`` updates the run status immediately before
                    # appending its final system event. Give the event bus a
                    # short grace window so workflow terminals do not miss the
                    # tail of a completed run.
                    grace_until = loop.time() + 0.35
                    while loop.time() < grace_until:
                        try:
                            event = await asyncio.wait_for(
                                queue.get(),
                                timeout=max(0.01, min(0.1, grace_until - loop.time())),
                            )
                        except asyncio.TimeoutError:
                            break
                        await forward_once(event)
                    await flush_run_events()
                    run_error = current.error
                    if current.status != "succeeded" and not run_error:
                        run_error = await self._latest_run_error(workspace, run.id)
                    return NodeRunResult(
                        run_id=run.id,
                        succeeded=current.status == "succeeded",
                        message=run_error or current.status,
                        error=run_error if current.status != "succeeded" else None,
                    )
                if deadline is not None and loop.time() >= deadline:
                    # Node exceeded its wall-clock budget; cancel the underlying run
                    # and surface a typed error so callers (and future retry logic)
                    # can distinguish a timeout from a generic failure.
                    timeout_msg = f"timeout after {effective_timeout}s"
                    await self._append_event(
                        workspace,
                        WorkflowEvent(
                            workflow_id=record.id,
                            timestamp=utc_now(),
                            event_type="node",
                            node_id=node.id,
                            run_id=run.id,
                            message=f"Node timed out: {node.name} ({timeout_msg})",
                            payload={"reason": "timeout", "timeout_seconds": effective_timeout},
                        ),
                    )
                    try:
                        await self.run_manager.cancel(workspace, run.id)
                    except Exception:
                        # Cancel is best-effort; the run record might already be terminal.
                        pass
                    return NodeRunResult(
                        run_id=run.id,
                        succeeded=False,
                        message=timeout_msg,
                        error=timeout_msg,
                    )
                wait_for = 1.0
                if deadline is not None:
                    wait_for = min(wait_for, max(0.05, deadline - loop.time()))
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=wait_for)
                except asyncio.TimeoutError:
                    now = loop.time()
                    if now >= next_heartbeat_at:
                        await append_heartbeat()
                        next_heartbeat_at = now + heartbeat_interval
                    continue
                await forward_once(event)
                cap_result = await maybe_stop_after_search_failures()
                if cap_result is not None:
                    return cap_result
        finally:
            await self.run_manager.bus.unsubscribe(run.id, queue)

    async def _latest_run_error(self, workspace: Path, run_id: str) -> str | None:
        events = await self.run_manager.replay_events(workspace, run_id)
        for event in reversed(events):
            message = event.message.strip()
            if event.stream == "stderr" and message and not message.startswith("Run `aris "):
                return message
        for event in reversed(events):
            if event.stream == "system" and "failed" in event.message.lower():
                return event.message.strip()
        return None

    def _build_node_prompt(self, workspace: Path, record: WorkflowRecord, node: WorkflowNode) -> str:
        config = get_agent_config(workspace, node.config_file) if node.type == "sub_agent" and node.config_file else None
        if node.type == "sub_agent" and node.config_file and config is None:
            raise ValueError(f"Agent config not found: {node.config_file}")
        upstream = []
        nodes_by_id = {item.id: item for item in record.graph_json.nodes}
        role_kind = node.team_role_kind or "worker"
        artifact_index = build_artifact_index(workspace, record)
        artifacts_by_node: dict[str, list[ArtifactIndexEntry]] = {}
        for artifact in artifact_index:
            if artifact.producer_node_id:
                artifacts_by_node.setdefault(artifact.producer_node_id, []).append(artifact)
        team_chat_items = [
            {
                "timestamp": item.timestamp,
                "node_id": item.node_id,
                "role": item.role,
                "role_kind": item.role_kind,
                "scope": item.scope,
                "message": item.message,
                "artifact_refs": [artifact.path for artifact in item.artifact_refs],
            }
            for item in build_team_chat_messages(workspace, record, artifact_index)[-20:]
        ]
        team_chat_text = json.dumps(team_chat_items, ensure_ascii=False, indent=2) if team_chat_items else "(no team chat updates yet)"
        fanout_source_id = None
        if node.fanout_parent_id:
            template_node = nodes_by_id.get(node.fanout_parent_id)
            if template_node and template_node.fanout:
                fanout_source_id = template_node.fanout.source or (template_node.depends_on[0] if template_node.depends_on else None)
        for dep in node.depends_on:
            parent = nodes_by_id.get(dep)
            if not parent:
                continue
            summary = ""
            structured_blob = ""
            if node.fanout_item is not None and fanout_source_id == parent.id:
                summary = "Fan-out source completed. Use the Dynamic fan-out assignment above for this child node."
            elif parent.type == "input":
                summary = parent.objective.strip() or parent.prompt.strip() or parent.name
            elif role_kind == "planner":
                parent_messages = [item for item in team_chat_items if item["node_id"] == parent.id]
                parent_artifacts = [artifact.path for artifact in artifacts_by_node.get(parent.id, [])]
                summary = json.dumps(
                    {
                        "status": parent.status,
                        "human_language_updates": parent_messages,
                        "artifact_refs": parent_artifacts,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            elif parent.run_id:
                # Prefer the structured node_output.json when an upstream agent
                # produced a parseable JSON payload — gives the downstream node
                # a typed view rather than re-parsing tail text.
                output_json_path = node_output_path(workspace, parent.run_id)
                if output_json_path.exists():
                    try:
                        parsed = json.loads(output_json_path.read_text(encoding="utf-8"))
                        json_payload = parsed.get("json") if isinstance(parsed, dict) else None
                        if json_payload is not None:
                            blob = json.dumps(json_payload, ensure_ascii=False, indent=2)
                            structured_blob = f"\n\nStructured output (JSON):\n```json\n{blob[:6000]}\n```"
                    except (json.JSONDecodeError, OSError):
                        pass
                path = last_message_path(workspace, parent.run_id)
                if path.exists():
                    summary = path.read_text(encoding="utf-8", errors="replace")[-6000:]
            port_header = _render_port_summary(parent.outputs, kind="produces")
            upstream.append(
                f"## {parent.name} ({dep})\n{port_header}\n{summary or parent.status}{structured_blob}"
            )
        upstream_text = "\n\n".join(upstream) or "(no upstream node outputs)"
        outputs_text = _render_port_summary(node.outputs, kind="expected outputs")
        if not node.outputs:
            outputs_text = "workspace artifacts and a concise final summary"
        concrete_outputs = concrete_output_paths(node.outputs)
        concrete_outputs_text = "\n".join(
            f"- {output_path.as_posix()} -> {workflow_output_relative_path(workspace, record.id, node, output_path)}"
            for output_path in concrete_outputs
        ) or "(no concrete file outputs declared)"
        fanout_output_requirements = _fanout_output_requirements(record.graph_json, node)
        inputs_text = _render_port_summary(node.inputs, kind="expected inputs")
        if not node.inputs:
            inputs_text = "(none declared)"
        fanout_assignment = ""
        if node.fanout_item is not None:
            fanout_assignment = json.dumps(node.fanout_item, ensure_ascii=False, indent=2)
        acceptance_text = "\n".join(f"- {item}" for item in node.acceptance_criteria) or "(none declared)"
        config_text = "(none)"
        config_prefix = ""
        if config:
            config_prefix = f"{config.prompt_prefix}\n" if config.prompt_prefix else ""
            config_text = f"""Config file: {config.path}
Config name: {config.name}
Config role: {config.role or "(none)"}
Config model default: {config.model or "(default)"}
Config skill default: {config.skill or "(node/ad-hoc)"}
Config effort default: {config.effort or "(default)"}

System instructions from config:
{config.system_prompt or "(none)"}

Prompt prefix from config:
{config.prompt_prefix or "(none)"}

Output contract from config:
{config.output_contract or "(none)"}
"""
        effective_skill_label = None if role_kind == "planner" else node.skill or (config.skill if config else None)
        actor_label = "SubAgent" if node.type == "sub_agent" else "Agent"
        prompt_text = node.prompt.strip()
        if not prompt_text:
            prompt_text = "(none; follow the inherited skill contract, objective, inputs, outputs, and acceptance criteria.)"
        role_scope = node.scope or default_scope_for_kind(role_kind)
        defaults = protocol_defaults(role_kind)
        can_ask_questions = defaults["can_ask_questions"] if node.can_ask_questions is None else bool(node.can_ask_questions)
        can_clone_workers = defaults["can_clone_workers"] if node.can_clone_workers is None else bool(node.can_clone_workers)
        can_call_planner = defaults["can_call_planner"] if node.can_call_planner is None else bool(node.can_call_planner)
        peer_access = defaults["peer_access"] if node.peer_access is None else bool(node.peer_access)
        planner_control_text = ""
        if role_kind == "planner":
            planner_control_text = """
	Planner control-plane rules:
	- You are the control-plane planner, not a content worker.
	- You cannot read full artifacts. Use only Team chat updates, artifact_refs, task status, and the initial goal.
	- Do not use read/glob/grep/WebSearch/WebFetch/Skill. Those tools are intentionally unavailable for this role.
	- If you need details, ask an employee by writing `[ASK_WORKER: writer|literature scout|citation inserter|reviewer | concrete question]` in your declared artifact or final summary.
	- Use `[LITERATURE_NEEDED: one precise query]` only for concrete literature gaps. Write one marker per query.
	- Keep your own output short: route questions, summarize status, and point to artifact_refs.
"""
        reviewer_dialogue_text = ""
        if role_kind == "reviewer":
            reviewer_dialogue_text = """
	Reviewer dialogue rules:
	- Keep looking for concrete problems in evidence, citations, claims, and clarity.
	- If an issue needs work, write `[ASK_WORKER: writer|literature scout|citation inserter | concrete question]` in your artifact and final summary.
	- Do not perform the fix yourself and do not decide the assignee; the planner routes your questions.
	- If no blocking question remains, explicitly say PASS and keep any notes as non-blocking watch items.
"""
        if role_kind == "planner":
            tool_contract = "- Planner tool contract: only write/edit/TodoWrite/Sleep/SendUserMessage/Config/StructuredOutput are available; do not attempt to inspect file contents."
        elif role_kind == "literature":
            tool_contract = "- Literature tool contract: use search/fetch and artifact tools only for the routed query; stop with an inconclusive artifact after repeated failures."
        elif role_kind in {"writer", "citation"}:
            tool_contract = "- Artifact worker tool contract: read and edit artifacts, but do not use WebSearch/WebFetch and do not ask follow-up questions. If citations or evidence are missing, report focused [LITERATURE_NEEDED: ...] markers in the short human update."
        elif role_kind == "reviewer":
            tool_contract = "- Reviewer tool contract: inspect artifacts and write review questions, but do not use WebSearch/WebFetch. Route follow-up work with [ASK_WORKER: writer|literature scout|citation inserter | concrete question]."
        else:
            tool_contract = "- Use the available workspace-safe tools directly for the assigned scope."
        skill_contract = (
            "- Planner role ignores suggested skills. Ask workers to read artifacts or search; do not load skill instructions."
            if role_kind == "planner"
            else "- When a suggested skill label is present, treat that ARIS skill as the node's execution contract. Load its SKILL.md with the Skill tool when it is relevant to the node, especially for literature search or research review, while keeping this node prompt as the local scope and output contract."
        )
        return f"""You are executing one {actor_label} task in an ARIS Web multi-agent task board runtime.

Task board title: {record.title}
Initial goal:
{record.goal}

Task id: {node.id}
Task name: {node.name}
Task type: {node.task_type}
Task runtime type: {node.type}
Task role: {node.role or "agent"}
Task objective:
{node.objective.strip() or "(derive the concrete work from the inherited skill and declared inputs/outputs)"}
Acceptance criteria:
{acceptance_text}
Assigned role: {node.assignee_role or node.role or node.team_role_id or "(none)"}
Assigned to: {node.assigned_to or "(unassigned)"}
Claimed by: {node.claimed_by or "(unclaimed)"}
Review status: {node.review_status}
Suggested skill label: {("/" + effective_skill_label) if effective_skill_label else "(none)"}
Expected inputs:
{inputs_text}
Expected outputs:
{outputs_text}

Concrete output storage paths:
{concrete_outputs_text}

Downstream fan-out requirements:
{fanout_output_requirements}

Task execution namespace:
- ARIS_WORKFLOW_ID={record.id}
- ARIS_NODE_ID={node.id}
- ARIS_NODE_ATTEMPT={node.attempt + 1}
- ARIS_SUBAGENT_DIR=.aris/web/workflows/{record.id}/nodes/{node.id}/attempt-{node.attempt + 1}
- ARIS_NODE_SESSION={node.session_path or ".aris/web/workflows/" + record.id + "/nodes/" + node.id + "/session.json"}

	Dynamic planning context:
	- dynamic_parent_id={node.dynamic_parent_id or "(none)"}
- dynamic_reason={node.dynamic_reason or "(none)"}
- auto_approve_after={str(node.auto_approve_after).lower()}
- research_request={json.dumps(node.research_request, ensure_ascii=False) if node.research_request else "(none)"}

	Agent configuration profile:
	{config_text}

	Team protocol:
	- role_kind={role_kind}
	- core_scope={role_scope}
	- can_ask_questions={str(can_ask_questions).lower()}
	- can_clone_workers={str(can_clone_workers).lower()}
	- can_call_planner={str(can_call_planner).lower()}
	- peer_access={str(peer_access).lower()}
	- Communicate in normal human language. Final summaries should be compact status updates plus artifact paths, not raw full-text dumps.
	- The planner reads team chat updates and artifact references. Do not paste long artifacts into the final summary.
	- If can_call_planner=false, do not ask, invoke, or route requests directly to the planner. State assumptions, blockers, and artifacts in your own update.
	- If can_ask_questions=false, do not ask questions. Make a reasonable default assumption and record it as a statement. Use [LITERATURE_NEEDED: ...] or [EVIDENCE_NEEDED: ...] when evidence is missing.
	- If can_clone_workers=true and the task needs parallel help, write [CLONE_WORKER: concise helper objective] in the declared artifact or final summary; the runtime planner will decide whether to materialize helper workers.
{planner_control_text}
{reviewer_dialogue_text}

	Dynamic fan-out assignment:
{fanout_assignment or "(none)"}

Team chat updates:
{team_chat_text}

Upstream task outputs:
{upstream_text}

Task prompt:
{config_prefix}{prompt_text}

Execution requirements:
- The subprocess current working directory is already the workspace.
- Work only inside this workspace.
- Use the provided ARIS_NODE_SESSION for conversation continuity when the runner resumes this node; otherwise rely only on this prompt, upstream outputs, and workspace artifacts.
- Do not write workflow-generated files into the project root.
- Do not treat same-named files already sitting in the project root as this node's current outputs; regenerate and write this node's deliverables to the mapped ARIS_SUBAGENT_DIR paths.
- Use ARIS_SUBAGENT_DIR for all node-owned files: scratch files, intermediate notes, private analysis artifacts, temporary per-agent state, and final node deliverables.
- Do not use Bash, shell scripts, PowerShell, REPL tools, or sub-agent spawning from the web runner.
- {tool_contract[2:] if tool_contract.startswith("- ") else tool_contract}
- If a skill suggests a helper script that requires Bash, perform the equivalent search, reading, or writing with the safe tools instead.
- For literature or research tasks, keep external search bounded: use at most 12 WebSearch/WebFetch calls total, stop after 3 search/fetch failures, and then write the declared artifacts from available evidence. Mark uncertain or unverified entries explicitly instead of continuing to search.
- If this task needs missing literature, citation anchors, or external evidence before it can make a claim, do not invent sources or silently continue. Write a clear marker like `[LITERATURE_NEEDED: focused search query]` or `[EVIDENCE_NEEDED: focused evidence question]` into this node's declared artifact; the Manager will insert a dynamic Literature task and rerun this role after it completes.
- Use relative paths for file operations; do not use absolute workspace paths in commands or tool inputs.
- Produce every expected output that names a concrete file path at the mapped path shown in "Concrete output storage paths".
- If "Downstream fan-out requirements" is not "(none)", write those JSON fan-out artifacts under ARIS_SUBAGENT_DIR before the final summary.
- If a declared output is `INTRO_OUTLINE.md`, write it as `ARIS_SUBAGENT_DIR/INTRO_OUTLINE.md`, not `./INTRO_OUTLINE.md`.
- If a declared output includes subdirectories, preserve that relative structure under ARIS_SUBAGENT_DIR unless the mapped path already starts with `.aris/`.
- Treat upstream task outputs as read-only context. Do not rewrite upstream artifacts unless the current task explicitly declares that output path.
- {skill_contract[2:] if skill_contract.startswith("- ") else skill_contract}
- Follow the agent configuration profile when present. Task fields override config defaults for skill/model/effort.
- Satisfy the acceptance criteria explicitly in your final summary and name any criteria that remain unmet.
- Respect the output contract from config when present.
- Keep a concise final summary (roughly 200 words or fewer) that names files created or changed, artifact paths, risks, and blockers. Do not paste full artifact contents.
- Do not store API keys or credentials in files.
"""

    def _set_node_run_id(self, workspace: Path, workflow_id: str, node_id: str, run_id: str) -> None:
        record = self._require(workspace, workflow_id)
        graph = record.graph_json
        node = self._find_node(graph, node_id)
        node.run_id = run_id
        update_workflow(workspace, workflow_id, graph_json=graph)

    async def _forward_run_event(self, workspace: Path, workflow_id: str, node_id: str, event) -> None:
        event_type = workflow_event_type_for_run_stream(event.stream)
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=workflow_id,
                timestamp=event.timestamp,
                event_type=event_type,
                node_id=node_id,
                run_id=event.run_id,
                message=event.message,
                payload=event.payload,
            ),
        )
        # Surface token/cost on the node when ``aris prompt`` emits its final
        # ``usage`` JSON. This only fires once per run (final stdout line),
        # so the extra ``update_workflow`` write is cheap.
        await self._apply_usage_from_run_event(workspace, workflow_id, node_id, event)

    async def _apply_usage_from_run_event(
        self,
        workspace: Path,
        workflow_id: str,
        node_id: str,
        event,
    ) -> None:
        usage_block = extract_usage_from_payload(getattr(event, "payload", None))
        if usage_block is None:
            return
        try:
            record = self._require(workspace, workflow_id)
        except ValueError:
            return
        graph = record.graph_json
        try:
            node = self._find_node(graph, node_id)
        except ValueError:
            return
        input_tokens = int(usage_block.get("input_tokens", 0) or 0)
        output_tokens = int(usage_block.get("output_tokens", 0) or 0)
        cache_creation = int(usage_block.get("cache_creation_input_tokens", 0) or 0)
        cache_read = int(usage_block.get("cache_read_input_tokens", 0) or 0)

        # Resolve which model produced these tokens — node override > config
        # default. If we can't price it, surface counts with cost_usd=None.
        config = get_agent_config(workspace, node.config_file) if node.type == "sub_agent" and node.config_file else None
        run_record = get_run(workspace, getattr(event, "run_id", ""))
        model_name = (
            usage_block.get("model")
            or (run_record.model if run_record else None)
            or node.model
            or (config.model if config else None)
            or effective_model_override()
        )
        pricing = pricing_for_model(model_name)
        cost_usd: float | None = None
        if pricing is not None:
            cost_usd = estimate_cost_usd(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_creation_input_tokens=cache_creation,
                cache_read_input_tokens=cache_read,
                pricing=pricing,
            )

        # ``aris prompt`` non-interactive emits one usage block per run, but
        # guard against duplicates (e.g. cumulative across retries) by
        # accumulating into the existing record if one is present.
        existing = node.usage
        if existing is None:
            node.usage = NodeUsage(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_creation_input_tokens=cache_creation,
                cache_read_input_tokens=cache_read,
                cost_usd=cost_usd,
                model=model_name,
            )
        else:
            node.usage = NodeUsage(
                input_tokens=existing.input_tokens + input_tokens,
                output_tokens=existing.output_tokens + output_tokens,
                cache_creation_input_tokens=existing.cache_creation_input_tokens + cache_creation,
                cache_read_input_tokens=existing.cache_read_input_tokens + cache_read,
                cost_usd=((existing.cost_usd or 0.0) + cost_usd) if cost_usd is not None else existing.cost_usd,
                model=model_name or existing.model,
            )
        update_workflow(workspace, workflow_id, graph_json=graph)

    def _require(self, workspace: Path, workflow_id: str) -> WorkflowRecord:
        record = get_workflow(workspace, workflow_id)
        if record is None:
            raise ValueError("Workflow not found")
        return record

    @staticmethod
    def _find_node(graph: WorkflowGraph, node_id: str) -> WorkflowNode:
        for node in graph.nodes:
            if node.id == node_id:
                return node
        raise ValueError(f"Workflow node not found: {node_id}")

    @staticmethod
    def _descendants(graph: WorkflowGraph, node_id: str) -> set[str]:
        children: dict[str, set[str]] = {}
        for node in graph.nodes:
            if node.fanout_parent_id:
                children.setdefault(node.fanout_parent_id, set()).add(node.id)
            for dep in node.depends_on:
                children.setdefault(dep, set()).add(node.id)
        result: set[str] = set()
        stack = list(children.get(node_id, set()))
        while stack:
            current = stack.pop()
            if current in result:
                continue
            result.add(current)
            stack.extend(children.get(current, set()))
        return result

    async def _append_event(self, workspace: Path, event: WorkflowEvent) -> None:
        append_workflow_event(workspace, event)
        await self.bus.publish(event)
