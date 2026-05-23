from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


GlobalApiProvider = Literal["anthropic", "openai", "gemini", "glm", "minimax", "kimi", "deepseek", "custom"]
RunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
WorkflowStatus = Literal["draft", "running", "paused", "succeeded", "failed", "cancelled"]
WorkflowNodeStatus = Literal[
    "queued",
    "blocked",
    "waiting_dynamic_dependency",
    "waiting_approval",
    "running",
    "succeeded",
    "failed",
    "skipped",
    "cancelled",
]
WorkflowNodeType = Literal["input", "agent", "sub_agent", "human_gate"]
WorkflowGate = Literal["none", "before", "after", "both"]
WorkflowTemplate = Literal["research", "paper_introduction"]
WorkflowFailurePolicy = Literal["halt", "skip_descendants", "continue"]
FanOutEmptyPolicy = Literal["fail", "succeed"]
TaskType = Literal["input", "goal", "planning", "research", "analysis", "coding", "writing", "review", "gate"]
TaskBoardColumn = Literal["backlog", "ready", "running", "review", "rework", "done", "blocked"]
TaskReviewStatus = Literal["not_required", "pending", "passed", "rework"]
TeamRoleKind = Literal["planner", "reviewer", "literature", "writer", "citation", "worker", "gate"]


class HealthItem(BaseModel):
    name: str
    available: bool
    value: str | None = None
    error: str | None = None


class HealthResponse(BaseModel):
    repo_root: str
    checks: list[HealthItem]


class SkillInfo(BaseModel):
    id: str
    name: str
    description: str
    argument_hint: str = ""
    source_path: str
    package: str = "skills"


class WorkspaceInfo(BaseModel):
    path: str
    exists: bool = True


class AddWorkspaceRequest(BaseModel):
    path: str


class CreateRunRequest(BaseModel):
    workspace: str
    skill: str
    arguments: str = ""
    model: str | None = None
    effort: str | None = None
    assurance: str | None = None
    session_path: str | None = None
    allowed_tools: list[str] | None = None
    env_overrides: dict[str, str] = Field(default_factory=dict)


class RunRecord(BaseModel):
    id: str
    workspace: str
    skill: str
    arguments: str = ""
    model: str | None = None
    effort: str | None = None
    assurance: str | None = None
    status: RunStatus
    created_at: str
    updated_at: str
    started_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None
    command: list[str] = Field(default_factory=list)
    last_message_path: str | None = None
    error: str | None = None


class RunEvent(BaseModel):
    run_id: str
    timestamp: str
    stream: Literal["system", "stdout", "stderr", "codex", "thinking", "tool", "result"]
    message: str
    payload: dict[str, Any] | None = None


class RunOutput(BaseModel):
    run_id: str
    last_message: str = ""
    node_output: dict[str, Any] | None = None
    last_message_path: str | None = None
    node_output_path: str | None = None


class ArtifactInfo(BaseModel):
    id: str
    workspace: str
    path: str
    name: str
    kind: str
    size: int
    modified_at: str


class RenderHtmlRequest(BaseModel):
    workspace: str
    path: str
    template: Literal["academic", "dashboard"] = "academic"
    title: str | None = None
    offline: bool = False


class GlobalProviderSettings(BaseModel):
    provider: GlobalApiProvider
    active: bool = False
    api_key_set: bool = False
    api_key_masked: str | None = None
    base_url: str | None = None
    model: str | None = None
    models: list[str] = Field(default_factory=list)
    effort: str | None = None
    updated_at: str | None = None
    applies_to: list[str] = Field(default_factory=list)


class GlobalSettings(BaseModel):
    provider: GlobalApiProvider = "anthropic"
    api_key_set: bool = False
    api_key_masked: str | None = None
    base_url: str | None = None
    model: str | None = None
    models: list[str] = Field(default_factory=list)
    effort: str | None = None
    updated_at: str | None = None
    config_path: str
    applies_to: list[str] = Field(default_factory=list)
    providers: list[GlobalProviderSettings] = Field(default_factory=list)


class UpdateGlobalSettingsRequest(BaseModel):
    provider: GlobalApiProvider = "anthropic"
    api_key: str | None = None
    clear_api_key: bool = False
    base_url: str | None = None
    model: str | None = None
    models: list[str] | None = None
    effort: str | None = None


class ValidateGlobalSettingsResponse(BaseModel):
    ok: bool
    provider: GlobalApiProvider
    endpoint: str | None = None
    model: str | None = None
    message: str
    status_code: int | None = None
    models: list[str] = Field(default_factory=list)
    model_count: int = 0


class AgentConfig(BaseModel):
    id: str
    workspace: str
    path: str
    name: str
    role: str = ""
    skill: str | None = None
    model: str | None = None
    effort: str | None = None
    system_prompt: str = ""
    prompt_prefix: str = ""
    output_contract: str = ""
    timeout_seconds: int | None = None
    created_at: str
    updated_at: str


class AgentConfigRequest(BaseModel):
    workspace: str
    id: str | None = None
    name: str
    role: str = ""
    skill: str | None = None
    model: str | None = None
    effort: str | None = None
    system_prompt: str = ""
    prompt_prefix: str = ""
    output_contract: str = ""
    timeout_seconds: int | None = None


class UpdateAgentConfigRequest(BaseModel):
    name: str | None = None
    role: str | None = None
    skill: str | None = None
    model: str | None = None
    effort: str | None = None
    system_prompt: str | None = None
    prompt_prefix: str | None = None
    output_contract: str | None = None
    timeout_seconds: int | None = None


PortType = Literal["text", "json", "file", "artifact_ref"]


class PortSpec(BaseModel):
    """Structured I/O port for a workflow node.

    Backward-compat: any place that historically accepted ``list[str]`` for
    ``inputs``/``outputs`` will silently lift each string into
    ``PortSpec(name=<string>, type="text")``. New callers can pass the rich
    dict form to declare type, JSON schema, required flag, and a description.
    """
    name: str
    type: PortType = "text"
    schema_: dict[str, Any] | str | None = Field(default=None, alias="schema")
    required: bool = True
    description: str = ""

    model_config = {"populate_by_name": True}


def _coerce_port_list(value: Any) -> Any:
    """Lift legacy ``list[str]`` into ``list[PortSpec]`` while leaving rich entries alone."""
    if value is None:
        return []
    if not isinstance(value, list):
        return value
    coerced: list[Any] = []
    for item in value:
        if isinstance(item, str):
            name = item.strip()
            if not name:
                continue
            coerced.append({"name": name, "type": "text"})
        else:
            coerced.append(item)
    return coerced


class NodeUsage(BaseModel):
    """Token / cost accounting for a workflow node.

    Populated by parsing the ``usage`` block that ``aris prompt`` already
    prints to stdout at run completion. ``cost_usd`` is computed locally
    using a Python pricing table (see ``web/backend/app/pricing.py``) — the
    Rust core does not emit a cost figure on the structured event yet.
    """
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    cost_usd: float | None = None
    model: str | None = None


class RetryPolicy(BaseModel):
    """Per-node retry policy.

    - ``max_attempts``: total attempts including the first one. ``1`` disables retry.
    - ``backoff_seconds``: base delay for exponential backoff. Effective wait is
      ``backoff_seconds * (2 ** (attempt - 1))`` between attempts.
    - ``on``: case-insensitive substring tokens to match against the error string.
      Empty list means retry on any non-cancellation failure.
    """
    max_attempts: int = 1
    backoff_seconds: float = 0.0
    on: list[str] = Field(default_factory=list)


class FanOutSpec(BaseModel):
    """Expand a template SubAgent into one SubAgent per upstream JSON item."""

    source: str | None = None
    path: str = ""
    name_template: str = "{{item.name}}"
    max_items: int = 12
    empty_policy: FanOutEmptyPolicy = "fail"


class WorkflowNode(BaseModel):
    id: str
    type: WorkflowNodeType = "sub_agent"
    name: str
    role: str = ""
    skill: str | None = None
    config_file: str | None = None
    prompt: str = ""
    model: str | None = None
    effort: str | None = None
    gate: WorkflowGate = "none"
    depends_on: list[str] = Field(default_factory=list)
    inputs: list[PortSpec] = Field(default_factory=list)
    outputs: list[PortSpec] = Field(default_factory=list)
    status: WorkflowNodeStatus = "queued"
    run_id: str | None = None
    session_path: str | None = None
    error: str | None = None
    approved_before: bool = False
    approved_after: bool = False
    position: dict[str, float] = Field(default_factory=dict)
    timeout_seconds: int | None = None
    retry: RetryPolicy | None = None
    attempt: int = 0
    usage: NodeUsage | None = None
    failure_policy: WorkflowFailurePolicy = "halt"
    concurrency_class: str = "default"
    fanout: FanOutSpec | None = None
    fanout_parent_id: str | None = None
    fanout_item: Any | None = None
    dynamic_parent_id: str | None = None
    dynamic_reason: str | None = None
    auto_approve_after: bool = False
    research_request: dict[str, Any] | None = None
    team_id: str | None = None
    team_instance_id: str | None = None
    team_role_id: str | None = None
    team_role_kind: TeamRoleKind | None = None
    scope: str = ""
    can_ask_questions: bool | None = None
    can_clone_workers: bool | None = None
    can_call_planner: bool | None = None
    peer_access: bool | None = None
    reports_to_chat: bool | None = None
    task_type: TaskType = "analysis"
    objective: str = ""
    acceptance_criteria: list[str] = Field(default_factory=list)
    assignee_role: str | None = None
    assigned_to: str | None = None
    claimed_by: str | None = None
    review_status: TaskReviewStatus = "not_required"
    review_notes: str = ""
    priority: int = 3

    @field_validator("inputs", "outputs", mode="before")
    @classmethod
    def _normalize_port_lists(cls, value: Any) -> Any:
        return _coerce_port_list(value)

    @field_validator("role", "prompt", mode="before")
    @classmethod
    def _normalize_optional_text(cls, value: Any) -> Any:
        if value is None:
            return ""
        return value

    @field_validator("acceptance_criteria", mode="before")
    @classmethod
    def _normalize_acceptance_criteria(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, str):
            return [line.strip() for line in value.splitlines() if line.strip()]
        return value


class WorkflowEdge(BaseModel):
    id: str
    source: str
    target: str


WorkflowDeltaAction = Literal[
    "add_node",
    "add_edge",
    "block_node",
    "resume_node",
    "complete",
    "mark_noop",
    "mark_policy_rejected",
]
PlannerDecisionType = Literal["noop", "mutate", "resume", "fail"]


class WorkflowDelta(BaseModel):
    action: WorkflowDeltaAction
    node: WorkflowNode | None = None
    source: str | None = None
    target: str | None = None
    node_id: str | None = None
    reason: str = ""
    wait_for: list[str] = Field(default_factory=list)
    research_request: dict[str, Any] | None = None
    refresh: bool = False
    gap_type: str | None = None
    gap_evidence_refs: list[str] = Field(default_factory=list)
    affected_session_ids: list[str] = Field(default_factory=list)
    blocked_node_ids: list[str] = Field(default_factory=list)
    expected_artifacts: list[str] = Field(default_factory=list)
    resume_plan: str | None = None
    source_event_refs: list[str] = Field(default_factory=list)
    source_artifact_refs: list[str] = Field(default_factory=list)
    before_graph_hash: str | None = None
    after_graph_hash: str | None = None
    policy_result: dict[str, Any] | None = None


class PlannerDecision(BaseModel):
    tick_id: str | None = None
    rationale: str = ""
    decision_type: PlannerDecisionType | None = None
    confidence: float | None = None
    gap_type: str | None = None
    gap_evidence_refs: list[str] = Field(default_factory=list)
    dynamic_reason: str | None = None
    affected_session_ids: list[str] = Field(default_factory=list)
    blocked_node_ids: list[str] = Field(default_factory=list)
    expected_artifacts: list[str] = Field(default_factory=list)
    resume_plan: str | None = None
    deltas: list[WorkflowDelta] = Field(default_factory=list)
    complete: bool = False


class RuntimePolicy(BaseModel):
    max_dynamic_nodes_per_caller: int = 3
    max_dynamic_nodes_total: int = 20
    allowed_dynamic_skills: list[str] = Field(default_factory=list)
    require_gap_evidence: bool = True
    allow_static_node_rewrite: bool = False
    allow_delete_static_nodes: bool = False
    allow_human_gate_bypass: bool = False
    auto_approve_literature: bool = True


class PolicyResult(BaseModel):
    allowed: bool
    reason: str = ""


class PlannerDecisionRecord(BaseModel):
    tick_id: str
    workflow_id: str
    timestamp: str
    trigger: str
    decision: PlannerDecision
    decision_type: PlannerDecisionType
    rationale: str = ""
    confidence: float | None = None
    policy_result: PolicyResult
    applied: bool = False
    before_graph_hash: str
    after_graph_hash: str
    source_event_refs: list[str] = Field(default_factory=list)
    source_artifact_refs: list[str] = Field(default_factory=list)


class WorkflowDeltaRecord(BaseModel):
    delta_id: str
    tick_id: str
    workflow_id: str
    timestamp: str
    action: WorkflowDeltaAction
    delta: WorkflowDelta | None = None
    node_id: str | None = None
    source: str | None = None
    target: str | None = None
    reason: str = ""
    gap_type: str | None = None
    gap_evidence_refs: list[str] = Field(default_factory=list)
    before_graph_hash: str
    after_graph_hash: str
    before_graph_json: dict[str, Any] | None = None
    after_graph_json: dict[str, Any] | None = None
    policy_result: PolicyResult
    applied: bool = False
    rejected_reason: str | None = None
    source_event_refs: list[str] = Field(default_factory=list)
    source_artifact_refs: list[str] = Field(default_factory=list)
    affected_session_ids: list[str] = Field(default_factory=list)
    blocked_node_ids: list[str] = Field(default_factory=list)
    expected_artifacts: list[str] = Field(default_factory=list)
    resume_plan: str | None = None
    graph_diff: dict[str, Any] = Field(default_factory=dict)


class ArtifactIndexEntry(BaseModel):
    id: str
    path: str
    name: str
    kind: str = "file"
    producer_node_id: str | None = None
    run_id: str | None = None
    session_id: str | None = None
    size: int = 0
    modified_at: str = ""
    sha256: str | None = None
    summary: str = ""
    refs: list[str] = Field(default_factory=list)


class TeamMessage(BaseModel):
    workflow_id: str
    timestamp: str
    node_id: str | None = None
    run_id: str | None = None
    role: str = ""
    role_kind: TeamRoleKind = "worker"
    scope: str = ""
    message: str = ""
    artifact_refs: list[ArtifactIndexEntry] = Field(default_factory=list)
    can_ask_questions: bool = False
    can_clone_workers: bool = False
    can_call_planner: bool = False
    peer_access: bool = True


class RuntimeSummary(BaseModel):
    planner_session_id: str
    planner_session_path: str
    execution_state: str = "idle"
    next_action: str = ""
    planner_active: bool = False
    latest_tick_id: str | None = None
    latest_decision_type: PlannerDecisionType | None = None
    latest_rationale: str = ""
    active_node_count: int = 0
    active_node_ids: list[str] = Field(default_factory=list)
    waiting_approval_count: int = 0
    waiting_approval_node_ids: list[str] = Field(default_factory=list)
    waiting_dynamic_dependency_count: int = 0
    waiting_dynamic_dependency_node_ids: list[str] = Field(default_factory=list)
    queued_node_count: int = 0
    ready_node_count: int = 0
    ready_node_ids: list[str] = Field(default_factory=list)
    failed_node_count: int = 0
    failed_node_ids: list[str] = Field(default_factory=list)
    terminal_node_count: int = 0
    dynamic_node_count: int = 0
    blocked_session_count: int = 0
    artifact_count: int = 0
    delta_count: int = 0
    decision_count: int = 0
    policy_rejection_count: int = 0
    last_event_at: str | None = None


class WorkflowHandoff(BaseModel):
    source: str
    target: str
    source_name: str = ""
    target_name: str = ""
    source_run_id: str | None = None
    target_run_id: str | None = None
    source_status: WorkflowNodeStatus | None = None
    content_type: Literal["json", "text", "status", "none"] = "none"
    preview: str = ""
    output_path: str | None = None
    has_structured_output: bool = False


class TaskBoardTask(BaseModel):
    id: str
    name: str
    task_type: TaskType
    column: TaskBoardColumn
    status: WorkflowNodeStatus
    role: str = ""
    skill: str | None = None
    objective: str = ""
    prompt: str = ""
    inputs: list[PortSpec] = Field(default_factory=list)
    outputs: list[PortSpec] = Field(default_factory=list)
    depends_on: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    assignee_role: str | None = None
    assigned_to: str | None = None
    claimed_by: str | None = None
    review_status: TaskReviewStatus = "not_required"
    review_notes: str = ""
    priority: int = 3
    artifact_refs: list[ArtifactIndexEntry] = Field(default_factory=list)
    dynamic_parent_id: str | None = None
    dynamic_reason: str | None = None
    team_id: str | None = None
    team_role_id: str | None = None
    team_role_kind: TeamRoleKind | None = None
    scope: str = ""
    can_ask_questions: bool | None = None
    can_clone_workers: bool | None = None
    can_call_planner: bool | None = None
    peer_access: bool | None = None
    reports_to_chat: bool | None = None
    run_id: str | None = None
    error: str | None = None


class TaskBoardColumnSummary(BaseModel):
    id: TaskBoardColumn
    title: str
    task_ids: list[str] = Field(default_factory=list)


class TaskBoardResponse(BaseModel):
    id: str
    workspace: str
    title: str
    goal: str
    status: WorkflowStatus
    tasks: list[TaskBoardTask] = Field(default_factory=list)
    columns: list[TaskBoardColumnSummary] = Field(default_factory=list)
    dependencies: list[WorkflowEdge] = Field(default_factory=list)
    artifact_index: list[ArtifactIndexEntry] = Field(default_factory=list)
    runtime_summary: RuntimeSummary


class TaskClaimRequest(BaseModel):
    agent_id: str | None = None
    role: str | None = None


class TaskReviewRequest(BaseModel):
    review_status: Literal["passed", "rework"]
    notes: str = ""
    acceptance_criteria: list[str] | None = None
    reset_for_rework: bool = True


class TeamEdge(BaseModel):
    id: str | None = None
    source: str
    target: str


class TeamRoleSpec(BaseModel):
    id: str
    name: str
    role: str = ""
    kind: TeamRoleKind | None = None
    scope: str = ""
    can_ask_questions: bool | None = None
    can_clone_workers: bool | None = None
    can_call_planner: bool | None = None
    peer_access: bool | None = None
    reports_to_chat: bool | None = None
    config_file: str | None = None
    skill: str | None = None
    prompt: str = ""
    model: str | None = None
    effort: str | None = None
    inputs: list[PortSpec] = Field(default_factory=list)
    outputs: list[PortSpec] = Field(default_factory=list)
    gate: WorkflowGate = "none"
    failure_policy: WorkflowFailurePolicy = "halt"
    concurrency_class: str = "default"
    position_offset: dict[str, float] = Field(default_factory=dict)

    @field_validator("inputs", "outputs", mode="before")
    @classmethod
    def _normalize_port_lists(cls, value: Any) -> Any:
        return _coerce_port_list(value)

    @field_validator("role", "prompt", mode="before")
    @classmethod
    def _normalize_optional_text(cls, value: Any) -> Any:
        if value is None:
            return ""
        return value


class TeamConfig(BaseModel):
    id: str
    workspace: str
    path: str
    name: str
    description: str = ""
    roles: list[TeamRoleSpec] = Field(default_factory=list)
    default_edges: list[TeamEdge] = Field(default_factory=list)
    created_at: str
    updated_at: str


class TeamConfigRequest(BaseModel):
    workspace: str
    id: str | None = None
    name: str
    description: str = ""
    roles: list[TeamRoleSpec] = Field(default_factory=list)
    default_edges: list[TeamEdge] = Field(default_factory=list)


class UpdateTeamConfigRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    roles: list[TeamRoleSpec] | None = None
    default_edges: list[TeamEdge] | None = None


class WorkflowGraph(BaseModel):
    schema_version: int = 2
    nodes: list[WorkflowNode] = Field(default_factory=list)
    edges: list[WorkflowEdge] = Field(default_factory=list)
    # ``max_concurrency`` overrides the WorkflowManager default for this
    # graph only. ``None`` falls back to the manager default. ``class_limits``
    # caps how many nodes of a given ``WorkflowNode.concurrency_class`` can
    # run simultaneously — useful when an LLM-bound batch shouldn't crowd
    # out IO-bound nodes.
    max_concurrency: int | None = None
    class_limits: dict[str, int] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _upgrade_legacy_agent_nodes(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        schema_version = value.get("schema_version")
        try:
            legacy_schema = schema_version is None or int(schema_version) < 2
        except (TypeError, ValueError):
            legacy_schema = True
        if not legacy_schema:
            return value
        upgraded = dict(value)
        nodes = []
        for node in value.get("nodes") or []:
            if isinstance(node, dict):
                item = dict(node)
                if item.get("type", "agent") == "agent":
                    item["type"] = "sub_agent"
                nodes.append(item)
            else:
                nodes.append(node)
        upgraded["nodes"] = nodes
        upgraded["schema_version"] = 2
        return upgraded


class WorkflowRecord(BaseModel):
    id: str
    workspace: str
    title: str
    goal: str
    status: WorkflowStatus
    graph_json: WorkflowGraph
    created_at: str
    updated_at: str
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None


class WorkflowEvent(BaseModel):
    workflow_id: str
    timestamp: str
    event_type: Literal[
        "workflow",
        "node",
        "run",
        "stdout",
        "stderr",
        "aris",
        "thinking",
        "tool",
        "result",
        "planner",
        "delta",
        "session",
        "team_message",
        "artifact",
        "approval",
    ]
    message: str
    node_id: str | None = None
    run_id: str | None = None
    payload: dict[str, Any] | None = None


class PlanSnapshot(BaseModel):
    graph: WorkflowGraph
    graph_hash: str
    node_count: int
    edge_count: int
    dynamic_node_count: int
    blocked_node_count: int


class WorkflowRuntimeResponse(BaseModel):
    workflow_id: str
    runtime_policy: RuntimePolicy
    runtime_summary: RuntimeSummary
    plan_snapshot: PlanSnapshot
    latest_decision: PlannerDecisionRecord | None = None
    blocked_sessions: list[dict[str, Any]] = Field(default_factory=list)
    dynamic_nodes: list[WorkflowNode] = Field(default_factory=list)
    artifact_index: list[ArtifactIndexEntry] = Field(default_factory=list)
    handoffs: list[WorkflowHandoff] = Field(default_factory=list)
    team_messages: list[TeamMessage] = Field(default_factory=list)


class SessionRuntimeView(BaseModel):
    session_id: str
    workflow_id: str
    node_id: str | None = None
    kind: Literal["planner", "node"]
    session_path: str | None = None
    events: list[WorkflowEvent] = Field(default_factory=list)
    artifact_refs: list[ArtifactIndexEntry] = Field(default_factory=list)
    resume_turns: list[dict[str, Any]] = Field(default_factory=list)


class GenerateWorkflowRequest(BaseModel):
    workspace: str
    goal: str
    title: str | None = None


class RefineWorkflowRequest(BaseModel):
    instructions: str
    title: str | None = None
    graph_json: WorkflowGraph | None = None


class OptimizeNodePromptRequest(BaseModel):
    graph_json: WorkflowGraph | None = None
    instructions: str | None = None
    model: str | None = None


class OptimizeNodePromptResponse(BaseModel):
    prompt: str


class CreateWorkflowRequest(BaseModel):
    workspace: str
    title: str
    goal: str = ""
    graph_json: WorkflowGraph | None = None
    template: WorkflowTemplate | None = None


class UpdateWorkflowRequest(BaseModel):
    title: str | None = None
    goal: str | None = None
    graph_json: WorkflowGraph | None = None
    status: WorkflowStatus | None = None


class NodeActionRequest(BaseModel):
    reset_downstream: bool = False
    reset_descendants: bool = False


class ExpandTeamRequest(BaseModel):
    team_id: str
    prefix: str | None = None
    position: dict[str, float] | None = None
    depends_on: list[str] = Field(default_factory=list)
    connect_to: list[str] = Field(default_factory=list)
