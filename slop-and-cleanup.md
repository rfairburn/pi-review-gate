# Slop and cleanup review inventory

Date: 2026-09-02
Status: Final consolidated inventory replacing the 2026-08-27 draft. Findings 0, 1, 2, 3, 4, and 5
are RESOLVED work-history entries (fixes landed 2026-09-02); remaining findings are
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
DNS TOCTOU (finding 6) is now closed; see its RESOLVED entry below.

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

### 3. HIGH — RESOLVED (2026-09-02): ShellSend can crash the pi host via unhandled async stdin EPIPE

**Root cause (confirmed).** `ShellSend.execute` guarded `job.proc.stdin?.write(payload)` with a
synchronous try/catch, but `attachStreams` never attached a listener to `job.proc.stdin`. A write
to a pipe whose read end closed (job exits between the `job.exited` check and the write, or while
an earlier large write is still queued beyond the 64KB pipe buffer) emits EPIPE/
`ERR_STREAM_DESTROYED` **asynchronously** as an `'error'` event on the stdin stream — invisible to
try/catch, and with no listener Node raises an uncaught exception that kills the whole pi host and
every job/session in it.

**Fix.** `src/background-shell/index.ts`:
- `attachStreams` now attaches a `job.proc.stdin.on("error", …)` listener at job creation (the same
class of fix the reviewer path shipped in `src/adapters/process.ts`).
- A single idempotent `recordStdinFailure(job, reason)` helper funnels every dead-stdin path — the
stream `'error'` event, the write-callback error, a synchronous write throw, and the already-
destroyed/non-writable precheck — through one place: first reason wins, `stdinDead`/`stdinError`
are marked, and exactly one bounded `[stdin error]` buffer note is recorded, so normal exit races
(callback + stream event firing together, or repeated retries) never spam the log and ShellLog
always explains an unwritable stdin.
- `ShellSend` treats a **recorded** stdin failure (`stdinDead`, set only by a real EPIPE/callback/
sync error via `recordStdinFailure`) as the more precise answer for a retry, so it wins over the
exit flag with a controlled, actionable `stdin-closed` error result. Error reasons are capped at
240 characters before entering the buffer or tool result. Exited jobs whose stdin never
failed keep the definitive `has already exited` message with no note — important because Node
destroys the child's stdin handle in its own exit handler, so a bare `stdin.destroyed` check alone
would misreport every exited job. The write itself uses a bounded await
on the write callback (`WRITE_FLUSH_TIMEOUT_MS = 1500`, unref'd timer). A callback error returns a
controlled `stdin-write-failed` result; a callback that has not fired within the window returns an
explicit `stdin-write-unconfirmed` result saying the bytes are queued but delivery was NOT
confirmed — never claiming they were written — and any later EPIPE still lands via the listener.
Resolution is settled-guarded, so the timeout and the callback can never double-resolve. Live-job
writes are unchanged: small writes flush to the OS pipe buffer immediately, so the existing
success text and wake/buffer behaviour are untouched.

**Tests.** `tests/background-shell-integration.test.ts` adds two deterministic cases. Exit-mid-
write: a `sleep 0.2` child that never reads stdin receives a 4MB ShellSend (far beyond pipe
capacity, so most of it is still queued when the child exits and closes the read end, well before
the flush timeout). Asserts ShellSend returns a controlled `isError` result, the buffer records
exactly one `[stdin error]` note despite the callback and stream event both firing, a follow-up
send trips the dead-stream precheck with a `no longer writable` error while still showing only
that one note (idempotent recording), and the host/test process is demonstrably still alive
(reaching the assertions at all proves no uncaught exception fired). A cleanly exited job
(`exit 0`) answers `has already exited` with **no** `[stdin error]` note, proving Node's own
stdin destruction at exit is never misreported as a failure. Flush-timeout: a `sleep 2`
child outlives the 1500ms window, so ShellSend reports the 4MB write as delivery-unconfirmed
(`isError` false but no `Wrote …` success claim), and the EPIPE from the eventual exit is recorded
as exactly one bounded note with the host intact. The pre-existing live-stdin write test covers
the unchanged live-job path.

**Validation.** `npm run check:static`; `npm run build:test` + targeted
`node --test --test-concurrency=1 dist-test/tests/background-shell-integration.test.js` (25/25)
and `dist-test/tests/background-shell-jobs.test.js` + `background-process-readiness.test.js`
(34/34); no `dist/` output touched.

**Impact.** No stdin error from ShellSend can surface as an unhandled event or crash the pi host;
destroyed/closed/write-callback failures are bounded, visible diagnostics with actionable
tool results, while live-job writes behave exactly as before.

### 4. MEDIUM — RESOLVED (2026-09-02): Background shell output bounded end-to-end; model wake patterns moved to linear-time RE2

Refs: `src/background-shell/jobs.ts` (bounds + matching), `src/background-shell/index.ts`
(stream plumbing), `src/background-shell/jobs.ts` `PendingLineBuffer`/`LineBuffer`,
`tests/background-shell-jobs.test.ts`, `tests/background-shell-integration.test.ts`.

**Changes.**
- Every output surface now carries an explicit, exported character cap with a visible
  `…[truncated]` marker: `MAX_PENDING_LINE_CHARS` (32 768, ≤ 96 KiB UTF-8 — a char cap is a
  byte-equivalent bound since N UTF-16 units encode to ≤ 3N UTF-8 bytes), `MAX_STORED_LINE_CHARS`
  (8 192) plus a `MAX_BUFFER_CHARS` (2 000 000) total retained-text budget that drops oldest
  lines while keeping `total`/offsets stable, `MAX_WAKE_EXCERPT_LINE_CHARS` (512),
  `MAX_WAKE_PAYLOAD_CHARS` (8 192), `MAX_LOG_LINE_CHARS` (2 048), `MAX_LOG_RESULT_CHARS`
  (32 768), `MAX_LABEL_CHARS`, `MAX_COMMAND_DISPLAY_CHARS`.
- The partial trailing line moved from an unbounded `job.pending` string to `PendingLineBuffer`,
  which caps the partial before accumulation, marks the cut, still completes the line when the
  newline finally arrives, and resets for the next line; `finish()` flushes it on close.
- Model wake patterns never touch V8 `RegExp` in production: `compileMatcher`/`compileMatchers`
  evaluate via `re2-wasm` (pure WebAssembly RE2, normal dependency, no native addon) with `iu`
  flags. RE2-unsupported/invalid syntax — or a match-time error such as lone surrogates —
  degrades to a bounded case-insensitive literal substring test, never `new RegExp`. Patterns
  are compiled once per job (weak-map cache for the per-call entry point); `normalizeRules` and
  `compileMatchers` cap count (`MAX_WAKE_PATTERNS` = 16) and length (`MAX_PATTERN_CHARS` = 512),
  and candidate lines are capped at `MAX_MATCH_LINE_CHARS` (8 192) before matching.
- Wake payloads bound label/command/excerpt lines and the whole payload; `ShellLog` bounds
  per-line and total result text while preserving line-count/offset semantics; all tool error
  text (job ids, labels, spawn exception messages — all model-supplied) goes through
  `errorResult`, capped at `MAX_ERROR_DISPLAY_CHARS` (240) with the visible marker.

**Tests.** Unit (`tests/background-shell-jobs.test.ts`): `PendingLineBuffer` no-newline 8 MB
firehose bounds, stored-line and char-budget caps with stable offsets, `(a+)+$` over 200 000 a's
in bounded time, candidate-line cap, pattern count/length caps, payload/field truncation,
`truncateText` marker. Integration (`tests/background-shell-integration.test.ts`): 8 MB
no-newline firehose produces bounded, marker-visible `ShellLog` and wake payloads with paging
intact; a job printing a `(a+)+$`-failed line with the failing `!` inside the
`MAX_MATCH_LINE_CHARS` candidate cap (4 000 a's) under that wake pattern exits with its wake
in ~0.25 s with a responsive host, and oversized job ids passed to ShellLog/ShellSend/ShellStop
return bounded error text with the visible marker. Existing finding-3 ShellSend tests stay green.

**Validation.** `npm run check:static`; `npm run build:test`; targeted `node --test
dist-test/tests/background-shell-jobs.test.js` (49/49) and `--test-concurrency=1
dist-test/tests/background-shell-integration.test.js` (28/28); `test:fast:run` (179/179) plus
the execution suite (59/59); dependency smoke — `re2-wasm@1.0.2` in package.json/package-lock,
packed tarball installs it as a prod dep and CommonJS `require("re2-wasm")` passes an
linear-time RE2 check. No `dist/` output touched (`npm pack --ignore-scripts` for packaging).

### 5. MEDIUM — RESOLVED (2026-09-02): Web table parser DoS via unbounded colspan/rowspan

**Root cause (confirmed).** `src/web/page.ts` table extraction accepted any positive integer
for `colspan`/`rowspan`, filled each cell span in an unbounded loop, and sized the column
array from the maximum expanded row length, so a few-byte page with
`<td colspan="999999999">` drove ~1e9-wide array allocations that OOM the research worker.
Row counts, cell text, and generated table Markdown were likewise unbounded.

**Fix.** `src/web/page.ts` now enforces conservative budgets before any dense allocation or
span-fill loop: per-table row cap (2,000), column cap (256), total expanded-cell cap (65,536,
counting rowspan carry-over slots and the padded dense result), per-cell `colspan`/`rowspan`
cap (1,000), per-cell text cap (2,000 characters including the ellipsis), synthesized combined
header text capped at the same 2,000 characters per column while composing it, table labels
capped at 500 characters, inventory labels/headers summarized under tighter display caps, and a 512,000-character cap on generated
table Markdown (counting every repeated chunk heading/header, whose own length is bounded so
every block stays within the 7,000-character block limit). Rows and cells are collected via
bounded depth-first traversal that never materializes a NodeList or array proportional to
attacker-controlled row/cell counts, and cell/row iteration stops early once budgets are
exhausted; oversized values are clamped/truncated rather than thrown. Truncation is reported
via new `WebTableDescriptor.truncated`/`truncationNotes` fields, which flow through the
session-cache result and are rendered in the `formatPage` table inventory (`· truncated: …`)
for both WebFetch and BrowserExtract. Ordinary tables are unchanged.

**Tests.** `tests/web-tools.test.ts` adds adversarial coverage — billion `colspan`/`rowspan`
clamping with bounded blocks and a sub-5-second runtime budget, physical-row and physical-
cell list traversal that stops at the budgets, sparse-wide and rowspan-heavy tables bounding
the padded dense result, per-cell text truncation, long-header block-limit enforcement,
generated-Markdown capping with an exact ≤512,000 aggregate assertion and the descriptor
signal, formatted-output surfacing through the WebFetch cache result — plus regression
coverage that modest-span tables keep full extraction with no truncation signal.

**Validation.** `npm run check:static`; targeted `npm run build:test` run of
dist-test/tests/web-tools.test.js (39/39, ~8s). No `dist/` output touched.

**Impact.** Attacker-controlled numeric spans and cell counts can no longer drive enormous
loops or array allocations during HTML table extraction; clamped/truncated output remains
usable and visibly flagged to the model.

### 6. MEDIUM (defense-in-depth) — RESOLVED (2026-09-02): DNS validation/connect TOCTOU

**Root cause (confirmed).** `src/web/network.ts` (`validatedPublicUrl`) resolved and checked the
hostname, then `downloadText` re-resolved via `fetch` at connect time — a DNS rebinding window
between validation and connection on every hop. `src/web/browser.ts` cached an origin after one
validation (`approvedOrigins`) and never re-checked it during the render, so a rebinding hostname
stayed approved for the whole render, enabling internal scanning/exfiltration from inside the
browser context.

**Fix.**
- `src/web/network.ts`: `validatePublicUrl` now returns the canonical href, hostname, and every
  address from the single validation-time DNS answer (all pre-validated public). `downloadText`
  was converted from global `fetch` to a direct Node-20-compatible `undici@^6.28.0` dependency
  (7.x would raise the engine floor to ≥20.18.1) using one `undici.request` per hop through a
  per-hop `Agent` whose custom `lookup` (`createPinnedLookup`) dials ONLY the addresses returned
  by the immediately preceding validation for that exact hostname/hop; any other hostname —
  including a re-resolution through real DNS — fails closed. The original hostname is preserved
  for the HTTP Host header, TLS SNI, and certificate validation. Redirect hops are re-validated
  and re-pinned before the next dial, an aborted redirect body plus every per-hop dispatcher is
  destroyed reliably (including on error paths), and `readBoundedBody` was adapted to undici
  request streams. Hostname resolution is injectable (`resolveHostname`) for deterministic tests.
- `src/web/browser.ts`: the origin-approval cache is removed. The initially validated hostname is
  pinned inside Chromium with `--host-resolver-rules=MAP <hostname> <validated address>` (IPv4
  preferred; IPv6 literal bracketed) plus `--no-proxy-server`, because host-resolver rules do not
  govern DNS performed by an HTTP/SOCKS/system proxy; neither Chromium nor a proxy can perform a
  second destination lookup. The resolver is additionally made default-deny by appending an
  ordered `MAP * ~NOTFOUND` rule after the admitted-host mapping, so sockets Chromium may create
  without a routeable request — speculative preconnect and alternative-service endpoints — are
  denied at the network layer before any connection to an unpinned endpoint. Requests to the
  admitted hostname are allowed for every scheme and port (common http→https upgrade redirects
  keep working). Actual response remote addresses are
  verified where Playwright exposes them via `Response.serverAddr()`: every HTTP(S) response's
  peer must equal the pinned validated address, and a blocked peer, a mismatched peer, or a
  missing server address aborts the whole render immediately. Browser networking is closed before
  the final pending-check drain, so a late response or shutdown-time check cannot be omitted from
  the render result. The compensating control for destinations the MAP rule does not cover is
  fail-closed: any HTTP(S) request or navigation to a different hostname — including
  cross-hostname passive resources — or any non-HTTP protocol aborts the request and fails the
  whole render with actionable compatibility text naming the blocked URL and suggesting direct
  extraction of that final URL
  (WebFetch/BrowserExtract on it). Local browser protocols (`about:`, `blob:`, `data:`) remain
  narrowly allowed, images/media/fonts stay blocked, and WebSockets are closed via
  `routeWebSocket`.

**Tests.** New `tests/web-dns-pinning.test.ts` (22 deterministic tests, no real DNS or external
network): injected-resolver validation returning canonical href/hostname/all addresses and
re-resolving on every call; DNS-answer-change simulation proving a private second answer is
rejected; pinned-lookup table tests (only validated addresses, family filtering, fail-closed for
any hostname outside the pin set including `localhost`, `127.0.0.1`, and a trailing-dot spelling);
real-socket tests proving the pinned agent dials only the pinned address with a hostname-based
Host header and refuses `localhost` without opening a connection (no second-resolution fallback);
downloadText redirect e2e tests proving per-hop validation/pinning, hostname-based Host headers
on both hops, exact validated pins passed to each dispatcher, reliable dispatcher destruction
(including on HTTP 500 failures), a rebinding redirect hop rejected before any dispatcher or
dial exists, and a same-hostname DNS flip rejected on the second resolution; no-loopback
controls (loopback literals and private injected answers rejected with zero connections and zero
dispatchers); Chromium host-resolver-rule formatting for IPv4/IPv6/literal pins with IPv4
preference; pinned peer-address verification tests (pinned IPv4 match, bracketed IPv6 match,
blocked/private peers, public-but-different peers, missing server address, non-HTTP(S) skipped);
browser route policy table tests (same-hostname HTTP(S) allowed for every scheme and port,
IPv6-literal hostnames compared without URL brackets, local protocols narrowly allowed,
cross-hostname/`javascript:`/unparseable and cross-hostname passive requests blocked with
actionable text, same-hostname passive requests blocked without tainting); launch-argument and
resolver-rule tests asserting `--no-proxy-server`, the exact admitted-host MAP rule, and the
ordered `MAP * ~NOTFOUND` default denial; a browser-finalization test proving a failing
address check appended during network closure still aborts the render; renderWithChromium
failing closed before any browser launch on invalid answers; and a Chromium-backed connection
control (skipped automatically when Chromium is not installed) driving the pinned resolver rules
through a real headless browser without any route interception installed against loopback
listeners: the admitted hostname renders through the MAP rule while a direct-IP loopback
endpoint — the route-blind speculative-preconnect and alternative-service vector — rejects with
ERR_NAME_NOT_RESOLVED and receives zero new connections, proving the default denial applies to
IP literals rather than merely to nonresolving names.

**Validation.** `npm run check:static`; `npm run build:test`; focused `node --test` runs of
dist-test/tests/web-dns-pinning.test.js (22/22, including the Chromium-backed connection control;
that test skips automatically in environments without Playwright Chromium), web-network.test.js,
web-tools.test.js, and ensure-playwright-chromium.test.js (75/75 combined with Chromium present;
without Chromium the same run reports 75 tests, 74 pass, and 1 skipped). No `dist/` output
touched; no `npm test`/`test:package` run.

**Impact.** WebFetch sockets can only connect to addresses returned by the immediately preceding
validation for that exact hop, and BrowserExtract pins the requested hostname in the browser while
verifying each response's actual peer address, so it cannot contact an unpinned HTTP(S)
destination; the DNS rebinding window is closed on every path instead of being accepted residual
risk. Compatibility trade-off: BrowserExtract now refuses pages that require cross-hostname HTTP(S)
subresources or cross-hostname redirects; the error names the blocked URL and directs the model to
extract that final URL directly.

### 7. MEDIUM-LOW — RESOLVED (2026-09-02): Durable record writers had inconsistent fsync discipline

**Root cause.** Recovery-critical operation records, wave manifests, owner-heartbeat updates,
and persisted task definitions used temp-file renames without syncing file contents or the parent
directory. A hard crash could therefore leave stale or unreadable recovery state exactly when it
was needed.

**Fix.** New `src/execution/durable-write.ts` centralizes restrictive same-directory exclusive
temp creation, complete write, file fsync, close, atomic rename, best-effort directory fsync, and
owned-temp cleanup. Operation records retain their per-path serialization; wave and continuation
manifests, owner heartbeats, and initial/updated task definitions now use the helper. Owner
acquisition preserves exclusive-claim semantics by publishing a fully synced staged file with an
atomic hard link. The prior background-controller and wave-landing durable-write duplicates were
also consolidated without changing their serialized bytes.

**Tests.** Deterministic stage hooks cover pre-rename failures, prior-target preservation,
post-rename reality, foreign temp collisions, exclusive publication visibility/collisions,
restrictive modes, and temp cleanup. Writer regressions cover operation sequencing and recovery,
owner acquisition/heartbeat/release, task metadata preservation, and wave/continuation manifests.
The focused durable/execution/landing suites pass 166/166 with static checks; `dist/` was untouched.

### 8. MEDIUM-LOW — RESOLVED (2026-09-02): Interrupt left queued `continue` commands impossible to dispatch

**Root cause.** Pre-dispatch interruption and launch-rejection cleanup terminalized queued
steering but not queued continuation records. Restored automatic continuations could therefore
leave both a permanently `queued` command and a populated `pendingContinuation` after the task
became interrupted.

**Fix.** `BackgroundExecutionController` now terminalizes every definitely undelivered queued
continuation with a durable reason and clears `pendingContinuation` during pre-start interrupts,
registered-runtime preprocessing interrupts, launch rejection, and preserved terminal outcomes.
Scheduler and continuation-entry guards re-check the exact queued work after awaited routing,
steering, and snapshot preparation so a stale selection cannot launch. Already delivered or
acknowledged commands retain their recorded reality.

**Tests.** Four deterministic regressions cover restored auto-continuation interruption, an
ordinary queued continuation interrupted while scheduler routing is suspended, all launch
rejection branches, and interruption while a runtime exists but before executor dispatch. They
assert terminal command/task state, cleared pending work, durable persistence, retained
acknowledged steering, and zero continuation launches. The focused controller suite passes 21/21
with static checks; `dist/` was untouched.

### 9. MEDIUM — RESOLVED (2026-09-02): Snapshots failed on concurrent filesystem changes

**Root cause.** File and directory inspection treated per-entry races and permission failures as
fatal to the entire snapshot. A file removed between enumeration, `lstat`, and streaming—or an
unreadable directory during the non-Git walk—could therefore reject the agent turn.

**Fix.** Capture is now best-effort per entry while preserving abort semantics. A typed, bounded
omission ledger distinguishes verified `missing` entries from possibly present `unreadable`
files/directories, retains unreadable presence records, suppresses false child deletions beneath
unreadable directories, and survives ledger overflow with a conservative root sentinel. Git
warning paths are rebased to the capture cwd and audited with a filesystem fallback. File reads
use a no-follow handle, verify canonical workspace containment and stable identity/size before and
after hashing, and close handles on every path. Omissions persist with session snapshots and flow
through review/question bundles into reviewer prompts; prompt rendering caps count, path length,
and error-code length and visibly reports both display and ledger truncation.

**Tests.** Deterministic fault seams and filesystem controls cover deletion between `lstat` and
open, unreadable files/directories, non-Git and Git-warning discovery, cwd rebasing, omission
bounds/root sentinel behavior, file-to-symlink swaps, in-place growth/shrink races, aborts, handle
cleanup, stable-tree compatibility, session round trips, evidence classification, prompt bounds,
and review/wave propagation. Focused capture, evidence, prompt, session/state, and wave-semantic
suites plus static checks pass without touching `dist/`.

### 10. MEDIUM — RESOLVED (2026-09-02): Uncertain deliveries were not surfaced in-session

**Root cause.** A throwing automatic `sendFollowUp` escaped `agent_settled` after the durable
delivery protocol classified the outcome as uncertain, leaving the user without an in-session
explanation until restart recovery.

**Fix.** Automatic delivery now distinguishes a successfully persisted `uncertain` transition
from queue/save failures, pre-existing uncertainty, and session-shutdown no-op persistence. Only
the newly durable uncertainty is handled: `agent_settled` resolves and one session-active notice
reports the delivery ID, invocation directory, and single-line diagnostic capped at 200 characters
including its visible truncation marker. It never claims non-delivery, retries, or reverts the
record to `queued`; all non-durable/pre-existing cases still propagate, and recovery retains its
manual-inspection/no-duplicate protocol.

**Tests.** Five automatic-pipeline regressions cover a throwing transport with durable state and
one visible notice, diagnostic truncation, uncertain-state persistence failure, shutdown during
dispatch, and pre-existing uncertain-record deduplication. They assert exact send/notice counts,
`agent_settled` resolution versus rejection, durable `dispatching`/`uncertain` status, restart
behavior, and no automatic duplicate.

### 11. MEDIUM-LOW — RESOLVED (2026-09-02): `delivery.json` receipt persistence was racy (review pipeline)

**Root cause.** Concurrent deliveries to one invocation directory performed independent
read-modify-write cycles, so a later write could overwrite an earlier receipt. Replacement was
also direct, allowing a failed write to leave a partial target.

**Fix.** `writeReviewDeliveryReceipt` now queues read-modify-write operations by the resolved
invocation-directory path. Each tail recovers from the prior operation, and cleanup removes only
the exact current tail after settlement. Receipt replacement stages a unique same-directory temp
file, writes and syncs it, renames it into place atomically, and best-effort syncs the directory;
all pre-rename failures close and remove the temp file without changing the prior target. Send,
uncertain-state, receipt content/message, and idempotency-key behavior are unchanged.

**Tests.** `tests/transmission.test.ts` runs 64 concurrent writes and verifies valid JSON,
contiguous sequences, exact unique keys, and first-content/subsequent-message behavior. A
deterministically delayed/interleaved write proves same-directory serialization and independent
directory progress, including exact-tail pruning. A pre-rename failure seam verifies byte-for-byte
prior-target preservation, temp cleanup, tail recovery, and a successful subsequent append.

### 12. LOW-MEDIUM — RESOLVED (2026-09-02): Cancellation silently discarded queued user input

**Root cause.** Escape and `/review-cancel` correctly cancelled durable queued-input deliveries
and cleared the legacy input ledger, but their only user-facing message reported reviewer
quiescence. Users therefore had no indication that mid-review guidance was deliberately dropped.

**Fix.** The cancellation path now reconciles legacy ledger-only occurrences into active durable
deliveries, treating stale delivered/cancelled records as non-matches, counts only deliveries
still definitely `queued` (never `dispatching`/`uncertain`), marks them cancelled, clears the
ledger, persists that state immediately, and emits one count-only notice telling the user the
inputs will not be sent automatically and should be resent if needed. Input content is never
echoed. Zero-drop cancellation remains quiet apart from the existing cancellation notices.

**Tests.** Automatic Escape and `/review-cancel` tests assert a single count-only notice, no
follow-up delivery, and no content leak. A restore regression covers a legacy queued ledger with
no active delivery despite a stale cancelled same-text record, then verifies the reconciled
record and cleared ledger remain durably cancelled. Command and Kitty-escape tests assert that
zero-drop cancellation does not invent a drop notice.

### 13. MEDIUM — RESOLVED (2026-09-02): `BackgroundExecutionController` mixed unrelated mechanics

**Root cause.** The controller owned pure task lifecycle/timing/history logic, durable group and
archive formats, filesystem cleanup, widget rendering, scheduling, recovery transactions, and
notification delivery in one module. That obscured persistence boundaries and made independent
behavior difficult to test.

**Fix.** Cohesive internals now live in three typed modules. `task-state.ts` owns task contracts,
state predicates/transitions, timing, bounded history normalization, activity, and progress
mapping. `background-group-store.ts` owns manifest/archive versions, exact serialization and
integrity checks, legacy-v1 restoration, archive reuse/hydration, durable writes, and guarded temp
root cleanup while the controller retains L9 caller-owned save ordering. `subtask-widget.ts` owns
the compact/expanded view model, executor labels, clipping, and component rendering from plain
snapshots. Existing controller imports remain source-compatible through re-exports. The
force-merge/conflict path deliberately stays controller-owned because it is one transaction over
the source lease, parent checkpoint, conflict gate, durable save, associations, and wake; splitting
it into callbacks would hide rather than clarify ownership. Notification policy is handled
separately by finding 14.

**Tests.** New module suites cover task transitions/timing/history/progress, exact group and archive
bytes/hashes, archive reuse/tamper/state validation, legacy execute/research restore, guarded root
cleanup, executor labels, compact/expanded widgets, sorting, clipping, conflict display, and public
re-export compatibility. Controller/tool/session and new module suites pass 89/89 with static
checks, with on-disk versions and existing lifecycle behavior unchanged.

### 16. HIGH — RESOLVED (2026-09-03): Allow safe cross-host BrowserExtract resources

**Root cause.** BrowserExtract's initial DNS hardening statically pinned one hostname and made every
other HTTP(S) request fatal, including fonts/images/media that the tool deliberately omitted. That
prevented DNS rebinding but rejected ordinary CDN-backed pages such as `developers.openai.com`.

**Fix.** Passive images/media/fonts are now aborted before any destination connection, disclosed in
bounded model-visible omission diagnostics, and never taint an otherwise useful render. Required
cross-host scripts, styles, API calls, and redirects use a per-render authenticated loopback HTTP
and HTTPS-CONNECT egress broker. Every destination is canonicalized, resolved once, required to
have only public answers, and dialed only at a validated address while preserving HTTP Host and
end-to-end TLS SNI/certificate semantics. Chromium is forced through the broker with implicit
loopback bypass removed, default-deny DNS, QUIC/alternative transport controls, non-proxied WebRTC
UDP disabled, service workers blocked, and WebSockets closed. Explicit host, request, connection,
header, authority, byte, redirect, idle, total-time, and cleanup budgets fail closed. Browser and
broker sockets quiesce before the public-address ledger is audited; truncated/omitted active
resources are accepted only when useful rendered content remains.

**Tests.** Deterministic resolver/dial and real Chromium tests cover passive zero-connect behavior,
cross-host scripts/styles/XHR/redirects, DNS rebinding and private/unresolved destinations,
loopback/direct-IP/WebRTC/QUIC bypass resistance, proxy authentication, Host semantics, concurrent
admission and byte limits, truncation versus client cancellation, main-document completion,
visible bounded diagnostics, and cleanup deadlines. The focused web suite passes 116/116 with no
skips plus static checks and `git diff --check`. A live compiled-source acceptance render of
`https://developers.openai.com/` succeeded with 317,708 rendered HTML bytes and bounded disclosure
of its omitted CDN fonts/images, while live `dist/` remained unchanged.

### 14. MEDIUM — RESOLVED (2026-09-02): Centralize the subtask notification contract

**Root cause.** Wake eligibility, delivery lanes, lifecycle formatting, no-action wording, tool
result prose, prompt guidance, watch checkpoints, and the L8 failure diagnostic were maintained as
independent controller/tool copies that could drift. Passive UI state and model-turn policy were
not represented by one typed contract.

**Fix.** `src/execution/subtask-notifications.ts` is now the pure, typed source of truth for
quiet/noisy wake eligibility, actionable versus passive events, immediate/follow-up delivery
shapes, state-transition and no-action wording, execution/research/watch formatting, derived tool
and prompt guidance, and the bounded curated failure-recovery diagnostic. The controller retains
only delivery sequencing, persistence snapshots, watch cancellation, and I/O; widget telemetry
remains a separate passive path. Existing controller exports remain source-compatible.

**Tests.** Dedicated policy tests cover quiet/noisy eligibility, lanes and trigger-turn behavior,
derived lifecycle prose, passive transition suppression, no-action acknowledgement separation,
partial/full execution and research completion, watch formatting/delivery, and L8 content/bounds.
The focused notification/controller suites pass 59/59 with static checks and unchanged live
`dist/` output.

### 15. MEDIUM-LOW — RESOLVED (2026-09-02): Bound persistence and top-off scaling

**Root cause.** Every settled task left a manifest stub that was reprocessed, cloned, hashed, and
rewritten forever; restore eagerly hydrated all archives; widget/scheduling paths traversed
lifetime task history; and repeated additions had no per-execution unsettled-task ceiling.

**Fix.** Version-3 group manifests retain at most 32 recent settled references and persist exact
lifetime/archived aggregate counts, while execution-bound version-2 task archives preserve stable
historical handles. Older records load lazily by exact `(executionId, taskId)` with integrity and
ownership checks; v1/v2 manifests and legacy archives migrate compatibly through an authenticated
membership index. Routine serialization is proportional to bounded inline state, unchanged
archives are reused, and archive writes precede the atomic manifest. An execution admits at most
128 unsettled tasks but supports unlimited sequential settled top-offs. A controller-wide active
index now feeds scheduling, readiness, and widget rendering without scanning settled history;
model and compact UI output explicitly disclose archive-only or omitted records.

**Tests.** Admission, legacy migration, lazy lookup, tamper/missing/foreign archive failures,
archive reuse/write counts, continuation/re-admission races, cleanup safety, truthful notification
aggregates, active-index behavior, and a 220-top-off soak test cover the new format. The focused
store/notification/controller/tool suites pass 109/109 with static checks, `git diff --check`, and
unchanged live `dist/` output.

## Lower-priority cleanup / general recommendations

- L1. **RESOLVED (2026-09-02):** force-merge now fails promptly with a durable actionable
  outcome when an active conflict gate blocks the source, and lease acquisition uses a dedicated
  abort signal. Pending force-merges are registered before awaiting, so user interruption and
  shutdown cancel and quiesce a request that is waiting behind another source mutation without
  claiming a merge or changing the workspace. Acquired merges retain the existing serialized
  landing path. Aborted coordinator waiters now prune their settled lease tails even though no
  release callback was returned. Focused conflict-gate, held-lease interrupt/shutdown, no-mutation,
  command-status, and tail-cleanup tests pass (27/27 with the controller and coordinator suites).
- L2. **RESOLVED (2026-09-02):** `restore()` now validates each persisted group's cwd
  before merging any of its archive metadata into controller-global state. A cross-cwd or
  malformed group remains rejected without contaminating archive hashes used by a valid group.
  A collision regression restores valid, mismatched, and malformed groups together, forces the
  valid group through another save, verifies its archive bytes/hash and second restore, and
  confirms rejected groups never become inspectable. The focused controller suite passes 25/25.
- L3. **RESOLVED (2026-09-02):** the launcher still sanitizes and re-resolves inherited
  `PI_REVIEW_GATE_CONFIG`, but now preserves the documented `PI_REVIEW_GATE_DISABLED` kill
  switch, forwards it to Pi, and prints a clear non-activation notice for the same truthy values
  recognized by `loadConfig`. Launcher tests cover enabled and disabled paths.
- L4. **RESOLVED (2026-09-02):** `normalizeWeb` now rejects values above explicit exported
  caps for search results (100), output characters (100,000), cache bytes (256 MiB), and cache
  entries (256). Boundary and billion-scale regression tests cover every setting while defaults
  remain unchanged.
  Bound them in the config contract.
- L5. ~~`isBlockedAddress` also misses reserved IPv4 ranges (192.0.0.0/24, 198.18.0.0/15,
  192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and deprecated site-local `fec0::/10`
  (verified: `fec0::1` and `198.18.0.1` pass).~~ RESOLVED (2026-09-02): folded into the
  finding-1 fix (`src/web/ip.ts`); all listed ranges plus `fec0::/10` are blocked with
  regression tests in `tests/web-network.test.ts`.
- L6. **RESOLVED (2026-09-02):** evidence redaction now recognizes bounded multiline and
  JSON-escaped PEM private-key blocks plus structurally plausible raw JWTs without requiring a
  `Bearer` prefix. Tests cover key-label variants, CRLF/escaped forms, JWT structure, near misses,
  marker idempotence, and existing credential patterns.
- L7. **RESOLVED (2026-09-02):** response decoding now routes through
  `decodeResponseText`, which honors supported declared charsets and falls back to UTF-8 when
  `TextDecoder` rejects an unknown label. Focused tests cover supported, unknown, malformed,
  absent, and unquoted charset declarations without changing the existing byte limit.
- L8. **RESOLVED (2026-09-02):** failure wakes now use a typed curated recovery diagnostic
  instead of serializing `inspect()`. It includes stable task/execution handles, current state,
  aggregate progress, bounded summary/error/recent activity, and only the durable bundle or
  conflict-gate fields needed for explicit recovery actions. Instructions, acceptance criteria,
  command text, model results, full task arrays, and generic event bodies are excluded. Every
  model-controlled field, recovery action, encoded JSON payload, and final notification has a
  visible hard cap; conflict recovery retains `SubtasksMarkClean` independently of truncated
  notice text. Failure wording remains truthful for conflicted and other non-`failed` states.
  Adversarial secret, escape-amplification, conflict-path, quiet/noisy, structured-details, and
  parseability tests pass in the 28/28 focused controller suite.
- L9. **RESOLVED (2026-09-02):** each serialized group-save tail now self-prunes after
  settlement using exact promise identity, so an older completion cannot delete a newer tail and
  failed writes remain visible to their caller without wedging the next save. Shutdown and detach
  quiesce all registered tails before clearing bookkeeping; lifecycle epochs and attachment guards
  prevent an awaited start, restore, or bundle adoption from attaching a group after a superseding
  detach. Tests cover overlapping saves and final revision order, failed-tail recovery, repeated
  groups, start/restore/detach races, stale-group rejection, and gated detach/shutdown writes. The
  focused controller/tool suites pass 51/51; `steeringTails` behavior is unchanged.
- L10. **RESOLVED (2026-09-02):** production no longer honors the
  `PI_REVIEW_GATE_DDGS_HELPER` override; it resolves only the packaged bridge and runs it with
  Python isolated mode. Provisioning now uses isolated mode throughout, installs the exact DDGS
  version with binary-only/no-cache/noninteractive eager dependency resolution, and verifies
  both installed metadata and `pip check` before continuing. README documents the remaining
  trusted-user boundaries (`PI_REVIEW_GATE_DDGS_PYTHON`, venv/cache path, package index/pip
  configuration) and explicitly states that version pinning is not cryptographic hash pinning.
  Launcher and web-network tests verify isolated invocation and that helper injection is ignored.
- L11. **RESOLVED (2026-09-02):** a same-conversation/different-cwd session start no
  longer overwrites or delivers the prior persisted state. `restore()` throws typed errors
  (`SessionStateCwdMismatchError` with only safe metadata: stored/current cwd, revision,
  aggregate pending-delivery counts; plus typed parse/integrity/conversation errors whose
  messages never quote sidecar content), `session_start` quarantines the rejected sidecar to
  a unique no-clobber sibling before any fresh-state save, and every other restore failure is
  fail-closed against overwrite. Notices disclose only fixed failure categories or errno codes
  and bounded paths plus count summaries — never message text. A throwing notifier cannot
  disable persistence after a successful quarantine; if quarantine itself fails the store is
  disabled so the authoritative sidecar is never overwritten. Integration and unit tests cover
  byte preservation, no delivery across cwds, isolated fresh state, non-clobbering repeated
  quarantines, quarantine/notice failure, secret-sentinel content containment, and long-path
  bounding.

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
- **Highest-value missing tests** (from findings above): queued-continuation interrupt (8) and
  fsync durability (7). Post-landing faults (2), ShellSend lifecycle (3), table bounds (5), DNS/IP
  controls (1), background-shell bounds (4), snapshot concurrency (9), uncertain delivery (10),
  and receipt races (11) now have dedicated regression coverage.
- **Docs drift**: README documents `PI_REVIEW_GATE_DISABLED=1` while the launcher strips it
  (L3); keep kill-switch docs and behavior in sync.
- **Dependency posture is good**: only 8 runtime deps, `package-lock.json` present, and the
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
