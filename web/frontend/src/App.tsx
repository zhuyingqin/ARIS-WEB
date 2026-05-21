import { type MouseEvent as ReactMouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  applyNodeChanges,
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
  type NodeTypes,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
  Activity,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
  GlobalProviderSettings,
  RunEvent,
  RunOutput,
  RunRecord,
  SkillInfo,
  WorkflowEvent,
  WorkflowGate,
  WorkflowHandoff,
  WorkflowNodeInfo,
  WorkflowPort,
  WorkflowRecord,
  WorkflowRuntimeResponse,
  WorkspaceInfo,
} from "./types"
import { Badge, Button, Card, Dialog, Input, Select, Tabs, Textarea } from "./components/ui"

const navItems = [
  { value: "orchestrator", label: "Orchestrator", icon: <GitBranch size={16} /> },
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

type WorkflowEventFilter = "all" | "aris" | "workflow" | "node" | "planner" | "runtime" | "errors"

const workflowEventFilterOptions: { value: WorkflowEventFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "aris", label: "ARIS" },
  { value: "workflow", label: "Flow" },
  { value: "node", label: "Nodes" },
  { value: "planner", label: "Planner" },
  { value: "runtime", label: "Runtime" },
  { value: "errors", label: "Errors" },
]

const WORKFLOW_EVENT_LIMIT = 800
const WORKFLOW_REPLAY_LIMIT = 600
const NODE_EVENT_LIMIT = 400
const NODE_REPLAY_LIMIT = 300
const EVENT_FLUSH_INTERVAL_MS = 80

function appendLimited<T>(current: T[], incoming: T[], limit: number) {
  return [...current, ...incoming].slice(-limit)
}

function isRecentEvent(timestamp: string, windowMs = 45000) {
  const eventTime = Date.parse(timestamp)
  if (!Number.isFinite(eventTime)) return true
  const ageMs = Date.now() - eventTime
  return ageMs > -5000 && ageMs < windowMs
}

function statusClass(status: string) {
  return `status status-${status}`
}

function isLiveWorkflowStatus(status?: string | null) {
  return status === "running"
}

function executionStateLabel(state?: string | null) {
  switch (state) {
    case "planning":
      return "Planner checking"
    case "running":
      return "Running"
    case "waiting_approval":
      return "Waiting approval"
    case "waiting_dynamic_dependency":
      return "Waiting literature"
    case "ready":
      return "Ready to schedule"
    case "scheduled":
      return "Scheduled"
    case "succeeded":
      return "Done"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
    case "paused":
      return "Paused"
    case "draft":
      return "Draft"
    default:
      return "Idle"
  }
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
  const [sidebarHidden, setSidebarHidden] = useState(false)
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
    <div className={`app-shell ${sidebarHidden ? "sidebar-hidden" : ""}`}>
      {!sidebarHidden && (
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="brand">
              <div className="brand-mark">A</div>
              <div>
                <strong>ARIS-Code</strong>
                <span>Research cockpit</span>
              </div>
            </div>
            <button
              aria-label="Hide sidebar"
              className="sidebar-toggle"
              onClick={() => setSidebarHidden(true)}
              title="Hide sidebar"
              type="button"
            >
              <ChevronLeft size={16} />
            </button>
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
      )}

      <main className="main">
        <div className="topbar">
          <div className="topbar-title">
            {sidebarHidden && (
              <button
                aria-label="Show sidebar"
                className="sidebar-restore"
                onClick={() => setSidebarHidden(false)}
                title="Show sidebar"
                type="button"
              >
                <ChevronRight size={15} />
                <span>Menu</span>
              </button>
            )}
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

function workflowOutputArtifactPaths(workflow: WorkflowRecord, node: WorkflowNodeInfo) {
  const base = `.aris/web/workflows/${workflow.id}/nodes/${node.id}/attempt-${(node.attempt ?? 0) + 1}`
  return outputFilePaths(node.outputs).map((path) => (path.startsWith(".aris/") ? path : `${base}/${path}`))
}

function artifactExtension(path: string) {
  return path.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? ""
}

function isMarkdownArtifact(path: string) {
  return ["md", "markdown"].includes(artifactExtension(path))
}

function isImageArtifact(path: string) {
  return ["png", "jpg", "jpeg", "webp", "svg"].includes(artifactExtension(path))
}

function isFrameArtifact(path: string) {
  return ["html", "htm", "pdf"].includes(artifactExtension(path))
}

function artifactLabel(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path
}

function artifactByPath(artifacts: ArtifactInfo[] | undefined) {
  return new Map((artifacts ?? []).map((artifact) => [artifact.path.replace(/^\.\//, ""), artifact]))
}

function artifactOutputSection(text: string) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    /输出文件|output artifact|output file|files? written|written files/i.test(line),
  )
  if (start < 0) return text
  const collected: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    if (index > start && /^(#{1,6}\s+|\*\*[^*]+\*\*:?\s*$)/.test(lines[index].trim())) break
    collected.push(lines[index])
  }
  return collected.join("\n")
}

function extractArtifactPathsFromRunOutput(output: RunOutput | undefined, artifacts: ArtifactInfo[] | undefined) {
  if (!output || !artifacts?.length) return []
  const textParts = [
    typeof output.node_output?.text === "string" ? output.node_output.text : "",
    output.last_message,
  ].filter(Boolean)
  const text = artifactOutputSection(textParts.join("\n"))
  const byPath = artifactByPath(artifacts)
  const byName = new Map<string, ArtifactInfo[]>()
  for (const artifact of artifacts) {
    const list = byName.get(artifact.name) ?? []
    list.push(artifact)
    byName.set(artifact.name, list)
  }
  const paths = new Set<string>()
  for (const artifact of artifacts) {
    if (text.includes(artifact.path)) paths.add(artifact.path)
  }
  const filePattern = /[`"'(]?(?:\.\/)?([A-Za-z0-9_.\-/]+?\.(?:md|markdown|html?|pdf|txt|jsonl?|csv|tsv|tex|bib|docx|pptx|xlsx|png|jpe?g|webp|svg))/gi
  let match: RegExpExecArray | null
  while ((match = filePattern.exec(text)) !== null) {
    const candidate = match[1].replace(/^\.\//, "").replace(/[),.;:]+$/g, "")
    if (byPath.has(candidate)) {
      paths.add(candidate)
      continue
    }
    const name = artifactLabel(candidate)
    const named = byName.get(name)
    if (named?.length === 1) paths.add(named[0].path)
  }
  return [...paths]
}

function slug(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || `node-${Date.now().toString(36)}`
}

function workflowCounts(workflow: WorkflowRecord) {
  const nodes = workflow.graph_json.nodes
  const agents = nodes.filter((node) => node.type === "agent" || node.type === "sub_agent").length
  const gates = nodes.filter((node) => node.type === "human_gate").length
  return { agents, gates }
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

function workflowEventLabel(event: WorkflowEvent) {
  if (event.event_type === "workflow") return "workflow"
  if (event.event_type === "planner") return "planner"
  if (event.event_type === "delta") return "delta"
  if (event.event_type === "session") return "session"
  if (event.event_type === "approval") return "approval"
  if (event.event_type === "node" || event.event_type === "run") return event.node_id ?? event.event_type
  if (["aris", "thinking", "tool", "result", "stdout", "stderr"].includes(event.event_type)) {
    return event.event_type === "aris" ? "aris" : `aris/${event.event_type}`
  }
  return event.event_type
}

function workflowEventTitle(event: WorkflowEvent) {
  return [
    event.event_type,
    event.node_id ? `node: ${event.node_id}` : "",
    event.run_id ? `run: ${event.run_id}` : "",
  ]
    .filter(Boolean)
    .join(" | ")
}

function eventPayloadEntries(event: WorkflowEvent) {
  const payload = event.payload ?? {}
  return Object.entries(payload).filter(([, value]) => value !== null && value !== undefined && value !== "")
}

function workflowEventMetaItems(event: WorkflowEvent): { key: string; value: string }[] {
  const payload = event.payload ?? {}
  const items: { key: string; value: string }[] = []
  if (event.node_id) items.push({ key: "node", value: event.node_id })
  if (event.run_id) items.push({ key: "run", value: event.run_id })
  for (const key of ["model", "skill", "effort", "tick_id", "trigger", "decision_type", "action", "delta_id", "status", "session_id"]) {
    const value = payload[key]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      items.push({ key, value: String(value) })
    }
  }
  const policy = payload["policy_result"]
  if (policy && typeof policy === "object" && "allowed" in policy) {
    const allowed = (policy as { allowed?: unknown }).allowed
    const reason = (policy as { reason?: unknown }).reason
    items.push({ key: "policy", value: `${allowed ? "allowed" : "rejected"}${reason ? `: ${String(reason)}` : ""}` })
  }
  return items
}

function workflowEventPayloadText(event: WorkflowEvent) {
  if (!event.payload || eventPayloadEntries(event).length === 0) return ""
  try {
    return JSON.stringify(event.payload, null, 2)
  } catch {
    return String(event.payload)
  }
}

function isArisOutputEvent(event: WorkflowEvent) {
  return ["aris", "thinking", "tool", "result", "stdout", "stderr"].includes(event.event_type)
}

function isWorkflowErrorEvent(event: WorkflowEvent) {
  return event.event_type === "stderr" || /\b(error|failed|failure|unauthorized|timeout)\b/i.test(event.message)
}

function workflowEventMatchesFilter(event: WorkflowEvent, filter: WorkflowEventFilter) {
  if (filter === "all") return true
  if (filter === "aris") return isArisOutputEvent(event)
  if (filter === "workflow") return event.event_type === "workflow"
  if (filter === "node") return event.event_type === "node" || event.event_type === "run"
  if (filter === "planner") return event.event_type === "planner"
  if (filter === "runtime") return ["delta", "session", "approval"].includes(event.event_type)
  if (filter === "errors") return isWorkflowErrorEvent(event)
  return true
}

function organizeWorkflowPositions(workflow: WorkflowRecord, expandedFanoutGroups: Set<string> = new Set()) {
  const order = workflowNodeOrder(workflow)
  const orderIndex = new Map(order.map((id, index) => [id, index]))
  const nodeMap = new Map(workflow.graph_json.nodes.map((node) => [node.id, node]))
  const stackCandidates = new Map<string, WorkflowNodeInfo[]>()

  for (const node of workflow.graph_json.nodes) {
    const key = fanoutStackKey(node)
    if (!key || expandedFanoutGroups.has(key)) continue
    stackCandidates.set(key, [...(stackCandidates.get(key) ?? []), node])
  }

  const collapsedStackKeys = new Set(
    Array.from(stackCandidates.entries())
      .filter(([, nodes]) => nodes.length >= FANOUT_STACK_MIN_SIZE)
      .map(([key]) => key),
  )
  const unitForNode = (node: WorkflowNodeInfo) => {
    const key = fanoutStackKey(node)
    return key && collapsedStackKeys.has(key) ? fanoutStackNodeId(key) : node.id
  }
  const unitMembers = new Map<string, WorkflowNodeInfo[]>()
  const nodeUnitById = new Map<string, string>()

  for (const id of order) {
    const node = nodeMap.get(id)
    if (!node) continue
    const unit = unitForNode(node)
    nodeUnitById.set(id, unit)
    unitMembers.set(unit, [...(unitMembers.get(unit) ?? []), node])
  }

  const unitOrder = Array.from(unitMembers.keys())
  const unitOrderIndex = new Map(unitOrder.map((id, index) => [id, index]))
  const depsByUnit = new Map<string, Set<string>>()

  for (const [unit, members] of unitMembers) {
    const deps = depsByUnit.get(unit) ?? new Set<string>()
    for (const node of members) {
      const rawDeps = [
        ...node.depends_on,
        ...workflow.graph_json.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source),
      ]
      for (const dep of rawDeps) {
        const depUnit = nodeUnitById.get(dep)
        if (depUnit && depUnit !== unit) deps.add(depUnit)
      }
    }
    depsByUnit.set(unit, deps)
  }

  const layerByUnit = new Map<string, number>()

  for (const id of unitOrder) {
    const deps = Array.from(depsByUnit.get(id) ?? [])
    const layer = deps.reduce((max, dep) => Math.max(max, (layerById.get(dep) ?? 0) + 1), 0)
    layerByUnit.set(id, layer)
  }

  const rowsByLayer = new Map<number, string[]>()
  for (const id of unitOrder) {
    const layer = layerByUnit.get(id) ?? 0
    rowsByLayer.set(layer, [...(rowsByLayer.get(layer) ?? []), id])
  }

  for (const ids of rowsByLayer.values()) {
    ids.sort((a, b) => (unitOrderIndex.get(a) ?? 0) - (unitOrderIndex.get(b) ?? 0))
  }

  const layerCount = Math.max(...Array.from(rowsByLayer.keys()), 0) + 1
  const maxRowsInLayer = Math.max(...Array.from(rowsByLayer.values()).map((ids) => ids.length), 1)
  const nodeCount = unitMembers.size
  const columnsPerBand = Math.min(layerCount, Math.min(5, Math.max(3, Math.ceil(Math.sqrt(nodeCount * 1.7)))))
  const xGap = layerCount > columnsPerBand ? 260 : 300
  const yGap = maxRowsInLayer > 2 ? 126 : 148
  const bandHeight = Math.max(250, maxRowsInLayer * yGap + 88)
  const originX = 96
  const originY = 96

  const positionByUnit = new Map<string, { x: number; y: number }>()
  for (const unit of unitOrder) {
    const layer = layerByUnit.get(unit) ?? 0
    const row = rowsByLayer.get(layer)?.indexOf(unit) ?? 0
    const band = Math.floor(layer / columnsPerBand)
    const columnInBand = layer % columnsPerBand
    const visualColumn = band % 2 === 0 ? columnInBand : columnsPerBand - 1 - columnInBand
    const idsInLayer = rowsByLayer.get(layer) ?? []
    const verticalInset = ((maxRowsInLayer - idsInLayer.length) * yGap) / 2
    positionByUnit.set(unit, {
      x: originX + visualColumn * xGap,
      y: originY + band * bandHeight + verticalInset + row * yGap,
    })
  }

  workflow.graph_json.nodes = workflow.graph_json.nodes.map((node) => {
    const unit = nodeUnitById.get(node.id) ?? node.id
    const base = positionByUnit.get(unit) ?? { x: originX, y: originY }
    const members = unitMembers.get(unit) ?? [node]
    const memberIndex = members.findIndex((member) => member.id === node.id)
    const compactOffset = collapsedStackKeys.has(fanoutStackKey(node) ?? "")
      ? {
          x: Math.min(memberIndex, 3) * 10,
          y: Math.min(memberIndex, 3) * 10,
        }
      : { x: 0, y: 0 }
    return {
      ...node,
      position: {
        x: base.x + compactOffset.x,
        y: base.y + compactOffset.y,
      },
    }
  })
}

function nodeKindLabel(node: WorkflowNodeInfo) {
  if (node.type === "human_gate") return "Gate"
  if (node.skill === "research-lit" && node.dynamic_parent_id) return "Research"
  return "Agent"
}

const FANOUT_STACK_MIN_SIZE = 3
const FANOUT_STACK_NODE_PREFIX = "fanout-stack:"
const STACK_EDGE_PREFIX = "stack-edge:"

type FanoutStackGroup = {
  key: string
  parentId: string
  parent?: WorkflowNodeInfo
  nodes: WorkflowNodeInfo[]
}

function fanoutStackKey(node: WorkflowNodeInfo) {
  if (node.fanout_parent_id) return `fanout:${node.fanout_parent_id}`
  if (node.dynamic_parent_id && node.type !== "human_gate") return `dynamic:${node.dynamic_parent_id}`
  return null
}

function fanoutStackNodeId(key: string) {
  return `${FANOUT_STACK_NODE_PREFIX}${key}`
}

function isFanoutStackNodeId(id: string) {
  return id.startsWith(FANOUT_STACK_NODE_PREFIX)
}

function isStackEdgeId(id: string) {
  return id.startsWith(STACK_EDGE_PREFIX)
}

function statusSummary(nodes: WorkflowNodeInfo[]) {
  const order: WorkflowNodeInfo["status"][] = [
    "failed",
    "running",
    "waiting_approval",
    "waiting_dynamic_dependency",
    "blocked",
    "queued",
    "succeeded",
    "skipped",
    "cancelled",
  ]
  const counts = new Map<WorkflowNodeInfo["status"], number>()
  nodes.forEach((node) => counts.set(node.status, (counts.get(node.status) ?? 0) + 1))
  return order
    .map((status) => ({ status, count: counts.get(status) ?? 0 }))
    .filter((item) => item.count > 0)
}

type WorkflowFlowNodeData = {
  label: ReactNode
}

function WorkflowFlowNode({ data }: NodeProps) {
  const nodeData = data as WorkflowFlowNodeData
  return (
    <>
      <Handle type="target" position={Position.Left} />
      {nodeData.label}
      <Handle type="source" position={Position.Right} />
    </>
  )
}

const workflowNodeTypes: NodeTypes = {
  workflow: WorkflowFlowNode,
}

type WorkflowEdgeData = Record<string, unknown> & {
  label?: string
  onOpen?: (edgeId: string) => void
}

type WorkflowCanvasEdge = Edge<WorkflowEdgeData, "workflowHandoff">

function WorkflowHandoffEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  markerStart,
  style,
  selected,
  data,
  interactionWidth,
}: EdgeProps<WorkflowCanvasEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const label = typeof data?.label === "string" ? data.label : ""
  const canOpen = Boolean(data?.onOpen)
  const handleOpen = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    data?.onOpen?.(id)
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={style}
        interactionWidth={interactionWidth}
      />
      {label && (
        <EdgeLabelRenderer>
          {canOpen ? (
            <button
              aria-label={`${label}. View handoff preview.`}
              className={`nodrag nopan flow-edge-label-button${selected ? " flow-edge-label-button-selected" : ""}`}
              onClick={handleOpen}
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
              title="View handoff preview"
              type="button"
            >
              {label}
            </button>
          ) : (
            <span
              className="nodrag nopan flow-edge-label-button flow-edge-label-static"
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            >
              {label}
            </span>
          )}
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const workflowEdgeTypes: EdgeTypes = {
  workflowHandoff: WorkflowHandoffEdge,
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

function handoffKey(source: string, target: string) {
  return `${source}->${target}`
}

function edgeHandoffLabel(handoff: WorkflowHandoff | undefined, plannerInserted: boolean) {
  if (!handoff?.preview) return plannerInserted ? "planner" : undefined
  const typeLabel = handoff.content_type === "json" ? "json" : handoff.content_type === "text" ? "text" : "handoff"
  return plannerInserted ? `planner ${typeLabel} view` : `${typeLabel} view`
}

function NodeResultPanel({ workflow, node }: { workflow: WorkflowRecord; node: WorkflowNodeInfo }) {
  const queryClient = useQueryClient()
  const [nodeEvents, setNodeEvents] = useState<WorkflowEvent[]>([])
  const nodeEventLogRef = useAutoScrollToEnd<HTMLDivElement>([nodeEvents.length, node.id])
  const outputRefreshTimerRef = useRef<number | null>(null)
  const runId = node.run_id ?? ""
  const scheduleOutputRefresh = useCallback(() => {
    if (!runId || outputRefreshTimerRef.current !== null) return
    outputRefreshTimerRef.current = window.setTimeout(() => {
      outputRefreshTimerRef.current = null
      queryClient.invalidateQueries({ queryKey: ["run-output", workflow.workspace, runId] })
    }, 500)
  }, [queryClient, runId, workflow.workspace])
  const outputQuery = useQuery({
    queryKey: ["run-output", workflow.workspace, runId],
    queryFn: () => api.runOutput(workflow.workspace, runId),
    enabled: Boolean(runId),
    refetchInterval: node.status === "running" ? 2500 : false,
  })
  const finalText =
    typeof outputQuery.data?.node_output?.text === "string"
      ? outputQuery.data.node_output.text
      : outputQuery.data?.last_message ?? ""

  useEffect(() => {
    setNodeEvents([])
    const socket = new WebSocket(api.workflowNodeStreamUrl(workflow, node.id, NODE_REPLAY_LIMIT))
    const pendingEvents: WorkflowEvent[] = []
    let flushTimer: number | null = null
    let active = true
    const flushEvents = () => {
      flushTimer = null
      if (!active || pendingEvents.length === 0) return
      const nextEvents = pendingEvents.splice(0, pendingEvents.length)
      setNodeEvents((current) => appendLimited(current, nextEvents, NODE_EVENT_LIMIT))
    }
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as WorkflowEvent
      pendingEvents.push(event)
      if (flushTimer === null) {
        flushTimer = window.setTimeout(flushEvents, EVENT_FLUSH_INTERVAL_MS)
      }
      if (runId && isRecentEvent(event.timestamp) && ["node", "run", "result"].includes(event.event_type)) {
        scheduleOutputRefresh()
      }
    }
    return () => {
      active = false
      if (flushTimer !== null) window.clearTimeout(flushTimer)
      socket.close()
    }
  }, [node.id, runId, scheduleOutputRefresh, workflow.id, workflow.workspace])

  useEffect(() => {
    return () => {
      if (outputRefreshTimerRef.current !== null) window.clearTimeout(outputRefreshTimerRef.current)
    }
  }, [])

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
        {(node.usage?.model || node.model) && (
          <span>
            Model
            <b>{node.usage?.model ?? node.model}</b>
          </span>
        )}
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
          {nodeEvents.map((event, index) => (
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

type NodeArtifactPreview = {
  workspace: string
  path: string
  nodeId: string
  nodeName: string
  artifact?: ArtifactInfo
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    if (token.startsWith("`")) {
      nodes.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>)
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) {
        nodes.push(
          <a href={link[2]} key={`${match.index}-link`} rel="noreferrer" target="_blank">
            {link[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    }
    lastIndex = match.index + token.length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function renderMarkdownTable(lines: string[], key: string) {
  const rows = lines.map((line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim()),
  )
  const [head, , ...body] = rows
  return (
    <div className="markdown-table-wrap" key={key}>
      <table>
        <thead>
          <tr>{head.map((cell, index) => <th key={index}>{renderInlineMarkdown(cell)}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{renderInlineMarkdown(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MarkdownPreview({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    const fence = line.match(/^```(\w+)?\s*$/)
    if (fence) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index])
        index += 1
      }
      index += index < lines.length ? 1 : 0
      blocks.push(
        <pre className="markdown-code" key={`code-${index}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      )
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = Math.min(heading[1].length, 4)
      const content = renderInlineMarkdown(heading[2])
      if (level === 1) blocks.push(<h1 key={`heading-${index}`}>{content}</h1>)
      else if (level === 2) blocks.push(<h2 key={`heading-${index}`}>{content}</h2>)
      else if (level === 3) blocks.push(<h3 key={`heading-${index}`}>{content}</h3>)
      else blocks.push(<h4 key={`heading-${index}`}>{content}</h4>)
      index += 1
      continue
    }
    if (/^\s*\|.+\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
      const tableLines = [line, lines[index + 1]]
      index += 2
      while (index < lines.length && /^\s*\|.+\|\s*$/.test(lines[index])) {
        tableLines.push(lines[index])
        index += 1
      }
      blocks.push(renderMarkdownTable(tableLines, `table-${index}`))
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""))
        index += 1
      }
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""))
        index += 1
      }
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}</ol>)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""))
        index += 1
      }
      blocks.push(<blockquote key={`quote-${index}`}>{quoteLines.map((item, itemIndex) => <p key={itemIndex}>{renderInlineMarkdown(item)}</p>)}</blockquote>)
      continue
    }
    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push(<p key={`p-${index}`}>{renderInlineMarkdown(paragraph.join(" "))}</p>)
  }
  return <article className="markdown-preview">{blocks}</article>
}

function NodeArtifactDialog({ preview, onClose }: { preview: NodeArtifactPreview | null; onClose: () => void }) {
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const path = preview?.artifact?.path ?? preview?.path ?? ""

  useEffect(() => {
    setText("")
    setError("")
    if (!preview || isImageArtifact(path) || isFrameArtifact(path)) return
    fetch(api.artifactUrlForPath(preview.workspace, path))
      .then((response) => {
        if (!response.ok) throw new Error(response.statusText)
        return response.text()
      })
      .then(setText)
      .catch((nextError: Error) => setError(nextError.message))
  }, [path, preview])

  return (
    <Dialog open={Boolean(preview)} title={preview ? `${preview.nodeName} · ${artifactLabel(path)}` : "Node artifact"} onClose={onClose}>
      {preview && (
        <div className="node-artifact-reader">
          <div className="node-artifact-reader-meta">
            <Badge>{preview.artifact?.kind ?? (artifactExtension(path) || "file")}</Badge>
            <span>{path}</span>
            <a className="btn btn-secondary" href={api.artifactUrlForPath(preview.workspace, path)} rel="noreferrer" target="_blank">
              Open raw
            </a>
          </div>
          {error ? (
            <div className="node-artifact-reader-content">
              <p className="error-text">{error}</p>
            </div>
          ) : (
            <div className="node-artifact-reader-content">
              {isImageArtifact(path) ? (
                <img className="preview-image" src={api.artifactUrlForPath(preview.workspace, path)} alt={artifactLabel(path)} />
              ) : isFrameArtifact(path) ? (
                <iframe className="preview-frame" src={api.artifactUrlForPath(preview.workspace, path)} title={artifactLabel(path)} />
              ) : isMarkdownArtifact(path) ? (
                text ? <MarkdownPreview text={text} /> : <p className="muted">Loading Markdown...</p>
              ) : (
                <pre className="preview-text">{text || "Loading..."}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
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
  const [flowPanelCollapsed, setFlowPanelCollapsed] = useState(false)
  const [generatorCollapsed, setGeneratorCollapsed] = useState(true)
  const [canvasToolsCollapsed, setCanvasToolsCollapsed] = useState(true)
  const [expandedFanoutGroups, setExpandedFanoutGroups] = useState<Set<string>>(() => new Set())
  const [fanoutStackPositions, setFanoutStackPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [selectedNodeId, setSelectedNodeId] = useState("")
  const [selectedEdgeId, setSelectedEdgeId] = useState("")
  const [promptOptimizationNote, setPromptOptimizationNote] = useState("")
  const [promptSuggestion, setPromptSuggestion] = useState<{ nodeId: string; prompt: string } | null>(null)
  const [artifactPreview, setArtifactPreview] = useState<NodeArtifactPreview | null>(null)
  const [events, setEvents] = useState<WorkflowEvent[]>([])
  const [workflowEventFilter, setWorkflowEventFilter] = useState<WorkflowEventFilter>("all")
  const [showFullWorkflowLog, setShowFullWorkflowLog] = useState(true)
  const workflowLogRef = useAutoScrollToEnd<HTMLDivElement>([events.length, selectedId, workflowEventFilter, showFullWorkflowLog])
  const flowInstanceRef = useRef<ReactFlowInstance<Node, WorkflowCanvasEdge> | null>(null)
  const workflowRefreshTimerRef = useRef<number | null>(null)
  const artifactRefreshTimerRef = useRef<number | null>(null)
  const runtimeRefreshTimerRef = useRef<number | null>(null)
  const [canvasNodes, setCanvasNodes] = useState<Node[]>([])
  const workflows = useQuery({
    queryKey: ["workflows", workspace],
    queryFn: () => api.workflows(workspace),
    enabled: Boolean(workspace),
    refetchInterval: dirty || isDraggingNode ? false : isLiveWorkflowStatus(draft?.status) ? 10000 : false,
  })
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills })
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const agentConfigs = useQuery({
    queryKey: ["agent-configs", workspace],
    queryFn: () => api.agentConfigs(workspace),
    enabled: Boolean(workspace),
  })
  const workspaceArtifacts = useQuery({
    queryKey: ["artifacts", workspace],
    queryFn: () => api.artifacts(workspace),
    enabled: Boolean(workspace),
    refetchInterval: isLiveWorkflowStatus(draft?.status) ? 5000 : false,
  })
  const selected = (workflows.data ?? []).find((workflow) => workflow.id === selectedId) ?? workflows.data?.[0]
  const artifactsByPath = useMemo(() => artifactByPath(workspaceArtifacts.data), [workspaceArtifacts.data])
  const runtime = useQuery<WorkflowRuntimeResponse>({
    queryKey: ["workflow-runtime", selected?.id],
    queryFn: () => api.workflowRuntime(selected as WorkflowRecord),
    enabled: Boolean(selected),
    refetchInterval: isLiveWorkflowStatus(selected?.status) ? 5000 : false,
  })

  const scheduleWorkflowRefresh = useCallback(() => {
    if (workflowRefreshTimerRef.current !== null) return
    workflowRefreshTimerRef.current = window.setTimeout(() => {
      workflowRefreshTimerRef.current = null
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
    }, 900)
  }, [queryClient, workspace])

  const scheduleArtifactRefresh = useCallback(() => {
    if (artifactRefreshTimerRef.current !== null) return
    artifactRefreshTimerRef.current = window.setTimeout(() => {
      artifactRefreshTimerRef.current = null
      queryClient.invalidateQueries({ queryKey: ["artifacts", workspace] })
    }, 1800)
  }, [queryClient, workspace])

  const scheduleRuntimeRefresh = useCallback((workflowId: string) => {
    if (runtimeRefreshTimerRef.current !== null) return
    runtimeRefreshTimerRef.current = window.setTimeout(() => {
      runtimeRefreshTimerRef.current = null
      queryClient.invalidateQueries({ queryKey: ["workflow-runtime", workflowId] })
    }, 900)
  }, [queryClient])

  useEffect(() => {
    if (!selectedId && workflows.data?.[0]) setSelectedId(workflows.data[0].id)
  }, [selectedId, workflows.data])

  useEffect(() => {
    if (!workflows.data) return
    if (workflows.data.length === 0) {
      setGeneratorCollapsed(false)
      setFlowPanelCollapsed(false)
    }
  }, [workflows.data?.length])

  useEffect(() => {
    setPromptSuggestion(null)
  }, [selectedNodeId])

  useEffect(() => {
    if (!selected) return
    setDraft((current) => {
      if (dirty && current?.id === selected.id) return current
      return cloneWorkflow(selected)
    })
    if (!dirty) {
      setSelectedNodeId((current) =>
        current && selected.graph_json.nodes.some((node) => node.id === current)
          ? current
          : selected.graph_json.nodes[0]?.id ?? "",
      )
    }
  }, [dirty, selected?.id, selected?.updated_at])

  useEffect(() => {
    setEvents([])
    if (!selected) return
    const socket = new WebSocket(api.workflowStreamUrl(selected, WORKFLOW_REPLAY_LIMIT))
    const pendingEvents: WorkflowEvent[] = []
    let flushTimer: number | null = null
    let active = true
    const flushEvents = () => {
      flushTimer = null
      if (!active || pendingEvents.length === 0) return
      const nextEvents = pendingEvents.splice(0, pendingEvents.length)
      setEvents((current) => appendLimited(current, nextEvents, WORKFLOW_EVENT_LIMIT))
    }
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as WorkflowEvent
      pendingEvents.push(event)
      if (flushTimer === null) {
        flushTimer = window.setTimeout(flushEvents, EVENT_FLUSH_INTERVAL_MS)
      }
      if (isRecentEvent(event.timestamp) && ["workflow", "node", "planner", "delta", "session", "approval"].includes(event.event_type)) {
        scheduleWorkflowRefresh()
        scheduleArtifactRefresh()
        scheduleRuntimeRefresh(selected.id)
      }
    }
    return () => {
      active = false
      if (flushTimer !== null) window.clearTimeout(flushTimer)
      socket.close()
    }
  }, [scheduleArtifactRefresh, scheduleRuntimeRefresh, scheduleWorkflowRefresh, selected?.id, selected?.workspace, workspace])

  useEffect(() => {
    return () => {
      if (workflowRefreshTimerRef.current !== null) window.clearTimeout(workflowRefreshTimerRef.current)
      if (artifactRefreshTimerRef.current !== null) window.clearTimeout(artifactRefreshTimerRef.current)
      if (runtimeRefreshTimerRef.current !== null) window.clearTimeout(runtimeRefreshTimerRef.current)
    }
  }, [])

  const createWorkflow = useMutation({
    mutationFn: api.createWorkflow,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setSelectedId(workflow.id)
      setDraft(cloneWorkflow(workflow))
      setDirty(false)
      setFlowPanelCollapsed(true)
      setGeneratorCollapsed(true)
    },
  })
  const generateWorkflow = useMutation({
    mutationFn: api.generateWorkflow,
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setSelectedId(workflow.id)
      setDraft(cloneWorkflow(workflow))
      setDirty(false)
      setFlowPanelCollapsed(true)
      setGeneratorCollapsed(true)
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
      setFlowPanelCollapsed(true)
      setGeneratorCollapsed(true)
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
    onMutate: async (workflow) => {
      await queryClient.cancelQueries({ queryKey: ["workflows", workspace] })
      const previousWorkflows = queryClient.getQueryData<WorkflowRecord[]>(["workflows", workspace])
      queryClient.setQueryData<WorkflowRecord[]>(["workflows", workspace], (current) =>
        (current ?? []).filter((item) => item.id !== workflow.id),
      )
      return { previousWorkflows }
    },
    onError: (_error, _workflow, context) => {
      if (context?.previousWorkflows) {
        queryClient.setQueryData(["workflows", workspace], context.previousWorkflows)
      }
    },
    onSuccess: (_result, workflow) => {
      setSelectedId((current) => (current === workflow.id ? "" : current))
      setDraft((current) => (current?.id === workflow.id ? null : current))
      setDirty(false)
      setSelectedNodeId("")
      setSelectedEdgeId("")
      setEvents([])
      queryClient.removeQueries({ queryKey: ["workflow-runtime", workflow.id] })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
    },
  })
  const executeWorkflow = useMutation({
    mutationFn: async (workflow: WorkflowRecord) => {
      const saved = await api.updateWorkflow(workflow)
      return api.executeWorkflow(saved)
    },
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
  const restoreNode = useMutation({
    mutationFn: ({ workflow, nodeId }: { workflow: WorkflowRecord; nodeId: string }) =>
      api.restoreWorkflowNode(workflow, nodeId),
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
    },
  })
  const optimizeNodePrompt = useMutation({
    mutationFn: ({ workflow, nodeId, instructions, model }: { workflow: WorkflowRecord; nodeId: string; instructions: string; model?: string | null }) =>
      api.optimizeWorkflowNodePrompt(workflow, nodeId, {
        graph_json: workflow.graph_json,
        instructions: instructions.trim() || null,
        model: model?.trim() || null,
      }),
    onSuccess: (response, variables) => {
      setPromptSuggestion({ nodeId: variables.nodeId, prompt: response.prompt })
    },
  })
  const runNode = useMutation({
    mutationFn: async ({ workflow, nodeId }: { workflow: WorkflowRecord; nodeId: string }) => {
      const saved = await api.updateWorkflow(workflow)
      return api.rerunWorkflowNode(saved, nodeId, false)
    },
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
      setDirty(false)
    },
  })
  const rerunNode = useMutation({
    mutationFn: async ({ workflow, nodeId }: { workflow: WorkflowRecord; nodeId: string }) => {
      const saved = await api.updateWorkflow(workflow)
      return api.rerunWorkflowNode(saved, nodeId, true)
    },
    onSuccess: (workflow) => {
      queryClient.invalidateQueries({ queryKey: ["workflows", workspace] })
      setDraft(cloneWorkflow(workflow))
      setDirty(false)
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
      const id = slug(`${type === "human_gate" ? "gate" : "agent"}-${index}`)
      workflow.graph_json.nodes.push({
        id,
        type,
        name: type === "human_gate" ? `Gate ${index}` : `Agent ${index}`,
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
        session_path: null,
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
        dynamic_parent_id: null,
        dynamic_reason: null,
        auto_approve_after: false,
        research_request: null,
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
    window.setTimeout(() => {
      flowInstanceRef.current?.fitView({ padding: 0.16, duration: 320 })
    }, 80)
  }

  const selectedNode = draft?.graph_json.nodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedEdge = draft?.graph_json.edges.find((edge) => edge.id === selectedEdgeId) ?? null
  const handoffByEdge = useMemo(() => {
    const next = new Map<string, WorkflowHandoff>()
    for (const handoff of runtime.data?.handoffs ?? []) {
      next.set(handoffKey(handoff.source, handoff.target), handoff)
    }
    return next
  }, [runtime.data?.handoffs])
  const selectedHandoff = selectedEdge ? handoffByEdge.get(handoffKey(selectedEdge.source, selectedEdge.target)) : undefined
  const openEdgePanel = useCallback((edgeId: string) => {
    setSelectedEdgeId(edgeId)
    setSelectedNodeId("")
  }, [])
  const fanoutStackGroups = useMemo<FanoutStackGroup[]>(() => {
    const nodes = draft?.graph_json.nodes ?? []
    const nodeMap = new Map(nodes.map((node) => [node.id, node]))
    const groups = new Map<string, FanoutStackGroup>()
    for (const node of nodes) {
      const key = fanoutStackKey(node)
      if (!key) continue
      const parentId = node.fanout_parent_id ?? node.dynamic_parent_id ?? key
      const group = groups.get(key) ?? {
        key,
        parentId,
        parent: nodeMap.get(parentId),
        nodes: [],
      }
      group.nodes.push(node)
      groups.set(key, group)
    }
    return Array.from(groups.values())
      .filter((group) => group.nodes.length >= FANOUT_STACK_MIN_SIZE)
      .map((group) => ({
        ...group,
        nodes: [...group.nodes].sort((a, b) => a.name.localeCompare(b.name)),
      }))
  }, [draft])
  useEffect(() => {
    setExpandedFanoutGroups((current) => {
      if (!current.size) return current
      const validKeys = new Set(fanoutStackGroups.map((group) => group.key))
      const next = new Set(Array.from(current).filter((key) => validKeys.has(key)))
      return next.size === current.size ? current : next
    })
  }, [fanoutStackGroups])
  useEffect(() => {
    setFanoutStackPositions((current) => {
      const validKeys = new Set<string>()
      fanoutStackGroups.forEach((group) => {
        validKeys.add(group.key)
        validKeys.add(`${group.key}:expanded-control`)
      })
      const entries = Object.entries(current).filter(([key]) => validKeys.has(key))
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries)
    })
  }, [fanoutStackGroups])
  const expandFanoutGroup = useCallback((key: string) => {
    setExpandedFanoutGroups((current) => {
      if (current.has(key)) return current
      const next = new Set(current)
      next.add(key)
      return next
    })
  }, [])
  const collapseFanoutGroup = useCallback((key: string) => {
    setExpandedFanoutGroups((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }, [])
  const stackableFanoutGroupByNodeId = useMemo(() => {
    const next = new Map<string, FanoutStackGroup>()
    for (const group of fanoutStackGroups) {
      group.nodes.forEach((node) => next.set(node.id, group))
    }
    return next
  }, [fanoutStackGroups])
  const collapsedFanoutGroups = useMemo(
    () => fanoutStackGroups.filter((group) => !expandedFanoutGroups.has(group.key)),
    [expandedFanoutGroups, fanoutStackGroups],
  )
  const collapsedNodeToStackId = useMemo(() => {
    const next = new Map<string, string>()
    for (const group of collapsedFanoutGroups) {
      const stackId = fanoutStackNodeId(group.key)
      group.nodes.forEach((node) => next.set(node.id, stackId))
    }
    return next
  }, [collapsedFanoutGroups])
  const collapsedNodeIds = useMemo(() => new Set(collapsedNodeToStackId.keys()), [collapsedNodeToStackId])
  const nodesWithRuns = useMemo(
    () =>
      (draft?.graph_json.nodes ?? []).filter(
        (node) => Boolean(node.run_id) && (!collapsedNodeIds.has(node.id) || node.id === selectedNodeId),
      ),
    [collapsedNodeIds, draft?.graph_json.nodes, selectedNodeId],
  )
  const nodeOutputQueries = useQueries({
    queries: nodesWithRuns.map((node) => ({
      queryKey: ["run-output", workspace, node.run_id],
      queryFn: () => api.runOutput(workspace, node.run_id as string),
      enabled: Boolean(workspace && node.run_id),
      staleTime: 30000,
      refetchOnWindowFocus: false,
    })),
  })
  const nodeOutputSignature = nodeOutputQueries.map((query) => query.dataUpdatedAt).join(":")
  const runOutputByRunId = useMemo(() => {
    const next = new Map<string, RunOutput>()
    nodesWithRuns.forEach((node, index) => {
      const data = nodeOutputQueries[index]?.data
      if (node.run_id && data) next.set(node.run_id, data)
    })
    return next
  }, [nodeOutputSignature, nodesWithRuns])
  const selectedRuntimeSessionId = draft && selectedNode ? `node:${draft.id}:${selectedNode.id}` : runtime.data?.runtime_summary.planner_session_id
  const selectedSession = useQuery({
    queryKey: ["workflow-session", selected?.id, selectedRuntimeSessionId],
    queryFn: () => api.workflowSession(selected as WorkflowRecord, selectedRuntimeSessionId as string),
    enabled: Boolean(selected && selectedRuntimeSessionId),
    refetchInterval: isLiveWorkflowStatus(selected?.status) ? 7000 : false,
  })
  const workflowTerminalStats = useMemo(
    () => ({
      aris: events.filter(isArisOutputEvent).length,
      total: events.length,
    }),
    [events],
  )
  const workflowTerminalCounts = useMemo(
    () => ({
      all: events.length,
      aris: events.filter(isArisOutputEvent).length,
      workflow: events.filter((event) => event.event_type === "workflow").length,
      node: events.filter((event) => event.event_type === "node" || event.event_type === "run").length,
      planner: events.filter((event) => event.event_type === "planner").length,
      runtime: events.filter((event) => ["delta", "session", "approval"].includes(event.event_type)).length,
      errors: events.filter(isWorkflowErrorEvent).length,
    }),
    [events],
  )
  const displayedWorkflowEvents = useMemo(
    () => events.filter((event) => workflowEventMatchesFilter(event, workflowEventFilter)),
    [events, workflowEventFilter],
  )
  const selectedNodeConfig =
    selectedNode?.type === "sub_agent" ? findAgentConfig(agentConfigs.data, selectedNode?.config_file) : null
  const configuredProviderModels = useMemo(
    () =>
      (settings.data?.providers ?? [])
        .filter((profile) => profile.api_key_set)
        .flatMap((profile) => [profile.model, ...(profile.models ?? [])].filter((item): item is string => Boolean(item))),
    [settings.data?.providers],
  )
  const modelProviderLabels = useMemo(() => {
    const labels = new Map<string, string>()
    for (const profile of settings.data?.providers ?? []) {
      if (!profile.api_key_set) continue
      const label = providerOptions.find((item) => item.value === profile.provider)?.label ?? profile.provider
      for (const modelOption of uniqueModelOptions(profile.model, profile.models ?? [])) {
        if (!labels.has(modelOption)) labels.set(modelOption, label)
      }
    }
    return labels
  }, [settings.data?.providers])
  const nodeModelOptions = uniqueModelOptions(
    selectedNode?.model,
    selectedNodeConfig?.model,
    settings.data?.model,
    configuredProviderModels,
  )
  const nodeModelDefaultLabel = selectedNodeConfig?.model
    ? `Use profile default (${selectedNodeConfig.model})`
    : settings.data?.model
      ? `Use global default (${settings.data.model})`
      : "Use runtime default"
  const draftCounts = draft
    ? workflowCounts(draft)
    : { agents: 0, gates: 0 }
  const waitingBatchCount =
    draft?.graph_json.nodes.filter(
      (node) => isExecutableNode(node) && node.status === "waiting_approval" && Boolean(node.run_id) && !node.approved_after,
    ).length ?? 0
  const runtimeSummary = runtime.data?.runtime_summary
  const executionState = runtimeSummary?.execution_state ?? draft?.status ?? "idle"
  const selectedNodeRuntimeArtifacts = useMemo(
    () => (selectedNode ? (runtime.data?.artifact_index ?? []).filter((artifact) => artifact.producer_node_id === selectedNode.id) : []),
    [runtime.data?.artifact_index, selectedNode],
  )
  const selectedBlockedSession = useMemo(
    () =>
      selectedNode
        ? (runtime.data?.blocked_sessions ?? []).find((item) => item["node_id"] === selectedNode.id)
        : null,
    [runtime.data?.blocked_sessions, selectedNode],
  )
  const nodeSequence = useMemo(() => workflowNodeSequence(draft), [draft])
  const draftFlowNodes: Node[] = useMemo(
    () => {
      const visibleNodes = (draft?.graph_json.nodes ?? []).filter((node) => !collapsedNodeIds.has(node.id))
      const normalNodes = visibleNodes.map((node) => {
        const agentConfig = findAgentConfig(agentConfigs.data, node.config_file)
        const inheritedSkill = node.skill ?? agentConfig?.skill ?? null
        const skillLabel = node.type === "sub_agent" && inheritedSkill ? `/${inheritedSkill}` : null
        const roleLabel = agentConfig
          ? agentConfig.name
          : node.role || (node.type === "human_gate" ? "human approval" : node.type === "sub_agent" ? "executor" : "planner")
        const roleAccent = agentConfig ? roleColor(agentConfig.id) : null
        const teamAccent = node.team_instance_id ? roleColor(node.team_instance_id) : null
        const isDynamicResearch = node.skill === "research-lit" && Boolean(node.dynamic_parent_id)
        const dynamicAccent = isDynamicResearch ? "#0891b2" : null
        const accent = roleAccent ?? teamAccent ?? dynamicAccent
        const style: React.CSSProperties | undefined = accent
          ? { borderLeft: `4px solid ${accent}` }
          : undefined
        const sequence = nodeSequence.get(node.id) ?? 0
        const runOutput = node.run_id ? runOutputByRunId.get(node.run_id) : undefined
        const nodeArtifactPaths = [
          ...(draft ? workflowOutputArtifactPaths(draft, node) : []),
          ...outputFilePaths(node.outputs),
          ...extractArtifactPathsFromRunOutput(runOutput, workspaceArtifacts.data),
        ]
        const nodeArtifacts = [...new Set(nodeArtifactPaths)]
          .map((path) => artifactsByPath.get(path))
          .filter((artifact): artifact is ArtifactInfo => Boolean(artifact))
        const fanoutGroup = stackableFanoutGroupByNodeId.get(node.id)
        const fanoutGroupExpanded = Boolean(fanoutGroup && expandedFanoutGroups.has(fanoutGroup.key))
        return {
          id: node.id,
          type: "workflow",
          position: { x: node.position?.x ?? 0, y: node.position?.y ?? 0 },
          data: {
            label: (
              <div className="flow-node-label">
                <div className="flow-node-topline">
                  <span className="flow-node-kind-row">
                    <span className="flow-node-order">{String(sequence).padStart(2, "0")}</span>
                    <span className={`node-kind node-kind-${isDynamicResearch ? "research" : node.type}`}>
                      {node.type === "human_gate" ? <ClipboardCheck size={13} /> : <Cpu size={13} />}
                      {nodeKindLabel(node)}
                    </span>
                  </span>
                  <em className={statusClass(node.status)}>{node.status}</em>
                </div>
                <strong>{node.name}</strong>
                {isDynamicResearch ? (
                  <span className="role-chip role-chip-research">
                    <Sparkles size={11} />
                    planned by Agent
                  </span>
                ) : node.type === "sub_agent" && agentConfig ? (
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
                {node.status === "waiting_dynamic_dependency" && <small>waiting for literature</small>}
                {node.dynamic_reason && <small title={node.dynamic_reason}>{truncate(node.dynamic_reason, 72)}</small>}
                {fanoutGroup && fanoutGroupExpanded && (
                  <button
                    className="flow-node-group-action nodrag nopan"
                    onClick={(event) => {
                      event.stopPropagation()
                      collapseFanoutGroup(fanoutGroup.key)
                    }}
                    title={`Stack ${fanoutGroup.nodes.length} generated agents`}
                    type="button"
                  >
                    <Layers3 size={12} />
                    Stack group
                  </button>
                )}
                {nodeArtifacts.length > 0 && (
                  <div className="flow-node-artifacts">
                    {nodeArtifacts.slice(0, 3).map((artifact) => (
                      <button
                        aria-label={`Open ${artifact.name}`}
                        className="flow-node-artifact nodrag nopan"
                        key={artifact.id}
                        onClick={(event) => {
                          event.stopPropagation()
                          setArtifactPreview({
                            workspace: draft?.workspace ?? workspace,
                            path: artifact.path,
                            nodeId: node.id,
                            nodeName: node.name,
                            artifact,
                          })
                        }}
                        title={artifact.path}
                        type="button"
                      >
                        <FileText size={12} />
                        <span>{artifactLabel(artifact.path)}</span>
                      </button>
                    ))}
                    {nodeArtifacts.length > 3 && <span className="flow-node-artifact-more">+{nodeArtifacts.length - 3}</span>}
                  </div>
                )}
              </div>
            ),
          },
          className: `flow-node flow-node-${node.type} flow-node-${node.status}${isDynamicResearch ? " flow-node-dynamic-research" : ""}`,
          style,
        }
      })

      const renderFanoutStackLabel = (group: FanoutStackGroup, mode: "collapsed" | "expanded") => {
        const statusItems = statusSummary(group.nodes)
        const primaryStatus = statusItems[0]?.status ?? "queued"
        const succeededCount = group.nodes.filter((node) => node.status === "succeeded").length
        return (
          <div className="fanout-stack-label">
            <div className="flow-node-topline">
              <span className="flow-node-kind-row">
                <span className="flow-node-order">{group.nodes.length}</span>
                <span className="node-kind node-kind-fanout">
                  <Layers3 size={13} />
                  {mode === "collapsed" ? "Stack" : "Expanded"}
                </span>
              </span>
              <em className={statusClass(primaryStatus)}>{primaryStatus}</em>
            </div>
            <strong>{group.parent?.name ?? group.parentId} fan-out</strong>
            <span>
              {group.nodes.length} generated Agents · {succeededCount}/{group.nodes.length} done
            </span>
            {mode === "collapsed" && (
              <>
                <div className="fanout-stack-statuses">
                  {statusItems.slice(0, 4).map((item) => (
                    <small key={item.status}>
                      {item.count} {item.status}
                    </small>
                  ))}
                </div>
                <div className="fanout-stack-preview">
                  {group.nodes.slice(0, 4).map((node) => (
                    <span key={node.id}>{node.name}</span>
                  ))}
                  {group.nodes.length > 4 && <span>+{group.nodes.length - 4} more</span>}
                </div>
              </>
            )}
            <button
              className="fanout-stack-expand nodrag nopan"
              onClick={(event) => {
                event.stopPropagation()
                if (mode === "collapsed") {
                  expandFanoutGroup(group.key)
                } else {
                  collapseFanoutGroup(group.key)
                }
              }}
              type="button"
            >
              {mode === "collapsed" ? "Expand" : "Collapse"}
            </button>
          </div>
        )
      }

      const stackNodes: Node[] = collapsedFanoutGroups.map((group) => {
        const xValues = group.nodes.map((node) => Number(node.position?.x ?? 0))
        const yValues = group.nodes.map((node) => Number(node.position?.y ?? 0))
        const position = fanoutStackPositions[group.key] ?? {
          x: Math.min(...xValues),
          y: Math.min(...yValues),
        }
        return {
          id: fanoutStackNodeId(group.key),
          type: "workflow",
          position,
          connectable: false,
          data: {
            label: renderFanoutStackLabel(group, "collapsed"),
          },
          className: "flow-node flow-node-fanout-stack",
        }
      })

      const expandedStackControls: Node[] = fanoutStackGroups
        .filter((group) => expandedFanoutGroups.has(group.key))
        .map((group) => {
          const xValues = group.nodes.map((node) => Number(node.position?.x ?? 0))
          const yValues = group.nodes.map((node) => Number(node.position?.y ?? 0))
          const collapsedPosition = fanoutStackPositions[group.key]
          return {
            id: fanoutStackNodeId(`${group.key}:expanded-control`),
            type: "workflow",
            position: fanoutStackPositions[`${group.key}:expanded-control`] ?? {
              x: collapsedPosition?.x ?? Math.min(...xValues),
              y: Math.max(24, (collapsedPosition?.y ?? Math.min(...yValues)) - 120),
            },
            connectable: false,
            data: {
              label: renderFanoutStackLabel(group, "expanded"),
            },
            className: "flow-node flow-node-fanout-stack flow-node-fanout-controller",
          }
        })

      return [...normalNodes, ...stackNodes, ...expandedStackControls]
    },
    [
      artifactsByPath,
      draft,
      agentConfigs.data,
      nodeSequence,
      runOutputByRunId,
      workspace,
      workspaceArtifacts.data,
      collapsedNodeIds,
      stackableFanoutGroupByNodeId,
      expandedFanoutGroups,
      collapseFanoutGroup,
      collapsedFanoutGroups,
      expandFanoutGroup,
      fanoutStackGroups,
      fanoutStackPositions,
    ],
  )
  useEffect(() => {
    if (!isDraggingNode) {
      setCanvasNodes(draftFlowNodes)
    }
  }, [draftFlowNodes, isDraggingNode])

  const flowEdges: WorkflowCanvasEdge[] = useMemo(
    () => {
      const nodesById = new Map((draft?.graph_json.nodes ?? []).map((node) => [node.id, node]))
      const mergedEdges = new Map<string, {
        edge: WorkflowRecord["graph_json"]["edges"][number]
        source: string
        target: string
        handoff?: WorkflowHandoff
        plannerInserted: boolean
        count: number
      }>()

      for (const edge of draft?.graph_json.edges ?? []) {
        const source = nodesById.get(edge.source)
        const target = nodesById.get(edge.target)
        const mappedSource = collapsedNodeToStackId.get(edge.source) ?? edge.source
        const mappedTarget = collapsedNodeToStackId.get(edge.target) ?? edge.target
        if (mappedSource === mappedTarget) continue
        const handoff = handoffByEdge.get(handoffKey(edge.source, edge.target))
        const plannerInserted = Boolean(source?.dynamic_parent_id || (target?.status === "waiting_dynamic_dependency" && target.depends_on.includes(edge.source)))
        const key = `${mappedSource}->${mappedTarget}`
        const existing = mergedEdges.get(key)
        if (existing) {
          existing.count += 1
          existing.plannerInserted = existing.plannerInserted || plannerInserted
          existing.handoff = existing.handoff ?? handoff
          continue
        }
        mergedEdges.set(key, {
          edge,
          source: mappedSource,
          target: mappedTarget,
          handoff,
          plannerInserted,
          count: 1,
        })
      }

      return Array.from(mergedEdges.values()).map(({ edge, source, target, handoff, plannerInserted, count }) => {
        const isStackEdge = count > 1 || source !== edge.source || target !== edge.target
        const handoffLabel = edgeHandoffLabel(handoff, plannerInserted)
        const edgeLabel = count > 1 ? `${count} links` : handoffLabel
        const classes = [
          edge.id === selectedEdgeId ? "flow-edge-selected" : "",
          isStackEdge ? "flow-edge-stacked" : "",
          plannerInserted ? "flow-edge-planner" : "",
          handoff?.preview ? "flow-edge-handoff" : "",
          nodesById.get(edge.target)?.status === "waiting_dynamic_dependency" ? "flow-edge-blocking" : "",
        ].filter(Boolean)
        return {
          id: isStackEdge ? `${STACK_EDGE_PREFIX}${source}->${target}` : edge.id,
          type: "workflowHandoff",
          source,
          target,
          markerEnd: { type: MarkerType.ArrowClosed },
          selected: !isStackEdge && edge.id === selectedEdgeId,
          data: {
            label: edgeLabel,
            onOpen: isStackEdge ? undefined : openEdgePanel,
          },
          ariaLabel: edgeLabel ? `${edgeLabel}.` : undefined,
          focusable: Boolean(edgeLabel && !isStackEdge),
          interactionWidth: edgeLabel ? 28 : 20,
          className: classes.join(" ") || undefined,
        }
      })
    },
    [collapsedNodeToStackId, draft, handoffByEdge, openEdgePanel, selectedEdgeId],
  )
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const realChanges = changes.filter((change) => !(change.type === "remove" && isFanoutStackNodeId(change.id)))
    const removeChanges = realChanges.filter((change) => change.type === "remove")
    setCanvasNodes((nodes) => applyNodeChanges(realChanges, nodes))
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

  function handleDeleteWorkflow(workflow: WorkflowRecord | null = draft) {
    if (!workflow) return
    if (!globalThis.confirm(`Delete Flow "${workflow.title}"? This cannot be undone.`)) return
    deleteWorkflow.mutate(workflow)
  }

  return (
    <div className={`orchestrator-grid workflow-layout ${flowPanelCollapsed ? "flows-collapsed" : ""}`}>
      <aside className="orchestrator-left panel">
        {flowPanelCollapsed ? (
          <Button
            className="flow-panel-rail-button"
            variant="secondary"
            onClick={() => setFlowPanelCollapsed(false)}
            type="button"
            aria-label="Show flows"
            title="Show flows"
          >
            <ChevronRight size={16} />
            <GitBranch size={16} />
            <span>Flows</span>
          </Button>
        ) : (
          <>
        <div className="panel-head compact-head">
          <div>
            <h2>Flows</h2>
            <p>{(workflows.data ?? []).length} local workflows</p>
          </div>
          <div className="panel-head-actions">
            <Button variant="secondary" onClick={() => workflows.refetch()} type="button" aria-label="Refresh flows" title="Refresh flows">
              <RefreshCcw size={15} />
            </Button>
            <Button variant="secondary" onClick={() => setFlowPanelCollapsed(true)} type="button" aria-label="Hide flows" title="Hide flows">
              <ChevronLeft size={15} />
            </Button>
          </div>
        </div>
        <div className="workflow-list">
          {(workflows.data ?? []).map((workflow) => {
            const counts = workflowCounts(workflow)
            return (
              <div
                className={`workflow-row ${draft?.id === workflow.id ? "selected" : ""}`}
                key={workflow.id}
              >
                <button
                  className="workflow-row-main"
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
                  {counts.agents} Agents · {counts.gates} Gates
                  </span>
                  <em className={statusClass(workflow.status)}>{workflow.status}</em>
                </button>
                <Button
                  aria-label={`Delete flow ${workflow.title}`}
                  className="workflow-row-delete"
                  disabled={deleteWorkflow.isPending}
                  onClick={() => handleDeleteWorkflow(workflow)}
                  title="Delete flow"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            )
          })}
          {workflows.data?.length === 0 && (
            <div className="list-empty">
              <GitBranch size={18} />
              <span>No flows yet</span>
            </div>
          )}
        </div>
        <div className={`generator-box ${generatorCollapsed ? "generator-box-collapsed" : ""}`}>
          <button
            aria-expanded={!generatorCollapsed}
            className="generator-toggle"
            onClick={() => setGeneratorCollapsed((current) => !current)}
            title={generatorCollapsed ? "Expand flow editor" : "Collapse flow editor"}
            type="button"
          >
            <span className="generator-toggle-title">
              <Sparkles size={14} />
              Create / Update Flow
            </span>
            {generatorCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </button>
          {!generatorCollapsed && (
            <div className="generator-content">
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
          )}
        </div>
          </>
        )}
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
              <div className={`flow-canvas-toolbar ${canvasToolsCollapsed ? "flow-canvas-toolbar-collapsed" : ""}`} aria-label="Flow canvas actions">
                <Button
                  className="flow-canvas-toolbar-toggle"
                  variant="secondary"
                  onClick={() => setCanvasToolsCollapsed((current) => !current)}
                  type="button"
                  aria-label={canvasToolsCollapsed ? "Expand canvas tools" : "Collapse canvas tools"}
                  title={canvasToolsCollapsed ? "Expand tools" : "Collapse tools"}
                >
                  {canvasToolsCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
                  {!canvasToolsCollapsed && "Tools"}
                </Button>
                <div className="canvas-actions-group">
                  <Button variant="secondary" onClick={() => addNode("agent")} type="button" title="Agent">
                    <Cpu size={15} />
                    Agent
                  </Button>
                  <Button variant="secondary" onClick={() => addNode("human_gate")} type="button" title="Gate">
                    <ClipboardCheck size={15} />
                    Gate
                  </Button>
                  {selectedEdge && (
                    <Button variant="secondary" onClick={() => removeEdges([selectedEdge.id])} type="button" title="Remove selected edge">
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
                    title="Save"
                  >
                    <Save size={15} />
                    Save
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => handleDeleteWorkflow()}
                    disabled={deleteWorkflow.isPending}
                    type="button"
                    title="Delete"
                  >
                    <Trash2 size={15} />
                    Delete
                  </Button>
                </div>
                <div className="canvas-actions-group">
                  <Button onClick={() => executeWorkflow.mutate(draft)} disabled={executeWorkflow.isPending} type="button" title="Run">
                    <Play size={15} />
                    Run
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => (draft.status === "paused" ? resumeWorkflow.mutate(draft) : pauseWorkflow.mutate(draft))}
                    disabled={pauseWorkflow.isPending || resumeWorkflow.isPending}
                    type="button"
                    title={draft.status === "paused" ? "Resume" : "Pause"}
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
                    title="Cancel"
                  >
                    <Square size={15} />
                    Cancel
                  </Button>
                </div>
              </div>
              <ReactFlow
                nodes={canvasNodes}
                edges={flowEdges}
                nodeTypes={workflowNodeTypes}
                edgeTypes={workflowEdgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onInit={(instance) => {
                  flowInstanceRef.current = instance
                }}
                fitView
                fitViewOptions={{ padding: 0.16 }}
                deleteKeyCode={["Backspace", "Delete"]}
                elementsSelectable
                nodesConnectable
                nodesDraggable
                onlyRenderVisibleElements
                onConnect={onConnect}
                onNodeClick={(_, node) => {
                  if (isFanoutStackNodeId(node.id)) {
                    const key = node.id.slice(FANOUT_STACK_NODE_PREFIX.length)
                    if (key.endsWith(":expanded-control")) return
                    expandFanoutGroup(key)
                    setSelectedEdgeId("")
                    return
                  }
                  setSelectedNodeId(node.id)
                  setSelectedEdgeId("")
                }}
                onEdgeClick={(_, edge) => {
                  if (isStackEdgeId(edge.id)) return
                  setSelectedEdgeId(edge.id)
                  setSelectedNodeId("")
                }}
                onNodeDragStart={() => setIsDraggingNode(true)}
                onNodeDragStop={(_, node) => {
                  setIsDraggingNode(false)
                  if (isFanoutStackNodeId(node.id)) {
                    const key = node.id.slice(FANOUT_STACK_NODE_PREFIX.length)
                    setFanoutStackPositions((current) => ({
                      ...current,
                      [key]: { x: node.position.x, y: node.position.y },
                    }))
                    return
                  }
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
            <div className="workflow-terminal">
              <div className="workflow-terminal-head">
                <div className="workflow-terminal-title">
                  <Terminal size={14} />
                  <strong>Terminal</strong>
                  {draft?.status && <span className={statusClass(draft.status)}>{draft.status}</span>}
                  <span className={statusClass(executionState)}>{executionStateLabel(executionState)}</span>
                </div>
                <div className="workflow-terminal-filters" aria-label="Terminal event filters">
                  {workflowEventFilterOptions.map((option) => (
                    <button
                      className={`terminal-filter ${workflowEventFilter === option.value ? "terminal-filter-active" : ""}`}
                      key={option.value}
                      onClick={() => setWorkflowEventFilter(option.value)}
                      type="button"
                    >
                      <span>{option.label}</span>
                      <b>{workflowTerminalCounts[option.value].toLocaleString()}</b>
                    </button>
                  ))}
                </div>
                <div className="workflow-terminal-meta">
                  <button
                    className={`terminal-filter ${showFullWorkflowLog ? "terminal-filter-active" : ""}`}
                    onClick={() => setShowFullWorkflowLog((current) => !current)}
                    type="button"
                  >
                    <span>{showFullWorkflowLog ? "Full log" : "Compact"}</span>
                  </button>
                  <span>{workflowTerminalStats.aris.toLocaleString()} ARIS</span>
                  <span>{workflowTerminalStats.total.toLocaleString()} events</span>
                </div>
              </div>
              <div className="workflow-log" ref={workflowLogRef}>
                {displayedWorkflowEvents.map((event, index) => {
                  const metaItems = workflowEventMetaItems(event)
                  const payloadText = workflowEventPayloadText(event)
                  return (
                    <div
                      className={`term-line term-${event.event_type} ${showFullWorkflowLog ? "term-line-full" : ""}`}
                      key={`${event.timestamp}-${index}`}
                    >
                      <span className="term-time">{event.timestamp.slice(11, 19)}</span>
                      <b title={workflowEventTitle(event)}>{workflowEventLabel(event)}</b>
                      <div className="term-body">
                        <p>{event.message}</p>
                        {showFullWorkflowLog && metaItems.length > 0 && (
                          <div className="term-meta-list">
                            {metaItems.map((item) => (
                              <span key={`${event.timestamp}-${index}-${item.key}`}>
                                {item.key}: <strong>{item.value}</strong>
                              </span>
                            ))}
                          </div>
                        )}
                        {showFullWorkflowLog && payloadText && (
                          <details className="term-payload-details">
                            <summary>payload</summary>
                            <pre>{payloadText}</pre>
                          </details>
                        )}
                      </div>
                    </div>
                  )
                })}
                {displayedWorkflowEvents.length === 0 && (
                  <div className="terminal-empty">No events in this category.</div>
                )}
              </div>
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
              This edge means the target Agent or Gate waits for the source node to finish.
            </p>
            <div className="handoff-preview-box">
              <div className="handoff-preview-head">
                <span>Handoff preview</span>
                <Badge>{selectedHandoff?.content_type ?? "none"}</Badge>
              </div>
              {selectedHandoff ? (
                <>
                  <div className="runtime-kv">
                    <span>source</span>
                    <b>{selectedHandoff.source_name || selectedHandoff.source}</b>
                    <span>target</span>
                    <b>{selectedHandoff.target_name || selectedHandoff.target}</b>
                    {selectedHandoff.output_path && (
                      <>
                        <span>output</span>
                        <b>{selectedHandoff.output_path}</b>
                      </>
                    )}
                  </div>
                  <pre>{selectedHandoff.preview || "No upstream content is available yet."}</pre>
                </>
              ) : (
                <p className="muted">No handoff preview has been recorded for this dependency yet.</p>
              )}
            </div>
            <Button variant="destructive" onClick={() => removeEdges([selectedEdge.id])} type="button">
              <XCircle size={15} />
              Remove edge
            </Button>
          </>
        ) : draft && selectedNode ? (
          <>
            <div className="selected-skill">
              <div className="node-editor-title">
                <span className={`node-kind node-kind-${selectedNode.skill === "research-lit" && selectedNode.dynamic_parent_id ? "research" : selectedNode.type}`}>
                  {selectedNode.type === "human_gate" ? <ClipboardCheck size={13} /> : <Cpu size={13} />}
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
            {(selectedNode.session_path || selectedNode.dynamic_parent_id || selectedNode.status === "waiting_dynamic_dependency") && (
              <div className="dynamic-node-box">
                {selectedNode.session_path && <p>session {selectedNode.session_path}</p>}
                {selectedNode.dynamic_parent_id && <p>planned from {selectedNode.dynamic_parent_id}</p>}
                {selectedNode.status === "waiting_dynamic_dependency" && <p>waiting for literature</p>}
                {selectedNode.dynamic_reason && <p>{selectedNode.dynamic_reason}</p>}
                {selectedNode.research_request && <pre>{jsonPreview(selectedNode.research_request, 900)}</pre>}
              </div>
            )}
            <div className="session-inspector">
              <div className="runtime-card-head">
                <span>
                  <Terminal size={14} />
                  Session Inspector
                </span>
                <Badge>{selectedSession.data?.kind ?? "node"}</Badge>
              </div>
              <div className="runtime-kv">
                <span>session</span>
                <b>{selectedSession.data?.session_id ?? selectedRuntimeSessionId ?? "none"}</b>
                <span>events</span>
                <b>{selectedSession.data?.events.length ?? 0}</b>
                <span>artifacts</span>
                <b>{selectedSession.data?.artifact_refs.length ?? selectedNodeRuntimeArtifacts.length}</b>
              </div>
              {selectedBlockedSession && (
                <div className="blocked-session-box">
                  <strong>blocked by dynamic dependency</strong>
                  <span>{String(selectedBlockedSession["reason"] ?? "waiting for literature")}</span>
                  <small>{jsonPreview(selectedBlockedSession["blocked_by"] ?? [], 220)}</small>
                </div>
              )}
              {(selectedSession.data?.artifact_refs.length ? selectedSession.data.artifact_refs : selectedNodeRuntimeArtifacts).slice(0, 4).map((artifact) => (
                <button
                  className="session-artifact-row"
                  key={artifact.path}
                  onClick={() =>
                    setArtifactPreview({
                      workspace: draft.workspace,
                      path: artifact.path,
                      nodeId: selectedNode.id,
                      nodeName: selectedNode.name,
                      artifact: artifactsByPath.get(artifact.path),
                    })
                  }
                  type="button"
                >
                  <FileText size={13} />
                  <span>{artifact.path}</span>
                </button>
              ))}
            </div>
            <div className="node-editor-actions">
              <Button
                variant="secondary"
                onClick={() => runNode.mutate({ workflow: draft, nodeId: selectedNode.id })}
                disabled={!isExecutableNode(selectedNode) || runNode.isPending || rerunNode.isPending}
                type="button"
                title="Save current node settings, then run only this node"
              >
                <Play size={15} />
                Save & run
              </Button>
              <Button
                variant="secondary"
                onClick={() => rerunNode.mutate({ workflow: draft, nodeId: selectedNode.id })}
                disabled={!isExecutableNode(selectedNode) || runNode.isPending || rerunNode.isPending}
                type="button"
                title="Save current node settings, then rerun this node and reset downstream nodes"
              >
                <RefreshCcw size={15} />
                Save & rerun
              </Button>
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
                onClick={() =>
                  selectedNode.status === "skipped"
                    ? restoreNode.mutate({ workflow: draft, nodeId: selectedNode.id })
                    : skipNode.mutate({ workflow: draft, nodeId: selectedNode.id })
                }
                disabled={skipNode.isPending || restoreNode.isPending}
                type="button"
                title={selectedNode.status === "skipped" ? "Restore this skipped node to queued" : "Skip this node"}
              >
                {selectedNode.status === "skipped" && <RefreshCcw size={15} />}
                {selectedNode.status === "skipped" ? "Restore" : "Skip"}
              </Button>
            </div>
            {isExecutableNode(selectedNode) && (
              <div className="node-run-settings">
                <div>
                  <label>Run model</label>
                  <Select
                    value={selectedNode.model ?? ""}
                    onChange={(event) =>
                      updateNode(selectedNode.id, (node) => {
                        node.model = event.target.value || null
                      })
                    }
                  >
                    <option value="">{nodeModelDefaultLabel}</option>
                    {nodeModelOptions.map((modelOption) => (
                      <option key={modelOption} value={modelOption}>
                        {modelProviderLabels.get(modelOption) ? `${modelOption} · ${modelProviderLabels.get(modelOption)}` : modelOption}
                      </option>
                    ))}
                  </Select>
                </div>
                <p className="muted">This value is saved before Save & run / Save & rerun starts the node.</p>
              </div>
            )}
            <label>Type</label>
            <Select
              value={selectedNode.type === "sub_agent" ? "agent" : selectedNode.type}
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
              <option value="human_gate">Gate</option>
            </Select>
            <label>Name</label>
            <Input value={selectedNode.name} onChange={(event) => updateNode(selectedNode.id, (node) => (node.name = event.target.value))} />
            <label>Role</label>
            <Input value={selectedNode.role} onChange={(event) => updateNode(selectedNode.id, (node) => (node.role = event.target.value))} />
            {selectedNode.type === "sub_agent" && (
              <>
                <label>
                  Agent Profile
                  <small className="inline-hint"> executor defaults</small>
                </label>
                <Select
                  value={selectedNode.config_file ?? ""}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) => {
                      node.config_file = event.target.value || null
                    })
                  }
                >
                  <option value="">Default agent (no profile)</option>
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
                      : "Ad-hoc agent"}
                  </option>
                  {(skills.data ?? []).map((skill) => (
                    <option key={skill.id} value={skill.id}>
                      /{skill.id}
                    </option>
                  ))}
                </Select>
              </>
            )}
            <div className="field-head">
              <label>{selectedNode.type === "human_gate" ? "Gate instructions" : "Prompt"}</label>
              <Button
                variant="secondary"
                onClick={() =>
                  optimizeNodePrompt.mutate({
                    workflow: draft,
                    nodeId: selectedNode.id,
                    instructions: promptOptimizationNote,
                    model: selectedNode.model ?? selectedNodeConfig?.model ?? settings.data?.model ?? null,
                  })
                }
                disabled={!selectedNode.prompt.trim() || optimizeNodePrompt.isPending}
                type="button"
                title="Ask the configured LLM to improve this node prompt"
              >
                <Wand2 size={14} />
                {optimizeNodePrompt.isPending ? "Optimizing" : "Optimize prompt"}
              </Button>
            </div>
            <Textarea
              rows={selectedNode.type === "human_gate" ? 5 : 8}
              value={selectedNode.prompt}
              onChange={(event) => updateNode(selectedNode.id, (node) => (node.prompt = event.target.value))}
            />
            <div className="prompt-optimizer-row">
              <Input
                value={promptOptimizationNote}
                onChange={(event) => setPromptOptimizationNote(event.target.value)}
                placeholder="Optional focus, e.g. stricter output format, shorter prompt, add success criteria"
              />
            </div>
            {optimizeNodePrompt.error && <p className="error-text">{optimizeNodePrompt.error.message}</p>}
            {promptSuggestion?.nodeId === selectedNode.id && (
              <div className="prompt-suggestion">
                <div className="prompt-suggestion-head">
                  <strong>Optimized prompt suggestion</strong>
                  <div>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        updateNode(selectedNode.id, (node) => {
                          node.prompt = promptSuggestion.prompt
                        })
                        setPromptSuggestion(null)
                      }}
                      type="button"
                    >
                      Apply
                    </Button>
                    <Button variant="ghost" onClick={() => setPromptSuggestion(null)} type="button">
                      Discard
                    </Button>
                  </div>
                </div>
                <pre>{promptSuggestion.prompt}</pre>
              </div>
            )}
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
              </details>
            )}
            {selectedNode.error && <p className="error-text">{selectedNode.error}</p>}
            <div className="node-editor-danger-zone">
              <Button variant="destructive" onClick={() => removeNode(selectedNode.id)} type="button">
                Remove
              </Button>
            </div>
          </>
        ) : (
          <p className="muted">Select a DAG node to edit it.</p>
        )}
      </aside>
      <NodeArtifactDialog preview={artifactPreview} onClose={() => setArtifactPreview(null)} />
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
    <div className="page-grid runs-grid">
      <section className="panel runs-list-panel">
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
      <aside className="console-panel runs-console-panel">
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
  { value: "openai", label: "GPT / OpenAI-compatible", hint: "Works with OpenAI and most proxy endpoints." },
  { value: "anthropic", label: "Anthropic-compatible", hint: "Uses x-api-key and Anthropic message/model endpoints." },
  { value: "gemini", label: "Gemini OpenAI-compatible", hint: "Google Gemini via its OpenAI-compatible endpoint." },
  { value: "glm", label: "GLM OpenAI-compatible", hint: "Zhipu/GLM via OpenAI-compatible endpoint." },
  { value: "kimi", label: "Kimi OpenAI-compatible", hint: "Moonshot/Kimi via OpenAI-compatible endpoint." },
  { value: "minimax", label: "MiniMax Anthropic-compatible", hint: "MiniMax through the Anthropic-compatible API." },
  { value: "custom", label: "Custom OpenAI-compatible", hint: "Any endpoint that accepts OpenAI-style requests." },
]

function uniqueModelOptions(...groups: Array<string | null | undefined | readonly string[]>): string[] {
  const seen = new Set<string>()
  const options: string[] = []
  groups.forEach((group) => {
    const values = Array.isArray(group) ? group : [group]
    values.forEach((value) => {
      const item = typeof value === "string" ? value.trim() : ""
      if (!item || seen.has(item)) return
      seen.add(item)
      options.push(item)
    })
  })
  return options
}

function splitModelCatalog(value: string) {
  return uniqueModelOptions(value.split(/[\n,]/))
}

function joinModelCatalog(models?: readonly string[]) {
  return (models ?? []).join("\n")
}

function baseUrlFromValidationEndpoint(endpoint?: string | null) {
  const value = endpoint?.trim()
  if (!value) return ""
  for (const suffix of ["/models", "/chat/completions"]) {
    if (value.endsWith(suffix)) return value.slice(0, -suffix.length)
  }
  return ""
}

function SettingsPage() {
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const [expandedProvider, setExpandedProvider] = useState<GlobalApiProvider>("openai")
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState("")
  const [modelsText, setModelsText] = useState("")
  const [effort, setEffort] = useState("")
  const providerProfiles = useMemo(() => {
    const next = new Map<GlobalApiProvider, GlobalProviderSettings>()
    for (const profile of settings.data?.providers ?? []) next.set(profile.provider, profile)
    return next
  }, [settings.data?.providers])
  const updateSettings = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (item) => {
      queryClient.setQueryData(["settings"], item)
      queryClient.invalidateQueries({ queryKey: ["health"] })
      setApiKey("")
    },
  })
  const validateSettings = useMutation({
    mutationFn: api.validateSettings,
    onSuccess: (result) => {
      const inferredBaseUrl = baseUrlFromValidationEndpoint(result.endpoint)
      if (result.ok && result.provider === expandedProvider && inferredBaseUrl) {
        setBaseUrl(inferredBaseUrl)
      }
      if (result.provider === expandedProvider && result.models.length > 0 && splitModelCatalog(modelsText).length === 0) {
        setModelsText(joinModelCatalog(result.models))
      }
    },
  })

  useEffect(() => {
    if (!settings.data) return
    setExpandedProvider(settings.data.providers.find((item) => item.active)?.provider ?? settings.data.provider)
  }, [settings.data])

  const selectedProfile = providerProfiles.get(expandedProvider)
  const selectedProvider = providerOptions.find((item) => item.value === expandedProvider)
  const configuredCount = (settings.data?.providers ?? []).filter((item) => item.api_key_set).length
  const selectedKeySet = Boolean(selectedProfile?.api_key_set)

  useEffect(() => {
    if (!settings.data) return
    const profile = providerProfiles.get(expandedProvider)
    setApiKey("")
    setBaseUrl(profile?.base_url ?? "")
    setModel(profile?.model ?? "")
    setModelsText(joinModelCatalog(profile?.models))
    setEffort(profile?.effort ?? "")
  }, [expandedProvider, providerProfiles, settings.data])

  function settingsPayload(clearApiKey = false, targetProvider: GlobalApiProvider = expandedProvider) {
    const profile = providerProfiles.get(targetProvider)
    const isExpanded = targetProvider === expandedProvider
    return {
      provider: targetProvider,
      api_key: isExpanded ? apiKey || null : null,
      clear_api_key: clearApiKey,
      base_url: isExpanded ? baseUrl || null : profile?.base_url ?? null,
      model: isExpanded ? model || null : profile?.model ?? null,
      models: isExpanded ? splitModelCatalog(modelsText) : profile?.models ?? [],
      effort: isExpanded ? effort || null : profile?.effort ?? null,
    }
  }

  function save(clearApiKey = false) {
    updateSettings.mutate(settingsPayload(clearApiKey))
  }

  function validateConnection() {
    validateSettings.mutate(settingsPayload(false))
  }

  function validateProvider(targetProvider: GlobalApiProvider) {
    validateSettings.mutate(settingsPayload(false, targetProvider))
  }

  const validationResult = validateSettings.data
  const validation = validationResult?.provider === expandedProvider ? validationResult : null
  const validationModels = validation?.models ?? []
  const configuredProviderOptions = providerOptions.filter((option) => providerProfiles.get(option.value)?.api_key_set)
  const addableProviderOptions = providerOptions.filter((option) => !providerProfiles.get(option.value)?.api_key_set)

  function selectProvider(value: string) {
    if (!value) return
    setExpandedProvider(value as GlobalApiProvider)
    validateSettings.reset()
  }

  return (
    <section className="settings-page">
      <div className="settings-hero">
        <div className="settings-hero-main">
          <div className="settings-hero-icon">
            <KeyRound size={22} />
          </div>
          <div>
            <h1>API Configuration</h1>
            <p>Configured providers stay visible. Add new ones only when you need them.</p>
          </div>
        </div>
        <div className={`settings-status-pill ${configuredCount > 0 ? "is-ok" : "is-missing"}`}>
          {configuredCount > 0 ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <div>
            <span>Configured APIs</span>
            <strong>{configuredCount === 1 ? "1 provider" : `${configuredCount} providers`}</strong>
          </div>
        </div>
      </div>

      <section className="settings-provider-panel">
        <div className="settings-provider-panel-head">
          <div>
            <h2>Configured Providers</h2>
            <p>Only providers with saved API keys are shown here.</p>
          </div>
          <div className="settings-add-provider">
            <label htmlFor="settings-add-provider">Add provider</label>
            <Select
              id="settings-add-provider"
              value={selectedKeySet ? "" : expandedProvider}
              onChange={(event) => selectProvider(event.target.value)}
            >
              <option value="">{addableProviderOptions.length ? "Choose provider to configure" : "All providers configured"}</option>
              {addableProviderOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {configuredProviderOptions.length > 0 ? (
          <div className="settings-provider-grid">
            {configuredProviderOptions.map((option) => {
              const profile = providerProfiles.get(option.value)
              const active = Boolean(profile?.active)
              const lastValidation = validationResult?.provider === option.value ? validationResult : null
              return (
                <section
                  className={`settings-provider-card ${expandedProvider === option.value ? "selected" : ""}`}
                  key={option.value}
                >
                  <button className="settings-provider-main" onClick={() => selectProvider(option.value)} type="button">
                    <div className="settings-provider-top">
                      <strong>{option.label}</strong>
                      <div className="settings-provider-badges">
                        {active && <Badge>active</Badge>}
                        <Badge className="provider-ok">configured</Badge>
                      </div>
                    </div>
                    <span>{profile?.api_key_masked ? `Key ${profile.api_key_masked}` : "Key saved"}</span>
                    <small>{profile?.model ?? "default model"}</small>
                    <small title={profile?.base_url ?? ""}>{profile?.base_url ?? "provider default endpoint"}</small>
                  </button>
                  <div className="settings-provider-actions">
                    {lastValidation && (
                      <span className={lastValidation.ok ? "ok" : "bad"}>
                        {lastValidation.ok ? "verified" : "failed"}
                      </span>
                    )}
                    <Button
                      disabled={validateSettings.isPending && validateSettings.variables?.provider === option.value}
                      onClick={() => validateProvider(option.value)}
                      type="button"
                      variant="secondary"
                    >
                      {validateSettings.isPending && validateSettings.variables?.provider === option.value ? "Testing..." : "Test"}
                    </Button>
                  </div>
                </section>
              )
            })}
          </div>
        ) : (
          <div className="settings-provider-empty">
            <strong>No providers configured yet.</strong>
            <span>Choose a provider above, add its key and endpoint, then save it.</span>
          </div>
        )}
      </section>

      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          save(false)
        }}
      >
        <div className="settings-main">
          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h2>{selectedProvider?.label ?? expandedProvider}</h2>
                <p>{selectedKeySet ? "Edit this provider connection, then save or test it." : "Add this provider by entering its key and connection settings."}</p>
              </div>
              <Badge>{selectedKeySet ? "configured" : "new provider"}</Badge>
            </div>
            <div className="settings-field-grid">
              <div className="settings-field settings-field-full">
                <label>API key</label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={selectedKeySet ? "Leave blank to keep existing key" : "Paste API key"}
                />
                <div className={`settings-key-state ${selectedKeySet ? "is-ok" : "is-missing"}`}>
                  {selectedKeySet ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <span>
                    {selectedKeySet
                      ? `Saved key: ${selectedProfile?.api_key_masked ?? "configured"}. Leave this field blank to keep it.`
                      : "No API key saved yet."}
                  </span>
                </div>
              </div>
              <div className="settings-field settings-field-full">
                <label>Base URL</label>
                <Input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="Optional, e.g. https://api.openai.com/v1"
                />
              </div>
              <div className="settings-field">
                <label>Default model</label>
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="e.g. gpt-5.4"
                />
              </div>
              <div className="settings-field">
                <label>Reasoning effort</label>
                <Select value={effort} onChange={(event) => setEffort(event.target.value)}>
                  <option value="">Default</option>
                  <option value="none">none</option>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </Select>
              </div>
            </div>
            <p className="settings-inline-hint">{selectedProvider?.hint}</p>
          </section>

          {(validateSettings.isPending || validateSettings.error || validation) && (
            <section className={`settings-validation ${validation?.ok ? "is-ok" : validation ? "is-bad" : ""}`}>
              <div className="settings-section-head">
                <div>
                  <h2>Validation</h2>
                  <p>Endpoint check result for this provider.</p>
                </div>
                {validateSettings.isPending ? <Badge>checking</Badge> : validation?.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              </div>
              {validateSettings.isPending && <p>Checking endpoint...</p>}
              {validateSettings.error && <p className="error-text">{validateSettings.error.message}</p>}
              {validation && (
                <>
                  <p>{validation.message}</p>
                  <dl className="settings-summary-grid">
                    <div className="settings-summary-row">
                      <dt>Endpoint</dt>
                      <dd title={validation.endpoint ?? ""}>{validation.endpoint ?? "not available"}</dd>
                    </div>
                    <div className="settings-summary-row">
                      <dt>Model</dt>
                      <dd title={validation.model ?? ""}>{validation.model ?? "provider default"}</dd>
                    </div>
                    <div className="settings-summary-row">
                      <dt>Models</dt>
                      <dd>{validation.model_count.toLocaleString()}</dd>
                    </div>
                  </dl>
                  {validationModels.length > 0 && (
                    <div className="settings-validation-models">
                      {validationModels.slice(0, 12).map((item) => (
                        <Badge key={item}>{item}</Badge>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>

        <div className="settings-footer">
          <div className="settings-save-state">
            {updateSettings.error && <span className="error-text">{updateSettings.error.message}</span>}
            {updateSettings.isSuccess && !updateSettings.error && <span>Settings saved.</span>}
            {!updateSettings.isSuccess && !updateSettings.error && (
              <span title={settings.data?.config_path ?? ""}>Stored locally at {settings.data?.config_path ?? "the ARIS Web settings file"}.</span>
            )}
          </div>
          <div className="console-actions">
            <Button disabled={validateSettings.isPending || settings.isLoading} onClick={validateConnection} type="button" variant="secondary">
              {validateSettings.isPending ? "Validating..." : "Validate connection"}
            </Button>
            <Button disabled={updateSettings.isPending || settings.isLoading} type="submit">
              <Save size={15} />
              Save settings
            </Button>
            <Button
              variant="destructive"
              onClick={() => save(true)}
              disabled={!selectedKeySet || updateSettings.isPending}
              type="button"
            >
              <XCircle size={15} />
              Clear key
            </Button>
          </div>
        </div>
      </form>
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
