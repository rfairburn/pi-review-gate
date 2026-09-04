# pi-review-gate

External [pi](https://github.com/badlogic/pi-mono) extension that reviews code changes
after an agent turn and sends the complete classified review pass back to the
implementing model.

Every completed agent turn is captured as numbered evidence in a review window. One or
more reviewers run read-only against that evidence and return a structured verdict; the
gate transmits every result — passing, non-blocking, guidance, and errors — to the
implementing model, tracks corrections against a configurable budget, and keeps durable
receipts of exactly what the model was told.

## Key capabilities

- **Post-turn review gate** — automatic review of the primary orchestrator with a
  classified transmission, bounded correction cycles, deferred-at-cap semantics, and
  command-driven reruns, pauses, cancellations, and ad hoc reviewer questions
  ([Review workflow](docs/review-workflow.md)).
- **Multiple reviewers** — parallel reviewers over one evidence bundle with a simple
  gate: any `needs_changes` verdict requires changes; a completed pass survives another
  reviewer's infrastructure error; mixed results are `pass_with_warnings`. Built-in
  Codex, Claude, and Pi adapters run as read-only agentic reviewers
  ([Configuration](docs/configuration.md#reviewers),
  [Security model](docs/security-model.md#read-only-enforcement)).
- **Delegated execution** — background subtask workers (`SubtasksStart`, `SubtasksAdd`,
  inspect, steer, continue, watch, interrupt, force-merge, mark-clean) in isolated
  worktrees with independent landing, conflict gates, bounded retry, and failover
  ([Delegated execution](docs/delegated-execution.md)).
- **Native web tools** — `WebSearch` (API-key-free DDGS), `WebFetch` (indexed HTML/PDF
  reading), and `BrowserExtract` (headless-Chromium rendered-page fallback), all with
  DNS-rebinding-hardened, validated egress
  ([Web tools](docs/web-tools.md),
  [Security model](docs/security-model.md#web-egress-hardening)).
- **Durable evidence and recovery** — stable evidence bundles, integrity-checked
  execution manifests, landing-manifest crash recovery, and exact-session restart
  restoration ([Recovery](docs/recovery.md)).
- **`ApplyPatch` tool** — one structured OpenAI apply-patch operation per call with
  workspace confinement, atomic staged writes, and serialized mutation windows
  ([Security model](docs/security-model.md#applypatch-confinement-and-safety)).
- **Background shell tools** — `ShellStart`, `ShellList`, `ShellLog`, `ShellSend`, and
  `ShellStop` with detached process groups and lifecycle wakes
  ([Delegated execution](docs/delegated-execution.md#background-shell-tools)).

## Non-goals

- **Not a Pi fork.** Pi is independently installed and upgradeable; this project
  consumes its public extension and CLI/RPC surfaces rather than patching or bundling
  Pi.
- **Not an OS sandbox.** Task isolation is worktree and instruction isolation; a hostile
  custom executor process can still access paths allowed by the host account
  ([Security model](docs/security-model.md#isolation-limits)).
- **Not an interactive browser.** `BrowserExtract` renders and extracts only; it never
  clicks, types, authenticates, scrolls, or keeps a browser session
  ([Web tools](docs/web-tools.md#browserextract-rendered-page-extraction)).
- **No forced verification theater.** Force merges and `interrupt_with_merge` are
  mechanical landing attempts, not verification; the main workspace must always be
  inspected manually afterward
  ([Delegated execution](docs/delegated-execution.md#conflicts-and-gates)).
- **No polling loops.** Completions, failures, and conflicts are delivered proactively;
  `SubtasksWatch` arms one explicit checkpoint and never becomes a recurring heartbeat.
- **No token budget imposition.** Telemetry measures behavior without capping reviewer
  output; reasoning effort stays owned by Pi and the selected provider
  ([Configuration](docs/configuration.md#reviewers)).

## Prerequisites

- Node.js 20 or newer.
- Pi, installed independently.
- At least one harness installed and authenticated by its own login/configuration
  (Codex CLI, Claude CLI, a Pi-scoped model, or a generic CLI program). Do not put
  OAuth tokens or API keys in the review-gate config file — see
  [Security model](docs/security-model.md#secrets-and-authentication).

## Installation

```bash
npm install
```

By default, installation also verifies and downloads Playwright's Chromium build for
`BrowserExtract`. Server/CI installs that do not need browser extraction can skip it:

```bash
PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM=1 npm install
```

`WebSearch` and `WebFetch` remain available either way. See
[Getting started](docs/getting-started.md#installation) for the recovery path when
Chromium is missing.

## Minimal configuration and launch

The persistent launcher reads its config from a fixed location and deliberately ignores
an exported `PI_REVIEW_GATE_CONFIG`, so a parent pi session cannot redirect it. Place (or
copy) your config at one of these paths before launching — the launcher uses the first
that exists and fails with a clear message if neither is present:

- `~/.config/pi-review-gate/config.json`
- `~/.config/pi/review-gate.json`

```bash
mkdir -p ~/.config/pi-review-gate
cp /path/to/review-gate.json ~/.config/pi-review-gate/config.json
./scripts/pi-review-gate.sh
```

A minimal config using Codex as the reviewer:

```json
{
  "enabled": true,
  "reviewerTimeoutMs": 600000,
  "maxCorrectionCycles": 3,
  "retainBundles": "on-failure",
  "decider": {
    "id": "codex",
    "adapter": "codex-cli",
    "timeoutMs": 600000
  }
}
```

The launcher builds the extension when sources are present, selects the first existing
persistent config, refreshes the orchestrator skill at
`~/.agents/skills/orchestrator/SKILL.md`, and forwards all remaining arguments to `pi`.
For development you can load the built extension directly instead; in that path
`PI_REVIEW_GATE_CONFIG` is honored because it reaches the extension itself rather than
goes through the launcher:

```bash
PI_REVIEW_GATE_CONFIG=/path/to/review-gate.json \
pi -e /path/to/pi-review-gate/dist/src/index.js
```

To disable everything, set `PI_REVIEW_GATE_DISABLED=1`. The complete field reference,
multi-reviewer setups, `/review-settings`, and legacy compatibility live in
[Configuration](docs/configuration.md); ready-to-run examples are in
[examples/](examples/).

## How a review turn works

1. An agent turn completes and is appended to the review window's evidence bundle as a
   numbered exchange (workspace diff, side effects, tool evidence, summary, usage).
2. The configured reviewer or reviewers run read-only against the bundle — Codex in its
   read-only sandbox, Claude and Pi with explicit read-only tool allowlists, a fresh CLI
   session per pass.
3. Reviewer output is parsed strictly; the gate classifies the result (`pass`,
   `pass_with_warnings`, `needs_changes`, errors) and transmits every reviewer result to
   the implementing model.
4. Corrections consume the configured `maxCorrectionCycles` budget; reaching the cap
   defers — it never hides reviewer information — and `/review-continue` can authorize
   another round.

The full lifecycle, including commands (`/review-now`, `/review-cancel`, `/review-pause`,
`/ask-reviewer`, …), cancellation, and bundle layout, is owned by
[Review workflow](docs/review-workflow.md).

## Delegated execution in one paragraph

With a worker route configured, the orchestrator can start 1–16 bounded background tasks
per group. Each task captures the source workspace independently (git-ignored files are
never captured or landed), works in an isolated worktree, and lands on its own: accepted
tasks acquire the source-mutation lease, replan against current main, and leave landed
changes uncommitted without touching source HEAD, index, staging state, or stash.
Three-way conflicts materialize ordinary diff3 markers plus a durable gate that blocks
later landings until `SubtasksMarkClean` verifies the resolution. Details live in
[Delegated execution](docs/delegated-execution.md); recovery semantics live in
[Recovery](docs/recovery.md).

## Documentation

| Topic | Page |
| --- | --- |
| Overview and index | [docs/README.md](docs/README.md) |
| Prerequisites, install, first launch | [docs/getting-started.md](docs/getting-started.md) |
| Config reference, defaults, `/review-settings` | [docs/configuration.md](docs/configuration.md) |
| Review lifecycle, commands, cancellation | [docs/review-workflow.md](docs/review-workflow.md) |
| Subtask workers, capture/landing, shell tools | [docs/delegated-execution.md](docs/delegated-execution.md) |
| WebSearch / WebFetch / BrowserExtract | [docs/web-tools.md](docs/web-tools.md) |
| Trust boundaries, egress hardening, read-only enforcement | [docs/security-model.md](docs/security-model.md) |
| Crash recovery, restart, retry/failover | [docs/recovery.md](docs/recovery.md) |
| Build, tests, static checks, launcher internals | [docs/development.md](docs/development.md) |
| Symptom-to-fix troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |

## Development

```bash
npm install          # dependencies (downloads Chromium unless skipped)
npm test             # build + full suite (up to four test files concurrently)
npm run test:fast    # short pure/unit development loop
npm run test:execution  # serial background/recovery/pool/session/tool-contract tier
npm run test:serial  # full serial fallback for resource/ordering-sensitive diagnosis
npm run check:static # tsc --noEmit + shellcheck + docs link/anchor/JSON validation
npm run test:package # pack, install into a scratch consumer, assert required files
```

Use `npm test` (or `npm run test:integration`) for the process, Git, filesystem, and
end-to-end suite before finalizing a phase. Build and workflow details live in
[docs/development.md](docs/development.md).

## Third-party notices

The background-shell implementation and its tests are modified from Little Coder by
Itay Inbar and are used under the Apache License, Version 2.0. The source files carry
modification notices. See [NOTICE](NOTICE) and
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) for attribution and the full license
text.

The `ApplyPatch` V4A diff engine and its compatibility tests are adapted from the
OpenAI Agents JS apply-patch implementation and are used under the MIT License. See
[NOTICE](NOTICE) and [LICENSES/MIT-openai-agents-js.txt](LICENSES/MIT-openai-agents-js.txt)
for attribution and the full license text.

## License

MIT — see [LICENSE](LICENSE).