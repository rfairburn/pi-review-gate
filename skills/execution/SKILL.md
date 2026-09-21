---
name: execution
description: Execute authorized implementation and runtime work directly or as a delegated worker — workspace edits, builds, targeted tests, long-running command handling, and process/PTY diagnosis. Read before substantive execution work, including before delegated execution begins.
---

# Execute authorized work

Read this skill before substantive execution work: implementation phases, build/test
loops, background command handling, and runtime or PTY diagnosis. It explains what the
execution role may do, how tools are discovered, and how results must be reported.

## Primary execution mode versus delegated executor role

- **Primary execution mode** ("Prefer execution") is the top-level assistant working
  directly in the live workspace. It keeps the full registered toolset it was launched
  with — including delegation controls (`SubtasksStart`, `SubtasksAdd`, `SubtasksSteer`,
  `SubtasksInterrupt`, `SubtasksContinue`, `SubtasksWatch`, and related `Subtasks*`
  controls), background shell tools, browser tools, and web tools — and remains
  responsible for integration, validation, and reporting to the user.
- **Delegated executor role** is a worker inside an isolated task: its tool catalog is
  captured from the parent's live authorization when the task starts and never widens.
  Recursive delegation is deliberately not registered for Pi executor roles, so a
  worker cannot hand off its work. Delegation never escalates permissions: a worker can
  only use what the parent itself was authorized to use, and a primary cannot gain
  authority it lacked by delegating the same request.
- Availability ceilings are actual, not assumed. Neither role may invoke a tool by
  guesswork: consult the startup inventory and the `search_tools` description for this
  role's actual discovery set, then activate with exact names. Baseline tools the
  role loads automatically never need activation.

## Tool discovery and activation

- The startup inventory lists this role's discovery set — its deferred authorized
  tools, each name with a tiny purpose summary. Tools the role loads automatically at
  baseline are omitted. The summary is a stable role inventory, not a "still
  inactive" list: it stays byte-identical as deferred tools activate, and newly
  activated deferred tools remain listed. It is an index, not the schemas: full
  parameter schemas stay deferred until a tool is activated.
- The `search_tools` tool description itself carries that same discovery set — the
  role's authorized names minus its baseline-loaded tools — at live permissions. If a
  name is known, query `search_tools` with that exact name only; use capability terms
  only for names you do not know. Loading never performs the operation — invoke the
  activated tool on the next turn.
- Do not restate or guess the runtime catalog from memory; the live inventory and
  `search_tools` are authoritative, and absence from the summary never means absence
  of authority — baseline tools are already loaded. The set rebuilds only when the
  real role, mode, or permission boundary changes. Detailed usage for the
  capabilities below lives in this skill.

## Background shells versus delegation

Decide per piece of work; both use existing semantics, no new tools.

- **Background shell** (`ShellStart`, with `ShellList`, `ShellLog`, `ShellSend`,
  `ShellStop`): for long-running or interactive processes you must observe or drive
  from this session — dev servers, test watchers, interactive prompts, and
  process/PTY-style diagnosis — and for minute-scale commands such as builds,
  test runs, and dependency installs even when no stdin interaction is needed.
  Keep the returned handle; read output with `ShellLog`, send input with
  `ShellSend`, and stop explicitly with `ShellStop`. Completion and output
  arrive as event notifications and wakes: never poll, sleep, or spin on
  handles. Only genuinely quick commands — seconds, not minutes — belong in
  the foreground inside an ordinary tool call.
- **Delegation** (`SubtasksStart` with kind `execute`, primary mode only): separate,
  isolated Git worktree at a captured base, its own review/correction loop, and an
  independently landed result. Use it when the work is a bounded phase that benefits
  from isolation, duration, or parallelism — not to escape a tool you lack: a worker's
  authority is fixed from the parent's authorization, so delegation cannot unlock
  capabilities the primary does not have.

## The delegated execution workspace contract

Workers run in detached-HEAD managed worktrees created at a synthetic captured base
commit; they are not the source/target checkout.

- Never check out, create, switch, or delete Git branches, and never alter Git worktree
  or ownership metadata. A named issue branch in the task belongs to the target
  capture/landing checkout; treat branch mentions as context, not checkout
  instructions.
- The harness owns capture, checkpointing, and landing. Do not commit, push, or manage
  Git state; keep your output as ordinary working-tree files.
- Keep the worktree clean of anything you do not intend to deliver. Untracked files
  inside the worktree are captured by the harness snapshot and land with the task: a
  report-only or no-code intent does not exclude them. Diagnostic evidence, scratch
  trees, build output, session/auth fixtures, and similar byproducts belong outside
  the captured worktree — or in a durable artifact location the task contract
  explicitly authorizes — never under an untracked `scratch/` path inside it. Do not
  invent new artifact mechanisms; existing tools plus the task report are the
  channels.
- For a report-only phase, the summary is the deliverable: put findings, evidence,
  and diagnostics in the report itself. Do not fabricate file edits or fixture trees
  to make a diagnosis look implemented, and keep evidence out of tracked content at
  private paths (the privacy and worktree-boundary rules apply unchanged).
- Evidence is not limited to files you actually change: observed commands and
  their results, unchanged-source findings, and the reasoning that establishes
  a conclusion are all evidence the parent can evaluate. A report of
  `no_changes` is a legitimate deliverable when the authorized scope required
  none — report the observations that establish it — but it does not prove
  task acceptance or review; the parent evaluates the returned evidence.

## Verify and report

- Run the checks that actually cover your change (focused compiled tests, static
  checks, package checks when layout or shipped files change) inside your own tree.
  Never build into or modify a live `dist/` that is not yours; build into scratch or
  staging trees when required.
- Report changed files, verification performed with the commands that were run, and
  remaining risks. Do not report work as done while its required checks are pending or
  failing, and do not claim review outcomes — acceptance and review belong to the
  parent and the review gate.
- Recursive searches and scans: prune `.terraform` directories (and similar dependency
  caches) at traversal time rather than filtering results afterward.
