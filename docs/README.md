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
| [Configuration](configuration.md) | Config discovery, core JSON fields and defaults, operating modes, reviewer catalogs/layers, legacy compatibility, and web settings. |
| [Settings menu](settings.md) | `/review-settings` sections, staged edits, Escape/Cancel/Save/Ctrl+S apply and persistence semantics, reload requirements, and separate live runtime actions. |
| [Scheduled tasks](scheduled-tasks.md) | Schedule catalog, destinations, worker/review overrides, instruction images, local time/DST, and runtime dispatch. |
| [Review workflow](review-workflow.md) | Review windows, evidence bundles, reviewer adapters, corrections, transmission, commands, cancellation. |
| [Delegated execution](delegated-execution.md) | Subtask kinds and tools, worker resources/routes, capture and landing, conflicts, steering, notifications, background shell tools. |
| [Subtask evidence](subtask-evidence.md) | Inspection, bounded indexed reads, review-cycle history, evidence provenance, and retention/redaction limits. |
| [Web tools](web-tools.md) | `WebSearch`, `WebFetch`, `BrowserExtract`, page cache, and the standalone web CLI. |
| [Browser guide](browser.md) | Interactive sessions and tools, semantic observations, browser visibility, ownership and cleanup. |
| [Browser approvals and permissions](browser-permissions.md) | Human interaction approval and opt-in capability permissions, their distinct lifetimes, limits and failure boundaries. |
| [User questions](user-questions.md) | The `AskUserQuestion` tool: async/sync modes, the persistent pending panel above the editor and question list (Ctrl+Alt+Up), answer/decline semantics, session isolation, availability limits. |
| [Security model](security-model.md) | Trust boundaries, egress hardening, read-only enforcement, isolation limits, secrets handling. |
| [Recovery](recovery.md) | Crash recovery for landing manifests, exact-session restart, executor retry and failover. |
| [Development](development.md) | Build and test commands, test tiers, static checks, package smoke, launcher internals. |
| [Troubleshooting](troubleshooting.md) | Symptom-to-fix entries for common setup, review, and recovery problems. |
| [Releases](releases.md) | The automated numbered prerelease builder: version naming, eligibility, publication model, and recovery. |

## Suggested reading paths

- **Evaluate the project:** root [README](../README.md), then
  [Getting started](getting-started.md).
- **Configure reviews day to day:** [Settings menu](settings.md),
  [Configuration](configuration.md) for raw fields, then [Review workflow](review-workflow.md).
- **Run background workers:** [Delegated execution](delegated-execution.md),
  [Subtask evidence](subtask-evidence.md), then [Recovery](recovery.md).
- **Schedule work:** [Scheduled tasks](scheduled-tasks.md) with the
  [Settings menu](settings.md) for staged setup.
- **Research and browse:** [Web tools](web-tools.md), [Browser guide](browser.md),
  then [Browser approvals and permissions](browser-permissions.md) before enabling capabilities.
- **Ask for user decisions:** [User questions](user-questions.md).
- **Assess risk:** [Security model](security-model.md).
- **Extend or verify the codebase:** [Development](development.md).

## Reference material in the repository

- Runnable config examples: [examples/](../examples) (single- and multi-reviewer,
  delegated execution, and a deterministic fake reviewer for testing).
- Attribution and license texts: [NOTICE](../NOTICE), [LICENSE](../LICENSE),
  and [LICENSES/](../LICENSES).
- The shipped skills provisioned with the package:
  [skills/pi-review-gate-orchestrator/SKILL.md](../skills/pi-review-gate-orchestrator/SKILL.md),
  [skills/pi-review-gate-execution/SKILL.md](../skills/pi-review-gate-execution/SKILL.md), and
  [skills/pi-review-gate-research/SKILL.md](../skills/pi-review-gate-research/SKILL.md).

## Governance and contribution

- [CONTRIBUTING](../CONTRIBUTING.md) — issue-first workflow, branch and merge
  conventions, verification expectations, and the public release summary.
- [SECURITY](../SECURITY.md) — private vulnerability reporting route.
- [CHANGELOG](../CHANGELOG.md) — notable changes per build, with the preserved
  pre-adoption aggregate history.
- [Releases](releases.md) — how each validated merge is published as a numbered prerelease,
  and how a failed publication is recovered.
- Issue and pull request templates, code ownership, and external review guidance live in
  the source-only `.github/` directory of the checkout (not shipped in the npm package);
  see the [review guidance](https://github.com/rfairburn/pi-review-gate/blob/main/.github/REVIEW_GUIDANCE.md)
  for reviewer expectations.