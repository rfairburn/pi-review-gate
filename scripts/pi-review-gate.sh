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

# First-launch initialization (issue 32): when neither discovered config exists,
# create a private zero-model default config at the preferred location and
# continue normal startup. It never overwrites an existing or malformed config,
# never exposes partial JSON at the final path, and never clobbers a config that
# a concurrent launch created in the same window. Only the resolved path is
# printed to stdout; all notices go to stderr.
initialize_default_review_gate_config() {
  local primary="$HOME/.config/pi-review-gate/config.json"
  local fallback="$HOME/.config/pi/review-gate.json"
  local dir probe parent level tmp i prev_umask
  local missing=()

  # Re-check discovery: another launch (or the user) may have created a config
  # between the first pass and now. Preserve the same precedence.
  for candidate in "$primary" "$fallback"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
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

REVIEW_GATE_CONFIG=""
for candidate in \
  "$HOME/.config/pi-review-gate/config.json" \
  "$HOME/.config/pi/review-gate.json"
do
  if [[ -f "$candidate" ]]; then
    REVIEW_GATE_CONFIG="$candidate"
    break
  fi
done

if [[ -z "$REVIEW_GATE_CONFIG" ]]; then
  REVIEW_GATE_CONFIG="$(initialize_default_review_gate_config)" || exit 2
fi

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
