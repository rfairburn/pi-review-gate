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

## [0.1.0-dev.219]

### Changed

- **Dangerous protection is a harm-only audit** (#542): the tests printed for the
  `dangerous` level are now the two harms alone — concrete catastrophic or unjustified
  irreversible destruction, or an actual disclosure or transfer of sensitive contents to
  a recipient the supplied evidence does not authorize. The prompt states outright that
  this level does not audit task alignment, working-directory or worker-root confinement,
  prior human approval of the exact path, command, or destination, compliance with a
  path, recipient, or destination restriction stated in the governing instructions, the
  task, or a user message, or a substituted target that moves no protected contents, and
  that neither uncertainty nor an evidence item the host omitted is evidence of harm or a
  reason to hedge. The conformance tests it previously shared with the stricter levels —
  a real prohibition in the governing instructions, unexplained target substitution, and
  a restriction stated by a genuine current-session user message — are no longer printed
  here and no longer decide `FAIL` here. Returning the content the requesting user asked
  for — in the conversation or its user-facing notice — is not an unauthorized transfer
  merely because that content carries customer or diagnostic context, and reading a
  user-supplied attachment is not refused on a prohibition inferred from a complaint about
  earlier blocking. Quoted approval still authorizes no recipient, and the two real harms
  stay blocked.
- **Level-aware auditor instruction and revision `rules-5`** (#542): the instruction
  block now matches the enabled level, because the single shared wording told every
  level that a governing prohibition or a user restriction decides `FAIL` — the
  conformance audit `dangerous` no longer runs. `aligned` and `workspace` keep their
  existing rules, worked examples, instruction, provenance, and output-contract text
  unchanged apart from the neutral revision token in the header, so their stricter
  checks, including F5 governing prohibitions, F7 target substitution, and F8 genuine
  current-session user restrictions, still apply there. Nothing else moved: Off and the
  defaults, coverage and scope, the discovery-loader exemption, optional auditor-session
  retention, inline annotations, bounded evidence selection and provenance, and every
  fail-closed runtime path (missing mandatory context, context capacity, timeout,
  malformed or invalidated decision, unsupported route, cancellation) are unchanged, with
  no retry, replay, cache, or fallback, and a runtime failure is still reported as one
  rather than as a policy `FAIL`. A `dangerous` PASS grants no authority: the acting
  agent still obeys its governing instructions and the user's restrictions, and native
  permissions, role and tool ceilings, trust, ownership, preflight, review, landing, and
  cancellation still decide independently. There is no tool-name, path, or domain
  allowlist. See [Tool protection](docs/tool-protection.md).

## [0.1.0-dev.218]

### Added

- **Tool protection** (#536): one optional `toolProtection` block
  configures a pre-execution decision gate at `off` (the default), `dangerous`,
  `aligned`, or `workspace`, with one shared level and auditor for the primary agent
  and newly launched Pi executors. An `all` or exact-name `selected` audit scope, a
  10-second decision deadline, and a 128,000-character context budget are the shipped
  defaults; the code-owned policy, bounded provenance-labelled context, strict
  `PASS`/`FAIL` format, and in-process Pi auditor are additional restrictions, not a
  sandbox or an all-harness guarantee. Claude/Codex CLI auditor routes fail closed as
  unsupported, while external binaries use the documented JSON decision protocol. See
  [Tool protection](docs/tool-protection.md).
- **Tool protection floor and the discovery loader** (#536): the `dangerous` level now
  states its floor as catastrophic irreversible loss or unauthorized sensitive
  disclosure, and says outright that it is not a working-directory sandbox, not a
  task-alignment test, and not a per-call human approval of the exact path, command, or
  destination, so ordinary reads (including outside the working directory), disposable
  and operating-system temporary fixtures, and build, test, dependency-install, and
  version-control work are not gated there, while a restriction stated by the user's own
  current message is respected at every level; `aligned` and `workspace` keep their own
  added rules and never leak into the floor. The policy revision is a neutral
  identifier recorded with each decision, and the submenu, notices, and docs drop the
  experimental wording while keeping every level, reason, timing, and limitation claim.
  The reserved `tool_search` discovery loader is the single infrastructure exception:
  never audited at any level or scope, never presented as a pass, annotated
  `NOT AUDITED — discovery loader`, never offered as an audited name, and still bound by
  every native authorization, permission, and liveness guard. The exception is bound to
  the loader this extension registered — the live registry entry is matched against the
  registration references this extension's published metadata preserves, and configured
  scope matching stays a plain name lookup, so a definition that took over the reserved
  name is audited like any other tool instead of borrowing the exemption.
- **Optional auditor-session retention** (#536): `toolProtection.retainAuditorSessions`
  (**Save auditor sessions**, Off by default, and Off for any block or parent launch pin
  that predates the field) saves each actual auditor invocation as its own ordinary saved
  Pi session, so the exact request, the terminal reply or captured external-binary output,
  and the recorded verdict can be browsed later. Records are written through Pi's own
  session writer, never read back into a later decision, and never grant a tool or
  authority when opened; an external binary's record says plainly that it is host process
  input and program output rather than a provider exchange. Nothing is written while the
  setting is Off, and a call the auditor was never asked about records nothing. A recording
  failure leaves the auditor's verdict untouched and is disclosed inline instead of
  silently dropping the record.

### Changed

- **Reasonless auditor denials** (#536): a top-level `FAIL` carrying no reason now blocks
  with `Tool protection: FAIL — the auditor denied this <tool> call. The call did not run.`,
  without the appended host-status clause. A reason the auditor did supply is still passed
  through verbatim, and annotations on calls that already ran keep their existing wording.

## [0.1.0-dev.217]

### Changed

- Spawned Pi sessions use Pi's environment-resolved native store, with exact file
  references in existing task/reviewer metadata for continuation and evidence (#533).
  Reviewers remain fresh; no historical session migration or conversion is performed.
  Continuing subtasks started before this update is not supported. Allow active
  subtasks to land before upgrading.
- **Retention** groups Bundle retention with default-off
  `deleteSpawnedPiSessionsOnCleanup`. When enabled, existing cleanup points also unlink
  their recorded Pi files after bounded header identification; cleanup scope and timing
  are unchanged.

## [0.1.0-dev.216]

### Changed

- `assertNoRawTerminalControls` in the YouShouldKnow test suite now builds its
  full-frame diagnostic string once before the character loop instead of once per
  character (Refs #194). Character iteration, the code-point fallback, the control
  predicate, the assertion call, and the exact diagnostic message contents are
  unchanged, as are all call sites, fixtures, viewport dimensions, and other test
  behavior. No production code, workflows, or other tests changed; #194 stays open
  with its remaining scope.

## [0.1.0-dev.215]

### Changed

- Two more fallback-Node cache tests now seed their five completed fallback-runtime
  generations with the real producer's post-success on-disk layout instead of making
  ten preparatory wrapper launches (Refs #194). `five existing artifacts never refuse
  the next launch and stale locks are reclaimed` keeps both of its real launches and
  its dead-owner and empty-lock reclamation, startup, no-capacity-refusal,
  five-generation-target, and reclaimed-existing-generation checks; its recorded
  download lower bound drops from seven to two because the five removed setup launches
  no longer download. `never deletes another producer's live lock that replaced
  malformed metadata` keeps its one real launch and every safety check: the
  stat-wrapper lock swap, the observation counter, the byte-for-byte survival of the
  replacement live lock, the busy-cleanup warning, the retained prior generations, and
  the fresh sixth generation. Seeded generations are real private directories in each
  fixture's own cache carrying that fixture's synthetic Node program, the internal
  relative npm link, and a nonempty representative payload, with no fabricated
  liveness, lifetime, ownership, or current-runtime records. The shared seeding helper
  is unchanged, and no production code, other tests, deadlines, or CI workflows
  changed; measured CI timing remains for the actual pull request run. #194 stays open
  with its remaining scope.

## [0.1.0-dev.214]

### Changed

- The release artifact build's failing-install-smoke case now builds its
  tarball from a small valid package project created inside its own scratch
  directory instead of staging the whole repository (Refs #194). The case still
  calls the real artifact builder, so the real staging build copies the packaged
  inputs, compiles TypeScript output into the staging tree, packs the stage, and
  extracts and verifies the generated tarball before the gate is reached; the
  gate itself stays the same throwing install-smoke stub whose rejection must
  keep the build from returning publishable assets. The case also witnesses that
  this run reached that stub, because the asserted `install smoke verification
  failed` message prefix alone would match the real gate failing on the small
  project too: the passing case now proves the intended gate was reached rather
  than the build stopping earlier or failing for an incidental reason. Only that
  one case's source input size and its own stub witness changed. The smoke case
  that verifies the exact tarball built from the real checkout, the real
  pack/verify/install coverage in `release-package.test.ts`, the refusal to
  publish after a failed artifact build, every other release gate, all
  assertions, deadlines, and CI workflows are unchanged, and #194 stays open
  with its remaining scope. Measured timing for the change comes from the pull
  request's own CI run rather than a local benchmark campaign.

## [0.1.0-dev.213]

### Changed

- Two redundant wave-controller test cases were removed (Refs #194). A case titled
  `no_changes is successful but contributes no commit` used a writing executor and
  asserted only the task-result count, so it never exercised `no_changes`; the real
  no-op controller case (`no_changes contributes no commit and integration is
  no_changes`) and the worker-lifecycle `no_changes` case remain. The controller's
  copy of the conflict-provenance case called `integrateWave` directly instead of
  `executeWave` and duplicated the identical real-setup, two-worktree, pinned-commit,
  conflicting-path, and retained-worktree assertions in the wave-semantics suite;
  that semantics case and the controller's `executeWave` error-provenance cases
  remain unchanged, and only the conflict-fixture imports that no remaining case
  used were dropped with it. This removes only duplicate or ineffective test
  executions: production behavior, deadlines, and CI workflows are unchanged.

## [0.1.0-dev.212]

### Fixed

- Primary's post-pass attribution warning now appears only for detected changes after
  the previous passing review, not unchanged confirmations or already-reviewed changes
  (#527). It states that those changes could not be attributed to the running model
  and were not subject to further review. Review eligibility and outcomes are unchanged.

## [0.1.0-dev.211]

### Changed

- The malformed-lock reclamation test now seeds its five completed fallback-runtime
  generations with the real producer's post-success on-disk layout instead of
  performing five preparatory wrapper launches for each of its six admission-lock
  shapes (Refs #194). The directory, symlink, device-target, FIFO-target, oversized,
  and unreadable cases still run exactly one real wrapper launch each and keep their
  existing startup, download, checksum, listing, extraction, version-probe, dispatch,
  pruning, lock-recovery, and outside-bytes assertions. Seeded generations are real
  private directories in each fixture's own cache carrying this fixture's synthetic
  Node program, the internal relative npm link, and a nonempty representative payload,
  with no fabricated liveness, lifetime, or current-runtime records. This makes the
  repeated test setup cheaper without weakening its checks; measured CI timing remains
  for the actual pull request run. Test fixtures only: production behavior, other
  tests, deadlines, and CI workflows are unchanged.

## [0.1.0-dev.210]

### Fixed

- Native Windows teardown fixtures now let their spawned worker be the sole publisher
  of its own PID and ready markers, in PID-then-ready-then-IPC order, instead of having
  the parent entry script rewrite the same two files after the worker had already
  published them. The redundant parent truncation window could expose an empty PID
  marker to the readiness check and surface as an invalid-PID assertion for a live,
  correctly published descendant (the duplicate-publication race tracked in #416). The parent
  entry still publishes the detached background group PID it spawns, and the
  fixture assertions, deadlines, IPC readiness timing, and cleanup safeguards are
  unchanged. Test fixtures only: production behavior and CI workflows are unchanged.

## [0.1.0-dev.209]

### Changed

- The Linux full-suite CI job now carries a 30-minute job deadline, up from 20 (#523).
  The suite and its setup are unchanged: the `Full test suite` step keeps its own
  15-minute cap, 300-second per-test bound, `dist-test/tests/*.test.js` glob,
  four-file concurrency, and spec plus progress reporters, and every other job or
  step deadline stays as it was. The added job budget is provisioning headroom: setup
  that takes around fifteen minutes previously left the suite only five minutes despite
  its 15-minute step allowance, while the whole job remains bounded at 30 minutes. No
  retry, cache, mirror, skipped test, or wider failure tolerance was added.

## [0.1.0-dev.208]

### Fixed

- Primary and every InPlace adapter now re-enter automatic review within the same
  passing-review confirmation/follow-up loop only for new originating-session/task
  captured reviewable activity (#316). A qualifying call alone plus workspace drift,
  unchanged confirmations, repeated finals, and already-reviewed evidence do not
  retrigger review. Workspace-only or checkpoint-only churn retains the identifiable
  prior pass with an explicit warning that it covers previously reviewed evidence
  only: later unattributed changes are not approved, and the current workspace is not
  certified. Genuine new captured own reviewable edits and relevant observed outside-root
  mutation candidates still require review, without proof of an external file diff.
  Missing, unsupported, or incomplete tool capture remains best effort with disclosed
  limits, not proof of no effects, a snapshot-only fallback trigger, or a new blocker.
  Initial/new-window reviews, `needs_changes` corrections, existing capture/integrity
  failures, manual review, isolated `execute`, and the run-as-binary final-response
  behavior remain unchanged.

## [0.1.0-dev.207]

### Fixed

- Human `/subtask-steer` commands now give the originating model one bounded,
  redacted acceptance notice before dependent outcomes, distinguishing queued or
  acknowledged requests from applied instructions or completed work. Cancelled and
  failed requests send no success notice; model-facing steering and worker controls
  are unchanged (#215).
- Immediate human `/subtask-add` launch notices redact before deriving their short
  title, preventing a clipped credential fragment from escaping redaction while
  preserving the worker instructions and existing UI title (#215).
- The native clipboard routing test now measures its real-Main selection only after
  the turn's terminal review-gate deferred notice has rendered, so that notice can
  no longer scroll the conversation between measurement and copy and select the
  wrong rows. Exact payload, padding, helper-byte, and clipboard-request-count
  assertions, the fallback-copy timing, and the other fixture legs are unchanged;
  production behavior is unchanged (#521).

## [0.1.0-dev.206]

### Fixed

- Sidebar-managed native editors preserve legacy Ctrl+J as Ctrl+J rather than
  converting it to Enter, preventing premature draft submission in local and
  networked panes (#518). Ordinary Enter, Shift+Enter, and the native editor's
  configured keybindings retain their existing semantics.

## [0.1.0-dev.205]

### Changed

- The Windows lineage proof now observes the two process IDs it already knows before
  querying anything — the settlement candidate and the owned command root — in one
  filtered CIM request instead of two separate ones, so a verified chain performs one
  fewer sequential round trip (Refs #194). That response is usable only when it
  holds exactly one candidate row, at most one owned-root row, and no row for any
  other PID, so a duplicated, ambiguous, or unexpected row refuses on the existing
  fixed stages instead of silently selecting one of the conflicting rows. The initial
  root record is used only once the parent walk actually reaches that PID, and the
  unchanged fresh full-chain snapshot
  still re-reads every chain member and re-validates its creation identity, so
  ancestry walking, PID-reuse and root-liveness refusal, the 64-hop bound, the 4 KiB
  output bound, and the 5 s single-child deadline are unchanged. No deadline, retry,
  warm-up, or host skip was added, and no cause is claimed for the still-unreproduced
  cold-runner query timeout.

## [0.1.0-dev.204]

### Fixed

- Native settings text-field titles and key hints now truncate to the available
  terminal-cell width, including ANSI-styled and wide text (#212). Fitting display
  text and the full editable value remain unchanged.

## [0.1.0-dev.203]

### Changed

- The native MCP TUI tests compile their candidate package once per test-file
  process and reuse it across both real-Pi scenarios. Each scenario retains its
  own synthetic home, workspace, MCP state, and Pi process; candidate cleanup
  waits until both tests finish.

## [0.1.0-dev.202]

### Changed

- Upgrade the managed WebSearch dependency to `ddgs==9.16.1`, requiring Python
  3.10 or newer (#513). Shell and native provisioning retain eager dependency
  resolution, binary-only isolated installation, pinned-version validation, and
  `pip check`; current-environment reuse and the local search bridge contract are
  unchanged. This inherits upstream Google-engine disabling and narrower Startpage
  extraction/filtering, without changing local provider or ranking policy.

## [0.1.0-dev.201]

### Changed

- Routine dependency maintenance: the direct `undici` dependency now requires
  `^6.29.1`, and the committed lock refreshes the affected compatible transitive
  resolutions (`body-parser`, `fast-uri`, `ip-address`, `qs`, `zod`) to what a clean
  install resolves. A clean `npm install` and `npm ci` both complete with the audit
  enabled, report no known vulnerabilities, and leave the committed lock byte-identical.
  Nothing else moves: other direct, development, and optional dependencies keep their
  existing ranges and pins, and the supported Node floors, the pinned Pi TUI target,
  optional native platform coverage, product behaviour, and dependency policy are
  unchanged. A focused guard keeps the selected direct minimum and the committed
  baseline floors in step with the root lock (#506).

### Fixed

- The Linux external-editor process regressions now wait for the real non-Node
  byte consumer to exit and assert its actual status before accepting successful
  completion (#511). Exact input and Pi-result assertions remain, as does the
  genuine-signal failure control. The existing tests still run once each; no
  repeated-trial suite, polling delay, deadline increase, or production handoff
  change is added.

## [0.1.0-dev.200]

### Changed

- Numbered prerelease publication now also depends on the native Windows session-host
  acceptance matrix (#211): CI calls `.github/workflows/session-host-alpha.yml` as a
  read-only reusable workflow on every enforced trigger (pull request, `main` push, and
  manual dispatch), so the eight real verification legs — the three `Verify` Node floors,
  the full suite, the two native Windows jobs, and the matrix's Node 22.23.4 and 24.22.1
  legs — sit upstream of the publish job, which keeps its implicit `success()` guard and
  its original push/`refs/heads/main`/repository conditions. The matrix no longer starts
  on its own `pull_request`/`push` triggers, so the automatic Windows matrix runs exactly
  once per CI run; targeted `workflow_dispatch` stays available for one commit, and its
  concurrency group keeps a fixed prefix with cancellation off, so it never cancels the
  calling CI run or a `main` publication run. The same test files, commands, fail-closed
  prerequisite gates, pinned actions and Node floors, and job, step, and test deadlines
  run as before, and the native Main case plus both cold hosted-source wrapper legs stay
  deferred under #345, so a green matrix job is not Windows runtime-support proof.
- CI's six existing check names are unchanged. Which contexts the called matrix
  contributes, and the repository protection that requires them, are coordinated with the
  live repository configuration rather than set from this source tree; the workflow
  contract tests here pin only that source contract. Proof for an exact merged commit
  comes from an authorized merge and that commit's own post-merge CI run, independently of
  any ruleset change.

## [0.1.0-dev.199]

### Fixed

- Remote input no longer crosses into an unfinished native redraw on the owner (#500).
  A completed remote operation now waits before its first owner write while the owner's
  synchronized redraw is still in flight, then crosses in arrival order — mouse,
  keyboard, and paste share one queue — exactly once when the redraw settles, including
  a frame that completes with nothing visually changed. Every original fact is proven
  again immediately before that single write (scope, conversation tuple, geometry
  revision, source token, observed input modes, subscription, and authorization) and again
  after the owner's readiness answer, which is itself owner code, so an answer given while
  the subscription is being retired or the observed facts are moved and restored releases
  nothing.
  Work whose facts moved — including a change that lands back on the original values —
  is discarded rather than retargeted or replayed, and a refused or uncertain handoff
  stays terminal. Waiting work is bounded by the existing viewer limits (128 outstanding
  logical operations, retained payload within the existing content transfer-byte budget)
  and an over-bound operation is refused with zero bytes written and no replay. Close,
  retirement, transport loss, protocol failure, and a replaced run release waiting work
  with no late write. Each completed operation takes its place in that queue, and its
  retained bytes, before the owner is consulted about it, so input admitted from inside an
  authorization or a scope read still arrives later and crosses later. The mode facts
  published with a frame are now that frame's committed facts, so the brief mid-redraw mouse withholding is never presented as a
  mode of the frame a viewer is looking at. A content source that offers no redraw
  observation keeps the existing direct handoff unchanged; a source that offers one and
  cannot answer it fails closed — waiting work is cancelled and new input refused —
  instead of writing unchecked; a parse pipeline that has failed and a surface being
  disposed are reported as unavailable rather than as nothing in flight. No setting, wire capability, retry path, or timing guess
  is added.

## [0.1.0-dev.198]

### Fixed

- AskUserQuestion now refreshes its cached popup rows when Pi's native editor
  reports an asynchronous change, so an image-paste path appears on the next
  ordinary coalesced render without another input. The host callback and the
  single native draft/cursor remain authoritative; clipboard routing and answer
  behavior are unchanged (#488).

## [0.1.0-dev.197]

### Changed

- Increased the session-content viewer's shared finite queue bound to 128 pending
  logical input operations and queued control writes (#500). This remains an experimental
  scrolling-capacity change, not a confirmed fix. Existing tests cover 128 admitted
  operations with the 129th refused, a synchronous 136-report burst admitting 128 and
  refusing 8, ordered drain, contiguous paste pages, and slot reuse. Input fences,
  too-large guards, truthful not-sent/unknown outcomes, and no-replay behavior are unchanged.
- Remote input notices now present only this viewer's own queue-limit refusal quietly
  (#500). When the viewer's finite pending-operation bound (a local backpressure limit,
  not a server limit or a rate limit) refuses an operation before any transport write,
  the input still stays unsent, nothing is retried or replayed, no success is claimed,
  no new notice appears, and an earlier refusal or uncertainty notice stays visible.
  Every other refusal reason, an unrecognized reason, an oversize paste, and an unknown
  or failed handoff keep their existing visible notice, and the 128-operation bound
  itself is unchanged.

## [0.1.0-dev.196]

### Fixed

- Corrected the native Ctrl+G external-editor input handoff (#499). Hosted editors
  receive ordinary terminal input through an editor-specific PTY relay behind the
  existing authenticated decoder, instead of reading printable native-input frames
  directly. The configured editor and Pi's draft-return behavior are preserved;
  save, quit-without-save, and failure return input to Pi without disabling framing
  or widening viewer authorization. The handoff is enabled on every operating system,
  including Windows' shell-based launch through the pinned ConPTY surface; there is no
  OS allowlist. General enablement tests run in the Windows launcher CI step too. The
  installed-Pi Windows RPC smoke allows 90 seconds for cold startup (other platforms
  retain 30 seconds), without changing product shutdown deadlines.

## [0.1.0-dev.195]

### Added

- The Network pane now explains why Network storage is unavailable (#494): each refusal
  shows one fixed reason and mitigation for one fixed item named by its conventional
  name below the Pi agent directory, with Windows- or POSIX-appropriate advice and no
  path, error number, account identifier, or native output; unsafe settings are never
  shown as defaults. For an access-permission refusal while Network is inactive, an
  explicit **Repair Network storage permissions** confirmation tightens only the
  protection of the five fixed existing items and keeps their contents, the identity key,
  pins, grants, explicit Off values, and saved destinations byte for byte. It acts only
  from the actually written confirmation with a frozen assessment that is re-checked
  immediately before any change. It never hosts, connects, creates or rotates keys,
  reopens stores, or retries, and a changed or possibly changed result keeps Network
  unavailable until a deliberate restart. Its warning recommends separately replacing a
  possibly exposed identity key. Defaults are unchanged. A missing `session-host`
  directory is now created exclusively with private protection at creation (on Windows a
  protected access list for only your account, SYSTEM, and Administrators; on POSIX
  `0700`), and that protection is claimed only after the created directory itself is
  verified on Windows or a supported POSIX system. An existing directory is never changed
  automatically. When protection cannot be verified at creation (for example under some
  inherited macOS ACLs), the directory may still be created for local use, but Network
  refuses it as unsafe until the explicit repair above is confirmed. See
  [Repairing Network storage permissions](docs/session-host-alpha.md#repairing-network-storage-permissions).

## [0.1.0-dev.194]

### Changed

- The sidebar's managed Pi fallback and the pinned verification fixtures now resolve
  the exact public Pi **1.4.0** release (#487). With no supported global or `PATH`
  installation, `pi-review-sessions` provisions an isolated
  `@earendil-works/pi-coding-agent@1.4.0` runtime, the shipped `pi-session-host-tui`
  alias pins `@earendil-works/pi-tui@1.4.0`, and the test-only CI runtimes pin
  `@earendil-works/pi-coding-agent@1.4.0` and `@earendil-works/pi-agent-core@1.4.0`.
  A completed discovery of the managed default now carries that pin, so a stale
  implicit selection recorded under an older default revalidates, provisions the
  current release, and republishes its record instead of silently keeping the older
  runtime. Nothing is purged, and explicit `--pi-executable`, npm-global, and `PATH`
  selections keep their own cached identity and precedence, so an explicitly chosen
  older runtime still reuses. The stable Pi `1.0.4` floor, the per-line Node security
  minimums, and standalone launcher behavior are unchanged.
- Native clipboard provenance also recognizes the audited Pi 1.4.0 producer while
  retaining Pi 1.3.0 recognition and the existing source, origin, size, and
  authentication guards. Other versions remain unverified and fail closed (#487).

## [0.1.0-dev.193]

### Added

- A capability-gated owner Close transport on the existing paired roster channel
  (#389). It uses the owning Main's same stop/removal path, current directional
  receiving grant, and exact owner run/row; parallel rows remain independent. Lost
  replies stay unknown and are never replayed. Sidebar Close acts on the actually
  written remote highlight, independently of the displayed stream; busy or unknown
  activity needs an exact written requester confirmation. Exited or settled-error
  removal stays owner-routed, and saved history is untouched. See
  [Owner Close transport foundation](docs/session-host-alpha.md#owner-close-transport-foundation).
- The New session form now has one **Host** line, naming **Local** each time it opens
  (#389). Choosing one already-connected saved destination makes the Workspace field
  plain bounded owner text and submits one rowless create request to that owner's own
  manager over the existing paired roster channel's optional `roster-create-v1`
  capability; the owner creates one blank native child in its own run with no initial
  prompt, and its own local focus, selection, and drafts are untouched. No local row,
  child, or input owner is created, selected, or focused: only the owner's roster
  projection lists the new row, and a `started` answer displays that exact returned run
  and row only while
  the same request still owns the form. Every actual Host change clears the Workspace
  value, choosing the same Host is a no-op with no per-host history, and the Local form
  keeps its native path editor and completion. A request carries the exact owner run, a
  canonical workspace (2048 code points, derived 8192 UTF-8-byte ceiling), a fresh
  correlation id, and one monotonic anti-replay attempt number; the current pin,
  directional grant, destination channel, and the written, uncovered New-form frame are
  independently re-checked, and the caller's written-form check and the owner facts are
  re-evaluated inside the ordered write. Fixed facts distinguish started, unconfirmed,
  refused, and unknown; a lost reply, elapsed requester patience (15 seconds on this
  side only), or a retired destination is never retried, replayed, or cancelled. A
  missing capability is refused with a fixed notice and no upgrade or connect. No new
  listener, manager, registry, permission kind, or stored state is added. See
  [Owner Create transport foundation](docs/session-host-alpha.md#owner-create-transport-foundation).
- Authenticated input-origin framing and origin-bearing clipboard capsules for the
  existing owned Node stdio bridge (#389). Payloads and explicit origins are
  authenticated, and a separate signed readiness signal precedes framed input. The host
  mode gates both user input and non-user terminal replies, refuses unknown bootstrap
  modes, and sets native capture only for the hosted child tree with ordinary descendant
  inheritance. Normal production Main enables it by default for the children it creates;
  only a dependency-only explicit-false test seam keeps the legacy call shape, and no
  viewer setting toggles it. Local/SSH copying and standalone Pi remain unchanged, a
  rowless New-form Host choice can ask one connected owner for a blank child,
  `SessionSpawn` stays the native, owner-bound tool, and human handoff remains
  unimplemented.
- Native input and text copy for the one selected remote viewport, on the existing
  selected-content lane (#389), enabled by default in normal production Main. Main always
  gives the coordinator its native I/O callbacks, so `native-input-copy-v1` negotiation and
  the owner side's capability are fixed for the host's lifetime and never depend on this
  host's own viewer setting. A new remembered Network setting, **Remote input/copy**, is
  this VIEWER's own switch for its displayed remote pane (on for a new installation or an
  otherwise valid older settings document; an explicit Off survives restarts). Off refuses
  keyboard, mouse, and paste with one brief fixed notice and writes no completed copy to
  the clipboard; it never disconnects, revokes, changes Hosting/Auto, stops children,
  cancels accepted owner work, or affects the owner's local input/copy, other viewers, or
  the sidebar's New, Close, and Saved actions. Keyboard, canonical mouse, and whole text
  paste are admitted only against the actually written, uncovered, Main-focused viewer
  frame and re-proved against current owner facts, the current TLS-proved peer, pin,
  directional grant, endpoint, subscription, selection, and that setting, before every
  protected write and after caller callbacks; an actual setting change (including Off and
  back On) invalidates earlier admissions and written receipts, so turning it back on needs
  a fresh written frame even when the pixels match. The source token is descriptive, not a
  grant, and the owner's Main need not display or focus the controlled row. A paste is
  validated whole up to 1 MiB of decoded UTF-8 before one PTY handoff, and a copy is
  retained whole up to the unchanged 100,000-character native bound and returned only to
  the exact initiating viewer. Ordinary output with unchanged semantic source and modes
  does not stall input; source- or mode-only changes still need a real writer boundary.
  Refusals stay brief and non-modal; only a pre-invoke refusal is `not-sent`, and an
  invoked loss is truthfully unknown without replay. Several viewers may control one
  owner row independently. Close behavior, local/SSH copying, and native producers are
  unchanged; human handoff remains unimplemented, and `SessionSpawn` stays the native,
  owner-bound tool. See
  [Native input and copy](docs/session-host-alpha.md#native-input-and-copy).
- Startup input for a remote child before it has a conversation (#389). The optional
  `native-input-startup-v1` content capability depends on `native-input-copy-v1` and lets
  an authorized viewer answer native Pi's `Trust project folder?` prompt with ordinary
  keys. Startup authority is explicit, never inferred from a missing tuple. The child
  arms it only after its owned reporter registered the mandatory public hooks, and its
  first session update closes it permanently. The owner's registration closes it at the
  first accepted status, disconnect, or exit. The startup source carries phase `startup`,
  no native session field, and its own token domain, under the same written-frame, owner,
  peer, and setting fences as conversation input; a phase or tuple change drops any
  partly assembled dispatch. Pi's trust decision and persistence are unchanged, with no
  automatic trust, Pi patch, or new API, and copy stays unsupported until a real
  conversation exists. See
  [Native input and copy](docs/session-host-alpha.md#native-input-and-copy).
- The Saved picker can now reach one connected owner's complete saved-conversation
  catalog (#389) through an optional `roster-saved-v1` capability on the existing paired
  roster channel. It opens on Local with a blank query each time; an actual Host change
  clears the query and results, the same Host is a no-op, and an owner with an empty
  roster is a valid choice. Remote rows carry the owner's own session id, saved file
  path, caption, and workspace exactly, presented through the same formatter as Local rows. These
  are display data only: requests name only opaque owner-issued handles and the exact
  owner run, and the requester never acts on a displayed path. Search keeps the owner's
  native semantics with the exact query. Every row of the unfiltered catalog or a result
  is reachable through bounded windows over one immutable owner result, with the full
  total stated and no silent truncation; existing navigation keys are unchanged.
  Resume uses the owner's native Saved admission and duplicate guards and starts an
  owner-owned child. Only this viewer selects the returned row, and only while that
  request still owns the picker. Delete is gated by the owner's live **Allow remote
  history deletion** policy, the requester's Local-style confirmation, and the owner's
  existing `trash`-first and file-identity guards, through one guarded native manager operation. Requests need the
  actually written picker or confirmation frame. One request is pending per channel, and
  outcomes stay `not-sent`, owner facts, or `unknown`, without retry or replay. A
  missing capability gets one fixed notice. No new listener, manager, history, index,
  transcript copy, or lease is added. See
  [Saved conversations on a connected owner](docs/session-host-alpha.md#saved-conversations-on-a-connected-owner).
- A separate remembered OWNER-side Network setting, **Allow remote history deletion**
  (#389): whether this host exposes remote saved-history deletion to its paired viewers.
  It is on by default and an explicit Off survives restarts; it is not a viewer-side delete
  toggle and does not gate this host's own local Saved deletion. The viewer checks the
  owner's current positive description at admission and actual queued send. The owner
  reads its own current value once per incoming prepare or confirmed request, refusing
  Off or unknown before provider work, independently of any viewer's Remote input/copy
  setting. Later preference flips alone do not revoke an admitted request, and Off then
  On before sending preserves a still-owned intent or confirmation without retrying a
  refused attempt. Independent authorization and file guards remain live. Both new settings are optional
  fields of the existing version-1 protected preferences document; malformed values or
  unavailable storage are refused untouched and never treated as the default-on values.
- A TLS/WSS peer-transport foundation with KDE-style explicit device pairing (#475).
  Explicit callers supply generated self-signed identities, consent and trust stores, and
  a listener address; module import alone still enables nothing. Actual TLS peer keys,
  remembered identity, and separate directional receiving grants gate application
  channels. No CA-issued certificate or domain setup is required. Bounded pairing
  metadata, cancellation, backpressure, and owned teardown are covered without adding
  clipboard synchronization; the optional network sidebar now uses this transport
  (#482). See [Paired peer transport foundation](docs/session-host-alpha.md#paired-peer-transport-foundation).
- A metadata-only remote roster foundation projects the local session manager's roster
  facts over that explicitly constructed paired channel (#478). The owner observes its
  existing single manager through a coherent snapshot-and-watch seam with a fresh
  owner-run identity and monotonic observation revisions, and publishes one bounded
  versioned metadata snapshot plus bounded live updates. A full snapshot is assembled
  and applied as a whole, fenced to the current subscription, owner run, and observation
  revision, with authority rechecked against the current accepted peer identity and
  receiving grant. Rows carry only local-equivalent display facts — stable row id, title,
  exact owner-side workspace path, lifecycle, live-process/input-surface and
  busy/pending-input observations, generic activity, canonical native conversation
  identity, separate ownership and activity-intent counts, a known exit code, and
  bounded display-safe error text — while unknown observations stay unknown rather than
  idle or zero. The native current-file guard, agent/account directories, configuration,
  providers, credentials, prompts, transcripts, question text, terminal/output bytes, and
  image data never cross, and native session-pane contents are never altered, filtered,
  or rebuilt. Error text strips terminal-control hazards and recognizable credential
  patterns with a fixed fallback; it is not an arbitrary-secrets guarantee. Ownership
  stays with the owner host: a client snapshot is only a projection, its loss means
  not-current rather than idle, and stopping a subscription or disposing the bridge never
  shuts down owner sessions. No second controller, separate ACL, or new revocation
  lifecycle policy is added. Importing this foundation enables no networking, and this
  foundation adds no remote input, session-operation routing, or clipboard attribution;
  the optional network sidebar now consumes this projection (#482). See
  [Remote roster metadata foundation](docs/session-host-alpha.md#remote-roster-metadata-foundation-metadata-only).
- The session host sizes each session for the surfaces that actually display it, and can
  display no session at all (#474). Every displayable surface registers as a viewer of one
  session, and a session's canonical content size is the independent minimum of those widths
  and the independent minimum of those heights (a 100x40 and an 80x50 surface on one session
  give it 80x40). Only sessions whose viewer set changed are recomputed and only that
  session's own child is resized, so a sibling nobody views keeps its size; a session whose
  last viewer left keeps its last size, a session nobody has ever viewed keeps the existing
  initial-sizing rule, and a surface with no content size contributes nothing. Those viewer
  facts live once on the host's single session manager, and a completion carrying an older
  viewer state is refused instead of resurrecting a detached view, retargeting a finished row,
  or overwriting a later selection. With the roster focused, `n` displays no session: it
  retires only this host's local content and input participation, so every session keeps
  running, the roster, saved conversations, host lifetime, and Quit's child shutdown stay
  unchanged, and Enter on a row displays that session again without restarting it. A session
  smaller than its pane is drawn padded at the pane's top-left corner: that padding stays host
  space, while the drawn content keeps its clipboard copy, click-to-focus, and image ownership,
  and native positional input is authorized only against the frame actually written. This local
  geometry change enables no network, remote protocol, daemon, stored state, or exclusive-control
  lease, and viewing never
  grants or revokes input. See
  [Per-session content geometry](docs/session-host-alpha.md#per-session-content-geometry).

- An explicit protected peer-state library retains one per-agent identity, accepted
  peers, directional grants and separate outgoing host pins (#480). Initialization is
  explicit; startup creates no identity or fresh trust. Real
  filesystem protection precedes private-key writes; unsafe, missing initialized,
  corrupt or key-mismatched state fails closed without permission repair, silent identity
  rotation or fresh-trust fallback.
  One-time association remains valid until revoked: reconnects and restarts with the same
  keys require no repeated approval, and pending consent deadlines never expire grants.
  Synchronous publication and immutable projections preserve the current store seams;
  uncertain commits invalidate the handle instead of claiming rollback. The receiving
  pairing callback also exposes its actual configured deadline and sanitized settlement
  without changing consent authority or timeout defaults (#475). The optional network
  sidebar now builds its saved settings, listener, and consent surface on this state
  (#482); native input/copy for the displayed remote pane is on by default with a
  per-viewer Remote input/copy setting, one deliberately
  selected remote row's native viewport can now be displayed, and a rowless New-form
  Host choice can now ask one connected owner for a blank child, and the Saved picker can
  reach one connected owner's saved conversations; `SessionSpawn` stays the native,
  owner-bound tool, and human handoff remains unimplemented. See
  [Explicit protected peer-state foundation](docs/session-host-alpha.md#explicit-protected-peer-state-foundation).
- The optional native session host now displays one deliberately selected remote native
  viewport through the existing left roster, compositor, graphics layer, and writer
  (#389). Visible Pi/chat text, styling, cursor, Unicode, and bounded typed PNG images and
  fallbacks are included; visible text can itself be sensitive. Unselected rows stay
  metadata-only. One selected stream uses the same owning manager, per-session viewer
  minima, TLS-proved key, remembered pin, and directional grant, without another listener,
  manager, controller lease, or permission kind. New session starts on Local and a
  deliberate Host choice can target one connected owner; loss or disconnection never
  stops remote work or silently selects another row. Exact source,
  run, generation, geometry, and written-display fences remain fail closed; 64 KiB bounds
  messages, not whole viewports. Native input, text paste, and copy travel only through
  the default-on native input/copy bridge described above, subject to this viewer's
  Remote input/copy setting; owner Saved conversations are described above, human
  handoff remains unimplemented, and `SessionSpawn` stays the native, owner-bound tool.
  Ordinary Pi and authenticated local/SSH clipboard are unchanged. See
  [Selected native viewport](docs/session-host-alpha.md#selected-native-viewport-interim-display-scope).
- The optional native session host now wires a **Network** sidebar over the paired peer
  transport (#482). A fresh Network pane prefills the editable local listen draft
  `*:8088`; `*` requests IPv4/IPv6 dual-stack on one listener, while explicit addresses
  remain available. Hosting is initially off and remembered, and an enabled saved
  setting attempts to restore its listener on the next start. Saved destinations, the default-off Auto setting, and the
  default-on arrival bell are protected preferences kept separately from the
  identity/trust document, so muting the bell or saving a destination creates no key
  material. A fresh host with no saved preferences creates no peer keys, network
  preferences, listener, or connection. The first explicit Enable hosting or Connect
  initializes an identity only when none exists. First pairing has a two-minute human
  approval window and a first-use server-key confirmation; the consent dialog's immutable
  identity latches at arrival, and its controls authorize only after the exact frame was
  actually written. Changed known pins and unsafe, corrupt, or
  missing-initialized trust fail closed without repair, rotation, or silent key
  replacement; explicit Connect is not pin replacement. Incoming requests raise a
  persistent non-focus-stealing alert and one best-effort bell per arrival, with a
  reserved alert band when the sidebar is hidden or narrow. Auto recovery is off by
  default and attempts only previously connected, still-trusted destinations with a
  remembered pin and no suppression after startup or an unexpected loss. Disconnect
  persists suppression until an explicit Connect; Remove forgets only this side's
  endpoint and remembered pin; Revoke removes only this side's current receiving grant.
  None stops remote work or sessions.
  Add destination uses independently navigable Name, Host, and Port fields and one
  explicit Add action, rather than a sequential wizard.
  Connected rows stay metadata-only until one is deliberately selected. Close is
  owner-routed as described above; native input, text paste, and copy are reachable only
  through the default-on bridge and this viewer's Remote input/copy setting, and the
  separate Allow remote history deletion setting is an owner-side policy; a deliberate
  New-form Host choice can ask
  one connected owner for a blank child, the Saved picker can reach one connected owner's
  saved conversations, and `SessionSpawn` stays the native, owner-bound tool; human
  handoff remains unimplemented; no view-only permission kind or controller lease is
  invented. See
  [Network sidebar](docs/session-host-alpha.md#network-sidebar-hosting-pairing-and-remote-metadata)
  and [Session-host peer network](docs/security-model.md#session-host-peer-network-optional).

### Changed

- Session-host session operations now run through one presentation-independent local
  owning-host boundary over the host's single session manager (#473). Starting a session,
  admitting an authenticated background `SessionSpawn` sibling, resuming an exited row,
  checking a saved-conversation deletion, and owned-child settlement at quit read and use
  that one manager's facts, and a host run refuses to open a second manager. The sidebar
  stays a disposable view of those facts, and delegated children gain no new
  session-creation authority. No behavior, protocol, control, or setting changes. See
  [One owning host, one session manager](docs/session-host-alpha.md#one-owning-host-one-session-manager).
- Left roster rows stay clickable while a right-hand host UI is open beside them (#486).
  A click on a different left row first closes that UI through its own existing
  cancellation route — including the nested Saved-delete confirmation together with its
  picker, so no hidden pane or pending UI ownership survives — and then performs the
  clicked row's ordinary action exactly once, without confirming, approving, submitting,
  or deleting anything. Backend work keeps its existing cancellation and request-id
  fences; dismissing a pane does not guarantee that an operation already submitted to
  Main stops. A click on the row that already holds the left highlight is a pure no-op that
  preserves the open pane, its draft, focus, notices, and pending work. Only the roster
  actually drawn in the written frame authorizes the click, and no keyboard, consent,
  confirmation, or native-input ownership fence changes. See
  [Focus, display, and status](docs/session-host-alpha.md#focus-display-and-status).
- Remote roster cards in the left sidebar now use the same card layout and facts as local
  rows, with one indented `host <label>` line directly below the title and no workspace
  path in the card (#482). An unusually long label is clipped on that one line, and the
  honest stale marker leads it so clipping cannot hide the observation. The exact
  owner-side workspace path and other roster metadata, Network details, selection, Enter
  and drawn-click actions, and activity-only collapse are unchanged. See
  [Network sidebar](docs/session-host-alpha.md#network-sidebar-hosting-pairing-and-remote-metadata).
### Fixed

- Early automatic terminal-query replies no longer fail an otherwise-live, non-stopping
  framing child awaiting its own authenticated readiness (Refs #389). These unsent replies
  are discarded, never queued or replayed; user input still requires readiness, and future
  replies keep their framed non-user origin and existing failure paths.
- Cleanup-lock contention keeps trying atomic publication while one owned, targeted
  process-start query runs asynchronously, rather than blocking on that query (#389).
  The existing two-second deadline and 50 ms cadence remain unchanged; only a real
  helper close can settle ownership, and confirmation expiry is re-proved against the
  absolute clock even before a delayed timer dispatches. Unknown owners and replaced
  records remain protected, and the original Windows eight-racer checks are unchanged.
- The Windows bootstrap test fixture now allows 120 seconds for its cold first
  attempt and records bounded per-launch phase diagnostics; subsequent attempts
  retain their existing limits and all integrity assertions remain.
- The retired-activity census regression installs its gates before a fresh retired
  uncertainty mark, preventing an automatic refresh from consuming the proof first.
  Test cleanup releases held operations; production activity fences are unchanged.
- The signal-exit test observer rechecks completed markers when filesystem watch
  events are missing and captures safe failure facts before cleanup can produce the
  marker itself. Signal behavior, original assertions and deadlines are unchanged;
  the historical local timeout's cause remains unproven.
- Session-host field labels now sit beside the native Editor's first editable body row,
  not its top border (#482). New/Edit, Host shortcuts, and Network editors share the
  same stable anchor; wrapped caret movement leaves the label, drafts, and editing
  behavior unchanged.
- A single left press on a drawn Network menu row now performs its normal Enter action
  once (#482). Captured row positions and displayed action values fence stale or unwritten
  clicks; opening consent review decides nothing, and host gestures never reach a child.
- Owned-child input-origin framing is terminal-safe (Refs #389). The framing is versioned
  `prg-ni-v2` and every frame is printable ASCII end to end, closed by one printable `;`
  instead of a line feed, so a terminal that re-encodes control characters on the way into
  the child can no longer rewrite the frame boundary. Only that exact tag and terminator
  are accepted: the older line-feed-terminated wire, a carriage return, and a
  terminal-substituted key ending are malformed framing that poisons that decoder, and a
  host and a child built from different framing versions refuse each other rather than
  downgrade, queue, replay, or fall back to raw input. Body encoding, origins, fences,
  sequence, dispatch assembly, bounds, readiness, and every policy are unchanged, and no
  dual-version decoder or negotiation is added.

## [0.1.0-dev.192]

### Changed

- `review.evidence.snapshotFailureFallback` now defaults On when absent (#491). An
  explicit `false` stays Off, and the default is never written back to saved settings.
  Existing On behavior is unchanged: the Tools only (snapshot-failure fallback) warning,
  retained tool evidence, the session latch, and `/review-clear`.
- With the fallback explicitly Off, an eligible Primary review-baseline capture failure
  (for example an over-budget untracked set) no longer blocks the prompt (#491). A
  prominent local warning says review is disabled for that turn and no snapshot coverage
  is available. The work then continues unreviewed: no Tools only substitute, no
  reviewer, and no reviewed or passed result. The decision covers the whole turn:
  re-arming it before settlement never captures a later baseline. Nothing latches for
  the session, so the next fresh prompt tries a snapshot again. Capture limits and
  eligibility are unchanged. These still block:
  cancellation, a failed warning, ineligible failures, settlement and worker captures,
  missing or corrupt persisted evidence, reviewer errors, and construction, checkpoint
  and landing failures.

## [0.1.0-dev.191]

### Security

- Node.js now has a security floor for each release line: 22.23.4 or newer on Node 22,
  24.22.1 or newer on Node 24, and 26.12.1 or newer on Node 26 (#489). These match the
  [October 2026 Node.js security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases),
  which include the eMudhra intermediate-CA compromise fix. The package engine range is
  `>=22.23.4 <24.0.0 || >=24.22.1 <26.0.0 || >=26.12.1`. Later patches in a line are
  accepted, and Node 26 is not required. Other majors keep their existing
  eligibility. The session-host managed fallback stays on Node 22 and now bootstraps
  the checksum-pinned official Node.js 22.23.4 archive. This release does not update
  or restart Node.js installations or running processes. Update Node.js yourself,
  then restart running Pi, review-gate, session-host, and web-tool processes.

### Changed

- CI now selects the exact patched floors (#489). The existing `verify` matrix runs
  Node 22.23.4, 24.22.1, and 26.12.1 through the same stages, with no extra
  full-suite stage. Its checks are now named **Verify (Node 22.23.4)**,
  **Verify (Node 24.22.1)**, and **Verify (Node 26.12.1)**, replacing
  **Verify (Node 22.19.0)** and **Verify (Node 24.x)**. The Linux full suite, the
  Windows shell job, and the release builder use Node 24.22.1 and keep their check
  names. The Windows launcher job uses Node 22.23.4 and is now named
  **Windows launcher (Node 22.23.4)**. The Windows session-host alpha matrix uses
  Node 22.23.4 and 24.22.1, which renames its checks to match. Earlier CI runs on
  Node 22.19.0 and 24.x remain historical evidence, not patched-runtime runs.
  Separate Node 26 CI work in #401 stays open.

## [0.1.0-dev.190]

### Changed

- Automatic Primary review, and automatic review of InPlace workers with structured
  tool events, now also needs a new qualifying tool call since the preceding review
  (#461). Filesystem changes alone (runtime, background, or external writers) no
  longer start or retrigger it, a call never forces an empty-diff review, and skipped
  changes stay unreviewed and earlier findings unresolved, never accepted. A tool call
  is not proof that the agent caused every captured change. `/review-now` and
  `/ask-reviewer` are unchanged, and there is no new setting.
- After a pass, a user-selected `run-as-binary` InPlace executor's final pass-response
  turn is returned to the orchestrator as unreviewed evidence without another review
  (#461). Initial and correction review eligibility and caps are unchanged.

### Fixed

- The session host now accepts the native Pi agent directory, or its `.pi` parent, as
  an ordinary session workspace with the same effective `PI_CODING_AGENT_DIR` and shared
  native configuration, and non-Git review of such a root no longer fails (#461). Raw
  capture skips only this extension's own private checkpoint `record.json` files;
  everything else, including unknown files next to them, stays captured. The delegated
  capture limitation tracked in #318 remains.

## [0.1.0-dev.189]

### Changed

- Removed infrastructure-specific directory handling from generic source/discovery,
  copying and test harnesses (#481), with no replacement exclusion or configurable
  special case. Generic input scopes, path/type/no-follow checks and ownership-confined
  cleanup remain unchanged. Agent search-performance instructions are explicitly not
  product requirements in the repository guide.

## [0.1.0-dev.188]

### Added

- Both scoped tool-denial pickers in `/review-settings` > **Tools** (**Top-level
  tools** and **Executor tools**) now have a live tool-name search field (#463). It
  works like the saved-conversation picker: a native query line above the rows narrows
  the list as you type, using the same grammar (fuzzy tokens, `"quoted phrases"`, and
  `re:<pattern>`, all of which must match). Only tool names are searched, never
  descriptions. The arrow keys move through the matches and Enter still toggles the
  highlighted row, all through your `tui.select.*` keybindings. A query that matches
  nothing shows **No matching tools** and keeps **Back** and Escape available. The
  query is view state only: each picker keeps its own query, the query is never
  saved, and a denial hidden by the query stays denied and is still applied or saved
  with the whole draft. Denial semantics, the staged transaction, and the saved
  configuration are unchanged, and a non-TUI (RPC) host keeps the plain, unfiltered
  list.

### Fixed

- On terminals that report held-key repeats, a held key no longer replays its action
  across the settings menus: a held Enter does not toggle a second row, a held Escape
  does not close the parent menu and then apply the staged draft at the root, and a
  held Ctrl+S does not save (#463). Navigation and query-editing repeats still repeat.

## [0.1.0-dev.187]

### Fixed

- The sidebar preserves native Pi SSH clipboard requests instead of discarding their
  OSC 52 transport while still displaying **Copied!** (#466). Verified native copy
  producers use an authenticated, session- and foreground-owner-fenced host route;
  arbitrary raw/rendered PTY controls remain blocked. Pi's native selection, visible
  question/notice copying, copy-on-select, configured copy shortcut, and local helper
  remain unchanged; Pi itself is not patched. The provenance adapter is bounded to
  the verified Pi 1.3.0 runtime and fails closed when provenance is unavailable. Copy
  feedback stays native: Pi's **Copied!** flash is unchanged and the host adds no
  per-copy notice. Ordinary safety refusals stay quiet; actual routing failures for
  the displayed Main owner (unsupported runtime, unavailable provenance, or a failed
  terminal write) are recorded through the existing Terminal diagnostics warning and
  private log with fixed codes only, never clipboard text, stacks, exception messages,
  or paths. A submitted request is not proof of client clipboard delivery; existing
  terminal/multiplexer permissions and native size limits still apply.
  Operator-driven isolated standalone/hosted client-paste checks are documented.

## [0.1.0-dev.186]

### Fixed

- Primary review-evidence warnings are now local to the user and no longer start model
  turns or reviews (#465). The warning was sent as a `pi-review-evidence-policy` custom
  message with `triggerTurn: true`, so an eligible snapshot-failure fallback started an
  extra model turn. Tools only fallback also skipped the no-change check, so a response
  with no file changes could still invoke the reviewer. Evidence warnings now use Pi's
  warning-level UI notice only, with no custom, system, steering, or follow-up message
  and no triggered turn. Automatic Primary Tools only review, including fallback, now
  needs reviewable change evidence: retained changed content, a mutation-capable or
  uncertain observation, or an outstanding correction. The evidence method, its warning,
  an assistant summary, or known read-only observations alone run no reviewer, and
  `/review-now` applies the same no-change rule that snapshot review already used. Real
  edits still reach the reviewer with retained tool content and the truthful
  **Tools only (snapshot-failure fallback)** label.
- The first eligible Primary snapshot-failure fallback now applies **Tools only** for
  the rest of the session (#465). Later turns, reviews, and `/review-continue` make no
  snapshot capture attempt and repeat no fallback warning. This runtime state is never
  saved, so the configured preference, the menu value, and Save are unaffected.
  `/review-clear` or a new session ends it, and the next prompt's ordinary capture then
  tries the configured snapshot preference once; an eligible re-failure warns once more
  and returns to Tools only. With fallback Off, capture failure still blocks.
  Cancellation, integrity, cleanup, checkpoint, and landing gates are unchanged, as are
  explicit reviewer questions and the #462 capture budget preflight. Worker evidence
  policies, their fallback warnings, and their per-cycle retries are unchanged.
- Every Primary evidence settings change is now a short local warning, whether it is
  applied, deferred, a reset, a success, or a failure (#465). Reviewer-directed
  evidence prose no longer appears in user warnings, and `/review-continue` sends
  the model only the correction authorization, never the local warning text.
  Reviewer bundles and review transmissions keep the full evidence-method labels.
- Settings changes no longer send model-facing warnings for scheduled work (#465).
  When a `/review-settings` change removes a scheduled subtask's pinned worker, or
  leaves it unable to serve that entry, the enabled entry is disabled with its
  existing `enabled` flag before the scheduler replans, so it is never attempted
  again. It keeps its pin and no other worker is chosen. Save persists the disable,
  root Escape applies it for the session, and Cancel changes nothing. The user sees
  one local warning per disabled entry, and an already-queued occurrence ends
  without a worker attempt and is reported to the user only. Execution-controller
  notices now go to the current native UI as warning-level notices instead of a
  channel that could be silent.
- A subtask whose isolated workspace capture refuses a source entry before any
  worker starts now fails with a typed capture rejection naming the exact path
  (#467). Examples are an untracked file over the budget, an unsupported file type,
  or a symlink that is absolute or escapes the workspace. The failure notification
  offers two explicit choices: retry with a narrower workspace that excludes that
  path, or deliberately launch an InPlace task with degraded review. Nothing is
  converted, spawned, or retried automatically. Start acceptance stays
  asynchronous; the typed refusal arrives with the task's failure notification.

## [0.1.0-dev.185]

### Fixed

- Git checkpoint capture now enforces the untracked byte budget before reading an
  untracked file (#462). The arm passes the budget still remaining to the existing
  per-file size check, so a single oversized file, or a file that no longer fits after
  earlier entries, is refused from its opened size with the typed `untracked_too_large`
  failure before its buffer is allocated or any of its bytes are read. Previously the
  arm checked the aggregate only after reading the whole file. Each native read is now
  a bounded 8 MiB chunk instead of the whole remaining file; partial reads still
  resume at the exact offset. This source gap is platform-neutral. The limits, the
  exact/empty/below-limit behavior, no-follow and identity race checks, and cleanup are
  unchanged. With `review.evidence.snapshotFailureFallback` On and owned cleanup
  confirmed, the failure still takes the warned Tools only (snapshot-failure fallback)
  review. With it Off, the failure still blocks. Cancellation, races, and unconfirmed
  cleanup stay ineligible. The original report was a native Node filesystem assertion
  on Linux with Node 24.19.0. Its exact trigger, file size, and installed revision were
  not established, and that abort was not reproduced. Regressions use small and sparse
  owned fixtures.

## [0.1.0-dev.184]

### Changed

- Launcher startup is now one shared current check instead of an exhaustive
  per-launch pipeline (#344). The Pi, web, and sidebar entry points on macOS, Linux, and
  Windows ask a single preparation authority (`scripts/prepare-application.cjs`) whether
  the prepared application is current, and launch immediately when it is. A current
  start reads a bounded marker plus a completion receipt and stats only the recorded
  application inputs: no `npm ci`, no TypeScript compile, no staging or artifact
  inventory, no runtime/toolchain fingerprint, no Python validation, no skill copy, and
  no cache cleanup. Installed packages are identified by their full exact version (for
  example `0.1.0-dev.180`), so prebuilt consumers never compile; source checkouts are
  identified by that bounded input index, so real edits, additions, or deletions
  invalidate while touch-only or irrelevant changes do not. A genuine miss updates
  automatically — no confirmation — in a fresh inactive generation under one producer,
  publishes readiness only after install, compile, required entries, and input
  coherence all succeed, and never builds into the live checkout's `dist/`. Live
  consumers (including a launcher started from an older prepared generation, and a
  managed Pi runtime) hold leases, so cleanup preserves code that is still running; an
  unreadable or incomplete consumer view skips reclamation. Fallback managed Node also
  reuses a completed cached runtime instead of downloading and re-extracting it on every
  fallback launch (pinned digest verification remains on actual installation).
  A completed Pi discovery is reused from cheap package/path metadata, so a current
  sidebar start performs no global npm-root query, no live `pi --version` probe, and no
  managed-runtime cleanup; explicit or PATH changes are honored without rebuilding.
  Managed Pi selection and lease publication are one coordinated step, and a lease names
  the native process that will actually run the code (a POSIX wrapper's invoked parent,
  not a shell-supplied number). A reused fallback Node runtime carries a per-consumer
  liveness record that all native reclamation routes honor, stale completed-runtime
  records are replaced on the next successful installation, and the managed state
  directory chain is revalidated on every current selection. The retired
  whole-artifact parallel re-hashing, npm-implementation/toolchain content
  fingerprints, and per-startup cache-record scans are gone, along with the old-contract
  tests that asserted them; the shared-command, ownership, role, cancellation,
  source-copy, atomic-publication, and per-type retention guards are unchanged.

### Fixed

- Installed POSIX npm bins now resolve their physical package directory through a
  bounded, read-only symlink chain, so the standard Pi and web commands find their
  shipped helpers without requiring direct script paths (#386).
- When DDGS provisioning is needed, validate an already-valid cached environment once
  instead of twice on macOS, Linux, and Windows (#344, #379). Current launches skip
  provisioning altogether through the shared readiness state.
  Validation still checks the pinned distribution version in Python's isolated mode
  and runs `pip check`; any installation or repair receives a fresh full validation
  before startup continues. Provisioning failures still stop startup, and dependency
  pins, installation flags, and cache locations are unchanged.

## [0.1.0-dev.183]

### Changed

- The Linux full-suite CI job now keeps bounded headroom for the complete suite it
  already ran (#458): the job deadline is 20 minutes and its `Full test suite` step
  deadline is 15 minutes, up from 15 and 10. The same source tree's all-green suite
  needed roughly ten minutes of runner time, so the previous step cap cut a passing
  run off before publication. Test selection, assertions, prerequisites, permissions,
  release gates, and every other job or step deadline are unchanged; the suite
  command keeps the same `dist-test/tests/*.test.js` glob, four-file concurrency,
  300-second per-test bound, and spec plus progress reporters. No test is skipped,
  filtered, or removed, and no retry was added.

### Fixed

- This build is the first published successor of `0.1.0-dev.182`, whose publisher run
  did not complete: `b182` was never released, so its steering and abort-recovery
  changes ship for the first time here (#452). Eligible background-shell, subtask, and
  review notifications now steer at Pi's next supported boundary instead of waiting
  for the current turn to stop, covering routine match, milestone, and stall wakes,
  subtask completion and launch notices, review transmissions, and
  background-completion resumes; an idle session still resumes through the same
  triggered delivery, and a foreground command runs normally. Exit notices keep their
  bounded recovery after an abort, where transcript insertion alone does not
  acknowledge delivery before a normal model response consumes the notice. Delivery
  records, ids, receipt keys, and message bytes are unchanged, genuine user input held
  during a review keeps its follow-up release, scheduler new-work admission is
  unchanged, and an unrecognized persisted delivery kind is preserved with a
  diagnostic instead of being sent or acknowledged. The busy-only routine-wake hold
  and the pre-send deferral are gone; duplicate suppression still comes from the
  existing wake interval and exit coalescing.

## [0.1.0-dev.182]

### Fixed

- Eligible background-shell, subtask, and review notifications now steer at Pi's next
  supported boundary instead of waiting for the current turn's natural stop (#452).
  Routine match, milestone, and stall wakes, subtask completion notices, launch
  notices, review transmissions, and background-completion resumes reach the
  still-running turn while a foreground command keeps running normally, and an idle
  session still resumes through the same triggered delivery. Stored delivery records,
  delivery ids, receipt keys, and message bytes are unchanged. Exit notices retain
  their bounded recovery after an abort: transcript insertion alone does not
  acknowledge delivery before a normal model response consumes the notice. Genuine
  user input held during a review keeps its follow-up release, scheduler new-work admission is
  unchanged, and an unrecognized persisted delivery kind is preserved with a
  diagnostic instead of being sent or acknowledged. The busy-only routine-wake hold
  (with its settlement-time coalescing) is
  removed along with the pre-send deferral; duplicate suppression still comes from the
  existing wake interval and exit coalescing. Background wake freshness remains a
  separate, unresolved concern.

## [0.1.0-dev.181]

### Fixed

- `SessionSpawn` no longer rejects thorough initial handoffs at a fixed 8,192-character
  ceiling (#447). Exact prompt text is transferred automatically through owned private
  temporary payloads, avoiding both bounded control-frame and native startup-environment
  limits without requiring manual shortening or file loading. Payload validation refuses
  missing, altered, or unsafe data instead of silently delivering partial context.
  There is no new prompt-length setting; empty/NUL rejection, title/workspace bounds,
  authorization, independent background launches, and launch-only success semantics
  remain unchanged. Uncertain launches are never automatically retried.

## [0.1.0-dev.180]

### Fixed

- Parallel worker startup no longer races on one repository's shared Git worktree
  administration (#451). Preparing, removing, and cleaning up managed worktrees of the
  same captured repository now run one at a time, so a preparation can no longer observe
  another preparation's partially created or partially removed registration — previously
  surfacing as `failed to read worktrees/<id>/commondir` during `git worktree add` and a
  task that never reached execution. Only that short Git administration section is
  serialized: executor and reviewer work stays concurrent, different repositories stay
  independent, and the configured worker pool keeps its capacity. Cancelling a queued
  preparation still admits no work and mutates no repository metadata, an active
  preparation keeps its existing bounded failed-creation cleanup, and cancellation,
  path/ownership validation, retained work, recovery records, and the conservative
  dirty-worktree removal protections are unchanged — removal still refuses dirty sources
  and no removal forces, purges, or broadens what it may delete, but its cleanliness
  revalidation now runs under the same lease so ignored recovery data that appears while
  a removal waits is preserved rather than deleted.
- Session-host activity status (#412) now distinguishes a freshly loaded owning runtime
  from historical conversation state. Loading a saved conversation creates a new owning
  runtime rather than attaching to the former process, and a load that admits or resumes
  no work reports known idle agent status and zero background-task/shell activity at its
  first successful Ready presentation, not eventually. Former counts, busy state, and
  unknown or incomplete telemetry are never replayed as that runtime's activity; work
  that actually starts or resumes is counted from its own current lifecycle
  observations. Stale or unknown activity also recovers independently: the host discards
  the affected ephemeral telemetry understanding and requests the owning client's
  complete authoritative current census from its live sources instead of re-reading a
  cached aggregate or waiting for an unrelated prompt, task, or event. The canonical
  live-source census stays separate from historical cleanup uncertainty, an explicit
  source refresh re-observes all sources even when cached, and recovery is one bounded
  authenticated host-to-client request per attempt, event-driven with no periodic or
  global polling. Healthy clients re-establish their actual zero or nonzero value across
  repeated episodes without a new prompt, task, manual refresh, or client restart, while
  genuinely unreachable or incomplete live evidence remains unknown. Durable
  task/group/recovery records, ownership/security identities, stop/remove safeguards, and
  saved-conversation behavior are unchanged; recovery never coerces an unavailable
  status to zero, erases a lost owner's retained state, or restarts a client or purges a
  cache to obtain status.
  Reporters that do not answer the census remain unknown, so this is a truthful
  additive authenticated control request with no configuration or package-layout
  change. The reported symptom's exact trigger and any native-platform certification
  remain unestablished.

## [0.1.0-dev.179]

### Fixed

- Disposable producer caches now clean up progressively instead of stopping at startup or
  reporting work they did not do (#385). The launcher's `.pi-review-gate/{build,
  pi-runtime,node}` caches keep their independent per-type target of five, but one cleanup
  pass now shares a single runtime budget and deletes one entry at a time, so a large or
  deep generation is actually reduced by every pass and finished by later ones; the budget
  is checked as the walk deletes, never only between whole generations, and reaching it
  never leaves a pass with zero progress. Compatible source-build and Pi runtime reuse, and
  each settled preparation, run the same bounded pass and never treat the generation the
  launch is using as a candidate, so a warm startup converges older generations without
  installing, compiling, or recreating anything. The CJS, POSIX, and native PowerShell
  producers share those rules, and no count, inventory, or cleanup outcome refuses a start.
  `.producer-active` markers and `.admission.lock` records now name their owner as a pid
  plus a targeted birth identity, so an abandoned record whose pid was reused is reclaimed
  instead of pinning a generation, while a legacy pid-only record is still honored for its
  genuine owner; missing or malformed metadata protects nothing and no real in-flight
  producer is deleted.
- A starting session host and producer-owned cache reclamation no longer race for the same
  agent directory (#385). Taking host ownership and destructive reclamation of those caches
  share one canonical per-agent coordination entry,
  `<agentDir>/session-host/host-coordination.lock`, published already complete (`pid` plus
  one per-platform birth identity) through an atomic no-overwrite hard link. Cleanup holds it
  only while it removes excess generations and creates its own, rechecks the existing
  ownership record after any wait or stale/malformed recovery and at every destructive
  boundary, and skips reclamation (with a truthful bounded warning) when the entry is
  unavailable instead of racing an ownership acquisition it cannot exclude. The launcher
  takes the same entry before its final build/Pi revalidation, the host-entry load, and the
  ownership claim, revalidates the prepared build and selected runtime with the existing
  validation authority inside that hold, re-prepares or reselects through the existing
  selection path when a concurrent preparation reclaimed them, and hands the entry back once
  the host's ownership record exists. Dead, malformed, pid-only, or pid-reused coordination
  metadata is reclaimed rather than gating startup, while a birth query that temporarily
  fails is never treated as a proven mismatch: a live holder's entry stays honored, so no
  actor can steal a live destructive holder's mutex mid-deletion. A live host's generations
  stay untouched. Cleanup-specific disposal is also less artificial: a special leaf entry
  (FIFO, socket, or device name) inside a selected disposable generation is unlinked without
  being opened. Producer-owned Node-cache artifacts have no directory-name exemption
  from reclamation.

## [0.1.0-dev.178]

### Fixed

- Startup no longer stops because disposable cache capacity is full (#385). The
  session-host launcher's `.pi-review-gate/build/`, `.pi-review-gate/pi-runtime/`,
  and `.pi-review-gate/node/` trees are created only by these producers, so their
  contents are disposable by location: five or more legacy, failed, or
  receipt-less generations are reclaimed best effort down to the independent
  per-type target of five and startup proceeds. Removable stale/malformed non-live
  locks are reclaimed, including directory/link-shaped metadata. Cleanup warnings
  (a live producer lock, unreclaimable entry, or real filesystem failure) are reported
  truthfully without a cache-capacity startup refusal and without claiming a
  deletion that did not happen. A live owner-pid marker prevents cleanup from
  reclaiming a generation another producer is still filling; generation roots are
  fenced before marker inspection so a direct-child link never exposes outside
  data, and only a valid live-owner record protects an entry. An incomplete
  isolated-Pi version root that cannot be reclaimed falls through confined
  `pi-<version>.<n>` generations without a fixed limit (later launches reuse any
  valid generation for that exact version), and the same-version replacement path
  honors the live-owner marker, so a concurrently filling generation is never
  deleted. Startup is not stopped by any of these cases. Ordinary nested content
  inside a selected disposable generation is removed with it. The
  previous durable lifetime receipts, holder pins, mount census, and Windows
  count-only admission gate are removed; active sessions remain guarded by the
  session host's existing exclusive agent-directory ownership record, and
  cleanup is skipped while that record exists. Prepared-build reuse/freshness validation, supported installed-Pi
  preference, isolated-Pi package/version validation, and the checksum-pinned
  fresh Node extraction/argv/environment behavior are unchanged.

## [0.1.0-dev.177]

### Added

- Review evidence controls (#303): **Reviewers → Evidence methods** independently
  selects **Tools + workspace changes** (default) or **Tools only** for the scope-only
  **Primary / top-level**, **Isolated worktree**, and **InPlace** rows. Workspace changes
  means whole-workspace snapshot/diff review evidence; both methods retain bounded tool
  observations, task/assistant context, and reviewer read access. Separate snapshot-failure
  fallback defaults **Off**; canonical `review.evidence` booleans are unchanged. Root
  Escape applies for the session, Save/Ctrl+S persists (including nested Ctrl+S),
  and Cancel preserves the live choices from before the visit. Effective Primary
  **Tools + workspace changes → Tools only** resets current evidence with a prominent
  warning; **Tools only → Tools + workspace changes** retains it
  and starts a new snapshot baseline. Workers pin evidence/fallback policy at firing/queue
  admission: each Start/Add task independently, scheduled tasks at actual firing, not
  schedule creation. Already queued/running tasks retain it through corrections, retries,
  and continuations; later Add tasks capture the then-current live choice, without
  reconfiguring in-flight tasks or freezing all routing/reviewer selections.
- Enabled snapshot-failure fallback (#303) uses retained current tool evidence for
  eligible review-evidence capture failures, including the first Primary or InPlace
  baseline before work, with a durable truthful basis, prominent origin-correct warning
  on every occurrence, and reviewer/user/model disclosure. Fallback is not sticky:
  snapshot-preferring policy retries later cycles/continuations; later success neither
  fabricates earlier coverage nor discards retained current-work tool evidence. Missing
  observations do not block degraded review: collected evidence, adapter/capture limits,
  and provenance-labelled claims/context remain visible, never proof of clean work or no
  effects. **Tools only** omits only filesystem/Git review snapshots subject to outside-writer
  contamination, not bounded tool/path/content observations or read-only inspection.
  It never implies approval or full snapshot coverage.
  Missing/corrupt persisted evidence, cancellation, review errors,
  isolated construction capture, checkpoint, and landing requirements remain blocking;
  shared isolated stages may still require snapshot capture for durability. The public
  review guide includes a disposable-candidate manual exercise and the supported
  `SCRIPT`/independent `REPORT` example, with adapter and attribution limits and
  InPlace's post-hoc/no-rollback boundary preserved.

## [0.1.0-dev.176]

### Fixed

- Review cancellation (#397): automatic reviews, `/review-now`, and reviewer questions
  now report stopped reviewer processes only with positive process-settlement evidence.
  Bounded teardown without confirmed cleanup explicitly reports termination unconfirmed;
  an uncertain reviewer cannot be masked by a settled sibling. Cancellation results and
  tombstones retain termination diagnostics, but discard partial verdicts as before.
  Cancellation authority, teardown deadlines, baseline preservation, and popup Escape
  ownership are unchanged. Production regressions cover uncertain and confirmed
  automatic and command cancellation on native Windows.

## [0.1.0-dev.175]

### Fixed

- Codex executor terminal cancellation (#425) starts owned teardown without
  waiting for an interrupt reply or ordinary turn timeout, fences late
  replacement work, and preserves truthful concurrent steering acceptance and
  completed output. The existing two-second SIGTERM-to-SIGKILL escalation now
  has a seven-second close/drain bound and a separate five-second lifecycle
  persistence bound. Unconfirmed cleanup or exit publication retains writer
  ownership without checkpointing or retrying; native acknowledgement alone
  never proves child quiescence. Recovery and result finalization do not rejoin
  timed-out lifecycle publication tails, and a best-effort interrupt's input
  failure does not discard late acceptance replies for previously sent steering.
  Nonterminal interrupt-steering is unchanged.

## [0.1.0-dev.174]

### Fixed

- Session-host development builds and isolated Pi provisioning (#385) now reserve capacity
  before artifact creation, independently limiting each disposable cache to five
  generations including setup residue. Settled unused generations can be reclaimed;
  live, uncertain, legacy, or unsafe generations instead block admission. Validated
  build reuse and installed build-free startup remain unchanged. Normal complete
  POSIX host shutdown explicitly releases consumer pins; native Windows uncertainty
  remains protected. Fallback Node wrappers now independently reserve one of five
  artifacts before downloads/extraction. POSIX reclaims settled path-owned contents
  and makes a runtime inactive only after explicit consumer quiescence plus exact
  CJS process exit. The POSIX supervisor forwards PID-targeted termination signals to
  its exact child and waits through signal-interrupted waits, preserving inherited
  terminal streams and the child's eventual exit status. Fresh checksum-pinned
  extraction and supported PATH-Node preference are unchanged. Cleanup refuses mounted
  generations and descendants before traversal and rechecks bounded native mount
  evidence before deletion. Native Windows refuses a sixth artifact without
  reclamation; native rolling cleanup remains unresolved.

## [0.1.0-dev.173]

### Fixed

- Tool-derived file evidence (#302): preserve UTF-8 filenames across Pi RPC stdout
  chunks; recognize attached literal shell output redirections without selecting
  command-like text inside quoted data; and disclose unavailable outside-root
  observations instead of reading a privacy-redacted or truncated pathname as a
  different filesystem address. Focused regressions inspect retained review content,
  including script edits alongside independently generated reports. Snapshot-default
  review scope, failed/partial-operation evidence, reviewer requirements, and
  checkpoint/landing behavior are unchanged. The review workflow documents producer
  and adapter coverage, isolated-worker limits, and remaining attribution uncertainty.

## [0.1.0-dev.172]

### Fixed

- Shared pending-input popup (#436): in Pi fullscreen mode, the popup claimed every
  non-wheel pointer event inside its bounds, which blocked Pi's own text selection
  over the popup and, with it, native copy/paste. Only a left press that lands on a
  currently drawn, live menu entry is claimed now; a press or drag on body text,
  headings, the fixed hint, separator rules, padding, or blank cells is left to Pi's
  native selection and copy-on-select, which read the visible popup rows — including
  their current scroll position and wrapping — and nothing offscreen. Deliberate item
  clicks, Enter/Escape, the native free-text field and paste, choice and Decline
  actions, notice More details/Close, keyboard-only popup scrolling (the mouse
  wheel keeps its unchanged native behavior), session
  isolation, and the content-sized compact layout are unchanged. Non-primary presses
  keep their previous foreground ownership. Headless regression coverage drives the
  installed runtime's SGR parser, overlay dispatch, native selection, and clipboard
  seam rather than calling the extension's handler directly.
- Shared pending-input popup (#436): with Pi's copy-on-select setting off, Pi's
  configured explicit copy shortcut (`app.message.copy`, **Ctrl+X** by default and
  honored live from `keybindings.json`) now copies a selection made over the popup
  while its overlay holds focus, using Pi's own public fullscreen-selection clipboard
  path. Copying no longer requires enabling copy-on-select or closing the popup, and
  the host's copy-on-select setting is never changed. Opening the popup clears a
  fullscreen selection inherited from before it opened (the host's public
  `resetTextSelection()` lifecycle call), because such a selection is anchored to the
  transcript's scroll view and would otherwise let the key read hidden scroll content
  instead of the visible popup. The key is consumed only when a
  fullscreen selection is live and copy-on-select is off; with no selection,
  copy-on-select on, or a host without that public surface it keeps its existing
  editor/navigation/paste behavior, and it never falls back to the last assistant
  message or other hidden conversation text. Exactly the currently visible popup rows
  are copied, including their wrapping and scroll position. A rejected clipboard seam
  is swallowed without closing the popup or claiming success. The explicit-copy path
  is covered by configured-key bytes driven through the installed runtime's parser,
  overlay dispatch, native selection, and recording clipboard seam, including a
  regression that selects transcript text before the popup opens and proves the popup
  neither inherits nor copies that hidden-scroll selection.

## [0.1.0-dev.171]

### Added

- Settings tools (#434): `/review-settings` gains one **Tools** subsection that owns two
  independent exact-name deny multi-selectors — **Top-level tools** and **Executor
  tools** — where a checked row is denied. Enter toggles the highlighted row, **Back**
  and Escape return to the Tools root, root Escape applies the draft to the running
  session, Save/Ctrl+S persists it, and Cancel discards it. A saved name the live
  inventory no longer offers stays a reversible `[not currently available]` row for the
  whole menu session, including after Back and re-entry, and a denied name is never
  converted into an allowed one by inventory drift. The lists are stored as
  `tools.topLevelDeny` and `tools.executorDeny`: exact literal names (never patterns,
  prefixes, or globs), each defaulting to an empty list that denies nothing, with a
  malformed list recovering independently to its empty default and a startup warning.
  `tool_search` is the reserved discovery loader: it is never a selectable candidate in
  either list, and a raw `tool_search` entry is rejected by strict validation on write
  and omitted by startup recovery rather than applied, so the loader is never denied.
  A top-level denial is withheld from the primary's admission, startup inventory,
  `tool_search`, and normal declarations without affecting executor eligibility; an
  executor denial is withheld at catalog capture from newly admitted execute/inplace
  workers without affecting the primary. Denials only narrow: Pi's
  `--tools`/`--exclude-tools`/`--no-tools`, the operating mode, launch and role ceilings,
  and the existing feature settings stay authoritative; unchecking a denial restores
  only that tool's ordinary eligibility. Top-level denials apply at the next applicable
  model set write, without interrupting an in-flight run or reloading; executor denials
  apply to new admissions through the shared `SubtasksStart`/`SubtasksAdd`, scheduled, and
  human paths, while research tasks are unaffected and already-admitted queued or running
  tasks and their continuation turns keep their captured authority. A denied call fails
  closed without executing on direct, nested, codemode, and wrapper paths. The scoped
  settings explanation is added where the host establishes the cause — a call refused at
  the `tool_call` admission check, a direct call clarified at Pi's `message_end` seam, or
  a nested call Pi recorded on the wrapper's tool result. An early native rejection that
  leaves no recorded invocation — codemode's own proxy refusing a non-callable
  direct-exposure member before `ctx.executeTool` runs, for example — keeps Pi's own
  truthful error rather than gaining a settings attribution, and still executes nothing.
  A delegated executor omission is explained from that task's fixed captured catalog
  instead of the current deny configuration. Pi itself is unchanged, so a denied
  name can remain visible to Pi's native callable metadata (`ctx.tools`, an active
  codemode description, or an earlier transcript entry); normal declarations, the startup
  inventory, and review-gate's `tool_search` omit denied names, and no denied call
  executes. No plugin is disabled, no effect is sandboxed, and no wildcard policy is
  added. The checkout also ships `scripts/pi-review-gate-tool-denial-sandbox.cjs` and its
  fixture, which stage a disposable isolated sandbox and print the supported command for
  manually exercising both lists against a real Pi session and a new executor child.

### Changed

- Settings tools (#434): **Deferred Pi tools**, **YouShouldKnow notices**, **Completion
  guidance**, and **Web** move from the `/review-settings` root into the new **Tools**
  subsection. Their labels, stored keys (`execution.deferredPiTools`,
  `youShouldKnow.enabled`, `youShouldKnow.completionGuidance`, and `web.*`), defaults, and
  runtime behavior are unchanged; only their location and the root's consolidated
  **Tools** row summary change.

## [0.1.0-dev.170]

### Fixed

- Native Pi tools (#421): top-level tool discovery now follows the tools Pi's registry
  currently permits instead of the conversation's restored tool loadout. A resumed
  (`--continue`), switched, or forked conversation previously advertised only the tools
  its transcript had loaded, and a Plan/research conversation resumed in a write-capable
  mode lost its baseline writes. Now every registered, non-hidden tool is a
  `tool_search` discovery candidate, bounded by the operating mode and live feature
  settings, and the role baseline (`read`, `bash`, `edit`, `write`, `grep`, `find`,
  `ls`, `ApplyPatch`, `SubtasksStart`, and `powershell` where registered and
  authorized) is rebuilt from the live registry. Nothing is persisted or restored as
  authority. Entering Plan/research removes forbidden tools even when they were loaded
  (loaded read-only tools stay loaded), and
  leaving it rebuilds the tool set from the registry at that moment, so forbidden tools
  loaded with `tool_search` before the switch need `tool_search` again. No launch
  selection or restored declaration decides admission: a registered `codemode` is now a
  candidate in manual launches too (the launchers' codemode marker no longer changes
  authority). Shells keep their existing parity: `bash` and `powershell` both start
  active wherever both are authorized. Pi registers its builtin `powershell` on every
  platform but can run it only on Windows with `pwsh.exe` or `powershell.exe` on
  PATH, so that builtin, identified by the provenance Pi reports, is now withheld from
  discovery, the baseline, and new worker catalogs on other hosts. Extension or SDK
  tools named `powershell` are unaffected. Explicit `--tools`/`--exclude-tools`/`--no-tools`
  restrictions, hidden or withdrawn registrations, the YouShouldKnow notice setting,
  native MCP enablement and exposure, and delegated workers' fixed captured catalogs are
  unchanged.
- Native Pi tools (#421): `tool_search` now confirms each activation from Pi's actual
  active set and reports a match Pi declines as not activated and unavailable instead
  of activated or already active. On Pi 1.3, a `--tools` allowlist that names no
  `mcp__` entry keeps `direct`-exposure MCP tools registered (so they stay listed as
  candidates; Pi has no public per-tool activatability query) but never declarable;
  such a search previously claimed success. A selection Pi declines later is dropped
  rather than kept as loaded, and direct calls now require Pi's actual active set
  (nested codemode/deferred callability is unchanged). Pi's policy and `/mcp` exposure
  are unchanged.

## [0.1.0-dev.169]

### Added

- Shared pending-input popup (#431): in Pi fullscreen mode, a left-button press
  highlights a visible menu entry and a completed single click invokes its existing
  Enter action, including submitting a suggested question answer. Pending-item rows,
  free-text entry and Decline rows, and notice More details/Close actions use the same
  shared interaction. Hit testing follows the drawn layout, including wrapped rows, the
  current keyboard scroll position, the fixed keyboard hint area, small and resized
  popups; non-item content and the hint never activate a neighboring or hidden action,
  and a press never scrolls the popup. Popup clicks stay with the foreground popup, and
  normal native routing resumes on close. Scrolling remains keyboard-only and the mouse
  wheel keeps its native behavior. Keyboard controls, action meanings,
  originating-session delivery, content, and tool schemas are unchanged; regular mode
  remains terminal-owned.

## [0.1.0-dev.168]

### Changed

- Shared question/notice popup (#413): the keyboard hint stays visible in a fixed area
  below the popup body, and the complete question or notice text, context, choices,
  **Type something…**, **Decline**, and notice actions scroll together. Long questions
  and notices open at their beginning instead of at the first choice. Up/Down still
  move the selection and bring the selected choice or action into view, also at the
  first or last row. Editing input brings the free-text cursor back into view, and
  while editing the hint says to press Esc before using the scroll keys. Resizing keeps
  the scroll position within the new bounds with the complete re-wrapped content
  reachable. Small popups first shorten the hint and then drop their blank padding
  rows; in three- or four-row terminals the frame rules give way too, so at least one
  content row always stays visible and scrollable. The popup keeps its content-sized
  height and position with the conversation visible around it. Scrolling stays
  keyboard-only: the popup adds no mouse handling, so mouse wheel behavior is Pi's and
  the terminal's own. The scroll shortcuts and their one-line step, choice, free-text,
  Decline, notice-action, and Escape/review behavior are unchanged.

## [0.1.0-dev.167]

### Fixed

- Delegated execution (#191): a human `/subtask-interrupt` is now visible to the next
  model request. Previously the command reported only to the UI. It now queues a context
  note in its own session, which never starts a turn. The note carries `User intent:
  interrupted by user; do not restart without authorization.` beside the truthful
  settlement from the request's own command records: stop acknowledged, the current
  queued attempt stopped before startup (never implying that earlier attempts left no
  work or checkpoint), not confirmed, or rejected; and for `interrupt_with_merge`,
  merge acknowledged, failed, pending, not attempted, or unrecorded when the request
  failed without any merge record (attempt unknown, no landing confirmed). An execute merge queues the intent before any
  landing or conflict notification it triggers. Model `SubtasksInterrupt` results add
  the same settlement lines with the model origin, also when the merge throws.
  Nothing is queued after the owning session ends. Interrupt, landing, review, and
  wake behavior are unchanged.

## [0.1.0-dev.166]

### Fixed

- Optional session host (#428): xterm parser diagnostics no longer reach the real
  terminal outside the composed frame. Each child's virtual terminal hands the pinned
  xterm parser its own private logger instead of the host console. A malformed child
  sequence (for example an unterminated CSI followed by a non-ASCII character) can no
  longer paint a `Parsing error` dump onto stderr that later redraws leave on screen.
  The log level, parser recovery, valid and chunk-split sequence rendering, graphics,
  clipping, input routing, focus, and session ownership are unchanged. A few internal
  xterm messages that call the console directly remain outside this per-terminal
  logger. Constructed-input tests do not establish the cause of any earlier on-screen
  corruption.

### Added

- The session host shows a clearable warning when xterm reports a warning or error:
  a right-aligned header notice plus a host-owned **Terminal diagnostics** roster
  entry. Pressing Enter on the fully drawn entry while the roster has focus, or
  clicking it, clears exactly the drawn count. A later error warns again. Clearing
  never touches the log or changes focus, the active Main owner, or any child's
  input; Main-focused keys stay native input. Bounded structured records (run
  identities, parser state and active parameters, labelled logger-call-site stacks,
  and no raw terminal bytes, conversation text, credentials, or logger arguments) are
  kept privately at `<agentDir>/session-host/terminal-diagnostics.jsonl`. Retention
  is exactly the active file plus `.1` and `.2`, at 5 MiB each. Every file a run
  writes, including each file after rotation, starts with that run's identity record.
  Persistence creates nothing until a diagnostic occurs, refuses unsafe or
  unrecognized files without modifying them, shows a payload-free save-failure
  warning without stopping work, and settles at shutdown. A failed final sync, or
  any persistence failure first seen during shutdown, is reported as a cleanup
  failure. No setting, transmission, polling, or daemon is added.

## [0.1.0-dev.165]

### Removed

- The deprecated legacy array forms of the `externalAgents` and
  `execution.workerResources` catalogs are no longer imported or converted
  ([#116](https://github.com/rfairburn/pi-review-gate/issues/116)); only the
  canonical ID-keyed object catalogs load. Strict validation rejects an array
  catalog, and startup recovery reports it as an unsupported field and continues
  with the remaining valid settings under the existing recovery rules, without
  converting, rewriting, or deleting the stored file. No replacement automatic
  conversion exists. Canonical catalogs and their consumers are unchanged: ordered
  execute/research priorities with per-entry reasoning, ordered primary/subtask
  reviewer lists, resource IDs and shared `maxConcurrent` capacity, and the rule
  that a missing or empty priority means no models.
- Migration for a legacy array config: back up the file, load it with the published
  conversion-capable prerelease
  [b164](https://github.com/rfairburn/pi-review-gate/releases/tag/b164)
  (`0.1.0-dev.164`), explicitly save once through `/review-settings` there, and
  then upgrade; the saved canonical config loads without conversion. Do not save
  settings with a release lacking the import while the file still holds arrays,
  because that save does not carry them forward. Full steps are in
  [Configuration](docs/configuration.md#removed-legacy-array-catalogs).

## [0.1.0-dev.164]

### Changed

- The Windows `cmd.exe`-rooted settlement descendant check reports which bounded
  stage refused: the existing settlement refusal keeps its exact wording and
  appends one fixed sanitized stage code (`[lineage stage: <code>]`) covering
  preflight, the single bounded query child (spawn failure, nonzero exit, output
  cap, or a timeout positively witnessed by the verifier's own deadline callback
  rather than inferred from a kill flag, signal, or elapsed time), the native
  ancestry script's sentinel branches, the local evidence validator, and the
  final owned-root liveness check. This is diagnostic-only (#335) and identifies
  no cause: acceptance conditions, the 5-second/4KiB/64-step bounds, the single
  query child with no retry, owned-root ownership, PID binding, and the receipt
  wire schema and HMAC identity are unchanged, and no query output, error text,
  command line, host path, or PID is ever reported.
- The Windows launcher workflow adds one manual-dispatch-only sampling step (#335):
  five fixed fresh invocations of the existing compaction-recovery child case, each
  in its own `node --test` process selected by a name pattern anchored to that exact
  title and reusing the pinned installed Pi 1.3.0 environment, so every sample starts
  its own owned children and the unmodified lineage query verifies each fresh child
  once. All five samples run regardless of an earlier failure, every exit code is
  collected, and any failed sample fails the step; nothing is rerun, no sample stops
  the loop early, and a sample that ran no matching case counts as failed. Required
  checks, the case and its assertions, and every process, lineage, and job deadline
  are unchanged: fixed sampling is diagnostic evidence, and a green run establishes no
  cause and applies no correction.

## [0.1.0-dev.163]

### Fixed

- Reduce Codex app-server JSON-RPC line-framing CPU and allocation amplification
  (#239): each stdout data event is now searched for line breaks only within its own
  decoded text, and an incomplete line is assembled once when its newline arrives
  instead of the whole pending prefix being rescanned and recopied on every event.
  The protocol and framing semantics are unchanged: there is still no frame-size cap
  (an unterminated line is retained in full), a final line without a newline is still
  never parsed, and the retained stdout/stderr capture limits are unchanged.

## [0.1.0-dev.162]

### Changed

- Upgrade the current Pi integration target to 1.3.0 across isolated runtimes,
  native-host acceptance, and the pinned pi-tui alias (#417). Supported floors and
  older compatibility fixtures remain unchanged.

## [0.1.0-dev.161]

### Changed

- Consolidate equivalent durable-publication mechanics behind the execution writer's
  existing replace/exclusive facades and a shared best-effort directory-sync helper
  (#244). Per-writer permissions, directory creation, publication, fault, and cleanup
  policies remain unchanged, including capture-record default modes and the session
  sidecar's private no-mkdir contract.

## [0.1.0-dev.160]

### Fixed

- The wave capture record (`<waveRoot>/capture.json`) is published through the shared
  durable atomic writer: the complete record is staged in an owned same-directory
  temporary file, file-synced, and atomically renamed onto its final name before a
  successful capture returns, so a reader sees either the complete record or none
  (#235). The record keeps its previous file mode (the filesystem default inside the
  private `0700` wave root) through an opt-in that leaves other durable records at
  `0600`. Record fields, bytes, identity, lineage, retry, cancellation, failure
  cleanup, and fail-closed reader validation are unchanged, and directory sync stays
  best-effort rather than a power-loss guarantee.

## [0.1.0-dev.159]

### Fixed

- Loaded sidebar sessions re-establish truthful current activity from fresh,
  exact owning-source observations at startup/restore and event-driven recovery
  points (#382). Stale unknown telemetry can recover to idle/zero or actual
  running/nonzero work without a new prompt, task, or manual refresh. Source
  initialization and replacement no longer leave avoidable uncertainty sticky;
  incomplete observations remain unknown and stale replies are rejected.
  Ephemeral activity reconstruction leaves durable records, cleanup ownership,
  cancellation, and stop/remove settlement safeguards unchanged. No polling,
  blanket zero fallback, or Pi compatibility-floor change is added.

## [0.1.0-dev.158]

### Tests

- Test-only web launcher coverage (#246) invokes byte-for-byte copies of the
  production `pi-review-web.sh` / `ensure-ddgs.sh` files in isolated fixtures and
  smoke-tests the installed package wrapper/helper with controlled dependencies. It
  pins source build ordering and status, packaged no-build behavior, exact argument
  boundaries and CLI status, missing-CLI and provisioning fail-closed paths, and DDGS
  creation/repair, version pin, isolated Python calls, and environment export. The
  package smoke also runs the installed web-bin target against a controlled valid
  venv. Production launchers and defaults are unchanged; these stubs do not prove
  native DDGS installation, live search, or Windows behavior.

## [0.1.0-dev.157]

### Fixed

- An in-place task whose terminal `result.json` publication failed (leaving no
  stored result after the executor had already run and written) is now
  recoverable by an explicit continuation instead of failing before dispatch on
  the write-once launch baseline (#253). A continuation without a stored result
  reuses and verifies the retained original baseline — integrity, task, and
  workspace-root checks unchanged — and recovers the executor session and the
  next monotonic turn number from the durable operation record, resuming the
  session only while the existing selection/fingerprint compatibility checks
  pass; a missing or incompatible session falls back to a disclosed fresh
  session in the same workspace. A missing launch baseline is proof of first
  dispatch only when the durable operation record retains no prior execution —
  after recorded execution it fails closed instead of re-baselining over an
  already-modified workspace — and corrupt, foreign-task, mis-rooted, and
  failed-critical retained state still fails closed. The recorded delta
  keeps pre-fault writes against the original baseline; no automatic retry,
  new marker, or publication-policy change.

## [0.1.0-dev.156]

### Tests

- The two native Windows PowerShell 7 (pwsh.exe) ShellStart cases — pwsh
  preference when both editions resolve, and the pwsh exit-status matrix — now
  treat PowerShell 7 as an optional prerequisite (#406). A verified absence
  (`where pwsh.exe` ran cleanly and found nothing) skips them with a truthful
  reason; a present pwsh runs all existing assertions unchanged. A failed,
  timed-out, or malformed lookup fails with diagnostics instead of skipping.
  Focused tests cover the present, verified-absent, and error/timeout/malformed
  outcomes through an injectable lookup runner. The Windows PowerShell 5.1
  fallback, fail-closed ownership/settlement coverage, and production discovery
  are unchanged.

## [0.1.0-dev.155]

### Changed

- Internal cleanup with no behavior change (#241): 34 identical strict
  unknown-valued record guards now share one dependency-free helper. It still
  rejects only `null`, non-objects, and arrays, and still accepts null-prototype
  and non-plain objects such as `Date` and `Buffer`. The evidence parser's
  exported `isRecord` stays available, and every other guard is unchanged —
  including the permissive guards that accept arrays (deferred native
  `tool_search` schema selection, `/review-settings` UI detection, and scoped
  model thinking maps). New parity tests pin both strict and permissive behavior.

## [0.1.0-dev.154]

### Added

- Direct sidebar launches (`scripts/pi-review-sessions.sh` / `scripts\pi-review-sessions.cmd`
  → the shared `scripts/pi-review-sessions.cjs`) now provision the shipped skills
  themselves before host startup, with no wrapper prerequisite (#378). Every file in
  the canonical publication manifest — orchestrator (with its recovery runbook),
  execution, research, and completion — is refreshed into `~/.agents/skills/` using
  the shared atomic per-file publication, followed by the ownership-safe pre-#151
  generic-location migration. Repeat launches refresh stale skills and reuse
  byte-identical installed files untouched; a missing packaged source or failed
  publication stops startup with an actionable error before the host loads.
  User-owned generic skills, customized copies, overrides, namespacing/discovery,
  session/input isolation, roles/capabilities, cancellation/process settlement,
  and fail-closed provenance/runtime checks are unchanged; per-instance native
  launches still do not republish skills. Focused parity/provisioning tests cover
  the shared and supported POSIX/Windows seams (native filesystem evidence on each
  platform, mocked flow ordering/failure semantics), and the CI `windows-launcher`
  job now runs them natively for direct entrypoint setup evidence — real Windows
  ConPTY and sidebar UI readiness remain out of scope.

## [0.1.0-dev.153]

### Fixed

- Failed initialization of a newly allocated review or reviewer-question bundle now
  drains all started setup work before removing its positively identified temporary
  root (#376). Caller-supplied roots, detected substitutions, symlinks, and uncertain
  identities are preserved; private relocation and identity checks fence deletion.
  Cleanup failures/refusals are reported without masking the initialization error.
  Ownership assumes no hostile external same-user mutation during allocation/identity
  capture or private cleanup: public Node APIs cannot atomically bind creation to a
  directory handle or provide fd-relative recursive deletion. That extreme edge case
  remains outside the guarantee, as detailed in the review workflow documentation.
  Successful creation, retention, recovery/checkpoint evidence, and cache behavior
  are unchanged; no historical temporary-directory sweeping is added.

## [0.1.0-dev.152]

### Fixed

- Escape in the foreground pending-input popup now performs only its existing
  close, back, or native completion-dismiss action, without cancelling an
  automatic or command-driven review underneath it (#387). A separate Escape
  immediately after the popup closes still cancels the review normally;
  pending input alone does not intercept cancellation. Review verdicts,
  cancellation settlement, answers, declines, and notice actions are unchanged.

## [0.1.0-dev.151]

### Fixed

- Non-Git delegated source inventory buffer overflows now identify the actual
  inventory command, safely encoded selected workspace, 64 MiB limit, and original
  overflow code with truthful stdout/stderr context, and recommend choosing a
  narrower workspace (#355). Diagnostics exclude inventory output, file contents,
  and original error stacks or arbitrary properties. The 64 MiB/15-second bounds,
  capture eligibility, temporary-enumerator cleanup, cancellation handling, and
  fail-closed worker admission are unchanged.

## [0.1.0-dev.150]

### Changed

- Shipped skills guide `AskUserQuestion` callers to make delayed/shared-pending
  questions self-contained with relevant task, truthful result or uncertainty,
  concrete decision, and meaningful choice consequences (#373). The orchestrator
  skill owns sanitized observed-result and unknown-evidence examples; the execution
  skill links to that guidance. This is instructional guidance, not guaranteed model
  compliance. Tool schema limits, UI/routing/history behavior, async noninterrupting
  delivery, session isolation/privacy, and authorization/confirmation remain unchanged.

## [0.1.0-dev.149]

### Changed

- Pi 1.2.0 is now the targeted runtime (#388). The optional session host's
  `pi-session-host-tui` dependency is now the `@earendil-works/pi-tui` 1.2.0 alias,
  and `pi-review-sessions` provisions an isolated Pi 1.2.0 runtime when no supported
  installation exists. The locked CI Pi UI and agent-core fixtures and the
  exact-version host checks moved to 1.2.0 too. The supported floors are unchanged:
  stable Pi 1.0.4 or newer for the session host, Pi 1.0.0 or newer for the
  extension, and Node.js 22.19.0 or newer. Canonical Pi packages are still never
  hoisted beside the alias. Host form fields remove only the exact fake-cursor
  markers that pi-tui 1.2.0 wraps around the caret before the unchanged sanitizer
  runs, so text after a mid-line caret stays visible. Saved-session search remains
  adapted from Pi 1.1.0, whose native matcher is unchanged in 1.2.0.
- The replacement `tool_search` declares Pi 1.2's public `reachesTools` contract
  so native MCP discovery and server readiness work, while retaining older-host
  schema recognition and the unchanged authorization ceiling (#388).
- Pi 1.2's new idle custom-run `before_agent_start` event arms the review gate
  without adding user-turn prompt guidance to scheduler or wake messages.
  Idle custom runs started by other extensions also gain review-baseline coverage
  on Pi 1.2. Message-start attribution for this extension's messages, older-host
  fallback arming, and settlement remain unchanged (#388).

## [0.1.0-dev.148]

### Added

- The optional session host gains a bounded native Kitty-image display path for
  directly attached Ghostty Main panes (#363), with per-session image state,
  pane-confined placement, and writer-owned graphics cleanup. Unsupported display
  paths retain native-style image text rather than adding settings or host notices.
  Standalone launchers and image input/model processing are unchanged. Physical
  Ghostty display acceptance remains manual; protocol and PTY tests alone do not
  establish it.

### Fixed

- Hosted output again batches queued text-only chunks before xterm snapshots,
  preserving the earlier scrolling row-diff optimization. Unchanged immutable
  PNGs no longer repeat validation/hash work per redraw, and same-owner image
  moves/crops reuse resident data with scoped placement updates instead of
  retransmitting the PNG. Ownership, clipping, bounded output/backpressure, and
  cleanup/restoration fences remain intact (#363).
- Native synchronized redraws now commit text, cursor, and graphics together,
  with alternate-screen image anchors checked against the completed covered rows
  instead of stale text from an unfinished redraw. This prevents false image
  disappearance and repeated PNG uploads between a native placement deletion and
  its replacement. Frame holds are bounded; retained graphics remain budgeted,
  and incomplete frames cannot authorize native mouse clicks against stale contents
  (#363).
- Unchanged eligible source-sidebar launches reuse a verified completed staged
  build instead of installing dependencies and compiling the extension every time.
  Exact source/toolchain changes invalidate reuse; unsafe or incomplete cached
  artifacts are preserved and rebuilt privately. Per-launch Pi/DDGS validation,
  startup guards, ordinary package/standalone launchers, and native user settings
  remain unchanged (#363).

## [0.1.0-dev.147]

### Added

- `YouShouldKnow` adds session-local notices alongside `AskUserQuestion` (#295).
  Notices use a compact title, complete Markdown body, and optional context retained
  in full. Questions and notice details use one shared native question popup and
  Markdown renderer; question text is rendered as Markdown as well. **More details**
  closes that popup before sending the complete retained body/context as an ordinary
  owner-session request with an explicit natural-language request to elaborate in a
  normal conversation reply. The selected notice is consumed before delivery and is
  not restored after a delivery failure. **Close** removes only the selected notice
  and sends nothing. Contextual ordinary user requests stay scoped to the originating
  session and use existing busy-steering or idle non-interrupting delivery. The shared
  `Pending input` list uses a padded popup framed only by full-width top and bottom
  separator lines, and the single active native answer field stays isolated from the
  saved chat draft. Default-on `youShouldKnow.enabled`
  and `youShouldKnow.completionGuidance` settings control notice availability and the
  supplemental completion prompt; the prompt is supplied only when both settings are
  On and live authorized discovery exposes the tool. Disabling availability preserves
  pending notice actions, and disabling guidance does not block authorized calls. The
  completion skill opts out of native automatic skill routing; it is manually available
  only when installed and discoverable in Pi's active environment. Existing question
  answer/decline behavior and in-memory lifecycle remain unchanged; notices add no
  permission grants, dashboard, or notification channel.

### Fixed

- The shared answer popup uses the host-owned native editor for both input and
  popup rendering, suppressing its ordinary prompt rows instead of creating a
  second render-only editor. Native actions and the single caret stay in the
  popup, and closing restores the independent chat draft and ordinary rendering.
- Background activity counts remain independent of restore-persistence and
  cleanup-ownership failures. Ordinary task updates can recover counts through
  a fresh, authenticated same-owner census; incomplete, unreadable, foreign, or
  superseded evidence remains unknown, and cleanup ownership stays conservative.
- Extension-owned question/notice Markdown, titles, and tool results visibly escape
  terminal controls for display without changing stored data or ordinary model
  requests. A guarded optional Pi Markdown display transformer applies the same
  adapter to native conversation Markdown when available; older hosts retain safe
  extension-owned rendering but cannot sanitize their transcript renderer. CRLF
  remains a structural newline, and printable text, ordinary Markdown, and backslash
  escaping are preserved.

## [0.1.0-dev.146]

### Added

- The session host's always-global Saved conversations picker now supports native
  Pi 1.1.0 `/resume` fuzzy-token, quoted-phrase, and `re:` regex search across native
  session fields, plus confirmed Ctrl+D deletion (Ctrl+Backspace only with an empty
  query). The complete delete confirmation occupies the right/Main pane on wide layouts,
  with the roster retained left and cancel returning to the same picker/query/selection.
  Deletion is trash-first with permanent-unlink fallback, revalidates the exact selected
  saved file, protects current and host-loaded conversations, and refreshes the picker
  with truthful outcomes. Plain `d` remains query text; independent children, Main
  ownership, ordinary native `/resume`, and roster stop/remove behavior are unchanged
  (#372).

## [0.1.0-dev.145]

### Changed

- Explicit **Add Resource** enrollment now inserts newly added entries at priority slot 1
  in each supported execution or research route, preserving existing order and
  model/reasoning pairings. Existing entries are not duplicated or promoted, passive
  settings actions do not reorder routes, and slot 1 remains a preference under the
  existing capacity, scheduler, and failover rules (#370).

## [0.1.0-dev.144]

### Added

- The optional session host can independently remap its existing sidebar toggle and
  roster-only return-to-Main chords (#362) through the private
  `<agentDir>/session-host/keybindings.json` file or the Host shortcuts editor. Missing
  settings retain Alt+Left/Alt+Right; the existing `--sidebar-key` remains a toggle-only
  override. Unsupported, conflicting, unsafe, or unreadable settings fail closed, and
  editor saves are atomic and take effect immediately without changing either action's
  behavior or native Pi keybindings.

## [0.1.0-dev.143]

### Fixed

- The saved-session launch revalidation test now disposes its created fixture
  entries, including the deliberately rejected symlink, on success or failure.
  Cleanup preserves unknown or identity-replaced entries and retains original
  assertion diagnostics. The ancestor-replacement regression also rolls back its
  owned symlink and moved tree after assertion failures. This fixes the concrete
  source-capture blocker in #354; broader suite-wide cleanup remains open.

## [0.1.0-dev.142]

### Added

- Clicking the displayed native Main pane while the sidebar roster has focus now
  returns focus to the unchanged active Main owner and consumes the activating click;
  subsequent input reaches that owner. Sidebar selection and visibility, siblings,
  keyboard controls, and already-focused native mouse behavior remain unchanged.
  Forms, confirmations, and the narrow overlay are excluded (#361).

## [0.1.0-dev.141]

### Changed

- Equivalent executor, review, in-place, wave infrastructure, and operation retry
  delays now share one internal exponential-cap/jitter calculation (#240). Existing
  retry numbering, random draws, wait guards, abort behavior, and settlement policies
  are unchanged.

## [0.1.0-dev.140]

### Changed

- Config fingerprints and session-state digests now share one internal, dependency-free
  canonical JSON serializer (#245). The exact serialized bytes and hash inputs are
  unchanged, so existing digests remain valid; the tests' independent legacy/tamper
  fixture serializers are retained.

## [0.1.0-dev.139]

### Fixed

- Partial follow-up to #353: each existing authenticated `session_start` takes one
  bounded snapshot pass over eligible retired execution sources whose exact
  association inventories were sealed by completed detaches. It reads each eligible
  owner at most once, skips already-proven complete empty sources, and does not
  duplicate an in-flight read. Failed or fresh incomplete/unavailable reads leave the
  affected channel unknown and can be retried only on a later explicit `session_start`.
  A controller/source-fenced stale result leaves that exact incarnation's channels and
  tokens unchanged and can be retried on a later event; a source-list change discards
  the captured pass without restarting it within that event. Later admissions or local
  state/token mutations invalidate the owner's seal. A complete census can
  resolve only that old incarnation's uncertainty, and tokens leave only with
  channel-specific release proof; stopped cleanup ownership remains paired with its
  token, and replacements cannot clear it. Missing, corrupt, unmatched, ambiguous,
  stale, or unavailable evidence, uncertain liveness, and lost runtime/force-merge
  ownership remain unknown. There is no polling, task/user notification, state write,
  task resume, or change to ordinary task token formats.
  Historical onset and any screenshot/Claude-link causation remain unproven; this does
  not claim full resolution of #353.

## [0.1.0-dev.138]

### Added

- Authenticated top-level session-host children can use `SessionSpawn` to create a fresh
  native Pi sibling with an explicit existing workspace, title, and initial prompt.
  The child starts in the background without changing selection, focus, active Main
  ownership, or sidebar visibility; no worktree, clone, or branch is created. The new
  title and prompt are delivered through Pi's public session APIs, with inherited parent
  name/message inputs excluded so literal `@`- and flag-leading prompts are not parsed as
  CLI inputs. Ordinary launches, New sessions, and saved-conversation behavior remain
  unchanged. The spawn IPC privacy boundary and launch-only acknowledgement are
  documented in [the session-host guide](docs/session-host-alpha.md) and
  [security model](docs/security-model.md).

## [0.1.0-dev.137]

### Changed

- The session-host sidebar accepts a single left-click on a displayed instance card as
  that row's existing Enter action: a live instance becomes the active Main input owner
  and focuses Main while sibling sessions continue. A fully displayed Saved-picker row
  follows the existing exact-open, admission, duplicate-open, and lifecycle guards; a
  successful open focuses Main. Click targets are tied to emitted frames, not pending
  redraws, so rate limiting or output backpressure cannot activate an undisplayed entry.
  Clicking existing New/Saved/Quit action entries keeps their forms, picker, and Quit
  confirmation behavior. Keyboard controls and native Main
  mouse handling are unchanged, and sidebar clicks are handled by the host rather than
  forwarded to a native child. No new lifecycle action or conversation wheel/trackpad
  scrolling (#332) is added; Windows runtime caveats remain and this does not certify
  Windows behavior (#323, #345).

## [0.1.0-dev.136]

### Fixed

- Main-focus input no longer reconciles layout or prepares/submits a speculative frame
  when the child screen is unchanged (#350). Child-output `onChange` updates and host
  UI, focus, layout, and resize actions remain immediate and are not gated by this
  check; wheel, keyboard, paste, and click forwarding, ANSI handling, redraw cadence,
  and backpressure are unchanged. Interactive trackpad scrolling in Ghostty was
  manually confirmed smooth with this change; this is a single interactive check,
  not a measured latency result or a guarantee for other terminals or platforms.

## [0.1.0-dev.135]

### Changed

- `/review-settings` separates applying settings from persisting them (#294). Root
  Escape applies the edited configuration in memory for the current session only —
  through the same validation and managed-image preparation as a save — and never
  writes the configuration file, so a later `/reload` re-reads the file and may
  discard those choices. Reopening the menu shows the in-memory choices, and an
  immediate **Save changes** or Ctrl+S persists them. Explicit **Cancel** discards
  this menu's edits and restores the settings that were live when it opened,
  including any earlier session-only choices, and copies no images. **Save changes**
  and Ctrl+S are equivalent permanent saves, and Ctrl+S works from any settings
  submenu. Submenu Escape/**Back** navigation, the current-process-only scheduler
  runtime On/Off switch, and existing validation and running-work capture semantics
  are unchanged.

## [0.1.0-dev.134]

### Changed

- Dependency security refresh (#329): the direct `undici` floor moves to `^6.29.0`,
  and the lockfile now resolves `@modelcontextprotocol/sdk` 1.32.1, `fast-uri` 3.1.8,
  `hono` 4.13.13, `ip-address` 10.7.3, and `proxy-addr` 2.0.8, clearing every advisory
  the previous resolution reported: undici WebSocket/retry issues, the MCP SDK OAuth
  authorization-server credential leak, `fast-uri` authority/host confusion,
  `hono` path and parsing issues, `ip-address` IPv6 classifier gaps, and the critical
  `proxy-addr` IPv4-mapped trust-subnet spoofing issue. No audit suppression, install
  scope reduction, or unrelated dependency upgrade is involved; installed behavior,
  the Node >=22.19.0 floor, and the optional `@lydell/node-pty` dependency are
  unchanged, and a fresh unlocked install of the packed package resolves the same
  fixed versions.

## [0.1.0-dev.133]

### Changed

- The optional Windows session host selects the Microsoft ConPTY implementation
  bundled with the pinned public `@lydell/node-pty` dependency instead of Windows'
  inbox implementation; its real Windows acceptance fixtures request the same
  public option. Hermetic native fixtures deny ambient project resources without
  changing user trust policy and require the complete geometry-wrapped Quit pane.
  POSIX PTYs, ordinary standalone launchers, and input/ownership/shutdown safeguards
  are unchanged.

### Known limitations

- Manual Windows validation observed clicks working. That observation does not
  certify other physical mouse input or runtime parity: wheel/conversation
  scrolling, pane-confined selection, complete original Main/outer process
  settlement, the cold hosted launchers, and full terminal restoration remain
  unproven. The real native Main case and both cold hosted-source wrapper legs stay
  explicitly skipped, so green CI still does not certify Windows runtime support
  (#345).
- A cosmetic child-pane flicker on pointer movement and clicks has been observed; it
  is not breakage and not a release blocker (#343).
- Native Pi/review-gate startup latency on Windows has been present since before this
  release and is unrelated to it (#344).

## [0.1.0-dev.132]

### Changed

- The optional session host's sidebar now reports background work as **activity
  intent** rather than as unsettled cleanup ownership (#339). The displayed
  task/shell numbers and the running/idle line read a separate nullable intent
  channel: logical work counts while it is admitted/queued, capturing, running,
  reviewing, accepted, waiting to land, or landing, and while an actual
  force-merge is executing or an accepted continuation is queued/active; a shell counts
  while it is starting/running, including known live owned descendants after a
  Windows shell root exits. A task or shell that stopped — stopped, paused,
  recoverable, failed, or conflict-blocked with no admitted work — reads zero
  even while it still owns recovery artifacts or cleanup obligations. Shells
  continue counting until their activity is observed stopped; reaping or a bare
  error alone is not proof of exit. Unknown or unobserved activity stays unknown,
  never a fabricated zero.
  The status frame gains optional `activeTasks`/`activeShells` fields; an older
  reporter that omits them stays unknown and is never substituted with the
  ownership counts. The separate conservative ownership counts remain on the
  wire and still gate the idle-only stop/remove confirmation and shutdown
  preflight, so retained work is never silently dropped, and a pre-intent global
  registry record keeps its valid ownership counts with unknown intent.

## [0.1.0-dev.131]

### Fixed

- The optional session host's generated-frame writer now defaults to a 16 ms
  minimum redraw interval (about 60 fps), matching Pi's native minimum redraw
  cadence, and emits only rows that changed since the last written frame (full
  redraw on start, a geometry change, or an actual resize notification — even
  one that returns to the previous dimensions — cursor-only sequences for
  cursor moves, no output for unchanged frames); fast invalidation bursts still
  coalesce to the newest frame and a blocked sink retains only the newest
  bounded frame (#332).

## [0.1.0-dev.130]

### Added

- The optional session host now remembers one global sidebar roster in the
  canonical Pi agent directory (`PI_CODING_AGENT_DIR`, otherwise
  `~/.pi/agent`) and restores it automatically from any launch directory:
  remembered rows return in their original order as new independently owned
  children started only from a freshly revalidated saved conversation in the
  exact remembered workspace, with the remembered active entry preserved unless
  a deliberate user action happened while restoration was still running. A
  remembered entry that cannot be freshly admitted — including one whose saved
  workspace changed, or one whose child never reported any conversation — keeps
  its roster position as a bounded, non-activatable error row and never starts a
  fresh session, and a row's remembered identity follows an in-native `/new` or
  `/resume`. Explicit row removal forgets one entry while Quit keeps the roster,
  and one host owns a Pi agent directory exclusively: a second host sharing it
  is refused before it starts anything, with ownership released only after owned
  child state positively settled and otherwise left fail closed (#331).

## [0.1.0-dev.129]

### Added

- Optional `pi-review-sessions` terminal host alpha for same-machine POSIX
  macOS/Linux (#323, related research #274). Each explicitly created row owns
  an independent native Pi process, workspace and native conversation, sharing
  ordinary native Pi configuration/resources without per-window profiles.
  Highlighting or hiding a row changes no ownership;
  activation is explicit and input is never broadcast. The separate launcher
  requires Node 22.19.0+, stable Pi 1.0.4+ and a supported readable Node CLI
  entry; provisioned Pi, the matching TUI dependency and native UI acceptance
  fixture are pinned to 1.1.0. Parent resume/session/storage overrides are rejected; ordinary native
  arguments and commands remain native. Public terminal APIs, independent
  headless surfaces and bounded generated frames provide text/SGR display and
  observed generic sidebar status, with explicit Unicode, mouse and platform
  limits. Existing standalone launchers remain unchanged. See
  [the alpha guide](docs/session-host-alpha.md).

### Fixed

- Background-shell exit cleanup preserves native and foreign asynchronous
  signal handlers through the public, directly pinned `signal-exit` API
  instead of deleting handlers and re-sending signals (#324). Owned-job
  termination/watchdog cleanup and ordinary Windows behavior remain intact.
- Pending-question widgets retain their current-session public widget sink
  separately from fresh shortcut dialog/editor contexts, with stale-context
  fences. Answer completion clears observed pending status without inventing
  lifecycle events or inferring clearance from idle state (#323).

### Known limitations

- Windows sidebar/host runtime acceptance is deferred to #334 for this release: the
  real native Main case (startup, public Quit confirmation, original-process/kernel
  settlement/restoration) and both cold hosted-source wrapper legs (cmd and direct
  PowerShell) are retained in the suite but explicitly skipped, so green CI does not
  certify Windows runtime support; the Windows sidebar/host remains optional
  experimental. The hosted **Main** mouse routing limitation also remains unresolved
  (#334): the pane does not accept ordinary terminal mouse tracking/SGR reporting, so
  terminal-like selection can span panes and wheel input can move editor history
  rather than the full conversation; no proven cause. The mouse-specific assertion is
  temporarily deferred to that ticket, not fixed; production ownership guards and the
  remaining tests stay enabled.
- The recurring Windows delegated Pi RPC descendant-proof launch failure remains
  unresolved (#335). The Windows-only alias-independent RPC case is temporarily
  deferred to that ticket, not fixed; production ownership guards and the remaining
  tests stay enabled. Ordinary standalone launchers, POSIX behavior, and shared
  native configuration remain unchanged.
- The Windows device-attributes query/reply witness remains unresolved (#337):
  the expected device-attributes reply was not observed in either Windows
  22.19/24 alpha lane, so that single assertion is temporarily deferred to
  that ticket, not fixed; no cause is established and no Windows compatibility
  claim is made. It belongs to the broader #334 Windows-host follow-up. Production
  ownership guards and the remaining tests stay enabled.

## [0.1.0-dev.128]

### Fixed

- A Claude Code executor no longer ends its run on a successful turn result while
  native background work is still running (#218). The adapter tracks the Agent SDK's
  authoritative `background_tasks_changed` level signal — the complete live background
  task set under replace semantics, covering Bash `run_in_background` commands and
  background subagents — and holds a successful result instead of treating it as final
  while that set is non-empty. The streaming session stays open, so live steering and
  explicit interruption keep working, and once the level reports no live task the
  adapter requests one inspection turn so the worker reads the completed task results
  before normal settlement, and a later turn that replaces or interrupts that
  inspection earns a replacement inspection so normal success always follows a
  completed one; a failed turn result stays terminal and is never replaced by a later
  turn. The configured executor timeout is unchanged and remains the
  absolute bound of the whole run — unlike the Pi executor's verified process-group
  readiness, native Claude background work never suspends it — and cancellation,
  interruption, steering retargeting, and research restrictions are unchanged. When a
  successful background launch is never reported in the SDK membership level, that
  membership is malformed, or the stream ends while background work is still
  outstanding, the run fails closed as a protocol failure instead of normalizing on a
  result that predates the unfinished work; a rejected background launch is not treated
  as in flight, and earlier membership evidence never discharges a later launch — a
  launch is verified only by a membership update reported at or after it started.
  Terminal results that cannot be correlated to the current completion target are
  buffered rather than treated as that target's outcome.

## [0.1.0-dev.127]

### Fixed

- Automatic notifications no longer advertise an expansion that cannot happen (#326).
  A notification whose shape cannot be compacted truthfully — unknown, historical, or
  malformed content — already rendered its complete retained text in both states, but
  the shared expansion core still appended the native `(ctrl+o to expand)` /
  `(ctrl+o to collapse)` hint, promising a change expansion could not make. The
  collapsed renderers now explicitly mark such a row as the complete retained text
  (`markFullTextFallback`), and the shared core shows it in both states with no
  expansion hint; a genuinely compact row keeps its hint unchanged. The signal is
  explicit renderer state, never a comparison of rendered lines, so width, theme, or
  partial rendering cannot disable a real row's expansion, and tool-result rows —
  which do not opt into the marker — render byte-identically to before.
- Recovery-required failure notifications now compact from the curated diagnostic even
  when the structured message details are absent or empty (#326). The collapsed
  subtask-event card previously required a usable `details.diagnostic`; when a host or
  history delivered only the retained notification text (the producer's own recovery
  preamble, the literal diagnostic-boundary line, and the curated JSON), the card fell
  back to the full text. The text-only path now recognizes exactly that producer shape,
  validates the embedded JSON structurally, and requires its task/execution/kind/state/
  revision/progress identities and its notice/summary/error text to agree with the
  preamble, so unrelated, inlined, or truncated JSON can never be compacted into a
  misleading recovery summary. Valid structured details remain authoritative;
  nonempty but unusable structured metadata is never replaced by a text-derived
  diagnostic, and a diagnostic recovered from text is rejected when it contradicts a
  supplied taskId, executionId, or state, so the full retained text is shown instead.
  The collapsed card keeps the immediate error and notice plus EVERY recovery action
  visible, expansion still shows the complete retained text and nothing beyond it, and
  contraction restores the compact card. The shared presentation-core unit tests, the
  notification unit tests, and the real-host tests cover absent/empty/valid diagnostic
  metadata, nonempty-invalid and conflicting metadata, identity-inconsistent and
  truncated content, no-hint fallbacks, and the native keyboard/click paths.

## [0.1.0-dev.126]

### Changed

- Worker concurrency and task-submission maxima now reach 128 (#119). The
  user-configured `execution.maxWorkers` range is 1–128 (default 4 unchanged) as the
  session-wide worker budget shared by every group, each `workerResources` entry's
  shared `maxConcurrent` range is 1–128, and `SubtasksStart`/`SubtasksAdd` accept
  1–128 task definitions per call. The three limits stay distinct: how many tasks one
  call may submit, how many workers run at once, and the independently enforced
  per-execution unsettled admission cap, which remains 128. Sequential top-offs after
  tasks settle remain unbounded, and reviewer concurrency still does not draw on the
  worker pool. Queueing, per-resource capacity, review, landing, cancellation, and
  recovery behavior are otherwise unchanged, and the larger maxima imply no
  sustained-operation or performance guarantee.

## [0.1.0-dev.125]

### Fixed

- Notification cards regained the native custom-message theme (#92 correction).
  The #92 expansion renderers re-created the rows bare — compact header/report line
  and expanded retained text rendered directly on the ordinary terminal background
  with the default foreground, so automatic notifications blended with surrounding
  assistant inference text. The five notification families now wrap their rows in the
  host's own native card in BOTH states — the same pi-tui
  `Box(1, 1, (t) => theme.bg("customMessageBg", t))` the default
  `CustomMessageComponent` uses, with the original one-cell horizontal/vertical
  padding and every row (content, wrapped hint, and the blank padding rows) filled to
  the terminal width — and the plain body text and family labels follow the native
  `customMessageText`/`customMessageLabel` fg tokens with the existing outcome colors
  preserved. Every cell stays terminal-safe: at degenerate widths (below the three
  cells the padding needs) the card renders a width-aware narrow path — zero
  horizontal padding, the same vertical padding and background, and rows clipped to
  the exact cell width with the host's own ANSI-aware `truncateToWidth` (single wide
  graphemes clip rather than overflow, with the card background reapplied after the
  truncator's full reset so no cell — padding included — is left unthemed) — so no
  card row ever exceeds the requested
  width in any state. Colors resolve through the theme at render time — no
  snapshotted ANSI,
  no hard-coded colors — so compact and expanded cards follow the active theme
  (including nondefault/custom themes and theme changes) exactly like the host's own
  card. Content, expansion, click behavior (any card content or padding location
  toggles that one item), hints, degradation paths, and tool-result card backgrounds
  are unchanged. The real-host suite establishes the actual card styling (themed
  full-width fill, padding rows, token fg output) in both states, pins render-time
  theme re-resolution including an in-place token change, and the compiled-launch
  PTY regressions (default/remapped/empty binding, independent clicks) still pass on
  installed Pi 1.0.4 and the 1.0.2 pinned runtime.
- Compiled launches now actually wire the shared expansion peers (#92 correction).
  A compiled CommonJS extension entry is loaded by pi ≥ 0.86 through native
  import, whose `require()` calls bypass the extension loader's package aliases —
  so the notification renderers' bare-name `require("@earendil-works/pi-tui")`
  failed, was cached, and every automatic notification silently rendered through
  the host's native full-text fallback (no compaction, no hint, no expansion),
  exactly as reported for installed Pi 1.0.4. The five notification families and
  the shared hint core now resolve their peers through the established shared
  host-relative loader (`src/host-peer-loader.ts`) asynchronously at activation
  and complete during interactive session setup — before pi renders the initial
  transcript — with rendering itself performing no loading; when a peer is
  genuinely unavailable the documented native fallback applies unchanged. The
  configured expansion binding is resolved on the separately evaluated pi-tui
  record from the running host's own keybinding configuration — the host's own
  `KeybindingsManager.create()` static factory, so built-in defaults plus the
  user's `keybindings.json` overrides make a remapped binding resolve exactly
  as the host renders it — never hard-coded; a configured initialization that
  fails installs nothing rather than substituting defaults. Tool and
  notification content, native state, delivery, and model-visible behavior are
  unchanged. The compiled-launch regression
  `tests/message-expansion-compiled-launch.test.ts` drives the real built
  candidate through pi's public `--extension` seam on a real PTY (compact
  two-family rendering with the live hint, default Ctrl+O and a remapped
  keybindings.json binding driven by its real keystroke expanding/contracting
  the complete retained text, a configured-empty binding rendering no hint,
  and independent fullscreen clicks) and is required host coverage; it fails
  with this exact regression on the unfixed candidates.

### Changed

- One shared presentation expansion core (#92). `src/presentation-expansion.ts` and
  `src/presentation-hints.ts` now own the cross-cutting expansion presentation —
  renderer selection, native configured hints, width safety, the visible
  detail-failure fallback, and component forwarding — for every expandable
  extension row. `src/tool-result-expansion.ts` and `src/tool-result-hints.ts`
  become thin backwards-compatible adapters over that core, so tool behavior is
  unchanged: the same registrations, host-owned `{ expanded, isPartial }` state,
  the global keyboard expansion binding (`app.tools.expand`, ctrl+o by default),
  fullscreen per-card clicking, provenance, and native image presentation.
- Automatic notification compaction (#92). Five automatic notification families
  now render through the same shared core as compact, expandable messages:
  `pi-review-subtask-event` (task title, the actual landed/reported/failed/
  conflicted/recovery outcome, available aggregate progress, and a separate full,
  usable report-reference line; actionable failure, conflict, and recovery
  details stay visible without expansion, and in-place settlement is shown
  through the event's own state rather than as a Git landing),
  `pi-review-bg-shell` (job identity, wake reason, exit status where reported,
  and actionable failure or match information), `pi-review-subtask-watch`
  (execution-level active-work summaries, explicitly a checkpoint rather than a
  completion or failure), `pi-review-scheduled-task-event` (schedule identity and
  due occurrence, the truthful skipped/not-run/failed/uncertain outcome and
  immediate action, including retry and duplicate warnings), and
  `pi-review-scheduled-orchestrator-turn` (schedule entry and due occurrence
  only, with no execution or completion claim; the full instructions are one
  expansion away). Expanding a notification shows all of its current
  notification text and nothing beyond it — no report, log, or artifact fetch,
  no polling, execution, or other I/O — and never changes the model-visible
  payload, upstream privacy or retention, delivery lanes, lifecycle tracking,
  wake policy, or scheduler behavior. The existing short subtask launch and
  background-ready notices, hidden messages, and native host-owned messages are
  unchanged. Unknown historical or malformed notification formats fall back to
  the full retained text, and when the host's renderer APIs are absent the
  native full presentation applies. Keyboard expansion follows the same native
  configured binding as tool rows; fullscreen clicking operates a single item
  through the public pi-tui `MouseRegion` with per-message state reconciled to
  the host's global expansion flag; regular mode remains keyboard-only, with no
  host patching and no competing keyboard binding. See
  [Development → Shared native presentation
  expansion](docs/development.md#shared-native-presentation-expansion).

## [0.1.0-dev.124]

### Added

- Re-armable one-shot scheduled tasks (#306). Scheduled task entries accept two
  optional boolean fields, `oneShot` and `alreadyRun`, each `false` by default
  when absent, so existing entries stay recurring and need no migration. A
  `oneShot: true` entry is eligible to fire only while `alreadyRun` is `false`;
  the scheduler records `alreadyRun: true` when execution of a due occurrence
  actually starts — the scheduled worker's prompt delivery for the subtask
  destination and the matching scheduled-message observation inside the host
  run for the orchestrator-turn destination — and never through launch
  admission, queueing, completion, model-reported success, or review results,
  none of which reset the consumed state. Skipped occurrences and launch sends
  that never start leave the flag unchanged. The entry remains in the catalog
  after it runs, disarmed; setting `alreadyRun: true` manually disarms it
  without executing anything, and setting it back to `false` re-arms it for its
  next future cron occurrence under its existing `enabled` setting — no
  immediate run and no catch-up. Cron expressions, schedule destinations,
  scheduler firing reliability, and future-only scheduling are unchanged. See
  the scheduled-task docs, [One-shot entries](docs/scheduled-tasks.md#one-shot-entries).

## [0.1.0-dev.123]

### Changed

- Non-Git parent review checkpoints are no longer written inside the workspace
  (#301). Every record now lives in the live Pi session's namespace under Pi's
  agent-data directory, `<agent dir>/sessions/pi-review-gate/<session id>/checkpoints/`
  (`~/.pi/agent` by default, following `PI_CODING_AGENT_DIR` on every platform), for
  persisted and in-memory (`--no-session`) sessions alike. Review is not disabled for a
  session without a conversation file, and no conversation persistence is enabled for
  one. The location never follows the conversation file (even one inside the
  workspace) or Pi's session-directory setting. Records bind the live session,
  canonical workspace, review window, and a random owner generation; they are private,
  atomically published, and every publication flushes each directory entry it depends
  on. A restart verifies every checkpoint the saved review references before deciding
  whether damage is recoverable. Loading and release re-derive the location from
  the live session rather than any stored path, and only the verified owner generation
  is removed at the existing release points. A record of another session or workspace
  can never be cut over as recoverable damage. For an ordinary project root that
  neither contains the checkpoint store nor lies inside it, no checkpoint bytes are
  written under that root, so delegated task capture of it no longer sees checkpoint
  records or counts them against `maxSnapshotBytes`; the overlapping case is a known
  limitation described below. Ordinary project `.pi-review-gate` content, top-level
  or nested, is captured and reviewed normally. Git checkpoints are unchanged.
- The non-Git checkpoint format is now `prg-parent-raw/v2`. A persisted review window
  that references an earlier non-Git format fails restore closed instead of being
  migrated, and earlier in-workspace `.pi-review-gate/checkpoints` records are neither
  read nor removed. If the agent-data checkpoint location overlaps the captured
  workspace (for example `PI_CODING_AGENT_DIR` inside it, or a non-Git session started
  in an ancestor of the agent directory such as the home directory), non-Git checkpoint
  capture fails closed with an explicit unsupported-configuration error.

### Known limitations

- A workspace that overlaps the checkpoint store is only partly supported in this
  release (#301). A non-Git review root that contains the store, or lies inside it, is
  rejected as an unsupported configuration, as described above. A delegated execution
  target whose tree contains the store is not rejected: its automatic task capture and
  downstream snapshots may include checkpoint record files, and those bytes count
  against capture budgets such as `maxSnapshotBytes`. Keeping the Pi agent directory
  outside review and delegated workspaces avoids both. Follow-up
  [#318](https://github.com/rfairburn/pi-review-gate/issues/318) will exclude exactly
  this extension's checkpoint record files from automatic and downstream collection,
  without choosing another storage destination and while still retaining tool-based
  evidence of modifications to those files. Record file permissions and capture-size
  limits are unchanged.

## [0.1.0-dev.122]

### Fixed

- A Claude explicit Interrupt after non-interrupting steering no longer waits for
  the superseded steering result or the executor timeout. Any terminal result after
  the native interrupt settles the run; a missing acknowledgement or result falls
  back after a bounded wait and closes the session. Steering surviving the native
  interrupt (`still_queued`) is stopped by closing the session rather than running
  afterward, and steering during or after interruption reports non-delivery.
  Adapter acknowledgement requires verified owned process-group shutdown; a missing
  native acknowledgement or unverified shutdown is reported as failed with diagnostics.
  When shutdown is unverified, the operation stays `failed_critical` with its writer
  ownership retained, and the interrupt command is never acknowledged or merged.
  Codex, native Pi, controller queueing, retries, and review gates are unchanged (#310).

## [0.1.0-dev.121]

### Tests

- Make the child-teardown suite's owned fixture-root removal reliable on Windows
  (test-only; #312). Removal still runs only after each recorded owned PID has
  actually exited, then retries a transient Windows directory lock (`EBUSY`,
  `ENOTEMPTY`, `EPERM`) for at most about five seconds. Other errors, POSIX
  errors, and an exhausted budget still fail with the original error code.
  Focused regressions cover the retry rules, and a native Windows test shows that
  removal fails while an owned child holds the root as its working directory and
  succeeds after that child exits. Every existing teardown assertion is
  unchanged, and runtime behavior is unchanged.

## [0.1.0-dev.120]

### Added

- The no-argument `/subtask-steer` now asks, after you pick a task and before you
  enter the instruction, whether to steer without interrupting the active turn
  (listed first) or to interrupt it and then steer. The choice is sent as the
  existing `SubtasksSteer` `interrupt` flag, so it keeps the same task, workspace,
  review gates, transport statuses, and fail-closed handling. Dismissing any prompt
  steers and interrupts nothing. The explicit
  `/subtask-steer <executionId> <taskId> <instruction>` form and the model-facing
  `SubtasksSteer` API are unchanged (#309).

## [0.1.0-dev.119]

### Fixed

- Stop labeling every Claude execution error as an API error; progress now
  includes available subtype and `errors[]` diagnostics. Interrupting steering
  and explicit Interrupt report `model turn interrupted` when an acknowledged
  owned interrupt correlates with abort evidence. Diagnostic-only cutoff results
  require a native interrupt receipt excluding the target from `still_queued`;
  CLIs without that receipt require an explicit abort terminal reason instead.
  Unproven, racing, rejected, and genuine failure results retain failure labels.
  Execution, retry, cancellation, and review semantics are unchanged (#305).

## [0.1.0-dev.118]

### Added

- Create and manage Claude Code and Codex CLI definitions in `/review-settings`,
  editing ID, adapter, roles, timeouts, and human-readable Model/Reasoning
  choices. Release catalogs include versioned Claude models and eight Codex models;
  custom/pinned values remain until explicitly replaced. Model-specific structured
  `reasoningEffort` supports Shared inheritance and explicit role CLI default (not
  off), distinguishes Max from Extra High (`xhigh`), and discloses Codex Ultra's
  automatic task delegation. Invalid or incompatible effort requires explicit resolution, not
  silent fallback. Create/Apply automatically sets `claude`/`codex` and fixed native
  protocols, with no executable/argument-list/protocol-override menus. Only that
  edited definition imports legacy effort and removes other advanced arguments,
  custom paths, and native protocol overrides, with scoped warnings before staging;
  untouched legacy configurations remain compatible.
- List every external definition; supported editors offer Delete directly beside
  Apply/Cancel, targeting the original identity despite unapplied edits, including
  newly staged definitions. Unsupported types offer only Delete/Back. Renames keep
  references paired and resource IDs/routes stable. Deletion reports resource,
  route, and reviewer cleanup, disables invalidated schedules, and resets only
  invalid pins or emptied review overrides to inheritance with later-default notices.
  Root Save/Cancel atomically persists/discards the shared draft, preserving unrelated
  definitions and rejecting catalog conflicts. Creation/editing never enrolls workers
  or invokes providers; catalogs do not guarantee installed CLI/account access.
  Missing native CLIs on PATH warn without blocking Save, including selected workers;
  runtime failures remain failures (#49).

### Changed

- Simplified the native external worker editors in `/review-settings`: they no longer
  offer shared/role environment key/value editing or entry counts. `env` remains
  supported in the `externalAgents` schema and honored at runtime; configure
  environment variables by editing the configuration file directly, and Apply,
  rename, and unrelated staged edits preserve existing shared/role environment
  entries while the roles remain enabled (disabling a role drops that role's
  overrides, including its environment). The root menu now lists **External
  workers** immediately below **Worker resources**; ordinary rows and Save/Cancel
  behavior are unchanged (#49).

## [0.1.0-dev.117]

### Fixed

- Use one shared Windows Pi spawn specification across the launcher, reviewer,
  delegated RPC executor, and compaction recovery: resolve the full `pi.cmd`
  path and invoke it through the parent's validated absolute
  `SystemRoot\System32\cmd.exe`, without inspecting Pi's shim or trusting the
  child environment, `ComSpec`, `PATH`, or working directory; invalid or missing
  interpreter paths fail closed. Simple managed and npm-generated shims use the
  same path; `pi.exe`, custom commands, POSIX launch semantics, setup,
  management passthrough, exit-status propagation, and the launcher's npm-only
  build parser are preserved; its batch fallback also uses the validated
  system command processor and fails closed when unavailable (#290).
- Keep the Windows `cmd.exe` PID as the lifecycle and process-tree cleanup root
  while authenticating the actual Pi PID from the signed settlement receipt.
  Before first binding, the parent verifies live, snapshot-stable ancestry and
  requires each parent to predate its child, rejecting recycled PIDs; later
  receipts require exact PID equality. The receipt wire schema and HMAC
  child/session/generation identity are unchanged (#290).
- Bound reviewer, RPC executor, and compaction-recovery teardown when an exited
  root leaves inherited pipes open. Root exit and cancellation stop background
  readiness waits; uncertain cleanup fails explicitly without accepting a result,
  inventing exit status, or treating locally destroyed pipes as descendant cleanup.
  Native Windows regressions cover all three launch paths (#290).
- Keep cancellation and deadlines active during asynchronous PID persistence;
  bound terminal lifecycle callbacks without delivering prompts after teardown.
  Preserve late callback ordering and match exit updates to the originating
  lifecycle so they cannot clear a newer child's ownership (#290).

### Changed

- Require fresh, locked full Pi 1.0.2 installations on Linux and Windows CI,
  exercising the installed command's version, provider-free RPC, candidate
  registration, and a generated simple managed-style wrapper. Missing required
  prerequisites fail instead of skipping; Pi remains a test-only dependency (#290).

## [0.1.0-dev.116]

### Documentation

- Explain the release builder's lightweight-tag-only requirement, annotated-tag
  rejection, and operator recovery boundaries without changing publication behavior
  or immutable-tag protections (#30).

## [0.1.0-dev.115]

### Fixed

- Invoke the resolved full Windows `pi.cmd` path with the extension and launch
  arguments instead of parsing its JavaScript entry point. Simple Pi 1.0.0
  shims and future shim layouts no longer depend on npm's shim format; normal
  batch parsing applies. Launcher setup, management passthrough, and exit
  status propagation remain unchanged (#287).

## [0.1.0-dev.114]

### Fixed

- Bound recovery for an unobserved background-shell exit wake to one hidden,
  cancelable control turn that resumes Pi's retained follow-up queue; the
  completion is not re-sent and unrelated queued messages are untouched. The
  recovery turn remains directly cancelable; ambiguous lifecycle outcomes favor
  delivery without guessing model intent. Canceling recovery does not start
  another attempt, while routine status wakes remain best-effort. Real-host
  tests cover delivery after an aborted run and aborting
  recovery before the retained exit is drained; the original report's precise
  cause remains unestablished (Refs #281).

## [0.1.0-dev.113]

### Fixed

- Allow ordinary review checkpoints in initialized repositories before the
  user's first commit by pinning a synthetic empty-tree baseline under the
  checkpoint-owned ref. Staged, unstaged, and non-ignored untracked state still
  uses the normal review path; the user's HEAD, branch refs, and live index are
  unchanged, and unverified HEAD state remains fail-closed. Windows requires Git
  2.36.0 or newer for durable synthetic objects (#284).

## [0.1.0-dev.112]

### Fixed

- Preserve exact large NTFS wave-root inode and volume identities through capture,
  persisted reload, landing, and authenticated recovery. Safe numeric identity
  fields keep their existing version-1 encoding; larger unsigned 64-bit fields
  use canonical decimal strings, requiring an updated build to reload/recover
  those records. Root replacement and retarget checks remain fail-closed (#282).
- Restore native Windows raw parent-review baseline capture when directory-handle
  fsync returns `EPERM`, matching the existing Git checkpoint exception. File
  flushes and other filesystem failures remain mandatory; mocked Windows tests
  cover ancestor and final-directory flushes and fail-closed error boundaries
  (#282).
- Apply the existing Windows path-stat/open-handle device-ID normalization to
  raw file capture and record reload, preserving all other identity checks;
  accept native absolute descriptor roots so Windows drive and UNC paths can
  reload without accepting relative paths (#282).

## [0.1.0-dev.111]

### Changed

- Replace Pi's builtin `tool_search` with review-gate's own inventory-backed
  loader registered under the same replaceable name: there is now one
  model-facing discovery/activation tool, and `search_tools` is no longer part
  of the tool, prompt, or documentation contract (#279).
- The loader directly activates authorized matches — ordinary, codemode- and
  deferred-exposed (including MCP), and model-only tools — declaring their
  schemas for the next model call without ever executing the matched operation.
  Exact-name-first matching, the compact discovery inventory in the tool
  description and startup prompt, native script callability of codemode/deferred
  exposures, permission gates, the deferred-off setting, operating modes,
  research visibility, and fixed worker ceilings are unchanged (#279).
- Supported live MCP changes (server connect/disconnect, `/mcp reconnect`,
  enablement/exposure changes, and server tool-list notifications) update
  discovery at Pi's real reconciliation seams without a reload; removed, hidden,
  or withdrawn tools are pruned from inventory and activation (#279).
- The loader now registers at session start (after top-level execution tools are
  synced and before authorization capture) instead of at extension load time, and
  reuses the host-native `tool_search` parameter schema by exact object reference —
  borrowed from the live registry when Pi's builtin is loaded, otherwise captured
  from the running install's own bundled factory. Pi's replaceable-builtin
  collision pass therefore sees no competing definition, its identity-based
  tool-search recognition accepts the replacement with the builtin enabled,
  disabled, or toggled across a reload, and both misleading startup warnings are
  gone while genuine diagnostics (including the truly-missing discovery warning)
  remain visible. When no running host resolves the local fallback schema is
  kept; when a resolved host's native schema cannot be acquired, session start
  fails explicitly instead of registering the incompatible fallback (#279).
- `tool_search` honors the native limit contract: a supplied positive integer or
  the default of eight caps strongest-tier matched/activated results per call,
  invalid limit values fail explicitly, the omitted count reports exactly what
  the cap withheld from that call, and the discovery inventory in the loader
  description and startup prompt stays complete and uncapped (#279).

## [0.1.0-dev.110]

### Changed

- Require Pi 1.0.0 or newer and Node.js 22.19.0 or newer; replace the Node 20
  verification tier with the minimum supported Node 22 runtime and validate
  native Pi integration against locked Pi 1.0.0 fixtures (#224).
- Make native `codemode` available to wrapper-launched execution/orchestration
  and authorized Pi execution workers through the ordinary deferred-tools
  setting: search/load when on, normally loaded when off. Research roles keep
  codemode and all MCP tool access disabled. Preserve explicit Pi restrictions,
  native MCP exposure, and captured worker authorization ceilings (#224).

### Fixed

- Reconcile tool discovery and calls against Pi's live registrations so withdrawn
  or hidden tools cannot remain available through stale loader entries. Correlate
  codemode's native nested calls with their admitted parent while retaining
  permission, duplicate-start, review, and evidence boundaries (#224).

## [0.1.0-dev.109]

### Fixed

- Clean only the session-sidecar writer's owned unpublished temporary file after
  a failed write, sync, close or rename (#243, audit #46). Preserve committed
  data, exclusive-create permissions, successful publication order and existing
  error precedence; cleanup remains best-effort and never hides the failure or
  removes another writer's file or a pre-existing collision.

## [0.1.0-dev.108]

### Fixed

- Make both real-host tool-card integration suites honor the established
  required-host gate and the installed Pi package pin (test-only; #247, audit
  #46). When PI_REVIEW_GATE_REQUIRE_PI_HOST is exactly "1", a missing or
  unloadable host fails clearly with the required-host diagnostic instead of
  skipping; optional environments keep their honest reason-bearing skips. A
  set PI_REVIEW_GATE_INSTALLED_AGENT pin is the sole discovery candidate and
  never falls back to an ambient installation, while unpinned runs retain the
  PI_CODING_AGENT_DIR node_modules-root override and standard global-root
  discovery. Existing native-host assertions, test registration, Windows/CI
  policy, host versions, and production behavior are unchanged.

## [0.1.0-dev.107]

### Fixed

- Decode the Codex executor's stdout and stderr incrementally as UTF-8 so a
  valid multibyte character split across transport chunks no longer becomes a
  replacement character in the JSON-RPC line buffer or the retained captures,
  preserving agent text summaries, tool-event paths, and diagnostics (#238,
  audit #46). Each channel's decoder holds a trailing partial sequence until
  the chunk that completes it, and held tails flush at close; a genuinely
  incomplete final sequence still decodes with the replacement character, as
  full-stream decoding always did. RPC routing and framing, retained-output
  caps, malformed-line handling, abort behavior, and startup/shutdown
  settlement are unchanged. Focused controlled-child regressions require split
  and intact chunk delivery to receive byte-identical results.

## [0.1.0-dev.106]

### Fixed

- Contain a Codex executor's dead stdin transport through the existing
  failed-executor outcome (#268). When the app-server child closes its stdin read
  side while still alive, stdin stream errors and synchronous dead-channel refusals
  of request, notification, and reply writes are remembered as a transport failure:
  pending and later-registered protocol requests and turn waits settle with it as the
  executor's ordinary failure — not as an uncaught stream error, a forced completion,
  or a wait that never settles — and no further writes are attempted against the dead
  channel, while already-completed turn results remain authoritative. Healthy protocol
  framing and decoding, retained stream and evidence caps, startup observation order,
  cancellation precedence, termination and child settlement, review admission, retry
  limits, provider routing, and configuration are unchanged.

## [0.1.0-dev.105]

### Changed

- Use synthetic names in test fixtures; preserve test behavior.

## [0.1.0-dev.104]

### Fixed

- Preserve completed in-place worker summaries in the normal bounded, redacted
  review evidence, including the initial turn, retries and restored context
  (#266). Summary-only deliverables need no report file; review admission,
  zero-delta skipping, authorization and retry limits remain unchanged.

## [0.1.0-dev.103]

### Changed

- Share the explicit-Add worker-resource enrollment rule between its immediate
  Add action and final-model reconciliation (#249, audit #46). Preserve route
  membership, ordering, research eligibility, reasoning, and staged Save/Cancel
  behavior; passive loading or saving still never activates unused resources.

## [0.1.0-dev.102]

### Fixed

- Correct reviewer configuration examples and onboarding review roles, retaining
  the advertised models, timeouts, limits and correction settings (#250, audit
  #46). Clarify startup recovery warnings versus strict configuration writes,
  all settings sections, scheduled in-place work and the browser-tool inventory.

### Changed

- Organize scheduling, settings, interactive browsing, browser approvals and
  permissions, and subtask evidence into linked canonical guides. Keep the
  README focused on setup, essential limits and task-oriented navigation.
- Validate shipped JSON configurations and runnable documentation examples
  through production normalization and hermetic reviewer resolution. Require
  every discovered documentation page to be reachable and verify installed
  documentation and examples byte-for-byte against source. Runtime behavior,
  configuration policy, reviewer/model choices and safety boundaries are unchanged.

## [0.1.0-dev.101]

### Changed

- Decompose activation diagnostics, pending delivery, persistence/owner
  retirement, prompt composition, review cancellation and review-turn mechanics
  into cohesive internal owners (#254, audit #46). The composition root retains
  ordered host registrations, bootstrap, live session state and orchestration;
  entry identity, prompts/notices, durable proof, restore/cutover, cancellation,
  settings-save/shutdown order and fail-closed behavior are unchanged.

## [0.1.0-dev.100]

### Changed

- Decompose background execution into cohesive lifecycle, parent-checkpoint,
  wake-delivery, salvage, scheduling and indicator owners (#237, audit #46).
  The controller retains authoritative records, leases, serialization tails,
  command transitions and transaction boundaries. Public APIs, task-kind
  distinctions, launch/outcome ordering, cancellation and settlement, durable
  recovery, scoped gates, notices and review/retirement proofs are unchanged.

## [0.1.0-dev.99]

### Changed

- Decompose browser limits, approval bindings, isolated readers, diagnostics,
  WebSocket admission, interaction effects, permissions, clipboard, file
  transfer, cleanup and visibility replacement into cohesive owners (#236,
  audit #46). The browser manager retains authoritative session/security state
  and live callbacks; public APIs, output, approvals, egress policy, retention,
  host-write semantics, generation fences and fail-closed behavior are unchanged.

## [0.1.0-dev.98]

### Changed

- Decompose the checkpoint engine into cohesive record, Git execution, audit,
  capture, pin, durability and operation owners behind its unchanged public
  facade (#233, audit #46). Record bytes and digests, error identities, frozen
  comparisons, selective advancement, pin ownership and release proofs,
  hardened Git execution, durability, platform handling and fail-closed
  recovery behavior remain unchanged.

## [0.1.0-dev.97]

### Changed

- Decompose the in-place worker into cohesive lifecycle, baseline, evidence,
  prompt, review-record and settlement owners behind its unchanged public
  facade (#252, audit #46). The coordinator retains branch-specific settlement
  and review catch/finally ordering; immediate writes, original-root/baseline
  continuity, retry/failover, serialized records, review policy and recovery
  behavior remain unchanged.

## [0.1.0-dev.96]

### Fixed

- Observe Codex executor child closure before awaiting durable PID persistence
  so an early failing exit cannot strand finalization (#234, audit #46).
  Initialization and prompt transport remain behind PID persistence; existing
  failure classification, shutdown policy and transport limits are unchanged.
  A causally gated real-child regression records the actual exit exactly once.

## [0.1.0-dev.95]

### Fixed

- Detach the WebSocket test client's completed HTTP-handshake listener so
  legal split header/frame delivery cannot fabricate a duplicate initial frame
  (#256, audit #46). Deterministic split/coalesced delivery regressions preserve
  the existing broker assertions and deadlines; production broker behavior and
  network policy remain unchanged.

## [0.1.0-dev.94]

### Changed

- Split the settings command into cohesive section owners while retaining
  `registerReviewSettings` as its compatibility facade (#251, audit #46).
  The staged draft, ordered Save transaction, validation, persistence and
  rollback behavior, native editors, resource enrollment, and Cancel behavior
  are unchanged. Scheduler runtime controls retain their immediate effect.

## [0.1.0-dev.93]

### Fixed

- Observe Pi executor child exit before awaiting durable PID persistence, so
  a fast-exiting child settles as a failure instead of missing its exit and
  hanging (#231). Prompt delivery still waits for PID persistence; shutdown
  bounds and fail-closed settlement remain unchanged. Deterministic regression
  coverage exercises actual child exit while the PID callback is pending.

## [0.1.0-dev.92]

### Changed

- Update the pinned `ddgs` web-search dependency from `9.15.0` to `9.16.0`
  (issue #206). Both launch paths — the Unix `scripts/ensure-ddgs.sh` and the
  native Windows launcher — now provision, validate, and export the same exact
  version in the versioned managed venv (`ddgs-9.16.0`). The isolated-mode
  Python invocation, exact-version validation, `pip check`, binary-only
  installation, fail-closed provisioning, and the search helper's query and
  result contract are unchanged; no code or configuration changes beyond the
  synchronized version pin, documentation, and test expectations were required.

## [0.1.0-dev.91]

### Added

- In-place subtask kind (#220): a third, explicitly selected worker kind alongside
  `execute` and `research` that runs a write-capable executor directly in a
  launch-selected workspace — any existing directory, including an empty one or one
  outside any Git repository — with no wave capture, candidate commit, or landing:
  writes and external side effects happen where performed and are never gated, rolled
  back, or landed. Selectable from `SubtasksStart`/`SubtasksAdd`, `/subtask-add`, and
  scheduled entries (with their worker pin and review override); in-place workers cannot
  launch subtasks, draw from the write-capable executor pool (the `execute` priority
  route), review with the ordinary subtask review configuration, and cannot be
  force-merged or interrupt-with-merge (their own reviewer reports on the recorded
  workspace delta since launch, disclosing concurrent-writer uncertainty instead of
  crediting unattributable changes to the worker or pretending writes were undone).
  Tool-observed outside-root writes reach review even with no in-root delta, with
  unverified prior states and bounded after-content rather than fabricated diffs.
  The selected root and original launch baseline survive continuation and ordinary
  executor failover; prior direct effects are disclosed to the replacement worker.
  Settled in-place tasks end `reported` with the review outcome and workspace delta;
  review-disabled runs settle completed-unreviewed in place. Concise completion notices
  name workspace changes separately from additional observed paths outside the
  workspace; shared human and scheduled launch notices report admission facts with a
  brief acknowledgement cue. Discard-output writes to `/dev/null` are excluded from
  evidence candidates, while destructive operations on that path remain evidenced.
  Existing execute/research workspace isolation, configured routes, and defaults are
  unchanged.

### Changed

- Bound Linux full-suite CI with a five-minute per-test timeout, ten-minute
  test-step limit, and fifteen-minute job limit. Add immediate file start and
  completion diagnostics alongside the usual test output, identifying files
  without observed completion if a run stalls. Test selection, concurrency,
  prerequisites, release gates, and local commands are unchanged; the original
  hang's cause remains unconfirmed.

## [0.1.0-dev.90]

### Added

- Scheduled task entries gain a per-entry **schedule destination** (issue #222).
  The existing `subtask` destination remains the default and every pre-existing
  entry stays subtask-dispatched without migration: kind, workspace, worker
  resource, task-local review, the one-unsettled-run-per-entry overlap rule,
  and quiet/noisy completion behavior are unchanged. After a successful
  scheduled-subtask dispatch, the top-level model now also receives a launch
  notice with the schedule identity and execution/task handles through the
  shared non-model-initiated subtask-launch mechanism used by human
  `/subtask-add` (partial #215 integration): the same follow-up delivery lane,
  redaction and bounds, origin metadata, and causal ordering, so a
  fast-settling subtask's notifications wait for the bounded launch-notice
  attempt. A definite rejection is reported as a failure; an unacknowledged
  send is reported as uncertain and may still arrive, so later model delivery
  cannot be guaranteed in that case. The notice never dispatches a duplicate
  or implies completion.
- Add the optional `orchestrator-turn` destination: the due entry's
  instructions and occurrence identity are delivered as a new turn to the
  existing primary agent — no second Pi, no workspace override, current
  tools/model/review — the occurrence completes when its initiating turn ends
  (optional subtasks started during the turn keep their own lifecycle and
  never hold the occurrence open), later due occurrences are independent, and
  a host without required run-lifecycle hooks refuses delivery rather than
  starting an unreviewed turn, while a send
  accepted but never acknowledged within its bounded window is reported as
  uncertain (the turn may still arrive; never counted as executed). A
  delivery that definitively cannot be performed fails closed with an
  actionable scheduler wake.
- `/review-settings` scheduled-entry editing gains a **Destination** row;
  worker and review rows display as unused while an entry targets
  orchestrator turns and their stored values are validated again when the
  entry is switched back to the subtask destination.

## [0.1.0-dev.89]

### Fixed

- Execute subtasks started from a nested Git working directory now verify the parent review checkpoint at the enclosing repository root instead of failing before worker capture. Selective parent checkpoint advancement uses that same root while preserving repository-relative landing paths, sibling parent edits, and delegated capture and landing scope across all executor routes.

## [0.1.0-dev.88]

### Changed

- Interactive TUI sessions now prewarm the running Pi agent peer immediately on session start (a fire-and-forget native import with no timer and no visible UI), so the first `/review-settings` menu and native textbox consume an already-cached module instead of pausing on a cold load. Non-interactive modes are unaffected, early opens safely coalesce with an in-flight prewarm into one evaluation, and a failed prewarm preserves the existing on-demand, fail-closed behavior.

## [0.1.0-dev.87]

### Fixed

- When Pi runs below the top level of a Git repository, parent review now pins the
  enclosing repository instead of failing at the checkpoint root guard. Frozen
  tracked and eligible untracked sibling changes and review evidence use
  repository-relative paths across restart. Pi and reviewer process directories,
  delegated task capture and landing, and non-Git review remain unchanged.

## [0.1.0-dev.86]

### Fixed

- Allow Git parent baselines on Windows when directory fsync reports `EPERM`,
  and avoid false untracked and tracked-file races when path stat omits the
  volume ID that open-handle stat reports. Preserve file flushes and actual
  race checks.
- Preserve Windows Git's effective `core.autocrlf` normalization without
  exposing other ambient Git settings; suppress worktree-only mode noise
  while retaining staged mode changes. Reload large valid checkpoint records
  without overflowing Base64 validation.
- Avoid worktree-only mode noise in private Windows subtask capture while
  retaining source-index staged executable modes and current worktree bytes;
  use an opened directory's volume ID to bind capture, landing and recovery
  when path stat omits it. Stage landing temp files beside their destination
  across Windows volumes and validate those paths during recovery. Keep the
  POSIX capture behavior unchanged.
- Contain synchronous reviewer and delegated executor process-kill errors,
  including Windows `EINVAL`, without treating a still-live child as exited;
  retain termination diagnostics and bounded kill escalation.
- Launch Pi child processes (reviewer prompts, the delegated Pi RPC executor,
  and compaction recovery) alias-independently through one shared resolver:
  on Windows the default `pi` resolves to an installed pi.exe or npm's
  pi.cmd shim JavaScript entry executed by this Node binary without a shell,
  because a shell-less spawn of the bare name cannot find the cmd shim; POSIX
  keeps direct execution and configured custom commands keep their exact
  spawn semantics. A missing or unresolvable default Pi CLI fails closed with
  an actionable error instead of a raw spawn failure.

## [0.1.0-dev.85]

### Changed

- Replace the ordinary parent-review snapshot baseline with one durable checkpoint
  workflow for Git and non-Git workspaces. Git pins committed clean content and
  records staged and unstaged differences plus exact non-ignored untracked entries
  without copying clean tracked files; tracked text follows Git-normalized newline
  semantics. Non-Git workspaces retain eligible raw entries. Window and exchange
  reviews compare separately against one frozen after-checkpoint.
- Preserve parent edits across reviewed subtask landings while leaving private
  subtask capture, candidate review, and landing unchanged. Retire superseded
  parent checkpoint owners only after the replacement state is durably saved.
- Start a fresh review baseline for active pre-checkpoint windows on restart,
  without migrating an old verdict. If a current checkpoint is damaged beyond
  verified recovery, preserve its evidence, notify the user, and start a fresh
  checkpoint with already-present edits as baseline; no prior edit is passed.

## [0.1.0-dev.84]

### Added

- Add a native Pi assistant tool-call preflight that blocks later identical members in
  a batch and adjacent repeated calls before execution, with one retry only after an
  observed operation error. `ShellStart` and `SubtasksStart` also fail closed against an
  identical active job/group across intervening groups; unknown liveness blocks the new
  start rather than risking a duplicate spawn, and blocked starts do not cancel prior
  work. Distinct calls and multi-task starts remain allowed, and external API wrappers
  are not intercepted.

- For that `SubtasksStart` liveness check, an older or restored active group without a
  recorded start-call fingerprint (missing or malformed) is unidentifiable rather than
  unknown: it cannot match the submitted fingerprint and does not by itself block an
  otherwise admissible new start. The accepted duplicate risk is disclosed: because the
  legacy group's original submitted identity is unavailable, an identical new start can
  duplicate its still-active work — the new start is not proven distinct or safe. Known
  identical active groups still block across intervening groups even with a legacy group
  present, and known different active groups remain nonblocking. Unknown liveness still
  fails closed when the lookup itself is unavailable or throws, and `ShellStart` keeps
  liveness unknown while any running job lacks a recorded start identity; no cancellation
  of existing work, no new configuration option.

## [0.1.0-dev.83]

### Changed

- Remove workspace-specific recursive-search guidance from the shipped execution
  skill; local agent policies remain outside the packaged skill.

## [0.1.0-dev.82]

### Added

- Add a `/scheduled-tasks` landing shortcut for the scheduled-task settings:
  in an interactive session it opens the existing **Scheduled tasks** submenu
  of `/review-settings` immediately, and Esc or **Back** from there lands at
  the settings root with the **Scheduled tasks** row highlighted (the root's
  retained-selection state, rendered by the interactive Pi TUI), where
  **Save changes** persists staged edits through the same validation and
  persistence and **Cancel** discards them. The shortcut
  stages into the one canonical staged catalog through its existing
  readers/writers — no duplicate scheduler UI or state, no implicit save,
  and no change to scheduler runtime enablement, dispatch, or the ordinary
  `/review-settings` entry behavior (which still opens at the settings root).

## [0.1.0-dev.81]

### Added

- Persist images pasted through the native editor into scheduled-task
  instructions durably at Save: Pi's image paste inserts a path to a temporary
  clipboard file, so Save validates the referenced file by content (PNG,
  JPEG, GIF, or WebP, at most 10 MiB — re-bounded during the read so a source
  that grows after the size check cannot allocate unbounded memory), copies
  it into a private managed store next to the config file (0700 directories,
  0600 files, fsynced; each pasted image gets its own copy, kept per task id
  across Saves; a store root or per-task directory that is a symbolic link
  fails Save closed and its target is never chmod'ed or written through), and
  replaces the temporary path in the instructions with the
  managed absolute path before the ordinary atomic config write — a later
  scheduled run reads the managed copy even after Pi deletes its temp file.
  Only Pi's own paste output is treated as an image: candidates are bounded
  to `pi-clipboard-<UUID>.<png|jpg|jpeg|gif|webp>` in the OS temp directory
  (with content validated after path recognition), so ordinary clipboard
  text — any other absolute path, real or missing, a sentence, or `@`
  attachment text — stays verbatim as text and Save proceeds with native
  text-paste behavior unchanged. Provenance comes only from the bridge's
  observation-only paste seam, each
  observed token is verified against the final staged instructions, an
  unobserved `pi-clipboard-...` reference (any extension or name spelling)
  fails Save with an actionable message instead of being copied or persisted,
  and missing, non-image, too large, or failed copies fail the Save closed
  with the config and store untouched (Cancel copies nothing; a persistence
  failure that already landed keeps the copies the parsed saved config
  references). Managed assets are never auto-deleted
  (active or other-process scheduled runs may still read them); cleanup is
  manual, and a missing asset fails its dispatch with an actionable wake
  instead of silently starting a run against a dead path (the dispatch scan
  checks the platform separator and the Windows backslash spelling).

- Add opt-in process-local scheduled subtasks. Define independently enabled
  local-time cron entries in `/review-settings`, with per-entry instructions,
  workspaces, worker routes, and task-local review choices. A Pi process starts
  scheduling only with `--scheduler`, or after its own live settings toggle;
  definitions stay editable while scheduling is off. Future due occurrences
  dispatch through existing subtasks, with owner notifications and actionable
  overlap skips rather than catch-up or cross-process deduplication.

### Changed

- Complete leading-`/` tokens in every extension-owned interactive text field
  using Pi's own file provider, not slash-command suggestions; no command
  executes. The screenshot-reported AskUserQuestion answer case (`/se` showing
  the slash-command menu) and every typeable `/review-settings` field — not
  only the scheduled-task Workspace directory — now share the same
  host-wired provider decoration through the native editor bridge, with no
  per-field opt-in switch: `/`, `/se`, `/var`, and nested absolute paths list
  filesystem entries (or nothing for a missing path), never slash commands.
  The same shared routing covers the staged subtask form (title,
  instructions, acceptance criteria, relevant context, target workspace), the
  no-argument steering instruction, and the private reviewer answer editor;
  the main Pi chat prompt itself keeps its ordinary slash-command context.
  The decorator preserves native relative and `~/` completion, Ctrl+C clear,
  Ctrl+G, multiline, paste, Esc list-first, and Enter field-only settle
  semantics. Native absolute-path lists show the first item highlighted; the
  first Tab may only show the list, with a further Tab applying its
  selection. Save still rejects missing or non-directory workspaces.

- Accept a leading `~` or `~/...` as a scheduled-task workspace and as the
  `SubtasksStart` workspace: settings Save and run-time dispatch both expand it
  against the user's home through the shared Pi-native path rule, and Save
  persists the expanded absolute spelling (runtime target realpath is separate).
  Nonexistent or non-directory targets fail closed; unsupported tilde spellings
  (such as `~user`) are never reinterpreted and fail closed unless a literal
  path of that name exists; relative workspaces keep resolving against the
  parent session's working directory.

### Fixed

- Fail closed when an interactive host cannot assign and verify takeover of
  the field editor's `onSubmit`: refuse field acquisition and restore the prior
  editor factory instead of risking a chat send on Enter. This applies to
  settings and AskUserQuestion alike.

- Make every `/review-settings` text field truly editable through one shared
  host-wired native editor bridge: in the interactive Pi TUI each field —
  including the scheduled-task workspace — temporarily acquires the host's own
  main-prompt editor through the public `setEditorComponent` seam and embeds
  that same instance in the settings surface, so the current value arrives as
  an editable prefill and the host's native controls apply unmodified: Tab path
  completion for relative or `~/...` paths (`docs/` + first Tab lists the
  folders *and* files under it; a single match is applied directly, exactly as
  in the chat editor), the fd-backed `@` file picker, Ctrl+C clear, Ctrl+G
  external editing for long values such as scheduled-task instructions, image
  paste, and Shift+Enter newlines. Enter submits the field's own text — never a
  chat message — and Esc first dismisses a visible completion list, then
  cancels, leaving the staged value unchanged; the editor remains the single
  draft, with the chat draft restored on every open/close. The workspace-only
  bespoke editor/provider/matcher surface is removed: there is no duplicate
  completion algorithm or editor state. Token recognition, relative/`~`/
  absolute handling, platform behavior, the list UI, and selection keys are
  inherited from the host as-is, except for the shared leading-`/`
  file suggestion routing above; no universal absolute-path or Windows support
  is claimed. An interactive host missing the required native seams
  fails closed with an error notice instead of presenting a non-parity
  fallback field; non-interactive hosts keep their clearly identified chain —
  Pi's public editor with an editable prefill first, then the legacy single-line
  input with its old title/placeholder semantics — and a host offering neither
  seam fails closed with an error notice instead of silently staging nothing.
  Completion is a convenience — Save checks relative workspaces against the
  session working directory, matching completion and dispatch, and still
  rejects nonexistent or non-directory targets, including a file selected from
  the list. The cron field keeps its compact heading above the editable
  prefilled text mapping all five fields in order (minute, hour, day-of-month,
  month, day-of-week), stating machine-local time and `* * * * * = every
  minute`. No scheduler policy change: grammar, dispatch, no-catch-up, overlap
  handling, choices and toggles are unchanged.

## [0.1.0-dev.80]

### Fixed

- Show `Closes #N` and `Refs #N` as plain text in the pull request template's
  fill-in lines so a completed PR body can close a fully resolved issue on
  merge or link a related issue without closing it. This source-only guidance
  change does not alter runtime behavior or review policy.

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
  cleanup. Sample-client-alpha tool navigation/screenshots show the graphical homepage; CNN captures
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
