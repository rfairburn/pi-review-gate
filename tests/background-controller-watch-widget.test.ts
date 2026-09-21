import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BackgroundExecutionController,
  formatWatchEvent,
} from "../src/execution/background-controller";
import type { BackgroundInspection } from "../src/execution/background-controller";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
import { isActiveTaskState } from "../src/execution/task-state";
import {
  boundedScalingConfig,
  controllerInternals,
  initGitRepo,
  renderWidget,
  settleOldestUnsettled,
  waitFor,
  waitForAsync,
} from "./helpers/background-controller-fixtures";


test("widget and dispatch traverse the controller-wide active index, not settled history", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-active-index-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root, {});
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const startedA = await controller.start([
      { title: "a1", instructions: "work", acceptanceCriteria: ["done"] },
      { title: "a2", instructions: "work", acceptanceCriteria: ["done"] },
      { title: "a3", instructions: "work", acceptanceCriteria: ["done"] },
    ]);
    const startedB = await controller.start([
      { title: "b1", instructions: "work", acceptanceCriteria: ["done"] },
      { title: "b2", instructions: "work", acceptanceCriteria: ["done"] },
    ]);
    const internals = controllerInternals(controller);
    const activeCount = () => internals.activeTasks.size;
    assert.equal(activeCount(), 5, "both groups' live tasks are indexed");
    assert.equal(controller.inspect(startedA.executionId).scheduling.globallyDispatchPending, 5);
    // Readiness checks read the same index.
    assert.equal(controller.reviewReadiness().length, 5);
    assert.ok(controller.reviewReadiness().every((task) => task.state === "queued"));

    // Settle two of A's tasks: the index drops them without touching B's.
    await settleOldestUnsettled(controller, startedA.executionId, "a1");
    await settleOldestUnsettled(controller, startedA.executionId, "a2");
    assert.equal(activeCount(), 3);
    assert.equal(controller.inspect(startedA.executionId).scheduling.globallyDispatchPending, 3);
    assert.equal(controller.inspect(startedA.executionId).scheduling.dispatchPending, 1);
    assert.equal(controller.inspect(startedB.executionId).scheduling.dispatchPending, 2);
    const readiness = controller.reviewReadiness();
    assert.equal(readiness.length, 3);
    assert.equal(readiness.filter((task) => task.executionId === startedA.executionId).length, 1);
    assert.equal(readiness.filter((task) => task.executionId === startedB.executionId).length, 2);
    assert.ok(readiness.every((task) => task.taskId !== startedA.tasks[0]!.taskId));

    // Widget rendering reads the same index: three active across both groups.
    const widgetContents: unknown[] = [];
    const widgetCtx = { ui: { setWidget: (_name: string, content: unknown) => { widgetContents.push(content); } } };
    await controller.toggleExpandedView(widgetCtx);
    const expandedComponent = widgetContents.at(-1) as () => { render(width: number): string[]; invalidate(): void };
    const rendered = expandedComponent().render(240);
    assert.ok(rendered[0]!.includes("3 active background subtasks"));

    // Settle everything, including across groups: the index empties and the
    // compact widget clears.
    await settleOldestUnsettled(controller, startedA.executionId, "a3");
    await settleOldestUnsettled(controller, startedB.executionId, "b1");
    await settleOldestUnsettled(controller, startedB.executionId, "b2");
    assert.equal(activeCount(), 0, "the active index reaches zero after settlement");
    assert.equal(controller.inspect(startedA.executionId).scheduling.globallyDispatchPending, 0);
    assert.deepEqual(controller.reviewReadiness(), []);
    widgetContents.length = 0;
    controller.setUiContext(widgetCtx);
    // The expanded view (toggled above) always renders; with an empty active
    // index it must report zero active tasks rather than settled history.
    const clearedComponent = widgetContents.at(-1) as () => { render(width: number): string[]; invalidate(): void };
    const cleared = clearedComponent().render(240);
    assert.ok(cleared[0]!.includes("0 active background subtasks"));
    assert.ok(cleared.some((line: string) => line.includes("No active background subtasks.")));
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// ── Watch-checkpoint event formatting (controller-owned; finding 14 boundary) ──

const watchConfig = normalizeConfig({
  enabled: true,
  review: { activeReviewers: [] },
  externalAgents: {
    "fake": {
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" as const }
    }
  },
  execution: {
workerResources: {
  "pi-entry": {
    selection: { source: "pi", model: "gpt-x" }, maxConcurrent: 1
  },
  "external-fake": {
    selection: { source: "external", id: "fake" }, maxConcurrent: 1
  }
},
  routes: { execute: [{ resourceId: "pi-entry" }, { resourceId: "external-fake" }], research: [{ resourceId: "pi-entry" }] },
  },
});

test("formatWatchEvent renders a bounded checkpoint report for active tasks only", () => {
  const now = Date.now();
  const inspection = {
    executionId: "exec-1",
    kind: "execute",
    revision: 7,
    tasks: [
      {
        taskId: "task-1",
        definition: { title: "Task one" },
        state: "running",
        updatedAt: new Date(now - 5000).toISOString(),
        executorEntryId: "pi-entry",
        activity: [{ sequence: 3, at: new Date(now - 30_000).toISOString(), phase: "executing", message: "progress ".repeat(40) }],
        timing: { queueMs: 1000, captureMs: 2000, executionMs: 90_000, reviewMs: 0, landingMs: 0, totalMs: 93_000 },
        liveControl: { steer: true },
      },
      {
        taskId: "task-2",
        definition: { title: "Landed task" },
        state: "landed",
        updatedAt: new Date(now - 5000).toISOString(),
        activity: [],
        timing: { queueMs: 0, captureMs: 0, executionMs: 0, reviewMs: 0, landingMs: 0, totalMs: 0 },
      },
    ],
  };
  const single = formatWatchEvent([inspection] as unknown as BackgroundInspection[], watchConfig);
  assert.ok(single.startsWith("[pi-review-subtask-watch]"));
  assert.ok(single.includes("The requested one-shot checkpoint for execution exec-1 is due while work remains active."));
  assert.ok(single.includes("Execution exec-1: 1 active task(s), revision 7."));
  assert.ok(single.includes("- task-1 · Task one · running · gpt-x"));
  assert.ok(single.includes("elapsed 1m33s;"));
  assert.ok(single.includes("last recorded activity 30s ago;"));
  assert.ok(single.includes("controls: inspect yes, steer yes (live yes), interrupt yes"));
  assert.ok(single.includes("recent: executing · "));
  assert.ok(!single.includes("landed task") && !single.includes("Landed task"));

  const both = formatWatchEvent([inspection, { ...inspection, executionId: "exec-2" }] as unknown as BackgroundInspection[], watchConfig);
  assert.ok(both.includes("2 requested one-shot subtask checkpoints became due together"));
  assert.ok(both.includes("Execution exec-2:"));
});

test("formatWatchEvent falls back to updated time and the raw executor entry id", () => {
  const now = Date.now();
  const inspection = {
    executionId: "exec-3",
    kind: "research",
    revision: 1,
    tasks: [{
      taskId: "task-9",
      definition: { title: "Research one" },
      state: "queued",
      updatedAt: new Date(now - 125_000).toISOString(),
      executorEntryId: "unknown-entry",
      activity: [],
      timing: { queueMs: 5000, captureMs: 0, executionMs: 0, reviewMs: 0, landingMs: 0, totalMs: 5000 },
    }],
  };
  const text = formatWatchEvent([inspection] as unknown as BackgroundInspection[], watchConfig);
  assert.ok(text.includes("Research exec-3: 1 active task(s), revision 1."));
  assert.ok(text.includes("- task-9 · Research one · queued · unknown-entry"));
  assert.ok(text.includes("elapsed 5s;"));
  assert.ok(text.includes("last recorded activity 2m5s ago;"));
  assert.ok(text.includes("interrupt yes"));
  assert.ok(text.includes("recent: no recorded activity yet"));
});

test("widget and watch keep the recorded model-less external identity when the catalog later changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-model-less-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    // Deliberately model-less external executor with a readiness/release
    // handshake: it signals ready, then holds the turn running until the test
    // writes release.txt, so active-state assertions run against a state that
    // persists instead of sampling a fixed delay window. The bounded wait is
    // an orphan guard for hard process kills only.
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      "const path=require('node:path');",
      "const dir=process.env.PI_TEST_HANDSHAKE_DIR;",
      "fs.writeFileSync(path.join(dir,'ready.txt'),'ready\\n');",
      "function finish(){",
      "fs.writeFileSync('done.txt','landed\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'model-less-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "}",
      "const release=path.join(dir,'release.txt');",
      "const deadline=Date.now()+30000;",
      "const timer=setInterval(()=>{if(fs.existsSync(release)||Date.now()>deadline){clearInterval(timer);finish();}},10);",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "fake": {
          adapter: "run-as-binary",
          command: executor,
          env: { PI_TEST_HANDSHAKE_DIR: root },
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    const widgets: unknown[] = [];
    const controllerCtx = { ui: { setWidget: (_key: string, content: unknown) => { widgets.push(content); } } };
    controller = new BackgroundExecutionController({
      pi: { sendMessage: () => undefined },
      config,
      state: createState(),
      cwd: () => root,
    });
    const expanded = await controller.toggleExpandedView(controllerCtx);
    assert.equal(expanded, true, "expanded view must be on so widget lines carry executor labels");
    const started = await controller.start([{
      title: "model-less",
      instructions: "write done.txt",
      acceptanceCriteria: ["done.txt exists"],
    }]);

    // Readiness handshake: the executor signals ready and then holds the turn
    // running until explicitly released, so the active-state assertions below
    // run against a state that persists — no sampled delay window.
    const readyPath = join(root, "ready.txt");
    await waitForAsync(async () => {
      try {
        await access(readyPath);
        return true;
      } catch {
        return false;
      }
    });
    // The recorded external selection is on the live record and no model has
    // been reported (the agent has none to report); held, this stays true.
    await waitFor(() => {
      const task = controller!.inspect(started.executionId).tasks[0];
      return task?.state === "running"
        && JSON.stringify(task.executorSelection) === JSON.stringify({ source: "external", id: "fake" })
        && task.executorModel === undefined;
    });
    const beforeEdit = renderWidget(widgets.at(-1)).join("\n");
    assert.ok(beforeEdit.includes("· fake"), `expected the recorded model-less label: ${beforeEdit}`);

    // Catalog edit plus resource reassignment while the task is still active:
    // the agent id now claims a model that never served the task, and the same
    // entry id resolves to a different executor selection entirely.
    const agent = config.externalAgents!["fake"];
    assert.ok(agent, "harness must define the fake agent");
    agent.model = "never-ran-7";
    config.execution!.workerResources = {
      "external-fake": {
        selection: { source: "pi", model: "gpt-reassigned" },
        maxConcurrent: 1,
      },
    };

    // Synchronous re-render against the edited settings: no awaits between the
    // edit and the assertion, so the task is still the same active invocation.
    const postEditCtx = { ui: { setWidget: (_key: string, content: unknown) => { widgets.length = 0; widgets.push(content); } } };
    controller.setUiContext(postEditCtx);
    const postEdit = renderWidget(widgets.at(-1)).join("\n");
    assert.ok(postEdit.includes("· fake"), `catalog edits must not relabel the model-less invocation: ${postEdit}`);
    assert.ok(!postEdit.includes("never-ran-7"), postEdit);
    assert.ok(!postEdit.includes("gpt-reassigned"), postEdit);

    // The watch path renders the same live record through the same label:
    // the honest recorded id, not a current-config re-resolution.
    const watchText = formatWatchEvent([controller.inspect(started.executionId)] as unknown as BackgroundInspection[], config);
    assert.ok(/model-less · \w+ · fake/.test(watchText), watchText);
    assert.ok(!watchText.includes("never-ran-7"), watchText);
    assert.ok(!watchText.includes("gpt-reassigned"), watchText);

    // Release the held invocation; it must still settle normally — labeling
    // changes preserve landing, bounded notifications, and cleanup.
    await writeFile(join(root, "release.txt"), "released\n", "utf8");
    await waitFor(() => controller!.inspect(started.executionId).tasks[0]?.state === "landed", 30_000);
    assert.equal(await readFile(join(root, "done.txt"), "utf8"), "landed\n");
    const settled = controller.inspect(started.executionId);
    assert.equal(settled.activeCount, 0);
    assert.equal(settled.tasks[0]?.executorSelection && JSON.stringify(settled.tasks[0]!.executorSelection), JSON.stringify({ source: "external", id: "fake" }));
  } finally {
    // Release any still-held executor so failure cleanup cannot hang behind it;
    // shutdown's abort (and process-tree termination) is the backstop.
    await writeFile(join(root, "release.txt"), "released\n", "utf8").catch(() => undefined);
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("watch checkpoint delivery options come from the shared notification policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-watch-delivery-"));
  try {
    await initGitRepo(root);
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>setTimeout(()=>{",
      "if(prompt.includes('WATCH_SENTINEL'))fs.writeFileSync('watched.txt','watched landed\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "},400));",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "fake": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" as const }
        }
      },
      execution: {
maxWorkers: 2,
workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 2 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    const contents: string[] = [];
    const deliveries: Array<{ deliverAs: string; triggerTurn: boolean } | undefined> = [];
    const controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }, options?: { deliverAs: "steer" | "followUp"; triggerTurn: boolean }) => {
        contents.push(message.content);
        deliveries.push(options);
      } },
      config,
      state: createState(),
      cwd: () => root,
    });
    const started = await controller.start([
      { title: "watched", instructions: "WATCH_SENTINEL", acceptanceCriteria: ["watched.txt exists"] },
    ]);
    controller.watch(started.executionId, 25);
    await waitFor(() => contents.some((content) => content.startsWith("[pi-review-subtask-watch]")));
    const watchIndex = contents.findIndex((content) => content.startsWith("[pi-review-subtask-watch]"));
    assert.deepEqual(deliveries[watchIndex], { deliverAs: "followUp", triggerTurn: true },
      "watch checkpoints follow up with a turn and never steer, matching watchCheckpointDelivery()");
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active widget and watch labels follow the failover successor during execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-failover-labels-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    // Deterministic fake executor: waits for stdin end, records the invocation
    // (turn/operation/session), optionally fails mapped turns, and writes
    // worker-output.txt only on mapped turns.
    const fakeSource = (capture: string, failTurns: number[], contents: Record<string, string>) => [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN||'1');",
      "const sessionId=process.env.PI_REVIEW_EXECUTOR_SESSION_ID;",
      `fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({turn,operation:process.env.PI_REVIEW_EXECUTOR_OPERATION,sessionId})+'\\n');`,
      `if(${JSON.stringify(failTurns)}.includes(turn)){console.log(JSON.stringify({type:'session',sessionId}));process.exit(3);}`,
      `const content=${JSON.stringify(contents)}[String(turn)];`,
      "if(content!==undefined)fs.writeFileSync('worker-output.txt',content);",
      "console.log(JSON.stringify({type:'session',sessionId}));",
      "console.log(JSON.stringify({type:'assistant',text:'turn complete'}));",
      "});",
    ].join("\n");

    const captureA = join(root, "invocations-a.jsonl");
    const captureB = join(root, "invocations-b.jsonl");
    const execA = join(root, "exec-a.cjs");
    const execB = join(root, "exec-b.cjs");
    await writeFile(execA, fakeSource(captureA, [2], { 1: "v1\n" }), "utf8");
    await writeFile(execB, fakeSource(captureB, [], { 3: "v2\n" }), "utf8");
    await chmod(execA, 0o755);
    await chmod(execB, 0o755);

    // Stateful reviewer: the first review is needs_changes (forcing a
    // correction turn that fails on res-a and triggers failover); the second
    // passes.
    const reviewerState = join(root, "reviewer-count");
    const reviewer = join(root, "reviewer.cjs");
    await writeFile(reviewer, [
      "#!/usr/bin/env node",
      `const fs=require('node:fs');const state=${JSON.stringify(reviewerState)};`,
      "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "let count=0;try{count=Number(fs.readFileSync(state,'utf8'))||0;}catch{}count+=1;fs.writeFileSync(state,String(count));",
      "const verdict=count<2?'needs_changes':'pass';",
      "console.log(JSON.stringify({verdict,summary:verdict==='pass'?'ok':'fix it',findings:[]}));",
      "});",
    ].join("\n"), "utf8");
    await chmod(reviewer, 0o755);

    const config = normalizeConfig({
enabled: true,
externalAgents: {
  "exec-a": {
    adapter: "run-as-binary", command: process.execPath, model: "model-a", execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [execA], timeoutMs: 30000 }
  },
  "exec-b": {
    adapter: "run-as-binary", command: process.execPath, model: "agent-b-default", execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [execB], timeoutMs: 30000, model: "exec-b-effective" }
  },
  "gate-reviewer": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [reviewer],
      timeoutMs: 20000,
    }
  }
},
execution: {
        workerResources: {
          "res-a": {
            selection: { source: "external" as const, id: "exec-a" }, maxConcurrent: 1
          },
          "res-b": {
            selection: { source: "external" as const, id: "exec-b" }, maxConcurrent: 1
          }
        },
        routes: { execute: [{ resourceId: "res-a" }, { resourceId: "res-b" }], research: [] },
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
      },
retainBundles: "always",
review: { activeReviewers: [
        { source: "external", id: "gate-reviewer" }
      ] },
    });

    const widgetFrames: string[][] = [];
    const contents: string[] = [];
    const widgetCtx = { ui: { setWidget: (_name: string, content: unknown) => {
      const component = content as (() => { render(width: number): string[]; invalidate(): void }) | undefined;
      if (typeof component === "function") widgetFrames.push(component().render(400));
    } } };
    controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => { contents.push(message.content); } },
      config,
      state: createState(),
      cwd: () => root,
    });
    controller.setUiContext(widgetCtx);
    await controller.toggleExpandedView(widgetCtx);

    const started = await controller.start([
      { title: "failover-task", instructions: "make the change", acceptanceCriteria: ["done"] },
    ]);

    // One-shot watch checkpoints: arm the first, then re-arm after each
    // delivery so the sequence spans the whole run, including the
    // post-failover turns. The loop also doubles as the wait for settlement.
    try {
      controller.watch(started.executionId, 100);
    } catch {
      // Already settled before the first arm could be placed.
    }
    let lastDelivered = 0;
    for (let guard = 0; guard < 240; guard++) {
      const delivered = contents.filter((content) => content.startsWith("[pi-review-subtask-watch]")).length;
      if (delivered > lastDelivered) {
        lastDelivered = delivered;
        const inspection = controller.inspect(started.executionId);
        if (!inspection.tasks.some((task) => isActiveTaskState(task.state))) break;
        try {
          controller.watch(started.executionId, 100);
        } catch {
          // The task settled between the check and the arm: nothing left to watch.
          break;
        }
      }
      const settled = controller.inspect(started.executionId).tasks.every((task) => task.state === "landed");
      if (settled) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    await waitFor(() => controller!.inspect(started.executionId).tasks.every((task) => task.state === "landed"), 60_000);

    // The failover really happened: res-a served turn 1, failed on the
    // correction turn, and res-b served the successor turns.
    const invocationsA = (await readFile(captureA, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const invocationsB = (await readFile(captureB, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(invocationsA.map((item: { turn: number }) => item.turn), [1, 2]);
    assert.ok(invocationsB.length >= 1 && invocationsB[0]!.turn >= 3);

    // While the task was still active, the expanded widget frames must show
    // the successor's effective model — the execution-level override, not the
    // agent default — and never keep labeling it with the original executor
    // after the successor first appears.
    const activeLines = widgetFrames
      .map((frame) => frame.find((line) => /failover-task \[(running|correcting|reviewing)\]/.test(line)) ?? "")
      .filter(Boolean);
    assert.ok(activeLines.length > 0, `expected active widget frames: ${JSON.stringify(widgetFrames.slice(0, 4))}`);
    const successorLines = activeLines.filter((line) => line.includes("exec-b-effective"));
    assert.ok(successorLines.length > 0,
      `no active widget frame showed the failover successor's effective model: ${JSON.stringify(activeLines)}`);
    const firstSuccessor = activeLines.indexOf(successorLines[0]!);
    assert.ok(
      activeLines.slice(firstSuccessor).every((line) => !/model-a/.test(line)),
      `an active frame after failover still showed the original executor: ${JSON.stringify(activeLines)}`,
    );

    // The watch checkpoints render the same live identity from the task
    // record: some checkpoint shows the successor while active, and nothing
    // after that relabels the task with the original executor.
    const checkpoints = contents.filter((content) => content.startsWith("[pi-review-subtask-watch]"));
    assert.ok(checkpoints.length > 0, "expected at least one delivered watch checkpoint");
    const successorCheckpoints = checkpoints.filter((content) => /failover-task · (running|correcting|reviewing) · exec-b-effective/.test(content));
    assert.ok(successorCheckpoints.length > 0,
      `no watch checkpoint showed the successor's effective model while active: ${JSON.stringify(checkpoints)}`);
    const firstSuccessorCheckpoint = checkpoints.indexOf(successorCheckpoints[0]!);
    assert.ok(
      checkpoints.slice(firstSuccessorCheckpoint).every((content) => !/failover-task · (running|correcting|reviewing) · model-a/.test(content)),
      `a watch checkpoint after failover still showed the original executor: ${JSON.stringify(checkpoints)}`,
    );
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("failover to a model-less external executor clears the predecessor's model label", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-modelless-failover-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const fakeSource = (capture: string, failTurns: number[], contents: Record<string, string>) => [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN||'1');",
      "const sessionId=process.env.PI_REVIEW_EXECUTOR_SESSION_ID;",
      `fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({turn,operation:process.env.PI_REVIEW_EXECUTOR_OPERATION,sessionId})+'\\n');`,
      `if(${JSON.stringify(failTurns)}.includes(turn)){console.log(JSON.stringify({type:'session',sessionId}));process.exit(3);}`,
      `const content=${JSON.stringify(contents)}[String(turn)];`,
      "if(content!==undefined)fs.writeFileSync('worker-output.txt',content);",
      "console.log(JSON.stringify({type:'session',sessionId}));",
      "console.log(JSON.stringify({type:'assistant',text:'turn complete'}));",
      "});",
    ].join("\n");

    const captureA = join(root, "invocations-a.jsonl");
    const captureB = join(root, "invocations-b.jsonl");
    const execA = join(root, "exec-a.cjs");
    const execB = join(root, "exec-b.cjs");
    await writeFile(execA, fakeSource(captureA, [2], { 1: "v1\n" }), "utf8");
    await writeFile(execB, fakeSource(captureB, [], { 3: "v2\n" }), "utf8");
    await chmod(execA, 0o755);
    await chmod(execB, 0o755);

    const reviewerState = join(root, "reviewer-count");
    const reviewer = join(root, "reviewer.cjs");
    await writeFile(reviewer, [
      "#!/usr/bin/env node",
      `const fs=require('node:fs');const state=${JSON.stringify(reviewerState)};`,
      "let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "let count=0;try{count=Number(fs.readFileSync(state,'utf8'))||0;}catch{}count+=1;fs.writeFileSync(state,String(count));",
      "const verdict=count<2?'needs_changes':'pass';",
      "console.log(JSON.stringify({verdict,summary:verdict==='pass'?'ok':'fix it',findings:[]}));",
      "});",
    ].join("\n"), "utf8");
    await chmod(reviewer, 0o755);

    // res-a is a named model; res-b has no configured model at all (external
    // models are optional). After failover the task must stop displaying
    // model-a and fall back to the successor's own identity.
    const config = normalizeConfig({
enabled: true,
externalAgents: {
  "exec-a": {
    adapter: "run-as-binary", command: process.execPath, model: "model-a", execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [execA], timeoutMs: 30000 }
  },
  "exec-b": {
    adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [execB], timeoutMs: 30000 }
  },
  "gate-reviewer": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [reviewer],
      timeoutMs: 20000,
    }
  }
},
execution: {
        workerResources: {
          "res-a": {
            selection: { source: "external" as const, id: "exec-a" }, maxConcurrent: 1
          },
          "res-b": {
            selection: { source: "external" as const, id: "exec-b" }, maxConcurrent: 1
          }
        },
        routes: { execute: [{ resourceId: "res-a" }, { resourceId: "res-b" }], research: [] },
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 1 },
      },
retainBundles: "always",
review: { activeReviewers: [
        { source: "external", id: "gate-reviewer" }
      ] },
    });

    const widgetFrames: string[][] = [];
    const contents: string[] = [];
    const widgetCtx = { ui: { setWidget: (_name: string, content: unknown) => {
      const component = content as (() => { render(width: number): string[]; invalidate(): void }) | undefined;
      if (typeof component === "function") widgetFrames.push(component().render(400));
    } } };
    controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => { contents.push(message.content); } },
      config,
      state: createState(),
      cwd: () => root,
    });
    controller.setUiContext(widgetCtx);
    await controller.toggleExpandedView(widgetCtx);

    const started = await controller.start([
      { title: "modelless-task", instructions: "make the change", acceptanceCriteria: ["done"] },
    ]);

    try {
      controller.watch(started.executionId, 100);
    } catch {
      // Already settled before the first arm could be placed.
    }
    let lastDelivered = 0;
    for (let guard = 0; guard < 240; guard++) {
      const delivered = contents.filter((content) => content.startsWith("[pi-review-subtask-watch]")).length;
      if (delivered > lastDelivered) {
        lastDelivered = delivered;
        const inspection = controller.inspect(started.executionId);
        if (!inspection.tasks.some((task) => isActiveTaskState(task.state))) break;
        try {
          controller.watch(started.executionId, 100);
        } catch {
          break;
        }
      }
      const settled = controller.inspect(started.executionId).tasks.every((task) => task.state === "landed");
      if (settled) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    await waitFor(() => controller!.inspect(started.executionId).tasks.every((task) => task.state === "landed"), 60_000);

    // The failover really happened.
    const invocationsA = (await readFile(captureA, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const invocationsB = (await readFile(captureB, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(invocationsA.map((item: { turn: number }) => item.turn), [1, 2]);
    assert.ok(invocationsB.length >= 1 && invocationsB[0]!.turn >= 3);

    // While active before failover the task showed its named model...
    const activeLines = widgetFrames
      .map((frame) => frame.find((line) => /modelless-task \[(running|correcting|reviewing)\]/.test(line)) ?? "")
      .filter(Boolean);
    assert.ok(activeLines.some((line) => /· model-a/.test(line)),
      `expected an active frame showing the original named model: ${JSON.stringify(activeLines)}`);
    // ...and once the model-less successor's executing progress arrives, no
    // active frame may keep displaying the predecessor's model; the label
    // falls back to the successor's own identity (its agent id).
    const successorLines = activeLines.filter((line) => /modelless-task \[(running|correcting|reviewing)\] · exec-b\b/.test(line));
    assert.ok(successorLines.length > 0,
      `no active frame showed the model-less successor's own identity: ${JSON.stringify(activeLines)}`);
    const firstSuccessor = activeLines.indexOf(successorLines[0]!);
    assert.ok(
      activeLines.slice(firstSuccessor).every((line) => !/· model-a/.test(line)),
      `an active frame after failover still showed the predecessor's model: ${JSON.stringify(activeLines)}`,
    );

    // Same guarantee for the watch checkpoints.
    const checkpoints = contents.filter((content) => content.startsWith("[pi-review-subtask-watch]"));
    assert.ok(checkpoints.length > 0, "expected at least one delivered watch checkpoint");
    const successorCheckpoints = checkpoints.filter((content) => /modelless-task · (running|correcting|reviewing) · exec-b\b/.test(content));
    assert.ok(successorCheckpoints.length > 0,
      `no watch checkpoint showed the model-less successor's own identity: ${JSON.stringify(checkpoints)}`);
    const firstSuccessorCheckpoint = checkpoints.indexOf(successorCheckpoints[0]!);
    assert.ok(
      checkpoints.slice(firstSuccessorCheckpoint).every((content) => !/modelless-task · (running|correcting|reviewing) · model-a/.test(content)),
      `a watch checkpoint after failover still showed the predecessor's model: ${JSON.stringify(checkpoints)}`,
    );
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
