import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activate } from "../src/index";
import registerBackgroundShell from "../src/background-shell";
import { EXECUTION_TOOL_NAMES } from "../src/execution/tool";
import { NativeToolCallPreflight } from "../src/tool-call-preflight";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";

type Call = { id: string; name: string; input: Record<string, unknown> };
type AttemptOutcome = "success" | "error" | "returned-error" | "text-error" | "unknown" | "policy-blocked";
type StartLiveness = "active" | "unknown" | "inactive";
type NativeBatchResult = {
  decisions: Array<{ block: boolean; reason?: string }>;
  ran: Call[];
  toolResults: number;
  nativeToolResults: Array<Record<string, unknown>>;
};

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
    async emitToolResult(event: Record<string, unknown>): Promise<Record<string, unknown>> {
      toolResultCount += 1;
      let currentEvent = { ...event };
      for (const handler of hooks.get("tool_result") ?? []) {
        const result = await handler(currentEvent);
        if (typeof result === "object" && result !== null && !Array.isArray(result)) {
          currentEvent = { ...currentEvent, ...result as Record<string, unknown> };
        }
      }
      return currentEvent;
    },
    admittedSubmittedFingerprint(toolCallId: string, toolName: string): string | undefined {
      return preflight.admittedSubmittedFingerprint(toolCallId, toolName);
    },
    observeReturnedError(toolCallId: string, toolName: string): void {
      preflight.observeReturnedError(toolCallId, toolName);
    },
    toolResultCount(): number {
      return toolResultCount;
    },
  };
}

/** Simulates Pi 0.87.1's native batch seam: message_end, then for each member
 * tool_execution_start BEFORE tool_call preflight for each member, with ALL
 * member preflights before any execution. Pi's validated hook input drops
 * optional nulls; blocked calls produce no extension tool_result. */
async function dispatchNativeBatch(
  runtime: ReturnType<typeof nativePiHarness>,
  calls: Array<Call | { id: string; name: string; input?: Record<string, unknown> }>,
  outcomes: AttemptOutcome[] = [],
): Promise<NativeBatchResult> {
  const resultsBefore = runtime.toolResultCount();
  await runtime.emit("message_end", {
    message: {
      role: "assistant",
      content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.input })),
    },
  });

  const decisions: Array<{ block: boolean; reason?: string }> = [];
  const ran: Call[] = [];
  const nativeToolResults: Array<Record<string, unknown>> = [];
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
  }
  // Pi completes the entire native batch preflight before running any member.
  // A same-batch duplicate cannot claim an earlier result at block time.
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    if (decisions[index]!.block || !call.input) continue;
    const outcome = outcomes[index] ?? "success";
    // Another policy can block after this guard admits the call. It has no
    // observed result, so it earns no retry entitlement.
    if (outcome === "policy-blocked") continue;
    ran.push(call as Call);
    const resultDetails = outcome === "returned-error"
      ? { diagnostic: "the extension returned a structured error" }
      : outcome === "text-error"
        ? { diagnostic: "text looks like an error, but no structured failure was returned" }
        : {};
    const hookEvent: Record<string, unknown> = {
      type: "tool_result",
      toolCallId: call.id,
      toolName: call.name,
      input: call.input,
      content: [{ type: "text", text: outcome === "success" ? "completed" : "Error: operation did not complete" }],
      details: resultDetails,
      // Pi 0.87.1's execute wrapper reports fulfilled calls as nonerrors and
      // copies content/details (not the extension result's top-level isError).
      ...(outcome === "unknown" ? {} : { isError: outcome === "error" }),
    };
    if (outcome === "returned-error") runtime.observeReturnedError(call.id, call.name);
    nativeToolResults.push(await runtime.emitToolResult(hookEvent));
  }
  return { decisions, ran, toolResults: runtime.toolResultCount() - resultsBefore, nativeToolResults };
}

function call(id: string, name: string, input: Record<string, unknown>): Call {
  return { id, name, input };
}

function onlyDecisionBatch(
  runtime: ReturnType<typeof nativePiHarness>,
  calls: Call[],
): Promise<NativeBatchResult> {
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
  assert.equal(second.decisions[0]?.reason, "Duplicate bash blocked: member 1 (bash) of 1 matches an identical request in the immediately preceding native tool group; this member did not run. Review any existing command result and the current workspace state.");
  const third = await onlyDecisionBatch(runtime, [a("a3")]);
  assert.deepEqual(third.decisions.map((decision) => decision.block), [true]);
  assert.equal(third.decisions[0]?.reason, "Duplicate bash blocked: member 1 (bash) of 1 follows an identical request that was blocked before execution; this member did not run. Review any existing command result and the current workspace state.");
  assert.equal(first.ran.length + second.ran.length + third.ran.length, 1);
});

test("an observed operation failure earns one adjacent retry, then reports repeated failures or repeated calls truthfully", async () => {
  for (const retryOutcome of ["error", "success"] as const) {
    const runtime = nativePiHarness();
    const a = (id: string) => call(id, "bash", { command: "run deterministic check" });
    const first = await dispatchNativeBatch(runtime, [a("first")], ["error"]);
    assert.equal(first.decisions[0]?.block, false);
    assert.equal(first.nativeToolResults[0]?.isError, true, "Pi's wrapper error flag remains authoritative");
    const retry = await dispatchNativeBatch(runtime, [a("retry")], [retryOutcome]);
    assert.equal(retry.decisions[0]?.block, false, "one retry follows an observed execution error");
    const third = await onlyDecisionBatch(runtime, [a("third")]);
    assert.equal(third.decisions[0]?.block, true);
    if (retryOutcome === "error") {
      assert.equal(third.decisions[0]?.reason, "Duplicate bash blocked after repeated failures: member 1 (bash) of 1 follows two identical executions that failed; this member did not run. Review any existing command result and the current workspace state.");
    } else {
      assert.equal(third.decisions[0]?.reason, "Repeated calls blocked: member 1 (bash) of 1 follows an identical execution that succeeded; this member did not run. Review any existing command result and the current workspace state.");
    }
  }
});

test("duplicate blockers name each approved request cause without changing member positions", async () => {
  const batchInput = { command: "repeat-safe-check" };
  const sameBatchRuntime = nativePiHarness();
  const sameBatch = await onlyDecisionBatch(sameBatchRuntime, [
    call("batch-first", "bash", batchInput),
    call("batch-middle", "read", { path: "other.txt" }),
    call("batch-duplicate", "bash", batchInput),
  ]);
  assert.equal(sameBatch.decisions[2]?.reason, "Duplicate bash blocked: member 3 (bash) of 3 matches an earlier identical request in this native batch; this member did not run. Review any existing command result and the current workspace state.");

  const precedingRuntime = nativePiHarness();
  await onlyDecisionBatch(precedingRuntime, [call("preceding-success", "bash", batchInput)]);
  const preceding = await onlyDecisionBatch(precedingRuntime, [call("preceding-repeat", "bash", batchInput)]);
  assert.equal(preceding.decisions[0]?.reason, "Duplicate bash blocked: member 1 (bash) of 1 matches an identical request in the immediately preceding native tool group; this member did not run. Review any existing command result and the current workspace state.");

  const blockedRuntime = nativePiHarness();
  await blockedRuntime.emit("message_end", {
    message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: batchInput }] },
  });
  const missingIdentity = await blockedRuntime.emit("tool_call", { toolCallId: "missing", toolName: "bash", input: batchInput });
  assert.equal((missingIdentity[0] as { block?: boolean }).block, true);
  const afterBlocked = await onlyDecisionBatch(blockedRuntime, [call("after-blocked", "bash", batchInput)]);
  assert.equal(afterBlocked.decisions[0]?.reason, "Duplicate bash blocked: member 1 (bash) of 1 follows an identical request that was blocked before execution; this member did not run. Review any existing command result and the current workspace state.");

  const unknownRuntime = nativePiHarness();
  await dispatchNativeBatch(unknownRuntime, [call("unknown-outcome", "bash", batchInput)], ["policy-blocked"]);
  const afterUnknown = await onlyDecisionBatch(unknownRuntime, [call("after-unknown", "bash", batchInput)]);
  assert.equal(afterUnknown.decisions[0]?.reason, "Duplicate bash blocked: member 1 (bash) of 1 matches an adjacent request whose execution outcome was not observed; this member did not run. Review any existing command result and the current workspace state.");
});

test("active start feedback omits unavailable job and execution identities", async () => {
  let shellState: StartLiveness = "inactive";
  const shellRuntime = nativePiHarness({ shellStart: () => ({ state: shellState }) });
  const shell = (id: string) => call(id, "ShellStart", { command: "sleep safely" });
  assert.equal((await onlyDecisionBatch(shellRuntime, [shell("shell-first")])).decisions[0]?.block, false);
  shellState = "active";
  const activeShell = await onlyDecisionBatch(shellRuntime, [shell("shell-again")]);
  assert.equal(activeShell.decisions[0]?.reason, "Duplicate ShellStart blocked: member 1 (ShellStart) of 1 matches an earlier start with an active job; this member started no job.");

  let subtaskState: StartLiveness = "inactive";
  const subtaskRuntime = nativePiHarness({ subtaskStart: () => ({ state: subtaskState }) });
  const subtasks = (id: string) => call(id, "SubtasksStart", {
    tasks: [{ title: "bounded task", instructions: "work safely", acceptanceCriteria: ["done"] }],
  });
  assert.equal((await onlyDecisionBatch(subtaskRuntime, [subtasks("subtask-first")])).decisions[0]?.block, false);
  subtaskState = "active";
  const activeSubtasks = await onlyDecisionBatch(subtaskRuntime, [subtasks("subtask-again")]);
  assert.equal(activeSubtasks.decisions[0]?.reason, "Duplicate SubtasksStart blocked: member 1 (SubtasksStart) of 1 matches an earlier identical start with active work; this member created no group or tasks.");
});

test("tool-specific duplicate feedback uses only observed results and approved next-step text", async () => {
  const resultTools: Array<[string, Record<string, unknown>]> = [
    ["read", { path: "RESULT-SECRET-read" }],
    ["grep", { pattern: "RESULT-SECRET-grep" }],
    ["find", { name: "RESULT-SECRET-find" }],
    ["ls", { path: "RESULT-SECRET-ls" }],
    ["WebFetch", { url: "https://example.test/RESULT-SECRET-fetch" }],
    ["WebSearch", { query: "RESULT-SECRET-search" }],
  ];
  for (const [name, input] of resultTools) {
    const sameBatchRuntime = nativePiHarness();
    const sameBatch = await onlyDecisionBatch(sameBatchRuntime, [
      call(`${name}-same-batch-first`, name, input),
      call(`${name}-same-batch-repeat`, name, input),
    ]);
    assert.equal(sameBatch.decisions[1]?.reason, `Duplicate ${name} blocked: member 2 (${name}) of 2 matches an earlier identical request in this native batch; this member did not run. This blocked member produced no result.`);

    const sameBatchNoResultRuntime = nativePiHarness();
    const sameBatchNoResult = await dispatchNativeBatch(sameBatchNoResultRuntime, [
      call(`${name}-same-batch-no-result`, name, input),
      call(`${name}-same-batch-no-result-repeat`, name, input),
    ], ["policy-blocked"]);
    assert.equal(sameBatchNoResult.decisions[1]?.reason, `Duplicate ${name} blocked: member 2 (${name}) of 2 matches an earlier identical request in this native batch; this member did not run. This blocked member produced no result.`);

    const observedRuntime = nativePiHarness();
    await onlyDecisionBatch(observedRuntime, [call(`${name}-observed`, name, input)]);
    const observed = await onlyDecisionBatch(observedRuntime, [call(`${name}-observed-repeat`, name, input)]);
    assert.equal(observed.decisions[0]?.reason, `Duplicate ${name} blocked: member 1 (${name}) of 1 matches an identical request in the immediately preceding native tool group; this member did not run. Use the returned result.`);

    const noResultRuntime = nativePiHarness();
    await dispatchNativeBatch(noResultRuntime, [call(`${name}-no-result`, name, input)], ["policy-blocked"]);
    const noResult = await onlyDecisionBatch(noResultRuntime, [call(`${name}-no-result-repeat`, name, input)]);
    assert.equal(noResult.decisions[0]?.reason, `Duplicate ${name} blocked: member 1 (${name}) of 1 matches an adjacent request whose execution outcome was not observed; this member did not run. This blocked member produced no result.`);
    assert.doesNotMatch(noResult.decisions[0]?.reason ?? "", /RESULT-SECRET/);
  }

  const tailored: Array<[string, Record<string, unknown>, string]> = [
    ["bash", { command: "SECRET-bash" }, "Review any existing command result and the current workspace state."],
    ["powershell", { command: "SECRET-powershell" }, "Review any existing command result and the current workspace state."],
    ["ApplyPatch", { patch: "SECRET-patch" }, "Revalidate the intended patch against the current file contents and any prior patch outcome before making further edits."],
    ["SubtasksInspect", { executionId: "SECRET-execution" }, "No inspection snapshot was taken by this member. Repeated polling is discouraged; rely on event-driven completion notifications, or use SubtasksWatch for one decision-relevant, one-shot callback while work continues."],
    ["ShellList", {}, "Use the evidence already available."],
    ["ShellStart", { command: "SECRET-start" }, ""],
    ["SubtasksStart", { tasks: [] }, ""],
  ];
  for (const [name, input, nextStep] of tailored) {
    const runtime = nativePiHarness({
      shellStart: () => ({ state: "inactive" }),
      subtaskStart: () => ({ state: "inactive" }),
    });
    const duplicate = await onlyDecisionBatch(runtime, [
      call(`${name}-first`, name, input),
      call(`${name}-duplicate`, name, input),
    ]);
    const base = `Duplicate ${name} blocked: member 2 (${name}) of 2 matches an earlier identical request in this native batch; this member did not run.`;
    assert.equal(duplicate.decisions[1]?.reason, nextStep ? `${base} ${nextStep}` : base);
    assert.doesNotMatch(duplicate.decisions[1]?.reason ?? "", /SECRET-|correction tool|retry/i);
  }
});

test("runtime correlation feedback preserves earlier allowed decisions and does not invent results", async () => {
  const uncorrelatedRuntime = nativePiHarness();
  const uncorrelated = await uncorrelatedRuntime.emit("tool_call", {
    toolCallId: "unmatched-read",
    toolName: "read",
    input: { path: "UNCORRELATED-SECRET" },
  });
  const uncorrelatedReason = (uncorrelated[0] as { block?: boolean; reason?: string }).reason ?? "";
  assert.equal(uncorrelatedReason, "Tool group blocked before execution: member 1 (read) had no matching assistant batch. This call did not run; any other calls before the next assistant message_end will also be blocked. This blocked member produced no result.");
  assert.doesNotMatch(uncorrelatedReason, /UNCORRELATED-SECRET|earlier result/);

  const uncorrelatedStart = await uncorrelatedRuntime.emit("tool_call", {
    toolCallId: "unmatched-start",
    toolName: "SubtasksStart",
    input: { tasks: [] },
  });
  const uncorrelatedStartReason = (uncorrelatedStart[0] as { block?: boolean; reason?: string }).reason ?? "";
  assert.doesNotMatch(uncorrelatedStartReason, /earlier start|existing group|execution identity|worker usage/);

  const runtime = nativePiHarness();
  await runtime.emit("message_end", {
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "allowed-first", name: "bash", arguments: { command: "safe" } },
        { type: "toolCall", id: "mismatched-second", name: "read", arguments: { path: "CORRELATION-SECRET" } },
      ],
    },
  });
  const allowed = await runtime.emit("tool_call", { toolCallId: "allowed-first", toolName: "bash", input: { command: "safe" } });
  assert.equal((allowed[0] as { block?: boolean } | undefined)?.block, undefined);
  const mismatched = await runtime.emit("tool_call", { toolCallId: "mismatched-second", toolName: "not-read", input: { path: "CORRELATION-SECRET" } });
  const reason = (mismatched[0] as { block?: boolean; reason?: string }).reason ?? "";
  assert.match(reason, /^Tool group blocked before execution: member 2 \(read\) did not match the submitted native batch\./);
  assert.match(reason, /This member and any remaining calls before the next assistant message are blocked; earlier preflight decisions were not revoked\./);
  assert.match(reason, /This blocked member produced no result\.$/);
  assert.doesNotMatch(reason, /all 2 tool calls|earlier group|existing group|CORRELATION-SECRET/);
});

test("structured ShellStart and SubtasksStart return failures become truthful Pi errors and earn one retry", async () => {
  const cases = [
    {
      name: "ShellStart",
      input: { command: "sleep 30", label: "worker" },
      runtime: () => nativePiHarness({ shellStart: () => ({ state: "inactive" }) }),
    },
    {
      name: "SubtasksStart",
      input: { tasks: [{ title: "one", instructions: "work", acceptanceCriteria: ["done"] }] },
      runtime: () => nativePiHarness({ subtaskStart: () => ({ state: "inactive" }) }),
    },
  ];
  for (const { name, input, runtime: createRuntime } of cases) {
    const runtime = createRuntime();
    const makeCall = (id: string) => call(id, name, input);
    const first = await dispatchNativeBatch(runtime, [makeCall(`${name}-failed`)], ["returned-error"]);
    assert.equal(first.decisions[0]?.block, false, `${name} runs before returning its error`);
    assert.equal(first.nativeToolResults[0]?.isError, true, `${name} error is reflected in Pi's final tool result`);
    assert.deepEqual(first.nativeToolResults[0]?.details, { diagnostic: "the extension returned a structured error" });
    assert.match((first.nativeToolResults[0]?.content as Array<{ text: string }>)[0]?.text ?? "", /^Error:/);

    const retry = await dispatchNativeBatch(runtime, [makeCall(`${name}-retry`)], ["success"]);
    assert.equal(retry.decisions[0]?.block, false, `${name} permits exactly one adjacent retry`);
    assert.equal(retry.nativeToolResults[0]?.isError, false, "a successful async start remains a success");

    const third = await onlyDecisionBatch(runtime, [makeCall(`${name}-third`)]);
    assert.equal(third.decisions[0]?.block, true, `${name} blocks a third identical operation`);
    assert.match(third.decisions[0]?.reason ?? "", /follows an identical execution that succeeded; this member did not run\./);
  }
});

test("structured returned errors from every non-start owned tool become Pi errors and permit only one retry", async () => {
  const names = [
    "ShellList", "ShellLog", "ShellSend", "ShellStop",
    "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
    "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
  ];
  for (const name of names) {
    const runtime = nativePiHarness();
    const makeCall = (id: string) => call(id, name, {});
    const first = await dispatchNativeBatch(runtime, [makeCall(`${name}-failed`)], ["returned-error"]);
    assert.equal(first.decisions[0]?.block, false, `${name} runs before returning its error`);
    assert.equal(first.nativeToolResults[0]?.isError, true, `${name} explicit returned error reaches Pi's final result`);
    assert.deepEqual(first.nativeToolResults[0]?.details, { diagnostic: "the extension returned a structured error" }, `${name} details are preserved`);
    assert.equal(
      (first.nativeToolResults[0]?.content as Array<{ text: string }>)[0]?.text,
      "Error: operation did not complete",
      `${name} content is preserved`,
    );

    const retry = await dispatchNativeBatch(runtime, [makeCall(`${name}-retry`)], ["success"]);
    assert.equal(retry.decisions[0]?.block, false, `${name} permits one adjacent retry after its returned failure`);
    assert.equal(retry.nativeToolResults[0]?.isError, false, `${name} retry success stays successful`);

    const third = await onlyDecisionBatch(runtime, [makeCall(`${name}-third`)]);
    assert.equal(third.decisions[0]?.block, true, `${name} blocks a third identical operation`);
    assert.match(third.decisions[0]?.reason ?? "", /follows an identical execution that succeeded; this member did not run\./);
    assert.equal(third.toolResults, 0, `${name} third call never reaches execute`);
  }

  const textRuntime = nativePiHarness();
  const textualFailure = await dispatchNativeBatch(
    textRuntime,
    [call("shell-log-text-error", "ShellLog", { id: "missing" })],
    ["text-error"],
  );
  assert.equal(textualFailure.nativeToolResults[0]?.isError, false, "error-looking content alone does not change Pi's result flag");
  const repeatedText = await onlyDecisionBatch(textRuntime, [call("shell-log-text-repeat", "ShellLog", { id: "missing" })]);
  assert.equal(repeatedText.decisions[0]?.block, true);
  assert.doesNotMatch(repeatedText.decisions[0]?.reason ?? "", /after two observed operation failures/);
});

test("returned-error normalization covers every registered Shell and Subtasks tool name", async () => {
  const shellNames: string[] = [];
  registerBackgroundShell({
    registerTool(tool) { shellNames.push(tool.name); },
    on() {},
    sendMessage() {},
  });
  const names = [...shellNames, ...Object.values(EXECUTION_TOOL_NAMES)];
  assert.equal(new Set(names).size, names.length, "owned registration families have unique tool names");

  const runtime = nativePiHarness({
    shellStart: () => ({ state: "inactive" }),
    subtaskStart: () => ({ state: "inactive" }),
  });
  for (const [index, name] of names.entries()) {
    const result = await dispatchNativeBatch(
      runtime,
      [call(`owned-tool-${index}`, name, {})],
      ["returned-error"],
    );
    assert.equal(result.decisions[0]?.block, false, `${name} is admissible`);
    assert.equal(result.nativeToolResults[0]?.isError, true, `${name} is covered by returned-error normalization`);
  }
});

test("unknown outcomes and policy-blocked calls do not create retry entitlement", async () => {
  const unknownRuntime = nativePiHarness();
  const a = (id: string) => call(id, "bash", { command: "uncertain operation" });
  await dispatchNativeBatch(unknownRuntime, [a("unknown-1")], ["unknown"]);
  const afterUnknown = await onlyDecisionBatch(unknownRuntime, [a("unknown-2")]);
  assert.equal(afterUnknown.decisions[0]?.block, true);
  assert.match(afterUnknown.decisions[0]?.reason ?? "", /outcome was not observed/);

  const textRuntime = nativePiHarness();
  await dispatchNativeBatch(textRuntime, [a("text-only-error")], ["text-error"]);
  const afterTextOnlyError = await onlyDecisionBatch(textRuntime, [a("after-text-only-error")]);
  assert.equal(afterTextOnlyError.decisions[0]?.block, true);
  assert.doesNotMatch(afterTextOnlyError.decisions[0]?.reason ?? "", /after two observed operation failures/);

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

  const ownedCall = (id: string) => call(id, "ShellLog", { id: "missing" });
  const ownedUnknownRuntime = nativePiHarness();
  await dispatchNativeBatch(ownedUnknownRuntime, [ownedCall("owned-unknown")], ["unknown"]);
  const afterOwnedUnknown = await onlyDecisionBatch(ownedUnknownRuntime, [ownedCall("owned-after-unknown")]);
  assert.equal(afterOwnedUnknown.decisions[0]?.block, true);
  assert.match(afterOwnedUnknown.decisions[0]?.reason ?? "", /outcome was not observed/);

  const ownedPolicyRuntime = nativePiHarness();
  await dispatchNativeBatch(ownedPolicyRuntime, [ownedCall("owned-failed")], ["returned-error"]);
  await dispatchNativeBatch(ownedPolicyRuntime, [ownedCall("owned-policy-blocked")], ["policy-blocked"]);
  const afterOwnedPolicyBlock = await onlyDecisionBatch(ownedPolicyRuntime, [ownedCall("owned-after-policy-block")]);
  assert.equal(afterOwnedPolicyBlock.decisions[0]?.block, true);
  assert.doesNotMatch(afterOwnedPolicyBlock.decisions[0]?.reason ?? "", /after two observed operation failures/);
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
  assert.equal(result.decisions[1]?.reason, "Duplicate ShellStart blocked: member 2 (ShellStart) of 4 matches an earlier identical request in this native batch; this member did not run.");
  assert.equal(result.decisions[3]?.reason, "Duplicate SubtasksStart blocked: member 4 (SubtasksStart) of 4 matches an earlier identical request in this native batch; this member did not run.");
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
  assert.equal(activeRepeat.decisions[0]?.reason, "Duplicate ShellStart blocked: member 1 (ShellStart) of 1 matches an earlier start with an active job job-raw; this member started no job.");
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
  assert.equal(duplicate.decisions[0]?.reason, "Duplicate SubtasksStart blocked: member 1 (SubtasksStart) of 1 matches an earlier identical start with active work in execution exec-raw; this member created no group or tasks.");
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
  assert.match(activeDuplicate.decisions[0]?.reason ?? "", /matches an earlier start with an active job job:/);
  assert.doesNotMatch(activeDuplicate.decisions[0]?.reason ?? "", /ShellStop|ShellList/);

  shellState = "unknown";
  await onlyDecisionBatch(runtime, [call("read-gap", "read", { path: "later.txt" })]);
  const unknown = await onlyDecisionBatch(runtime, [shell()]);
  assert.equal(unknown.decisions[0]?.block, true);
  assert.equal(unknown.decisions[0]?.reason, "Duplicate ShellStart blocked: member 1 (ShellStart) of 1 matches an earlier start whose job liveness could not be verified; this member started no job.");
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
  assert.equal(active.decisions[0]?.reason, "Duplicate SubtasksStart blocked: member 1 (SubtasksStart) of 1 matches an earlier identical start with active work in execution exec-known; this member created no group or tasks.");

  groupState = "unknown";
  await onlyDecisionBatch(runtime, [call("patch", "ApplyPatch", { patch: "different" })]);
  const unknown = await onlyDecisionBatch(runtime, [start("start-unknown")]);
  assert.equal(unknown.decisions[0]?.block, true);
  assert.equal(unknown.decisions[0]?.reason, "Duplicate SubtasksStart blocked: member 1 (SubtasksStart) of 1 matches an earlier identical start whose work liveness could not be verified; this member created no group or tasks.");
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
  assert.doesNotMatch(feedback, /worker usage|SubtasksInspect|SubtasksStart creates/);
  assert.match(feedback, /This blocked member produced no result\./);
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
  assert.equal(next.decisions[1]?.reason, "Duplicate SubtasksStart blocked: member 2 (SubtasksStart) of 2 follows an identical request that was blocked before execution; this member did not run.");
});
