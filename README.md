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

Example config using Codex as the reviewer:

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
    "id": "codex",
    "adapter": "codex-cli",
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

A Codex-oriented starter config is available at:

```bash
examples/single-codex.json
```

Claude and little-coder model examples are available at:

```bash
examples/single-claude.json
examples/single-little-coder-model.json
```

The little-coder model adapter is generic. The example currently uses
`ollama/glm-5.2`, matching a provider/model entry from
`~/.config/little-coder/models.json`.

For little-coder plus Codex review, use:

```bash
./scripts/little-coder-codex-review.sh
```

The development wrappers pass all ordinary arguments through to `little-coder`.
By default they do not retain review temp bundles. To keep review bundles, pass:

```bash
./scripts/little-coder-codex-review.sh --retain-review-bundles
```

The wrapper flag also accepts explicit modes:

```bash
--retain-review-bundles=never
--retain-review-bundles=on-failure
--retain-review-bundles=always
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

The review bundle includes a compact evidence ledger built from tool calls,
tool results, high-confidence file path arguments, shell redirection targets,
and the agent's final assistant summary. Exact `write` / `edit` paths and easy
shell targets are pre-captured before execution, including absolute paths
outside the current worktree.

## Commands

`/review-now` reruns the configured reviewer against the current captured
baseline and evidence.

`/ask-reviewer [--private|--public] <question>` asks the configured reviewer an
ad hoc question about the current work. It includes the current request context,
changed files and patch when available, and the session evidence digest,
including read-only/tool-call activity and the primary agent's final summary.
This makes it useful after planning-only turns as well as after edits.

`--private` is the default. The answer is shown to you but is not sent to the
primary model. With `--public`, the answer is also queued as `nextTurn` context,
so the primary model sees it on your next real message without triggering a new
turn immediately.

Retained review bundles include `request.md`, `changed-files.json`,
`patch.diff`, `reviewer-prompt.md`, `evidence.json`, `evidence.md`,
`acting-model-usage.json`, `reviewer-usage.json`, `raw-output.txt`, and
`stderr.txt`. When supported by the reviewer CLI, user-facing notices include a
compact reviewer token summary, for example `review gate: passed (review tokens:
in 1.2k, out 340, total 1.6k)`.
