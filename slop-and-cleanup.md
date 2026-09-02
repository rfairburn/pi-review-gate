# Slop and cleanup review inventory

Date: 2026-09-02
Status: Final consolidated inventory replacing the 2026-08-27 draft. Findings 0, 1, and 2 are
RESOLVED work-history entries (fixes landed 2026-09-02); remaining findings are
recommendations only with no product code changes.

Scope: `pi-review-gate` (extension + execution subsystem + web tools + scripts). Severity
legend: HIGH = security boundary bypass or host crash; MEDIUM = correctness/data-loss or
DoS reachable from model/operator input; MEDIUM-LOW/LOW = durability, hardening, or
maintainability debt.

Changes vs. the 2026-08-27 draft: completed typed-continuation-event work removed (typed
phases are live in `src/execution/types.ts` and reduced by the controller); the stale
"5,000-entry history" claim is corrected to the current caps (200 activity / 64 state);
controller-decomposition and notification-contract items updated to current line counts.

## Prioritized findings

### 0. P0 — RESOLVED (2026-09-02): Escape cancellation on live Pi + /review-cancel fallback

**Root cause (confirmed).** Installed Pi 0.84.4 enables the Kitty keyboard
protocol on capable terminals, so its TUI input listeners receive raw CSI-u
sequences — unmodified Escape arrives as `\x1b[27u` (with optional
modifier/event sub-parameters), not bare ESC — while `isEscapeTerminalInput`
(`src/pi.ts`) only recognized bare `"\x1b"` and legacy parsed-object shapes. On
Kitty-capable terminals every real Escape press therefore fell through the
terminal-input handler (`src/index.ts`, `createReviewAbortController`) and
Escape could never cancel a live review. Secondary gaps: the listener was
installed only after `drainEvidenceCaptures()`/`persistSessionState()` awaits
inside the automatic-review handler, `cleanup()` had no exception isolation,
and an uninstalled subscription (`onTerminalInput` returning undefined) failed
open silently.

**Fix.**
- `src/pi.ts` (`isEscapeTerminalInput`): recognizes raw Kitty CSI-u Escape
  (`\x1b[27u`, `\x1b[27;1u`, `\x1b[27;1:1u` press, `\x1b[27;1:2u` repeat,
  optional alternate-key sub-parameters) and xterm `modifyOtherKeys` Escape
  (`\x1b[27;1;27~`), while rejecting key-release (`:3` event type) and user
  modifiers such as shift/alt/ctrl/super (lock-state bits are ignored, matching
  pi-tui). Legacy string/object shapes retained; no
  runtime dependency on pi-tui (raw-sequence parsing only, mirroring
  pi-tui's documented CSI-u grammar).
- `src/index.ts`: the automatic-review abort controller (including the
  terminal-input listener and its session-wide registration) is now created
  immediately after `state.reviewInProgress = true`, before the evidence-drain
  and state-persist awaits, closing the startup registration gap; early-exit
  and `finally` paths both clean it up. `cleanup()` is exception-safe
  (per-listener try/catch, idempotent).
- New `src/review-cancellation.ts`: a session-wide cancellation coordinator.
  Every active review (automatic, `/review-now`, reviewer-question commands)
  registers a handle exposing `requestCancel`/`settled`/`describe`/
  `notifyCancellation`. It also owns the one-time fallback diagnostic emitted
  when terminal interception is unavailable, pointing users at
  `/review-cancel`.
- `src/commands.ts`: new documented `/review-cancel` command — aborts whichever
  review is currently registered, immediately acknowledges the cancellation
  request (`cancelling … waiting for reviewer processes to stop`), awaits the
  owning run's `settled` promise (resolved only after `runReview` returned and
  the terminal listener was removed), then emits the idempotent completion
  notice (`review gate: review cancelled; reviewer processes stopped`). With no
  active review it reports `no active review to cancel`. Command-driven aborts
  get the same completion-notice discipline; completion notices are cached so
  Escape and `/review-cancel` can never double-report. `/review-now` and
  reviewer-question commands surface the same one-time fallback diagnostic when
  interception is unavailable.
- `src/review.ts`: `/review-cancel` aborts (reason `manual`) now produce the
  user-canceled `CANCELED.md`/`canceled.json` tombstone, same as Escape.

**Tests.** `tests/pi.test.ts` covers the real raw sequences (Kitty CSI-u
press/repeat/alternate-key forms, xterm modifyOtherKeys; release and modified
Escape rejected; non-Escape CSI-u rejected). `tests/index.test.ts` adds an
automatic-review case where Kitty CSI-u Escape (`\x1b[27u`) cancels the active
reviewer child, establishing reviewer-process quiescence (reviewer child PID
no longer alive) plus the `CANCELED.md` aborted-process artifact, and asserts
release (`\x1b[27;1:3u`) and modified (`\x1b[27;5u`) sequences do not cancel.
Another index test cancels an active automatic review via `/review-cancel` and
verifies the tombstone, process quiescence, and the `no active review to
cancel` reply afterwards. `tests/commands.test.ts` adds a case for
`/review-cancel` against an active `/review-now` (request feedback, completion
notice only after the run returned, child quiescence) and the no-active review
reply, and exercises exception-safe listener cleanup via a throwing
unsubscribe; `tests/pi.test.ts` covers dispose/unsubscribe subscription
unwrapping and a throwing registration target.

**Validation.** `npm run check:static` (tsc no-emit + shellcheck); targeted
dist-test runs of `pi`, `index`, and `commands` test files via
`npm run build:test`; no `dist/` output touched.

**Impact.** Live Escape cancellation now matches the documented contract on
Kitty-capable terminals, and `/review-cancel` provides a terminal-independent
hard stop whose completion notice is emitted only after reviewer processes are
gone.

### 1. HIGH — RESOLVED (2026-09-02): SSRF bypass via IPv4-mapped/compatible/NAT64/6to4 literals — canonical, fail-closed IP validation

**Root cause (confirmed).** `isBlockedAddress` (`src/web/network.ts`) matched
addresses with ad-hoc string prefixes and a regex that only recognized
dotted-decimal `::ffff:a.b.c.d` mapped literals. The WHATWG URL parser
serializes IPv6 literals in hex (`http://[::ffff:127.0.0.1]/` → hostname
`[::ffff:7f00:1]`), so mapped (`::ffff:7f00:1`, `::ffff:a9fe:a9fe` cloud
metadata, `::ffff:0a00:0001`, `::ffff:c0a8:0101`, `::ffff:ac1f:0001`),
IPv4-compatible (`::7f00:1`), NAT64 (`64:ff9b::7f00:1`), and 6to4
(`2002:7f00:1::`) literal forms all passed validation end to end; loopback
reachability of the mapped form was reproduced in this review. IPv4
documentation/benchmark/protocol ranges (192.0.0.0/24, 192.0.2.0/24,
198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24) and deprecated site-local
`fec0::/10` were also missing (former item L5).

**Fix.** New `src/web/ip.ts`: strict canonical IPv4 (dotted-decimal only, no
hex/octal/leading-zero forms) and IPv6 parsing (WHATWG URL-standard algorithm:
`::` compression, embedded dotted IPv4 tails, zone indexes stripped) into raw
bytes, plus explicit special-purpose range checks. `isBlockedAddress` now
fails closed — unparseable input is blocked — and extracts the embedded 32-bit
IPv4 from mapped (`::ffff:0:0/96`), compatible (`::/96`), NAT64
(`64:ff9b::/96`), and 6to4 (`2002::/16`) forms, running it through the IPv4
blocklist so hex and dotted spellings behave identically. Blocked outright:
IPv4 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24,
192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24,
224/4, 240/4; IPv6 `::`, `::1`, NAT64 local-use
`64:ff9b:1::/48` (RFC 8215), Teredo `2001::/32`, discard `100::/64`, doc
`2001:db8::/32`, unique-local `fc00::/7`, link-local `fe80::/10`, deprecated
site-local `fec0::/10`, multicast `ff00::/8`. `src/web/network.ts`
(`validatedPublicUrl`, used by WebFetch, BrowserExtract, redirect
re-validation, and the CLI) now delegates to the new module; no new dependency.
DNS TOCTOU (finding 6) is intentionally out of scope.

**Tests.** New `tests/web-network.test.ts`: table tests rejecting all mapped
(hex, dotted, zero-padded, uppercase), compatible, NAT64, 6to4, and L5 ranges
plus boundary positives (public literals, `2606:4700:4700::1111`, public IPv4
embedded in mapped/NAT64/6to4 wrappers, adjacent-octet boundaries such as
`172.32.0.1`, `100.128.0.1`, `198.20.0.1`, `203.0.114.1`); fail-closed cases
(malformed IPv4/IPv6); `validatedPublicUrl` literal tests proving
WHATWG-normalized dotted mapped input (`[::ffff:127.0.0.1]`) is rejected; and
an end-to-end integration test binding a server to 127.0.0.1 — a direct raw
`fetch` control reaches it, then `downloadText` over
`[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[::7f00:1]`, `[64:ff9b::7f00:1]`, and
`[2002:7f00:1::]` rejects with `non-public address` and the server's
connection count stays unchanged (zero new connections).

**Validation.** `npm run check:static`; `npm run build:test` + targeted
`node --test dist-test/tests/web-network.test.js` (5/5 pass) and
`dist-test/tests/web-tools.test.js` (23/23 pass); no `dist/` output touched.

**Impact.** The sole SSRF control for all web fetch/browser paths now
canonicalizes before checking and cannot be bypassed by any spelling of an
embedded-IPv4 or special-range address.

### 2. MEDIUM-HIGH — RESOLVED (2026-09-02): Post-landing bookkeeping failure flips a landed task to `failed`

**Root cause (confirmed).** In `runFresh`/`runContinuation`, `checkpointParent` was awaited
before the `landed` transition, and the launch `.catch` moved any rejecting body to `failed`;
`forceMerge` had the same shape (checkpoint → transition → save/publish/wake inside a catch
that moved non-conflicted tasks to `paused_recoverable`). A post-landing checkpoint/save/
publish/wake failure therefore either prevented the `landed` transition or regressed it, so
main was changed while the durable record claimed failure.

**Fix.**
- `src/execution/background-controller.ts`: new invariant — once the source workspace
  mutation succeeded (`landing.status === "landed"`), no later bookkeeping failure may
  change the outcome. `runFresh`, `runContinuation`, and `forceMerge` now run
  `checkpointParent` as tolerated bookkeeping *before* the (unchanged) success-path
  `landed` transition — closing both windows: a checkpoint failure no longer prevents the
  transition, and a post-transition save/publish/wake failure can never regress it. The
  new `completeLandedBookkeeping` helper catches each step's failure, records a
  `bookkeeping` activity entry plus a `notify` diagnostic ("landing preserved"), and
  retries the durable save when an earlier post-landing save failed, and force-merge always
  performs a tolerated final durable save so post-save diagnostics persist. The launch
  rejection handler is state-aware and terminal-state preservation takes precedence over a
  concurrently pending `interruptionMode` (which `interrupt()` leaves set until the launch
  promise settles): `landed`/`reported`/`conflicted` are never regressed to `interrupted` or
  `failed`; preserved successful states wake as `completion` while `conflicted` remains an
  actionable `failure` wake, recording the bookkeeping failure in activity/summary instead,
  and the handler's own save/wake are exception-safe.
  Pre-landing failures keep their existing failure/recovery paths untouched.
- New deterministic fault seams: `BackgroundFaultHooks` (`checkpointParent`, `save`,
  `publishAssociations`, `wake`) accepted via controller input or `setFaultHooks`, each
  invoked immediately before its step with task/state context.

**Tests.** `tests/background-controller.test.ts` adds seven deterministic fault tests: each
post-mutation step (parent checkpoint, durable save, association publish, completion wake)
failing after successful landing asserts main contains the landed change, the task stays
`landed` with no `failed` history entry, a `bookkeeping` activity entry records the failure,
and the task archive on disk agrees (`landed` + activity); the durable-save case also proves
the landed state reaches `execution.json` on the retry. Force-merge variants cover a failing
post-landing save and failing publish+wake (both recorded in the archived activity with the
landed state durable). A regression test proves the launch rejection handler keeps a
`landed` task at `landed` (never `interrupted`/`failed`) even when `interruptionMode` is
simultaneously pending and a post-terminal rejection arrives.

**Validation.** `npm run check:static`; `npm run build:test` + targeted
`node --test --test-concurrency=1 dist-test/tests/background-controller.test.js` (17/17)
and the rest of the execution suite (`background-process-readiness`, `execution-tool-batch`,
`executor-pool`, `operation-actions`, `session-state`, `source-mutation-lease`; 42/42);
no `dist/` output touched.

**Impact.** A successful source landing can no longer be reclassified as failed by any
checkpoint/save/publish/wake error; bookkeeping failures are visible as activity and
notifications while the durable and in-memory task states stay consistent with main.

### 3. HIGH — ShellSend can crash the pi host via unhandled async stdin EPIPE

Refs: `src/background-shell/index.ts` `ShellSend.execute` (`:681-687`, try/catch around
`job.proc.stdin?.write(payload)`); `attachStreams` (`:368+`) attaches `job.proc.on("error")`
(`:405`) but no listener on `job.proc.stdin`. Compare the reviewer path, which already fixed
this class in `src/adapters/process.ts:285-290` (stdin error listener with explanatory
comment).

Impact: a write to a pipe whose read end closed (job exits between the `job.exited` check and
the write, or while an earlier write is still flushing) emits EPIPE/`ERR_STREAM_DESTROYED`
**asynchronously** as an `'error'` event on the stdin stream. try/catch cannot catch it; with
no listener Node raises an uncaught exception that kills the whole pi host and every
job/session in it.

Recommendation:
- [ ] Attach a `job.proc.stdin.on("error", …)` handler at job creation (bounded note in
      `job.buffer`, mark stream dead) and/or use the write callback plus a
      `stdin.destroyed` check before writing.
- [ ] Test: `ShellSend` against a child that exits mid-write must not crash the host.

Test status: none — `tests/background-shell-integration.test.ts:208` writes to a *live* job
only; no test exercises an exiting child.

### 4. MEDIUM — Background shell: unbounded line length and per-line regex compilation

Refs: `src/background-shell/jobs.ts` `LineBuffer.push` (`:118-124`; caps line **count** at
`MAX_BUFFER_LINES = 5000`, `:46`, not line length); `compileMatcher` (`:98`) invoked per
pattern per line by `findMatch` (`:179-184`; `evaluateMatch` does not compile — it only tests
the fixed `ERROR_ISH` regex); `src/background-shell/index.ts` `onChunk` accumulates an
arbitrarily long partial line in `job.pending` **before** any `LineBuffer.push` call;
`formatWakePayload` embeds raw lines un-truncated.

Impact: a job emitting multi-MB output without newlines (base64 dump, progress bar) grows
`job.pending` and host memory without bound — capping `LineBuffer.push` alone does not fix
this because the bytes accumulate in `job.pending` first. Wake payloads and `ShellLog` tails
can inject hundreds of MB into model context. Model-supplied wake regexes run synchronously
in the host loop with a fresh `RegExp` compilation per pattern per line — a
catastrophic-backtracking pattern (`(a+)+$`) can freeze the event loop for minutes on a
single candidate line, and caching compiled matchers only removes the compilation cost, not
the backtracking cost.

Recommendation:
- [ ] Add a byte-bounded streaming accumulator for `job.pending` (flush/truncate with a
      marker once a partial line exceeds N bytes) in addition to capping stored lines in
      `LineBuffer.push` and wake/log payload line sizes.
- [ ] Use a genuinely bounded matching strategy for model-supplied patterns: safe-pattern
      validation, a linear-time engine, or isolated execution with an enforceable timeout —
      not merely per-job matcher caching.
- [ ] Tests: long-line truncation, bounded wake payload, backtracking-pattern guard.

Test status: partial — `tests/background-shell-jobs.test.ts` covers LineBuffer slicing/drop,
matcher basics, and `formatWakePayload` shape, but not byte bounds or per-line regex cost;
no adversarial test.

### 5. MEDIUM — Web table parser DoS via unbounded colspan/rowspan

Refs: `src/web/page.ts` `positiveSpan` (`:416-419`, accepts any positive integer),
`expandTableRows` (`:384-414`, per-cell `for (offset < colspan)` fill), `tableData`
(`:350-377`; `columns = Math.max(...row lengths)`, then `Array.from({ length: columns })` at
`:363` and `:374`).

Impact: a few-byte page with `<td colspan="999999999">` yields `columns ≈ 1e9`; the dense
`Array.from` allocations OOM the research worker. Download is bounded (50 MiB) but parsing is
not.

Recommendation:
- [ ] Cap colspan/rowspan in `positiveSpan` (e.g., ≤ 1000) and cap total expanded cells per
      table.
- [ ] Add an adversarial-table test asserting bounded parse cost/memory.

Test status: none — no adversarial table tests in `tests/web-tools.test.ts`.

### 6. MEDIUM (defense-in-depth) — DNS validation/connect TOCTOU

Refs: `src/web/network.ts:304-323` (`validatedPublicUrl` resolves and checks the hostname),
then `downloadText` (`:59`) re-resolves via `fetch`; redirects are re-validated per hop
(`:79`, good); BrowserExtract caches an origin after one validation
(`src/web/browser.ts:111-115`) and never re-checks it during the render.

Impact: an attacker-controlled hostname can answer public at validation time and internal at
connect time (DNS rebinding); in the browser a rebinding hostname stays approved for the whole
render, enabling internal scanning/exfiltration from inside the browser context.

Recommendation:
- [ ] Pin the validated address to the actual connection (for Node, use a custom
      dispatcher/lookup while preserving the original hostname for HTTP Host and TLS
      SNI/certificate validation), and repeat validation/pinning for every redirect.
- [ ] For Chromium, remove origin-only approval caching and enforce equivalent per-request
      connection pinning, such as routing requests through a pinned validating proxy. A
      second DNS lookup alone does not close the TOCTOU window; if pinning is deferred,
      document the residual risk explicitly.
- [ ] Test status: none. A deterministic test is hard (requires controlling DNS); document as
      accepted residual risk if pinning is deferred.

### 7. MEDIUM-LOW — Inconsistent fsync discipline across durable record writers

Refs: fully durable: `src/execution/background-controller.ts:2496-2520` (`atomicWrite`: file
fsync + best-effort dir fsync) and `src/execution/wave-landing.ts:852-870`
(`atomicWriteJson`: datasync + dir fsync). Not durable (temp write + rename, no fsync):
`src/execution/operation-record.ts:368-382` (`writeOperationRecord` — the durable recovery
record gating `continueOperation` and crash reconciliation),
`src/execution/wave-controller.ts:399-417` (`writeWaveManifest` — drives
`pruneCompletedWaveRoots` and legacy-terminal detection), `src/execution/wave-owner.ts:100-105`
(`writeWaveOwner` heartbeat updates; the initial acquisition at `:44` does sync), and
`src/execution/wave-worker.ts:191-201` (`persistTaskDefinition`).

Impact: power loss/hard crash right after rename can leave `operation.json` or
`wave-manifest.json` zero-length or stale on filesystems that don't guarantee rename
durability without fsync — degrading `paused_recoverable` recovery into "record unreadable"
exactly when it matters.

Recommendation:
- [ ] Route the four listed non-durable writers through one shared `atomicWrite` helper
      (promote the controller's to a util) so fsync policy is single-sourced.
- [ ] Test status: none — no crash-durability tests exist anywhere in the execution suites.

### 8. MEDIUM-LOW — Interrupt never fails queued `continue` commands

Refs: `src/execution/background-controller.ts:697-703` (pre-dispatch interrupt rewrites only
`steer` commands); `restore()` auto-queues a durable continuation for
`stopped_for_application_exit` tasks with `status: "queued"` and sets
`task.pendingContinuation` (`:375-392`); `failUndeliveredSteering` likewise handles only
`steer`.

Impact: if the user interrupts before the auto-queued continuation dispatches, the task is
`interrupted` but the `continue` command stays `queued` forever and `pendingContinuation`
stays populated (later silently overwritten by any `continueTask`). Diagnostics/tooling that
surface "queued commands" report pending work that can never be delivered.

Recommendation:
- [ ] In the pre-dispatch interrupt path (and the launch catch), fail or cancel `continue`
      commands and clear `pendingContinuation`.
- [ ] Test status: none — interrupt tests assert task state and steering failure only.

### 9. MEDIUM — Workspace snapshot fails the whole turn on concurrent FS changes (review pipeline)

Refs: `src/capture.ts` `inspectFile` (`:343-389`, rejects on stream error — a file deleted
between `lstat` and `createReadStream`); `discoverFilesystemFiles` walk (`:288-310`, no
per-entry error tolerance; unreadable dir throws from `readdir` in the non-git fallback);
bubbles through `before_agent_start` at `src/index.ts:377-380`.

Impact: a background `ShellStart` job (or any concurrent process) deleting/rotating a file
mid-snapshot rejects `createWorkspaceSnapshot`, which can fail the agent turn and the review
gate for reasons unrelated to the change under review.

Recommendation:
- [ ] Per-file/per-dir try/catch recording an `omittedReason` (`"missing"`/`"unreadable"`)
      instead of throwing; keep the snapshot best-effort with a visible omission list.
- [ ] Test status: none for concurrent deletion or unreadable dirs; `tests/capture.test.ts`
      covers stable-tree capture only.

### 10. MEDIUM — Transient delivery failures are not retried or surfaced in-session (review pipeline)

Refs: `src/index.ts` `deliverAutomaticTransmission` (`:888-918`, no try/catch around
`dispatchModelDelivery`); `src/durable-delivery.ts:32-62` (`dispatchModelDelivery` marks the
delivery `uncertain` and rethrows at `:60-62`).

Impact: if `sendFollowUp` throws on a transient Pi API failure, the exception escapes
`agent_settled`, the review transmission is never delivered in that session, and the user gets
no notice — only a restart surfaces it as a manual "uncertain" inspection.

Recommendation:
- [ ] Catch in `deliverAutomaticTransmission` and notify the user that the delivery is
      `uncertain` with its diagnostic, instead of letting the exception escape silently.
- [ ] Preserve the existing `uncertain` protocol (recovery explicitly refuses to re-dispatch
      uncertain deliveries): only auto-retry when the transport can prove no send occurred or
      supports recipient-side idempotency; do not mark a possibly-sent delivery back to
      `queued`, since that can duplicate a successfully sent message.
- [ ] Test status: `tests/durable-delivery.test.ts` covers persistence transitions only;
      `tests/transmission.test.ts` covers message formatting only.

### 11. MEDIUM-LOW — `delivery.json` receipt is a racy read-modify-write, written after send (review pipeline)

Refs: `src/transmission.ts` `writeReviewDeliveryReceipt` (`:86-113`, readFile → parse → push →
writeFile with no serialization or atomic rename); `deliverReviewTransmission` (`:115+`)
writes the receipt only after `deliver()` returns true.

Impact: two concurrent deliveries to the same invocation dir can both read the same
`delivery.json` and lose one receipt (non-atomic read-modify-write). A crash between
successful send and receipt write leaves the delivery `uncertain`; recovery refuses to
re-dispatch it automatically, so no automatic duplicate occurs — but the follow-up requires
manual uncertainty resolution instead of being surfaced in-session.

Recommendation:
- [ ] Serialize receipt writes per invocation dir (reuse the `configUpdateTails` pattern from
      `src/settings/persistence.ts:35,109-121`) and make the receipt write atomic (temp +
      rename). The pre-send marker already effectively exists as the persisted `dispatching`
      state; no protocol change is needed for crash semantics.
- [ ] Test status: partial — `tests/index.test.ts:1443-1448` verifies multiple sequential
      receipts in one invocation and `:1843+` verifies an initial receipt; no test covers
      concurrent receipt writes or atomic-write failure.

### 12. LOW-MEDIUM — Aborting a review silently discards queued user input (review pipeline)

Refs: `src/index.ts:642-652` (escape-abort marks queued `queued_user_input` deliveries
`cancelled` and clears `queuedUserInputsDuringReview`); `notifyCancellation`
(`:1060-1067`) sends only the generic "review gate: review cancelled" notice.

Impact: user types guidance mid-review, presses Escape, and the guidance is dropped without
explanation.

Recommendation:
- [ ] Include the dropped-input count (and a pointer to retype) in the cancellation notice.
- [ ] Test status: `tests/commands.test.ts:222` covers abort mechanics but not the
      dropped-input notice.

### 13. MEDIUM — Maintainability: `BackgroundExecutionController` decomposition (updated)

Refs: `src/execution/background-controller.ts` is now **2,592 lines** (previous inventory
said "more than 2,200"). It still owns group persistence, scheduling, execution,
continuation, live control, interruption, force-merge, conflict gating, restoration,
notification delivery, diagnostic formatting, and widget rendering.

Recommendation (extraction order unchanged; boundaries re-verified):
- [ ] Extract task/group persistence and integrity handling (`save`/`atomicWrite` cluster,
      `:1936-2020`, `:2496-2520`).
- [ ] Extract the conflict-gate/force-merge cluster (`~:760-935`) — cleanest first cut.
- [ ] Extract the wake/notification cluster (`wake` lanes `:1745-1810`,
      `formatExecutionEvent :2149+`, `noActionResponseNotice :2210+`,
      `formatResearchCompletion :2105+`) together with item 14.
- [ ] Extract widget/view-model construction, then scheduler/runtime ownership, then
      interaction/recovery commands where transaction boundaries remain explicit.
- Do not split transaction-heavy landing code solely to reduce line count.

Test status: behavior is well covered (`tests/background-controller.test.ts`, execution
suite); extraction is refactor-safe with the current 52/52 `test:execution` baseline as a
guard.

### 14. MEDIUM — Centralize the subtask notification contract (updated)

Refs: policy is represented independently in `wake()` lanes (`background-controller.ts:1745-1790`,
including quiet-mode suppression at `:1758-1762`), `formatExecutionEvent` (`:2149+`),
`noActionResponseNotice` (`:2210+`), `formatResearchCompletion` (`:2105+`), tool
descriptions/result prose, the orchestrator prompt text, README, and tests.

Recommendation (unchanged checklist):
- [ ] Define one typed policy for quiet/noisy state wakes, terminal completion, failure,
      conflict, and recovery-required events.
- [ ] Derive model-facing lifecycle summaries from that policy where practical.
- [ ] Keep passive UI telemetry distinct from events that trigger model turns.
- [ ] Test that quiet mode keeps ordinary `RUNNING`/`REVIEWING` passive while completion,
      failure, conflict, and recovery remain actionable.
- [ ] Test no-action acknowledgement wording separately from transition selection.

Test status: current behavior is tested (quiet-mode assertions exist in the background
controller tests), but the independent copies can drift — that is the debt.

### 15. MEDIUM-LOW — Persistence/top-off scaling debt (corrected)

Current verified state (replaces the stale draft claims): history caps are
`MAX_ACTIVITY = 200` / `MAX_STATE_HISTORY = 64` (`background-controller.ts:28-29`, enforced in
`appendActivity`/`transitionTaskState` plus `normalizeTaskHistory` on read); recent UI
activity is maintained **incrementally** (`addActivity` at `:1911-1918`,
`RECENT_ACTIVITY_LIMIT = 10`, rebuilt only on restore via `rebuildRecentActivity`); terminal
tasks are archived to bounded per-task files with in-manifest stubs (`save()` at `:1943-1972`,
tested by "settled tasks move to bounded archives" in
`tests/background-controller.test.ts:128`). Per-task history is bounded, but **total task
count is not**:

Remaining verified debt:
- [ ] `add()` appends tasks without bound (`background-controller.ts:467-472`) and every
      terminal task leaves a manifest stub that every save re-processes and rewrites
      (`:1943-1980`) — manifest size grows linearly with total top-offs.
- [ ] Restore loads every archived task's full archive back into memory (`readGroup`
      `:2435-2436`, `readTaskArchive` `:2460`) — restore cost and peak memory grow with the
      number of settled tasks.
- [ ] `updateIndicator` traverses all tasks and, in expanded mode, sorts **all** tasks by
      `updatedAt` before filtering to active ones (`:2002-2010`) — widget work grows with
      total task count on every state change.
- [ ] Per-save cost: `save()` still deep-clones the whole group via
      `JSON.parse(JSON.stringify(…))` (`:1973`), then stringifies again for the integrity hash
      (`:1975`) and a third time pretty-printed for the write (`:1980`) — ~3 full
      serializations per save even when only one task changed.
- [ ] Unchanged historical payloads (including every terminal stub) are rewritten on every
      save (no content-diffing of the manifest).
- [ ] Compact or evict terminal stubs past a bound (keep recent N inline, point older tasks
      at their archive files only) and index active tasks so indicator work does not scale
      with total task count.
- [ ] Soak test: hundreds of sequential top-offs asserting bounded manifest size and widget
      work — the acceptance test for the compaction above, not merely a missing-test note.

Test status: caps/archiving tested; soak test missing.

## Lower-priority cleanup / general recommendations

- L1. `forceMerge` acquires the source lease with no abort signal —
  `background-controller.ts:797` vs. `:1085` (which passes `abort.signal`). Behind another
  task's active conflict gate it blocks indefinitely with no timeout or cancel; the command
  stays `queued` with no feedback. Pass an abort signal or fail fast when
  `sourceMutationCoordinator.blocked(cwd)` is set. No test covers force-merge behind a gate.
- L2. `restore()` merges `restored.archives` into `this.archivedTasks` **before** the
  cwd-mismatch validation throws (`background-controller.ts:370-374`) — cross-contaminates
  archive hashes across workspaces. Validate cwd before merging.
- L3. `scripts/pi-review-gate.sh:17-18` unconditionally `unset`s `PI_REVIEW_GATE_CONFIG` and
  `PI_REVIEW_GATE_DISABLED`, silently overriding the kill switch documented at
  `README.md:36-40`. Honor an already-set `PI_REVIEW_GATE_DISABLED` (or warn loudly).
- L4. `normalizeWeb` (`src/config.ts:333-360`) imposes no upper bounds on
  `maxResults`/`maxOutputChars`/`cacheMaxBytes`/`cacheMaxEntries` — `1e9` passes validation.
  Bound them in the config contract.
- L5. ~~`isBlockedAddress` also misses reserved IPv4 ranges (192.0.0.0/24, 198.18.0.0/15,
  192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and deprecated site-local `fec0::/10`
  (verified: `fec0::1` and `198.18.0.1` pass).~~ RESOLVED (2026-09-02): folded into the
  finding-1 fix (`src/web/ip.ts`); all listed ranges plus `fec0::/10` are blocked with
  regression tests in `tests/web-network.test.ts`.
- L6. Secrets redaction misses PEM private-key blocks and raw JWTs without a `Bearer` prefix
  (`src/redaction.ts:8-14`); such tool results persist unredacted in review evidence.
  `tests/redaction.test.ts` covers only two basic cases.
- L7. `new TextDecoder(charsetOf(…))` throws RangeError on an unknown declared charset
  (`src/web/network.ts:96`, `charsetOf :416`) — fall back to utf-8.
- L8. `wake()` failure diagnostics embed a full `inspect()` clone as pretty-printed JSON in
  the notification (`background-controller.ts:1776`) — use a curated diagnostic subset.
- L9. `saveTails` entries are never pruned (set at `background-controller.ts:1988`, awaited
  only at shutdown `:934`) and neither map is cleared in `detach()`; `steeringTails` entries
  *are* deleted when their tail settles (`:1741`). Functional impact nil today since new
  groups get fresh UUIDs — prune `saveTails` on group detach.
- L10. `scripts/ensure-ddgs.sh` pip-installs `ddgs==9.15.0` without hash pinning into a
  user-writable venv, and `runDdgsSearch` honors `PI_REVIEW_GATE_DDGS_PYTHON`/
  `PI_REVIEW_GATE_DDGS_HELPER` env overrides — trusted-environment assumption; document or
  pin harder (defense-in-depth).
- L11. A same-conversation/different-cwd session start overwrites and loses the prior
  persisted state (data-loss/durability debt — kept in lower-priority cleanup, not
  observability-only). On `session_start`, `discardSessionState(state)`
  (`src/index.ts:290`) clears in-memory state before restore; a same-conversation/
  different-cwd restore then throws (`src/session-state.ts:193-195`); the catch notifies
  (`src/index.ts:317-318`); and the unconditional `persistSessionState()`
  (`src/index.ts:334`) writes fresh state through the same conversation sidecar — its path is
  keyed by session file, not cwd (`src/session-state.ts:122-124`) — overwriting the rejected
  persisted state. Pending deliveries, review windows, and execution associations are lost,
  not merely stranded; `recoverPendingModelDeliveries` never runs because it is gated on a
  successful restore (`src/index.ts:324-331`). The rejection itself is an intentional
  isolation contract (mirrored by the execution recovery behavior) and cross-cwd delivery
  must remain prohibited — do not recover or deliver project-specific messages into a
  different cwd. Fix direction: preserve/quarantine the rejected sidecar before any
  post-failure save, report the rejection and pending-record status in the notice without
  exposing or delivering project-specific content into the new cwd, and add a session-start
  test proving a cwd mismatch does not overwrite prior state or pending delivery records.
  `tests/session-state.test.ts:129` asserts the unit-level cwd-mismatch rejection but no
  session-start test covers the overwrite consequence.

## Packaging / docs / test strategy (independent review)

- **No CI exists.** No `.github/workflows`, no other CI config is tracked. All verification
  is local (`npm test`, `npm run check:static`, `npm run test:package`). Recommend a minimal
  CI job (build + `test:fast` on PR; full `npm test` + `check:static` + `test:package` on the
  default branch), caching the Playwright Chromium download that `postinstall` triggers.
- **`postinstall` Chromium install**: runs on every install and downloads Playwright
  Chromium when absent (`scripts/ensure-playwright-chromium.cjs:8-9` exits early when the
  executable already exists). Consider making it lazy/optional for installs that never use
  BrowserExtract.
- **Test-script hygiene**: README (`README.md:13-25`) documents the test tiers
  (`test:fast`, full/integration, `test:execution`, serial, static, package) — no doc gap
  there. Remaining nits: `test:fast` membership (which suites are in the fast tier; it omits
  e.g. `commands.test.ts` and the background-shell tests) is only visible in `package.json`,
  and `test:integration` is just an alias of `npm test`.
- **Highest-value missing tests** (from findings above): post-landing fault injection (2), ShellSend stdin lifecycle (3), LineBuffer byte bounds/matcher cost (4), adversarial table spans (5), receipt race (11), delivery-failure notice and uncertain-state handling (10), queued-continuation interrupt (8), fsync durability (7), snapshot concurrency (9). (Finding 1's SSRF-control coverage gap was resolved 2026-09-02 by `tests/web-network.test.ts`.)
- **Docs drift**: README documents `PI_REVIEW_GATE_DISABLED=1` while the launcher strips it
  (L3); keep kill-switch docs and behavior in sync.
- **Dependency posture is good**: only 7 runtime deps, `package-lock.json` present, and the
  baseline audit is clean (below). Keep lockfile discipline; note L10 for the pip side.

## Validation and positive controls

Baseline validation (2026-09-02): `npm test` **795/795** passed; `npm run test:execution`
**52/52** passed; `npm run check:static` passed; `npm run test:package` passed;
`npm audit --omit=dev` found **0 vulnerabilities** (full `npm audit` also zero).

This review additionally verified, against the current tree:
- Every retained finding above by direct source inspection (line refs are to this snapshot and
  may drift with future edits).
- Finding 1 independently: Node v26 logic reproduction of the exact `isBlockedAddress` code
  (`[::ffff:7f00:1]` and all listed variants pass; for the bare function, dotted-decimal
  mapped forms and private IPv4 are correctly blocked) plus an end-to-end in-process fetch
  where `http://[::ffff:7f00:1]:<port>/probe` reached a server bound to 127.0.0.1 (HTTP
  200). For URL input specifically, the WHATWG parser normalizes `[::ffff:127.0.0.1]` to
  `[::ffff:7f00:1]`, so dotted-decimal *literals* also bypass `validatedPublicUrl` end to end
  — that is part of finding 1, not a gap in it.

Positive controls confirmed in current source/tests:
- Redirect re-validation per hop (`src/web/network.ts:79`).
- `readBoundedBody` enforces the byte limit even when `content-length` lies
  (`src/web/network.ts:278+`); cache files written `0o600`.
- Workspace capture never follows symlinks and omits outside-workspace content by default
  (`src/capture.ts`; covered in `tests/capture.test.ts`).
- ApplyPatch confinement (lexical + realpath) and atomicity are solid and well tested
  (`tests/apply-patch.test.ts`), including traversal, symlink escapes, and check/commit races.
- Session-state/state round-trip integrity and config validation are thoroughly tested
  (`tests/session-state.test.ts`, `tests/state.test.ts`, `tests/config.test.ts`).
- No shell injection in reviewer/executor paths: all spawns use argv arrays with
  `shell: false`; prompts go via stdin. ShellStart's bash wrapper interpolates only numeric
  values (documented design, bounded to model tool use).
- LineBuffer line-count capping and wake-lane routing are tested
  (`tests/background-shell-jobs.test.ts`).

Excluded as intended behavior (not a defect): `/review-now` resetting the automatic
correction budget on `needs_changes` — `tests/commands.test.ts:163+` explicitly tests this as
intended ("`/review-now` requested changes reset the automatic correction budget").
