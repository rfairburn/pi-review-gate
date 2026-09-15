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
3. **Checkpoint status.** `SubtasksContinue` requires a verified recovery checkpoint or an accepted commit; missing, invalid, or unverifiable checkpoints require a replacement task or explicit manual recovery, not optimistic reuse. `SubtasksForceMerge` lands an accepted commit or verified checkpoint when one is present and otherwise salvages the identified work from retained state — it never asserts review success.
4. **Source-workspace disposition.** `unchanged` means this task did not land; `landed` means it mechanically reached main; `recovery_required` means source state may be uncertain.
5. **Conflict status.** Determine whether main already contains diff3 markers (or preserved unrepresentable conflicts — an intact target with a worker version saved alongside, or a recorded worker-side deletion) and an active conflict gate, or whether the attempted landing refused before touching main. Ordinary reviewed landing refuses any conflict it cannot represent; an explicit force-merge preserves them instead.
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
| `failed` | The task stopped without a usable automatic recovery path, often without a bundle. | Inspect diagnostics. If no verified checkpoint exists, either start a replacement task for the remaining outcome or use `SubtasksForceMerge` to salvage the retained work when landing that identified work is the desired outcome; retain the failed task as history. |
| `failed_critical` or source `recovery_required` | Recovery state or source rollback is unsafe or unverifiable. | Stop source mutations. Inspect recovery manifests and blocked actions; do not continue automatically. Report the exact source-state risk if the tool cannot establish a safe action. |
| `conflicted` with an active conflict gate | Main contains materialized diff3 markers and automatic landings are paused. | Resolve all gated paths in main, verify the combined result, then call `SubtasksMarkClean`. |
| Landing refused before any mutation | An ordinary reviewed landing met a conflict it cannot represent (binary, symlink/type change, oversized side, or worker-side deletion), so nothing was transferred and the limits were reported; or a force-merge met a genuinely unsafe path (escaping destination or unsafe symlinked ancestor). | For a normal landing, rework the task or resolve the overlap directly in main if authorized, then retry. An explicit force-merge does not refuse these representability limits — it preserves them — so do not expect another mode; only unsafe paths refuse. |
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

## Recover a worker worktree whose detached HEAD was replaced by a branch checkout

Workers run in detached-HEAD managed worktrees created at a synthetic captured base commit — pinned as `refs/pi-review-gate/waves/<waveId>/base` in the wave's private bare repository — whose tree already includes the target checkout's uncommitted content. Two accident classes differ materially:

- **Branch creation without a start point** (`git checkout -b <name>` or `git switch -c <name>` at the detached HEAD) damages only HEAD attachment: HEAD's commit and the working tree are unchanged — creating a branch at the current commit captures nothing new but destroys nothing either — and a plain `git checkout --detach` restores the detached state with the ancestry precondition intact. Treat it like any other attached-HEAD finding and confirm the survey below; inspection may then still list normal continuation as safe.
- **Checking out an existing branch, or branch creation with an explicit start point that differs from the current commit**, moves HEAD and the working tree to that commit's tree. Git refuses when a dirty tracked file or a needed untracked file would be overwritten, and otherwise carries compatible local edits over — but it silently drops from the working tree any content that exists only in the current tree, including captured baseline content the branch's tree lacks and committed worker content from earlier detached commits. That dropped content is recoverable only from the pinned base ref, salvage refs, and the reflog — never from the moved worktree.

Prevent both with the workspace contract in the orchestrator skill; there is no polling or early detection that would catch it sooner.

The failure usually surfaces as checkpoint or candidate validation rejecting an attached HEAD ("Worker must use detached HEAD") before review or landing. Recovery is manual mechanical salvage with ordinary Git in the worker worktree and the wave's private repository. It never touches the target checkout, its branches, or its worktree metadata, and never relies on future capabilities.

### Verify before acting

First confirm the writer is quiesced: the task is stopped or interrupted, and `SubtasksInspect` reports no live or uncertain writer. Then survey read-only, before any mutation:

```text
git -C <worktree> rev-parse --show-toplevel
git -C <worktree> rev-parse --git-common-dir      # must resolve to the wave's wave-repo.git
git -C <worktree> symbolic-ref --short HEAD       # a branch name here means HEAD is attached (damaged)
git -C <worktree> rev-parse HEAD
git -C <worktree> rev-parse refs/pi-review-gate/waves/<waveId>/base
git -C <worktree> status --porcelain              # uncommitted worker content still present?
git -C <worktree> log --oneline -g HEAD           # HEAD reflog: what the checkout did, step by step
git -C <worktree> log --oneline <branch>          # commits the worker made while attached, if any
```

Resolve the wave root from the task's artifact directory (`SubtasksInspect` reports it); `<worktree>`'s common dir must resolve to that wave root's `wave-repo.git`. If identity cannot be established, stop: this runbook does not apply.

Distinguish what actually survived:

- **Retained commits** the worker made while attached are safe objects in the wave repository regardless of later HEAD movement. Their SHAs come from the branch tip, the HEAD reflog, or the durable operation record.
- **Uncommitted worker edits** may still be present in the working tree (a checkout carries compatible local edits over). `git status --porcelain` is the evidence.
- **Working-tree-only worker content** that the checkout overwrote (worker edits clobbered by the branch's tree and never committed or stashed) is what can be irrecoverably lost; the reflog records the tree moves, not the destroyed worktree content. The captured baseline itself is not lost this way: it remains pinned at `refs/pi-review-gate/waves/<waveId>/base` and the target checkout still holds its own copy, so a truthful loss report distinguishes these two cases.

### Preserve the retained content first

Pin everything found before changing anything. Create-only salvage refs keep later work from destroying evidence; export (below) reads only these refs and never needs to mutate the worktree. Create a create-only salvage ref in the wave repository (the `000…0` old-value argument makes the update fail if the ref already exists):

```text
git -C <worktree> update-ref refs/pi-review-gate/waves/<waveId>/salvage/<taskId> <retainedCommitSha> 0000000000000000000000000000000000000000
git -C <worktree> rev-parse refs/pi-review-gate/waves/<waveId>/salvage/<taskId>
```

If uncommitted content is still present, capture it as a stash commit before anything else (do not commit on the attached branch; do not apply or drop the stash). Stash creates commits, which need a committer identity — pass one explicitly per command instead of editing configuration:

```text
git -C <worktree> -c user.name=pi-review-gate-recovery -c user.email=pi-review-gate-recovery@invalid stash push --include-untracked -m "salvage <waveId>/<taskId>: retained worker content before detachment repair"
git -C <worktree> rev-parse refs/stash   # stash SHA to pin under its own create-only ref (next step)
```

Pin the stash SHA under its own create-only ref, because the retained-commit pin above refuses to replace `salvage/<taskId>` by design:

```text
git -C <worktree> update-ref refs/pi-review-gate/waves/<waveId>/salvage/<taskId>-stash <stashSha> 0000000000000000000000000000000000000000
git -C <worktree> rev-parse refs/pi-review-gate/waves/<waveId>/salvage/<taskId>-stash
```

This keeps the stashed content reachable even if the stash ref is later overwritten. Verify reachability (`git -C <worktree> cat-file -t <sha>`, `git -C <worktree> show --stat <sha>`) for every pinned SHA before proceeding.

Determine the worker's own commit range from evidence, never by assuming HEAD's immediate parent is all worker work. Read the HEAD reflog to find each contiguous run of worker commits (commit entries between checkout entries) and note which commit each run started from: a run on the attached branch starts at the branch tip, but a worker that also committed while detached before the checkout has a separate earlier run on the captured base. Export one diff per run (below); a single diff spanning the first worker commit's parent to the last does not cover disjoint runs, and a diff from the captured base to the branch tip is not the worker delta at all. Pin each retained run tip the reflog identifies under its own create-only ref (`refs/pi-review-gate/waves/<waveId>/salvage/<taskId>-run<N>`) as well, so the exported ranges stay reachable even if the reflog is later truncated.

### Export the retained material (read-only for the worktree)

Export the worker's own delta as reviewable material before considering any worktree mutation — everything below reads only the pinned refs and the commits the reflog names, so it works even if the worktree is never detached again:

```text
# One diff per contiguous run of worker commits identified from the reflog
# (each run's start commit is the commit the run built on, from reflog evidence)
git -C <worktree> diff --binary <runStartCommit> <runTipCommit>
# Stashed tracked content: staged and unstaged changes collapsed into one
# diff by `stash show` (the stash still records the index state in its second parent,
# so the split below remains recoverable)
git -C <worktree> stash show --binary -p <stashSha>
# Optional: recover the staged/unstaged split from the stash's second parent
# (the index tree at stash time)
git -C <worktree> diff --binary <stashSha>^1 <stashSha>^2   # staged at stash time
git -C <worktree> diff --binary <stashSha>^2 <stashSha>     # unstaged at stash time
# Stashed untracked files: only when the stash was taken with untracked files
# present; the stash then has a third parent (a parentless commit holding them)
git -C <worktree> show --binary <stashSha>^3
```

`stashSha^3` fails with "unknown revision" when the stash has no untracked parent — two-parent stashes are complete without it. Write the exported material into files under the task's artifact directory — never into the target checkout.

Applying that material in the target checkout is a separate, explicit, user-authorized manual recovery step — it is ordinary content salvage, not a harness landing, and exporting alone has placed nothing anywhere. It must not be described as a verified checkpoint, review success, or recovered correctness. Joint review of the applied result decides whether the implementation is actually correct.

### Restore detachment honestly (only if attempting normal continuation)

Detachment is a mutation of the failed worktree; skip this section when export alone is the goal. With the working tree clean or stashed, detach without changing the working tree:

```text
git -C <worktree> checkout --detach                      # bare form: detaches at the current commit; the working tree does not change
git -C <worktree> symbolic-ref --short HEAD              # must now fail: HEAD is detached again
```

Never use `git checkout --detach <sha>` here: when `<sha>` differs from the current commit, that form moves HEAD *and* resets the working tree to `<sha>`'s tree, which is exactly the destructive movement being recovered from. The bare form is the only detach that is guaranteed tree-preserving.

State plainly what this repairs: detachment restores only the mechanical precondition that harness validation checks. It does not create, verify, or revalidate any durable harness checkpoint, does not recover content the checkout already abandoned, and does not by itself make the task landable.

### Choose between normal and manual recovery

- **Normal continuation is available only when inspection still lists it as safe.** Harness validation requires a detached HEAD whose commit is the captured base or is based on it (`git merge-base HEAD <baseCommit>` must resolve to the base commit). A worker that committed on top of a checked-out branch generally fails that ancestry check, so the automatic candidate/checkpoint path stays closed even after detachment — that rejection is the fail-closed design working. A verified durable checkpoint that already existed before the damage remains valid as a durable record; whether continuation can proceed still depends on what inspection reports about the now-damaged worktree.
- **Manual mechanical salvage** is the supported path when the automatic path is unavailable and the retained content is verified. Export per **Export the retained material** above — a diff that spans from the captured base to a foreign branch tip is **not** the retained result (it also contains the branch's own deltas and the inverse of the captured uncommitted content) and must never be applied into the target checkout. Stashed or exported content is not restored by any continuation: even where normal continuation is safe, it resumes from durable harness state, and the only path for salvaged uncommitted content is the user-authorized manual application above.
- **Unsupported or unverifiable cases**: no readable reflog, unidentifiable worktree identity, missing wave repository, or reflog/status evidence that content was destroyed by the checkout. Preserve the worktree and all artifacts exactly as they are, report exactly what is lost and what remains unverifiable, and do not reset, re-checkout, or fabricate a state. Never run `git reset --hard` or any destructive command before the retained content is pinned and verified, and never accept the attached branch as a valid candidate.

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

Normal landing has materialized diff3 markers, or an explicit `SubtasksForceMerge` has materialized markers or preserved an unrepresentable conflict (an intact target with any available worker version saved alongside, or a recorded worker-side deletion). Either path activated a conflict gate. Automatic landings are blocked, although workers may continue executing in their separate worktrees.

1. Read the critical conflict notice or inspect the gate for the exact paths, task, execution, and manifest.
2. Resolve every conflict in the main workspace using the effective task request, current main intent, captured base, and worker result. Do not blindly choose one side.
3. Check for all remaining conflict markers in the gated paths and validate the integrated behavior.
4. Call `SubtasksMarkClean` only after the files are genuinely resolved and verified. The command checks marker removal, checkpoints the parent review baseline, marks the task landed, clears the gate, and releases queued landing attempts.
5. Observe the released tasks' landing events and perform combined validation after they settle.

`SubtasksMarkClean` is not a semantic validator. Calling it only says that the orchestrator has resolved and verified the materialized conflict; the orchestrator remains responsible for correctness.

### The landing refused before touching main

An ordinary reviewed landing refuses up front, names every affected path and its concrete limit, and transfers nothing when a conflict cannot be represented: a binary, symlink/type change, oversized side, or worker-side deletion. An explicit force-merge does not refuse those representability limits — it preserves them there instead — so the refusal it can still produce is for a genuinely unsafe path (an escaping destination or an unsafe symlinked ancestor). In either refusal, main is left unchanged, and no second force option exists to retry differently.

Choose deliberately among:

- continue the worker with instructions to adapt its result to current main;
- start a new bounded integration task after abandoning the stopped checkpoint; or
- resolve the overlap directly in main if that work was explicitly authorized.

### Landing rollback is incomplete

If the landing packet says source disposition `recovery_required`, `failed_critical`, rollback incomplete, or recovery manifest unverified, main may contain only part of an attempted transaction.

1. Stop unrelated source mutations and automatic recovery guesses.
2. Inspect the landing manifest, failed path, applied paths, rollback error, head drift, and every recovery-manifest verification result.
3. Use continuation only if inspection explicitly lists it as safe. Verified in-progress recovery manifests are reconciled before continuation; unverified manifests block it.
4. If inspection cannot establish a safe action, report the exact affected paths, manifest paths, source disposition, and blocked action. Preserve all artifacts for manual recovery.
5. After recovery returns source to a known state, inspect and validate main before resuming queued landings.

Do not call `SubtasksMarkClean` for rollback recovery unless an actual conflict gate with materialized markers exists.

## Force-land a stopped checkpoint

Use `SubtasksForceMerge` only for a stopped execution task with no live writer. It lands an accepted commit or verified checkpoint when one is present; otherwise it salvages the identified work from retained state (a dirty worktree or surviving refs). A force-merge never asserts review success.

- An explicit `SubtasksForceMerge` merges all identified work in one call: clean paths apply and ordinary text conflicts are written to main with diff3 markers immediately, so the task becomes `conflicted` and the workspace conflict gate blocks automatic landings until `SubtasksMarkClean`. There is no clean-only mode and no second force option.
- A conflict that cannot carry text markers is preserved in place instead of aborting the merge: for a binary, symlink/type-change, or oversized side the target stays intact and any available worker version is saved alongside at a collision-safe `<path>.worker-<blob>` name; for a worker-side deletion the target is kept and the deletion intent is recorded without fabricating bytes (no sidecar file). Both are named in the gate reason and recorded in the conflict manifest. Preservation is not resolution: choose a side, remove any saved worker version you do not keep, then call `SubtasksMarkClean`.
- Only genuinely unsafe paths (an escaping destination or an unsafe symlinked ancestor) still refuse before any mutation; in that case main remains unchanged and the error names the limits. Prefer continuation or an explicit integration decision.
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
