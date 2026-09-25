# Configuration

This page owns the complete configuration reference: config discovery, every JSON field
with its default, the `/review-settings` UI, and legacy compatibility. Runtime behavior
described only briefly here is owned by the linked page.

## Config discovery

- `PI_REVIEW_GATE_CONFIG=/path/to/review-gate.json` selects the config file explicitly.
- Without an explicit selection, two fixed implicit candidates are checked in order:
  1. `review-gate.json` in the Pi agent directory — `~/.pi/agent/review-gate.json` by
     default (`%USERPROFILE%\.pi\agent\review-gate.json` on Windows), following Pi's
     native `PI_CODING_AGENT_DIR` override when set.
  2. `~/.config/pi-review-gate/config.json` — an implicit compatibility fallback.
  There is no third implicit location, and nothing is copied or migrated between the
  two candidates.
- The persistent launcher (`scripts/pi-review-gate.sh`) deliberately ignores an
  inherited `PI_REVIEW_GATE_CONFIG` (it re-resolves and re-exports the variable itself)
  so an inherited value from a parent pi session cannot silently redirect the gate
  elsewhere. It selects the first existing candidate above — a config that exists only
  at the fallback location remains selected unchanged. When neither exists, it
  initializes a private zero-model default config at the default location — explicitly
  empty reviewer and worker selections, never overwriting or replacing anything that is
  already there — and continues normal startup.
- With no config file found on a direct `pi -e` load (no `PI_REVIEW_GATE_CONFIG` and
  neither persistent path), `enabled` defaults to `false`, so automatic review does not
  run — but the extension still loads `WebSearch`, `WebFetch`, `ApplyPatch`, and the
  background shell. Model-facing subtask tools require at least one resolvable configured
  worker resource. Only `PI_REVIEW_GATE_DISABLED` disables the whole extension.
- The config file must be a JSON object. Startup reports invalid settings and uses
  defaults for those settings while retaining valid values. An unreadable or
  unparseable document uses built-in defaults; the file is never overwritten.

## Kill switches

- `PI_REVIEW_GATE_DISABLED=1` (truthy values `1`, `true`, `yes`) is the environment kill
  switch: it disables the whole extension, including delegated execution. The launcher
  warns loudly when it is set instead of silently swallowing it.
- Top-level `enabled: false` is the automatic-review master switch only. It does **not**
  disable configured worker routes.
- Clearing every reviewer for a review layer in `/review-settings` disables that layer's
  automatic review without disabling delegated execution. The preserved review window
  stays open (deferring each review with a notice) until reviewers are configured again
  or the window is cleared explicitly; it never turns into a pass. Manual primary
  review commands remain available while primary reviewers stay selected (see
  [Review layers](#review-layers-and-the-legacy-activereviewers-import)); the stored
  automatic-review toggles never gate them.

## Top-level fields

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Automatic-review master switch (see kill switches above). |
| `operatingMode` | `"orchestrate"` | Primary assistant posture: `execute`, `orchestrate`, or `plan-research` (see operating modes below). |
| `modeCycleShortcut` | `"alt+m"` | Human hotkey that directly cycles the operating modes in the order `execute` → `orchestrate` → `plan-research` → `execute` (see operating modes below). |
| `reviewerTimeoutMs` | `600000` | Default reviewer timeout (10 minutes). |
| `executorTimeoutMs` | `1800000` | Default executor timeout (30 minutes). |
| `maxCorrectionCycles` | `1` | Correction budget before feedback is classified as deferred. |
| `implementationGuidanceAfterCorrectionAttempts` | `1` | Threshold that strengthens review requests with concrete implementation guidance (see [Review workflow](review-workflow.md#corrections-guidance-and-the-correction-cap)). |
| `maxPatchBytes` | `200000` | Bound for retained patch content. |
| `maxFileBytes` | `1048576` | Bound for retained individual file content. |
| `maxSnapshotBytes` | `52428800` | Bounds the cumulative size of non-ignored untracked files during task capture (50 MiB) and the textual file content retained for ordinary review snapshots. |
| `waveArtifactTtlMs` | `2592000000` (30 days) | Age after which completed non-recovery wave artifact roots are garbage-collected; `0` disables collection. |
| `retainBundles` | `"on-failure"` | Review-bundle retention policy: `never`, `on-failure`, or `always`. `always` disables age-based wave GC while the application is running. |

## Operating modes

Choose **Operating mode** in `/review-settings`, then **Save changes**:

- **Prefer execution**: favor focused direct implementation; delegate when useful.
- **Prefer orchestration** (default): favor bounded delegation; the primary assistant
  remains responsible for integration and verification.
- **Plan/research**: local read-only investigation and planning. Write-capable tools,
  arbitrary shell, and execution-subtask controls are removed from the active tool
  schemas, authorized inventory, and `search_tools` results. Launch-authorized native
  read-only discovery (`grep`, `find`, `ls`) stays active in every mode. The structured
  read-only Git history tool `GitRead` is active only in this mode: available from the
  first request (no `search_tools` step) and removed from the active set, inventory,
  and search results in every other mode. When changes are needed, the assistant asks
  you to switch modes; there is no GitHub-writing exception.

The next normal run in the same conversation receives the replacement mode prompt:
no `/new`, reload, or restart is needed. Shared safety and review instructions and user
append prompts remain. An in-flight run retains its prompt, and already-running subtasks
retain their captured instructions and authority. Cancelling settings leaves the mode
unchanged. Returning to a write-capable mode restores tools within the original
authorization boundary, not tools that were disabled at launch.

Prompt files live in `scripts/orchestrator-system-prompt.md`,
`scripts/execution-system-prompt.md`, and `scripts/planning-system-prompt.md`.
The extension selects the mode segment rather than the launcher permanently appending
orchestration instructions. Native `grep`, `find`, and `ls` stay active in all modes
whenever Pi's tool registry permits them. `--no-builtin-tools` only changes initial
activity, so it does not keep this trio inactive; use `--exclude-tools` or an explicit
`--tools` allowlist to exclude them. Planning gains no arbitrary shell, but it does
activate the structured read-only `GitRead` history tool; outside plan/research,
`GitRead` is neither active nor discoverable (see [Security model](security-model.md#read-only-enforcement)).

### Direct mode-cycle hotkey

Pressing the configured hotkey (default `alt+m`) advances the operating mode one step
in the canonical order — `execute` → `orchestrate` → `plan-research` → `execute`,
wrapping at the end — with no selector and no confirmation popup. It uses the same
persisted `operatingMode` field, the same shared transition, and the same persistence
path as the **Operating mode** selector, and the existing `operating mode:` status
indicator updates in place. The hotkey works in every mode, including Plan/research,
and applies from the next turn like any mode change; already-running subtasks keep
their captured instructions. There is no model-facing tool for changing modes, and no
mode state is stored anywhere besides the canonical config field.

The hotkey is editable under **Mode cycle hotkey** in `/review-settings`. Values must
use a single key, optionally prefixed with modifiers (`ctrl`, `shift`, `alt`,
`super`) — for example `alt+m`, `ctrl+shift+r`, or `f6`. Avoid binding ordinary
unmodified typing keys unless you intend to replace their normal input behavior. If the chosen key is already a built-in Pi binding, the
settings menu rejects it by name and asks for a different key, so the built-in action
keeps working; at startup a config file that carries an occupied key is named in a
warning and the hotkey is simply not registered. Conflicts with other extensions are
not detectable here — Pi reports those itself at startup — and the extension does not
claim otherwise. The binding itself is captured when the extension loads, so a changed
hotkey takes effect after `/reload`, just like `keybindings.json`; the persisted mode
change itself never needs a reload.

## Reviewers

Reviewers run in parallel against the same review bundle. Review-gate waits for every
reviewer and applies a simple gate: any `needs_changes` verdict means changes are
required; when no reviewer requests changes, at least one completed `pass` is accepted
even if another reviewer has an infrastructure error; and the gate errors only when no
reviewer completes a usable review. Mixed pass/error results are classified as
`pass_with_warnings`, retain their evidence, and return every reviewer result to the
orchestrator. Each reviewer also appears once in the implementing-model transmission.
Results from every reviewer are transmitted, including passing assessments, non-blocking
observations, guidance, disagreements, and reviewer errors. Blocking findings are
identified as required corrections; passing and non-blocking material remains visible
without becoming mandatory work.

A reviewer selection that no longer resolves (removed, renamed, or currently unscoped)
never blocks the rest of the review: every resolvable reviewer still runs, and each
unresolvable selection appears in the results as an explicit bounded
`reviewer_unavailable` error outcome instead of a hidden or resurrected reviewer.
Duplicated selections run once. When no configured reviewer is currently usable, the
gate defers the review with an actionable notice and keeps the preserved review window
open until a reviewer can run; it never clears the window or turns the situation into a
pass.

Multi-reviewer example:

```json
{
  "enabled": true,
  "maxCorrectionCycles": 3,
  "implementationGuidanceAfterCorrectionAttempts": 1,
  "retainBundles": "on-failure",
  "reviewers": [
    { "id": "codex", "adapter": "codex-cli", "timeoutMs": 600000 },
    { "id": "claude", "adapter": "claude-cli", "timeoutMs": 600000 }
  ]
}
```

Reviewer adapters:

- `codex-cli`, `claude-cli`, and the Pi model adapter run as read-only agentic reviewers
  so they can inspect the workspace and retained review bundle before deciding. The
  enforcement details are owned by [Security model](security-model.md#read-only-enforcement).
- `generic-cli` (and `run-as-binary` for executors) remain prompt-only unless the
  configured command provides its own safe read-only behavior.

Reviewer selections use discriminated references. Pi internal models are
runtime-discovered and use the exact canonical `provider/model` value plus a role-owned
`thinkingLevel` whose allowed levels come from that scoped model's runtime metadata
(including its `thinkingLevelMap`; unsupported extended levels such as `max` are not
offered). These settings never inherit the controlling session's thinking level. Legacy
internal selections without a `thinkingLevel` continue to use `high`; saving them
through `/review-settings` materializes an explicit model-supported level.

```json
{
  "review": {
    "activeReviewers": [
      { "source": "pi", "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "high" },
      { "source": "external", "id": "codex-sol" }
    ]
  }
}
```

### Review layers and the legacy `activeReviewers` import

Issue #175 splits automatic review into two independently controlled layers, both
configured from the **Review** submenu in `/review-settings` and stored under the
existing `review` object:

| Field | Default | Meaning |
| --- | --- | --- |
| `review.primaryReviewers` | — | Reviewer set for automatic review of the primary assistant's own changes (one policy shared by `execute` and `orchestrate`). |
| `review.subtaskReviewers` | — | Reviewer set for automatic review of subtask results before ordinary accepted landing. |
| `review.primaryEnabled` | `true` | Automatic review of the primary assistant's own changes is on (one policy shared by `execute` and `orchestrate`). Controls automatic review only: manual `/review-now` and `/ask-reviewer` remain usable while reviewers stay selected, and `/review-pause` is unchanged as a temporary control. |
| `review.subtaskEnabled` | `true` | Automatic subtask review is on: ordinary accepted subtask landings go through the subtask reviewer set before landing. Off lets subtasks land without their own review; their changes still follow `review.reviewLandedChanges`. |
| `review.reviewLandedChanges` | `false` | Landings into the primary review window that did **not** already complete a successful subtask review stay pending in that window's diff as ordinary primary review evidence instead of being checkpointed out. Inactive while automatic primary review is off (landed changes are checkpointed out as before). |

Both layers may be saved Off, including a configuration that performs no automatic
review at all. The selected primary reviewer set remains available to manual
`/review-now` and `/ask-reviewer`: the toggles control automatic review only
and never gate those commands. While automatic primary review is off, the primary review
window/baseline stays tracked across quick iterations so a later manual review can
inspect those changes; suppressing the automatic run never records a synthetic PASS.
There are no model-controlled paths to these settings: the submenu is staged by a
human like every other settings section, and the reviewer sets are drawn from the
existing reviewer catalog above (no second definition catalog and no model controls).

**Landed changes.** With `review.reviewLandedChanges` on, a landing into the parent
session's own workspace that did **not** already complete a successful subtask review
— an unreviewed subtask merge, or an unreviewed exceptional-path landing such as
explicit force-merge/salvage or `SubtasksMarkClean` resolved-conflict handling where
the landing path supports it — keeps its diff in the primary review window as ordinary
evidence instead of being checkpointed out. A landing that already completed a
successful subtask review keeps the existing checkpoint/bypass handling and is not
re-reviewed in the primary window. The review itself always settles at the primary
model's normal idle point, exactly like any other primary exchange; a landing never
triggers an immediate review. The existing conflict and salvage recovery warnings and
fail-closed gates are unchanged: a forced merge is still a mechanical landing attempt,
not verification. Landings into a target other than the parent session's workspace
never enter the parent review window
(see [Delegated execution](delegated-execution.md#conflicts-and-gates)). With the
option off — or while automatic primary review is off — landed changes are
checkpointed out of the window as before.

**Legacy import.** A config that stores only the legacy `review.activeReviewers`
single set is imported in memory on every load: the same selections become both
effective sets (primary and subtask) and both menus display them immediately, while
the stored file stays byte-identical — loading never rewrites it. The lifecycle:

- **Save (even with no manual edit)** persists the effective split fields and removes
  the `review.activeReviewers` key, so a saved record never keeps a second canonical
  reviewer set. Manual edits win over the imported values.
- **Cancel or Esc** leaves the file untouched, but the imported sets remain effective
  for the running session; re-loading the unchanged file re-imports identically.
- A config that already stores the split fields honors its saved choices and never
  re-imports the legacy copy. A record that carries both uses the split fields and
  ignores the obsolete copy without a rewrite (the same doubled-record precedence as
  the pre-cutover fields below).

The split state is derived through one shared accessor, `effectiveReviewSettings(config)`,
whose fields match the stored `review.*` fields one-for-one (`primaryReviewers`,
`subtaskReviewers`, `primaryEnabled`, `subtaskEnabled`, `reviewLandedChanges`), so
automatic review consumes layer-specific values from a single canonical source.

Pi and the selected provider own reasoning effort and token-budget behavior;
review-gate does not impose a second output-side thinking cap. Reviewer and executor
selections remain separate from the orchestrator. External harness reasoning is
configured natively through each `externalAgents` entry's `review.args` and
`execution.args` roles (for example a Codex CLI role can use
`["-c", "model_reasoning_effort=\"high\""]`, Claude Code can use
`["--effort", "high"]`, and arbitrary binary adapters may use their own arguments or
environment variables).

### The `externalAgents` catalog

`externalAgents` is one configured catalog shared by both menus: an object keyed by
stable agent ID, where each value has an optional `review` role, `execution` role, or
both. Role sections can override shared arguments, environment, model, protocol, and
timeout, so one harness can use different limits for review and execution. An inactive
external definition does not need to be installed; its command is checked when that
definition is selected or run. Pi-scoped internal models are never copied into the
external catalog.

The legacy array form (entries carrying their own `id`) is deprecated but still
imported at load time and converted to the keyed object, preserving every identity,
reference, and setting. That import support will be removed in a future version without
a fixed date or version ([#116](https://github.com/rfairburn/pi-review-gate/issues/116));
save the canonical object form now — `/review-settings` saves already write it. The
worker catalog follows the same shape and deprecation; see
[Delegated execution](delegated-execution.md#worker-resources-routes-and-concurrency).

### Pre-cutover configuration fields

The pre-cutover fields `decider`, `reviewers`, `enabledReviewerIds`,
`execution.activeExecutor`, `execution.executorPool`, and
`execution.externalExecutors` are no longer accepted. A config that carries
only one of them fails strict validation. Startup warns and omits unsupported fields;
it does not convert them into reviewer or worker selections. Use `externalAgents`
plus `review.primaryReviewers`/`review.subtaskReviewers`, or `execution.workerResources`. There is no migration: a record
that carries both the old and the new shape uses the canonical fields and ignores the
old copies, and `/review-settings` saves never rewrite stored records into either
pre-cutover shape. Reviewer and executor selections that cannot be resolved against the current
catalog remain reported (as unavailable selections) instead of being dropped or
silently disabling review.

Startup recovery reports invalid fields and continues normal tool initialization.
Valid settings, including configured workers and reviewers, survive unrelated errors.
Nested scalar settings use their existing defaults. Invalid selection, agent, resource,
or route entries are omitted individually rather than inventing a replacement model,
command, or authorization reference; valid sibling entries remain. Model/reasoning
pairs stay together. An unreadable document uses built-in defaults, which contain no
reviewer or worker selections; this is not a successful review. Explicit configuration
writes still validate strictly. The environment kill switch and worker tool ceilings
remain authoritative.

## Delegated execution fields

The `execution` block (`workerResources`, `routes`, `maxWorkers`,
`subtaskNotifications`, `deferredPiTools`, `retryPolicy`) and the reviewer/execution route matrix are
documented with the behavior they control in
[Delegated execution](delegated-execution.md#worker-resources-routes-and-concurrency),
including the keyed-catalog shape, legacy array import, and deprecation.
A complete end-to-end example is `examples/delegated-execution.json`.

Defaults: `execution.maxWorkers` is `4` (allowed range 1–16) and
`execution.subtaskNotifications` defaults to `quiet`. `execution.deferredPiTools`
defaults to `true`. The default retry policy is
`maxRetries: 2`, `baseDelayMs: 1000`, `maxDelayMs: 15000`, `jitter: true`,
`maxSameIncidentRepeats: 2`.

## Scheduled task fields

`scheduledTasks` is an unordered catalog keyed by each task's stable identity.
Every schedule entry is stored exactly once, in this catalog — there is no
second copy, no parallel mirror, and no copied global setting inside an entry.
The cron timer and dispatch that run these entries are part of the scheduled-run
runtime; this section defines, validates, and persists the entries that runtime
consumes.

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | (required) | Human label, editable without changing the entry's stable key. |
| `cron` | (required) | Standard five-field Unix cron expression (minute, hour, day-of-month, month, day-of-week), interpreted in the machine's local timezone. Ranges, lists, steps, and `jan`–`dec` / `sun`–`sat` names are accepted; `7` means Sunday. No seconds field and no `@` shorthands. |
| `enabled` | `true` | Disabled entries stay configured but are never dispatched. |
| `kind` | `"execute"` | `execute` (write-capable subtask) or `research` (read-only subtask). |
| `instructions` | (required) | Instructions carried verbatim to the scheduled subtask. An image pasted through the native host editor is copied into a private managed store at Save and the instructions keep the managed absolute path — see [Scheduled instruction images](#scheduled-instruction-images). |
| `workspace` | (required) | Explicit authorized target workspace directory for the scheduled run. A leading `~` or `~/...` expands against the user's home (the same Pi-native rule as the built-in file tools); every other spelling, including `~user`, is used verbatim. Save persists the expanded absolute spelling of a tilde workspace (the runtime separately resolves the target's realpath). |
| `workerResourceId` | absent | Optional override naming an `execution.workerResources` entry. See below. |
| `review` | absent | Task-local review choice. See below. |

Example:

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
  fabricated. Review overrides apply to `execute` entries: research runs have
  no review stage, so a `selected` override on a `research` entry fails closed
  at dispatch time instead of being silently ignored (`off` is a consistent
  no-op there).

The two inheritances are independent: an entry may pin a worker while
inheriting review policy, or the reverse.

### Scheduled instruction images

An image pasted through the native editor in a scheduled task's
**Instructions** field (Ctrl+V in the interactive TUI) inserts a path to one
of Pi's temporary clipboard files — a path, never image bytes, and Pi deletes
those files, so a temporary path saved as instruction text would break on a
later run. At Save, such a paste is made durable instead:

- Save verifies each pasted path against the **final staged instructions**
  (an observation of the paste is only provenance; a token that was deleted or
  edited away copies nothing), opens the file and validates it by content
  (PNG, JPEG, GIF, or WebP; regular file; at most 10 MiB), copies the bytes
  into a private managed store next to the config file
  (`<config dir>/scheduled-image-assets/<task id>/`), and replaces the
  temporary path in the instructions with that managed absolute path before
  the ordinary atomic config write. The config file never contains image
  bytes.
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
  deleted), not a supported image, or too large fails the whole Save with an
  actionable notice, leaving the config and the store untouched; the same
  applies if the copy fails, or if a source grows past the limit between the
  size check and the read, and only copies that Save positively created are
  removed (if a persistence failure lands after the config write, the copies
  the persisted text references are kept, matched against the parsed saved
  config). Cancel at any level copies
  nothing, and a pasted path must remain separated by spaces from surrounding
  text — a path glued to adjacent text fails Save with a message asking for
  the separating space. A pasted image therefore has to
  be re-pasted and Saved while its source still exists (paste, then Save — do
  not close and reopen the settings menu in between without saving). Text
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
  cannot keep. Save checks every staged scheduled entry, so a pre-existing
  unobserved clipboard-temp reference also blocks an otherwise unrelated
  settings Save until that reference is removed. This gate is broader than
  the copy recognition: any `pi-clipboard-...` reference without an observed
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

Entries are created and edited under **Scheduled tasks** in `/review-settings`,
staged like every other section behind **Save changes** / **Cancel**. Save
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
`PI_REVIEW_GATE_CONFIG`, see [Config discovery](#config-discovery)), while
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

## Web fields

```json
{
  "web": {
    "enabled": true,
    "browserInteractionApproval": "ask",
    "browserVisible": false,
    "browserIdleExpiryMinutes": 15,
    "browserDownloadRetention": 8,
    "browserPermissions": {
      "modelCredentialEntry": false,
      "modelCredentialSubmission": false,
      "modelUploads": false,
      "modelDownloadSaving": false,
      "modelClipboard": false,
      "modelCamera": false,
      "modelMicrophone": false,
      "modelGeolocation": false,
      "modelServiceWorkers": false,
      "modelPopupRestrictionOverride": false,
      "localNetworks": false,
      "yolo": false
    },
    "search": { "provider": "ddgs", "timeoutMs": 20000, "maxResults": 10 },
    "fetch": {
      "timeoutMs": 30000,
      "maxDownloadBytes": 52428800,
      "maxOutputChars": 12000,
      "cacheMaxBytes": 67108864,
      "cacheMaxEntries": 32,
      "userAgent": "pi-review-gate/0.1 (+native web research)"
    }
  }
}
```

`web.browserIdleExpiryMinutes` is a non-negative safe integer number of minutes
(default **15**). Edit it through `/review-settings` → **Web** → **Browser idle
expiry**, then **Save changes**. **0 disables idle close**: the session never closes
for inactivity and stays open until an explicit `BrowserClose`, shutdown, replacement,
or unrecoverable failure. Fractions, negative, and nonfinite values are rejected.
The browser lifecycle contract is renewed by browser-tool activity and by detectable
genuine human input in the live page (browser-trusted pointer presses, keyboard input,
and wheel scrolling, authenticated so page script cannot forge it), not by background
page requests, scripts, or WebSockets, and does not expire during an active browser
operation. For hands-on human use of a visible browser, prefer setting the timeout to
`0` so it cannot disappear mid-interaction. Both initial tool registration and live
settings updates apply this persisted value to the managed browser in both directions
(timed ↔ disabled). Expired handles explicitly require `BrowserOpen`; no lost state is
silently recreated.

`web.browserDownloadRetention` is a non-negative safe integer (default
**8**). Edit it through `/review-settings` → **Web** → **Download retention**,
then **Save changes**. It is the maximum number of unsaved downloads retained per
interactive-browser session: while the cap is reached, a new download cancels and
releases the oldest retained one (after a live lowering, the next arrival drains
down to the new cap and may release more than one). Saved files are never
counted or affected, and
the ordinary save, tab/session-close, and capability-revocation cleanups always
apply. **0 disables count-based eviction entirely**: every pending download stays
retained until it is saved, its tab or session closes, or the capability is
revoked. Fractions, negative, and nonfinite values are rejected. A changed value
takes effect when the next download arrives — a live lowering never deletes
already-retained pending downloads merely because the setting was edited — and
both initial tool registration and live settings updates apply this persisted
value to the managed browser.

`web.browserVisible` is a boolean (default **false**). Edit it through
`/review-settings` → **Web** → **Browser visibility**, then **Save changes**. **false**
keeps the default headless QA browser (no window); **true** launches the interactive
browser headed — a real browser window with a native address bar the human can use
directly. The model's tool set and exposure are identical in both modes; there is no
model-facing visibility control, no persistent profile, and no remote-control port in
either mode. Saving a changed value applies it immediately to the live browser through
a controlled close/reopen replacement (tabs, active page, and memory-only session
state restored best-effort with truthful loss/redirect reporting; the model-facing
handles are replaced and the old ones are rejected). With no open browser it applies
at the next `BrowserOpen`, and saving the already-active value restarts nothing.
Cancel in the settings menu never relaunches. For hands-on human use of a headed
window, prefer also setting `browserIdleExpiryMinutes` to `0`. See
[Web tools](web-tools.md#browser-visibility) for the full replacement semantics and
their limits.

`web.browserInteractionApproval` accepts exactly `"ask"` (default),
`"automatically-accept"`, or `"automatically-deny"`. Omission uses Ask; invalid values
(including `null`, booleans, and display labels such as `"Ask"`) reject configuration
loading rather than silently granting approval. This policy applies only to the
confirmation-required branch of authorized native `BrowserClick`, `BrowserFill`,
`BrowserType`, `BrowserSelect`, `BrowserPress`, `BrowserUpload`, `BrowserDownloadSave`,
and `BrowserClipboard`; it does not turn off hard-denied
actions, role authorization, SSRF controls, ref/target/value-digest revalidation, or
value-secrecy protections. See [approval behavior](web-tools.md#browser-interaction-approval).

`web.browserPermissions` holds the independently selectable managed-browser
permission toggles from
[#27](https://github.com/rfairburn/pi-review-gate/issues/27). Every field is a
boolean that defaults to **false**, so default browser behavior is unchanged
unless a capability is explicitly enabled; there is no restricted/intermediate/
unrestricted level ladder and no role scheme.

- `modelCredentialEntry` lets the model enter values into password/credential fields.
- `modelCredentialSubmission` lets the model submit forms containing credentials.
- `modelUploads` lets the model upload explicitly chosen host files through
  `BrowserUpload`; `modelDownloadSaving` lets it save retained pending downloads
  through `BrowserDownloadSave`, wherever the model's existing host write
  authority reaches (relative paths resolve to the session working directory;
  absolute paths are not fenced by the browser). File selection and side effects
  follow the configured `web.browserInteractionApproval` policy, and no mandatory
  human picker is introduced; while either is disabled (the default) the
  corresponding tool is denied before any approval prompt.
- `modelClipboard` lets the model read or replace text on the browser
  clipboard of an owned tab through `BrowserClipboard`. It is text-only — no
  binary or image formats and no file paste — and always follows the configured
  `web.browserInteractionApproval` policy; while disabled (the default) the
  tool is denied before any approval prompt. Headless Chromium uses its
  per-instance virtual clipboard; headed desktop Chromium reaches the host
  system clipboard, and each result reports which scope was used.
- `modelCamera`, `modelMicrophone`, and `modelGeolocation` are enforced as real
per-origin device permission grants issued when a session tab commits a top-level
HTTP(S) navigation to an origin; while disabled (the default) no device grant is
issued for any origin, and disabling clears the capability's grants from live
sessions (an unconfirmable engine clear fails the affected session closed and
is reported through the save rather than claimed applied; a clear that does
not settle within the browser cleanup deadline is likewise reported as still
in flight — never confirmed applied — and its session is closed to contain any
retained grants, with the closure status reported through the save). They grant capability, not forced activation, and actual
capture still depends on host hardware, operating-system privacy prompts, and
position sources.
- `modelServiceWorkers` and `modelPopupRestrictionOverride` grant capability
only: they do not force service-worker registration or popup activation. Service
workers are blocked at context creation by default and allowed when enabled;
because the mode is pinned at launch, a saved change replaces a live browser in a
controlled way (tabs, storage state, and granted permissions restored
best-effort with every loss reported). The popup override lifts the four-tab
session limit for page-created popups while enabled; disabling it closes nothing
already adopted.
- `localNetworks` applies to **human and model** navigation alike: it allows
loopback, private, and link-local addresses including cloud metadata endpoints,
for intentional local-service and machine-role debugging.
- `yolo` is the master override: it enables every capability above and bypasses
per-action approval prompts, including an otherwise configured Ask or
Automatically Deny policy.

The `model*` fields constrain model actions only: human credential/form
submission and file uploads remain allowed regardless of them. Unknown keys
inside `web.browserPermissions` are ignored and never grant capabilities; a
non-boolean value for any known field rejects configuration loading rather than
silently granting or dropping authority (startup recovery drops only the invalid
fields, with warnings).

**Enablement semantics.** In `/review-settings`, every YOLO off → on transition
requires a prominent warning plus explicit interactive human confirmation;
cancellation, an unavailable confirm dialog, or a failed save leaves it off. It
persists until explicitly disabled (disabling is straightforward and needs no
confirmation), the enabled state is shown prominently, and the individual values
saved beneath the override are preserved so disabling restores them as the
effective policy. Enabling YOLO in the configuration file follows the existing
loading philosophy: a strict, valid value takes effect on next load — editing
the file is itself the explicit human act — and no acknowledgment token is
stored or invented for it.

**Status.** Model credential entry (`modelCredentialEntry`) and model credential
submission (`modelCredentialSubmission`) are enforced by the interactive-browser
tool actions: while disabled, the gated action is denied before any approval
prompt with a precise error naming the disabled permission; while enabled, it
proceeds through the ordinary interaction-approval flow. Settings saved through
`/review-settings` apply to the live session for these two capabilities.
`localNetworks` (and YOLO) is enforced by the interactive egress broker and
navigation preflight: while disabled, loopback, private, link-local, and
cloud-metadata destinations are refused before any request or dial; while
enabled, they are admitted with the same resolve-once-and-pin validation as
public addresses. Saved changes apply to live sessions without a restart;
disabling revokes only established local connections and refuses subsequent
local admissions. `WebFetch` and `BrowserExtract` remain public-only.
Model uploads (`modelUploads`) and model download saving
(`modelDownloadSaving`) are enforced by `BrowserUpload` and
`BrowserDownloadSave`: while disabled, those tools are denied before any
approval prompt with a precise error naming the disabled permission; while
enabled, they proceed through the ordinary interaction-approval flow with
one-use revalidated permits. Saved changes apply to the live session;
revoking download saving cancels and drops every retained pending download
immediately. Model clipboard read/write (`modelClipboard`) is enforced by
`BrowserClipboard`: while disabled, both operations are denied before any
approval prompt with a precise error naming the disabled permission; while
enabled, they proceed through the ordinary interaction-approval flow with
one-use revalidated permits and a real per-origin browser permission grant for
the approved operation's origin (headless Chromium uses its per-instance
virtual clipboard; headed desktop Chromium reaches the host system
clipboard). Saved changes apply to the live session; revoking it clears every
issued clipboard permission grant, and an unconfirmable engine clear fails the
affected session closed (reported through the save) instead of being claimed
applied; a clear that does not settle within the browser cleanup deadline is
likewise reported as still in flight — never confirmed applied — and its
session is closed to contain any retained grants, with the closure status
reported through the save. Camera (`modelCamera`),
microphone (`modelMicrophone`), and geolocation (`modelGeolocation`) are
enforced as real per-origin device permission grants: while disabled, no
device grant is issued for any origin; while enabled, a grant scoped to that
origin only is issued when one of the session's tabs commits a top-level
HTTP(S) navigation there, re-evaluating the current effective policy at every
commit. Saved changes apply to the live session immediately: disabling clears
every issued grant for that capability at once while leaving the other enabled
capabilities' grants intact (an unconfirmable engine clear fails the affected
session closed and is reported through the save rather than claimed applied; a
clear that does not settle within the browser cleanup deadline is likewise
reported as still in flight — never confirmed applied — and its session is
closed to contain any retained grants, with the closure status reported
through the save), and enabling takes effect from the next applicable navigation commit. Actual capture still depends on host hardware,
operating-system privacy prompts, and position sources; the manager grants
permission state only and reports failures truthfully. Service workers
(`modelServiceWorkers`) are enforced at context creation — blocked by default,
allowed when enabled — and because Chromium pins that mode at launch, a saved
change replaces a live browser in a controlled way (tabs, storage state, and
granted permissions restored best-effort with every loss reported) while all
service-worker traffic still egresses only through the authenticated broker.
The popup restriction override (`modelPopupRestrictionOverride`) lifts the
four-tab session limit for page-created popups while enabled; disabling it
closes nothing already adopted and only refuses further over-limit adoptions.
Full semantics, including the service-worker WebSocket admission limitation,
are documented in [Web tools](web-tools.md#browser-permissions-issue-27).
The effective policy is computed by `effectiveBrowserPolicy` in `src/web/browser-capabilities.ts`;
YOLO-approved actions are automatic approvals and must never be reported as human-confirmed.

These are the defaults; every value can be overridden under `web`. The Python bridge for
`WebSearch` is deliberately not configurable. Tool behavior and the trusted environment
boundaries are owned by [Web tools](web-tools.md) and
[Security model](security-model.md#web-egress-hardening).

## `/review-settings`

`/review-settings` opens one staged settings transaction with fourteen sections:

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
  [Review layers](#review-layers-and-the-legacy-activereviewers-import).
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
  the conservative active subset plus `search_tools`. For new mutation-authorized
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
  five-field Unix cron schedule in machine-local time, execute/research kind,
  instructions, explicit authorized workspace directory, an optional worker
  override picked from the worker-resource catalog (never from the global role
  routes; research-capable only for research tasks), an optional task-local
  review choice (**Inherit global subtask review settings**, **Off — run this
  task's subtasks without review**, or a selected reviewer set), and an
  enabled/disabled toggle. Adding prompts for a name and generates a stable
  identity; required-but-unset fields block Save with a named validation error.
  Entries stay visible and editable regardless of the **Scheduler runtime**
  switch, and saving never clears entries. See
  [Scheduled task fields](#scheduled-task-fields).
- **Scheduler runtime** (shown when the host runtime provides the switch) is a
  live, current-process-only On/Off toggle for scheduled execution: it applies
  immediately, is never persisted in the config file, and stays outside the
  staged Save/Cancel transaction. See
  [Scheduled task fields](#settings-behavior-and-process-visibility).
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
  session without a restart; see [Web fields](#web-fields).

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
[Scheduled instruction images](#scheduled-instruction-images) — the pasted
temporary path is validated by content, copied there, and replaced by the
managed absolute path before the config write. There is no second editor or
clipboard surface; recognition for this persistence stays bounded to Pi's
clipboard temp naming and this config's own managed store root.
Enter submits the field's own text (never a chat message); Esc first dismisses a
visible completion list, then cancels the field, leaving the staged value
unchanged. The scheduled-task **workspace** field uses this same surface with one
field-scoped addition: it opts into native absolute-path completion. A first-line
token that starts with `/` and contains no space (`/`, `/var`, a nested absolute
path) gets the host provider's own filesystem suggestions in its ordinary
file-list layout — never slash-command items, so a nonexistent token such as
`/subtasks` simply lists nothing instead of offering commands. No second
completer is involved: the field decorates only the host-provided autocomplete
provider through the public `setAutocompleteProvider` seam, forcing that
provider's own file branch for those tokens and masking the returned prefix's
leading slash with a same-length neutral sentinel so the editor renders the file
list (not the two-column command layout) and applies a path (never `/command `
text). Everything else is unchanged: relative paths, `~/...`, the fd-backed `@`
picker, Ctrl+C clear, Ctrl+G external editing, image paste, Shift+Enter
newlines, Esc-dismisses-the-list-first, and the chat draft all behave exactly as
in the shared main-chat editor, and every other settings field — and
AskUserQuestion — keeps that shared behavior unchanged, where a line starting
with `/` remains the host editor's slash-command context. Token recognition,
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
