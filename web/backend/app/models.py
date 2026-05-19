from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


GlobalApiProvider = Literal["anthropic", "openai", "gemini", "glm", "minimax", "kimi", "custom"]
RunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
WorkflowStatus = Literal["draft", "running", "paused", "succeeded", "failed", "cancelled"]
WorkflowNodeStatus = Literal[
    "queued",
    "blocked",
    "waiting_approval",
    "running",
    "succeeded",
    "failed",
    "skipped",
    "cancelled",
]
WorkflowNodeType = Literal["agent", "human_gate"]
WorkflowGate = Literal["none", "before", "after", "both"]
WorkflowTemplate = Literal["research", "paper_introduction"]
WorkflowFailurePolicy = Literal["halt", "skip_descendants", "continue"]


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
    stream: Literal["system", "stdout", "stderr", "codex"]
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


class GlobalSettings(BaseModel):
    provider: GlobalApiProvider = "anthropic"
    api_key_set: bool = False
    api_key_masked: str | None = None
    base_url: str | None = None
    model: str | None = None
    effort: str | None = None
    updated_at: str | None = None
    config_path: str
    applies_to: list[str] = Field(default_factory=list)


class UpdateGlobalSettingsRequest(BaseModel):
    provider: GlobalApiProvider = "anthropic"
    api_key: str | None = None
    clear_api_key: bool = False
    base_url: str | None = None
    model: str | None = None
    effort: str | None = None


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


class WorkflowNode(BaseModel):
    id: str
    type: WorkflowNodeType = "agent"
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
    team_id: str | None = None
    team_instance_id: str | None = None
    team_role_id: str | None = None

    @field_validator("inputs", "outputs", mode="before")
    @classmethod
    def _normalize_port_lists(cls, value: Any) -> Any:
        return _coerce_port_list(value)


class WorkflowEdge(BaseModel):
    id: str
    source: str
    target: str


class TeamEdge(BaseModel):
    id: str | None = None
    source: str
    target: str


class TeamRoleSpec(BaseModel):
    id: str
    name: str
    role: str = ""
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
    nodes: list[WorkflowNode] = Field(default_factory=list)
    edges: list[WorkflowEdge] = Field(default_factory=list)
    # ``max_concurrency`` overrides the WorkflowManager default for this
    # graph only. ``None`` falls back to the manager default. ``class_limits``
    # caps how many nodes of a given ``WorkflowNode.concurrency_class`` can
    # run simultaneously — useful when an LLM-bound batch shouldn't crowd
    # out IO-bound nodes.
    max_concurrency: int | None = None
    class_limits: dict[str, int] = Field(default_factory=dict)


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
    event_type: Literal["workflow", "node", "run", "stdout", "stderr", "aris"]
    message: str
    node_id: str | None = None
    run_id: str | None = None
    payload: dict[str, Any] | None = None


class GenerateWorkflowRequest(BaseModel):
    workspace: str
    goal: str
    title: str | None = None


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


class ExpandTeamRequest(BaseModel):
    team_id: str
    prefix: str | None = None
    position: dict[str, float] | None = None
    depends_on: list[str] = Field(default_factory=list)
    connect_to: list[str] = Field(default_factory=list)
