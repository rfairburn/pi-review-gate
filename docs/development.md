# Development

This page owns the build, test, static-check, and packaging workflows plus launcher
internals. It does not add repo-management guidance; CI lives in the repository's
`.github/workflows/ci.yml` (present only in the checkout, not shipped in the npm
package).

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

## Build and test commands

```bash
npm install        # install dependencies (downloads Chromium unless skipped)
npm test           # build + full test suite (up to four test files concurrently)
npm run test:fast  # short pure/unit development loop
npm run test:integration
npm run test:execution   # serial background-controller, recovery, pool, session, tool-contract tier
npm run test:serial      # full serial fallback for resource- or ordering-sensitive diagnosis
npm run check:static     # tsc --noEmit, shellcheck, and docs validation
npm run test:package     # stage+build in scratch, npm pack, install-into-consumer smoke
```

The complete `npm test` run executes up to four test files concurrently. Use
`npm run test:fast` for the short pure/unit development loop. Use `npm test` (or
`npm run test:integration`) for the process, Git, filesystem, and end-to-end suite
before finalizing a phase. Use `npm run test:execution` for the serial
background-controller, recovery, pool, session, and tool-contract tier. For diagnosing
resource-sensitive or ordering-sensitive failures, use the full serial fallback
(`npm run test:serial`).

`npm run test:package` runs `scripts/package-smoke.cjs`: it compiles production output
into a scratch staging tree without touching live `dist`, packs that tree with lifecycle
scripts disabled, installs the tarball into a scratch consumer, asserts that required
files (including the public `docs/` tree) are present, checks that the `pi-review-gate`
bin is executable, and runs the deterministic docs validation against the installed
package layout.

## Static checks and docs validation

`npm run check:static` runs `tsc --noEmit`, `shellcheck scripts/*.sh`, and
`node scripts/check-docs.cjs`. The docs check is deterministic and covers:

- Every relative link in `README.md` and `docs/*.md` resolves to an existing file.
- Every local anchor (`#fragment`, including `page.md#fragment`) matches a heading in
  the target page (GitHub-style slug matching).
- The required public docs set exists and every docs page is reachable from the root
  `README.md` through relative links (core reachability).
- Every fenced `json` code block parses as JSON.
- Referenced repository paths (examples, scripts, license files) exist.

The script accepts an optional root directory argument so the package smoke can validate
the installed package layout with the same rules.

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