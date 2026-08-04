#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESET="${1:-}"
if [[ -z "$PRESET" ]]; then
  echo "usage: $0 <codex|claude|glm-5.2|double|triple|fake> [little-coder args...]" >&2
  exit 2
fi
shift

CONFIG="${TMPDIR:-/tmp}/pi-review-gate-${PRESET//[^a-zA-Z0-9_.-]/_}-review.json"
RETAIN_BUNDLES="${PI_REVIEW_GATE_RETAIN_BUNDLES:-on-failure}"
MAX_CORRECTION_CYCLES=30
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

write_reviewer_config() {
  case "$PRESET" in
    codex)
      echo '  "decider": {"id":"codex","adapter":"codex-cli","timeoutMs":600000}'
      ;;
    claude)
      echo '  "decider": {"id":"claude","adapter":"claude-cli","timeoutMs":600000}'
      ;;
    glm-5.2)
      echo '  "decider": {"id":"glm-5.2","adapter":"little-coder-model","model":"ollama/glm-5.2","timeoutMs":600000}'
      ;;
    double)
      echo '  "reviewers": ['
      echo '    {"id":"codex","adapter":"codex-cli","timeoutMs":600000},'
      echo '    {"id":"glm-5.2","adapter":"little-coder-model","model":"ollama/glm-5.2","timeoutMs":600000}'
      echo '  ]'
      ;;
    triple)
      echo '  "reviewers": ['
      echo '    {"id":"codex","adapter":"codex-cli","timeoutMs":600000},'
      echo '    {"id":"glm-5.2","adapter":"little-coder-model","model":"ollama/glm-5.2","timeoutMs":600000},'
      echo '    {"id":"claude","adapter":"claude-cli","timeoutMs":600000}'
      echo '  ]'
      ;;
    fake)
      MAX_CORRECTION_CYCLES=1
      echo "  \"decider\": {\"id\":\"fake-reviewer\",\"adapter\":\"generic-cli\",\"command\":\"node\",\"args\":[\"$ROOT/scripts/fake-reviewer.cjs\"],\"timeoutMs\":5000}"
      ;;
    *)
      echo "unknown reviewer preset: $PRESET" >&2
      exit 2
      ;;
  esac
}

# Validate the preset before spending time on the build.
case "$PRESET" in
  codex|claude|glm-5.2|double|triple|fake) ;;
  *)
    echo "unknown reviewer preset: $PRESET" >&2
    exit 2
    ;;
esac
if [[ "$PRESET" == "fake" ]]; then
  MAX_CORRECTION_CYCLES=1
fi

npm --prefix "$ROOT" run build

{
  echo '{'
  echo '  "enabled": true,'
  echo "  \"maxCorrectionCycles\": $MAX_CORRECTION_CYCLES,"
  echo '  "implementationGuidanceAfterCorrectionAttempts": 1,'
  echo '  "maxPatchBytes": 200000,'
  echo '  "maxFileBytes": 1048576,'
  echo '  "maxSnapshotBytes": 52428800,'
  echo "  \"retainBundles\": \"$RETAIN_BUNDLES\","
  write_reviewer_config
  echo '}'
} >"$CONFIG"

echo "pi-review-gate reviewer preset: $PRESET"
echo "PI_REVIEW_GATE_CONFIG=$CONFIG"
echo "retainBundles=$RETAIN_BUNDLES"

export PI_REVIEW_GATE_CONFIG="$CONFIG"
export LITTLE_CODER_EXTRA_EXTENSIONS="$ROOT/dist/src/index.js${LITTLE_CODER_EXTRA_EXTENSIONS:+:$LITTLE_CODER_EXTRA_EXTENSIONS}"
echo "LITTLE_CODER_EXTRA_EXTENSIONS=$LITTLE_CODER_EXTRA_EXTENSIONS"
exec little-coder "${LITTLE_CODER_ARGS[@]}"
