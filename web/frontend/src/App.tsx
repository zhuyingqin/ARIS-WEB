import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
  Activity,
  Bot,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Cpu,
  FileText,
  Folder,
  GitBranch,
  HeartPulse,
  KeyRound,
  Layers3,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  UsersRound,
  Wand2,
  XCircle,
} from "lucide-react"
import { api } from "./api"
import type {
  AgentConfig,
  ArtifactInfo,
  GlobalApiProvider,
  RunEvent,
  RunRecord,
  SkillInfo,
  TeamConfig,
  WorkflowEvent,
  WorkflowGate,
  WorkflowNodeInfo,
  WorkflowPort,
  WorkflowRecord,
  WorkspaceInfo,
} from "./types"
import { Badge, Button, Card, Dialog, Input, Select, Tabs, Textarea } from "./components/ui"
import { AgentsPage } from "./components/AgentsPage"

const navItems = [
  { value: "orchestrator", label: "Orchestrator", icon: <GitBranch size={16} /> },
  { value: "agents", label: "SubAgents", icon: <Bot size={16} /> },
  { value: "skills", label: "Skills", icon: <BookOpen size={16} /> },
  { value: "runs", label: "Runs", icon: <Terminal size={16} /> },
  { value: "artifacts", label: "Artifacts", icon: <FileText size={16} /> },
  { value: "settings", label: "Settings", icon: <KeyRound size={16} /> },
  { value: "health", label: "Health", icon: <HeartPulse size={16} /> },
]

const workflowTemplateOptions = [
  { value: "research", label: "Research validation" },
  { value: "paper_introduction", label: "Paper introduction" },
] as const

function statusClass(status: string) {
  return `status status-${status}`
}

function compactPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~")
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function useAutoScrollToEnd<T extends HTMLElement>(dependencies: unknown[]) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, dependencies)
  return ref
}

function useDefaultWorkspace(workspaces: WorkspaceInfo[] | undefined) {
  return useMemo(() => workspaces?.find((workspace) => workspace.exists)?.path ?? "", [workspaces])
}

export default function App() {
  const queryClient = useQueryClient()
  const [view, setView] = useState("orchestrator")
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces })
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 8000 })
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills })
  const defaultWorkspace = useDefaultWorkspace(workspaces.data)
  const [workspace, setWorkspace] = useState("")
  const [workspaceDraft, setWorkspaceDraft] = useState("")

  useEffect(() => {
    if (!workspace && defaultWorkspace) {
      setWorkspace(defaultWorkspace)
      setWorkspaceDraft(defaultWorkspace)
    }
  }, [defaultWorkspace, workspace])

  const addWorkspace = useMutation({
    mutationFn: api.addWorkspace,
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] })
      setWorkspace(item.path)
      setWorkspaceDraft(item.path)
    },
  })

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>ARIS-Code</strong>
            <span>Research cockpit</span>
          </div>
        </div>
        <div className="branch-pill">
          <Sparkles size={14} />
          <span>aris-code</span>
        </div>
        <Tabs value={view} onChange={setView} items={navItems} />
        <Card className="workspace-card">
          <label>Workspace</label>
          <Select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
            {(workspaces.data ?? []).map((item) => (
              <option key={item.path} value={item.path} disabled={!item.exists}>
                {compactPath(item.path)}
              </option>
            ))}
          </Select>
          <div className="inline-form">
            <Input
              value={workspaceDraft}
              onChange={(event) => setWorkspaceDraft(event.target.value)}
              placeholder="/path/to/project"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => addWorkspace.mutate(workspaceDraft)}
              disabled={!workspaceDraft || addWorkspace.isPending}
              aria-label="Add workspace"
              title="Add workspace"
            >
              <Folder size={15} />
            </Button>
          </div>
          {addWorkspace.error && <p className="error-text">{addWorkspace.error.message}</p>}
        </Card>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="topbar-title">
            <span className="eyebrow">Auto Research in Sleep</span>
            <h1>{navItems.find((item) => item.value === view)?.label ?? "Console"}</h1>
          </div>
          <div className="metric-strip">
            <div className="metric metric-wide">
              <Folder size={17} />
              <span title={workspace || "No workspace selected"}>{workspace ? compactPath(workspace) : "None"}</span>
              <b>workspace</b>
            </div>
            <div className="metric">
              <Layers3 size={17} />
              <span>{skills.data?.length ?? "..."}</span>
              <b>skills</b>
            </div>
            <div className="metric">
              <Cpu size={17} />
              <span>{health.data?.checks.find((item) => item.name === "aris")?.available ? "bin" : "cargo"}</span>
              <b>runner</b>
            </div>
          </div>
        </div>
        {view === "orchestrator" && <OrchestratorPage workspace={workspace} />}
        {view === "agents" && <AgentsPage workspace={workspace} />}
        {view === "skills" && <SkillsPage workspace={workspace} onRunCreated={() => setView("runs")} />}
        {view === "runs" && <RunsPage workspace={workspace} />}
        {view === "artifacts" && <ArtifactsPage workspace={workspace} />}
        {view === "settings" && <SettingsPage />}
        {view === "health" && <HealthPage />}
      </main>
    </div>
  )
}

function cloneWorkflow(workflow: WorkflowRecord): WorkflowRecord {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowRecord
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function portName(value: WorkflowPort) {
  return typeof value === "string" ? value : value.name
}

function joinList(value: WorkflowPort[] | string[]) {
  return value.map((item) => portName(item as WorkflowPort)).join(", ")
}

function outputFilePaths(outputs: WorkflowPort[]) {
  const fileLike = /\.(md|markdown|html?|pdf|txt|jsonl?|csv|tsv|tex|bib|docx|pptx|xlsx|png|jpe?g|webp|svg)$/i
  return outputs
    .filter((item) => {
      if (typeof item !== "string" && ["file", "artifact_ref"].includes(item.type ?? "")) return true
      return fileLike.test(portName(item))
    })
    .map((item) => portName(item).replace(/^\.\//, ""))
    .filter(Boolean)
}

function slug(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || `node-${Date.now().toString(36)}`
}

function uniqueTeamPrefix(teamId: string, nodes: WorkflowNodeInfo[]) {
  const base = slug(teamId)
  const used = new Set(nodes.map((node) => node.id))
  let candidate = base
  let index = 2
  while ([...used].some((id) => id === candidate || id.startsWith(`${candidate}-`))) {
    candidate = `${base}-${index}`
    index += 1
  }
  return candidate
}

function workflowCounts(workflow: WorkflowRecord) {
  const nodes = workflow.graph_json.nodes
  const agents = nodes.filter((node) => node.type === "agent").length
  const subAgents = nodes.filter((node) => node.type === "sub_agent").length
  const gates = nodes.filter((node) => node.type === "human_gate").length
  const specialists = new Set(
    nodes.filter((node) => node.type === "sub_agent" && node.config_file).map((node) => node.config_file as string),
  ).size
  return { agents, subAgents, gates, specialists }
}

function workflowNodeOrder(workflow: WorkflowRecord | null): string[] {
  const nodes = workflow?.graph_json.nodes ?? []
  const nodeIds = new Set(nodes.map((node) => node.id))
  const incoming = new Map(nodes.map((node) => [node.id, new Set<string>()]))
  const outgoing = new Map(nodes.map((node) => [node.id, new Set<string>()]))
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]))

  function addDependency(source: string | undefined, target: string | undefined) {
    if (!source || !target || source === target || !nodeIds.has(source) || !nodeIds.has(target)) return
    incoming.get(target)?.add(source)
    outgoing.get(source)?.add(target)
  }

  for (const node of nodes) {
    for (const dep of node.depends_on) addDependency(dep, node.id)
  }
  for (const edge of workflow?.graph_json.edges ?? []) addDependency(edge.source, edge.target)

  const ready = nodes
    .filter((node) => (incoming.get(node.id)?.size ?? 0) === 0)
    .map((node) => node.id)
  const order: string[] = []
  const visited = new Set<string>()

  while (ready.length) {
    ready.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))
    const id = ready.shift() as string
    if (visited.has(id)) continue
    visited.add(id)
    order.push(id)

    for (const target of outgoing.get(id) ?? []) {
      const sourceSet = incoming.get(target)
      sourceSet?.delete(id)
      if (!visited.has(target) && (sourceSet?.size ?? 0) === 0) ready.push(target)
    }
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) order.push(node.id)
  }
  return order
}

function workflowNodeSequence(workflow: WorkflowRecord | null): Map<string, number> {
  return new Map(workflowNodeOrder(workflow).map((id, index) => [id, index + 1]))
}

function organizeWorkflowPositions(workflow: WorkflowRecord) {
  const order = workflowNodeOrder(workflow)
  const orderIndex = new Map(order.map((id, index) => [id, index]))
  const nodeMap = new Map(workflow.graph_json.nodes.map((node) => [node.id, node]))
  const layerById = new Map<string, number>()

  for (const id of order) {
    const node = nodeMap.get(id)
    if (!node) continue
    const deps = [
      ...node.depends_on,
      ...workflow.graph_json.edges.filter((edge) => edge.target === id).map((edge) => edge.source),
    ].filter((dep) => nodeMap.has(dep))
    const layer = deps.reduce((max, dep) => Math.max(max, (layerById.get(dep) ?? 0) + 1), 0)
    layerById.set(id, layer)
  }

  const rowsByLayer = new Map<number, string[]>()
  for (const id of order) {
    const layer = layerById.get(id) ?? 0
    rowsByLayer.set(layer, [...(rowsByLayer.get(layer) ?? []), id])
  }

  for (const ids of rowsByLayer.values()) {
    ids.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0))
  }

  workflow.graph_json.nodes = workflow.graph_json.nodes.map((node) => {
    const layer = layerById.get(node.id) ?? 0
    const row = rowsByLayer.get(layer)?.indexOf(node.id) ?? 0
    return {
      ...node,
      position: {
        x: 80 + layer * 300,
        y: 92 + row * 148,
      },
    }
  })
}

function nodeKindLabel(node: WorkflowNodeInfo) {
  if (node.type === "human_gate") return "Gate"
  if (node.type === "sub_agent") return "SubAgent"
  return "Agent"
}

function isExecutableNode(node: WorkflowNodeInfo) {
  return node.type === "agent" || node.type === "sub_agent"
}

const ROLE_PALETTE = ["#7c3aed", "#0ea5e9", "#16a34a", "#f59e0b", "#dc2626", "#0891b2", "#9333ea", "#0d9488"]

function roleColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
  }
  return ROLE_PALETTE[Math.abs(hash) % ROLE_PALETTE.length]
}

function findAgentConfig(
  configs: AgentConfig[] | undefined,
  configFile: string | null | undefined,
): AgentConfig | null {
  if (!configFile || !configs) return null
  return configs.find((config) => config.path === configFile || config.id === configFile) ?? null
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1).trimEnd()}…`
}

function jsonPreview(value: unknown, max = 420) {
  if (value === null || value === undefined) return ""
  let text = ""
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return truncate(text, max)
}

function NodeResultPanel({ workflow, node }: { workflow: WorkflowRecord; node: WorkflowNodeInfo }) {
  const queryClient = useQueryClient()
  const [nodeEvents, setNodeEvents] = useState<WorkflowEvent[]>([])
  const nodeEventLogRef = useAutoScrollToEnd<HTMLDivElement>([nodeEvents.length, node.id])
  const runId = node.run_id ?? ""
  const outputQuery = useQuery({
    queryKey: ["run-output", workflow.workspace, runId],
    queryFn: () => api.runOutput(workflow.workspace, runId),
    enabled: Boolean(runId),
    refetchInterval: node.status === "running" ? 2500 : false,
  })
  const outputFiles = outputFilePaths(node.outputs)
  const finalText =
    typeof outputQuery.data?.node_output?.text === "string"
      ? outputQuery.data.node_output.text
      : outputQuery.data?.last_message ?? ""

  useEffect(() => {
    setNodeEvents([])
    const socket = new WebSocket(api.workflowNodeStreamUrl(workflow, node.id))
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as WorkflowEvent
      setNodeEvents((current) => [...current, event].slice(-180))
      if (runId && ["node", "run"].includes(event.event_type)) {
        queryClient.invalidateQueries({ queryKey: ["run-output", workflow.workspace, runId] })
      }
    }
    return () => socket.close()
  }, [node.id, queryClient, runId, workflow.id, workflow.workspace])

  return (
    <div className="node-result-panel">
      <div className="node-section-title">
        <Activity size={14} />
        Result
      </div>
      <div className="node-result-grid">
        <span>
          Status
          <b className={statusClass(node.status)}>{node.status}</b>
        </span>
        <span>
          Run
          <b>{runId || "not started"}</b>
        </span>
        {node.usage && (
          <>
            <span>
              Input
              <b>{node.usage.input_tokens.toLocaleString()} tok</b>
            </span>
            <span>
              Output
              <b>{node.usage.output_tokens.toLocaleString()} tok</b>
            </span>
            {typeof node.usage.cost_usd === "number" && (
              <span>
                Cost
                <b>${node.usage.cost_usd.toFixed(4)}</b>
              </span>
            )}
          </>
        )}
      </div>
      {outputFiles.length > 0 && (
        <div className="node-output-list">
          {outputFiles.map((path) => (
            <a href={api.artifactUrlForPath(workflow.workspace, path)} key={path} rel="noreferrer" target="_blank">
              <FileText size={13} />
              {path}
            </a>
          ))}
        </div>
      )}
      {node.error && <p className="error-text">{node.error}</p>}
      {runId ? (
        <div className="node-result-output">
          {outputQuery.isLoading && <p className="muted">Loading final output...</p>}
          {outputQuery.error && <p className="error-text">{outputQuery.error.message}</p>}
          {finalText ? <pre>{finalText}</pre> : <p className="node-empty-result">No final output has been written yet.</p>}
        </div>
      ) : (
        <p className="node-empty-result">
          {node.type === "human_gate"
            ? "This Gate records approval state and does not launch a separate run."
            : `This ${nodeKindLabel(node)} has not run yet.`}
        </p>
      )}
      {nodeEvents.length > 0 && (
        <div className="node-event-log" ref={nodeEventLogRef}>
          {nodeEvents.slice(-60).map((event, index) => (
            <div className={`term-line term-${event.event_type}`} key={`${event.timestamp}-${index}`}>
              <span>{event.timestamp.slice(11, 19)}</span>
              <b>{event.event_type}</b>
              <p>{event.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OrchestratorPage({ workspace }: { workspace: string }) {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState("")
  const [draft, setDraft] = useState<WorkflowRecord | null>(null)
  const [dirty, setDirty] = useState(false)
  const [isDraggingNode, setIsDraggingNode] = useState(false)
  const [goal, setGoal] = useState("")
  const [title, setTitle] = useState("")
  const [template, setTemplate] = useState<(typeof workflowTemplateOptions)[number]["value"]>("paper_introduction")
  const [selectedNodeId, setSelectedNodeId] = useState("")
  const [selectedEdgeId, setSelectedEdgeId] = useState("")
  const [teamDialogOpen, setTeamDialogOpen] = useState(false)
  const [selectedTeamId, setSelectedTeamId] = useState("")
  const [teamPrefix, setTeamPrefix] = useState("")
  const [events, setEvents] = useState<WorkflowEvent[]>([])
  const workflowLogRef = useAutoScrollToEnd<HTMLDivElement>([events.length, selectedId])
  const [canvasNodes, setCanvasNodes] = useState<Node[]>([])
  const workflows = useQuery({
    queryKey: ["workflows", workspace],
    queryFn: () => api.workflows(workspace),
    enabled: Boolean(workspace),
    refetchInterval: dirty || isDraggingNode ? false : 3000,
  })
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills })
  const agentConfigs = useQuery({
    queryKey: ["agent-configs", workspace],
    queryFn: () => api.agentConfigs(workspace),
    enabled: Boolean(workspace),
  })
  const teamConfigs = useQuery({
    queryKey: ["team-configs", workspace],
    queryFn: () => api.teamConfigs(workspace),
    enabled: Boolean(workspace),
  })
  const selected = (workflows.data ?? []).find((workflow) => workflow.id === selectedId) ?? workflows.data?.[0]

  useEffect(() => {
    if (!selectedId && workflows.data?.[0]) setSelectedId(workflows.data[0].id)
  }, [selectedId, workflows.data])

  useEffect(() => {
    if (!selectedTeamId && teamConfigs.data?.[0]) setSelectedTeamId(teamConfigs.data[0].id)
  }, [selectedTeamId, teamConfigs.data])

  useEffect(() => {
    if (!selected) return
    setDraft((current) => {
      if (dirty && current?.id === selected.id) return current
      return cloneWorkflow(selected)
    })
    if (!dirty) {
      setSelectedNodeId(selected.graph_json.nodes[0]?.id ?? "")
    }
  }, [dirty, selected?.id, selected?.updated_at])

  useEffect(() => {
    setEvents([])
    if (!selected) return
    const socket = new WebSocket(api.workflowStreamUrl(selected))
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as WorkflowEvent
      setEvents((current) => [...current, event].slice(-800))
      if (["workflow", "node"].includes(event.event_type)) {
        queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      }
    }
    return () => socket.close()
  }, [queryClient, selected?.id, selected?.workspace, workspace])

  const createWorkflow = useMutation({
    mutationFn: api.createWorkflow,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setSelectedId(workflow.id)
      setDraft(cloneWorkflow(workflow))
      setDirty(false)
    },
  })
  const generateWorkflow = useMutation({
    mutationFn: api.generateWorkflow,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setSelectedId(workflow.id)
      setDraft(cloneWorkflow(workflow))
      setDirty(false)
    },
  })
  const refineWorkflow = useMutation({
    mutationFn: ({ workflow, instructions, title }: { workflow: WorkflowRecord; instructions: string; title?: string }) =>
      api.refineWorkflow(workflow, {
        instructions,
        title: title || null,
        graph_json: workflow.graph_json,
      }),
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setSelectedId(workflow.id)
      setDraft(cloneWorkflow(workflow))
      setSelectedNodeId(workflow.graph_json.nodes[0]?.id ?? "")
      setDirty(false)
    },
  })
  const saveWorkflow = useMutation({
    mutationFn: api.updateWorkflow,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
      setDirty(false)
    },
  })
  const deleteWorkflow = useMutation({
    mutationFn: api.deleteWorkflow,
    onSuccess: (_result, workflow) => {
      queryClient.setQueryData<WorkflowRecord[]>(["workflows", workspace], (current) =>
        (current ?? []).filter((item) => item.id !== workflow.id),
      )
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setSelectedId((current) => (current === workflow.id ? "" : current))
      setDraft((current) => (current?.id === workflow.id ? null : current))
      setDirty(false)
      setSelectedNodeId("")
      setSelectedEdgeId("")
      setEvents([])
    },
  })
  const executeWorkflow = useMutation({
    mutationFn: api.executeWorkflow,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
      setDirty(false)
    },
  })
  const pauseWorkflow = useMutation({
    mutationFn: api.pauseWorkflow,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
    },
  })
  const resumeWorkflow = useMutation({
    mutationFn: api.resumeWorkflow,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
    },
  })
  const cancelWorkflow = useMutation({
    mutationFn: api.cancelWorkflow,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
    },
  })
  const approveNode = useMutation({
    mutationFn: ({ workflow, nodeId }: { workflow: WorkflowRecord; nodeId: string }) =>
      api.approveWorkflowNode(workflow, nodeId),
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
    },
  })
  const approveBatch = useMutation({
    mutationFn: api.approveWorkflowBatch,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
    },
  })
  const skipNode = useMutation({
    mutationFn: ({ workflow, nodeId }: { workflow: WorkflowRecord; nodeId: string }) =>
      api.skipWorkflowNode(workflow, nodeId),
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
    },
  })
  const rerunNode = useMutation({
    mutationFn: ({ workflow, nodeId }: { workflow: WorkflowRecord; nodeId: string }) =>
      api.rerunWorkflowNode(workflow, nodeId, true),
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
    },
  })
  const expandTeam = useMutation({
    mutationFn: ({ workflow, team, prefix }: { workflow: WorkflowRecord; team: TeamConfig; prefix: string }) =>
      api.expandWorkflowTeam(workflow, {
        team_id: team.id,
        prefix,
        position: selectedNode?.position
          ? { x: selectedNode.position.x + 280, y: selectedNode.position.y }
          : { x: 120, y: 140 },
        depends_on: selectedNodeId ? [selectedNodeId] : [],
        connect_to: [],
      }),
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
      setSelectedId(workflow.id)
      setDirty(false)
      setTeamDialogOpen(false)
      setTeamPrefix("")
    },
  })

  function updateDraft(updater: (workflow: WorkflowRecord) => void) {
    setDraft((current) => {
      if (!current) return current
      const next = cloneWorkflow(current)
      updater(next)
      setDirty(true)
      return next
    })
  }

  function updateNode(nodeId: string, updater: (node: WorkflowNodeInfo) => void) {
    updateDraft((workflow) => {
      const node = workflow.graph_json.nodes.find((item) => item.id === nodeId)
      if (!node) return
      updater(node)
      workflow.graph_json.edges = workflow.graph_json.nodes.flatMap((item) =>
        item.depends_on.map((source) => ({ id: `${source}->${item.id}`, source, target: item.id })),
      )
    })
  }

  function removeEdges(edgeIds: string[]) {
    if (!edgeIds.length) return
    updateDraft((workflow) => {
      const removed = new Set(edgeIds)
      const removedEdges = workflow.graph_json.edges.filter((edge) => removed.has(edge.id))
      workflow.graph_json.edges = workflow.graph_json.edges.filter((edge) => !removed.has(edge.id))
      for (const edge of removedEdges) {
        const target = workflow.graph_json.nodes.find((node) => node.id === edge.target)
        if (target) {
          target.depends_on = target.depends_on.filter((source) => source !== edge.source)
        }
      }
    })
    setSelectedEdgeId("")
  }

  function addNode(type: WorkflowNodeInfo["type"]) {
    updateDraft((workflow) => {
      const index = workflow.graph_json.nodes.length + 1
      const id = slug(`${type === "human_gate" ? "gate" : type === "sub_agent" ? "sub-agent" : "agent"}-${index}`)
      workflow.graph_json.nodes.push({
        id,
        type,
        name: type === "human_gate" ? `Gate ${index}` : type === "sub_agent" ? `SubAgent ${index}` : `Agent ${index}`,
        role: type === "human_gate" ? "human approval" : type === "sub_agent" ? "executor" : "planner",
        skill: null,
        config_file: null,
        prompt: type === "human_gate" ? "Review the upstream output and approve when it is ready for downstream work." : "",
        model: null,
        effort: null,
        gate: "none",
        depends_on: [],
        inputs: [],
        outputs: [],
        status: "queued",
        run_id: null,
        error: null,
        approved_before: false,
        approved_after: false,
        position: { x: 120 + workflow.graph_json.nodes.length * 220, y: type === "human_gate" ? 90 : type === "agent" ? 170 : 260 },
        timeout_seconds: null,
        retry: null,
        failure_policy: "halt",
        concurrency_class: "default",
        fanout: null,
        fanout_parent_id: null,
        fanout_item: null,
      })
      setSelectedNodeId(id)
      setSelectedEdgeId("")
    })
  }

  function removeNode(nodeId: string) {
    updateDraft((workflow) => {
      workflow.graph_json.nodes = workflow.graph_json.nodes
        .filter((node) => node.id !== nodeId)
        .map((node) => ({ ...node, depends_on: node.depends_on.filter((dep) => dep !== nodeId) }))
      workflow.graph_json.edges = workflow.graph_json.edges.filter(
        (edge) => edge.source !== nodeId && edge.target !== nodeId,
      )
      setSelectedNodeId(workflow.graph_json.nodes[0]?.id ?? "")
    })
  }

  function organizeWorkflow() {
    updateDraft((workflow) => {
      organizeWorkflowPositions(workflow)
    })
  }

  const selectedNode = draft?.graph_json.nodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedEdge = draft?.graph_json.edges.find((edge) => edge.id === selectedEdgeId) ?? null
  const selectedNodeConfig =
    selectedNode?.type === "sub_agent" ? findAgentConfig(agentConfigs.data, selectedNode?.config_file) : null
  const selectedTeam = (teamConfigs.data ?? []).find((team) => team.id === selectedTeamId) ?? teamConfigs.data?.[0] ?? null
  const draftCounts = draft
    ? workflowCounts(draft)
    : { agents: 0, subAgents: 0, gates: 0, specialists: 0 }
  const waitingBatchCount =
    draft?.graph_json.nodes.filter(
      (node) => isExecutableNode(node) && node.status === "waiting_approval" && Boolean(node.run_id) && !node.approved_after,
    ).length ?? 0
  const nodeSequence = useMemo(() => workflowNodeSequence(draft), [draft])
  const draftFlowNodes: Node[] = useMemo(
    () =>
      (draft?.graph_json.nodes ?? []).map((node) => {
        const agentConfig = findAgentConfig(agentConfigs.data, node.config_file)
        const inheritedSkill = node.skill ?? agentConfig?.skill ?? null
        const skillLabel =
          node.type === "sub_agent" ? (inheritedSkill ? `/${inheritedSkill}` : "ad-hoc") : null
        const roleLabel = agentConfig
          ? agentConfig.name
          : node.role || (node.type === "human_gate" ? "human approval" : node.type === "sub_agent" ? "executor" : "planner")
        const roleAccent = agentConfig ? roleColor(agentConfig.id) : null
        const teamAccent = node.team_instance_id ? roleColor(node.team_instance_id) : null
        const accent = roleAccent ?? teamAccent
        const style: React.CSSProperties | undefined = accent
          ? { borderLeft: `4px solid ${accent}` }
          : undefined
        const sequence = nodeSequence.get(node.id) ?? 0
        return {
          id: node.id,
          position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
          data: {
            label: (
              <div className="flow-node-label">
                <div className="flow-node-topline">
                  <span className="flow-node-kind-row">
                    <span className="flow-node-order">{String(sequence).padStart(2, "0")}</span>
                    <span className={`node-kind node-kind-${node.type}`}>
                      {node.type === "human_gate" ? <ClipboardCheck size={13} /> : node.type === "sub_agent" ? <Bot size={13} /> : <Cpu size={13} />}
                      {nodeKindLabel(node)}
                    </span>
                  </span>
                  <em className={statusClass(node.status)}>{node.status}</em>
                </div>
                <strong>{node.name}</strong>
                {node.type === "sub_agent" && agentConfig ? (
                  <span
                    className="role-chip"
                    style={{
                      background: `${roleAccent}22`,
                      color: roleAccent ?? undefined,
                    }}
                  >
                    <Sparkles size={11} />
                    {roleLabel}
                  </span>
                ) : node.team_id ? (
                  <span
                    className="role-chip"
                    style={{
                      background: `${teamAccent}22`,
                      color: teamAccent ?? undefined,
                    }}
                  >
                    <UsersRound size={11} />
                    {node.team_id}
                  </span>
                ) : (
                  <span>{roleLabel}</span>
                )}
                {skillLabel && <small>{skillLabel}</small>}
              </div>
            ),
          },
          className: `flow-node flow-node-${node.type} flow-node-${node.status}`,
          style,
        }
      }),
    [draft, agentConfigs.data, nodeSequence],
  )
  useEffect(() => {
    if (!isDraggingNode) {
      setCanvasNodes(draftFlowNodes)
    }
  }, [draftFlowNodes, isDraggingNode])

  const flowEdges: Edge[] = useMemo(
    () =>
      (draft?.graph_json.edges ?? []).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        markerEnd: { type: MarkerType.ArrowClosed },
        selected: edge.id === selectedEdgeId,
        className: edge.id === selectedEdgeId ? "flow-edge-selected" : undefined,
      })),
    [draft, selectedEdgeId],
  )
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const removeChanges = changes.filter((change) => change.type === "remove")
    setCanvasNodes((nodes) => applyNodeChanges(changes, nodes))
    if (!removeChanges.length) return

    setDraft((current) => {
      if (!current) return current
      const next = cloneWorkflow(current)
      const removed = new Set(removeChanges.map((change) => change.id))
      next.graph_json.nodes = next.graph_json.nodes
        .filter((node) => !removed.has(node.id))
        .map((node) => ({ ...node, depends_on: node.depends_on.filter((dep) => !removed.has(dep)) }))
      next.graph_json.edges = next.graph_json.edges.filter(
        (edge) => !removed.has(edge.source) && !removed.has(edge.target),
      )
      return next
    })
    setDirty(true)
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = changes.filter((change) => change.type === "remove").map((change) => change.id)
    if (removed.length) removeEdges(removed)
  }, [])
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return
    const edgeId = `${connection.source}->${connection.target}`
    updateDraft((workflow) => {
      const target = workflow.graph_json.nodes.find((node) => node.id === connection.target)
      if (!target || target.depends_on.includes(connection.source!)) return
      target.depends_on.push(connection.source!)
      workflow.graph_json.edges.push({
        id: edgeId,
        source: connection.source,
        target: connection.target,
      })
    })
    setSelectedEdgeId(edgeId)
    setSelectedNodeId("")
  }, [])

  function handleCreateTemplate() {
    createWorkflow.mutate({
      workspace,
      title: title || (template === "paper_introduction" ? "Paper introduction workflow" : "Research workflow"),
      goal: goal || (template === "paper_introduction" ? "Draft and refine the Introduction for the current research paper" : "Explore and validate a research idea"),
      template,
    })
  }

  function handleGenerate() {
    generateWorkflow.mutate({
      workspace,
      title: title || undefined,
      goal: goal || "Explore and validate a research idea",
    })
  }

  function handleRefine() {
    if (!draft) return
    const instructions = goal.trim()
    if (!instructions) return
    refineWorkflow.mutate({
      workflow: draft,
      instructions,
      title: title || undefined,
    })
  }

  function handleDeleteWorkflow() {
    if (!draft) return
    if (!globalThis.confirm(`Delete Flow "${draft.title}"? This cannot be undone.`)) return
    deleteWorkflow.mutate(draft)
  }

  function openTeamDialog() {
    if (!draft) return
    const team = selectedTeam ?? teamConfigs.data?.[0]
    if (team && !selectedTeamId) setSelectedTeamId(team.id)
    setTeamPrefix(team ? uniqueTeamPrefix(team.id, draft.graph_json.nodes) : "")
    setTeamDialogOpen(true)
  }

  function handleInsertTeam() {
    if (!draft || !selectedTeam) return
    const prefix = teamPrefix.trim() || uniqueTeamPrefix(selectedTeam.id, draft.graph_json.nodes)
    expandTeam.mutate({ workflow: draft, team: selectedTeam, prefix })
  }

  return (
    <div className="orchestrator-grid workflow-layout">
      <aside className="orchestrator-left panel">
        <div className="panel-head compact-head">
          <div>
            <h2>Flows</h2>
            <p>{(workflows.data ?? []).length} local workflows</p>
          </div>
          <Button variant="secondary" onClick={() => workflows.refetch()} type="button" aria-label="Refresh flows" title="Refresh flows">
            <RefreshCcw size={15} />
          </Button>
        </div>
        <div className="workflow-list">
          {(workflows.data ?? []).map((workflow) => {
            const counts = workflowCounts(workflow)
            return (
              <button
                className={`workflow-row ${draft?.id === workflow.id ? "selected" : ""}`}
                key={workflow.id}
                onClick={() => {
                  setSelectedId(workflow.id)
                  setDirty(false)
                }}
                type="button"
              >
                <div className="workflow-row-title">
                  <strong>{workflow.title}</strong>
                  <Badge>Flow</Badge>
                </div>
                <span>
                  {counts.agents} Agents · {counts.subAgents} SubAgents · {counts.gates} Gates
                </span>
                <em className={statusClass(workflow.status)}>{workflow.status}</em>
              </button>
            )
          })}
          {workflows.data?.length === 0 && (
            <div className="list-empty">
              <GitBranch size={18} />
              <span>No flows yet</span>
            </div>
          )}
        </div>
        <div className="generator-box">
          <div className="form-section-title">
            <Sparkles size={14} />
            Create / Update Flow
          </div>
          <label>Flow goal</label>
          <Textarea
            rows={5}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Describe a new flow, or changes to apply to the selected flow..."
          />
          <label>Title</label>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional title" />
          <label>Template</label>
          <Select
            value={template}
            onChange={(event) => setTemplate(event.target.value as (typeof workflowTemplateOptions)[number]["value"])}
          >
            {workflowTemplateOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
          <div className="generator-actions">
            <Button
              variant="secondary"
              onClick={handleCreateTemplate}
              disabled={!workspace || createWorkflow.isPending || refineWorkflow.isPending}
              type="button"
            >
              <GitBranch size={15} />
              Use Template
            </Button>
            <Button
              onClick={handleGenerate}
              disabled={!workspace || generateWorkflow.isPending || refineWorkflow.isPending}
              type="button"
            >
              <Wand2 size={15} />
              Generate New
            </Button>
            <Button
              onClick={handleRefine}
              disabled={!workspace || !draft || draft.status === "running" || !goal.trim() || refineWorkflow.isPending}
              type="button"
            >
              <Wand2 size={15} />
              Update Flow
            </Button>
          </div>
          {(createWorkflow.error || generateWorkflow.error || refineWorkflow.error) && (
            <p className="error-text">{(createWorkflow.error || generateWorkflow.error || refineWorkflow.error)?.message}</p>
          )}
        </div>
      </aside>

      <section className="orchestrator-main panel">
        {draft ? (
          <>
            <div className="orchestrator-toolbar">
              <div>
                <div className="flow-title-row">
                  <Badge>
                    <GitBranch size={13} />
                    Flow
                  </Badge>
                  <span>{draftCounts.agents} Agents</span>
                  <span>{draftCounts.subAgents} SubAgents</span>
                  <span>{draftCounts.specialists} Specialists</span>
                  <span>{draftCounts.gates} Gates</span>
                  {dirty && <Badge>unsaved</Badge>}
                  <span className={statusClass(draft.status)}>{draft.status}</span>
                </div>
                <h1>{draft.title}</h1>
                <p>{draft.goal || "No goal set"}</p>
              </div>
            </div>
            {deleteWorkflow.error && <p className="error-text">{deleteWorkflow.error.message}</p>}
            <div className="flow-shell">
              <div className="flow-canvas-toolbar" aria-label="Flow canvas actions">
                <div className="canvas-actions-group">
                  <Button variant="secondary" onClick={() => addNode("agent")} type="button">
                    <Cpu size={15} />
                    Agent
                  </Button>
                  <Button variant="secondary" onClick={() => addNode("sub_agent")} type="button">
                    <Plus size={15} />
                    SubAgent
                  </Button>
                  <Button variant="secondary" onClick={() => addNode("human_gate")} type="button">
                    <ClipboardCheck size={15} />
                    Gate
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={openTeamDialog}
                    disabled={!teamConfigs.data?.length}
                    type="button"
                    title={teamConfigs.data?.length ? "Insert Team" : "Create a Team on the SubAgents page first"}
                  >
                    <UsersRound size={15} />
                    Team
                  </Button>
                  {selectedEdge && (
                    <Button variant="secondary" onClick={() => removeEdges([selectedEdge.id])} type="button">
                      <XCircle size={15} />
                      Edge
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={organizeWorkflow}
                    disabled={!draft.graph_json.nodes.length}
                    type="button"
                    aria-label="Organize flow"
                    title="Organize flow"
                  >
                    <SlidersHorizontal size={15} />
                    Organize
                  </Button>
                </div>
                <div className="canvas-actions-group">
                  <Button
                    variant="secondary"
                    onClick={() => draft && saveWorkflow.mutate(draft)}
                    disabled={!dirty || saveWorkflow.isPending}
                    type="button"
                  >
                    <Save size={15} />
                    Save
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleDeleteWorkflow}
                    disabled={deleteWorkflow.isPending}
                    type="button"
                  >
                    <Trash2 size={15} />
                    Delete
                  </Button>
                </div>
                <div className="canvas-actions-group">
                  <Button onClick={() => executeWorkflow.mutate(draft)} disabled={executeWorkflow.isPending} type="button">
                    <Play size={15} />
                    Run
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => (draft.status === "paused" ? resumeWorkflow.mutate(draft) : pauseWorkflow.mutate(draft))}
                    disabled={pauseWorkflow.isPending || resumeWorkflow.isPending}
                    type="button"
                  >
                    {draft.status === "paused" ? <Play size={15} /> : <Pause size={15} />}
                    {draft.status === "paused" ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => approveBatch.mutate(draft)}
                    disabled={!waitingBatchCount || approveBatch.isPending}
                    type="button"
                    title={waitingBatchCount ? "Approve completed execution batch" : "No completed batch is waiting"}
                  >
                    <ClipboardCheck size={15} />
                    Approve Batch
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => cancelWorkflow.mutate(draft)}
                    disabled={cancelWorkflow.isPending}
                    type="button"
                  >
                    <Square size={15} />
                    Cancel
                  </Button>
                </div>
              </div>
              <ReactFlow
                nodes={canvasNodes}
                edges={flowEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                fitView
                deleteKeyCode={["Backspace", "Delete"]}
                elementsSelectable
                nodesConnectable
                nodesDraggable
                onlyRenderVisibleElements
                onConnect={onConnect}
                onNodeClick={(_, node) => {
                  setSelectedNodeId(node.id)
                  setSelectedEdgeId("")
                }}
                onEdgeClick={(_, edge) => {
                  setSelectedEdgeId(edge.id)
                  setSelectedNodeId("")
                }}
                onNodeDragStart={() => setIsDraggingNode(true)}
                onNodeDragStop={(_, node) => {
                  setIsDraggingNode(false)
                  updateNode(node.id, (item) => {
                    item.position = { x: node.position.x, y: node.position.y }
                  })
                }}
                onPaneClick={() => {
                  setSelectedEdgeId("")
                }}
              >
                <Background />
                <MiniMap pannable zoomable />
                <Controls />
              </ReactFlow>
            </div>
            <div className="workflow-log" ref={workflowLogRef}>
              {events.map((event, index) => (
                <div className={`term-line term-${event.event_type}`} key={`${event.timestamp}-${index}`}>
                  <span>{event.timestamp.slice(11, 19)}</span>
                  <b>{event.node_id ?? event.event_type}</b>
                  <p>{event.message}</p>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <GitBranch size={28} />
            <h1>Create or generate a research workflow</h1>
            <p>Start from a template or ask ARIS to generate a DAG from the research goal.</p>
          </div>
        )}
      </section>

      <Dialog open={teamDialogOpen} title="Insert Team" onClose={() => setTeamDialogOpen(false)}>
        <div className="dialog-body config-form">
          {teamConfigs.data?.length ? (
            <>
              <div className="two-col">
                <div>
                  <label>Team</label>
                  <Select
                    value={selectedTeam?.id ?? ""}
                    onChange={(event) => {
                      const nextTeam = teamConfigs.data?.find((team) => team.id === event.target.value)
                      setSelectedTeamId(event.target.value)
                      if (draft && nextTeam) {
                        setTeamPrefix(uniqueTeamPrefix(nextTeam.id, draft.graph_json.nodes))
                      }
                    }}
                  >
                    {(teamConfigs.data ?? []).map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name} ({team.roles.length} roles)
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label>Instance prefix</label>
                  <Input
                    value={teamPrefix}
                    onChange={(event) => setTeamPrefix(event.target.value)}
                    placeholder={selectedTeam ? uniqueTeamPrefix(selectedTeam.id, draft?.graph_json.nodes ?? []) : "team"}
                  />
                </div>
              </div>
              {selectedTeam && (
                <div className="role-preview">
                  <div className="role-preview-head">
                    <span className="role-pill">
                      <UsersRound size={11} />
                      {selectedTeam.name}
                    </span>
                    <small>{selectedTeam.roles.length} roles</small>
                    <small>{selectedTeam.default_edges.length} edges</small>
                  </div>
                  <p>{selectedTeam.description || "This Team will expand into editable SubAgent nodes."}</p>
                </div>
              )}
              <p className="muted">
                {selectedNode
                  ? `Entry roles will depend on "${selectedNode.id}".`
                  : "Insert without an upstream dependency, then connect edges on the canvas."}
              </p>
              {expandTeam.error && <p className="error-text">{expandTeam.error.message}</p>}
              <div className="console-actions">
                <Button variant="secondary" onClick={() => setTeamDialogOpen(false)} type="button">
                  Cancel
                </Button>
                <Button onClick={handleInsertTeam} disabled={!draft || !selectedTeam || expandTeam.isPending} type="button">
                  <UsersRound size={15} />
                  Insert Team
                </Button>
              </div>
            </>
          ) : (
            <div className="empty-state compact-empty-state">
              <UsersRound size={24} />
              <p className="muted">Create a Team on the SubAgents page first, then insert it into this Flow.</p>
            </div>
          )}
        </div>
      </Dialog>

      <aside className="orchestrator-right side-panel">
        <h2>{selectedEdge ? "Edge Editor" : "Node Editor"}</h2>
        {draft && selectedEdge ? (
          <>
            <div className="selected-skill">
              <div className="node-editor-title">
                <span className="node-kind node-kind-edge">
                  <GitBranch size={13} />
                  Dependency
                </span>
                <strong>{selectedEdge.id}</strong>
              </div>
              <span>
                {selectedEdge.source} → {selectedEdge.target}
              </span>
            </div>
            <p className="muted">
              This edge means the target Agent, SubAgent, or Gate waits for the source node to finish.
            </p>
            <Button variant="destructive" onClick={() => removeEdges([selectedEdge.id])} type="button">
              <XCircle size={15} />
              Remove edge
            </Button>
          </>
        ) : draft && selectedNode ? (
          <>
            <div className="selected-skill">
              <div className="node-editor-title">
                <span className={`node-kind node-kind-${selectedNode.type}`}>
                  {selectedNode.type === "human_gate" ? <ClipboardCheck size={13} /> : selectedNode.type === "sub_agent" ? <Bot size={13} /> : <Cpu size={13} />}
                  {nodeKindLabel(selectedNode)}
                </span>
                <strong>{selectedNode.id}</strong>
              </div>
              <span>{selectedNode.run_id ? `run ${selectedNode.run_id}` : selectedNode.status}</span>
              {selectedNode.team_id && (
                <span>
                  team {selectedNode.team_id}
                  {selectedNode.team_role_id ? ` · ${selectedNode.team_role_id}` : ""}
                </span>
              )}
            </div>
            <NodeResultPanel workflow={draft} node={selectedNode} />
            <label>Type</label>
            <Select
              value={selectedNode.type}
              onChange={(event) =>
                updateNode(selectedNode.id, (node) => {
                  const nextType = event.target.value as WorkflowNodeInfo["type"]
                  node.type = nextType
                  if (nextType === "human_gate") {
                    node.role = node.role || "human approval"
                    node.skill = null
                    node.config_file = null
                    node.model = null
                    node.effort = null
                    node.gate = "none"
                    node.timeout_seconds = null
                    node.retry = null
                    node.failure_policy = "halt"
                    node.fanout = null
                  } else if (nextType === "agent") {
                    node.role = node.role === "human approval" || node.role === "executor" ? "planner" : node.role
                    node.skill = null
                    node.config_file = null
                    node.gate = "none"
                    node.timeout_seconds = null
                    node.retry = null
                    node.failure_policy = "halt"
                    node.fanout = null
                  } else if (node.role === "human approval" || node.role === "planner") {
                    node.role = "executor"
                  }
                })
              }
            >
              <option value="agent">Agent</option>
              <option value="sub_agent">SubAgent</option>
              <option value="human_gate">Gate</option>
            </Select>
            <label>Name</label>
            <Input value={selectedNode.name} onChange={(event) => updateNode(selectedNode.id, (node) => (node.name = event.target.value))} />
            <label>Role</label>
            <Input value={selectedNode.role} onChange={(event) => updateNode(selectedNode.id, (node) => (node.role = event.target.value))} />
            {selectedNode.type === "sub_agent" && (
              <>
                <label>
                  SubAgent Profile
                  <small className="inline-hint"> independent executor profile</small>
                </label>
                <Select
                  value={selectedNode.config_file ?? ""}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) => {
                      node.config_file = event.target.value || null
                    })
                  }
                >
                  <option value="">Generic SubAgent (no profile)</option>
                  {(agentConfigs.data ?? []).map((config) => (
                    <option key={config.id} value={config.path}>
                      {config.name}
                      {config.role ? ` - ${config.role}` : ""}
                    </option>
                  ))}
                </Select>
                {selectedNodeConfig && (
                  <div className="role-preview">
                    <div className="role-preview-head">
                      <span
                        className="role-pill"
                        style={{
                          background: `${roleColor(selectedNodeConfig.id)}22`,
                          color: roleColor(selectedNodeConfig.id),
                        }}
                      >
                        <Sparkles size={11} />
                        {selectedNodeConfig.name}
                      </span>
                      {selectedNodeConfig.skill && <small>/{selectedNodeConfig.skill}</small>}
                      {selectedNodeConfig.model && <small>model: {selectedNodeConfig.model}</small>}
                      {selectedNodeConfig.effort && <small>effort: {selectedNodeConfig.effort}</small>}
                    </div>
                    {selectedNodeConfig.system_prompt ? (
                      <p>{truncate(selectedNodeConfig.system_prompt, 180)}</p>
                    ) : selectedNodeConfig.role ? (
                      <p className="muted">{selectedNodeConfig.role}</p>
                    ) : null}
                  </div>
                )}
                <label>
                  Skill
                  {selectedNodeConfig?.skill && !selectedNode.skill && (
                    <small className="inline-hint"> profile default /{selectedNodeConfig.skill}</small>
                  )}
                </label>
                <Select
                  value={selectedNode.skill ?? ""}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) => {
                      node.skill = event.target.value || null
                    })
                  }
                >
                  <option value="">
                    {selectedNodeConfig?.skill
                      ? `Use profile default (/${selectedNodeConfig.skill})`
                      : "Ad-hoc SubAgent"}
                  </option>
                  {(skills.data ?? []).map((skill) => (
                    <option key={skill.id} value={skill.id}>
                      /{skill.id}
                    </option>
                  ))}
                </Select>
              </>
            )}
            <label>{selectedNode.type === "human_gate" ? "Gate instructions" : "Prompt"}</label>
            <Textarea
              rows={selectedNode.type === "human_gate" ? 5 : 8}
              value={selectedNode.prompt}
              onChange={(event) => updateNode(selectedNode.id, (node) => (node.prompt = event.target.value))}
            />
            {selectedNode.type === "sub_agent" && (
              <>
                <label>Gate</label>
                <Select
                  value={selectedNode.gate}
                  onChange={(event) => updateNode(selectedNode.id, (node) => (node.gate = event.target.value as WorkflowGate))}
                >
                  <option value="none">none</option>
                  <option value="before">before</option>
                  <option value="after">after</option>
                  <option value="both">both</option>
                </Select>
              </>
            )}
            <label>Depends on</label>
            <Input
              value={joinList(selectedNode.depends_on)}
              onChange={(event) => updateNode(selectedNode.id, (node) => (node.depends_on = splitList(event.target.value)))}
              placeholder="planner, literature"
            />
            {isExecutableNode(selectedNode) && (
              <details className="advanced-node-settings">
                <summary>
                  <SlidersHorizontal size={14} />
                  Advanced node settings
                </summary>
                <div className="two-col">
                  <div>
                    <label>Model</label>
                    <Input
                      value={selectedNode.model ?? ""}
                      onChange={(event) =>
                        updateNode(selectedNode.id, (node) => {
                          node.model = event.target.value || null
                        })
                      }
                      placeholder={
                        selectedNodeConfig?.model ? `Profile default: ${selectedNodeConfig.model}` : "Default"
                      }
                    />
                  </div>
                  <div>
                    <label>Effort</label>
                    <Input
                      value={selectedNode.effort ?? ""}
                      onChange={(event) =>
                        updateNode(selectedNode.id, (node) => {
                          node.effort = event.target.value || null
                        })
                      }
                      placeholder={
                        selectedNodeConfig?.effort ? `Profile default: ${selectedNodeConfig.effort}` : "Default"
                      }
                    />
                  </div>
                </div>
                {selectedNode.type === "sub_agent" && (
                  <>
                    <div className="two-col">
                      <div>
                        <label>Timeout seconds</label>
                        <Input
                          value={selectedNode.timeout_seconds ?? ""}
                          onChange={(event) =>
                            updateNode(selectedNode.id, (node) => {
                              const value = event.target.value.trim()
                              node.timeout_seconds = value ? Number(value) : null
                            })
                          }
                          placeholder={selectedNodeConfig?.timeout_seconds ? `Profile default: ${selectedNodeConfig.timeout_seconds}` : "Default"}
                        />
                      </div>
                      <div>
                        <label>Failure policy</label>
                        <Select
                          value={selectedNode.failure_policy ?? "halt"}
                          onChange={(event) =>
                            updateNode(selectedNode.id, (node) => {
                              node.failure_policy = event.target.value as WorkflowNodeInfo["failure_policy"]
                            })
                          }
                        >
                          <option value="halt">halt</option>
                          <option value="skip_descendants">skip descendants</option>
                          <option value="continue">continue</option>
                        </Select>
                      </div>
                    </div>
                    <div className="two-col">
                      <div>
                        <label>Retry attempts</label>
                        <Input
                          value={selectedNode.retry?.max_attempts ?? ""}
                          onChange={(event) =>
                            updateNode(selectedNode.id, (node) => {
                              const value = event.target.value.trim()
                              node.retry = value
                                ? {
                                    max_attempts: Number(value),
                                    backoff_seconds: node.retry?.backoff_seconds ?? 0,
                                    on: node.retry?.on ?? [],
                                  }
                                : null
                            })
                          }
                          placeholder="1"
                        />
                      </div>
                      <div>
                        <label>Retry backoff seconds</label>
                        <Input
                          value={selectedNode.retry?.backoff_seconds ?? ""}
                          onChange={(event) =>
                            updateNode(selectedNode.id, (node) => {
                              const value = event.target.value.trim()
                              node.retry = {
                                max_attempts: node.retry?.max_attempts ?? 2,
                                backoff_seconds: value ? Number(value) : 0,
                                on: node.retry?.on ?? [],
                              }
                            })
                          }
                          placeholder="0"
                        />
                      </div>
                    </div>
                    <label>Retry on</label>
                    <Input
                      value={joinList(selectedNode.retry?.on ?? [])}
                      onChange={(event) =>
                        updateNode(selectedNode.id, (node) => {
                          const on = splitList(event.target.value)
                          node.retry = on.length || node.retry
                            ? {
                                max_attempts: node.retry?.max_attempts ?? 2,
                                backoff_seconds: node.retry?.backoff_seconds ?? 0,
                                on,
                              }
                            : null
                        })
                      }
                      placeholder="timeout, rate limit"
                    />
                    <div className="fanout-config">
                      <label>Dynamic fan-out</label>
                      <Select
                        value={selectedNode.fanout ? "on" : "off"}
                        onChange={(event) =>
                          updateNode(selectedNode.id, (node) => {
                            node.fanout =
                              event.target.value === "on"
                                ? {
                                    source: node.fanout?.source ?? node.depends_on[0] ?? null,
                                    path: node.fanout?.path ?? "keyword_groups",
                                    name_template: node.fanout?.name_template ?? "Literature search: {{item.name}}",
                                    max_items: node.fanout?.max_items ?? 12,
                                    empty_policy: node.fanout?.empty_policy ?? "fail",
                                  }
                                : null
                          })
                        }
                      >
                        <option value="off">off</option>
                        <option value="on">expand from upstream JSON</option>
                      </Select>
                      {selectedNode.fanout && (
                        <>
                          <div className="two-col">
                            <div>
                              <label>Source node</label>
                              <Select
                                value={selectedNode.fanout.source ?? ""}
                                onChange={(event) =>
                                  updateNode(selectedNode.id, (node) => {
                                    if (!node.fanout) return
                                    node.fanout.source = event.target.value || null
                                  })
                                }
                              >
                                <option value="">First dependency</option>
                                {draft.graph_json.nodes
                                  .filter((node) => node.id !== selectedNode.id)
                                  .map((node) => (
                                    <option key={node.id} value={node.id}>
                                      {node.id}
                                    </option>
                                  ))}
                              </Select>
                            </div>
                            <div>
                              <label>JSON path</label>
                              <Input
                                value={selectedNode.fanout.path}
                                onChange={(event) =>
                                  updateNode(selectedNode.id, (node) => {
                                    if (!node.fanout) return
                                    node.fanout.path = event.target.value
                                  })
                                }
                                placeholder="keyword_groups"
                              />
                            </div>
                          </div>
                          <label>Name template</label>
                          <Input
                            value={selectedNode.fanout.name_template}
                            onChange={(event) =>
                              updateNode(selectedNode.id, (node) => {
                                if (!node.fanout) return
                                node.fanout.name_template = event.target.value
                              })
                            }
                            placeholder="Literature search: {{item.name}}"
                          />
                          <div className="two-col">
                            <div>
                              <label>Max items</label>
                              <Input
                                value={selectedNode.fanout.max_items}
                                onChange={(event) =>
                                  updateNode(selectedNode.id, (node) => {
                                    if (!node.fanout) return
                                    const value = Number(event.target.value)
                                    node.fanout.max_items = Number.isFinite(value) ? value : 12
                                  })
                                }
                                type="number"
                                min={1}
                              />
                            </div>
                            <div>
                              <label>Empty result</label>
                              <Select
                                value={selectedNode.fanout.empty_policy ?? "fail"}
                                onChange={(event) =>
                                  updateNode(selectedNode.id, (node) => {
                                    if (!node.fanout) return
                                    node.fanout.empty_policy = event.target.value as "fail" | "succeed"
                                  })
                                }
                              >
                                <option value="fail">fail node</option>
                                <option value="succeed">succeed with none</option>
                              </Select>
                            </div>
                          </div>
                          <p className="muted small">
                            Prompt placeholders: {"{{item.name}}"}, {"{{item.keywords}}"}, {"{{item}}"}, {"{{number}}"}.
                          </p>
                        </>
                      )}
                      {selectedNode.fanout_parent_id && (
                        <div className="fanout-preview">
                          <strong>Generated from {selectedNode.fanout_parent_id}</strong>
                          <pre>{jsonPreview(selectedNode.fanout_item)}</pre>
                        </div>
                      )}
                    </div>
                  </>
                )}
                <label>Inputs</label>
                <Input
                  value={joinList(selectedNode.inputs)}
                  onChange={(event) => updateNode(selectedNode.id, (node) => (node.inputs = splitList(event.target.value)))}
                />
                <label>Outputs</label>
                <Input
                  value={joinList(selectedNode.outputs)}
                  onChange={(event) => updateNode(selectedNode.id, (node) => (node.outputs = splitList(event.target.value)))}
                />
              </details>
            )}
            {selectedNode.error && <p className="error-text">{selectedNode.error}</p>}
            <div className="node-action-grid">
              <Button
                variant="secondary"
                onClick={() => approveNode.mutate({ workflow: draft, nodeId: selectedNode.id })}
                disabled={selectedNode.status !== "waiting_approval" || approveNode.isPending}
                type="button"
              >
                <CheckCircle2 size={15} />
                Approve
              </Button>
              <Button
                variant="secondary"
                onClick={() => rerunNode.mutate({ workflow: draft, nodeId: selectedNode.id })}
                disabled={rerunNode.isPending}
                type="button"
              >
                <RefreshCcw size={15} />
                Rerun
              </Button>
              <Button
                variant="secondary"
                onClick={() => skipNode.mutate({ workflow: draft, nodeId: selectedNode.id })}
                disabled={skipNode.isPending}
                type="button"
              >
                Skip
              </Button>
              <Button variant="destructive" onClick={() => removeNode(selectedNode.id)} type="button">
                Remove
              </Button>
            </div>
          </>
        ) : (
          <p className="muted">Select a DAG node to edit it.</p>
        )}
      </aside>
    </div>
  )
}

function SkillsPage({ workspace, onRunCreated }: { workspace: string; onRunCreated: () => void }) {
  const queryClient = useQueryClient()
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills })
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<SkillInfo | null>(null)
  const [argumentsText, setArgumentsText] = useState("")
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState("balanced")
  const [assurance, setAssurance] = useState("")
  const createRun = useMutation({
    mutationFn: api.createRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] })
      onRunCreated()
    },
  })

  const filtered = (skills.data ?? []).filter((skill) => {
    const haystack = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase()
    return haystack.includes(search.toLowerCase())
  })

  useEffect(() => {
    if (!selected && filtered[0]) {
      setSelected(filtered[0])
    }
  }, [filtered, selected])

  function startRun() {
    if (!selected || !workspace) return
    createRun.mutate({
      workspace,
      skill: selected.id,
      arguments: argumentsText,
      model: model || undefined,
      effort: effort || undefined,
      assurance: assurance || undefined,
    })
  }

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h1>Skill Catalog</h1>
            <p>{filtered.length} bundled ARIS-Code skills discovered from the runtime assets.</p>
          </div>
          <div className="search-box">
            <Search size={16} />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search skills" />
          </div>
        </div>
        <div className="skill-list">
          {filtered.map((skill) => (
            <button
              className={`skill-row ${selected?.id === skill.id ? "selected" : ""}`}
              key={skill.id}
              onClick={() => {
                setSelected(skill)
                setArgumentsText(skill.argument_hint ? "" : argumentsText)
              }}
              type="button"
            >
              <div>
                <strong>/{skill.name}</strong>
                <span>{skill.description}</span>
              </div>
              <Badge>{skill.package}</Badge>
            </button>
          ))}
          {filtered.length === 0 && !skills.isLoading && (
            <div className="list-empty">
              <Search size={18} />
              <span>No skills match this search</span>
            </div>
          )}
        </div>
      </section>

      <aside className="side-panel">
        <h2>Launch Run</h2>
        {selected ? (
          <>
            <div className="selected-skill">
              <strong>/{selected.name}</strong>
              <span>{selected.argument_hint || "Free-form ARIS arguments"}</span>
            </div>
            <label>Arguments</label>
            <Textarea
              rows={8}
              value={argumentsText}
              onChange={(event) => setArgumentsText(event.target.value)}
              placeholder='Example: "factorized gap in discrete diffusion LMs" -- effort: balanced'
            />
            <label>Model override</label>
            <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Optional" />
            <div className="two-col">
              <div>
                <label>Effort</label>
                <Select value={effort} onChange={(event) => setEffort(event.target.value)}>
                  <option value="">Default</option>
                  <option value="lite">lite</option>
                  <option value="balanced">balanced</option>
                  <option value="max">max</option>
                  <option value="beast">beast</option>
                </Select>
              </div>
              <div>
                <label>Assurance</label>
                <Select value={assurance} onChange={(event) => setAssurance(event.target.value)}>
                  <option value="">Default</option>
                  <option value="draft">draft</option>
                  <option value="polished">polished</option>
                  <option value="conference-ready">conference-ready</option>
                  <option value="submission">submission</option>
                </Select>
              </div>
            </div>
            <Button onClick={startRun} disabled={!workspace || createRun.isPending} type="button">
              <Play size={16} />
              Start ARIS run
            </Button>
            {createRun.error && <p className="error-text">{createRun.error.message}</p>}
          </>
        ) : (
          <p className="muted">Select a skill to configure a run.</p>
        )}
      </aside>
    </div>
  )
}

function RunsPage({ workspace }: { workspace: string }) {
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.runs, refetchInterval: 3000 })
  const [selectedId, setSelectedId] = useState<string>("")
  const selected = (runs.data ?? []).find((run) => run.id === selectedId) ?? runs.data?.[0]

  useEffect(() => {
    if (!selectedId && runs.data?.[0]) setSelectedId(runs.data[0].id)
  }, [runs.data, selectedId])

  const visibleRuns = (runs.data ?? []).filter((run) => !workspace || run.workspace === workspace)

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h1>Runs</h1>
            <p>Live ARIS-Code execution state and replayable logs.</p>
          </div>
          <Button variant="secondary" onClick={() => runs.refetch()} type="button">
            <RefreshCcw size={16} />
            Refresh
          </Button>
        </div>
        <div className="run-list">
          {visibleRuns.map((run) => (
            <button
              className={`run-row ${selected?.id === run.id ? "selected" : ""}`}
              key={run.id}
              onClick={() => setSelectedId(run.id)}
              type="button"
            >
              <div>
                <strong>{run.skill}</strong>
                <span>{run.id} · {compactPath(run.workspace)}</span>
              </div>
              <span className={statusClass(run.status)}>{run.status}</span>
            </button>
          ))}
          {visibleRuns.length === 0 && !runs.isLoading && (
            <div className="list-empty">
              <Terminal size={18} />
              <span>No runs for this workspace yet</span>
            </div>
          )}
        </div>
      </section>
      <aside className="console-panel">
        {selected ? <RunConsole run={selected} /> : <p className="muted">No runs yet.</p>}
      </aside>
    </div>
  )
}

function RunConsole({ run }: { run: RunRecord }) {
  const queryClient = useQueryClient()
  const [events, setEvents] = useState<RunEvent[]>([])
  const terminalRef = useAutoScrollToEnd<HTMLDivElement>([events.length, run.id])
  const cancelRun = useMutation({
    mutationFn: api.cancelRun,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runs"] }),
  })

  useEffect(() => {
    setEvents([])
    const socket = new WebSocket(api.runStreamUrl(run))
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent
      setEvents((current) => [...current, event].slice(-1000))
      if (event.stream === "system" && event.payload && "status" in event.payload) {
        queryClient.invalidateQueries({ queryKey: ["runs"] })
      }
    }
    return () => socket.close()
  }, [queryClient, run.id, run.workspace])

  return (
    <div className="console-wrap">
      <div className="console-head">
        <div>
          <h2>{run.skill}</h2>
          <p>{run.id}</p>
        </div>
        <div className="console-actions">
          <span className={statusClass(run.status)}>{run.status}</span>
          <Button
            variant="destructive"
            onClick={() => cancelRun.mutate(run)}
            disabled={!["queued", "running"].includes(run.status) || cancelRun.isPending}
            type="button"
          >
            <Square size={15} />
            Cancel
          </Button>
        </div>
      </div>
      <div className="terminal" ref={terminalRef}>
        {events.map((event, index) => (
          <div className={`term-line term-${event.stream}`} key={`${event.timestamp}-${index}`}>
            <span>{event.timestamp.slice(11, 19)}</span>
            <b>{event.stream}</b>
            <p>{event.message}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function ArtifactsPage({ workspace }: { workspace: string }) {
  const queryClient = useQueryClient()
  const health = useQuery({ queryKey: ["health"], queryFn: api.health })
  const artifacts = useQuery({
    queryKey: ["artifacts", workspace],
    queryFn: () => api.artifacts(workspace),
    enabled: Boolean(workspace),
  })
  const [preview, setPreview] = useState<ArtifactInfo | null>(null)
  const renderHtml = useMutation({
    mutationFn: (artifact: ArtifactInfo) => api.renderHtml(artifact.workspace, artifact.path),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["artifacts", workspace] }),
  })
  const canRenderHtml = Boolean(health.data?.checks.find((item) => item.name === "render_html")?.available)

  return (
    <section className="panel full-panel">
      <div className="panel-head">
        <div>
          <h1>Artifacts</h1>
          <p>Workspace files that ARIS workflows commonly create or consume.</p>
        </div>
        <Button variant="secondary" onClick={() => artifacts.refetch()} type="button">
          <RefreshCcw size={16} />
          Refresh
        </Button>
      </div>
      <div className="artifact-table">
        {(artifacts.data ?? []).map((artifact) => (
          <div className="artifact-row" key={artifact.id}>
            <FileText size={17} />
            <div>
              <strong>{artifact.name}</strong>
              <span>{artifact.path}</span>
            </div>
            <Badge>{artifact.kind}</Badge>
            <span>{formatBytes(artifact.size)}</span>
            <Button variant="ghost" onClick={() => setPreview(artifact)} type="button">
              Preview
            </Button>
            <a className="btn btn-secondary" href={api.artifactUrl(artifact)} rel="noreferrer" target="_blank">
              Open
            </a>
            {canRenderHtml && ["document", "data"].includes(artifact.kind) && (
              <Button variant="secondary" onClick={() => renderHtml.mutate(artifact)} type="button">
                Render HTML
              </Button>
            )}
          </div>
        ))}
        {artifacts.data?.length === 0 && (
          <div className="list-empty artifact-empty">
            <FileText size={18} />
            <span>No artifacts found in this workspace</span>
          </div>
        )}
      </div>
      <Dialog open={Boolean(preview)} title={preview?.name ?? "Artifact"} onClose={() => setPreview(null)}>
        {preview && <ArtifactPreview artifact={preview} />}
      </Dialog>
    </section>
  )
}

function ArtifactPreview({ artifact }: { artifact: ArtifactInfo }) {
  const [text, setText] = useState("Loading...")
  useEffect(() => {
    fetch(api.artifactUrl(artifact))
      .then((response) => response.text())
      .then(setText)
      .catch((error: Error) => setText(error.message))
  }, [artifact])
  if (artifact.kind === "image") {
    return <img className="preview-image" src={api.artifactUrl(artifact)} alt={artifact.name} />
  }
  if (artifact.kind === "pdf" || artifact.kind === "html") {
    return <iframe className="preview-frame" src={api.artifactUrl(artifact)} title={artifact.name} />
  }
  return <pre className="preview-text">{text}</pre>
}

const providerOptions: { value: GlobalApiProvider; label: string; hint: string }[] = [
  { value: "anthropic", label: "Anthropic", hint: "ANTHROPIC_API_KEY" },
  { value: "openai", label: "OpenAI", hint: "EXECUTOR_API_KEY + OPENAI_API_KEY" },
  { value: "gemini", label: "Gemini", hint: "Gemini OpenAI-compatible endpoint" },
  { value: "glm", label: "GLM", hint: "GLM OpenAI-compatible endpoint" },
  { value: "minimax", label: "MiniMax", hint: "MiniMax China Anthropic-compatible endpoint" },
  { value: "kimi", label: "Kimi", hint: "Kimi OpenAI-compatible endpoint" },
  { value: "custom", label: "Custom", hint: "EXECUTOR_API_KEY with optional base URL" },
]

const apiPresets = [
  {
    id: "manual",
    label: "Manual",
    hint: "Configure provider, endpoint, model, and effort manually.",
  },
  {
    id: "yybb-openai",
    label: "YYBB / OpenAI",
    hint: "OpenAI-compatible proxy preset: https://yybb.codes, gpt-5.4, xhigh.",
    provider: "openai" as GlobalApiProvider,
    baseUrl: "https://yybb.codes",
    model: "gpt-5.4",
    effort: "xhigh",
  },
] as const

function detectApiPreset(
  provider: GlobalApiProvider,
  baseUrl: string,
  model: string,
  effort: string,
): (typeof apiPresets)[number]["id"] {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "")
  const match = apiPresets.find(
    (item) =>
      item.id !== "manual" &&
      item.provider === provider &&
      item.baseUrl === normalizedBase &&
      item.model === model.trim() &&
      item.effort === effort.trim(),
  )
  return match?.id ?? "manual"
}

function SettingsPage() {
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const [apiPreset, setApiPreset] = useState<(typeof apiPresets)[number]["id"]>("manual")
  const [provider, setProvider] = useState<GlobalApiProvider>("anthropic")
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState("")
  const updateSettings = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (item) => {
      queryClient.setQueryData(["settings"], item)
      queryClient.invalidateQueries({ queryKey: ["health"] })
      setApiKey("")
    },
  })

  useEffect(() => {
    if (!settings.data) return
    setProvider(settings.data.provider)
    setBaseUrl(settings.data.base_url ?? "")
    setModel(settings.data.model ?? "")
    setEffort(settings.data.effort ?? "")
    setApiPreset(
      detectApiPreset(
        settings.data.provider,
        settings.data.base_url ?? "",
        settings.data.model ?? "",
        settings.data.effort ?? "",
      ),
    )
  }, [settings.data])

  function applyApiPreset(presetId: (typeof apiPresets)[number]["id"]) {
    setApiPreset(presetId)
    const preset = apiPresets.find((item) => item.id === presetId)
    if (!preset || preset.id === "manual") return
    setProvider(preset.provider)
    setBaseUrl(preset.baseUrl)
    setModel(preset.model)
    setEffort(preset.effort)
  }

  function save(clearApiKey = false) {
    updateSettings.mutate({
      provider,
      api_key: apiKey || null,
      clear_api_key: clearApiKey,
      base_url: baseUrl || null,
      model: model || null,
      effort: effort || null,
    })
  }

  const selectedProvider = providerOptions.find((item) => item.value === provider)
  const selectedPreset = apiPresets.find((item) => item.id === apiPreset)

  return (
    <section className="panel full-panel">
      <div className="panel-head">
        <div>
          <h1>Global Settings</h1>
          <p>Configure the API key that every Web-launched ARIS run inherits.</p>
        </div>
        <KeyRound size={22} />
      </div>
      <div className="settings-grid">
        <Card className="settings-card">
          <div className="selected-skill">
            <strong>Executor API key</strong>
            <span>
              {settings.data?.api_key_set
                ? `${settings.data.provider} ${settings.data.api_key_masked ?? ""}`
                : "No key configured"}
            </span>
          </div>
          <label>API preset</label>
          <Select value={apiPreset} onChange={(event) => applyApiPreset(event.target.value as (typeof apiPresets)[number]["id"])}>
            {apiPresets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </Select>
          <p className="muted">{selectedPreset?.hint}</p>
          <label>Provider</label>
          <Select
            value={provider}
            onChange={(event) => {
              setApiPreset("manual")
              setProvider(event.target.value as GlobalApiProvider)
            }}
          >
            {providerOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
          <p className="muted">{selectedProvider?.hint}</p>
          <label>API key</label>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={settings.data?.api_key_set ? "Leave blank to keep existing key" : "Paste API key"}
          />
          <label>Base URL</label>
          <Input
            value={baseUrl}
            onChange={(event) => {
              setApiPreset("manual")
              setBaseUrl(event.target.value)
            }}
            placeholder="Optional, e.g. https://api.openai.com/v1"
          />
          <label>Reviewer model</label>
          <Input
            value={model}
            onChange={(event) => {
              setApiPreset("manual")
              setModel(event.target.value)
            }}
            placeholder="Optional ARIS_REVIEWER_MODEL"
          />
          <label>Reasoning effort</label>
          <Select
            value={effort}
            onChange={(event) => {
              setApiPreset("manual")
              setEffort(event.target.value)
            }}
          >
            <option value="">Default</option>
            <option value="none">none</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </Select>
          <div className="console-actions">
            <Button onClick={() => save(false)} disabled={updateSettings.isPending} type="button">
              <Save size={15} />
              Save settings
            </Button>
            <Button
              variant="destructive"
              onClick={() => save(true)}
              disabled={!settings.data?.api_key_set || updateSettings.isPending}
              type="button"
            >
              <XCircle size={15} />
              Clear key
            </Button>
          </div>
          {updateSettings.error && <p className="error-text">{updateSettings.error.message}</p>}
        </Card>

        <Card className="settings-card">
          <h2>Runtime Injection</h2>
          <p className="muted">The backend injects these variables only into child ARIS processes. The API key is never returned in API responses.</p>
          <div className="env-list">
            {(settings.data?.applies_to ?? []).map((item) => (
              <Badge key={item}>{item}</Badge>
            ))}
            {!settings.data?.applies_to?.length && <span className="muted">No runtime variables are active yet.</span>}
          </div>
          <label>Local settings file</label>
          <Input value={settings.data?.config_path ?? ""} readOnly />
          <p className="muted">This is local-only state for the single-user console.</p>
        </Card>
      </div>
    </section>
  )
}

function HealthPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 5000 })
  return (
    <section className="panel full-panel">
      <div className="panel-head">
        <div>
          <h1>Environment Health</h1>
          <p>{health.data?.repo_root ?? "Checking local ARIS repository..."}</p>
        </div>
        <Activity size={22} />
      </div>
      <div className="health-grid">
        {(health.data?.checks ?? []).map((item) => (
          <Card className="health-card" key={item.name}>
            {item.available ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}
            <div>
              <strong>{item.name}</strong>
              <span>{item.value ?? item.error ?? "Unavailable"}</span>
            </div>
          </Card>
        ))}
      </div>
    </section>
  )
}
