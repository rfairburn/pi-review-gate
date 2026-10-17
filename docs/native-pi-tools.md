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

- **Codemode admission is availability only, and the toggle never widens a role.** At
  the top level the gate admits `codemode` wherever Pi's registry carries it and no
  explicit restriction removed it — even with no MCP server at all, and alike for
  wrapper sessions (which forward arguments unchanged and pass no `--tools` value) and
  manual extension-only launches (`pi -e`). Neither a launch selection nor a restored
  declaration decides admission (#421). Admission is not activation, and switching the
  toggle never produces a tool the role excludes.
- **Explicit restrictions are authoritative.** `--tools`/`--exclude-tools`/`--no-tools`
  remove `codemode` and MCP tool names from Pi's registry and are never re-added, for
  the session or any worker. Pi's own `--tools` nuance applies: an allowlist that names
  no `mcp__` entry keeps MCP tools registered for codemode and `tool_search`, and Pi
  never declares the `direct`-exposure ones it does not name (see
  [Top-level authority](#top-level-authority-comes-from-the-live-registry));
  `--no-builtin-tools` and Pi's `defaultTools` only set
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
builtin name `tool_search`, so there is exactly one model-facing discovery tool.
Registration happens at session start — after every legitimately available
top-level execution tool is registered and before the session's first authorization
reconciliation — never at extension load time, so Pi's builtin collision pass sees no
competing definition whether the builtin tool search is enabled, disabled, or
toggled across a reload. The descriptor reuses the host-native `tool_search`
parameter schema by exact reference (borrowed from the live registry when the
builtin is loaded, otherwise captured from the running install's own bundled
factory) for Pi 1.1 and older hosts' identity-based recognition. On Pi 1.2 and
newer, the descriptor declares `reachesTools: () => "all"`, the public contract
Pi uses to recognize a replacement and wait for native MCP server readiness.
Neither mechanism grants tool access: the live authorization boundary and
loading gates remain authoritative, and genuine diagnostics — including the
warning for a truly missing discovery path — remain intact. When no running Pi host resolves (unit tests, non-Pi processes),
the loader keeps its local fallback schema and startup proceeds unchanged; when
a host resolves but its native schema cannot be acquired, session start fails
explicitly instead of registering an incompatible descriptor that would silently
defeat Pi's recognition.

The loader honors the native limit contract: a search call returns at most the
supplied positive integer of strongest-tier matches, or eight when none is
supplied (any other limit value is rejected as an invalid request), and reports
how many strongest-tier matches the limit withheld from that call. Matching,
tiering, and authorization are untouched by the cap, and the discovery
inventory in the tool description and startup prompt stays complete — it lists
every authorized name and is never capped.

The loader activates authorized matches — ordinary, codemode- and
deferred-exposed (including MCP), and model-only tools alike — within the
session's review-gate authorization at live permissions: the reconciled
authorized/exposed registry at the top level, the captured catalog in a
delegated Pi worker. Activation declares the matched schemas for the next model
call; it never executes the matched operation, and codemode/deferred tools
remain callable from scripts while inactive exactly as before.

## Top-level authority comes from the live registry

Pi restores a resumed (`--continue`), switched, or forked conversation's previous tool
declarations before review-gate starts, so the active set is not evidence of permission.
At the top level, review-gate derives authority afresh from Pi's current registry at
session start and at every reconciliation seam below; it never persists, restores, or
infers a tool list from the transcript.

- Every registered, non-hidden tool Pi currently permits is a discovery candidate,
  within the operating mode and live feature settings (for example the YouShouldKnow
  notice setting and the `tools.topLevelDeny` list; see
  [Scoped tool denial](#scoped-tool-denial-top-level-and-executor)); `codemode` is no
  exception. Candidates are listed by the startup inventory and the `tool_search`
  description and are declared only after `tool_search` loads them; tools already active
  report as already active.
- Registered is not always declarable. Pi offers no public per-tool activatability
  query, so the inventory lists registered candidates, and `tool_search` confirms each
  activation from Pi's actual active set after loading. A name Pi declines is reported
  as not activated and unavailable, never as activated or already active, and it is
  not retained as loaded: a selection Pi declines at any later write is dropped too
  (a later reappearance needs `tool_search` again), and direct calls require the tool
  to be in Pi's actual active set. On Pi 1.3, for example, `--tools read,tool_search` keeps a
  `direct`-exposure MCP tool registered but never declarable; naming it (or an
  `mcp__` pattern matching it) in `--tools` makes it loadable, and permitted
  `codemode`/`deferred`-exposure MCP tools load through `tool_search` whenever the
  allowlist keeps `tool_search` itself.
  review-gate does not change Pi's policy or `/mcp` exposure to work around a refusal.
- The role baseline (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`,
  `ls`, `ApplyPatch`, `SubtasksStart`) is active wherever Pi registers and review-gate
  authorizes it, regardless of the restored loadout; both shells keep parity when both
  are authorized. Activity never decides admission or auto-loading.
- Pi registers its builtin `powershell` on every platform, but Pi can run it only on
  Windows, using `pwsh.exe` or else `powershell.exe` from PATH. Review-gate identifies
  the builtin from the public provenance Pi reports for each registered tool
  (`builtin:powershell`) and authorizes it only on Windows when one of those
  executables resolves; elsewhere it is withheld from the baseline, discovery,
  `tool_search`, and new worker catalogs. Host support is checked at session start and
  on operating-mode changes, never on every reconciliation, so an interpreter installed
  or removed mid-session is noticed at the next of those points. The check proves that
  the interpreter resolves, not that any particular command will succeed. Extension or
  SDK tools named `powershell`, and entries whose provenance the host does not report,
  are not gated. Existing worker catalogs are never re-derived. `--no-builtin-tools`
  and `defaultTools` only set Pi's initial activity; withhold tools with
  `--exclude-tools` or an explicit `--tools` allowlist.
- Explicit `--tools`/`--exclude-tools`/`--no-tools` restrictions remove names from Pi's
  registry (subject to the `--tools` MCP nuance above) and stay authoritative; hidden,
  withdrawn, or natively disabled MCP tools are never reconstructed.
- Operating-mode changes apply from the next turn. Entering Plan/research removes
  forbidden tools, including loaded ones, while loaded read-only tools stay loaded;
  leaving it rebuilds the loadout from the registry at that moment, so forbidden tools
  loaded before the switch need `tool_search` again.

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
  forcing native declarations or weakening ordinary/control startup checks. A newly
  captured executor also applies the exact-name `tools.executorDeny` list at admission
  (see [Scoped tool denial](#scoped-tool-denial-top-level-and-executor)).
- Research workers never receive codemode or any MCP tool name, and a supplied
  catalog cannot add either back: it fails closed at subset validation. External
  harnesses are unchanged (Claude with settings, skills, plugins, and MCP disabled;
  Codex's sandbox; generic binaries ineligible for research).

## Scoped tool denial (top-level and executor)

Beyond the role, mode, and launch ceilings above, the configuration's
`tools.topLevelDeny` and `tools.executorDeny` lists (staged as the **Top-level tools**
and **Executor tools** selectors under `/review-settings` → **Tools**) are exact-name
narrowing layers. A checked row is denied; the two lists are independent, never
glob/pattern lists, and never grant: unchecking a denial restores only that tool's
ordinary eligibility, and a denial removes no plugin, sandboxes no effect, and adds no
wildcard policy. See [Tool denial fields](configuration.md#tool-denial-fields).

- **What a denial removes.** A denied name is withheld from admission and
discovery — the startup inventory, the `tool_search` description and results, and the
normal declared tool set — and every call naming it fails without executing: a direct
model call, a codemode or other wrapper script's `ctx.executeTool` (nested) call, and
the same call reached through a second wrapper, because the denial is checked before the
correlated `tool_call` admission rather than at a single surface.
- **Denial diagnostics state only what the host establishes.** The scoped settings
explanation is added where the host establishes the cause: a call refused at the
`tool_call` admission check receives it directly, a direct call whose declaration was
withheld is clarified at the documented `message_end` seam, and a nested call Pi recorded
on the wrapper's tool result is explained from that record. A delegated executor omission
is explained from that task's fixed captured catalog alone — plus Pi's record where the
call failed before admission — a durable captured-permission fact, never a re-read of the
current deny configuration and never an attribution to a global, mode, or native
restriction. An early native rejection that leaves no recorded invocation keeps Pi's own
truthful error instead: codemode's own proxy can refuse a non-callable direct-exposure
member before `ctx.executeTool` runs, so there is no invocation for review-gate to
attribute and it never infers a settings cause from error text. The no-execution guarantee
above is unaffected.
- **Independence.** A top-level-only denial leaves the tool eligible for a newly
captured executor; an executor-only denial leaves the primary eligible. Denying both
excludes both; denying neither changes nothing. A denial in one list never widens
authority in the other, and neither widens a real global, native launch, feature, mode,
or role ceiling: Pi's `--tools`/`--exclude-tools`/`--no-tools`, the operating mode, the
YouShouldKnow notice setting, and research restrictions stay authoritative.
- **The discovery loader is reserved.** `tool_search` itself is never a candidate in
either list, so the lists can only narrow other tools; the candidate universe is every
otherwise-discoverable tool except `tool_search`. A raw `tool_search` entry is rejected
rather than applied — an explicit write fails strict validation, and startup recovery
warns and omits the entry — and neither list can deny the loader.
- **Timing and captured authority.** Applying the draft makes top-level denials
effective at the next applicable model set write, without interrupting an in-flight run
or reloading. Executor denials apply to new execute/inplace admissions through the
shared `SubtasksStart`/`SubtasksAdd`, scheduled-task, and human paths; research tasks
are unaffected. Authority is captured at admission, so already-admitted queued or
running tasks — and their later continuation turns — keep the catalog captured at
launch, exactly like every other member of the [fixed captured
ceiling](#delegated-pi-workers-the-fixed-captured-ceiling).
- **Bounded metadata visibility.** Pi itself is unchanged,
so a denied name may remain visible to Pi's own native callable metadata: codemode and
other wrapper scripts can still observe it through `ctx.tools`, and an active codemode
description can list codemode-exposure tools. That metadata is not always in context —
deferred tool metadata is generally returned only by explicit queries such as
`ALL_TOOLS`, `searchTools`, or `describeTool` — and names recorded in earlier transcript
entries persist after a denial. Normal declarations, the startup inventory, and
review-gate's `tool_search` exclude denied names, and no denied call executes.

### Manually verifying scoped tool denial

The checkout ships one small helper that stages a disposable, isolated sandbox — its
own `HOME`, `PI_CODING_AGENT_DIR`, `TMPDIR`, caches, synthetic workspace, probe
fixture, and `review-gate.json` — and prints the exact `pi` command to run. It builds
and launches nothing; it reads only the installed Pi runtime's install
location/provenance to build that command, and never reads or writes live settings,
auth, config, or cache:

```sh
node scripts/pi-review-gate-tool-denial-sandbox.cjs --candidate /path/to/owned/dist/src/index.js
```

The probe fixture is a synthetic third-party `SyntheticNotify` tool (its only effect is
one local JSONL line) plus a scripted in-process model, so the deterministic path needs
no credential and no network. The printed command changes into the sandbox workspace
before launching Pi — so a dispatched task that omits an explicit workspace still
targets the sandbox, never the checkout — and runs under an allowlisted `env -i`.
Loading the candidate also means the command does not rely on ambient discovery; Pi's
builtin extension set stays off (`--no-extensions`) except the explicitly loaded
`builtin:codemode` needed for the nested-call probe. Because the sandbox agent directory
holds the fixture and
a new review-gate executor child inherits `PI_CODING_AGENT_DIR` without
`--no-extensions`, the fixture reaches a freshly launched worker too. The printed guide
covers the interactive Tools walkthrough, the deterministic prompts that exercise a
direct call, a `SubtasksStart` executor dispatch, and a codemode script call, and the
sandbox cleanup command. In that walkthrough, nested Back/Escape only navigate; only
Escape at the `/review-settings` root applies the draft to the running session, while
Save/Ctrl+S persists it (see [Settings menu](settings.md#review-settings)). Pass
`--json` for a machine-readable command summary, and `--model <provider/model>` with
`--pass-env <NAME>` if you need a real model; the helper copies no credentials, and it
refuses `--pass-env` names that are sandbox-owned or review-gate-reserved so the
isolation cannot be overridden. The printed guide references a `--pass-env` value from
your own shell instead of echoing it, while the `--json` summary carries the full env
map and so must be treated as sensitive when a credential is passed. A built candidate
is required: build it into an owned scratch directory, never the live `dist/`.

To probe whether tool metadata or a call surfaced, read the JSONL log the fixture writes
(`PRG_TOOL_DENIAL_LOG`) and the `/tool-denial-dump` inventory dump; a denied call leaves
no log line, and an allowed one leaves exactly one.

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