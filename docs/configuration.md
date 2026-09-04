# Configuration

This page owns the complete configuration reference: config discovery, every JSON field
with its default, the `/review-settings` UI, and legacy compatibility. Runtime behavior
described only briefly here is owned by the linked page.

## Config discovery

- `PI_REVIEW_GATE_CONFIG=/path/to/review-gate.json` selects the config file explicitly.
- The persistent launcher (`scripts/pi-review-gate.sh`) selects the first existing file
  from `~/.config/pi-review-gate/config.json` or `~/.config/pi/review-gate.json` and
  deliberately re-resolves (and re-exports) the variable so an inherited value from a
  parent pi session cannot silently redirect the gate elsewhere.
- With no config file found, `enabled` defaults to `false`, so automatic review does not
  run — but the extension still loads `WebSearch`, `WebFetch`, `ApplyPatch`, and the
  background shell. Model-facing subtask tools require at least one resolvable configured
  worker resource. Only `PI_REVIEW_GATE_DISABLED` disables the whole extension.
- The config file must be a JSON object; invalid JSON or shapes fail with an error.

## Kill switches

- `PI_REVIEW_GATE_DISABLED=1` (truthy values `1`, `true`, `yes`) is the environment kill
  switch: it disables the whole extension, including delegated execution. The launcher
  warns loudly when it is set instead of silently swallowing it.
- Top-level `enabled: false` is the automatic-review master switch only. It does **not**
  disable configured worker routes.
- Clearing every reviewer in `/review-settings` disables automatic review without
  disabling delegated execution.

## Top-level fields

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Automatic-review master switch (see kill switches above). |
| `reviewerTimeoutMs` | `600000` | Default reviewer timeout (10 minutes). |
| `executorTimeoutMs` | `1800000` | Default executor timeout (30 minutes). |
| `maxCorrectionCycles` | `1` | Correction budget before feedback is classified as deferred. |
| `implementationGuidanceAfterCorrectionAttempts` | `1` | Threshold that strengthens review requests with concrete implementation guidance (see [Review workflow](review-workflow.md#corrections-guidance-and-the-correction-cap)). |
| `maxPatchBytes` | `200000` | Bound for retained patch content. |
| `maxFileBytes` | `1048576` | Bound for retained individual file content. |
| `maxSnapshotBytes` | `52428800` | Bounds the cumulative size of non-ignored untracked files during task capture (50 MiB) and the textual file content retained for ordinary review snapshots. |
| `waveArtifactTtlMs` | `2592000000` (30 days) | Age after which completed non-recovery wave artifact roots are garbage-collected; `0` disables collection. |
| `retainBundles` | `"on-failure"` | Review-bundle retention policy: `never`, `on-failure`, or `always`. `always` disables age-based wave GC while the application is running. |

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

Pi and the selected provider own reasoning effort and token-budget behavior;
review-gate does not impose a second output-side thinking cap. Reviewer and executor
selections remain separate from the orchestrator. External harness reasoning is
configured natively through `externalAgents[].review.args` and
`externalAgents[].execution.args` (for example a Codex CLI role can use
`["-c", "model_reasoning_effort=\"high\""]`, Claude Code can use
`["--effort", "high"]`, and arbitrary binary adapters may use their own arguments or
environment variables).

### The `externalAgents` catalog

`externalAgents` is one configured catalog shared by both menus. Each entry has an
optional `review` role, `execution` role, or both. Role sections can override shared
arguments, environment, model, protocol, and timeout, so one harness can use different
limits for review and execution. An inactive external definition does not need to be
installed; its command is checked when that definition is selected or run. Pi-scoped
internal models are never copied into the external catalog.

### Legacy compatibility

The older single `decider` field is still supported, as are `reviewers`,
`enabledReviewerIds`, and `execution.externalExecutors`. A successful `/review-settings`
save migrates their definitions into `externalAgents`.

## Delegated execution fields

The `execution` block (`workerResources`, `routes`, `maxWorkers`,
`subtaskNotifications`, `deferredPiTools`, `retryPolicy`) and the reviewer/execution route matrix are
documented with the behavior they control in
[Delegated execution](delegated-execution.md#worker-resources-routes-and-concurrency).
A complete end-to-end example is `examples/delegated-execution.json`.

Defaults: `execution.maxWorkers` is `4` (allowed range 1–16) and
`execution.subtaskNotifications` defaults to `quiet`. `execution.deferredPiTools`
defaults to `true`. The default retry policy is
`maxRetries: 2`, `baseDelayMs: 1000`, `maxDelayMs: 15000`, `jitter: true`,
`maxSameIncidentRepeats: 2`.

## Web fields

```json
{
  "web": {
    "enabled": true,
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

These are the defaults; every value can be overridden under `web`. The Python bridge for
`WebSearch` is deliberately not configurable. Tool behavior and the trusted environment
boundaries are owned by [Web tools](web-tools.md) and
[Security model](security-model.md#web-egress-hardening).

## `/review-settings`

`/review-settings` opens one staged settings transaction with thirteen sections:

- **Worker resources** defines Pi-scoped models and execution-capable entries from
  `externalAgents`, each with one physical maximum concurrency shared by every
  background-task kind.
- **Execution priority** and **Research priority** are independently ordered subsets of
  those resources. Either route can exclude a resource. Per-route reasoning lets the
  same local model use different effort without creating a second capacity bucket.
- **Reviewers** is a multi-selection, `/scoped-models`-style picker over the same
  Pi-scoped models plus review-capable entries from `externalAgents`. Clearing every
  reviewer is valid and disables automatic review without disabling delegated execution.
  Each selected internal reviewer has its own **Reasoning** row.
- **Timeouts** edits the default reviewer and executor timeouts in minutes. Explicit
  `externalAgents[].review.timeoutMs` and `externalAgents[].execution.timeoutMs` values
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
  the conservative active subset plus `search_tools`. Newly launched Pi subtasks use the
  saved value, while already-running subtask sessions keep their launch behavior.
- **Subtasks view** stores the expanded/collapsed live-panel preference globally.
- The maximum acquisition size is also available under **Web**; saves apply to
  subsequent `WebFetch` and `BrowserExtract` acquisitions without restarting the
  application.

Escape from a submenu returns to the settings root. Escape or **Cancel** at the root
discards all staged changes; **Save changes** atomically persists every section while
preserving unrelated JSON keys.

Saved values are authoritative for execution stages that have not started.
Already-running executor and reviewer processes finish with their launch values, while
queued dispatch, waiting failover, later continuation turns, and later review cycles use
the current routes, capacities, policies, and reviewer selection. Subtask notification
mode is a delivery preference and takes effect immediately for subsequent events from
already-running tasks. Running capacity leases survive pool edits; removed entries
receive no new work. A restarted task warns when its prior runtime configuration
differs, and an executor-selection change starts a fresh native session from the durable
checkpoint instead of attaching an incompatible conversation.