import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BackgroundExecutionController,
} from "../src/execution/background-controller";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
import type { ExecutorLiveControl } from "../src/execution/types";
import {
  initGitRepo,
  waitFor,
} from "./helpers/background-controller-fixtures";


test("steering unsupported by a live turn is applied after it settles even when review is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-deferred-steer-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
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
      externalAgents: {
        "deferred": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "deferred" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
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

test("interrupt steering fails with a concrete unsupported status when live control lacks turn interruption (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-steer-interrupt-unsupported-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const executor = join(root, "slow-executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('work.txt','done\\n');",
      "setTimeout(()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'slow-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'turn complete'}));",
      "},2000);",
      "});",
    ].join("\n"), "utf8");
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "slow": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "slow" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
    const started = await controller.start([{
      title: "interrupt steering unsupported",
      instructions: "write work",
      acceptanceCriteria: ["work.txt exists"],
    }]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "running");
    const runtime = (controller as unknown as { runtimes: Map<string, { control?: ExecutorLiveControl }> }).runtimes.get(taskId);
    assert.ok(runtime, "a dispatched task registers a runtime before live-control injection");
    const delivered: Array<{ interrupt?: boolean }> = [];
    runtime.control = {
      adapter: "test-binary",
      generation: 1,
      capabilities: { steer: true, interrupt: false },
      // A transport without turn-interrupt support reports it through a
      // concrete failed acknowledgement instead of a capability flag (#63).
      steer: async (_instruction, _instructionId, options) => {
        delivered.push(options ?? {});
        return { status: "failed" as const, message: "The active test-binary transport cannot interrupt an in-flight turn for steering." };
      },
      interrupt: async () => ({ status: "acknowledged" as const, message: "unused" }),
    };
    await assert.rejects(
      controller.steer({
        executionId: started.executionId,
        taskId,
        instructions: "interrupt steer",
        instructionId: "steer-unsupported",
        actor: "model",
        interrupt: true,
      }),
      /cannot interrupt an in-flight turn for steering/,
    );
    const task = controller.inspect(started.executionId, taskId).tasks[0]!;
    const command = task.commands.at(-1)!;
    assert.equal(command.status, "failed");
    // The canonical flag is preserved on the durable command record and the
    // failed acknowledgement is surfaced as the command error.
    assert.equal(command.interrupt, true);
    assert.match(command.error ?? "", /cannot interrupt an in-flight turn/);
    // The controller forwards the request; the adapter's acknowledgement is
    // the truthful capability signal.
    assert.deepEqual(delivered, [{ interrupt: true }]);
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupt steering flows through the canonical command record to acknowledged live delivery (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-steer-interrupt-flow-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
    const executor = join(root, "slow-executor.cjs");
    await writeFile(executor, [
      "const fs=require('node:fs');",
      "process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('work.txt','done\\n');",
      "setTimeout(()=>{",
      "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID||'slow-session'}));",
      "console.log(JSON.stringify({type:'assistant',text:'turn complete'}));",
      "},2000);",
      "});",
    ].join("\n"), "utf8");
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        "slow": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "slow" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
    const started = await controller.start([{
      title: "interrupt steering flow",
      instructions: "write work",
      acceptanceCriteria: ["work.txt exists"],
    }]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "running");
    const runtime = (controller as unknown as { runtimes: Map<string, { control?: ExecutorLiveControl }> }).runtimes.get(taskId);
    assert.ok(runtime, "a dispatched task registers a runtime before live-control injection");
    const delivered: Array<[string, string, { interrupt?: boolean } | undefined]> = [];
    runtime.control = {
      adapter: "test-binary",
      generation: 1,
      capabilities: { steer: true, interrupt: false },
      steer: async (instruction, instructionId, options) => {
        delivered.push([instruction, instructionId, options]);
        return { status: "acknowledged" as const, message: "steered" };
      },
      interrupt: async () => ({ status: "acknowledged" as const, message: "unused" }),
    };
    const inspection = await controller.steer({
      executionId: started.executionId,
      taskId,
      instructions: "interrupt steer",
      instructionId: "steer-supported",
      actor: "model",
      interrupt: true,
    });
    const command = inspection.tasks[0]?.commands.at(-1);
    assert.equal(command?.status, "acknowledged");
    // The canonical flag is preserved on the durable command record.
    assert.equal(command?.interrupt, true);
    assert.deepEqual(delivered, [["interrupt steer", "steer-supported", { interrupt: true }]]);
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    // The task completed its own turn normally: no cancellation or landing
    // was forced by the steering flag.
    assert.equal(await readFile(join(root, "work.txt"), "utf8"), "done\n");
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupt steering without a live control stays durably queued and applies at the next handoff (#63)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-background-steer-interrupt-queued-"));
  let controller: BackgroundExecutionController | undefined;
  try {
    await initGitRepo(root);
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
      externalAgents: {
        "deferred": {
          adapter: "run-as-binary",
          command: process.execPath,
          execution: { protocol: "pi-review-executor-jsonl-v1", args: [executor] }
        }
      },
      execution: {
maxWorkers: 1,
workerResources: { "default": { selection: { source: "external", id: "deferred" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [] },
      },
    });
    controller = new BackgroundExecutionController({ config, state: createState(), cwd: () => root, pi: {} });
    const started = await controller.start([{
      title: "interrupt steering queued",
      instructions: "write true first",
      acceptanceCriteria: ["deferred.txt reflects the latest instruction"],
    }]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "running");
    // No live control exists for this transport: the request must stay
    // durably queued exactly like an ordinary steer, never claimed as an
    // interruption.
    const queued = await controller.steer({
      executionId: started.executionId,
      taskId,
      instructions: "write false instead",
      instructionId: "queued-interrupt-steer",
      actor: "model",
      interrupt: true,
    });
    const command = queued.tasks[0]?.commands.at(-1);
    assert.equal(command?.status, "queued");
    assert.equal(command?.interrupt, true);
    await waitFor(() => controller!.inspect(started.executionId, taskId).tasks[0]?.state === "landed", 30_000);
    // The instruction was incorporated at the next executor handoff.
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
    await initGitRepo(root);
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
      externalAgents: {
        "steerable": {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" }
        }
      },
      execution: {
maxWorkers: 1,
subtaskNotifications: "noisy",
workerResources: { "default": { selection: { source: "external", id: "steerable" }, maxConcurrent: 1 } },
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
    await waitFor(() => messages.some((message) => /partial task completion, not completion of the whole group/.test(message)));
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
