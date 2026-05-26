from __future__ import annotations

import asyncio
import json
import os
import re
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
    get_run,
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
    built = REPO_ROOT / "target" / "debug" / ("aris.exe" if os.name == "nt" else "aris")
    if built.exists():
        return str(built)
    return shutil.which("aris")


def _command_available(command: str, env: dict[str, str]) -> bool:
    command_path = Path(command)
    if command_path.is_absolute() and command_path.exists():
        return True
    return shutil.which(command, path=env.get("PATH")) is not None


def build_aris_prompt(skill: SkillInfo, request: CreateRunRequest) -> str:
    workflow_artifact_dir = (request.env_overrides or {}).get("ARIS_SUBAGENT_DIR")
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
    ]
    if skill.id != "workflow-agent":
        parts.extend(
            [
                "Execution policy:",
                "- Execute the requested ARIS skill/workflow end to end inside this workspace.",
                "- The subprocess current working directory is already the workspace.",
                "- Do not use Bash, shell scripts, PowerShell, REPL tools, or sub-agent spawning from the web runner.",
                "- Use the available workspace-safe tools directly: read/write/edit/glob/grep/WebFetch/WebSearch/TodoWrite/LlmReview/Skill.",
                "- If a skill suggests a helper script that requires Bash, perform the equivalent search, reading, or writing with the safe tools instead.",
                "- Use relative paths such as `.` and `paper/...` for file operations; do not use absolute workspace paths in commands or tool inputs.",
                "- Use the SKILL.md source as the contract for the workflow.",
                "- Run fully automatically where possible inside workspace-write permissions.",
                "- Keep all outputs and logs in the workspace, preferably under .aris/ or the skill's standard artifact paths.",
                "- Do not store API keys or credentials in files.",
            ]
        )
        if workflow_artifact_dir:
            parts.extend(
                [
                    "- This is a workflow node run. Put node-generated reports, plans, notes, datasets, matrices, drafts, and other deliverable artifacts under ARIS_SUBAGENT_DIR.",
                    f"- ARIS_SUBAGENT_DIR={workflow_artifact_dir}",
                    "- Do not create new workflow artifact files in the workspace root.",
                    "- Only edit files outside ARIS_SUBAGENT_DIR when the node task explicitly requires changing existing project source files.",
                ]
            )
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
    session_path: str | None = None,
    allowed_tools: list[str] | None = None,
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
        ",".join(allowed_tools or SAFE_WORKSPACE_TOOLS),
        "--output-format=json",
    ])
    if model:
        command.extend(["--model", model])
    if session_path:
        command.extend(["--session-path", session_path])
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
        self._runtime_event_offsets: dict[str, int] = {}
        self._runtime_event_keys: dict[str, set[str]] = {}

    async def create_run(self, request: CreateRunRequest, skill: SkillInfo, workspace: Path) -> RunRecord:
        run_id = uuid.uuid4().hex[:12]
        run_dir = run_path(workspace, run_id)
        run_dir.mkdir(parents=True, exist_ok=True)
        output_file = last_message_path(workspace, run_id)
        if not request.effort:
            if hasattr(request, "model_copy"):
                request = request.model_copy(update={"effort": effective_effort_override(model=request.model)})
            else:  # Pydantic v1 compatibility
                request = request.copy(update={"effort": effective_effort_override(model=request.model)})
        prompt = build_aris_prompt(skill, request)
        effective_model = request.model or effective_model_override()
        model_label = effective_model or "runtime default"
        command = build_aris_command(workspace, prompt, effective_model, request.session_path, request.allowed_tools)
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
                message=f"Run queued (model: {model_label})",
                payload={
                    "command": redact_command_for_event(command),
                    "model": model_label,
                    "skill": skill.id,
                    "effort": request.effort,
                },
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
                event = RunEvent(**json.loads(line))
                events.extend(expand_replayed_run_event(event))
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
        run_record = get_run(workspace, run_id)
        env = build_runtime_env(model=run_record.model if run_record else None)
        if env_overrides:
            env.update({key: value for key, value in env_overrides.items() if value is not None})
        run_model = (run_record.model if run_record else None) or "runtime default"
        run_skill = run_record.skill if run_record else None
        run_effort = run_record.effort if run_record else None
        runtime_events_path = run_path(workspace, run_id) / "runtime_events.jsonl"
        env["ARIS_META_LOGGING"] = "content"
        env["ARIS_SESSION_ID"] = run_id
        env["ARIS_META_LOG_PATH"] = str(runtime_events_path)
        executor_provider = env.get("EXECUTOR_PROVIDER") or "anthropic"
        executor_base_url = env.get("EXECUTOR_BASE_URL") or env.get("ANTHROPIC_BASE_URL") or env.get("DEEPSEEK_BASE_URL")
        if Path(command[0]).name.lower() in {"aris", "aris.exe"} and not _command_available(command[0], env):
            message = "Neither aris nor cargo was found; install ARIS-Code or Rust/Cargo first"
            update_run(workspace, run_id, status="failed", finished_at=utc_now(), error=message)
            await self._append_event(
                workspace,
                RunEvent(
                    run_id=run_id,
                    timestamp=utc_now(),
                    stream="system",
                    message=message,
                    payload={"model": run_model, "skill": run_skill, "effort": run_effort},
                ),
            )
            return

        update_run(workspace, run_id, status="running", started_at=utc_now())
        await self._append_event(
            workspace,
            RunEvent(
                run_id=run_id,
                timestamp=utc_now(),
                stream="system",
                message=f"Run started (model: {run_model})",
                payload={
                    "model": run_model,
                    "skill": run_skill,
                    "effort": run_effort,
                    "executor_provider": executor_provider,
                    "executor_base_url": executor_base_url,
                },
            ),
        )
        runtime_tail_task = asyncio.create_task(
            self._tail_runtime_events(workspace, run_id, runtime_events_path)
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
            runtime_tail_task.cancel()
            try:
                await runtime_tail_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
            await self._drain_runtime_event_file(workspace, run_id, runtime_events_path)
            self._runtime_event_offsets.pop(run_id, None)
            self._runtime_event_keys.pop(run_id, None)

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
                message=f"Run {status} with exit code {exit_code} (model: {run_model})",
                payload={"exit_code": exit_code, "status": status, "model": run_model, "skill": run_skill, "effort": run_effort},
            ),
        )
        await self._write_last_message_from_events(workspace, run_id)

    async def _tail_runtime_events(self, workspace: Path, run_id: str, path: Path) -> None:
        while True:
            try:
                await self._drain_runtime_event_file(workspace, run_id, path)
            except Exception:
                pass
            await asyncio.sleep(0.25)

    async def _drain_runtime_event_file(self, workspace: Path, run_id: str, path: Path) -> None:
        if not path.exists():
            return
        offset = self._runtime_event_offsets.get(run_id, 0)
        try:
            current_size = path.stat().st_size
        except OSError:
            return
        if current_size < offset:
            offset = 0
        seen = self._runtime_event_keys.setdefault(run_id, set())
        try:
            with path.open("r", encoding="utf-8") as fh:
                fh.seek(offset)
                for line in fh:
                    raw = line.strip()
                    if not raw or raw in seen:
                        continue
                    seen.add(raw)
                    try:
                        record = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    event = runtime_meta_event_to_run_event(run_id, record)
                    if event is not None:
                        await self._append_event(workspace, event)
                self._runtime_event_offsets[run_id] = fh.tell()
        except OSError:
            return

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
                payload = parse_stdout_json_payload(text)
                if payload is not None:
                    payload = redact_sensitive_payload(payload)
                    for event in expand_codex_payload_events(run_id, payload):
                        await self._append_event(workspace, event)
                    continue
            elif name == "stderr":
                text = clean_terminal_text(text)
                if is_provider_selection_diagnostic(text):
                    continue
                message = text
                if is_nonfatal_diagnostic(text):
                    event_stream = "system"
                    payload = {"kind": "diagnostic", "level": "warning", "source_stream": "stderr"}
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
        events = await self.replay_events(workspace, run_id)
        final_messages = [
            event.message
            for event in events
            if event.stream == "result"
            and isinstance(event.payload, dict)
            and event.payload.get("kind") == "final_result"
        ]
        collected = final_messages or [
            event.message
            for event in events
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


ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
API_KEY_RE = re.compile(r"\b(?:sk|ak|rk|tp)-[A-Za-z0-9_\-]{6,}\b")
API_KEY_PREFIX_RE = re.compile(r"(?i)(api\s*key\s*prefix\s*:\s*)[A-Za-z0-9_\-]+")
API_KEY_FIELD_RE = re.compile(
    r"(?i)\b(api[_\s-]?key|secret|access[_\s-]?token|auth[_\s-]?token|[A-Z0-9_]*(?:KEY|TOKEN|SECRET))"
    r"(\s*[:=]\s*)[^\s,;]+"
)
JSON_SECRET_FIELD_RE = re.compile(
    r'(?i)("?(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|[A-Z0-9_]*(?:KEY|TOKEN|SECRET))"?\s*:\s*)"[^"]*"'
)
REQUEST_BODY_RE = re.compile(r"(?i)(\b(?:deepseek|minimax|openai|anthropic)\s+request\s+body\s*:\s*).+")


def redact_sensitive_text(text: str) -> str:
    redacted = REQUEST_BODY_RE.sub(r"\1<redacted>", text)
    redacted = JSON_SECRET_FIELD_RE.sub(r'\1"<redacted>"', redacted)
    redacted = API_KEY_PREFIX_RE.sub(r"\1<redacted>", redacted)
    redacted = API_KEY_RE.sub("<redacted-api-key>", redacted)
    redacted = API_KEY_FIELD_RE.sub(r"\1\2<redacted>", redacted)
    return redacted


def redact_sensitive_payload(value: Any) -> Any:
    if isinstance(value, str):
        return redact_sensitive_text(value)
    if isinstance(value, list):
        return [redact_sensitive_payload(item) for item in value]
    if isinstance(value, dict):
        return {key: redact_sensitive_payload(item) for key, item in value.items()}
    return value


def clean_terminal_text(text: str) -> str:
    return redact_sensitive_text(ANSI_ESCAPE_RE.sub("", text).strip())


def parse_stdout_json_payload(text: str) -> dict[str, Any] | None:
    for candidate in (text, clean_terminal_text(text)):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    cleaned = clean_terminal_text(text)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            return parsed
    return None


def runtime_meta_event_to_run_event(run_id: str, record: dict[str, Any]) -> RunEvent | None:
    session_id = str(record.get("session") or "")
    if session_id and session_id != run_id:
        return None
    event_name = str(record.get("event") or "")
    timestamp = str(record.get("ts") or utc_now())
    payload = redact_sensitive_payload({"kind": "runtime_event", **record})

    if event_name == "llm_call_start":
        iteration = record.get("iteration")
        messages = record.get("messages")
        return RunEvent(
            run_id=run_id,
            timestamp=timestamp,
            stream="thinking",
            message=f"LLM call {iteration} started ({messages} messages)",
            payload=payload,
        )
    if event_name == "llm_call_end":
        iteration = record.get("iteration")
        assistant_events = record.get("assistant_events")
        return RunEvent(
            run_id=run_id,
            timestamp=timestamp,
            stream="thinking",
            message=f"LLM call {iteration} completed ({assistant_events} assistant events)",
            payload=payload,
        )
    if event_name == "llm_call_error":
        iteration = record.get("iteration")
        message = redact_sensitive_text(str(record.get("message") or "request failed"))
        return RunEvent(
            run_id=run_id,
            timestamp=timestamp,
            stream="stderr",
            message=f"LLM call {iteration} failed: {message}",
            payload=payload,
        )
    if event_name in {"tool_call", "tool_failure"}:
        tool_name = str(record.get("tool") or "tool")
        summary = str(record.get("input_summary") or "").strip()
        label = "Tool failed" if event_name == "tool_failure" else "Tool call"
        return RunEvent(
            run_id=run_id,
            timestamp=timestamp,
            stream="stderr" if event_name == "tool_failure" else "tool",
            message=f"{label}: {tool_name}{(': ' + summary) if summary else ''}",
            payload=payload,
        )
    if event_name == "skill_invoke":
        skill_name = str(record.get("skill") or "skill")
        args = str(record.get("args") or "").strip()
        return RunEvent(
            run_id=run_id,
            timestamp=timestamp,
            stream="tool",
            message=f"Skill invoke: {skill_name}{(': ' + args) if args else ''}",
            payload=payload,
        )
    if event_name in {"session_start", "session_end", "slash_command"}:
        return RunEvent(
            run_id=run_id,
            timestamp=timestamp,
            stream="system",
            message=f"Runtime event: {event_name}",
            payload=payload,
        )
    return None


def is_nonfatal_diagnostic(text: str) -> bool:
    normalized = text.lower()
    return any(
        token in normalized
        for token in (
            "warning:",
            "retrying",
            "restart",
            "rate limit",
            "premature eof",
            "continuing without",
        )
    )


def is_provider_selection_diagnostic(text: str) -> bool:
    normalized = clean_terminal_text(text).lower()
    return any(
        token in normalized
        for token in (
            "deepseek not selected:",
            "deepseek config not found",
            "using anthropic executor",
        )
    )


def expand_codex_payload_events(run_id: str, payload: dict[str, Any]) -> list[RunEvent]:
    """Expand one-shot ARIS JSON into readable terminal transcript events."""
    now = utc_now()
    if not is_aris_final_payload(payload):
        return [
            RunEvent(
                run_id=run_id,
                timestamp=now,
                stream="codex",
                message=summarize_codex_event(payload),
                payload=payload,
            )
        ]

    events: list[RunEvent] = []
    final_text = str(payload.get("message") or "").strip()
    transcript = payload.get("events")
    if isinstance(transcript, list):
        last_final_text_index = _last_matching_text_event_index(transcript, final_text)
        for index, item in enumerate(transcript):
            if not isinstance(item, dict):
                continue
            event = codex_transcript_item_to_event(
                run_id,
                item,
                payload if index == last_final_text_index else None,
                force_final=index == last_final_text_index,
            )
            if event is not None:
                events.append(event)
    else:
        events.extend(fallback_codex_events(run_id, payload))

    if final_text and not any(
        event.stream == "result"
        and isinstance(event.payload, dict)
        and event.payload.get("kind") == "final_result"
        for event in events
    ):
        events.append(
            RunEvent(
                run_id=run_id,
                timestamp=utc_now(),
                stream="result",
                message=final_text,
                payload={**payload, "kind": "final_result"},
            )
        )
    if not events:
        events.append(
            RunEvent(
                run_id=run_id,
                timestamp=utc_now(),
                stream="codex",
                message=summarize_codex_event(payload),
                payload=payload,
            )
        )
    return events


def is_aris_final_payload(payload: dict[str, Any]) -> bool:
    return any(key in payload for key in ("message", "tool_uses", "tool_results", "usage", "events"))


def expand_replayed_run_event(event: RunEvent) -> list[RunEvent]:
    if event.stream != "codex" or not isinstance(event.payload, dict) or not is_aris_final_payload(event.payload):
        return [event]
    expanded = expand_codex_payload_events(event.run_id, event.payload)
    if len(expanded) == 1 and expanded[0].stream == "codex":
        return [event]
    return [
        RunEvent(
            run_id=event.run_id,
            timestamp=event.timestamp,
            stream=item.stream,
            message=item.message,
            payload=item.payload,
        )
        for item in expanded
    ]


def _last_matching_text_event_index(transcript: list[Any], final_text: str) -> int | None:
    if not final_text:
        return None
    normalized_final = final_text.strip()
    for index in range(len(transcript) - 1, -1, -1):
        item = transcript[index]
        if not isinstance(item, dict) or item.get("kind") != "assistant_text":
            continue
        if str(item.get("text") or "").strip() == normalized_final:
            return index
    return None


def codex_transcript_item_to_event(
    run_id: str,
    item: dict[str, Any],
    full_payload: dict[str, Any] | None = None,
    *,
    force_final: bool = False,
) -> RunEvent | None:
    kind = str(item.get("kind") or "")
    if kind == "thinking":
        thinking = str(item.get("thinking") or "").strip()
        if not thinking:
            return None
        return RunEvent(
            run_id=run_id,
            timestamp=utc_now(),
            stream="thinking",
            message=thinking,
            payload={"kind": "thinking", "iteration": item.get("iteration")},
        )
    if kind == "assistant_text":
        text = str(item.get("text") or "").strip()
        if not text:
            return None
        stream = "result" if force_final else "codex"
        payload = {**(full_payload or {}), "kind": "final_result" if force_final else "assistant_text"}
        return RunEvent(
            run_id=run_id,
            timestamp=utc_now(),
            stream=stream,
            message=text,
            payload=payload,
        )
    if kind == "tool_use":
        name = str(item.get("name") or "tool")
        detail = summarize_tool_input(item.get("input"))
        return RunEvent(
            run_id=run_id,
            timestamp=utc_now(),
            stream="tool",
            message=f"{name} call{(': ' + detail) if detail else ''}",
            payload={"kind": "tool_use", **item},
        )
    if kind == "tool_result":
        name = str(item.get("tool_name") or "tool")
        output = str(item.get("output") or "").strip()
        is_error = bool(item.get("is_error"))
        summary = truncate_text(output, 1400)
        label = f"{name} error" if is_error else f"{name} result"
        return RunEvent(
            run_id=run_id,
            timestamp=utc_now(),
            stream="stderr" if is_error else "tool",
            message=f"{label}{(': ' + summary) if summary else ''}",
            payload={"kind": "tool_result", **item},
        )
    return None


def fallback_codex_events(run_id: str, payload: dict[str, Any]) -> list[RunEvent]:
    events: list[RunEvent] = []
    for thinking in payload.get("thinking") or []:
        if isinstance(thinking, dict):
            event = codex_transcript_item_to_event(run_id, {"kind": "thinking", **thinking})
            if event is not None:
                events.append(event)
    for tool_use in payload.get("tool_uses") or []:
        if isinstance(tool_use, dict):
            event = codex_transcript_item_to_event(run_id, {"kind": "tool_use", **tool_use})
            if event is not None:
                events.append(event)
    for tool_result in payload.get("tool_results") or []:
        if isinstance(tool_result, dict):
            event = codex_transcript_item_to_event(run_id, {"kind": "tool_result", **tool_result})
            if event is not None:
                events.append(event)
    return events


def summarize_tool_input(value: Any) -> str:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return truncate_text(value, 280)
    if isinstance(value, dict):
        for key in ("query", "url", "path", "pattern", "skill", "prompt"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return truncate_text(candidate.strip(), 280)
        return truncate_text(json.dumps(value, ensure_ascii=False), 280)
    if value is None:
        return ""
    return truncate_text(str(value), 280)


def truncate_text(text: str, limit: int) -> str:
    cleaned = clean_terminal_text(text)
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(0, limit - 3)].rstrip() + "..."


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
