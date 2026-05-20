from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

from .config import REPO_ROOT
from .global_settings import build_runtime_env, effective_effort_override, effective_model_override
from .models import CreateRunRequest, RunEvent, RunRecord
from .skills import SkillInfo
from .storage import (
    events_path,
    insert_run,
    last_message_path,
    node_output_path,
    run_path,
    utc_now,
    update_run,
)


SUBPROCESS_STREAM_LIMIT = 16 * 1024 * 1024
LOCAL_BIN_DIR = REPO_ROOT / ".aris-bin"
SAFE_WORKSPACE_TOOLS = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "LlmReview",
    "Skill",
    "ToolSearch",
    "NotebookEdit",
    "Sleep",
    "SendUserMessage",
    "Config",
    "StructuredOutput",
]


def _local_executable(name: str) -> Path | None:
    candidates = [name]
    if os.name == "nt":
        candidates.extend([f"{name}.exe", f"{name}.cmd", f"{name}.bat"])
    for candidate in candidates:
        path = LOCAL_BIN_DIR / candidate
        if path.exists():
            return path
    return None


def resolve_aris_binary() -> str | None:
    local = _local_executable("aris")
    if local:
        return str(local)
    return shutil.which("aris")


def _command_available(command: str, env: dict[str, str]) -> bool:
    command_path = Path(command)
    if command_path.is_absolute() and command_path.exists():
        return True
    return shutil.which(command, path=env.get("PATH")) is not None


def build_aris_prompt(skill: SkillInfo, request: CreateRunRequest) -> str:
    parts = [
        "You are running ARIS-Code from the local web console.",
        "",
        f"ARIS repository root: {REPO_ROOT}",
        f"Target skill id: {skill.id}",
        f"Target skill name: /{skill.name}",
        f"Skill source: {skill.source_path}",
        f"Workspace: {request.workspace}",
        "",
        "User arguments:",
        request.arguments.strip() or "(none)",
        "",
        "Execution policy:",
        "- Execute the requested ARIS skill/workflow end to end inside this workspace.",
        "- The subprocess current working directory is already the workspace.",
        "- Do not use Bash, shell scripts, PowerShell, REPL tools, or sub-agent spawning from the web runner.",
        "- Use the available workspace-safe tools directly: read/write/edit/glob/grep/WebSearch/WebFetch/Skill/LlmReview.",
        "- If a skill suggests a helper script that requires Bash, perform the equivalent search, reading, or writing with the safe tools instead.",
        "- Use relative paths such as `.` and `paper/...` for file operations; do not use absolute workspace paths in commands or tool inputs.",
        "- Use the SKILL.md source as the contract for the workflow.",
        "- Run fully automatically where possible inside workspace-write permissions.",
        "- Keep all outputs and logs in the workspace, preferably under .aris/ or the skill's standard artifact paths.",
        "- Do not store API keys or credentials in files.",
    ]
    if request.effort:
        parts.append(f"- Effort: {request.effort}")
    if request.assurance:
        parts.append(f"- Assurance: {request.assurance}")
    parts.extend(
        [
            "",
            "When finished, summarize the files created or changed and the final status.",
        ]
    )
    return "\n".join(parts)


def build_aris_command(
    workspace: Path,
    prompt: str,
    model: str | None = None,
) -> list[str]:
    aris_bin = resolve_aris_binary()
    if aris_bin:
        command = [aris_bin]
    elif shutil.which("cargo") and (REPO_ROOT / "Cargo.toml").exists():
        command = [
            "cargo",
            "run",
            "--quiet",
            "--manifest-path",
            str(REPO_ROOT / "Cargo.toml"),
            "--bin",
            "aris",
            "--",
        ]
    else:
        command = ["aris"]
    command.extend([
        "--permission-mode=workspace-write",
        "--allowedTools",
        ",".join(SAFE_WORKSPACE_TOOLS),
        "--output-format=json",
    ])
    if model:
        command.extend(["--model", model])
    command.extend(["prompt", prompt])
    return command


class EventBus:
    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue[RunEvent]]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, run_id: str) -> asyncio.Queue[RunEvent]:
        queue: asyncio.Queue[RunEvent] = asyncio.Queue()
        async with self._lock:
            self._subscribers.setdefault(run_id, set()).add(queue)
        return queue

    async def unsubscribe(self, run_id: str, queue: asyncio.Queue[RunEvent]) -> None:
        async with self._lock:
            subscribers = self._subscribers.get(run_id)
            if not subscribers:
                return
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(run_id, None)

    async def publish(self, event: RunEvent) -> None:
        async with self._lock:
            subscribers = list(self._subscribers.get(event.run_id, set()))
        for queue in subscribers:
            queue.put_nowait(event)


class RunManager:
    def __init__(self) -> None:
        self.bus = EventBus()
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._workspace_by_run: dict[str, Path] = {}

    async def create_run(self, request: CreateRunRequest, skill: SkillInfo, workspace: Path) -> RunRecord:
        run_id = uuid.uuid4().hex[:12]
        run_dir = run_path(workspace, run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        output_file = last_message_path(workspace, run_id)
        if not request.effort:
            if hasattr(request, "model_copy"):
                request = request.model_copy(update={"effort": effective_effort_override()})
            else:  # Pydantic v1 compatibility
                request = request.copy(update={"effort": effective_effort_override()})
        prompt = build_aris_prompt(skill, request)
        effective_model = request.model or effective_model_override()
        command = build_aris_command(workspace, prompt, effective_model)
        now = utc_now()
        record = RunRecord(
            id=run_id,
            workspace=str(workspace),
            skill=skill.id,
            arguments=request.arguments,
            model=effective_model,
            effort=request.effort,
            assurance=request.assurance,
            status="queued",
            created_at=now,
            updated_at=now,
            command=command,
            last_message_path=str(output_file),
        )
        insert_run(record)
        await self._append_event(
            workspace,
            RunEvent(
                run_id=run_id,
                timestamp=utc_now(),
                stream="system",
                message="Run queued",
                payload={"command": redact_command_for_event(command)},
            ),
        )
        await self._write_last_message_from_events(workspace, run_id)
        asyncio.create_task(self._run_process(record.id, workspace, command, request.env_overrides))
        return record

    async def cancel(self, workspace: Path, run_id: str) -> bool:
        process = self._processes.get(run_id)
        if process is None or process.returncode is not None:
            update_run(workspace, run_id, status="cancelled", finished_at=utc_now(), error="Cancelled")
            await self._append_event(
                workspace,
                RunEvent(run_id=run_id, timestamp=utc_now(), stream="system", message="Run cancelled"),
            )
            return False
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        return True

    async def replay_events(self, workspace: Path, run_id: str) -> list[RunEvent]:
        path = events_path(workspace, run_id)
        if not path.exists():
            return []
        events: list[RunEvent] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                events.append(RunEvent(**json.loads(line)))
            except Exception:
                continue
        return events

    async def _run_process(
        self,
        run_id: str,
        workspace: Path,
        command: list[str],
        env_overrides: dict[str, str] | None = None,
    ) -> None:
        self._workspace_by_run[run_id] = workspace
        env = build_runtime_env()
        if env_overrides:
            env.update({key: value for key, value in env_overrides.items() if value is not None})
        if Path(command[0]).name.lower() in {"aris", "aris.exe"} and not _command_available(command[0], env):
            message = "Neither aris nor cargo was found; install ARIS-Code or Rust/Cargo first"
            update_run(workspace, run_id, status="failed", finished_at=utc_now(), error=message)
            await self._append_event(
                workspace,
                RunEvent(run_id=run_id, timestamp=utc_now(), stream="system", message=message),
            )
            return

        update_run(workspace, run_id, status="running", started_at=utc_now())
        await self._append_event(
            workspace,
            RunEvent(run_id=run_id, timestamp=utc_now(), stream="system", message="Run started"),
        )
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(workspace),
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=SUBPROCESS_STREAM_LIMIT,
            )
            self._processes[run_id] = process
            await asyncio.gather(
                self._read_stream(workspace, run_id, process.stdout, "stdout"),
                self._read_stream(workspace, run_id, process.stderr, "stderr"),
            )
            exit_code = await process.wait()
        except Exception as exc:
            update_run(workspace, run_id, status="failed", finished_at=utc_now(), error=str(exc))
            await self._append_event(
                workspace,
                RunEvent(run_id=run_id, timestamp=utc_now(), stream="system", message=f"Run failed: {exc}"),
            )
            return
        finally:
            self._processes.pop(run_id, None)

        status = "succeeded" if exit_code == 0 else "failed"
        if exit_code < 0:
            status = "cancelled"
        update_run(workspace, run_id, status=status, finished_at=utc_now(), exit_code=exit_code)
        await self._append_event(
            workspace,
            RunEvent(
                run_id=run_id,
                timestamp=utc_now(),
                stream="system",
                message=f"Run {status} with exit code {exit_code}",
                payload={"exit_code": exit_code, "status": status},
            ),
        )
        await self._write_last_message_from_events(workspace, run_id)

    async def _read_stream(
        self,
        workspace: Path,
        run_id: str,
        stream: asyncio.StreamReader | None,
        name: str,
    ) -> None:
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip("\r\n")
            payload: dict[str, Any] | None = None
            event_stream = name
            message = text
            if name == "stdout":
                try:
                    payload = json.loads(text)
                    event_stream = "codex"
                    message = summarize_codex_event(payload)
                except json.JSONDecodeError:
                    payload = None
            await self._append_event(
                workspace,
                RunEvent(
                    run_id=run_id,
                    timestamp=utc_now(),
                    stream=event_stream,  # type: ignore[arg-type]
                    message=message,
                    payload=payload,
                ),
            )

    async def _append_event(self, workspace: Path, event: RunEvent) -> None:
        path = events_path(workspace, event.run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = event.model_dump() if hasattr(event, "model_dump") else event.dict()
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(data, ensure_ascii=False) + "\n")
        await self.bus.publish(event)

    async def _write_last_message_from_events(self, workspace: Path, run_id: str) -> None:
        output_path = last_message_path(workspace, run_id)
        collected = [
            event.message
            for event in await self.replay_events(workspace, run_id)
            if event.stream in {"stdout", "codex"}
        ]
        if not collected:
            return
        body = "\n".join(collected)
        output_path.write_text(body, encoding="utf-8")
        # Best-effort structured output: try to extract a JSON object from the
        # tail of the body so downstream nodes / the UI can consume a typed
        # payload. Failure here must not affect run status.
        parsed: Any | None = _try_extract_json(body)
        structured = {"text": body, "json": parsed}
        try:
            node_output_path(workspace, run_id).write_text(
                json.dumps(structured, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass


def _try_extract_json(body: str) -> Any | None:
    """Return a parsed JSON value if ``body`` ends with one, else ``None``.

    Handles three common cases agents emit:
      1. Whole body is a JSON document.
      2. Body ends with a fenced ```json ... ``` block.
      3. Body's last line is a JSON document.
    """
    if not body:
        return None
    stripped = body.strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    # Fenced ```json ... ``` block at tail
    fence = stripped.rfind("```")
    if fence != -1:
        prior_fence = stripped.rfind("```", 0, fence)
        if prior_fence != -1:
            inner = stripped[prior_fence + 3 : fence].strip()
            if inner.startswith("json"):
                inner = inner[4:].strip()
            try:
                return json.loads(inner)
            except json.JSONDecodeError:
                pass
    # Last non-empty line
    for line in reversed(stripped.splitlines()):
        candidate = line.strip()
        if not candidate:
            continue
        if candidate.startswith("{") or candidate.startswith("["):
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
        break
    return None


def summarize_codex_event(payload: dict[str, Any]) -> str:
    event_type = payload.get("type") or payload.get("event") or "codex"
    for key in ("message", "text", "content", "delta"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    item = payload.get("item")
    if isinstance(item, dict):
        for key in ("text", "message", "content"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return str(event_type)


def redact_command_for_event(command: list[str]) -> list[str]:
    redacted = list(command)
    if redacted:
        redacted[-1] = "<prompt>"
    return redacted
