from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import REPO_ROOT, WEB_HOME
from .models import (
    GlobalApiProvider,
    GlobalProviderSettings,
    GlobalSettings,
    UpdateGlobalSettingsRequest,
    ValidateGlobalSettingsResponse,
)
from .storage import utc_now

try:
    import certifi
except Exception:  # pragma: no cover - certifi may be unavailable in minimal installs
    certifi = None


DEFAULT_BASE_URLS: dict[str, str] = {
    "anthropic": "https://api.anthropic.com/v1",
    "openai": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "glm": "https://open.bigmodel.cn/api/paas/v4",
    "minimax": "https://api.minimaxi.com/anthropic",
    "kimi": "https://api.moonshot.cn/v1",
    "deepseek": "https://api.deepseek.com/v1",
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

PROVIDER_IDS: tuple[GlobalApiProvider, ...] = ("openai", "minimax", "anthropic", "gemini", "glm", "kimi", "deepseek", "custom")
PROVIDER_ID_SET = set(PROVIDER_IDS)

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


class NonJsonResponseError(ValueError):
    def __init__(self, status_code: int, content_type: str | None, preview: str) -> None:
        super().__init__("Response was not JSON.")
        self.status_code = status_code
        self.content_type = content_type
        self.preview = preview


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


def normalize_provider(value: object, default: GlobalApiProvider = "openai") -> GlobalApiProvider:
    provider = str(value or "").strip()
    return provider if provider in PROVIDER_ID_SET else default  # type: ignore[return-value]


def _clean_profile(profile: object, provider: GlobalApiProvider) -> dict[str, Any]:
    data = profile if isinstance(profile, dict) else {}
    return {
        "api_key": str(data.get("api_key") or ""),
        "base_url": str(data.get("base_url") or "").strip() or None,
        "model": str(data.get("model") or "").strip() or None,
        "models": clean_model_options(data.get("model"), data.get("models")),
        "effort": str(data.get("effort") or "").strip() or None,
        "updated_at": data.get("updated_at") or None,
        "provider": provider,
    }


def _profiles_from_raw(data: dict[str, Any]) -> dict[GlobalApiProvider, dict[str, Any]]:
    profiles: dict[GlobalApiProvider, dict[str, Any]] = {}
    raw_profiles = data.get("providers")
    if isinstance(raw_profiles, dict):
        for key, value in raw_profiles.items():
            provider = normalize_provider(key, default="custom")
            profiles[provider] = _clean_profile(value, provider)

    active_provider = normalize_provider(data.get("provider"))
    has_legacy_values = any(data.get(key) for key in ("api_key", "base_url", "model", "models", "effort"))
    if has_legacy_values:
        legacy = _clean_profile(data, active_provider)
        current = profiles.get(active_provider)
        if current is None or legacy.get("api_key") or not current.get("api_key"):
            profiles[active_provider] = {**(current or {}), **legacy}
    return profiles


def _active_provider(data: dict[str, Any], profiles: dict[GlobalApiProvider, dict[str, Any]]) -> GlobalApiProvider:
    provider = normalize_provider(data.get("provider"))
    if provider in profiles or data.get("provider"):
        return provider
    for candidate in PROVIDER_IDS:
        if profiles.get(candidate, {}).get("api_key"):
            return candidate
    return provider


def _active_profile(data: dict[str, Any]) -> tuple[GlobalApiProvider, dict[str, Any]]:
    profiles = _profiles_from_raw(data)
    provider = _active_provider(data, profiles)
    return provider, profiles.get(provider, _clean_profile({}, provider))


def _profile_for_model(data: dict[str, Any], model: str | None) -> tuple[GlobalApiProvider, dict[str, Any]]:
    profiles = _profiles_from_raw(data)
    active_provider = _active_provider(data, profiles)
    requested_model = str(model or "").strip()
    if requested_model:
        ordered_providers = [active_provider, *[item for item in PROVIDER_IDS if item != active_provider]]
        for provider in ordered_providers:
            profile = profiles.get(provider, _clean_profile({}, provider))
            if not str(profile.get("api_key") or "").strip():
                continue
            if requested_model in model_options_for(provider, profile):
                return provider, profile
    return active_provider, profiles.get(active_provider, _clean_profile({}, active_provider))


def model_options_for(provider: GlobalApiProvider, data: dict[str, Any]) -> list[str]:
    return clean_model_options(
        data.get("model"),
        DEFAULT_MODELS.get(provider),
        data.get("models"),
        DEFAULT_MODEL_OPTIONS.get(provider, []),
    )


def provider_settings_for(
    provider: GlobalApiProvider,
    profile: dict[str, Any],
    *,
    active: bool,
) -> GlobalProviderSettings:
    api_key = str(profile.get("api_key") or "")
    base_url = str(profile.get("base_url") or "").strip() or DEFAULT_BASE_URLS.get(provider)
    model = str(profile.get("model") or "").strip() or DEFAULT_MODELS.get(provider)
    effort = str(profile.get("effort") or "").strip() or None
    models = model_options_for(provider, profile)
    return GlobalProviderSettings(
        provider=provider,
        active=active,
        api_key_set=bool(api_key),
        api_key_masked=mask_secret(api_key),
        base_url=base_url,
        model=model,
        models=models,
        effort=effort,
        updated_at=profile.get("updated_at") or None,
        applies_to=applies_to(provider, bool(api_key), base_url, model, effort),
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
    elif provider == "deepseek":
        envs.extend(["EXECUTOR_PROVIDER=deepseek", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"])
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
    profiles = _profiles_from_raw(data)
    provider = _active_provider(data, profiles)
    active_profile = profiles.get(provider, _clean_profile({}, provider))
    api_key = str(active_profile.get("api_key") or "")
    base_url = str(active_profile.get("base_url") or "").strip() or DEFAULT_BASE_URLS.get(provider)
    model = str(active_profile.get("model") or "").strip() or DEFAULT_MODELS.get(provider)
    effort = str(active_profile.get("effort") or "").strip() or None
    models = model_options_for(provider, active_profile)
    provider_summaries = [
        provider_settings_for(item, profiles.get(item, _clean_profile({}, item)), active=item == provider)
        for item in PROVIDER_IDS
    ]
    return GlobalSettings(
        provider=provider,
        api_key_set=bool(api_key),
        api_key_masked=mask_secret(api_key),
        base_url=base_url,
        model=model,
        models=models,
        effort=effort,
        updated_at=active_profile.get("updated_at") or data.get("updated_at") or None,
        config_path=str(settings_path(home)),
        applies_to=applies_to(provider, bool(api_key), base_url, model, effort),
        providers=provider_summaries,
    )


def update_global_settings(request: UpdateGlobalSettingsRequest, home: Path = WEB_HOME) -> GlobalSettings:
    current = _read_raw(home)
    profiles = _profiles_from_raw(current)
    provider = normalize_provider(request.provider)
    profile = profiles.get(provider, _clean_profile({}, provider))
    api_key = str(profile.get("api_key") or "")
    if request.clear_api_key:
        api_key = ""
    elif request.api_key is not None and request.api_key.strip():
        api_key = request.api_key.strip()
    model = request.model.strip() if request.model else None
    models = clean_model_options(model, request.models if request.models is not None else profile.get("models"))
    updated_at = utc_now()
    profiles[provider] = {
        "provider": provider,
        "api_key": api_key,
        "base_url": request.base_url.strip() if request.base_url else None,
        "model": model,
        "models": models,
        "effort": request.effort.strip() if request.effort else None,
        "updated_at": updated_at,
    }
    data = {
        "provider": provider,
        "api_key": api_key,
        "base_url": request.base_url.strip() if request.base_url else None,
        "model": model,
        "models": models,
        "effort": request.effort.strip() if request.effort else None,
        "updated_at": updated_at,
        "providers": profiles,
    }
    _write_raw(data, home)
    return get_global_settings(home)


def validate_global_settings(request: UpdateGlobalSettingsRequest, home: Path = WEB_HOME) -> ValidateGlobalSettingsResponse:
    current = _read_raw(home)
    profiles = _profiles_from_raw(current)
    provider = normalize_provider(request.provider)
    profile = profiles.get(provider, _clean_profile({}, provider))
    api_key = ""
    if not request.clear_api_key:
        api_key = (request.api_key or "").strip() or str(profile.get("api_key") or "").strip()
    base_url = (request.base_url.strip() if request.base_url else "") or str(profile.get("base_url") or "").strip()
    base_url = (base_url or DEFAULT_BASE_URLS.get(provider) or DEFAULT_BASE_URLS["openai"]).rstrip("/")
    model = (request.model.strip() if request.model else "") or str(profile.get("model") or "").strip() or DEFAULT_MODELS.get(provider)
    if not api_key:
        return ValidateGlobalSettingsResponse(
            ok=False,
            provider=provider,  # type: ignore[arg-type]
            endpoint=base_url,
            model=model,
            message="API key is required before validation.",
        )

    responses: list[ValidateGlobalSettingsResponse] = []
    candidate_bases = _validation_base_candidates(provider, base_url)
    for candidate_base in candidate_bases:
        response = _validate_models_endpoint(provider, api_key, candidate_base, model)
        if response.ok:
            return response
        responses.append(response)

    if provider in {"openai", "gemini", "glm", "kimi", "custom"} and model:
        for candidate_base in candidate_bases:
            fallback = _validate_openai_chat_endpoint(provider, api_key, candidate_base, model)
            if fallback.ok:
                return fallback
            responses.append(fallback)
    if responses:
        return responses[-1]
    return ValidateGlobalSettingsResponse(
        ok=False,
        provider=provider,  # type: ignore[arg-type]
        endpoint=base_url,
        model=model,
        message="Validation failed.",
    )


def _validate_models_endpoint(
    provider: str,
    api_key: str,
    base_url: str,
    model: str | None,
) -> ValidateGlobalSettingsResponse:
    url = _validation_models_url(provider, base_url)
    headers = _validation_headers(provider, api_key)
    try:
        status_code, payload = _request_json("GET", url, headers=headers)
    except urllib.error.HTTPError as exc:
        return ValidateGlobalSettingsResponse(
            ok=False,
            provider=provider,  # type: ignore[arg-type]
            endpoint=url,
            model=model,
            status_code=exc.code,
            message=_http_error_message(exc),
        )
    except NonJsonResponseError as exc:
        return ValidateGlobalSettingsResponse(
            ok=False,
            provider=provider,  # type: ignore[arg-type]
            endpoint=url,
            model=model,
            status_code=exc.status_code,
            message=_non_json_message(exc),
        )
    except Exception as exc:
        return ValidateGlobalSettingsResponse(
            ok=False,
            provider=provider,  # type: ignore[arg-type]
            endpoint=url,
            model=model,
            message=f"Connection failed: {exc}",
        )
    models = _extract_model_ids(payload)
    model_message = f" Connected; {len(models)} model(s) returned." if models else " Connected."
    if model and models and model not in models:
        model_message += f" Warning: configured model `{model}` was not in the returned catalog."
    return ValidateGlobalSettingsResponse(
        ok=True,
        provider=provider,  # type: ignore[arg-type]
        endpoint=url,
        model=model,
        status_code=status_code,
        message=model_message.strip(),
        models=models[:50],
        model_count=len(models),
    )


def _validate_openai_chat_endpoint(
    provider: str,
    api_key: str,
    base_url: str,
    model: str,
) -> ValidateGlobalSettingsResponse:
    url = f"{base_url.rstrip('/')}/chat/completions"
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
    }
    try:
        status_code, _payload = _request_json("POST", url, headers=_validation_headers(provider, api_key), body=body)
    except urllib.error.HTTPError as exc:
        return ValidateGlobalSettingsResponse(
            ok=False,
            provider=provider,  # type: ignore[arg-type]
            endpoint=url,
            model=model,
            status_code=exc.code,
            message=_http_error_message(exc),
        )
    except NonJsonResponseError as exc:
        return ValidateGlobalSettingsResponse(
            ok=False,
            provider=provider,  # type: ignore[arg-type]
            endpoint=url,
            model=model,
            status_code=exc.status_code,
            message=_non_json_message(exc),
        )
    except Exception as exc:
        return ValidateGlobalSettingsResponse(
            ok=False,
            provider=provider,  # type: ignore[arg-type]
            endpoint=url,
            model=model,
            message=f"Connection failed: {exc}",
        )
    return ValidateGlobalSettingsResponse(
        ok=True,
        provider=provider,  # type: ignore[arg-type]
        endpoint=url,
        model=model,
        status_code=status_code,
        message="Connection verified with a minimal chat request. The model catalog endpoint was not available.",
    )


def _validation_base_candidates(provider: str, base_url: str) -> list[str]:
    base = base_url.rstrip("/")
    candidates = [base]
    if provider in {"openai", "custom"} and not base.endswith("/v1"):
        candidates.append(f"{base}/v1")
    return candidates


def _validation_models_url(provider: str, base_url: str) -> str:
    base = base_url.rstrip("/")
    if provider in {"anthropic", "minimax"}:
        return f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models"
    return f"{base}/models"


def _validation_headers(provider: str, api_key: str) -> dict[str, str]:
    if provider in {"anthropic", "minimax"}:
        return {
            "anthropic-version": "2023-06-01",
            "x-api-key": api_key,
        }
    return {"Authorization": f"Bearer {api_key}"}


def _request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    body: dict[str, Any] | None = None,
) -> tuple[int, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            **headers,
        },
    )
    context = ssl.create_default_context(cafile=certifi.where()) if certifi else None
    with urllib.request.urlopen(request, timeout=15, context=context) as response:  # noqa: S310 - user-configured local console endpoint
        raw = response.read().decode("utf-8", errors="replace")
        if not raw.strip():
            return response.status, {}
        try:
            return response.status, json.loads(raw)
        except json.JSONDecodeError as exc:
            raise NonJsonResponseError(response.status, response.headers.get("content-type"), raw[:500]) from exc


def _extract_model_ids(payload: Any) -> list[str]:
    items = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []
    result: list[str] = []
    for item in items:
        if isinstance(item, dict):
            value = item.get("id") or item.get("name")
        else:
            value = item
        if isinstance(value, str) and value.strip():
            result.append(value.strip())
    return clean_model_options(result)


def _http_error_message(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", errors="replace")
    except Exception:
        raw = ""
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                error = parsed.get("error")
                if isinstance(error, dict):
                    message = error.get("message")
                    if isinstance(message, str) and message.strip():
                        return message.strip()
                detail = parsed.get("detail") or parsed.get("message")
                if isinstance(detail, str) and detail.strip():
                    return detail.strip()
        except json.JSONDecodeError:
            return raw[:500]
    return f"Validation request failed with HTTP {exc.code}."


def _non_json_message(exc: NonJsonResponseError) -> str:
    content_type = exc.content_type or "unknown content type"
    return (
        f"Validation endpoint returned non-JSON content ({content_type}). "
        "Check that Base URL points to the API root, for example including /v1 when required."
    )


def _read_secret_settings(home: Path = WEB_HOME) -> dict[str, object]:
    data = _read_raw(home)
    _provider, profile = _active_profile(data)
    if not profile.get("api_key"):
        return {}
    return profile


def _clear_managed_env(env: dict[str, str]) -> None:
    for key in MANAGED_ENV_KEYS:
        env.pop(key, None)


def effective_model_override(home: Path = WEB_HOME) -> str | None:
    raw = _read_raw(home)
    if not raw:
        return None
    provider, profile = _active_profile(raw)
    if not str(profile.get("api_key") or "").strip():
        return None
    model = str(profile.get("model") or "").strip()
    if model:
        return model
    return DEFAULT_MODELS.get(provider)


def effective_effort_override(home: Path = WEB_HOME, model: str | None = None) -> str | None:
    raw = _read_raw(home)
    if not raw:
        return None
    _provider, profile = _profile_for_model(raw, model)
    if not str(profile.get("api_key") or "").strip():
        return None
    return str(profile.get("effort") or "").strip() or None


def openai_compatible_settings(home: Path = WEB_HOME, model: str | None = None) -> dict[str, str] | None:
    raw = _read_raw(home)
    if not raw:
        return None
    provider, profile = _profile_for_model(raw, model)
    api_key = str(profile.get("api_key") or "").strip()
    if not api_key:
        return None
    if provider not in {"openai", "gemini", "glm", "minimax", "kimi", "deepseek", "custom"}:
        return None
    base_url = str(profile.get("base_url") or "").strip() or DEFAULT_BASE_URLS.get(provider)
    selected_model = str(model or "").strip() or str(profile.get("model") or "").strip() or DEFAULT_MODELS.get(provider)
    if not base_url or not selected_model:
        return None
    if provider == "minimax" and "anthropic" in base_url.rstrip("/").lower():
        return None
    return {
        "provider": provider,
        "api_key": api_key,
        "base_url": base_url.rstrip("/"),
        "model": selected_model,
        "effort": str(profile.get("effort") or "").strip(),
    }


def build_runtime_env(
    base_env: dict[str, str] | None = None,
    home: Path = WEB_HOME,
    model: str | None = None,
) -> dict[str, str]:
    env = dict(base_env if base_env is not None else os.environ)
    _prepend_local_bin(env)
    raw = _read_raw(home)
    if not raw:
        return env
    _clear_managed_env(env)

    provider, profile = _profile_for_model(raw, model)
    api_key = str(profile.get("api_key") or "").strip()
    base_url = str(profile.get("base_url") or "").strip()
    configured_model = str(profile.get("model") or "").strip()
    effort = str(profile.get("effort") or "").strip()
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
    elif provider == "deepseek":
        env["EXECUTOR_PROVIDER"] = "deepseek"
        env["DEEPSEEK_API_KEY"] = api_key
        env["DEEPSEEK_BASE_URL"] = base_url or DEFAULT_BASE_URLS["deepseek"]
    else:
        env["EXECUTOR_PROVIDER"] = "openai"
        env["EXECUTOR_API_KEY"] = api_key
        if base_url:
            env["EXECUTOR_BASE_URL"] = base_url

    effective_model = str(model or "").strip() or configured_model or DEFAULT_MODELS.get(str(provider))
    if effective_model:
        env["ARIS_REVIEWER_MODEL"] = effective_model
    if effort:
        env["ARIS_REASONING_EFFORT"] = effort
    return env
