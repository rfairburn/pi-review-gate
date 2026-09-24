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

## [0.1.0-dev.79]

### Changed

- Remove the UI-only 4000-character answer bound from `AskUserQuestion` free-text
  answers: drafts and pastes beyond 4000 characters are kept in full and submit
  without data loss in both the hosted editor and the fallback field (the
  controller never applied an answer cap). Extract the host chat-editor creation,
  theme, and live-keybinding wiring into a shared host-agnostic adapter
  (`src/host-editor.ts`) that the question UI now consumes, and deduplicate the
  identical peer-module discovery/loading of `src/settings/menu.ts` and the
  question loader into one shared host peer-loader (`src/host-peer-loader.ts`)
  with unchanged resolution behavior and test seams.

## [0.1.0-dev.78]

### Changed

- Use Pi's chat editor in `AskUserQuestion` free-text answers, including configured
  text-entry bindings, multiline editing, movement, deletion, yank, and undo. Keep
  Enter submission, Escape/back with the draft preserved, choices and Decline,
  and the 4000-character answer bound; fall back to the basic field if the host
  editor is unavailable.

## [0.1.0-dev.77]

### Added

- Add an explicit `inPlace: true` `SubtasksContinue` for a stopped execute task without
  a verified recovery checkpoint (including checkpoint staging/verification failure): the task
  continues in exactly its retained managed worktree — never recreated, copied, reset,
  checked out, or cleaned — after a strictly read-only preflight that verifies writer
  quiescence, worktree identity, detached HEAD against the task's candidate lineage, and
  landing-recovery safety. The continuation is told the truth about the reused folder:
  its state is neither checkpoint-verified nor reviewed, a failed staging attempt may
  have staged Git index entries, and a fresh executor session does not restore prior
  hidden state. The later candidate is still checkpoint-verified and passes the normal
  configured review and landing gates.

### Changed

- Extend the shipped orchestrator recovery runbook and the public recovery and
  delegated-execution documentation for retained-worktree reuse after a checkpoint
  staging failure, keeping checkpoint staging failures (pre-review, reported back to the
  orchestrator) distinct from normal landing refusals and conflicts, and keeping
  `SubtasksForceMerge` an all-identified-work mechanical salvage rather than a
  continuation or review.
- Require configured subtask reviewers to treat concrete candidate-workspace defects
  as blocking, path-specific `needs_changes` findings. Primary review and the
  review-Off contract stay unchanged; a pre-review checkpoint failure cannot be
  fixed by a reviewer prompt.
- Preserve the launcher's historical generic-skill migration as shipped skill text
  evolves: immutable pre-namespacing identities still remove only proven unmodified
  old copies, while customized or uncertain files remain untouched.
- Preserve the strict defaults: ordinary `SubtasksContinue` still requires a verified
  checkpoint, a repeated in-place staging failure leaves no new checkpoint and the
  retained folder for another explicit attempt, landing recovery is never bypassed,
  no cache exclusion or disposable worktree is added, and with review off judgment
  stays with the orchestrator.

## [0.1.0-dev.76]

### Fixed

- Keep the bare `id-token: write` permission readable under a GitHub Actions-style
  multiline `permissions:` mapping in redacted evidence, including search,
  previews, deep reads, continuations and rendered results. Token-bearing
  assignments and occurrences outside that mapping remain redacted.

## [0.1.0-dev.75]

### Added

- Add a Review submenu with independent automatic primary and subtask review switches
  and reviewer sets. Legacy shared reviewer selections appear in both sets on load;
  Save writes the split format, while Cancel leaves the old file untouched. Both
  automatic layers may be Off without disabling manual primary review.
- Optionally keep unreviewed subtask landings in the primary review window for its
  normal model-idle review, including resolved conflicts and force/salvage paths;
  already-reviewed landings retain their existing checkpoint behavior. No landing
  triggers immediate review, and disabled automatic review records no synthetic PASS.

## [0.1.0-dev.74]

### Added

- Add `GitRead` for bounded, structured Git-history research: commit logs and inspection,
  two-revision diffs with indexed file/patch navigation, blame, refs, merge-base,
  historical tree/file reads and tracked-content search. The tool is immediately
  available in primary Plan/research and Pi-backed research subtasks, but hidden
  from other primary modes and execution subtasks. It accepts no shell or raw Git
  arguments, and leaves Claude research unchanged; Codex research retains its
  own read-only-sandboxed Git access without this structured tool. Worktree
  status/diff and SHA-256 object-format repositories are not supported.

## [0.1.0-dev.73]

### Changed

- Align ApplyPatch filesystem access with native write/edit: absolute paths,
  outside-workspace relative paths, home paths and symlinked targets are supported
  subject to host permissions and execution-environment restrictions. The working
  directory is a path-resolution context, not a filesystem sandbox; authorized
  scratch locations such as `/tmp` are intentional. Preserve patch correctness,
  source-change detection, cancellation, review and read-only role protections.

## [0.1.0-dev.72]

### Fixed

- Update real-agent-loop regression fixtures for Pi 0.87's `finishTurn` API,
  preventing the browser native-error test from spinning on the removed hook.
  Pin CI's agent-core runtime to 0.87.0 and refresh compatibility documentation;
  existing production behavior and error-handling assertions remain unchanged.

## [0.1.0-dev.71]

### Changed

- Namespace shipped orchestrator, execution and research skills with the
  `pi-review-gate-` prefix across launchers, startup cues and documentation.
  Preserve customized or ambiguously owned generic skills; remove only exact
  recognized historical copies, retaining recovery references for preserved
  generic orchestrator skills. Launcher-time atomic provisioning and role
  permissions remain unchanged.

## [0.1.0-dev.70]

### Fixed

- Count WebSocket upgrades rejected for premature payload bytes as refusals.
  Preserve connection-local rejection, byte accounting and sanitized diagnostics
  without invoking the session-fatal policy callback.

## [0.1.0-dev.69]

### Fixed

- Keep valid UTF-8 text reviewable when a multibyte character crosses the bounded
  capture sample boundary. Distinguish a cut sample from an incomplete character
  at end of file, preserving binary checks and existing capture limits.

## [0.1.0-dev.68]

### Fixed

- Settle cancellation during executor retry backoff through the verified
  cancellation path instead of reporting a recoverable executor failure. Preserve
  prior incident evidence and retained work, and keep checkpoint-verification
  failures critical and fail-closed.

## [0.1.0-dev.67]

### Changed

- Extract conflict-gate storage, root identity and validation into a focused
  module while preserving the controller's public type export and existing
  conflict/lease checks. Task orchestration and force-merge behavior are unchanged.

## [0.1.0-dev.66]

### Tests

- Make suppressed-completion watch regressions deterministic by controlling the
  watch deadline and delivery window instead of racing real-time sleeps. Cover
  cancellation, queued-checkpoint cleanup, legitimate earlier delivery, and a
  negative control without changing production behavior.

## [0.1.0-dev.65]

### Changed

- Extract browser diagnostics, error types and classifiers, operation/deadline
  primitives, and URL-policy helpers into focused modules. Preserve the
  interactive browser's existing exports, error identities, safety checks and
  runtime behavior while reducing mixed responsibilities in its manager.

## [0.1.0-dev.64]

### Changed

- Split background-controller tests into seven suites organized by lifecycle,
  steering, interruption/merge, persistence, notifications, watch/widget, and
  subtask-command behavior. Reuse shared fixture setup and update the execution
  test command while preserving all 71 scenarios and their assertions. Runtime
  behavior is unchanged.

## [0.1.0-dev.63]

### Changed

- Split extension-entrypoint tests into focused readiness, deferred-discovery,
  restoration, review-lifecycle, and uncertain-transmission suites with shared
  fixture setup. Preserve all 55 scenarios and their production entrypoints;
  runtime behavior is unchanged.

## [0.1.0-dev.62]

### Added

- Both launcher paths now install and refresh execution and research skills
  alongside orchestrator and its recovery reference, preserving unrelated
  custom skills. Ship capability-aware role guidance and concise startup cues
  while keeping detailed instructions in the skills rather than system prompts.
- Explain capability-based delegation, background-job lifecycles, and diagnostic
  execution that returns evidence without fabricated source changes. Research
  remains read-only and delegation never expands the parent's permissions.

### Changed

- Expose authorized deferred-tool names in the tool-search description and
  compact names with purposes in startup guidance. Exclude role-baseline tools,
  keep inventories stable across ordinary deferred activation, and recompute
  them when actual mode or permission boundaries change. Full schemas remain
  deferred; unauthorized tools remain unavailable.

## [0.1.0-dev.61]

### Added

- AskUserQuestion provides session-local questions with suggested choices and
  free-text answers. Async questions let work continue; later answers arrive
  without interrupting the active run. Explicit synchronous questions wait for
  an answer or decline, with no acknowledgement-only turn for a declined
  question-only batch.
- Keep pending questions discoverable in a persistent, non-focus-taking panel
  above the chat editor. Ctrl+Alt+Up (Ctrl+Option+Up on macOS), displayed in the
  panel, opens or collapses the question UI without showing question text while
  collapsed. Preserve editor drafts, existing message-restoration bindings, and
  session boundaries; reject unavailable interactive hosts and binding conflicts.
- Handle the collapse shortcut in free-text answers and prevent unrecognized
  terminal key sequences from corrupting answer text while preserving ordinary
  typing and bracketed paste.

## [0.1.0-dev.60]

### Fixed

- Restore retained settings-menu selection in real Pi sessions loading the
  compiled CommonJS extension. Resolve host-provided TUI peers from the running
  Pi installation when package-name loading cannot use the host's aliases,
  instead of silently falling back to the position-resetting plain selector.
- Connect the custom selector to Pi's supplied live keybindings manager so
  configured selection keys are honored. Preserve stable menu-row identities,
  submenu return positions, Save/Cancel behavior, and non-TUI fallback.

## [0.1.0-dev.59]

### Fixed

- Verify live browser download retention independently of click results' bounded
  observation window, including a deliberately delayed download. Tests still
  require actual default-off cancellation, approved exact-byte saving, and
  retained-handle consistency; production behavior is unchanged.
- Ship the retained settings-menu selection changes and capacity-recovery test
  correction recorded under b57 and b58. Neither candidate was published because
  its main-branch full suite failed.

## [0.1.0-dev.58]

### Fixed

- Stabilize the browser-capacity recovery test by waiting for Chromium's internal
  error-page navigation to settle before attempting recovery, instead of relying
  on a fixed delay. Production behavior and recovery/safety assertions are unchanged.
- Ship the retained settings-menu selection changes recorded under b57; that
  candidate was not published because its main-branch full suite failed.

## [0.1.0-dev.57]

### Fixed

- Terminal settings menus retain the selected row after toggles and other staged
  changes, using Pi's supported SelectList component and stable row identities.
  All eleven redisplayed settings menus are covered, including Web permissions,
  reviewers, worker resources/routes, and parent menus returning from pickers.
- Preserve option ordering, confirmations, cancellation, and persistence behavior.
  RPC and hosts without custom TUI support retain the existing plain selector;
  selection position is local UI state, not a saved configuration setting.

## [0.1.0-dev.56]

### Added

- Optional viewport dimensions for BrowserScreenshot, retaining the 1280×720
  default and restoring the prior viewport after capture for responsive testing.
- BrowserClick coordinate targeting for visual elements without accessibility
  refs. Coordinate clicks temporarily apply the targeted tab's last successful
  viewport screenshot dimensions, then restore the prior viewport. Element
  screenshots do not establish or replace this reference; without one, coordinate
  clicks explicitly request a viewport screenshot while ref clicks remain usable.

### Security

- Coordinate clicks retain owned-tab targeting, structural safety checks and
  configured interaction approvals. Snapshot refs remain the primary interaction
  mechanism; completed interactions do not expire the stored viewport dimensions,
  and current-target checks still apply. Drag/modifier gestures are not included.

## [0.1.0-dev.55]

### Added

- Independent managed-browser permissions for model credential entry/submission,
  uploads, download saving, clipboard text, camera, microphone, geolocation,
  service workers, popup restrictions, and local networks. Controls default off;
  acknowledged, persistent YOLO overrides these controls and per-action approvals.
- `BrowserUpload`, `BrowserDownloadSave`, and `BrowserClipboard` with explicit
  owned-tab targeting and configured interaction approvals. Download destinations
  follow model write authority; unsaved-download retention is configurable in Web
  settings, defaults to eight per session, and accepts zero for unlimited retention.
- Opt-in local-network access includes loopback, private networks, and link-local
  cloud metadata endpoints, with explicit warnings. BrowserExtract and WebFetch
  remain isolated from managed-browser permission changes and public-only.

### Changed

- Human credential/form submission and uploads remain independent of model-only
  controls. Device access remains subject to actual browser, hardware, and OS
  availability; clipboard results distinguish headless and headed scope.
- Service-worker policy changes use controlled browser replacement with best-effort
  in-memory state restoration. Previously admitted popup tabs survive replacement
  beyond the ordinary new-tab limit without granting unrelated tab admission.
- Live permission revocation reports its actual outcome; failed or timed-out
  revocation triggers owned-browser containment and reports unconfirmed cleanup
  rather than claiming permissions were removed or closure succeeded.

## [0.1.0-dev.54]

### Fixed

- Shell and Subtasks failure cards now correlate failed model-stream attempts
  with bounded, sanitized diagnostics instead of attributing every displayed
  error to tool execution. Missing evidence remains explicitly unknown.
- Failed attempts can supply a concise diagnostic note to subsequent model
  context without fabricating tool results. Notes track actual execution,
  consumption, and session changes; retry and transport behavior are unchanged.
- Preserve shutdown ordering so diagnostic hooks do not delay existing review
  cancellation and executor cleanup.

## [0.1.0-dev.53]

### Changed

- Make adherence to the existing contribution verification policy explicit in
  `AGENTS.md`, including coordinated integration-owner full-suite checks for
  process, Git, and filesystem phases, focused worker checks, truthful evidence,
  and commands that preserve the live build. Test requirements and runtime
  behavior are unchanged.

## [0.1.0-dev.52]

### Added

- Visible/headless selection for the managed interactive browser in Web settings.
  Saving a changed mode immediately replaces an open browser, restoring intended
  tab URLs and the active tab with best-effort memory-only cookies, local storage,
  and IndexedDB transfer. Results disclose failed restoration, redirects, and state
  limitations; old session, tab, and ref handles are invalid after replacement.

### Changed

- Browser idle expiry accepts `0` to disable idle closure. Detectable trusted
  pointer, keyboard, and wheel input renews finite idle leases alongside model
  activity; explicit close and session cleanup remain effective. Documentation
  recommends `0` for hands-on browser use and explains detection limitations.
- BrowserExtract remains an independent headless URL-rendering tool, with no managed
  tab or authentication-state reuse. Interactive actions still target explicit tab
  IDs; visibility does not change tool exposure or browser permissions.

## [0.1.0-dev.51]

### Changed

- Strengthen orchestrator prompts, tool guidance, and the shipped skill to prefer
  useful independent ready work over slot-filling, with legitimate waiting and
  sequential execution when parallel work would not help.
- Encourage bounded, coherent subtasks with explicit invariants and acceptance
  criteria without assuming worker model identity. Keep dependent edits sequential,
  preserve coupled changes and their focused tests, and reassess from observed
  progress rather than automatic time limits.
- Add representative orchestration evaluation scenarios and policy-wiring tests,
  explicitly distinguishing guidance checks from evidence of model judgment.
  Scheduler, routing, review gates, and recovery behavior remain unchanged.

## [0.1.0-dev.50]

### Changed

- Explicit ForceMerge can merge identified retained worker work without a verified
  checkpoint, retaining source attribution and unresolved evidence across restart
  rather than inventing review or checkpoint success.
- ForceMerge materializes text conflicts in one call without a second force option.
  Binary and other unrepresentable conflicts preserve target content, retain available
  worker content alongside, and record unresolved operations for manual resolution
  while the remaining identified work merges. Normal reviewed landing is unchanged.
- Protect sidecar destinations from incoming-path collisions and overwrite races,
  and stream large nonconflicting files during explicit conflict materialization.
  Unsupported atomic sidecar installation fails closed without an unsafe fallback.
- Correct conflict progress reporting and recovery guidance to distinguish actual
  workspace changes, preserved conflicts, and verified continuation eligibility.

## [0.1.0-dev.49]

### Changed

- Clarify detached managed-worktree ownership in worker prompts and the shipped
  orchestration skill: issue branches belong to the separate target checkout, and
  workers must preserve the synthetic captured baseline rather than switch branches.
- Document recovery with current Git and harness capabilities, including retained
  commit and dirty-content preservation, evidence-based export, and the distinction
  between supported continuation and explicitly authorized manual salvage. No new
  recovery engine or ForceMerge behavior is introduced.

## [0.1.0-dev.48]

### Changed

- Make `/subtask-add <prompt>` submit one task in a new execution group using
  existing routing and workspace defaults. All supplied text, including JSON and
  execution-id-looking text, is treated as instructions; the former execution-ID
  plus task-JSON slash-command syntax is removed.
- With no arguments, `/subtask-add` collects task fields and new/existing-group
  settings interactively, then asks for explicit confirmation before submission.
  Cancellation creates no work. Structured model-facing Start/Add APIs and batch
  support remain unchanged.

## [0.1.0-dev.47]

### Fixed

- Make the background-submission regression test independent of host speed by
  explicitly holding and releasing fake worker completion, while preserving
  nonblocking submission, independent landing, and capacity-notification checks.
  Production behavior is unchanged.
- Attach worker lifecycle rejection handling before awaiting the task-start manifest
  write, preventing unhandled rejections during early interruption while preserving
  the original failure and cancellation reporting.

## [0.1.0-dev.46]

### Changed

- Remove ApplyPatch's legacy structured `operation` input and compatibility-only
  implementation. Only the canonical `patch` envelope is supported; legacy requests
  are rejected before filesystem mutation. Canonical multi-file behavior, workspace
  confinement, partial-failure reporting, and result presentation remain unchanged.

## [0.1.0-dev.45]

### Fixed

- Show repeated submitted instructions only once in expanded SubtasksStart and
  SubtasksAdd results when the captured worker prompt contains the exact text.
  A rendering-only marker replaces the repeated span; differing instructions,
  worker-specific content, and unavailable-prompt status remain visible. Collapsed
  results and model-visible context are unchanged.

## [0.1.0-dev.44]

### Fixed

- Avoid duplicate completion notifications for synchronous model-tool force-merge,
  interrupt-with-merge, and conflict-resolution landings. Direct results retain the
  group completion and capacity information, and completed operations still cancel
  stale watches. User-command, asynchronous, failure, and recovery notifications
  remain unchanged.
- Correct documentation and model guidance about completion notification contents;
  execution revision and task timing are available through `SubtasksInspect`.

## [0.1.0-dev.43]

### Changed

- Store Worker resources and external agents as ID-keyed catalogs, with alphabetical
  Worker resources display and no catalog reorder controls. Explicit role priorities,
  independent reasoning settings, shared capacity, and reviewer order remain separate.
- Missing Execution or Research priorities now mean no models, just like empty lists;
  loading or saving never infers priorities from the resource catalog.
- Import legacy catalog arrays at load time and write canonical objects on normal
  saves, without rewriting configuration during load. Legacy imports are deprecated;
  removal is tracked in #116 without a fixed date or version. After removal, an interim
  conversion-supporting release can save old configurations before upgrading.

## [0.1.0-dev.42]

### Added

- Publish native Windows PowerShell `ShellStart` support: fixed platform shells,
  Pi-compatible invocation, and Windows Job Object ownership that retains descendants
  after shell-root exit, with fail-closed readiness and host-exit cleanup. Includes
  the Windows launcher skill-publication contention correction recorded under the
  b41 candidate below. b41 was not published because native test teardown failed
  ([#99](https://github.com/rfairburn/pi-review-gate/issues/99),
  [#108](https://github.com/rfairburn/pi-review-gate/issues/108)).

### Fixed

- Tolerate bounded transient Windows file-handle contention when deleting native
  lifecycle-test temporary files, preserving process-death assertions and surfacing
  persistent cleanup failures
  ([#113](https://github.com/rfairburn/pi-review-gate/issues/113)).

## [0.1.0-dev.41]

### Added

- Run `ShellStart` in PowerShell on native Windows, preferring `pwsh.exe` then
  `powershell.exe` with Pi-compatible invocation and UTF-8 initialization; retain
  Bash on macOS/Linux with no shell-selection setting. Windows Job Object ownership
  and a watchdog account for descendants after shell-root exit and preserve
  fail-closed readiness, stop, and host-exit cleanup. Add native Windows shell tests
  as a publishing prerequisite alongside the existing launcher checks
  ([#99](https://github.com/rfairburn/pi-review-gate/issues/99)).

### Fixed

- Retry transient Windows skill-publication rename contention with a bounded delay
  while preserving atomic replacement and fail-closed errors. Report the underlying
  filesystem error when publication fails during concurrent launcher startup
  ([#108](https://github.com/rfairburn/pi-review-gate/issues/108)).

## [0.1.0-dev.40]

### Added

- Add a native Windows `.cmd` launcher and Node helper with configuration discovery,
  first-launch initialization, development rebuilds, packaged-extension handling,
  native pinned-DDGS setup, skill refresh, argument forwarding, and exit propagation.
  Ship the entry point as `pi-review-gate-cmd` and gate publishing on native Windows
  launcher tests; the macOS/Linux launcher remains unchanged
  ([#108](https://github.com/rfairburn/pi-review-gate/issues/108)).

## [0.1.0-dev.39]

### Documentation

- Inventory runtime, optional-feature, launcher, and development dependencies;
  document Git on `PATH` for delegated worktrees, user-installed versus provisioned
  web dependencies, and current platform limitations
  ([#109](https://github.com/rfairburn/pi-review-gate/issues/109)).

## [0.1.0-dev.38]

### Added

- A technical SVG diagram in the root README illustrates orchestration,
  representative executors across workspaces, independent review, and
  role-scoped tool capabilities
  ([#105](https://github.com/rfairburn/pi-review-gate/issues/105)).

## [0.1.0-dev.37]

### Removed

- Removed six unused renderer aliases: `renderSearchResult`,
  `renderExpandedSearchResult`, `renderApplyPatchExpandedResult`,
  `renderSearchToolsResult`, `renderExpandedSearchToolsResult`, and
  `searchToolsRenderResult`, plus the unused evidence formatter
  `selectionLabel` and its supporting type import
  ([#103](https://github.com/rfairburn/pi-review-gate/issues/103)). No repository
  consumers were found in their history; registered tools and canonical
  renderers are unchanged. These names were exported from shipped modules:
  external consumers deep-importing them must update before upgrading.

## [0.1.0-dev.36]

### Changed

- ApplyPatch and tool-discovery result views now share their identical
  text-wrapping helpers, removing duplicate code without changing rendering
  behavior ([#101](https://github.com/rfairburn/pi-review-gate/issues/101)).

## [0.1.0-dev.35]

### Changed

- Configuration now defaults to `review-gate.json` in Pi's agent directory on
  every platform, honoring `PI_CODING_AGENT_DIR`. The sole compatibility
  fallback is `~/.config/pi-review-gate/config.json`; existing fallback files
  are used without automatic migration. Runtime explicit config overrides and
  persistent-launcher override isolation remain unchanged
  ([#94](https://github.com/rfairburn/pi-review-gate/issues/94)).
- Native PowerShell tools now receive the same execution-role catalog,
  evidence, and progress handling as Bash when available and authorized.
  Research restrictions remain unchanged. This is basic compatibility work,
  not a claim of complete native Windows or ShellStart support
  ([#94](https://github.com/rfairburn/pi-review-gate/issues/94)).

## [0.1.0-dev.34]

### Fixed

- Concurrent launches now publish complete orchestrator skill files with an
  atomic replacement instead of racing over the destination. Existing file
  modes, configuration initialization, and fail-closed publication errors are
  preserved ([#97](https://github.com/rfairburn/pi-review-gate/issues/97)).
- Dispatch-card lifecycle regressions now retain simulated live row owners and
  distinguish recoverable interrupted tasks from permanently settled tasks,
  covering both continued subscriptions and eventual cleanup
  ([#97](https://github.com/rfairburn/pi-review-gate/issues/97)).

## [0.1.0-dev.33]

### Added

- Every registered extension tool result now expands natively and faithfully (#93). All
  37 tools — including the previously rendererless `WebSearch` and `search_tools` —
  share one native expansion mechanism with actionable collapsed cards and expanded
  views showing the complete original model-visible inputs and results: no additional
  masking, omission, summarization, or truncation in the human view. Expansion hints
  (`(ctrl+o to expand)` / `(ctrl+o to collapse)`) follow the configured binding
  (ctrl+o by default), render width-safely on every card, and interaction stays fully
  native: the global keyboard binding and per-card clicking in fullscreen mode.
  Expansion reuses the recorded tool-call arguments instead of truncated copies, so
  expanded cards show the complete `ShellStart` command, the actual `ShellSend` input,
  the submitted `BrowserFill`/`BrowserType`/`BrowserSelect` values, the complete
  `ApplyPatch` envelope and final diff, and every returned search, log, snapshot, and
  evidence record — the collapsed `ShellLog` preview shows the tail of its returned
  range with an omission count, and expansion shows the complete returned range.
  `SubtasksStart` and `SubtasksAdd` cards update automatically when a task dispatches,
  showing the prompt captured at the transport boundary plus the worker worktree and
  captured base commit; queued cards truthfully say not yet sent. Control bytes in
  recorded text render as visible escape notation instead of being executed or
  deleted, and image payloads stay native images. Expansion remains presentation-only
  — no fetching, polling, re-execution, or key handlers — and protections applied
  before data reaches the model are unchanged (Refs #93).

## [0.1.0-dev.32]

### Fixed

- Shell result views now wrap grapheme clusters using terminal-cell widths, including
  default-presentation emoji such as ⏰ and ✅, and safely substitute a placeholder
  when a glyph cannot fit the available row. Collapsed previews apply their ten-row
  budget after wrapping, with an omission count and expansion hint, so long retained
  log lines no longer produce oversized collapsed cards. The expanded text fallback
  preserves the retained output; native expansion, redaction, and shell execution
  behavior remain unchanged (Refs #58).

## [0.1.0-dev.31]

### Added

- Expanded tool-result detail for the one-shot web acquisition tools: the actual
  `WebFetch` and `BrowserExtract` registrations are wired through the shared native
  `expandableResult(collapsedRenderer, expandedRenderer?)` mechanism with the native
  bounded collapsed preview preserved (output that fits the budget renders unchanged;
  a large acquisition keeps its first lines behind an explicit omitted-lines notice
  with an expand hint), and expansion renders the shared web detail view — a
  compact summary line plus the safe retained response details (document type, source,
  acquisition, extraction metadata, table/pagination descriptors, index range and
  continuation, truncation notes, and the untrusted retained content between explicit
  markers). Pending/partial, error, empty, and cancelled native states keep their
  existing rendering, raw private fields (raw paths, transport details, private error
  bodies) never appear, and expansion stays presentation-only: no key handler, no
  mirrored expansion state, and no re-fetch, cache, browser, or filesystem access when
  a row expands. Existing interactive browser, shell, and subtask views remain
  unchanged; WebSearch and discovery keep Pi's native fallback rendering (Refs #82).

## [0.1.0-dev.30]

### Added

- The five background shell tools (`ShellStart`, `ShellList`, `ShellLog`,
  `ShellSend`, `ShellStop`) now expand through the shared native tool-result expansion
  mechanism: every registration is wired through
  `expandableResult(collapsedRenderer, expandedRenderer)` with a collapsed view that
  preserves Pi's native fallback presentation (bounded preview with the expand hint
  when collapsed, full returned text when expanded) and a per-tool expanded detail
  view rendering the bounded retained snapshot the call recorded — command and job
  lifecycle provenance, log range and drop counts, and stdin delivery state. Expansion
  is display-only: nothing is re-read, re-fetched, or reconstructed from live job
  state (restored sessions render exactly what was recorded, and older results without
  structured details degrade to the retained text preview), pending/partial, error,
  and empty states stay bounded and stable in both expansion directions, and no
  competing key handler is registered (the configured binding, Ctrl+O by default,
  still toggles both directions). No mirrored expansion state, no reruns or network
  requests, and no change to tool schemas, authority, redaction, model output budgets,
  or retention limits (Closes #58).

## [0.1.0-dev.29]

### Added

- Native expandable result views for the interactive browser family: all eighteen
  interactive `Browser*` tools (from `BrowserOpen` through `BrowserClose`) now register
  one shared `expandableResult` wrapper (`src/web/browser-renderer.ts`) whose collapsed
  view keeps the previous useful native presentation — a bounded preview of the
  already-returned model-visible text with an explicit omission marker — and whose
  expanded view renders family detail from the tool's returned `details.response`:
  semantic snapshots, console/error and network diagnostics with cursor and retention
  bounds, allowlisted semantic inspection, history/tabs, interaction effect accounting,
  wait/scroll observations, screenshot capture bounds, and close teardown results.
  Screenshots keep native Pi image presentation in both states; encoded image data is
  never printed. Expansion only re-renders already-returned safe content under the
  existing allowlists and redactions (no network request, navigation, action, or read
  on toggle, no competing key handler, and no mirrored expansion state), and
  `WebSearch`, `WebFetch`, and `BrowserExtract` are unchanged pending their own detail
  views (Refs #60).

## [0.1.0-dev.28]

### Added

- Expanded detail view for the `Subtasks*` tool family: every one of the nine tools'
  returned results now renders a cohesive expanded detail view under Pi's native
  expansion binding (Ctrl+O by default), contributed as the shared expansion mechanism's
  expanded callback and selected by the native `options.expanded` flag. Expansion stays
  presentation of already-returned data only — no competing key handler, no mirrored
  expansion state, and no rerun, poll, artifact read, log fetch, or history retrieval; the
  #56 collapsed cards are passed through unchanged and re-collapse restores them
  identically. The expanded view is bounded and provenance-separated: what the executor
  process observed (`executor_observed`), what the worker wrote in its final response
  (`worker_claim`, never treated as verification), reviewer verdicts
  (`reviewer_verdict`), and the authoritative task/landing state from durable records
  render as distinct sections, with the returned snapshot's "as of" freshness and an
  explicit uncertainty note while any task is still active. Unavailable sources,
  retention-truncated records, omitted ranges, and capped rendering are disclosed, never
  cut silently; simple acknowledgements (`SubtasksWatch`, `SubtasksMarkClean`) render
  only their returned fields, unrecognized result shapes fall back to the returned
  summary, streaming results render a bounded pending view, evidence selector failures
  stay task-scoped, and private model reasoning never appears. Deep-read chunks keep the
  retained text's own whitespace, and all lines are clipped in terminal display cells
  (CJK and default-presentation emoji measured as two cells) so narrow rows stay readable
  (Refs #59).

## [0.1.0-dev.27]

### Added

- Shared native tool-result expansion foundation: one Pi-native `options.expanded`
  mechanism in `src/tool-result-expansion.ts` covers every extension-owned tool with
  potentially expandable returned data. Tools with an existing custom result renderer —
  the nine `Subtasks*` tools and `ApplyPatch` — are wired through
  `expandableResult(collapsedRenderer, expandedRenderer?)` with their current renderer
  preserved as the collapsed view, so family detail issues can contribute expanded
  callbacks without touching registration; until then their presentation is unchanged in
  both expansion states. Rendererless tools (the five `Shell*` tools, the web/browser
  family, and `search_tools`) keep Pi's native fallback rendering, which already expands
  and re-collapses with a bounded preview. Expansion stays presentation of already
  returned data only: no competing key handler (the configured binding, Ctrl+O by
  default, still toggles both directions), no mirrored state, no reruns, network
  requests, log fetches, artifact reads, or history retrieval, and no change to tool
  schemas, authority, redaction, model output budgets, or retention limits (Refs #57).

## [0.1.0-dev.26]

### Changed

- Collapsed `SubtasksInspect` tool cards now distinguish each inspection mode at a
  glance: the call line names the task and effective selector (`status`, activity
  offset, `find` query with optional filter, requested entry window, entry/chunk deep
  read, call handle, or cursor continuation — opaque cursor tokens are never displayed),
  and evidence result lines lead with the operation-specific outcome — returned entry
  range with provenance mix and retention-truncated entries, match totals with list
  truncation, call/result resolution (`returned`, an observed result with unresolved
  pairing, or in flight with no observed result), deep-read chunk size and continuation,
  or newer-entry count for cursor reads — plus available continuations and important
  empty/unavailable/truncated outcomes instead of scheduler boilerplate. Query/selector
  text is redacted before display, retained content and private reasoning never appear in
  the collapsed card, expanded results keep their previous summary-first rendering, and
  native pending/error/cancelled rendering, retrieval bounds, and authority are unchanged
  (Closes #56).

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
