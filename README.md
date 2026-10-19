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
  ([Review workflow](docs/review-workflow.md)). Optional
  [evidence controls](docs/configuration.md#review-evidence-methods) independently
  select **Tools + workspace changes** (default) or **Tools only** for Primary,
  isolated worktree, and InPlace review. Separate snapshot-failure fallback defaults
  **Off**, with per-occurrence warnings and later snapshot retries when used.
  Workers pin evidence policy at firing/queue admission; missing observations permit
  degraded review with disclosed limits, never proof of no effects. These controls
  preserve bounded tool observations and read-only inspection, never replacing durability gates.
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
  `BrowserFill`, `BrowserType`, `BrowserSelect`, `BrowserPress`, permission-gated
  `BrowserUpload` and `BrowserDownloadSave`, `BrowserWait`, `BrowserHistory`, `BrowserTabs`, `BrowserClose`), all with
  DNS-rebinding-hardened, validated egress
  ([Web tools](docs/web-tools.md),
  [Security model](docs/security-model.md#web-egress-hardening)).
- **Durable evidence and recovery** — stable evidence bundles, integrity-checked
  execution manifests, landing-manifest crash recovery, and exact-session restart
  restoration ([Recovery](docs/recovery.md)).
- **`ApplyPatch` tool** — the canonical OpenAI/Codex apply_patch envelope as its only
  request format (multi-file create/update/rename/delete with sequential application and
  explicit partial-failure reporting), native edit/write path access, atomic staged
  writes, and serialized mutation windows ([Security model](docs/security-model.md#applypatch-envelope-handling-and-safety)).
- **Background shell tools** — `ShellStart`, `ShellList`, `ShellLog`, `ShellSend`, and
  `ShellStop` with detached process groups and lifecycle wakes
  ([Delegated execution](docs/delegated-execution.md#background-shell-tools)).
- **User questions and notices** — `AskUserQuestion` keeps its async-by-default
  (pending handle, no deadlines or fabricated answers) and explicit sync-wait modes;
  `YouShouldKnow` adds session-local notices with a compact title, complete Markdown
  body, and optional full-retained context. Questions and notices share the persistent
  pending panel, list, and native question popup (Ctrl+Alt+Up / Ctrl+Option+Up on
  macOS); question and notice content use native Markdown when available, with a
  disclosed complete plain-text fallback. In fullscreen mode, press a visible menu
  item to highlight it and complete a single left click to invoke its Enter action;
  pressing or dragging non-item popup content (body text, borders, padding, blank
  cells) instead starts Pi's normal native text selection over the visible popup.
  With copy-on-select on, Pi copies the finished selection on release; with it
  off, Pi's configured application copy shortcut (Ctrl+X by default, remappable)
  copies the visible selection through Pi's own fullscreen clipboard path while
  the popup holds focus. Opening the popup clears any selection made before it
  opened, so the popup never changes the copy setting and this path copies only a
  selection made over the visible popup, never hidden conversation text.
  Keyboard controls remain available. **More details** closes the popup, asks for
  elaboration in an ordinary reply to the originating session with the full body and
  context, and consumes only that notice. **Close** removes only that notice and
  sends nothing. The extension also uses Pi's optional native Markdown display hook
  to safely escape terminal controls in the transcript when available.
  Separate default-on settings control notice availability and completion guidance;
  the prompt appears only when both are On and live authorized discovery exposes the
  tool. The shipped completion skill remains manually invocable without native
  automatic routing. Existing question answers, free text, and explicit decline remain
  unchanged ([User questions](docs/user-questions.md)).

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

- Node.js 22.19.0 or newer for package installation and direct package commands; this
  extension's support floor matches Pi 1.0.0's verified minimum (see
  [Getting started](docs/getting-started.md#prerequisites)). The `.sh` and `.cmd`
  session-host entry points can bootstrap an isolated, checksum-pinned official Node
  22.19.0 runtime on supported OS/architectures when PATH has no supported Node; a
  supported PATH Node is retained.
- Pi 1.0.0 or newer, installed independently; Pi versions below 1.0.0 are outside
  the supported compatibility scope.
- Git on `PATH` for captured/worktree-based delegated execution (capture, landing,
  recovery, and diff3 conflict materialization). Opt-in in-place work also supports
  non-Git directories. Ordinary review evidence capture uses Git when available
  and falls back to a filesystem walk without it.
- For reviews or worker execution, the chosen harness installed and authenticated
  through its own login/configuration (Codex CLI, Claude CLI, a Pi-scoped model, or
  a generic CLI program). Do not put
  OAuth tokens or API keys in the review-gate config file — see
  [Security model](docs/security-model.md#secrets-and-authentication).

Two web-tool dependencies sit outside the npm tree: `WebSearch` needs a user-installed
Python 3 interpreter (`python3`, or also `python`/`py -3` on Windows). Launchers set up
and validate the pinned DDGS venv when its readiness state is missing or outdated;
current launches reuse it without Python setup checks. Creating or repairing that venv
needs package-index access; a current cached environment starts offline. `npm install` downloads Playwright's
Chromium for `BrowserExtract` and the interactive browser tools unless skipped.
`WebFetch` needs neither. The full inventory, including what is user-installed versus
automatic, lives in [Getting started](docs/getting-started.md#prerequisites), along
with the current Bash/Unix requirements of the shell launcher and `ShellStart`.

## Installation

Use a numbered, prebuilt tarball from
[GitHub releases](https://github.com/rfairburn/pi-review-gate/releases). It includes
compiled code and the full prerelease version; no npm-registry publication or source
build is required. Choose a fresh installation prefix that no running session uses:

```bash
npm install --prefix ./new-inactive-install ./pi-review-gate-0.1.0-dev.N.tgz
```

By default, installation also verifies and downloads Playwright's Chromium build for
`BrowserExtract`. Server/CI installs that do not need browser extraction can skip it:

```bash
PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM=1 npm install --prefix ./new-inactive-install ./pi-review-gate-0.1.0-dev.N.tgz
```

`WebSearch` and `WebFetch` remain available either way. See
[Getting started](docs/getting-started.md#installation) for the recovery path when
Chromium is missing.

For development dependencies and tests in a source checkout, run `npm install` there.
Source launchers remain supported and prepare an inactive build automatically only
when relevant inputs have changed.

## Minimal configuration and launch

Launch the installed entry point on macOS/Linux:

```bash
./new-inactive-install/node_modules/.bin/pi-review-gate
```

On Windows, use the native cmd.exe/PowerShell entry point (no Bash or WSL required):

```bat
new-inactive-install\node_modules\.bin\pi-review-gate-cmd.cmd
```

Source-checkout equivalents are `./scripts/pi-review-gate.sh` and
`scripts\pi-review-gate.cmd`; both use the same shared current/preparation state as
the sidebar and web launchers.

An optional, separate session-host alpha can run multiple independent native Pi sessions
in one terminal on macOS/Linux. It does not replace either launcher; see the
[session-host alpha guide](docs/session-host-alpha.md) for requirements, limitations,
and the host-only shortcut configuration/editor.
Launch it with the one-command entry points. They retain a supported Node on PATH or
bootstrap the source-pinned official Node.js 22.19.0 archive under an isolated per-agent
cache when Node is missing or too old (macOS/Linux x64 or
arm64; Windows x64, arm64, or x86). The pinned archive digest is verified and freshly
extracted on installation/update; a previously completed fallback runtime is reused when
it is still current, so later fallback launches do not download or extract again. This
does not replace a global Node install or
change normal user configuration. The launcher also resolves (or provisions) the public
Pi runtime automatically — no manual Pi CLI path is needed. The `.cmd` entry point
performs the Node bootstrap. Experimental same-machine Windows source paths for the
native session-host backend are prepared for validation only: they do not establish
Windows support, parity, or readiness, and real Windows Node 22.19 and 24 native
runtime validation remains required. POSIX macOS/Linux remains the supported alpha
host scope:

```bash
./scripts/pi-review-sessions.sh   # macOS/Linux source checkout
```

```bat
scripts\pi-review-sessions.cmd    # native Windows entry point (experimental validation paths only; no Windows readiness claim)
```

An installed package exposes the `pi-review-sessions` command.

The persistent launcher selects the Pi agent directory's `review-gate.json`
(`~/.pi/agent/review-gate.json` by default, following `PI_CODING_AGENT_DIR`), then
`~/.config/pi-review-gate/config.json` as a compatibility fallback. It ignores an
inherited `PI_REVIEW_GATE_CONFIG`. If neither file exists, first launch creates a
private zero-model config and prints a notice; existing files are not overwritten
or migrated. No reviewer or worker model is selected implicitly. Configure selections
through `/review-settings` or edit the selected file.

Installation from a release tarball, configuration discovery, native launcher details,
and argument forwarding are covered in [Getting started](docs/getting-started.md).

A minimal config using Codex as the reviewer:

```json
{
  "enabled": true,
  "reviewerTimeoutMs": 600000,
  "maxCorrectionCycles": 3,
  "retainBundles": "on-failure",
  "externalAgents": {
    "codex": {
      "adapter": "codex-cli",
      "review": { "timeoutMs": 600000 }
    }
  },
  "review": {
    "primaryReviewers": [
      { "source": "external", "id": "codex" }
    ],
    "subtaskReviewers": [
      { "source": "external", "id": "codex" }
    ]
  }
}
```

The launcher builds when sources are present, refreshes the shipped skills, and
forwards remaining arguments to Pi. For direct extension loading (where
`PI_REVIEW_GATE_CONFIG` is honored), see [Launch paths](docs/getting-started.md#launching).
To disable everything, set `PI_REVIEW_GATE_DISABLED=1`.

See [Configuration](docs/configuration.md) for fields and compatibility,
[Settings](docs/settings.md) for the staged menu, and [examples/](examples/) for
ready-to-run configurations.

## Platform and shell compatibility

`ShellStart` uses a fixed shell: Bash on macOS/Linux; PowerShell on Windows
(`pwsh.exe`, then `powershell.exe`). There is no shell selector; a missing Windows
shell fails before any job starts. Host shell-tool availability and authorization
remain ceilings, and plan/research posture exposes no arbitrary shell.

The launcher has a native Windows entry point, but broader native Windows
worktree/landing/recovery validation remains incomplete. The complete shell and
ownership contract is in [Background shell tools](docs/delegated-execution.md#background-shell-tools).

## How a review turn works

With automatic primary review enabled and usable reviewers selected:

1. An agent turn completes and is appended to the review window's evidence bundle as a
   numbered exchange (by default, workspace diff, side effects, tool evidence,
   summary, usage; **Tools only** selections disclose their narrower basis).
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

With a worker route configured, the orchestrator can start 1–128 bounded background tasks
per group. An `execute` task captures the source workspace independently (git-ignored
files are never captured or landed), works in an isolated worktree, and lands on its
own: accepted tasks acquire the source-mutation lease, replan against current main,
and leave landed changes uncommitted without touching source HEAD, index, staging
state, or stash. Three-way conflicts materialize ordinary diff3 markers plus a durable
gate that blocks later landings until `SubtasksMarkClean` verifies the resolution.

`research` returns a read-only report without landing. Opt-in `inplace` writes
immediately in an existing directory, including non-Git directories; the root is
cwd/snapshot scope, not a sandbox, and post-hoc review never gates or rolls back those
writes. See [Delegated execution](docs/delegated-execution.md) for kinds and lifecycle,
[Subtask evidence](docs/subtask-evidence.md) for inspection, and [Recovery](docs/recovery.md)
for durable recovery.

## Documentation

The [documentation index](docs/README.md) maps every topic and suggests reading paths.
Start with the guide for your task:

| Task | Guides |
| --- | --- |
| Install and configure | [Getting started](docs/getting-started.md), [Configuration](docs/configuration.md), [Settings](docs/settings.md) |
| Review and delegate | [Review workflow](docs/review-workflow.md), [Delegated execution](docs/delegated-execution.md), [Scheduled tasks](docs/scheduled-tasks.md) |
| Research and browse | [Web tools](docs/web-tools.md), [Browser guide](docs/browser.md), [Browser permissions](docs/browser-permissions.md) |
| Inspect and recover | [Subtask evidence](docs/subtask-evidence.md), [Recovery](docs/recovery.md), [Troubleshooting](docs/troubleshooting.md) |
| Assess and extend | [Security model](docs/security-model.md), [Development](docs/development.md), [Releases](docs/releases.md) |

## Development

```bash
npm run build:test    # compile tests without touching the live dist/
npm run test:run      # full compiled suite (up to four test files concurrently)
npm run check:static  # types, shell lint, docs links/anchors/JSON/privacy
npm run test:package  # scratch build, install, docs/example byte-fidelity smoke
```

Use an owned isolated build for commands that rebuild `dist/` (including `npm test`).
The [development guide](docs/development.md) owns prerequisites, fast/execution tiers,
serial diagnosis, launcher internals, the shared native presentation expansion (tool
results and automatic notifications), and verification limits.

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