import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type ExternalAgentCatalog, type ReviewGateConfig } from "../src/config";
import type { ProcessRunResult } from "../src/adapters/process";
import {
  PROTECTION_AUDITOR_PROTOCOL,
  runProtectionAuditor,
  type ProtectionAuditorDependencies,
  type ProtectionAuditorPiContext,
  type ProtectionAuditorPiModel,
  type ProtectionAuditorPiModelRegistry,
  type ProtectionAuditorPiStreamOptions,
  type ProtectionAuditorObservation,
  type ProtectionAuditorRequest,
} from "../src/tool-protection/runner";

type ProcessLaunchInput = Parameters<typeof import("../src/adapters/process").runPromptProcess>[0];

function configWith(externalAgents?: ExternalAgentCatalog): ReviewGateConfig {
  return { ...DEFAULT_CONFIG, ...(externalAgents ? { externalAgents } : {}) };
}

function request(overrides: Partial<ProtectionAuditorRequest> = {}): ProtectionAuditorRequest {
  return {
    selection: { source: "pi", model: "synthetic/model", thinkingLevel: "high" },
    config: configWith(),
    prompt: "Synthetic decision prompt with no live data.",
    input: { proposal: { tool: "synthetic", args: {} } },
    cwd: process.cwd(),
    timeoutMs: 5_000,
    ...overrides,
  };
}

function processResult(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    stdout: '{"decision":"PASS","reason":"synthetic"}',
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    streamEvents: 0,
    toolCalls: 0,
    toolResultBytes: 0,
    compactions: 0,
    code: 0,
    timedOut: false,
    aborted: false,
    processSettlement: "confirmed",
    ...overrides,
  };
}

test("Pi selection without a model registry fails closed before launch", async () => {
  let launched = false;
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => {
      launched = true;
      return processResult();
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const result = await runProtectionAuditor(request(), dependencies);
  assert.equal(launched, false);
  assert.match(result.error ?? "", /requires a coordinator-supplied model registry/);
  assert.equal(result.output, undefined);
  assert.equal(result.settlement, undefined);
});

interface FakePiCall {
  model: ProtectionAuditorPiModel;
  context: ProtectionAuditorPiContext;
  options?: ProtectionAuditorPiStreamOptions;
}

function fakePiRegistry(
  models: ProtectionAuditorPiModel[],
  events: unknown[],
  onCall?: (call: FakePiCall) => void,
  hang = false,
): ProtectionAuditorPiModelRegistry {
  return {
    find(provider, modelId) {
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
    getAll() {
      return models;
    },
    streamSimple(model, context, options) {
      onCall?.({ model, context, options });
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
          if (hang) {
            await new Promise((_, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("synthetic abort")), { once: true });
            });
          }
        },
      };
    },
  };
}

function piDone(text: string): unknown {
  return {
    type: "done",
    reason: "stop",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

const syntheticPiModels: ProtectionAuditorPiModel[] = [
  { id: "model", provider: "synthetic" },
];

test("Pi in-process auditor uses streamSimple with no tools and no CLI launch", async () => {
  let call: FakePiCall | undefined;
  let launched = false;
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => {
      launched = true;
      return processResult();
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const registry = fakePiRegistry(
    syntheticPiModels,
    [{ type: "start" }, piDone('{"decision":"PASS","reason":"in-process"}')],
    (value) => { call = value; },
  );
  const result = await runProtectionAuditor(request({ modelRegistry: registry }), dependencies);

  assert.equal(launched, false);
  assert.equal(result.error, undefined);
  assert.equal(result.output, '{"decision":"PASS","reason":"in-process"}');
  assert.equal(result.settlement, undefined);
  assert.ok(call);
  assert.deepEqual(call.model, syntheticPiModels[0]);
  assert.match(call.context.systemPrompt, /no tools/);
  assert.equal(call.context.messages.length, 1);
  assert.equal(call.context.messages[0]!.role, "user");
  assert.equal(call.context.messages[0]!.content, request().prompt);
  assert.equal("tools" in call.context, false);
  assert.ok(call.options?.signal);
  assert.equal(call.options?.toolChoice, "none");
  assert.equal(call.options?.maxRetries, 0);
  assert.equal(call.options?.timeoutMs, 5_000);
  assert.equal(call.options?.reasoning, "high");
});

test("Pi in-process auditor resolves provider/model and omits off reasoning", async () => {
  let call: FakePiCall | undefined;
  const registry = fakePiRegistry(
    [{ id: "model", provider: "synthetic" }],
    [piDone("{\"decision\":\"FAIL\"}")],
    (value) => { call = value; },
  );
  const result = await runProtectionAuditor(request({
    selection: { source: "pi", model: "synthetic/model", thinkingLevel: "off" },
    modelRegistry: registry,
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.output, '{"decision":"FAIL"}');
  assert.equal(call?.model.id, "model");
  assert.equal(call?.model.provider, "synthetic");
  assert.equal(call?.options?.reasoning, undefined);
});

test("Pi in-process auditor defaults absent reasoning to high", async () => {
  let call: FakePiCall | undefined;
  const registry = fakePiRegistry(
    syntheticPiModels,
    [piDone("{\"decision\":\"PASS\"}")],
    (value) => { call = value; },
  );
  const result = await runProtectionAuditor(request({
    selection: { source: "pi", model: "synthetic/model" },
    modelRegistry: registry,
  }));
  assert.equal(result.error, undefined);
  assert.equal(call?.options?.reasoning, "high");
});

test("Pi in-process auditor prefers an explicit provider/model over a colliding bare id", async () => {
  let call: FakePiCall | undefined;
  const collision = fakePiRegistry(
    [
      { id: "model", provider: "anthropic" },
      { id: "anthropic/model", provider: "gateway" },
    ],
    [piDone("{\"decision\":\"PASS\"}")],
    (value) => { call = value; },
  );
  const resolved = await runProtectionAuditor(request({
    selection: { source: "pi", model: "anthropic/model" },
    modelRegistry: collision,
  }));
  assert.equal(resolved.error, undefined);
  assert.equal(call?.model.provider, "anthropic");
  assert.equal(call?.model.id, "model");

  let streamed = false;
  const missingPair = fakePiRegistry(
    [
      { id: "other", provider: "anthropic" },
      { id: "anthropic/model", provider: "gateway" },
    ],
    [piDone("unexpected")],
    () => { streamed = true; },
  );
  const rejected = await runProtectionAuditor(request({
    selection: { source: "pi", model: "anthropic/model" },
    modelRegistry: missingPair,
  }));
  assert.match(rejected.error ?? "", /explicit provider\/model/);
  assert.equal(streamed, false);
});

test("Pi in-process auditor rejects a missing canonical pair even with a same-provider slash-bearing id", async () => {
  let streamed = false;
  const onlySlashBearing = fakePiRegistry(
    [{ id: "anthropic/model", provider: "anthropic" }],
    [piDone("unexpected")],
    () => { streamed = true; },
  );
  const rejected = await runProtectionAuditor(request({
    selection: { source: "pi", model: "anthropic/model" },
    modelRegistry: onlySlashBearing,
  }));
  assert.match(rejected.error ?? "", /explicit provider\/model/);
  assert.equal(streamed, false);

  let call: FakePiCall | undefined;
  const qualified = fakePiRegistry(
    [{ id: "anthropic/model", provider: "anthropic" }],
    [piDone("{\"decision\":\"PASS\"}")],
    (value) => { call = value; },
  );
  const resolved = await runProtectionAuditor(request({
    selection: { source: "pi", model: "anthropic/anthropic/model" },
    modelRegistry: qualified,
  }));
  assert.equal(resolved.error, undefined);
  assert.equal(call?.model.provider, "anthropic");
  assert.equal(call?.model.id, "anthropic/model");
});

test("Pi in-process auditor rejects ambiguous and missing registry models before streaming", async () => {
  let streamed = false;
  const ambiguous = fakePiRegistry(
    [
      { id: "shared", provider: "one" },
      { id: "shared", provider: "two" },
    ],
    [piDone("unexpected")],
    () => { streamed = true; },
  );
  const ambiguousResult = await runProtectionAuditor(request({
    selection: { source: "pi", model: "shared" },
    modelRegistry: ambiguous,
  }));
  assert.match(ambiguousResult.error ?? "", /ambiguous/);
  assert.equal(streamed, false);

  const missing = fakePiRegistry([], [piDone("unexpected")], () => { streamed = true; });
  const missingResult = await runProtectionAuditor(request({
    selection: { source: "pi", model: "absent" },
    modelRegistry: missing,
  }));
  assert.match(missingResult.error ?? "", /not found/);
  assert.equal(streamed, false);
});

test("Pi in-process auditor discards a decision after a tool-call event or message", async () => {
  const eventRegistry = fakePiRegistry(
    syntheticPiModels,
    [{ type: "toolcall_start", contentIndex: 0 }, piDone('{"decision":"PASS"}')],
  );
  const eventResult = await runProtectionAuditor(request({ modelRegistry: eventRegistry }));
  assert.match(eventResult.error ?? "", /attempted a tool call/);
  assert.equal(eventResult.output, undefined);

  const messageRegistry = fakePiRegistry(
    syntheticPiModels,
    [{
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "Bash", arguments: {} }, { type: "text", text: "{\"decision\":\"PASS\"}" }],
      },
    }],
  );
  const messageResult = await runProtectionAuditor(request({ modelRegistry: messageRegistry }));
  assert.match(messageResult.error ?? "", /attempted a tool call/);
  assert.equal(messageResult.output, undefined);
});

test("Pi in-process auditor returns provider errors and missing output as errors", async () => {
  const errorRegistry = fakePiRegistry(syntheticPiModels, [
    { type: "error", reason: "error", error: { errorMessage: "synthetic provider error" } },
  ]);
  const errorResult = await runProtectionAuditor(request({ modelRegistry: errorRegistry }));
  assert.match(errorResult.error ?? "", /synthetic provider error/);

  const emptyRegistry = fakePiRegistry(syntheticPiModels, [piDone("   ")]);
  const emptyResult = await runProtectionAuditor(request({ modelRegistry: emptyRegistry }));
  assert.match(emptyResult.error ?? "", /produced no output/);

  const truncatedRegistry = fakePiRegistry(syntheticPiModels, [{
    type: "done",
    message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "{\"decision\":\"PASS\"}" }] },
  }]);
  const truncatedResult = await runProtectionAuditor(request({ modelRegistry: truncatedRegistry }));
  assert.match(truncatedResult.error ?? "", /truncated by the model token limit/);
});

test("Pi in-process auditor launch failure is an explicit error without another model attempt", async () => {
  let launched = false;
  const registry: ProtectionAuditorPiModelRegistry = {
    find: () => syntheticPiModels[0],
    getAll: () => syntheticPiModels,
    streamSimple: () => {
      throw new Error("synthetic auth failure");
    },
  };
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => {
      launched = true;
      return processResult();
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const result = await runProtectionAuditor(request({ modelRegistry: registry }), dependencies);
  assert.equal(launched, false);
  assert.match(result.error ?? "", /in-process launch failed: synthetic auth failure/);
});

test("Pi in-process auditor timeout and abort return errors without a decision", async () => {
  const timeoutRegistry = fakePiRegistry(syntheticPiModels, [], undefined, true);
  const timedOut = await runProtectionAuditor(request({ modelRegistry: timeoutRegistry, timeoutMs: 25 }));
  assert.match(timedOut.error ?? "", /timed out after 25ms/);
  assert.equal(timedOut.output, undefined);
  // Positive timeout evidence: the in-process deadline itself won the race.
  assert.equal(timedOut.timedOut, true);

  const abortRegistry = fakePiRegistry(syntheticPiModels, [], undefined, true);
  const controller = new AbortController();
  const run = runProtectionAuditor(request({ modelRegistry: abortRegistry, signal: controller.signal }));
  setTimeout(() => controller.abort(), 20);
  const aborted = await run;
  assert.match(aborted.error ?? "", /aborted/);
  assert.equal(aborted.output, undefined);
  // A cancellation is not a confirmed deadline, so no timeout evidence is claimed.
  assert.equal(aborted.timedOut, undefined);
});

test("generic-cli auditor sends the versioned request on stdin and returns raw decision text", async () => {
  let launch: Parameters<typeof import("../src/adapters/process").runPromptProcess>[0] | undefined;
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async (input: ProcessLaunchInput) => {
      launch = input;
      return processResult({ stdout: '{"decision":"FAIL"}\n' });
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({
    classifier: {
      adapter: "generic-cli",
      command: "/synthetic/classifier",
      args: ["--shared"],
      env: { SHARED: "1" },
      review: { args: ["--review"], env: { ROLE: "review" } },
    },
  });
  const result = await runProtectionAuditor(request({ selection: { source: "external", id: "classifier" }, config }), dependencies);

  assert.equal(result.error, undefined);
  assert.equal(result.output, '{"decision":"FAIL"}');
  assert.equal(result.settlement, "confirmed");
  assert.ok(launch);
  assert.equal(launch.command, "/synthetic/classifier");
  assert.deepEqual(launch.args, ["--shared", "--review"]);
  assert.equal(launch.env?.PI_REVIEW_AGENT_PROTOCOL, PROTECTION_AUDITOR_PROTOCOL);
  assert.equal(launch.env?.SHARED, "1");
  assert.equal(launch.env?.ROLE, "review");
  assert.equal(launch.args.includes(request().prompt), false);
  const envelope = JSON.parse(launch.prompt) as Record<string, unknown>;
  assert.equal(envelope.version, PROTECTION_AUDITOR_PROTOCOL);
  assert.equal(envelope.prompt, request().prompt);
  assert.deepEqual(envelope.input, request().input);
  assert.equal(envelope.cwd, process.cwd());
});

test("run-as-binary auditor with an execution role uses execution settings and inherits shared settings", async () => {
  let launch: Parameters<typeof import("../src/adapters/process").runPromptProcess>[0] | undefined;
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async (input: ProcessLaunchInput) => {
      launch = input;
      return processResult({ stdout: '{"decision":"PASS"}' });
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({
    binary: {
      adapter: "run-as-binary",
      command: "/synthetic/binary",
      args: ["--shared"],
      review: { protocol: "pi-reviewer-json-v1", args: ["--review"] },
      execution: { protocol: "pi-review-executor-jsonl-v1", args: ["--execution"] },
    },
  });
  await runProtectionAuditor(request({ selection: { source: "external", id: "binary" }, config }), dependencies);
  assert.deepEqual(launch?.args, ["--shared", "--execution"]);
});

test("run-as-binary auditor falls back to its review role when no execution role exists", async () => {
  let launch: Parameters<typeof import("../src/adapters/process").runPromptProcess>[0] | undefined;
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async (input: ProcessLaunchInput) => {
      launch = input;
      return processResult({ stdout: '{"decision":"PASS"}' });
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({
    binary: {
      adapter: "run-as-binary",
      command: "/synthetic/binary",
      review: { protocol: "pi-reviewer-json-v1", args: ["--review"] },
    },
  });
  await runProtectionAuditor(request({ selection: { source: "external", id: "binary" }, config }), dependencies);
  assert.deepEqual(launch?.args, ["--review"]);
});

test("real fake external binary receives the envelope on stdin and no prompt in argv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-auditor-binary-"));
  try {
    const capturePath = join(dir, "capture.json");
    const scriptPath = join(dir, "auditor.mjs");
    await writeFile(scriptPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      `  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
      "    argv: process.argv.slice(2),",
      "    marker: process.env.PI_REVIEW_AGENT_PROTOCOL,",
      "    stdin: input,",
      "  }));",
      "  process.stdout.write('{\"decision\":\"FAIL\",\"reason\":\"synthetic\"}\\n');",
      "});",
    ].join("\n"), "utf8");
    await chmod(scriptPath, 0o755);
    const config = configWith({
      binary: {
        adapter: "run-as-binary",
        command: scriptPath,
        args: ["--shared"],
        execution: { protocol: "pi-review-executor-jsonl-v1", args: ["--execution"] },
      },
    });
    const result = await runProtectionAuditor(request({
      selection: { source: "external", id: "binary" },
      config,
      timeoutMs: 10_000,
    }));
    assert.equal(result.error, undefined);
    assert.equal(result.settlement, "confirmed");
    assert.equal(result.output, '{"decision":"FAIL","reason":"synthetic"}');
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
      argv: string[];
      marker: string;
      stdin: string;
    };
    assert.deepEqual(capture.argv, ["--shared", "--execution"]);
    assert.equal(capture.argv.includes(request().prompt), false);
    assert.equal(capture.marker, PROTECTION_AUDITOR_PROTOCOL);
    const envelope = JSON.parse(capture.stdin) as Record<string, unknown>;
    assert.equal(envelope.version, PROTECTION_AUDITOR_PROTOCOL);
    assert.equal(envelope.prompt, request().prompt);
    assert.deepEqual(envelope.input, request().input);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex auditor fails closed before launch because no proven no-tools route exists", async () => {
  let launched = false;
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => {
      launched = true;
      return processResult();
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({
    codex: {
      adapter: "codex-cli",
      command: "/synthetic/codex",
      review: { args: ["--synthetic"] },
    },
  });
  const result = await runProtectionAuditor(request({ selection: { source: "external", id: "codex" }, config }), dependencies);
  assert.equal(launched, false);
  assert.match(result.error ?? "", /Codex auditor route is unsupported/);
  assert.match(result.error ?? "", /no proven supplied-context-only\/no-tools/);
  assert.equal(result.settlement, undefined);
});

test("Claude auditor fails closed before launch until single-attempt retries are proven", async () => {
  let launched = false;
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => {
      launched = true;
      return processResult();
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({
    claude: {
      adapter: "claude-cli",
      command: "/synthetic/claude",
      review: { args: ["--effort", "high"] },
    },
  });
  const result = await runProtectionAuditor(request({
    selection: { source: "external", id: "claude" },
    config,
  }), dependencies);
  assert.equal(launched, false);
  assert.match(result.error ?? "", /invocation-local API retry disabling has not been established/);
  assert.equal(result.output, undefined);
  assert.equal(result.settlement, undefined);
});

test("process route returns timeout, abort, nonzero, missing-output, stdin, settlement, and truncation errors exactly once", async () => {
  const scenarios: Array<{
    name: string;
    output: ProcessRunResult;
    expected: RegExp;
    settlement?: "confirmed" | "unconfirmed";
    /** Expected positive timeout evidence for this transport result. */
    timedOut?: true;
  }> = [
    { name: "timeout", output: processResult({ timedOut: true, code: null }), expected: /timed out after 5000ms/, settlement: "confirmed", timedOut: true },
    { name: "abort", output: processResult({ aborted: true, code: null }), expected: /aborted/, settlement: "confirmed" },
    { name: "nonzero", output: processResult({ code: 2 }), expected: /exited with status 2/, settlement: "confirmed" },
    { name: "missing", output: processResult({ stdout: " \n" }), expected: /produced no output/, settlement: "confirmed" },
    { name: "truncated", output: processResult({ stdoutTruncated: true }), expected: /output was truncated/, settlement: "confirmed" },
    { name: "stdin", output: processResult({ stdinError: "synthetic stdin failure" }), expected: /could not receive its request/, settlement: "confirmed" },
    { name: "settlement", output: processResult({ processSettlement: "unconfirmed" }), expected: /settlement is unconfirmed/, settlement: "unconfirmed" },
    // A cancelled run whose deadline also passed stays an uncertain end: the
    // deadline is not reported as confirmed timeout evidence.
    { name: "timeout then abort", output: processResult({ timedOut: true, aborted: true, code: null }), expected: /aborted/, settlement: "confirmed" },
  ];
  for (const scenario of scenarios) {
    let calls = 0;
    const dependencies: ProtectionAuditorDependencies = {
      runPromptProcess: (async () => {
        calls += 1;
        return scenario.output;
      }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
    };
    const config = configWith({
      classifier: { adapter: "generic-cli", command: "/synthetic/classifier", review: {} },
    });
    const result = await runProtectionAuditor(request({ selection: { source: "external", id: "classifier" }, config }), dependencies);
    assert.equal(calls, 1, `${scenario.name} must not retry`);
    assert.match(result.error ?? "", scenario.expected, scenario.name);
    assert.equal(result.output, undefined, scenario.name);
    assert.equal(result.settlement, scenario.settlement, scenario.name);
    assert.equal(result.timedOut, scenario.timedOut, `${scenario.name} timeout evidence`);
  }
});

test("process launch rejection is an error with no retry", async () => {
  let calls = 0;
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => {
      calls += 1;
      throw new Error("synthetic spawn failure");
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({
    classifier: { adapter: "generic-cli", command: "/synthetic/classifier", review: {} },
  });
  const result = await runProtectionAuditor(request({ selection: { source: "external", id: "classifier" }, config }), dependencies);
  assert.equal(calls, 1);
  assert.match(result.error ?? "", /launch failed: synthetic spawn failure/);
  assert.equal(result.settlement, undefined);
});

test("invalid requests and missing agents fail before launch", async () => {
  let calls = 0;
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => {
      calls += 1;
      return processResult();
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };

  const preAborted = new AbortController();
  preAborted.abort();
  const aborted = await runProtectionAuditor(request({ signal: preAborted.signal }), dependencies);
  assert.match(aborted.error ?? "", /aborted before launch/);

  const badTimeout = await runProtectionAuditor(request({ timeoutMs: 0 }), dependencies);
  assert.match(badTimeout.error ?? "", /timeoutMs/);

  const emptyPrompt = await runProtectionAuditor(request({ prompt: "   " }), dependencies);
  assert.match(emptyPrompt.error ?? "", /prompt/);

  const missing = await runProtectionAuditor(request({ selection: { source: "external", id: "absent" } }), dependencies);
  assert.match(missing.error ?? "", /external agent not found: absent/);

  assert.equal(calls, 0);
});

test("result shape remains the fixed API without parsing the decision", async () => {
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => processResult({ stdout: "not-json but raw text" })) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({
    classifier: { adapter: "generic-cli", command: "/synthetic/classifier", review: {} },
  });
  const result = await runProtectionAuditor(request({
    selection: { source: "external", id: "classifier" },
    config,
  }), dependencies);
  assert.deepEqual(Object.keys(result).sort(), ["durationMs", "output", "settlement"]);
  assert.equal(result.output, "not-json but raw text");
});

// ---------------------------------------------------------------------------
// Optional auditor-session retention (#536): what the runner reports about the
// transport it actually used. The runner never stores anything itself; it hands
// the exact transport data to an optional observer after the decision wait.
// ---------------------------------------------------------------------------

test("Pi in-process observation reports the exact request context and terminal message", async () => {
  let call: FakePiCall | undefined;
  const terminal = { role: "assistant", content: [{ type: "text", text: '{"decision":"PASS","reason":"in-process"}' }], stopReason: "stop", usage: { input: 11, output: 3 } };
  const registry = fakePiRegistry(
    syntheticPiModels,
    [{ type: "start" }, { type: "done", reason: "stop", message: terminal }],
    (value) => { call = value; },
  );
  let observation: ProtectionAuditorObservation | undefined;
  const result = await runProtectionAuditor(request({
    modelRegistry: registry,
    observe: (value) => { observation = value; },
  }));

  assert.equal(result.error, undefined);
  assert.ok(observation, "an actual transport invocation reports what it carried");
  assert.equal(observation.transport, "pi-in-process");
  assert.equal(observation.refusal, undefined);
  assert.equal(observation.external, undefined);
  assert.ok(observation.pi);
  // Byte-identical to what the request actually used, not a summary of it.
  assert.equal(observation.pi.systemPrompt, call?.context.systemPrompt);
  assert.equal(observation.pi.prompt, request().prompt);
  assert.equal(observation.pi.thinkingLevel, "high");
  assert.deepEqual(observation.pi.model, { provider: "synthetic", id: "model" });
  // The terminal message is passed through as the host produced it — including
  // whatever provider-exposed usage it really carried — never rebuilt.
  assert.equal(observation.pi.assistant, terminal);
});

test("Pi in-process observation omits a terminal message that never existed", async () => {
  const registry = fakePiRegistry(syntheticPiModels, [], undefined, true);
  let observation: ProtectionAuditorObservation | undefined;
  const result = await runProtectionAuditor(request({
    modelRegistry: registry,
    timeoutMs: 25,
    observe: (value) => { observation = value; },
  }));
  assert.match(result.error ?? "", /timed out after 25ms/);
  assert.equal(observation?.transport, "pi-in-process");
  // The request really went out, so it is reported; the reply does not exist,
  // so nothing is invented for it.
  assert.equal(observation?.pi?.prompt, request().prompt);
  assert.ok(observation && !("assistant" in (observation.pi ?? {})), JSON.stringify(observation.pi));
});

test("a pre-transport refusal reports no request bytes and the real refusal", async () => {
  let observation: ProtectionAuditorObservation | undefined;
  // No model registry: the Pi route refuses before any dispatch.
  const result = await runProtectionAuditor(request({ observe: (value) => { observation = value; } }));
  assert.match(result.error ?? "", /requires a coordinator-supplied model registry/);
  assert.ok(observation);
  assert.equal(observation.transport, "route-refused");
  assert.match(observation.refusal ?? "", /model registry/);
  assert.equal(observation.pi, undefined);
  assert.equal(observation.external, undefined);

  // Cancellation before launch is likewise a refusal, not a request.
  let second: ProtectionAuditorObservation | undefined;
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runProtectionAuditor(request({
    modelRegistry: fakePiRegistry(syntheticPiModels, []),
    signal: controller.signal,
    observe: (value) => { second = value; },
  }));
  assert.match(cancelled.error ?? "", /aborted before launch/);
  assert.equal(second?.transport, "route-refused");
});

test("external-binary observation reports the real stdin, stdout and host facts without provider data", async () => {
  const dependencies: ProtectionAuditorDependencies = {
    // The shared primitive reports delivery when the stdin write flushes; a
    // healthy run reports it, and the observation must carry that fact.
    runPromptProcess: (async (launch: ProcessLaunchInput) => {
      launch.onPromptDelivery?.({ prompt: launch.prompt });
      return processResult({ stdout: '{"decision":"FAIL","reason":"nope"}\n' });
    }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({
    classifier: { adapter: "generic-cli", command: "/synthetic/classifier", review: {} },
  });  let observation: ProtectionAuditorObservation | undefined;
  const result = await runProtectionAuditor(request({
    selection: { source: "external", id: "classifier" },
    config,
    observe: (value) => { observation = value; },
  }), dependencies);
  assert.equal(result.error, undefined);
  assert.ok(observation);
  assert.equal(observation.transport, "external-binary");
  assert.equal(observation.pi, undefined, "an external binary performed no Pi provider call");
  const external = observation.external!;
  // The exact envelope written to stdin, and the exact captured stdout.
  assert.deepEqual(JSON.parse(external.requestText), {
    version: PROTECTION_AUDITOR_PROTOCOL,
    prompt: request().prompt,
    input: request().input,
    cwd: request().cwd,
  });
  assert.equal(external.outputText, '{"decision":"FAIL","reason":"nope"}\n');
  assert.equal(external.truncated, false);
  assert.equal(external.exitCode, 0);
  assert.equal(external.timedOut, false);
  assert.equal(external.aborted, false);
  assert.equal(external.settlement, "confirmed");
  assert.equal(external.deliveredToStdin, true, "the host's own delivery report is preserved");
  // No provider, api, model, usage, or stop reason is implied for a program.
  assert.deepEqual(Object.keys(external).sort(), ["aborted", "deliveredToStdin", "exitCode", "outputText", "requestText", "settlement", "timedOut", "truncated"]);
});

test("external-binary observation never claims stdin delivery the host did not report", async () => {
  const cases = [
    { name: "EPIPE from an early exit", result: processResult({ code: null, stdout: "", stdinError: "write EPIPE", processSettlement: "unconfirmed" }) },
    { name: "cancelled before the write flushed", result: processResult({ code: null, stdout: "", aborted: true, processSettlement: "unconfirmed" }) },
    { name: "timed out before the write flushed", result: processResult({ code: null, stdout: "", timedOut: true, processSettlement: "unconfirmed" }) },
  ];
  for (const item of cases) {
    const dependencies: ProtectionAuditorDependencies = {
      // A process that dies or is cancelled early never reports delivery.
      runPromptProcess: (async () => item.result) as unknown as typeof import("../src/adapters/process").runPromptProcess,
    };
    const config = configWith({ classifier: { adapter: "generic-cli", command: "/synthetic/classifier", review: {} } });
    let observation: ProtectionAuditorObservation | undefined;
    await runProtectionAuditor(request({
      selection: { source: "external", id: "classifier" },
      config,
      observe: (value) => { observation = value; },
    }), dependencies);
    const external = observation!.external!;
    assert.equal(external.deliveredToStdin, false, `${item.name} must not be reported as delivered`);
    assert.equal(external.requestText.length > 0, true, `${item.name} still preserves the envelope the gate supplied`);
  }
});

test("a launch failure reports an honest category and code without the configured command", async () => {
  // Node's own spawn error, including the executable path it quotes.
  const spawnError = Object.assign(new Error("spawn /synthetic/SECRET-auditor-bin ENOENT"), {
    code: "ENOENT",
    errno: -2,
    syscall: "spawn /synthetic/SECRET-auditor-bin",
    path: "/synthetic/SECRET-auditor-bin",
  });
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => { throw spawnError; }) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({ classifier: { adapter: "generic-cli", command: "/synthetic/SECRET-auditor-bin", review: {} } });
  let observation: ProtectionAuditorObservation | undefined;
  const result = await runProtectionAuditor(request({
    selection: { source: "external", id: "classifier" },
    config,
    observe: (value) => { observation = value; },
  }), dependencies);
  // The user-facing diagnostic keeps the real launch detail.
  assert.match(result.error ?? "", /launch failed/i);
  assert.match(result.error ?? "", /ENOENT/);
  // The retained observation carries the category and code only.
  assert.deepEqual(observation!.launchFailure, { syscall: "spawn", code: "ENOENT" });
  assert.equal(observation!.transport, "route-refused");
  assert.equal(observation!.external, undefined, "a program that never started carried no bytes");
  const retained = JSON.stringify(observation);
  assert.ok(!retained.includes("SECRET-auditor-bin"), `the configured command leaked into the record: ${retained}`);
  assert.ok(!retained.includes("/synthetic/"), `an executable path leaked into the record: ${retained}`);
});

test("external-binary observation keeps host failure facts and an unreported settlement stays absent", async () => {
  const dependencies: ProtectionAuditorDependencies = {
    runPromptProcess: (async () => processResult({
      stdout: "",
      code: null,
      timedOut: true,
      processSettlement: undefined,
    })) as unknown as typeof import("../src/adapters/process").runPromptProcess,
  };
  const config = configWith({ classifier: { adapter: "generic-cli", command: "/synthetic/classifier", review: {} } });
  let observation: ProtectionAuditorObservation | undefined;
  const result = await runProtectionAuditor(request({
    selection: { source: "external", id: "classifier" },
    config,
    observe: (value) => { observation = value; },
  }), dependencies);
  assert.match(result.error ?? "", /timed out/);
  // An unconfirmed auditor-process settlement does not erase the deadline the
  // transport itself reported; the record fields below stay exactly as they were.
  assert.equal(result.timedOut, true);
  const external = observation!.external!;
  assert.equal(external.timedOut, true);
  assert.equal(external.exitCode, null);
  assert.equal(external.outputText, "", "no output is reported as none, not as an empty decision");
  assert.equal("settlement" in external, false, "an unreported settlement is absent, never invented");
});

test("a retention observer can never change the auditor result", async () => {
  const registry = fakePiRegistry(syntheticPiModels, [piDone('{"decision":"PASS","reason":"kept"}')]);
  const withoutObserver = await runProtectionAuditor(request({ modelRegistry: registry }));
  const result = await runProtectionAuditor(request({
    modelRegistry: registry,
    observe: () => {
      throw new Error("synthetic retention failure");
    },
  }));
  assert.equal(result.output, '{"decision":"PASS","reason":"kept"}');
  assert.equal(result.error, undefined);
  // Independent calls have independent elapsed times; their outcomes must match.
  const { durationMs: observedDuration, ...observedOutcome } = result;
  const { durationMs: baselineDuration, ...baselineOutcome } = withoutObserver;
  assert.deepEqual(observedOutcome, baselineOutcome);
  assert.ok(Number.isFinite(observedDuration) && observedDuration >= 0);
  assert.ok(Number.isFinite(baselineDuration) && baselineDuration >= 0);
});
