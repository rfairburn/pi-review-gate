#!/usr/bin/env bash
set -euo pipefail

# Web CLI wrapper. Issue 344: no freshness, build, or DDGS logic lives here.
# The same shared authority the Pi and sidebar launchers use decides in a
# fraction of a second whether the prepared application is current and
# prepares it automatically (isolated generation) only when it is genuinely
# missing or outdated. A current start runs no npm, no compiler, no staging,
# no Python validation, and no cleanup.

# --- Physical package root -------------------------------------------------
# npm installs a public POSIX bin (node_modules/.bin/pi-review-web) as a link to
# this installed script, so the invoked path's own directory is the shim
# directory, not the package. Follow the entry point's symlinks -- relative or
# absolute targets, any spaces -- and take the physical parent of the real
# script, so a standard .bin launch finds the shared helpers it ships with.
# Resolution is read-only and bounded, and it fails closed: a malformed,
# dangling, or cyclic link never falls back to the shim's parent directory or to
# an ancestor helper.
launcher_package_root() {
  local label="$1" invoked="${BASH_SOURCE[0]}" target hops=0 directory
  case "$invoked" in
    */*) ;;
    *) invoked="./$invoked" ;;
  esac
  while [[ -L "$invoked" ]]; do
    # Bounded well below POSIX hosts' own symlink limits, so a pathological
    # chain fails here with its own diagnostic instead of traversing unbounded.
    if (( hops >= 16 )); then
      echo "$label: cannot resolve the launcher entry point (too many symlink levels): $invoked" >&2
      return 1
    fi
    if ! target="$(readlink "$invoked" 2>/dev/null)" || [[ -z "$target" ]]; then
      echo "$label: cannot resolve the launcher symlink (readlink failed): $invoked" >&2
      return 1
    fi
    case "$target" in
      /*) invoked="$target" ;;
      *) invoked="${invoked%/*}/$target" ;;
    esac
    hops=$((hops + 1))
  done
  if [[ ! -f "$invoked" ]]; then
    echo "$label: launcher entry point is not a regular file: $invoked" >&2
    return 1
  fi
  directory="${invoked%/*}"
  # Physical traversal: `cd -P` makes `..` mean the real parent of the real
  # script even when the shim directory (or an ancestor) is itself a symlink, so
  # logical normalization can never redirect the package root to a decoy tree.
  ( CDPATH='' cd -P -- "$directory/.." && pwd -P )
}

REVIEW_GATE_ROOT="$(launcher_package_root pi-review-web)" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "pi-review-web: Node.js 22.23.4 or newer (Node 24 >=24.22.1, Node 26 >=26.12.1) is required to run pi-review-web." >&2
  exit 127
fi

# The shared CLI binds the lease to its native invoking parent (this shell), and
# the final `exec node` preserves that pid.
PREPARE_OUTPUT="$(node "$REVIEW_GATE_ROOT/scripts/prepare-application.cjs" --prepare)" || exit $?
PREPARED_ROOT=""
DDGS_PYTHON=""
while IFS=$'\t' read -r prepare_key prepare_value _prepare_label; do
  case "$prepare_key" in
    root) PREPARED_ROOT="$prepare_value" ;;
    ddgs) DDGS_PYTHON="$prepare_value" ;;
  esac
done <<< "$PREPARE_OUTPUT"
if [[ -z "$PREPARED_ROOT" || -z "$DDGS_PYTHON" ]]; then
  echo "pi-review-web: application preparation did not report a usable application root and DDGS interpreter." >&2
  exit 1
fi

export PI_REVIEW_GATE_DDGS_PYTHON="$DDGS_PYTHON"
WEB_CLI="$PREPARED_ROOT/dist/src/web/cli.js"
if [[ ! -f "$WEB_CLI" ]]; then
  echo "pi-review-web: packaged CLI is missing: $WEB_CLI" >&2
  exit 2
fi

exec node "$WEB_CLI" "$@"
