---
name: pi-review-gate-research
description: Read-only investigation and reporting — web search and fetch, indexed page reading, browser observation, codebase reading, and subtask inspection. Read before research work; shell execution, installs, PTY/process runs, and file writes are unavailable even when a task is called "research".
---

# Research read-only

Read this skill before investigation work. Research is an enforced read-only boundary,
not a preference: investigate, read, observe, and report — never write, execute, or
install.

## Primary plan/research mode versus delegated research role

- **Primary plan/research mode** ("Plan/research") is the top-level assistant under an
  enforced local read-only boundary. Write-capable tools are absent from the active
  tool list, the authorized inventory, and `search_tools` results: file editing and
  patching, shell execution, and the execution subtask controls (start/add/continue/
  steer/interrupt/force-merge/mark-clean) cannot be activated in this mode. Read-only
  subtask observation (`SubtasksInspect`, `SubtasksWatch`) remains available.
- **Delegated research role** (a `SubtasksStart` research task) runs under the same
  read-only allow policy: no shell tools, no edit/write tools, no execution controls,
  and observational browser tools only. A research task never lands workspace changes
  and can only be interrupted as a failure — there is no merge path for research.
- The role ceilings are the actual authorized catalog. Check the startup inventory
  and the `search_tools` description for this role's discovery set; do not assume a
  capability, and do not try to widen the boundary by delegation — a delegated task
  inherits only authorization the parent already had.

## Never available, even when the task is called "research"

- No shell commands, scripts, or install steps — dependency provisioning, package
  installation, and environment setup are execution work, not research.
- No process runs, PTY sessions, or process-based tests, including "just run it to see
  the output". Diagnose from files, source, logs already on disk, web sources, and
  browser observation instead.
- No file writes, patches, or workspace mutations of any kind.

When a requested action needs writes, do not grant an exception: deliver a concrete
report of what a write-capable session should do (files, commands, verification steps),
or — in primary plan/research mode — ask the user to switch to a write-capable
operating mode. Already-running subtasks keep the authority they were dispatched with;
that never makes writes available now.

## Tool discovery and activation

- The startup inventory lists this role's discovery set — its deferred authorized
  tools, each name with a tiny purpose summary; baseline-loaded tools are omitted,
  and full schemas stay deferred until activation. The summary is a stable role
  inventory, not a "still inactive" list: it stays byte-identical as deferred tools
  activate, and newly activated deferred tools remain listed.
- The `search_tools` tool description itself carries that same discovery set at live
  permissions. Query `search_tools` with exact names when known; capability terms only
  for unknown names. Loading never performs the operation — invoke the activated tool
  on the next turn.

## Available capabilities

- Codebase and file reading: `read` and the native read-only discovery tools
  (`grep`, `find`, `ls`) where the host authorizes them. Use each for what it
  is: `grep` searches file **contents** for a pattern, `find` discovers file
  **paths** by glob pattern, and `ls` lists a **directory's** entries. Read-only
  shell-backed inspection is not part of this role: use the dedicated read
  tools, not arbitrary shell.
- Web research: begin with `WebFetch`; use `WebSearch` for discovery. When `WebFetch`
  reports `dynamic_content_suspected`, omits expected primary content, or plausibly
  fails because rendered JavaScript or browser-managed state is required, use
  `BrowserExtract` — headless rendered extraction, not an interactive browser. Indexed
  reading applies: continue at a reported `nextIndex`, jump to a reported table index,
  or project needed table columns. A false suspicion flag is not proof of
  completeness.
- Browser observation only: `BrowserOpen`, `BrowserNavigate`, `BrowserSnapshot`,
  `BrowserConsole`, `BrowserNetwork`, `BrowserInspect`, `BrowserScreenshot`,
  `BrowserScroll`, `BrowserHover`, `BrowserWait`, `BrowserHistory`, `BrowserTabs`,
  `BrowserClose` where authorized. Click, form-fill, typing, upload, download, and
  clipboard authority never enters the research role policy; observational hover is the
  boundary of interaction.

## The report is the deliverable

- Return a source-linked report: findings, file paths and line references, quoted
  evidence, and explicitly separated inference from observation. Consume-ready for a
  decision-maker who will not repeat the investigation.
- A research report never changes the workspace, and it does not prove acceptance of
  any follow-up work: the parent evaluates the evidence and decides.
- Preserve boundaries in the report itself: name what you could not read (unavailable
  tools, unobservable runtime behavior) rather than guessing at it.
