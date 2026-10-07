#!/usr/bin/env bash
set -euo pipefail

# One-command session host launcher (issue 323), paired with
# scripts/pi-review-sessions.cmd on native Windows. Selects a supported Node
# runtime from PATH, then hands off to the shared setup/runtime selection in
# scripts/pi-review-sessions.cjs, which resolves (or provisions) the Pi
# runtime: the user never supplies a manual Pi CLI path. The session host
# itself supports POSIX macOS/Linux only; the CJS reports that limitation
# elsewhere.
#
# Node requirement (this phase): Node.js 22.19.0 or newer must already be on
# PATH. Automatic isolated Node fallback (cached or provisioned runtime)
# remains unfinished: a cache's provenance manifest is self-asserted and
# cannot yet be bound to the checksum-verified official artifact, so no
# non-PATH Node binary is ever selected or executed. Existing cache
# directories are left untouched.
#
# Capability isolation (fail closed): executor role contexts are rejected and
# the host bootstrap/restore authorization markers are cleared BEFORE any
# probe or provisioning child process runs, so no descendant inherits host
# authorization. Trusted provider settings and the user's original
# NODE_OPTIONS pass through unchanged.

# --- Capability isolation before any child process runs ---------------------
if [[ -n "${PI_REVIEW_GATE_RUNTIME_ROLE:-}" ]]; then
  echo "pi-review-sessions: unsupported role context (PI_REVIEW_GATE_RUNTIME_ROLE)." >&2
  exit 1
fi
if [[ -n "${PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG:-}" ]]; then
  echo "pi-review-sessions: unsupported role context (PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG)." >&2
  exit 1
fi
unset PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE

# Pure-bash script directory resolution: the core selection path must not
# depend on external commands (dirname), which a minimal PATH may lack.
script_path="${BASH_SOURCE[0]}"
case "$script_path" in
  */*) SCRIPT_DIR="$(cd "${script_path%/*}" && pwd)";;
  *) SCRIPT_DIR="$(pwd)";;
esac
CJS_ENTRY="$SCRIPT_DIR/pi-review-sessions.cjs"

# Mirrors meetsNodeFloor in scripts/pi-review-sessions.cjs: a stable version
# at or above 22.19.0; a pre-release build never counts at the exact floor.
node_version_supported() {
  local v="${1#v}" prerelease=0 major minor patch
  case "$v" in *-*) prerelease=1; v="${v%%-*}";; esac
  IFS=. read -r major minor patch _ <<< "$v"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  [[ "$minor" =~ ^[0-9]+$ ]] || return 1
  [[ "$patch" =~ ^[0-9]+$ ]] || return 1
  if (( major > 22 )); then return 0; fi
  if (( major < 22 )); then return 1; fi
  if (( minor > 19 )); then return 0; fi
  if (( minor < 19 )); then return 1; fi
  (( prerelease == 0 ))
}

# Supported Node on PATH — the only runtime source in this phase. A missing,
# unreadable, or unsupported node fails closed with a bounded diagnostic; no
# cached or provisioned fallback is attempted.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  if NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null)"; then
    if ! node_version_supported "$NODE_VERSION"; then
      echo "pi-review-sessions: Node.js 22.19.0 or newer is required on PATH (found ${NODE_VERSION}); automatic isolated Node fallback is not available in this phase." >&2
      exit 1
    fi
  else
    NODE_BIN=""
  fi
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "pi-review-sessions: Node.js 22.19.0 or newer is required on PATH; automatic isolated Node fallback is not available in this phase." >&2
  exit 1
fi

exec "$NODE_BIN" "$CJS_ENTRY" "$@"
