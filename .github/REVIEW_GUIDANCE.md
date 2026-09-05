# External review guidance

Expectations for external reviewers — human or agent — reviewing pull requests in this
repository. Reviews are checked against the linked issue's acceptance criteria and the
public policy in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Finding format

Every finding must include all three parts:

1. **Precise evidence** — the file and line (or exact command output) that demonstrates
   the problem. A finding without locatable evidence is not actionable and will be
   returned.
2. **Severity** — `blocker`, `major`, `minor`, or `nit`, with a one-line justification
   for the rating.
3. **Actionable fix direction** — concrete enough that the author can act on it without
   guessing intent.

Low-severity findings are part of the review, not noise: file them as `nit` or `minor`
rather than dropping them silently. A review with no findings must say so explicitly
after working through the checklist below.

## Reviewer obligations

- Verify before endorsing: run or read the cited evidence. Do not fabricate test results,
  and do not cite commands or outputs that were not actually produced.
- Check the linked issue: missing or mismatched issue linkage — including inaccurate
  `Closes #N` / `Refs #N` semantics — is a blocker.
- Security-relevant changes are checked against the fail-closed semantics in
  [docs/security-model.md](../docs/security-model.md): cancellation, durability, egress
  hardening, and read-only enforcement. Weakening a fail-closed default or hiding
  reviewer information is a blocker.
- Do not impose arbitrary model, token, or reviewer budgets on the work; reviewer
  selection and reasoning effort are product configuration, not review scope.

## Verdicts

- **approve** — no open blockers or majors; nits may remain.
- **request changes** — at least one blocker or major, each with precise evidence.
