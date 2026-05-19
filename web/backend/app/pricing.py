"""Token pricing table mirrored from ``crates/runtime/src/usage.rs``.

The Rust core's ``pricing_for_model`` is the single source of truth for
``aris`` itself. The web orchestrator can't call it (it talks to ``aris`` over
stdio JSON), and the structured ``usage`` block emitted at the end of a
non-interactive ``aris prompt`` run does NOT currently include ``cost_usd`` —
just token counts. So we maintain a small parallel table here and compute
cost in Python.

Prices are USD per million tokens. The Rust table is authoritative; if a
discrepancy is found, fix it there first, then mirror.

Cache-tier handling matches Rust:
- Anthropic: distinct ``cache_creation`` (1.25x input) and ``cache_read``
  (0.1x input) tiers.
- OpenAI: ``cache_creation`` = ``input``; ``cache_read`` = 0.1x input
  (automatic prefix-cache discount).
- DeepSeek: explicit hit/miss split.
- Others: generic — ``cache_creation`` = ``input``, ``cache_read`` =
  ``input`` / 2.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class ModelPricing:
    input_per_million: float
    output_per_million: float
    cache_creation_per_million: float
    cache_read_per_million: float


_DEFAULT_SONNET_TIER = ModelPricing(
    input_per_million=15.0,
    output_per_million=75.0,
    cache_creation_per_million=18.75,
    cache_read_per_million=1.5,
)


def _openai(input_: float, output: float) -> ModelPricing:
    return ModelPricing(
        input_per_million=input_,
        output_per_million=output,
        cache_creation_per_million=input_,
        cache_read_per_million=input_ * 0.1,
    )


def _generic(input_: float, output: float) -> ModelPricing:
    return ModelPricing(
        input_per_million=input_,
        output_per_million=output,
        cache_creation_per_million=input_,
        cache_read_per_million=input_ / 2.0,
    )


def _has_word(haystack: str, needle: str) -> bool:
    """Word-boundary match to avoid e.g. ``o3`` matching inside ``gpt-5.4-nano``.

    Treats ``-``, ``_``, ``/``, ``:``, and string edges as boundaries.
    """
    if not needle or len(haystack) < len(needle):
        return False
    boundaries = {"-", "_", "/", ":"}
    n = len(needle)
    i = 0
    while i + n <= len(haystack):
        if haystack[i : i + n] == needle:
            before_ok = i == 0 or haystack[i - 1] in boundaries
            after_idx = i + n
            after_ok = after_idx == len(haystack) or haystack[after_idx] in boundaries
            if before_ok and after_ok:
                return True
        i += 1
    return False


def pricing_for_model(model: str | None) -> ModelPricing | None:
    """Return pricing for a model name, or ``None`` if unknown.

    Callers should treat ``None`` as "skip cost estimation" — token counts
    are still useful even without USD.
    """
    if not model:
        return None
    m = model.lower()

    # Anthropic Claude
    if "haiku" in m:
        return ModelPricing(1.0, 5.0, 1.25, 0.1)
    if "opus" in m:
        return ModelPricing(15.0, 75.0, 18.75, 1.5)
    if "sonnet" in m:
        return _DEFAULT_SONNET_TIER

    # OpenAI
    if "gpt-5.5" in m:
        return _openai(5.0, 30.0)
    if "gpt-5.4-nano" in m:
        return _openai(0.20, 1.25)
    if "gpt-5.4-mini" in m:
        return _openai(0.75, 4.5)
    if "gpt-5.4" in m:
        return _openai(2.5, 15.0)
    if "gpt-4o-mini" in m:
        return _openai(0.15, 0.6)
    if "gpt-4o" in m:
        return _openai(2.5, 10.0)
    if _has_word(m, "o4"):
        return _openai(4.0, 16.0)
    if _has_word(m, "o3"):
        return _openai(2.0, 8.0)
    if _has_word(m, "o1"):
        return _openai(15.0, 60.0)

    # Gemini
    if "gemini-2.5-flash" in m:
        return _generic(0.3, 2.5)
    if "gemini-2.5-pro" in m:
        return _generic(2.5, 10.0)
    if "gemini-2.0-flash" in m:
        return _generic(0.1, 0.4)

    # DeepSeek
    if "deepseek-v4" in m or "deepseek-v3" in m:
        return ModelPricing(0.27, 1.10, 0.27, 0.07)
    if "deepseek-r1" in m or "deepseek-reasoner" in m:
        return ModelPricing(0.55, 2.19, 0.55, 0.14)
    if "deepseek" in m:
        return ModelPricing(0.27, 1.10, 0.27, 0.07)

    # Other Chinese providers
    if "glm" in m:
        return _generic(0.5, 2.0)
    if "minimax" in m:
        return _generic(0.6, 2.4)
    if "kimi" in m or "moonshot" in m:
        return _generic(0.6, 2.5)
    if "mimo" in m:
        return _generic(0.4, 1.6)
    if "qwen" in m:
        return _generic(0.4, 1.6)
    if "doubao" in m:
        return _generic(0.3, 1.2)

    return None


def estimate_cost_usd(
    *,
    input_tokens: int,
    output_tokens: int,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    pricing: ModelPricing,
) -> float:
    """Sum the four per-tier costs and return USD."""
    return (
        input_tokens * pricing.input_per_million / 1_000_000
        + output_tokens * pricing.output_per_million / 1_000_000
        + cache_creation_input_tokens * pricing.cache_creation_per_million / 1_000_000
        + cache_read_input_tokens * pricing.cache_read_per_million / 1_000_000
    )


def extract_usage_from_payload(payload) -> dict | None:
    """Pull the ``usage`` block out of a parsed ``aris prompt`` stdout event.

    ``aris-cli/src/main.rs`` (run_oneshot prompt path) prints a final JSON
    object containing a ``usage`` field with token counts. Anything that
    doesn't look like that block returns ``None`` so callers can ignore
    intermediate codex events safely.
    """
    if not isinstance(payload, dict):
        return None
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    keys = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    if not any(k in usage for k in keys):
        return None
    return usage
