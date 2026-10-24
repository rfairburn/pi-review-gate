import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolvePiChildSpawn } from "../src/pi-invocation";
import { redactSensitiveText } from "../src/redaction";

const EXPECTED_PI_VERSION = "1.4.0";
const RPC_TIMEOUT_MS = process.platform === "win32" ? 90_000 : 30_000;
const CHILD_CLOSE_TIMEOUT_MS = 2_000;
const TREE_TERM_GRACE_MS = 1_500;
const TREE_KILL_TIMEOUT_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 10_000;
// Startup evidence attached to an RPC failure is bounded and sanitized: it
// never extends the RPC deadline and never replaces an assertion.
const DIAGNOSTIC_STDOUT_TAIL_LINES = 12;
const DIAGNOSTIC_LINE_CHARS = 400;
const DIAGNOSTIC_STDERR_TAIL_CHARS = 4_000;
const DIAGNOSTIC_TRACE_BYTES = 8 * 1024;
const DIAGNOSTIC_EVENT_TYPES = 32;
const HOST_LOOKUP_TIMEOUT_MS = 5_000;

type ResolvedPiSpawn = Extract<ReturnType<typeof resolvePiChildSpawn>, { ok: true }> & {
  windowsVerbatimArguments?: boolean;
};

interface RpcResponse extends Record<string, unknown> {
  type: string;
  id: string;
  success: boolean;
}

interface RpcClient {
  request(type: string, fields?: Record<string, unknown>): Promise<RpcResponse>;
  lines: string[];
  /** Bounded, sanitized startup evidence; the only output published in failures. */
  diagnostics(): string;
  close(): Promise<void>;
}

interface RpcDriveOptions {
  /** Per-request deadline; the installed smoke always uses RPC_TIMEOUT_MS. */
  timeoutMs?: number;
  /** JSON-lines startup trace written by the anonymous trace/probe extensions. */
  tracePath?: string;
  /** Owned fixture roots replaced by placeholders in failure evidence. */
  redactRoots?: readonly string[];
}

/** Bounded startup evidence for one owned RPC child (#421 PR435 Windows follow-through). */
interface RpcStartupEvidence {
  spawnedAt: number;
  pid: number | undefined;
  stdoutLines: number;
  firstStdoutAt?: number;
  lastStdoutAt?: number;
  eventTypes: Map<string, number>;
  stdoutTail: string[];
  stderrTail: string;
  stderrChars: number;
  exit?: { code: number | null; signal: NodeJS.Signals | null; at: number };
}

/**
 * Strip terminal control sequences, replace owned fixture roots (raw,
 * slash-normalized, and JSON-escaped forms) with placeholders, and redact
 * credential-shaped values. The sandbox has no provider credentials, but
 * failure evidence must stay safe to publish in a public CI log.
 */
function sanitizeDiagnosticText(text: string, redactRoots: readonly string[] = []): string {
  let out = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const variants = new Set<string>();
  for (const root of redactRoots) {
    if (!root || root.length < 4) continue;
    for (const form of [root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")]) {
      variants.add(form);
      variants.add(JSON.stringify(form).slice(1, -1));
    }
  }
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    // Windows paths are case-insensitive; POSIX paths are matched exactly.
    out = process.platform === "win32"
      ? out.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<fixture>")
      : out.split(variant).join("<fixture>");
  }
  return redactSensitiveText(out);
}

function truncateDiagnostic(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...[+${text.length - limit} chars]`;
}

/** Read at most DIAGNOSTIC_TRACE_BYTES of the JSON-lines startup trace. */
function readStartupTrace(tracePath: string | undefined): Array<Record<string, unknown>> | string {
  if (!tracePath) return "not configured";
  if (!existsSync(tracePath)) return "no marker written";
  let fd: number | undefined;
  try {
    fd = openSync(tracePath, "r");
    const buffer = Buffer.alloc(DIAGNOSTIC_TRACE_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const markers: Array<Record<string, unknown>> = [];
    for (const line of buffer.subarray(0, read).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed === "object" && parsed !== null) markers.push(parsed as Record<string, unknown>);
      } catch {
        // A truncated final line is expected at the byte bound.
      }
    }
    return markers;
  } catch (error) {
    return `unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Format sanitized, bounded startup evidence for an RPC failure. It reports
 * where startup stopped (spawn, stdout, extension load/session_start markers,
 * exit) without asserting a cause.
 */
function formatRpcStartupDiagnostics(
  evidence: RpcStartupEvidence,
  options: { now: number; tracePath?: string; redactRoots?: readonly string[] },
): string {
  const rel = (at: number | undefined): string => {
    if (at === undefined) return "never";
    const delta = at - evidence.spawnedAt;
    return `${delta < 0 ? "-" : "+"}${Math.abs(delta)}ms`;
  };
  const roots = options.redactRoots ?? [];
  const events = [...evidence.eventTypes.entries()].map(([type, count]) => `${type}x${count}`).join(", ") || "(none)";
  const trace = readStartupTrace(options.tracePath);
  const markers = typeof trace === "string"
    ? trace
    : trace.length === 0
      ? "no marker written"
      : trace.map((marker) => {
        const at = typeof marker.at === "number" ? rel(marker.at) : "?";
        return `${String(marker.role ?? "?")}:${String(marker.phase ?? "?")}@${at}`;
      }).join(", ");
  const exit = evidence.exit
    ? `exited ${evidence.exit.code ?? evidence.exit.signal} at ${rel(evidence.exit.at)}`
    : "still running when evidence was captured";
  const stdoutTail = evidence.stdoutTail.length
    ? evidence.stdoutTail.map((line) => `    ${truncateDiagnostic(sanitizeDiagnosticText(line, roots), DIAGNOSTIC_LINE_CHARS)}`).join("\n")
    : "    (none)";
  const stderrText = sanitizeDiagnosticText(evidence.stderrTail, roots).trimEnd();
  const stderrTail = stderrText
    ? stderrText.split("\n").map((line) => `    ${line}`).join("\n")
    : "    (none)";
  return [
    "installed Pi startup diagnostics (sanitized, bounded):",
    `  elapsed since spawn: ${options.now - evidence.spawnedAt}ms; child pid ${evidence.pid ?? "unknown"} ${exit}`,
    `  stdout: ${evidence.stdoutLines} line(s); first ${rel(evidence.firstStdoutAt)}; last ${rel(evidence.lastStdoutAt)}; event types: ${sanitizeDiagnosticText(events, roots)}`,
    `  startup markers (before-candidate trace, after-candidate probe): ${sanitizeDiagnosticText(markers, roots)}`,
    `  stderr: ${evidence.stderrChars} char(s) total; tail:`,
    stderrTail,
    `  stdout tail (last ${DIAGNOSTIC_STDOUT_TAIL_LINES}):`,
    stdoutTail,
  ].join("\n");
}

/**
 * Windows-only, diagnostic-only timing of the same `where` host lookup the
 * candidate's native PowerShell support runs at session start, executed in
 * the identical isolated environment. It asserts nothing and never gates the
 * smoke; it only records whether that lookup is slow or failing on this host.
 */
function windowsHostLookupDiagnostic(env: NodeJS.ProcessEnv, cwd: string, redactRoots: readonly string[]): string {
  return ["pwsh.exe", "powershell.exe"].map((name) => {
    const started = Date.now();
    const result = spawnSync("where", [name], {
      cwd,
      env,
      encoding: "utf8",
      timeout: HOST_LOOKUP_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    });
    const elapsed = Date.now() - started;
    const error = result.error ? (result.error as NodeJS.ErrnoException).code ?? result.error.message : "none";
    const firstLine = typeof result.stdout === "string" ? result.stdout.trim().split(/\r?\n/)[0] ?? "" : "";
    return `where ${name}: status ${result.status} signal ${result.signal ?? "none"} error ${error} in ${elapsed}ms`
      + (firstLine ? ` -> ${truncateDiagnostic(sanitizeDiagnosticText(firstLine, redactRoots), 200)}` : "");
  }).join("; ");
}

function requirePath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? resolve(value) : undefined;
}

function resolveInstalledPi(args: string[], childEnv: NodeJS.ProcessEnv): ResolvedPiSpawn {
  const spec = resolvePiChildSpawn("pi", args, childEnv);
  if (!spec.ok) throw new Error(`could not resolve installed pi command: ${spec.error}`);
  assert.equal(typeof spec.file, "string", "the shared resolver must return a concrete spawn file");
  assert.ok(Array.isArray(spec.args), "the shared resolver must return an argv array");
  const resolved = spec as ResolvedPiSpawn;
  if (process.platform === "win32") {
    assert.equal(resolved.windowsVerbatimArguments, true,
      "a resolved Windows pi.cmd command must request verbatim argv forwarding");
  } else {
    assert.deepEqual(resolved.args, args,
      "POSIX command resolution must preserve argv byte-for-byte");
  }
  return resolved;
}

function withVerbatimArguments(spec: ResolvedPiSpawn, options: SpawnOptions): SpawnOptions {
  if (spec.windowsVerbatimArguments !== undefined) {
    options.windowsVerbatimArguments = spec.windowsVerbatimArguments;
  }
  return options;
}

async function runVersionCommand(spec: ResolvedPiSpawn, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const child = trackChild(spawn(spec.file, spec.args, withVerbatimArguments(spec, {
    cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })));
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-1024 * 1024); });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1024 * 1024); });

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolvePromise({ code, signal }));
      }),
      new Promise<never>((_resolvePromise, reject) => {
        timer = setTimeout(() => reject(new Error("the installed Pi --version command timed out")), 20_000);
      }),
    ]);
    assert.equal(result.code, 0,
      `the actual installed pi command must exit successfully (${result.signal ?? result.code}): ${stderr}`);
    return `${stdout}${stderr}`.trim();
  } finally {
    if (timer) clearTimeout(timer);
    await terminateOwnedProcessTree(child);
  }
}

function assertResolvedEntry(
  spec: ResolvedPiSpawn,
  expectedShim: string,
  requestedArgs: string[],
  description: string,
): void {
  if (process.platform === "win32") {
    const invocation = [spec.file, ...spec.args].join(" ").replace(/[\"']/g, "").toLowerCase();
    assert.ok(invocation.includes(resolve(expectedShim).toLowerCase()),
      `${description} must target the installed command shim ${expectedShim}; got ${invocation}`);
    assert.equal(spec.windowsVerbatimArguments, true,
      `${description} must retain windowsVerbatimArguments for the encoded cmd invocation`);
  } else {
    assert.equal(spec.file, "pi", `${description} must use the command found through PATH`);
    assert.deepEqual(spec.args, requestedArgs,
      `${description} must pass the original POSIX argv byte-for-byte`);
  }
}

function isolatedCommandEnvironment(
  binDirectories: string[],
  sandbox: string,
  runtimeBin: string,
  agentRoot: string,
  candidateEntry: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const inheritedPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const pathKey = process.platform === "win32" ? inheritedPathKey : "PATH";
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const pathEntries = [...binDirectories, dirname(process.execPath)];
  if (process.platform === "win32" && systemRoot) pathEntries.push(join(systemRoot, "System32"));
  else pathEntries.push("/usr/bin", "/bin");
  env[pathKey] = [...new Set(pathEntries)].join(delimiter);

  // Keep only the OS values needed to start Node/npm shims and never append
  // the ambient developer/runner PATH. Provider credentials, profile paths,
  // and inherited review-gate role/config are not copied into this sandbox.
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const home = join(sandbox, "home");
  const temp = join(sandbox, "tmp");
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  env.TEMP = temp;
  env.TMP = temp;
  env.TMPDIR = temp;
  env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
  env.PI_REVIEW_GATE_INSTALLED_PI_BIN = runtimeBin;
  env.PI_REVIEW_GATE_INSTALLED_AGENT = agentRoot;
  env.PI_REVIEW_GATE_CANDIDATE_ENTRY = candidateEntry;
  env.PI_REVIEW_GATE_REQUIRE_PI_HOST = "1";
  env.PI_REVIEW_GATE_EXPECT_PI_VERSION = EXPECTED_PI_VERSION;
  return env;
}

const closedChildren = new WeakSet<ChildProcess>();

function trackChild(child: ChildProcess): ChildProcess {
  child.once("close", () => closedChildren.add(child));
  return child;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function processGroupIsAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
  }
  return !processIsAlive(pid);
}

async function waitForProcessGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(pgid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
  }
  return !processGroupIsAlive(pgid);
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (closedChildren.has(child) || child.pid === undefined) return true;
  return new Promise((resolvePromise) => {
    const onClose = (): void => {
      closedChildren.add(child);
      finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (closed: boolean): void => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolvePromise(closed);
    };
    child.once("close", onClose);
  });
}

class ProcessTreeCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessTreeCleanupError";
  }
}

/** Terminate only the process tree owned by this test's exact child PID. */
async function terminateOwnedProcessTree(child: ChildProcess): Promise<void> {
  try {
    await terminateOwnedProcessTreeImpl(child);
  } catch (error) {
    if (error instanceof ProcessTreeCleanupError) throw error;
    throw new ProcessTreeCleanupError(`could not clean the owned process tree: ${String(error)}`, { cause: error });
  }
}

async function terminateOwnedProcessTreeImpl(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const taskkill = systemRoot ? join(systemRoot, "System32", "taskkill.exe") : "taskkill";
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: TASKKILL_TIMEOUT_MS,
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    if (result.error) throw new Error(`taskkill failed for owned process ${pid}: ${result.error.message}`);
    if (result.status !== 0 && processIsAlive(pid)) {
      throw new Error(`taskkill did not terminate owned process tree ${pid} (status ${result.status})`);
    }
  } else if (processGroupIsAlive(pid)) {
    try { process.kill(-pid, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    if (!(await waitForProcessGroupExit(pid, TREE_TERM_GRACE_MS))) {
      try { process.kill(-pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      if (!(await waitForProcessGroupExit(pid, TREE_KILL_TIMEOUT_MS))) {
        throw new Error(`SIGKILL did not terminate owned process group ${pid}`);
      }
    }
  }

  if (!(await waitForChildClose(child, TREE_KILL_TIMEOUT_MS))) {
    throw new Error(`owned process ${pid} did not close after process-tree termination`);
  }
}

function driveRpc(child: ChildProcess, options: RpcDriveOptions = {}): RpcClient {
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
  let nextId = 1;
  let buffer = "";
  let closed = false;
  const lines: string[] = [];
  const evidence: RpcStartupEvidence = {
    spawnedAt: Date.now(),
    pid: child.pid,
    stdoutLines: 0,
    eventTypes: new Map(),
    stdoutTail: [],
    stderrTail: "",
    stderrChars: 0,
  };
  const diagnostics = (): string => formatRpcStartupDiagnostics(evidence, {
    now: Date.now(),
    tracePath: options.tracePath,
    redactRoots: options.redactRoots,
  });
  const pending = new Map<string, {
    resolve(response: RpcResponse): void;
    reject(error: Error): void;
  }>();

  const failPending = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const raw = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!raw) continue;
      lines.push(raw);
      const at = Date.now();
      evidence.stdoutLines += 1;
      evidence.firstStdoutAt ??= at;
      evidence.lastStdoutAt = at;
      evidence.stdoutTail.push(raw);
      if (evidence.stdoutTail.length > DIAGNOSTIC_STDOUT_TAIL_LINES) evidence.stdoutTail.shift();
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const eventType = typeof event.type === "string" ? event.type.slice(0, 64) : "(untyped)";
      if (evidence.eventTypes.has(eventType) || evidence.eventTypes.size < DIAGNOSTIC_EVENT_TYPES) {
        evidence.eventTypes.set(eventType, (evidence.eventTypes.get(eventType) ?? 0) + 1);
      }
      if (event.type !== "response" || typeof event.id !== "string") continue;
      const waiter = pending.get(event.id);
      if (!waiter) continue;
      pending.delete(event.id);
      if (event.success === true) waiter.resolve(event as RpcResponse);
      else waiter.reject(new Error(typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? {})));
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    lines.push(`[stderr] ${chunk}`);
    if (lines.length > 100) lines.shift();
    evidence.stderrChars += chunk.length;
    evidence.stderrTail = `${evidence.stderrTail}${chunk}`.slice(-DIAGNOSTIC_STDERR_TAIL_CHARS);
  });
  child.once("error", (error) => failPending(new Error(`installed Pi failed to start: ${error.message}\n${diagnostics()}`)));
  child.once("close", (code, signal) => {
    closed = true;
    evidence.exit = { code, signal, at: Date.now() };
    if (pending.size) {
      // Only the bounded, sanitized formatter output is published; raw
      // stdout/stderr lines are never interpolated into the failure.
      failPending(new Error(`installed Pi exited before RPC completed (${code ?? signal}):\n${diagnostics()}`));
    }
  });

  return {
    lines,
    diagnostics,
    request: (type, fields = {}) => new Promise((resolvePromise, reject) => {
      if (closed) {
        reject(new Error(`installed Pi exited before RPC ${type}\n${diagnostics()}`));
        return;
      }
      const id = `prg-installed-${nextId++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`installed Pi RPC ${type} timed out after ${timeoutMs}ms\n${diagnostics()}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (response) => { clearTimeout(timer); resolvePromise(response); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
        if (!error) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    }),
    close: async () => {
      if (closed || closedChildren.has(child)) return;
      child.stdin?.end();
      await waitForChildClose(child, CHILD_CLOSE_TIMEOUT_MS);
    },
  };
}

function probeExtensionSource(): string {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "module.exports = function (pi) {",
    ...startupTraceStatements("after-candidate"),
    '  pi.registerCommand("prg-installed-launch-probe", {',
    '    description: "Record anonymous process ancestry for the installed Pi smoke test.",',
    "    handler: async () => {",
    "      const wrapperPid = Number(process.env.PRG_INSTALLED_PI_WRAPPER_PID);",
    "      fs.writeFileSync(process.env.PRG_INSTALLED_PI_PROBE_RESULT, JSON.stringify({ pid: process.pid, ppid: process.ppid, wrapperPid: Number.isInteger(wrapperPid) && wrapperPid > 0 ? wrapperPid : null }));",
    "    },",
    "  });",
    "};",
    "module.exports.default = module.exports;",
  ].join("\n");
}

/**
 * Anonymous startup markers (role, phase, wall-clock ms) appended to the
 * owned trace file. A marker failure is ignored so tracing can never change
 * the registration result; it only records how far startup progressed.
 */
function startupTraceStatements(role: "before-candidate" | "after-candidate"): string[] {
  return [
    "  const __prgTrace = (phase) => {",
    "    const file = process.env.PRG_INSTALLED_PI_STARTUP_TRACE;",
    "    if (!file) return;",
    `    try { require('node:fs').appendFileSync(file, JSON.stringify({ role: ${JSON.stringify(role)}, phase, at: Date.now() }) + '\\n'); } catch {}`,
    "  };",
    "  __prgTrace('loaded');",
    "  if (typeof pi.on === 'function') pi.on('session_start', () => { __prgTrace('session_start'); });",
  ];
}

/** Trace-only extension loaded before the candidate; it registers nothing. */
function startupTraceExtensionSource(): string {
  return [
    "'use strict';",
    "module.exports = function (pi) {",
    ...startupTraceStatements("before-candidate"),
    "};",
    "module.exports.default = module.exports;",
  ].join("\n");
}

function wrapperEntrySource(): string {
  return [
    "'use strict';",
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, [process.env.PRG_INSTALLED_PI_CLI, ...process.argv.slice(2)], { stdio: 'inherit', shell: false, env: { ...process.env, PRG_INSTALLED_PI_WRAPPER_PID: String(process.pid) } });",
    "child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });",
    "child.once('close', (code) => { process.exitCode = code ?? 1; });",
  ].join("\n");
}

async function createRpcSession(
  sandbox: string,
  label: string,
  argsEnv: NodeJS.ProcessEnv,
  candidateEntry: string,
  expectedShim: string,
): Promise<{ rpc: RpcClient; child: ChildProcess; probeResult: string }> {
  const sessionRoot = join(sandbox, label);
  const home = join(sessionRoot, "home");
  const agentDir = join(sessionRoot, "agent");
  const sessionsDir = join(sessionRoot, "sessions");
  const temp = join(sessionRoot, "tmp");
  const probeResult = join(sessionRoot, "probe-result.json");
  const probePath = join(sessionRoot, "probe-extension.cjs");
  const tracePath = join(sessionRoot, "startup-trace.jsonl");
  const traceExtensionPath = join(sessionRoot, "startup-trace-extension.cjs");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(sessionsDir, { recursive: true }),
    mkdir(temp, { recursive: true }),
  ]);
  await writeFile(join(agentDir, "review-gate.json"), JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {},
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
  }, null, 2), "utf8");
  await writeFile(probePath, probeExtensionSource(), "utf8");
  await writeFile(traceExtensionPath, startupTraceExtensionSource(), "utf8");

  const env = { ...argsEnv };
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = join(home, "AppData", "Local");
  env.TEMP = temp;
  env.TMP = temp;
  env.TMPDIR = temp;
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PRG_INSTALLED_PI_PROBE_RESULT = probeResult;
  env.PRG_INSTALLED_PI_STARTUP_TRACE = tracePath;
  const args = [
    "--mode", "rpc",
    "--session-dir", sessionsDir,
    "--extension", traceExtensionPath,
    "--extension", candidateEntry,
    "--extension", probePath,
  ];
  const spec = resolveInstalledPi(args, env);
  assertResolvedEntry(spec, expectedShim, args, `installed Pi ${label} RPC command`);
  const child = trackChild(spawn(spec.file, spec.args, withVerbatimArguments(spec, {
    cwd: sessionRoot,
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })));
  if (!child.stdin || !child.stdout) {
    await terminateOwnedProcessTree(child);
    throw new Error("installed Pi RPC child did not expose piped stdio");
  }
  return {
    rpc: driveRpc(child, { tracePath, redactRoots: [sandbox, dirname(candidateEntry)] }),
    child,
    probeResult,
  };
}

async function runRegistrationSmoke(
  sandbox: string,
  label: string,
  env: NodeJS.ProcessEnv,
  candidateEntry: string,
  expectedShim: string,
  wrapperExpected: boolean,
): Promise<void> {
  const { rpc, child, probeResult } = await createRpcSession(
    sandbox, label, env, candidateEntry, expectedShim,
  );
  try {
    const state = await rpc.request("get_state", {});
    assert.equal(state.success, true, `installed Pi get_state must succeed:\n${rpc.diagnostics()}`);

    const commandsResponse = await rpc.request("get_commands", {});
    assert.equal(commandsResponse.success, true, "installed Pi get_commands must succeed");
    const data = typeof commandsResponse.data === "object" && commandsResponse.data !== null
      ? commandsResponse.data as Record<string, unknown>
      : {};
    const commands = Array.isArray(data.commands) ? data.commands as Array<Record<string, unknown>> : [];
    const names = commands.map((command) => String(command.name));
    assert.ok(names.includes("review-gate-ping"),
      `the candidate extension must register its command in real Pi RPC; found ${names.join(", ") || "(none)"}`);
    assert.ok(names.includes("prg-installed-launch-probe"),
      `the anonymous probe extension must register in real Pi RPC; found ${names.join(", ") || "(none)"}`);

    // This is a registered slash-command action, not a plain prompt: the
    // synthetic session has no model configured, so no provider request occurs.
    const command = await rpc.request("prompt", { message: "/prg-installed-launch-probe" });
    assert.equal(command.success, true, "the provider-free RPC command must execute");
    const deadline = Date.now() + 15_000;
    while (!existsSync(probeResult) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(existsSync(probeResult), `the probe command did not run:\n${rpc.diagnostics()}`);
    const processInfo = JSON.parse(await readFile(probeResult, "utf8")) as {
      pid: number;
      ppid: number;
      wrapperPid: number | null;
    };
    assert.ok(Number.isInteger(processInfo.pid) && processInfo.pid > 0);
    assert.ok(Number.isInteger(processInfo.ppid) && processInfo.ppid > 0);
    if (wrapperExpected) {
      assert.ok(Number.isInteger(processInfo.wrapperPid) && processInfo.wrapperPid! > 0,
        "the managed-style wrapper must pass its anonymous process id to its real Pi child");
      assert.equal(processInfo.ppid, processInfo.wrapperPid,
        "the real installed Pi process must remain a child of the generated wrapper process");
    }
  } finally {
    try {
      await rpc.close();
    } finally {
      await terminateOwnedProcessTree(child);
    }
  }
}

test("fresh Pi 1.4.0 install launches through the resolver and registers the candidate without a provider call", { timeout: 180_000 }, async (t) => {
  const runtimeBin = requirePath("PI_REVIEW_GATE_INSTALLED_PI_BIN");
  const agentRoot = requirePath("PI_REVIEW_GATE_INSTALLED_AGENT");
  const candidateEntry = requirePath("PI_REVIEW_GATE_CANDIDATE_ENTRY");
  const expectedVersion = process.env.PI_REVIEW_GATE_EXPECT_PI_VERSION?.trim();
  const cliEntry = agentRoot ? join(agentRoot, "dist", "bundle", "cli.js") : undefined;
  const nativeBin = runtimeBin
    ? join(runtimeBin, process.platform === "win32" ? "pi.cmd" : "pi")
    : undefined;
  const missing = [
    !runtimeBin && "PI_REVIEW_GATE_INSTALLED_PI_BIN",
    !agentRoot && "PI_REVIEW_GATE_INSTALLED_AGENT",
    !candidateEntry && "PI_REVIEW_GATE_CANDIDATE_ENTRY",
    !expectedVersion && "PI_REVIEW_GATE_EXPECT_PI_VERSION",
    runtimeBin && !existsSync(runtimeBin) && `installed Pi bin directory (${runtimeBin})`,
    agentRoot && !existsSync(agentRoot) && `installed Pi package root (${agentRoot})`,
    candidateEntry && !existsSync(candidateEntry) && `built candidate entry (${candidateEntry})`,
    cliEntry && !existsSync(cliEntry) && `installed Pi CLI entry (${cliEntry})`,
    nativeBin && !existsSync(nativeBin) && `npm-generated Pi command shim (${nativeBin})`,
  ].filter((item): item is string => Boolean(item));
  if (missing.length) {
    const message = `required installed-Pi smoke prerequisite(s) missing: ${missing.join(", ")}`;
    if (process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST === "1") throw new Error(message);
    t.skip(message);
    return;
  }
  assert.equal(expectedVersion, EXPECTED_PI_VERSION,
    "the CI smoke must request the exact Pi version under test");

  const packageInfo = JSON.parse(await readFile(join(agentRoot!, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  assert.equal(packageInfo.name, "@earendil-works/pi-coding-agent");
  assert.equal(packageInfo.version, EXPECTED_PI_VERSION,
    "the installed Pi package itself must be exactly 1.4.0");
  const runnerTemp = process.env.RUNNER_TEMP || tmpdir();
  const sandbox = await mkdtemp(join(runnerTemp, "prg-installed-pi-smoke-"));
  let preserveSandboxForDiagnosis = false;
  try {
    await mkdir(join(sandbox, "home"), { recursive: true });
    await mkdir(join(sandbox, "tmp"), { recursive: true });
    const directEnv = isolatedCommandEnvironment(
      [runtimeBin!], sandbox, runtimeBin!, agentRoot!, candidateEntry!,
    );
    const versionSpec = resolveInstalledPi(["--version"], directEnv);
    assertResolvedEntry(versionSpec, nativeBin!, ["--version"], "fresh npm-installed Pi command");
    const versionOutput = await runVersionCommand(versionSpec, directEnv, sandbox);
    assert.match(versionOutput, /^(?:pi(?: version)?\s+)?1\.4\.0$/i,
      `the actual installed pi command must report exact ${EXPECTED_PI_VERSION}, got ${JSON.stringify(versionOutput)}`);
    t.diagnostic(`fresh locked npm install: actual pi command reported ${versionOutput}`);
    if (process.platform === "win32") {
      t.diagnostic(`isolated host lookup (diagnostic only): ${windowsHostLookupDiagnostic(directEnv, sandbox, [sandbox])}`);
    }

    await runRegistrationSmoke(sandbox, "direct", directEnv, candidateEntry!, nativeBin!, false);

    // Separate from npm's generated pi.cmd, generate a representative two-line
    // managed-style command wrapper around the same REAL installed Pi runtime.
    // This validates wrapper ancestry and the resolver's forwarding shape; it
    // is not an official installer or a true managed installation.
    const wrapperRoot = join(sandbox, "managed-style-wrapper");
    const wrapperBin = join(wrapperRoot, "bin");
    await mkdir(wrapperBin, { recursive: true });
    const wrapperEntry = join(wrapperBin, "pi-launcher.js");
    await writeFile(wrapperEntry, wrapperEntrySource(), "utf8");
    const wrapperPath = join(wrapperBin, process.platform === "win32" ? "pi.cmd" : "pi");
    if (process.platform === "win32") {
      await writeFile(wrapperPath, '@ECHO off\r\nnode "%~dp0pi-launcher.js" %*\r\n', "utf8");
    } else {
      await writeFile(wrapperPath, '#!/bin/sh\nexec node "$(dirname "$0")/pi-launcher.js" "$@"\n', "utf8");
      await chmod(wrapperPath, 0o755);
    }
    const wrapperEnv = isolatedCommandEnvironment(
      [wrapperBin, runtimeBin!], sandbox, runtimeBin!, agentRoot!, candidateEntry!,
    );
    wrapperEnv.PRG_INSTALLED_PI_CLI = cliEntry;
    await runRegistrationSmoke(
      sandbox, "managed-style-wrapper", wrapperEnv, candidateEntry!, wrapperPath, true,
    );
    t.diagnostic("generated managed-style two-line wrapper: real Pi RPC, candidate registration, and wrapper-parent ancestry passed");
  } catch (error) {
    preserveSandboxForDiagnosis = error instanceof ProcessTreeCleanupError;
    throw error;
  } finally {
    if (!preserveSandboxForDiagnosis) await rm(sandbox, { recursive: true, force: true });
  }
});

test("owned process-tree cleanup kills a wrapper and descendant that ignore stdin closure", { timeout: 45_000 }, async () => {
  const scratch = process.env.RUNNER_TEMP || tmpdir();
  const sandbox = await mkdtemp(join(scratch, "prg-process-tree-cleanup-"));
  const descendantPath = join(sandbox, "ignore-stdin.cjs");
  const wrapperPath = join(sandbox, "wrapper.cjs");
  const pidFile = join(sandbox, "owned-pids.json");
  let owned: ChildProcess | undefined;
  let pids: { wrapper: number; descendant: number } | undefined;
  let treeCleanupComplete = false;

  try {
    try {
      await writeFile(descendantPath, [
        "process.stdin.on('end', () => {});",
        "process.stdin.resume();",
        "setInterval(() => {}, 1_000);",
      ].join("\n"), "utf8");
      await writeFile(wrapperPath, [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, [process.argv[3]], { stdio: 'inherit', shell: false });",
        "fs.writeFileSync(process.argv[2], JSON.stringify({ wrapper: process.pid, descendant: child.pid }));",
        "setInterval(() => {}, 1_000);",
      ].join("\n"), "utf8");
      owned = trackChild(spawn(process.execPath, [wrapperPath, pidFile, descendantPath], {
        cwd: sandbox,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "ignore", "ignore"],
      }));
      assert.ok(owned.pid, "the test-owned wrapper must start with a PID");

      const deadline = Date.now() + 5_000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.ok(existsSync(pidFile), "the wrapper must start and record its descendant PID");
      pids = JSON.parse(await readFile(pidFile, "utf8")) as { wrapper: number; descendant: number };
      assert.ok(Number.isInteger(pids.wrapper) && pids.wrapper > 0);
      assert.ok(Number.isInteger(pids.descendant) && pids.descendant > 0);
      assert.notEqual(pids.wrapper, pids.descendant);
      assert.ok(processIsAlive(pids.wrapper), "the wrapper must be alive before tree cleanup");
      assert.ok(processIsAlive(pids.descendant), "the descendant must be alive before tree cleanup");

      // EOF is intentionally insufficient: the descendant's handler keeps its
      // event loop alive, leaving the wrapper and inherited pipe open.
      owned.stdin?.end();
      await new Promise((done) => setTimeout(done, 150));
      assert.ok(processIsAlive(pids.wrapper), "stdin closure alone must not stop the wrapper fixture");
      assert.ok(processIsAlive(pids.descendant), "stdin closure alone must not stop the descendant fixture");
    } finally {
      if (owned) {
        await terminateOwnedProcessTree(owned);
        treeCleanupComplete = true;
      }
    }

    assert.ok(pids, "the process tree fixture must have reported both owned PIDs");
    assert.equal(await waitForProcessExit(pids.wrapper, TREE_KILL_TIMEOUT_MS), true,
      "tree cleanup must terminate the wrapper process");
    assert.equal(await waitForProcessExit(pids.descendant, TREE_KILL_TIMEOUT_MS), true,
      "tree cleanup must terminate the wrapper's descendant process");
  } finally {
    const knownDescendantsStopped = !pids || (!processIsAlive(pids.wrapper) && !processIsAlive(pids.descendant));
    if ((!owned || treeCleanupComplete) && knownDescendantsStopped) {
      await rm(sandbox, { recursive: true, force: true });
    }
  }
});

test("RPC startup failures keep the platform deadline and attach bounded sanitized startup evidence", { timeout: 30_000 }, async () => {
  assert.equal(RPC_TIMEOUT_MS, process.platform === "win32" ? 90_000 : 30_000,
    "the installed smoke allows 90s on Windows and retains 30s elsewhere");
  const scratch = process.env.RUNNER_TEMP || tmpdir();
  const sandbox = await mkdtemp(join(scratch, "prg-rpc-startup-diagnostics-"));
  const tracePath = join(sandbox, "startup-trace.jsonl");
  const fakePi = join(sandbox, "fake-pi.cjs");
  const token = `ghp_${"A".repeat(36)}`;
  let child: ChildProcess | undefined;
  try {
    const started = Date.now();
    await writeFile(tracePath, [
      JSON.stringify({ role: "before-candidate", phase: "loaded", at: started }),
      JSON.stringify({ role: "before-candidate", phase: "session_start", at: started + 5 }),
      "{\"role\":\"after-candidate\",\"pha", // truncated marker is tolerated
    ].join("\n"), "utf8");
    // A startup that emits one UI event and stderr, then never answers RPC.
    await writeFile(fakePi, [
      "const sandbox = process.argv[2];",
      "process.stdout.write(JSON.stringify({ type: 'extension_ui_request', path: sandbox + '/agent' }) + '\\n');",
      "process.stdout.write('not json ' + JSON.stringify(sandbox) + '\\n');",
      "process.stderr.write('x'.repeat(10000) + '\\n');",
      // The credential, path, and ANSI sequence sit inside the retained tail.
      `process.stderr.write('\\u001b[31mwarn\\u001b[0m ' + sandbox + ' token=${token}\\nlast-stderr-line\\n');`,
      "process.stdin.resume();",
      "setInterval(() => {}, 1000);",
    ].join("\n"), "utf8");
    child = trackChild(spawn(process.execPath, [fakePi, sandbox], {
      cwd: sandbox,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }));
    const rpc = driveRpc(child, { timeoutMs: 1_500, tracePath, redactRoots: [sandbox] });
    const error = await rpc.request("get_state", {}).then(
      () => assert.fail("a never-answering startup must not resolve"),
      (rejection: unknown) => rejection as Error,
    );
    const message = error.message;
    assert.match(message, /^installed Pi RPC get_state timed out after 1500ms\n/,
      "the timeout identity and deadline stay first and unchanged");
    assert.match(message, /elapsed since spawn: \d+ms; child pid \d+ still running/);
    assert.match(message, /stdout: 2 line\(s\); first \+\d+ms; last \+\d+ms; event types: extension_ui_requestx1/);
    assert.match(message, /startup markers \(before-candidate trace, after-candidate probe\): before-candidate:loaded@[+-]\d+ms, before-candidate:session_start@[+-]\d+ms$/m);
    assert.match(message, /stderr: \d+ char\(s\) total; tail:/);
    assert.match(message, /last-stderr-line/);
    assert.ok(!message.includes(sandbox), "owned fixture paths must be replaced by placeholders");
    assert.ok(!message.includes(JSON.stringify(sandbox).slice(1, -1)), "JSON-escaped fixture paths must be replaced too");
    assert.ok(message.includes("<fixture>"));
    assert.match(message, /warn <fixture> token=\[REDACTED\]/,
      "the retained stderr tail must carry the redacted credential, not drop it");
    assert.ok(!message.includes(token), "credential-shaped values must be redacted");
    assert.ok(!message.includes("\u001b"), "terminal control sequences must be stripped");
    assert.ok(message.length < DIAGNOSTIC_STDERR_TAIL_CHARS + DIAGNOSTIC_STDOUT_TAIL_LINES * (DIAGNOSTIC_LINE_CHARS + 32) + 2_000,
      "failure evidence must stay bounded");
    await rpc.close();
  } finally {
    // A cleanup failure throws before rm, preserving the sandbox for diagnosis.
    if (child) await terminateOwnedProcessTree(child);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an RPC child that exits before answering reports only bounded, sanitized evidence", { timeout: 30_000 }, async () => {
  const scratch = process.env.RUNNER_TEMP || tmpdir();
  const sandbox = await mkdtemp(join(scratch, "prg-rpc-startup-exit-"));
  const fakePi = join(sandbox, "exiting-pi.cjs");
  const token = `ghp_${"B".repeat(36)}`;
  let child: ChildProcess | undefined;
  try {
    // Large stdout/stderr volume, then a fixture path, ANSI sequence, and
    // credential inside the retained tails, then a nonzero exit.
    await writeFile(fakePi, [
      "const sandbox = process.argv[2];",
      "process.stdout.write(('y'.repeat(5000) + '\\n').repeat(30));",
      "process.stdout.write(JSON.stringify({ type: 'extension_ui_request', path: sandbox, note: 'token=" + token + "' }) + '\\n');",
      "process.stderr.write('z'.repeat(20000) + '\\n');",
      "process.stderr.write('\\u001b[31mboom\\u001b[0m ' + sandbox + ' token=" + token + "\\n', () => process.exit(7));",
    ].join("\n"), "utf8");
    child = trackChild(spawn(process.execPath, [fakePi, sandbox], {
      cwd: sandbox,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }));
    const rpc = driveRpc(child, { tracePath: join(sandbox, "absent-trace.jsonl"), redactRoots: [sandbox] });
    const error = await rpc.request("get_state", {}).then(
      () => assert.fail("an exited child must not answer"),
      (rejection: unknown) => rejection as Error,
    );
    const message = error.message;
    // The request is written synchronously after spawn, before the child can
    // exit, so the close handler (not the deadline) must fail it.
    assert.match(message, /^installed Pi exited before RPC completed \(7\):\ninstalled Pi startup diagnostics \(sanitized, bounded\):\n/,
      "the exit prefix is followed directly by the formatter, never raw output");
    assert.match(message, /exited 7 at \+\d+ms/);
    assert.match(message, /startup markers \(before-candidate trace, after-candidate probe\): no marker written/);
    assert.match(message, /boom <fixture> token=\[REDACTED\]/);
    assert.ok(!message.includes(sandbox), "owned fixture paths must be replaced by placeholders");
    assert.ok(!message.includes(token), "credential-shaped values must be redacted");
    assert.ok(!message.includes("\u001b"), "terminal control sequences must be stripped");
    assert.ok(!message.includes("y".repeat(DIAGNOSTIC_LINE_CHARS + 1)), "each stdout tail line is truncated");
    assert.ok(!message.includes("z".repeat(DIAGNOSTIC_STDERR_TAIL_CHARS + 1)), "the stderr tail is bounded");
    assert.ok(message.length < DIAGNOSTIC_STDERR_TAIL_CHARS + DIAGNOSTIC_STDOUT_TAIL_LINES * (DIAGNOSTIC_LINE_CHARS + 32) + 2_000,
      "the entire early-exit failure must stay bounded");
  } finally {
    // A cleanup failure throws before rm, preserving the sandbox for diagnosis.
    if (child) await terminateOwnedProcessTree(child);
    await rm(sandbox, { recursive: true, force: true });
  }
});
