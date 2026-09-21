import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BackgroundExecutionController,
  MAX_UNSETTLED_TASKS_PER_EXECUTION,
} from "../src/execution/background-controller";
import type { BackgroundExecutionGroup, BackgroundStateTransition, BackgroundTaskRecord } from "../src/execution/background-controller";
import { normalizeConfig } from "../src/config";
import { compareSnapshots, createWorkspaceSnapshot } from "../src/capture";
import { activeExchangeBaseline, beginAgentRun, rememberUserRequest, setReviewWindowBaseline, createState } from "../src/state";
import { transitionTaskState } from "../src/execution/task-state";
import {
  awaitBounded,
  boundedScalingConfig,
  controllerInternals,
  initGitRepo,
  settleOldestUnsettled,
  setupFaultScenario,
  waitFor,
} from "./helpers/background-controller-fixtures";


test("background tasks return immediately, land independently, and additions capture prior landings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-controller-"));
  const executor = join(root, "executor.cjs");
  const releaseGate = join(root, "release-gate");
  let controller: BackgroundExecutionController | undefined;
  let restored: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const finish=()=>{",
      "if(prompt.includes('FIRST_SENTINEL'))fs.writeFileSync('first.txt','first landed\\n');",
      "if(prompt.includes('PEER_SENTINEL'))fs.writeFileSync('peer.txt','peer landed\\n');",
      "if(prompt.includes('SECOND_SENTINEL'))fs.writeFileSync('second.txt',fs.existsSync('first.txt')?'saw first\\n':'missed first\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "};",
      "const gate=process.env.PI_REVIEW_EXECUTOR_TEST_GATE+(prompt.includes('PEER_SENTINEL')?'-peer':'');",
      "const poll=setInterval(()=>{if(gate&&fs.existsSync(gate)){clearInterval(poll);finish();}},10);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "fake": {
          adapter: "run-as-binary",
          command: executor,
          env: { PI_REVIEW_EXECUTOR_TEST_GATE: releaseGate },
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 2,
workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 2 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
      retainBundles: "always",
    });
    const messages: string[] = [];
    controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config,
      state: createState(),
      cwd: () => root,
    });

    // Deterministic nonblocking proof (#128): the fake executors hold every
    // turn's completion behind the release gate, so a controller.start that
    // waited for worker completion would never resolve and must trip the
    // finite deadline below instead of racing a host-speed threshold.
    const first = await awaitBounded(
      controller.start([
        {
          title: "first",
          instructions: "FIRST_SENTINEL",
          acceptanceCriteria: ["first.txt exists"],
        },
        {
          title: "peer",
          instructions: "PEER_SENTINEL",
          acceptanceCriteria: ["peer.txt exists"],
        },
      ]),
      10_000,
      "controller.start did not return while fake executor completion was still blocked behind the release gate",
    );
    assert.equal(first.activeCount, 2);
    assert.equal(first.tasks.length, 2);
    assert.equal(first.scheduling.dispatchPending, 0);
    assert.equal(first.scheduling.dispatchAssigned, 2);
    assert.equal(first.scheduling.configuredWorkerLimit, 2);
    assert.equal(first.scheduling.configuredPoolCapacity, 2);
    assert.equal(first.scheduling.estimatedImmediatelyAvailableSlots, 0);
    // The gate is still closed: both dispatched workers are running but
    // provably not completed, so start genuinely returned before completion.
    await waitFor(() => controller!.inspect(first.executionId).tasks.every((task) => task.state === "running"));
    assert.ok(
      controller.inspect(first.executionId).tasks.every((task) => task.state === "running"),
      "gated workers remain running before the release gate is written",
    );
    await assert.rejects(readFile(join(root, "first.txt"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(root, "peer.txt"), "utf8"), /ENOENT/);
    await writeFile(releaseGate, "release\n", "utf8");
    // Keep the peer running until the first landing reports exactly one free
    // slot; simultaneous worker completion need not produce that snapshot.
    await waitFor(() => messages.some((message) => /Top-off opportunity: up to 1 additional task\(s\) may be submitted with SubtasksAdd/.test(message)));
    await writeFile(`${releaseGate}-peer`, "release\n", "utf8");
    await waitFor(() => controller!.inspect(first.executionId).tasks.every((task) => task.state === "landed"));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first landed\n");
    assert.equal(await readFile(join(root, "peer.txt"), "utf8"), "peer landed\n");
    await waitFor(() => messages.some((message) => /Landed paths: first\.txt/.test(message)));
    assert.ok(messages.every((message) => !/CAPTURING -> RUNNING.*task is ACTIVE/s.test(message)));
    assert.ok(messages.some((message) => /landed independently/.test(message)), "quiet mode still reports each task landing");
    assert.ok(messages.every((message) => !/Execution revision: \d+/.test(message)));
    assert.ok(messages.every((message) => !/Task timing \(ms\):/.test(message)));
    assert.ok(messages.every((message) => !/Post-settlement scheduler:/.test(message)));
    await waitFor(() => messages.some((message) => /Top-off opportunity: up to 1 additional task\(s\) may be submitted with SubtasksAdd/.test(message)));

    config.execution!.subtaskNotifications = "noisy";
    const toppedOff = await controller.add(first.executionId, [{
      title: "second",
      instructions: "SECOND_SENTINEL",
      acceptanceCriteria: ["second.txt records the prior landing"],
    }]);
    assert.equal(toppedOff.tasks.length, 3);
    assert.notEqual(toppedOff.tasks[0]?.taskId, toppedOff.tasks[2]?.taskId);
    await waitFor(() => controller!.inspect(first.executionId).tasks.every((task) => task.state === "landed"));
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "saw first\n");
    assert.ok(messages.some((message) => message.includes(toppedOff.tasks[2]!.taskId) && /task is ACTIVE/s.test(message)));
    assert.ok(messages.some((message) => /landed independently/.test(message)));
    await waitFor(() => messages.some((message) => /Top-off opportunity: up to 2 additional task\(s\) may be submitted with SubtasksAdd/.test(message)));
    assert.equal(controller.inspect(first.executionId).activeCount, 0);
    const completedInspection = controller.inspect(first.executionId);
    assert.equal(completedInspection.peakConcurrency, 2);
    assert.ok(completedInspection.tasks.every((task) => task.timing.totalMs > 0));
    assert.ok(completedInspection.tasks.every((task) => (task.stateHistory?.length ?? 0) >= 3));
    assert.ok(messages.every((message) => !/Execution timing \(ms\):/.test(message)));
    const associations = controller.associations();
    await controller.shutdown();
    await controller.detach();
    restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    const restoredAssociations = restored.associations();
    assert.deepEqual(restoredAssociations.waveRoots, []);
    assert.deepEqual(restoredAssociations.bundles, []);
    assert.deepEqual(restoredAssociations.groupRoots, []);
    assert.throws(() => restored!.inspect(first.executionId), /Unknown execution group/);
    await restored.shutdown();
  } finally {
    // Failure-safe teardown: release the gate so gated fake executors settle
    // instead of being killed mid-turn, shut every controller down, and only
    // then remove the temporary tree.
    await writeFile(releaseGate, "release\n", "utf8").catch(() => undefined);
    await writeFile(`${releaseGate}-peer`, "release\n", "utf8").catch(() => undefined);
    await controller?.shutdown().catch(() => undefined);
    await restored?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel independent landings accumulate in the parent review checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-checkpoint-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const executor = join(root, "checkpoint-executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const task=prompt.includes('FIRST_CHECKPOINT')?['first.txt',100]:prompt.includes('SECOND_CHECKPOINT')?['second.txt',200]:['third.txt',350];",
      "setTimeout(()=>{fs.writeFileSync(task[0],task[0]+' landed\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));},task[1]);",
      "});",
    ].join("\n"), "utf8");

    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "checkpoint": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] }
        }
      },
      execution: {
maxWorkers: 3,
workerResources: { "default": { selection: { source: "external", id: "checkpoint" }, maxConcurrent: 3 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    const state = createState();
    rememberUserRequest(state, "create three files with parallel subtasks and one parent file");
    beginAgentRun(state);
    const originalBaseline = await createWorkspaceSnapshot(root, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
    });
    setReviewWindowBaseline(state, originalBaseline);
    await writeFile(join(root, "parent.txt"), "parent-authored\n", "utf8");

    controller = new BackgroundExecutionController({ config, state, cwd: () => root, pi: {} });
    const started = await controller.start([
      { title: "first", instructions: "FIRST_CHECKPOINT", acceptanceCriteria: ["first.txt exists"] },
      { title: "second", instructions: "SECOND_CHECKPOINT", acceptanceCriteria: ["second.txt exists"] },
      { title: "third", instructions: "THIRD_CHECKPOINT", acceptanceCriteria: ["third.txt exists"] },
    ]);
    await waitFor(() => controller!.inspect(started.executionId).tasks.every((task) => task.state === "landed"), 30_000);

    const checkpoint = activeExchangeBaseline(state);
    assert.ok(checkpoint);
    const current = await createWorkspaceSnapshot(root, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
      reuseUnchangedFrom: checkpoint,
    });
    assert.deepEqual(compareSnapshots(checkpoint, current).map((change) => change.path), ["parent.txt"]);
    const owned = controller.associations();
    assert.equal(owned.groupRoots?.length, 1);
    assert.equal(owned.waveRoots.length, 3);
    await controller.shutdown();
    await controller.cleanupSettledArtifacts();
    assert.deepEqual(controller.associations().groupRoots, []);
    assert.deepEqual(controller.associations().waveRoots, []);
    for (const path of [...(owned.groupRoots ?? []), ...owned.waveRoots]) {
      await assert.rejects(access(path), /ENOENT/);
    }
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("research tasks report without review or landing and quarantine accidental writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-research-"));
  const controllers: BackgroundExecutionController[] = [];
  try {
    await initGitRepo(root, { "base.txt": "base\n", ".gitignore": "ignored-research.txt\n" });
    const executor = join(root, "research-codex.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs'),readline=require('node:readline');let threadId='thread-'+process.pid,turn=0;",
      "const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);",
      "if(request.method==='initialize')return send({jsonrpc:'2.0',id:request.id,result:{userAgent:'test-codex'}});",
      "if(request.method==='initialized')return;",
      "if(request.method==='thread/start'||request.method==='thread/resume'){threadId=request.params.threadId||threadId;return send({jsonrpc:'2.0',id:request.id,result:{thread:{id:threadId}}});}",
      "if(request.method==='turn/start'){const prompt=request.params.input?.[0]?.text||'';if(prompt.includes('DIRTY_RESEARCH'))fs.writeFileSync('ignored-research.txt','must not land\\n');",
      "const turnId='turn-'+(++turn),text=prompt.includes('LONG_RESEARCH')?'Summary: The captured baseline was found.\\n\\n## Details\\n'+('LONG_DETAIL '.repeat(120)):'Evidence-backed finding: base.txt contains the captured baseline.';send({jsonrpc:'2.0',id:request.id,result:{turn:{id:turnId}}});",
      "setImmediate(()=>{send({jsonrpc:'2.0',method:'item/completed',params:{item:{type:'agentMessage',text}}});send({jsonrpc:'2.0',method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{type:'agentMessage',text}]}}});});return;}",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "researcher": {
          adapter: "codex-cli",
          command: executor,
          execution: {}
        }
      },
      execution: {
        workerResources: {
          "researcher": {
            selection: { source: "external", id: "researcher" },
            maxConcurrent: 2
          }
        },
        routes: {
          execute: [],
          research: [{ resourceId: "researcher" }],
        },
        maxWorkers: 2,
      },
      retainBundles: "always",
    });
    const messages: string[] = [];
    const controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config,
      state: createState(),
      cwd: () => root,
    });

    controllers.push(controller);
    const started = await controller.start([
      {
        title: "clean research",
        instructions: "Inspect base.txt and report evidence.",
        acceptanceCriteria: ["Return an evidence-backed report"],
        executorToolCatalog: {
          allowedToolCatalog: ["read"],
          initialActiveTools: ["read"],
        },
      },
      {
        title: "dirty research",
        instructions: "DIRTY_RESEARCH",
        acceptanceCriteria: ["Return an evidence-backed report"],
        executorToolCatalog: {
          allowedToolCatalog: ["read"],
          initialActiveTools: ["read"],
        },
      },
      {
        title: "long research",
        instructions: "LONG_RESEARCH",
        acceptanceCriteria: ["Return a detailed report with a bounded summary"],
        executorToolCatalog: {
          allowedToolCatalog: ["read"],
          initialActiveTools: ["read"],
        },
      },
    ], "research");
    assert.equal(started.kind, "research");
    await waitFor(() => controller.inspect(started.executionId).activeCount === 0);
    const finished = controller.inspect(started.executionId);
    const clean = finished.tasks.find((task) => task.definition.title === "clean research")!;
    const dirty = finished.tasks.find((task) => task.definition.title === "dirty research")!;
    const long = finished.tasks.find((task) => task.definition.title === "long research")!;
    assert.equal(clean.state, "reported");
    assert.match(clean.report ?? "", /Evidence-backed finding/);
    const reportArtifact = await readFile(clean.reportPath!, "utf8");
    assert.match(reportArtifact, new RegExp(`Captured source commit: [0-9a-f]{40}`));
    assert.match(reportArtifact, /Workspace disposition: unchanged/);
    assert.match(reportArtifact, /Evidence-backed finding/);
    assert.equal(dirty.state, "failed");
    assert.match(dirty.error ?? "", /read-only contract/);
    await assert.rejects(readFile(join(root, "ignored-research.txt"), "utf8"), /ENOENT/);
    await waitFor(() => messages.some((message) => /completed without workspace changes/.test(message)));
    const cleanMessage = messages.find((message) => message.startsWith(`Research task ${clean.taskId} completed without workspace changes.`))!;
    assert.match(cleanMessage, /Complete report:\nEvidence-backed finding/);
    await waitFor(() => messages.some((message) => message.startsWith(`Research task ${long.taskId} completed without workspace changes.`)));
    const longMessage = messages.find((message) => message.startsWith(`Research task ${long.taskId} completed without workspace changes.`))!;
    assert.match(longMessage, /Full report: .*research-report\.md/);
    assert.match(longMessage, /too long to inline completely; no partial report excerpt is included/);
    assert.match(longMessage, /Summary: The captured baseline was found\./);
    assert.doesNotMatch(longMessage, /LONG_DETAIL/);
    await waitFor(() => messages.some((message) => /private changes were quarantined and main is unchanged/.test(message)));
    await assert.rejects(controller.forceMerge({
      executionId: started.executionId,
      taskId: dirty.taskId,
      mergeAnyhow: false,
      instructionId: "research-force-merge",
      actor: "model",
    }), /Research tasks have reports, not mergeable checkpoints/);

    // Research has a retained operation/capture, not an execute-wave manifest.
    // Its own returned bundle must still support explicit continuation.
    await waitFor(() => (controller as unknown as { runtimes: Map<string, unknown> }).runtimes.size === 0);
    await assert.rejects(access(join(clean.waveRoot!, "wave-manifest.json")), /ENOENT/);
    const continueResearch = (bundle = clean.bundle!) => controller.continueTask({
      executionId: started.executionId, taskId: clean.taskId, bundle,
      instructions: "Confirm the evidence in base.txt without modifying any files.",
      instructionId: "explicit-research-continuation", actor: "user",
    });
    await assert.rejects(continueResearch(dirty.bundle!), /ownership/);
    await assert.rejects(continueResearch({ ...clean.bundle!, waveRoot: dirty.waveRoot! }), /ownership/);
    await assert.rejects(continueResearch({ ...clean.bundle!, expectedRevision: Number.MAX_SAFE_INTEGER }), /revision/);
    assert.equal(controller.inspect(started.executionId, clean.taskId).tasks[0]!.commands.length, 0);
    await continueResearch();
    await waitFor(() => {
      const task = controller.inspect(started.executionId, clean.taskId).tasks[0]!;
      return task.state === "reported" && task.generation > clean.generation;
    });
    const continuedResearch = controller.inspect(started.executionId, clean.taskId).tasks[0]!;
    assert.equal(continuedResearch.commands.find((command) => command.instructionId === "explicit-research-continuation")?.status, "acknowledged");
    assert.match(continuedResearch.report!, /Evidence-backed finding/);
    assert.equal(controller.inspect(started.executionId).historicalCount, 3);
    assert.equal(await readFile(join(root, "base.txt"), "utf8"), "base\n");
    await assert.rejects(access(join(clean.waveRoot!, "wave-manifest.json")), /ENOENT/);

    const associations = controller.associations();
    await controller.shutdown();
    await controller.detach();
    const restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    assert.equal(restored.inspect(started.executionId).kind, "research");
    assert.equal(restored.inspect(started.executionId).tasks.find((task) => task.taskId === clean.taskId)?.state, "reported");
    await restored.shutdown();
  } finally {
    for (const controller of controllers) await controller.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("launch rejection never regresses a terminal state even with a pending interruption mode", async () => {
  const scenario = await setupFaultScenario({});
  const { controller, started, messages } = scenario;
  try {
    await waitFor(() => controller.inspect(started.executionId).tasks[0]?.state === "landed");
    const internals = controller as unknown as {
      groups: Map<string, BackgroundExecutionGroup>;
      handleLaunchRejection: (group: BackgroundExecutionGroup, task: BackgroundTaskRecord, error: unknown) => Promise<void>;
    };
    const group = internals.groups.get(started.executionId)!;
    const task = group.tasks[0]!;
    assert.equal(task.state, "landed");
    // Simulate interrupt() having set its mode while the launch promise is still
    // settling, followed by a post-terminal rejection reaching the launch catch.
    task.interruptionMode = "interrupt_as_failure";
    await internals.handleLaunchRejection(group, task, new Error("post-terminal bookkeeping rejection"));
    assert.equal(task.state, "landed", "a pending interruption mode must not regress a landed task");
    assert.ok((task.stateHistory ?? []).every((entry) => entry.state !== "interrupted" && entry.state !== "failed"));
    assert.ok(
      task.activity.some((event) => event.phase === "bookkeeping" && /already reached landed.*outcome is preserved.*post-terminal bookkeeping rejection/s.test(event.message)),
      "expected a bookkeeping activity entry preserving the landed outcome",
    );
    assert.ok(messages.some((message) => /already reached landed.*outcome is preserved/.test(message)));
    await controller.shutdown();
  } finally {
    await scenario.cleanup();
  }
});

test("unsettled task admission is capped per execution while sequential settled top-offs continue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-cap-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root, {});
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const cap = MAX_UNSETTLED_TASKS_PER_EXECUTION;
    const definitions = Array.from({ length: cap }, (_unused, index) => ({
      title: `task ${index}`,
      instructions: "bounded work",
      acceptanceCriteria: ["done"],
    }));
    const started = await controller.start(definitions);
    assert.equal(started.historicalCount, cap);
    assert.equal(started.tasks.length, cap);

    // Fail closed at the cap with a clear, actionable error and no partial state.
    await assert.rejects(
      () => controller!.add(started.executionId, [{ title: "over cap", instructions: "work", acceptanceCriteria: ["done"] }]),
      (error: Error) => /at most \d+ unsettled tasks are admitted per execution/.test(error.message)
        && error.message.includes(started.executionId),
    );
    assert.equal(controller.inspect(started.executionId).tasks.length, cap);
    await assert.rejects(
      () => controller!.start([{ title: "over cap start", instructions: "work", acceptanceCriteria: ["done"] }, ...definitions]),
      /At most \d+ unsettled tasks are admitted per execution/,
    );
    assert.throws(() => controller!.inspect("exec-never-created"), /Unknown execution group/);

    // Sequential top-offs after settlement remain supported without limit.
    const group = controllerInternals(controller).groups.get(started.executionId)!;
    const oldest = group.tasks[0]!;
    transitionTaskState(oldest, "landed");
    oldest.summary = "settled to free admission capacity";
    await controllerInternals(controller).save(group);
    const toppedOff = await controller.add(started.executionId, [{
      title: "after settle",
      instructions: "work",
      acceptanceCriteria: ["done"],
    }]);
    // The settled record stays inline within the bounded window; the admission
    // cap counts only the unsettled (128) tasks, all of which remain queued
    // for dispatch in this harness (maxWorkers 0).
    assert.equal(toppedOff.tasks.length, cap + 1);
    assert.equal(toppedOff.historicalCount, cap + 1);
    assert.equal(toppedOff.archivedCount, 0);
    assert.equal(controller.inspect(started.executionId).scheduling.globallyDispatchPending, cap);
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("archived-task reactivation and recovery adoption enforce the unsettled admission cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-cap-continue-"));
  let controller: BackgroundExecutionController | undefined;
  const ownedRoots = new Set<string>();
  try {
    await initGitRepo(root, {});
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const cap = MAX_UNSETTLED_TASKS_PER_EXECUTION;
    const started = await controller.start(Array.from({ length: cap }, (_unused, index) => ({
      title: `task ${index}`,
      instructions: "bounded work",
      acceptanceCriteria: ["done"],
    })));
    ownedRoots.add(started.root);
    const evictedTaskId = started.tasks[0]!.taskId;
    // Give the task a durable continuation bundle so it stays continuable
    // after eviction, exactly like a real landing.
    const waveRootDir = await realpath(await mkdtemp(join(tmpdir(), "wave-cap-continue-")));
    ownedRoots.add(waveRootDir);
    const internals = controllerInternals(controller);
    const firstGroup = internals.groups.get(started.executionId)!;
    const firstTask = firstGroup.tasks[0]!;
    firstTask.bundle = {
      version: 1,
      operationId: "op-cap-continue",
      waveId: "wave-cap-continue",
      taskId: firstTask.taskId,
      waveRoot: waveRootDir,
      expectedRevision: 1,
    };
    firstTask.waveRoot = waveRootDir;
    // 40 settlements: 8 evicted archives, 32 inline settled, 88 unsettled.
    for (let index = 0; index < 40; index += 1) {
      await settleOldestUnsettled(controller!, started.executionId, `settle ${index + 1}`);
    }
    // Fill the unsettled population to exactly the cap.
    await controller.add(started.executionId, Array.from({ length: 40 }, (_unused, index) => ({
      title: `top-off ${index + 1}`,
      instructions: "work",
      acceptanceCriteria: ["done"],
    })));
    assert.equal(controller.inspect(started.executionId).archivedCount, 8);

    // Reactivating an archived task is admission-capped like SubtasksAdd.
    await assert.rejects(
      () => controller!.continueTask({
        executionId: started.executionId,
        taskId: evictedTaskId,
        instructions: "resume",
        instructionId: "cap-probe",
        actor: "user",
      }),
      (error: Error) => /at most \d+ unsettled tasks are admitted per execution/.test(error.message)
        && error.message.includes(started.executionId),
    );
    // Settling one task frees exactly one slot: the same continuation succeeds.
    await settleOldestUnsettled(controller, started.executionId, "free one slot");
    const continued = await controller.continueTask({
      executionId: started.executionId,
      taskId: evictedTaskId,
      instructions: "resume",
      instructionId: "cap-probe-2",
      actor: "user",
    });
    assert.equal(continued.tasks[0]!.state, "queued");
    assert.equal(controller.inspect(started.executionId).archivedCount, 8);
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    for (const owned of ownedRoots) await rm(owned, { recursive: true, force: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("continuing an inline settled task is capped like archive reactivation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-cap-inline-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root, {});
    controller = new BackgroundExecutionController({ pi: {}, config: boundedScalingConfig(), state: createState(), cwd: () => root });
    const cap = MAX_UNSETTLED_TASKS_PER_EXECUTION;
    const started = await controller.start(Array.from({ length: cap }, (_unused, index) => ({
      title: `task ${index}`,
      instructions: "bounded work",
      acceptanceCriteria: ["done"],
    })));
    const internals = controllerInternals(controller);
    const group = internals.groups.get(started.executionId)!;
    // The NEWEST settled task stays inline (within the bounded window) — it is
    // the inline settled continuation case.
    const inlineSettled = group.tasks[32]!;
    inlineSettled.bundle = {
      version: 1,
      operationId: "op-inline-cap",
      waveId: "wave-inline-cap",
      taskId: inlineSettled.taskId,
      waveRoot: join(tmpdir(), "wave-inline-cap-unused"),
      expectedRevision: 1,
    };
    for (let index = 0; index < 33; index += 1) {
      await settleOldestUnsettled(controller, started.executionId, `settle ${index + 1}`);
    }
    // 32 inline settled, 1 archived, 95 unsettled: fill the cap exactly.
    await controller.add(started.executionId, Array.from({ length: 33 }, (_unused, index) => ({
      title: `top-off ${index + 1}`,
      instructions: "work",
      acceptanceCriteria: ["done"],
    })));
    assert.equal(controller.inspect(started.executionId).archivedCount, 1);

    // The settled INLINE task also re-enters the unsettled population when
    // continued: the shared admission cap refuses it at the cap.
    await assert.rejects(
      () => controller!.continueTask({
        executionId: started.executionId,
        taskId: inlineSettled.taskId,
        instructions: "resume",
        instructionId: "inline-cap-probe",
        actor: "user",
      }),
      (error: Error) => /at most \d+ unsettled tasks are admitted per execution/.test(error.message)
        && error.message.includes(started.executionId),
    );
    // Rejected continuation leaves inline state and aggregates untouched.
    const inspection = controller.inspect(started.executionId);
    assert.equal(inspection.archivedCount, 1);
    const stillInline = inspection.tasks.find((task) => task.taskId === inlineSettled.taskId);
    assert.equal(stillInline?.state, "landed");
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("BackgroundStateTransition remains exported from background-controller (compile-time probe)", () => {
  const transition: BackgroundStateTransition = {
    sequence: 1,
    state: "queued",
    at: "2024-01-01T00:00:00.000Z",
    generation: 0,
  };
  assert.equal(transition.state, "queued");
});
