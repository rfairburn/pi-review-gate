#!/usr/bin/env bash
set -euo pipefail

REVIEW_GATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REVIEW_GATE_EXTENSION="$REVIEW_GATE_ROOT/dist/src/index.js"
ORCHESTRATOR_PROMPT="$REVIEW_GATE_ROOT/scripts/orchestrator-system-prompt.md"
# shellcheck source=scripts/little-coder-tool-policy.sh
source "$REVIEW_GATE_ROOT/scripts/little-coder-tool-policy.sh"

export LITTLE_CODER_THINKING_BUDGET=262144

unset PI_REVIEW_GATE_CONFIG
unset LITTLE_CODER_REVIEW_CONFIG
unset PI_REVIEW_GATE_DISABLED
unset LITTLE_CODER_REVIEW_GATE_DISABLED

REVIEW_GATE_CONFIG=""
for candidate in \
  "$HOME/.config/pi-review-gate/config.json" \
  "$HOME/.config/pi/review-gate.json" \
  "$HOME/.config/little-coder/review-gate.json"
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
  echo "  $HOME/.config/little-coder/review-gate.json" >&2
  exit 2
fi

if [[ -f "$REVIEW_GATE_ROOT/src/index.ts" ]]; then
  npm --prefix "$REVIEW_GATE_ROOT" run build
elif [[ ! -f "$REVIEW_GATE_EXTENSION" ]]; then
  echo "pi-review-gate: packaged extension is missing: $REVIEW_GATE_EXTENSION" >&2
  exit 2
fi

case ":${LITTLE_CODER_EXTRA_EXTENSIONS:-}:" in
  *":$REVIEW_GATE_EXTENSION:"*) ;;
  *) export LITTLE_CODER_EXTRA_EXTENSIONS="$REVIEW_GATE_EXTENSION${LITTLE_CODER_EXTRA_EXTENSIONS:+:$LITTLE_CODER_EXTRA_EXTENSIONS}" ;;
esac

echo "pi-review-gate config: $REVIEW_GATE_CONFIG"
echo "pi-review-gate extension: $REVIEW_GATE_EXTENSION"

exec little-coder --tui-mode fullscreen --append-system-prompt "$ORCHESTRATOR_PROMPT" --tools "$LITTLE_CODER_ALLOWED_TOOLS" "$@"
