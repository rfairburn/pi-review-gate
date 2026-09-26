// Issue #193: the bounded session-local completed-snapshot cache that carries
// a reuse source across ordinary review-window close. Unit coverage of the
// same-root, reset, and move-to-new-root boundaries; entrypoint lifecycle
// coverage (when the entrypoint remembers, offers, and clears) lives in
// tests/entrypoint-snapshot-reuse.test.ts.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createWorkspaceSnapshot } from "../src/capture";
import { CompletedSnapshotCache } from "../src/snapshot-reuse";

const snapshotOptions = { maxFileBytes: 1024 * 1024, maxSnapshotBytes: 10 * 1024 * 1024 };

test("the cache retains one completed source and serves it for the same resolved root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-reuse-cache-"));
  try {
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    const cache = new CompletedSnapshotCache();
    assert.equal(cache.reuseSourceFor(dir), undefined, "an empty cache offers no source");

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    cache.remember(snapshot);
    assert.equal(cache.current()?.snapshot, snapshot, "the completed snapshot is retained by reference");
    assert.equal(cache.reuseSourceFor(dir), snapshot, "the same root gets the retained source");
    // Resolved-root equivalence: relative variants and redundant separators
    // of the same directory are the same root.
    assert.equal(cache.reuseSourceFor(join(dir, ".")), snapshot);
    assert.equal(cache.reuseSourceFor(resolve(dir) + "/"), snapshot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the cache never serves a source across roots and moves with the newest root", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "pi-review-reuse-cache-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-review-reuse-cache-b-"));
  try {
    await writeFile(join(dirA, "a.txt"), "one\n", "utf8");
    await writeFile(join(dirB, "b.txt"), "two\n", "utf8");
    const cache = new CompletedSnapshotCache();
    const snapshotA = await createWorkspaceSnapshot(dirA, snapshotOptions);
    cache.remember(snapshotA);

    assert.equal(cache.reuseSourceFor(dirB), undefined, "a different root gets no source");

    const snapshotB = await createWorkspaceSnapshot(dirB, snapshotOptions);
    cache.remember(snapshotB);
    assert.equal(cache.current()?.cwd, resolve(dirB), "the entry moves to the newest completed root");
    assert.equal(cache.reuseSourceFor(dirB), snapshotB);
    assert.equal(cache.reuseSourceFor(dirA), undefined, "the old root is no longer served");
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("clear drops the retained source for a session boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-reuse-cache-clear-"));
  try {
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    const cache = new CompletedSnapshotCache();
    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    cache.remember(snapshot);
    assert.equal(cache.current()?.snapshot, snapshot);

    cache.clear();
    assert.equal(cache.current(), undefined, "the source is gone after a boundary");
    assert.equal(cache.reuseSourceFor(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
