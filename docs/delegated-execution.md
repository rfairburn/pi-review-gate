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
- Start and add accept 1–16 bounded tasks and return stable execution/task handles
  immediately. Work continues in the background up to the configured global and
  per-model capacities.
- Each task owns its capture, worktree, session, checkpoint, review, and landing
  outcome; there is no wave-wide shared base or all-workers integration barrier.
- Research tasks skip review and landing, validate that their private worktree stayed
  unchanged, and finish as `reported` with a durable report path.
- `SubtasksContinue` accepts either an associated task handle or a verified reattachment
  bundle.
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
Interruption is terminal rather than a claim that a settled turn has no live browser. Executor extension reload or session
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
source-mutation lease, replans against current main, and attempts to land. It does not
wait for, integrate with, or roll back a sibling. A completed landing immediately frees
capacity, and `SubtasksAdd` can top the execution group back up. The landed changes
remain uncommitted; source HEAD, index, staging state, and stash are preserved.

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
main. A durable critical gate then blocks every later landing, identifies the owning
task and paths in `SubtasksInspect`, and injects a priority instruction on every
matching orchestrator turn. After resolving the files, use `SubtasksMarkClean`; it
verifies that markers are gone, checkpoints the resolution, clears the gate, and wakes
queued landings.

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

Stopped tasks retain verified checkpoints and reattachment bundles for
`SubtasksContinue` or `SubtasksForceMerge`.

**Failures, retry, and recovery**: Executor failures are checkpointed to a protected
recovery ref before bounded retry. If same-executor recovery is exhausted, a verified
checkpoint may be handed to the next lower-priority pool entry; that adapter starts a
new native session in the same isolated worktree, so different providers and CLI
harnesses can take over without pretending to share conversation state. The full
recovery story — compaction lifecycle, protected refs, restart behavior, and the
`recoverLandingManifest` API — is owned by [Recovery](recovery.md).

Every failed or non-landed execution-tool operation returns the complete group and task
inspection: durable handles, current source disposition, commands and acknowledgements,
incidents, checkpoint/bundle data, artifact paths, conflicts, and concrete recovery
actions. This state remains inspectable after compaction or an exact-session restart.
Only `landed` means that worker changes reached the source workspace.

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

Pi enforces the read-only tool intersection through `--tools`. Codex uses its read-only
sandbox and rejects configuration that could weaken the research profile. Claude uses an
explicit read-only tool allowlist and permission callback while disabling user settings,
skills, plugins, and MCP. Every adapter also receives a private worktree check that
quarantines any detected write. Generic binary adapters are ineligible for research
because their protocol does not acknowledge the restriction. Research subtasks never
receive `ApplyPatch`. Enforcement details are owned by
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