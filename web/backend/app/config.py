from __future__ import annotations

import os
from pathlib import Path


def repo_root() -> Path:
    """Return the ARIS repository root."""
    return Path(__file__).resolve().parents[3]


def web_home() -> Path:
    """Return the local web console config directory."""
    return Path(os.environ.get("ARIS_WEB_HOME", Path.home() / ".aris-web")).expanduser()


REPO_ROOT = repo_root()
WEB_HOME = web_home()
ARIS_CODE_SKILLS_DIR = REPO_ROOT / "crates" / "runtime" / "assets" / "skills"
LEGACY_SKILLS_DIR = REPO_ROOT / "skills"
SKILLS_DIR = ARIS_CODE_SKILLS_DIR if ARIS_CODE_SKILLS_DIR.exists() else LEGACY_SKILLS_DIR
TOOLS_DIR = REPO_ROOT / "crates" / "runtime" / "assets" / "tools"
RENDER_HTML = LEGACY_SKILLS_DIR / "render-html" / "scripts" / "render_html.py"
FRONTEND_DIST = REPO_ROOT / "web" / "frontend" / "dist"
