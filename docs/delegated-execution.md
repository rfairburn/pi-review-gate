# Delegated execution and background tasks

This page owns delegated execution: the subtask tools, worker resources and routes,
capture and landing behavior, conflicts, steering, notifications, background shell
tools, and the external executor protocol. Field defaults live in
[Configuration](configuration.md); crash and restart behavior lives in
[Recovery](recovery.md).

## Subtask tools

With at least one worker resource selected, the extension exposes one exact-schema tool
per operation: `SubtasksStart`, `SubtasksAdd`, `SubtasksInspect`, `SubtasksWatch`,
`SubtasksContinue`, `SubtasksSteer`, `SubtasksInterrupt`, `SubtasksForceMerge`, and
`SubtasksMarkClean`. No singular or snake_case compatibility tool is registered.

- `SubtasksStart` accepts an optional immutable group-level `kind`: `execute` (the
  default) or `research`.
- `SubtasksStart` also accepts an optional top-level `workspace` string selecting
  an existing, explicitly authorized development checkout or Git worktree as the
  group's capture and landing destination. Omitted or blank uses the parent
  session's working directory, preserving the default behavior; relative paths
  resolve against that same parent session's working directory. The target is
  resolved once at start (it must already exist; the extension never creates,
  clones, checks out, or repurposes directories) and persisted with the group:
  every capture, reviewed landing, restore, continuation, and recovery path uses
  that target, `SubtasksAdd` inherits the group's target, and steering never
  retargets it. The target is a landing destination, not worker scratch: each
  task still receives its own isolated worktree captured from the target, several
  workers may independently land reviewed changes into the same target, and
  separate groups may target different repositories concurrently under the
  unchanged shared global capacity limits. Parent-session identity checks remain
  in force independently of the selected target, and a landing into a target
  other than the parent session's workspace never enters the parent review
  baseline.
- Start and add accept 1–16 bounded tasks and return stable execution/task handles
  immediately. Work continues in the background up to the configured global and
  per-model capacities.
- Each task owns its capture, worktree, session, checkpoint, review, and landing
  outcome; there is no wave-wide shared base or all-workers integration barrier.
- Research tasks skip review and landing, validate that their private worktree stayed
  unchanged, and finish as `reported` with a durable report path.
- `SubtasksContinue` accepts either an associated task handle or a verified reattachment
  bundle.
- `SubtasksInspect` requires an explicit `taskId`, even for single-task executions; it
  is never inferred from group size, and an omitted ID fails immediately with a concise
  actionable diagnostic in both activity and evidence modes. The execution-wide overview
  remains available without a task handle: start and add results list every task handle
  in the group, operations that fail after input validation return the complete group
  inspection — except read-only evidence-navigation selector failures (a mistyped
  `entryId`, unknown `callId`, malformed or expired `cursor`, or out-of-range `index`),
  which return a concise task-scoped diagnostic with a bounded navigation hint and never
  other executions' state — and `/subtasks` and `/subtasks-view` show all groups and
  active tasks.
- `SubtasksWatch` optionally arms one future checkpoint for an active execution. It
  returns immediately, replaces any prior watch for that execution, and wakes once with
  active-task state, timing, recent activity, executor identity, and available controls
  if work is still active at the deadline. An earlier completion, failure, conflict, or
  recovery notification cancels the watch; another checkpoint must be explicitly
  rearmed, so this never becomes a polling loop or recurring heartbeat.

User analogs are available as `/subtasks` and the `/subtask-*` commands for inspect,
add, steer, interrupt, force-merge, and mark-clean. These commands open interactive
execution/task and action pickers when handles are omitted; their explicit-handle forms
remain available for scripting.

## Pi worker settlement and browser ownership

Pi workers keep one live browser across their completed turns, including resumed turns
while background work remains active. The extension publishes a version-2 authenticated
**model-settlement receipt**, not a browser-quiescence receipt. It binds the child PID,
child/session identity, and monotonic settlement generation; signatures and one-shot
consumption prevent stale or forged completion. Legacy zero-browser-resource receipts
and bootstrap names are not compatible. RPC `agent_end` and process exit alone are
still insufficient evidence of successful model settlement.

Terminal worker shutdown closes the browser, and the parent adapter awaits process exit
before returning completion for capture/review. After closing stdin, it allows a separate
15-second terminal cleanup deadline (covering the browser's 5-second close phase,
5-second late-containment drain, and exit overhead), independent of the model execution
deadline. Exceeding that deadline fails completion and escalates process termination.
Task interruption through `SubtasksInterrupt` is terminal rather than a claim that a
settled turn has no live browser. Native turn interruption through
`SubtasksSteer` with `interrupt: true` keeps the task and browser alive. Executor extension reload or session
replacement is unsupported: shutdown retires the receipt identity, and the erased
bootstrap is not reconstructed from environment, session history, or old receipts.
The replacement runtime blocks tools and cannot acknowledge completion; restart that
worker with a fresh parent-issued identity. Normal top-level Pi reload remains supported
and closes its old browser before creating a new runtime.

## Worker resources, routes, and concurrency

Fresh tasks scan their `execution.routes.execute` or `execution.routes.research`
ordering and use the first eligible `workerResources` entry with remaining shared
capacity. The two priorities are independent subsets: either route can exclude a
resource, and per-route reasoning lets the same local model use different effort without
creating a second capacity bucket.

When `/review-settings` switches a resource to a different model, the previous model's
reasoning is discarded for that resource's retained route entries — the model and its
reasoning go hand in hand, even when the new model supports the prior level — and each
entry takes the new model's own configured or pinned reasoning, otherwise that model's
supported default (the single valid level for single-level models and `off` for models
without configurable reasoning). Switching to an external agent drops the Pi reasoning
override because the agent owns its configuration, and other resources' route overrides
are untouched, so a model switch never leaves an unsupported or stale level behind and
needs no second manual configuration step.

`config.execution.maxWorkers` controls concurrent workers (1–16, default 4); there is no
parallelism toggle or per-tool override. Task count is independent, and excess tasks
queue. The sum of resource capacities may exceed `maxWorkers`; it describes available
fallback capacity, not the number of workers that must run. Thus a one-slot local
primary cannot run one execution and one research worker at the same time, while
lower-priority cloud entries can absorb overflow.

Worker routes and reviewers are independent:

| Reviewers | Execution route | Behavior |
| --- | --- | --- |
| selected | non-empty | delegated execution with the full review/correction loop |
| none | non-empty | delegated execution returns `completed_unreviewed` |
| selected | empty | automatic parent review only |
| none | empty | settings remain available; both behaviors are off |

## Capture and ignore policy

Each dispatched task captures the source workspace independently. Non-ignored untracked
files are included. Git-ignored files are excluded from capture and landing. This means
dependencies installed in `node_modules`, secrets in `.env`, and other ignored paths are
not captured or landed. If your task depends on files that are git-ignored, the worker
will not see them. Files known to Git through `HEAD` or the index are always captured
regardless of repository size.

During task capture, `maxSnapshotBytes` limits only the cumulative size of non-ignored
untracked files (50 MiB by default). For ordinary serial review snapshots, the same
setting continues to bound the textual file content retained for diffing. Ordinary
snapshots stream files once to retain an exact SHA-256 identity. Recognizable archives,
executables, media, fonts, PDFs, and other binary data are classified from content
signatures with a binary-content fallback; their bytes are not retained or decoded for
textual diffs, and filename extensions alone never determine classification.

## Landing and source preservation

**Independent landing**: As soon as one task is accepted, it acquires the short
source-mutation lease, replans against current main (the group's selected workspace,
or the parent session's working directory when no `workspace` was supplied), and
attempts to land. It does not wait for, integrate with, or roll back a sibling. A
completed landing immediately frees capacity, and `SubtasksAdd` can top the execution
group back up. The landed changes remain uncommitted; source HEAD, index, staging
state, and stash are preserved.

**Source preservation**: Landing never changes source HEAD, index, staging state, or
stash. Final filesystem mutations are serialized and rollback-protected. Absolute
source-workspace paths in task and correction text are remapped to the worker worktree,
and executor `PWD` is set to its actual isolated cwd. Clean worktrees are removed after
completion; dirty or conflicted worktrees are preserved for diagnosis. This is worktree
and instruction isolation, not an OS sandbox — see
[Security model](security-model.md#isolation-limits).

## Conflicts and gates

A clean accepted task lands immediately. On a three-way conflict, clean paths are
applied and ordinary diff3 markers are materialized for the conflicting text paths in
the target workspace. A durable critical gate then blocks every later landing into
that target, identifies the owning task and paths in `SubtasksInspect`, and injects a
priority instruction on every matching orchestrator turn. When separate groups target
different repositories, each target keeps its own independent gate: concurrent
conflicts retain their own block, inspection entry, and cleanup, and resolving one
target never releases another target's block. After resolving the files, use
`SubtasksMarkClean`; it verifies that markers are gone in every outstanding gate
before clearing any of them, checkpoints each resolution (only for gates on the
parent session's own workspace), clears the gates, and wakes queued landings.

**Interrupt and force merge**: `SubtasksInterrupt` explicitly chooses failure or merge
disposition. A normal cancellation uses `interrupt_as_failure`; `interrupt_with_merge`
must be requested explicitly. `SubtasksForceMerge` operates only on a stopped task with
an accepted commit or verified checkpoint; `mergeAnyhow` may deliberately install
ordinary conflict markers in main. Both `interrupt_with_merge` and every direct force
merge are mechanical landing attempts, not verification that the requested changes are
present or correct. The main workspace must always be inspected manually afterward,
including when the task's authoritative state is `landed`.

## Steering, continuation, and failure handling

`SubtasksSteer` is valid while a task is queued, starting, in a live executor turn, or
being reviewed. Queued instructions are durable, live instructions use the adapter's
acknowledged transport, and a steer during review cancels that review and resumes the
executor with the changed request before a fresh review. If the current adapter cannot
steer a long-running command, the instruction waits for that next executor handoff
instead of being reported as rejected.

`SubtasksSteer` accepts an optional `interrupt` boolean (omitted or `false` preserves
the behavior above). When `true` on a live executor turn, the adapter first aborts the
active **turn** and then delivers the instructions to the same task, session, and
workspace; the acknowledgement covers the verified interruption plus transport
acceptance of the replacement turn — it never awaits the replacement turn's
completion, so a follow-up steer can target the still-running replacement. The flag
never cancels, lands, or terminates the task, and `SubtasksInterrupt` keeps its
separate terminal semantics. Queued or starting tasks retain the instructions for
startup or the next executor handoff without claiming a native interruption.
An available idle executor can accept the instructions without interrupting a turn;
steering during review uses the existing review-to-executor handoff. Adapters that cannot interrupt an in-flight turn report a concrete
unsupported status as a failed steering acknowledgement instead of acknowledging a
queued delivery as an interruption.

Stopped tasks retain verified checkpoints and reattachment bundles for
`SubtasksContinue` or `SubtasksForceMerge`.

**Failures, retry, and recovery**: Executor failures are checkpointed to a protected
recovery ref before bounded retry. If same-executor recovery is exhausted, a verified
checkpoint may be handed to the next lower-priority pool entry; that adapter starts a
new native session in the same isolated worktree, so different providers and CLI
harnesses can take over without pretending to share conversation state. A failover is
announced explicitly in the activity stream, recorded durably in the operation's
assignment history, and every later turn — corrections, steering, pass confirmation,
and continuations — follows the successor that actually served the previous turn. The
full recovery story — compaction lifecycle, protected refs, restart behavior, and the
`recoverLandingManifest` API — is owned by [Recovery](recovery.md).

Every failed or non-landed execution-tool operation returns the complete group and task
inspection: durable handles, current source disposition, commands and acknowledgements,
incidents, checkpoint/bundle data, artifact paths, conflicts, and concrete recovery
actions. The one exception is a read-only evidence-navigation selector failure on a
valid, authorized `taskId` (a mistyped `entryId`, unknown `callId`, malformed or expired
`cursor`, or out-of-range `index`): that error returns a concise task-scoped diagnostic
with a bounded navigation hint and never the unrelated executions' inventory, IDs,
titles, artifact paths, or recovery history. Otherwise this state remains inspectable
after compaction or an exact-session restart. Only `landed` means that worker changes
reached the source workspace.

## Subtask evidence

`SubtasksInspect` accepts an optional `evidence` selector that reads a task's bounded,
indexed executor evidence instead of the legacy activity window. The two interfaces are
mutually exclusive: combining `evidence` with `offset`/`lines` is a hard error, and
legacy activity behavior is unchanged when `evidence` is absent.

Evidence indexes only authorized per-task artifacts under the task's wave root: executor
session files (Pi) or per-turn raw streams (Claude/Codex/binary), final responses,
process results, the durable operation record, completed review cycles, and the latest
review report. Every source
that is missing, unreadable, unsupported, or truncated appears as an explicit
`unavailable` note; nothing is invented to fill a gap, and no caller-supplied path can
widen the read boundary (symlinks and path escapes are refused). For a Pi turn whose
session file is missing, that turn falls back explicitly to its own stdout stream and is
never double-counted from both.

Retained Claude and Codex streams are indexed with adapter-specific honesty. Claude
tool calls and results pair by the stream's real tool ids (a call without an observed
result stays `in_flight`), and entries carry the stream's own timestamps for display —
the SDK marks them display-only, so source ordering keeps its artifact basis. Modern
retained Codex app-server streams carry stable item ids: started/completed pairs link
by that observed identity, scoped to the source stream (one retained stream is one
app-server session) — the pairing decision stays with that stream's parser, so
snapshot-wide id matching never re-pairs these entries across ambiguous duplicates or
different sources; older id-less captures keep conservative positional pairing only
while unambiguous, a missing id never matches an observed one, and overlapping or
mismatched items stay unpaired rather than guessed. A call read for such an id reports
only a validated pair: a single unlinked entry stays honestly unpaired, and an id
shared by several unlinked entries is refused explicitly instead of guessing. Item types and command-result
fields are accepted in both observed serializations (camelCase and snake_case). When a
turn's process-result.json does not record its adapter (in-flight or incomplete turns),
a readable raw stream is indexed only when the durable operation record's canonical
per-turn evidence — the attempt that ran the turn and the assignment that served it —
establishes that turn's own adapter; the record's current adapter field describes only
its latest assignment, so an earlier turn is never relabeled with a later executor, and
a stream whose adapter cannot be established from durable evidence stays explicitly
unavailable. Disclosed indexing carries an explicit `adapter_from_operation_record`
note. An empty search over indexed evidence reports zero matches and remains distinct
from genuinely missing or unsupported sources.

Each entry carries a stable `entryId`, timestamp, kind, tool name, status, and
provenance. Provenance separates what an executor process observed
(`executor_observed`) from what a worker wrote in its final response (`worker_claim`,
which never implies verification) from reviewer verdicts (`reviewer_verdict`). Tool calls
and results are paired by real call ids; a call without an observed result stays
`in_flight`, which is never evidence of success. Private model reasoning (Pi thinking
blocks, Codex reasoning items) is excluded from every view, and all retained content is
redacted before search or display. Entry previews stay compact (whitespace-collapsed
and bounded); deep reads are distinct from previews and preserve the retained text's
own whitespace — newlines, indentation, tabs, and blank lines — so multiline YAML,
source code, diffs, and command output arrive readable, with continued chunks
reconstructing the retained content exactly and truncation/continuation explicit.

Completed review cycles are persisted as official records under the task's artifact
directory (`reviews/<waveId>/cycle-NNNN.json`, one per cycle, numbered to match the
immutable per-cycle review alias) at the moment each cycle completes — so a
`needs_changes` verdict and its findings (stable finding ids, severity and blocking
status, location, and recommendation, plus the reviewer's summary and guidance) are
inspectable through `find`, `filter: "review"`, and deep reads while a worker is actively
correcting, before any final task result exists. Each cycle also contributes lifecycle
entries: before settlement, no cycle is asserted to be definitively current — the
newest readable cycle is presented as the latest available review evidence with unknown
completeness (a later cycle's record could have failed to publish without leaving a
trace), and every earlier cycle is explicitly marked as superseded, so a historical
blocker is never presented as the current verdict while both remain searchable. When no completed review evidence exists at all (a review
in flight, or a disabled or unreviewed run), evidence reads report an explicit
`review_unavailable` note instead of a silent empty success; unreadable, malformed,
oversized, foreign-task, or symlinked cycle records are likewise refused with per-file
notes and never indexed. If a completed cycle's record fails to publish, the lifecycle
best-effort leaves an explicit marker (`cycle-NNNN.json.unpublished`) beside the missing
record carrying the official gate verdict, summary, and a bounded failure reason: that
cycle counts toward review completeness and its verdict stays visible through its
lifecycle entry, but its per-reviewer findings are not readable because no durable record
exists, and the marker itself is refused with an explicit note when it is malformed or
foreign. When a later unusable sibling — an unreadable or refused record, or a
publication-failure marker — exists before settlement, its lifecycle entry and the
context summary say the newest readable cycle cannot be confirmed (or name the
superseding unpublished cycle when the marker identifies one), rather than presenting a
possibly superseded verdict as the current one. If both writes fail under a shared fault
such as ENOSPC or directory permissions, no trace of the completed cycle exists at all,
and the same conservative qualification applies: the newest readable cycle is latest
available with unknown completeness until settlement. Once a final
result with a review report exists, it is reconciled with the durable cycles by review
identity: cycle persistence is best-effort, so when the latest cycle's record is missing
or unreadable (or left only as an explicit publication-failure marker) the report covers
a newer review than every usable durable cycle and is indexed — with
each earlier cycle marked superseded by the final report — so a later official pass is
never hidden behind an older persisted blocker. When the durable cycles already cover the
report's latest review, the report is not counted twice. Reads are bounded: per-entry and total byte budgets,
a bounded tail byte window per source (only the newest bytes of each stream are
scanned, so evidence appended beyond any fixed offset stays reachable; earlier bytes
and the boundary record are disclosed as `scan_budget`), a global rolling entry window
that retains the newest entries across all sources (`records_omitted` when older ones
overflow), and a shared raw retention budget across all sources that evicts the oldest
retained content first — releasing it immediately — so discovery memory stays bounded
no matter how many artifacts exist. Directory enumeration applies its bound during
iteration, before the whole directory is allocated. Every bound reports an explicit
`unavailable` note or `truncated` marker instead of cutting silently.

Navigation follows the same block model as the web tools. Each object below is a
complete `SubtasksInspect` argument value — the registered schema has no `action`
field, because each operation has its own exact-schema tool:

```jsonc
// Find a failure across all indexed evidence (case-insensitive, redacted view)
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "find": "E2E-FAILURE-MARKER" } }

// Page the index; nextIndex continues the range. Unfiltered reads also return a cursor.
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "index": 0, "limit": 20 } }

// A later turn: continue from the cursor to receive only newer evidence. Cursors are
// watermark-scoped per source and carry a chained digest of every covered record,
// salted with the opened file's generation (device/inode/birth time); they are rejected
// explicitly when a covered source is missing, atomically replaced — even with an
// identical covered prefix — or any covered record was rewritten. Appends to the same
// file preserve the generation and continue exactly once (no silent skip, duplicate,
// or stale continuation).
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "cursor": "ev1.…" } }

// Deep-read one large entry in bounded chunks; the chunk text preserves the
// retained content's own newlines, indentation, tabs, and blank lines (redaction
// and retention caps excepted), and continued chunks reconstruct it exactly.
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "entryId": "turn:0001/line:12", "chunkIndex": 0 } }

// Resolve one call and its paired result by real call id
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "callId": "toolu_…" } }
```

`filter` narrows a range to `tool_call`, `tool_result`, `command`, `lifecycle`,
`claim`, or `review` entries (filtered reads do not issue cursors). Evidence reads also
return the authoritative context: current task state, assignment history and current
selection, steering acknowledgements, changed files with honest landing status, and the
latest review verdicts. The artifact root is validated against the authorized wave root
before anything under it is read (a symlinked or moved artifacts directory is refused,
never followed), and the operation record informs that context only when it is a
regular file inside that verified directory, fits the bounded context size, belongs to
this task, and records an artifact directory that verifies as this task's; every other
case is reported as an explicit unavailable note rather than read unbounded or trusted.

The collapsed tool card summarizes each read at a glance. The call line names the task
and the effective mode using safe selectors only — `status` for a plain inspection, the
activity offset for legacy paging, `find "<query>"` with an optional `filter`, the
requested `entries start..end` window, the entry handle plus chunk for deep reads, the
call handle for pair resolution, or `cursor continuation` (opaque cursor tokens are never
displayed) — and query/selector text is redacted before display. The result line reports
the operation-specific outcome instead of scheduler boilerplate: the returned entry range
with its provenance mix and retention-truncated entries, match totals with list
truncation, call/result resolution (`returned`, an observed result with unresolved
pairing, or in flight with no result observed), deep-read chunk size and continuation,
or the newer-entry count for cursor reads — plus available continuations (`nextIndex`,
incremental cursor) and important unavailable notes such as missing tool evidence.
Retained content, entry previews, and private reasoning never appear in the collapsed
card; expanding the result with Pi's native expansion binding (Ctrl+O by default) renders
the #59 expanded detail view — the same returned data, never a rerun or retrieval,
reorganized into bounded, provenance-separated sections (observed evidence, worker
claims, reviewer verdicts, and the authoritative durable context) with the snapshot's
"as of" freshness, unavailable ranges, truncated records, and every omitted range
disclosed — and re-collapsing restores the unchanged collapsed card. Streaming, error,
and cancelled results stay stable in both states: a still-streaming result renders a
bounded pending view even when expanded, and evidence selector failures stay task-scoped
in the expanded view.

Selector failures are scoped: with a valid, authorized `taskId`, a mistyped `entryId`, an
unknown `callId`, a malformed or expired `cursor`, or an out-of-range `index` returns one
concise task-scoped diagnostic with a bounded navigation hint (list entries with
`index`/`limit`, optionally `filter` or `find`, then deep-read by the exact `entryId` or
resolve a call by its real `callId`) — never the unrelated executions' inventory, IDs,
titles, artifact paths, or recovery history. The evidence snapshot is built once per
inspection, before any checkpoint-backfill recovery, and that validated read is returned
unchanged — so a selector can never fail only after a recovery write — while the
surrounding task inspection still reflects any backfilled state; a follow-up evidence read
picks up post-recovery changes. A correct selector still succeeds, an invalid read mutates
neither the task record nor the workspace, and an in-range index with a limit beyond the
remaining entries (or a filtered read with no matches) is a valid clamped/empty result,
not an error.

Prefer `SubtasksWatch` when you must wait for a state change (it returns immediately
and arms one deliberate future checkpoint while work remains active; it never waits
synchronously or rearms itself); use evidence-mode `SubtasksInspect` when you need to
understand *what happened* — locating a failure, checking whether a command result was
observed versus merely claimed, reading reviewer findings, or confirming unlanded
changes.

## Notifications and UI

The default **Quiet** notification mode keeps ordinary running and reviewing transitions
in passive UI telemetry while still notifying for every task landing, failure, conflict,
or recovery requirement. **Noisy** additionally starts turns for running and reviewing
transitions. In quiet mode, each `LANDED`, failed, conflicted, or recovery-required task
wakes the orchestrator, while ordinary `RUNNING` and `REVIEWING` transitions remain
passive UI telemetry; noisy mode additionally wakes on those two interactive states.

Every task landing is reported immediately with its still-active siblings so the
orchestrator can top off freed capacity without waiting for the entire execution. Each
completion reports the durable execution revision, per-phase task timing, and estimated
post-settlement capacity after already-queued work. Final completion also reports wall
time, summed task time, and peak concurrent workers. Internal `CAPTURING`, `ACCEPTED`,
`WAITING_TO_LAND`, and `LANDING` progress remains durable and user-visible without
starting model turns.

The persistent widget shows active tasks below the editor and distinguishes a task
assigned for executor startup from one still waiting for capacity and from active work.
`/subtasks-view` toggles the expanded panel, and the same expanded/collapsed preference
is available in `/review-settings`. This is a global UI preference rather than
conversation state. The expanded view lists only active tasks (up to 16), while its
combined newest-ten activity feed may temporarily retain events from tasks that have
already landed.

Every model-facing `SubtasksStart`, `SubtasksAdd`, and `SubtasksInspect` result includes
the stable task UUIDs, states, recent activity, and full artifact paths needed for
control and deeper `rg` inspection. Start/add results also show assigned-starting versus
capacity-waiting tasks and a point-in-time scheduler snapshot without claiming startup
has completed. A partial landing event identifies the landed paths and every sibling
that has not landed; only the final event invites aggregate verification. Completion,
failure, meaningful state changes, and workspace conflicts are delivered proactively;
polling loops are neither required nor recommended, but purposeful `SubtasksInspect`
calls are always supported.

## Review-readiness deferral

The same top-level review-readiness gate covers background shell jobs and execution and
research subtasks: automatic review of the primary orchestrator is deferred while any
job is alive or any task is queued, capturing, running, reviewing, accepted, waiting to
land, or landing. Normal task completion is delivered as a follow-up and failure is
delivered immediately; only after no background task remains active may that turn enter
automatic review.

## Background shell tools

The extension provides `ShellStart`, `ShellList`, `ShellLog`, `ShellSend`, and
`ShellStop` directly through Pi. Background jobs are detached process groups, wake the
agent on configured output or exit events, survive ordinary turn settlement, and are
reaped when the Pi session ends. At the top level, review-gate consumes the shell
controller's typed lifecycle state and defers automatic review while any job is alive.
The last job's ordinary exit wake resumes the orchestrator without a duplicate aggregate
notification; jobs with exit waking disabled still receive a review-readiness wake. A Pi
executor likewise keeps its RPC session alive while tracked background work runs,
accepts steering during that interval, and performs a final inspection turn before
review. Executor timeouts are suspended while a verified process group remains active;
external or unparseable `ShellStart` success responses fail closed.

## External harness protocol

The `run-as-binary` adapter uses the versioned `pi-review-executor-jsonl-v1` protocol.
It sends the prompt on stdin and sets `PI_REVIEW_EXECUTOR_OPERATION` (`start` or
`resume`), `PI_REVIEW_EXECUTOR_SESSION_ID`, and `PI_REVIEW_EXECUTOR_PROTOCOL`. The
process emits newline-delimited JSON:

```jsonl
{"type":"session","sessionId":"stable-session-id"}
{"type":"assistant","text":"Implemented and verified the bounded phase."}
{"type":"usage","usage":{"input_tokens":100,"output_tokens":25}}
```

The assistant event is required. The session event lets later correction and post-pass
turns resume the same harness context. Authentication remains in each harness's own
login/configuration; see [Security model](security-model.md#secrets-and-authentication).

## Research-task tool restriction

Pi enforces the read-only tool intersection through `--tools`. Launch-authorized native
read-only discovery (`grep`, `find`, `ls`) is part of the durable initial-active
subset, so Pi research workers can enumerate paths, search contents, and read matches
from the first request without a `search_tools` activation step. Codex uses its
read-only sandbox and rejects configuration that could weaken the research profile.
Claude maps the same authorized capability names onto its native `Grep`/`Glob` inside
an explicit read-only tool allowlist and permission callback while disabling user
settings, skills, plugins, and MCP. Every adapter also receives a private worktree
check that quarantines any detected write. Generic binary adapters are ineligible for
research because their protocol does not acknowledge the restriction. Research
subtasks never receive `ApplyPatch`. Enforcement details are owned by
[Security model](security-model.md#read-only-enforcement).

## Artifacts

Each task produces a `waveRoot` containing its operation record, bounded
executor/reviewer protocol streams, worktree/checkpoint metadata, manifest, and stable
refs. Its execution group has a separate integrity-checked manifest and is associated
with the exact parent conversation sidecar. On later captures, completed non-recovery
roots older than `waveArtifactTtlMs` are garbage-collected (30 days by default; `0`
disables collection). Conflict, integration-error, and recovery-required roots are never
removed by this GC, and `retainBundles: "always"` disables age-based wave GC while the
application is running. Application shutdown still removes settled artifacts;
recoverable unlanded checkpoints remain protected (see [Recovery](recovery.md)).