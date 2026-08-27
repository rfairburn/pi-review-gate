#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  update|install|remove|uninstall|list|config|auth)
    exec pi "$@"
    ;;
esac

REVIEW_GATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REVIEW_GATE_EXTENSION="$REVIEW_GATE_ROOT/dist/src/index.js"
ORCHESTRATOR_PROMPT="$REVIEW_GATE_ROOT/scripts/orchestrator-system-prompt.md"
ORCHESTRATOR_SKILL_SOURCE="$REVIEW_GATE_ROOT/skills/orchestrator/SKILL.md"
ORCHESTRATOR_RECOVERY_SOURCE="$REVIEW_GATE_ROOT/skills/orchestrator/references/recovery.md"
ORCHESTRATOR_SKILL_DIR="$HOME/.agents/skills/orchestrator"

unset PI_REVIEW_GATE_CONFIG
unset PI_REVIEW_GATE_DISABLED

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
  echo "pi-review-gate: no persistent config found" >&2
  echo "checked:" >&2
  echo "  $HOME/.config/pi-review-gate/config.json" >&2
  echo "  $HOME/.config/pi/review-gate.json" >&2
  exit 2
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

mkdir -p "$ORCHESTRATOR_SKILL_DIR/references"
if [[ ! -f "$ORCHESTRATOR_SKILL_DIR/SKILL.md" ]] || ! cmp -s "$ORCHESTRATOR_SKILL_SOURCE" "$ORCHESTRATOR_SKILL_DIR/SKILL.md"; then
  install -m 0644 "$ORCHESTRATOR_SKILL_SOURCE" "$ORCHESTRATOR_SKILL_DIR/SKILL.md"
fi
if [[ ! -f "$ORCHESTRATOR_SKILL_DIR/references/recovery.md" ]] || ! cmp -s "$ORCHESTRATOR_RECOVERY_SOURCE" "$ORCHESTRATOR_SKILL_DIR/references/recovery.md"; then
  install -m 0644 "$ORCHESTRATOR_RECOVERY_SOURCE" "$ORCHESTRATOR_SKILL_DIR/references/recovery.md"
fi

export PI_REVIEW_GATE_CONFIG="$REVIEW_GATE_CONFIG"

echo "pi-review-gate config: $REVIEW_GATE_CONFIG"
echo "pi-review-gate extension: $REVIEW_GATE_EXTENSION"
echo "pi-review-gate orchestrator skill: $ORCHESTRATOR_SKILL_DIR/SKILL.md"

exec pi --extension "$REVIEW_GATE_EXTENSION" --append-system-prompt "$ORCHESTRATOR_PROMPT" "$@"
