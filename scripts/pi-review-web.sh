#!/usr/bin/env bash
set -euo pipefail

REVIEW_GATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_CLI="$REVIEW_GATE_ROOT/dist/src/web/cli.js"

if [[ -f "$REVIEW_GATE_ROOT/src/web/cli.ts" ]]; then
  npm --prefix "$REVIEW_GATE_ROOT" run build >&2
elif [[ ! -f "$WEB_CLI" ]]; then
  echo "pi-review-web: packaged CLI is missing: $WEB_CLI" >&2
  exit 2
fi

exec node "$WEB_CLI" "$@"
