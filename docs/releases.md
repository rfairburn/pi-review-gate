# Releases

This page describes the automated numbered prerelease builder: what it publishes, the
trust boundaries it enforces, and how to recover when it fails. The builder is a single
reusable workflow ([`.github/workflows/release.yml`](https://github.com/rfairburn/pi-review-gate/blob/main/.github/workflows/release.yml),
`workflow_call`) invoked by CI on
pushes to `main`; it does not run on demand and there is no floating-dispatch publish path.

## Naming scheme

- **Number `N`** is the pure first-parent distance from the immutable baseline commit
  `f7c174f1c12c81447bce2ab1aa39fb5faf4331ec` to the released commit. It is a function of
  repository history only: later main advances never change the number of an existing
  commit. Gaps can exist in recorded history (for example from earlier direct pushes to
  `main`); under the current squash-only pull request merge policy, future merges land
  as single squash commits, so the numbering stays consecutive going forward.
- **Tag** `b<N>` identifies the exact commit (for example `b1` after the baseline).
- **Package version** `0.1.0-dev.<N>` is written only into the staged package metadata;
  no version bump is ever committed and the live `dist` is never touched.

## Eligibility

A push to `main` is releasable only when all of the following hold; anything else fails
closed before any write:

- The original event is a `push` to `refs/heads/main` on `rfairburn/pi-review-gate`.
  Reusable workflow runs inherit the caller's original event context, and both the
  workflow-level conditions and the scripts re-validate the environment, so
  `workflow_dispatch`, forks, and other refs are refused. CI additionally invokes the
  builder only after both required check jobs (`verify` and `full-tests`) succeeded:
  GitHub's implicit `success()` guard on `needs` skips publication when either check
  failed or was skipped. There is no `workflow_run`
  privilege chain, no custom PAT, and no GitHub App; the only write permission anywhere
  is `contents: write` on the single publish job.
- The target SHA is the exact `merge_commit_sha` of a merged pull request against
  `main` of this repository. The commit-to-pull-request association endpoint returns
  simplified items without the detailed merge flag, so every associated candidate is
  confirmed against its detailed pull request record before it counts; direct pushes,
  open or unmerged pull requests, foreign base branches/repositories, and commits whose
  merge commit differs from the target are all rejected. Pull request text is never
  echoed into logs or shells.
- The baseline lies on the target's first-parent line, `N` is positive, and the target
  itself lies on current `main`'s strict first-parent history. The publish job fetches
  the current `main` tip read-only (a remote-tracking ref; nothing is checked out) before
  eligibility runs, so a commit that was once merged but later removed from `main` by a
  history rewrite is rejected even on an original-run retry.
- The checked-out `HEAD` equals the event SHA; `main` is never checked out at a floating
  ref, and later main advances cannot change the commit being published.

## Publication model

Each exact target SHA has its own publication group (`release-publish-<sha>`) with
`cancel-in-progress: false`. Distinct main commits therefore use distinct groups and
never drop or replace one another's builds. Within one group, GitHub's default pending
policy applies: a publication that has already started is never auto-cancelled, while a
newly queued retry of the same SHA replaces a still-pending (not yet started) run of
that same SHA, so redundant same-SHA retries coalesce instead of stacking. The publish
job then:

1. Creates the tag `b<N>` first, verifying it points at the exact target SHA. A tag that
   already exists pointing anywhere else is never retargeted; the run fails closed.
2. Creates a **draft** release carrying an ownership marker that pins the source
   repository, SHA, tag, and version. Because the by-tag release endpoint only returns
   published releases, an interrupted draft is located through the authenticated release
   listing (bounded pagination) instead; duplicate-creation races re-read identity from
   that same source rather than blindly retrying.
3. Builds everything inside a scratch staging tree derived from the exact validated
   source: production TypeScript output is compiled into the staging tree, the package
   and lockfile get the dev version, and `npm pack --ignore-scripts` produces the
   tarball. The tarball is extracted and checked against an allowlist derived from
   `package.json` `files`, with secret-shaped file names and private-key content
   rejected.
4. Uploads the three assets — the tarball, `SHA256SUMS`, and a bounded deterministic
   `provenance.json` (schema, package version, source repository/SHA/baseline/distance/
   pull request, and the tarball digest; no run timestamps) — verifying each uploaded
   asset's bytes by downloading it again and comparing SHA-256 digests.
5. Publishes the draft with `draft: false`, `prerelease: true`, `make_latest: "false"`,
   and re-verifies the published release. No npm publish step exists and no milestone
   tags are created.

An incomplete run resumes: a draft carrying the matching ownership marker may be
completed by uploading only its missing assets, and mismatched assets of such a verified
owned temporary draft are replaced narrowly. A draft that does not carry the marker is
never touched.

Published releases are immutable: retries verify the published assets against the
published `provenance.json` and `SHA256SUMS` (the tarball bytes themselves are only
re-built for a draft, because tar packing is not byte-reproducible across runs) and
otherwise do nothing. Any mismatch fails closed; nothing is replaced or clobbered.

## Costs and limits

- Runs on standard public runners alongside the normal CI verification; a full
  publication costs one verify job plus one build/publish job.
- The `GITHUB_TOKEN` cannot obtain the `workflows` permission. Per the
  [GitHub REST releases API](https://docs.github.com/en/rest/releases/releases), a target
  that modifies workflow files relative to the current default branch can therefore be
  blocked from tag or release creation. Publishing at current `main` works normally; a
  historical target whose later main commits changed `.github/workflows/` may need
  operator recovery (creating the tag and assets for the same exact SHA manually). The
  builder never invents permissions, publishes a wrong SHA, or falls back to broader
  credentials.

## Manual recovery

Recovery is always a re-run of the original CI run that performed the push: the reusable
workflow inherits the original event, so the target SHA stays exact. Never dispatch a
floating workflow to "publish whatever main is now" — that path does not exist by design.
If a draft remains incomplete, a re-run of the same SHA resumes it after identity
validation; if the failure was a fail-closed identity, integrity, or permission error,
resolve the underlying condition (or recover manually at the same exact SHA) and re-run.
