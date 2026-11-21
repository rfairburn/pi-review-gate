/**
 * #682 slice 1: one canonical handler for SubtasksStart and SubtasksInspect.
 * Pi registration calls it now, and a trusted second adapter can bind it
 * through `ExecutionToolManager.sharedManagedTool`.
 *
 * Verified here, in process, against the real manager and controller (see
 * ./managed-tool-fixtures.ts for what is faked):
 * - Pi registration, order, activation, and schemas are unchanged, and the
 *   shared definitions expose the same schema and description.
 * - Pi and the shared path reach the same private handler.
 * - Validation, lookup, and wrong-scope errors are identical across both paths.
 * - The shared path runs only the owner-held request admitted for (call id,
 *   tool). Start queues that snapshot under its raw admitted identity, and
 *   Inspect can read the queued handle.
 * - A missing admission, an admission for another call or tool, or a
 *   non-fingerprint Start identity fails closed before any work is created.
 * - The owner's live call policy is required, separately from the parent
 *   catalog.
 * - Shared invocation needs a live owner scope, across restore and detach.
 * No MCP transport, authentication, real owner admission, or native-CLI
 * behavior is covered.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedToolAdmission } from "../src/execution/tool";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";
import {
  EMPTY_ASSOCIATIONS,
  FixtureAdmission,
  SUBTASK_TOOL_NAMES,
  assertEnvelopeParity,
  assertManagedEnvelope,
  managedToolFixture,
  queuedTask,
  type ManagedToolFixture,
} from "./managed-tool-fixtures";

const startParams = (title: string) => ({ tasks: [queuedTask(title)] });
const call = (toolCallId: string) => ({ toolCallId });
const toolNameOf = (action: "start" | "inspect") => action === "start" ? "SubtasksStart" : "SubtasksInspect";

type SpyBinding = { toolCallId: string; host?: { ctx: unknown } };
type Handler = (action: string, toolName: string, params: unknown, binding: SpyBinding) => Promise<Record<string, unknown>>;

/** Records every call that reaches the private canonical handler. */
function spyHandler(manager: unknown): { calls: Array<{ action: string; toolName: string; params: unknown; binding: SpyBinding }>; restore(): void } {
  const instance = manager as { executeAction: Handler };
  const original = instance.executeAction.bind(manager);
  const calls: Array<{ action: string; toolName: string; params: unknown; binding: SpyBinding }> = [];
  instance.executeAction = async (action, toolName, params, binding) => {
    calls.push({ action, toolName, params, binding });
    return original(action, toolName, params, binding);
  };
  return { calls, restore: () => { instance.executeAction = original; } };
}

/** Admits `params` for one call id and runs it through the shared definition. */
async function sharedCall(fixture: ManagedToolFixture, action: "start" | "inspect", toolCallId: string, params: unknown): Promise<Record<string, any>> {
  fixture.admission.admit(toolCallId, toolNameOf(action), params);
  return fixture.shared(action).invoke(call(toolCallId));
}

test("Pi registration is unchanged and shares schema and description with the shared definitions", async () => {
  const fixture = await managedToolFixture();
  try {
    assert.deepEqual(fixture.tools.map((tool) => tool.name), SUBTASK_TOOL_NAMES);
    assert.deepEqual(fixture.activations, SUBTASK_TOOL_NAMES.map((name) => ({ name, enabled: true })));
    for (const action of ["start", "inspect"] as const) {
      const name = toolNameOf(action);
      const definition = fixture.shared(action);
      const tool = fixture.piTool(name);
      assert.equal(definition.name, name);
      assert.equal(definition.action, action);
      assert.equal(tool.executionMode, "sequential");
      assert.deepEqual(definition.parameters, tool.parameters, `${name} schema`);
      assert.equal(definition.description, tool.description, `${name} description`);
    }
    assert.deepEqual(Object.keys(fixture.piTool("SubtasksStart").parameters.properties), ["kind", "workspace", "tasks"]);
    assert.deepEqual(Object.keys(fixture.piTool("SubtasksInspect").parameters.properties), ["executionId", "taskId", "offset", "lines", "evidence"]);
    for (const action of ["add", "watch", "continue", "steer", "interrupt", "force_merge", "mark_clean"]) {
      assert.throws(
        () => fixture.manager.sharedManagedTool(action as never, fixture.admission),
        /is not a shared managed tool action/,
        `${action} stays Pi-only`,
      );
    }
    assert.throws(() => fixture.manager.sharedManagedTool("start", undefined as never), /requires an owner admission resolver/);
    assert.throws(() => fixture.manager.sharedManagedTool("start", {} as never), /requires an owner admission resolver/);
  } finally {
    await fixture.dispose();
  }
});

test("Pi execute and the shared definition route through the same canonical handler", async () => {
  const fixture = await managedToolFixture();
  const spy = spyHandler(fixture.manager);
  try {
    const ctx = { marker: "pi-ctx" };
    const params = { executionId: "exec-missing", taskId: "task-missing" };
    await fixture.piExecute("SubtasksInspect")("pi-inspect", params, undefined, undefined, ctx);
    await sharedCall(fixture, "inspect", "owner-inspect", params);
    await fixture.piExecute("SubtasksStart")("pi-start", { unsupported: true }, undefined, undefined, ctx);
    await sharedCall(fixture, "start", "owner-start", { unsupported: true });
    assert.deepEqual(spy.calls.map(({ action, toolName, params: p }) => [action, toolName, p]), [
      ["inspect", "SubtasksInspect", params],
      ["inspect", "SubtasksInspect", params],
      ["start", "SubtasksStart", { unsupported: true }],
      ["start", "SubtasksStart", { unsupported: true }],
    ]);
    assert.equal(spy.calls[0]!.binding.toolCallId, "pi-inspect");
    assert.equal(spy.calls[0]!.binding.host?.ctx, ctx, "Pi keeps its tool call context");
    assert.equal(spy.calls[1]!.binding.toolCallId, "owner-inspect");
    assert.equal(spy.calls[1]!.binding.host, undefined, "the shared binding carries no host context");
  } finally {
    spy.restore();
    await fixture.dispose();
  }
});

test("admitted invalid requests get canonical validation errors identical to Pi; only Pi feeds the returned-error observer", async () => {
  const fixture = await managedToolFixture();
  try {
    const cases: Array<["start" | "inspect", unknown]> = [
      ["start", { unsupported: true }],
      ["start", { tasks: [] }],
      ["start", "not an object"],
      ["inspect", { executionId: "exec-x" }],
      ["inspect", { taskId: "task-x", lines: -1 }],
    ];
    for (const [index, [action, params]] of cases.entries()) {
      const name = toolNameOf(action);
      const viaPi = await fixture.piExecute(name)(`pi-${index}`, params, undefined, undefined, {});
      const viaShared = await sharedCall(fixture, action, `owner-${index}`, params);
      assertManagedEnvelope(viaPi, true, `${name} Pi`);
      assertManagedEnvelope(viaShared, true, `${name} shared`);
      assert.match(viaPi.content[0].text, new RegExp(`^Invalid ${name} request: `));
      assert.deepEqual(viaShared, viaPi, `${name} ${JSON.stringify(params)}`);
    }
    assert.deepEqual(fixture.observedErrors, cases.map(([action], index) => [`pi-${index}`, toolNameOf(action)]));
    assert.equal(fixture.groupCount(), 0);
  } finally {
    await fixture.dispose();
  }
});

test("shared Start queues the admitted snapshot under its raw identity, and shared Inspect reads the handle like Pi", async () => {
  const fixture = await managedToolFixture();
  const spy = spyHandler(fixture.manager);
  try {
    // The owner admitted a raw submission that validation coerces (`kind: null`
    // is dropped), so the effective params differ from the raw input.
    const effective = startParams("shared queued");
    const raw = { ...effective, kind: null };
    const admitted = fixture.admission.admit("owner-start-1", "SubtasksStart", raw, effective);
    // Later edits to the caller's objects cannot change the admitted snapshot.
    (effective.tasks[0] as Record<string, unknown>).title = "MUTATED AFTER ADMISSION";
    const started = await fixture.shared("start").invoke(call("owner-start-1"));
    assertManagedEnvelope(started, false, "start");
    const details = started.details as Record<string, any>;
    assert.equal(details.action, "start");
    assert.equal(details.tasks.length, 1);
    assert.equal(details.tasks[0].state, "queued");
    assert.equal(details.tasks[0].definition.title, "shared queued", "the admitted snapshot is what queues");
    assert.deepEqual(spy.calls.at(-1)!.params, startParams("shared queued"));
    assert.match(started.content[0].text, /Task handles \(retain these for SubtasksSteer, SubtasksInterrupt, and SubtasksInspect\)/);
    assert.equal(fixture.manager.startLiveness(admitted!).state, "active", "the raw admitted identity is what persists");
    assert.equal(fixture.manager.startLiveness(toolCallFingerprint("SubtasksStart", startParams("shared queued"))!).state, "inactive",
      "effective params are not rehashed into the persisted identity");
    assert.equal(fixture.groupCount(), 1);
    assert.deepEqual(fixture.observedErrors, []);

    const handle = { executionId: details.executionId, taskId: details.tasks[0].taskId };
    const handlerCalls = spy.calls.length;
    // Inspect with an unknown call id, or an id admitted only for Start, never reaches the handler.
    for (const [label, toolCallId] of [["unknown id", "owner-never-admitted"], ["id admitted for Start", "owner-start-1"]] as const) {
      const refused = await fixture.shared("inspect").invoke(call(toolCallId));
      assertManagedEnvelope(refused, true, label);
      assert.match(refused.content[0].text, /failed closed: no owner admission for this call and tool; nothing was started or read/, label);
    }
    assert.equal(spy.calls.length, handlerCalls, "unadmitted Inspect fails before executeAction");

    const viaShared = await sharedCall(fixture, "inspect", "owner-inspect-1", handle);
    const viaPi = await fixture.piExecute("SubtasksInspect")("pi-inspect-1", handle, undefined, undefined, {});
    assertManagedEnvelope(viaShared, false, "shared inspect");
    assert.equal((viaShared.details as Record<string, any>).executionId, handle.executionId);
    assert.equal((viaShared.details as Record<string, any>).tasks[0].taskId, handle.taskId);
    assertEnvelopeParity(viaShared, viaPi, "inspect parity");
  } finally {
    spy.restore();
    await fixture.dispose();
  }
});

test("Pi Start keeps its admitted-identity semantics, including fail-closed on a mismatched resolver", async () => {
  const params = startParams("pi admitted");
  const submitted = toolCallFingerprint("SubtasksStart", { ...params, kind: null })!;
  const fixture = await managedToolFixture({
    submittedFingerprintFor: (toolCallId, toolName) =>
      toolCallId === "pi-admitted" && toolName === "SubtasksStart" ? submitted : undefined,
  });
  try {
    const started = await fixture.piExecute("SubtasksStart")("pi-admitted", params, undefined, undefined, {});
    assertManagedEnvelope(started, false, "pi start");
    assert.equal(fixture.manager.startLiveness(submitted).state, "active");
    const mismatched = await fixture.piExecute("SubtasksStart")("pi-other-call", startParams("pi mismatched"), undefined, undefined, {});
    assertManagedEnvelope(mismatched, true, "pi mismatched");
    assert.match(mismatched.content[0].text, /identity could not be verified; no group or tasks were created/);
    assert.equal(fixture.groupCount(), 1);
    assert.deepEqual(fixture.observedErrors, [["pi-other-call", "SubtasksStart"]]);
  } finally {
    await fixture.dispose();
  }
});

test("shared Start fails closed without an owner admission for exactly this call and tool", async () => {
  const fixture = await managedToolFixture();
  const spy = spyHandler(fixture.manager);
  try {
    const params = startParams("must not start");
    const otherCall = fixture.admission.admit("owner-call-a", "SubtasksStart", params)!;
    fixture.admission.admit("owner-call-b", "SubtasksInspect", { taskId: "task-any" });
    const nonFingerprint: ManagedToolAdmission = { resolveCall: () => ({ params, startCallFingerprint: "caller-asserted" }) };
    const missingFingerprint: ManagedToolAdmission = { resolveCall: () => ({ params }) };
    const throwing: ManagedToolAdmission = { resolveCall: () => { throw new Error("admission store unavailable"); } };
    const malformed: ManagedToolAdmission = { resolveCall: () => "params" as never };
    const refusals: Array<[string, unknown, RegExp, ManagedToolAdmission, boolean]> = [
      ["no admission record", call("owner-unadmitted"), /no owner admission for this call and tool/, fixture.admission, false],
      ["admitted for another tool", call("owner-call-b"), /no owner admission for this call and tool/, fixture.admission, false],
      ["empty admission table", call("owner-call-a"), /no owner admission for this call and tool/, new FixtureAdmission(), false],
      ["admission throws", call("owner-call-a"), /owner call admission could not be verified/, throwing, false],
      ["malformed admission", call("owner-call-a"), /no owner admission for this call and tool/, malformed, false],
      ["empty call id", call(""), /missing owner-assigned call id/, fixture.admission, false],
      ["no invocation", undefined, /missing owner-assigned call id/, fixture.admission, false],
      // These reach the canonical handler, which fails closed on the identity.
      ["non-fingerprint identity", call("owner-call-x"), /identity could not be verified; no group or tasks were created/, nonFingerprint, true],
      ["missing identity", call("owner-call-y"), /identity could not be verified; no group or tasks were created/, missingFingerprint, true],
    ];
    for (const [label, invocation, expected, admission, reachesHandler] of refusals) {
      const before = spy.calls.length;
      const response = await fixture.shared("start", admission).invoke(invocation as never);
      assertManagedEnvelope(response, true, label);
      assert.match(response.content[0].text, expected, label);
      assert.equal(spy.calls.length, before + (reachesHandler ? 1 : 0), label);
    }
    assert.equal(fixture.groupCount(), 0);
    assert.equal(fixture.manager.startLiveness(otherCall).state, "inactive");
    assert.deepEqual(fixture.observedErrors, [], "the shared path does not touch Pi preflight accounting");
  } finally {
    spy.restore();
    await fixture.dispose();
  }
});

test("shared Inspect lookup and wrong-scope errors stay bounded and match Pi", async () => {
  const fixture = await managedToolFixture();
  try {
    const first = await sharedCall(fixture, "start", "a", startParams("SCOPE-A-682"));
    const second = await sharedCall(fixture, "start", "b", startParams("SCOPE-B-682"));
    const a = first.details as Record<string, any>;
    const b = second.details as Record<string, any>;
    const requests = [
      { executionId: a.executionId, taskId: b.tasks[0].taskId },
      { executionId: "exec-unknown-682", taskId: a.tasks[0].taskId },
      { taskId: "task-unknown-682" },
    ];
    for (const [index, request] of requests.entries()) {
      // The same call id on both paths keeps the failure projection identical.
      const viaShared = await sharedCall(fixture, "inspect", `owner-scope-${index}`, request);
      const viaPi = await fixture.piExecute("SubtasksInspect")(`owner-scope-${index}`, request, undefined, undefined, {});
      assertManagedEnvelope(viaShared, true, JSON.stringify(request));
      assert.match(viaShared.content[0].text, /^SubtasksInspect failed: /);
      assertEnvelopeParity(viaShared, viaPi, JSON.stringify(request));
      const executions = (viaShared.details as Record<string, any>).executions as Array<Record<string, any>>;
      assert.ok(executions.length <= 1, "a failure never replays more than its scoped target");
    }
    const wrongScope = await fixture.shared("inspect").invoke(call("owner-scope-0"));
    assert.doesNotMatch(JSON.stringify(wrongScope), /SCOPE-B-682/, "the other group's data is not replayed");
  } finally {
    await fixture.dispose();
  }
});

test("the live call policy is required separately from the parent catalog and Pi launch exposure", async () => {
  const params = startParams("gated");
  const refusedWith = async (fixture: ManagedToolFixture, action: "start" | "inspect", input: unknown, pattern: RegExp) => {
    const spy = spyHandler(fixture.manager);
    try {
      const response = await sharedCall(fixture, action, `gate-${action}`, input);
      assertManagedEnvelope(response, true, action);
      assert.match(response.content[0].text, pattern);
      assert.match(response.content[0].text, /nothing was started or read/);
      assert.equal(spy.calls.length, 0, "a refused call never reaches the handler");
    } finally {
      spy.restore();
    }
  };

  // Start stays in the parent catalog, but the live policy denies it (plan
  // mode or a primary-role denial, for example).
  let liveAllowed = new Set(SUBTASK_TOOL_NAMES);
  const catalog = () => ["read", "bash", ...SUBTASK_TOOL_NAMES];
  const denied = await managedToolFixture({ authorizedTools: catalog, liveToolCallAllowed: (name) => liveAllowed.has(name) });
  try {
    const before = await sharedCall(denied, "inspect", "gate-before", { taskId: "task-any" });
    assert.match(before.content[0].text, /^SubtasksInspect failed: /, "allowed before the policy changes");
    liveAllowed = new Set(["SubtasksInspect"]);
    await refusedWith(denied, "start", params, /not allowed by this owner's live call policy/);
    assert.equal(denied.groupCount(), 0, "no group is created");
  } finally {
    await denied.dispose();
  }

  // A policy that throws fails closed.
  const throwing = await managedToolFixture({ liveToolCallAllowed: () => { throw new Error("policy unavailable"); } });
  try {
    await refusedWith(throwing, "inspect", { taskId: "task-any" }, /not allowed by this owner's live call policy/);
  } finally {
    await throwing.dispose();
  }

  // No owner policy wired.
  const unwired = await managedToolFixture({ liveToolCallAllowed: null });
  try {
    await refusedWith(unwired, "start", params, /not allowed by this owner's live call policy/);
    assert.equal(unwired.groupCount(), 0);
  } finally {
    await unwired.dispose();
  }

  // Not allowed by Pi at launch (native --tools allowlist), even if the policy says yes.
  const notLaunched = await managedToolFixture({ activeTools: ["read", "bash", "SubtasksInspect"], liveToolCallAllowed: () => true });
  try {
    await refusedWith(notLaunched, "start", params, /not currently exposed by this owner/);
    assert.equal(notLaunched.groupCount(), 0);
  } finally {
    await notLaunched.dispose();
  }
});

test("shared invocation needs a live owner scope across restore, detach, and shutdown", async () => {
  const fixture = await managedToolFixture();
  const spy = spyHandler(fixture.manager);
  try {
    fixture.admission.admit("cached", "SubtasksInspect", { taskId: "task-any" });
    fixture.admission.admit("fresh", "SubtasksInspect", { taskId: "task-any" });
    fixture.admission.admit("after-detach", "SubtasksStart", startParams("after detach"));

    // A definition cached before an association restore never reaches the new set.
    const cached = fixture.shared("inspect");
    await fixture.manager.restoreAssociations(EMPTY_ASSOCIATIONS);
    const afterRestore = await cached.invoke(call("cached"));
    assertManagedEnvelope(afterRestore, true, "cached across restore");
    assert.match(afterRestore.content[0].text, /owner session that bound this tool is no longer live/);
    assert.equal(spy.calls.length, 0);

    // A fresh binding in the restored scope works.
    const fresh = await fixture.shared("inspect").invoke(call("fresh"));
    assert.match(fresh.content[0].text, /^SubtasksInspect failed: /);
    assert.equal(spy.calls.length, 1);

    // After a plain detach, nothing new can be bound and old bindings are refused.
    const beforeDetach = fixture.shared("start");
    await fixture.manager.detach();
    assert.throws(() => fixture.shared("inspect"), /only while its owner session is live/);
    const stale = await beforeDetach.invoke(call("after-detach"));
    assert.match(stale.content[0].text, /owner session that bound this tool is no longer live/);
    assert.equal(spy.calls.length, 1, "neither the stale nor a fresh binding reached the controller");

    // The owner is ready again only after its next restore completes.
    await fixture.manager.restoreAssociations(EMPTY_ASSOCIATIONS);
    assert.ok(fixture.shared("inspect"));
    await fixture.manager.shutdown();
    assert.throws(() => fixture.shared("inspect"), /only while its owner session is live/);
  } finally {
    spy.restore();
    await fixture.dispose();
  }
});
