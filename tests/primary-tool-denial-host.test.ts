/**
 * Issue #434 real-host enforcement and diagnostics for the primary agent's
 * top-level tool denial.
 *
 * These cases drive the REAL installed Pi (`pi --mode rpc`, the same hermetic
 * native fixture the other native suites use) with the freshly compiled
 * candidate (PI_REVIEW_GATE_CANDIDATE_ENTRY, never the checkout's live dist/),
 * a scripted in-process model (no provider, credential, or network), synthetic
 * HOME/agent dir, and a synthetic trusted-project MCP server that instruments
 * every tools/call it receives. Each case asserts what actually happened:
 *
 * - a top-level denied MCP tool is removed from the model-visible declarations
 *   and cannot execute through a codemode wrapper (the nested invocation path)
 *   or through a direct model call;
 * - a permitted wrapper that forwards ctx.executeTool() for a denied
 *   direct-exposure tool cannot execute it either, and Pi's recorded nested
 *   call lets the runtime preserve the wrapper's own outcome while appending
 *   the primary settings explanation;
 * - a delegated executor's early unknown-tool result is explained from its
 *   captured catalog alone, with no deny-selector attribution;
 * - the denied call never reaches the MCP server (no tools/call event, counter
 *   unchanged), so no side effect occurred;
 * - the model-visible policy diagnostic names the settings denial, states that
 *   nothing executed, and names the role scope; Pi's own early unknown-tool
 *   result is clarified through the documented message_end seam rather than
 *   left as a bare "not found";
 * - an exact-name tool_search for the denied tool reports the denial and
 *   activates nothing.
 *
 * Deliberately NOT covered here (documented, not faked): native codemode
 * metadata visibility (ALL_TOOLS/searchTools/ctx.tools) remains Pi-owned and
 * is accepted residual scope, and a model-driven executor admission matrix,
 * which the hermetic unit suites cover against the real catalog/admission
 * code. One residual path IS pinned below: codemode's own proxy rejects a
 * non-callable direct-exposure member before any nested call exists, so Pi's
 * truthful "does not exist" error is preserved with no settings attribution
 * (there is no host record to attribute).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createNativeMcpFixture,
  DEFAULT_SERVER_NAME,
  describeFixturePrerequisites,
  mcpToolName,
  type FixtureEvent,
  type NativeMcpFixture,
  type NativeMcpFixtureOptions,
} from "./pi-native-mcp-fixture";
import { skipOrFail } from "./bridge-fakes";

const TIMEOUTS = { requestMs: 30_000, connectMs: 30_000, turnMs: 90_000, dumpMs: 10_000 } as const;
const CODEMODE = "codemode";
const SERVER_ECHO = mcpToolName(DEFAULT_SERVER_NAME, "echo");
const SERVER_COUNTER = mcpToolName(DEFAULT_SERVER_NAME, "counter");

/** Gate config with the two independent deny lists; only the primary list is exercised here. */
function denyGateConfig(deniedTools: string[], deferredPiTools = true): object {
  return {
    enabled: true,
    operatingMode: "execute",
    review: { activeReviewers: [], primaryEnabled: false, subtaskEnabled: false },
    execution: { deferredPiTools },
    tools: { topLevelDeny: deniedTools, executorDeny: [] },
  };
}

async function startCandidate(
  t: TestContext,
  options: Omit<NativeMcpFixtureOptions, "candidateEntry" | "timeouts" | "gateConfig"> & {
    serverExposure: "direct" | "codemode";
    deniedTools: string[];
  },
): Promise<NativeMcpFixture | undefined> {
  const candidateEntry = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
  if (!candidateEntry) {
    skipOrFail(t, "real-host tool denial diagnostics require PI_REVIEW_GATE_CANDIDATE_ENTRY pointing to the freshly compiled candidate src/index.js");
    return undefined;
  }
  const resolvedCandidate = resolvePath(candidateEntry);
  assert.notEqual(
    resolvedCandidate,
    resolvePath(process.cwd(), "dist/src/index.js"),
    "this suite must not silently exercise the checkout's live dist/",
  );
  const { serverExposure, deniedTools, ...nativeOptions } = options;
  const fixtureOptions: NativeMcpFixtureOptions = {
    ...nativeOptions,
    serverExposure,
    candidateEntry: resolvedCandidate,
    timeouts: TIMEOUTS,
    gateConfig: denyGateConfig(deniedTools),
  };
  const prerequisites = describeFixturePrerequisites(fixtureOptions);
  if (!prerequisites.ok) {
    skipOrFail(t, `real-host tool denial prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
    return undefined;
  }
  const fixture = createNativeMcpFixture(fixtureOptions);
  t.after(async () => {
    if (fixture.paths?.scratch) await fixture.dispose();
  });
  await fixture.start();
  await initSyntheticGitProject(fixture);
  const initialized = await fixture.waitForServerLog((event) => event.event === "initialize");
  assert.ok(initialized, "the real Pi MCP client should connect to the anonymized fixture server");
  return fixture;
}

/** The candidate's review-window checkpoint path needs a real, disposable Git baseline before turns. */
async function initSyntheticGitProject(fixture: NativeMcpFixture): Promise<void> {
  const { project, scratch } = fixture.paths;
  const hooks = join(scratch, "deny-git-hooks");
  const template = join(scratch, "deny-git-template");
  const globalConfig = join(scratch, "deny-empty-gitconfig");
  const xdgConfig = join(scratch, "deny-xdg-config");
  await Promise.all([
    mkdir(hooks, { recursive: true }),
    mkdir(template, { recursive: true }),
    mkdir(xdgConfig, { recursive: true }),
    writeFile(globalConfig, "", "utf8"),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    HOME: scratch,
    USERPROFILE: scratch,
    XDG_CONFIG_HOME: xdgConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
  });
  const runGit = (args: string[]): void => {
    execFileSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], {
      cwd: project, env, stdio: "pipe", timeout: 10_000,
    });
  };
  runGit(["init", "--quiet", `--template=${template}`]);
  runGit(["config", "user.name", "Pi native deny fixture"]);
  runGit(["config", "user.email", "pi-native-deny@example.invalid"]);
  runGit(["add", ".pi/mcp.json"]);
  runGit(["-c", "commit.gpgSign=false", "commit", "--no-gpg-sign", "--quiet", "-m", "synthetic MCP fixture baseline"]);
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

/** Require a real root tool execution and its actual Pi result; scripted provider intent alone is not evidence. */
function rootToolResult(fixture: NativeMcpFixture, toolName: string, isError?: boolean): FixtureEvent {
  const rootRecords = collectTypedRecords(fixture.sessionEvents).filter((event) =>
    event.toolName === toolName && event.parentToolCallId == null,
  );
  assert.ok(
    rootRecords.some((event) => event.type === "tool_execution_start"),
    `Pi should report the attempted root call to ${toolName}; observed ${JSON.stringify(rootRecords)}`,
  );
  const ended = rootRecords.filter((event) => event.type === "tool_execution_end").at(-1);
  assert.ok(ended, `Pi should report the root result for ${toolName}; observed ${JSON.stringify(rootRecords)}`);
  if (isError !== undefined) {
    assert.equal(ended.isError === true, isError, `unexpected ${toolName} result: ${JSON.stringify(ended)}`);
  }
  return ended;
}

function resultText(event: FixtureEvent): string {
  const result = (event.result ?? event) as { content?: Array<{ text?: string }> };
  return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

async function runSearchCall(fixture: NativeMcpFixture, query: string, expectError: boolean): Promise<FixtureEvent> {
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "tool_search", arguments: { query } }] },
    { text: "fixture-search-settled" },
  ]);
  await fixture.promptTurn(`Search authorized tools for ${query}.`);
  return rootToolResult(fixture, "tool_search", expectError);
}

test("real host: a top-level denied MCP tool is undeclared and cannot execute through a codemode wrapper; it reports the settings denial (#434)", { timeout: 240_000 }, async (t) => {
  const fixture = await startCandidate(t, { serverExposure: "codemode", deniedTools: [SERVER_ECHO] });
  if (!fixture) return;

  const inventory = await fixture.waitForRegisteredTools([SERVER_ECHO, SERVER_COUNTER]);
  assert.equal(inventory.allTools?.find((tool) => tool.name === SERVER_ECHO)?.exposure, "deferred");
  assert.ok(!inventory.activeTools?.includes(SERVER_ECHO), "the denied MCP tool is not declared to the model");
  assert.ok(!inventory.activeTools?.includes(SERVER_COUNTER), "an unactivated MCP tool is not declared");

  // Activate the script transport through the real loader (the nested call path).
  const gateSearch = await runSearchCall(fixture, CODEMODE, false);
  assert.match(resultText(gateSearch), /Activated/);
  assert.match(resultText(gateSearch), new RegExp(CODEMODE));

  // A codemode wrapper tries the denied tool: the nested invocation is blocked.
  await fixture.setTurnScript([
    { codemode: `return await tools.${SERVER_ECHO}({ message: "denied-nested-attempt" });` },
    { text: "fixture-nested-deny-settled" },
  ]);
  await fixture.promptTurn("Attempt the denied MCP tool through a codemode wrapper.");
  const codemodeResult = rootToolResult(fixture, CODEMODE, true);
  assert.match(resultText(codemodeResult), /Top-level tools/, `the nested denial names the settings cause: ${resultText(codemodeResult)}`);
  assert.match(resultText(codemodeResult), /cannot bypass the denial/);

  // The blocked nested call never reached the server and had no side effect.
  const events = await fixture.readServerEvents();
  assert.deepEqual(events.filter((event) => event.event === "tool_call"), [], "the denied nested call must not reach MCP tools/call");
  assert.equal(await fixture.readCounter(), 0, "the denied nested call must have no counter side effect");

  // Exact-name search reports the denial and activates nothing.
  const deniedSearch = await runSearchCall(fixture, SERVER_ECHO, true);
  assert.match(resultText(deniedSearch), /Denied for the primary agent by review-gate settings/);
  assert.match(resultText(deniedSearch), new RegExp(SERVER_ECHO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(resultText(deniedSearch), /cannot bypass the denial/);
  const after = await fixture.probeDump();
  assert.ok(!after.activeTools?.includes(SERVER_ECHO), "a denied exact-name search activated nothing");
  assert.deepEqual((await fixture.readServerEvents()).filter((event) => event.event === "tool_call"), []);
});

test("real host: a direct call to a top-level denied direct-exposure MCP tool never executes and the early not-found result is clarified (#434)", { timeout: 240_000 }, async (t) => {
  const fixture = await startCandidate(t, { serverExposure: "direct", deniedTools: [SERVER_ECHO], nestedRelay: true });
  if (!fixture) return;

  const inventory = await fixture.waitForRegisteredTools([SERVER_ECHO, SERVER_COUNTER]);
  assert.equal(inventory.allTools?.find((tool) => tool.name === SERVER_ECHO)?.exposure, "direct");

  await fixture.setTurnScript([
    { toolCalls: [{ toolName: SERVER_ECHO, arguments: { message: "denied-direct-attempt" } }] },
    { text: "fixture-direct-deny-settled" },
  ]);
  await fixture.promptTurn("Attempt the denied MCP tool directly.");

  // The turn-boundary reconciliation removes the denied direct-exposure tool
  // from the model-visible declarations before this request, so Pi's own early
  // lookup refuses it before any execution.
  const afterTurn = await fixture.probeDump();
  assert.ok(!afterTurn.activeTools?.includes(SERVER_ECHO), "the denied direct-exposure tool is removed from declarations");
  const ended = rootToolResult(fixture, SERVER_ECHO, true);
  assert.match(resultText(ended), /not found/, `the raw early result is Pi's unknown-tool error: ${resultText(ended)}`);

  // The documented message_end seam clarifies the model-visible result honestly.
  const journal = fixture.readProbeJournal();
  const deniedResults = journal.flatMap((entry) => Array.isArray(entry.mcpToolResults) ? entry.mcpToolResults as Array<Record<string, unknown>> : []);
  const deniedResult = deniedResults.find((entry) => entry.toolName === SERVER_ECHO);
  assert.ok(deniedResult, `the model-visible denied tool result should be journaled: ${JSON.stringify(journal)}`);
  assert.equal(deniedResult.isError, true);
  assert.match(String(deniedResult.text), /Top-level tools/, `the clarified result names the settings cause: ${String(deniedResult.text)}`);
  assert.match(String(deniedResult.text), /no operation was performed/);

  // A permitted wrapper that forwards ctx.executeTool() for the denied
  // direct-exposure tool also takes Pi's early lookup path (the codemode proxy
  // pre-checks membership, so the opt-in relay stands in for such a wrapper).
  // Pi records the nested call on the wrapper's result, letting the runtime
  // preserve the wrapper outcome and explain the denial.
  const relaySearch = await runSearchCall(fixture, "prgNestedRelay", false);
  assert.match(resultText(relaySearch), /prgNestedRelay/);
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "prgNestedRelay", arguments: { tool: SERVER_ECHO, arguments: { message: "denied-nested-relay" } } }] },
    { text: "fixture-nested-relay-settled" },
  ]);
  await fixture.promptTurn("Forward a nested call to the denied MCP tool through a permitted wrapper.");
  const wrapperEnded = rootToolResult(fixture, "prgNestedRelay");
  assert.match(resultText(wrapperEnded), /relay-/, `the wrapper ran and returned its own result: ${resultText(wrapperEnded)}`);
  const relayResults = fixture.readProbeJournal()
    .flatMap((entry) => Array.isArray(entry.toolResults) ? entry.toolResults as Array<Record<string, unknown>> : [])
    .filter((entry) => entry.toolName === "prgNestedRelay");
  const relayResult = relayResults.at(-1);
  assert.ok(relayResult, `the model-visible wrapper result should be journaled: ${JSON.stringify(relayResults)}`);
  assert.match(String(relayResult.text), /Top-level tools/, `the wrapper result explains the nested denial: ${String(relayResult.text)}`);
  assert.match(String(relayResult.text), /nested tool call/);
  assert.deepEqual((await fixture.readServerEvents()).filter((event) => event.event === "tool_call"), [], "the denied nested call must not reach MCP tools/call");
  assert.equal(await fixture.readCounter(), 0, "the denied nested call must have no counter side effect");

  // No execution and no server side effect.
  const events = await fixture.readServerEvents();
  assert.deepEqual(events.filter((event) => event.event === "tool_call"), [], "the denied direct call must not reach MCP tools/call");
  assert.equal(await fixture.readCounter(), 0, "the denied direct call must have no counter side effect");
});

test("real host: an executor's early unknown-tool results explain its captured permissions without deny attribution (#434)", { timeout: 240_000 }, async (t) => {
  const fixture = await startCandidate(t, {
    serverExposure: "direct",
    deniedTools: [],
    nestedRelay: true,
    executorToolCatalog: { allowedToolCatalog: ["read", "prgNestedRelay"], initialActiveTools: ["read", "prgNestedRelay"] },
  });
  if (!fixture) return;

  await fixture.waitForRegisteredTools([SERVER_ECHO, "prgNestedRelay"]);
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: SERVER_ECHO, arguments: { message: "executor-outside-catalog" } }] },
    { text: "fixture-executor-missing-settled" },
  ]);
  await fixture.promptTurn("Attempt a tool outside this executor's captured permissions.");

  const ended = rootToolResult(fixture, SERVER_ECHO, true);
  assert.match(resultText(ended), /not found/);
  const journal = fixture.readProbeJournal();
  const deniedResult = journal
    .flatMap((entry) => Array.isArray(entry.mcpToolResults) ? entry.mcpToolResults as Array<Record<string, unknown>> : [])
    .find((entry) => entry.toolName === SERVER_ECHO);
  assert.ok(deniedResult, `the model-visible executor result should be journaled: ${JSON.stringify(journal)}`);
  assert.match(String(deniedResult.text), /captured tool permissions/, `the executor result explains the captured limit: ${String(deniedResult.text)}`);
  assert.match(String(deniedResult.text), /nothing was executed/);
  assert.doesNotMatch(String(deniedResult.text), /Top-level tools|settings deny|executor deny/i, "the executor never attributes the omission to a deny selector");

  // An allowed wrapper (the fixture relay) forwarding ctx.executeTool() for the
  // same excluded tool also takes Pi's early lookup path; its captured nested
  // failure must be explained while the wrapper's own result is preserved.
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "prgNestedRelay", arguments: { tool: SERVER_ECHO, arguments: { message: "executor-nested-relay" } } }] },
    { text: "fixture-executor-relay-settled" },
  ]);
  await fixture.promptTurn("Forward a nested call to a tool outside this executor's captured permissions.");
  const relayEnded = rootToolResult(fixture, "prgNestedRelay");
  assert.match(resultText(relayEnded), /relay-/, `the wrapper ran and returned its own result: ${resultText(relayEnded)}`);
  const relayResults = fixture.readProbeJournal()
    .flatMap((entry) => Array.isArray(entry.toolResults) ? entry.toolResults as Array<Record<string, unknown>> : [])
    .filter((entry) => entry.toolName === "prgNestedRelay");
  const relayResult = relayResults.at(-1);
  assert.ok(relayResult, `the model-visible executor wrapper result should be journaled: ${JSON.stringify(relayResults)}`);
  assert.match(String(relayResult.text), /captured tool permissions/, `the executor wrapper result explains the nested limit: ${String(relayResult.text)}`);
  assert.match(String(relayResult.text), /nested tool/);
  assert.doesNotMatch(String(relayResult.text), /Top-level tools|settings deny|executor deny/i, "the executor never attributes the omission to a deny selector");

  assert.deepEqual((await fixture.readServerEvents()).filter((event) => event.event === "tool_call"), [], "the denied executor calls must not reach MCP tools/call");
  assert.equal(await fixture.readCounter(), 0, "the denied executor calls must have no counter side effect");
});

test("real host: a direct-exposure denied tool reached from codemode fails at the proxy with no settings attribution and no side effect (#434)", { timeout: 240_000 }, async (t) => {
  // Pi's codemode sandbox builds its `tools` proxy from the callable set, so a
  // direct-exposure tool the primary deny list removed from declarations is
  // rejected by the proxy before ctx.executeTool() runs: no nested call record
  // exists for the runtime to attribute, and the runtime deliberately does not
  // derive a settings cause from the sandbox's error text. This case pins that
  // residual boundary: Pi's own truthful unknown-member error is preserved, no
  // settings/denial attribution is appended, and nothing executes.
  const fixture = await startCandidate(t, { serverExposure: "direct", deniedTools: [SERVER_ECHO] });
  if (!fixture) return;

  await fixture.waitForRegisteredTools([SERVER_ECHO, SERVER_COUNTER]);
  const gateSearch = await runSearchCall(fixture, CODEMODE, false);
  assert.match(resultText(gateSearch), /Activated/);

  await fixture.setTurnScript([
    { codemode: `return await tools.${SERVER_ECHO}({ message: "denied-proxy-attempt" });` },
    { text: "fixture-proxy-deny-settled" },
  ]);
  await fixture.promptTurn("Attempt the denied direct-exposure MCP tool through a codemode script.");

  const codemodeResult = rootToolResult(fixture, CODEMODE, true);
  const text = resultText(codemodeResult);
  assert.match(text, /does not exist/, `the proxy keeps Pi's truthful unknown-member error: ${text}`);
  assert.doesNotMatch(text, /Top-level tools|settings deny|executor deny/i,
    "the runtime never attributes a proxy early rejection it has no record for");
  const details = (codemodeResult.result as { details?: { calls?: unknown[] } } | undefined)?.details;
  assert.deepEqual(details?.calls, [], "a proxy rejection creates no nested call record to attribute");

  assert.deepEqual((await fixture.readServerEvents()).filter((event) => event.event === "tool_call"), [],
    "the proxy-rejected member must not reach MCP tools/call");
  assert.equal(await fixture.readCounter(), 0, "the proxy-rejected member must have no counter side effect");
});
