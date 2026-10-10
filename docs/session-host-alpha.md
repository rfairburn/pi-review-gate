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
sidebar single-click activation, other physical input, or complete host-process shutdown
(see below).
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
activation is described below, but this does not certify Windows runtime behavior
(#323, #345). Conversation wheel/trackpad scrolling remains outside this change and
separate under #332; scroll-smoothness tuning remains separate work. A cosmetic child-pane
flicker on pointer movement and clicks has been observed; it is not breakage and not
a release blocker (#343). Native Pi/review-gate startup latency on Windows has been
present since before this release and is unrelated to it (#344).

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
  acceptance fixture are pinned to **1.1.0**, with the matching 1.1.0 TUI dependency.
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
privacy. Setup uses a fresh exclusive stage and public Node identity checks. Stages
are retained after setup because a root identity does not establish ownership of npm,
build, or runtime descendants; complete per-entry creation receipts with BigInt
identities are not recorded, so cleanup does not enumerate or delete stage contents,
even after graceful setup or native shutdown. A timed-out setup child that cannot be
positively settled is likewise not treated as clean. No custom Win32 pipe application, TLS/PSK layer, taskkill tree
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
host refuses instead of racing children that may still be running. Malformed, oversized,
unsafe, or unreadable roster state is reported truthfully and left untouched: nothing is
restored from it, persistence stays disabled, and nothing overwrites it. The sidebar toggle defaults to `alt+left`; `f8` is an
example of a way to leave Alt+Left available for native word-left editing. Put native Pi
arguments after a literal `--`; allowed arguments retain their original order and
bytes. There are no initial host `--workspace`, `--profile`, or `--label` options.

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
runtime-role contexts before starting a host. It builds from a source checkout or uses
the compiled package, then validates or provisions the existing DDGS environment once
before starting the host or creating any instance capability. Source builds use fresh
bounded staging and locked `npm ci --include=dev --ignore-scripts`. It then runs the
stage-installed TypeScript compiler directly through trusted Node, without the package
build script's recursive clean step; ordinary package scripts are unchanged. Public
Node can terminate only the directly owned Windows setup child, so abnormal timeout
settlement is not represented as descendant-tree proof and uncertain stages are kept.
Setup preserves trusted original `NODE_OPTIONS` and provider values while removing only
stale host capabilities. Setup failures stop startup rather than falling back to a
shell wrapper. The normal review-gate launchers, their behavior, and user settings are
unchanged.

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
semantics, including trimming surrounding whitespace on the pinned 1.1.0 runtime. The
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
The host does not clone those files, republish skills, create per-window credentials, or
require a separate login. It does not attach to existing or detached processes, adopt
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

**Saved conversations** is a deliberate, read-only picker in the sidebar. It lists the
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
an existing action entry. A single left-click on a displayed New, Saved, or Quit action
entry invokes that same existing action: New still opens its form, Saved its picker, and
Quit follows its existing confirmation rules. These sidebar clicks are handled by the
host, not forwarded to a native child; existing keyboard controls remain available.
The `d`/`D` or Delete keys stop/remove precisely the selected
fully displayed row (`x` is the Delete fallback when Delete is configured as the sidebar
toggle), `q`/`Q` activates Quit host,
Alt+Right returns input focus to the existing Main owner without activating the
highlighted row, resizing, or hiding (its repeats and releases are fenced so a held key
never leaks into the child; in Main focus Alt+Right is ordinary native input), and
Escape hides the sidebar. The reserved toggle is two-step: it shows and focuses a hidden
sidebar; from a visible Main focus one press only moves host input focus to the sidebar
without hiding it or resizing any child; and a press from sidebar-owned focus hides it
back to Main. A live row stops directly only with positively observed
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
sidebar-toggle chord is reserved there, including its repeat and release events. The default `alt+left` therefore intentionally takes precedence over
Pi's native word-left chord; set `--sidebar-key f8` (or another supported key) if you
need to keep that native chord.

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

The display is text and SGR styling, not a graphics renderer. The child terminal's
image/graphics protocol is disabled with `PI_IMAGE_PROTOCOL=none`; native Pi image
input and model behavior are otherwise unchanged.

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
native child. This does not add conversation wheel/trackpad scrolling (#332). On
Windows, bundled-ConPTY protocol observations do not certify physical mouse behavior:
manual validation has observed clicks working, but pane-confined selection and native
conversation wheel scrolling still require interactive validation, as described in the
Windows runtime limitation above. Pixel-coordinate mouse reporting and terminal-focus
forwarding are not supported. Keyboard negotiation is designed around independent
Kitty keyboard flags 1, 2, and 4, preserves modified Enter through Pi's
`modifyOtherKeys` fallback, and drops key-release events when the child has no event
reporting support. These input paths are still being integrated and verified; do not
treat the design description as proof that every terminal/input combination works.

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
not removed as part of host shutdown. The persistent roster and ownership record are the
only session-host files changed by a normal run: the roster is republished atomically when
rows are created, removed, renamed, reactivated, or change their native conversation, and
this host's ownership record is removed only after its owned children settled. Unconfirmed
child exit or unavailable settlement evidence keeps the ownership record so a later host
refuses to start until the situation is resolved; forced termination alone does not retain
ownership once exit is confirmed.
