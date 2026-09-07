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
