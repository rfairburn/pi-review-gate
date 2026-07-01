#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${TMPDIR:-/tmp}/pi-review-gate-fake-review.json"

npm --prefix "$ROOT" run build

cat >"$CONFIG" <<JSON
{
  "enabled": true,
  "mode": "single-decider",
  "maxCorrectionCycles": 1,
  "reviewWhen": "changed-files",
  "maxPatchBytes": 200000,
  "maxFileBytes": 1048576,
  "maxSnapshotBytes": 52428800,
  "retainBundles": "on-failure",
  "decider": {
    "id": "fake-reviewer",
    "adapter": "generic-cli",
    "command": "node",
    "args": ["$ROOT/scripts/fake-reviewer.cjs"],
    "timeoutMs": 5000
  }
}
JSON

echo "pi-review-gate fake reviewer config: $CONFIG"
echo "PI_REVIEW_GATE_FAKE_VERDICT=${PI_REVIEW_GATE_FAKE_VERDICT:-pass}"

export PI_REVIEW_GATE_CONFIG="$CONFIG"
export LITTLE_CODER_EXTRA_EXTENSIONS="$ROOT/dist/src/index.js${LITTLE_CODER_EXTRA_EXTENSIONS:+:$LITTLE_CODER_EXTRA_EXTENSIONS}"
echo "PI_REVIEW_GATE_CONFIG=$PI_REVIEW_GATE_CONFIG"
echo "LITTLE_CODER_EXTRA_EXTENSIONS=$LITTLE_CODER_EXTRA_EXTENSIONS"
exec little-coder "$@"
