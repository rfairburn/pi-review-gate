import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadReleaseModule } from "./helpers/release-scripts";
import type { EligibilityModule, NumberingModule, ReleaseApi } from "./helpers/release-scripts";

const common = loadReleaseModule<{
  BASELINE_SHA: string;
  MAIN_REF: string;
  REPOSITORY: string;
  assertReleaseEventContext(env: Record<string, string | undefined>): unknown;
  createApi(options: { fetchImpl: unknown; token: string; repository: string }): ReleaseApi;
}>("common.cjs");
const eligibilityModule = loadReleaseModule<EligibilityModule>("eligibility.cjs");
const numberingModule = loadReleaseModule<NumberingModule>("numbering.cjs");

const TARGET = "a".repeat(40);
const TOKEN = "test-token";

function baseEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REPOSITORY: "rfairburn/pi-review-gate",
    GITHUB_SHA: TARGET,
    GITHUB_TOKEN: TOKEN,
    ...overrides,
  };
}

interface SyntheticRepo {
  root: string;
  baseline: string;
  mergeCommit: string;
}

// Synthetic repository: baseline, one main commit, then a real merge commit
// (two parents) at the tip, matching a merge-commit release target.
function makeRepo(): SyntheticRepo {
  const root = mkdtempSync(join(tmpdir(), "release-eligibility-"));
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
  return { root, baseline, mergeCommit };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

// --- Contract-faithful fixtures and mock ------------------------------------
//
// GET /commits/{sha}/pulls returns LIST-SHAPED simplified items that do NOT
// carry the detailed `merged` boolean (merged PRs expose merged_at instead).
// Eligibility must therefore confirm every candidate against its DETAILED
// record from GET /pulls/{number}.

function listItem(number: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: number * 1000,
    number,
    state: "closed",
    title: `untrusted list title ${number}`,
    html_url: `https://github.com/rfairburn/pi-review-gate/pull/${number}`,
    ...extra,
  };
}

function detailPr(number: number, mergeCommitSha: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: number * 1000,
    number,
    state: "closed",
    merged: true,
    merged_at: "2026-01-02T00:00:00Z",
    merge_commit_sha: mergeCommitSha,
    base: { ref: "main", sha: mergeCommitSha, repo: { full_name: "rfairburn/pi-review-gate" } },
    ...extra,
  };
}

interface FetchCall {
  url: string;
  method?: string;
  authorization?: string;
}

function makeFetch(
  listItems: unknown[],
  details: Record<number, unknown> = {},
  calls: FetchCall[] = [],
): (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}> {
  return async (url, init) => {
    calls.push({ url, method: init?.method, authorization: init?.headers?.Authorization });
    const path = new URL(url).pathname;
    let match: RegExpMatchArray | null;
    if (/^\/repos\/rfairburn\/pi-review-gate\/commits\/[0-9a-f]{40}\/pulls$/.test(path)) {
      return json(200, listItems);
    }
    if ((match = path.match(/^\/repos\/rfairburn\/pi-review-gate\/pulls\/(\d+)$/))) {
      const detail = details[Number(match[1])];
      if (detail === undefined) return json(404, { message: "Not Found" });
      return json(200, detail);
    }
    return json(404, { message: `unrouted: ${path}` });
  };
}

function json(status: number, body: unknown) {
  return {
    status,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

async function expectRejection(
  promise: Promise<unknown>,
  pattern: RegExp | ((error: Error) => boolean),
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    if (typeof pattern === "function") {
      assert.ok(pattern(error));
    } else {
      assert.match(error.message, pattern);
    }
    return true;
  });
}

test("accepts a merged main PR whose merge commit is exactly the target", async () => {
  const repo = makeRepo();
  try {
    const env = baseEnv({ GITHUB_SHA: repo.mergeCommit });
    const calls: FetchCall[] = [];
    // List-shaped association (merged_at, no merged) + detailed record.
    const result = await eligibilityModule.resolveEligibility({
      env,
      fetchImpl: makeFetch(
        [listItem(7, { merged_at: "2026-01-02T00:00:00Z" })],
        { 7: detailPr(7, repo.mergeCommit) },
        calls,
      ),
      repoRoot: repo.root,
      baseline: repo.baseline,
    });
    assert.equal(result.n, 2); // baseline -> c1 -> merge
    assert.equal(result.tag, "b2");
    assert.equal(result.version, "0.1.0-dev.2");
    assert.equal(result.target, repo.mergeCommit);
    assert.equal(result.baseline, repo.baseline);
    assert.equal(result.prNumber, 7);
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
      `/repos/rfairburn/pi-review-gate/commits/${repo.mergeCommit}/pulls`,
      "/repos/rfairburn/pi-review-gate/pulls/7",
    ]);
    assert.match(calls[0]?.authorization ?? "", /^Bearer test-token$/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("rejects a direct push with no associated pull request", async () => {
  const repo = makeRepo();
  try {
    await expectRejection(
      eligibilityModule.resolveEligibility({ env: baseEnv({ GITHUB_SHA: repo.mergeCommit }), fetchImpl: makeFetch([]), repoRoot: repo.root, baseline: repo.baseline }),
      /no pull request is associated/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("rejects open, unmerged, foreign-base, and sha-mismatched associations", async () => {
  const repo = makeRepo();
  try {
    // List items are list-shaped (no merged); the detailed records carry the
    // authoritative fields that drive each rejection.
    await expectRejection(
      eligibilityModule.resolveEligibility({
        env: baseEnv({ GITHUB_SHA: repo.mergeCommit }),
        fetchImpl: makeFetch(
          [listItem(1), listItem(2), listItem(3), listItem(4), listItem(5)],
          {
            1: detailPr(1, repo.mergeCommit, { state: "open", merged: false, merged_at: null }),
            2: detailPr(2, repo.mergeCommit, { merged: false, merged_at: null }),
            3: detailPr(3, "b".repeat(40)),
            4: detailPr(4, repo.mergeCommit, { base: { ref: "main", sha: repo.mergeCommit, repo: { full_name: "fork/pi-review-gate" } } }),
            5: detailPr(5, repo.mergeCommit, { base: { ref: "develop", sha: repo.mergeCommit, repo: { full_name: "rfairburn/pi-review-gate" } } }),
          },
        ),
        repoRoot: repo.root,
        baseline: repo.baseline,
      }),
      /#1: state "open".*#2: not merged.*#3: merge_commit_sha differs.*#4: base repository mismatch.*#5: base branch is not main/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("rejection messages never leak pull request text", async () => {
  const repo = makeRepo();
  try {
    await expectRejection(
      eligibilityModule.resolveEligibility({
        env: baseEnv({ GITHUB_SHA: repo.mergeCommit }),
        fetchImpl: makeFetch(
          [listItem(9, { title: "secret-list-title-ghp_abcdefghijklmnopqrst" })],
          { 9: detailPr(9, repo.mergeCommit, { merged: false, merged_at: null, title: "secret-title-token", body: "credential leak" }) },
        ),
        repoRoot: repo.root,
        baseline: repo.baseline,
      }),
      (error: Error) => {
        assert.ok(!error.message.includes("secret-title"));
        assert.ok(!error.message.includes("credential leak"));
        assert.ok(!error.message.includes("secret-list-title"));
        return true;
      },
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a list-shaped association alone can never establish eligibility", async () => {
  const repo = makeRepo();
  try {
    // The list item looks merged (merged_at set) but carries no `merged`
    // boolean; the detailed record is the only authority, and it says the PR
    // was closed without merging.
    await expectRejection(
      eligibilityModule.resolveEligibility({
        env: baseEnv({ GITHUB_SHA: repo.mergeCommit }),
        fetchImpl: makeFetch(
          [listItem(4, { merged_at: "2026-01-02T00:00:00Z" })],
          { 4: detailPr(4, repo.mergeCommit, { merged: false, merged_at: null }) },
        ),
        repoRoot: repo.root,
        baseline: repo.baseline,
      }),
      /#4: not merged/,
    );
    // Conversely a list item with no merge information at all is accepted when
    // its detailed record proves the real merge.
    const result = await eligibilityModule.resolveEligibility({
      env: baseEnv({ GITHUB_SHA: repo.mergeCommit }),
      fetchImpl: makeFetch([listItem(6)], { 6: detailPr(6, repo.mergeCommit) }),
      repoRoot: repo.root,
      baseline: repo.baseline,
    });
    assert.equal(result.prNumber, 6);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("unreadable detailed records are rejected without leaking text", async () => {
  const repo = makeRepo();
  try {
    await expectRejection(
      eligibilityModule.resolveEligibility({
        env: baseEnv({ GITHUB_SHA: repo.mergeCommit }),
        // The association exists but the detailed record 404s.
        fetchImpl: makeFetch([listItem(11)]),
        repoRoot: repo.root,
        baseline: repo.baseline,
      }),
      /#11: detailed pull request unreadable/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("multiple real merges at the exact SHA resolve to the lowest PR number deterministically", async () => {
  const repo = makeRepo();
  try {
    const result = await eligibilityModule.resolveEligibility({
      env: baseEnv({ GITHUB_SHA: repo.mergeCommit }),
      fetchImpl: makeFetch(
        [listItem(3), listItem(2)],
        { 2: detailPr(2, repo.mergeCommit), 3: detailPr(3, repo.mergeCommit) },
      ),
      repoRoot: repo.root,
      baseline: repo.baseline,
    });
    assert.equal(result.prNumber, 2);
    assert.deepEqual(result.associatedPullRequests, [2, 3]);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("untrusted event contexts are rejected before any API call", async () => {
  const repo = makeRepo();
  try {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetch([listItem(7)], { 7: detailPr(7, repo.mergeCommit) }, calls);
    const cases: Array<[Record<string, string>, RegExp]> = [
      [baseEnv({ GITHUB_SHA: repo.mergeCommit, GITHUB_EVENT_NAME: "workflow_dispatch" }), /GITHUB_EVENT_NAME/],
      [baseEnv({ GITHUB_SHA: repo.mergeCommit, GITHUB_REF: "refs/heads/develop" }), /GITHUB_REF/],
      [baseEnv({ GITHUB_SHA: repo.mergeCommit, GITHUB_REPOSITORY: "fork/pi-review-gate" }), /GITHUB_REPOSITORY/],
      [baseEnv({ GITHUB_SHA: "not-a-sha" }), /GITHUB_SHA/],
      [baseEnv({ GITHUB_SHA: repo.mergeCommit, GITHUB_REF_TYPE: "tag" }), /GITHUB_REF_TYPE/],
    ];
    for (const [env, pattern] of cases) {
      await expectRejection(eligibilityModule.resolveEligibility({ env, fetchImpl, repoRoot: repo.root }), pattern);
    }
    assert.equal(calls.length, 0, "no API request may be made for rejected contexts");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("later main advances do not change the numbered identity of the pinned target", async () => {
  const repo = makeRepo();
  try {
    // Advance main beyond the target: the pinned event SHA keeps its identity.
    const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const newer = execFileSync(
      "git",
      ["-C", repo.root, "commit-tree", tree, "-m", "later advance", "-p", repo.mergeCommit],
      { encoding: "utf8" },
    ).trim();
    git(repo.root, "update-ref", "refs/heads/main", newer);
    const result = await eligibilityModule.resolveEligibility({
      env: baseEnv({ GITHUB_SHA: repo.mergeCommit }),
      fetchImpl: makeFetch([listItem(7, { merged_at: "2026-01-02T00:00:00Z" })], { 7: detailPr(7, repo.mergeCommit) }),
      repoRoot: repo.root,
      baseline: repo.baseline,
    });
    assert.equal(result.n, 2);
    assert.equal(result.tag, "b2");
    assert.equal(result.target, repo.mergeCommit);
    assert.notEqual(result.target, newer);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a side-branch-only target is rejected even with a real merge association", async () => {
  // baseline -> c1 (main) with `side` forked off c1: `side`'s own first-parent
  // line reaches the baseline (numbering would pass), but it is not on main's
  // first-parent history, so the local ancestry gate must reject it before any
  // API call even though a plausible merge association is offered.
  const root = mkdtempSync(join(tmpdir(), "release-eligibility-side-"));
  try {
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
    const calls: FetchCall[] = [];
    await expectRejection(
      eligibilityModule.resolveEligibility({
        env: baseEnv({ GITHUB_SHA: side }),
        fetchImpl: makeFetch([listItem(8, { merged_at: "2026-01-02T00:00:00Z" })], { 8: detailPr(8, side) }, calls),
        repoRoot: root,
        baseline,
      }),
      /not on the first-parent history of main/,
    );
    assert.equal(calls.length, 0, "the local ancestry gate runs before any API request");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a target removed from main by a history rewrite is rejected", async () => {
  // The merge commit was once on main and has a real merged PR; a later
  // force-push rewrite removes it from main's first-parent line. Its own line
  // still reaches the baseline, so only the current-main check can catch it.
  const repo = makeRepo();
  try {
    // Build the rewrite directly on top of c1 (the first main commit), which
    // drops the old merge from main's first-parent line.
    const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const c1 = git(repo.root, "rev-parse", `${repo.mergeCommit}^`);
    const rewritten = execFileSync(
      "git",
      ["-C", repo.root, "commit-tree", tree, "-m", "rewritten tip", "-p", c1],
      { encoding: "utf8" },
    ).trim();
    git(repo.root, "update-ref", "refs/heads/main", rewritten);
    const calls: FetchCall[] = [];
    await expectRejection(
      eligibilityModule.resolveEligibility({
        env: baseEnv({ GITHUB_SHA: repo.mergeCommit }),
        fetchImpl: makeFetch([listItem(7, { merged_at: "2026-01-02T00:00:00Z" })], { 7: detailPr(7, repo.mergeCommit) }, calls),
        repoRoot: repo.root,
        baseline: repo.baseline,
      }),
      /not on the first-parent history of main/,
    );
    assert.equal(calls.length, 0, "the local ancestry gate runs before any API request");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a direct first-parent child of the baseline numbers as b1 (owned synthetic fixture)", async () => {
  // Prove the baseline -> direct child numbering and eligibility behavior
  // without requiring production Git objects in portable or shallow checkouts.
  // Publication independently verifies the actual target's ancestry.
  assert.equal(common.BASELINE_SHA, "f7c174f1c12c81447bce2ab1aa39fb5faf4331ec");
  const repo = makeRepo();
  try {
    // c1 is the direct first-parent child of the synthetic baseline (first
    // parent of the merge tip).
    const c1 = git(repo.root, "rev-parse", `${repo.mergeCommit}^`);
    const distance = numberingModule.firstParentDistance({
      repoRoot: repo.root,
      target: c1,
      baseline: repo.baseline,
    });
    assert.equal(distance.n, 1);
    assert.equal(distance.target, c1);
    assert.equal(distance.baseline, repo.baseline);
    // The same history shape through the full production eligibility path.
    const result = await eligibilityModule.resolveEligibility({
      env: baseEnv({ GITHUB_SHA: c1 }),
      fetchImpl: makeFetch([listItem(3, { merged_at: "2026-01-02T00:00:00Z" })], { 3: detailPr(3, c1) }),
      repoRoot: repo.root,
      baseline: repo.baseline,
    });
    assert.equal(result.n, 1);
    assert.equal(result.tag, "b1");
    assert.equal(result.version, "0.1.0-dev.1");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("GITHUB_OUTPUT summary carries only deterministic identity fields", async () => {
  const repo = makeRepo();
  try {
    const result = await eligibilityModule.resolveEligibility({
      env: baseEnv({ GITHUB_SHA: repo.mergeCommit }),
      fetchImpl: makeFetch([listItem(7, { merged_at: "2026-01-02T00:00:00Z" })], { 7: detailPr(7, repo.mergeCommit) }),
      repoRoot: repo.root,
      baseline: repo.baseline,
    });
    const summary = eligibilityModule.summarizeGITHUBOutput(result);
    assert.equal(summary, `n=2\ntag=b2\nversion=0.1.0-dev.2\ntarget=${repo.mergeCommit}\nbaseline=${repo.baseline}\npr=7\n`);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
