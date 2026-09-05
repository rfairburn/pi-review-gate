# pi-review-gate documentation

`pi-review-gate` is an external [pi](https://github.com/badlogic/pi-mono) extension that
reviews code changes after an agent turn and sends the complete classified review pass
back to the implementing model. The project also provides delegated background execution,
native web research tools, durable evidence bundles, and crash recovery.

Start at the root [README](../README.md) for a product overview, prerequisites, and a
minimal setup. Each page below is the single canonical owner of its topic; pages link to
each other instead of duplicating detail.

## Documentation map

| Page | Owns |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, installation, first configuration, launch paths, first review walkthrough. |
| [Configuration](configuration.md) | The complete JSON config reference, defaults, legacy compatibility, and the `/review-settings` UI. |
| [Review workflow](review-workflow.md) | Review windows, evidence bundles, reviewer adapters, corrections, transmission, commands, cancellation. |
| [Delegated execution](delegated-execution.md) | Subtask tools, worker resources and routes, capture and landing, conflicts, steering, background shell tools. |
| [Web tools](web-tools.md) | `WebSearch`, `WebFetch`, `BrowserExtract`, bounded semantic browser sessions, click confirmation policy, cache behavior, and the standalone web CLI. |
| [Security model](security-model.md) | Trust boundaries, egress hardening, read-only enforcement, isolation limits, secrets handling. |
| [Recovery](recovery.md) | Crash recovery for landing manifests, exact-session restart, executor retry and failover. |
| [Development](development.md) | Build and test commands, test tiers, static checks, package smoke, launcher internals. |
| [Troubleshooting](troubleshooting.md) | Symptom-to-fix entries for common setup, review, and recovery problems. |
| [Releases](releases.md) | The automated numbered prerelease builder: version naming, eligibility, publication model, and recovery. |

## Suggested reading paths

- **Evaluate the project:** root [README](../README.md), then
  [Getting started](getting-started.md).
- **Operate reviews day to day:** [Configuration](configuration.md) and
  [Review workflow](review-workflow.md).
- **Run background workers:** [Delegated execution](delegated-execution.md) and
  [Recovery](recovery.md).
- **Assess risk:** [Security model](security-model.md).
- **Extend or verify the codebase:** [Development](development.md).

## Reference material in the repository

- Runnable config examples: [examples/](../examples) (single- and multi-reviewer,
  delegated execution, and a deterministic fake reviewer for testing).
- Attribution and license texts: [NOTICE](../NOTICE), [LICENSE](../LICENSE),
  and [LICENSES/](../LICENSES).
- The persistent orchestrator skill shipped with the package:
  [skills/orchestrator/SKILL.md](../skills/orchestrator/SKILL.md).

## Governance and contribution

- [CONTRIBUTING](../CONTRIBUTING.md) — issue-first workflow, branch and merge
  conventions, verification expectations, and the public release summary.
- [SECURITY](../SECURITY.md) — private vulnerability reporting route.
- [CHANGELOG](../CHANGELOG.md) — notable changes summarized under Unreleased pre-1.0.
- [Releases](releases.md) — how each validated merge is published as a numbered prerelease,
  and how a failed publication is recovered.
- Issue and pull request templates, code ownership, and external review guidance live in
  the source-only `.github/` directory of the checkout (not shipped in the npm package);
  see the [review guidance](https://github.com/rfairburn/pi-review-gate/blob/main/.github/REVIEW_GUIDANCE.md)
  for reviewer expectations.