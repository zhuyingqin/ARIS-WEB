from __future__ import annotations

import json
import asyncio
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "web" / "backend"))

from app.artifacts import (  # noqa: E402
    decode_artifact_id,
    encode_artifact_id,
    list_artifacts,
    resolve_workspace_file,
)
from app.agent_configs import get_agent_config, list_agent_configs, save_agent_config, update_agent_config  # noqa: E402
from app.team_configs import (  # noqa: E402
    delete_team_config,
    get_team_config,
    list_team_configs,
    save_team_config,
    update_team_config,
)
from app.global_settings import (  # noqa: E402
    build_runtime_env,
    effective_model_override,
    get_global_settings,
    openai_compatible_settings,
    update_global_settings,
)
from app.models import (  # noqa: E402
    AgentConfigRequest,
    CreateRunRequest,
    RunEvent,
    RunRecord,
    SkillInfo,
    TeamConfigRequest,
    TeamEdge,
    TeamRoleSpec,
    UpdateGlobalSettingsRequest,
    UpdateAgentConfigRequest,
    UpdateTeamConfigRequest,
    WorkflowEdge,
    WorkflowGraph,
    WorkflowNode,
    WorkflowRecord,
)
from app.runner import RunManager, build_aris_command, build_aris_prompt, summarize_codex_event  # noqa: E402
from app.skills import parse_skill_frontmatter, scan_skills  # noqa: E402
from app.storage import (  # noqa: E402
    WorkspaceStore,
    get_run,
    insert_run,
    last_message_path,
    list_runs,
    node_output_path,
    utc_now,
)
from app.workflow_storage import get_workflow, workflow_path  # noqa: E402
from app.workflows import (  # noqa: E402
    NodeRunResult,
    WorkflowManager,
    build_workflow_generation_prompt,
    build_workflow_refinement_prompt,
    missing_concrete_outputs,
    normalize_workflow_graph,
    paper_introduction_template_graph,
    parse_generated_workflow_text,
    research_template_graph,
    workflow_event_type_for_run_stream,
)


def make_skill(root: Path, rel: str, body: str) -> None:
    target = root / rel
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text(body, encoding="utf-8")


def test_parse_skill_frontmatter_reads_yaml_fields() -> None:
    meta = parse_skill_frontmatter(
        """---
name: research-lit
description: "Search papers"
argument-hint: <topic>
---
# Body
"""
    )

    assert meta["name"] == "research-lit"
    assert meta["description"] == "Search papers"
    assert meta["argument-hint"] == "<topic>"


def test_scan_skills_includes_nested_package_ids(tmp_path: Path) -> None:
    skills_root = tmp_path / "skills"
    make_skill(skills_root, "alpha", "---\nname: alpha\ndescription: Alpha\n---\n")
    make_skill(skills_root, "skills-codex/beta", "---\nname: beta\ndescription: Beta\n---\n")

    skills = scan_skills(skills_root)

    assert {skill.id for skill in skills} == {"alpha", "skills-codex/beta"}
    beta = next(skill for skill in skills if skill.id == "skills-codex/beta")
    assert beta.package == "skills-codex"


def test_workspace_store_allowlist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    default_workspace = tmp_path / "repo"
    default_workspace.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    store = WorkspaceStore(home=home, default_workspace=default_workspace)

    assert store.require_allowed(default_workspace) == default_workspace.resolve()
    with pytest.raises(ValueError):
        store.require_allowed(project)

    added = store.add(project)

    assert added.path == str(project.resolve())
    assert store.require_allowed(project) == project.resolve()
    assert json.loads((home / "workspaces.json").read_text())["workspaces"][-1] == str(project.resolve())


def test_resolve_workspace_file_blocks_traversal(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "inside.md").write_text("ok", encoding="utf-8")

    assert resolve_workspace_file(workspace, "inside.md") == (workspace / "inside.md").resolve()
    with pytest.raises(ValueError):
        resolve_workspace_file(workspace, "../outside.md")


def test_artifact_id_roundtrip_and_listing(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "report.md").write_text("# Report", encoding="utf-8")
    (workspace / "ignore.bin").write_bytes(b"x")

    encoded = encode_artifact_id("report.md")

    assert decode_artifact_id(encoded) == "report.md"
    artifacts = list_artifacts(workspace)
    assert [artifact.path for artifact in artifacts] == ["report.md"]
    assert artifacts[0].kind == "document"


def test_run_output_endpoint_reads_final_message(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from app import main

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    main.workspace_store = WorkspaceStore(home=tmp_path / "home", default_workspace=workspace)
    client = TestClient(main.app)
    run_id = "run-output"
    insert_run(
        RunRecord(
            id=run_id,
            workspace=str(workspace),
            skill="workflow-agent",
            arguments="",
            status="succeeded",
            created_at=utc_now(),
            updated_at=utc_now(),
            command=[],
        )
    )
    last_message_path(workspace, run_id).write_text("final node result", encoding="utf-8")
    node_output_path(workspace, run_id).write_text(
        json.dumps({"text": "final node result", "json": {"ok": True}}),
        encoding="utf-8",
    )

    response = client.get(f"/api/runs/{run_id}/output?workspace={workspace}")

    assert response.status_code == 200
    body = response.json()
    assert body["last_message"] == "final node result"
    assert body["node_output"]["json"] == {"ok": True}


def test_agent_config_storage_roundtrip_and_clear_fields(tmp_path: Path) -> None:
    saved = save_agent_config(
        tmp_path,
        AgentConfigRequest(
            workspace=str(tmp_path),
            id="Reviewer A",
            name="Reviewer A",
            role="critical reviewer",
            skill="research-review",
            model="gpt-5.4",
            effort="high",
            system_prompt="Be skeptical.",
            prompt_prefix="Check assumptions first.",
            output_contract="Return risks and fixes.",
        ),
    )

    assert saved.id == "reviewer-a"
    assert saved.path == ".aris/web/agent-configs/reviewer-a.json"
    assert get_agent_config(tmp_path, saved.path) is not None
    assert list_agent_configs(tmp_path)[0].prompt_prefix == "Check assumptions first."

    updated = update_agent_config(
        tmp_path,
        saved.id,
        UpdateAgentConfigRequest(skill=None, model=None, name="Reviewer A revised"),
    )

    assert updated.name == "Reviewer A revised"
    assert updated.skill is None
    assert updated.model is None


def test_team_config_storage_roundtrip_update_delete(tmp_path: Path) -> None:
    saved = save_team_config(
        tmp_path,
        TeamConfigRequest(
            workspace=str(tmp_path),
            id="Review Team",
            name="Review Team",
            description="Planner executor reviewer",
            roles=[
                TeamRoleSpec(id="Planner", name="Planner", role="planning"),
                TeamRoleSpec(id="Reviewer", name="Reviewer", role="critical review"),
            ],
            default_edges=[TeamEdge(source="Planner", target="Reviewer")],
        ),
    )

    assert saved.id == "review-team"
    assert saved.path == ".aris/web/team-configs/review-team.json"
    assert [role.id for role in saved.roles] == ["planner", "reviewer"]
    assert saved.default_edges[0].source == "planner"
    assert get_team_config(tmp_path, saved.path) is not None
    assert list_team_configs(tmp_path)[0].name == "Review Team"

    updated = update_team_config(
        tmp_path,
        saved.id,
        UpdateTeamConfigRequest(description="Updated", default_edges=[]),
    )

    assert updated.description == "Updated"
    assert updated.default_edges == []
    delete_team_config(tmp_path, saved.id)
    assert list_team_configs(tmp_path) == []


def test_global_settings_mask_and_runtime_env(tmp_path: Path) -> None:
    settings = update_global_settings(
        UpdateGlobalSettingsRequest(
            provider="openai",
            api_key="sk-test-123456",
            base_url="https://example.test/v1",
            model="gpt-5.5",
        ),
        tmp_path,
    )

    assert settings.api_key_set is True
    assert settings.api_key_masked == "sk-t...3456"
    settings_data = settings.model_dump() if hasattr(settings, "model_dump") else settings.dict()
    assert "sk-test-123456" not in json.dumps(settings_data)

    env = build_runtime_env(
        base_env={
            "PATH": "/bin",
            "ANTHROPIC_API_KEY": "stale-anthropic",
            "ARIS_REVIEWER_MODEL": "claude-opus-4-7",
        },
        home=tmp_path,
    )

    assert env["PATH"].split(";")[-1] == "/bin" or env["PATH"].split(":")[-1] == "/bin"
    assert env["EXECUTOR_PROVIDER"] == "openai"
    assert env["EXECUTOR_API_KEY"] == "sk-test-123456"
    assert env["OPENAI_API_KEY"] == "sk-test-123456"
    assert env["EXECUTOR_BASE_URL"] == "https://example.test/v1"
    assert env["ARIS_REVIEWER_MODEL"] == "gpt-5.5"
    assert "ANTHROPIC_API_KEY" not in env

    cleared = update_global_settings(UpdateGlobalSettingsRequest(provider="openai", clear_api_key=True), tmp_path)

    assert cleared.api_key_set is False
    env_after_clear = build_runtime_env(
        base_env={"EXECUTOR_API_KEY": "stale", "ARIS_REVIEWER_MODEL": "claude-opus-4-7"},
        home=tmp_path,
    )
    assert "EXECUTOR_API_KEY" not in env_after_clear
    assert "ARIS_REVIEWER_MODEL" not in env_after_clear

    update_global_settings(UpdateGlobalSettingsRequest(provider="minimax", api_key="sk-minimax-123"), tmp_path)
    minimax_env = build_runtime_env(base_env={"ARIS_REVIEWER_MODEL": "claude-opus-4-7"}, home=tmp_path)
    assert minimax_env["EXECUTOR_PROVIDER"] == "anthropic"
    assert minimax_env["ANTHROPIC_API_KEY"] == "sk-minimax-123"
    assert "ANTHROPIC_AUTH_TOKEN" not in minimax_env
    assert minimax_env["ANTHROPIC_BASE_URL"] == "https://api.minimaxi.com/anthropic"
    assert minimax_env["MINIMAX_API_KEY"] == "sk-minimax-123"
    assert minimax_env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] == "1"
    assert minimax_env["ARIS_REVIEWER_MODEL"] == "MiniMax-M2.7"
    assert effective_model_override(tmp_path) == "MiniMax-M2.7"
    assert openai_compatible_settings(tmp_path) is None


def test_build_aris_command_uses_exec_args_not_shell(tmp_path: Path) -> None:
    command = build_aris_command(tmp_path, "hello", model="claude-opus")

    assert Path(command[0]).name in {"aris", "aris.exe", "cargo"}
    assert "--permission-mode=workspace-write" in command
    assert "--allowedTools" in command
    assert "bash" not in command[command.index("--allowedTools") + 1].lower()
    assert "--output-format=json" in command
    assert "--model" in command
    assert command[-1] == "hello"
    assert all(";" not in part for part in command[:-1])


def test_build_aris_prompt_contains_skill_contract(tmp_path: Path) -> None:
    skills_root = tmp_path / "skills"
    make_skill(skills_root, "alpha", "---\nname: alpha\ndescription: Alpha\n---\n")
    skill = scan_skills(skills_root)[0]
    request = CreateRunRequest(
        workspace=str(tmp_path),
        skill=skill.id,
        arguments='"topic"',
        effort="balanced",
        assurance="draft",
    )

    prompt = build_aris_prompt(skill, request)

    assert "Target skill name: /alpha" in prompt
    assert 'User arguments:\n"topic"' in prompt
    assert "Effort: balanced" in prompt
    assert "Assurance: draft" in prompt
    assert "current working directory is already the workspace" in prompt
    assert "Use relative paths" in prompt


def test_run_storage_roundtrip(tmp_path: Path) -> None:
    now = utc_now()
    record = RunRecord(
        id="run01",
        workspace=str(tmp_path),
        skill="alpha",
        status="queued",
        created_at=now,
        updated_at=now,
        command=["codex", "exec", "<prompt>"],
    )

    insert_run(record)
    loaded = get_run(tmp_path, "run01")

    assert loaded is not None
    assert loaded.command == ["codex", "exec", "<prompt>"]
    assert list_runs([type("W", (), {"path": str(tmp_path), "exists": True})()])[0].id == "run01"


def test_summarize_codex_event_prefers_text_fields() -> None:
    assert summarize_codex_event({"type": "message", "message": "hello"}) == "hello"
    assert summarize_codex_event({"type": "item", "item": {"text": "nested"}}) == "nested"
    assert summarize_codex_event({"type": "other"}) == "other"


def test_health_endpoint_smoke() -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    response = client.get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert Path(body["repo_root"]).resolve() == REPO_ROOT.resolve()
    assert {item["name"] for item in body["checks"]} >= {
        "aris",
        "cargo",
        "python3",
        "node",
        "aris_repo",
        "bundled_skills",
    }


def test_local_dev_cors_accepts_any_vite_port() -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    response = client.options(
        "/api/workspaces",
        headers={
            "Origin": "http://127.0.0.1:5174",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5174"


def test_agent_config_api_create_update_delete(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from app import main

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    main.workspace_store = WorkspaceStore(home=tmp_path / "home", default_workspace=workspace)
    client = TestClient(main.app)

    created = client.post(
        "/api/agent-configs",
        json={
            "workspace": str(workspace),
            "id": "planner",
            "name": "Planner",
            "role": "workflow planner",
            "model": "gpt-5.4",
        },
    )
    assert created.status_code == 200
    config = created.json()
    assert config["path"] == ".aris/web/agent-configs/planner.json"

    patched = client.patch(
        f"/api/agent-configs/{config['id']}?workspace={workspace}",
        json={"model": None, "prompt_prefix": "Start with a DAG checklist."},
    )
    assert patched.status_code == 200
    assert patched.json()["model"] is None
    assert patched.json()["prompt_prefix"] == "Start with a DAG checklist."

    listed = client.get(f"/api/agent-configs?workspace={workspace}")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == ["planner"]

    deleted = client.delete(f"/api/agent-configs/{config['id']}?workspace={workspace}")
    assert deleted.status_code == 200
    assert client.get(f"/api/agent-configs?workspace={workspace}").json() == []


def test_team_config_api_create_expand_and_execute(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from app import main

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    calls: list[str] = []

    async def fake_runner(workspace: Path, record, node) -> NodeRunResult:
        calls.append(node.id)
        return NodeRunResult(run_id=f"run-{node.id}", succeeded=True)

    main.workspace_store = WorkspaceStore(home=tmp_path / "home", default_workspace=workspace)
    main.workflow_manager = WorkflowManager(main.run_manager, node_runner=fake_runner)
    client = TestClient(main.app)

    created_team = client.post(
        "/api/team-configs",
        json={
            "workspace": str(workspace),
            "id": "triad",
            "name": "Triad",
            "roles": [
                {"id": "planner", "name": "Planner", "prompt": "Plan."},
                {"id": "executor", "name": "Executor", "prompt": "Execute."},
            ],
            "default_edges": [{"source": "planner", "target": "executor"}],
        },
    )
    assert created_team.status_code == 200
    assert created_team.json()["path"] == ".aris/web/team-configs/triad.json"

    workflow_response = client.post(
        "/api/workflows",
        json={
            "workspace": str(workspace),
            "title": "Team API workflow",
            "goal": "Goal",
            "graph_json": {
                "nodes": [{"id": "start", "name": "Start"}, {"id": "finish", "name": "Finish"}],
                "edges": [],
            },
        },
    )
    assert workflow_response.status_code == 200
    workflow = workflow_response.json()

    expanded = client.post(
        f"/api/workflows/{workflow['id']}/teams/expand?workspace={workspace}",
        json={
            "team_id": "triad",
            "prefix": "team-one",
            "depends_on": ["start"],
            "connect_to": ["finish"],
            "position": {"x": 42, "y": 84},
        },
    )
    assert expanded.status_code == 200
    nodes = {node["id"]: node for node in expanded.json()["graph_json"]["nodes"]}
    assert nodes["team-one-planner"]["depends_on"] == ["start"]
    assert nodes["team-one-executor"]["depends_on"] == ["team-one-planner"]
    assert "team-one-executor" in nodes["finish"]["depends_on"]
    assert nodes["team-one-planner"]["team_id"] == "triad"

    execute_response = client.post(f"/api/workflows/{workflow['id']}/execute?workspace={workspace}")
    assert execute_response.status_code == 200
    for _ in range(8):
        for _ in range(40):
            current = get_workflow(workspace, workflow["id"])
            if current and current.status in {"paused", "succeeded"}:
                break
            time.sleep(0.05)
        current = get_workflow(workspace, workflow["id"])
        assert current is not None
        if current.status == "succeeded":
            break
        approve_batch = client.post(f"/api/workflows/{workflow['id']}/approve-batch?workspace={workspace}")
        assert approve_batch.status_code == 200
    current = get_workflow(workspace, workflow["id"])
    assert current is not None
    assert current.status == "succeeded"
    assert {"start", "team-one-planner", "team-one-executor", "finish"} <= set(calls)
    run_ids = {node.id: node.run_id for node in current.graph_json.nodes}
    assert run_ids["team-one-planner"] == "run-team-one-planner"
    assert run_ids["team-one-executor"] == "run-team-one-executor"


def test_global_settings_api_never_returns_plain_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from app import main

    monkeypatch.setattr(main, "settings_home", tmp_path / "settings-home")
    client = TestClient(main.app)

    response = client.patch(
        "/api/settings",
        json={"provider": "anthropic", "api_key": "sk-ant-secret", "model": "claude-opus-4-7"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["api_key_set"] is True
    assert body["api_key_masked"] == "sk-a...cret"
    assert "sk-ant-secret" not in json.dumps(body)

    fetched = client.get("/api/settings")
    assert fetched.status_code == 200
    assert "sk-ant-secret" not in json.dumps(fetched.json())

    health = client.get("/api/health")
    assert health.status_code == 200
    api_key_check = next(item for item in health.json()["checks"] if item["name"] == "global_api_key")
    assert api_key_check["available"] is True
    assert "sk-ant-secret" not in json.dumps(api_key_check)


def test_workflow_validation_rejects_cycles_and_unknown_skills() -> None:
    with pytest.raises(ValueError, match="Unknown skill"):
        normalize_workflow_graph(
            WorkflowGraph(nodes=[WorkflowNode(id="a", name="A", skill="missing-skill")]),
            {"research-lit"},
        )

    graph = WorkflowGraph(
        nodes=[
            WorkflowNode(id="a", name="A", depends_on=["b"]),
            WorkflowNode(id="b", name="B", depends_on=["a"]),
        ]
    )
    with pytest.raises(ValueError, match="cycle"):
        normalize_workflow_graph(graph)


def test_workflow_graph_legacy_agent_nodes_upgrade_to_sub_agents() -> None:
    legacy = WorkflowGraph(
        **{
            "nodes": [{"id": "legacy", "name": "Legacy", "type": "agent"}],
            "edges": [],
        }
    )
    modern = WorkflowGraph(
        schema_version=2,
        nodes=[WorkflowNode(id="planner", name="Planner", type="agent")],
        edges=[],
    )

    assert legacy.schema_version == 2
    assert legacy.nodes[0].type == "sub_agent"
    assert modern.schema_version == 2
    assert modern.nodes[0].type == "agent"


def test_parse_generated_workflow_text_reads_aris_json_message() -> None:
    text = json.dumps(
        {
            "message": json.dumps(
                {
                    "title": "Generated",
                    "goal": "Goal",
                    "nodes": [{"id": "a", "name": "A", "prompt": "Do A"}],
                    "edges": [],
                }
            )
        }
    )

    title, goal, graph = parse_generated_workflow_text(text)

    assert title == "Generated"
    assert goal == "Goal"
    assert graph.schema_version == 2
    assert graph.nodes[0].id == "a"
    assert graph.nodes[0].type == "sub_agent"


def test_workflow_generation_prompt_keeps_agent_overrides_hidden() -> None:
    prompt = build_workflow_generation_prompt(
        "Build a research plan",
        [
            SkillInfo(
                id="research-lit",
                name="research-lit",
                description="Search papers",
                argument_hint="",
                source_path="SKILL.md",
                package="skills",
            )
        ],
    )

    schema = prompt.split("The DAG must be acyclic.", 1)[0]

    assert '"schema_version": 2' in prompt
    assert '"type": "agent|sub_agent|human_gate"' in prompt
    assert "type=\"agent\"" in prompt
    assert "type=\"sub_agent\"" in prompt
    assert "type=\"human_gate\"" in prompt
    assert '"fanout"' in prompt
    assert "{{item.keywords}}" in prompt
    assert '"model"' not in schema
    assert '"effort"' not in schema
    assert '"config_file"' not in schema


def test_workflow_refinement_prompt_includes_current_graph_without_runtime() -> None:
    workflow = WorkflowRecord(
        id="wf",
        workspace=".",
        title="Existing",
        goal="Original goal",
        status="paused",
        graph_json=WorkflowGraph(
            nodes=[
                WorkflowNode(
                    id="a",
                    name="A",
                    status="waiting_approval",
                    run_id="run-a",
                    error="old error",
                    approved_after=True,
                    fanout={"source": "source", "path": "items"},
                ),
                WorkflowNode(
                    id="a-child",
                    name="A child",
                    depends_on=["source"],
                    status="succeeded",
                    run_id="run-child",
                    fanout_parent_id="a",
                    fanout_item={"name": "child"},
                ),
                WorkflowNode(
                    id="review",
                    name="Review",
                    type="human_gate",
                    depends_on=["a-child"],
                )
            ],
            edges=[WorkflowEdge(id="a-child->review", source="a-child", target="review")],
        ),
        created_at=utc_now(),
        updated_at=utc_now(),
    )

    prompt = build_workflow_refinement_prompt(
        workflow,
        workflow.graph_json,
        "Add a final human review gate",
        [
            SkillInfo(
                id="research-review",
                name="research-review",
                description="Review research outputs",
                argument_hint="",
                source_path="SKILL.md",
                package="skills",
            )
        ],
    )

    assert "Add a final human review gate" in prompt
    assert '"id": "a"' in prompt
    assert '"id": "a-child"' not in prompt
    assert '"depends_on": [\n        "a"\n      ]' in prompt
    assert "research-review" in prompt
    assert "run-a" not in prompt
    assert "run-child" not in prompt
    assert "waiting_approval" not in prompt
    assert "old error" not in prompt
    assert "Return the complete updated workflow, not a patch" in prompt
    assert '"fanout"' in prompt
    assert "{{item.keywords}}" in prompt


def test_research_template_graph_has_human_gates() -> None:
    graph = research_template_graph("test goal", {"research-refine", "research-lit", "experiment-plan"})
    nodes = {node.id: node for node in graph.nodes}

    assert [node.id for node in graph.nodes if node.type == "human_gate"] == ["approve-implementation", "approve-review"]
    assert nodes["planner"].type == "agent"
    assert nodes["experiment-plan"].type == "agent"
    assert nodes["literature"].type == "sub_agent"
    assert nodes["implementation"].type == "sub_agent"
    assert nodes["review"].type == "sub_agent"
    assert nodes["report"].type == "sub_agent"
    assert {edge.target for edge in graph.edges} >= {"literature", "experiment-plan", "approve-implementation"}


def test_paper_introduction_template_graph_targets_intro_writing() -> None:
    graph = paper_introduction_template_graph(
        "write an introduction",
        {"paper-plan", "research-lit", "paper-write", "research-review"},
    )

    assert [node.id for node in graph.nodes] == [
        "intro-context",
        "literature-positioning",
        "intro-outline",
        "draft-introduction",
        "review-introduction",
        "revise-introduction",
        "approve-introduction",
    ]
    assert graph.nodes[-1].type == "human_gate"
    assert graph.nodes[0].type == "agent"
    assert graph.nodes[1].type == "sub_agent"
    assert graph.nodes[2].type == "agent"
    assert graph.nodes[3].type == "sub_agent"
    assert graph.nodes[-1].depends_on == ["revise-introduction"]
    assert {edge.target for edge in graph.edges} >= {"draft-introduction", "review-introduction", "approve-introduction"}


def test_workflow_storage_roundtrip(tmp_path: Path) -> None:
    manager = WorkflowManager(type("R", (), {})())

    async def run() -> None:
        workflow = await manager.create(tmp_path, "Title", "Goal", WorkflowGraph(nodes=[WorkflowNode(id="a", name="A")]))
        loaded = get_workflow(tmp_path, workflow.id)
        assert loaded is not None
        assert loaded.graph_json.nodes[0].id == "a"
        assert workflow_path(tmp_path, workflow.id).exists()
        await manager.delete(tmp_path, workflow.id)
        assert get_workflow(tmp_path, workflow.id) is None
        assert not workflow_path(tmp_path, workflow.id).exists()

    asyncio.run(run())


def test_workflow_manager_refines_existing_workflow_and_preserves_unchanged_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app import workflows as workflow_module

    async def fake_refine(workspace: Path, workflow: WorkflowRecord, current_graph: WorkflowGraph, instructions: str):
        assert workspace == tmp_path
        assert workflow.title == "Original"
        assert current_graph.nodes[0].id == "a"
        assert instructions == "add a reviewer"
        return (
            "Generated title",
            "Updated goal",
            WorkflowGraph(
                nodes=[
                    WorkflowNode(id="a", name="A renamed", prompt="Do A."),
                    WorkflowNode(id="b", name="Reviewer", type="human_gate", depends_on=["a"]),
                    WorkflowNode(id="c", name="Changed", prompt="Do C differently."),
                ],
                edges=[],
            ),
        )

    monkeypatch.setattr(workflow_module, "refine_workflow_graph_with_aris", fake_refine)
    manager = WorkflowManager(type("R", (), {})())

    async def run() -> None:
        workflow = await manager.create(
            tmp_path,
            "Original",
            "Original goal",
            WorkflowGraph(
                nodes=[
                    WorkflowNode(id="a", name="A", prompt="Do A.", status="succeeded", run_id="run-a", approved_after=True),
                    WorkflowNode(id="c", name="Changed", prompt="Do C.", status="waiting_approval", run_id="run-c"),
                ]
            ),
        )
        refined = await manager.refine(tmp_path, workflow.id, "add a reviewer", title="Keep title")

        assert refined.id == workflow.id
        assert refined.title == "Keep title"
        assert refined.goal == "Updated goal"
        assert refined.status == "draft"
        nodes = {node.id: node for node in refined.graph_json.nodes}
        assert nodes["a"].name == "A renamed"
        assert nodes["a"].status == "succeeded"
        assert nodes["a"].run_id == "run-a"
        assert nodes["a"].approved_after is True
        assert nodes["b"].type == "human_gate"
        assert nodes["b"].status == "queued"
        assert nodes["c"].status == "queued"
        assert nodes["c"].run_id is None
        assert refined.graph_json.edges[0].source == "a"
        assert refined.graph_json.edges[0].target == "b"

    asyncio.run(run())


def test_workflow_expand_team_creates_nodes_edges_and_guards_collisions(tmp_path: Path) -> None:
    save_team_config(
        tmp_path,
        TeamConfigRequest(
            workspace=str(tmp_path),
            id="research-team",
            name="Research Team",
            roles=[
                TeamRoleSpec(id="planner", name="Planner", role="plan", position_offset={"x": 0, "y": 0}),
                TeamRoleSpec(id="executor", name="Executor", role="execute", position_offset={"x": 220, "y": 0}),
                TeamRoleSpec(id="reviewer", name="Reviewer", role="review", position_offset={"x": 440, "y": 0}),
            ],
            default_edges=[
                TeamEdge(source="planner", target="executor"),
                TeamEdge(source="executor", target="reviewer"),
            ],
        ),
    )
    manager = WorkflowManager(type("R", (), {})())

    async def run() -> None:
        workflow = await manager.create(
            tmp_path,
            "Expand team",
            "Goal",
            WorkflowGraph(
                nodes=[
                    WorkflowNode(id="upstream", name="Upstream"),
                    WorkflowNode(id="downstream", name="Downstream"),
                ]
            ),
        )
        expanded = await manager.expand_team(
            tmp_path,
            workflow.id,
            team_id="research-team",
            prefix="alpha",
            position={"x": 10, "y": 20},
            depends_on=["upstream"],
            connect_to=["downstream"],
        )

        nodes = {node.id: node for node in expanded.graph_json.nodes}
        assert {"alpha-planner", "alpha-executor", "alpha-reviewer"} <= set(nodes)
        assert {nodes["alpha-planner"].type, nodes["alpha-executor"].type, nodes["alpha-reviewer"].type} == {"sub_agent"}
        assert nodes["alpha-planner"].depends_on == ["upstream"]
        assert nodes["alpha-executor"].depends_on == ["alpha-planner"]
        assert nodes["alpha-reviewer"].depends_on == ["alpha-executor"]
        assert "alpha-reviewer" in nodes["downstream"].depends_on
        assert nodes["alpha-executor"].position == {"x": 230.0, "y": 20.0}
        assert nodes["alpha-reviewer"].team_id == "research-team"
        assert nodes["alpha-reviewer"].team_instance_id == "alpha"
        assert nodes["alpha-reviewer"].team_role_id == "reviewer"
        assert {"upstream->alpha-planner", "alpha-reviewer->downstream"} <= {
            edge.id for edge in expanded.graph_json.edges
        }

        with pytest.raises(ValueError, match="overwrite existing node"):
            await manager.expand_team(tmp_path, workflow.id, team_id="research-team", prefix="alpha")

    asyncio.run(run())


def test_workflow_expand_team_rejects_cycles_after_expansion(tmp_path: Path) -> None:
    save_team_config(
        tmp_path,
        TeamConfigRequest(
            workspace=str(tmp_path),
            id="cyclic-team",
            name="Cyclic Team",
            roles=[TeamRoleSpec(id="a", name="A"), TeamRoleSpec(id="b", name="B")],
            default_edges=[TeamEdge(source="a", target="b"), TeamEdge(source="b", target="a")],
        ),
    )
    manager = WorkflowManager(type("R", (), {})())

    async def run() -> None:
        workflow = await manager.create(tmp_path, "Cycle", "Goal", WorkflowGraph(nodes=[]))
        with pytest.raises(ValueError, match="cycle"):
            await manager.expand_team(tmp_path, workflow.id, team_id="cyclic-team", prefix="cyclic")

    asyncio.run(run())


def test_expanded_team_failure_policy_behaves_like_normal_dag_nodes(tmp_path: Path) -> None:
    save_team_config(
        tmp_path,
        TeamConfigRequest(
            workspace=str(tmp_path),
            id="fragile-team",
            name="Fragile Team",
            roles=[
                TeamRoleSpec(id="fail", name="Failing role", failure_policy="skip_descendants"),
                TeamRoleSpec(id="after", name="After role"),
            ],
            default_edges=[TeamEdge(source="fail", target="after")],
        ),
    )

    async def fake_runner(workspace: Path, record, node) -> NodeRunResult:
        if node.id == "fragile-fail":
            return NodeRunResult(run_id="run-fail", succeeded=False, error="boom")
        return NodeRunResult(run_id=f"run-{node.id}", succeeded=True)

    manager = WorkflowManager(type("R", (), {})(), node_runner=fake_runner)

    async def run() -> None:
        workflow = await manager.create(tmp_path, "Failure policy", "Goal", WorkflowGraph(nodes=[]))
        expanded = await manager.expand_team(tmp_path, workflow.id, team_id="fragile-team", prefix="fragile")
        assert expanded.graph_json.nodes[0].failure_policy == "skip_descendants"
        await manager.execute(tmp_path, workflow.id)
        for _ in range(40):
            current = get_workflow(tmp_path, workflow.id)
            if current and current.status == "failed":
                break
            await asyncio.sleep(0.05)
        current = get_workflow(tmp_path, workflow.id)
        assert current is not None
        nodes = {node.id: node for node in current.graph_json.nodes}
        assert current.status == "failed"
        assert nodes["fragile-fail"].status == "failed"
        assert nodes["fragile-after"].status == "skipped"

    asyncio.run(run())


def test_workflow_forwards_run_system_events_as_run_events(tmp_path: Path) -> None:
    manager = WorkflowManager(type("R", (), {})())

    async def run() -> None:
        workflow = await manager.create(tmp_path, "Events", "Goal", WorkflowGraph(nodes=[WorkflowNode(id="a", name="A")]))
        await manager._forward_run_event(
            tmp_path,
            workflow.id,
            "a",
            RunEvent(run_id="run-a", timestamp=utc_now(), stream="system", message="Run queued"),
        )
        events = await manager.replay_events(tmp_path, workflow.id)
        assert events[-1].event_type == "run"
        assert events[-1].message == "Run queued"

    assert workflow_event_type_for_run_stream("codex") == "aris"
    assert workflow_event_type_for_run_stream("system") == "run"
    asyncio.run(run())


def test_workflow_expected_output_file_detection(tmp_path: Path) -> None:
    node = WorkflowNode(
        id="intro",
        name="Intro",
        outputs=["INTRO_CONTEXT.md", "summary bullets", "paper/sections/1_intro.tex"],
    )
    assert missing_concrete_outputs(tmp_path, node) == [
        "INTRO_CONTEXT.md",
        "paper/sections/1_intro.tex",
    ]

    (tmp_path / "INTRO_CONTEXT.md").write_text("ok", encoding="utf-8")
    (tmp_path / "paper/sections").mkdir(parents=True)
    (tmp_path / "paper/sections/1_intro.tex").write_text("ok", encoding="utf-8")
    assert missing_concrete_outputs(tmp_path, node) == []


def test_run_manager_handles_large_stdout_lines(tmp_path: Path) -> None:
    manager = RunManager()
    run_id = "large-output"
    insert_run(
        RunRecord(
            id=run_id,
            workspace=str(tmp_path),
            skill="smoke",
            status="queued",
            created_at=utc_now(),
            updated_at=utc_now(),
            command=[],
        )
    )

    async def run() -> None:
        command = [sys.executable, "-c", "print('x' * 70000)"]
        await manager._run_process(run_id, tmp_path, command)
        record = get_run(tmp_path, run_id)
        events = await manager.replay_events(tmp_path, run_id)
        assert record is not None
        assert record.status == "succeeded"
        assert any(event.stream == "stdout" and len(event.message) == 70000 for event in events)

    asyncio.run(run())


def test_run_manager_env_overrides_are_scoped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ARIS_NODE_ID", raising=False)
    manager = RunManager()

    def seed_run(run_id: str) -> None:
        insert_run(
            RunRecord(
                id=run_id,
                workspace=str(tmp_path),
                skill="smoke",
                status="queued",
                created_at=utc_now(),
                updated_at=utc_now(),
                command=[],
            )
        )

    async def run() -> None:
        seed_run("env-a")
        seed_run("env-b")
        command = [sys.executable, "-c", "import os; print(os.environ.get('ARIS_NODE_ID', 'none'))"]
        await manager._run_process("env-a", tmp_path, command, {"ARIS_NODE_ID": "node-a"})
        await manager._run_process("env-b", tmp_path, command)

        events_a = await manager.replay_events(tmp_path, "env-a")
        events_b = await manager.replay_events(tmp_path, "env-b")
        assert any(event.stream == "stdout" and event.message == "node-a" for event in events_a)
        assert any(event.stream == "stdout" and event.message == "none" for event in events_b)

    asyncio.run(run())


def test_workflow_node_prompt_includes_agent_config(tmp_path: Path) -> None:
    config = save_agent_config(
        tmp_path,
        AgentConfigRequest(
            workspace=str(tmp_path),
            id="critic",
            name="Critic",
            role="method reviewer",
            skill=None,
            model="gpt-5.4",
            effort="xhigh",
            system_prompt="Challenge weak claims.",
            prompt_prefix="Before doing the node, list hidden assumptions.",
            output_contract="Write REVIEW.md with issues and fixes.",
        ),
    )
    manager = WorkflowManager(type("R", (), {})())

    async def run() -> None:
        workflow = await manager.create(
            tmp_path,
            "Configured workflow",
            "Review the research plan",
            WorkflowGraph(
                nodes=[
                    WorkflowNode(
                        id="review",
                        name="Review",
                        role="reviewer",
                        config_file=config.path,
                        prompt="Review the current plan.",
                    )
                ]
            ),
        )
        node = workflow.graph_json.nodes[0]
        prompt = manager._build_node_prompt(tmp_path, workflow, node)
        assert "Agent configuration profile:" in prompt
        assert "Config file: .aris/web/agent-configs/critic.json" in prompt
        assert "Challenge weak claims." in prompt
        assert "Before doing the node, list hidden assumptions." in prompt
        assert "Write REVIEW.md with issues and fixes." in prompt
        assert "Use relative paths" in prompt
        assert "ARIS_SUBAGENT_DIR=.aris/web/workflows/" in prompt
        assert "Use ARIS_SUBAGENT_DIR for scratch files" in prompt
        assert "Declared concrete outputs belong at their requested workspace-relative paths" in prompt

    asyncio.run(run())


def test_sub_agent_runs_use_isolated_attempt_directories(tmp_path: Path) -> None:
    class FakeBus:
        async def subscribe(self, run_id: str) -> asyncio.Queue[RunEvent]:
            return asyncio.Queue()

        async def unsubscribe(self, run_id: str, queue: asyncio.Queue[RunEvent]) -> None:
            return None

    class FakeRunManager:
        def __init__(self) -> None:
            self.bus = FakeBus()
            self.requests: list[CreateRunRequest] = []

        async def create_run(self, request: CreateRunRequest, skill: SkillInfo, workspace: Path) -> RunRecord:
            self.requests.append(request)
            run_id = f"run-{len(self.requests)}"
            record = RunRecord(
                id=run_id,
                workspace=str(workspace),
                skill=request.skill,
                status="succeeded",
                created_at=utc_now(),
                updated_at=utc_now(),
                command=[],
            )
            insert_run(record)
            return record

        async def replay_events(self, workspace: Path, run_id: str) -> list[RunEvent]:
            return []

    manager = WorkflowManager(FakeRunManager())

    async def run() -> None:
        workflow = await manager.create(
            tmp_path,
            "Isolation",
            "Goal",
            WorkflowGraph(
                schema_version=2,
                nodes=[
                    WorkflowNode(id="a", name="A", type="sub_agent"),
                    WorkflowNode(id="b", name="B", type="sub_agent"),
                ],
            ),
        )
        result_a = await manager._run_node_with_aris(tmp_path, workflow, workflow.graph_json.nodes[0])
        result_b = await manager._run_node_with_aris(tmp_path, workflow, workflow.graph_json.nodes[1])

        assert result_a.succeeded
        assert result_b.succeeded
        requests = manager.run_manager.requests
        dir_a = Path(requests[0].env_overrides["ARIS_SUBAGENT_DIR"])
        dir_b = Path(requests[1].env_overrides["ARIS_SUBAGENT_DIR"])
        assert dir_a != dir_b
        assert dir_a.name == "attempt-1"
        assert dir_b.name == "attempt-1"
        assert dir_a.exists()
        assert dir_b.exists()
        assert requests[0].env_overrides["ARIS_NODE_ID"] == "a"
        assert requests[1].env_overrides["ARIS_NODE_ID"] == "b"

    asyncio.run(run())


def test_workflow_manager_gates_and_approval(tmp_path: Path) -> None:
    calls: list[str] = []

    async def fake_runner(workspace: Path, record, node) -> NodeRunResult:
        calls.append(node.id)
        return NodeRunResult(run_id=f"run-{node.id}", succeeded=True, message="ok")

    manager = WorkflowManager(type("R", (), {})(), node_runner=fake_runner)
    graph = WorkflowGraph(
        nodes=[
            WorkflowNode(id="a", name="A", gate="before"),
            WorkflowNode(id="b", name="B", depends_on=["a"]),
        ]
    )

    async def run() -> None:
        workflow = await manager.create(tmp_path, "Gated", "Goal", graph)
        paused = await manager.execute(tmp_path, workflow.id)
        assert paused.status == "paused"
        assert paused.graph_json.nodes[0].status == "waiting_approval"

        await manager.approve_node(tmp_path, workflow.id, "a")
        for _ in range(40):
            current = get_workflow(tmp_path, workflow.id)
            if current and current.status == "paused" and current.graph_json.nodes[0].status == "waiting_approval" and current.graph_json.nodes[0].run_id:
                break
            await asyncio.sleep(0.05)
        current = get_workflow(tmp_path, workflow.id)
        assert current is not None
        assert current.status == "paused"
        assert current.graph_json.nodes[0].status == "waiting_approval"
        assert current.graph_json.nodes[1].status == "queued"
        assert calls == ["a"]

        await manager.approve_batch(tmp_path, workflow.id)
        for _ in range(40):
            current = get_workflow(tmp_path, workflow.id)
            if current and current.status == "paused" and current.graph_json.nodes[1].status == "waiting_approval":
                break
            await asyncio.sleep(0.05)
        current = get_workflow(tmp_path, workflow.id)
        assert current is not None
        assert current.status == "paused"
        assert current.graph_json.nodes[0].status == "succeeded"
        assert current.graph_json.nodes[1].status == "waiting_approval"
        assert calls == ["a", "b"]

        finished = await manager.approve_batch(tmp_path, workflow.id)
        assert finished.status == "succeeded"
        assert all(node.status == "succeeded" for node in finished.graph_json.nodes)
        assert calls == ["a", "b"]

    asyncio.run(run())


def test_workflow_manager_runs_ready_nodes_as_approval_batch(tmp_path: Path) -> None:
    running = 0
    max_running = 0

    async def fake_runner(workspace: Path, record, node) -> NodeRunResult:
        nonlocal running, max_running
        running += 1
        max_running = max(max_running, running)
        await asyncio.sleep(0.05)
        running -= 1
        return NodeRunResult(run_id=f"run-{node.id}", succeeded=True)

    manager = WorkflowManager(type("R", (), {})(), max_concurrency=2, node_runner=fake_runner)
    graph = WorkflowGraph(
        nodes=[
            WorkflowNode(id="a", name="A"),
            WorkflowNode(id="b", name="B"),
            WorkflowNode(id="c", name="C"),
            WorkflowNode(id="d", name="D", depends_on=["a", "b", "c"]),
        ]
    )

    async def run() -> None:
        workflow = await manager.create(tmp_path, "Concurrent", "Goal", graph)
        await manager.execute(tmp_path, workflow.id)
        for _ in range(40):
            current = get_workflow(tmp_path, workflow.id)
            if current and current.status == "paused":
                break
            await asyncio.sleep(0.05)
        current = get_workflow(tmp_path, workflow.id)
        assert current is not None
        nodes = {node.id: node for node in current.graph_json.nodes}
        assert current.status == "paused"
        assert {nodes["a"].status, nodes["b"].status, nodes["c"].status} == {"waiting_approval"}
        assert nodes["d"].status == "queued"
        assert max_running == 3

        await manager.approve_batch(tmp_path, workflow.id)
        for _ in range(40):
            current = get_workflow(tmp_path, workflow.id)
            if current and current.status == "paused" and current.graph_json.nodes[-1].status == "waiting_approval":
                break
            await asyncio.sleep(0.05)
        current = get_workflow(tmp_path, workflow.id)
        assert current is not None
        assert current.graph_json.nodes[-1].status == "waiting_approval"
        finished = await manager.approve_batch(tmp_path, workflow.id)
        assert finished.status == "succeeded"

    asyncio.run(run())


def test_workflow_manager_expands_fanout_sub_agents_from_json_output(tmp_path: Path) -> None:
    calls: list[str] = []

    async def fake_runner(workspace: Path, record, node) -> NodeRunResult:
        calls.append(node.id)
        run_id = f"run-{node.id}"
        output_path = node_output_path(workspace, run_id)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if node.id == "keywords":
            output_path.write_text(
                json.dumps(
                    {
                        "text": "",
                        "json": {
                            "keyword_groups": [
                                {"name": "large", "keywords": ["foundation models", "research agents"]},
                                {"name": "medium", "keywords": ["workflow orchestration", "human approval"]},
                                {"name": "small", "keywords": ["Scopus query", "paper abstract"]},
                            ]
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        return NodeRunResult(run_id=run_id, succeeded=True, message="ok")

    manager = WorkflowManager(type("R", (), {})(), node_runner=fake_runner)
    graph = WorkflowGraph(
        schema_version=2,
        nodes=[
            WorkflowNode(
                id="keywords",
                type="agent",
                name="Keyword planner",
                role="planner",
                prompt="Return keyword_groups JSON with large, medium, and small groups.",
            ),
            WorkflowNode(
                id="literature-template",
                type="sub_agent",
                name="Literature search template",
                role="literature scout",
                prompt="Search and summarize papers for {{item.name}} keywords: {{item.keywords}}",
                depends_on=["keywords"],
                fanout={
                    "source": "keywords",
                    "path": "keyword_groups",
                    "name_template": "Literature search: {{item.name}}",
                    "max_items": 12,
                },
            ),
            WorkflowNode(
                id="synthesis",
                type="agent",
                name="Synthesize results",
                role="planner",
                prompt="Merge the literature summaries.",
                depends_on=["literature-template"],
            ),
        ],
    )

    async def run() -> None:
        workflow = await manager.create(tmp_path, "Fanout", "Search three keyword groups", graph)
        await manager.execute(tmp_path, workflow.id)
        for _ in range(40):
            current = get_workflow(tmp_path, workflow.id)
            if current and current.status == "paused" and current.graph_json.nodes[0].status == "waiting_approval":
                break
            await asyncio.sleep(0.05)

        assert calls == ["keywords"]
        await manager.approve_batch(tmp_path, workflow.id)
        for _ in range(80):
            current = get_workflow(tmp_path, workflow.id)
            generated = [node for node in current.graph_json.nodes if node.fanout_parent_id == "literature-template"] if current else []
            if current and current.status == "paused" and len(generated) == 3 and all(node.status == "waiting_approval" for node in generated):
                break
            await asyncio.sleep(0.05)

        current = get_workflow(tmp_path, workflow.id)
        assert current is not None
        nodes = {node.id: node for node in current.graph_json.nodes}
        generated = [node for node in current.graph_json.nodes if node.fanout_parent_id == "literature-template"]
        generated_ids = {node.id for node in generated}

        assert nodes["literature-template"].status == "succeeded"
        assert generated_ids == {
            "literature-template-large",
            "literature-template-medium",
            "literature-template-small",
        }
        assert nodes["synthesis"].depends_on == sorted(generated_ids)
        assert all(node.depends_on == ["keywords"] for node in generated)
        assert all(node.status == "waiting_approval" for node in generated)
        assert any("large keywords" in node.prompt for node in generated)
        assert {"keywords", *generated_ids} <= set(calls)
        assert "synthesis" not in calls

        prompt = manager._build_node_prompt(tmp_path, current, nodes["literature-template-large"])
        assert "Dynamic fan-out assignment:" in prompt
        assert "foundation models" in prompt

        await manager.approve_batch(tmp_path, workflow.id)
        for _ in range(40):
            current = get_workflow(tmp_path, workflow.id)
            if current and current.status == "paused":
                nodes_now = {node.id: node for node in current.graph_json.nodes}
                if nodes_now["synthesis"].status == "waiting_approval":
                    break
            await asyncio.sleep(0.05)

        current = get_workflow(tmp_path, workflow.id)
        assert current is not None
        nodes = {node.id: node for node in current.graph_json.nodes}
        assert nodes["synthesis"].status == "waiting_approval"

    asyncio.run(run())


def test_workflow_manager_expands_fanout_from_node_artifact_json(tmp_path: Path) -> None:
    calls: list[str] = []

    async def fake_runner(workspace: Path, record, node) -> NodeRunResult:
        calls.append(node.id)
        run_id = f"run-{node.id}"
        if node.id == "keywords":
            artifact_dir = workspace / ".aris" / "web" / "workflows" / record.id / "nodes" / node.id / "attempt-1"
            artifact_dir.mkdir(parents=True, exist_ok=True)
            (artifact_dir / "keyword_groups.json").write_text(
                json.dumps(
                    {
                        "keyword_groups": [
                            {"name": "bayes", "keywords": ["Bayesian point estimation"]},
                            {"name": "bootstrap", "keywords": ["Bayesian bootstrap"]},
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            last_message_path(workspace, run_id).parent.mkdir(parents=True, exist_ok=True)
            last_message_path(workspace, run_id).write_text(
                "Wrote `.aris/web/workflows/.../nodes/keywords/attempt-1/keyword_groups.json`.",
                encoding="utf-8",
            )
            node_output_path(workspace, run_id).write_text(
                json.dumps({"text": "see artifact", "json": None}, ensure_ascii=False),
                encoding="utf-8",
            )
        return NodeRunResult(run_id=run_id, succeeded=True, message="ok")

    manager = WorkflowManager(type("R", (), {})(), node_runner=fake_runner)
    graph = WorkflowGraph(
        schema_version=2,
        nodes=[
            WorkflowNode(id="keywords", type="agent", name="Keyword planner", role="planner", prompt="Write keyword_groups.json."),
            WorkflowNode(
                id="literature-template",
                type="sub_agent",
                name="Literature search template",
                role="literature scout",
                prompt="Search for {{item.name}}: {{item.keywords}}",
                depends_on=["keywords"],
                fanout={"source": "keywords", "path": "keyword_groups", "name_template": "Search: {{item.name}}"},
            ),
        ],
    )

    async def run() -> None:
        workflow = await manager.create(tmp_path, "Fanout artifacts", "Search keyword group artifacts", graph)
        await manager.execute(tmp_path, workflow.id)
        for _ in range(40):
            current = get_workflow(tmp_path, workflow.id)
            if current and current.status == "paused" and current.graph_json.nodes[0].status == "waiting_approval":
                break
            await asyncio.sleep(0.05)

        await manager.approve_batch(tmp_path, workflow.id)
        for _ in range(80):
            current = get_workflow(tmp_path, workflow.id)
            generated = [node for node in current.graph_json.nodes if node.fanout_parent_id == "literature-template"] if current else []
            if current and current.status == "paused" and len(generated) == 2 and all(node.status == "waiting_approval" for node in generated):
                break
            await asyncio.sleep(0.05)

        current = get_workflow(tmp_path, workflow.id)
        assert current is not None
        generated = [node for node in current.graph_json.nodes if node.fanout_parent_id == "literature-template"]
        assert {node.id for node in generated} == {"literature-template-bayes", "literature-template-bootstrap"}
        assert all(node.status == "waiting_approval" for node in generated)
        assert any("Bayesian point estimation" in node.prompt for node in generated)
        assert {"keywords", "literature-template-bayes", "literature-template-bootstrap"} <= set(calls)

    asyncio.run(run())


def test_workflow_manager_reruns_fanout_rewires_downstream_dependencies(tmp_path: Path) -> None:
    async def fake_runner(workspace: Path, record, node) -> NodeRunResult:
        run_id = f"run-{node.id}"
        output_path = node_output_path(workspace, run_id)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if node.id == "keywords":
            output_path.write_text(
                json.dumps(
                    {
                        "text": "",
                        "json": {
                            "keyword_groups": [
                                {"name": "alpha", "keywords": ["alpha"]},
                                {"name": "beta", "keywords": ["beta"]},
                            ]
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        return NodeRunResult(run_id=run_id, succeeded=True, message="ok")

    manager = WorkflowManager(type("R", (), {})(), node_runner=fake_runner)
    graph = WorkflowGraph(
        schema_version=2,
        nodes=[
            WorkflowNode(id="keywords", type="agent", name="Keyword planner", role="planner", prompt="Return groups."),
            WorkflowNode(
                id="literature-template",
                type="sub_agent",
                name="Literature search template",
                role="literature scout",
                prompt="Search {{item.name}}",
                depends_on=["keywords"],
                fanout={"source": "keywords", "path": "keyword_groups", "name_template": "Search: {{item.name}}"},
            ),
            WorkflowNode(id="synthesis", type="agent", name="Synthesis", role="writer", prompt="Merge.", depends_on=["literature-template"]),
        ],
    )

    async def run() -> None:
        workflow = await manager.create(tmp_path, "Fanout rerun", "Search groups", graph)
        await manager.execute(tmp_path, workflow.id)
        for _ in range(40):
            current = get_workflow(tmp_path, workflow.id)
            if current and current.graph_json.nodes[0].status == "waiting_approval":
                break
            await asyncio.sleep(0.05)

        await manager.approve_batch(tmp_path, workflow.id)
        for _ in range(80):
            current = get_workflow(tmp_path, workflow.id)
            generated = [node for node in current.graph_json.nodes if node.fanout_parent_id == "literature-template"] if current else []
            if current and len(generated) == 2 and all(node.status == "waiting_approval" for node in generated):
                break
            await asyncio.sleep(0.05)

        await manager.rerun_node(tmp_path, workflow.id, "literature-template", reset_downstream=True)
        for _ in range(80):
            current = get_workflow(tmp_path, workflow.id)
            generated = [node for node in current.graph_json.nodes if node.fanout_parent_id == "literature-template"] if current else []
            if current and len(generated) == 2:
                nodes = {node.id: node for node in current.graph_json.nodes}
                if nodes["synthesis"].depends_on == sorted(node.id for node in generated):
                    break
            await asyncio.sleep(0.05)

        current = get_workflow(tmp_path, workflow.id)
        assert current is not None
        generated = [node for node in current.graph_json.nodes if node.fanout_parent_id == "literature-template"]
        generated_ids = {node.id for node in generated}
        nodes = {node.id: node for node in current.graph_json.nodes}
        assert generated_ids == {"literature-template-alpha", "literature-template-beta"}
        assert nodes["synthesis"].depends_on == sorted(generated_ids)

    asyncio.run(run())


def test_workflow_api_rerun_accepts_reset_descendants_alias(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from app import main

    workspace = tmp_path / "workspace"
    workspace.mkdir()

    async def fake_runner(workspace: Path, record, node) -> NodeRunResult:
        return NodeRunResult(run_id=f"run-{node.id}", succeeded=True)

    main.workspace_store = WorkspaceStore(home=tmp_path / "home", default_workspace=workspace)
    main.run_manager = RunManager()
    main.workflow_manager = WorkflowManager(main.run_manager, node_runner=fake_runner)
    client = TestClient(main.app)

    create_response = client.post(
        "/api/workflows",
        json={
            "workspace": str(workspace),
            "title": "Rerun alias",
            "goal": "Goal",
            "graph_json": {
                "schema_version": 2,
                "nodes": [
                    {"id": "a", "name": "A", "type": "sub_agent", "status": "failed", "run_id": "old-a"},
                    {
                        "id": "b",
                        "name": "B",
                        "type": "sub_agent",
                        "status": "skipped",
                        "depends_on": ["a"],
                        "error": "Blocked by upstream failure",
                    },
                ],
                "edges": [{"id": "a->b", "source": "a", "target": "b"}],
            },
        },
    )
    assert create_response.status_code == 200
    workflow = create_response.json()

    rerun_response = client.post(
        f"/api/workflows/{workflow['id']}/nodes/a/rerun?workspace={workspace}",
        json={"reset_descendants": True},
    )
    assert rerun_response.status_code == 200

    for _ in range(20):
        current_response = client.get(f"/api/workflows/{workflow['id']}?workspace={workspace}")
        assert current_response.status_code == 200
        current = current_response.json()
        if current["status"] == "paused" and current["graph_json"]["nodes"][0]["status"] == "waiting_approval":
            break
        time.sleep(0.05)

    current_response = client.get(f"/api/workflows/{workflow['id']}?workspace={workspace}")
    current = current_response.json()
    nodes = {node["id"]: node for node in current["graph_json"]["nodes"]}
    assert nodes["a"]["status"] == "waiting_approval"
    assert nodes["b"]["status"] == "queued"
    assert nodes["b"]["error"] is None


def test_workflow_api_create_execute_and_stream(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from app import main

    workspace = tmp_path / "workspace"
    workspace.mkdir()

    async def fake_runner(workspace: Path, record, node) -> NodeRunResult:
        return NodeRunResult(run_id=f"run-{node.id}", succeeded=True)

    main.workspace_store = WorkspaceStore(home=tmp_path / "home", default_workspace=workspace)
    main.workflow_manager = WorkflowManager(main.run_manager, node_runner=fake_runner)
    client = TestClient(main.app)

    template_response = client.post(
        "/api/workflows",
        json={
            "workspace": str(workspace),
            "title": "Intro workflow",
            "goal": "Draft the paper introduction",
            "template": "paper_introduction",
        },
    )
    assert template_response.status_code == 200
    assert template_response.json()["graph_json"]["nodes"][-1]["id"] == "approve-introduction"

    create_response = client.post(
        "/api/workflows",
        json={
            "workspace": str(workspace),
            "title": "API workflow",
            "goal": "Goal",
            "graph_json": {"nodes": [{"id": "a", "name": "A", "gate": "before"}], "edges": []},
        },
    )
    assert create_response.status_code == 200
    workflow = create_response.json()

    execute_response = client.post(f"/api/workflows/{workflow['id']}/execute?workspace={workspace}")
    assert execute_response.status_code == 200
    assert execute_response.json()["status"] == "paused"

    approve_response = client.post(f"/api/workflows/{workflow['id']}/nodes/a/approve?workspace={workspace}")
    assert approve_response.status_code == 200

    for _ in range(20):
        current_response = client.get(f"/api/workflows/{workflow['id']}?workspace={workspace}")
        assert current_response.status_code == 200
        current_workflow = current_response.json()
        if current_workflow["status"] == "paused" and current_workflow["graph_json"]["nodes"][0]["run_id"]:
            break
        time.sleep(0.05)
    approve_batch_response = client.post(f"/api/workflows/{workflow['id']}/approve-batch?workspace={workspace}")
    assert approve_batch_response.status_code == 200
    assert approve_batch_response.json()["status"] == "succeeded"

    delete_response = client.delete(f"/api/workflows/{template_response.json()['id']}?workspace={workspace}")
    assert delete_response.status_code == 200
    listed = client.get(f"/api/workflows?workspace={workspace}")
    assert listed.status_code == 200
    assert template_response.json()["id"] not in {item["id"] for item in listed.json()}

    with client.websocket_connect(f"/api/workflows/{workflow['id']}/stream?workspace={workspace}") as websocket:
        first = websocket.receive_json()
        assert first["workflow_id"] == workflow["id"]
