import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadReleaseModule } from "./helpers/release-scripts";
import type { NumberingModule, ReleaseCommon } from "./helpers/release-scripts";

const { BASELINE_SHA } = loadReleaseModule<ReleaseCommon>("common.cjs");
const numbering = loadReleaseModule<NumberingModule>("numbering.cjs");
const { firstParentDistance } = numbering;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "release-test",
  GIT_AUTHOR_EMAIL: "release-test@example.com",
  GIT_COMMITTER_NAME: "release-test",
  GIT_COMMITTER_EMAIL: "release-test@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

interface SyntheticRepo {
  root: string;
  commit(message: string, parents?: string[]): string;
  pointBranchAt(sha: string, branch?: string): void;
}

// Deterministic synthetic repository built with git plumbing so first-parent
// chains (including merges with arbitrary parent orders) are explicit.
function makeRepo(): SyntheticRepo {
  const root = mkdtempSync(join(tmpdir(), "release-numbering-"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "release-test@example.com");
  git(root, "config", "user.name", "release-test");
  let counter = 0;
  const repo: SyntheticRepo = {
    root,
    commit(message, parents = []) {
      counter += 1;
      // Well-known empty tree: numbering only depends on commit topology.
      const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const args = ["commit-tree", tree, "-m", message];
      for (const parent of parents) args.push("-p", parent);
      const sha = execFileSync("git", ["-C", root, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
      return sha;
    },
    pointBranchAt(sha, branch = "main") {
      git(root, "update-ref", `refs/heads/${branch}`, sha);
    },
  };
  return repo;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
}

test("immutable baseline constant is the pinned first-parent baseline", () => {
  assert.equal(BASELINE_SHA, "f7c174f1c12c81447bce2ab1aa39fb5faf4331ec");
});

test("first-parent distance counts linear commits after the baseline", () => {
  const repo = makeRepo();
  try {
    const base = repo.commit("baseline");
    const c1 = repo.commit("one", [base]);
    const c2 = repo.commit("two", [c1]);
    const c3 = repo.commit("three", [c2]);
    assert.deepEqual(firstParentDistance({ repoRoot: repo.root, target: c3, baseline: base }), {
      n: 3,
      target: c3,
      baseline: base,
    });
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("merge commits count only along the first-parent line", () => {
  const repo = makeRepo();
  try {
    const base = repo.commit("baseline");
    const c1 = repo.commit("one", [base]);
    const s1 = repo.commit("side one", [c1]);
    const s2 = repo.commit("side two", [s1]);
    const merge = repo.commit("merge side", [c1, s2]);
    // First-parent chain: merge -> c1 -> base  => distance 2.
    assert.equal(firstParentDistance({ repoRoot: repo.root, target: merge, baseline: base }).n, 2);
    // A side-branch tip forks off the line: its own first-parent walk still
    // traces s2 -> s1 -> c1 -> base, so the distance counts the side branch.
    // Such a tip is not a merge of main and is rejected by eligibility, not
    // by numbering.
    assert.equal(firstParentDistance({ repoRoot: repo.root, target: s2, baseline: base }).n, 3);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a side history that never reaches the baseline is rejected", () => {
  const repo = makeRepo();
  try {
    const base = repo.commit("baseline");
    // Orphan side history: its first-parent chain never reaches the baseline.
    const orphan = repo.commit("orphan root");
    const orphan2 = repo.commit("orphan two", [orphan]);
    assert.throws(() => firstParentDistance({ repoRoot: repo.root, target: orphan2, baseline: base }), /first-parent/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("target equal to the baseline is rejected (N must be positive)", () => {
  const repo = makeRepo();
  try {
    const base = repo.commit("baseline");
    assert.throws(() => firstParentDistance({ repoRoot: repo.root, target: base, baseline: base }), /positive/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("numbering is a pure function of history: gaps and rewritten commits keep their distance", () => {
  const repo = makeRepo();
  try {
    const base = repo.commit("baseline");
    const c1 = repo.commit("one", [base]);
    const c2 = repo.commit("two", [c1]);
    assert.equal(firstParentDistance({ repoRoot: repo.root, target: c2, baseline: base }).n, 2);
    // Simulate a force-push rewrite: a different commit replaces c2 at the tip.
    const c2prime = repo.commit("two (rewritten)", [c1]);
    repo.pointBranchAt(c2prime);
    assert.equal(firstParentDistance({ repoRoot: repo.root, target: c2prime, baseline: base }).n, 2);
    // Different commit, same distance: tag identity must be enforced elsewhere.
    assert.notEqual(c2, c2prime);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("default baseline is the pinned immutable baseline commit", () => {
  const repo = makeRepo();
  try {
    const c1 = repo.commit("after baseline");
    repo.pointBranchAt(c1);
    // Against the real repository baseline (absent from this synthetic repo)
    // the walk must fail closed rather than invent a number.
    assert.throws(() => firstParentDistance({ repoRoot: repo.root, target: c1 }), /is not a commit|first-parent/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("non-commit or malformed SHAs are rejected", () => {
  const repo = makeRepo();
  try {
    const base = repo.commit("baseline");
    assert.throws(() => firstParentDistance({ repoRoot: repo.root, target: "nothex", baseline: base }), /40-hex/);
    assert.throws(
      () => firstParentDistance({ repoRoot: repo.root, target: "0".repeat(40), baseline: base }),
      /not a commit/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

// --- Current-main first-parent verification ---------------------------------

function makeMainRepo(): SyntheticRepo & { side: string; c1: string } {
  const repo = makeRepo();
  const base = repo.commit("baseline");
  const c1 = repo.commit("one", [base]);
  repo.pointBranchAt(c1);
  const side = repo.commit("side", [c1]);
  return { ...repo, side, c1 };
}

test("a later valid main advance keeps the target eligible on main's first-parent line", () => {
  const repo = makeMainRepo();
  try {
    // Target c1 is a direct child of the baseline; main has since advanced
    // past it, so an original-run retry for c1 must stay eligible.
    const newer = repo.commit("later advance", [repo.c1]);
    repo.pointBranchAt(newer);
    const result = numbering.assertTargetOnMainFirstParent({ repoRoot: repo.root, target: repo.c1 });
    assert.equal(result.mainRef, "refs/heads/main");
    assert.equal(result.mainSha, newer);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a target present only through a merged side parent is rejected", () => {
  const repo = makeMainRepo();
  try {
    // `side` forks off main at c1 and is never merged back: it is reachable
    // from main's tip only through the second parent of a future merge, so it
    // must not count as part of main.
    const merge = repo.commit("merge side later", [repo.c1, repo.side]);
    repo.pointBranchAt(merge);
    assert.throws(
      () => numbering.assertTargetOnMainFirstParent({ repoRoot: repo.root, target: repo.side }),
      /not on the first-parent history of main/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a previously merged target removed from main by a rewrite is rejected", () => {
  const repo = makeMainRepo();
  try {
    const sideTip = repo.commit("side tip", [repo.side]);
    const merge = repo.commit("merge side", [repo.c1, sideTip]);
    repo.pointBranchAt(merge);
    // The target is on main's first-parent line while the merge is the tip.
    numbering.assertTargetOnMainFirstParent({ repoRoot: repo.root, target: merge });
    // A force-push rewrite replaces the tip with a different child of c1,
    // removing the old merge from main's first-parent history.
    const rewritten = repo.commit("rewritten tip", [repo.c1]);
    repo.pointBranchAt(rewritten);
    assert.throws(
      () => numbering.assertTargetOnMainFirstParent({ repoRoot: repo.root, target: merge }),
      /not on the first-parent history of main/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a missing authoritative main ref fails closed", () => {
  const repo = makeRepo();
  try {
    // No refs/heads/main and no refs/remotes/origin/main exist yet.
    const base = repo.commit("baseline");
    const c1 = repo.commit("one", [base]);
    assert.throws(
      () => numbering.assertTargetOnMainFirstParent({ repoRoot: repo.root, target: c1 }),
      /cannot resolve an authoritative main ref/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a freshly fetched remote main takes precedence over the local branch", () => {
  const repo = makeMainRepo();
  try {
    // Point a remote-tracking ref at a history that does NOT contain c1's
    // sibling side: the remote ref must be the one walked.
    const otherRootSha = repo.commit("remote-only tip", [repo.c1]);
    git(repo.root, "update-ref", "refs/remotes/origin/main", otherRootSha);
    const result = numbering.assertTargetOnMainFirstParent({ repoRoot: repo.root, target: otherRootSha });
    assert.equal(result.mainRef, "refs/remotes/origin/main");
    assert.equal(result.mainSha, otherRootSha);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
