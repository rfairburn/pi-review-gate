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
  assert.deepEqual((await owner.delegate.listTools(lane.context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
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
  assert.deepEqual((await owner.delegate.listTools(env.lane(run).context)).map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
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
