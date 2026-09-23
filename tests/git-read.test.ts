/**
 * GitRead (#73): structured read-only Git research with indexed navigation.
 *
 * Tests run against real disposable Git repositories created in the system
 * temp directory (outside the repository under test) and removed afterwards.
 * They cover: linear+merge log paging, moved-HEAD pinning, path-filter rename
 * follow, all-files diff inventory + hunk pages, binary/huge data, blame,
 * invalid arguments, hostile repo config/attributes/environment, limits and
 * snapshot expiry, and no-repository-mutation.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { GIT_READ_LIMITS, GitReadEngine } from "../src/git-read/engine";
import { GIT_READ_TOOL_NAME, registerGitReadTool, type GitReadHost } from "../src/git-read/tool";

// ---------------------------------------------------------------------------
// Fixture: disposable repository in the system temp dir (outside target)
// ---------------------------------------------------------------------------

const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  // Keep the fixture's own status calls from rewriting .git/index so the
  // no-mutation hash comparison stays exact.
  GIT_OPTIONAL_LOCKS: "0",
};

interface Fixture {
  root: string;
  git(...args: string[]): string;
  sha(): string;
  commit(message: string, files?: Record<string, string>, options?: { branch?: string }): string;
}

function makeFixture(name: string): Fixture {
  // Resolve symlinks (e.g. macOS /var → /private/var) so fixture paths compare
  // equal to what `git rev-parse --show-toplevel` reports.
  const root = realpathSync(mkdtempSync(join(tmpdir(), `gitread-${name}-`)));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: FIXTURE_ENV }).trim();

  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  return {
    root,
    git,
    sha: () => git("rev-parse", "HEAD"),
    commit(message, files = {}, options = {}) {
      if (options.branch) git("checkout", "-q", "-b", options.branch);
      for (const [path, content] of Object.entries(files)) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      git("add", "-A");
      git("commit", "-q", "-m", message, "--allow-empty");
      return git("rev-parse", "HEAD");
    },
  };
}

function withFixture<T>(name: string, fn: (fx: Fixture) => Promise<T> | T): Promise<T> {
  const fx = makeFixture(name);
  return Promise.resolve()
    .then(() => fn(fx))
    .finally(() => rmSync(fx.root, { recursive: true, force: true }));
}

function engineFor(fx: Fixture, options: Record<string, unknown> = {}): GitReadEngine {
  return new GitReadEngine({ cwd: () => fx.root, timeoutMs: 30_000, ...options });
}

interface ToolResult {
  text: string;
  details: Record<string, unknown>;
  isError: boolean;
}

function detailsOf(result: ToolResult): Record<string, any> {
  return result.details;
}

// ---------------------------------------------------------------------------
// Registration contract
// ---------------------------------------------------------------------------

test("registerGitReadTool registers exactly one tool named GitRead", () => {
  const registered: Array<Record<string, unknown>> = [];
  const host = { registerTool: (tool: Record<string, unknown>) => registered.push(tool) };
  assert.equal(registerGitReadTool(host, () => process.cwd()), true);
  assert.equal(registered.length, 1);
  const tool = registered[0]!;
  assert.equal(tool.name, GIT_READ_TOOL_NAME);
  assert.equal(tool.label, GIT_READ_TOOL_NAME);
  assert.equal(typeof tool.execute, "function");
  assert.equal(typeof tool.description, "string");
  assert.ok((tool.description as string).includes("log"));
  const parameters = tool.parameters as Record<string, any>;
  assert.equal(parameters.type, "object");
  assert.deepEqual(parameters.required, ["action"]);
  assert.equal(parameters.additionalProperties, false);
  const actions = parameters.properties.action.enum as string[];
  for (const action of ["log", "show", "diff", "blame", "refs", "mergeBase", "listFiles", "readFile", "search", "status"]) {
    assert.ok(actions.includes(action), `schema lists ${action}`);
  }
  // A host without registerTool registers nothing and reports false.
  assert.equal(registerGitReadTool({} as unknown as GitReadHost, () => process.cwd()), false);
});

// ---------------------------------------------------------------------------
// log: linear + merge history, paging, filters
// ---------------------------------------------------------------------------

test("log pages a linear+merge history completely without duplicates", async () => {
  await withFixture("log-merge", async (fx) => {
    const c1 = fx.commit("one", { "a.txt": "1\n" });
    const c2 = fx.commit("two", { "a.txt": "1\n2\n" });
    const b1 = fx.commit("side one", { "s.txt": "s1\n" }, { branch: "side" });
    const b2 = fx.commit("side two", { "s.txt": "s1\ns2\n" });
    fx.git("checkout", "-q", "main");
    fx.git("merge", "-q", "--no-ff", "side", "-m", "merge side");
    const merge = fx.sha();

    const engine = engineFor(fx);
    const first = await engine.execute({ action: "log", rev: "HEAD", limit: 10, maxChars: 600 });
    assert.equal(first.isError, false, first.text);
    const d = detailsOf(first);
    assert.equal(d.totalCommits, 5);
    assert.equal(d.acquiredEntries, 5);
    assert.equal(typeof d.snapshotId, "string");
    assert.equal((d.pinned as any).rev, merge);

    // Page through with the snapshot until exhausted.
    const all = (detailsOf(first).entries as any[]).map((entry) => entry.sha);
    let next = detailsOf(first).nextIndex as number | null;
    while (next !== null) {
      const page = await engine.execute({ action: "log", snapshotId: d.snapshotId, index: next, maxChars: 600 });
      assert.equal(page.isError, false, page.text);
      const pd = detailsOf(page);
      for (const entry of pd.entries as any[]) all.push(entry.sha);
      next = pd.nextIndex as number | null;
    }
    // First page entries plus continuation entries cover all 5 exactly once.
    assert.equal(all.length, 5);
    assert.equal(new Set(all).size, 5);
    for (const sha of [c1, c2, b1, b2, merge]) assert.ok(all.includes(sha), `saw ${sha}`);
    // Newest first: the merge commit is entry 0.
    assert.equal((detailsOf(first).entries as any[])[0]!.sha, merge);
  });
});

test("log first-parent and from..to ranges respect merge topology", async () => {
  await withFixture("log-range", async (fx) => {
    const m1 = fx.commit("m1", { "x.txt": "x\n" });
    const s1 = fx.commit("s1", { "y.txt": "y\n" }, { branch: "side" });
    fx.git("checkout", "-q", "main");
    fx.git("merge", "-q", "--no-ff", "side", "-m", "merge");
    const merge = fx.sha();

    const engine = engineFor(fx);
    const firstParent = await engine.execute({ action: "log", rev: "HEAD", firstParent: true, limit: 20 });
    assert.equal(firstParent.isError, false, firstParent.text);
    const fpShas = (detailsOf(firstParent).entries as any[]).map((entry) => entry.sha);
    assert.ok(fpShas.includes(merge));
    assert.ok(!fpShas.includes(s1), "side-branch commit excluded from first-parent walk");

    const range = await engine.execute({ action: "log", from: m1, to: merge, limit: 20 });
    assert.equal(range.isError, false, range.text);
    const rangeShas = (detailsOf(range).entries as any[]).map((entry) => entry.sha);
    assert.ok(rangeShas.includes(s1));
    assert.ok(!rangeShas.includes(m1), "from..to excludes the from commit itself");
  });
});

test("log find locates entries inside a pinned snapshot", async () => {
  await withFixture("log-find", async (fx) => {
    fx.commit("alpha parser fix", { "a.txt": "1\n" });
    fx.commit("beta network fix", { "b.txt": "2\n" });
    fx.commit("gamma docs", { "c.md": "# d\n" });

    const engine = engineFor(fx);
    const found = await engine.execute({ action: "log", rev: "HEAD", find: "network" });
    assert.equal(found.isError, false, found.text);
    const d = detailsOf(found);
    assert.equal(d.matches.length, 1);
    assert.equal(d.matches[0]!.index, 1); // newest first: gamma=0, beta=1, alpha=2

    const page = await engine.execute({ action: "log", snapshotId: d.snapshotId, index: 1 });
    assert.equal(page.isError, false, page.text);
    assert.equal((detailsOf(page).entries as any[])[0]!.subject, "beta network fix");
  });
});

// ---------------------------------------------------------------------------
// moved HEAD: continuations must not re-resolve
// ---------------------------------------------------------------------------

test("log continuation over a snapshot ignores a moved HEAD", async () => {
  await withFixture("moved-head", async (fx) => {
    fx.commit("first", { "a.txt": "1\n" });
    fx.commit("second", { "b.txt": "2\n" });
    const headAtAcquisition = fx.sha();

    const engine = engineFor(fx);
    const first = await engine.execute({ action: "log", rev: "HEAD", limit: 5, maxChars: 600 });
    assert.equal(first.isError, false, first.text);
    const d = detailsOf(first);
    assert.equal((d.pinned as any).rev, headAtAcquisition);

    // HEAD moves after acquisition.
    fx.commit("third", { "c.txt": "3\n" });
    assert.notEqual(fx.sha(), headAtAcquisition);

    // Continuation is served from the pinned snapshot: no new commit appears.
    const index = (d.nextIndex as number | null) ?? 0;
    const page = await engine.execute({ action: "log", snapshotId: d.snapshotId, index });
    assert.equal(page.isError, false, page.text);
    const pagedShas = (detailsOf(page).entries as any[]).map((entry) => entry.sha);
    for (const sha of pagedShas) assert.notEqual(sha, fx.sha(), "new commit must not leak into the pinned snapshot");

    // find over the same snapshot also cannot see the new commit.
    const found = await engine.execute({ action: "log", snapshotId: d.snapshotId, find: "third" });
    assert.equal(found.isError, false, found.text);
    assert.equal((detailsOf(found).matches as unknown[]).length, 0);

    // A fresh acquisition does see the new commit (honest re-acquisition).
    const fresh = await engine.execute({ action: "log", rev: "HEAD" });
    assert.equal(fresh.isError, false, fresh.text);
    assert.ok((detailsOf(fresh).entries as any[]).some((entry) => entry.sha === fx.sha()));
  });
});

test("identical re-acquisition after a moved HEAD gets a distinct snapshot and the old one stays pinned", async () => {
  await withFixture("reacquire", async (fx) => {
    for (const msg of ["one", "two", "three", "four"]) fx.commit(msg, { [`${msg}.txt`]: "x\n" });
    const engine = engineFor(fx);
    const first = await engine.execute({ action: "log", rev: "HEAD", limit: 50, maxChars: 600 });
    assert.equal(first.isError, false, first.text);
    const firstId = detailsOf(first).snapshotId as string;
    const firstPinned = (detailsOf(first).pinned as any).rev as string;
    assert.match(firstPinned, /^[0-9a-f]{40}$/);

    // HEAD moves, then the byte-identical query is re-run.
    fx.commit("five", { "five.txt": "x\n" });
    const again = await engine.execute({ action: "log", rev: "HEAD", limit: 50, maxChars: 600 });
    assert.equal(again.isError, false, again.text);
    const againId = detailsOf(again).snapshotId as string;
    assert.notEqual(againId, firstId, "identical query after HEAD moved must mint a distinct snapshot id");
    assert.equal((detailsOf(again).pinned as any).rev, fx.sha());
    assert.notEqual((detailsOf(again).pinned as any).rev, firstPinned);
    assert.ok((detailsOf(again).entries as any[]).some((entry) => entry.sha === fx.sha()), "new snapshot serves the new HEAD");

    // The old snapshot was NOT overwritten: its continuations still serve the
    // pinned acquisition, page after page, until expiry.
    let index: number | null = 0;
    const oldShas: string[] = [];
    let guard = 0;
    for (;;) {
      const page = await engine.execute({ action: "log", snapshotId: firstId, index, maxChars: 600 });
      assert.equal(page.isError, false, page.text);
      for (const entry of detailsOf(page).entries as any[]) oldShas.push(entry.sha);
      index = detailsOf(page).nextIndex as number | null;
      if (index === null || guard > 50) break;
      guard += 1;
    }
    assert.equal(oldShas.length, 4, "old snapshot still holds exactly its acquisition-time entries");
    assert.ok(oldShas.includes(firstPinned));
    assert.ok(!oldShas.includes(fx.sha()), "post-acquisition commit never leaks into the old snapshot");

    // Same identity guarantee for refs: the ref list changes at the SAME HEAD,
    // so no pinned sha can distinguish the acquisitions — the counter must.
    const refsBefore = await engine.execute({ action: "refs", maxChars: 20_000 });
    assert.equal(refsBefore.isError, false, refsBefore.text);
    const refsBeforeId = detailsOf(refsBefore).snapshotId as string;
    fx.git("branch", "late-branch");
    const refsAfter = await engine.execute({ action: "refs", maxChars: 20_000 });
    assert.equal(refsAfter.isError, false, refsAfter.text);
    assert.notEqual(detailsOf(refsAfter).snapshotId, refsBeforeId, "re-acquired refs at the same HEAD get a distinct snapshot id");
    const beforeNames = ((await engine.execute({ action: "refs", snapshotId: refsBeforeId, index: 0, maxChars: 20_000 })).details as any).refs
      .map((ref: any) => ref.refname);
    assert.ok(!beforeNames.includes("refs/heads/late-branch"), "old refs snapshot keeps its acquired ref list");
    assert.ok(
      ((detailsOf(refsAfter).refs as any[]).map((ref) => ref.refname)).includes("refs/heads/late-branch"),
      "new refs snapshot sees the new branch",
    );
  });
});

// ---------------------------------------------------------------------------
// path filters and rename follow
// ---------------------------------------------------------------------------

test("log path filter without follow vs with follow across a rename", async () => {
  await withFixture("rename-follow", async (fx) => {
    const c1 = fx.commit("c1", { "a.txt": "v1\n" });
    const c2 = fx.commit("c2", { "a.txt": "v2\n" });
    fx.git("mv", "a.txt", "b.txt");
    fx.git("add", "-A");
    const c3 = fx.commit("c3 rename", {});
    const c4 = fx.commit("c4", { "b.txt": "v4\n" });

    const engine = engineFor(fx);
    const oldPath = await engine.execute({ action: "log", rev: "HEAD", paths: ["a.txt"], limit: 20 });
    assert.equal(oldPath.isError, false, oldPath.text);
    const oldShas = (detailsOf(oldPath).entries as any[]).map((entry) => entry.sha);
    assert.ok(oldShas.includes(c1) && oldShas.includes(c2));
    assert.ok(!oldShas.includes(c4), "post-rename work on the new name is not in the old-path history");

    const followed = await engine.execute({ action: "log", rev: "HEAD", paths: ["b.txt"], follow: true, limit: 20 });
    assert.equal(followed.isError, false, followed.text);
    const followedShas = (detailsOf(followed).entries as any[]).map((entry) => entry.sha);
    for (const sha of [c1, c2, c3, c4]) assert.ok(followedShas.includes(sha), `follow saw ${sha}`);

    const noFollow = await engine.execute({ action: "log", rev: "HEAD", paths: ["b.txt"], limit: 20 });
    const noFollowShas = (detailsOf(noFollow).entries as any[]).map((entry) => entry.sha);
    assert.ok(!noFollowShas.includes(c1), "without follow the pre-rename history is absent");
  });
});

test("log filters: author, message (literal), since/until, pickaxe", async () => {
  await withFixture("log-filters", async (fx) => {
    fx.git("config", "user.email", "alice@example.com");
    const a1 = fx.commit("add widget", { "w.txt": "widget v1\n" });
    fx.git("config", "user.email", "bob@example.com");
    fx.commit("tweak widget", { "w.txt": "widget v2\n" });
    fx.git("config", "user.email", "alice@example.com");
    const a2 = fx.commit("remove widget word", { "w.txt": "gadget\n" });

    const engine = engineFor(fx);
    const byAuthor = await engine.execute({ action: "log", rev: "HEAD", author: "alice", limit: 20 });
    const authorShas = (detailsOf(byAuthor).entries as any[]).map((entry) => entry.sha);
    assert.deepEqual(authorShas, [a2, a1]);

    // message is a literal fixed-string match: regex metacharacters are not special.
    const byMessage = await engine.execute({ action: "log", rev: "HEAD", message: "widget (v", limit: 20 });
    assert.equal(byMessage.isError, false, byMessage.text);
    assert.equal((detailsOf(byMessage).entries as any[]).length, 0, "literal match of a non-matching fragment");

    const pickaxe = await engine.execute({ action: "log", rev: "HEAD", pickaxe: "widget", limit: 20 });
    const pickShas = (detailsOf(pickaxe).entries as any[]).map((entry) => entry.sha);
    assert.ok(pickShas.includes(a1) && pickShas.includes(a2), "pickaxe sees add and remove of the string");

    // author is a regex (git --author; git's default is a POSIX basic regexp),
    // not a literal substring: '.' matches any char in BRE too.
    const byAuthorRegex = await engine.execute({ action: "log", rev: "HEAD", author: "al.ce", limit: 20 });
    assert.equal(byAuthorRegex.isError, false, byAuthorRegex.text);
    assert.equal((detailsOf(byAuthorRegex).entries as any[]).length, 2, "BRE 'al.ce' matches 'alice'");

    // When message is also set the engine passes git --fixed-strings, which
    // makes the limiting patterns (including author) literal: 'al.ce' then no
    // longer matches 'alice'. Pinned so the schema caveat stays true.
    const byAuthorLiteral = await engine.execute({ action: "log", rev: "HEAD", author: "al.ce", message: "widget", limit: 20 });
    assert.equal(byAuthorLiteral.isError, false, byAuthorLiteral.text);
    assert.equal((detailsOf(byAuthorLiteral).entries as any[]).length, 0, "author is literal when message is also set");

    // since in the future yields nothing (year kept below ~2038: git's date
    // parser silently drops dates beyond int32 range, which would skip the filter).
    const none = await engine.execute({ action: "log", rev: "HEAD", since: "2027-01-01" });
    assert.equal(none.isError, false, none.text);
    assert.equal((detailsOf(none).entries as any[]).length, 0);
  });
});

// ---------------------------------------------------------------------------
// diff: inventory + targeted patch pages
// ---------------------------------------------------------------------------

test("diff inventories all affected files with statuses and stats", async () => {
  await withFixture("diff-inventory", async (fx) => {
    const from = fx.commit("base", {
      "keep.txt": "k\n",
      "mod.txt": "m1\nm2\n",
      "del.txt": "d\n",
      "old.txt": "x\n",
      // Enough common lines that the rename survives git's 50% similarity
      // threshold after a single-line modification.
      "old-name.txt": "o1\no2\no3\no4\no5\no6\no7\no8\n",
      // A committed pathname containing a tab: -z output emits it verbatim,
      // so numstat parsing must key stats by the full path, not a prefix.
      "tab\tname.txt": "t1\nt2\n",
    });
    writeFileSync(join(fx.root, "bin.dat"), Buffer.from([0, 1, 2, 255, 0]));
    fx.git("rm", "-q", "del.txt");
    fx.git("mv", "old-name.txt", "new-name.txt");
    // Rename to a status-shaped new name: the parser must branch on the
    // record type (R = two paths), not on whether the next token looks like
    // a status code.
    fx.git("mv", "old.txt", "A");
    fx.commit("changed", {
      // Modified after the status-shaped rename so a misparse that drops or
      // re-keys later records is caught.
      "keep.txt": "k2\n",
      "mod.txt": "m1\nM2\nM3\n",
      "add.md": "# new\n",
      // Modify one line of the renamed file so numstat reports non-zero
      // added/removed on the rename record (old → new path pair).
      "new-name.txt": "o1\nO2\no3\no4\no5\no6\no7\no8\n",
      "tab\tname.txt": "t1\nT2\n",
    });
    const to = fx.sha();

    const engine = engineFor(fx);
    const result = await engine.execute({ action: "diff", from, to, maxChars: 20_000 });
    assert.equal(result.isError, false, result.text);
    const d = detailsOf(result);
    assert.equal((d.pinned as any).from, from);
    assert.equal((d.pinned as any).to, to);
    const files = d.files as any[];
    const byPath = new Map(files.map((file) => [file.path, file]));

    assert.equal(byPath.get("mod.txt")!.status, "M");
    assert.equal(byPath.get("mod.txt")!.added, 2);
    assert.equal(byPath.get("mod.txt")!.removed, 1);
    // Status-shaped rename: new path is "A", old path preserved.
    const statusShaped = byPath.get("A")!;
    assert.match(statusShaped.status, /^R\d+$/);
    assert.equal(statusShaped.oldPath, "old.txt");
    // The entry after the rename record must survive parsing intact.
    assert.equal(byPath.get("keep.txt")!.status, "M");
    assert.equal(byPath.get("add.md")!.status, "A");
    const deleted = byPath.get("del.txt");
    assert.equal(deleted.status, "D");
    const renamed = byPath.get("new-name.txt")!;
    assert.match(renamed.status, /^R\d+$/);
    assert.equal(renamed.oldPath, "old-name.txt");
    // The numstat rename record (added/removed keyed old→new) must be joined
    // into the inventory entry.
    assert.equal(renamed.added, 1);
    assert.equal(renamed.removed, 1);
    const binary = byPath.get("bin.dat")!;
    assert.equal(binary.binary, true);
    assert.equal(binary.added, null);
    // The tab-named file must keep its full path and real counts (a
    // prefix-keyed lookup would render it as +? −?).
    const tabbed = byPath.get("tab\tname.txt")!;
    assert.equal(tabbed.status, "M");
    assert.equal(tabbed.added, 1);
    assert.equal(tabbed.removed, 1);
    assert.equal((d.inventoryTruncated as boolean), false);

    // Targeted patch page for one file, with hunk metadata and paging.
    const patch = await engine.execute({ action: "diff", from, to, file: "mod.txt", maxChars: 600 });
    assert.equal(patch.isError, false, patch.text);
    assert.ok(patch.text.includes("@@"), "patch page contains hunk headers");
    assert.ok(patch.text.includes("+M2"), "patch page contains added lines");
    const pd = detailsOf(patch);
    assert.ok(Array.isArray(pd.hunks) && (pd.hunks as any[]).length >= 1);
    if (pd.nextIndex !== null) {
      const rest = await engine.execute({ action: "diff", from, to, file: "mod.txt", index: pd.nextIndex, maxChars: 20_000 });
      assert.equal(rest.isError, false, rest.text);
      assert.ok((detailsOf(rest).nextIndex as number | null) === null || (detailsOf(rest).patchLinesReturned as number) >= 0);
    }
  });
});

test("diff rejects missing revisions and unknown paths", async () => {
  await withFixture("diff-invalid", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    fx.commit("two", { "a.txt": "2\n" });
    const engine = engineFor(fx);
    const missingTo = await engine.execute({ action: "diff", from: "HEAD" });
    assert.equal(missingTo.isError, true);
    assert.match(missingTo.text, /requires both from and to/);

    const badPath = await engine.execute({ action: "diff", from: "HEAD~1", to: "HEAD", file: "nope.txt" });
    assert.equal(badPath.isError, true);
    assert.match(badPath.text, /not present in either revision/);
  });
});

// ---------------------------------------------------------------------------
// show: metadata, merge semantics, root commits, file patches
// ---------------------------------------------------------------------------

test("show reports metadata and discloses merge parent basis", async () => {
  await withFixture("show-merge", async (fx) => {
    fx.commit("base", { "a.txt": "1\n" });
    const side = fx.commit("side work", { "s.txt": "s\n" }, { branch: "side" });
    fx.git("checkout", "-q", "main");
    fx.commit("main work", { "m.txt": "m\n" });
    fx.git("merge", "-q", "--no-ff", "side", "-m", "merge side");
    const merge = fx.sha();

    const engine = engineFor(fx);
    const shown = await engine.execute({ action: "show", rev: merge });
    assert.equal(shown.isError, false, shown.text);
    const d = detailsOf(shown);
    assert.deepEqual((d.commit as any).parents, [fx.git("rev-parse", `${merge}^1`), side]);
    assert.match(d.diffBasis.note as string, /merge commit with 2 parents/);
    assert.equal((d.diffBasis as any).base, fx.git("rev-parse", `${merge}^1`));

    // First-parent inventory contains only the side file addition.
    const firstParentFiles = (d.files as any[]).map((file) => file.path);
    assert.deepEqual(firstParentFiles, ["s.txt"]);

    // Selecting parent 2 diffs against the side branch: main's m.txt appears.
    const parentTwo = await engine.execute({ action: "show", rev: merge, parent: 2 });
    assert.equal(parentTwo.isError, false, parentTwo.text);
    const p2Files = (detailsOf(parentTwo).files as any[]).map((file) => file.path);
    assert.deepEqual(p2Files, ["m.txt"]);

    // Out-of-range parent fails with an actionable error.
    const badParent = await engine.execute({ action: "show", rev: merge, parent: 3 });
    assert.equal(badParent.isError, true);
    assert.match(badParent.text, /has 2 parent/);
  });
});

test("show on a root commit diffs against the empty tree", async () => {
  await withFixture("show-root", async (fx) => {
    const root = fx.commit("root", { "a.txt": "1\n", "b.txt": "2\n" });
    const engine = engineFor(fx);
    const shown = await engine.execute({ action: "show", rev: root });
    assert.equal(shown.isError, false, shown.text);
    const d = detailsOf(shown);
    assert.match(d.diffBasis.note as string, /root commit/);
    const files = (d.files as any[]).map((file) => [file.path, file.status] as const);
    assert.deepEqual(files.sort(), [["a.txt", "A"], ["b.txt", "A"]]);

    // Targeted patch view of one file in the root commit.
    const patch = await engine.execute({ action: "show", rev: root, file: "a.txt" });
    assert.equal(patch.isError, false, patch.text);
    assert.ok(patch.text.includes("+1"), "root-commit patch shows the added line");
  });
});

// ---------------------------------------------------------------------------
// blame
// ---------------------------------------------------------------------------

test("blame attributes lines to the right commits and pages windows", async () => {
  await withFixture("blame", async (fx) => {
    const c1 = fx.commit("c1", { "f.txt": "l1\nl2\nl3\nl4\nl5\n" });
    const c2 = fx.commit("c2", { "f.txt": "l1\nl2\nL3\nl4\nl5\nl6\nl7\n" });
    const c3 = fx.commit("c3", { "f.txt": "L1\nl2\nL3\nl4\nl5\nl6\nl7\n" });

    const engine = engineFor(fx);
    const result = await engine.execute({ action: "blame", rev: "HEAD", path: "f.txt" });
    assert.equal(result.isError, false, result.text);
    const d = detailsOf(result);
    const ranges = d.ranges as any[];
    const ownerOf = (line: number): string => ranges.find((range) => line >= range.startLine && line <= range.endLine)?.commit;
    assert.equal(ownerOf(1), c3);
    assert.equal(ownerOf(2), c1);
    assert.equal(ownerOf(3), c2);
    assert.equal(ownerOf(7), c2);
    assert.equal(d.nextIndex, null, "small file fully blamed in one window");

    // Explicit window. A bounded window must NOT advertise a continuation:
    // the requested window is the whole query, and index > endLine is rejected.
    const windowed = await engine.execute({ action: "blame", rev: "HEAD", path: "f.txt", startLine: 2, endLine: 3 });
    assert.equal(windowed.isError, false, windowed.text);
    assert.deepEqual((detailsOf(windowed).window as any), [2, 3]);
    assert.equal(detailsOf(windowed).nextIndex, null, "bounded window must not advertise nextIndex");

    // Large file: window cap forces continuation.
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    fx.commit("big", { "big.txt": big });
    const firstWindow = await engine.execute({ action: "blame", rev: "HEAD", path: "big.txt" });
    assert.equal(firstWindow.isError, false, firstWindow.text);
    const fd = detailsOf(firstWindow);
    assert.deepEqual(fd.window, [1, GIT_READ_LIMITS.blameMaxLinesPerCall]);
    assert.equal(fd.nextIndex, GIT_READ_LIMITS.blameMaxLinesPerCall);
    // Continuation must use the pinned SHA (symbolic specs are rejected for
    // index > 0 so a moved HEAD cannot blend pages from two revisions).
    const rest = await engine.execute({ action: "blame", rev: (fd.pinned as any).rev, path: "big.txt", index: fd.nextIndex });
    assert.equal(rest.isError, false, rest.text);
    assert.deepEqual(detailsOf(rest).window, [GIT_READ_LIMITS.blameMaxLinesPerCall + 1, 2500]);
    assert.equal(detailsOf(rest).nextIndex, null);

    // Symbolic spec on a continuation page is rejected explicitly.
    const symbolic = await engine.execute({ action: "blame", rev: "HEAD", path: "big.txt", index: fd.nextIndex });
    assert.equal(symbolic.isError, true);
    assert.match(symbolic.text, /full 40-hex pinned revision/);

    // Exact-multiple-of-window file: the continuation window starts past EOF.
    // git reports `has only N lines`; that is a clean end-of-file, not an error.
    const exact = Array.from({ length: GIT_READ_LIMITS.blameMaxLinesPerCall }, (_, i) => `x${i + 1}`).join("\n") + "\n";
    fx.commit("exact", { "exact.txt": exact });
    const firstExact = await engine.execute({ action: "blame", rev: "HEAD", path: "exact.txt" });
    assert.equal(firstExact.isError, false, firstExact.text);
    const fed = detailsOf(firstExact);
    assert.equal(fed.nextIndex, GIT_READ_LIMITS.blameMaxLinesPerCall);
    const pastEof = await engine.execute({ action: "blame", rev: (fed.pinned as any).rev, path: "exact.txt", index: fed.nextIndex });
    assert.equal(pastEof.isError, false, pastEof.text);
    assert.match(pastEof.text, /past end of file/);
    assert.equal(detailsOf(pastEof).nextIndex, null);

    // A bounded window larger than the per-call cap must page through the
    // requested tail instead of claiming end of file at the cap boundary.
    const long = Array.from({ length: 4500 }, (_, i) => `y${i + 1}`).join("\n") + "\n";
    fx.commit("long", { "long.txt": long });
    const bounded = await engine.execute({ action: "blame", rev: "HEAD", path: "long.txt", startLine: 1, endLine: 4500 });
    assert.equal(bounded.isError, false, bounded.text);
    assert.deepEqual((detailsOf(bounded).window as any), [1, GIT_READ_LIMITS.blameMaxLinesPerCall]);
    assert.equal(detailsOf(bounded).nextIndex, GIT_READ_LIMITS.blameMaxLinesPerCall);
    const boundedRev = (detailsOf(bounded).pinned as any).rev as string;
    const middle = await engine.execute({ action: "blame", rev: boundedRev, path: "long.txt", startLine: 1, endLine: 4500, index: detailsOf(bounded).nextIndex });
    assert.equal(middle.isError, false, middle.text);
    assert.deepEqual((detailsOf(middle).window as any), [GIT_READ_LIMITS.blameMaxLinesPerCall + 1, 2 * GIT_READ_LIMITS.blameMaxLinesPerCall]);
    assert.equal(detailsOf(middle).nextIndex, 2 * GIT_READ_LIMITS.blameMaxLinesPerCall);
    const boundedTail = await engine.execute({ action: "blame", rev: boundedRev, path: "long.txt", startLine: 1, endLine: 4500, index: detailsOf(middle).nextIndex });
    assert.equal(boundedTail.isError, false, boundedTail.text);
    assert.deepEqual((detailsOf(boundedTail).window as any), [2 * GIT_READ_LIMITS.blameMaxLinesPerCall + 1, 4500]);
    assert.equal(detailsOf(boundedTail).nextIndex, null);

    void c1; void c2;
  });
});

// ---------------------------------------------------------------------------
// refs / mergeBase / listFiles / readFile / search
// ---------------------------------------------------------------------------

test("refs lists refs with full ids and supports pattern filters", async () => {
  await withFixture("refs", async (fx) => {
    const head = fx.commit("one", { "a.txt": "1\n" });
    fx.git("tag", "-a", "v1", "-m", "v1"); // annotated tag: has a peelable tag object
    fx.git("branch", "feature");

    const engine = engineFor(fx);
    const all = await engine.execute({ action: "refs" });
    assert.equal(all.isError, false, all.text);
    const refs = (detailsOf(all).refs as any[]);
    const main = refs.find((ref) => ref.refname === "refs/heads/main");
    assert.ok(main);
    assert.equal(main.sha, head);
    assert.ok(refs.some((ref) => ref.refname === "refs/tags/v1" && ref.peeledSha === head));

    const heads = await engine.execute({ action: "refs", pattern: "refs/heads/*" });
    const headRefs = (detailsOf(heads).refs as any[]);
    assert.ok(headRefs.every((ref) => ref.refname.startsWith("refs/heads/")));
    assert.ok(headRefs.some((ref) => ref.refname === "refs/heads/feature"));
  });
});

test("refs rejects option-shaped patterns instead of passing them to git as argv options", async () => {
  await withFixture("refs-injection", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    fx.git("branch", "feature");
    const engine = engineFor(fx);
    for (const pattern of ["--format=%(refname)", "--sort=-committerdate", "--points-at=HEAD", "-n", "-c"] ) {
      const result = await engine.execute({ action: "refs", pattern });
      assert.equal(result.isError, true, `expected rejection for pattern ${pattern}`);
      assert.match(result.text, /starts with a dash/, `error for ${pattern}: ${result.text}`);
    }
    // A legitimate refname glob is unaffected.
    const ok = await engine.execute({ action: "refs", pattern: "refs/heads/*" });
    assert.equal(ok.isError, false, ok.text);
    assert.equal((detailsOf(ok).refs as any[]).length, 2);
  });
});

test("mergeBase finds common ancestors and reports unrelated histories", async () => {
  await withFixture("mergebase", async (fx) => {
    const base = fx.commit("base", { "a.txt": "1\n" });
    const sideTip = fx.commit("side work", { "s.txt": "s\n" }, { branch: "side" });
    fx.git("checkout", "-q", "main");
    fx.commit("main work", { "m.txt": "m\n" });

    const engine = engineFor(fx);
    const result = await engine.execute({ action: "mergeBase", a: "main", b: "side" });
    assert.equal(result.isError, false, result.text);
    assert.equal((detailsOf(result).mergeBase as string), base);

    // Unrelated histories (orphan branch) report null, not an error.
    fx.git("checkout", "-q", "--orphan", "orphan");
    fx.commit("orphan root", { "o.txt": "o\n" });
    const unrelated = await engine.execute({ action: "mergeBase", a: "main", b: "orphan" });
    assert.equal(unrelated.isError, false, unrelated.text);
    assert.equal(detailsOf(unrelated).mergeBase, null);

    void sideTip;
  });
});

test("listFiles inventories the tree at a revision with sizes", async () => {
  await withFixture("listfiles", async (fx) => {
    fx.commit("one", { "a.txt": "12345\n", "sub/b.txt": "6789\n", "tab\tname.txt": "1234567890\n" });
    const engine = engineFor(fx);
    const all = await engine.execute({ action: "listFiles", rev: "HEAD" });
    assert.equal(all.isError, false, all.text);
    const files = (detailsOf(all).files as any[]);
    const a = files.find((file) => file.path === "a.txt");
    assert.equal(a.type, "blob");
    assert.equal(a.size, 6);
    assert.match(a.mode, /^100/);
    assert.ok(files.some((file) => file.path === "sub/b.txt"));
    // A pathname containing a tab must survive ls-tree -z parsing verbatim
    // (the first tab separates metadata from the path, not the last).
    const tabbed = files.find((file) => file.path === "tab\tname.txt");
    assert.ok(tabbed, "tab-named file is listed");
    assert.equal(tabbed.size, 11);

    const filtered = await engine.execute({ action: "listFiles", rev: "HEAD", paths: ["sub"] });
    assert.equal(filtered.isError, false, filtered.text);
    const subFiles = (detailsOf(filtered).files as any[]);
    assert.deepEqual(subFiles.map((file) => file.path), ["sub/b.txt"]);
  });
});

test("readFile returns tracked content at a revision with paging", async () => {
  await withFixture("readfile", async (fx) => {
    const v1 = fx.commit("v1", { "doc.txt": "alpha\nbeta\ngamma\n" });
    fx.commit("v2", { "doc.txt": "ALPHA\nbeta\ngamma\ndelta\n" });

    const engine = engineFor(fx);
    const atV1 = await engine.execute({ action: "readFile", rev: v1, path: "doc.txt" });
    assert.equal(atV1.isError, false, atV1.text);
    assert.ok(atV1.text.includes("alpha"), "historical content, not the worktree copy");
    assert.equal((detailsOf(atV1).totalLines as number), 3);

    // A larger file so the minimum maxChars (500) still forces paging.
    const bigDoc = Array.from({ length: 120 }, (_, i) => `line ${i + 1} padding padding`).join("\n") + "\n";
    fx.commit("v3", { "bigdoc.txt": bigDoc });
    const paged = await engine.execute({ action: "readFile", rev: "HEAD", path: "bigdoc.txt", maxChars: 600 });
    assert.equal(paged.isError, false, paged.text);
    assert.ok((detailsOf(paged).nextIndex as number) > 0, "small maxChars pages the file");
    assert.equal(detailsOf(paged).totalLines, 120);

    // Continuation pages must use the pinned SHA, not a symbolic spec that
    // could re-resolve to a different commit (HEAD may have moved).
    const pagedRev = (detailsOf(paged).pinned as any).rev as string;
    const symbolicPage = await engine.execute({ action: "readFile", rev: "HEAD", path: "bigdoc.txt", index: detailsOf(paged).nextIndex });
    assert.equal(symbolicPage.isError, true);
    assert.match(symbolicPage.text, /full 40-hex pinned revision/);
    const pinnedPage = await engine.execute({ action: "readFile", rev: pagedRev, path: "bigdoc.txt", index: detailsOf(paged).nextIndex });
    assert.equal(pinnedPage.isError, false, pinnedPage.text);

    const missing = await engine.execute({ action: "readFile", rev: "HEAD", path: "nope.txt" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /not tracked at revision/);

    const dir = await engine.execute({ action: "readFile", rev: "HEAD", path: "." });
    assert.equal(dir.isError, true);
  });
});

test("search finds historical tracked content with literal and regex modes", async () => {
  await withFixture("search", async (fx) => {
    fx.commit("one", {
      "src/a.ts": "const needle = 1;\nexport {};\n",
      "src/b.ts": "NEEDLE again\n",
      // A ':' in the pathname: grep -z records delimit the path with NUL, so
      // colons inside the path cannot be mistaken for field boundaries.
      "src/a:b.ts": "colon needle here\n",
      // ':' immediately before digits must not be mistaken for a boundary.
      "x:2": "colon digit needle\n",
      "docs/guide.md": "the needle moves\n",
    });

    const engine = engineFor(fx);
    const literal = await engine.execute({ action: "search", pattern: "needle", rev: "HEAD" });
    assert.equal(literal.isError, false, literal.text);
    let matches = (detailsOf(literal).matches as any[]);
    assert.ok(matches.some((match) => match.path === "src/a.ts" && match.line === 1));
    assert.ok(
      matches.some((match) => match.path === "src/a:b.ts" && match.line === 1),
      "match in a colon-named path is not dropped",
    );
    assert.ok(
      matches.some((match) => match.path === "x:2" && match.line === 1),
      "numeric-looking path segment is not taken as the line number",
    );

    // Literal mode: regex metacharacters do not match ("e.d" is not literal text).
    const noRegex = await engine.execute({ action: "search", pattern: "e.d", rev: "HEAD" });
    assert.equal(noRegex.isError, false, noRegex.text);
    assert.equal((detailsOf(noRegex).matches as any[]).length, 0);

    // Regex mode: "e.d" matches the "eed" inside "needle".
    const regex = await engine.execute({ action: "search", pattern: "e.d", rev: "HEAD", fixedStrings: false });
    matches = (detailsOf(regex).matches as any[]);
    assert.ok(matches.some((match) => match.path === "src/a.ts"));

    // Case-insensitive + path filter.
    const ci = await engine.execute({ action: "search", pattern: "needle", rev: "HEAD", caseInsensitive: true, paths: ["src/b.ts"] });
    matches = (detailsOf(ci).matches as any[]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.path, "src/b.ts");

    // No match is an empty result, not an error.
    const none = await engine.execute({ action: "search", pattern: "zzz-not-there", rev: "HEAD" });
    assert.equal(none.isError, false, none.text);
    assert.equal((detailsOf(none).matches as any[]).length, 0);
  });
});

// ---------------------------------------------------------------------------
// binary and huge data
// ---------------------------------------------------------------------------

test("binary blobs are detected and never returned as content", async () => {
  await withFixture("binary", async (fx) => {
    const before = fx.commit("before", { "a.txt": "1\n" });
    writeFileSync(join(fx.root, "blob.bin"), Buffer.from([0, 255, 1, 0, 128, 65]));
    fx.git("add", "-A");
    const after = fx.commit("after", {});

    const engine = engineFor(fx);
    const inventory = await engine.execute({ action: "diff", from: before, to: after });
    assert.equal(inventory.isError, false, inventory.text);
    const blob = (detailsOf(inventory).files as any[]).find((file) => file.path === "blob.bin");
    assert.ok(blob);
    assert.equal(blob.binary, true);

    const read = await engine.execute({ action: "readFile", rev: after, path: "blob.bin" });
    assert.equal(read.isError, false, read.text);
    assert.equal((detailsOf(read).binary as boolean), true);
    assert.match(read.text, /binary/);
    assert.ok(!read.text.includes("\u0000"), "no raw binary bytes in the result");
  });
});

test("readFile binary detection is honest above and below the read cap", async () => {
  await withFixture("binary-bounds", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    // Over-cap blob (>256 KiB) with NULs inside the probed prefix.
    const bigBinary = Buffer.alloc(GIT_READ_LIMITS.readFileMaxBytes + 4096, 0x41);
    bigBinary[64] = 0;
    bigBinary[1000] = 0;
    writeFileSync(join(fx.root, "big.bin"), bigBinary);
    // Over-cap blob with no NUL anywhere: must not be mislabelled binary.
    const bigText = `${"z".repeat(99)}\n`.repeat(Math.ceil((GIT_READ_LIMITS.readFileMaxBytes + 4096) / 100));
    writeFileSync(join(fx.root, "bigtext.txt"), bigText);
    // Under-cap blob whose only NUL sits past the old first-8000-bytes window.
    const lateNul = Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0]), Buffer.alloc(16, 0x62)]);
    writeFileSync(join(fx.root, "late-nul.bin"), lateNul);
    fx.git("add", "-A");
    fx.commit("two", {});

    const engine = engineFor(fx);
    const binRead = await engine.execute({ action: "readFile", rev: "HEAD", path: "big.bin" });
    assert.equal(binRead.isError, false, binRead.text);
    assert.equal(detailsOf(binRead).binary, true, "over-cap blob with NUL in the probed prefix is binary");
    assert.equal(detailsOf(binRead).binaryProbed, true, "the over-cap blob was actually probed");
    assert.equal(detailsOf(binRead).binaryProbeBytes, GIT_READ_LIMITS.readFileProbeBytes);
    assert.equal(detailsOf(binRead).truncated, true);
    assert.match(binRead.text, /binary/);
    assert.ok(!binRead.text.includes("\u0000"), "no raw binary bytes in the result");

    const textRead = await engine.execute({ action: "readFile", rev: "HEAD", path: "bigtext.txt" });
    assert.equal(textRead.isError, false, textRead.text);
    assert.equal(detailsOf(textRead).binary, false, "over-cap text blob must not be claimed binary");
    assert.equal(detailsOf(textRead).binaryProbed, true);
    assert.equal(detailsOf(textRead).truncated, true);

    const lateRead = await engine.execute({ action: "readFile", rev: "HEAD", path: "late-nul.bin" });
    assert.equal(lateRead.isError, false, lateRead.text);
    assert.equal(detailsOf(lateRead).binary, true, "a NUL past byte 8000 under the cap must be detected");
    assert.ok(!lateRead.text.includes("\u0000"), "binary content is never returned as model-facing text");
  });
});

test("huge files are bounded: readFile cap and patch byte cap", async () => {
  await withFixture("huge", async (fx) => {
    const line = "x".repeat(96) + "\n";
    const huge = line.repeat(4000); // ~384 KiB
    const before = fx.commit("before", { "a.txt": "1\n" });
    fx.commit("after", { "huge.txt": huge });

    const engine = engineFor(fx);
    const read = await engine.execute({ action: "readFile", rev: "HEAD", path: "huge.txt" });
    assert.equal(read.isError, false, read.text);
    const rd = detailsOf(read);
    assert.equal(rd.truncated, true, "file above the read cap is reported truncated");
    assert.ok((rd.size as number) > GIT_READ_LIMITS.readFileMaxBytes);
    assert.ok(!read.text.includes("x".repeat(96)), "content of an over-cap file is not returned");

    // Patch paging on a huge diff: pages are bounded and continue exactly.
    // Continuations pass the pinned SHA back (symbolic specs are rejected
    // for index > 0 so a moved HEAD cannot blend pages from two revisions).
    const patch = await engine.execute({ action: "diff", from: before, to: "HEAD", file: "huge.txt", maxChars: 2000 });
    assert.equal(patch.isError, false, patch.text);
    const pd = detailsOf(patch);
    const toSha = (pd.pinned as any).to as string;
    assert.match(toSha, /^[0-9a-f]{40}$/);
    assert.ok(pd.nextIndex !== null, "huge patch pages");
    let totalLines = pd.patchLinesReturned as number;
    let index: number | null = pd.nextIndex as number | null;
    let guard = 0;
    while (index !== null && guard < 100) {
      const next = await engine.execute({ action: "diff", from: before, to: toSha, file: "huge.txt", index, maxChars: 20_000 });
      assert.equal(next.isError, false, next.text);
      totalLines += detailsOf(next).patchLinesReturned as number;
      index = detailsOf(next).nextIndex as number | null;
      guard += 1;
    }
    assert.ok(totalLines > 4000, `all ${totalLines} patch lines were reachable through pages`);

    // A deliberately tiny command byte cap fails closed with a clear error
    // (maxChars is at its maximum so the character budget cannot stop the read first).
    const capped = engineFor(fx, { commandByteCap: 10_000 });
    const overflow = await capped.execute({ action: "diff", from: before, to: "HEAD", file: "huge.txt", maxChars: GIT_READ_LIMITS.maxCharsMax });
    assert.equal(overflow.isError, true);
    assert.match(overflow.text, /byte cap/);
  });
});

// ---------------------------------------------------------------------------
// invalid arguments
// ---------------------------------------------------------------------------

test("invalid arguments are rejected with actionable errors", async () => {
  await withFixture("invalid-args", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    const engine = engineFor(fx);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ action: "log", rev: "--all" }, /starts with a dash/],
      [{ action: "log", paths: ["../escape"] }, /escapes the repository/],
      [{ action: "log", paths: ["/etc/passwd"] }, /repository-relative/],
      [{ action: "log", paths: ["src/:(glob)*.ts"] }, /pathspec magic/],
      [{ action: "log", paths: ["a*b.txt"] }, /glob characters/],
      [{ action: "log", paths: ["!negated"] }, /reserved prefix/],
      [{ action: "log", follow: true, paths: ["a.txt", "b.txt"] }, /exactly one path/],
      [{ action: "show", rev: "HEAD", find: "x" }, /does not accept field/],
      [{ action: "log", index: 5 }, /snapshotId/],
      [{ action: "bogus" }, /action must be one of/],
      [{ action: "blame", path: "a.txt", startLine: 10, endLine: 5 }, /endLine must be >= startLine/],
      [{ action: "log", limit: 999_999 }, /integer from 1 through/],
      [{ action: "diff", from: "HEAD" }, /requires both from and to/],
      [{ action: "mergeBase", a: "HEAD" }, /must be a string revision/],
      [{ action: "log", rev: "HEAD\ninjected" }, /control characters/],
    ];
    for (const [params, pattern] of cases) {
      const result = await engine.execute(params);
      assert.equal(result.isError, true, `expected error for ${JSON.stringify(params)}`);
      assert.match(result.text, pattern, `error message for ${JSON.stringify(params)}: ${result.text}`);
    }

    // parent on a non-merge commit is rejected explicitly.
    const parent = await engine.execute({ action: "show", rev: "HEAD", parent: 2 });
    assert.equal(parent.isError, true);
    assert.match(parent.text, /only applies to merge commits/);
  });
});

// ---------------------------------------------------------------------------
// hostile repository config, attributes, and environment
// ---------------------------------------------------------------------------

test("hostile repo diff programs are refused fail-closed", async () => {
  await withFixture("hostile-config", async (fx) => {
    fx.commit("one", { "a.ts": "1\n" });
    const pwned = join(fx.root, "pwned");
    writeFileSync(join(fx.root, ".gitattributes"), "*.ts diff=evil\n");
    fx.git("config", "diff.evil.command", `touch ${pwned}`);
    fx.git("config", "diff.evil.textconv", `touch ${pwned}`);

    const engine = engineFor(fx);
    for (const params of [
      { action: "log", rev: "HEAD" },
      { action: "show", rev: "HEAD" },
      { action: "diff", from: "HEAD~1", to: "HEAD" },
      { action: "blame", path: "a.ts" },
    ]) {
      const result = await engine.execute(params);
      assert.equal(result.isError, true, `expected refusal for ${JSON.stringify(params)}`);
      assert.match(result.text, /refusing repository/);
      assert.match(result.text, /diff\.evil/);
    }
    assert.equal(existsSync(pwned), false, "no repository-defined program was executed");
  });
});

test("dotted diff driver names cannot bypass the config audit", async () => {
  await withFixture("hostile-dotted-driver", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    const pwned = join(fx.root, "pwned");
    // Git splits a driver config key at the LAST dot: diff.evil.x.textconv is
    // driver "evil.x". A single-segment audit regex would miss it.
    writeFileSync(join(fx.root, ".gitattributes"), "*.txt diff=evil.x\n");
    fx.git("config", "diff.evil.x.command", `touch ${pwned}`);
    fx.git("config", "diff.evil.x.textconv", `touch ${pwned}`);

    const engine = engineFor(fx);
    for (const params of [
      { action: "log", rev: "HEAD" },
      { action: "show", rev: "HEAD" },
      { action: "diff", from: "HEAD~1", to: "HEAD" },
    ]) {
      const result = await engine.execute(params);
      assert.equal(result.isError, true, `expected refusal for ${JSON.stringify(params)}`);
      assert.match(result.text, /refusing repository/);
      assert.match(result.text, /diff\.evil\.x/);
    }
    assert.equal(existsSync(pwned), false, "no repository-defined program was executed");
  });
});

test("replace refs cannot rewrite what GitRead reports", async () => {
  await withFixture("replace-refs", async (fx) => {
    const original = fx.commit("original", { "a.txt": "one\n" });
    const replacement = fx.commit("replacement", { "a.txt": "two\n" });
    // refs/replace/<original> → <replacement>: plain git now reports the
    // replacement wherever the original is named.
    fx.git("replace", original, replacement);

    // Baseline: without --no-replace-objects / GIT_NO_REPLACE_OBJECTS, git
    // follows the replace ref (proves the fixture is armed).
    const plainGit = execFileSync(
      "git", ["show", "--no-patch", "--format=%s", original],
      { encoding: "utf8", cwd: fx.root, env: FIXTURE_ENV },
    ).trim();
    assert.equal(plainGit, "replacement", "plain git follows the replace ref");

    const engine = engineFor(fx);
    const log = await engine.execute({ action: "log", rev: original });
    assert.equal(log.isError, false, log.text);
    assert.ok(log.text.includes("original"), "log reports the original commit subject");
    assert.ok(!log.text.includes("replacement"), "replace ref must not be followed");

    const show = await engine.execute({ action: "show", rev: original, file: "a.txt" });
    assert.equal(show.isError, false, show.text);
    assert.ok(show.text.includes("+one"), "patch shows the original content");
    assert.ok(!show.text.includes("two"), "replacement content must not appear");

    void replacement;
  });
});

test("--no-ext-diff/--no-textconv prevent configured diff programs from running", async () => {
  await withFixture("no-ext-diff-flags", async (fx) => {
    const a = fx.commit("one", { "a.txt": "1\n" });
    fx.commit("two", { "a.txt": "2\n" });
    const pwned = join(fx.root, "pwned");
    writeFileSync(join(fx.root, ".gitattributes"), "*.txt diff=plain\n");
    fx.git("config", "diff.plain.command", `touch ${pwned}`);

    // Baseline: a plain `git diff` in this armed repository runs the program.
    execFileSync("git", ["-c", "core.pager=cat", "diff", a, "HEAD"], { cwd: fx.root, env: FIXTURE_ENV });
    assert.equal(existsSync(pwned), true, "armed fixture: plain git diff executes the driver");
    rmSync(pwned);

    // The exact flag pair GitRead adds neutralizes it.
    execFileSync("git", ["-c", "core.pager=cat", "diff", "--no-ext-diff", "--no-textconv", a, "HEAD"], { cwd: fx.root, env: FIXTURE_ENV });
    assert.equal(existsSync(pwned), false, "--no-ext-diff/--no-textconv prevent driver execution");
  });
});

test("continuations with snapshotId reject stray query fields", async () => {
  await withFixture("snapshot-query-guard", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    const engine = engineFor(fx);

    const first = await engine.execute({ action: "log", rev: "HEAD", maxChars: 600 });
    assert.equal(first.isError, false, first.text);
    const logSnap = detailsOf(first).snapshotId as string;

    const strayLog = await engine.execute({ action: "log", snapshotId: logSnap, index: 1, author: "nobody" });
    assert.equal(strayLog.isError, true);
    assert.match(strayLog.text, /accepts only index\/find\/maxChars/);
    assert.match(strayLog.text, /author/);

    const refsFirst = await engine.execute({ action: "refs", maxChars: 600 });
    assert.equal(refsFirst.isError, false, refsFirst.text);
    const refsSnap = detailsOf(refsFirst).snapshotId as string;
    const strayRefs = await engine.execute({ action: "refs", snapshotId: refsSnap, index: 1, pattern: "refs/heads" });
    assert.equal(strayRefs.isError, true);
    assert.match(strayRefs.text, /pattern/);

    // Navigation-only continuations still work.
    const ok = await engine.execute({ action: "log", snapshotId: logSnap, index: 1 });
    assert.equal(ok.isError, false, ok.text);
  });
});

test("inert attribute drivers and clean/smudge filters do not block history reads", async () => {
  await withFixture("inert-attrs", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    // Attribute references a driver that is NOT configured: nothing can run.
    writeFileSync(join(fx.root, ".gitattributes"), "*.txt diff=unconfigured\n");
    // LFS-style filters: only run on checkout/add/commit, which GitRead never does.
    fx.git("config", "filter.lfs.clean", "git-lfs clean %f");
    fx.git("config", "filter.lfs.smudge", "git-lfs smudge %f");
    fx.git("config", "filter.lfs.process", "git-lfs filter-process");

    const engine = engineFor(fx);
    const result = await engine.execute({ action: "log", rev: "HEAD" });
    assert.equal(result.isError, false, `expected success, got: ${result.text}`);
    assert.ok(result.text.includes("one"));
  });
});

test("hostile user config and inherited GIT_* environment are ignored", async () => {
  await withFixture("hostile-env", async (fx) => {
    const head = fx.commit("one", { "a.txt": "1\n" });

    // A fake user config that would enable a diff program if read.
    const fakeHome = mkdtempSync(join(tmpdir(), "gitread-home-"));
    writeFileSync(join(fakeHome, ".gitconfig"), "[diff]\n\texternal = /bin/echo\n[core]\n\tfsmonitor = true\n");
    // A different repository that inherited GIT_DIR/GIT_WORK_TREE would point at.
    const otherRoot = mkdtempSync(join(tmpdir(), "gitread-other-"));
    execFileSync("git", ["init", "-q", "--initial-branch=main", otherRoot], { env: FIXTURE_ENV });

    const engine = engineFor(fx);
    const previous = { HOME: process.env.HOME, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    try {
      process.env.HOME = fakeHome;
      process.env.GIT_DIR = join(otherRoot, ".git");
      process.env.GIT_WORK_TREE = otherRoot;
      const result = await engine.execute({ action: "log", rev: "HEAD" });
      assert.equal(result.isError, false, `expected success despite hostile env, got: ${result.text}`);
      assert.equal((detailsOf(result).repoRoot as string), fx.root, "operates on the runtime-cwd repository");
      assert.equal((detailsOf(result).pinned as any).rev, head);
    } finally {
      process.env.HOME = previous.HOME;
      if (previous.GIT_DIR === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous.GIT_DIR;
      if (previous.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previous.GIT_WORK_TREE;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

test("non-repository cwd and bare repositories fail with clear errors", async () => {
  const notRepo = mkdtempSync(join(tmpdir(), "gitread-notrepo-"));
  const bareRoot = mkdtempSync(join(tmpdir(), "gitread-bare-"));
  try {
    const engine = new GitReadEngine({ cwd: () => notRepo, timeoutMs: 10_000 });
    const result = await engine.execute({ action: "log" });
    assert.equal(result.isError, true);
    assert.match(result.text, /no Git repository found/);

    execFileSync("git", ["init", "-q", "--bare", bareRoot], { env: FIXTURE_ENV });
    // A directory inside the .git of a bare repo has no work tree.
    const bareEngine = new GitReadEngine({ cwd: () => join(bareRoot, "objects"), timeoutMs: 10_000 });
    const bareResult = await bareEngine.execute({ action: "log" });
    assert.equal(bareResult.isError, true);
    assert.match(bareResult.text, /bare repository|work tree/i);
  } finally {
    rmSync(notRepo, { recursive: true, force: true });
    rmSync(bareRoot, { recursive: true, force: true });
  }
});

test("SHA-256 object-format repositories fail closed with a clear unsupported diagnostic", async () => {
  const shaRoot = mkdtempSync(join(tmpdir(), "gitread-sha256-"));
  try {
    execFileSync("git", ["init", "-q", "--object-format=sha256", "--initial-branch=main", shaRoot], { env: FIXTURE_ENV });
    execFileSync("git", ["-C", shaRoot, "config", "user.email", "test@example.com"], { env: FIXTURE_ENV });
    execFileSync("git", ["-C", shaRoot, "config", "user.name", "Test User"], { env: FIXTURE_ENV });
    writeFileSync(join(shaRoot, "a.txt"), "1\n");
    execFileSync("git", ["-C", shaRoot, "add", "-A"], { env: FIXTURE_ENV });
    execFileSync("git", ["-C", shaRoot, "commit", "-q", "-m", "one"], { env: FIXTURE_ENV });

    const engine = new GitReadEngine({ cwd: () => shaRoot, timeoutMs: 10_000 });
    const result = await engine.execute({ action: "log" });
    assert.equal(result.isError, true);
    assert.match(result.text, /sha-256/i, `expected an explicit sha-256 diagnostic: ${result.text}`);
    assert.match(result.text, /does not support/i);
    assert.doesNotMatch(result.text, /unknown revision|cannot resolve revision/, "not a misleading unknown-revision error");
  } finally {
    rmSync(shaRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// limits and snapshot expiry
// ---------------------------------------------------------------------------

test("snapshots expire and evict with explicit errors", async () => {
  await withFixture("expiry", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    fx.commit("two", { "b.txt": "2\n" });

    // TTL expiry.
    const shortLived = engineFor(fx, { snapshotTtlMs: 80 });
    const first = await shortLived.execute({ action: "log", rev: "HEAD", maxChars: 600 });
    assert.equal(first.isError, false, first.text);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expired = await shortLived.execute({ action: "log", snapshotId: detailsOf(first).snapshotId, index: 1 });
    assert.equal(expired.isError, true);
    assert.match(expired.text, /expired/);

    // LRU eviction.
    const tinyCache = engineFor(fx, { maxSnapshots: 1 });
    const s1 = await tinyCache.execute({ action: "log", rev: "HEAD" });
    const s2 = await tinyCache.execute({ action: "log", rev: "HEAD", author: "nobody-matches" });
    assert.equal(s2.isError, false, s2.text);
    const evicted = await tinyCache.execute({ action: "log", snapshotId: detailsOf(s1).snapshotId, index: 1 });
    assert.equal(evicted.isError, true);
    assert.match(evicted.text, /not available/);

    // Cross-action snapshot reuse is rejected.
    const engine = engineFor(fx);
    const logSnap = await engine.execute({ action: "log", rev: "HEAD" });
    const wrongAction = await engine.execute({ action: "refs", snapshotId: detailsOf(logSnap).snapshotId, index: 1 });
    assert.equal(wrongAction.isError, true);
    assert.match(wrongAction.text, /belongs to action 'log'/);
  });
});

test("maxChars bounds pages and timeouts fail closed", async () => {
  await withFixture("limits", async (fx) => {
    for (let i = 0; i < 30; i += 1) fx.commit(`commit ${i}`, { [`f${i}.txt`]: `${i}\n`.repeat(20) });

    const engine = engineFor(fx);
    const page = await engine.execute({ action: "log", rev: "HEAD", limit: 30, maxChars: GIT_READ_LIMITS.maxCharsMin });
    assert.equal(page.isError, false, page.text);
    const d = detailsOf(page);
    // The page body (before the footer) respects the budget; at least one entry shows.
    assert.ok((d.entries as any[]).length >= 1);
    assert.notEqual(d.nextIndex, null, "a minimal window pages");

    // maxChars below the floor is rejected.
    const tooSmall = await engine.execute({ action: "log", rev: "HEAD", maxChars: 10 });
    assert.equal(tooSmall.isError, true);
    assert.match(tooSmall.text, /integer from/);

    // Timeout: an impossibly small deadline fails with a timeout error.
    const slow = engineFor(fx, { timeoutMs: 1 });
    const timedOut = await slow.execute({ action: "log", rev: "HEAD" });
    assert.equal(timedOut.isError, true);
    assert.match(timedOut.text, /timed out/);

    // log limit disclosure: acquiring fewer than the total says so.
    const limited = await engine.execute({ action: "log", rev: "HEAD", limit: 5 });
    const ld = detailsOf(limited);
    assert.equal(ld.totalCommits, 30);
    assert.equal(ld.acquiredEntries, 5);
    assert.match(limited.text, /raise limit or narrow filters/);
  });
});

// ---------------------------------------------------------------------------
// status is explicitly unsupported
// ---------------------------------------------------------------------------

test("status returns an explicit unsupported rationale", async () => {
  await withFixture("status", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    const engine = engineFor(fx);
    const result = await engine.execute({ action: "status" });
    assert.equal(result.isError, true);
    assert.equal((detailsOf(result).supported as boolean), false);
    assert.match(result.text, /unsupported/i);
    assert.match(result.text, /non-atomic/);
    assert.match(result.text, /future work/i);
  });
});

// ---------------------------------------------------------------------------
// no repository mutation
// ---------------------------------------------------------------------------

test("GitRead never mutates the repository (.git tree and worktree unchanged)", async () => {
  await withFixture("no-mutation", async (fx) => {
    fx.commit("one", { "a.txt": "1\n2\n", "sub/b.txt": "b\n" });
    const before = fx.commit("two", { "a.txt": "1\nM2\n3\n" });

    const gitTreeHash = (): string => {
      const out = execFileSync("bash", [
        "-c",
        `cd ${JSON.stringify(fx.root)} && find .git -type f -print0 | sort -z | xargs -0 shasum 2>/dev/null`,
      ], { encoding: "utf8" });
      return createHash("sha256").update(out).digest("hex");
    };

    const hashBefore = gitTreeHash();
    const statusBefore = fx.git("status", "--porcelain");

    const engine = engineFor(fx);
    const actions: Array<Record<string, unknown>> = [
      { action: "log", rev: "HEAD", limit: 10 },
      { action: "log", snapshotId: undefined, find: "one" },
      { action: "show", rev: before },
      { action: "show", rev: before, file: "a.txt" },
      { action: "diff", from: "HEAD~1", to: "HEAD" },
      { action: "diff", from: "HEAD~1", to: "HEAD", file: "a.txt" },
      { action: "blame", path: "a.txt" },
      { action: "refs" },
      { action: "mergeBase", a: "HEAD~1", b: "HEAD" },
      { action: "listFiles", rev: "HEAD" },
      { action: "readFile", rev: "HEAD", path: "a.txt" },
      { action: "search", pattern: "M2", rev: "HEAD" },
    ];
    for (const params of actions) {
      const result = await engine.execute(params);
      assert.equal(result.isError, false, `${JSON.stringify(params)}: ${result.text}`);
    }

    assert.equal(fx.git("status", "--porcelain"), statusBefore, "worktree state unchanged");
    assert.equal(gitTreeHash(), hashBefore, ".git contents byte-identical after all read actions");
  });
});

// ---------------------------------------------------------------------------
// end-to-end through the registered tool (Pi-compatible surface)
// ---------------------------------------------------------------------------

test("registered GitRead tool executes through the Pi-compatible surface", async () => {
  await withFixture("tool-surface", async (fx) => {
    fx.commit("one", { "a.txt": "1\n" });
    const registered: Array<Record<string, unknown>> = [];
    assert.equal(registerGitReadTool({ registerTool: (tool) => registered.push(tool) }, () => fx.root), true);
    const tool = registered[0]!;
    const execute = tool.execute as (id: string, params: unknown, signal?: AbortSignal) => Promise<any>;

    const ok = await execute("call-1", { action: "log", rev: "HEAD" });
    assert.equal(ok.isError, false);
    assert.ok(Array.isArray(ok.content));
    assert.match(ok.content[0].text as string, /GitRead log/);
    assert.equal(ok.details.action, "log");

    const failure = await execute("call-2", { action: "diff", from: "HEAD" });
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text as string, /GitRead failed/);
  });
});
