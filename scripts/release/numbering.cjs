"use strict";

// Release numbering: N is the first-parent distance from the immutable baseline
// commit to the target commit. It is a pure function of repository history, so
// two different main commits can never derive the same N without a history
// rewrite, and later main advances never change the number of an existing
// target. Gaps (from rebase or direct-push landings) are acceptable; the number
// always reflects actual first-parent distance.

const { BASELINE_SHA, HEX40, ReleaseError, git } = require("./common.cjs");

// Walk the strict first-parent chain from `target` toward its root and report
// how many steps separate it from `baseline`. The baseline must lie exactly on
// the first-parent line: reachability through a second (merged side-branch)
// parent does not count and is rejected.
function firstParentDistance({ repoRoot, target, baseline = BASELINE_SHA }) {
  if (!HEX40.test(target ?? "")) {
    throw new ReleaseError(`target must be a 40-hex commit SHA, got ${JSON.stringify(target ?? null)}`);
  }
  if (!HEX40.test(baseline ?? "")) {
    throw new ReleaseError(`baseline must be a 40-hex commit SHA, got ${JSON.stringify(baseline ?? null)}`);
  }
  for (const [label, sha] of [["target", target], ["baseline", baseline]]) {
    let type;
    try {
      type = git(["cat-file", "-t", sha], { repoRoot });
    } catch {
      throw new ReleaseError(`${label} ${sha} is not a commit (object is missing or unreadable)`);
    }
    if (type !== "commit") {
      throw new ReleaseError(`${label} ${sha} is not a commit (git cat-file reported ${type})`);
    }
  }
  if (target === baseline) {
    throw new ReleaseError("target equals the immutable baseline; N must be positive");
  }
  const chain = git(["rev-list", "--first-parent", target], { repoRoot }).split("\n");
  const index = chain.indexOf(baseline);
  if (index === -1) {
    throw new ReleaseError(
      `baseline ${baseline} is not on the first-parent line of target ${target}; refusing to number`,
    );
  }
  if (index === 0) {
    throw new ReleaseError("target equals the immutable baseline; N must be positive");
  }
  return { n: index, target, baseline };
}

// Resolve the authoritative main ref without checking anything out: prefer a
// freshly fetched remote-tracking ref (the workflow fetches origin/main into
// this ref read-only before eligibility runs), and fall back to the local
// branch for synthetic test repositories. Fails closed when neither exists.
function resolveMainRef(repoRoot) {
  for (const ref of ["refs/remotes/origin/main", "refs/heads/main"]) {
    try {
      const sha = git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { repoRoot });
      if (HEX40.test(sha)) return { ref, sha };
    } catch {
      // Try the next candidate.
    }
  }
  throw new ReleaseError(
    "cannot resolve an authoritative main ref (neither refs/remotes/origin/main nor refs/heads/main exists); fetch main before verifying release ancestry",
  );
}

// The target must lie on main's strict first-parent history. This is a
// stronger condition than the baseline check above: a commit that was merged
// into main but later removed by a history rewrite still has its own
// first-parent line reaching the baseline, yet it is no longer part of main
// and must be rejected. Reachability only through a merged side parent is
// likewise rejected. Nothing is checked out; the walk reads the resolved ref.
function assertTargetOnMainFirstParent({ repoRoot, target }) {
  if (!HEX40.test(target ?? "")) {
    throw new ReleaseError(`target must be a 40-hex commit SHA, got ${JSON.stringify(target ?? null)}`);
  }
  const { ref, sha: mainSha } = resolveMainRef(repoRoot);
  const chain = git(["rev-list", "--first-parent", mainSha], { repoRoot }).split("\n");
  if (!chain.includes(target)) {
    throw new ReleaseError(
      `target ${target} is not on the first-parent history of main (${ref} at ${mainSha}); refusing to release a commit that is not part of main`,
    );
  }
  return { mainRef: ref, mainSha };
}

module.exports = {
  assertTargetOnMainFirstParent,
  firstParentDistance,
  resolveMainRef,
};
