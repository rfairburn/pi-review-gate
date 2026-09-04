# Getting started

This page covers prerequisites, installation, first configuration, and launch paths.
Behavioral detail lives in the linked pages.

## Prerequisites

- **Node.js 20 or newer** (`engines.node: ">=20"` in `package.json`).
- **Pi**, installed independently. `pi-review-gate` consumes Pi's public extension and
  CLI/RPC surfaces; it does not patch or bundle Pi, and Pi remains independently
  installed and upgradeable.
- **At least one reviewer or executor harness**, installed and authenticated by its own
  login/configuration: the Codex CLI, the Claude CLI, a Pi-scoped model, or a generic
  CLI program. Do not put OAuth tokens or API keys in the review-gate config file —
  see [Security model](security-model.md#secrets-and-authentication).

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
A minimal example using Codex as the reviewer:

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

For normal use with the first existing fallback config, use the persistent launcher:

```bash
./scripts/pi-review-gate.sh
```

The launcher builds the extension (when sources are present), selects the first existing
config from `~/.config/pi-review-gate/config.json` or `~/.config/pi/review-gate.json`,
refreshes the discoverable orchestration skill at
`~/.agents/skills/orchestrator/SKILL.md` (including its recovery runbook), and then
executes the installed `pi` with the extension and the orchestrator prompt. All remaining
arguments are forwarded unchanged. To limit the orchestrator, pass Pi's native tool
allowlist through the wrapper, for example
`./scripts/pi-review-gate.sh --tools read,bash,edit,write`.

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