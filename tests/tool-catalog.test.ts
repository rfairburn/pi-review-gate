import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assignExecutorToolCatalog,
  createExecutorToolCatalog,
  normalizeExecutorToolCatalog,
  normalizeToolNames,
} from "../src/execution/tool-catalog";
import { newTask } from "../src/execution/task-state";
import { createOperationRecord, operationRecordPath, readOperationRecord } from "../src/execution/operation-record";
import { synchronizeTaskAndOperationToolCatalog, type WaveWorkerTask } from "../src/execution/wave-worker";

const definition = (): WaveWorkerTask => ({
  title: "bounded task",
  instructions: "do it",
  acceptanceCriteria: ["done"],
});

test("tool catalog normalization is stable, deduplicated, and subset validated", () => {
  assert.deepEqual(normalizeToolNames([" bash ", "read", "bash", " read "]), ["bash", "read"]);
  assert.deepEqual(
    createExecutorToolCatalog(["read", "bash", "read"], ["bash", "bash"]),
    { allowedToolCatalog: ["read", "bash"], initialActiveTools: ["bash"] },
  );
  assert.throws(
    () => createExecutorToolCatalog(["read"], ["read", "write"]),
    /must be a subset/,
  );
  assert.throws(() => normalizeToolNames([" "]), /must not be empty/);
});

test("legacy allowed-only task records restore with every authorized tool active", () => {
  const legacy = { ...definition(), executorAllowedTools: ["read", "bash", "read"] };
  const catalog = normalizeExecutorToolCatalog(legacy);
  assert.deepEqual(catalog, {
    allowedToolCatalog: ["read", "bash"],
    initialActiveTools: ["read", "bash"],
  });
  assert.deepEqual(legacy.executorAllowedTools, ["read", "bash"]);
  assert.deepEqual(legacy.executorInitialActiveTools, ["read", "bash"]);
  assert.deepEqual(legacy.executorToolCatalog, catalog);
});

test("task and operation records preserve future initial intent without narrowing authorization", () => {
  const taskDefinition = definition();
  assignExecutorToolCatalog(taskDefinition, createExecutorToolCatalog(["read", "bash"], ["read"]));
  const task = newTask(taskDefinition);
  assert.deepEqual(task.definition.executorToolCatalog, {
    allowedToolCatalog: ["read", "bash"],
    initialActiveTools: ["read"],
  });
  assert.deepEqual(task.definition.executorAllowedTools, ["read", "bash"]);

  const operation = createOperationRecord({
    waveId: "wave-1",
    taskId: task.taskId,
    title: task.definition.title,
    worktreeRoot: "/tmp/worker",
    effectiveCwd: "/tmp/worker",
    artifactDir: "/tmp/artifacts",
    retryBudget: 2,
    executorToolCatalog: task.definition.executorToolCatalog,
  });
  assert.deepEqual(operation.executorToolCatalog, {
    allowedToolCatalog: ["read", "bash"],
    initialActiveTools: ["read"],
  });
  assert.deepEqual(operation.executorAllowedTools, ["read", "bash"]);
  assert.deepEqual(operation.executorInitialActiveTools, ["read"]);
});

test("task/operation recovery fails closed on divergent durable catalogs", () => {
  const task = definition();
  assignExecutorToolCatalog(task, createExecutorToolCatalog(["read"], ["read"]));
  const operation = createOperationRecord({
    waveId: "wave-mismatch",
    taskId: "task-mismatch",
    title: task.title,
    worktreeRoot: "/tmp/worker",
    effectiveCwd: "/tmp/worker",
    artifactDir: "/tmp/artifacts",
    retryBudget: 1,
    executorToolCatalog: createExecutorToolCatalog(["read", "bash"], ["read", "bash"]),
  });
  assert.throws(
    () => synchronizeTaskAndOperationToolCatalog(task, operation),
    /mismatch between durable task and operation records/,
  );
});

test("older operation records without the canonical field restore full-active", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "tool-catalog-operation-"));
  try {
    const operation = createOperationRecord({
      waveId: "wave-legacy",
      taskId: "task-legacy",
      title: "legacy",
      worktreeRoot: artifactDir,
      effectiveCwd: artifactDir,
      artifactDir,
      retryBudget: 1,
    });
    operation.executorAllowedTools = ["read", "bash", "read"];
    delete operation.executorToolCatalog;
    delete operation.executorInitialActiveTools;
    await writeFile(operationRecordPath(artifactDir), JSON.stringify(operation), "utf8");

    const restored = await readOperationRecord(operationRecordPath(artifactDir));
    assert.deepEqual(restored.executorToolCatalog, {
      allowedToolCatalog: ["read", "bash"],
      initialActiveTools: ["read", "bash"],
    });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
