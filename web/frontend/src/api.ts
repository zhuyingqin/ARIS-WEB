import type {
  AgentConfig,
  AgentConfigPayload,
  ArtifactInfo,
  CreateRunPayload,
  CreateWorkflowPayload,
  ExpandTeamPayload,
  GenerateWorkflowPayload,
  RefineWorkflowPayload,
  GlobalSettings,
  HealthResponse,
  OptimizeNodePromptPayload,
  OptimizeNodePromptResponse,
  PlannerDecisionRecord,
  RunOutput,
  RunRecord,
  SessionRuntimeView,
  SkillInfo,
  TaskBoardResponse,
  TeamConfig,
  TeamConfigPayload,
  UpdateGlobalSettingsPayload,
  ValidateSettingsResponse,
  WorkflowDeltaRecord,
  WorkflowRecord,
  WorkflowRuntimeResponse,
  WorkspaceInfo,
} from "./types"

export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000"

function wsBase() {
  return API_BASE.replace(/^http/, "ws")
}

function encodeArtifactId(path: string) {
  const bytes = new TextEncoder().encode(path)
  let binary = ""
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    ...options,
  })
  if (!response.ok) {
    let message = response.statusText
    try {
      const body = await response.json()
      message = body.detail ?? message
    } catch {
      message = await response.text()
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  settings: () => request<GlobalSettings>("/api/settings"),
  updateSettings: (payload: UpdateGlobalSettingsPayload) =>
    request<GlobalSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  validateSettings: (payload: UpdateGlobalSettingsPayload) =>
    request<ValidateSettingsResponse>("/api/settings/validate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  skills: () => request<SkillInfo[]>("/api/skills"),
  agentConfigs: (workspace: string) =>
    request<AgentConfig[]>(`/api/agent-configs?workspace=${encodeURIComponent(workspace)}`),
  createAgentConfig: (payload: AgentConfigPayload) =>
    request<AgentConfig>("/api/agent-configs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateAgentConfig: (config: AgentConfig) =>
    request<AgentConfig>(`/api/agent-configs/${config.id}?workspace=${encodeURIComponent(config.workspace)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: config.name,
        role: config.role,
        skill: config.skill,
        model: config.model,
        effort: config.effort,
        system_prompt: config.system_prompt,
        prompt_prefix: config.prompt_prefix,
        output_contract: config.output_contract,
        timeout_seconds: config.timeout_seconds ?? null,
      }),
    }),
  deleteAgentConfig: (config: AgentConfig) =>
    request<{ ok: boolean }>(`/api/agent-configs/${config.id}?workspace=${encodeURIComponent(config.workspace)}`, {
      method: "DELETE",
    }),
  teamConfigs: (workspace: string) =>
    request<TeamConfig[]>(`/api/team-configs?workspace=${encodeURIComponent(workspace)}`),
  createTeamConfig: (payload: TeamConfigPayload) =>
    request<TeamConfig>("/api/team-configs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateTeamConfig: (config: TeamConfig) =>
    request<TeamConfig>(`/api/team-configs/${config.id}?workspace=${encodeURIComponent(config.workspace)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: config.name,
        description: config.description,
        roles: config.roles,
        default_edges: config.default_edges,
      }),
    }),
  deleteTeamConfig: (config: TeamConfig) =>
    request<{ ok: boolean }>(`/api/team-configs/${config.id}?workspace=${encodeURIComponent(config.workspace)}`, {
      method: "DELETE",
    }),
  workspaces: () => request<WorkspaceInfo[]>("/api/workspaces"),
  addWorkspace: (path: string) =>
    request<WorkspaceInfo>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  runs: () => request<RunRecord[]>("/api/runs"),
  createRun: (payload: CreateRunPayload) =>
    request<RunRecord>("/api/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  cancelRun: (run: RunRecord) =>
    request<RunRecord>(`/api/runs/${run.id}/cancel?workspace=${encodeURIComponent(run.workspace)}`, {
      method: "POST",
    }),
  runOutput: (workspace: string, runId: string) =>
    request<RunOutput>(`/api/runs/${runId}/output?workspace=${encodeURIComponent(workspace)}`),
  workflows: (workspace?: string) =>
    request<WorkflowRecord[]>(`/api/task-boards${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`),
  taskBoard: (workflow: WorkflowRecord) =>
    request<TaskBoardResponse>(
      `/api/task-boards/${workflow.id}/task-board?workspace=${encodeURIComponent(workflow.workspace)}`,
    ),
  workflowRuntime: (workflow: WorkflowRecord) =>
    request<WorkflowRuntimeResponse>(
      `/api/task-boards/${workflow.id}/runtime?workspace=${encodeURIComponent(workflow.workspace)}`,
    ),
  workflowDecisions: (workflow: WorkflowRecord) =>
    request<PlannerDecisionRecord[]>(
      `/api/workflows/${workflow.id}/decisions?workspace=${encodeURIComponent(workflow.workspace)}`,
    ),
  workflowDeltas: (workflow: WorkflowRecord) =>
    request<WorkflowDeltaRecord[]>(
      `/api/workflows/${workflow.id}/deltas?workspace=${encodeURIComponent(workflow.workspace)}`,
    ),
  workflowSession: (workflow: WorkflowRecord, sessionId: string) =>
    request<SessionRuntimeView>(
      `/api/workflows/${workflow.id}/sessions/${encodeURIComponent(sessionId)}?workspace=${encodeURIComponent(workflow.workspace)}`,
    ),
  createWorkflow: (payload: CreateWorkflowPayload) =>
    request<WorkflowRecord>("/api/task-boards", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  generateWorkflow: (payload: GenerateWorkflowPayload) =>
    request<WorkflowRecord>("/api/task-boards/generate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  refineWorkflow: (workflow: WorkflowRecord, payload: RefineWorkflowPayload) =>
    request<WorkflowRecord>(`/api/task-boards/${workflow.id}/refine?workspace=${encodeURIComponent(workflow.workspace)}`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateWorkflow: (workflow: WorkflowRecord) =>
    request<WorkflowRecord>(`/api/task-boards/${workflow.id}?workspace=${encodeURIComponent(workflow.workspace)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: workflow.title,
        goal: workflow.goal,
        graph_json: workflow.graph_json,
      }),
    }),
  deleteWorkflow: (workflow: WorkflowRecord) =>
    request<{ ok: boolean }>(`/api/task-boards/${workflow.id}?workspace=${encodeURIComponent(workflow.workspace)}`, {
      method: "DELETE",
    }),
  executeWorkflow: (workflow: WorkflowRecord) =>
    request<WorkflowRecord>(`/api/task-boards/${workflow.id}/execute?workspace=${encodeURIComponent(workflow.workspace)}`, {
      method: "POST",
    }),
  pauseWorkflow: (workflow: WorkflowRecord) =>
    request<WorkflowRecord>(`/api/task-boards/${workflow.id}/pause?workspace=${encodeURIComponent(workflow.workspace)}`, {
      method: "POST",
    }),
  resumeWorkflow: (workflow: WorkflowRecord) =>
    request<WorkflowRecord>(`/api/task-boards/${workflow.id}/resume?workspace=${encodeURIComponent(workflow.workspace)}`, {
      method: "POST",
    }),
  cancelWorkflow: (workflow: WorkflowRecord) =>
    request<WorkflowRecord>(`/api/task-boards/${workflow.id}/cancel?workspace=${encodeURIComponent(workflow.workspace)}`, {
      method: "POST",
    }),
  approveWorkflowNode: (workflow: WorkflowRecord, nodeId: string) =>
    request<WorkflowRecord>(
      `/api/workflows/${workflow.id}/nodes/${nodeId}/approve?workspace=${encodeURIComponent(workflow.workspace)}`,
      { method: "POST" },
    ),
  approveWorkflowBatch: (workflow: WorkflowRecord) =>
    request<WorkflowRecord>(
      `/api/workflows/${workflow.id}/approve-batch?workspace=${encodeURIComponent(workflow.workspace)}`,
      { method: "POST" },
    ),
  skipWorkflowNode: (workflow: WorkflowRecord, nodeId: string) =>
    request<WorkflowRecord>(
      `/api/workflows/${workflow.id}/nodes/${nodeId}/skip?workspace=${encodeURIComponent(workflow.workspace)}`,
      { method: "POST" },
    ),
  restoreWorkflowNode: (workflow: WorkflowRecord, nodeId: string, resetDownstream = false) =>
    request<WorkflowRecord>(
      `/api/workflows/${workflow.id}/nodes/${nodeId}/restore?workspace=${encodeURIComponent(workflow.workspace)}`,
      {
        method: "POST",
        body: JSON.stringify({ reset_downstream: resetDownstream }),
      },
    ),
  optimizeWorkflowNodePrompt: (workflow: WorkflowRecord, nodeId: string, payload: OptimizeNodePromptPayload) =>
    request<OptimizeNodePromptResponse>(
      `/api/workflows/${workflow.id}/nodes/${nodeId}/optimize-prompt?workspace=${encodeURIComponent(workflow.workspace)}`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  rerunWorkflowNode: (workflow: WorkflowRecord, nodeId: string, resetDownstream = false) =>
    request<WorkflowRecord>(
      `/api/workflows/${workflow.id}/nodes/${nodeId}/rerun?workspace=${encodeURIComponent(workflow.workspace)}`,
      {
        method: "POST",
        body: JSON.stringify({ reset_downstream: resetDownstream }),
      },
    ),
  expandWorkflowTeam: (workflow: WorkflowRecord, payload: ExpandTeamPayload) =>
    request<WorkflowRecord>(`/api/workflows/${workflow.id}/teams/expand?workspace=${encodeURIComponent(workflow.workspace)}`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  artifacts: (workspace: string) =>
    request<ArtifactInfo[]>(`/api/artifacts?workspace=${encodeURIComponent(workspace)}`),
  renderHtml: (workspace: string, path: string) =>
    request<ArtifactInfo>("/api/render-html", {
      method: "POST",
      body: JSON.stringify({ workspace, path, template: "academic" }),
    }),
  artifactUrl: (artifact: ArtifactInfo) =>
    `${API_BASE}/api/artifacts/${artifact.id}?workspace=${encodeURIComponent(artifact.workspace)}`,
  artifactUrlForPath: (workspace: string, path: string) =>
    `${API_BASE}/api/artifacts/${encodeArtifactId(path)}?workspace=${encodeURIComponent(workspace)}`,
  runStreamUrl: (run: RunRecord) =>
    `${wsBase()}/api/runs/${run.id}/stream?workspace=${encodeURIComponent(run.workspace)}`,
  workflowStreamUrl: (workflow: WorkflowRecord, replayLimit?: number) =>
    `${wsBase()}/api/workflows/${workflow.id}/stream?workspace=${encodeURIComponent(workflow.workspace)}${
      replayLimit === undefined ? "" : `&replay_limit=${replayLimit}`
    }`,
  workflowNodeStreamUrl: (workflow: WorkflowRecord, nodeId: string, replayLimit?: number) =>
    `${wsBase()}/api/workflows/${workflow.id}/nodes/${nodeId}/stream?workspace=${encodeURIComponent(workflow.workspace)}${
      replayLimit === undefined ? "" : `&replay_limit=${replayLimit}`
    }`,
}
