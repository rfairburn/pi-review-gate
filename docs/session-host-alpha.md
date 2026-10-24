# Optional Pi session host (alpha)

`pi-review-sessions` is an optional terminal host for running multiple, independent
native Pi sessions side by side, on one machine or across paired machines. It is a
separate entry point: it does not replace `pi-review-gate`, the normal Pi CLI, or either
standalone review-gate launcher, and it changes no native Pi CLI, runtime, version, or
public SDK. Use those existing entry points as before when you want one ordinary Pi
session. It is not a tmux integration, daemon, or session-adoption layer: each host owns
only the children its own session manager started. Through the optional
[Network sidebar](#network-sidebar-hosting-pairing-and-remote-metadata), a paired
viewer on another machine can display, type into, copy from, and close one owner's
sessions, create new ones there, and browse, resume, or delete that owner's
[saved conversations](#saved-conversations-on-a-connected-owner). It does this without
adopting, migrating, or synchronizing them: the owning host keeps every process.

This is alpha guidance, not a finished-host compatibility guarantee. The alpha design
uses Pi's public `ProcessTerminal` input and terminal-negotiation path with custom
generated frame composition; it is not a `TuiAltScreen` renderer. Native wrapper,
terminal-input, menu, question, editor, and runtime parity remain under integration
verification.

Component, mock, or socket tests alone do not prove compatibility with a real native
Pi wrapper, and same-host network tests do not establish two-machine, operator, or
platform readiness for the cross-machine features. macOS and Linux are the intended POSIX host platforms; intended platform
scope is not evidence that end-to-end runtime compatibility has been proven. Windows
startup, public named-pipe, and pinned node-pty ConPTY source paths are experimental
only; they are not Windows runtime support or readiness evidence. Manual Windows
validation has observed mouse clicks working, but that observation does not certify
sidebar single-click activation, native Main click-to-focus, other physical input, or
complete host-process shutdown (see below).
Device-attributes negotiation also requires complete runtime acceptance; its narrow
witness investigation is tracked in
https://github.com/rfairburn/pi-review-gate/issues/337 under the broader #334
Windows-host follow-up. The sidebar alpha release defers all remaining Windows
sidebar/host runtime acceptance to
https://github.com/rfairburn/pi-review-gate/issues/345: the real native Main case
(startup, public Quit confirmation, original-process/kernel settlement/restoration)
and both cold hosted-source wrapper legs (cmd and direct PowerShell) are retained in
the suite but explicitly skipped, so green CI does not certify Windows runtime
support; the Windows sidebar/host remains optional experimental.

## Known limitation: Windows runtime acceptance

Bundled-ConPTY diagnostics have observed genuine native mouse-tracking/SGR requests
and device-attributes negotiation. Their assertions are retained in the explicitly
skipped runtime cases; those protocol observations do not certify physical wheel or
selection behavior. Manual Windows validation has observed mouse clicks working, and
that observation is limited to clicks: wheel/conversation scrolling and
pane-confined selection still require interactive validation, rather than
editor-history navigation or selection crossing host panes. Sidebar single-click
activation and native Main click-to-focus are described below, but neither certifies
Windows runtime behavior (#323, #345). Conversation wheel/trackpad scrolling remains
outside this change and separate under #332; scroll-smoothness tuning remains separate
work. A cosmetic child-pane flicker on pointer movement and clicks has been observed;
it is not breakage and not a release blocker (#343). Native Pi/review-gate startup
latency on Windows has been present since before this release and is unrelated to
it (#344).

Complete graceful shutdown is also unresolved: native child exits and a returned Main
status do not establish original Main and outer/wrapper process settlement. Current
diagnostics have not established that complete settlement; the pinned ConPTY
lifecycle is an investigation lead, not proof of the exact retained resource or its
cause. The genuine Main and cold CMD/direct-PowerShell runtime cases remain deferred
under https://github.com/rfairburn/pi-review-gate/issues/345. Result files, passing
subtests, or forced exits cannot replace positive original-process exit and full
terminal-restoration evidence. Green CI does not certify Windows runtime support.

## Requirements and launch

- **Host platform:** same-machine POSIX macOS or Linux remains the documented
  runtime scope. Windows source paths now admit the same-machine host and public
  ConPTY flow for validation, but Windows is not supported/readiness-certified until
  real Windows runtime evidence on the patched Node 22 and 24 lines passes. Earlier
  Windows evidence on Node 22.19.0 and 24.x is historical: it predates the current
  security floors and is not a patched-runtime run. In the upcoming sidebar
  alpha release that runtime acceptance is deferred under
  https://github.com/rfairburn/pi-review-gate/issues/345. The ordinary standalone
  Windows launcher remains unchanged.
- **Node.js:** at or above its release line's security floor: 22.23.4 or newer on
  Node 22, 24.22.1 or newer on Node 24, or 26.12.1 or newer on Node 26 (see
  [Node.js security floors](getting-started.md#nodejs-security-floors)). The managed
  fallback runtime is the checksum-pinned official Node.js 22.23.4 archive. Updating
  this requirement does not update or restart a running host or its sessions. Update
  Node.js, then restart them.
- **Pi:** stable Pi 1.0.4 or newer; the provisioned runtime and native UI
  acceptance fixture are pinned to **1.4.0**, with the matching 1.4.0 TUI dependency.
- An interactive terminal with both stdin and stdout attached.

The Windows session-host source path selects the Microsoft ConPTY implementation
bundled with the pinned `@lydell/node-pty` package through its public
`useConptyDll` option, rather than Windows' inbox ConPTY. The real Windows
acceptance fixtures request the same public option. This selection alone is not runtime
support evidence; the acceptance deferrals and limitations above still apply.
POSIX PTYs and the ordinary standalone launchers are unchanged.

The Windows validation path uses plain Node named pipes with the existing
per-instance token authorization and the platform's default pipe ACL behavior. It
adds no custom ACL guarantee, explicit remote-client rejection, or encryption; this
is not a same-user sandbox. The broker retains its 32-connection unauthenticated
backlog cap and 2-second authentication deadline, but those bounds do not prevent
resource-exhaustion attempts or promise availability. Node source staging likewise
relies on inherited OS ACLs: requested POSIX mode bits do not establish Windows
privacy. Setup uses a fresh exclusive stage and public Node identity checks. Build, fallback-Node
and Pi-runtime generation subtrees are path-owned disposable caches, including legacy
or failed contents, regardless of individual descendant creator. Excess generations are
reclaimed best effort with confined, unchanged filesystem identities; a cleanup problem
warns and the launch continues, because cache capacity never stops startup. No custom Win32 pipe application, TLS/PSK layer, taskkill tree
scan, or private process helper
is part of the design. These source paths do not make the host Windows-supported;
that claim remains gated on the native evidence above.

The host must launch Pi through its actual supported Node CLI entry, not through an
arbitrary shell command. By default, `pi-review-sessions` looks for `pi` on `PATH`,
but accepts it only when that file is a readable (Windows) or executable (POSIX) Node
entry with a standard direct `node` shebang or `env node` shebang. Windows descriptors
use `process.execPath` and the exact canonical readable JavaScript CLI as the first
argument; POSIX keeps direct CLI/shebang execution. A `pi` name that resolves to a shell
shim is not sufficient. Opaque shell or managed-shell wrappers, native/SEA executables,
and complex interpreter flags are rejected before the version probe. For a managed or
custom installation, point to the actual Node CLI entry file explicitly; for example:

```sh
pi-review-sessions --pi-executable /path/to/pi-coding-agent/dist/cli.js
```

That example identifies the kind of path the host needs; it does not promise
compatibility with a particular installer or with older Pi versions. Do not substitute
an ordinary wrapper script for the actual Node entry.

From a source checkout, invoke the script with Node; an installed package exposes the
`pi-review-sessions` command:

```sh
node scripts/pi-review-sessions.cjs --pi-executable /path/to/pi-coding-agent/dist/cli.js \
  --state-root /path/to/session-host-state --sidebar-key f8
```

The host's options are `--help`/`-h`, `--pi-executable`, `--state-root`, and
`--sidebar-key`. `--state-root`, when supplied, must name an existing absolute
private directory and is used only as the root for the host's transient
status-broker transport directory; that owned directory and socket are removed when
the host closes. It is not a Pi agent,
profile, settings, or credential root. Without it, the broker uses the operating
system's temporary directory.

The host also owns one **global sidebar roster** in the canonical Pi agent directory —
Pi's `PI_CODING_AGENT_DIR` override when set, otherwise Pi's ordinary `~/.pi/agent` —
under `<agentDir>/session-host/`. That location follows Pi's native agent-data
resolution: it is never the launch cwd, `--state-root`, a config-file directory, or the
package root, so the same roster is visible from any launch directory. The same private
directory holds the host's exclusive ownership record. One host owns a given Pi agent
directory at a time: a second `pi-review-sessions` host sharing that directory is refused
before it constructs a manager, resolves a roster entry, or starts a child, with a
message naming the agent directory and the ownership record. Ownership is taken only by
an exclusive create and is never stolen, verified around, or repaired, and no process is
inspected or signalled to decide it. The record is removed only by the host that created
it, and only after its owned children settled; an unsettled shutdown keeps it so a later
host refuses instead of racing children that may still be running. Taking that ownership
and the launcher/producer's destructive cache reclamation share one short-lived
per-agent coordination entry in the same private directory
(`session-host/host-coordination.lock`). It is a mutex with a fixed protocol, never a second
lifetime record: the record (`pid` plus a targeted single-pid process-start identity) is
written complete in a private candidate and published with an atomic no-overwrite hard
link, so no reader ever sees a half-written entry and a paused publisher only loses the
link race. The identity is one exact per-platform token — `linux:<boot
identity>:<starttime>` from that single pid's `/proc/<pid>/stat` (no procps needed),
`darwin:<ps lstart>` from one targeted `ps` query, or `win32:<StartTime>` from one targeted
native PowerShell query — and a record is honored only while its pid is alive *and* still
reports the recorded token. Dead, malformed, or pid-reused metadata is therefore reclaimed
and can never gate startup on any supported platform, while a current holder is honored.
When that single-pid identity genuinely cannot be established, no record is published at
all (the mutex is reported unavailable and the launch continues), so a weak pid-only
record can never pin a later start. A live holder is a producer inside
its own bounded destructive critical section, so this host waits for it instead of
claiming ownership behind its back — with no elapsed-time release — and a genuine
unremovable-entry failure is not turned into a verification gate (ownership still
proceeds, and producers keep rechecking the record). The selection itself is protected by a coordinated handoff
rather than by a last-moment proof: the launcher takes that same entry before its final
selection revalidation, the host-entry load, and the host's ownership claim, revalidates
the prepared build artifact and Pi runtime with the launcher's existing validation
authority inside the hold, re-prepares or reselects them when a concurrent preparation
reclaimed them, and hands the entry back once the host's exclusive ownership record
exists. There is no new startup refusal for a cache this launcher pruned itself. The
running Node is already protected for the session by the bootstrap producer's transient
live generation marker. Malformed, oversized,
unsafe, or unreadable roster state is reported truthfully and left untouched: nothing is
restored from it, persistence stays disabled, and nothing overwrites it. Host shortcut
settings and the defaults are described below. Put native Pi arguments after a literal
`--`; allowed arguments retain their original order and bytes. There are no initial host
`--workspace`, `--profile`, or `--label` options.

### Host shortcut configuration

The host's two existing keyboard actions have independent bindings. Their dedicated
private JSON file is `<agentDir>/session-host/keybindings.json`, under the same native
Pi agent directory used by the roster. It is separate from Pi's native
`<agentDir>/keybindings.json`, workspace/project keybindings, `/review-settings`, and
review-gate configuration. A missing host file uses defaults without creating the file:
`toggle` is `alt+left`, and `returnToMain` is `alt+right`. For example:

```json
{
  "version": 1,
  "toggle": "f8",
  "returnToMain": "f9"
}
```

The Host shortcuts roster entry opens a host-owned editor. Tab switches between the two
configured fields; the current native form submit binding saves, and the current native
cancel binding cancels. Save validates both configured chords and the effective pair,
then atomically writes the file and applies the bindings immediately. Cancel changes
nothing. A failed or invalid save keeps the editor open with an error and keeps the
previous file and active bindings. The editor shows configured values, not an active
legacy override.

Each action takes one supported chord string. Supported chords are modified letters,
digits, symbols, and navigation keys using the pinned matcher's `ctrl`, `shift`, `alt`,
and `super` modifiers, or unmodified F1-F12. Shift-only navigation chords (such as
`shift+left`) are supported; Shift-only printable keys remain ordinary typing. Plain
navigation, Enter/Return (including Ctrl+M/Ctrl+J), Space, Escape, Ctrl+[ (Escape),
Ctrl+C, and duplicate bindings are refused; modified function keys and unsupported
special keys are also refused.
Equivalent modifier order/case is canonicalized, and legacy aliases recognized as the
same packet by Pi's pinned matcher are refused too (for example, `ctrl+-`/`ctrl+_` and
`alt+f`/`alt+right`).
Omitting an action in a version-1 file keeps that action's default; there are no aliases
for actions and no disabling value. An invalid, unreadable, oversized, symlinked, or
otherwise unsafe existing file refuses host startup with an actionable diagnostic and
is left untouched, even when `--sidebar-key` is supplied.

The existing `--sidebar-key` option remains a legacy toggle-only override. It uses the
same supported-key validation and takes precedence over the file's `toggle` value. The
editor identifies the override explicitly; Save still writes the configured toggle,
while the command-line override remains effective for that run. If the override and
configured return chord collide, startup and Save refuse the pair rather than choosing
an action by precedence. No additional command-line options are introduced.

Bindings change only the existing host actions. The toggle keeps its two-step behavior:
a hidden sidebar is shown and focused; a visible sidebar with Main focus only moves
focus to the roster; and a sidebar-owned focus hides and returns to Main. The
return-to-Main chord remains roster-only: it focuses the existing Main input owner
without selecting the highlighted sibling, hiding the sidebar, resizing children, or
changing active-session identity, and only when the selected roster entry was completely
drawn. Its held repeat/release stays fenced; in Main, a fresh return chord is native
input. Forms, the Saved picker, and confirmations consume the return chord. Existing
paste opacity, focus/visibility ownership, input routing, and action safeguards are
unchanged. Ordinary arrow/Enter/Space navigation, other session actions, mouse behavior,
review authorization, and native Pi bindings are not remapped.

There is no automatic collision rejection against native Pi bindings: the host reserves
its chords only in the existing host contexts, so native Alt+Left/Alt+Right editor or
tree bindings may be intercepted while their corresponding host action is active. The
terminal and operating system must deliver a chord for the host to match it; in
particular, Super chords require a terminal/platform combination that sends them.

Parent startup arguments apply to **every new instance**. The alpha rejects
`--continue`/`-c`, `--resume`/`-r`, `--session`, `--session-id`, `--fork`,
`--session-dir`, and `--no-session`, including attached-value spellings, so children
cannot attach to the parent's or another selected conversation. Rejection happens
before setup or instance creation; diagnostics identify the option, never its value.
Ordinary option values and arguments after Pi's own `--` terminator remain data, not
forbidden options. Native Pi environment configuration is otherwise shared with other
Pi sessions, but a nonempty inherited `PI_CODING_AGENT_SESSION_DIR` is explicitly
rejected by the host startup guard and launcher before setup or dependency construction.
With that override unset, Pi uses its ordinary session-storage default. Native
commands inside an individual window, including `/resume`, remain unchanged. Saved
conversation selection happens only through the sidebar's deliberate Saved conversations
picker (below); parent startup arguments still cannot select a session.

The launcher rejects unsupported platform, Node version, non-interactive use, and
runtime-role contexts before starting a host. A completed Pi discovery (the validated CLI
entry, its package version, and its filesystem identity, keyed to the explicit/PATH
context) is reused on later launches, so a current sidebar start performs no global
npm-root query, no `pi --version` probe, and no managed-runtime cleanup; an explicit or
PATH change is honored by falling back to full validation without rebuilding the
application. Every launcher — Pi (`.sh`/`.cmd`), the
web wrapper, and the sidebar (`.sh`/`.cmd`/`.ps1`) — then asks ONE shared authority
(`scripts/prepare-application.cjs`) whether the prepared application is current. That
decision is a fraction of a second: it reads a small bounded marker plus a completion
receipt, and stats only the paths those records name. A current start runs no install,
compiler, staging step, artifact inventory, runtime fingerprint, Python probe, skill
copy, or cache cleanup.

Installed packages are identified by their full exact version (for example
`0.1.0-dev.180`), so a prebuilt consumer never compiles. Source checkouts are identified
by a bounded index of the application inputs — `package.json`, `package-lock.json`,
`tsconfig.json`, `src/`, `scripts/`, and `skills/` — captured during preparation. A
recorded file's size, inode, device, mode, and modification/change times decide whether
anything moved; only a metadata change triggers the small input checksum, which
distinguishes a real edit from a touch-only change. Only the explicit input roots are
walked; other checkout trees, including top-level `node_modules`, `dist`, `.git`,
`docs`, and `tests`, are not scanned or hashed. Added, edited, or deleted inputs
invalidate; irrelevant or touch-only changes do not. A prepared generation is immutable
installed code and keeps the same source
identity as the checkout it came from, so starting a launcher from a prepared root never
rebuilds recursively and never overwrites the checkout's freshness state.

A genuine miss is updated automatically — no confirmation — under one preparation lock,
so concurrent launchers never duplicate the same update. Staging and locked
`npm ci --include=dev --ignore-scripts` plus the stage-installed TypeScript compiler run
in a fresh inactive generation, never in the live checkout's `dist/` or dependencies,
and never through the package build script's recursive clean step. Readiness is
published only after installation, compilation, required entries, and input coherence
all succeed: a marker names the prepared root and its filesystem identity, and a
completion receipt inside the generation records its own identity and the exact inputs
it was built from. A failed, cancelled, or raced preparation publishes nothing and
preserves everything it did not own. Markers and receipts are freshness/coordination
state, not protection against a same-user writer forging both artifacts and metadata;
filesystem identity fences are not an atomic filesystem sandbox.

Every consumer publishes a small pid+birth lease before it uses a prepared root (a
generation, an installed package never needs one, and a managed Pi runtime is leased for
the same lifetime), and every destructive pass preserves leased roots. A lease names the
native process that will actually run the code: a POSIX wrapper execs the launched
application, so the shared CLI binds its invoking parent's native pid rather than a
shell-provided number. Managed-runtime selection and lease publication are one
coordinated step, so an update cannot delete a runtime between selection and leasing; a
lease that cannot be published stops that selection instead of using unprotected code. The lease and the
selection decision are taken under one short coordination entry, so an update cannot
reclaim the code a live Pi, web, or sidebar process selected. Consumer inventories are
bounded: an incomplete or unreadable lease view skips reclamation rather than ignoring
consumers it could not see, and unknown entries are never deleted as stale leases.
Development-build, fallback-Node, and isolated-Pi caches each target **five
generations**, counted independently. Application preparation does not reclaim at
admission; one coordinated, lease-aware pass runs after the completed generation is
published, and a current start performs no cleanup at all. A build's npm
home/cache/temp residue stays inside its one generation; Pi stages and publishes inside
its own version root without an extra generation. Partial npm output stays in a
contained `.setup` directory until validated `node_modules` publication, so another
launcher cannot reuse a half-install.

Cleanup never refuses creation. Stale or malformed non-live lock artifacts are
reclaimed rather than permanently disabling pruning, and missing/malformed legacy
lifetime records do not protect cache contents. A live producer lock or actual cleanup
failure is reported as a bounded warning and the launch continues, so five or more legacy
generations can never block startup. One cleanup pass shares a single runtime budget and
deletes as it walks, so a large or deep generation makes real progress instead of being
refused forever by a whole-tree bound; the next preparation continues from what remains.
Each settled preparation (and each managed-Pi reuse) runs the same bounded pass toward
five and never treats the generation the launch is using, or any generation leased by a
live consumer, as a candidate.
Destructive reclamation and the session host's
ownership acquisition are mutually exclusive through the same per-agent coordination
entry described above: cleanup holds it only while it removes excess generations and
creates its own, rechecks the ownership record after any wait or stale-lock recovery,
and rechecks it again at every destructive boundary, so a host that becomes the owner
mid-pass keeps the remaining generations. When that entry is unavailable (a busy live
holder or an unremovable artifact) cleanup is skipped with a truthful warning and the
launch continues; a special leaf (FIFO, socket, or device name) inside the
producer-owned cache is unlinked without being opened. Active sessions stay protected by
the host's own
exclusive agent-directory ownership record; cache entries are not a second lifetime
gate, and no consumer is killed to obtain space. No age/size quotas, per-file creation
receipts, mount censuses, or checkpoint/history cleanup are added; the `.producer-active`
marker and the per-cache admission lock name their owner as `<pid>` plus a targeted birth
identity, so a reused pid never pins a generation, while a legacy pid-only record is still
honored for its genuine owner (a pid whose birth is not clearly after the record's mtime).
A birth query that temporarily fails is not a proven mismatch: a live destructive holder's
entry is honored (cleanup skips, ownership acquisition keeps waiting) instead of being
reclaimed as stale mid-deletion, and only a real different identity proves reuse.
An incomplete
fixed-name Pi version root that cannot be reclaimed falls through confined
`pi-<version>.<n>` generations without a fixed candidate limit, and later launches reuse
any valid generation for that exact version, so it also cannot stop startup. Settled failed or
aborted setup is reclaimed by a later cleanup, and an incomplete Pi installation can
retry the same version through identity-checked replacement. Ordinary package scripts
are unchanged.

The fallback Node wrappers reclaim excess direct-child artifacts before creating another
one, using the same best-effort rules; a failed deletion warns and the launch proceeds.
Pinned-digest verification, member validation, and fresh extraction stay on ACTUAL Node
installation or update; a previously completed fallback runtime is reused when its
recorded pinned identity, direct-child generation path, Node/npm entries, filesystem
identity, and cheap version probe all still match, so a warm fallback launch performs no
download, extraction, or tree scan. A reused runtime is protected by a per-consumer
pid+birth liveness record that every native reclamation route honors and that is
reclaimed once that consumer exits; a stale completed-runtime record is replaced by the
next successful installation instead of forcing a download on every later launch. The
currently marked generation is protected while a replacement installs. The supported PATH-Node route is unchanged. POSIX and native PowerShell both
recover a stale lock and never enter reparse points/links. Native Windows cache cleanup
is ordinary native deletion without a descendant-settlement claim; remaining Windows
host/ConPTY parity work is tracked separately. Protocol and native proof boundaries are
described in [Development](development.md#producer-owned-disposable-cache-cleanup).
Setup preserves trusted original `NODE_OPTIONS` and provider values while removing only
stale host capabilities. Before starting the host, the launcher also refreshes the
shipped skills under `~/.agents/skills/` from the same canonical publication manifest
as the review-gate wrapper — orchestrator (with its recovery runbook), execution,
research, and completion — followed by the ownership-safe pre-#151 generic-location
migration, so a direct sidebar launch needs no wrapper prerequisite; byte-identical
installed files are reused untouched on repeat launches. Setup failures stop startup
rather than falling back to a shell wrapper. Explicit, npm-global and PATH selections
inside a managed Pi generation keep the existing package/version validation and
alias-containment checks before the version probe, and the selected generation is
leased for the launcher's lifetime so cache cleanup preserves it.
Normal POSIX host shutdown keeps the existing ownership/cleanup guards for the agent
directory; cache cleanup is independent of the numeric exit status. Cache metadata is
coordination, not a same-user security sandbox. Installed compiled-package startup
does not inspect or clean the application build cache. The Pi and web launchers use the
same shared current/update decision and component markers.

## Starting and owning sessions

The host opens on a welcome/sidebar picker; it does not implicitly launch a Pi session
or treat its own startup directory as a workspace. It automatically restores its globally
persisted roster, so a host started from **any** launch directory begins with the rows it
remembered last time, in the same order — including a remembered row that could not be
restarted, which keeps its own position as a bounded error entry. Restoration runs before
any deliberate user
action is admitted, and the remembered active entry becomes the active Main input owner
only when no deliberate user action happened while restoration was still running, so a
slow restoration can never take over a user's own focus or action. Each **New session**
has one explicit **Workspace** field and one **Host** line; there is no separate host
display-label field. The Host line names **Local** every time the form opens: a Local
submission asks only for an explicit existing workspace directory, keeps the native path
editor and its completion, and immediately makes the created child the active Main input
owner without a second row Enter, with the sidebar still visible. A previous remote choice
is never carried forward, an actual Host change clears the Workspace value, and choosing
the same Host again is a no-op, so no per-host history is kept. Choosing one
already-connected saved destination makes Workspace plain bounded text for that owner's
filesystem and submits a single create request to that owner, which creates one blank
native child in its own run with no initial prompt (see
[Owner Create transport foundation](#owner-create-transport-foundation)). That Host
choice is not a Network destination action: it adds no destination, connection, pin, or
grant.

An authenticated top-level session-host child with the review-gate reporter also exposes
`SessionSpawn`; delegated executor children do not. It remains a native, owner-bound
tool: the child is created in its own hosting process through the same owner service,
without adding a network `SessionSpawn` RPC. The optional owner-create exchange later
in this page is a separate operation. `SessionSpawn` requires exactly an existing
workspace, title, and nonempty prompt. It creates a fresh native Pi process and
conversation in that workspace, without creating a worktree, clone, or branch. Native
settings and compatible inherited launch options remain shared, but the parent's
conversation name and startup message/file inputs are not inherited. The supplied title is
forwarded unchanged to Pi's native session-name API; Pi applies its own persistence
semantics, including trimming surrounding whitespace on the pinned 1.4.0 runtime. The
host does not crop or shorten titles to fit the sidebar, and titles longer than the
recommendation remain stored in full after Pi's native normalization. The prompt is
handed unchanged to Pi's public user-message API with prompt-template expansion disabled,
so leading `@`, `/`, and option-like text are prompt content rather than CLI inputs. It is
dispatched only after review-gate session initialization has established checkpoint scope
and deferred-tool authorization, and is recorded in the review request context before the
turn starts. The child is added in the background: its row appears without changing the
selected row, focus, active Main owner, or sidebar visibility. A successful result
confirms process launch only, not prompt processing or completion.

There is no fixed initial-prompt character or byte ceiling and no prompt-length setting.
Long handoffs use the same tool arguments as short prompts; callers do not need to
shorten the text or ask the child to load a file. The host transfers the complete exact
text automatically through private temporary payload files, keeping both authenticated
control frames and the child's startup environment small. Payloads are checked for exact
size, integrity, and file identity before consumption; nothing is truncated, summarized,
or substituted. Empty or NUL-containing prompts remain invalid. Existing title and
workspace safety bounds are unchanged. This is not an unlimited-resource guarantee:
filesystem, memory, native Pi, and model-context limits still apply. A transfer or initial
delivery failure is reported rather than treated as complete delivery. An uncertain
launch may already have created a child: inspect the sidebar before retrying; the tool
never automatically retries. Longer context grants no additional tool or role authority.
See [Security model](security-model.md#session-host-status-ipc) for temporary-payload
privacy and ownership boundaries.

The tool's title-width
suggestion is a host-computed snapshot of the sidebar title area in the visible layout
when that reporter child was launched; it is advisory and may become stale after a
resize. Ordinary launch, New-session, and saved-conversation behavior is unchanged.

The sidebar name comes from the observed native conversation metadata (the stored
native name or Pi's native first-user-message fallback). Until that metadata is observed,
the row reports that the session name is unavailable rather than inventing a user label.
A Local New's Workspace field uses Pi's native path completion, with relative
suggestions rooted at the host startup working directory; this does not select that
directory as the workspace. A New form whose Host line names a destination keeps plain
owner-interpreted text instead, with no requester filesystem completion or local path
interpretation. The New form's on-screen key cues reflect the current `keybindings.json`
in the shared native Pi agent directory. A genuinely absent optional file is silent and
uses Pi's real default form keys; an unavailable, unsafe, or unsupported file keeps a
bounded warning and the same default keys. The per-window Profile field is removed:
every child uses the same canonical native Pi agent directory, resolved from
`PI_CODING_AGENT_DIR` or Pi's ordinary `~/.pi/agent` default. That directory is fixed
user configuration, not a workspace selector. It (or its `.pi` parent) may still be
chosen as an ordinary session workspace: that child runs with that canonical directory
as its cwd while keeping the
same effective `PI_CODING_AGENT_DIR` and shared native configuration. Review of such a
non-Git workspace follows
[A workspace that contains the checkpoint store](review-workflow.md#a-workspace-that-contains-the-checkpoint-store).

Each host-created row owns a separate top-level native Pi process, selected workspace,
new conversation, input route, terminal frame, and lifecycle. Restoring a remembered row
is not process recovery: the host does not find, adopt, attach to, or revive an existing
or detached process, and it never guesses a newest file. Every remembered entry is
revalidated against a fresh saved-conversation listing and restarted only through a new
exact branded per-child `--session` admission as a new, independently owned child in that
conversation's **recorded** workspace. A conversation whose saved record now resolves to a
different workspace is refused instead of being launched there. A remembered entry that
cannot be freshly admitted — never saved, missing, ambiguous, replaced, unsafe, refused,
workspace-changed, or never observed to have a conversation at all — is not restarted and
is never replaced by a fresh session: it stays visible at its remembered roster position as
a bounded error row with a truthful reason until it is deliberately removed. Such a row is
never activatable: Enter on it refuses without moving input focus or changing the active
Main owner, so typing is never handed to a sibling session. The remembered identity is the
last observed
current authenticated native conversation, not the conversation the row originally
launched with: a native `/new` or `/resume` inside a row updates its remembered entry.
A row that never reports any conversation metadata, and a row whose launch failed, stay
remembered as identity-unavailable entries rather than disappearing; only an explicit
removal forgets a row.
All children naturally
share ordinary native Pi configuration and resources: settings, authentication,
models, keybindings, extensions, MCP configuration, skills, and provider environment.
The launcher refreshes the shipped skills before host startup (above); the host itself
does not clone those files, republish skills per window, create per-window credentials,
or require a separate login. It does not attach to existing or detached processes, adopt
them, or reparent work. Moving the sidebar highlight does not change the active
session. A single left-click on a displayed instance card invokes that row's existing
Enter action: activating a live row makes it the active Main input owner and focuses
Main, while sibling sessions continue running; exited and error rows retain their
existing Enter behavior and guards. A successful Local New submission or
saved-conversation open activates the created or restored child directly, without a second
row Enter; a successful remote New selects only the viewport of the returned owner run and
row (see [Owner Create transport foundation](#owner-create-transport-foundation)).
Enter on an exited row instead starts a new
owned process for its current observed conversation, using a freshly revalidated saved
entry. A positively never-saved binding can start fresh in the same workspace only when
the safe catalog confirms that exact conversation is absent. Unknown, ambiguous, unsafe,
or missing-known-saved bindings are refused; the host never substitutes the original
launch conversation or newest file. Successful replacement removes the old placeholder
without taking over a later focus, pane, or draft, and keeps the replaced row's roster
position and remembered active-slot mapping instead of reordering the roster; a failure
retains the old row and any
already-started child. Activating another session or hiding the sidebar
changes only display and input focus: it does not pause, stop, or transfer ownership of
any session. Background work can continue while another session is active. If the active
owner exits or disappears, the host does not automatically send input to a sibling.

**Saved conversations** is a deliberate, always-global picker in the sidebar. It lists the
shared native agent root's saved conversations showing each conversation's canonical
caption and, when the catalog recorded one, its workspace on one bounded line (long
captions/paths are visibly ellipsized) — never transcripts, tool arguments, question
text, or credentials. A small details area below the list shows more of the selected
caption and its recorded workspace, wrapped within its reserved rows: the full
workspace is shown only when it fits, otherwise it is explicitly truncated; a missing
workspace shows as unavailable, never a current-workspace guess. The picker opens on
this computer's **Local** catalog every time; choosing a connected owner instead is
described under
[Saved conversations on a connected owner](#saved-conversations-on-a-connected-owner),
and this section describes the Local catalog. Highlighting a row does nothing to any running session. Deliberately selecting a row
revalidates that exact catalog entry (file identity and first-line header) against the
live file and starts a new, independently owned child in that conversation's recorded
workspace with an exact per-child `--session` admission; it never adopts an external
process or attaches a child to another live conversation. A conversation already open in
this host is refused while its row is live or its creation is pending, and can be opened
again after that child has confirmed exit. The picker shows truthful loading, empty,
unavailable, and partial issue-count notices; Up/Down moves the highlight. Enter opens
the highlighted conversation, and a single left-click opens the clicked conversation,
only when that row belongs to the last emitted picker frame (a too-small fallback or an
undrawn/hidden row is refused). A queued redraw cannot authorize a newly mapped row:
click activation is refused while its changed hit targets are awaiting output.
A click uses the same exact-entry revalidation, admission, duplicate-open, and lifecycle
guards as Enter. Escape returns to the roster without pausing or stopping anything. A
successful open makes the restored child the active Main input owner and focuses Main
without a second Enter, with the pane still visible. A late listing or creation result
never takes over a later-opened or dismissed pane.

Type in the Saved search bar to filter this global catalog with native Pi `/resume`
query semantics (adapted from Pi 1.1.0 and unchanged in the pinned 1.4.0 runtime): fuzzy tokens, quoted phrases such as `"node cve"`, and
case-insensitive regular expressions such as `re:node.*cve`. Search covers the native
session ID, full stored name, native all-message text, and recorded workspace. Message
text is held only in a transient search index; it is never displayed in picker rows,
sent over status IPC, logged, or persisted in the roster. All tokens/phrases must match;
phrases ignore case and normalize whitespace. Unbalanced quotes fall back to native
whitespace-token matching (including the quote characters). The `re:` prefix is
case-sensitive; an empty or invalid regex yields no matches without crashing. Nonempty
queries use native relevance ordering with newest-modified ties; clearing the query
restores the catalog's existing recent-first order. There are no folder/global,
sort, named-only, path-display, or rename controls in this picker.

Plain `d` edits the search query. The native Saved delete action defaults to **Ctrl+D**;
**Ctrl+Backspace** is its noninvasive alias only when the query buffer is completely
empty (not merely whitespace). Deletion asks for confirmation of the selected saved
conversation: the native selection-confirm binding (Enter by default) confirms, and
the selection-cancel binding (Escape or Ctrl+C by default) cancels without changing the
file or row. On wide layouts, the complete confirmation replaces the right/Main pane
while the roster remains left; cancel restores the same right-pane picker, query, and
selection. Narrow layouts keep the existing full-content overlay. Other keys do not
confirm. Confirmation revalidates the exact catalog entry and file identity/header; it
never substitutes another path. Deletion tries the native `trash` command first, with
permanent unlink fallback when trash fails, and reports its actual outcome. Success refreshes the global picker; failure stays visible
without falsely removing its row. Only the selected eligible saved conversation file
is removed—not its workspace, sibling files, roster entries, or review metadata.

The host protects its current conversation by canonical file identity, and refuses
other conversations loaded by its owned children or reserved for a pending open with a
warning to close the conversation first. It never automatically stops or closes a
child to delete its saved file. An unavailable current-file observation (including an
older or disconnected reporter) cannot establish that a selected file is safe to
delete. The authenticated current path is private guard data, not sidebar display or
roster metadata. The host cannot discover conversations open in unrelated Pi
processes: close those windows before deleting their saved files. Search, confirmation,
cancellation, and deletion never change the active Main owner or a sibling's draft;
ordinary native `/resume` inside each child remains unchanged. The roster's `d`/Delete
stop/remove action below is separate and still never deletes saved files.

The native review-gate configuration is initialized with the ordinary zero-model
default only when no native/explicit configuration exists. Existing configuration bytes
and native resources are left in place. `/review-settings` continues to configure the
shared native setup, not one window in isolation. Shared setup is not account isolation
or a sandbox: every child has the same operating-system permissions and can use the
same provider credentials and native resources.

The host itself does not require Git merely to start a session. It adds no
question-only, no-worktree, or capture-bypass mode: the normal review, evidence-capture,
and delegated-execution policies still apply to native activity.

### One owning host, one session manager

Each session-host window is the single owner of its children. One local session manager
holds the authoritative conversation identity, lifecycle, and liveness facts, and the host
performs its session operations — starting a session, admitting an authenticated
`SessionSpawn` sibling, resuming an exited row, checking a saved-conversation deletion, and
settling its children at quit — against that one manager rather than against a parallel
copy of the truth. The sidebar projects the manager's current process/session facts;
remembered roster slots, their ordering, and the active selection remain separate
presentation metadata. Those remembered observations never become a second authoritative
process or status store. This ownership belongs to
one host process on one machine. A paired viewer on another machine may see a projection
of this manager's roster metadata, display one deliberately selected row's native
viewport, forward native input to it and receive its copies, ask this owner to close or
create a session, and browse, resume, or delete this owner's saved conversations (see
[Network sidebar](#network-sidebar-hosting-pairing-and-remote-metadata),
[Selected native viewport](#selected-native-viewport-interim-display-scope), and
[Saved conversations on a connected owner](#saved-conversations-on-a-connected-owner)).
Every such operation is performed by this host through this same manager. None of it
creates a second host sharing the same sessions, moves a process or conversation to the
viewer, or changes how each child's own terminal, local input, or local saved
conversations behave.

### Paired peer transport foundation

The source includes a TLS/WSS peer-transport foundation (#475). The optional native
session host uses it for the
[Network sidebar](#network-sidebar-hosting-pairing-and-remote-metadata); ordinary Pi
sessions and the standalone review-gate launchers never start it. The transport modules
themselves remain inert: importing or constructing them creates no keys, files, sockets,
or listeners. Explicit callers supply owned identity material, trust/grant stores and
local consent callbacks, then explicitly bind an address. A fresh host with no saved
network preferences and no explicit network action starts no listener and no connection.
With saved preferences, startup restores only what was explicitly saved: an enabled
hosting setting may restore a listener, and an eligible remembered Auto setting may
reconnect previously connected destinations. Those two roles are independent.

The foundation follows KDE-style explicit device acceptance, using generated self-signed
certificates and the exact peer key proved by TLS rather than public website PKI. Direct
IP operation needs no CA-issued certificate or domain name. Friendly names are bounded
display labels, never identity. First contact permits only bounded encrypted pairing
metadata; application channels require accepted identity plus a current receiving-side
grant. The client verifies the server key before sending HTTP headers or application
bytes. A grant for A accessing B does not authorize B accessing A, and an unexpected
remembered-key change is refused rather than silently accepted.

Accepting an unknown identity without independently comparing its fingerprint does not
defeat an active interceptor during first pairing. Later key verification protects
continuity, not the authenticity of that first acceptance. No mandatory QR/code ceremony
is added. Protected identity/trust storage is described below. The network sidebar
supplies the explicit pairing controls, saved connection preferences and bounded automatic
recovery; discovery remains unimplemented. The session-level protocols implemented so far
are the bounded roster-metadata channel described next, the single-row native viewport
lane described under
[Selected native viewport](#selected-native-viewport-interim-display-scope), the
[owner-routed Close](#owner-close-transport-foundation), and the rowless
[owner-routed Create](#owner-create-transport-foundation) that an explicit New-form Host
choice uses. The content lane also carries the native input and text-copy bridge that
normal production Main enables by default, with a per-viewer off setting (see
[Native input and copy](#native-input-and-copy)), and the roster lane carries the
optional owner Saved catalog exchange (see
[Saved conversations on a connected owner](#saved-conversations-on-a-connected-owner)).
`SessionSpawn` is unchanged: it remains the native, owner-bound tool inside a hosted
child and is not a network request. Human handoff remains unimplemented. Native
client-only mobile implementations can use this trust model;
ordinary browser WebSockets do not expose self-signed certificate pinning and are not
claimed supported.

### Explicit protected peer-state foundation

The source includes an explicit `openPeerStateStore({ agentDir })` entry point (#480).
It uses the actual platform permission policy rather than a caller-selected test probe.
Opening a fresh agent directory creates nothing; `initializeIdentity(label)` is the
separate explicit action that generates and publishes a new identity. Normal startup
never initializes an identity; only an explicit Enable hosting or Connect does, and only
when no identity exists. A single bounded, versioned document at
`<agentDir>/session-host/peers/state.json` holds the identity, accepted peers, directional
receiving grants and independent outgoing remembered-key slots. It stores trust, not
connection addresses, automatic reconnect preferences or a remote sidebar roster.
Connection addresses and automatic reconnect preferences live in the separate protected
preferences document described below; remote roster observations remain in memory.

The application does not encrypt this file at rest or require an OS credential-store
service. It verifies owner-only filesystem protection before secret bytes are written:
POSIX ownership/private modes and supported extended-ACL checks, or actual Windows
owner/DACL evidence. The store itself never repairs an existing unsafe file: it is
refused, and only the separate, human-confirmed
[permission repair](#repairing-network-storage-permissions) can tighten it. Unknown,
malformed, oversized, missing initialized state or mismatched certificate/key/receiving
identity is unavailable, never a fresh identity or empty-trust fallback. Initialization
cannot silently replace a previously used identity. Fixed errors do not expose private
keys or raw native diagnostics; same-account and OS-privileged access is outside this
protection boundary.

**Pair once, reconnect until revoked.** Reopening the same protected identity and stores
retains the exact peer keys and directional grants without approval on each connection or
session. Permission has no age-based expiry; disconnects and host restarts do not revoke
it. Each outgoing target has its own remembered pin, and A accessing B never grants B
access to A. Changed keys are refused, and a different receiving identity cannot inherit
old grants. A pending human-approval deadline is separate from that remembered permission:
the pairing callback exposes its configured deadline and a fixed settlement outcome for
host-owned notifications, not a grant-expiry timer or proof the peer received a
reply. The network sidebar's two-minute approval window is not a two-minute grant
lifetime.

Each synchronous store mutation publishes a complete candidate before making it usable
in memory. The host's separate acceptance and grant writes are not one atomic pairing
transaction; both current facts are still required. Uncertain publication invalidates the
handle rather than asserting a successful rollback. File sync, atomic publication and
best-effort directory sync are scoped guarantees, not a power-loss guarantee. This is a
single-writer component under the existing owning-host lifecycle, not another daemon or
an arbitrary multi-process database. Windows storage tests are filesystem evidence only,
not native terminal UI readiness. The network sidebar is the explicit human-accessible
pairing surface built on this foundation; starting a host still initializes nothing by
itself.

### Remote roster metadata foundation (metadata only)

The source also includes a metadata-only roster bridge over that peer transport (#478).
The network sidebar attaches one viewer per connected destination, so the bridge is
reachable from the optional native session host. Ordinary Pi, the standalone launchers,
and importing the modules still start no networking by themselves. Existing local owner,
viewer, and passive behavior stays fully active. The transport it uses is ordinary
TLS/WSS, not a stub.

The owner side observes the same single local session manager that already backs local
session operations, through a coherent snapshot-and-watch seam keyed to a fresh owner
service-run identity and monotonic observation revisions. It publishes one bounded,
versioned roster-metadata snapshot and bounded live updates over an explicit paired
channel. A full snapshot is assembled and applied as a whole, fenced to the current
subscription, owner run, and observation revision, so an older, duplicate, or
partially applied update cannot regress or mix a roster. Authority is rechecked against
the current accepted peer identity and the current receiving-side grant. Stopping a
subscription or disposing the bridge releases only that observation; it never shuts
down, pauses, or stops owner sessions.

Each published row carries only display-oriented roster facts: the stable row id, title,
the exact owner-side workspace path, lifecycle, live-process and input-surface
observations, busy and pending-input observations, generic activity lines, the canonical
native conversation identity (session id, epoch, and observed native name), separate
ownership and activity-intent counts, a known exit code, and bounded display-safe error
text. Unknown and absent observations stay unknown — never idle, zero, or false — and
ownership counts stay separate from the displayed activity-intent counts, exactly as
locally. The native current-file guard, agent/account directories, configuration,
provider and credential data, prompts, transcripts, question text, terminal or output
bytes, and image data never enter a row. The metadata projection does not alter, filter,
or rebuild native session-pane contents, which remain the owner's own terminal. Error text
is stripped of terminal-control hazards and recognizable credential patterns and bounded
to a display-safe message with a fixed fallback; that is not a blanket
arbitrary-secrets guarantee, and nothing here globally scrubs native pane or workspace
data. Workspace paths are exact owner-side values: bounded, never resolved, rewritten,
or redacted, with rendering sanitizing its own cells.

One owner is unchanged: session ownership stays with the owner host, and a client holds
only a projection of it. A lost projection — a disconnect, a stopped subscription, or an
unavailable owner — means *not current*, never idle and never zero. No second
controlling host, separate ACL, exclusive-controller lease, or new revocation lifecycle
policy is added.

The roster projection itself stays metadata-only: connecting a destination adds no
terminal content, input, or session operation by itself. The base `roster-v1` capability
cannot create, stop, or close an owner session; the separate optional
[Close](#owner-close-transport-foundation),
[Create](#owner-create-transport-foundation), and
[Saved](#saved-conversations-on-a-connected-owner) capabilities each add explicit
owner-routed operations without requiring a content selection. A deliberate selection can display one exact
row's native viewport (see
[Selected native viewport](#selected-native-viewport-interim-display-scope)); every other
row stays metadata-only. That is an implemented protocol scope, not a view-only permission
kind or a controller lease. See the network sidebar's operational behavior and optional
manual comparison next.

### Network sidebar: hosting, pairing, and remote metadata

The optional native session host exposes a **Network** entry in its sidebar when the
network UI snapshot is attached. Ordinary Pi sessions and both standalone review-gate
launchers are unchanged and have no Network entry. The sidebar is a pure display and
command frontend: one coordinator owned by the host performs every listener, client,
consent, trust-store, and preference write. Remote rows never become local sessions: they
are typed remote cards, not fabricated local entries, even when an owner-supplied row id
collides with a local one.

**Fresh start versus saved state.** With no saved network preferences, a fresh host
creates no peer keys or identity, no preferences or trust document, no listener, and no
connection. Starting a host initializes no network state: it reads saved state, then
restores an explicitly saved hosting setting and schedules an eligible remembered Auto
setting, but never creates an identity, starts discovery, or silently chooses an address
or port. The first explicit Enable hosting or Connect creates an identity when none
exists. Hosting is initially off. With no saved listen address or port, the Network pane
prefills the editable suggestion `*:8088` in the separate Listen address and Listen port
rows and in their editors, so Enable or Apply can be chosen without typing first; `*`
requests one dual-stack listener that accepts IPv4 and IPv6 on that single handle, and an
explicit `0.0.0.0` is an IPv4-only request. The suggestion is a local draft only: it is
not written to the saved settings, and nothing is bound, saved, or created until an
explicit action. A saved address and port stay shown exactly as stored, an unsaved edit
stays visible until the next explicit action, and unavailable settings stay unknown and
keep Enable refused. The pane shows the address and port actually bound, with a bound
IPv6 endpoint written `[::]:8088`. Disabling hosting stops the listener and keeps the
saved setting; the address and port the operator submitted are the only bind input, no
other address or port is substituted, and a failed bind is reported rather than retried
somewhere else. There is no daemon between host runs.

**Destinations, pins, and approval.** Each saved destination is a local alias and
endpoint with its own remembered server key; saving a destination creates no key, socket,
or connection. When first pairing is needed, Connect requires the receiving person to
approve the incoming request and the connecting person to confirm the
exact server key their TLS handshake actually proved. The approval window is two minutes
and is a human deadline, not a grant lifetime. Consent is shown with the immutable name,
fingerprint, and endpoint captured when the request arrived (an endpoint that was not
provided stays unknown), and its controls become actionable only after that exact dialog
has actually been written; a resized or semantically changed dialog must be written again
before it can approve or deny anything.
Incoming requests also raise a persistent, non-focus-stealing alert in the roster, and a
bell is attempted once when the request arrives when the remembered bell setting is on
(it defaults on and can be turned off); the visual alert persists with the bell muted.
The alert is not a modal and never takes focus or changes the selected native owner. When
the roster is hidden or too narrow for a usable pane, a bounded alert band reserves real
rows and may resize or reflow the local child; it renders no approval control.

Association is one-time and persists until revoked, with no age-based expiry. Reopening
the same identity and trust store needs no repeated approval. A changed key, missing
initialized trust, or unsafe/corrupt store fails closed: it is reported with a fixed
reason and is never re-paired, rotated, or overwritten. Only an unsafe-permission refusal
can be offered the explicit, confirmed
[permission repair](#repairing-network-storage-permissions), and an explicit Connect does not replace a
changed remembered key. Independently verify the intended identity before choosing to
Remove and re-add a destination to confirm a new key.
Receiving approval is directional: A approving B lets B connect to A and does not grant A
access to B.

**Remembered settings and automatic recovery.** Auto reconnect is off by default. When
enabled, it recovers only previously connected destinations after host start or an
unexpected loss, and only when a pin is currently remembered, no explicit suppression
applies, and no terminal authorization failure has occurred. It never prompts for an
unknown key, never pairs automatically, and never replaces a changed pin. The bounded
retry schedule is owned by the coordinator and is cancelled on Disconnect, Remove,
turning Auto off, or host close. A healthy connected destination is not stopped by
turning Auto off. Disconnect keeps the association but persists suppression until an
explicit Connect, including across host restarts.

The Network pane also shows **Remote input/copy** (this viewer only; Enter toggles it) and
**Allow remote history deletion** (this host's owner policy; Enter toggles it), each with
its saved on/off value; see [Native input and copy](#native-input-and-copy) and
[Saved conversations on a connected owner](#saved-conversations-on-a-connected-owner). Like the
other toggles, Enter or a click acts only on the state the drawn row displayed (a click
additionally needs that row's written frame), and an unknown settings value sends nothing.

**What each action does and does not do.** In the Network pane, Enter opens the
highlighted control or row, and `c`, `x`, `r`, and `v` connect, disconnect, remove, and
revoke the highlighted destination or receiving permission. Add destination opens a field
menu whose Name, Host, and Port rows each edit one local draft value in any order: the
editor shows only the chosen field and the other two drafts stay on the menu; Enter
saves that field and returns to the menu, Escape abandons only that edit, and the
destination is sent only by the menu's single Add destination action, which validates all
three values first and then returns to the Network pane; leaving the menu sends nothing.
A single left-click on a row the pane actually drew performs that row's ordinary Enter
action once through the same activation path — it selects a destination, opens a field or
the Add menu, or opens a pending request's review — and it decides nothing that Enter would
not. A press whose drawn row, pane geometry, or displayed state has since changed is
refused instead of retargeted, and releases, drags, and non-left buttons activate nothing
and are never forwarded to a native child.
Removing a destination forgets only this side's saved endpoint and local remembered pin;
re-adding it requires
confirming the key again. It never revokes the other host's receiving grant and never
stops its sessions. Revoke removes only this side's current receiving permission for that
peer; it does not change the opposite direction, stop a session, or shut down the owning
host. When this host is the viewer, its own Revoke leaves an existing outbound view
intact: that view uses the owning peer's separate receiving grant. Revocation by the
owning peer makes the selected display unavailable. None of Disconnect, Remove, or Revoke
stops remote work. A receiving grant has no view-only
variant: displaying the selected row's native viewport is part of the same implemented
display scope, not a separate permission kind. Remote input forwarding and copy travel
only through the default-on [native I/O bridge](#native-input-and-copy); this viewer's
**Remote input/copy** setting turns forwarding off for its own displayed remote pane, and
the separate **Allow remote history deletion** setting is this host's owner-side policy.
Neither setting is changed by, or changes, Disconnect, Remove, Revoke, Hosting, or Auto.

**Ownership and shutdown.** Several destinations may be connected at once. Every
destination's rows project into the same existing left roster as typed remote cards, and
exactly one displayed session supplies content for this host's pane: either one selected
local row or one deliberately selected remote row, never both. A remote card is a
separate typed entry, not a local session row; it shows the owner-side roster facts and
honest current or stale state, and Enter or a drawn left click on it selects that row's
native viewport for display (see
[Selected native viewport](#selected-native-viewport-interim-display-scope)) without
changing any local row's process, input ownership, saved state, or the roster. Remote
keyboard, canonical mouse, whole text paste, and text copy travel through the default-on
[native I/O bridge](#native-input-and-copy) while this viewer's Remote input/copy
setting is on. A deliberate New-form Host choice can ask one connected
destination's owner for one blank child, as described under
[Owner Create transport foundation](#owner-create-transport-foundation), and the Saved
picker can browse, resume, and delete one connected owner's saved conversations, as
described under
[Saved conversations on a connected owner](#saved-conversations-on-a-connected-owner).
`SessionSpawn` remains the native, owner-bound tool described above, and human handoff
remains unimplemented. Close uses the highlighted remote row and its owner,
independently of the displayed stream. Host shutdown
closes only this host's owned local network
resources and waits for that local settlement; an unconfirmed close is reported and
retains agent-directory ownership. It never waits for a remote receipt or remote work.

**Remote card display.** A remote row's left card uses the local card layout and facts:
the title, the same status line, the same background activity counts, and the same
activity lines under the existing activity-only collapse. It adds exactly one owner line
— an indented `host <label>` line directly below the title, where the label is the
destination's bounded local display name, never an identity claim — and it shows no
workspace path. That one line is clipped with the card's usual ellipsis when the label is
unusually long, rather than wrapping or widening the card, and the honest stale marker
leads it so a long label cannot hide the observation. The leading selection marker is
omitted in this example:

```
Build runner
  host studio-mac
  agent idle | input none
  bg tasks 0 | shells 0
    Ready
```

The exact owner-side workspace path and the rest of each row remain transported roster
metadata exactly as before; this is a readability change to the left card only. Network
details, selection, Enter and drawn-click actions, and activity-only collapse are
unchanged.

**Settings and trust storage.** Hosting intent, the Auto and bell settings, the
viewer-side **Remote input/copy** setting, the owner-side **Allow remote history
deletion** policy, and saved destinations are kept in a protected preferences document
below the session-host state directory, separate from the key/trust document. The two
newer settings are optional in that version-1 document: absent means on, and only an
explicit Off is written, so an existing valid document keeps working unchanged. Saving a
setting such as muting the bell or turning Remote input/copy off never creates an
identity, a `peers` directory, key material, or a listener. Both documents require
verified operating-system protection before private or preference bytes are written;
they are not encrypted at rest and use no OS credential-store service. Existing unsafe,
malformed, unknown-version, or missing-initialized documents are refused untouched and
never reset or rotated; opening, reading, or saving never repairs them. The one exception
is the explicit permission repair described next, which changes only protection.
Same-account and OS-privileged access remains outside this boundary.

Trust, storage, and consent boundaries are detailed in
[Session-host peer network](security-model.md#session-host-peer-network-optional).
This sidebar changes no Windows, native-mobile, browser, or physical-input certification
claim; the alpha platform limitations above still apply.

**Optional two-host comparison.** To check the current alpha by hand on two machines,
run the optional `pi-review-sessions` host on each. On host A, open **Network**, review or
edit the prefilled listen address and port, apply, and start hosting; on host B, add a
destination for A's address and port and press Connect. Compare each host's displayed
identity key
with the fingerprint the other host shows for approval through an independent channel if
you need to rule out an active interceptor during first pairing, then confirm the
server-key dialog on B, approve A's incoming request, and compare B's remote rows with
A's local roster. Select one of those remote rows on B and confirm its owner's native
viewport appears while A keeps running and B's own local sessions are untouched. With
B's Remote input/copy on, type a harmless unsent draft into that pane and confirm it
appears in A's session without changing A's own focus; then select a local row on B and
confirm the remote stream is released rather than retained. Open Saved on B, change its
Host line to A, and compare the rows with A's own Local Saved picker without resuming or
deleting anything you want to keep. Disconnect on B and confirm the rows become stale, then remove the destination on B and
confirm it forgets only that endpoint and local pin.
These are optional manual alpha checks, not an installation, support, release, or
cross-machine readiness claim; CI does not run them.

#### Repairing Network storage permissions

When a protected Network document or one of its fixed directories cannot be used, the
Network pane says why instead of using defaults: settings, Hosting, Auto, destinations,
and the identity stay unknown, and nothing is created. Each refusal names one fixed
reason and one fixed item by its conventional name below the Pi agent directory
(`session-host`, `session-host/peers`, `session-host/peers/state.json`,
`session-host/peer-preferences`, or `session-host/peer-preferences/preferences.json`),
never a resolved path, error number, mode, account identifier, or native output:

| Reason | Meaning | What to do |
| --- | --- | --- |
| Access beyond your account | Broad owner/mode bits or Windows access entries | Use **Repair permissions** when offered, or restrict the item yourself, then restart Pi |
| Extended ACL entry | A macOS ACL grants another account | Use **Repair permissions** when offered; an ACL the repair cannot prove is refused, so remove that entry yourself |
| Link or unexpected object | A symlink, junction, other type, or extra hard link | Replace it with a real item you own; it is never followed or changed |
| Another owner | Owned by a different account | Have ownership returned; it is never taken over |
| Protection not verifiable | The platform or Windows helper cannot prove protection | Nothing is changed; on Windows check that Windows PowerShell is available |
| Unreadable | Access denied or an I/O error | Check your access and the disk |
| Damaged | Empty, oversized, unparseable, or an unknown version | Restore from a backup; for the identity see the manual replacement below |
| Document missing | An initialized directory without its document | Restore it, or follow the manual replacement below; no key is generated |
| Changed while checked | The item changed during the check | Make sure nothing else modifies it |

Showing a refusal performs at most one read-only eligibility check, and only for an
access-permission refusal; it never runs while drawing the pane or on a timer. When every
present fixed item can be tightened and none is refused, the pane offers **Repair Network
storage permissions**. Otherwise it says why no repair is possible. The repair is offered
only while Network owns no listener, connection, connection attempt, or unconfirmed
teardown; disable hosting and disconnect first. Pending automatic retries are cancelled
without saving any Disconnect intent, and local or remote sessions are not stopped.

The repair always opens a confirmation first, with Cancel selected. It lists the five
fixed items and what happens to each (repaired, already protected, or absent and not
created) and the new protection: owner-only access with no other account's ACL entry on
POSIX systems, or a protected access list for only your account, SYSTEM, and
Administrators on Windows. It states that contents, the identity key, pins, receiving
grants, saved settings, and destinations stay byte for byte and that ownership is not
changed. It also states that the agent directory, its parent folders, and every other
file are not touched, and that nothing is created, deleted, or swept recursively. It
warns that repair cannot undo earlier access and recommends separately replacing the
identity key if another account could have read it, and that Network stays unavailable
until you restart Pi. Repair acts only from the exact confirmation the terminal actually
wrote, with Repair chosen. A resize, a changed assessment, a hidden or too-small dialog,
Cancel, Escape, a repeated key, or pasted text requests nothing. The host re-checks the
written frame, Network inactivity, and a fresh read-only assessment equal to the one
shown immediately before changing anything.

The repair never hosts, connects, creates a key, reopens a store, restores saved Hosting
or Auto, or retries. When protection changed, or may have partly changed, Network stays
unavailable with a persistent restart status, and every Network action is refused until
you deliberately restart the host. A refused or unnecessary repair changes nothing. The
repair cannot revoke handles another process already holds or prove that earlier exposed
state stayed secret; it never rotates or deletes a key automatically. If exposure was
possible, follow the manual identity replacement below after the restart.

Creating Network storage is separate. A missing `session-host` directory is created
private at creation, and a first save creates its private directories and document. When
that private protection cannot be proven at creation (for example under some inherited
macOS ACLs), the directory may still be created for local session-host use, but Network
refuses it as unsafe and claims no protection. It then needs this explicit repair; it is
not repaired automatically.

These behaviors are covered by focused tests of the real coordinator and storage backend
on POSIX, sidebar and Main confirmation tests, and an opted-in native-Windows ConPTY
companion acceptance described in [Development](development.md#network-storage-permission-repair-494).

#### Manually replacing the network identity

Repairing the protection of the trust document never changes its key or bytes: the
identity, outgoing pins, accepted peers, and receiving grants are kept. Neither a
permission repair nor a replacement undoes an earlier disclosure: if another account could
read the document, assume its private key was copied. The application has no automatic
key rotation, reset, or deletion. Retiring this host's key is a separate manual choice,
and this is the only supported way to do it. It discards every pairing and leaves this
host's network unavailable until you pair again.

Do not delete `state.json` alone. A `peers` directory without its document is refused as
unavailable on every start; it is never treated as a fresh identity, and no key is
generated.

1. **Coordinate with paired peers.** On each host paired with this one, Revoke this
   host's receiving permission and Remove the destination for this host. Replacing the
   key here revokes nothing elsewhere: until each peer does this, a copy of the old key
   can still authenticate to that peer as this host.
2. **Turn off saved intent.** In this host's Network pane, disable hosting and turn Auto
   off, so the next start does not try to restore either one.
3. **Settle and quit.** Let local sessions and network work finish, then quit normally
   (see [Quitting and cleanup](#quitting-and-cleanup)); do not force-stop busy work.
   Continue only after the host has exited and released agent-directory ownership. A
   running host keeps using the old key from memory.
4. **Quarantine the whole directory.** Confirm that `<agentDir>/session-host/peers` is
   the real directory for this agent directory and that it is private and owned by your
   account. Create a private, owner-only directory outside the agent directory, on the
   same filesystem, and move the entire `peers` directory into it. Leave
   `peer-preferences` and every other file in place. If the path or ownership is uncertain,
   or the quarantine or its parent cannot be made private, stop.
5. **Restart.** Opening the trust store creates no key. Saved preferences and
   destinations remain, but outgoing pins, accepted peers, and receiving grants left with
   the moved document, and Auto skips destinations without a pin.
6. **Create the replacement deliberately.** Choose Enable hosting or Connect. Only that
   explicit action generates the new identity; confirm that the shown fingerprint changed.
7. **Re-pair both directions.** Each direction needs a new approval; compare fingerprints
   through an independent channel. A peer that still remembers the old key refuses this
   host with `PEER_KEY_MISMATCH` until it Removes and re-adds the destination; Connect
   never replaces a changed pin.

**Undoing before step 6.** Settle and quit again, confirm that
`<agentDir>/session-host/peers` is absent, move the quarantined directory back without
overwriting anything, and restart. The peers' Revoke and Remove actions from step 1 are
not undone.

The quarantine still holds the old private key. Keep it private until you deliberately
destroy it, and note that deleting a file does not guarantee erasure from SSDs, snapshots,
or backups. Same-account and OS-privileged access remains outside this boundary. This
sequence has been checked on macOS only; Linux and Windows have not been exercised.

### Selected native viewport (interim display scope)

The source can also display one deliberately selected remote session's native viewport
(#389). Remote rows from every connected destination project into the **same existing
left roster** as typed remote cards — there is no second sidebar, authoritative roster,
session manager, listener, or daemon. Each card identifies its owner host and row; a
selection carries the observed owner run, or honestly records that it is unknown.
Exactly one native content stream is selected
at a time across all destinations for this viewing sidebar. Local and remote selection
identities stay separate even when an owner-supplied row id happens to equal a local one,
and remote metadata never becomes local process, input, or trust authority.

Selecting a remote card (ordinary Enter, or a drawn left click on it) asks that owner for
the row's native viewport, and the pane then shows that viewport: ordinary visible Pi and
conversation text with its generated SGR styling, cursor, Unicode cells, and the bounded
typed Kitty PNG images, placements, and text fallbacks the native surface already
produces, drawn through the existing compositor, graphics layer, and bounded writer. It is
deliberately not a transcript, not a raw PTY or terminal-control stream, and it carries no
separate private configuration, provider/credential, authentication, current-file,
structured-question, or hidden telemetry records. Rows that are not selected stay
metadata-only, and the owner
watches only the subscribed row, so a session nobody selected is neither captured nor
resized for this viewer. Visible terminal text can itself be sensitive, and displaying the
deliberately selected row is the intended behavior of this slice. There is no text-only or
no-graphics shortcut. The 64 KiB bound is one protocol message, not a whole-viewport
ceiling: a complete viewport is carried as one bounded begin/chunk/end transfer with a
defensive 64 MiB assembly ceiling.

Transport and authority are unchanged. The viewer opens the additive
`pi-peer-content-v1` lane on the same TLS/WSS `/app` upgrade as the roster lane, on the
same listener, with the same exact TLS-proved peer key, the same current remembered pin,
and the same directional receiving grant. This adds no listener, daemon, manager,
permission kind, controller lease, or stored state, and it never pairs automatically or
replaces a changed pin; a sending result still never claims the owner wrote or the viewer
rendered anything. The owner side is the same owning service over the same single session
manager that already supplies the roster: it reads that manager's inventory snapshot to
fence a subscription against the exact observed owner run and row, takes one read-only
content watch on that row, and registers this endpoint's own independent viewer
contribution, so the ordinary per-session geometry minima apply and no other session is
touched.

Selecting a remote row retires only this viewing surface's local participation: it no
longer displays that local row or contributes its geometry or input, and every
local and remote child keeps running. `n`/No session, Main focus, and passive behavior
remain exactly as described elsewhere in this page, and a session with no viewer keeps its
last canonical size. New session starts on Local while a remote row is displayed, so an
ordinary New never redirects creation to the remote owner; a deliberate Host choice on
the New form can still target one connected destination, and a late completion cannot
replace a later deliberate selection. A lost connection, Remove, Disconnect, or
revocation by the owning
peer makes the selected display unavailable without stopping remote work. The deliberate
target stays selected and the pane shows a host-owned status instead of another host's
content, a local session, or a silent fallback. Replacing one selection with another — remote A,
remote B, local, or none — first retires the one stream through the coordinator's bounded
settlement barrier, so streams are never stacked and a retirement never becomes a second
selection. This confirms only local retirement, not an owner acknowledgement or remote
settlement; the owning side independently retires its own subscription resources.

Display authority is fenced, not inferred. A published viewport must still match this
sidebar's own selection generation, destination, owner run, and owner row; it must carry
the owner's subscription identity, a monotonic publish sequence, the canonical geometry and
its revision, and the exact native conversation tuple when one is known, and its frame
must match that geometry. Only the frame the writer actually committed identifies the
drawn source. A queued, held, superseded, covered, or unchanged candidate for a new
semantic source cannot authorize a click or copy. Repainting the same accepted frame does
not invent a new source receipt. Input modes and cursor facts carried with a
viewport are inert observations for rendering; they grant no input.

Keyboard, canonical mouse, whole text paste, and text copy travel through the
[native I/O bridge](#native-input-and-copy), which normal production Main enables by
default; this viewer's remembered **Remote input/copy** Network setting can turn
forwarding off for its own displayed remote pane only. While it is off, native-pane
keyboard, paste, and mouse packets are not forwarded to the remote owner (one brief fixed
notice says nothing was sent), and no local child ever receives them on that stream's
behalf. That setting is a per-viewer preference, not a permission kind, grant, or
owner-side policy. A deliberate New-form Host choice can create one blank child through
the owner-routed Create capability described below, and the Saved picker can reach one
connected owner's saved conversations (see
[Saved conversations on a connected owner](#saved-conversations-on-a-connected-owner)).
`SessionSpawn` remains the native, owner-bound tool described above rather than a network
request, and human handoff is not implemented. The owner-routed Close controls are
described below.
Authenticated local and SSH clipboard copying, ordinary standalone Pi, and local host
input are unchanged: nothing is broadcast, a remote copy reaches only its initiating
viewer, raw PTY OSC 52 stays denied, and no last-input-origin inference is added. Native
Pi clipboard-producer coverage keeps the limits the
[clipboard section](#clipboard-copying-over-ssh) describes.

### Owner Close transport foundation

An optional `roster-close-v1` capability adds exact owner-run/row Close requests to
that owner's existing paired roster channel. It is acknowledged only when the host
has a real owner Close provider. An older peer or a host without that provider is
unsupported, not silently upgraded or connected on demand. The current TLS-proved
peer key, pin and directional receiving grant still gate each request and reply;
capability negotiation grants no authority.

The provider reuses Main's one manager, stop ladder, and roster-removal bookkeeping.
It needs no selected content stream, native conversation tuple, viewer, or controller
lease. Unconfirmed requests recheck positive idle on the owner; busy or unknown activity
returns `confirmation-required`. Requesters supply the confirmed flag only after explicit
confirmation on the requesting sidebar. Confirmed requests use only the existing
bounded stop ladder. Only the manager's actual exit or settled-error removal authority can
remove a row; saved conversations are never deleted. Different rows may close in
parallel, while a pending close never starts a second ladder for the same row.

Fixed results distinguish removal, stopped-but-retained, confirmation required,
unconfirmed, refused, busy, and unknown. The requester does not optimistically delete
a row: only the owner's roster observation changes that projection. Once a send was
attempted, a lost reply or uncertain write remains unknown and is not replayed.
Disconnect, Remove, Revoke, or dismissing requester UI cannot cancel a stop the owner
already accepted; network teardown does not establish process settlement.

With the left roster focused, `d`/Delete acts on the remote row the host actually
wrote as its complete highlight, not a queued logical selection or the displayed
content stream. Positive idle permits a direct request; busy or unknown activity
opens the existing left confirmation pane. The exact target, confirmation generation,
render token and current geometry must have a real writer receipt before confirmation
can submit once. Held, tiny, clipped, stale or superseded frames authorize nothing;
a changed native conversation tuple or content epoch is not a Close prerequisite.

If the owner reports `confirmation-required` despite a cached idle card, the next
deliberate Close opens confirmation; it never opens automatically or replays the
request. Every still-addressable target retains that reminder until it is acted on or
positive owner/run/row disappearance or settlement makes it obsolete. An exited or
settled-error row still sends removal to its owner, not local deletion. Local Close,
Quit, saved-history deletion and stream selection are unchanged. Close itself enables no
native input, paste, copy, creation, or resume; native input, paste, and copy are the
separate [native I/O bridge](#native-input-and-copy), and creation is the separate rowless
capability described next.

### Owner Create transport foundation

An optional `roster-create-v1` capability adds rowless owner-create requests to that
owner's existing paired roster channel. It rides the same authenticated
roster-metadata lane on the same listener and TLS/WSS `/app` upgrade, and it is
acknowledged only when the host really holds its own create provider. An older peer, or
one without that provider, is unsupported rather than silently upgraded, paired, or
connected on demand: the New form reports one fixed notice and sends nothing. The
current TLS-proved peer key, remembered pin, and directional receiving grant still gate
every request and reply, and capability negotiation grants no authority.

One request names only this owner's exact run, one canonical workspace, a fresh
correlation id, and a per-channel monotonic attempt number. It carries no row id, native
conversation tuple, epoch, input mode, viewer, selected stream, displayed row, or path
decision, so an owner whose current roster is empty is a valid first target. The owner's
provider reuses the same one manager, run identity, and launch path as its own local New,
with only the workspace: no duplicate fence, workspace deduplication, path resolution,
trimming, activation, or focus change. The owner's own local Main owner, selection, and
drafts stay exactly as they were. No new creation prompt or extra creation notice is
shown to the owner; normal roster updates and runtime/persistence warnings are unchanged.

Requester-side facts are checked independently of the owner's. Admission and the final
transport write re-check the observed exact owner run, the remembered pin against the
channel's TLS-proved key, this side's identity against the borrowed client, and the
destination channel and epoch. The New form adds its own fences: the exact drawn,
uncovered frame the writer actually committed, its host identity and owner run, its
canonical workspace, its pane geometry and geometry epoch, and one request receipt that
is consumed before dispatch. The caller's written-form check is evaluated first inside
the ordered write and the owner facts are re-checked after it returns, so a stale caller
cannot submit anything by itself. One create is in flight per channel; a second is
refused rather than queued, evicted, or retargeted. The attempt number is a monotonic
anti-replay scalar, not a newest-answer fence: a duplicate or older number is refused
before the provider is reached, and a later request never cancels a child or drops an
earlier result.

Workspace text is the exact canonical value the form held, inside the form's own existing
bound of 2048 code points and its derived 8192 UTF-8-byte ceiling. Nothing is trimmed,
resolved, normalized, or substituted by the transport, and the owner applies its own
existing launch semantics; spaces, slashes, and Windows backslashes are preserved. No new
listener, manager, queue, replay cache, registry, permission kind, controller lease, or
stored state is added.

Fixed owner facts are the whole answer. `started` means this owner's manager created a
row in the exact requested run that is alive with a live process in the owner's own
post-create inventory; it claims nothing about agent execution, native readiness, a
durable roster write, or a requester/client receipt. An addressed create that produced
nothing usable is `unconfirmed`, and it may have left an error row behind. `refused` is
reserved for authority this host positively established before any create was invoked.
`unknown` claims nothing either way, and it is also what a lost reply, an elapsed
patience window, a retired destination, or an unreadable inventory produces. The
requester's patience is one fixed 15-second window on its own side only: it is not the
owner's deadline, it does not cancel the owner's create, and a timeout is never retried.

Nothing local is fabricated by a request: no local row, child, or input owner is created
or accepted. Only the owner's roster projection lists the new row, so no optimistic row
exists; until that projection arrives the pane reports that it is waiting for the row.
A `started` answer displays that exact returned run and row only while the same request
still owns the form; a superseded, dismissed, or newer form is left untouched. Every
refusal or uncertainty is reported as a brief, non-modal, fixed notice that carries no
payload, path, exception text, retry, or automatic re-send. Local New, Close, Quit, saved history,
hosting settings, Auto, the
editable listen default, and protected identity/pin persistence are unchanged.
`SessionSpawn` is not replaced: it stays the native, owner-bound tool described above.
Remote New does not add or require a network `SessionSpawn` RPC.

### Saved conversations on a connected owner

The Saved picker can show the complete saved-conversation catalog of one chosen owner
host: browse it, search it, resume a conversation there, and, when that owner allows it,
delete a saved conversation there. It uses an optional `roster-saved-v1` capability on
that owner's existing paired roster channel: the same listener, TLS/WSS `/app` upgrade,
TLS-proved peer key, remembered pin, and directional receiving grant as every other
owner request. The owner acknowledges it only when it really holds its own Saved
catalog provider and live delete policy; acknowledgement is protocol support, not
authority. No second daemon, listener, manager, authority registry, history store,
index, transcript copy, or controller lease is added.

**Choosing a host.** The picker opens on **Local**, meaning the computer running this
sidebar, never the host of a currently displayed remote row, with a blank query every
time. While a connected destination can be offered, the picker shows a Host line that
selects Local or one connected owner. An actual Host change, in either direction, clears the query and
every result; choosing the same Host again changes nothing, and no per-host query
history is kept. Opening Saved or changing its Host never resumes anything and never
changes the displayed or active native row. An owner whose roster is empty is a valid
choice: Saved needs no displayed row, native conversation tuple, focus, or geometry. A
connected owner without the capability, such as an older version, is an unsupported
choice. Choosing it shows one fixed brief notice and requests nothing, with no fallback,
upgrade, automatic connection, or new grant.

**What a remote row shows.** Each row carries exactly what the owner's own Local picker
row holds: the native session id, the saved conversation file path, the canonical
caption, and the recorded workspace. They are the owner's own values, unclipped and
unredacted, and they are drawn through the same row, details, and confirmation
formatter as a Local row, so the chosen host's picker looks as it would on that host.
The full saved file path is shown wherever the Local picker shows it. A Windows owner's
paths appear verbatim on a POSIX viewer. These values are display data only. Every
Resume or Delete request names only opaque owner-issued catalog, result, and entry
handles plus the exact owner run. The requester never resolves, completes, opens,
stats, or deletes a displayed path on its own filesystem, and the owner maps each handle
back to its own private row and file identity under its own guards. No file contents,
transcript, search index, or history sync crosses the network, and there are no
separate project- or agent-directory fields. Directory names that are part of a
displayed saved file path or recorded workspace are still visible. The roster's existing boundary is unchanged: a live child's current-file guard
path still never crosses. Saved file paths of the chosen owner do cross the network as
picker display data.

**Search and the full catalog.** Search runs on the owner with the owner's native Saved
search semantics, exactly as its Local picker would: fuzzy tokens, quoted phrases,
`re:` regular expressions, spaces, and Unicode. The query is forwarded verbatim, with no
trimming, normalization, or added length cap; its only limit is the technical size of one
lane frame. The unfiltered catalog and any search result are reachable in full, however
many rows they have, through bounded windows over one immutable owner result. Each
window states the full result total. Entry handles stay stable across windows of the
same result, and fetching another window never relists the catalog or reissues
handles. Nothing is cut off at a fixed total, refined implicitly, or silently truncated.
Existing Up/Down wrap navigation, matching, and keys are unchanged, with no new Home,
Page, or wheel keys. The viewer keeps at most three windows, and a row not yet fetched
is a non-actionable loading placeholder. A window carries at most 4096 rows or 8 MiB, in
pages of 32 rows within 64 KiB frames. A legal entry too large for one frame is carried
whole across fragment frames, never omitted or clipped.

**Resume.** Resume uses the owner's own native Saved admission: the same exact catalog
entry, recorded workspace, file identity, root, and header checks, and the same refusal
of a conversation already open or reserved by one of the owner's children. A successful
Resume starts a new native child owned by the owner's manager in the owner's run. On
this viewer only, the exact returned owner run and row is selected for display, while
the same request still owns the picker, even when the owner's row publication arrives
later. Accepted work that finishes after the picker moved on completes without taking
over this viewer's pane, focus, or drafts, and without stopping or resizing anything.
The owner's own local focus, Main owner, and drafts are unchanged.

**Delete.** Remote deletion is governed by the owner's **Allow remote history deletion**
Network setting. This is the owner host's own exposure policy, on by default, with an
explicit Off remembered. It is independent of the viewer's Remote input/copy setting.
It is not a viewer-side delete control, and it does not gate the owner's own Local Saved
deletion. The policy a viewer sees is a description, not a grant. Unknown or Off hides
its delete hint and blocks prepare/Delete at admission and the actual queued send.
On permits sending only with the normal written target, confirmation, and live guards.
The owner independently reads its own current policy once when each incoming request
is admitted: Off refuses before provider work; On allows that request to continue
through the independent authorization and saved-file checks. Prepare and confirmed
Delete are separate requests. A later preference change does not revoke an admitted
request, and Off followed by On wholly before sending does not retire a still-owned
intent or confirmation. A refused send is never retried or reopened automatically.
The viewer uses the same full-file confirmation, warning, fitting, and paste guards as
a Local delete, labelled with the owner host. At removal, the owner still rechecks the
channel, grant, run, and saved-file facts. Policy changes are described without waiting
for a roster refresh, and completed deletions are always reported truthfully. The
owner keeps its existing Local deletion behavior. It tries native `trash` first and
falls back to permanent unlink, and a conversation whose workspace is missing can still
be deleted. Live, unknown, or current-file conversations owned by the owner's children
are refused, as are pending reservations and canonical-path, header, or file-identity
replacements. Every removal is performed only by the owner.

**Fences and outcomes.** Requests come from the picker frame, or confirmation, that the
writer actually wrote. Resume and delete-prepare need the written picker; a confirmed
delete needs the written confirmation. Each uses a one-shot proof that is re-proved
against the current semantic content, geometry, view, cover, and lifetime inside the
ordered write. An ordinary repaint with the same content does not invalidate it, but a
real change does, even one that changes back. One Saved request is pending per channel.
A newer read replaces an older read that was not yet sent, quietly and without leaving
loading gaps or stray notices. Busy Resume or Delete requests are not kept for later
submission; an ordered transport write still re-checks authority at dispatch. Accepted
mutations are not superseded or replayed. `not-sent` is reported only with proof that
no transport write was invoked.
A completed send is a transport handoff, not proof that the owner executed anything. A
loss after a write may have been invoked is `unknown`. Nothing is retried, replayed,
regranted, reconnected, or claimed cancelled automatically. Refusals and uncertainty
appear as brief, fixed, non-modal notices without raw errors or payloads, and they
never steal focus.

## Focus, display, and status

Host keyboard controls apply only while the corresponding host surface has focus. In
the sidebar, Up/Down moves the selection, Enter opens the selected session or activates
an existing action entry. A single left-click on a displayed New, Saved, Quit, or Host shortcuts action entry
invokes that same action: New still opens its form, Saved its picker, Quit follows its
existing confirmation rules, and Host shortcuts opens its dedicated editor. These sidebar clicks are handled by the
host, not forwarded to a native child; existing keyboard controls remain available.
With the roster focused, a single left click inside a currently displayed native Main
pane returns keyboard focus to the unchanged active Main owner and consumes that first
click, including its release. It does not change the sidebar's visibility or selection,
activate a row, or change any sibling; subsequent typing goes to the same Main owner.
This applies only when the visible native pane still belongs to the current live owner
at the displayed geometry. A deliberately selected remote viewport is not a local Main
owner, so a roster-focused click in that pane is dropped instead of becoming a local focus
gesture (see
[Selected native viewport](#selected-native-viewport-interim-display-scope)). Forms,
confirmations, and the narrow sidebar overlay are not
native Main click targets. Once Main already has focus, mouse input keeps its existing
native behavior.
While a host UI occupies the right-hand pane beside the visible roster, the roster stays
clickable. A single left click on a *different* left row first closes that right-hand UI
through its own cancellation route — the same route its keyboard cancel uses, so an
unsent New or Edit draft keeps its existing retention, a Saved picker is dismissed, and a
Saved-delete confirmation closes together with its picker rather than leaving a hidden
pane — and then performs the clicked row's ordinary action exactly once. That
cancellation confirms, approves, denies, submits, or deletes nothing. Backend work keeps
its existing cancellation and request-id fences; dismissing a pane does not guarantee
that work already submitted to the host stops. A pending consent review is only
dismissed and its request stays pending, and Quit, stop/remove, peer remove, and peer
revoke confirmations never leave a clickable roster behind. A click on the row that
already holds the left highlight changes nothing at all — the right-hand UI, its draft,
focus, notices, and pending UI ownership are preserved. The left highlight,
not the native Main owner or an edit target, decides which row counts as the same one,
and only the roster actually drawn in the current written frame authorizes such a click.
The `d`/`D` or Delete keys stop/remove precisely the selected, fully displayed row,
`q`/`Q` activates Quit host, and the configured return-to-Main chord (Alt+Right by
default) returns input focus to the existing Main owner without activating the highlighted
row, resizing, or hiding. Its repeats and releases are fenced so a held key never leaks
into the child; a fresh return chord in Main focus is ordinary native input. Escape hides
the sidebar. The configured toggle (Alt+Left by default) is two-step: it shows and focuses
a hidden sidebar; from a visible Main focus one press only moves host input focus to the
sidebar without hiding it or resizing any child; and a press from sidebar-owned focus
hides it back to Main. A live row stops directly only with positively observed
complete idleness on the conservative ownership channel — zero unsettled owned
background tasks and shells, not merely the displayed activity-intent counts — and
fresh authenticated idle revalidation. Otherwise it requires a separate, fully displayed confirmation for
that frozen row; cancellation or a vanished target cannot stop a sibling. Removal waits
for the exact owned process's exit, never merely a shutdown acknowledgement.
Errored rows follow the same safeguards: an error badge grants neither exit nor force
authority. A no-child error can be removed only after the backend positively settles its
own launch and resource releases; pending, uncertain, or stale rows stay with a notice.
Removing a row detaches only that host entry and never deletes its workspace, native Pi
files, or saved conversation files. Removing the active owner clears ownership without
auto-activating a sibling; removing an inactive row preserves the existing owner.
Delete remains native input in Main focus unless it is itself the explicitly configured
sidebar-toggle chord.
With the roster focused, `n`/`N` displays no session: the host retires only its own local
content and input participation. The Main pane shows no native session, no keystroke reaches
a child, and every session keeps running in the background. The roster keeps its rows and
their ordering, the host stays up and able to display a session again, and nothing is
stopped, removed, closed, quit, or deleted; the Quit host row still shuts its children down
exactly as before. Input and clipboard routing follow the actually displayed owner, so while
nothing is displayed nothing is fed to or copied on behalf of a session; for a remote
viewport this routing uses the native I/O bridge only while this viewer's Remote
input/copy setting is on, and otherwise nothing is fed or copied on its behalf. Enter on a row
displays that session again and an already-running child is never restarted; a restart of an
exited row that was still in flight is cancelled instead of displaying itself over the
detached view. `n` is a roster-focus control: inside a form field it stays ordinary typed
text.

In the Local New session form, Enter (or the configured native submit binding) submits
the explicit workspace path; the native Editor
provides path completion and its current Pi editing bindings. A New form whose Host line
names a destination keeps the same native editing bindings but no requester filesystem
completion, and its Workspace text is forwarded verbatim. The form's single Host
line is one host-owned selection control: Shift+Tab moves the form focus to it, Tab or
one fresh Escape returns to the Workspace editor, and Up/Left and Down/Right step through
Local and the connected saved destinations while it holds that focus. Every other press
there is consumed instead of editing the hidden Workspace text, and a bracketed paste is
consumed too. A single left press on the Host value the render actually drew cycles that
one selection; a press elsewhere on that same drawn row only focuses the control, and
any other row, geometry, or option list refuses. Changing the Host clears the Workspace
value, and a chosen destination that later disconnects stays named but cannot be
submitted. The Host line uses the single spacer row the form already reserved, so the
editable body keeps its previous row budget. A successful Local submission activates the
created child as the active Main input owner, while a successful remote submission only
selects the viewport of the returned owner run and row, and never makes it a local input
owner; input to it follows the [native I/O bridge](#native-input-and-copy). The submission key's repeat/release is fenced in
both cases so it is never replayed as native input. In a Local form, if a completion menu
is open, the first Escape/cancel action dismisses that native menu and keeps the form; the
next fresh Escape cancels only New and returns to the visible roster without hiding the
sidebar. New and Edit cancellation are both local to their own form: the active Main
owner, native process, native input draft, persisted name, selection, and geometry are
preserved, a retained Local New **Workspace** draft is still offered by a later Local
form, a previous remote Host choice resets to Local and clears that draft, and the
held Escape's repeat/release neither hides the roster nor reaches the child as native
input. A form can also be abandoned while a launch/rename result is pending; that changes
UI ownership only and does not stop or roll back the backend operation, and its late
result still cannot take over a later-opened or dismissed pane. The Edit form is
available with `e` while a row with observed native metadata is highlighted. It shows the
current native name for reference and starts with a separate empty **New name** field;
the existing name is never prefilled or treated as an editable draft. Submitting sends a
persisted rename request fenced by the host row id and the exact observed native session
id/epoch. A stale or unavailable tuple is rejected, and a failed rename leaves the
session name unconfirmed. Escape in the Edit form cancels only that form in the same local
way and returns to the visible roster; a held Escape repeat does not bubble into the
roster hide, but a fresh roster Escape still hides. Editing never activates the
row, routes input to it, pauses or stops its child, or changes the active input owner. Both forms show the effective native
keybindings; the external-editor action temporarily hands the real terminal to the
shared native Pi agent directory's `settings.json` `externalEditor` command when it is a
nonempty string, otherwise to `VISUAL`, then `EDITOR`, then Pi's native platform
fallback (`nano` on POSIX, `notepad` on Windows). An absent global settings file uses
those fallbacks; malformed, unsafe, or unavailable settings fail before the editor
child starts rather than silently guessing. Workspace/project `.pi/settings.json` overrides are deliberately
not loaded, so this adds no project-code or trust grant. The command is parsed as literal
arguments and run as a directly owned, shell-free child; Windows `.cmd`/batch and
command-shell shims are unsupported. This editor-command support does not make the alpha
host Windows-supported: Windows temporary-file privacy follows Node and the operating
system's default ACLs, without a custom-ACL or same-user sandbox guarantee. The editor
uses a bounded temporary file; unsafe, oversized, or failed results are not applied.
Use the on-screen cues for form actions and quit confirmation. When a native Pi
frame has focus, input is sent only to the explicitly activated, live child; it is never
broadcast to hidden or sibling sessions. A remotely displayed viewport is not such a
child: native-pane input there is never reassigned to a local child, and it reaches the
remote owner only through the [native I/O bridge](#native-input-and-copy) while this
viewer's Remote input/copy setting is on (see
[Selected native viewport](#selected-native-viewport-interim-display-scope)).
Native Escape, `q`/`Q`, and Ctrl+C remain Pi's
keys whenever the native frame has focus. They cannot be configured as the sidebar
toggle; conflicting Escape aliases are rejected too. Only the admitted configured
toggle chord is reserved there, including its repeat and release events. The default
`alt+left` therefore intentionally takes precedence over Pi's native word-left chord;
use the Host shortcuts editor or the legacy `--sidebar-key f8` override (or another
supported key) if you need to keep that native chord.

### Sidebar status and activity

The sidebar is a bounded top-level summary: the observed native conversation name,
busy/idle/unknown state, pending-input presence only when observed, and at most a couple
of generic activity lines, with reporter-backed numeric background activity-task/shell
counts when available. Those displayed numbers are **activity intent**: admitted or
currently running logical work (including accepted continuations that are queued or
active, capturing, running, reviewing, waiting to land, landing, and in-flight
force-merge operations) and starting/running background shells. Continuation
validation alone does not count; a rejected continuation leaves stopped work at zero.
They are released as soon as work is observed stopped, independent of background
ownership, so a task or shell that has stopped but still owns unsettled cleanup or
recovery artifacts reads zero (or unknown when the stop itself is unproven). The
separate conservative **ownership** state still gates an idle-only stop or removal; it
is deliberately not displayed. Missing, invalid, or pre-intent observations stay
unknown, never inferred zero and never silently substituted with an ownership count.

Loaded sessions establish activity from fresh, complete observations of their exact
owning sources at startup/restore and safe event-driven resynchronization points. A
freshly loaded saved conversation initializes a new owning runtime; it is never attached
to the former process. When that initialization admits or resumes no work, the first
successful loaded/Ready presentation reports known idle agent status and zero
background-task and background-shell activity — at that first Ready, not eventually.
Counts, busy state, and unknown or incomplete telemetry recorded by the same
conversation's former runtime are historical records only: they are never replayed as
the new runtime's activity and never substitute for current observations. Work that
initialization actually starts or resumes is counted from its own current lifecycle
observations. Loading a conversation still does not attach to or adopt a live process,
and this adds no attachment support.

Stale or unknown current activity recovers independently through a canonical live-source
census. The host discards the affected stale ephemeral telemetry understanding and asks
the actual owning client for its complete authoritative current state from that client's
own live sources, rather than re-reading a cached aggregate or waiting for an unrelated
prompt, task, or event. A healthy owning client therefore re-establishes the actual
idle/zero or running/nonzero value, and repeated later unknown episodes recover the same
way without a new prompt, task, manual refresh, or client restart. That census is
separate from historical cleanup and recovery uncertainty: a current zero does not
resolve an old owner's retained cleanup ownership, and older uncertainty cannot poison a
current live zero. An explicit source refresh re-observes every source even when some are
already cached known. Recovery remains event-driven over one bounded authenticated
host-to-client request per attempt, fenced to the current
session/generation/request/sequence, with no periodic polling or global polling loop.
A stalled source-read lease expires without stopping work; a late reply cannot replace
newer valid observations or prevent a subsequent fresh read.
Genuinely unreachable, incomplete, stale, or unavailable live evidence stays unknown:
it is never coerced to zero, no lost owner's retained records are erased, and no client
restart or cache purge produces a status. This does not claim to reconstruct arbitrary
destroyed source state.

A Ready label is not proof of idleness: unavailable or incomplete source observations
remain unknown, and stale source/session observations cannot replace a current
incarnation's state. This refresh reconstructs ephemeral activity only; it does not
clear cleanup ownership, delete recovery records, resume work, or weaken stop/remove
safeguards.

Separately from that live-source census, after a same-process extension reload each
existing authenticated `session_start` may make one bounded read-only pass over its
snapshot of eligible retired execution controllers whose exact association inventories
were sealed by completed detaches. Each eligible exact owner is read at most once in
that pass; an in-flight read is not duplicated, and a retired source already proven
complete and empty is skipped. Failed
or fresh incomplete/unavailable reads leave the affected channel unknown and may be
retried on a later explicit `session_start`. A stale/discarded read leaves the exact
incarnation's existing channels and tokens unchanged and may be retried on that later
event; a source-list change discards that pass's snapshot and results without restarting
it. Recovery is event-driven only, with no periodic polling or transport
heartbeat trigger. Later admissions or relevant local-state mutations invalidate the
corresponding proof. A retired incarnation's intent census covers work actually admitted
or resumed there, independently of its historical cleanup inventory. Historical-only
references may keep ownership unknown but cannot poison its proven current zero. Only
validated, identity-matched evidence resolves retained local work; known stopped work may
clear activity intent while its recovery/cleanup token remains owned. The pass runs before
ordinary association restoration and does not restore/adopt tasks, write state, send
task/user notifications, or start/resume work. A missing, corrupt, unmatched, ambiguous, stale, or unavailable
reference; uncertain operation/liveness; lost runtime/force-merge owner; or post-detach
mutation leaves that channel unknown, with prior positive tokens retained. Replacement
controller emptiness is not evidence about a retired owner, and legacy registry entries
without a retained census callback remain unknown. This intentionally conservative
recovery repairs only cases the old owner can prove; it does not establish the
historical onset or cause of any earlier unknown status.
Native names may use Pi's first-user-message fallback when
there is no stored title. The sidebar does not monitor or coordinate reviewers, workers,
or their children, and does not display tool arguments, question text, transcripts, or
secrets. Status stays unknown until it is observed; an unavailable reporter, disconnect,
error, or process exit does not turn unknown into Idle. Exited rows retain their last terminal frame until
explicitly removed. There is no heartbeat timeout that declares a quiet session dead,
so a valid idle state may remain for hours.

Title highlighting is focus-domain, never both at once: while a sidebar-owned surface
(roster, form, or confirmation) has focus, the LEFT selected navigation target's title
is blue; while Main has focus, the ACTUAL active Main conversation's title is white
(never a sibling or the stale left selection). With no active owner, no row is falsely
highlighted.

The local status channel uses a private Unix socket and per-instance authorization
identity bound to the owned child. A pre-main Node preload consumes the one-shot
bootstrap synchronously before original user `--require` hooks and Pi's main; it
restores the original `NODE_OPTIONS` exactly before those loaders and their descendants
run. This is process coordination, not a sandbox: trusted original Node loaders and Pi
extensions are not restricted, and the host does not protect against malicious code
running with your account's authority.

## Terminal and input limits

Text and SGR styling remain reconstructed from each child's virtual terminal;
raw child escape streams are never forwarded. A separate, bounded graphics path
handles native Pi's Kitty PNG image commands for a directly attached Ghostty Main
pane. This is a display feature only: native image input, model processing, and
ordinary standalone launchers are unchanged.

### Per-session content geometry

Each session's content area is sized for the surfaces that actually display it. Every
host surface that can display a session registers as a viewer of one session and reports its
own content size, and a session's canonical size is the independent minimum of those widths
and the independent minimum of those heights across the surfaces displaying it: a 100x40
surface and an 80x50 surface showing the same session give that session 80 columns and 40
rows. Only sessions whose viewer set actually changed are recomputed, and only that session's
own child is resized, so a sibling nobody is viewing keeps its size. A surface that displays
no session, or one with no content size yet, contributes no dimensions. When the last surface
stops displaying a session, that session keeps its last canonical size instead of resetting,
and a later viewer can change it again. A session nobody has ever viewed keeps the existing
initial-sizing rule and is created at the host's current pane size.

These viewer facts live once on the host's single session manager, and the host reads them
back instead of keeping a second copy. Retiring a surface — closing a pane, displaying no
session, or a row whose child exited or was removed — ends its participation immediately, and
a completion carrying an older viewer state is refused instead of resurrecting a detached
view, retargeting a finished row, or overwriting a later selection.

Because a child's size can change while a frame is in flight, native input is translated only
against what was actually committed to the screen: the content rectangle the session's frame
drew, together with the canonical size and revision that frame was drawn from. A resize still
queued behind a blocked writer authorizes nothing — neither the padding it will expose nor the
size nobody has drawn yet. The same written snapshot governs native clipboard copies, so a copy
is transported only for content the user actually saw. When the manager reports no usable
canonical size for the displayed session, a positional packet is dropped: a missing or malformed
size is never taken as permission to treat padded pane cells as the child's. Keyboard and paste
input claim no cell of the content area and keep their ordinary path.

A session smaller than its pane is drawn at the pane's top-left corner and padded. That padding
is host space: a click there is neither forwarded to the child nor treated as a focus gesture.
A fully drawn padded session keeps what a drawn session has — native clipboard copying,
click-to-focus on its own content, and its images, whose layer is bounded by the drawn content
rectangle rather than by the containing pane, with the ordinary text fallback where the terminal
cannot render them.

This is display sizing on the host's single session manager. The one selected remote
viewport described above registers as one more independent viewer of that same manager, so
its pane size participates in the ordinary per-session minima for the selected row only;
sessions nobody has selected are not watched, resized, or given a viewer. It adds no control
channel, permission, stored state, or second manager, and no session becomes exclusive to
one surface: registering or closing a viewer never grants, leases, or revokes input or
output participation.

### Clipboard copying over SSH

Native Pi already sends SSH clipboard copies to the connecting terminal with OSC 52.
The sidebar previously discarded that request while still displaying Pi's ordinary
**Copied!** flash; a successful clipboard helper on the remote machine did not mean
the connecting client's clipboard changed.

The host now transports verified native copy requests separately from reconstructed
screen text. Pi remains the only selection and clipboard producer: native Main,
visible question/notice selections, copy-on-select, the configured application copy
shortcut, and the original local clipboard helper remain native. Nothing patches Pi,
changes its settings, or adds a second selection engine. Raw PTY OSC 52 remains denied.
The owned child observes the native producer's runtime/call-stack provenance through
Node's stdio boundary, then authenticates a bounded request with its existing
per-child capability. The host checks the current session epoch and live, actually
displayed Main input owner before generating its own outer-terminal OSC 52 command.
Stale, hidden, covered, sibling, or shutting-down owners cannot write the client
clipboard. Ordinary local helper-only copying is unchanged.

This provenance adapter recognizes the audited bundled **Pi 1.3.0 and 1.4.0** runtimes. A changed
runtime or unavailable native provenance fails closed rather than admitting arbitrary
output. This is not a sandbox against trusted executable extensions running with the
user's operating-system authority. Clipboard payloads are transient authenticated
transport, not encrypted storage or a sync service.

Copy feedback stays native: Pi's own **Copied!** flash is the only per-copy status, and
the host adds no header notice, dialog, or setting for a copy. Ordinary safety
refusals (stale, sibling, hidden, unfocused, covered, form, changed-geometry, or
shutting-down owners) stay quiet. Only actual routing failures for the current,
displayed Main owner are recorded, through the existing
[terminal diagnostics](#terminal-parser-diagnostics) warning and private log: an
authenticated unsupported-runtime or unavailable-provenance report, or a failed write
of the host's OSC 52 request to the outer terminal. Those records carry only the
`host-clipboard` category and a fixed message identifier
(`clipboard-unsupported-runtime`, `clipboard-provenance-unavailable`, or
`clipboard-terminal-write-failed`), with no stack or invented cause. No clipboard
text or encoding, source stack, exception message, environment value, or path is
recorded, and malformed, raw, or unauthenticated controls never produce a record.

A successful copy records nothing. It means only that bytes were submitted, not that
Ghostty or another terminal acknowledged an OS clipboard write; only a paste on the
client verifies delivery. Existing terminal permissions, multiplexers, and native size limits still apply
(Pi 1.3.0 and 1.4.0 bound the encoded OSC 52 payload to 100,000 characters). No terminal/SSH
configuration or multiplexer passthrough is forced. A terminal or multiplexer that
disables/does not implement clipboard writes may discard the request. There is no
clipboard read, paste, synchronization, image transfer, or remote-host backend here. The
local routing follows the actually displayed owner: while a remote viewport is displayed,
this host has no displayed local owner to copy for, and nothing is broadcast to a child or
a peer. Through the native I/O bridge described next, a completed remote copy is delivered
only to its initiating viewer, and only while that viewer's Remote input/copy setting is
on.

#### Native input and copy

The content lane carries native keyboard, canonical mouse, whole text paste, and
text-copy results between one remote viewer and the exact native child that viewer
displays. In normal production Main this bridge is **on by default**: every child the
host creates uses the strict authenticated input-origin framing described below, and
Main always supplies its native I/O callbacks to the one coordinator. That bridge
support is fixed for the host's lifetime. Only the dependency-only
`MainDependencies.nativeInputOriginFraming === false` legacy test seam keeps the old
display-only call shape; there is no CLI, environment, or configuration flag, and no
standalone or live-child retrofit.

Two separate, remembered **Network** menu settings sit on top of that bridge:

- **Remote input/copy** is a VIEWER-side setting for this sidebar's own displayed remote
  pane (on by default). Turning it off stops only THIS viewer from forwarding keyboard,
  mouse, paste, and copy for the remote pane it displays: input there gets one brief
  fixed notice and nothing is sent, and a completed copy is not written to this terminal's
  clipboard while it is off. It does not disconnect, revoke, reconnect, change Hosting or
  Auto, stop children, cancel owner work that was already accepted, re-negotiate the
  content lane, or touch owner framing, the owner's own local input and copying, other
  viewers, or the sidebar's New, Close, and Saved host actions. Every protected write and
  every completed copy re-reads the current setting. An actual change starts a new setting
  generation, so an input admitted before it cannot complete, and turning it back on needs
  a fresh, actually written, uncovered, Main-focused frame for the current source and modes
  even when the pixels did not change. An explicit Off is remembered across restarts; a
  new installation, or a valid settings document written before this setting existed, is
  on.
- **Allow remote history deletion** is an OWNER-side policy for this host (on by
  default): whether this host exposes remote saved-history deletion to its paired viewers.
  It is not a viewer-side delete toggle, it does not gate this host's own local Saved
  deletion, and it changes no viewer's input, grant, Hosting, Auto, or connection. An
  explicit Off is remembered across restarts. The owner reads the live value at every
  remote delete decision, as described under
  [Saved conversations on a connected owner](#saved-conversations-on-a-connected-owner).

Both settings are saved like the other Network settings: written before they take
effect, with no identity, key, or listener created, and an unsaved change reports the
existing "could not be saved" notice instead of taking effect. Unavailable, unsafe, or
malformed settings are never treated as the default-on values: remote input/copy is then
off and the history-deletion policy reports off.

Negotiation is explicit: `native-input-copy-v1` is offered only when Main supplied the
callbacks, and knowing or acknowledging the identifier grants no authority. The separate
optional `native-input-startup-v1` capability depends on it and is never negotiated
without it (see **Startup input** below). The owner side
binds one viewer to one existing content subscription and states a host-written source;
the viewer side only describes and submits against that exact source. On the child side,
the bridge requests bootstrap mode `1` and requires its own authenticated readiness
statement before any child write. Only never-sent automatic terminal-query replies for an
otherwise-current, live, non-stopping framing child awaiting that readiness are discarded
without failing the row. They are never queued or replayed; readiness enables only future
framed replies with non-user origin. User input stays refused until ready, and other reply
failures retain their existing failure paths. Unknown bootstrap modes and requested
bridge-installation failures refuse without downgrade, raw fallback, queued replay, or a
late readiness guess. Each input frame is printable ASCII end to end and ends in one
printable `;` rather than a control byte, so a terminal that rewrites control characters
cannot move or erase a frame boundary. Only that exact versioned framing is accepted: the
older line-feed-terminated wire and a terminal-substituted key ending are malformed
framing that poisons the child's decoder, and a host and a child built from different
framing versions refuse each other instead of downgrading. Local-origin and non-user
origins keep their existing local-path fences; non-user input cannot authorize a copy.

**Input authority.** Every protected write is measured against the frame the writer
actually committed: one uncovered, Main-focused remote viewer frame, with the exact
host-written source (owner run and row, native session id and epoch, viewer revision,
canonical geometry and revision, and source commitment) and observed input modes, or
the explicitly fenced startup source described below.
The owner independently compares those expected facts with its current source and binds
the commitment to its current private registration identity and generation; those private
registration facts are not exported. Current TLS-proved peer key, remembered pin,
directional receiving grant, endpoint, subscription, selection, and this viewer's current
Remote input/copy setting are also required. The same dynamic proof runs before every
protected write and is re-checked after the caller's callback returns, so reentrant code
cannot leave a write admitted, including code that turns the setting off and on again. The source token is a descriptive commitment, not a grant; no registry, second
manager, permission kind, or controller lease is added. The owner's own Main pane need not
display or focus the controlled row.

With semantic source and modes unchanged, ordinary terminal output, a new snapshot
object, or a new publish sequence does not stall input. A semantic native-source or mode-only change requires a real writer boundary even
when the visible bytes are identical. Keyboard packets, canonical content-coordinate SGR
mouse reports, and whole text pastes are the only input kinds; images and files are not
expressible. A paste is validated whole as decoded UTF-8 at up to exactly 1,048,576 bytes
before one PTY handoff, never truncated; bracketed-paste markers are added only when the
child's current native mode asks for them. The child authenticates and assembles an
entire viewer logical dispatch before one stdin handoff, so no native listener sees part
of it. It uses a technical assembly bound of 1,048,588 bytes (the 1 MiB body plus its
two six-byte paste markers). A phase or conversation-tuple change drops an assembly in
progress immediately, even when the source later changes back. Mouse bytes, including
high-bit bytes, are handed over exactly. There is no raw fallback and no downgrade of
viewer input to local input. Local input and non-user terminal-query replies use the
same authenticated child decoder. Legacy unframed children retain their existing paths. Atomic assembly
and admission are protocol boundaries, not an operating-system delivery guarantee.

**External editing.** Ctrl+G still opens Pi's configured external editor; it does not
open a host replacement editor or change the editor setting. The handoff has no
operating-system enablement filter: an editor-specific PTY relay in a framing child
keeps the authenticated decoder in front of that editor:
ordinary commands, text, and supported paste reach the editor as terminal input, not
as printable `prg-ni-v2;` records. Pi and the external editor never share an active
input consumer. Input retained across an ownership transition is discarded rather
than replayed into the next consumer. Saving returns Pi's edited draft once; quitting
without saving or an editor failure preserves the draft under Pi's existing rules.
After the owned editor exits, Pi resumes its normal input and terminal modes. The
relay does not disable framing, create a raw-input window, or broaden remote input
permissions; viewer input retains its existing authorization and source fences.
Windows retains Pi's shell-based configured-editor launch through the pinned ConPTY
surface; other platforms retain their native command/argument launch. Missing terminal
capabilities or unverified launch provenance fail that edit closed, never by exposing
framed input directly. Enablement tests are separate from physical-terminal acceptance.

For manual acceptance in an isolated profile with a synthetic draft, configure your
chosen editor through Pi's existing editor setting and open a native session in Main. Type a
recognizable draft, press Ctrl+G, make a small edit (including Unicode/paste supported
by the terminal), and save/exit. Confirm the exact edited draft returns, with no
unintended frame records, and ordinary Pi typing still works. Repeat with the editor's
quit-without-save action and a deliberately failing editor command: the prior draft must
remain and input must recover without restarting the host. Compare standalone Pi,
local Main, Windows, and SSH to Linux separately; a same-host PTY test is not physical-terminal
or SSH certification. If using a remote viewer, repeat through that selected remote
pane with its existing Remote input/copy setting enabled; no new grant is needed or
implied.

**Startup input.** A child the owner has just started can show a native prompt before
it has a conversation, such as Pi's `Trust project folder?` selector. When both sides
negotiated `native-input-startup-v1`, an authorized viewer can answer that prompt with
ordinary keys. Startup authority is explicit, never inferred from a missing
conversation tuple. The child's startup phase is armed only after the owned reporter has
registered its mandatory public hooks. The child's first session update, whatever its
value, closes the phase for good. On the owner, the registration's first accepted
status, a disconnect, an exit, or a similar event closes it too. A startup source states
phase `startup` and carries no native session field, not even a fake or null one, under
a source token domain separate from conversation sources. All other fences above still
apply. Pi's native trust decision and its persistence are unchanged: there is no
automatic trust, no Pi patch, and no new API. Copy is unsupported during startup. An
asynchronous copy begun during startup can neither become a local copy nor complete as a
remote one after the phase ends.

**Text copy.** Only the exact initiating viewer receives a completed copy; there is no
owner outer-terminal or local clipboard fallback, broadcast, raw OSC 52 relay, or
highest-input-dispatch filter. An asynchronous copy caused by earlier input A still
arrives after input B when it is still valid, because copies are ordered by their own
emission sequence, not by input dispatch id. The full native producer payload is retained:
up to 100,000 canonical base64 characters, representing at most 75,000 decoded text
bytes. Small copies may fit inline; paging preserves the complete encoded string as
ASCII bytes, and the pages are joined before the text is decoded, without reducing the
producer bound to a single message. Copy delivery is a terminal-write submission on the
viewer, not proof of a physical OS clipboard write.
The native producer and OS clipboard writer are unchanged. Each hosted child tree created
with the bridge receives the static `PI_CLIPBOARD_OSC52=1` capture setting, and it inherits
only inside that tree; standalone launches and the system environment stay unchanged, and
no clipboard image push, read, or synchronization is added. While this viewer's Remote
input/copy is off, a completed remote copy is dropped without a clipboard write; nothing
is cancelled on the owner, and an older copy is not fenced out by a newer input. The existing 64 MiB
whole-viewport assembly bound is unchanged.

**Outcomes.** `not-sent` is possible only before any transport-write invocation;
`submitted` means only that local transport writes returned, never that the owner or
child executed anything. If a transport write may have been invoked, loss, rejection,
malformed results, or source changes leave the handoff `unknown`, with no replay, retry,
or cancellation claim. Refusals, an oversize paste, or a full or
busy queue use one brief non-modal notice; they never open a dialog, steal focus, or
truncate input.

Close, Disconnect, Remove, Revoke, and stream loss keep their existing boundaries. Close
is authorized only by the highlighted host/run/row plus its actual written receipt or
confirmation, independently of the native tuple, epoch, modes, selected stream, or viewer
lease. Disconnect, Remove, Revoke, or a lost stream does not stop work the owner already
accepted; a local receiving-side Revoke does not block this side's outbound view; and
retiring a viewer may legitimately recompute a row's minimum size, with the last
canonical size retained at zero viewers. Several viewers may display and control the
same owner row at once, each with its own geometry contribution and setting, and the
owner's own Main need not display or focus that row. This bridge is not a platform,
physical clipboard, or native-Windows certification, and it cannot retrofit an
already-running child. Remote saved conversations are described under
[Saved conversations on a connected owner](#saved-conversations-on-a-connected-owner).

#### Isolated manual SSH clipboard comparison

Run these source-checkout steps **on the SSH host**, from the checkout root, in the same
client terminal for both controls. Set `PI_AGENT` to the installed Pi 1.4.0 package
directory, not its launcher shim. This creates a disposable home, agent directory,
workspaces, and an inactive candidate build; it does not use the live roster,
credentials, or installation. Dependencies must already be installed in the checkout:
the prepared candidate links to the checkout's own `node_modules` and `scripts`, so no
`NODE_PATH` or global module fallback is needed. The fixture uses a scripted local faux
provider, never an external model or API key, and never copies automatically.

Every Node command below, including preparation and the compiler, runs through
`clipboard_proof`, a subshell-scoped wrapper for this POSIX-only proof. It removes
inherited `PI_REVIEW_GATE_*`, `PRG_FIXTURE_*`, and `PIP_*` variables plus
`NODE_OPTIONS`, `NODE_PATH`, `PI_CODING_AGENT_SESSION_DIR`, and `XDG_CACHE_HOME`, then
sets the disposable `HOME` and `PI_CODING_AGENT_DIR`, the fixture's provider values, and
`PIP_CONFIG_FILE=/dev/null` (which makes pip skip every configuration file). An
inherited review-gate config, scheduler, DDGS environment, or cache location therefore
cannot retarget the proof at live configuration or a live DDGS environment, and ambient
pip target, prefix, index, or configuration settings cannot redirect the disposable DDGS
install. `PATH`, `TERM`, SSH and multiplexer markers, and the native clipboard
environment pass through unchanged, so standalone and hosted runs see the same
terminal. The calling shell's environment is not changed. If any removal or assignment
fails (for example, a read-only `HOME` or `NODE_OPTIONS`), the wrapper exits nonzero
before running the command; start a fresh shell without that setting rather than
retrying without the wrapper. This isolates the proof harness only; it is not a product setting.

The hosted control (step 3) prepares its own generation under the disposable agent
directory and provisions DDGS under the disposable home's cache: it runs a locked
`npm ci` against the public npm registry, then creates a virtual environment and
downloads the pinned DDGS wheel from the default Python package index. That requires
network access to both registries and Python 3.9 or newer with its `venv` module (some
distributions package it separately, for example `python3-venv`). A failure there is a
setup prerequisite, not a clipboard result.

```sh
PI_AGENT=/absolute/path/to/pi-coding-agent
PI_CLI="$PI_AGENT/dist/bundle/cli.js"
checkout="$(pwd)"
fixture="$checkout/tests/fixtures/pi-host-clipboard-proof.cjs"
proof=$(mktemp -d "${TMPDIR:-/tmp}/pi-host-clipboard-proof.XXXXXX")
clipboard_proof() (
  for name in $(env | sed -n -E 's/^((PI_REVIEW_GATE|PRG_FIXTURE|PIP)_[A-Za-z0-9_]*)=.*/\1/p'); do
    unset "$name" || exit 1
  done
  unset NODE_OPTIONS NODE_PATH PI_CODING_AGENT_SESSION_DIR XDG_CACHE_HOME || exit 1
  export HOME="$proof/home" PI_CODING_AGENT_DIR="$proof/agent" PIP_CONFIG_FILE=/dev/null \
    PRG_FIXTURE_AGENT_DIR="$PI_AGENT" PRG_FIXTURE_STATE_DIR="$proof/provider" || exit 1
  exec "$@"
)
clipboard_proof node "$fixture" --prepare "$proof"
clipboard_proof node node_modules/typescript/bin/tsc -p tsconfig.json \
  --outDir "$proof/candidate/dist"
clipboard_proof node "$PI_CLI" --offline --no-context-files --no-skills --no-extensions \
  --extension "$proof/candidate/dist/src/index.js" --extension "$fixture" \
  --provider prg-native-question --model driven --tui-mode fullscreen
```

1. Record the client terminal/version, host OS/Node/Pi versions, terminal size, and
   whether tmux/screen is present. Run `/clipboard-proof`, drag across the distinctive
   Unicode/multiline text, release, and **paste on the client into a controlled local
   text target**. Inspect the actual destination and exact content. This is the
   standalone positive control; do not proceed as though it passed when it did not.
2. Run `/clipboard-proof-popups`. Open the shared list with Ctrl+Alt+Up and inspect
   both the synthetic question and notice. Copy visible body text, not a menu action,
   and paste on the client. Close standalone Pi normally before the hosted control.
3. Start the candidate from the same terminal/environment:

   ```sh
   clipboard_proof node scripts/pi-review-sessions.cjs --pi-executable "$PI_CLI" \
     --sidebar-key f8 -- --offline --no-context-files --no-skills --no-extensions \
     --extension "$fixture" --provider prg-native-question --model driven \
     --tui-mode fullscreen
   ```

   Use New session to select `$proof/a`. Repeat both commands and client-side pastes.
   The selected text must match standalone, including Unicode and line breaks. Pi's
   native **Copied!** flash alone is not success evidence; the host adds no per-copy
   notice, and an absent Terminal diagnostics warning is not client-paste evidence.
4. Create a sibling in `$proof/b`; switch focus, show/hide the sidebar, and open/cancel
   a host form. Copy only from the visible foreground owner. No old/sibling selection
   may overwrite the client clipboard, and ordinary typing/mouse behavior must remain.
5. Quit normally. In **only the disposable agent's** `settings.json`, change
   `fullscreenCopyOnSelect` to `false`. Repeat standalone/hosted: releasing a selection
   must not copy; Pi's configured copy shortcut (Ctrl+X by default) must copy the live
   selection. Select background text before opening a popup: the popup must clear that
   inherited selection and never copy hidden conversation rows. Repeat with a shortcut
   remap in only the disposable `keybindings.json` if needed.
6. Repeat the local, non-SSH control in a fresh disposable context: a new proof
   directory, prepared and run through the same wrapper. Keep existing
   terminal/multiplexer permissions unchanged; where clipboard writes are disabled,
   verify the limitation rather than treating helper success or emitted bytes as a
   client-side paste result. Confirm normal terminal restoration and owned-child exit.

Keep fixtures for inspection if shutdown is uncertain. Do not delete unknown files,
kill other sessions, modify the active runtime, or change terminal security to obtain a
passing result. Synthetic PTY tests do not replace these operator-driven paste checks.

### Inline images and compatibility

Ghostty is the concrete image-display target, not a blanket terminal-graphics
compatibility promise. The native protocol fixture uses Pi and pi-tui **1.4.0**.
The hosted Kitty path requires `TERM_PROGRAM=ghostty` and `TERM=xterm-ghostty`,
with no `TMUX`, `TMUX_PANE`, or `STY` marker. A customized terminal environment
that does not meet this narrow gate uses text fallback, even if standalone Pi's
broader heuristic detects images. Explicit `PI_IMAGE_PROTOCOL=none`/`0` disables
the host renderer; `iterm2` is not rendered through this Kitty path. Native
image-disable preferences remain native choices. No new host setting or image
tool is introduced.

The host accepts a narrow typed subset of native PNG uploads, cached placements,
vertical crops, and deletions. It generates its own outer-terminal commands,
remaps child image identities, and confines graphics to the actual visible Main
owner's pane. Child-wide deletion affects that child's graphics state only,
never sibling images or arbitrary outer-terminal graphics. Switching sessions,
covering Main with a form or overlay, and changing geometry remove old visible
placements before drawing replacements. Images do not authorize input, activate
a sidebar selection, or change session/workspace ownership. A selected remote viewport
carries that same typed image subset and is drawn through the same compositor, graphics
layer, and bounded writer with the same fallbacks and cleanup; that lane transfers no
images outside an accepted viewport.

Unsupported display uses Pi's image-text convention, not a host warning or a new
configuration prompt. Native unsupported-terminal rendering retains its own image
metadata. When the host must substitute text for a Kitty placement, it can report
only the PNG metadata available in that terminal stream; original filenames and
pre-conversion formats are not reconstructed. Unknown graphics protocols, file
or shared-memory transfers, and arbitrary graphics controls are not passed through.
Forcing an unsupported protocol is not a compatibility guarantee. Child window
and cell-pixel queries remain suppressed, so native image sizing uses the child's
cell-pixel defaults rather than measured outer-terminal pixels; exact physical
size/aspect parity with direct Pi is not certified.

Image transfers, retained data, decoded-size estimates, pixel dimensions, image
counts, and placement counts have fixed internal bounds. A shared graphics budget
also covers the manager's sessions, rather than multiplying an unbounded cache by
the number of children. These are bounds on the host's retained graphics state,
not an operating-system or terminal-emulator memory guarantee. Graphics output
uses the existing bounded writer and its coalescing/backpressure boundary; cleanup
must settle before the writer can report successful terminal restoration.

Retained immutable PNG metadata is validated and hashed once, not on every text
redraw. Moving or cropping an unchanged image for the same Main owner reuses its
resident outer image data: the writer removes/replaces only the scoped placements,
rather than deleting and retransmitting the PNG. Owner changes, hidden/covered
Main panes, changed content, and shutdown still remove obsolete owned graphics.
Mutable or accessor-backed image values do not receive that validation-cache trust.

Queued text-only output is parsed in bounded batches again, avoiding one xterm
parse cycle and snapshot per child chunk. Potential graphics commands remain
parse-order barriers. Native synchronized redraws publish text, cursor, and graphics
as a completed frame, rather than exposing a temporary image deletion before its
replacement. New alternate-screen image anchors are captured against the completed
covered rows; older anchors are validated, not moved onto unrelated text. Unframed
output retains its ordinary overwrite and destructive-control checks.

A synchronized-frame hold has fixed internal limits of 1 second, 8 MiB, and 8192
child chunks; an exceeded limit ends the hold and resumes unframed processing.
Resize, buffer changes, reset, parser failure, and disposal cannot retain stale
geometry or strand a hold. Snapshot-held image data and placements remain charged
to the shared graphics budget until released. Keyboard encoding follows the child's
live modes; native mouse packets are withheld while a frame is incomplete to avoid
authorizing clicks against stale contents. Outer terminal mouse capture follows the
last committed reporting request during the hold, avoiding off/on churn or stuck
reporting after a no-change commit. No setting or redraw-rate cap is added.
These changes preserve row-diff/coalescing; they do not promise a physical frame rate.

Source, unit, and controlled-PTY tests establish parsing, placement commands,
identity fences, and cleanup ordering; they do **not** prove pixels appeared in a
physical terminal. Actual same-content direct/hosted Ghostty display and visual
cleanup require the manual comparison below.

### Manual Ghostty image comparison

Run this from the PR checkout in a physical Ghostty terminal, without tmux/screen.
Use a disposable native agent directory so a second host cannot contend with an
existing sidebar host's ownership record or change its roster. The test-only
extension adds an explicit image command; it makes no model/provider request.
It is not shipped as a product tool.

```sh
proof=$(mktemp -d "${TMPDIR:-/tmp}/pi-host-image-proof.XXXXXX")
(umask 077; mkdir "$proof/agent" "$proof/a" "$proof/b")
fixture="$(pwd)/tests/fixtures/pi-host-image-proof.cjs"
printf 'Workspace A: %s\nWorkspace B: %s\n' "$proof/a" "$proof/b"
# Unset this override if present: the host deliberately rejects inherited
# native session-directory overrides.
unset PI_CODING_AGENT_SESSION_DIR
PI_CODING_AGENT_DIR="$proof/agent" pi --offline --no-extensions --extension "$fixture"
```

1. In direct Pi, run `/host-image-proof red`. Verify the actual colored image,
   not just the text label, appears. Exit normally; record the Ghostty and Pi
   versions, terminal size, and whether Pi is in regular or fullscreen mode.
2. Start the candidate host from the same checkout and terminal:

   ```sh
   PI_CODING_AGENT_DIR="$proof/agent" node scripts/pi-review-sessions.cjs \
     --sidebar-key f8 -- --offline --no-extensions --extension "$fixture"
   ```

3. Use New session to select the printed `$proof/a` directory, then run
   `/host-image-proof red`. Compare the actual image with the direct baseline.
4. Create a second session in `$proof/b` and run `/host-image-proof blue`.
   Switch repeatedly between A and B. Their images must stay with their own
   Main panes even though the fixture deliberately reuses the same child image ID.
5. Show/hide the sidebar with F8, resize the terminal, and cross the 53-column
   overlay boundary. Open and cancel New while an image is visible. No old image
   may remain over the sidebar, form, overlay, or the other session. When Main
   is visible again, its own image should return at its current placement.
6. Quit through the public host confirmation. Check that graphics disappear,
   the ordinary terminal returns, and the original host/owned children settle.
   Repeat the comparison with `--tui-mode regular` and `--tui-mode fullscreen`
   on direct Pi and after the host's `--` separator, using fresh sandboxes.

Also test native image disabling and an unsupported terminal: image text should
remain usable without a new host notice. A passing protocol trace or text
snapshot cannot substitute for these visual observations. Retain the disposable
sandbox for inspection if shutdown is uncertain; do not delete unknown files or
use forced termination as proof that normal cleanup passed.

For scrolling performance, also compare the same existing image-bearing
conversation in direct Pi and the candidate host. The small red/blue fixture
proves identity and cleanup behavior, not representative large-PNG throughput.
Exercise ordinary text scrolling with and without an image visible; confirm
ownership and visual cleanup still hold while comparing responsiveness.

### Generated frames and input

Generated frames are drawn through a bounded outer writer whose default minimum
redraw interval is 16 ms (about 60 fps), matching Pi's native minimum redraw cadence;
there is no user-facing frame-rate option. Each submitted frame is sanitized and
clipped synchronously and validated against the complete-frame byte bound before it
can be drawn. At the next allowed redraw only rows that changed since the last frame
actually written are emitted: the first frame after start, any geometry change, and
any actual terminal resize notification (even one that returns to the previous
dimensions) redraw fully, cursor-only changes emit only the cursor sequence, and
an unchanged frame emits nothing. Rapid invalidations coalesce so that only the
newest composed frame is drawn at the next allowed redraw, and when the terminal
refuses a write (backpressure) only the newest bounded frame is retained until
drain. Main-focus input that leaves the child screen unchanged no longer reconciles host
layout or prepares/submits a speculative frame for that unchanged screen. The child's
existing output `onChange` path still updates the display; host UI, focus, layout, and
resize actions remain immediate. This changes only redundant redraw work: it does not
filter terminal output or ANSI sequences, alter wheel, keyboard, paste, or click
forwarding, or change redraw cadence, coalescing, or backpressure. This bounds output
volume; it does not promise a particular on-screen smoothness or physical paint
timing. Normal and alternate child buffers,
terminal query replies, and resize state are kept per instance and routed only to that
same child. Cell widths use the pinned Unicode 11 behavior for CJK, combining marks,
and basic emoji; newer emoji and complex ZWJ sequences are not guaranteed to match
Pi's standalone layout.

With the sidebar visible at 53 columns or wider, it uses 32 columns plus a divider
and leaves at least 20 columns for the native frame. The New/Edit form
temporarily replaces that right (native) pane while the roster remains on the left;
below that width the form is a full-content overlay instead. While the form is open,
the underlying child keeps running unpaused with its geometry and input ownership
unchanged; cancelling the form restores the same child frame, while completing a Local
New or Local Saved open activates the new child as the Main input owner (completing Edit
restores the same child frame; a remote New or Resume only selects the owner's returned
row for display).
Below 53 columns the sidebar is a frontend overlay while it has focus; native
geometry remains full-width and unchanged across focus switches, and returning to
native focus only removes the overlay. Sidebar hint text wraps across reserved
footer rows instead of being ellipsized; when the geometry cannot show the hints
plus a usable pane, that pane shows a truthful too-small message rather than
half-hints. Very small terminals show bounded text, not a promise that every native
Pi menu will remain readable.

The native Main mouse path is cell-based and applies only to the active native frame;
events outside that frame are dropped before coordinate translation, never clamped to
the pane edge. Sidebar-target clicks are handled by the host and are not forwarded to a
native child. For a locally displayed owner, the first left click in the visible native
pane while the roster owns focus is consumed to return focus to that active Main owner;
subsequent mouse input is forwarded normally. A deliberately selected remote viewport
never focuses or feeds a local child. Its canonical mouse packets reach the remote owner
only through the [native I/O bridge](#native-input-and-copy), under that bridge's
written-frame and Remote input/copy fences, and are otherwise dropped. Only the frame the
writer actually committed decides whether the drawn source is remote. This does not add conversation wheel/trackpad scrolling (#332). On
Windows, bundled-ConPTY protocol observations do not certify physical mouse behavior:
manual validation has observed clicks working, but pane-confined selection and native
conversation wheel scrolling still require interactive validation, as described in the
Windows runtime limitation above. Pixel-coordinate mouse reporting and terminal-focus
forwarding are not supported. Keyboard negotiation is designed around independent
Kitty keyboard flags 1, 2, and 4, preserves modified Enter through Pi's
`modifyOtherKeys` fallback, and drops key-release events when the child has no event
reporting support. These input paths are still being integrated and verified; do not
treat the design description as proof that every terminal/input combination works.

### Terminal parser diagnostics

Each child's virtual terminal hands the pinned xterm parser its own private logger, so
xterm diagnostics never go to the host's console. Before this change, a malformed
child control sequence (for example an unterminated CSI immediately followed by a
non-ASCII character) could make xterm print a `Parsing error` dump onto the real
terminal's stderr, outside the composed frame. Later redraws could leave that text on
screen until a full repaint. The parser's own recovery is unchanged: it returns to
ground and later valid text, styling, graphics, and clipping render as before. Valid
sequences, including ones split across child output chunks, produce no diagnostic.
The xterm log level is not changed, escape sequences are not newly accepted or
stripped, redraw is not disabled, and the host console is not intercepted. A few
internal xterm messages (for example listener-leak or invalid-option warnings) call
the console directly rather than through the logger, and are outside this per-terminal
containment.

When xterm reports a warning or error, or an actual host clipboard routing failure
occurs (see [Clipboard copying over SSH](#clipboard-copying-over-ssh)), the host shows
a clearable warning in its own UI:

- a right-aligned header notice, for example
  `! Terminal diagnostics: 3 (clear in sidebar)`, visible even while the sidebar is
  hidden;
- a three-row **Terminal diagnostics** entry in the roster, below the session cards,
  showing the count since the last clear, `details: diagnostics log` (or a
  `NOT saved: ...` reason once a persistence failure is known), and
  `enter clears warning`. Records are written asynchronously, so the pointer means
  only that no failure is known yet, not that a write has completed.

To clear the warning, highlight that roster entry and press Enter while the roster
has focus, or single-left-click the drawn entry. Only a fully drawn entry can be
cleared. The clear covers exactly the count that was drawn, so an error that arrives
later warns again. Clearing never deletes, rotates, truncates, or resets the log. It
does not change focus, the active Main owner, sidebar visibility, the selection of any
session, or any child's input. Keys typed while a native Main frame has focus,
including Enter, remain native input. There is no new host key binding or setting.

Records are saved under the canonical native agent directory (Pi's
`PI_CODING_AGENT_DIR` override when set, otherwise `~/.pi/agent`) at
`<agentDir>/session-host/terminal-diagnostics.jsonl`. The file is created only when the
first diagnostic of a run is recorded. Retention is exactly three files: the active file
plus `terminal-diagnostics.jsonl.1` and `terminal-diagnostics.jsonl.2`, each at most
5 MiB (15 MiB total). Before a line would push the active file past 5 MiB, `.2` is
removed, `.1` becomes `.2`, and the active file becomes `.1`. Each line is a JSON
record whose first key is the schema marker
`pi-review-gate.session-host.terminal-diagnostics.v1`:

- a `host-run` record at the start of every file a run writes, including each file
  after rotation (numbered by `segment`), so retained records keep their run's
  identities. It carries the identities that are actually available: package
  name and version, Node.js version, platform and architecture, the resolved Pi
  version, and the installed `@xterm/headless`, `@xterm/addon-unicode11`, and pinned
  pi-tui versions. Missing values are omitted, never guessed;
- `diagnostic` records with time, run and session-row identifiers, level, category,
  a fixed message identifier, and pane geometry, buffer, and synchronized-frame
  state. For parser errors they add the parser state, the rejected code point, its
  offset, the collected intermediates, and only the active parameters (bounded);
- a bounded stack labelled `logger-call-site`: the host call stack at the moment
  xterm called the logger. xterm parser errors are state reports, not exceptions, so
  records state `not-applicable-parser-state-report` and never invent an originating
  child stack or cause. A genuine Error passed to the logger keeps only its own
  frames, labelled `logged-error`;
- `diagnostic` records in the `host-clipboard` category for actual native clipboard
  routing failures. They carry only time, run and session-row identifiers, level, the
  fixed message identifier, the suppressed count, and `not-captured` in place of a
  stack: no geometry, parser state, stack, error name, or exception text;
- `dropped`, `diagnostic-omitted`, and `host-run-end` summary records.

Logger message text, arbitrary logger arguments, raw terminal bytes, conversation or
tool text, credentials, and environment values are never retained. Per session pane,
at most 16 detailed records are kept in a burst, then one every 2 seconds; host
clipboard routing failures share one host-wide bound of the same size. Further
calls are counted, and the next detailed record carries that count. Unwritten lines
are held in a bounded queue (256 lines, 1 MiB); overflow is recorded as a dropped
count, not as growing memory. Nothing is transmitted, and there is no polling, daemon,
or new setting.

Persistence is ownership-safe and fails closed:

- The state directory must be a real directory, not a symlink. On POSIX it must also
  be owned by the current user and must not be writable by group or others.
- Log files must be regular, single-link files owned by the current user, opened
  without following symlinks. New files are created exclusively with mode `0600`.
  On POSIX, an existing active or rotation file with any group or other permission
  is refused (`unsafe log file`). Its contents, mode, and path are left unchanged;
  the host never changes its mode. On Windows the agent directory's OS access
  control applies; the host sets no custom ACL.
- A rotation slot or an existing active file is moved, removed, or appended to only
  when its first line carries the schema marker. Any other file, including an empty
  one, is left untouched.

When persistence fails or is unavailable, the warning says so with a fixed phrase,
for example `NOT saved: unsafe log file` or `unknown file at log path`. No path or
payload is printed to the terminal, nothing falls back to the console, and child
sessions keep running. A failed log stays disabled for the rest of that run. At
shutdown the host flushes each pane's pending diagnostics, appends the end record,
syncs, and closes the log within a bounded wait. Each file is also synced before it
rotates; a failed sync stops persistence (`log sync failed`) before any file is moved,
and the file is still closed. Some write errors only surface at a sync. The host reports a cleanup failure, and never success, when:

- the log cannot settle in time;
- the final sync fails (`log sync failed`; the file is still closed);
- any other persistence failure is first seen after shutdown began.

None of these by itself keeps the host ownership record. Focused tests drive constructed malformed input through the
production parser, compositor, writer, and host. They do not identify the cause of
any earlier on-screen corruption and do not certify physical terminal behavior.

## Quitting and cleanup

Quitting the host stops its owned children and **preserves the global roster**: closing
the host is not an explicit removal, so the remembered rows stay exactly as they were and
the next host restores them. Only an explicit row removal forgets an entry — the settled
exited/error row removal above, or an explicit removal of a remembered-but-unavailable
error entry. Quit never rewrites the roster to an empty or differently ordered one.

Quitting the host asks for confirmation whenever it still owns a live child-process
handle, including a row marked error; the row's lifecycle badge alone does not determine
whether a handle is live. It then asks each active authenticated status registration to
request native shutdown, when that public control is available, and waits only within
the existing bounded grace window. A `requested` acknowledgement means the request was
accepted; it is not proof of PTY exit or successful graceful termination. The host
therefore treats only the owned PTY's actual exit event as confirmation. On POSIX,
unavailable or failed public control falls back to SIGTERM for that owned handle
immediately. A public request still pending after the first half of the shared grace
window also falls back to SIGTERM, leaving the remainder for an owned exit; without
a confirmed exit by the deadline, the manager escalates with SIGKILL against that
same handle. On Windows no POSIX signal is sent: forced escalation calls the same
public PTY handle's no-argument `kill()` and still waits for its actual exit event; a
shutdown acknowledgement is never exit proof. The host does not scan for processes or
promise to stop arbitrary detached descendants. A forced stop or a child whose exit
could not be confirmed is reported truthfully; do not assume such a handle has exited.
The optional network coordinator closes only this host's owned local listener, client
connections, viewers, and timers that it actually owns. An unconfirmed local settlement is
reported and keeps agent-directory ownership; shutdown never waits for a remote receipt
and never stops a remote session or remote work.
Native Pi configuration, credentials, conversations, and unknown files are preserved,
not removed as part of host shutdown. Apart from deliberate Saved-file deletion,
Host shortcuts saves, explicit network actions that save settings or trust, and the
bounded terminal diagnostics log (written only after a
diagnostic, see [Terminal parser diagnostics](#terminal-parser-diagnostics)), the
persistent roster and ownership record are the only
session-host files changed by a normal run: the roster is republished atomically when
rows are created, removed, renamed, reactivated, or change their native conversation, and
this host's ownership record is removed only after its owned children settled. Unconfirmed
child exit or unavailable settlement evidence keeps the ownership record so a later host
refuses to start until the situation is resolved; forced termination alone does not retain
ownership once exit is confirmed.
