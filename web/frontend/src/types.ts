export type HealthItem = {
  name: string
  available: boolean
  value?: string | null
  error?: string | null
}

export type HealthResponse = {
  repo_root: string
  checks: HealthItem[]
}

export type SkillInfo = {
  id: string
  name: string
  description: string
  argument_hint: string
  source_path: string
  package: string
}

export type WorkspaceInfo = {
  path: string
  exists: boolean
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export type RunRecord = {
  id: string
  workspace: string
  skill: string
  arguments: string
  model?: string | null
  effort?: string | null
  assurance?: string | null
  status: RunStatus
  created_at: string
  updated_at: string
  started_at?: string | null
  finished_at?: string | null
  exit_code?: number | null
  command: string[]
  last_message_path?: string | null
  error?: string | null
}

export type RunEvent = {
  run_id: string
  timestamp: string
  stream: "system" | "stdout" | "stderr" | "codex" | "thinking" | "tool" | "result"
  message: string
  payload?: Record<string, unknown> | null
}

export type RunOutput = {
  run_id: string
  last_message: string
  node_output?: Record<string, unknown> | null
  last_message_path?: string | null
  node_output_path?: string | null
}

export type ArtifactInfo = {
  id: string
  workspace: string
  path: string
  name: string
  kind: string
  size: number
  modified_at: string
}

export type CreateRunPayload = {
  workspace: string
  skill: string
  arguments: string
  model?: string
  effort?: string
  assurance?: string
}

export type AgentConfig = {
  id: string
  workspace: string
  path: string
  name: string
  role: string
  skill?: string | null
  model?: string | null
  effort?: string | null
  system_prompt: string
  prompt_prefix: string
  output_contract: string
  timeout_seconds?: number | null
  created_at: string
  updated_at: string
}

export type AgentConfigPayload = {
  workspace: string
  id?: string | null
  name: string
  role?: string
  skill?: string | null
  model?: string | null
  effort?: string | null
  system_prompt?: string
  prompt_prefix?: string
  output_contract?: string
  timeout_seconds?: number | null
}

export type TeamEdgeInfo = {
  id?: string | null
  source: string
  target: string
}

export type TeamRoleSpec = {
  id: string
  name: string
  role?: string
  config_file?: string | null
  skill?: string | null
  prompt?: string
  model?: string | null
  effort?: string | null
  inputs?: WorkflowPort[]
  outputs?: WorkflowPort[]
  gate?: WorkflowGate
  failure_policy?: "halt" | "skip_descendants" | "continue"
  concurrency_class?: string
  position_offset?: Record<string, number>
}

export type TeamConfig = {
  id: string
  workspace: string
  path: string
  name: string
  description: string
  roles: TeamRoleSpec[]
  default_edges: TeamEdgeInfo[]
  created_at: string
  updated_at: string
}

export type TeamConfigPayload = {
  workspace: string
  id?: string | null
  name: string
  description?: string
  roles?: TeamRoleSpec[]
  default_edges?: TeamEdgeInfo[]
}

export type GlobalApiProvider = "anthropic" | "openai" | "gemini" | "glm" | "minimax" | "kimi" | "custom"

export type GlobalProviderSettings = {
  provider: GlobalApiProvider
  active: boolean
  api_key_set: boolean
  api_key_masked?: string | null
  base_url?: string | null
  model?: string | null
  models?: string[]
  effort?: string | null
  updated_at?: string | null
  applies_to: string[]
}

export type GlobalSettings = {
  provider: GlobalApiProvider
  api_key_set: boolean
  api_key_masked?: string | null
  base_url?: string | null
  model?: string | null
  models?: string[]
  effort?: string | null
  updated_at?: string | null
  config_path: string
  applies_to: string[]
  providers: GlobalProviderSettings[]
}

export type UpdateGlobalSettingsPayload = {
  provider: GlobalApiProvider
  api_key?: string | null
  clear_api_key?: boolean
  base_url?: string | null
  model?: string | null
  models?: string[]
  effort?: string | null
}

export type ValidateSettingsResponse = {
  ok: boolean
  provider: GlobalApiProvider
  endpoint?: string | null
  model?: string | null
  message: string
  status_code?: number | null
  models: string[]
  model_count: number
}

export type WorkflowStatus = "draft" | "running" | "paused" | "succeeded" | "failed" | "cancelled"

export type WorkflowNodeStatus =
  | "queued"
  | "blocked"
  | "waiting_dynamic_dependency"
  | "waiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"

export type WorkflowGate = "none" | "before" | "after" | "both"

export type WorkflowPort = string | {
  name: string
  type?: "text" | "json" | "file" | "artifact_ref"
  schema?: Record<string, unknown> | string | null
  required?: boolean
  description?: string
}

export type NodeUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cost_usd?: number | null
  model?: string | null
}

export type WorkflowFanOut = {
  source?: string | null
  path: string
  name_template: string
  max_items: number
  empty_policy?: "fail" | "succeed"
}

export type WorkflowNodeInfo = {
  id: string
  type: "agent" | "sub_agent" | "human_gate"
  name: string
  role: string
  skill?: string | null
  config_file?: string | null
  prompt: string
  model?: string | null
  effort?: string | null
  gate: WorkflowGate
  depends_on: string[]
  inputs: WorkflowPort[]
  outputs: WorkflowPort[]
  status: WorkflowNodeStatus
  run_id?: string | null
  session_path?: string | null
  error?: string | null
  approved_before: boolean
  approved_after: boolean
  position: Record<string, number>
  timeout_seconds?: number | null
  retry?: { max_attempts: number; backoff_seconds: number; on: string[] } | null
  attempt?: number
  usage?: NodeUsage | null
  failure_policy?: "halt" | "skip_descendants" | "continue"
  concurrency_class?: string
  fanout?: WorkflowFanOut | null
  fanout_parent_id?: string | null
  fanout_item?: unknown
  dynamic_parent_id?: string | null
  dynamic_reason?: string | null
  auto_approve_after?: boolean
  research_request?: Record<string, unknown> | null
  team_id?: string | null
  team_instance_id?: string | null
  team_role_id?: string | null
}

export type WorkflowEdgeInfo = {
  id: string
  source: string
  target: string
}

export type WorkflowDeltaAction =
  | "add_node"
  | "add_edge"
  | "block_node"
  | "resume_node"
  | "complete"
  | "mark_noop"
  | "mark_policy_rejected"

export type PlannerDecisionType = "noop" | "mutate" | "resume" | "fail"

export type WorkflowDeltaInfo = {
  action: WorkflowDeltaAction
  node?: WorkflowNodeInfo | null
  source?: string | null
  target?: string | null
  node_id?: string | null
  reason?: string
  wait_for?: string[]
  research_request?: Record<string, unknown> | null
  refresh?: boolean
  gap_type?: string | null
  gap_evidence_refs?: string[]
  affected_session_ids?: string[]
  blocked_node_ids?: string[]
  expected_artifacts?: string[]
  resume_plan?: string | null
  source_event_refs?: string[]
  source_artifact_refs?: string[]
  before_graph_hash?: string | null
  after_graph_hash?: string | null
  policy_result?: Record<string, unknown> | null
}

export type PlannerDecision = {
  tick_id?: string | null
  rationale: string
  decision_type?: PlannerDecisionType | null
  confidence?: number | null
  gap_type?: string | null
  gap_evidence_refs?: string[]
  dynamic_reason?: string | null
  affected_session_ids?: string[]
  blocked_node_ids?: string[]
  expected_artifacts?: string[]
  resume_plan?: string | null
  deltas: WorkflowDeltaInfo[]
  complete?: boolean
}

export type PolicyResult = {
  allowed: boolean
  reason: string
}

export type PlannerDecisionRecord = {
  tick_id: string
  workflow_id: string
  timestamp: string
  trigger: string
  decision: PlannerDecision
  decision_type: PlannerDecisionType
  rationale: string
  confidence?: number | null
  policy_result: PolicyResult
  applied: boolean
  before_graph_hash: string
  after_graph_hash: string
  source_event_refs: string[]
  source_artifact_refs: string[]
}

export type WorkflowDeltaRecord = {
  delta_id: string
  tick_id: string
  workflow_id: string
  timestamp: string
  action: WorkflowDeltaAction
  delta?: WorkflowDeltaInfo | null
  node_id?: string | null
  source?: string | null
  target?: string | null
  reason: string
  gap_type?: string | null
  gap_evidence_refs: string[]
  before_graph_hash: string
  after_graph_hash: string
  before_graph_json?: Record<string, unknown> | null
  after_graph_json?: Record<string, unknown> | null
  policy_result: PolicyResult
  applied: boolean
  rejected_reason?: string | null
  source_event_refs: string[]
  source_artifact_refs: string[]
  affected_session_ids: string[]
  blocked_node_ids: string[]
  expected_artifacts: string[]
  resume_plan?: string | null
  graph_diff: Record<string, unknown>
}

export type ArtifactIndexEntry = {
  id: string
  path: string
  name: string
  kind: string
  producer_node_id?: string | null
  run_id?: string | null
  session_id?: string | null
  size: number
  modified_at: string
  sha256?: string | null
  summary: string
  refs: string[]
}

export type WorkflowGraph = {
  schema_version?: number
  nodes: WorkflowNodeInfo[]
  edges: WorkflowEdgeInfo[]
  max_concurrency?: number | null
  class_limits?: Record<string, number>
}

export type WorkflowRecord = {
  id: string
  workspace: string
  title: string
  goal: string
  status: WorkflowStatus
  graph_json: WorkflowGraph
  created_at: string
  updated_at: string
  started_at?: string | null
  finished_at?: string | null
  error?: string | null
}

export type WorkflowEvent = {
  workflow_id: string
  timestamp: string
  event_type:
    | "workflow"
    | "node"
    | "run"
    | "stdout"
    | "stderr"
    | "aris"
    | "thinking"
    | "tool"
    | "result"
    | "planner"
    | "delta"
    | "session"
    | "approval"
  message: string
  node_id?: string | null
  run_id?: string | null
  payload?: Record<string, unknown> | null
}

export type RuntimePolicy = {
  max_dynamic_nodes_per_caller: number
  max_dynamic_nodes_total: number
  allowed_dynamic_skills: string[]
  require_gap_evidence: boolean
  allow_static_node_rewrite: boolean
  allow_delete_static_nodes: boolean
  allow_human_gate_bypass: boolean
  auto_approve_literature: boolean
}

export type PlanSnapshot = {
  graph: WorkflowGraph
  graph_hash: string
  node_count: number
  edge_count: number
  dynamic_node_count: number
  blocked_node_count: number
}

export type RuntimeSummary = {
  planner_session_id: string
  planner_session_path: string
  execution_state: string
  next_action: string
  planner_active: boolean
  latest_tick_id?: string | null
  latest_decision_type?: PlannerDecisionType | null
  latest_rationale: string
  active_node_count: number
  active_node_ids: string[]
  waiting_approval_count: number
  waiting_approval_node_ids: string[]
  waiting_dynamic_dependency_count: number
  waiting_dynamic_dependency_node_ids: string[]
  queued_node_count: number
  ready_node_count: number
  ready_node_ids: string[]
  failed_node_count: number
  failed_node_ids: string[]
  terminal_node_count: number
  dynamic_node_count: number
  blocked_session_count: number
  artifact_count: number
  delta_count: number
  decision_count: number
  policy_rejection_count: number
  last_event_at?: string | null
}

export type WorkflowHandoff = {
  source: string
  target: string
  source_name: string
  target_name: string
  source_run_id?: string | null
  target_run_id?: string | null
  source_status?: WorkflowNodeStatus | null
  content_type: "json" | "text" | "status" | "none"
  preview: string
  output_path?: string | null
  has_structured_output: boolean
}

export type WorkflowRuntimeResponse = {
  workflow_id: string
  runtime_policy: RuntimePolicy
  runtime_summary: RuntimeSummary
  plan_snapshot: PlanSnapshot
  latest_decision?: PlannerDecisionRecord | null
  blocked_sessions: Record<string, unknown>[]
  dynamic_nodes: WorkflowNodeInfo[]
  artifact_index: ArtifactIndexEntry[]
  handoffs: WorkflowHandoff[]
}

export type SessionRuntimeView = {
  session_id: string
  workflow_id: string
  node_id?: string | null
  kind: "planner" | "node"
  session_path?: string | null
  events: WorkflowEvent[]
  artifact_refs: ArtifactIndexEntry[]
  resume_turns: Record<string, unknown>[]
}

export type CreateWorkflowPayload = {
  workspace: string
  title: string
  goal?: string
  graph_json?: WorkflowGraph
  template?: "research" | "paper_introduction"
}

export type GenerateWorkflowPayload = {
  workspace: string
  goal: string
  title?: string
}

export type RefineWorkflowPayload = {
  instructions: string
  title?: string | null
  graph_json?: WorkflowGraph
}

export type OptimizeNodePromptPayload = {
  graph_json?: WorkflowGraph
  instructions?: string | null
}

export type OptimizeNodePromptResponse = {
  prompt: string
}

export type ExpandTeamPayload = {
  team_id: string
  prefix?: string | null
  position?: Record<string, number> | null
  depends_on?: string[]
  connect_to?: string[]
}
