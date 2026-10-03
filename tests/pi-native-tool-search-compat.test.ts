import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/**
 * #279 follow-up: warning-free tool_search compatibility against the REAL
 * installed Pi. The issue-279 target emitted misleading startup surfaces from
 * its factory-time loader registration and non-native parameter schema:
 * (1) the replaceable-builtin replacement warning ("registers tool
 * `tool_search`, so built-in extension ... was not loaded"), (2) the false
 * discovery notify ("MCP tools are only reachable from the codemode or
 * tool_search tool, but neither is active") fired whenever Pi's identity-based
 * tool_search recognition rejected the descriptor, and (3) extension load
 * failure lines. These tests pin that none of those surfaces appear with the
 * late-registered, native-schema loader — builtin enabled AND disabled at
 * startup, across /reload toggles — while discover→activate→echo keeps
 * working, and a genuinely missing tool_search still warns (negative control).
 */

const ECHO_TOOL = "mcp__prg_native_mcp__echo";
const TIMEOUTS = { requestMs: 30_000, connectMs: 30_000, turnMs: 90_000, dumpMs: 10_000 } as const;

/** The misleading surfaces only (a genuine load failure of another extension would still fail the run). */
const MISLEADING_STDERR = /registers tool `tool_search`|so built-in extension .* was not loaded|Failed to load extension.*index\.js/i;
const FALSE_DISCOVERY_NOTIFY = /MCP tools are only reachable from the codemode or tool_search tool/;

function gateConfig(): object {
  return {
    enabled: true,
    operatingMode: "execute",
    review: { activeReviewers: [], primaryEnabled: false, subtaskEnabled: false },
    execution: { deferredPiTools: true },
  };
}

async function startFixture(
  t: TestContext,
  options: { builtinEnabled: boolean; withCandidate: boolean },
): Promise<NativeMcpFixture | undefined> {
  const candidateEntry = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
  if (options.withCandidate && !candidateEntry) {
    skipOrFail(t, "native tool_search compatibility requires PI_REVIEW_GATE_CANDIDATE_ENTRY pointing to the fresh compiled candidate src/index.js");
    return undefined;
  }
  if (options.withCandidate) {
    assert.notEqual(resolve(candidateEntry!), resolve(process.cwd(), "dist", "src", "index.js"),
      "native tool_search compatibility must not exercise the live dist/");
  }

  const scratchParent = await mkdtemp(join(tmpdir(), "pi-native-tool-search-compat-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = scratchParent;
  const fixtureOptions: NativeMcpFixtureOptions = {
    ...(options.withCandidate ? {} : { candidateEntry: null }),
    gateConfig: gateConfig(),
    // Deferred exposure is the surface that makes Pi's discovery check require
    // a RECOGNIZED tool_search (isToolSearchTool identity check): with it, a
    // non-native parameter schema produces the false "MCP tools are only
    // reachable..." warning, while codemode exposure would be masked by
    // codemode auto-enablement.
    serverExposure: "deferred",
    // Real user-level Pi settings: the builtin tool-search extension enabled
    // (default) or explicitly disabled, exactly as a user would configure it.
    agentSettings: options.builtinEnabled ? {} : { extensions: ["-builtin:tool-search"] },
    wrapperDefault: true,
    scratchParent,
    timeouts: TIMEOUTS,
  };
  const prerequisites = describeFixturePrerequisites(fixtureOptions);
  if (!prerequisites.ok) {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(scratchParent, { recursive: true, force: true });
    skipOrFail(t, `native tool_search compatibility prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
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
  return fixture;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every notify message the session emitted so far. */
function notifyMessages(fixture: NativeMcpFixture): string[] {
  return fixture.sessionEvents
    .filter((event) => event.type === "extension_ui_request" && event.method === "notify")
    .map((event) => String(event.message ?? ""));
}

/** None of the issue-279 misleading surfaces may be present (RPC events or stderr). */
function assertNoMisleadingSurfaces(fixture: NativeMcpFixture, context: string): void {
  const falseNotifies = notifyMessages(fixture).filter((message) => FALSE_DISCOVERY_NOTIFY.test(message));
  assert.deepEqual(falseNotifies, [],
    `${context}: the false discovery warning must not be emitted:\n${falseNotifies.join("\n")}`);
  assert.doesNotMatch(fixture.stderrTailText(), MISLEADING_STDERR,
    `${context}: pi stderr must not carry a replacement or load-failure diagnostic for the loader:\n${fixture.stderrTailText()}`);
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
  timeoutMs = 30_000,
): Promise<FixtureEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await probeEvents(fixture)).find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`probe lifecycle event did not appear within ${timeoutMs}ms`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

/**
 * Discover→activate→echo through direct native calls. Keep codemode inactive
 * throughout: activating it could mask a tool_search recognition regression.
 */
async function searchActivateEcho(fixture: NativeMcpFixture, marker: string): Promise<void> {
  const start = fixture.sessionEvents.length;
  await fixture.setTurnScript([
    { toolCalls: [{ toolName: "tool_search", arguments: { query: ECHO_TOOL } }] },
    { toolCalls: [{ toolName: ECHO_TOOL, arguments: { message: marker } }] },
    { text: "compatibility turn complete" },
  ]);
  await fixture.promptTurn(`Use tool_search to find and activate ${ECHO_TOOL}, then call it with the marker.`);
  const events = fixture.sessionEvents.slice(start);

  const searches = collectTypedRecords(events)
    .filter((event) => event.toolName === "tool_search" && event.parentToolCallId == null
      && event.type === "tool_execution_end");
  assert.equal(searches.length, 1, `the tool_search call must run: ${JSON.stringify(searches)}`);
  for (const searchResult of searches) {
    assert.notEqual(searchResult.isError, true, `tool_search failed: ${JSON.stringify(searchResult)}`);
    const details = searchDetails(searchResult.result);
    assert.ok(details, `tool_search must return actual structured details: ${JSON.stringify(searchResult)}`);
    assert.ok((details.matched as string[]).length > 0, `the search must match an authorized tool: ${JSON.stringify(details)}`);
  }
  const echoDetails = searchDetails(searches.at(-1)?.result);
  assert.ok(echoDetails, "the echo search must return structured details");
  assert.deepEqual(echoDetails.matched, [ECHO_TOOL]);
  assert.ok((echoDetails.activated as string[]).includes(ECHO_TOOL) || (echoDetails.alreadyActive as string[]).includes(ECHO_TOOL),
    `the loader must activate (or report already active) ${ECHO_TOOL}: ${JSON.stringify(echoDetails)}`);

  const afterDump = await fixture.probeDump();
  assert.equal(afterDump.activeTools?.includes("codemode"), false,
    "codemode must stay inactive so it cannot mask broken tool_search recognition");
  assert.ok(afterDump.activeTools?.includes(ECHO_TOOL),
    "the activated echo tool is declared for the next model call");

  const echoResult = rootToolResult(events, ECHO_TOOL);
  assert.ok(JSON.stringify(echoResult.result ?? "").includes(marker),
    `the direct native echo result must contain its marker: ${JSON.stringify(echoResult)}`);
  assert.ok((await fixture.readServerEvents()).some((event) =>
    event.event === "tool_call" && event.tool === "echo"
    && isRecord(event.arguments) && event.arguments.message === marker,
  ), "the direct call must reach the real MCP server with its marker");
}

function requireTool(dump: ProbeDump, name: string): NonNullable<ProbeDump["allTools"]>[number] {
  const tool = dump.allTools?.find((candidate) => candidate.name === name);
  assert.ok(tool, `Pi's real getAllTools() registry should contain ${name}: ${JSON.stringify(dump.allTools)}`);
  return tool;
}

test("builtin tool_search enabled at startup: late loader registration stays warning-free and recognized (#279)", { timeout: 180_000 }, async (t) => {
  const fixture = await startFixture(t, { builtinEnabled: true, withCandidate: true });
  if (!fixture) return;

  const initial = await fixture.probeDump();
  assert.ok(requireTool(initial, "tool_search"), "the review-gate loader is registered");
  assertNoMisleadingSurfaces(fixture, "startup (builtin enabled)");

  await searchActivateEcho(fixture, "compat-enabled-ok");
  assertNoMisleadingSurfaces(fixture, "after discover/activate/echo (builtin enabled)");
});

test("builtin tool_search disabled at startup: bundled-factory schema keeps recognition warning-free (#279)", { timeout: 180_000 }, async (t) => {
  const fixture = await startFixture(t, { builtinEnabled: false, withCandidate: true });
  if (!fixture) return;

  // The user disabled the builtin tool-search extension: Pi's registry holds
  // no live native schema to borrow, so the loader must capture the exact
  // reference from the running install's bundled factory.
  const initial = await fixture.probeDump();
  assert.ok(requireTool(initial, "tool_search"), "the review-gate loader is registered");
  assertNoMisleadingSurfaces(fixture, "startup (builtin disabled)");

  await searchActivateEcho(fixture, "compat-disabled-ok");
  assertNoMisleadingSurfaces(fixture, "after discover/activate/echo (builtin disabled)");
});

test("toggling the builtin across a settings reload retains our loader and recognition (#279)", { timeout: 300_000 }, async (t) => {
  const fixture = await startFixture(t, { builtinEnabled: true, withCandidate: true });
  if (!fixture) return;

  const initial = await fixture.probeDump();
  assert.ok(requireTool(initial, "tool_search"), "the review-gate loader is registered");
  await searchActivateEcho(fixture, "compat-toggle-base-ok");

  // The reload reuses the SessionManager but runs a FRESH extension factory:
  // track the factory id, which is the incarnation boundary our late
  // registration must survive.
  let lastFactoryId = 1;
  const startsBefore = (await probeEvents(fixture)).filter((event) => event.event === "probe_session_start");
  assert.equal(startsBefore.length, 1, "exactly one session start before the first reload");

  const reloadSettings = async (settings: object): Promise<void> => {
    await writeFile(join(fixture.paths.piAgentDir, "settings.json"), `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
    // The fixture's /native-mcp-reload command drives the public ctx.reload()
    // seam (settings + extensions); RPC prompts never route built-in slash
    // commands, so this is the real-host toggle path.
    await fixture.runCommand("/native-mcp-reload");
    // A fresh extension factory and session start must be observed (bounded
    // wait) before the loader's late registration runs again for the
    // replacement incarnation.
    const replacement = await waitForProbeEvent(fixture, (event) =>
      event.event === "probe_session_start"
      && typeof event.factoryId === "number"
      && event.factoryId > lastFactoryId,
    );
    lastFactoryId = Number(replacement.factoryId);
  };

  // Builtin off: the live borrow source disappears; recognition must survive
  // on the bundled-factory reference for this session incarnation.
  await reloadSettings({ extensions: ["-builtin:tool-search"] });
  const afterOff = await fixture.probeDump();
  assert.ok(requireTool(afterOff, "tool_search"), "our loader survives the builtin-off reload");
  await searchActivateEcho(fixture, "compat-toggle-off-ok");
  assertNoMisleadingSurfaces(fixture, "after builtin-off /reload");

  // Builtin back on: a live native schema exists again; ours is retained and
  // still recognized (no competing definition, no false discovery warning).
  await reloadSettings({});
  const afterOn = await fixture.probeDump();
  assert.ok(requireTool(afterOn, "tool_search"), "our loader survives the builtin-on reload");
  await searchActivateEcho(fixture, "compat-toggle-on-ok");
  assertNoMisleadingSurfaces(fixture, "after builtin-on /reload");
});

test("without the loader, a genuinely missing tool_search still warns (#279 negative control)", { timeout: 180_000 }, async (t) => {
  const fixture = await startFixture(t, { builtinEnabled: false, withCandidate: false });
  if (!fixture) return;

  // No candidate extension and the builtin disabled: tool_search genuinely
  // does not exist while MCP tools do, so the discovery warning is GENUINE
  // and must remain visible — the no-warning assertions above are meaningful.
  const dump = await fixture.probeDump();
  assert.equal(dump.allTools?.some((tool) => tool.name === "tool_search"), false,
    "the negative control has no tool_search at all");

  await fixture.setTurnScript([{ text: "negative control turn complete" }]);
  await fixture.promptTurn("Say the negative control is complete.");
  assert.ok(notifyMessages(fixture).some((message) => FALSE_DISCOVERY_NOTIFY.test(message)),
    `the genuine discovery warning must remain visible: ${JSON.stringify(notifyMessages(fixture))}`);
});
