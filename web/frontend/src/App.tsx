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
  RunEvent,
  RunOutput,
  RunRecord,
  SkillInfo,
  WorkflowDeltaRecord,
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

const WORKFLOW_EVENT_LIMIT = 5000

function statusClass(status: string) {
  return `status status-${status}`
}

function isLiveWorkflowStatus(status?: string | null) {
  return status === "running" || status === "paused"
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

  const layerCount = Math.max(...Array.from(rowsByLayer.keys()), 0) + 1
  const maxRowsInLayer = Math.max(...Array.from(rowsByLayer.values()).map((ids) => ids.length), 1)
  const nodeCount = workflow.graph_json.nodes.length
  const columnsPerBand = Math.min(layerCount, Math.min(5, Math.max(3, Math.ceil(Math.sqrt(nodeCount * 1.7)))))
  const xGap = layerCount > columnsPerBand ? 260 : 300
  const yGap = maxRowsInLayer > 2 ? 126 : 148
  const bandHeight = Math.max(250, maxRowsInLayer * yGap + 88)
  const originX = 96
  const originY = 96

  workflow.graph_json.nodes = workflow.graph_json.nodes.map((node) => {
    const layer = layerById.get(node.id) ?? 0
    const row = rowsByLayer.get(layer)?.indexOf(node.id) ?? 0
    const band = Math.floor(layer / columnsPerBand)
    const columnInBand = layer % columnsPerBand
    const visualColumn = band % 2 === 0 ? columnInBand : columnsPerBand - 1 - columnInBand
    const idsInLayer = rowsByLayer.get(layer) ?? []
    const verticalInset = ((maxRowsInLayer - idsInLayer.length) * yGap) / 2
    return {
      ...node,
      position: {
        x: originX + visualColumn * xGap,
        y: originY + band * bandHeight + verticalInset + row * yGap,
      },
    }
  })
}

function nodeKindLabel(node: WorkflowNodeInfo) {
  if (node.type === "human_gate") return "Gate"
  if (node.skill === "research-lit" && node.dynamic_parent_id) return "Research"
  return "Agent"
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
  const runId = node.run_id ?? ""
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
    const socket = new WebSocket(api.workflowNodeStreamUrl(workflow, node.id))
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as WorkflowEvent
      setNodeEvents((current) => [...current, event].slice(-1000))
      if (runId && ["node", "run", "result"].includes(event.event_type)) {
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
  const nodesWithRuns = useMemo(() => (draft?.graph_json.nodes ?? []).filter((node) => Boolean(node.run_id)), [draft?.graph_json.nodes])
  const nodeOutputQueries = useQueries({
    queries: nodesWithRuns.map((node) => ({
      queryKey: ["run-output", workspace, node.run_id],
      queryFn: () => api.runOutput(workspace, node.run_id as string),
      enabled: Boolean(workspace && node.run_id),
      staleTime: 5000,
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
  const selected = (workflows.data ?? []).find((workflow) => workflow.id === selectedId) ?? workflows.data?.[0]
  const artifactsByPath = useMemo(() => artifactByPath(workspaceArtifacts.data), [workspaceArtifacts.data])
  const runtime = useQuery<WorkflowRuntimeResponse>({
    queryKey: ["workflow-runtime", selected?.id],
    queryFn: () => api.workflowRuntime(selected as WorkflowRecord),
    enabled: Boolean(selected),
    refetchInterval: isLiveWorkflowStatus(selected?.status) ? 5000 : false,
  })
  const decisions = useQuery({
    queryKey: ["workflow-decisions", selected?.id],
    queryFn: () => api.workflowDecisions(selected as WorkflowRecord),
    enabled: Boolean(selected),
    refetchInterval: isLiveWorkflowStatus(selected?.status) ? 7000 : false,
  })
  const deltas = useQuery({
    queryKey: ["workflow-deltas", selected?.id],
    queryFn: () => api.workflowDeltas(selected as WorkflowRecord),
    enabled: Boolean(selected),
    refetchInterval: isLiveWorkflowStatus(selected?.status) ? 7000 : false,
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
    const socket = new WebSocket(api.workflowStreamUrl(selected))
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as WorkflowEvent
      setEvents((current) => [...current, event].slice(-WORKFLOW_EVENT_LIMIT))
      if (["workflow", "node", "planner", "delta", "session", "approval"].includes(event.event_type)) {
        scheduleWorkflowRefresh()
        scheduleArtifactRefresh()
        queryClient.invalidateQueries({ queryKey: ["workflow-runtime", selected.id] })
        queryClient.invalidateQueries({ queryKey: ["workflow-decisions", selected.id] })
        queryClient.invalidateQueries({ queryKey: ["workflow-deltas", selected.id] })
      }
    }
    return () => socket.close()
  }, [queryClient, scheduleArtifactRefresh, scheduleWorkflowRefresh, selected?.id, selected?.workspace, workspace])

  useEffect(() => {
    return () => {
      if (workflowRefreshTimerRef.current !== null) window.clearTimeout(workflowRefreshTimerRef.current)
      if (artifactRefreshTimerRef.current !== null) window.clearTimeout(artifactRefreshTimerRef.current)
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
      queryClient.removeQueries({ queryKey: ["workflow-decisions", workflow.id] })
      queryClient.removeQueries({ queryKey: ["workflow-deltas", workflow.id] })
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
  const optimizeNodePrompt = useMutation({
    mutationFn: ({ workflow, nodeId, instructions }: { workflow: WorkflowRecord; nodeId: string; instructions: string }) =>
      api.optimizeWorkflowNodePrompt(workflow, nodeId, {
        graph_json: workflow.graph_json,
        instructions: instructions.trim() || null,
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
  const nodeModelOptions = uniqueModelOptions(
    selectedNode?.model,
    selectedNodeConfig?.model,
    settings.data?.model,
    settings.data?.models ?? [],
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
  const executionAction = runtimeSummary?.next_action || "Runtime state has not been recorded yet."
  const executionLastEvent = runtimeSummary?.last_event_at ? runtimeSummary.last_event_at.slice(11, 19) : "no events"
  const activeNodeIds = runtimeSummary?.active_node_ids ?? []
  const waitingApprovalIds = runtimeSummary?.waiting_approval_node_ids ?? []
  const waitingLiteratureIds = runtimeSummary?.waiting_dynamic_dependency_node_ids ?? []
  const readyNodeIds = runtimeSummary?.ready_node_ids ?? []
  const latestDecision =
    runtime.data?.latest_decision ?? (decisions.data?.length ? decisions.data[decisions.data.length - 1] : null)
  const recentDecisionCards = useMemo(() => [...(decisions.data ?? [])].slice(-4).reverse(), [decisions.data])
  const recentDeltaCards = useMemo(() => [...(deltas.data ?? [])].slice(-5).reverse(), [deltas.data])
  const recentRuntimeEvents = useMemo(
    () => events.filter((event) => ["planner", "delta", "session", "approval"].includes(event.event_type)).slice(-8).reverse(),
    [events],
  )
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
    () =>
      (draft?.graph_json.nodes ?? []).map((node) => {
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
      }),
    [artifactsByPath, draft, agentConfigs.data, nodeSequence, runOutputByRunId, workspace, workspaceArtifacts.data],
  )
  useEffect(() => {
    if (!isDraggingNode) {
      setCanvasNodes(draftFlowNodes)
    }
  }, [draftFlowNodes, isDraggingNode])

  const flowEdges: WorkflowCanvasEdge[] = useMemo(
    () => {
      const nodesById = new Map((draft?.graph_json.nodes ?? []).map((node) => [node.id, node]))
      return (draft?.graph_json.edges ?? []).map((edge) => {
        const source = nodesById.get(edge.source)
        const target = nodesById.get(edge.target)
        const handoff = handoffByEdge.get(handoffKey(edge.source, edge.target))
        const plannerInserted = Boolean(source?.dynamic_parent_id || (target?.status === "waiting_dynamic_dependency" && target.depends_on.includes(edge.source)))
        const handoffLabel = edgeHandoffLabel(handoff, plannerInserted)
        const classes = [
          edge.id === selectedEdgeId ? "flow-edge-selected" : "",
          plannerInserted ? "flow-edge-planner" : "",
          handoff?.preview ? "flow-edge-handoff" : "",
          target?.status === "waiting_dynamic_dependency" ? "flow-edge-blocking" : "",
        ].filter(Boolean)
        return {
          id: edge.id,
          type: "workflowHandoff",
          source: edge.source,
          target: edge.target,
          markerEnd: { type: MarkerType.ArrowClosed },
          selected: edge.id === selectedEdgeId,
          data: {
            label: handoffLabel,
            onOpen: openEdgePanel,
          },
          ariaLabel: handoffLabel ? `${handoffLabel}. Click to view handoff preview.` : undefined,
          focusable: Boolean(handoffLabel),
          interactionWidth: handoffLabel ? 28 : 20,
          className: classes.join(" ") || undefined,
        }
      })
    },
    [draft, handoffByEdge, openEdgePanel, selectedEdgeId],
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

  function handleDeleteWorkflow(workflow: WorkflowRecord | null = draft) {
    if (!workflow) return
    if (!globalThis.confirm(`Delete Flow "${workflow.title}"? This cannot be undone.`)) return
    deleteWorkflow.mutate(workflow)
  }

  return (
    <div className={`orchestrator-grid workflow-layout ${flowPanelCollapsed ? "flows-collapsed" : ""}`}>
      <aside className="orchestrator-left panel">
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
              <ChevronRight size={15} />
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
              {flowPanelCollapsed && (
                <div className="console-actions">
                  <Button
                    variant="secondary"
                    onClick={() => setFlowPanelCollapsed(false)}
                    type="button"
                    aria-label="Show flows"
                    title="Show flows"
                  >
                    <GitBranch size={15} />
                    Flows
                  </Button>
                </div>
              )}
            </div>
            {deleteWorkflow.error && <p className="error-text">{deleteWorkflow.error.message}</p>}
            <section className={`execution-state-panel execution-state-${executionState}`}>
              <div className="execution-state-main">
                <span className="execution-state-eyebrow">
                  <Activity size={14} />
                  Execution state
                </span>
                <div className="execution-state-title-row">
                  <strong>{executionStateLabel(executionState)}</strong>
                  <span className={statusClass(executionState)}>{executionState}</span>
                  {runtimeSummary?.planner_active && <Badge>planner active</Badge>}
                </div>
                <p>{executionAction}</p>
              </div>
              <div className="execution-state-metrics">
                <span>
                  <b>{runtimeSummary?.active_node_count ?? activeNodeIds.length}</b>
                  active
                </span>
                <span>
                  <b>{runtimeSummary?.ready_node_count ?? readyNodeIds.length}</b>
                  ready
                </span>
                <span>
                  <b>{runtimeSummary?.waiting_approval_count ?? waitingApprovalIds.length}</b>
                  approval
                </span>
                <span>
                  <b>{runtimeSummary?.waiting_dynamic_dependency_count ?? waitingLiteratureIds.length}</b>
                  literature wait
                </span>
                <span>
                  <b>{runtimeSummary?.failed_node_count ?? 0}</b>
                  failed
                </span>
              </div>
              <div className="execution-state-details">
                <span>last event: {executionLastEvent}</span>
                {activeNodeIds.length > 0 && <span>active: {activeNodeIds.join(", ")}</span>}
                {waitingApprovalIds.length > 0 && <span>approval: {waitingApprovalIds.join(", ")}</span>}
                {waitingLiteratureIds.length > 0 && <span>literature: {waitingLiteratureIds.join(", ")}</span>}
                {readyNodeIds.length > 0 && <span>ready: {readyNodeIds.join(", ")}</span>}
              </div>
            </section>
            <div className="runtime-workbench">
              <section className="runtime-card runtime-summary-card">
                <div className="runtime-card-head">
                  <span>
                    <Activity size={14} />
                    Runtime
                  </span>
                  <Badge>{runtimeSummary?.latest_decision_type ?? "no tick"}</Badge>
                </div>
                <div className="runtime-metrics">
                  <span>
                    <b>{runtimeSummary?.decision_count ?? 0}</b>
                    decisions
                  </span>
                  <span>
                    <b>{runtimeSummary?.delta_count ?? 0}</b>
                    deltas
                  </span>
                  <span>
                    <b>{runtimeSummary?.dynamic_node_count ?? 0}</b>
                    dynamic
                  </span>
                  <span>
                    <b>{runtimeSummary?.blocked_session_count ?? 0}</b>
                    blocked
                  </span>
                </div>
                <p>{latestDecision?.rationale || "Planner runtime has not recorded a decision yet."}</p>
                {runtimeSummary?.latest_tick_id && <small>tick {runtimeSummary.latest_tick_id}</small>}
              </section>

              <section className="runtime-card">
                <div className="runtime-card-head">
                  <span>
                    <Terminal size={14} />
                    Timeline
                  </span>
                  <Badge>{recentRuntimeEvents.length}</Badge>
                </div>
                <div className="runtime-list">
                  {recentRuntimeEvents.map((event, index) => (
                    <div className="runtime-row" key={`${event.timestamp}-${event.event_type}-${index}`}>
                      <b>{workflowEventLabel(event)}</b>
                      <span>{event.message}</span>
                      <small>{event.timestamp.slice(11, 19)}</small>
                    </div>
                  ))}
                  {!recentRuntimeEvents.length && <p className="muted">No runtime events yet.</p>}
                </div>
              </section>

              <section className="runtime-card">
                <div className="runtime-card-head">
                  <span>
                    <Layers3 size={14} />
                    Decision Cards
                  </span>
                  <Badge>{recentDecisionCards.length}</Badge>
                </div>
                <div className="runtime-list">
                  {recentDecisionCards.map((decision) => (
                    <div className="decision-card-mini" key={decision.tick_id}>
                      <div>
                        <Badge>{decision.decision_type}</Badge>
                        <small>{decision.trigger}</small>
                        {!decision.policy_result.allowed && <Badge>policy rejected</Badge>}
                      </div>
                      <strong>{decision.rationale || "No rationale recorded"}</strong>
                      <span>
                        {decision.before_graph_hash.slice(0, 8)}
                        {" -> "}
                        {decision.after_graph_hash.slice(0, 8)}
                      </span>
                    </div>
                  ))}
                  {!recentDecisionCards.length && <p className="muted">No decision cards yet.</p>}
                </div>
              </section>

              <section className="runtime-card">
                <div className="runtime-card-head">
                  <span>
                    <GitBranch size={14} />
                    Graph Diff
                  </span>
                  <Badge>{recentDeltaCards.length}</Badge>
                </div>
                <div className="runtime-list">
                  {recentDeltaCards.map((delta: WorkflowDeltaRecord) => (
                    <div className={`delta-card-mini ${delta.applied ? "delta-applied" : delta.policy_result.allowed ? "delta-noop" : "delta-rejected"}`} key={delta.delta_id}>
                      <div>
                        <Badge>{delta.action}</Badge>
                        <small>{delta.node_id || delta.target || delta.source || delta.delta_id}</small>
                      </div>
                      <span>{delta.reason || delta.policy_result.reason || "no reason"}</span>
                      <pre>{jsonPreview(delta.graph_diff, 260)}</pre>
                    </div>
                  ))}
                  {!recentDeltaCards.length && <p className="muted">No graph deltas yet.</p>}
                </div>
              </section>
            </div>
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
                onClick={() => skipNode.mutate({ workflow: draft, nodeId: selectedNode.id })}
                disabled={skipNode.isPending}
                type="button"
              >
                Skip
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
                        {modelOption}
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

function SettingsPage() {
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const [apiPreset, setApiPreset] = useState<(typeof apiPresets)[number]["id"]>("manual")
  const [provider, setProvider] = useState<GlobalApiProvider>("anthropic")
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState("")
  const [modelsText, setModelsText] = useState("")
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
    setModelsText(joinModelCatalog(settings.data.models))
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
    setModelsText((current) => joinModelCatalog(uniqueModelOptions(splitModelCatalog(current), preset.model)))
    setEffort(preset.effort)
  }

  function save(clearApiKey = false) {
    updateSettings.mutate({
      provider,
      api_key: apiKey || null,
      clear_api_key: clearApiKey,
      base_url: baseUrl || null,
      model: model || null,
      models: splitModelCatalog(modelsText),
      effort: effort || null,
    })
  }

  const selectedProvider = providerOptions.find((item) => item.value === provider)
  const selectedPreset = apiPresets.find((item) => item.id === apiPreset)
  const settingsModelOptions = uniqueModelOptions(model, splitModelCatalog(modelsText))
  const modelCatalog = splitModelCatalog(modelsText)
  const keyStatusLabel = settings.data?.api_key_set
    ? `${settings.data.provider} ${settings.data.api_key_masked ?? ""}`.trim()
    : "Not configured"
  const endpointLabel = baseUrl.trim() || "Provider default"
  const modelLabel = model.trim() || "Provider default"
  const effortLabel = effort.trim() || "Default"

  return (
    <section className="settings-page">
      <div className="settings-hero">
        <div className="settings-hero-main">
          <div className="settings-hero-icon">
            <KeyRound size={22} />
          </div>
          <div>
            <h1>API Configuration</h1>
            <p>Provider credentials and defaults for Web-launched ARIS runs.</p>
          </div>
        </div>
        <div className={`settings-status-pill ${settings.data?.api_key_set ? "is-ok" : "is-missing"}`}>
          {settings.data?.api_key_set ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <div>
            <span>API key</span>
            <strong>{keyStatusLabel}</strong>
          </div>
        </div>
      </div>

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
                <h2>Provider</h2>
                <p>{selectedPreset?.hint}</p>
              </div>
              <Badge>{apiPreset === "manual" ? "Manual" : "Preset"}</Badge>
            </div>
            <div className="settings-field-grid">
              <div className="settings-field">
                <label>Preset</label>
                <Select
                  value={apiPreset}
                  onChange={(event) => applyApiPreset(event.target.value as (typeof apiPresets)[number]["id"])}
                >
                  {apiPresets.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="settings-field">
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
              </div>
            </div>
            <div className="settings-note">
              <SlidersHorizontal size={15} />
              <span>{selectedProvider?.hint}</span>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h2>Connection</h2>
                <p>Key, endpoint, and default model used by the runner.</p>
              </div>
            </div>
            <div className="settings-field-grid">
              <div className="settings-field settings-field-full">
                <label>API key</label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={settings.data?.api_key_set ? "Leave blank to keep existing key" : "Paste API key"}
                />
              </div>
              <div className="settings-field settings-field-full">
                <label>Base URL</label>
                <Input
                  value={baseUrl}
                  onChange={(event) => {
                    setApiPreset("manual")
                    setBaseUrl(event.target.value)
                  }}
                  placeholder="Optional, e.g. https://api.openai.com/v1"
                />
              </div>
              <div className="settings-field">
                <label>Default reviewer model</label>
                <Select
                  value={model}
                  onChange={(event) => {
                    setApiPreset("manual")
                    setModel(event.target.value)
                  }}
                >
                  <option value="">Provider default</option>
                  {settingsModelOptions.map((modelOption) => (
                    <option key={modelOption} value={modelOption}>
                      {modelOption}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="settings-field">
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
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h2>Model Catalog</h2>
                <p>Models shown in node-level model selectors.</p>
              </div>
              <Badge>{modelCatalog.length} models</Badge>
            </div>
            <Textarea
              className="model-catalog-textarea"
              rows={6}
              value={modelsText}
              onChange={(event) => {
                setApiPreset("manual")
                setModelsText(event.target.value)
              }}
              placeholder="One model per line"
            />
          </section>
        </div>

        <aside className="settings-side">
          <section className="settings-summary">
            <div className="settings-summary-head">
              <h2>Runtime Preview</h2>
              <Badge>{provider}</Badge>
            </div>
            <dl className="settings-summary-grid">
              <div className="settings-summary-row">
                <dt>Endpoint</dt>
                <dd title={endpointLabel}>{endpointLabel}</dd>
              </div>
              <div className="settings-summary-row">
                <dt>Model</dt>
                <dd title={modelLabel}>{modelLabel}</dd>
              </div>
              <div className="settings-summary-row">
                <dt>Effort</dt>
                <dd>{effortLabel}</dd>
              </div>
            </dl>
          </section>

          <section className="settings-summary">
            <div className="settings-summary-head">
              <h2>Injected Variables</h2>
              <Badge>{settings.data?.applies_to?.length ?? 0}</Badge>
            </div>
            <div className="env-list settings-env-list">
              {(settings.data?.applies_to ?? []).map((item) => (
                <Badge key={item}>{item}</Badge>
              ))}
              {!settings.data?.applies_to?.length && <span className="muted">No runtime variables active.</span>}
            </div>
          </section>

          <section className="settings-summary">
            <div className="settings-summary-head">
              <h2>Storage</h2>
            </div>
            <div className="settings-code-line" title={settings.data?.config_path ?? ""}>
              {settings.data?.config_path ?? "Loading settings path..."}
            </div>
          </section>
        </aside>

        <div className="settings-footer">
          <div className="settings-save-state">
            {updateSettings.error && <span className="error-text">{updateSettings.error.message}</span>}
            {updateSettings.isSuccess && !updateSettings.error && <span>Settings saved.</span>}
            {!updateSettings.isSuccess && !updateSettings.error && <span>API keys are stored locally and are not returned by the API.</span>}
          </div>
          <div className="console-actions">
            <Button disabled={updateSettings.isPending || settings.isLoading} type="submit">
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
