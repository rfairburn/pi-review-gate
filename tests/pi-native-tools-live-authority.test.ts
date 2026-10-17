/**
 * #421 production regression: top-level tool discovery follows Pi's CURRENT
 * permitted registry, never a session's restored/saved loadout.
 *
 * Every case drives the REAL installed Pi (`pi --mode rpc`, the same hermetic
 * native fixture as the other native suites) with the freshly compiled
 * candidate (PI_REVIEW_GATE_CANDIDATE_ENTRY, never the checkout's live
 * dist/), a scripted in-process model (no provider, credential, or network),
 * synthetic HOME/agent dir, and a synthetic trusted-project MCP server. The
 * assertions read what each model REQUEST actually received — the declared
 * tool schemas, the system-prompt inventory, and the tool_search description
 * — journaled by the fixture probe, plus the real tool_search results.
 *
 * Seams are production paths only:
 * - operating-mode and notice-feature changes go through the real
 *   `/review-settings` command (its plain-selector fallback, answered over
 *   Pi's documented RPC extension-UI sub-protocol) and its Save path;
 * - restart is a new Pi process with `--continue` over the same session dir;
 *   switch and fork are Pi's RPC `switch_session` / `fork` / `new_session`;
 * - native MCP changes use the server's `tools/list_changed`, Pi's public
 *   `registerMcpServer`, and the project `mcp.json` `enabled` flag that Pi
 *   re-reads on session start (the gate never writes it);
 * - explicit restrictions use Pi's own `--tools`, `--exclude-tools`, and
 *   `--no-tools`, including Pi 1.3's allowlist nuance (no `mcp__` entry keeps
 *   MCP tools registered while Pi declines to declare direct-exposure ones);
 * - the worker case launches the ACTUAL executor role with a fixed catalog.
 *
 * Not covered here (and not claimed): the TUI-only `/mcp` manager
 * interactions (see tests/pi-native-mcp-tui.test.ts) and a model-driven
 * SubtasksStart dispatch to a live Pi worker (the parent-side capture is
 * covered in tests/execution-tool-batch.test.ts).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";
import {
  createNativeMcpFixture,
  DEFAULT_SERVER_NAME,
  describeFixturePrerequisites,
  mcpToolName,
  ZERO_MODEL_GATE_CONFIG,
  type FixtureEvent,
  type FixtureTurnStep,
  type NativeMcpFixture,
  type NativeMcpFixtureOptions,
} from "./pi-native-mcp-fixture";
import { createExecutorToolCatalog } from "../src/execution/tool-catalog";
import { probeNativePowerShellHostSupport } from "../src/native-powershell-support";
import { skipOrFail } from "./bridge-fakes";

const CONTROL_EXTENSION_CANDIDATES = [
  resolvePath(__dirname, "..", "..", "tests", "fixtures", "pi-native-mcp-control.cjs"),
  resolvePath(process.cwd(), "tests", "fixtures", "pi-native-mcp-control.cjs"),
];
const CONTROL_EXTENSION = CONTROL_EXTENSION_CANDIDATES.find((candidate) => existsSync(candidate))
  ?? CONTROL_EXTENSION_CANDIDATES[0]!;
const LATE_SERVER = "prg_late_native";
const MODEL_ONLY_TOOL = "prg_native_model_only";
const FIXTURE_TIMEOUTS = { requestMs: 30_000, connectMs: 30_000, turnMs: 60_000, dumpMs: 10_000 } as const;

/** The top-level conservative baseline Pi permits by default (deferred tools on). */
const EXECUTE_BASELINE = ["read", "bash", "edit", "write", "grep", "find", "ls", "ApplyPatch", "SubtasksStart", "tool_search"];
const WRITE_CAPABLE = ["bash", "edit", "write", "ApplyPatch", "SubtasksStart"];
const PLAN_BASELINE = ["read", "grep", "find", "ls", "GitRead", "tool_search"];
/** Representative registered-but-inactive families: user input, shell, web, browser, notices, subtask observation. */
const DEFERRED_FAMILIES = ["AskUserQuestion", "ShellStart", "WebFetch", "WebSearch", "BrowserOpen", "BrowserClick", "YouShouldKnow", "SubtasksInspect"];

interface ModelRequest {
  tools: string[];
  systemPrompt: string;
  searchDescription: string;
}

type TestContext = { skip(message?: string): void; after(callback: () => void | Promise<void>): void };

/**
 * Zero-reviewer config plus one configured (never dispatched) execution
 * worker resource so the top level registers its real Subtasks controls.
 * The synthetic external worker is the Node binary itself; no test ever
 * starts a subtask, so it is never launched.
 */
function gateConfig(extra: Record<string, unknown> = {}): object {
  return {
    ...ZERO_MODEL_GATE_CONFIG,
    operatingMode: "execute",
    externalAgents: {
      synthetic: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      workerResources: { synthetic: { selection: { source: "external", id: "synthetic" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "synthetic" }], research: [] },
    },
    ...extra,
  };
}

async function startFixture(t: TestContext, options: Partial<NativeMcpFixtureOptions>): Promise<NativeMcpFixture | undefined> {
  const candidateEntry = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
  if (!candidateEntry) {
    skipOrFail(t, "live-authority regression requires PI_REVIEW_GATE_CANDIDATE_ENTRY pointing to the freshly compiled candidate src/index.js");
    return undefined;
  }
  assert.notEqual(resolvePath(candidateEntry), resolvePath(process.cwd(), "dist", "src", "index.js"),
    "the regression must not exercise the checkout's possibly stale live dist/");
  const fixtureOptions: NativeMcpFixtureOptions = {
    candidateEntry,
    additionalExtensions: [CONTROL_EXTENSION],
    gateConfig: gateConfig(),
    timeouts: FIXTURE_TIMEOUTS,
    ...options,
  };
  const prerequisites = describeFixturePrerequisites(fixtureOptions);
  if (!prerequisites.ok) {
    skipOrFail(t, `live-authority prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
    return undefined;
  }
  const fixture = createNativeMcpFixture(fixtureOptions);
  // Cleanup is registered before startup so every failure path terminates the
  // owned Pi child and removes only its own synthetic scratch tree.
  t.after(async () => {
    if (fixture.paths?.scratch) await fixture.dispose();
  });
  await fixture.start();
  await initSyntheticRepository(fixture);
  return fixture;
}

/** Hermetic synthetic Git repository for the project (no caller Git config, hooks, or signing). */
async function initSyntheticRepository(fixture: NativeMcpFixture): Promise<void> {
  const scratch = fixture.paths.scratch;
  const hooksPath = join(scratch, "git-hooks");
  const templatePath = join(scratch, "git-template");
  const globalConfig = join(scratch, "empty-gitconfig");
  await Promise.all([mkdir(hooksPath, { recursive: true }), mkdir(templatePath, { recursive: true }), writeFile(globalConfig, "", "utf8")]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, { HOME: scratch, USERPROFILE: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig });
  const options = { cwd: fixture.paths.project, env, stdio: "ignore" as const, timeout: 10_000 };
  execFileSync("git", ["-c", `core.hooksPath=${hooksPath}`, "init", "--quiet", `--template=${templatePath}`], options);
  execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${hooksPath}`,
    "-c", "user.name=Pi Native Fixture", "-c", "user.email=pi-native-fixture@example.invalid",
    "commit", "--no-gpg-sign", "--allow-empty", "--quiet", "-m", "synthetic live-authority baseline",
  ], options);
}

function modelRequestsSince(fixture: NativeMcpFixture, journalStart: number): ModelRequest[] {
  return fixture.readProbeJournal().slice(journalStart)
    .filter((entry) => entry.event === "model_request")
    .map((entry) => ({
      tools: Array.isArray(entry.requestToolNames) ? entry.requestToolNames.filter((name): name is string => typeof name === "string") : [],
      systemPrompt: typeof entry.systemPrompt === "string" ? entry.systemPrompt : "",
      searchDescription: typeof entry.toolSearchDescription === "string" ? entry.toolSearchDescription : "",
    }));
}

let turnSequence = 0;

async function runTurn(fixture: NativeMcpFixture, steps: FixtureTurnStep[]): Promise<{ requests: ModelRequest[]; records: FixtureEvent[] }> {
  const journalStart = fixture.readProbeJournal().length;
  const eventStart = fixture.sessionEvents.length;
  await fixture.setTurnScript(steps);
  await fixture.promptTurn(`live authority turn ${++turnSequence}`);
  const requests = modelRequestsSince(fixture, journalStart);
  assert.ok(requests.length > 0, "the scripted model must observe at least one request");
  return { requests, records: collectTypedRecords(fixture.sessionEvents.slice(eventStart)) };
}

/** The first model request of a fresh text-only turn: what the model sees at this seam. */
async function observe(fixture: NativeMcpFixture): Promise<ModelRequest> {
  return (await runTurn(fixture, [{ text: "observed" }])).requests[0]!;
}

interface SearchOutcome {
  matched: string[];
  activated: string[];
  alreadyActive: string[];
  refused: string[];
  outcome: unknown;
  /** The native result's error flag as Pi reported it (undefined when absent). */
  isError: unknown;
  text: string;
}

async function search(fixture: NativeMcpFixture, query: string): Promise<SearchOutcome> {
  const { records } = await runTurn(fixture, [
    { toolCalls: [{ toolName: "tool_search", arguments: { query } }] },
    { text: "search done" },
  ]);
  const end = records.find((event) => event.type === "tool_execution_end" && event.toolName === "tool_search");
  assert.ok(end, `tool_search(${query}) must complete through the candidate loader`);
  const details = findSearchDetails(end);
  assert.ok(details, `tool_search(${query}) must expose structured details: ${JSON.stringify(end).slice(0, 2000)}`);
  const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
  return {
    matched: names(details.matched),
    activated: names(details.activated),
    alreadyActive: names(details.alreadyActive),
    refused: names(details.refused),
    outcome: details.outcome,
    isError: end.isError,
    text: JSON.stringify(end),
  };
}

function inventorySegment(request: ModelRequest): string {
  const start = request.systemPrompt.lastIndexOf("Authorized tool names with purpose:");
  if (start < 0) return "";
  const end = request.systemPrompt.indexOf("If an authorized tool is inactive", start);
  return request.systemPrompt.slice(start, end < 0 ? undefined : end);
}

function inventoryHas(request: ModelRequest, name: string): boolean {
  const segment = inventorySegment(request);
  return segment.includes(`"${name}" (`) || segment.includes(`"${name}", `) || segment.includes(`"${name}".`);
}

function describe(request: ModelRequest): string {
  return `declared [${request.tools.join(", ")}]; description [${descriptionNames(request).join(", ")}]; inventory ${inventorySegment(request).slice(0, 4000)}`;
}

function descriptionNames(request: ModelRequest): string[] {
  const marker = "Authorized tool names: ";
  const start = request.searchDescription.indexOf(marker);
  if (start < 0) return [];
  return request.searchDescription.slice(start + marker.length).replace(/\.\s*$/, "").split(", ").map((name) => name.trim());
}

/** Discoverable = advertised by BOTH the system-prompt inventory and the tool_search description. */
function assertDiscoverable(request: ModelRequest, names: readonly string[], label: string): void {
  for (const name of names) {
    assert.ok(inventoryHas(request, name), `${label}: ${name} must be in the system-prompt inventory; ${describe(request)}`);
    assert.ok(descriptionNames(request).includes(name), `${label}: ${name} must be in the tool_search description; ${describe(request)}`);
    assert.ok(!request.tools.includes(name), `${label}: deferred candidate ${name} must not be declared before tool_search loads it; ${describe(request)}`);
  }
}

/** Absent = neither declared (no schema) nor advertised on any discovery surface. */
function assertAbsent(request: ModelRequest, names: readonly string[], label: string): void {
  for (const name of names) {
    assert.ok(!request.tools.includes(name), `${label}: ${name} must not be declared; ${describe(request)}`);
    assert.ok(!inventoryHas(request, name), `${label}: ${name} must not be in the inventory; ${describe(request)}`);
    assert.ok(!descriptionNames(request).includes(name), `${label}: ${name} must not be in the tool_search description; ${describe(request)}`);
  }
}

function assertDeclared(request: ModelRequest, names: readonly string[], label: string): void {
  for (const name of names) assert.ok(request.tools.includes(name), `${label}: ${name} must be declared; ${describe(request)}`);
}

/**
 * Drive the real `/review-settings` menu (plain-selector fallback over RPC):
 * each step picks a root row by its label prefix and optionally an option in
 * the opened chooser; the menu is then saved through its real Save path.
 */
async function saveSettings(fixture: NativeMcpFixture, steps: Array<{ row: string; option?: string }>): Promise<void> {
  const queue = [...steps];
  let pendingOption: string | undefined;
  let failure: string | undefined;
  let saveSent = false;
  const eventStart = fixture.sessionEvents.length;
  fixture.setUiResponder((request) => {
    if (request.method !== "select") return undefined;
    const options = Array.isArray(request.options) ? request.options.filter((option): option is string => typeof option === "string") : [];
    if (pendingOption !== undefined) {
      const wanted = pendingOption;
      pendingOption = undefined;
      const match = options.find((option) => option.startsWith(wanted));
      if (!match) failure ??= `option ${wanted} missing from ${JSON.stringify(options)}`;
      return match ? { value: match } : undefined;
    }
    // The Tools subsection is one nested menu inside the same transaction.
    if (request.title === "Tools") {
      if (failure) return undefined;
      const back = options.find((option) => option.startsWith("Back"));
      const step = queue.shift();
      if (!step) return back === undefined ? undefined : { value: back };
      const row = options.find((option) => option.startsWith(step.row));
      if (!row) {
        failure = `row ${step.row} missing from ${JSON.stringify(options)}`;
        return back === undefined ? undefined : { value: back };
      }
      pendingOption = step.option;
      return { value: row };
    }
    if (request.title !== "Review settings") {
      failure ??= `unexpected selector ${String(request.title)}`;
      return undefined;
    }
    if (failure) return { value: "Cancel" };
    if (saveSent) {
      // The root menu reappears only when Save was rejected (validation).
      failure = "the settings Save was rejected";
      return { value: "Cancel" };
    }
    const step = queue.shift();
    if (!step) {
      saveSent = true;
      return { value: "Save changes" };
    }
    const row = options.find((option) => option.startsWith(step.row));
    if (!row) {
      failure = `row ${step.row} missing from ${JSON.stringify(options)}`;
      return { value: "Cancel" };
    }
    pendingOption = step.option;
    return { value: row };
  });
  try {
    await fixture.runCommand("/review-settings");
    const deadline = Date.now() + FIXTURE_TIMEOUTS.requestMs;
    while (!fixture.sessionEvents.slice(eventStart).some((event) =>
      event.type === "extension_ui_request" && event.method === "notify" && event.message === "Review settings saved.")) {
      if (failure) break;
      assert.ok(Date.now() < deadline, "the real settings Save path must report completion");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    fixture.setUiResponder(undefined);
  }
  assert.equal(failure, undefined, failure);
  assert.equal(queue.length, 0, "every settings step must be applied before Save");
}

async function setMode(fixture: NativeMcpFixture, label: "Plan/research" | "Prefer execution" | "Prefer orchestration"): Promise<void> {
  await saveSettings(fixture, [{ row: "Operating mode", option: label }]);
}

async function sessionFile(fixture: NativeMcpFixture): Promise<string> {
  const state = await fixture.rpc("get_state") as Record<string, unknown>;
  assert.equal(typeof state.sessionFile, "string", "the native session must be persisted to a session file");
  return state.sessionFile as string;
}

async function publicControl(fixture: NativeMcpFixture, action: string): Promise<void> {
  await fixture.runCommand(`/native-mcp-control ${action}`);
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

test("#421 top-level discovery follows the live registry across fresh start, Plan/research round trips, and registry changes", { timeout: 600_000 }, async (t) => {
  const fixture = await startFixture(t, { serverExposure: "codemode", wrapperDefault: true });
  if (!fixture) return;
  const echo = mcpToolName(fixture.serverName, "echo");
  const echoSecond = mcpToolName(fixture.serverName, "echo_second");
  const counter = mcpToolName(fixture.serverName, "counter");
  const lateEcho = mcpToolName(LATE_SERVER, "echo_second");
  const mcpConfigBefore = readFileSync(fixture.paths.mcpConfig, "utf8");
  await fixture.waitForRegisteredTools([echo, counter]);

  // Fresh session: the baseline is declared; every other permitted family is
  // a deferred discovery candidate on both discovery surfaces.
  const fresh = await observe(fixture);
  assertDeclared(fresh, EXECUTE_BASELINE, "fresh execute");
  assertDiscoverable(fresh, [...DEFERRED_FAMILIES, "codemode", echo, counter], "fresh execute");

  // Deferred exact searches across families activate; an already-active
  // exact search reports already-active without changing the contract.
  const loaded = await search(fixture, `AskUserQuestion ShellStart WebFetch BrowserOpen ${echo}`);
  assert.deepEqual([...loaded.activated].sort(), ["AskUserQuestion", "BrowserOpen", "ShellStart", "WebFetch", echo].sort());
  const already = await search(fixture, "read");
  assert.deepEqual(already.activated, []);
  assert.deepEqual(already.alreadyActive, ["read"]);
  const afterLoad = await observe(fixture);
  assertDeclared(afterLoad, ["AskUserQuestion", "ShellStart", "WebFetch", "BrowserOpen", echo], "after exact search");
  const againLoaded = await search(fixture, "AskUserQuestion");
  assert.deepEqual(againLoaded.alreadyActive, ["AskUserQuestion"], "a loaded tool reports already active");

  // Enter Plan/research through the real settings Save path: forbidden tools
  // are removed even when previously active — including the loaded MCP tool
  // whose server annotation claims readOnlyHint:true.
  await setMode(fixture, "Plan/research");
  const plan = await observe(fixture);
  assertDeclared(plan, PLAN_BASELINE, "plan/research");
  assertAbsent(plan, [...WRITE_CAPABLE, "AskUserQuestion", "ShellStart", "codemode", echo, counter, "BrowserClick"], "plan/research");
  assertDeclared(plan, ["WebFetch", "BrowserOpen"], "read-only research selections stay loaded");
  assertDiscoverable(plan, ["WebSearch", "SubtasksInspect"], "plan/research");
  assert.deepEqual((await search(fixture, echo)).matched, [], "readOnlyHint MCP stays unmatchable in research");
  assert.deepEqual((await search(fixture, "ApplyPatch")).matched, [], "write-capable tools stay unmatchable in research");

  // Registry changes while restricted: the project server withdraws echo and
  // adds echo_second; a public late MCP server and a model-only extension
  // tool register. None surfaces in research.
  await fixture.rotateToolList(2);
  await publicControl(fixture, "register");
  await publicControl(fixture, "register-model-only");
  await fixture.waitForRegisteredTools([echoSecond, lateEcho, MODEL_ONLY_TOOL],
    (dump) => dump.allTools?.some((tool) => tool.name === echo && tool.exposure === "hidden") === true);
  const planChanged = await observe(fixture);
  assertAbsent(planChanged, [echo, echoSecond, lateEcho, MODEL_ONLY_TOOL, "codemode"], "plan/research after registry changes");

  // Return to a write-capable mode: the tool set is rebuilt from the registry
  // as it is now. Baseline writes return, pre-plan selections are not
  // resurrected, new permitted names are discoverable, withdrawn ones are not.
  await setMode(fixture, "Prefer execution");
  const back = await observe(fixture);
  assertDeclared(back, EXECUTE_BASELINE, "back to execute");
  assertDiscoverable(back, ["AskUserQuestion", "ShellStart", "codemode", echoSecond, counter, lateEcho, MODEL_ONLY_TOOL], "back to execute");
  assertAbsent(back, [echo], "withdrawn MCP tool");
  assert.deepEqual((await search(fixture, echo)).matched, [], "the withdrawn name is not discoverable");
  const newLoad = await search(fixture, `${echoSecond} ${lateEcho} ${MODEL_ONLY_TOOL}`);
  assert.deepEqual([...newLoad.activated].sort(), [echoSecond, lateEcho, MODEL_ONLY_TOOL].sort());
  assertDeclared(await observe(fixture), [echoSecond, lateEcho, MODEL_ONLY_TOOL], "newly loaded registrations");

  assert.equal(readFileSync(fixture.paths.mcpConfig, "utf8"), mcpConfigBefore, "the gate never writes native MCP configuration");
});

test("#421 a --continue restart re-derives discovery from the live registry, including a resumed Plan/research transcript", { timeout: 600_000 }, async (t) => {
  const fixture = await startFixture(t, { serverExposure: "codemode", wrapperDefault: true });
  if (!fixture) return;
  const echo = mcpToolName(fixture.serverName, "echo");
  const counter = mcpToolName(fixture.serverName, "counter");
  await fixture.waitForRegisteredTools([echo, counter]);

  // A session whose last loadout carries only a few loaded names.
  assert.deepEqual((await search(fixture, "WebFetch")).activated, ["WebFetch"]);
  await observe(fixture);

  // Restart the Pi process with --continue in execute mode: Pi restores the
  // transcript loadout, but discovery is re-derived from the live registry.
  await fixture.respawn(["--continue"]);
  await fixture.waitForRegisteredTools([echo, counter]);
  const resumed = await observe(fixture);
  assertDeclared(resumed, EXECUTE_BASELINE, "resumed execute");
  assertDiscoverable(resumed, [...DEFERRED_FAMILIES.filter((name) => name !== "WebFetch"), "codemode", echo, counter], "resumed execute");
  const familySearch = await search(fixture, "AskUserQuestion ShellStart WebSearch BrowserClick YouShouldKnow");
  assert.deepEqual([...familySearch.activated].sort(), ["AskUserQuestion", "BrowserClick", "ShellStart", "WebSearch", "YouShouldKnow"]);

  // The historical mismatch: a Plan/research transcript resumed in execute.
  // Pi restores the plan loadout (no writes); the next mode change back must
  // rebuild baseline writes and full discovery from the current registry.
  await setMode(fixture, "Plan/research");
  await observe(fixture);
  await fixture.respawn(["--continue"]);
  await fixture.waitForRegisteredTools([echo, counter]);
  const resumedPlan = await observe(fixture);
  assertDeclared(resumedPlan, PLAN_BASELINE, "resumed plan/research");
  assertAbsent(resumedPlan, [...WRITE_CAPABLE, "AskUserQuestion", "codemode", echo], "resumed plan/research");
  await setMode(fixture, "Prefer orchestration");
  const resumedBack = await observe(fixture);
  assertDeclared(resumedBack, EXECUTE_BASELINE, "plan transcript resumed then orchestrate");
  assertDiscoverable(resumedBack, [...DEFERRED_FAMILIES.filter((name) => name !== "WebFetch"), "codemode", echo, counter], "plan transcript resumed then orchestrate");
  assert.deepEqual((await search(fixture, `ShellStart ${echo}`)).activated.sort(), ["ShellStart", echo].sort());
});

test("#421 in-process switch and fork re-derive discovery; CLI exclusions and notice settings stay authoritative", { timeout: 600_000 }, async (t) => {
  // --exclude-tools is an explicit native restriction that removes names
  // (codemode included) from Pi's registry for this whole process.
  const fixture = await startFixture(t, { serverExposure: "codemode", piArgs: ["--exclude-tools", "WebSearch,BrowserClick,codemode"] });
  if (!fixture) return;
  const echo = mcpToolName(fixture.serverName, "echo");
  await fixture.waitForRegisteredTools([echo]);
  const excluded = ["WebSearch", "BrowserClick", "codemode"];

  const first = await observe(fixture);
  assertDeclared(first, EXECUTE_BASELINE, "session A execute");
  assertDiscoverable(first, ["AskUserQuestion", "ShellStart", "WebFetch", "BrowserOpen", "YouShouldKnow", echo], "session A execute");
  assertAbsent(first, excluded, "session A execute");
  assert.deepEqual((await search(fixture, "WebSearch BrowserClick codemode")).matched, [], "excluded names never match");

  // Session A ends on a Plan/research loadout (no write-capable declarations).
  await setMode(fixture, "Plan/research");
  await observe(fixture);
  const sessionA = await sessionFile(fixture);

  // A new session, then back to execute, then switch to session A: Pi
  // restores A's plan loadout while the primary mode is execute.
  await fixture.restartSession();
  await fixture.ensureScriptedModel();
  await fixture.waitForRegisteredTools([echo]);
  await setMode(fixture, "Prefer execution");
  const sessionB = await observe(fixture);
  assertDeclared(sessionB, EXECUTE_BASELINE, "new session B");
  await fixture.rpc("switch_session", { sessionPath: sessionA });
  await fixture.ensureScriptedModel();
  // Pi reconnects MCP servers asynchronously on every session start.
  await fixture.waitForRegisteredTools([echo]);
  const switched = await observe(fixture);
  assertDeclared(switched, EXECUTE_BASELINE, "switched to a plan transcript in execute");
  assertDiscoverable(switched, ["AskUserQuestion", "ShellStart", "WebFetch", "BrowserOpen", "YouShouldKnow", "SubtasksInspect", echo], "switched session");
  assertAbsent(switched, excluded, "switched session");

  // Fork from the first user message of A: a new branch session.
  const forkable = await fixture.rpc("get_fork_messages") as { messages?: Array<{ entryId: string }> };
  const entryId = forkable.messages?.[0]?.entryId;
  assert.ok(entryId, "session A must offer a fork point");
  await fixture.rpc("fork", { entryId });
  await fixture.ensureScriptedModel();
  await fixture.waitForRegisteredTools([echo]);
  const forked = await observe(fixture);
  assertDeclared(forked, EXECUTE_BASELINE, "forked session");
  assertDiscoverable(forked, ["AskUserQuestion", "ShellStart", "YouShouldKnow", echo], "forked session");
  assertAbsent(forked, excluded, "forked session");

  // The YouShouldKnow notice feature is a live feature control: Off removes
  // it from every surface; On restores it as a candidate.
  await saveSettings(fixture, [{ row: "Tools" }, { row: "YouShouldKnow notices" }]);
  const noticesOff = await observe(fixture);
  assertAbsent(noticesOff, ["YouShouldKnow"], "notices off");
  assert.deepEqual((await search(fixture, "YouShouldKnow")).matched, [], "a disabled feature is not matchable");
  await saveSettings(fixture, [{ row: "Tools" }, { row: "YouShouldKnow notices" }]);
  assertDiscoverable(await observe(fixture), ["YouShouldKnow"], "notices on");
});

test("#421 manual codemode follows the live registry; Pi's native powershell follows actual host support with bash parity", { timeout: 600_000 }, async (t) => {
  // A manual launch (no wrapper marker) whose Pi settings select codemode and
  // Pi's builtin powershell. Pi applies settings selections at a fresh start
  // only; on --continue it restores the transcript's declarations instead.
  // Neither Pi's own selection nor a restored declaration authorizes the
  // builtin on a host that cannot run it.
  const fixture = await startFixture(t, { serverExposure: "codemode", agentSettings: { defaultTools: ["+codemode", "+powershell"] } });
  if (!fixture) return;
  const echo = mcpToolName(fixture.serverName, "echo");
  const registered = await fixture.waitForRegisteredTools([echo, "powershell"]);
  // Real Pi registers its builtin powershell on every platform and discloses
  // that provenance publicly; the gate keys on it, never on the name alone.
  const builtinShell = registered.allTools?.find((tool) => tool.name === "powershell");
  assert.deepEqual(builtinShell?.sourceInfo, { path: "builtin:powershell", source: "builtin" },
    `Pi must report its own powershell as a builtin: ${JSON.stringify(builtinShell)}`);
  // Pi can run that builtin only on Windows with pwsh.exe/powershell.exe.
  const nativePowerShell = probeNativePowerShellHostSupport();
  if (process.platform !== "win32") assert.equal(nativePowerShell, false, "Pi's native powershell is Windows-only");
  const assertShells = (request: ModelRequest, label: string): void => {
    assertDeclared(request, ["bash"], label);
    if (nativePowerShell) assertDeclared(request, ["powershell"], `${label} (supported host: bash parity)`);
    else assertAbsent(request, ["powershell"], `${label} (unsupported native host)`);
  };

  const fresh = await observe(fixture);
  assertDiscoverable(fresh, ["codemode"], "fresh manual launch");
  assertShells(fresh, "fresh manual launch");
  if (!nativePowerShell) {
    const shellSearch = await search(fixture, "powershell");
    assert.ok(!shellSearch.matched.includes("powershell"), "an unsupported native builtin is never matchable");
    assert.ok(!shellSearch.activated.includes("powershell"), "an unsupported native builtin never activates");
  }

  // A Plan/research transcript records a loadout without codemode.
  await setMode(fixture, "Plan/research");
  assertAbsent(await observe(fixture), ["codemode", "bash", "powershell"], "plan/research");
  await fixture.respawn(["--continue"]);
  await fixture.waitForRegisteredTools([echo]);
  assertAbsent(await observe(fixture), ["codemode", "bash", "powershell"], "resumed plan/research");
  // Resumed from a transcript lacking codemode's declaration, the currently
  // registered codemode is a candidate again in a write-capable mode, and the
  // shells are rebuilt from the live registry and host support.
  await setMode(fixture, "Prefer execution");
  const resumed = await observe(fixture);
  assertDiscoverable(resumed, ["codemode", echo], "resumed without a codemode declaration");
  assertShells(resumed, "resumed without a codemode declaration");

  // Stale declarations: load codemode, then resume a transcript that declares
  // it. Restored activity is not auto-loading: it is a candidate again.
  const loaded = await search(fixture, "codemode powershell");
  assert.deepEqual(loaded.activated, ["codemode"]);
  if (nativePowerShell) assert.deepEqual(loaded.alreadyActive, ["powershell"]);
  else assert.ok(!loaded.matched.includes("powershell"), "the unsupported native builtin never activates");
  assertDeclared(await observe(fixture), ["codemode"], "loaded");
  await fixture.respawn(["--continue"]);
  await fixture.waitForRegisteredTools([echo]);
  const resumedStale = await observe(fixture);
  assertDiscoverable(resumedStale, ["codemode"], "resumed with stale declarations");
  assertShells(resumedStale, "resumed with stale declarations");

  // The inverse: the same declaring transcript resumed under an explicit
  // native exclusion grants nothing, on any host.
  await fixture.respawn(["--exclude-tools", "codemode,powershell", "--continue"]);
  await fixture.waitForRegisteredTools([echo]);
  assertAbsent(await observe(fixture), ["codemode", "powershell"], "stale declarations under --exclude-tools");
  const excludedSearch = await search(fixture, "codemode powershell");
  for (const name of ["codemode", "powershell"]) {
    assert.ok(!excludedSearch.matched.includes(name), `excluded ${name} never matches`);
    assert.ok(!excludedSearch.activated.includes(name), `excluded ${name} never activates`);
  }
});

test("#421 native /mcp enablement stays Pi-owned across mode transitions and session restores", { timeout: 600_000 }, async (t) => {
  const fixture = await startFixture(t, { serverExposure: "codemode", wrapperDefault: true });
  if (!fixture) return;
  const echo = mcpToolName(fixture.serverName, "echo");
  const counter = mcpToolName(fixture.serverName, "counter");
  await fixture.waitForRegisteredTools([echo, counter]);
  const agentSettings = join(fixture.paths.piAgentDir, "settings.json");
  const settingsExisted = existsSync(agentSettings);

  // Deferred-exposure MCP tools are candidates, never auto-declared; the
  // codemode script channel reaches them without declaration once codemode
  // itself is loaded through tool_search.
  const start = await observe(fixture);
  assertDiscoverable(start, [echo, counter, "codemode"], "enabled server");
  assert.deepEqual((await search(fixture, "codemode")).activated, ["codemode"]);
  const counterBefore = await fixture.readCounter();
  const script = await runTurn(fixture, [
    { codemode: `return JSON.stringify(await tools.${counter}({ label: "live-authority" }));` },
    { text: "script done" },
  ]);
  assert.ok(script.records.some((event) => event.type === "tool_execution_end" && event.toolName === "codemode"));
  assert.equal(await fixture.readCounter(), counterBefore + 1, "the native script channel reaches the deferred MCP callee");
  assert.ok(!(await observe(fixture)).tools.includes(counter), "script calls never declare the deferred callee");

  // Disable the server natively (project mcp.json), enter Plan/research, and
  // start a new session so Pi re-reads its MCP configuration.
  await fixture.setServerEnabled(false);
  const disabledConfig = readFileSync(fixture.paths.mcpConfig, "utf8");
  await setMode(fixture, "Plan/research");
  await fixture.restartSession();
  await fixture.ensureScriptedModel();
  await fixture.waitForRegisteredTools([], (dump) => !dump.allTools?.some((tool) => tool.name === echo && tool.exposure !== "hidden"));
  assertAbsent(await observe(fixture), [echo, counter, "codemode"], "disabled server in research");
  await setMode(fixture, "Prefer execution");
  const disabled = await observe(fixture);
  assertAbsent(disabled, [echo, counter], "disabled server in execute");
  assert.deepEqual((await search(fixture, echo)).matched, [], "a natively disabled MCP tool is not resurrected");

  // Re-enable natively and restore: candidates again, still not declared.
  await fixture.setServerEnabled(true);
  await fixture.restartSession();
  await fixture.ensureScriptedModel();
  await fixture.waitForRegisteredTools([echo, counter], (dump) => dump.allTools?.some((tool) => tool.name === echo && tool.exposure !== "hidden") === true);
  const reenabled = await observe(fixture);
  assertDiscoverable(reenabled, [echo, counter], "re-enabled server");
  assert.deepEqual((await search(fixture, echo)).activated, [echo], "tool_search remains the activation path");

  assert.notEqual(disabledConfig, readFileSync(fixture.paths.mcpConfig, "utf8"), "only the fixture toggled enablement");
  assert.equal(existsSync(agentSettings), settingsExisted, "the gate writes no native Pi settings file");
});

test("#421 a running worker keeps its fixed catalog ceiling while the registry and primary settings change", { timeout: 300_000 }, async (t) => {
  const catalog = createExecutorToolCatalog(["read", "grep", "find", "ls", "WebFetch"], ["read", "grep", "find", "ls"]);
  const fixture = await startFixture(t, { serverExposure: "codemode", executorToolCatalog: catalog });
  if (!fixture) return;
  const echo = mcpToolName(fixture.serverName, "echo");
  const lateEcho = mcpToolName(LATE_SERVER, "echo");

  const initial = await observe(fixture);
  assertDeclared(initial, ["read", "grep", "find", "ls", "tool_search"], "worker start");
  assertAbsent(initial, ["write", "bash", "ApplyPatch", "AskUserQuestion", "codemode", echo], "worker start");
  assert.deepEqual((await search(fixture, "WebFetch")).activated, ["WebFetch"], "an in-ceiling candidate loads");

  // Primary-side changes cannot reach the worker: the persisted operating
  // mode flips, and new registrations (a late MCP server outside the native
  // allowlist's MCP filter) appear in the worker's own Pi registry.
  await writeFile(join(fixture.paths.piAgentDir, "review-gate.json"), `${JSON.stringify(gateConfig({ operatingMode: "plan-research" }))}\n`, "utf8");
  await publicControl(fixture, "register");
  await fixture.waitForRegisteredTools([lateEcho]);
  const after = await observe(fixture);
  assertDeclared(after, ["read", "grep", "find", "ls", "WebFetch", "tool_search"], "worker after primary changes");
  assertAbsent(after, [lateEcho, echo, "write", "AskUserQuestion"], "worker after primary changes");
  assert.deepEqual((await search(fixture, lateEcho)).matched, [], "registrations outside the ceiling never become discoverable");
});

/**
 * An explicit native allowlist of the execute baseline plus tool_search and
 * one ordinary deferred candidate — no `mcp__` entry. Pi keeps MCP tools
 * registered for codemode/tool_search under such a list.
 */
const ALLOWLIST_WITHOUT_MCP = [...EXECUTE_BASELINE, "WebFetch"];

test("#421 a --tools allowlist naming no mcp__ entry: Pi's refusal of direct-exposure MCP tools is reported, never claimed as activation", { timeout: 600_000 }, async (t) => {
  const fixture = await startFixture(t, { serverExposure: "direct", piArgs: ["--tools", ALLOWLIST_WITHOUT_MCP.join(",")] });
  if (!fixture) return;
  const echo = mcpToolName(fixture.serverName, "echo");
  const counter = mcpToolName(fixture.serverName, "counter");
  const mcpConfigBefore = readFileSync(fixture.paths.mcpConfig, "utf8");
  // Pi lists the direct-exposure MCP tools in getAllTools() under this
  // allowlist; whether it will DECLARE them is Pi's own policy.
  const registered = await fixture.waitForRegisteredTools([echo, counter]);
  for (const name of [echo, counter]) {
    assert.equal(registered.allTools?.find((entry) => entry.name === name)?.exposure, "direct", `${name} keeps its native direct exposure`);
  }

  const start = await observe(fixture);
  assertDeclared(start, EXECUTE_BASELINE, "allowlisted execute baseline");
  assertAbsent(start, ["AskUserQuestion", "ShellStart", "codemode", "WebSearch"], "names outside the allowlist");
  // Registered candidates stay listed: Pi offers no public per-tool
  // activatability query, so the gate does not guess which ones Pi declines.
  assertDiscoverable(start, ["WebFetch", echo, counter], "registered candidates under the allowlist");

  // The real search: Pi's post-write active set declines the MCP tool, so it
  // is reported as refused — not activated, not already active — and the
  // request fails rather than reading as success.
  const refused = await search(fixture, echo);
  assert.deepEqual(refused.matched, [echo]);
  assert.deepEqual(refused.activated, [], `a declined activation is never reported activated: ${refused.text.slice(0, 2000)}`);
  assert.deepEqual(refused.alreadyActive, [], "a declined activation is never reported already active");
  assert.deepEqual(refused.refused, [echo]);
  assert.equal(refused.outcome, "refused");
  assert.equal(refused.isError, true, "Pi receives the refusal-only search as a failed tool result");
  assert.match(refused.text, /Not activated: mcp__/);
  const afterRefusal = await observe(fixture);
  assert.ok(!afterRefusal.tools.includes(echo), `the declined MCP tool is not declared: ${describe(afterRefusal)}`);
  assertDiscoverable(afterRefusal, [echo, counter], "candidates after a refusal (inventory unchanged)");

  // A repeat is still a refusal (no retained selection turns it into
  // "already active"), and an ordinary candidate beside it still activates.
  const mixed = await search(fixture, `WebFetch ${echo} ${counter}`);
  assert.deepEqual(mixed.activated, ["WebFetch"]);
  assert.deepEqual(mixed.alreadyActive, []);
  assert.deepEqual([...mixed.refused].sort(), [counter, echo].sort());
  assert.equal(mixed.outcome, "activated");
  assert.equal(mixed.isError, false, "a search that activated something is not a failure");
  const afterMixed = await observe(fixture);
  assertDeclared(afterMixed, ["WebFetch"], "ordinary activation beside a refusal");
  assert.ok(!afterMixed.tools.includes(echo) && !afterMixed.tools.includes(counter), `declined MCP tools stay undeclared: ${describe(afterMixed)}`);
  const alreadyLoaded = await search(fixture, "WebFetch");
  assert.deepEqual(alreadyLoaded.alreadyActive, ["WebFetch"], "an actually active tool reports already active");

  assert.equal(readFileSync(fixture.paths.mcpConfig, "utf8"), mcpConfigBefore, "the gate never writes native MCP configuration");
});

test("#421 explicit native allowlists: named direct MCP and allowed deferred-exposure MCP load through tool_search; exclusions and --no-tools forbid; Plan/research excludes MCP", { timeout: 600_000 }, async (t) => {
  // (a) Naming the direct-exposure MCP tool in --tools makes Pi permit its
  // declaration; the `mcp__` entry also filters every unnamed MCP tool out of
  // Pi's registry.
  const named = await startFixture(t, { serverExposure: "direct", piArgs: ["--tools", [...EXECUTE_BASELINE, mcpToolName(DEFAULT_SERVER_NAME, "echo")].join(",")] });
  if (!named) return;
  const echo = mcpToolName(named.serverName, "echo");
  const counter = mcpToolName(named.serverName, "counter");
  assert.equal(echo, mcpToolName(DEFAULT_SERVER_NAME, "echo"), "the allowlist names the fixture server's echo tool");
  const namedConfigBefore = readFileSync(named.paths.mcpConfig, "utf8");
  await named.waitForRegisteredTools([echo]);
  assert.ok(await named.waitForServerLog((event) => event.event === "tools_list"), "Pi listed the server's tools");
  const namedStart = await observe(named);
  assertDiscoverable(namedStart, [echo], "named direct MCP");
  assertAbsent(namedStart, [counter], "unnamed MCP under an mcp__ allowlist");
  const loaded = await search(named, echo);
  assert.deepEqual(loaded.activated, [echo]);
  assert.deepEqual(loaded.refused, []);
  assertDeclared(await observe(named), [echo], "named direct MCP after tool_search");
  assert.deepEqual((await search(named, counter)).matched, [], "the filtered MCP tool is not discoverable");
  // Plan/research removes the loaded MCP tool even though the server marks
  // it readOnlyHint:true, and keeps it unmatchable.
  await setMode(named, "Plan/research");
  const namedPlan = await observe(named);
  // GitRead is outside this allowlist, so Pi's registry withholds it too.
  assertDeclared(namedPlan, PLAN_BASELINE.filter((name) => name !== "GitRead"), "allowlisted plan/research");
  assertAbsent(namedPlan, [echo, counter, ...WRITE_CAPABLE], "plan/research under an allowlist");
  assert.deepEqual((await search(named, echo)).matched, [], "a loaded readOnlyHint MCP tool is unmatchable in research");
  assert.equal(readFileSync(named.paths.mcpConfig, "utf8"), namedConfigBefore, "the gate never writes native MCP configuration");
  await named.dispose();

  // (b) A deferred-exposure server under an allowlist naming no mcp__ entry:
  // Pi permits tool_search to declare it, so the gate's search activates it.
  // --exclude-tools still removes the excluded MCP tool from every surface.
  const deferred = await startFixture(t, {
    serverExposure: "deferred",
    piArgs: ["--tools", ALLOWLIST_WITHOUT_MCP.join(","), "--exclude-tools", mcpToolName(DEFAULT_SERVER_NAME, "counter")],
  });
  if (!deferred) return;
  const deferredEcho = mcpToolName(deferred.serverName, "echo");
  const deferredCounter = mcpToolName(deferred.serverName, "counter");
  const deferredConfigBefore = readFileSync(deferred.paths.mcpConfig, "utf8");
  await deferred.waitForRegisteredTools([deferredEcho]);
  const deferredStart = await observe(deferred);
  assertDiscoverable(deferredStart, [deferredEcho], "allowed deferred-exposure MCP");
  assertAbsent(deferredStart, [deferredCounter], "--exclude-tools MCP");
  const deferredLoad = await search(deferred, deferredEcho);
  assert.deepEqual(deferredLoad.activated, [deferredEcho]);
  assert.deepEqual(deferredLoad.refused, []);
  assertDeclared(await observe(deferred), [deferredEcho], "deferred-exposure MCP after tool_search");
  assert.deepEqual((await search(deferred, deferredCounter)).matched, [], "an excluded MCP tool never matches");
  await setMode(deferred, "Plan/research");
  assertAbsent(await observe(deferred), [deferredEcho, deferredCounter], "plan/research removes loaded deferred MCP");
  assert.equal(readFileSync(deferred.paths.mcpConfig, "utf8"), deferredConfigBefore, "the gate never writes native MCP configuration");
  await deferred.dispose();

  // (c) --no-tools: Pi's empty allowlist filters every tool, MCP included,
  // and the gate restores nothing (its own loader is filtered too).
  const none = await startFixture(t, { serverExposure: "deferred", piArgs: ["--no-tools"] });
  if (!none) return;
  const noneEcho = mcpToolName(none.serverName, "echo");
  const noneCounter = mcpToolName(none.serverName, "counter");
  assert.ok(await none.waitForServerLog((event) => event.event === "tools_list"), "Pi listed the server's tools before the observation");
  const noneDump = await none.probeDump();
  assert.ok(!noneDump.allTools?.some((entry) => entry.name.startsWith("mcp__")), "--no-tools keeps MCP tools out of Pi's registry");
  const noneRequest = await observe(none);
  assertAbsent(noneRequest, [noneEcho, noneCounter, "tool_search", ...EXECUTE_BASELINE], "--no-tools");
});

test("#421 deferred tools Off: the full base requests direct-exposure MCP tools, Pi declines them under an allowlist without mcp__, and search reports the refusal", { timeout: 300_000 }, async (t) => {
  const base = gateConfig() as { execution: Record<string, unknown> } & Record<string, unknown>;
  const fixture = await startFixture(t, {
    serverExposure: "direct",
    piArgs: ["--tools", ALLOWLIST_WITHOUT_MCP.join(",")],
    gateConfig: { ...base, execution: { ...base.execution, deferredPiTools: false } },
  });
  if (!fixture) return;
  const echo = mcpToolName(fixture.serverName, "echo");
  const counter = mcpToolName(fixture.serverName, "counter");
  const mcpConfigBefore = readFileSync(fixture.paths.mcpConfig, "utf8");
  await fixture.waitForRegisteredTools([echo, counter]);

  const start = await observe(fixture);
  assertDeclared(start, [...EXECUTE_BASELINE, "WebFetch"], "deferred-off allowlisted tools");
  assert.ok(!start.tools.includes(echo) && !start.tools.includes(counter), `Pi declines the unnamed direct MCP tools: ${describe(start)}`);
  const dump = await fixture.probeDump();
  assert.ok(!dump.activeTools?.includes(echo), "Pi's own active set excludes the declined tool");

  const refused = await search(fixture, echo);
  assert.deepEqual(refused.refused, [echo]);
  assert.deepEqual(refused.alreadyActive, [], "a declined base name is never reported already active");
  assert.deepEqual(refused.activated, []);
  assert.equal(refused.isError, true);
  assert.deepEqual((await search(fixture, "WebFetch")).alreadyActive, ["WebFetch"], "an actually active base tool reports already active");
  assert.equal(readFileSync(fixture.paths.mcpConfig, "utf8"), mcpConfigBefore, "the gate never writes native MCP configuration");
});
