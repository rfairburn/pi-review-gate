import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activate } from "../src/index";
import { NativeToolCallPreflight } from "../src/tool-call-preflight";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";

type Call = { id: string; name: string; input: Record<string, unknown> };
type AttemptOutcome = "success" | "error" | "unknown" | "policy-blocked";
type StartLiveness = "active" | "unknown" | "inactive";

function nativePiHarness(options: {
  shellStart?: (fingerprint: string) => { state: StartLiveness; identity?: string };
  subtaskStart?: (fingerprint: string) => { state: StartLiveness; identity?: string };
} = {}) {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  let toolResultCount = 0;
  const preflight = new NativeToolCallPreflight({
    shellStartLiveness: options.shellStart,
    subtaskStartLiveness: options.subtaskStart,
  });
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
  };
  assert.equal(preflight.registerLifecycleHooks(pi), true);
  assert.equal(preflight.registerToolCallHook(pi), true);
  return {
    hooks,
    async emit(name: string, ...args: unknown[]): Promise<unknown[]> {
      if (name === "tool_result") toolResultCount += 1;
      const results: unknown[] = [];
      for (const handler of hooks.get(name) ?? []) results.push(await handler(...args));
      return results;
    },
    admittedSubmittedFingerprint(toolCallId: string, toolName: string): string | undefined {
      return preflight.admittedSubmittedFingerprint(toolCallId, toolName);
    },
    toolResultCount(): number {
      return toolResultCount;
    },
  };
}

/** Simulates Pi 0.87.1's native batch seam: message_end, then for each member
 * tool_execution_start BEFORE tool_call preflight. Pi's validated hook input
 * drops optional nulls; blocked calls produce no extension tool_result. */
async function dispatchNativeBatch(
  runtime: ReturnType<typeof nativePiHarness>,
  calls: Array<Call | { id: string; name: string; input?: Record<string, unknown> }>,
  outcomes: AttemptOutcome[] = [],
): Promise<{ decisions: Array<{ block: boolean; reason?: string }>; ran: Call[]; toolResults: number }> {
  const resultsBefore = runtime.toolResultCount();
  await runtime.emit("message_end", {
    message: {
      role: "assistant",
      content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.input })),
    },
  });

  const decisions: Array<{ block: boolean; reason?: string }> = [];
  const ran: Call[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    const input = call.input
      ? Object.fromEntries(Object.entries(call.input).filter(([, value]) => value !== null))
      : undefined;
    await runtime.emit("tool_execution_start", { toolCallId: call.id, toolName: call.name, args: input });
    const results = await runtime.emit("tool_call", {
      toolCallId: call.id,
      toolName: call.name,
      ...(input ? { input } : {}),
    });
    const result = results.find((candidate) => candidate !== undefined) as { block?: boolean; reason?: string } | undefined;
    decisions.push({ block: result?.block === true, ...(result?.reason ? { reason: result.reason } : {}) });
    if (decisions[index]!.block || !call.input) continue;
    const outcome = outcomes[index] ?? "success";
    // Another policy can block after this guard admits the call. It has no
    // observed result, so it earns no retry entitlement.
    if (outcome === "policy-blocked") continue;
    ran.push(call as Call);
    if (outcome === "unknown") {
      await runtime.emit("tool_result", { toolCallId: call.id, toolName: call.name, input: call.input });
    } else {
      await runtime.emit("tool_result", { toolCallId: call.id, toolName: call.name, input: call.input, isError: outcome === "error" });
    }
  }
  return { decisions, ran, toolResults: runtime.toolResultCount() - resultsBefore };
}

function call(id: string, name: string, input: Record<string, unknown>): Call {
  return { id, name, input };
}

function onlyDecisionBatch(
  runtime: ReturnType<typeof nativePiHarness>,
  calls: Call[],
): Promise<{ decisions: Array<{ block: boolean; reason?: string }>; ran: Call[]; toolResults: number }> {
  return dispatchNativeBatch(runtime, calls);
}

test("activate registers duplicate preflight lifecycle hooks in primary and Pi executor roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-duplicate-hooks-"));
  const configPath = join(root, "review-gate.json");
  const savedConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const savedDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  const savedRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  try {
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      maxCorrectionCycles: 3,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200_000,
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
      retainBundles: "never",
    }));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    for (const role of ["primary", "executor"] as const) {
      const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
      const pi = {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          hooks.set(name, [...(hooks.get(name) ?? []), handler]);
        },
      };
      if (role === "executor") process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
      else delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
      await activate(pi);
      for (const name of ["message_end", "tool_call", "tool_execution_start", "tool_result", "session_start", "session_shutdown"]) {
        assert.ok(hooks.has(name), `${role} registered ${name}`);
      }
      for (const handler of hooks.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" });
    }
  } finally {
    if (savedConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
    else process.env.PI_REVIEW_GATE_CONFIG = savedConfig;
    if (savedDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
    else process.env.PI_REVIEW_GATE_DISABLED = savedDisabled;
    if (savedRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = savedRole;
    await rm(root, { recursive: true, force: true });
  }
});

test("native registered hooks block A→A→A after a completed operation without rerunning it", async () => {
  const runtime = nativePiHarness();
  const a = (id: string) => call(id, "bash", { command: "test -f output.txt" });
  const first = await onlyDecisionBatch(runtime, [a("a1")]);
  assert.deepEqual(first.decisions.map((decision) => decision.block), [false]);
  const second = await onlyDecisionBatch(runtime, [a("a2")]);
  assert.deepEqual(second.decisions.map((decision) => decision.block), [true]);
  assert.match(second.decisions[0]?.reason ?? "", /Duplicate bash blocked/);
  assert.match(second.decisions[0]?.reason ?? "", /this member did not run/);
  const third = await onlyDecisionBatch(runtime, [a("a3")]);
  assert.deepEqual(third.decisions.map((decision) => decision.block), [true]);
  assert.match(third.decisions[0]?.reason ?? "", /follows a member that was itself blocked/);
  assert.equal(first.ran.length + second.ran.length + third.ran.length, 1);
});

test("an observed operation failure earns one adjacent retry, then reports repeated failures or repeated calls truthfully", async () => {
  for (const retryOutcome of ["error", "success"] as const) {
    const runtime = nativePiHarness();
    const a = (id: string) => call(id, "bash", { command: "run deterministic check" });
    const first = await dispatchNativeBatch(runtime, [a("first")], ["error"]);
    assert.equal(first.decisions[0]?.block, false);
    const retry = await dispatchNativeBatch(runtime, [a("retry")], [retryOutcome]);
    assert.equal(retry.decisions[0]?.block, false, "one retry follows an observed execution error");
    const third = await onlyDecisionBatch(runtime, [a("third")]);
    assert.equal(third.decisions[0]?.block, true);
    if (retryOutcome === "error") {
      assert.match(third.decisions[0]?.reason ?? "", /after two observed operation failures/);
    } else {
      assert.match(third.decisions[0]?.reason ?? "", /Repeated calls blocked/);
      assert.doesNotMatch(third.decisions[0]?.reason ?? "", /previous (?:retry )?succeeded|prior success/i);
    }
  }
});

test("unknown outcomes and policy-blocked calls do not create retry entitlement", async () => {
  const unknownRuntime = nativePiHarness();
  const a = (id: string) => call(id, "bash", { command: "uncertain operation" });
  await dispatchNativeBatch(unknownRuntime, [a("unknown-1")], ["unknown"]);
  const afterUnknown = await onlyDecisionBatch(unknownRuntime, [a("unknown-2")]);
  assert.equal(afterUnknown.decisions[0]?.block, true);
  assert.match(afterUnknown.decisions[0]?.reason ?? "", /outcome was not observed/);

  const policyRuntime = nativePiHarness();
  const first = await dispatchNativeBatch(policyRuntime, [a("policy-1")], ["error"]);
  assert.equal(first.decisions[0]?.block, false);
  // This call is allowed by our guard but another policy hook blocks it. Pi's
  // preflight-start event precedes this hook and is not proof that our callback
  // ran; with no result, the operation outcome remains unknown.
  await dispatchNativeBatch(policyRuntime, [a("policy-2")], ["policy-blocked"]);
  const afterPolicyBlock = await onlyDecisionBatch(policyRuntime, [a("policy-3")]);
  assert.equal(afterPolicyBlock.decisions[0]?.block, true);
  assert.doesNotMatch(afterPolicyBlock.decisions[0]?.reason ?? "", /after two observed operation failures/);
});

test("[A,B,C]→[B,D,F] blocks only the shared member in either direction", async () => {
  const runDirection = async (firstInputs: string[], secondInputs: string[]) => {
    const runtime = nativePiHarness();
    const make = (prefix: string, values: string[]) => values.map((value, index) => call(`${prefix}-${index}`, "read", { path: value }));
    const first = await onlyDecisionBatch(runtime, make("first", firstInputs));
    assert.deepEqual(first.decisions.map((decision) => decision.block), [false, false, false]);
    const second = await onlyDecisionBatch(runtime, make("second", secondInputs));
    assert.deepEqual(second.decisions.map((decision) => decision.block), secondInputs.map((value) => firstInputs.includes(value)));
    assert.equal(second.ran.length, 2);
  };
  await runDirection(["A", "B", "C"], ["B", "D", "F"]);
  await runDirection(["B", "D", "F"], ["A", "B", "C"]);
});

test("later identical ShellStart and SubtasksStart members in one native batch are blocked selectively", async () => {
  const runtime = nativePiHarness({
    shellStart: () => ({ state: "inactive" }),
    subtaskStart: () => ({ state: "inactive" }),
  });
  const shell = { command: "sleep 30", label: "worker" };
  const subtasks = { tasks: [{ title: "one", instructions: "work", acceptanceCriteria: ["done"] }] };
  const result = await onlyDecisionBatch(runtime, [
    call("shell-1", "ShellStart", shell),
    call("shell-2", "ShellStart", shell),
    call("subtasks-1", "SubtasksStart", subtasks),
    call("subtasks-2", "SubtasksStart", subtasks),
  ]);
  assert.deepEqual(result.decisions.map((decision) => decision.block), [false, true, false, true]);
  assert.equal(result.ran.length, 2);
  assert.match(result.decisions[1]?.reason ?? "", /no second job/i);
  assert.match(result.decisions[3]?.reason ?? "", /no group or tasks/i);
  assert.match(result.decisions[3]?.reason ?? "", /no worker usage/i);
  assert.doesNotMatch(result.decisions.map((decision) => decision.reason ?? "").join("\n"), /sleep 30|instructions|acceptanceCriteria/);
});

test("raw submitted identity survives Pi null normalization, mixed batches, and key reordering", async () => {
  const activeFingerprints = new Set<string>();
  const runtime = nativePiHarness({
    shellStart: (fingerprint) => activeFingerprints.has(fingerprint)
      ? { state: "active", identity: "job-raw" }
      : { state: "inactive" },
  });
  const withNull = { command: "sleep 30", label: null };
  const withNullReordered = { label: null, command: "sleep 30" };
  const first = await onlyDecisionBatch(runtime, [
    call("shell-null", "ShellStart", withNull),
    call("shell-null-reordered", "ShellStart", withNullReordered),
    call("mixed-read", "read", { path: "safe.txt" }),
  ]);
  assert.deepEqual(first.decisions.map((decision) => decision.block), [false, true, false]);
  assert.equal(first.toolResults, 2, "preflight-blocked calls produce no extension tool_result");
  const submittedFingerprint = runtime.admittedSubmittedFingerprint("shell-null", "ShellStart");
  assert.equal(submittedFingerprint, toolCallFingerprint("ShellStart", withNull));
  assert.equal(runtime.admittedSubmittedFingerprint("shell-null", "read"), undefined, "tool name is part of the narrow lookup");
  assert.equal(runtime.admittedSubmittedFingerprint("shell-null-reordered", "ShellStart"), undefined, "blocked calls are not admitted");
  assert.notEqual(submittedFingerprint, toolCallFingerprint("ShellStart", { command: "sleep 30" }), "a submitted null remains part of raw identity");

  // Model the execute callback persisting the admitted raw identity on its
  // live job. Pi strips label:null from validated hook/callback params.
  activeFingerprints.add(submittedFingerprint!);
  await onlyDecisionBatch(runtime, [call("gap", "WebFetch", { url: "https://example.test/" })]);
  const activeRepeat = await onlyDecisionBatch(runtime, [call("shell-active-repeat", "ShellStart", withNullReordered)]);
  assert.equal(activeRepeat.decisions[0]?.block, true);
  assert.match(activeRepeat.decisions[0]?.reason ?? "", /still active \(job-raw\)/);
  assert.equal(activeRepeat.toolResults, 0);

  await onlyDecisionBatch(runtime, [call("second-gap", "WebFetch", { url: "https://example.test/other" })]);
  const absentNull = await onlyDecisionBatch(runtime, [call("shell-null-absent", "ShellStart", { command: "sleep 30" })]);
  assert.equal(absentNull.decisions[0]?.block, false, "omitting the submitted null is distinct even though Pi normalizes both inputs alike");
  assert.notEqual(
    runtime.admittedSubmittedFingerprint("shell-null-absent", "ShellStart"),
    submittedFingerprint,
  );
});

test("SubtasksStart liveness uses the raw submitted fingerprint across an intervening group", async () => {
  const activeFingerprints = new Set<string>();
  const runtime = nativePiHarness({
    subtaskStart: (fingerprint) => activeFingerprints.has(fingerprint)
      ? { state: "active", identity: "exec-raw" }
      : { state: "inactive" },
  });
  const task = { title: "Raw identity", instructions: "Remain active", acceptanceCriteria: ["Finish"] };
  const submitted = { tasks: [task], kind: null };
  const reordered = { kind: null, tasks: [task] };
  const first = await onlyDecisionBatch(runtime, [call("subtask-null", "SubtasksStart", submitted)]);
  assert.equal(first.decisions[0]?.block, false);
  const submittedFingerprint = runtime.admittedSubmittedFingerprint("subtask-null", "SubtasksStart");
  assert.equal(submittedFingerprint, toolCallFingerprint("SubtasksStart", submitted));
  assert.notEqual(submittedFingerprint, toolCallFingerprint("SubtasksStart", { tasks: [task] }));

  activeFingerprints.add(submittedFingerprint!);
  await onlyDecisionBatch(runtime, [call("subtask-gap", "WebFetch", { url: "https://example.test/" })]);
  const duplicate = await onlyDecisionBatch(runtime, [call("subtask-repeat", "SubtasksStart", reordered)]);
  assert.equal(duplicate.decisions[0]?.block, true);
  assert.match(duplicate.decisions[0]?.reason ?? "", /active work \(exec-raw\)/);
  assert.equal(duplicate.toolResults, 0);

  await onlyDecisionBatch(runtime, [call("subtask-gap-2", "WebFetch", { url: "https://example.test/other" })]);
  const distinct = await onlyDecisionBatch(runtime, [call("subtask-null-absent", "SubtasksStart", { tasks: [task] })]);
  assert.equal(distinct.decisions[0]?.block, false, "omitting a submitted null is a distinct identity");
});

test("active ShellStart survives intervening groups; unknown liveness blocks, settling permits a nonadjacent repeat", async () => {
  let shellState: StartLiveness = "inactive";
  const runtime = nativePiHarness({
    shellStart: (fingerprint) => ({ state: shellState, ...(shellState === "active" ? { identity: `job:${fingerprint.slice(0, 6)}` } : {}) }),
  });
  let shellSequence = 0;
  const shell = () => call(`shell-${++shellSequence}`, "ShellStart", { command: "sleep 30", label: "long-job" });
  const started = await dispatchNativeBatch(runtime, [shell()]);
  assert.equal(started.decisions[0]?.block, false);
  shellState = "active";

  await onlyDecisionBatch(runtime, [call("fetch", "WebFetch", { url: "https://example.test/a" })]);
  await onlyDecisionBatch(runtime, [call("edit", "edit", { path: "out.txt", content: "change" })]);
  const activeDuplicate = await onlyDecisionBatch(runtime, [shell()]);
  assert.equal(activeDuplicate.decisions[0]?.block, true);
  assert.match(activeDuplicate.decisions[0]?.reason ?? "", /still active/);
  assert.match(activeDuplicate.decisions[0]?.reason ?? "", /ShellStop only if stopping it is authorized/);

  shellState = "unknown";
  await onlyDecisionBatch(runtime, [call("read-gap", "read", { path: "later.txt" })]);
  const unknown = await onlyDecisionBatch(runtime, [shell()]);
  assert.equal(unknown.decisions[0]?.block, true);
  assert.match(unknown.decisions[0]?.reason ?? "", /liveness is unknown/);
  shellState = "inactive";
  await onlyDecisionBatch(runtime, [call("settled-gap", "WebFetch", { url: "https://example.test/b" })]);
  const afterSettle = await onlyDecisionBatch(runtime, [shell()]);
  assert.equal(afterSettle.decisions[0]?.block, false);
});

test("active and unknown SubtasksStart liveness blocks across unrelated groups, regardless of start result", async () => {
  let groupState: StartLiveness = "inactive";
  const runtime = nativePiHarness({
    subtaskStart: () => ({ state: groupState, ...(groupState === "active" ? { identity: "exec-known" } : {}) }),
  });
  const start = (id: string, title = "phase") => call(id, "SubtasksStart", {
    tasks: [{ title, instructions: "remain active", acceptanceCriteria: ["complete"] }],
  });
  const first = await dispatchNativeBatch(runtime, [start("start-first")], ["error"]);
  assert.equal(first.decisions[0]?.block, false);
  groupState = "active";
  await onlyDecisionBatch(runtime, [call("web", "WebFetch", { url: "https://example.test/" })]);
  const active = await onlyDecisionBatch(runtime, [start("start-active")]);
  assert.equal(active.decisions[0]?.block, true);
  assert.match(active.decisions[0]?.reason ?? "", /active work \(exec-known\)/);
  assert.match(active.decisions[0]?.reason ?? "", /no worker usage/i);
  assert.match(active.decisions[0]?.reason ?? "", /SubtasksInspect/);

  groupState = "unknown";
  await onlyDecisionBatch(runtime, [call("patch", "ApplyPatch", { patch: "different" })]);
  const unknown = await onlyDecisionBatch(runtime, [start("start-unknown")]);
  assert.equal(unknown.decisions[0]?.block, true);
  assert.match(unknown.decisions[0]?.reason ?? "", /group liveness is unknown/);
});

test("an eight-task SubtasksStart and distinct starts remain admissible without quantity blocking", async () => {
  const runtime = nativePiHarness({
    subtaskStart: () => ({ state: "inactive" }),
  });
  const eight = {
    tasks: Array.from({ length: 8 }, (_, index) => ({
      title: `independent ${index}`,
      instructions: `task ${index}`,
      acceptanceCriteria: [`done ${index}`],
    })),
  };
  const distinct = {
    tasks: [{ title: "different", instructions: "separate", acceptanceCriteria: ["done"] }],
  };
  const result = await onlyDecisionBatch(runtime, [
    call("eight", "SubtasksStart", eight),
    call("different", "SubtasksStart", distinct),
  ]);
  assert.deepEqual(result.decisions.map((decision) => decision.block), [false, false]);
  assert.equal(result.ran.length, 2);
  assert.ok(toolCallFingerprint("SubtasksStart", eight));
});

test("bash(test)→ApplyPatch(fix)→bash(same test) remains allowed", async () => {
  const runtime = nativePiHarness();
  const testCall = (id: string) => call(id, "bash", { command: "npm run test:run -- --test-name-pattern=target" });
  const first = await onlyDecisionBatch(runtime, [testCall("bash-1")]);
  const patch = await onlyDecisionBatch(runtime, [call("patch", "ApplyPatch", { patch: "fix the test" })]);
  const last = await onlyDecisionBatch(runtime, [testCall("bash-2")]);
  assert.equal(first.decisions[0]?.block, false);
  assert.equal(patch.decisions[0]?.block, false);
  assert.equal(last.decisions[0]?.block, false);
});

test("uncorrelatable native batch blocks every member before execution without echoing arguments", async () => {
  const runtime = nativePiHarness();
  await runtime.emit("message_end", {
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "bad", name: "SubtasksStart" },
        { type: "toolCall", id: "good", name: "read", arguments: { path: "SECRET-PATH" } },
      ],
    },
  });
  const first = await runtime.emit("tool_call", { toolCallId: "bad", toolName: "SubtasksStart", input: { tasks: [] } });
  const second = await runtime.emit("tool_call", { toolCallId: "good", toolName: "read", input: { path: "SECRET-PATH" } });
  const reasons = [...first, ...second].filter((value) => value !== undefined) as Array<{ block: boolean; reason: string }>;
  const feedback = reasons.map((reason) => reason.reason).join("\n");
  assert.equal(reasons.length, 2);
  assert.ok(reasons.every((reason) => reason.block));
  assert.ok(reasons.every((reason) => /all 2 tool calls in this group were blocked before execution/.test(reason.reason)));
  assert.match(feedback, /Offending submission: member 1 \(SubtasksStart\)/);
  assert.match(feedback, /no worker usage/i);
  assert.doesNotMatch(feedback, /SECRET-PATH|\"tasks\"/);
});

test("innocent fallback siblings are retryable while the identified offender remains blocked", async () => {
  const runtime = nativePiHarness({ subtaskStart: () => ({ state: "inactive" }) });
  const badInput = { tasks: [{ title: "bad call", instructions: "submitted once", acceptanceCriteria: ["finish"] }] };
  const readInput = { path: "safe.txt" };
  await runtime.emit("message_end", {
    message: {
      role: "assistant",
      content: [
        // Missing identity makes selective preflight impossible, but the exact
        // offending request remains fingerprintable and trackable.
        { type: "toolCall", name: "SubtasksStart", arguments: badInput },
        { type: "toolCall", id: "read-first", name: "read", arguments: readInput },
      ],
    },
  });
  const firstOffender = await runtime.emit("tool_call", { toolCallId: "bad-first", toolName: "SubtasksStart", input: badInput });
  const firstSibling = await runtime.emit("tool_call", { toolCallId: "read-first", toolName: "read", input: readInput });
  assert.ok([...firstOffender, ...firstSibling].every((result) => (result as { block?: boolean } | undefined)?.block === true));

  const next = await dispatchNativeBatch(runtime, [
    call("read-retry", "read", readInput),
    call("bad-retry", "SubtasksStart", badInput),
  ]);
  assert.deepEqual(next.decisions.map((decision) => decision.block), [false, true]);
  assert.match(next.decisions[1]?.reason ?? "", /follows a member that was itself blocked/);
});
