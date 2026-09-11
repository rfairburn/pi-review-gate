#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  update|install|remove|uninstall|list|config|auth)
    exec pi "$@"
    ;;
esac

REVIEW_GATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REVIEW_GATE_EXTENSION="$REVIEW_GATE_ROOT/dist/src/index.js"
ORCHESTRATOR_SKILL_SOURCE="$REVIEW_GATE_ROOT/skills/orchestrator/SKILL.md"
ORCHESTRATOR_RECOVERY_SOURCE="$REVIEW_GATE_ROOT/skills/orchestrator/references/recovery.md"
ORCHESTRATOR_SKILL_DIR="$HOME/.agents/skills/orchestrator"

# Deliberate environment sanitization: the persistent config is re-resolved
# below and re-exported, so an inherited PI_REVIEW_GATE_CONFIG (e.g. from a
# parent pi session) cannot silently redirect the gate to another config file.
unset PI_REVIEW_GATE_CONFIG

# PI_REVIEW_GATE_DISABLED is deliberately NOT unset: it is the documented kill
# switch (README: PI_REVIEW_GATE_DISABLED=1 disables the gate) and must reach
# the extension so loadConfig() cleanly refuses to activate. Unsetting it here
# would silently defeat the kill switch.

# PI_CODING_AGENT_DIR is also deliberately NOT unset: Pi itself honors it for
# its own agent directory, so the gate must resolve its config against the
# same directory instead of silently diverging from the running agent.

# Native Pi agent-dir resolution (issue 94), mirroring Pi's getAgentDir() in
# the installed dist/config.js: a non-empty PI_CODING_AGENT_DIR wins with
# Pi's native semantics, and the default is the native agent directory
# <homedir>/.pi/agent. Home resolution mirrors node's os.homedir(): USERPROFILE
# on Windows (never the Git Bash HOME, which may legitimately differ), HOME on
# POSIX. Keep this in sync with src/config-path.ts, which mirrors the same
# semantics for the runtime; the duplication is deliberate because the
# launcher must resolve paths before the (pre-build/packaged) extension is
# available.
launcher_on_windows() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

# Parity with Pi's normalizeWindowsShellPath (dist/utils/paths.js): lone
# leading drive paths (/c/x, /mnt/c/x, /cygdrive/c/x) become C:\x; UNC paths,
# backslash-bearing paths and non-drive POSIX paths are returned unchanged.
normalize_windows_shell_path() {
  local path="$1"
  case "$path" in
    "//"*|*\\*) printf '%s\n' "$path"; return 0 ;;
  esac
  if [[ "$path" =~ ^/(mnt/|cygdrive/)?([A-Za-z])(/(.*))?$ ]]; then
    local drive="${BASH_REMATCH[2]}"
    local rest="${BASH_REMATCH[4]}"
    # tr instead of ${var^^}: the uppercase expansion needs bash 4+, but the
    # launcher must also run under macOS's stock bash 3.2.
    drive="$(printf '%s' "$drive" | tr '[:lower:]' '[:upper:]')"
    if [[ -n "$rest" ]]; then
      printf '%s\n' "$drive:\\${rest//\//\\}"
    else
      printf '%s\n' "$drive:\\"
    fi
  else
    printf '%s\n' "$path"
  fi
}

# Native Windows path -> POSIX form, for the shell's own filesystem tools
# (dirname, mkdir, mktemp): MSYS tooling does not treat backslashes as
# directory separators, so every internal path stays forward-slashed.
# Prefers cygpath (the canonical Git Bash/MSYS mapping) and falls back to a
# plain drive-letter mapping when cygpath is unavailable. Identity off Windows.
windows_native_to_shell_path_fallback() {
  local p="$1"
  case "$p" in
    [A-Za-z]:*)
      local drive="${p:0:1}"
      local rest="${p:2}"
      rest="${rest//\\//}"
      rest="${rest#/}"
      drive="$(printf '%s' "$drive" | tr '[:upper:]' '[:lower:]')"
      if [[ -n "$rest" ]]; then
        printf '%s\n' "/${drive}/${rest}"
      else
        printf '%s\n' "/${drive}"
      fi
      ;;
    *) printf '%s\n' "$p" ;;
  esac
}

shell_path_of() {
  local p="$1"
  launcher_on_windows || { printf '%s\n' "$p"; return 0; }
  if command -v cygpath >/dev/null 2>&1; then
    if cygpath -u "$p" 2>/dev/null; then
      return 0
    fi
  fi
  windows_native_to_shell_path_fallback "$p"
}

# POSIX (shell) path -> native Windows form, for anything handed to native
# processes through the environment: MSYS converts program arguments but never
# environment variables, and Node cannot open /c/... paths on Windows.
windows_shell_to_native_path_fallback() {
  local p="$1"
  case "$p" in
    # Already a native drive path (possibly with mixed separators): unify to
    # backslashes.
    [A-Za-z]:\\*) printf '%s\n' "${p//\//\\}"; return 0 ;;
  esac
  normalize_windows_shell_path "$p"
}

native_path_of() {
  local p="$1"
  launcher_on_windows || { printf '%s\n' "$p"; return 0; }
  if command -v cygpath >/dev/null 2>&1; then
    if cygpath -w "$p" 2>/dev/null; then
      return 0
    fi
  fi
  windows_shell_to_native_path_fallback "$p"
}

native_home_value() {
  if launcher_on_windows; then
    printf '%s\n' "${USERPROFILE:-$HOME}"
  else
    printf '%s\n' "${HOME:-}"
  fi
}

resolve_pi_agent_dir() {
  local override="${PI_CODING_AGENT_DIR:-}"
  if [[ -z "$override" ]]; then
    printf '%s\n' "$SHELL_HOME/.pi/agent"
    return 0
  fi
  case "$override" in
    "~") printf '%s\n' "$SHELL_HOME"; return 0 ;;
    ["~"]/*) printf '%s\n' "$SHELL_HOME/${override#??}"; return 0 ;;
  esac
  if launcher_on_windows; then
    case "$override" in
      ["~"]\\*) printf '%s\n' "$SHELL_HOME/${override#??}"; return 0 ;;
    esac
    # Pi normalizes Git Bash/WSL/Cygwin drive forms (/c, /mnt/c, /cygdrive/c)
    # to the native path before anything else. Mirror that before cygpath,
    # which does not interpret /mnt or /cygdrive as drive mounts, so the
    # launcher and the runtime resolve the same directory.
    override="$(normalize_windows_shell_path "$override")"
    override="$(shell_path_of "$override")"
  fi
  printf '%s\n' "$override"
}

# Config locations (issue 94), kept in shell form: all filesystem operations
# below (dirname, mkdir, mktemp, link publication) operate on forward-slashed
# paths so they behave identically under MSYS; the path selected for pi is
# converted to the native Windows form only at the export boundary. The
# default on all platforms is the native Pi agent directory plus
# review-gate.json; the sole implicit compatibility fallback is the historical
# XDG location below. The pre-#94 candidate ~/.config/pi/review-gate.json is
# no longer discovered or initialized, and there is no automatic migration.
NATIVE_HOME="$(native_home_value)"
SHELL_HOME="$(shell_path_of "$NATIVE_HOME")"
PI_AGENT_DIR="$(resolve_pi_agent_dir)"
PI_AGENT_DIR="${PI_AGENT_DIR%/}"
REVIEW_GATE_DEFAULT_CONFIG="$PI_AGENT_DIR/review-gate.json"
REVIEW_GATE_COMPAT_CONFIG="$SHELL_HOME/.config/pi-review-gate/config.json"

# First-launch initialization (issue 32, re-anchored by issue 94): when
# neither the Pi-agent default nor the compatibility fallback exists, create a
# private zero-model default config at the Pi-agent default location and
# continue normal startup. The compatibility fallback is never created.
# Initialization never overwrites an existing or malformed config, never
# exposes partial JSON at the final path, and never clobbers a config that a
# concurrent launch created in the same window. Only the resolved path is
# printed to stdout; all notices go to stderr.
initialize_default_review_gate_config() {
  local primary="$REVIEW_GATE_DEFAULT_CONFIG"
  local fallback="$REVIEW_GATE_COMPAT_CONFIG"
  local dir probe parent level tmp i prev_umask
  local missing=()

  # Re-check discovery: another launch (or the user) may have created a config
  # between the first pass and now. Preserve the same precedence and the same
  # fail-closed validity rule: a present candidate must be a usable regular
  # file (dangling symlinks and directories included), and an invalid
  # higher-priority candidate is never bypassed in favor of a lower-priority
  # one.
  for candidate in "$primary" "$fallback"; do
    if [[ -L "$candidate" || -e "$candidate" ]]; then
      if [[ -f "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
      echo "pi-review-gate: $candidate appeared during initialization but is not a regular file; refusing to continue" >&2
      return 1
    fi
  done

  dir="$(dirname "$primary")"
  # Collect the missing directory levels (leaf first) without touching any
  # level that already exists, so pre-existing directories keep their mode.
  probe="$dir"
  while [[ ! -d "$probe" ]]; do
    missing+=("$probe")
    parent="$(dirname "$probe")"
    if [[ "$parent" == "$probe" ]]; then
      break
    fi
    if [[ -e "$parent" && ! -d "$parent" ]]; then
      echo "pi-review-gate: $parent exists but is not a directory; cannot create $dir for the default config" >&2
      echo "pi-review-gate: move or rename that path, or create a config manually at $primary or $fallback" >&2
      return 1
    fi
    probe="$parent"
  done
  # Create top-down. Each level is created private from the instant of
  # creation (local umask 077 plus mkdir -m 700), so no level ever exists in a
  # permissive state; if a concurrent launch wins the creation race, mkdir
  # fails with EEXIST and its permissions are left untouched.
  prev_umask="$(umask)"
  umask 077
  for ((i = ${#missing[@]} - 1; i >= 0; i--)); do
    level="${missing[i]}"
    if ! mkdir -m 700 "$level" 2>/dev/null && [[ ! -d "$level" ]]; then
      umask "$prev_umask"
      echo "pi-review-gate: could not create directory $level (permission denied?); check write access to your home directory, or create a config manually at $primary or $fallback" >&2
      return 1
    fi
  done
  umask "$prev_umask"

  if [[ -e "$primary" || -L "$primary" ]]; then
    # It appeared after the discovery re-check; only a regular file is usable.
    if [[ -f "$primary" ]]; then
      printf '%s\n' "$primary"
      return 0
    fi
    echo "pi-review-gate: $primary exists but is not a regular file; refusing to initialize over it" >&2
    echo "pi-review-gate: move or rename that path, or create a config manually at $fallback" >&2
    return 1
  fi

  tmp="$(mktemp "$dir/.config.json.XXXXXXXX")" || {
    echo "pi-review-gate: could not create a temporary file in $dir (permission denied?); check write access to your home directory, or create a config manually at $primary or $fallback" >&2
    return 1
  }
  if ! chmod 600 "$tmp"; then
    rm -f "$tmp"
    echo "pi-review-gate: could not set private permissions on the new default config; refusing to continue with a non-private config file" >&2
    return 1
  fi
  # Zero-model defaults: explicitly empty reviewer and worker selections, so
  # nothing is invoked or configured implicitly until the user opts in.
  if ! cat > "$tmp" <<'EOF'
{
  "enabled": true,
  "review": {
    "activeReviewers": []
  },
  "execution": {
    "workerResources": [],
    "routes": {
      "execute": [],
      "research": []
    }
  }
}
EOF
  then
    rm -f "$tmp"
    echo "pi-review-gate: could not write the default config content to $dir (permission denied? or disk full?); create a config manually at $primary or $fallback" >&2
    return 1
  fi

  # Publish atomically with exact-destination link(2) semantics (Node's
  # fs.linkSync): the call fails when the target already exists in any form —
  # file, directory, or symlink — so a concurrent first launch can never be
  # clobbered, a destination that turns into a directory is rejected instead
  # of linked into, and the final path never holds partial JSON. The temporary
  # name stays private in $dir until it is linked into place or removed.
  if ! command -v node >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "pi-review-gate: the node runtime is required to publish the default config (install Node.js 20 or newer); create a config manually at $primary or $fallback" >&2
    return 1
  fi
  if node -e 'require("node:fs").linkSync(process.argv[1], process.argv[2]);' "$tmp" "$primary" 2>/dev/null; then
    rm -f "$tmp"
    echo "pi-review-gate: no persistent config found; created default zero-model config at $primary" >&2
    echo "pi-review-gate: no reviewers or workers are selected yet; configure them with /review-settings" >&2
    printf '%s\n' "$primary"
    return 0
  fi
  rm -f "$tmp"
  if [[ -f "$primary" ]]; then
    # A concurrent launch won the race; its config is authoritative from here.
    printf '%s\n' "$primary"
    return 0
  fi
  if [[ -e "$primary" || -L "$primary" ]]; then
    echo "pi-review-gate: $primary appeared during initialization but is not a regular file; refusing to continue" >&2
    return 1
  fi
  echo "pi-review-gate: unexpected failure publishing the default config to $primary (the target path changed mid-initialization?); re-run the launcher or create a config manually at $primary" >&2
  return 1
}

# Fail-closed candidate selection (issue 94): candidates are inspected in
# precedence order for existence — including dangling symlinks — and any
# present candidate must be a usable regular file. An invalid candidate is
# never bypassed in favor of a lower-priority path or replaced by
# initialization. Exit codes: 0 = selected (path on stdout), 3 = no candidate
# exists, 1 = invalid candidate (diagnostic on stderr).
select_review_gate_config() {
  local candidate
  for candidate in "$REVIEW_GATE_DEFAULT_CONFIG" "$REVIEW_GATE_COMPAT_CONFIG"; do
    if [[ -L "$candidate" || -e "$candidate" ]]; then
      if [[ -f "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
      echo "pi-review-gate: $candidate exists but is not a regular file; refusing to continue" >&2
      echo "pi-review-gate: move or rename that path, or create a config manually" >&2
      return 1
    fi
  done
  return 3
}

REVIEW_GATE_CONFIG=""
resolution=""
resolution_status=0
resolution="$(select_review_gate_config)" || resolution_status=$?
case "$resolution_status" in
  0) REVIEW_GATE_CONFIG="$resolution" ;;
  3) REVIEW_GATE_CONFIG="$(initialize_default_review_gate_config)" || exit 2 ;;
  *) exit 2 ;;
esac

if [[ -f "$REVIEW_GATE_ROOT/src/index.ts" ]]; then
  npm --prefix "$REVIEW_GATE_ROOT" run build
elif [[ ! -f "$REVIEW_GATE_EXTENSION" ]]; then
  echo "pi-review-gate: packaged extension is missing: $REVIEW_GATE_EXTENSION" >&2
  exit 2
fi

source "$REVIEW_GATE_ROOT/scripts/ensure-ddgs.sh"

if [[ ! -f "$ORCHESTRATOR_SKILL_SOURCE" ]]; then
  echo "pi-review-gate: packaged orchestrator skill is missing: $ORCHESTRATOR_SKILL_SOURCE" >&2
  exit 2
fi
if [[ ! -f "$ORCHESTRATOR_RECOVERY_SOURCE" ]]; then
  echo "pi-review-gate: packaged orchestrator recovery reference is missing: $ORCHESTRATOR_RECOVERY_SOURCE" >&2
  exit 2
fi

# Publish one orchestrator skill file atomically (issue 97). The content is
# staged in a private temporary file inside the destination directory and then
# moved into place with an atomic rename(2) (Node's fs.renameSync), mirroring
# the default-config publication above. rename() replaces an existing regular
# destination in a single step, so concurrent first launches publishing the
# same skill cannot fail over each other: GNU install overwrites by unlinking
# the destination and recreating it with O_CREAT|O_EXCL (install's
# unlink_dest_before_opening), and two interleaved launches race exactly that
# window into "cannot create regular file ... File exists". Readers likewise
# never observe a missing or partially written skill file: the final path
# holds either the old complete file or the new complete one. A destination
# symlink is replaced atomically as well (the link itself, never followed),
# but if the destination is a directory rename fails and the launcher refuses
# to continue instead of publishing somewhere else.
publish_orchestrator_skill_file() {
  local skill_source="$1" skill_destination="$2" dir tmp
  dir="$(dirname "$skill_destination")"
  if ! command -v node >/dev/null 2>&1; then
    echo "pi-review-gate: the node runtime is required to publish the orchestrator skill (install Node.js 20 or newer)" >&2
    return 1
  fi
  tmp="$(mktemp "$dir/.skill-publish.XXXXXXXX")" || {
    echo "pi-review-gate: could not create a temporary file in $dir (permission denied?); the orchestrator skill cannot be published to $skill_destination" >&2
    return 1
  }
  if ! cp -f "$skill_source" "$tmp"; then
    rm -f "$tmp"
    echo "pi-review-gate: could not stage $skill_source for publication to $skill_destination (disk full?)" >&2
    return 1
  fi
  # Set the final mode before the rename so the published path never exists in
  # any other state (mktemp creates 0600; the skill files are 0644).
  if ! chmod 644 "$tmp"; then
    rm -f "$tmp"
    echo "pi-review-gate: could not set permissions on the staged orchestrator skill file in $dir; refusing to continue" >&2
    return 1
  fi
  if node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2]);' "$tmp" "$skill_destination" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp"
  if [[ -d "$skill_destination" ]]; then
    echo "pi-review-gate: $skill_destination exists but is not a replaceable regular file (a directory appeared there?); move or rename that path and re-run the launcher" >&2
  else
    echo "pi-review-gate: unexpected failure publishing the orchestrator skill to $skill_destination; re-run the launcher" >&2
  fi
  return 1
}

mkdir -p "$ORCHESTRATOR_SKILL_DIR/references" || exit 2
if [[ ! -f "$ORCHESTRATOR_SKILL_DIR/SKILL.md" ]] || ! cmp -s "$ORCHESTRATOR_SKILL_SOURCE" "$ORCHESTRATOR_SKILL_DIR/SKILL.md"; then
  publish_orchestrator_skill_file "$ORCHESTRATOR_SKILL_SOURCE" "$ORCHESTRATOR_SKILL_DIR/SKILL.md" || exit 2
fi
if [[ ! -f "$ORCHESTRATOR_SKILL_DIR/references/recovery.md" ]] || ! cmp -s "$ORCHESTRATOR_RECOVERY_SOURCE" "$ORCHESTRATOR_SKILL_DIR/references/recovery.md"; then
  publish_orchestrator_skill_file "$ORCHESTRATOR_RECOVERY_SOURCE" "$ORCHESTRATOR_SKILL_DIR/references/recovery.md" || exit 2
fi

# The exported path must be in the native Windows form: MSYS never converts
# environment variables, and Node cannot open /c/... paths on Windows. Off
# Windows this is an identity mapping.
REVIEW_GATE_CONFIG="$(native_path_of "$REVIEW_GATE_CONFIG")"
export PI_REVIEW_GATE_CONFIG="$REVIEW_GATE_CONFIG"

# Same truthy values the extension uses (loadConfig/firstTruthyEnv -> isTruthy
# in src/config.ts): warn loudly when the kill switch is on instead of
# silently swallowing it. Keep this list in sync with isTruthy there.
case "${PI_REVIEW_GATE_DISABLED:-}" in
  1|true|yes)
    echo "pi-review-gate: PI_REVIEW_GATE_DISABLED is set; the review gate will not activate"
    ;;
esac

echo "pi-review-gate config: $REVIEW_GATE_CONFIG"
echo "pi-review-gate extension: $REVIEW_GATE_EXTENSION"
echo "pi-review-gate orchestrator skill: $ORCHESTRATOR_SKILL_DIR/SKILL.md"

# The extension owns the operating-mode system prompt segment (issue 19); the
# launcher no longer passes a permanent --append-system-prompt, so mode
# switches hot-replace it on the next run without string surgery.
exec pi --extension "$REVIEW_GATE_EXTENSION" "$@"
