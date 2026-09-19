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

`WebFetch` downloads and indexes the complete selected HTML page, PDF, or non-HTML
text response, but returns only a bounded structural range. Its result includes
`nextIndex` when more blocks remain. HTML results include a whole-page table inventory,
possible site-pagination URLs, and `dynamic_content_suspected`; PDF results preserve
page numbers, expose document metadata, and identify likely scanned/image-only files
when little or no text can be extracted.

- Responses declared as non-HTML text (for example `application/json` or `text/plain`)
  are indexed verbatim as bounded text blocks with the declared content type disclosed:
  JSON and plain-text payloads stay readable and searchable, and angle-bracket sequences
  in them are never interpreted as markup — including raw HTML source served as
  `text/plain`, which remains literal text. BrowserExtract's rendered output is always
  parsed as HTML regardless of the main response's declared type, and bodies with a
  missing content type that begin like an HTML document are parsed as HTML; other
  HTML-declared responses without parseable structure fall back to the same verbatim
  text indexing when they carry readable text.
- Empty bodies, undecodable (non-text) bodies, comment-only or otherwise
  structure-less HTML, and pages made only of non-renderable markup fail with an
  explicit bounded diagnostic instead of a silent empty result or an internal parser
  error; script-only shells report the usual `dynamic_content_suspected` escalation.

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
  the limit — except while the model popup restriction override is enabled, which
  adopts over-limit page-created popups as owned tabs instead, or when a visibility
  or service-worker replacement re-adopts the previously owned tab set it replaced
  (see [Browser permissions](#browser-permissions-issue-27)). Refused popups remain tracked until closure is confirmed, and a tab whose
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
  File controls are rejected; password/credential fields are gated by the
  `modelCredentialEntry` permission for Fill/Type and non-activation Press (see
  [Browser permissions](#browser-permissions-issue-27)). A structurally proven unsent local edit may
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
- `BrowserUpload` uploads one to 32 explicitly chosen host files into one file
  input identified by a fresh opaque semantic ref. Source paths are absolute, or
  relative to the session working directory, and must resolve to regular files;
  they are verified (real path, size, mtime) before approval, bound into the
  single-use permit digest, and re-verified after approval. The page supplies only
  the file-input target — it never sees or chooses source paths — and file content
  never appears in results, prompts, logs, or snapshots (counts and byte sizes
  only). It requires `web.browserPermissions.modelUploads` (default off; YOLO
  overrides) and always follows the Browser interaction approval policy: an upload
  is always consequential because host bytes leave the machine. Human file input in
  a visible browser is unaffected by the permission.
- `BrowserDownloadSave` lists this tab's retained pending downloads, or saves one
  to an explicitly chosen destination (absolute, or relative to the session working
  directory), wherever the model's existing host write authority reaches — the
  browser adds no workspace fence of its own:
  omitting both `download` and `destination` lists; providing exactly one is
  rejected. While `web.browserPermissions.modelDownloadSaving` (default off; YOLO
  overrides) is enabled, a download triggered by an approved action is retained
  under an opaque handle bound to the session and tab (at most
  `web.browserDownloadRetention` per session, default **8**; **0** disables
  count-based eviction entirely; at a finite cap the oldest is canceled and
  released when a new download arrives — after a live lowering, several at
  once) instead of canceled — its bytes stay in
  Playwright's private temporary storage until saved or released. Saving requires
  a completed download, destination verification against the real path (so a
  symlinked destination is approved at its true location) before and after
  approval, and the interaction-approval policy; replacing an existing file is
  stated in the prompt and created overwrite-race-safely. Actual platform/role
  write restrictions are enforced by the host filesystem at save time and reported
  honestly; no destination is assumed writable. Page-suggested filenames are
  untrusted metadata and never choose or authorize a destination. While the
  permission is off, downloads are canceled as they occur exactly as before and
  nothing is retained.
- `BrowserClipboard` reads or replaces the text on the browser clipboard of one
  owned tab (text only — no binary or image formats, no file paste, and no
  arbitrary native clipboard command). It requires
  `web.browserPermissions.modelClipboard` (default off; YOLO overrides) and
  always follows the Browser interaction approval policy: while disabled it is
  denied before any approval prompt with a precise error naming the disabled
  permission. The manager issues a real per-origin Playwright permission grant
  for the exact origin of the approved operation — never a context-wide or
  cross-session capability — re-checks the live permission after approval, and
  revokes every issued grant immediately when the permission is turned off.
  Untrusted page content cannot grant or toggle this capability. Headless
  Chromium operates on its per-instance virtual clipboard (writes do not reach
  the host pasteboard); headed desktop Chromium reaches the host system
  clipboard; each result reports which scope was used. Read text is bounded,
  returned as untrusted evidence, and becomes model-visible content; write
  values are bound to approval by digest and length only and are never echoed
  in results or prompts.
- `BrowserClose` is idempotent. It reports closure only after the page, context,
  Chromium connection, broker listener, and every tracked broker socket are confirmed
  quiescent. Recent closes retain bounded broker diagnostics; older confirmed closes
  remain recognizable through authenticated session handles without retaining
  unbounded state.

Each Pi session owns at most **one live, non-suspended browser**, with multiple owned
tabs. Its session/tab handles remain usable across completed turns, model thinking,
ordinary idle, and automatic/manual/ask-reviewer reviews until `BrowserClose` or
configured tool-inactivity expiry (15 minutes by default).
Duplicate or concurrent `BrowserOpen` never creates or replaces an instance: it gives
instructions for the existing session (`BrowserTabs`/`BrowserNavigate`/`BrowserClose`),
or asks you to await the already-running open.

Reviews do **not** establish browser quiescence: page scripts, timers, and permitted
network effects can continue during review. Call `BrowserClose` when that is no longer
desired. Explicit close and terminal Pi shutdown, reload, replacement, or worker process
shutdown drain operations and close all browser/broker resources. Unrecoverable safety
failures may also close the browser. Unconfirmed teardown fails closed for the remainder
of that runtime. Browser state is process-local and never survives a restart.

Model credential entry exists only under the `modelCredentialEntry` permission,
model file transfer exists only as `BrowserUpload` and `BrowserDownloadSave`, and
model clipboard access exists only as `BrowserClipboard`
(see [Browser permissions](#browser-permissions-issue-27)); there is no
filesystem-path input, caller-provided selector,
XPath, coordinate action, caller-supplied JavaScript/evaluate, forced action,
arbitrary action option, CDP, or permission API. Interactions
resolve only extension-issued semantic refs internally. Navigation, popup, dialog, and download
observers are armed before dispatch. Popup tabs stay in the same ownership/broker bound
and are never auto-switched; overflow popups are closed, except that the model popup
restriction override adopts over-limit page-created popups as owned tabs (see
[Browser permissions](#browser-permissions-issue-27)). While model download saving is
disabled (the default) unexpected downloads are canceled; with it enabled they are
retained under opaque handles for `BrowserDownloadSave` instead. Confirm/prompt/beforeunload
dialogs are default-dismissed so they cannot
hang an action. Service workers are blocked by default and allowed only under the
model service-worker permission; external protocols, direct QUIC/WebRTC,
and proxy bypass remain disabled. Interactive images, downloaded fonts, media, SSE,
and HTTP beacons use protected broker networking. Local `data:`/`blob:` rendering is
allowed; those URLs do not themselves open network connections. Dedicated, shared,
and (when enabled) service workers retain broker-only egress. Site CSP, CORS, TLS
checks and user-gesture media playback policy remain in force. This is a QA browser,
not unrestricted computer use; window visibility is a user-side setting (below),
and camera/microphone/geolocation access under their permissions follows the same
broker boundary.

### Browser visibility

`/review-settings` → **Web** → **Browser visibility** selects **Headless** (default,
no window) or **Headed** (a real browser window with a native address bar). The model's
tool set and exposure are identical in both modes, and there is no model-facing
visibility control.

Saving a changed visibility applies it **immediately to the live browser**; the pinned
Playwright runtime selects the headless-shell or headed binary at launch, so a running
browser cannot switch modes in place. The save therefore performs a controlled
replacement through the ordinary ownership path: in-flight browser operations are
cancelled and settled, the old browser is closed and torn down quiescently with fresh
per-session egress-broker credentials in the replacement, and no duplicate or orphan
browser is created. Saving with no open browser applies the preference at the next
`BrowserOpen`; saving the already-active mode is idempotent and restarts nothing.
A saved service-worker policy change takes this same path, because Chromium pins
that mode at context creation too: a live browser is replaced when either launch-
pinned setting differs from the saved policy, and only then. **Cancel** in the
settings menu never relaunches anything.

The replacement restores, best-effort and in the original order, every actual context
tab (including human-opened popups and popup tabs adopted under the model popup
restriction override) by re-navigating its recorded
URL through the same effective egress policy, re-applies the manager-issued per-origin
permission grants that still pass the current effective policy, and it makes the intended tab active again — when
the real window's foregrounded tab can be detected and differs from the model's
recorded active tab, the foregrounded tab wins. Cookies, localStorage, and IndexedDB
are replayed from memory via the context storage-state object; nothing touches disk,
no persistent profile is created, and state values never appear in results, logs, or
diagnostics (only counts). This replay is **memory-only and best-effort: there is no
lossless guarantee**. Auth-dependent pages can still redirect to a login page; each
tab reports its requested and final URL, mismatches, unrestorable URLs (including
intended-tab information for URLs that no longer pass the current egress policy —
public-only by default, with local-network destinations only under the `localNetworks`
or YOLO permission — which are never re-navigated), failed restores, and pages beyond the tab cap. Old
session/tab/ref handles are invalidated and rejected; the save notice reports the
replacement session and tab handles for the model's next operation. Irreversible form
submissions are not replayed, and no DOM or history state is fabricated. Setting the
idle expiry to `0` is recommended when working hands-on in a headed window so the
browser cannot disappear mid-interaction. See
[Configuration](configuration.md#web-fields).

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
owned tab with shared session-wide count/byte quotas, bounded when each event is captured,
never written to caches or review-gate
evidence stores beyond the bounded tool result itself, and cleared on tab close, session
teardown, or extension shutdown. Diagnostic reads are serialized with existing browser
actions, renew tool activity, honor cancellation and deadlines, and
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

Active resource limits remain hard and finite: one browser per Pi session, 4 tabs,
32 retained history entries per tab, 64 simultaneous broker client connections and
64 simultaneous upstream connections. Interactive browsing has no cumulative host,
connection, request, navigation, action, main-document-request, or transferred-byte
quota. `navigationsRemaining` and disabled lifetime limit fields are `null`.
Capacity returns on close; an excess connection is refused locally without retiring a
healthy session. Diagnostic results expose a bounded scalar `brokerCapacityRefusals`
(session-wide, not attributed to the queried tab). Streaming retains backpressure,
not whole responses; this does not bound Chromium page memory. Extraction limits are
unchanged.
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
Browser tool inactivity expires the session after `web.browserIdleExpiryMinutes`
(default 15; configurable under `/review-settings` → Web, where 0 disables idle close
so only explicit close, shutdown, replacement, or unrecoverable failure ends the
session). Detectable genuine human input in the live page — browser-trusted pointer
presses, keyboard input, and wheel scrolling — also resets a nonzero timer, through
a manager-owned bridge that reports only events Chromium marks trusted (`isTrusted`)
and authenticates each signal with a single-use HMAC token; page script cannot mint
or replay tokens, so script alone can never keep the lease alive. Page-script
`dispatchEvent`, fabricated trusted clicks such as `element.click()`, programmatic
scrolling, DOM mutations, timers, animation, and background requests/WebSockets are
never treated as human input. No input values, keys, or element contents are
collected. Detection is per tab and per document: an adopted popup or newly opened
tab is covered from its next navigation, and documents in cross-origin (out-of-process)
iframes are not covered; both gaps fail toward less renewal, never toward spoofing.
Detection is deliberately partial and never claimed otherwise: input
outside the page surface (address bar, window controls, scrollbar drags, OS-level
activity) and navigation by itself are not attributed, and model-driven Playwright
input travels the same trusted pipeline, renewing like model tool activity always
has. For hands-on human use, set the timeout to `0` so the browser cannot disappear
mid-interaction. Background scripts, requests and WebSockets do not renew expiry, and
active operations/approval waits are protected. Expired handles explicitly require
`BrowserOpen`; state is not recreated.
There is no elapsed browser-lifetime deadline or established-stream idle eviction.
Pre-authentication connection deadlines and concurrent capacity still apply, and new
connections undergo fresh DNS validation and pinned dialing. No page action is
automatically replayed. Redirect chains are capped at 10 hops and semantic output at
24,000 characters and depth 16. Console and network rings retain at most
256 events and 1 MiB of sanitized UTF-8 serialized data per channel across the whole
session, with tab-isolated reads; each read returns at most 64. Oldest captures are
evicted by count or bytes with truthful dropped cursors. Broker closed history retains
256 entries plus at most 64 active entries, disclosing pruned history separately. Console/error text
is captured at 1,000 characters, source origins at 300, inspect names/descriptions/text at
256/512/512, and every cap has explicit truncation accounting. A screenshot is capped at 2,000×2,000,
4,000,000 decoded pixels, 4 MiB of final encoded PNG data, and a conservative 32 MiB
allocation charge covering decoded RGBA, encoded bytes, and the Pi base64 image-content
string. Both viewport/element bounds and the decoded final PNG are checked; an oversized
or malformed final result is discarded and fails the session closed before image
content is created. Individual output limits are not relaxed by sustained sessions.

Action cancellation, terminal session shutdown, browser crashes, and hard broker
security-policy failures immediately begin deadline-bounded teardown. Capacity-only
refusals are nonfatal. Interaction failures distinguish
`not_started`, `started`, `completed`, and `unknown` effect states where available and
never claim that cancellation rolled back a page or external effect. Successful results
use a bounded post-dispatch accounting window, drain containment work added during that
window, and describe absent navigation/downloads as `not_observed` rather than proving
that a later page effect cannot occur. Shutdown also aborts and awaits
any `BrowserOpen` still in startup, permanently rejects new opens, and preserves any
unconfirmed startup teardown as a shutdown error. If any close step times out or
quiescence cannot be proven, the tool returns an error saying closure is unconfirmed; it
never turns an attempted close into a false closed claim. Local Chromium gets 5 seconds
for graceful close, then the retained verified-owned Playwright process handle is used
for forced termination, with up to 5 additional seconds for verification (plus 100 ms
outer scheduling allowance). This retains the local isolated-selector transport; no
process-name scanning or arbitrary PID termination is used. OS process disappearance,
not just connection state, is checked. Unsupported ownership bridges fail closed.
Screenshot cancellation also
fails closed and completes this teardown before returning. Call `BrowserClose` as soon
as the evidence is collected; on success it deterministically confirms browser and
broker cleanup, and it is safe to repeat.

Interactive Browser failures throw bounded, sanitized errors so Pi's native outer
`toolResult.isError` is true. They contain text only, never screenshots or raw page/
Playwright exceptions. Manager-owned failures carry a structured failure phase
(`url_validation`, `broker_admission`, `chromium_startup`, `context_creation`, or
`navigation`) and a safe category such as `dns_resolution_failed`,
`non_public_address_denied`, `budget_exhausted`, or `browser_process_failure`; browser
tool errors report them as fixed text like `phase=...; category=...` with bounded
per-category guidance. This keeps a distinct-host budget exhaustion on a content-rich
page distinguishable from an ambiguous network error, and unstructured failure text never
claims a proven authorization denial. `BrowserExtract` and `WebFetch` keep their existing
result contract.
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
`BrowserSelect`, `BrowserPress`, `BrowserUpload`, `BrowserDownloadSave`, and
`BrowserClipboard`; research Pi roles receive observational
`BrowserConsole`, `BrowserNetwork`, `BrowserInspect`, and `BrowserHover` but none of the click/form-action tools. Authorized names appear in each
role's deterministic names-only system-prompt inventory while schemas
remain deferred. The generic deferred matcher, ranking, limits, and guidance are shared
unchanged with all other tools.
External Claude and Codex adapters retain their existing native web-tool policies.

### Browser interaction approval

`/review-settings` → **Web** → **Browser interaction approval** controls only the
existing confirmation-required branch for authorized `BrowserClick`, `BrowserFill`,
`BrowserType`, `BrowserSelect`, `BrowserPress`, `BrowserUpload`,
`BrowserDownloadSave`, and `BrowserClipboard`:

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
Invalid config values reject loading; see [Configuration](configuration.md#web-fields). The separate **Browser permissions** submenu (#27) adds independently selectable capabilities and the YOLO master override on top of this per-action policy; see [Browser permissions](#browser-permissions-issue-27).

### Browser permissions (issue #27)

`/review-settings` → **Web** → **Browser permissions** exposes the independently
selectable capability toggles from
[#27](https://github.com/rfairburn/pi-review-gate/issues/27): model credential
entry, credential submission, uploads, download saving, clipboard read/write,
camera, microphone, geolocation, service workers, popup restriction override,
local networks (human and model), and the **YOLO / allow everything** master
override. They are a-la-carte booleans — there is no security-level ladder or
role scheme — and every one defaults off, so current behavior is unchanged until
a capability is explicitly enabled.

The pure effective policy (`effectiveBrowserPolicy` in
`src/web/browser-capabilities.ts`) computes what each stored setting means:

- **YOLO** enables the complete agreed capability set and bypasses per-action
  approval prompts, including an otherwise configured Ask or Automatically Deny
  policy; it never silently leaves a supposedly disabled restriction in force.
  YOLO-approved actions are automatic approvals and must never be reported as
  human-confirmed. Enabling requires the explicit interactive confirmation
  described in [Configuration](configuration.md#web-fields); disabling is
  straightforward and restores the saved individual values as effective.
- **Model-only toggles** constrain model actions only. Human credential/form
  submission and file uploads remain allowed regardless of them, and browser
  visibility stays independent of tool availability/exposure.
- **Upload/download selection and side effects** follow the existing Ask /
  Automatically Accept / Automatically Deny interaction-approval policy; no
  mandatory human file picker is introduced.
- **Local networks** applies to human and model navigation alike and covers
  loopback, private, and link-local addresses including cloud metadata endpoints;
  enabling it presents a prominent warning about SSRF-style access to local
  services and instance metadata.
- **Service workers and popup override** grant capability only: they do not force
  registration, activation, or new popups. With both off (the default),
  service workers are blocked at context creation and page-created popups stay
  inside the four-tab session limit.

Browser host/session ownership and the authenticated control transport are
preserved: these settings grant no cross-session or arbitrary host-command
authority, and unsupported capabilities require real implementation before any
runtime claims them.

**Enforced today:** `modelCredentialEntry` and `modelCredentialSubmission` gate
the interactive-browser tool actions. While disabled (the default), a model
Fill/Type into a password-type field — or an explicit current/new-password
autocomplete field — is denied before any approval prompt, as is a model click
on a native submit control or activation-key press on a form that structurally
contains credentials; each denial names the disabled permission and notes that
human browser input is unaffected. Detection is structural only: no field value
is read, echoed, or compared, so a human-entered password is gated exactly like
a model-entered one. Non-credential forms and navigation to authenticated
routes are not gated by these capabilities; they follow the ordinary interaction
approval policy, and there is no blanket denial of authenticated browsing. With
the permissions enabled, the same actions proceed through the existing Ask /
Automatically Accept / Automatically Deny flow with one-use revalidated permits;
YOLO approves them automatically and never as human-confirmed. Settings saved
through `/review-settings` apply to the live session for these two capabilities.

`localNetworks` (and YOLO, which enables it) is enforced at the interactive
egress broker and navigation preflight: while disabled (the default), loopback,
private, link-local, and cloud-metadata destinations are refused before any
request or dial — for initial navigation, model and human address-bar
navigation, page-initiated requests, main-document redirects, adopted popups,
and page-created WebSockets alike. While enabled, the same admissions proceed
with the identical resolve-once-and-pin validation applied to every resolved
address. Settings saved through `/review-settings` apply to live sessions
without a restart; disabling revokes only the established local connections
(the browser keeps running) and refuses subsequent local admissions.
`WebFetch` and `BrowserExtract` remain public-only regardless of this setting.

`modelUploads` and `modelDownloadSaving` are enforced by `BrowserUpload` and
`BrowserDownloadSave`: while disabled (the default), those tools are denied
before any approval prompt with a precise error naming the disabled permission,
and no file is read, sent, staged, or written; human file input and downloads in
a visible browser are unaffected. With the permissions enabled, uploads and
saves proceed through the existing Ask / Automatically Accept /
Automatically Deny flow with one-use revalidated permits bound to the exact
source files, or the download handle and verified destination; YOLO approves
them automatically and never as human-confirmed. Download saving resolves
destinations against the model's existing host write authority (relative paths
resolve to the session working directory; absolute paths are not fenced by the
browser), binds the exact real destination into the one-use approval, and releases
retained staged artifacts on save, capability revocation, or session teardown.
Settings saved through `/review-settings` apply to the live session for these
capabilities; revoking download saving cancels and drops every retained pending
download immediately.

`modelClipboard` is enforced by `BrowserClipboard`: while disabled (the
default), both clipboard operations are denied before any approval prompt with
a precise error naming the disabled permission, and no per-origin browser
permission grant is issued. With it enabled, reads and writes proceed through
the existing Ask / Automatically Accept / Automatically Deny flow with one-use
revalidated permits bound to the exact session, tab, generation, origin,
operation, and — for writes — a digest and length of the exact text; YOLO
approves them automatically and never as human-confirmed. The manager issues a
real Playwright permission grant for the approved operation's origin only —
the capability is per-origin, never context-wide or cross-session — re-checks
the live permission after approval, and revokes every issued grant immediately
when the permission is turned off (the running browser keeps all of its other
behavior). Headless Chromium operates on its per-instance virtual clipboard;
headed desktop Chromium reaches the host system clipboard, and each result
reports which scope was used.

`modelCamera`, `modelMicrophone`, and `modelGeolocation` are enforced as real
per-origin device permission grants on the owned browser context. While
disabled (the default), no device grant is issued for any origin, so page
requests for camera, microphone, or location are denied by Chromium itself.
While enabled, the manager issues a Playwright grant scoped to that origin only
when one of its tabs commits a top-level HTTP(S) navigation there — model
navigation, adopted popups, and page-initiated navigation alike — re-evaluating
the current effective policy at every commit. The grants compose with clipboard
grants (enabling one never clears the others), YOLO enables all three,
and disabling any of them immediately revokes its per-origin grants from
every live session while leaving the other enabled grants intact. These
toggles grant capability, not forced activation: a page must still request the
device or location API itself, and no browser tool invokes these APIs on the
model's behalf — what a page does with granted access is page behavior,
bounded only by the egress policy. Whether capture actually succeeds also
depends on the host (hardware presence, operating-system privacy prompts such
as macOS camera/microphone access, and an available position source); the
manager grants permission state only, reports failures truthfully, and never
fabricates media or coordinates.

`modelServiceWorkers` is enforced at context creation: while disabled (the
default), every managed browser context is created with service workers
blocked, so registration never completes; enabling it allows registration and
activation. Chromium pins this mode at launch, so a saved change to the setting
(or to YOLO) cannot flip a live browser in place — applying the save performs
the same controlled replacement as a visibility change: the session is closed
through the ordinary ownership path and relaunched under the new policy,
restoring ordered tabs, the active page, storage state, and manager-issued
permission grants best-effort, with every loss reported. Service-worker network
traffic stays inside the existing egress boundary: worker script loads and
worker-initiated requests traverse the authenticated broker exactly like other
page traffic, under the same public-URL, DNS-pinning, and local-network
policy. One truthful limitation: Playwright's per-tab WebSocket admission,
which validates and records each socket before connect, does not observe
sockets created inside a service worker; those still egress only through the
authenticated broker, whose own pre-dial validation enforces the same
destination policy, but they do not receive the manager-side admission record.

`modelPopupRestrictionOverride` lifts the four-tab session limit for
page-created popups while enabled: a popup created by page script beyond the
limit is adopted as an owned explicit-tab handle with the full guard set
(routes, WebSocket admission, navigation policy, and broker egress) instead of
being refused and closed. Model-initiated opens remain subject to the four-tab
limit; no separate or higher popup cap is introduced. Disabling the override
does not close already-adopted popup tabs — it only refuses further over-limit
adoptions from that point on. A later visibility or service-worker replacement
still restores those previously owned tabs: the replacement re-adopts exactly
the replaced session's owned tab set (beyond the ordinary limit when the
override had admitted extra popups) and admits no new over-limit popups of its
own.

**Exfiltration boundary (truthful):** these gates constrain model-initiated
tool actions only. They do not make the managed browser a secret safe: page
scripts can read field values, submit forms through their own handlers, and use
every network channel still available to the page. The bounded memory-only
redaction registry protects literal echoes in extension result text and
diagnostics; it is not a page information-flow secrecy guarantee, and Pi/provider
conversation and session-history retention are outside its protection. Do not
enter secrets into pages that do not deserve them.

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
