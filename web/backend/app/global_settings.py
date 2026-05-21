from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .config import REPO_ROOT, WEB_HOME
from .models import GlobalApiProvider, GlobalSettings, UpdateGlobalSettingsRequest
from .storage import utc_now


DEFAULT_BASE_URLS: dict[str, str] = {
    "openai": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "glm": "https://open.bigmodel.cn/api/paas/v4",
    "minimax": "https://api.minimaxi.com/anthropic",
    "kimi": "https://api.moonshot.cn/v1",
}

DEFAULT_MODELS: dict[str, str] = {
    "openai": "gpt-5.5",
    "gemini": "gemini-2.5-pro",
    "glm": "GLM-5",
    "minimax": "MiniMax-M2.7",
    "kimi": "kimi-k2.5",
}

DEFAULT_MODEL_OPTIONS: dict[str, list[str]] = {
    "anthropic": ["claude-sonnet-4-5", "claude-opus-4"],
    "openai": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
    "gemini": ["gemini-2.5-pro", "gemini-2.5-flash"],
    "glm": ["GLM-5", "GLM-5-Turbo"],
    "minimax": ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
    "kimi": ["kimi-k2.5"],
    "custom": [],
}

MANAGED_ENV_KEYS = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    "EXECUTOR_API_KEY",
    "EXECUTOR_BASE_URL",
    "EXECUTOR_PROVIDER",
    "GEMINI_API_KEY",
    "GLM_API_KEY",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
    "OPENAI_API_KEY",
    "ARIS_REASONING_EFFORT",
    "ARIS_REVIEWER_MODEL",
    "CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS",
}

DEFAULT_AUTO_COMPACT_INPUT_TOKENS = "80000"


LOCAL_BIN_DIR = REPO_ROOT / ".aris-bin"


def _prepend_local_bin(env: dict[str, str]) -> None:
    if not LOCAL_BIN_DIR.exists():
        return
    current_path = env.get("PATH", "")
    local_bin = str(LOCAL_BIN_DIR)
    entries = [entry for entry in current_path.split(os.pathsep) if entry]
    if not any(Path(entry).resolve() == LOCAL_BIN_DIR.resolve() for entry in entries):
        env["PATH"] = os.pathsep.join([local_bin, *entries]) if entries else local_bin


def settings_path(home: Path = WEB_HOME) -> Path:
    return home / "global-settings.json"


def planner_settings_path(home: Path = WEB_HOME) -> Path:
    return home / "planner-settings.json"


def _read_raw(home: Path = WEB_HOME) -> dict[str, Any]:
    path = settings_path(home)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _write_raw(data: dict[str, Any], home: Path = WEB_HOME) -> None:
    home.mkdir(parents=True, exist_ok=True)
    path = settings_path(home)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _read_planner_raw(home: Path = WEB_HOME) -> dict[str, Any]:
    path = planner_settings_path(home)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _write_planner_raw(data: dict[str, Any], home: Path = WEB_HOME) -> None:
    home.mkdir(parents=True, exist_ok=True)
    path = planner_settings_path(home)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def get_planner_llm_settings(home: Path = WEB_HOME) -> dict[str, str] | None:
    data = _read_planner_raw(home)
    api_key = str(data.get("api_key") or "").strip()
    model = str(data.get("model") or "").strip() or "gpt-5.5"
    base_url = str(data.get("base_url") or "").strip()
    wire_api = str(data.get("wire_api") or "").strip() or "responses"
    provider = str(data.get("provider") or "").strip() or "openai"
    if not api_key or not base_url:
        return None
    return {
        "provider": provider,
        "api_key": api_key,
        "base_url": base_url.rstrip("/"),
        "model": model,
        "wire_api": wire_api,
    }


def planner_llm_summary(home: Path = WEB_HOME) -> dict[str, str] | None:
    settings = get_planner_llm_settings(home)
    if not settings:
        return None
    return {
        "provider": settings["provider"],
        "base_url": settings["base_url"],
        "model": settings["model"],
        "wire_api": settings["wire_api"],
        "api_key": mask_secret(settings["api_key"]) or "",
    }


def update_planner_llm_settings(
    *,
    api_key: str,
    base_url: str,
    model: str = "gpt-5.5",
    wire_api: str = "responses",
    provider: str = "openai",
    home: Path = WEB_HOME,
) -> dict[str, str] | None:
    _write_planner_raw(
        {
            "provider": provider.strip() or "openai",
            "api_key": api_key.strip(),
            "base_url": base_url.strip().rstrip("/"),
            "model": model.strip() or "gpt-5.5",
            "wire_api": wire_api.strip() or "responses",
            "updated_at": utc_now(),
        },
        home,
    )
    return get_planner_llm_settings(home)


def mask_secret(secret: str | None) -> str | None:
    if not secret:
        return None
    if len(secret) <= 8:
        return "••••"
    return f"{secret[:4]}...{secret[-4:]}"


def clean_model_options(*groups: object) -> list[str]:
    seen: set[str] = set()
    options: list[str] = []
    for group in groups:
        values = group if isinstance(group, list) else [group]
        for value in values:
            if not isinstance(value, str):
                continue
            item = value.strip()
            if not item or item in seen:
                continue
            seen.add(item)
            options.append(item)
    return options


def model_options_for(provider: GlobalApiProvider, data: dict[str, Any]) -> list[str]:
    return clean_model_options(
        data.get("model"),
        DEFAULT_MODELS.get(provider),
        data.get("models"),
        DEFAULT_MODEL_OPTIONS.get(provider, []),
    )


def applies_to(
    provider: GlobalApiProvider,
    has_key: bool,
    base_url: str | None = None,
    model: str | None = None,
    effort: str | None = None,
) -> list[str]:
    if not has_key:
        return []
    envs: list[str] = []
    if provider == "anthropic":
        envs.extend(["ANTHROPIC_API_KEY"])
        if base_url:
            envs.append("ANTHROPIC_BASE_URL")
    elif provider == "openai":
        envs.extend(["EXECUTOR_PROVIDER=openai", "EXECUTOR_API_KEY", "OPENAI_API_KEY"])
        if base_url:
            envs.append("EXECUTOR_BASE_URL")
    elif provider == "gemini":
        envs.extend(["EXECUTOR_PROVIDER=openai", "EXECUTOR_API_KEY", "GEMINI_API_KEY", "EXECUTOR_BASE_URL"])
    elif provider == "glm":
        envs.extend(["EXECUTOR_PROVIDER=openai", "EXECUTOR_API_KEY", "GLM_API_KEY", "EXECUTOR_BASE_URL"])
    elif provider == "minimax":
        envs.extend([
            "EXECUTOR_PROVIDER=anthropic",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "MINIMAX_API_KEY",
        ])
    elif provider == "kimi":
        envs.extend(["EXECUTOR_PROVIDER=openai", "EXECUTOR_API_KEY", "KIMI_API_KEY", "EXECUTOR_BASE_URL"])
    else:
        envs.extend(["EXECUTOR_PROVIDER=openai", "EXECUTOR_API_KEY"])
        if base_url:
            envs.append("EXECUTOR_BASE_URL")
    if model or DEFAULT_MODELS.get(provider):
        envs.append("ARIS_REVIEWER_MODEL")
    if effort:
        envs.append("ARIS_REASONING_EFFORT")
    return envs


def get_global_settings(home: Path = WEB_HOME) -> GlobalSettings:
    data = _read_raw(home)
    provider = data.get("provider") or "anthropic"
    if provider not in {"anthropic", "openai", "gemini", "glm", "minimax", "kimi", "custom"}:
        provider = "anthropic"
    api_key = str(data.get("api_key") or "")
    base_url = str(data.get("base_url") or "").strip() or None
    model = str(data.get("model") or "").strip() or None
    effort = str(data.get("effort") or "").strip() or None
    models = model_options_for(provider, data)
    return GlobalSettings(
        provider=provider,
        api_key_set=bool(api_key),
        api_key_masked=mask_secret(api_key),
        base_url=base_url,
        model=model,
        models=models,
        effort=effort,
        updated_at=data.get("updated_at") or None,
        config_path=str(settings_path(home)),
        applies_to=applies_to(provider, bool(api_key), base_url, model, effort),
    )


def update_global_settings(request: UpdateGlobalSettingsRequest, home: Path = WEB_HOME) -> GlobalSettings:
    current = _read_raw(home)
    api_key = str(current.get("api_key") or "")
    if request.clear_api_key:
        api_key = ""
    elif request.api_key is not None and request.api_key.strip():
        api_key = request.api_key.strip()
    model = request.model.strip() if request.model else None
    models = clean_model_options(model, request.models if request.models is not None else current.get("models"))
    data = {
        "provider": request.provider,
        "api_key": api_key,
        "base_url": request.base_url.strip() if request.base_url else None,
        "model": model,
        "models": models,
        "effort": request.effort.strip() if request.effort else None,
        "updated_at": utc_now(),
    }
    _write_raw(data, home)
    return get_global_settings(home)


def _read_secret_settings(home: Path = WEB_HOME) -> dict[str, object]:
    data = _read_raw(home)
    if not data.get("api_key"):
        return {}
    return data


def _clear_managed_env(env: dict[str, str]) -> None:
    for key in MANAGED_ENV_KEYS:
        env.pop(key, None)


def effective_model_override(home: Path = WEB_HOME) -> str | None:
    raw = _read_raw(home)
    if not raw or not str(raw.get("api_key") or "").strip():
        return None
    provider = str(raw.get("provider") or "anthropic")
    model = str(raw.get("model") or "").strip()
    if model:
        return model
    return DEFAULT_MODELS.get(provider)


def effective_effort_override(home: Path = WEB_HOME) -> str | None:
    raw = _read_raw(home)
    if not raw or not str(raw.get("api_key") or "").strip():
        return None
    return str(raw.get("effort") or "").strip() or None


def openai_compatible_settings(home: Path = WEB_HOME) -> dict[str, str] | None:
    raw = _read_raw(home)
    api_key = str(raw.get("api_key") or "").strip()
    if not raw or not api_key:
        return None
    provider = str(raw.get("provider") or "anthropic")
    if provider not in {"openai", "gemini", "glm", "minimax", "kimi", "custom"}:
        return None
    base_url = str(raw.get("base_url") or "").strip() or DEFAULT_BASE_URLS.get(provider)
    model = effective_model_override(home)
    if not base_url or not model:
        return None
    if provider == "minimax" and "anthropic" in base_url.rstrip("/").lower():
        return None
    return {
        "provider": provider,
        "api_key": api_key,
        "base_url": base_url.rstrip("/"),
        "model": model,
        "effort": str(raw.get("effort") or "").strip(),
    }


def build_runtime_env(base_env: dict[str, str] | None = None, home: Path = WEB_HOME) -> dict[str, str]:
    env = dict(base_env if base_env is not None else os.environ)
    _prepend_local_bin(env)
    raw = _read_raw(home)
    if not raw:
        return env
    _clear_managed_env(env)

    provider = raw.get("provider") or "anthropic"
    api_key = str(raw.get("api_key") or "").strip()
    base_url = str(raw.get("base_url") or "").strip()
    model = str(raw.get("model") or "").strip()
    effort = str(raw.get("effort") or "").strip()
    if not api_key:
        return env
    env.setdefault("CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS", DEFAULT_AUTO_COMPACT_INPUT_TOKENS)

    if provider == "anthropic":
        env["ANTHROPIC_API_KEY"] = api_key
        if base_url:
            env["ANTHROPIC_BASE_URL"] = base_url
    elif provider in {"openai", "gemini", "glm", "kimi"}:
        env["EXECUTOR_PROVIDER"] = "openai"
        env["EXECUTOR_API_KEY"] = api_key
        if provider == "openai":
            env["OPENAI_API_KEY"] = api_key
        elif provider == "gemini":
            env["GEMINI_API_KEY"] = api_key
        elif provider == "glm":
            env["GLM_API_KEY"] = api_key
        elif provider == "kimi":
            env["KIMI_API_KEY"] = api_key
        env["EXECUTOR_BASE_URL"] = base_url or DEFAULT_BASE_URLS.get(provider, "")
    elif provider == "minimax":
        env["EXECUTOR_PROVIDER"] = "anthropic"
        env["ANTHROPIC_API_KEY"] = api_key
        env["ANTHROPIC_BASE_URL"] = base_url or DEFAULT_BASE_URLS["minimax"]
        env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] = "1"
        env["MINIMAX_API_KEY"] = api_key
    else:
        env["EXECUTOR_PROVIDER"] = "openai"
        env["EXECUTOR_API_KEY"] = api_key
        if base_url:
            env["EXECUTOR_BASE_URL"] = base_url

    effective_model = model or DEFAULT_MODELS.get(str(provider))
    if effective_model:
        env["ARIS_REVIEWER_MODEL"] = effective_model
    if effort:
        env["ARIS_REASONING_EFFORT"] = effort
    return env
