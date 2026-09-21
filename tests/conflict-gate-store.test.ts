import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ConflictGateStore, type ConflictGate } from "../src/execution/conflict-gate-store";
import { sourceMutationCoordinator } from "../src/execution/source-mutation-lease";

function gate(overrides: Partial<ConflictGate> = {}): ConflictGate {
  return {
    executionId: "exec-1",
    taskId: "task-1",
    sourceRoot: "/tmp/gate-root",
    paths: ["conflicted.txt"],
    activatedAt: new Date().toISOString(),
    manifestPath: "/tmp/gate-root/conflict-manifest.json",
    reason: "test gate",
    ...overrides,
  };
}

test("conflict gate store keys gates to the resolved source root and isolates targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-store-"));
  try {
    const store = new ConflictGateStore();
    // A non-normalized path that resolves to the same root keys to the same slot.
    const relative = `${root}${sep}nested${sep}..`;
    store.install(gate({ sourceRoot: relative, executionId: "exec-a", taskId: "task-a", reason: "first" }));
    assert.equal(store.size, 1);
    // Installing the same root again releases only that root's prior block.
    store.install(gate({ sourceRoot: root, executionId: "exec-b", taskId: "task-b", reason: "second" }));
    assert.equal(store.size, 1);
    assert.deepEqual(sourceMutationCoordinator.blocked(root), { blocked: true, reason: "second" });
    // A different target keeps its own gate and block untouched.
    const other = await mkdtemp(join(tmpdir(), "pi-review-gate-store-other-"));
    try {
      store.install(gate({ sourceRoot: other, executionId: "exec-c", taskId: "task-c" }));
      assert.equal(store.size, 2);
      assert.deepEqual(sourceMutationCoordinator.blocked(root), { blocked: true, reason: "second" });
      assert.equal(store.forExecution("exec-b")?.taskId, "task-b");
      assert.equal(store.forExecution("exec-c")?.taskId, "task-c");
      assert.equal(store.forTask("exec-b", "task-b")?.taskId, "task-b");
      assert.equal(store.forTask("exec-c", "task-b"), undefined);
      assert.deepEqual(store.list().map((entry) => entry.executionId).sort(), ["exec-b", "exec-c"]);
      // Clearing one target's entry never clears another.
      const entries = store.entries();
      const otherEntry = entries.find((entry) => entry.gate.sourceRoot === other)!;
      store.delete(otherEntry.key);
      otherEntry.release();
      assert.equal(store.size, 1);
      assert.equal(store.forExecution("exec-c"), undefined);
      assert.equal(store.forExecution("exec-b")?.taskId, "task-b");
      assert.deepEqual(sourceMutationCoordinator.blocked(root), { blocked: true, reason: "second" });
    } finally {
      store.clear();
      assert.equal(store.size, 0);
      assert.deepEqual(sourceMutationCoordinator.blocked(root), { blocked: false });
      assert.deepEqual(sourceMutationCoordinator.blocked(other), { blocked: false });
      await rm(other, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflict gate store validation reports markers and preserved sidecars per gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-validate-"));
  const other = await mkdtemp(join(tmpdir(), "pi-review-gate-validate-other-"));
  const store = new ConflictGateStore();
  try {
    const conflicted = join(root, "conflicted.txt");
    await writeFile(conflicted, "<<<<<<< current workspace\nours\n=======\ntheirs\n>>>>>>> subtask\n", "utf8");
    const resolved = join(root, "resolved.txt");
    await writeFile(resolved, "resolved\n", "utf8");
    store.install(gate({
      sourceRoot: root,
      paths: ["conflicted.txt", "resolved.txt", "preserved.bin"],
      sidecars: [{ path: "preserved.bin" }, { path: "recorded.bin" }],
    }));
    // Sole gate: the message keeps its unprefixed shape; the preserved path is
    // excluded from the marker scan and record-only sidecars are not checked.
    assert.deepEqual(await store.unresolvedReasons(), ["conflicted.txt"]);

    await writeFile(conflicted, "resolved\n", "utf8");
    // A sidecar still present keeps the clearance blocked with the exact
    // single-gate message.
    const sidecarPath = join(root, "preserved.bin.worker-version");
    await writeFile(sidecarPath, "worker bytes\n", "utf8");
    store.install(gate({
      sourceRoot: root,
      paths: ["preserved.bin"],
      sidecars: [{ path: "preserved.bin", sidecarPath }],
    }));
    assert.deepEqual(await store.unresolvedReasons(), [
      `preserved conflict preserved.bin still has its worker version saved alongside at ${sidecarPath}; choose a side and remove the other file`,
    ]);

    // Several outstanding gates: every dirty root is named so one unresolved
    // target cannot clear another.
    store.install(gate({ sourceRoot: other, executionId: "exec-2", taskId: "task-2", paths: ["also-conflicted.txt"] }));
    const otherConflicted = join(other, "also-conflicted.txt");
    await writeFile(otherConflicted, "<<<<<<< current\nours\n=======\ntheirs\n>>>>>>> subtask\n", "utf8");
    const reasons = await store.unresolvedReasons();
    assert.equal(reasons.length, 2);
    assert.deepEqual([...reasons].sort(), [
      `${root}: preserved conflict preserved.bin still has its worker version saved alongside at ${sidecarPath}`,
      `${other}: also-conflicted.txt`,
    ].sort());
  } finally {
    store.clear();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});