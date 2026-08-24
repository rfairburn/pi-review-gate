#!/usr/bin/env bash

DDGS_VERSION="9.15.0"
PI_REVIEW_GATE_CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/pi-review-gate"
PI_REVIEW_GATE_DDGS_VENV="${PI_REVIEW_GATE_DDGS_VENV:-$PI_REVIEW_GATE_CACHE_ROOT/ddgs-$DDGS_VERSION}"
PI_REVIEW_GATE_DDGS_PYTHON="$PI_REVIEW_GATE_DDGS_VENV/bin/python"

if [[ ! -x "$PI_REVIEW_GATE_DDGS_PYTHON" ]]; then
  echo "pi-review-gate: creating DDGS $DDGS_VERSION environment" >&2
  mkdir -p "$PI_REVIEW_GATE_CACHE_ROOT"
  python3 -m venv "$PI_REVIEW_GATE_DDGS_VENV"
fi

if ! "$PI_REVIEW_GATE_DDGS_PYTHON" -c "import ddgs, sys; sys.exit(0 if ddgs.__version__ == '$DDGS_VERSION' else 1)" 2>/dev/null; then
  echo "pi-review-gate: installing DDGS $DDGS_VERSION" >&2
  "$PI_REVIEW_GATE_DDGS_PYTHON" -m pip install --disable-pip-version-check --quiet "ddgs==$DDGS_VERSION"
fi

export PI_REVIEW_GATE_DDGS_PYTHON
