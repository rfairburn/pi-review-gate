import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assignExecutorToolCatalog,
  createExecutorToolCatalog,
  createPiWorkerToolCatalog,
  defaultExecutorInitialActiveTools,
  normalizeExecutorToolCatalog,
  normalizeToolNames,
  rejectPreCutoverRequestFields,
  resolveExecutorToolCatalog,
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
  assert.deepEqual(
    defaultExecutorInitialActiveTools(["WebSearch", "read", "ApplyPatch", "bash"]),
    ["read", "bash", "ApplyPatch"],
  );
});

test("Pi worker catalogs remove orchestrator-only delegation controls without mutating the durable catalog", () => {
  const durable = createExecutorToolCatalog(
    ["read", "bash", "SubtasksStart", "SubtasksInspect", "WebSearch"],
    ["read", "bash", "SubtasksStart"],
  );
  const worker = createPiWorkerToolCatalog(durable);
  assert.deepEqual(worker, {
    allowedToolCatalog: ["read", "bash", "WebSearch"],
    initialActiveTools: ["read", "bash"],
  });
  assert.deepEqual(durable.allowedToolCatalog, ["read", "bash", "SubtasksStart", "SubtasksInspect", "WebSearch"]);
});

test("records persist only the canonical catalog without compatibility mirrors", () => {
  const taskDefinition = definition();
  assignExecutorToolCatalog(taskDefinition, createExecutorToolCatalog(["read", "bash"], ["read"]));
  assert.deepEqual(taskDefinition.executorToolCatalog, {
    allowedToolCatalog: ["read", "bash"],
    initialActiveTools: ["read"],
  });
  assert.equal("executorAllowedTools" in taskDefinition, false);
  assert.equal("executorInitialActiveTools" in taskDefinition, false);
});

test("doubled records consume the validated canonical catalog and ignore stale legacy copies", () => {
  const doubled = definition();
  assignExecutorToolCatalog(doubled, createExecutorToolCatalog(["read", "bash"], ["read"]));
  (doubled as unknown as Record<string, unknown>).executorAllowedTools = ["read", "bash", "write"];
  (doubled as unknown as Record<string, unknown>).executorInitialActiveTools = ["read", "bash"];
  const catalog = normalizeExecutorToolCatalog(doubled);
  assert.deepEqual(catalog, {
    allowedToolCatalog: ["read", "bash"],
    initialActiveTools: ["read"],
  });
  // The canonical contract is revalidated and rewritten; the stale copies are
  // ignored, never migrated or compared against it.
  assert.deepEqual(doubled.executorToolCatalog, catalog);
});

test("old-only task records fail explicitly instead of restoring full-active behavior", () => {
  const legacy = definition();
  (legacy as unknown as Record<string, unknown>).executorAllowedTools = ["read", "bash"];
  assert.throws(
    () => normalizeExecutorToolCatalog(legacy),
    /Unsupported pre-cutover executor tool catalog/,
  );
});

test("records without any catalog fields remain legitimate no-catalog contexts", () => {
  assert.equal(resolveExecutorToolCatalog(definition()), undefined);
});

test("newTask strips stale legacy mirrors from doubled input definitions", () => {
  const input = definition();
  assignExecutorToolCatalog(input, createExecutorToolCatalog(["read", "bash"], ["read"]));
  (input as unknown as Record<string, unknown>).executorAllowedTools = ["read", "bash", "write"];
  (input as unknown as Record<string, unknown>).executorInitialActiveTools = "malformed";
  const task = newTask(input);
  assert.deepEqual(task.definition.executorToolCatalog, {
    allowedToolCatalog: ["read", "bash"],
    initialActiveTools: ["read"],
  });
  assert.equal("executorAllowedTools" in task.definition, false);
  assert.equal("executorInitialActiveTools" in task.definition, false);
});

test("newTask rejects old-only input definitions explicitly", () => {
  const input = definition();
  (input as unknown as Record<string, unknown>).executorAllowedTools = ["read"];
  assert.throws(() => newTask(input), /Unsupported pre-cutover executor tool catalog/);
});

test("requests with a valid canonical catalog ignore stale legacy request fields", () => {
  const request = {
    executorToolCatalog: createExecutorToolCatalog(["read"], ["read"]),
    allowedTools: ["read", "write"],
    initialActiveTools: ["read", "write"],
  };
  assert.doesNotThrow(() => rejectPreCutoverRequestFields(request));
});

test("old-only requests are rejected before adapter launch", () => {
  const legacy = { allowedTools: ["read"], initialActiveTools: ["read"] } as unknown as Parameters<typeof rejectPreCutoverRequestFields>[0];
  assert.throws(
    () => rejectPreCutoverRequestFields(legacy),
    /Unsupported pre-cutover executor request/,
  );
});

test("task and operation records preserve deferred initial intent without narrowing authorization", () => {
  const taskDefinition = definition();
  assignExecutorToolCatalog(taskDefinition, createExecutorToolCatalog(["read", "bash"], ["read"]));
  const task = newTask(taskDefinition);
  assert.deepEqual(task.definition.executorToolCatalog, {
    allowedToolCatalog: ["read", "bash"],
    initialActiveTools: ["read"],
  });
  assert.equal("executorAllowedTools" in task.definition, false);
  assert.equal("executorInitialActiveTools" in task.definition, false);

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
  assert.equal("executorAllowedTools" in operation, false);
  assert.equal("executorInitialActiveTools" in operation, false);
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

test("old-only operation records fail explicitly at the durable read boundary", async () => {
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
    (operation as unknown as Record<string, unknown>).executorAllowedTools = ["read", "bash"];
    delete operation.executorToolCatalog;
    await writeFile(operationRecordPath(artifactDir), JSON.stringify(operation), "utf8");

    await assert.rejects(
      readOperationRecord(operationRecordPath(artifactDir)),
      /Unsupported pre-cutover executor tool catalog/,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
