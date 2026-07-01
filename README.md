# pi-review-gate

External pi extension that reviews code changes after an agent turn and sends
concise follow-up instructions when a configured reviewer finds blocking issues.

## Development

```bash
npm install
npm test
```

## Configuration

Point the extension at a JSON config file:

```bash
PI_REVIEW_GATE_CONFIG=/path/to/review-gate.json
```

Disable the gate:

```bash
PI_REVIEW_GATE_DISABLED=1
```

The older `LITTLE_CODER_REVIEW_CONFIG` and
`LITTLE_CODER_REVIEW_GATE_DISABLED` names are still accepted as compatibility
aliases.

Example config:

```json
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
    "id": "claude",
    "adapter": "generic-cli",
    "command": "claude",
    "args": ["--print"],
    "timeoutMs": 120000
  }
}
```

Load during development by pointing your pi host at the built extension:

```bash
PI_REVIEW_GATE_CONFIG=/path/to/review-gate.json \
pi -e /path/to/pi-review-gate/dist/src/index.js
```

For little-coder specifically, the same built extension can be loaded with:

```bash
PI_REVIEW_GATE_CONFIG=/path/to/review-gate.json \
little-coder -e /path/to/pi-review-gate/dist/src/index.js
```

## Temporary fake reviewer

For local wiring tests, use the fake reviewer wrapper:

```bash
./scripts/little-coder-fake-review.sh
```

By default it approves changed files. To force the retry/follow-up path:

```bash
PI_REVIEW_GATE_FAKE_VERDICT=retry ./scripts/little-coder-fake-review.sh
```

Optional retry message controls:

```bash
PI_REVIEW_GATE_FAKE_ISSUE="Controlled fake issue." \
PI_REVIEW_GATE_FAKE_RECOMMENDATION="Make any tiny follow-up edit." \
PI_REVIEW_GATE_FAKE_VERDICT=retry \
./scripts/little-coder-fake-review.sh
```
