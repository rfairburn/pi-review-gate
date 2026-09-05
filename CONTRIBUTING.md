# Contributing to pi-review-gate

`pi-review-gate` is a pre-1.0 project under active development. Contributions are
welcome and follow a small, explicit workflow so that every change has context,
evidence, and a review before it lands.

## Issue-first workflow

- **Every pull request must accompany or link an issue to be considered.** PRs without
  a linked issue are not reviewed or merged.
- New features and material work are **issue-first**: file the issue (feature or bug
  form), let it be scoped, then implement against it.
- Closing semantics must be accurate:
  - `Closes #N` — this PR fully resolves issue N. The PR description must evidence the
    full resolution (what was checked and how).
  - `Refs #N` — this PR partially addresses or is related to issue N. State the
    remaining scope explicitly so the issue can stay open honestly.

## Branches, commits, and merges

- Branch convention: `issue-N/short-slug`, where N is the linked issue number.
- Focused commits: one logical change per commit with a truthful message.
- **Squash-only merges:** GitHub pull requests are squash-merged only — squash is the
  repository's sole enabled PR merge method, with no exception. This governs how PRs
  land on GitHub; it does not rewrite local commits or ordinary git operations.
- Merges are maintainer-authorized: each squash merge happens only after the required
  review and checks pass, and the merged branch is deleted on merge.
- No force-pushes to an open PR and no review bypasses of any kind.

## Verification before opening a PR

Run the checks that actually cover your change and cite them in the PR description —
truthful tests only, never fabricated or placeholder results:

- `npm run check:static` — type check, shell lint, docs link/anchor/JSON/privacy
  validation.
- Targeted compiled tests for the areas you touched (tiers and commands in
  [docs/development.md](docs/development.md)).
- Before finalizing a phase that touches processes, Git, or filesystem behavior, run
  the full suite without touching the live build: `npm run build:test` followed by
  `npm run test:run`. Do not run `npm test` in a working checkout — it rebuilds the
  live `dist/`; reserve it for CI or an explicitly owned isolated build.
- `npm run test:package` when package layout, shipped docs, or scripts change.

## Documentation and changelog

- Public behavior changes update the public docs (`README.md`, `docs/`).
- Notable changes get an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- The pull request template requires explicit documentation, changelog, and
  compatibility declarations.

## Releases

Public summary of the release policy:

- Each validated PR merge publishes a GitHub **prerelease** named `b<number>` — never a
  draft and never marked latest or stable.
- Each prerelease carries a unique package version `0.1.0-dev.N`, the tarball checksum,
  and the commit SHA it was built from.
- A curated normal `v0.1.0` release may be cut later at maintainer discretion. No npm
  publishing is configured or authorized today; a future npm publication would require
  explicit setup against a trusted registry and a corresponding docs update.
- Until then, [CHANGELOG.md](CHANGELOG.md) summarizes the current feature surface under
  Unreleased rather than listing dated releases that do not exist.

## Security

Security vulnerabilities are reported privately via the route in
[SECURITY.md](SECURITY.md). Never open public issues or pull requests for security
problems, and keep all pasted data sanitized (no tokens, credentials, private paths, or
personal information).

## Review expectations

External reviewers follow the review guidance in the source-only `.github/` directory of
the checkout ([review guidance](https://github.com/rfairburn/pi-review-gate/blob/main/.github/REVIEW_GUIDANCE.md)):
precise evidence per finding, explicit severity, actionable fixes even at low severity,
no fabricated test results, and no arbitrary model or token budgets imposed on the work.
