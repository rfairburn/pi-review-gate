/**
 * Issue #434 focused integration: the SHIPPED manual tool-denial sandbox path,
 * driven headlessly against the REAL installed Pi.
 *
 * Where the existing suites stop: `tests/primary-tool-denial-host.test.ts`
 * proves a real Pi primary host's top-level denial, and the unit suites prove the
 * catalog/admission filter against real code. Neither drives the shipped
 * `scripts/pi-review-gate-tool-denial-sandbox.cjs` helper and its deterministic
 * `scripts/pi-review-gate-tool-denial-probe.cjs` fixture, and neither reaches a NEW
 * real review-gate executor child admitted through the production path.
 *
 * This suite does exactly that, with no provider call, credential, or network:
 *
 * 1. `scripts/pi-review-gate-tool-denial-sandbox.cjs --json` stages a disposable
 *    isolated sandbox (own HOME/agent/TMPDIR/caches/config/synthetic workspace,
 *    credential-free faux provider, synthetic `SyntheticNotify` deferred tool).
 *    The suite launches the REAL installed `pi` from the printed summary in
 *    `--mode rpc`. The pinned install directory is prepended to `PATH` for the
 *    staged environment, so the primary's explicit binary AND the bare `pi` the
 *    production `PiExecutorAdapter` launches for the child resolve to the same
 *    installed runtime.
 * 2. The shipped probe's scripted turn script makes a session search for then
 *    call `SyntheticNotify`; `/subtask-add` is the human admission path that makes
 *    the gate admit a NEW real Pi executor child, which auto-discovers the probe
 *    (and the test-owned `tests/fixtures/prg-tool-denial-observer.cjs`) from the
 *    sandbox agent's `extensions/` directory and follows the same turn script.
 *    The probe appends one JSONL line per EXECUTED `SyntheticNotify` call; the
 *    observer appends one line per Pi tool event from inside the actual child
 *    process. Each scenario therefore requires an explicit child-side
 *    `tool_end` for the attempted `SyntheticNotify` AND an `agent_settled`
 *    boundary before effects are judged — a child that stalls, crashes, or never
 *    attempts the tool fails the wait instead of passing as a denial.
 * 3. The four-way primary/executor independence matrix is driven purely by the
 *    production `tools.topLevelDeny` / `tools.executorDeny` settings file — the
 *    exact file the production menu Save persists.
 * 4. The production `/review-settings` -> Tools -> Executor tools selectors are
 *    driven over the real RPC selector fallback: a Cancel exchange must discard
 *    the staged denial, a Save exchange must persist it, and a NEW executor
 *    admitted in that SAME primary session must inherit the changed ceiling
 *    (denied attempt, no effect) while the primary stays allowed. The shipped
 *    helper's printed command scopes the deterministic model through the
 *    supported `--models` CLI option, which is what lets the real settings
 *    validation accept the route; the harness runs that argv unchanged.
 *
 * Boundaries (documented, not faked): the actual TUI is not driven here; the
 * `/review-settings` menu is exercised through its real plain-selector RPC
 * fallback, not a physical PTY. The residual Pi-native callable metadata
 * visibility (ctx.tools / codemode) is accepted scope and is not asserted here.
 * Genuine launch/mode/role ceilings and the research/reviewer roles are
 * unchanged and out of scope.
 *
 * The running-child retention boundary is covered by the final scenario: a REAL
 * executor child is admitted with an empty deny list and parked at a test-only
 * deferred hold tool, then the production menu Save applies the executor-only
 * denial while that child is still live. After release the same child executes
 * `SyntheticNotify` (its captured permission is unchanged), a NEW child admitted
 * after the apply is explicitly denied with no synthetic effect, and the primary
 * stays allowed. The hold fixture is loaded explicitly by the primary as well,
 * so the hold tool is genuinely part of the captured parent authorization rather
 * than a child-only capability. The shipped `--models` scope in the helper's
 * printed command is what makes the real settings Save path accept the sandbox's
 * Pi worker route; the harness runs that argv unchanged.
 *
 * Requirements (CI exports them; locally they resolve): an installed Pi 1.x
 * (`PI_REVIEW_GATE_INSTALLED_AGENT`) with its `@earendil-works/pi-ai` faux
 * provider dependency, its executable (`PI_REVIEW_GATE_INSTALLED_PI_BIN` or the
 * agent `bin/`), the compiled candidate (`PI_REVIEW_GATE_CANDIDATE_ENTRY` or
 * `<root>/dist/src/index.js`), and the shipped scripts from this checkout. A
 * missing prerequisite skips locally and hard-fails under
 * `PI_REVIEW_GATE_REQUIRE_PI_HOST=1`.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import test, { type TestContext } from "node:test";
import { skipOrFail } from "./bridge-fakes";
import { findInstalledAgentDir } from "./menu-tui-fakes";

const projectRoot = resolvePath(__dirname, "..", "..");
const helperPath = join(projectRoot, "scripts", "pi-review-gate-tool-denial-sandbox.cjs");
const TOOL = "SyntheticNotify";

const TIMEOUTS = {
  requestMs: 30_000,
  settleMs: 90_000,
  executorMs: 60_000,
  controlMs: 20_000,
  testMs: 420_000,
  liveChildMs: 480_000,
  terminateMs: 5_000,
} as const;

interface SandboxSummary {
  sandbox: string;
  candidate: string;
  extension: string;
  cwd: string;
  model: string;
  deterministic: boolean;
  piBinary: string;
  installedAgent: string | null;
  env: Record<string, string>;
  piArgs: string[];
}

interface CallRecord {
  event?: string;
  role?: string;
  caller?: string;
  tool?: string;
  message?: string;
  [key: string]: unknown;
}

interface ObservedEvent {
  event?: string;
  role?: string;
  pid?: number;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  resultText?: string;
  [key: string]: unknown;
}

interface HoldRecord {
  event?: string;
  role?: string;
  pid?: number;
  waitedMs?: number;
  [key: string]: unknown;
}

interface RpcEvent {
  type?: string;
  id?: string;
  command?: string;
  method?: string;
  title?: string;
  options?: unknown;
  message?: string;
  toolName?: string;
  isError?: boolean;
  success?: boolean;
  data?: unknown;
  [key: string]: unknown;
}

interface HostResolution {
  candidate: string;
  agentDir: string;
  piBinary: string;
}

/** First option whose label starts with the prefix (the plain-selector fallback labels rows). */
function pick(options: readonly string[], prefix: string): string | undefined {
  return options.find((option) => option.startsWith(prefix));
}

function optionStrings(event: RpcEvent): string[] {
  return Array.isArray(event.options)
    ? event.options.filter((option): option is string => typeof option === "string")
    : [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

/**
 * Resolve and validate the candidate build. The production executor adapter
 * launches its child with the entry adjacent to the adapter (`../../index.js`),
 * so the candidate must be a complete build tree — never just a single file.
 */
function resolveCandidate(): string | undefined {
  const fromEnv = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
  const candidate = fromEnv ? resolvePath(fromEnv) : join(projectRoot, "dist", "src", "index.js");
  if (!existsSync(candidate)) return undefined;
  if (!existsSync(join(dirname(candidate), "execution", "adapters", "pi-model.js"))) return undefined;
  return candidate;
}

/** Resolve the installed pi executable (PI_REVIEW_GATE_INSTALLED_PI_BIN is a directory), or undefined. */
function resolvePiBinary(agentDir: string | undefined): string | undefined {
  const explicit = process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN;
  const candidates: string[] = [];
  if (explicit) for (const name of ["pi", "pi.cmd"]) candidates.push(join(explicit, name));
  if (agentDir) for (const name of ["pi", "pi.cmd"]) candidates.push(join(agentDir, "bin", name));
  for (const name of ["pi", "pi.cmd"]) candidates.push(join(homedir(), ".pi", "agent", "bin", name));
  return candidates.find((candidate) => existsSync(candidate));
}

/** The shipped probe resolves its faux provider from the installed agent's pi-ai dependency. */
function installedAgentHasPiAi(agentDir: string): boolean {
  return [
    join(agentDir, "..", "pi-ai", "dist", "index.js"),
    join(agentDir, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
  ].some((candidate) => existsSync(candidate));
}

/** Full prerequisite description: the suite skips locally and hard-fails under the required-host gate. */
function describeHost(): { ok: boolean; problems: string[]; host?: HostResolution } {
  const problems: string[] = [];
  const candidate = resolveCandidate();
  if (!candidate) {
    problems.push("compiled candidate missing (PI_REVIEW_GATE_CANDIDATE_ENTRY or <root>/dist/src/index.js with src/execution/adapters/pi-model.js)");
  }
  const agentDir = findInstalledAgentDir();
  if (!agentDir) problems.push("no installed Pi (@earendil-works/pi-coding-agent) found");
  else if (!installedAgentHasPiAi(agentDir)) problems.push(`installed Pi at ${agentDir} has no resolvable @earendil-works/pi-ai faux provider`);
  const piBinary = resolvePiBinary(agentDir);
  if (!piBinary) problems.push("no installed pi executable (PI_REVIEW_GATE_INSTALLED_PI_BIN or the agent bin/)");
  if (problems.length > 0 || !candidate || !agentDir || !piBinary) return { ok: false, problems };
  return { ok: true, problems: [], host: { candidate, agentDir, piBinary } };
}

/**
 * Stage the shipped sandbox with plain `node`; the helper builds and launches
 * nothing. The pinned executable directory is prepended to PATH so the staged
 * environment (which the child inherits) resolves bare `pi` to the same install.
 * The helper's own printed argv must already scope the worker route's model; the
 * harness runs exactly that argv and adds no duplicate `--models` of its own.
 */
interface StageOptions {
  /**
   * Install the test-only hold fixture and its role-aware child turn script.
   * Only the live-child retention scenario needs it.
   */
  hold?: boolean;
}

function stageSandbox(t: TestContext, host: HostResolution, options: StageOptions = {}): SandboxSummary {
  if (!existsSync(helperPath)) {
    skipOrFail(t, "the shipped tool-denial sandbox helper is missing");
    throw new Error("unreachable after a required-host failure");
  }
  const pinnedDir = dirname(host.piBinary);
  const result = spawnSync(process.execPath, [helperPath, "--candidate", host.candidate, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PI_REVIEW_GATE_INSTALLED_AGENT: host.agentDir,
      PI_BIN: host.piBinary,
      PATH: process.env.PATH ? `${pinnedDir}${delimiter}${process.env.PATH}` : pinnedDir,
    },
  });
  assert.equal(result.status, 0, `sandbox helper failed:\n${result.stderr}`);
  const summary = JSON.parse(String(result.stdout)) as SandboxSummary;
  // The production settings Save validates a Pi worker route against the
  // currently scoped models (`Pi executor model is not currently scoped`), so
  // the shipped helper's printed argv must scope the sandbox model. The harness
  // relies on that argv unchanged instead of appending its own `--models`.
  const modelsIndex = summary.piArgs.indexOf("--models");
  assert.ok(modelsIndex >= 0, `the shipped helper launch command must scope the worker model: ${JSON.stringify(summary.piArgs)}`);
  assert.equal(summary.piArgs[modelsIndex + 1], summary.model, "the shipped helper must scope exactly the sandbox model");
  const modelIndex = summary.piArgs.indexOf("--model");
  if (modelIndex >= 0) {
    assert.equal(summary.piArgs[modelIndex + 1], summary.model, "an explicit model selection must match the scoped model");
  }
  // Install the test-owned child observer beside the probe: only the executor
  // child (which is launched WITHOUT --no-extensions) auto-discovers it.
  const observerSource = fixtureSource("prg-tool-denial-observer.cjs");
  assert.ok(existsSync(observerSource), `observer fixture missing: ${observerSource}`);
  writeFileSync(join(summary.sandbox, "agent", "extensions", "prg-tool-denial-observer.js"), readFileSync(observerSource));
  summary.env.PRG_TOOL_DENIAL_OBSERVER_LOG = join(summary.sandbox, "state", "observer.jsonl");
  if (options.hold) {
    const holdSource = fixtureSource("prg-tool-denial-hold.cjs");
    assert.ok(existsSync(holdSource), `hold fixture missing: ${holdSource}`);
    const holdInstall = join(summary.sandbox, "agent", "extensions", "prg-tool-denial-hold.js");
    writeFileSync(holdInstall, readFileSync(holdSource));
    // The primary explicitly loads the SAME fixture, so the hold tool is part
    // of the captured parent authorization the child inherits — never a
    // child-only tool smuggled past admission.
    summary.piArgs.push("--extension", holdInstall);
    summary.env.PRG_TOOL_DENIAL_HOLD_LOG = join(summary.sandbox, "state", "hold.jsonl");
    summary.env.PRG_TOOL_DENIAL_HOLD_SENTINEL = join(summary.sandbox, "state", "hold-release");
    summary.env.PRG_TOOL_DENIAL_CHILD_STATE_DIR = join(summary.sandbox, "state", "child-turn");
    mkdirSync(join(summary.sandbox, "state", "child-turn"), { recursive: true });
    writeChildHoldTurnScript(summary.sandbox);
  }
  t.after(() => cleanupSandbox(summary.sandbox));
  return summary;
}

/** Resolve a test-only fixture from the source tree (compiled or source root). */
function fixtureSource(name: string): string {
  const compiledRoot = resolvePath(__dirname, "..", "..");
  const sourceRoot = resolvePath(__dirname, "..");
  for (const root of [compiledRoot, sourceRoot]) {
    const candidate = join(root, "tests", "fixtures", name);
    if (existsSync(candidate)) return candidate;
  }
  return join(sourceRoot, "tests", "fixtures", name);
}

/** Read the sandbox's gate config, override the two deny lists, and write it back. */
function writeGateConfig(sandbox: string, lists: { topLevelDeny?: string[]; executorDeny?: string[] }): void {
  const path = join(sandbox, "agent", "review-gate.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as { tools?: Record<string, unknown> };
  config.tools = { ...(config.tools ?? {}), topLevelDeny: lists.topLevelDeny ?? [], executorDeny: lists.executorDeny ?? [] };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** The deterministic turn script: search for the probe, call it, then stop. */
function writeProbeTurnScript(sandbox: string): void {
  writeFileSync(join(sandbox, "state", "turn-script.json"), `${JSON.stringify({
    steps: [
      { toolCalls: [{ toolName: "tool_search", arguments: { query: TOOL } }] },
      { toolCalls: [{ toolName: TOOL, arguments: { message: "sandbox-probe" } }] },
      { text: "probe script complete" },
    ],
  }, null, 2)}\n`, "utf8");
}

function logPath(sandbox: string): string {
  return join(sandbox, "state", "synthetic-calls.jsonl");
}

function observerLogPath(sandbox: string): string {
  return join(sandbox, "state", "observer.jsonl");
}

/** Reset both the effect log and the child-observation log before a scenario. */
function resetLogs(sandbox: string): void {
  writeFileSync(logPath(sandbox), "", "utf8");
  rmSync(observerLogPath(sandbox), { force: true });
}

function readCalls(sandbox: string): CallRecord[] {
  try {
    return readFileSync(logPath(sandbox), "utf8").split("\n")
      .map((line) => line.trim()).filter(Boolean)
      .map((line) => JSON.parse(line) as CallRecord);
  } catch {
    return [];
  }
}

function readObserved(sandbox: string): ObservedEvent[] {
  try {
    return readFileSync(observerLogPath(sandbox), "utf8").split("\n")
      .map((line) => line.trim()).filter(Boolean)
      .map((line) => JSON.parse(line) as ObservedEvent);
  } catch {
    return [];
  }
}

const HOLD_TOOL = "PrgToolDenialHold";

function holdLogPath(sandbox: string): string {
  return join(sandbox, "state", "hold.jsonl");
}

function holdSentinelPath(sandbox: string): string {
  return join(sandbox, "state", "hold-release");
}

/**
 * The executor's own turn script, kept apart from the primary's main script by
 * the test-only hold fixture: search for and enter the hold, then attempt the
 * probe tool, then stop. The same script serves both the pre-apply child and the
 * post-apply child, so the only variable between them is the admission-time
 * denial.
 */
function writeChildHoldTurnScript(sandbox: string): void {
  writeFileSync(join(sandbox, "state", "child-turn", "turn-script.json"), `${JSON.stringify({
    steps: [
      { toolCalls: [{ toolName: "tool_search", arguments: { query: HOLD_TOOL } }] },
      { toolCalls: [{ toolName: HOLD_TOOL, arguments: {} }] },
      { toolCalls: [{ toolName: "tool_search", arguments: { query: TOOL } }] },
      { toolCalls: [{ toolName: TOOL, arguments: { message: "live-child-probe" } }] },
      { text: "live child probe complete" },
    ],
  }, null, 2)}\n`, "utf8");
}

function readHold(sandbox: string): HoldRecord[] {
  try {
    return readFileSync(holdLogPath(sandbox), "utf8").split("\n")
      .map((line) => line.trim()).filter(Boolean)
      .map((line) => JSON.parse(line) as HoldRecord);
  } catch {
    return [];
  }
}

/** Reset the effect log, the observer log, the hold log, and the released sentinel. */
function resetLiveChildLogs(sandbox: string): void {
  resetLogs(sandbox);
  writeFileSync(holdLogPath(sandbox), "", "utf8");
  rmSync(holdSentinelPath(sandbox), { force: true });
}

/**
 * Wait for a REAL executor child process to enter the hold. Returns its pid, so
 * the caller can assert against that exact process instead of inferring from an
 * absence of effects.
 */
async function waitForHoldEntered(sandbox: string, timeoutMs: number, excludePid?: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const held = readHold(sandbox).find((record) => record.event === "hold_entered"
      && record.role === "executor"
      && typeof record.pid === "number"
      && record.pid !== excludePid);
    if (held && typeof held.pid === "number") return held.pid;
    if (Date.now() >= deadline) {
      throw new Error(`no executor child reached the hold within ${timeoutMs}ms; hold observations: ${JSON.stringify(readHold(sandbox))}`);
    }
    await delay(100);
  }
}

/** Wait for one specific child pid to explicitly attempt the probe and settle. */
async function waitForChildByPid(sandbox: string, pid: number, timeoutMs: number): Promise<ObservedEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = readObserved(sandbox).filter((event) => event.pid === pid);
    const settled = events.some((event) => event.event === "settled");
    const attempted = events.some((event) => event.event === "tool_end" && event.toolName === TOOL);
    if (settled && attempted) return events;
    if (settled && !attempted) {
      throw new Error(`executor child ${pid} settled without attempting ${TOOL}; observed ${JSON.stringify(events)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`executor child ${pid} never reached a settled attempt boundary within ${timeoutMs}ms; observed ${JSON.stringify(events)}`);
    }
    await delay(100);
  }
}

/**
 * Wait for the admitted child to reach an explicit settled boundary AND to have
 * attempted the probe tool. A child that settles without attempting, or never
 * settles, fails here instead of passing as a denial.
 */
async function waitForExecutorObservation(sandbox: string, timeoutMs: number): Promise<ObservedEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = readObserved(sandbox);
    const settled = events.some((event) => event.event === "settled");
    const attempted = events.some((event) => event.event === "tool_end" && event.toolName === TOOL);
    if (settled && attempted) return events;
    if (settled && !attempted) {
      throw new Error(`executor child settled without attempting ${TOOL}; observed ${JSON.stringify(events)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`executor child never reached a settled attempt boundary within ${timeoutMs}ms; observed ${JSON.stringify(events)}`);
    }
    await delay(100);
  }
}

/** List pids whose command line contains this test-owned sandbox path (POSIX pgrep). */
function listOwnedPids(sandbox: string): number[] {
  const result = spawnSync("pgrep", ["-f", sandbox], { encoding: "utf8" });
  // Fail closed: only status 0 (matches) and 1 (no matches) prove discovery
  // ran. Any other status, a signal, or a spawn error leaves settlement
  // unknown and must not be treated as an empty, settled process set.
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`cannot confirm owned-process settlement; retaining ${sandbox}: ${String(result.error ?? result.stderr ?? result.status)}`);
  }
  if (result.status === 1) return [];
  return String(result.stdout ?? "").split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the process is gone; any other failure (for example a
    // permission or inspection error) leaves liveness unknown and must fail closed.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPidsGone(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pids.every((pid) => !processAlive(pid))) return true;
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
}

/**
 * Bounded, positively-owned process settlement: graceful TERM, bounded wait,
 * then KILL, bounded wait, then confirm. Returns the still-live owned pids.
 */
async function settleOwnedProcesses(sandbox: string): Promise<number[]> {
  const signal = (sig: NodeJS.Signals): void => {
    for (const pid of listOwnedPids(sandbox)) {
      try {
        process.kill(pid, sig);
      } catch {
        // Already gone.
      }
    }
  };
  signal("SIGTERM");
  if (await waitForPidsGone(listOwnedPids(sandbox), TIMEOUTS.terminateMs)) return [];
  signal("SIGKILL");
  if (await waitForPidsGone(listOwnedPids(sandbox), TIMEOUTS.terminateMs)) return [];
  return listOwnedPids(sandbox);
}

/**
 * Remove only the sandbox this test created, after confirming its owned
 * processes exited. Unconfirmed settlement retains the fixture and reports.
 */
async function cleanupSandbox(sandbox: string): Promise<void> {
  if (!sandbox || !existsSync(sandbox)) return;
  const remaining = await settleOwnedProcesses(sandbox);
  if (remaining.length > 0) {
    process.stderr.write(`prg-tool-denial-integration: owned sandbox processes did not exit (${remaining.join(", ")}); retaining ${sandbox} for inspection\n`);
    throw new Error(`owned sandbox processes did not exit: ${remaining.join(", ")}`);
  }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** One real `pi --mode rpc` process under the staged sandbox environment. */
class SandboxSession {
  readonly events: RpcEvent[] = [];
  private buffer = "";
  private nextId = 1;
  private stderrTail = "";
  private launchError: Error | undefined;
  private readonly pending = new Map<string, { resolve: (event: RpcEvent) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private uiResponder: ((request: RpcEvent) => { value: string } | undefined) | undefined;

  private constructor(readonly sandbox: string, private readonly proc: ChildProcess) {
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        this.handleLine(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
      }
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => { this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_000); });
    proc.on("error", (error) => {
      this.launchError = error instanceof Error ? error : new Error(String(error));
      this.rejectPending(this.launchError);
    });
    proc.on("close", () => {
      if (!this.launchError) this.launchError = new Error("pi sandbox process closed before the exchange completed");
      this.rejectPending(this.launchError);
    });
  }

  static launch(summary: SandboxSummary): SandboxSession {
    // The shipped helper already scopes the model in its printed launch command
    // (`--models`), so the harness runs exactly that argv with no separate append.
    const args = [summary.piBinary, ...summary.piArgs, "--mode", "rpc"];
    const proc = spawn(args[0]!, args.slice(1), {
      cwd: summary.cwd,
      env: summary.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new SandboxSession(summary.sandbox, proc);
  }

  setUiResponder(responder: ((request: RpcEvent) => { value: string } | undefined) | undefined): void {
    this.uiResponder = responder;
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let event: RpcEvent;
    try {
      event = JSON.parse(line) as RpcEvent;
    } catch {
      return;
    }
    this.events.push(event);
    if (event.type === "extension_ui_request" && event.method === "select" && this.uiResponder) {
      let answer: { value: string } | undefined;
      try {
        answer = this.uiResponder(event);
      } catch {
        answer = undefined;
      }
      if (answer) {
        try {
          this.proc.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, value: answer.value })}\n`);
        } catch {
          // Dead child; pending requests fail on close.
        }
      }
      return;
    }
    if (event.type === "response" && typeof event.id === "string") {
      const entry = this.pending.get(event.id);
      if (!entry) return;
      this.pending.delete(event.id);
      clearTimeout(entry.timer);
      if (event.success === false) entry.reject(new Error(`RPC ${String(event.command)} rejected: ${JSON.stringify(event.data ?? {})}`));
      else entry.resolve(event);
    }
  }

  private request(type: string, fields: Record<string, unknown>): Promise<RpcEvent> {
    const id = `prg-sandbox-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      if (this.launchError) {
        reject(this.launchError);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${type} timed out\nstderr:\n${this.stderrTail}`));
      }, TIMEOUTS.requestMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (!this.proc.stdin?.writable) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("pi RPC stdin is not writable"));
        return;
      }
      try {
        this.proc.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Wait for the session to be live and its scripted provider selectable. */
  async ready(): Promise<void> {
    const deadline = Date.now() + TIMEOUTS.requestMs;
    for (;;) {
      try {
        await this.request("get_state", {});
        return;
      } catch (error) {
        if (this.launchError) throw new Error(`sandbox pi failed to launch: ${this.launchError.message}\nstderr:\n${this.stderrTail}`);
        if (Date.now() >= deadline) throw new Error(`sandbox pi session never became ready: ${String(error)}\nstderr:\n${this.stderrTail}`);
        await delay(100);
      }
    }
  }

  async waitForEvent(predicate: (event: RpcEvent) => boolean, since: number, timeoutMs: number): Promise<RpcEvent | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let index = since; index < this.events.length; index += 1) {
        if (predicate(this.events[index]!)) return this.events[index];
      }
      if (Date.now() >= deadline) return undefined;
      await delay(50);
    }
  }

  /** Send an extension command (no agent run) and wait only for its RPC response. */
  async command(message: string): Promise<void> {
    await this.request("prompt", { message });
  }

  /** Send a prompt and wait for the scripted run to settle (the agent_settled boundary). */
  async prompt(message: string, timeoutMs = TIMEOUTS.settleMs): Promise<void> {
    const since = this.events.length;
    await this.request("prompt", { message });
    const settled = await this.waitForEvent((event) => event.type === "agent_settled", since, timeoutMs);
    if (!settled) throw new Error(`sandbox prompt ${JSON.stringify(message)} never settled\nstderr:\n${this.stderrTail}`);
  }

  /** Primary-side tool executions Pi actually reported for the probe tool. */
  probeExecutions(): { starts: number; endedError: boolean } {
    let starts = 0;
    let endedError = false;
    for (const event of this.events) {
      if (event.toolName !== TOOL) continue;
      if (event.type === "tool_execution_start") starts += 1;
      if (event.type === "tool_execution_end") endedError = endedError || event.isError === true;
    }
    return { starts, endedError };
  }

  /** Confirm owned-process settlement after this session; throws when unconfirmed. */
  async disposeAndSettle(): Promise<void> {
    this.rejectPending(new Error("sandbox session disposed"));
    const proc = this.proc;
    const closed = (): boolean => proc.exitCode !== null || proc.signalCode !== null;
    try {
      proc.stdin?.end();
    } catch {
      // Already closed.
    }
    if (!closed()) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([new Promise<void>((resolve) => proc.once("close", () => resolve())), delay(TIMEOUTS.terminateMs)]);
    }
    if (!closed()) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await Promise.race([new Promise<void>((resolve) => proc.once("close", () => resolve())), delay(TIMEOUTS.terminateMs)]);
    }
    const remaining = await settleOwnedProcesses(this.sandbox);
    if (remaining.length > 0) {
      throw new Error(`owned sandbox processes did not settle (${remaining.join(", ")}); retaining ${this.sandbox}`);
    }
  }
}

test("shipped sandbox: the four-way primary/executor SyntheticNotify denial matrix is independent and denied calls never execute (#434)", { timeout: TIMEOUTS.testMs }, async (t) => {
  const host = describeHost();
  if (!host.ok || !host.host) {
    skipOrFail(t, `shipped sandbox integration prerequisites unavailable: ${host.problems.join("; ")}`);
    return;
  }
  const summary = stageSandbox(t, host.host);
  assert.equal(summary.deterministic, true, "the sandbox must run the credential-free deterministic provider");

  const scenarios: Array<{ name: string; topLevelDeny: string[]; executorDeny: string[]; primaryExecutes: boolean; executorExecutes: boolean }> = [
    { name: "neither denied", topLevelDeny: [], executorDeny: [], primaryExecutes: true, executorExecutes: true },
    { name: "primary denied only", topLevelDeny: [TOOL], executorDeny: [], primaryExecutes: false, executorExecutes: true },
    { name: "executor denied only", topLevelDeny: [], executorDeny: [TOOL], primaryExecutes: true, executorExecutes: false },
    { name: "both denied", topLevelDeny: [TOOL], executorDeny: [TOOL], primaryExecutes: false, executorExecutes: false },
  ];

  for (const scenario of scenarios) {
    writeGateConfig(summary.sandbox, { topLevelDeny: scenario.topLevelDeny, executorDeny: scenario.executorDeny });
    writeProbeTurnScript(summary.sandbox);
    resetLogs(summary.sandbox);
    const session = SandboxSession.launch(summary);
    try {
      await session.ready();
      await session.prompt("probe");
      await session.prompt(`/subtask-add Call ${TOOL} once with message "executor-probe". If it is unavailable or denied, reply DENIED with the reason and stop.`);

      // Explicit child-side attempt + settled boundary before judging effects.
      const observed = await waitForExecutorObservation(summary.sandbox, TIMEOUTS.executorMs);
      const childAttempts = observed.filter((event) => event.event === "tool_end" && event.toolName === TOOL);
      assert.ok(childAttempts.length > 0, `${scenario.name}: the child must have attempted ${TOOL}`);
      const childErrored = childAttempts.some((event) => event.isError === true);
      assert.equal(childErrored, !scenario.executorExecutes, `${scenario.name}: child attempt error state mismatch; observed ${JSON.stringify(childAttempts)}`);
      if (!scenario.executorExecutes) {
        assert.match(String(childAttempts.at(-1)?.resultText ?? ""), /SyntheticNotify/, `${scenario.name}: the denied child result must concern the attempted tool`);
      }
      assert.ok(observed.some((event) => event.event === "settled"), `${scenario.name}: the child must reach a settled boundary`);

      const calls = readCalls(summary.sandbox);
      const primaryCalls = calls.filter((entry) => entry.event === "tool_call" && entry.caller === "primary" && entry.tool === TOOL);
      const executorCalls = calls.filter((entry) => entry.event === "tool_call" && entry.caller === "executor" && entry.tool === TOOL);
      const executorLoaded = calls.some((entry) => entry.event === "probe_loaded" && entry.role === "executor");
      const primary = session.probeExecutions();

      assert.ok(executorLoaded, `${scenario.name}: a NEW real executor child must start`);
      assert.ok(primary.starts > 0, `${scenario.name}: the primary must have attempted the probe tool through the real host`);
      assert.equal(primaryCalls.length > 0, scenario.primaryExecutes, `${scenario.name}: primary execution mismatch; calls=${JSON.stringify(primaryCalls)}`);
      assert.equal(executorCalls.length > 0, scenario.executorExecutes, `${scenario.name}: executor execution mismatch; calls=${JSON.stringify(executorCalls)}`);
      assert.equal(primary.endedError, !scenario.primaryExecutes, `${scenario.name}: primary probe error state must match the denial`);
    } finally {
      await session.disposeAndSettle();
      resetLogs(summary.sandbox);
    }
  }
});

test("shipped sandbox: a real child that never attempts the probe cannot be mistaken for a denial (#434)", { timeout: TIMEOUTS.testMs }, async (t) => {
  const host = describeHost();
  if (!host.ok || !host.host) {
    skipOrFail(t, `shipped sandbox integration prerequisites unavailable: ${host.problems.join("; ")}`);
    return;
  }
  const summary = stageSandbox(t, host.host);
  writeGateConfig(summary.sandbox, { topLevelDeny: [], executorDeny: [] });
  // A child that only searches and then stops: it never attempts the probe tool.
  writeFileSync(join(summary.sandbox, "state", "turn-script.json"), `${JSON.stringify({
    steps: [
      { toolCalls: [{ toolName: "tool_search", arguments: { query: TOOL } }] },
      { text: "no probe attempt" },
    ],
  }, null, 2)}\n`, "utf8");
  resetLogs(summary.sandbox);

  const session = SandboxSession.launch(summary);
  try {
    await session.ready();
    await session.prompt(`/subtask-add Attempt nothing; do not call ${TOOL}.`);
    await assert.rejects(
      waitForExecutorObservation(summary.sandbox, TIMEOUTS.controlMs),
      /without attempting|never reached a settled attempt boundary/,
      "the observation gate must fail (not pass as a denial) when the child never attempts the tool",
    );
    const observed = readObserved(summary.sandbox);
    assert.ok(observed.some((event) => event.event === "settled"), "the control child must actually run and settle");
    assert.equal(
      observed.some((event) => event.event === "tool_end" && event.toolName === TOOL),
      false,
      "the control child must not have attempted the probe tool",
    );
    assert.deepEqual(readCalls(summary.sandbox).filter((entry) => entry.event === "tool_call"), [], "no probe effect may occur in the non-attempting control");
  } finally {
    await session.disposeAndSettle();
    resetLogs(summary.sandbox);
  }
});

interface MenuOutcome {
  observedDeniedRow: boolean;
  stagedSummary?: string;
  saveRefused: boolean;
  notifies: string[];
}

/**
 * Drive the REAL `/review-settings` Tools selectors (plain-selector fallback over
 * RPC): root -> Tools -> Executor tools -> toggle SyntheticNotify -> Back -> Back
 * -> root, then either Cancel the draft or Save it. A root reappearing after Save
 * is recorded as a refusal so the caller can report the actual notify error.
 */
async function driveExecutorDenyMenu(session: SandboxSession, action: "Cancel" | "Save changes"): Promise<MenuOutcome> {
  const since = session.events.length;
  let phase: "root" | "tools" | "picker" | "toolsBack" | "saveRoot" | "afterSave" | "done" = "root";
  let failure: string | undefined;
  let observedDeniedRow = false;
  let stagedSummary: string | undefined;
  let saveRefused = false;
  session.setUiResponder((request) => {
    if (failure) return undefined;
    const options = optionStrings(request);
    if (request.title === "Review settings") {
      if (phase === "afterSave") {
        saveRefused = true;
        phase = "done";
        return { value: pick(options, "Cancel") ?? "" };
      }
      if (phase === "saveRoot") {
        stagedSummary = options.find((option) => option.startsWith("Tools"));
        if (action === "Cancel") {
          phase = "done";
          return { value: pick(options, "Cancel") ?? "" };
        }
        phase = "afterSave";
        return { value: pick(options, "Save changes") ?? "" };
      }
      if (phase !== "root") { failure = `unexpected root at phase ${phase}`; return undefined; }
      const tools = pick(options, "Tools");
      if (!tools) { failure = `Tools row missing from ${JSON.stringify(options)}`; return undefined; }
      phase = "tools";
      return { value: tools };
    }
    if (request.title === "Tools") {
      if (phase === "tools") {
        const row = pick(options, "Executor tools");
        if (!row) { failure = "Executor tools row missing"; return undefined; }
        phase = "picker";
        return { value: row };
      }
      if (phase === "toolsBack") {
        const back = pick(options, "Back");
        if (!back) { failure = "Tools Back row missing"; return undefined; }
        phase = "saveRoot";
        return { value: back };
      }
      failure = `unexpected Tools menu at phase ${phase}`;
      return undefined;
    }
    if (typeof request.title === "string" && request.title.startsWith("Executor tools")) {
      if (phase !== "picker") { failure = `unexpected picker at phase ${phase}`; return undefined; }
      if (options.some((option) => option.startsWith(TOOL) && option.includes("denied"))) observedDeniedRow = true;
      const allowed = options.find((option) => option.startsWith(TOOL) && option.includes("allowed"));
      if (allowed) return { value: allowed };
      const back = pick(options, "Back");
      if (!back) { failure = "picker Back row missing"; return undefined; }
      phase = "toolsBack";
      return { value: back };
    }
    return undefined;
  });
  try {
    await session.command("/review-settings");
    if (action === "Save changes" && !saveRefused) {
      await session.waitForEvent(
        (event) => event.type === "extension_ui_request" && event.method === "notify" && event.message === "Review settings saved.",
        since,
        TIMEOUTS.requestMs,
      );
    }
  } finally {
    session.setUiResponder(undefined);
  }
  assert.equal(failure, undefined, failure);
  const notifies = session.events.slice(since)
    .filter((event) => event.type === "extension_ui_request" && event.method === "notify")
    .map((event) => String(event.message ?? ""));
  return { observedDeniedRow, stagedSummary, saveRefused, notifies };
}

test("shipped sandbox: the real /review-settings Tools apply then a NEW real executor child in the same session is denied while the primary stays allowed (#434)", { timeout: TIMEOUTS.testMs }, async (t) => {
  const host = describeHost();
  if (!host.ok || !host.host) {
    skipOrFail(t, `shipped sandbox integration prerequisites unavailable: ${host.problems.join("; ")}`);
    return;
  }
  const summary = stageSandbox(t, host.host);
  writeGateConfig(summary.sandbox, { topLevelDeny: [], executorDeny: [] });
  writeProbeTurnScript(summary.sandbox);
  resetLogs(summary.sandbox);

  const session = SandboxSession.launch(summary);
  try {
    await session.ready();

    // 1. Cancel must discard the staged denial (negative control for the apply).
    const canceled = await driveExecutorDenyMenu(session, "Cancel");
    assert.equal(canceled.observedDeniedRow, true, "the production picker must render the toggled tool as a denied row");
    assert.match(String(canceled.stagedSummary ?? ""), /1 executor denied/, "the root Tools summary must reflect the staged denial");
    assert.equal(canceled.saveRefused, false);
    const afterCancel = JSON.parse(readFileSync(join(summary.sandbox, "agent", "review-gate.json"), "utf8")) as { tools?: { executorDeny?: string[] } };
    assert.deepEqual(afterCancel.tools?.executorDeny, [], "Cancel must discard the staged denial");

    // 2. The SAME session must now persist the denial through the real Save path.
    const saved = await driveExecutorDenyMenu(session, "Save changes");
    assert.equal(saved.observedDeniedRow, true, "the re-opened picker must still render the toggle");
    assert.match(String(saved.stagedSummary ?? ""), /1 executor denied/);
    assert.equal(saved.saveRefused, false, `production menu Save must succeed; observed notifies: ${JSON.stringify(saved.notifies)}`);
    const persisted = JSON.parse(readFileSync(join(summary.sandbox, "agent", "review-gate.json"), "utf8")) as { tools?: { executorDeny?: string[] } };
    assert.deepEqual(persisted.tools?.executorDeny, [TOOL], "a successful Save must persist the staged denial");

    // 3. In the SAME primary session, a NEW executor admitted after the apply must
    //    inherit the changed ceiling while the primary remains allowed.
    resetLogs(summary.sandbox);
    await session.prompt("probe");
    const primary = session.probeExecutions();
    assert.ok(primary.starts > 0, "the primary must still attempt the probe tool after the executor-only apply");
    assert.equal(primary.endedError, false, "an executor-only denial must preserve primary authority");

    await session.prompt(`/subtask-add Call ${TOOL} once and stop.`);
    const observed = await waitForExecutorObservation(summary.sandbox, TIMEOUTS.executorMs);
    const attempts = observed.filter((event) => event.event === "tool_end" && event.toolName === TOOL);
    assert.ok(attempts.length > 0, "the newly admitted child must attempt the probe tool");
    assert.ok(attempts.every((event) => event.isError === true), `the newly admitted child's attempt must be denied: ${JSON.stringify(attempts)}`);
    assert.match(String(attempts.at(-1)?.resultText ?? ""), /SyntheticNotify/, "the denied child result must concern the attempted tool");
    const calls = readCalls(summary.sandbox).filter((entry) => entry.event === "tool_call" && entry.tool === TOOL);
    assert.ok(calls.some((entry) => entry.caller === "primary"), "the primary must remain able to execute the probe tool");
    assert.equal(calls.some((entry) => entry.caller === "executor"), false, "the newly admitted child must not execute the denied tool");
  } finally {
    await session.disposeAndSettle();
  }
});

test("shipped sandbox: a real running executor child keeps its captured SyntheticNotify authority across a production executor-deny apply while the next admission is denied (#434)", { timeout: TIMEOUTS.liveChildMs }, async (t) => {
  const host = describeHost();
  if (!host.ok || !host.host) {
    skipOrFail(t, `shipped sandbox integration prerequisites unavailable: ${host.problems.join("; ")}`);
    return;
  }
  const summary = stageSandbox(t, host.host, { hold: true });
  writeGateConfig(summary.sandbox, { topLevelDeny: [], executorDeny: [] });
  // The primary's own turns (the /subtask-add launch notice and the final
  // eligibility probe) execute the probe tool directly; they never dispatch
  // another task. The executor child reads its own hold script instead, because
  // the test-only hold fixture points only the executor role at it.
  writeProbeTurnScript(summary.sandbox);
  resetLiveChildLogs(summary.sandbox);

  const session = SandboxSession.launch(summary);
  try {
    await session.ready();

    // 1. Admit the first real executor child with an empty deny list and park it
    //    at the hold. Its pid is the exact process the apply must not disturb.
    //    (Its scripted turns ignore this human text and call the probe with the
    //    child script's own message.)
    await session.prompt(`/subtask-add Call ${TOOL} once and stop.`);
    const oldPid = await waitForHoldEntered(summary.sandbox, TIMEOUTS.executorMs);
    assert.notEqual(oldPid, process.pid, "the held executor must be a separate process");
    assert.equal(processAlive(oldPid), true, "the pre-apply child must be genuinely live in its hold");

    // 2. While that child is held, apply the executor-only denial through the
    //    real production menu Save path in the SAME primary session.
    const saved = await driveExecutorDenyMenu(session, "Save changes");
    assert.equal(saved.observedDeniedRow, true, "the production picker must render the toggled tool as a denied row");
    assert.match(String(saved.stagedSummary ?? ""), /1 executor denied/, "the root Tools summary must reflect the staged denial");
    assert.equal(saved.saveRefused, false, `production menu Save must succeed; observed notifies: ${JSON.stringify(saved.notifies)}`);
    const persisted = JSON.parse(readFileSync(join(summary.sandbox, "agent", "review-gate.json"), "utf8")) as { tools?: { executorDeny?: string[] } };
    assert.deepEqual(persisted.tools?.executorDeny, [TOOL], "a successful Save must persist the staged executor denial");
    assert.equal(processAlive(oldPid), true, "the already-admitted child must still be live across the apply");

    // 3. Release the held child. Its captured catalog predates the apply, so it
    //    must still execute SyntheticNotify and reach an explicit settled boundary.
    writeFileSync(holdSentinelPath(summary.sandbox), "release\n", "utf8");
    const oldEvents = await waitForChildByPid(summary.sandbox, oldPid, TIMEOUTS.executorMs);
    const oldAttempt = oldEvents.find((event) => event.event === "tool_end" && event.toolName === TOOL);
    assert.ok(oldAttempt, `the pre-apply child must attempt ${TOOL}: ${JSON.stringify(oldEvents)}`);
    assert.equal(oldAttempt.isError, false, `the pre-apply child must keep its captured allowance: ${JSON.stringify(oldAttempt)}`);
    assert.ok(oldEvents.some((event) => event.event === "settled"), "the held child must reach a settled boundary after release");
    const oldHold = readHold(summary.sandbox).filter((record) => record.pid === oldPid);
    assert.ok(oldHold.some((record) => record.event === "hold_entered"), "the child must actually have entered the hold");
    assert.ok(oldHold.some((record) => record.event === "hold_released"), "the child must actually have been released");
    const executorCallsAfterOld = readCalls(summary.sandbox)
      .filter((entry) => entry.event === "tool_call" && entry.tool === TOOL && entry.caller === "executor");
    assert.ok(executorCallsAfterOld.length > 0, "the pre-apply child must produce the synthetic effect after release");

    // 4. A NEW real executor child admitted after the same apply must inherit the
    //    changed denial: an explicit denied attempt with no synthetic effect.
    await session.prompt(`/subtask-add Call ${TOOL} once and stop.`);
    const newPid = await waitForHoldEntered(summary.sandbox, TIMEOUTS.executorMs, oldPid);
    assert.notEqual(newPid, oldPid, "the post-apply admission must be a different real process");
    const newEvents = await waitForChildByPid(summary.sandbox, newPid, TIMEOUTS.executorMs);
    const newAttempt = newEvents.find((event) => event.event === "tool_end" && event.toolName === TOOL);
    assert.ok(newAttempt, `the newly admitted child must attempt ${TOOL}: ${JSON.stringify(newEvents)}`);
    assert.equal(newAttempt.isError, true, `the newly admitted child's attempt must be denied: ${JSON.stringify(newAttempt)}`);
    assert.match(String(newAttempt.resultText ?? ""), /SyntheticNotify/, "the denied child result must concern the attempted tool");
    assert.ok(newEvents.some((event) => event.event === "settled"), "the denied child must reach a settled boundary");
    const executorCallsAfterNew = readCalls(summary.sandbox)
      .filter((entry) => entry.event === "tool_call" && entry.tool === TOOL && entry.caller === "executor");
    assert.equal(executorCallsAfterNew.length, executorCallsAfterOld.length, "the denied new child must produce no synthetic effect");

    // 5. The executor-only apply must leave primary eligibility unchanged.
    const primaryBefore = session.probeExecutions().starts;
    await session.prompt("probe");
    const primary = session.probeExecutions();
    assert.ok(primary.starts > primaryBefore, "the primary must still execute the probe tool after the executor-only apply");
    assert.equal(primary.endedError, false, "the executor-only apply must preserve primary authority");
    const calls = readCalls(summary.sandbox).filter((entry) => entry.event === "tool_call" && entry.tool === TOOL);
    assert.ok(calls.some((entry) => entry.caller === "primary"), "the primary must remain able to execute the probe tool");
  } finally {
    await session.disposeAndSettle();
  }
});
