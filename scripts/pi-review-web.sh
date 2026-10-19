#!/usr/bin/env bash
set -euo pipefail

# Web CLI wrapper. Issue 344: no freshness, build, or DDGS logic lives here.
# The same shared authority the Pi and sidebar launchers use decides in a
# fraction of a second whether the prepared application is current and
# prepares it automatically (isolated generation) only when it is genuinely
# missing or outdated. A current start runs no npm, no compiler, no staging,
# no Python validation, and no cleanup.
REVIEW_GATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "pi-review-web: Node.js 22.19.0 or newer is required to run pi-review-web." >&2
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
