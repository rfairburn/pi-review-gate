import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  atomicWrite,
  atomicWriteExclusive,
  setDurableWriteFaultInjectionForTesting,
  type DurableWriteStage,
} from "../src/execution/durable-write";
import {
  createOperationRecord,
  operationRecordPath,
  readOperationRecord,
  writeOperationRecord,
} from "../src/execution/operation-record";
import { persistTaskDefinition } from "../src/execution/wave-worker";
import {
  acquireWaveOwner,
  heartbeatWaveOwner,
  inspectWaveOwner,
  releaseWaveOwner,
} from "../src/execution/wave-owner";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function tempFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}

test("atomicWrite replaces target content, uses restrictive modes, and leaves no temp litter", async () => {
  const root = await tempDir("durable-write-ok-");
  try {
    const target = join(root, "nested", "record.json");
    await atomicWrite(target, "first\n");
    assert.equal(await readFile(target, "utf8"), "first\n");
    // Parent directories are created restrictively alongside the file.
    assert.equal((await stat(target)).mode & 0o777, 0o600);

    await atomicWrite(target, "second\n");
    assert.equal(await readFile(target, "utf8"), "second\n");
    assert.deepEqual(await tempFiles(root), ["nested"], "no temp files may survive a successful write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomicWrite pre-rename failures preserve old target bytes and clean temp files", async () => {
  const root = await tempDir("durable-write-fault-");
  try {
    const target = join(root, "record.json");
    await atomicWrite(target, "original bytes\n");

    const stageHooks = {
      after_temp_write: "afterTempWrite",
      after_file_sync: "afterFileSync",
      before_rename: "beforeRename",
    } as const;
    for (const stage of ["after_temp_write", "after_file_sync", "before_rename"] as const) {
      const hookKey = stageHooks[stage];
      await assert.rejects(
        atomicWrite(target, "replacement\n", { hooks: { [hookKey]: () => { throw new Error(`boom at ${stage}`); } } }),
        new RegExp(`boom at ${stage}`),
      );
      assert.equal(
        await readFile(target, "utf8"),
        "original bytes\n",
        `a ${stage} failure must leave the previous target bytes untouched`,
      );
      assert.deepEqual(await tempFiles(root), ["record.json"], `a ${stage} failure must clean its temp file`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomicWrite still reports post-rename hook failures but the new content is durable", async () => {
  const root = await tempDir("durable-write-post-");
  try {
    const target = join(root, "record.json");
    await atomicWrite(target, "old\n");
    await assert.rejects(
      atomicWrite(target, "new\n", { hooks: { afterRename: () => { throw new Error("late boom"); } } }),
      /late boom/,
    );
    assert.equal(await readFile(target, "utf8"), "new\n");
    assert.deepEqual(await tempFiles(root), ["record.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomicWrite collision at the temp path never deletes a file it does not own", async () => {
  const root = await tempDir("durable-write-collision-");
  try {
    const target = join(root, "record.json");
    await atomicWrite(target, "original bytes\n");
    // Pre-create the exact temp path this invocation will pick.
    const tempPath = `${target}.tmp.hostile-collision`;
    await writeFile(tempPath, "not ours\n", "utf8");

    await assert.rejects(
      atomicWrite(target, "replacement\n", { tempSuffixForTesting: "hostile-collision" }),
      /EEXIST/,
    );
    assert.equal(
      await readFile(tempPath, "utf8"),
      "not ours\n",
      "a pre-existing temp-path collision must be preserved, never deleted",
    );
    assert.equal(
      await readFile(target, "utf8"),
      "original bytes\n",
      "the previous target bytes must survive a temp-name collision",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomicWriteExclusive creates exclusively, fsyncs, and preserves foreign targets on collision", async () => {
  const root = await tempDir("durable-write-exclusive-");
  try {
    const target = join(root, "lease.json");
    await writeFile(target, "someone else's claim\n", "utf8");
    await assert.rejects(atomicWriteExclusive(target, "ours\n"), /EEXIST/);
    assert.equal(
      await readFile(target, "utf8"),
      "someone else's claim\n",
      "an existing exclusive target must never be clobbered or deleted",
    );
    assert.deepEqual(await tempFiles(root), ["lease.json"]);

    await atomicWriteExclusive(join(root, "fresh.json"), "claimed\n");
    assert.equal(await readFile(join(root, "fresh.json"), "utf8"), "claimed\n");
    assert.equal((await stat(join(root, "fresh.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeOperationRecord is durable: sequential writes, restrictive mode, no temp litter, injected failure keeps old record", async () => {
  const root = await tempDir("durable-op-record-");
  try {
    const record = createOperationRecord({
      waveId: "wave-durable",
      taskId: "task-0",
      title: "durable write test",
      worktreeRoot: root,
      effectiveCwd: root,
      artifactDir: root,
      retryBudget: 1,
    });
    await writeOperationRecord(record);
    const path = operationRecordPath(root);
    const afterFirst = await readFile(path, "utf8");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(afterFirst).revision, 1);

    await writeOperationRecord(record);
    assert.equal(JSON.parse(await readFile(path, "utf8")).revision, 2);
    assert.deepEqual(await tempFiles(root), ["operation.json"], "no temp litter after successful writes");

    const stage: DurableWriteStage = "before_rename";
    setDurableWriteFaultInjectionForTesting((injected) => {
      if (injected === stage) throw new Error("injected pre-rename failure");
    });
    try {
      await assert.rejects(writeOperationRecord(record), /injected pre-rename failure/);
      assert.equal(JSON.parse(await readFile(path, "utf8")).revision, 2, "old record bytes must survive");
      assert.deepEqual(await tempFiles(root), ["operation.json"], "no temp litter after failed write");
      const recovered = await readOperationRecord(path);
      assert.equal(recovered.revision, 2);
      assert.equal(recovered.operationId, "wave-durable/task-0");
    } finally {
      setDurableWriteFaultInjectionForTesting(undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wave-owner heartbeat and release writes are durable with no temp litter", async () => {
  const root = await tempDir("durable-wave-owner-");
  try {
    const lease = await acquireWaveOwner(root, "wave-durable-owner");
    assert.equal((await inspectWaveOwner(root)).status, "live");
    await heartbeatWaveOwner(root, lease);
    const path = join(root, "wave-owner.json");
    const heartbeatAt = JSON.parse(await readFile(path, "utf8")).heartbeatAt;
    assert.equal(lease.heartbeatAt, heartbeatAt);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await releaseWaveOwner(root, lease);
    assert.equal((await inspectWaveOwner(root)).status, "released");
    assert.deepEqual(await tempFiles(root), ["wave-owner.json"], "no temp litter after owner writes");

    const stage: DurableWriteStage = "after_temp_write";
    setDurableWriteFaultInjectionForTesting((injected) => {
      if (injected === stage) throw new Error("injected heartbeat failure");
    });
    try {
      lease.status = "active";
      lease.releasedAt = undefined;
      const before = await readFile(path, "utf8");
      await assert.rejects(heartbeatWaveOwner(root, lease), /injected heartbeat failure/);
      assert.equal(await readFile(path, "utf8"), before, "heartbeat failure must not damage the lease");
      assert.deepEqual(await tempFiles(root), ["wave-owner.json"]);
    } finally {
      setDurableWriteFaultInjectionForTesting(undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistTaskDefinition preserves metadata, uses restrictive mode, and keeps old bytes on failure", async () => {
  const root = await tempDir("durable-task-def-");
  try {
    const path = join(root, "task.json");
    await writeFile(path, JSON.stringify({ custom: "keep", task: null }, null, 2), "utf8");
    await persistTaskDefinition(root, {
      title: "durable task",
      instructions: "do the thing",
      acceptanceCriteria: ["done"],
    });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.custom, "keep");
    assert.equal(persisted.task.title, "durable task");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await tempFiles(root), ["task.json"], "no temp litter after task definition writes");

    const stage: DurableWriteStage = "before_rename";
    setDurableWriteFaultInjectionForTesting((injected) => {
      if (injected === stage) throw new Error("injected task-definition failure");
    });
    try {
      const before = await readFile(path, "utf8");
      await assert.rejects(
        persistTaskDefinition(root, {
          title: "second task",
          instructions: "more",
          acceptanceCriteria: [],
        }),
        /injected task-definition failure/,
      );
      assert.equal(await readFile(path, "utf8"), before, "failed write must preserve old task bytes");
      assert.deepEqual(await tempFiles(root), ["task.json"]);
    } finally {
      setDurableWriteFaultInjectionForTesting(undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("atomicWriteExclusive does not expose the final target before publication", async () => {
  const root = await tempDir("durable-write-exclusive-stage-");
  try {
    const target = join(root, "lease.json");
    await assert.rejects(
      atomicWriteExclusive(target, "claimed\n", {
        hooks: {
          afterTempWrite: async () => {
            await assert.rejects(readFile(target, "utf8"), /ENOENT/);
            throw new Error("stop before publication");
          },
        },
      }),
      /stop before publication/,
    );
    await assert.rejects(readFile(target, "utf8"), /ENOENT/);
    assert.deepEqual(await tempFiles(root), [], "only the owned staged temp may exist, and it must be cleaned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acquireWaveOwner keeps exclusive claim semantics and cleans partial leases on failure", async () => {
  const root = await tempDir("durable-wave-acquire-");
  try {
    // A concurrent claim while a live owner holds the lease must fail.
    const lease = await acquireWaveOwner(root, "wave-acquire-a");
    await assert.rejects(
      acquireWaveOwner(root, "wave-acquire-b"),
      /Cannot acquire wave ownership/,
    );
    assert.equal(
      (await inspectWaveOwner(root)).status,
      "live",
      "the failed concurrent claim must not damage the live lease",
    );
    await releaseWaveOwner(root, lease);

    // A released lease must be reclaimable through the EEXIST -> inspect
    // (released) -> unlink -> retry path.
    const reclaimed = await acquireWaveOwner(root, "wave-acquire-c");
    assert.equal((await inspectWaveOwner(root)).status, "live");
    await releaseWaveOwner(root, reclaimed);
    assert.deepEqual(await tempFiles(root), ["wave-owner.json"]);

    // A failure before publication leaves no final record (only the owned temp
    // file existed, and it is cleaned), so later acquisition is not blocked by
    // a corrupt record. Use a fresh root so no prior lease file is present.
    const cleanRoot = await tempDir("durable-wave-acquire-clean-");
    try {
      const stage: DurableWriteStage = "after_temp_write";
      setDurableWriteFaultInjectionForTesting((injected) => {
        if (injected === stage) throw new Error("injected acquisition failure");
      });
      try {
        await assert.rejects(acquireWaveOwner(cleanRoot, "wave-acquire-b"), /injected acquisition failure/);
        const status = await inspectWaveOwner(cleanRoot);
        assert.equal(status.status, "uncertain");
        assert.match(status.message, /No durable wave ownership lease exists/);
        assert.deepEqual(await tempFiles(cleanRoot), [], "no partial lease may survive a failed acquisition");
        setDurableWriteFaultInjectionForTesting(undefined);
        const retry = await acquireWaveOwner(cleanRoot, "wave-acquire-b");
        assert.equal((await inspectWaveOwner(cleanRoot)).status, "live");
        await releaseWaveOwner(cleanRoot, retry);
        assert.deepEqual(await tempFiles(cleanRoot), ["wave-owner.json"]);
      } finally {
        setDurableWriteFaultInjectionForTesting(undefined);
      }
    } finally {
      await rm(cleanRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
