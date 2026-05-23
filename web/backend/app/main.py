from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .artifacts import (
    ensure_inside,
    guess_media_type,
    list_artifacts,
    resolve_artifact,
    resolve_workspace_file,
)
from .agent_configs import delete_agent_config, list_agent_configs, save_agent_config, update_agent_config
from .config import FRONTEND_DIST, RENDER_HTML, REPO_ROOT, SKILLS_DIR, TOOLS_DIR, WEB_HOME
from .global_settings import build_runtime_env, get_global_settings, update_global_settings, validate_global_settings
from .models import (
    AddWorkspaceRequest,
    AgentConfig,
    AgentConfigRequest,
    ArtifactInfo,
    CreateRunRequest,
    CreateWorkflowRequest,
    ExpandTeamRequest,
    GenerateWorkflowRequest,
    GlobalSettings,
    HealthItem,
    HealthResponse,
    NodeActionRequest,
    OptimizeNodePromptRequest,
    OptimizeNodePromptResponse,
    PlannerDecisionRecord,
    RefineWorkflowRequest,
    RenderHtmlRequest,
    RunRecord,
    RunOutput,
    SessionRuntimeView,
    SkillInfo,
    TaskBoardResponse,
    TaskClaimRequest,
    TaskReviewRequest,
    TeamConfig,
    TeamConfigRequest,
    UpdateGlobalSettingsRequest,
    UpdateWorkflowRequest,
    UpdateAgentConfigRequest,
    UpdateTeamConfigRequest,
    ValidateGlobalSettingsResponse,
    WorkflowDeltaRecord,
    WorkflowRecord,
    WorkflowRuntimeResponse,
    WorkspaceInfo,
)
from .runner import RunManager, resolve_aris_binary
from .skills import get_skill, scan_skills
from .storage import WorkspaceStore, get_run, last_message_path, list_runs, node_output_path, utc_now, update_run
from .team_configs import delete_team_config, list_team_configs, save_team_config, update_team_config
from .workflows import WorkflowManager


app = FastAPI(title="ARIS Web Local Console", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

workspace_store = WorkspaceStore()
run_manager = RunManager()
workflow_manager = WorkflowManager(run_manager)
settings_home = WEB_HOME
MAX_STREAM_REPLAY_EVENTS = 1000


def _stream_replay_limit(value: int | None) -> int | None:
    if value is None:
        return None
    return max(0, min(value, MAX_STREAM_REPLAY_EVENTS))


def _workspace_or_404(path: str) -> Path:
    try:
        return workspace_store.require_allowed(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _validate_agent_config_skill(skill: str | None) -> None:
    if skill and get_skill(skill) is None:
        raise HTTPException(status_code=400, detail=f"Unknown skill: {skill}")


def _validate_team_config_skills(request: TeamConfigRequest | UpdateTeamConfigRequest) -> None:
    roles = request.roles
    if roles is None:
        return
    for role in roles:
        _validate_agent_config_skill(role.skill)


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    global_settings = get_global_settings(settings_home)
    runtime_env = build_runtime_env()
    python3_bin = shutil.which("python3", path=runtime_env.get("PATH"))
    node_bin = shutil.which("node", path=runtime_env.get("PATH"))
    checks = [
        HealthItem(name="aris", available=resolve_aris_binary() is not None, value=resolve_aris_binary()),
        HealthItem(name="cargo", available=shutil.which("cargo") is not None, value=shutil.which("cargo")),
        HealthItem(name="python3", available=python3_bin is not None, value=python3_bin),
        HealthItem(name="node", available=node_bin is not None, value=node_bin),
        HealthItem(name="aris_repo", available=REPO_ROOT.exists(), value=str(REPO_ROOT)),
        HealthItem(name="bundled_skills", available=SKILLS_DIR.exists(), value=str(SKILLS_DIR)),
        HealthItem(name="bundled_tools", available=TOOLS_DIR.exists(), value=str(TOOLS_DIR)),
        HealthItem(name="render_html", available=RENDER_HTML.exists(), value=str(RENDER_HTML)),
        HealthItem(
            name="global_api_key",
            available=global_settings.api_key_set,
            value=f"{global_settings.provider}: {global_settings.api_key_masked}" if global_settings.api_key_set else "not configured",
        ),
    ]
    return HealthResponse(repo_root=str(REPO_ROOT), checks=checks)


@app.get("/api/skills", response_model=list[SkillInfo])
async def skills() -> list[SkillInfo]:
    return scan_skills()


@app.get("/api/workspaces", response_model=list[WorkspaceInfo])
async def get_workspaces() -> list[WorkspaceInfo]:
    return workspace_store.list()


@app.post("/api/workspaces", response_model=WorkspaceInfo)
async def add_workspace(request: AddWorkspaceRequest) -> WorkspaceInfo:
    try:
        return workspace_store.add(request.path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/settings", response_model=GlobalSettings)
async def global_settings_endpoint() -> GlobalSettings:
    return get_global_settings(settings_home)


@app.patch("/api/settings", response_model=GlobalSettings)
async def update_global_settings_endpoint(request: UpdateGlobalSettingsRequest) -> GlobalSettings:
    return update_global_settings(request, settings_home)


@app.post("/api/settings/validate", response_model=ValidateGlobalSettingsResponse)
async def validate_global_settings_endpoint(request: UpdateGlobalSettingsRequest) -> ValidateGlobalSettingsResponse:
    return await asyncio.to_thread(validate_global_settings, request, settings_home)


@app.post("/api/runs", response_model=RunRecord)
async def create_run(request: CreateRunRequest) -> RunRecord:
    workspace = _workspace_or_404(request.workspace)
    skill = get_skill(request.skill)
    if skill is None:
        raise HTTPException(status_code=404, detail=f"Unknown skill: {request.skill}")
    if hasattr(request, "model_copy"):
        normalized = request.model_copy(update={"workspace": str(workspace)})
    else:  # Pydantic v1 compatibility
        normalized = request.copy(update={"workspace": str(workspace)})
    return await run_manager.create_run(normalized, skill, workspace)


@app.get("/api/runs", response_model=list[RunRecord])
async def runs() -> list[RunRecord]:
    return list_runs(workspace_store.list())


@app.get("/api/runs/{run_id}", response_model=RunRecord)
async def get_run_endpoint(run_id: str, workspace: str = Query(...)) -> RunRecord:
    workspace_path = _workspace_or_404(workspace)
    record = get_run(workspace_path, run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return record


@app.get("/api/runs/{run_id}/output", response_model=RunOutput)
async def get_run_output_endpoint(run_id: str, workspace: str = Query(...)) -> RunOutput:
    workspace_path = _workspace_or_404(workspace)
    record = get_run(workspace_path, run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Run not found")

    message_path = last_message_path(workspace_path, run_id)
    output_path = node_output_path(workspace_path, run_id)
    last_message = message_path.read_text(encoding="utf-8", errors="replace") if message_path.exists() else ""
    node_output = None
    if output_path.exists():
        raw = output_path.read_text(encoding="utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                node_output = parsed
            else:
                node_output = {"value": parsed}
        except json.JSONDecodeError:
            node_output = {"raw": raw}

    return RunOutput(
        run_id=run_id,
        last_message=last_message,
        node_output=node_output,
        last_message_path=str(message_path) if message_path.exists() else None,
        node_output_path=str(output_path) if output_path.exists() else None,
    )


@app.post("/api/runs/{run_id}/cancel", response_model=RunRecord)
async def cancel_run(run_id: str, workspace: str = Query(...)) -> RunRecord:
    workspace_path = _workspace_or_404(workspace)
    record = get_run(workspace_path, run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Run not found")
    await run_manager.cancel(workspace_path, run_id)
    updated = get_run(workspace_path, run_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return updated


@app.websocket("/api/runs/{run_id}/stream")
async def run_stream(websocket: WebSocket, run_id: str, workspace: str) -> None:
    try:
        workspace_path = workspace_store.require_allowed(workspace)
    except ValueError:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    for event in await run_manager.replay_events(workspace_path, run_id):
        data = event.model_dump() if hasattr(event, "model_dump") else event.dict()
        await websocket.send_json(data)
    queue = await run_manager.bus.subscribe(run_id)
    try:
        while True:
            event = await queue.get()
            data = event.model_dump() if hasattr(event, "model_dump") else event.dict()
            await websocket.send_json(data)
    except WebSocketDisconnect:
        pass
    finally:
        await run_manager.bus.unsubscribe(run_id, queue)


@app.get("/api/agent-configs", response_model=list[AgentConfig])
async def agent_configs(workspace: str = Query(...)) -> list[AgentConfig]:
    workspace_path = _workspace_or_404(workspace)
    return list_agent_configs(workspace_path)


@app.post("/api/agent-configs", response_model=AgentConfig)
async def create_agent_config(request: AgentConfigRequest) -> AgentConfig:
    workspace = _workspace_or_404(request.workspace)
    _validate_agent_config_skill(request.skill)
    return save_agent_config(workspace, request)


@app.patch("/api/agent-configs/{config_id}", response_model=AgentConfig)
async def update_agent_config_endpoint(
    config_id: str,
    request: UpdateAgentConfigRequest,
    workspace: str = Query(...),
) -> AgentConfig:
    workspace_path = _workspace_or_404(workspace)
    _validate_agent_config_skill(request.skill)
    try:
        return update_agent_config(workspace_path, config_id, request)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.delete("/api/agent-configs/{config_id}")
async def delete_agent_config_endpoint(config_id: str, workspace: str = Query(...)) -> dict[str, bool]:
    workspace_path = _workspace_or_404(workspace)
    try:
        delete_agent_config(workspace_path, config_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@app.get("/api/team-configs", response_model=list[TeamConfig])
async def team_configs(workspace: str = Query(...)) -> list[TeamConfig]:
    workspace_path = _workspace_or_404(workspace)
    return list_team_configs(workspace_path)


@app.post("/api/team-configs", response_model=TeamConfig)
async def create_team_config(request: TeamConfigRequest) -> TeamConfig:
    workspace = _workspace_or_404(request.workspace)
    _validate_team_config_skills(request)
    try:
        return save_team_config(workspace, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/api/team-configs/{team_id}", response_model=TeamConfig)
async def update_team_config_endpoint(
    team_id: str,
    request: UpdateTeamConfigRequest,
    workspace: str = Query(...),
) -> TeamConfig:
    workspace_path = _workspace_or_404(workspace)
    _validate_team_config_skills(request)
    try:
        return update_team_config(workspace_path, team_id, request)
    except ValueError as exc:
        if str(exc) == "Team config not found":
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/team-configs/{team_id}")
async def delete_team_config_endpoint(team_id: str, workspace: str = Query(...)) -> dict[str, bool]:
    workspace_path = _workspace_or_404(workspace)
    try:
        delete_team_config(workspace_path, team_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/workflows/generate", response_model=WorkflowRecord)
async def generate_workflow(request: GenerateWorkflowRequest) -> WorkflowRecord:
    workspace = _workspace_or_404(request.workspace)
    try:
        return await workflow_manager.generate(workspace, request.goal, request.title)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/refine", response_model=WorkflowRecord)
async def refine_workflow(
    workflow_id: str,
    request: RefineWorkflowRequest,
    workspace: str = Query(...),
) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.refine(
            workspace_path,
            workflow_id,
            request.instructions,
            title=request.title,
            graph=request.graph_json,
        )
    except ValueError as exc:
        if str(exc) == "Workflow not found":
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/workflows", response_model=list[WorkflowRecord])
async def workflows(workspace: str | None = Query(None)) -> list[WorkflowRecord]:
    if workspace:
        workspace_path = _workspace_or_404(workspace)
        return workflow_manager.list([WorkspaceInfo(path=str(workspace_path), exists=True)])
    return workflow_manager.list(workspace_store.list())


@app.post("/api/workflows", response_model=WorkflowRecord)
async def create_workflow(request: CreateWorkflowRequest) -> WorkflowRecord:
    workspace = _workspace_or_404(request.workspace)
    try:
        return await workflow_manager.create(workspace, request.title, request.goal, request.graph_json, request.template)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/workflows/{workflow_id}", response_model=WorkflowRecord)
async def get_workflow_endpoint(workflow_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    record = workflow_manager.get(workspace_path, workflow_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return record


@app.get("/api/workflows/{workflow_id}/runtime", response_model=WorkflowRuntimeResponse)
async def workflow_runtime(workflow_id: str, workspace: str = Query(...)) -> WorkflowRuntimeResponse:
    workspace_path = _workspace_or_404(workspace)
    try:
        return workflow_manager.runtime(workspace_path, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/task-boards", response_model=list[WorkflowRecord])
async def task_boards(workspace: str | None = Query(None)) -> list[WorkflowRecord]:
    return await workflows(workspace)


@app.post("/api/task-boards", response_model=WorkflowRecord)
async def create_task_board(request: CreateWorkflowRequest) -> WorkflowRecord:
    return await create_workflow(request)


@app.post("/api/task-boards/generate", response_model=WorkflowRecord)
async def generate_task_board(request: GenerateWorkflowRequest) -> WorkflowRecord:
    return await generate_workflow(request)


@app.get("/api/task-boards/{board_id}", response_model=WorkflowRecord)
async def get_task_board_endpoint(board_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    return await get_workflow_endpoint(board_id, workspace)


@app.patch("/api/task-boards/{board_id}", response_model=WorkflowRecord)
async def update_task_board_endpoint(
    board_id: str,
    request: UpdateWorkflowRequest,
    workspace: str = Query(...),
) -> WorkflowRecord:
    return await update_workflow_endpoint(board_id, request, workspace)


@app.delete("/api/task-boards/{board_id}")
async def delete_task_board_endpoint(board_id: str, workspace: str = Query(...)) -> dict[str, bool]:
    return await delete_workflow_endpoint(board_id, workspace)


@app.post("/api/task-boards/{board_id}/refine", response_model=WorkflowRecord)
async def refine_task_board(
    board_id: str,
    request: RefineWorkflowRequest,
    workspace: str = Query(...),
) -> WorkflowRecord:
    return await refine_workflow(board_id, request, workspace)


@app.get("/api/task-boards/{board_id}/runtime", response_model=WorkflowRuntimeResponse)
async def task_board_runtime(board_id: str, workspace: str = Query(...)) -> WorkflowRuntimeResponse:
    return await workflow_runtime(board_id, workspace)


@app.get("/api/task-boards/{board_id}/task-board", response_model=TaskBoardResponse)
async def task_board_view(board_id: str, workspace: str = Query(...)) -> TaskBoardResponse:
    workspace_path = _workspace_or_404(workspace)
    try:
        return workflow_manager.task_board(workspace_path, board_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/task-boards/{board_id}/execute", response_model=WorkflowRecord)
async def execute_task_board(board_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        record = workflow_manager.get(workspace_path, board_id)
        restart = bool(record and record.status in {"paused", "failed", "cancelled", "succeeded"})
        return await workflow_manager.execute(
            workspace_path,
            board_id,
            auto_approve_executable=True,
            restart=restart,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/task-boards/{board_id}/pause", response_model=WorkflowRecord)
async def pause_task_board(board_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    return await pause_workflow(board_id, workspace)


@app.post("/api/task-boards/{board_id}/resume", response_model=WorkflowRecord)
async def resume_task_board(board_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    return await resume_workflow(board_id, workspace)


@app.post("/api/task-boards/{board_id}/cancel", response_model=WorkflowRecord)
async def cancel_task_board(board_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    return await cancel_workflow(board_id, workspace)


@app.post("/api/task-boards/{board_id}/tasks/{task_id}/claim", response_model=WorkflowRecord)
async def claim_task(board_id: str, task_id: str, request: TaskClaimRequest, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.claim_task(workspace_path, board_id, task_id, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/task-boards/{board_id}/tasks/{task_id}/review", response_model=WorkflowRecord)
async def review_task(board_id: str, task_id: str, request: TaskReviewRequest, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.review_task(workspace_path, board_id, task_id, request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/workflows/{workflow_id}/decisions", response_model=list[PlannerDecisionRecord])
async def workflow_decisions(workflow_id: str, workspace: str = Query(...)) -> list[PlannerDecisionRecord]:
    workspace_path = _workspace_or_404(workspace)
    if workflow_manager.get(workspace_path, workflow_id) is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow_manager.decisions(workspace_path, workflow_id)


@app.get("/api/workflows/{workflow_id}/deltas", response_model=list[WorkflowDeltaRecord])
async def workflow_deltas(workflow_id: str, workspace: str = Query(...)) -> list[WorkflowDeltaRecord]:
    workspace_path = _workspace_or_404(workspace)
    if workflow_manager.get(workspace_path, workflow_id) is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow_manager.deltas(workspace_path, workflow_id)


@app.get("/api/workflows/{workflow_id}/sessions/{session_id:path}", response_model=SessionRuntimeView)
async def workflow_session(workflow_id: str, session_id: str, workspace: str = Query(...)) -> SessionRuntimeView:
    workspace_path = _workspace_or_404(workspace)
    try:
        return workflow_manager.session_view(workspace_path, workflow_id, session_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.patch("/api/workflows/{workflow_id}", response_model=WorkflowRecord)
async def update_workflow_endpoint(
    workflow_id: str,
    request: UpdateWorkflowRequest,
    workspace: str = Query(...),
) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.update(
            workspace_path,
            workflow_id,
            title=request.title,
            goal=request.goal,
            graph=request.graph_json,
            status=request.status,
        )
    except ValueError as exc:
        if str(exc) == "Workflow not found":
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/workflows/{workflow_id}")
async def delete_workflow_endpoint(workflow_id: str, workspace: str = Query(...)) -> dict[str, bool]:
    workspace_path = _workspace_or_404(workspace)
    try:
        await workflow_manager.delete(workspace_path, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/workflows/{workflow_id}/teams/expand", response_model=WorkflowRecord)
async def expand_workflow_team(
    workflow_id: str,
    request: ExpandTeamRequest,
    workspace: str = Query(...),
) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.expand_team(
            workspace_path,
            workflow_id,
            team_id=request.team_id,
            prefix=request.prefix,
            position=request.position,
            depends_on=request.depends_on,
            connect_to=request.connect_to,
        )
    except ValueError as exc:
        if str(exc) in {"Workflow not found", "Team config not found"}:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/execute", response_model=WorkflowRecord)
async def execute_workflow(workflow_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.execute(workspace_path, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/pause", response_model=WorkflowRecord)
async def pause_workflow(workflow_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.pause(workspace_path, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/resume", response_model=WorkflowRecord)
async def resume_workflow(workflow_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.resume(workspace_path, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/cancel", response_model=WorkflowRecord)
async def cancel_workflow(workflow_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.cancel(workspace_path, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/nodes/{node_id}/approve", response_model=WorkflowRecord)
async def approve_workflow_node(workflow_id: str, node_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.approve_node(workspace_path, workflow_id, node_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/approve-batch", response_model=WorkflowRecord)
async def approve_workflow_batch(workflow_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.approve_batch(workspace_path, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/nodes/{node_id}/skip", response_model=WorkflowRecord)
async def skip_workflow_node(workflow_id: str, node_id: str, workspace: str = Query(...)) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.skip_node(workspace_path, workflow_id, node_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/nodes/{node_id}/restore", response_model=WorkflowRecord)
async def restore_workflow_node(
    workflow_id: str,
    node_id: str,
    request: NodeActionRequest,
    workspace: str = Query(...),
) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.restore_node(
            workspace_path,
            workflow_id,
            node_id,
            reset_downstream=request.reset_downstream or request.reset_descendants,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workflows/{workflow_id}/nodes/{node_id}/optimize-prompt", response_model=OptimizeNodePromptResponse)
async def optimize_workflow_node_prompt(
    workflow_id: str,
    node_id: str,
    request: OptimizeNodePromptRequest,
    workspace: str = Query(...),
) -> OptimizeNodePromptResponse:
    workspace_path = _workspace_or_404(workspace)
    try:
        prompt = await workflow_manager.optimize_node_prompt(
            workspace_path,
            workflow_id,
            node_id,
            graph=request.graph_json,
            instructions=request.instructions,
            model=request.model,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return OptimizeNodePromptResponse(prompt=prompt)


@app.post("/api/workflows/{workflow_id}/nodes/{node_id}/rerun", response_model=WorkflowRecord)
async def rerun_workflow_node(
    workflow_id: str,
    node_id: str,
    request: NodeActionRequest,
    workspace: str = Query(...),
) -> WorkflowRecord:
    workspace_path = _workspace_or_404(workspace)
    try:
        return await workflow_manager.rerun_node(
            workspace_path,
            workflow_id,
            node_id,
            reset_downstream=request.reset_downstream or request.reset_descendants,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.websocket("/api/workflows/{workflow_id}/stream")
async def workflow_stream(
    websocket: WebSocket,
    workflow_id: str,
    workspace: str,
    replay_limit: int | None = None,
) -> None:
    try:
        workspace_path = workspace_store.require_allowed(workspace)
    except ValueError:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        for event in await workflow_manager.replay_events(
            workspace_path,
            workflow_id,
            limit=_stream_replay_limit(replay_limit),
        ):
            data = event.model_dump() if hasattr(event, "model_dump") else event.dict()
            await websocket.send_json(data)
    except WebSocketDisconnect:
        return
    queue = await workflow_manager.bus.subscribe(workflow_id)
    try:
        while True:
            event = await queue.get()
            data = event.model_dump() if hasattr(event, "model_dump") else event.dict()
            await websocket.send_json(data)
    except WebSocketDisconnect:
        pass
    finally:
        await workflow_manager.bus.unsubscribe(workflow_id, queue)


@app.websocket("/api/workflows/{workflow_id}/nodes/{node_id}/stream")
async def workflow_node_stream(
    websocket: WebSocket,
    workflow_id: str,
    node_id: str,
    workspace: str,
    replay_limit: int | None = None,
) -> None:
    """Per-node event stream.

    Filters the same workflow event bus the global stream consumes, so a node
    panel in the UI can tail just its own ``aris``/``stdout``/``stderr``/node
    transition events without parsing the cross-node feed.
    """
    try:
        workspace_path = workspace_store.require_allowed(workspace)
    except ValueError:
        await websocket.close(code=1008)
        return
    await websocket.accept()

    def _matches(event_obj) -> bool:
        candidate_id = getattr(event_obj, "node_id", None)
        if candidate_id is None and isinstance(event_obj, dict):
            candidate_id = event_obj.get("node_id")
        return candidate_id == node_id

    try:
        for event in await workflow_manager.replay_events(
            workspace_path,
            workflow_id,
            limit=_stream_replay_limit(replay_limit),
        ):
            if not _matches(event):
                continue
            data = event.model_dump() if hasattr(event, "model_dump") else event.dict()
            await websocket.send_json(data)
    except WebSocketDisconnect:
        return
    queue = await workflow_manager.bus.subscribe(workflow_id)
    try:
        while True:
            event = await queue.get()
            if not _matches(event):
                continue
            data = event.model_dump() if hasattr(event, "model_dump") else event.dict()
            await websocket.send_json(data)
    except WebSocketDisconnect:
        pass
    finally:
        await workflow_manager.bus.unsubscribe(workflow_id, queue)


@app.get("/api/artifacts", response_model=list[ArtifactInfo])
async def artifacts(workspace: str = Query(...)) -> list[ArtifactInfo]:
    workspace_path = _workspace_or_404(workspace)
    return list_artifacts(workspace_path)


@app.get("/api/artifacts/{artifact_id}")
async def artifact_file(artifact_id: str, workspace: str = Query(...)):
    workspace_path = _workspace_or_404(workspace)
    try:
        path = resolve_artifact(workspace_path, artifact_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found")
    media_type = guess_media_type(path)
    if media_type.startswith("text/") or path.suffix.lower() in {".md", ".json", ".jsonl", ".tex", ".bib"}:
        return PlainTextResponse(path.read_text(encoding="utf-8", errors="replace"), media_type=media_type)
    return FileResponse(path, media_type=media_type, filename=path.name)


@app.post("/api/render-html", response_model=ArtifactInfo)
async def render_html(request: RenderHtmlRequest) -> ArtifactInfo:
    workspace = _workspace_or_404(request.workspace)
    try:
        source = resolve_workspace_file(workspace, request.path)
        ensure_inside(workspace, source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not source.exists() or not source.is_file():
        raise HTTPException(status_code=404, detail="Source artifact not found")
    if not RENDER_HTML.exists():
        raise HTTPException(status_code=500, detail="render_html.py was not found")

    command = ["python3", str(RENDER_HTML), str(source), "--template", request.template]
    if request.title:
        command.extend(["--title", request.title])
    if request.offline:
        command.append("--offline")
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(workspace),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=(stderr or stdout).decode("utf-8", errors="replace")[-2000:],
        )

    html_path = source.with_suffix(".html")
    artifacts_now = list_artifacts(workspace)
    for artifact in artifacts_now:
        if artifact.path == html_path.resolve().relative_to(workspace).as_posix():
            return artifact
    raise HTTPException(status_code=500, detail="HTML render completed but output was not found")


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
