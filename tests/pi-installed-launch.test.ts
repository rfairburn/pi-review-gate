import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolvePiChildSpawn } from "../src/pi-invocation";

const EXPECTED_PI_VERSION = "1.0.4";
const RPC_TIMEOUT_MS = 30_000;
const CHILD_CLOSE_TIMEOUT_MS = 2_000;
const TREE_TERM_GRACE_MS = 1_500;
const TREE_KILL_TIMEOUT_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 10_000;

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
  close(): Promise<void>;
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

function driveRpc(child: ChildProcess): RpcClient {
  let nextId = 1;
  let buffer = "";
  let closed = false;
  const lines: string[] = [];
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
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
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
  });
  child.once("error", (error) => failPending(new Error(`installed Pi failed to start: ${error.message}`)));
  child.once("close", (code, signal) => {
    closed = true;
    if (pending.size) {
      failPending(new Error(`installed Pi exited before RPC completed (${code ?? signal}):\n${lines.slice(-20).join("\n")}`));
    }
  });

  return {
    lines,
    request: (type, fields = {}) => new Promise((resolvePromise, reject) => {
      if (closed) {
        reject(new Error(`installed Pi exited before RPC ${type}`));
        return;
      }
      const id = `prg-installed-${nextId++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`installed Pi RPC ${type} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
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
  const args = [
    "--mode", "rpc",
    "--session-dir", sessionsDir,
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
  return { rpc: driveRpc(child), child, probeResult };
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
    assert.equal(state.success, true, `installed Pi get_state must succeed: ${rpc.lines.slice(-20).join("\n")}`);

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
    assert.ok(existsSync(probeResult), `the probe command did not run: ${rpc.lines.slice(-20).join("\n")}`);
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

test("fresh Pi 1.0.4 install launches through the resolver and registers the candidate without a provider call", { timeout: 180_000 }, async (t) => {
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
    "the installed Pi package itself must be exactly 1.0.4");
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
    assert.match(versionOutput, /^(?:pi(?: version)?\s+)?1\.0\.4$/i,
      `the actual installed pi command must report exact ${EXPECTED_PI_VERSION}, got ${JSON.stringify(versionOutput)}`);
    t.diagnostic(`fresh locked npm install: actual pi command reported ${versionOutput}`);

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
