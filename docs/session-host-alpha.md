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
startup, public named-pipe, and pinned node-pty ConPTY source paths are being prepared
for native validation only. Source implementation is not Windows runtime support or
readiness evidence: the parent phase still requires real Windows Node 22.19 and 24
Main, PTY, kernel, graceful-shutdown, and terminal-restoration tests.

## Requirements and launch

- **Host platform:** same-machine POSIX macOS or Linux remains the documented
  runtime scope. Windows source paths now admit the same-machine host and public
  ConPTY flow for validation, but Windows is not supported/readiness-certified until
  real Windows Node 22.19 and 24 runtime evidence passes. The ordinary standalone
  Windows launcher remains unchanged.
- **Node.js:** 22.19.0 or newer.
- **Pi:** stable Pi 1.0.4 or newer; the provisioned runtime and native UI
  acceptance fixture are pinned to **1.1.0**, with the matching 1.1.0 TUI dependency.
- An interactive terminal with both stdin and stdout attached.

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
system's temporary directory. The sidebar toggle defaults to `alt+left`; `f8` is an
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
bounded staging, locked `npm ci --ignore-scripts`, and the existing build script; public
Node can terminate only the directly owned Windows setup child, so abnormal timeout
settlement is not represented as descendant-tree proof and uncertain stages are kept.
Setup preserves trusted original `NODE_OPTIONS` and provider values while removing only
stale host capabilities. Setup failures stop startup rather than falling back to a
shell wrapper. The normal review-gate launchers, their behavior, and user settings are
unchanged.

## Starting and owning sessions

The host opens on a welcome/sidebar picker; it does not implicitly launch a Pi session
or treat its own startup directory as a workspace. Each **New session** asks only for an
explicit existing workspace directory; there is no separate host display-label field.
The sidebar name comes from the observed native conversation metadata (the stored
native name or Pi's native first-user-message fallback). Until that metadata is observed,
the row reports that the session name is unavailable rather than inventing a user label.
The New field uses Pi's native path completion, with relative suggestions rooted at the
host startup working directory; this does not select that directory as the workspace.
Its on-screen key cues reflect the current `keybindings.json` in the shared native Pi
agent directory. If that file is absent, unavailable, or unsupported, the form shows a
bounded warning and uses Pi's default form keys. The per-window Profile field is removed: every child uses the same
canonical native Pi agent directory, resolved from `PI_CODING_AGENT_DIR` or Pi's
ordinary `~/.pi/agent` default. That directory is fixed user configuration, not a
workspace selector, and cannot also be selected as a session workspace.

Each host-created row owns a separate top-level native Pi process, selected workspace,
new conversation, input route, terminal frame, and lifecycle. All children naturally
share ordinary native Pi configuration and resources: settings, authentication,
models, keybindings, extensions, MCP configuration, skills, and provider environment.
The host does not clone those files, republish skills, create per-window credentials, or
require a separate login. It does not attach to existing or detached processes, adopt
them, or reparent work. Moving the sidebar highlight does not change the active
session; press Enter to activate a row. Activating another session or hiding the sidebar
changes only display and input focus: it does not pause, stop, or transfer ownership of
any session. Background work can continue while another session is active. If the active
owner exits or disappears, the host does not automatically send input to a sibling.

**Saved conversations** is a deliberate, read-only picker in the sidebar. It lists the
shared native agent root's saved conversations showing each conversation's canonical
caption only — never transcripts, tool arguments, question text, or credentials.
Highlighting a row does nothing to any running session. Deliberately selecting a row
revalidates that exact catalog entry (file identity and first-line header) against the
live file and starts a new, independently owned child in that conversation's recorded
workspace with an exact per-child `--session` admission; it never adopts an external
process or attaches a child to another live conversation. A conversation already open in
this host is refused while its row is live or its creation is pending, and can be opened
again after that child has confirmed exit. The picker shows truthful loading, empty,
unavailable, and partial issue-count notices; Up/Down moves the highlight, Enter opens
the highlighted conversation, and Escape returns to the roster without pausing or
stopping anything. A late listing or creation result never takes over a later-opened or
dismissed pane.

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
the New session/Quit host row, Delete removes the selected exited row (`x` does so if
Delete is explicitly configured as the sidebar toggle), `q`/`Q` activates Quit host,
and Escape hides the sidebar. Removal is refused unless the backend has
confirmed that the child exited; a live, unconfirmed, or stale row remains in place
with a notice. Removing an exited row only detaches that host-owned entry: it does not
signal a process or delete its workspace, native Pi files, or saved conversation files.
Delete remains native input in Main focus unless it is itself the explicitly configured
sidebar-toggle chord.
In the New session form, Enter submits the explicit workspace path; the native Editor
provides path completion and its current Pi editing bindings. If a completion menu is
open, the first Escape/cancel action dismisses that native menu; the next cancels the form.
A form can also be abandoned while a launch/rename result is pending; that changes UI
ownership only and does not stop or roll back the backend operation. The Edit form is
available with `e` while a row with observed native metadata is highlighted. It shows the
current native name for reference and starts with a separate empty **New name** field;
the existing name is never prefilled or treated as an editable draft. Submitting sends a
persisted rename request fenced by the host row id and the exact observed native session
id/epoch. A stale or unavailable tuple is rejected, and a failed rename leaves the
session name unconfirmed. Editing never activates the row, routes input to it, pauses or
stops its child, or changes the active input owner. Both forms show the effective native
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
of generic activity lines. Native names may use Pi's first-user-message fallback when
there is no stored title. The sidebar does not monitor or coordinate reviewers, workers,
or their children, and does not display tool arguments, question text, transcripts, or
secrets. Status stays unknown until it is observed; an unavailable reporter, disconnect,
error, or process exit does not turn unknown into Idle. Exited rows retain their last terminal frame until
explicitly removed. There is no heartbeat timeout that declares a quiet session dead,
so a valid idle state may remain for hours.

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
input and model behavior are otherwise unchanged. Normal and alternate child buffers,
terminal query replies, and resize state are kept per instance and routed only to that
same child. Cell widths use the pinned Unicode 11 behavior for CJK, combining marks,
and basic emoji; newer emoji and complex ZWJ sequences are not guaranteed to match
Pi's standalone layout.

With the sidebar visible at 53 columns or wider, it uses 32 columns plus a divider
and leaves at least 20 columns for the native frame. The New/Edit form
temporarily replaces that right (native) pane while the roster remains on the left;
below that width the form is a full-content overlay instead. While the form is open,
the underlying child keeps running unpaused with its geometry and input ownership
unchanged, and cancelling or completing the form restores the same child frame.
Below 53 columns the sidebar is a frontend overlay while it has focus; native
geometry remains full-width and unchanged across focus switches, and returning to
native focus only removes the overlay. Sidebar hint text wraps across reserved
footer rows instead of being ellipsized; when the geometry cannot show the hints
plus a usable pane, that pane shows a truthful too-small message rather than
half-hints. Very small terminals show bounded text, not a promise that every native
Pi menu will remain readable.

The intended mouse path is cell-based and applies only to the active native frame;
events outside that frame are dropped before coordinate translation, never clamped to
the pane edge. Pixel-coordinate mouse reporting and
terminal-focus forwarding are not supported, and the alpha makes no promise of mouse
controls for the host sidebar. Keyboard negotiation is designed around independent
Kitty keyboard flags 1, 2, and 4, preserves modified Enter through Pi's
`modifyOtherKeys` fallback, and drops key-release events when the child has no event
reporting support. These input paths are still being integrated and verified; do not
treat the design description as proof that every terminal/input combination works.

## Quitting and cleanup

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
not removed as part of host shutdown.
