# Configuration

This page owns the raw configuration reference: config discovery, kill switches, every
JSON field with its default, operating modes and the mode-cycle hotkey, reviewer
selections, catalogs, and imports, delegated-execution defaults, Web fields, and legacy
compatibility. The staged `/review-settings` menu is documented on the
[Settings menu](settings.md#review-settings) page, and the scheduled-task feature guide
lives on [Scheduled tasks](scheduled-tasks.md#scheduled-task-fields). Runtime behavior
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
| `maxSnapshotBytes` | `52428800` | Bounds cumulative non-ignored untracked file bytes in private task capture (50 MiB) and textual content retained for parent review diffs; it does not truncate durable checkpoint content (see [Review workflow](review-workflow.md#review-windows-and-evidence)). |
| `waveArtifactTtlMs` | `2592000000` (30 days) | Age after which completed non-recovery wave artifact roots are garbage-collected; `0` disables collection. |
| `retainBundles` | `"on-failure"` | Review-bundle retention policy: `never`, `on-failure`, or `always`. `always` disables age-based wave GC while the application is running. |

## Operating modes

Choose **Operating mode** in `/review-settings`, then **Save changes**:

- **Prefer execution**: favor focused direct implementation; delegate when useful.
- **Prefer orchestration** (default): favor bounded delegation; the primary assistant
  remains responsible for integration and verification.
- **Plan/research**: local read-only investigation and planning. Write-capable tools,
  arbitrary shell, execution-subtask controls, and the `codemode` script transport are
  removed from the active tool schemas, authorized inventory, and `tool_search`
  results. Launch-authorized native read-only discovery (`grep`, `find`, `ls`) stays
  active in every mode. The structured
  read-only Git history tool `GitRead` is active only in this mode: available from the
  first request (no `tool_search` step) and removed from the active set, inventory,
  and search results in every other mode. When changes are needed, the assistant asks
  you to switch modes; there is no GitHub-writing exception.

The next normal run in the same conversation receives the replacement mode prompt:
no `/new`, reload, or restart is needed. Shared safety and review instructions and user
append prompts remain. An in-flight run retains its prompt, and already-running subtasks
retain their captured instructions and authority. Cancelling settings leaves the mode
unchanged. Returning to a write-capable mode restores tools within the
session's current authorization boundary — including natively reconciled MCP/codemode
registrations (see [Native Pi tools](native-pi-tools.md#reconciliation-during-a-running-session))
— not tools that were disabled at launch.

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
  "externalAgents": {
    "codex": {
      "adapter": "codex-cli",
      "review": { "timeoutMs": 600000 }
    },
    "claude": {
      "adapter": "claude-cli",
      "review": { "timeoutMs": 600000 }
    }
  },
  "review": {
    "primaryReviewers": [
      { "source": "external", "id": "codex" },
      { "source": "external", "id": "claude" }
    ],
    "subtaskReviewers": [
      { "source": "external", "id": "codex" },
      { "source": "external", "id": "claude" }
    ]
  }
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

That block shows the selection layer only, not a standalone config: it assumes an
`externalAgents.codex-sol` catalog entry (see [The `externalAgents` catalog](#the-externalagents-catalog))
and, for live resolution, that the Pi model is currently scoped.

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
successful subtask review advances parent checkpoint bookkeeping for its independently
reviewed paths at the landing boundary, without checkpointing away unrelated parent
edits; it is not re-reviewed in the primary window. The private subtask capture,
candidate review, and landing are unchanged. Primary review always settles at the
primary model's normal idle point, exactly like any other primary exchange; a landing never
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
selections remain separate from the orchestrator. Native external harness reasoning
uses optional `reasoningEffort` fields on each
`externalAgents` entry and its `execution`/`review` roles (see
[Native reasoning effort](#native-reasoning-effort)). Untouched legacy Claude/Codex
argument-based settings remain compatible; arbitrary binary adapters may still use
their own arguments or environment variables.

### The `externalAgents` catalog

`externalAgents` is one configured catalog shared by both menus: an object keyed by
stable agent ID, where each value has an optional `review` role, `execution` role, or
both. Role sections can override shared environment, model, and reasoning effort,
plus the global role timeout, so one harness can use different limits for review and execution. Raw JSON
also supports legacy arguments and adapter-specific protocols; these are not native
Claude/Codex editor controls. An inactive external definition does not need to be
installed. Missing Claude Code or Codex CLI
binaries produce a warning when settings are saved, including for selected workers,
but do not prevent saving; those workers will fail until their CLI is installed or
available on `PATH` for definitions created or applied through the native editor.
Untouched custom commands remain compatible. Runtime command failures remain errors.
Other adapters retain their existing executable validation. Pi-scoped internal models
are never copied into the external catalog.

The legacy array form (entries carrying their own `id`) is deprecated but still
imported at load time and converted to the keyed object, preserving every identity,
reference, and setting. That import support will be removed in a future version without
a fixed date or version ([#116](https://github.com/rfairburn/pi-review-gate/issues/116));
save the canonical object form now — `/review-settings` saves already write it. The
worker catalog follows the same shape and deprecation; see
[Delegated execution](delegated-execution.md#worker-resources-routes-and-concurrency).

### Create external workers in the settings menu

Open `/review-settings` → **External workers** to list every configured definition.
Choose **Create worker** to add a **Claude Code** or **Codex CLI** definition without
editing JSON. Choose a unique identifier and application, enable execution, review,
or both roles, then use the human-readable **Model** and **Reasoning** controls.
Timeout fields remain editable: an unset role model inherits Shared and an unset
timeout inherits the global role timeout. The native editors offer no shared/role
environment key/value editing or entry counts. Environment variables are configured
by editing the JSON file directly — `env` on the entry and on each role section
remains valid schema honored at runtime — and Apply, rename, and unrelated staged
edits preserve existing shared/role environment entries while the roles remain
enabled (disabling a role drops that role's overrides, including its environment).

Create/Apply automatically stores `command: "claude"` or `command: "codex"` and uses
the existing fixed native transport. There are no **Application executable**, literal
argument-list, or protocol-override controls. Generic/binary creation is not offered;
existing unsupported definitions are listed with **Delete** and **Back** only.
Authenticate through the CLI's own login/configuration; do not enter credentials
into the settings file. No editor row offers environment editing or displays
environment values or entry counts.
Existing read-only research and review safeguards are unchanged.

Creating a definition only adds it to the settings draft. Before saving, explicitly
add it through **Worker resources** for execution, or select it in the primary and/or
subtask reviewer sets under **Reviewers** for review. Only configured roles appear
in their supported selectors. Creating, listing, or editing a definition
never enrolls it in a resource or reviewer pool or invokes a provider.
**Save changes** saves the definitions together
with explicit resource, route, and reviewer selections; reopening/reloading retains
them. Cancel or leaving the root menu with Escape discards the current edits.
Untouched definitions and unrelated configuration are preserved; conflicting
catalog changes by another writer are rejected rather than overwritten. Missing
Claude Code or Codex CLI binaries warn rather than block Save, whether the definition
is selected or inactive. The warning identifies affected workers and explains that
they cannot run until their executable is available. Saving does not install a CLI,
authenticate it, or convert a failed run into success.

#### Manage existing external workers

Existing and newly created **Claude Code** and **Codex CLI** definitions are editable,
including their ID, adapter, roles, models, reasoning effort, and
timeouts. Environment variables are edited only in the JSON file: manual `env`
configuration remains fully supported and is preserved by Apply, rename, and other
edits while the roles remain enabled. A missing binary does not make a supported type read-only. **Keep current**
preserves custom or pinned shared/role model strings until an explicit replacement
or unset choice. Model or adapter changes must resolve incompatible reasoning
explicitly; Apply never silently resets it.

Only the definition being created or edited is normalized on **Create**/**Apply**.
The editor imports recognized legacy Claude `["--effort", "high"]` or Codex
`["-c", "model_reasoning_effort=\"high\""]` arguments into structured `reasoningEffort`.
Valid levels are migrated; identical duplicates are canonicalized with a warning,
while conflicting or unverified levels require an explicit valid choice. All other
advanced arguments, native protocol overrides, and custom executable paths are
removed from that edited definition in favor of automatic native settings. Before
staging at Apply, clear warnings identify the definition, Shared/execution/review
scope, and counts/categories of affected options, not raw arguments, environment
values, secrets, or paths. Root Cancel still discards the staged normalization.
Opening, Back, Cancel, or root Save of unrelated changes never normalizes untouched
native or unsupported entries from the current catalog. Legacy JSON
arguments, custom commands, environment, timeouts, and models remain compatible in
untouched configurations; this is not a global removal of argument or environment
fields, and Apply itself preserves the edited definition's existing shared/role
environment entries while its roles remain enabled.

Renaming updates resource selections and primary, subtask, and scheduled reviewer
references together. Resource IDs, route order, and scheduled resource pins remain
unchanged: these refer to the same resource, not directly to the renamed definition.
Invalid or duplicate IDs do not partially change the catalog or its references.

Every supported definition has **Delete** directly alongside **Apply** and **Cancel**
in its existing editor, with no extra action submenu. Delete targets the original
selected identity even after an unapplied local ID rename, ignoring other unapplied
edits. A newly created staged definition is also deletable. For unsupported adapter
types, opening an entry offers only **Delete** and **Back**; there is no editor or
separate viewer. **Delete** removes that definition, resources
selecting it, their route entries, and primary/subtask/scheduled reviewer references.
If a scheduled task loses its pinned resource or its explicit reviewer set becomes
empty, the task is disabled and only the invalid pin or review override resets to
inheritance. Other task settings and remaining reviewers are retained. The menu
reports removed references, disabled tasks, and inheritance resets; a later explicit
re-enable uses the configured defaults rather than the deleted worker.

Edits, renames, and deletion cascades are staged until root **Save changes**. Root
Cancel or Escape discards them together. Saving rejects conflicting catalog changes
rather than overwriting another writer's definition. These controls do not add guided
configuration for generic executables or change runtime adapter safeguards.

#### Release-maintained CLI model catalogs

The creation and editing flows use separate bundled catalogs with human labels,
not Pi-scoped model names or live provider discovery:

| Application | Label | Stored model ID |
| --- | --- | --- |
| Claude Code | Opus 5.5 | `claude-opus-5-5` |
| Claude Code | Fable 5.1 | `claude-fable-5-1` |
| Claude Code | Sonnet 5.5 | `claude-sonnet-5-5` |
| Claude Code | Haiku 4.5 | `claude-haiku-4-5` |
| Codex CLI | GPT-6.1-Sol | `gpt-6.1-sol` |
| Codex CLI | GPT-6-Astra | `gpt-6-astra` |
| Codex CLI | GPT-6-Sol | `gpt-6-sol` |
| Codex CLI | GPT-6-Luna | `gpt-6-luna` |
| Codex CLI | GPT-5.6-Sol | `gpt-5.6-sol` |
| Codex CLI | GPT-5.6-Terra | `gpt-5.6-terra` |
| Codex CLI | GPT-5.6-Luna | `gpt-5.6-luna` |
| Codex CLI | GPT-5.5 | `gpt-5.5` |

Unset/inherited model choices leave selection to existing configuration and CLI
defaults. There is no manual-model fallback in creation. Existing custom or pinned
strings, including mutable aliases, can be kept without replacement.

The lists are verified against the official
[Claude Code model configuration](https://code.claude.com/docs/en/model-config) and
[Codex models](https://developers.openai.com/codex/models) documentation and maintained
with review-gate releases. Catalog data and verification provenance live in
`src/settings/external-agent-models.ts`; the Codex catalog was verified against
Codex CLI 0.160.0 on 2026-10-05. Release maintenance must recheck those upstream sources
and update catalog values and verification provenance when supported choices change.
A catalog entry is a known CLI selection, not proof of account access: availability
and alias resolution depend on CLI version, authentication, provider, plan, and
organization policy. Settings do not probe a provider, start one, or authenticate
on your behalf, and a release catalog does not guarantee support by the installed
CLI or account entitlement.

#### Native reasoning effort

Optional `reasoningEffort` is stored at Shared and/or `execution`/`review` scope.
An absent role field inherits Shared. An explicit role `"default"` suppresses any
inherited effort and supplies no app-owned effort: **CLI default** means the CLI's
own settings, not off or no thinking. Shared `"default"` or no shared effort also
delegates to the CLI.

Reasoning choices come from the selected/effective model's bundled capabilities,
not generic Pi thinking levels. Native levels include `low`, `medium`, `high`,
`xhigh`, and `max` only where supported; **Max** is distinct from **Extra High** (`xhigh`).
Codex **Ultra — automatic task delegation** is offered only for models whose
capabilities include `ultra`. Claude Haiku 4.5 has no effort control beyond CLI
default. Mutable aliases, unknown strings, and unset CLI-default models preserve
their model value but offer only CLI default reasoning because new levels cannot
be verified. There is no generic `off` or `minimal` choice.

Create/Apply validates every effective enabled role, including inherited Shared
effort against a role-specific model. Existing invalid, unverified, or conflicting
effort, or a model change that invalidates a level, blocks Create/Apply until you
explicitly choose a known model with compatible effort or CLI default. Compatible
existing effort is preserved; there is no silent reset or fallback.

```json
{
  "externalAgents": {
    "claude": {
      "adapter": "claude-cli",
      "command": "claude",
      "model": "claude-sonnet-5-5",
      "reasoningEffort": "high",
      "execution": {},
      "review": { "reasoningEffort": "default", "timeoutMs": 600000 }
    },
    "codex": {
      "adapter": "codex-cli",
      "command": "codex",
      "model": "gpt-6.1-sol",
      "reasoningEffort": "high",
      "execution": {},
      "review": { "reasoningEffort": "default" }
    }
  }
}
```

Here execution inherits High; review uses CLI default without inheriting High.
Runtime centrally generates canonical Claude `["--effort", "high"]` or Codex
`["-c", "model_reasoning_effort=\"high\""]` arguments with only one effective effort.
This does not change native transport or safety enforcement.

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

## Native Pi tool surfaces (MCP and codemode)

On the supported Pi versions (see [Getting started](getting-started.md#prerequisites)),
review-gate integrates with Pi's native MCP and codemode surfaces without taking any of
them over. The concise rules:

- Sessions started through the review-gate launcher forward your arguments unchanged
  and pass no `--tools` value of their own; the review-gate default there is
  availability, not activation: the registered `codemode` tool is admitted to the
  session's authorized catalog where Pi's registry carries it and no explicit
  restriction removed it. Explicit Pi `--tools`/`--exclude-tools`/`--no-tools`
  restrictions remain authoritative and are never broadened; a manual extension-only
  load gets no new default.
- `codemode` follows the ordinary deferred-tools toggle
  (`execution.deferredPiTools`): with the default On it is discoverable through
  `tool_search` but never part of the initial-active subset, so the model loads it
  before use; with the toggle Off ordinary permitted tools, including `codemode`,
  load without review-gate deferral. Native MCP exposure and Pi's loading choices
  still apply: Off does not force codemode/deferred MCP tools into direct declarations.
  Plan/research sessions and research roles exclude it entirely — and, alongside it,
  all MCP tools are off for research by default: the read-only role boundary admits no
  MCP tool names through the direct, script, or deferred channels, so there is no
  default MCP exposure or callable MCP tool there, no `readOnlyHint` opt-in, and no
  researcher override; the toggle never grants a research-forbidden tool.
- Delegated Pi workers inherit `codemode` only through the parent's captured worker
  catalog; the captured worker ceiling never widens after capture, and withdrawn or
  hidden names become absent and unusable within it. Review-gate adds no MCP server
  manager, project-trust grant, credential flow, exposure editor, or annotation-based
  permission policy: server configuration, trust, credentials, exposure, and
  permissions stay with Pi. Enabled, permitted MCP tools are discoverable through
  `tool_search`; disabled, hidden, or withdrawn names are not. Review-gate's guards
  and existing evidence policy apply to
  MCP and codemode calls like any other tool call.

Behavior details — the builtin `tool_search` replacement, in-session reconciliation,
and the nested-call guards — are owned by
[Native Pi tools](native-pi-tools.md#one-loader-replaces-pis-builtin-tool-search).

## Scheduled task fields

`scheduledTasks` is an unordered catalog keyed by each task's stable identity; every
schedule entry is stored exactly once in this catalog, and the cron timer and dispatch
that run these entries are part of the scheduled-run runtime. The complete field
reference — catalog shape and defaults, inheritance and overrides, schedule destinations,
scheduled instruction images, local time and daylight saving, settings behavior and
process visibility, and runtime dispatch — is owned by the
[Scheduled tasks](scheduled-tasks.md#scheduled-task-fields) page.

### Inheritance and overrides

See [Inheritance and overrides](scheduled-tasks.md#inheritance-and-overrides) on the
Scheduled tasks page.

### Schedule destinations

See [Schedule destinations](scheduled-tasks.md#schedule-destinations) on the Scheduled
tasks page.

### Scheduled instruction images

See [Scheduled instruction images](scheduled-tasks.md#scheduled-instruction-images) on
the Scheduled tasks page.

### Local time and daylight saving

See [Local time and daylight saving](scheduled-tasks.md#local-time-and-daylight-saving)
on the Scheduled tasks page.

### Settings behavior and process visibility

See [Settings behavior and process visibility](scheduled-tasks.md#settings-behavior-and-process-visibility)
on the Scheduled tasks page.

### Runtime dispatch

See [Runtime dispatch](scheduled-tasks.md#runtime-dispatch) on the Scheduled tasks page.

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
[Browser guide](browser.md#browser-visibility) for the full replacement semantics and
their limits.

`web.browserInteractionApproval` accepts exactly `"ask"` (default),
`"automatically-accept"`, or `"automatically-deny"`. Omission uses Ask; invalid values
(including `null`, booleans, and display labels such as `"Ask"`) reject configuration
loading rather than silently granting approval. This policy applies only to the
confirmation-required branch of authorized native `BrowserClick`, `BrowserFill`,
`BrowserType`, `BrowserSelect`, `BrowserPress`, `BrowserUpload`, `BrowserDownloadSave`,
and `BrowserClipboard`; it does not turn off hard-denied
actions, role authorization, SSRF controls, ref/target/value-digest revalidation, or
value-secrecy protections. See [approval behavior](browser-permissions.md#browser-interaction-approval).

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
are documented in [Browser approvals and permissions](browser-permissions.md#browser-permissions-issue-27).
The effective policy is computed by `effectiveBrowserPolicy` in `src/web/browser-capabilities.ts`;
YOLO-approved actions are automatic approvals and must never be reported as human-confirmed.

These are the defaults; every value can be overridden under `web`. The Python bridge for
`WebSearch` is deliberately not configurable. Tool behavior and the trusted environment
boundaries are owned by [Web tools](web-tools.md) and
[Security model](security-model.md#web-egress-hardening).

## `/review-settings`

The staged settings menu is documented on the [Settings menu](settings.md#review-settings)
page: its seventeen ordinary rows, the conditional **Scheduler runtime** row, Save/Cancel
staging and apply semantics, and the shared native text-field behavior. Raw field values
and defaults stay in this reference — see [Top-level fields](#top-level-fields),
[Operating modes](#operating-modes), [Reviewers](#reviewers), and
[Web fields](#web-fields) — and scheduled-task semantics are owned by
[Scheduled tasks](scheduled-tasks.md#scheduled-task-fields).
