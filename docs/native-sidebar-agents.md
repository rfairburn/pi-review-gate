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

What a hosted row can honestly say about its own provider — busy or at rest, the
current tool type, an observed question request, that provider harness's own
background counts — is observed through the provider's own documented surfaces
where those surfaces support it, and is stated as `unknown` or `N/A` where they do
not ([Native status observation](#native-status-observation)).

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
- Provider selection is the New-session form's **Provider** line, and it
  **defaults to Pi every time the form opens**; choosing a native provider is
  explicit. The offered choices belong to the destination on the **Host** line: this
  host's own targets when it names **Local**, and only a connected owner's advertised
  targets when it names that owner. Choosing a native provider is
  explicit. The **Workspace** field and its initial focus behave exactly as before:
  the form still opens on **Workspace**. The lines above it are drawn in the order
  **Host**, then **Provider**, then the field, and the keyboard ring follows that
  drawn order: `Shift+Tab` once from **Workspace** reaches **Provider** (or **Host**
  when no Provider line is drawn), `Shift+Tab` again reaches **Host**, `Tab` from
  **Host** steps to **Provider** and then back to **Workspace**, `Up`/`Down` cycle
  the displayed choice on the focused line, and `Enter` still submits. With the mouse,
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
- Choosing a native provider for a connected destination needs that owner to advertise
  native targets and to hold the native owner-create provider. If it does, the form offers
  only its own catalog and one request starts the row there; if it does not, no Provider
  line is drawn for that destination and the choice is never carried across destinations or
  quietly turned into Pi. Starting a native row on a paired owner over a real network is
  still unproven provider acceptance; the shipped scope is the transport and the form, and
  no physical-terminal or Windows result is claimed for it. The product description is
  [Remote native create and host row name](session-host-alpha.md#remote-native-create-and-host-row-name).
- The native **Workspace** field accepts exactly the spellings the Pi workspace field
  already accepts, because both go through the host's one existing resolver: a bare
  `~` or a `~/…` path is the host's own home directory, a relative spelling resolves
  against the process working directory the host was started in, and an absolute
  spelling is used as given. Whatever the spelling, the row and the child are anchored
  at the single canonical real directory, and a path that is missing or is not a
  directory is refused before anything spawns. No shell is involved, so a `~otheruser`
  form and a `$VAR` form are not expanded here for either backend — that expansion
  stays the invoking shell's job.
- An existing native row can be **named** with the same `E` the host already has. What
  it edits is a host-side caption of this host's own row, stored with the row's
  remembered slot so the row comes back under the same name; it is never sent to the
  child or the provider, never becomes provider conversation identity, and never
  touches the authenticated Pi rename path. A name must be one trimmed line of at most
  80 characters with no control characters; anything else is refused with the row and
  the draft left exactly as they were. A remembered placeholder is not a live row to
  caption: its footer advertises no naming affordance, and `E` there refuses truthfully.
  Naming is honest about durability. When this host's roster publication for that
  operation did not take — the store is unreadable, the remembered sequence overflowed,
  or an earlier write failed — the live row is still captioned, and the host says so:
  the name applies to this session only and will not return after a restart. It never
  reuses an earlier one-time roster warning as if it described this naming.
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
  backend, a platform other than macOS, Linux, or Windows, or a `cmd.exe` it
  cannot resolve as trusted.
  **No caller-provided shell command string is ever accepted:**
  the operator supplies an executable and argv, never a complete shell command
  line. Windows batch execution does necessarily go through `cmd.exe`, so one
  command string exists on that path — the host generates it from the resolved
  executable plus the exact argv it would otherwise have spawned, and that
  host-generated string is the only command text `cmd.exe` is ever handed. What a
  real `cmd.exe` delivers from it is no longer an open design question: the
  dedicated Windows acceptance cases observed it on real Windows runners at both
  current Node pins, and the boundary of that observation is stated in
  [Evidence basis](#evidence-basis).
- **On Windows a `.cmd`/`.bat` shim is launched as one batch command line, and a
  direct executable never goes through `cmd.exe`.** The batch child is the trusted
  `SystemRoot\System32\cmd.exe` resolved from the **parent** environment, invoked
  as `/d /s /v:off /c "<quoted command text>"`. The pinned PTY spawn has exactly
  two public forms — an argv array it escapes itself per the MSDN command-line
  rules, or one pre-escaped command-line string appended verbatim after the
  program path — and the batch invocation travels **only** in the string form,
  with argv left empty: cmd.exe does not treat a backslash as an escape, so the
  same invocation passed as argv would reach it as `\"` and re-tokenize the line
  against the operator's own arguments. `/v:off` names delayed expansion off
  explicitly, because a machine can turn it on for every `cmd.exe` through its
  Command Processor settings, and then a `!name!` in the operator's own argument
  would expand while the shim forwards `%*`; naming the switch keeps literal
  bangs literal here instead of depending on whose machine this is. A literal `%`
  cannot be *typed* into a `cmd.exe /c` line at all: cmd expands `%NAME%` while it
  **reads** the line, before quoting and tokenization, and neither quoting nor a
  caret suppresses that. Each percent in the batch text is therefore delivered as
  one expansion of an internal carrier variable whose value is exactly `%`, under
  a name already checked free in the environment the child starts with so an
  existing operator variable is never overwritten, and the same line clears that
  carrier with a leading `set "NAME=" &` before the shim runs — and so before the
  CLI process inherits the environment. Percent expansion is a single pass per
  line, which is what makes the quoted text identical to what the shared quoting
  produces for an argument whose percent cmd left alone; that single-pass behavior
  on a real Windows host is what the acceptance cases below observed on both
  current Node pins, with the boundary of that observation stated there. No
  argument is refused, expanded, or reclassified to make the batch path work, and
  the shipped launcher's own Pi batch path keeps its previous `/d /s /c` invocation
  unchanged.
  A resolved executable that is not a `.cmd` or `.bat` shim — a direct `.exe`,
  including one configured with a `node wrapper.js` argument prefix — keeps its
  argv array, carries no command line, and the owned PTY handle **is** the CLI
  process, with no batch wrapper between them. POSIX launches are unchanged.
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
- **Codex adds exactly one argument of its own, `--no-daemon`**, so the launched child
  owns its backend instead of joining or starting the shared background server. An
  older Codex build that rejects it fails rather than being launched onto the
  shared daemon. `--no-alt-screen` is not added, and no approval flag is added.
  Claude Code adds no arguments of its own. The only thing ever added on top of
  these is the separately documented per-launch status-observer setup, which
  changes nothing the operator configured
  ([Native status observation](#native-status-observation)).
- **The CLI's own configuration and authentication are preserved.** The child
  inherits `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and provider
  authentication as-is, and nothing is written into the operator's stored Claude or
  Codex settings, hooks, plugins, or trust stores. The status observer reaches the
  provider only through per-session flags — a private temporary file this host
  creates, owns, and cleans up for that one launch, or one added per-session
  configuration entry — and never by editing anything the operator owns
  ([Native status observation](#native-status-observation)). The deliberate
  additions to a child environment are `HERDR_ENV=1` on a Codex child only, for
  terminal text copy, plus — when status observation is armed for a
  launch — the one provider hook-bootstrap marker described in
  [Native status observation](#native-status-observation). Both are child-only
  ([Launch and ownership rules](#launch-and-ownership-rules)). This is deliberately
  *not* a blanket ban on settings, plugin, or MCP arguments: choosing a settings
  file, an MCP configuration, a plugin directory, or an agent definition is the
  operator configuring the very target they selected, and those arguments are
  forwarded untouched. Only the narrow categories listed above are refused, and they are
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
- **A hosted row can report its own foreground status, within stated limits.**
  Where the provider's own documented hook surface states a fact this host can
  read, the row's card shows it: the agent working or at rest, the current or last
  **tool type**, an observed pending **question request**, and — on a Claude Code
  row — that provider harness's own background task and shell counts taken from a
  root `Stop` snapshot. A category this route cannot report at all reads `N/A`; a
  category that is reportable but was not positively observed reads `unknown`; a
  `0` appears only when the provider positively reported an empty set. None of it
  is scraped from the terminal, none of it is this host's own subtask or
  background-shell registry, and none of it weakens a stop confirmation
  ([Native status observation](#native-status-observation)).
- Native rows are created by this host, and — over the paired owner lanes — by a
  connected owner that advertises native targets. `SessionSpawn`, the Saved picker,
  and the standalone launchers all keep creating Pi sessions and behave exactly as
  before. A native row has no Pi status registration, so Pi's input framing and its
  per-registration encoder do not apply to it. Instead, when both sides negotiated
  the optional `native-input-cli-v1` capability, an authorized and consented viewer's
  keys, canonical mouse packets, and whole pastes are handed to that row's PTY raw,
  exactly as the owner's own Main types them, under a source-token domain separate
  from both Pi families and the same per-viewer Remote input/copy setting. That is
  terminal-process control only: it is never a claim about provider conversation
  state and no provider-tool behavior is claimed for a native row. Copying text
  **out** of such a row is a separate, closed mechanism of its own —
  [Copying text out of a hosted row](#copying-text-out-of-a-hosted-row) — not part of
  the input lane.
- A remembered native row keeps its own backend and workspace and **always** comes
  back as a truthful **unavailable placeholder** titled `<name> (unavailable)`, where
  `<name>` is the caption the operator gave the row or, if it was never named, its
  provider label:
  a remembered native row is never restarted automatically by a host restart, so
  there is no conditional auto-restart to wait for. The row states
  `<Provider> sessions are not restored; open New to start one`. It is never
  restarted as a Pi row, never adopted into a live provider process, and never
  bound to an arbitrary recent provider conversation; starting one again is always the
  operator's own New submission.

## Evidence basis

Each claim below carries one of five labels:

- **Documented** — the provider's own official documentation, reviewed as source
  only against the versions below: on 2026-11-12, with the pages behind the Claude
  Code mods, hooks, tools-reference, and agent-view statements and the Codex hooks
  and slash-command statements rechecked on 2026-11-13.
- **Probed** — an installed-binary check on a macOS development machine that ran
  version and help output only.
- **Implemented, exercised with synthetic children** — host code covered by real
  PTY tests whose child processes are purpose-built Node programs, not provider
  CLIs.
- **Wired into native CI, completed on a real Windows host** — a test tier that
  drives the production path on a real host platform and fails rather than skips
  when a prerequisite is missing. Its scenario assertions passed on real Windows
  runners at both current Node pins *and* its test command terminated normally on
  its own, so a completed run of that tier exists on that host. It pins the
  acceptance contract and reports those observations and nothing more.
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
- Hosted **text copy out** is covered by focused synthetic tiers only:
  `tests/session-host-native-cli-copy.test.ts` (the closed OSC 52 text parser, the
  opt-in surface sink against a surface that never opted in, the
  last-actual-accepted-input recipient, the acceptance-time freeze, and every
  no-fallback refusal), `tests/session-host-native-cli-content-lane.test.ts` and
  `tests/session-host-network-session-content-integration.test.ts` (the
  `native-copy-cli-v1` negotiation, the tuple-less wire family inline and paged, and
  a peer that negotiated hosted input but not provider copy receiving no copy frame
  at all), and `tests/session-host-native-cli-launch.test.ts` (the one Codex child
  marker and what it never mutates). Every child there is a synthetic PTY program
  writing synthetic terminal bytes: no real provider binary, real OS clipboard read
  or write, provider configuration, credential, conversation, physical terminal, or
  two-machine copy takes part, so a passing case proves the owner-side contract and
  never that some desktop clipboard changed
  ([Copying text out of a hosted row](#copying-text-out-of-a-hosted-row)).
- An optional real Codex startup case was deliberately skipped: that it would
  cause zero side effects on the operator's OS keychain or startup network
  behavior could not be proven, and evidence gathering must not spend the
  operator's real credentials or keychain.
- **Native status observation is source-derived and exercised with synthetic
  children only.** The hook relay, its closed wire family, the per-launch hook
  preparation, the Claude foreground/count reducers, the owned-transcript tail
  reader, the Codex foreground reducer, the shared applicability contract, the
  card rendering of `N/A` / a real zero / `unknown`, and the paired-owner
  declaration lane are each covered by named suites —
  `tests/session-host-native-hook.test.ts`,
  `tests/session-host-native-hook-launch-prep.test.ts`,
  `tests/session-host-native-claude-status.test.ts`,
  `tests/session-host-native-claude-acquisition.test.ts`,
  `tests/session-host-native-jsonl-tail.test.ts`,
  `tests/session-host-native-codex-status.test.ts`,
  `tests/session-host-native-status.test.ts`,
  `tests/session-host-native-status-sidebar.test.ts`, and
  `tests/session-host-native-status-roster.test.ts`. Every child there is a
  purpose-built fixture: the hook payloads, rollout records, and persisted
  turn-end summaries are synthesized from the reviewed provider shapes, never
  captured from a running provider. So a passing case proves the host's own
  interpretation of those shapes and every refusal rule around them; it is not
  runtime acceptance on a real provider, and **no real Claude Code or Codex
  session has been observed through this status path on any platform**.
- Still unverified on every platform: a real provider interactive TUI in a
  physical terminal — rendering, model and auth round trips, mouse, images,
  in-pane resume, approval prompts, and platform-specific behavior. That gap
  belongs to the provider, not to a platform: it stands on macOS, Linux, and
  Windows alike, and it is not a reason to treat any of the three as excluded.
- **Windows is inside this feature's supported-platform scope, and its native
  acceptance coverage is wired and enforced.** Seven real-ConPTY cases in
  `tests/session-host-native-cli-windows-pty.test.ts` wire the same production pair
  the POSIX tier uses — `createNativeCliLauncher` feeding the session manager's
  `nativeCliLaunch` provider, spawned by the manager's **default** pinned
  `@lydell/node-pty` factory — with no injected platform, fake spawn, or second
  resolver, and they take the host as they find it: on a Windows host a missing
  pinned addon, a missing `SystemRoot`, or a missing `System32\cmd.exe` is a
  **failure**, never a skip. From each real child's own terminal self-report they
  observe: the built-in Claude and Codex `PATH`/`PATHEXT` `.cmd` shims with exact
  argv, cwd (spaces included), environment, TTY state, geometry, and the `cmd.exe`
  wrapper pid kept distinct from the CLI process the shim started; a configured
  `.cmd` and `.bat` target's shared arguments and shared environment through real
  `cmd.exe` delivery; an operator argument that *spells* a `cmd.exe` variable
  reference — a defined name and an undefined one, `%1 %~dp0 %* %ERRORLEVEL%`, the
  `!name!` forms `/v:off` exists for, a `&` sharing a token with a percent,
  embedded quotes, a spaced path ending in a backslash, and an empty option
  operand — arriving as the operator's literal text, with no internal carrier
  variable surviving into the child's environment and that `&` never becoming a
  command; a direct `.exe` with a `node wrapper.js` prefix staying off `cmd.exe`
  with the prefix in front; exactly one `--no-daemon` in real option position for
  Codex and no injected flag for Claude in those cases, as the child reports them;
  addressed input, a prompt answer, and an addressed resize reaching only the owning
  row's child while a sibling row shares nothing; and a deliberate fixture exit plus a
  confirmed owned Stop settling with Windows lifecycle semantics — no POSIX signal
  requested by the host, which says nothing about the `SIGHUP` Node itself emits
  when a Windows console closes — the full grace window, the pinned forced kill,
  and settlement proven for the CLI process the shim started rather than only for
  the wrapper the manager owns. Three cross-platform cases in
  `tests/session-host-native-cli-windows-delivery.test.ts` pin the wiring that makes
  that delivery possible at all: the batch child's
  pre-escaped command line is what the pinned public spawn receives in place of an
  argv array, one row's command line travels from the launch provider to the PTY
  factory verbatim, and an unusable command line is refused before any child
  exists. Both existing native Windows CI jobs — **Windows launcher (Node 22)**
  and **Windows shell (Node 24)** — run those two files as their own step, so
  publication is gated on them.
- **Those cases have completed on real Windows runners at the Node pins then in
  force.** In one real-Windows CI run, both existing native Windows jobs —
  **Windows launcher (Node 22)** and **Windows shell (Node 24)**, on that run's
  22.23.4 and 24.22.1 pins — ran those two files as their own step and each
  ended with 12 tests passed, 0 failed, 0 skipped, its test command terminating
  normally on its own in about 69 seconds. Those 12 are the seven real-ConPTY
  cases, the two observation controls beside them in the same file — which pin
  that the file's own handle shadowing touches only `kill`, and that an
  observation it cannot
  install is reported as a fault instead of throwing before a handle is owned —
  and the three cross-platform delivery cases. The scenarios reported their
  assertions passing: `cmd.exe` delivered the composed command line into the
  child's own argv, a percent carrier expanded once and was gone before the CLI
  process inherited the environment, the bang literals stayed literal, and the
  Windows stop ladder settled the CLI process the shim started rather than only
  the wrapper the manager owns. All thirteen raw owned handles exited and each
  stayed bound to the row that owned it. The owned-ConPTY reader settlement the
  shipped default PTY factory now requires — capture the pinned addon's own reader
  for the handle it created, release it through the addon's own drain after that
  handle's genuine exit, and confirm settlement — was observed there rather than
  assumed: each fixture's manager disposal reported every owned reader confirmed,
  and the final resource counts of those runs showed no live `MessagePort`. Normal
  termination counts as part of the required result because an earlier run of
  these cases on these same jobs had its assertions passing and then had to be
  cancelled when its test commands did not end on their own. That closes the
  completed-run boundary for this tier and nothing past it: the children are
  synthetic Node programs behind synthetic batch shims, so what this establishes is
  real-host process facts about them, and the next bullet states what it never
  touches. It is the result of the two native Windows jobs, not a full-suite or
  whole-CI result. The per-line Node security floors have since risen to 22.23.5
  and 24.22.3, so this tier's run on the raised pins is still pending.
- What those cases still do not touch on Windows: a real provider binary's own
  startup, auth, model, question, approval, and resume behavior — every child
  there is a synthetic Node program behind a synthetic batch shim, and no provider
  configuration, credential, or conversation is read or written — physical-terminal
  behavior, and the paired-owner network path, which those local rows do not
  exercise. The generic session-host Windows limitations — physical wheel and
  pane-confined selection, and the rest of the remaining scope listed there —
  stay owned by
  [Session host](session-host-alpha.md#known-limitation-windows-runtime-acceptance)
  and are not resolved here.
- Provider documentation also moves quickly — Codex's documentation host has
  already moved once — so treat version-specific detail as a dated snapshot, and
  read [Sources](#sources) as the boundary of what was reviewed. **Nothing marked
  Documented below has been observed running.**

## What the host owns, and what it never infers

- **Supported:** process spawn, addressed keyboard input, resize, the owned stop
  ladder, and the child's exit. These are host-owned process facts.
- **Observed where this host armed a provider-side observer, and only for the
  categories that observer declares it can report:** the agent's working/rest
  state, the current or last tool **type**, and — on a Claude Code row — an
  observed pending question request and that provider harness's own background
  task and shell counts. Everything else on such a row stays unknown. See
  [Native status observation](#native-status-observation) for what each provider
  can actually state, and for the three answers a field can hold.
- **Unknown, always, whatever the observer reports:** a pending native
  **approval**, and this host's own conservative ownership pair
  (`backgroundTasks` / `backgroundShells`) that gates an idle-only stop or
  removal. A provider's own task and shell numbers are activity facts about that
  provider's harness; they never enter the ownership channel, so no provider
  reading — including an `N/A` or a displayed rest — ever authorizes stopping a
  row that would otherwise require confirmation.
  `Unknown` records that this host observed nothing usable for the field — not
  that the provider has nothing to report. The capability tables below say what
  each provider documents, and where a genuine gap remains.
- The host **never scrapes the terminal** to guess a provider's state, and never
  infers idle from a missing PID, a quiet period, or an output gap. A row's exit
  event is the only settlement witness.
- Stop is an **explicit, confirmed owned stop**: an idle-only stop or removal of a
  native row always requires confirmation, exactly as an unobserved Pi row does.
  A displayed rest on a native card is a foreground display fact about the
  provider's own turn, never the complete-idle proof the stop gate reads; that
  gate keeps requiring this host's own ownership counts to be positively observed
  zeros, which a hosted provider child never reports.
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
| Native tasks and subagents | Documented in-client and in-process; **Unknown** as an external read | [`--agents` definitions and the `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted` hook events](https://code.claude.com/docs/en/hooks) report transitions. Inside a running session a [mod](https://code.claude.com/docs/en/plugins/mods/reference) can take a live census: `$.agent.list()` "returns this session's subagents and teammates, each with a status of `pending`, `running`, `waiting`, `idle`, `completed`, `failed`, or `killed`", where `waiting` and `idle` need Claude Code v2.1.289 or later. [Agent view](https://code.claude.com/docs/en/agent-view) documents that those subagents and teammates are **not** listed as separate rows there, and no read from outside the running provider process is documented |
| Background shells | Documented in-client; **Unknown** as an external read | [`Ctrl+B`](https://code.claude.com/docs/en/interactive-mode) moves a running Bash command to the background (tmux users press twice); `!` shell mode runs a command directly; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` turns backgrounding off. A tool hook can see a `Bash` call with `run_in_background: true`, but the running set is listed only in-client with `/tasks`, no completion event is documented, no per-change notification is documented, and no external per-session shell count is documented ([Tools reference](https://code.claude.com/docs/en/tools-reference#background-commands), [PreToolUse input](https://code.claude.com/docs/en/hooks#pretooluse-input)) |
| External current-state read | Documented; **unverified** for a row this host starts | [`claude agents --json [--all]`](https://code.claude.com/docs/en/agent-view) is documented as the way to read session state from outside Claude Code — "every live session, plus background sessions that are still working or blocked even when their process has exited" — where entries carry `cwd`, `kind`, and `startedAt`, and a live entry carries `pid`, `status` (`busy`, `waiting`, `idle`) and, while waiting, `waitingFor` naming the cause (permission prompt, question or MCP input request, sandbox request, open dialog). The same page's agent-view list also says an interactive session open in another terminal does not appear until it is backgrounded, and the documented `state` values cover background sessions, so whether a session this host started in its own PTY is listed at all is **unverified** — not documented as impossible |
| Hooks | Documented; **session-scoped observer hooks are armed per launch** | A large [lifecycle event set](https://code.claude.com/docs/en/hooks) (session, prompt, tool, permission, subagent, task, model switch, compaction, session end) with command, HTTP, MCP-tool, prompt, and subagent handlers, restrictable by managed settings. This host arms a read-only subset of those hooks **for one launch of one row**, through that provider's own per-session configuration channel, and it installs nothing into the operator's settings, plugins, or trust store ([Native status observation](#native-status-observation)) |
| Mods (in-process observers) | Documented; **not installed or integrated by this host** | [A mod runs inside Claude Code](https://code.claude.com/docs/en/plugins/mods/reference) and follows its own conversation through [events](https://code.claude.com/docs/en/plugins/mods/events) including `turn.start`, `turn.step`, and `turn.complete`, with API namespaces such as `$.agent.list()`, `$.session` (`id`, `cwd`, `model`, `version`, …), and `$.env.get` / `set`. Running in the provider's own process, it needs no second client, which makes it the closest documented native-UI-preserving bridge; `--plugin-dir` and `--settings` are documented as applying to one session only. This project installs no mod and claims nothing about what any operator's own mod reports; the only thing it ever passes through `--plugin-dir` is a throwaway hooks-only plugin for one launch, with no JavaScript mod, MCP server, tool, command, or skill in it |
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
| Native tasks and subagents | Documented in-client; **Unknown** as an external read | [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): `agents.enabled` defaults to `true`, built-ins are `default`, `worker`, and `explorer`, and custom agents are TOML files under `~/.codex/agents/` or project `.codex/agents/`; `SubagentStart` and `SubagentStop` [hook events](https://learn.chatgpt.com/docs/hooks) exist. No programmatic current-state census for an ordinary hosted TUI session was established by this source review |
| Background shells | Documented in-client; **Unknown** as an external read | [`/ps` lists the session's background terminals with each one's command and up to three recent non-empty output lines, and `/stop` (alias `/clean`) stops them](https://learn.chatgpt.com/docs/cli/slash-commands); that list is populated when `unified_exec` is in use, otherwise it may be empty. A unified-exec `exec_command` matches as Bash and "a later `write_stdin` poll can deliver the original command's `PostToolUse` when that command finishes" ([hooks](https://learn.chatgpt.com/docs/hooks)), so settlement is observable only when something polls; no external per-session shell count is documented. Separately, app-server `thread/backgroundTerminals/list`, `/terminate`, and `/clean` are experimental and require the `experimentalApi` capability; `thread/shellCommand` runs outside the sandbox with full access and is never used |
| External current-state read | Documented for an app-server client; **Unknown** for a TUI-owned session | [`thread/read` and `thread/list` report runtime status, and `thread/status/changed` notifies with e.g. `status.type: "active"` and `activeFlags: ["waitingOnApproval"]`](https://learn.chatgpt.com/docs/app-server). Whether a second app-server client can observe a thread owned by a hosted TUI is unverified |
| Hooks | Documented; **one session-scoped observer hook is armed per launch** | [Lifecycle events](https://learn.chatgpt.com/docs/hooks) covering session start and end, prompt submit, tool pre and post, permission request, subagent start and stop, compaction, model request, stop, and interrupt. Hooks belong to the CLI itself, so they apply to a `--no-daemon` interactive row with no app-server connection — real transition signals, and still no current-state census; non-managed hooks must be reviewed and trusted by hash before running (`/hooks`). This host adds at most one per-launch `hooks.SessionStart` entry and only where it conflicts with nothing the operator wrote; it writes no hook file, no `hooks.state` trust record, and no bypass, and the provider's own review-and-trust step stays in front of it ([Native status observation](#native-status-observation)) |
| app-server | Documented, experimental | JSON-RPC over stdio by default; the WebSocket transport is documented as experimental and unsupported, and status-reading methods can be gated behind the `experimentalApi` capability |

## Native status observation

A hosted row can say more than "I own this process". This section states exactly
what this host observes, how it reaches the host, and what each answer means.
Everything here is a source-derived contract implemented in this repository and
exercised with synthetic fixtures; **no real provider runtime has been driven
through it** ([Evidence basis](#evidence-basis)).

**One shared surface, three honest answers.** The same shared sidebar components
draw a native row locally and a native row the operator sees through a paired
owner: the agent state, the current or last tool **type**, and — on a Claude Code
row — the existing `Working` / `Ready` activity wording, plus a
pending-**question-request** indication where the source actually observed one —
never an invented counter of something else. Every
observed category has exactly three possible answers:

- a **real observation** — and a `0` only when the source positively reported an
  empty set for that category;
- **`unknown`** — a category this route supports whose value failed, was
  unverified, was never observed, or was withdrawn after a gap;
- **`N/A`** — only a category this route positively declares it cannot report.

`N/A` and `unknown` are different facts and are painted differently; neither is
ever rendered as a zero or as rest. **Absence of any declaration stays legacy
unknown**: a Pi row, and a native row whose observer never declared anything,
render exactly as they did before this existed. A value submitted for a category
the row declared unreportable is not a value — the declaration wins, and that one
category stays unknown while the rest of the observation still lands.

**Native harness jobs are not this host's jobs.** A provider's own subtasks and
background shells are that provider's harness work. They are never this host's
subtask registry or its background-shell registry, and a provider number never
enters the conservative `backgroundTasks` / `backgroundShells` ownership channel
that gates a stop. An `N/A` never becomes a zero, and a displayed `Ready` never
becomes idle-only stop authority: the stop and remove gate keeps requiring this
host's own ownership counts to be positively observed zeros, which a hosted
provider child never reports. A displayed foreground rest is a display fact about
the provider's turn, not complete idle proof.

**How an observation reaches the host (both providers).** The provider's own
command hook runs a short-lived bounded relay: it connects to the **existing**
authenticated local status broker, authenticates with a token issued for that one
owned launch, sends exactly one bounded event — or one closed failure reason —
reads one fixed-size acknowledgement, and closes. That native family owns its own
registration keys, lifetime, and bounds; it never becomes a Pi reporter, never
mints or impersonates a Pi bootstrap, broker namespace, or native conversation
tuple, and it carries no Pi command authority. Each observation is bound to one
exact row and one exact child-process incarnation. A retired capture generation
can write nothing further; recoverable source gaps withdraw observations to unknown
under the source's own stale-read fences.

The observer is armed **per launch**. A fresh child-only
`PI_REVIEW_GATE_NATIVE_HOOK_BOOTSTRAP` environment entry carries that launch's
bootstrap, so no token ever appears in provider hook command text — which is also
what lets one host's generated hook command stay byte-identical from row to row.
Only selected event metadata and one validated native count projection cross the
wire: no question text, answers, prompt text, tool arguments, tool results,
transcript lines, or terminal output are relayed, logged, or broadcast. Separately,
the owner **does** read bounded bytes from the exact provider-named JSONL file:
Claude's native transcript or Codex's root-thread rollout. It parses status metadata
without keeping a transcript history or logging or broadcasting record text;
this is not a claim that no transcript is read.
There is no `HOME` or history scan, no session-directory search, no global
clipboard watch, no raw recording, no extra service or port, and no replacement
conversation.

**There is no liveness proof.** If the provider never runs the hook, or the relay
never reaches the broker, nothing is reported to the row: no heartbeat, no queue,
no retry, no replay. Supported fields stay unknown until observed and return to
unknown when a gap is detected. A category already declared unreportable keeps
showing N/A; without any declaration, the row keeps legacy unknown behavior.
No promise is made that every missed hook is detected.

**Claude Code: what this route states.** The armed event set is `SessionStart`,
`SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`, `StopFailure`, `SubagentStart`, and `SubagentStop`.

- A question is a **request lifecycle**: a `PreToolUse` for the question tool
  opens a request and a matching `Post*` closes it. `Pre` means a question was
  *requested* — it is not proof that a human-visible dialog was painted or that
  anything was answered. `input pending` reflects open observed requests; a
  definitive "none remain" is claimed only for a scope a genuine root
  `SessionStart` observed from its beginning.
- Tool activity is **type-only**: the current or last tool TYPE label, or
  `Working` / `Ready`. Arguments, results, and question content never enter state.
- A turn is **at rest** only from the positively bound, persisted **root**
  `stop_hook_summary` record, which the provider writes after every `Stop` hook
  has answered. This host's own `Stop` callback is never sufficient, because
  another operator's `Stop` hook can block and continue the same turn. An
  ambiguous, non-root, or gapped source leaves the foreground unknown.
- Task and shell counts come **only** from real **root** `Stop` snapshots of the
  documented `background_tasks` array. Present — including an empty array, which
  is a real 0/0 — is a real observed snapshot; absent is unknown; a subagent's
  snapshot is never used as root scope. Any new accepted work, task transition,
  scope change, or source gap drops the last snapshot to unknown rather than
  reconstructing membership. There is no continuous census, no process counting,
  no quiet-period inference, and no reconstructed edges.
- Every one of the five categories is declared **supported** on this route, so
  nothing here renders `N/A`; a temporarily unverifiable value is `unknown`, which
  is exactly why it is not declared unreportable.
- Arming is by that provider's own per-session channel, with the operator's own
  configuration always first: a hooks-only `--settings` file is added **only**
  when the configured arguments carry no `--settings` of their own (a second one
  would replace the operator's settings layer). When the operator already supplies
  one, the fallback is one extra session-scoped `--plugin-dir` holding a
  hooks-only plugin — a minimal manifest plus classic `hooks/hooks.json`, with no
  JavaScript mod, MCP server, tool, command, or skill in it — and every existing
  entry stays exactly as configured. Nothing is installed into global or project
  settings, no plugin is installed, no folder is auto-trusted, and no permission
  posture is overridden. The operator's normal policy — workspace trust,
  sideload-flag and marketplace policy, `disableAllHooks` — can withhold these
  hooks entirely, and this host bypasses none of it: the row simply stays unknown.

**Codex: what this route states, and what it declares it cannot.** Arming is one
`-c hooks.SessionStart=[…]` entry, and only when the operator writes no
conflicting `hooks` or `hooks.SessionStart` override in real option position —
same-layer paths are last-wins, so adding one there would replace theirs. An
existing override is preserved untouched and that row's supported categories
simply stay unknown. File-based hook layers from other sources stay additive; this
host writes no hook file, no `hooks.state` trust record, no self-trust, and no
bypass, so the provider's own review-and-trust step still runs in front of it.
The generated command is stable across rows of one host; a changed package path
or command can need the operator's approval again. Nothing here edits the
operator's trust store.

- Agent turn state and tool activity come from the **exact owned root thread's**
  durable rollout records — `task_started`, `task_complete`, `turn_aborted`, and
  persisted tool items — read together with that run's own hook metadata.
  Descendant-scoped events and nested turns never act as root authority.
- Activity is likewise **type-only**, from a closed label set — an exec, an edit, an
  MCP tool, a web search, an image view, a read, a sub-agent, or a plain tool.
  A question or permission tool contributes **no line at all**, so nothing in the
  activity row can imply pending input — while that scoped tool attempt still counts
  as processing evidence for the foreground.
- A raw hook `Stop` (or a notification) is **never** a terminal: a blocking
  `Stop` hook continues the same turn, so the durable terminal in the rollout is
  the only rest witness, and it grants rest once, for the held turn only.
- What this route cannot report it declares **unreportable**, which renders
  `N/A` — never `0`, and never a claim about the provider: a complete, ongoing
  pending-input census and a background work / shell census. Some question
  surfaces are transient and some clears are local to the provider, so this route
  cannot show their full lifecycle. A Codex row's `input`, `bg tasks`, and
  `shells` read `N/A` because of **this route's** limit — not because Codex lacks
  the feature, and not as a zero. Failures inside the categories this route does
  support (agent state, activity) go to `unknown`, not `N/A`.
- No new input-surface representation is added anywhere, and none of this is a
  universal claim that a hosted Codex row can never report those categories.
  Actual native questions and approvals stay in Codex's own UI; this route never
  stands in for them.

**What a paired viewer sees.** The owner's per-category applicability declaration
reaches an authorized viewer as derived status facts and support through the
optional `roster-native-status-v1` roster capability, negotiated separately from
native create and native rename. Observed values keep travelling in the row fields
the roster already carried. A peer that never negotiated it decodes the row shape
it always did and renders every unobserved category as `unknown`; a viewer can
never declare a category unreportable on its owner's behalf. The capability grants
nothing by itself — it is a protocol capability, not a new user-facing telemetry
switch.

**What is staged, and when it goes away.** The Claude routes stage their artifacts
in a freshly created private temporary directory this host owns (directories
`0700`, files `0600`, exclusive creation, never inside a workspace); the Codex
route stages no file at all. Cleanup removes only the exact entries that one
preparation created, and only where each is still the object it created — same device
and inode, of the expected kind, checked without following a link, under a recorded
root and ancestry that still carry the identities they were created with; an
unprovable or changed ancestor fails closed, a symlink standing where a recorded
directory was is another object so nothing below it is removed through it, and a
directory now holding an entry this preparation never created is not removed and
keeps it. Artifact cleanup does not read or digest contents, so an in-place edit of a created
file keeps its identity and goes with the rest, and nothing is swept or deleted
recursively. The lease is released only after the provider source and the row's
actual PTY have settled.

## What a sidebar row shows today

The sidebar rules apply unchanged: an unobserved field stays `unknown`, never
idle and never zero, and the child's exit is the only settlement witness
([Sidebar status and activity](session-host-alpha.md#sidebar-status-and-activity)).
Where this host armed a provider-side observer for a row, some of those fields are
now **observed**; where that observer states it cannot report a category, the
field reads `N/A`; and an observer that armed but never reached the provider, or
that lost its source, leaves the field `unknown` exactly as before. Every
`unknown` below still means this host observed nothing usable — not that the
provider documents nothing. The capability tables above say what each provider
does document, and the "Current state versus events, and freshness" paragraph
below names the gaps that survive any observer.

| Sidebar field | Claude Code row | Codex CLI row |
| --- | --- | --- |
| Lifecycle and exit code | Real: the host owns the child process | Real: the host owns the child process |
| Conversation name | Unknown: never scraped | Unknown: never scraped |
| Agent busy or idle | Observed when the observer reached its source: running from an accepted prompt or root tool work, rest only from the persisted root turn-end summary; `unknown` before any observation and after any gap or ambiguous boundary | Observed when the observer reached its source: running from durable turn start or persisted root tool activity, rest only from that thread's own durable terminal for the held turn; `unknown` before any observation and after any gap, replay ambiguity, or source failure |
| Pending input | Observed as an open **question request** where the hook lane saw one; `unknown` when nothing was observed or the census has a hole — never a guessed count | `N/A`: this route cannot show that lifecycle completely. Not a zero, and not a claim that Codex has no questions |
| Background task count | Observed only from a real root `Stop` snapshot — an empty snapshot is a real `0`; `unknown` when no snapshot is current or anything newer invalidated it | `N/A`: this route has no complete census. Not a zero, and not a claim about Codex |
| Background shell count | Observed only from the same real root `Stop` snapshot; `unknown` otherwise | `N/A`: same limit as above |
| Activity lines | Observed: the current or last tool TYPE, or `Working` / `Ready`; empty when nothing was observed or after a withdrawal | Observed: the current or last tool TYPE for the held turn; empty when nothing was observed or after a withdrawal |
| Row caption the operator can set with `E` | Yes: a host-side name of this host's row, never a provider conversation name | Yes: the same host-side caption |
| Roster title of a live row | The operator's caption, else `<Provider>` | The operator's caption, else `<Provider>` |
| Roster title of a remembered row after a host restart (always unavailable) | `<caption or Provider> (unavailable)` | `<caption or Provider> (unavailable)` |
| Idle-only stop | Confirmation required, always | Confirmation required, always |
| Provider conversation rename, saved-conversation open, exited-row resume | Unavailable: Pi APIs | Unavailable: Pi APIs |

**Card structure.** A native card is drawn with the same rows as a Pi card, by the same
shared card formatter, and a paired owner's native row is drawn by that same
formatter from the same three answers. The one-word aggregate `background unknown`
stays reserved for what it has always meant: two reportable categories with
nothing observed. Once a category is observed the row names it (`bg tasks 2 |
shells 0`), and a category the row's observer declared unreportable reads `N/A`
instead — ordinary pane text, never a zero and never painted as rest. A supported
category whose value simply went missing still reads `unknown`; it is never
relabelled `N/A`. Nothing here is ever rendered as a zero that was not observed.
That is a statement about what this host observed on this pass, not a claim that a
provider could never report such a count. The aggregate `agent` word follows the
same rule: it reads rest only when every **reportable** category is positively at
rest or zero — a supported-but-unobserved category keeps it `unknown`, while a
declared-unreportable one does not block it — so a positively observed provider turn
end can display as rest without anyone inventing background zeros to satisfy the
formatter, while the same positive rest observation on a row whose other categories
were never observed still reads `unknown`.

**Current state versus events, and freshness.** The host's status model is
event-driven with no periodic polling, and the shipped observer keeps that rule:
it reacts to that run's own hook events and to one watched transcript file, and it
starts no polling loop. The Claude Code external read is a poll, so using it at
all would be a per-provider adapter exception with its own staleness-to-unknown
transition rather than a global polling loop, and the host's event-driven
resynchronization points are not provider events. Codex's `thread/status/changed`
is a genuine event, but only for a client of that app-server connection, and
whether it describes a thread owned by a hosted TUI is unverified; neither read is
part of the shipped route. What both providers document for these fields is a
*transition* notification: `SubagentStart` and `SubagentStop` on both, plus
`TaskCreated` and `TaskCompleted` on Claude Code. A transition stream is not a
census, and the two providers are not alike here. Claude Code documents one live
census **inside a running session**: a mod's `$.agent.list()` returns that
session's subagents and teammates with their current statuses, and `turn.start` /
`turn.complete` mark the busy edges
([Mods reference](https://code.claude.com/docs/en/plugins/mods/reference),
[Mods events](https://code.claude.com/docs/en/plugins/mods/events)). It is a
read of one session by code running in that session, not an external read of a
hosted TUI, and this host installs no mod — the shipped route reads the persisted
records and hook payloads instead, and treats them the same honest way. Codex
documents no equivalent census.
The background-shell gap stands on **both** providers: neither documents any
notification that a background shell count changed inside a live interactive
session. Claude Code's `Stop` and `SubagentStop` payloads carry a
[`background_tasks`](https://code.claude.com/docs/en/hooks#stop-input) array of the
in-flight tasks known at that instant, which is a turn-end snapshot rather than a
live count, and no completion event for one shell is documented; Codex's `/ps` list
is in-client only, with a unified-exec settlement that arrives only if something
polls it. The shipped route therefore does not pretend to answer "what exists
right now" continuously: on a Claude row a count is published only as that root
`Stop` snapshot, and any newer work, structured transition, scope change, or
source gap retires it to `unknown`; on a Codex row the category is declared
unreportable and reads `N/A`. Where an observer cannot answer honestly, the field
stays `unknown` or `N/A`, never a reconstruction.

## Copying text out of a hosted row

A hosted Claude or Codex row can copy **text** out. This is its own closed
mechanism, deliberately separate from Pi's authenticated clipboard bridge: Pi's
selection producers, per-dispatch origin, capsule authentication, and provenance
fences are unchanged, raw OSC 52 stays default-denied on every surface that did not
opt into this sink, and nothing here adds clipboard **read**, paste, image or file
transfer, synchronization, a right-click change, or any new status, notice, or
count.

**What is captured.** Only that row's terminal surface opts in. What crosses is
parsed, never relayed: exactly one standard clipboard-selection field (empty is the
standard spelling of the default selection) and exactly one payload; a clipboard
**query** (`?`) is refused outright, because this host never answers one and never
sends clipboard content back toward a child; and the payload must be canonical
base64 decoding to non-empty strict UTF-8 text inside the unchanged
100,000-encoded-character producer bound (at most 75,000 decoded bytes). Binary,
empty, malformed, or over-bound payloads are refused whole — nothing is ever
truncated to fit, and no control sequence is re-emitted. Capture is bound to one row
and one child-process incarnation, and the sink is installed on no other surface.

**What the trust is, and what it is not.** Pi's route proves a native *producer* by
runtime call-stack provenance, because Pi has an audited producer to pin. A provider
CLI has no such audited producer, so the fence here is different and narrower: the
request is accepted because it appeared inside a PTY this host owns and opened for
that provider — which means a copy request written by the provider's own UI, by a
tool it ran, or by a program it started is accepted alike. Only text crosses that
fence: no query, no binary, no clipboard direction back toward the child.

**Who receives it.** The recipient is the origin of the most recent **actual
accepted** nonempty input this host forwarded to that exact child — the owner's own
local Main input, or one viewer's verified input. Never a currently selected form, a
refused or rejected request, a received copy request, or a terminal protocol
query/reply. The recipient is frozen when the owner accepts the copy, so input that
arrives afterwards never retargets a copy already in flight, and the routing is a
convention, never proof that the input caused the copy:

- viewer A types, then viewer B types, then the provider copies — **B** receives it;
- a copy accepted for A before B's input arrives stays **A**, and is **dropped**,
  not retargeted, if A is no longer eligible by the time it is delivered.

An ineligible recipient delivers nothing: a retired viewer, a viewer now
displaying another row, a viewer-revision, geometry, or backend change, a replacement
child, a released row, a channel that never negotiated the copy capability, or an
owner-local route whose own live-row, focus, actual-coverage, and geometry proof
refuses. There is no fallback to the other peer, no broadcast, no automatic retry,
no queue, and no global clipboard monitor — and a row nobody has ever typed into
copies nowhere at all. On the owner's own machine the host writes its outer-terminal
OSC 52 request only under the same display guards the Pi copy route already uses; a
hosted provider child has no Pi conversation, so no conversation tuple is compared
and none is invented: the copy names that row's recorded backend and nothing else.

**What crosses the network.** A viewer-routed copy rides that viewer's existing
authenticated, consented content lane under a new optional `native-copy-cli-v1`
capability, negotiated only beside native IO and hosted native CLI input; an
acknowledgement naming it without them is a protocol violation, and a peer that
never negotiated it gains nothing and refuses such a source outright. The frame
carries the tuple-less hosted source and an event naming the same recorded backend,
so the two producer families never mix on one frame, and the unchanged inline-or-paged
transfer preserves the whole payload. Delivery still requires this viewer's own
current written, uncovered, Main-focused frame and its **Remote input/copy** setting
to be on, and the copy is written to that viewer's own terminal — a terminal-write
submission, not proof that an OS clipboard changed.

“Optional” here refers to protocol negotiation, not a new clipboard-only setting.
The existing **Remote input/copy** switch controls both remote input and writes to
the viewer's clipboard; turning it off does not cancel the provider's own OS copy.

**What was actually read in the providers, and what was not run.** These are
source-level findings from reviewing the shipped clipboard paths, not observed
provider behavior: the reviewed Claude Code build (the 2.1.325 line) emits its
OSC 52 request alongside its own OS clipboard helper on the normal macOS, Windows,
and non-VTE Linux paths, while its Linux VTE helper-only path may emit no capturable
request at all; a Codex child carrying the marker below additionally emits one OSC
52 request while its own native OS copy continues. No extra helper wrapper and no
provider flag is needed for the common Claude path. **tmux/screen DCS-wrapped** OSC
52 capture is **not** implemented, so a provider the operator puts inside their own
multiplexer, or a provider path that talks to a clipboard helper directly, can
bypass the owned PTY emission entirely. Nothing here falls back to polling a
clipboard.

**One Codex child environment marker.** A hosted Codex child — built-in or an
explicitly configured target — is given `HERDR_ENV=1`, the one value of an
undocumented upstream branch (reviewed at the pinned `rust-v0.167.2` tag) under which
Codex writes that extra terminal copy request to its own controlling terminal, which
under this host is the row's PTY. It is applied to that one composed **child**
environment after every environment source has merged, so the host-owned mode
intentionally wins for this single key over any inherited or configured value while
every other entry keeps what the ordinary composition gave it; the host process, the
launcher options, a caller's request object, a Claude child, and a native Pi child
receive nothing. This is a narrow compatibility use, not an integration: no HERDR
code, repository, or dependency is involved, upstream owns the semantics and they can
change in a future release, and no other provider argument, permission,
authentication, or session setting is added. `SSH_TTY`, `SSH_CONNECTION`, `TMUX`,
`TMUX_PANE`, and `STY` stay exactly as inherited. Pretending to be an SSH session
would also switch off Codex's own clipboard-text read, right-click paste, and local
image links; multiplexer markers have other unrelated effects. A hosted Codex row's
own write to the owner's OS clipboard is still its
own: the host's forwarding is **additional** to the single controller it routes to,
never a guarantee that the owner's clipboard was untouched.

## Launch and ownership rules

- The child inherits the host environment as-is, which is what makes each CLI's own
  `PATH`, home, and configuration-directory resolution work with zero
  provider-side change. Two treatments apply to the clone (and to any configured
  environment overlay), and they differ on purpose. A delegated worker's runtime
  role authorization and executor tool catalog are **refused fail-closed**: the
  launch is rejected outright rather than sanitized, because quietly deleting them
  would launder a worker context into a top-level session. Stale host-only markers
  — session-host bootstrap, startup-request, title, `NODE_OPTIONS`-restore, and
  settlement/quiescence — are stripped, so a native child never inherits a
  capability it did not already own. One addition applies to a **Codex** child only:
  after the ordinary composition and overlay merge, the cloned child environment
  carries `HERDR_ENV=1` so the provider additionally emits a terminal text-copy
  request the host can capture
  ([Copying text out of a hosted row](#copying-text-out-of-a-hosted-row)). It wins
  for that one key over an inherited or configured value, and no other entry, no
  Claude or Pi child, and no multiplexer or SSH marker is touched.
- **When status observation is armed for a launch, one more child-environment entry and
  that provider's own per-launch hook flags are added — and nothing else.** The
  marker is the fresh `PI_REVIEW_GATE_NATIVE_HOOK_BOOTSTRAP` value carrying that
  launch's broker endpoint, generation, instance id, backend, and one-shot token;
  it is stripped from any inherited environment before the fresh one is set, and no
  token ever enters provider hook command text or an artifact. The added flags are
  exactly the two documented routes — a hooks-only `--settings` file when the
  configured arguments carry none, otherwise one extra session-scoped `--plugin-dir`
  holding a hooks-only plugin, or one `-c hooks.SessionStart=[…]` entry for Codex —
  and where they would conflict with the operator's own configuration they are
  skipped and the row stays unknown. Any refusal here is a **declined observer**,
  never a failed launch: the child is then composed exactly as it was before status
  observation existed. The Claude routes stage their files in a freshly created
  private temporary root this host owns (`0700` directories, `0600` files,
  exclusive creation, never inside a workspace), and cleanup removes only the exact
  entries that one preparation created, deepest first, and only where each is still
  the object it created — same device and inode, of the expected kind, checked
  without following a link, under a recorded root and ancestry that still carry the
  identities they were created with. An unprovable or changed ancestor fails closed;
  a symlink standing where a recorded directory was is another object, so nothing
  below it is removed through it; a directory now holding an entry this preparation
  never created is not removed and keeps it. Artifact cleanup does not read or digest contents, so
  an in-place edit of a created file keeps its identity and is removed with the rest.
  Nothing is swept or deleted recursively; the lease is released only after that row's
  provider source and PTY have settled. Nothing is written to global or project
  provider settings, hooks, plugin lists, no trust record is written, and no
  permission or hook-trust posture
  is overridden
  ([Native status observation](#native-status-observation)).
- The provider command, base arguments, and shared environment come from the
  operator's explicit
  [`externalAgents` catalog](configuration.md#the-externalagents-catalog) entry
  when one is selected; otherwise the built-in default command is used. The
  `execution` and `review` role overlays are **not** inherited: a top-level
  native session is not a delegated execution or review role.
- Codex adds only `--no-daemon` of its own, so the launched child owns its backend
  instead of joining or starting the shared background server; the per-launch
  status-observer flags described above are the only addition on top of it, and they
  are skipped wherever they would conflict. An older Codex build that lacks the flag
  fails with its own argument error; the flag is never silently dropped.
  `--no-alt-screen` and any headless or approval flag are not added. Claude Code
  adds no flags of its own.
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
  a native row has no Pi status registration — the status observer above is a
  separate native family, never a Pi reporter — no Pi shutdown request is attempted
  for it: the host signals the handle it owns and waits for that handle's exit.
- A native launch descriptor may carry one Windows batch command line beside its
  file, argv, environment, and workspace. The manager validates it as one printable
  non-empty string and refuses a descriptor carrying an unusable one — it is never
  silently dropped and never spawned as a bare interpreter with no command — and
  the manager's default PTY factory hands that string to the pinned public
  `@lydell/node-pty` spawn in place of argv. On Windows that factory also selects
  the ConPTY DLL bundled with the pinned package (`useConptyDll: true`) instead of
  the system ConPTY, so the shipped source path uses the same transport
  the acceptance cases do; POSIX options are unchanged. On that same Windows
  request the factory captures the addon's own output reader for the handle it
  just created, releases it through the addon's own drain and dispose path only
  after that handle reports its genuine exit, revalidates the captured ownership
  chain before invoking anything, and requires the addon's reader Worker
  settlement to be positively observed — a release it cannot confirm stays a
  cleanup failure at host disposal instead of becoming success. A native row is
  spawned by that same factory, so its reader release is required on the same
  terms as a Pi row's, and the real-Windows native acceptance cases observed that
  release end to end at both current Node pins
  ([Evidence basis](#evidence-basis)).

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
- To create a native row: press `Shift+Tab` once (**Workspace** → **Provider**),
  use `Up`/`Down` to reach the provider you want, press `Tab` back to
  **Workspace**, enter an existing directory, and submit. With a connected **Host** line the
  Provider line offers only that owner's advertised targets, or nothing at all if it
  advertises none; confirm which of the two you get before submitting.
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
- If this host armed the row's status observer, the card is the other thing worth
  watching: the agent line moves between running and rest as the provider's own
  turns start and end, the activity line names the current or last tool type, and a
  Claude row can show an observed pending question request and its root-snapshot
  background counts. A Codex row's `input`, `bg tasks`, and `shells` read `N/A` by
  design. Two honest outcomes are also correct behavior: a card whose supported fields
  stay `unknown` because the provider's own policy declined the observer's hooks, and —
  on Codex — the provider's own hook review-and-trust prompt, which this host never
  answers or bypasses for you. Nothing here proves any of that ran: this page
  reports no completed run of the tryout.
- **No automated approvals.** Never try a provider's permission-bypass or
  approval-disabling flag to make a tryout easier; a configured target that names
  one is refused by design, and that refusal is the behavior under test.
- Restarting the host in the same stage shows a remembered native row as
  `<Provider> (unavailable)`, and the next New session asks you to choose the target
  again: a native target's id, executable, arguments, and environment are not
  persisted.
- If your terminal implements OSC 52 clipboard writes, select and copy text in the
  provider the provider's own way and see whether your connecting terminal's
  clipboard changed. For a hosted Codex row this is exactly what the `HERDR_ENV=1`
  marker exists to make possible. On this host's own machine either path can produce
  that change — the provider's own native OS clipboard write, or the host's guarded
  outer-terminal OSC 52 forwarding when this host's own Main was the last input this
  row accepted — so the clipboard change alone does not tell the two apart; a
  terminal, multiplexer, or permission that declines clipboard writes simply
  discards the request, and this page claims no completed run of the check.
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
| Agent status, pending input, task and shell counts | The provider's own API or hook surface — per provider, optional, and honestly `unknown` or `N/A` where absent. The shipped hook-backed route is described in [Native status observation](#native-status-observation); anything it cannot state stays unknown or declared-unreportable rather than being inferred |
| This project's tools exposed *to* Claude Code or Codex (`SessionSpawn`, later defined tools) | The owning MCP integration layer, keeping tool authorization, session/workspace/process ownership, and originating-session routing; it grants no extra execution or review authority and is not required to host a session |
| Provider-to-sidebar lifecycle and status | Partially today, through the provider's own documented hook and persisted-record surfaces only, and only for the categories a given route can state ([Native status observation](#native-status-observation)). Exposing a tool does not by itself establish anything about a provider session's lifecycle, activity, input, or control: the sidebar needs a reliable native observation, not merely an available call, and a native observation never becomes stop or idle authority |
| Review gate and tool protection | Out of scope for hosted provider sessions |

## Open questions

- Whether the Claude Code external status read lists a session started inside a PTY
  host at all: `--json` is documented as covering "every live session", while the
  agent-view list says an interactive session open in another terminal does not
  appear until it is backgrounded — plus what it reports where agent view is
  unavailable or disabled by policy. The shipped status route does not use that
  read, so this bounds a possible future route only.
- Whether an operator-loaded Claude Code mod could be tied to one specific row for
  the life of one launch: `--plugin-dir` and `--settings` are documented as
  per-session, and no provider-side row identity is documented. The shipped route
  uses the per-session hook channels for one row's own launch and installs no mod;
  a mod-backed bridge remains a separate question.
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

Provider documentation reviewed on 2026-11-12, with the Claude Code mods, hooks,
tools-reference, and agent-view pages and the Codex hooks and slash-commands pages
rechecked on 2026-11-13; the pages above link inline to the specific claim they
support.

- Claude Code: [CLI reference](https://code.claude.com/docs/en/cli-reference),
  [Settings](https://code.claude.com/docs/en/settings),
  [Environment variables](https://code.claude.com/docs/en/env-vars),
  [Authentication](https://code.claude.com/docs/en/authentication),
  [Permissions](https://code.claude.com/docs/en/permissions),
  [Tools reference](https://code.claude.com/docs/en/tools-reference),
  [Interactive mode](https://code.claude.com/docs/en/interactive-mode),
  [Manage sessions](https://code.claude.com/docs/en/sessions),
  [Hooks reference](https://code.claude.com/docs/en/hooks),
  [Agent view](https://code.claude.com/docs/en/agent-view),
  [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference),
  [Mods events](https://code.claude.com/docs/en/plugins/mods/events).
- Codex CLI: [CLI reference](https://learn.chatgpt.com/docs/cli/reference),
  [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic),
  [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security),
  [App server](https://learn.chatgpt.com/docs/app-server),
  [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
  [Hooks](https://learn.chatgpt.com/docs/hooks),
  [Slash commands](https://learn.chatgpt.com/docs/cli/slash-commands).
- Published package versions at review time:
  [`@anthropic-ai/claude-code`](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)
  2.1.322 and [`@openai/codex`](https://registry.npmjs.org/@openai/codex/latest)
  0.167.2.
- The shipped clipboard paths behind
  [Copying text out of a hosted row](#copying-text-out-of-a-hosted-row) were read in
  a separate source review — a Claude Code 2.1.325 build and the Codex
  `rust-v0.167.2` tag (its `tui` clipboard-copy module) — and those findings are a
  code reading, not part of the dated documentation review above. Nothing in them was
  observed running, and upstream code moves independently of this host.
- The hook-payload and record shapes behind
  [Native status observation](#native-status-observation) come from the same kind of
  pinned source reading: the shipped Claude Code 2.1.325 hook envelope for the event
  names, scope fields, `tool_use_id` correlation, and the persisted root
  `stop_hook_summary` row, and the Codex `rust-v0.167.2` tag for the hook schema,
  the rollout record stream (`task_started`, `task_complete`, `turn_aborted`, and
  persisted tool items), and the `-c` / `hooks.SessionStart` configuration layer.
  Those are code readings against pinned versions, not observed provider behavior,
  and they carry the same moves-independently caveat as the clipboard findings above.
