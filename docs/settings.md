# Settings menu

This page owns the staged `/review-settings` settings menu: its sixteen ordinary rows,
the conditional **Scheduler runtime** row, Save/Cancel staging and apply semantics, and
the shared native text-field behavior. Raw field values and defaults are owned by the
[Configuration](configuration.md) reference, and scheduled-task semantics are documented
on [Scheduled tasks](scheduled-tasks.md#scheduled-task-fields).

## `/review-settings`

`/review-settings` opens one staged settings transaction with sixteen ordinary rows —
Operating mode, Mode cycle hotkey, Worker resources, Execution priority, Research
priority, Reviewers, Timeouts, Review policy, Bundle retention, Global concurrency,
Retry policy, Subtask notifications, Deferred Pi tools, Subtasks view, Scheduled
tasks, and Web — plus a conditional **Scheduler runtime** row when the host runtime
supplies the live switch (the ordinary extension entry point always does):

- **Operating mode** stages the primary assistant posture; **Save changes** persists it
  ([Operating modes](configuration.md#operating-modes)).
- **Mode cycle hotkey** edits the `modeCycleShortcut` binding in the same staged
  transaction; a changed hotkey takes effect after `/reload`
  ([Direct mode-cycle hotkey](configuration.md#direct-mode-cycle-hotkey)).
- **Worker resources** defines Pi-scoped models and execution-capable entries from
  `externalAgents`, each with one physical maximum concurrency shared by every
  background-task kind. The catalog displays alphabetically and edits by stable key —
  it has no reorder controls, because row order never defines identity or scheduling.
- **Execution priority** and **Research priority** are independently ordered subsets of
  those resources, referenced by key. Either route can exclude a resource; a missing or
  empty route means no models for that role. Per-route reasoning lets the same local
  model use different effort without creating a second capacity bucket.
- **Reviewers** opens the **Review** submenu: **Automatic primary review**,
  **Automatic subtask review**, and **Review landed changes** toggles, plus one
  multi-selection, `/scoped-models`-style reviewer picker per layer (**Primary
  reviewers** and **Subtask reviewers**) over the same Pi-scoped models plus
  review-capable entries from `externalAgents`. Each layer may be off. Saving a layer
  Off stops that layer's automatic review from that point on (already-running reviewer
  and executor processes finish with their launch values), while manual `/review-now`
  and `/ask-reviewer` stay usable with selected primary reviewers either way, and
  `/review-pause` remains unchanged. The landed-changes choice is inactive while
  automatic primary review is off. Clearing every reviewer for a layer is valid and
  disables that layer's automatic review without disabling delegated execution (a
  layer with no reviewers cannot run
  one). Each selected internal reviewer has its own **Reasoning** row per set. A legacy
  `review.activeReviewers` record displays in both
  sets immediately; see
  [Review layers](configuration.md#review-layers-and-the-legacy-activereviewers-import).
- **Timeouts** edits the default reviewer and executor timeouts in minutes. Explicit
  `review.timeoutMs` and `execution.timeoutMs` values on an `externalAgents` entry
  override these defaults for that external harness role.
- **Review policy** edits `maxCorrectionCycles` and
  `implementationGuidanceAfterCorrectionAttempts` as non-negative whole numbers.
- **Bundle retention** selects `never`, `on-failure`, or `always`.
- **Global concurrency** sets `execution.maxWorkers` (1–16, default 4). This is the
  total worker ceiling; each worker resource also has its own shared `maxConcurrent`
  capacity.
- **Retry policy** configures bounded executor/reviewer recovery: retry count,
  exponential-backoff bounds, jitter, and the repeated-incident guard.
- **Subtask notifications** defaults to **Quiet**. See
  [Delegated execution](delegated-execution.md#notifications-and-ui).
- **Deferred Pi tools** defaults to **On**. Saving **Off** immediately exposes every
  authorized tool in the current top-level Pi session; saving **On** immediately restores
  the conservative active subset plus `tool_search`. For new mutation-authorized
  sessions/tasks, `write` starts active alongside `edit` and `ApplyPatch`; planning
  still hides it, explicit exclusions still apply, and previously captured worker
  catalogs retain their recorded initial subsets. The conservative subset always
  includes launch-authorized native read-only discovery (`grep`, `find`, `ls`), so
  discovery needs no deferred activation in any mode, including delegated subtasks.
  Newly launched Pi subtasks use the saved value, while already-running subtask
  sessions keep their launch behavior.
- **Subtasks view** stores the expanded/collapsed live-panel preference globally.
- **Scheduled tasks** opens the scheduled-task submenu (issue #26): one staged entry
  per independent scheduled task, keyed by its stable identity, with name,
  five-field Unix cron schedule in machine-local time, execute/research/inplace kind,
  schedule destination (**Subtask** — the default isolated scheduled subtask, or
  **Orchestrator turn** — see [Schedule destinations](scheduled-tasks.md#schedule-destinations)),
  instructions, explicit authorized workspace directory, an optional worker
  override picked from the worker-resource catalog (never from the global role
  routes; research-capable only for research tasks; unused for orchestrator
  turns), an optional task-local review choice (**Inherit global subtask review
  settings**, **Off — run this task's subtasks without review**, or a selected
  reviewer set; unused for orchestrator turns), and an enabled/disabled toggle.
  Adding prompts for a name and generates a stable identity; required-but-unset
  fields block Save with a named validation error. Entries stay visible and
  editable regardless of the **Scheduler runtime** switch, and saving never
  clears entries. See [Scheduled task fields](scheduled-tasks.md#scheduled-task-fields).
- **Scheduler runtime** (the conditional row, shown when the host runtime provides
  the switch; the ordinary extension entry point supplies it) is a
  live, current-process-only On/Off toggle for scheduled execution: it applies
  immediately, is never persisted in the config file, and stays outside the
  staged Save/Cancel transaction. See
  [Scheduled task fields](scheduled-tasks.md#settings-behavior-and-process-visibility).
- **Web** includes maximum acquisition size and **Browser interaction approval**:
  **Ask**, **Automatically Accept**, or **Automatically Deny**. Ask prompts when
  approval is required and rejects without UI; Accept supplies automatic approval
  without prompting; Deny rejects the approval-required branch. Already-permitted
  observations and structurally proven local actions remain permitted in every mode.
  Saves apply immediately to subsequent local approval decisions and acquisitions
  without restarting. Newly launched Pi workers load the saved policy; running workers
  keep the configuration loaded at launch. Research roles still cannot click or use
  form-action tools. It also opens the **Browser permissions** submenu (#27) with
  the independently selectable capability toggles — model credential entry and
  submission, uploads, download saving, clipboard read/write, camera, microphone,
  geolocation, service workers, popup restriction override, local networks (human
  and model), and **YOLO / allow everything** — each staged like every other
  section until **Save changes**. Enabling a capability presents its risk-appropriate
  notice; enabling YOLO additionally requires an explicit interactive confirmation
  after a prominent warning (cancellation or an unavailable dialog leaves it off),
  shows the enabled state prominently on the Web row, and disables straightforwardly
  with the saved individual values restored as effective. Every capability is
  enforced: credential entry and submission, uploads, download saving, and
  clipboard read/write by the interactive-browser tool actions; camera,
  microphone, and geolocation as per-origin device permission grants issued on
  navigation commits and cleared live on disable (an unconfirmable engine clear
  fails the affected session closed); service workers at browser
  launch, with a controlled replacement of the live browser when the saved
  policy changes; the popup restriction override while enabled; and local
  networks at the interactive egress broker. Saved changes apply to the live
  session without a restart; see [Web fields](configuration.md#web-fields).

The `/scheduled-tasks` command is a landing shortcut into this same
transaction: it opens the **Scheduled tasks** submenu immediately, and Esc or
**Back** from there returns to the settings root with the **Scheduled tasks**
row highlighted — the root's own retained-selection state. It introduces no
second menu, state, or save path — staged edits use the identical Save
validation and persistence, and Cancel discards them exactly as for
`/review-settings`.

Re-shown menus keep your position: after a staged change (a toggle, an add, a move),
the next display of the same menu highlights the row you last selected — even when its
label or position changed. In the interactive Pi TUI this renders as the host's native
selector list, preselected through its public component API, so arrow keys, Enter, and
Esc use Pi's supplied live keybindings manager, including configured selection-key
remaps. Compiled extension builds resolve these TUI components from the running Pi
installation when ordinary package-name loading is unavailable. Hosts without a terminal UI (RPC/print)
keep the plain selector that opens at the first row; retention is TUI-only, with no GUI
planned.

In the interactive Pi TUI every text field opens as the host's own main-prompt
editor: the extension temporarily acquires that editor through Pi's public
`setEditorComponent` seam and embeds the same instance in the settings surface,
so the current value arrives as an editable prefill and all of the host's native
controls apply unmodified — Tab path completion for relative or `~/...` paths
(typing `docs/` + Tab opens the host's own selectable list of folders *and*
files; a single match is applied directly, exactly as in the chat editor), the
fd-backed `@` file picker, Ctrl+C clear, Ctrl+G external editing for long values
such as scheduled-task instructions, image paste, and Shift+Enter newlines.
For scheduled instructions, a native image paste is persisted durably at Save
into the private managed store described in
[Scheduled instruction images](scheduled-tasks.md#scheduled-instruction-images) — the pasted
temporary path is validated by content, copied there, and replaced by the
managed absolute path before the config write. There is no second editor or
clipboard surface; recognition for this persistence stays bounded to Pi's
clipboard temp naming and this config's own managed store root.
Enter submits the field's own text (never a chat message); Esc first dismisses a
visible completion list, then cancels the field, leaving the staged value
unchanged. Every editable field shares the same native absolute-path behavior
(no per-field opt-in remains): a first-line token that starts with `/` and
contains no space (`/`, `/se`, `/var`, a nested absolute path) gets the host
provider's own filesystem suggestions in its ordinary file-list layout —
never slash-command items, so a nonexistent token such as `/subtasks` simply
lists nothing instead of offering commands, and no command can be offered or
executed in any extension-owned field. No second completer is involved: each
field decorates only the host-provided autocomplete provider through the
public `setAutocompleteProvider` seam, forcing that provider's own file
branch for those tokens and masking the returned prefix's leading slash with
a same-length neutral sentinel so the editor renders the file list (not the
two-column command layout) and applies a path (never `/command ` text). The
main chat prompt itself is untouched: a line starting with `/` there keeps
the host editor's ordinary slash-command context. Everything else is
unchanged: relative paths, `~/...`, the fd-backed `@` picker, Ctrl+C clear,
Ctrl+G external editing, image paste, Shift+Enter newlines,
Esc-dismisses-the-list-first, and the chat draft all behave exactly as in
the shared main-chat editor. This shared behavior covers every
`/review-settings` field, every other extension-owned interactive text field
— the staged subtask form (title, instructions, acceptance criteria,
relevant context, target workspace), the no-argument steering instruction,
and the private reviewer answer editor — and the AskUserQuestion free-text
answers. Token recognition,
relative/`~` handling, platform behavior, the list UI, and selection keys are
inherited from the host as-is, so no universal absolute-path or Windows support
is claimed. Two host behaviors are not preserved for absolute-path tokens through
this public seam: a first Tab never auto-applies a single match (the list shows
instead; after Esc, Tab reopens it and a further Tab selects the highlighted
entry), and best-match preselection does not apply within an absolute-path list
(the first entry is highlighted; arrow keys navigate). A space ends the token and
returns that position to the host's own completion behavior. An interactive host
missing the required native seams fails closed
with an error notice instead of presenting a non-parity fallback field.
Completion is a convenience — Save validates the workspace against the same
session working directory used for relative completion and dispatch, and rejects
nonexistent or non-directory targets, including a file selected from the list.
Non-interactive hosts (RPC/print) keep their clearly identified chain: Pi's
public editor with the current value as an editable prefill first, then the
legacy single-line input with its placeholder semantics; a host offering neither
seam reports an error instead of staging anything. The cron field shows
a compact heading above its editable prefilled text mapping all five fields in
order (minute, hour, day-of-month, month, day-of-week), stating machine-local
time and `* * * * * = every minute`.

Escape from a submenu returns to the settings root. Escape or **Cancel** at the root
discards all staged changes; **Save changes** atomically persists every section while
preserving unrelated JSON keys.

Saved values are authoritative for execution stages that have not started.
Already-running executor and reviewer processes finish with their launch values, while
queued dispatch, waiting failover, later continuation turns, and later review cycles use
the current routes, capacities, policies, and reviewer selection. Open review windows
reconcile to the new reviewer selection immediately on save: the preserved baseline,
evidence, and completed history are unchanged, a review already in flight finishes under
its original selection, and later reviews use the new one (a window frozen with no
usable reviewers becomes reviewable as soon as its settings are fixed). Subtask notification
mode is a delivery preference and takes effect immediately for subsequent events from
already-running tasks. Running capacity leases survive pool edits; removed entries
receive no new work. A restarted task warns when its prior runtime configuration
differs, and an executor-selection change starts a fresh native session from the durable
checkpoint instead of attaching an incompatible conversation.
