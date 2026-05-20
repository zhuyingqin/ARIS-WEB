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
  stream: "system" | "stdout" | "stderr" | "codex"
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

export type GlobalSettings = {
  provider: GlobalApiProvider
  api_key_set: boolean
  api_key_masked?: string | null
  base_url?: string | null
  model?: string | null
  effort?: string | null
  updated_at?: string | null
  config_path: string
  applies_to: string[]
}

export type UpdateGlobalSettingsPayload = {
  provider: GlobalApiProvider
  api_key?: string | null
  clear_api_key?: boolean
  base_url?: string | null
  model?: string | null
  effort?: string | null
}

export type WorkflowStatus = "draft" | "running" | "paused" | "succeeded" | "failed" | "cancelled"

export type WorkflowNodeStatus =
  | "queued"
  | "blocked"
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
  team_id?: string | null
  team_instance_id?: string | null
  team_role_id?: string | null
}

export type WorkflowEdgeInfo = {
  id: string
  source: string
  target: string
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
  event_type: "workflow" | "node" | "run" | "stdout" | "stderr" | "aris"
  message: string
  node_id?: string | null
  run_id?: string | null
  payload?: Record<string, unknown> | null
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

export type ExpandTeamPayload = {
  team_id: string
  prefix?: string | null
  position?: Record<string, number> | null
  depends_on?: string[]
  connect_to?: string[]
}
