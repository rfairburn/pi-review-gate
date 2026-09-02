#!/usr/bin/env bash
set -euo pipefail

DDGS_VERSION="9.15.0"
PI_REVIEW_GATE_CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/pi-review-gate"
PI_REVIEW_GATE_DDGS_VENV="${PI_REVIEW_GATE_DDGS_VENV:-$PI_REVIEW_GATE_CACHE_ROOT/ddgs-$DDGS_VERSION}"
PI_REVIEW_GATE_DDGS_PYTHON="$PI_REVIEW_GATE_DDGS_VENV/bin/python"

# Every Python invocation below runs in isolated mode (-I): Python must not
# place the launcher's working directory (which may be an untrusted reviewed
# repository) on sys.path, or a local ddgs.py/pip/venv shadow module would
# execute arbitrary code during provisioning.
ddgs_environment_is_valid() {
  "$PI_REVIEW_GATE_DDGS_PYTHON" -I -c \
    'import ddgs, importlib.metadata as metadata, sys; sys.exit(0 if metadata.version("ddgs") == sys.argv[1] else 1)' \
    "$DDGS_VERSION" 2>/dev/null \
    && "$PI_REVIEW_GATE_DDGS_PYTHON" -I -m pip check >/dev/null 2>&1
}

if [[ ! -x "$PI_REVIEW_GATE_DDGS_PYTHON" ]]; then
  echo "pi-review-gate: creating DDGS $DDGS_VERSION environment" >&2
  mkdir -p "$PI_REVIEW_GATE_CACHE_ROOT"
  python3 -I -m venv "$PI_REVIEW_GATE_DDGS_VENV"
fi

if ! ddgs_environment_is_valid; then
  echo "pi-review-gate: installing DDGS $DDGS_VERSION" >&2
  # These resolver options apply to DDGS and its full transitive dependency
  # graph. If a compatible binary is unavailable, pip fails and the final
  # validation below keeps the launcher from continuing with a bad venv.
  "$PI_REVIEW_GATE_DDGS_PYTHON" -I -m pip install \
    --disable-pip-version-check \
    --no-cache-dir \
    --no-input \
    --only-binary=:all: \
    --quiet \
    --upgrade \
    --upgrade-strategy eager \
    "ddgs==$DDGS_VERSION"
fi

if ! ddgs_environment_is_valid; then
  echo "pi-review-gate: DDGS $DDGS_VERSION is unavailable or has inconsistent dependencies; refusing to continue" >&2
  exit 1
fi

export PI_REVIEW_GATE_DDGS_PYTHON
