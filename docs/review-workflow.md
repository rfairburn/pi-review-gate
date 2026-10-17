# Review workflow

This page owns the review lifecycle: windows and evidence, reviewer execution,
corrections, transmission, commands, cancellation, telemetry, and retained bundle
layout. Field defaults are owned by [Configuration](configuration.md).

## Review windows and evidence

Each review window uses one stable temporary evidence bundle. Every completed agent run
is appended as a numbered exchange with the evidence available under the selected
method. By default this includes its workspace diff, captured side-effect diff, tool
calls and results, assistant summary, usage, and before/after artifacts. The bundle
also maintains the cumulative baseline-to-current patch where available and numbered
reviewer invocations. Optional [tool-only evidence](#review-evidence-methods) changes
the evidence basis, never reviewer selection or the requirement for a real verdict.

If initialization of a newly allocated temporary bundle fails, all started setup
operations (including nested artifact writes) settle before cleanup. The ownership
contract assumes no hostile external same-user (same-UID) process mutates directories
during allocation/identity capture of either the bundle root or the private cleanup
directory, or during private cleanup. Within that boundary, cleanup removes only that
invocation's positively identified root; caller-supplied bundle directories are never
included. Detected substitutions, symlinks, and failed or unverifiable identity capture
preserve remaining resources and refuse recursive deletion. Deletion uses a private
relocation and rechecks the moved directory identity, rather than recursively removing
the original temporary pathname after a check. Cleanup failures or refusals emit an
explicit unconfirmed-cleanup diagnostic (including the attempted relocation target when
applicable) without replacing the original initialization error. If the filesystem
cannot supply a pinned directory identity, cleanup refuses deletion.

Synchronous allocation/capture and final identity-check/deletion calls prevent
in-process interleaving, not races with external processes. Public Node APIs provide
neither an atomic creation-bound directory handle nor fd-relative recursive deletion.
A hostile same-user process could substitute a directory between `mkdtempSync` and the
first `lstatSync`, causing the replacement to be captured as owned and later recursively
deleted, or mutate the private cleanup directory between verification and deletion.
These races are outside the
ownership guarantee; the identity fences do not make those cases safe. Successful
bundle creation, configured retention of completed bundles, recovery records,
checkpoints, and cache behavior are unchanged; no old temporary directories are swept.

On Pi 1.2 and newer, idle custom-message runs also arm a review baseline through
Pi's `before_agent_start` event, including runs started by other extensions.
Custom runs receive no user-turn prompt-guidance injection. This extension's
scheduled and wake messages retain their authoritative `message_start` attribution
and fallback review arming on older hosts; their settlement semantics are unchanged.

Snapshot-based parent review uses one durable checkpoint mechanism for Git and non-Git
workspaces. Each settlement freezes one after-checkpoint. In a Git checkout, even when Pi starts in a
subdirectory, the parent checkpoint covers the enclosing repository: tracked changes
and non-ignored untracked entries in sibling directories are included, and review
changes and evidence paths within that repository are repository-relative. Pi and
reviewer processes keep the selected subdirectory as their cwd; delegated task capture
and landing remain separate and unchanged. Non-Git review still uses the selected cwd.
The Git checkpoint pins clean committed content and captures both staged and unstaged
Git differences plus raw non-ignored untracked entries. Tracked content follows Git-normalized newline semantics: the checkpoint is
not a raw CRLF reproduction guarantee and does not run a separate EOL proof pass.
Untracked entries, and eligible entries in a non-Git workspace, retain their raw bytes.
An initialized repository with a verified unborn symbolic `HEAD` uses a checkpoint-owned
synthetic parentless commit with an empty tree as its baseline. This does not create the
user's first commit, move `HEAD`, change branch refs, or write the live index; staged,
unstaged, and non-ignored untracked content still follows the ordinary review path.
Corrupt or otherwise unverified `HEAD` state remains fail-closed.
On Windows, checkpoint Git commands use the effective `core.autocrlf` value
without enabling other system/global Git settings. Unreliable worktree-only
executable-bit differences are ignored; staged mode changes remain captured.
For a Windows path stat that omits the volume ID, only that device-ID mismatch
against an open file handle is normalized; other read/race checks remain strict.
For non-Git capture, `.gitignore` patterns apply within their directory subtree; if
any `.gitignore` exists, global Git excludes apply throughout the capture root, while
without one there are no global excludes. Comparisons use the frozen after-checkpoint
against separate window and exchange baselines; a checkpoint is not itself a passing
review or a substitute for either baseline.

### Non-Git checkpoint storage

Non-Git checkpoint records are never written inside a workspace. Every record lives in
the live Pi session's namespace under Pi's agent-data directory:
`<agent dir>/sessions/pi-review-gate/<session id>/checkpoints/` (the agent directory
is `~/.pi/agent` by default, following Pi's `PI_CODING_AGENT_DIR` semantics on every
platform). This applies equally to persisted sessions and to in-memory sessions such
as `--no-session`: review is not disabled because a session has no conversation file,
and no conversation persistence or resumability is enabled for in-memory sessions. The
location never depends on where the conversation file lives (including a conversation
file inside the workspace), and Pi's conversation session-directory setting does not
select it. Git workspaces keep their existing Git checkpoint storage unchanged.

Each record is bound to the live session id, the canonical workspace, the review window,
and a random owner generation. It is published atomically as a private file (POSIX mode
`0600` in `0700` directories owned by the current user), and every publication flushes
each directory entry it depends on, up to the agent directory's own entry, before use.
Above the extension namespace, only a missing agent directory (when its parent exists)
and its `sessions` directory are ever created; otherwise capture fails explicitly. Loading and release re-derive the expected location from the live
session and the current workspace, never from a path stored in persisted state, and
verify the digest, record schema, and binding before any use. A record of another
session or workspace cannot be read, released, or treated as recoverable damage.
Release removes only the verified owner generation; the session namespace, other
workspaces' records, and unrelated or unverified content are never removed, and
cleanup happens only at the existing release points (no extra retention or automatic
garbage collection). Window baselines are retired only after a durable session-state
save, so an in-memory session, which saves no state, keeps those records in its session
namespace, just as they previously remained in the workspace.

For an ordinary project root that neither contains the checkpoint store nor lies
inside it, no checkpoint bytes are written under that root. Delegated task capture of
such a root therefore never sees checkpoint records or counts them against
`maxSnapshotBytes`, and ordinary project files or directories named `.pi-review-gate`
(top-level or nested) are captured and reviewed like any other content. Only the
current record format is accepted: a persisted review window that references an
earlier non-Git checkpoint format fails restore closed rather than being migrated.
Records are located from the agent directory resolved when the session starts; if that
directory changes between restarts, the earlier record is reported as damaged and
review starts fresh from the current workspace.

#### Known limitation: a workspace that overlaps the checkpoint store

The checkpoint store has one location for every non-Git session, with no alternate or
configurable base. This release accepts two limitations when a workspace overlaps it:

- **Non-Git review root.** If the store overlaps the non-Git workspace being captured
  for review (for example `PI_CODING_AGENT_DIR` inside the workspace, or a non-Git
  session started in an ancestor of the agent directory such as the home directory),
  non-Git checkpoint capture fails closed with an explicit unsupported-configuration
  error instead of writing records into the workspace or choosing another location.
  Reviewing such a root is unsupported.
- **Delegated target.** A delegated execution target whose tree contains the store is
  not rejected. Its automatic task capture and downstream snapshots may include
  checkpoint record files, and those bytes count against capture budgets such as
  `maxSnapshotBytes`.

Keeping the Pi agent directory outside review and delegated workspaces avoids both.
Follow-up [#318](https://github.com/rfairburn/pi-review-gate/issues/318) will exclude
exactly this extension's checkpoint record files from automatic and downstream
collection. It will not choose another storage destination, and tool-based evidence
of modifications to those files will still be retained. Record file permissions and
capture-size limits stay as described above.

On Windows, synthetic checkpoint objects are flushed by Git at write time; this
requires Git 2.36.0 or newer, and older versions fail closed. Git and non-Git
checkpoint record files are also flushed, but a directory-handle fsync rejected
with `EPERM` is best-effort: a power loss may lose a newly created directory entry.
Restart verifies the surviving checkpoint rather than assuming it survived.

In snapshot mode, exact `write` / `edit` paths and easy shell targets are pre-captured
before execution, including absolute paths outside the current worktree. Repository baselines,
per-exchange snapshots, pre-captured outside-file baselines, user guidance, tool
evidence, assistant summaries, and reviewer feedback belong to one review window.

A requested correction keeps that window open. In snapshot mode, even when a correction
exactly restores the original baseline, the next reviewer sees the inverse exchange
diff and validates the correction. A passing review is transmitted to the implementing
model as a final review turn with every reviewer's official notes. The pass applies to
the reviewed evidence basis: in snapshot mode, the exact reviewed workspace snapshot;
tool-only review never claims full snapshot coverage. A response that does not introduce
new changes under the selected evidence method closes the window at settlement while
retaining it for an immediate `/ask-reviewer` follow-up. If the implementing model makes
another reviewable change after seeing the passing observations, that response becomes
a new exchange in the same window and triggers another review. Later ordinary work
starts a fresh window under the selected method and does not re-review changes that
already passed.

At cutover, an active pre-checkpoint review window starts fresh with the existing
workspace edits as its new baseline; no earlier verdict is migrated or represented as
a pass on the new window. If a new checkpoint is damaged or cannot be verified, its
evidence is preserved and the user is notified. Review starts fresh from the current
workspace as baseline rather than claiming that edits under the damaged checkpoint
passed. A fresh baseline cannot retroactively certify those earlier edits.

## Review evidence methods

Snapshot evidence remains the default. The independent, default-Off
`review.evidence.primaryToolOnly`, `worktreeToolOnly`, and `inplaceToolOnly` choices
select retained observed-tool evidence for Primary / top-level, isolated worktree,
and InPlace review respectively. They do not disable review, change operating mode,
select reviewers, or remove construction, checkpoint, and landing requirements.
Tool-only omits only filesystem/Git review snapshotting, which can include outside-writer
changes; bounded tool/path/content observations, targeted candidate capture, and reviewer
read-only inspection remain available. It is not a sandbox or a prohibition on reading
files. The [Evidence methods menu](settings.md#evidence-methods) owns staging and apply timing.

Tool-only review follows supported observed calls, their retained content/results, and
associated task context rather than treating every filesystem difference as an agent
edit. For example, a supported tool edit to `SCRIPT` remains review evidence while an
independent generator updates `REPORT`. The reviewer receives the retained `SCRIPT`
content/tool evidence, not a claim that the worker authored every changed file. After
a pass, independent `REPORT` additions alone do not retrigger tool-only review without
new observed changes. A new observed edit still requires review; a summary alone is
not proof of a change or a passing verdict.

This is a narrower evidence basis, not perfect authorship or universal side-effect
coverage. Adapter events can be missing, unsupported, bounded, or truncated;
`run-as-binary` supplies no structured tool events. Missing or unavailable observations
must not block review: present as much retained evidence as collected, disclose adapter
and capture limits, and let the reviewer assess clearly provenance-labelled claims and
context without promoting them to observations. Missing observations are not proof of
clean work or no effects. Shell commands and observations are not a verified diff of
every effect they may cause. Snapshot omissions and tool observation limits remain
explicit, and a tool-only pass does not attest that unseen
files, network/API effects, or concurrent writers were reviewed. InPlace review stays
post-hoc: it cannot prevent or roll back writes or external effects.

Applying Primary Off → On resets the current Primary evidence window with a prominent
warning; the reset is not approval of earlier edits. On → Off retains accumulated
evidence and takes a new snapshot baseline, so it does not reconstruct earlier
snapshot coverage. Unchanged settings, other-scope edits, navigation, and Cancel do
not reset Primary evidence. Workers capture the applicable evidence and fallback policy
at firing/queue admission: each new task in `SubtasksStart` or `SubtasksAdd` captures the
current live choice independently; scheduled tasks capture it at actual firing/admission,
not schedule creation. Already queued and running tasks retain that policy through
corrections, retries, and continuations. Later Add tasks capture the then-current live
choice without reconfiguring in-flight tasks. This pins evidence policy only, not all
routes or reviewer selections.

### Snapshot-failure fallback

`review.evidence.snapshotFailureFallback` is an independent opt-in, default **Off**.
Off leaves snapshot capture failure blocking. On allows an eligible
**review-evidence-only** snapshot capture failure to use retained current tool evidence
instead, with a durable, truthfully labelled tool-only basis. It is allowed even on
the **first Primary or InPlace review-baseline capture before work**: an absent initial
snapshot is disclosed, not fabricated, and actual fallback records its tool-only basis
durably. This is different from losing or corrupting a previously persisted basis.

Every actual fallback emits a prominent warning identifying the originating context
(Primary, isolated worktree, or InPlace) to the user and implementing model, and labels
the reviewer input with the actual tool-only basis and failed snapshot coverage.
Evidence and user/model provenance stay truthful; a worker fallback is not presented
as Primary activity. A settings description, log entry, or optional notice is not a
substitute for this actual-use warning. Fallback neither approves the work nor creates
a snapshot-equivalent verdict: the configured reviewer still has to run and return a
usable result under the ordinary gate.

Fallback is not sticky: when the configured Primary or captured worker policy prefers
snapshots, retry snapshot capture on later review cycles and continuations, warning
prominently on each actual fallback. A later successful baseline cannot fabricate
coverage before it existed or discard retained current-work tool evidence, including
when the first baseline was unavailable. Missing structured observations do not block
degraded review; the evidence and limitations must remain explicit as above.

Fallback cannot substitute tool history for durability. Missing or corrupt persisted
evidence, cancellation, reviewer execution errors, isolated construction input capture,
checkpoint staging/verification, and landing failures remain blocking under their
normal rules. An isolated stage shared with checkpoint or landing may still have to
block even when its output would also have supplied review evidence. Not every error
containing the word “snapshot” is eligible. See
[Recovery](recovery.md#review-evidence-failure-and-fallback) and
[Security model](security-model.md#review-evidence-is-not-a-durability-bypass).

### Manual exercise in an inactive candidate

Use a disposable synthetic workspace and an inactive candidate build, never the
extension, config, or sessions serving an active conversation. Prepare a separate
candidate tree with its dependencies and shipped scripts available as described in
[Development](development.md#build-and-test-commands). Launch Pi directly from the
synthetic workspace with an explicit candidate entry and disposable settings, rather
than using the persistent launcher:

```bash
HOME="$sandbox/home" PI_CODING_AGENT_DIR="$sandbox/agent" \
  PI_REVIEW_GATE_CONFIG="$sandbox/review-gate.json" \
  pi --no-extensions --extension "$candidate/dist/src/index.js" --no-session
```

Here `$sandbox` and `$candidate` are your own disposable absolute directories. Create
the sandbox directories and a test config first; configure only the worker/reviewer
resources intended for this exercise. Do not copy credentials or production session
state into it. Execution/review steps require the selected harness to be available
and authenticated; menu-only checks need no model call.

1. Open **Reviewers → Evidence methods** and verify all four defaults are Off.
   Stage a change, navigate Back/Escape, and verify it has not applied yet. Root
   Escape applies only for this session; reopen and Cancel a different draft to
   confirm the earlier session-only choices survive. Save or nested Ctrl+S persists
   them to the disposable config.
2. Accumulate Primary evidence, then apply Primary Off → On and verify the actual
   reset warning. Reapply unchanged values, change only another scope, and cancel a
   staged Primary change: none resets it. Apply On → Off and verify evidence remains
   with a new snapshot baseline rather than claimed retroactive coverage.
3. With Primary tool-only On, have the agent make a small supported tool edit to
   `SCRIPT`, while an independent generator outside the agent's observed tools adds
   to `REPORT`. Inspect the reviewer input for retained `SCRIPT` content/tool evidence
   and honest provenance. After a pass, let only the generator add more to `REPORT`:
   a no-change agent response must not cause another review solely for that addition.
   Then make a new observed edit and verify review runs again.
4. Repeat the `SCRIPT`/`REPORT` exercise with a new isolated execute worker and a new
   InPlace worker, selecting only the corresponding evidence row each time. Use only
   the synthetic workspace for InPlace: its writes happen immediately, with no rollback.
   Change the live setting while a task is queued or running and verify corrections,
   retries, and continuations retain its admission policy. A later Add captures the new
   choice independently; a scheduled task captures at actual firing/admission. Verify
   missing structured observations permit review with retained evidence and disclosed
   limits, without claiming clean work or no effects.
5. In a controlled test setup that induces only a review-evidence capture failure,
   compare fallback Off (blocked) with On (tool-only review plus the actual origin-correct
   warning and reviewer disclosure). Include a first Primary and first InPlace baseline
   failure before work. Restore capture and verify later cycles/continuations retry
   snapshots without losing retained tool evidence or inventing earlier coverage;
   each repeated actual fallback must warn again. Do not simulate an eligible failure
   by deleting saved evidence or breaking construction/checkpoint/landing: those must
   still block. A capture fault
   that cannot be isolated from durability is not a successful fallback exercise.

## Tool-derived file evidence: coverage and limits

Tool observations supplement the workspace delta; they do not establish authorship.
An observed edit to `SCRIPT.sh` can select that file without selecting independent
`REPORT` files written in the same workspace. The default workspace comparison still
includes those reports as changes since the baseline. Excluding them from that
comparison is not the behavior of tool capture, and neither a matching pathname nor
a capture-time window proves that the session authored every retained byte.

| Execution path | File evidence delivered to review |
| --- | --- |
| Primary Pi session | The native `tool_call` hook pre-captures recognized mutation candidates; `tool_result` retains outcomes, including errors, and bounded post-tool content for tool-only or fallback review. Snapshot mode also uses the frozen workspace checkpoint; tool-only uses retained observations instead of a whole-root comparison. |
| Isolated execution worker | Construction, candidate checkpoints, and landing remain verified independently. Snapshot review uses the candidate-tree diff; tool-only review consumes supported structured observations and bounded candidate content. Adapter transcripts remain inspectable artifacts, not a substitute file-evidence producer. |
| In-place worker | Snapshot review uses the launch-to-current workspace delta. Tool-only review uses supported Pi RPC, Claude Agent SDK, and Codex app-server observations, including bounded in-root and outside-root candidate content. Adapter pre-state is unverified: after-turn observations are not exact diffs or authorship proof. |

The common producer is `src/evidence.ts`; primary hooks live in `src/index.ts`,
isolated candidate review in `src/execution/wave-worker-lifecycle.ts`, and in-place
observation/review wiring in `src/execution/inplace/`. Adapter observation contracts
live in `src/execution/types.ts` and `src/execution/adapters/`. The
[executor evidence index](subtask-evidence.md) is a separate read interface over
retained artifacts, not an additional file-evidence producer.

### Supported observations

- Native `write` / `edit` path arguments and ApplyPatch envelope paths (including move
  destinations) are mutation candidates. Literal shell output redirects and simple
  `tee`, `touch`, `rm`, `mkdir`, `cp`, and `mv` spellings are best-effort candidates,
  not execution receipts. Attached output redirects are recognized; command-like text
  inside quoted data must not select files merely because it contains `touch` or `rm`.
- Pi RPC observation records preserve UTF-8 path bytes across transport chunk
  boundaries. Claude pairs results with recorded tool-use inputs; Codex forwards
  supported command, file-change, and MCP items. Their available shapes and the common
  extractor still limit which effects can become file candidates. Arbitrary MCP tool
  arguments are not assumed to describe filesystem mutations.
- An observed outside-root address that is changed by privacy redaction or retention
  truncation must not be used to read a different file. The sanitized event remains
  evidence and the unavailable path observation is disclosed; it is not a verified
  missing file or a clean effect. Safely retained addresses can still receive bounded
  after-turn content under the existing in-place policy. Generic adapter arguments
  remain bounded and redacted evidence, not inferred filesystem targets. Omitted
  fields, values, nested data, or unsupported reflection are explicitly incomplete
  and require review. New incomplete observations advance the existing observation
  revision so a prior pass or no-progress comparison cannot cover later unknown scope.
- Failed calls remain evidence. ApplyPatch can successfully edit one file before a
  later operation fails; the earlier file change must survive review capture. An
  overall error is neither proof of no effects nor proof that every requested target
  was touched.

### Remaining uncertainty

Shell candidates are lexical hints, not a shell interpreter: conditional branches,
command substitutions, variables, cwd changes, recursive or multiple-operand commands,
interpreter scripts, and PowerShell-specific syntax may be missed or over-selected.
For example, `false && printf x > REPORT` names a target but does not write it;
an independent later writer can still change that candidate. Relative targets after
`cd` may resolve differently from the collector's original cwd. Neither situation
licenses an authorship claim or a universal command-side-effect guarantee.

Candidate comparisons and outside-root after-observations occur later than the tool
operation. Another writer can replace the same path before collection, so retained
current content need not equal the bytes written by the observed operation. Symlink
snapshots retain link identity/target spelling rather than automatically following
write-through mutations to target bytes. Binary/oversized/unreadable content,
observation limits, unsupported tool contracts, missing events, and the opaque
run-as-binary protocol remain limitations, not evidence of no changes. More accurate
review evidence does not replace input/worktree capture, checkpoint verification,
process settlement, recovery, or safe landing.

## Live browser during review

Automatic reviews, `/review-now`, and `/ask-reviewer` settle model work without closing,
pausing, or suspending the Pi session's browser. Page scripts and permitted network
activity can continue during review; a passing review is not an attestation of zero
browser resources or absence of later web effects. The same session/tab handles work
in later turns. Use `BrowserClose` to stop those effects explicitly. Terminal session
shutdown/replacement/reload still closes browser resources. See
[Interactive browser](browser.md#interactive-browser) for limits and closure behavior.

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

The foreground [pending-input popup](user-questions.md#shared-pending-panel-and-list)
(question or notice) owns Escape before review cancellation: it performs only the
popup's existing close, back, or native completion-dismiss action. An automatic or
command-driven review underneath continues unchanged to its real verdict. After the
popup closes, a separate Escape, even immediately afterward, cancels normally.
Pending input without a foreground popup does not suppress cancellation.

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
silently. `/review-cancel` explicitly cancels whichever automatic or command-driven
review is currently active and immediately acknowledges the cancellation request.
Completion waits for the review run to return after bounded teardown. It reports
`reviewer processes stopped` only when the owned reviewer launches have positive
process-settlement evidence; when cleanup cannot be confirmed, it instead reports
`reviewer process termination unconfirmed; cleanup uncertain; owned processes may remain live`.
The same distinction applies to Escape, `/review-now`, and reviewer-question
cancellation. A sent signal, a returned teardown promise, or root exit alone is not
confirmation. This does not strengthen process-tree termination guarantees or extend
teardown deadlines. Termination diagnostics remain on the cancelled result and in
`canceled.json`, without retaining partial reviewer verdicts or copying reviewer
content or private paths into the completion notice. With no review running,
`/review-cancel` reports that clearly instead of pretending to cancel.

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
  press Escape/Ctrl+C to clear it without sending anything. In the interactive Pi TUI
  the answer opens in the host's own main-prompt editor through the shared native
  editor field (issue #26), with the same native filesystem suggestions for
  first-line leading-`/` tokens (never slash-command items); on non-interactive hosts
  the public multi-line editor is used, and a host without an editing surface
  delivers the answer as a notice instead of staging anything.

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
invocation contains `CANCELED.md` and `canceled.json` (including process settlement and
any termination diagnostic) rather than reviewer results.

Retention itself is governed by `retainBundles`; see
[Configuration](configuration.md#top-level-fields). Shutdown behavior and what survives
a restart are owned by [Recovery](recovery.md).