# Changelog

Notable changes to `pi-review-gate` are recorded here as per-build sections keyed to
the exact numbered prerelease each change ships in (`## [0.1.0-dev.N]`, matching the
`bN` tag and package version). The project is pre-1.0: no dated release exists yet,
and a curated normal `v0.1.0` release may be cut later at maintainer discretion — see
the release summary in [CONTRIBUTING.md](CONTRIBUTING.md#releases).

While a pull request is open, its topmost numbered section is a candidate for the next
build: CI predicts that number from the pull request's current base (first-parent
distance plus one), and the publisher re-validates it against the exact merged commit
before any remote write. If the base advances, the candidate is updated against the
new base and strict CI re-runs; a stale number never publishes. Changes made before
per-build attribution was adopted are preserved verbatim under
[Previous builds](#previous-builds), without invented per-build splits or release
dates.

## [0.1.0-dev.25]

### Added

- `SubtasksStart` accepts an optional top-level `workspace` string selecting an
  existing, explicitly authorized development checkout or Git worktree as the
  execution group's capture and landing destination; omitted or blank uses the
  parent session's working directory, preserving current behavior (relative paths
  resolve against that same parent session's working directory). The target is
  resolved once at start (it must already exist; nothing is created, cloned,
  checked out, or repurposed) and persisted with the group: every capture,
  reviewed landing, restore, continuation, and recovery path uses that target,
  `SubtasksAdd` inherits the group's target, and steering never retargets it.
  Each task still receives its own isolated worktree captured from the target;
  several workers may independently land into the same target, and separate
  groups may target different repositories concurrently under the unchanged
  shared global capacity limits. Parent-session identity checks remain in force
  independently of the selected target, and a landing into a target other than
  the parent session's workspace never enters the parent review baseline (Refs
  #25).

## [0.1.0-dev.24]

### Fixed

- `SubtasksInspect` evidence now indexes retained Claude/Codex raw streams in the
  reported readable-stream case instead of reporting no evidence: when a turn's
  process-result.json does not record its adapter, a readable raw stream is indexed
  only when the durable operation record's canonical per-turn evidence (the attempt
  that ran the turn and the assignment that served it) establishes that turn's own
  adapter — the record's current adapter field describes only its latest assignment
  and never relabels earlier turns — disclosed with an explicit
  `adapter_from_operation_record` note; streams whose adapter cannot be established
  from durable evidence stay explicitly unavailable. Claude entries carry their stream
  timestamps (display only, without changing source ordering), Codex app-server items
  pair by their observed item ids where the retained stream carries them (scoped to
  the source stream; missing or ambiguous ids stay unpaired and legacy id-less streams
  keep conservative positional pairing), item types and command-result fields are
  accepted in both observed serializations so real call/result pairing with real
  statuses works where the stream supports it, parser-level pair references resolve to
  navigable entry ids, and an empty search over indexed evidence stays distinct from
  genuinely missing or unsupported sources (Refs #69).

## [0.1.0-dev.23]

### Added

- `SubtasksSteer` accepts an optional `interrupt` boolean (omitted or `false`
  preserves current behavior). When `true` on a live executor turn, the active
  **turn** is interrupted and the instructions are delivered to the same task,
  session, and workspace without cancelling, landing, or terminating the task;
  the acknowledgement covers the verified interruption plus transport acceptance
  of the replacement turn and never awaits its completion. During review the flag
  rides the existing steering-wins-over-review handoff. Without a live turn the
  request stays durably queued for the next executor handoff exactly like an
  ordinary steer, and adapters that cannot interrupt an in-flight turn report a
  concrete unsupported status as a failed steering acknowledgement instead of
  claiming interruption. `SubtasksInterrupt`
  terminal semantics are unchanged (Refs #63).

## [0.1.0-dev.22]

### Fixed

- Authorized `write` is active by default alongside `edit` and `ApplyPatch` in new
  top-level and delegated Pi coding sessions, without deferred activation. Planning
  and research restrictions, explicit exclusions, and previously captured worker
  catalogs remain unchanged (Refs #45).

## [0.1.0-dev.21]

### Fixed

- Pi's native `grep`, `find`, and `ls` are active from the first request in every
  operating mode and newly delegated Pi execute/research task, without deferred
  activation. Default-inactive discovery tools are included when Pi's registry
  permits them; explicit `--tools`, `--exclude-tools`, and `--no-tools` restrictions
  remain authoritative. `--no-builtin-tools` and other initial-activity settings
  alone do not withhold these tools. Claude research receives native `Grep`/`Glob`
  through the existing mapping; Claude execution already includes them. No native
  tool reimplementation, broader filesystem access, or research shell/write access
  is added. Captured worker authorization remains unchanged (Refs #71, Refs #72).

## [0.1.0-dev.20]

### Added

- A direct operating-mode cycling hotkey (default `alt+m`, configurable as
  `modeCycleShortcut` and under **Mode cycle hotkey** in `/review-settings`) advances
  the canonical persisted mode one step — `execute` → `orchestrate` → `plan-research`
  → `execute`, wrapping — with no selector or confirmation popup. It reuses the
  single shared mode transition and persistence path (status indicator, notice,
  deferred tool reapply), keeps already-running subtask authority untouched, and adds
  no model-facing mode tool or duplicate mode state. A key that is already a built-in
  Pi binding is rejected by name in `/review-settings` and, at startup, named in a
  warning with the hotkey left unregistered rather than overridden, so the built-in
  action keeps working; conflicts with other extensions are not detectable by the
  extension (Pi reports those itself at startup). The hotkey binding is captured at
  extension load, so a changed key applies after `/reload` (Refs #20).

## [0.1.0-dev.19]

### Added

- `/review-settings` now selects Prefer execution, Prefer orchestration (default), or
  Plan/research. The extension replaces the mode-specific system prompt on the next
  normal run in the same conversation, without restart or layered orchestration
  instructions. Planning removes write-capable tools from active schemas, the tool
  inventory, and deferred discovery; writing requires switching modes. Shared safety
  rules and already-running subtask authority remain unchanged (Refs #19).

## [0.1.0-dev.18]

### Changed

- Executor tool authorization is now carried exclusively by the canonical `executorToolCatalog` contract on durable task and operation records and in internal executor requests: new writers no longer emit the parallel `executorAllowedTools`/`executorInitialActiveTools` fields or request-level allowlist mirrors, and newly created task records are stripped of stale pre-cutover keys even when built from doubled input. Existing doubled records consume their validated canonical catalog while ignoring stale legacy copies (no migration and no rewrite-on-read), and pre-cutover old-only catalog shapes fail explicitly at the persistence, recovery, or launch boundary instead of silently restoring full-active behavior — including internal executor requests that carry only legacy fields, which every executor adapter rejects before spawning a process or loading an SDK. Records and requests that legitimately carry no catalog remain distinct from unsupported old-format ones, the executor bootstrap stays fail-closed, native CLI tool flags (`--tools`, `--allowedTools`) and adapter research settings remain the authoritative external enforcement surface, and authorization ceilings, initial-active subset validation, role and research restrictions, and interrupted/restart/continue integrity checks are unchanged (Refs #67).
- Reviewer and executor configuration is now carried exclusively by the canonical shapes: the shared `externalAgents` catalog with per-role `review`/`execution` sections, `review.activeReviewers` selections (`pi` model references or `external` agent ids), and `execution.workerResources`. The pre-cutover fields `decider`, `reviewers`, `enabledReviewerIds`, `execution.activeExecutor`, `execution.executorPool`, and `execution.externalExecutors` are no longer accepted: strict validation rejects old-only fields, while a doubled record consumes the canonical data alone and ignores obsolete copies without rewriting the stored record. Startup recovery warns, preserves valid settings, defaults invalid scalar values, and omits invalid collection entries individually without inventing model/reasoning pairs or authorization references. Unreadable documents use built-in defaults with a warning. Tool initialization continues normally; explicit configuration writes, the environment kill switch, and worker authorization ceilings remain unchanged. No legacy conversion or automatic file rewrite is performed. Unresolvable or duplicated reviewer selections keep their keyed identities (`pi:<model>`, `external:<id>`), stay reported as unavailable with bounded error outcomes instead of being dropped, and fail closed at freeze time; a frozen window recovers in-session when `/review-settings` repairs the selection. Settings persistence stops stripping or fabricating legacy fields on save, and the shipped examples and docs use the canonical shapes (Refs #67).
- Audited legacy review-session compatibility is removed with no migration, upgrade-on-read, backfill, or guessed defaults, and old-only incompatible session state now fails explicitly and locally instead of being silently interpreted: persisted snapshots predating the omission ledger are rejected at restore with an actionable diagnostic (the sidecar is preserved byte-for-byte, persistence is disabled for that session to avoid overwriting it, and the application keeps running) rather than defaulting to an empty ledger; new sidecars write only the canonical `reviewerSelectionDigest` (the superseded broad `reviewConfigDigest` field is no longer emitted), and sidecars whose persisted review window lacks that digest are likewise rejected at restore with an actionable diagnostic — preserving the sidecar byte-for-byte instead of accepting it and re-saving it under a freshly computed digest — while records without a review window remain restorable; obsolete `reviewConfigurationError` flags on old sidecars are ignored on read and the window re-freezes from current settings instead of deferring review behind a dead flag; and legacy queued-input delivery backfill is gone, so queued inputs are released only through their own durable delivery records — recovery notices now distinguish occurrences backed by an active delivery record (releasable when the review finishes) from old-only occurrences without one, which are reported as unreleasable with their contents preserved until cancelled with `/review-clear`, and review completion reports them instead of silently skipping. Current canonical session round-trip, restoration, reconciliation, pending-input delivery, honest reviewer-label rendering for synthesized outcomes, task restart/continuation, and evidence safety are unchanged (Refs #67).

## [0.1.0-dev.17]

### Fixed

- `SubtasksInspect` evidence deep reads now preserve the retained text faithfully: the model-visible chunk renders the retained original indentation, newlines, tabs, and blank lines (deliberate existing redaction and disclosed retention limits excepted), so multiline indented YAML, source code, diffs, and multiline tool/command output arrive as multiline text instead of a whitespace-collapsed single line. Continued chunks reconstruct the retained redacted content exactly — no silent whitespace loss, normalization, or duplication — chunk boundaries no longer split UTF-16 surrogate pairs (a lone surrogate in either half would corrupt both chunks' text), and continuation and truncation remain explicit. Compact entry previews stay compact and distinct from deep content. Two parser paths that unnecessarily JSON-escaped safe structured text fields now retain them verbatim: a plain-string `tool_execution_end` result in the Pi RPC stdout fallback, and the query of a completed Codex `web_search` item, whose remaining fields (status, error, id, results) stay retained in their compact JSON representation alongside the verbatim query so a failed search still carries its diagnostic and metadata (structured `mcp_tool_call` items keep their full compact JSON representation). Redaction before retention/search/display, private-reasoning exclusion, confinement, resource bounds, the explicit-`taskId` inspection contract (#53), and the scoped read-only selector error semantics (#61) are all unchanged (Closes #54).

## [0.1.0-dev.16]

### Fixed

- `SubtasksInspect` evidence-navigation selector failures are now concise and task-scoped
  instead of dumping every execution's state: with a valid, authorized `executionId`/
  `taskId`, a mistyped `evidence.entryId`, an unknown `evidence.callId`, a malformed or
  expired `evidence.cursor`, or an out-of-range `evidence.index` now returns one short
  diagnostic naming the requested task plus a bounded navigation hint (list entries with
  `index`/`limit`, optionally `filter` or `find`, then deep-read by the exact `entryId`
  or resolve a call by its real `callId`) — in the model-visible response, the
  human-rendered output, and the details payload alike — rather than the unrelated
  historical executions' inventory, task IDs, titles, artifact paths, diagnostic markers,
  or recovery history that the generic failure path appended. The evidence snapshot is
  assembled exactly once per inspection — before any checkpoint-backfill recovery — and
  that validated read is returned as-is, so a cursor or selector can never fail only after
  a recovery write (the surrounding task inspection still reflects any backfilled state),
  without double-building the bounded artifact index. A correct `entryId` deep read still
  succeeds, an invalid read mutates neither the task record nor the workspace, and the
  intentional non-error selector semantics are unchanged (an in-range index with a
  limit beyond the remaining entries clamps to what exists, and a filtered read with no
  matches is a valid empty result). Genuine failures — unknown task or execution handles,
  confinement refusals, and every other non-selector error — keep their complete group
  diagnostic packet, and authorization, redaction, resource bounds, and the explicit-
  `taskId` inspection contract are all unchanged (Closes #61).

## [0.1.0-dev.15]

### Changed

- `SubtasksInspect` now requires an explicit `taskId` in every mode and for every group
  size, including single-task executions: the registered schema marks it required,
  input validation rejects an omitted ID before any execution state is resolved, and
  both activity and evidence reads fail immediately with one concise actionable
  diagnostic naming where stable task handles come from, instead of silently inspecting
  the whole execution group (activity mode) or failing late with a different
  evidence-only error. Previously advertised omission is no longer supported for
  inspection, and single-task IDs are never inferred. Valid explicit-ID inspection of
  active and archived tasks — including unknown-handle failures and integrity-checked
  archive recovery — is unchanged, as are the optional-`taskId` contracts of the other
  subtask tools. The execution-wide overview remains available without a task handle
  through `SubtasksStart`/`SubtasksAdd` results, the complete group diagnostic packet
  returned by operations that fail after input validation, and the `/subtasks` and
  `/subtasks-view` user surfaces (Closes #53).

## [0.1.0-dev.14]

### Fixed

- Switching a worker resource to a different model in `/review-settings` no longer
  leaves stale reasoning levels behind, and never carries the previous model's level
  over: the model and its reasoning go hand in hand, so every retained execution and
  research route entry for the switched resource is re-derived from the new model's own
  capability metadata — its configured or pinned reasoning where set, otherwise its
  supported default (the single valid level for single-level models, `off` for models
  without configurable reasoning) — even when the new model also supports the prior
  level. Switching to an external agent drops the Pi reasoning override since the agent
  owns its configuration. Unrelated resources' route overrides are untouched, and the
  paired choice is displayed, persisted, and resolved consistently so it survives
  save/reopen/restart and execution succeeds under the new model without additional
  configuration (Closes #24).

## [0.1.0-dev.13]

### Fixed

- Wave execution Git subprocess handling now settles stdout capture only after the
  child process has exited and every stdio stream has drained, closing a class of
  latent truncation bugs (the candidate commit object-name capture was already
  settled this way):
  - Bounded review patch generation could resolve on process exit while diff bytes
    were still in flight, silently truncating the review patch under load; it now
    captures the complete diff before resolving, preserving bounded retention and
    truncation metadata, actual exit-status reporting, and timeout-kill behavior.
  - Landing blob materialization had the same exit-settled capture and could write
    a truncated file into the worktree; it now waits for stream drainage, preserving
    abort/timeout cleanup and failure diagnostics.
- Candidate commit creation no longer crashes the parent process or risks pinning an
  unverified checkpoint when writing the commit message to Git's stdin fails (early
  child exit, EPIPE, or spawn failure): stdin errors are now handled with a bounded
  diagnostic, the operation fails closed before any ref is pinned — a zero exit after
  a failed message write is never treated as success — and settlement happens exactly
  once even when spawn error, stdin error, and close all fire.

## [0.1.0-dev.12]

### Added

- `SubtasksInspect` evidence reads now expose completed `needs_changes` review findings
  while a worker is actively correcting, before any final task result exists: each
  completed review cycle is persisted immediately as an official record under the task's
  artifact directory (`reviews/<waveId>/cycle-NNNN.json`, numbered to match the immutable
  per-cycle review alias) and indexed with `reviewer_verdict` provenance — verdict,
  reviewer, cycle identity, summary and guidance, and findings with stable ids, severity
  and blocking status, location, and recommendation — reachable through the existing
  `find`, `filter: "review"`, and deep-read paths. Before settlement, no cycle is
  asserted to be definitively current — the newest readable cycle is presented as the
  latest available review evidence with unknown completeness (a later cycle's record
  could have failed to publish without leaving a trace), and earlier cycles are
  explicitly marked as superseded, so a historical blocker is never presented as the
  current verdict while both remain searchable. When no completed
  review evidence exists at all (a review in flight, or a disabled or unreviewed run),
  evidence reads report an explicit `review_unavailable` note instead of a silent empty
  success; unreadable, malformed, oversized, foreign-task, or symlinked cycle records
  are refused with per-file notes and never indexed. If a completed cycle's record fails
  to publish, the lifecycle best-effort leaves an explicit marker
  (`cycle-NNNN.json.unpublished`) beside the missing record carrying the official gate
  verdict, summary, and a bounded failure reason: that cycle counts toward review
  completeness and its verdict stays visible through its lifecycle entry, but its
  per-reviewer findings are not readable because no durable record exists, and malformed
  or foreign markers are refused with an explicit note. When a later unusable sibling —
  an unreadable or refused record, or a publication-failure marker — exists before
  settlement, its lifecycle entry and the context summary say the newest readable cycle
  cannot be confirmed (or name the superseding unpublished cycle when the marker
  identifies one) rather than presenting a possibly superseded verdict as current; if
  both writes fail under a shared fault such as ENOSPC or directory permissions, no trace
  of the completed cycle exists at all and the same conservative qualification applies —
  latest available with unknown completeness until settlement. Once
  a final result with a review report exists, it is reconciled with the durable cycles
  by review identity: cycle persistence is best-effort, so when the latest cycle's
  record is missing or unreadable (or left only as an explicit publication-failure
  marker) the report covers a newer review and is indexed — with each earlier cycle
  marked superseded by the final report — so a later
  official pass is never hidden behind an older persisted blocker; when the durable
  cycles already cover the report's latest review, the report is not counted twice
  (Closes #50).

## [0.1.0-dev.11]

### Added

- First launch no longer requires a hand-created config: when neither
  `~/.config/pi-review-gate/config.json` nor `~/.config/pi/review-gate.json` exists,
  the persistent launcher now initializes a private (directory `0700`, file `0600`)
  default config at the preferred location and continues normal startup. The generated
  config is valid with explicitly empty reviewer and worker selections — no models are
  selected, providers invoked, or credentials requested — so automatic review stays off
  until reviewers are configured through `/review-settings` or by editing the file,
  which remains fully usable from this state. Existing primary and fallback configs keep
  their discovery precedence and are never overwritten, including malformed ones;
  concurrent first launches publish atomically and can never clobber each other's config
  or expose partial JSON, and creation failures (permission errors, non-regular paths at
  the config location) fail closed with distinct actionable diagnostics (Closes #32).

## [0.1.0-dev.10]

### Changed

- Removed the obsolete "No general browser automation" non-goal bullet from the README
  Non-goals list, including its explanatory prose: interactive browsing with
  approval-required consequential actions is already documented as a shipped
  capability, so the stale non-goal no longer applied (Closes #43).

## [0.1.0-dev.9]

### Added

- `SubtasksInspect` gains an optional `evidence` selector that reads a task's bounded,
  indexed executor evidence natively instead of parsing raw session histories by hand.
  Evidence mode is mutually exclusive with the legacy activity `offset`/`lines`
  interface, which remains byte-compatible. It indexes only authorized per-task
  artifacts under the task's wave root (executor session files or per-turn raw streams,
  final responses, process results, the durable operation record, and the latest review
  report) with explicit `unavailable` notes for missing, unreadable, unsupported, or
  truncated sources; symlinks and path escapes are refused. Entries carry stable
  `entryId`s, timestamps, kinds, statuses, and provenance separating executor-observed
  data from worker claims (which never imply verification) and reviewer verdicts. Tool
  calls and results pair by real call ids, unpaired calls stay explicitly `in_flight`,
  private model reasoning is excluded from every view, and all content is redacted
  before search or display under per-entry, total, bounded tail-byte-window (per
  source), global newest-entry, and shared raw retention budgets with immediate release
  of evicted content, honest omission and truncation markers, and directory enumeration
  that applies its bound during iteration.
  Navigation supports paged ranges with `nextIndex`,
  case-insensitive `find` over the redacted view, `filter` narrowing, deep reads of
  large entries in bounded chunks via `entryId`/`chunkIndex`, call/result resolution by
  real `callId`, and incremental continuation through per-source watermark cursors whose
  chained digest covers every covered record salted with the opened file's generation
  (device/inode/birth time), so atomic replacement is rejected even with an identical
  covered prefix while appends continue exactly once. Each evidence read also returns
  the authoritative context: task state, assignment history and current selection,
  steering acknowledgements, changed files with honest landing status, and latest review
  verdicts; the artifact root is validated against the authorized wave root before any
  read through it, and the operation record informs that context only when it is a
  regular file inside that verified directory, fits the bounded context size, belongs to
  this task, and records an artifact directory that verifies as this task's (Closes #33).

## [0.1.0-dev.8]

### Fixed

- `WebFetch` handles non-HTML and structure-less responses instead of failing with an
  internal parser exception: explicitly non-HTML text responses (for example
  `application/json` or `text/plain`) are now indexed verbatim as bounded text blocks
  with the declared content type disclosed, so JSON and plain-text payloads remain
  readable and searchable without any markup interpretation. Empty bodies, undecodable
  non-text bodies, comment-only, rooted-but-empty, or otherwise structure-less
  responses, and pages made only of non-renderable markup now fail with an explicit
  bounded diagnostic instead of
  a raw parser error or a silent empty result; script-only shells keep the
  JavaScript-shell BrowserExtract escalation, and BrowserExtract's rendered output
  still parses as HTML regardless of the main response's declared content type
  (Closes #41).

## [0.1.0-dev.7]

### Added

- `ApplyPatch` now accepts the canonical OpenAI/Codex apply_patch envelope in a single
  `patch` argument: `*** Begin Patch` ... `*** End Patch` with mixed multi-file
  `*** Add File:` / `*** Update File:` (optional `*** Move to:`) / `*** Delete File:`
  operations, following the public Codex grammar (boundary trimming, shell-heredoc
  leniency, per-line add newlines, `@@ [anchor]` hunks whose first chunk may omit the
  marker, and `*** End of File` anchors). The complete envelope is parsed before any
  filesystem mutation; `*** Environment ID:` lines are rejected because the tool patches
  the local workspace only. The legacy single-file structured `operation` argument
  remains accepted for compatibility with earlier sessions (Refs #18).

### Changed

- Multi-file `ApplyPatch` requests apply file operations sequentially in envelope order,
  like Codex: the first failing operation stops the request, earlier successes remain
  applied, later operations are not attempted, and the call errors with an explicit
  applied / failed / not-attempted report including any uncertain effects of the failed
  operation (for example a move whose destination was created but whose source removal
  failed). There is no cross-file rollback: partial state is reported truthfully instead
  of claiming atomicity POSIX does not provide. Successful canonical calls return the
  upstream `print_summary` text (`Success. Updated the following files:` with git-style
  A/M/D lines); review evidence pre-captures every envelope path and retains successful
  changes even when the overall call errors (Refs #18).

## [0.1.0-dev.6]

### Changed

- Interactive browsing now uses a sustained QA session rather than extraction-style
  rendering: images, downloadable fonts, media, local data/blob resources, SSE and
  HTTP beacons render through protected networking. Dedicated/shared workers retain
  broker egress. Cumulative host, connection, request, byte, navigation and action
  quotas no longer retire interactive sessions; extraction limits remain unchanged.
  Concurrent broker capacity is 64 client and 64 upstream connections, with local,
  observable overload refusal and bounded retained history (Refs #35).
- Console and network diagnostics retain the latest 256 events and at most 1 MiB of
  sanitized UTF-8 data per channel across a session, with tab-isolated reads and
  truthful eviction cursors. Structured failure phase/category reporting preserves
  safe DNS, SSRF, startup and navigation diagnoses without guessing authorization
  from untrusted error text. SSRF, pinned DNS, broker authentication, isolated
  selectors, approvals and finite per-operation/output limits remain in force.
- Local Chromium receives five seconds for graceful close, then verified-owned force
  termination with an additional bounded verification allowance. The exact Playwright
  dependency is pinned for the guarded local ownership bridge; unsupported ownership
  fails closed without switching transport or signalling unrelated processes.

### Added

- Persisted Browser idle expiry under `/review-settings` → Web, default 15 minutes.
  Browser-tool activity renews it, active operations are protected, background page
  activity does not renew it, and expired handles require explicit reopening.
- Real QA regressions cover painted network-image pixels, valid fonts/audio,
  dedicated/shared workers, SSE beyond 32 MiB, approved synthetic search submission,
  sustained navigation beyond former quotas, and owner-alive forced Chromium-tree
  cleanup. Fleet tool navigation/screenshots show the graphical homepage; CNN captures
  expose advertising-frame settling and remaining third-party ad/player errors rather
  than claiming unrestricted site fidelity. Visibility, password/upload overrides and
  service-worker support are not added by this candidate (Refs #35).

## [0.1.0-dev.5]

### Changed

- Changelog entries are now attributed to the specific numbered prerelease build they
  ship in instead of accumulating under an aggregate Unreleased bucket: each pull
  request carries a candidate section for the next build, CI validates that number
  against the pull request's current base, and the publisher re-validates it against
  the exact merged commit before any remote write (#36).
- Numbered prereleases from this build onward carry their own human-readable changes
  in a collapsed-by-default details block in the GitHub release body, derived
  deterministically from the exact source changelog of the released commit;
  publication fails closed on missing, duplicate, empty, or mismatched notes, and
  retries verify the published notes against that same exact source (#36).

### Added

- A Previous builds section preserving the pre-adoption aggregate history verbatim,
  with no invented per-build attribution or release dates for the old aggregate
  (#36).

## Previous builds

Current feature surface of the repository, summarized:

### Added

- Post-turn review gate: numbered evidence bundles per agent turn, strict reviewer
  output parsing, classified transmission of every result to the implementing model,
  bounded correction cycles with deferred-at-cap semantics, and command-driven reruns,
  pauses, cancellations, and ad hoc reviewer questions.
- Multiple reviewers over one evidence bundle (Codex, Claude, Pi adapters plus generic
  CLI), any-`needs_changes` gating, `pass_with_warnings` for mixed results, and a
  completed pass surviving another reviewer's infrastructure error.
- Delegated execution: bounded background subtask workers in isolated worktrees with
  independent landing, source-mutation lease, conflict gates, bounded retry and
  failover, steering and interruption, and durable landing-manifest crash recovery.
- Native web tools: `WebSearch` (DDGS), `WebFetch` (HTML/PDF), `BrowserExtract`, and a
  bounded Pi-native semantic browser with DNS-rebinding-hardened egress and
  approval-required consequential actions.
- `ApplyPatch` tool: one structured V4A operation per call with workspace confinement,
  atomic staged writes, and serialized mutation windows.
- Background shell tools (`ShellStart`, `ShellList`, `ShellLog`, `ShellSend`,
  `ShellStop`) with detached process groups and lifecycle wakes.
- Durable evidence and recovery: integrity-checked execution manifests, landing-manifest
  crash recovery, and exact-session restart restoration.

### Changed

- Review windows now reconcile to changed reviewer settings instead of blocking:
  a window saved under one reviewer configuration restores on reload with its
  preserved baseline, evidence, and completed history intact and is reviewed with
  the currently configured reviewers, and saving new reviewer settings through
  `/review-settings` reconciles open windows immediately in-session (an in-flight
  review finishes under its original selection; a window frozen with no usable
  reviewers becomes reviewable once its settings are fixed). A label/count-only
  notice reports the reconciliation; manual clearing remains for genuine
  corruption or an explicit operator choice. The persisted selection digest
  also covers unresolvable and duplicated selections, so a change that only
  swaps which configured selection is unavailable is reported on reload.
- Stale or duplicated reviewer selections no longer disable the whole gate:
  every resolvable reviewer still runs, each unresolvable selection produces an
  explicit bounded `reviewer_unavailable` outcome in the review results, and a
  window with zero usable reviewers is deferred (not cleared) until a reviewer
  can run. The documented mixed pass/error policy is unchanged: at least one
  completed `pass` still gates as `pass` (`pass_with_warnings`) alongside other
  reviewer errors, any `needs_changes` still blocks, and zero usable reviews
  still error rather than pass.
- Completed review history snapshots the display label of the configuration that
  actually ran each reviewer, so historical results keep their original reviewer
  identity after the window's configuration is reconciled to newer settings. New
  results additionally carry gate-owned non-secret identity — the adapter name and a
  one-way SHA-256 fingerprint of the effective reviewer configuration — so a same-id
  configuration replacement stays distinguishable after reload; the fingerprint is
  hash-only, not a reconstructable raw configuration snapshot. History entries without
  a saved identity (pre-migration sidecars) render with their raw reviewer id and are
  never relabeled or backfilled from current settings.

### Fixed

- Executor assignment continuity across the review lifecycle: correction turns,
  steering, and pass confirmation now follow the executor that actually served the
  previous turn — including a failover successor — instead of silently re-resolving
  to the first configured pool entry. A genuine failover is announced explicitly in
  the activity stream, recorded durably in the operation's assignment history, and
  every later turn follows the successor. Continuations hold at most one live lease
  at a time (the predecessor is released before the successor is acquired), so pool
  capacity no longer overcounts a failed-over task.
- Recovery session compatibility is now proven by the durable record: a persisted
  executor session is resumed only when the recorded selection matches the effective
  assignment, and — for external agents, whose id is a mutable catalog handle — only
  when that id still resolves to the same adapter/command/model fingerprint recorded
  at session creation. A changed assignment, an unverifiable legacy record, or a
  re-pointed agent id all fail closed to a new session with an explicit announcement
  naming the executor that takes over, so the announced assignment, the actual
  adapter invocation, the persisted record, and the UI agree.
- Subtask UI and watch labels carry the live executor identity through execution,
  continuation, and research progress — not only after settlement — and prefer the
  model reported by the actual adapter invocation (which shows execution-level model
  overrides exactly as executed) over resolving a stale entry id or external agent id
  against current settings. Catalog or settings changes can no longer relabel a task
  that already ran, and historical activity text is never re-labeled from current
  settings.
