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
  package smoke, docs validation, fake reviewer, and the operating-mode prompt segments.
- `skills/pi-review-gate-orchestrator/`, `skills/pi-review-gate-execution/`,
  `skills/pi-review-gate-research/`, and `skills/pi-review-gate-completion/` — shipped
  skills refreshed by the launcher (orchestration with its recovery runbook,
  direct/delegated execution, read-only research, and completion handoff). The completion
  skill opts out of native automatic model invocation; the extension points to it only
  when completion guidance and notice availability are enabled and live authorized
  discovery exposes `YouShouldKnow`. Explicit `/skill:pi-review-gate-completion` use
  remains available.
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

- **Node.js 22.19.0 or newer and npm.** CI exercises Node 22.19.0 (the supported
  minimum) and Node 24.
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
  1.0.0-or-newer `dist/index.js` enables `tests/browser-native-error.test.ts` (CI uses
  the exact `@earendil-works/pi-agent-core@1.3.0`; the model stream is
  mocked, with no live model calls). Without it the test skips itself. See
  [Browser guide](browser.md#interactive-browser).
- **Optional: an installed Pi** (`@earendil-works/pi-coding-agent` plus its pi-tui
  peer, resolved from the node binary's install tree or the common global locations)
  enables the real-host tier of `tests/native-editor-bridge.test.ts` and the
  scheduled-workspace flow test: they drive the installed Pi's actual `CustomEditor`
  headlessly (Tab path completion, the fd-backed `@` picker, Ctrl+C clear, Ctrl+G
  external editing, image paste, Shift+Enter newlines, draft survival). Without a
  resolvable install those tests skip themselves; in an environment that has Pi,
  set `PI_REVIEW_GATE_REQUIRE_PI_HOST=1` to turn those skips into hard failures.
  The `@` picker test additionally needs `fd` on `PATH` and fails (rather than
  skipping) when the required-host gate is set and no finder is resolvable.
- **Test-only explicit paths (never shipped, never user-specific in tracked files):**
  Linux's full suite and the native Windows launcher job freshly install a locked
  `@earendil-works/pi-coding-agent@1.3.0` full runtime (manifests:
  `scripts/ci/pi-ui-runtime/`) into runner temp. This sits above the alpha
  helper's minimum stable Pi CLI version (1.0.4); the Windows tier still
  covers its existing standalone command/RPC and child-launch behavior, not
  that helper. They export
  `PI_REVIEW_GATE_INSTALLED_AGENT` (the package root),
  `PI_REVIEW_GATE_INSTALLED_PI_BIN` (the installed executable directory),
  `PI_REVIEW_GATE_EXPECT_PI_VERSION=1.3.0`, and
  `PI_REVIEW_GATE_REQUIRE_PI_HOST=1` for required host coverage. The command-path
  smoke runs the installed `pi`/`pi.cmd`, checks its exact version, and verifies
  RPC and candidate registration without a provider call. Missing prerequisites
  fail, rather than skip. A separate generated simple managed-style wrapper
  exercises the same real runtime; it is not an official installer run. The same job compiles the review-gate candidate into the runner
  temp (`npx tsc -p tsconfig.json --outDir ...`) and exports
  `PI_REVIEW_GATE_CANDIDATE_ENTRY` for the live PTY smoke, and provisions `fd`
  (Ubuntu's `fd-find`, exposed as `fdfind`) exporting the resolved binary as
  `PI_REVIEW_GATE_FD` so the `@` test never depends on ambient `PATH` variance.
  Locally, set `PI_REVIEW_GATE_INSTALLED_AGENT` to any installed pi-coding-agent
  package root and `PI_REVIEW_GATE_CANDIDATE_ENTRY` to a built `dist/src/index.js`
  to enable the TUI smoke. For `tests/pi-installed-launch.test.ts`, use the matching
  Pi 1.3.0 install, set `PI_REVIEW_GATE_INSTALLED_PI_BIN` to its executable directory
  and `PI_REVIEW_GATE_EXPECT_PI_VERSION=1.3.0`; set the required-host gate to make
  missing prerequisites fail locally too.
- **Live PTY smoke (`tests/pi-tui-live-settings-smoke.test.ts`):** drives the built
  candidate inside a real Pi TUI on a real PTY through the public
  `pi --no-extensions --extension <candidate>` seam, under a throwaway sandbox
  (synthetic `HOME` with a minimal `review-gate.json`, a synthetic workspace with a
  `docs/` folder and a workspace-root fixture, a stub `$EDITOR`, allowlisted
  environment with no `PI_REVIEW_GATE_*` variables and no provider API keys — no
  model/API call is possible). It walks `/review-settings` → Scheduled tasks → a
  task's workspace field and asserts, as screen-scraped observations: the native
  editor bridge hint line, the real first-Tab `docs/` list, a leading-`/`
  Workspace filesystem list (directory and file, no slash-command items), the
  real fd-backed recursive `@` picker (asserted on a workspace-root fixture only that
  picker can surface, frame-scoped so stale buffer content cannot satisfy it), Esc
  list-first semantics (text retention via a printable probe key), Ctrl+G external
  editing landing its content in the field, Enter staging the value into the task
  catalog, the reopen prefill, no field text leaking into the chat draft, no
  accidental chat/command submission, and the documented Ctrl+C-twice host exit.
  Every wait is time-bounded; the driver kills the forked PTY child's process
  group on exit, and on the overall timeout the driver's group is killed (the
  PTY child then sees the closed master and hangs up).
  Locally the smoke skips when a prerequisite is missing; under
  `PI_REVIEW_GATE_REQUIRE_PI_HOST=1` (CI) a missing prerequisite is a hard failure.
  CI additionally links the checkout's `node_modules` and `scripts` into the
  disposable candidate directory (the compiled entry resolves dependencies with
  plain Node resolution and loads its mode prompts from the adjacent scripts
  directory; both are required outside the checkout).

  **Reported gaps (not faked):** the live smoke does not seed or decode an OS
  image clipboard or prove a pasted image's bytes were read by Pi. The
  installed-host scheduled-image test instead simulates Pi's native clipboard
  callback while exercising the real `CustomEditor` paste key handler, settings
  Save/Cancel, and managed-asset persistence. The live smoke also asserts
  nothing about a single-press Ctrl+C clear: a cleared editor row is only observable as an absence in the newest
  redraw fragment, and the probes (raw `\x03` and the Kitty-protocol CSI-u form
  `\x1b[99;5u`, in the main chat editor and in a bridge-opened field) could not
  reproduce it through that heuristic. The double Ctrl+C host exit IS asserted and
  proves the same `app.clear` handler ran — its first press calls the host's
  `clearEditor()`, its second exits — so the clear code path is exercised even
  though the cleared row is not screen-scraped. The bridge tiers exercise the
  editor-level Ctrl+C handler directly. To close the gap deterministically, assert
  the clear behaviourally: type `docs/` in the workspace field, press Ctrl+C once,
  then Enter — the empty value is rejected with the unique
  "Workspace must be a non-empty string." notice, and reopening shows no prefill.
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
bin is executable, requires every actual flat `docs/*.md` page and standalone
`examples/*.json` configuration in the source tree to install byte-identically into the
packaged tarball (derived coverage with no hardcoded file list, so newly added pages and
example configs are validated automatically when the shipped tree moves or grows), and
runs the deterministic docs validation against the installed package layout.

The focused shipped-config tests (`tests/example-configs.test.ts`) normalize the shipped
standalone example configs and the runnable JSON blocks in the documentation through the
production strict validator and check intended reviewer selections/resolution and worker
routes using hermetic fixtures, without invoking providers or reviewer/executor commands.

### Fullscreen popup pointer-input verification (#431, #436)

`tests/user-question-mouse-host.test.ts` drives the production shared-popup
registration and factory through the installed Pi's real `TuiAltScreen` mouse
dispatch: synthetic SGR (1006) cell-coordinate packets enter the terminal input
callback, so Pi's own parser, overlay hit test, press capture, drag tracking,
click synthesis, native selection, and clipboard seam decide what happens — the
extension's own handler is never called directly. It asserts the text the host's
public `copyActiveSelectionToClipboard()` actually resolves from its own visible
screen, with `copyOnSelect` off and a recording `copySelection` seam, so no OS
clipboard is touched. The same file sends the configured explicit-copy bytes
through that same production path — `registerUserQuestions` → shortcut handler →
real `TuiAltScreen` overlay dispatch — and asserts Pi's own `app.message.copy`
binding (Ctrl+X by default, live-remappable through `keybindings.json`) copies
the visible selection once and only while a fullscreen selection is live, that
the release itself copies nothing with copy-on-select off, that no hidden
transcript text is copied, that a transcript selection inherited from before the
popup opened is dropped at popup entry and never copied (a fresh popup selection
then still copies), that no selection leaves the key with the existing
editor/navigation behavior, and that a rejected clipboard seam is swallowed
without closing the popup. The boundary is headless: this proves the dispatch
the installed runtime performs for given bytes, not which bytes a particular
physical terminal emits, and it does not exercise `InteractiveMode`, the
session-host pane-forwarding path, or an OS-level selection/paste.

Manual check on a real terminal: open the popup with Ctrl+Alt+Up, drag with the
left button across the question/notice body or context, and release. With Pi's
`fullscreenCopyOnSelect` setting enabled (the default) Pi's own clipboard path
copies the selection on release, and it can be pasted outside Pi; the selection
is Pi-managed rather than terminal-owned, so the terminal's own copy gesture
copies nothing on its own. With copy-on-select off nothing is copied on
release; press Pi's configured copy shortcut (**Ctrl+X** by default, or your
`keybindings.json` remap) to copy the visible selection through Pi's own
fullscreen-selection path, without closing the popup or changing the setting.
Opening the popup clears a selection made before it opened, so the shortcut only
ever copies a selection made over the visible popup. Confirm that a press on a
drawn menu entry highlights it
and a completed click runs its action, while a body-originated drag that crosses
or releases over an action never runs it. `tests/session-host-main.test.ts`
separately covers the session-host authority this relies on: only an initial left
press above a pane can activate a row, so stray drag or release packets outside
the popup cannot switch sessions or trigger a deliberate action.

## Static checks and docs validation

`npm run check:static` runs `tsc --noEmit`, `shellcheck scripts/*.sh`, and
`node scripts/check-docs.cjs`. The docs check is deterministic and covers:

- Every relative link in `README.md`, the root governance docs (`CONTRIBUTING.md`,
  `SECURITY.md`, `CHANGELOG.md`, and `AGENTS.md` when present), and `docs/*.md`
  resolves to an existing file.
- Every local anchor (`#fragment`, including `page.md#fragment`) matches a heading in
  the target page (GitHub-style slug matching).
- The required public docs set exists, every discovered flat `docs/*.md` page is
  reachable from the root `README.md` through relative links (required reachability
  derives from the discovered docs inventory, not merely the fixed core list, so a newly
  added page must gain a README-reachable inbound link), and the shipped root docs
  (`CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`) are linked directly from
  `README.md` (core reachability).
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
- Refreshes the shipped skills under `~/.agents/skills/` — pi-review-gate-orchestrator
  (including its recovery runbook), pi-review-gate-execution, pi-review-gate-research,
  and pi-review-gate-completion — from packaged sources, then executes the installed
  `pi` with the extension, forwarding all remaining arguments unchanged. The completion
  skill remains explicitly invocable but is excluded from native automatic model routing;
  the extension supplies its prompt only when both guidance settings are On and live
  authorized discovery exposes `YouShouldKnow`.

`scripts/pi-review-web.sh` similarly provisions DDGS, builds when sources are present,
and executes `dist/src/web/cli.js`.

`scripts/pi-review-gate.cmd` + `scripts/pi-review-gate-launcher.cjs` (issue 108) are the
native Windows counterparts of the persistent launcher: the thin `.cmd` passes its raw
arguments to the helper, which forwards Pi management verbs directly to `pi` (with the
inherited environment and no setup) and runs everything else natively — deleting an
inherited `PI_REVIEW_GATE_CONFIG`, resolving
`PI_CODING_AGENT_DIR` with Pi's native semantics (a deliberate mirror of
`src/config-path.ts`; keep the two in sync), initializing the zero-model default config
with exact-destination link publication, rebuilding dist or requiring the packaged
artifact, provisioning the pinned DDGS dependency in a `Scripts\python.exe` venv
(`python3`, then `python`, probed for isolated-mode usability; the POSIX
`scripts/ensure-ddgs.sh` stays the macOS/Linux mechanism), publishing the orchestrator
skill through an atomic rename, exporting `PI_REVIEW_GATE_DDGS_PYTHON`, and executing
`pi` with the forwarded arguments and exit status. On Windows it resolves `pi.cmd`
on `PATH` and invokes that full path through the parent's validated absolute
`SystemRoot\System32\cmd.exe`, without reading the shim or resolving Pi's underlying
installation; an installed `pi.exe` continues to run directly. The interpreter must
exist as a regular file at the parent's fully qualified `SystemRoot\System32\cmd.exe`;
child `SystemRoot`, `ComSpec`, `PATH`, and the working directory cannot override it, and an
invalid or missing interpreter fails closed. Normal Windows batch parsing, including
`%VAR%` expansion, applies. Publication runs in-process (`fs.linkSync`/`fs.renameSync`),
and Python is spawned with argument arrays. npm's development build still uses its
resolved JavaScript entry point with a fixed-token fallback through the same
validated system command processor; that fallback also fails closed when the
interpreter is unavailable. POSIX uses plain
`execvp`. Invoking a `.cmd` file from PowerShell still crosses cmd.exe parsing:
PowerShell string delimiters alone do not protect batch metacharacters. For example, pass `--label '\"a&b|c^d\"'` from
PowerShell so literal double quotes protect the value through batch forwarding.
Command-shell expansion (including `%VAR%`) can happen before the helper receives an
argument, and Pi's batch invocation also follows command-shell expansion rules. POSIX
permission modes (0700/0600/0644) are requested for parity and are no-ops under Windows
ACLs. CI covers the native paths on `windows-latest`
(`.github/workflows/ci.yml`, focused `launcher-cmd` tests); macOS/Linux behavior of the
POSIX launcher is unchanged.
The `review-checkpoint-windows` tests exercise raw parent checkpoint directory-sync
and file-identity error boundaries with mocks on every host, plus native Windows
capture/reload/frozen-comparison/advancement. Raw checkpoint tests point
`PI_CODING_AGENT_DIR` (or an explicit test scope) at a disposable directory, because
non-Git records live in the session namespace under the Pi agent-data directory; the
`review-checkpoint-session-storage` and `entrypoint-session-checkpoint-storage` tests
cover that layout, isolation, and lifecycle. Both Windows CI Node versions run
that file; the full suite also runs its non-skipped mocked cases.
The launcher and the extension's Pi child launches (reviewer prompts, the
delegated Pi RPC executor, and compaction recovery) share one authoritative
resolver and spawn-spec generator. On Windows it resolves the installed
`pi.exe` directly or invokes the full `pi.cmd` path through the parent's validated
absolute `SystemRoot\System32\cmd.exe` with `/d /s /c`, `cmdQuote`, and
`windowsVerbatimArguments`; it does not inspect or parse Pi's shim, so both simple
managed shims and npm-generated shims use the same path. The interpreter is checked
as an existing regular file and never selected from the child environment, `ComSpec`,
`PATH`, or working directory; invalid or missing parent `SystemRoot` fails closed.
The launcher's npm-only parser remains separate for its development build;
its batch fallback uses the same validated absolute system command processor.
POSIX default launches and configured custom commands retain their
existing spawn semantics, and a missing default CLI fails closed.

For a Windows `.cmd` launch, `cmd.exe` remains the owned lifecycle and cleanup
root (including tree termination with `taskkill /T`), while the signed RPC
settlement receipt identifies the actual Pi process. Before accepting its
first receipt, the parent authenticates the existing child/session/generation
signature and then verifies through bounded native process ancestry evidence
that the reported live PID descends from the still-owned command root. The
query rechecks process creation times and parent links and requires each parent
to predate its child, rejecting recycled PIDs. That verified PID is bound for
exact equality on later receipts; the receipt wire schema and HMAC identity
remain unchanged. When that verification refuses, the existing settlement
refusal is kept verbatim and one fixed sanitized stage code is appended
(`[lineage stage: <code>]`), naming the bounded stage that refused: preflight
(non-Windows host, invalid identity, already-exited owned root, unvalidated host
root), the one query child (spawn failure, nonzero exit, output-cap, or a
timeout positively witnessed by the verifier's own deadline callback — never
inferred from a kill flag, signal, or elapsed time), the native ancestry script's
own sentinel (missing candidate/ancestor/root record, absent parent, cycle,
64-step limit, live-snapshot count/creation/parent incoherence), the local
evidence validator, or the final owned-root liveness check. Stage codes are a
closed fixed list; a thrown verifier reports `verifier-error` and a missing,
unknown, or malformed stage reports `unknown`. No query output, raw
stdout/stderr, error text, command line, host path, PID, or process inventory
is ever appended; plain-boolean verification callers keep the original wording
unchanged, and only strict `verified === true` accepts — a truthy result object
never does. The 5-second/4KiB/64-step bounds, single query child, no-retry
behavior, owned-root ownership, and PID binding are unchanged; the stage is
diagnostic only. Focused tests cover command generation, PID binding,
owned-tree teardown, and every refusal stage; native `.cmd` cleanup verifies the
actual Pi PID exits and waits for process close before removing its sandbox.

Terminal teardown bounds inherited-pipe waits separately from root exit. Reviewer
cleanup drains for its escalation interval plus a five-second grace period; RPC
and recovery cleanup use a seven-second terminal drain after signaling. RPC keeps
its existing fifteen-second graceful shutdown window where applicable. Root exit,
cancellation, and interruption stop background-readiness waits and deadline renewal.
An observed root exit retains its actual status, but missing close/cleanup evidence
is an explicit infrastructure failure, not an accepted executor result. Destroying
local stdio cannot confirm descendant cleanup, including for concurrent close
waiters. POSIX owned groups remain signalable after leader exit; Windows refuses
`taskkill /T` against an already-exited root and reports uncertainty instead.
Lifecycle callback persistence also has a five-second terminal completion bound;
a pending callback reports unconfirmed persistence instead of keeping completion
open indefinitely. Startup still persists process identity before prompt delivery,
with cancellation and the configured deadline active during that wait. Late callback
completion remains ordered and cannot deliver a prompt after teardown. Child ownership
records carry an optional lifecycle identity so a late exit from an earlier attempt
cannot clear a newer child's ownership, even if its PID is reused.
The required native Windows child suite includes
`tests/pi-child-teardown.test.ts` for reviewer, RPC executor, recovery, and
root-exit-during-background-readiness paths. The native launcher job runs
`tests/pi-settlement-lineage-diagnostics.test.ts` in that same child-process
step, so its native evidence is still collected when an earlier case in the step
fails. Its win32-only cases drive
the real production lineage query against real processes (a genuine descendant
must verify, an unrelated PID must be refused by a native chain/evidence stage),
while its cross-platform cases drive the same orchestration through a mocked
bounded query child to cover every refusal stage on every host. Native fixture
cleanup adopts a descendant identity only from a complete validated ownership
frame or ownership record, terminates the still-owned tree rather than only the
root, guards each step separately, waits for each fixture's actual `close` event
(an error event is not closure evidence), and keeps the ownership records on disk
whenever settlement stays unconfirmed instead of deleting its only evidence.

The native launcher job also carries one manual-dispatch-only sampling step for the
same unresolved question. `Compaction lineage sampling (manual dispatch only)` is
gated on `workflow_dispatch`, so pull-request and push runs of the required Windows
launcher check never execute or report it. It runs exactly five predetermined fresh
invocations of the existing
`executor compaction recovery launches the default pi child through the same resolver`
case — selected by a `--test-name-pattern` anchored to that exact title, each in its
own `node --test` process, against the same pinned installed Pi 1.3.0 environment as
the required child-launch step — so each sample starts its own owned `cmd.exe`-rooted
children and the unmodified production lineage query verifies each fresh child once.
The case, its assertions, and its disposable fake `pi` fixture are unchanged and no
provider or model call is made. All five samples always run: an earlier failure never
stops a later sample, no sample is ever rerun, and every sample's exit code is
collected, so any nonzero exit fails the step; a sample whose anchored case is absent
from its recorded TAP evidence also counts as failed, so a renamed or filtered case
cannot report green. The step carries its own finite timeout inside the job's existing
20-minute cap and extends no process, lineage, or job deadline. Fixed sampling is
evidence only: five passing samples establish no cause and apply no correction, and a
failing sample identifies only that one sample of a still-unproven refusal. The
`ci-workflow` contract tests pin the event gate, the fixed count, the reused
installed-Pi environment, and the accumulate-then-fail behavior.

The extension selects the configured [operating-mode prompt](configuration.md#operating-modes)
for each new run; each prompt opens with a startup cue to read the matching shipped
skill, which provides deeper guidance — decomposition, beneficial
parallelism and bounded task construction, supervision, reviewer interpretation,
integration, and synthesis for orchestration; direct and delegated execution
capabilities and the worker workspace contract for execution; the enforced read-only
boundary for plan/research. The launcher does not impose a separate orchestrator policy;
to limit the orchestrator, pass Pi's native allowlist through the wrapper, for example
`./scripts/pi-review-gate.sh --tools read,bash,edit,write`.

### Producer-owned disposable cache cleanup

`scripts/managed-generations.cjs` provides the CJS producer seam used by the optional
session host's development build and isolated Pi installer. Each type's direct child
entries are its complete inventory (target five); there is no parallel lifetime index
and no receipt written into a generation. These trees exist only under the designated
`.pi-review-gate/{build,pi-runtime,node}` caches, so their contents are disposable by
location: a descendant is reclaimable regardless of who created it and regardless of
whether any legacy lifetime/metadata record still exists. Existing source-build
freshness manifests/records remain the sole build-reuse authority and are not
repurposed as capacity evidence.

`admit(cacheRoot, create, options)` first takes the canonical per-agent coordination
entry (`<agentDir>/session-host/host-coordination.lock`) that the session host's
ownership acquisition also takes, then one exclusive `.admission.lock`, reclaims excess
generations down to four (so creation lands at or below five), creates the requested
generation, and holds the admission lock until the producer settles its own setup. The
admission entry's own identity is captured as part of that acquisition, and that exact
entry is released even when a host-ownership recheck skips reclamation, so a producer
never strands its own fresh metadata; release compares that identity, so a replacement
entry at the path is never removed. The coordination entry is released as soon as the
fresh generation exists, so a starting host is never held behind a long build or install.
It is a lock, not a registry: a stale or
malformed entry is reclaimed like a stale admission lock, and a busy live holder only
makes cleanup skip (with a bounded warning). Destructive reclamation rechecks the
ownership record after any admission-lock wait or stale/malformed recovery, and again at
every destructive boundary, so a host that becomes the owner mid-pass keeps the remaining
generations; when the coordination entry is unavailable, cleanup is skipped instead of
racing an ownership acquisition it cannot exclude. Host ownership acquisition likewise
claims the record inside a coordinated selection/preparation handoff: the launcher takes
that same entry before its final build/Pi revalidation, the host-entry load, and the
ownership claim, and hands it back once the ownership record exists. Inside the hold the
launcher revalidates the prepared build artifact (`validateSourceBuildArtifact` freshness
authority) and the selected Pi runtime (ordinary positive Node entry plus managed
generation confinement/identity through `pin`), and re-prepares or reselects them through
the existing selection path when a concurrent preparation reclaimed them — so a cache this
launcher pruned itself never becomes a new startup refusal. The native fallback-Node
producers run the same cleanup-only pass once at preparation settlement (joined, under the
same canonical entry and admission lock, targeting five while preserving the generation they
launched), so reclamation deferred by contention is retried instead of waiting for another
fresh generation. The canonical entry is published already complete (`pid` plus a targeted single-pid
process-start identity) through a private candidate and an atomic no-overwrite hard link,
so no half-written canonical record is ever observable and a paused publisher only loses
the link race; readers accept the publisher's transient hard-link pairing. The identity is one exact per-platform token: `linux:<boot identity>:<starttime>` read
from that single pid's `/proc/<pid>/stat` (no procps `ps` required, so minimal/BusyBox
images work), `darwin:<ps lstart>` from one targeted `ps` query, or `win32:<StartTime>`
from one targeted native PowerShell query for that one numeric pid (fixed argv, bounded,
no shell string). A record is honored only while its pid is alive *and* still reports the
recorded token, so a reused pid is reclaimed rather than becoming a permanent gate on any
supported platform; when the identity genuinely cannot be established no record is
published (the mutex is unavailable and the launch continues), never a weak pid-only
record. A birth query that *temporarily* fails is not a proven mismatch: a live pid with
a non-empty recorded identity is honored, so producer cleanup skips and an ownership
claim keeps waiting instead of stealing a live destructive holder's mutex mid-deletion,
while a real, different identity still proves reuse. This process's own identity is
re-queried until it succeeds and only a positive token is cached, so a transient failure
at load can never prevent publishing or recognizing its own hold. Stale recovery captures
the exact entry identity *before* it reads or judges the
owner in every wrapper, so a contender that publishes its own live record in that window is
never reclaimed: reclamation stays bound to the entry that was actually judged stale. Coordination helpers are resolved from the standard OS locations when `PATH` is
limited and are never a cache-cleanup or launch prerequisite. A managed explicit Pi
selection is validated through the same package authority used for installed packages
(`validatePiPackage` with the directory-chain check), so a partially reclaimed generation
that still has a runnable CLI is rejected; an unconfirmed validation-probe cleanup fails
the launch closed instead of re-preparing over a possibly live runtime. A live coordination holder
is waited for with no elapsed-time release, since it may be inside the destructive pass
that would delete this host's prepared generation; a genuine unremovable-entry failure is
retried and then treated as an unavailable (not refusing) boundary, with the ownership
record still stopping producer removals.
Capacity never refuses creation. A stale lock — one whose recorded pid is gone, or
whose record stays empty/malformed across several observations — is reclaimed instead
of becoming a permanent stop condition; a live owner is left alone and the producer
skips cleanup with a bounded warning, then still creates its generation. An existing
session-host ownership record makes cleanup skip the cache entirely. A real filesystem failure, an
unsafe entry, or a `.terraform` subtree leaves that generation in place and reports a
warning; startup continues and never claims a cleanup it did not perform. Generations
are removed in deterministic directory-name order; there is no age, size, or
retention policy. `options.replacement` lets the isolated Pi producer retry its own settled incomplete
version root after confirming that nothing was published; it applies the same
live-owner marker check, so a concurrently filling generation is never replaced. When that root still cannot
be reclaimed (busy/unreadable lock, a real removal failure, or a foreign entry), the
isolated Pi producer continues through confined `pi-<version>.<n>` generations with no
fixed candidate limit instead of stopping startup, and a read-only reuse pass selects
any existing valid generation for that exact version on later launches. `pin()` only confirms
that a reuse selection is a direct child of its managed cache; it writes no record,
and `generation.release()` settles only the setup admission because the next producer
cleanup reclaims excess generations.

Cleanup is progressive and bounded by the pass. One bounded pass inventories the type and
then removes generations one entry at a time, with deletion as progress: entries are
unlinked (or removed as empty directories) as they are visited, so a pass that reaches its
runtime budget keeps everything it removed and the next preparation continues from what
remains. One pass shares a single runtime budget (120 seconds by default) and a single
progress allowance instead of resetting either per generation: the budget is checked per
entry, and once the pass has deleted something it also stops before starting another
candidate, so a long run of empty directories or direct-child links cannot be processed
past the budget while the canonical mutex is held. There is no whole-tree preflight, entry-count quota, or depth quota
that could make a large or deep generation permanently undeletable, and a budget stop is
never a no-op: a pass that stops has already deleted something. A budget stop is reported
truthfully (`cache cleanup stopped at its runtime budget … the next preparation reclaims
more`) and startup continues. Reuse is not idle either: a compatible source-build or Pi
runtime reuse, and a settled preparation, run the same bounded pass with a per-type
target of five and never treat the generation this launch selected, created, or is
returning as a candidate (`keep`). A warm startup therefore converges older generations
without installing, compiling, or recreating anything.

Removal is a bounded, no-follow walk of one designated generation: links are
unlinked themselves and never traversed, a hardlinked file only loses this name, and a
special leaf (FIFO, socket, or device name) is unlinked without being opened, so it
cannot pin a disposable generation. Leaf names and completed directories are removed in
native batches (`rm`/`unlink`, then an identity-checked `rmdir` per batch) and directory
identities are captured in argv-bounded native `stat` batches, so a file-heavy,
directory-heavy, or long-path generation keeps pace with the budget instead of paying one
process per descendant or exceeding the platform argument limit; any identity-query
failure aborts that pass with a truthful warning instead of walking on with missing
data, and when the bulk tool is unavailable the same walk falls back to one no-follow
`unlink` per name. A direct-child entry named `.terraform` under the
producer-owned cache is ordinary disposable content, not an exemption.
`.terraform` content inside a selected disposable generation is cleanup-specific and is
removed with it (ordinary source discovery still prunes it before traversal). Partial
removal leaves the entry counted for a later retry. These are public path-API fences, not an atomic sandbox
against a malicious same-user writer. No real user cache is used by the focused tests.

Every in-flight generation carries one `.producer-active` marker, and the per-cache
`.admission.lock` names its owner the same way: `<pid>` plus the owner's targeted birth
identity, written already complete. A marker or lock that names an identity is honored
only while that exact identity still holds, so an abandoned record whose pid was reused by
an unrelated process is reclaimed instead of pinning a generation. A record written by an
older producer is pid-only and remains readable: it is honored while the live pid's OS
birth is *not* clearly after the record's own mtime (an earlier birth is legitimate
in-flight work, a later birth means the number was reused). Missing or malformed metadata
is never protection, and no real in-flight producer is deleted by cleanup.

Active sessions are protected by the session host's existing exclusive
agent-directory ownership record ([Recovery](recovery.md) and
[Session host](session-host-alpha.md)), not by cache receipts: cleanup never
implements a second lifetime gate and never stops a launch for capacity reasons. The
source-build/Pi producer keeps its package/version validation, supported installed-Pi
preference, and checksum-pinned fresh Node extraction semantics unchanged.

The fallback Node wrappers reclaim excess direct-child artifacts under
`.pi-review-gate/node/` before creating another one, using the same best-effort rules and
the same per-agent coordination entry, ownership rechecks, and destructive-boundary stop.
Neither wrapper exempts a direct child named `.terraform`.
The supported PATH-Node fast route is unchanged, and no mutable extracted Node is
reused. POSIX uses `scripts/node-generations.sh`; native PowerShell uses an
in-memory Reflection.Emit handle identity plus the same bounded no-follow deletion, live
`.producer-active` skips, and stale-lock recovery; every lock/inventory/removal failure is
caught as a bounded warning before the fresh generation is created. Both natives share
the CJS semantics: one runtime budget for the whole pass, deletion as progress, owner
records carrying a pid plus birth identity, and the same birth/mtime rule for a legacy
pid-only marker or lock. Windows
cleanup is native path deletion with reparse points unlinked rather than entered; it
does not claim descendant-settlement proof beyond that.
`tests/session-host-entrypoints.test.ts` includes native Windows tests selected by the
Windows launcher CI job; POSIX mocks/source assertions are not Windows runtime
evidence. For a manual native proof, use a new disposable `PI_CODING_AGENT_DIR` and a
PATH without supported Node, launch the PowerShell wrapper more than five times with
`--help`, and verify every launch proceeds while older bootstrap directories are
actually reclaimed.

## Protocol and compatibility notes

- Pi is independently installed and upgradeable; this project consumes its public
  extension and CLI/RPC surfaces rather than patching or bundling Pi.
- The `run-as-binary` executor protocol (`pi-review-executor-jsonl-v1`) is documented in
  [Delegated execution](delegated-execution.md#external-harness-protocol).
- Pre-cutover configuration fields (`decider`, `reviewers`, `enabledReviewerIds`,
  `execution.activeExecutor`, `execution.executorPool`, `execution.externalExecutors`)
  are no longer accepted: strict validation (explicit configuration writes and
  `/review-settings` Save) rejects an old-only record with an actionable diagnostic,
  while startup recovery warns about and omits the unsupported fields — never
  converting them into reviewer or worker selections — and doubled records consume the
  canonical shape alone without rewriting the stored record
  ([Configuration](configuration.md#pre-cutover-configuration-fields)).
- The legacy array forms of `externalAgents` and `execution.workerResources` are no
  longer imported: strict validation rejects them, while startup recovery reports the
  unsupported catalog and continues without converting it or rewriting the stored
  file. Migration goes through a published conversion-capable release and an explicit
  Save there ([Configuration](configuration.md#removed-legacy-array-catalogs)).

## Shared native presentation expansion

Expansion is presentation-only and Pi-native: the host toggles each row's expanded state
through its configured expansion binding (`app.tools.expand`, ctrl+o by default) and
passes that state to the registered renderer — `{ expanded, isPartial }` for tool rows,
`{ expanded, outputPad }` for the extension's own notification messages. The extension
registers no competing key handler; tool rows retain that host-owned state without
mirroring it, while notification rows keep only the local per-click state that is
reconciled to the host's global expansion flag. Expansion never
reruns a tool, performs a network request, polls, or reads logs, artifacts, or history —
it renders only data that was already returned.

One shared core backs every expandable extension row, tool-result and automatic
notification alike (issue #92):

- `src/presentation-expansion.ts` owns the cross-cutting expansion logic for all
  presentation rows: renderer selection (collapsed unless `options.expanded === true`; a
  contributed detail renderer is used only when one exists), the visible failure notice
  when a detail view fails to render, forwarding of host-owned `options` fields unchanged,
  handler forwarding, and a wiring-audit marker. It is never tool-specific — it receives
  an opaque result value, the host's options, the theme, and render context, and a
  consumer whose host contract guarantees extra fields supplies its own fallback options
  (tool rows keep `{ expanded: false, isPartial: false }`, message rows their own shape).
- `src/presentation-hints.ts` owns the native configured hints and width safety for every
  renderer with a contributed expanded view (see below).
- Tool rows consume the core through the thin backwards-compatible adapter
  `src/tool-result-expansion.ts`; `src/tool-result-hints.ts` re-exports the shared hint
  functions unchanged, so existing tool registrations, tests, and imports keep their
  names while the logic lives in one non-tool-specific module. Tool content, host-owned
  state, global keyboard behavior, fullscreen per-card click behavior, provenance, and
  native image presentation are unchanged by the extraction.
- Automatic notification messages consume the same core through their own registered
  message renderers, so tool-result and notification presentation stay in lockstep:
  [Automatic notification compaction](#automatic-notification-compaction-92).

Every extension-owned registration with a custom result renderer is covered by this
mechanism, consumed via `src/tool-result-expansion.ts` — 40 of the 42 tools registered
in the top-level runtime (24 web/browser, `ApplyPatch`, `GitRead`, 5 background-shell,
`tool_search`, `AskUserQuestion`, and 9 subtask tools). `GitRead` and
`AskUserQuestion` deliberately register no custom renderer; their results are
self-describing text rendered through Pi's default text display:

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
- Centralized native hints (`src/presentation-hints.ts`, re-exported unchanged by the
  `src/tool-result-hints.ts` adapter): the shared wrapper appends
  exactly one native-style `(ctrl+o to expand)` / `(ctrl+o to collapse)` hint to the
  header of every tool with a contributed expanded renderer; family renderers emit no
  expansion hints of their own. The key is never hard-coded: it is resolved at render
  time from the host's configured `app.tools.expand` binding, lowercase to match the
  native tool-row hint casing. The hint is width-safe — it rides on the header when the
  line still fits and otherwise moves to its own wrapped row(s) below the card (oversized
  tokens hard-wrap) without truncating or dropping any family line, so the affordance
  stays visible at every width.
- Peer loading happens entirely at session setup, never at render time (`src/host-peer-loader.ts`,
  the established shared loader): soft `require` first (the loader's package
  alias path), then resolution inside the running Pi install for a compiled
  extension entry, which pi ≥ 0.86 loads by native import and whose `require()`
  calls cannot resolve host packages by bare name (`src/index.ts` starts it at
  activation and completes it during interactive `session_start`, before pi
  renders the initial transcript). When the separately evaluated pi-tui record
  has no configured app-level keybindings yet, the shared hints core installs
  the host package's own manager through its `KeybindingsManager.create()`
  static factory (built-in defaults plus the user's `keybindings.json`
  overrides, the same file the running mode reads) on that record so a remapped
  binding resolves exactly as the host renders it; a configured initialization
  that fails installs nothing (no misleading defaults), the running session's
  own manager is never touched, and a genuinely unavailable peer degrades to
  the documented native full presentation instead of guessing.
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
  unchanged collapsed card. When a captured sent prompt contains the submitted
  instructions verbatim, the expanded Start/Add view shows that overlapping block once:
  the repeated span inside the rendered prompt is replaced by a rendering-only marker
  that names the already-shown submitted text and states it is an abbreviation, not
  prompt content, while worker-specific framing around the span still renders exactly;
  a prompt that differs from the submitted instructions (path-rewritten or transformed)
  renders in full, and unavailable captures keep their truthful not-recorded state.
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
- The twenty-one interactive `Browser*` tools from `BrowserOpen` through `BrowserClose`
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
- `tool_search` (`src/deferred-tools.ts`, `src/deferred-tools-result-renderer.ts`)
  contributes collapsed and expanded views showing the actual query, matched and
  newly activated tools, and the real activation outcome, preserving the no-match,
  unavailable, invalid-query, and already-active distinctions from the operation
  record.

`isExpandableResult()` (tool rows) and `isExpandablePresentation()` (the shared core,
set on every callback it produces) provide wiring-audit markers used by
`tests/tool-result-expansion.test.ts` and
`tests/browser-render-registration.test.ts` to prove that every expandable
registration routes through the shared helper, that expand and re-collapse render
through it, that the interactive browser family shares one wrapper instance, and that
expanded views carry the actual recorded inputs (including content beyond the legacy
preview caps and synthetic secret-shaped model-visible input shown unfiltered). The
registered browser tests render through the real registrations — including image
handling, errors, partial and empty results, long output bounds, and the redaction
boundaries — rather than only the module callbacks. The shared inventory also exercises
registered web, discovery, shell, subtask, and patch tools through expansion and
re-collapse with their real renderers.

### Automatic notification compaction (#92)

The same shared core delivers a compact, expandable presentation for the extension's
own automatic notification messages, registered through Pi's public custom
message-renderer API. Exactly five notification families render compactly:

- `pi-review-subtask-event` — the task title, the actual outcome (reported, landed,
  failed, conflicted, or recovery-required), available aggregate progress, and a
  separate full, usable report-reference line whenever a report exists; immediate
  actionable failure, conflict, and recovery details also stay visible collapsed. An
  in-place execution's settlement is shown through its own event state and is never
  presented as a Git landing.
- `pi-review-bg-shell` — job identity or label, the wake reason, the exit status where
  reported, and immediate actionable failure or match information.
- `pi-review-subtask-watch` — execution-level active-work summaries, explicitly framed
  as a checkpoint rather than a completion or failure claim.
- `pi-review-scheduled-task-event` — the schedule identity and due occurrence, the
  truthful skipped / not-run / failed / uncertain outcome and the immediate action,
  including retry or duplicate warnings where present.
- `pi-review-scheduled-orchestrator-turn` — the scheduled entry and due occurrence only:
  the collapsed view never claims execution started or completed; the turn's full
  instructions and metadata are one expansion away.

The existing short subtask launch admission and background-ready notices are unchanged,
and hidden messages and native host-owned messages are not touched.

Boundaries shared by all five families:

- Expanding a notification displays all of its current notification text and nothing
  beyond it: no fetch of the linked report, log, or artifacts, no polling, execution,
  or other I/O, and no change to the model-visible payload, upstream privacy or
  retention behavior, delivery lanes, lifecycle tracking, wake policy, or scheduler
  behavior. This is compaction of the delivered text, not replacement of it.
- Unknown historical or malformed notification formats fall back to the full retained
  text rather than a potentially misleading summary, and when the host's renderer APIs
  are absent the native full presentation applies instead of a degraded guess. A
  row that falls back to its complete retained text is explicitly marked as such, so
  it carries NO expand/collapse hint in either state — the hint would advertise a
  change expansion cannot make — while a genuinely compact row keeps its hint. The
  signal is explicit renderer state, never a comparison of rendered lines, so width,
  theme, or partial rendering cannot disable a real row's expansion. Tool-result rows
  do not participate in this fallback signaling and are rendered unchanged.
- A failure/recovery notification compacts from its curated diagnostic whether the
  diagnostic arrived as structured message details or only inside the retained
  notification text. The text-only path recognizes only the producer's own preamble
  and literal diagnostic-boundary line, validates the embedded JSON structurally, and
  requires its task/execution/kind/state/revision/progress identities and its
  notice/summary/error text to agree with the preamble — so unrelated, inlined, or
  truncated JSON can never be compacted into a misleading recovery summary. Valid
  structured details remain authoritative; nonempty but unusable structured metadata
  is never replaced by a text-derived diagnostic, and a diagnostic recovered from
  text is rejected when it contradicts a supplied taskId, executionId, or state.
  Genuinely unknown, malformed, invalid, or identity-inconsistent content keeps the
  full retained text.
- Each notification renders in the host's own native custom-message card in both
  states: the pi-tui `Box(1, 1, (t) => theme.bg("customMessageBg", t))` boundary the
  default `CustomMessageComponent` uses — one-cell horizontal/vertical padding, every
  row (including wrapped hints and the blank padding rows) filled to the terminal
  width — with the plain body text and family labels following the native
  `customMessageText`/`customMessageLabel` fg tokens (outcome colors preserved). Every
  color resolves through the theme at render time — never snapshotted or hard-coded —
  so the card follows the active theme, including nondefault/custom themes and theme
  changes, exactly like the native card. Width safety holds at every width: below the
  three cells the native padding needs, a width-aware narrow path renders with zero
  horizontal padding and clips every row to the exact cell width (the host's own
  ANSI-aware `truncateToWidth`), so no row — including retained wide-glyph content,
  in compact, expanded, or full-text-fallback states — ever exceeds the requested
  width. Clicking any card content or padding location
  still toggles only that item, and tool-result card backgrounds are untouched.
- The host peer modules the renderers read (pi-tui helpers and the native key-hint
  helpers) are resolved through the established shared host-relative loader during
  session setup — before anything renders, with no loading at render time. A compiled
  extension entry cannot resolve host packages by bare `require` name (pi ≥ 0.86
  loads pre-compiled CommonJS by native import), which previously left every
  notification family on the native full-text fallback in real compiled launches; the
  compiled-launch regression (`tests/message-expansion-compiled-launch.test.ts`) now
  pins the actual behavior through pi's public `--extension` seam on a real PTY:
  compact rows with the live configured hint — including a remapped
  `keybindings.json` expansion binding driven by its real keystroke, and a
  configured-empty binding that renders no hint — global expand/contract of the
  complete retained text, and independent fullscreen clicks.
- Keyboard expansion is the same native-configured `app.tools.expand` binding the
  tool rows use, toggling all expandable rows together. In fullscreen mode, clicking
  one notification operates that item
  only, through the public pi-tui `MouseRegion` surface, with each message's local
  expansion state reconciled to the host's global expansion flag. Regular mode remains
  keyboard-only. The extension performs no host patching and registers no competing
  keyboard binding.

Consumer-facing notes for the affected families live in the product
guides: [Delegated execution → Notifications and UI](delegated-execution.md#notifications-and-ui)
and [Scheduled tasks](scheduled-tasks.md#schedule-destinations).

## Model-stream failure reporting (#84)

When an assistant (model) message ends with `stopReason` `"error"` or `"aborted"`,
the host assigns a synthetic error result to every still-pending tool card and never
dispatches those tool calls. The extension reports this honestly through one shared
bridge (`src/stream-failure-report.ts`), consumed by both tool families
(Subtasks* and Shell*) in collapsed and expanded states:

- Capture is bounded and in-memory only (no durable sidecar): the public
  `message_end` event retains allowlisted diagnostics per `toolCallId` (diagnostic
  type, bounded error name/code/message, `phase`, configured/recorded transport,
  `eventsEmitted`, `requestBytes`, provider/model/api), with credential tokens,
  URLs, and private paths redacted and every field length-bounded. Raw provider
  payloads, headers, and stack traces are never retained. The displayed and
  copied host error summary passes through the same redaction/bounding contract
  before it is shown, so the card never carries the raw provider text. Records
  are rebuilt from the session's active branch
  on `session_start` (new/resume/fork) and `session_tree` (branch navigation,
  which does not fire `session_start`) and cleared on `session_shutdown`.
- "Not dispatched" is asserted only when the correlated errored assistant tool call
  is retained AND the host render context explicitly reports
  `executionStarted === false`. Anything else renders an honest unknown status —
  never a fabricated execution result. A real dispatch (`tool_execution_start`)
  deletes the record, and an actual toolResult in the session supersedes the stale
  errored assistant message, so real execution always wins over stream-failure
  uncertainty.
- An aborted stream is reported as a cancellation, never a provider failure. A
  recorded fallback transport is described as recorded only — never as a completed
  switch, a performed retry, or a transient/retryable classification. Actual tool
  errors after a real dispatch keep the existing error rendering unchanged.
- The model receives one concise sanitized note per unresolved failed attempt
  through the public `context` event
  (`transformContext`) when the failure details would otherwise be invisible to the
  provider payload (the host removes the failed assistant message from agent state
  on auto-retry). The note is a plain user-role message — no tool-result message is
  ever fabricated — it marks quoted diagnostics as untrusted data, states the
  evidenced execution status (not dispatched, or unknown when evidence is missing),
  and changes no retry/transport behavior. At most one note is appended per request
  (never accumulated); an actual toolResult in the built context supersedes the
  uncertain record entirely; a note is re-injected on later context builds only
  until the successful response that followed its delivery consumes it
  (`message_end` fires for every assistant message before `agent_end`), and a
  request that consumed nothing from re-arms it; pending notes are never consumed
  by an unrelated or earlier-turn success. Records excluded by the note's attempt
  and character bounds stay pending and are described by a later build, or
  described minimally when even one full section exceeds the note's character
  bound (with every unresolved call still either described or counted by the
  note's omission marker). The note
  is contextual only — it is never persisted, never claimed durable, and never
  injected for restored history.
- Limitations: only providers whose pi-ai adapters emit assistant-message
  diagnostics (for example the Codex websocket transport's
  `provider_transport_failure`) produce transport detail; other failures report the
  host error text with an explicit "cause not retained" disclosure. Model-visible
  notes cover only failures captured live in the current session — restored history
  and compacted-away attempts are not re-noted.

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
  copied. Only the headerless update application is retained from the upstream engine:
  create-file mode was removed with the legacy structured `operation` argument because
  canonical `*** Add File:` hunks carry their final content directly.
- The saved-session search parser, matcher, and relevance ordering are adapted from
  Pi Coding Agent v1.1.0 under the MIT License. See [NOTICE](../NOTICE) and
  [LICENSES/MIT-pi-session-search.txt](../LICENSES/MIT-pi-session-search.txt). The
  fuzzy matcher is imported from the pinned `pi-session-host-tui` dependency and is not
  copied.
