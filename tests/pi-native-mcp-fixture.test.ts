import assert from "node:assert/strict";
import test from "node:test";
import {
  createNativeMcpFixture,
  DEFAULT_SERVER_NAME,
  describeFixturePrerequisites,
  mcpToolName,
  REGISTERED_EXPOSURE_FOR_CODENAME_SERVER,
  type FixtureEvent,
  type NativeMcpFixture,
  type NativeMcpFixtureOptions,
  type ProbeDump,
} from "./pi-native-mcp-fixture";
import { skipOrFail } from "./bridge-fakes";

const BASELINE_OPTIONS = {
  candidateEntry: null,
  timeouts: { requestMs: 30_000, connectMs: 30_000, turnMs: 60_000, dumpMs: 10_000 },
} satisfies NativeMcpFixtureOptions;

type FixtureTestContext = {
  skip(message?: string): void;
  after(callback: () => void | Promise<void>): void;
};

/** Start the installed native Pi host only; candidateEntry:null is intentional. */
async function startNativeFixture(
  t: FixtureTestContext,
  options: NativeMcpFixtureOptions = BASELINE_OPTIONS,
): Promise<NativeMcpFixture | undefined> {
  const prerequisites = describeFixturePrerequisites(options);
  if (!prerequisites.ok) {
    skipOrFail(t, `native MCP fixture prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
    return undefined;
  }

  const fixture = createNativeMcpFixture(options);
  // Register cleanup before startup so failed assertions and startup errors
  // still terminate the child and remove its synthetic HOME/project/session.
  t.after(async () => {
    if (fixture.paths?.scratch) await fixture.dispose();
  });
  await fixture.start();
  const initialized = await fixture.waitForServerLog((event) => event.event === "initialize");
  assert.ok(initialized, "native MCP server should receive initialize before baseline assertions");
  return fixture;
}

function observedMcpTool(dump: ProbeDump, name: string): NonNullable<ProbeDump["allTools"]>[number] {
  const tool = dump.allTools?.find((candidate) => candidate.name === name);
  assert.ok(tool, `actual Pi tool metadata should contain ${name}; observed ${JSON.stringify(dump.allTools)}`);
  return tool;
}

function collectTypedRecords(value: unknown, result: FixtureEvent[] = []): FixtureEvent[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTypedRecords(item, result);
  } else if (typeof value === "object" && value !== null) {
    const record = value as FixtureEvent;
    if (typeof record.type === "string") result.push(record);
    for (const nested of Object.values(record)) collectTypedRecords(nested, result);
  }
  return result;
}

/** Check Pi's parent lineage only when the RPC stream exposes both sides. */
function assertNestedParentLinkageWhenExposed(fixture: NativeMcpFixture): void {
  const records = collectTypedRecords(fixture.sessionEvents);
  const codemodeParentIds = new Set(
    records
      .filter((event) => event.toolName === "codemode")
      .map((event) => event.toolCallId)
      .filter((id): id is string => typeof id === "string"),
  );
  const nestedCalls = records.filter((event) => typeof event.parentToolCallId === "string");
  if (codemodeParentIds.size > 0 && nestedCalls.length > 0) {
    assert.ok(
      nestedCalls.some((event) => codemodeParentIds.has(event.parentToolCallId as string)),
      "exposed nested MCP events should carry the observed codemode parentToolCallId",
    );
  }
}

test("native Pi codemode executes real fixture MCP echo and counter calls", { timeout: 180_000 }, async (t) => {
  const fixture = await startNativeFixture(t);
  if (!fixture) return;

  const echoName = mcpToolName(fixture.serverName, "echo");
  const counterName = mcpToolName(fixture.serverName, "counter");
  const inventory = await fixture.probeDump();
  assert.equal(
    observedMcpTool(inventory, echoName).exposure,
    REGISTERED_EXPOSURE_FOR_CODENAME_SERVER,
    "assert native Pi's reported tool metadata, not an inferred exposure from mcp.json",
  );
  observedMcpTool(inventory, counterName);

  const message = "native-mcp-fixture-baseline";
  await fixture.setTurnScript([{
    codemode: `const echo = await tools.${echoName}({ message: ${JSON.stringify(message)} });\n`
      + `const counter = await tools.${counterName}({ label: "successful-baseline" });\n`
      + "return JSON.stringify({ echo, counter });",
  }]);
  await fixture.promptTurn("Run the fixture echo and counter tools.");

  const serverEvents = await fixture.readServerEvents();
  const calls = serverEvents.filter((event) => event.event === "tool_call");
  assert.deepEqual(calls.map((event) => event.tool), ["echo", "counter"], "real MCP tools/call requests should reach the server in script order");
  assert.deepEqual(calls[0]?.arguments, { message });
  assert.deepEqual(calls[1]?.arguments, { label: "successful-baseline" });
  assert.ok(serverEvents.some((event) => event.event === "tool_result" && event.tool === "echo" && event.messageChars === message.length));
  assert.ok(serverEvents.some((event) => event.event === "tool_result" && event.tool === "counter" && event.count === 1));
  assert.equal(await fixture.readCounter(), 1, "the real counter tool should leave an observable filesystem effect");
  assert.ok(fixture.sessionEvents.some((event) => event.type === "agent_settled"), "the real Pi RPC turn should settle");
  assertNestedParentLinkageWhenExposed(fixture);
});

test("fixture probe simulation (NOT the review gate): ordinary tool_call denial leaves counter unchanged", { timeout: 180_000 }, async (t) => {
  const fixture = await startNativeFixture(t);
  if (!fixture) return;

  const counterName = mcpToolName(fixture.serverName, "counter");
  const inventory = await fixture.probeDump();
  observedMcpTool(inventory, counterName);
  const beforeEvents = await fixture.readServerEvents();
  const beforeCalls = beforeEvents.filter((event) => event.event === "tool_call").length;
  const beforeCounter = await fixture.readCounter();

  // This deny file activates only the fixture probe's Pi `tool_call` handler.
  // It is deliberately not evidence of candidate/review-gate behavior.
  await fixture.setDenial({ tools: [counterName], reason: "fixture baseline denial simulation" });
  await fixture.setTurnScript([{
    codemode: `const result = await tools.${counterName}({ label: "probe-denied" });\nreturn JSON.stringify(result);`,
  }]);
  await fixture.promptTurn("Attempt the counter through the fixture denial probe.");

  const afterEvents = await fixture.readServerEvents();
  assert.equal(
    afterEvents.filter((event) => event.event === "tool_call").length,
    beforeCalls,
    "the probe-simulated blocking hook should stop the call before MCP tools/call reaches the server",
  );
  assert.equal(await fixture.readCounter(), beforeCounter, "denial should leave the fixture counter unchanged");
  assert.ok(fixture.sessionEvents.some((event) => event.type === "agent_settled"), "Pi should finish the probe-denied turn");

  const records = collectTypedRecords(fixture.sessionEvents);
  const codemodeParent = records.find((event) => event.type === "tool_execution_start" && event.toolName === "codemode");
  assert.equal(typeof codemodeParent?.toolCallId, "string", "Pi should report the model-issued codemode call");
  const deniedNestedCall = records.find((event) =>
    event.type === "tool_execution_end"
    && event.toolName === counterName
    && event.isError === true
    && event.parentToolCallId === codemodeParent?.toolCallId,
  );
  assert.ok(deniedNestedCall, "Pi should report the probe-blocked nested tool result with codemode parent linkage");
  assert.match(JSON.stringify(deniedNestedCall.result), /fixture baseline denial simulation/);
});

test("native MCP list rotation withdraws/re-registers tools and reconnect preserves counter state in-session", { timeout: 240_000 }, async (t) => {
  const fixture = await startNativeFixture(t);
  if (!fixture) return;

  const oldEchoName = mcpToolName(fixture.serverName, "echo");
  const newEchoName = mcpToolName(fixture.serverName, "echo_second");
  const counterName = mcpToolName(fixture.serverName, "counter");
  const initial = await fixture.probeDump();
  observedMcpTool(initial, oldEchoName);
  const eventsBeforeRotation = (await fixture.readServerEvents()).length;

  await fixture.rotateToolList(2);
  const changed = await fixture.waitForServerLog(
    (event) => event.event === "list_changed" && event.generation === 2,
    undefined,
    eventsBeforeRotation,
  );
  assert.ok(changed, "fixture server should send notifications/tools/list_changed");
  const refreshedList = await fixture.waitForServerLog(
    (event) => event.event === "tools_list" && event.generation === 2,
    undefined,
    eventsBeforeRotation,
  );
  assert.ok(refreshedList, "native Pi should request the rotated tools/list");

  const rotated = await fixture.probeDump();
  // Pi retains the old registry record as hidden after list withdrawal; assert
  // that runtime metadata rather than inferring a loader promotion from config.
  // This is not a review-gate hidden-exposure contract or candidate assertion.
  const withdrawn = observedMcpTool(rotated, oldEchoName);
  assert.equal(withdrawn.exposure, "hidden", "actual Pi metadata should hide the withdrawn old echo registration");
  assert.ok(!rotated.activeTools?.includes(oldEchoName), "the withdrawn native MCP tool should no longer be active");
  const replacement = observedMcpTool(rotated, newEchoName);
  assert.equal(replacement.exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  observedMcpTool(rotated, counterName);

  await fixture.setTurnScript([{
    codemode: `const echo = await tools.${newEchoName}({ message: "generation-two" });\n`
      + `const counter = await tools.${counterName}({ label: "before-reconnect" });\n`
      + "return JSON.stringify({ echo, counter });",
  }]);
  await fixture.promptTurn("Use the rotated echo tool and increment the counter.");
  assert.equal(await fixture.readCounter(), 1, "the rotated native registration should call the real server");

  const childPid = fixture.childPid;
  const beforeReconnect = await fixture.readServerEvents();
  const initializeCount = beforeReconnect.filter((event) => event.event === "initialize").length;
  await fixture.runCommand(`/mcp reconnect ${fixture.serverName}`);
  const reconnected = await fixture.waitForServerLog(
    (event) => event.event === "initialize",
    undefined,
    beforeReconnect.length,
  );
  assert.ok(reconnected, "native /mcp reconnect should start a new MCP connection");
  assert.equal(fixture.childPid, childPid, "reconnect should happen inside the same native Pi RPC child/session");
  assert.equal(
    (await fixture.readServerEvents()).filter((event) => event.event === "initialize").length,
    initializeCount + 1,
    "reconnect should create exactly one new native MCP server connection",
  );
  const afterReconnect = await fixture.probeDump();
  assert.equal(observedMcpTool(afterReconnect, oldEchoName).exposure, "hidden");
  assert.ok(!afterReconnect.activeTools?.includes(oldEchoName));
  observedMcpTool(afterReconnect, newEchoName);

  await fixture.setTurnScript([{
    codemode: `return await tools.${counterName}({ label: "after-reconnect" });`,
  }]);
  await fixture.promptTurn("Increment the counter after native reconnect.");
  assert.equal(await fixture.readCounter(), 2, "counter state should continue across the native server reconnect");
  const finalCalls = (await fixture.readServerEvents()).filter((event) => event.event === "tool_call");
  assert.ok(finalCalls.some((event) => event.tool === "echo_second" && event.generation === 2));
  assert.deepEqual(finalCalls.filter((event) => event.tool === "counter").map((event) => event.generation), [2, 2]);
});

test("explicit piArgs tool exclusion is observed in native Pi metadata", { timeout: 180_000 }, async (t) => {
  const fixture = await startNativeFixture(t, {
    ...BASELINE_OPTIONS,
    serverName: DEFAULT_SERVER_NAME,
    serverExposure: "direct",
    piArgs: ["--exclude-tools", mcpToolName(DEFAULT_SERVER_NAME, "counter")],
  });
  if (!fixture) return;

  const echoName = mcpToolName(fixture.serverName, "echo");
  const counterName = mcpToolName(fixture.serverName, "counter");
  const advertisedCounter = await fixture.waitForServerLog((event) =>
    event.event === "tools_list" && Array.isArray(event.tools) && event.tools.includes("counter"),
  );
  assert.ok(advertisedCounter, "the fixture server should advertise counter before native --exclude-tools filters its registration");
  const inventory = await fixture.probeDump();
  const echo = observedMcpTool(inventory, echoName);
  assert.equal(echo.exposure, "direct", "native Pi metadata should report the configured direct tool registration");
  assert.equal(
    inventory.allTools?.some((tool) => tool.name === counterName),
    false,
    "consumer-owned --exclude-tools should remove the named tool from Pi's actual registry metadata",
  );
  assert.ok(inventory.activeTools?.includes(echoName), "the unrestricted direct MCP tool should remain active");
  assert.ok(!inventory.activeTools?.includes(counterName), "the excluded native tool must not be active");
});
