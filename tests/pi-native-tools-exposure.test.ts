import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNativeMcpFixture,
  DEFAULT_SERVER_NAME,
  describeFixturePrerequisites,
  mcpToolName,
  REGISTERED_EXPOSURE_FOR_CODENAME_SERVER,
  ZERO_MODEL_GATE_CONFIG,
  type FixtureEvent,
  type NativeMcpFixture,
  type NativeMcpFixtureOptions,
  type ProbeDump,
} from "./pi-native-mcp-fixture";
import { skipOrFail } from "./bridge-fakes";
import { createExecutorToolCatalog } from "../src/execution/tool-catalog";

const CANDIDATE_OPTIONS = {
  timeouts: { requestMs: 30_000, connectMs: 30_000, turnMs: 60_000, dumpMs: 10_000 },
} satisfies NativeMcpFixtureOptions;

const DEFERRED_OFF_CONFIG = {
  ...ZERO_MODEL_GATE_CONFIG,
  execution: {
    workerResources: {},
    routes: { execute: [], research: [] },
    deferredPiTools: false,
  },
};

type FixtureTestContext = {
  skip(message?: string): void;
  after(callback: () => void | Promise<void>): void;
};

async function createNativeToolSearchSelector(t: FixtureTestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "prg-native-tool-search-selector-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const extension = join(directory, "native-tool-search-selector.cjs");
  await writeFile(extension, `module.exports = (pi) => {
  pi.registerCommand("native-select-tool-search", {
    description: "Exercise Pi's public native active-tool selection seam in the fixture.",
    handler: () => {
      const active = pi.getActiveTools();
      if (Array.isArray(active) && active.every((name) => typeof name === "string")) {
        pi.setActiveTools([...active, "tool_search"]);
      }
    },
  });
};\n`, "utf8");
  return extension;
}

async function startCandidateFixture(
  t: FixtureTestContext,
  options: NativeMcpFixtureOptions,
): Promise<NativeMcpFixture | undefined> {
  const prerequisites = describeFixturePrerequisites(options);
  if (!prerequisites.ok) {
    skipOrFail(t, `native MCP candidate fixture prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
    return undefined;
  }
  const fixture = createNativeMcpFixture(options);
  t.after(async () => {
    if (fixture.paths?.scratch) await fixture.dispose();
  });
  await fixture.start();
  assert.ok(
    await fixture.waitForServerLog((event) => event.event === "initialize"),
    "native MCP server should initialize before candidate assertions",
  );
  return fixture;
}

function observedTool(dump: ProbeDump, name: string): NonNullable<ProbeDump["allTools"]>[number] {
  const tool = dump.allTools?.find((candidate) => candidate.name === name);
  assert.ok(tool, `native Pi metadata should contain ${name}: ${JSON.stringify(dump.allTools)}`);
  return tool;
}

function toolEnd(fixture: NativeMcpFixture, name: string): FixtureEvent | undefined {
  return fixture.sessionEvents
    .filter((event) => event.type === "tool_execution_end" && event.toolName === name)
    .at(-1);
}

function matchSearchResult(fixture: NativeMcpFixture, name: string, pattern: RegExp): void {
  const event = toolEnd(fixture, name);
  assert.ok(event, `Pi should report search_tools completion for ${name}`);
  assert.match(JSON.stringify(event.result), pattern);
}

test("native MCP host callees stay outside gate declarations when deferred tools are off", { timeout: 300_000 }, async (t) => {
  const nativeToolSearchSelector = await createNativeToolSearchSelector(t);
  const nativeHost = await startCandidateFixture(t, {
    ...CANDIDATE_OPTIONS,
    candidateEntry: null,
    additionalExtensions: [nativeToolSearchSelector],
  });
  if (!nativeHost) return;
  const nativeEchoName = mcpToolName(nativeHost.serverName, "echo");
  const nativeInitial = await nativeHost.probeDump();
  assert.equal(observedTool(nativeInitial, "tool_search").exposure, "model-only");
  assert.ok(!nativeInitial.activeTools?.includes("tool_search"), "the native helper starts inactive before Pi selects it");
  await nativeHost.runCommand("/native-select-tool-search");
  assert.ok((await nativeHost.probeDump()).activeTools?.includes("tool_search"), "Pi's public native active-set seam selects tool_search");
  await nativeHost.setTurnScript([{
    toolCalls: [{ toolName: "tool_search", arguments: { query: nativeEchoName } }],
  }]);
  await nativeHost.promptTurn("Use Pi's native tool_search to load the permitted fixture echo tool.");
  const nativeSearchEnd = toolEnd(nativeHost, "tool_search");
  assert.ok(nativeSearchEnd, "Pi reports the native tool_search call");
  const nativeAfterSearch = await nativeHost.probeDump();
  assert.ok(nativeAfterSearch.activeTools?.includes(nativeEchoName), `Pi's native search declares echo: ${JSON.stringify(nativeSearchEnd.result)}`);

  const host = await startCandidateFixture(t, {
    ...CANDIDATE_OPTIONS,
    gateConfig: DEFERRED_OFF_CONFIG,
    wrapperDefault: true,
    additionalExtensions: [nativeToolSearchSelector],
  });
  if (!host) return;

  const echoName = mcpToolName(host.serverName, "echo");
  const counterName = mcpToolName(host.serverName, "counter");
  const initial = await host.probeDump();
  const nativeToolSearchName = "tool_search";
  assert.equal(observedTool(initial, nativeToolSearchName).exposure, "model-only");
  assert.ok(!initial.activeTools?.includes(nativeToolSearchName), "an unselected builtin helper remains inactive under deferred-off");
  assert.equal(observedTool(initial, echoName).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  assert.equal(observedTool(initial, counterName).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  assert.ok(initial.activeTools?.includes("codemode"), "wrapper-authorized root codemode is ordinary and selected while deferred tools are off");
  assert.ok(!initial.activeTools?.includes(echoName));
  assert.ok(!initial.activeTools?.includes(counterName));

  await host.setTurnScript([{ text: "Finished a text-only turn." }]);
  await host.promptTurn("Reply with the scripted text only.");
  const afterTextTurn = await host.probeDump();
  assert.ok(!afterTextTurn.activeTools?.includes(echoName), "turn-boundary reconciliation must not declare native echo");
  assert.ok(!afterTextTurn.activeTools?.includes(counterName), "turn-boundary reconciliation must not declare native counter");
  assert.ok(afterTextTurn.activeTools?.includes("codemode"));

  await host.runCommand("/native-select-tool-search");
  const afterNativeSelection = await host.probeDump();
  assert.ok(afterNativeSelection.activeTools?.includes(nativeToolSearchName), "a native Pi choice is present before managed reapply");
  await host.setTurnScript([{
    toolCalls: [{ toolName: nativeToolSearchName, arguments: { query: echoName } }],
  }]);
  await host.promptTurn("Use Pi's native tool_search to load the permitted fixture echo tool.");
  const candidateNativeSearchEnd = toolEnd(host, nativeToolSearchName);
  assert.ok(candidateNativeSearchEnd, "the selected native tool_search remains callable through the gate");
  const afterNativeSearch = await host.probeDump();
  assert.ok(afterNativeSearch.activeTools?.includes(echoName), `native tool_search loads authorized echo: ${JSON.stringify(candidateNativeSearchEnd.result)}`);
  assert.ok(afterNativeSearch.activeTools?.includes(counterName), "native server search may select its permitted server tools as a loadout");
  const nativeDirectMessage = "candidate-native-tool-search-call";
  await host.setTurnScript([{
    toolCalls: [{ toolName: echoName, arguments: { message: nativeDirectMessage } }],
  }]);
  await host.promptTurn("Call the native-search-selected echo tool directly.");
  assert.ok(toolEnd(host, echoName), "the selected native MCP tool remains callable directly");
  assert.deepEqual((await host.readServerEvents()).find((event) => event.event === "tool_call" && event.tool === "echo")?.arguments, { message: nativeDirectMessage });

  await host.setTurnScript([{
    toolCalls: [{ toolName: "search_tools", arguments: { query: echoName } }],
  }]);
  await host.promptTurn("Discover the native fixture echo tool.");
  matchSearchResult(host, "search_tools", /native-available[\s\S]*mcp__|native exposure/i);
  const afterSearch = await host.probeDump();
  assert.ok(afterSearch.activeTools?.includes(echoName), "review-gate discovery preserves Pi's earlier native declaration");
  assert.ok(afterSearch.activeTools?.includes(counterName), "review-gate discovery preserves Pi's entire native tool_search loadout");

  const message = "candidate-host-native-exposure";
  await host.setTurnScript([{
    codemode: `const echo = await tools.${echoName}({ message: ${JSON.stringify(message)} });\n`
      + `const counter = await tools.${counterName}({ label: "host-native-off" });\n`
      + "return JSON.stringify({ echo, counter });",
  }]);
  await host.promptTurn("Use native codemode to call the permitted echo and counter tools.");
  const hostEvents = await host.readServerEvents();
  assert.deepEqual(
    hostEvents.filter((event) => event.event === "tool_call").map((event) => event.tool),
    ["echo", "echo", "counter"],
    "the native direct call and both authorized nested calls reach the real MCP protocol server",
  );
  assert.deepEqual(hostEvents.filter((event) => event.event === "tool_call" && event.tool === "echo")[1]?.arguments, { message });
  assert.equal(await host.readCounter(), 1, "the authorized native counter call has a real fixture-local effect");
  const afterCalls = await host.probeDump();
  assert.ok(afterCalls.activeTools?.includes(echoName), "Pi's selected native echo stays declared across the nested call");
  assert.ok(afterCalls.activeTools?.includes(counterName), "Pi's selected native counter stays declared across the nested call");
  assert.ok(toolEnd(host, "codemode"), "Pi reports the model-facing root codemode execution");

  const beforeRotation = (await host.readServerEvents()).length;
  await host.rotateToolList(2);
  assert.ok(await host.waitForServerLog(
    (event) => event.event === "list_changed" && event.generation === 2,
    undefined,
    beforeRotation,
  ), "native Pi should receive the real tools/list_changed notification");
  assert.ok(await host.waitForServerLog(
    (event) => event.event === "tools_list" && event.generation === 2,
    undefined,
    beforeRotation,
  ), "native Pi should refresh the withdrawn tool list");
  const rotated = await host.probeDump();
  assert.equal(observedTool(rotated, echoName).exposure, "hidden", "Pi metadata records the withdrawn registration as hidden");
  assert.ok(!rotated.activeTools?.includes(echoName));
  const withdrawnEcho = mcpToolName(host.serverName, "echo_second");
  assert.equal(observedTool(rotated, withdrawnEcho).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  await host.setTurnScript([{
    toolCalls: [{ toolName: "search_tools", arguments: { query: echoName } }],
  }]);
  await host.promptTurn("Search for the withdrawn native echo name.");
  matchSearchResult(host, "search_tools", /No authorized tools matched/);
});

test("frozen native Pi worker can discover and call permitted native callees without promotion", { timeout: 300_000 }, async (t) => {
  const echoName = mcpToolName(DEFAULT_SERVER_NAME, "echo");
  const counterName = mcpToolName(DEFAULT_SERVER_NAME, "counter");
  // An actual executor bootstrap carries both native names in the immutable
  // CLI --tools ceiling, but its deferred-off gate overlay must still avoid
  // promoting either native callee into model declarations.
  const workerCatalog = createExecutorToolCatalog(
    ["read", "codemode", echoName, counterName],
    ["read", "codemode", echoName, counterName],
  );
  const worker = await startCandidateFixture(t, {
    ...CANDIDATE_OPTIONS,
    gateConfig: DEFERRED_OFF_CONFIG,
    executorToolCatalog: workerCatalog,
  });
  if (!worker) return;

  const workerEchoName = mcpToolName(worker.serverName, "echo");
  const workerCounterName = mcpToolName(worker.serverName, "counter");
  const workerInitial = await worker.probeDump();
  assert.equal(observedTool(workerInitial, workerEchoName).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  assert.ok(workerInitial.activeTools?.includes("codemode"), "worker CLI ceiling preserves its ordinary root codemode declaration");
  assert.ok(workerInitial.activeTools?.includes("search_tools"), `worker loader should remain declared: ${JSON.stringify(workerInitial.activeTools)}`);
  assert.ok(!workerInitial.activeTools?.includes(workerEchoName), "worker --tools ceiling does not imply a native model declaration");
  assert.ok(!workerInitial.activeTools?.includes(workerCounterName), "the native counter stays undeclared too");
  assert.equal(observedTool(workerInitial, workerCounterName).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  await worker.setTurnScript([{
    toolCalls: [{ toolName: "search_tools", arguments: { query: workerEchoName } }],
  }]);
  await worker.promptTurn("Discover the permitted native fixture echo tool in the worker.");
  const workerSearchResult = toolEnd(worker, "search_tools")?.result;
  const workerAfterSearch = await worker.probeDump();
  assert.ok(!workerAfterSearch.activeTools?.includes(workerEchoName), "worker discovery does not promote native echo");
  assert.ok(!workerAfterSearch.activeTools?.includes(workerCounterName));

  const workerMessage = "candidate-worker-native-exposure";
  await worker.setTurnScript([{
    codemode: `const echo = await tools.${workerEchoName}({ message: ${JSON.stringify(workerMessage)} });\n`
      + `const counter = await tools.${workerCounterName}({ label: "worker-native-off" });\n`
      + "return JSON.stringify({ echo, counter });",
  }]);
  await worker.promptTurn("Use worker codemode to call the permitted echo and counter tools.");
  const workerEventsAfterCalls = await worker.readServerEvents();
  assert.deepEqual(
    workerEventsAfterCalls.filter((event) => event.event === "tool_call").map((event) => event.tool),
    ["echo", "counter"],
    `permitted worker nested calls reach the real MCP protocol server; search_tools result: ${JSON.stringify(workerSearchResult)}; codemode result: ${JSON.stringify(toolEnd(worker, "codemode")?.result)}`,
  );
  assert.deepEqual(workerEventsAfterCalls.find((event) => event.event === "tool_call" && event.tool === "echo")?.arguments, { message: workerMessage });
  assert.equal(await worker.readCounter(), 1, "the permitted worker counter call has a real fixture-local effect");
  const workerCodemodeResult = toolEnd(worker, "codemode")?.result;
  assert.match(JSON.stringify(workerCodemodeResult), /echo:candidate-worker-native-exposure/);
  assert.match(JSON.stringify(workerCodemodeResult), /counter:1/);
  assert.match(JSON.stringify(workerSearchResult), /native-available[\s\S]*mcp__|native exposure/i,
    "worker search_tools discovers the authorized native exposure");
  const workerAfterCalls = await worker.probeDump();
  assert.ok(!workerAfterCalls.activeTools?.includes(workerEchoName));
  assert.ok(!workerAfterCalls.activeTools?.includes(workerCounterName));

  await worker.setTurnScript([{ text: "Finished a frozen-worker text-only turn." }]);
  await worker.promptTurn("Reply with the scripted worker text only.");
  const workerAfterText = await worker.probeDump();
  assert.ok(!workerAfterText.activeTools?.includes(workerEchoName), "frozen-worker reconciliation never declares its permitted native callee");
  assert.ok(!workerAfterText.activeTools?.includes(workerCounterName));
  assert.equal(await worker.readCounter(), 1, "the worker text-only turn leaves the prior native server effect unchanged");

  const beforeWorkerRotation = workerEventsAfterCalls.length;
  await worker.rotateToolList(2);
  assert.ok(await worker.waitForServerLog(
    (event) => event.event === "list_changed" && event.generation === 2,
    undefined,
    beforeWorkerRotation,
  ), "native worker Pi should receive the real tools/list_changed notification");
  assert.ok(await worker.waitForServerLog(
    (event) => event.event === "tools_list" && event.generation === 2,
    undefined,
    beforeWorkerRotation,
  ), "native worker Pi should refresh the withdrawn tool list");
  const workerLateEcho = mcpToolName(worker.serverName, "echo_second");
  const workerAfterRotation = await worker.probeDump();
  assert.equal(workerAfterRotation.allTools?.some((tool) => tool.name === workerLateEcho), false,
    "Pi's native CLI mask excludes the late name from worker registry metadata");
  assert.ok(!workerAfterRotation.activeTools?.includes(workerLateEcho), "late native registration stays outside the frozen worker ceiling");
  await worker.setTurnScript([{
    toolCalls: [{ toolName: "search_tools", arguments: { query: workerLateEcho } }],
  }]);
  await worker.promptTurn("Search for the late native tool outside the worker ceiling.");
  matchSearchResult(worker, "search_tools", /No authorized tools matched/);

  await worker.setTurnScript([{
    codemode: `try { await tools.${workerLateEcho}({ message: "outside-ceiling" }); return "unexpected success"; }\n`
      + "catch (error) { return `blocked:${String(error)}`; }",
  }]);
  await worker.promptTurn("Attempt a nested call to the late native tool outside the frozen worker ceiling.");
  const workerEventsAfterDeniedCall = await worker.readServerEvents();
  assert.equal(workerEventsAfterDeniedCall.filter((event) => event.event === "tool_call" && event.tool === "echo_second").length, 0,
    "the out-of-ceiling native call never reaches MCP");
  assert.equal(await worker.readCounter(), 1, "the out-of-ceiling attempt has no fixture-local effect");
  const workerDeniedResult = toolEnd(worker, "codemode")?.result;
  assert.match(JSON.stringify(workerDeniedResult), /blocked:/);
  const workerAfterDeniedCall = await worker.probeDump();
  assert.ok(!workerAfterDeniedCall.activeTools?.includes(workerEchoName));
  assert.ok(!workerAfterDeniedCall.activeTools?.includes(workerCounterName));
  assert.ok(!workerAfterDeniedCall.activeTools?.includes(workerLateEcho));
});
