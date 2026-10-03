import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import test from "node:test";
import {
  createNativeMcpFixture,
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

const CONTROL_EXTENSION_CANDIDATES = [
  resolvePath(__dirname, "..", "..", "tests", "fixtures", "pi-native-mcp-control.cjs"),
  resolvePath(process.cwd(), "tests", "fixtures", "pi-native-mcp-control.cjs"),
];
const CONTROL_EXTENSION = CONTROL_EXTENSION_CANDIDATES.find((candidate) => existsSync(candidate))
  ?? CONTROL_EXTENSION_CANDIDATES[0]!;
const DEFAULT_CANDIDATE_ENTRY = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
const CONTROL_SERVER_NAME = "prg_late_native";
const MODEL_ONLY_TOOL_NAME = "prg_native_model_only";
const FIXTURE_TIMEOUTS = {
  requestMs: 30_000,
  connectMs: 30_000,
  turnMs: 60_000,
  dumpMs: 10_000,
} as const;

type FixtureTestContext = {
  skip(message?: string): void;
  after(callback: () => void | Promise<void>): void;
};

function candidateOptions(
  options: Partial<NativeMcpFixtureOptions> = {},
): NativeMcpFixtureOptions {
  return {
    candidateEntry: DEFAULT_CANDIDATE_ENTRY,
    additionalExtensions: [CONTROL_EXTENSION],
    // This is the fixture's credential-free, zero-reviewer configuration:
    // the fake provider supplies scripted turns in-process, and the candidate
    // cannot invoke any configured reviewer or provider API.
    gateConfig: ZERO_MODEL_GATE_CONFIG,
    timeouts: FIXTURE_TIMEOUTS,
    ...options,
  };
}

async function fixtureGitEnvironment(fixture: NativeMcpFixture): Promise<{
  env: NodeJS.ProcessEnv;
  hooksPath: string;
  templatePath: string;
}> {
  const scratch = fixture.paths.scratch;
  const hooksPath = join(scratch, "git-hooks");
  const templatePath = join(scratch, "git-template");
  const globalConfig = join(scratch, "empty-gitconfig");
  const xdgConfig = join(scratch, "xdg-config");
  await Promise.all([
    mkdir(hooksPath, { recursive: true }),
    mkdir(templatePath, { recursive: true }),
    mkdir(xdgConfig, { recursive: true }),
    writeFile(globalConfig, "", "utf8"),
  ]);

  // Copy only the process-launch essentials; never pass through GIT_* overrides
  // (GIT_DIR, GIT_WORK_TREE, indexes, object dirs, tracing, or config). The
  // explicit global/system config and hook/template paths below are scratch-only.
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
  assert.deepEqual(
    Object.keys(env).filter((name) => name.startsWith("GIT_")).sort(),
    ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"],
    "only the deliberate scratch-scoped Git config overrides enter these subprocesses",
  );
  return { env, hooksPath, templatePath };
}

async function startCandidateFixture(
  t: FixtureTestContext,
  options: Partial<NativeMcpFixtureOptions> = {},
): Promise<NativeMcpFixture | undefined> {
  const fixtureOptions = candidateOptions(options);
  if (!fixtureOptions.candidateEntry) {
    skipOrFail(t, "native candidate lifecycle requires PI_REVIEW_GATE_CANDIDATE_ENTRY pointing to the freshly compiled candidate src/index.js");
    return undefined;
  }
  assert.notEqual(
    resolvePath(fixtureOptions.candidateEntry),
    resolvePath(process.cwd(), "dist", "src", "index.js"),
    "native lifecycle tests must not exercise the checkout's possibly stale live dist/",
  );
  const prerequisites = describeFixturePrerequisites(fixtureOptions);
  if (!prerequisites.ok) {
    skipOrFail(t, `native candidate lifecycle prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
    return undefined;
  }
  assert.ok(fixtureOptions.candidateEntry, "candidate lifecycle tests must load an actual compiled candidate entry");
  assert.ok(existsSync(fixtureOptions.candidateEntry), `compiled candidate entry must exist: ${fixtureOptions.candidateEntry}`);
  assert.ok(existsSync(CONTROL_EXTENSION), `public MCP control extension must exist: ${CONTROL_EXTENSION}`);

  const fixture = createNativeMcpFixture(fixtureOptions);
  // Register cleanup before startup: every assertion and startup failure still
  // terminates the native Pi child and removes its synthetic scratch tree.
  t.after(async () => {
    if (fixture.paths?.scratch) await fixture.dispose();
  });
  await fixture.start();
  // The candidate's turn hooks may consult Git; give each isolated project a
  // synthetic repository before issuing any agent turn. Both Git calls receive
  // the same allowlisted environment, scratch HOME/config, empty template/hooks,
  // and explicit non-signing settings, independent of caller Git configuration.
  const git = await fixtureGitEnvironment(fixture);
  execFileSync("git", [
    "-c", `core.hooksPath=${git.hooksPath}`,
    "init", "--quiet", `--template=${git.templatePath}`,
  ], {
    cwd: fixture.paths.project,
    env: git.env,
    stdio: "ignore",
    timeout: 10_000,
  });
  execFileSync("git", [
    "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${git.hooksPath}`,
    "-c", "user.name=Pi Native Fixture",
    "-c", "user.email=pi-native-fixture@example.invalid",
    "commit", "--no-gpg-sign", "--allow-empty", "--quiet", "-m", "synthetic native-fixture baseline",
  ], {
    cwd: fixture.paths.project,
    env: git.env,
    stdio: "ignore",
    timeout: 10_000,
  });
  return fixture;
}

function observedTool(dump: ProbeDump, name: string): NonNullable<ProbeDump["allTools"]>[number] {
  const tool = dump.allTools?.find((candidate) => candidate.name === name);
  assert.ok(tool, `native Pi registry should contain ${name}; observed ${JSON.stringify(dump.allTools)}`);
  return tool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTypedRecords(value: unknown, result: FixtureEvent[] = []): FixtureEvent[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTypedRecords(item, result);
  } else if (isRecord(value)) {
    if (typeof value.type === "string") result.push(value);
    for (const nested of Object.values(value)) collectTypedRecords(nested, result);
  }
  return result;
}

function findSearchDetails(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSearchDetails(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (isRecord(value.details) && Array.isArray(value.details.matched)) return value.details;
  for (const nested of Object.values(value)) {
    const found = findSearchDetails(nested);
    if (found) return found;
  }
  return undefined;
}

async function searchTools(fixture: NativeMcpFixture, query: string): Promise<Record<string, unknown>> {
  const firstEvent = fixture.sessionEvents.length;
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "search_tools", arguments: { query } }] },
    { text: "native candidate search completed" },
  ]);
  await fixture.promptTurn(`Use search_tools to look for ${query}.`);
  const turnRecords = collectTypedRecords(fixture.sessionEvents.slice(firstEvent));
  const completedSearch = turnRecords.find((event) =>
    event.type === "tool_execution_end" && event.toolName === "search_tools",
  );
  assert.ok(completedSearch, `the actual candidate search_tools call should finish; observed ${JSON.stringify(turnRecords)}`);
  const details = findSearchDetails(completedSearch);
  assert.ok(details, `the native search_tools result should expose structured discovery details: ${JSON.stringify(completedSearch)}`);
  return details;
}

async function runCodemode(fixture: NativeMcpFixture, code: string, prompt: string): Promise<FixtureEvent[]> {
  const firstEvent = fixture.sessionEvents.length;
  await fixture.setTurnScript([{ codemode: code }]);
  await fixture.promptTurn(prompt);
  return collectTypedRecords(fixture.sessionEvents.slice(firstEvent));
}

function nestedEnd(records: FixtureEvent[], name: string): FixtureEvent {
  const end = records.find((event) => event.type === "tool_execution_end" && event.toolName === name);
  assert.ok(end, `Pi should report the nested ${name} completion; observed ${JSON.stringify(records)}`);
  return end;
}

async function publicControlEvents(fixture: NativeMcpFixture): Promise<FixtureEvent[]> {
  const target = join(dirname(fixture.paths.controlFile), "public-control-events.jsonl");
  try {
    return (await readFile(target, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureEvent);
  } catch {
    return [];
  }
}

async function assertLastControlSucceeded(fixture: NativeMcpFixture, action: string): Promise<FixtureEvent> {
  const event = (await publicControlEvents(fixture)).at(-1);
  assert.ok(event, `public control extension should record ${action}`);
  assert.equal(event.action, action);
  assert.equal(event.ok, true, `public ${action} failed: ${JSON.stringify(event)}`);
  return event;
}

test("compiled candidate reconciles native MCP withdrawal, replacement, calls, and same-session reconnect", { timeout: 300_000 }, async (t) => {
  const fixture = await startCandidateFixture(t, {
    serverExposure: "codemode",
    wrapperDefault: true,
  });
  if (!fixture) return;

  const oldEcho = mcpToolName(fixture.serverName, "echo");
  const newEcho = mcpToolName(fixture.serverName, "echo_second");
  const counter = mcpToolName(fixture.serverName, "counter");
  const initial = await fixture.probeDump();
  assert.equal(
    observedTool(initial, oldEcho).exposure,
    REGISTERED_EXPOSURE_FOR_CODENAME_SERVER,
    "assert Pi's actual MCP-to-tool exposure mapping, not a server-config inference",
  );
  assert.ok(!initial.activeTools?.includes(oldEcho), "the registered native MCP callee starts inactive");
  const initialSearch = await searchTools(fixture, oldEcho);
  assert.deepEqual(initialSearch.matched, [oldEcho], "the candidate initially discovers the live old MCP name");
  assert.deepEqual(initialSearch.nativeAvailable, [oldEcho], "search_tools reports native callability without activating it");
  assert.deepEqual(initialSearch.activated, [], "search_tools does not directly promote native codemode/deferred tools");
  assert.ok(!(await fixture.probeDump()).activeTools?.includes(oldEcho));

  const rootSearch = await searchTools(fixture, "codemode");
  assert.deepEqual(rootSearch.matched, ["codemode"], "the candidate loader discovers the registered script root");
  assert.deepEqual(rootSearch.activated, ["codemode"], "search_tools loads the model-facing codemode root");
  assert.ok((await fixture.probeDump()).activeTools?.includes("codemode"),
    "the candidate's loader leaves the root available for the subsequent turn");

  const beforeRotation = await fixture.readServerEvents();
  await fixture.rotateToolList(2);
  const changed = await fixture.waitForServerLog(
    (event) => event.event === "list_changed" && event.generation === 2,
    undefined,
    beforeRotation.length,
  );
  assert.ok(changed, "the real fixture MCP server sends notifications/tools/list_changed");
  const refreshed = await fixture.waitForServerLog(
    (event) => event.event === "tools_list" && event.generation === 2,
    undefined,
    beforeRotation.length,
  );
  assert.ok(refreshed, "native Pi requests the rotated list before candidate discovery assertions");

  const rotated = await fixture.probeDump();
  assert.equal(observedTool(rotated, oldEcho).exposure, "hidden",
    "Pi retains the withdrawn old registration as hidden in its actual registry");
  assert.ok(!rotated.activeTools?.includes(oldEcho), "the withdrawn registration is not directly active");
  assert.equal(observedTool(rotated, newEcho).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  assert.ok(!rotated.activeTools?.includes(newEcho), "the replacement remains native-only and inactive");

  const oldSearch = await searchTools(fixture, oldEcho);
  assert.deepEqual(oldSearch.matched, [], "candidate search_tools drops the withdrawn/hidden old name");
  assert.deepEqual(oldSearch.nativeAvailable, []);
  const replacementSearch = await searchTools(fixture, newEcho);
  assert.deepEqual(replacementSearch.matched, [newEcho], "candidate search_tools adopts the newly listed native name");
  assert.deepEqual(replacementSearch.nativeAvailable, [newEcho]);
  assert.deepEqual(replacementSearch.activated, [], "adoption does not turn the deferred native tool into a direct declaration");
  assert.ok(!(await fixture.probeDump()).activeTools?.includes(newEcho));

  // Register the synthetic tool after candidate capture through Pi's public
  // tool API. Pi itself reports its actual model-only registry exposure.
  // Searching may make it model-callable, but a nested script call must retain
  // the native model-only denial and never execute the effect.
  await fixture.runCommand("/native-mcp-control register-model-only");
  await assertLastControlSucceeded(fixture, "register-model-only");
  const modelOnlySearch = await searchTools(fixture, MODEL_ONLY_TOOL_NAME);
  assert.deepEqual(modelOnlySearch.matched, [MODEL_ONLY_TOOL_NAME]);
  assert.deepEqual(modelOnlySearch.activated, [MODEL_ONLY_TOOL_NAME]);
  const modelOnlyDump = await fixture.probeDump();
  assert.equal(observedTool(modelOnlyDump, MODEL_ONLY_TOOL_NAME).exposure, "model-only",
    "the exposure under test is read from Pi's real tool metadata");
  assert.ok(modelOnlyDump.activeTools?.includes(MODEL_ONLY_TOOL_NAME));

  const beforeWithdrawnAttempt = await fixture.readServerEvents();
  const withdrawnAttempt = await runCodemode(
    fixture,
    `return await tools.${oldEcho}({ message: "must-not-reach-server" });`,
    "Attempt the withdrawn MCP echo from the already-loaded codemode root.",
  );
  const withdrawnRootResult = nestedEnd(withdrawnAttempt, "codemode");
  assert.equal(withdrawnRootResult.isError, true, "Pi's real codemode root rejects a withdrawn tool name");
  assert.match(JSON.stringify(withdrawnRootResult.result), /does not exist/);
  assert.match(JSON.stringify(withdrawnRootResult.result), /No tool calls were made/,
    "the native script API refuses the hidden name before any tools/call request");
  assert.equal(
    (await fixture.readServerEvents()).filter((event) => event.event === "tool_call").length,
    beforeWithdrawnAttempt.filter((event) => event.event === "tool_call").length,
    "the withdrawn MCP call has no server-side tools/call effect",
  );

  const replacementCall = await runCodemode(
    fixture,
    `return await tools.${newEcho}({ message: "generation-two" });`,
    "Call the newly listed MCP echo through codemode while it stays inactive.",
  );
  assert.equal(nestedEnd(replacementCall, newEcho).isError, false,
    "a permitted deferred/native MCP tool remains callable nested after loading the script root");
  assert.ok(!(await fixture.probeDump()).activeTools?.includes(newEcho),
    "successful nested native reachability never promotes the MCP tool into the direct active set");
  const afterReplacementCall = await fixture.readServerEvents();
  assert.ok(afterReplacementCall.some((event) =>
    event.event === "tool_call" && event.tool === "echo_second" && event.generation === 2,
  ), "the actual generation-two MCP server receives the replacement call");

  const beforeModelOnlyAttempt = await fixture.readServerEvents();
  const modelOnlyAttempt = await runCodemode(
    fixture,
    `return await tools.${MODEL_ONLY_TOOL_NAME}({});`,
    "Attempt the model-only synthetic tool from codemode.",
  );
  const modelOnlyRootResult = nestedEnd(modelOnlyAttempt, "codemode");
  assert.equal(modelOnlyRootResult.isError, true, "Pi's real codemode root rejects the model-only tool");
  assert.match(JSON.stringify(modelOnlyRootResult.result), /does not exist/,
    "the model-only exposure is not present in the native script callee set");
  const modelOnlyEffectPath = join(dirname(fixture.paths.controlFile), "model-only-effects.jsonl");
  await assert.rejects(
    readFile(modelOnlyEffectPath, "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "the model-only handler has no synthetic effect when called nested",
  );
  assert.equal(
    (await fixture.readServerEvents()).filter((event) => event.event === "tool_call").length,
    beforeModelOnlyAttempt.filter((event) => event.event === "tool_call").length,
  );

  await runCodemode(
    fixture,
    `return await tools.${counter}({ label: "before-reconnect" });`,
    "Increment the shared native fixture counter before reconnect.",
  );
  assert.equal(await fixture.readCounter(), 1);
  const childPid = fixture.childPid;
  const beforeReconnect = await fixture.readServerEvents();
  const initializeCount = beforeReconnect.filter((event) => event.event === "initialize").length;
  await fixture.runCommand(`/mcp reconnect ${fixture.serverName}`);
  const reconnected = await fixture.waitForServerLog(
    (event) => event.event === "initialize",
    undefined,
    beforeReconnect.length,
  );
  assert.ok(reconnected, "native /mcp reconnect starts a new MCP server connection");
  assert.equal(fixture.childPid, childPid, "the same native Pi RPC child/session remains alive");
  assert.equal(
    (await fixture.readServerEvents()).filter((event) => event.event === "initialize").length,
    initializeCount + 1,
    "exactly one native server reconnect occurred",
  );
  const afterReconnect = await fixture.probeDump();
  assert.equal(observedTool(afterReconnect, oldEcho).exposure, "hidden");
  assert.ok(!afterReconnect.activeTools?.includes(oldEcho));
  assert.equal(observedTool(afterReconnect, newEcho).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  const stillWithdrawn = await searchTools(fixture, oldEcho);
  assert.deepEqual(stillWithdrawn.matched, [], "reconnect does not restore the withdrawn old discovery name");

  await runCodemode(
    fixture,
    `return await tools.${counter}({ label: "after-reconnect" });`,
    "Increment the persistent native fixture counter after reconnect.",
  );
  assert.equal(await fixture.readCounter(), 2, "fixture server counter state persists across reconnect");
  const finalCalls = (await fixture.readServerEvents()).filter((event) => event.event === "tool_call");
  assert.deepEqual(finalCalls.filter((event) => event.tool === "counter").map((event) => event.generation), [2, 2]);
});

test("public native MCP registration is discovered dynamically while a worker ceiling stays immutable", { timeout: 360_000 }, async (t) => {
  const host = await startCandidateFixture(t, {
    serverExposure: "codemode",
    wrapperDefault: true,
  });
  if (!host) return;

  const lateEcho = mcpToolName(CONTROL_SERVER_NAME, "echo");
  const lateCounter = mcpToolName(CONTROL_SERVER_NAME, "counter");
  const beforeRegistration = await host.readServerEvents();
  await host.runCommand("/native-mcp-control register");
  const registration = await assertLastControlSucceeded(host, "register");
  assert.ok(registration.registrationForm === "name-config" || registration.registrationForm === "config-object",
    `registration must use the public ExtensionAPI form: ${JSON.stringify(registration)}`);
  const registeredList = await host.waitForServerLog(
    (event) => event.event === "tools_list"
      && Array.isArray(event.tools)
      && event.tools.includes("echo")
      && event.tools.includes("counter"),
    undefined,
    beforeRegistration.length,
  );
  assert.ok(registeredList, "public registerMcpServer connects and lists its late synthetic MCP tools");
  const hostDump = await host.probeDump();
  assert.equal(observedTool(hostDump, lateEcho).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER,
    "the late MCP config exposure is checked against actual Pi registry metadata");
  assert.equal(observedTool(hostDump, lateCounter).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  assert.ok(!hostDump.activeTools?.includes(lateEcho));
  assert.ok(!hostDump.activeTools?.includes(lateCounter));
  const hostEchoSearch = await searchTools(host, lateEcho);
  assert.deepEqual(hostEchoSearch.matched, [lateEcho], "dynamic top-level authority adopts a genuinely late MCP name");
  assert.deepEqual(hostEchoSearch.nativeAvailable, [lateEcho]);
  const hostCounterSearch = await searchTools(host, lateCounter);
  assert.deepEqual(hostCounterSearch.matched, [lateCounter]);
  assert.deepEqual(hostCounterSearch.nativeAvailable, [lateCounter]);
  assert.ok(!(await host.probeDump()).activeTools?.includes(lateEcho),
    "dynamic host discovery leaves deferred native registrations inactive");

  const hostRootSearch = await searchTools(host, "codemode");
  assert.deepEqual(hostRootSearch.matched, ["codemode"]);
  assert.deepEqual(hostRootSearch.activated, ["codemode"]);
  await runCodemode(
    host,
    `return await tools.${lateCounter}({ label: "before-public-unregister" });`,
    "Call the publicly registered MCP counter through the native script root.",
  );
  assert.equal(await host.readCounter(), 1, "the publicly registered tool has a real synthetic server effect");

  await host.runCommand("/native-mcp-control unregister");
  await assertLastControlSucceeded(host, "unregister");
  const afterUnregister = await host.probeDump();
  assert.ok(
    !afterUnregister.allTools?.some((tool) => tool.name === lateCounter && tool.exposure !== "hidden"),
    "public unregister removes or hides the late native registry entries",
  );
  const withdrawnLateSearch = await searchTools(host, lateCounter);
  assert.deepEqual(withdrawnLateSearch.matched, [], "candidate discovery drops publicly unregistered MCP names");
  const beforeDeniedLateCall = await host.readServerEvents();
  const deniedLateCall = await runCodemode(
    host,
    `return await tools.${lateCounter}({ label: "after-public-unregister" });`,
    "Attempt the publicly unregistered counter through the still-loaded script root.",
  );
  const unregisteredRootResult = nestedEnd(deniedLateCall, "codemode");
  assert.equal(unregisteredRootResult.isError, true);
  assert.match(JSON.stringify(unregisteredRootResult.result), /does not exist/,
    "the native script callee set no longer exposes the publicly unregistered name");
  assert.equal(await host.readCounter(), 1, "unregistration denial leaves the server-side counter unchanged");
  assert.equal(
    (await host.readServerEvents()).filter((event) => event.event === "tool_call").length,
    beforeDeniedLateCall.filter((event) => event.event === "tool_call").length,
    "the unregistered nested call never reaches MCP tools/call",
  );

  const workerAllowedEcho = lateEcho;
  const worker = await startCandidateFixture(t, {
    serverExposure: "codemode",
    wrapperDefault: false,
    executorToolCatalog: {
      allowedToolCatalog: ["read", "codemode", workerAllowedEcho],
      initialActiveTools: ["read", "codemode"],
    },
  });
  if (!worker) return;

  const workerBeforeRegistration = await worker.readServerEvents();
  await worker.runCommand("/native-mcp-control register");
  await assertLastControlSucceeded(worker, "register");
  const workerList = await worker.waitForServerLog(
    (event) => event.event === "tools_list"
      && Array.isArray(event.tools)
      && event.tools.includes("echo")
      && event.tools.includes("counter"),
    undefined,
    workerBeforeRegistration.length,
  );
  assert.ok(workerList, "the native host itself sees both late server names in the worker");
  const workerDump = await worker.probeDump();
  assert.equal(observedTool(workerDump, workerAllowedEcho).exposure, REGISTERED_EXPOSURE_FOR_CODENAME_SERVER);
  // The real MCP server advertises both names above, but Pi's worker `--tools`
  // list is exactly the captured catalog plus search_tools. The outside name
  // is therefore withheld by Pi before it enters getAllTools; this test does
  // not misstate that host-side restriction as a candidate-only rejection.
  assert.equal(workerDump.allTools?.some((tool) => tool.name === lateCounter), false,
    "the fixed worker launch allowlist does not materialize an outside-ceiling late name");
  assert.ok(workerDump.activeTools?.includes("codemode"), "the worker's captured root is natively active");
  assert.ok(!workerDump.activeTools?.includes(workerAllowedEcho));
  assert.ok(!workerDump.activeTools?.includes(lateCounter));

  const permittedLateSearch = await searchTools(worker, workerAllowedEcho);
  assert.deepEqual(permittedLateSearch.matched, [workerAllowedEcho],
    "a late name already in the captured worker ceiling becomes discoverable when registered");
  assert.deepEqual(permittedLateSearch.nativeAvailable, [workerAllowedEcho]);
  assert.deepEqual(permittedLateSearch.activated, []);
  const outsideCeilingSearch = await searchTools(worker, lateCounter);
  assert.deepEqual(outsideCeilingSearch.matched, [],
    "host registration does not append a name to the immutable worker authorization ceiling");

  const permittedWorkerCall = await runCodemode(
    worker,
    `return await tools.${workerAllowedEcho}({ message: "late-worker-ceiling-name" });`,
    "Call the newly registered but pre-authorized MCP echo nested under codemode.",
  );
  assert.equal(nestedEnd(permittedWorkerCall, workerAllowedEcho).isError, false,
    "the pre-authorized name is usable after the live native server appears");
  assert.ok(!(await worker.probeDump()).activeTools?.includes(workerAllowedEcho),
    "nested native access does not promote the worker MCP name into direct active tools");

  const beforeOutsideCall = await worker.readServerEvents();
  const outsideWorkerCall = await runCodemode(
    worker,
    `return await tools.${lateCounter}({ label: "outside-worker-ceiling" });`,
    "Attempt the host-discovered late MCP counter outside the worker ceiling.",
  );
  const outsideRootResult = nestedEnd(outsideWorkerCall, "codemode");
  assert.equal(outsideRootResult.isError, true,
    "the native script callee set denies an MCP tool outside the frozen worker ceiling");
  assert.match(JSON.stringify(outsideRootResult.result), /does not exist/);
  assert.equal(await worker.readCounter(), 0, "the out-of-ceiling server-side counter remains untouched");
  assert.equal(
    (await worker.readServerEvents()).filter((event) => event.event === "tool_call").length,
    beforeOutsideCall.filter((event) => event.event === "tool_call").length,
    "the out-of-ceiling attempt never reaches the real MCP server",
  );
});
