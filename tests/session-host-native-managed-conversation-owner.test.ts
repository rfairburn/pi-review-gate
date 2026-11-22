/**
 * #682: the production owner for one exact native managed conversation run
 * (`src/session-host/native-managed-conversation-owner.ts`).
 *
 * EVIDENCE SCOPE: the real owner composition — the real no-Pi
 * `ExecutionToolManager` and controller, the real owner association store and
 * restore handle, the real lane delegate, real saved settings files read by
 * `readPersistedReviewGateSnapshot`, and `resolveNativeWorkerToolCeiling` —
 * driven through hand-built lane contexts that carry one run-scope object the
 * test revokes. Only the installed Pi SDK the ceiling loads is a fake module
 * (the policy module's own test seam). Saved settings cannot hold the
 * test-only `maxWorkers = 0`, so an admitted task dispatches to the external
 * placeholder executor, a bounded keep-alive child, and stays active until teardown; assertions
 * use only admission, liveness, and durable association effects, and teardown
 * (the caller's custody) shuts each manager down. No InstanceManager, MCP
 * transport, provider, wake routing, or main.ts startup is exercised.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExecutionToolManager } from "../src/execution/tool";
import type { NativeMcpLaneContext, NativeMcpLaneRunScope } from "../src/session-host/instances";
import { readNativeManagedAssociations } from "../src/session-host/native-managed-association-store";
import {
  createNativeManagedConversationOwner,
  type NativeManagedConversationOwnerOptions,
} from "../src/session-host/native-managed-conversation-owner";
import type { NativeManagedToolOwnerIdentity } from "../src/session-host/native-managed-tool-delegate";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";
import { queuedTask } from "./managed-tool-fixtures";

const SCRATCH_PARENT = realpathSync(tmpdir());
const CONVERSATION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_CONVERSATION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const PI_EXECUTABLE = "/synthetic/pi/dist/cli.js";
const PI_VERSION = "9.9.9";
const STALE = /no current proved lane context/;
const startArgs = (title: string) => ({ tasks: [queuedTask(title)] });
const text = (result: { readonly content: readonly Record<string, unknown>[] } | undefined) => String(result?.content.map((item) => item.text).join("\n"));

type ControllerInternals = {
  groups: Map<string, { tasks: Array<{ taskId: string; definition: { executorToolCatalog?: { allowedToolCatalog: string[] } } }> }>;
  groupSettings: WeakMap<object, { maxCorrectionCycles: number }>;
  scopedModels: string[];
};
const controllerOf = (manager: ExecutionToolManager) => (manager as unknown as { controller: ControllerInternals }).controller;
const baseConfigOf = (manager: ExecutionToolManager) => (manager as unknown as { input: { config: { maxCorrectionCycles: number } } }).input.config;

function savedSettings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    // Bounds the placeholder executor turn; it stays active well past each test.
    executorTimeoutMs: 120_000,
    review: { activeReviewers: [] },
    externalAgents: {
      unstarted: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", "setTimeout(() => {}, 120_000)"] } },
    },
    execution: {
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    ...overrides,
  };
}

interface Env {
  stateRoot: string;
  workspace: string;
  agentDir: string;
  identity: NativeManagedToolOwnerIdentity;
  writeSettings(content: unknown): void;
  /** Fake installed SDK loads, in order, with their arguments. */
  sdkLoads: unknown[][];
  sdkFails: { value: boolean };
  run(): { run: NativeMcpLaneRunScope; revoke(): void };
  /** One request on a lane of `run`; `request.abort()` cancels only this request. */
  lane(run: NativeMcpLaneRunScope, overrides?: Partial<NativeManagedToolOwnerIdentity>): { context: NativeMcpLaneContext; abort(): void };
  owner(run: NativeMcpLaneRunScope, overrides?: Partial<NativeManagedConversationOwnerOptions>): ReturnType<typeof createNativeManagedConversationOwner>;
  /** Hands a manager to the test's teardown (the caller's lifecycle custody). */
  retain(manager: ExecutionToolManager | undefined): void;
}

function makeEnv(t: { after(fn: () => void | Promise<void>): void }): Env {
  const root = mkdtempSync(join(SCRATCH_PARENT, "prg-native-managed-conversation-owner-tests-"));
  const stateRoot = join(root, "session-host");
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(workspace);
  mkdirSync(agentDir);
  const managers = new Set<ExecutionToolManager>();
  t.after(async () => {
    const groupRoots = new Set<string>();
    for (const manager of managers) {
      const associations = manager.associations();
      for (const groupRoot of [...associations.groupRoots ?? [], ...associations.waveRoots]) groupRoots.add(groupRoot);
      await manager.shutdown().catch(() => undefined);
      await manager.detach().catch(() => undefined);
    }
    for (const groupRoot of groupRoots) await rm(groupRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const identity = Object.freeze({ rowId: "row-a", backend: "claude" as const, workspace, conversationId: CONVERSATION });
  const sdkLoads: unknown[][] = [];
  const sdkFails = { value: false };
  const env: Env = {
    stateRoot,
    workspace,
    agentDir,
    identity,
    sdkLoads,
    sdkFails,
    writeSettings: (content) => writeFileSync(join(agentDir, "review-gate.json"), typeof content === "string" ? content : JSON.stringify(content)),
    run: () => {
      const controller = new AbortController();
      let current = true;
      const run: NativeMcpLaneRunScope = Object.freeze({ signal: controller.signal, isCurrent: () => current && !controller.signal.aborted });
      return { run, revoke: () => { current = false; controller.abort(); } };
    },
    lane: (run, overrides = {}) => {
      const request = new AbortController();
      const signal = AbortSignal.any([request.signal, run.signal]);
      const context: NativeMcpLaneContext = Object.freeze({
        ...identity,
        ...overrides,
        signal,
        isCurrent: () => !signal.aborted && run.isCurrent(),
        run,
      });
      return { context, abort: () => request.abort() };
    },
    owner: (run, overrides = {}) => createNativeManagedConversationOwner({
      run,
      identity,
      stateRoot,
      settings: { env: {}, agentDir },
      pi: { executable: PI_EXECUTABLE, version: PI_VERSION, launchArgs: ["--offline"] },
      scopedModels: ["provider/model-a"],
      testHooks: {
        ceiling: {
          loadSdk: (...args: unknown[]) => {
            sdkLoads.push(args);
            if (sdkFails.value) throw new Error("synthetic SDK unavailable");
            return {
              parseArgs: (argv: string[]) => (argv.includes("--offline") ? { offline: true } : {}),
              createReadToolDefinition: () => ({ name: "read", description: "Read files." }),
              createBashToolDefinition: () => ({ name: "bash", description: "Execute a command." }),
            };
          },
          nativePowerShellSupported: () => false,
        },
      },
      ...overrides,
    }),
    retain: (manager) => { if (manager) managers.add(manager); },
  };
  return env;
}

const slotOwner = (env: Env, slotId = env.identity.rowId) =>
  ({ slotId, backend: env.identity.backend, conversationId: env.identity.conversationId, workspace: env.workspace });

async function readyOwner(env: Env, run: NativeMcpLaneRunScope) {
  const owner = env.owner(run);
  const result = await owner.prepare();
  if (result.status === "ready") env.retain(result.manager);
  else if ("retainedManager" in result) env.retain(result.retainedManager);
  assert.equal(result.status, "ready", JSON.stringify(result));
  return { owner, manager: (result as { manager: ExecutionToolManager }).manager };
}

test("one exact-run owner restores once, admits Start through the shared handler, persists under the row's slot, and restores in a new run", async (t) => {
  const env = makeEnv(t);
  env.writeSettings(savedSettings());
  const first = env.run();
  const { owner, manager } = await readyOwner(env, first.run);
  const again = await owner.prepare();
  assert.equal(again.status === "ready" && again.manager, manager, "prepare shares the one restore");
  assert.deepEqual(controllerOf(manager).scopedModels, ["provider/model-a"]);

  const lane = env.lane(first.run);
  assert.deepEqual((await owner.delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
  assert.equal(await owner.delegate.callTool(lane.context, { name: "SubtasksWatch", arguments: {} }), undefined, "Watch is not offered yet");

  const started = await owner.delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("owner start") });
  assert.equal(started?.isError, false, text(started));
  const fingerprint = toolCallFingerprint("SubtasksStart", startArgs("owner start"))!;
  const liveness = manager.startLiveness(fingerprint) as { state: string; identity?: string };
  assert.equal(liveness.state, "active");
  const executionId = liveness.identity!;
  const taskId = controllerOf(manager).groups.get(executionId)!.tasks[0]!.taskId;
  assert.match(text(started), new RegExp(executionId));
  const groupRoots = manager.associations().groupRoots ?? [];
  assert.equal(groupRoots.length, 1);

  // Durable under exactly this owner key: the row id is the slot id.
  const persisted = await readNativeManagedAssociations(env.stateRoot, slotOwner(env));
  assert.equal(persisted.status, "loaded");
  assert.deepEqual(persisted.status === "loaded" && persisted.associations.groupRoots, groupRoots);
  assert.equal((await readNativeManagedAssociations(env.stateRoot, slotOwner(env, "row-b"))).status, "absent");

  // Queue admission: an identical Start is the canonical duplicate, never replayed.
  const duplicate = await owner.delegate.callTool(lane.context, { name: "SubtasksStart", arguments: startArgs("owner start") });
  assert.equal(duplicate?.isError, true);
  assert.match(text(duplicate), /already active/);
  assert.equal(manager.associations().groupRoots?.length, 1);

  // Wrong owner: another run object with the same identity, or another identity on this run.
  const impostor = env.run();
  for (const context of [
    env.lane(impostor.run).context,
    env.lane(first.run, { conversationId: OTHER_CONVERSATION }).context,
    env.lane(first.run, { rowId: "row-b" }).context,
    env.lane(first.run, { backend: "codex" }).context,
  ]) {
    assert.deepEqual(await owner.delegate.listTools(context), []);
    assert.equal(await owner.delegate.callTool(context, { name: "SubtasksStart", arguments: startArgs("impostor") }), undefined);
  }
  assert.equal(manager.associations().groupRoots?.length, 1);

  // A request's abort refuses only that request; the owner and its work stay.
  const aborted = env.lane(first.run);
  aborted.abort();
  await assert.rejects(owner.delegate.callTool(aborted.context, { name: "SubtasksInspect", arguments: { taskId } }), STALE);
  const inspected = await owner.delegate.callTool(env.lane(first.run).context, { name: "SubtasksInspect", arguments: { taskId } });
  assert.equal(inspected?.isError, false, text(inspected));
  assert.match(text(inspected), new RegExp(taskId));

  // Steer and Continue reach the same owned task through the same canonical
  // handler: Steer queues its command; Continue on queued work is the
  // canonical refusal, and an explicit reattachment bundle stays refused.
  const ownedTask = controllerOf(manager).groups.get(executionId)!.tasks[0]! as unknown as { commands: Array<{ action: string; status: string }> };
  const steered = await owner.delegate.callTool(env.lane(first.run).context, { name: "SubtasksSteer", arguments: { executionId, taskId, instructions: "narrow scope" } });
  assert.equal(steered?.isError, false, text(steered));
  assert.deepEqual(ownedTask.commands.filter((command) => command.action === "steer").map((command) => command.status), ["queued"]);
  const continued = await owner.delegate.callTool(env.lane(first.run).context, { name: "SubtasksContinue", arguments: { executionId, taskId, instructions: "resume" } });
  assert.equal(continued?.isError, true);
  assert.match(text(continued), /already active/);
  const bundled = await owner.delegate.callTool(env.lane(first.run).context, {
    name: "SubtasksContinue",
    arguments: { executionId, taskId, instructions: "resume", bundle: { version: 1, operationId: "op", waveId: "wave", taskId, waveRoot: env.workspace, expectedRevision: 0 } },
  });
  assert.equal(bundled?.isError, true);
  assert.match(text(bundled), /explicit reattachment bundle is not admitted/);
  assert.equal(ownedTask.commands.some((command) => command.action === "continue"), false);
  assert.equal(await owner.delegate.callTool(env.lane(impostor.run).context, { name: "SubtasksSteer", arguments: { executionId, taskId, instructions: "impostor" } }), undefined);
  assert.equal(ownedTask.commands.filter((command) => command.action === "steer").length, 1, "the impostor run steered nothing");

  // Revoking the run ends exposure but neither cancels nor detaches: the manager is retained for the caller.
  first.revoke();
  const stale = await owner.prepare();
  assert.equal(stale.status, "stale");
  assert.equal(stale.status === "stale" && stale.retainedManager, manager);
  assert.equal((manager.startLiveness(fingerprint) as { state: string }).state, "active", "admitted work was not cancelled");
  assert.deepEqual(manager.associations().groupRoots, groupRoots);

  // The caller retires the old manager (its lifecycle decision): it stops and
  // awaits its work before detaching, then a new run restores the owner.
  await manager.shutdown();
  await manager.detach();
  const second = env.run();
  const restored = await readyOwner(env, second.run);
  assert.notEqual(restored.manager, manager);
  assert.deepEqual(restored.manager.associations().groupRoots, groupRoots);
  const reinspected = await restored.owner.delegate.callTool(env.lane(second.run).context, { name: "SubtasksInspect", arguments: { taskId } });
  assert.equal(reinspected?.isError, false, text(reinspected));
  assert.match(text(reinspected), new RegExp(taskId));
  // The first run's lane never reaches the new owner.
  assert.deepEqual(await restored.owner.delegate.listTools(env.lane(impostor.run).context), []);
});

test("each Start reads one fresh saved snapshot and its ceiling; earlier groups and the base keep theirs", async (t) => {
  const env = makeEnv(t);
  env.writeSettings(savedSettings({ maxCorrectionCycles: 3, web: { enabled: false } }));
  const { run } = env.run();
  const { owner, manager } = await readyOwner(env, run);
  assert.equal(env.sdkLoads.length, 0, "construction and restore compute no ceiling");
  assert.deepEqual((await owner.delegate.listTools(env.lane(run).context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
  assert.equal(env.sdkLoads.length, 0, "discovery reads no Start settings");

  const first = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksStart", arguments: startArgs("first") });
  assert.equal(first?.isError, false, text(first));
  env.writeSettings(savedSettings({ maxCorrectionCycles: 7, web: { enabled: true } }));
  const second = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksStart", arguments: startArgs("second") });
  assert.equal(second?.isError, false, text(second));
  assert.deepEqual(env.sdkLoads, [[PI_EXECUTABLE, PI_VERSION], [PI_EXECUTABLE, PI_VERSION]], "one ceiling per admitted Start, from the host's Pi facts");

  const controller = controllerOf(manager);
  const groupOf = (title: string) => {
    const identity = (manager.startLiveness(toolCallFingerprint("SubtasksStart", startArgs(title))!) as { identity: string }).identity;
    return controller.groups.get(identity)!;
  };
  const firstGroup = groupOf("first");
  const secondGroup = groupOf("second");
  assert.equal(controller.groupSettings.get(firstGroup)?.maxCorrectionCycles, 3, "the earlier group keeps its snapshot");
  assert.equal(controller.groupSettings.get(secondGroup)?.maxCorrectionCycles, 7, "the later Start pinned the fresh snapshot");
  const firstCeiling = firstGroup.tasks[0]!.definition.executorToolCatalog!.allowedToolCatalog;
  const secondCeiling = secondGroup.tasks[0]!.definition.executorToolCatalog!.allowedToolCatalog;
  assert.ok(firstCeiling.includes("read") && firstCeiling.includes("bash"));
  assert.ok(!firstCeiling.includes("WebFetch"), "web off in the first snapshot withholds web tools");
  assert.ok(secondCeiling.includes("WebFetch"), "web on in the fresh snapshot makes them eligible");
  assert.ok(!secondCeiling.includes("SubtasksStart"), "no host-only control is handed down");
  assert.equal(baseConfigOf(manager).maxCorrectionCycles, 3, "the base snapshot is never rewritten");
});

test("disabled or unreadable settings fail closed at construction and at each Start", async (t) => {
  const env = makeEnv(t);

  // Kill switch: nothing is constructed, restored, persisted, or exposed.
  env.writeSettings(savedSettings());
  const disabledRun = env.run();
  const disabled = env.owner(disabledRun.run, { settings: { env: { PI_REVIEW_GATE_DISABLED: "1" }, agentDir: env.agentDir } });
  const disabledResult = await disabled.prepare();
  assert.deepEqual(disabledResult, { status: "failed", reason: "manager-construction-failed" });
  assert.deepEqual(await disabled.delegate.listTools(env.lane(disabledRun.run).context), []);
  assert.equal((await readNativeManagedAssociations(env.stateRoot, slotOwner(env))).status, "absent");

  // No saved settings at all: the same.
  rmSync(join(env.agentDir, "review-gate.json"));
  const missing = env.owner(env.run().run, { settings: { env: {}, agentDir: env.agentDir, resolvedHomeDir: env.agentDir } });
  assert.deepEqual(await missing.prepare(), { status: "failed", reason: "manager-construction-failed" });

  // Ready owner, then the saved file becomes unreadable: Start is refused before any group exists.
  env.writeSettings(savedSettings());
  const { run } = env.run();
  const { owner, manager } = await readyOwner(env, run);
  env.writeSettings("{ not json");
  const unreadable = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksStart", arguments: startArgs("unreadable") });
  assert.equal(unreadable?.isError, true);
  assert.match(text(unreadable), /Start settings for this request could not be read; nothing was started/);
  assert.equal(env.sdkLoads.length, 0, "no ceiling without a snapshot");

  // A readable snapshot whose ceiling is refused is refused the same way.
  env.writeSettings(savedSettings());
  env.sdkFails.value = true;
  const refused = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksStart", arguments: startArgs("refused ceiling") });
  assert.equal(refused?.isError, true);
  assert.match(text(refused), /could not be read; nothing was started/);
  assert.equal(env.sdkLoads.length, 1);
  assert.deepEqual(manager.associations().groupRoots, []);
  assert.equal((await readNativeManagedAssociations(env.stateRoot, slotOwner(env))).status, "absent", "nothing was persisted");

  // Inspect never reads Start settings and stays available.
  const inspect = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksInspect", arguments: { taskId: "task-unknown" } });
  assert.notEqual(inspect, undefined);
  assert.equal(env.sdkLoads.length, 1);

  // Once the settings recover: the next Start reads them fresh and is admitted.
  env.sdkFails.value = false;
  const recovered = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksStart", arguments: startArgs("recovered") });
  assert.equal(recovered?.isError, false, text(recovered));
});

test("a run revoked while prepare resumes is reported stale with the manager retained, never ready", async (t) => {
  const env = makeEnv(t);
  env.writeSettings(savedSettings());
  const { run, revoke } = env.run();
  const { owner, manager } = await readyOwner(env, run);
  const pending = owner.prepare();
  queueMicrotask(revoke);
  const result = await pending;
  assert.equal(result.status, "stale", JSON.stringify(result));
  assert.equal(result.status === "stale" && result.retainedManager, manager);
  // Neither cancelled nor detached: the manager's owner scope still binds.
  assert.doesNotThrow(() => manager.sharedManagedTool("inspect", { resolveCall: () => undefined }));
  const later = await owner.prepare();
  assert.equal(later.status, "stale");
});

test("settings that route work to Pi workers are refused: no ambient Pi launch for a host-admitted executable", async (t) => {
  const env = makeEnv(t);
  const withPiWorker = savedSettings({
    execution: {
      workerResources: {
        default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 },
        local: { selection: { source: "pi", model: "provider/model-a" }, maxConcurrent: 1 },
      },
      routes: { execute: [{ resourceId: "local" }, { resourceId: "default" }], research: [] },
    },
  });

  // As the base snapshot: nothing is constructed, restored, persisted, or exposed.
  env.writeSettings(withPiWorker);
  const refusedRun = env.run();
  const refused = env.owner(refusedRun.run);
  assert.deepEqual(await refused.prepare(), { status: "failed", reason: "manager-construction-failed" });
  assert.deepEqual(await refused.delegate.listTools(env.lane(refusedRun.run).context), []);

  // As a later Start snapshot: refused before any ceiling, group, or launch.
  env.writeSettings(savedSettings());
  const { run } = env.run();
  const { owner, manager } = await readyOwner(env, run);
  env.writeSettings(withPiWorker);
  const start = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksStart", arguments: startArgs("pi-backed") });
  assert.equal(start?.isError, true);
  assert.match(text(start), /nothing was started/);
  assert.equal(env.sdkLoads.length, 0, "no ceiling is computed for a refused snapshot");
  assert.deepEqual(manager.associations().groupRoots, []);
  assert.equal((await readNativeManagedAssociations(env.stateRoot, slotOwner(env))).status, "absent");
});

test("each Add reads one fresh saved snapshot and its ceiling for its new tasks only; refused, stale, or foreign Adds add nothing", async (t) => {
  const env = makeEnv(t);
  env.writeSettings(savedSettings({ maxCorrectionCycles: 3, web: { enabled: false } }));
  const { run, revoke } = env.run();
  const { owner, manager } = await readyOwner(env, run);
  const started = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksStart", arguments: startArgs("original") });
  assert.equal(started?.isError, false, text(started));
  const executionId = (manager.startLiveness(toolCallFingerprint("SubtasksStart", startArgs("original"))!) as { identity: string }).identity;
  const controller = controllerOf(manager);
  const group = controller.groups.get(executionId)!;
  const originalCatalog = [...group.tasks[0]!.definition.executorToolCatalog!.allowedToolCatalog];
  const addArgs = (title: string) => ({ executionId, tasks: [queuedTask(title)] });
  const catalogOf = (taskId: string) => group.tasks.find((task) => task.taskId === taskId)!.definition.executorToolCatalog!.allowedToolCatalog;
  /** The one task the call attached (from the controller), whose stable handle the lane result must carry. */
  const newTaskId = (result: Awaited<ReturnType<typeof owner.delegate.callTool>>, known: readonly string[]) => {
    const ids = group.tasks.map((task) => task.taskId).filter((id) => !known.includes(id));
    assert.equal(ids.length, 1, text(result));
    assert.ok(text(result).includes(ids[0]!), "the new stable task handle reaches the lane result");
    return ids[0]!;
  };

  // Fresh policy: web enabled and bash denied to executors after the Start.
  env.writeSettings(savedSettings({ maxCorrectionCycles: 7, web: { enabled: true }, tools: { executorDeny: ["bash"] } }));
  const loadsBefore = env.sdkLoads.length;
  const added = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksAdd", arguments: addArgs("fresh") });
  assert.equal(added?.isError, false, text(added));
  assert.equal(env.sdkLoads.length, loadsBefore + 1, "one ceiling for the admitted Add, from the host's Pi facts");
  const freshId = newTaskId(added, [group.tasks[0]!.taskId]);
  // Captured-catalog evidence only: the placeholder `run-as-binary` worker does
  // not consume the catalog, and external worker runtime permissions remain
  // governed by their adapters.
  assert.ok(catalogOf(freshId).includes("WebFetch"), "the captured catalog follows the fresh snapshot's ceiling");
  assert.ok(!catalogOf(freshId).includes("bash"), "the captured catalog follows the fresh executor deny list");
  assert.ok(!catalogOf(freshId).includes("SubtasksStart"), "no host-only control is handed down");
  assert.deepEqual(group.tasks[0]!.definition.executorToolCatalog!.allowedToolCatalog, originalCatalog, "the earlier task is unchanged");
  assert.equal(controller.groupSettings.get(group)?.maxCorrectionCycles, 3, "the group keeps its Start snapshot");
  assert.equal(baseConfigOf(manager).maxCorrectionCycles, 3, "the owner's base is never rewritten");
  // The new task is part of the owner's durable association (same group root).
  const persisted = await readNativeManagedAssociations(env.stateRoot, slotOwner(env));
  assert.deepEqual(persisted.status === "loaded" && persisted.associations.groupRoots, manager.associations().groupRoots);

  // Revocation in saved settings applies to the next Add's captured catalog.
  env.writeSettings(savedSettings({ web: { enabled: false } }));
  const revoked = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksAdd", arguments: addArgs("revoked web") });
  assert.equal(revoked?.isError, false, text(revoked));
  const revokedId = newTaskId(revoked, [group.tasks[0]!.taskId, freshId]);
  assert.ok(!catalogOf(revokedId).includes("WebFetch"), "web is absent from the later task's captured catalog");
  assert.ok(catalogOf(freshId).includes("WebFetch"), "the earlier top-off keeps the catalog it was admitted with");
  const count = group.tasks.length;

  // Unreadable, disabled-ceiling, or Pi-routed settings refuse the Add before any task.
  env.writeSettings("{ not json");
  const unreadable = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksAdd", arguments: addArgs("unreadable") });
  assert.equal(unreadable?.isError, true);
  assert.match(text(unreadable), /Add settings for this request could not be read/);
  env.writeSettings(savedSettings({
    execution: {
      workerResources: { local: { selection: { source: "pi", model: "provider/model-a" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "local" }], research: [] },
    },
  }));
  const piRouted = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksAdd", arguments: addArgs("pi-routed") });
  assert.equal(piRouted?.isError, true);
  // A saved route revocation for the group's kind refuses new work; the group's pinned route is untouched.
  env.writeSettings(savedSettings({
    execution: {
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [], research: [] },
    },
  }));
  const pinnedSettings = controller.groupSettings.get(group);
  const unrouted = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksAdd", arguments: addArgs("unrouted") });
  assert.equal(unrouted?.isError, true, text(unrouted));
  assert.match(text(unrouted), /No execute worker route is configured in the current settings; no tasks were added/);
  assert.equal(controller.groupSettings.get(group), pinnedSettings);
  env.writeSettings(savedSettings());
  env.sdkFails.value = true;
  const noCeiling = await owner.delegate.callTool(env.lane(run).context, { name: "SubtasksAdd", arguments: addArgs("no ceiling") });
  assert.equal(noCeiling?.isError, true);
  env.sdkFails.value = false;
  assert.equal(group.tasks.length, count, "no refused Add attached a task");

  // Another run or conversation reaches nothing; a revoked run adds nothing.
  const impostor = env.run();
  assert.equal(await owner.delegate.callTool(env.lane(impostor.run).context, { name: "SubtasksAdd", arguments: addArgs("impostor") }), undefined);
  assert.equal(await owner.delegate.callTool(env.lane(run, { conversationId: OTHER_CONVERSATION }).context, { name: "SubtasksAdd", arguments: addArgs("other") }), undefined);
  const lane = env.lane(run);
  revoke();
  await assert.rejects(owner.delegate.callTool(lane.context, { name: "SubtasksAdd", arguments: addArgs("after revoke") }), STALE);
  assert.equal(group.tasks.length, count);
});
