---
name: orchestrator
description: Coordinate substantive coding or research through background subtasks while retaining ownership of decisions, supervision, integration, and validation. Use for multi-step, long-running, delegated, or meaningfully parallel work.
---

# Orchestrate substantive work

Treat delegation as an execution strategy, not a transfer of responsibility. Keep the primary context focused on decomposition, decisions, coordination, and synthesis while workers perform bounded investigation or implementation.

## Capability-based dispatch: primary mode versus delegate roles

You orchestrate as the primary: you keep your own registered toolset — read and search tools, web tools, background shells where authorized, and the delegation controls themselves — for quick discovery and direct decisions. Delegates are capability-scoped roles, not general-purpose clones of you: an execution worker and a research worker each receive a fixed tool catalog captured at dispatch.

- Choose the delegate role by the capabilities the work needs, not by whether files will change. Source-only inspection and investigation fit research. Anything that needs to run something — installing dependencies, executing tests or builds, running Pi or another process in a PTY, observing runtime behavior — requires an authorized execution path, even when the deliverable is only a diagnostic report and no file changes are expected.
- Check the planned operations against the actual available tools before dispatching: consult the startup inventory and `search_tools` for this session rather than assuming a capability from memory.
- For tool discovery, the startup inventory and the `search_tools` description carry this role's discovery set: the authorized tools minus the tools the role loads automatically at baseline. The set is unchanged by later activations and is rebuilt only when the real permissions or operating mode change. Never duplicate a static tool catalog into task text or prompts.
- Delegation never widens authority: a delegate can only use what the parent itself was authorized to use, and a plan/research operating mode cannot escalate past its own read-only boundary by delegating. If the work needs a capability this session lacks, say so instead of dispatching around it.
- Read the relevant capability guidance before choosing or dispatching a delegate: [../execution/SKILL.md](../execution/SKILL.md) for execution tasks, [../research/SKILL.md](../research/SKILL.md) for research tasks. The execution skill details the primary-execution mode versus the delegated executor role; the research skill details the enforced read-only boundary.

## Shape the work

- Use your own direct tools for concurrent foreground reads, searches, fetches, and shell calls for quick discovery that immediately informs a decision.
- Use read-only research subtasks for deeper independent investigation whose detailed exploration would consume the primary context. Consume their reports and sources instead of repeating the investigation.
- Use execution subtasks for phases that need the execution path: substantive workspace-writing work, and runtime or process diagnosis — including report-only diagnosis that changes no files. Every execution task receives a separate, isolated Git worktree at its captured base. Siblings do not share a working directory and cannot see or build on one another's unlanded edits. A cohesive deliverable can be one bounded worker task; parallelism is useful but is not required for delegation.
- Keep branch ownership with the target checkout: prepare the task's named issue branch there, pass that checkout as the execution group's workspace, and reference the branch as context only. Never instruct a worker to check out, create, or switch to that branch: the worker's managed worktree stays on a detached HEAD at a synthetic captured base that already includes the target's uncommitted content, checking out a different commit there would reset the tree and can drop that content, and the harness owns checkpointing and landing. Do not hand workers the repository's own branch/commit conventions as working instructions — commits, checkpoints, and landings are harness-owned.
- Shape concurrency from dependencies and benefit, not from available capacity. At the start of substantive work, identify actual dependencies and independent ready work; while work runs or a dependency clears, ask whether another already-authorized task with a concrete useful output and known consumer can proceed independently. Parallelize when the expected time or primary-context benefit outweighs dispatch, review, and integration costs: independent evidence gathering is useful when it answers a concrete unresolved question, not when it duplicates an active investigation or reviews a tree that will be replaced.
- Capacity is an opportunity, not a utilization target. There is no minimum task count, required research companion, or obligation to manufacture work to avoid idleness; waiting or serial execution is correct when no useful independent work is ready. Do not fragment tightly coupled changes across workers that must continuously coordinate merely to create more tasks.
- Prefer non-overlapping ownership, but permit justified controlled overlap with distinct responsibilities and an explicit integration order. Ordinary conflicts are an integration responsibility, not a reason to serialize everything: resolve both accepted intents and validate the combined result rather than force-merging blindly.
- After an intermediate landing, continue onto meaningful ready accepted work instead of stopping because one task landed; do not expand accepted scope or invent follow-ups to stay busy.
- Keep making useful decisions or performing independent discovery while workers run. Rely on event notifications; do not create polling loops, sleeps, or background wait jobs.

## Write worker contracts

Give each worker a self-contained contract containing:

- the desired outcome, relevant context, and explicit boundaries;
- constraints, non-goals, dependencies, and invariants;
- clear ownership boundaries when siblings run concurrently;
- observable acceptance criteria such as final behavior, file contents, targeted test results, or a source-linked research report.

Describe what must be true without over-prescribing incidental implementation details. A later steer is authoritative when the task changes. Point each worker at its shipped role skill as required reading before substantive work — execution workers at the execution skill, research workers at the research skill — and do not restate those skills' content in the task text.

Default to one concrete, coherent outcome per subtask. Minimize simultaneous unresolved decisions without assuming advance knowledge of which model will serve the worker: a smaller-model success should follow from good task construction, not from model selection or routing changes. Resolve architectural uncertainty before dispatching implementation slices that depend on it; do not bundle broad investigation, a large implementation, documentation, and broad validation into one assignment, and keep each change with the focused tests and documentation necessary to establish its coherent outcome. Keep genuinely dependent source-writing slices sequential, and parallelize independent slices only when their shared contracts are settled.

## Supervise deliberately

- Retain execution and task handles. Inspect only when a current diagnostic snapshot will inform a decision; ordinary state changes arrive as events.
- When a long-running execution warrants one deliberate future checkpoint, use `SubtasksWatch`. It returns immediately, replaces the execution's prior watch, cancels on an earlier completion/failure/conflict/recovery event, and fires at most once; explicitly rearm it only when another checkpoint remains useful. Never turn it into a recurring heartbeat.
- Steer promptly when new information changes direction. Steering supersedes an in-flight review and remains queued when live delivery is temporarily unavailable.
- Add work to an existing execution when completed tasks free capacity and more planned work remains.
- Reassess from observed progress, expanding scope, and repeated review cycles rather than elapsed time or task size: prolonged work without a verifiable result justifies inspection, clarification, or splitting the remaining work — not automatic cancellation or a rigid limit. Preserve completed work and accepted invariants when rescoping.
- For a stopped task, diagnose its failure packet and prefer continuation from its verified checkpoint over recreating work. Retry infrastructure failures without pretending they are implementation verdicts.
- Treat reviewer feedback as a technical diagnosis to evaluate against the effective request and current workspace. Blocking findings require correction before ordinary landing; passing and non-blocking observations are information, not mandatory scope expansion.
- When a task is conflicted, interrupted, failed, `paused_recoverable`, `stopped_for_application_exit`, or otherwise reports recovery-required state, read [references/recovery.md](references/recovery.md) before acting.

## Integrate and conclude

- Only `landed` proves that a worker changed the source workspace. Before that state, its changes exist only in its separate worktree/checkpoint. Never claim or validate a sibling's output before it lands.
- Landing is a guarded three-way merge/integration using the captured base, the current main workspace, and the accepted worker result. Clean paths apply transactionally. When both main and the worker diverged on a path, normal landing reports a conflict instead of silently overwriting main or automatically line-merging the file. An explicit `SubtasksForceMerge` merges all identified work in one call — there is no clean-only mode and no second force option: clean paths apply and ordinary text conflicts materialize diff3 conflict markers that you resolve and clear with `SubtasksMarkClean`. `mergeAnyhow` is accepted for caller compatibility only and changes nothing. A conflict that cannot carry text markers (binary, symlink/type change, oversized side, or worker-side deletion) is refused before any mutation by ordinary reviewed landing, but preserved in place by an explicit force-merge: the target stays intact with any available worker version saved alongside at a collision-safe `<path>.worker-<blob>` name, and a worker-side deletion records its intent without fabricating bytes. Both are named in the gate reason and manifest; preservation is not resolution, so clear it with `SubtasksMarkClean` after manual resolution.
- Independently landed tasks need combined validation because individually correct changes can interact. Resolve cross-task inconsistencies in the primary workspace and run the smallest verification that establishes the integrated outcome.
- Treat landing conflicts and recovery-required states as immediate orchestration work. A force-merge is only a mechanical attempt and always requires manual workspace inspection.
- Report the combined result, relevant validation, unresolved warnings, and any task that did not land. Worker summaries are evidence to use, not conclusions to repeat without checking.
