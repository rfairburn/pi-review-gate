import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { EXECUTION_TOOL_NAMES, ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

// #465: removing a scheduled entry's pinned worker resource in settings while
// one of its occurrences is still queued makes that occurrence unrunnable
// before any worker starts. The production Save path (executionTools.sync ->
// refreshPool -> pump) must record it truthfully as failed and tell the USER
// through the existing local notify callback only: no model message, wake, or
// turn, no executor start, and no automatic re-route/spawn/retry. Ordinary
// pre-start failures (the #467 capture rejection) stay model-visible.

const execFileAsync = promisify(execFile);

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

type ModelMessage = { customType: string; content: string; details?: Record<string, any> };
type Delivery = { message: ModelMessage; options: unknown };

test("settings removal of a queued scheduled task's pinned resource notifies the user only; ordinary pre-start failures still reach the model", { skip: process.platform === "win32", timeout: 120_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-465-sched-route-")));
  let manager: ExecutionToolManager | undefined;
  const release = join(root, "release");
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) await execFileAsync("git", args, { cwd: repo });
    await writeFile(join(repo, "base.txt"), "base\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd: repo });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repo });

    // Records every executor launch by prompt sentinel; the blocker holds its
    // slot until released so the scheduled occurrence stays queued.
    const launches = join(root, "launches.log");
    const executor = join(root, "executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');let p='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>p+=c);",
      "process.stdin.on('end',()=>{",
      `fs.appendFileSync(${JSON.stringify(launches)},(p.includes('SCHEDULED_SENTINEL')?'scheduled':p.includes('BLOCKER_SENTINEL')?'blocker':'other')+'\\n');`,
      `const done=()=>{console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));console.log(JSON.stringify({type:'assistant',text:'done'}));};`,
      `const wait=()=>fs.existsSync(${JSON.stringify(release)})?done():setTimeout(wait,25);wait();`,
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    const config = normalizeConfig({
      enabled: true,
      retainBundles: "always",
      maxSnapshotBytes: 4096,
      review: { activeReviewers: [] },
      externalAgents: {
        fake: { adapter: "run-as-binary", command: executor, execution: { protocol: "pi-review-executor-jsonl-v1" } },
        "fake-spare": { adapter: "run-as-binary", command: executor, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      },
      execution: {
        maxWorkers: 3,
        workerResources: {
          pinned: { selection: { source: "external", id: "fake" }, maxConcurrent: 1 },
          spare: { selection: { source: "external", id: "fake-spare" }, maxConcurrent: 1 },
        },
        routes: { execute: [{ resourceId: "pinned" }], research: [] },
      },
    });
    const model: Delivery[] = [];
    const ui: string[] = [];
    const tools: Array<Record<string, any>> = [];
    manager = new ExecutionToolManager({
      pi: {
        registerTool: (tool: Record<string, any>) => { tools.push(tool); },
        registerCommand() {},
        setToolActive() {},
        getActiveTools: () => ["read", "bash", ...Object.values(EXECUTION_TOOL_NAMES)],
        sendMessage: (message: ModelMessage, options: unknown) => { model.push({ message, options }); },
      },
      config,
      state: createState(),
      cwd: () => repo,
      notify: (message: string) => { ui.push(message); },
    });
    manager.sync();
    const controller = (manager as unknown as { controller: {
      groups: Map<string, unknown>;
      inspect(executionId: string, taskId?: string): any;
      start(tasks: unknown[], kind: "execute", workspace: string): Promise<{ executionId: string }>;
    } }).controller;
    const launched = async () => (await readFile(launches, "utf8").catch(() => "")).split("\n").filter(Boolean);

    // The blocker occupies the pinned resource's only slot (spare capacity remains).
    await controller.start([{ title: "blocker", instructions: "BLOCKER_SENTINEL", acceptanceCriteria: ["held"] }], "execute", repo);
    await waitUntil(async () => (await launched()).includes("blocker"), "blocker executor start");

    const scheduled = await manager.startScheduled(
      { title: "Scheduled execute task nightly", instructions: "SCHEDULED_SENTINEL", acceptanceCriteria: ["never runs"] },
      "execute",
      repo,
      { scheduledTaskId: "nightly", workerResourceId: "pinned" },
    );
    const scheduledTaskId = scheduled.tasks[0]!.taskId as string;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    assert.equal(controller.inspect(scheduled.executionId, scheduledTaskId).tasks[0].state, "queued", "the occurrence is queued behind the busy pin");

    // Settings Save: the pinned resource is removed from the live config, then
    // the production onSaved path re-syncs the execution tools.
    const modelBefore = model.length;
    const uiBefore = ui.length;
    delete config.execution!.workerResources!.pinned;
    config.execution!.routes!.execute = [{ resourceId: "spare" }];
    manager.sync();

    await waitUntil(() => controller.inspect(scheduled.executionId, scheduledTaskId).tasks[0].state === "failed", "scheduled occurrence failed");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    const failed = controller.inspect(scheduled.executionId, scheduledTaskId).tasks[0];
    assert.match(failed.summary, /Scheduled task nightly cannot run: pinned worker resource pinned no longer resolves/);
    assert.equal(failed.error, failed.summary);
    const persisted = JSON.parse(await readFile(join(scheduled.root, "execution.json"), "utf8")) as { tasks: Array<{ taskId: string; state: string }> };
    assert.equal(persisted.tasks.find((task) => task.taskId === scheduledTaskId)?.state, "failed", "durable record is truthfully failed");

    const userNotices = ui.slice(uiBefore);
    assert.equal(userNotices.length, 1, "exactly one user-visible notice");
    assert.match(userNotices[0]!, /^review gate: Scheduled task nightly cannot run: pinned worker resource pinned/);
    assert.deepEqual(model.slice(modelBefore), [], "no model message, wake, steer, follow-up, or turn");
    assert.equal((await launched()).includes("scheduled"), false, "no executor started for the unrunnable occurrence");
    assert.equal(controller.groups.size, 2, "no automatic re-route, replacement, or retry");

    // Positive control: an ordinary pre-start failure (#467 capture rejection)
    // in an unrelated group is still delivered to the model, not the user notice path.
    await writeFile(join(repo, "oversize.bin"), Buffer.alloc(8192, "x"));
    const start = tools.find((tool) => tool.name === "SubtasksStart")!.execute as (...args: unknown[]) => Promise<Record<string, any>>;
    const ordinary = await start("ordinary", { tasks: [{ title: "ordinary", instructions: "ORDINARY", acceptanceCriteria: ["x"] }] }, undefined, undefined, {});
    const ordinaryTaskId = ordinary.details.tasks[0].taskId as string;
    await waitUntil(() => model.some((delivery) => delivery.message.details?.taskId === ordinaryTaskId && delivery.message.content.includes("requires recovery attention")), "ordinary failure reaches the model");
    const delivered = model.find((delivery) => delivery.message.details?.taskId === ordinaryTaskId && delivery.message.content.includes("requires recovery attention"))!;
    assert.ok(delivered.message.content.includes("Capture rejected before worker started"));
    assert.equal(ui.slice(uiBefore).length, 1, "the ordinary failure did not use the user-only notice path");
  } finally {
    await writeFile(release, "").catch(() => undefined);
    if (manager) {
      await manager.shutdown();
      await manager.detach();
    }
    // A cleanup error preserves the fixture instead of deleting under an unconfirmed writer.
    await rm(root, { recursive: true, force: true });
  }
});
