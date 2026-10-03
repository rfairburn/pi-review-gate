# Native Pi tools: MCP and codemode

codemode is a native Pi tool for calling registered tools from scripts; MCP servers are
Pi's native extension surface, and review-gate takes neither over: it adds only
admission, loading, live-reconciled availability, and call guards. Cross-ownership:
[Configuration](configuration.md#delegated-execution-fields) owns defaults,
[Security model](security-model.md#read-only-enforcement) read-only enforcement, and
[Delegated execution](delegated-execution.md) worker mechanics; the semantics
originate with [#224](https://github.com/rfairburn/pi-review-gate/issues/224).

## Loading by role and deferred toggle

| Session | Deferred tools on (default) | Deferred tools off |
| --- | --- | --- |
| Top-level Prefer execution / Prefer orchestrate; execute-kind Pi workers with codemode authorized | `codemode` is not initially active: discovered and loaded through review-gate's `tool_search`, then called on a later turn | ordinary permitted tools, including `codemode`, load without review-gate deferral; native MCP exposure still applies |
| Plan/research sessions; research Pi workers | `codemode` and all MCP tool access are off, regardless of the toggle (the read-only role boundary: no reduced-transport exception, no `readOnlyHint` opt-in, no researcher override) | same |

- **Wrapper default is availability only, and the toggle never widens a role.** Wrapper
  sessions forward arguments unchanged and pass no `--tools` value, and the gate merely
  admits `codemode` where Pi's registry carries it and no explicit restriction removed
  it — even with no MCP server at all. A manual extension-only launch (`pi -e`) gets no
  added default and codemode follows Pi's own settings there; admission is not
  activation, and switching the toggle never produces a tool the role excludes.
- **Explicit restrictions are authoritative.** `--tools`/`--exclude-tools`/`--no-tools`
  remove `codemode` and MCP tool names from Pi's registry and are never re-added, for
  the session or any worker; `--no-builtin-tools` and Pi's `defaultTools` only set
  initial activity, so they cannot withhold registered names by themselves
  ([Security model](security-model.md#read-only-enforcement)).

## What stays with Pi

MCP server configuration (`pi mcp`, `/mcp`), project trust, OAuth credentials, and
per-server/tool exposure (`direct`, `codemode`, `deferred`, `hidden`) are Pi's —
review-gate neither reads nor writes them and registers no server of its own. While
deferred tools are on, direct-exposed permitted tools are not automatically declared:
like any other deferred authorized tool they surface through `tool_search` and
activate on load, or sit active from start when the toggle is off — codemode- and
deferred-exposed tools keep their native script channels. Baseline tools remain
baseline. MCP annotations (`readOnlyHint` and peers) are unverified server hints:
review-gate adds no annotation-based permission policy and never treats a hint as a
safety signal, though the user's Pi permission handlers keep applying to MCP calls.
Tool access off is availability-only: this page claims nothing about whether MCP
server processes start or connect — Pi's configuration and project trust decide that.

Turning review-gate deferral off removes only review-gate's loading step. It does
not force native codemode/deferred MCP tools into direct declarations. Pi's `/mcp`
enablement and exposure still govern their availability; disabled, hidden, and
withdrawn tools are absent from `tool_search` discovery, and an explicit `tool_search`
activation persists across reapplication within the role and captured ceiling until
withdrawal or a hidden exposure prunes it.

## One loader replaces Pi's builtin tool search

Review-gate registers its discovery/activation loader under Pi's replaceable
builtin name `tool_search`, so Pi does not load its own tool-search extension and
there is exactly one model-facing discovery tool. The loader activates authorized
matches — ordinary, codemode- and deferred-exposed (including MCP), and model-only
tools alike — within the session's review-gate authorization at live permissions:
the reconciled authorized/exposed registry at the top level, the captured catalog in
a delegated Pi worker. Activation declares the matched schemas for the next model
call; it never executes the matched operation, and codemode/deferred tools remain
callable from scripts while inactive exactly as before.

## Reconciliation during a running session

Pi has no generic tools-changed event, so review-gate aligns its cached
authorized/exposed view with Pi's current registry at the seams it already crosses —
session start, restore, and tree/branch transitions; turn boundaries; its own discovery
and search queries; the tool-call admission hook; and MCP lifecycle changes visible
there (connects, `/mcp` re-enablement, tool-list changes, extension registrations).
The pass is an alignment, not a second authorization grant or a configuration write.

- A permitted addition becomes available at the next seam without a restart, within
  Pi's native exposure and the ordinary deferred toggle above; a withdrawn, hidden,
  disabled, or excluded name becomes absent, stale entries cannot serve it, and a call
  naming it fails. Re-enablement applies within the same restrictions, and delegated
  workers never see beyond their captured catalog.

## Delegated Pi workers: the fixed captured ceiling

A Pi worker launches with an explicit `--tools` catalog captured from the parent's
authorized tools at task start, and that ceiling never widens afterward — later
registrations, `/mcp` re-enablement, or reconfiguration apply only within it
([Delegated execution](delegated-execution.md#research-task-tool-restriction),
[Security model](security-model.md#read-only-enforcement)).

- Worker codemode is inherited, never separately granted: the captured catalog carries
  it exactly when the parent's authorization admitted it, loading follows the same
  toggle as the top level, and names outside the ceiling — MCP tool names arriving
  mid-task included — are unreachable by direct and script call alike. Captured names
  remain unavailable while withdrawn or hidden; Pi can restore them only within that
  same ceiling. Native MCP registrations may arrive asynchronously after bootstrap:
  pending names stay unavailable until Pi supplies permitted live metadata, without
  forcing native declarations or weakening ordinary/control startup checks.
- Research workers never receive codemode or any MCP tool name, and a supplied
  catalog cannot add either back: it fails closed at subset validation. External
  harnesses are unchanged (Claude with settings, skills, plugins, and MCP disabled;
  Codex's sandbox; generic binaries ineligible for research).

## Codemode calls inside the gate

A script's `tools.<name>(...)` call is a native Pi tool call through the same
`tool_call`/`tool_result` hooks as model-issued calls, correlated to its parent: the
[native duplicate/liveness preflight](delegated-execution.md#native-pi-duplicate-call-preflight),
permission gates, and existing review-evidence policy apply as to a direct call. A
failed, timed-out, or cancelled script does not roll back — completed calls stand,
still-running calls are cancelled, evidence keeps what was recorded, and the model
receives the partial output plus the error; these remain ordinary recorded calls for
review windows and bundles.

## Out of scope for review-gate

No MCP server manager, `/mcp` replacement, exposure editor, or toolset UI; no
researcher override, trust grant, credential storage, or proxying; no second
discovery loader alongside the builtin `tool_search` replacement; no
annotation-derived permission policy; and no claims about Pi session-durability or
storage — review-gate's own durability story is [Recovery](recovery.md).