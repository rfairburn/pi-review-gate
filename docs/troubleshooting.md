# Troubleshooting

Symptom-to-fix entries for common problems. Each entry links to the page that owns the
underlying behavior.

## Setup and launch

- **The gate does not activate.**
  - `PI_REVIEW_GATE_DISABLED=1` (or `true`/`yes`) disables the whole extension,
    including delegated execution. The launcher warns loudly when it is set.
  - No config file was found. For the launcher, create one of its two persistent paths
    (`~/.config/pi-review-gate/config.json` first, then `~/.config/pi/review-gate.json`) —
    it deliberately ignores an exported `PI_REVIEW_GATE_CONFIG`. For direct `pi -e`
    loading, set `PI_REVIEW_GATE_CONFIG` instead. See
    [Configuration](configuration.md#config-discovery).
  - The config file must be a JSON object; malformed JSON fails with an error.
- **`pi-review-gate.sh: no persistent config found`.** Neither persistent path exists.
  The launcher only reads `~/.config/pi-review-gate/config.json` or
  `~/.config/pi/review-gate.json` and deliberately ignores an exported
  `PI_REVIEW_GATE_CONFIG`; create one of the two files. See
  [Getting started](getting-started.md#launching).
- **`pi-review-gate: packaged extension is missing`.** The launcher could not find
  `dist/src/index.js` and no `src/index.ts` was present to build from. Run
  `npm run build` in the checkout, or reinstall the package.

## Reviews

- **Escape does not cancel a running review.** If terminal input interception cannot be
  installed in the current context, the extension says so once and points at
  `/review-cancel`, the guaranteed hard stop. Modified Escape (shift/alt/ctrl) and
  key-release events are intentionally ignored. See
  [Review workflow](review-workflow.md#cancellation).
- **A reviewer fails with a sandbox startup error.** Codex runs a local no-op sandbox
  preflight; a platform sandbox startup failure is reported as an explicit reviewer
  error, never mislabeled as a verdict-schema failure, and before any model turn is
  spent. Check the harness installation.
- **Reviewer output looks garbled but a verdict still appears.** Strict parsing runs
  first; a narrow fallback recovers the same schema only for actionable non-passing
  results with unescaped multiline Markdown. A passing verdict is never accepted through
  repair. See
  [Review workflow](review-workflow.md#reviewer-execution).
- **The correction cap was reached.** The complete pass is transmitted with correction
  classified as deferred; use `/review-continue` to authorize another correction round.
  See [Review workflow](review-workflow.md#corrections-guidance-and-the-correction-cap).
- **Queued review inputs appear after a restart.** Queued inputs are never reordered
  automatically: use `/review-now` to finish the review and release them, or
  `/review-clear` to cancel them. See [Recovery](recovery.md#session-scoped-restart-recovery).

## Web tools

- **`BrowserExtract` reports a setup action instead of a render.** Chromium was not
  provisioned (possibly because `PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM=1` was set at
  install). Run `npx playwright install chromium` in the package environment and retry;
  if the skip variable was set, unset it before reinstalling. See
  [Getting started](getting-started.md#installation).
- **A fetch fails on a page you expected to work.** Non-2xx navigations, oversized
  rendered HTML, oversized downloads, and any egress-ledger audit failure fail the
  render closed by design; password-protected, corrupt, or oversized PDFs fail
  explicitly. See [Security model](security-model.md#web-egress-hardening) and
  [Web tools](web-tools.md).
- **Images or fonts are missing from an extracted page.** Images, media, and fonts are
  intentionally omitted by the route policy; this never fails the render and bounded
  omission diagnostics are disclosed. See
  [Security model](security-model.md#egress-broker-containment).
- **DDGS provisioning fails during install or launch.** `scripts/ensure-ddgs.sh`
  requires the pinned `ddgs==9.15.0`, binary distributions, and a clean `pip check`; the
  configured PyPI/index source and local pip configuration are part of the trusted setup
  boundary. See [Web tools](web-tools.md#websearch).

## Delegated execution and landing

- **A landing is blocked by a conflict gate.** Resolve the materialized diff3 markers in
  main, then run `SubtasksMarkClean` (or `/subtask-mark-clean`) to verify, checkpoint,
  clear the gate, and wake queued landings. See
  [Delegated execution](delegated-execution.md#conflicts-and-gates).
- **Recovery returned `manual_required`.** Follow the manual recovery steps:
  identify conflicting paths from the manifest, compare destination vs. backup, decide,
  then remove `.pi-backup-*` and remaining `.pi-landing-tmp-*` artifacts. See
  [Recovery](recovery.md#manual-recovery-steps).
- **A task reports `completed_unreviewed`.** Delegated execution ran with no reviewer
  selected. This is a valid configuration (reviewers and routes are independent). See
  [Delegated execution](delegated-execution.md#worker-resources-routes-and-concurrency).
- **The worker cannot see a file your task needs.** Git-ignored files (including
  `node_modules` and `.env`) are excluded from capture and landing. See
  [Delegated execution](delegated-execution.md#capture-and-ignore-policy).
- **A force-merged task looks wrong.** Force merges and `interrupt_with_merge` are
  mechanical landing attempts, not verification; always inspect the main workspace
  manually afterward, even when the authoritative state is `landed`. See
  [Delegated execution](delegated-execution.md#conflicts-and-gates).
- **Background shell tool output is missing.** Jobs are detached process groups that
  survive turn settlement and are reaped when the Pi session ends; use `ShellList` and
  `ShellLog` to inspect them. See
  [Delegated execution](delegated-execution.md#background-shell-tools).

## Development and tests

- **Resource-sensitive or ordering-sensitive test failures.** Use the full serial
  fallback `npm run test:serial` instead of the concurrent run. See
  [Development](development.md#build-and-test-commands).
- **Package smoke fails on a missing file.** `npm run test:package` asserts that
  required files — including the public `docs/` tree — are packed. Check the `files`
  list in `package.json`. See [Development](development.md#static-checks-and-docs-validation).
- **Docs validation reports a broken link or anchor.** `node scripts/check-docs.cjs`
  validates relative links, local anchors, reachability, referenced paths, and fenced
  JSON in `README.md` and `docs/`. Fix the target or the link; anchors use GitHub-style
  heading slugs.