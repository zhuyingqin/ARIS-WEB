# ARIS Web Local Console

Single-user local web console for the `aris-code` branch. It browses bundled
ARIS-Code skills, launches `aris prompt` runs, streams logs, opens workspace
artifacts, and provides a local multi-agent DAG orchestrator.

## Start the backend

```bash
cd /path/to/aris-code
python3 -m uvicorn web.backend.app.main:app --host 127.0.0.1 --port 8000
```

The backend only binds to `127.0.0.1` by default. It stores run state in each
workspace under `.aris/web/`. Runs prefer an installed `aris` binary and fall
back to `cargo run --manifest-path <repo>/Cargo.toml --bin aris -- ...`.

Workflow state is stored beside run state:

- `.aris/web/workflows.sqlite` stores the latest workflow DAG per workflow.
- `.aris/web/workflows/<workflow_id>/events.jsonl` stores replayable workflow
  and node events.
- Node execution still creates normal run records under `.aris/web/runs/`.

## Start the frontend

```bash
cd /path/to/aris-code/web/frontend
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The frontend talks to
<http://127.0.0.1:8000> unless `VITE_API_BASE` is set.

## Production-style local build

```bash
cd /path/to/aris-code/web/frontend
npm run build
cd /path/to/aris-code
python3 -m uvicorn web.backend.app.main:app --host 127.0.0.1 --port 8000
```

When `web/frontend/dist/` exists, the FastAPI backend serves it at `/` while
keeping the API under `/api/*`.

## Orchestrator v1

The Orchestrator tab supports:

- AI-generated research DAGs from a natural-language goal.
- Template DAG creation when you want a deterministic starting point.
- Node-level editing for prompt, skill, model, effort, dependencies, inputs,
  outputs, and human checkpoints.
- Backend DAG execution with a default maximum of two concurrent agent nodes.
- Workflow WebSocket logs and per-node status replay.
- Reusable Team configs stored in `.aris/web/team-configs/*.json`.
- Team insertion on the canvas: each role expands into a normal Sub-Agent node
  with independent run context, logs, and `.aris/web/workflows/.../nodes/...`
  artifact namespace.

v1 is intentionally local and single-user. It keeps workflow history simple by
storing only the latest graph, while preserving execution logs for replay.
