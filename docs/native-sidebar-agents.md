# Native Claude Code and Codex sessions

Guide and reference for the session host's native hosting: real, top-level
interactive **Claude Code** and **Codex CLI** sessions started as sidebar rows
beside the Pi sessions, in the same owning sidebar, over the same owned PTY and
terminal surfaces. It is the published deliverable of
[#277](https://github.com/rfairburn/pi-review-gate/issues/277): how a native row
starts, what the host can honestly display about it, and what stays unknown.

Pi stays the default everywhere. Every New-session form still opens on Pi, a
`SessionSpawn` call without `kind` still starts Pi, every existing Pi path is
unchanged, and a native row is always an explicit choice. A hosted row is the operator's own CLI as an ordinary child: the host
owns its process, its input, its size, and its exit, and everything else is what
the provider's own surfaces state. The provider's own startup, authentication,
model behavior, in-pane approvals and resume, and physical-terminal rendering
belong to the provider and are not certified here.

What a hosted row can honestly say about its own provider — busy or at rest, the
current tool type, an observed question request, that provider harness's own
background counts — is observed through the provider's own documented surfaces,
and each field shows an observed value or `unknown`
([Native status observation](#native-status-observation)).

The [Claude Code capabilities](#claude-code-capabilities) and
[Codex CLI capabilities](#codex-cli-capabilities) tables use **Documented** for
what the provider's own official documentation states — a source review at the
pinned versions listed in [Sources](#sources), never observed running —
**Partially documented** where those pages cover only part of it, and **Unknown**
where this host has no documented surface to rely on and infers nothing. Provider
documentation moves quickly, so version-specific detail is a dated snapshot.

Cross-ownership: [Session host](session-host-alpha.md) owns the host contract,
roster, sidebar status rules, and stop ladder;
[Configuration](configuration.md#the-externalagents-catalog) owns the
external-agent catalog; [Security model](security-model.md) owns trust
boundaries; [Development](development.md) owns verification commands.

## What shipped

- One native row is **one real full native interactive session**: the operator's
  own CLI as an ordinary PTY child of the existing host, under the same ownership
  model as a Pi row — one row, one interactive child, one workspace, one frame. A
  hosted Codex row additionally owns one private backend child of its own, created for
  that row and stopped and settled with it
  ([Native status observation](#native-status-observation)). No
  new host-side detector, daemon, service, renderer, SDK client, or headless
  substitute was added: a provider's print or `exec` path drives *its own* thread,
  so running it beside a hosted TUI would be a second conversation rather than
  the same session, and it is never used that way. A hosted Codex row's backend is
  the same provider's own app-server mode started for that row and driven by that
  row's own interactive client — one conversation, not a second client with a thread
  of its own.
- Provider selection is the New-session form's **Provider** line, and it
  **defaults to Pi every time the form opens**; choosing a native provider is
  explicit. The only choices are the three session kinds **Pi**, **Claude Code**, and
  **Codex CLI** — on the terminal sidebar and in the Android application alike — and
  a native kind always means the destination's normal native setup, never a
  configured `externalAgents` worker profile. The offered choices belong to the
  destination on the **Host** line and are filtered by its current availability: the
  kinds this host's own launch probe finds startable when it names **Local**, and
  only what a connected owner's freshly probed catalog reports when it names that
  owner. An offered choice is an observation, not a grant; the destination
  revalidates it at submission. The **Workspace** field and its initial focus
  behave exactly as before:
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
  native kinds, to hold the native owner-create provider, and to describe its catalog as
  freshly probed under `roster-native-availability-v1`. If it does, the form offers
  only its own catalog and one request starts the row there; if it does not — including
  a legacy owner whose configuration-only catalog has unknown availability — no native
  choice is offered for that destination, and the choice is never carried across
  destinations or quietly turned into Pi. The product description is
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
  the draft left exactly as they were. A Codex row started by `SessionSpawn` gets its
  full supplied title as this same stored caption at startup, under the `SessionSpawn`
  title bound (1024 UTF-8 bytes) instead of the manual rule, with no trimming or
  clipping; a card or peer row label too narrow for it shows a visibly ellipsized
  display projection, never a second stored caption, and the full caption is what is
  kept and restored. A remembered placeholder is not a live row to
  caption: its footer advertises no naming affordance, and `E` there refuses truthfully.
  Naming is honest about durability. When this host's roster publication for that
  operation did not take — the store is unreadable, the remembered sequence overflowed,
  or an earlier write failed — the live row is still captioned, and the host says so:
  the name applies to this session only and will not return after a restart. It never
  reuses an earlier one-time roster warning as if it described this naming.
  Naming is also permanent in one direction: a caption you gave survives every later
  provider title change **and** every conversation reset on that row, and no provider
  title can move the row again. That includes a caption equal to the text the row was
  already showing — the host records the intent, not just the difference.
- A live native row can also be titled by **its own provider**, when this host's
  observer positively read the provider's actual conversation title. Precedence is
  fixed: **your caption, then the provider's own title, then the provider label**
  (`Claude` or `Codex`). It is the provider's own name for the conversation and never
  text this host generated, guessed, or lifted from a prompt, a summary, a first line,
  or the screen:

  - **Claude Code**: the conversation's custom title (what `/rename` or `--name` sets),
    or the title the provider generated for it. Both are read from the one transcript
    file the provider itself named for that run, and a custom title outranks a
    generated one, exactly as the provider's own session-summary fold ranks those two
    fields. A title the provider recorded **before** this host started watching that
    transcript is read too: once the run positively proves which conversation it is,
    the observer takes one metadata-only look at the transcript that run itself named
    and shows the title already recorded there, so an existing or resumed conversation
    needs no new `/rename` and no new prompt. That look reads title fields and nothing
    else — the older prompts, tool rows, turn endings, and counts in the same file stay
    un-replayed — and no poller, watcher, history catalog, or extra connection is added
    for a title. If that one look cannot be trusted (the file is unreadable or was
    replaced, a row inside its read window is corrupt, or the only title it reached was
    a generated one while the file's earlier records stayed unread, where an older
    custom title could still be waiting), the row keeps your caption or the provider
    label rather than guessing.
  - **Codex**: the thread's user-facing name (what `/rename` sets), read from the same
    private root-thread read that already corroborates the row's workspace. An unnamed
    thread is answered honestly as having no title, so the row keeps its provider
    label; Codex documents no automatic titling.

  A provider title is **ephemeral**: it is never stored with the row's remembered slot,
  never restored as a name after a restart, and never sent back to the provider — this
  host renames nothing. When the row's conversation is replaced (a `/new`, `/clear`, or
  a resume to another conversation) or the proof of which conversation the row runs is
  lost, the title goes with it instead of naming the row after a conversation it no
  longer runs. A provider title this host cannot display at all — one over 256
  characters, or carrying control characters or a line break — is refused whole and
  never clipped, and the row simply keeps what it showed. That 256-character limit is
  the bound a row's name already travels under everywhere else in this host, including
  what a peer's roster accepts; it is **not** the 80-character limit that applies to a
  caption you type, which has no claim on text the host merely displays. So a long
  provider title is shown rather than silently dropped, while your own typed caption
  keeps its shorter input rule. A title change is noticed on the paths the observer
  already has: the
  one watched Claude transcript, and the owned Codex read refreshed by the provider's own
  rename edge. There is no polling and no extra connection for a title.
- A native session — from the New form, a paired owner, `SessionSpawn`, or restart
  restoration — always uses the built-in default target for its backend: the
  `claude` or `codex` command with no host-configured arguments or environment, so
  the provider runs with its own normal configuration. A configured
  [`externalAgents`](configuration.md#the-externalagents-catalog) entry is a
  delegated review/execution worker definition, not a session choice: its adapter,
  `command`, `args`, `env`, role overlays, models, and reasoning settings are
  **never** used for a top-level native session, and they keep configuring delegated
  workers exactly as before. Each new session selects its native kind again: the
  chosen kind's executable, arguments, and environment are never persisted, so a
  later form cannot silently reuse them. The argument guards and the named-profile
  refusal described below remain part of the launcher contract.
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
  given, a bare name is searched in `PATH` order, on Windows a bare name tries
  only native `PATHEXT` suffixes (so the extensionless npm shell shim installed
  beside `codex.cmd` is never selected), and a `.cmd`/`.bat` shim runs through the trusted
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
  host-generated string is the only command text `cmd.exe` is ever handed.
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
  produces for an argument whose percent cmd left alone. No argument is refused,
  expanded, or reclassified to make the batch path work, and
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
- **A hosted Codex row's interactive client attaches to a private app-server
  backend this host started for that row**, so no host-added `--no-daemon` is
  needed on that route: the client and its backend are the same resolved target,
  and neither one joins or starts the shared background server. A Codex launch this
  host does not front with its own backend keeps `--no-daemon` as its one host-added
  argument, and an operator who configured that flag themselves keeps it either way.
  `--no-alt-screen` is never added, and no approval, sandbox, or headless flag is
  ever added. On a New-form or restored row, Claude Code adds no arguments of its own.
  The only other thing ever added is the separately documented per-launch
  status-observer setup, which changes nothing the operator configured
  ([Native status observation](#native-status-observation)), plus, for a fresh
  `SessionSpawn` child only, that request's startup tokens: Claude Code's
  `--name=<title>` in option position, and for both providers the generated
  prompt-file instruction as the single operand after a trailing `--` (see
  [Starting and owning sessions](session-host-alpha.md#starting-and-owning-sessions)).
- **A configured Codex target whose arguments choose one of the operator's named
  provider profiles is refused clearly, before any process, socket, or file is
  created.** This host does not route profile-scoped provider configuration into the
  separate backend process it owns, so forwarding the choice would leave the
  interactive client on one profile and the process that actually runs hooks and MCP
  servers on another, while dropping it would run the default profile when the
  operator asked for a named one. The refusal carries no profile name, path, or
  argument, and the built-in default target and every explicit target that names no
  profile start normally.
- **The CLI's own configuration and authentication are preserved.** The child
  inherits `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and provider
  authentication as-is, and nothing is written into the operator's stored Claude or
  Codex settings, hooks, plugins, or trust stores. The status observer reaches the
  provider only through per-session flags — a private temporary file this host
  creates, owns, and cleans up for that one launch, or one added per-session
  configuration entry — and never by editing anything the operator owns; a hosted
  Codex row needs no flag of ours at all, because its observer reads the private
  backend this host started beside that row
  ([Native status observation](#native-status-observation)). The deliberate
  additions to a child environment are `HERDR_ENV=1` on a hosted Codex interactive
  child only, for
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
- **A hosted row can report its own foreground status.**
  Where the provider's own documented surface states a fact this host can read —
  through that provider's per-session observer hooks, or through the read-only
  connection to the private backend beside a Codex CLI row — the row's card shows
  it: the agent working or at rest, the current or last
  **tool type**, an observed pending **question request**, and that provider
  harness's own background task and shell counts. A field shows an observed value —
  a `0` only when the source positively reported an empty set — or `unknown`.
  None of it is scraped from the terminal, none of it is this host's own subtask or
  background-shell registry, and none of it weakens a stop confirmation
  ([Native status observation](#native-status-observation)).
- Native rows are created by this host, over the paired owner lanes by a connected
  owner that advertises native kinds, and by a hosted Pi child's `SessionSpawn` with
  `kind` `claude` or `codex` on its own host or an exact paired `host` (see
  [Starting and owning sessions](session-host-alpha.md#starting-and-owning-sessions)
  for its file-backed initial request and title handling). The Saved picker and the
  standalone launchers keep creating Pi sessions and behave exactly as before. A
  native row has no Pi status registration, so Pi's input framing and its
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
- A remembered native row keeps its own backend, workspace, and caption across a
  host restart, and is **restored automatically** when it can be verified — see
  [Restart restoration of native rows](#restart-restoration-of-native-rows). A row
  that cannot be restored comes back as a truthful **unavailable placeholder** titled
  `<name> (unavailable)`, where `<name>` is the caption the operator gave the row or,
  if it was never named, its provider label. It is never restarted as a Pi row, never
  adopted into a live provider process, and never bound to an arbitrary recent
  provider conversation.

### Restart restoration of native rows

A host restart restores **every** remembered native row automatically, the same way
it restores a remembered Pi conversation: in the remembered mixed order beside Pi rows
and remote cards, with its caption, and with the remembered active row selected
unless you already acted during startup. Each restored row is a **new** process this
host owns, asked to resume exactly one conversation:

- **What is remembered.** For a native row the roster keeps the exact provider
  conversation UUID the row's own run last proved, and the id of the launch target it
  was started with. No executable, argument, environment, or credential is stored. The UUID is the host's private restart identity: it is never a
  Pi conversation id, never shown on a card, and never sent to a paired viewer.
- **Which target restores it.** A row restores with its backend's built-in default
  target — the same normal native setup a New session uses. A row remembered with
  that default restores with it unchanged. A row remembered with a legacy configured
  worker target (`external:<id>`) is deliberately restored with its **backend's**
  default: a Claude row as base Claude Code and a Codex row as base Codex CLI. This is
  a deliberate compatibility change, not a fallback: the old entry's command,
  arguments, and environment are not looked up or reproduced, and the row is not
  unavailable merely because that worker entry was since removed. Everything that
  identifies the row is still exact — the same provider conversation UUID, recorded
  workspace, caption, roster order, and restoration proof below — and the provider's
  own native permissions apply. A row is never resumed as a fresh conversation or as
  a different kind. No bulk deletion or migration of settings is performed; normal
  row persistence records the selected base target. Worker configuration is not
  rewritten. Any other remembered id stays refused.
- **Downgrade compatibility.** A roster containing a Codex startup caption longer
  than the old 80-character manual limit, or with surrounding whitespace, may be
  rejected as a whole by an older build that accepts only that narrower rule.
  Those builds cannot restore such a roster; this change provides no automatic
  conversion for downgrades.
- **What is checked before anything starts.** The remembered UUID and target id are
  both present; the backend default it maps to is currently offered by this host;
  the recorded workspace still exists; and this host can start native rows at all.
  The launch then goes through the same launcher as New, with the target named
  explicitly, so a launcher that cannot resume that target exactly (for example a
  Codex row whose backend this host does not own) refuses instead of starting a
  fresh conversation.
- **What proves it.** The resumed run's own provider must still prove the
  conversation: for Claude Code, that run's own root `SessionStart` resuming exactly
  that UUID in the recorded workspace; for an owned Codex row, a read-only check of
  exactly that thread before the interactive TUI starts and then that TUI's own
  resume of the same thread. Until then the row is an ordinary live row whose status
  stays `unknown`. A later conversation change that the same run's own provider
  positively proves replaces the remembered UUID; a positive loss of the proved
  identity, or a loss of the observer that could follow it, forgets it. An ordinary
  exit or stop keeps the last proved UUID.
- **Status after a restore.** A restored Claude Code row gets the same launch
  baseline as a fresh row — agent idle, input `none`, `Ready`, and 0 background
  tasks and 0 shells — once, before any new prompt, as soon as **both** of two facts
  hold, in either order: this host activated the new process it launched for the row,
  and that run's own root `SessionStart` proved the exact conversation as described
  above. No prompt is sent to obtain it. Before that proof, or when the proof is
  missing, names another conversation or workspace, or comes from a child, every
  field stays `unknown`. The baseline describes the new process, not the resumed
  history: earlier transcript rows, summaries, and task records are never read as
  current state. Anything the run reports itself — a prompt, a question, a tool or
  background launch, a membership snapshot, newer root transcript rows, a session
  end, or a hook-lane loss — replaces or withdraws the baseline exactly as on a fresh
  row. The baseline is forfeited, rather than idling the row over something unseen,
  by a hook-lane loss before the proof, by a hook naming the resumed conversation
  that arrives before the proof (it is still not admitted as status), and — when the
  proof comes first — by any hook of the run or any new transcript row between the
  proof and activation. A repeated activation or start notice never re-mints it.
  Each restored row is judged on its own run's evidence only, so two restored Claude
  rows in the same workspace never affect each other. These counts are display
  only: they never become ownership counts or stop/idle authority. A restored owned Codex row
  starts with a fresh native question queue: without contrary live evidence it can
  show `none` before the first prompt; live questions or gaps still mean `pending`
  or `unknown`. Its counts and `Ready` come only from that thread's current complete
  census, exactly as for a fresh row. No input is replayed into a restored
  conversation, and this host does not answer provider authentication, trust, or
  approval prompts. While initial restoration proof is pending, the row stays live,
  selectable, and `unknown`, with no deadline; later status follows the provider's
  actual observations rather than the presence of a prompt alone.
- **What stays unavailable.** A remembered row with no proved UUID — including every
  row remembered before this restoration existed, which is never retrofitted from
  provider history, file times, or names — or with a missing or unmappable target
  id, a backend default this host does not currently offer, a vanished workspace, or
  no native hosting, comes back as the unavailable
  placeholder with a bounded reason, and nothing is started for it. A resume refused
  before it started, or one whose provider exited before proving the conversation,
  stays on its real row as `<name> (unavailable)`; that row still owns its resources
  until they settle and is removed only by your deliberate Delete. In every case the
  remembered UUID, target, and caption are kept, so the next restart tries again;
  Delete is the only way to forget the row.
- **What this does not add.** Restoration happens at host startup only. Resuming an
  exited native row from its card in the same run, or following an in-pane Codex
  resume or switch to another thread, is still unsupported (see below), and in-pane
  `/resume` remains the provider's own feature.
- **Qualification is pending.** This restoration is covered by the repository's
  component tests with synthetic providers. It has not yet been qualified against a
  live Claude Code or Codex release, and it is not Windows runtime evidence.

## What the host owns, and what it never infers

- **Supported:** process spawn, addressed keyboard input, resize, the owned stop
  ladder, and the child's exit — and, for a hosted Codex row, that row's own private
  backend child beside it. These are host-owned process facts.
- **Observed where this host armed a provider-side observer and that observer
  reached its source:** the agent's working/rest state, the current or last tool
  **type**, an observed pending question request, and that provider harness's own
  background task and shell counts. Everything the host has
  not observed stays unknown. See
  [Native status observation](#native-status-observation) for what each provider
  documents and for the two answers a field can hold.
- **Never this host's own doing, whatever an observer reports:** a pending native
  **approval** is never answered, resolved, requested, or inferred here — the only
  approval fact a card can ever show is one the provider itself positively stated
  about its own root — and this host's own conservative ownership pair
  (`backgroundTasks` / `backgroundShells`) that gates an idle-only stop or
  removal stays unknown for a hosted provider child. A provider's own task and shell numbers are activity facts about that
  provider's harness; they never enter the ownership channel, so no provider
  reading — including a displayed rest — ever authorizes stopping a
  row that would otherwise require confirmation.
  `Unknown` records that this host observed nothing usable for the field — not
  that the provider has nothing to report. The capability tables below say what
  each provider documents, and where a genuine gap remains.
- The host **never scrapes the terminal** to guess a provider's state, and never
  infers idle from a missing PID, a quiet period, or an output gap. That row's own exit
  event is the settlement witness for its interactive child; a hosted Codex row stays
  unsettled additionally until that row's own private backend and relay have each
  proved their own actual end
  ([Launch and ownership rules](#launch-and-ownership-rules)).
- Stop is an **explicit, confirmed owned stop**: an idle-only stop or removal of a
  native row always requires confirmation, exactly as an unobserved Pi row does.
  A displayed rest on a native card is a foreground display fact about the
  provider's own turn, never the complete-idle proof the stop gate reads; that
  gate keeps requiring this host's own ownership counts to be positively observed
  zeros, which a hosted provider child never reports.
- Within a running host, resume is **in-pane only**, through whatever the provider
  itself offers (for example `/resume` in a running Claude Code session). Pi's
  rename, Saved conversation open, and exited-row resume are unavailable for a native
  row, because they are Pi APIs. The one resume this host starts itself is the
  automatic one at host startup
  ([Restart restoration of native rows](#restart-restoration-of-native-rows)).

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
| Resume | Documented | [`claude -c`, `claude -r` with a session id or name, `/resume`, `--fork-session`, `--session-id <UUID>`](https://code.claude.com/docs/en/sessions); not everything is restored — plan mode only under conditions, and a forked process starts without the earlier session's permission grants. A hosted row passes `--resume <UUID>` only when [restart restoration](#restart-restoration-of-native-rows) resumes its own remembered conversation; it never uses `-c`, a name, or `--fork-session` |
| Native tasks and subagents | Documented in-client and in-process; **Unknown** as an external read | [`--agents` definitions and the `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted` hook events](https://code.claude.com/docs/en/hooks) report transitions. Inside a running session a [mod](https://code.claude.com/docs/en/plugins/mods/reference) can take a live census: `$.agent.list()` "returns this session's subagents and teammates, each with a status of `pending`, `running`, `waiting`, `idle`, `completed`, `failed`, or `killed`", where `waiting` and `idle` need Claude Code v2.1.289 or later. [Agent view](https://code.claude.com/docs/en/agent-view) documents that those subagents and teammates are **not** listed as separate rows there, and no read from outside the running provider process is documented |
| Background shells | Documented in-client; **Unknown** as an external read | [`Ctrl+B`](https://code.claude.com/docs/en/interactive-mode) moves a running Bash command to the background (tmux users press twice); `!` shell mode runs a command directly; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` turns backgrounding off. A tool hook can see a `Bash` call with `run_in_background: true`, but the running set is listed only in-client with `/tasks`, no completion event is documented, no per-change notification is documented, and no external per-session shell count is documented ([Tools reference](https://code.claude.com/docs/en/tools-reference#background-commands), [PreToolUse input](https://code.claude.com/docs/en/hooks#pretooluse-input)) |
| External current-state read | Documented; **unverified** for a row this host starts | [`claude agents --json [--all]`](https://code.claude.com/docs/en/agent-view) is documented as the way to read session state from outside Claude Code — "every live session, plus background sessions that are still working or blocked even when their process has exited" — where entries carry `cwd`, `kind`, and `startedAt`, and a live entry carries `pid`, `status` (`busy`, `waiting`, `idle`) and, while waiting, `waitingFor` naming the cause (permission prompt, question or MCP input request, sandbox request, open dialog). The same page's agent-view list also says an interactive session open in another terminal does not appear until it is backgrounded, and the documented `state` values cover background sessions, so whether a session this host started in its own PTY is listed at all is **unverified** — not documented as impossible |
| Hooks | Documented; **session-scoped observer hooks are armed per launch** | A large [lifecycle event set](https://code.claude.com/docs/en/hooks) (session, prompt, tool, permission, subagent, task, model switch, compaction, session end) with command, HTTP, MCP-tool, prompt, and subagent handlers, restrictable by managed settings. This host arms a read-only subset of those hooks **for one launch of one row**, through that provider's own per-session configuration channel, and it installs nothing into the operator's settings, plugins, or trust store ([Native status observation](#native-status-observation)). With automatic review of Claude Code rows On, a launch also gets blocking `UserPromptSubmit` and `Stop` hooks in one more review-only `--plugin-dir` ([Automatic review of hosted native sessions](review-workflow.md#automatic-review-of-hosted-native-sessions)) |
| Mods (in-process observers) | Documented; **not installed or integrated by this host** | [A mod runs inside Claude Code](https://code.claude.com/docs/en/plugins/mods/reference) and follows its own conversation through [events](https://code.claude.com/docs/en/plugins/mods/events) including `turn.start`, `turn.step`, and `turn.complete`, with API namespaces such as `$.agent.list()`, `$.session` (`id`, `cwd`, `model`, `version`, …), and `$.env.get` / `set`. Running in the provider's own process, it needs no second client, which makes it the closest documented native-UI-preserving bridge; `--plugin-dir` and `--settings` are documented as applying to one session only. This project installs no mod and claims nothing about what any operator's own mod reports; the only things it ever passes through `--plugin-dir` are throwaway hooks-only plugins for one launch — the status observer's and, with automatic review On, a review-only one — with no JavaScript mod, MCP server, tool, command, or skill in them |
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
| Resume | Documented | [`codex resume` (by id or name, `--last`, `--all`) and `codex fork`](https://learn.chatgpt.com/docs/cli/reference); `--worktree` cannot combine with resume. A hosted row starts `resume` with one exact thread id only when [restart restoration](#restart-restoration-of-native-rows) resumes its own remembered conversation on a row whose backend this host owns; it never uses a name, `--last`, `--all`, or `fork`, and otherwise resumes only in-pane |
| Native tasks and subagents | Documented in-client; **Unknown** as an external read | [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): `agents.enabled` defaults to `true`, built-ins are `default`, `worker`, and `explorer`, and custom agents are TOML files under `~/.codex/agents/` or project `.codex/agents/`; `SubagentStart` and `SubagentStop` [hook events](https://learn.chatgpt.com/docs/hooks) exist. No programmatic current-state census for an ordinary hosted TUI session was established by this source review; on the owned route the backend beside the row is this host's own, and that provider's documented descendant-thread listing is what the task figure reads |
| Background shells | Documented in-client; **Unknown** as an external read | [`/ps` lists the session's background terminals with each one's command and up to three recent non-empty output lines, and `/stop` (alias `/clean`) stops them](https://learn.chatgpt.com/docs/cli/slash-commands); that list is populated when `unified_exec` is in use, otherwise it may be empty. A unified-exec `exec_command` matches as Bash and "a later `write_stdin` poll can deliver the original command's `PostToolUse` when that command finishes" ([hooks](https://learn.chatgpt.com/docs/hooks)), so settlement is observable only when something polls; no external per-session shell count is documented. Separately, app-server `thread/backgroundTerminals/list`, `/terminate`, and `/clean` are experimental and require the `experimentalApi` capability; `thread/shellCommand` runs outside the sandbox with full access and is never used, and the owned route reads only the list method against its own backend — a refusal there is `unknown`, never a zero |
| External current-state read | Documented for an app-server client; **Unknown** for a session this host does not own the backend of | [`thread/read` and `thread/list` report runtime status, and `thread/status/changed` notifies with e.g. `status.type: "active"` and `activeFlags: ["waitingOnApproval"]`](https://learn.chatgpt.com/docs/app-server). On the owned route this host holds the backend and reads those methods read-only against its own endpoint; whether a second app-server client could observe a thread owned by some other, provider-started session is unverified and never relied on |
| Hooks | Documented; **on the owned Codex route this host arms only the opt-in review hooks** | [Lifecycle events](https://learn.chatgpt.com/docs/hooks) covering session start and end, prompt submit, tool pre and post, permission request, subagent start and stop, compaction, model request, stop, and interrupt. Hooks belong to the CLI itself, so they apply to an interactive row with no app-server connection — real transition signals, and still no current-state census; non-managed hooks must be reviewed and trusted by hash before running (`/hooks`). For a hosted Codex row this host prepares no observer hook of its own, because the read-only connection to the backend it owns is that row's metadata channel; every hook, override, and flag the operator wrote is still composed unchanged for both children. With automatic review of Codex rows On, the backend alone also gets `-c hooks.UserPromptSubmit` and `-c hooks.Stop` entries that run a stable script in this host's state directory; Codex's own one-time hook trust stays in front of them, and an operator override of the same paths means no review for that row ([Automatic review of hosted native sessions](review-workflow.md#automatic-review-of-hosted-native-sessions)). On a Codex launch this host does not front with its own backend it adds at most one per-launch `hooks.SessionStart` entry and only where it conflicts with nothing the operator wrote; it writes no hook file, no `hooks.state` trust record, and no bypass, and the provider's own review-and-trust step stays in front of it ([Native status observation](#native-status-observation)) |
| app-server | Documented, experimental | JSON-RPC over stdio by default; the WebSocket transport is documented as experimental and unsupported, and status-reading methods can be gated behind the `experimentalApi` capability. The owned Codex route uses that WebSocket transport against the backend this host owns, and a method the backend declines simply leaves that field `unknown` |

## Native status observation

A hosted row can say more than "I own this process". This section states exactly
what this host observes, how it reaches the host, and what each answer means.
Everything here is source-derived: the host reads the provider's own documented
hook and persisted-record surfaces, and states nothing it did not observe.

**One shared card.** The same shared sidebar components
draw a native row locally and a native row the operator sees through a paired
owner: the agent state, the current or last tool **type**, the existing
`Working` / `Ready` activity wording, a
pending-**question-request** indication where the host actually observed one —
never an invented counter of something else — and that provider harness's own
background task and shell numbers. Every
field holds one of two answers:

- a **real observation** — and a `0` only when the source positively reported an
  empty set for that category;
- **`unknown`** — a value that failed, was
  unverified, was never observed, or was withdrawn after a gap.

`unknown` is never rendered as a zero or as rest, and a value that simply went
missing stays `unknown` rather than being relabelled.

**Native harness jobs are not this host's jobs.** A provider's own subtasks and
background shells are that provider's harness work. They are never this host's
subtask registry or its background-shell registry, and a provider number never
enters the conservative `backgroundTasks` / `backgroundShells` ownership channel
that gates a stop. A displayed `Ready` never
becomes idle-only stop authority: the stop and remove gate keeps requiring this
host's own ownership counts to be positively observed zeros, which a hosted
provider child never reports. A displayed foreground rest is a display fact about
the provider's turn, not complete idle proof.

**How an observation reaches the host (the hook lane).** The provider's own
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
clipboard watch, no raw recording, no extra service, and no replacement
conversation; the hook lane itself adds no listener and no port.

**How an owned Codex row's observations reach the host.** A hosted Codex row gets a
private app-server backend of its own. This host starts one backend child for that
row on numeric IPv4 loopback with an operating-system-chosen ephemeral port,
authenticated by one fresh capability token of which only the SHA-256 digest ever
reaches that child's generated arguments, and the interactive client is launched
with the provider's own remote-connection arguments pointed at a private relay this
host owns in front of that backend. The relay is an opaque byte forwarder with a
read-only frame tap: the genuine client's handshake and frames are copied unchanged
in both directions under real backpressure — the one rewrite is the `Host` header,
which has to name the backend it dials — and the relay originates no
application-layer byte ever, so it never subscribes, starts, resumes, forks, retries,
answers, or approves anything, and a second concurrent client is refused. Its tap
emits only a closed set of metadata projections — opaque ids, closed enums,
booleans, and counts — never a prompt, command, output, question, option, answer,
path, model text, or error message. The row's five sidebar categories then come from
one read-only connection to that same backend, which reads status and the provider's
own censuses and never replies to a provider request; a pending approval or question
stays in the provider's own UI. The backend child inherits the same native
configuration, `CODEX_HOME`, and authentication the interactive client does, and
nothing is written into provider settings, trust stores, or credential files. Two
loopback sockets exist for such a row — the backend's listener and the relay's — and
both are private, ephemeral, and owned by that row alone.

That route states anything about a thread only on an ordinary fresh start or a
verified [restart restoration](#restart-restoration-of-native-rows) — where the
remembered thread itself is read before the TUI starts and the TUI's own resume of
exactly that thread stands in for the thread start below. A fresh start is proved
in order: the backend's loaded-thread census was empty before anything attached, one
genuine provider-client `initialize` established the connection, and exactly one
initial non-helper, parentless, non-ephemeral thread start named the candidate. Those
three facts are the fresh candidate: the read-only observer starts on that one thread
before any prompt, so a freshly launched, still unprompted row can show `idle`,
`input none`, `0` tasks, `0` shells, and `Ready` — but only once the provider's own
complete read of that thread reports it idle, its sub-agent census is complete and
empty, its background-terminal census is complete and empty, and no question of its
own is waiting. A launch default, a quiet period, or the empty-backend census alone
never produces any of those values, and a failed or unfinished read leaves its own
field `unknown`. That same connection's own first successful turn start must then
name the same thread, which binds it as the root on the same read-only connection
with no new dial; a status read that may predate that turn is discarded and re-read
rather than allowed to show a stale `Ready` over the new work. Until the fresh
candidate holds, the row publishes `unknown` — not rest, not a zero, and not a
declaration that Codex cannot report it — and the interactive session stays fully
usable, because this route never waits on a provider session-start hook that itself
only fires on a first turn. A consumer that attaches later is handed the current
closed state, never a replay of the frames that produced it. A root the operator
moves on deliberately — a side thread, a fork, a resume, a fresh thread, or a new
connection — sits outside that proof, so the source withdraws to `unknown` rather than
carrying a stale scope or guessing a replacement; the provider's own UI and transport
keep working exactly as before, and nothing here needs a provider patch. Retiring
that observer closes only its own read-only connection, its watcher, and its timers:
the relay keeps forwarding, and the owner's stop of the row's own resources stays
exactly as truthful as it was.

**There is no liveness proof.** If the provider never runs the hook, or the relay
never reaches the broker, nothing is reported to the row: no heartbeat, no queue,
no retry, no replay. Fields stay unknown until observed and are withdrawn when their own
source fails; a transcript-only failure does not erase a hook-reported count.
No promise is made that every missed hook is detected.

**Claude Code: what the observer states.** The armed event set is `SessionStart`,
`SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`, `StopFailure`, `SubagentStart`, and `SubagentStop`.

- A question is a **request lifecycle**: a `PreToolUse` for the question tool
  opens a request and a matching `Post*` closes it. `Pre` means a question was
  *requested* — it is not proof that a human-visible dialog was painted or that
  anything was answered. `input pending` reflects open observed requests; a
  genuine root `SessionStart` establishes the empty request baseline, so input is
  `none` before the first question and remains so through ordinary work. A matching
  close (including a persisted result for the root request) settles that request
  alone. A confirmed root turn end or the next accepted root prompt can repair a
  gap in root question coverage without resetting the conversation. Neither event
  settles a subagent's question or certifies an unreadable subagent census. A gap
  attributable to a named child clears on that child's definitively established
  execution end, not on `SubagentStop` alone or on another child's end. A gap that
  cannot be attributed to a child is not cleared by any one child's end.
- Tool activity is **type-only**: the current or last tool TYPE label, or
  `Working` / `Ready`. Arguments, results, and question content never enter state.
- A turn is **at rest** only from the positively bound, persisted **root**
  `stop_hook_summary` record, which the provider writes after every `Stop` hook
  has answered. This host's own `Stop` callback is never sufficient, because
  another operator's `Stop` hook can block and continue the same turn. That is why
  a `Stop` this host cannot prove final also never forces an observed foreground
  away: where a root turn was positively observed running, that running state and
  its tool type stand through the unproven boundary. A persisted summary that
  positively reports a block without a failed hook (including an automatic review
  that sent a verdict back to the model) confirms continuation, not completion:
  the observed foreground and input stay known. The next clean, bound Stop can
  show `Ready`, and the card shows `agent idle` and `input none` once input is
  definitively clear. A failed or inconclusive root summary withdraws only the
  root facts it calls into question. A non-root summary makes no claim about the
  root. Trailing assistant and tool-result rows before a terminal summary belong
  to the finishing turn; newer work after that terminal boundary can withdraw
  its Ready claim.
- Task and shell counts are a **live membership census of that run**, not only a
  turn-boundary reading. One per-run ledger holds the active set, and it starts only
  on evidence that can vouch for it — this host's own launch of that provider child
  (no background member of a run it started can predate that child), or one complete
  **root** membership snapshot — and it then moves on positively observed edges: a
  confirmed background launch identity and its matching completion, read out of this
  run's own persisted root rows. A keyed edge is an **update to an exact count**, not a
  withdrawal: a confirmed launch takes the figure from 0 to 1 and its matching
  completion brings it back, and the same is true of a complete root `Stop` snapshot of
  the documented `background_tasks` array, which replaces the whole set and outranks
  anything the ledger remembered — the recovery path after a hole. Present is a real
  observation, absent is unknown, and a
  subagent's snapshot is that child's own array and is never used as root scope. An
  **empty** array is a real empty *in-flight* census: it makes the ledger's own set
  empty, while the published task figure is still that set unioned with this run's live
  agent identities — so an empty array beside one still-live parked agent publishes
  tasks 1 / shells 0, and a `0` is claimed only for what this observer can actually
  state.
  Where the ledger has no exact set to publish, a root `Stop`'s own identity-free
  totals stand as **last-reported**, and any membership edge clears them, because
  totals cannot account for a member nobody saw; that fallback also stands only while
  this run holds no live agent to reconcile it against, since a total says nothing about
  whether it already counts one.
- The published task figure is the **distinct union** of that run's non-shell
  in-flight members and its **live agent identities**. An agent counts from the
  provider's own agent-start edge and stops counting only on a positively
  established actual end, scoped to one execution window: that window's own turn
  boundary showed it owned nothing still running or pending, and its own terminal
  completion was recorded in that same window. An agent parked on work it owns, one
  whose owned work has just settled and is about to wake it, one held by a genuinely
  blocking question, and one whose final turn ended without that end being
  established are all still counted: a snapshot that stops listing an agent, a turn
  boundary alone, a root question, or the rest of the session emptying out never ends
  one, and no delivery to the root and no whole-session-empty condition is required.
  The same id positively resuming is counted again. A background shell an agent
  launched stays a shell and is never added to tasks, and an id counted by both
  sources is one task. Two things make the task side alone unstateable rather than
  merely large: an id the provider lists as a shell member that this run also knows as
  a live agent — an identity conflict in one shared key namespace, so the task axis
  goes `unknown` while the provider's own shell number keeps standing — and an agent
  whose own lifetime crosses an evidence gap. A root snapshot cannot repair that
  lifetime, but when agent identity coverage is intact it can prove the task count
  if its exact membership already lists every unresolved agent as a task: whether
  those agents are still live cannot change the union. An omitted unresolved agent
  is not proof that it ended. If the gap could have hidden an agent's start, even a
  snapshot listing every tracked agent cannot rule out an unseen parked agent.
  Tasks remain `unknown` until a positively fresh conversation establishes a new
  agent census; the same snapshot can still restore the shell count.
- An exact figure changes only on evidence that changes membership, and it is withdrawn
  **only by what can contradict it**: a settle for an id this ledger never launched, a
  membership change whose member cannot be identified, an over-full member set, a
  malformed snapshot, a confirmed gap in the lane, a scope change, or a loss of the
  authenticated hook lane — never merely because some other event arrived, and never
  because an ordinary keyed edge moved the number. Ordinary new foreground work says nothing about background membership, so a live
  set or a last-reported snapshot survives it, and a transcript-only failure does not
  silently null a count the provider itself reported. Nothing reconstructs a count
  from process counts, activity, or quietness. The two categories are published
  **independently**: a hole attributable to one of them — a member of a known kind
  this ledger cannot key, a launch of a known kind it cannot track — makes that
  category `unknown` while the other keeps stating exactly what it knows, while a
  hole nobody can attribute, a scope change, or a lane loss withdraws both. These
  counts are **advisory display only**: they are never this host's
  `backgroundTasks` / `backgroundShells`, never ownership, and never stop or idle
  authority.
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

**Codex: what the observer states.** A hosted Codex row on the shipped route is
observed through the read-only connection to its own private backend described
above, and for such a launch this host prepares **no** observer hook of its own:
neither child's real arguments or environment carry an observer hook instruction,
marker, or staged artifact from us, while every hook, configuration override, and
flag the operator wrote is composed unchanged for both children. The opt-in
automatic review hooks are separate: when they are armed they reach the backend
child only, with their own marker
([Automatic review of hosted native sessions](review-workflow.md#automatic-review-of-hosted-native-sessions)). The arming below is what a
Codex launch this host does not front with its own backend uses: one
`-c hooks.SessionStart=[…]` entry, and only when the operator writes no
conflicting `hooks` or `hooks.SessionStart` override in real option position —
same-layer paths are last-wins, so adding one there would replace theirs. An
existing override is preserved untouched and that row's fields
simply stay unknown. File-based hook layers from other sources stay additive; this
host writes no hook file, no `hooks.state` trust record, no self-trust, and no
bypass, so the provider's own review-and-trust step still runs in front of it.
The generated command is stable across rows of one host; a changed package path
or command can need the operator's approval again. Nothing here edits the
operator's trust store.

On the hook and rollout lane:

- Agent turn state and tool activity come from the **exact owned root thread's**
  durable rollout records — `task_started`, `task_complete`, `turn_aborted`, and
  persisted tool items — read together with that run's own hook metadata.
  Descendant-scoped events and nested turns never act as root authority.
- Activity is likewise **type-only**, from a closed label set — an exec, an edit, an
  MCP tool, a web search, an image view, a read, a sub-agent, or a plain tool.
  A question or permission tool contributes **no line at all**, so nothing in the
  activity row can imply pending input — while that scoped tool attempt still counts
  as processing evidence for the foreground. After a gap, a fresh, bound root
  tool hook that proves a tool type restores its line without waiting for another
  rollout record.
- A raw hook `Stop` (or a notification) is **never** a terminal: a blocking
  `Stop` hook continues the same turn, so the durable terminal in the rollout is
  the only rest witness, and it grants rest once, for the held turn only.
- Questions and approvals stay in Codex's own UI, and nothing on the card stands
  in for them.

On the owned lane, once that row's own fresh candidate is proved, all five categories come
from the read-only connection to the backend this host owns. The two lanes never
blend: a row switches at most once, when its own owned-backend capability arrives,
and a later observation loss publishes `unknown` rather than restoring the retired
lane or guessing a value.

- **Agent and activity** come from that root's live provider status — an idle root is
  a real rest, an active root with no flags is real work — with the current or last
  tool TYPE attributed only to the bound root's current turn, so a helper or child
  thread is never labelled as the root's tool and an older turn's completion is
  rejected. A tool completion is never presented as rest.
- **Input** is `pending` when the provider's own waiting-for-approval or
  waiting-for-user-input flag is set on that root, or when one of that root's own
  asynchronous questions is still unanswered. It is `none` only when both are
  positively known to be clear, and `unknown` otherwise. This host never answers,
  forwards, or guesses either kind. A descendant's own pending prompt, or a helper
  thread's question, never changes the root's agent or input axes. Once the root
  facts needed for a status update are proved, an independent foreground or
  input update, including a fresh bound tool type or its clear, need not wait
  for another background census. Only the last committed counts accompany it.
- **Asynchronous questions** are not provider requests and raise no status flag, so
  the relay's tap tracks them. It records only the asking item's id, its thread and
  turn, and how many questions it asked; no question, option, or answer text is kept.
  A question counts from the moment the provider completes the message that asks it.
  It stays `pending` while the question queue is collapsed or expanded in the
  provider's UI, while focus moves, while tools complete, and while the root keeps
  working — the agent line can read running at the same time. It clears only when
  the backend commits that thread's native reply naming that exact question. In a
  multi-question set, each answer clears only its own question. The relay does not
  treat the provider client's own answer submission, or the backend acknowledging or
  rejecting it, as that commit. Sending an
  ordinary new prompt from that same provider client makes the provider's UI drop its
  unanswered questions. A question can still be on its way to the UI when that
  happens, though, so the row cannot prove which ones were dropped. When the relay
  sees that client's own ordinary prompt for the root, each question it was holding
  becomes uncertain: input reads `unknown`, never a stale `pending` and never a
  guessed `none`. Acknowledging that prompt changes nothing. A question asked after
  it counts as `pending` again. A helper's prompt, a prompt on another thread or
  connection, or the backend echoing a user message clears nothing. The provider's
  UI drops its whole remaining queue when that thread's current live turn ends, and
  the row retires everything it held at the same point. That is not reported as an
  answer. Repeated or late copies of a question never bring it back. If a user message
  could not be read in full, or a reply naming a question carried no thread, the
  questions it might have answered become uncertain in the same way. Input reads
  `unknown`, not `none`, and the other fields keep their values. This uncertainty is
  limited to the named questions and can be recovered: as soon as the backend commits
  replies naming all of them, input returns to `none` without waiting for the turn to
  end. If a question message itself could not be read in full, the row cannot see
  which questions it asked, so no reply to a different question can prove `none`. A
  reply to that whole message resolves it, and so does a later complete copy of the
  same message while its turn is still current. Otherwise the gap stays until the
  current live turn ends. A turn end is one way to recover, not the only one. A fresh
  question or the provider's current waiting flag can independently prove `pending`
  in the meantime. Whether a reply is visible before the backend commits it depends
  on the provider's own queueing, so the row waits for the committed reply.
- **Tasks** count this row's own currently-active native sub-agents, and **shells**
  come from the provider's complete background-terminal census for the bound root and
  every proven descendant, deduplicated across pages and threads. A census publishes
  only when it finished collecting: a refused, truncated, contradictory, or unfinished
  walk withdraws its own axis to `unknown` rather than publishing a smaller number,
  while an authoritative empty page is a real `0`. Bounds on how much provider traffic
  one scheduling step may issue never shrink what a healthy row is allowed to report.

**What a paired viewer sees.** A paired viewer sees the same card. The owner's
observed status facts travel to an authorized viewer in the roster row fields the
roster already carried, under the existing pairing, consent, and per-viewer
settings, and nothing a viewer holds changes what the owner reports or how a
field is drawn.

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

## What a sidebar row shows

The sidebar rules apply unchanged: an unobserved field stays `unknown`, never
idle and never zero, and that row's own exit is the settlement witness for its
interactive child — a hosted Codex row additionally waits on its own backend and
relay proving their actual end
([Sidebar status and activity](session-host-alpha.md#sidebar-status-and-activity)).
Where this host armed a provider-side observer for a row and that observer reached
its source, some of those fields are **observed**; an observer that armed but never
reached the provider, or that lost its source, leaves the field `unknown`. Every
`unknown` below still means this host observed nothing usable — not that the
provider documents nothing. The capability tables above say what each provider
does document, and the "Current state versus events, and freshness" paragraph
below names the gaps that survive any observer.

| Sidebar field | Claude Code row | Codex CLI row |
| --- | --- | --- |
| Lifecycle and exit code | Real: the host owns the child process | Real: the host owns the child process |
| Conversation name | Observed when this row's observer read its own bound transcript — including the one metadata-only read that picks up a title the provider recorded before this host started watching: the conversation's custom title, else the title the provider generated for it (custom outranks generated); `unknown` before any such read, after an observation gap, and for a conversation this host never proved | Observed when the row's own private backend read named it: that thread's user-facing name; a thread the provider reports with no name is honestly titled by its provider label, and the field stays `unknown` before that read or after a gap |
| Agent busy or idle | Observed when the observer reached its source: running from an accepted prompt or root tool work, rest only from the persisted root turn-end summary, and a positively observed running turn stands through an unproven `Stop` boundary; `unknown` before any observation and after any gap or ambiguous boundary | Observed when the observer reached its source: on the owned lane, that backend's own live status for the row's thread once its fresh candidate is proved; on the hook and rollout lane, running from durable turn start or persisted root tool activity, rest only from that thread's own durable terminal for the held turn; `unknown` before any observation and after any gap, replay ambiguity, or source failure |
| Pending input | Observed question requests: `pending` while a request is open and `none` when both root and subagent coverage prove no request remains. A confirmed root turn end or the next accepted root prompt can recover missing root coverage; subagent uncertainty needs its own evidence. | `unknown` until this host observes it; on the owned lane, `pending` from the provider's own waiting-for-approval or waiting-for-user-input flag on the row's thread or from that thread's own unanswered asynchronous question, `none` only when both are positively clear, and `unknown` after an input-metadata gap or an own ordinary prompt that may have dropped a held question, until fresh evidence resolves it — this host never answers it, and it is never an inferred value |
| Background task count | Live membership of this run — exact while its own coverage holds, and a keyed launch or completion edge **updates** that exact number rather than making it unknown; the distinct union of this run's non-shell members and its live agent identities, so an empty in-flight census beside one still-live agent displays `1`, not `0`; a last-reported root `Stop` total stands only while the ledger holds no exact set and no live agent needs reconciling, and any membership edge clears it; `unknown` only for a genuine coverage hole — per category when attributable — a scope change, or a hook-lane loss | `unknown` before the row's own fresh candidate or root is proved and after any gap — never an inferred zero and never a claim that Codex cannot report it; on the owned lane, the provider's census of this row's own active native sub-agents, while a positively observed empty census displays `0` |
| Background shell count | Live membership from the same source and lifetime as the task figure — updated by the same keyed edges, cleared the same way when it is a last-reported total, and withdrawn only by a genuine hole (per category when attributable), a scope change, or a lane loss | `unknown` before the row's own fresh candidate or root is proved and after any gap — never an inferred zero and never a claim that Codex cannot report it; on the owned lane, the provider's complete background-terminal census for the bound root and its proven descendants, while a positively observed empty census displays `0` |
| Activity lines | Observed: the current or last tool TYPE, or `Working` / `Ready`; empty when nothing was observed or after a withdrawal | Observed: the current or last tool TYPE for the held turn, attributed only to the bound root; empty when nothing was observed or after a withdrawal |
| Row caption the operator can set with `E` | Yes: a host-side name of this host's row, never a provider conversation name | Yes: the same host-side caption |
| Roster title of a live row | The operator's caption, else the observed provider conversation title, else `<Provider>` | The operator's caption, else the observed provider conversation title, else `<Provider>` |
| Roster title of a remembered row after a host restart | Restored: the operator's caption, else `<Provider>`; not restorable: `<caption or Provider> (unavailable)`. An observed provider title is ephemeral and is never remembered, so a restored row starts from its caption or provider label, and on an uncaptioned Claude row the provider's title comes back from the transcript that run itself names once its conversation is proved — no new rename is needed, and a caption you typed keeps winning over it | Restored: the operator's caption, else `<Provider>`; not restorable: `<caption or Provider> (unavailable)`. An observed provider title is ephemeral and is never remembered, so a restored row starts from its caption or provider label and, on an uncaptioned row, shows the provider's title again once its own run reports one |
| Idle-only stop | Confirmation required, always | Confirmation required, always |
| Provider conversation rename, saved-conversation open, exited-row resume | Unavailable: Pi APIs | Unavailable: Pi APIs |

**Card structure.** A native card is drawn with the same rows as a Pi card, by the same
shared card formatter, and a paired owner's native row is drawn by that same
formatter. The background row always names both categories independently
(`bg tasks 2 | shells 0`), even when neither is observed
(`bg tasks unknown | shells unknown`). The task figure combines the provider's
native tasks with managed work for that exact conversation when the managed lane
has a census (for example, two native tasks plus one managed task is `bg tasks 3`).
If either applicable count is unknown, the total is unknown. Shell counts and
stop authority are unchanged. An unobserved field is never rendered as a zero
or as rest, and a displayed foreground rest never grants idle-only stop authority.

**Current state versus events, and freshness.** The host's status model is
event-driven with no periodic polling, and the shipped observer keeps that rule: the
hook lane reacts to that run's own hook events and to one watched transcript file and
starts no polling loop, and the owned Codex lane refreshes on the provider's own
status and membership edges plus one provider-scoped refresh armed only while work is
known to be in flight. The Claude Code external read is a poll, so using it at
all would be a per-provider adapter exception with its own staleness-to-unknown
transition rather than a global polling loop, and the host's event-driven
resynchronization points are not provider events. Codex's `thread/status/changed`
is a genuine event for a client of that app-server connection; on the owned route
this host is such a client of the backend it started for that row, while whether it
describes a thread owned by some other, provider-started session stays unverified and
is never relied on. What both providers document for these fields is a
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
documents no equivalent in-session census; the owned route's task figure comes from
that provider's own documented descendant-thread census instead.
The background-shell gap stands on **both** providers: neither documents any
notification that a background shell count changed inside a live interactive
session. Claude Code's `Stop` and `SubagentStop` payloads carry a
[`background_tasks`](https://code.claude.com/docs/en/hooks#stop-input) array of the
in-flight tasks known at that instant, which is a turn-end snapshot rather than a
live count, and no completion event for one shell is documented; Codex's `/ps` list
is in-client only, with a unified-exec settlement that arrives only if something
polls it. The shipped route therefore does not pretend to answer "what exists
right now" from notifications alone: on a Claude row a count is a live membership
set — exact while its own coverage holds, seeded by this host's own launch or a
complete root snapshot, and **moved** by each keyed launch or completion edge rather
than withdrawn by it — with a last-reported root `Stop` total standing behind it only
while no exact set and no live agent contradict that total; the set is withdrawn only by
a genuine coverage hole (category by category when attributable), a scope change, or a
hook-lane loss. On an owned Codex row a count is the provider's own census, re-read on
its own edges and withdrawn to `unknown` whenever a census
cannot be finished. Missing observations are never turned into fabricated zeros.

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

**One Codex child environment marker.** A hosted Codex child is given `HERDR_ENV=1`, the one value of an
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
  Claude or Pi child, and no multiplexer or SSH marker is touched. On a hosted Codex
  row it goes to the interactive client only; that row's private backend child starts
  from the same sanitized operator environment without this host-imposed key.
- **When status observation is armed for a launch, one more child-environment entry and
  that provider's own per-launch hook flags are added — and nothing else beyond the
  separate opt-in automatic review family described in this bullet.** For a
  hosted Codex row this host prepares no observer hook of its own at all, because that
  row's metadata channel is the read-only connection to the private backend beside it:
  no observer marker, generated flag, or staged artifact from us reaches either child,
  while every hook, configuration override, and flag the operator wrote is composed
  unchanged. The opt-in automatic review lane is the one exception, and it is a
  separate family with its own marker, `PI_REVIEW_GATE_NATIVE_REVIEW_BOOTSTRAP`, and
  its own token: one more review-only `--plugin-dir` for Claude Code, or two
  `-c hooks.*` entries plus the marker on a hosted Codex row's backend child only —
  never the interactive client
  ([Automatic review of hosted native sessions](review-workflow.md#automatic-review-of-hosted-native-sessions)).
  A review lane that cannot be prepared is likewise declined, never a failed launch. The
  two marker families stay distinct: the observer marker is the fresh
  `PI_REVIEW_GATE_NATIVE_HOOK_BOOTSTRAP` value carrying that launch's broker
  endpoint, generation, instance id, backend, and one-shot token, while the review
  marker above carries only that row's review bootstrap. Each is stripped from any
  inherited environment before the fresh one is set, and no token ever enters
  provider hook command text or an artifact. The added flags are
  exactly the two documented routes — a hooks-only `--settings` file when the
  configured arguments carry none, otherwise one extra session-scoped `--plugin-dir`
  holding a hooks-only plugin, or one `-c hooks.SessionStart=[…]` entry for Codex —
  and where they would conflict with the operator's own configuration they are
  skipped and the row stays unknown. Any refusal here is a **declined observer**,
  never a failed launch: the child is then composed exactly as it would be with no
  observer at all. The Claude routes stage their files in a freshly created
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
- The provider command is always the built-in default for the backend, with no
  host-configured base arguments or environment. An
  [`externalAgents` catalog](configuration.md#the-externalagents-catalog) entry is
  never a native session target, and neither its shared settings nor its
  `execution` and `review` role overlays are inherited: a top-level native session
  is not a delegated execution or review role.
- A hosted Codex row's interactive client carries no host-added `--no-daemon`, because
  it attaches to the private app-server backend this host started for that row; a Codex
  launch this host does not front with its own backend keeps `--no-daemon` as its one
  host-added argument, and an operator who configured the flag themselves keeps it
  either way. The per-launch
  status-observer flags described above are the only other addition, and they
  are skipped wherever they would conflict. An older Codex build that cannot start the
  backend or rejects a flag fails rather than being quietly redirected; nothing is
  silently dropped.
  `--no-alt-screen` and any headless or approval flag are not added. Claude Code
  adds no flags of its own on a New-form or restored row; a fresh `SessionSpawn`
  child additionally gets Claude Code's `--name=<title>` and, for either provider,
  the generated prompt-file instruction after a trailing `--`.
- Configured arguments that override the provider's permission, tool, sandbox, or
  hook-trust posture, or that would start a headless/service mode or attach to an
  existing conversation, or that would change the workspace scope, are a **launch
  refusal**, never a silent strip. The refusal is on the documented option name,
  so it covers restrictive values too: `--sandbox read-only` is refused exactly
  like a permissive spelling, and the operator's own inherited native
  configuration — which the host neither reads nor rewrites — stays native.
  Past a `--` terminator the provider reads prompt text, so those tokens are
  forwarded exactly and are never re-read as options.
- Stop uses the host's existing owned-handle ladder, and that child's own exit is the
  settlement witness for that child; a PID disappearing is not proof of settlement.
  Because
  a native row has no Pi status registration — the status observer above is a
  separate native family, never a Pi reporter — no Pi shutdown request is attempted
  for it: the host signals the handle it owns and waits for that handle's exit. For a
  hosted Codex row the same owner also stops that row's own private backend and its
  private relay, and the row is not reported settled until each of them proves its own
  actual end — the backend child's genuine exit plus the natural end of both captured
  readers, and the relay's own listener and socket closures — never from a stop
  acknowledgement, a timer, or a stream being destroyed.
- A native launch descriptor may carry one Windows batch command line beside its
  file, argv, environment, and workspace. The manager validates it as one printable
  non-empty string and refuses a descriptor carrying an unusable one — it is never
  silently dropped and never spawned as a bare interpreter with no command — and
  the manager's default PTY factory hands that string to the pinned public
  `@lydell/node-pty` spawn in place of argv. On Windows that factory also selects
  the ConPTY DLL bundled with the pinned package (`useConptyDll: true`) instead of
  the system ConPTY, so the shipped source path uses the same ConPTY transport as
  the Windows runtime path; POSIX options are unchanged. On that same Windows
  request the factory captures the addon's own output reader for the handle it
  just created, releases it through the addon's own drain and dispose path only
  after that handle reports its genuine exit, revalidates the captured ownership
  chain before invoking anything, and requires the addon's reader Worker
  settlement to be positively observed — a release it cannot confirm stays a
  cleanup failure at host disposal instead of becoming success. A native row is
  spawned by that same factory, so its reader release is required on the same
  terms as a Pi row's.

## Managed tools in native conversations

On a supported Linux or macOS sidebar launch, Claude Code and Codex can discover
Review Gate's shared `Subtasks*` tools over MCP when the host can arm a managed
lane with valid saved settings. The provider still handles tool discovery and
approvals; the host does not grant preapproval. For example, Claude's
`--strict-mcp-config` can prevent the host from adding its server. A listed tool
still requires proof of the current conversation before it can act.

`SubtasksStart` and `SubtasksAdd` use the same managed worker queue, review
policy, and landing rules as Pi. An `execute` task uses a Git worktree; it can
land unreviewed when subtask review is off. It does not switch to `inplace`.
`SubtasksInspect` can read an owned result even when no completion message
arrived. Recovery tools operate on work owned by that conversation;
reusing a sidebar row does not transfer old handles. On a supported, proved
Claude `/clear`, the new conversation regains tool access without inheriting the
old one's work. Configured Pi workers and in-scope Pi reviewers use the Pi
executable the host admitted, not a different `pi` found on `PATH`.

Automatic completion delivery and one-shot `SubtasksWatch` depend on the exact
launch's verified callback support. The minimum versions are Claude Code 2.1.330
and Codex 0.171.0 for the owned Codex backend. Where callbacks are available is
a separate question, unchanged by these minimums. Claude callbacks are
available on Linux, macOS, and Windows. A macOS launch is eligible only
when it uses the default `claude` target resolved to a native executable (no
configured command, wrapper, arguments, or environment) with the host's hooks
and managed MCP prepared. The host then checks that exact executable's version
and proves the announced inbox socket's owner, permissions, and ACLs before it
enables callbacks, and again before and after connecting for each send. A
launch that fails any check gets no callbacks; its managed tools still work.
macOS callback support is covered by synthetic tests only; it has not yet been
accepted against a live Claude session on a Mac. A Windows launch has the same
eligibility, with the default target resolved to a native `claude.exe` (never a
`.cmd` or `.bat` shim). The host first proves, from the file's and each parent
folder's permissions, that no other account can change or replace that
executable. It then checks the exact executable's version through the stock
System32 Windows PowerShell 5.1, which must be present. Just before starting
Claude under a held supervisor, the host confirms the executable is still the
exact file whose version was checked, and confirms it again when Claude's
authenticated session start matches that supervisor's own report for the same
session. Callbacks start only after both checks pass; an update or replacement
before either check gets no callbacks. Every send goes through that supervisor.
A version check that cannot confirm its own check process has ended refuses that
launch attempt instead of starting Claude beside it. A launch that fails any
check before the supervisor is chosen starts normally without callbacks; its
managed tools still work. Once the supervisor is chosen, a failure to start
Claude under it ends that launch attempt rather than starting Claude a second
time; a failed check at the session match leaves Claude running without
callbacks. These checks assume a same-user trust boundary: they do not defend
against another program running as the same Windows user. Windows callback support in this composition is
covered by synthetic tests; its live acceptance against a Claude session on
Windows is still pending. Codex proves its owned
backend's version through a bounded `--version` probe on Linux, or through that
backend's own handshake on macOS and Windows. Either way, the version must be a plain stable
`major.minor.patch` at or above the minimum. Prerelease, build-tagged,
malformed, and older versions get no callbacks. The minimums are the tested
releases; newer releases are accepted without separate testing, and every other
eligibility check still applies. A watch requires a current sender and requests
one progress notification if the work is still active. Earlier actionable
outcomes cancel it. Sending is not proof that the conversation consumed the
message, and uncertain sends aren't retried automatically. `SessionHosts` and
`SessionSpawn` return direct results only; a successful spawn confirms launch,
not completion of the child's prompt.

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
  **Workspace**, enter an existing directory, and submit. The Provider line offers
  only Pi plus the Claude Code and Codex CLI kinds this host's launch probe finds
  startable, so a provider CLI that is not installed is not offered. With a connected
  **Host** line it offers only that owner's freshly probed native kinds, or no native
  choice at all if that owner advertises none or its catalog availability is unknown;
  confirm which you get before submitting.
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
  Claude row can show an observed pending question request and its background
  membership counts; a Codex row's counts appear once that row's own fresh candidate is
  proved, before any prompt.
  Two outcomes are also correct behavior: a card whose fields
  stay `unknown` because the provider's own policy declined the observer's hooks or
  because that Codex row's fresh candidate is not yet proved, and — where the operator configured hooks
  of their own — the provider's own hook review-and-trust prompt, which this host never
  answers or bypasses for you.
- To check a row's **title** by hand, in that same stage, use the provider's own naming
  and this host's own `E`. Do the two checks below on **two different rows**: a caption
  you typed permanently outranks the provider's title on the row it belongs to, so one
  row cannot show you both outcomes.
  - **The provider's own title, on an uncaptioned row.** Start a Claude row, name the
    conversation **inside the provider** with its `/rename`, and confirm the sidebar row
    takes that name. Then quit the host and start it again in the same stage: the restored
    row reads `Claude` at first, and once that run proves which conversation it is, the
    provider's own title returns **without** any new `/rename` — it is read from the
    transcript that run itself names, and never remembered as a name.
  - **Your caption, on a captioned row.** Press `E` on a row and type a caption of your
    own: it outranks the provider's title at once, and it survives every later `/rename`
    on that conversation **and** a conversation reset on that row, including a caption
    equal to the text the row was already showing. Restart the host on that same row and
    it comes back under your caption — a captioned row never visibly reverts to the
    provider's title, on a restart or at any other time.

  A row that stays on `Claude` is the honest outcome when the observer never proved the
  conversation or never reached its transcript, not a fallback name; and this host never
  renames anything inside the provider, so `/rename` in that walkthrough is always your
  own action in the provider.
- **No automated approvals.** Never try a provider's permission-bypass or
  approval-disabling flag to make a tryout easier; the host adds none, and the
  provider's own approval prompts are part of what you observe.
- Restarting the host in the same stage restores a remembered native row whose own
  run proved its conversation, through its backend's built-in default target, and
  shows any other remembered native row as `<Provider> (unavailable)`
  ([Restart restoration of native rows](#restart-restoration-of-native-rows)). Only
  the target's id is remembered; no executable, argument, or environment is stored,
  and the next New session still asks you to choose a kind.
- If your terminal implements OSC 52 clipboard writes, select and copy text in the
  provider the provider's own way and see whether your connecting terminal's
  clipboard changed. For a hosted Codex row this is exactly what the `HERDR_ENV=1`
  marker exists to make possible. On this host's own machine either path can produce
  that change — the provider's own native OS clipboard write, or the host's guarded
  outer-terminal OSC 52 forwarding when this host's own Main was the last input this
  row accepted — so the clipboard change alone does not tell the two apart; a
  terminal, multiplexer, or permission that declines clipboard writes simply
  discards the request.
- This stage proves startup, row ownership, input routing, resize, exit, and — if you
  did the title walkthrough above — a real provider rename reaching your own row on your
  own terminal. It does not certify the provider's own rendering, mouse, image, resume,
  approval, or platform behavior, and it is not Windows runtime evidence. The automated
  evidence behind this page is narrower still and different in kind: the Claude title
  and status paths are tested against synthetic transcripts this suite writes, and the
  Codex paths against this host's own private backend, so those tests cover no live
  Claude or Codex session, no account, no TUI, no physical terminal, and no
  provider-generated title.

This page documents the procedure only: it claims no completed run of it, and the
observations it lists are what to check, not reported results.

To clean up, quit the host, then remove the stage: `rm -rf "$STAGE"`. Because
`PI_CODING_AGENT_DIR` names the stage, the host's own first-run files — its roster and
ownership record, and the ordinary zero-model review-gate default it creates when none
exists — are written inside the stage and never in your live Pi agent directory. If you
did interact with a real provider, its own state directory holds whatever you chose to
create.

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
- The two Claude conversation-title fields behind
  [What a sidebar row shows](#what-a-sidebar-row-shows) — the custom title a conversation
  carries and the title the provider generated for it, the rule that the custom title
  outranks the generated one, and the fact that neither is a prompt, a summary, or a
  first line — were read in the session-summary fold of the
  [`@anthropic-ai/claude-agent-sdk`](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk)
  version this repository locks, together with the provider's own
  [session management](https://code.claude.com/docs/en/sessions) page for what `/rename`
  does. That is a pinned source reading, not observed provider behavior, and it carries
  the same moves-independently caveat as the items above.
