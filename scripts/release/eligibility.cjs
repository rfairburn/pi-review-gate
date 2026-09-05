"use strict";

// Release eligibility: the target SHA must be the exact merge commit of a
// merged pull request against the scoped repository's main branch. Association
// by "any PR mentioning the commit" is NOT sufficient; direct pushes, open or
// unmerged PRs, foreign base repositories/branches, and SHAs whose merge commit
// differs from the target are all rejected. When several real merges share the
// exact target SHA the lowest PR number is chosen deterministically.
//
// The commit-associated pull request endpoint (GET /commits/{sha}/pulls)
// returns list-shaped simplified items that do NOT carry the detailed `merged`
// boolean, so every candidate is confirmed against its detailed pull request
// record (GET /pulls/{number}) before it can count as a real merge.

const fs = require("node:fs");
const {
  BASE_VERSION,
  BASELINE_SHA,
  REPOSITORY,
  ReleaseError,
  TAG_PREFIX,
  assertReleaseEventContext,
  createApi,
} = require("./common.cjs");
const { assertTargetOnMainFirstParent, firstParentDistance } = require("./numbering.cjs");

// Validates a DETAILED pull request record. The `merged` boolean is the
// authoritative merge signal on this shape (list-shaped association items lack
// it and must never be evaluated by this function alone).
function isEligiblePullRequest(pr, target) {
  return Boolean(
    pr
      && typeof pr.number === "number"
      && pr.state === "closed"
      && pr.merged === true
      && pr.merge_commit_sha === target
      && pr.base
      && pr.base.repo
      && pr.base.repo.full_name === REPOSITORY
      && pr.base.ref === "main",
  );
}

function describeRejection(pr, target) {
  // Numbers and enum state only: pull request titles/bodies are untrusted and
  // never echoed into logs or error messages.
  const reasons = [];
  if (pr.state !== "closed") reasons.push(`state ${JSON.stringify(pr.state)}`);
  if (pr.merged !== true) reasons.push("not merged");
  if (pr.merge_commit_sha !== target) reasons.push("merge_commit_sha differs from target");
  if (!pr.base || !pr.base.repo || pr.base.repo.full_name !== REPOSITORY) reasons.push("base repository mismatch");
  if (!pr.base || pr.base.ref !== "main") reasons.push("base branch is not main");
  return `#${pr.number}: ${reasons.length > 0 ? reasons.join(", ") : "unknown"}`;
}

async function resolveEligibility({ env, fetchImpl, repoRoot, gitDir, baseline = BASELINE_SHA }) {
  if (repoRoot === undefined && gitDir === undefined) {
    throw new ReleaseError("resolveEligibility requires repoRoot or gitDir");
  }
  const context = assertReleaseEventContext(env);
  const { n, target, baseline: resolvedBaseline } = firstParentDistance({
    repoRoot: repoRoot ?? gitDir,
    target: context.target,
    baseline,
  });
  // Local ancestry gate before any API call: the target must be part of
  // current main's strict first-parent history (a merged commit later removed
  // from main by a rewrite is not releasable, even though its own line still
  // reaches the baseline and a real merge PR exists for it).
  assertTargetOnMainFirstParent({ repoRoot: repoRoot ?? gitDir, target });
  const api = createApi({
    fetchImpl,
    token: env.GITHUB_TOKEN,
    repository: REPOSITORY,
  });
  const associations = await api.getCommitPullRequests(target);
  const malformed = associations.filter((pr) => !pr || typeof pr.number !== "number").length;
  const numbers = [...new Set(
    associations
      .filter((pr) => pr && typeof pr.number === "number")
      .map((pr) => pr.number),
  )].sort((a, b) => a - b);
  if (numbers.length === 0) {
    throw new ReleaseError(
      associations.length === 0
        ? "no pull request is associated with this commit (direct pushes are not releasable)"
        : `commit association contains no usable pull request (${malformed} malformed item(s))`,
    );
  }
  // Confirm every candidate against its detailed record; the list-shaped
  // association alone can never establish eligibility.
  const eligibleNumbers = [];
  const rejections = [];
  for (const number of numbers) {
    const detail = await api.getPullRequest(number);
    if (!detail) {
      rejections.push(`#${number}: detailed pull request unreadable`);
      continue;
    }
    if (isEligiblePullRequest(detail, target)) {
      eligibleNumbers.push(number);
    } else {
      rejections.push(describeRejection(detail, target));
    }
  }
  if (eligibleNumbers.length === 0) {
    throw new ReleaseError(
      `no associated pull request is a real merge of ${REPOSITORY} main at the exact target SHA (${rejections.join("; ")})`,
    );
  }
  return {
    n,
    target,
    baseline: resolvedBaseline,
    tag: `${TAG_PREFIX}${n}`,
    version: `${BASE_VERSION}-dev.${n}`,
    prNumber: eligibleNumbers[0],
    prMergeCommitSha: target,
    associatedPullRequests: eligibleNumbers,
  };
}

function summarizeGITHUBOutput(eligibility) {
  return [
    `n=${eligibility.n}`,
    `tag=${eligibility.tag}`,
    `version=${eligibility.version}`,
    `target=${eligibility.target}`,
    `baseline=${eligibility.baseline}`,
    `pr=${eligibility.prNumber}`,
    "",
  ].join("\n");
}

module.exports = { isEligiblePullRequest, resolveEligibility, summarizeGITHUBOutput };

if (require.main === module) {
  resolveEligibility({
    env: process.env,
    fetchImpl: globalThis.fetch,
    repoRoot: process.cwd(),
  })
    .then((eligibility) => {
      const output = process.env.GITHUB_OUTPUT;
      if (output) {
        fs.appendFileSync(output, summarizeGITHUBOutput(eligibility));
      }
      process.stdout.write(
        `release eligibility verified: ${eligibility.tag} (${eligibility.version}) from ${eligibility.target} via PR #${eligibility.prNumber}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`release eligibility rejected: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
