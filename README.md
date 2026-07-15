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
  "maxCorrectionCycles": 3,
  "reviewWhen": "changed-files",
  "maxPatchBytes": 200000,
  "maxFileBytes": 1048576,
  "maxSnapshotBytes": 52428800,
  "retainBundles": "on-failure",
  "decider": {
    "id": "codex",
    "adapter": "codex-cli",
    "timeoutMs": 300000
  }
}
```

Multiple reviewers can be configured with `reviewers`. They run in parallel
against the same review bundle. Review-gate waits for every reviewer, then
aggregates the independent results: any reviewer requesting changes causes a
combined `needs_changes` response with that reviewer's findings attributed in
the follow-up. The built-in Codex, Claude, and little-coder model adapters run
as read-only agentic reviewers so they can inspect the workspace and retained
review bundle before deciding. Generic CLI reviewers remain prompt-only unless
the configured command provides its own safe read-only behavior.

```json
{
  "enabled": true,
  "mode": "single-decider",
  "maxCorrectionCycles": 3,
  "reviewWhen": "changed-files",
  "retainBundles": "on-failure",
  "reviewers": [
    {
      "id": "codex",
      "adapter": "codex-cli",
      "timeoutMs": 300000
    },
    {
      "id": "claude",
      "adapter": "claude-cli",
      "timeoutMs": 300000
    }
  ]
}
```

The older single `decider` field is still supported for compatibility.

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

Multi-reviewer examples matching the double and triple wrapper scripts are
available at:

```bash
examples/double-review.json
examples/triple-review.json
```

The little-coder model adapter is generic. The example currently uses
`ollama/glm-5.2`, matching a provider/model entry from
`~/.config/little-coder/models.json`.

For little-coder plus Codex review, use:

```bash
./scripts/little-coder-codex-review.sh
```

The development wrappers pass all ordinary arguments through to `little-coder`.
By default they retain review temp bundles on reviewer failure. To keep every
review bundle, pass:

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

Repository baselines, pre-captured outside-file baselines, user guidance,
tool evidence, assistant summaries, and reviewer feedback belong to one review
window. A requested correction keeps that window open so the next reviewer sees
the original baseline and all intervening context. A passing review checkpoints
and closes the window; later work starts from current file contents and does not
re-review changes that already passed.

## Commands

`/review-now` reruns the configured reviewer or reviewers against the active
review window's baseline and evidence. A pass checkpoints and closes that
window, so `/review-now` cannot resurrect changes from an earlier passing review.

`/review-continue` sends the last reviewer feedback that was held back because
the automatic correction cap was reached. It resets the correction counter, so
the configured correction budget is available again for the continued fix.
Reaching the cap does not accept or checkpoint the changes. Normal user guidance
also remains in the same unresolved window unless that window later passes.

If you send normal guidance while the reviewer is still running, the plugin
holds that input locally until the review finishes. When the reviewer requests
changes, reviewer feedback is queued first, then your held guidance is queued
after it in the same order you typed it.

`/ask-reviewer <question>` asks the configured reviewer or reviewers an ad hoc
question about the current work. It includes the current request context,
changed files and patch when available, and the session evidence digest, including
read-only/tool-call activity and the primary agent's final summary. This makes it
useful after planning-only turns as well as after edits. At the automatic
correction cap it also includes the prior reviewer result and the held correction
message from the same unresolved review window.

Reviewer answers open in an editable prompt. Press Enter to submit the reviewer
note to the primary model as your next message, edit it first if needed, or press
Escape/Ctrl+C to clear it without sending anything.

Retained review bundles include `request.md`, `changed-files.json`,
`patch.diff`, `side-effect.patch.diff`, `reviewer-prompt.md`, `evidence.json`,
`evidence.md`, `acting-model-usage.json`, aggregate `parsed-result.json`,
`reviewer-results.json`, aggregate `reviewer-usage.json`, and an `artifacts/`
tree with captured before/after file contents and evidence baselines where
available. Each reviewer also writes isolated outputs under `reviewers/<id>/`,
including `raw-output.txt`, `stderr.txt`, `parsed-result.json`, and
`reviewer-usage.json`. The little-coder model adapter stores the extracted final
review in `raw-output.txt` and the capped JSONL stream separately as
`raw-stream.jsonl`. When supported by the reviewer CLI, user-facing notices
include a compact reviewer token summary, for example
`review gate: passed (review tokens: in 1.2k, out 340, total 1.6k)`.
