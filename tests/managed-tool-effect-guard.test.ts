/**
 * #682: the optional trusted per-call lifecycle guard (`effectGuard`) that a
 * shared owner admission may attach to SubtasksStart and SubtasksInspect.
 *
 * Verified here, in process, against the real manager, shared binding, and
 * controller:
 * - Start checks the guard at entry, immediately before the execution root
 *   is allocated (after target resolution and temp-base lookup), and
 *   immediately before the group is attached (after the owner's last `cwd()`
 *   callback). A caller revoked before allocation leaves nothing behind. A
 *   caller revoked after allocation (or by that callback) creates no group
 *   and saves nothing, and its unpublished root, even an empty one, is
 *   retained untouched and reported: no path-based removal can be made
 *   conditional on the directory's identity. The same applies when a detach
 *   overlaps a guarded start; an unguarded (Pi) start keeps its original
 *   recursive cleanup. Once
 *   attached, a revocation (here, during the first save) neither rolls the
 *   group back nor cancels its task, and no further guard check runs.
 * - Inspect checks the guard at entry and immediately before each checkpoint
 *   backfill update. A caller revoked during recovery's awaits records no
 *   backfill, no refusal activity, and no save. An applied backfill stays
 *   applied and saved.
 * - Continue checks the guard at entry, at each continuation admission
 *   recheck (strict and explicit in-place), and immediately before its first
 *   recovery update. A caller revoked at any of them records no command,
 *   queue transition, or save. Once queued, a revocation (here, during the
 *   first save) neither rolls the continuation back nor stops its save. A
 *   guarded call never adopts an explicit reattachment bundle.
 * - Pi calls (and shared calls whose admission supplies no guard) keep the
 *   unchanged semantics: recovery gets no `beforeUpdate`, and a refused
 *   backfill still records its activity and saves.
 * - A guard on any other action, or a malformed guard, refuses before the
 *   handler.
 *
 * Most Inspect cases replace checkpoint recovery on the controller instance
 * with a stub honoring `recoverTaskAssociation`'s contract (awaits, then
 * `beforeUpdate`, then the synchronous task update), so revocation timing is
 * deterministic. One case runs the real recovery against a real retained
 * interrupted wave (the shared background-controller fixture). Elsewhere,
 * queued tasks never dispatch (`maxWorkers = 0`). No MCP transport, native
 * delegate, or provider launch is covered.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import {
  EFFECT_GUARD_CONTINUE_REVOKED,
  EFFECT_GUARD_INSPECT_REVOKED,
  EFFECT_GUARD_START_REVOKED,
  type ControllerEffectGuard,
} from "../src/execution/background-controller";
import {
  ExecutionToolManager,
  type ManagedToolAdmission,
  type SharedManagedToolAction,
} from "../src/execution/tool";
import { readGroup } from "../src/execution/background-group-store";
import { createState } from "../src/state";
import { setupInterruptedMergeTask, waitFor } from "./helpers/background-controller-fixtures";
import {
  EMPTY_ASSOCIATIONS,
  FixtureAdmission,
  SUBTASK_TOOL_NAMES,
  assertManagedEnvelope,
  managedToolFixture,
  queuedTask,
  type SharedTool,
} from "./managed-tool-fixtures";

// Private temp tree for this test process, so execution roots the controller
// creates (pi-review-execution-*) can be counted exactly. Node's tmpdir()
// reads TEMP/TMP on Windows and TMPDIR elsewhere.
const privateTmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-review-effect-guard-")));
const tempVariables = process.platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"];
const originalTemp = new Map(tempVariables.map((name) => [name, process.env[name]]));
for (const name of tempVariables) process.env[name] = privateTmp;
assert.equal(realpathSync(tmpdir()), privateTmp, "the controller's temp root must be the private fixture tree");
test.after(() => {
  for (const [name, value] of originalTemp) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(privateTmp, { recursive: true, force: true });
});

const executionRoots = (): string[] => readdirSync(privateTmp).filter((name) => name.startsWith("pi-review-execution-"));

type Recover = (group: any, task: any, explicit?: unknown, options?: { beforeUpdate?: () => void }) => Promise<void>;
interface ControllerInternals {
  save(group: unknown): Promise<unknown>;
  recoverTaskAssociation: Recover;
  groups: Map<string, { tasks: Array<Record<string, any>> }>;
  inspect(executionId: string): { tasks: Array<{ state: string }> };
  start(tasks: unknown[], kind?: "execute", workspace?: string, options?: { effectGuard?: ControllerEffectGuard }): Promise<unknown>;
  inspectTask(executionId?: string, taskId?: string, offset?: number, lines?: number, evidence?: undefined, guard?: ControllerEffectGuard): Promise<unknown>;
  continueTask(input: Record<string, unknown>, options?: { effectGuard?: ControllerEffectGuard }): Promise<unknown>;
}

function fixtureConfig() {
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      unstarted: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] } },
    },
    execution: {
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
  });
  config.execution!.maxWorkers = 0;
  return config;
}

/** Owner admission that attaches one trusted guard to every admitted call. */
class GuardedAdmission implements ManagedToolAdmission {
  readonly base = new FixtureAdmission();
  constructor(private readonly guard: unknown) {}
  resolveCall(toolCallId: string, toolName: string) {
    const admitted = this.base.resolveCall(toolCallId, toolName);
    return admitted && { ...admitted, effectGuard: this.guard as ControllerEffectGuard };
  }
}

interface HostFixture {
  manager: ExecutionToolManager;
  controller: ControllerInternals;
  invoke(action: SharedManagedToolAction, toolName: string, toolCallId: string, params: unknown, guard?: unknown): Promise<Record<string, any>>;
  groupCount(): number;
  dispose(): Promise<void>;
}

/** A no-Pi host manager, built like a host owner would: construct, restore, sync. */
async function hostFixture(onCwd?: () => void): Promise<HostFixture> {
  const sourceRoot = mkdtempSync(join(privateTmp, "source-"));
  const manager = new ExecutionToolManager({
    pi: undefined,
    config: fixtureConfig(),
    state: createState(),
    cwd: () => {
      onCwd?.();
      return sourceRoot;
    },
    authorizedTools: () => ["read", "bash"],
    liveToolCallAllowed: (name: string) => SUBTASK_TOOL_NAMES.includes(name),
    hostExposure: { actions: ["start", "inspect", "add", "watch", "continue", "steer"] },
  });
  await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
  manager.sync();
  const controller = (manager as unknown as { controller: ControllerInternals }).controller;
  return {
    manager,
    controller,
    invoke: async (action, toolName, toolCallId, params, guard) => {
      const admission = guard === undefined ? new FixtureAdmission() : new GuardedAdmission(guard);
      const base = admission instanceof GuardedAdmission ? admission.base : admission;
      base.admit(toolCallId, toolName, params);
      return (manager.sharedManagedTool(action, admission) as SharedTool).invoke({ toolCallId });
    },
    groupCount: () => manager.associations().groupRoots?.length ?? 0,
    dispose: async () => {
      await manager.shutdown();
      await manager.detach();
      for (const name of executionRoots()) rmSync(join(privateTmp, name), { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    },
  };
}

/** A guard current for the first `currentCalls` checks; logs the execution roots present at each check. */
function scriptedGuard(currentCalls: number) {
  const log: number[] = [];
  const guard: ControllerEffectGuard = {
    isCurrent: () => {
      log.push(executionRoots().length);
      return log.length <= currentCalls;
    },
  };
  return { guard, log };
}

const startParams = { tasks: [queuedTask("guarded start")] };

test("Start: a revoked caller attaches no group; a root exists only if it was revoked after allocation, and is then retained", async () => {
  // currentCalls → expected check log (roots present at each check) and roots left.
  const cases: Array<{ currentCalls: number; log: number[]; roots: number; label: string }> = [
    { currentCalls: 0, log: [0], roots: 0, label: "revoked at entry" },
    { currentCalls: 1, log: [0, 0], roots: 0, label: "revoked before allocation: no root is created" },
    { currentCalls: 2, log: [0, 0, 1], roots: 1, label: "revoked across allocation: the empty root is retained and reported" },
  ];
  for (const { currentCalls, log: expected, roots, label } of cases) {
    const fixture = await hostFixture();
    try {
      const { guard, log } = scriptedGuard(currentCalls);
      const response = await fixture.invoke("start", "SubtasksStart", `start-${currentCalls}`, startParams, guard);
      assertManagedEnvelope(response, true, label);
      assert.match(response.content[0].text, new RegExp(EFFECT_GUARD_START_REVOKED.replace(/[.;]/g, "\\$&")), label);
      assert.deepEqual(log, expected, label);
      assert.equal(fixture.groupCount(), 0, label);
      assert.equal(fixture.controller.groups.size, 0, label);
      assert.equal(executionRoots().length, roots, label);
      if (roots > 0) {
        const retained = join(privateTmp, executionRoots()[0]!);
        assert.deepEqual(readdirSync(retained), [], `${label}: still empty`);
        assert.ok(response.content[0].text.includes(`Its unpublished execution root was retained at ${retained}: safe ownership-checked removal is unavailable.`), label);
      }
    } finally {
      await fixture.dispose();
    }
  }
});

test("Start: an owner cwd() callback that revokes the caller after root creation attaches and saves nothing", async () => {
  let revoked = false;
  let controller: ControllerInternals | undefined;
  // Flip on the cwd() read that populates the group's sessionCwd: the only one
  // made after this call's root exists and before any group is attached.
  const fixture = await hostFixture(() => {
    if (controller && executionRoots().length > 0 && controller.groups.size === 0) revoked = true;
  });
  controller = fixture.controller;
  try {
    let saves = 0;
    const originalSave = fixture.controller.save.bind(fixture.controller);
    fixture.controller.save = async (group) => {
      saves += 1;
      return originalSave(group);
    };
    let checks = 0;
    const response = await fixture.invoke("start", "SubtasksStart", "start-cwd-revokes", startParams, {
      isCurrent: () => { checks += 1; return !revoked; },
    });
    assertManagedEnvelope(response, true, "cwd revocation");
    assert.equal(revoked, true, "the sessionCwd callback ran and revoked the caller");
    assert.equal(checks, 3);
    assert.match(response.content[0].text, /no longer current; no execution group or tasks were created/);
    assert.equal(fixture.controller.groups.size, 0);
    assert.equal(fixture.groupCount(), 0);
    assert.equal(saves, 0);
    assert.equal(executionRoots().length, 1, "the unpublished root is retained");
    assert.match(response.content[0].text, /Its unpublished execution root was retained at /);
  } finally {
    await fixture.dispose();
  }
});

test("Start: a caller revoked during the temp-base lookup allocates no root", async () => {
  const fixture = await hostFixture();
  const fsPromises = require("node:fs/promises") as { realpath: (...args: any[]) => Promise<string> };
  const originalRealpath = fsPromises.realpath;
  let revoked = false;
  let checks = 0;
  // createExecutionRoot resolves realpath(tmpdir()) right before mkdtemp.
  fsPromises.realpath = async (...args: any[]) => {
    if (args[0] === tmpdir()) revoked = true;
    return originalRealpath(...args);
  };
  try {
    await assert.rejects(
      fixture.controller.start([queuedTask("lookup revoked")], "execute", undefined, { effectGuard: { isCurrent: () => { checks += 1; return !revoked; } } }),
      { message: EFFECT_GUARD_START_REVOKED },
    );
    assert.equal(revoked, true, "revoked during the lookup");
    assert.equal(checks, 2, "entry, then the pre-allocation check");
    assert.deepEqual(executionRoots(), [], "no root allocated");
    assert.equal(fixture.controller.groups.size, 0);
  } finally {
    fsPromises.realpath = originalRealpath;
    await fixture.dispose();
  }
});

/** A guard current for two checks that tampers with the fresh root at the final check, then revokes. */
function tamperingGuard(tamper: (rootPath: string) => void): ControllerEffectGuard {
  let checks = 0;
  return {
    isCurrent: () => {
      checks += 1;
      if (checks < 3) return true;
      const [name] = executionRoots();
      assert.ok(name, "the fresh root exists at the final check");
      tamper(join(privateTmp, name));
      return false;
    },
  };
}

test("Start: revocation cleanup never follows a replaced root entry", { skip: process.platform === "win32" ? "symlink creation needs privileges on Windows" : false }, async () => {
  const fixture = await hostFixture();
  const victim = mkdtempSync(join(privateTmp, "victim-"));
  writeFileSync(join(victim, "keep.txt"), "not Start's\n");
  try {
    let replacedAt = "";
    const guard = tamperingGuard((rootPath) => {
      replacedAt = rootPath;
      renameSync(rootPath, `${rootPath}-moved`);
      symlinkSync(victim, rootPath, "dir");
    });
    const response = await fixture.invoke("start", "SubtasksStart", "start-replaced", startParams, guard);
    assertManagedEnvelope(response, true, "replaced root");
    assert.match(response.content[0].text, /no execution group or tasks were created\. Its unpublished execution root was retained at .*: safe ownership-checked removal is unavailable\./);
    assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "not Start's\n", "the symlink target is untouched");
    assert.ok(existsSync(replacedAt), "the replacing entry is retained");
    assert.ok(existsSync(`${replacedAt}-moved`), "the moved original is not chased");
    assert.equal(fixture.controller.groups.size, 0);
  } finally {
    await fixture.dispose();
    rmSync(victim, { recursive: true, force: true });
  }
});

test("Start: revocation never deletes content added to the fresh root", async () => {
  const fixture = await hostFixture();
  try {
    let rootPath = "";
    const guard = tamperingGuard((path) => {
      rootPath = path;
      mkdirSync(join(path, "added"));
      writeFileSync(join(path, "added", "data.txt"), "added after creation\n");
    });
    const response = await fixture.invoke("start", "SubtasksStart", "start-nonempty", startParams, guard);
    assertManagedEnvelope(response, true, "non-empty root");
    assert.match(response.content[0].text, /Its unpublished execution root was retained at /);
    assert.equal(readFileSync(join(rootPath, "added", "data.txt"), "utf8"), "added after creation\n", "added content is never deleted");
    assert.equal(fixture.controller.groups.size, 0);
  } finally {
    await fixture.dispose();
  }
});

/**
 * Pauses the fresh root's realpath (inside root creation): writes a marker into
 * the new directory, optionally revokes, and completes a detach before letting
 * realpath return. The compiled controller reads `fs/promises.realpath` at call
 * time, so patching the module object intercepts exactly that call.
 */
async function startOverlappingDetach(guarded: boolean) {
  const fixture = await hostFixture();
  const fsPromises = require("node:fs/promises") as { realpath: (...args: any[]) => Promise<string> };
  const originalRealpath = fsPromises.realpath;
  let revoked = false;
  let detached = false;
  let markerPath = "";
  fsPromises.realpath = async (...args: any[]) => {
    const [path] = args;
    if (!markerPath && typeof path === "string" && basename(path).startsWith("pi-review-execution-")) {
      markerPath = join(path, "marker.txt");
      writeFileSync(markerPath, "added during root creation\n");
      revoked = true;
      await fixture.manager.detach();
      detached = true;
    }
    return originalRealpath(...args);
  };
  let error: unknown;
  try {
    await fixture.controller.start([queuedTask("overlapping detach")], "execute", undefined,
      guarded ? { effectGuard: { isCurrent: () => !revoked } } : undefined)
      .then(() => assert.fail("start must not succeed"), (rejection: unknown) => { error = rejection; });
  } finally {
    fsPromises.realpath = originalRealpath;
  }
  return { fixture, error, detached, revoked, markerPath, groups: fixture.controller.groups.size };
}

test("Start: detach overlapping a revoked guarded start retains the fresh root and its contents", async () => {
  const outcome = await startOverlappingDetach(true);
  try {
    assert.equal(outcome.detached, true, "the detach completed during root creation");
    assert.equal(outcome.revoked, true);
    assert.match(String((outcome.error as Error)?.message), /controller detach began while the execution group was being created\. Its unpublished execution root was retained at /);
    assert.equal(outcome.groups, 0, "no group attaches");
    assert.equal(readFileSync(outcome.markerPath, "utf8"), "added during root creation\n", "the marker survives");
  } finally {
    await outcome.fixture.dispose();
  }
});

test("Start: an unguarded (Pi) start overlapping detach keeps its original recursive cleanup", async () => {
  const outcome = await startOverlappingDetach(false);
  try {
    assert.equal(outcome.detached, true);
    assert.equal(String((outcome.error as Error)?.message), "Application shutdown or controller detach began while the execution group was being created.");
    assert.equal(outcome.groups, 0);
    assert.equal(existsSync(outcome.markerPath), false, "unchanged: the unguarded root is removed recursively");
    assert.deepEqual(executionRoots(), []);
  } finally {
    await outcome.fixture.dispose();
  }
});

test("Start: once attached, a revoked caller's group is kept, saved, and not cancelled", async () => {
  const fixture = await hostFixture();
  try {
    let revoked = false;
    let checks = 0;
    const guard: ControllerEffectGuard = { isCurrent: () => { checks += 1; return !revoked; } };
    const originalSave = fixture.controller.save.bind(fixture.controller);
    let saves = 0;
    fixture.controller.save = async (group) => {
      // The caller is revoked while the attached group's first save awaits.
      revoked = true;
      saves += 1;
      return originalSave(group);
    };
    const response = await fixture.invoke("start", "SubtasksStart", "start-admitted", startParams, guard);
    assertManagedEnvelope(response, false, "admitted start");
    assert.equal(revoked, true);
    assert.equal(checks, 3, "no guard check after the group is attached");
    assert.equal(saves, 1);
    assert.equal(fixture.groupCount(), 1);
    assert.equal(executionRoots().length, 1, "the attached root is not removed");
    const details = response.details as Record<string, any>;
    assert.deepEqual(fixture.controller.inspect(details.executionId).tasks.map((task) => task.state), ["queued"], "work is not rolled back or cancelled");
  } finally {
    await fixture.dispose();
  }
});

/** Starts one unguarded group of `count` tasks and makes each eligible for checkpoint backfill. */
async function backfillEligible(fixture: { controller: ControllerInternals; invoke: HostFixture["invoke"] }, count = 1) {
  const response = await fixture.invoke("start", "SubtasksStart", "seed", { tasks: Array.from({ length: count }, (_, index) => queuedTask(`seed ${index}`)) });
  assertManagedEnvelope(response, false, "seed start");
  const executionId = (response.details as Record<string, any>).executionId as string;
  const tasks = fixture.controller.groups.get(executionId)!.tasks;
  for (const task of tasks) {
    task.state = "failed";
    task.waveRoot = join(privateTmp, `wave-${task.taskId}`);
  }
  return { executionId, tasks };
}

interface RecoveryStub {
  calls: Array<{ taskId: string; hasOptions: boolean }>;
  saves: number;
}

/**
 * Replaces checkpoint recovery with a stub honoring its contract: awaits,
 * `during` (the revocation point), then `beforeUpdate`, then the update.
 */
function stubRecovery(controller: ControllerInternals, during: (taskId: string) => void, fail?: string): RecoveryStub {
  const stub: RecoveryStub = { calls: [], saves: 0 };
  controller.recoverTaskAssociation = async (_group, task, _explicit, options) => {
    stub.calls.push({ taskId: task.taskId, hasOptions: options !== undefined });
    await Promise.resolve();
    during(task.taskId);
    await Promise.resolve();
    if (fail) throw new Error(fail);
    options?.beforeUpdate?.();
    task.summary = `backfilled ${task.taskId}`;
  };
  const originalSave = controller.save.bind(controller);
  controller.save = async (group) => {
    stub.saves += 1;
    return originalSave(group);
  };
  return stub;
}

const refusedActivity = (task: Record<string, any>) => task.activity.filter((entry: { message?: string }) => /Checkpoint backfill refused/.test(entry.message ?? ""));

test("Inspect: a revoked caller enters no backfill update, refusal activity, or save", async () => {
  for (const variant of ["entry", "during recovery", "during failing recovery"] as const) {
    const fixture = await hostFixture();
    try {
      const { executionId, tasks } = await backfillEligible(fixture);
      const task = tasks[0]!;
      let revoked = variant === "entry";
      const stub = stubRecovery(fixture.controller, () => { revoked = true; }, variant === "during failing recovery" ? "recovery refused" : undefined);
      const activityBefore = task.activity.length;
      const response = await fixture.invoke("inspect", "SubtasksInspect", `inspect-${variant}`, { executionId, taskId: task.taskId }, { isCurrent: () => !revoked });
      assertManagedEnvelope(response, true, variant);
      assert.match(response.content[0].text, /no longer current; inspection stopped before any further checkpoint backfill/, variant);
      assert.equal(stub.calls.length, variant === "entry" ? 0 : 1, variant);
      assert.equal(task.summary, undefined, `${variant}: no backfill update`);
      assert.equal(task.activity.length, activityBefore, `${variant}: no refusal activity`);
      assert.equal(stub.saves, 0, `${variant}: nothing saved`);
    } finally {
      await fixture.dispose();
    }
  }
});

test("Inspect: an applied backfill is kept and saved even when the caller is revoked before the next one", async () => {
  const fixture = await hostFixture();
  try {
    const { executionId, tasks } = await backfillEligible(fixture, 2);
    let revoked = false;
    const stub = stubRecovery(fixture.controller, () => {});
    // Revoke while the first task's backfill save awaits.
    const countingSave = fixture.controller.save;
    fixture.controller.save = async (group) => {
      revoked = true;
      return countingSave(group);
    };
    // The tool requires a taskId, so the whole-group backfill loop is reached
    // through the controller operation directly.
    await assert.rejects(
      fixture.controller.inspectTask(executionId, undefined, undefined, undefined, undefined, { isCurrent: () => !revoked }),
      { message: EFFECT_GUARD_INSPECT_REVOKED },
    );
    assert.deepEqual(stub.calls.map((call) => call.hasOptions), [true, true]);
    assert.equal(tasks[0]!.summary, `backfilled ${tasks[0]!.taskId}`, "first backfill is not rolled back");
    assert.equal(tasks[1]!.summary, undefined, "second backfill never ran its update");
    assert.equal(stub.saves, 1, "only the admitted backfill was saved");
    assert.equal(refusedActivity(tasks[1]!).length, 0);
  } finally {
    await fixture.dispose();
  }
});

test("Inspect: a current guarded caller backfills exactly like an unguarded one", async () => {
  const fixture = await hostFixture();
  try {
    const { executionId, tasks } = await backfillEligible(fixture);
    const stub = stubRecovery(fixture.controller, () => {});
    const response = await fixture.invoke("inspect", "SubtasksInspect", "inspect-current", { executionId, taskId: tasks[0]!.taskId }, { isCurrent: () => true });
    assertManagedEnvelope(response, false, "current guarded inspect");
    assert.equal(tasks[0]!.summary, `backfilled ${tasks[0]!.taskId}`);
    assert.equal(stub.saves, 1);
  } finally {
    await fixture.dispose();
  }
});

test("Pi and unguarded shared calls keep the existing Start and Inspect semantics", async () => {
  // Shared call without a guard: recovery gets no options, and a refused
  // backfill still records its activity and saves.
  const host = await hostFixture();
  try {
    const { executionId, tasks } = await backfillEligible(host);
    const stub = stubRecovery(host.controller, () => {}, "recovery refused");
    const response = await host.invoke("inspect", "SubtasksInspect", "inspect-unguarded", { executionId, taskId: tasks[0]!.taskId });
    assertManagedEnvelope(response, false, "unguarded inspect");
    assert.deepEqual(stub.calls.map((call) => call.hasOptions), [false]);
    assert.equal(refusedActivity(tasks[0]!).length, 1);
    assert.equal(stub.saves, 1);
  } finally {
    await host.dispose();
  }

  // Pi registration never carries a guard.
  const pi = await managedToolFixture();
  try {
    const controller = (pi.manager as unknown as { controller: ControllerInternals }).controller;
    const started = await pi.piExecute("SubtasksStart")("pi-start", startParams, undefined, undefined, {});
    assertManagedEnvelope(started, false, "pi start");
    assert.equal(pi.groupCount(), 1);
    const executionId = (started.details as Record<string, any>).executionId as string;
    const task = controller.groups.get(executionId)!.tasks[0]!;
    task.state = "failed";
    task.waveRoot = join(privateTmp, `wave-${task.taskId}`);
    const stub = stubRecovery(controller, () => {}, "recovery refused");
    const inspected = await pi.piExecute("SubtasksInspect")("pi-inspect", { executionId, taskId: task.taskId }, undefined, undefined, {});
    assertManagedEnvelope(inspected, false, "pi inspect");
    assert.deepEqual(stub.calls.map((call) => call.hasOptions), [false]);
    assert.equal(refusedActivity(task).length, 1);
    assert.equal(stub.saves, 1);
  } finally {
    await pi.dispose();
  }
});

test("a guard on a non-guarded action, or a malformed guard, refuses before the handler", async () => {
  const fixture = await hostFixture();
  try {
    const seeded = await fixture.invoke("start", "SubtasksStart", "seed", startParams);
    const executionId = (seeded.details as Record<string, any>).executionId as string;
    const current = { isCurrent: () => true };
    // #682: Add is now an effect-guarded action (it fences before attaching
    // its tasks); Watch remains the non-guarded example.
    const cases: Array<[SharedManagedToolAction, string, unknown, unknown]> = [
      ["watch", "SubtasksWatch", { executionId, afterMs: 60_000 }, current],
      // Steer commits synchronously after admission and takes no guard.
      ["steer", "SubtasksSteer", { executionId, taskId: "task-x", instructions: "go" }, current],
      ["add", "SubtasksAdd", { executionId, tasks: [queuedTask("extra")] }, { isCurrent: "yes" }],
      ["start", "SubtasksStart", startParams, { isCurrent: true }],
      ["inspect", "SubtasksInspect", { executionId }, null],
      ["inspect", "SubtasksInspect", { executionId }, { get isCurrent(): never { throw new Error("accessor"); } }],
    ];
    for (const [action, toolName, params, guard] of cases) {
      const response = await fixture.invoke(action, toolName, `bad-${action}`, params, guard);
      assertManagedEnvelope(response, true, action);
      assert.match(response.content[0].text, /owner lifecycle guard is invalid or cannot be honored by this action; nothing was started or read/, action);
    }
    assert.equal(fixture.groupCount(), 1);
    assert.equal(fixture.controller.groups.get(executionId)!.tasks.length, 1, "Add never reached the controller");
  } finally {
    await fixture.dispose();
  }
});

test("Inspect: real checkpoint recovery calls the guard before its update; a revoked caller changes neither memory nor the persisted group", async () => {
  const scenario = await setupInterruptedMergeTask("effect-guard-inspect");
  const { controller, started, taskId } = scenario;
  try {
    const internals = controller as unknown as { runtimes: Map<string, unknown> };
    await waitFor(() => !internals.runtimes.has(taskId));
    const snapshot = () => {
      const task = controller.inspect(started.executionId, taskId).tasks[0]!;
      return JSON.stringify({ bundle: task.bundle, result: task.result, summary: task.summary, updatedAt: task.updatedAt, activity: task.activity });
    };
    const persistedRevision = async () => (await readGroup(started.root)).group.revision;
    const before = snapshot();
    const revisionBefore = await persistedRevision();

    // Current at entry; revoked across the real recovery verification.
    const checks: string[] = [];
    const revokedGuard: ControllerEffectGuard = {
      isCurrent: () => {
        checks.push(new Error().stack ?? "");
        return checks.length === 1;
      },
    };
    await assert.rejects(
      controller.inspectTask(started.executionId, taskId, undefined, undefined, undefined, revokedGuard),
      { message: EFFECT_GUARD_INSPECT_REVOKED },
    );
    assert.equal(checks.length, 2);
    assert.match(checks[1]!, /recoverTaskAssociation/, "the refusing check ran inside the real recovery, at beforeUpdate");
    assert.equal(snapshot(), before, "no backfill or activity in memory");
    assert.equal(await persistedRevision(), revisionBefore, "nothing persisted");

    // Control on the same unchanged state: a current caller's real recovery
    // reaches the same check, backfills, and saves.
    let currentChecks = 0;
    await controller.inspectTask(started.executionId, taskId, undefined, undefined, undefined, { isCurrent: () => { currentChecks += 1; return true; } });
    assert.equal(currentChecks, 2);
    const after = controller.inspect(started.executionId, taskId).tasks[0]!;
    assert.equal(after.activity.some((event) => /Checkpoint backfill refused/.test(event.message)), false, "the real recovery succeeded");
    assert.notEqual(snapshot(), before, "the backfill updated the task");
    assert.ok(await persistedRevision() > revisionBefore, "and was saved");
  } finally {
    await scenario.cleanup();
  }
});

interface ContinueRecoveryStub {
  calls: Array<{ taskId: string; options?: string[] }>;
  saves: number;
}

/**
 * Replaces checkpoint recovery with a stub honoring its contract for
 * Continue: awaits, `during`, `beforeUpdate`, then the synchronous update that
 * publishes the task's continuation bundle, then `after`.
 */
function stubContinueRecovery(controller: ControllerInternals, hooks: { during?: () => void; after?: () => void } = {}): ContinueRecoveryStub {
  const stub: ContinueRecoveryStub = { calls: [], saves: 0 };
  controller.recoverTaskAssociation = async (_group, task, _explicit, options) => {
    stub.calls.push({ taskId: task.taskId, ...(options === undefined ? {} : { options: Object.keys(options).sort() }) });
    await Promise.resolve();
    hooks.during?.();
    await Promise.resolve();
    options?.beforeUpdate?.();
    task.bundle = { version: 1, operationId: `op-${task.taskId}`, waveId: "wave", taskId: task.taskId, waveRoot: task.waveRoot, expectedRevision: 1 };
    hooks.after?.();
  };
  const originalSave = controller.save.bind(controller);
  controller.save = async (group) => {
    stub.saves += 1;
    return originalSave(group);
  };
  return stub;
}

const continueCommands = (task: Record<string, any>) => task.commands.filter((command: { action: string }) => command.action === "continue");

test("Continue: a revoked caller records no command, queue transition, or save", async () => {
  const variants = ["entry", "during recovery", "during in-place recovery", "after recovery, at the admission recheck"] as const;
  for (const variant of variants) {
    const fixture = await hostFixture();
    try {
      const { executionId, tasks } = await backfillEligible(fixture);
      const task = tasks[0]!;
      let revoked = variant === "entry";
      const revoke = () => { revoked = true; };
      const stub = stubContinueRecovery(fixture.controller, variant === "after recovery, at the admission recheck" ? { after: revoke } : { during: revoke });
      const inPlace = variant === "during in-place recovery";
      const response = await fixture.invoke("continue", "SubtasksContinue", `continue-${variant}`, {
        executionId, taskId: task.taskId, instructions: "resume", ...(inPlace ? { inPlace: true } : {}),
      }, { isCurrent: () => !revoked });
      assertManagedEnvelope(response, true, variant);
      assert.match(response.content[0].text, /no longer current; the continuation was not admitted and the task was not queued/, variant);
      assert.equal(stub.calls.length, variant === "entry" ? 0 : 1, variant);
      if (variant !== "entry") {
        assert.deepEqual(stub.calls[0]!.options, inPlace ? ["beforeUpdate", "inPlace"] : ["beforeUpdate"], `${variant}: recovery carries the guard`);
      }
      assert.equal(task.state, "failed", `${variant}: not queued`);
      assert.equal(task.pendingContinuation, undefined, variant);
      assert.equal(continueCommands(task).length, 0, `${variant}: no command`);
      if (variant !== "after recovery, at the admission recheck") assert.equal(task.bundle, undefined, `${variant}: no recovery update`);
      assert.equal(stub.saves, 0, `${variant}: nothing saved`);
    } finally {
      await fixture.dispose();
    }
  }
});

test("Continue: a current guarded caller is admitted; a revocation after queueing neither rolls it back nor stops its save", async () => {
  const fixture = await hostFixture();
  try {
    const { executionId, tasks } = await backfillEligible(fixture);
    const task = tasks[0]!;
    let revoked = false;
    let checks = 0;
    const stub = stubContinueRecovery(fixture.controller);
    const countingSave = fixture.controller.save;
    fixture.controller.save = async (group) => {
      revoked = true;
      return countingSave(group);
    };
    const response = await fixture.invoke("continue", "SubtasksContinue", "continue-admitted", { executionId, taskId: task.taskId, instructions: "resume" }, {
      isCurrent: () => { checks += 1; return !revoked; },
    });
    assertManagedEnvelope(response, false, "admitted continue");
    assert.equal(revoked, true);
    assert.equal(checks, 4, "entry, admission recheck, before the recovery update, and the post-recovery recheck; none after queueing");
    assert.equal(task.state, "queued", "not rolled back");
    assert.deepEqual(continueCommands(task).map((command: Record<string, unknown>) => [command.instructionId, command.status]), [["continue-admitted", "queued"]]);
    assert.equal(task.pendingContinuation?.instructionId, "continue-admitted");
    assert.equal(stub.saves, 1, "the admitted continuation was saved");
    const root = (fixture.controller.groups.get(executionId) as unknown as { root: string }).root;
    const persisted = (await readGroup(root)).group.tasks.find((candidate) => candidate.taskId === task.taskId);
    assert.equal(persisted?.state, "queued", "and the save persisted it");
  } finally {
    await fixture.dispose();
  }
});

test("Continue: an explicit reattachment bundle stays refused with a current guard, before any recovery", async () => {
  const fixture = await hostFixture();
  try {
    const { executionId, tasks } = await backfillEligible(fixture);
    const task = tasks[0]!;
    const stub = stubContinueRecovery(fixture.controller);
    const bundle = { version: 1, operationId: "op-foreign", waveId: "wave", taskId: task.taskId, waveRoot: task.waveRoot, expectedRevision: 0 };
    const response = await fixture.invoke("continue", "SubtasksContinue", "continue-bundle", { executionId, taskId: task.taskId, instructions: "resume", bundle }, { isCurrent: () => true });
    assertManagedEnvelope(response, true, "bundle");
    assert.match(response.content[0].text, /^SubtasksContinue failed closed: an explicit reattachment bundle is not admitted through the shared managed boundary/);
    // The controller refuses a guarded bundle itself too, before any lookup.
    await assert.rejects(
      fixture.controller.continueTask({ executionId, taskId: task.taskId, bundle, instructions: "resume", instructionId: "direct-bundle", actor: "model" }, { effectGuard: { isCurrent: () => true } }),
      /guarded continuation does not admit an explicit reattachment bundle/,
    );
    assert.equal(stub.calls.length, 0, "no recovery or adoption");
    assert.equal(stub.saves, 0);
    assert.equal(continueCommands(task).length, 0);
    assert.equal(task.state, "failed");
  } finally {
    await fixture.dispose();
  }
});

test("Pi and unguarded shared Continue keep recovery without a guard", async () => {
  const host = await hostFixture();
  try {
    const { executionId, tasks } = await backfillEligible(host);
    const stub = stubContinueRecovery(host.controller);
    const response = await host.invoke("continue", "SubtasksContinue", "continue-unguarded", { executionId, taskId: tasks[0]!.taskId, instructions: "resume" });
    assertManagedEnvelope(response, false, "unguarded continue");
    assert.deepEqual(stub.calls.map((call) => call.options), [undefined], "recovery gets no options");
    assert.equal(tasks[0]!.state, "queued");
    assert.equal(stub.saves, 1);
  } finally {
    await host.dispose();
  }

  const pi = await managedToolFixture();
  try {
    const controller = (pi.manager as unknown as { controller: ControllerInternals }).controller;
    const started = await pi.piExecute("SubtasksStart")("pi-start", startParams, undefined, undefined, {});
    assertManagedEnvelope(started, false, "pi start");
    const executionId = (started.details as Record<string, any>).executionId as string;
    const task = controller.groups.get(executionId)!.tasks[0]!;
    task.state = "failed";
    task.waveRoot = join(privateTmp, `wave-${task.taskId}`);
    const stub = stubContinueRecovery(controller);
    const continued = await pi.piExecute("SubtasksContinue")("pi-continue", { executionId, taskId: task.taskId, instructions: "resume" }, undefined, undefined, {});
    assertManagedEnvelope(continued, false, "pi continue");
    assert.deepEqual(stub.calls.map((call) => call.options), [undefined]);
    assert.equal(task.state, "queued");
  } finally {
    await pi.dispose();
  }
});

test("Continue: real checkpoint recovery calls the guard before its update; a revoked caller changes neither memory nor the persisted group", async () => {
  const scenario = await setupInterruptedMergeTask("effect-guard-continue");
  const { controller, started, taskId } = scenario;
  try {
    const internals = controller as unknown as { runtimes: Map<string, unknown>; groups: Map<string, { tasks: Array<Record<string, any>> }> };
    await waitFor(() => !internals.runtimes.has(taskId));
    const task = internals.groups.get(started.executionId)!.tasks.find((candidate) => candidate.taskId === taskId)!;
    // Without an in-memory continuation bundle, strict Continue runs the real
    // recovery, which re-derives it from the retained operation record.
    task.bundle = undefined;
    const snapshot = () => JSON.stringify({ state: task.state, bundle: task.bundle, result: task.result, commands: task.commands, pending: task.pendingContinuation, updatedAt: task.updatedAt });
    const persistedRevision = async () => (await readGroup(started.root)).group.revision;
    const before = snapshot();
    const revisionBefore = await persistedRevision();
    const input = (instructionId: string) => ({ executionId: started.executionId, taskId, instructions: "resume", instructionId, actor: "model" as const });

    // Current at entry and at the first admission recheck; revoked across the real recovery's awaits.
    const checks: boolean[] = [];
    await assert.rejects(
      controller.continueTask(input("continue-revoked"), {
        effectGuard: { isCurrent: () => { checks.push(/recoverTaskAssociation/.test(new Error().stack ?? "")); return checks.length <= 2; } },
      }),
      { message: EFFECT_GUARD_CONTINUE_REVOKED },
    );
    assert.deepEqual(checks, [false, false, true], "the refusing check ran inside the real recovery, at beforeUpdate");
    assert.equal(snapshot(), before, "no recovery update, command, or queue transition in memory");
    assert.equal(await persistedRevision(), revisionBefore, "nothing persisted");

    // Control on the same unchanged state: a current caller reaches the same
    // check, then the post-recovery recheck, and is admitted and saved.
    const currentChecks: boolean[] = [];
    await controller.continueTask(input("continue-current"), {
      effectGuard: { isCurrent: () => { currentChecks.push(/recoverTaskAssociation/.test(new Error().stack ?? "")); return true; } },
    });
    assert.deepEqual(currentChecks, [false, false, true, false]);
    assert.ok(task.bundle, "the real recovery published the continuation bundle");
    assert.deepEqual(continueCommands(task).map((command: Record<string, unknown>) => command.instructionId), ["continue-current"]);
    assert.ok(await persistedRevision() > revisionBefore, "and the admission was saved");
  } finally {
    await scenario.cleanup();
  }
});
