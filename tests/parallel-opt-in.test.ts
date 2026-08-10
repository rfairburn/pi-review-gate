import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

// ── Activation opt-in tests ──────────────────────────────────────────────────

test("execute_subtasks is inactive by default even with resolvable executor", () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools = ["read"];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next: string[]) {
      activeTools = next;
    },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: {
      activeExecutor: { source: "external", id: "fake" },
      // parallelEnabled not set — defaults to false
    },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
  });

  manager.sync();
  // Both tools registered (because executor is resolvable), but only execute_subtask is active.
  assert.equal(registered.length, 2);
  assert.equal(registered[0].name, "execute_subtask");
  assert.equal(registered[1].name, "execute_subtasks");
  // execute_subtask is active, execute_subtasks is not.
  assert.ok(activeTools.includes("execute_subtask"));
  assert.ok(!activeTools.includes("execute_subtasks"));
});

test("execute_subtasks is active only with parallelEnabled=true", () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools = ["read"];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next: string[]) {
      activeTools = next;
    },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: {
      activeExecutor: { source: "external", id: "fake" },
      parallelEnabled: true,
    },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
  });

  manager.sync();
  assert.equal(registered.length, 2);
  assert.ok(activeTools.includes("execute_subtask"));
  assert.ok(activeTools.includes("execute_subtasks"));
});

test("execute_subtask activation is unchanged without parallelEnabled", () => {
  const registered: Array<Record<string, unknown>> = [];
  let activeTools = ["read"];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next: string[]) {
      activeTools = next;
    },
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" },
    }],
    execution: {
      activeExecutor: { source: "external", id: "fake" },
    },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
  });

  manager.sync();
  assert.ok(activeTools.includes("execute_subtask"));
});

// ── Config normalization tests ───────────────────────────────────────────────

test("parallelEnabled is normalized as boolean", () => {
  const truthy = normalizeConfig({
    enabled: true,
    execution: { parallelEnabled: true },
  });
  assert.equal(truthy.execution?.parallelEnabled, true);

  const falsy = normalizeConfig({
    enabled: true,
    execution: { parallelEnabled: false },
  });
  assert.equal(falsy.execution?.parallelEnabled, false);
});

test("parallelEnabled defaults to undefined (effectively false)", () => {
  const config = normalizeConfig({
    enabled: true,
    execution: { activeExecutor: null },
  });
  assert.equal(config.execution?.parallelEnabled, undefined);
});

// ── Settings persistence tests ───────────────────────────────────────────────

test("settings persistence includes parallelEnabled", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { persistReviewSettings } = await import("../src/settings/persistence");

  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-parallel-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: null },
  }), "utf8");

  const next = await persistReviewSettings(configPath, {
    activeExecutor: null,
    activeReviewers: [],
    reviewerTimeoutMs: 600000,
    executorTimeoutMs: 1800000,
    maxCorrectionCycles: 1,
    implementationGuidanceAfterCorrectionAttempts: 1,
    retainBundles: "on-failure",
    maxWorkers: 2,
    parallelEnabled: true,
  });

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.execution.parallelEnabled, true);
  assert.equal(next.execution?.parallelEnabled, true);

  await rm(dir, { recursive: true, force: true });
});

// ── Snapshot disclosure tests ────────────────────────────────────────────────

test("manifest includes snapshot policy disclosure", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const dir = await mkdtemp(join(tmpdir(), "pi-review-manifest-"));
  try {
    // Initialize a git repo
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "hello\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });

    // Run a wave with 1 task
    const { executeWave } = await import("../src/execution/wave-controller");
    const { normalizeConfig } = await import("../src/config");

    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      execution: { activeExecutor: null },
    });

    const progressUpdates: Array<Record<string, any>> = [];
    const result = await executeWave({
      cwd: dir,
      tasks: [{
        title: "test",
        instructions: "noop",
        acceptanceCriteria: ["done"],
      }],
      config,
      scopedModels: [],
      maxWorkers: 1,
      onProgress: (update) => progressUpdates.push(update as Record<string, any>),
    });

    // Read the manifest
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(join(result.waveRoot, "wave-manifest.json"), "utf8"));
    assert.equal(manifest.snapshotPolicy, "non-ignored untracked included; ignored files excluded");
    assert.equal(manifest.includesUntracked, true);
    assert.equal(manifest.excludesIgnored, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── HEAD drift visibility tests ──────────────────────────────────────────────

test("landing outcome includes source HEAD drift", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const dir = await mkdtemp(join(tmpdir(), "pi-review-head-drift-"));
  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "hello\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });

    const { executeWave } = await import("../src/execution/wave-controller");

    // Slow writing executor: writes output.txt after a 2s delay, giving a
    // window to commit to the source repo while the wave is running.
    const config: Record<string, any> = {
      enabled: false,
      reviewerTimeoutMs: 600_000,
      executorTimeoutMs: 1_800_000,
      maxCorrectionCycles: 0,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200_000,
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
      retainBundles: "never",
      execution: {
        activeExecutor: { source: "external", id: "fake-slow-writer" },
        externalExecutors: [{
          id: "fake-slow-writer",
          adapter: "run-as-binary",
          protocol: "pi-review-executor-jsonl-v1",
          command: process.execPath,
          args: ["-e", [
            "process.stdin.resume();",
            "process.stdin.on('data',()=>{});",
            "process.stdin.on('end',()=>{",
            "  setTimeout(()=>{",
            '    const fs=require("fs");',
            '    const p=require("path").join(process.cwd(),"output.txt");',
            '    fs.writeFileSync(p,"hello from worker\\n");',
            '    process.stdout.write(JSON.stringify({type:"session",sessionId:"fake"})+"\\n");',
            '    process.stdout.write(JSON.stringify({type:"assistant",text:"Done."})+"\\n");',
            "    process.exit(0);",
            "  }, 2000);",
            "});",
          ].join("")],
          timeoutMs: 10000,
        }],
      },
    };

    // Wait for a worker progress/start signal after capture, not a fixed sleep.
    let workerStarted = false;
    let resolveWorkerStarted!: () => void;
    const workerStartPromise = new Promise<void>((resolve) => {
      resolveWorkerStarted = resolve;
    });

    const wavePromise = executeWave({
      cwd: dir,
      tasks: [{ title: "test", instructions: "noop", acceptanceCriteria: ["done"] }],
      config: config as any,
      scopedModels: [],
      maxWorkers: 1,
      onProgress: (update) => {
        // Wait for the worker to enter executing phase (deterministic signal).
        if (update.subtask?.phase === "executing" && !workerStarted) {
          workerStarted = true;
          resolveWorkerStarted();
        }
      },
    });

    // Wait for worker start signal, then commit to source to create drift.
    await workerStartPromise;
    await writeFile(join(dir, "drift.txt"), "drift\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "drift"], { cwd: dir });

    const result = await wavePromise;
    assert.equal(result.landing?.status, "landed");
    assert.equal(result.landing?.headDrift?.drifted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Progress counts/activity tests ───────────────────────────────────────────

test("progress updates include counts and bounded activity", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const dir = await mkdtemp(join(tmpdir(), "pi-review-progress-"));
  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "hello\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir });

    const { executeWave } = await import("../src/execution/wave-controller");
    const { normalizeConfig } = await import("../src/config");

    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      execution: { activeExecutor: null },
    });

    const progressUpdates: Array<Record<string, any>> = [];
    await executeWave({
      cwd: dir,
      tasks: [{
        title: "test",
        instructions: "noop",
        acceptanceCriteria: ["done"],
      }],
      config,
      scopedModels: [],
      maxWorkers: 1,
      onProgress: (update) => progressUpdates.push(update as Record<string, any>),
    });

    // Verify at least one update has counts
    const updateWithCounts = progressUpdates.find((u) => u.counts !== undefined);
    assert.ok(updateWithCounts, "At least one progress update should have counts");
    assert.ok(typeof updateWithCounts.counts.queued === "number");
    assert.ok(typeof updateWithCounts.counts.running === "number");
    assert.ok(typeof updateWithCounts.counts.accepted === "number");
    assert.ok(typeof updateWithCounts.counts.failed === "number");

    // Verify at least one update has activity
    const updateWithActivity = progressUpdates.find((u) => u.activity !== undefined);
    assert.ok(updateWithActivity, "At least one progress update should have activity");
    assert.ok(Array.isArray(updateWithActivity.activity));
    assert.ok(updateWithActivity.activity.length <= 40, "Activity should be bounded to 40 entries");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── String false normalization test ──────────────────────────────────────────

test("parallelEnabled rejects non-boolean values", () => {
  assert.throws(
    () => normalizeConfig({ enabled: true, execution: { parallelEnabled: "false" } }),
    { message: /execution.parallelEnabled must be a boolean/ },
  );
  assert.throws(
    () => normalizeConfig({ enabled: true, execution: { parallelEnabled: "true" } }),
    { message: /execution.parallelEnabled must be a boolean/ },
  );
  assert.throws(
    () => normalizeConfig({ enabled: true, execution: { parallelEnabled: 0 } }),
    { message: /execution.parallelEnabled must be a boolean/ },
  );
  assert.throws(
    () => normalizeConfig({ enabled: true, execution: { parallelEnabled: 1 } }),
    { message: /execution.parallelEnabled must be a boolean/ },
  );
  assert.throws(
    () => normalizeConfig({ enabled: true, execution: { parallelEnabled: null } }),
    { message: /execution.parallelEnabled must be a boolean/ },
  );
  assert.throws(
    () => normalizeConfig({ enabled: true, execution: { parallelEnabled: "yes" } }),
    { message: /execution.parallelEnabled must be a boolean/ },
  );
});
