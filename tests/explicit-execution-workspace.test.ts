import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  BackgroundExecutionController,
  type BackgroundTaskDefinition,
} from "../src/execution/background-controller";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

// Issue #25 regression coverage: an optional top-level execution workspace
// target. The agreed production seam is (a) an optional top-level `workspace`
// string on SubtasksStart (Start only — SubtasksAdd inherits the group target)
// and (b) `BackgroundExecutionController.start(tasks, kind = "execute",
// workspace?: string)`. A supplied existing target becomes the group's
// immutable capture/landing cwd across dispatch, landing, restore,
// continuation, and recovery; omission or blank keeps the parent cwd.
//
const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function makeRepo(prefix: string, baseName: string, baseContent: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, baseName), baseContent, "utf8");
  await git(root, "add", baseName);
  await git(root, "commit", "-qm", "base");
  return root;
}

async function samePath(a: string, b: string): Promise<boolean> {
  return (await realpath(a)) === (await realpath(b));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function task(title: string, instructions: string): BackgroundTaskDefinition {
  return { title, instructions, acceptanceCriteria: [`${title} marker landed`] };
}

/** Fake executor seam: writes the marker file whose sentinel appears in the prompt. */
async function writeExecutorScript(root: string, markers: Array<{ sentinel: string; file: string }>): Promise<string> {
  const script = join(root, `executor-${markers.map((m) => m.sentinel.toLowerCase()).join("-")}.cjs`);
  await writeFile(script, [
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    `process.stdin.on('end',()=>{const markers=${JSON.stringify(markers)};`,
    "for(const marker of markers){if(prompt.includes(marker.sentinel)){fs.writeFileSync(marker.file,'landed\\n');}}",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));});",
  ].join("\n"), "utf8");
  return script;
}

function executionConfig(script: string): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "workspace-fake",
      adapter: "run-as-binary" as const,
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [script] },
    }],
    execution: {
      maxWorkers: 2,
      workerResources: [{ resourceId: "default", selection: { source: "external", id: "workspace-fake" }, maxConcurrent: 2 }],
    },
    retainBundles: "always",
  });
}

function makeController(config: ReviewGateConfig, cwd: () => string): BackgroundExecutionController {
  return new BackgroundExecutionController({ pi: {}, config, state: createState(), cwd });
}

async function removeOwned(roots: Iterable<string>): Promise<void> {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

test("start with an omitted or blank workspace keeps the parent cwd as the group target", async () => {
  const parent = await makeRepo("workspace-default-parent-", "base.txt", "parent base\n");
  const unrelated = await makeRepo("workspace-default-unrelated-", "base.txt", "unrelated base\n");
  const script = await writeExecutorScript(parent, [
    { sentinel: "OMITTED_SENTINEL", file: "omitted-landed.txt" },
    { sentinel: "BLANK_SENTINEL", file: "blank-landed.txt" },
  ]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const owned = [parent, unrelated];
  try {
    // Omitted workspace: the group target is the controller's parent cwd.
    const byOmission = await controller.start([task("omitted", "OMITTED_SENTINEL")]);
    assert.ok(await samePath(byOmission.cwd, parent), `group cwd ${byOmission.cwd} should be the parent cwd`);
    // Blank (whitespace-only) workspace resolves to the parent cwd as well.
    const byBlank = await controller.start([task("blank", "BLANK_SENTINEL")], "execute", "   ");
    assert.ok(await samePath(byBlank.cwd, parent), `blank workspace group cwd ${byBlank.cwd} should be the parent cwd`);

    await waitUntil(
      () => controller.inspect(byOmission.executionId).tasks.every((t) => t.state === "landed")
        && controller.inspect(byBlank.executionId).tasks.every((t) => t.state === "landed"),
      "default-workspace tasks to land in the parent repo",
    );
    assert.equal(await readFile(join(parent, "omitted-landed.txt"), "utf8"), "landed\n");
    assert.equal(await readFile(join(parent, "blank-landed.txt"), "utf8"), "landed\n");
    await assert.rejects(readFile(join(unrelated, "omitted-landed.txt"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(unrelated, "blank-landed.txt"), "utf8"), /ENOENT/);
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});

test("start forwards an explicit existing workspace target for capture and landing", async () => {
  const parent = await makeRepo("workspace-forward-parent-", "base.txt", "parent base\n");
  const workspace = await makeRepo("workspace-forward-target-", "base.txt", "target base\n");
  const script = await writeExecutorScript(parent, [{ sentinel: "FORWARD_SENTINEL", file: "forward-landed.txt" }]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const owned = [parent, workspace];
  try {
    const started = await controller.start([task("forwarded", "FORWARD_SENTINEL")], "execute", workspace);
    assert.ok(await samePath(started.cwd, workspace), `explicit target group cwd ${started.cwd} should be the workspace target`);
    await waitUntil(
      () => controller.inspect(started.executionId).tasks.every((t) => t.state === "landed"),
      "explicit-workspace task to land in the target repo",
    );
    assert.equal(await readFile(join(workspace, "forward-landed.txt"), "utf8"), "landed\n");
    await assert.rejects(readFile(join(parent, "forward-landed.txt"), "utf8"), /ENOENT/, "the parent cwd must stay unchanged by the workspace-targeted task");
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});

test("two workspace groups land in their own repositories without cross-target landing", async () => {
  const parent = await makeRepo("workspace-two-parent-", "base.txt", "parent base\n");
  const targetA = await makeRepo("workspace-two-target-a-", "base.txt", "a base\n");
  const targetB = await makeRepo("workspace-two-target-b-", "base.txt", "b base\n");
  const script = await writeExecutorScript(parent, [
    { sentinel: "GROUP_A_SENTINEL", file: "a-landed.txt" },
    { sentinel: "GROUP_B_SENTINEL", file: "b-landed.txt" },
  ]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const owned = [parent, targetA, targetB];
  try {
    const groupA = await controller.start([task("group-a", "GROUP_A_SENTINEL")], "execute", targetA);
    const groupB = await controller.start([task("group-b", "GROUP_B_SENTINEL")], "execute", targetB);
    assert.ok(await samePath(groupA.cwd, targetA));
    assert.ok(await samePath(groupB.cwd, targetB));
    await waitUntil(
      () => controller.inspect(groupA.executionId).tasks.every((t) => t.state === "landed")
        && controller.inspect(groupB.executionId).tasks.every((t) => t.state === "landed"),
      "both repository groups to land in their own targets",
    );
    assert.equal(await readFile(join(targetA, "a-landed.txt"), "utf8"), "landed\n");
    assert.equal(await readFile(join(targetB, "b-landed.txt"), "utf8"), "landed\n");
    await assert.rejects(readFile(join(targetB, "a-landed.txt"), "utf8"), /ENOENT/, "group A must not land into group B's target");
    await assert.rejects(readFile(join(targetA, "b-landed.txt"), "utf8"), /ENOENT/, "group B must not land into group A's target");
    await assert.rejects(readFile(join(parent, "a-landed.txt"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(parent, "b-landed.txt"), "utf8"), /ENOENT/);
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});

test("SubtasksAdd inherits the execution group's workspace target", async () => {
  const parent = await makeRepo("workspace-add-parent-", "base.txt", "parent base\n");
  const workspace = await makeRepo("workspace-add-target-", "base.txt", "target base\n");
  const script = await writeExecutorScript(parent, [
    { sentinel: "ADD_INITIAL_SENTINEL", file: "initial-landed.txt" },
    { sentinel: "ADDED_SENTINEL", file: "added-landed.txt" },
  ]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const owned = [parent, workspace];
  try {
    const started = await controller.start([task("initial", "ADD_INITIAL_SENTINEL")], "execute", workspace);
    await waitUntil(
      () => controller.inspect(started.executionId).tasks.every((t) => t.state === "landed"),
      "initial workspace task to land",
    );
    // SubtasksAdd takes no workspace of its own: it inherits the group target.
    await controller.add(started.executionId, [task("added", "ADDED_SENTINEL")]);
    await waitUntil(
      () => controller.inspect(started.executionId).tasks
        .find((t) => t.definition.title === "added")?.state === "landed",
      "added task to inherit the group target",
    );
    assert.equal(await readFile(join(workspace, "added-landed.txt"), "utf8"), "landed\n");
    await assert.rejects(readFile(join(parent, "added-landed.txt"), "utf8"), /ENOENT/, "an added task must not land in the parent cwd");
    const inspection = controller.inspect(started.executionId);
    assert.ok(await samePath(inspection.cwd, workspace), "the group target stays immutable after SubtasksAdd");
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});

test("restore and continuation keep the durable workspace target", async () => {
  const parent = await makeRepo("workspace-restore-parent-", "base.txt", "parent base\n");
  const workspace = await makeRepo("workspace-restore-target-", "base.txt", "target base\n");
  const script = await writeExecutorScript(parent, [
    { sentinel: "RESTORE_INITIAL_SENTINEL", file: "restore-landed.txt" },
    { sentinel: "RESTORE_CONTINUE_SENTINEL", file: "restore-continued.txt" },
  ]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const owned = [parent, workspace];
  let restored: BackgroundExecutionController | undefined;
  try {
    const started = await controller.start([task("durable", "RESTORE_INITIAL_SENTINEL")], "execute", workspace);
    owned.push(started.root);
    await waitUntil(
      () => controller.inspect(started.executionId).tasks.every((t) => t.state === "landed"),
      "durable target task to land before detach",
    );
    // Detach (not shutdown) keeps the landed task's wave and group state on
    // disk so restore exercises the durable workspace target, not a fresh one.
    const associations = controller.associations();
    await controller.detach();
    restored = makeController(config, () => parent);
    await restored.restore(associations);
    const restoredInspection = restored.inspect(started.executionId);
    assert.ok(await samePath(restoredInspection.cwd, workspace), `restored group cwd ${restoredInspection.cwd} must keep the durable workspace target`);

    const taskId = restoredInspection.tasks[0]!.taskId;
    await restored.continueTask({
      executionId: started.executionId,
      taskId,
      instructions: "RESTORE_CONTINUE_SENTINEL",
      instructionId: "workspace-restore-continue",
      actor: "user",
    });
    await waitUntil(
      () => restored!.inspect(started.executionId).tasks[0]?.state === "landed"
        && (async () => {
          try {
            return (await readFile(join(workspace, "restore-continued.txt"), "utf8")) === "landed\n";
          } catch {
            return false;
          }
        })(),
      "continued work to land in the preserved workspace target",
    );
    await assert.rejects(readFile(join(parent, "restore-continued.txt"), "utf8"), /ENOENT/, "continuation after restore must not land in the parent cwd");
  } finally {
    await restored?.shutdown().catch(() => undefined);
    await restored?.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});

test("start resolves a relative workspace against the session input cwd, not process.cwd()", async () => {
  const parent = await makeRepo("workspace-relative-parent-", "base.txt", "parent base\n");
  const checkout = await makeRepo("workspace-relative-checkout-", "base.txt", "checkout base\n");
  const script = await writeExecutorScript(parent, [{ sentinel: "RELATIVE_SENTINEL", file: "relative-landed.txt" }]);
  const config = executionConfig(script);
  const controller = makeController(config, () => parent);
  const owned = [parent, checkout];
  try {
    // The session input cwd is the parent repo, but the CLI process's
    // process.cwd() is this repository's root. A relative workspace must be
    // resolved once against the session cwd (path.resolve(parentCwd,
    // workspace)), never against process.cwd(); the checkout lives next to the
    // parent session directory and nowhere near the runner's process.cwd().
    const relativeTarget = join("..", basename(checkout));
    const started = await controller.start([task("relative", "RELATIVE_SENTINEL")], "execute", relativeTarget);
    assert.ok(
      await samePath(started.cwd, checkout),
      `relative workspace ${relativeTarget} must resolve against the session cwd (${parent}), not process.cwd() (${process.cwd()})`,
    );
    await waitUntil(
      () => controller.inspect(started.executionId).tasks.every((t) => t.state === "landed"),
      "relative-workspace task to land in the session-relative checkout",
    );
    assert.equal(await readFile(join(checkout, "relative-landed.txt"), "utf8"), "landed\n");
    await assert.rejects(readFile(join(parent, "relative-landed.txt"), "utf8"), /ENOENT/, "the session cwd must stay unchanged by the relative workspace task");
  } finally {
    await controller.shutdown().catch(() => undefined);
    await controller.detach().catch(() => undefined);
    await removeOwned(owned);
  }
});

test("SubtasksStart forwards the workspace target through the real tool entrypoint", async () => {
  const parent = await makeRepo("workspace-tool-parent-", "base.txt", "parent base\n");
  const workspace = await makeRepo("workspace-tool-target-", "base.txt", "target base\n");
  const script = await writeExecutorScript(parent, [{ sentinel: "TOOL_SENTINEL", file: "tool-landed.txt" }]);
  const config = executionConfig(script);
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
    getActiveTools: () => ["read", "bash", "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"],
  };
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => parent,
    notify: () => undefined,
  });
  manager.sync();
  const start = tools.find((tool) => tool.name === "SubtasksStart");
  assert.ok(start, "SubtasksStart was not registered");
  type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;
  try {
    const response = await (start.execute as ExecuteTool)("workspace-tool-start", {
      tasks: [task("tool-forwarded", "TOOL_SENTINEL")],
      workspace,
    }, undefined, undefined, {});
    assert.equal(response.isError, false);
    const started = response.details as { executionId: string; tasks: Array<{ state: string; waveRoot?: string }> };
    await waitUntil(
      () => readFile(join(workspace, "tool-landed.txt"), "utf8").then(() => true, () => false),
      "tool-forwarded task to land in the workspace target",
    );
    await assert.rejects(readFile(join(parent, "tool-landed.txt"), "utf8"), /ENOENT/, "the tool entrypoint must forward the workspace target, not the parent cwd");
    assert.equal(started.executionId.startsWith("exec-"), true);
  } finally {
    await manager.shutdown().catch(() => undefined);
    await manager.detach().catch(() => undefined);
    await removeOwned([parent, workspace]);
  }
});