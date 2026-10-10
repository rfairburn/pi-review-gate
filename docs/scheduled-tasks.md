# Scheduled tasks

This page owns the scheduled-task feature guide: the `scheduledTasks` catalog fields and
defaults, inheritance and overrides, schedule destinations, instruction images, local-time
and daylight-saving behavior, settings behavior and process visibility, and runtime
dispatch. Raw config discovery and top-level defaults live on the
[Configuration](configuration.md) page; the staged menu that edits these entries is
documented on [Settings menu](settings.md#review-settings).

## Scheduled task fields

`scheduledTasks` is an unordered catalog keyed by each task's stable identity.
Every schedule entry is stored exactly once, in this catalog — there is no
second copy, no parallel mirror, and no copied global setting inside an entry.
The cron timer and dispatch that run these entries are part of the scheduled-run
runtime; this page defines, validates, and persists the entries that runtime
consumes.

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | (required) | Human label, editable without changing the entry's stable key. |
| `cron` | (required) | Standard five-field Unix cron expression (minute, hour, day-of-month, month, day-of-week), interpreted in the machine's local timezone. Ranges, lists, steps, and `jan`–`dec` / `sun`–`sat` names are accepted; `7` means Sunday. No seconds field and no `@` shorthands. |
| `enabled` | `true` | Disabled entries stay configured but are never dispatched. |
| `kind` | `"execute"` | `execute` (write-capable subtask), `research` (read-only subtask), or `inplace` (writes directly in its scoped directory through the `execute` worker route, with no capture or landing; the directory is not a sandbox and review is post-hoc, never a rollback). Applies to the subtask destination; see [Schedule destinations](#schedule-destinations) and [In-place kind](delegated-execution.md#in-place-subtask-kind). |
| `destination` | `"subtask"` | Where a due occurrence is delivered: `"subtask"` (the existing isolated scheduled-subtask dispatch) or `"orchestrator-turn"` (a turn to the existing primary agent). See [Schedule destinations](#schedule-destinations). |
| `instructions` | (required) | Instructions carried verbatim to the scheduled subtask or orchestrator turn. An image pasted through the native host editor is copied into a private managed store at Save (or at a session-only root Escape) and the instructions keep the managed absolute path — see [Scheduled instruction images](#scheduled-instruction-images). |
| `workspace` | required for `subtask`; otherwise absent | Explicit authorized target directory for a scheduled subtask. A leading `~` or `~/...` expands against the user's home (the same Pi-native rule as the built-in file tools); every other spelling, including `~user`, is used verbatim. Save persists the expanded absolute spelling of a tilde workspace (the runtime separately resolves the target's realpath). Orchestrator-turn entries may omit it or leave it empty; any stored value is unused and never overrides the existing agent's current Pi launch workspace. Switching an entry back to `subtask` requires a valid workspace. |
| `workerResourceId` | absent | Optional override naming an `execution.workerResources` entry. See below. Unused while the destination is `orchestrator-turn`. |
| `review` | absent | Task-local review choice. See below. Unused while the destination is `orchestrator-turn`. |
| `oneShot` | `false` | One-shot mode (issue #306). When `true`, the entry is eligible to fire only while `alreadyRun` is `false`; once an occurrence actually starts, the scheduler records `alreadyRun: true` and the entry stays in the catalog disarmed until manually re-armed. See [One-shot entries](#one-shot-entries). |
| `alreadyRun` | `false` | Whether an occurrence of this entry has actually started execution. Meaningful only for one-shot entries: a recurring entry ignores it and the scheduler never auto-updates it. It is editable by hand to disarm or re-arm — see [One-shot entries](#one-shot-entries). |

Illustrative fragment, not a standalone config: it assumes a research-capable
`execution.workerResources.local-research` entry and usable routes are already
configured — see [Delegated execution](delegated-execution.md#worker-resources-routes-and-concurrency);
on its own the pinned `local-research` reference does not resolve.

```json
{
  "scheduledTasks": {
    "task-nightly": {
      "name": "Nightly docs check",
      "cron": "30 2 * * *",
      "enabled": true,
      "kind": "execute",
      "instructions": "Check the docs for staleness and report any findings",
      "workspace": "/work/pi-review-gate"
    },
    "task-research": {
      "name": "Morning research digest",
      "cron": "0 9 * * mon-fri",
      "enabled": true,
      "kind": "research",
      "instructions": "Summarize upstream releases",
      "workspace": "/work/pi-review-gate",
      "workerResourceId": "local-research",
      "review": { "mode": "off" }
    },
    "task-onboarding": {
      "name": "One-shot onboarding sweep",
      "cron": "0 4 * * 1",
      "enabled": true,
      "kind": "execute",
      "oneShot": true,
      "instructions": "Run the onboarding checklist once",
      "workspace": "/work/pi-review-gate"
    }
  }
}
```

### Inheritance and overrides

Inheritance is per-field and resolved live at each future run; absence is the
only marker, so a global change flows into every still-inheriting entry without
any stored copy going stale:

- **Worker:** an entry with no `workerResourceId` uses the current global route
  for its kind when it runs. An entry with `workerResourceId` uses exactly that
  worker resource, selected from the independent `execution.workerResources`
  catalog — it does not have to appear on the kind's global route, because
  route membership would defeat the entry's independence from later route
  edits. Research capability is still enforced: a `research` entry may only
  name a research-capable resource.
- **Review:** an entry with no `review` inherits the current global subtask
  review settings at run time. An explicit choice is task-local and frozen per
  run: `{ "mode": "off" }` runs the task's subtasks without review — allowed
  for write-capable tasks too — and `{ "mode": "selected", "reviewers": [...] }`
  reviews that task's runs with exactly the listed set. An explicit choice
  never mutates the global or parent review state, and an unreviewed run is
  recorded as an ordinary unreviewed outcome; no pass verdict is ever
  fabricated. Review overrides apply to `execute` and `inplace` entries: research runs have
  no review stage, so a `selected` override on a `research` entry fails closed
  at dispatch time instead of being silently ignored (`off` is a consistent
  no-op there).

The two inheritances are independent: an entry may pin a worker while
inheriting review policy, or the reverse.

### One-shot entries

Each entry accepts two optional booleans, `oneShot` and `alreadyRun` (issue #306).
Absent fields mean `false`, so existing entries stay recurring unchanged; both
catalog fields persist across `/reload` and restarts like every other entry
field. The behavior applies to both destinations — scheduled subtasks and
orchestrator turns.

- **Eligibility:** a `oneShot: true` entry is eligible at a due occurrence only
  while its stored `alreadyRun` is `false`. That is one more condition at the
  ordinary per-minute admission, under the entry's existing `enabled` setting
  and unchanged cron expression — not a separate scheduling system, date
  format, retry mechanism, or catch-up behavior.
- **Consumption records run start, not success:** the scheduler sets
  `alreadyRun: true` when the occurrence's execution actually begins — for the
  `subtask` destination at the actual delivery of that worker's prompt, and for
  `orchestrator-turn` at the matching scheduled-message observation inside the
  host run (a queued delivery alone, or one the host accepted but never
  acknowledged, is not evidence that execution started). Once the flag is set
  it never depends on the model: a refusal, a failure, unsuccessful work, or
  any review outcome leaves it consumed. "Already-run" means **has started** —
  never "succeeded".
- **What does not consume an occurrence:** the existing skip and rejection
  paths leave `alreadyRun` untouched — occurrences skipped for overlap, dropped
  as sampled-but-not-admitted (switch Off, session end, or a Save replan), or
  skipped for a dispatch-time validation failure, and launches that never
  start. Rejected or uncertain sends do not by themselves consume a one shot;
  if execution is subsequently observed to start, that start consumes it.
  A queued-only orchestrator-turn delivery likewise does not mark the entry
  as run.
- **Lifecycle:** the entry remains in the catalog after it runs, disarmed —
  later due occurrences, including any that fall while that first run is still
  active, do not execute it again. Setting `alreadyRun: true` manually disarms
  the entry without executing anything; setting it back to `false` re-arms it
  for its next future cron occurrence — never an immediate run and never a
  replay of missed occurrences (future-only semantics as in
  [Local time and daylight saving](#local-time-and-daylight-saving)).
- **Recurring entries are unchanged:** with `oneShot: false` (the default),
  `alreadyRun` has no role — its stored value is ignored for scheduling and
  execution, and the scheduler never auto-updates it. It is not a status or
  history field for recurring tasks.

### Schedule destinations

Each scheduled entry selects where its due occurrences are delivered
(issue #222). The choice is per-entry and never a global replacement for
scheduled subtasks; existing entries stay subtask-dispatched without an
implicit migration.

**`subtask` (default; absence of the field has this meaning):** the entry
dispatches through the ordinary scheduled-subtask path exactly as before —
its kind, workspace, worker resource, and task-local review choice apply,
the one-unsettled-run-per-entry overlap rule applies (a later due occurrence
is skipped while a previous run of the entry is still unsettled and reported
with the active handles, and an overdue occurrence is reported as not-run
instead of catching up), and completion/failure delivery follows the
`execution.subtaskNotifications` quiet/noisy policy. After a successful
dispatch the top-level model is additionally woken with a model-facing
launch notice carrying the schedule identity (entry id, name, exact due
minute, cron expression) and the execution/task handles. It uses the same
shared, non-model-initiated subtask-launch mechanism as a human
`/subtask-add`: the same non-interrupting follow-up delivery lane, the same
redaction and character bounds, the same origin metadata, and the same
causal ordering that keeps a fast-settling outcome behind the notice — only
the origin-specific context differs. The notice never dispatches a duplicate
of the task and never implies it has progressed or completed.

**`orchestrator-turn`:** the due entry's instructions and opaque occurrence
identity are delivered as a NEW TURN to the EXISTING primary agent instead of
starting a subtask. No second Pi instance is launched, and there is no
workspace-root override for this destination: the agent acts in its current
Pi launch workspace with its current tools, model, and review behavior, and
may act directly or start subtasks. The `workspace` field may be omitted or
empty; any stored value is unused. Delivery is a non-interrupting follow-up
that still triggers a turn — a busy orchestrator is never interrupted; the
queued turn runs after its current turn. The scheduled occurrence completes
when its initiating turn ends. Subtasks or other background work the turn
started continue under their own existing lifecycle and notifications; they
never keep the schedule occurrence open, and later due occurrences of the
entry are evaluated independently (there is no per-entry overlap gate in this
destination).

**Notification presentation:** the scheduled task events (`pi-review-scheduled-task-event`)
and scheduled orchestrator-turn deliveries (`pi-review-scheduled-orchestrator-turn`)
render as compact, expandable notifications in the host's native expansion mechanism:
each collapsed view names the schedule entry and the due occurrence and states the
truthful outcome and immediate action — a skipped occurrence, a not-run drop, a
failure or an uncertain dispatch, or a duplicate/retry warning — while an
orchestrator-turn delivery never claims the turn executed or completed: its full
instructions and metadata are visible by expanding the item. Expansion reveals all of
the delivered event text and nothing beyond it; it fetches nothing and changes no
delivery or scheduling behavior. A notification whose shape is unknown, malformed, or
inconsistent is shown as its full retained text and carries no expand/collapse hint
(there is no compact view to restore), rather than a summary fabricated from
unrelated content. See [Development → Shared native presentation
expansion](development.md#shared-native-presentation-expansion).

Installed Pi starts an idle custom-message turn without emitting
`before_agent_start`; for both idle and queued custom messages, the extension
therefore arms the fail-closed review baseline and reasserts the deferred-tool
authorization at the host's `message_start`, before that message's model
request. A busy queued message shares the already-armed review window. The
occurrence is correlated only by its opaque id on that exact `message_start`,
then completed after its consuming run ends and the submit-cycle settles; an
unrelated human turn, message delivery, or downstream subtask completion
cannot settle it. If review/auth re-arming fails, native tool calls are
blocked for the session and the occurrence is not counted. A host without the
required run/message lifecycle hooks rejects scheduled orchestrator delivery
before sending it, with an actionable limitation report. A definitely
rejected send fails closed with an actionable scheduler wake; nothing was
triggered. A send the host accepts but never acknowledges within its bounded
window is reported as **uncertain**: whether the turn was queued is UNKNOWN,
it may still arrive, the occurrence is not counted as executed, and the report
warns the owner to inspect the conversation before retrying so a pending turn
is never duplicated.

### Scheduled instruction images

An image pasted through the native editor in a scheduled task's
**Instructions** field (Ctrl+V in the interactive TUI) inserts a path to one
of Pi's temporary clipboard files — a path, never image bytes, and Pi deletes
those files, so a temporary path saved as instruction text would break on a
later run. At Save (and at a session-only root Escape), such a paste is made
durable instead:

- Save (and root Escape) verifies each pasted path against the **final staged
  instructions** (an observation of the paste is only provenance; a token that
  was deleted or edited away copies nothing), opens the file and validates it by
  content (PNG, JPEG, GIF, or WebP; regular file; at most 10 MiB), copies the
  bytes into a private managed store next to the config file
  (`<config dir>/scheduled-image-assets/<task id>/`), and replaces the
  temporary path in the instructions with that managed absolute path. Save then
  performs the ordinary atomic config write; root Escape leaves the configuration
  file untouched. The config file never contains image bytes.
- Only text Pi's image paste itself could have produced is treated as a
  pasted image: a single absolute path in the OS temp directory named
  `pi-clipboard-<UUID>.<png|jpg|jpeg|gif|webp>` (Pi's own paste naming, with
  the strict UUID basename, and the content still validated after that path
  recognition). Pi's native Ctrl+V inserts ordinary clipboard text through
  the same editor call, so a plain text paste — any other absolute path
  (file, directory, real or nonexistent), a sentence, or `@` attachment text
  — is never treated as an image: it stays verbatim in the instructions and
  Save behaves exactly as native text paste always did, even when the named
  file does not exist or its content happens to be an image. If the temp
  directory's own name contains spaces (a Windows user or home directory), a
  genuine UUID-named temp insert is still recognized.
- The managed store is private (0700 directories, 0600 files, fsynced before
  the rename) and append-only: assets are **never auto-deleted** when an entry
  is edited, disabled, or removed, because an active run of that entry — or a
  scheduled run in another Pi process sharing the config — may still read
  them. After every run that could reference a file has settled (or the entry
  and any sharing process are gone), delete unneeded files from the store
  manually. A bounded garbage-collection pass is a possible follow-up, not
  current behavior.
- Fail closed: a pasted source that is missing (Pi's temp file already
  deleted), not a supported image, or too large fails the whole Save or root
  Escape with an actionable notice, leaving the config and the store untouched;
  the same applies if the copy fails, or if a source grows past the limit between
  the size check and the read, and only copies that Save or root Escape
  positively created are removed (if a persistence failure lands after the config
  write, the copies the persisted text references are kept, matched against the
  parsed saved config). Cancel at any level copies
  nothing, and a pasted path must remain separated by spaces from surrounding
  text — a path glued to adjacent text fails Save or root Escape with a message
  asking for the separating space. A pasted image therefore has to
  be re-pasted and applied while its source still exists (paste, then Save or
  root Escape — do not close and reopen the settings menu in between). Text
  glued directly after a pasted path (for example a `.bak` suffix) also fails
  Save: the saved reference would never resolve; trailing sentence punctuation
  (`<path>.`, `<path>,`) is still accepted.
- Provenance boundary: only inserts observed through the native editor's
  public paste seam are ever considered. A `pi-clipboard-...` path that
  appears in the instructions without such an observation — typed by hand,
  edited into the config file, or entered through the non-interactive
  editor/input fallback — cannot be verified and fails Save with an actionable
  message instead of being copied or persisted; Pi deletes its clipboard temp
  files, so persisting such a reference would promise image availability it
  cannot keep. Save and root Escape check every staged scheduled entry, so a
  pre-existing unobserved clipboard-temp reference also blocks an otherwise
  unrelated Save or root Escape until that reference is removed. This gate is
  broader than the copy recognition: any `pi-clipboard-...` reference without an observed
  paste fails Save, even
  with a non-image extension or a non-UUID name. Ordinary typed paths and
  commands are never touched, and
  `@`-picker selections or terminal drops (whose image provenance is not
  observable through public native seams) are left as ordinary text. If the
  same image is needed in two entries, paste it into each entry; the pastes
  get independent managed copies. If the managed store root or a per-task
  directory exists as a symbolic link (for example pointed at a foreign
  directory), Save fails closed with an actionable message: the store is
  never chmod'ed or copied into through a symlink, and the link's target is
  left untouched.
- At dispatch, an entry whose instructions reference a managed image that no
  longer exists fails that occurrence closed with the standard actionable
  dispatch-failure report (naming the missing file) instead of silently
  starting a run against a dead path; existing overlap, overdue, and review
  semantics are unchanged.

### Local time and daylight saving

The cron expression is stored and interpreted only in the machine's local
timezone. No UTC representation is stored or displayed alongside it.

The runtime samples the host's actual local wall clock once per distinct
absolute minute and dispatches every enabled entry whose expression matches
the sampled minute. Daylight-saving behavior falls out of that sampling rather
than from any fire-time computation:

- **Spring-forward gap:** local minutes that do not exist on the transition
  day (for example 02:00–02:59 when the clock jumps forward) are never
  observed by the host clock, so an entry due in that window is missed for
  that day. It runs again on its next ordinary due time.
- **Fall-back repeat:** a local minute that occurs twice (for example 01:00–
  01:59 when the clock repeats) is evaluated once per distinct absolute due
  minute. An entry due at 01:30 can run on both passes; if its first run is
  still active on the second pass, that occurrence is skipped with an
  actionable overlap wake instead.
- **No catch-up:** time that passes while the process is not running, while
  the switch is Off, or while a host sleeps is never replayed. Starting,
  re-enabling, or replanning makes the next full minute the first possible
  dispatch. The same rule applies inside one enabled session: a due occurrence
  whose minute passes before its own dispatch could be admitted (a previous
  occurrence of the same entry had not yet settled) is never run late — it is
  reported (an overlap skip when a run of the entry is active, otherwise as
  not-run) and the next due occurrence is evaluated independently.

### Settings behavior and process visibility

Entries are created and edited under **Scheduled tasks** in `/review-settings`
— or directly through the `/scheduled-tasks` command, which opens that same
submenu first; Esc or **Back** from it lands at the settings root with the
**Scheduled tasks** row highlighted, where **Save changes**, **Cancel**, and
root Escape behave exactly as for the ordinary entry (see
[Settings menu](settings.md#review-settings)).
Either way entries are staged like every other section behind **Save changes**
/ **Cancel**, with root Escape applying them to the running session only. Save
validates every entry (a real cron expression, non-empty instructions, an
existing workspace directory — relative paths are checked against the session
working directory and a leading `~`/`~/...` is expanded against the user's
home before that check — a resolvable worker override, and a task-local
reviewer set that resolves like any global one) and persists the catalog while
preserving unrelated JSON keys. A tilde workspace entered in the editor or
hand-edited into the config file is persisted in its expanded absolute form on
Save; until then the `~/...` spelling remains valid, because dispatch expands
it at run time against the same home directory. Entries remain visible and
editable regardless of the runtime switch described below, and a Save applies to the task
definitions only: an already-running subtask is never stopped or reconfigured
by a Save, and stopping one is an explicit action.

Save also preserves schedule entries that another Pi process appended to the
config after this instance's menu opened; entries this instance explicitly
removed are still removed. A Pi process reads schedule definitions from its own
loaded configuration: it sees another process's saved edits only on its own
`/reload` or restart.

Scheduled execution has a live, current-process-only On/Off switch in
`/review-settings`. It is never stored in the config file and is never a shared
default: a launcher process starts with scheduled execution **On only when that
launch passed the `--scheduler` flag** — the launchers export
`PI_REVIEW_GATE_SCHEDULER=1` for exactly that launch and clear any inherited
value, so a nested or fresh launch without the flag starts **Off** even under a
flagged parent. A directly loaded Pi process (no launcher) instead seeds its
initial state from `PI_REVIEW_GATE_SCHEDULER=1` in its own environment. Either
way, a live toggle survives `/reload` in the same process exactly as it was set.
Because several enabled Pi processes may share one config file, two enabled
instances can independently run the same due task — treat accidental concurrent
runs as a real possibility and enable more than one instance only deliberately.
If independently differing schedule sets are wanted, point the instances at
separate config files: launcher launches follow Pi's `PI_CODING_AGENT_DIR`
agent-directory override (the launchers deliberately ignore an inherited
`PI_REVIEW_GATE_CONFIG`, see [Config discovery](configuration.md#config-discovery)), while
direct loads honor `PI_REVIEW_GATE_CONFIG`; there is no per-instance, per-task
filtering.

### Runtime dispatch

When the switch is On, a due entry dispatches directly through the ordinary
background subtask start path — no model turn and no orchestrator launch turn
are involved in starting the run. The launching orchestrator then receives the
same ordinary owner-scoped completion, failure, and recovery notifications it
receives for any subtask; a successful dispatch itself is reported with a
lightweight notice.

**Overlap:** while any earlier run of an entry still has unsettled tasks (the
entry's stable id is persisted on each run's execution group, so overlap
detection survives restarts), **every** due occurrence is skipped and the
owning orchestrator is woken with actionable data: the schedule identity,
the exact due time, and the active executions with their task handles. A skip
never implies completion or cancellation, never queues a later run, and never
interrupts the active run. Editing an entry does not proactively wake its
orchestrator; a later due occurrence that overlaps the still-active run does.

**Stopping:** turning the switch Off (or ending the session) stops future
dispatch only — active scheduled subtasks keep running under the controller's
own recovery semantics and are never interrupted by the scheduler. Occurrences
that were sampled but not yet admitted when the switch went Off or the session
ended are dropped: they can never start after a re-enable, and no catch-up run
is started for them. Process exit stops the timers the same way; a run in
flight settles through the existing subtask recovery rather than any
notification to an exited process.

**Save replan:** saving `/review-settings` replans the current process's
timers immediately: future-only sampling restarts from the next full minute
against the saved catalog, so edits apply at the very next due occurrence
without replaying anything. A Save likewise drops occurrences that were
sampled but not yet admitted: none of them starts afterwards with the old or
the edited definition. Entries that fail validation at dispatch time are
skipped with an actionable report instead of taking down the timer loop.

**Managed images:** when a due entry's instructions reference a managed
scheduled image (see [Scheduled instruction images](#scheduled-instruction-images))
that no longer exists, the occurrence is not dispatched: it is reported
through the standard actionable dispatch-failure wake naming the missing file,
and the next due occurrence is evaluated independently.
