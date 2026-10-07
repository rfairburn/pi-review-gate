import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { join, resolve } from "node:path";
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
import { RESEARCH_ALLOWED_TOOLS } from "../src/execution/tool";
import {
  createExecutorToolCatalog,
  defaultExecutorInitialActiveTools,
} from "../src/execution/tool-catalog";

const TIMEOUTS = { requestMs: 30_000, connectMs: 30_000, turnMs: 60_000, dumpMs: 10_000 } as const;
const CODEMODE = "codemode";

/**
 * Offline native RPC coverage only: automatic primary review is disabled, so this proves candidate tool permissions/results,
 * not reviewer execution or full evidence review. Existing review/evidence tests own those paths.
 */
function gateConfig(operatingMode: "execute" | "plan-research" = "execute", deferredPiTools = true): object {
  return {
    enabled: true,
    operatingMode,
    review: { activeReviewers: [], primaryEnabled: false, subtaskEnabled: false },
    execution: { deferredPiTools },
  };
}

/** Never fall back to the checkout's possibly stale dist/; the runner must name its compiled candidate explicitly. */
async function startCandidate(
  t: TestContext,
  options: Omit<NativeMcpFixtureOptions, "candidateEntry" | "timeouts" | "gateConfig"> & {
    operatingMode?: "execute" | "plan-research";
    deferredPiTools?: boolean;
  } = {},
): Promise<NativeMcpFixture | undefined> {
  const candidateEntry = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
  if (!candidateEntry) {
    skipOrFail(t, "native tool policy requires PI_REVIEW_GATE_CANDIDATE_ENTRY pointing to the freshly compiled candidate src/index.js");
    return undefined;
  }
  const resolvedCandidate = resolve(candidateEntry);
  assert.notEqual(
    resolvedCandidate,
    resolve(process.cwd(), "dist/src/index.js"),
    "native policy tests must not silently exercise the checkout's live dist/",
  );
  const { operatingMode, deferredPiTools, ...nativeOptions } = options;
  const fixtureOptions: NativeMcpFixtureOptions = {
    ...nativeOptions,
    candidateEntry: resolvedCandidate,
    timeouts: TIMEOUTS,
    gateConfig: gateConfig(operatingMode, deferredPiTools),
  };
  const prerequisites = describeFixturePrerequisites(fixtureOptions);
  if (!prerequisites.ok) {
    skipOrFail(t, `native tool policy prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
    return undefined;
  }

  const fixture = createNativeMcpFixture(fixtureOptions);
  // Cleanup is registered before startup so assertion/startup failures still reap the host and scratch tree.
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
  const hooks = join(scratch, "policy-git-hooks");
  const template = join(scratch, "policy-git-template");
  const globalConfig = join(scratch, "policy-empty-gitconfig");
  const xdgConfig = join(scratch, "policy-xdg-config");
  await Promise.all([
    mkdir(hooks, { recursive: true }),
    mkdir(template, { recursive: true }),
    mkdir(xdgConfig, { recursive: true }),
    writeFile(globalConfig, "", "utf8"),
  ]);
  // Never inherit Git directory/index/config overrides or caller hooks/templates.
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
  runGit(["config", "user.name", "Pi native policy fixture"]);
  runGit(["config", "user.email", "pi-native-policy@example.invalid"]);
  runGit(["add", ".pi/mcp.json"]);
  runGit(["-c", "commit.gpgSign=false", "commit", "--no-gpg-sign", "--quiet", "-m", "synthetic MCP fixture baseline"]);
}

function echoName(fixture: NativeMcpFixture): string {
  return mcpToolName(fixture.serverName, "echo");
}

function counterName(fixture: NativeMcpFixture): string {
  return mcpToolName(fixture.serverName, "counter");
}

function observedTool(dump: ProbeDump, name: string): NonNullable<ProbeDump["allTools"]>[number] | undefined {
  return dump.allTools?.find((tool) => tool.name === name);
}

function requireTool(dump: ProbeDump, name: string): NonNullable<ProbeDump["allTools"]>[number] {
  const tool = observedTool(dump, name);
  assert.ok(tool, `actual Pi getAllTools() inventory should contain ${name}; observed ${JSON.stringify(dump.allTools)}`);
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

/** Require a real root tool execution and its actual Pi result; scripted provider intent alone is not evidence. */
function rootToolResult(fixture: NativeMcpFixture, toolName: string, isError: boolean): FixtureEvent {
  const rootRecords = collectTypedRecords(fixture.sessionEvents).filter((event) =>
    event.toolName === toolName && event.parentToolCallId == null,
  );
  assert.ok(
    rootRecords.some((event) => event.type === "tool_execution_start"),
    `Pi should report the attempted root call to ${toolName}; observed ${JSON.stringify(rootRecords)}`,
  );
  const ended = rootRecords.filter((event) => event.type === "tool_execution_end").at(-1);
  assert.ok(ended, `Pi should report the root result for ${toolName}; observed ${JSON.stringify(rootRecords)}`);
  assert.equal(ended.isError === true, isError, `unexpected ${toolName} result: ${JSON.stringify(ended)}`);
  return ended;
}

function assertResultContains(result: FixtureEvent, ...needles: string[]): void {
  const rendered = JSON.stringify(result.result ?? result);
  for (const needle of needles) assert.ok(rendered.includes(needle), `result should include ${needle}: ${rendered}`);
}

function assertMcpMetadataRemainsNative(dump: ProbeDump, fixture: NativeMcpFixture): void {
  const echo = requireTool(dump, echoName(fixture));
  const counter = requireTool(dump, counterName(fixture));
  assert.equal(echo.exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  assert.equal(counter.exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  assert.equal(echo.annotations?.readOnlyHint, true, "the read-only server hint is observed but is not a policy grant");
}

function assertMcpRemainsNativeAndInactive(dump: ProbeDump, fixture: NativeMcpFixture): void {
  assertMcpMetadataRemainsNative(dump, fixture);
  assert.ok(!dump.activeTools?.includes(echoName(fixture)), "native MCP echo must not be promoted into a direct declaration");
  assert.ok(!dump.activeTools?.includes(counterName(fixture)), "native MCP counter must not be promoted into a direct declaration");
}

function codemodeScript(fixture: NativeMcpFixture, label: string): string {
  const message = `native-policy-${label}`;
  return `const echo = await tools.${echoName(fixture)}({ message: ${JSON.stringify(message)} });\n`
    + `const counter = await tools.${counterName(fixture)}({ label: ${JSON.stringify(label)} });\n`
    + "return JSON.stringify({ echo, counter });";
}

async function runCodemodeOnlyTurn(fixture: NativeMcpFixture, label: string): Promise<void> {
  await fixture.setTurnScript([{ codemode: `return JSON.stringify({ marker: ${JSON.stringify(label)} })` }]);
  await fixture.promptTurn(`Run an ordinary codemode-only response (${label}).`);
  const result = rootToolResult(fixture, CODEMODE, false);
  assertResultContains(result, label);
}

async function runSuccessfulCodemodeTurn(fixture: NativeMcpFixture, label: string): Promise<void> {
  await fixture.setTurnScript([{ codemode: codemodeScript(fixture, label) }]);
  await fixture.promptTurn(`Use codemode to call the fixture echo and counter (${label}).`);
  const rootResult = rootToolResult(fixture, CODEMODE, false);
  assertResultContains(rootResult, `native-policy-${label}`, "counter", "1");
  const events = await fixture.readServerEvents();
  const calls = events.filter((event) => event.event === "tool_call");
  assert.deepEqual(calls.map((event) => event.tool), ["echo", "counter"], "real MCP tools/call requests should reach the server in order");
  assert.deepEqual(calls[0]?.arguments, { message: `native-policy-${label}` });
  assert.deepEqual(calls[1]?.arguments, { label });
  assert.ok(events.some((event) => event.event === "tool_result" && event.tool === "echo" && event.messageChars === `native-policy-${label}`.length));
  assert.ok(events.some((event) => event.event === "tool_result" && event.tool === "counter" && event.count === 1));
  assert.equal(await fixture.readCounter(), 1, "the real MCP counter side effect should be observable");
}

async function runDeniedAttempts(
  fixture: NativeMcpFixture,
  calls: Array<{ toolName: string; arguments: Record<string, unknown> }>,
): Promise<void> {
  await fixture.setTurnScript([
    ...calls.map((call) => ({ toolCalls: [call] })),
    { text: "fixture-observed-forbidden-call-attempts" },
  ]);
  await fixture.promptTurn("Attempt the listed tools so native execution outcomes are observable.");
  for (const call of calls) rootToolResult(fixture, call.toolName, true);
  const events = await fixture.readServerEvents();
  assert.deepEqual(events.filter((event) => event.event === "tool_call"), [], "denied calls must not reach MCP tools/call");
  assert.equal(await fixture.readCounter(), 0, "denied calls must have no counter side effect");
}

function toolCall(toolName: string, arguments_: Record<string, unknown>) {
  return { toolName, arguments: arguments_ };
}

async function runSearchCall(fixture: NativeMcpFixture, query: string): Promise<FixtureEvent> {
  await fixture.setTurnScript([
    { toolCalls: [toolCall("tool_search", { query })] },
    { text: "fixture-search-settled" },
  ]);
  await fixture.promptTurn(`Search authorized tools for ${query}.`);
  return rootToolResult(fixture, "tool_search", false);
}

test("native candidate: wrapper default requires deferred code discovery, then preserves MCP exposure during real calls", { timeout: 240_000 }, async (t) => {
  const fixture = await startCandidate(t, { wrapperDefault: true, deferredPiTools: true });
  if (!fixture) return;

  const before = await fixture.waitForRegisteredTools([echoName(fixture), counterName(fixture)]);
  assertMcpRemainsNativeAndInactive(before, fixture);
  assert.equal(requireTool(before, CODEMODE).exposure, "model-only", "root codemode keeps Pi's model-only exposure");
  assert.ok(before.activeTools?.includes("tool_search"));

  const gateSearch = await runSearchCall(fixture, CODEMODE);
  assertResultContains(gateSearch, '"activated":["codemode"]');
  const afterGateSearch = await fixture.probeDump();
  assert.ok(afterGateSearch.activeTools?.includes(CODEMODE), "tool_search loads model-only root codemode");
  assertMcpRemainsNativeAndInactive(afterGateSearch, fixture);

  await runSuccessfulCodemodeTurn(fixture, "wrapper-default");
  assertMcpRemainsNativeAndInactive(await fixture.probeDump(), fixture);
});

test("native candidate: deferred-off exposes ordinary codemode without deciding native MCP declaration policy", { timeout: 180_000 }, async (t) => {
  const fixture = await startCandidate(t, { wrapperDefault: true, deferredPiTools: false });
  if (!fixture) return;

  const inventory = await fixture.waitForRegisteredTools([echoName(fixture), counterName(fixture)]);
  assert.ok(inventory.activeTools?.includes(CODEMODE), "deferred-off retains ordinary root codemode availability");
  assert.ok(inventory.activeTools?.includes("read"), "normal direct-exposed tools still load when deferred tools are off");
  assertMcpMetadataRemainsNative(inventory, fixture);
  // Native MCP declaration/loading behavior is covered separately; this case isolates
  // ordinary root codemode availability and preservation of native exposure metadata.
  await runCodemodeOnlyTurn(fixture, "deferred-off");
  assertMcpMetadataRemainsNative(await fixture.probeDump(), fixture);
  assert.equal(
    collectTypedRecords(fixture.sessionEvents).some((event) => event.toolName === "tool_search"),
    false,
    "the permitted code call did not depend on a search step when deferred tools are off",
  );
});

test("native candidate: explicit Pi --tools and --exclude-tools restrictions survive wrapper intent", { timeout: 300_000 }, async (t) => {
  const excludedCode = await startCandidate(t, {
    wrapperDefault: true,
    deferredPiTools: false,
    piArgs: ["--tools", ["read", "grep", "find", "ls", echoNameFromDefault(), counterNameFromDefault()].join(",")],
  });
  if (!excludedCode) return;
  const codeInventory = await excludedCode.probeDump();
  assert.equal(observedTool(codeInventory, CODEMODE), undefined, "native --tools must keep code outside getAllTools()");
  assert.ok(!codeInventory.activeTools?.includes(CODEMODE), "the wrapper marker cannot restore excluded codemode");
  await runDeniedAttempts(excludedCode, [toolCall(CODEMODE, { code: "return 'must-not-run'" })]);

  const excludedMcp = await startCandidate(t, {
    wrapperDefault: true,
    deferredPiTools: false,
    piArgs: ["--exclude-tools", mcpToolName(DEFAULT_SERVER_NAME, "echo")],
  });
  if (!excludedMcp) return;
  const echo = echoName(excludedMcp);
  const inventory = await excludedMcp.probeDump();
  assert.equal(observedTool(inventory, echo), undefined, "native --exclude-tools must keep the MCP tool outside getAllTools()");
  assert.ok(!inventory.activeTools?.includes(echo), "the wrapper marker cannot restore an excluded MCP tool");
  await runDeniedAttempts(excludedMcp, [toolCall(echo, { message: "must-not-reach-server" })]);
});

function echoNameFromDefault(): string {
  return mcpToolName(DEFAULT_SERVER_NAME, "echo");
}

function counterNameFromDefault(): string {
  return mcpToolName(DEFAULT_SERVER_NAME, "counter");
}

test("native candidate: plan/research excludes code and every MCP tool with either deferred setting", { timeout: 360_000 }, async (t) => {
  for (const deferredPiTools of [true, false]) {
    const fixture = await startCandidate(t, {
      wrapperDefault: true,
      operatingMode: "plan-research",
      deferredPiTools,
    });
    if (!fixture) return;

    const inventory = await fixture.waitForRegisteredTools([echoName(fixture), counterName(fixture)]);
    requireTool(inventory, CODEMODE);
    assertMcpMetadataRemainsNative(inventory, fixture);
    assert.doesNotMatch(requireTool(inventory, "tool_search").description ?? "", /codemode|mcp__/i);

    const codeSearch = await runSearchCall(fixture, CODEMODE);
    assert.doesNotMatch(JSON.stringify(codeSearch.result ?? codeSearch), /"matched":\["codemode"\]|"nativeAvailable":\["codemode"\]/);
    const afterCodeSearch = await fixture.probeDump();
    assert.ok(!afterCodeSearch.activeTools?.includes(CODEMODE), "plan/research keeps codemode out after a real search turn");
    assert.ok(!afterCodeSearch.activeTools?.some((name) => name.startsWith("mcp__")), "plan/research keeps every MCP tool out after a real turn");
    assertMcpRemainsNativeAndInactive(afterCodeSearch, fixture);
    const mcpSearch = await runSearchCall(fixture, echoName(fixture));
    assertResultContains(mcpSearch, '"outcome":"no-match"');

    await runDeniedAttempts(fixture, [
      toolCall(CODEMODE, { code: `return await tools.${echoName(fixture)}({ message: "nested-research-attempt" })` }),
      toolCall(echoName(fixture), { message: "direct-research-attempt" }),
      toolCall(counterName(fixture), { label: "research-attempt" }),
    ]);
  }
});

test("native candidate: actual executor-role catalog loads permitted code and reaches permitted MCP", { timeout: 240_000 }, async (t) => {
  const echo = mcpToolName(DEFAULT_SERVER_NAME, "echo");
  const counter = mcpToolName(DEFAULT_SERVER_NAME, "counter");
  const allowedToolCatalog = ["read", "grep", "find", "ls", CODEMODE, echo, counter];
  const executorToolCatalog = createExecutorToolCatalog(
    allowedToolCatalog,
    defaultExecutorInitialActiveTools(allowedToolCatalog),
  );
  const fixture = await startCandidate(t, {
    deferredPiTools: true,
    executorToolCatalog,
  });
  if (!fixture) return;

  const initial = await fixture.waitForRegisteredTools([echoName(fixture), counterName(fixture)]);
  assertMcpRemainsNativeAndInactive(initial, fixture);
  assert.equal(requireTool(initial, CODEMODE).exposure, "model-only", "executor root codemode keeps Pi's model-only exposure");
  const gateSearch = await runSearchCall(fixture, CODEMODE);
  assertResultContains(gateSearch, '"activated":["codemode"]');
  const afterGateSearch = await fixture.probeDump();
  assert.ok(afterGateSearch.activeTools?.includes(CODEMODE), "executor tool_search loads its authorized root codemode");
  assertMcpRemainsNativeAndInactive(afterGateSearch, fixture);
  await runSuccessfulCodemodeTurn(fixture, "executor-role");
  assertMcpRemainsNativeAndInactive(await fixture.probeDump(), fixture);
});

test("native candidate: research executor catalog stays read-only with deferred tools on or off", { timeout: 360_000 }, async (t) => {
  // Parent research-catalog construction is covered by the existing unit tests. This launches the fixture's authentic
  // executor role from a fixed parent inventory intersected with RESEARCH_ALLOWED_TOOLS; it does not drive full Subtasks dispatch/capture.
  for (const deferredPiTools of [true, false]) {
    const echo = mcpToolName(DEFAULT_SERVER_NAME, "echo");
    const counter = mcpToolName(DEFAULT_SERVER_NAME, "counter");
    const parentCatalog = ["read", "grep", "find", "ls", "edit", "write", CODEMODE, echo, counter];
    const researchAllowed = parentCatalog.filter((name) => RESEARCH_ALLOWED_TOOLS.has(name));
    assert.deepEqual(researchAllowed, ["read", "grep", "find", "ls"], "research uses the existing parent read-only allow policy");
    const executorToolCatalog = createExecutorToolCatalog(
      researchAllowed,
      deferredPiTools ? defaultExecutorInitialActiveTools(researchAllowed) : researchAllowed,
    );
    const fixture = await startCandidate(t, {
      deferredPiTools,
      executorToolCatalog,
    });
    if (!fixture) return;

    // Pi 1.0.4 keeps passive MCP tool metadata registered (deferred exposure) even when --tools omits mcp__ entries;
    // that metadata is not a grant — the research ceiling still controls tool_search, activation, and direct calls below.
    const inventory = await fixture.waitForRegisteredTools([echoName(fixture), counterName(fixture)]);
    assert.equal(observedTool(inventory, CODEMODE), undefined, "research worker --tools catalog withholds native code");
    assertMcpRemainsNativeAndInactive(inventory, fixture);
    assert.ok(!inventory.activeTools?.includes(CODEMODE));
    assert.ok(!inventory.activeTools?.some((name) => name.startsWith("mcp__")));
    const codeSearch = await runSearchCall(fixture, CODEMODE);
    assertResultContains(codeSearch, '"outcome":"no-match"');
    const mcpSearch = await runSearchCall(fixture, echoName(fixture));
    assertResultContains(mcpSearch, '"outcome":"no-match"');
    await runDeniedAttempts(fixture, [
      toolCall(CODEMODE, { code: `return await tools.${echoName(fixture)}({ message: "research-worker-attempt" })` }),
      toolCall(echoName(fixture), { message: "research-worker-direct-attempt" }),
      toolCall(counterName(fixture), { label: "research-worker-attempt" }),
    ]);
  }
});
