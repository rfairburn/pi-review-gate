# Security model

This page owns trust boundaries, network egress hardening, read-only enforcement,
isolation limits, and secrets handling. Operational behavior is owned by the pages it
links to.

## Trust boundaries

The following environment variables are trusted-user boundaries, not safe inputs to
accept from an untrusted repository, task, or process environment:

- `PI_REVIEW_GATE_CONFIG` — config file selection (the launcher re-resolves it so an
  inherited value from a parent pi session cannot redirect the gate).
- `PI_REVIEW_GATE_DISABLED` — the documented kill switch.
- `PI_REVIEW_GATE_DDGS_VENV`, `XDG_CACHE_HOME` / `HOME` — venv and cache locations for
  the web search bridge. The default venv lives in a user-writable cache by design.
  `PI_REVIEW_GATE_DDGS_PYTHON` is exported by the wrappers from that venv, but direct
  extension invocation may supply it as a trusted interpreter override.
  `PI_REVIEW_GATE_CACHE_ROOT` is derived from `XDG_CACHE_HOME` / `HOME` inside
  `scripts/ensure-ddgs.sh`; it is not read as an environment override.
- `PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM` — install-time Chromium download skip.

The legacy `PI_REVIEW_GATE_DDGS_HELPER` variable is ignored, so an inherited value
cannot substitute an arbitrary helper; production always resolves the packaged
`scripts/ddgs-search.py` relative to the loaded extension ([Web tools](web-tools.md)).

## Web egress hardening

Every native web path (`WebFetch`, `BrowserExtract`, and bounded semantic interactive
browser sessions) is DNS-rebinding-hardened. Every
URL and every redirect hop is validated immediately before that hop is dialed: the URL
is canonicalized, credentials are rejected, and the hostname is resolved exactly once
with every returned address required to be public. The connection then dials only those
validated addresses through a pinned DNS lookup (`undici` dispatcher with a custom
`lookup`), while the request keeps the original hostname for the HTTP `Host` header,
TLS SNI, and certificate validation. A DNS answer that changes between validation and
connect cannot redirect a socket, a second resolution can never bypass the blocklist,
and per-hop dispatchers are destroyed after each download so no unpinned connection
survives.

### Egress broker containment

`BrowserExtract` routes every Chromium request through a per-render loopback egress
broker; each bounded interactive session uses exactly one authenticated broker
for its complete lifetime. Each broker is an HTTP/HTTPS CONNECT proxy bound only to
127.0.0.1 on an ephemeral port. Chromium is launched so the broker is its only network
path:

- The proxy is forced (`--proxy-server` plus `--proxy-bypass-list=<-loopback>`, which
  removes Chromium's implicit loopback bypass so even loopback/private-literal requests
  reach the broker and are refused there).
- QUIC and alternative direct transports are disabled; WebRTC is forced to
  `disable_non_proxied_udp` so peer connections cannot open direct UDP to IP literals.
- The broker accepts only this render's Chromium (per-render Basic proxy credentials
  challenged via 407).
- The host resolver is default-deny (`MAP * ~NOTFOUND`) with only the exact broker
  endpoint excluded, so speculative preconnect or direct-IP attempts can never resolve
  or connect outside the broker.

For every destination — including cross-hostname resources and redirects — the broker
canonicalizes the request or CONNECT authority, rejects credentials and non-HTTP(S)
schemes, resolves the hostname exactly once, requires every resolved address to be
public, and dials only that validated address set, with no fallback to system DNS.
Original hostname semantics are preserved: the browser keeps its `Host` header for plain
HTTP, and HTTPS traffic stays end-to-end through the CONNECT tunnel, so TLS SNI and
certificate verification remain between Chromium and the origin (the broker never
decrypts it). In one-shot `BrowserExtract` renders WebSockets are always closed; in
interactive sessions page-created `ws:`/`wss:` connections use Chromium's native
WebSocket stack through the same authenticated loopback broker (the context proxy
credentials carry the authentication): before the browser is allowed to connect, each
requested destination is validated against the public-URL policy (every address public,
no URL credentials, no harness retry or replay). The broker independently revalidates
and pins each actual connection. Chromium can tunnel both `ws:` and `wss:` through
CONNECT; the broker also supports authenticated plain HTTP WebSocket upgrades for
opted-in clients. WSS stays end-to-end TLS inside CONNECT. Neither the manager nor
broker parses WebSocket frames or retains payloads in diagnostics. Service workers are
blocked in both modes, and every outbound connection is recorded in a broker-owned
connection ledger that is audited before a `BrowserExtract` render result is returned;
that one-shot browser and its broker sockets quiesce before extraction is exposed.
Interactive browsers instead remain live across turns and reviews until explicit close
or terminal session teardown, subject to configured tool-inactivity expiry. Interactive
established streams are not idle-evicted; concurrent capacity, close, expiry and shutdown
still bound owned sockets. Local browser protocols (`about:`, `blob:`, `data:`) support
in-process rendering, including images/fonts/media; they do not themselves open network
connections. Background page traffic does not renew the tool-activity lease.

`BrowserExtract` aborts images, media, and fonts before any connection. Interactive
sessions instead allow images, downloadable fonts, media, SSE and HTTP beacons through
the same protected broker. Dedicated/shared workers retain broker-only egress; service
workers remain blocked. CSP, CORS, TLS validation, nonproxied-WebRTC restrictions,
default-deny DNS, and no-QUIC/proxy-bypass defenses are unchanged. `BrowserScreenshot` captures only the already-rendered viewport
or an element addressed by a current opaque semantic ref; it does not admit a new
network path. Bounded scroll/wait/history/form controls and every owned tab or admitted
popup stay inside the same context and authenticated broker; the four-tab cap closes
excess popups before they can become unowned. Element bounds must fit the viewport and become an immutable screenshot
clip; the capture leaves finite animations running rather than fast-forwarding them
after preflight, so a page resize cannot enlarge the requested image. Before native Pi
image delivery, both pre-capture and decoded final PNG dimensions/pixels are bounded,
final encoded bytes are capped, and a conservative
allocation charge includes decoded, encoded, and base64-content storage. Image bytes are
excluded from review-gate diagnostics/details and are retained only where Pi's native
image message itself requires them. Results disclose bounded omission diagnostics (capped samples plus
a dropped count). Extraction retains cumulative host/connection/request/byte and render
time budgets. Interactive mode instead admits at most 64 concurrent client and 64 upstream
connections, retains pre-authentication deadlines and authority/header bounds, and has
no cumulative traffic, host or operation quotas. Excess capacity refusals are local and
observable, not session-fatal; closed ledger history is bounded to 256 plus active entries,
with pruned history counted. Console/network retention is separately capped at 256 events
and 1 MiB per channel across the session. This does not bound Chromium page memory.
Interactive sessions have finite action deadlines but no elapsed browser-lifetime limit.
Close, expiry, shutdown and genuine security refusals still drain owned resources. Fresh
connections revalidate DNS; actions are never replayed automatically. Local Chromium gets
five seconds for graceful teardown before verified-owned forced termination, followed by
up to five seconds of verification. The pinned local Playwright ownership bridge preserves
isolated selectors and fails closed if unsupported; no arbitrary PID kill is permitted.
For `BrowserExtract`, a budget that destroys an in-flight transfer is nonfatal only when
the main document completed; main-document failures, non-2xx navigations, oversized
rendered HTML, and any ledger audit failure fail the render closed.

Interactive diagnostics do not add an egress path. `BrowserNetwork` observes only
capture-time-bounded method/origin/resource/status/timing/failure and available route-
policy outcomes from traffic already governed by the authenticated broker, including
metadata-only WebSocket lifecycle for page-created live connections (created when
admission is requested, closed at the terminal state reported by the browser's own WebSocket stack;
no connected state is ever claimed; close codes only where the browser exposes them;
and policy-block reasons for refused destinations); paths, queries, bodies, headers,
cookies, authorization,
post data, WebSocket frames, and cache contents are excluded. `BrowserConsole` retains only bounded redacted text and source
origin/position metadata, never argument objects, source payloads, or stacks.
`BrowserInspect` resolves only a current owned semantic ref and returns fixed bounded
accessibility/state fields using the browser-computed semantics captured with the fresh
ref and Playwright's isolated locator/accessibility primitives. Description candidates
are scoped to the ref's owning top-level or iframe document and returned only after an exact computed-description match; current
control states are read through fixed computed-role filters. It does not execute a
main-world page callback, cannot receive selectors, attribute names, coordinates,
scripts, CDP commands, or frame/shadow traversal instructions, and never reads an
editable/password value. These per-tab rings are memory-only and are cleared at tab or
session teardown and shutdown. Results are explicitly untrusted and disclose monotonic
cursors, ring drops, and capture/result truncation; reads create no requests or page
state/document-generation changes.

## Read-only enforcement

Built-in Codex, Claude, and Pi model adapters run as read-only agentic reviewers so they
can inspect the workspace and retained review bundle before deciding. Agentic reviewers
may use their native read tools or strictly read-only shell commands (`ls`, `find`, `rg`,
`grep`, `sed`, `cat`, and read-only Git commands) when the shell is their only
filesystem interface. Generic CLI reviewers remain prompt-only unless the configured
command provides its own safe read-only behavior.

For delegated workers and research subtasks:

- Pi reviewers and Pi workers are always launched with an explicit `--tools` value;
  worker values are captured from the orchestrator's active Pi tools and narrowed
  further for research. Research workers intersect the parent's active tools with a
  read-only allowlist that excludes `ApplyPatch`. Launch-authorized native read-only
  discovery (`grep`, `find`, `ls`; mapped to Claude's native `Grep`/`Glob`) is part of
  the conservative initial-active subset, so it is active from the first request in
  every operating mode and delegated role with no deferred activation step, and mode
  switches never deactivate it. Native discovery is included whenever Pi's tool
  registry permits it, even if initially inactive. `--tools`, `--exclude-tools`,
  and `--no-tools` remove disallowed names from that registry and remain authoritative.
  `--no-builtin-tools`, `defaultTools`, and SDK `noTools:'builtin'` only set initial
  activity; they do not exclude registered tools. Consequently, those settings alone
  do not keep `grep`, `find`, or `ls` inactive in review-gate. Use `--exclude-tools`
  or an explicit `--tools` allowlist to withhold them. Other inactive tools are not
  promoted. Configured worker catalogs are never expanded beyond the inherited
  durable catalog.
- Codex uses its read-only sandbox and rejects configuration that could weaken the
  research profile.
- Claude uses an explicit read-only tool allowlist and permission callback while
  disabling user settings, skills, plugins, and MCP.
- Every adapter receives a private worktree check that quarantines any detected write.
- Generic binary adapters are ineligible for research because their protocol does not
  acknowledge the restriction.

Tool restriction uses each harness's native allowlist. There is no review-gate
configuration gate for `ApplyPatch` and no `setActiveTools` re-enabling: availability
follows Pi's normal registered-tool policy, and an explicit Pi launch `--tools`
allowlist remains authoritative.

## Isolation limits

Task isolation is worktree and instruction isolation, not an OS sandbox: a hostile
custom executor process can still access paths allowed by the host account. Source
preservation and path confinement are enforced by the extension's own landing and
mutation coordination ([Delegated execution](delegated-execution.md#landing-and-source-preservation)),
not by kernel-level containment.

## ApplyPatch confinement and safety

The `ApplyPatch` tool accepts the canonical OpenAI/Codex apply_patch envelope —
`*** Begin Patch` ... `*** End Patch` with `*** Add File:`, `*** Update File:` (optional
`*** Move to:`), and `*** Delete File:` operations — in a single `patch` string argument,
and may mix multiple file operations per call. It follows the public apply_patch grammar
used by OpenAI Codex (the V4A diff contract at
https://developers.openai.com/api/docs/guides/tools-apply-patch); Pi's JSON tool
transport carries one argument value, so the whole envelope travels as that string — the
minimal transport difference from Codex's stdin/heredoc delivery. A legacy single-file
structured `operation` object remains accepted for compatibility with earlier sessions
but is deliberately not part of the model-facing guidance.

### Input contract

`ApplyPatch` takes exactly one argument: either the canonical `patch` envelope or the
legacy `operation` object, enforced both by the JSON schema (`oneOf` with
`additionalProperties: false`) and at runtime.

The canonical envelope follows the public Codex grammar:

- `*** Begin Patch` / `*** End Patch` boundary markers (surrounding blank lines are
  trimmed; a shell-style heredoc wrapper `<<EOF` ... `EOF` is unwrapped before parsing,
  matching Codex's lenient default).
- `*** Add File: <path>` — each following line starts with `+`; every line contributes
  `<line>\n` to the file content (Codex newline semantics).
- `*** Update File: <path>` — an optional `*** Move to: <path>` rename before the change
  lines, then one or more `@@ [anchor]` chunks of ` ` context / `-` removed / `+` added
  lines. The first chunk may omit its `@@` marker, a bare empty line is an empty context
  line, and `*** End of File` anchors a chunk at end-of-file.
- `*** Delete File: <path>` — no content lines.

The complete envelope is parsed before any filesystem mutation, so malformed requests
fail cleanly with no side effects. Update-hunk bodies are handed to the existing V4A
engine unmodified, so anchor/context/EOF application semantics are identical to
single-file operations. Deliberate deviations from upstream: `*** Environment ID:` lines
are rejected (this tool patches the local workspace only), and an update hunk without any
change line is rejected with a Codex-style diagnostic.

Legacy structured calls keep their earlier contract: a discriminated V4A file operation
(`create_file`, `update_file`, or `delete_file`) whose variants have their own required
and forbidden fields, a non-empty **headerless** diff body (no `*** Begin/Update/Add`
/Delete` markers and no path header), and the same path normalization. In both forms,
every path is a non-empty workspace-relative string; a single leading `@` convention
marker is stripped before use.

The tool is registered in both the top-level orchestrator and the Pi-native executor
runtimes; it is active by default under Pi's normal registered-tool policy and is never
force-enabled through `setActiveTools`, so an explicit Pi launch `--tools` allowlist
remains authoritative.

### Execution semantics

File operations are applied sequentially in envelope order, exactly like Codex's
`apply_hunks_to_files` loop: the first failing operation stops the request, earlier
successful operations remain applied, and later operations are not attempted. A later
operation may legitimately target a file an earlier one just created or modified (the
sequential state is what it reads). The overall call is an error on partial failure, and
its diagnostic explicitly reports which operations applied, which failed — including any
uncertain effects of the failed operation, such as a move whose destination was created
but whose source removal failed — and which were not attempted, so review capture and
the model both see the accumulated delta. There is deliberately no cross-file rollback:
POSIX provides no multi-file atomicity, so the tool reports partial state truthfully
instead of claiming atomicity it cannot provide; a process crash mid-request can leave a
partial set, and ordinary failures report exactly what was applied.

Successful canonical calls return the upstream Codex `print_summary` text (`Success.
Updated the following files:` followed by git-style `A`/`M`/`D` lines grouped by status,
with moved files listed under their source path); Pi's structured details are additive.
Legacy calls keep the familiar per-operation summaries.

### Per-file safety properties:

- The V4A engine is adapted from the official OpenAI Agents JS `applyDiff.ts`
  implementation (MIT-licensed; see [NOTICE](../NOTICE) and
  [LICENSES/MIT-openai-agents-js.txt](../LICENSES/MIT-openai-agents-js.txt)). Its anchor
  parsing, context matching, first-match selection, whitespace fuzz, and
  `*** End of File` behavior are preserved.
- Every source and destination path is confined to the current working directory. Path
  traversal, absolute paths outside the workspace, symlink escapes, symlinked targets,
  directories and other non-regular files, binary or non-UTF-8 content,
  create-over-existing, update/delete-missing, and unsafe move destinations are rejected
  with informative diagnostics. V4A file-level header lines inside `operation.diff`
  (e.g. a stray `*** End Patch`) are likewise rejected up front instead of being
  silently treated as section terminators.
- Each individual file mutation is staged through a same-directory temporary file, so a
  failed operation never exposes a partial write of its own target. New files and move
  destinations are committed through an atomic no-overwrite link, so a target that appears
  after validation is rejected with `EEXIST` rather than overwritten; on filesystems
  without hard-link support the commit fails safely instead of risking an overwrite.
  With `moveTo`, the patched content is committed at the destination before the source is
  removed: a destination-side failure leaves the original source bytes in place, while a
  source-removal failure leaves both files in place and reports them as uncertain effects
  rather than hiding the state. `delete_file` validates that the full source is UTF-8
  text before removing it, and each operation revalidates its source identity immediately
  before overwriting or deleting so concurrent external edits are not destroyed.
  Cancellation is honored before every mutation step (an atomic commit that already
  completed cannot be undone). The declared `executionMode: "sequential"` additionally
  prevents `ApplyPatch` from racing sibling built-in edit/write calls within one parallel
  tool batch.
- Like Pi's built-in `edit` and `write`, foreground `ApplyPatch` calls do not wait for
  background landing leases or conflict gates. This allows conflict resolution without
  deadlocking behind the gate it must repair. Editing does not clear that gate:
  automatic task landings remain blocked until `SubtasksMarkClean` validates resolution.
- Updates preserve the original file's exact permission bits (independent of the process
  umask), byte-order mark, and line-ending style (LF or CRLF) where feasible;
  trailing-newline state is preserved by the upstream engine. An update whose patch
  changes nothing and has no rename succeeds as a true no-op: the file is not rewritten,
  so its inode, timestamps, hard links, and extended metadata are preserved. A no-change
  update that does carry `moveTo` performs the rename and reports it as such.
- Failures throw with an informative message so Pi marks the tool result as an error and
  the model can correct the envelope and resubmit only the remaining operations.
- Review evidence pre-captures every envelope path (including move destinations) — or
  `operation.path`/`operation.moveTo` for legacy calls — as mutation candidates before
  execution, applying the same leading-`@` normalization the tool uses. Because change
  detection compares baseline snapshots against disk state, successful changes remain in
  the review capture even when the overall call errors after a partial failure.
  Successful and failed calls both remain review evidence. Results expose
  bounded structured details including the requested diff and a unified final diff —
  with `rename from`/`rename to` headers for moves and the removed content for
  deletions — rendered compactly by the tool's custom call/result renderers.

## Secrets and authentication

Authentication remains in each harness's own login/configuration; do not put OAuth
tokens or API keys in the review-gate file. Git-ignored files such as `.env` are
excluded from capture and landing, so worker tasks never receive them
([Delegated execution](delegated-execution.md#capture-and-ignore-policy)). DDGS
provisioning treats the configured PyPI/index source and local pip configuration as part
of the trusted setup boundary ([Web tools](web-tools.md#websearch)).