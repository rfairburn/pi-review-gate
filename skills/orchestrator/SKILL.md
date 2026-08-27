---
name: orchestrator
description: Coordinate substantive coding or research through background subtasks while retaining ownership of decisions, supervision, integration, and validation. Use for multi-step, long-running, delegated, or meaningfully parallel work.
---

# Orchestrate substantive work

Treat delegation as an execution strategy, not a transfer of responsibility. Keep the primary context focused on decomposition, decisions, coordination, and synthesis while workers perform bounded investigation or implementation.

## Shape the work

- Use concurrent foreground reads, searches, fetches, and shell calls for quick discovery that immediately informs a decision.
- Use read-only research subtasks for deeper independent investigation whose detailed exploration would consume the primary context. Consume their reports and sources instead of repeating the investigation.
- Use execution subtasks for substantive workspace-writing phases. Every execution task receives a separate, isolated Git worktree at its captured base. Siblings do not share a working directory and cannot see or build on one another's unlanded edits. A cohesive deliverable can be one bounded worker task; parallelism is useful but is not required for delegation.
- Parallelize work with genuinely independent outputs or ownership. Do not manufacture concurrency by splitting tightly coupled changes across workers that must continuously coordinate.
- Keep making useful decisions or performing independent discovery while workers run. Rely on event notifications; do not create polling loops, sleeps, or background wait jobs.

## Write worker contracts

Give each worker a self-contained contract containing:

- the desired outcome and relevant context;
- explicit constraints, non-goals, and dependencies;
- clear ownership boundaries when siblings run concurrently;
- observable acceptance criteria such as final behavior, file contents, targeted test results, or a source-linked research report.

Describe what must be true without over-prescribing incidental implementation details. A later steer is authoritative when the task changes.

## Supervise deliberately

- Retain execution and task handles. Inspect only when a current diagnostic snapshot will inform a decision; ordinary state changes arrive as events.
- Steer promptly when new information changes direction. Steering supersedes an in-flight review and remains queued when live delivery is temporarily unavailable.
- Add work to an existing execution when completed tasks free capacity and more planned work remains.
- For a stopped task, diagnose its failure packet and prefer continuation from its verified checkpoint over recreating work. Retry infrastructure failures without pretending they are implementation verdicts.
- Treat reviewer feedback as a technical diagnosis to evaluate against the effective request and current workspace. Blocking findings require correction before ordinary landing; passing and non-blocking observations are information, not mandatory scope expansion.

## Integrate and conclude

- Only `landed` proves that a worker changed the source workspace. Before that state, its changes exist only in its separate worktree/checkpoint. Never claim or validate a sibling's output before it lands.
- Landing is a guarded three-way merge/integration using the captured base, the current main workspace, and the accepted worker result. Clean paths apply transactionally. When both main and the worker diverged on a path, normal landing reports a conflict instead of silently overwriting main or automatically line-merging the file; an explicit merge-anyhow operation can materialize diff3 conflict markers for manual resolution.
- Independently landed tasks need combined validation because individually correct changes can interact. Resolve cross-task inconsistencies in the primary workspace and run the smallest verification that establishes the integrated outcome.
- Treat landing conflicts and recovery-required states as immediate orchestration work. A force-merge is only a mechanical attempt and always requires manual workspace inspection.
- Report the combined result, relevant validation, unresolved warnings, and any task that did not land. Worker summaries are evidence to use, not conclusions to repeat without checking.
