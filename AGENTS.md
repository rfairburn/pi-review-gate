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
- `skills/orchestrator/` — the orchestrator skill refreshed by the launcher (product
  surface, not a private configuration).
- `.github/` — issue/PR templates, CODEOWNERS, and external review guidance
  (source-only governance; not shipped in the npm package).
- Root policy docs: [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
  [CHANGELOG.md](CHANGELOG.md).

## Working agreements

- Issue-first: every change lands with a linked issue. `Closes #N` only for evidenced
  full resolution; `Refs #N` for partial or related work with the remaining scope
  stated. Branches are `issue-N/short-slug`; focused commits; GitHub PR merges are
  squash-only. Full policy: [CONTRIBUTING.md](CONTRIBUTING.md).
- Truthful verification: run and cite the checks that actually cover the change
  (`npm run check:static`, targeted compiled tests, `npm run test:package` for package
  layout); never fabricate results. Command details:
  [docs/development.md](docs/development.md).
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
