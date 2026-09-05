# Pull request

## Linked issue (required)

Every PR must accompany or link an issue to be considered; PRs without one are not
reviewed or merged. State the relationship with accurate semantics:

- `Closes #N` — fully resolves issue N. Provide evidence of the full resolution below.
- `Refs #N` — partially addresses or is related to issue N. State the remaining scope
  explicitly so the issue can stay open honestly.

Tick the form that applies (replace N with the issue number):

- [ ] `Closes #N`
- [ ] `Refs #N` — remaining scope:

## Description

What changes and why, in a few sentences.

## Evidence and testing

Truthful tests only — cite the commands actually run and what they demonstrate (for
example `npm run check:static`, targeted compiled test runs, `npm run build:test`
plus `npm run test:run`, `npm run test:package`). Never paste fabricated or
placeholder results.

## Documentation

- [ ] Public docs updated where behavior changed (`README.md`, `docs/`), or state why no
  doc change is needed.

## Changelog

- [ ] Entry added under `## [Unreleased]` in CHANGELOG.md, or state why no entry is
  needed.

## Compatibility

State any compatibility impact — config shapes and legacy migration, launcher/skill
refresh, Pi extension surface, shipped package layout. "None" is a valid answer; say it
explicitly.

## Workflow attestation

- [ ] Branch named `issue-N/short-slug` for the linked issue.
- [ ] Focused commits; ready for the repository's squash-only merge.
- [ ] Main-branch safety protections, independent review, and required CI are
  satisfied. Any formal-approval exemption is limited to an eligible
  maintainer-authored, same-repository PR under the documented review policy.
