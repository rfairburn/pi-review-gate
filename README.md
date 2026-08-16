# pi-review-gate

External pi extension that reviews code changes after an agent turn and sends
the complete classified review pass back to the implementing model.

## Development

```bash
npm install
npm test
```

The complete test run executes up to four test files concurrently. Use
`npm run test:fast` for the short pure/unit development loop. Use `npm test`
(or `npm run test:integration`) for the process, Git, filesystem, and end-to-end
suite before finalizing a phase. For diagnosing resource-sensitive or
ordering-sensitive failures, use the serial fallback:

```bash
npm run test:serial
npm run check:static
npm run test:package
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
  "reviewerTimeoutMs": 600000,
  "executorTimeoutMs": 1800000,
  "maxCorrectionCycles": 3,
  "implementationGuidanceAfterCorrectionAttempts": 1,
  "maxPatchBytes": 200000,
  "maxFileBytes": 1048576,
  "maxSnapshotBytes": 52428800,
  "waveArtifactTtlMs": 2592000000,
  "retainBundles": "on-failure",
  "decider": {
    "id": "codex",
    "adapter": "codex-cli",
    "timeoutMs": 600000
  }
}
```

Multiple reviewers can be configured with `reviewers`. They run in parallel
against the same review bundle. Review-gate waits for every reviewer and applies
a simple gate: any `needs_changes` verdict means changes are required; when no
reviewer requests changes, at least one completed `pass` is accepted even if
another reviewer has an infrastructure error; and the gate errors only when no
reviewer completes a usable review. Mixed pass/error results are classified as
`pass_with_warnings`, retain their evidence, and return every reviewer result to
the orchestrator. Each reviewer also appears once in the implementing-model
transmission.
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
schema when a model emits an actionable non-passing result with unescaped
multiline Markdown. A passing verdict is never accepted through repair.
Sandbox startup failures remain explicit reviewer errors rather than
being mislabeled as verdict-schema failures.

Reviewer/executor stdout and stderr are retained up to 100 MiB
per stream for diagnostics; JSONL protocols are decoded incrementally with
separate bounded records, so protocol correctness does not depend on display
capture truncation.

The reviewer treats orchestrator-provided task direction as authorized and
reviews concrete logic, regressions, security, API behavior, tests, and explicit
acceptance criteria. It must not request changes merely because an implementation
choice was not separately requested by the user. Targeted tests are expected in
delegated correction loops; absent an explicit task criterion or a concrete
cross-cutting risk, a full-suite run is a non-blocking final-orchestration note.

```json
{
  "enabled": true,
  "maxCorrectionCycles": 3,
  "implementationGuidanceAfterCorrectionAttempts": 1,
  "retainBundles": "on-failure",
  "reviewers": [
    {
      "id": "codex",
      "adapter": "codex-cli",
      "timeoutMs": 600000
    },
    {
      "id": "claude",
      "adapter": "claude-cli",
      "timeoutMs": 600000
    }
  ]
}
```

The older single `decider` field is still supported for compatibility.

### Delegated execution and runtime settings

`/review-settings` opens one staged settings transaction with seven sections:

- **Executor pool** is an ordered list of Pi-scoped little-coder models and
  execution-capable entries from `externalAgents`. **Add executor** walks
  through model, reasoning (when supported), and maximum concurrency. Existing
  entries can be edited, moved up/down, or removed.
- **Reviewers** is a multi-selection, `/scoped-models`-style picker over the
  same Pi-scoped models plus review-capable entries from `externalAgents`.
  Clearing every reviewer is valid and disables automatic review without
  disabling delegated execution. Each selected internal reviewer has its own
  **Reasoning** row.
- **Timeouts** edits the default reviewer and executor timeouts in minutes.
  Reviewers default to 10 minutes and executors to 30 minutes. Explicit
  `externalAgents[].review.timeoutMs` and `externalAgents[].execution.timeoutMs`
  values override these defaults for that external harness role.
- **Review policy** edits `maxCorrectionCycles` and
  `implementationGuidanceAfterCorrectionAttempts` as non-negative whole
  numbers.
- **Bundle retention** selects `never`, `on-failure`, or `always`. Choose
  `always` when successful executor and reviewer turns need to remain available
  for inspection.
- **Global concurrency** sets `execution.maxWorkers` (1–16, default 4). This is
  the total worker ceiling; each executor-pool entry also has its own
  `maxConcurrent` capacity.
- **Retry policy** configures bounded executor/reviewer recovery: retry count,
  exponential-backoff bounds, jitter, and the repeated-incident guard.

Escape from a submenu returns to the settings root. Escape or **Cancel** at the
root discards all staged changes; **Save changes** atomically persists every
section while preserving unrelated JSON keys. An inactive external definition
does not need to be installed. Its command is checked when that definition is
selected or run.

The executor pool and reviewers are independent:

| Reviewers | Executor pool | Behavior |
| --- | --- | --- |
| selected | non-empty | delegated execution with the full review/correction loop |
| none | non-empty | delegated execution returns `completed_unreviewed` |
| selected | empty | automatic parent review only |
| none | empty | settings remain available; both behaviors are off |

Top-level `enabled: false` is the automatic-review master switch and does not
disable a configured executor pool. The environment kill switches disable the whole
extension, including delegated execution.

With an executor selected, the plugin exposes one delegated-execution tool:
`execute_subtasks`. It accepts 1–16 bounded tasks, so a single phase and a
multi-worker wave use the same isolated worktree, review, retry, integration,
and landing lifecycle. The configured harness/model cannot be changed in tool
arguments. If review is enabled, corrections and post-pass confirmation reuse
the child's durable session; any post-pass tree change is reviewed again.

The tool has four top-level actions: `start`, `continue`, `steer`, and `inspect`.
`start` creates a wave. `continue` performs another durable turn and completes
review/integration/landing. `inspect` expands a reattachment bundle, or an
explicit `waveRoot` for a wave without an operation bundle yet, into current
state and recovery diagnostics. `steer` is live-turn-only and currently reports
that foreground adapters are not steerable; it never silently becomes a
continuation. `continue`, `steer`, and `inspect` may omit the bundle only when
the calling orchestrator has exactly one associated operation.

Executor failures are checkpointed to a protected recovery ref before bounded
retry. Compaction is a lifecycle transition: an interrupted Little Coder
session is reopened by exact UUID, explicitly compacted through Pi RPC, and
only then prompted to continue. If same-executor recovery is exhausted, a
verified checkpoint may be handed to the next lower-priority pool entry. That
adapter starts a new native session in the same isolated worktree, so different
providers and CLI harnesses can take over without pretending to share conversation
state. Durable diagnostics include the complete executor assignment history.
Non-landed results include the worktree,
session, attempts, incidents, changed paths, verified checkpoint, hashed
artifact inventory, current bundle, and safe next actions. Only `landed` means
that worker changes reached the source workspace.

The tool card shows the current phase and elapsed time. Ctrl+O expands bounded
per-task activity, executor/reviewer identity, artifacts, review cycles, and
verdicts. Five-second UI refreshes do not slow executor turns and are not copied
into model context; only the final result packet is returned as tool context.

Review and execution recovery state is scoped to the exact Pi conversation.
The normal restart flow—launching into a temporary/default session and then
running `/resume <session>`—loads the selected conversation in a fresh extension
runtime and restores only that conversation's integrity-checked sidecar state.
The temporary startup session is shut down and cannot leak its review window or
wave associations into the resumed session. Restored state includes review
baselines/evidence, pending model deliveries, wave roots, operation bundles,
task definitions, incidents, checkpoints, and owner leases. A live or uncertain
owner blocks another writer; a confirmed-dead writer can be reconciled into a
freshly reverified checkpoint before an explicit continuation. Queued inputs
from a review interrupted by restart are not reordered automatically: use
`/review-now` to finish the review and release them, or `/review-clear` to cancel
them.

Codex CLI, Claude CLI, and Little Coder reviewers stream bounded native lifecycle
and read-only tool activity into ordinary review status and delegated-subtask
activity views without exposing reasoning contents or reviewer output. Generic
CLI reviewers expose start/finish status because their protocol has no structured
intermediate event stream.
Foreground automatic reviews, `/review-now`, and reviewer-question commands show
the active reviewer milestone and elapsed time in the status line until the
review completes or is cancelled.

### Delegated waves with `execute_subtasks`

Each task runs in an isolated worktree with its own review lifecycle. Tasks are
specified as an array of 1–16 items.

**Concurrency**: `maxWorkers` controls concurrent workers (1–16, default 4).
The tool-call value overrides `config.execution.maxWorkers`; task count is
independent, and excess tasks queue. Fresh tasks scan `execution.executorPool`
in strict priority order and use the first entry with remaining
`maxConcurrent` capacity. Thus a one-slot local primary can remain preferred
while lower-priority cloud entries absorb overflow. The sum of pool capacities
may exceed `maxWorkers`; it describes available fallback capacity, not the
number of workers that must run.

**Integration policy**: By default all-or-nothing: any worker that is not
accepted, accepted_with_warnings, completed_unreviewed, or no_changes blocks
integration entirely. Set `integratePartial: true` to integrate eligible workers
(accepted / accepted_with_warnings / completed_unreviewed) in declared order
despite failed ones.

**Integration order**: Workers are integrated in the declared order from the
tasks array, regardless of completion order.

**Landing**: After integration, changes are landed into the source workspace.
The final changes are uncommitted — they appear as unstaged working-tree
changes; the source index and staging state remain unchanged.

**Snapshot and ignore policy**: The wave captures a snapshot of the source
workspace. Non-ignored untracked files are included in the snapshot. Git-ignored
files are excluded from the captured snapshot and landing. This means dependencies
installed in `node_modules`, secrets in `.env`, and other ignored paths are
not captured or landed. If your task depends on files that are git-ignored,
the worker will not see them. Files known to Git through `HEAD` or the index are
always captured regardless of repository size. During parallel wave capture,
`maxSnapshotBytes` limits only the cumulative size of non-ignored untracked
files (50 MiB by default). For ordinary serial review snapshots, the same
setting continues to bound the textual file content retained for diffing.

**Artifacts**: Each wave produces a `waveRoot` directory containing artifacts
for each task, a wave manifest (`wave-manifest.json`), and stable refs for
integrated commits. The wave root path is returned in the tool result. On later
wave starts, completed non-recovery roots older than `waveArtifactTtlMs` are
garbage-collected (30 days by default; `0` disables collection). Conflict,
integration-error, and recovery-required roots are never removed by this GC,
and `retainBundles: "always"` disables wave GC.

**Conflict and recovery**: If integration encounters conflicts, the wave
returns a `conflicted` status with details about the conflicting task, commit,
and paths. The integration worktree is preserved for diagnosis. Landing
conflicts are reported with per-path conflict details. Rolled-back landings
store a recovery manifest for manual recovery.

Every non-landed `execute_subtasks` result includes an explicit outcome and
recovery packet for both the controlling model and the expanded activity view.
For integration and landing conflicts it states that no executor changes were
applied to the source workspace, identifies preserved diagnostic worktrees when
present, retained commits, paths, Git diagnostics, and reattachment bundles,
and explains that the orchestrator must either resolve the combined change
itself or continue a specific retained task. Conflict wave manifests retain
the same provenance so `inspect` can recover it after compaction or
reattachment. A
`recovery_required` landing is called out separately because an incomplete
rollback means the source may be partially modified and its recovery manifest
must be handled before further edits.

**Source preservation**: The wave never mutates the source repository through
Git operations. Source HEAD, index, staging state, and stash are preserved.
Absolute source-workspace paths in task and correction text are remapped to the
worker worktree, and executor `PWD` is set to its actual isolated cwd. Clean
worktrees are removed after completion; dirty or conflicted worktrees are
preserved for diagnosis. This is worktree and instruction isolation, not an OS
sandbox: a hostile custom executor process can still access paths allowed by
the host account.

Pi/little-coder internal model selections use the exact canonical
`provider/model` value and store a role-owned `thinkingLevel`. The allowed
levels come from that scoped model's runtime metadata, including its
`thinkingLevelMap`; unsupported extended levels such as `max` are not offered.
These settings do not inherit the controlling session's thinking level. For
example, the menu displays:

```text
gpt-5.6-sol [openai-codex]
```

and persists:

```json
{
  "source": "little-coder",
  "model": "openai-codex/gpt-5.6-sol",
  "thinkingLevel": "high"
}
```

For internal little-coder providers, review-gate also sets the independent
thinking-budget cap to match Pi's level guidance: `minimal` is 1,024 tokens,
`low` is 2,048, `medium` is 8,192, and `high` is 16,384. `xhigh` and `max` use
the same 16,384-token ceiling because Pi does not define a larger numeric
budget for those levels. The `anthropic`, `openai`, and `openai-codex`
providers are excluded because Pi already gives them native token budgets or
reasoning effort. A second output-side character estimate would duplicate that
budget or cap a summary rather than the provider's hidden reasoning. Reviewer
and executor selections remain separate from the orchestrator. External
harnesses continue to configure reasoning through their role-specific arguments
or environment.

An end-to-end configuration example is available at
`examples/delegated-execution.json`. `externalAgents` is one configured catalog
shared by both menus. Each entry has an optional `review` role, `execution`
role, or both. Role sections can override shared arguments, environment, model,
protocol, and timeout, so one harness can use different limits for review and
execution. Pi-scoped internal models remain runtime-discovered and are never
copied into the external catalog.

Reviewer selections use discriminated references:

```json
{
  "review": {
    "activeReviewers": [
      { "source": "little-coder", "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "high" },
      { "source": "external", "id": "codex-sol" }
    ]
  }
}
```

An internal model may use different reasoning for the two roles because the
level lives on each selection. External harness reasoning remains native to the
harness and is configured independently under `externalAgents[].review.args`
and `externalAgents[].execution.args`. For example, a Codex CLI role can use
`["-c", "model_reasoning_effort=\"high\""]`, while Claude Code can use
`["--effort", "high"]`. Arbitrary binary adapters may use their own arguments
or environment variables.

Legacy `decider`, `reviewers`, `enabledReviewerIds`, and
`execution.externalExecutors` configurations remain readable. A successful
`/review-settings` save migrates their definitions into `externalAgents`.

The `run-as-binary` adapter uses the versioned
`pi-review-executor-jsonl-v1` protocol. It sends the prompt on stdin and sets
`PI_REVIEW_EXECUTOR_OPERATION` (`start` or `resume`),
`PI_REVIEW_EXECUTOR_SESSION_ID`, and `PI_REVIEW_EXECUTOR_PROTOCOL`. The process
emits newline-delimited JSON:

```jsonl
{"type":"session","sessionId":"stable-session-id"}
{"type":"assistant","text":"Implemented and verified the bounded phase."}
{"type":"usage","usage":{"input_tokens":100,"output_tokens":25}}
```

The assistant event is required. The session event lets later correction and
post-pass turns resume the same harness context. Authentication remains in each
harness's own login/configuration; do not put OAuth tokens or API keys in the
review-gate file.

`implementationGuidanceAfterCorrectionAttempts` controls when every review path
strengthens its request for concrete implementation guidance. The default is
`1`: reviewer responses are implementation-ready from the start, and after one
correction attempt the next automatic review, `/review-now`, or `/ask-reviewer`
first verifies historical findings against the current workspace. For only
those problems it independently confirms still remain, it explicitly requires
a concise prose defense plus a concise, directly applicable implementation diff
showing exactly what code the reviewer expects for the finding to pass. The diff
may be as complete as necessary and does not have to be minimal. Genuinely
non-code findings require exact actionable steps and a defense of why they are
sufficient. This guidance stays inside the structured response's Markdown
`guidance` field and is rendered under the review's Guidance section; the
Summary, Issue, and Recommendation fields keep their existing formatted layout.
The presence of prior feedback is not treated as proof that the correction
failed. Set the value to `0` to apply this conditional verification and
concrete-guidance requirement on the first
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

For normal use with the first existing fallback config, use the persistent
launcher:

```bash
./scripts/little-coder-review-gate.sh
```

It builds and explicitly enables this extension, forwards all arguments to
little-coder, sets the foreground model's `LITTLE_CODER_THINKING_BUDGET` to
16,384 tokens, and leaves config resolution on the established fallback order:
`~/.config/pi-review-gate/config.json`, `~/.config/pi/review-gate.json`, then
`~/.config/little-coder/review-gate.json`. It fails clearly if none exists and
does not generate or rewrite configuration.

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
examples/double-deepseek-v4-flash-review.json
examples/triple-review.json
```

The DeepSeek double is an alternative to the default Codex + GLM-5.2 pairing;
it runs Codex and `ollama/deepseek-v4-flash:0731-cloud` as independent
reviewers.

The little-coder model adapter is generic. The example currently uses
`ollama/glm-5.2`, matching a provider/model entry from
`~/.config/little-coder/models.json`. Legacy internal selections without a
`thinkingLevel` continue to use `high`; saving them through `/review-settings`
materializes an explicit model-supported level.

For little-coder plus Codex review, use:

```bash
./scripts/little-coder-codex-review.sh
```

For the Codex + DeepSeek-V4-Flash double, use:

```bash
./scripts/little-coder-double-deepseek-v4-flash-review.sh
```

All named development wrappers delegate to one preset launcher. It can also be
used directly with `codex`, `claude`, `glm-5.2`, `double`,
`double-deepseek-v4-flash`, `triple`, or `fake`:

```bash
./scripts/little-coder-review.sh double
```

The development wrappers pass all ordinary arguments through to `little-coder`
and set the foreground model's `LITTLE_CODER_THINKING_BUDGET` to 16,384 tokens.
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

Every built-in Codex, Claude, and little-coder review pass starts a fresh CLI
session. Correction context comes from the stable evidence bundle rather than
accumulated model/tool history, avoiding reviewer compaction across passes.
Correction reviewers begin with the original task evidence, latest correction
exchange, immediately preceding findings, and current files. Complete earlier
history remains available for targeted inspection but is not read by default.

Canceling a running review with Escape cancels the whole parallel review, even
if one reviewer has already completed. Partial results are discarded and are
not transmitted. The numbered invocation remains as a `CANCELED.md` tombstone
stating that a review would have run there but was canceled by the user, so pass
order remains unambiguous. The next review keeps the same evidence bundle but
starts fresh reviewer sessions.

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
baselines, user guidance, tool evidence, assistant summaries, and reviewer
feedback belong to one review window. A requested correction keeps
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
Already-retained bundles remain governed by that policy. Reviewer sessions are
never reused between passes. If a review is currently running, cancel it
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
`sessions.json`, per-pass `review-telemetry.json`, and captured before/after
artifacts. Reviewer outputs remain
isolated under each invocation's `reviewers/<id>/` directory. Each completed
review pass also stores `implementing-model-transmission.md`, its structured
JSON envelope, and additive `delivery.json` receipts recording exactly what the
implementing model was told and whether the transmission required correction,
reported a pass, deferred action, or disclosed a review error. Later reviewers
start with the immediately preceding record and consult older records only when
the latest correction evidence requires it. The envelope
contains the gate verdict and the individual reviewer results; no unsent
aggregate result is persisted. Telemetry records prompt and stream bytes,
tool-call and tool-result volume, wall time, token usage, compaction events, and
whether session reuse occurred; it measures behavior without imposing a token
budget. A canceled numbered invocation contains
`CANCELED.md` and `canceled.json` rather than reviewer results. The little-coder
model adapter stores the extracted final review in `raw-output.txt` and the
capped JSONL stream separately as `raw-stream.jsonl`. When supported by the
reviewer CLI, user-facing notices include a compact reviewer token summary, for
example
`review gate: passed (review tokens (this pass): input 1.2k (uncached 400, cached 800), out 340, total 1.6k)`.

## Crash Recovery for Landing Manifests

When a wave landing is in progress, a recovery manifest is written atomically
under `<waveRoot>/landing/manifest-<txId>.json` before any filesystem mutations.
If the process dies mid-landing, the manifest remains in `in_progress` or
`recovery_required` state with backup artifacts preserved.

### Manifest location

Recovery manifests live in the wave root directory:

```
<waveRoot>/landing/manifest-<uuid>.json
```

The wave root is the parent of the private bare Git repository created during
capture. Each manifest is scoped to a single transaction via a unique UUID.

### Recovery API

The `recoverLandingManifest(manifestPath)` function in
`src/execution/wave-landing.ts` recovers a crashed landing transaction:

```typescript
import { recoverLandingManifest } from "../src/execution/wave-landing";

const result = await recoverLandingManifest("/path/to/manifest.json");

// result.status is one of:
//   "recovered"       — all paths restored, manifest marked rolled_back
//   "manual_required" — concurrent modifications detected, artifacts preserved
//   "rejected"        — manifest invalid (wrong version, path escape, identity mismatch)
//   "terminal"        — manifest already completed or rolled_back; stale artifacts cleaned
```

### Recovery behavior

- **Source root identity**: Recovery verifies the source root's dev+ino matches
  the manifest. If the directory was replaced or moved, recovery is rejected.
- **Path confinement**: All destination, temp, and backup paths must reside
  within the source root. Path-escaping manifests are rejected.
- **Concurrent modifications**: If a destination was modified after the
  transaction installed it, recovery preserves both the newer destination and
  the original backup, marking the manifest `recovery_required`.
- **Idempotency**: Running recovery twice on the same manifest is safe. The
  first call restores paths and marks the manifest `rolled_back`; the second
call cleans stale temps.
- **No Git mutation**: Recovery never invokes Git staging, reset, or apply
  commands. It only manipulates filesystem artifacts.
- **Artifact preservation on manual_required**: When recovery detects a
  concurrent modification and returns `manual_required`, ALL artifacts (temps,
  backups, destinations, directories) are preserved for diagnosis. No cleanup
  occurs until the user resolves the conflict.
- **Created directories caveat**: Post-crash recovery never removes
  `manifest.createdDirs` entries because the manifest is untrusted and there is
  no durable proof an empty directory was transaction-created. Harmless empty
  directories may remain after recovery. Live in-process rollback (during
  `executeWaveLanding`) continues removing its trusted in-memory `createdDirs`.

### Manual recovery steps

When recovery returns `manual_required`:

1. Inspect the manifest to identify which paths have conflicts.
2. Compare the current destination with the backup (original content).
3. Decide whether to keep the concurrent modification or restore the original.
4. Remove backup artifacts (`.pi-backup-*` suffix) once resolved.
5. Remove temp artifacts (`.pi-landing-tmp-*` prefix) if any remain.

### No automatic startup recovery

This module does not provide automatic crash recovery on startup. Recovery is
an explicit operation invoked by the caller when a crashed manifest is detected.
