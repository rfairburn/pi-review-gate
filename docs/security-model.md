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

Both download paths (`WebFetch` and `BrowserExtract`) are DNS-rebinding-hardened. Every
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
broker (an HTTP/HTTPS CONNECT proxy owned by the render and bound only to 127.0.0.1 on
an ephemeral port). Chromium is launched so the broker is its only network path:

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
decrypts it). WebSockets are always closed, service workers are blocked, and every
outbound connection is recorded in a broker-owned connection ledger that is audited
before the render result is returned; the browser and all broker sockets quiesce before
anything is exposed. Local browser protocols (`about:`, `blob:`, `data:`) remain
narrowly allowed.

Images, media, and fonts are aborted by the route policy before any connection is made,
cross-host or not, and this never fails the render. The result discloses bounded
omission diagnostics (capped samples plus a dropped count) alongside explicit per-render
budgets (distinct hostnames, concurrent broker client connections and their
pre-authentication idle deadline, destination connections, per-connection and aggregate
bytes, authority/header lengths, idle and total time). A budget that destroys an
in-flight transfer is nonfatal only when the main document completed; main-document
failures, non-2xx navigations, oversized rendered HTML, and any ledger audit failure
fail the render closed.

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
  read-only allowlist that excludes `ApplyPatch`.
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

The `ApplyPatch` tool performs one structured OpenAI apply_patch operation per call —
`create_file`, `update_file`, or `delete_file` — against a single file inside the
current workspace, following the V4A diff contract at
https://developers.openai.com/api/docs/guides/tools-apply-patch.

### Input contract

`ApplyPatch` takes exactly one argument, `operation`, which is a discriminated V4A file
operation. Each variant has its own required and forbidden fields, enforced both by the
JSON schema (`oneOf` with `additionalProperties: false`) and at runtime, so a field that
belongs to another operation (for example `moveTo` on `create_file`, or `diff` on
`delete_file`) is rejected with an informative error rather than silently ignored:

- `create_file` — requires `type`, `path`, and `diff`; every diff line starts with `+`.
- `update_file` — requires `type`, `path`, and `diff`; optionally accepts a non-empty
  `moveTo` (a new workspace-relative path that must not already exist) to patch-and-rename.
- `delete_file` — accepts only `type` and `path`; there is no `diff` or `moveTo`.

`path` is a non-empty, workspace-relative string; a single leading `@` convention marker
is stripped before use. `diff` is a non-empty **headerless** V4A body (no
`*** Begin/Update/Add/Delete` markers and no path header), because the operation type and
paths are structured fields. The tool is registered in both the top-level orchestrator and
the Pi-native executor runtimes; it is active by default under Pi's normal registered-tool
policy and is never force-enabled through `setActiveTools`, so an explicit Pi launch
`--tools` allowlist remains authoritative.

Behavior and safety properties:

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
- Validation and parsing complete before any mutation, and each mutation is staged
  through a same-directory temporary file, so a failed call never exposes a partial
  write. New files and move destinations are committed through an atomic no-overwrite
  link, so a target that appears after validation is rejected with `EEXIST` rather than
  overwritten; on filesystems without hard-link support the commit fails safely instead
  of risking an overwrite. With `moveTo`, the patched content is committed at the
  destination before the source is removed, so a failed move leaves the original source
  bytes in place (and a source-removal failure rolls the destination back).
  `delete_file` validates that the full source is UTF-8 text before removing it and
  rechecks cancellation after the validation read. The declared
  `executionMode: "sequential"` additionally prevents `ApplyPatch` from racing sibling
  built-in edit/write calls within one parallel tool batch.
- The complete validated mutation window runs under the same source-mutation coordinator
  that serializes background-task landing, so a foreground patch cannot interleave with
  a landing capture and an active conflict gate blocks patching until it is cleared.
- Updates preserve the original file's exact permission bits (independent of the process
  umask), byte-order mark, and line-ending style (LF or CRLF) where feasible;
  trailing-newline state is preserved by the upstream engine. An update whose patch
  changes nothing succeeds as a true no-op: the file is not rewritten, so its inode,
  timestamps, hard links, and extended metadata are preserved.
- Failures throw with an informative message so Pi marks the tool result as an error and
  the model can correct the diff or path and retry. Each call mutates at most one file;
  there is deliberately no cross-call or multi-file rollback — retry the individual
  failed operation.
- Review evidence pre-captures `operation.path` and `operation.moveTo` as mutation
  candidates before execution (applying the same leading-`@` normalization the tool
  uses) and successful and failed calls both remain review evidence. Results expose
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