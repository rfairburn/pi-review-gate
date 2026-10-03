import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createNativeMcpFixture,
  describeFixturePrerequisites,
  type FixtureEvent,
  type NativeMcpFixture,
  type NativeMcpFixtureOptions,
  type ProbeDump,
} from "./pi-native-mcp-fixture";
import { skipOrFail } from "./bridge-fakes";

const CODEMODE = "codemode";
const SESSION_REPLACEMENT_MARKER = "prg-zero-mcp-replacement-root-v1";
const TIMEOUTS = { requestMs: 30_000, connectMs: 30_000, turnMs: 60_000, dumpMs: 10_000 } as const;

function gateConfig(deferredPiTools: boolean): object {
  return {
    enabled: true,
    operatingMode: "execute",
    review: { activeReviewers: [], primaryEnabled: false, subtaskEnabled: false },
    execution: { deferredPiTools },
  };
}

async function startCandidate(
  t: TestContext,
  options: { deferredPiTools: boolean; piArgs?: string[] },
): Promise<NativeMcpFixture | undefined> {
  const candidateEntry = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
  if (!candidateEntry) {
    skipOrFail(t, "native codemode replacement requires PI_REVIEW_GATE_CANDIDATE_ENTRY pointing to the fresh compiled candidate src/index.js");
    return undefined;
  }
  assert.notEqual(resolve(candidateEntry), resolve(process.cwd(), "dist", "src", "index.js"),
    "native codemode replacement must not exercise the live dist/");

  const scratchParent = await mkdtemp(join(tmpdir(), "pi-native-codemode-replacement-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = scratchParent;
  const fixtureOptions: NativeMcpFixtureOptions = {
    candidateEntry,
    gateConfig: gateConfig(options.deferredPiTools),
    noMcpServers: true,
    wrapperDefault: true,
    scratchParent,
    timeouts: TIMEOUTS,
    ...(options.piArgs ? { piArgs: options.piArgs } : {}),
  };
  const prerequisites = describeFixturePrerequisites(fixtureOptions);
  if (!prerequisites.ok) {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(scratchParent, { recursive: true, force: true });
    skipOrFail(t, `native zero-MCP codemode prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
    return undefined;
  }

  const fixture = createNativeMcpFixture(fixtureOptions);
  t.after(async () => {
    try {
      if (fixture.paths?.scratch) await fixture.dispose();
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await rm(scratchParent, { recursive: true, force: true });
    }
  });
  await fixture.start();
  await initGitProject(fixture);
  return fixture;
}

async function initGitProject(fixture: NativeMcpFixture): Promise<void> {
  const { scratch, project } = fixture.paths;
  const hooks = join(scratch, "git-hooks");
  const template = join(scratch, "git-template");
  const globalConfig = join(scratch, "empty-gitconfig");
  const xdgConfig = join(scratch, "xdg-config");
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
  const git = (args: string[]): void => {
    execFileSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], {
      cwd: project,
      env,
      stdio: "ignore",
      timeout: 10_000,
    });
  };
  git(["init", "--quiet", `--template=${template}`]);
  git(["config", "user.name", "Pi zero-MCP fixture"]);
  git(["config", "user.email", "pi-zero-mcp@example.invalid"]);
  git(["add", ".pi/mcp.json"]);
  git(["-c", "commit.gpgSign=false", "commit", "--no-gpg-sign", "--quiet", "-m", "synthetic zero-MCP baseline"]);
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

function rootToolResult(events: FixtureEvent[], toolName: string): FixtureEvent {
  const root = collectTypedRecords(events).filter((event) =>
    event.toolName === toolName && event.parentToolCallId == null,
  );
  assert.ok(root.some((event) => event.type === "tool_execution_start"),
    `Pi must emit an actual root start for ${toolName}: ${JSON.stringify(root)}`);
  const result = root.filter((event) => event.type === "tool_execution_end").at(-1);
  assert.ok(result, `Pi must emit an actual root result for ${toolName}: ${JSON.stringify(root)}`);
  assert.notEqual(result.isError, true, `${toolName} failed: ${JSON.stringify(result)}`);
  return result;
}

function searchDetails(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = searchDetails(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (isRecord(value.details) && Array.isArray(value.details.matched)) return value.details;
  for (const nested of Object.values(value)) {
    const found = searchDetails(nested);
    if (found) return found;
  }
  return undefined;
}

async function searchCodemode(fixture: NativeMcpFixture): Promise<FixtureEvent> {
  const start = fixture.sessionEvents.length;
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "search_tools", arguments: { query: CODEMODE } }] },
    { text: "zero-MCP codemode search completed" },
  ]);
  await fixture.promptTurn("Find and load the authorized codemode tool.");
  return rootToolResult(fixture.sessionEvents.slice(start), "search_tools");
}

async function executeBoundedCodemodeScript(fixture: NativeMcpFixture): Promise<FixtureEvent> {
  assert.ok(SESSION_REPLACEMENT_MARKER.length <= 64, "the script's observable marker remains bounded");
  const start = fixture.sessionEvents.length;
  await fixture.setTurnScript([{
    codemode: `return JSON.stringify({ marker: ${JSON.stringify(SESSION_REPLACEMENT_MARKER)} })`,
  }]);
  await fixture.promptTurn("Run the bounded zero-MCP codemode marker script.");
  const result = rootToolResult(fixture.sessionEvents.slice(start), CODEMODE);
  assert.ok(JSON.stringify(result.result ?? result).includes(SESSION_REPLACEMENT_MARKER),
    `the real codemode script result must contain its marker: ${JSON.stringify(result)}`);
  return result;
}

async function probeEvents(fixture: NativeMcpFixture): Promise<FixtureEvent[]> {
  try {
    return (await readFile(fixture.paths.probeJournal, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureEvent);
  } catch {
    return [];
  }
}

async function waitForProbeEvent(
  fixture: NativeMcpFixture,
  predicate: (event: FixtureEvent) => boolean,
  timeoutMs = 15_000,
): Promise<FixtureEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await probeEvents(fixture)).find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`probe lifecycle event did not appear within ${timeoutMs}ms`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

async function replaceSession(fixture: NativeMcpFixture): Promise<{
  beforeSessionId: string;
  afterSessionId: string;
  oldManagerId: number;
  newManagerId: number;
}> {
  const beforeState = await fixture.rpc("get_state") as Record<string, unknown>;
  const existingFactory = (await probeEvents(fixture))
    .filter((event) => event.event === "probe_factory_loaded")
    .at(-1);
  const existingStart = (await probeEvents(fixture))
    .filter((event) => event.event === "probe_session_start")
    .at(-1);
  assert.ok(existingFactory && typeof existingFactory.factoryId === "number");
  assert.ok(existingStart && typeof existingStart.sessionManagerId === "number");
  const pid = fixture.childPid;

  const response = await fixture.rpc("new_session", {}, { body: true }) as {
    data?: { cancelled?: unknown };
  };
  assert.equal(response.data?.cancelled, false, "the public native new_session RPC must complete");
  const replacementFactory = await waitForProbeEvent(fixture, (event) =>
    event.event === "probe_factory_loaded"
      && typeof event.factoryId === "number"
      && event.factoryId > (existingFactory.factoryId as number),
  );
  const replacementStart = await waitForProbeEvent(fixture, (event) =>
    event.event === "probe_session_start"
      && typeof event.sessionManagerId === "number"
      && event.sessionManagerId !== existingStart.sessionManagerId,
  );
  await fixture.ensureScriptedModel();

  const afterState = await fixture.rpc("get_state") as Record<string, unknown>;
  assert.equal(fixture.childPid, pid, "new_session replaced the session without restarting the primary process");
  assert.ok(typeof beforeState.sessionId === "string" && typeof afterState.sessionId === "string");
  assert.notEqual(afterState.sessionId, beforeState.sessionId, "Pi reports a different native session id after /new");
  assert.equal(replacementFactory.wrapperMarkerPresent, false, "the replacement extension factory sees no inherited marker");
  assert.equal(replacementStart.wrapperMarkerPresent, false, "the replacement session hook sees no inherited marker");
  assert.ok((await probeEvents(fixture)).some((event) =>
    event.event === "probe_session_shutdown" && event.sessionManagerId === existingStart.sessionManagerId,
  ), "Pi emitted session_shutdown for the replaced SessionManager");
  return {
    beforeSessionId: beforeState.sessionId as string,
    afterSessionId: afterState.sessionId as string,
    oldManagerId: existingStart.sessionManagerId as number,
    newManagerId: replacementStart.sessionManagerId as number,
  };
}

function requireTool(dump: ProbeDump, name: string): NonNullable<ProbeDump["allTools"]>[number] {
  const tool = dump.allTools?.find((candidate) => candidate.name === name);
  assert.ok(tool, `Pi's real getAllTools() registry should contain ${name}: ${JSON.stringify(dump.allTools)}`);
  return tool;
}

test("wrapper codemode discovery survives real zero-MCP /new factory and SessionManager replacement", { timeout: 240_000 }, async (t) => {
  const fixture = await startCandidate(t, { deferredPiTools: true });
  if (!fixture) return;

  const mcpConfig = JSON.parse(await readFile(fixture.paths.mcpConfig, "utf8")) as { mcpServers?: Record<string, unknown> };
  assert.deepEqual(mcpConfig.mcpServers, {}, "the real Pi process starts with no configured MCP servers");
  const initial = await fixture.probeDump();
  assert.equal(initial.allTools?.some((tool) => tool.name.startsWith("mcp__")), false);
  assert.equal(requireTool(initial, CODEMODE).exposure, "model-only");
  assert.ok(!initial.activeTools?.includes(CODEMODE), "native Pi registered codemode but left it initially inactive");
  assert.ok(requireTool(initial, "search_tools"), "the review-gate loader is registered");

  const initialSearch = await searchCodemode(fixture);
  const initialDetails = searchDetails(initialSearch.result);
  assert.ok(initialDetails, `search_tools must return actual structured details: ${JSON.stringify(initialSearch)}`);
  assert.deepEqual(initialDetails.matched, [CODEMODE]);
  assert.deepEqual(initialDetails.activated, [CODEMODE], "deferred ON loads Pi's model-only codemode root");
  assert.ok((await fixture.probeDump()).activeTools?.includes(CODEMODE));

  const replacement = await replaceSession(fixture);
  assert.notEqual(replacement.oldManagerId, replacement.newManagerId,
    "the observed SessionManager object changed, not just the active branch");
  const afterNew = await fixture.probeDump();
  assert.equal(requireTool(afterNew, CODEMODE).exposure, "model-only");
  assert.ok(!afterNew.activeTools?.includes(CODEMODE), "replacement starts with codemode inactive again");
  assert.ok(requireTool(afterNew, "search_tools"), "the replacement review-gate loader remains registered");

  const replacementSearch = await searchCodemode(fixture);
  const replacementDetails = searchDetails(replacementSearch.result);
  assert.ok(replacementDetails, `replacement search_tools result must be observable: ${JSON.stringify(replacementSearch)}`);
  assert.deepEqual(replacementDetails.matched, [CODEMODE]);
  assert.deepEqual(replacementDetails.activated, [CODEMODE]);
  const loaded = await fixture.probeDump();
  assert.ok(loaded.activeTools?.includes(CODEMODE));
  const scriptResult = await executeBoundedCodemodeScript(fixture);
  assert.equal(scriptResult.isError, false);
  const lifecycle = collectTypedRecords(fixture.sessionEvents);
  assert.ok(lifecycle.some((event) => event.type === "tool_execution_start" && event.toolName === CODEMODE),
    "Pi reports the real model-issued codemode root start");
  assert.ok(lifecycle.some((event) => event.type === "tool_execution_end" && event.toolName === CODEMODE
    && JSON.stringify(event.result ?? event).includes(SESSION_REPLACEMENT_MARKER)),
  "Pi reports the successful bounded codemode script result");
});

test("deferred OFF exposes and executes ordinary codemode after zero-MCP /new without a search call", { timeout: 180_000 }, async (t) => {
  const fixture = await startCandidate(t, { deferredPiTools: false });
  if (!fixture) return;

  const initial = await fixture.probeDump();
  assert.equal(requireTool(initial, CODEMODE).exposure, "model-only");
  assert.ok(initial.activeTools?.includes(CODEMODE), "deferred OFF keeps wrapper-authorized ordinary codemode active");
  const beforeEvents = fixture.sessionEvents.length;
  await replaceSession(fixture);

  const afterNew = await fixture.probeDump();
  assert.ok(afterNew.activeTools?.includes(CODEMODE), "ordinary codemode is active in the replacement session");
  const result = await executeBoundedCodemodeScript(fixture);
  assert.equal(result.isError, false);
  const newEvents = collectTypedRecords(fixture.sessionEvents.slice(beforeEvents));
  assert.ok(newEvents.some((event) => event.type === "tool_execution_end" && event.toolName === CODEMODE
    && JSON.stringify(event.result ?? event).includes(SESSION_REPLACEMENT_MARKER)));
  assert.equal(newEvents.some((event) => event.toolName === "search_tools"), false,
    "deferred OFF executes codemode without a search_tools activation step");
});

test("native --exclude-tools codemode remains authoritative across zero-MCP /new", { timeout: 180_000 }, async (t) => {
  const fixture = await startCandidate(t, { deferredPiTools: false, piArgs: ["--exclude-tools", CODEMODE] });
  if (!fixture) return;

  const initial = await fixture.probeDump();
  assert.equal(initial.allTools?.some((tool) => tool.name === CODEMODE), false,
    "Pi's native launch exclusion removes codemode from its real registry");
  const beforeEvents = fixture.sessionEvents.length;
  await replaceSession(fixture);

  const afterNew = await fixture.probeDump();
  assert.equal(afterNew.allTools?.some((tool) => tool.name === CODEMODE), false,
    "the native CLI exclusion survives extension and session replacement");
  assert.equal(afterNew.activeTools?.includes(CODEMODE), false);
  assert.doesNotMatch(requireTool(afterNew, "search_tools").description ?? "", /codemode/);

  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "search_tools", arguments: { query: CODEMODE } }] },
    { text: "excluded codemode search completed" },
  ]);
  await fixture.promptTurn("Try searching for the native-excluded codemode tool.");
  const result = rootToolResult(fixture.sessionEvents.slice(beforeEvents), "search_tools");
  const details = searchDetails(result.result);
  assert.ok(details);
  assert.deepEqual(details.matched, [], "the wrapper default cannot reintroduce native-excluded codemode");
});

test("native --no-tools keeps codemode inactive across zero-MCP /new", { timeout: 180_000 }, async (t) => {
  const fixture = await startCandidate(t, { deferredPiTools: false, piArgs: ["--no-tools"] });
  if (!fixture) return;

  const initial = await fixture.probeDump();
  assert.equal(initial.activeTools?.includes(CODEMODE), false,
    "the wrapper default cannot override Pi's native --no-tools selection");
  await replaceSession(fixture);

  const afterNew = await fixture.probeDump();
  assert.equal(afterNew.activeTools?.includes(CODEMODE), false,
    "the native --no-tools mask remains in force after session and extension replacement");
  const start = fixture.sessionEvents.length;
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: CODEMODE, arguments: { code: `return ${JSON.stringify(SESSION_REPLACEMENT_MARKER)}` } }] },
    { text: "native no-tools mask observed" },
  ]);
  await fixture.promptTurn("Attempt to invoke codemode while Pi's native --no-tools mask is set.");
  const attemptRecords = collectTypedRecords(fixture.sessionEvents.slice(start))
    .filter((event) => event.toolName === CODEMODE && event.parentToolCallId == null);
  assert.ok(attemptRecords.some((event) => event.type === "tool_execution_start"),
    `Pi should report the actual masked root attempt: ${JSON.stringify(attemptRecords)}`);
  const attempted = attemptRecords.find((event) => event.type === "tool_execution_end");
  assert.ok(attempted, `Pi should report the masked root result: ${JSON.stringify(attemptRecords)}`);
  assert.equal(attempted.isError, true, "Pi's native mask prevents the scripted root tool from executing");
  assert.ok(!JSON.stringify(attempted.result ?? attempted).includes(SESSION_REPLACEMENT_MARKER),
    "the masked script's bounded marker is never produced");
});
