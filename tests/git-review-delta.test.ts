import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedPatch } from "../src/diff";
import type { GitCheckpointComparisonReport } from "../src/git-checkpoint";
import { buildGitReviewDelta } from "../src/git-review-delta";

const limits = { maxFileBytes: 1000, maxSnapshotBytes: 10_000, maxPatchBytes: 100_000 };
const report = (overrides: Partial<GitCheckpointComparisonReport>): GitCheckpointComparisonReport => ({
  trackedChanges: [], untrackedAdded: [], untrackedRemoved: [], untrackedModified: [], untrackedChanges: [], ...overrides,
});

test("Git review delta shows changed tracked/untracked bytes without clean paths", () => {
  const result = buildGitReviewDelta(report({
    trackedChanges: [{ path: "tracked.txt", status: "modified", oldKind: "file", newKind: "file", oldMode: 0o644, newMode: 0o644,
      oldBytes: Buffer.from("old\n"), newBytes: Buffer.from("new\n") }],
    untrackedChanges: [{ path: "added.txt", change: "added", new: { kind: "file", mode: 0o100644, content: Buffer.from("hello\n") } },
      { path: "deleted.txt", change: "removed", old: { kind: "file", mode: 0o100644, content: Buffer.from("bye\n") } }],
  }), limits);
  assert.deepEqual(result.changes.map(({ path, status }) => [path, status]), [
    ["added.txt", "added"], ["deleted.txt", "deleted"], ["tracked.txt", "modified"],
  ]);
  assert.equal(result.changes[0]?.newContent, "hello\n");
  assert.equal(result.changes[1]?.oldContent, "bye\n");
  assert.match(result.patch.patch, /-old\n\+new/);
  assert.match(result.patch.patch, /new file mode 100644/);
});

test("mode-only and symlink retarget have visible metadata and target diffs", () => {
  const result = buildGitReviewDelta(report({
    trackedChanges: [
      { path: "script", status: "modified", oldKind: "file", newKind: "file", oldMode: 0o644, newMode: 0o755,
        oldBytes: Buffer.from("same\n"), newBytes: Buffer.from("same\n") },
      { path: "link", status: "modified", oldKind: "symlink", newKind: "symlink", oldMode: 0, newMode: 0,
        oldBytes: Buffer.from("old-target"), newBytes: Buffer.from("new-target") },
    ],
    untrackedChanges: [{ path: "new-link", change: "modified", old: { kind: "symlink", mode: 0o120777, target: "before" },
      new: { kind: "symlink", mode: 0o120777, target: "after" } }],
  }), limits);
  assert.match(result.patch.patch, /old mode 100644\nnew mode 100755/);
  assert.match(result.patch.patch, /-old-target\n\+new-target/);
  assert.match(result.patch.patch, /-before\n\+after/);
  assert.equal(result.changes.find((entry) => entry.path === "script")?.diffOmittedReason, undefined);
});

test("binary, oversized and cumulative bounds omit content while preserving mode and path", () => {
  const result = buildGitReviewDelta(report({ untrackedChanges: [
    { path: "binary", change: "added", new: { kind: "file", mode: 0o100644, content: Buffer.from([0, 255]) } },
    { path: "large", change: "added", new: { kind: "file", mode: 0o100644, content: Buffer.from("four") } },
    { path: "over-budget", change: "added", new: { kind: "file", mode: 0o100644, content: Buffer.from("three") } },
  ] }), { ...limits, maxFileBytes: 3, maxSnapshotBytes: 2 });
  assert.deepEqual(result.changes.map(({ path, diffOmittedReason }) => [path, diffOmittedReason]), [
    ["binary", "binary"], ["large", "oversized"], ["over-budget", "oversized"],
  ]);
  assert.match(result.patch.patch, /new file mode 100644\n# Diff omitted for binary: binary/);

  const budget = buildGitReviewDelta(report({ untrackedChanges: [
    { path: "a", change: "added", new: { kind: "file", mode: 0o100644, content: Buffer.from("abc") } },
    { path: "b", change: "added", new: { kind: "file", mode: 0o100644, content: Buffer.from("xyz") } },
  ] }), { ...limits, maxSnapshotBytes: 3 });
  assert.equal(budget.changes[0]?.newContent, "abc");
  assert.equal(budget.changes[1]?.diffOmittedReason, "snapshot_limit");
});

test("missing changed content and duplicate path fail closed", () => {
  assert.throws(() => buildGitReviewDelta(report({ trackedChanges: [
    { path: "tracked", status: "modified", oldKind: "file", newKind: "file", oldMode: 0o644, newMode: 0o644,
      oldBytes: Buffer.from("old") },
  ] }), limits), /lacks new tracked content/);
  assert.throws(() => buildGitReviewDelta(report({ untrackedChanges: [
    { path: "missing", change: "removed", old: { kind: "file", mode: 0o100644 } },
  ] }), limits), /lacks untracked file content/);
  assert.throws(() => buildGitReviewDelta(report({ trackedChanges: [
    { path: "same", status: "added", newKind: "file", newMode: 0o644, newBytes: Buffer.from("x") },
  ], untrackedChanges: [
    { path: "same", change: "added", new: { kind: "file", mode: 0o100644, content: Buffer.from("y") } },
  ] }), limits), /duplicate changed path/);
});

test("legacy snapshot diff with no mode metadata remains unchanged", () => {
  const patch = buildUnifiedPatch([{ path: "old", status: "modified", binary: false, oversized: false,
    oldContent: "a\n", newContent: "b\n" }], 1000).patch;
  assert.match(patch, /^diff --git a\/old b\/old\n--- a\/old\n\+\+\+ b\/old/);
  assert.doesNotMatch(patch, /old mode|new mode|file mode/);
});
