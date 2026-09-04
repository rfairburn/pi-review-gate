# Web tools

This page owns the native web research tools: `WebSearch`, `WebFetch`,
`BrowserExtract`, and the observational interactive-browser tools, their cache and
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

## Observational interactive browser

Use the least-powerful acquisition method that works: `WebSearch` discovers sources,
`WebFetch` reads ordinary documents, `BrowserExtract` renders one dynamic page and
immediately closes it, and only then should a Pi-native orchestrator or worker open a
short-lived interactive session. The initial session surface is deliberately read-only:

- `BrowserOpen` creates one isolated context and tab, navigates to a public HTTP(S) URL,
  and returns opaque random session, tab, and document-generation handles.
- `BrowserNavigate` navigates that tab, including public redirects. Every navigation
  invalidates all semantic refs from the previous document generation.
- `BrowserSnapshot` returns a bounded Playwright accessibility/ARIA snapshot. Any refs
  are replaced with opaque generation-scoped refs; truncation and original/returned
  character counts are explicit. A successful snapshot replaces the current ref set.
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
- `BrowserHistory` lists at most 32 session-local entries or performs back, forward, or
  reload. Traversal consumes the same cumulative navigation budget. A new document
  generation invalidates that tab's refs; hash-only same-document traversal retains
  them.
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
- `BrowserClose` is idempotent. It reports closure only after the page, context,
  Chromium connection, broker listener, and every tracked broker socket are confirmed
  quiescent. Recent closes retain bounded broker diagnostics; older confirmed closes
  remain recognizable through authenticated session handles without retaining
  unbounded state.

There is no click, typing, form submission, upload, download, caller-provided selector,
XPath, coordinate action, caller-supplied JavaScript/evaluate, CDP, or permission API.
Element operations resolve only extension-issued semantic refs internally. Popups never
escape session ownership and are closed when the four-tab bound is full. Service workers, WebSockets,
external protocols, media, downloads, permissions, direct QUIC/WebRTC, and proxy bypass
are disabled. This initial observational implementation also disables images and
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
stale, cross-session, and cross-tab combinations are rejected uniformly. Semantic refs
are process-local capabilities scoped to one session, tab, current document generation,
and latest successful snapshot.

Limits are hard and finite: at most 4 process-local sessions, 4 tabs per session, 12
explicit navigations/history traversals, 64 operations, 32 retained history entries per
tab, 32 main-document requests, 16 destination hosts,
96 connections, 256 broker requests, 8 MiB per connection, and 32 MiB aggregate bytes.
Each open/navigation has one 30-second end-to-end deadline and each other action or
snapshot has one 10-second end-to-end deadline; phases do not receive fresh timers.
Idle sessions are capped at 60 seconds, total lifetime at 5 minutes, redirect chains at 10 hops, and
semantic output at 24,000 characters and depth 16. A screenshot is capped at 2,000×2,000,
4,000,000 decoded pixels, 4 MiB of final encoded PNG data, and a conservative 32 MiB
allocation charge covering decoded RGBA, encoded bytes, and the Pi base64 image-content
string. Both viewport/element bounds and the decoded final PNG are checked; an oversized
or malformed final result is discarded and fails the session closed before image
content is created. Budgets are cumulative for the whole session, not reset by
navigation.

Cancellation, session shutdown, browser crashes, expiry, and broker policy/budget
failures immediately begin deadline-bounded teardown. Shutdown also aborts and awaits
any `BrowserOpen` still in startup, permanently rejects new opens, and preserves any
unconfirmed startup teardown as a shutdown error. If any close step times out or
quiescence cannot be proven, the tool returns an error saying closure is unconfirmed; it
never turns an attempted close into a false closed claim. Screenshot cancellation also
fails closed and completes this teardown before returning. Call `BrowserClose` as soon
as the evidence is collected; on success it deterministically confirms browser and
broker cleanup, and it is safe to repeat.

The interactive tools are registered only through the Pi extension surface and are
authorized but inactive initially when deferred tools are enabled. Use `search_tools`
with the exact tool name to load one. `BrowserScreenshot` checks the current Pi model's
input contract before capture; when image input is unavailable (or the host does not
provide a model capability contract), it returns a clear error and directs the caller
back to `BrowserSnapshot` rather than creating bytes Pi cannot deliver. Top-level,
execute, and research Pi roles receive all nine observational operations above; no
interaction operations are part of the role policy. Their names appear in each role's
deterministic names-only system-prompt inventory while schemas remain deferred.
External Claude and Codex adapters retain their existing native web-tool policies.

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