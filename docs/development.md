# Development

This page owns the build, test, static-check, and packaging workflows plus launcher
internals. CI lives in the repository's `.github/workflows/ci.yml` (present only in
the checkout, not shipped in the npm package).

## Repository layout

- `src/` — extension source. Notable areas: `src/execution/` (delegated execution and
  wave landing), `src/web/` (web tools), `src/adapters/` (reviewer/executor adapters),
  `src/apply-patch/` (V4A engine), `src/settings/`, `src/background-shell/`.
- `tests/` — Node test files compiled to `dist-test/`.
- `scripts/` — launcher, web CLI wrapper, DDGS provisioning, Playwright provisioning,
  package smoke, docs validation, fake reviewer, orchestrator prompt.
- `skills/orchestrator/` — the orchestrator skill refreshed by the launcher.
- `examples/` — runnable JSON configs ([Getting started](getting-started.md#minimal-configuration)).
- `docs/` — this documentation tree.
- Root policy docs: `AGENTS.md` (agent orientation), [CONTRIBUTING](../CONTRIBUTING.md),
  [SECURITY](../SECURITY.md), and [CHANGELOG](../CHANGELOG.md). The last three ship in
  the npm package; `AGENTS.md` is source-only.
- `.github/` — issue/PR templates, CODEOWNERS, and external review guidance (source-only
  governance; not shipped in the npm package).

## Build and test commands

```bash
npm install              # install dependencies (downloads Chromium unless skipped)
npm run build:test       # compile tests to dist-test/ without touching the live dist/
npm run test:run         # full compiled test suite (up to four test files concurrently)
npm run test:run:serial  # full serial fallback after npm run build:test, for resource- or ordering-sensitive diagnosis
npm test                 # build + full suite; rebuilds the live dist/, so reserve it for CI or an explicitly owned isolated build
npm run test:fast        # short pure/unit development loop
npm run test:integration # delegates to npm test; rebuilds the live dist/
npm run test:execution   # serial background-controller, recovery, pool, session, tool-contract tier
npm run test:serial      # build + serial suite; rebuilds the live dist/, so reserve it for CI or an explicitly owned isolated build
npm run check:static     # tsc --noEmit, shellcheck, and docs validation
npm run test:package     # stage+build in scratch, npm pack, install-into-consumer smoke
```

The complete suite (`npm run test:run`) executes up to four test files concurrently.
In a working checkout, compile with `npm run build:test` and then run `npm run
test:run`: that covers the process, Git, filesystem, and end-to-end tiers before
finalizing a phase without touching the live `dist/`. `npm test` (and
`npm run test:integration`, which delegates to it) also rebuilds the live `dist/`, so
reserve both for CI or an explicitly owned isolated build. Use `npm run test:fast`
for the short pure/unit development loop. Use `npm run test:execution` for the serial
background-controller, recovery, pool, session, and tool-contract tier. For diagnosing
resource-sensitive or ordering-sensitive failures, use the full serial fallback:
`npm run build:test` followed by `npm run test:run:serial`. `npm run test:serial`
rebuilds the live `dist/`, so reserve it for CI or an explicitly owned isolated build.

`npm run test:package` runs `scripts/package-smoke.cjs`: it compiles production output
into a scratch staging tree without touching live `dist`, packs that tree with lifecycle
scripts disabled, installs the tarball into a scratch consumer, asserts that required
files (including the public `docs/` tree) are present, checks that the `pi-review-gate`
bin is executable, and runs the deterministic docs validation against the installed
package layout.

## Static checks and docs validation

`npm run check:static` runs `tsc --noEmit`, `shellcheck scripts/*.sh`, and
`node scripts/check-docs.cjs`. The docs check is deterministic and covers:

- Every relative link in `README.md`, the root governance docs (`CONTRIBUTING.md`,
  `SECURITY.md`, `CHANGELOG.md`, and `AGENTS.md` when present), and `docs/*.md`
  resolves to an existing file.
- Every local anchor (`#fragment`, including `page.md#fragment`) matches a heading in
  the target page (GitHub-style slug matching).
- The required public docs set exists, every docs page is reachable from the root
  `README.md` through relative links, and the shipped root docs (`CONTRIBUTING.md`,
  `SECURITY.md`, `CHANGELOG.md`) are linked directly from `README.md` (core
  reachability).
- Every fenced `json` code block parses as JSON.
- Referenced repository paths (examples, scripts, license files) exist.
- The public governance/docs surface (validated markdown plus `.github/**` when
  present) is free of private artifact references: absolute home-directory paths,
  numbered project-board references, hidden agent-skill locations under the home
  directory, and prose mentions of markdown files outside the validated public
  inventory (derived from the markdown actually validated plus known source-only
  `.github` pages, so new public docs validate without a hardcoded list; code spans
  and fenced blocks may name product files). The patterns are identifier-free by
  design, so the check itself discloses nothing private.

The script accepts an optional root directory argument so the package smoke can validate
the installed package layout with the same rules. Source-only files (`.github/`,
`AGENTS.md`) are validated when present and simply absent in the installed layout; the
checker never requires them there.

## Governance and contribution tests

`tests/governance-docs.test.ts` (run by the full suite, `npm run test:run`) validates the
contribution surface itself: required governance files exist, the issue forms parse as
YAML and carry the required user-problem/repro/acceptance/security-privacy fields plus
the private security-reporting redirect, the PR template carries the linked-issue policy
and documentation/changelog/compatibility declarations, CODEOWNERS is ordinary public
default ownership, `SECURITY.md` routes to the private advisory without time promises,
and `CHANGELOG.md` stays truthful pre-1.0 (Unreleased summary, no fake dated releases).
It also re-scans the source-only `.github/**` surface for private artifact references.

## Launcher behavior

`scripts/pi-review-gate.sh`:

- Delegates Pi package management verbs (`update|install|remove|uninstall|list|config|auth`)
  directly to `pi`.
- Unsets any inherited `PI_REVIEW_GATE_CONFIG` and re-resolves the persistent config so
  a parent pi session cannot silently redirect the gate; it deliberately does **not**
  unset `PI_REVIEW_GATE_DISABLED`, the documented kill switch, and warns when it is set.
- Selects the first existing config from `~/.config/pi-review-gate/config.json` or
  `~/.config/pi/review-gate.json`, failing with a clear message when none exists.
- Builds the extension when `src/index.ts` is present, otherwise requires the packaged
  `dist/src/index.js`.
- Runs `scripts/ensure-ddgs.sh` to provision the pinned web-search dependency.
- Refreshes the discoverable orchestration skill at
  `~/.agents/skills/orchestrator/SKILL.md` (and its recovery runbook) from the packaged
  sources, then executes the installed `pi` with the extension and the orchestrator
  prompt, forwarding all remaining arguments unchanged.

`scripts/pi-review-web.sh` similarly provisions DDGS, builds when sources are present,
and executes `dist/src/web/cli.js`.

The always-loaded orchestrator prompt establishes the role and subtask protocol; the
skill provides deeper guidance for decomposition, supervision, reviewer interpretation,
integration, and synthesis. The launcher does not impose a separate orchestrator policy;
to limit the orchestrator, pass Pi's native allowlist through the wrapper, for example
`./scripts/pi-review-gate.sh --tools read,bash,edit,write`.

## Protocol and compatibility notes

- Pi is independently installed and upgradeable; this project consumes its public
  extension and CLI/RPC surfaces rather than patching or bundling Pi.
- The `run-as-binary` executor protocol (`pi-review-executor-jsonl-v1`) is documented in
  [Delegated execution](delegated-execution.md#external-harness-protocol).
- Legacy configuration shapes (`decider`, `reviewers`, `enabledReviewerIds`,
  `execution.externalExecutors`) remain readable and are migrated into `externalAgents`
  on `/review-settings` save ([Configuration](configuration.md#legacy-compatibility)).

## Third-party code

- The background-shell implementation and its tests are modified from Little Coder by
  Itay Inbar and are used under the Apache License, Version 2.0. The source files carry
  modification notices. See [NOTICE](../NOTICE) and
  [LICENSES/Apache-2.0.txt](../LICENSES/Apache-2.0.txt).
- The `ApplyPatch` V4A diff engine and its compatibility tests are adapted from the
  OpenAI Agents JS apply-patch implementation and are used under the MIT License. See
  [NOTICE](../NOTICE) and
  [LICENSES/MIT-openai-agents-js.txt](../LICENSES/MIT-openai-agents-js.txt).