# Optional Pi session host (alpha)

`pi-review-sessions` is an optional terminal host for running multiple, independent
native Pi sessions side by side. It is a separate entry point: it does not replace
`pi-review-gate`, the normal Pi CLI, or either standalone review-gate launcher. Use
those existing entry points as before when you want one ordinary Pi session. It is not
a tmux integration, daemon, remote host, or session-adoption layer: it owns only
sessions it starts locally.

This is alpha guidance, not a finished-host compatibility guarantee. The alpha design
uses Pi's public `ProcessTerminal` input and terminal-negotiation path with custom
generated frame composition; it is not a `TuiAltScreen` renderer. Native wrapper,
terminal-input, menu, question, editor, and runtime parity remain under integration
verification.

Component, mock, or socket tests alone do not prove compatibility with a real native
Pi wrapper. macOS and Linux are the intended POSIX host platforms; intended platform
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
  real Windows Node 22.19 and 24 runtime evidence passes; in the upcoming sidebar
  alpha release that runtime acceptance is deferred under
  https://github.com/rfairburn/pi-review-gate/issues/345. The ordinary standalone
  Windows launcher remains unchanged.
- **Node.js:** 22.19.0 or newer.
- **Pi:** stable Pi 1.0.4 or newer; the provisioned runtime and native UI
  acceptance fixture are pinned to **1.3.0**, with the matching 1.3.0 TUI dependency.
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
runtime-role contexts before starting a host. Installed packages use their compiled
output. Source launches can reuse a previously completed private stage when the exact
build/runtime input contents and modes, Node/npm implementation, platform, and build
configuration still match. Cache hits skip dependency installation and TypeScript
compilation, not Pi identity/version checks or DDGS validation. Cached artifact contents
and filesystem identities are checked before any cached setup helper or host is loaded.
Uncommitted source, script, skill, lockfile, manifest, or tsconfig changes invalidate reuse.

First or changed source builds still use fresh bounded staging and locked
`npm ci --include=dev --ignore-scripts`, followed by the stage-installed TypeScript
compiler directly through trusted Node, without the package build script's recursive
clean step. Unknown external Node preload/loader, dependency, or environment modes
(including proxy overrides) bypass reuse rather than assuming unchanged build inputs.
Invalid, incomplete, unsafe, or raced cache entries are preserved; the launcher builds
privately instead of loading unverifiable output. Cache manifests are corruption/freshness
checks, not protection against a same-user writer forging both artifacts and metadata;
filesystem identity fences are not an atomic filesystem sandbox. Development-build,
fallback-Node and isolated-Pi caches each target **five generations**, counted
independently, and excess generations are reclaimed best effort before another artifact
is created. A build's npm home/cache/temp residue stays inside its one generation; Pi
stages and publishes inside its own version root without an extra generation. Partial
npm output stays in a contained `.setup` directory until validated `node_modules`
publication, so another launcher cannot reuse a half-install. Compatible build reuse
neither inventories nor prunes generations.

Cleanup never refuses creation. Stale or malformed non-live lock artifacts are
reclaimed rather than permanently disabling pruning, and missing/malformed legacy
lifetime records do not protect cache contents. A live producer lock or actual cleanup
failure is reported as a bounded warning and the launch continues, so five or more legacy
generations can never block startup. Destructive reclamation and the session host's
ownership acquisition are mutually exclusive through the same per-agent coordination
entry described above: cleanup holds it only while it removes excess generations and
creates its own, rechecks the ownership record after any wait or stale-lock recovery,
and rechecks it again at every destructive boundary, so a host that becomes the owner
mid-pass keeps the remaining generations. When that entry is unavailable (a busy live
holder or an unremovable artifact) cleanup is skipped with a truthful warning and the
launch continues; a direct-child `.terraform` entry and a special leaf (FIFO, socket, or
device name) inside the producer-owned cache are ordinary disposable content and are
unlinked without being opened. Active sessions stay protected by the host's own
exclusive agent-directory ownership record; cache entries are not a second lifetime
gate, and no consumer is killed to obtain space. No age/size quotas, per-file creation
receipts, mount censuses, or checkpoint/history cleanup are added; a live owner-pid
marker only prevents pruning a generation another producer is still filling (the root is
fenced before marker inspection, and malformed markers are not liveness). An incomplete
fixed-name Pi version root that cannot be reclaimed falls through confined
`pi-<version>.<n>` generations without a fixed candidate limit, and later launches reuse
any valid generation for that exact version, so it also cannot stop startup. Settled failed or
aborted setup is reclaimed by a later cleanup, and an incomplete Pi installation can
retry the same version through identity-checked replacement. Ordinary package scripts
are unchanged.

The fallback Node wrappers reclaim excess direct-child artifacts before creating another
one, using the same best-effort rules; a failed deletion warns and the launch proceeds.
They still extract a fresh checksum-pinned official archive rather than reusing mutable
Node, and the supported PATH-Node route is unchanged. POSIX and native PowerShell both
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
alias-containment checks before the version probe; they do not acquire a lifetime pin.
Normal POSIX host shutdown keeps the existing ownership/cleanup guards for the agent
directory; cache cleanup is independent of the numeric exit status. Cache metadata is
coordination, not a same-user security sandbox. Installed compiled-package startup
does not inspect or clean the development-build cache. The normal review-gate launchers,
their behavior, and user settings are unchanged.

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
asks only for an
explicit existing workspace directory; there is no separate host display-label field.
Submitting New creates the child and immediately makes it the active Main input owner
without a second row Enter; the sidebar stays visible.

An authenticated top-level session-host child with the review-gate reporter also exposes
`SessionSpawn`; delegated executor children do not. It requires exactly an existing
workspace, title, and nonempty prompt. It creates a fresh native Pi process and
conversation in that workspace, without creating a worktree, clone, or branch. Native
settings and compatible inherited launch options remain shared, but the parent's
conversation name and startup message/file inputs are not inherited. The supplied title is
forwarded unchanged to Pi's native session-name API; Pi applies its own persistence
semantics, including trimming surrounding whitespace on the pinned 1.3.0 runtime. The
host does not crop or shorten titles to fit the sidebar, and titles longer than the
recommendation remain stored in full after Pi's native normalization. The prompt is
handed unchanged to Pi's public user-message API with prompt-template expansion disabled,
so leading `@`, `/`, and option-like text are prompt content rather than CLI inputs. It is
dispatched only after review-gate session initialization has established checkpoint scope
and deferred-tool authorization, and is recorded in the review request context before the
turn starts. The child is added in the background: its row appears without changing the
selected row, focus, active Main owner, or sidebar visibility. A successful result
confirms process launch only, not prompt processing or completion. The tool's title-width
suggestion is a host-computed snapshot of the sidebar title area in the visible layout
when that reporter child was launched; it is advisory and may become stale after a
resize. Ordinary launch, New-session, and saved-conversation behavior is unchanged.

The sidebar name comes from the observed native conversation metadata (the stored
native name or Pi's native first-user-message fallback). Until that metadata is observed,
the row reports that the session name is unavailable rather than inventing a user label.
The New field uses Pi's native path completion, with relative suggestions rooted at the
host startup working directory; this does not select that directory as the workspace.
Its on-screen key cues reflect the current `keybindings.json` in the shared native Pi
agent directory. A genuinely absent optional file is silent and uses Pi's real default
form keys; an unavailable, unsafe, or unsupported file keeps a bounded warning and the
same default keys. The per-window Profile field is removed: every child uses the same
canonical native Pi agent directory, resolved from `PI_CODING_AGENT_DIR` or Pi's
ordinary `~/.pi/agent` default. That directory is fixed user configuration, not a
workspace selector, and cannot also be selected as a session workspace.

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
existing Enter behavior and guards. A successful New submission or saved-conversation
open activates the created or restored child directly, without a second row Enter.
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
workspace shows as unavailable, never a current-workspace guess. Highlighting a row does nothing to any running session. Deliberately selecting a row
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
query semantics (adapted from Pi 1.1.0 and unchanged in the pinned 1.3.0 runtime): fuzzy tokens, quoted phrases such as `"node cve"`, and
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
at the displayed geometry. Forms, confirmations, and the narrow sidebar overlay are not
native Main click targets. Once Main already has focus, mouse input keeps its existing
native behavior.
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
In the New session form, Enter (or the configured native submit binding) submits the
explicit workspace path; the native Editor
provides path completion and its current Pi editing bindings. A successful submission
activates the created child as the active Main input owner, and that submission key's
repeat/release is fenced so it is never replayed into the new child as native input. If a completion menu is
open, the first Escape/cancel action dismisses that native menu and keeps the form; the
next fresh Escape cancels only New and returns to the visible roster without hiding the
sidebar. New and Edit cancellation are both local to their own form: the active Main
owner, native process, native input draft, persisted name, selection, and geometry are
preserved, a retained New **Workspace** draft is still offered by a later form, and the
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
broadcast to hidden or sibling sessions. Native Escape, `q`/`Q`, and Ctrl+C remain Pi's
keys whenever the native frame has focus. They cannot be configured as the sidebar
toggle; conflicting Escape aliases are rejected too. Only the admitted configured
toggle chord is reserved there, including its repeat and release events. The default
`alt+left` therefore intentionally takes precedence over Pi's native word-left chord;
use the Host shortcuts editor or the legacy `--sidebar-key f8` override (or another
supported key) if you need to keep that native chord.

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
Loaded sessions automatically re-establish activity from fresh, complete observations
of their exact owning sources at startup/restore and safe event-driven resynchronization
points. Deliberately stale or unknown activity can recover to the actual idle/zero or
running/nonzero state without a prompt, new task, or manual refresh. A Ready label is
not proof of idleness: unavailable or incomplete source observations remain unknown,
and stale source/session observations cannot replace a current incarnation's state.
This refresh reconstructs ephemeral activity only; it does not clear cleanup ownership,
delete recovery records, resume work, or weaken stop/remove safeguards. It adds no
periodic polling.
After a same-process extension reload, each existing authenticated `session_start` may
make one bounded read-only pass over its snapshot of eligible retired execution
controllers whose exact association inventories were sealed by completed detaches. Each
eligible exact owner is read at most once in that pass; an in-flight read is not
duplicated, and a retired source already proven complete and empty is skipped. Failed
or fresh incomplete/unavailable reads leave the affected channel unknown and may be
retried on a later explicit `session_start`. A stale/discarded read leaves the exact
incarnation's existing channels and tokens unchanged and may be retried on that later
event; a source-list change discards that pass's snapshot and results without restarting
it. Recovery is event-driven only, with no periodic polling or transport
heartbeat trigger. Any later admission or local state/token mutation invalidates that
owner's seal. Only validated, identity-matched manifests, task archives, and
operation-owner evidence can resolve that old incarnation; known stopped work may clear
activity intent while its recovery/cleanup token remains owned. The pass runs before
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

### Inline images and compatibility

Ghostty is the concrete image-display target, not a blanket terminal-graphics
compatibility promise. The native protocol fixture uses Pi and pi-tui **1.3.0**.
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
a sidebar selection, or change session/workspace ownership.

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
unchanged; cancelling the form restores the same child frame, while completing New or
Saved activates the new child as the Main input owner (completing Edit restores the same
child frame).
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
native child. The first left click in the visible native pane while the roster owns
focus is consumed to return focus to that active Main owner; subsequent mouse input is
forwarded normally. This does not add conversation wheel/trackpad scrolling (#332). On
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

When xterm reports a warning or error, the host shows a clearable warning in its own UI:

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
- `dropped`, `diagnostic-omitted`, and `host-run-end` summary records.

Logger message text, arbitrary logger arguments, raw terminal bytes, conversation or
tool text, credentials, and environment values are never retained. Per session pane,
at most 16 detailed records are kept in a burst, then one every 2 seconds. Further
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
Native Pi configuration, credentials, conversations, and unknown files are preserved,
not removed as part of host shutdown. Apart from deliberate Saved-file deletion,
Host shortcuts saves, and the bounded terminal diagnostics log (written only after a
diagnostic, see [Terminal parser diagnostics](#terminal-parser-diagnostics)), the
persistent roster and ownership record are the only
session-host files changed by a normal run: the roster is republished atomically when
rows are created, removed, renamed, reactivated, or change their native conversation, and
this host's ownership record is removed only after its owned children settled. Unconfirmed
child exit or unavailable settlement evidence keeps the ownership record so a later host
refuses to start until the situation is resolved; forced termination alone does not retain
ownership once exit is confirmed.
