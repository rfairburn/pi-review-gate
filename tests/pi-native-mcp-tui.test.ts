import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SERVER_NAME,
  REGISTERED_EXPOSURE_FOR_CODENAME_SERVER,
  ZERO_MODEL_GATE_CONFIG,
  describeFixturePrerequisites,
  mcpToolName,
} from "./pi-native-mcp-fixture";
import type { FixtureEvent, ProbeDump } from "./pi-native-mcp-fixture";
import { skipOrFail } from "./bridge-fakes";

const projectRoot = join(dirname(__dirname), "..");
const DRIVER_OVERALL_TIMEOUT_MS = 7 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

type DriverStep = { index: number; type?: string; ok: boolean; detail?: string; screen?: string; error?: string };
type DriverResult = {
  ok: boolean;
  alive: boolean;
  exitedNormally?: boolean;
  pid?: number;
  steps: DriverStep[];
  counters: Record<string, number>;
  lastScreen: string;
  error?: string;
};

type LifecycleAction =
  | { type: "dump"; name: string }
  | { type: "turn"; name: string; message: string; marker: string; script: { steps: unknown[] } }
  | { type: "manager_toggle"; server: string; desired: "enable" | "disable" }
  | { type: "command"; command: string; initializeCount: number; toolsListCount: number };

function hasPython3(): boolean {
  const result = spawnSync("python3", ["-c", "print(1)"], { stdio: "ignore", timeout: 5_000 });
  return !result.error && result.status === 0;
}

function fixtureGitEnvironment(home: string, tempDir: string, globalConfig: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: tempDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
  };
}

function resolveCompiler(): string | undefined {
  try {
    return createRequire(join(projectRoot, "package.json")).resolve("typescript/bin/tsc");
  } catch {
    return undefined;
  }
}

function compileCandidate(candidateRoot: string, compiler: string): string {
  const result = spawnSync(
    process.execPath,
    [compiler, "-p", join(projectRoot, "tsconfig.json"), "--outDir", join(candidateRoot, "dist"), "--pretty", "false"],
    { cwd: projectRoot, encoding: "utf8", timeout: 120_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `scratch candidate TypeScript build failed (status ${String(result.status)}):\n`
      + `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${String(result.error ?? "")}`,
    );
  }
  const entry = join(candidateRoot, "dist", "src", "index.js");
  assert.ok(existsSync(entry), `scratch compile did not produce ${entry}`);
  return entry;
}

async function createCandidatePackage(candidateRoot: string, compiler: string): Promise<string> {
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(join(candidateRoot, "package.json"), JSON.stringify({
    name: "pi-review-gate-native-mcp-tui-candidate",
    version: "0.0.0-test",
    type: "commonjs",
  }, null, 2) + "\n");
  await cp(join(projectRoot, "scripts"), join(candidateRoot, "scripts"), { recursive: true });
  const nodeModules = join(projectRoot, "node_modules");
  assert.ok(existsSync(nodeModules), "the repository node_modules directory is required to compile/run the candidate");
  await symlink(nodeModules, join(candidateRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return compileCandidate(candidateRoot, compiler);
}

function observerExtensionSource(): string {
  return String.raw`'use strict';
const fs = require('node:fs');
const target = process.env.PRG_FIXTURE_TOOL_OBSERVATIONS;
module.exports = (pi) => {
  const append = (hook, event) => {
    try {
      const seen = new WeakSet();
      const json = JSON.stringify({ hook, event }, (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[circular]';
          seen.add(value);
        }
        return value;
      });
      fs.appendFileSync(target, json + '\n', 'utf8');
    } catch (error) {
      fs.appendFileSync(target, JSON.stringify({ hook, captureError: String(error) }) + '\n', 'utf8');
    }
  };
  pi.on('tool_call', (event) => append('tool_call', event));
  pi.on('tool_result', (event) => append('tool_result', event));
};
module.exports.default = module.exports;
`;
}

function turnScript(
  query: string,
  code: string,
  marker: string,
  preludeQueries: string[] = [],
): { steps: unknown[] } {
  return {
    steps: [
      ...[...preludeQueries, query].map((item) => ({
        toolCalls: [{ toolName: "search_tools", arguments: { query: item } }],
      })),
      { codemode: code },
      { text: marker },
    ],
  };
}

function successfulCode(echoName: string, counterName: string, message: string, label: string): string {
  return `const echo = await tools.${echoName}({ message: ${JSON.stringify(message)} });\n`
    + `const counter = await tools.${counterName}({ label: ${JSON.stringify(label)} });\n`
    + "return JSON.stringify({ echo, counter });";
}

function disabledAttemptCode(echoName: string, message: string): string {
  return `const result = await tools.${echoName}({ message: ${JSON.stringify(message)} });\n`
    + "if (result?.isError !== true) throw new Error('disabled native MCP call unexpectedly returned success');\n"
    + "throw new Error('disabled native MCP callee was rejected');";
}

function parseJsonLines(path: string): FixtureEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureEvent);
}

function matchingTools(dump: ProbeDump, name: string): NonNullable<ProbeDump["allTools"]> {
  return (dump.allTools ?? []).filter((tool) => tool.name === name);
}

function eventToolName(record: FixtureEvent): string | undefined {
  const event = record.event;
  return typeof event === "object" && event !== null && !Array.isArray(event)
    && typeof (event as FixtureEvent).toolName === "string"
    ? (event as FixtureEvent).toolName as string
    : undefined;
}

function observationEvent(record: FixtureEvent): FixtureEvent {
  const event = record.event;
  return typeof event === "object" && event !== null && !Array.isArray(event) ? event as FixtureEvent : {};
}

function resultIsError(record: FixtureEvent): unknown {
  const event = observationEvent(record);
  const result = typeof event.result === "object" && event.result !== null ? event.result as FixtureEvent : {};
  return event.isError ?? result.isError;
}

function resultDetails(record: FixtureEvent): FixtureEvent | undefined {
  const event = observationEvent(record);
  const result = typeof event.result === "object" && event.result !== null ? event.result as FixtureEvent : {};
  const details = event.details ?? result.details;
  return typeof details === "object" && details !== null && !Array.isArray(details) ? details as FixtureEvent : undefined;
}

function toolCallInputText(record: FixtureEvent): string {
  const event = observationEvent(record);
  return JSON.stringify(event.input ?? event.arguments ?? {});
}

function resultContent(record: FixtureEvent): string {
  const event = observationEvent(record);
  const result = typeof event.result === "object" && event.result !== null ? event.result as FixtureEvent : {};
  const content = event.content ?? result.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) return [];
    const text = (block as FixtureEvent).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

function assertSearchAlreadyActive(record: FixtureEvent, name: string): void {
  assert.equal(resultIsError(record), false, "codemode discovery search must succeed");
  const details = resultDetails(record);
  const content = resultContent(record);
  if (Array.isArray(details?.matched)) assert.ok(details.matched.includes(name), "exact codemode search must match codemode");
  else assert.ok(content.includes(name) && content.includes("Matched authorized tools:"), "search result content must report codemode as matched");
  if (Array.isArray(details?.alreadyActive)) assert.ok(details.alreadyActive.includes(name), "deferred-tools-off must leave codemode active");
  else assert.ok(content.includes("already active"), "search result content must report codemode already active");
}

function assertSearchMatched(record: FixtureEvent, name: string, label: string): void {
  assert.equal(resultIsError(record), false, `${label} search_tools must succeed`);
  const details = resultDetails(record);
  const content = resultContent(record);
  if (Array.isArray(details?.matched)) {
    assert.ok(details.matched.includes(name), `${label} matched details must contain ${name}`);
  } else {
    assert.ok(content.includes(name) && content.includes("Matched authorized tools:"), `${label} result content must report a real match for ${name}`);
  }
  if (Array.isArray(details?.nativeAvailable)) {
    assert.ok(details.nativeAvailable.includes(name), `${label} nativeAvailable details must contain ${name}`);
    assert.ok(!Array.isArray(details.activated) || !details.activated.includes(name),
      `${label} search must not flatten native exposure by activating ${name}`);
    assert.ok(!Array.isArray(details.alreadyActive) || !details.alreadyActive.includes(name),
      `${label} native exposure must not be reported as a direct declaration for ${name}`);
  } else {
    assert.ok(content.includes("native tool_search") && content.includes("No direct declaration changed"),
      `${label} result content must preserve native availability for ${name}`);
  }
}

function assertSearchMissing(record: FixtureEvent, name: string): void {
  assert.equal(resultIsError(record), false, "disabled search_tools must complete without a tool error");
  const details = resultDetails(record);
  const content = resultContent(record);
  if (Array.isArray(details?.matched)) assert.deepEqual(details.matched, [], "disabled candidate search must have no matches");
  else assert.ok(content.includes("No authorized tools matched"), "disabled result content must report no authorized matches");
  if (Array.isArray(details?.nativeAvailable)) assert.deepEqual(details.nativeAvailable, [], "disabled nativeAvailable must be empty");
  else assert.ok(!content.includes(name), "disabled result content must omit the withdrawn tool name");
}

async function runDriver(
  driverPath: string,
  sandbox: string,
  resultPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<DriverResult> {
  return await new Promise<DriverResult>((resolve) => {
    const child = spawn("python3", [driverPath, sandbox, resultPath], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: environment,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-30_000);
    });
    let settled = false;
    let hardKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* driver already exited */ }
      hardKill = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* process group is gone */ }
      }, 4_000);
    }, DRIVER_OVERALL_TIMEOUT_MS);
    const finish = (fallback: DriverResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      try {
        const result = JSON.parse(readFileSync(resultPath, "utf8")) as DriverResult;
        if (stderr) result.error = `${result.error ?? ""}\npython driver stderr:\n${stderr}`;
        resolve(result);
      } catch {
        if (stderr) fallback.error = `${fallback.error ?? ""}\npython driver stderr:\n${stderr}`;
        resolve(fallback);
      }
    };
    child.once("error", (error) => finish({ ok: false, alive: false, steps: [], counters: {}, lastScreen: "", error: `python driver spawn failed: ${String(error)}` }));
    child.once("exit", (code, signal) => finish({
      ok: false,
      alive: false,
      steps: [],
      counters: {},
      lastScreen: "",
      error: `python driver exited without result.json (code ${String(code)}, signal ${String(signal)})`,
    }));
  });
}

test("native MCP disable/enable/reconnect are observed in one candidate Pi TUI session", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const prerequisites = describeFixturePrerequisites({ candidateEntry: null });
  if (!prerequisites.ok || !prerequisites.host) {
    skipOrFail(t, `native Pi 1.x TUI prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
    return;
  }
  const host = prerequisites.host;
  if (!hasPython3()) {
    skipOrFail(t, "native MCP TUI smoke prerequisite unavailable: python3");
    return;
  }
  const compiler = resolveCompiler();
  if (!compiler || !existsSync(join(projectRoot, "node_modules"))) {
    skipOrFail(t, "native MCP TUI scratch-build prerequisite unavailable: repository TypeScript/node_modules");
    return;
  }
  const driverPath = join(projectRoot, "tests", "fixtures", "pi-native-mcp-tui-driver.py");
  assert.ok(existsSync(driverPath), `dedicated PTY driver missing: ${driverPath}`);

  const sandbox = await mkdtemp(join(tmpdir(), "prg-native-mcp-tui-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const home = join(sandbox, "home");
  const agentDir = join(home, ".pi", "agent");
  const workspace = join(sandbox, "workspace");
  const stateDir = join(sandbox, "fixture-state");
  const candidateRoot = join(sandbox, "candidate-package");
  const candidateEntry = await createCandidatePackage(candidateRoot, compiler);
  const probeEntry = join(projectRoot, "tests", "fixtures", "pi-native-mcp-probe.cjs");
  const serverEntry = join(projectRoot, "tests", "fixtures", "pi-native-mcp-server.cjs");
  const observerEntry = join(sandbox, "observe-tool-results.cjs");
  const eventLog = join(stateDir, "event-log.jsonl");
  const counterFile = join(stateDir, "counter.txt");
  const generationFile = join(stateDir, "generation.json");
  const controlFile = join(stateDir, "control.json");
  const turnScriptPath = join(stateDir, "turn-script.json");
  const toolObservationPath = join(stateDir, "tool-observations.jsonl");
  const gitGlobalConfig = join(stateDir, "gitconfig");
  const gitTemplate = join(stateDir, "git-template");
  const gitTemplateHooks = join(gitTemplate, "hooks");
  const runTag = randomUUID().slice(0, 8);
  const echoName = mcpToolName(DEFAULT_SERVER_NAME, "echo");
  const counterName = mcpToolName(DEFAULT_SERVER_NAME, "counter");

  await mkdir(agentDir, { recursive: true });
  await mkdir(join(home, ".config"), { recursive: true });
  await mkdir(join(workspace, ".pi"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(gitTemplateHooks, { recursive: true });
  await writeFile(gitGlobalConfig, "");
  const fixtureGateConfig = {
    ...ZERO_MODEL_GATE_CONFIG,
    execution: { ...ZERO_MODEL_GATE_CONFIG.execution, deferredPiTools: false },
  };
  await writeFile(join(agentDir, "review-gate.json"), `${JSON.stringify(fixtureGateConfig, null, 2)}\n`);
  await writeFile(controlFile, '{"command":"none"}\n');
  await writeFile(generationFile, '{"generation":1}\n');
  await writeFile(counterFile, "0\n");
  await writeFile(turnScriptPath, '{"steps":[]}\n');
  await writeFile(observerEntry, observerExtensionSource());
  // The synthetic primary-mode config has no active reviewers. The candidate's
  // own deferred-tool layer is off, while Pi's native MCP exposure remains
  // authoritative; the real registry and search results below assert that the
  // wrapper does not directly activate or flatten those native tools. This
  // does not test reviewer decisions.
  await writeFile(join(workspace, ".pi", "mcp.json"), `${JSON.stringify({
    mcpServers: {
      [DEFAULT_SERVER_NAME]: {
        command: process.execPath,
        args: [serverEntry],
        description: "Credential-free native MCP lifecycle fixture for the real Pi TUI.",
        timeout: 30,
        env: {
          PRG_FIXTURE_EVENT_LOG: eventLog,
          PRG_FIXTURE_CONTROL_FILE: controlFile,
          PRG_FIXTURE_GENERATION_FILE: generationFile,
          PRG_FIXTURE_COUNTER_FILE: counterFile,
        },
      },
    },
  }, null, 2)}\n`);

  // A private synthetic Git repository gives the candidate a normal trusted
  // workspace without reading or modifying the user's repository.
  const gitInit = spawnSync("git", ["init", "--quiet", `--template=${gitTemplate}`], {
    cwd: workspace,
    env: fixtureGitEnvironment(home, sandbox, gitGlobalConfig),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(gitInit.status, 0, `could not initialize isolated fixture project: ${gitInit.stderr ?? gitInit.error ?? "unknown error"}`);

  const phases = {
    initial: {
      message: `native-mcp-ui-initial-${runTag}`,
      echo: `native-mcp-ui-initial-echo-${runTag}`,
      counter: `native-mcp-ui-initial-counter-${runTag}`,
    },
    disabled: {
      message: `native-mcp-ui-disabled-${runTag}`,
    },
    enabled: {
      message: `native-mcp-ui-enabled-${runTag}`,
      echo: `native-mcp-ui-enabled-echo-${runTag}`,
      counter: `native-mcp-ui-enabled-counter-${runTag}`,
    },
    reconnected: {
      message: `native-mcp-ui-reconnected-${runTag}`,
      echo: `native-mcp-ui-reconnected-echo-${runTag}`,
      counter: `native-mcp-ui-reconnected-counter-${runTag}`,
    },
  };
  const actions: LifecycleAction[] = [
    { type: "dump", name: "initial" },
    {
      type: "turn",
      name: "initial",
      message: `native-mcp-ui-turn-initial-${runTag}`,
      marker: `NATIVE_MCP_UI_INITIAL_DONE_${runTag}`,
      script: turnScript(
        `${echoName} ${counterName}`,
        successfulCode(echoName, counterName, phases.initial.echo, phases.initial.counter),
        `NATIVE_MCP_UI_INITIAL_DONE_${runTag}`,
        ["codemode"],
      ),
    },
    { type: "manager_toggle", server: DEFAULT_SERVER_NAME, desired: "disable" },
    { type: "dump", name: "disabled" },
    {
      type: "turn",
      name: "disabled",
      message: `native-mcp-ui-turn-disabled-${runTag}`,
      marker: `NATIVE_MCP_UI_DISABLED_DONE_${runTag}`,
      script: turnScript(
        echoName,
        disabledAttemptCode(echoName, phases.disabled.message),
        `NATIVE_MCP_UI_DISABLED_DONE_${runTag}`,
      ),
    },
    { type: "manager_toggle", server: DEFAULT_SERVER_NAME, desired: "enable" },
    { type: "dump", name: "enabled" },
    {
      type: "turn",
      name: "enabled",
      message: `native-mcp-ui-turn-enabled-${runTag}`,
      marker: `NATIVE_MCP_UI_ENABLED_DONE_${runTag}`,
      script: turnScript(
        `${counterName} ${echoName}`,
        successfulCode(echoName, counterName, phases.enabled.echo, phases.enabled.counter),
        `NATIVE_MCP_UI_ENABLED_DONE_${runTag}`,
      ),
    },
    {
      type: "command",
      command: `/mcp reconnect ${DEFAULT_SERVER_NAME}`,
      initializeCount: 3,
      toolsListCount: 3,
    },
    { type: "dump", name: "reconnected" },
    {
      type: "turn",
      name: "reconnected",
      message: `native-mcp-ui-turn-reconnected-${runTag}`,
      marker: `NATIVE_MCP_UI_RECONNECTED_DONE_${runTag}`,
      script: turnScript(
        counterName,
        successfulCode(echoName, counterName, phases.reconnected.echo, phases.reconnected.counter),
        `NATIVE_MCP_UI_RECONNECTED_DONE_${runTag}`,
      ),
    },
  ];
  await writeFile(join(sandbox, "lifecycle.json"), JSON.stringify(actions, null, 2));

  const resultPath = join(sandbox, "driver-result.json");
  const driver = await runDriver(driverPath, sandbox, resultPath, {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TMPDIR: sandbox,
    NODE_BIN: process.execPath,
    PRG_PI_CLI: host.cliEntry,
    PRG_CANDIDATE: candidateEntry,
    PRG_PROBE: probeEntry,
    PRG_OBSERVER: observerEntry,
    PRG_PROJECT: workspace,
    PRG_HOME: home,
    PRG_AGENT_DIR: agentDir,
    PRG_HOST_AGENT_DIR: host.agentDir,
    PRG_FIXTURE_STATE_DIR: stateDir,
    PRG_FIXTURE_TOOL_OBSERVATIONS: toolObservationPath,
  });
  const failures = driver.steps.filter((step) => !step.ok);
  assert.ok(
    driver.ok,
    `native MCP TUI lifecycle failed${driver.error ? `: ${driver.error}` : ""}\n`
      + `${failures.map((step) => `step ${step.index} (${step.type ?? "?"}): ${step.error ?? step.detail ?? "failed"}\n${step.screen ?? ""}`).join("\n---\n")}`
      + `\nlast screen:\n${driver.lastScreen}`,
  );
  assert.equal(driver.alive, false, "PTY cleanup must leave no live Pi TUI process");
  assert.equal(driver.exitedNormally, true, "the real Pi TUI must exit on the scripted Ctrl+C-twice shutdown, not merely be killed by cleanup");

  const snapshots = new Map<string, ProbeDump>();
  for (const name of ["initial", "disabled", "enabled", "reconnected"]) {
    const path = join(stateDir, `snapshot-${name}.json`);
    snapshots.set(name, JSON.parse(await readFile(path, "utf8")) as ProbeDump);
  }
  const initial = snapshots.get("initial")!;
  const disabled = snapshots.get("disabled")!;
  const enabled = snapshots.get("enabled")!;
  const reconnected = snapshots.get("reconnected")!;
  assert.ok(matchingTools(initial, echoName).some((tool) => tool.exposure === REGISTERED_EXPOSURE_FOR_CODENAME_SERVER),
    "initial probe snapshot must observe the enabled server's actual native tool registration");
  assert.ok(matchingTools(initial, counterName).some((tool) => tool.exposure === REGISTERED_EXPOSURE_FOR_CODENAME_SERVER),
    "initial counter registration must retain Pi's actual native MCP exposure");
  assert.ok(!disabled.activeTools?.includes(echoName), "disabled snapshot must not show the server tool active");
  assert.ok(!disabled.activeTools?.includes(counterName), "disabled snapshot must not show the counter active");
  assert.ok(
    matchingTools(disabled, echoName).length === 0 || matchingTools(disabled, echoName).every((tool) => tool.exposure === "hidden"),
    "disabled native tools must be absent or hidden in Pi's live registry snapshot",
  );
  assert.ok(matchingTools(enabled, echoName).some((tool) => tool.exposure === REGISTERED_EXPOSURE_FOR_CODENAME_SERVER),
    "re-enabled probe snapshot must observe the server's restored native tool registration");
  assert.ok(matchingTools(reconnected, counterName).some((tool) => tool.exposure === REGISTERED_EXPOSURE_FOR_CODENAME_SERVER),
    "post-reconnect counter registration must retain Pi's actual native MCP exposure");

  const serverEvents = parseJsonLines(eventLog);
  const protocolCalls = serverEvents.filter((event) => event.event === "tool_call");
  const expectedCalls = [
    ["echo", { message: phases.initial.echo }],
    ["counter", { label: phases.initial.counter }],
    ["echo", { message: phases.enabled.echo }],
    ["counter", { label: phases.enabled.counter }],
    ["echo", { message: phases.reconnected.echo }],
    ["counter", { label: phases.reconnected.counter }],
  ];
  assert.deepEqual(
    protocolCalls.map((event) => [event.tool, event.arguments]),
    expectedCalls,
    "only enabled/re-enabled/reconnected real tools/call requests may reach the MCP server; disabled attempts must have no protocol effect",
  );
  assert.deepEqual(
    serverEvents.filter((event) => event.event === "tool_result").map((event) => [event.tool, event.count, event.messageChars]),
    [
      ["echo", undefined, phases.initial.echo.length], ["counter", 1, undefined],
      ["echo", undefined, phases.enabled.echo.length], ["counter", 2, undefined],
      ["echo", undefined, phases.reconnected.echo.length], ["counter", 3, undefined],
    ],
    "fixture protocol results must pair with the expected distinct echo inputs and counter effects",
  );
  assert.equal(Number.parseInt((await readFile(counterFile, "utf8")).trim(), 10), 3,
    "the real server counter must preserve state across disable/enable and reconnect");
  assert.deepEqual(driver.counters, { initial: 1, disabled: 1, enabled: 2, reconnected: 3 },
    "the TUI-side checkpoints must observe no disabled counter effect and continuity through reconnect");
  assert.equal(serverEvents.filter((event) => event.event === "initialize").length, 3,
    "initial connection, UI enable, and same-session native reconnect must each initialize the real server");

  const observations = parseJsonLines(toolObservationPath);
  const searchResults = observations.filter((record) => record.hook === "tool_result" && eventToolName(record) === "search_tools");
  assert.equal(searchResults.length, 5, "search_tools must return codemode state plus one lifecycle discovery result per phase");
  assertSearchAlreadyActive(searchResults[0]!, "codemode");
  assertSearchMatched(searchResults[1]!, echoName, "initial");
  assertSearchMatched(searchResults[1]!, counterName, "initial");
  assertSearchMissing(searchResults[2]!, echoName);
  assertSearchMatched(searchResults[3]!, echoName, "re-enabled");
  assertSearchMatched(searchResults[4]!, counterName, "post-reconnect");

  const codemodeCalls = observations.filter((record) => record.hook === "tool_call" && eventToolName(record) === "codemode");
  const codemodeResults = observations.filter((record) => record.hook === "tool_result" && eventToolName(record) === "codemode");
  assert.equal(codemodeCalls.length, 4, "the candidate-backed native codemode call must run in each lifecycle phase");
  assert.equal(codemodeResults.length, 4, "Pi must report a real codemode result for the disabled attempt and each permitted phase");
  assert.ok(toolCallInputText(codemodeCalls[1]!).includes(phases.disabled.message),
    "the observed disabled codemode call must carry its distinct attempted echo arguments");
  for (const index of [0, 2, 3]) {
    assert.equal(resultIsError(codemodeResults[index]!), false,
      `permitted codemode phase ${index} must return a successful Pi tool result`);
  }
  assert.equal(resultIsError(codemodeResults[1]!), true,
    `the disabled native callee must fail inside the active codemode call; observed content: ${resultContent(codemodeResults[1]!)}`);
  assert.ok(driver.pid && driver.pid > 0, "PTY driver must report the single TUI process it kept through all manager operations");
});
