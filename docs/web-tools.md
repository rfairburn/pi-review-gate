# Web tools

This page owns the native web research tools: `WebSearch`, `WebFetch`, and
`BrowserExtract`, their cache behavior, and the standalone web CLI. Config fields and
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