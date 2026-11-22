/**
 * #682: native Start/Add descriptions and direct results describe completion
 * callback delivery truthfully, and Pi keeps its wording.
 *
 * Verified here, in process, against the real manager and controller:
 * - The static pre-proof descriptor (no conversation context) appends a
 *   conservative note to Start and Add only: no callback or turn is promised
 *   and SubtasksInspect is named. Every other action keeps Pi's description.
 * - A no-Pi host manager with no callback sink lists and returns
 *   "currently unavailable" wording.
 * - A sink alone is not proof: with the exact-run delivery-current proof (the
 *   owner's Watch live call policy) false or throwing, the manager still says
 *   unavailable; with it true, it says best effort (one attempt that may be
 *   declined or left unconfirmed, never retried, no guaranteed turn).
 * - A sink without any exposed proof keeps the conservative unknown wording.
 * - Every native variant points to SubtasksInspect and never claims that
 *   notifications arrive or trigger turns.
 * - A Pi manager's registered and shared descriptions and its Start/Add
 *   results keep the existing notification contract unchanged.
 *
 * Fixture-owned catalog, policy, and admission. Queued tasks never dispatch
 * (`maxWorkers = 0`); no sink is ever called. No MCP transport, real owner,
 * or delivery transport is covered.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager, sharedManagedToolDescriptor, type SharedManagedToolAction } from "../src/execution/tool";
import { EXECUTION_TOOL_ACTIONS, EXECUTION_TOOL_NAMES } from "../src/execution/tool-names";
import { createState } from "../src/state";
import {
  EMPTY_ASSOCIATIONS,
  FixtureAdmission,
  SUBTASK_TOOL_NAMES,
  assertManagedEnvelope,
  managedToolFixture,
  queuedTask,
  type SharedTool,
} from "./managed-tool-fixtures";

const PI_START_DESCRIPTION = "Start 1–128 durable background execute, research, or in-place subtasks — optionally selecting an existing authorized checkout/worktree (execute) or any directory the workers write in directly (inplace) via workspace — and return stable handles immediately.";
const PI_ADD_DESCRIPTION = "Add 1–128 durable background subtasks to an existing execution so freed capacity can be topped off.";
const PI_NOTIFICATION_PROSE = "Internal progress stays available in SubtasksInspect and /subtasks-view without triggering turns. Completion and meaningful state changes arrive as notifications, so there is no need to poll for them; continue other useful work or yield.";

const BEST_EFFORT = /Completion callbacks to this conversation are currently supported only as best effort: each completion, failure, conflict, recovery, or eligible state event gets one delivery attempt that may be declined or left unconfirmed, is never retried, and is not guaranteed to start a turn\./;
const UNAVAILABLE = /Completion callbacks to this conversation are currently unavailable: do not expect a completion or state callback here; use SubtasksInspect for durable state/;
const UNKNOWN = /Completion callbacks to this conversation are not guaranteed: /;

const call = (toolCallId: string) => ({ toolCallId });
const startParams = (title: string) => ({ tasks: [queuedTask(title)] });

/** No native Start/Add wording may promise a delivered notification or a turn. */
function assertNoGuaranteedTurn(text: string, label: string): void {
  assert.match(text, /SubtasksInspect/, `${label}: names the durable fallback`);
  assert.doesNotMatch(text, /arrive as notifications/, `${label}: no arrival promise`);
  assert.doesNotMatch(text, /trigger/i, `${label}: no turn promise`);
  assert.doesNotMatch(text, /notification mode is active/, `${label}: no Pi notification contract`);
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
  // Admission only: queued tasks never dispatch.
  config.execution!.maxWorkers = 0;
  return config;
}

interface NativeOptions {
  actions: SharedManagedToolAction[];
  /** Omitted: no callback sink at all. */
  sink?: true;
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

/** Starts one queued group and tops it off once; returns both result texts. */
async function startAndAdd(fixture: NativeFixture, label: string): Promise<{ start: string; add: string }> {
  const started = await fixture.invoke("start", `${label}-start`, startParams(`${label} queued`));
  assertManagedEnvelope(started, false, `${label} start`);
  const executionId = (started.details as Record<string, any>).executionId as string;
  const added = await fixture.invoke("add", `${label}-add`, { executionId, tasks: [queuedTask(`${label} extra`)] });
  assertManagedEnvelope(added, false, `${label} add`);
  return { start: started.content[0].text as string, add: added.content[0].text as string };
}

test("static pre-proof Start/Add metadata never promises a callback or turn and names SubtasksInspect", () => {
  for (const action of EXECUTION_TOOL_ACTIONS) {
    const { description } = sharedManagedToolDescriptor(action);
    if (action === "start" || action === "add") {
      const pi = action === "start" ? PI_START_DESCRIPTION : PI_ADD_DESCRIPTION;
      assert.ok(description.startsWith(`${pi} `), `${action}: keeps Pi's description first`);
      assert.match(description, UNKNOWN, `${action}: conservative note`);
      assert.match(description, /may be declined or left unconfirmed and never guarantees a turn\. Use SubtasksInspect for durable state\.$/);
      assert.doesNotMatch(description, /currently supported|currently unavailable/, `${action}: claims no capability without context`);
      assertNoGuaranteedTurn(description, `static ${action}`);
    } else {
      assert.doesNotMatch(description, /Completion callbacks/, `${action}: unchanged`);
    }
  }
});

test("a native manager without a callback sink lists and returns unavailable wording", async () => {
  const fixture = await nativeFixture({ actions: ["start", "add", "inspect"] });
  try {
    for (const action of ["start", "add"] as const) {
      const { description } = fixture.shared(action);
      assert.match(description, UNAVAILABLE, `${action} description`);
      assertNoGuaranteedTurn(description, `${action} description`);
    }
    assert.equal(fixture.shared("inspect").description, sharedManagedToolDescriptor("inspect").description, "other actions unchanged");
    const { start, add } = await startAndAdd(fixture, "no-sink");
    for (const [label, text] of [["start", start], ["add", add]] as const) {
      assert.match(text, UNAVAILABLE, `${label} result`);
      assert.match(text, /use SubtasksInspect for durable state and outcomes\./, `${label} result`);
      assertNoGuaranteedTurn(text, `${label} result`);
      assert.match(text, /Queued state and stable task handles are included below\./, `${label}: acceptance facts kept`);
    }
  } finally {
    await fixture.dispose();
  }
});

test("a sink is not proof: the exact-run delivery-current proof decides best effort versus unavailable", async () => {
  let current: boolean | "throw" = false;
  const fixture = await nativeFixture({
    actions: ["start", "add", "inspect", "watch"],
    sink: true,
    watchPolicy: () => {
      if (current === "throw") throw new Error("synthetic proof failure");
      return current;
    },
  });
  try {
    for (const state of [false, "throw"] as const) {
      current = state;
      for (const action of ["start", "add"] as const) {
        assert.match(fixture.shared(action).description, UNAVAILABLE, `${String(state)} ${action} description`);
      }
      const { start, add } = await startAndAdd(fixture, `sink-${String(state)}`);
      for (const text of [start, add]) {
        assert.match(text, UNAVAILABLE, String(state));
        assertNoGuaranteedTurn(text, String(state));
      }
    }

    current = true;
    for (const action of ["start", "add"] as const) {
      const { description } = fixture.shared(action);
      assert.match(description, BEST_EFFORT, `${action} description`);
      assert.match(description, /SubtasksInspect remains the durable source of state, including when no callback arrives\.$/);
      assertNoGuaranteedTurn(description, `${action} description`);
    }
    assert.equal(fixture.shared("watch").description, sharedManagedToolDescriptor("watch").description, "Watch keeps its description");
    const { start, add } = await startAndAdd(fixture, "sink-current");
    for (const [label, text] of [["start", start], ["add", add]] as const) {
      assert.match(text, BEST_EFFORT, `${label} result`);
      assert.match(text, /SubtasksInspect remains the durable source of state; use it to confirm outcomes, including when no callback arrives\./, `${label} result`);
      assertNoGuaranteedTurn(text, `${label} result`);
    }

    // Each binding re-reads the proof; a definition keeps what it listed.
    const bound = fixture.shared("start");
    current = false;
    assert.match(bound.description, BEST_EFFORT, "a bound definition keeps its binding-time listing");
    assert.match(fixture.shared("start").description, UNAVAILABLE, "a fresh binding re-proves");
    assert.equal(fixture.sinkCalls, 0, "reading the proof sends nothing");
  } finally {
    await fixture.dispose();
  }
});

test("a sink without an exposed delivery proof keeps the conservative unknown wording", async () => {
  const fixture = await nativeFixture({ actions: ["start", "add", "inspect"], sink: true, watchPolicy: () => true });
  try {
    for (const action of ["start", "add"] as const) {
      assert.equal(fixture.shared(action).description, sharedManagedToolDescriptor(action).description, `${action}: same as static`);
    }
    const { start, add } = await startAndAdd(fixture, "sink-unproved");
    for (const text of [start, add]) {
      assert.match(text, UNKNOWN);
      assert.match(text, /no delivery to it could be confirmed as currently supported/);
      assert.doesNotMatch(text, /currently supported only as best effort|currently unavailable/);
      assertNoGuaranteedTurn(text, "unknown");
    }
  } finally {
    await fixture.dispose();
  }
});

test("Pi descriptions and Start/Add results keep the existing notification contract", async () => {
  const fixture = await managedToolFixture();
  try {
    for (const [action, expected] of [["start", PI_START_DESCRIPTION], ["add", PI_ADD_DESCRIPTION]] as const) {
      const name = EXECUTION_TOOL_NAMES[action];
      assert.equal(fixture.piTool(name).description, expected, `${name} Pi registration`);
      assert.equal(fixture.shared(action).description, expected, `${name} Pi shared binding`);
    }
    const params = startParams("pi queued");
    fixture.admission.admit("pi-start", "SubtasksStart", params);
    const started = await fixture.shared("start").invoke(call("pi-start"));
    assertManagedEnvelope(started, false, "Pi start");
    const executionId = (started.details as Record<string, any>).executionId as string;
    const addParams = { executionId, tasks: [queuedTask("pi extra")] };
    fixture.admission.admit("pi-add", "SubtasksAdd", addParams);
    const added = await fixture.shared("add").invoke(call("pi-add"));
    assertManagedEnvelope(added, false, "Pi add");
    for (const [label, text] of [["start", started.content[0].text], ["add", added.content[0].text]] as const) {
      assert.match(text, /Quiet notification mode is active: .*Every task still triggers a turn when it lands, fails, conflicts, or requires recovery/, `${label}: Pi contract`);
      assert.ok(text.includes(PI_NOTIFICATION_PROSE), `${label}: Pi prose`);
      assert.doesNotMatch(text, /Completion callbacks to this conversation/, `${label}: no native note`);
    }
  } finally {
    await fixture.dispose();
  }
});
