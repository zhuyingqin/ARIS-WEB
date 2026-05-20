import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Copy, Plus, RefreshCcw, Save, Trash2, UsersRound } from "lucide-react"
import { api } from "../api"
import type { AgentConfig, AgentConfigPayload, TeamConfig, TeamConfigPayload, TeamEdgeInfo, TeamRoleSpec } from "../types"
import { Badge, Button, Input, Select, Textarea } from "./ui"

type AgentDraft = {
  name: string
  role: string
  skill: string
  model: string
  effort: string
  systemPrompt: string
  promptPrefix: string
  outputContract: string
  timeoutSeconds: string
}

type TeamDraft = {
  name: string
  description: string
  rolesJson: string
  edgesJson: string
}

const defaultTeamRoles: TeamRoleSpec[] = [
  {
    id: "planner",
    name: "Planner",
    role: "team planner",
    prompt: "Break the task into a concise execution plan and name the expected handoffs.",
    position_offset: { x: 0, y: 0 },
  },
  {
    id: "executor",
    name: "Executor",
    role: "implementation agent",
    prompt: "Execute the approved plan and produce the requested artifacts.",
    position_offset: { x: 260, y: 0 },
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "critical reviewer",
    prompt: "Review the executor output for risks, missing evidence, and concrete fixes.",
    position_offset: { x: 520, y: 0 },
  },
]

const defaultTeamEdges: TeamEdgeInfo[] = [
  { source: "planner", target: "executor" },
  { source: "executor", target: "reviewer" },
]

const emptyDraft: AgentDraft = {
  name: "",
  role: "",
  skill: "",
  model: "",
  effort: "",
  systemPrompt: "",
  promptPrefix: "",
  outputContract: "",
  timeoutSeconds: "",
}

const emptyTeamDraft: TeamDraft = {
  name: "",
  description: "",
  rolesJson: JSON.stringify(defaultTeamRoles, null, 2),
  edgesJson: JSON.stringify(defaultTeamEdges, null, 2),
}

function configToDraft(config: AgentConfig): AgentDraft {
  return {
    name: config.name ?? "",
    role: config.role ?? "",
    skill: config.skill ?? "",
    model: config.model ?? "",
    effort: config.effort ?? "",
    systemPrompt: config.system_prompt ?? "",
    promptPrefix: config.prompt_prefix ?? "",
    outputContract: config.output_contract ?? "",
    timeoutSeconds: config.timeout_seconds != null ? String(config.timeout_seconds) : "",
  }
}

function draftToPayload(workspace: string, draft: AgentDraft): AgentConfigPayload {
  const timeoutTrimmed = draft.timeoutSeconds.trim()
  return {
    workspace,
    name: draft.name.trim(),
    role: draft.role.trim(),
    skill: draft.skill || null,
    model: draft.model.trim() || null,
    effort: draft.effort || null,
    system_prompt: draft.systemPrompt,
    prompt_prefix: draft.promptPrefix,
    output_contract: draft.outputContract,
    timeout_seconds: timeoutTrimmed ? Number(timeoutTrimmed) : null,
  }
}

function teamToDraft(config: TeamConfig): TeamDraft {
  return {
    name: config.name ?? "",
    description: config.description ?? "",
    rolesJson: JSON.stringify(config.roles ?? [], null, 2),
    edgesJson: JSON.stringify(config.default_edges ?? [], null, 2),
  }
}

function parseJsonArray<T>(value: string, label: string): T[] {
  const parsed = JSON.parse(value || "[]")
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`)
  }
  return parsed as T[]
}

function draftToTeamPayload(workspace: string, draft: TeamDraft): TeamConfigPayload {
  return {
    workspace,
    name: draft.name.trim(),
    description: draft.description.trim(),
    roles: parseJsonArray<TeamRoleSpec>(draft.rolesJson, "Roles"),
    default_edges: parseJsonArray<TeamEdgeInfo>(draft.edgesJson, "Default edges"),
  }
}

export function AgentsPage({ workspace }: { workspace: string }) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<"agents" | "teams">("agents")
  const [selectedId, setSelectedId] = useState<string>("")
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedTeamId, setSelectedTeamId] = useState<string>("")
  const [teamDraft, setTeamDraft] = useState<TeamDraft>(emptyTeamDraft)
  const [teamDirty, setTeamDirty] = useState(false)
  const [teamError, setTeamError] = useState<string | null>(null)

  const configs = useQuery({
    queryKey: ["agent-configs", workspace],
    queryFn: () => api.agentConfigs(workspace),
    enabled: Boolean(workspace),
  })
  const teamConfigs = useQuery({
    queryKey: ["team-configs", workspace],
    queryFn: () => api.teamConfigs(workspace),
    enabled: Boolean(workspace),
  })
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills })

  const selected = useMemo<AgentConfig | null>(
    () => (configs.data ?? []).find((config) => config.id === selectedId) ?? null,
    [configs.data, selectedId],
  )
  const selectedTeam = useMemo<TeamConfig | null>(
    () => (teamConfigs.data ?? []).find((config) => config.id === selectedTeamId) ?? null,
    [teamConfigs.data, selectedTeamId],
  )
  const isNew = selectedId === ""
  const isNewTeam = selectedTeamId === ""

  useEffect(() => {
    if (!selected) return
    if (dirty) return
    setDraft(configToDraft(selected))
  }, [selected?.id, selected?.updated_at, dirty])

  useEffect(() => {
    if (!selectedTeam) return
    if (teamDirty) return
    setTeamDraft(teamToDraft(selectedTeam))
  }, [selectedTeam?.id, selectedTeam?.updated_at, teamDirty])

  function startNew() {
    setSelectedId("")
    setDraft(emptyDraft)
    setDirty(false)
    setError(null)
  }

  function pickConfig(id: string) {
    setSelectedId(id)
    setDirty(false)
    setError(null)
  }

  function setField<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setDirty(true)
  }

  function startNewTeam() {
    setSelectedTeamId("")
    setTeamDraft(emptyTeamDraft)
    setTeamDirty(false)
    setTeamError(null)
  }

  function pickTeam(id: string) {
    setSelectedTeamId(id)
    setTeamDirty(false)
    setTeamError(null)
  }

  function setTeamField<K extends keyof TeamDraft>(key: K, value: TeamDraft[K]) {
    setTeamDraft((current) => ({ ...current, [key]: value }))
    setTeamDirty(true)
  }

  const createMut = useMutation({
    mutationFn: (payload: AgentConfigPayload) => api.createAgentConfig(payload),
    onSuccess: (config) => {
      queryClient.invalidateQueries({ queryKey: ["agent-configs", workspace] })
      setSelectedId(config.id)
      setDirty(false)
      setError(null)
    },
    onError: (err: Error) => setError(err.message),
  })

  const updateMut = useMutation({
    mutationFn: (config: AgentConfig) => api.updateAgentConfig(config),
    onSuccess: (config) => {
      queryClient.invalidateQueries({ queryKey: ["agent-configs", workspace] })
      setSelectedId(config.id)
      setDirty(false)
      setError(null)
    },
    onError: (err: Error) => setError(err.message),
  })

  const deleteMut = useMutation({
    mutationFn: (config: AgentConfig) => api.deleteAgentConfig(config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-configs", workspace] })
      startNew()
    },
    onError: (err: Error) => setError(err.message),
  })

  const createTeamMut = useMutation({
    mutationFn: (payload: TeamConfigPayload) => api.createTeamConfig(payload),
    onSuccess: (config) => {
      queryClient.invalidateQueries({ queryKey: ["team-configs", workspace] })
      setSelectedTeamId(config.id)
      setTeamDirty(false)
      setTeamError(null)
    },
    onError: (err: Error) => setTeamError(err.message),
  })

  const updateTeamMut = useMutation({
    mutationFn: (config: TeamConfig) => api.updateTeamConfig(config),
    onSuccess: (config) => {
      queryClient.invalidateQueries({ queryKey: ["team-configs", workspace] })
      setSelectedTeamId(config.id)
      setTeamDirty(false)
      setTeamError(null)
    },
    onError: (err: Error) => setTeamError(err.message),
  })

  const deleteTeamMut = useMutation({
    mutationFn: (config: TeamConfig) => api.deleteTeamConfig(config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-configs", workspace] })
      startNewTeam()
    },
    onError: (err: Error) => setTeamError(err.message),
  })

  function handleSave() {
    if (!workspace) {
      setError("Pick a workspace from the sidebar first.")
      return
    }
    if (!draft.name.trim()) {
      setError("Name is required.")
      return
    }
    const trimmedTimeout = draft.timeoutSeconds.trim()
    if (trimmedTimeout) {
      const parsed = Number(trimmedTimeout)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError("Timeout must be a positive integer (seconds) or empty.")
        return
      }
    }
    const payload = draftToPayload(workspace, draft)
    if (selected) {
      updateMut.mutate({
        ...selected,
        name: payload.name,
        role: payload.role ?? "",
        skill: payload.skill ?? null,
        model: payload.model ?? null,
        effort: payload.effort ?? null,
        system_prompt: payload.system_prompt ?? "",
        prompt_prefix: payload.prompt_prefix ?? "",
        output_contract: payload.output_contract ?? "",
        timeout_seconds: payload.timeout_seconds ?? null,
      })
    } else {
      createMut.mutate(payload)
    }
  }

  function handleDuplicate() {
    if (!selected) return
    setSelectedId("")
    setDraft({ ...configToDraft(selected), name: `${selected.name} (copy)` })
    setDirty(true)
    setError(null)
  }

  function handleDelete() {
    if (!selected) return
    if (!globalThis.confirm(`Delete SubAgent profile "${selected.name}"? This cannot be undone.`)) return
    deleteMut.mutate(selected)
  }

  function handleSaveTeam() {
    if (!workspace) {
      setTeamError("Pick a workspace from the sidebar first.")
      return
    }
    if (!teamDraft.name.trim()) {
      setTeamError("Name is required.")
      return
    }
    let payload: TeamConfigPayload
    try {
      payload = draftToTeamPayload(workspace, teamDraft)
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : "Invalid Team JSON.")
      return
    }
    if (!payload.roles?.length) {
      setTeamError("A Team needs at least one role.")
      return
    }
    if (selectedTeam) {
      updateTeamMut.mutate({
        ...selectedTeam,
        name: payload.name,
        description: payload.description ?? "",
        roles: payload.roles ?? [],
        default_edges: payload.default_edges ?? [],
      })
    } else {
      createTeamMut.mutate(payload)
    }
  }

  function handleDuplicateTeam() {
    if (!selectedTeam) return
    setSelectedTeamId("")
    setTeamDraft({ ...teamToDraft(selectedTeam), name: `${selectedTeam.name} (copy)` })
    setTeamDirty(true)
    setTeamError(null)
  }

  function handleDeleteTeam() {
    if (!selectedTeam) return
    if (!globalThis.confirm(`Delete team "${selectedTeam.name}"? This cannot be undone.`)) return
    deleteTeamMut.mutate(selectedTeam)
  }

  if (!workspace) {
    return (
      <div className="empty-state">
        <p className="muted">Pick a workspace from the sidebar to manage SubAgent profiles.</p>
      </div>
    )
  }

  const items = configs.data ?? []
  const saving = createMut.isPending || updateMut.isPending
  const displayedName = draft.name || selected?.name || "Untitled"
  const displayedRole = draft.role || selected?.role || ""
  const teamItems = teamConfigs.data ?? []
  const teamSaving = createTeamMut.isPending || updateTeamMut.isPending
  const displayedTeamName = teamDraft.name || selectedTeam?.name || "Untitled"
  const displayedTeamDescription = teamDraft.description || selectedTeam?.description || ""

  if (mode === "teams") {
    return (
      <div className="orchestrator-grid agents-layout">
        <aside className="orchestrator-left panel">
          <div className="panel-head compact-head">
            <div>
              <h2>Teams</h2>
              <p>{teamItems.length} reusable role teams</p>
            </div>
            <div className="console-actions">
              <Button variant="secondary" onClick={() => teamConfigs.refetch()} type="button" aria-label="Refresh teams" title="Refresh teams">
                <RefreshCcw size={14} />
              </Button>
              <Button onClick={startNewTeam} type="button">
                <Plus size={14} />
                New
              </Button>
            </div>
          </div>
          <div className="mode-switch" aria-label="SubAgent profile manager mode">
            <Button variant="secondary" onClick={() => setMode("agents")} type="button">
              <Bot size={14} />
              Profiles
            </Button>
            <Button onClick={() => setMode("teams")} type="button">
              <UsersRound size={14} />
              Teams
            </Button>
          </div>
          <div className="workflow-list">
            {teamItems.map((config) => (
              <button
                className={`workflow-row ${selectedTeamId === config.id ? "selected" : ""}`}
                key={config.id}
                onClick={() => pickTeam(config.id)}
                type="button"
              >
                <div className="workflow-row-title">
                  <strong>{config.name}</strong>
                  <Badge>Team</Badge>
                </div>
                <span>
                  {config.roles.length} roles · {config.default_edges.length} edges · {config.id}
                </span>
              </button>
            ))}
            {teamConfigs.data?.length === 0 && (
              <div className="list-empty">
                <UsersRound size={18} />
                <span>No teams yet</span>
              </div>
            )}
          </div>
        </aside>

        <section className="orchestrator-main panel">
          <div className="orchestrator-toolbar">
            <div>
              <div className="flow-title-row">
                <Badge>
                  <UsersRound size={13} />
                  Team
                </Badge>
                {!isNewTeam && selectedTeam && <span>{selectedTeam.id}</span>}
              </div>
              <h1>{isNewTeam ? "New team" : displayedTeamName}</h1>
              <p>{displayedTeamDescription || "Reusable multi-role DAG template"}</p>
            </div>
            <div className="console-actions">
              {teamDirty && <Badge>unsaved</Badge>}
              {selectedTeam && (
                <Button variant="secondary" onClick={handleDuplicateTeam} type="button">
                  <Copy size={14} />
                  Duplicate
                </Button>
              )}
              <Button onClick={handleSaveTeam} disabled={!teamDirty || teamSaving} type="button">
                <Save size={14} />
                Save
              </Button>
              {selectedTeam && (
                <Button
                  variant="destructive"
                  onClick={handleDeleteTeam}
                  disabled={deleteTeamMut.isPending}
                  type="button"
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              )}
            </div>
          </div>
          {teamError && <p className="error-text">{teamError}</p>}
          <div className="config-form">
            <div className="two-col">
              <div>
                <label>Name</label>
                <Input
                  value={teamDraft.name}
                  onChange={(event) => setTeamField("name", event.target.value)}
                  placeholder="Research review team"
                />
              </div>
              <div>
                <label>Description</label>
                <Input
                  value={teamDraft.description}
                  onChange={(event) => setTeamField("description", event.target.value)}
                  placeholder="Planner, executor, and reviewer"
                />
              </div>
            </div>
            <div>
              <label>Roles JSON</label>
              <Textarea
                rows={15}
                value={teamDraft.rolesJson}
                onChange={(event) => setTeamField("rolesJson", event.target.value)}
                spellCheck={false}
              />
              <small className="inline-hint">
                Each role expands into an ordinary SubAgent node with its own prompt, skill, model, gate, outputs, and position_offset.
              </small>
            </div>
            <div>
              <label>Default edges JSON</label>
              <Textarea
                rows={6}
                value={teamDraft.edgesJson}
                onChange={(event) => setTeamField("edgesJson", event.target.value)}
                spellCheck={false}
              />
              <small className="inline-hint">
                Edges use role ids. Workflow-level depends_on connects to Team entry roles; connect_to is attached from Team exit roles.
              </small>
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="orchestrator-grid agents-layout">
      <aside className="orchestrator-left panel">
        <div className="panel-head compact-head">
          <div>
            <h2>SubAgent Profiles</h2>
            <p>{items.length} reusable executor profiles</p>
          </div>
          <div className="console-actions">
            <Button variant="secondary" onClick={() => configs.refetch()} type="button" aria-label="Refresh profiles" title="Refresh profiles">
              <RefreshCcw size={14} />
            </Button>
            <Button onClick={startNew} type="button">
              <Plus size={14} />
              New
            </Button>
          </div>
        </div>
        <div className="mode-switch" aria-label="SubAgent profile manager mode">
          <Button onClick={() => setMode("agents")} type="button">
            <Bot size={14} />
            Profiles
          </Button>
          <Button variant="secondary" onClick={() => setMode("teams")} type="button">
            <UsersRound size={14} />
            Teams
          </Button>
        </div>
        <div className="workflow-list">
          {items.map((config) => (
            <button
              className={`workflow-row ${selectedId === config.id ? "selected" : ""}`}
              key={config.id}
              onClick={() => pickConfig(config.id)}
              type="button"
            >
              <div className="workflow-row-title">
                <strong>{config.name}</strong>
                {config.skill && <Badge>{config.skill}</Badge>}
              </div>
              <span>
                {(config.role || "(no role)") + " · " + config.id}
              </span>
            </button>
          ))}
          {configs.data?.length === 0 && (
            <div className="list-empty">
              <Bot size={18} />
              <span>No profiles yet</span>
            </div>
          )}
        </div>
      </aside>

      <section className="orchestrator-main panel">
        <div className="orchestrator-toolbar">
          <div>
            <div className="flow-title-row">
              <Badge>
                <Bot size={13} />
                SubAgent Profile
              </Badge>
              {!isNew && selected && <span>{selected.id}</span>}
            </div>
            <h1>{isNew ? "New SubAgent profile" : displayedName}</h1>
            <p>{displayedRole || "Untitled role"}</p>
          </div>
          <div className="console-actions">
            {dirty && <Badge>unsaved</Badge>}
            {selected && (
              <Button variant="secondary" onClick={handleDuplicate} type="button">
                <Copy size={14} />
                Duplicate
              </Button>
            )}
            <Button onClick={handleSave} disabled={!dirty || saving} type="button">
              <Save size={14} />
              Save
            </Button>
            {selected && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleteMut.isPending}
                type="button"
              >
                <Trash2 size={14} />
                Delete
              </Button>
            )}
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="config-form">
          <div className="two-col">
            <div>
              <label>Name</label>
              <Input
                value={draft.name}
                onChange={(event) => setField("name", event.target.value)}
                placeholder="Researcher"
              />
            </div>
            <div>
              <label>Role</label>
              <Input
                value={draft.role}
                onChange={(event) => setField("role", event.target.value)}
                placeholder="critical reviewer"
              />
            </div>
          </div>
          <div className="two-col">
            <div>
              <label>Default skill</label>
              <Select
                value={draft.skill}
                onChange={(event) => setField("skill", event.target.value)}
              >
                <option value="">(none)</option>
                {(skills.data ?? []).map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    /{skill.id}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label>Effort</label>
              <Select
                value={draft.effort}
                onChange={(event) => setField("effort", event.target.value)}
              >
                <option value="">Default</option>
                <option value="lite">lite</option>
                <option value="balanced">balanced</option>
                <option value="max">max</option>
                <option value="beast">beast</option>
              </Select>
            </div>
          </div>
          <div className="two-col">
            <div>
              <label>Model override</label>
              <Input
                value={draft.model}
                onChange={(event) => setField("model", event.target.value)}
                placeholder="(use workspace default)"
              />
            </div>
            <div>
              <label>Timeout (seconds)</label>
              <Input
                value={draft.timeoutSeconds}
                onChange={(event) => setField("timeoutSeconds", event.target.value)}
                placeholder="e.g. 1800"
                inputMode="numeric"
              />
            </div>
          </div>
          <div>
            <label>System prompt</label>
            <Textarea
              rows={6}
              value={draft.systemPrompt}
              onChange={(event) => setField("systemPrompt", event.target.value)}
              placeholder="You are a critical reviewer. Focus on logical gaps and overclaiming."
            />
          </div>
          <div>
            <label>Prompt prefix</label>
            <Textarea
              rows={3}
              value={draft.promptPrefix}
              onChange={(event) => setField("promptPrefix", event.target.value)}
              placeholder="Optional text prepended to every node prompt"
            />
          </div>
          <div>
            <label>Output contract</label>
            <Textarea
              rows={3}
              value={draft.outputContract}
              onChange={(event) => setField("outputContract", event.target.value)}
              placeholder="Describe the expected output format (e.g. JSON schema, sections)"
            />
          </div>
        </div>
      </section>
    </div>
  )
}
