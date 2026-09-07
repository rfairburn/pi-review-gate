"use strict";

// Idempotent, immutable, per-SHA publication of a numbered prerelease.
//
// Invariants enforced here:
//   - tag `b<N>` exists at most once and always points at the exact target SHA;
//     an existing tag pointing anywhere else fails closed (never retargeted).
//   - the release is created as a DRAFT; assets are uploaded and verified
//     byte-for-byte before it is published; published releases are immutable
//     and are only ever verified (no replacement, no clobber).
//   - incomplete drafts of the exact same source SHA resume after identity
//     validation: only missing assets are uploaded, and mismatched assets are
//     replaced only for such a verified owned temporary draft.
//   - duplicate-creation races re-read identity instead of blindly retrying.
//   - the final release is draft:false, prerelease:true, make_latest:"false".
//   - publication never rebuilds a different published artifact: retries of an
//     already-published release verify the published trusted manifest.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  BASELINE_SHA,
  HEX40,
  POLICY_ADOPTION_ANCHOR,
  REPOSITORY,
  ReleaseError,
  assertReleaseEventContext,
  createApi,
  git,
  sha256Buffer,
} = require("./common.cjs");
const { resolveEligibility, summarizeGITHUBOutput } = require("./eligibility.cjs");
// Module-object reference (not destructured) so the install-smoke call is
// resolved at invocation time; tests stub the boundary through this object.
const packagingModule = require("./packaging.cjs");
const changelog = require("./changelog.cjs");
const {
  PROVENANCE_SCHEMA,
  buildProvenance,
  buildSha256Sums,
  packStage,
  parseSha256Sums,
  stagePackage,
  verifyTarball,
} = require("./packaging.cjs");

const PACKAGE_NAME = "pi-review-gate";
const MARKER_SCHEMA = "pi-review-gate-release-identity/1";
const TARBALL_ASSET_SUFFIX = ".tgz";

// ---------------------------------------------------------------------------
// Identity marker and release bodies
// ---------------------------------------------------------------------------

// Deterministic ownership marker embedded in every release body. A draft is
// "owned" only when this marker pins the exact source identity of the run.
function identityMarker(eligibility) {
  return `<!-- pi-review-gate-release ${JSON.stringify({
    schema: MARKER_SCHEMA,
    repository: REPOSITORY,
    sha: eligibility.target,
    tag: eligibility.tag,
    version: eligibility.version,
  })} -->`;
}

// The provenance fence is always the LAST fenced JSON block of a body this
// builder writes (releaseBody appends it after any release notes), so the
// authoritative embedded manifest is the last parseable ```json fence. Notes
// content may itself contain fenced JSON; those fences are not manifests.
function parseProvenanceFromBody(body) {
  const fences = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)];
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(fences[i][1]);
    } catch {
      // Not JSON: notes content, keep scanning earlier fences.
    }
  }
  return null;
}

// Contributor notes content is confined to the single collapsed details
// block this builder renders (its `<` characters are escaped, so no raw
// details tag can appear inside it). Removing that region isolates the
// authoritative part of the body: identity lines and the provenance fence.
// Notes examples — including fenced JSON that happens to claim the
// provenance schema — are never interpreted as manifests. When the details
// structure is ambiguous (not exactly one balanced pair) nothing is removed:
// scanning everything then fails closed on any mismatch instead of guessing.
function bodyWithoutNotes(body) {
  const openCount = (body.match(/<details>/g) ?? []).length;
  const closeCount = (body.match(/<\/details>/g) ?? []).length;
  if (openCount !== 1 || closeCount !== 1) return body;
  const start = body.indexOf("<details>");
  const end = body.indexOf("</details>", start);
  if (end === -1) return body;
  return body.slice(0, start) + body.slice(end + "</details>".length);
}

// Ownership of a draft: the exact identity marker plus an authoritative
// provenance manifest OUTSIDE the notes region. A freshly created draft has
// no manifest yet (the identity write appends it after the notes block), so
// an absent manifest is owned; a present one must carry the provenance
// schema and this run's exact repository/SHA/version — an incompatible or
// foreign authoritative manifest is never owned.
function isOwnedDraft(release, eligibility) {
  if (!release || release.draft !== true || release.tag_name !== eligibility.tag) return false;
  const body = typeof release.body === "string" ? release.body : "";
  if (!body.includes(identityMarker(eligibility))) return false;
  const provenance = parseProvenanceFromBody(bodyWithoutNotes(body));
  if (provenance) {
    if (provenance?.schema !== PROVENANCE_SCHEMA) return false;
    if (provenance?.source?.repository !== REPOSITORY) return false;
    if (provenance?.source?.sha !== eligibility.target) return false;
    if (provenance?.package?.version !== eligibility.version) return false;
  }
  return true;
}

// Deterministic release body. `notesBlock` (the collapsed per-build changes
// derived from the exact source changelog) is inserted between the identity/
// provenance lines and the provenance fence; when omitted the output is
// byte-identical to the pre-notes legacy shape, so old-format drafts and
// published releases keep verifying unchanged.
function releaseBody(eligibility, provenance, notesBlock) {
  const lines = [
    identityMarker(eligibility),
    "",
    `Prerelease \`${eligibility.tag}\` of \`${PACKAGE_NAME}@${eligibility.version}\`.`,
    "",
    `- Source: ${REPOSITORY}@${eligibility.target}`,
    `- Baseline: ${eligibility.baseline} (first-parent distance ${eligibility.n})`,
    `- Merged pull request: #${eligibility.prNumber} (merge commit ${eligibility.prMergeCommitSha})`,
  ];
  if (notesBlock !== undefined && notesBlock !== null) {
    lines.push("", notesBlock);
  }
  if (provenance) {
    lines.push("", "```json", JSON.stringify(provenance, null, 2), "```");
  }
  return `${lines.join("\n")}\n`;
}

function tarballFilenameFor(version) {
  const filename = `${PACKAGE_NAME}-${version}${TARBALL_ASSET_SUFFIX}`;
  if (!filename.endsWith(TARBALL_ASSET_SUFFIX)) {
    throw new ReleaseError(`unexpected tarball name: ${filename}`);
  }
  return filename;
}

// ---------------------------------------------------------------------------
// Tag handling
// ---------------------------------------------------------------------------

// Create the tag if absent; if present (including a concurrent creation race)
// re-read it and verify it points at the exact target SHA. Never retargets.
async function ensureTag({ api, tag, target }) {
  const ref = `refs/tags/${tag}`;
  const existing = await api.getTag(ref);
  if (existing) {
    assertTagObject(existing, tag, target);
    return { created: false, sha: target };
  }
  const created = await api.createTagRef(ref, target);
  if (created.status === 201) return { created: true, sha: target };
  if (created.status === 422) {
    // Lost a creation race or the tag already exists: re-read and verify.
    const reread = await api.getTag(ref);
    if (!reread) {
      throw new ReleaseError(`tag ${tag} creation reported a conflict but the ref is unreadable`);
    }
    assertTagObject(reread, tag, target);
    return { created: false, sha: target };
  }
  throw new ReleaseError(`tag ${tag} creation failed: status ${created.status} body ${JSON.stringify(created.text.slice(0, 300))}`);
}

function assertTagObject(tagResponse, tag, target) {
  if (tagResponse?.object?.type === "tag") {
    throw new ReleaseError(`tag ${tag} is an annotated tag object; the release builder only manages lightweight tags`);
  }
  const sha = tagResponse?.object?.sha;
  if (sha !== target) {
    throw new ReleaseError(`tag ${tag} already exists at ${sha ?? "unknown"} but the target is ${target}; refusing to retarget`);
  }
}

// Re-read the tag ref and verify it still points at the exact target SHA at an
// identity-sensitive boundary. The tag ref is the actual source binding of a
// release; target_commitish is only GitHub's fallback for CREATING a missing
// tag at publication time, so the ref itself is re-verified before and after
// publication rather than trusting earlier reads.
async function assertTagRefMatches({ api, tag, target }) {
  const ref = await api.getTag(`refs/tags/${tag}`);
  if (!ref) {
    throw new ReleaseError(`tag ${tag} is unreadable at a publication boundary; failing closed`);
  }
  assertTagObject(ref, tag, target);
}

// ---------------------------------------------------------------------------
// Draft resolution
// ---------------------------------------------------------------------------

// Locate the release for a tag the way GitHub actually exposes releases:
// GET /releases/tags/{tag} returns only PUBLISHED releases (an interrupted
// draft 404s there), so drafts are found through the authenticated release
// listing, which includes them. The listing is bounded (see listReleases) and
// at most one draft may exist per tag; anything ambiguous fails closed.
async function findReleaseByTag({ api, tag }) {
  const byTag = await api.getReleaseByTag(tag);
  if (byTag) return byTag;
  const releases = await api.listReleases();
  const drafts = releases.filter((release) => release && release.tag_name === tag && release.draft === true);
  if (drafts.length > 1) {
    throw new ReleaseError(`multiple draft releases found for tag ${tag}; failing closed`);
  }
  return drafts[0] ?? null;
}

async function resolveOrCreateDraftRelease({ api, eligibility, notesBlock }) {
  const created = await api.createRelease({
    tag_name: eligibility.tag,
    // Explicit source binding. GitHub's documented default for
    // target_commitish is the repository's DEFAULT BRANCH; omitting it would
    // let a publication create the tag at floating `main` if the tag were
    // missing at publish time. Pinning it to the exact event SHA keeps every
    // possible tag-creation path on the exact validated source.
    target_commitish: eligibility.target,
    name: `${eligibility.tag} (${PACKAGE_NAME} ${eligibility.version})`,
    body: releaseBody(eligibility, undefined, notesBlock),
    draft: true,
    prerelease: true,
    make_latest: "false",
  });
  if (created.status === 201) {
    // Validate the ACTUAL stored response identity before anything fallible
    // (artifact build, asset writes) happens: GitHub has been observed
    // storing draft releases under a detached tag identity (an
    // `untagged-<hash>` tag_name). Such a draft is not the release this
    // builder owns, so it fails closed immediately.
    const release = created.json;
    if (!release || release.draft !== true) {
      throw new ReleaseError("created draft release response is malformed; failing closed");
    }
    if (release.tag_name !== eligibility.tag) {
      throw new ReleaseError(
        `created draft release reports detached tag_name ${JSON.stringify(release.tag_name)} instead of ${eligibility.tag}; failing closed before any artifact build or asset writes`,
      );
    }
    if (!isOwnedDraft(release, eligibility)) {
      // Full ownership validation of the ACTUAL stored response: the marker
      // must pin this exact repository, SHA, tag, and version. A created
      // draft without it is not owned by this builder, so its body must never
      // be overwritten by a later identity write; fail closed immediately.
      throw new ReleaseError(
        `created draft release does not carry this builder's ownership identity for ${eligibility.tag}; failing closed before any artifact build or asset writes`,
      );
    }
    return { release, mode: "created-draft" };
  }
  if (created.status === 422) {
    // Creation race or an existing release: re-read identity (draft-aware),
    // no blind retry.
    const reread = await findReleaseByTag({ api, tag: eligibility.tag });
    if (!reread) {
      throw new ReleaseError(`release creation for ${eligibility.tag} conflicted but no release is readable after re-read`);
    }
    if (reread.draft === false) {
      return { release: reread, mode: "published" };
    }
    if (!isOwnedDraft(reread, eligibility)) {
      throw new ReleaseError(`existing draft for tag ${eligibility.tag} is not owned by this builder; failing closed`);
    }
    return { release: reread, mode: "resume-draft" };
  }
  throw new ReleaseError(`release creation for ${eligibility.tag} failed: status ${created.status} body ${JSON.stringify(created.text.slice(0, 300))}`);
}

// Fail-closed discovery diagnostic: an owned draft whose API tag_name no
// longer matches the intended tag (GitHub has been observed storing drafts
// under a detached `untagged-<hash>` name while the body still carries the
// exact ownership marker) is invisible to tag-based discovery. Without this
// check, a retry would create a SECOND draft for the same identity instead of
// touching the orphan. The orphan itself is never mutated here; recovering or
// removing it is an explicit operator decision.
async function findOrphanedOwnedDraft({ api, eligibility }) {
  const releases = await api.listReleases();
  const marker = identityMarker(eligibility);
  return releases.find((release) =>
    release
    && release.draft === true
    && release.tag_name !== eligibility.tag
    && typeof release.body === "string"
    && release.body.includes(marker)
  ) ?? null;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

function expectedAssetNames(tarballFilename) {
  return ["SHA256SUMS", "provenance.json", tarballFilename];
}

async function downloadAndHash(api, asset) {
  const { buffer, status } = await api.downloadAsset(asset.id);
  if (status !== 200) throw new ReleaseError(`asset ${asset.name} download failed: status ${status}`);
  return { asset, buffer, sha256: sha256Buffer(buffer), size: buffer.length };
}

// Sync the three assets of an owned draft to this run's bytes: upload missing
// assets, keep byte-identical ones, and narrowly replace only mismatched
// assets of this verified owned temporary draft.
async function syncDraftAssets({ api, release, assets }) {
  const uploaded = [];
  const kept = [];
  const replaced = [];
  for (const asset of assets) {
    const existing = (release.assets ?? []).find((candidate) => candidate.name === asset.filename);
    if (existing && existing.size === asset.size) {
      const downloaded = await downloadAndHash(api, existing);
      if (downloaded.sha256 === asset.sha256) {
        kept.push(asset.filename);
        continue;
      }
    }
    if (existing) {
      await api.deleteAsset(existing.id, existing.name);
      replaced.push(asset.filename);
    } else {
      uploaded.push(asset.filename);
    }
    const uploadedAsset = await api.uploadAsset(release.upload_url, asset.filename, asset.buffer);
    if (uploadedAsset?.size !== asset.size) {
      throw new ReleaseError(`uploaded asset ${asset.filename} size mismatch: API reported ${uploadedAsset?.size}, expected ${asset.size}`);
    }
    const verification = await downloadAndHash(api, uploadedAsset);
    if (verification.sha256 !== asset.sha256) {
      throw new ReleaseError(`uploaded asset ${asset.filename} digest mismatch after upload; failing closed before publish`);
    }
  }
  return { uploaded, kept, replaced };
}

// Verify a published release against its own trusted manifest: the published
// provenance.json must pin this exact source identity, and the published
// tarball bytes must match both the published SHA256SUMS and the manifest.
// Rebuilt local bytes are deliberately NOT compared: tar mtimes make packing
// non-deterministic between runs, so published verification relies on the
// validated manifest rather than on re-packing different bytes.
//
// For policy-adopted builds (`expectedNotesBlock` set), the published body
// must additionally carry EXACTLY the collapsed changes block derived from
// the exact source changelog — removing, editing, or duplicating notes on a
// published release fails closed instead of masquerading as legacy.
async function verifyPublishedRelease({ api, release, eligibility, tarballFilename, expectedNotesBlock }) {
  const problems = [];
  if (release.draft !== false) problems.push("release is not published");
  if (release.prerelease !== true) problems.push("release is not marked prerelease");
  if (release.tag_name !== eligibility.tag) problems.push("tag name mismatch");
  const body = typeof release.body === "string" ? release.body : "";
  if (!body.includes(identityMarker(eligibility))) problems.push("release body does not carry the release identity marker");
  if (expectedNotesBlock !== undefined && expectedNotesBlock !== null) {
    const openCount = (body.match(/<details>/g) ?? []).length;
    const closeCount = (body.match(/<\/details>/g) ?? []).length;
    if (openCount !== 1 || closeCount !== 1) {
      problems.push(`expected exactly one collapsed changes block in the published body, found ${openCount} opening / ${closeCount} closing details tag(s)`);
    }
    if (!body.includes(expectedNotesBlock)) {
      problems.push("published release notes do not match the exact source changelog for this build");
    }
  }
  const assets = release.assets ?? [];
  const names = new Set(assets.map((asset) => asset.name));
  for (const expected of expectedAssetNames(tarballFilename)) {
    if (!names.has(expected)) problems.push(`published asset missing: ${expected}`);
  }
  if (problems.length > 0) {
    throw new ReleaseError(`published release verification failed:\n  - ${problems.join("\n  - ")}`);
  }

  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const provenanceAsset = await downloadAndHash(api, byName.get("provenance.json"));
  const provenance = JSON.parse(provenanceAsset.buffer.toString("utf8"));
  const source = provenance?.source ?? {};
  const identityProblems = [];
  if (provenance?.schema !== PROVENANCE_SCHEMA) identityProblems.push("provenance schema mismatch");
  if (source.repository !== REPOSITORY) identityProblems.push("provenance repository mismatch");
  if (source.sha !== eligibility.target) identityProblems.push("provenance source SHA mismatch");
  if (source.baseline !== eligibility.baseline) identityProblems.push("provenance baseline mismatch");
  if (source.firstParentDistance !== eligibility.n) identityProblems.push("provenance first-parent distance mismatch");
  if (provenance?.package?.version !== eligibility.version) identityProblems.push("provenance package version mismatch");
  if (provenance?.release?.tag !== eligibility.tag) identityProblems.push("provenance tag mismatch");
  if (identityProblems.length > 0) {
    throw new ReleaseError(`published provenance identity verification failed:\n  - ${identityProblems.join("\n  - ")}`);
  }

  const sumsAsset = await downloadAndHash(api, byName.get("SHA256SUMS"));
  const sums = parseSha256Sums(sumsAsset.buffer.toString("utf8"));
  const tarballAsset = await downloadAndHash(api, byName.get(tarballFilename));
  const tarballSha = sha256Buffer(tarballAsset.buffer);
  const manifestSha = sums.get(tarballFilename);
  const provenanceArtifact = provenance?.artifacts?.[tarballFilename];
  if (!manifestSha) throw new ReleaseError("published SHA256SUMS does not cover the tarball");
  if (manifestSha !== tarballSha) throw new ReleaseError("published tarball digest does not match published SHA256SUMS");
  if (provenanceArtifact?.sha256 !== tarballSha) {
    throw new ReleaseError("published tarball digest does not match published provenance");
  }
  if (provenanceArtifact?.size !== tarballAsset.buffer.length) {
    throw new ReleaseError("published tarball size does not match published provenance");
  }
  // Policy-adopted builds additionally bind the body to the asset: the
  // authoritative manifest OUTSIDE the notes region must equal the published
  // provenance asset, so a body edited after publication cannot be certified
  // on retry (notes examples are not manifests and cannot stand in for it).
  if (expectedNotesBlock !== undefined && expectedNotesBlock !== null) {
    const embedded = parseProvenanceFromBody(bodyWithoutNotes(body));
    if (embedded === null) {
      throw new ReleaseError("published release body does not carry a parseable provenance fence outside the notes block");
    }
    if (JSON.stringify(embedded) !== JSON.stringify(provenance)) {
      throw new ReleaseError("provenance embedded in the published release body differs from the published provenance asset");
    }
  }
  return { verified: true, tarballSha256: tarballSha };
}

// ---------------------------------------------------------------------------
// Artifact build (staging, packing, verification, provenance)
// ---------------------------------------------------------------------------

// Derive the full asset set from the exact validated source checkout inside
// scratch. The live dist is never touched and no version bump is committed.
async function buildReleaseArtifacts({ eligibility, projectRoot, scratch }) {
  const version = eligibility.version;
  const tarballFilename = tarballFilenameFor(version);
  const stage = stagePackage({ projectRoot, stageRoot: scratch, version });
  const tarballPath = packStage({ stage, packDestination: scratch });
  const tarballBuffer = fs.readFileSync(tarballPath);
  if (path.basename(tarballPath) !== tarballFilename) {
    throw new ReleaseError(`npm pack produced ${path.basename(tarballPath)} but ${tarballFilename} was expected`);
  }
  const { entries } = verifyTarball({ tarballPath, extractDir: path.join(scratch, "extract") });
  // Install-identity gate on the ACTUAL generated artifact, before any draft
  // can be synced or published: exact name/version, loadable compiled entry
  // point, bins, and shipped docs. A failure here throws before this function
  // returns any asset, so publication fails closed. The already-published
  // verify-only path never reaches this build.
  packagingModule.verifyInstalledTarball({
    tarballPath,
    scratchRoot: scratch,
    projectRoot,
    packageName: PACKAGE_NAME,
    version,
  });
  const tarballSha256 = sha256Buffer(tarballBuffer);
  const provenance = buildProvenance({
    repository: REPOSITORY,
    target: eligibility.target,
    baseline: eligibility.baseline,
    n: eligibility.n,
    tag: eligibility.tag,
    version,
    prNumber: eligibility.prNumber,
    prMergeCommitSha: eligibility.prMergeCommitSha,
    tarballFilename,
    tarballSha256,
    tarballSize: tarballBuffer.length,
  });
  const sumsText = buildSha256Sums([{ sha256: tarballSha256, filename: tarballFilename }]);
  const provenanceBuffer = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  return {
    assets: [
      {
        filename: tarballFilename,
        buffer: tarballBuffer,
        sha256: tarballSha256,
        size: tarballBuffer.length,
      },
      {
        filename: "SHA256SUMS",
        buffer: Buffer.from(sumsText, "utf8"),
        sha256: sha256Buffer(Buffer.from(sumsText, "utf8")),
        size: Buffer.byteLength(sumsText, "utf8"),
      },
      {
        filename: "provenance.json",
        buffer: provenanceBuffer,
        sha256: sha256Buffer(provenanceBuffer),
        size: provenanceBuffer.length,
      },
    ],
    provenance,
    tarballFilename,
    tarballEntryCount: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Per-build release notes (exact source changelog)
// ---------------------------------------------------------------------------

const CHANGELOG_RELATIVE_PATH = "CHANGELOG.md";

function readTargetChangelog({ projectRoot }) {
  const changelogPath = path.join(projectRoot, CHANGELOG_RELATIVE_PATH);
  if (!fs.existsSync(changelogPath)) {
    throw new ReleaseError(`source checkout is missing ${CHANGELOG_RELATIVE_PATH}; cannot derive or verify per-build release notes; failing closed`);
  }
  try {
    return fs.readFileSync(changelogPath, "utf8");
  } catch (error) {
    throw new ReleaseError(`unable to read ${CHANGELOG_RELATIVE_PATH}: ${String((error && error.message) || error).slice(0, 300)}`);
  }
}

// Policy-adoption boundary, derived from the immutable source anchor rather
// than from section presence: a target is adopted when it is a STRICT
// first-parent descendant of the anchor (the main commit at adoption time). A
// section-presence scan would let the first adopted build omit its own notes
// and be reclassified as legacy; an anchor cannot. The anchor itself and its
// ancestors are pre-adoption builds and stay legacy. A target whose line
// neither contains nor precedes the anchor (a rewritten or divergent history)
// fails closed instead of guessing.
function changelogPolicyAdopted({ repoRoot, target, policyAnchor }) {
  if (!HEX40.test(policyAnchor ?? "")) {
    throw new ReleaseError(`policy adoption anchor must be a 40-hex commit SHA, got ${JSON.stringify(policyAnchor ?? null)}`);
  }
  const chain = git(["rev-list", "--first-parent", target], { repoRoot }).split("\n");
  const anchorIndex = chain.indexOf(policyAnchor);
  if (anchorIndex > 0) return true; // strict first-parent descendant: adopted
  if (anchorIndex === 0) return false; // the target IS the last legacy build
  let anchorChain;
  try {
    anchorChain = git(["rev-list", "--first-parent", policyAnchor], { repoRoot }).split("\n");
  } catch (error) {
    throw new ReleaseError(`cannot resolve the policy adoption anchor ${policyAnchor}: ${String((error && error.message) || error).slice(0, 300)}`);
  }
  if (anchorChain.includes(target)) return false; // pre-adoption ancestor of the anchor
  throw new ReleaseError(
    `cannot determine changelog policy adoption: target ${target} neither contains nor precedes the adoption anchor ${policyAnchor}; failing closed`,
  );
}

// Derive the exact collapsible release notes for this target from the changelog
// of the EXACT source checkout (never a moving branch). Runs before any remote
// write in publishRelease. Returns { notesBlock: string | null }:
//   - topmost numbered section is this build's: new format; the block is
//     derived and required to be well-formed and non-empty;
//   - no numbered sections at all: legacy unless the target is policy-adopted
//     per the immutable source anchor (then a missing section fails closed
//     instead of silently taking the legacy path);
//   - topmost numbered section is any other build: stale or mismatched
//     candidate; fails closed before publication.
function deriveReleaseNotes({ projectRoot, repoRoot, eligibility, policyAnchor }) {
  const text = readTargetChangelog({ projectRoot });
  let parsed;
  try {
    parsed = changelog.parseChangelog(text);
  } catch (error) {
    throw new ReleaseError(`changelog structure rejected: ${String((error && error.message) || error).slice(0, 300)}`);
  }
  const topmost = parsed.numbered.length > 0 ? parsed.numbered[0].n : null;
  if (topmost === null) {
    const adopted = changelogPolicyAdopted({ repoRoot, target: eligibility.target, policyAnchor });
    if (adopted) {
      throw new ReleaseError(
        `no changelog section for build ${changelog.devVersionFor(eligibility.n)} although per-build attribution is already adopted in this target's history; missing notes never publish silently; failing closed`,
      );
    }
    return { notesBlock: null };
  }
  if (topmost !== eligibility.n) {
    throw new ReleaseError(
      `changelog topmost numbered section is ${changelog.buildHeadingFor(topmost)} but this target is build ${changelog.devVersionFor(eligibility.n)}; the candidate number is stale or mismatched — update it against the current base and re-run strict CI; failing closed before any remote write`,
    );
  }
  let derived;
  try {
    derived = changelog.deriveReleaseNotes({ text, n: eligibility.n, tag: eligibility.tag });
  } catch (error) {
    throw new ReleaseError(`release notes derivation failed for ${changelog.devVersionFor(eligibility.n)}: ${String((error && error.message) || error).slice(0, 300)}`);
  }
  return { notesBlock: derived.notesBlock };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function publishRelease({ env, fetchImpl, projectRoot, scratchRoot, buildArtifacts, baseline, policyAnchor }) {
  const anchor = policyAnchor ?? POLICY_ADOPTION_ANCHOR;
  const context = assertReleaseEventContext(env);
  const eligibility = await resolveEligibility({ env, fetchImpl, repoRoot: projectRoot, baseline });
  if (eligibility.target !== context.target) {
    throw new ReleaseError("eligibility target drifted from the event context; failing closed");
  }
  // The checkout must literally be the event SHA: never a floating main.
  const head = git(["rev-parse", "HEAD"], { repoRoot: projectRoot });
  if (head !== context.target) {
    throw new ReleaseError(`checkout HEAD ${head} does not match the event SHA ${context.target}`);
  }
  const tarballFilename = tarballFilenameFor(eligibility.version);
  // Per-build notes are derived from the exact source checkout BEFORE any
  // remote write: a stale, missing, duplicate, or empty candidate fails
  // closed here, and the same block is what retries must find published.
  const { notesBlock } = deriveReleaseNotes({ projectRoot, repoRoot: projectRoot, eligibility, policyAnchor: anchor });
  const api = createApi({ fetchImpl, token: env.GITHUB_TOKEN, repository: REPOSITORY });

  const tag = await ensureTag({ api, tag: eligibility.tag, target: eligibility.target });
  // Draft-aware lookup: the tag endpoint alone would miss an interrupted draft.
  const existing = await findReleaseByTag({ api, tag: eligibility.tag });

  if (existing && existing.draft === false) {
    // Immutable boundary: published releases are verified only, never touched.
    const verification = await verifyPublishedRelease({ api, release: existing, eligibility, tarballFilename, expectedNotesBlock: notesBlock });
    // Read-only identity cross-check: the published release must still be
    // bound to a tag ref at the exact source SHA. Failing closed here mutates
    // nothing; it only refuses to certify a compromised identity.
    await assertTagRefMatches({ api, tag: eligibility.tag, target: eligibility.target });
    return {
      outcome: "already-published",
      tag: eligibility.tag,
      version: eligibility.version,
      target: eligibility.target,
      releaseUrl: existing.html_url,
      tarballSha256: verification.tarballSha256,
      mode: "published",
    };
  }

  if (!existing) {
    // No readable release for this tag. Before creating anything, refuse to
    // duplicate an orphaned owned draft: a draft carrying the exact identity
    // marker but detached from its tag (e.g. GitHub `untagged-…` tag_name)
    // must be recovered or removed by an explicit operator action, never
    // papered over with a duplicate draft.
    const orphan = await findOrphanedOwnedDraft({ api, eligibility });
    if (orphan) {
      throw new ReleaseError(
        `an owned draft carrying the exact ${eligibility.tag} identity marker exists (release id ${orphan.id}) but its API tag_name is ${JSON.stringify(orphan.tag_name)} (detached draft identity); refusing to create a duplicate draft; operator recovery required; failing closed`,
      );
    }
  }

  let release;
  let mode;
  if (existing) {
    if (!isOwnedDraft(existing, eligibility)) {
      throw new ReleaseError(
        `existing draft for tag ${eligibility.tag} is not owned by this builder (identity mismatch); refusing to touch it`,
      );
    }
    release = existing;
    mode = "resume-draft";
  } else {
    const resolved = await resolveOrCreateDraftRelease({ api, eligibility, notesBlock });
    release = resolved.release;
    mode = resolved.mode;
    if (mode === "published") {
      // A concurrent run published between our discovery and creation: the
      // immutable boundary applies immediately — verify only. No artifact
      // build, no PATCH, no upload, no delete may touch a published release.
      const verification = await verifyPublishedRelease({ api, release, eligibility, tarballFilename, expectedNotesBlock: notesBlock });
      return {
        outcome: "already-published",
        tag: eligibility.tag,
        version: eligibility.version,
        target: eligibility.target,
        releaseUrl: release.html_url,
        tarballSha256: verification.tarballSha256,
        mode: "published",
      };
    }
  }

  const scratch = scratchRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-release-"));
  const ownedScratch = scratchRoot ? false : true;
  try {
    const build = await (buildArtifacts ?? buildReleaseArtifacts)({
      eligibility,
      projectRoot,
      scratch,
    });
    await api.updateRelease(release.id, {
      // Re-assert the bound tag and source on EVERY draft mutation: a live
      // API probe (issue #13) confirmed that a draft PATCH omitting tag_name
      // detaches the stored tag (the draft is re-stored under a synthetic
      // `untagged-<hash>` tag_name), while an omitted target_commitish
      // preserves its existing value — the default branch applies only on
      // CREATE. Both fields are therefore always sent explicitly here.
      tag_name: eligibility.tag,
      target_commitish: eligibility.target,
      draft: true,
      prerelease: true,
      body: releaseBody(eligibility, build.provenance, notesBlock),
    });
    const refreshed = await api.getRelease(release.id);
    if (!refreshed) throw new ReleaseError("draft release became unreadable after identity write");
    if (!isOwnedDraft(refreshed, eligibility)) {
      throw new ReleaseError("draft release lost its owned identity before publication; failing closed");
    }
    const sync = await syncDraftAssets({ api, release: refreshed, assets: build.assets });
    // Publication boundary: re-verify the tag ref still points at the exact
    // target immediately before the publish PATCH, and re-assert the bound
    // tag/source in the publish payload itself.
    await assertTagRefMatches({ api, tag: eligibility.tag, target: eligibility.target });
    await api.updateRelease(release.id, {
      tag_name: eligibility.tag,
      target_commitish: eligibility.target,
      draft: false,
      prerelease: true,
      make_latest: "false",
      body: releaseBody(eligibility, build.provenance, notesBlock),
    });
    const published = await api.getRelease(release.id);
    if (!published) throw new ReleaseError("release became unreadable after publication");
    await assertTagRefMatches({ api, tag: eligibility.tag, target: eligibility.target });
    const verification = await verifyPublishedRelease({
      api,
      release: published,
      eligibility,
      tarballFilename: build.tarballFilename,
      expectedNotesBlock: notesBlock,
    });
    return {
      outcome: "published",
      tag: eligibility.tag,
      version: eligibility.version,
      target: eligibility.target,
      releaseUrl: published.html_url,
      tarballSha256: verification.tarballSha256,
      tarballEntries: build.tarballEntryCount,
      mode,
      tagCreated: tag.created,
      assets: sync,
    };
  } finally {
    if (ownedScratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = {
  assertTagRefMatches,
  bodyWithoutNotes,
  changelogPolicyAdopted,
  deriveReleaseNotes,
  ensureTag,
  expectedAssetNames,
  findOrphanedOwnedDraft,
  findReleaseByTag,
  identityMarker,
  isOwnedDraft,
  parseProvenanceFromBody,
  publishRelease,
  releaseBody,
  resolveOrCreateDraftRelease,
  syncDraftAssets,
  tarballFilenameFor,
  verifyPublishedRelease,
  buildReleaseArtifacts,
};

// Re-exported for the CLI entry point and tests.
module.exports.summarizeGITHUBOutput = summarizeGITHUBOutput;

if (require.main === module) {
  publishRelease({
    env: process.env,
    fetchImpl: globalThis.fetch,
    projectRoot: process.cwd(),
  })
    .then((summary) => {
      const output = process.env.GITHUB_OUTPUT;
      if (output) {
        fs.appendFileSync(output, `tag=${summary.tag}\nversion=${summary.version}\ntarget=${summary.target}\noutcome=${summary.outcome}\n`);
      }
      process.stdout.write(`release ${summary.outcome}: ${summary.tag} (${summary.version}) from ${summary.target}\n`);
    })
    .catch((error) => {
      process.stderr.write(`release failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
