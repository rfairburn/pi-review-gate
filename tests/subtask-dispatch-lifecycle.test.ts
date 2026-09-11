import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  BackgroundExecutionController,
  isActiveTaskState,
  type SubtaskCardDispatchView,
} from "../src/execution/background-controller";
import { hasDispatchCardWatcher, notifyDispatchCards, resetDispatchCardsForTests, watchDispatchCards } from "../src/execution/dispatch-cards";
import type { SubtaskDispatchRecord } from "../src/execution/types";
import { runWaveWorker } from "../src/execution/wave-worker";
import { captureWaveBase, type WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree } from "../src/execution/wave-worktrees";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

// #93: actual dispatch capture and original SubtasksStart/SubtasksAdd card
// lifecycle. These tests exercise the real production path — queued tool
// return, executor transport dispatch, durable task records, dispatch events,
// and the native renderer-context card update route — with a fake
// run-as-binary executor that records the exact prompt it receives on stdin.

const execFileAsync = promisify(execFile);
const identityTheme = { bold: (value: string) => value, fg: (_color: string, value: string) => value };

type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

async function mkRepo(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "base.txt"), "base\n", "utf8");
  await execFileAsync("git", ["add", "base.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

/**
 * Fake executor that records the exact prompt text the transport delivers to
 * its stdin (the far end of the authoritative dispatch boundary), optionally
 * fails the requested turn once to exercise re-dispatch, and emits a valid
 * run-as-binary protocol response.
 */
async function writeRecordingExecutor(root: string, options: { stdinCapture: string; failTurn?: number; delayMs?: number; holdPattern?: string }): Promise<void> {
  const executor = join(root, "dispatch-executor.cjs");
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');",
    `const capture=${JSON.stringify(options.stdinCapture)};`,
    "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    `  const failTurn=${options.failTurn ?? 0};`,
    `  const holdPattern=${JSON.stringify(options.holdPattern ?? "")};`,
    `  const baseDelay=${options.delayMs ?? 0};`,
    "  const delay=holdPattern&&prompt.includes(holdPattern)?30000:baseDelay;",
    "  const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN||'1');",
    "  fs.writeFileSync(capture+'.'+turn,prompt);",
    "  if(failTurn&&turn===failTurn){",
    "    console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "    console.log(JSON.stringify({type:'assistant',text:'attempting'}));",
    "    process.exit(1);",
    "  }",
    "  const finish=()=>{",
    "    try{fs.writeFileSync('worker-output.txt','worker done\\n');}catch(e){}",
    "    console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "    console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
    "  };",
    "  if(delay>0){setTimeout(finish,delay);}else{finish();}",
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Capture the committed repo as a wave base, with artifacts outside the source. */
async function setupCapture(sourceDir: string): Promise<WaveCaptureResult> {
  const artifactDir = await realpath(await mkdtemp(join(tmpdir(), "pi-review-dispatch-artifacts-")));
  return captureWaveBase({
    cwd: sourceDir,
    maxSnapshotBytes: 1_000_000,
    waveId: "dispatch-test-wave",
    artifactDir,
  });
}

function controllerConfig(root: string, executorPath: string, maxConcurrent = 1): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "fake",
      adapter: "run-as-binary",
      command: executorPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" as const },
    }],
    execution: {
      maxWorkers: maxConcurrent,
      workerResources: [{ resourceId: "default", selection: { source: "external", id: "fake" }, maxConcurrent }],
    },
  });
}

type ManagerInternals = { controller: BackgroundExecutionController };

function controllerOf(manager: ExecutionToolManager): BackgroundExecutionController {
  const controller = (manager as unknown as ManagerInternals).controller;
  assert.ok(controller, "ExecutionToolManager did not expose its controller");
  return controller;
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000, label = "dispatch lifecycle condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForStdinCapture(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
}

function toolOf(tools: Array<Record<string, any>>, name: string): Record<string, any> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool;
}

function renderCard(tool: Record<string, any>, value: unknown, context: { state: Record<string, unknown>; invalidate: () => void }, width = 480): string {
  const component = tool.renderResult(value, { expanded: false, isPartial: false }, identityTheme, context) as { render(width: number): string[] };
  return component.render(width).join("\n");
}

function taskDispatchEntry(view: SubtaskCardDispatchView | undefined, taskId: string): NonNullable<SubtaskCardDispatchView["tasks"][number]> {
  const entry = view?.tasks.find((candidate) => candidate.taskId === taskId);
  assert.ok(entry, `live dispatch view is missing task ${taskId}`);
  return entry;
}

/** Content digest of every file under a tree: expansion/toggle must not read
 * or rewrite any retained file, so the tree stays byte-identical. */
async function digestTree(rootPath: string): Promise<Map<string, string>> {
  const digest = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else digest.set(path, createHash("sha256").update(await readFile(path)).digest("hex"));
    }
  };
  await walk(rootPath);
  return digest;
}

test("queued start dispatches, captures the exact transport message, and updates the original card through a dispatch event", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-card-");
  let manager: ExecutionToolManager | undefined;
  try {
    const stdinCapture = join(root, "executor-stdin.json");
    await writeRecordingExecutor(root, { stdinCapture, delayMs: 400 });
    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", "bash", "SubtasksStart", "SubtasksAdd"]; },
    };
    const config = controllerConfig(root, join(root, "dispatch-executor.cjs"), 1);
    manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
    manager.sync();
    const controller = controllerOf(manager);
    const start = toolOf(tools, "SubtasksStart");

    // One executor slot: task one dispatches while task two stays queued.
    const started = await (start.execute as ExecuteTool)("dispatch-start", {
      tasks: [
        { title: "Dispatch card task", instructions: "Rewrite the renderer with DISPATCH_PROMPT_SENTINEL inside.", acceptanceCriteria: ["renderer rewritten", "card updates on dispatch"] },
        { title: "Queued follower task", instructions: "Wait for the first slot.", acceptanceCriteria: ["remains queued"] },
      ],
    }, undefined, undefined, {});
    assert.equal(started.isError, false);
    const executionId = started.details.executionId as string;
    const taskOne = started.details.tasks[0];
    const taskTwo = started.details.tasks[1];
    assert.ok(executionId && taskOne?.taskId && taskTwo?.taskId);

    // Queued snapshot: no fabricated dispatch data on the returned record.
    assert.equal(taskOne.dispatch, undefined);
    assert.equal(taskOne.initialDispatch, undefined);
    assert.equal(taskTwo.dispatch, undefined);

    // Original card renders immediately with the native context route. The
    // dispatch cannot have completed yet: the render happens before any
    // filesystem work of the dispatch chain can interleave.
    const invalidateCount = { count: 0 };
    const context = { state: {} as Record<string, unknown>, invalidate: () => { invalidateCount.count += 1; } };
    const queuedCard = renderCard(start, started, context);
    assert.ok(queuedCard.includes(String(taskOne.taskId)) && queuedCard.includes(String(taskTwo.taskId)));
    assert.match(queuedCard, /dispatch: not yet sent/);
    assert.ok(!queuedCard.includes("prompt delivered to transport"), "queued card must not fabricate dispatch provenance");
    assert.ok(!queuedCard.includes("Workspace isolation (authoritative)"), "collapsed card never embeds the full prompt");

    // Register an independent dispatch-event watcher to prove the event path.
    let eventTaskId = "";
    const unsubscribe = watchDispatchCards(executionId, (notification) => { eventTaskId = notification.taskId; });

    // Wait for the actual dispatch (captured at the transport boundary).
    await waitFor(
      () => Boolean(taskDispatchEntry(controller.liveDispatchView(executionId), taskOne.taskId).dispatch),
      20_000,
      "task one dispatch record",
    );
    const dispatchRecord = taskDispatchEntry(controller.liveDispatchView(executionId), taskOne.taskId).dispatch as SubtaskDispatchRecord;
    assert.equal(dispatchRecord.provenance, "captured_at_dispatch");
    assert.equal(dispatchRecord.delivery, "written_to_transport");
    assert.equal(dispatchRecord.executorTurn, 1);
    assert.equal(dispatchRecord.adapter, "run-as-binary");
    assert.ok(dispatchRecord.sentPrompt.includes("DISPATCH_PROMPT_SENTINEL"));
    assert.ok(dispatchRecord.worktreeRoot.includes(taskOne.taskId), "isolated worker worktree must be per-task");
    assert.ok(!dispatchRecord.worktreeRoot.startsWith(root), "worker worktree must be isolated, not the target checkout");
    assert.match(dispatchRecord.baseCommit, /^[0-9a-f]{40}$/);
    // The first dispatch stays immutable on the task record.
    assert.equal(
      taskDispatchEntry(controller.liveDispatchView(executionId), taskOne.taskId).initialDispatch?.sentPrompt,
      dispatchRecord.sentPrompt,
    );
    unsubscribe();

    // The dispatch event fired and the native invalidate route was exercised.
    await waitFor(() => invalidateCount.count > 0, 5_000, "dispatch-driven card invalidation");
    assert.equal(eventTaskId, taskOne.taskId);
    assert.equal(
      context.state.__piReviewGateDispatchWatchExecutionId,
      executionId,
      "the card must register through the native row-local state",
    );
    assert.ok(context.state.subtaskDispatchView, "the native row state exposes the dispatch projection for detail renderers");

    // Re-render after the dispatch event: the original card now carries the
    // actual dispatch provenance and the live task state.
    const dispatchedCard = renderCard(start, started, context);
    const taskOneLine = dispatchedCard.split("\n").find((candidate) => candidate.includes(String(taskOne.taskId)));
    assert.ok(taskOneLine, "dispatched card missing task line");
    assert.match(
      dispatchedCard,
      /dispatch: prompt delivered to transport · worker worktree .+ · captured base [0-9a-f]{12} · turn 1/,
    );
    assert.match(dispatchedCard, /dispatch: not yet sent/, "still-queued task two keeps the truthful not-yet-sent state");

    // Compare the record to the text the executor transport actually received.
    await waitForStdinCapture(`${stdinCapture}.1`);
    const transportReceived = await readFile(`${stdinCapture}.1`, "utf8");
    assert.equal(transportReceived, dispatchRecord.sentPrompt, "captured prompt must equal the exact text the transport received");
    // Path rewriting: the worker root appears; the source checkout does not.
    assert.ok(transportReceived.includes(dispatchRecord.worktreeRoot));
    assert.ok(!transportReceived.includes(root), "source workspace paths must be rewritten to the worker root");
    assert.match(transportReceived, /Workspace isolation \(authoritative\):/);
    // Submitted task vs actual sent text are distinct records.
    assert.equal(taskOne.definition.instructions, "Rewrite the renderer with DISPATCH_PROMPT_SENTINEL inside.");
    assert.ok(dispatchRecord.sentPrompt.includes(taskOne.definition.instructions));
    assert.notEqual(dispatchRecord.sentPrompt, taskOne.definition.instructions);
    assert.match(dispatchRecord.sentPrompt, /Subtask: Dispatch card task/);
    assert.match(dispatchRecord.sentPrompt, /- renderer rewritten/);
    await waitFor(() => {
      const entry = controller.liveDispatchView(executionId)?.tasks.find((candidate) => candidate.taskId === taskOne.taskId);
      return entry !== undefined
        && !["queued", "capturing", "running", "reviewing", "accepted", "waiting_to_land", "landing"].includes(entry.state);
    }, 30_000, "task one settlement");
  } finally {
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("queued steering is durably incorporated before startup and appears in the captured actual dispatch", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-steer-");
  let manager: ExecutionToolManager | undefined;
  try {
    const stdinCapture = join(root, "executor-stdin.json");
    await writeRecordingExecutor(root, { stdinCapture, delayMs: 500 });
    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", "bash", "SubtasksStart", "SubtasksSteer"]; },
    };
    const config = controllerConfig(root, join(root, "dispatch-executor.cjs"), 1);
    manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
    manager.sync();
    const controller = controllerOf(manager);
    const start = toolOf(tools, "SubtasksStart");
    const steer = toolOf(tools, "SubtasksSteer");
    // One slot: the holder occupies it while the steered task stays queued.
    const started = await (start.execute as ExecuteTool)("steer-start", {
      tasks: [
        { title: "Slot holder", instructions: "Occupy the single executor slot.", acceptanceCriteria: ["finishes"] },
        { title: "Steered dispatch task", instructions: "Work normally.", acceptanceCriteria: ["finishes"] },
      ],
    }, undefined, undefined, {});
    const executionId = started.details.executionId as string;
    const steeredTaskId = started.details.tasks[1].taskId as string;

    const steered = await (steer.execute as ExecuteTool)("steer-queued", {
      executionId,
      taskId: steeredTaskId,
      instructions: "QUEUED_STEER_SENTINEL: change the approach before dispatch.",
    }, undefined, undefined, {});
    assert.equal(steered.isError, false);

    await waitFor(
      () => Boolean(taskDispatchEntry(controller.liveDispatchView(executionId), steeredTaskId).dispatch),
      30_000,
      "steered dispatch record",
    );
    const record = taskDispatchEntry(controller.liveDispatchView(executionId), steeredTaskId).dispatch as SubtaskDispatchRecord;
    assert.ok(record.sentPrompt.includes("STEER_SENTINEL"), "queued steering must be inside the captured actual dispatch");
    assert.ok(
      record.sentPrompt.includes("Steering received before executor startup"),
      "the pre-start steering incorporation header must be inside the captured actual dispatch",
    );
    // Both tasks share the per-turn capture file; the steered task's dispatch
    // is the one whose text matches its captured record.
    let transportReceived = "";
    {
      const deadline = Date.now() + 40_000;
      for (;;) {
        try {
          const content = await readFile(`${stdinCapture}.1`, "utf8");
          if (content === record.sentPrompt) {
            transportReceived = content;
            break;
          }
        } catch {
          // not written yet
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for the steered task's transport capture`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    }
    assert.ok(transportReceived.includes("STEER_SENTINEL"));
  } finally {
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch records persist and restored controllers serve them to re-rendered original cards", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-reload-");
  let controller: BackgroundExecutionController | undefined;
  let restored: BackgroundExecutionController | undefined;
  try {
    const stdinCapture = join(root, "executor-stdin.json");
    await writeRecordingExecutor(root, { stdinCapture, delayMs: 30_000 });
    const config = controllerConfig(root, join(root, "dispatch-executor.cjs"), 1);
    controller = new BackgroundExecutionController({
      pi: {},
      config,
      state: createState(),
      cwd: () => root,
    });
    const started = await controller.start([{
      title: "Reloaded dispatch task",
      instructions: "Persist the actual dispatch provenance.",
      acceptanceCriteria: ["survives restore"],
    }], "execute");
    const executionId = started.executionId;
    const taskId = started.tasks[0].taskId;
    await waitFor(() => {
      const entry = controller?.liveDispatchView(executionId)?.tasks.find((candidate) => candidate.taskId === taskId);
      return Boolean(entry?.dispatch);
    }, 20_000, "pre-restore dispatch record");
    const beforeRestore = taskDispatchEntry(controller!.liveDispatchView(executionId), taskId).dispatch as SubtaskDispatchRecord;

    const associations = controller.associations();
    await controller.shutdown();
    await controller.detach();
    controller = undefined;
    restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    const reloaded = restored.liveDispatchView(executionId);
    assert.ok(reloaded, "restored controller must expose the persisted dispatch view");
    const restoredEntry = reloaded!.tasks.find((candidate) => candidate.taskId === taskId);
    assert.ok(restoredEntry?.dispatch, "restored task must carry the persisted dispatch record");
    const restoredRecord = restoredEntry!.dispatch as SubtaskDispatchRecord;
    assert.equal(restoredRecord.provenance, "captured_at_dispatch");
    assert.equal(restoredRecord.sentPrompt, beforeRestore.sentPrompt, "the reloaded record is the same actually-captured prompt");
    assert.ok(restoredRecord.sentPrompt.includes("Persist the actual dispatch provenance."));
    assert.ok(restoredRecord.worktreeRoot.includes(taskId));
    // The restored view stays usable by a re-rendered original card.
    assert.match(restoredRecord.sentPrompt, /Workspace isolation \(authoritative\):/);
  } finally {
    if (controller) {
      await controller.shutdown().catch(() => undefined);
      await controller.detach().catch(() => undefined);
    }
    if (restored) {
      await restored.shutdown();
      await restored.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("re-dispatch after a failed attempt updates the latest record while the initial dispatch is preserved", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-retry-");
  let manager: ExecutionToolManager | undefined;
  try {
    const stdinCapture = join(root, "executor-stdin.json");
    await writeRecordingExecutor(root, { stdinCapture, failTurn: 1, delayMs: 100 });
    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", "bash", "SubtasksStart"]; },
    };
    const config = controllerConfig(root, join(root, "dispatch-executor.cjs"), 1);
    manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
    manager.sync();
    const controller = controllerOf(manager);
    const start = toolOf(tools, "SubtasksStart");
    const started = await (start.execute as ExecuteTool)("retry-start", {
      tasks: [{ title: "Retried dispatch task", instructions: "Fail once then finish.", acceptanceCriteria: ["recovers"] }],
    }, undefined, undefined, {});
    const executionId = started.details.executionId as string;
    const taskId = started.details.tasks[0].taskId as string;
    await waitFor(() => {
      const entry = controller.liveDispatchView(executionId)?.tasks.find((candidate) => candidate.taskId === taskId);
      return Boolean(entry?.dispatch && entry.dispatch.executorTurn === 2);
    }, 30_000, "re-dispatch record for turn 2");
    const entry = taskDispatchEntry(controller.liveDispatchView(executionId), taskId);
    const initial = entry.initialDispatch as SubtaskDispatchRecord;
    const latest = entry.dispatch as SubtaskDispatchRecord;
    assert.equal(initial.executorTurn, 1);
    assert.equal(latest.executorTurn, 2);
    assert.notEqual(latest.sentPrompt, initial.sentPrompt, "the re-dispatched prompt after recovery is a distinct actual message");
    assert.ok(latest.sentPrompt.includes("Fail once then finish."));
    assert.equal(initial.worktreeRoot, latest.worktreeRoot, "re-dispatch stays in the same isolated worktree");
    assert.equal(initial.baseCommit, latest.baseCommit);
  } finally {
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation after dispatch preserves the captured record and unknown executions expose nothing", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-cancel-");
  let manager: ExecutionToolManager | undefined;
  try {
    // Long-running executor that records its actual stdin receipt and stays
    // alive until interrupted.
    const executor = join(root, "dispatch-executor.cjs");
    const receiptPath = join(root, "executor-receipt.json");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      `  fs.writeFileSync(${JSON.stringify(receiptPath)},prompt);`,
      "  console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "  console.log(JSON.stringify({type:'assistant',text:'waiting'}));",
      "  setTimeout(()=>{},30000);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", "bash", "SubtasksStart", "SubtasksInterrupt"]; },
    };
    const config = controllerConfig(root, executor, 1);
    manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
    manager.sync();
    const controller = controllerOf(manager);
    const start = toolOf(tools, "SubtasksStart");
    const interrupt = toolOf(tools, "SubtasksInterrupt");
    const started = await (start.execute as ExecuteTool)("cancel-start", {
      tasks: [{ title: "Cancelled dispatch task", instructions: "Keep running until interrupted.", acceptanceCriteria: ["none"] }],
    }, undefined, undefined, {});
    const executionId = started.details.executionId as string;
    const taskId = started.details.tasks[0].taskId as string;
    await waitFor(
      () => Boolean(taskDispatchEntry(controller.liveDispatchView(executionId), taskId).dispatch),
      20_000,
      "pre-interrupt dispatch record",
    );
    // Interrupt only after the executor actually received the prompt, so the
    // test genuinely exercises cancellation after delivery.
    await waitForStdinCapture(receiptPath);
    const interrupted = await (interrupt.execute as ExecuteTool)("cancel-interrupt", {
      executionId,
      taskId,
      interruptMode: "interrupt_as_failure",
    }, undefined, undefined, {});
    assert.equal(interrupted.isError, false);
    await waitFor(() => {
      const entry = controller.liveDispatchView(executionId)?.tasks.find((candidate) => candidate.taskId === taskId);
      return entry?.state === "interrupted";
    }, 30_000, "interrupted state");
    const entry = taskDispatchEntry(controller.liveDispatchView(executionId), taskId);
    // The dispatch record survives cancellation unchanged: the message WAS
    // actually sent before the interruption, so the provenance stays truthful.
    assert.ok(entry.dispatch, "cancelled task must keep its actual dispatch record");
    assert.equal((entry.dispatch as SubtaskDispatchRecord).executorTurn, 1);
    // Unknown executions expose no view; nothing is fabricated.
    assert.equal(controller.liveDispatchView("exec-unknown"), undefined);
  } finally {
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("failures before prompt delivery never publish a dispatch record", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-prefail-");
  try {
    // Adapter initialization failure (same class as adapter validation/startup
    // failures): the executor selection resolves to no external agent, so the
    // adapter cannot even be created. That failure happens before any prompt
    // delivery exists, so no dispatch record may be published and no progress
    // update may carry one.
    const capture = await setupCapture(root);
    const worker = await createWorkerWorktree(capture, "task-predelivery");
    const artifactDir = join(capture.waveRoot, "artifacts", "task-predelivery");
    const config = normalizeConfig({
      enabled: true,
      execution: {
        workerResources: [{ resourceId: "missing", selection: { source: "external", id: "missing" }, maxConcurrent: 1 }],
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 0 },
      },
    });
    const progressUpdates: unknown[] = [];
    const result = await runWaveWorker({
      sourceRoot: capture.discovery.captureRoot,
      taskId: "task-predelivery",
      task: { title: "Pre-delivery failure task", instructions: "Never delivered.", acceptanceCriteria: ["none"] },
      capture,
      worktree: worker,
      artifactDir,
      config,
      onUpdate: (update) => progressUpdates.push(update),
    });
    assert.equal(result.status, "executor_error");
    const carried = progressUpdates.filter((update) => isRecord(update) && update.dispatch !== undefined);
    assert.deepEqual(carried, [], "no progress update may carry dispatch data for a failure before delivery");
    const operation = JSON.parse(await readFile(join(artifactDir, "operation.json"), "utf8"));
    assert.equal(operation.state, "paused_recoverable");
    await removeWorktree(worker.worktreeRoot, capture.repositoryPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an originally expanded Start/Add card subscribes and refreshes its dispatch projection across dispatch events", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-expanded-");
  let manager: ExecutionToolManager | undefined;
  try {
    const stdinCapture = join(root, "executor-stdin.json");
    await writeRecordingExecutor(root, { stdinCapture, delayMs: 400 });
    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", "bash", "SubtasksStart"]; },
    };
    const config = controllerConfig(root, join(root, "dispatch-executor.cjs"), 1);
    manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
    manager.sync();
    const controller = controllerOf(manager);
    const start = toolOf(tools, "SubtasksStart");
    const started = await (start.execute as ExecuteTool)("expanded-start", {
      tasks: [{ title: "Expanded first task", instructions: "EXPANDED_LIFECYCLE_SENTINEL", acceptanceCriteria: ["finishes"] }],
    }, undefined, undefined, {});
    const executionId = started.details.executionId as string;
    const taskId = started.details.tasks[0].taskId as string;

    // The very first render is already expanded: the row must still subscribe
    // and project through the same native context route.
    const invalidateCount = { count: 0 };
    const context = { state: {} as Record<string, unknown>, invalidate: () => { invalidateCount.count += 1; } };
    const expandedComponent = (start.renderResult as (
      value: unknown,
      options: unknown,
      theme: typeof identityTheme,
      context?: unknown,
    ) => { render(width: number): string[] })(started, { expanded: true, isPartial: false }, identityTheme, context);
    const expandedBefore = expandedComponent.render(400).join("\n");
    assert.match(
      expandedBefore,
      /^SubtasksStart · exec\S+ · (queued|capturing|running)/m,
      "expanded rendering stays on the expanded arm",
    );

    await waitFor(
      () => Boolean(taskDispatchEntry(controller.liveDispatchView(executionId), taskId).dispatch),
      20_000,
      "expanded-row dispatch record",
    );
    await waitFor(() => invalidateCount.count > 0, 5_000, "dispatch-driven invalidation of the expanded row");
    assert.equal(context.state.__piReviewGateDispatchWatchExecutionId, executionId);
    // The row re-renders while it STAYS expanded — no intervening collapse or
    // inspection — and its projection must be freshly refreshed, not stale.
    const refreshed = (start.renderResult as (
      value: unknown,
      options: unknown,
      theme: typeof identityTheme,
      context?: unknown,
    ) => { render(width: number): string[] })(started, { expanded: true, isPartial: false }, identityTheme, context);
    const renderedExpanded = refreshed.render(400).join("\n");
    assert.match(
      renderedExpanded,
      /^SubtasksStart · exec\S+ · (queued|capturing|running)/m,
      "the row remains on the expanded arm after dispatch",
    );
    // The refreshed projection reaches the expanded renderer: the actual
    // transport-boundary capture is what the card shows, not a placeholder.
    assert.match(renderedExpanded, /Prompt provenance: captured at dispatch/);
    assert.match(renderedExpanded, /Prompt sent to worker:/);
    const projection = context.state.subtaskDispatchView as SubtaskCardDispatchView | undefined;
    assert.ok(projection, "the expanded row's native state must expose the refreshed dispatch projection");
    const entry = projection.tasks.find((candidate) => candidate.taskId === taskId);
    assert.ok(entry?.dispatch, "the projection must carry the actual delivered dispatch record after the event");
    assert.equal((entry!.dispatch as SubtaskDispatchRecord).delivery, "written_to_transport");
  } finally {
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("expansion shows the full actual captured sent prompt (not a reconstruction), toggling performs no I/O, and concurrent rows stay execution-scoped", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-expand-");
  let manager: ExecutionToolManager | undefined;
  try {
    const stdinCapture = join(root, "executor-stdin.json");
    // Long-lived executor: it holds the single slot for well over the test
    // window, so row B stays queued and no background writer races the digest.
    await writeRecordingExecutor(root, { stdinCapture, delayMs: 15_000 });
    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", "bash", "SubtasksStart"]; },
    };
    const config = controllerConfig(root, join(root, "dispatch-executor.cjs"), 1);
    manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
    manager.sync();
    const controller = controllerOf(manager);
    const start = toolOf(tools, "SubtasksStart");

    // Two concurrent Start rows for two different executions: row-local
    // identities must stay scoped (fencing) while both rows are live.
    const startedA = await (start.execute as ExecuteTool)("expand-a", {
      tasks: [{
        title: "Expand prompt task",
        instructions: "EXPAND_PROMPT_SENTINEL first line.\nSecond line with   triple spaces.",
        acceptanceCriteria: ["expanded shows the full actual prompt"],
      }],
    }, undefined, undefined, {});
    const startedB = await (start.execute as ExecuteTool)("expand-b", {
      tasks: [{ title: "Queued sibling task", instructions: "Stay queued behind the single slot.", acceptanceCriteria: ["stays queued"] }],
    }, undefined, undefined, {});
    const executionA = startedA.details.executionId as string;
    const taskIdA = startedA.details.tasks[0].taskId as string;
    const executionB = startedB.details.executionId as string;

    let invalidationsA = 0;
    let invalidationsB = 0;
    const contextA = { state: {} as Record<string, unknown>, invalidate: () => { invalidationsA += 1; } };
    const contextB = { state: {} as Record<string, unknown>, invalidate: () => { invalidationsB += 1; } };
    const render = (
      value: unknown,
      options: { expanded: boolean },
      context: typeof contextA | typeof contextB,
      width = 400,
    ): string => (
      (start.renderResult(value, options, identityTheme, context) as { render(w: number): string[] }).render(width).join("\n")
    );

    // Render both rows through the actual registered entrypoint with native
    // contexts; each row registers for its own execution only.
    render(startedA, { expanded: false }, contextA);
    render(startedB, { expanded: false }, contextB);
    assert.equal(contextA.state.__piReviewGateDispatchWatchExecutionId, executionA);
    assert.equal(contextB.state.__piReviewGateDispatchWatchExecutionId, executionB);

    // A's actual dispatch invalidates row A only; B's row stays untouched.
    await waitFor(
      () => Boolean(taskDispatchEntry(controller.liveDispatchView(executionA), taskIdA).dispatch),
      20_000,
      "A dispatch record",
    );
    await waitFor(() => invalidationsA > 0, 5_000, "row A dispatch-driven invalidation");
    assert.equal(invalidationsB, 0, "execution B's row must not react to execution A's dispatch event");

    // The expanded view of the SAME retained result now carries the full
    // actual sent prompt. Rendered wide enough that no wrapping occurs, so the
    // block is byte-comparable with the transport capture.
    const recordA = taskDispatchEntry(controller.liveDispatchView(executionA), taskIdA).dispatch as SubtaskDispatchRecord;
    const expanded = render(startedA, { expanded: true }, contextA, 4000);
    assert.match(expanded, /Prompt provenance: captured at dispatch/);
    assert.match(expanded, new RegExp(`Captured base commit: ${recordA.baseCommit}`));
    assert.match(expanded, new RegExp(`Worker worktree: ${recordA.worktreeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    // Actual vs reconstructed: the expanded block must equal the exact text
    // the executor transport received — never a reassembly from the submitted
    // definition or later configuration.
    const deadline = Date.now() + 20_000;
    let transportReceived = "";
    for (;;) {
      try {
        const content = await readFile(`${stdinCapture}.1`, "utf8");
        if (content === recordA.sentPrompt) { transportReceived = content; break; }
      } catch {
        // not written yet
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for A's transport capture");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert.ok(expanded.includes(transportReceived), "the expanded view must contain the exact captured sent prompt");
    assert.notEqual(transportReceived, startedA.details.tasks[0].definition.instructions, "the sent prompt is a distinct actual message from the submitted instructions");

    // No I/O on toggle: expand/re-collapse of the retained result re-runs
    // nothing — no dispatch events, no new reads/writes under the execution
    // root, deterministic output, and the collapsed card stays concise.
    let dispatchEvents = 0;
    const unsubscribe = watchDispatchCards(executionA, () => { dispatchEvents += 1; });
    const before = await digestTree(root);
    const collapsedBefore = render(startedA, { expanded: false }, contextA);
    const expandedMid = render(startedA, { expanded: true }, contextA);
    const collapsedAfter = render(startedA, { expanded: false }, contextA);
    assert.equal(collapsedAfter, collapsedBefore, "re-collapsing returns to the identical card");
    assert.equal(render(startedA, { expanded: true }, contextA), expandedMid, "expansion is deterministic for the same retained result");
    assert.ok(!collapsedAfter.includes(transportReceived), "the collapsed card stays concise; the full prompt lives in the expanded view");
    assert.equal(dispatchEvents, 0, "toggling must not emit dispatch events or trigger inspection");
    assert.deepEqual(await digestTree(root), before, "toggling must not read/rewrite retained files");
    unsubscribe();
  } finally {
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch-card watchers are bounded, row-scoped, and never leak truth data", () => {
  resetDispatchCardsForTests();
  const invalidations: string[] = [];
  const unsubscribeA = watchDispatchCards("exec-a", () => { invalidations.push("a"); });
  watchDispatchCards("exec-b", () => { throw new Error("row is gone"); });
  watchDispatchCards("exec-c", () => { invalidations.push("c"); });
  notifyDispatchCards("exec-b", "task-b");
  notifyDispatchCards("exec-a", "task-a");
  assert.deepEqual(invalidations, ["a"]);
  unsubscribeA();
  notifyDispatchCards("exec-a", "task-a");
  assert.deepEqual(invalidations, ["a"]);
  resetDispatchCardsForTests();
});

test("an early queued card survives registration of more than 64 further executions and still receives its dispatch update", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-retention-");
  let manager: ExecutionToolManager | undefined;
  try {
    const stdinCapture = join(root, "executor-stdin.json");
    // Every dispatched turn runs long; the holder therefore keeps the single
    // executor slot occupied until it is interrupted.
    await writeRecordingExecutor(root, { stdinCapture, delayMs: 30_000 });
    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", "bash", "SubtasksStart", "SubtasksAdd"]; },
    };
    const config = controllerConfig(root, join(root, "dispatch-executor.cjs"), 1);
    manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
    manager.sync();
    const controller = controllerOf(manager);
    const start = toolOf(tools, "SubtasksStart");
    const interrupt = toolOf(tools, "SubtasksInterrupt");

    // Holder occupies the only slot; its card is rendered (subscribed) first.
    const holder = await (start.execute as ExecuteTool)("retention-holder", {
      tasks: [{ title: "Slot holder", instructions: "Hold the executor slot.", acceptanceCriteria: ["hold"] }],
    }, undefined, undefined, {});
    assert.equal(holder.isError, false);
    const holderId = holder.details.executionId as string;
    const holderTaskId = holder.details.tasks[0].taskId as string;
    renderCard(start, holder, { state: {} as Record<string, unknown>, invalidate() {} });

    // The early card: queued behind the holder, rendered (subscribed) second.
    const early = await (start.execute as ExecuteTool)("retention-early", {
      tasks: [{ title: "Early survivor", instructions: "EARLY_RETENTION_SENTINEL", acceptanceCriteria: ["dispatched"] }],
    }, undefined, undefined, {});
    assert.equal(early.isError, false);
    const earlyId = early.details.executionId as string;
    const earlyTaskId = early.details.tasks[0].taskId as string;
    const invalidateCount = { count: 0 };
    const context = { state: {} as Record<string, unknown>, invalidate: () => { invalidateCount.count += 1; } };
    const queuedCard = renderCard(start, early, context);
    assert.match(queuedCard, /dispatch: not yet sent/);

    // Register MORE than the old hard cap of 64 further watched executions:
    // each filler is a real registered Start with its own rendered row.
    for (let i = 1; i <= 65; i += 1) {
      const filler = await (start.execute as ExecuteTool)(`retention-filler-${i}`, {
        tasks: [{ title: `Filler ${i}`, instructions: `FILLER_${i}_SENTINEL`, acceptanceCriteria: ["queued"] }],
      }, undefined, undefined, {});
      assert.equal(filler.isError, false);
      renderCard(start, filler, { state: {} as Record<string, unknown>, invalidate() {} });
    }

    // Release the slot: the early task dispatches next in queue order.
    const interrupted = await (interrupt.execute as ExecuteTool)("retention-interrupt", {
      executionId: holderId,
      taskId: holderTaskId,
      interruptMode: "interrupt_as_failure",
    }, undefined, undefined, {});
    assert.equal(interrupted.isError, false);
    await waitFor(() => {
      const entry = controller.liveDispatchView(holderId)?.tasks.find((candidate) => candidate.taskId === holderTaskId);
      return Boolean(entry && !isActiveTaskState(entry.state));
    }, 30_000, "holder settled after interrupt");

    await waitFor(
      () => Boolean(taskDispatchEntry(controller.liveDispatchView(earlyId), earlyTaskId).dispatch),
      30_000,
      "early task dispatch record",
    );
    // The early row's listener survived all 65 later registrations: the real
    // dispatch event invalidated it (blind FIFO eviction would have dropped
    // it at the 64th insertion).
    await waitFor(() => invalidateCount.count > 0, 5_000, "early-card invalidation after slot release");
    const dispatchedCard = renderCard(start, early, context);
    assert.match(dispatchedCard, /dispatch: prompt delivered to transport/);

    // Lifecycle-aware sweep: the settled holder's entry was retired by the
    // dispatch event, while the still-live early card and queued fillers keep
    // their subscriptions.
    assert.equal(hasDispatchCardWatcher(holderId), false, "settled execution's card entry is swept on the next dispatch event");
    assert.equal(hasDispatchCardWatcher(earlyId), true, "live execution keeps its card subscription");
  } finally {
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("an Add card identifies its own task by exact assigned id among more than eight existing tasks with duplicate definitions", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-add-");
  let manager: ExecutionToolManager | undefined;
  try {
    const stdinCapture = join(root, "executor-stdin.json");
    // The holder's prompt carries the hold pattern (30s turn); every other
    // task completes immediately.
    await writeRecordingExecutor(root, { stdinCapture, holdPattern: "HOLD_SLOT_SENTINEL" });
    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", "bash", "SubtasksStart", "SubtasksAdd"]; },
    };
    const config = controllerConfig(root, join(root, "dispatch-executor.cjs"), 1);
    manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
    manager.sync();
    const controller = controllerOf(manager);
    const start = toolOf(tools, "SubtasksStart");
    const add = toolOf(tools, "SubtasksAdd");
    const interrupt = toolOf(tools, "SubtasksInterrupt");

    // Holder occupies the only slot while the inventory builds up.
    const holder = await (start.execute as ExecuteTool)("add-holder", {
      tasks: [{ title: "Slot holder", instructions: "HOLD_SLOT_SENTINEL hold the executor slot.", acceptanceCriteria: ["hold"] }],
    }, undefined, undefined, {});
    assert.equal(holder.isError, false);
    const holderId = holder.details.executionId as string;
    const holderTaskId = holder.details.tasks[0].taskId as string;

    // Nine existing tasks sharing ONE definition: any title/instruction-based
    // selection for the Add card would be ambiguous.
    const duplicateDefinition = { title: "Duplicate definition task", instructions: "DUPLICATE_DEFINITION_BODY inside.", acceptanceCriteria: ["done"] };
    const started = await (start.execute as ExecuteTool)("add-start", {
      tasks: Array.from({ length: 9 }, () => ({ ...duplicateDefinition })),
    }, undefined, undefined, {});
    assert.equal(started.isError, false);
    const executionId = started.details.executionId as string;
    const existingIds = (started.details.tasks as Array<Record<string, any>>).map((task) => task.taskId as string);
    assert.equal(existingIds.length, 9);

    // The Add result carries the exact newly assigned id(s), not a guess.
    const added = await (add.execute as ExecuteTool)("add-top", {
      executionId,
      tasks: [{ ...duplicateDefinition }],
    }, undefined, undefined, {});
    assert.equal(added.isError, false);
    // The Add result inventory holds exactly one task beyond the nine
    // existing ones; its exact assigned id is what the card must select by.
    const addedTaskEntry = (added.details.tasks as Array<Record<string, any>>).find(
      (task) => !existingIds.includes(task.taskId as string),
    );
    assert.ok(addedTaskEntry, "the Add result inventory contains the newly assigned task");
    assert.deepEqual(added.details.addedTaskIds, [addedTaskEntry.taskId]);
    const addedTaskId = added.details.addedTaskIds[0] as string;
    assert.ok(!existingIds.includes(addedTaskId), "the added task has a fresh identity distinct from the nine existing duplicates");

    // Collapsed Add card: exactly the added task, never the nine duplicates.
    const addInvalidations = { count: 0 };
    const addContext = { state: {} as Record<string, unknown>, invalidate: () => { addInvalidations.count += 1; } };
    const addCard = renderCard(add, added, addContext);
    assert.match(addCard, /SubtasksAdd/);
    assert.match(addCard, /1 task\(s\) added/);
    assert.ok(addCard.includes(addedTaskId), "the Add card shows its own added task");
    for (const existingId of existingIds) {
      assert.ok(!addCard.includes(existingId), `the Add card must not render pre-existing task ${existingId}`);
    }

    // The Start card still renders the whole inventory with bounded disclosure.
    const startCard = renderCard(start, started, { state: {} as Record<string, unknown>, invalidate() {} });
    assert.match(startCard, /9 execution task\(s\)/);
    assert.match(startCard, /1 additional inline task\(s\) omitted/);

    // Release the slot; tasks dispatch in queue order — the added task last.
    const interrupted = await (interrupt.execute as ExecuteTool)("add-interrupt", {
      executionId: holderId,
      taskId: holderTaskId,
      interruptMode: "interrupt_as_failure",
    }, undefined, undefined, {});
    assert.equal(interrupted.isError, false);
    await waitFor(
      () => Boolean(taskDispatchEntry(controller.liveDispatchView(executionId), addedTaskId).dispatch),
      60_000,
      "added task dispatch record (after nine predecessors)",
    );

    // The Add row received the dispatch event (its native invalidate fired) and
    // its refreshed card shows the ACTUAL dispatch of the added task — not one
    // of the duplicates.
    await waitFor(() => addInvalidations.count > 0, 5_000, "Add-row invalidation on the added task's dispatch event");
    const dispatchedAddCard = renderCard(add, added, addContext);
    assert.match(dispatchedAddCard, /dispatch: prompt delivered to transport/);
    const dispatchRecord = taskDispatchEntry(controller.liveDispatchView(executionId), addedTaskId).dispatch as SubtaskDispatchRecord;
    assert.ok(dispatchedAddCard.includes(dispatchRecord.worktreeRoot), "the Add card's provenance is the added task's own worktree");
    for (const existingId of existingIds) {
      assert.ok(!dispatchedAddCard.includes(existingId), `the refreshed Add card must not render pre-existing task ${existingId}`);
    }
  } finally {
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});
test("an interrupted original card keeps its subscription across an unrelated dispatch sweep and updates on continue", async () => {
  resetDispatchCardsForTests();
  const root = await mkRepo("pi-review-dispatch-recoverable-");
  let manager: ExecutionToolManager | undefined;
  try {
    const stdinCapture = join(root, "executor-stdin.json");
    // The original task's prompt holds the single executor slot (30s turn)
    // until it is interrupted.
    await writeRecordingExecutor(root, { stdinCapture, holdPattern: "HOLD_SLOT_SENTINEL" });
    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
      getActiveTools() { return ["read", "bash", "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksInterrupt"]; },
    };
    const config = controllerConfig(root, join(root, "dispatch-executor.cjs"), 1);
    manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => root });
    manager.sync();
    const controller = controllerOf(manager);
    const start = toolOf(tools, "SubtasksStart");
    const inspect = toolOf(tools, "SubtasksInspect");
    const interrupt = toolOf(tools, "SubtasksInterrupt");
    const continueTool = toolOf(tools, "SubtasksContinue");

    // Original execution: its task dispatches and runs until interrupted.
    const original = await (start.execute as ExecuteTool)("recoverable-original", {
      tasks: [{ title: "Recoverable task", instructions: "HOLD_SLOT_SENTINEL hold for the recovery test.", acceptanceCriteria: ["stopped"] }],
    }, undefined, undefined, {});
    assert.equal(original.isError, false);
    const originalId = original.details.executionId as string;
    const originalTaskId = original.details.tasks[0].taskId as string;
    await waitFor(
      () => Boolean(taskDispatchEntry(controller.liveDispatchView(originalId), originalTaskId).dispatch),
      30_000,
      "original dispatch record",
    );

    // Render the original card: subscribes through weak row ownership.
    const invalidateCount = { count: 0 };
    const context = { state: {} as Record<string, unknown>, invalidate: () => { invalidateCount.count += 1; } };
    renderCard(start, original, context);

    // Stop it as failure: inactive and NOT archivable — it can be continued
    // and dispatch again, so its card must keep watching.
    const interrupted = await (interrupt.execute as ExecuteTool)("recoverable-interrupt", {
      executionId: originalId,
      taskId: originalTaskId,
      interruptMode: "interrupt_as_failure",
    }, undefined, undefined, {});
    assert.equal(interrupted.isError, false);
    await waitFor(
      () => taskDispatchEntry(controller.liveDispatchView(originalId), originalTaskId).state === "interrupted",
      30_000,
      "interrupted state",
    );

    // An unrelated execution dispatches: its record event runs the sweep.
    const other = await (start.execute as ExecuteTool)("recoverable-other", {
      tasks: [{ title: "Sweep trigger task", instructions: "OTHER_SWEEP_SENTINEL", acceptanceCriteria: ["dispatched"] }],
    }, undefined, undefined, {});
    assert.equal(other.isError, false);
    const otherId = other.details.executionId as string;
    const otherTaskId = other.details.tasks[0].taskId as string;
    await waitFor(
      () => Boolean(taskDispatchEntry(controller.liveDispatchView(otherId), otherTaskId).dispatch),
      30_000,
      "unrelated dispatch (sweep trigger)",
    );

    // The recoverable original card must NOT have been swept: only archivable
    // (permanently terminal) tasks count as settled for the sweep.
    assert.equal(hasDispatchCardWatcher(originalId), true, "recoverable cards keep their subscription across sweeps");
    assert.equal(invalidateCount.count, 0, "no dispatch event for the original card yet");

    // Inspect backfills the durable continuation bundle from the operation
    // record (the real recovery flow before a continue).
    const inspected = await (inspect.execute as ExecuteTool)("recoverable-inspect", {
      executionId: originalId,
      taskId: originalTaskId,
    }, undefined, undefined, {});
    assert.equal(inspected.isError, false);

    // Continue the stopped task: its re-dispatch must invalidate the ORIGINAL
    // card without any manual re-render in between.
    const continued = await (continueTool.execute as ExecuteTool)("recoverable-continue", {
      executionId: originalId,
      taskId: originalTaskId,
      instructions: "CONTINUE_AFTER_STOP_SENTINEL finish the work.",
    }, undefined, undefined, {});
    assert.equal(continued.isError, false);
    await waitFor(() => invalidateCount.count > 0, 30_000, "original-card invalidation on the continue re-dispatch");

    // The refreshed card shows the latest actual dispatch (the continuation
    // prompt), with the initial dispatch preserved as provenance.
    const refreshed = renderCard(start, original, context);
    assert.match(refreshed, /dispatch: prompt delivered to transport/);
    assert.match(refreshed, /re-dispatched after recovery \(latest actual dispatch shown\)/);
  } finally {
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    await rm(root, { recursive: true, force: true });
  }
});

const hasForcedGc = typeof (globalThis as Record<string, unknown>).gc === "function";

test("detached card rows release their dispatch subscriptions on collection without evicting live cards", {
  skip: hasForcedGc ? false : "requires --expose-gc for weak-reference finalization coverage (NODE_OPTIONS=--expose-gc)",
}, async () => {
  resetDispatchCardsForTests();
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
    getActiveTools() { return ["read", "bash", "SubtasksStart"]; },
  };
  const manager = new ExecutionToolManager({
    pi,
    config: controllerConfig("/tmp", "/tmp/dispatch-executor.cjs", 1),
    state: createState(),
    cwd: () => "/tmp",
  });
  manager.sync();
  const start = toolOf(tools, "SubtasksStart");
  const envelopeFor = (executionId: string) => ({
    content: [{ type: "text", text: `accepted ${executionId}` }],
    isError: false,
    details: { action: "start", executionId, kind: "execute", tasks: [] },
  });

  const countA = { value: 0 };
  const countB = { value: 0 };
  // Row A will be detached; row B stays live for the whole test.
  let contextA: { state: Record<string, unknown>; invalidate: () => void } | undefined = {
    state: {},
    invalidate: () => { countA.value += 1; },
  };
  const contextB = { state: {} as Record<string, unknown>, invalidate: () => { countB.value += 1; } };
  renderCard(start, envelopeFor("exec-weak-a"), contextA);
  renderCard(start, envelopeFor("exec-weak-b"), contextB);
  assert.equal(hasDispatchCardWatcher("exec-weak-a"), true);
  assert.equal(hasDispatchCardWatcher("exec-weak-b"), true);

  // While both rows are alive, weak ownership still routes events, and a
  // second render of the same row does not double-subscribe.
  notifyDispatchCards("exec-weak-a", "task-a");
  assert.equal(countA.value, 1);
  renderCard(start, envelopeFor("exec-weak-a"), contextA);
  notifyDispatchCards("exec-weak-a", "task-a");
  assert.equal(countA.value, 2, "one listener per row, not one per render");

  // Detach row A: drop the only strong references to its context/state.
  contextA = undefined;
  const gc = (globalThis as { gc: () => void }).gc;
  for (let i = 0; i < 8 && hasDispatchCardWatcher("exec-weak-a"); i += 1) {
    gc();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.equal(hasDispatchCardWatcher("exec-weak-a"), false, "the collected row's subscription is released by finalization");
  assert.equal(hasDispatchCardWatcher("exec-weak-b"), true, "the live card is not evicted by the detached row's cleanup");

  // The live row still receives events; the detached one no longer does.
  notifyDispatchCards("exec-weak-a", "task-a");
  notifyDispatchCards("exec-weak-b", "task-b");
  assert.equal(countA.value, 2);
  assert.equal(countB.value, 1);
  await manager.shutdown();
  await manager.detach();
});
