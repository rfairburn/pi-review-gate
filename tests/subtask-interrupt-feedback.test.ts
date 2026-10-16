/**
 * Issue #191: model-visible interruption feedback through the REGISTERED
 * /subtask-interrupt command and SubtasksInterrupt tool, driving the real
 * ExecutionToolManager/BackgroundExecutionController with real executor
 * processes in scratch git repositories. The host's sendMessage is captured
 * here; that it reaches the next model request is proven separately against
 * the installed Pi host in tests/subtask-interrupt-feedback-host.test.ts.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { BackgroundExecutionController, type BackgroundFaultHooks, type BackgroundInspection } from "../src/execution/background-controller";
import { SUBTASK_INTERRUPT_FEEDBACK_CUSTOM_TYPE } from "../src/execution/interrupt-feedback";
import { sourceMutationCoordinator } from "../src/execution/source-mutation-lease";
import { EXECUTION_TOOL_NAMES, ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";
import { controllerInternals, initGitRepo, waitFor, waitForAsync } from "./helpers/background-controller-fixtures";

const execFileAsync = promisify(execFile);
const INTENT = "User intent: interrupted by user; do not restart without authorization.";
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";

interface Sent { message: { customType: string; content: string; display?: boolean; details?: Record<string, unknown> }; options: unknown }

const WRITING_EXECUTOR = [
  "#!/usr/bin/env node",
  "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
  "fs.writeFileSync('draft.txt','worker draft\\n');",
  "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
  "});",
];
/** Records its start outside every worktree (inside the repo's .git), so it makes no worker change. */
const IDLE_EXECUTOR = (marker: string) => [
  "#!/usr/bin/env node",
  "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
  `fs.writeFileSync(${JSON.stringify(marker)},'');`,
  "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
  "});",
];

/**
 * A research-eligible codex-cli app-server stand-in (no real Codex, provider,
 * or network): it accepts one turn, never completes it on its own, and
 * settles the turn as interrupted only when asked through turn/interrupt.
 */
const RESEARCH_APP_SERVER = [
  "#!/usr/bin/env node",
  "const readline=require('node:readline');let threadId='thread-'+process.pid,turn=0;",
  "const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');",
  "readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);",
  "if(request.method==='initialize')return send({jsonrpc:'2.0',id:request.id,result:{userAgent:'test-codex'}});",
  "if(request.id===undefined)return;",
  "if(request.method==='thread/start'||request.method==='thread/resume'){threadId=request.params.threadId||threadId;return send({jsonrpc:'2.0',id:request.id,result:{thread:{id:threadId}}});}",
  "if(request.method==='turn/start')return send({jsonrpc:'2.0',id:request.id,result:{turn:{id:'turn-'+(++turn)}}});",
  "if(request.method==='turn/interrupt'){send({jsonrpc:'2.0',id:request.id,result:{}});return send({jsonrpc:'2.0',method:'turn/completed',params:{threadId,turn:{id:request.params.turnId,status:'interrupted',items:[]}}});}",
  "send({jsonrpc:'2.0',id:request.id,result:{}});",
  "});",
];

/**
 * Resources one test owns, released in reverse acquisition order once the
 * test body (or a partial setup) ends. Owned executor children are settled
 * first and proven quiescent through the controller's own #310 durable
 * ownership check; the scratch tree is deleted only afterwards, so a possibly
 * live writer's ownership evidence is retained and reported, never removed.
 */
interface OwnedScope { scratch?: string; settlers: Array<() => Promise<string[]>> }

/** Shut the manager down, then report every task whose owned writer may still be live. */
async function settleOwnedManager(manager: ExecutionToolManager): Promise<string[]> {
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  // The prototype method, so an instance-level fault seam cannot mask a live writer.
  const unverifiedWriter = (BackgroundExecutionController.prototype as unknown as {
    unverifiedWriterAfterInterrupt: (group: unknown, task: unknown) => Promise<string | undefined>;
  }).unverifiedWriterAfterInterrupt;
  try {
    await manager.shutdown();
    const uncertain: string[] = [];
    for (const group of controllerInternals(controller).groups.values()) {
      for (const task of group.tasks) {
        const reason = await unverifiedWriter.call(controller, group, task);
        if (reason) uncertain.push(`${task.taskId}: ${reason}`);
      }
    }
    return uncertain;
  } finally {
    await manager.detach();
  }
}

async function releaseOwned(scope: OwnedScope): Promise<void> {
  const failures: unknown[] = [];
  const uncertain: string[] = [];
  for (const settle of scope.settlers.splice(0).reverse()) {
    try {
      uncertain.push(...await settle());
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0 || uncertain.length > 0) {
    throw new AggregateError(failures, `owned executor children were not proven settled${uncertain.length > 0 ? ` (${uncertain.join("; ")})` : ""}; retained ${scope.scratch ?? "no scratch tree"} as ownership evidence`);
  }
  if (scope.scratch) await rm(scope.scratch, { recursive: true, force: true });
}

/** A body or setup failure always wins over a release failure, which is still reported. */
async function withOwnedScope(body: (scope: OwnedScope) => Promise<void>): Promise<void> {
  const scope: OwnedScope = { settlers: [] };
  let primary: { error: unknown } | undefined;
  try {
    await body(scope);
  } catch (error) {
    primary = { error };
  }
  try {
    await releaseOwned(scope);
  } catch (releaseError) {
    if (!primary) throw releaseError;
    console.warn(`#191 fixture release also failed after the primary failure: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
  }
  if (primary) throw primary.error;
}

interface HarnessOptions { executorLines?: string[] | ((marker: string) => string[]); maxConcurrent?: number; faults?: BackgroundFaultHooks; sendThrows?: boolean; research?: boolean }

async function harness(scope: OwnedScope, label: string, options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), `pi-review-interrupt-feedback-${label}-`));
  scope.scratch = root;
  await initGitRepo(root);
  const executor = join(root, "executor.cjs");
  const marker = join(root, ".git", "prg-executor-started");
  const lines = typeof options.executorLines === "function" ? options.executorLines(marker) : options.executorLines ?? WRITING_EXECUTOR;
  await writeFile(executor, lines.join("\n"), "utf8");
  await chmod(executor, 0o755);
  const researcher = join(root, "research-app-server.cjs");
  if (options.research) {
    await writeFile(researcher, RESEARCH_APP_SERVER.join("\n"), "utf8");
    await chmod(researcher, 0o755);
  }
  const maxConcurrent = options.maxConcurrent ?? 2;
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      fake: { adapter: "run-as-binary", command: executor, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      // codex-cli is research-eligible (workerResourceSupportsResearch); run-as-binary is not.
      ...(options.research ? { researcher: { adapter: "codex-cli", command: researcher, execution: {} } } : {}),
    },
    execution: {
      maxWorkers: maxConcurrent,
      workerResources: {
        default: { selection: { source: "external", id: "fake" }, maxConcurrent },
        ...(options.research ? { researcher: { selection: { source: "external", id: "researcher" }, maxConcurrent } } : {}),
      },
      routes: { execute: [{ resourceId: "default" }], research: options.research ? [{ resourceId: "researcher" }] : [] },
    },
    retainBundles: "always",
  });
  const sent: Sent[] = [];
  const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const tools: Array<Record<string, any>> = [];
  const pi = {
    registerTool: (tool: Record<string, any>) => { tools.push(tool); },
    registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => { handlers.set(name, definition.handler); },
    setToolActive() {},
    getActiveTools: () => ["read", "bash", ...Object.values(EXECUTION_TOOL_NAMES)],
    sendMessage: (message: Sent["message"], deliveryOptions: unknown) => {
      if (options.sendThrows) throw new Error("This extension ctx is stale after session replacement or reload.");
      sent.push({ message, options: deliveryOptions });
    },
  };
  const input = { pi, config, state: createState(), cwd: () => root, ...(options.faults ? { faults: options.faults } : {}) };
  const manager = new ExecutionToolManager(input as ConstructorParameters<typeof ExecutionToolManager>[0]);
  scope.settlers.push(() => settleOwnedManager(manager));
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  const notices: Array<{ message: string; level: string }> = [];
  const ctx = { ui: { notify: async (message: string, level: string) => { notices.push({ message, level }); } } };
  return {
    root,
    marker,
    manager,
    controller,
    sent,
    notices,
    feedback: () => sent.filter((entry) => entry.message.customType === SUBTASK_INTERRUPT_FEEDBACK_CUSTOM_TYPE),
    slash: (args: string) => handlers.get("subtask-interrupt")!(args, ctx),
    tool: (name: string) => tools.find((candidate) => candidate.name === name)!.execute as (id: string, params: unknown, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>,
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function withHarness(label: string, run: (h: Harness) => Promise<void>): Promise<void>;
function withHarness(label: string, options: HarnessOptions, run: (h: Harness) => Promise<void>): Promise<void>;
function withHarness(label: string, ...rest: [(h: Harness) => Promise<void>] | [HarnessOptions, (h: Harness) => Promise<void>]): Promise<void> {
  const [options, run] = rest.length === 1 ? [{}, rest[0]] : rest;
  return withOwnedScope(async (scope) => run(await harness(scope, label, options)));
}

async function startRunning(h: Harness, title: string, kind: "execute" | "inplace" = "execute", startedMarker?: string) {
  const started = await h.controller.start([{ title, instructions: "work", acceptanceCriteria: ["done"] }], kind);
  const taskId = started.tasks[0]!.taskId;
  await waitFor(() => h.controller.inspect(started.executionId, taskId).tasks[0]?.state === "running", 30_000);
  await waitForAsync(async () => {
    if (startedMarker) return readFile(startedMarker, "utf8").then(() => true, () => false);
    const task = h.controller.inspect(started.executionId, taskId).tasks[0];
    if (!task?.waveRoot) return false;
    return readFile(join(task.waveRoot, "workers", taskId, "draft.txt"), "utf8").then(() => true, () => false);
  }, 30_000);
  return { executionId: started.executionId, taskId };
}

function assertUserFeedback(entry: Sent | undefined, expect: { taskId: string; executionId: string; kind: string; mode: string }): string {
  assert.ok(entry, "a feedback note was queued");
  assert.deepEqual(entry.options, { triggerTurn: false }, "feedback never triggers a turn");
  assert.equal(entry.message.display, true);
  const text = entry.message.content;
  assert.ok(text.includes(INTENT), "carries both exact phrases in the qualified intent line");
  assert.ok(text.includes(`Task ${expect.taskId}`));
  assert.ok(text.includes(`${expect.kind} execution ${expect.executionId}; requested mode ${expect.mode}`));
  assert.equal(entry.message.details?.origin, "human-command");
  assert.equal(entry.message.details?.actor, "user");
  return text;
}

test("#191 /subtask-interrupt on a queued task reports the queued attempt never started; merge reports no merge by this request", () => withHarness("queued", { maxConcurrent: 1 }, async (h) => {
  const started = await h.controller.start([
    { title: "occupies the only slot", instructions: "work", acceptanceCriteria: ["done"] },
    { title: "waits in queue", instructions: "work", acceptanceCriteria: ["done"] },
    { title: "also waits", instructions: "work", acceptanceCriteria: ["done"] },
  ]);
  const [, second, third] = started.tasks.map((task) => task.taskId);
  await waitFor(() => h.controller.inspect(started.executionId).tasks[0]?.state === "running", 30_000);
  assert.equal(h.controller.inspect(started.executionId, second).tasks[0]?.state, "queued");

  await h.slash(`${started.executionId} ${second} failure`);
  assert.equal(h.feedback().length, 1);
  const failure = assertUserFeedback(h.feedback()[0], { taskId: second!, executionId: started.executionId, kind: "execute", mode: "interrupt_as_failure" });
  assert.match(failure, /Stop: acknowledged before executor startup of the current queued attempt; that queued attempt never started\. This says nothing about earlier attempts or any work, session, or checkpoint they retained\./);
  assert.doesNotMatch(failure, /Merge:/);
  assert.equal(h.feedback()[0]!.message.details?.stop, "stopped_before_start");
  assert.match(h.notices.at(-1)?.message ?? "", /interrupted/, "the existing UI result is unchanged");

  await h.slash(`${started.executionId} ${third} merge`);
  const [requested, settled] = h.feedback().slice(1);
  assert.equal(h.feedback().length, 3, "merge mode adds the intent note before the settlement note");
  const intent = assertUserFeedback(requested, { taskId: third!, executionId: started.executionId, kind: "execute", mode: "interrupt_with_merge" });
  assert.match(intent, /does not claim that the task stopped or that anything landed/);
  const merged = assertUserFeedback(settled, { taskId: third!, executionId: started.executionId, kind: "execute", mode: "interrupt_with_merge" });
  assert.match(merged, /Merge: no merge was attempted by this request for the current queued attempt; this does not indicate whether earlier work or a retained checkpoint exists\./);
  assert.equal(settled!.message.details?.merge, "not_attempted");
  assert.equal(h.sent.filter((entry) => entry.message.customType !== SUBTASK_INTERRUPT_FEEDBACK_CUSTOM_TYPE).length, 0, "no wake or other notification was produced");
}));

test("#191 /subtask-interrupt on a queued continuation describes only the queued attempt, never the absence of earlier work or checkpoint", () => withHarness("queued-continuation", { maxConcurrent: 1 }, async (h) => {
  // A real first attempt runs, writes worker edits, and is stopped; its
  // verified checkpoint, resumable session, and continuation bundle survive.
  const prior = await startRunning(h, "continued after prior work");
  await h.controller.interrupt({ executionId: prior.executionId, taskId: prior.taskId, mode: "interrupt_as_failure", instructionId: "setup-prior-stop", actor: "user" });
  assert.equal(h.feedback().length, 0, "direct controller calls queue no command feedback");
  const stopped = h.controller.inspect(prior.executionId, prior.taskId).tasks[0]!;
  assert.equal(stopped.state, "interrupted");
  assert.ok(stopped.initialDispatch, "an earlier attempt was dispatched to an executor");
  assert.ok(stopped.bundle, "the earlier attempt retains a continuation bundle");
  const priorResult = stopped.result?.taskResults[0];
  const checkpoint = priorResult?.checkpoint;
  assert.equal(checkpoint?.verified, true, "the earlier attempt retains a verified checkpoint");
  assert.deepEqual(checkpoint?.changedPaths, ["draft.txt"]);
  assert.equal(priorResult?.diagnostics?.session?.resumable, true, "the earlier attempt retains a resumable session");
  assert.equal(checkpoint?.differsFromBase, true, "the earlier attempt's edits are captured in its checkpoint");

  // Occupy the only slot, then queue the continuation behind it.
  const occupant = await startRunning(h, "occupies the only slot");
  const queued = await h.controller.continueTask({ executionId: prior.executionId, taskId: prior.taskId, instructions: "continue the retained work", instructionId: "setup-continue", actor: "user" });
  assert.equal(queued.tasks.find((task) => task.taskId === prior.taskId)?.state, "queued");
  assert.equal(h.controller.inspect(occupant.executionId, occupant.taskId).tasks[0]?.state, "running");

  await h.slash(`${prior.executionId} ${prior.taskId} merge`);
  const settledEntry = h.feedback().at(-1);
  const settled = assertUserFeedback(settledEntry, { taskId: prior.taskId, executionId: prior.executionId, kind: "execute", mode: "interrupt_with_merge" });
  assert.equal(settledEntry!.message.details?.stop, "stopped_before_start");
  assert.equal(settledEntry!.message.details?.merge, "not_attempted");
  assert.match(settled, /Stop: acknowledged before executor startup of the current queued attempt; that queued attempt never started\. This says nothing about earlier attempts or any work, session, or checkpoint they retained\./);
  assert.match(settled, /Merge: no merge was attempted by this request for the current queued attempt; this does not indicate whether earlier work or a retained checkpoint exists\./);
  // The ENTIRE note, including any carried controller wording, never infers
  // that no earlier work or checkpoint exists.
  assert.doesNotMatch(settled, /no (task )?checkpoint|no earlier work|(the )?task never started/i, "the note never infers no earlier work or checkpoint");
  assert.match(settled, /Current task state: interrupted\.$/m, "the state is still reported without the controller's pre-start outcome");
  assert.doesNotMatch(settled, /Authoritative outcome:|Recorded interrupt activity:/);
  assert.match(h.controller.inspect(prior.executionId, prior.taskId).tasks[0]!.summary ?? "", /no task checkpoint to merge/, "the controller's persisted summary is unchanged");
  // The earlier attempt's checkpoint and bundle are still retained after the stop.
  const after = h.controller.inspect(prior.executionId, prior.taskId).tasks[0]!;
  assert.equal(after.state, "interrupted");
  assert.ok(after.bundle, "the retained bundle survives the queued-attempt stop");
  assert.equal(after.result?.taskResults[0]?.checkpoint?.commitSha, checkpoint!.commitSha, "the retained checkpoint survives the queued-attempt stop");
  assert.equal(after.commands.some((command) => command.action === "force_merge"), false, "no merge was attempted");
  await assert.rejects(readFile(join(h.root, "draft.txt"), "utf8"), /ENOENT/, "nothing landed in main");
}));

test("#191 /subtask-interrupt merge whose save fails after an acknowledged stop and before forceMerge reports the merge unrecorded, not failed", async () => {
  let controller: BackgroundExecutionController | undefined;
  let target: string | undefined;
  let injected = false;
  await withHarness("save-before-merge", {
    faults: {
      // Narrow seam: fail only the persistence of this request's acknowledged
      // quiescence, which the controller performs before it calls forceMerge.
      save: () => {
        if (injected || !target) return;
        for (const group of controllerInternals(controller!).groups.values()) {
          const task = group.tasks.find((candidate) => candidate.taskId === target);
          if (!task) continue;
          const acknowledged = task.commands.some((command) => command.action === "interrupt" && command.instructionId.startsWith("user-interrupt-") && command.status === "acknowledged");
          const merging = task.commands.some((command) => command.action === "force_merge");
          if (acknowledged && !merging && /^Writer quiesced\./.test(task.activity.at(-1)?.message ?? "")) {
            injected = true;
            throw new Error("injected save failure after quiescence");
          }
        }
      },
    },
  }, async (h) => {
    controller = h.controller;
    const { executionId, taskId } = await startRunning(h, "save fails before merge");
    target = taskId;
    await h.slash(`${executionId} ${taskId} merge`);
    assert.equal(injected, true, "the save fault fired");
    assert.equal(h.notices.at(-1)?.level, "error", "the command still fails in the UI");
    const entry = h.feedback().at(-1);
    const settled = assertUserFeedback(entry, { taskId, executionId, kind: "execute", mode: "interrupt_with_merge" });
    assert.match(settled, /Stop: acknowledged\./);
    assert.match(settled, /Merge: no merge record exists for this request; it failed after the stop was acknowledged, so whether a merge was attempted is unknown and no landing is confirmed\. See the request error\./);
    assert.match(settled, /Request error: injected save failure after quiescence/);
    assert.doesNotMatch(settled, /mechanical merge failed|merge attempt was acknowledged|failed before it was recorded/);
    assert.equal(entry!.message.details?.merge, "unrecorded");
    assert.equal(entry!.message.details?.stop, "acknowledged");
    const task = h.controller.inspect(executionId, taskId).tasks[0]!;
    assert.equal(task.commands.some((command) => command.action === "force_merge"), false, "forceMerge was never called");
    assert.equal(h.sent.filter((sent) => sent.message.customType === "pi-review-subtask-event").length, 0, "no landing wake");
    await assert.rejects(readFile(join(h.root, "draft.txt"), "utf8"), /ENOENT/, "nothing landed in main");
  });
});

test("#191 /subtask-interrupt merge orders intent before the completion wake and reports the acknowledged landing", () => withHarness("merge-landed", async (h) => {
  const { executionId, taskId } = await startRunning(h, "merge me");
  await h.slash(`${executionId} ${taskId} merge`);
  const types = h.sent.map((entry) => entry.message.customType);
  assert.deepEqual(types, [SUBTASK_INTERRUPT_FEEDBACK_CUSTOM_TYPE, "pi-review-subtask-event", SUBTASK_INTERRUPT_FEEDBACK_CUSTOM_TYPE]);
  const settled = assertUserFeedback(h.sent[2], { taskId, executionId, kind: "execute", mode: "interrupt_with_merge" });
  assert.match(settled, /Stop: acknowledged\./);
  assert.match(settled, /Recorded interrupt activity: Writer quiesced\./);
  assert.match(settled, /Merge: the mechanical merge attempt was acknowledged; the task state is now landed\./);
  assert.match(settled, /Current task state: landed\./);
  assert.equal(await readFile(join(h.root, "draft.txt"), "utf8"), "worker draft\n");
}));

test("#191 /subtask-interrupt merge with no worker changes reports the controller's no-landed outcome, not a landing", () => withHarness("merge-empty", { executorLines: IDLE_EXECUTOR }, async (h) => {
  const { executionId, taskId } = await startRunning(h, "nothing to land", "execute", h.marker);
  await h.slash(`${executionId} ${taskId} merge`);
  const settled = assertUserFeedback(h.feedback().at(-1), { taskId, executionId, kind: "execute", mode: "interrupt_with_merge" });
  const task = h.controller.inspect(executionId, taskId).tasks[0]!;
  const forceMerge = task.commands.find((command) => command.action === "force_merge");
  assert.equal(forceMerge?.status, "acknowledged");
  assert.match(task.summary ?? "", /identified no remaining changes to land|contains no changes that remain to be landed/);
  assert.match(settled, /Merge: the mechanical merge attempt was acknowledged/);
  assert.ok(settled.includes(`Authoritative outcome: ${task.summary}`), "the controller's own no-change outcome is reported");
  assert.doesNotMatch(settled, /force-merged mechanically into the main workspace/);
  assert.equal(await readFile(join(h.root, "draft.txt"), "utf8").catch(() => "absent"), "absent", "nothing landed in main");
}));

test("#191 /subtask-interrupt merge that throws after an acknowledged stop reports both halves truthfully", () => withHarness("merge-throws", {
  faults: { materializeLandingConflicts: () => { throw new Error("injected conflict materialization failure"); } },
}, async (h) => {
  const { executionId, taskId } = await startRunning(h, "conflicting merge");
  // Diverge main on the same path so the merge must materialize conflicts.
  await writeFile(join(h.root, "draft.txt"), "main draft\n", "utf8");
  await execFileAsync("git", ["add", "draft.txt"], { cwd: h.root });
  await execFileAsync("git", ["commit", "-qm", "main draft"], { cwd: h.root });
  await h.slash(`${executionId} ${taskId} merge`);
  assert.equal(h.notices.at(-1)?.level, "error", "the command still fails in the UI");
  const settled = assertUserFeedback(h.feedback().at(-1), { taskId, executionId, kind: "execute", mode: "interrupt_with_merge" });
  assert.match(settled, /Stop: acknowledged\./);
  assert.match(settled, /Merge: the mechanical merge failed: injected conflict materialization failure/);
  assert.match(settled, /Request error: injected conflict materialization failure/);
  assert.equal(h.feedback().at(-1)!.message.details?.merge, "failed");
  assert.equal(h.sent.filter((entry) => entry.message.customType === "pi-review-subtask-event").length, 0, "no landing wake");
}));

test("#191 /subtask-interrupt cancelling a force-merge that waits for source access reports the cancellation, not a merge", () => withHarness("pending-merge", async (h) => {
  const { executionId, taskId } = await startRunning(h, "pending merge");
  // Setup only: stop the writer directly (no command feedback), then queue a
  // force-merge behind a held source mutation lease.
  await h.controller.interrupt({ executionId, taskId, mode: "interrupt_as_failure", instructionId: "setup-stop", actor: "user" });
  assert.equal(h.feedback().length, 0, "direct controller calls queue no command feedback");
  const releaseLease = await sourceMutationCoordinator.acquire(h.root);
  try {
    const waiting = h.controller.forceMerge({ executionId, taskId, mergeAnyhow: false, instructionId: "waiting-merge", actor: "model" });
    waiting.catch(() => undefined);
    await waitFor(() => h.controller.inspect(executionId, taskId).tasks[0]!.commands.some((command) => command.instructionId === "waiting-merge"));
    await h.slash(`${executionId} ${taskId} merge`);
    await assert.rejects(waiting, /interrupt/);
  } finally {
    releaseLease();
  }
  assert.equal(h.feedback().length, 2);
  const settled = assertUserFeedback(h.feedback()[1], { taskId, executionId, kind: "execute", mode: "interrupt_with_merge" });
  assert.match(settled, /Stop: acknowledged\./);
  assert.match(settled, /Recorded interrupt activity: Cancelled a force-merge that was waiting for source workspace access; no checkpoint landed and the main workspace is unchanged\./);
  assert.match(settled, /Merge: no merge was attempted by this request\./);
  await assert.rejects(readFile(join(h.root, "draft.txt"), "utf8"), /ENOENT/);
}));

test("#191 /subtask-interrupt with an unverified writer keeps the intent qualified and never claims a stop or merge", () => withHarness("unverified", async (h) => {
  const { executionId, taskId } = await startRunning(h, "unverified writer");
  // Fault seam: the real controller's #310 post-settlement quiescence check
  // reports an unverified owned writer (the native case is covered by
  // background-controller-interruption-merge #310).
  (h.controller as unknown as { unverifiedWriterAfterInterrupt: () => Promise<string> }).unverifiedWriterAfterInterrupt =
    async () => "executor shutdown was not verified";
  await h.slash(`${executionId} ${taskId} merge`);
  const settled = assertUserFeedback(h.feedback().at(-1), { taskId, executionId, kind: "execute", mode: "interrupt_with_merge" });
  assert.match(settled, /Stop: NOT confirmed; the interrupt command failed: Writer quiescence was not verified: executor shutdown was not verified/);
  assert.match(settled, /Merge: no merge was attempted because the stop was not confirmed\./);
  assert.doesNotMatch(settled, /Stop: acknowledged|Writer quiesced/);
  assert.equal(h.feedback().at(-1)!.message.details?.stop, "unconfirmed");
}));

test("#191 inplace /subtask-interrupt is failure-only and a rejected merge request reports that nothing was stopped", () => withHarness("inplace", { executorLines: IDLE_EXECUTOR }, async (h) => {
  const { executionId, taskId } = await startRunning(h, "in place work", "inplace", h.marker);
  await h.slash(`${executionId} ${taskId} merge`);
  assert.equal(h.feedback().length, 1, "no intent note: merge is not available for inplace");
  const rejected = assertUserFeedback(h.feedback()[0], { taskId, executionId, kind: "inplace", mode: "interrupt_with_merge" });
  assert.match(rejected, /Stop: this request was not recorded for the task, so it did not stop anything\./);
  assert.match(rejected, /Request error: In-place tasks cannot use interrupt_with_merge/);
  assert.equal(h.controller.inspect(executionId, taskId).tasks[0]?.state, "running");

  await h.slash(`${executionId} ${taskId} failure`);
  const stopped = assertUserFeedback(h.feedback()[1], { taskId, executionId, kind: "inplace", mode: "interrupt_as_failure" });
  assert.match(stopped, /Stop: acknowledged\./);
  assert.doesNotMatch(stopped, /Merge:/);
}));

/**
 * Start research tasks through the registered SubtasksStart tool, which
 * captures the authoritative parent tool ceiling a Codex research launch
 * requires; the first task is active once its Codex turn was accepted and its
 * live control registered.
 */
async function startResearch(h: Harness, titles: string[]): Promise<{ executionId: string; taskIds: string[] }> {
  const result = await h.tool("SubtasksStart")("research-start", {
    kind: "research",
    tasks: titles.map((title) => ({ title, instructions: "Inspect base.txt and report evidence.", acceptanceCriteria: ["Return an evidence-backed report"] })),
  }, undefined, undefined, {});
  assert.equal(result.isError, false);
  const started = result.details as BackgroundInspection;
  assert.equal(started.kind, "research");
  const taskIds = started.tasks.map((task) => task.taskId);
  const runtimes = (h.controller as unknown as { runtimes: Map<string, { control?: unknown }> }).runtimes;
  await waitFor(() => runtimes.get(taskIds[0]!)?.control !== undefined, 30_000);
  assert.equal(h.controller.inspect(started.executionId, taskIds[0]).tasks[0]?.state, "running");
  return { executionId: started.executionId, taskIds };
}

/** Research never lands: tracked content is unchanged and only the fixture's own scripts are untracked. */
async function assertNothingLanded(h: Harness): Promise<void> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: h.root });
  assert.deepEqual(stdout.split("\n").filter(Boolean).sort(), ["?? executor.cjs", "?? research-app-server.cjs"]);
  assert.equal(h.sent.filter((entry) => /landed mechanically|force-merged/.test(entry.message.content)).length, 0, "no landing was claimed");
}

test("#191 research /subtask-interrupt: rejected merges stop nothing, a queued failure stopped before its attempt started, an active failure reports the transport stop and no landing", () => withHarness("research", { research: true, maxConcurrent: 1 }, async (h) => {
  const { executionId, taskIds: [active, queued] } = await startResearch(h, ["active research", "queued research"]);
  assert.equal(h.controller.inspect(executionId, queued).tasks[0]?.state, "queued");

  for (const [index, taskId] of [queued!, active!].entries()) {
    await h.slash(`${executionId} ${taskId} merge`);
    assert.equal(h.notices.at(-1)?.level, "error", "the controller still rejects research merge in the UI");
    assert.equal(h.feedback().length, index + 1, "no intent note: merge is not available for research");
    const rejected = assertUserFeedback(h.feedback().at(-1), { taskId, executionId, kind: "research", mode: "interrupt_with_merge" });
    assert.match(rejected, /Stop: this request was not recorded for the task, so it did not stop anything\./);
    assert.match(rejected, /Merge: no merge was attempted by this request\./);
    assert.match(rejected, /Request error: Research tasks cannot use interrupt_with_merge because research workspaces are never eligible to land/);
    assert.doesNotMatch(rejected, /Stop: acknowledged/);
    assert.equal(h.feedback().at(-1)!.message.details?.stop, "rejected");
  }
  assert.equal(h.controller.inspect(executionId, queued).tasks[0]?.state, "queued", "the rejected merge left the queued task queued");
  assert.equal(h.controller.inspect(executionId, active).tasks[0]?.state, "running", "the rejected merge left the active task running");

  await h.slash(`${executionId} ${queued} failure`);
  const neverStarted = assertUserFeedback(h.feedback().at(-1), { taskId: queued!, executionId, kind: "research", mode: "interrupt_as_failure" });
  assert.match(neverStarted, /Stop: acknowledged before executor startup of the current queued attempt; that queued attempt never started\. This says nothing about earlier attempts or any work, session, or checkpoint they retained\./);
  assert.match(neverStarted, /Current task state: interrupted\.$/m);
  assert.doesNotMatch(neverStarted, /Authoritative outcome:|Recorded interrupt activity:/, "a stop before startup carries no pre-start controller wording");
  assert.doesNotMatch(neverStarted, /Merge:/);
  assert.equal(h.feedback().at(-1)!.message.details?.stop, "stopped_before_start");

  await h.slash(`${executionId} ${active} failure`);
  const settled = h.feedback().at(-1);
  const stopped = assertUserFeedback(settled, { taskId: active!, executionId, kind: "research", mode: "interrupt_as_failure" });
  assert.match(stopped, /Stop: acknowledged\./);
  assert.match(stopped, /Recorded interrupt activity: .*Codex app-server acknowledged turn interruption\./, "the actual transport stop is reported");
  assert.match(stopped, /Current task state: interrupted\. Authoritative outcome: Research worker was interrupted; its private workspace was not landed\./);
  assert.doesNotMatch(stopped, /Merge:/);
  assert.equal(settled!.message.details?.stop, "acknowledged");
  assert.equal(settled!.message.details?.merge, "not_requested");
  assert.equal(h.feedback().length, 4, "one settlement note per request; research never queues an intent note");
  await assertNothingLanded(h);
}));

test("#191 model SubtasksInterrupt on research keeps its model origin for a rejected merge and an acknowledged stop", () => withHarness("research-model", { research: true }, async (h) => {
  const { executionId, taskIds: [taskId] } = await startResearch(h, ["model research"]);
  const interrupt = h.tool("SubtasksInterrupt");
  const rejected = await interrupt("model-research-merge", { executionId, taskId, interruptMode: "interrupt_with_merge" }, undefined, undefined, {});
  assert.equal(rejected.isError, true);
  const rejectedText = rejected.content[0].text as string;
  assert.match(rejectedText, /SubtasksInterrupt failed: Research tasks cannot use interrupt_with_merge/);
  assert.ok(rejectedText.includes(`origin: model SubtasksInterrupt call; task ${taskId}; mode interrupt_with_merge`));
  assert.match(rejectedText, /Stop: this request was not recorded for the task, so it did not stop anything\./);
  assert.equal(h.controller.inspect(executionId, taskId).tasks[0]?.state, "running");

  const stopped = await interrupt("model-research-stop", { executionId, taskId, interruptMode: "interrupt_as_failure" }, undefined, undefined, {});
  assert.equal(stopped.isError, false);
  const text = stopped.content[0].text as string;
  assert.ok(text.includes(`origin: model SubtasksInterrupt call; task ${taskId}; mode interrupt_as_failure):`));
  assert.match(text, /Stop: acknowledged\./);
  assert.match(text, /Codex app-server acknowledged turn interruption/);
  for (const result of [rejectedText, text]) assert.doesNotMatch(result, /interrupted by user|User intent|human \/subtask-interrupt/);
  assert.equal(h.feedback().length, 0, "no human-command feedback for a model action");
  assert.equal(h.controller.inspect(executionId, taskId).tasks[0]?.state, "interrupted");
  await assertNothingLanded(h);
}));

test("#191 model SubtasksInterrupt keeps its model origin and queues no user feedback", () => withHarness("model", async (h) => {
  const { executionId, taskId } = await startRunning(h, "model stop");
  const interrupt = h.tool("SubtasksInterrupt");
  const result = await interrupt("model-interrupt-1", { executionId, taskId, interruptMode: "interrupt_as_failure" }, undefined, undefined, {});
  assert.equal(result.isError, false);
  const text = result.content[0].text as string;
  assert.match(text, /Interrupt settlement for this request \(origin: model SubtasksInterrupt call; task task-[^;]+; mode interrupt_as_failure\):/);
  assert.match(text, /Stop: acknowledged\./);
  assert.doesNotMatch(text, /interrupted by user|User intent/);
  assert.equal(h.feedback().length, 0, "no human-command feedback for a model action");

  const second = await startRunning(h, "model merge that throws");
  (h.controller as unknown as { forceMerge: () => Promise<never> }).forceMerge = async () => { throw new Error("injected force-merge failure"); };
  const failed = await interrupt("model-interrupt-2", { executionId: second.executionId, taskId: second.taskId, interruptMode: "interrupt_with_merge" }, undefined, undefined, {});
  assert.equal(failed.isError, true);
  const failedText = failed.content[0].text as string;
  assert.match(failedText, /SubtasksInterrupt failed: injected force-merge failure/);
  assert.match(failedText, /origin: model SubtasksInterrupt call/);
  assert.match(failedText, /Stop: acknowledged\./);
  // The override throws before any force-merge record exists, so the
  // feedback has no proof that a merge was attempted and must not claim one.
  assert.match(failedText, /Merge: no merge record exists for this request; it failed after the stop was acknowledged, so whether a merge was attempted is unknown and no landing is confirmed\./);
  assert.doesNotMatch(failedText, /mechanical merge failed|merge attempt was acknowledged/);
  assert.doesNotMatch(failedText, /interrupted by user/);
  assert.equal(h.feedback().length, 0);
}));

test("#191 feedback is redacted, never sent after the owner session retires, and a stale host channel fails closed", async () => {
  await withHarness("redaction", async (h) => {
    const { executionId, taskId } = await startRunning(h, `token ${SECRET} in title`);
    await h.slash(`${executionId} ${taskId} failure`);
    const text = h.feedback()[0]!.message.content;
    assert.ok(!text.includes(SECRET), "the task title is redacted");
    assert.ok(!JSON.stringify(h.feedback()[0]!.message.details).includes(SECRET));

    const retired = await startRunning(h, "owner retires mid-interrupt");
    const pending = h.slash(`${retired.executionId} ${retired.taskId} failure`);
    await h.manager.shutdown();
    await pending;
    assert.equal(h.feedback().length, 1, "no feedback after the owning session retired");
  });
  await withHarness("stale", { sendThrows: true }, async (stale) => {
    const { executionId, taskId } = await startRunning(stale, "stale host");
    await stale.slash(`${executionId} ${taskId} failure`);
    assert.equal(stale.notices.at(-1)?.level, "info", "the interrupt itself still succeeds");
    assert.equal(stale.sent.length, 0);
  });
});
