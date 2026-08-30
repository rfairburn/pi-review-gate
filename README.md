# pi-review-gate

External pi extension that reviews code changes after an agent turn and sends
the complete classified review pass back to the implementing model.

## Development

```bash
npm install
npm test
```

The complete test run executes up to four test files concurrently. Use
`npm run test:fast` for the short pure/unit development loop. Use `npm test`
(or `npm run test:integration`) for the process, Git, filesystem, and end-to-end
suite before finalizing a phase. Use `npm run test:execution` for the serial
background-controller, recovery, pool, session, and tool-contract tier. For
diagnosing resource-sensitive or ordering-sensitive failures, use the full
serial fallback:

```bash
npm run test:serial
npm run check:static
npm run test:package
```

## Configuration

Point the extension at a JSON config file:

```bash
PI_REVIEW_GATE_CONFIG=/path/to/review-gate.json
```

Disable the gate:

```bash
PI_REVIEW_GATE_DISABLED=1
```

Example config using Codex as the reviewer:

```json
{
  "enabled": true,
  "reviewerTimeoutMs": 600000,
  "executorTimeoutMs": 1800000,
  "maxCorrectionCycles": 3,
  "implementationGuidanceAfterCorrectionAttempts": 1,
  "maxPatchBytes": 200000,
  "maxFileBytes": 1048576,
  "maxSnapshotBytes": 52428800,
  "waveArtifactTtlMs": 2592000000,
  "retainBundles": "on-failure",
  "decider": {
    "id": "codex",
    "adapter": "codex-cli",
    "timeoutMs": 600000
  }
}
```

Multiple reviewers can be configured with `reviewers`. They run in parallel
against the same review bundle. Review-gate waits for every reviewer and applies
a simple gate: any `needs_changes` verdict means changes are required; when no
reviewer requests changes, at least one completed `pass` is accepted even if
another reviewer has an infrastructure error; and the gate errors only when no
reviewer completes a usable review. Mixed pass/error results are classified as
`pass_with_warnings`, retain their evidence, and return every reviewer result to
the orchestrator. Each reviewer also appears once in the implementing-model
transmission.
Results from every reviewer are transmitted, including passing assessments,
non-blocking observations, guidance, disagreements, and reviewer errors.
Blocking findings are identified as required corrections; passing and
non-blocking material remains visible without becoming mandatory work. The built-in Codex, Claude,
and Pi model adapters run
as read-only agentic reviewers so they can inspect the workspace and retained
review bundle before deciding. Generic CLI reviewers remain prompt-only unless
the configured command provides its own safe read-only behavior.

Agentic reviewers may use their native read tools or strictly read-only shell
commands (`ls`, `find`, `rg`, `grep`, `sed`, `cat`, and read-only Git commands)
when the shell is their only filesystem interface. Codex starts in its
`read-only` sandbox and receives a native output schema on the initial turn. A
local no-op sandbox preflight detects platform sandbox startup failures before
a model turn is spent.
Reviewer output is parsed strictly first; a narrow fallback recovers the same
schema when a model emits an actionable non-passing result with unescaped
multiline Markdown. A passing verdict is never accepted through repair.
Sandbox startup failures remain explicit reviewer errors rather than
being mislabeled as verdict-schema failures.

Reviewer/executor stdout and stderr are retained up to 100 MiB
per stream for diagnostics; JSONL protocols are decoded incrementally with
separate bounded records, so protocol correctness does not depend on display
capture truncation.

### Native web research

`WebSearch` uses the API-key-free DDGS metasearch library. It passes the requested result count directly to DDGS, retries one empty or failed attempt, canonicalizes duplicate URLs, reports optional provider-supplied dates and weak snippets without inventing missing data, and supports `excludeDomains`. The launcher provisions the pinned Python dependency in a private cache environment and every Pi process invokes it on demand.
`WebFetch` downloads and indexes the complete selected HTML page or PDF, but
returns only a bounded structural range. Its result includes `nextIndex` when
more blocks remain. HTML results include a whole-page table inventory, possible
site-pagination URLs, and `dynamic_content_suspected`; PDF results preserve page
numbers, expose document metadata, and identify likely scanned/image-only files
when little or no text can be extracted. Use `find` on that same `WebFetch` URL
to locate text anywhere in the indexed document; an accompanying `index` starts
the case-insensitive search at that block. Continue at a returned match, table,
or `nextIndex`; while the document remains cached, no second network request is made.
A site-pagination URL is a different document and therefore a new fetch.
When reading a table index, `columns` projects exact case-insensitive header
names in the requested order; `#N` selects a 1-based column when headers are
duplicated or inconvenient.
PDFs use the same `url`, `find`, `index`, `nextIndex`, `maxChars`, and `refresh`
flow; table-column projection is currently HTML-only. PDF detection uses both
the HTTP content type and file magic, and password-protected, corrupt, or
oversized documents fail explicitly.

`BrowserExtract` is the rendered-page extraction fallback. Use it only after
`WebFetch` reports `dynamic_content_suspected` or plausibly fails because the
result requires JavaScript rendering, asynchronous page population,
browser-managed cookies/bootstrap, or browser-style delivery. Missing expected
primary content is also sufficient reason to try it: a false suspicion flag
means no static heuristic fired, not that the page is proven complete. It launches an
isolated headless Playwright Chromium process for an uncached URL, captures the
rendered HTML, closes Chromium, and exposes the same `find`, `index`,
`nextIndex`, table inventory, and `columns` operations as `WebFetch`. It does
not click, type, authenticate, interactively scroll, capture screenshots, or
maintain a browser session; it is not an interactive browser or vision tool.
Installation verifies and, when necessary, downloads Playwright's compatible
Chromium build.

The page cache is bounded by entry count and total bytes and is force-removed
on session/application shutdown. Shutdown also removes settled subtask wave
roots, completed execution manifests, and review bundles. Only genuinely
unlanded recovery checkpoints are preserved for exact-session restart.

Defaults can be overridden under `web`:

The maximum acquisition size is also available under **Web** in
`/review-settings`; saves apply to subsequent WebFetch and BrowserExtract
acquisitions without restarting the application.

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

For independent manual testing, use the same implementation outside Pi:

```bash
./scripts/pi-review-web.sh search "largest US cities census wikipedia" --max-results 10
./scripts/pi-review-web.sh fetch https://en.wikipedia.org/wiki/List_of_United_States_cities_by_population
./scripts/pi-review-web.sh fetch https://en.wikipedia.org/wiki/List_of_United_States_cities_by_population --find Phoenix
./scripts/pi-review-web.sh fetch https://en.wikipedia.org/wiki/List_of_United_States_cities_by_population --index 36
./scripts/pi-review-web.sh fetch https://en.wikipedia.org/wiki/List_of_United_States_cities_by_population --index 36 --columns 'Municipality,2025estimate'
./scripts/pi-review-web.sh browser-extract https://example.com/javascript-application --find 'Rendered result'
```

The CLI emits versioned JSON. `batch` accepts NDJSON and keeps one cache alive
across all requests in that process, which is useful for independently proving
that indexed continuation is a cache hit.

The reviewer treats orchestrator-provided task direction as authorized and
reviews concrete logic, regressions, security, API behavior, tests, and explicit
acceptance criteria. It must not request changes merely because an implementation
choice was not separately requested by the user. Targeted tests are expected in
delegated correction loops; absent an explicit task criterion or a concrete
cross-cutting risk, a full-suite run is a non-blocking final-orchestration note.

```json
{
  "enabled": true,
  "maxCorrectionCycles": 3,
  "implementationGuidanceAfterCorrectionAttempts": 1,
  "retainBundles": "on-failure",
  "reviewers": [
    {
      "id": "codex",
      "adapter": "codex-cli",
      "timeoutMs": 600000
    },
    {
      "id": "claude",
      "adapter": "claude-cli",
      "timeoutMs": 600000
    }
  ]
}
```

The older single `decider` field is still supported for compatibility.

### Delegated execution and runtime settings

`/review-settings` opens one staged settings transaction with eleven sections:

- **Worker resources** defines Pi-scoped models and
  execution-capable entries from `externalAgents`, each with one physical
  maximum concurrency shared by every background-task kind.
- **Execution priority** and **Research priority** are independently ordered
  subsets of those resources. Either route can exclude a resource. Per-route
  reasoning lets the same local model use different effort without creating a
  second capacity bucket.
- **Reviewers** is a multi-selection, `/scoped-models`-style picker over the
  same Pi-scoped models plus review-capable entries from `externalAgents`.
  Clearing every reviewer is valid and disables automatic review without
  disabling delegated execution. Each selected internal reviewer has its own
  **Reasoning** row.
- **Timeouts** edits the default reviewer and executor timeouts in minutes.
  Reviewers default to 10 minutes and executors to 30 minutes. Explicit
  `externalAgents[].review.timeoutMs` and `externalAgents[].execution.timeoutMs`
  values override these defaults for that external harness role.
- **Review policy** edits `maxCorrectionCycles` and
  `implementationGuidanceAfterCorrectionAttempts` as non-negative whole
  numbers.
- **Bundle retention** selects `never`, `on-failure`, or `always`. Choose
  `always` when successful executor and reviewer turns need to remain available
  for inspection.
- **Global concurrency** sets `execution.maxWorkers` (1–16, default 4). This is
  the total worker ceiling; each worker resource also has its own shared
  `maxConcurrent` capacity.
- **Retry policy** configures bounded executor/reviewer recovery: retry count,
  exponential-backoff bounds, jitter, and the repeated-incident guard.
- **Subtask notifications** defaults to **Quiet**, which keeps ordinary running
  and reviewing transitions in passive UI telemetry while still notifying for
  every task landing, failure, conflict, or recovery requirement. **Noisy** also
  starts turns for running and reviewing transitions.
- **Subtasks view** stores the expanded/collapsed live-panel preference
  globally.

Escape from a submenu returns to the settings root. Escape or **Cancel** at the
root discards all staged changes; **Save changes** atomically persists every
section while preserving unrelated JSON keys. An inactive external definition
does not need to be installed. Its command is checked when that definition is
selected or run.

Saved values are authoritative for execution stages that have not started.
Already-running executor and reviewer processes finish with their launch
values, while queued dispatch, waiting failover, later continuation turns, and
later review cycles use the current routes, capacities, policies, and reviewer
selection. Subtask notification mode is a delivery preference and takes effect
immediately for subsequent events from already-running tasks. Running capacity
leases survive pool edits; removed entries receive no new work. A restarted task warns when its prior runtime configuration differs,
and an executor-selection change starts a fresh native session from the durable
checkpoint instead of attaching an incompatible conversation.

Worker routes and reviewers are independent:

| Reviewers | Execution route | Behavior |
| --- | --- | --- |
| selected | non-empty | delegated execution with the full review/correction loop |
| none | non-empty | delegated execution returns `completed_unreviewed` |
| selected | empty | automatic parent review only |
| none | empty | settings remain available; both behaviors are off |

Top-level `enabled: false` is the automatic-review master switch and does not
disable configured worker routes. The environment kill switches disable the whole
extension, including delegated execution.

With at least one worker resource selected, the plugin exposes one exact-schema tool per
operation: `SubtasksStart`, `SubtasksAdd`, `SubtasksInspect`,
`SubtasksContinue`, `SubtasksSteer`, `SubtasksInterrupt`,
`SubtasksForceMerge`, and `SubtasksMarkClean`. `SubtasksStart` accepts an
optional immutable group-level `kind`: `execute` (the default) or `research`.
Start and add accept 1–16 bounded tasks and return stable execution/task handles immediately. Work continues in
the background up to the configured global and per-model capacities. Each task owns its capture,
worktree, session, checkpoint, review, and landing outcome; there is no
wave-wide shared base or all-workers integration barrier. Research tasks skip
review and landing, validate that their private worktree stayed unchanged, and
finish as `reported` with a durable report path. Pi enforces the
read-only tool intersection through `--tools`. Codex uses its read-only sandbox
and rejects configuration that could weaken the research profile. Claude uses
an explicit read-only tool allowlist and permission callback while disabling
user settings, skills, plugins, and MCP. Every adapter also receives a private
worktree check that quarantines any detected write. Generic binary adapters are
ineligible for research because their protocol does not acknowledge the
restriction.

`SubtasksContinue` accepts either an associated task handle or a verified
reattachment bundle. `SubtasksSteer` is valid while a task is
queued, starting, in a live executor turn, or being reviewed. Queued instructions
are durable, live instructions use the adapter's acknowledged transport, and a
steer during review cancels that review and resumes the executor with the changed
request before a fresh review. If the current adapter cannot steer a long-running
command, the instruction waits for that next executor handoff instead of being
reported as rejected. In the default quiet notification mode, each `LANDED`,
failed, conflicted, or recovery-required task wakes the orchestrator, while
ordinary `RUNNING` and `REVIEWING` transitions remain passive UI telemetry.
Noisy mode additionally wakes on those two interactive states. Every task
landing is reported immediately with its still-active siblings so the
orchestrator can top off freed capacity without waiting for the entire execution.
Each completion reports the durable execution revision, per-phase task timing,
and estimated post-settlement capacity after already-queued work. Final completion
also reports wall time, summed task time, and peak concurrent workers.
Internal `CAPTURING`, `ACCEPTED`, `WAITING_TO_LAND`, and `LANDING` progress
remains durable and user-visible without starting model turns.

The extension provides `ShellStart`, `ShellList`, `ShellLog`, `ShellSend`, and
`ShellStop` directly through Pi. Background jobs are detached process groups,
wake the agent on configured output or exit events, survive ordinary turn
settlement, and are reaped when the Pi session ends. At the top level,
review-gate reads the process-group identity returned by `ShellStart`, defers
automatic review while the group is alive, and triggers the orchestrator to
inspect and finish the work after it clears. A Pi executor likewise keeps its
RPC session alive while tracked background work runs, accepts steering during
that interval, and performs a final inspection turn before review. Executor
timeouts are suspended while a verified process group remains active;
unparseable `ShellStart` success responses fail closed.

The same top-level review-readiness gate covers execution and research subtasks: automatic
review of the primary orchestrator is deferred while any task is queued,
capturing, running, reviewing, accepted, waiting to land, or landing. Normal
task completion is delivered as a follow-up and failure is delivered
immediately; only after no background task remains active may that turn enter
automatic review.

`SubtasksInterrupt` explicitly chooses failure or merge disposition. A normal cancellation
uses `interrupt_as_failure`; `interrupt_with_merge` must be requested explicitly.
`SubtasksForceMerge`
operates only on a stopped task with an accepted commit or verified checkpoint;
`mergeAnyhow` may deliberately install ordinary conflict markers in main.
Both `interrupt_with_merge` and every direct force merge are mechanical landing
attempts, not verification that the requested changes are present or correct.
The main workspace must always be inspected manually afterward, including when
the task's authoritative state is `landed`.
`SubtasksMarkClean` validates that those markers are resolved before queued landings
resume. No singular or snake_case compatibility tool is registered.

Executor failures are checkpointed to a protected recovery ref before bounded
retry. Compaction is a lifecycle transition: an interrupted Pi
session is reopened by exact UUID, explicitly compacted through Pi RPC, and
only then prompted to continue. If same-executor recovery is exhausted, a
verified checkpoint may be handed to the next lower-priority pool entry. That
adapter starts a new native session in the same isolated worktree, so different
providers and CLI harnesses can take over without pretending to share conversation
state. Durable diagnostics include the complete executor assignment history.
Non-landed results include the worktree,
session, attempts, incidents, changed paths, verified checkpoint, hashed
artifact inventory, current bundle, and safe next actions. Only `landed` means
that worker changes reached the source workspace.

The persistent widget shows active tasks below the editor and distinguishes a
task assigned for executor startup from one still waiting for capacity and from
active work. `/subtasks-view` toggles
the expanded panel, and the same expanded/collapsed preference is available in
`/review-settings`. This is a global UI preference rather than conversation
state. The expanded view lists only active tasks (up to 16), while its combined
newest-ten activity feed may temporarily retain events from tasks that have
already landed. Every model-facing `SubtasksStart`, `SubtasksAdd`, and
`SubtasksInspect` result includes the stable task UUIDs, states,
recent activity, and full artifact paths needed for control and deeper `rg`
inspection. Start/add results also show assigned-starting versus capacity-waiting
tasks and a point-in-time scheduler snapshot without claiming startup has completed.
A partial landing event identifies the landed paths and every
sibling that has not landed; only the final event invites aggregate verification.
Completion, failure, meaningful state changes, and workspace conflicts are
delivered proactively; polling loops are neither required nor recommended, but
purposeful `SubtasksInspect` calls are always supported.
User analogs are available as `/subtasks` and the `/subtask-*` commands for
inspect, add, steer, interrupt, force-merge, and mark-clean. These commands open
interactive execution/task and action pickers when handles are omitted; their
explicit-handle forms remain available for scripting.

Review and execution recovery state is scoped to the exact Pi conversation.
The normal restart flow—launching into a temporary/default session and then
running `/resume <session>`—loads the selected conversation in a fresh extension
runtime and restores only that conversation's integrity-checked sidecar state.
The temporary startup session is shut down and cannot leak its review window or
execution associations into the resumed session. Restored state includes review
baselines/evidence, pending model deliveries, execution groups, operation bundles,
task definitions, activity, commands, incidents, checkpoints, and conflict gates. A live or uncertain
owner blocks another writer; a confirmed-dead writer can be reconciled into a
freshly reverified checkpoint before an explicit continuation. Queued inputs
from a review interrupted by restart are not reordered automatically: use
`/review-now` to finish the review and release them, or `/review-clear` to cancel
them.

Codex CLI, Claude CLI, and Pi reviewers stream bounded native lifecycle
and read-only tool activity into ordinary review status and delegated-subtask
activity views without exposing reasoning contents or reviewer output. Generic
CLI reviewers expose start/finish status because their protocol has no structured
intermediate event stream.
Foreground automatic reviews, `/review-now`, and reviewer-question commands show
the active reviewer milestone and elapsed time in the status line until the
review completes or is cancelled.

### Background task tools

Each task runs in an isolated worktree with a permanent task UUID. Execute tasks
have a review/landing lifecycle; research tasks have a report-only lifecycle.
Tasks are specified as an array of 1–16 items.

**Concurrency**: `config.execution.maxWorkers` controls concurrent workers
(1–16, default 4); there is no parallelism toggle or per-tool override. Task
count is independent, and excess tasks queue. Fresh tasks scan their
`execution.routes.execute` or `execution.routes.research` ordering and use the
first eligible `workerResources` entry with remaining shared capacity. Thus a
one-slot local primary cannot run one execution and one research worker at the
same time, while lower-priority cloud entries can absorb overflow. The sum of resource capacities
may exceed `maxWorkers`; it describes available fallback capacity, not the
number of workers that must run.

**Independent landing**: As soon as one task is accepted, it acquires the short
source-mutation lease, replans against current main, and attempts to land. It
does not wait for, integrate with, or roll back a sibling. A completed landing
immediately frees capacity, and `SubtasksAdd` can top the execution group back up. The
landed changes remain uncommitted; source HEAD, index, staging state, and stash
are preserved.

**Snapshot and ignore policy**: Each dispatched task captures the source
workspace independently. Non-ignored untracked files are included. Git-ignored
files are excluded from capture and landing. This means dependencies
installed in `node_modules`, secrets in `.env`, and other ignored paths are
not captured or landed. If your task depends on files that are git-ignored,
the worker will not see them. Files known to Git through `HEAD` or the index are
always captured regardless of repository size. During task capture,
`maxSnapshotBytes` limits only the cumulative size of non-ignored untracked
files (50 MiB by default). For ordinary serial review snapshots, the same
setting continues to bound the textual file content retained for diffing.
Ordinary snapshots stream files once to retain an exact SHA-256 identity.
Recognizable archives, executables, media, fonts, PDFs, and other binary data
are classified from content signatures with a binary-content fallback; their
bytes are not retained or decoded for textual diffs, and filename extensions
alone never determine classification.

**Artifacts**: Each task produces a `waveRoot` containing its operation record,
bounded executor/reviewer protocol streams, worktree/checkpoint metadata, manifest, and
stable refs. Its execution group has a separate integrity-checked manifest and
is associated with the exact parent conversation sidecar. On later captures,
completed non-recovery roots older than `waveArtifactTtlMs` are
garbage-collected (30 days by default; `0` disables collection). Conflict,
integration-error, and recovery-required roots are never removed by this GC,
and `retainBundles: "always"` disables age-based wave GC while the application
is running. Application shutdown still removes settled artifacts; recoverable
unlanded checkpoints remain protected.

**Conflict and recovery**: A clean accepted task lands immediately. On a
three-way conflict, clean paths are applied and ordinary diff3 markers are
materialized for the conflicting text paths in main. A durable critical gate
then blocks every later landing, identifies the owning task and paths in
`SubtasksInspect`, and injects a priority instruction on every matching orchestrator
turn. After resolving the files, use `SubtasksMarkClean`; it verifies that markers are
gone, checkpoints the resolution, clears the gate, and wakes queued landings.
Stopped tasks retain verified checkpoints and reattachment bundles for
`SubtasksContinue` or `SubtasksForceMerge`; `SubtasksForceMerge` with `mergeAnyhow` deliberately
materializes the same conflict state when a clean landing is impossible. A
force-merge result describes only the mechanical landing outcome; manually
inspect the main workspace after every attempt before claiming task success.

Every failed or non-landed execution-tool operation returns the complete group
and task inspection: durable handles, current source disposition, commands and
acknowledgements, incidents, checkpoint/bundle data, artifact paths, conflicts,
and concrete recovery actions. This state remains inspectable after compaction
or an exact-session restart.

**Source preservation**: Landing never changes source HEAD, index, staging
state, or stash. Final filesystem mutations are serialized and rollback-protected.
Absolute source-workspace paths in task and correction text are remapped to the
worker worktree, and executor `PWD` is set to its actual isolated cwd. Clean
worktrees are removed after completion; dirty or conflicted worktrees are
preserved for diagnosis. This is worktree and instruction isolation, not an OS
sandbox: a hostile custom executor process can still access paths allowed by
the host account.

Pi internal model selections use the exact canonical
`provider/model` value and store a role-owned `thinkingLevel`. The allowed
levels come from that scoped model's runtime metadata, including its
`thinkingLevelMap`; unsupported extended levels such as `max` are not offered.
These settings do not inherit the controlling session's thinking level. For
example, the menu displays:

```text
gpt-5.6-sol [openai-codex]
```

and persists:

```json
{
  "source": "pi",
  "model": "openai-codex/gpt-5.6-sol",
  "thinkingLevel": "high"
}
```

Pi and the selected provider own reasoning effort and token-budget behavior;
review-gate does not impose a second output-side thinking cap. Reviewer and
executor selections remain separate from the orchestrator. External
harnesses continue to configure reasoning through their role-specific arguments
or environment.

An end-to-end configuration example is available at
`examples/delegated-execution.json`. `externalAgents` is one configured catalog
shared by both menus. Each entry has an optional `review` role, `execution`
role, or both. Role sections can override shared arguments, environment, model,
protocol, and timeout, so one harness can use different limits for review and
execution. Pi-scoped internal models remain runtime-discovered and are never
copied into the external catalog.

Reviewer selections use discriminated references:

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

An internal model may use different reasoning for the two roles because the
level lives on each selection. External harness reasoning remains native to the
harness and is configured independently under `externalAgents[].review.args`
and `externalAgents[].execution.args`. For example, a Codex CLI role can use
`["-c", "model_reasoning_effort=\"high\""]`, while Claude Code can use
`["--effort", "high"]`. Arbitrary binary adapters may use their own arguments
or environment variables.

Legacy `decider`, `reviewers`, `enabledReviewerIds`, and
`execution.externalExecutors` configurations remain readable. A successful
`/review-settings` save migrates their definitions into `externalAgents`.

The `run-as-binary` adapter uses the versioned
`pi-review-executor-jsonl-v1` protocol. It sends the prompt on stdin and sets
`PI_REVIEW_EXECUTOR_OPERATION` (`start` or `resume`),
`PI_REVIEW_EXECUTOR_SESSION_ID`, and `PI_REVIEW_EXECUTOR_PROTOCOL`. The process
emits newline-delimited JSON:

```jsonl
{"type":"session","sessionId":"stable-session-id"}
{"type":"assistant","text":"Implemented and verified the bounded phase."}
{"type":"usage","usage":{"input_tokens":100,"output_tokens":25}}
```

The assistant event is required. The session event lets later correction and
post-pass turns resume the same harness context. Authentication remains in each
harness's own login/configuration; do not put OAuth tokens or API keys in the
review-gate file.

`implementationGuidanceAfterCorrectionAttempts` controls when every review path
strengthens its request for concrete implementation guidance. The default is
`1`: reviewer responses are implementation-ready from the start, and after one
correction attempt the next automatic review, `/review-now`, or `/ask-reviewer`
first verifies historical findings against the current workspace. For only
those problems it independently confirms still remain, it explicitly requires
a concise prose defense plus a concise, directly applicable implementation diff
showing exactly what code the reviewer expects for the finding to pass. The diff
may be as complete as necessary and does not have to be minimal. Genuinely
non-code findings require exact actionable steps and a defense of why they are
sufficient. This guidance stays inside the structured response's Markdown
`guidance` field and is rendered under the review's Guidance section; the
Summary, Issue, and Recommendation fields keep their existing formatted layout.
The presence of prior feedback is not treated as proof that the correction
failed. Set the value to `0` to apply this conditional verification and
concrete-guidance requirement on the first
review. There is no separate disabled value; use a threshold higher than the
configured correction budget to prevent threshold escalation while retaining
the normal implementation-ready prompt.

Load during development by pointing your pi host at the built extension:

```bash
PI_REVIEW_GATE_CONFIG=/path/to/review-gate.json \
pi -e /path/to/pi-review-gate/dist/src/index.js
```

For normal use with the first existing fallback config, use the persistent
launcher:

```bash
./scripts/pi-review-gate.sh
```

It builds the extension, selects the first existing config from
`~/.config/pi-review-gate/config.json` or `~/.config/pi/review-gate.json`, and
refreshes the discoverable orchestration skill at
`~/.agents/skills/orchestrator/SKILL.md`, including its progressively loaded
recovery runbook, before executing the installed `pi`
with the extension and orchestrator prompt. The always-loaded prompt establishes
the role and subtask protocol; the skill provides deeper guidance for
decomposition, supervision, reviewer interpretation, integration, and synthesis.
All remaining arguments are forwarded unchanged. Pi remains independently
installed and upgradeable; this project consumes its public extension and
CLI/RPC surfaces rather than patching or bundling Pi.

Tool restriction uses each harness's native allowlist. Pi reviewers and Pi
workers are always launched with an explicit `--tools` value; worker values are
captured from the orchestrator's active Pi tools and narrowed further for
research. The launcher does not impose a separate orchestrator policy. To limit
the orchestrator, pass Pi's native allowlist through the wrapper, for example
`./scripts/pi-review-gate.sh --tools read,bash,edit,write`.

A Codex-oriented starter config is available at:

```bash
examples/single-codex.json
```

Claude and Pi model examples are available at:

```bash
examples/single-claude.json
examples/single-pi-model.json
```

Multi-reviewer examples are available at:

```bash
examples/double-review.json
examples/double-deepseek-v4-flash-review.json
examples/triple-review.json
```

The DeepSeek double is an alternative to the default Codex + GLM-5.2 pairing;
it runs Codex and `ollama/deepseek-v4-flash:0731-cloud` as independent
reviewers.

The Pi model adapter is generic. The example currently uses `ollama/glm-5.2`.
Legacy internal selections without a
`thinkingLevel` continue to use `high`; saving them through `/review-settings`
materializes an explicit model-supported level.

Every built-in Codex, Claude, and Pi review pass starts a fresh CLI
session. Correction context comes from the stable evidence bundle rather than
accumulated model/tool history, avoiding reviewer compaction across passes.
Correction reviewers begin with the original task evidence, latest correction
exchange, immediately preceding findings, and current files. Complete earlier
history remains available for targeted inspection but is not read by default.

Canceling a running review with Escape cancels the whole parallel review, even
if one reviewer has already completed. Partial results are discarded and are
not transmitted. The numbered invocation remains as a `CANCELED.md` tombstone
stating that a review would have run there but was canceled by the user, so pass
order remains unambiguous. The next review keeps the same evidence bundle but
starts fresh reviewer sessions.

Each review window uses one stable temporary evidence bundle. Every completed
agent run is appended as a numbered exchange containing its snapshot-derived
workspace diff, captured side-effect diff, tool calls and results, assistant
summary, usage, and before/after artifacts. The bundle also maintains the
cumulative baseline-to-current patch and numbered reviewer invocations.

Codex, Claude, and Pi reviewers receive a compact prompt pointing to
the bundle's `REVIEW.md` entry point and inspect the evidence with read-only
tools. The generic CLI adapter retains the inline prompt as a compatibility
transport and also receives the bundle path in `PI_REVIEW_GATE_BUNDLE_DIR`.
Exact `write` / `edit` paths and easy shell targets are pre-captured before
execution, including absolute paths outside the current worktree.

Repository baselines, per-exchange snapshots, pre-captured outside-file
baselines, user guidance, tool evidence, assistant summaries, and reviewer
feedback belong to one review window. A requested correction keeps
that window open. Even when a correction exactly restores the original baseline,
the next reviewer sees the inverse exchange diff and validates the correction.
A passing review is transmitted to the implementing model as a final review
turn with every reviewer's official notes. The pass certifies the exact reviewed
workspace snapshot. A response that does not change the workspace or create a
meaningful persistent side effect checkpoints and closes the window while
retaining it for an immediate `/ask-reviewer` follow-up. If the implementing
model makes another change after seeing the passing observations, that response
becomes a new exchange in the same window and triggers another review. Later
ordinary work starts a fresh window from current file contents and does not
re-review changes that already passed.

## Commands

`/review-clear` discards the active or retained review window, including its
baseline, request history, captured evidence, prior reviewer feedback, held
correction feedback, and queued user input. The next ordinary prompt starts a
fresh window from the workspace's current contents. It does not revert files or
override bundle retention: bundles continue to be retained or removed by the
configured `retainBundles` policy (`never`, `on-failure`, or `always`).
Already-retained bundles remain governed by that policy. Reviewer sessions are
never reused between passes. If a review is currently running, cancel it
first and then run `/review-clear`.

`/review-now` reruns the configured reviewer or reviewers against the active
review window's baseline and evidence. Its complete result is transmitted to
the implementing model. A pass closes only after the implementing model responds
without changing the reviewed state.

`/review-pause` suppresses automatic and explicitly requested reviewer runs
without stopping evidence collection. Each primary-model turn is still captured
as a separate exchange. `/review-unpause` resumes reviewer execution; the next
eligible turn reviews the accumulated changes and evidence. `/review-now` and
`/ask-reviewer*` remain unavailable while reviews are paused.

Reaching the automatic correction cap does not hide reviewer information. The
complete pass is transmitted with correction classified as deferred.
`/review-continue` authorizes the last capped feedback for correction and resets
the correction counter using a compact authorization message that references the
already-delivered pass instead of repeating its reviewer results, so the
configured correction budget is available again.
Reaching the cap does not accept or checkpoint the changes. Normal user guidance
also remains in the same unresolved window unless that window later passes.

If you send normal guidance while the reviewer is still running, the plugin
holds that input locally until the review finishes. When the reviewer requests
changes, reviewer feedback is queued first, then your held guidance is queued
after it in the same order you typed it.

`/ask-reviewer <question>` asks the configured reviewer or reviewers an ad hoc
question about the current work. It includes the current request context,
changed files and patch when available, and the session evidence digest, including
read-only/tool-call activity and the primary agent's final summary. This makes it
useful after planning-only turns as well as after edits. Immediately after a
passing review, it can still use that passed window's patch and evidence; a
regular prompt starts a fresh window instead. At the automatic correction cap it
also includes the prior reviewer results, the deferred transmission, and any
later `/review-continue` authorization from the same unresolved review window.

`/ask-reviewer` uses a two-stage interruption when the implementing model is in
a turn. It first steers a hold instruction that tells the model not to call more
tools or modify more files. Any tool calls already issued in the current
assistant batch may finish before steering is delivered. Once that turn ends
and its exchange is captured, the gate asks the
reviewer against the stable workspace and steers the resulting note into the
next model step. Escape remains available when an immediate hard stop is
required. `/ask-reviewer-interactive <question>` uses the same reviewer,
session, evidence, answer formatting,
two-stage interruption, and acceptance path, but opens the answer in an editable
prompt first. Press Enter to submit it, edit it first if needed, or press
Escape/Ctrl+C to clear it without sending anything.

Submitting either command accepts the question and the exact submitted reviewer
note into structured session evidence. Later automatic reviews, `/review-now`,
and reviewer-question calls in the resulting review window receive the accumulated
accepted Q&A, including preserved Markdown and fenced code. Clearing the editor
does not accept or record the answer. When a question follows a passing review,
its accepted Q&A is carried into the new review window created for the submitted
reviewer note without reusing the already-checkpointed file baseline.

Retained review bundles include `REVIEW.md`, `manifest.json`, `request.md`, a
`current/` cumulative view, immutable `exchanges/<sequence>/` evidence,
numbered `reviews/<sequence>/` and `questions/<sequence>/` invocations,
`sessions.json`, per-pass `review-telemetry.json`, and captured before/after
artifacts. Reviewer outputs remain
isolated under each invocation's `reviewers/<id>/` directory. Each completed
review pass also stores `implementing-model-transmission.md`, its structured
JSON envelope, and additive `delivery.json` receipts recording exactly what the
implementing model was told and whether the transmission required correction,
reported a pass, deferred action, or disclosed a review error. Later reviewers
start with the immediately preceding record and consult older records only when
the latest correction evidence requires it. The envelope
contains the gate verdict and the individual reviewer results; no unsent
aggregate result is persisted. Telemetry records prompt and stream bytes,
tool-call and tool-result volume, wall time, token usage, compaction events, and
whether session reuse occurred; it measures behavior without imposing a token
budget. A canceled numbered invocation contains
`CANCELED.md` and `canceled.json` rather than reviewer results. The Pi
model adapter stores the extracted final review in `raw-output.txt` and the
capped JSONL stream separately as `raw-stream.jsonl`. When supported by the
reviewer CLI, user-facing notices include a compact reviewer token summary, for
example
`review gate: passed (review tokens (this pass): input 1.2k (uncached 400, cached 800), out 340, total 1.6k)`.

## Crash Recovery for Landing Manifests

When a wave landing is in progress, a recovery manifest is written atomically
under `<waveRoot>/landing/manifest-<txId>.json` before any filesystem mutations.
If the process dies mid-landing, the manifest remains in `in_progress` or
`recovery_required` state with backup artifacts preserved.

### Manifest location

Recovery manifests live in the wave root directory:

```
<waveRoot>/landing/manifest-<uuid>.json
```

The wave root is the parent of the private bare Git repository created during
capture. Each manifest is scoped to a single transaction via a unique UUID.

### Recovery API

The `recoverLandingManifest(manifestPath)` function in
`src/execution/wave-landing.ts` recovers a crashed landing transaction:

```typescript
import { recoverLandingManifest } from "../src/execution/wave-landing";

const result = await recoverLandingManifest("/path/to/manifest.json");

// result.status is one of:
//   "recovered"       — all paths restored, manifest marked rolled_back
//   "manual_required" — concurrent modifications detected, artifacts preserved
//   "rejected"        — manifest invalid (wrong version, path escape, identity mismatch)
//   "terminal"        — manifest already completed or rolled_back; stale artifacts cleaned
```

### Recovery behavior

- **Source root identity**: Recovery verifies the source root's dev+ino matches
  the manifest. If the directory was replaced or moved, recovery is rejected.
- **Path confinement**: All destination, temp, and backup paths must reside
  within the source root. Path-escaping manifests are rejected.
- **Concurrent modifications**: If a destination was modified after the
  transaction installed it, recovery preserves both the newer destination and
  the original backup, marking the manifest `recovery_required`.
- **Idempotency**: Running recovery twice on the same manifest is safe. The
  first call restores paths and marks the manifest `rolled_back`; the second
call cleans stale temps.
- **No Git mutation**: Recovery never invokes Git staging, reset, or apply
  commands. It only manipulates filesystem artifacts.
- **Artifact preservation on manual_required**: When recovery detects a
  concurrent modification and returns `manual_required`, ALL artifacts (temps,
  backups, destinations, directories) are preserved for diagnosis. No cleanup
  occurs until the user resolves the conflict.
- **Created directories caveat**: Post-crash recovery never removes
  `manifest.createdDirs` entries because the manifest is untrusted and there is
  no durable proof an empty directory was transaction-created. Harmless empty
  directories may remain after recovery. Live in-process rollback (during
  `executeWaveLanding`) continues removing its trusted in-memory `createdDirs`.

### Manual recovery steps

When recovery returns `manual_required`:

1. Inspect the manifest to identify which paths have conflicts.
2. Compare the current destination with the backup (original content).
3. Decide whether to keep the concurrent modification or restore the original.
4. Remove backup artifacts (`.pi-backup-*` suffix) once resolved.
5. Remove temp artifacts (`.pi-landing-tmp-*` prefix) if any remain.

### Session-scoped restart recovery

The extension does not globally scan the filesystem for arbitrary landing
manifests at startup. Review and execution associations restore only when the
same Pi conversation and session file are resumed from the matching cwd. A
stopped task with a durable bundle is then queued for continuation, and that
continuation reconciles verified in-progress or recovery-required landing
manifests before allowing further source mutation.

Manifests outside that exact restored association remain explicit recovery
operations through `recoverLandingManifest()`. A different conversation,
session file, or cwd never silently adopts them.

## Third-party notices

The background-shell implementation and its tests are modified from Little
Coder by Itay Inbar and are used under the Apache License, Version 2.0. The
source files carry modification notices. See [NOTICE](NOTICE) and
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) for attribution and the full
license text.
