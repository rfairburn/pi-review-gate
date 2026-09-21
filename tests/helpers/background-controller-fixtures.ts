/** Shared setup for the background-controller test suites (split out of the
 *  former monolithic tests/background-controller.test.ts). Every helper drives
 *  the real production controller and adapter paths — this module only
 *  arranges fixtures, waits, and fault-injection seams shared across files. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BackgroundExecutionController,
  isArchivableTaskState,
  type BackgroundExecutionGroup,
  type BackgroundFaultHooks,
  type BackgroundInspection,
  type BackgroundTaskRecord,
} from "../../src/execution/background-controller";
import { normalizeConfig } from "../../src/config";
import { transitionTaskState } from "../../src/execution/task-state";
import { createState } from "../../src/state";

const execFileAsync = promisify(execFile);

/** Shared git fixture setup: initialize a throwaway repo and, when entries
 *  are given, write and commit them (default: a single base.txt). The command
 *  order matches the inline setup the original suites used. */
export async function initGitRepo(
  root: string,
  entries: Record<string, string> = { "base.txt": "base\n" },
): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  const names = Object.keys(entries);
  for (const [name, content] of Object.entries(entries)) {
    await writeFile(join(root, name), content, "utf8");
  }
  if (names.length > 0) {
    await execFileAsync("git", ["add", ...names], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
  }
}


export async function setupInterruptedMergeTask(
  unique: string,
  pi?: unknown,
  options?: { notificationMode?: "quiet" | "noisy"; interruptInSetup?: boolean },
): Promise<{
  root: string;
  controller: BackgroundExecutionController;
  started: BackgroundInspection;
  taskId: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-background-merge-${unique}-`));
  await initGitRepo(root);
  const executor = join(root, "merge-executor.cjs");
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
    "fs.writeFileSync('draft.txt','recover me\\n');",
    "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "slow-merge": {
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" }
      }
    },
    execution: {
      ...(options?.notificationMode ? { subtaskNotifications: options.notificationMode } : {}),
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "slow-merge" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
  const controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: pi ?? {} });
  const started = await controller.start([{
    title: "merge target",
    instructions: "write draft.txt",
    acceptanceCriteria: ["draft.txt exists"],
  }]);
  const taskId = started.tasks[0]!.taskId;
  await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "running");
  await waitForAsync(async () => {
    const waveRoot = controller.inspect(started.executionId, taskId).tasks[0]?.waveRoot;
    if (!waveRoot) return false;
    return readFile(join(waveRoot, "workers", taskId, "draft.txt"), "utf8").then(() => true, () => false);
  });
  if (options?.interruptInSetup !== false) {
    const interrupted = await controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: `setup-interrupt-${unique}`,
      actor: "user",
    });
    assert.equal(interrupted.tasks[0]?.state, "interrupted");
  }
  return {
    root,
    controller,
    started,
    taskId,
    cleanup: async () => {
      await controller.shutdown().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function setupFaultScenario(faults: BackgroundFaultHooks): Promise<{
  root: string;
  controller: BackgroundExecutionController;
  started: BackgroundInspection;
  messages: string[];
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-fault-"));
  await initGitRepo(root);
  const executor = join(root, "fault-executor.cjs");
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    "fs.writeFileSync('fault.txt','landed before bookkeeping failure\\n');",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "fault-fake": {
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" }
      }
    },
    execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "fault-fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
  const messages: string[] = [];
  const controller = new BackgroundExecutionController({
    pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
    config,
    state: createState(),
    cwd: () => root,
    notify: (message) => {
      messages.push(message);
    },
    faults,
  });
  const started = await controller.start([{
    title: "fault scenario",
    instructions: "LAND_SENTINEL",
    acceptanceCriteria: ["fault.txt exists"],
  }]);
  return {
    root,
    controller,
    started,
    messages,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ── Finding 15: bounded execution persistence and top-off scaling ──────────

/** Controller harness for bounded-scaling tests: an executor route exists but
 *  maxWorkers is 0, so nothing is ever dispatched and settlement is injected
 *  deterministically. */
export function boundedScalingConfig() {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "unstarted": {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] }
      }
    },
    execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
  // Nothing may ever dispatch in these tests: settlement is injected directly.
  config.execution!.maxWorkers = 0;
  return config;
}

export function controllerInternals(controller: BackgroundExecutionController): {
  groups: Map<string, BackgroundExecutionGroup>;
  activeTasks: Map<string, unknown>;
  archivedTasks: Map<string, unknown>;
  save: (group: BackgroundExecutionGroup) => Promise<unknown>;
  wake: (task: BackgroundTaskRecord, kind: "completion" | "failure" | "state", content: string) => Promise<void>;
} {
  return controller as unknown as {
    groups: Map<string, BackgroundExecutionGroup>;
    activeTasks: Map<string, unknown>;
    archivedTasks: Map<string, unknown>;
    save: (group: BackgroundExecutionGroup) => Promise<unknown>;
    wake: (task: BackgroundTaskRecord, kind: "completion" | "failure" | "state", content: string) => Promise<void>;
  };
}

/** Settles the oldest unsettled task directly and saves the group. */
export async function settleOldestUnsettled(
  controller: BackgroundExecutionController,
  executionId: string,
  label: string,
): Promise<BackgroundTaskRecord> {
  const internals = controllerInternals(controller);
  const group = internals.groups.get(executionId)!;
  const target = group.tasks.find((task) => !isArchivableTaskState(task.state));
  assert.ok(target, "an unsettled task is available to settle");
  transitionTaskState(target, "landed");
  target.summary = `settled outcome ${label}`;
  await internals.save(group);
  return target;
}

export async function waitForLandedDurableRecord(
  started: BackgroundInspection,
  requiredPhase: string,
): Promise<void> {
  await waitForAsync(async () => {
    try {
      const archive = JSON.parse(
        await readFile(join(started.root, "tasks", `${started.tasks[0]?.taskId}.json`), "utf8"),
      ) as {
        task: { state: string; activity?: Array<{ phase: string; message: string }> };
      };
      if (archive.task?.state !== "landed") return false;
      return archive.task.activity?.some((event) => event.phase === requiredPhase && /landed outcome is preserved/.test(event.message)) === true;
    } catch {
      return false;
    }
  });
}

/** Await a promise that must settle within a finite deadline (e.g. a start call that must not block on worker completion). */
export async function awaitBounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  // If the deadline wins the race, keep the losing promise from surfacing as
  // an unhandled rejection while the failure-path teardown runs.
  void promise.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for background task state");
}

export async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for asynchronous background task state");
}

export function collidingTaskRecord(taskId: string, createdAt: string, updatedAt: string, summary: string): BackgroundTaskRecord {
  return {
    taskId,
    definition: { title: "colliding archived task", instructions: "shared work", acceptanceCriteria: ["done"] },
    state: "landed",
    createdAt,
    updatedAt,
    generation: 0,
    summary,
    activity: [],
    nextActivitySequence: 1,
    stateHistory: [{ sequence: 1, state: "queued", at: createdAt, generation: 0 }],
    nextStateSequence: 2,
    commands: [],
  };
}

export async function writePersistedExecutionGroupTasks(
  groupRoot: string,
  groupCwd: string,
  executionId: string,
  tasks: BackgroundTaskRecord[],
): Promise<void> {
  const payloads = tasks.map((task) => {
    const archiveUnsigned = {
      version: 1 as const,
      taskId: task.taskId,
      archivedAt: task.updatedAt,
      task,
    };
    const archiveIntegritySha256 = createHash("sha256").update(JSON.stringify(archiveUnsigned)).digest("hex");
    return {
      archiveUnsigned,
      archiveIntegritySha256,
      reference: {
        archived: true,
        taskId: task.taskId,
        title: task.definition.title,
        state: task.state as "landed",
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        summary: task.summary,
        timing: { queueMs: 1, captureMs: 0, executionMs: 0, reviewMs: 0, landingMs: 0, totalMs: 0 },
        archivePath: join("tasks", `${task.taskId}.json`),
        archiveIntegritySha256,
      },
    };
  });
  const unsigned = {
    version: 2 as const,
    revision: 0,
    executionId,
    kind: "execute" as const,
    root: groupRoot,
    cwd: groupCwd,
    createdAt: tasks[0]!.createdAt,
    updatedAt: tasks.at(-1)!.updatedAt,
    peakConcurrency: 1,
    tasks: payloads.map((payload) => payload.reference),
  };
  const snapshot = { ...unsigned, integritySha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") };
  await mkdir(join(groupRoot, "tasks"), { recursive: true });
  for (const payload of payloads) {
    await writeFile(
      join(groupRoot, "tasks", `${payload.reference.taskId}.json`),
      `${JSON.stringify({ ...payload.archiveUnsigned, integritySha256: payload.archiveIntegritySha256 }, null, 2)}\n`,
      "utf8",
    );
  }
  await writeFile(join(groupRoot, "execution.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function writePersistedExecutionGroup(
  groupRoot: string,
  groupCwd: string,
  executionId: string,
  task: BackgroundTaskRecord,
): Promise<void> {
  await writePersistedExecutionGroupTasks(groupRoot, groupCwd, executionId, [task]);
}

export function renderWidget(content: unknown, width = 240): string[] {
  assert.equal(typeof content, "function");
  const component = (content as () => { render(width: number): string[] })();
  return component.render(width);
}


export interface SubtaskEventMessage {
  customType?: string;
  content: string;
}

export function subtaskEvents(messages: SubtaskEventMessage[]): SubtaskEventMessage[] {
  return messages.filter((message) => message.customType === "pi-review-subtask-event");
}

/** Completion wakes only. The two markers below exist solely in
 * completionGroupAggregateLines — the aggregate block appended to completion
 * wakes (and folded into synchronous tool results) — while state wakes reuse
 * similar "not yet landed" wording and failure wakes use the curated
 * diagnostic preamble. This keeps counts exact in noisy mode, where ordinary
 * RUNNING/REVIEWING state wakes are delivered too. */
export function completionEvents(messages: SubtaskEventMessage[]): SubtaskEventMessage[] {
  return subtaskEvents(messages).filter((message) =>
    message.content.includes("All requested task outputs have landed; aggregate verification is now appropriate.")
    || message.content.includes("This is a partial task completion, not completion of the whole group."));
}

/** Failure wakes only (curated diagnostic preamble), distinct from the state
 * transitions noisy mode additionally delivers. */
export function failureEvents(messages: SubtaskEventMessage[]): SubtaskEventMessage[] {
  return subtaskEvents(messages).filter((message) => message.content.includes("requires recovery attention"));
}

/** One-shot watch checkpoints, delivered on their own custom type. */
export function watchEvents(messages: SubtaskEventMessage[]): SubtaskEventMessage[] {
  return messages.filter((message) => message.customType === "pi-review-subtask-watch");
}
