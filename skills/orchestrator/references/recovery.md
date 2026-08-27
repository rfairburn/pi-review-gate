# Recover delegated work

Read this runbook when a subtask is interrupted, stopped, failed, conflicted, unable to land, restored after application restart, or otherwise reports that recovery is required. Recovery is orchestration work: establish what happened, preserve usable worker state, protect the main workspace, and choose the smallest safe action that completes or explicitly abandons the task.

## Preserve these invariants

- A worker's changes remain in its separate worktree or verified checkpoint until the task is `landed`. A worker summary, accepted review, checkpoint, or force-merge acknowledgement is not proof that main contains the requested result.
- Do not start a second writer, manually copy files, continue a task, or force a landing while the current writer is live or its ownership is uncertain.
- Treat `SubtasksInspect` as the authoritative recovery packet. Use the current task state, source-workspace disposition, checkpoint verification, live ownership, conflict gate, recovery manifests, and safe/blocked actions together; do not recover from a single error string in isolation.
- Preserve stable `executionId` and `taskId` handles. When a continuation bundle is supplied, use the newest bundle returned by inspection; an older revision may be stale.
- A task failure does not undo independently landed siblings. Verify landed siblings in main and recover only work that has not landed.
- A force-merge is a mechanical checkpoint landing, not acceptance or correctness. Inspect the main workspace manually after every force-merge or `interrupt_with_merge` outcome.
- Materialized conflict markers make the main workspace intentionally unclean and block automatic landings. Resolve that gate before unrelated source mutation.
- If source disposition is `recovery_required`, assume a landing rollback may be incomplete. Do not modify source until the recovery manifest is understood and the tool reports a safe recovery path.

## Triage before acting

Call `SubtasksInspect` with the stable execution and task handles. If the task is unavailable but a durable reattachment bundle was returned by an earlier failure, inspect or continue with that bundle so the operation can be adopted into the current execution state.

Read the packet for:

1. **Current state and latest command.** Distinguish an active task from a stopped task, and distinguish a queued steer from an acknowledged or failed one.
2. **Writer ownership.** A live controller, process, or uncertain owner blocks continuation and force-merge. Wait for an event or interrupt the known live task; do not create a competing writer.
3. **Checkpoint status.** Continue or force-merge only from a verified recovery checkpoint or an accepted commit. Missing, invalid, or unverifiable checkpoints require a replacement task or explicit manual recovery, not optimistic reuse.
4. **Source-workspace disposition.** `unchanged` means this task did not land; `landed` means it mechanically reached main; `recovery_required` means source state may be uncertain.
5. **Conflict status.** Determine whether main already contains diff3 markers and a conflict gate, or whether a clean-only landing merely detected conflicts and left main unchanged.
6. **Recovery manifests and safe actions.** Follow the packet's safe/blocked actions. A verified landing-recovery manifest may be reconciled during continuation; an unverified manifest blocks source mutation.
7. **Artifacts and diagnostics.** Use the task artifact directory, activity, reviewer result, failed stage, and error-state exception to decide whether the worker should continue, be replaced, or have its checkpoint landed.

Do not poll for ordinary progress. Inspect once for a decision, take the selected action, then rely on events again.

## Choose recovery by state

| Observed state or disposition | Meaning | Normal next action |
| --- | --- | --- |
| `queued`, `capturing`, `running`, `reviewing`, `accepted`, `waiting_to_land`, `landing` | The task still owns or may soon own active execution/landing work. | Steer or interrupt if direction must change; otherwise wait for events. Do not continue or force-merge. |
| `paused_recoverable` | Execution stopped but a durable bundle/checkpoint may be reusable. | Inspect ownership and checkpoint, then use `SubtasksContinue` when listed as safe. |
| `interrupted` | A user or model intentionally stopped the task. It may or may not have a reusable checkpoint. | Inspect. Continue if the checkpoint is verified and the work should resume; otherwise replace or leave explicitly incomplete. |
| `stopped_for_application_exit` | The owning application shut down and retained task state. | Resume the exact parent conversation and cwd; allow automatic restart recovery, then inspect only if it does not become active or reports a problem. |
| `failed` | The task stopped without a usable automatic recovery path, often without a bundle. | Inspect diagnostics. If no verified checkpoint exists, start a replacement task for the remaining outcome and retain the failed task as history. |
| `failed_critical` or source `recovery_required` | Recovery state or source rollback is unsafe or unverifiable. | Stop source mutations. Inspect recovery manifests and blocked actions; do not continue automatically. Report the exact source-state risk if the tool cannot establish a safe action. |
| `conflicted` with an active conflict gate | Main contains materialized diff3 markers and automatic landings are paused. | Resolve all gated paths in main, verify the combined result, then call `SubtasksMarkClean`. |
| Force-merge clean-only conflict | Main was left unchanged by the attempted landing. | Decide whether to continue/rework the task, resolve the overlap in another bounded task, or explicitly use merge-anyhow to materialize markers. |
| `landed` | The task's mechanical landing completed. | Inspect affected paths and run combined validation; do not continue recovery unless new incremental work is explicitly desired. |
| Research `reported` | A read-only report completed; main was never eligible to change. | Read and synthesize the report. |

## Recover an active task that needs new direction

Use `SubtasksSteer` while the task is queued, starting, running, or reviewing. Acknowledged live steering changes the active turn; if live delivery is temporarily unavailable, the instruction remains durably queued for the next executor handoff. Steering during review supersedes that review and sends the worker back through execution and review with the updated request.

After steering:

- Do not assume delivery merely because the request was accepted. Check the returned latest-command status or the next event for acknowledgement or explicit failure.
- If the task reaches a terminal state without accepting the steer, inspect it. Continue from the verified checkpoint with the authoritative instruction when safe.
- If there is no live/startup target and no recoverable checkpoint, report steering failure and create a replacement task only if the outcome remains necessary.

## Interrupt without losing control of the result

Use `SubtasksInterrupt`, choosing its mode from the requested outcome rather than convenience:

- Use `interrupt_as_failure` to stop without attempting to land. This is the default meaning of cancel, abort, or stop. After writer quiescence, inspect whether a verified checkpoint permits later continuation.
- Use `interrupt_with_merge` only when the user or orchestrator explicitly wants the stopped checkpoint mechanically attempted against main. It interrupts the writer, waits for quiescence, and then behaves like force-merge with conflict materialization allowed.
- Research tasks can only use `interrupt_as_failure`; their workspaces are read-only and never land.

For either mode, wait for acknowledgement that the writer quiesced. If interruption itself errors, inspect ownership before issuing any continuation or landing action.

After `interrupt_with_merge`, inspect the main workspace regardless of status. `landed` does not prove the requested changes are complete; `conflicted` requires the conflict-gate runbook below; a failed attempt may leave the task recoverable without changing main.

## Continue a stopped worker

Use `SubtasksContinue` when inspection shows all of the following:

- no live or uncertain writer remains;
- the task has a current durable continuation bundle;
- checkpoint verification is `verified`, or the inspection explicitly lists continuation as safe after abandoned-writer reconciliation;
- no unverified landing-recovery manifest blocks source mutation;
- the operation is not `failed_critical`.

Give continuation instructions that state what remains, what changed since the prior turn, and what must not be redone. The worker resumes from the preserved session/worktree when its adapter supports that; otherwise the verified checkpoint and durable task contract preserve the work across a new session.

If continuation rejects a stale bundle, inspect again and retry with the returned current bundle. If checkpoint verification fails, do not recreate or patch that checkpoint. Start a replacement task from the current main workspace for the remaining outcome, and report that the original work could not be safely resumed.

Continuation uses the current `/review-settings`; a changed model or configuration is expected outside the happy path and should be treated as a warning, not as proof the checkpoint is invalid.

## Recover review rejection or correction failure

Routine `needs_changes` feedback belongs inside the worker lifecycle: let the worker correct blocking findings and review the replacement result. Passing and non-blocking advice do not require scope expansion.

If review or correction stops:

1. Inspect the effective request, including authoritative steers, the reviewer findings, final assistant summary, checkpoint status, and failure stage.
2. Separate implementation findings from reviewer/infrastructure failure. A reviewer timeout, provider exception, or unusable review is not evidence that the code is wrong; configured retries should handle routine infrastructure failures.
3. If the checkpoint is verified and more work is needed, continue with only the still-blocking, outcome-relevant correction.
4. If the reviewer rejected evidence that the effective acceptance criteria do not require, do not force unnecessary work merely to appease the reviewer. Preserve the diagnosis for the orchestrator's decision.
5. If no verified checkpoint remains, create a replacement task for the unmet outcome rather than asking another writer to reconstruct an unknown partial state.

## Recover a failed normal landing

Normal independent landing performs a guarded three-way comparison among the captured base, current main, and accepted worker result. It applies clean paths transactionally and refuses to silently overwrite a path changed differently in both main and the worker.

There are three materially different failures:

### Conflict markers are already in main

Normal landing or merge-anyhow has materialized diff3 markers and activated a conflict gate. Automatic landings are blocked, although workers may continue executing in their separate worktrees.

1. Read the critical conflict notice or inspect the gate for the exact paths, task, execution, and manifest.
2. Resolve every conflict in the main workspace using the effective task request, current main intent, captured base, and worker result. Do not blindly choose one side.
3. Check for all remaining conflict markers in the gated paths and validate the integrated behavior.
4. Call `SubtasksMarkClean` only after the files are genuinely resolved and verified. The command checks marker removal, checkpoints the parent review baseline, marks the task landed, clears the gate, and releases queued landing attempts.
5. Observe the released tasks' landing events and perform combined validation after they settle.

`SubtasksMarkClean` is not a semantic validator. Calling it only says that the orchestrator has resolved and verified the materialized conflict; the orchestrator remains responsible for correctness.

### Clean-only landing found conflicts

A clean-only `SubtasksForceMerge` can detect overlap without touching main. Inspection should report the task as recoverable and source disposition as unchanged.

Choose deliberately among:

- continue the worker with instructions to adapt its result to current main;
- start a new bounded integration task after abandoning the stopped checkpoint;
- resolve the overlap directly in main if that work was explicitly authorized; or
- call `SubtasksForceMerge` with merge-anyhow only when placing ordinary diff3 markers in main is the desired recovery mechanism.

Do not use merge-anyhow merely to turn a diagnosable overlap into an urgent dirty-workspace gate.

### Landing rollback is incomplete

If the landing packet says source disposition `recovery_required`, `failed_critical`, rollback incomplete, or recovery manifest unverified, main may contain only part of an attempted transaction.

1. Stop unrelated source mutations and automatic recovery guesses.
2. Inspect the landing manifest, failed path, applied paths, rollback error, head drift, and every recovery-manifest verification result.
3. Use continuation only if inspection explicitly lists it as safe. Verified in-progress recovery manifests are reconciled before continuation; unverified manifests block it.
4. If inspection cannot establish a safe action, report the exact affected paths, manifest paths, source disposition, and blocked action. Preserve all artifacts for manual recovery.
5. After recovery returns source to a known state, inspect and validate main before resuming queued landings.

Do not call `SubtasksMarkClean` for rollback recovery unless an actual conflict gate with materialized markers exists.

## Force-land a stopped checkpoint

Use `SubtasksForceMerge` only for a stopped execution task with no live writer and an accepted commit or verified checkpoint.

- Begin with clean-only mode. If it lands, inspect every reported applied/already-applied path and validate the requested outcome manually.
- If clean-only reports conflicts, main remains unchanged. Prefer continuation or an explicit integration decision before choosing merge-anyhow.
- With merge-anyhow, conflicting paths are written to main with diff3 markers, the task becomes `conflicted`, and the workspace conflict gate blocks automatic landings until `SubtasksMarkClean`.
- If a force-merge reports no remaining changes, inspect main anyway: the result may already be present, may have been superseded, or may be absent from the checkpoint.

Never describe force-merge acknowledgement alone as successful task completion.

## Recover after application restart

The review-gate restores execution state only when the same Pi conversation is resumed from the same session file and the cwd matches. Starting a new conversation, resuming a different session file, or changing cwd must not attach the old review/execution state.

On a clean application shutdown, active workers are stopped and recorded as `stopped_for_application_exit`; settled artifacts are cleaned while unresolved recovery state is preserved. When the exact parent conversation and cwd are restored:

- a stopped task with a durable bundle is automatically queued to continue without repeating completed work;
- an undispatched stopped task is queued again;
- a task that still appeared active after an unclean shutdown becomes `paused_recoverable` so writer ownership can be inspected before continuation;
- an existing conflict gate is restored and continues to block automatic landings.

After `/resume`, wait for the restored-state notice and task events. Inspect only if automatic recovery does not proceed, ownership is uncertain, configuration changed unexpectedly, or a task reports recovery-required state. If state is rejected because conversation identity or cwd differs, do not bypass that contract by manually attaching arbitrary worktrees. Resume the correct conversation/cwd or use an explicit durable bundle for triage-style adoption in the matching workspace.

Application shutdown is designed to kill owned workers. If inspection nevertheless reports a live or uncertain prior writer, do not continue until ownership becomes safely dead or the known task is interrupted and quiesced.

## Recover a research task

Research tasks use private read-only workspaces and never merge into main.

- A successful task becomes `reported`; read its full report when the event summary is intentionally abbreviated.
- A stopped research task with a verified bundle can be continued with a focused instruction describing the missing evidence.
- A research task without a usable checkpoint must be replaced if its report is still needed.
- Interrupt research with `interrupt_as_failure`; force-merge and `interrupt_with_merge` are invalid.
- If a research worker modified its private workspace, treat that as task failure. Do not copy those changes into main.

## Close a partial execution honestly

Execution groups retain terminal failures and interruptions as durable history. A successful replacement task does not erase the original failed record, and the group may remain aggregate-incomplete even when the requested outcome has been covered elsewhere.

When concluding:

- list which tasks actually `landed` or `reported`;
- identify each task still active, recoverable, interrupted, failed, or conflicted;
- distinguish source state from worker state;
- name any replacement task that covered a failed task's outcome;
- report manual conflict or force-merge inspection and integrated validation;
- do not claim the whole group succeeded merely because the desired files now exist.

The orchestrator may synthesize an outcome as complete when every effective requirement is independently verified, while still disclosing failed historical attempts and the execution group's durable incomplete status.
