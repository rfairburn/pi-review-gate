import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureReviewBaseline, GitBaselineCaptureError } from "../src/git-baseline-capture";
import { loadGitCheckpoint, releaseGitCheckpointPin } from "../src/git-checkpoint";

const limits = { maxFileBytes: 1, maxSnapshotBytes: 1 };

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "prg-git-baseline-capture-"));
}

test("Git root captures a complete pinned descriptor independently of reviewer text limits", async () => {
  const root = await fixture();
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, "tracked"), "old tracked\n");
    execFileSync("git", ["-C", root, "add", "tracked"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
    await writeFile(join(root, "tracked"), "longer changed tracked data\n");
    await writeFile(join(root, "new"), "longer untracked bytes\n");
    const indexBefore = await readFile(join(root, ".git", "index"));
    const baseline = await captureReviewBaseline(root, limits);
    assert.equal(baseline.kind, "git");
    if (baseline.kind !== "git") return;
    assert.equal(Object.hasOwn(baseline, "snapshot"), false);
    assert.equal(typeof baseline.descriptor.digest, "string");
    const loaded = await loadGitCheckpoint(root, baseline.descriptor);
    assert.equal(loaded.status, "ok");
    if (loaded.status === "ok") {
      assert.deepEqual(loaded.value.record.untracked.map((entry) => entry.path), ["new"]);
      assert.equal(Buffer.from(loaded.value.record.untracked[0]?.contentB64 ?? "", "base64").toString("utf8"), "longer untracked bytes\n");
    }
    assert.deepEqual(await readFile(join(root, ".git", "index")), indexBefore);
    const released = await releaseGitCheckpointPin(root, baseline.descriptor.windowId, {
      expectedBase: baseline.descriptor.base, armId: baseline.descriptor.armId,
    });
    assert.equal(released.status, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Git directory keeps the best-effort snapshot path", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "file"), "hello\n");
    const baseline = await captureReviewBaseline(root, { maxFileBytes: 100, maxSnapshotBytes: 100 });
    assert.equal(baseline.kind, "snapshot");
    if (baseline.kind === "snapshot") assert.equal(baseline.snapshot.files.get("file")?.content, "hello\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid Git marker or unsupported unborn HEAD fails closed instead of claiming non-Git", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, ".git"), "gitdir: /definitely/missing/gitdir\n");
    await assert.rejects(captureReviewBaseline(root, limits), (error: unknown) =>
      error instanceof GitBaselineCaptureError && error.reason === "not_a_git_repository");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const unborn = await fixture();
  try {
    execFileSync("git", ["init", "-q", unborn]);
    await assert.rejects(captureReviewBaseline(unborn, limits), (error: unknown) =>
      error instanceof GitBaselineCaptureError && error.reason === "unborn_head");
  } finally {
    await rm(unborn, { recursive: true, force: true });
  }
});
