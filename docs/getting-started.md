# Getting started

This page covers prerequisites, installation, first configuration, and launch paths.
Behavioral detail lives in the linked pages.

## Prerequisites

### Installed by you

- **Node.js 20 or newer** (`engines.node: ">=20"` in `package.json`), plus **npm**
  for installation and source-checkout builds. CI exercises Node 20 and Node 24.
- **Pi**, installed independently. `pi-review-gate` consumes Pi's public extension and
  CLI/RPC surfaces; it does not patch or bundle Pi, and Pi remains independently
  installed and upgradeable. Use a Node version meeting both packages' requirements:
  for example, Pi 0.85.1 requires Node.js 22.19.0 or newer even though this extension's
  own declared minimum is Node.js 20.
- **A reviewer or executor harness**, installed and authenticated by its own
  login/configuration: the Codex CLI (`codex` by default), the Claude CLI (`claude`),
  a Pi-scoped model (the `pi` CLI), or a generic CLI program. Do not put OAuth tokens
  or API keys in the review-gate config file — see
  [Security model](security-model.md#secrets-and-authentication).
- **Git on `PATH`** — required for delegated execution, recommended for review-only
  use:
  - Delegated execution invokes Git directly and fails closed without it. Subtask
    capture builds a private bare repository, workers run in detached-HEAD worktrees
    (`git worktree add`/`remove`/`prune`), candidate snapshots are committed with
    plumbing commands (`write-tree`, `commit-tree`, `update-ref`), landing, integration,
    and recovery diff and reset through Git, and conflicts materialize real diff3
    markers with `git merge-file --diff3`. The Git binary is required even when the
    capture target is not itself a Git checkout: non-Git directories and repositories
    with an unborn `HEAD` are captured through that private bare repository, so
    missing-Git capture fails with `Git discovery failed` rather than falling back.
  - Ordinary review evidence capture enumerates the workspace with
    `git ls-files -co --exclude-standard` when Git is available and falls back to an
    omission-aware filesystem walk when it is not (or the workspace is not a
    repository). Review-only use without Git still works; with Git, ignored files are
    excluded from capture by Git's own enumeration.

- **Python 3, for `WebSearch`** — user-installed (`python3` with the standard
  `venv`/`pip` tooling); the pinned DDGS environment it fills is created and managed
  automatically below. No other runtime feature uses Python.
- **Bash and standard Unix command-line utilities, for the current `.sh` launchers.**
  These scripts use tools such as `dirname`, `mkdir`, `mktemp`, `chmod`, `cp`, and
  `rm`; Bash alone is not the entire launcher environment. Normal launch provisions
  or validates DDGS even if the session will not use `WebSearch`.
- **Bash at `/bin/bash`, for `ShellStart`.** Its watchdog and process-tree cleanup
  currently depend on POSIX process groups and shell utilities such as `sleep` and
  `kill`. Native Windows PowerShell support for this background tool is not yet
  implemented; Pi's separate native `powershell` tool does not supply that backend.

On Windows, Git must still be available on `PATH` for delegated execution; Git for
Windows supplies the executable. Requiring Git does not itself require using its
bundled Bash as the launch shell. Current `.sh` launcher requirements and ShellStart's
POSIX requirements are separate limitations, not proof of native Windows support.
Minimum Git, Python, and external harness versions are not pinned in the package
engine declaration; do not interpret that absence as verification of every version.

### Managed automatically

- **The `WebSearch` DDGS environment** — the launcher and the `pi-review-web.sh`
  wrapper automatically create, validate, and repair a per-user venv containing the
  pinned `ddgs==9.15.0` (`~/.cache/pi-review-gate` by default; relocatable via
  `PI_REVIEW_GATE_DDGS_VENV` and `XDG_CACHE_HOME`). Creating or repairing that venv
  needs package-index access; a valid cached environment is only validated, so
  launches can succeed offline. Management fails closed when the environment cannot
  be established. Each `WebSearch` call then runs Python at search time: the wrappers
  export `PI_REVIEW_GATE_DDGS_PYTHON` pointing at the managed venv, and a direct
  `pi -e` load without the wrappers falls back to `python3`, which must itself have
  DDGS installed, or use an explicitly configured `PI_REVIEW_GATE_DDGS_PYTHON`
  interpreter with DDGS installed. Direct extension loading does not run the shell
  provisioning helper. Details:
  [Web tools](web-tools.md#websearch).
- **Playwright's Chromium build** — required by `BrowserExtract` and the interactive
  browser tools only. `npm install` verifies and downloads it best-effort;
  `PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM=1` skips that, and
  `npx playwright install chromium` installs it later. `WebFetch` uses no browser,
  and the `WebSearch` venv is managed independently. See
  [Installation](#installation) for the recovery path.

No API keys or OAuth tokens belong in the review-gate config; harness authentication
stays in each harness's own login/configuration.

## Installation

From a checkout of this repository:

```bash
npm install
```

By default, installation verifies and, when necessary, downloads Playwright's compatible
Chromium build for `BrowserExtract`. CI and server installs that do not need
`BrowserExtract` can skip that browser download:

```bash
PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM=1 npm install
```

This only skips Chromium provisioning; `WebSearch` and `WebFetch` remain available. If
provisioning fails for another reason, installation still completes with a warning so
the core package remains usable. Invoking `BrowserExtract` without Chromium then reports
the setup action directly: run `npx playwright install chromium` in the package
environment and retry. If the skip variable was set, unset it before reinstalling or run
that command manually when browser extraction is needed. See
[Web tools](web-tools.md#browserextract-rendered-page-extraction).

## Minimal configuration

A review-gate config is a single JSON file. Where you place it and how the extension
finds it depends on your launch path: the persistent launcher reads one of two fixed
paths, while direct `pi -e` loading uses `PI_REVIEW_GATE_CONFIG` (see [Launching](#launching)).
On its first launch, the persistent launcher creates the file for you at the default
location — `~/.pi/agent/review-gate.json` (`%USERPROFILE%\.pi\agent\review-gate.json` on
Windows, following Pi's `PI_CODING_AGENT_DIR` override) — with a valid zero-model
default — no reviewers or workers selected — so a fresh install starts without any
hand-created config. You then
add reviewers and workers through `/review-settings` or by editing the file; until you
do, automatic review stays off and nothing is invoked.
A minimal example using Codex as the reviewer:

```json
{
  "enabled": true,
  "reviewerTimeoutMs": 600000,
  "maxCorrectionCycles": 3,
  "retainBundles": "on-failure",
  "externalAgents": [
    {
      "id": "codex",
      "adapter": "codex-cli"
    }
  ],
  "review": {
    "activeReviewers": [
      { "source": "external", "id": "codex" }
    ]
  }
}
```

The complete field reference, including multi-reviewer, delegated-execution, and web
settings, is owned by [Configuration](configuration.md). Ready-to-run starter files live
in [examples/](../examples):

- `examples/single-codex.json` — Codex-oriented starter config.
- `examples/single-claude.json`, `examples/single-pi-model.json` — Claude and Pi model
  reviewers (the Pi example currently uses `ollama/glm-5.2`).
- `examples/double-review.json`, `examples/double-deepseek-v4-flash-review.json`,
  `examples/triple-review.json` — multi-reviewer setups. The DeepSeek double is an
  alternative to the default Codex + GLM-5.2 pairing and runs Codex plus
  `ollama/deepseek-v4-flash:0731-cloud`.
- `examples/delegated-execution.json` — worker resources, routes, and external agents.
- `examples/fake-reviewer.json` — deterministic reviewer for testing.

To disable the gate entirely:

```bash
PI_REVIEW_GATE_DISABLED=1
```

The environment kill switches disable the whole extension, including delegated
execution. See [Configuration](configuration.md#kill-switches) for the full list.

## Launching

For normal use, use the persistent launcher:

```bash
./scripts/pi-review-gate.sh
```

On Windows, use the native entry point instead (from cmd.exe or PowerShell, without
Bash or WSL):

```bat
scripts\pi-review-gate.cmd
```

From an npm installation on Windows, the command is `pi-review-gate-cmd`. The Windows
entry pairs a thin `.cmd` file with a Node helper that mirrors the POSIX launcher's
behavior, including its DDGS provisioning (natively, in a `Scripts\python.exe` virtual
environment) and the same exit codes; the POSIX launcher remains the macOS/Linux entry.
Other portable launchers are not completed.

The launcher builds the extension (when sources are present), selects the first existing
config — `review-gate.json` in the Pi agent directory (`~/.pi/agent/review-gate.json`,
following Pi's `PI_CODING_AGENT_DIR` override) or the compatibility fallback
`~/.config/pi-review-gate/config.json` — creating a private zero-model default config
at the default location when neither exists. A config that exists only at the fallback
location remains selected unchanged. It builds the extension when sources are present,
creates and validates the pinned `WebSearch` environment with `scripts/ensure-ddgs.sh`
(creating or repairing that venv requires `python3` on `PATH`; see
[Prerequisites](#prerequisites)), then
refreshes the discoverable orchestration skill at
`~/.agents/skills/orchestrator/SKILL.md` (including its recovery runbook), and then
executes the installed `pi` with the extension. On macOS/Linux the persistent launcher
is a Bash script; on Windows the native entry point
(`scripts\pi-review-gate.cmd`, or `pi-review-gate-cmd` from an npm installation) mirrors
the same behavior from cmd.exe or PowerShell without Bash or WSL. The extension selects the
[operating-mode prompt](configuration.md#operating-modes); all remaining launcher
arguments are forwarded unchanged. To limit the orchestrator, pass Pi's native tool
allowlist through the wrapper, for example
`./scripts/pi-review-gate.sh --tools read,bash,edit,write`
(or `scripts\pi-review-gate.cmd --tools read,bash,edit,write` on Windows).

For development, load the built extension directly into your pi host:

```bash
PI_REVIEW_GATE_CONFIG=/path/to/review-gate.json \
pi -e /path/to/pi-review-gate/dist/src/index.js
```

Launcher internals are documented in [Development](development.md#launcher-behavior).

## What happens on your first review

1. An agent turn completes. The extension captures the workspace diff, side effects, and
   tool evidence as a numbered exchange in a review window's evidence bundle
   (see [Review workflow](review-workflow.md#review-windows-and-evidence)).
2. The configured reviewer or reviewers run read-only against that bundle and produce a
   structured verdict.
3. The complete classified result — including passing and non-blocking material — is
   transmitted back to the implementing model.
4. If the reviewer requests changes, the model corrects within the configured correction
   budget, and each correction becomes a new reviewed exchange.

Background subtask execution is optional and configured separately; see
[Delegated execution](delegated-execution.md).

## Next steps

- Reviewer commands and the correction lifecycle:
  [Review workflow](review-workflow.md).
- Web research tools: [Web tools](web-tools.md).
- Something not working: [Troubleshooting](troubleshooting.md).