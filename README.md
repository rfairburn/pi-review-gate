# pi-review-gate

External [pi](https://github.com/badlogic/pi-mono) extension that reviews code changes
after an agent turn and sends the complete classified review pass back to the
implementing model.

Every completed agent turn is captured as numbered evidence in a review window. One or
more reviewers run read-only against that evidence and return a structured verdict; the
gate transmits every result — passing, non-blocking, guidance, and errors — to the
implementing model, tracks corrections against a configurable budget, and keeps durable
receipts of exactly what the model was told.

![A Pi orchestrator delegates to representative Pi, Claude, and Codex executors in isolated worktrees across selected workspaces. Independent reviewers return findings for correction or approve results for landing. Tool capabilities remain role- and authorization-scoped.](docs/assets/orchestration.svg)

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
  reading), `BrowserExtract` (single-page rendered fallback), and a bounded Pi-native
  semantic browser (`BrowserOpen`, `BrowserNavigate`, `BrowserSnapshot`,
  bounded `BrowserConsole`, `BrowserNetwork`, and `BrowserInspect` diagnostics,
  `BrowserScreenshot`, `BrowserScroll`, `BrowserHover`, policy-bound `BrowserClick`,
  `BrowserFill`, `BrowserType`, `BrowserSelect`, `BrowserPress`, `BrowserWait`, `BrowserHistory`, `BrowserTabs`, `BrowserClose`), all with
  DNS-rebinding-hardened, validated egress
  ([Web tools](docs/web-tools.md),
  [Security model](docs/security-model.md#web-egress-hardening)).
- **Durable evidence and recovery** — stable evidence bundles, integrity-checked
  execution manifests, landing-manifest crash recovery, and exact-session restart
  restoration ([Recovery](docs/recovery.md)).
- **`ApplyPatch` tool** — the canonical OpenAI/Codex apply_patch envelope per call
  (multi-file create/update/rename/delete with sequential application and explicit
  partial-failure reporting), workspace confinement, atomic staged writes, and serialized
  mutation windows ([Security model](docs/security-model.md#applypatch-confinement-and-safety)).
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
an exported `PI_REVIEW_GATE_CONFIG`, so a parent pi session cannot redirect it. On every
platform it uses the first path that exists:

- `review-gate.json` in the Pi agent directory — `~/.pi/agent/review-gate.json` by
  default (`%USERPROFILE%\.pi\agent\review-gate.json` on Windows), following Pi's
  native `PI_CODING_AGENT_DIR` override when set
- `~/.config/pi-review-gate/config.json` — an implicit compatibility fallback

On its first launch, when neither is present, the launcher creates a private zero-model
default config at the default location (no reviewers or workers selected) and continues;
you then configure models through `/review-settings` or by editing the file. A config
that exists only at the fallback location stays selected unchanged; nothing is copied,
rewritten, or migrated between the two locations. To start from an existing config
instead, place (or copy) it before launching:

```bash
mkdir -p ~/.pi/agent
cp /path/to/review-gate.json ~/.pi/agent/review-gate.json
./scripts/pi-review-gate.sh
```

On Windows, the same launcher is available natively for cmd.exe and PowerShell — no
Bash, WSL, or PowerShell script execution:

```bat
scripts\pi-review-gate.cmd
```

From an npm installation, the Windows entry point is `pi-review-gate-cmd`. The native
entry pairs a thin `.cmd` file with a Node helper (`scripts/pi-review-gate-launcher.cjs`)
that mirrors the POSIX launcher end to end: the same configuration discovery and
first-launch initialization (deliberately ignoring an inherited `PI_REVIEW_GATE_CONFIG`),
development rebuilds versus the packaged artifact, the pinned DDGS web-search dependency
(provisioned natively in a `Scripts\python.exe` virtual environment — no `.sh` execution),
the orchestrator skill refresh, launch diagnostics, argument forwarding, and exit codes.
It requires Node.js 20+ (and Python 3 for web-search provisioning) on PATH.

The first launch prints a notice when it creates the default config; automatic review
stays off until at least one reviewer is selected.

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

## Platform and shell compatibility

Windows support is basic by design. Pi ships its native `bash` tool on every platform
and an optional `powershell` tool on Windows; wherever review-gate handles shell
commands — side-effect evidence and worker shell-tool authorization — `powershell`
receives the same treatment as `bash`, subject to actual host availability and
authorization: a tool the host has not registered or authorized is simply not exposed,
and neither name widens a tool catalog on its own. Plan/research posture removes
arbitrary shell entirely. The persistent launcher has a native Windows entry point
(`scripts\pi-review-gate.cmd`, or `pi-review-gate-cmd`
from an npm installation); `ShellStart` and the background-shell tool family keep
their current assumptions and remain unsupported on Windows, and worktree support is
not completed. See
[Delegated execution](docs/delegated-execution.md#background-shell-tools).

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
| Numbered prereleases, artifacts, publication recovery | [docs/releases.md](docs/releases.md) |
| Symptom-to-fix troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |

## Development

```bash
npm install              # dependencies (downloads Chromium unless skipped)
npm run build:test      # compile tests without touching the live dist/
npm run test:run        # full compiled suite (up to four test files concurrently)
npm run test:run:serial # full serial fallback after npm run build:test, for resource/ordering-sensitive diagnosis
npm test                # build + full suite; rebuilds the live dist/, so reserve it for CI or an explicitly owned isolated build
npm run test:fast       # short pure/unit development loop
npm run test:execution  # serial background/recovery/pool/session/tool-contract tier
npm run test:serial     # build + serial suite; rebuilds the live dist/, so reserve it for CI or an explicitly owned isolated build
npm run check:static    # tsc --noEmit + shellcheck + docs link/anchor/JSON validation
npm run test:package    # pack, install into a scratch consumer, assert required files
```

In a working checkout, run `npm run build:test` followed by `npm run test:run` for the
process, Git, filesystem, and end-to-end suite before finalizing a phase; `npm test`
rebuilds the live `dist/`, so reserve it for CI or an explicitly owned isolated build.
Build and workflow details live in [docs/development.md](docs/development.md).

## Contributing and governance

Contributions are issue-first and reviewed: every pull request must accompany or link an
issue (`Closes #N` for evidenced full resolution, `Refs #N` for partial or related work
with the remaining scope stated), branches follow `issue-N/short-slug`, and merges are
maintainer-authorized squash merges that happen only after the required review and
checks pass. The project is pre-1.0; each validated merge publishes a GitHub
prerelease with a unique `0.1.0-dev.N` package version, and no npm publishing is
configured or authorized today.

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose, implement, and land work, plus the
  public release summary.
- [SECURITY.md](SECURITY.md) — private vulnerability reporting (no public security
  issues).
- [CHANGELOG.md](CHANGELOG.md) — notable changes per build, with the preserved
  pre-adoption aggregate history.
- [Review guidance](https://github.com/rfairburn/pi-review-gate/blob/main/.github/REVIEW_GUIDANCE.md)
  — expectations for external reviewers (source-only governance page in the checkout).

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