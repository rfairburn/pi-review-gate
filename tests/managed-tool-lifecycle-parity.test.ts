/**
 * #682 slice 4: SubtasksAdd, SubtasksContinue, SubtasksSteer, and
 * SubtasksInterrupt through the canonical managed-tool boundary, with
 * SubtasksForceMerge and SubtasksMarkClean deliberately left unbound.
 *
 * The shared inventory is the canonical action list (./tool-names) minus two
 * documented exclusions, and every shared call runs the same private handler
 * as Pi. Binding grants no exposure: nothing here registers, activates, or
 * wires a production owner, and the standalone MCP smoke still binds only
 * Start and Inspect.
 *
 * Verified here, in process, against the real manager and controller (see
 * ./managed-tool-fixtures.ts for what is faked; executors never start, so
 * tasks stay queued until a lifecycle call changes them):
 * - Each bound definition has Pi's name, schema, and description. ForceMerge
 *   and MarkClean refuse to bind with their specific reason and stay intact
 *   on Pi.
 * - Invalid requests get Pi's canonical validation errors.
 * - Missing, other-call, and other-tool admissions, a live-policy denial, and
 *   a tool not allowed at launch all fail closed before the handler runs and
 *   leave the controller untouched.
 * - Canonical outcomes match Pi call for call (twin fixtures run the same
 *   script through each path): Add tops off, Steer queues a steer, a retried
 *   instruction id is deduplicated, Interrupt stops as failure, and Continue
 *   reports the controller's scoped refusals.
 * - Owner scoping: another owner's handles resolve to scoped unknown-target
 *   failures without leaking or changing the first owner's work.
 * - Explicit reattachment bundles and interrupt_with_merge: validation still
 *   matches Pi, but the validated input is refused on the shared path before
 *   the controller runs. Pi still hands the same request to the unchanged
 *   controller. This does not exercise actual recovery, adoption, or merge.
 * - Overlapping workspace roots: with another owner's conflict gate on this
 *   owner's root, shared calls never disclose that gate's reason, never
 *   persist it, and never release the process-wide block.
 * - Owner scope closing mid-call: a shared call whose owner session is
 *   restored while the handler runs returns only the fixed stale-scope
 *   result, never the handler's result shaped from the next owner's state.
 * No MCP transport, real owner admission, or native-CLI behavior is covered.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BackgroundExecutionController } from "../src/execution/background-controller";
import { EXECUTION_TOOL_NAMES, SHARED_MANAGED_TOOL_ACTIONS, type ManagedToolAdmission, type SharedManagedToolAction } from "../src/execution/tool";
import { EXECUTION_TOOL_ACTIONS, type ExecutionToolAction } from "../src/execution/tool-names";
import { sourceMutationCoordinator } from "../src/execution/source-mutation-lease";
import {
  EMPTY_ASSOCIATIONS,
  SUBTASK_TOOL_NAMES,
  assertManagedEnvelope,
  managedToolFixture,
  queuedTask,
  type ManagedToolFixture,
} from "./managed-tool-fixtures";

/** The actions this slice binds: the shared inventory minus the earlier slices. */
const EARLIER_SLICES = ["start", "inspect", "watch"] as const;
type Lifecycle = Exclude<SharedManagedToolAction, (typeof EARLIER_SLICES)[number]>;
const LIFECYCLE = SHARED_MANAGED_TOOL_ACTIONS.filter((action): action is Lifecycle => !(EARLIER_SLICES as readonly string[]).includes(action));
/** Canonical actions the shared boundary leaves unbound. */
const UNBOUND = EXECUTION_TOOL_ACTIONS.filter((action) => !(SHARED_MANAGED_TOOL_ACTIONS as readonly string[]).includes(action));
const nameOf = (action: ExecutionToolAction) => EXECUTION_TOOL_NAMES[action];
const call = (toolCallId: string) => ({ toolCallId });

type SpyBinding = { toolCallId: string; host?: { ctx: unknown } };
type Handler = (action: string, toolName: string, params: unknown, binding: SpyBinding) => Promise<Record<string, unknown>>;

/** Records every call that reaches the private canonical handler. */
function spyHandler(manager: unknown): { calls: Array<{ action: string; toolName: string; params: unknown }>; restore(): void } {
  const instance = manager as { executeAction: Handler };
  const original = instance.executeAction.bind(manager);
  const calls: Array<{ action: string; toolName: string; params: unknown }> = [];
  instance.executeAction = async (action, toolName, params, binding) => {
    calls.push({ action, toolName, params });
    return original(action, toolName, params, binding);
  };
  return { calls, restore: () => { instance.executeAction = original; } };
}

function controllerOf(fixture: ManagedToolFixture): BackgroundExecutionController {
  return (fixture.manager as unknown as { controller: BackgroundExecutionController }).controller;
}

/** The fixture owner's workspace (the manager's own cwd input). */
function workspaceOf(fixture: ManagedToolFixture): string {
  return (fixture.manager as unknown as { input: { cwd: () => string } }).input.cwd();
}

/** Counts calls to one real controller method without changing its behavior. */
function countControllerCalls(fixture: ManagedToolFixture, method: "continueTask" | "steer" | "interrupt" | "forceMerge" | "markClean" | "add"): { count(): number; restore(): void } {
  const controller = controllerOf(fixture) as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = controller[method]!;
  let calls = 0;
  controller[method] = function (this: unknown, ...args: unknown[]) {
    calls += 1;
    return original.apply(this, args);
  };
  return { count: () => calls, restore: () => { controller[method] = original; } };
}

/** Admits `params` for one call id and runs it through the shared definition. */
async function sharedCall(fixture: ManagedToolFixture, action: Lifecycle, toolCallId: string, params: unknown): Promise<Record<string, any>> {
  fixture.admission.admit(toolCallId, nameOf(action), params);
  return fixture.shared(action).invoke(call(toolCallId));
}

async function piCall(fixture: ManagedToolFixture, action: ExecutionToolAction, toolCallId: string, params: unknown): Promise<Record<string, any>> {
  return fixture.piExecute(nameOf(action))(toolCallId, params, undefined, undefined, {});
}

/** Starts one queued execute group through Pi and returns its handles. */
async function startQueued(fixture: ManagedToolFixture, toolCallId: string, ...titles: string[]): Promise<{ executionId: string; taskIds: string[] }> {
  const started = await piCall(fixture, "start", toolCallId, { tasks: titles.map(queuedTask) });
  assertManagedEnvelope(started, false, "setup start");
  const details = started.details as Record<string, any>;
  return { executionId: details.executionId, taskIds: details.tasks.map((task: Record<string, any>) => task.taskId) };
}

function taskRecord(fixture: ManagedToolFixture, executionId: string, taskId: string): Record<string, any> {
  const inspection = controllerOf(fixture).inspect(executionId, taskId) as unknown as Record<string, any>;
  return inspection.tasks[0];
}

/**
 * Parity between twin fixtures that ran the same script. Each owner's temp
 * paths, random handles, and digits are masked; text, structure, and error
 * state must otherwise match exactly.
 */
function maskTwin(value: unknown, fixture: ManagedToolFixture): string {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return JSON.stringify(value)
    .split(workspaceOf(fixture)).join("<workspace>")
    .replace(new RegExp(`${escape(tmpdir())}/[A-Za-z0-9._-]+`, "g"), "<tmp>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d+/g, "#");
}

test("the shared inventory is the canonical action list minus documented exclusions, and binding grants no new exposure", async () => {
  assert.deepEqual(LIFECYCLE, ["add", "continue", "steer", "interrupt"]);
  assert.deepEqual(UNBOUND, ["force_merge", "mark_clean"]);
  assert.deepEqual(SHARED_MANAGED_TOOL_ACTIONS, EXECUTION_TOOL_ACTIONS.filter((action) => !UNBOUND.includes(action)),
    "derived from the canonical order, not a second list");
  const fixture = await managedToolFixture();
  try {
    const registered = fixture.tools.length;
    const activations = fixture.activations.length;
    assert.deepEqual(fixture.tools.map((tool) => tool.name), SUBTASK_TOOL_NAMES);
    for (const action of LIFECYCLE) {
      const definition = fixture.shared(action);
      const tool = fixture.piTool(nameOf(action));
      assert.equal(definition.action, action);
      assert.equal(definition.name, nameOf(action));
      assert.equal(tool.executionMode, "sequential");
      assert.deepEqual(definition.parameters, tool.parameters, `${definition.name} schema`);
      assert.equal(definition.description, tool.description, `${definition.name} description`);
    }
    assert.deepEqual(Object.keys(fixture.piTool("SubtasksContinue").parameters.properties),
      ["executionId", "taskId", "bundle", "instructions", "instructionId", "inPlace"]);
    for (const [action, reason] of [
      ["force_merge", /after an owner restore can replace the next owner's same-root conflict gate/],
      ["mark_clean", /drop the next owner's same-root conflict gate/],
    ] as const) {
      assert.throws(() => fixture.manager.sharedManagedTool(action as never, fixture.admission),
        new RegExp(`^Error: ${nameOf(action)} is not available through the shared managed boundary: `), action);
      assert.throws(() => fixture.manager.sharedManagedTool(action as never, fixture.admission), reason, action);
      assert.throws(() => fixture.manager.sharedManagedTool(action as never, fixture.admission), /It remains available through Pi\.$/, action);
    }
    // Pi keeps both, unchanged.
    assert.equal(typeof fixture.piTool("SubtasksForceMerge").execute, "function");
    assert.deepEqual(Object.keys(fixture.piTool("SubtasksMarkClean").parameters.properties ?? {}), []);
    const piClean = await piCall(fixture, "mark_clean", "pi-clean", {});
    assertManagedEnvelope(piClean, false, "Pi MarkClean");
    assert.equal(piClean.content[0].text, "No workspace conflict gate is active.");
    assert.equal(fixture.tools.length, registered, "binding registers nothing");
    assert.equal(fixture.activations.length, activations, "binding activates nothing");
    for (const bogus of ["bogus", "SubtasksSteer", undefined]) {
      assert.throws(() => fixture.manager.sharedManagedTool(bogus as never, fixture.admission), /is not a shared managed tool action/);
    }
    assert.throws(() => fixture.manager.sharedManagedTool("steer", {} as never), /requires an owner admission resolver/);
  } finally {
    await fixture.dispose();
  }
});

test("admitted invalid requests get Pi's canonical validation errors for every lifecycle action", async () => {
  const fixture = await managedToolFixture();
  const spy = countControllerCalls(fixture, "continueTask");
  try {
    const cases: Array<[Lifecycle, unknown]> = [
      ["add", { executionId: "exec-x" }],
      ["add", { executionId: "exec-x", tasks: [] }],
      ["continue", { taskId: "task-x" }],
      ["continue", { taskId: "task-x", instructions: "go", bundle: { version: 2 } }],
      ["continue", { taskId: "task-x", instructions: "go", bundle: { version: 1, operationId: "op", waveId: "w", taskId: "task-x", waveRoot: "/x", expectedRevision: -1 } }],
      ["continue", { taskId: "task-x", instructions: "go", inPlace: "yes" }],
      ["steer", { instructions: "go" }],
      ["steer", { taskId: "task-x", instructions: "go", interrupt: "now" }],
      ["interrupt", { taskId: "task-x" }],
      ["interrupt", { taskId: "task-x", interruptMode: "bogus" }],
      // Validation precedes the shared interrupt_with_merge refusal.
      ["interrupt", { taskId: "task-x", interruptMode: "interrupt_with_merge", mergeAnyhow: true }],
      ["interrupt", "not an object"],
    ];
    for (const [index, [action, params]] of cases.entries()) {
      const name = nameOf(action);
      const viaPi = await piCall(fixture, action, `pi-${index}`, params);
      const viaShared = await sharedCall(fixture, action, `owner-${index}`, params);
      assertManagedEnvelope(viaShared, true, `${name} shared`);
      assert.match(viaPi.content[0].text, new RegExp(`^Invalid ${name} request: `), `${name} ${JSON.stringify(params)}`);
      assert.deepEqual(viaShared, viaPi, `${name} ${JSON.stringify(params)}`);
    }
    assert.equal(spy.count(), 0, "validation precedes the controller, including the shared refusals");
    assert.deepEqual(fixture.observedErrors, cases.map(([action], index) => [`pi-${index}`, nameOf(action)]),
      "only Pi feeds its returned-error observer");
  } finally {
    spy.restore();
    await fixture.dispose();
  }
});

test("authorization and admission refusals fail closed before the handler and change nothing", async () => {
  let liveAllowed = new Set(SUBTASK_TOOL_NAMES);
  const fixture = await managedToolFixture({ liveToolCallAllowed: (name) => liveAllowed.has(name) });
  const notLaunched = await managedToolFixture({ activeTools: ["read", "bash", "SubtasksStart", "SubtasksInspect", "SubtasksForceMerge", "SubtasksMarkClean"], liveToolCallAllowed: () => true });
  try {
    const { executionId, taskIds: [taskId] } = await startQueued(fixture, "setup", "AUTH-682");
    const params: Record<Lifecycle, unknown> = {
      add: { executionId, tasks: [queuedTask("must not add")] },
      continue: { executionId, taskId, instructions: "must not continue" },
      steer: { executionId, taskId, instructions: "must not steer" },
      interrupt: { executionId, taskId, interruptMode: "interrupt_as_failure" },
    };
    const throwing: ManagedToolAdmission = { resolveCall: () => { throw new Error("admission store unavailable"); } };
    for (const action of LIFECYCLE) {
      const name = nameOf(action);
      const other = LIFECYCLE.find((candidate) => candidate !== action)!;
      fixture.admission.admit(`other-tool-${action}`, nameOf(other), params[action]);
      fixture.admission.admit(`denied-${action}`, name, params[action]);
      notLaunched.admission.admit(`unlaunched-${action}`, name, params[action]);
      const refusals: Array<[string, () => Promise<Record<string, any>>, RegExp]> = [
        ["no admission", () => fixture.shared(action).invoke(call(`never-${action}`)), /no owner admission for this call and tool/],
        ["admitted for another tool", () => fixture.shared(action).invoke(call(`other-tool-${action}`)), /no owner admission for this call and tool/],
        ["throwing admission", () => fixture.shared(action, throwing).invoke(call(`denied-${action}`)), /owner call admission could not be verified/],
        ["missing call id", () => fixture.shared(action).invoke(call("")), /missing owner-assigned call id/],
        ["live policy denies", async () => {
          liveAllowed = new Set(SUBTASK_TOOL_NAMES.filter((candidate) => candidate !== name));
          try {
            return await fixture.shared(action).invoke(call(`denied-${action}`));
          } finally {
            liveAllowed = new Set(SUBTASK_TOOL_NAMES);
          }
        }, /not allowed by this owner's live call policy/],
        ["not allowed at launch", () => notLaunched.shared(action).invoke(call(`unlaunched-${action}`)), /not currently exposed by this owner/],
      ];
      for (const [label, invoke, pattern] of refusals) {
        const spy = spyHandler(label === "not allowed at launch" ? notLaunched.manager : fixture.manager);
        try {
          const refused = await invoke();
          assertManagedEnvelope(refused, true, `${name} ${label}`);
          assert.match(refused.content[0].text, new RegExp(`^${name} failed closed: `), `${name} ${label}`);
          assert.match(refused.content[0].text, pattern, `${name} ${label}`);
          assert.equal(spy.calls.length, 0, `${name} ${label} never reaches the handler`);
        } finally {
          spy.restore();
        }
      }
    }
    const task = taskRecord(fixture, executionId, taskId!);
    assert.equal(task.state, "queued", "no refused call changed the task");
    assert.equal((controllerOf(fixture).inspect(executionId) as unknown as Record<string, any>).tasks.length, 1, "no refused Add admitted a task");
    assert.deepEqual(fixture.observedErrors, []);
  } finally {
    await notLaunched.dispose();
    await fixture.dispose();
  }
});

test("canonical lifecycle outcomes match Pi call for call, with Pi's actor and instruction identity", async () => {
  const viaPi = await managedToolFixture();
  const viaShared = await managedToolFixture();
  try {
    type Step = [Lifecycle, string, (handles: { executionId: string; taskIds: string[] }) => unknown, boolean];
    const steps: Step[] = [
      ["add", "add-1", ({ executionId }) => ({ executionId, tasks: [queuedTask("LIFECYCLE-B")] }), false],
      ["steer", "steer-1", ({ executionId, taskIds }) => ({ executionId, taskId: taskIds[0], instructions: "refined scope" }), false],
      // Retrying the same instruction id is deduplicated by the controller.
      ["steer", "steer-retry", ({ executionId, taskIds }) => ({ executionId, taskId: taskIds[0], instructions: "refined scope", instructionId: "steer-1" }), false],
      ["continue", "continue-active", ({ executionId, taskIds }) => ({ executionId, taskId: taskIds[0], instructions: "continue now" }), true],
      ["interrupt", "interrupt-1", ({ executionId, taskIds }) => ({ executionId, taskId: taskIds[0], interruptMode: "interrupt_as_failure" }), false],
      // A retried interrupt instruction id is deduplicated too.
      ["interrupt", "interrupt-retry", ({ executionId, taskIds }) => ({ executionId, taskId: taskIds[0], interruptMode: "interrupt_as_failure", instructionId: "interrupt-1" }), false],
      ["continue", "continue-stopped", ({ executionId, taskIds }) => ({ executionId, taskId: taskIds[0], instructions: "resume" }), true],
    ];
    const piHandles = await startQueued(viaPi, "setup", "LIFECYCLE-A");
    const sharedHandles = await startQueued(viaShared, "setup", "LIFECYCLE-A");
    for (const [action, toolCallId, paramsFor, isError] of steps) {
      const piResult = await piCall(viaPi, action, toolCallId, paramsFor(piHandles));
      const sharedResult = await sharedCall(viaShared, action, toolCallId, paramsFor(sharedHandles));
      const label = `${nameOf(action)} ${toolCallId}`;
      assertManagedEnvelope(sharedResult, isError, label);
      assertManagedEnvelope(piResult, isError, label);
      assert.equal(maskTwin(sharedResult, viaShared), maskTwin(piResult, viaPi), label);
      if (isError) {
        assert.match(sharedResult.content[0].text, new RegExp(`^${nameOf(action)} failed: `), label);
        assert.ok(((sharedResult.details as Record<string, any>).executions as unknown[]).length <= 1, `${label} stays scoped`);
      }
    }
    // The shared calls changed the real controller exactly as Pi's did.
    for (const [fixture, handles] of [[viaPi, piHandles], [viaShared, sharedHandles]] as const) {
      const group = controllerOf(fixture).inspect(handles.executionId) as unknown as Record<string, any>;
      assert.deepEqual(group.tasks.map((task: Record<string, any>) => task.definition.title), ["LIFECYCLE-A", "LIFECYCLE-B"]);
      const task = taskRecord(fixture, handles.executionId, handles.taskIds[0]!);
      assert.notEqual(task.state, "queued", "interrupted as failure");
      const commands = (task.commands as Array<Record<string, any>>).map(({ instructionId, action, actor }) => [instructionId, action, actor]);
      assert.deepEqual(commands.filter(([, action]) => action === "steer"), [["steer-1", "steer", "model"]], "one steer despite the retry");
      assert.deepEqual(commands.filter(([, action]) => action === "interrupt"), [["interrupt-1", "interrupt", "model"]]);
    }
    assert.deepEqual(viaShared.observedErrors, []);
  } finally {
    await viaShared.dispose();
    await viaPi.dispose();
  }
});

test("another owner's handles fail as scoped unknown targets and never change or leak that owner's work", async () => {
  const owner = await managedToolFixture();
  const other = await managedToolFixture();
  try {
    const { executionId, taskIds: [taskId] } = await startQueued(owner, "setup", "OWNER-A-SECRET-682");
    await startQueued(other, "other-setup", "OWNER-B-682");
    // Durable state only: live queue timing advances on its own.
    const durable = () => JSON.stringify(controllerOf(owner).inspect(executionId), (key, value) => key === "timing" ? undefined : value);
    const before = durable();
    const requests: Array<[Lifecycle, unknown]> = [
      ["add", { executionId, tasks: [queuedTask("cross-owner add")] }],
      ["continue", { executionId, taskId, instructions: "cross-owner continue" }],
      ["continue", { taskId, instructions: "cross-owner continue by task id" }],
      ["continue", { executionId, taskId, instructions: "cross-owner in place", inPlace: true }],
      ["steer", { executionId, taskId, instructions: "cross-owner steer" }],
      ["steer", { taskId, instructions: "cross-owner steer by task id" }],
      ["interrupt", { executionId, taskId, interruptMode: "interrupt_as_failure" }],
      ["interrupt", { taskId, interruptMode: "interrupt_as_failure" }],
    ];
    for (const [index, [action, params]] of requests.entries()) {
      const label = `${nameOf(action)} ${JSON.stringify(params)}`;
      const refused = await sharedCall(other, action, `cross-${index}`, params);
      assertManagedEnvelope(refused, true, label);
      assert.match(refused.content[0].text, new RegExp(`^${nameOf(action)} failed: `), label);
      assert.match(refused.content[0].text, /Unknown execution group|Task target is unknown|Unknown task/, label);
      assert.doesNotMatch(JSON.stringify(refused), /OWNER-A-SECRET-682/, `${label} leaks nothing of the other owner`);
      const executions = (refused.details as Record<string, any>).executions as Array<Record<string, any>>;
      assert.ok(executions.every((execution) => execution.executionId !== executionId), `${label} replays no foreign execution`);
      // Pi on the same owner refuses identically: the scope is the controller's, not the boundary's.
      assert.equal(maskTwin(await piCall(other, action, `cross-${index}`, params), other), maskTwin(refused, other), `${label} Pi parity`);
    }
    assert.equal(durable(), before, "the first owner's work is unchanged");
  } finally {
    await other.dispose();
    await owner.dispose();
  }
});

test("shared Continue refuses explicit reattachment bundles before the recovery engine; Pi keeps its recovery path", async () => {
  const fixture = await managedToolFixture();
  try {
    const { executionId, taskIds: [taskId] } = await startQueued(fixture, "setup", "BUNDLE-682");
    const groupsBefore = fixture.groupCount();
    const associationsBefore = JSON.stringify(fixture.manager.associations());
    const bundleFor = (bundleTaskId: string) => ({
      version: 1,
      operationId: `op-foreign-${bundleTaskId}`,
      waveId: "wave-foreign",
      taskId: bundleTaskId,
      waveRoot: join(tmpdir(), "pi-review-foreign-wave-682-never-created"),
      expectedRevision: 0,
    });
    const requests: Array<[string, unknown]> = [
      ["unknown task (would reach operation adoption)", { instructions: "adopt", bundle: bundleFor("task-foreign-682") }],
      ["unknown task in a named execution", { executionId, instructions: "adopt", bundle: bundleFor("task-foreign-682") }],
      ["this owner's own task", { executionId, taskId, instructions: "reassociate", bundle: bundleFor(taskId!) }],
      ["in-place continuation", { executionId, taskId, instructions: "in place", inPlace: true, bundle: bundleFor(taskId!) }],
    ];
    for (const [index, [label, params]] of requests.entries()) {
      const continues = countControllerCalls(fixture, "continueTask");
      try {
        const refused = await sharedCall(fixture, "continue", `bundle-${index}`, params);
        assertManagedEnvelope(refused, true, label);
        assert.match(refused.content[0].text,
          /^SubtasksContinue failed closed: an explicit reattachment bundle is not admitted through the shared managed boundary/, label);
        assert.match(refused.content[0].text, /nothing was continued, adopted, or changed/, label);
        assert.deepEqual(refused.details, { action: "continue", diagnostic: "explicit reattachment bundle refused at the shared managed boundary" }, label);
        assert.equal(continues.count(), 0, `${label}: the controller never runs`);
        // Pi still hands the identical request to the unchanged recovery engine.
        const viaPi = await piCall(fixture, "continue", `pi-bundle-${index}`, params);
        assert.equal(continues.count(), 1, `${label}: Pi reaches the controller`);
        assertManagedEnvelope(viaPi, true, `${label} Pi`);
        assert.match(viaPi.content[0].text, /^SubtasksContinue failed: /, `${label} Pi`);
        assert.doesNotMatch(viaPi.content[0].text, /shared managed boundary/, `${label} Pi`);
      } finally {
        continues.restore();
      }
    }
    assert.equal(fixture.groupCount(), groupsBefore, "no execution was adopted");
    assert.equal(JSON.stringify(fixture.manager.associations()), associationsBefore, "no association changed");
    assert.equal(taskRecord(fixture, executionId, taskId!).state, "queued");
  } finally {
    await fixture.dispose();
  }
});

/** A conflict gate held by `holder`, restored onto `sourceRoot` (which may be another owner's workspace). */
async function restoreForeignGate(holder: ManagedToolFixture, sourceRoot: string, label: string, path: string): Promise<void> {
  await writeFile(join(sourceRoot, path), "<<<<<<< ours\nleft\n||||||| base\nbase\n=======\nright\n>>>>>>> theirs\n");
  await holder.manager.restoreAssociations({
    ...EMPTY_ASSOCIATIONS,
    conflictGates: [{
      executionId: `exec-${label}`,
      taskId: `task-${label}`,
      sourceRoot,
      paths: [path],
      activatedAt: new Date(0).toISOString(),
      manifestPath: join(sourceRoot, `${label}-manifest.json`),
      reason: `${label} landing conflict on task-${label}: ${path}`,
    }],
  } as never);
  assert.equal(holder.manager.associations().conflictGates?.length, 1, `${label} gate restored`);
}

test("with another owner's gate on this workspace, shared Interrupt never discloses, persists, or releases it", async () => {
  const foreign = await managedToolFixture();
  const owner = await managedToolFixture();
  try {
    const root = workspaceOf(owner);
    const { executionId, taskIds: [mergeTask, failTask] } = await startQueued(owner, "setup", "MERGE-682", "FAIL-682");
    await restoreForeignGate(foreign, root, "FOREIGN-GATE-SECRET-682", "foreign-secret-path.txt");
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, true, "the foreign gate blocks this owner's workspace");
    const secret = /FOREIGN-GATE-SECRET-682|foreign-secret-path/;
    // Durable state only: live queue timing advances on its own.
    const durable = (taskId: string) => JSON.stringify(taskRecord(owner, executionId, taskId), (key, value) => key === "timing" ? undefined : value);

    // interrupt_with_merge is refused before the controller, so its merge never
    // runs and nothing of the foreign gate is read, returned, or persisted.
    const interrupts = countControllerCalls(owner, "interrupt");
    try {
      const before = durable(mergeTask!);
      const refused = await sharedCall(owner, "interrupt", "merge-1", { executionId, taskId: mergeTask, interruptMode: "interrupt_with_merge" });
      assertManagedEnvelope(refused, true, "interrupt_with_merge");
      assert.match(refused.content[0].text, /^SubtasksInterrupt failed closed: interrupt_with_merge is not admitted through the shared managed boundary/);
      assert.match(refused.content[0].text, /nothing was interrupted, merged, or changed\. interrupt_as_failure remains available\.$/);
      assert.deepEqual(refused.details, { action: "interrupt", diagnostic: "interrupt_with_merge refused at the shared managed boundary" });
      assert.doesNotMatch(JSON.stringify(refused), secret);
      assert.equal(interrupts.count(), 0, "the controller never runs");
      assert.equal(durable(mergeTask!), before, "nothing was persisted");

      // ForceMerge cannot be bound, so it cannot reach that refusal either.
      assert.throws(() => owner.shared("force_merge" as never), /SubtasksForceMerge is not available through the shared managed boundary/);

      // interrupt_as_failure never consults the coordinator and stays bound.
      const stopped = await sharedCall(owner, "interrupt", "fail-1", { executionId, taskId: failTask, interruptMode: "interrupt_as_failure" });
      assertManagedEnvelope(stopped, false, "interrupt_as_failure");
      assert.equal(interrupts.count(), 1);
      assert.doesNotMatch(JSON.stringify(stopped), secret);
      assert.doesNotMatch(durable(failTask!), secret);
      assert.notEqual(taskRecord(owner, executionId, failTask!).state, "queued");

      // Pi still hands interrupt_with_merge to the unchanged controller.
      await piCall(owner, "interrupt", "pi-merge-1", { executionId, taskId: mergeTask, interruptMode: "interrupt_with_merge" });
      assert.equal(interrupts.count(), 2, "Pi reaches the controller");
    } finally {
      interrupts.restore();
    }
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, true, "no shared call released the foreign block");
    assert.equal(foreign.manager.associations().conflictGates?.length, 1, "the foreign gate is untouched");
  } finally {
    await owner.dispose();
    await foreign.dispose();
  }
});

test("two owners' gates on one workspace root: shared MarkClean stays unbound, so neither can release the other's block", async () => {
  const first = await managedToolFixture();
  const second = await managedToolFixture();
  try {
    const root = workspaceOf(second);
    await restoreForeignGate(first, root, "FIRST-682", "first.txt");
    await restoreForeignGate(second, root, "SECOND-682", "second.txt");
    // The second owner resolves its own conflict; the first owner's stays unresolved.
    await writeFile(join(root, "second.txt"), "resolved\n");
    for (const fixture of [first, second]) {
      assert.throws(() => fixture.shared("mark_clean" as never),
        /SubtasksMarkClean is not available through the shared managed boundary: .*drop the next owner's same-root conflict gate/);
    }
    assert.equal(sourceMutationCoordinator.blocked(root).blocked, true, "the root stays blocked");
    assert.equal(first.manager.associations().conflictGates?.length, 1);
    assert.equal(second.manager.associations().conflictGates?.length, 1);
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

test("a shared call whose owner scope closes while the handler runs returns only the fixed stale-scope result", async () => {
  const owner = await managedToolFixture();
  try {
    const root = workspaceOf(owner);
    const { executionId, taskIds: [taskId] } = await startQueued(owner, "setup", "SCOPE-682");
    const params = { executionId, taskId, instructions: "steer across a restore" };
    // The real handler runs, but only after the manager has restored the next
    // owner, whose conflict gate carries secrets (no engine override).
    const instance = owner.manager as unknown as { executeAction: Handler };
    const original = instance.executeAction.bind(owner.manager);
    let restored = false;
    instance.executeAction = async (action, toolName, handlerParams, binding) => {
      if (!restored) {
        restored = true;
        await restoreForeignGate(owner, root, "NEXT-OWNER-SECRET-682", "next-secret-path.txt");
      }
      return original(action, toolName, handlerParams, binding);
    };
    try {
      const stale = await sharedCall(owner, "steer", "steer-1", params);
      assert.deepEqual(stale, {
        content: [{
          type: "text",
          text: "SubtasksSteer failed closed: the owner session that bound this tool closed while the call was in flight, so its outcome is withheld from this session-scoped result. The call may already have changed that session's work; inspect it from its current session before retrying.",
        }],
        details: { action: "steer", diagnostic: "owner session closed while the call was in flight; outcome withheld" },
        isError: true,
      });
      // The withheld handler result would have carried the next owner's gate: Pi's identical call shows it.
      const viaPi = await piCall(owner, "steer", "pi-steer-1", params);
      assertManagedEnvelope(viaPi, true, "Pi after restore");
      assert.match(viaPi.content[0].text, /NEXT-OWNER-SECRET-682/);
    } finally {
      instance.executeAction = original;
    }
    assert.equal(owner.manager.associations().conflictGates?.length, 1, "the next owner's gate is untouched");
  } finally {
    await owner.dispose();
  }
});
