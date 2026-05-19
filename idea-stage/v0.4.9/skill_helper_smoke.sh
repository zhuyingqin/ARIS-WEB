#!/usr/bin/env bash
#
# v0.4.9 T29 smoke test for the skill-helper subsystem.
#
# Runs the release binary against a temp $HOME so the bundled extract
# materialises into ~/.config/aris/cache/<version>/, then verifies:
#
#   1. cache dir exists with the expected three top-level dirs
#      (tools/, skills/, shared-references/)
#   2. specific shared helpers from T13 + T28 are present
#   3. each helper's `--help` exits 0 (Python parses without ImportError
#      on stdlib-only helpers)
#   4. no helper extraction wrote anything into the smoke test's cwd
#      (regression guard for H6: extract-to-cwd was v0.4.7 behaviour)
#
# Exit codes:
#   0 = all checks passed
#   non-zero = describes which check failed
#
# Run from repo root:
#   bash idea-stage/v0.4.9/skill_helper_smoke.sh
# or with an explicit binary:
#   ARIS_BIN=/path/to/aris bash idea-stage/v0.4.9/skill_helper_smoke.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARIS_BIN="${ARIS_BIN:-$REPO_ROOT/target/release/aris}"

if [ ! -x "$ARIS_BIN" ]; then
    echo "ERROR: $ARIS_BIN not found or not executable." >&2
    echo "Build first: cargo build --release" >&2
    exit 2
fi

# Hard prerequisite: python3 on PATH. Smoke would silent-pass otherwise.
if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found in PATH; smoke cannot validate helpers." >&2
    exit 3
fi

# Isolated HOME + cwd so the smoke test never pollutes the real env.
SMOKE_DIR="$(mktemp -d)"
trap 'rm -rf "$SMOKE_DIR"' EXIT
export HOME="$SMOKE_DIR/home"
mkdir -p "$HOME"
cd "$SMOKE_DIR"

VERSION="$("$ARIS_BIN" --version 2>&1 | awk '/Version/ {print $2}')"
echo "smoke: aris $VERSION under HOME=$HOME cwd=$SMOKE_DIR"

# 1. Trigger startup eager extract (--help is enough — runs run() entry).
"$ARIS_BIN" --help >/dev/null 2>&1 || true

CACHE_DIR="$HOME/.config/aris/cache/$VERSION"
[ -d "$CACHE_DIR/tools" ] && [ -d "$CACHE_DIR/skills" ] && [ -d "$CACHE_DIR/shared-references" ] \
    || { echo "FAIL[1]: cache dir layout missing under $CACHE_DIR" >&2; exit 11; }

echo "smoke: ✓ cache layout present ($CACHE_DIR)"

# 2. Specific shared helpers from T13 + T28
for helper in arxiv_fetch.py deepxiv_fetch.py exa_search.py \
              semantic_scholar_fetch.py openalex_fetch.py \
              save_trace.sh verify_papers.py verify_paper_audits.sh \
              research_wiki.py; do
    if [ ! -f "$CACHE_DIR/tools/$helper" ]; then
        echo "FAIL[2]: tools/$helper missing in cache" >&2
        exit 12
    fi
done
echo "smoke: ✓ all 9 shared tools/ helpers present"

# 3. Python helpers — use `py_compile` so we only validate parseability
#    (doesn't run import-time side effects, doesn't depend on optional libs
#    like `requests`). Shell helpers — `sh -n` syntax check.
#    Both check exit code directly; no string sniffing on stderr.
for helper in arxiv_fetch.py deepxiv_fetch.py exa_search.py \
              semantic_scholar_fetch.py openalex_fetch.py \
              verify_papers.py research_wiki.py; do
    if ! python3 -m py_compile "$CACHE_DIR/tools/$helper" 2>&1; then
        echo "FAIL[3]: $helper failed py_compile" >&2
        exit 13
    fi
done
for helper in save_trace.sh verify_paper_audits.sh; do
    if ! sh -n "$CACHE_DIR/tools/$helper"; then
        echo "FAIL[3]: $helper failed sh -n syntax check" >&2
        exit 14
    fi
done
echo "smoke: ✓ all helpers parse cleanly (py_compile / sh -n)"

# 4. cwd must be empty (modulo the temp_dir creation). H6 regression
#    guard: v0.4.7 extracted helpers to cwd/<skill_name>/.
shopt -s nullglob
polluters=("$SMOKE_DIR"/research-wiki "$SMOKE_DIR"/shared-references "$SMOKE_DIR"/tools "$SMOKE_DIR"/skills)
found_polluter=0
for p in "${polluters[@]}"; do
    if [ -e "$p" ]; then
        echo "FAIL[4]: cwd pollution — $p exists (H6 regression)" >&2
        found_polluter=1
    fi
done
[ "$found_polluter" -eq 0 ] || exit 15
echo "smoke: ✓ no cwd pollution (H6 regression guard)"

echo "smoke: ALL CHECKS PASSED"
