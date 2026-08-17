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
    const first = await controller.start([{
      title: "first",
      instructions: "FIRST_SENTINEL",
      acceptanceCriteria: ["first.txt exists"],
    }]);
    assert.ok(Date.now() - startedAt < 300, "start should return before the deliberately delayed worker");
    assert.equal(first.activeCount, 1);
    assert.equal(first.tasks.length, 1);
    await waitFor(() => controller.inspect(first.executionId).tasks[0]?.state === "landed");
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first landed\n");

    const toppedOff = await controller.add(first.executionId, [{
      title: "second",
      instructions: "SECOND_SENTINEL",
      acceptanceCriteria: ["second.txt records the prior landing"],
    }]);
    assert.equal(toppedOff.tasks.length, 2);
    assert.notEqual(toppedOff.tasks[0]?.taskId, toppedOff.tasks[1]?.taskId);
    await waitFor(() => controller.inspect(first.executionId).tasks.every((task) => task.state === "landed"));
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "saw first\n");
    assert.ok(messages.some((message) => /landed independently/.test(message)));
    assert.equal(controller.inspect(first.executionId).activeCount, 0);
    const associations = controller.associations();
    await controller.shutdown();
    await controller.detach();
    const restored = new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd: () => root });
    await restored.restore(associations);
    assert.equal(restored.inspect(first.executionId).tasks.filter((task) => task.state === "landed").length, 2);
    await restored.shutdown();
  } finally {
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
      execution: { activeExecutor: { source: "external", id: "steerable" }, maxWorkers: 1 },
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
    assert.ok(messages.some((message) => /partial task completion, not completion of the whole execution/.test(message)));
    assert.ok(messages.some((message) => message.includes(secondId) && /not landed/.test(message)));
    await waitFor(() => controller!.inspect(started.executionId).tasks.every((task) => task.state === "landed"), 60_000);
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "false");
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
