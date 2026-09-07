import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadReleaseModule, projectRoot } from "./helpers/release-scripts";

// Tests for the PR changelog candidate check (scripts/release/pr-candidate.cjs).
// Event handling (skip rules, payload failures) is exercised by spawning the
// real CLI with a synthetic pull_request event; the prediction and validation
// logic is exercised directly against a synthetic Git history with a synthetic
// baseline — the production CLI itself always uses the immutable pinned
// baseline and never accepts an override. No network, no remote mutation.

const SCRIPT = join(projectRoot(), "scripts", "release", "pr-candidate.cjs");

const prc = loadReleaseModule<{
  predictNextBuild(options: { repoRoot: string; baseSha: string; baseline?: string }): number;
  validateCandidateForBase(options: {
    repoRoot: string;
    baseSha: string;
    changelogText: string;
    baseline?: string;
  }): { predictedN: number; problems: string[] };
}>("pr-candidate.cjs");

interface SyntheticRepo {
  root: string;
  baseline: string;
  mainChild: string;
  mergeCommit: string;
}

function makeRepo(): SyntheticRepo {
  const root = mkdtempSync(join(tmpdir(), "release-pr-candidate-"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "release-test@example.com");
  git(root, "config", "user.name", "release-test");
  const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const commit = (message: string, parents: string[] = []): string => {
    const args = ["commit-tree", tree, "-m", message];
    for (const parent of parents) args.push("-p", parent);
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  };
  const baseline = commit("baseline");
  const c1 = commit("one", [baseline]);
  git(root, "update-ref", "refs/heads/main", c1);
  const side = commit("side", [c1]);
  const mergeCommit = commit("merge PR #1", [c1, side]);
  git(root, "update-ref", "refs/heads/main", mergeCommit);
  return { root, baseline, mainChild: c1, mergeCommit };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

const LEGACY_CHANGELOG = [
  "# Changelog",
  "",
  "Intro.",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- Old aggregate content.",
  "",
].join("\n");

function candidateChangelog(n: number, body = "- Candidate changes for the next build."): string {
  return [
    "# Changelog",
    "",
    "Intro.",
    "",
    `## [0.1.0-dev.${n}]`,
    "",
    body,
    "",
    "## Previous builds",
    "",
    "### Added",
    "",
    "- Old aggregate content.",
    "",
  ].join("\n");
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Spawn the real CLI in a scratch checkout (the event-handling paths it
// covers never touch Git history, so the synthetic repository is not needed).
function runCli(opts: {
  eventName?: string;
  event?: Record<string, unknown> | null;
  changelog?: string;
}): RunResult {
  const root = mkdtempSync(join(tmpdir(), "release-pr-candidate-run-"));
  try {
    if (opts.changelog !== undefined) writeFileSync(join(root, "CHANGELOG.md"), opts.changelog, "utf8");
    const eventPath = join(root, "event.json");
    if (opts.event !== null && opts.event !== undefined) {
      writeFileSync(eventPath, JSON.stringify(opts.event), "utf8");
    }
    const res = spawnSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_EVENT_NAME: opts.eventName ?? "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "rfairburn/pi-review-gate",
      },
    });
    return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function prEvent(baseSha: string, baseRef = "main", baseRepo = "rfairburn/pi-review-gate") {
  return { pull_request: { base: { sha: baseSha, ref: baseRef, repo: { full_name: baseRepo } } } };
}

// --- CLI event handling (spawned) -------------------------------------------

test("non-pull-request events skip the candidate check without failing", () => {
  // Even a broken changelog must not fail a push event: the publisher is the
  // gate for pushes, this check is PR-scoped.
  const res = runCli({
    eventName: "push",
    event: prEvent("a".repeat(40)),
    changelog: "garbage without any sections",
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /not a pull_request event/);
});

test("pull requests against non-main bases skip the candidate check", () => {
  const res = runCli({
    event: prEvent("a".repeat(40), "develop"),
    changelog: LEGACY_CHANGELOG,
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /not releasable/);
});

test("pull requests against other repositories skip the candidate check", () => {
  const res = runCli({
    event: prEvent("a".repeat(40), "main", "someone/else"),
    changelog: LEGACY_CHANGELOG,
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /not releasable/);
});

test("a missing or malformed base SHA fails closed before any history work", () => {
  const res = runCli({
    event: { pull_request: { base: { sha: "nope", ref: "main", repo: { full_name: "rfairburn/pi-review-gate" } } } },
    changelog: candidateChangelog(2),
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /base SHA is missing or malformed/);
});

test("a missing event payload fails closed", () => {
  const res = runCli({ event: null, changelog: candidateChangelog(2) });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unable to read the pull request event payload/);
});

test("a missing CHANGELOG.md in the checkout fails closed", () => {
  const res = runCli({ event: prEvent("a".repeat(40)) });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /CHANGELOG\.md is missing/);
});

// --- Prediction and validation (direct, synthetic history) -------------------

test("the prediction is base first-parent distance + 1; the baseline predicts b1", () => {
  const repo = makeRepo();
  try {
    assert.equal(prc.predictNextBuild({ repoRoot: repo.root, baseSha: repo.baseline, baseline: repo.baseline }), 1);
    assert.equal(prc.predictNextBuild({ repoRoot: repo.root, baseSha: repo.mainChild, baseline: repo.baseline }), 2);
    assert.equal(prc.predictNextBuild({ repoRoot: repo.root, baseSha: repo.mergeCommit, baseline: repo.baseline }), 3);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a correct candidate for the current base validates cleanly", () => {
  const repo = makeRepo();
  try {
    // Base is the main child (distance 1): the squash merge lands at distance 2.
    const { predictedN, problems } = prc.validateCandidateForBase({
      repoRoot: repo.root,
      baseSha: repo.mainChild,
      changelogText: candidateChangelog(2),
      baseline: repo.baseline,
    });
    assert.equal(predictedN, 2);
    assert.deepEqual(problems, []);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a stale candidate after base advancement fails with both numbers named", () => {
  const repo = makeRepo();
  try {
    // Main advanced to the merge commit (distance 2), so the next build is b3,
    // but the branch still carries the candidate for b2.
    const { predictedN, problems } = prc.validateCandidateForBase({
      repoRoot: repo.root,
      baseSha: repo.mergeCommit,
      changelogText: candidateChangelog(2),
      baseline: repo.baseline,
    });
    assert.equal(predictedN, 3);
    assert.ok(problems.length > 0, "a stale candidate must never validate");
    const all = problems.join("\n");
    assert.match(all, /## \[0\.1\.0-dev\.2\]/);
    assert.match(all, /## \[0\.1\.0-dev\.3\]/);
    assert.match(all, /stale or mismatched/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("missing candidate section fails closed", () => {
  const repo = makeRepo();
  try {
    const { problems } = prc.validateCandidateForBase({
      repoRoot: repo.root,
      baseSha: repo.mainChild,
      changelogText: "# Changelog\n\nIntro.\n\n## Previous builds\n\n- old\n",
      baseline: repo.baseline,
    });
    assert.ok(problems.some((p) => p.includes("no candidate build section")), JSON.stringify(problems));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("empty candidate section fails closed", () => {
  const repo = makeRepo();
  try {
    const { problems } = prc.validateCandidateForBase({
      repoRoot: repo.root,
      baseSha: repo.mainChild,
      changelogText: "# Changelog\n\n## [0.1.0-dev.2]\n\n\n## Previous builds\n\n- old\n",
      baseline: repo.baseline,
    });
    assert.ok(problems.some((p) => p.includes("is empty")), JSON.stringify(problems));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a remaining Unreleased section fails closed", () => {
  const repo = makeRepo();
  try {
    const { problems } = prc.validateCandidateForBase({
      repoRoot: repo.root,
      baseSha: repo.mainChild,
      changelogText: candidateChangelog(2) + "\n## [Unreleased]\n\n- leftover aggregate\n",
      baseline: repo.baseline,
    });
    assert.ok(problems.some((p) => p.includes("Unreleased")), JSON.stringify(problems));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("duplicate numbered sections fail closed", () => {
  const repo = makeRepo();
  try {
    const { problems } = prc.validateCandidateForBase({
      repoRoot: repo.root,
      baseSha: repo.mainChild,
      changelogText: candidateChangelog(2).replace("## Previous builds", "## [0.1.0-dev.2]\n\n- duplicate\n\n## Previous builds"),
      baseline: repo.baseline,
    });
    assert.ok(problems.some((p) => p.includes("duplicate")), JSON.stringify(problems));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a base whose history never reaches the baseline fails closed", () => {
  const repo = makeRepo();
  try {
    // An orphan commit in the same repository whose first-parent line never
    // reaches the synthetic baseline.
    const orphan = git(repo.root, "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "orphan");
    assert.throws(
      () => prc.predictNextBuild({ repoRoot: repo.root, baseSha: orphan, baseline: repo.baseline }),
      /first-parent/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
