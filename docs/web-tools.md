# Web tools

This page owns the native web research tools: `WebSearch`, `WebFetch`,
`BrowserExtract`, and the bounded interactive-browser tools, their cache and
session behavior, and the standalone web CLI. Config fields and
defaults live in [Configuration](configuration.md#web-fields); hardening details live in
the [Security model](security-model.md#web-egress-hardening).

## WebSearch

`WebSearch` uses the API-key-free DDGS metasearch library. It passes the requested
result count directly to DDGS, retries one empty or failed attempt, canonicalizes
duplicate URLs, reports optional provider-supplied dates and weak snippets without
inventing missing data, and supports `excludeDomains`. The launcher provisions the
pinned Python dependency in a per-user cache environment and every Pi process invokes it
on demand.

The Python bridge is deliberately not configurable: production always resolves the
packaged `scripts/ddgs-search.py` relative to the loaded extension and invokes it with
Python's isolated mode (`-I`). The legacy `PI_REVIEW_GATE_DDGS_HELPER` variable is
ignored, so an inherited value cannot substitute an arbitrary helper. The launcher and
web CLI wrapper export `PI_REVIEW_GATE_DDGS_PYTHON` to point at their isolated venv;
direct extension invocation without those wrappers may set that interpreter override
itself — this is required when DDGS is installed only via `PYTHONPATH` or user
site-packages, because isolated mode ignores both, so the override must point at an
interpreter whose own environment contains DDGS.

`PI_REVIEW_GATE_DDGS_VENV` and `XDG_CACHE_HOME` (or `HOME` when the former is unset)
select the venv/cache location. The default venv lives in a user-writable cache by
design. These interpreter, environment, and cache controls are trusted-user boundaries,
not safe inputs to accept from an untrusted repository, task, or process environment —
see [Security model](security-model.md#trust-boundaries).

DDGS setup fails closed: `scripts/ensure-ddgs.sh` provisions exactly `ddgs==9.15.0`,
resolves all of its dependencies through pip, requires binary distributions, avoids
pip's reusable download cache, runs every Python invocation (venv creation, pip, version
validation) in isolated mode (`-I`) so a reviewed repository's local modules cannot
shadow the interpreter or pip, and verifies both the installed DDGS distribution version
and `pip check` before continuing. The version constraint and these checks are defense
in depth, not cryptographic integrity: transitive dependencies and artifacts are not
fully hash-pinned. The configured PyPI/index source and local pip configuration
therefore remain part of the trusted setup boundary.

## WebFetch

`WebFetch` downloads and indexes the complete selected HTML page or PDF, but returns
only a bounded structural range. Its result includes `nextIndex` when more blocks
remain. HTML results include a whole-page table inventory, possible site-pagination
URLs, and `dynamic_content_suspected`; PDF results preserve page numbers, expose
document metadata, and identify likely scanned/image-only files when little or no text
can be extracted.

- Use `find` on that same `WebFetch` URL to locate text anywhere in the indexed
  document; an accompanying `index` starts the case-insensitive search at that block.
- Continue at a returned match, table, or `nextIndex`; while the document remains
  cached, no second network request is made. A site-pagination URL is a different
  document and therefore a new fetch.
- When reading a table index, `columns` projects exact case-insensitive header names in
  the requested order; `#N` selects a 1-based column when headers are duplicated or
  inconvenient.
- PDFs use the same `url`, `find`, `index`, `nextIndex`, `maxChars`, and `refresh`
  flow; table-column projection is currently HTML-only. PDF detection uses both the
  HTTP content type and file magic, and password-protected, corrupt, or oversized
  documents fail explicitly.

## BrowserExtract (rendered-page extraction)

`BrowserExtract` is the rendered-page extraction fallback. Use it only after `WebFetch`
reports `dynamic_content_suspected` or plausibly fails because the result requires
JavaScript rendering, asynchronous page population, browser-managed cookies/bootstrap,
or browser-style delivery. Missing expected primary content is also sufficient reason to
try it: a false suspicion flag means no static heuristic fired, not that the page is
proven complete.

It launches an isolated headless Playwright Chromium process for an uncached URL,
captures the rendered HTML, closes Chromium, and exposes the same `find`, `index`,
`nextIndex`, table inventory, and `columns` operations as `WebFetch`. It does not click,
type, authenticate, interactively scroll, capture screenshots, or maintain a browser
session; it is not an interactive browser or vision tool.

Every Chromium request routes through a per-render loopback egress broker. The
containment design — forced proxying, default-deny host resolution, per-destination
validation, budget enforcement, and fail-closed rules — is owned by
[Security model](security-model.md#egress-broker-containment). Pages requiring ordinary
cross-host scripts, styles, API calls, or redirects render normally through
independently validated public destinations. Images, media, and fonts are intentionally
omitted by the route policy and this never fails the render; the result discloses
bounded omission diagnostics instead.

Chromium provisioning follows the install-time rules described in
[Getting started](getting-started.md#installation), including
`PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM=1` and the `npx playwright install chromium`
recovery path.

## Interactive browser

Use the least-powerful acquisition method that works: `WebSearch` discovers sources,
`WebFetch` reads ordinary documents, `BrowserExtract` renders one dynamic page and
immediately closes it, and only then should a Pi-native orchestrator or worker open a
short-lived interactive session. Start with `BrowserSnapshot`; escalate to `BrowserInspect`
only for one referenced element that needs fixed state detail, and use `BrowserConsole` or
`BrowserNetwork` only to diagnose behavior the rendered semantic view cannot explain.
Pages may open live `ws:`/`wss:` connections: each destination is validated with the same
public-URL policy as navigation (no URL credentials, every resolved address public) and routed
by Chromium through the session's authenticated loopback broker, so quiet connections survive idle,
turns, and reviews and are drained on close or shutdown. The session surface is bounded
and semantic:

- `BrowserOpen` creates one isolated context and tab, navigates to a public HTTP(S) URL,
  and returns opaque random session, tab, and document-generation handles.
- `BrowserNavigate` navigates that tab, including public redirects. Interactive open,
  navigate, and tab-open preserve URL fragments; same-document navigation succeeds
  without a new HTTP response and reports the existing document's status. Navigation
  metadata is read after bounded rendering settle. Every navigation invalidates all
  semantic refs from the previous document generation.
- `BrowserSnapshot` returns a bounded Playwright accessibility/ARIA snapshot. Any refs
  are replaced with opaque generation-scoped refs; truncation and original/returned
  character counts are explicit. A successful snapshot replaces the current ref set.
- `BrowserConsole` reads a cursor page from a capture-time-bounded, per-tab memory ring
  of console level/text/source metadata and uncaught page errors. Text is structurally
  filtered, secret-redacted, and capped before retention; sources expose only a public
  origin and bounded line/column metadata. Console arguments, object serialization,
  source payloads, and error stacks are excluded. Every result reports the requested,
  next, latest, and oldest-retained monotonic cursors plus returned, dropped,
  result-truncated, and capture-truncated counts.
- `BrowserNetwork` reads an equivalent bounded cursor ring containing only request,
  response, failure, and available browser-policy metadata: sequence/timing, method,
  public origin (path, query, fragment, and credentials removed), resource kind, status,
  and bounded outcome/failure classification. Live page-created `ws:`/`wss:` connections
  appear as websocket-kind records with metadata-only lifecycle states — created when the
  route requests admission, closed at the terminal state reported by the browser's own WebSocket
  stack (no connected state is ever claimed; a working connection is proven by page/app
  state) — plus close codes only where the browser exposes them and policy-block reasons
  for refused destinations. It never returns
  request or response bodies, headers, cookies, authorization, post data, WebSocket
  frames, cache contents, or sensitive URL path/query data. Reading it creates no
  network traffic.
- `BrowserInspect` accepts exactly one current opaque ref from the latest successful
  `BrowserSnapshot` for that owned session, tab, and document generation. It returns a
  fixed allowlist: browser-computed role/name semantics captured with the fresh
  accessibility ref, tag/type and a browser-computed description bounded after
  computation, current effective checked/disabled/expanded/selected/focus/editability
  state, redacted HTTP(S) href origin resolved against the browser-computed owning
  document base URL (including CSP enforcement and inherited document bases), and
  bounded visible-text metadata. The fixed base-URL reader uses in-process Playwright's
  isolated selector evaluator and fails closed if that internal API is unavailable. Description computation uses Playwright's isolated
  accessibility engine in the ref's owning document. Input, textarea, and select text
  remains suppressed even when readonly or disabled; suppression does not imply editability. Forged, stale, cross-session, and cross-tab refs fail uniformly. The tool has no
  selector, arbitrary attribute, coordinates, raw HTML/DOM, value, script/evaluate,
  CDP, frame, or shadow-root escape input. Inspection never runs a callback in the
  page's main JavaScript world; timeout or cancellation tears down the owning session
  before browser action serialization is released.
- `BrowserScreenshot` is the visual fallback after semantic inspection. It returns a
  PNG as native Pi image tool-result content for either the current 1280×720 viewport
  or one visible element named by a ref from the latest successful `BrowserSnapshot`.
  Element capture positions the ref, validates that it fits the viewport, and passes
  those exact bounds as an immutable page clip; later layout or animation changes
  cannot enlarge the capture. It never returns a file path or textual base64. Full-page screenshots are not
  supported because an arbitrarily tall page cannot meet the allocation guarantee
  without unbounded capture or tiling.
- `BrowserScroll` permits only three bounded semantic forms: moving the page up/down,
  moving the nearest scrollable container belonging to a current opaque ref up/down,
  or bringing a current ref into view. Each movement is at most three viewport
  fractions. There is no caller-provided selector, pixel coordinate, or script.
- `BrowserWait` performs one event-driven, deadline-bounded observation. Conditions are
  limited to a current ref becoming attached/detached/visible/hidden, bounded literal
  text becoming present/absent, an HTTP(S) URL exact/prefix/safe-RE2 match, DOM/load
  completion, Playwright-observable network quiet, or a duration of at most two
  seconds. Text presence requires at least one visible literal match across the page;
  absence requires that no visible match remains. The total deadline is at most ten
  seconds and is shared by every phase;
  this is not a polling or workflow-orchestration tool.
- `BrowserHistory` lists at most 32 browser-owned HTTP(S) history entries or performs
  back, forward, or reload. Fixed internal Chromium history commands distinguish
  pushState, replaceState, identical URLs, and page-initiated traversal; no caller CDP
  input is accepted. The retained window includes the current entry and reports
  `omittedEntries` and `truncated`, including omissions at the retention limit. Entry
  indices are browser history indices, not positions within the returned window.
  Traversal consumes the same navigation budget and targets an observed adjacent entry
  ID. Generations are opaque observation epochs, not restorable document handles;
  navigation (including hash/SPA and child-frame commits) invalidates prior refs.
- `BrowserTabs` lists, opens, switches, and closes session-owned tabs using opaque
  handles. A session has at most four tabs. Script-created popups are immediately
  adopted into that same ownership/broker boundary when capacity exists, or closed at
  the limit. Refused popups remain tracked until closure is confirmed, and a tab whose
  creation resolves after its deadline is contained during teardown. Switching does
  not change a document generation. Closing the active tab chooses the oldest remaining
  owned tab deterministically; closing the last tab tears down the complete session and
  reports that fact. Failed opens restore the prior active tab only after rollback
  closure is confirmed; an uncertain creation, tab close, or history traversal tears
  down the session before returning an error.
- `BrowserHover` hovers exactly one current opaque semantic ref. It is observational,
  accepts no action options, and invalidates that tab's refs after a successful dispatch
  because hover-driven page changes can make prior evidence stale.
- `BrowserClick` clicks exactly one current opaque semantic ref. It accepts an optional
  `button` parameter limited to `left` (default) or `right`; no other button, modifier,
  double-click, or coordinate form is exposed. A centralized policy
  inspects a freshly resolved target's structural properties and fingerprint; accessible
  names, page claims, and model assertions never establish safety. Structurally proven
  ordinary HTTP(S) links may proceed without a
  prompt. Controlled links must target the current top-level browsing context;
  child-frame links and non-self base targets are rejected before navigation rather
  than silently redirected into the top page. Silent links preserve fragments and resolve
  relative URLs against the owning document's isolated native base URL.
  Native `summary` disclosure is consequential: even setting `details.open` dispatches
  page-controlled `toggle` handlers. Preflight (including hover) uses Playwright's
  isolated engine reads, never page-owned getters or main-world evaluation.
  Submission binding includes the native effective form action and method, including
  external `form` associations and submitter overrides. These form facts require the
  supported isolated Playwright selector bridge; missing support fails closed, without
  falling back to main-world evaluation or element-handle previews.
  Silent links are activated as controlled brokered navigation rather than by
  dispatching page click handlers; known consequential destinations such as logout,
  destructive, authorization, publish, send, purchase, or account paths are not silent.
  A `right` button is always consequential on every target: it is dispatched as a real
  Playwright right-click so page-controlled `contextmenu` and mouse handlers can run, it
  never uses the controlled ordinary-link navigation or any other silent shortcut, and
  the selected button is shown in the confirmation prompt and result metadata. Forms,
  downloads, authentication/terms/permissions, destructive/publish/send/
  purchase/account actions, unknown buttons or menu items, and every unknown or mixed
  result are consequential and require approval under
  [Browser interaction approval](#browser-interaction-approval). With the default
  **Ask**, a top-level interactive Pi session must approve one exact, short-lived click
  through Pi's confirmation UI. The permit is bound to the session,
  tab, document generation, origin and destination, operation, mouse button, target
  fingerprint, and consequence; it is single-use, expires absolutely, and is consumed only after the
  target is re-resolved and all fields still match, including with automatic approval.
  A permit issued for a left-click cannot be consumed for a right-click or vice versa.
  Denial, cancellation, timeout, changed structure/origin, or stale refs prevents
  dispatch. Absent UI also rejects in **Ask**; authorized non-UI executor sessions may
  use **Automatically Accept** but never claim human confirmation.
- `BrowserFill` replaces a supported text control's bounded value (including
  clearing it), while `BrowserType` appends at most 1,000 characters with an optional
  0–5 ms per-character delay. `BrowserSelect` accepts a nonempty set of at most 32
  exact, unique native option labels or values and supports bounded multi-selects.
  `BrowserPress` accepts one named key or short editing chord under a strict grammar;
  clipboard chords, arbitrary sequences, and raw event objects are rejected. All four
  require a fresh owned semantic ref and invalidate refs after a successful action.
  Password and file controls are rejected. A structurally proven unsent local edit may
  proceed as ephemeral state only when relevant page-controlled events are proven
  absent; ordinary web pages can hide direct or delegated `addEventListener` handlers,
  so event-dispatching form actions conservatively require configured approval rather than
  assuming those handlers do not exist. Results explicitly distinguish whether a remote
  network effect was observed. Sensitive or autocomplete controls, authentication/terms destinations,
  submit or activation keys (including Enter and Space), explicit change/autosave/
  submit handlers, and unknown or mixed targets require the same configured approval
  as consequential clicks (**Ask** requires real top-level UI and rejects without it).
  Approval is
  bound to the action, key, and a nonpersisted digest and lengths of the exact values,
  in addition to session/tab/generation/origin/target/consequence, followed by immediate
  re-resolution and reclassification. Input argument redaction and value-free approval
  prompts remain in place. Before dispatch, literal entered strings and selected native
  labels/values are registered in bounded, memory-only browser-manager state. Complete
  literal echoes are redacted from browser result text/details and later diagnostics,
  including asynchronous echoes, before those results become extension evidence.
  This is not a page information-flow secrecy guarantee; see the limits below.
  Pi/provider-native conversation and session-history retention is outside this
  protection; do not enter secrets or other credentials.
- `BrowserClose` is idempotent. It reports closure only after the page, context,
  Chromium connection, broker listener, and every tracked broker socket are confirmed
  quiescent. Recent closes retain bounded broker diagnostics; older confirmed closes
  remain recognizable through authenticated session handles without retaining
  unbounded state.

Each Pi session owns at most **one live, non-suspended browser**, with multiple owned
tabs. Its session/tab handles remain usable across completed turns, model thinking,
ordinary idle, and automatic/manual/ask-reviewer reviews until `BrowserClose`.
Duplicate or concurrent `BrowserOpen` never creates or replaces an instance: it gives
instructions for the existing session (`BrowserTabs`/`BrowserNavigate`/`BrowserClose`),
or asks you to await the already-running open.

Reviews do **not** establish browser quiescence: page scripts, timers, and permitted
network effects can continue during review. Call `BrowserClose` when that is no longer
desired. Explicit close and terminal Pi shutdown, reload, replacement, or worker process
shutdown drain operations and close all browser/broker resources. Unrecoverable safety
failures may also close the browser. Unconfirmed teardown fails closed for the remainder
of that runtime. Browser state is process-local and never survives a restart.

There is no password/file entry, upload, download saving, clipboard, filesystem-path
input, caller-provided selector, XPath, coordinate action, caller-supplied JavaScript/
evaluate, forced action, arbitrary action option, CDP, or permission API. Interactions
resolve only extension-issued semantic refs internally. Navigation, popup, dialog, and download
observers are armed before dispatch. Popup tabs stay in the same ownership/broker bound
and are never auto-switched; overflow popups are closed. Unexpected downloads are
canceled, and confirm/prompt/beforeunload dialogs are default-dismissed so they cannot
hang an action. Service workers, external protocols, media, permissions,
direct QUIC/WebRTC, and proxy bypass are disabled. This initial observational implementation also disables images and
custom/downloadable fonts in Chromium itself and blocks image/font requests at routing;
no visual resource is allowed to bypass broker accounting through a generated `data:`
or `blob:` URL.

Everything returned from a page — snapshot text, accessible names, title, URL, and
pixels — is labeled **untrusted evidence**. It must never be treated as an instruction
or as a tool handle supplied by the extension. Screenshots can contain private or
sensitive information already rendered in the page; request only the smallest useful
scope and do not assume visual text is safe. Image bytes appear only in Pi's native
image content (and consequently Pi's own conversation/session representation), never in
review-gate details, error diagnostics, caches, or paths. Metadata is bounded to the
session/tab/generation, bounded URL/title, mode/ref, MIME type, dimensions, encoded byte
count, and hard limits. Session/tab handles are non-enumerable capabilities; forged,
cross-session, and cross-tab combinations are rejected uniformly. Authenticated closed
session handles receive a bounded closure reason and instructions to open a new browser;
older evicted closure diagnostics are not invented. Semantic refs
are process-local capabilities scoped to one session, tab, current document generation,
and latest successful snapshot.

Console and network rings are also process-local and memory-only. They are allocated per
owned tab, bounded when each event is captured, never written to caches or review-gate
evidence stores beyond the bounded tool result itself, and cleared on tab close, session
teardown, or extension shutdown. Diagnostic reads are serialized with existing browser
actions, consume the existing operation budget, honor cancellation and deadlines, and
do not navigate, mutate the document generation/page state, create requests, or widen
broker permissions. Ring overflow and result pagination are never silent: dropped and
truncated counts accompany every read.

Literal-echo protection retains at most 1,024 distinct nonempty strings and 65,536
UTF-16 code units per browser-manager owner, across tabs and browser close/reopen.
The registry is never persisted or sent as telemetry. It is not evicted while that
owner exists: exhaustion rejects further value dispatch rather than forgetting older
values. Selected-option inspection is capped at 512 options. Ordinary observations
remain available; matching text is replaced, not the whole page. Very short inputs
can redact common text; opaque refs, structural role tokens, and typed protocol fields
are preserved. This protects complete literal matches, not page encodings, escaping,
transformations, fragments, screenshot pixels, previously returned evidence, or native
Pi/provider input/conversation retention. It must not be presented as credential-safe
browsing or as guaranteed erasure. The registry ends when its owning manager is discarded,
not at a turn/review boundary.

Resource and action limits remain hard and finite: one browser per Pi session, 4 tabs, 12
explicit navigations/history traversals, 64 operations, 32 retained history entries per
tab, 32 main-document requests, 16 destination hosts,
96 connections, 256 broker requests, 8 MiB per connection, and 32 MiB aggregate bytes.
Each open/navigation and confirmation-capable interaction has one 30-second end-to-end
deadline; each other action or snapshot has one 10-second end-to-end deadline. All
phases share that one absolute timer and never receive fresh timers. A deadline race
is not cancellation: pending browser commands (including preflight and tab switching)
are contained through browser/broker teardown and a bounded drain before operation
serialization is released. Parallel inspection groups retain all issued sibling reads
until settlement, even when one read rejects; a rejected child cannot hide pending work.
Cleanup can therefore extend the caller's elapsed time
beyond the action deadline. Unsettled work reports unknown effects, never rollback.
Ordinary invalid/stale capability validation and harmless screenshot mode/ref argument
mistakes do not themselves retire a healthy session.
There is no browser idle or elapsed-lifetime expiry. Interactive CONNECT tunnels are
retained through ordinary idle because the broker cannot distinguish encrypted HTTPS
from live WSS traffic. Ordinary plain-HTTP destination sockets still have a 20-second
idle eviction without closing the browser or cancelling a pending permission prompt.
Hard resource budgets and terminal cleanup still apply to all transports, and new
connections undergo fresh DNS validation and pinned dialing. No page action is
automatically replayed. Redirect chains are capped at 10 hops and semantic output at
24,000 characters and depth 16. Console and network rings retain at most
128 and 256 events per tab respectively; each read returns at most 64. Console/error text
is captured at 1,000 characters, source origins at 300, inspect names/descriptions/text at
256/512/512, and every cap has explicit truncation accounting. A screenshot is capped at 2,000×2,000,
4,000,000 decoded pixels, 4 MiB of final encoded PNG data, and a conservative 32 MiB
allocation charge covering decoded RGBA, encoded bytes, and the Pi base64 image-content
string. Both viewport/element bounds and the decoded final PNG are checked; an oversized
or malformed final result is discarded and fails the session closed before image
content is created. Budgets are cumulative for the whole session, not reset by
navigation.

Action cancellation, terminal session shutdown, browser crashes, and hard broker
policy/budget failures immediately begin deadline-bounded teardown. Ordinary socket
idle eviction is not a fatal budget notification. Interaction failures distinguish
`not_started`, `started`, `completed`, and `unknown` effect states where available and
never claim that cancellation rolled back a page or external effect. Successful results
use a bounded post-dispatch accounting window, drain containment work added during that
window, and describe absent navigation/downloads as `not_observed` rather than proving
that a later page effect cannot occur. Shutdown also aborts and awaits
any `BrowserOpen` still in startup, permanently rejects new opens, and preserves any
unconfirmed startup teardown as a shutdown error. If any close step times out or
quiescence cannot be proven, the tool returns an error saying closure is unconfirmed; it
never turns an attempted close into a false closed claim. Screenshot cancellation also
fails closed and completes this teardown before returning. Call `BrowserClose` as soon
as the evidence is collected; on success it deterministically confirms browser and
broker cleanup, and it is safe to repeat.

Interactive Browser failures throw bounded, sanitized errors so Pi's native outer
`toolResult.isError` is true. They contain text only, never screenshots or raw page/
Playwright exceptions. `BrowserExtract` and `WebFetch` keep their existing result contract.
The real-runtime regression in `tests/browser-native-error.test.ts` accepts
`PI_BROWSER_AGENT_RUNTIME` pointing to an installed Pi agent-core `dist/index.js`
(tested with 0.85.0); its model stream is entirely mocked, with no live model calls.
Without that runtime path the optional contract test is explicitly skipped.

The interactive tools are registered only through the Pi extension surface and are
authorized but inactive initially when deferred tools are enabled. Use `search_tools`
with the exact tool name to load one. `BrowserScreenshot` checks the current Pi model's
input contract before capture; when image input is unavailable (or the host does not
provide a model capability contract), it returns a clear error and directs the caller
back to `BrowserSnapshot` rather than creating bytes Pi cannot deliver. Top-level and
execute Pi roles receive `BrowserConsole`, `BrowserNetwork`, `BrowserInspect`,
`BrowserHover`, `BrowserClick`, `BrowserFill`, `BrowserType`,
`BrowserSelect`, and `BrowserPress`; research Pi roles receive observational
`BrowserConsole`, `BrowserNetwork`, `BrowserInspect`, and `BrowserHover` but none of the click/form-action tools. Authorized names appear in each
role's deterministic names-only system-prompt inventory while schemas
remain deferred. The generic deferred matcher, ranking, limits, and guidance are shared
unchanged with all other tools.
External Claude and Codex adapters retain their existing native web-tool policies.

### Browser interaction approval

`/review-settings` → **Web** → **Browser interaction approval** controls only the
existing confirmation-required branch for authorized `BrowserClick`, `BrowserFill`,
`BrowserType`, `BrowserSelect`, and `BrowserPress`:

- **Ask** (default) uses Pi's interactive confirmation prompt. Denial, cancellation,
  unavailable UI, or no-UI/background execution rejects that branch.
- **Automatically Accept** supplies policy approval without invoking UI, including in
  authorized native workers. It still issues the same short-lived, single-use permit
  and consumes it only after immediate ref/target/consequence and value-digest/key
  revalidation. It does not pretend a human confirmed the action.
- **Automatically Deny** rejects that branch without prompting or dispatching the
  requested interaction. It is not a browser-wide read-only switch.

Already-permitted observations, controlled ordinary navigation, and
structurally proven local edits remain permitted in all three modes. No mode grants
research-role click/form authority or removes password/file/clipboard and other hard
restrictions, SSRF/broker controls, revalidation, or value-secrecy protections. Approval
is not a guarantee that page code is safe or that an action has no remote effects.

Successful interaction details include `approval: "not_required"`, `"human"`, or
`"automatic"`. The compatibility field `confirmed` is true only for interactive human
confirmation; automatic approval returns `confirmed: false`. Text reports both fields.
Save applies to subsequent local approval decisions in existing sessions; it does not
revisit in-flight approval requests or actions already dispatched. Native workers load
settings once at extension startup:
new launches use the saved policy, while running worker sessions keep their launch
values. The setting does not change external adapters' native browser policies.
Invalid config values reject loading; see [Configuration](configuration.md#web-fields).

## Page cache

The page cache is bounded by entry count and total bytes and is force-removed on
session/application shutdown. Shutdown also removes settled subtask wave roots,
completed execution manifests, and review bundles; only genuinely unlanded recovery
checkpoints are preserved for exact-session restart (see [Recovery](recovery.md)).

## Standalone web CLI

For independent manual testing, use the same implementation outside Pi:

```bash
./scripts/pi-review-web.sh search "largest US cities census wikipedia" --max-results 10
./scripts/pi-review-web.sh fetch https://en.wikipedia.org/wiki/List_of_United_States_cities_by_population
./scripts/pi-review-web.sh fetch https://en.wikipedia.org/wiki/List_of_United_States_cities_by_population --find Phoenix
./scripts/pi-review-web.sh fetch https://en.wikipedia.org/wiki/List_of_United_States_cities_by_population --index 36
./scripts/pi-review-web.sh fetch https://en.wikipedia.org/wiki/List_of_United_States_cities_by_population --index 36 --columns 'Municipality,2025estimate'
./scripts/pi-review-web.sh browser-extract https://example.com/javascript-application --find 'Rendered result'
```

The CLI emits versioned JSON. `batch` accepts NDJSON and keeps one cache alive across
all requests in that process, which is useful for independently proving that indexed
continuation is a cache hit.
