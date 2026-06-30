import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareSnapshots, createWorkspaceSnapshot } from "../src/capture";

const snapshotOptions = {
  maxFileBytes: 1024 * 1024,
  maxSnapshotBytes: 10 * 1024 * 1024,
};

test("snapshot comparison detects added, modified, and deleted files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-capture-"));
  try {
    await writeFile(join(dir, "modified.txt"), "before\n", "utf8");
    await writeFile(join(dir, "deleted.txt"), "remove me\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await writeFile(join(dir, "modified.txt"), "after\n", "utf8");
    await rm(join(dir, "deleted.txt"));
    await writeFile(join(dir, "added.txt"), "new\n", "utf8");

    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    const changes = compareSnapshots(before, after);

    assert.deepEqual(
      changes.map((change) => [change.path, change.status]),
      [
        ["added.txt", "added"],
        ["deleted.txt", "deleted"],
        ["modified.txt", "modified"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot omits binary content but still detects changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-binary-"));
  try {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await writeFile(join(dir, "nested", "blob.bin"), Buffer.from([0, 1, 2, 4]));
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    const [change] = compareSnapshots(before, after);

    assert.equal(change.path, "nested/blob.bin");
    assert.equal(change.binary, true);
    assert.equal(change.diffOmittedReason, "binary");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
