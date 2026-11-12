# Native Claude Code and Codex sessions

Guide and reference for the session host's **initial native hosting**: real,
top-level interactive **Claude Code** and **Codex CLI** sessions started as
sidebar rows beside the Pi sessions, in the same owning sidebar, over the same
owned PTY and terminal surfaces. It is the published deliverable of
[#277](https://github.com/rfairburn/pi-review-gate/issues/277): how a native row
starts, what the host can honestly display about it, and what stays unknown.

Pi stays the default everywhere. Every New-session form still opens on Pi, every
existing Pi path is unchanged, and a native row is always an explicit local
choice. This is initial hosting, not a compatibility promise: the launch path, the
process handling (tested with synthetic children), and the New-session form and roster
behavior (tested at the UI level) are implemented, while **no real provider session
has been driven through the host yet**
([Evidence basis](#evidence-basis)).

Cross-ownership: [Session host](session-host-alpha.md) owns the host contract,
roster, sidebar status rules, and stop ladder;
[Configuration](configuration.md#the-externalagents-catalog) owns the
external-agent catalog; [Security model](security-model.md) owns trust
boundaries; [Development](development.md) owns verification commands.

## What shipped

- One native row is **one real full native interactive session**: the operator's
  own CLI as an ordinary PTY child of the existing host, under the same ownership
  model as a Pi row — one row, one child process, one workspace, one frame. No
  new detector, daemon, service, renderer, SDK client, or headless substitute was
  added: a provider's print, `exec`, or app-server path drives *its own* thread,
  so running it beside a hosted TUI would be a second conversation rather than
  the same session.
- Provider selection is the New-session form's **Provider** line, local only, and
  it **defaults to Pi every time the form opens**; choosing a native provider is
  explicit. The **Workspace** field and its initial focus behave exactly as before:
  the form still opens on **Workspace**, `Shift+Tab` once reaches **Host**, a second
  `Shift+Tab` reaches **Provider**, `Up`/`Down` cycle the displayed choice on the
  focused line, and `Tab` from **Provider** returns to **Workspace**. With the mouse,
  clicking the **Provider** label focuses that line and clicking its value cycles to
  the next displayed choice — and only from the presentation currently drawn, so a
  stale frame never acts. The line is drawn only while the host offers native
  targets and the pane has one row to spare: it never takes a row from the
  Workspace field's budget, a pending or error status, or the hint footer. A pane
  with nothing left to give draws no Provider line, and an undrawn line owns no
  invisible control — the focus ring skips it, the render that lost the space
  releases any focus it held, arrows cannot change an undrawn choice, and a click
  there is refused. It returns on a later render once a row is spare again, for
  example after a resize or once the field stops drawing a completion list.
- Choosing a native provider while the **Host** line names a connected destination is
  refused in the form: nothing is sent, and the form shows
  `<provider> is local only; choose Local or Pi`.
- A native target is either the built-in default for that backend or an explicit
  shared [`externalAgents`](configuration.md#the-externalagents-catalog) entry —
  its `command`, base `args`, and base `env`. The `review` and `execution` role
  overlays, their models, and their reasoning settings are **never** consulted: a
  top-level native session is not a delegated execution or review role. Each new
  session selects its native target again: the chosen target id, its executable,
  arguments, and environment are never persisted, so a later form cannot silently
  reuse them.
- Command discovery is the shared application-command resolver the settings
  availability probe already uses — one filesystem/`PATH`/`PATHEXT`/case contract,
  so neither surface keeps a second detector. One shared resolver is not an
  equivalence guarantee: the probe resolves against the settings process and the
  environment that layer assembles, while a launch anchors a relative spelling
  (`./wrapper`) and relative `PATH` entries to the selected workspace and searches
  only the composed child environment, which never carries the `review` or
  `execution` role overlays. The same configured command can therefore be reported
  available and still resolve to a different file, or to nothing, for the child.
  Within one surface the rules are identical: an explicit path is used exactly as
  given, a bare name is searched in `PATH` order, Windows also tries `PATHEXT`
  suffixes, and a `.cmd`/`.bat` shim runs through the trusted
  `SystemRoot\System32\cmd.exe` resolved from the **parent** environment only.
  Availability is also not a start: the launch below can still refuse a located
  executable — on its shared-argument guard, a target belonging to the other
  backend, an unsupported platform, or a `cmd.exe` it cannot resolve as trusted.
  **No caller-provided shell command string is ever accepted:**
  the operator supplies an executable and argv, never a complete shell command
  line. Windows batch execution does necessarily go through `cmd.exe`, so one
  command string exists on that path — the host generates it by quoting the
  resolved executable plus the exact argv it would otherwise have spawned, and
  that host-generated string is the only command text `cmd.exe` is ever handed.
  Whether a real Windows `cmd.exe` reproduces it verbatim is unverified
  ([Evidence basis](#evidence-basis)).
- **A missing binary is a refusal, and so is a shared argument this cannot host**
  — a documented headless or service mode, a permission, tool, sandbox, or
  hook-trust **override** flag, an existing-session attach or startup
  session/resume switch, or a workspace-scope change. The guard matches the
  documented option **name**, so an override flag is refused whatever value it
  carries: a restrictive spelling such as `--permission-mode plan`,
  `--sandbox read-only`, or `--ask-for-approval always` is refused just as a
  bypass is, because the host declines to be the thing that sets or replaces an
  approval posture rather than deciding which posture is safer. Nothing is
  silently stripped, translated, retried without the argument, or replaced with
  another target.
- **Codex adds exactly one argument, `--no-daemon`**, so the launched child owns
  its backend instead of joining or starting the shared background server. An
  older Codex build that rejects it fails rather than being launched onto the
  shared daemon. `--no-alt-screen` is not added, and no approval flag is added.
  Claude Code adds no arguments.
- **The CLI's own configuration and authentication are preserved.** The child
  inherits `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and provider
  authentication as-is, and nothing is written to the operator's Claude or Codex
  settings, hooks, plugins, or trust stores. This is deliberately *not* a blanket
  ban on settings, plugin, or MCP arguments: choosing a settings file, an MCP
  configuration, a plugin directory, or an agent definition is the operator
  configuring the very target they selected, and those arguments are forwarded
  untouched. Only the narrow categories listed above are refused, and they are
  refused by option name — so a permission, tool, or sandbox override flag is
  refused even when its value would make the provider stricter. The inherited
  native configuration stays native: the host neither reads it nor rewrites it.
- **Native state stays in the provider's own state directories.** The host's Pi
  agent directory continues to hold only Pi data plus this host's roster and
  ownership record; a native row contributes no Pi conversation, and the host
  never reads or migrates provider history.
- A native row **does not carry this project's review gate, tool protection, or
  subtask capture/review/landing guarantees**, and is never presented as a
  review-gate-managed worker.
- Native rows are created **locally only**. `SessionSpawn`, remote owner-create,
  the Saved picker, and the standalone launchers all keep creating Pi sessions and
  behave exactly as before. A remote viewer cannot type into a native row: that
  row has no status registration to fence an input scope against, so the viewer
  input path refuses it. No remote input, copy, or provider-tool behavior is
  claimed for a native row.
- A remembered native row keeps its own backend and workspace and **always** comes
  back as a truthful **unavailable placeholder** titled `<Provider> (unavailable)`:
  a remembered native row is never restarted automatically by a host restart, so
  there is no conditional auto-restart to wait for. The row states
  `<Provider> sessions are not restored; open New to start one`. It is never
  restarted as a Pi row, never adopted into a live provider process, and never
  bound to an arbitrary recent provider conversation; starting one again is always the
  operator's own New submission.

## Evidence basis

Each claim below carries one of four labels:

- **Documented** — the provider's own official documentation, reviewed as source
  only on 2026-11-12 against the versions below.
- **Probed** — an installed-binary check on a macOS development machine that ran
  version and help output only.
- **Implemented, exercised with synthetic children** — host code covered by real
  PTY tests whose child processes are purpose-built Node programs, not provider
  CLIs.
- **Unknown** — no evidence, or evidence too weak to state a fact.

| Provider | Documentation reviewed | Installed-binary probe |
| --- | --- | --- |
| Claude Code | `code.claude.com/docs`, the `@anthropic-ai/claude-code` 2.1.322 line | 2.1.319, a compiled native macOS binary |
| Codex CLI | `learn.chatgpt.com/docs`, the `@openai/codex` 0.167.2 line | 0.167.0, a compiled native macOS binary |

What the host-side runtime evidence actually is:

- Eight real POSIX `node-pty` tests in `tests/session-host-native-cli-pty.test.ts`
  drive the production launch adapter and the production session manager together:
  every child is a real OS process that reports its own pid, tty state, geometry,
  argv, and environment back through its own terminal, so spawn, addressed input,
  resize, a prompt answer, signals, and confirmed exit are observed from the real
  child. Claude, Codex, and Pi rows coexist in one manager without sharing a PTY,
  a registration, or a byte of input, and a native row keeps receiving raw bytes
  even when host input framing is on.
- **Every one of those children is a synthetic Node program with a synthetic
  question.** None of them is Claude Code or the Codex CLI, and the Pi rows in
  that file run an inert Pi shim, so it is not real-Pi, reporter, or
  broker-socket evidence either.
- The New-session form, roster, and refusal behavior above is covered by named
  suites rather than a run total:
  `tests/session-host-native-provider-sidebar.test.ts` (the Pi default at every
  opening, the explicit native choice, native card display, and the local-only
  refusal), `tests/session-host-new-form-provider-layout.test.ts` (the field's row
  budget and the suppressed-row keyboard and pointer rules against the real pinned
  field), `tests/session-host-native-provider-main.test.ts` (one injected launcher,
  that host's offered targets, and the carried provider choice),
  `tests/session-host-native-cli-instances.test.ts` (manager-side target validation
  and ownership), `tests/session-host-native-cli-launch.test.ts` (descriptor and
  argument policy), and `tests/session-host-roster-main.test.ts` (remembered-row
  restoration). That is form, roster, and refusal behavior only — no real provider
  binary takes part.
- The strongest host-side witness is one integrated acceptance case,
  `tests/session-host-native-cli-main-pty.test.ts`: the real public
  `runSessionHost` Main on a real outer `node-pty`, one ordinary Pi row on the
  pinned real Pi 1.5.2 run offline with tools and context files disabled (no model
  call, no prompt), and two native rows created through the actual Provider control
  — the real keystroke path through the production sidebar action, host create
  options, manager, and `createNativeCliLauncher`. It observes addressed input and
  its continuation after a row switch, one deliberate outer resize, the truthful
  unknown sidebar status, a natural fixture exit and a confirmed stop, the original
  pid and kernel-PTY exits, the Pi row's graceful exit, and the host's normal Quit
  with full outer restoration. A focused run of that case passed 1/1 in about 12
  seconds. The adjacent real-Main framing regression,
  `tests/session-host-native-main-framing.test.ts` (real production Main, one local
  New reaching a live real-Pi PTY child that renders typed text under the
  input-origin framing opt-in), passed 1/1 in about 11 seconds; it pins that Main
  framing path, not provider behavior.
- Those two focused runs are host-side only, and they are not a full-suite or CI
  result. They carry the same boundary as the eight PTY tests above — synthetic
  provider children with a real host, on POSIX, and these two are macOS-only — no
  real provider binary, physical terminal, Windows, review-gate, tool-protection,
  or MCP parity.
- An optional real Codex startup case was deliberately skipped: that it would
  cause zero side effects on the operator's OS keychain or startup network
  behavior could not be proven, and evidence gathering must not spend the
  operator's real credentials or keychain.
- Still unverified: a real provider interactive TUI in a physical terminal —
  rendering, model and auth round trips, mouse, images, in-pane resume, approval
  prompts, and platform-specific behavior. Windows remains an **unsupported
  validation target**: descriptor-level and mocked Windows cases are not real
  ConPTY certification
  ([Windows runtime acceptance](session-host-alpha.md#known-limitation-windows-runtime-acceptance)).
  One concrete gap: the Windows `.cmd`/`.bat` path builds a quoted batch command
  for `cmd.exe`, and those tests pin the generated descriptor string only. That
  string has never been observed arriving through a real `node-pty` Windows spawn,
  and the launcher and the host adapter emitting the *same* `cmdQuote` output is
  internal consistency, not evidence that Windows delivers it verbatim. Nothing
  here claims Windows support.
- Provider documentation also moves quickly — Codex's documentation host has
  already moved once — so treat version-specific detail as a dated snapshot, and
  read [Sources](#sources) as the boundary of what was reviewed. **Nothing marked
  Documented below has been observed running.**

## What the host owns, and what it never infers

- **Supported:** process spawn, addressed keyboard input, resize, the owned stop
  ladder, and the child's exit. These are host-owned process facts.
- **Unknown, always:** agent busy or idle, a pending question, a pending approval,
  task and subagent counts, and background shell counts. A native row gets no
  status registration, so those fields stay unknown rather than being estimated.
- The host **never scrapes the terminal** to guess a provider's state, and never
  infers idle from a missing PID, a quiet period, or an output gap. A row's exit
  event is the only settlement witness.
- Stop is an **explicit, confirmed owned stop**: an idle-only stop or removal of a
  native row always requires confirmation, exactly as an unobserved Pi row does.
- Resume is **in-pane only**, through whatever the provider itself offers (for
  example `/resume` in a running Claude Code session). Pi's rename, Saved
  conversation open, and exited-row resume are unavailable for a native row,
  because they are Pi APIs.

## Claude Code capabilities

| Capability | Evidence | Documented surface |
| --- | --- | --- |
| Startup | Documented | [`claude`](https://code.claude.com/docs/en/cli-reference) in the target directory starts the interactive session, optionally with a first prompt; `--add-dir` extends the working set |
| Workspace and config inheritance | Documented | User, project, project-local, and managed [settings layers](https://code.claude.com/docs/en/settings); [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars) relocates the whole configuration directory (default `~/.claude`), so an inherited environment selects the config directory and its stored account state |
| Auth inheritance | Documented | First-launch browser login, `/login`, `claude auth login` and `claude auth logout`, `ANTHROPIC_API_KEY`, and `claude setup-token` for a long-lived token ([Authentication](https://code.claude.com/docs/en/authentication)) |
| Native permissions | Documented | [Permission modes](https://code.claude.com/docs/en/permissions) (Manual default, `acceptEdits`, `plan`, bypass) selectable with `--permission-mode`, evaluated in deny → ask → allow order; administrators can disable the permissive modes. A hosted row never adds one of these: an approval posture is the operator's own choice, not a host default, and a configured target that names the flag is refused whatever value it carries |
| Native questions | Documented | [`AskUserQuestion`](https://code.claude.com/docs/en/tools-reference) multiple-choice questions **stay open until answered** unless `askUserQuestionTimeout` (`60s`, `5m`, `10m`) is set; permission prompts, including plan approval, never auto-resolve on idle |
| Cancel | Documented | [`Esc` interrupts the running turn](https://code.claude.com/docs/en/interactive-mode) and keeps a queued draft; `Ctrl+C` interrupts a running operation or clears input |
| Shutdown | Documented, non-interactive only | `/exit` closes an interactive session. The documented SIGTERM contract (Bash process tree terminated, exit 143) is described for non-interactive runs, so interactive stop and settlement semantics are unverified |
| Resume | Documented | [`claude -c`, `claude -r` with a session id or name, `/resume`, `--fork-session`, `--session-id <UUID>`](https://code.claude.com/docs/en/sessions); not everything is restored — plan mode only under conditions, and a forked process starts without the earlier session's permission grants. A hosted row starts no resume argument of its own |
| Native tasks and subagents | Documented in-client; **Unknown** as an external read | [`--agents` definitions and the `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted` hook events](https://code.claude.com/docs/en/hooks). [Agent view](https://code.claude.com/docs/en/agent-view) documents that spawned subagents and teammates are **not** listed as separate rows, and no external per-session task count is documented |
| Background shells | Documented in-client; **Unknown** as an external read | [`Ctrl+B`](https://code.claude.com/docs/en/interactive-mode) moves a running Bash command to the background (tmux users press twice); `!` shell mode runs a command directly; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` turns backgrounding off. No external per-session shell count is documented |
| External current-state read | Documented; **Unknown** under a hosted PTY | [`claude agents --json [--all]`](https://code.claude.com/docs/en/agent-view) is documented as the supported way to read session state from outside Claude Code: entries carry `cwd`, `kind`, and `startedAt`, and a live entry carries `pid`, `status` (`busy`, `waiting`, `idle`) and, while waiting, `waitingFor` naming the cause (permission prompt, question or MCP input request, sandbox request, open dialog). Two documented limits matter here: an interactive session open in another terminal is **not listed until it is backgrounded**, and the documented `state` values cover background sessions |
| Hooks | Documented | A large [lifecycle event set](https://code.claude.com/docs/en/hooks) (session, prompt, tool, permission, subagent, task, model switch, compaction, session end) with command, HTTP, MCP-tool, prompt, and subagent handlers, restrictable by managed settings — an available later route, not something this project installs |
| Headless and SDK | Documented, refused for a hosted row | `claude -p` and the Agent SDK drive their own conversation, and a project folder that was never trusted is treated differently there ([permissions](https://code.claude.com/docs/en/permissions)); they are never a substitute for the hosted interactive session, and a configured target that names them is refused |

## Codex CLI capabilities

| Capability | Evidence | Documented surface |
| --- | --- | --- |
| Startup | Documented | [`codex`](https://learn.chatgpt.com/docs/cli/reference) opens the interactive TUI; `--cd`/`-C`, `--add-dir`, `--model`, `--profile`; `--no-daemon` runs the interactive CLI without the shared background server and cannot combine with `--remote` or `codex agents` |
| Config inheritance | Documented | [Documented precedence](https://learn.chatgpt.com/docs/config-file/config-basic) with command-line flags above the project and user `config.toml` layers; an untrusted project skips its project-local configuration layer |
| Auth inheritance | Documented | `codex login` (ChatGPT OAuth, device auth, API key, or an access token piped over stdin), `codex login status` (exit `0` when credentials exist), and `codex logout` ([CLI reference](https://learn.chatgpt.com/docs/cli/reference)) |
| Native permissions | Documented | Two layers — [sandbox mode and approval policy](https://learn.chatgpt.com/docs/agent-approvals-security) (`--sandbox`, `--ask-for-approval`); the Auto preset is workspace write plus `on-request`; destructive app and MCP tool annotations always require approval ([app-server](https://learn.chatgpt.com/docs/app-server)). A hosted row adds neither flag |
| Native questions | **Unknown** in the TUI; Documented for app-server | No TUI multiple-choice question tool is documented. [app-server](https://learn.chatgpt.com/docs/app-server) exposes `item/tool/requestUserInput` (experimental: 1–3 short questions, optional free-form option) and MCP elicitation |
| Cancel | Partially documented | `interrupt_turn` is a configurable [`tui.keymap` chat action](https://learn.chatgpt.com/docs/config-file/config-basic); its default binding was not confirmed in the reviewed pages |
| Shutdown | Documented | `Ctrl+C` or `/exit` closes the session ([CLI reference](https://learn.chatgpt.com/docs/cli/reference)); an `Interrupt` hook event fires when a turn is interrupted ([hooks](https://learn.chatgpt.com/docs/hooks)) |
| Resume | Documented | [`codex resume` (by id or name, `--last`, `--all`) and `codex fork`](https://learn.chatgpt.com/docs/cli/reference); `--worktree` cannot combine with resume. These are subcommands or startup switches, so a hosted row starts none of them and resumes only in-pane |
| Native tasks and subagents | Documented in-client; **Unknown** as an external read | [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): `agents.enabled` defaults to `true`, built-ins are `default`, `worker`, and `explorer`, and custom agents are TOML files under `~/.codex/agents/` or project `.codex/agents/`; `SubagentStart` and `SubagentStop` [hook events](https://learn.chatgpt.com/docs/hooks) exist. No external current-state read is documented |
| Background shells | **Unknown** in the TUI; Documented, experimental, for app-server | No TUI shell mode or shell count was confirmed in the reviewed pages. app-server `thread/backgroundTerminals/list`, `/terminate`, and `/clean` are experimental and require the `experimentalApi` capability; `thread/shellCommand` runs outside the sandbox with full access and is never used |
| External current-state read | Documented for an app-server client; **Unknown** for a TUI-owned session | [`thread/read` and `thread/list` report runtime status, and `thread/status/changed` notifies with e.g. `status.type: "active"` and `activeFlags: ["waitingOnApproval"]`](https://learn.chatgpt.com/docs/app-server). Whether a second app-server client can observe a thread owned by a hosted TUI is unverified |
| Hooks | Documented | [Lifecycle events](https://learn.chatgpt.com/docs/hooks) covering session start and end, prompt submit, tool pre and post, permission request, subagent start and stop, compaction, model request, stop, and interrupt; non-managed hooks must be reviewed and trusted by hash before running (`/hooks`) — so installing one for the host would be an undisclosed change to the operator's environment, and this project does not do it |
| app-server | Documented, experimental | JSON-RPC over stdio by default; the WebSocket transport is documented as experimental and unsupported, and status-reading methods can be gated behind the `experimentalApi` capability |

## What a sidebar row shows today

The sidebar rules apply unchanged: an unobserved field stays `unknown`, never
idle and never zero, and the child's exit is the only settlement witness
([Sidebar status and activity](session-host-alpha.md#sidebar-status-and-activity)).

| Sidebar field | Claude Code row | Codex CLI row |
| --- | --- | --- |
| Lifecycle and exit code | Real: the host owns the child process | Real: the host owns the child process |
| Conversation name | Unknown: never scraped | Unknown: never scraped |
| Agent busy or idle | Unknown | Unknown; a documented status read exists only for an app-server client, unverified for a hosted TUI |
| Pending input | Unknown | Unknown |
| Background task count | Unknown | Unknown |
| Background shell count | Unknown | Unknown |
| Activity lines | None | None |
| Roster title of a remembered row after a host restart (always unavailable) | `<Provider> (unavailable)` | `<Provider> (unavailable)` |
| Idle-only stop | Confirmation required, always | Confirmation required, always |
| Rename, saved-conversation open, exited-row resume | Unavailable: Pi APIs | Unavailable: Pi APIs |

**Current state versus events, and freshness.** The host's status model is
event-driven with no periodic polling. The Claude Code external read is a poll, so
using it at all would be a per-provider adapter exception with its own
staleness-to-unknown transition rather than a global polling loop, and the host's
event-driven resynchronization points are not provider events. Codex's
`thread/status/changed` is a genuine event, but only for a client of that
app-server connection, and whether it describes a thread owned by a hosted TUI is
unverified. What the providers do document is a *transition* notification:
`SubagentStart` and `SubagentStop` on both, plus `TaskCreated` and `TaskCompleted`
on Claude Code. Neither documents any notification that a background shell count
changed inside a live interactive session, and no documented event carries the
complete current set of tasks or background shells. Hooks are therefore real
signal about transitions — but a transition stream is not a census: neither
provider documents a reliable way to enumerate the complete current state at host
startup or at a resynchronization point, so a hook-backed row would still have to
answer "what exists right now" honestly before displaying anything.

## Launch and ownership rules

- The child inherits the host environment as-is, which is what makes each CLI's own
  `PATH`, home, and configuration-directory resolution work with zero
  provider-side change. Host-owned session-bootstrap, startup-request, title,
  `NODE_OPTIONS`-restore, settlement markers, and any delegated-worker role
  authorization are stripped from the clone (including from a configured
  environment overlay), so a native child never inherits a capability it did not
  already own.
- The provider command, base arguments, and shared environment come from the
  operator's explicit
  [`externalAgents` catalog](configuration.md#the-externalagents-catalog) entry
  when one is selected; otherwise the built-in default command is used. The
  `execution` and `review` role overlays are **not** inherited: a top-level
  native session is not a delegated execution or review role.
- Codex adds only `--no-daemon`, so the launched child owns its backend instead of
  joining the shared background server. An older Codex build that lacks the flag
  fails with its own argument error; the flag is never silently dropped.
  `--no-alt-screen` and any headless or approval flag are not added. Claude Code
  adds no flags.
- Configured arguments that override the provider's permission, tool, sandbox, or
  hook-trust posture, or that would start a headless/service mode or attach to an
  existing conversation, or that would change the workspace scope, are a **launch
  refusal**, never a silent strip. The refusal is on the documented option name,
  so it covers restrictive values too: `--sandbox read-only` is refused exactly
  like a permissive spelling, and the operator's own inherited native
  configuration — which the host neither reads nor rewrites — stays native.
  Past a `--` terminator the provider reads prompt text, so those tokens are
  forwarded exactly and are never re-read as options.
- Stop uses the host's existing owned-handle ladder, and the child's exit is the
  only settlement witness; a PID disappearing is not proof of settlement. Because
  a native row has no status registration, no Pi shutdown request is attempted for
  it: the host signals the handle it owns and waits for that handle's exit.

## Trying one in an owned inactive stage

The recipe below runs the host from a **private stage you own**, so nothing about
your live installation changes: no launcher run, no global install, no skill or
settings refresh, no live `dist/`, and no live settings, configuration, or
credential file. The host refuses to start unless its stdin and stdout are both a
real terminal, which is why the last step uses `node -e`: `node -` with a heredoc
would consume the very stdin the host needs.

Set the two placeholders once in your own shell: `CHECKOUT` is this repository's
source checkout, and `PI_CLI` is the **actual Node CLI entry** of a supported
installed Pi — not a shell wrapper, the same requirement as `--pi-executable` in
[Requirements and launch](session-host-alpha.md#requirements-and-launch).

```sh
CHECKOUT=/path/to/pi-review-gate
PI_CLI=/path/to/pi-coding-agent/dist/cli.js

# 1. A short-named private stage outside both the checkout and your live
#    installation, with a fresh Pi agent directory and host state root inside it.
STAGE=$(mktemp -d /tmp/prg-native.XXXXXX)
mkdir -p "$STAGE/pi-agent" "$STAGE/state"

# 2. Compile into the stage. The checkout's live dist/ is never created or changed.
cd "$CHECKOUT"
npx tsc -p tsconfig.json --outDir "$STAGE/dist"

# 3. Stage the runtime files the host resolves at run time.
cp package.json "$STAGE/package.json"
cp -R scripts "$STAGE/scripts"
ln -s "$CHECKOUT/node_modules" "$STAGE/node_modules"
cd -
```

Keep the stage path short and close to the filesystem root. The host's status broker
creates a private transport directory and its socket beneath the `stateRoot` you pass,
and it refuses to start when that socket pathname goes past the 103-byte POSIX
Unix-socket limit — macOS' default per-user temporary directory is already long enough
that a `$(mktemp -d)/native-tryout/state` root overflows it, so startup fails before
the sidebar ever appears. The template above canonicalizes to
`/private/tmp/prg-native.XXXXXX` (macOS resolves `/tmp` to `/private/tmp`), which puts
the broker socket at 57 bytes — room to spare. If you pick a different root, keep the
canonical `<stage>/state` pathname at 82 bytes or fewer, because the broker appends its
own 21-byte transport directory and socket name beneath it.

The staged `node_modules` link points at the checkout's existing install, so no
dependency is downloaded or reinstalled and nothing is written into the checkout. To
keep the stage fully independent instead, copy `package.json` and
`package-lock.json` into it and run `npm ci --omit=dev --ignore-scripts` there.

Then start the host in that same shell. `PI_CODING_AGENT_DIR` keeps the roster and
the host's ownership record inside the stage instead of your live Pi agent
directory; `packageRoot`, `piExecutable`, `stateRoot`, `args`, and `env` are the
exported `runSessionHost` options:

```sh
PI_CODING_AGENT_DIR="$STAGE/pi-agent" STAGE="$STAGE" PI_CLI="$PI_CLI" node -e '
  const stage = process.env.STAGE;
  const { runSessionHost } = require(stage + "/dist/src/session-host/main.js");
  runSessionHost({
    packageRoot: stage,
    piExecutable: process.env.PI_CLI,
    stateRoot: stage + "/state",
    args: [],
    env: process.env,
  }).then((status) => { process.exitCode = status; });
'
```

What to expect, and what this does and does not prove:

- The host opens its own sidebar in this terminal with an empty roster. The New
  session form opens focused on **Workspace** with **Provider** set to **Pi** —
  that is the unchanged default, and it is the first thing worth confirming. A pane
  too short to spare a row draws no **Provider** line and skips it in the focus
  ring; make the terminal taller.
- To create a native row: press `Shift+Tab` twice (**Workspace** → **Host** →
  **Provider**), use `Up`/`Down` to reach the provider you want, press `Tab` back to
  **Workspace**, enter an existing directory, and submit. Choosing a native provider
  and then a connected **Host** line is refused in the form with nothing sent —
  `<provider> is local only; choose Local or Pi` — which is itself worth confirming.
- The provider CLI inherits your normal `HOME`, configuration, and authentication,
  exactly as it would from your own shell. **You do not have to log in, select a
  model, or send a prompt to complete the tryout.** Opening the row, watching the
  provider's own startup, and exiting it with the provider's own quit control is a
  complete observation, and it is the recommended first run. If you *do* choose to
  interact, the CLI may write its own ordinary new state into its own state
  directory; the host neither copies nor migrates anything.
- If you did interact, then observe in this order: switch rows and come back and the
  session keeps its own frame and continues; answer a prompt while only its own pane
  receives the keystrokes; resize the terminal and both panes reflow; exit the provider
  and confirm the row settles on its own exit event; then quit the host and confirm it
  asks about any live child and leaves your live configuration untouched.
- **No automated approvals.** Never try a provider's permission-bypass or
  approval-disabling flag to make a tryout easier; a configured target that names
  one is refused by design, and that refusal is the behavior under test.
- Restarting the host in the same stage shows a remembered native row as
  `<Provider> (unavailable)`, and the next New session asks you to choose the target
  again: a native target's id, executable, arguments, and environment are not
  persisted.
- This stage proves startup, row ownership, input routing, resize, and exit on your
  machine. It does not certify the provider's own rendering, mouse, image, resume,
  approval, or platform behavior, and it is not Windows runtime evidence.

This page documents the procedure only: it claims no completed run of it, and the
observations it lists are what to check, not reported results.

To clean up, quit the host, then remove the stage: `rm -rf "$STAGE"`. Because
`PI_CODING_AGENT_DIR` names the stage, the host's own first-run files — its roster and
ownership record, and the ordinary zero-model review-gate default it creates when none
exists — are written inside the stage and never in your live Pi agent directory. If you
did interact with a real provider, its own state directory holds whatever you chose to
create.

## Later MCP and review integration responsibilities

Native rows never carry this project's review gate, tool protection, or
MCP-exposed integration tools today, and are never presented as review-gate-managed
workers. Later work maps onto existing owning layers instead of inventing new
requirements:

| Responsibility | Owner |
| --- | --- |
| Process spawn, resize, signal, and settlement; PTY frames; focus; workspace ownership | The session host and its provider launch path |
| Approvals, sandbox decisions, question UI | The provider, in-pane and native; the sidebar may only display an observed waiting state |
| Agent status, pending input, task and shell counts | The provider's own API or hook surface — per provider, optional, and honestly unknown where absent |
| This project's tools exposed *to* Claude Code or Codex (`SessionSpawn`, later defined tools) | The owning MCP integration layer, keeping tool authorization, session/workspace/process ownership, and originating-session routing; it grants no extra execution or review authority and is not required to host a session |
| Provider-to-sidebar lifecycle and status | Not today. Exposing a tool does not by itself establish anything about a provider session's lifecycle, activity, input, or control: the sidebar needs a reliable native observation, not merely an available call |
| Review gate and tool protection | Out of scope for hosted provider sessions |

## Open questions

- Whether the Claude Code external status read is available and correct for a
  session started inside a PTY host, given the documented rule that an interactive
  session is not listed until backgrounded, and what it reports where agent view is
  unavailable or disabled by policy.
- Whether any second-client status observation of a Codex TUI-owned thread is
  possible at all before app-server matures.
- Whether a Codex interactive session surfaces background terminals in any way a
  host could count, and what its default interrupt binding actually is.
- Whether interactive shutdown and settlement match the documented non-interactive
  contract for either provider.
- Which of these deserve a sidebar control surface rather than staying in-pane
  native, and what the operator is told when a row is permanently unknown.

None of these blocks the hosting that shipped; each bounds what may be claimed
about it.

## Sources

Provider documentation reviewed on 2026-11-12; the pages above link inline to the
specific claim they support.

- Claude Code: [CLI reference](https://code.claude.com/docs/en/cli-reference),
  [Settings](https://code.claude.com/docs/en/settings),
  [Environment variables](https://code.claude.com/docs/en/env-vars),
  [Authentication](https://code.claude.com/docs/en/authentication),
  [Permissions](https://code.claude.com/docs/en/permissions),
  [Tools reference](https://code.claude.com/docs/en/tools-reference),
  [Interactive mode](https://code.claude.com/docs/en/interactive-mode),
  [Manage sessions](https://code.claude.com/docs/en/sessions),
  [Hooks reference](https://code.claude.com/docs/en/hooks),
  [Agent view](https://code.claude.com/docs/en/agent-view).
- Codex CLI: [CLI reference](https://learn.chatgpt.com/docs/cli/reference),
  [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic),
  [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security),
  [App server](https://learn.chatgpt.com/docs/app-server),
  [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
  [Hooks](https://learn.chatgpt.com/docs/hooks).
- Published package versions at review time:
  [`@anthropic-ai/claude-code`](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)
  2.1.322 and [`@openai/codex`](https://registry.npmjs.org/@openai/codex/latest)
  0.167.2.
