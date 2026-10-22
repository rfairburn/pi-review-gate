#!/usr/bin/env bash
set -euo pipefail

# Pi management verbs pass straight through to pi (Pi package management and
# Pi 1.0's native `pi mcp` management, which remains Pi-owned): no setup runs,
# the inherited environment and arguments reach pi untouched, and the wrapper's
# normal-launch exports below never apply.
case "${1:-}" in
  update|install|remove|uninstall|list|config|auth|mcp)
    exec pi "$@"
    ;;
esac

# --- Physical package root -------------------------------------------------
# npm installs a public POSIX bin (node_modules/.bin/pi-review-gate) as a link
# to this installed script, so the invoked path's own directory is the shim
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

REVIEW_GATE_ROOT="$(launcher_package_root pi-review-gate)" || exit 1

# Issue 344: this wrapper contains NO freshness, build, DDGS, or skill logic.
# One shared authority (scripts/prepare-application.cjs) decides in a fraction
# of a second whether the prepared application is current and, only when it is
# genuinely missing or outdated, automatically installs/compiles/publishes it in
# an isolated generation. The same module is used by the Windows helper, the
# sidebar launcher, and the web wrapper, so no wrapper can drift.
#
# Path handling deliberately stays inside the shared Node implementation: it
# resolves the Pi agent directory (PI_CODING_AGENT_DIR with Pi's own semantics),
# the package root (this physical entry point's package), the home directory
# (the platform's native home), and the per-platform separators. That keeps Git
# Bash/MSYS launches from handing native-invalid /c/... paths to Node.
if ! command -v node >/dev/null 2>&1; then
  echo "pi-review-gate: Node.js 22.23.4 or newer (Node 24 >=24.22.1, Node 26 >=26.12.1) is required to launch pi-review-gate." >&2
  exit 127
fi

# Persistent config resolution and first-launch initialization (shared with the
# Windows helper): selects the native Pi agent directory's review-gate.json,
# then the compatibility fallback, and publishes a private zero-model default
# only when neither exists. Fail-closed diagnostics go to stderr.
REVIEW_GATE_CONFIG="$(node "$REVIEW_GATE_ROOT/scripts/pi-review-gate-launcher.cjs" --resolve-config)" || exit $?

# The one shared current/update decision plus component readiness. On a current
# start this performs no install, compile, staging, inventory, Python probe,
# skill copy, or cleanup. Output is tab-separated so the shell needs no JSON
# parser: mode, extension, ddgs, and skill lines.
# The shared CLI binds the lease to its native invoking parent (this shell), and
# the final `exec pi` preserves that pid, so the prepared generation stays
# protected for exactly as long as pi runs.
PREPARE_OUTPUT="$(node "$REVIEW_GATE_ROOT/scripts/prepare-application.cjs" --prepare)" || exit $?
REVIEW_GATE_EXTENSION=""
DDGS_PYTHON=""
SKILL_DIAGNOSTICS=()
while IFS=$'\t' read -r prepare_key prepare_value prepare_label; do
  case "$prepare_key" in
    extension) REVIEW_GATE_EXTENSION="$prepare_value" ;;
    ddgs) DDGS_PYTHON="$prepare_value" ;;
    skill) SKILL_DIAGNOSTICS+=("pi-review-gate $prepare_value skill: $prepare_label") ;;
  esac
done <<< "$PREPARE_OUTPUT"
if [[ -z "$REVIEW_GATE_EXTENSION" || -z "$DDGS_PYTHON" ]]; then
  echo "pi-review-gate: application preparation did not report a usable extension and DDGS interpreter." >&2
  exit 1
fi

export PI_REVIEW_GATE_CONFIG="$REVIEW_GATE_CONFIG"
export PI_REVIEW_GATE_DDGS_PYTHON="$DDGS_PYTHON"

# Same truthy values the extension uses (loadConfig/firstTruthyEnv -> isTruthy
# in src/config.ts): warn loudly when the kill switch is on instead of
# silently swallowing it. PI_REVIEW_GATE_DISABLED is deliberately not unset.
case "${PI_REVIEW_GATE_DISABLED:-}" in
  1|true|yes)
    echo "pi-review-gate: PI_REVIEW_GATE_DISABLED is set; the review gate will not activate"
    ;;
esac

echo "pi-review-gate config: $REVIEW_GATE_CONFIG"
echo "pi-review-gate extension: $REVIEW_GATE_EXTENSION"
if (( ${#SKILL_DIAGNOSTICS[@]} > 0 )); then
  for skill_diagnostic in "${SKILL_DIAGNOSTICS[@]}"; do
    echo "$skill_diagnostic"
  done
fi

# Issue #26: --scheduler enables the process-local scheduled-execution runtime
# for this launch only. The flag is consumed here and handed to the extension
# through PI_REVIEW_GATE_SCHEDULER; it is never forwarded to pi, which would
# reject the unknown option. Processes started without the flag start Off (the
# live /review-settings toggle can still turn them on). An inherited
# PI_REVIEW_GATE_SCHEDULER (e.g. from a parent launched with --scheduler) is
# cleared before parsing so the explicit opt-in contract holds for nested and
# fresh launches. Keep in sync with scripts/pi-review-gate-launcher.cjs.
unset PI_REVIEW_GATE_SCHEDULER
SCHEDULER_ENABLED=""
REMAINING_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--scheduler" ]]; then
    SCHEDULER_ENABLED="1"
  else
    REMAINING_ARGS+=("$arg")
  fi
done
if [[ -n "$SCHEDULER_ENABLED" ]]; then
  export PI_REVIEW_GATE_SCHEDULER="$SCHEDULER_ENABLED"
fi

# Wrapper-only codemode default (normal launches only): export
# PI_REVIEW_GATE_CODEMODE_DEFAULT=1 so the extension can enable Pi's
# registered native codemode tool without rewriting any pi tool argument.
# Tool restrictions (--tools/--exclude-tools/--no-tools/--no-extensions) are
# forwarded untouched and Pi's policy-filtered getAllTools stays authoritative.
export PI_REVIEW_GATE_CODEMODE_DEFAULT="1"

# The extension owns the operating-mode system prompt segment (issue 19); the
# launcher no longer passes a permanent --append-system-prompt, so mode
# switches hot-replace it on the next run without string surgery.
exec pi --extension "$REVIEW_GATE_EXTENSION" ${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}
