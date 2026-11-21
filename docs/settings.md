# Settings menu

This page owns the staged `/review-settings` settings menu: its fifteen ordinary rows,
the conditional **Scheduler runtime** row, Escape/Cancel/Save/Ctrl+S apply and
persistence semantics, and the shared native text-field behavior. It also owns the
sidebar's disk-only review-gate settings editor and how its exits differ from the
Pi-session menu's ([Sidebar review-gate settings](#sidebar-review-gate-settings-disk-only)).
Raw field values and defaults are owned by the [Configuration](configuration.md)
reference, and scheduled-task semantics are documented on
[Scheduled tasks](scheduled-tasks.md#scheduled-task-fields).

## `/review-settings`

`/review-settings` opens one staged settings transaction with fifteen ordinary
rows — Operating mode, Mode cycle hotkey, Worker resources, External workers,
Execution priority, Research priority, Reviewers, Timeouts, Review policy,
Retention, Global concurrency, Retry policy, Subtasks, Tools, and Scheduled
tasks — plus a conditional
**Scheduler runtime** row when the host runtime supplies the live switch (the
ordinary extension entry point always does):

- **Operating mode** stages the primary assistant posture; **Save changes** persists it
  ([Operating modes](configuration.md#operating-modes)).
- **Mode cycle hotkey** edits the `modeCycleShortcut` binding in the same staged
  transaction; a changed hotkey requires **Save changes** (or Ctrl+S), then
  `/reload`. Escape retains the edited value for later saving but does not
  change the currently registered binding; reloading before saving discards it
  ([Direct mode-cycle hotkey](configuration.md#direct-mode-cycle-hotkey)).
- **Worker resources** defines Pi-scoped models and execution-capable entries from
  `externalAgents`, each with one physical maximum concurrency shared by every
  background-task kind. The catalog displays alphabetically and edits by stable key —
  it has no reorder controls, because row order never defines identity or scheduling.
  Removing a resource that an enabled scheduled subtask pins (or making it unable to
  serve that entry) disables the entry when the change is applied: Save persists the
  disable, root Escape applies it for the session, and Cancel changes nothing. A local
  warning names each disabled entry; the pin is kept and no other worker is chosen.
- **External workers** sits immediately below **Worker resources** and lists
  every external-agent definition. Create and edit Claude Code/Codex CLI IDs,
  adapters, enabled roles, timeouts, and human-readable **Model**/**Reasoning**
  choices. The native editors offer no shared/role environment key/value editing
  or entry counts: environment variables are configured by editing the JSON file
  directly, where `env` remains a supported schema and runtime field, and Apply,
  rename, and unrelated staged edits preserve existing shared/role environment
  entries while the roles remain enabled. Custom/pinned models have a **Keep
  current** choice. Reasoning is model-specific: CLI default delegates to the
  CLI (not off); a role can inherit Shared or explicitly suppress it with CLI
  default. Max differs from Extra High (`xhigh`); Codex Ultra discloses
  automatic task delegation and appears only where supported. Unknown/alias
  models and Claude Haiku 4.5 offer only CLI default. Invalid effort or
  incompatible inheritance blocks Create/Apply until an explicit valid choice,
  never a silent fallback. Create/Apply sets `claude`/`codex` automatically,
  with fixed native protocols and no executable, literal argument-list, or
  protocol-override menus. Only that definition is normalized: legacy effort
  migrates, other advanced arguments/custom paths/protocol overrides are removed
  with scoped count/category warnings before staging; opening, Back/Cancel, or
  unrelated root Save leaves other entries alone. Renames migrate references
  without changing resource IDs or route order. Every supported editor has
  **Delete** beside **Apply**/**Cancel**, targeting the original identity
  despite unapplied edits; a new staged definition can also be deleted.
  Unsupported types offer only **Delete**/**Back**. Deletion reports reference
  cleanup, disables invalidated schedules, and resets only invalid pins or
  emptied review overrides to inheritance, with notice of defaults used on later
  re-enable. No creation/listing/editing enrolls workers or invokes providers.
  Root **Save changes** (or Ctrl+S) atomically persists the draft, **Cancel**
  discards it, and root Escape applies it to the running session only; missing
  native CLIs on `PATH` warn without blocking Save, including selected workers,
  and runtime failures remain errors. See
  [External worker management](configuration.md#manage-existing-external-workers)
  and [Native reasoning effort](configuration.md#native-reasoning-effort).
- **Execution priority** and **Research priority** are independently ordered
  subsets of those resources, referenced by key. Either route can exclude a
  resource; a missing or empty route means no models for that role. Per-route
  reasoning lets the same local model use different effort without creating a
  second capacity bucket.
- **Reviewers** opens the **Review** submenu: **Automatic primary review**,
  **Automatic subtask review**, and **Review landed changes** toggles, plus one
  multi-selection, `/scoped-models`-style reviewer picker per layer (**Primary
  reviewers** and **Subtask reviewers**) over the same Pi-scoped models plus
  review-capable entries from `externalAgents`. Each layer may be off. Saving a
  layer Off stops that layer's automatic review from that point on
  (already-running reviewer and executor processes finish with their launch
  values), while manual `/review-now` and `/ask-reviewer` stay usable with
  selected primary reviewers either way, and `/review-pause` remains unchanged.
  The landed-changes choice is inactive while automatic primary review is off.
  Clearing every reviewer for a layer is valid and disables that layer's
  automatic review without disabling delegated execution (a layer with no
  reviewers cannot run one). Each selected internal reviewer has its own
  **Reasoning** row per set. A legacy `review.activeReviewers` record displays
  in both sets immediately; see
  [Review layers](configuration.md#review-layers-and-the-legacy-activereviewers-import).
  **Evidence methods** in this same submenu selects evidence contexts
  independently of those toggles and reviewer sets; see
  [Evidence methods](#evidence-methods).
- **Timeouts** edits the default reviewer and executor timeouts in minutes.
  Explicit `review.timeoutMs` and `execution.timeoutMs` values on an
  `externalAgents` entry override these defaults for that external harness role.
- **Review policy** edits `maxCorrectionCycles` and
  `implementationGuidanceAfterCorrectionAttempts` as non-negative whole numbers.
- **Retention** groups **Bundle retention** (`never`, `on-failure`, or `always`,
  unchanged), **Wave artifact cleanup age**, and **Spawned Pi sessions**
  (**Retained** by default; select **Deleted on cleanup** to enable deletion).
  Opening the submenu shows its help notice: what each control governs, and the
  precedence that while **Bundle retention** is `always`, age-based wave
  collection stays suppressed whatever the threshold says — the configured age is
  kept and becomes effective again when retention is not `always`, and choosing
  `always` never changes it. In the Pi session that notice is the full text; in
  the sidebar it is the concise summary in the pane's single notice slot, which
  wraps and opens whole in the reader, so the explanation never depends on row
  width (the row itself marks the suppression after the age).
  **Wave artifact cleanup age** shows the existing `waveArtifactTtlMs` threshold
  with clear units — **30 days** by default, `7 days`, `6h`, `90m`, or `500ms`
  for custom values — and edits the same canonical field: enter a whole number of
  milliseconds or a whole number with an `ms`, `s`, `m`, `h`, or `d` suffix, or
  `0` to disable age-based collection. The field prefills the current duration in
  that same parseable spelling (`6h`, `30d`, `2500ms`, `0`), so reopening it shows
  six hours rather than a bare number. An empty, negative, fractional, or
  out-of-range entry is reported and the staged age stays as it was. Only an
  accepted edit makes the age part of the transaction: a Save that never touched
  it (or only changed the other Retention rows) leaves the latest on-disk
  threshold, including an absent key, exactly as it was, while an age applied
  session-only by root Escape still carries through to a later Save. Changing the
  age only stages it: nothing is collected by saving, and cleanup timing,
  artifact eligibility, and the recovery protections are unchanged. All three rows
  use the same Save/Ctrl+S, root-Escape apply, and Cancel transaction; switching
  sessions On does not itself delete anything. See
  [Configuration](configuration.md#top-level-fields).
- **Global concurrency** sets `execution.maxWorkers` (1–128, default 4). This is
  the session-wide worker ceiling shared by every group; each worker resource
  also has its own shared `maxConcurrent` capacity (1–128). These bound how many
  workers run at once, not how many tasks one `SubtasksStart`/`SubtasksAdd` call
  may submit or how many unsettled tasks an execution may hold — see
  [Worker resources, routes, and concurrency](delegated-execution.md#worker-resources-routes-and-concurrency).
- **Retry policy** (the menu titles this section **Executor retry policy**)
  configures bounded executor and worker candidate-review recovery: retry count,
  exponential-backoff bounds, jitter, and the repeated-incident guard. It
  governs executor retries and failover plus review-error retries for execute
  and in-place workers.
- **Subtasks** groups the three subtask notification and display controls under one
  submenu: **Subtask notifications** (**Quiet** by default), **Subtasks view** (the
  expanded/collapsed live-panel preference, stored globally), and **Subtask task IDs**
  (**Hidden**/**Shown** for the task-ID prefix on the live panel's subtask activity
  lines, **Hidden** by default). Each row keeps its previous label, default, and effect,
  and the whole submenu stages into the same Save, root-Escape, and Cancel transaction as
  the rows it replaces — only their grouping changed. See
  [Delegated execution](delegated-execution.md#notifications-and-ui). The task-ID switch
  is presentation only: the durable activity event, the task's identity in records and
  evidence, and every model-facing result keep the task ID unchanged.
- **Tools** opens the **Tools** submenu: two independent exact-name deny
  multi-selectors (**Top-level tools** and **Executor tools**, checked = denied)
  over the runtime's pre-deny candidate inventory, each with a live tool-name
  search field, plus the moved **Deferred Pi tools**, **YouShouldKnow notices**,
  **Completion guidance**, and **Web** controls, and the **Tool protection**
  group. Denials only narrow existing authority, and the two lists never cascade
  to each other. See [Tools subsection](#tools-subsection).
- **Scheduled tasks** opens the scheduled-task submenu (issue #26): one staged
  entry per independent scheduled task, keyed by its stable identity, with name,
  five-field Unix cron schedule in machine-local time, execute/research/inplace
  kind, schedule destination (**Subtask** — the default isolated scheduled
  subtask, or **Orchestrator turn** — see
  [Schedule destinations](scheduled-tasks.md#schedule-destinations)),
  instructions, explicit authorized workspace directory, an optional worker
  override picked from the worker-resource catalog (never from the global role
  routes; research-capable only for research tasks; unused for orchestrator
  turns), an optional task-local review choice (**Inherit global subtask review
  settings**, **Off — run this task's subtasks without review**, or a selected
  reviewer set; unused for orchestrator turns), and an enabled/disabled toggle.
  Each entry also has a **One shot** toggle (issue #306) and an **Already run**
  toggle, editable only while **One shot** is enabled (otherwise shown as not
  applicable). The scheduler sets it when execution actually starts — see
  [One-shot entries](scheduled-tasks.md#one-shot-entries). Adding prompts for a
  name and generates a stable identity; required-but-unset fields block Save
  with a named validation error. Entries stay visible and editable regardless of
  the **Scheduler runtime** switch, and saving never clears entries. See
  [Scheduled task fields](scheduled-tasks.md#scheduled-task-fields).
- **Scheduler runtime** (the conditional row, shown when the host runtime
  provides the switch; the ordinary extension entry point supplies it) is a
  live, current-process-only On/Off toggle for scheduled execution: it applies
  immediately, is never persisted in the config file, and stays outside the
  staged transaction — Escape, Save, and Cancel never set or revert it. See
  [Scheduled task fields](scheduled-tasks.md#settings-behavior-and-process-visibility).

The `/scheduled-tasks` command is a landing shortcut into this same transaction:
it opens the **Scheduled tasks** submenu immediately, and Esc or **Back** from
there returns to the settings root with the **Scheduled tasks** row highlighted
— the root's own retained-selection state. It introduces no second menu, state,
or save path — staged edits use the identical Save validation and persistence,
Cancel discards them, and root Escape applies them to the running session only,
exactly as for `/review-settings`.

Re-shown menus keep your position: after a staged change (a toggle, an add, a
move), the next display of the same menu highlights the row you last selected —
even when its label or position changed. In the interactive Pi TUI this renders
as the host's native selector list, preselected through its public component
API, so arrow keys, Enter, and Esc use Pi's supplied live keybindings manager,
including configured selection-key remaps. Compiled extension builds resolve
these TUI components from the running Pi installation when ordinary package-name
loading is unavailable. Hosts without a terminal UI (RPC/print) keep the plain
selector that opens at the first row; retention is TUI-only, with no GUI
planned.

In the interactive Pi TUI every text field opens as the host's own main-prompt
editor: the extension temporarily acquires that editor through Pi's public
`setEditorComponent` seam and embeds the same instance in the settings surface,
so the current value arrives as an editable prefill and all of the host's native
controls apply unmodified — Tab path completion for relative or `~/...` paths
(typing `docs/` + Tab opens the host's own selectable list of folders *and*
files; a single match is applied directly, exactly as in the chat editor), the
fd-backed `@` file picker, Ctrl+C clear, Ctrl+G external editing for long values
such as scheduled-task instructions, image paste, and Shift+Enter newlines. For
scheduled instructions, a native image paste is persisted durably at Save — and
at a session-only root Escape — into the private managed store described in
[Scheduled instruction images](scheduled-tasks.md#scheduled-instruction-images):
the pasted temporary path is validated by content, copied there, and replaced by
the managed absolute path before the config write. Save then writes the config;
root Escape makes the same validated copies but leaves the configuration file
untouched, so the session-only instructions keep working. Cancel copies nothing.
There is no second editor or clipboard surface; recognition for this persistence
stays bounded to Pi's clipboard temp naming and this config's own managed store
root. Field titles and key hints truncate to the available terminal-cell width,
including styled and wide text; fitting text stays unchanged. This affects only
those display rows, never the full editable value. Enter submits the field's own
text (never a chat message); Esc first dismisses a visible completion list, then
cancels the field, leaving the staged value unchanged. In Pi's fullscreen mode a
click inside any of these fields places the insertion caret where you clicked, so
the next typed or pasted edit lands there; it changes no text and submits nothing.
Clicking a visible completion suggestion applies it without submitting the field
(see
[Clicking editable text places the caret](session-host-alpha.md#clicking-editable-text-places-the-caret)).
Every editable field shares the same native absolute-path behavior (no per-field
opt-in remains): a
first-line token that starts with `/` and contains no space (`/`, `/se`, `/var`,
a nested absolute path) gets the host provider's own filesystem suggestions in
its ordinary file-list layout — never slash-command items, so a nonexistent
token such as `/subtasks` simply lists nothing instead of offering commands, and
no command can be offered or executed in any extension-owned field. No second
completer is involved: each field decorates only the host-provided autocomplete
provider through the public `setAutocompleteProvider` seam, forcing that
provider's own file branch for those tokens and masking the returned prefix's
leading slash with a same-length neutral sentinel so the editor renders the file
list (not the two-column command layout) and applies a path (never `/command `
text). The main chat prompt itself is untouched: a line starting with `/` there
keeps the host editor's ordinary slash-command context. Everything else is
unchanged: relative paths, `~/...`, the fd-backed `@` picker, Ctrl+C clear,
Ctrl+G external editing, image paste, Shift+Enter newlines,
Esc-dismisses-the-list-first, and the chat draft all behave exactly as in the
shared main-chat editor. This shared behavior covers every `/review-settings`
field, every other extension-owned interactive text field — the staged subtask
form (title, instructions, acceptance criteria, relevant context, target
workspace), the no-argument steering instruction, and the private reviewer
answer editor — and the AskUserQuestion free-text answers. Token recognition,
relative/`~` handling, platform behavior, the list UI, and selection keys are
inherited from the host as-is, so no universal absolute-path or Windows support
is claimed. Two host behaviors are not preserved for absolute-path tokens
through this public seam: a first Tab never auto-applies a single match (the
list shows instead; after Esc, Tab reopens it and a further Tab selects the
highlighted entry), and best-match preselection does not apply within an
absolute-path list (the first entry is highlighted; arrow keys navigate). A
space ends the token and returns that position to the host's own completion
behavior. An interactive host missing the required native seams fails closed
with an error notice instead of presenting a non-parity fallback field.
Completion is a convenience — Save validates the workspace against the same
session working directory used for relative completion and dispatch, and rejects
nonexistent or non-directory targets, including a file selected from the list.
Non-interactive hosts (RPC/print) keep their clearly identified chain: Pi's
public editor with the current value as an editable prefill first, then the
legacy single-line input with its placeholder semantics; a host offering neither
seam reports an error instead of staging anything. The cron field shows a
compact heading above its editable prefilled text mapping all five fields in
order (minute, hour, day-of-month, month, day-of-week), stating machine-local
time and `* * * * * = every minute`.

Escape from a submenu returns to the settings root; nested Escape/**Back**
navigation is unchanged, and a running review is never part of it: while any
settings screen holds the foreground — a menu, submenu, reviewer or model choice
list, the searchable tool picker, a text field, or a settings confirmation
dialog such as the one that gates enabling browser YOLO — Escape belongs to that
screen alone, so the review underneath is not cancelled, its reviewers are not
stopped, and its captured inputs and eventual verdict are unchanged. Declining
such a confirmation changes nothing about the setting it guards. Closing the
menu never waits for that review. With no settings screen in the foreground, a
separate Escape press keeps its ordinary review-cancellation meaning (see
[Cancellation](review-workflow.md#cancellation)). The root has three distinct
exits:

- **Escape** applies the edited choices to the running session in memory only,
  using the same validation and image handling as a save, and never writes the
  configuration file. The choices stay in effect for the current session; a
  later `/reload` re-reads the file and may discard them.
- **Cancel** discards every edit made in this menu and restores the live
  settings that were in effect when it opened — including session-only choices
  applied by an earlier Escape. It copies no images.
- **Save changes** and Ctrl+S are equivalent: both apply the active edited
  choices and atomically persist every section while preserving unrelated JSON
  keys. Ctrl+S works from any settings submenu, not only the root. Finish typed
  fields and unfinished external-worker Create/Edit forms first; Ctrl+S does not
  interrupt them.

Because Escape applies in memory, reopening `/review-settings` shows those choices and
an immediate **Save changes** or Ctrl+S persists them without re-entering them.

Except for the captured worker evidence policy described under
[Evidence methods](#evidence-methods), applied values (session-only or saved)
are authoritative for execution stages that have not started. Already-running
executor and reviewer processes finish with their launch values, while queued
dispatch, waiting failover, later continuation turns, and later review cycles
use the current routes, capacities, policies, and reviewer selection. Open
review windows reconcile to the new reviewer selection immediately on apply: the
preserved baseline, evidence, and completed history are unchanged, a review
already in flight finishes under its original selection, and later reviews use
the new one (a window frozen with no usable reviewers becomes reviewable as soon
as its settings are fixed). Subtask notification mode is a delivery preference
and takes effect immediately for subsequent events from already-running tasks.
Running capacity leases survive pool edits; removed entries receive no new work.
A restarted task warns when its prior runtime configuration differs, and an
executor-selection change starts a fresh native session from the durable
checkpoint instead of attaching an incompatible conversation.

## Evidence methods

Open `/review-settings` → **Reviewers** → **Evidence methods**. The four rows are:

- **Primary / top-level**
- **Isolated worktree**
- **InPlace**
- **Snapshot-failure fallback**

Each scope row defaults to **Tools + workspace changes**; Enter cycles between
that and **Tools only**. “Workspace changes” means whole-workspace snapshot/diff
**review evidence**. Both methods retain bounded tool calls/results, observed
file content and per-file tool-observation diffs, task/assistant context, and
reviewer read access.
Mandatory construction, checkpoint, and landing verification is unchanged. These
rows select evidence for that context, not the operating mode, whether review
runs, or who reviews. **Snapshot-failure fallback** remains a separate **Off** /
**On** choice (default **On**) for qualifying review-evidence capture failures,
not a fourth execution context. The stored fields are documented in
[Configuration](configuration.md#review-evidence-methods).

Enter stages a choice. Back and nested Escape only navigate; they neither apply the
policy nor reset evidence. Root Escape applies the final draft to the running session
without writing the config. **Save changes** or Ctrl+S applies and persists it; Ctrl+S
also works in this nested menu. Explicit root **Cancel** discards this visit's draft
and preserves the live values from when it opened, including any session-only values
applied by an earlier Escape. Reopening and saving can persist those earlier values.

Primary transitions are based on the effective value before and after apply, not
how many times a row was visited or toggled:

| Effective Primary transition | Effect |
| --- | --- |
| Tools + workspace changes → Tools only | Clears accumulated Primary review evidence and starts a new Tools only evidence window. A prominent warning identifies the actual reset; earlier work is not certified by resetting. |
| Tools only → Tools + workspace changes | Retains accumulated evidence and establishes a new snapshot baseline for subsequent capture, without inventing earlier snapshot coverage. |
| Unchanged | No evidence reset. |

Selecting **Tools only** for Primary in the draft warns about the pending reset,
but navigation or Cancel never performs it. Changing only worktree, InPlace, or
fallback settings does not reset Primary evidence. A draft toggled back to its
original value has no effective transition, so applying it does not reset
evidence either.

Workers capture the applicable evidence choices, including fallback, at firing/queue
admission. Each new `SubtasksStart`/`SubtasksAdd` task and human submission captures
independently; scheduled subtasks capture at actual firing/admission, not schedule
creation. Already queued or running tasks keep that policy through corrections,
retries, and continuations; later Add tasks capture the then-current live choice.
Applying settings does not intercept or reconfigure in-flight tasks. This guarantee
is specific to evidence policy; it does not freeze all routing or reviewer settings.

With fallback Off, an eligible Primary baseline failure warns that review is
disabled and the turn continues unreviewed; other capture failures still block
([details](review-workflow.md#snapshot-failure-fallback)). When On actually
substitutes current retained tool evidence for an eligible failed snapshot, a
prominent warning identifies the originating review context, and the reviewer
receives the truthful **Tools only (snapshot-failure fallback)** basis. For
Primary the warning is a local user-only notice, never a model message or turn,
and the fallback makes Primary act as **Tools only** for the rest of the session
without capture retries. That session state is not a menu value and is never
saved; `/review-clear` or a new session lets the next prompt try the configured
snapshot preference again. Worker fallback is not sticky: captured
snapshot-preferring worker policy retries capture on later cycles/continuations,
warning to the worker's implementing model each time, without inventing earlier
coverage or discarding retained current-work tool evidence. The menu description
or an optional notice alone is not that warning. Missing structured observations
do not block degraded review; retained evidence and capture limits remain
disclosed. See [Review workflow](review-workflow.md#snapshot-failure-fallback)
for first-baseline eligibility and failures that must remain blocking.

## Tools subsection

The **Tools** row opens one submenu that owns the scoped deny selectors and the
four controls moved out of the root — **Deferred Pi tools**, **YouShouldKnow
notices**, **Completion guidance**, and **Web** — plus each control's existing
submenus and the **Tool protection** group. It introduces no second menu, state,
or save path: everything here is staged into the same `/review-settings`
transaction. **Save changes** and Ctrl+S persist the whole draft atomically,
**Cancel** discards it, and root Escape applies it to the running session only,
exactly as for every other row. In the TUI, Enter opens the highlighted row;
Enter in a tool picker — either deny selector or the audit-name selector —
toggles the highlighted tool; **Back** and Escape return to the immediate parent
(the Tools root from a deny selector, the Tool protection submenu from the
audit-name selector); Escape from the Tools root returns to the
`/review-settings` root.

### Scoped tool denial

- **Top-level tools** and **Executor tools** are two independent multi-selectors
over the same candidate inventory. Rows are the runtime's pre-deny,
otherwise-discoverable tool names other than the reserved `tool_search` loader
(see below) — rendering them neither activates nor authorizes anything.
Enter toggles the selected row; a checked row means **denied**, the opposite of
the reviewer picker's allowed marker.
- **Both deny pickers have a live search field.** In the TUI, a query line sits
above the rows: type part of a tool name to narrow the list as you type, move
through the matches with the arrow keys, and press Enter to toggle the
highlighted row. Navigation, confirm, and cancel follow your `tui.select.*`
keybindings. The query uses the same grammar as the sidebar's saved-conversation
picker: whitespace-separated fuzzy tokens, `"quoted phrases"`, and
`re:<pattern>`; every term must match. Only tool names are searched, never
descriptions, and matching stays single-text: a term may match as a scattered
subsequence of the tool name, and matches are ordered by that one-text score.
The saved-conversation picker's per-field matching and its name / ID / message /
workspace tier ordering do not apply here. A query that matches nothing shows
**No matching tools** and the picker stays open and editable, with **Back** and
Escape still available. The query is view state only: it never changes what is
denied, a denial hidden by the query stays denied and is applied or saved with
the whole draft, and the query is never stored. Each picker keeps its own query,
and a non-TUI (RPC) host offers the plain, unfiltered list. On terminals that
report held-key repeats, a held Enter, Escape, or Ctrl+S acts only once.
- The lists are independent. A top-level-only denial leaves the tool eligible
for a newly captured executor; an executor-only denial leaves the primary
eligible. With both checked the name is excluded from both; with neither it is
unchanged.
- A saved denial that the live inventory no longer offers stays a row marked
`[not currently available]`, in whatever checked/unchecked state you last
staged, for the whole menu session — including after Back and re-entry.
Unchecking it does not delete the row, and a denied name is never silently
converted into an allowed one just because the live catalog changed.
- Denials are exact literal names, never patterns, prefixes, or globs. They are stored
as `tools.topLevelDeny` and `tools.executorDeny`; each defaults to an empty list and
denies nothing. See [Tool denial fields](configuration.md#tool-denial-fields) and
[Scoped tool denial](native-pi-tools.md#scoped-tool-denial-top-level-and-executor).
- **`tool_search` is reserved and never selectable.** Both pickers offer every
otherwise-discoverable tool except `tool_search` itself: the loader is never a
row, so retained rows, choices, and counts never present it as selectable. A raw
`tool_search` entry in a staged or saved list is rejected — an explicit write
fails strict validation, and startup recovery warns and omits the entry — so it
can never be denied.
- Denials only narrow. Pi's own `--tools`/`--exclude-tools`/`--no-tools`, the
operating mode, the launch/role ceilings, and the existing feature settings stay
authoritative; unchecking a denial restores only that tool's ordinary
eligibility and never grants authority another control withheld. The lists
disable no plugin, sandbox no effect, and add no wildcard policy.
- **Top-level timing.** Applying the staged draft (Save, Ctrl+S, or root Escape)
makes the new top-level denials effective at the next applicable model set
write; an in-flight run is not interrupted and no `/reload` is required.
Executor denials apply to new execute/inplace admissions through the shared
`SubtasksStart`/`SubtasksAdd`, scheduled-task, and human paths. Research tasks
are unaffected, and a research role never gains a denied name or loses one it
already had. A catalog is captured at admission: already-admitted queued or
running tasks, and their later continuation turns, retain the authority captured
at launch.
- **Metadata visibility is bounded, not eliminated.** Pi itself is unchanged: a
denied name can remain part of Pi's own native callable metadata, so codemode
and other wrapper scripts may still observe it through `ctx.tools`, and an
active codemode description may list codemode-exposure tools. That metadata is
not always in context — deferred tool metadata is generally returned only by
explicit queries such as `ALL_TOOLS`, `searchTools`, or `describeTool`, and
earlier transcript entries keep names recorded before a denial. Normal tool
declarations, the startup inventory, and review-gate's `tool_search` omit denied
names. The guarantee is that a denied call never executes — by direct, nested,
codemode, or wrapper path. The scoped settings explanation is added where the
host establishes the cause: a call refused at the `tool_call` admission check, a
direct call clarified at Pi's `message_end` seam, or a nested call Pi recorded
on the wrapper's tool result. A delegated executor omission is explained from
that task's fixed captured catalog (plus Pi's record where the call failed
before admission) instead, never by re-reading the current deny configuration.
An early native rejection that leaves no recorded invocation — codemode's own
proxy refusing a non-callable direct-exposure member before `ctx.executeTool`
runs, for example — keeps Pi's own truthful error instead, with no settings
attribution and still no executed side effect.

### Tool protection

- **Tool protection** opens the controls for the pre-execution decision gate:
  one shared Protection level (**Off**, **Dangerous**, **Aligned**, or
  **Workspace**), one auditor selection from the same Pi and external sources,
  an `all` or exact-name `selected` audit scope, the decision timeout, the
  context budget, and **Debug audit output**. Off is the default and removes
  only this added gate; there is no separate enable toggle. See
  [Tool protection](tool-protection.md) and the raw
  [field reference](configuration.md#tool-protection-fields).
- **Save auditor sessions** is Off by default and controls only whether each
  auditor invocation is also saved as an ordinary Pi session you can browse
  later. Turning it on asks for confirmation first, because it starts writing
  records that contain the exact auditor request; turning it off needs no
  confirmation. Nothing is written while it is Off. See
  [Keeping auditor sessions](tool-protection.md#keeping-auditor-sessions-optional).
- **Debug audit output** is Off by default and changes only whether this gate's
  routine `PASS` and `NOT AUDITED` audit lines are shown to you. With it On you
  get the themed status line, with the level and audit elapsed time for a `PASS`
  but no PASS reason; `NOT AUDITED` keeps its exemption diagnostic without an
  invented audit duration. It adds nothing to what the acting model receives for
  a call the gate did not stop, records nothing, contacts no model or provider,
  and changes no level, scope, or decision; a `FAIL`, an audit error, and a
  nested refusal stay reported at either value, and an auditor-session save
  warning stays visible to you. It is independent of **Save auditor sessions**
  and is staged by this page's transaction like every other row, then pinned for
  newly launched Pi executors with the rest of the settings. See
  [What each call reports](tool-protection.md#what-each-call-reports).
- **Selected tool names** is chosen in the same searchable multi-select as the
  deny pickers, with the opposite checked meaning: a tool-name query sits above
  the rows, one row is one tool, Enter toggles it, and a checked row means
  **audited** — never denied. Only tool names are searched, a query hides rows
  without changing what is audited, and each picker keeps its own transient
  query. The list is exact names only: there is no typed or comma-separated name
  entry, so a raw configured name is retained rather than silently dropped. The
  reserved `tool_search` loader is never an audited candidate — it is the
  discovery infrastructure this gate never audits, so its row states
  `· never audited — discovery loader`, cannot be checked, and is excluded from
  the audited count, while the deny pickers still never offer it at all. An
  audit name the live inventory does not offer stays a reversible
  `[not currently available]` row. Entering this scope with no established audit
  list starts with **every** currently offered auditable name checked, so you
  uncheck the exemptions instead of checking each tool, while a saved or
  previously chosen subset is never re-checked for you. Leaving the picker with
  nothing auditable checked changes nothing: `selected` requires at least one
  exact name, and **All calls** or **Off** stay the ways to widen or stop the
  gate.
- The group uses this page's staged transaction: root Escape applies
  session-only, **Save changes**/Ctrl+S persists, and **Cancel** discards.
  Opening it and changing values invokes no provider and launches no auditor; a
  saved selection is not a connection test.
- Enabling a non-Off level or changing the auditor warns that the selected boundary
  receives context within the configured budget: proposed tool name and arguments
  first, then session evidence newest-first, then governing instructions and other
  reference material. Fixed auditor instructions are separate from that budget.
- An external auditor reference that no longer resolves is preserved and reported as
  unavailable; the menu does not silently rewrite it to Off or choose another auditor.
- Coverage is Pi admission only. Non-Pi acting workers — Codex, Claude, and
  generic binary executors — are out of scope for this added gate today: no
  Protection level refuses, audits, or pins their launches, whatever the auditor
  selection. The gate is not an OS sandbox and does not cover other harnesses;
  see [Limits and non-goals](tool-protection.md#limits-and-non-goals).

### Moved controls

The four moved rows keep their labels, stored keys, defaults, and behavior; only
their location and the root **Tools** row summary change.

- **Deferred Pi tools** defaults to **On**. Saving **Off** immediately exposes
  every authorized tool in the current top-level Pi session; saving **On**
  immediately restores the conservative active subset plus `tool_search`. For
  new mutation-authorized sessions/tasks, `write` starts active alongside `edit`
  and `ApplyPatch`; planning still hides it, explicit exclusions still apply,
  and previously captured worker catalogs retain their recorded initial subsets.
  The conservative subset always includes launch-authorized native read-only
  discovery (`grep`, `find`, `ls`), so discovery needs no deferred activation in
  any mode, including delegated subtasks. Newly launched Pi subtasks use the
  saved value, while already-running subtask sessions keep their launch
  behavior.
- **YouShouldKnow notices** defaults to **On** and controls new notice availability
  within the existing launch, role, mode, and call authorization limits. Turning it
  off immediately removes the tool from the active/discovery surfaces but leaves any
  pending notice and its More details/Close actions intact; `AskUserQuestion` is
  unchanged.
- **Completion guidance** defaults to **On** and allows an automatic prompt
  pointing to the shipped completion skill only when notice availability is also
  On and the current live authorized discovery ceiling includes `YouShouldKnow`
  (whether or not it is currently activated). Turning guidance off removes that
  prompt only: it does not disable notice availability or block
  otherwise-authorized calls. The skill opts out of Pi's automatic model-invoked
  skill list but remains manually available as
  `/skill:pi-review-gate-completion`; toggling this setting does not edit Pi's
  native settings or uninstall the skill. See
  [Availability and completion guidance](user-questions.md#availability-and-completion-guidance).
- **Web** includes maximum acquisition size, the **URL blocklist** — one
  JavaScript regular-expression source per line, surrounding whitespace on each
  line trimmed (write a space you really want as regex syntax, such as
  `final\x20test` or `final[ ]test`), blank lines ignored, an invalid expression
  reported instead of staged, and an empty list blocking nothing — and **Browser
  interaction approval**: **Ask**, **Automatically Accept**, or **Automatically
  Deny**. Ask prompts when approval is required and rejects without UI; Accept
  supplies automatic approval without prompting; Deny rejects the
  approval-required branch. Already-permitted observations and structurally
  proven local actions remain permitted in every mode. Saves apply immediately
  to subsequent local approval decisions and acquisitions without restarting;
  saving a changed URL blocklist applies it to `WebFetch` and `BrowserExtract`
  together and discards cached acquisitions, while saving an unchanged list
  leaves the cache intact. Newly launched Pi workers load the saved policy;
  running workers keep the configuration loaded at launch. Research roles still
  cannot click or use form-action tools. It also opens the **Browser
  permissions** submenu (#27) with the independently selectable capability
  toggles — model credential entry and submission, uploads, download saving,
  clipboard read/write, camera, microphone, geolocation, service workers, popup
  restriction override, local networks (human and model), and
  **YOLO / allow everything** — each staged like every other section and
  persisted with **Save changes**. Enabling a capability presents its
  risk-appropriate notice; enabling YOLO additionally requires an explicit
  interactive confirmation after a prominent warning (cancellation or an
  unavailable dialog leaves it off), shows the enabled state prominently on the
  Tools → Web row, and disables straightforwardly with the saved individual
  values restored as effective. Every capability is enforced: credential entry
  and submission, uploads, download saving, and clipboard read/write by the
  interactive-browser tool actions; camera, microphone, and geolocation as
  per-origin device permission grants issued on navigation commits and cleared
  live on disable (an unconfirmable engine clear fails the affected session
  closed); service workers at browser launch, with a controlled replacement of
  the live browser when the saved policy changes; the popup restriction override
  while enabled; and local networks at the interactive egress broker. Saved
  changes apply to the live session without a restart; see
  [Web fields](configuration.md#web-fields). The row is reached through
  `/review-settings` → **Tools** → **Web**; its stored `web.*` keys, defaults,
  and behavior are unchanged by the move.

## Sidebar review-gate settings (disk-only)

The `pi-review-sessions` sidebar carries its own review-gate settings editor for the **local
host's saved configuration**: the same file a local Pi session loads at startup, through the
same field definitions, validation, and persistence path as `/review-settings` — no second
format, and no separate file that local launches ignore. Raw keys and defaults stay owned by
[Configuration](configuration.md). It is configuration-only, not a second live review-gate
instance: opening it starts no hidden Pi session and holds no effective in-memory configuration.

It covers the **fifteen persisted sections** enumerated at the top of this page, with the same
shared menu behavior and validation — searchable tool pickers and external-worker Create/Edit
forms included — and existing model, reasoning, worker, route, reviewer, and scheduled-task
entries survive a save under the shared path's existing normalization and unrelated-key
protections. The **Scheduler runtime** switch stays out: it is live, process-only, never persisted.

- **Every open re-reads disk** — never a selected session's live settings and never a stale
  sidebar snapshot — so another legitimate editor's change (a Pi session's **Save changes**,
  or a direct edit of that file) shows up on the next open.
- **Edits stay a menu-local draft**: toggling, typing, adding, deleting, or reordering stages
  values inside that one open menu, writing nothing and applying nothing to any running
  session, so reopening shows the on-disk values again rather than a discarded draft.
- **Save** (or Ctrl+S) is the only write: it validates the whole draft with the shared rules, then
  atomically persists every section, preserving unrelated JSON keys and existing protections.
- **First use creates nothing.** With no configuration file present the menu shows the ordinary
  zero-model defaults, and opening or cancelling leaves no file behind; that first explicit
  **Save** creates the canonical implicit file through the existing guarded initializer. An
  existing primary or compatibility fallback is never initialized over, and an explicit
  `PI_REVIEW_GATE_CONFIG` naming a missing file stays an error and is never created.
- **Cancel, root Escape, and closing the editor discard the draft.** The sidebar's root
  Escape applies nothing: the file and every running session stay as they were; nested
  **Back** only navigates and keeps this visit's draft staged.
- **Pi model choices need models already scoped in Pi.** The model, reasoning, reviewer, and
  worker-resource pickers list only the models Pi itself scopes — the host's forwarded
  `--models` when present, otherwise Pi's global `enabledModels`. Patterns match Pi's built-in
  models, `models.json`, and the provider catalogs Pi has already saved in the same agent
  directory (`models-store.json`, such as newer Codex models). When the model scope is nonempty,
  the editor reads that catalog read-only on each open, without network refresh, sign-in, or
  credential use. Models available only from a saved catalog are omitted when Pi has not saved a
  usable entry for them; a real Pi session may refresh a missing or stale catalog (older than
  Pi's bundled data), but the editor also requires `models-store.json` itself to be a readable,
  well-formed regular file — a symlink is declined however fresh its target. This editor never
  scopes a model and never writes Pi's own configuration, so on a host with nothing scoped yet it offers
  no Pi model choices and says so in one non-blocking notice. The way to get choices is Pi's own
  setup: start a real Pi session — the sidebar's **New session** works, and review and subtasks
  may stay unset for that setup session — configure Pi's base settings and scoped models there,
  then reopen this editor. A sidebar first-run flow that did all of that without a Pi session is
  separate future work ([#719](https://github.com/rfairburn/pi-review-gate/issues/719)), not
  implemented and not implied by anything here.

The Pi-session exits above are unchanged: root Escape there still applies the draft to the
running session in memory only, **Cancel** still restores the values live when that menu opened,
and **Save changes**/Ctrl+S still persists and applies.

### What a sidebar Save affects

Saved values are what **new local Pi instances** load at their own startup — a sidebar **New
session** or a `SessionSpawn` child, another workspace included — and that saved file is the
child's default, never a running parent's live in-memory settings. Nothing already running is
reconfigured or restarted: every running instance, delegated executor, and reviewer keeps its
**current effective configuration** — including session-only values an earlier root Escape
applied — plus its active review and pending work. Explicit launch arguments and each session's
role and authorization boundaries are unchanged, reading the saved defaults grants nothing, and
native **Claude Code** and **Codex CLI** rows keep reading their own provider configuration.

### Scope and boundaries

- **Local host only.** The editor reads and writes this host's own configuration file even
  while a remote sidebar row is selected or viewed, and never writes another machine's
  settings; editing a remote host's configuration is separate follow-up work.
- **Persisted settings only.** Process-only controls are neither offered nor saved here, so they
  never become saved defaults or live controls; Pi's own settings, authentication, models,
  keybindings, and extensions and the sidebar's own Theme, Network, and Host shortcuts are
  untouched.
- **Tool-name lists are configuration-only metadata.** The deny and audit pickers build their
  inventory from the shared registration constants and known local Pi tool metadata, never from
  a live session: a listed name proves nothing about provider authentication, availability, or
  permission; registrations that exist only inside a live session (custom or MCP tools) are not
  discovered; and an unknown saved name stays a retained `[not currently available]` row.
- **Text fields use the sidebar's own shared host text field**, the one its New-session and rename
  forms already use, so its host-owned behavior — including Ctrl+G external editing through the
  host's configured editor command — applies here. Behaviors needing Pi's own editor callbacks
  (image-paste provenance, the `@` picker) are not claimed, and no mouse behavior is added.
- **Lists follow the pane's height.** Menus and pickers show as many rows as the sidebar pane
  fits — more than a Pi popup's ten when there is room, fewer with the usual scroll position in a
  short pane — below the notice, which is drawn whole when the list still fits beside it and
  otherwise takes up to half of the rows below the header. Selection, keys, the
  tool-search query, and Save/Cancel behave as before, and a pane too short for the title, hints,
  and one row shows that it is too small instead. In-Pi `/review-settings` popups keep ten rows.
- **One notice at a time.** Below the **Review settings (local)** header the pane shows a single
  notice, never a growing history. Outside a section with its own help it is the LOCAL target notice
  (including the first-use **Save** creates / **Cancel** leaves it absent wording). **Reviewers** →
  **Review** and its **Evidence methods** show a short summary instead of the in-Pi description;
  the full details are under **Reviewers** in [`/review-settings`](#review-settings), in
  [Review layers](configuration.md#review-layers-and-the-legacy-activereviewers-import), and in
  [Evidence methods](#evidence-methods). The result of the latest action — a warning, an error such
  as a failed **Save** validation, or an informational result — replaces it on the next screen,
  error over warning over info, and clears once a later action opens another screen; opening
  diagnostics are the first screen's result in the same way, so saved tool-protection settings
  that do not load (an error: protected calls stay blocked) outrank a config-load warning, which
  outranks routine model-catalog guidance. Notices, including long opening diagnostics, are never
  shortened: when the pane has room a
  notice such as the **Browser permissions** or **URL blocklist** description is drawn whole. In a
  pane too short for it beside a usable list or field, its first rows end with
  `... ctrl+o read all`; when no notice row is left, the cue joins the pane's header (or footer)
  so no menu entry or field row is lost. When Ctrl+O is a host shortcut or bound to a settings key,
  the cue names the first free key of F2 through F8 instead, so it never takes a configured action;
  if all of them are bound, it names the return-to-Main chord (Alt+Right by default), which does
  nothing else in these panes and reads the notice only while the cue is shown. That key
  opens a read-only reader of the whole notice in the same pane: up/down and Page Up/Page Down
  scroll it, it shows which lines are in view, and Escape (or the same key) returns to the
  unchanged screen or field. The reader takes no other action, so Enter, Ctrl+S, typed text, and
  pasted text do nothing while it is open. After it closes, no key or paste (including one begun
  inside the reader) acts until the screen or field has actually been written to the terminal again, a key still held from the reader (such as a held Enter) never repeats
  into it until that key is pressed afresh, and a confirming action still needs a freshly written
  screen. If the pane became too small while the reader was open, Back shows the too-small pane
  with `esc back`; once that is written, Escape there cancels as it would on the screen or field,
  and no other key acts. A confirmation's disclosure (such as **Save auditor sessions**) is that screen's
  one notice, drawn whole with its choices regardless of length, and **Yes** is accepted only from
  a frame that shows it whole. When the pane is too short for both (for example an auditor
  confirmation listing a very long selected tool-name scope), the pane draws no choice: it shows
  the start of the disclosure, says to enlarge the pane to answer, and the reader shows the rest.
  Reading it there (or seeing a too-small pane) never accepts **Yes**, and Enter, Ctrl+S, or arrow keys there change nothing:
  the pane keeps showing the disclosure and its reader cue, and the choice shown once the pane is
  large enough is the one that was selected before. Escape answers No without closing the editor, and so do
  configured Cancel keys that reach the pane. A result that ends the editor is shown as its one
  notice in **Settings**, which always keeps every entry and offers the same reader when the
  result does not fit. Text fields show the same single result or their own field message; a
  rejected input's error clears once the field accepts a changed value. In-Pi `/review-settings`
  keeps its full section descriptions as ordinary notifications.
