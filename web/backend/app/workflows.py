from __future__ import annotations

import asyncio
import json
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
from .global_settings import build_runtime_env, effective_effort_override, effective_model_override, openai_compatible_settings
from .models import (
    CreateRunRequest,
    NodeUsage,
    WorkflowEdge,
    WorkflowEvent,
    WorkflowGraph,
    WorkflowNode,
    WorkflowRecord,
)
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
    delete_workflow,
    get_workflow,
    insert_workflow,
    list_workflows,
    replay_workflow_events,
    update_workflow,
)

try:
    import certifi
except Exception:  # pragma: no cover - certifi may be unavailable in minimal installs
    certifi = None


TERMINAL_NODE_STATUSES = {"succeeded", "skipped", "cancelled", "failed"}
SUCCESS_NODE_STATUSES = {"succeeded", "skipped"}
EXECUTABLE_NODE_TYPES = {"agent", "sub_agent"}


@dataclass
class NodeRunResult:
    run_id: str | None
    succeeded: bool
    message: str = ""
    error: str | None = None


NodeRunner = Callable[[Path, WorkflowRecord, WorkflowNode], Awaitable[NodeRunResult]]


def model_dict(value):
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return value.dict()


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _safe_node_slug(value: object, fallback: str) -> str:
    slug = _slug(str(value))
    return slug[:42].strip("-") or fallback


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


def missing_concrete_outputs(workspace: Path, node: WorkflowNode) -> list[str]:
    missing: list[str] = []
    for output_path in concrete_output_paths(node.outputs):
        resolved = (workspace / output_path).resolve()
        if workspace.resolve() not in [resolved, *resolved.parents]:
            missing.append(output_path.as_posix())
            continue
        if not resolved.exists():
            missing.append(output_path.as_posix())
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
        if node.type in {"agent", "human_gate"}:
            skill = None
            config_file = None
        if skill and known_skills is not None and skill not in known_skills:
            raise ValueError(f"Unknown skill for node {node_id}: {skill}")
        normalized_nodes.append(
            node.copy(update={"id": node_id, "skill": skill, "config_file": config_file}) if not hasattr(node, "model_copy")
            else node.model_copy(update={"id": node_id, "skill": skill, "config_file": config_file})
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

    source_prompt = (
        "Inventory the available paper materials for this introduction-writing task. "
        "Read narrative reports, paper plans, experiment logs, figures, references, and existing TeX when present. "
        "Write INTRO_CONTEXT.md with: one-sentence contribution, target audience/venue assumptions, 3-5 core claims, "
        "evidence for each claim, missing evidence, and citation/literature needs. "
        f"User goal:\n{goal}"
    )
    nodes = [
        WorkflowNode(
            id="intro-context",
            type="agent",
            name="Build introduction context",
            role="paper context scout",
            skill=skill("paper-plan"),
            prompt=source_prompt,
            outputs=["INTRO_CONTEXT.md"],
            position={"x": 0, "y": 100},
        ),
        WorkflowNode(
            id="literature-positioning",
            type="sub_agent",
            name="Map positioning and gap",
            role="literature positioning agent",
            skill=skill("research-lit"),
            prompt=(
                "Using INTRO_CONTEXT.md and the project materials, identify the closest related work, "
                "the precise gap this paper should claim, and 6-10 citation anchors for the Introduction. "
                "You must save INTRO_RELATED_WORK.md with short, citation-ready bullets. Do not invent citations."
            ),
            depends_on=["intro-context"],
            inputs=["INTRO_CONTEXT.md"],
            outputs=["INTRO_RELATED_WORK.md"],
            position={"x": 260, "y": 0},
        ),
        WorkflowNode(
            id="intro-outline",
            type="agent",
            name="Plan introduction arc",
            role="introduction story planner",
            skill=skill("paper-plan"),
            prompt=(
                "You must create INTRO_OUTLINE.md: a paragraph-by-paragraph Introduction arc. "
                "Include motivation, problem, gap, key insight, method sketch, evidence preview, and contributions. "
                "Mark any unsupported claim with [EVIDENCE_NEEDED]."
            ),
            depends_on=["intro-context", "literature-positioning"],
            inputs=["INTRO_CONTEXT.md", "INTRO_RELATED_WORK.md"],
            outputs=["INTRO_OUTLINE.md"],
            position={"x": 520, "y": 100},
        ),
        WorkflowNode(
            id="draft-introduction",
            type="sub_agent",
            name="Draft LaTeX introduction",
            role="introduction writer",
            skill=skill("paper-write"),
            prompt=(
                "Draft only the paper Introduction from INTRO_OUTLINE.md, INTRO_CONTEXT.md, and INTRO_RELATED_WORK.md. "
                "You must write INTRODUCTION_DRAFT.md in the workspace root. "
                "Use concrete claims grounded in available evidence, preserve citation placeholders only when the cited source is known, "
                "and avoid generic hype."
            ),
            depends_on=["intro-outline"],
            inputs=["INTRO_OUTLINE.md", "INTRO_CONTEXT.md", "INTRO_RELATED_WORK.md"],
            outputs=["INTRODUCTION_DRAFT.md"],
            position={"x": 780, "y": 100},
        ),
        WorkflowNode(
            id="review-introduction",
            type="sub_agent",
            name="Review introduction claims",
            role="adversarial introduction reviewer",
            skill=skill("research-review"),
            prompt=(
                "Review the drafted Introduction for unsupported claims, weak motivation, unclear novelty, citation gaps, "
                "and mismatch between evidence and promises. You must save INTRO_REVIEW.md with prioritized fixes."
            ),
            depends_on=["draft-introduction"],
            inputs=["introduction draft"],
            outputs=["INTRO_REVIEW.md"],
            position={"x": 1040, "y": 0},
        ),
        WorkflowNode(
            id="revise-introduction",
            type="sub_agent",
            name="Revise introduction",
            role="introduction revision agent",
            skill=skill("paper-write"),
            prompt=(
                "Revise the Introduction using INTRO_REVIEW.md. Keep changes local to the Introduction artifact, "
                "remove or soften unsupported claims, and write INTRODUCTION_REVISED.md plus INTRO_REVISION_SUMMARY.md explaining the changes."
            ),
            depends_on=["review-introduction"],
            inputs=["introduction draft", "INTRO_REVIEW.md"],
            outputs=["INTRODUCTION_REVISED.md", "INTRO_REVISION_SUMMARY.md"],
            position={"x": 1300, "y": 100},
        ),
        WorkflowNode(
            id="approve-introduction",
            type="human_gate",
            name="Approve introduction",
            role="checkpoint",
            prompt=(
                "Inspect the revised Introduction, INTRO_REVIEW.md, and INTRO_REVISION_SUMMARY.md. "
                "Approve when the Introduction is coherent enough to feed the rest of the paper-writing flow."
            ),
            depends_on=["revise-introduction"],
            position={"x": 1560, "y": 100},
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
    return f"""You are designing an ARIS-Code multi-agent research workflow DAG for the local web console.

Return ONLY valid JSON, with no Markdown fences or prose. The JSON must match:
{{
  "schema_version": 2,
  "title": "short workflow title",
  "goal": "user goal",
  "nodes": [
    {{
      "id": "stable-slug",
      "type": "agent|sub_agent|human_gate",
      "name": "human readable name",
      "role": "planner|literature scout|experiment planner|executor|reviewer|writer",
      "skill": "one skill id from the catalog or null",
      "prompt": "specific task prompt",
      "gate": "none|before|after|both",
      "depends_on": ["upstream-node-id"],
      "fanout": null,
      "position": {{"x": 0, "y": 0}}
    }}
  ],
  "edges": [{{"id": "source->target", "source": "source", "target": "target"}}]
}}

Use 5-7 nodes. Use type="agent" only for planning/orchestration nodes that decide what should happen next.
Use type="sub_agent" for independent execution work such as literature search, implementation, writing, or review.
Use type="human_gate" for visible human checkpoints.
Include at least one human_gate before expensive implementation and one human_gate after review.
For human_gate nodes set skill to null and gate to "none".
For sub_agent nodes, assume a fresh isolated run with no memory beyond declared upstream outputs and artifacts.
When a planner/keyword node produces a variable-length JSON array, create one template sub_agent with a fanout object:
  "fanout": {{"source": "keyword-node-id", "path": "keyword_groups", "name_template": "Literature search: {{{{item.name}}}}", "max_items": 12}}
The fanout template will expand at runtime into one independent SubAgent per JSON item. Downstream nodes depending on the template will wait for all generated SubAgents. Use prompt placeholders like {{{{item.name}}}}, {{{{item.keywords}}}}, {{{{item}}}}, {{{{index}}}}, and {{{{number}}}}.
Do not include model, effort, config_file, inputs, or outputs unless the user explicitly asked for those overrides.
The DAG must be acyclic. Prefer research workflow skills from this catalog:
{catalog}

User goal:
{goal}
"""


WORKFLOW_PROMPT_RUNTIME_FIELDS = {
    "status",
    "run_id",
    "error",
    "approved_before",
    "approved_after",
    "attempt",
    "usage",
    "fanout_parent_id",
    "fanout_item",
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
    "team_id",
    "team_instance_id",
    "team_role_id",
]

WORKFLOW_NODE_PRESERVED_RUNTIME_FIELDS = [
    "status",
    "run_id",
    "error",
    "approved_before",
    "approved_after",
    "attempt",
    "usage",
    "fanout_parent_id",
    "fanout_item",
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
    return f"""You are updating an existing ARIS-Code multi-agent research workflow DAG for the local web console.

Return ONLY valid JSON, with no Markdown fences or prose. Return the complete updated workflow, not a patch.

Current workflow title:
{workflow.title}

Current workflow goal:
{workflow.goal}

Current workflow graph:
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
      "type": "agent|sub_agent|human_gate",
      "name": "human readable name",
      "role": "planner|literature scout|experiment planner|executor|reviewer|writer",
      "skill": "one skill id from the catalog or null",
      "prompt": "specific task prompt",
      "gate": "none|before|after|both",
      "depends_on": ["upstream-node-id"],
      "fanout": null,
      "position": {{"x": 0, "y": 0}}
    }}
  ],
  "edges": [{{"id": "source->target", "source": "source", "target": "target"}}]
}}

Preserve stable node ids, positions, prompts, and edges when they still satisfy the new requirements.
Only add, remove, rename, or reorder nodes when the new requirements make that necessary.
Use type="agent" only for planning/orchestration nodes that decide what should happen next.
Use type="sub_agent" for independent execution work such as literature search, implementation, writing, or review.
Use type="human_gate" for visible human checkpoints.
For human_gate nodes set skill to null and gate to "none".
For sub_agent nodes, assume a fresh isolated run with no memory beyond declared upstream outputs and artifacts.
When the new requirements need variable-length parallel work based on upstream output, use a fanout template sub_agent:
  "fanout": {{"source": "keyword-node-id", "path": "keyword_groups", "name_template": "Literature search: {{{{item.name}}}}", "max_items": 12}}
The template expands at runtime into one independent SubAgent per JSON item. Downstream nodes depending on the template will wait for all generated SubAgents. Use prompt placeholders like {{{{item.name}}}}, {{{{item.keywords}}}}, {{{{item}}}}, {{{{index}}}}, and {{{{number}}}}.
Do not include runtime fields such as status, run_id, error, approved_before, approved_after, attempt, or usage.
Do not include model, effort, config_file, inputs, or outputs unless the user explicitly asked for those overrides.
The DAG must be acyclic. Prefer research workflow skills from this catalog:
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
    return _MISSING


def _template_value_to_text(value: Any) -> str:
    if value is _MISSING or value is None:
        return ""
    if isinstance(value, list) and all(not isinstance(item, (dict, list)) for item in value):
        return ", ".join(str(item) for item in value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


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
    ) -> None:
        self.run_manager = run_manager
        self.max_concurrency = max_concurrency
        self.node_runner = node_runner
        self.bus = WorkflowEventBus()
        self._active: dict[str, set[str]] = {}

    def list(self, workspaces: list[object]) -> list[WorkflowRecord]:
        return list_workflows(workspaces)

    def get(self, workspace: Path, workflow_id: str) -> WorkflowRecord | None:
        return get_workflow(workspace, workflow_id)

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

    async def execute(self, workspace: Path, workflow_id: str) -> WorkflowRecord:
        record = self._require(workspace, workflow_id)
        started_at = record.started_at or utc_now()
        update_workflow(workspace, workflow_id, status="running", started_at=started_at, finished_at=None, clear_error=True)
        await self._append_event(
            workspace,
            WorkflowEvent(workflow_id=workflow_id, timestamp=utc_now(), event_type="workflow", message="Workflow execution started"),
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
            if node.status in {"queued", "blocked", "waiting_approval", "running"}:
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

    async def replay_events(self, workspace: Path, workflow_id: str) -> list[WorkflowEvent]:
        events: list[WorkflowEvent] = []
        for event in replay_workflow_events(workspace, workflow_id):
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

        ready = []
        nodes_by_id = {node.id: node for node in graph.nodes}
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
                    missing_outputs = missing_concrete_outputs(workspace, node)
                    if missing_outputs:
                        failure_error = "Missing expected output file(s): " + ", ".join(missing_outputs)

                if failure_error is None:
                    node.status = "waiting_approval"
                    node.error = None
                    update_workflow(workspace, workflow_id, graph_json=graph)
                    await self._append_event(
                        workspace,
                        WorkflowEvent(
                            workflow_id=workflow_id,
                            timestamp=utc_now(),
                            event_type="node",
                            node_id=node_id,
                            run_id=node.run_id,
                            message=f"Node completed and waiting for batch approval: {node.name}",
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

    async def _run_node_with_aris(self, workspace: Path, record: WorkflowRecord, node: WorkflowNode) -> NodeRunResult:
        config = get_agent_config(workspace, node.config_file) if node.type == "sub_agent" and node.config_file else None
        if node.type == "sub_agent" and node.config_file and config is None:
            raise ValueError(f"Agent config not found: {node.config_file}")
        effective_skill_id = node.skill or (config.skill if config else None)
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
        request = CreateRunRequest(
            workspace=str(workspace),
            skill=effective_skill_id or skill.id,
            arguments=prompt,
            model=effective_model,
            effort=effective_effort,
            env_overrides={
                "ARIS_WORKFLOW_ID": record.id,
                "ARIS_NODE_ID": node.id,
                "ARIS_NODE_ATTEMPT": str(attempt_number),
                "ARIS_SUBAGENT_DIR": str(subagent_dir),
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
        await self._append_event(
            workspace,
            WorkflowEvent(
                workflow_id=record.id,
                timestamp=utc_now(),
                event_type="node",
                node_id=node.id,
                run_id=run.id,
                message=f"Node attached to run {run.id}",
                payload={
                    "timeout_seconds": effective_timeout,
                    "subagent_dir": subagent_dir.resolve().relative_to(workspace.resolve()).as_posix(),
                    "attempt": attempt_number,
                },
            ),
        )

        loop = asyncio.get_running_loop()
        deadline = loop.time() + effective_timeout if effective_timeout else None

        queue = await self.run_manager.bus.subscribe(run.id)
        try:
            for event in await self.run_manager.replay_events(workspace, run.id):
                await self._forward_run_event(workspace, record.id, node.id, event)
            while True:
                current = get_run(workspace, run.id)
                if current and current.status in {"succeeded", "failed", "cancelled"}:
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
                    continue
                await self._forward_run_event(workspace, record.id, node.id, event)
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
        inputs_text = _render_port_summary(node.inputs, kind="expected inputs")
        if not node.inputs:
            inputs_text = "(none declared)"
        fanout_assignment = ""
        if node.fanout_item is not None:
            fanout_assignment = json.dumps(node.fanout_item, ensure_ascii=False, indent=2)
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
        effective_skill_label = node.skill or (config.skill if config else None)
        actor_label = "SubAgent" if node.type == "sub_agent" else "Agent"
        return f"""You are executing one {actor_label} node in an ARIS Web multi-agent workflow.

Workflow title: {record.title}
Workflow goal:
{record.goal}

Node id: {node.id}
Node name: {node.name}
Node type: {node.type}
Node role: {node.role or "agent"}
Suggested skill label: {("/" + effective_skill_label) if effective_skill_label else "(none)"}
Expected inputs:
{inputs_text}
Expected outputs:
{outputs_text}

Sub-agent execution namespace:
- ARIS_WORKFLOW_ID={record.id}
- ARIS_NODE_ID={node.id}
- ARIS_NODE_ATTEMPT={node.attempt + 1}
- ARIS_SUBAGENT_DIR=.aris/web/workflows/{record.id}/nodes/{node.id}/attempt-{node.attempt + 1}

Agent configuration profile:
{config_text}

Dynamic fan-out assignment:
{fanout_assignment or "(none)"}

Upstream node outputs:
{upstream_text}

Node task prompt:
{config_prefix}{node.prompt}

Execution requirements:
- The subprocess current working directory is already the workspace.
- Work only inside this workspace.
- Treat this as a fresh run. Do not assume any prior conversation, memory, or hidden state exists.
- Use ARIS_SUBAGENT_DIR for scratch files, intermediate notes, private analysis artifacts, and temporary per-agent state.
- Do not use Bash, shell scripts, PowerShell, REPL tools, or sub-agent spawning from the web runner.
- Use the available workspace-safe tools directly: read/write/edit/glob/grep/WebSearch/WebFetch/Skill/LlmReview.
- If a skill suggests a helper script that requires Bash, perform the equivalent search, reading, or writing with the safe tools instead.
- Use relative paths such as `.` and `paper/...` for file operations; do not use absolute workspace paths in commands or tool inputs.
- Produce every expected output that names a concrete file path. If the expected output is `INTRO_RELATED_WORK.md`, `INTRO_OUTLINE.md`, `INTRODUCTION_DRAFT.md`, `INTRO_REVIEW.md`, `INTRODUCTION_REVISED.md`, or `INTRO_REVISION_SUMMARY.md`, write that exact file before finishing.
- Declared concrete outputs belong at their requested workspace-relative paths, not inside ARIS_SUBAGENT_DIR, unless the output itself is explicitly under `.aris/`.
- Treat upstream node outputs as read-only context. Do not rewrite upstream artifacts unless the current node explicitly declares that output path.
- When a suggested skill label is present, treat that ARIS skill as the node's execution contract. Load its SKILL.md with the Skill tool when it is relevant to the node, especially for literature search or research review, while keeping this node prompt as the local scope and output contract.
- Follow the agent configuration profile when present. Node fields override config defaults for skill/model/effort.
- Respect the output contract from config when present.
- Keep a concise final summary that names files created or changed.
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
        model_name = node.model or (config.model if config else None)
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
