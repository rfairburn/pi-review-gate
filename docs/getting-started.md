# Getting started

This page covers prerequisites, installation, first configuration, and launch paths.
Behavioral detail lives in the linked pages.

## Prerequisites

### Installed by you

- **Node.js at or above its release line's security floor**, plus **npm** for
  installation and source-checkout builds (see [Node.js security floors](#nodejs-security-floors)):
  Node 22.x needs **22.23.4** or newer, Node 24.x needs **24.22.1** or newer, and
  Node 26.x needs **26.12.1** or newer. CI's `verify` matrix exercises exactly those
  three floors.
- **Pi 1.0.0 or newer**, installed independently. `pi-review-gate` consumes Pi's
  public extension and CLI/RPC surfaces; it does not patch or bundle Pi, and Pi
  remains independently installed and upgradeable. Pi versions below 1.0.0 are
  outside the supported compatibility scope. Pi 1.0.0's own package metadata
  requires Node.js 22.19.0 or newer; this package's per-line security floors are
  higher, so use a Node version meeting both packages' requirements.
- **For reviews or worker execution: the chosen harness**, installed and
  authenticated through its own login/configuration: the Codex CLI (`codex` by default), the Claude CLI (`claude`),
  a Pi-scoped model (the `pi` CLI), or a generic CLI program. Do not put OAuth tokens
  or API keys in the review-gate config file — see
  [Security model](security-model.md#secrets-and-authentication).
- **Git on `PATH`** — required for captured/worktree-based delegated execution,
  recommended for review-only use. Opt-in [in-place work](delegated-execution.md#in-place-subtask-kind)
  also supports non-Git directories without capture or landing:
  - Captured/worktree-based execution invokes Git directly and fails closed without it. Subtask
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

- **Python 3.10 or newer, for `WebSearch`** — user-installed with the standard `venv`/`pip`
  tooling (`python3` on macOS/Linux; Windows also supports `python` and the
  existing `py -3` launcher); the pinned DDGS environment is created and managed
  automatically below. No other runtime feature uses Python.
- **Bash and standard Unix command-line utilities, for the current `.sh` launchers.**
  These scripts use tools such as `dirname`, `readlink`, `mkdir`, `mktemp`, `chmod`, `cp`,
  and `rm`; Bash alone is not the entire launcher environment. Launchers prepare DDGS
  when its recorded installation is missing or outdated, even if the session will
  not use `WebSearch`; current launches do not run Python setup checks.
- **Platform shell, for `ShellStart`.** macOS/Linux use `/bin/bash`, POSIX process
  groups and utilities such as `sleep` and `kill`. Windows uses `pwsh.exe` first,
  then `powershell.exe`, on `PATH`; neither available means no job can start.
  Windows descendant ownership uses PowerShell/.NET with Windows Job Objects;
  inability to establish that protection prevents the user command from running.
  There is no shell-selection argument or configuration.

On Windows, Git must still be available on `PATH` for delegated execution; Git for
Windows supplies the executable. Requiring Git does not itself require using its
bundled Bash as the launch shell. The native `.cmd` launcher needs no Bash or WSL;
ShellStart uses PowerShell on Windows independently of the launch shell. Launcher
and shell verification do not establish native Windows worktree/landing/recovery
compatibility.
Minimum Git, Python, and external harness versions are not pinned in the package
engine declaration; do not interpret that absence as verification of every version.

### Managed automatically

- **The `WebSearch` DDGS environment** — the launcher and the `pi-review-web.sh`
  wrapper automatically create, validate, and repair a per-user venv containing the
  pinned `ddgs==9.16.1` (the Windows launcher performs equivalent native provisioning
  with a `Scripts\\python.exe` venv; the `.sh` helpers use `bin/python`). The cache is
  `~/.cache/pi-review-gate` by default, relocatable via
  `PI_REVIEW_GATE_DDGS_VENV` and `XDG_CACHE_HOME`. Creating or repairing that venv
  needs package-index access. A current readiness marker and the expected installed
  paths let subsequent launches reuse it offline without running a version import
  or `pip check` again. Those full checks run during setup or repair before readiness
  is recorded. Management fails closed when the environment cannot be established. Each `WebSearch` call then runs Python at search time: the wrappers
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

### Node.js security floors

The Node.js requirement is a minimum per release line, not a single version:

| Release line | Minimum version |
| --- | --- |
| Node 22.x | 22.23.4 |
| Node 24.x | 24.22.1 |
| Node 26.x | 26.12.1 |

These minimums are the
[October 2026 Node.js security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases),
which fix several vulnerabilities in the 22.x, 24.x, and 26.x lines, including the
eMudhra intermediate-CA compromise. The
[Node.js 26.12.1 release notes](https://nodejs.org/en/blog/release/v26.12.1/), for
example, update the root certificates to NSS 3.131.1 and reject certificate chains
that contain blocked public keys. The package declares the floors as
`>=22.23.4 <24.0.0 || >=24.22.1 <26.0.0 || >=26.12.1`. A bare `>=22.23.4` would
still admit unpatched 24.x and 26.x releases.

- Later patch and minor releases in the same line are accepted. You do not need to
  move to Node 26; any supported line at or above its own floor works.
- Other majors keep their existing eligibility. This baseline adds no floor for
  them and drops none. The October 2026 security releases cover only the 22.x,
  24.x, and 26.x lines.
- The session-host entry points' managed fallback runtime stays on Node 22 and
  is now the checksum-pinned official Node.js 22.23.4 archive. A fallback runtime
  that an earlier release set up on Node.js 22.19.0 is not reused.
- Raising the documented minimum does not change any Node.js already installed or
  running on your machine, and nothing replaces a live runtime automatically. Update
  Node.js through your usual installer or version manager. Then restart running Pi,
  review-gate, session-host, and web-tool processes so they load the patched
  runtime. A process started before the update keeps running the old runtime until
  it exits.

## Installation

For a prebuilt release, download the numbered prerelease tarball from
[GitHub releases](https://github.com/rfairburn/pi-review-gate/releases). It already
contains compiled code and its full version, such as `0.1.0-dev.180`. Install it into
a new prefix that is not used by a running session:

```bash
npm install --prefix /path/to/new-inactive-install /path/to/pi-review-gate-0.1.0-dev.N.tgz
```

Use the installed entry points under that prefix's `node_modules/.bin/` (the native
Windows entry is `pi-review-gate-cmd`). No npm-registry publication is required.

For development dependencies and tests in a source checkout:

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
do, no reviewer or worker model is invoked implicitly; no usable review is configured.
For Claude Code or Codex CLI, open `/review-settings` → **External workers** →
**Create worker**, choose roles, then use human-readable **Model** and **Reasoning**
controls and timeouts. The menus offer no environment key/value editing: configure
environment variables by editing the JSON file (`env` on the entry or a role), and
staged edits preserve existing entries while the roles remain enabled. The executable is automatically
`claude`/`codex` with the fixed native protocol; no executable, argument-list, or
protocol-override menus are needed. Reasoning choices depend on the effective model;
CLI default means the CLI's own settings, not no thinking. Role effort inherits
Shared unless overridden with a supported level or CLI default; incompatible choices
require explicit resolution, never a silent fallback. See
[Native reasoning effort](configuration.md#native-reasoning-effort) for Max versus
Extra High (`xhigh`) and Codex Ultra's automatic task delegation.

All definitions are listed. Claude/Codex entries are editable, including ID and
adapter, and preserve custom/pinned models until explicit replacement. Apply
normalizes only that edited definition, migrating valid legacy effort and warning
before removing other advanced arguments, custom paths, and native protocol overrides.
Opening or cancelling an editor, or saving unrelated changes, preserves untouched
legacy definitions. Every supported editor has **Delete** beside **Apply**/**Cancel**;
unsupported entries offer only **Delete**/**Back**. Delete uses the original selected
identity, ignoring unapplied renames/edits, and also works for newly staged entries.
Renames keep references paired. Deletion reports resource/route/reviewer cleanup,
disables schedules with invalid pins or emptied explicit reviewer sets, and resets
only those invalid overrides to inheritance, explaining defaults on later re-enable.
Root **Save changes** (or Ctrl+S) persists these staged changes; root **Cancel**
discards them, while root Escape applies them to the running session only, without
saving them (see [Settings menu](settings.md#review-settings)).

The new or edited definition is immediately available for explicit **Worker resources**
or **Reviewers** selection before saving. Creation alone activates nothing; select
the workers you want, then **Save changes**. If the Claude/Codex CLI is missing, Save
still succeeds with a warning; affected workers cannot run until the executable is
installed and available on `PATH` for a created/applied definition. The bundled
model catalog does not guarantee installed CLI support or account/provider access;
the menu performs no live discovery or provider startup. Runtime failures remain
errors. See
[Creating and managing external workers](configuration.md#create-external-workers-in-the-settings-menu)
for the flow, inheritance effects, and release-maintained model catalogs.

A minimal example using Codex as the reviewer:

```json
{
  "enabled": true,
  "reviewerTimeoutMs": 600000,
  "maxCorrectionCycles": 3,
  "retainBundles": "on-failure",
  "externalAgents": {
    "codex": {
      "adapter": "codex-cli",
      "command": "codex",
      "model": "gpt-6.1-sol",
      "reasoningEffort": "high",
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

The recommended way to run Pi with the gate is the session-host sidebar: one terminal, one
left sidebar roster of your sessions, and the review gate plus the same shared
configuration in every session the host starts. Launch it from a source checkout with
`./scripts/pi-review-sessions.sh` (macOS/Linux) or `scripts\pi-review-sessions.cmd` (native
cmd.exe or PowerShell), or from an installed package with the `pi-review-sessions`
command. The host needs an interactive terminal and stable Pi 1.0.4 or newer; macOS and
Linux are the supported host platforms, and the Windows host paths are native-validation
paths rather than a Windows support claim (the genuine native Windows runtime cases stay
skipped under #345, so a green Windows matrix job is not Windows runtime evidence). Host
requirements, options, session and roster semantics, saved conversations, and the
physical-terminal limits are documented in
[Session host](session-host-alpha.md).

That recommendation is guidance only: it does not change what the package installs, its
command mapping, or its argument routing. The direct launchers below remain fully
supported entry points with unchanged behavior:

```bash
./scripts/pi-review-gate.sh
```

On Windows, use the native entry point instead (from cmd.exe or PowerShell, without
Bash or WSL):

```bat
scripts\pi-review-gate.cmd
```

The package's default launcher commands are unchanged: `pi-review-gate` runs
`scripts/pi-review-gate.sh`, `pi-review-gate-cmd` runs `scripts/pi-review-gate.cmd`, and
the separate `pi-review-sessions` command runs the shared session-host launcher
`scripts/pi-review-sessions.cjs`. From an npm installation on Windows, the launcher
command is `pi-review-gate-cmd`. The Windows entry pairs a thin `.cmd` file with a Node
helper that mirrors the POSIX launcher's behavior, including its DDGS provisioning
(natively, in a `Scripts\python.exe` virtual environment) and the same exit codes; the
POSIX launcher remains the macOS/Linux entry. The supported entry points are the POSIX
launcher, the native Windows launcher, the `pi-review-web.sh` web wrapper, and the
session-host entry points; no other launcher ports exist.

The launcher selects the first existing
config — `review-gate.json` in the Pi agent directory (`~/.pi/agent/review-gate.json`,
following Pi's `PI_CODING_AGENT_DIR` override) or the compatibility fallback
`~/.config/pi-review-gate/config.json` — creating a private zero-model default config
at the default location when neither exists. A config that exists only at the fallback
location remains selected unchanged. Pi, sidebar, and web launchers share the same
quick current-state decision on every supported OS. A current installation launches
without dependency installation, compilation, another staging copy, or exhaustive
validation. Relevant development-input changes or missing/outdated preparation trigger
an automatic update in an inactive managed generation, not the live checkout's `dist/`.
The pinned `WebSearch` environment and the shipped skills are prepared only when their
own readiness state is missing or outdated (see [Prerequisites](#prerequisites)).
The four shipped skills live under
`~/.agents/skills/` (pi-review-gate-orchestrator — including its recovery runbook —
pi-review-gate-execution, pi-review-gate-research, and pi-review-gate-completion).
The launcher then executes the installed `pi` with the prepared extension. The
session-host entry points (`scripts/pi-review-sessions.sh`,
`scripts\pi-review-sessions.cmd`, and the installed `pi-review-sessions` command) use the
same preparation and skill
readiness state before starting the host, so a direct sidebar
launch needs no wrapper prerequisite. The completion-guidance setting
controls only whether the extension supplies its automatic pointer; manual skill
discovery depends on the skill being installed in Pi's active skill path. Loading the
extension directly — without either launcher — does not install these skills.
On macOS/Linux, the persistent launcher is a Bash script; on Windows the native entry point
(`scripts\pi-review-gate.cmd`, or `pi-review-gate-cmd` from an npm installation) mirrors
the same behavior from cmd.exe or PowerShell without Bash or WSL. The extension selects the
[operating-mode prompt](configuration.md#operating-modes); all remaining launcher
arguments are forwarded unchanged. To limit the orchestrator, pass Pi's native tool
allowlist through the wrapper, for example
`./scripts/pi-review-gate.sh --tools read,bash,edit,write`
(or `scripts\pi-review-gate.cmd --tools read,powershell,edit,write` on Windows).

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
- Running several Pi sessions in one terminal, network roster access, and saved
  conversations: [Session host](session-host-alpha.md).
- Web research tools: [Web tools](web-tools.md).
- Something not working: [Troubleshooting](troubleshooting.md).