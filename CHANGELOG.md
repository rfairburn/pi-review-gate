# Changelog

Notable changes to `pi-review-gate` are recorded here, grouped under `## [Unreleased]`
until a curated release is cut. The project is pre-1.0: no dated release exists yet, and
per-merge prereleases (GitHub prereleases with unique `0.1.0-dev.N` package versions)
do not create dated sections on their own — see the release summary in
[CONTRIBUTING.md](CONTRIBUTING.md#releases).

## [Unreleased]

Current feature surface of the repository, summarized:

### Added

- Post-turn review gate: numbered evidence bundles per agent turn, strict reviewer
  output parsing, classified transmission of every result to the implementing model,
  bounded correction cycles with deferred-at-cap semantics, and command-driven reruns,
  pauses, cancellations, and ad hoc reviewer questions.
- Multiple reviewers over one evidence bundle (Codex, Claude, Pi adapters plus generic
  CLI), any-`needs_changes` gating, `pass_with_warnings` for mixed results, and a
  completed pass surviving another reviewer's infrastructure error.
- Delegated execution: bounded background subtask workers in isolated worktrees with
  independent landing, source-mutation lease, conflict gates, bounded retry and
  failover, steering and interruption, and durable landing-manifest crash recovery.
- Native web tools: `WebSearch` (DDGS), `WebFetch` (HTML/PDF), `BrowserExtract`, and a
  bounded Pi-native semantic browser with DNS-rebinding-hardened egress and
  approval-required consequential actions.
- `ApplyPatch` tool: one structured V4A operation per call with workspace confinement,
  atomic staged writes, and serialized mutation windows.
- Background shell tools (`ShellStart`, `ShellList`, `ShellLog`, `ShellSend`,
  `ShellStop`) with detached process groups and lifecycle wakes.
- Durable evidence and recovery: integrity-checked execution manifests, landing-manifest
  crash recovery, and exact-session restart restoration.

### Changed

- Review windows now reconcile to changed reviewer settings instead of blocking:
  a window saved under one reviewer configuration restores on reload with its
  preserved baseline, evidence, and completed history intact and is reviewed with
  the currently configured reviewers, and saving new reviewer settings through
  `/review-settings` reconciles open windows immediately in-session (an in-flight
  review finishes under its original selection; a window frozen with no usable
  reviewers becomes reviewable once its settings are fixed). A label/count-only
  notice reports the reconciliation; manual clearing remains for genuine
  corruption or an explicit operator choice. The persisted selection digest
  also covers unresolvable and duplicated selections, so a change that only
  swaps which configured selection is unavailable is reported on reload.
- Stale or duplicated reviewer selections no longer disable the whole gate:
  every resolvable reviewer still runs, each unresolvable selection produces an
  explicit bounded `reviewer_unavailable` outcome in the review results, and a
  window with zero usable reviewers is deferred (not cleared) until a reviewer
  can run. The documented mixed pass/error policy is unchanged: at least one
  completed `pass` still gates as `pass` (`pass_with_warnings`) alongside other
  reviewer errors, any `needs_changes` still blocks, and zero usable reviews
  still error rather than pass.
- Completed review history snapshots the display label of the configuration that
  actually ran each reviewer, so historical results keep their original reviewer
  identity after the window's configuration is reconciled to newer settings. New
  results additionally carry gate-owned non-secret identity — the adapter name and a
  one-way SHA-256 fingerprint of the effective reviewer configuration — so a same-id
  configuration replacement stays distinguishable after reload; the fingerprint is
  hash-only, not a reconstructable raw configuration snapshot. History entries without
  a saved identity (pre-migration sidecars) render with their raw reviewer id and are
  never relabeled or backfilled from current settings.
