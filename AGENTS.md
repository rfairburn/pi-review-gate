# Agent guide

Concise orientation for agents working in this repository. The human-facing policy
lives in [CONTRIBUTING.md](CONTRIBUTING.md); product safety semantics live in the
public docs.

## Repository structure

- `src/` — extension source (review gate, delegated execution, web tools, apply-patch
  engine).
- `tests/` — Node test suite compiled to `dist-test/`.
- `scripts/` — launcher, provisioning, docs validation (`check-docs.cjs`), package
  smoke, fake reviewer.
- `docs/` — public documentation tree (shipped in the npm package).
- `skills/pi-review-gate-orchestrator/`, `skills/pi-review-gate-execution/`, `skills/pi-review-gate-research/` — the shipped skills (issue 151 namespacing)
  refreshed by the launcher (orchestration with its recovery runbook, direct/delegated
  execution, and read-only research; product surface, not a private configuration).
- `.github/` — issue/PR templates, CODEOWNERS, and external review guidance
  (source-only governance; not shipped in the npm package).
- Root policy docs: [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
  [CHANGELOG.md](CHANGELOG.md).

## Working agreements

- Issue-first: every change lands with a linked issue. `Closes #N` only for evidenced
  full resolution; `Refs #N` for partial or related work with the remaining scope
  stated. Branches are `issue-N/short-slug`; focused commits; GitHub PR merges are
  squash-only. Full policy: [CONTRIBUTING.md](CONTRIBUTING.md).
- Verification compliance is mandatory, not background reading: follow
  [CONTRIBUTING.md — Verification before opening a PR](CONTRIBUTING.md#verification-before-opening-a-pr).
  Run and cite the checks that actually cover the change (`npm run check:static`,
  targeted compiled tests, `npm run test:package` when package layout, shipped docs, or
  scripts change); a phase touching process, Git, or filesystem behavior requires the
  full suite. Command/tier reference: [docs/development.md](docs/development.md).
- Coordinated verification: in orchestrated work, workers normally run focused checks
  for their bounded changes; the orchestrator or designated integration owner runs the
  required phase-level full suite once changes integrate (`npm run build:test` then
  `npm run test:run` — never `npm test`, which rebuilds the live `dist/`), and repeats
  broad validation only when later changes invalidate its coverage or the existing
  contribution policy requires it. Do not multiply equivalent full-suite runs across
  workers or reviewers; never present a review pass as a test result or imply that an
  unrun check passed.
- Preserve the working tree: leave unrelated and untracked files untouched; never modify
  or delete a live `dist/` in the primary checkout — build into scratch or staging trees
  instead.

## Safety invariants (fail closed)

Cancellation, durability, and security semantics are fail-closed by design (see
[docs/security-model.md](docs/security-model.md) and [docs/recovery.md](docs/recovery.md)).
Do not weaken a fail-closed default, bypass a review gate, or hide reviewer information
to make a check pass.

## Privacy

Tracked files must not reference private planning notes, private repositories or boards,
or private skill or home locations. Docs validation and the governance test enforce this
for the public surface; see [docs/development.md](docs/development.md#static-checks-and-docs-validation).
