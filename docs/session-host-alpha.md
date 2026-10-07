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
Pi wrapper. macOS and Linux are the intended host platforms; intended platform scope
is not evidence that end-to-end Linux runtime compatibility has been proven.

## Requirements and launch

- **Host platform:** same-machine POSIX macOS or Linux. This alpha adds no Windows
  host support; the existing standalone Windows launcher remains unchanged.
- **Node.js:** 22.19.0 or newer.
- **Pi:** stable Pi 1.0.4 or newer.
- An interactive terminal with both stdin and stdout attached.

The host must launch Pi through its actual supported Node CLI entry, not through an
arbitrary shell command. By default, `pi-review-sessions` looks for `pi` on `PATH`,
but accepts it only when that file is an executable Node entry with a standard direct
`node` shebang or `env node` shebang. A `pi` name that resolves to a shell shim is not
sufficient. Opaque shell or managed-shell wrappers, native/SEA executables, and
complex interpreter flags are rejected before the version probe. For a managed or
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
`--sidebar-key`. `--state-root` selects a dedicated root for generated private
profiles; by default, generated profiles live under the native Pi agent directory's
`session-host` area. The sidebar toggle defaults to `alt+left`; `f8` is an example of a
way to leave Alt+Left available for native word-left editing. Put native Pi arguments
after a literal `--`; allowed arguments retain their original order and bytes. There
are no initial host `--workspace`, `--profile`, or `--label` options.

Parent startup arguments apply to **every new instance**. To preserve a new native
conversation in each selected workspace and private profile, the alpha rejects
`--continue`/`-c`, `--resume`/`-r`, `--session`, `--session-id`, `--fork`,
`--session-dir`, and `--no-session`, including attached-value spellings. A nonempty
inherited `PI_CODING_AGENT_SESSION_DIR` is also rejected because it redirects
profile-owned session storage. Rejection happens before setup or instance creation;
diagnostics identify the option, never its value. Ordinary option values and arguments
after Pi's own `--` terminator remain data, not forbidden options. Native commands
inside an individual window, including `/resume`, remain unchanged. No shared-chat
mode or per-instance startup-configuration UI is included.

The launcher rejects unsupported platform, Node version, non-interactive use, and
runtime-role contexts before starting a host. It builds from a source checkout or uses
the compiled package, then validates or provisions the existing DDGS environment once
before starting the host or creating any instance capability. Setup failures stop
startup rather than falling back to a shell wrapper. The normal review-gate launchers,
their behavior, and user settings are unchanged.

## Starting and owning sessions

The host opens on a welcome/sidebar picker; it does not implicitly launch a Pi session
or treat its own startup directory as a workspace. Each **New session** requires a
nonempty label and an explicit existing workspace directory; an existing profile
directory is optional. The workspace is chosen for that instance; the host does not
silently use its current directory. The optional profile is a separate Pi agent-state
directory with its own local review-gate configuration, never the workspace itself. If
no profile is supplied, the host creates a new private profile under the selected state
root. Generated profiles persist after exit.

Each host-created row owns one top-level native Pi process, workspace, conversation,
profile, model/settings, reviewers, workers, and their children. The host does not
attach to existing or detached processes, adopt them, or reparent work. Moving the
sidebar highlight does not change the active session; press Enter to activate a row.
Activating another session or hiding the sidebar changes only display and input focus:
it does not pause, stop, or transfer ownership of any session. Background work can
continue while another session is active. If the active owner exits or disappears, the
host does not automatically send input to a sibling.

A fresh generated profile receives only the standalone review-gate's zero-model
configuration defaults. The host does not copy global or sibling authentication,
settings, models, or other profile files, and does not choose a model, provider,
reviewer, or worker for you. Configure native Pi settings and the review gate separately
in each instance, including through `/review-settings`. Existing profiles are used as
chosen and must contain their own valid local review-gate configuration; a profile
cannot be active in two instances managed by the same host at once. This admission
check does not lock a profile against a separate host or standalone Pi process; do not
reuse one profile concurrently outside this host. Independent profiles are not account
isolation or a sandbox: two profiles may use the same provider account, and native Pi
code runs with the permissions of your operating-system user.

The host itself does not require Git merely to start a session. It adds no
question-only, no-worktree, or capture-bypass mode: the normal review, evidence-capture,
and delegated-execution policies still apply to native activity.

## Focus, display, and status

Host keyboard controls apply only while the corresponding host surface has focus. In
the sidebar, Up/Down moves the selection, Enter opens the selected session or activates
the New session/Quit host row, `q`/`Q` activates Quit host, and Escape hides the sidebar.
In the New session form, Enter advances to the next field and submits from the last
field; Escape cancels. Use the on-screen cues for quit confirmation. When a native Pi
frame has focus, input is sent only to the explicitly activated, live child; it is never
broadcast to hidden or sibling sessions. Native Escape, `q`/`Q`, and Ctrl+C remain Pi's
keys whenever the native frame has focus. They cannot be configured as the sidebar
toggle; conflicting Escape aliases are rejected too. Only the admitted configured
sidebar-toggle chord is reserved there, including its repeat and release events. The default `alt+left` therefore intentionally takes precedence over
Pi's native word-left chord; set `--sidebar-key f8` (or another supported key) if you
need to keep that native chord.

The sidebar is a bounded top-level summary: busy/idle/unknown state, pending-input
presence only when observed, and at most a couple of generic activity lines. It does
not monitor or coordinate reviewers, workers, or their children, and does not display
tool arguments, question text, titles, transcripts, or secrets. Status stays unknown
until it is observed; an unavailable reporter, disconnect, error, or process exit does
not turn unknown into Idle. Exited rows retain their last terminal frame. There is no
heartbeat timeout that declares a quiet session dead, so a valid idle state may remain
for hours.

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
and leaves at least 20 columns for the native frame. The New session form
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
whether a handle is live. It then makes bounded graceful and forced-stop attempts
against only the host's owned child handles. The host does not scan for processes or
promise to stop arbitrary detached descendants. A forced stop or a child whose exit
could not be confirmed is reported truthfully; do not assume such a handle has exited.
Generated profiles and unknown files are preserved, not removed as part of host
shutdown.
