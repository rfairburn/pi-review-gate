# Releases

This page describes the automated numbered prerelease builder: what it
publishes, the trust boundaries it enforces, and how to recover when it fails.
The builder is a single reusable workflow
([`.github/workflows/release.yml`](https://github.com/rfairburn/pi-review-gate/blob/main/.github/workflows/release.yml),
`workflow_call`) invoked by CI on pushes to `main`; it does not run on demand
and there is no floating-dispatch publish path.

## Naming scheme

- **Number `N`** is the pure first-parent distance from the immutable baseline
  commit `f7c174f1c12c81447bce2ab1aa39fb5faf4331ec` to the released commit. It
  is a function of repository history only: later main advances never change the
  number of an existing commit. Gaps can exist in recorded history (for example
  from earlier direct pushes to `main`); under the current squash-only pull
  request merge policy, future merges land as single squash commits, so the
  numbering stays consecutive going forward.
- **Tag** `b<N>` identifies the exact commit (for example `b1` after the baseline).
- **Package version** `0.1.0-dev.<N>` is written only into the staged package
  metadata; no version bump is ever committed and the live `dist` is never
  touched.
- **Android** uses that same `N` as `versionCode` (bounded to `1..2100000000`),
  `versionName` `0.1.0+N`, and asset `pi-review-gate-bN.apk`. The application ID
  and namespace stay `io.github.rfairburn.pireviewgate`, minimum SDK 33,
  target/compile SDK
  37. CI release tasks require explicit `-PreleaseNumber=N`; missing,
  noncanonical, or out-of-range values fail. Ordinary debug defaults remain `1`
  / `0.1.0`.

## Eligibility

A push to `main` is releasable only when all of the following hold; anything
else fails closed before any write:

- The original event is a `push` to `refs/heads/main` on
  `rfairburn/pi-review-gate`. Reusable workflow runs inherit the caller's
  original event context, and both the workflow-level conditions and the scripts
  re-validate the environment, so `workflow_dispatch`, forks, and other refs are
  refused. CI additionally invokes the builder only after all verification
  dependencies (`verify`, `full-tests`, `windows-launcher`, `windows-shell`, and
  `windows-session-host`) succeeded. The `windows-session-host` dependency is
  CI's read-only reusable call of the native Windows session-host acceptance
  matrix, so the matrix's two Node legs gate publication; that matrix no longer
  triggers on its own `pull_request`/`push` events and therefore runs exactly
  once per CI run, while its targeted `workflow_dispatch` path stays available.
  Its concurrency group uses a fixed prefix with cancellation disabled, so it
  can never cancel the calling CI run or a `main` publication run. The `verify`
  matrix runs the exact per-line Node security floors 22.23.5, 24.22.3, and 26.13.1
  (see [Node.js security floors](getting-started.md#nodejs-security-floors)).
  The full suite and the Windows shell job run on Node 24.22.3, and the Windows
  launcher job runs on Node 22.23.5. Both Windows jobs gate publication, as does
  the full suite. Each required-check name comes from a stable per-major label
  that the matrix pairs explicitly with that line's exact pinned runtime, so
  raising a line's patch or minor floor changes only the pin and keeps every
  required context name — and therefore the ruleset — unchanged, while
  `actions/setup-node` logs the exact version each leg installed. Adding or
  dropping a supported major stays a separate support decision that does rename
  checks. The one-time migration is the exception, because these checks were
  previously named from the pinned versions: the operator must update the
  repository ruleset to require **Verify (Node 22)**, **Verify (Node 24)**,
  **Verify (Node 26)**, **Full suite (Node 24)**, **Windows launcher (Node 22)**,
  **Windows shell (Node 24)**, **Session host alpha matrix / Windows session host
  alpha (Node 22)**, and **Session host alpha matrix / Windows session host alpha
  (Node 24)** in the same window as the merge; nothing in this repository
  changes that live configuration. GitHub's implicit `success()` guard on `needs`
  skips publication when any dependency failed or was skipped. There is no
  `workflow_run` privilege chain, no custom PAT, and no GitHub App; the only
  write permission anywhere is `contents: write` on the single publish job.
  Eight verification legs sit upstream of that guard in total. The dependency is
  enforced by keeping every automatic verification path unconditional (no
  job-level `if:` on the matrix or its caller, no `continue-on-error`, no
  `always()`/`failure()`/`cancelled()` override) rather than by counting
  required contexts: GitHub's required-status-check configuration itself does
  not reject a skipped or neutral conclusion, and the merge gate is exact-head
  while publication is re-validated against the exact merged commit.
- The target SHA is the exact `merge_commit_sha` of a merged pull request
  against `main` of this repository. The commit-to-pull-request association
  endpoint returns simplified items without the detailed merge flag, so every
  associated candidate is confirmed against its detailed pull request record
  before it counts; direct pushes, open or unmerged pull requests, foreign base
  branches/repositories, and commits whose merge commit differs from the target
  are all rejected. Pull request text is never echoed into logs or shells.
- The baseline lies on the target's first-parent line, `N` is positive, and the
  target itself lies on current `main`'s strict first-parent history. The
  publish job fetches the current `main` tip read-only (a remote-tracking ref;
  nothing is checked out) before eligibility runs, so a commit that was once
  merged but later removed from `main` by a history rewrite is rejected even on
  an original-run retry.
- The checked-out `HEAD` equals the event SHA; `main` is never checked out at a
  floating ref, and later main advances cannot change the commit being
  published.

## Publication model

Each exact target SHA has its own publication group (`release-publish-<sha>`)
with `cancel-in-progress: false`. Distinct main commits therefore use distinct
groups and never drop or replace one another's builds. Within one group,
GitHub's default pending policy applies: a publication that has already started
is never auto-cancelled, while a newly queued retry of the same SHA replaces a
still-pending (not yet started) run of that same SHA, so redundant same-SHA
retries coalesce instead of stacking. The publish job then:

1. Creates the lightweight tag `b<N>` first, verifying it points directly at the
   exact target SHA. An existing annotated tag or a tag pointing anywhere else
   fails closed; neither is converted or retargeted (see
   [Annotated tag failures](#annotated-tag-failures)).
2. Creates a **draft** release carrying an ownership marker that pins the source
   repository, SHA, tag, and version. Because the by-tag release endpoint only
   returns published releases, an interrupted draft is located through the
   authenticated release listing (bounded pagination) instead;
   duplicate-creation races re-read identity from that same source rather than
   blindly retrying.
3. Builds everything inside a scratch staging tree derived from the exact validated
   source: production TypeScript output is compiled into the staging tree, the package
   and lockfile get the dev version, and `npm pack --ignore-scripts` produces the
   tarball. The tarball is extracted and checked against an allowlist derived from
   `package.json` `files`, with secret-shaped file names and private-key content
   rejected.
4. Requires six assets: the unchanged Node tarball, `SHA256SUMS`, and
   `provenance.json`, plus `pi-review-gate-bN.apk`, `ANDROID_SHA256SUMS`, and
   `android-provenance.json`. The Android build/sign chain described below
   completes before the publisher starts. Every asset is downloaded and verified
   while still a draft, including APK signature, certificate, application
   identity, SDK versions, digest, and size. The authoritative release-body JSON
   fence remains **only the original Node provenance**; Android metadata is
   separate.
5. Publishes the draft with `draft: false`, `prerelease: true`,
   `make_latest: "false"`, and re-verifies the published release. For
   policy-adopted builds the body also carries that build's collapsed change
   notes derived from the exact source changelog (see
   [Release notes](#release-notes-per-build-changes) below). No npm publish step
   exists and no milestone tags are created.

An incomplete run resumes: a draft carrying the matching ownership marker may be
completed by uploading only its missing assets, and mismatched assets of such a
verified owned temporary draft are replaced narrowly. A draft that does not
carry the marker is never touched.

Published releases are immutable: retries verify the published assets against
the published `provenance.json` and `SHA256SUMS` (the tarball bytes themselves
are only re-built for a draft, because tar packing is not byte-reproducible
across runs) and otherwise do nothing. New producers also verify all three
Android assets and the actual APK signature, never rebuild or re-sign them. For
policy-adopted builds they additionally verify that the published body still
carries exactly the collapsed change notes derived from the exact source
changelog. Any mismatch fails closed; nothing is replaced or clobbered.

## Android build and isolated signing

All six assets publish together after the existing CI/review/eligibility gates. A missing
secret, invalid certificate, build failure, environment failure, or signature failure
blocks the **whole** publication. There is no Node-only fallback, late APK attachment,
per-release manual approval, Play pipeline, auto-updater, or installation step.

A read-only planner validates the exact merged SHA and derives `N` through existing
eligibility. An already-published plan skips both Android build and signing; if that
release disappears, the publisher fails read-only rather than rebuilding. Otherwise:

- A separate read-only job checks out the exact event SHA, runs the full JVM
  core tests and unsigned release build, and inspects package/version/SDK
  identity and absence of signatures/debuggability. Gradle 9.6.1 retains its
  wrapper checksum; AGP 9.3.1, Kotlin 2.4.21, Temurin JDK 21.0.9+10,
  command-line tools 22.0 (checksum-pinned official archive), and SDK Build
  Tools 37.0.0 are pinned. Provisioning names each vendor's exact package
  string: that JDK is requested as `21.0.9+10.0.LTS` (the Temurin selector for
  the same 21.0.9 build 10, recorded in provenance under the canonical
  `21.0.9+10` label), and the platform package is `platforms;android-37.0` for
  the numeric compile/target SDK 37. No signing secret is available.
- Only the unsigned APK and public metadata cross to the protected `android-release`
  environment, by same-run immutable artifact ID and digest, not name or latest success.
  Metadata binds repository, push SHA, run ID/attempt, input digest/size, version, and
  toolchain. The signer repeats push/main/repository and checkout-HEAD checks.
- The signer runs no Gradle, npm, application code, dependencies, or artifact
  scripts. SDK/JDK provisioning finishes before the single secret-bearing helper
  step. The dependency-free helper decodes the user-managed PKCS12 into a
  mode-0700 temporary directory (key mode 0600), aligns first, then signs with
  APK v2 and v3; v4 is disabled for the standalone APK. Passwords enter
  `apksigner` through environment input, not literal arguments. Tool diagnostics
  and secret aliases are not logged. If the sign step fails, its public output
  stays the generic redacted line plus one annotation whose text is a single
  code from a closed fixed allowlist: the failed configuration gate, identity or
  digest binding, verification check, or align/sign/verify stage the helper can
  attribute, and one generic code otherwise. Exception text, tool output,
  arguments, and secret values remain redacted, and the annotation adds no
  check, retry, or fallback — it is an operator pointer, not a claim that every
  tool or credential cause is identifiable. Key material is removed in
  `finally`; ephemeral runners are the cancellation backstop. No key or
  temporary signing directory is cached or uploaded.
- Only the verified APK, Android checksum, and Android provenance leave the
  signer. The publisher checks artifact identity and verifies them again, then
  downloads and verifies **all six** draft assets before publishing. Android
  provenance records the exact source SHA/tag/N, application/version/SDK
  identity, unsigned input digest/size, signed output digest/size, public
  certificate digest, and toolchain versions. It contains no alias, password,
  key material, or private path.

The normal CLI producer (`node scripts/release/publish.cjs`) declares the
`node-and-android/1` contract: Android is mandatory, including published
verification. `--inspect` is a read-only plan, not certification or publication.
The explicit `--verify-legacy-node-only` mode is read-only and requires an
already-published release whose **exact target source** positively declares the
original three-asset producer contract. Unknown/new producers are rejected,
never downgraded by missing APKs or an edited release body. Original-run retries
execute their original immutable producer, so already-published historical
Node-only releases remain valid under their actual old contract; they are not
claimed to contain an APK. Nothing attaches Android retroactively.

For an interrupted draft, re-run **all jobs** of the original push run so the
build and signing metadata share the current run attempt. No per-release
approval is needed once the one-time environment setup below is complete.

### Signing environment and key setup

Complete this setup **before enabling the new producer on main**. Referencing an
absent GitHub environment may create an unprotected one: create and configure
`android-release` in repository Settings → Environments separately from the
release workflow, and restrict its deployment branches to **main only**. Keep it
automatic: do not configure required reviewers or a wait timer. The workflow
does not generate signing keys.

Generate and retain the signing key locally in a private directory **outside the
repository**, not in CI or chat. Disable shell tracing and restrict newly created files
to owner-only permissions before generating the key or its base64 copy. Use the JDK's
interactive password prompts (no password flags or shell history containing passwords):

```sh
set +x
umask 077
keytool -genkeypair -alias release -keystore android-release.p12 -storetype PKCS12 -keyalg RSA -keysize 4096 -validity 10000
keytool -list -v -keystore android-release.p12 -storetype PKCS12
base64 < android-release.p12 > android-release.p12.base64
```

Use the same strong password for the store and entry. Back up the PKCS12 file
and its password in **1Password**. Restore a copy to a separate private
directory and verify it with interactive `keytool -list -v` before relying on
the backup; compare its public SHA-256 certificate fingerprint to the original.
Keep the key, password, base64, and vault contents out of chat, source control,
automation logs, and build artifacts. Base64 is **not encryption**. Delete
disposable plaintext/base64/restore copies after upload and backup verification,
retaining the protected backup and intended private original.

Upload these environment secrets through GitHub's UI:

- `ANDROID_SIGNING_KEYSTORE_BASE64`: the PKCS12 base64 as one line (remove wrapping).
- `ANDROID_SIGNING_PASSWORD`: the shared store/entry password.
- `ANDROID_SIGNING_ALIAS`: `release` for the command above.

The CI caller forwards exactly these three environment-secret names to the
reusable release builder (`jobs.release.secrets` in `ci.yml`); the builder
declares them as required `workflow_call` secrets. No other secrets or inputs
are forwarded, and broad `secrets: inherit` is forbidden. Only the protected
`android-release` signing job exports these credentials, in its signing step.
`required: true` checks that the caller forwarded the names, **not** that their
values are non-empty or valid: the signer's existing value and cryptographic
checks remain necessary. This addresses the documented forwarding gap associated
with build 269's `CONFIG_SECRETS_MISSING` failure; actual credential validity
and signing success still require verification.

Set the public repository Actions variable `ANDROID_SIGNING_CERT_SHA256` to the
certificate's 64 hexadecimal SHA-256 digits; colon-separated fingerprints and
case are normalized by the verifier. This is a **certificate** digest, not the
PKCS12 file digest. Missing/invalid configuration fails closed. No debug key,
new key, global keystore, or client Android Keystore identity is used as a
fallback.

The normal `apksigner verify` run must verify v3; an independent SDK 24–27 run
must verify v2. Each requires exactly one APK certificate record with the pinned
Build Tools 37.0.0 label (`V3.0 Signer:` and `V2 Signer:`, respectively) and the
configured normalized digest. Records are counted before digest validation:
extra, malformed, unknown, rotation and hybrid signer records fail closed. The
separate source stamp identity is not an APK signer and remains ignored. A Build
Tools change requires re-deriving this pinned format; there is no fallback
parser.

Keep this same signing key for normal app updates: with the unchanged application ID,
Android can update the installation without intentionally resetting app data, mTLS
identity, or pins. This pipeline does not implement reset/re-enrollment or claim a
physical-device update-continuity test. A future optional Play setup may import the same
app signing key and use a separate upload key; no Play publication is configured now.

## Release notes (per-build changes)

From the build that adopted per-build changelog attribution onward, every
release body carries that build's human-readable changes in a
collapsed-by-default block:

```html
<details>
<summary>Changes in bN</summary>

...the exact content of the build's changelog section...

</details>
```

- **Source of truth:** the notes are derived deterministically from the
  `## [0.1.0-dev.N]` section of the `CHANGELOG.md` checked out at the exact
  released commit — never from a moving branch, never independently maintained,
  and never duplicated across releases. The staged tarball carries that same
  changelog, so the repository, the shipped package, and the release body agree
  by construction.
- **Candidate policy:** while a pull request is open, its topmost numbered
  section is a candidate for the next build. CI (the verify job, full-history
  checkout) predicts that number as the first-parent distance of the pull
  request's current base from the immutable baseline plus one — the squash merge
  lands exactly one first-parent step above that base. This is a provisional
  prediction: if main advances while the pull request is open, the contributor
  updates the section number against the new base and strict CI re-validates it.
  The publisher then re-checks the exact merged commit's own distance before any
  remote write; a stale, missing, duplicate, or empty candidate fails closed
  instead of publishing a wrong or absent history.
- **Policy-adoption boundary:** whether a build requires notes is derived from
  an immutable source anchor, not from section presence and not from mutable
  "latest release" state: the anchor is the main commit at the moment per-build
  attribution was adopted (pinned in the builder next to the numbering
  baseline). Every strict first-parent descendant of the anchor is a
  policy-adopted build whose publication requires exact notes — including the
  first adopted build itself, which cannot omit its own section and be
  reclassified as legacy. The anchor and its ancestors (the old-format immutable
  releases) verify read-only through the original marker, provenance, and asset
  checks without demanding retroactive mutation; a target whose history neither
  contains nor precedes the anchor fails closed. Removing notes from a
  new-format release therefore cannot masquerade as legacy — retries re-derive
  the expected block from the exact source and fail closed on any omission,
  mismatch, or duplication.
- **Body integrity:** the notes sit between the identity/provenance lines and
  the provenance fence. Contributor content is escaped so it can never terminate
  the details block early, open an HTML comment, or inject markup; a release
  body must carry exactly one details block, and the manifest embedded in the
  body must equal the published `provenance.json` asset.

## Costs and limits

- Runs on standard public runners alongside normal CI: verification, a read-only
  planner, isolated unsigned build and protected signing, and the single
  publisher. Published retries skip the Android build/sign jobs and do not
  rebuild Node assets.
- The `GITHUB_TOKEN` cannot obtain the `workflows` permission. Per the
  [GitHub REST releases API](https://docs.github.com/en/rest/releases/releases),
  a target that modifies workflow files relative to the current default branch
  can therefore be blocked from tag or release creation. Publishing at current
  `main` works normally; a historical target whose later main commits changed
  `.github/workflows/` may need operator recovery (creating the tag and assets
  for the same exact SHA manually). The builder never invents permissions,
  publishes a wrong SHA, or falls back to broader credentials.

## Manual recovery

Recovery depends on why the original run failed. For ordinary retryable failures,
recovery is a re-run of the original CI run that performed the push: the reusable
workflow inherits the original event, so the target SHA stays exact. Never dispatch a
floating workflow to "publish whatever main is now" — that path does not exist by design.

A re-run always executes that original run's immutable producer code, so merging
a builder fix does not retroactively repair the producer of an earlier failed
run; a newly merged fixed producer affects only future commits, which publish
automatically. While an interrupted release is still a draft, retries of the
original run repeat the original producer's behavior, so recovery from a
producer bug may require a manual operator publication at the exact SHA. Once
the release exists published, a later re-run of the original producer can
legitimately succeed through its read-only already-published verification path,
which idempotently verifies the published assets; such a green re-run does not
mean the old producer's write path performed or repaired the publication, and
the original failed attempt remains history.

If a draft remains incomplete, a re-run of the same SHA resumes it after identity
validation; if the failure was a fail-closed identity, integrity, or permission error,
resolve the underlying condition (or recover manually at the same exact SHA) and re-run.

### Annotated tag failures

The builder only manages lightweight `b<N>` tags: the ref must point directly to
the exact target commit. An annotated tag instead points to a tag object, which
is rejected with
`tag <name> is an annotated tag object; the release builder only manages lightweight tags`.
This rejection happens before the SHA comparison, even if the annotated tag
ultimately resolves to the correct commit, and before draft recovery or
already-published release verification.

Keep the existing tag unchanged: do not delete, convert, or retarget a protected tag.
There is no permitted in-place builder recovery while that annotated ref remains;
leave the automated run blocked rather than blindly re-running the same producer.
Even a manually published release does not make that producer's retry eligible: its
tag check still rejects the annotated ref before reaching published-release verification.

Any separately, explicitly authorized manual exact-source publication must
preserve the tag, independently verify that it resolves to the exact eligible
target SHA, and satisfy the existing provenance, asset-integrity, release-notes,
and published-release immutability requirements. It is not a builder retry or an
exemption from the builder's lightweight-tag requirement. If the tag resolves to
another commit, or no policy-compliant manual publication is authorized, leave
the release blocked. Do not publish a different SHA, dispatch a floating
workflow, or bypass policy to fill the gap.
