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

### Development prerequisites

- **Node.js 20 or newer and npm.** CI exercises Node 20 and Node 24; the optional real
  runtime regression needs Node 22.19 or newer (see below).
- **TypeScript and type definitions** arrive as ordinary `devDependencies` via
  `npm install`; the runtime dependencies (including Playwright, undici, and the HTML/PDF
  parsing stack) are ordinary npm packages.
- **A Git executable on `PATH`.** The delegated-execution, capture/landing, conflict,
  and recovery test tiers drive the real `git` binary (worktrees, private bare
  repositories, plumbing commands, and `git merge-file`), matching what the production
  code invokes.
- **`shellcheck` on `PATH`** for `npm run check:static`, which runs
  `shellcheck scripts/*.sh`.
- **Bash and Unix utilities** for launcher and background-process tests; some paths
  require `/bin/bash` and POSIX process-group behavior. These suites are not evidence
  of native Windows compatibility. **`tar` on `PATH`** is used to extract release
  packages by `scripts/release/packaging.cjs` and its verification tests.
- **Playwright's Chromium build** for the browser test tier. Install-time provisioning
  covers it; after a skipped install, run `npx playwright install chromium`
  (`--with-deps` adds Linux OS libraries, as the CI full-suite job does). Static checks,
  packaging smoke, the pure/unit and execution tiers, and the DDGS-mocked web-tool unit
  tests do not need Chromium — CI's fast job runs them with provisioning skipped
  entirely.
- **Optional: `PI_BROWSER_AGENT_RUNTIME`** pointing at an installed Pi agent-core
  `dist/index.js` enables `tests/browser-native-error.test.ts` (CI uses
  `@earendil-works/pi-agent-core@0.85.0`, which needs Node >=22.19; the model stream is
  mocked, with no live model calls). Without it the test skips itself. See
  [Web tools](web-tools.md#interactive-browser).
- **`python3` is not needed by the test suite**: DDGS interactions are mocked. In the
  runtime, Python is used only by `WebSearch` — launch-time venv creation/validation via
  `scripts/ensure-ddgs.sh` plus one Python process per search
  (`src/web/network.ts`).

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
and `CHANGELOG.md` stays truthful pre-1.0 (per-build candidate sections, preserved
aggregate history, no fake dated releases).
It also re-scans the source-only `.github/**` surface for private artifact references.

## Launcher behavior

`scripts/pi-review-gate.sh`:

- Delegates Pi package management verbs (`update|install|remove|uninstall|list|config|auth`)
  directly to `pi`.
- Unsets any inherited `PI_REVIEW_GATE_CONFIG` and re-resolves the persistent config so
  a parent pi session cannot silently redirect the gate; it deliberately does **not**
  unset `PI_REVIEW_GATE_DISABLED`, the documented kill switch, and warns when it is set.
- Selects the first existing config from the Pi agent directory's `review-gate.json`
  (`~/.pi/agent/review-gate.json`, following `PI_CODING_AGENT_DIR`) or the
  compatibility fallback `~/.config/pi-review-gate/config.json`. When neither exists,
  it initializes a private
  (directory `0700`, file `0600`) zero-model default config at the default location —
  explicitly empty reviewer and worker selections, written to a temporary name and
  published atomically so concurrent first launches can never clobber each other or
  expose partial JSON — and continues normal startup. Existing or malformed configs are
  never overwritten; creation failures (permission errors, non-regular paths at the
  config location) fail closed with distinct actionable diagnostics.
- Builds the extension when `src/index.ts` is present, otherwise requires the packaged
  `dist/src/index.js`.
- Runs `scripts/ensure-ddgs.sh` to create, validate, and repair the pinned web-search
  venv (creating or repairing it requires a `python3` interpreter on `PATH`; fails
  closed when the environment cannot be established).
- Refreshes the discoverable orchestration skill at
  `~/.agents/skills/orchestrator/SKILL.md` (and its recovery runbook) from the packaged
  sources, then executes the installed `pi` with the extension, forwarding all
  remaining arguments unchanged.

`scripts/pi-review-web.sh` similarly provisions DDGS, builds when sources are present,
and executes `dist/src/web/cli.js`.

The extension selects the configured [operating-mode prompt](configuration.md#operating-modes)
for each new run; the skill provides deeper guidance for decomposition, supervision,
reviewer interpretation, integration, and synthesis. The launcher does not impose a separate orchestrator policy;
to limit the orchestrator, pass Pi's native allowlist through the wrapper, for example
`./scripts/pi-review-gate.sh --tools read,bash,edit,write`.

## Protocol and compatibility notes

- Pi is independently installed and upgradeable; this project consumes its public
  extension and CLI/RPC surfaces rather than patching or bundling Pi.
- The `run-as-binary` executor protocol (`pi-review-executor-jsonl-v1`) is documented in
  [Delegated execution](delegated-execution.md#external-harness-protocol).
- Pre-cutover configuration fields (`decider`, `reviewers`, `enabledReviewerIds`,
  `execution.activeExecutor`, `execution.executorPool`, `execution.externalExecutors`)
  are no longer accepted: old-only records fail to load with an actionable diagnostic,
  and doubled records consume the canonical shape alone without rewriting the stored
  record ([Configuration](configuration.md#pre-cutover-configuration-fields)).

## Shared native tool-result expansion

Tool result expansion is presentation-only and Pi-native: Pi toggles each tool row's
expanded state through its configured expansion binding (`app.tools.expand`, ctrl+o by
default) and passes `{ expanded, isPartial }` to the registered `renderResult`. The
extension registers no competing key handler, mirrors no expansion state, and expansion
never reruns a tool, performs a network request, polls, or reads logs, artifacts, or
history — it renders only data the tool already returned.

All 37 registered extension-owned tools are covered by one shared mechanism in
`src/tool-result-expansion.ts` — there is no rendererless remainder:

- `expandableResult(collapsedRenderer, expandedRenderer?)` returns a Pi-compatible
  `renderResult` callback. Collapsed state (or any state before an expanded callback is
  contributed) renders the existing renderer unchanged; expanded state renders the
  contributed detail callback. A detail callback that throws or returns a non-component
  falls back to the collapsed renderer with a visible failure notice line so pending,
  partial, completed, error, and cancelled states stay stable and the failure never
  silently looks like a complete summary.
- Collapsed cards are actionable operation/outcome summaries; expanded views render the
  complete original model-visible inputs and results — no additional human-view
  masking, omission, summarization, or truncation is layered on top of what the model
  saw. Renderers reuse the native `renderResult` `context.args` (the actual recorded
  tool-call request) instead of duplicating inputs into truncated result-detail copies.
  Extra execution provenance is captured at the actual transport boundary only where
  the original call cannot establish it — for example the worker prompt, captured at
  dispatch after transformations, is retained rather than reconstructed later and
  labeled exact. Data genuinely omitted upstream (retention bounds, dropped log lines,
  uncaptured bodies, genuinely unavailable fields) stays truthfully disclosed; nothing
  is presented as complete when it cannot be shown.
- Centralized native hints (`src/tool-result-hints.ts`): the shared wrapper appends
  exactly one native-style `(ctrl+o to expand)` / `(ctrl+o to collapse)` hint to the
  header of every tool with a contributed expanded renderer; family renderers emit no
  expansion hints of their own. The key is never hard-coded: it is resolved at render
  time from the host's configured `app.tools.expand` binding, lowercase to match the
  native tool-row hint casing. The hint is width-safe — it rides on the header when the
  line still fits and otherwise moves to its own wrapped row(s) below the card (oversized
  tokens hard-wrap) without truncating or dropping any family line, so the affordance
  stays visible at every width.
- Interaction stays the host's own: keyboard expansion is the global `app.tools.expand`
  binding, which flips every row's expansion state together, and in fullscreen mode the
  host's per-card click region toggles one card without changing its neighbors. Regular
  mode remains keyboard-only. The mechanism registers no toggle state or handler and
  forwards any handlers the inner component defines, otherwise leaving events unhandled
  for the host's region.
- Start/Add lifecycle: `SubtasksStart` and `SubtasksAdd` return before dispatch. Their
  queued view truthfully says the prompt is not yet sent and that no captured base
  commit or worker worktree is available yet — nothing is inferred or fabricated. When
  an actual dispatch event arrives, the original tool card invalidates automatically
  through Pi's native renderer context (`context.invalidate()`) and re-renders with the
  controller's authoritative dispatch view: the prompt captured at the transport
  boundary (after transformations), the worker worktree, the captured base commit, and
  the current task state. Rendering and expansion trigger no polling, no fetching, and
  no dispatch.
- Control-character display encoding (`src/tool-result-text.ts`): recorded text that
  contains terminal control bytes renders through `visibleTerminalText` — a reversible
  visible display encoding (ESC as `\u001b`, CR as `\r`, literal backslashes escaped
  first, LF and TAB preserved) applied once at the raw-text display boundary. The
  encoding is not a redaction: nothing is filtered, masked, or truncated, and the
  upstream retention, redaction, and privacy rules that run before data reaches the
  model remain unchanged.
- Native image presentation: screenshot image blocks stay native Pi image content in
  both states; encoded image data is never printed, and the `[native image]` line
  denotes the actual native image component, never replacement text.
- The nine `Subtasks*` tools (`src/execution/tool.ts`) contribute their expanded detail
  callback: expanding a result renders a cohesive, provenance-separated view of
  already-returned data — submitted instructions and acceptance criteria, the actual
  steer instruction and continuation text (with any adapter-delivered variant shown
  separately when retained), actual dispatch records, and mode-specific evidence reads
  that are complete (the find query and every returned match, the requested range and
  every returned entry, the full returned chunk with its whitespace, and the actual
  call with its paired result or its not-yet-observed state); re-collapse restores the
  unchanged collapsed card.
- The five `Shell*` tools (`src/background-shell/index.ts`, `result-view.ts`) are wired
  with per-tool collapsed and expanded detail callbacks. The collapsed card shows the
  actionable job/outcome summary — for `ShellLog` the tail of the returned range with a
  truthful earlier-lines omission count; expansion renders the complete actual inputs
  and meaningful retained results: the full recorded command from the original call
  arguments (never a preview-capped copy), the complete returned log range with its
  range and drop markers, the actual stdin input, and the retained stop-all target
  snapshot. Expansion never re-reads, re-fetches, or reconstructs from live job state;
  restored results without structured details degrade to the retained text preview
  (bounded collapsed, complete expanded).
- The eighteen interactive `Browser*` tools from `BrowserOpen` through `BrowserClose`
  (`src/web/browser-renderer.ts`) share one wrapper (`browserRenderResult`): the
  collapsed view presents concise, tool-specific operation/outcome summaries rather
  than previews of returned diagnostic text (opened/navigated titles and URLs, snapshot
  ref counts and truncation state, console/network event and failure counts with
  cursor and drop accounting), and the expanded view renders the family detail callback
  from `details.response` — semantic snapshots, console/error and network diagnostics
  with cursor and retention bounds, allowlisted semantic inspection, history/tabs,
  interaction effect accounting, wait/scroll observations, screenshot capture bounds,
  and close teardown results. Submitted form values (`BrowserFill`, `BrowserType`,
  `BrowserSelect`) come from the recorded call arguments and are shown in human
  expansion without a second masking or truncation layer; the result payload itself
  intentionally does not echo them back to the model.
- The acquisition and search tools (`src/web/tools.ts`, `src/web/result-renderer.ts`):
  `WebFetch`, `BrowserExtract`, and `WebSearch` contribute collapsed cards naming the
  actual request and outcome plus expanded views with the effective request settings
  and the complete retained content — every returned block or search result once, with
  source, index/range, continuation and truncation details. Expansion never fetches
  unreturned blocks or re-runs a search.
- `ApplyPatch` (`src/apply-patch/tool.ts`, `result-renderer.ts`) contributes a genuine
  expanded arm: the complete requested patch envelope and the complete retained final
  diff; on partial failure the view distinguishes applied, failed, and not-attempted
  operations and shows the complete retained failure detail.
- `search_tools` (`src/deferred-tools.ts`, `src/deferred-tools-result-renderer.ts`)
  contributes collapsed and expanded views showing the actual query, matched and
  newly activated tools, and the real activation outcome, preserving the no-match,
  unavailable, invalid-query, and already-active distinctions from the operation
  record.

`isExpandableResult()` provides a wiring-audit marker used by
`tests/tool-result-expansion.test.ts` and
`tests/browser-render-registration.test.ts` to prove that every one of the 37
registrations routes through the shared helper, that expand and re-collapse render
through it, that the interactive browser family shares one wrapper instance, and that
expanded views carry the actual recorded inputs (including content beyond the legacy
preview caps and synthetic secret-shaped model-visible input shown unfiltered). The
registered browser tests render through the real registrations — including image
handling, errors, partial and empty results, long output bounds, and the redaction
boundaries — rather than only the module callbacks. The shared inventory also exercises
registered web, discovery, shell, subtask, and patch tools through expansion and
re-collapse with their real renderers.

## Third-party code

- The background-shell implementation and its tests are modified from Little Coder by
  Itay Inbar and are used under the Apache License, Version 2.0. The source files carry
  modification notices. See [NOTICE](../NOTICE) and
  [LICENSES/Apache-2.0.txt](../LICENSES/Apache-2.0.txt).
- The `ApplyPatch` V4A diff engine and its compatibility tests are adapted from the
  OpenAI Agents JS apply-patch implementation and are used under the MIT License. See
  [NOTICE](../NOTICE) and
  [LICENSES/MIT-openai-agents-js.txt](../LICENSES/MIT-openai-agents-js.txt). The canonical
  envelope parser (`src/apply-patch/envelope.ts`) implements the publicly documented
  OpenAI/Codex apply_patch grammar so patches authored by OpenAI models apply unchanged;
  it is an independent implementation of the public format — no Codex source code is
  copied.