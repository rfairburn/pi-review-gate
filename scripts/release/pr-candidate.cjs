"use strict";

// Event/history-aware PR changelog candidate check (read-only, no API calls).
//
// Validates that a pull request against main carries the changelog candidate
// section for the NEXT build, numbered from the pull request's CURRENT base:
// N = first-parent distance(base, baseline) + 1. A squash merge lands exactly
// one first-parent step above the base it merges against, so this is an exact
// prediction of where THIS pull request will land — but only while the base
// does not move. It is a provisional prediction, not publication eligibility:
// it never runs for push events, never calls the GitHub API, and never writes.
// If main advances while the pull request is open, the contributor updates the
// candidate section against the new base and strict CI re-validates; the
// publisher then re-checks the exact merged commit before any remote write.
//
// Requires full history (the verify job checks out with fetch-depth: 0): the
// default shallow checkout cannot count the base's first-parent distance from
// the immutable baseline, and this check fails closed rather than guessing.

const fs = require("node:fs");
const path = require("node:path");
const { BASELINE_SHA, HEX40, REPOSITORY, ReleaseError } = require("./common.cjs");
const { firstParentDistance } = require("./numbering.cjs");
const changelog = require("./changelog.cjs");

// Bounded diagnostic: never echo the event payload or file contents.
function boundedDetail(error) {
  const message = String((error && error.message) || error);
  return message.slice(0, 300);
}

// The next build number this pull request will land at: one first-parent
// step above the base it merges against. `baseline` defaults to the immutable
// production baseline; tests may pass a synthetic one (the CLI never does).
function predictNextBuild({ repoRoot, baseSha, baseline = BASELINE_SHA }) {
  if (!HEX40.test(baseSha ?? "")) {
    throw new ReleaseError("pull request base SHA is missing or malformed; failing closed");
  }
  if (baseSha === baseline) return 1;
  const { n } = firstParentDistance({ repoRoot, target: baseSha, baseline });
  return n + 1;
}

// Validate the candidate changelog against the prediction for a specific
// pull request base. Returns { predictedN, problems }.
function validateCandidateForBase({ repoRoot, baseSha, changelogText, baseline = BASELINE_SHA }) {
  const predictedN = predictNextBuild({ repoRoot, baseSha, baseline });
  return { predictedN, problems: changelog.validateCandidateChangelog(changelogText, predictedN).problems };
}

function main() {
  const env = process.env;
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    process.stdout.write("pr-candidate: not a pull_request event; nothing to validate\n");
    return 0;
  }
  let event;
  try {
    event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch (error) {
    throw new ReleaseError(`unable to read the pull request event payload: ${boundedDetail(error)}`);
  }
  const base = (event.pull_request && event.pull_request.base) || null;
  const baseRef = base ? base.ref : undefined;
  const baseRepo = base && base.repo ? base.repo.full_name : undefined;
  if (baseRef !== "main" || baseRepo !== REPOSITORY) {
    process.stdout.write(
      `pr-candidate: base is ${JSON.stringify(baseRepo ?? null)}:${JSON.stringify(baseRef ?? null)}, not ${REPOSITORY}:main; not releasable, nothing to validate\n`,
    );
    return 0;
  }
  // Exact prediction from the event's current base against the immutable
  // production baseline (the CLI never accepts a different one).
  const { predictedN, problems } = validateCandidateForBase({
    repoRoot: process.cwd(),
    baseSha: base.sha,
    changelogText: readChangelog(process.cwd()),
  });
  if (problems.length > 0) {
    process.stderr.write(
      `pr-candidate: the current base predicts next build b${predictedN} (first-parent distance ${predictedN - 1} + 1); candidate validation failed:\n`,
    );
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.stderr.write(
      "pr-candidate: failing closed; update the candidate section against the current base and re-run strict CI\n",
    );
    return 1;
  }
  process.stdout.write(
    `pr-candidate: candidate section for b${predictedN} validated against the current base (provisional prediction; the publisher re-validates the exact merged commit before any remote write)\n`,
  );
  return 0;
}

function readChangelog(repoRoot) {
  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) {
    throw new ReleaseError("CHANGELOG.md is missing from the pull request checkout; failing closed");
  }
  try {
    return fs.readFileSync(changelogPath, "utf8");
  } catch (error) {
    throw new ReleaseError(`unable to read CHANGELOG.md: ${boundedDetail(error)}`);
  }
}

module.exports = { main, predictNextBuild, validateCandidateForBase };

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`pr-candidate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}