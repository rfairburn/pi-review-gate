#!/usr/bin/env bash
set -euo pipefail

REVIEW_GATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REVIEW_GATE_EXTENSION="$REVIEW_GATE_ROOT/dist/src/index.js"
ORCHESTRATOR_PROMPT="$REVIEW_GATE_ROOT/scripts/orchestrator-system-prompt.md"

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

export PI_REVIEW_GATE_CONFIG="$REVIEW_GATE_CONFIG"

echo "pi-review-gate config: $REVIEW_GATE_CONFIG"
echo "pi-review-gate extension: $REVIEW_GATE_EXTENSION"

exec pi --extension "$REVIEW_GATE_EXTENSION" --append-system-prompt "$ORCHESTRATOR_PROMPT" "$@"
