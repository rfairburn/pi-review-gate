import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { createState } from "../src/state";

const execFileAsync = promisify(execFile);

test("background tasks return immediately, land independently, and additions capture prior landings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-controller-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>setTimeout(()=>{",
      "if(prompt.includes('FIRST_SENTINEL'))fs.writeFileSync('first.txt','first landed\\n');",
      "if(prompt.includes('PEER_SENTINEL'))fs.writeFileSync('peer.txt','peer landed\\n');",
      "if(prompt.includes('SECOND_SENTINEL'))fs.writeFileSync('second.txt',fs.existsSync('first.txt')?'saw first\\n':'missed first\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "},350));",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "fake",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: {
        activeExecutor: { source: "external", id: "fake" },
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

    const startedAt = Date.now();
    const first = await controller.start([
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
    ]);
    assert.ok(Date.now() - startedAt < 300, "start should return before the deliberately delayed worker");
    assert.equal(first.activeCount, 2);
    assert.equal(first.tasks.length, 2);
    assert.equal(first.scheduling.dispatchPending, 0);
    assert.equal(first.scheduling.dispatchAssigned, 2);
    assert.equal(first.scheduling.configuredWorkerLimit, 2);
    assert.equal(first.scheduling.configuredPoolCapacity, 2);
    assert.equal(first.scheduling.estimatedImmediatelyAvailableSlots, 0);
    await waitFor(() => controller.inspect(first.executionId).tasks.every((task) => task.state === "landed"));
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first landed\n");
    assert.equal(await readFile(join(root, "peer.txt"), "utf8"), "peer landed\n");
    await waitFor(() => messages.some((message) => /Landed paths: first\.txt/.test(message)));
    assert.ok(messages.every((message) => !/CAPTURING -> RUNNING.*task is ACTIVE/s.test(message)));
    assert.ok(messages.some((message) => /landed independently/.test(message)), "quiet mode still reports each task landing");
    assert.ok(messages.some((message) => /Execution revision: \d+/.test(message)));
    assert.ok(messages.some((message) => /Task timing \(ms\): total \d+; queued \d+; capture \d+; execution \d+; review \d+; landing \d+/.test(message)));
    assert.ok(messages.some((message) => /Top-off opportunity: up to 1 additional task\(s\) may be submitted with SubtasksAdd/.test(message)));

    config.execution!.subtaskNotifications = "noisy";
    const toppedOff = await controller.add(first.executionId, [{
      title: "second",
      instructions: "SECOND_SENTINEL",
      acceptanceCriteria: ["second.txt records the prior landing"],
    }]);
    assert.equal(toppedOff.tasks.length, 3);
    assert.notEqual(toppedOff.tasks[0]?.taskId, toppedOff.tasks[2]?.taskId);
    await waitFor(() => controller.inspect(first.executionId).tasks.every((task) => task.state === "landed"));
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "saw first\n");
    assert.ok(messages.some((message) => message.includes(toppedOff.tasks[2]!.taskId) && /task is ACTIVE/s.test(message)));
    assert.ok(messages.some((message) => /landed independently/.test(message)));
    await waitFor(() => messages.some((message) => /Top-off opportunity: up to 2 additional task\(s\) may be submitted with SubtasksAdd/.test(message)));
    assert.equal(controller.inspect(first.executionId).activeCount, 0);
    const completedInspection = controller.inspect(first.executionId);
    assert.equal(completedInspection.peakConcurrency, 2);
    assert.ok(completedInspection.tasks.every((task) => task.timing.totalMs > 0));
    assert.ok(completedInspection.tasks.every((task) => (task.stateHistory?.length ?? 0) >= 3));
    assert.ok(messages.some((message) => /Execution timing \(ms\): wall \d+; summed task time \d+; peak concurrency 2/.test(message)));
    const associations = controller.associations();
    await controller.shutdown();
    await controller.detach();
    const restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    const restoredInspection = restored.inspect(first.executionId);
    assert.equal(restoredInspection.tasks.filter((task) => task.state === "landed").length, 3);
    assert.equal(restoredInspection.peakConcurrency, 2);
    assert.ok(restoredInspection.tasks.every((task) => (task.stateHistory?.length ?? 0) >= 3));
    await restored.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("noisy subtask notifications wake the orchestrator when active execution enters review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-review-state-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "fs.writeFileSync('reviewed.txt','ready\\n');",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'review-state-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'done'}));",
    ].join("\n"), "utf8");
    const config = normalizeConfig({
      enabled: true,
      decider: {
        id: "passing",
        adapter: "generic-cli",
        command: process.execPath,
        args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'ok',findings:[]})),100))"],
        timeoutMs: 5_000,
      },
      externalAgents: [{
        id: "fake",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] },
      }],
      execution: {
        activeExecutor: { source: "external", id: "fake" },
        maxWorkers: 1,
        subtaskNotifications: "noisy",
      },
    });
    const messages: string[] = [];
    const widgets: unknown[] = [];
    controller = new BackgroundExecutionController({
      pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
      config,
      state: createState(),
      cwd: () => root,
    });
    await controller.toggleExpandedView({
      ui: { setWidget: (_key: string, content: unknown) => widgets.push(content) },
    });
    const started = await controller.start([{
      title: "review transition",
      instructions: "write reviewed.txt",
      acceptanceCriteria: ["reviewed.txt exists"],
    }]);
    await waitFor(() => controller!.inspect(started.executionId).tasks[0]?.state === "landed", 30_000);
    assert.ok(messages.some((message) => /CAPTURING -> RUNNING.*task is ACTIVE/s.test(message)));
    assert.ok(messages.some((message) => /(?:CAPTURING|RUNNING) -> REVIEWING.*task is REVIEWING/s.test(message)));
    assert.ok(messages.some((message) => /NO TOOL ACTION IS NECESSARY/.test(message)));
    assert.ok(messages.some((message) => new RegExp(`No action for ${started.tasks[0]!.taskId} at (?:RUNNING|REVIEWING)`).test(message)));
    assert.ok(messages.every((message) => !/-> (?:CAPTURING|ACCEPTED|WAITING_TO_LAND|LANDING)/.test(message)));
    assert.ok(messages.every((message) => !/interaction reported a failure/.test(message)));
    const inspection = controller.inspect(started.executionId);
    assert.deepEqual(inspection.tasks[0]?.reviewStatus?.reviewers, ["passing"]);
    assert.doesNotMatch(renderWidget(widgets.at(-1)).join("\n"), /reviewers passing \(accepted\)/, "inactive landed tasks leave the active summary");
    assert.ok(widgets.some((content) => /passing (?:started|finished)/.test(renderWidget(content).join("\n"))));
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("steering unsupported by a live turn is applied after it settles even when review is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-deferred-steer-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "deferred-steer.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "const turn=Number(process.env.PI_REVIEW_EXECUTOR_TURN||'1');",
      "process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('deferred.txt',turn===1?'true\\n':'false\\n');",
      "setTimeout(()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'deferred-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'turn '+turn+' complete'}));",
      "},500);",
      "});",
    ].join("\n"), "utf8");
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "deferred",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] },
      }],
      execution: { activeExecutor: { source: "external", id: "deferred" }, maxWorkers: 1 },
    });
    controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
    const started = await controller.start([{
      title: "deferred steering",
      instructions: "write true first",
      acceptanceCriteria: ["deferred.txt reflects the latest instruction"],
    }]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "running");
    const queued = await controller.steer({
      executionId: started.executionId,
      taskId,
      instructions: "write false instead",
      instructionId: "deferred-steer",
      actor: "model",
    });
    assert.equal(queued.tasks[0]?.commands.at(-1)?.status, "queued");
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    assert.equal(await readFile(join(root, "deferred.txt"), "utf8"), "false\n");
    assert.equal(controller.inspect(started.executionId, taskId).tasks[0]?.commands.at(-1)?.status, "acknowledged");
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("queued steering is incorporated before startup and landing events distinguish partial from complete execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-steering-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "steerable-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
      "process.stdin.on('end',()=>{",
      "const first=prompt.includes('FIRST_SENTINEL');",
      "if(first)fs.writeFileSync('first.txt','first\\n');",
      "else fs.writeFileSync('second.txt',prompt.includes('STEER_FALSE')?'false':'true');",
      "setTimeout(()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
      "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
      "},first?500:10);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: [{
        id: "steerable",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: {
        activeExecutor: { source: "external", id: "steerable" },
        maxWorkers: 1,
        subtaskNotifications: "noisy",
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
    const started = await controller.start([
      { title: "first task", instructions: "FIRST_SENTINEL", acceptanceCriteria: ["first.txt exists"] },
      { title: "second task", instructions: "SECOND_SENTINEL", acceptanceCriteria: ["second.txt is false"] },
    ]);
    const secondId = started.tasks[1]!.taskId;
    const steered = await controller.steer({
      executionId: started.executionId,
      taskId: secondId,
      instructions: "STEER_FALSE: write false instead of true",
      instructionId: "queued-steer",
      actor: "model",
    });
    assert.equal(steered.tasks[0]?.commands.at(-1)?.status, "queued");

    const probe = await controller.start([{
      title: "invalid probe",
      instructions: "SECOND_SENTINEL",
      acceptanceCriteria: ["probe is cancelled"],
    }]);
    const interrupted = await controller.interrupt({
      executionId: probe.executionId,
      mode: "interrupt_as_failure",
      instructionId: "cancel-single-task-execution",
      actor: "user",
    });
    assert.equal(interrupted.tasks[0]?.state, "interrupted");
    assert.match(interrupted.tasks[0]?.summary ?? "", /before executor startup/);

    await waitFor(() => controller!.inspect(started.executionId).tasks[0]?.state === "landed", 60_000);
    await waitFor(() => messages.some((message) => /partial task completion, not completion of the whole execution/.test(message)));
    assert.ok(messages.some((message) => message.includes(secondId) && /not landed/.test(message)));
    await waitFor(() => controller!.inspect(started.executionId).tasks.every((task) => task.state === "landed"), 60_000);
    await waitFor(() => messages.some((message) => /COMPLETE: 2\/2 tasks landed/.test(message)));
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "false");
    for (const task of started.tasks) {
      assert.ok(
        messages.some((message) => message.includes(task.taskId) && /CAPTURING -> RUNNING.*task is ACTIVE/s.test(message)),
        `${task.taskId} must independently notify when pool capacity lets it become active`,
      );
      assert.ok(
        messages.some((message) => message.includes(task.taskId) && /landed independently|continuation landed|force-merged and landed/.test(message)),
        `${task.taskId} must independently notify when landed`,
      );
    }
    assert.ok(messages.some((message) => /COMPLETE: 2\/2 tasks landed/.test(message)));
    assert.ok(messages.some((message) => /aggregate verification is now appropriate/.test(message)));
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupt quiesces a writer and force-merge lands its verified checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-interrupt-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const executor = join(root, "slow-executor.cjs");
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
      externalAgents: [{
        id: "slow",
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      }],
      execution: { activeExecutor: { source: "external", id: "slow" }, maxWorkers: 1 },
      retainBundles: "always",
    });
    const controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
    const started = await controller.start([{
      title: "recover interrupted edit",
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
    const interrupted = await controller.interrupt({
      executionId: started.executionId,
      taskId,
      mode: "interrupt_as_failure",
      instructionId: "interrupt-test",
      actor: "user",
    });
    assert.equal(interrupted.tasks[0]?.state, "interrupted");
    await assert.rejects(readFile(join(root, "draft.txt"), "utf8"));
    const landed = await controller.forceMerge({
      executionId: started.executionId,
      taskId,
      mergeAnyhow: false,
      instructionId: "force-test",
      actor: "user",
    });
    assert.equal(landed.tasks[0]?.state, "landed");
    assert.match(landed.tasks[0]?.summary ?? "", /manual workspace inspection is still required/i);
    assert.equal(await readFile(join(root, "draft.txt"), "utf8"), "recover me\n");
    await controller.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restored conflict gates keep injecting until mark-clean validates resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-conflict-"));
  try {
    const path = join(root, "conflicted.txt");
    await writeFile(path, "<<<<<<< current workspace\nours\n=======\ntheirs\n>>>>>>> subtask\n", "utf8");
    const controller = new BackgroundExecutionController({
      pi: {},
      config: normalizeConfig({ enabled: true, review: { activeReviewers: [] } }),
      state: createState(),
      cwd: () => root,
    });
    await controller.restore({
      waveRoots: [],
      bundles: [],
      conflictGate: {
        executionId: "exec-restored",
        taskId: "task-restored",
        sourceRoot: root,
        paths: ["conflicted.txt"],
        activatedAt: new Date().toISOString(),
        manifestPath: join(root, "conflict-manifest.json"),
        reason: "restored conflict",
      },
    });
    assert.match(controller.criticalPrompt() ?? "", /CRITICAL REVIEW-GATE WORKSPACE CONFLICT/);
    await assert.rejects(controller.markClean(), /Conflict markers remain/);
    assert.ok(controller.criticalPrompt());
    await writeFile(path, "resolved\n", "utf8");
    assert.deepEqual(await controller.markClean(), { cleared: true, paths: ["conflicted.txt"] });
    assert.equal(controller.criticalPrompt(), undefined);
    await controller.shutdown();
    await controller.detach();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for background task state");
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for asynchronous background task state");
}

function renderWidget(content: unknown, width = 240): string[] {
  assert.equal(typeof content, "function");
  const component = (content as () => { render(width: number): string[] })();
  return component.render(width);
}
