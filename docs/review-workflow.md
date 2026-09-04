# Review workflow

This page owns the review lifecycle: windows and evidence, reviewer execution,
corrections, transmission, commands, cancellation, telemetry, and retained bundle
layout. Field defaults are owned by [Configuration](configuration.md).

## Review windows and evidence

Each review window uses one stable temporary evidence bundle. Every completed agent run
is appended as a numbered exchange containing its snapshot-derived workspace diff,
captured side-effect diff, tool calls and results, assistant summary, usage, and
before/after artifacts. The bundle also maintains the cumulative baseline-to-current
patch and numbered reviewer invocations.

Exact `write` / `edit` paths and easy shell targets are pre-captured before execution,
including absolute paths outside the current worktree. Repository baselines,
per-exchange snapshots, pre-captured outside-file baselines, user guidance, tool
evidence, assistant summaries, and reviewer feedback belong to one review window.

A requested correction keeps that window open. Even when a correction exactly restores
the original baseline, the next reviewer sees the inverse exchange diff and validates
the correction. A passing review is transmitted to the implementing model as a final
review turn with every reviewer's official notes. The pass certifies the exact reviewed
workspace snapshot. A response that does not change the workspace or create a meaningful
persistent side effect checkpoints and closes the window while retaining it for an
immediate `/ask-reviewer` follow-up. If the implementing model makes another change
after seeing the passing observations, that response becomes a new exchange in the same
window and triggers another review. Later ordinary work starts a fresh window from
current file contents and does not re-review changes that already passed.

## Live browser during review

Automatic reviews, `/review-now`, and `/ask-reviewer` settle model work without closing,
pausing, or suspending the Pi session's browser. Page scripts and permitted network
activity can continue during review; a passing review is not an attestation of zero
browser resources or absence of later web effects. The same session/tab handles work
in later turns. Use `BrowserClose` to stop those effects explicitly. Terminal session
shutdown/replacement/reload still closes browser resources. See
[Interactive browser](web-tools.md#interactive-browser) for limits and closure behavior.

## Reviewer execution

Every built-in Codex, Claude, and Pi review pass starts a fresh CLI session. Correction
context comes from the stable evidence bundle rather than accumulated model/tool
history, avoiding reviewer compaction across passes. Correction reviewers begin with the
original task evidence, latest correction exchange, immediately preceding findings, and
current files. Complete earlier history remains available for targeted inspection but is
not read by default.

Codex, Claude, and Pi reviewers receive a compact prompt pointing to the bundle's
`REVIEW.md` entry point and inspect the evidence with read-only tools. The generic CLI
adapter retains the inline prompt as a compatibility transport and also receives the
bundle path in `PI_REVIEW_GATE_BUNDLE_DIR`. Read-only enforcement per adapter is owned by
the [Security model](security-model.md#read-only-enforcement).

Codex starts in its `read-only` sandbox and receives a native output schema on the
initial turn. A local no-op sandbox preflight detects platform sandbox startup failures
before a model turn is spent.

Reviewer output is parsed strictly first; a narrow fallback recovers the same schema
when a model emits an actionable non-passing result with unescaped multiline Markdown.
A passing verdict is never accepted through repair. Sandbox startup failures remain
explicit reviewer errors rather than being mislabeled as verdict-schema failures.

Reviewer/executor stdout and stderr are retained up to 100 MiB per stream for
diagnostics; JSONL protocols are decoded incrementally with separate bounded records, so
protocol correctness does not depend on display capture truncation.

## Reviewer direction policy

The reviewer treats orchestrator-provided task direction as authorized and reviews
concrete logic, regressions, security, API behavior, tests, and explicit acceptance
criteria. It must not request changes merely because an implementation choice was not
separately requested by the user. Targeted tests are expected in delegated correction
loops; absent an explicit task criterion or a concrete cross-cutting risk, a full-suite
run is a non-blocking final-orchestration note.

## Corrections, guidance, and the correction cap

`implementationGuidanceAfterCorrectionAttempts` controls when every review path
strengthens its request for concrete implementation guidance. The default is `1`:
reviewer responses are implementation-ready from the start, and after one correction
attempt the next automatic review, `/review-now`, or `/ask-reviewer` first verifies
historical findings against the current workspace. For only those problems it
independently confirms still remain, it explicitly requires a concise prose defense plus
a concise, directly applicable implementation diff showing exactly what code the
reviewer expects for the finding to pass. The diff may be as complete as necessary and
does not have to be minimal. Genuinely non-code findings require exact actionable steps
and a defense of why they are sufficient. This guidance stays inside the structured
response's Markdown `guidance` field and is rendered under the review's Guidance
section; the Summary, Issue, and Recommendation fields keep their existing formatted
layout. The presence of prior feedback is not treated as proof that the correction
failed. Set the value to `0` to apply this conditional verification and
concrete-guidance requirement on the first review. There is no separate disabled value;
use a threshold higher than the configured correction budget to prevent threshold
escalation while retaining the normal implementation-ready prompt.

Reaching the automatic correction cap does not hide reviewer information. The complete
pass is transmitted with correction classified as deferred.
`/review-continue` authorizes the last capped feedback for correction and resets the
correction counter using a compact authorization message that references the
already-delivered pass instead of repeating its reviewer results, so the configured
correction budget is available again. Reaching the cap does not accept or checkpoint the
changes. Normal user guidance also remains in the same unresolved window unless that
window later passes.

If you send normal guidance while the reviewer is still running, the extension holds
that input locally until the review finishes. When the reviewer requests changes,
reviewer feedback is queued first, then your held guidance is queued after it in the
same order you typed it.

## Transmission

Each completed review pass stores `implementing-model-transmission.md`, its structured
JSON envelope, and additive `delivery.json` receipts recording exactly what the
implementing model was told and whether the transmission required correction, reported a
pass, deferred action, or disclosed a review error. Later reviewers start with the
immediately preceding record and consult older records only when the latest correction
evidence requires it. The envelope contains the gate verdict and the individual reviewer
results; no unsent aggregate result is persisted.

## Reviewer status and telemetry

Codex CLI, Claude CLI, and Pi reviewers stream bounded native lifecycle and read-only
tool activity into ordinary review status and delegated-subtask activity views without
exposing reasoning contents or reviewer output. Generic CLI reviewers expose
start/finish status because their protocol has no structured intermediate event stream.
Foreground automatic reviews, `/review-now`, and reviewer-question commands show the
active reviewer milestone and elapsed time in the status line until the review completes
or is cancelled.

Per-pass `review-telemetry.json` records prompt and stream bytes, tool-call and
tool-result volume, wall time, token usage, compaction events, and whether session reuse
occurred; it measures behavior without imposing a token budget. When supported by the
reviewer CLI, user-facing notices include a compact reviewer token summary, for example:

```text
review gate: passed (review tokens (this pass): input 1.2k (uncached 400, cached 800), out 340, total 1.6k)
```

The Pi model adapter stores the extracted final review in `raw-output.txt` and the
capped JSONL stream separately as `raw-stream.jsonl`.

## Cancellation

Canceling a running review with Escape cancels the whole parallel review, even if one
reviewer has already completed. Escape is recognized in legacy terminals (raw ESC) and
in Kitty-keyboard-protocol / CSI-u and xterm `modifyOtherKeys` terminals, where
unmodified Escape arrives as `\x1b[27u`-style sequences; Escape key-release events and
modified Escape (shift/alt/ctrl + Escape) are ignored. Partial results are discarded and
are not transmitted. The numbered invocation remains as a `CANCELED.md` tombstone
stating that a review would have run there but was canceled by the user, so pass order
remains unambiguous. The next review keeps the same evidence bundle but starts fresh
reviewer sessions.

If the terminal input interception cannot be installed in the current context, the
extension says so once and points at the `/review-cancel` command instead of failing
silently. `/review-cancel` is the guaranteed hard stop: it cancels whichever automatic
or command-driven review is currently active, immediately confirms the cancellation
request, and only reports the review cancelled once the review run has returned and all
reviewer child processes have stopped. With no review running it reports that clearly
instead of pretending to cancel.

## Commands

- `/review-clear` discards the active or retained review window, including its baseline,
  request history, captured evidence, prior reviewer feedback, held correction feedback,
  and queued user input. The next ordinary prompt starts a fresh window from the
  workspace's current contents. It does not revert files or override bundle retention:
  bundles continue to be retained or removed by the configured `retainBundles` policy,
  and already-retained bundles remain governed by that policy. Reviewer sessions are
  never reused between passes. If a review is currently running, cancel it first and
  then run `/review-clear`.
- `/review-now` reruns the configured reviewer or reviewers against the active review
  window's baseline and evidence. Its complete result is transmitted to the implementing
  model. A pass closes only after the implementing model responds without changing the
  reviewed state.
- `/review-pause` suppresses automatic and explicitly requested reviewer runs without
  stopping evidence collection. Each primary-model turn is still captured as a separate
  exchange. `/review-unpause` resumes reviewer execution; the next eligible turn reviews
  the accumulated changes and evidence. `/review-now` and `/ask-reviewer*` remain
  unavailable while reviews are paused.
- `/review-cancel` — see [Cancellation](#cancellation).
- `/review-continue` — see [Corrections](#corrections-guidance-and-the-correction-cap).
- `/ask-reviewer <question>` asks the configured reviewer or reviewers an ad hoc
  question about the current work. It includes the current request context, changed
  files and patch when available, and the session evidence digest, including read-only
  tool-call activity and the primary agent's final summary. This makes it useful after
  planning-only turns as well as after edits. Immediately after a passing review, it can
  still use that passed window's patch and evidence; a regular prompt starts a fresh
  window instead. At the automatic correction cap it also includes the prior reviewer
  results, the deferred transmission, and any later `/review-continue` authorization
  from the same unresolved review window.
- `/ask-reviewer-interactive <question>` uses the same reviewer, session, evidence,
  answer formatting, two-stage interruption, and acceptance path, but opens the answer
  in an editable prompt first. Press Enter to submit it, edit it first if needed, or
  press Escape/Ctrl+C to clear it without sending anything.

`/ask-reviewer` uses a two-stage interruption when the implementing model is in a turn.
It first steers a hold instruction that tells the model not to call more tools or modify
more files. Any tool calls already issued in the current assistant batch may finish
before steering is delivered. Once that turn ends and its exchange is captured, the gate
asks the reviewer against the stable workspace and steers the resulting note into the
next model step. Escape remains available when an immediate hard stop is required.

Submitting either command accepts the question and the exact submitted reviewer note
into structured session evidence. Later automatic reviews, `/review-now`, and
reviewer-question calls in the resulting review window receive the accumulated accepted
Q&A, including preserved Markdown and fenced code. Clearing the editor does not accept
or record the answer. When a question follows a passing review, its accepted Q&A is
carried into the new review window created for the submitted reviewer note without
reusing the already-checkpointed file baseline.

## Retained bundle layout

Retained review bundles include `REVIEW.md`, `manifest.json`, `request.md`, a
`current/` cumulative view, immutable `exchanges/<sequence>/` evidence, numbered
`reviews/<sequence>/` and `questions/<sequence>/` invocations, `sessions.json`, per-pass
`review-telemetry.json`, and captured before/after artifacts. Reviewer outputs remain
isolated under each invocation's `reviewers/<id>/` directory. A canceled numbered
invocation contains `CANCELED.md` and `canceled.json` rather than reviewer results.

Retention itself is governed by `retainBundles`; see
[Configuration](configuration.md#top-level-fields). Shutdown behavior and what survives
a restart are owned by [Recovery](recovery.md).