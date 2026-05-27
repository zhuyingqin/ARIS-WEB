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
  TaskBoardResponse,
  TaskBoardTask,
  TeamMessage,
  TeamRoleKind,
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
import { Office3DScene, type Office3DDesk, type Office3DProblem, type Office3DSignal } from "./Office3DScene"

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

type WorkflowEventFilter = "all" | "aris" | "workflow" | "node" | "planner" | "team" | "problems" | "runtime" | "errors"

const workflowEventFilterOptions: { value: WorkflowEventFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "aris", label: "ARIS" },
  { value: "workflow", label: "Workflow" },
  { value: "node", label: "Tasks" },
  { value: "planner", label: "Planner" },
  { value: "team", label: "Team" },
  { value: "problems", label: "Problems" },
  { value: "runtime", label: "Runtime" },
  { value: "errors", label: "Errors" },
]

const WORKFLOW_EVENT_LIMIT = 800
const WORKFLOW_REPLAY_LIMIT = 600
const NODE_EVENT_LIMIT = 400
const NODE_REPLAY_LIMIT = 300
const EVENT_FLUSH_INTERVAL_MS = 80
const EMPTY_TASK_BOARD_TASKS: TaskBoardTask[] = []
const EMPTY_TASK_BOARD_COLUMNS: TaskBoardResponse["columns"] = []

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
        {view === "orchestrator" && <TaskBoardsPage workspace={workspace} />}
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
  if (event.event_type === "workflow") return "runtime"
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

function workflowEventSearchText(event: WorkflowEvent) {
  const payload = workflowEventPayloadText(event)
  return `${event.message} ${event.node_id ?? ""} ${event.run_id ?? ""} ${payload}`.trim()
}

function isArisOutputEvent(event: WorkflowEvent) {
  return ["aris", "thinking", "tool", "result", "stdout", "stderr"].includes(event.event_type)
}

function isTeamWorkflowEvent(event: WorkflowEvent) {
  return ["planner", "delta", "session", "team_message", "artifact", "approval"].includes(event.event_type)
}

const PROBLEM_ID_PATTERN = /pb-[a-z0-9]{8,}/i
const PROBLEM_ID_GLOBAL_PATTERN = /pb-[a-z0-9]{8,}/gi

function problemIdFromText(value?: string | null) {
  if (!value) return ""
  return value.match(PROBLEM_ID_PATTERN)?.[0] ?? ""
}

function workflowEventProblemId(event: WorkflowEvent) {
  return problemIdFromText(workflowEventSearchText(event))
}

function eventPolicyAllowed(event: WorkflowEvent): boolean | null {
  const policy = event.payload?.["policy_result"]
  if (!policy || typeof policy !== "object" || !("allowed" in policy)) return null
  const allowed = (policy as { allowed?: unknown }).allowed
  return typeof allowed === "boolean" ? allowed : null
}

function isPlannerRejectionEvent(event: WorkflowEvent) {
  return (
    event.message.includes("PlannerDeltaRejected")
    || event.message.includes("dynamic node cap reached")
    || eventPolicyAllowed(event) === false
  )
}

function isLowValuePlannerEvent(event: WorkflowEvent) {
  const normalized = event.message.toLowerCase()
  return (
    isPlannerRejectionEvent(event)
    || normalized.includes("planner checked dynamic dag: no applicable changes")
    || normalized.includes("plannerdeltanoop")
  )
}

function isResolvedOrNonBlockingText(value: string) {
  const normalized = value.toLowerCase()
  return (
    normalized.includes("resolved_by=")
    || normalized.includes("[resolved]")
    || /\bpass\b/.test(normalized)
    || normalized.includes("blockers: none")
    || normalized.includes("blocking issues: none")
    || normalized.includes("no blocker")
    || normalized.includes("no blocking")
    || normalized.includes("non-blocking")
    || normalized.includes("非阻塞")
    || normalized.includes("阻塞项：无")
    || normalized.includes("阻塞项: 无")
    || normalized.includes("无阻塞")
  )
}

function isMachineDiagnosticText(value: string) {
  const normalized = value.toLowerCase()
  return (
    normalized.includes("tool call")
    || normalized.includes("read_file call")
    || normalized.includes("read_file result")
    || normalized.includes("grep_search call")
    || normalized.includes("grep_search result")
    || normalized.includes("glob_search result")
    || normalized.includes("todowrite result")
    || normalized.includes("assistant stream produced no content")
    || normalized.includes("sessionturncompleted")
    || normalized.includes("research state updated")
    || normalized.includes("run `aris")
    || normalized.includes("aris --help")
    || normalized.includes("llm call ")
    || normalized.includes("anthropic api returned")
    || normalized.includes("context window exceeds limit")
    || normalized.includes("run failed with exit code")
    || normalized.includes("run still active")
    || normalized.includes("run queued")
    || normalized.includes("run started")
    || normalized.includes("node queued for rerun")
    || normalized.includes("node started:")
    || normalized.includes("node completed and auto")
    || normalized.includes("node attached to run")
    || normalized.includes("node failed:")
    || normalized.includes("finished with status skipped")
    || normalized.includes("obsolete failed duplicate")
    || normalized.includes("invalid_request_error")
  )
}

function isProblemWorkflowEvent(event: WorkflowEvent) {
  const text = workflowEventSearchText(event).toLowerCase()
  return Boolean(problemIdFromText(text)) || text.includes("problem board") || text.includes("问题板")
}

function isProviderDiagnosticNoise(message: string) {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("deepseek not selected:")
    || normalized.includes("deepseek config not found")
    || normalized.includes("using anthropic executor")
    || isMachineDiagnosticText(message)
  )
}

function isWorkflowErrorEvent(event: WorkflowEvent) {
  if (isProviderDiagnosticNoise(event.message)) return false
  return event.event_type === "stderr" || /\b(error|failed|failure|unauthorized|timeout)\b/i.test(event.message)
}

function workflowEventMatchesFilter(event: WorkflowEvent, filter: WorkflowEventFilter) {
  if (isProviderDiagnosticNoise(event.message)) return false
  if (filter === "all") return true
  if (filter === "aris") return isArisOutputEvent(event)
  if (filter === "workflow") return event.event_type === "workflow"
  if (filter === "node") return event.event_type === "node" || event.event_type === "run"
  if (filter === "planner") return event.event_type === "planner"
  if (filter === "team") return isTeamWorkflowEvent(event)
  if (filter === "problems") return isProblemWorkflowEvent(event)
  if (filter === "runtime") return ["delta", "session", "team_message", "artifact", "approval"].includes(event.event_type)
  if (filter === "errors") return isWorkflowErrorEvent(event)
  return true
}

function organizeWorkflowPositions(workflow: WorkflowRecord, expandedFanoutGroups: Set<string> = new Set()) {
  const order = workflowNodeOrder(workflow)
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
    const layer = deps.reduce((max, dep) => Math.max(max, (layerByUnit.get(dep) ?? 0) + 1), 0)
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

const FANOUT_STACK_MIN_SIZE = 3
const FANOUT_STACK_NODE_PREFIX = "fanout-stack:"
const STACK_EDGE_PREFIX = "stack-edge:"
const ROLE_NODE_PREFIX = "role:"
const PLANNER_ROLE = "planner"
const LITERATURE_ROLE = "literature scout"
const REVIEWER_ROLE = "reviewer"
const LITERATURE_SKILLS = new Set(["research-lit", "openalex-search"])

type CanvasMode = "office" | "role" | "task"

type FanoutStackGroup = {
  key: string
  parentId: string
  parent?: WorkflowNodeInfo
  nodes: WorkflowNodeInfo[]
}

type RoleSummary = {
  role: string
  total: number
  active: number
  running: number
  blocked: number
  review: number
  done: number
  agents: Set<string>
  tasks: WorkflowNodeInfo[]
  onDemand: boolean
  standbyLabel?: string
}

type RoleKind = TeamRoleKind

type ProblemLaneStatus = "active" | "review" | "closed"

type ProblemLaneTask = {
  id: string
  name: string
  role: string
  roleKind: TeamRoleKind
  status: string
}

type ProblemLane = {
  id: string
  title: string
  latestReason: string
  status: ProblemLaneStatus
  tasks: ProblemLaneTask[]
  primaryTaskId: string
  latestTime: number
}

type CollaborationEventSummary = {
  actor: string
  title: string
  detail: string
  problemId: string
  nodeId: string
  tone: "planner" | "problem" | "worker" | "reviewer" | "runtime"
}

type CollaborationSignal = {
  key: string
  timestamp: string
  summary: CollaborationEventSummary
}

type OfficeDeskStatus = "running" | "review" | "blocked" | "done" | "idle"

type OfficeRoleDesk = {
  role: string
  kind: TeamRoleKind
  status: OfficeDeskStatus
  statusLabel: string
  taskName: string
  taskStatus: string
  total: number
  active: number
  review: number
  done: number
  left: string
  top: string
  selected: boolean
  taskId: string
}

const roleKindOptions: { value: TeamRoleKind; label: string }[] = [
  { value: "planner", label: "Planner" },
  { value: "reviewer", label: "Reviewer" },
  { value: "literature", label: "Literature" },
  { value: "writer", label: "Writer" },
  { value: "citation", label: "Citation" },
  { value: "worker", label: "Worker" },
  { value: "gate", label: "Gate" },
]

function defaultScopeForRoleKind(kind: TeamRoleKind) {
  if (kind === "planner") return "解释问题、拆任务、读员工的人话进展，并决定下一步交给谁。员工不能反向调用规划员。"
  if (kind === "reviewer") return "只提出质量问题、证据缺口和返工建议；由规划员决定继续指派给哪个员工。"
  if (kind === "literature") return "按固定 OpenAlex 流程检索文献，维护高相关 CSV 表格，并写回可引用证据 artifact。"
  if (kind === "citation") return "把已确认文献插入草稿并修正引用格式；只执行任务，可复制帮手处理批量引用。"
  if (kind === "writer") return "根据已有材料写作和改写论文片段；只执行任务，用人话报告结果、风险和 artifact 链接。"
  if (kind === "gate") return "人工确认点，只做通过/暂停/返工判断。"
  return "自主完成被分配的问题，和其他员工用人话同步必要状态，可复制同类员工分担工作。"
}

function protocolDefaultsForRoleKind(kind: TeamRoleKind) {
  if (kind === "planner") return { can_ask_questions: true, can_clone_workers: false, can_call_planner: false, peer_access: true, reports_to_chat: true }
  if (kind === "reviewer") return { can_ask_questions: true, can_clone_workers: false, can_call_planner: false, peer_access: true, reports_to_chat: true }
  if (kind === "gate") return { can_ask_questions: true, can_clone_workers: false, can_call_planner: false, peer_access: false, reports_to_chat: true }
  return { can_ask_questions: false, can_clone_workers: true, can_call_planner: false, peer_access: true, reports_to_chat: true }
}

function applyRoleProtocolDefaults(node: WorkflowNodeInfo, kind: TeamRoleKind) {
  const defaults = protocolDefaultsForRoleKind(kind)
  node.team_role_kind = kind
  if (!node.scope) node.scope = defaultScopeForRoleKind(kind)
  node.can_ask_questions = defaults.can_ask_questions
  node.can_clone_workers = defaults.can_clone_workers
  node.can_call_planner = defaults.can_call_planner
  node.peer_access = defaults.peer_access
  node.reports_to_chat = defaults.reports_to_chat
}

function isLiteratureSkill(skill?: string | null) {
  return Boolean(skill && LITERATURE_SKILLS.has(skill))
}

function isLiteratureRoleText(role: string) {
  return /literature|文献|调研/.test(role.toLowerCase())
}

function isCitationRoleText(role: string) {
  return /citation|reference|bibliography|引用|插文献/.test(role.toLowerCase())
}

function inferRoleKindForNode(node: WorkflowNodeInfo): TeamRoleKind {
  if (node.team_role_kind) return node.team_role_kind
  const text = `${node.team_role_id ?? ""} ${node.assignee_role ?? ""} ${node.role} ${node.name} ${node.skill ?? ""} ${node.task_type ?? ""}`.toLowerCase()
  if (node.type === "human_gate" || node.task_type === "gate" || /gate|approval|checkpoint|人工|审批/.test(text)) return "gate"
  if (/planner|manager|coordinator|plan|outline|规划|计划/.test(text)) return "planner"
  if (/review|reviewer|critic|审查|审阅/.test(text)) return "reviewer"
  if (isCitationRoleText(text)) return "citation"
  if (isLiteratureRoleText(text) || isLiteratureSkill(node.skill)) return "literature"
  if (/write|writer|draft|author|paper-write|写作|撰写|改写/.test(text)) return "writer"
  return "worker"
}

function inferRoleKindForTask(task: TaskBoardTask): TeamRoleKind {
  if (task.team_role_kind) return task.team_role_kind
  const text = `${task.team_role_id ?? ""} ${task.assignee_role ?? ""} ${task.role} ${task.name} ${task.skill ?? ""} ${task.task_type}`.toLowerCase()
  if (/gate|approval|checkpoint|人工|审批/.test(text)) return "gate"
  if (/planner|manager|coordinator|plan|outline|规划|计划/.test(text)) return "planner"
  if (/review|reviewer|critic|审查|审阅/.test(text)) return "reviewer"
  if (isCitationRoleText(text)) return "citation"
  if (isLiteratureRoleText(text) || isLiteratureSkill(task.skill)) return "literature"
  if (/write|writer|draft|author|paper-write|写作|撰写|改写/.test(text)) return "writer"
  return "worker"
}

function roleKindForSummary(role: RoleSummary): RoleKind {
  const explicit = role.tasks.find((task) => task.team_role_kind)?.team_role_kind
  if (explicit) return explicit
  const roleName = role.role.trim().toLowerCase()
  const text = `${role.role} ${role.tasks.map((task) => `${task.name} ${task.skill ?? ""} ${task.task_type}`).join(" ")}`.toLowerCase()
  if (role.standbyLabel === "control" || ["planner", "manager", "manager/planner", "规划员", "计划员"].includes(roleName)) return "planner"
  if (/review|reviewer|critic|审查|审阅/.test(text)) return "reviewer"
  if (isCitationRoleText(text)) return "citation"
  if (isLiteratureRoleText(text) || role.tasks.some((task) => isLiteratureSkill(task.skill))) return "literature"
  if (/write|writer|draft|author|paper-write|写作/.test(text)) return "writer"
  if (/gate|approval|human|checkpoint/.test(text)) return "gate"
  return "worker"
}

function roleScopeForSummary(role: RoleSummary) {
  const kind = roleKindForSummary(role)
  const explicitScope = role.tasks.find((task) => task.scope?.trim())?.scope?.trim()
  return explicitScope || defaultScopeForRoleKind(kind)
}

function rolePermissionChips(role: RoleSummary) {
  const kind = roleKindForSummary(role)
  const source = role.tasks.find((task) => task.team_role_kind || task.can_ask_questions !== undefined || task.can_clone_workers !== undefined)
  const defaults = protocolDefaultsForRoleKind(kind)
  const canAsk = source?.can_ask_questions ?? defaults.can_ask_questions
  const canClone = source?.can_clone_workers ?? defaults.can_clone_workers
  const canCallPlanner = source?.can_call_planner ?? defaults.can_call_planner
  const peerAccess = source?.peer_access ?? defaults.peer_access
  if (kind === "planner") return ["chat coordinator", "reads human updates", "not callable"]
  if (kind === "reviewer") return ["asks questions", "planner routes", "evidence gate"]
  if (kind === "gate") return ["approve", "pause", "rework"]
  return [
    canAsk ? "can ask" : "no questions",
    canClone ? "can clone workers" : "no clone",
    canCallPlanner ? "planner callable" : "no planner call",
    peerAccess ? "peer access" : "isolated",
  ]
}

function roleSortWeight(role: RoleSummary) {
  const kind = roleKindForSummary(role)
  if (kind === "planner") return 0
  if (kind === "reviewer") return 80
  if (kind === "gate") return 90
  if (role.onDemand) return 70
  return 40
}

function nodeKindLabel(node: WorkflowNodeInfo) {
  if (node.type === "input") return "Input"
  if (node.type === "human_gate") return "Gate"
  if (isLiteratureSkill(node.skill) && node.dynamic_parent_id) return "Research"
  return "Agent"
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

function syncWorkflowEdges(workflow: WorkflowRecord) {
  workflow.graph_json.edges = workflow.graph_json.nodes.flatMap((item) =>
    item.depends_on.map((source) => ({ id: `${source}->${item.id}`, source, target: item.id })),
  )
}

function taskTypeLabel(task: TaskBoardTask | WorkflowNodeInfo) {
  const raw = "task_type" in task ? task.task_type : undefined
  return raw ? raw.replace("_", " ") : "analysis"
}

function taskDependencyLabel(task: TaskBoardTask) {
  if (!task.depends_on.length) return "no dependencies"
  return `${task.depends_on.length} dependencies`
}

const ROLE_PALETTE = ["#7c3aed", "#0ea5e9", "#16a34a", "#f59e0b", "#dc2626", "#0891b2", "#9333ea", "#0d9488"]

function roleColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
  }
  return ROLE_PALETTE[Math.abs(hash) % ROLE_PALETTE.length]
}

function defaultSkillForTask(taskType?: string, role = "", name = "") {
  const haystack = `${role} ${name}`.toLowerCase()
  if (haystack.includes("openalex")) return "openalex-search"
  const exact: Record<string, string> = {
    goal: "paper-plan",
    planning: "paper-plan",
    research: "research-lit",
    analysis: "analyze-results",
    writing: "paper-write",
    review: "research-review",
  }
  if (taskType && exact[taskType]) return exact[taskType]
  if (/(review|reviewer|critic|审查|审阅)/.test(haystack)) return "research-review"
  if (/(write|writer|draft|author|写作)/.test(haystack)) return "paper-write"
  if (/(literature|research|scout|文献|调研)/.test(haystack)) return "research-lit"
  if (/(analysis|analy|分析)/.test(haystack)) return "analyze-results"
  if (/(plan|planner|outline|规划)/.test(haystack)) return "paper-plan"
  return ""
}

function taskRoleForNode(node: WorkflowNodeInfo, task?: TaskBoardTask) {
  return task?.assignee_role || node.assignee_role || node.team_role_id || node.role || "unassigned"
}

function canonicalRoleForNode(node: WorkflowNodeInfo, task?: TaskBoardTask) {
  const rawRole = taskRoleForNode(node, task)
  const kind = inferRoleKindForNode({
    ...node,
    assignee_role: task?.assignee_role ?? node.assignee_role,
    team_role_kind: task?.team_role_kind ?? node.team_role_kind,
  })
  if (kind === "planner") return PLANNER_ROLE
  if (kind === "literature") return LITERATURE_ROLE
  if (kind === "reviewer") return REVIEWER_ROLE
  if (kind === "writer") return "writer"
  if (kind === "citation") return "citation inserter"
  return rawRole
}

function roleNodeId(role: string) {
  return `${ROLE_NODE_PREFIX}${encodeURIComponent(role)}`
}

function roleFromNodeId(id: string) {
  return decodeURIComponent(id.slice(ROLE_NODE_PREFIX.length))
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

function problemIdFromResearchRequest(request?: Record<string, unknown> | null) {
  const direct = request?.["problem_id"]
  return typeof direct === "string" ? problemIdFromText(direct) : ""
}

function problemIdForNode(node: WorkflowNodeInfo, task?: TaskBoardTask) {
  return (
    problemIdFromText(node.dynamic_parent_id)
    || problemIdFromText(task?.dynamic_parent_id)
    || problemIdFromResearchRequest(node.research_request)
    || problemIdFromText(node.dynamic_reason)
    || problemIdFromText(task?.dynamic_reason)
    || problemIdFromText(node.objective)
    || problemIdFromText(task?.objective)
    || problemIdFromText(node.prompt)
    || problemIdFromText(task?.prompt)
    || problemIdFromText(node.review_notes)
    || problemIdFromText(task?.review_notes)
  )
}

function problemIdForTask(task: TaskBoardTask) {
  return (
    problemIdFromText(task.dynamic_parent_id)
    || problemIdFromText(task.dynamic_reason)
    || problemIdFromText(task.objective)
    || problemIdFromText(task.prompt)
    || problemIdFromText(task.review_notes)
  )
}

function cleanProblemTitle(value: string, problemId: string) {
  const escapedProblemId = problemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const cleaned = value
    .replace(new RegExp(escapedProblemId, "ig"), "")
    .replace(/PlannerDeltaRejected/ig, "")
    .replace(/PlannerDecisionRecorded/ig, "")
    .replace(/Planner checked dynamic DAG: no applicable changes/ig, "")
    .replace(/task board dynamic node cap reached/ig, "")
    .replace(/Node failed:/ig, "")
    .replace(/planner triaged problem board issue/ig, "")
    .replace(/problem board/ig, "")
    .replace(/问题板/g, "")
    .replace(/\s*[:：-]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned ? truncate(cleaned, 132) : "Awaiting planner triage"
}

function humanSignalDetail(value: string, limit = 180) {
  const cleaned = value
    .replace(PROBLEM_ID_GLOBAL_PATTERN, "the issue")
    .replace(/\bPB-(\d+)\b/gi, "review item $1")
    .replace(/`?\.aris\/web\/workflows\/[^`\s]+`?/g, "the referenced artifact")
    .replace(/\bissue-[a-z0-9-]+/gi, "the issue")
    .replace(/\s+/g, " ")
    .trim()
  return truncate(cleaned, limit)
}

function humanProblemTitle(value: string, problemId: string) {
  const cleaned = cleanProblemTitle(value, problemId)
  const normalized = cleaned.toLowerCase()
  if (normalized.includes("placeholder") || normalized.includes("占位符")) {
    return "Replace unresolved draft placeholders"
  }
  if (normalized.includes("aris evaluation") || normalized.includes("ablation") || normalized.includes("citation accuracy")) {
    return "Remove unsupported ARIS evaluation claims"
  }
  if (normalized.includes("blocking") || normalized.includes("rework") || normalized.includes("reviewer feedback")) {
    return "Resolve reviewer blocking comments"
  }
  if (normalized.includes("revise") || normalized.includes("修订") || normalized.includes("修改")) {
    return "Revise introduction after review"
  }
  if (normalized.includes("citation") || normalized.includes("引用")) {
    return "Verify citation evidence and format"
  }
  if (normalized.includes("literature") || normalized.includes("文献")) {
    return "Gather literature evidence"
  }
  if (normalized.includes("approval")) {
    return "Waiting for human approval"
  }
  if (normalized.includes("planner") && normalized.includes("route")) {
    return "Waiting for planner route"
  }
  return cleaned
}

function laneStatusFromTasks(tasks: ProblemLaneTask[]): ProblemLaneStatus {
  if (!tasks.length) return "active"
  const reviewerTasks = tasks.filter((task) => task.roleKind === "reviewer")
  const reviewerOpen = reviewerTasks.some((task) => !["succeeded", "skipped", "cancelled"].includes(task.status))
  if (reviewerOpen) return "review"
  const workerOpen = tasks.some((task) => ["queued", "running", "blocked", "waiting_dynamic_dependency", "waiting_approval"].includes(task.status))
  if (workerOpen) return "active"
  if (reviewerTasks.some((task) => task.status === "succeeded")) return "closed"
  return tasks.every((task) => ["succeeded", "skipped", "cancelled"].includes(task.status)) ? "closed" : "active"
}

function problemLaneStatusLabel(status: ProblemLaneStatus) {
  if (status === "review") return "reviewing"
  if (status === "closed") return "closed"
  return "needs work"
}

function roleKindLabel(kind: TeamRoleKind) {
  if (kind === "planner") return "Planner"
  if (kind === "literature") return "Literature"
  if (kind === "writer") return "Writer"
  if (kind === "reviewer") return "Reviewer"
  if (kind === "citation") return "Citation"
  if (kind === "gate") return "Approval"
  return "Worker"
}

function taskStatusLabel(status: string) {
  if (status === "running") return "working"
  if (status === "queued" || status === "ready") return "queued"
  if (status === "waiting_approval") return "needs approval"
  if (status === "waiting_dynamic_dependency") return "waiting"
  if (status === "succeeded") return "done"
  if (status === "skipped") return "superseded"
  if (status === "failed") return "failed"
  return status.replace(/_/g, " ")
}

function problemLaneOwner(lane: ProblemLane) {
  const openTask = lane.tasks.find((task) => !["succeeded", "skipped", "cancelled"].includes(task.status))
  if (openTask) return `${roleKindLabel(openTask.roleKind)} ${taskStatusLabel(openTask.status)}`
  if (lane.tasks.some((task) => task.roleKind === "reviewer" && task.status === "succeeded")) return "Reviewer passed"
  if (lane.tasks.length) return "Resolved by team"
  return "Waiting for planner"
}

function problemLaneRoute(lane: ProblemLane) {
  const roles = Array.from(new Set(lane.tasks.map((task) => roleKindLabel(task.roleKind)))).slice(0, 4)
  return roles.length ? roles.join(" → ") : "No route yet"
}

function problemTaskChipLabel(task: ProblemLaneTask) {
  return roleKindLabel(task.roleKind)
}

function humanizePlannerAction(nextAction: string | undefined, activeProblemCount: number, waitingApprovalCount = 0) {
  const text = nextAction || ""
  const normalized = text.toLowerCase()
  if (waitingApprovalCount > 0 && activeProblemCount === 0) return "Final introduction is waiting for approval"
  if (normalized.includes("human approval")) return "Human approval is needed before the team continues"
  if (normalized.includes("queued node")) return "Team tasks are ready to run"
  if (normalized.includes("problem board")) return "Planner is routing open Problem Board items"
  return text || "No planner action yet"
}

function humanizePlannerRationale(value: string | undefined) {
  const text = value || ""
  const normalized = text.toLowerCase()
  if (!text) return "No planner decision has been recorded yet."
  if (normalized.includes("plannerdecisionrecorded")) return "Planner recorded a routing decision."
  if (normalized.includes("queued team work")) return "The planner found queued team work and routed follow-up tasks to the right role."
  if (normalized.includes("problem board")) return "The planner is turning Problem Board items into focused role tasks."
  if (normalized.includes("dynamic node cap")) return "The planner reached the follow-up task limit; resolved or duplicate items are hidden from the open board."
  return truncate(text, 220)
}

function officeDeskStatus(role: RoleSummary): OfficeDeskStatus {
  if (role.running > 0) return "running"
  if (role.blocked > 0) return "blocked"
  if (role.review > 0) return "review"
  if (role.done > 0 && role.total > 0) return "done"
  return "idle"
}

function officeDeskStatusLabel(status: OfficeDeskStatus) {
  if (status === "running") return "working"
  if (status === "blocked") return "blocked"
  if (status === "review") return "reviewing"
  if (status === "done") return "done"
  return "standby"
}

function officeSlotForKind(kind: TeamRoleKind, index: number) {
  const slots: Record<TeamRoleKind, { left: string; top: string }> = {
    planner: { left: "50%", top: "24%" },
    literature: { left: "24%", top: "48%" },
    writer: { left: "75%", top: "48%" },
    reviewer: { left: "50%", top: "70%" },
    citation: { left: "25%", top: "72%" },
    worker: { left: "74%", top: "72%" },
    gate: { left: "50%", top: "86%" },
  }
  const slot = slots[kind] ?? slots.worker
  if (index === 0) return slot
  const offsetX = index % 2 === 0 ? -10 : 10
  const offsetY = 8 + Math.floor(index / 2) * 8
  return {
    left: `calc(${slot.left} + ${offsetX}%)`,
    top: `calc(${slot.top} + ${offsetY}%)`,
  }
}

function activeTaskForRole(role: RoleSummary, taskById: Map<string, TaskBoardTask>) {
  const rank = (task: WorkflowNodeInfo) => {
    const status = taskById.get(task.id)?.status ?? task.status
    if (status === "running") return 0
    if (status === "queued") return 1
    if (status === "waiting_dynamic_dependency" || status === "blocked") return 2
    if (status === "waiting_approval") return 3
    if (status === "succeeded") return 5
    return 4
  }
  return [...role.tasks].sort((a, b) => rank(a) - rank(b))[0]
}

function isCollaborationSignalEvent(event: WorkflowEvent) {
  if (isProviderDiagnosticNoise(event.message)) return false
  if (isMachineDiagnosticText(workflowEventSearchText(event))) return false
  if (isLowValuePlannerEvent(event)) return false
  if (isProblemWorkflowEvent(event)) {
    return false
  }
  if (isTeamWorkflowEvent(event)) return true
  if (event.event_type === "workflow") return /\b(started|succeeded|failed|cancelled|paused|updated)\b/i.test(event.message)
  if (event.event_type === "node") return /\b(started|succeeded|failed|completed|waiting|blocked)\b/i.test(event.message)
  return false
}

function collaborationEventSummary(event: WorkflowEvent): CollaborationEventSummary {
  const payload = event.payload ?? {}
  const problemId = workflowEventProblemId(event)
  const nodeId = event.node_id ?? (typeof payload["node_id"] === "string" ? payload["node_id"] : "")
  if (event.event_type === "planner" || event.event_type === "delta") {
    const action = typeof payload["action"] === "string" ? payload["action"].replace("_", " ") : "route"
    const humanTitle = problemId ? humanProblemTitle(event.message, problemId) : ""
    return {
      actor: "Planner",
      title: humanTitle ? `Routed: ${humanTitle}` : action === "route" ? "Planner routed follow-up work" : `Planner ${action}`,
      detail: humanSignalDetail(humanizePlannerRationale(String(payload["reason"] ?? event.message))),
      problemId,
      nodeId,
      tone: "planner",
    }
  }
  if (event.event_type === "team_message") {
    const role = typeof payload["role"] === "string" ? payload["role"] : "Role agent"
    const roleKind = typeof payload["role_kind"] === "string" ? payload["role_kind"] : ""
    const roleLabel = roleKind ? roleKindLabel(roleKind as TeamRoleKind) : role
    const lowered = event.message.toLowerCase()
    const title =
      roleKind === "reviewer" && /\bpass\b/i.test(event.message)
        ? "Review passed"
        : roleKind === "reviewer" && (lowered.includes("rework") || lowered.includes("not pass"))
          ? "Review requested rework"
          : roleKind === "writer"
            ? "Draft revised"
            : roleKind === "literature"
              ? "Evidence delivered"
              : roleKind
                ? `${roleLabel} update`
                : "Team update"
    return {
      actor: roleLabel,
      title,
      detail: humanSignalDetail(event.message),
      problemId,
      nodeId,
      tone: roleKind === "reviewer" ? "reviewer" : "worker",
    }
  }
  if (isProblemWorkflowEvent(event)) {
    const title = problemId ? humanProblemTitle(event.message, problemId) : "Problem Board updated"
    return {
      actor: "Problem Board",
      title,
      detail: humanSignalDetail(event.message),
      problemId,
      nodeId,
      tone: "problem",
    }
  }
  if (event.event_type === "node" || event.event_type === "run") {
    const lowered = event.message.toLowerCase()
    const title =
      lowered.includes("waiting") && lowered.includes("approval")
        ? "Waiting for approval"
        : lowered.includes("completed") || lowered.includes("succeeded")
          ? "Task completed"
          : lowered.includes("failed")
            ? "Task failed"
            : event.message
    return {
      actor: nodeId || "Task",
      title,
      detail: nodeId ? `Task ${nodeId}` : humanSignalDetail(event.message, 120),
      problemId,
      nodeId,
      tone: "worker",
    }
  }
  return {
    actor: event.event_type === "workflow" ? "Runtime" : event.event_type,
    title: event.message,
    detail: humanSignalDetail(jsonPreview(payload, 180) || event.message),
    problemId,
    nodeId,
    tone: "runtime",
  }
}

function collaborationTeamMessageSummary(message: TeamMessage): CollaborationEventSummary {
  const roleLabel = roleKindLabel(message.role_kind)
  const lowered = message.message.toLowerCase()
  const title =
    message.role_kind === "reviewer" && /\bpass\b/i.test(message.message)
      ? "Review passed"
      : message.role_kind === "reviewer" && (lowered.includes("blocking") || lowered.includes("rework") || lowered.includes("not pass"))
        ? "Review requested rework"
        : message.role_kind === "writer"
          ? "Draft revised"
          : message.role_kind === "literature"
            ? "Evidence delivered"
            : message.role_kind === "planner"
              ? "Planner update"
              : `${roleLabel} update`
  return {
    actor: roleLabel,
    title,
    detail: humanSignalDetail(message.message),
    problemId: problemIdFromText(message.message),
    nodeId: message.node_id ?? "",
    tone: message.role_kind === "reviewer" ? "reviewer" : message.role_kind === "planner" ? "planner" : "worker",
  }
}

function collaborationDisplayDetail(summary: CollaborationEventSummary) {
  if (summary.title === "Review passed") return "Reviewer cleared the routed issue."
  if (summary.title === "Review requested rework") return "Reviewer found a blocking evidence gap."
  if (summary.title === "Draft revised") return "Writer produced an updated introduction artifact."
  if (summary.title === "Evidence delivered") return "Literature Scout handed off verified evidence."
  if (summary.title.includes("Human checkpoint")) return "Waiting for human approval."
  if (summary.title === "Workflow updated") return "Workflow state changed."
  if (summary.tone === "planner") return "Planner updated the team route."
  return summary.detail
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
  const displayedNodeEvents = useMemo(
    () => nodeEvents.filter((event) => !isProviderDiagnosticNoise(event.message)),
    [nodeEvents],
  )

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
      {displayedNodeEvents.length > 0 && (
        <div className="node-event-log" ref={nodeEventLogRef}>
          {displayedNodeEvents.map((event, index) => (
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

function TaskBoardsPage({ workspace }: { workspace: string }) {
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
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("office")
  const [selectedRole, setSelectedRole] = useState("")
  const [officeDetailRole, setOfficeDetailRole] = useState("")
  const [roleNodePositions, setRoleNodePositions] = useState<Record<string, { x: number; y: number }>>({})
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
  const [roleCanvasNodes, setRoleCanvasNodes] = useState<Node[]>([])
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
  const taskBoard = useQuery<TaskBoardResponse>({
    queryKey: ["task-board", selected?.id],
    queryFn: () => api.taskBoard(selected as WorkflowRecord),
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
      queryClient.invalidateQueries({ queryKey: ["task-board", workflowId] })
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
      if (isRecentEvent(event.timestamp) && ["workflow", "node", "planner", "delta", "session", "team_message", "artifact", "approval"].includes(event.event_type)) {
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
      syncWorkflowEdges(workflow)
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
      const id = slug(`${type === "input" ? "input" : type === "human_gate" ? "gate" : "agent"}-${index}`)
      const inputDependencies = workflow.graph_json.nodes.filter((node) => node.type === "input").map((node) => node.id)
      const taskType = type === "input" ? "input" : type === "human_gate" ? "gate" : type === "agent" ? "planning" : "analysis"
      const role = type === "input" ? "global input" : type === "human_gate" ? "human approval" : type === "sub_agent" ? "executor" : "planner"
      const teamRoleKind: TeamRoleKind = type === "input" ? "worker" : type === "human_gate" ? "gate" : type === "agent" ? "planner" : "worker"
      const protocolDefaults = protocolDefaultsForRoleKind(teamRoleKind)
      const skill = type === "input" || type === "human_gate" ? null : defaultSkillForTask(taskType, role) || null
      workflow.graph_json.nodes.push({
        id,
        type,
        name: type === "input" ? `Input ${index}` : type === "human_gate" ? `Gate ${index}` : `Agent ${index}`,
        role,
        skill,
        config_file: null,
        prompt: "",
        model: null,
        effort: null,
        gate: "none",
        depends_on: type === "input" ? [] : inputDependencies,
        inputs: [],
        outputs: type === "input" ? [{ name: "user_context", type: "text", description: "User-provided context inherited by downstream tasks" }] : [],
        status: type === "input" ? "succeeded" : "queued",
        run_id: null,
        session_path: null,
        error: null,
        approved_before: false,
        approved_after: false,
        position: { x: 120 + workflow.graph_json.nodes.length * 220, y: type === "input" ? 20 : type === "human_gate" ? 90 : type === "agent" ? 170 : 260 },
        timeout_seconds: null,
        retry: null,
        failure_policy: "halt",
        concurrency_class: "default",
        fanout: null,
        fanout_parent_id: null,
        fanout_item: null,
        dynamic_parent_id: null,
        dynamic_reason: null,
        auto_approve_after: type === "agent" || type === "sub_agent",
        research_request: null,
        team_role_kind: teamRoleKind,
        scope: type === "input" ? "" : defaultScopeForRoleKind(teamRoleKind),
        can_ask_questions: protocolDefaults.can_ask_questions,
        can_clone_workers: protocolDefaults.can_clone_workers,
        can_call_planner: protocolDefaults.can_call_planner,
        peer_access: protocolDefaults.peer_access,
        reports_to_chat: protocolDefaults.reports_to_chat,
        task_type: taskType,
        objective: type === "input" ? "Add user-provided context, constraints, files, or requirements that every task should inherit." : "",
        acceptance_criteria: [],
        assignee_role: type === "input" ? null : type === "human_gate" ? "human approval" : type === "agent" ? "planner" : "executor",
        assigned_to: null,
        claimed_by: null,
        review_status: type === "human_gate" ? "pending" : "not_required",
        review_notes: "",
        priority: 3,
      })
      if (type === "input") {
        for (const node of workflow.graph_json.nodes) {
          if (node.id !== id && node.type !== "input" && !node.depends_on.includes(id)) {
            node.depends_on.push(id)
          }
        }
      }
      syncWorkflowEdges(workflow)
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
      organizeWorkflowPositions(workflow, expandedFanoutGroups)
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
      team: events.filter(isTeamWorkflowEvent).length,
      problems: events.filter(isProblemWorkflowEvent).length,
      runtime: events.filter((event) => ["delta", "session", "team_message", "artifact", "approval"].includes(event.event_type)).length,
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
  const roleRuntimeLive = ["planning", "running", "waiting_dynamic_dependency", "ready", "scheduled"].includes(executionState)
  const draftDisplayStatus = draft ? executionState : undefined
  const boardTasks = taskBoard.data?.tasks ?? EMPTY_TASK_BOARD_TASKS
  const boardTaskById = useMemo(() => new Map(boardTasks.map((task) => [task.id, task])), [boardTasks])
  const boardColumns = taskBoard.data?.columns ?? EMPTY_TASK_BOARD_COLUMNS
  const problemLanes = useMemo<ProblemLane[]>(() => {
    type MutableLane = Omit<ProblemLane, "status"> & { taskIds: Set<string> }
    const lanes = new Map<string, MutableLane>()

    const ensureLane = (problemId: string, candidateTitle = "", latestReason = "", latestTime = 0) => {
      const title = candidateTitle ? humanProblemTitle(candidateTitle, problemId) : "Waiting for planner route"
      const lane = lanes.get(problemId) ?? {
        id: problemId,
        title,
        latestReason: latestReason || candidateTitle,
        tasks: [],
        taskIds: new Set<string>(),
        primaryTaskId: "",
        latestTime: 0,
      }
      if (title !== "Waiting for planner route" && lane.title === "Waiting for planner route") lane.title = title
      if (latestReason && (!lane.latestReason || latestTime >= lane.latestTime)) lane.latestReason = latestReason
      lane.latestTime = Math.max(lane.latestTime, latestTime)
      lanes.set(problemId, lane)
      return lane
    }

    for (const event of events) {
      const eventText = workflowEventSearchText(event)
      if (isLowValuePlannerEvent(event)) continue
      if (isMachineDiagnosticText(eventText) || isResolvedOrNonBlockingText(eventText)) continue
      const problemId = workflowEventProblemId(event)
      if (!problemId) continue
      ensureLane(problemId, event.message, event.message, Number.isFinite(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : 0)
    }

    for (const node of draft?.graph_json.nodes ?? []) {
      const task = boardTaskById.get(node.id)
      const problemId = problemIdForNode(node, task)
      if (!problemId) continue
      const lane = ensureLane(
        problemId,
        node.dynamic_reason || task?.dynamic_reason || node.objective || task?.objective || node.name,
        node.dynamic_reason || task?.dynamic_reason || node.objective || task?.objective || "",
      )
      if (lane.taskIds.has(node.id)) continue
      const roleKind = task?.team_role_kind ?? node.team_role_kind ?? inferRoleKindForNode(node)
      lane.taskIds.add(node.id)
      lane.tasks.push({
        id: node.id,
        name: node.name,
        role: canonicalRoleForNode(node, task),
        roleKind,
        status: task?.status ?? node.status,
      })
    }

    for (const task of boardTasks) {
      const problemId = problemIdForTask(task)
      if (!problemId) continue
      const lane = ensureLane(
        problemId,
        task.dynamic_reason || task.objective || task.name,
        task.dynamic_reason || task.objective || "",
      )
      if (lane.taskIds.has(task.id)) continue
      lane.taskIds.add(task.id)
      lane.tasks.push({
        id: task.id,
        name: task.name,
        role: task.assignee_role || task.team_role_id || task.role || "worker",
        roleKind: inferRoleKindForTask(task),
        status: task.status,
      })
    }

    const statusRank: Record<ProblemLaneStatus, number> = { active: 0, review: 1, closed: 2 }
    const taskRank = (status: string) => {
      if (status === "running") return 0
      if (status === "queued" || status === "ready") return 1
      if (status === "blocked" || status === "waiting_dynamic_dependency") return 2
      if (status === "waiting_approval") return 3
      if (status === "failed") return 4
      return 5
    }

    return Array.from(lanes.values())
      .map((lane) => {
        const tasks = [...lane.tasks].sort((a, b) => taskRank(a.status) - taskRank(b.status) || a.name.localeCompare(b.name))
        const status = laneStatusFromTasks(tasks)
        return {
          id: lane.id,
          title: lane.title,
          latestReason: lane.latestReason,
          status,
          tasks,
          primaryTaskId: tasks.find((task) => taskRank(task.status) < 5)?.id ?? tasks[0]?.id ?? "",
          latestTime: lane.latestTime,
        }
      })
      .sort((a, b) => statusRank[a.status] - statusRank[b.status] || b.latestTime - a.latestTime || a.id.localeCompare(b.id))
  }, [boardTaskById, boardTasks, draft?.graph_json.nodes, events])
  const activeProblemCount = problemLanes.filter((lane) => lane.status !== "closed").length
  const openProblemLanes = useMemo(() => problemLanes.filter((lane) => lane.status !== "closed"), [problemLanes])
  const resolvedProblemLanes = useMemo(() => problemLanes.filter((lane) => lane.status === "closed"), [problemLanes])
  const auditableResolvedProblemLanes = useMemo(
    () => resolvedProblemLanes.filter((lane) => !isMachineDiagnosticText(lane.title) && !isMachineDiagnosticText(lane.latestReason)),
    [resolvedProblemLanes],
  )
  const collaborationSignals = useMemo<CollaborationSignal[]>(() => {
    const signals = new Map<string, CollaborationSignal>()
    for (const event of events.filter(isCollaborationSignalEvent).slice(-16)) {
      const summary = collaborationEventSummary(event)
      const key = `event:${event.timestamp}:${event.event_type}:${event.node_id ?? ""}:${event.message}`
      signals.set(key, { key, timestamp: event.timestamp, summary })
    }
    for (const message of (runtime.data?.team_messages ?? []).slice(-16)) {
      if (isMachineDiagnosticText(message.message)) continue
      const key = `message:${message.timestamp}:${message.node_id ?? ""}:${message.role}:${message.message}`
      if (signals.has(key)) continue
      signals.set(key, {
        key,
        timestamp: message.timestamp,
        summary: collaborationTeamMessageSummary(message),
      })
    }
    return Array.from(signals.values())
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 10)
  }, [events, runtime.data?.team_messages])
  const plannerActionLabel = humanizePlannerAction(
    runtimeSummary?.next_action,
    activeProblemCount,
    runtimeSummary?.waiting_approval_count ?? 0,
  )
  const plannerRationaleLabel = humanizePlannerRationale(runtime.data?.latest_decision?.rationale)
  const roleSummaries = useMemo(() => {
    const roles = new Map<string, RoleSummary>()
    for (const node of draft?.graph_json.nodes ?? []) {
      if (node.type === "input" || node.type === "human_gate") continue
      const task = boardTaskById.get(node.id)
      const role = canonicalRoleForNode(node, task)
      const summary = roles.get(role) ?? { role, total: 0, active: 0, running: 0, blocked: 0, review: 0, done: 0, agents: new Set<string>(), tasks: [], onDemand: false }
      const column = task?.column
      const status = task?.status ?? node.status
      const reviewStatus = task?.review_status ?? node.review_status
      summary.total += 1
      if (column === "running" || column === "ready" || status === "running") summary.active += 1
      if (status === "running") summary.running += 1
      if (status === "waiting_dynamic_dependency") summary.blocked += 1
      if (column === "review" || reviewStatus === "pending" || status === "waiting_approval") summary.review += 1
      if (column === "done" || status === "succeeded") summary.done += 1
      if (task?.claimed_by) summary.agents.add(task.claimed_by)
      if (task?.assigned_to) summary.agents.add(task.assigned_to)
      summary.tasks.push(node)
      roles.set(role, summary)
    }
    if (draft && ![...roles.values()].some((role) => roleKindForSummary(role) === "planner")) {
      roles.set(PLANNER_ROLE, {
        role: PLANNER_ROLE,
        total: 0,
        active: 0,
        running: 0,
        blocked: 0,
        review: 0,
        done: 0,
        agents: new Set<string>(),
        tasks: [],
        onDemand: true,
        standbyLabel: "control",
      })
    }
    if (draft && ![...roles.values()].some((role) => role.tasks.some((task) => isLiteratureSkill(task.skill)) || isLiteratureRoleText(role.role))) {
      roles.set(LITERATURE_ROLE, {
        role: LITERATURE_ROLE,
        total: 0,
        active: 0,
        running: 0,
        blocked: 0,
        review: 0,
        done: 0,
        agents: new Set<string>(),
        tasks: [],
        onDemand: true,
        standbyLabel: "on-demand",
      })
    }
    if (draft && ![...roles.values()].some((role) => roleKindForSummary(role) === "reviewer")) {
      roles.set(REVIEWER_ROLE, {
        role: REVIEWER_ROLE,
        total: 0,
        active: 0,
        running: 0,
        blocked: 0,
        review: 0,
        done: 0,
        agents: new Set<string>(),
        tasks: [],
        onDemand: true,
        standbyLabel: "review gate",
      })
    }
    return [...roles.values()].sort(
      (a, b) =>
        roleSortWeight(a) - roleSortWeight(b)
        || b.active - a.active
        || b.review - a.review
        || b.total - a.total
        || a.role.localeCompare(b.role),
    )
  }, [boardTaskById, draft?.graph_json.nodes])
  const routedRoleCount = roleSummaries.filter((role) => !role.onDemand).length
  const onDemandRoleCount = roleSummaries.length - routedRoleCount
  useEffect(() => {
    setSelectedRole((current) => {
      if (current && roleSummaries.some((role) => role.role === current)) return current
      return roleSummaries[0]?.role ?? ""
    })
  }, [roleSummaries])
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
  const draftFlowTasks: Node[] = useMemo(
    () => {
      const visibleTasks = (draft?.graph_json.nodes ?? []).filter((node) => !collapsedNodeIds.has(node.id))
      const normalTasks = visibleTasks.map((node) => {
        const agentConfig = findAgentConfig(agentConfigs.data, node.config_file)
        const inheritedSkill = node.skill ?? agentConfig?.skill ?? null
        const skillLabel = isExecutableNode(node) && inheritedSkill ? `/${inheritedSkill}` : null
        const roleLabel = agentConfig
          ? agentConfig.name
          : node.role || (node.type === "human_gate" ? "human approval" : node.type === "sub_agent" ? "executor" : "planner")
        const roleAccent = agentConfig ? roleColor(agentConfig.id) : null
        const teamAccent = node.team_instance_id ? roleColor(node.team_instance_id) : null
        const isDynamicResearch = isLiteratureSkill(node.skill) && Boolean(node.dynamic_parent_id)
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
                      {node.type === "input" ? <FileText size={13} /> : node.type === "human_gate" ? <ClipboardCheck size={13} /> : <Cpu size={13} />}
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

      const stackTasks: Node[] = collapsedFanoutGroups.map((group) => {
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

      return [...normalTasks, ...stackTasks, ...expandedStackControls]
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
      setCanvasNodes(draftFlowTasks)
    }
  }, [draftFlowTasks, isDraggingNode])

  const roleFlowNodes: Node[] = useMemo(() => {
    const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(Math.max(roleSummaries.length, 1)))))
    return roleSummaries.map((role, index) => {
      const accent = roleColor(role.role)
      const position = roleNodePositions[role.role] ?? {
        x: 72 + (index % columns) * 430,
        y: 86 + Math.floor(index / columns) * 300,
      }
      const visibleTasks = role.tasks.slice(0, 5)
      const statusItems = statusSummary(role.tasks)
      const kind = roleKindForSummary(role)
      const permissionChips = rolePermissionChips(role)
      const isRoleRunning = role.running > 0
      const isRoleBlocked = role.blocked > 0
      const isRoleLive = roleRuntimeLive && (isRoleRunning || isRoleBlocked || role.active > 0 || role.review > 0)
      return {
        id: roleNodeId(role.role),
        type: "workflow",
        position,
        data: {
          label: (
            <div className="role-flow-label">
              <div className="flow-node-topline">
                <span className="flow-node-kind-row">
                  <span className="role-flow-mark" style={{ background: `${accent}22`, color: accent }}>
                    {kind === "literature" ? <Search size={14} /> : <UsersRound size={14} />}
                  </span>
                  <span className="role-flow-title">{role.role}</span>
                </span>
                <em>{role.onDemand ? role.standbyLabel ?? "standby" : `${role.total} tasks`}</em>
              </div>
              <p className="role-scope">{roleScopeForSummary(role)}</p>
              <div className="role-flow-stats">
                {role.onDemand ? (
                  <>
                    <span>standby</span>
                    <span>{kind === "planner" ? "chat control" : "no link until needed"}</span>
                  </>
                ) : (
                  <>
                    <span>{role.active} active</span>
                    <span>{role.review} review</span>
                    <span>{role.done} done</span>
                  </>
                )}
              </div>
              {isRoleLive && (
                <div className="role-live-row">
                  <Activity size={12} />
                  <span>{isRoleRunning ? "thinking" : isRoleBlocked ? "waiting on answers" : role.review ? "reviewing" : "queued"}</span>
                  <i />
                </div>
              )}
              <div className="role-permission-row" aria-label={`${role.role} permissions`}>
                {permissionChips.map((chip) => <span key={chip}>{chip}</span>)}
              </div>
              <div className="role-task-stack">
                {visibleTasks.map((task) => {
                  const boardTask = boardTaskById.get(task.id)
                  const taskStatus = boardTask?.status ?? task.status
                  const inheritedSkill = task.skill || boardTask?.skill
                  return (
                    <button
                      className={`role-task-chip nodrag nopan role-task-chip-${taskStatus}`}
                      key={task.id}
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelectedNodeId(task.id)
                        setSelectedEdgeId("")
                        setSelectedRole(role.role)
                      }}
                      title={task.objective || task.prompt || task.name}
                      type="button"
                    >
                      <span>{inheritedSkill ? `/${inheritedSkill}` : taskTypeLabel(boardTask ?? task)}</span>
                      <strong>{task.name}</strong>
                    </button>
                  )
                })}
                {role.tasks.length > visibleTasks.length && (
                  <small className="role-task-more">+{role.tasks.length - visibleTasks.length} more tasks</small>
                )}
                {!visibleTasks.length && (
                  <small className="role-task-more">
                    {role.onDemand ? "Waiting for human-language updates or routed work" : "No routed tasks"}
                  </small>
                )}
              </div>
              {statusItems.length > 0 && (
                <div className="role-status-row">
                  {statusItems.slice(0, 4).map((item) => (
                    <small key={item.status}>
                      {item.count} {item.status}
                    </small>
                  ))}
                </div>
              )}
            </div>
          ),
        },
        className: `flow-node role-flow-node${role.onDemand ? " role-flow-node-ondemand" : ""}${selectedRole === role.role ? " role-flow-node-selected" : ""}${isRoleRunning ? " role-flow-node-running" : ""}${isRoleBlocked ? " role-flow-node-blocked" : ""}${isRoleLive ? " role-flow-node-live" : ""}`,
        style: { borderLeft: `4px solid ${accent}` },
      }
    })
  }, [boardTaskById, roleNodePositions, roleRuntimeLive, roleSummaries, selectedRole])

  useEffect(() => {
    if (!isDraggingNode) {
      setRoleCanvasNodes(roleFlowNodes)
    }
  }, [isDraggingNode, roleFlowNodes])

  const roleFlowEdges: WorkflowCanvasEdge[] = useMemo(() => {
    const nodesById = new Map((draft?.graph_json.nodes ?? []).map((node) => [node.id, node]))
    const communications = new Map<
      string,
      { sourceRole: string; targetRole: string; count: number; previews: string[] }
    >()
    for (const handoff of runtime.data?.handoffs ?? []) {
      if (handoff.content_type === "status" || handoff.content_type === "none") continue
      const source = nodesById.get(handoff.source)
      const target = nodesById.get(handoff.target)
      if (!source || !target) continue
      const sourceRole = canonicalRoleForNode(source, boardTaskById.get(source.id))
      const targetRole = canonicalRoleForNode(target, boardTaskById.get(target.id))
      if (sourceRole === targetRole) continue
      const key = `${sourceRole}->${targetRole}`
      const item = communications.get(key) ?? { sourceRole, targetRole, count: 0, previews: [] }
      item.count += 1
      if (handoff.preview) item.previews.push(handoff.preview)
      communications.set(key, item)
    }
    return Array.from(communications.values()).map((item) => ({
      id: `role-edge:${item.sourceRole}->${item.targetRole}`,
      type: "workflowHandoff",
      source: roleNodeId(item.sourceRole),
      target: roleNodeId(item.targetRole),
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        label: item.count === 1 ? "handoff" : `${item.count} handoffs`,
      },
      animated: roleRuntimeLive,
      ariaLabel: item.previews[0] ? truncate(item.previews[0], 140) : undefined,
      interactionWidth: 24,
      className: `flow-edge-role-route${roleRuntimeLive ? " flow-edge-role-route-live" : ""}`,
    }))
  }, [boardTaskById, draft?.graph_json.nodes, roleRuntimeLive, runtime.data?.handoffs])

  const selectedRoleSummary = roleSummaries.find((role) => role.role === selectedRole) ?? roleSummaries[0]
  const selectedRoleMessages = useMemo(() => {
    if (!selectedRoleSummary) return []
    const taskIds = new Set(selectedRoleSummary.tasks.map((task) => task.id))
    return (runtime.data?.team_messages ?? [])
      .filter((message) => message.role === selectedRoleSummary.role || (message.node_id ? taskIds.has(message.node_id) : false))
      .slice(-4)
      .reverse()
  }, [runtime.data?.team_messages, selectedRoleSummary])
  const latestTeamMessages = useMemo(
    () => (runtime.data?.team_messages ?? []).slice(-3).reverse(),
    [runtime.data?.team_messages],
  )
  const officeRoleDesks = useMemo<OfficeRoleDesk[]>(() => {
    const kindCounts = new Map<TeamRoleKind, number>()
    return roleSummaries.map((role) => {
      const kind = roleKindForSummary(role)
      const index = kindCounts.get(kind) ?? 0
      kindCounts.set(kind, index + 1)
      const slot = officeSlotForKind(kind, index)
      const task = activeTaskForRole(role, boardTaskById)
      const boardTask = task ? boardTaskById.get(task.id) : undefined
      const status = officeDeskStatus(role)
      return {
        role: role.role,
        kind,
        status,
        statusLabel: officeDeskStatusLabel(status),
        taskName: task?.name ?? (role.onDemand ? role.standbyLabel ?? "Waiting for routed work" : "No routed work"),
        taskStatus: boardTask?.status ?? task?.status ?? (role.onDemand ? "standby" : "idle"),
        total: role.total,
        active: role.active,
        review: role.review,
        done: role.done,
        left: slot.left,
        top: slot.top,
        selected: selectedRole === role.role,
        taskId: task?.id ?? "",
      }
    })
  }, [boardTaskById, roleSummaries, selectedRole])
  const officeDetailDesk = officeRoleDesks.find((desk) => desk.role === officeDetailRole)
  const officeUploadKinds = useMemo<TeamRoleKind[]>(() => {
    const visibleKinds = new Set(officeRoleDesks.map((desk) => desk.kind))
    return (["planner", "literature", "writer", "citation", "worker", "reviewer"] as TeamRoleKind[]).filter((kind) =>
      visibleKinds.has(kind),
    )
  }, [officeRoleDesks])
  const officeActiveDesks = officeRoleDesks.filter((desk) => desk.status === "running" || desk.status === "review" || desk.status === "blocked").length
  const officeProblemCards = openProblemLanes.slice(0, 3)
  const officeTimeline = collaborationSignals.slice(0, 5)
  const office3DDesks = officeRoleDesks as Office3DDesk[]
  const office3DProblems = useMemo<Office3DProblem[]>(
    () =>
      officeProblemCards.map((lane) => ({
        id: lane.id,
        title: lane.title,
        status: lane.status,
        route: problemLaneRoute(lane),
      })),
    [officeProblemCards],
  )
  const office3DSignals = useMemo<Office3DSignal[]>(
    () =>
      officeTimeline.map(({ key, timestamp, summary }) => ({
        key,
        timestamp,
        actor: summary.actor,
        title: summary.title,
        tone: summary.tone,
        nodeId: summary.nodeId,
      })),
    [officeTimeline],
  )

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
  const onRoleNodesChange = useCallback((changes: NodeChange[]) => {
    const nonRemovingChanges = changes.filter((change) => change.type !== "remove")
    setRoleCanvasNodes((nodes) => applyNodeChanges(nonRemovingChanges, nodes))
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (canvasMode !== "task") return
    const removed = changes.filter((change) => change.type === "remove").map((change) => change.id)
    if (removed.length) removeEdges(removed)
  }, [canvasMode])
  const onConnect = useCallback((connection: Connection) => {
    if (canvasMode !== "task") return
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
  }, [canvasMode])

  function handleCreateTemplate() {
    createWorkflow.mutate({
      workspace,
      title: title || (template === "paper_introduction" ? "Paper introduction runtime" : "Research runtime"),
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
    if (!globalThis.confirm(`Delete runtime "${workflow.title}"? This cannot be undone.`)) return
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
            aria-label="Show orchestrations"
            title="Show orchestrations"
          >
            <ChevronRight size={16} />
            <GitBranch size={16} />
            <span>Orchestrations</span>
          </Button>
        ) : (
          <>
        <div className="panel-head compact-head">
          <div>
            <h2>Orchestrations</h2>
            <p>{(workflows.data ?? []).length} local runtimes</p>
          </div>
          <div className="panel-head-actions">
            <Button variant="secondary" onClick={() => workflows.refetch()} type="button" aria-label="Refresh orchestrations" title="Refresh orchestrations">
              <RefreshCcw size={15} />
            </Button>
            <Button variant="secondary" onClick={() => setFlowPanelCollapsed(true)} type="button" aria-label="Hide orchestrations" title="Hide orchestrations">
              <ChevronLeft size={15} />
            </Button>
          </div>
        </div>
        <div className="workflow-list">
          {(workflows.data ?? []).map((workflow) => {
            const counts = workflowCounts(workflow)
            const displayStatus = workflow.id === draft?.id ? executionState : workflow.status
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
                    <Badge>Runtime</Badge>
                  </div>
                  <span>
                  {counts.agents} Agents · {counts.gates} Gates
                  </span>
                  <em className={statusClass(displayStatus)}>{displayStatus}</em>
                </button>
                <Button
                  aria-label={`Delete runtime ${workflow.title}`}
                  className="workflow-row-delete"
                  disabled={deleteWorkflow.isPending}
                  onClick={() => handleDeleteWorkflow(workflow)}
                  title="Delete runtime"
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
              <span>No orchestrations yet</span>
            </div>
          )}
        </div>
        <div className={`generator-box ${generatorCollapsed ? "generator-box-collapsed" : ""}`}>
          <button
            aria-expanded={!generatorCollapsed}
            className="generator-toggle"
            onClick={() => setGeneratorCollapsed((current) => !current)}
            title={generatorCollapsed ? "Expand runtime editor" : "Collapse runtime editor"}
            type="button"
          >
            <span className="generator-toggle-title">
              <Sparkles size={14} />
              Create / Update Runtime
            </span>
            {generatorCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </button>
          {!generatorCollapsed && (
            <div className="generator-content">
              <label>Initial goal</label>
              <Textarea
                rows={5}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="Describe a new runtime, or changes to apply to the selected orchestration..."
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
                  Plan Tasks
                </Button>
                <Button
                  onClick={handleRefine}
                  disabled={!workspace || !draft || draft.status === "running" || !goal.trim() || refineWorkflow.isPending}
                  type="button"
                >
                  <Wand2 size={15} />
                  Refine Board
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
                    Runtime Flow
                  </Badge>
                  <span>{draftCounts.agents} Agents</span>
                  <span>{draftCounts.gates} Gates</span>
                  {dirty && <Badge>unsaved</Badge>}
                  {draftDisplayStatus && <span className={statusClass(draftDisplayStatus)}>{executionStateLabel(draftDisplayStatus)}</span>}
                </div>
                <h1>{draft.title}</h1>
                <p>{draft.goal || "No goal set"}</p>
              </div>
            </div>
            {deleteWorkflow.error && <p className="error-text">{deleteWorkflow.error.message}</p>}
            <section className="task-runtime-strip" aria-label="Task board runtime">
              <div className="task-runtime-item">
                <span>Runtime</span>
                <strong>{executionStateLabel(executionState)}</strong>
                <small>{runtimeSummary?.next_action || "No runtime activity yet."}</small>
              </div>
              <div className="task-runtime-item">
                <span>Ready</span>
                <strong>{runtimeSummary?.ready_node_count ?? 0}</strong>
                <small>{runtimeSummary?.ready_node_ids.slice(0, 3).join(", ") || "none"}</small>
              </div>
              <div className="task-runtime-item">
                <span>Review</span>
                <strong>{runtimeSummary?.waiting_approval_count ?? 0}</strong>
                <small>{waitingBatchCount ? `${waitingBatchCount} completed task(s)` : "no approval batch"}</small>
              </div>
              <div className="task-runtime-item">
                <span>Artifacts</span>
                <strong>{taskBoard.data?.artifact_index.length ?? runtimeSummary?.artifact_count ?? 0}</strong>
                <small>{runtimeSummary?.delta_count ?? 0} planner changes</small>
              </div>
            </section>

            <section className="collab-workbench" aria-label="Team collaboration workbench">
              <div className="collab-workbench-head">
                <div>
                  <h2>Team Collaboration</h2>
                  <p>{activeProblemCount ? "Open handoffs need routing" : "All blockers are cleared"}</p>
                </div>
                <div className="collab-workbench-meta">
                  <span>{activeProblemCount} blocker(s)</span>
                  <span>{collaborationSignals.length} update(s)</span>
                </div>
              </div>
              <div className="collab-workbench-grid">
                <div className="collab-panel problem-board-panel">
                  <div className="collab-panel-head">
                    <span>
                      <ClipboardCheck size={14} />
                      Problem Board
                    </span>
                    <b>{activeProblemCount ? `${activeProblemCount} open` : "clear"}</b>
                  </div>
                  <div className="problem-lane-list">
                    {openProblemLanes.slice(0, 5).map((lane, index) => (
                      <button
                        className={`problem-lane problem-lane-${lane.status}`}
                        disabled={!lane.primaryTaskId}
                        key={lane.id}
                        onClick={() => {
                          if (!lane.primaryTaskId) return
                          setSelectedNodeId(lane.primaryTaskId)
                          setSelectedEdgeId("")
                          setCanvasMode("task")
                          const node = draft.graph_json.nodes.find((item) => item.id === lane.primaryTaskId)
                          if (node) setSelectedRole(canonicalRoleForNode(node, boardTaskById.get(node.id)))
                        }}
                        title={lane.latestReason || lane.title}
                        type="button"
                      >
                        <div className="problem-lane-head">
                          <strong>{lane.status === "closed" ? "Resolved issue" : `Issue ${index + 1}`}</strong>
                          <span className={`problem-status problem-status-${lane.status}`}>{problemLaneStatusLabel(lane.status)}</span>
                        </div>
                        <p>{lane.title}</p>
                        <div className="problem-lane-meta">
                          <span>{problemLaneOwner(lane)}</span>
                          <span>{problemLaneRoute(lane)}</span>
                        </div>
                        <div className="problem-task-strip">
                          {lane.tasks.slice(0, 4).map((task) => (
                            <span
                              className="problem-task-chip"
                              key={task.id}
                              style={{ borderColor: `${roleColor(task.role)}55` }}
                              title={task.name}
                            >
                              <b>{problemTaskChipLabel(task)}</b>
                              <em>{taskStatusLabel(task.status)}</em>
                            </span>
                          ))}
                          {!lane.tasks.length && <small>Waiting for planner route</small>}
                          {lane.tasks.length > 4 && <small>+{lane.tasks.length - 4} more</small>}
                        </div>
                      </button>
                    ))}
                    {!activeProblemCount && (
                      <div className="problem-empty">
                        <CheckCircle2 size={16} />
                        <span>No open blockers. The latest resolved handoffs are kept below as audit history.</span>
                      </div>
                    )}
                    {!activeProblemCount && auditableResolvedProblemLanes.length > 0 && (
                      <div className="problem-history-list" aria-label="Recently resolved Problem Board history">
                        <span>Recently resolved</span>
                        {auditableResolvedProblemLanes.slice(0, 3).map((lane) => (
                          <button
                            className="problem-history-row"
                            disabled={!lane.primaryTaskId}
                            key={lane.id}
                            onClick={() => {
                              if (!lane.primaryTaskId) return
                              setSelectedNodeId(lane.primaryTaskId)
                              setSelectedEdgeId("")
                              setCanvasMode("task")
                              const node = draft.graph_json.nodes.find((item) => item.id === lane.primaryTaskId)
                              if (node) setSelectedRole(canonicalRoleForNode(node, boardTaskById.get(node.id)))
                            }}
                            title={`${lane.title} (${lane.id})`}
                            type="button"
                          >
                            <strong>{lane.title}</strong>
                            <small>{problemLaneRoute(lane)}</small>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="collab-panel planner-focus-panel">
                  <div className="collab-panel-head">
                    <span>
                      <GitBranch size={14} />
                      Planner Focus
                    </span>
                    <b>{runtimeSummary?.dynamic_node_count ?? 0} routed</b>
                  </div>
                  <div className="planner-focus-stack">
                    <span>Next action</span>
                    <strong>{plannerActionLabel}</strong>
                    <span>Latest rationale</span>
                    <p>{plannerRationaleLabel}</p>
                  </div>
                  <div className="planner-focus-kpis">
                    <span>
                      <b>{runtimeSummary?.delta_count ?? 0}</b>
                      changes
                    </span>
                    <span>
                      <b>{runtimeSummary?.policy_rejection_count ?? 0}</b>
                      rejected
                    </span>
                  </div>
                </div>

                <div className="collab-panel collab-timeline-panel">
                  <div className="collab-panel-head">
                    <span>
                      <Activity size={14} />
                      Collaboration Timeline
                    </span>
                    <b>{collaborationSignals.length} shown</b>
                  </div>
                  <div className="collab-timeline-list">
                    {collaborationSignals.map(({ key, timestamp, summary }) => (
                      <button
                        className={`collab-event collab-event-${summary.tone}`}
                        disabled={!summary.nodeId}
                        key={key}
                        onClick={() => {
                          if (!summary.nodeId) return
                          setSelectedNodeId(summary.nodeId)
                          setSelectedEdgeId("")
                          setCanvasMode("task")
                          const node = draft.graph_json.nodes.find((item) => item.id === summary.nodeId)
                          if (node) setSelectedRole(canonicalRoleForNode(node, boardTaskById.get(node.id)))
                        }}
                        title={summary.detail}
                        type="button"
                      >
                        <span className="collab-event-time">{timestamp.slice(11, 19)}</span>
                        <div>
                          <strong>{summary.actor}</strong>
                          <p>{summary.title}</p>
                          <small>{collaborationDisplayDetail(summary)}</small>
                        </div>
                      </button>
                    ))}
                    {!collaborationSignals.length && (
                      <div className="problem-empty">
                        <Activity size={16} />
                        <span>No collaboration signals yet.</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="role-flow-surface" aria-label="Role orchestration flow">
              <div className="task-section-head">
                <div>
                  <h2>Role Orchestration Flow</h2>
                  <p>
                    {roleSummaries.length} Role Agents · {boardTasks.length || draft.graph_json.nodes.length} routed tasks
                    {onDemandRoleCount ? ` · ${onDemandRoleCount} standby` : ""}
                  </p>
                </div>
                <div className="task-board-actions">
                  <div className="canvas-mode-toggle" aria-label="Canvas mode">
                    <button
                      className={canvasMode === "office" ? "active" : ""}
                      onClick={() => setCanvasMode("office")}
                      type="button"
                    >
                      <Activity size={14} />
                      Office View
                    </button>
                    <button
                      className={canvasMode === "role" ? "active" : ""}
                      onClick={() => setCanvasMode("role")}
                      type="button"
                    >
                      <UsersRound size={14} />
                      Role Flow
                    </button>
                    <button
                      className={canvasMode === "task" ? "active" : ""}
                      onClick={() => setCanvasMode("task")}
                      type="button"
                    >
                      <GitBranch size={14} />
                      Task Dependencies
                    </button>
                  </div>
                  <Button variant="secondary" onClick={() => addNode("agent")} type="button" title="Add manager task">
                    <Cpu size={15} />
                    Task
                  </Button>
                  <Button variant="secondary" onClick={() => addNode("input")} type="button" title="Add global input">
                    <FileText size={15} />
                    Input
                  </Button>
                  <Button variant="secondary" onClick={() => addNode("human_gate")} type="button" title="Add checkpoint">
                    <ClipboardCheck size={15} />
                    Gate
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={organizeWorkflow}
                    disabled={!draft.graph_json.nodes.length || canvasMode !== "task"}
                    type="button"
                    aria-label="Organize task dependency flow"
                    title={canvasMode === "task" ? "Organize task dependency flow" : "Switch to Task Dependencies to organize task nodes"}
                  >
                    <SlidersHorizontal size={15} />
                    Organize
                  </Button>
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
                  <Button onClick={() => executeWorkflow.mutate(draft)} disabled={executeWorkflow.isPending} type="button" title="Start runtime">
                    <Play size={15} />
                    Start
                  </Button>
                </div>
              </div>
              {canvasMode === "office" ? (
                <>
                  <Office3DScene
                    activeCount={officeActiveDesks}
                    artifactCount={runtimeSummary?.artifact_count ?? 0}
                    desks={office3DDesks}
                    executionLabel={executionStateLabel(executionState)}
                    openIssueCount={activeProblemCount}
                    problems={office3DProblems}
                    signals={office3DSignals}
                    onOpenProblem={(problem) => {
                      const lane = officeProblemCards.find((item) => item.id === problem.id)
                      if (!lane?.primaryTaskId) return
                      setSelectedNodeId(lane.primaryTaskId)
                      setSelectedEdgeId("")
                      setCanvasMode("task")
                      const node = draft.graph_json.nodes.find((item) => item.id === lane.primaryTaskId)
                      if (node) setSelectedRole(canonicalRoleForNode(node, boardTaskById.get(node.id)))
                    }}
                    onOpenSignal={(signal) => {
                      if (!signal.nodeId) return
                      setSelectedNodeId(signal.nodeId)
                      setSelectedEdgeId("")
                      setCanvasMode("task")
                      const node = draft.graph_json.nodes.find((item) => item.id === signal.nodeId)
                      if (node) setSelectedRole(canonicalRoleForNode(node, boardTaskById.get(node.id)))
                    }}
                    onSelectDesk={(desk) => {
                      setSelectedRole(desk.role)
                      setOfficeDetailRole(desk.role)
                      setSelectedNodeId(desk.taskId)
                      setSelectedEdgeId("")
                    }}
                  />
                  <div className="office-legacy-hidden" aria-hidden="true">
                <div className={`office-shell office-shell-${executionState}`}>
                  <div className="office-stage" aria-label="Animated team office">
                    <div className="office-room-fixtures" aria-hidden="true">
                      <span className="office-wall-shelf">
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="office-coffee-counter">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="office-wall-board">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="office-window">
                        <i />
                        <i />
                      </span>
                      <span className="office-plant">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="office-floor-rug" />
                      <span className="office-floor-path" />
                    </div>
                    <div className="office-room-title">
                      <strong>ARIS Office</strong>
                      <span>{officeActiveDesks} active · {activeProblemCount} open issue(s)</span>
                    </div>
                    <div className="office-animation-layer" aria-hidden="true">
                      <span className="office-walk-path" />
                      <span className="office-mobile-agent">
                        <span className="office-mobile-shadow" />
                        <span className="office-mobile-document" />
                        <span className="office-person office-person-moving office-person-worker">
                          <span className="office-person-head" />
                          <span className="office-person-hair" />
                          <span className="office-person-body" />
                          <span className="office-person-arm office-person-arm-left" />
                          <span className="office-person-arm office-person-arm-right" />
                          <span className="office-person-leg office-person-leg-left" />
                          <span className="office-person-leg office-person-leg-right" />
                        </span>
                      </span>
                      <span className="office-shared-board">
                        <strong>Shared Workboard</strong>
                        <small>{runtimeSummary?.artifact_count ?? 0} artifacts</small>
                        <i />
                        <i />
                        <i />
                      </span>
                      {officeUploadKinds.map((kind) => (
                        <span className={`office-upload-channel office-upload-channel-${kind}`} key={kind}>
                          <span className={`office-upload-track office-upload-track-${kind}`} />
                          <span className={`office-upload-file office-upload-file-${kind}`} />
                        </span>
                      ))}
                      <span className="office-task-bubble office-task-bubble-a">
                        <strong>{officeTimeline[0]?.summary.actor ?? "Planner"}</strong>
                        <small>{officeTimeline[0]?.summary.title ?? runtimeSummary?.next_action ?? "planning next route"}</small>
                      </span>
                      <span className="office-task-bubble office-task-bubble-b">
                        <strong>{activeProblemCount ? "Problem Board" : "Board clear"}</strong>
                        <small>{officeProblemCards[0]?.title ?? "no open blockers"}</small>
                      </span>
                      <span className="office-task-bubble office-task-bubble-c">
                        <strong>{officeTimeline[1]?.summary.actor ?? "Reviewer"}</strong>
                        <small>{officeTimeline[1]?.summary.title ?? "checking output"}</small>
                      </span>
                    </div>
                    <div className="office-problem-board">
                      <div className="office-board-head">
                        <span>
                          <ClipboardCheck size={14} />
                          Problem Board
                        </span>
                        <b>{activeProblemCount}</b>
                      </div>
                      <div className="office-problem-list">
                        {officeProblemCards.map((lane) => (
                          <button
                            className={`office-problem-card office-problem-card-${lane.status}`}
                            disabled={!lane.primaryTaskId}
                            key={lane.id}
                            onClick={() => {
                              if (!lane.primaryTaskId) return
                              setSelectedNodeId(lane.primaryTaskId)
                              setSelectedEdgeId("")
                              setCanvasMode("task")
                              const node = draft.graph_json.nodes.find((item) => item.id === lane.primaryTaskId)
                              if (node) setSelectedRole(canonicalRoleForNode(node, boardTaskById.get(node.id)))
                            }}
                            type="button"
                          >
                            <strong>{lane.title}</strong>
                            <span>{problemLaneStatusLabel(lane.status)}</span>
                            <small>{problemLaneRoute(lane)}</small>
                          </button>
                        ))}
                        {!officeProblemCards.length && <small>No open board issues</small>}
                      </div>
                    </div>
                    <div className="office-metrics">
                      <span>Today</span>
                      <strong>{executionStateLabel(executionState)}</strong>
                      <div>
                        <b>{runtimeSummary?.active_node_count ?? 0}</b>
                        <small>running</small>
                        <b>{runtimeSummary?.terminal_node_count ?? 0}</b>
                        <small>done</small>
                      </div>
                    </div>
                    {officeRoleDesks.map((desk) => (
                      <button
                        className={`office-desk office-desk-${desk.kind} office-desk-${desk.status}${desk.selected ? " office-desk-selected" : ""}`}
                        key={desk.role}
                        onClick={() => {
                          setSelectedRole(desk.role)
                          setOfficeDetailRole(desk.role)
                          setSelectedNodeId(desk.taskId)
                          setSelectedEdgeId("")
                        }}
                        style={{ left: desk.left, top: desk.top }}
                        title={desk.taskName}
                        type="button"
                      >
                        <span className="office-desk-shadow" />
                        <span className="office-desk-surface">
                          <span className={`office-work-activity office-work-activity-${desk.kind}`}>
                            <span className="office-paper-stack">
                              <span className="office-paper office-paper-a" />
                              <span className="office-paper office-paper-b" />
                              <span className="office-paper office-paper-c" />
                            </span>
                            <span className="office-keyboard">
                              <i />
                              <i />
                              <i />
                              <i />
                            </span>
                            <span className="office-manuscript">
                              <i />
                              <i />
                              <i />
                            </span>
                            <span className="office-review-sheet">
                              <i />
                              <i />
                              <i />
                            </span>
                            <span className="office-pen" />
                            <span className="office-search-lens" />
                            <span className="office-plan-board-mini">
                              <i />
                              <i />
                              <i />
                            </span>
                            <span className="office-upload-spark" />
                          </span>
                          <span className="office-screen" />
                          <span className="office-agent">
                            <span className={`office-person office-person-seated office-person-${desk.kind}`}>
                              <span className="office-person-head" />
                              <span className="office-person-hair" />
                              <span className="office-person-body" />
                              <span className="office-person-arm office-person-arm-left" />
                              <span className="office-person-arm office-person-arm-right" />
                              <span className="office-person-leg office-person-leg-left" />
                              <span className="office-person-leg office-person-leg-right" />
                              <span className={`office-person-prop office-person-prop-${desk.kind === "reviewer" ? "check" : desk.kind === "literature" ? "search" : desk.kind === "planner" ? "board" : "doc"}`} />
                            </span>
                          </span>
                        </span>
                        <span className="office-desk-card">
                          <span className="office-desk-topline">
                            <strong>{desk.role}</strong>
                            <em>{desk.statusLabel}</em>
                          </span>
                          <span className="office-current-task">{desk.taskName}</span>
                          <span className="office-desk-kpis">
                            <b>{desk.active}</b> active
                            <b>{desk.review}</b> review
                            <b>{desk.done}</b> done
                          </span>
                          <span className="office-task-status">{desk.taskStatus}</span>
                        </span>
                      </button>
                    ))}
                    <div className="office-status-dock" aria-label="Office role status">
                      {officeRoleDesks.map((desk) => (
                        <button
                          className={`office-status-tile office-status-tile-${desk.kind}${officeDetailRole === desk.role ? " office-status-tile-selected" : ""}`}
                          key={`office-status-${desk.role}`}
                          onClick={() => {
                            setSelectedRole(desk.role)
                            setOfficeDetailRole((current) => (current === desk.role ? "" : desk.role))
                            setSelectedNodeId(desk.taskId)
                            setSelectedEdgeId("")
                          }}
                          type="button"
                        >
                          <strong>{desk.role}</strong>
                          <em>{desk.statusLabel}</em>
                        </button>
                      ))}
                      {officeDetailDesk && (
                        <div className={`office-status-detail office-status-detail-${officeDetailDesk.kind}`}>
                          <div>
                            <strong>{officeDetailDesk.role}</strong>
                            <em>{officeDetailDesk.taskStatus}</em>
                          </div>
                          <p>{officeDetailDesk.taskName}</p>
                          <span>
                            <b>{officeDetailDesk.active}</b> active
                            <b>{officeDetailDesk.review}</b> review
                            <b>{officeDetailDesk.done}</b> done
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="office-feed">
                      <div className="office-feed-head">
                        <Activity size={14} />
                        <strong>Live Work</strong>
                      </div>
                      {officeTimeline.map(({ key, timestamp, summary }) => (
                        <button
                          className={`office-feed-item office-feed-item-${summary.tone}`}
                          disabled={!summary.nodeId}
                          key={key}
                          onClick={() => {
                            if (!summary.nodeId) return
                            setSelectedNodeId(summary.nodeId)
                            setSelectedEdgeId("")
                            setCanvasMode("task")
                            const node = draft.graph_json.nodes.find((item) => item.id === summary.nodeId)
                            if (node) setSelectedRole(canonicalRoleForNode(node, boardTaskById.get(node.id)))
                          }}
                          type="button"
                        >
                          <span>{timestamp.slice(11, 19)}</span>
                          <strong>{summary.actor}</strong>
                          <small>{summary.title}</small>
                        </button>
                      ))}
                      {!officeTimeline.length && <small>No team activity yet.</small>}
                    </div>
                  </div>
                </div>
                  </div>
                </>
              ) : (
                <div className="flow-shell role-flow-shell">
                  {roleRuntimeLive && (
                    <div className="role-live-overlay" aria-live="polite">
                      <div className="role-live-overlay-head">
                        <span className="role-live-dot" />
                        <strong>Live dialogue</strong>
                        <small>{runtimeSummary?.next_action ?? "runtime active"}</small>
                      </div>
                      <div className="role-live-message-strip">
                        {latestTeamMessages.length ? (
                          latestTeamMessages.map((message) => (
                            <span key={`${message.node_id ?? message.role}-${message.timestamp}`}>
                              <b>{message.role}</b>
                              {truncate(message.message, 120)}
                            </span>
                          ))
                        ) : (
                          <span>
                            <b>{runtimeSummary?.active_node_ids[0] ?? "team"}</b>
                            waiting for the next human-language update
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <ReactFlow
                    nodes={canvasMode === "role" ? roleCanvasNodes : canvasNodes}
                    edges={canvasMode === "role" ? roleFlowEdges : flowEdges}
                    nodeTypes={workflowNodeTypes}
                    edgeTypes={workflowEdgeTypes}
                    onNodesChange={canvasMode === "role" ? onRoleNodesChange : onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onInit={(instance) => {
                      flowInstanceRef.current = instance
                    }}
                    fitView
                    fitViewOptions={{ padding: 0.18 }}
                    deleteKeyCode={canvasMode === "role" ? null : ["Backspace", "Delete"]}
                    elementsSelectable
                    nodesConnectable={canvasMode === "task"}
                    nodesDraggable
                    onlyRenderVisibleElements
                    onConnect={onConnect}
                    onNodeClick={(_, node) => {
                      if (canvasMode === "role" && node.id.startsWith(ROLE_NODE_PREFIX)) {
                        const role = roleFromNodeId(node.id)
                        setSelectedRole(role)
                        setSelectedNodeId(roleSummaries.find((item) => item.role === role)?.tasks[0]?.id ?? "")
                        setSelectedEdgeId("")
                        return
                      }
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
                      if (canvasMode === "role" || isStackEdgeId(edge.id)) return
                      setSelectedEdgeId(edge.id)
                      setSelectedNodeId("")
                    }}
                    onNodeDragStart={() => setIsDraggingNode(true)}
                    onNodeDragStop={(_, node) => {
                      setIsDraggingNode(false)
                      if (canvasMode === "role" && node.id.startsWith(ROLE_NODE_PREFIX)) {
                        const role = roleFromNodeId(node.id)
                        setRoleNodePositions((current) => ({
                          ...current,
                          [role]: { x: node.position.x, y: node.position.y },
                        }))
                        setSelectedRole(role)
                        return
                      }
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
                    {canvasMode === "task" && <MiniMap pannable zoomable />}
                    <Controls />
                  </ReactFlow>
                </div>
              )}
              {selectedRoleSummary && (
                <div className="role-internal-flow-panel">
                  <div className="role-internal-flow-head">
                    <span className="role-pill" style={{ background: `${roleColor(selectedRoleSummary.role)}22`, color: roleColor(selectedRoleSummary.role) }}>
                      {roleKindForSummary(selectedRoleSummary) === "literature" ? <Search size={12} /> : <UsersRound size={12} />}
                      {selectedRoleSummary.role}
                    </span>
                    <strong>Team Chat Protocol</strong>
                    <small>Planner reads human-language updates, not full artifact dumps.</small>
                  </div>
                  <div className="role-demand-note">
                    <strong>Core scope</strong>
                    <span>{roleScopeForSummary(selectedRoleSummary)}</span>
                  </div>
                  <div className="role-chat-grid">
                    <div className="role-chat-card">
                      <strong>Planner</strong>
                      <span>Continuously explains the problem in chat, reads compact human updates, and routes follow-up work.</span>
                    </div>
                    <div className="role-chat-card">
                      <strong>Workers</strong>
                      <span>Write papers, search literature, insert citations, or analyze results. They execute and report; they do not call the planner.</span>
                    </div>
                    <div className="role-chat-card">
                      <strong>Reviewer</strong>
                      <span>Raises questions and evidence gaps. The planner decides which employee continues.</span>
                    </div>
                    <div className="role-chat-card">
                      <strong>Messages</strong>
                      <span>Use human-language summaries with artifact links. Do not send all raw text at once.</span>
                    </div>
                  </div>
                  <div className="role-message-list">
                    <header>Human-language updates</header>
                    {selectedRoleMessages.map((message) => (
                      <div className="role-message-card" key={`${message.node_id ?? message.role}-${message.timestamp}`}>
                        <div>
                          <strong>{message.role}</strong>
                          <span>{message.role_kind}</span>
                        </div>
                        <p>{truncate(message.message, 420)}</p>
                        {message.artifact_refs.length > 0 && (
                          <small>{message.artifact_refs.slice(0, 3).map((artifact) => artifact.path).join(" · ")}</small>
                        )}
                      </div>
                    ))}
                    {!selectedRoleMessages.length && <small>No team chat updates from this role yet.</small>}
                  </div>
                  <div className="role-selected-tasks">
                    <header>{selectedRoleSummary.tasks.length ? "Current routed work" : "No routed work yet"}</header>
                    {selectedRoleSummary.tasks.slice(0, 4).map((task) => (
                      <button
                        className={`role-internal-task ${selectedNodeId === task.id ? "selected" : ""}`}
                        key={task.id}
                        onClick={() => {
                          setSelectedNodeId(task.id)
                          setSelectedEdgeId("")
                        }}
                        type="button"
                      >
                        <span>{taskTypeLabel(boardTaskById.get(task.id) ?? task)}</span>
                        <strong>{task.name}</strong>
                      </button>
                    ))}
                    {!selectedRoleSummary.tasks.length && <small>Waiting for planner assignment or a worker request.</small>}
                  </div>
                </div>
              )}
            </section>

            <section className="role-agent-strip" aria-label="Role agents">
              <div className="task-section-head">
                <div>
                  <h2>Role Agents</h2>
                  <p>
                    {routedRoleCount} routed role(s)
                    {onDemandRoleCount ? ` · ${onDemandRoleCount} standby role(s)` : ""}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => taskBoard.refetch()} type="button" title="Refresh runtime state">
                  <RefreshCcw size={14} />
                  Refresh
                </Button>
              </div>
              <div className="role-agent-list">
                {roleSummaries.map((role) => {
                  const kind = roleKindForSummary(role)
                  return (
                    <div className={`role-agent-tile${role.onDemand ? " role-agent-tile-ondemand" : ""}`} key={role.role}>
                      <span className="role-pill" style={{ background: `${roleColor(role.role)}22`, color: roleColor(role.role) }}>
                        {kind === "literature" ? <Search size={12} /> : <UsersRound size={12} />}
                        {role.role}
                      </span>
                      <strong>{role.onDemand ? role.standbyLabel ?? "standby" : `${role.active} active`}</strong>
                      <small>{roleScopeForSummary(role)}</small>
                      <em>{rolePermissionChips(role).join(" · ")}</em>
                    </div>
                  )
                })}
                {!roleSummaries.length && (
                  <div className="role-agent-empty">
                    <UsersRound size={16} />
                    <span>No role agents on this board yet.</span>
                  </div>
                )}
              </div>
            </section>

            <div className="workflow-terminal">
              <div className="workflow-terminal-head">
                <div className="workflow-terminal-title">
                  <Terminal size={14} />
                  <strong>Terminal</strong>
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
            <h1>Create or generate an orchestration</h1>
            <p>Start from a template or ask ARIS to plan role-agent work from the initial goal.</p>
          </div>
        )}
      </section>

      <aside className="orchestrator-right side-panel">
        <h2>{selectedEdge ? "Edge Editor" : "Task Editor"}</h2>
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
              This dependency means the target task waits for the source task to finish.
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
                  {selectedNode.type === "input" ? <FileText size={13} /> : selectedNode.type === "human_gate" ? <ClipboardCheck size={13} /> : <Cpu size={13} />}
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
            <label>Type</label>
            <Select
              value={selectedNode.type === "sub_agent" ? "agent" : selectedNode.type}
              onChange={(event) =>
                updateNode(selectedNode.id, (node) => {
                  const nextType = event.target.value as WorkflowNodeInfo["type"]
                  node.type = nextType
                  if (nextType === "input") {
                    node.role = "global input"
                    node.skill = null
                    node.config_file = null
                    node.model = null
                    node.effort = null
                    node.gate = "none"
                    node.timeout_seconds = null
                    node.retry = null
                    node.failure_policy = "halt"
                    node.fanout = null
                    node.task_type = "input"
                    node.status = "succeeded"
                    node.assignee_role = null
                    node.review_status = "not_required"
                    applyRoleProtocolDefaults(node, "worker")
                    node.scope = ""
                    node.outputs = node.outputs.length ? node.outputs : [{ name: "user_context", type: "text" }]
                    node.depends_on = []
                    for (const item of draft.graph_json.nodes) {
                      if (item.id !== node.id && item.type !== "input" && !item.depends_on.includes(node.id)) {
                        item.depends_on.push(node.id)
                      }
                    }
                    return
                  }
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
                    node.task_type = "gate"
                    applyRoleProtocolDefaults(node, "gate")
                  } else if (nextType === "agent") {
                    node.role = node.role === "human approval" || node.role === "executor" ? "planner" : node.role
                    node.config_file = null
                    node.gate = "none"
                    node.timeout_seconds = null
                    node.retry = null
                    node.failure_policy = "halt"
                    node.fanout = null
                    if (node.task_type === "input" || node.task_type === "gate") node.task_type = "planning"
                    node.skill = node.skill || defaultSkillForTask(node.task_type, node.role, node.name) || null
                    applyRoleProtocolDefaults(node, "planner")
                  } else if (node.role === "human approval" || node.role === "planner") {
                    node.role = "executor"
                    if (node.task_type === "input" || node.task_type === "gate") node.task_type = "analysis"
                    node.skill = node.skill || defaultSkillForTask(node.task_type, node.role, node.name) || null
                    applyRoleProtocolDefaults(node, "worker")
                  }
                })
              }
            >
              <option value="input">Input</option>
              <option value="agent">Agent</option>
              <option value="human_gate">Gate</option>
            </Select>
            <label>Name</label>
            <Input value={selectedNode.name} onChange={(event) => updateNode(selectedNode.id, (node) => (node.name = event.target.value))} />
            <label>Role</label>
            <Input value={selectedNode.role} onChange={(event) => updateNode(selectedNode.id, (node) => (node.role = event.target.value))} />
            {selectedNode.type !== "input" && (
              <div className="team-protocol-editor">
                <div className="field-head">
                  <label>Team protocol</label>
                  <Badge>{inferRoleKindForNode(selectedNode)}</Badge>
                </div>
                <Select
                  value={inferRoleKindForNode(selectedNode)}
                  onChange={(event) =>
                    updateNode(selectedNode.id, (node) => {
                      applyRoleProtocolDefaults(node, event.target.value as TeamRoleKind)
                    })
                  }
                >
                  {roleKindOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <Textarea
                  rows={2}
                  value={selectedNode.scope || defaultScopeForRoleKind(inferRoleKindForNode(selectedNode))}
                  onChange={(event) => updateNode(selectedNode.id, (node) => (node.scope = event.target.value))}
                  placeholder="Core responsibility range"
                />
                <div className="protocol-toggle-grid">
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.can_ask_questions)}
                      onChange={(event) => updateNode(selectedNode.id, (node) => (node.can_ask_questions = event.target.checked))}
                    />
                    Can ask
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.can_clone_workers)}
                      onChange={(event) => updateNode(selectedNode.id, (node) => (node.can_clone_workers = event.target.checked))}
                    />
                    Clone workers
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.peer_access)}
                      onChange={(event) => updateNode(selectedNode.id, (node) => (node.peer_access = event.target.checked))}
                    />
                    Peer access
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.reports_to_chat ?? true)}
                      onChange={(event) => updateNode(selectedNode.id, (node) => (node.reports_to_chat = event.target.checked))}
                    />
                    Chat report
                  </label>
                </div>
              </div>
            )}
            <label>Task type</label>
            <Select
              value={selectedNode.task_type ?? (selectedNode.type === "human_gate" ? "gate" : "analysis")}
              onChange={(event) =>
                updateNode(selectedNode.id, (node) => {
                  node.task_type = event.target.value as WorkflowNodeInfo["task_type"]
                  if (isExecutableNode(node)) {
                    node.skill = defaultSkillForTask(node.task_type, node.role, node.name) || node.skill || null
                  }
                })
              }
            >
              <option value="input">input</option>
              <option value="goal">goal</option>
              <option value="planning">planning</option>
              <option value="research">research</option>
              <option value="analysis">analysis</option>
              <option value="coding">coding</option>
              <option value="writing">writing</option>
              <option value="review">review</option>
              <option value="gate">gate</option>
            </Select>
            <label>Objective</label>
            <Textarea
              rows={3}
              value={selectedNode.objective ?? ""}
              onChange={(event) => updateNode(selectedNode.id, (node) => (node.objective = event.target.value))}
              placeholder="What this task should accomplish"
            />
            {isExecutableNode(selectedNode) && (
              <>
                <label>
                  Inherited skill
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
                      : "Auto by role/task"}
                  </option>
                  {(skills.data ?? []).map((skill) => (
                    <option key={skill.id} value={skill.id}>
                      /{skill.id}
                    </option>
                  ))}
                </Select>
                <label>Model</label>
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
                      {modelProviderLabels.get(modelOption)
                        ? `${modelOption} · ${modelProviderLabels.get(modelOption)}`
                        : modelOption}
                    </option>
                  ))}
                </Select>
              </>
            )}
            <div className="field-head">
              <label>
                {selectedNode.type === "input"
                  ? "Input content"
                  : selectedNode.type === "human_gate"
                    ? "Gate instructions"
                    : "Optional supplemental instructions"}
              </label>
            </div>
            <Textarea
              rows={selectedNode.type === "human_gate" || selectedNode.type === "input" ? 5 : 8}
              value={selectedNode.prompt}
              onChange={(event) => updateNode(selectedNode.id, (node) => (node.prompt = event.target.value))}
              placeholder={
                selectedNode.type === "input"
                  ? "Add global context, constraints, files, requirements, or notes. All non-input tasks inherit this as upstream input."
                  : isExecutableNode(selectedNode)
                    ? "Optional. Leave empty to let the inherited skill drive the task from objective, inputs, outputs, and criteria."
                    : ""
              }
            />
            <label>Depends on</label>
            <Input
              value={joinList(selectedNode.depends_on)}
              onChange={(event) => updateNode(selectedNode.id, (node) => (node.depends_on = splitList(event.target.value)))}
              placeholder="planner, literature"
            />
            {selectedNode.error && <p className="error-text">{selectedNode.error}</p>}
            <div className="node-editor-danger-zone">
              <Button variant="destructive" onClick={() => removeNode(selectedNode.id)} type="button">
                Remove
              </Button>
            </div>
          </>
        ) : (
          <p className="muted">Select a task to edit it.</p>
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
        <h2>Launch Start Runtime</h2>
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
          <p>Workspace files that ARIS orchestrations commonly create or consume.</p>
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
  { value: "deepseek", label: "DeepSeek OpenAI-compatible", hint: "DeepSeek via OpenAI-compatible endpoint." },
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
