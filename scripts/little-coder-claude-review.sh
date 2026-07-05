#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${TMPDIR:-/tmp}/pi-review-gate-claude-review.json"
RETAIN_BUNDLES="${PI_REVIEW_GATE_RETAIN_BUNDLES:-on-failure}"
LITTLE_CODER_ARGS=()

while (($#)); do
  case "$1" in
    --retain-review-bundles|--keep-review-bundles|--store-review-tmp|--store-review-tmp-files)
      RETAIN_BUNDLES="always"
      shift
      ;;
    --retain-review-bundles=*)
      RETAIN_BUNDLES="${1#*=}"
      shift
      ;;
    --)
      shift
      LITTLE_CODER_ARGS+=("$@")
      break
      ;;
    *)
      LITTLE_CODER_ARGS+=("$1")
      shift
      ;;
  esac
done

case "$RETAIN_BUNDLES" in
  never|on-failure|always) ;;
  *)
    echo "invalid --retain-review-bundles value: $RETAIN_BUNDLES" >&2
    echo "expected one of: never, on-failure, always" >&2
    exit 2
    ;;
esac

npm --prefix "$ROOT" run build

cat >"$CONFIG" <<JSON
{
  "enabled": true,
  "mode": "single-decider",
  "maxCorrectionCycles": 30,
  "reviewWhen": "changed-files",
  "maxPatchBytes": 200000,
  "maxFileBytes": 1048576,
  "maxSnapshotBytes": 52428800,
  "retainBundles": "$RETAIN_BUNDLES",
  "decider": {
    "id": "claude",
    "adapter": "claude-cli",
    "timeoutMs": 600000
  }
}
JSON

echo "pi-review-gate Claude reviewer config: $CONFIG"
echo "retainBundles=$RETAIN_BUNDLES"

export PI_REVIEW_GATE_CONFIG="$CONFIG"
export LITTLE_CODER_EXTRA_EXTENSIONS="$ROOT/dist/src/index.js${LITTLE_CODER_EXTRA_EXTENSIONS:+:$LITTLE_CODER_EXTRA_EXTENSIONS}"
echo "PI_REVIEW_GATE_CONFIG=$PI_REVIEW_GATE_CONFIG"
echo "LITTLE_CODER_EXTRA_EXTENSIONS=$LITTLE_CODER_EXTRA_EXTENSIONS"
if ((${#LITTLE_CODER_ARGS[@]})); then
  exec little-coder "${LITTLE_CODER_ARGS[@]}"
else
  exec little-coder
fi
