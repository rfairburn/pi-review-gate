/**
 * #682: native (Claude/Codex) managed subtask tools share Pi's canonical
 * wording. Callback capability changes what is delivered, never what the
 * tool cards or ordinary success results say.
 *
 * Verified here, in process, against the real manager and controller:
 * - The static pre-proof descriptor (an early MCP listing) carries exactly the
 *   name, description, and parameter schema Pi registers, for every action.
 * - A no-Pi host manager lists the same metadata as Pi in every callback
 *   state: no sink, a sink whose exact-run delivery-current proof (the
 *   owner's Watch live call policy) is false, throwing, or true, and a sink
 *   with no exposed proof.
 * - For identical facts, native Start, Add, and Watch success results are the
 *   same text as Pi's once only run-specific handles and digits are masked,
 *   except (#805) Start/Add when the owner has no delivery transport (no sink
 *   and no notifier) or Watch is exposed but its delivery proof refuses it:
 *   those state that notification delivery is unavailable instead of
 *   promising turns the conversation cannot receive.
 * - No native result or card carries a transport-specific callback caveat
 *   while delivery is available.
 * - Reading the callback state sends nothing.
 *
 * Fixture-owned catalog, policy, and admission. Queued tasks never dispatch
 * (`maxWorkers = 0`); no sink is ever called. No MCP transport, real owner,
 * delivery transport, or host-specific UI is covered.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager, sharedManagedToolDescriptor, type SharedManagedToolAction } from "../src/execution/tool";
import { EXECUTION_TOOL_ACTIONS, EXECUTION_TOOL_NAMES } from "../src/execution/tool-names";
import { notificationDeliveryUnavailableProse } from "../src/execution/subtask-notifications";
import { createState } from "../src/state";
import {
  EMPTY_ASSOCIATIONS,
  FixtureAdmission,
  SUBTASK_TOOL_NAMES,
  assertManagedEnvelope,
  managedToolFixture,
  queuedTask,
  type ManagedToolFixture,
  type SharedTool,
} from "./managed-tool-fixtures";

/** Transport-specific callback caveats retired by restoring shared wording. */
const RETIRED_NATIVE_CAVEATS = /Completion callbacks to this conversation|best effort|delivery to this conversation|will be attempted once|not guaranteed to start a turn|never retried/;

const call = (toolCallId: string) => ({ toolCallId });
const startParams = (title: string) => ({ tasks: [queuedTask(title)] });

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
  // Admission only: queued tasks never dispatch. Same config as the Pi fixture.
  config.execution!.maxWorkers = 0;
  return config;
}

interface NativeOptions {
  actions: SharedManagedToolAction[];
  /** Omitted: no callback sink at all. */
  sink?: true;
  /** A fallback host notifier (counted with sink calls); omitted: none. */
  notifier?: true;
  /** The exact-run delivery-current proof read through the Watch policy. */
  watchPolicy?: () => boolean;
}

interface NativeFixture {
  shared(action: SharedManagedToolAction): SharedTool;
  invoke(action: SharedManagedToolAction, toolCallId: string, params: unknown): Promise<Record<string, any>>;
  sinkCalls: number;
  dispose(): Promise<void>;
}

/** A trusted no-Pi host manager, built the way an owner builds it: construct, restore, sync. */
async function nativeFixture(options: NativeOptions): Promise<NativeFixture> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-review-native-callback-"));
  const fixture = { sinkCalls: 0 } as NativeFixture;
  const manager = new ExecutionToolManager({
    pi: undefined,
    config: fixtureConfig(),
    state: createState(),
    cwd: () => sourceRoot,
    authorizedTools: () => ["read", "bash"],
    liveToolCallAllowed: (name) => name === EXECUTION_TOOL_NAMES.watch
      ? (options.watchPolicy ?? (() => false))()
      : SUBTASK_TOOL_NAMES.includes(name),
    hostExposure: { actions: options.actions },
    ...(options.sink ? { nativeEventSink: async () => { fixture.sinkCalls += 1; } } : {}),
    ...(options.notifier ? { notify: () => { fixture.sinkCalls += 1; } } : {}),
  });
  await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
  manager.sync();
  const admission = new FixtureAdmission();
  const shared = (action: SharedManagedToolAction) => manager.sharedManagedTool(action, admission) as SharedTool;
  fixture.shared = shared;
  fixture.invoke = (action, toolCallId, params) => {
    admission.admit(toolCallId, EXECUTION_TOOL_NAMES[action], params);
    return shared(action).invoke(call(toolCallId));
  };
  fixture.dispose = async () => {
    const roots = manager.associations().groupRoots ?? [];
    await manager.shutdown();
    await manager.detach();
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  };
  return fixture;
}

/** Collects every run-specific handle (execution and task ids) in a result's details. */
function handles(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) handles(entry, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "executionId" || key === "taskId") && typeof entry === "string" && entry.length > 0) found.add(entry);
      else handles(entry, found);
    }
  }
  return found;
}

/** A result's text with run-specific handles and digits masked; wording must match exactly. */
function wording(result: Record<string, any>): string {
  let text = result.content[0].text as string;
  for (const handle of [...handles(result.details)].sort((a, b) => b.length - a.length)) text = text.split(handle).join("<handle>");
  return text.replace(/\d+/g, "#");
}

interface Results { start: Record<string, any>; add: Record<string, any>; watch?: Record<string, any> }

/** Starts one queued group, tops it off once, and optionally arms one Watch, with identical facts on either path. */
async function runCommon(
  invoke: (action: SharedManagedToolAction, toolCallId: string, params: unknown) => Promise<Record<string, any>>,
  withWatch: boolean,
): Promise<Results> {
  const start = await invoke("start", "parity-start", startParams("parity queued"));
  assertManagedEnvelope(start, false, "start");
  const executionId = (start.details as Record<string, any>).executionId as string;
  const add = await invoke("add", "parity-add", { executionId, tasks: [queuedTask("parity extra")] });
  assertManagedEnvelope(add, false, "add");
  if (!withWatch) return { start, add };
  const watch = await invoke("watch", "parity-watch", { executionId, after: "1h" });
  assertManagedEnvelope(watch, false, "watch");
  return { start, add, watch };
}

function piInvoke(fixture: ManagedToolFixture) {
  return (action: SharedManagedToolAction, toolCallId: string, params: unknown) => {
    fixture.admission.admit(toolCallId, EXECUTION_TOOL_NAMES[action], params);
    return fixture.shared(action).invoke(call(toolCallId));
  };
}

/** The Pi registration's common metadata for one action. */
function piMetadata(fixture: ManagedToolFixture, action: SharedManagedToolAction) {
  const tool = fixture.piTool(EXECUTION_TOOL_NAMES[action]);
  return { name: tool.name as string, description: tool.description as string, parameters: tool.parameters as Record<string, unknown> };
}

test("early MCP metadata is exactly Pi's registered name, description, and schema for every action", async () => {
  const pi = await managedToolFixture();
  try {
    for (const action of EXECUTION_TOOL_ACTIONS) {
      const descriptor = sharedManagedToolDescriptor(action);
      assert.deepEqual(
        { name: descriptor.name, description: descriptor.description, parameters: descriptor.parameters },
        piMetadata(pi, action),
        `${action}: early listing equals Pi`,
      );
      assert.doesNotMatch(descriptor.description, RETIRED_NATIVE_CAVEATS, `${action}: no transport-specific caveat`);
    }
  } finally {
    await pi.dispose();
  }
});

test("proved native metadata equals Pi in every callback state, and reading the state sends nothing", async () => {
  const pi = await managedToolFixture();
  const withWatch: SharedManagedToolAction[] = [...EXECUTION_TOOL_ACTIONS];
  const withoutWatch = withWatch.filter((action) => action !== "watch");
  const states: Array<{ label: string; options: NativeOptions }> = [
    { label: "no sink", options: { actions: withoutWatch } },
    { label: "sink, proof false", options: { actions: withWatch, sink: true, watchPolicy: () => false } },
    { label: "sink, proof throws", options: { actions: withWatch, sink: true, watchPolicy: () => { throw new Error("synthetic proof failure"); } } },
    { label: "sink, proof current", options: { actions: withWatch, sink: true, watchPolicy: () => true } },
    { label: "sink, no exposed proof", options: { actions: withoutWatch, sink: true, watchPolicy: () => true } },
  ];
  try {
    for (const { label, options } of states) {
      const native = await nativeFixture(options);
      try {
        for (const action of options.actions) {
          const { name, description, parameters } = native.shared(action);
          assert.deepEqual({ name, description, parameters }, piMetadata(pi, action), `${label} ${action}: proved listing equals Pi`);
          assert.deepEqual({ name, description, parameters }, sharedManagedToolDescriptor(action), `${label} ${action}: proved listing equals early listing`);
        }
        assert.equal(native.sinkCalls, 0, `${label}: listing sends nothing`);
      } finally {
        await native.dispose();
      }
    }
  } finally {
    await pi.dispose();
  }
});

test("for identical facts, native Start/Add/Watch results use Pi's ordinary wording in every callback state", async () => {
  const pi = await managedToolFixture();
  let expected: Results;
  try {
    expected = await runCommon(piInvoke(pi), true);
  } finally {
    await pi.dispose();
  }
  const piStart = wording(expected.start);
  const piAdd = wording(expected.add);
  const piWatch = wording(expected.watch!);
  assert.match(piStart, /Completion and meaningful state changes arrive as notifications/, "Pi Start keeps its notification guidance");
  assert.match(piWatch, /one checkpoint notification will trigger a turn\./, "Pi Watch keeps its arm wording");

  // #805: Start/Add must not promise notification turns when the owner has no
  // delivery transport at all (no sink, no notifier), or when Watch is exposed
  // but its exact-run delivery proof refuses it (or throws). Every other state,
  // including a notifier-only owner and a sink without an exposed proof, keeps
  // Pi's wording exactly.
  const unavailable = notificationDeliveryUnavailableProse();
  const states: Array<{ label: string; options: NativeOptions; watch: boolean; deliveryUnavailable?: true }> = [
    { label: "no sink, no notifier", options: { actions: ["start", "add", "inspect"] }, watch: false, deliveryUnavailable: true },
    { label: "no sink, no notifier, Watch exposed", options: { actions: ["start", "add", "inspect", "watch"], watchPolicy: () => true }, watch: false, deliveryUnavailable: true },
    { label: "notifier only", options: { actions: ["start", "add", "inspect"], notifier: true }, watch: false },
    { label: "sink, proof false", options: { actions: ["start", "add", "inspect", "watch"], sink: true, watchPolicy: () => false }, watch: false, deliveryUnavailable: true },
    {
      label: "sink, proof throws",
      options: { actions: ["start", "add", "inspect", "watch"], sink: true, watchPolicy: () => { throw new Error("proof unavailable"); } },
      watch: false,
      deliveryUnavailable: true,
    },
    { label: "sink, no exposed proof", options: { actions: ["start", "add", "inspect"], sink: true, watchPolicy: () => true }, watch: false },
    { label: "sink, proof current", options: { actions: ["start", "add", "inspect", "watch"], sink: true, watchPolicy: () => true }, watch: true },
  ];
  for (const { label, options, watch, deliveryUnavailable } of states) {
    const native = await nativeFixture(options);
    try {
      const results = await runCommon(native.invoke, watch);
      if (deliveryUnavailable) {
        for (const [name, result, pi] of [["Start", results.start, piStart], ["Add", results.add, piAdd]] as const) {
          const text = result.content[0].text as string;
          assert.ok(text.includes(unavailable), `${label}: ${name} says delivery is unavailable`);
          assert.doesNotMatch(text, /no need to poll|triggers a turn when it/, `${label}: ${name} promises no turn`);
          assert.notEqual(wording(result), pi, `${label}: ${name} differs from Pi only by the delivery contract`);
          // Everything before the contract is Pi's text: same acceptance, scheduler, and handles.
          const [piLead] = pi.split("Quiet notification mode is active:");
          assert.ok(wording(result).startsWith(piLead), `${label}: ${name} keeps Pi's lead`);
        }
      } else {
        assert.equal(wording(results.start), piStart, `${label}: Start wording equals Pi`);
        assert.equal(wording(results.add), piAdd, `${label}: Add wording equals Pi`);
        for (const result of Object.values(results)) {
          assert.doesNotMatch(result.content[0].text as string, RETIRED_NATIVE_CAVEATS, `${label}: no transport-specific caveat`);
        }
      }
      if (results.watch) assert.equal(wording(results.watch), piWatch, `${label}: Watch wording equals Pi`);
      assert.equal(native.sinkCalls, 0, `${label}: nothing was delivered while arming`);
    } finally {
      await native.dispose();
    }
  }
});

test("a native Watch the proof does not admit is still refused, with no wording change to the refusal path", async () => {
  const native = await nativeFixture({ actions: ["start", "add", "inspect", "watch"], sink: true, watchPolicy: () => false });
  try {
    const started = await native.invoke("start", "refused-start", startParams("refused queued"));
    assertManagedEnvelope(started, false, "start");
    const executionId = (started.details as Record<string, any>).executionId as string;
    const refused = await native.invoke("watch", "refused-watch", { executionId, after: "1h" });
    assertManagedEnvelope(refused, true, "watch refused");
    assert.doesNotMatch(refused.content[0].text as string, /SubtasksWatch armed/, "no arm acknowledgement");
    assert.equal(native.sinkCalls, 0);
  } finally {
    await native.dispose();
  }
});
