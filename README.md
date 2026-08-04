# pi-review-gate

External pi extension that reviews code changes after an agent turn and sends
the complete classified review pass back to the implementing model.

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
  "implementationGuidanceAfterCorrectionAttempts": 1,
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
against the same review bundle. Review-gate waits for every reviewer and applies
a simple gate: any `needs_changes` verdict means changes are required, all
reviewers must pass for the gate to pass, and reviewer errors prevent a silent
pass. Each reviewer appears once in the implementing-model transmission, and
review decisions are stored per reviewer rather than as an additional combined
result. There is no separate aggregate summary, guidance, or finding set.
Results from every reviewer are transmitted, including passing assessments,
non-blocking observations, guidance, disagreements, and reviewer errors.
Blocking findings are identified as required corrections; passing and
non-blocking material remains visible without becoming mandatory work. The built-in Codex, Claude,
and little-coder model adapters run
as read-only agentic reviewers so they can inspect the workspace and retained
review bundle before deciding. Generic CLI reviewers remain prompt-only unless
the configured command provides its own safe read-only behavior.

Agentic reviewers may use their native read tools or strictly read-only shell
commands (`ls`, `find`, `rg`, `grep`, `sed`, `cat`, and read-only Git commands)
when the shell is their only filesystem interface. Codex starts in its
`read-only` sandbox and receives a native output schema on the initial turn. A
local no-op sandbox preflight detects platform sandbox startup failures before
a model turn is spent.
Reviewer output is parsed strictly first; a narrow fallback recovers the same
schema when a model emits otherwise-valid fields with unescaped multiline
Markdown. Sandbox startup failures remain explicit reviewer errors rather than
being mislabeled as verdict-schema failures.

```json
{
  "enabled": true,
  "mode": "single-decider",
  "maxCorrectionCycles": 3,
  "implementationGuidanceAfterCorrectionAttempts": 1,
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

`implementationGuidanceAfterCorrectionAttempts` controls when every review path
strengthens its request for concrete implementation guidance. The default is
`1`: reviewer responses are implementation-ready from the start, and after one
correction attempt the next automatic review, `/review-now`, or `/ask-reviewer`
first verifies historical findings against the current workspace. For only
those problems it independently confirms still remain, it explicitly requires
a targeted code example, minimal diff, or exact actionable steps. Code examples
stay inside the structured response's Markdown `guidance` field and are rendered
under the review's Guidance section; the Summary, Issue, and Recommendation
fields keep their existing formatted layout. The presence of prior feedback is
not treated as proof that the correction failed. Set the value to `0` to apply
this conditional verification and concrete-guidance requirement on the first
review. There is no separate disabled value; use a threshold higher than the
configured correction budget to prevent threshold escalation while retaining
the normal implementation-ready prompt.

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
`~/.config/little-coder/models.json`. Review invocations use Pi's `high`
thinking level by default; an explicit `args` entry can override it.

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

Built-in Codex, Claude, and little-coder reviewers use one explicit CLI session
per reviewer for the lifetime of a review window. Correction reviews,
continuations made after a passing transmission, and `/ask-reviewer` resume that
same reviewer session against the same evidence bundle. A new review window
always starts new reviewer sessions. The bundle is
still authoritative: if a saved session cannot be resumed, the reviewer can be
restarted from the complete bundle without losing review context.

Canceling a running review with Escape cancels the whole parallel review, even
if one reviewer has already completed. Partial results are discarded and are
not transmitted. The numbered invocation remains as a `CANCELED.md` tombstone
stating that a review would have run there but was canceled by the user, so pass
order remains unambiguous. Cancellation restores the reviewer-session handles
from before that invocation; the next review keeps the same evidence bundle and
resumes from the last successful sessions instead of starting a new window.

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

Each review window uses one stable temporary evidence bundle. Every completed
agent run is appended as a numbered exchange containing its snapshot-derived
workspace diff, captured side-effect diff, tool calls and results, assistant
summary, usage, and before/after artifacts. The bundle also maintains the
cumulative baseline-to-current patch and numbered reviewer invocations.

Codex, Claude, and little-coder reviewers receive a compact prompt pointing to
the bundle's `REVIEW.md` entry point and inspect the evidence with read-only
tools. The generic CLI adapter retains the inline prompt as a compatibility
transport and also receives the bundle path in `PI_REVIEW_GATE_BUNDLE_DIR`.
Exact `write` / `edit` paths and easy shell targets are pre-captured before
execution, including absolute paths outside the current worktree.

Repository baselines, per-exchange snapshots, pre-captured outside-file
baselines, user guidance, tool evidence, assistant summaries, reviewer feedback,
and reviewer sessions belong to one review window. A requested correction keeps
that window open. Even when a correction exactly restores the original baseline,
the next reviewer sees the inverse exchange diff and validates the correction.
A passing review is transmitted to the implementing model as a final review
turn with every reviewer's official notes. The pass certifies the exact reviewed
workspace snapshot. A response that does not change the workspace or create a
meaningful persistent side effect checkpoints and closes the window while
retaining it for an immediate `/ask-reviewer` follow-up. If the implementing
model makes another change after seeing the passing observations, that response
becomes a new exchange in the same window and triggers another review. Later
ordinary work starts a fresh window from current file contents and does not
re-review changes that already passed.

## Commands

`/review-clear` discards the active or retained review window, including its
baseline, request history, captured evidence, prior reviewer feedback, held
correction feedback, and queued user input. The next ordinary prompt starts a
fresh window from the workspace's current contents. It does not revert files or
override bundle retention: bundles continue to be retained or removed by the
configured `retainBundles` policy (`never`, `on-failure`, or `always`).
Already-retained bundles remain governed by that policy. Reviewer sessions from
the cleared window are never reused. If a review is currently running, cancel it
first and then run `/review-clear`.

`/review-now` reruns the configured reviewer or reviewers against the active
review window's baseline and evidence. Its complete result is transmitted to
the implementing model. A pass closes only after the implementing model responds
without changing the reviewed state.

`/review-pause` suppresses automatic and explicitly requested reviewer runs
without stopping evidence collection. Each primary-model turn is still captured
as a separate exchange. `/review-unpause` resumes reviewer execution; the next
eligible turn reviews the accumulated changes and evidence. `/review-now` and
`/ask-reviewer*` remain unavailable while reviews are paused.

Reaching the automatic correction cap does not hide reviewer information. The
complete pass is transmitted with correction classified as deferred.
`/review-continue` authorizes the last capped feedback for correction and resets
the correction counter using a compact authorization message that references the
already-delivered pass instead of repeating its reviewer results, so the
configured correction budget is available again.
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
useful after planning-only turns as well as after edits. Immediately after a
passing review, it can still use that passed window's patch and evidence; a
regular prompt starts a fresh window instead. At the automatic correction cap it
also includes the prior reviewer results, the deferred transmission, and any
later `/review-continue` authorization from the same unresolved review window.

`/ask-reviewer` uses a two-stage interruption when the implementing model is in
a turn. It first steers a hold instruction that tells the model not to call more
tools or modify more files. Any tool calls already issued in the current
assistant batch may finish before steering is delivered. Once that turn ends
and its exchange is captured, the gate asks the
reviewer against the stable workspace and steers the resulting note into the
next model step. Escape remains available when an immediate hard stop is
required. `/ask-reviewer-interactive <question>` uses the same reviewer,
session, evidence, answer formatting,
two-stage interruption, and acceptance path, but opens the answer in an editable
prompt first. Press Enter to submit it, edit it first if needed, or press
Escape/Ctrl+C to clear it without sending anything.

Submitting either command accepts the question and the exact submitted reviewer
note into structured session evidence. Later automatic reviews, `/review-now`,
and reviewer-question calls in the resulting review window receive the accumulated
accepted Q&A, including preserved Markdown and fenced code. Clearing the editor
does not accept or record the answer. When a question follows a passing review,
its accepted Q&A is carried into the new review window created for the submitted
reviewer note without reusing the already-checkpointed file baseline.

Retained review bundles include `REVIEW.md`, `manifest.json`, `request.md`, a
`current/` cumulative view, immutable `exchanges/<sequence>/` evidence,
numbered `reviews/<sequence>/` and `questions/<sequence>/` invocations,
`sessions.json`, and captured before/after artifacts. Reviewer outputs remain
isolated under each invocation's `reviewers/<id>/` directory. Each completed
review pass also stores `implementing-model-transmission.md`, its structured
JSON envelope, and additive `delivery.json` receipts recording exactly what the
implementing model was told and whether the transmission required correction,
reported a pass, deferred action, or disclosed a review error. Later reviewers
are directed to read these records before judging a continuation. The envelope
contains the gate verdict and the individual reviewer results; no unsent
aggregate result is persisted. A canceled numbered invocation contains
`CANCELED.md` and `canceled.json` rather than reviewer results. The little-coder
model adapter stores the extracted final review in `raw-output.txt` and the
capped JSONL stream separately as `raw-stream.jsonl`. When supported by the
reviewer CLI, user-facing notices include a compact reviewer token summary, for
example
`review gate: passed (review tokens (this pass): input 1.2k (uncached 400, cached 800), out 340, total 1.6k)`.
