/**
 * Issue #533 — installed-native synthetic proof.
 *
 * Runs the INSTALLED Pi CLI inside a fully owned sandbox: private HOME, private
 * `PI_CODING_AGENT_DIR`, private temp, no inherited gate wiring, no provider
 * credential and no network. Identity/location cases send no prompt at all:
 * every fact comes from `get_state`, the session file Pi itself writes, and the
 * reference the gate-owned reporter records. The turn cases prompt an OWNED
 * scripted local provider on loopback — no credential, no upstream — so real
 * tool calls, usage, continuation, and compaction records are inspected in the
 * native transcript the changed adapters actually produce.
 *
 * Proven against the real Pi 1.4 CLI:
 * 1. A launched session resolves to Pi's OWN standard store under the sandbox
 *    agent dir (no `--session-dir` is passed anywhere), and the reporter records
 *    exactly one canonical `{ id, file, cwd }` reference with absolute paths.
 * 2. Reopening the recorded ABSOLUTE `--session` path returns that same session
 *    id and the same session file — the exact continuation the gate performs.
 * 3. Re-passing a bare `--session-id` from a DIFFERENT workspace resolves a
 *    DIFFERENT session file: Pi silently opens a second, empty same-id session.
 *    That is the loss this design refuses, and the gate-side resolver refuses it.
 * 4. Through the real executor adapter: a scripted tool call and its usage are
 *    recorded in the referenced native transcript; the exact-path continuation
 *    and an interrupted-compaction recovery keep appending to THAT SAME file
 *    with the earlier tool call, tool result, and usage records intact.
 * 5. Through the real reviewer adapter: a JSON `--print` pass completes and the
 *    gate-owned reporter records exactly one canonical reference, while the
 *    mutable transcript stays in the native store and never enters the bundle.
 *
 * The case skips when no installed Pi is available (same prerequisite
 * convention as the other real-Pi checks).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { terminateProcessTree } from "../src/adapters/process";
import { PiExecutorAdapter } from "../src/execution/adapters/pi-model";
import { PiModelAdapter } from "../src/adapters/pi-model";
import {
  PI_SESSION_REFERENCE_DIRNAME,
  piSessionReferencePath,
  readPiSessionReference,
  resolveVerifiedPiSessionFile,
  verifyPiSessionReference,
  writePiSessionReference,
} from "../src/pi-session-reference";
import type { ExecutorTurn } from "../src/execution/types";
import { PI_SESSION_REFERENCE_ENV } from "../src/pi-session-reference-reporter";
import { findInstalledAgentDirs } from "./menu-tui-fakes";

/** Compiled reporter used at runtime; source form when the package is unbuilt. */
const COMPILED_REPORTER = resolve(__dirname, "..", "..", "dist", "src", "pi-session-reference-reporter.js");
const SOURCE_REPORTER = resolve(__dirname, "..", "..", "src", "pi-session-reference-reporter.ts");
const RUNNER_ROOT = resolve(__dirname, "..", "..");
const RPC_TIMEOUT_MS = 30_000;
const CLOSE_WAIT_MS = 5_000;

function reporterForChild(): string {
  return existsSync(COMPILED_REPORTER) ? COMPILED_REPORTER : SOURCE_REPORTER;
}

/** Env for a disposable installed-Pi run: owned locations, nothing inherited. */
function sandboxEnv(home: string, agentDir: string, temp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    // No gate wiring, no ambient Pi store, and no provider credential may reach
    // the disposable session.
    if (key.startsWith("PI_REVIEW_GATE_") || key.startsWith("PI_CODING_AGENT") || /(^|_)(API_KEY|TOKEN|SECRET|CREDENTIAL)S?$/.test(key)) {
      delete env[key];
    }
  }
  // The scripted provider is loopback-only; an inherited proxy would send the
  // request somewhere else entirely.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
  env.HOME = home;
  env.USERPROFILE = home;
  env.TMPDIR = temp;
  env.TMP = temp;
  env.TEMP = temp;
  env.PI_CODING_AGENT_DIR = agentDir;
  return env;
}

function locateInstalledPi(): { cliEntry: string } | { bin: string } | undefined {
  for (const agentDir of findInstalledAgentDirs()) {
    const cliEntry = join(agentDir, "dist", "bundle", "cli.js");
    if (existsSync(cliEntry)) return { cliEntry };
  }
  // This existing test pin names an executable DIRECTORY, not the command.
  const binDir = process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN;
  if (!binDir) return undefined;
  const bin = join(binDir, process.platform === "win32" ? "pi.cmd" : "pi");
  return existsSync(bin) ? { bin } : undefined;
}

/**
 * Absolute path with every existing component resolved (so `/var` and
 * `/private/var` compare equal) while still naming a file that does not exist
 * yet — Pi creates a session file only once it has something to persist.
 */
function canonicalPath(path: string): string {
  const missing: string[] = [];
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...missing);
}

const samePath = (left: string, right: string): boolean => canonicalPath(left) === canonicalPath(right);

function canonicalize(cwd: string, reported: string): string {
  return isAbsolute(reported) ? resolve(reported) : resolve(cwd, reported);
}

interface RpcExchange {
  request: (type: string, fields?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
  lines: string[];
}

function driveRpc(child: ChildProcess): RpcExchange {
  let nextId = 1;
  let buffer = "";
  let closed = false;
  const lines: string[] = [];
  const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let announceClose!: () => void;
  const closeEvent = new Promise<void>((resolvePromise) => { announceClose = resolvePromise; });
  child.once("close", () => { closed = true; announceClose(); });
  child.stdin?.on("error", () => { /* racing EPIPE after exit */ });
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
      if (event.type === "response" && typeof event.id === "string") {
        const waiter = pending.get(event.id);
        if (!waiter) continue;
        pending.delete(event.id);
        if (event.success === true) waiter.resolve(event);
        else waiter.reject(new Error(typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? {})));
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { lines.push(`[stderr] ${chunk}`); });
  const waitForClose = (timeoutMs: number): Promise<boolean> => {
    if (closed) return Promise.resolve(true);
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), timeoutMs);
      void closeEvent.then(() => { clearTimeout(timer); resolvePromise(true); });
    });
  };
  let closing: Promise<void> | undefined;
  return {
    lines,
    request: (type, fields = {}) => new Promise((resolvePromise, reject) => {
      const id = `prg-533-${nextId++}`;
      pending.set(id, { resolve: resolvePromise, reject });
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC ${type} timed out; output so far:\n${lines.slice(-25).join("\n")}`));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    }),
    close: () => {
      if (closing) return closing;
      closing = (async () => {
        try { child.stdin?.end(); } catch { /* already closed */ }
        if (closed) return;
        const firstError = terminateProcessTree(child, "SIGTERM");
        if (await waitForClose(CLOSE_WAIT_MS)) return;
        const escalationError = terminateProcessTree(child, "SIGKILL");
        if (await waitForClose(CLOSE_WAIT_MS)) return;
        throw new Error(`Pi RPC child did not close${firstError || escalationError ? `: ${escalationError ?? firstError}` : ""}`);
      })();
      return closing;
    },
  };
}

function launchRpc(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  target: { cliEntry: string } | { bin: string },
): ChildProcess {
  const [file, prefix] = "cliEntry" in target ? [process.execPath, [target.cliEntry]] : [target.bin, [] as string[]];
  return spawn(file, [...prefix, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
}

/** One disposable `get_state` exchange; returns the authoritative state payload. */
async function readState(args: string[], env: NodeJS.ProcessEnv, cwd: string, target: { cliEntry: string } | { bin: string }): Promise<Record<string, unknown>> {
  const child = launchRpc(args, env, cwd, target);
  const rpc = driveRpc(child);
  try {
    const response = await rpc.request("get_state", {});
    return typeof response.data === "object" && response.data !== null ? response.data as Record<string, unknown> : {};
  } catch (error) {
    assert.fail(`the disposable Pi session ${JSON.stringify(args)} could not report state: ${String(error)}\n${rpc.lines.slice(-25).join("\n")}`);
  } finally {
    await rpc.close();
  }
}

async function writeSandboxConfig(agentDir: string): Promise<void> {
  // The launcher's default configuration: no reviewers, no workers, and no
  // configured model or provider auth, so nothing here can reach a provider.
  await writeFile(join(agentDir, "review-gate.json"), JSON.stringify({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {},
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
  }, null, 2), "utf8");
}

interface Sandbox {
  root: string;
  agentDir: string;
  worktree: string;
  movedWorktree: string;
  artifactDir: string;
  env: NodeJS.ProcessEnv;
}

async function createSandbox(label: string): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), `prg-533-${label}-`));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const temp = join(root, "temp");
  const worktree = join(root, "worktree");
  const movedWorktree = join(root, "moved-worktree");
  const artifactDir = join(root, "artifact");
  for (const dir of [home, agentDir, temp, worktree, movedWorktree, artifactDir]) await mkdir(dir, { recursive: true });
  await writeSandboxConfig(agentDir);
  return { root, agentDir, worktree, movedWorktree, artifactDir, env: sandboxEnv(home, agentDir, temp) };
}

test("installed Pi: a launched session records one canonical reference in Pi's own standard store", async (t) => {
  const target = locateInstalledPi();
  if (!target) {
    t.skip("installed pi-coding-agent unavailable (PI_REVIEW_GATE_INSTALLED_PI_BIN or a global install)");
    return;
  }
  const sandbox = await createSandbox("launch");
  t.after(async () => { await rm(sandbox.root, { recursive: true, force: true }); });
  const sessionId = `prg533launch${Date.now().toString(36)}`;
  const referencePath = piSessionReferencePath(sandbox.artifactDir, sessionId);

  const args = ["--mode", "rpc", "--session-id", sessionId, "--extension", reporterForChild()];
  assert.ok(!args.includes("--session-dir"), "the gate never redirects the native session store per role");
  const state = await readState(args, { ...sandbox.env, [PI_SESSION_REFERENCE_ENV]: referencePath }, sandbox.worktree, target);

  assert.equal(state.sessionId, sessionId, "Pi opens the session id the launch requested");
  const reported = String(state.sessionFile ?? "");
  assert.ok(reported.length > 0, `get_state must report a session file, got ${JSON.stringify(state)}`);

  const reference = await readPiSessionReference(sandbox.artifactDir, sessionId);
  assert.ok(reference, `the reporter extension must record ${referencePath}`);
  assert.equal(reference.id, sessionId);
  assert.ok(isAbsolute(reference.file), `a recorded session file is absolute, got ${reference.file}`);
  assert.ok(isAbsolute(reference.cwd), `a recorded session cwd is absolute, got ${reference.cwd}`);
  // A relative `sessionFile` (relative effective sessionDir) is canonicalized
  // against the SESSION cwd, which is exactly what this comparison re-derives.
  assert.equal(canonicalPath(reference.file), canonicalPath(canonicalize(sandbox.worktree, reported)),
    "the reference names the native session file Pi actually opened");
  assert.ok(samePath(reference.cwd, sandbox.worktree), `the reference records the session workspace, got ${reference.cwd}`);

  // The transcript lives in Pi's OWN standard store under the sandbox agent dir:
  // no per-role redirection and nothing inside the gate's artifact directory.
  assert.ok(canonicalPath(reference.file).startsWith(join(canonicalPath(sandbox.agentDir), "sessions") + "/"),
    `the native transcript must resolve inside the disposable standard store, got ${reference.file}`);
  assert.ok(!canonicalPath(reference.file).startsWith(canonicalPath(sandbox.artifactDir)),
    "the gate never redirects the session store into its artifact directory");

  // Until Pi has persisted anything the file does not exist; the gate then
  // refuses to resume rather than guessing a path or searching the store.
  const unresolved = await resolveVerifiedPiSessionFile({
    ownerArtifactDir: sandbox.artifactDir,
    sessionId,
    cwd: sandbox.worktree,
  });
  if (!unresolved.ok) {
    assert.match(unresolved.message, /Native session reference|No canonical native session reference/);
  }
});

test("installed Pi: continuation reopens the exact recorded absolute session path", async (t) => {
  const target = locateInstalledPi();
  if (!target) {
    t.skip("installed pi-coding-agent unavailable (PI_REVIEW_GATE_INSTALLED_PI_BIN or a global install)");
    return;
  }
  const sandbox = await createSandbox("resume");
  t.after(async () => { await rm(sandbox.root, { recursive: true, force: true }); });
  const sessionId = "prg533resumable";
  const worktree = canonicalPath(sandbox.worktree);
  // A persisted native session in the disposable standard store, exactly what a
  // prior turn leaves behind: a regular JSONL file whose header carries id+cwd.
  const storeDir = join(sandbox.agentDir, "sessions", "--prg533-synthetic--");
  await mkdir(storeDir, { recursive: true });
  const sessionFile = join(storeDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  await writeFile(sessionFile, `${JSON.stringify({
    type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: worktree,
  })}\n`, "utf8");
  await writePiSessionReference(sandbox.artifactDir, { id: sessionId, file: sessionFile, cwd: worktree });

  const verified = verifyPiSessionReference({ id: sessionId, file: sessionFile, cwd: worktree });
  assert.equal(verified.ok, true, `the native header must verify: ${verified.ok ? "" : verified.message}`);
  const resolved = await resolveVerifiedPiSessionFile({ ownerArtifactDir: sandbox.artifactDir, sessionId, cwd: worktree });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.ok(isAbsolute(resolved.reference.file));

  const state = await readState(["--mode", "rpc", "--session", resolved.reference.file], sandbox.env, sandbox.worktree, target);
  assert.equal(state.sessionId, sessionId, "reopening the recorded path returns the recorded session id");
  assert.equal(canonicalPath(canonicalize(sandbox.worktree, String(state.sessionFile ?? ""))), canonicalPath(sessionFile),
    "reopening the recorded path returns the recorded session file");
});

test("installed Pi: a bare --session-id in a changed workspace is a different, empty session", async (t) => {
  const target = locateInstalledPi();
  if (!target) {
    t.skip("installed pi-coding-agent unavailable (PI_REVIEW_GATE_INSTALLED_PI_BIN or a global install)");
    return;
  }
  const sandbox = await createSandbox("hazard");
  t.after(async () => { await rm(sandbox.root, { recursive: true, force: true }); });
  const sessionId = `prg533hazard${Date.now().toString(36)}`;
  const worktree = canonicalPath(sandbox.worktree);

  // Where Pi's OWN cwd-scoped store puts this session (reported, not guessed).
  const fresh = await readState(["--mode", "rpc", "--session-id", sessionId], sandbox.env, sandbox.worktree, target);
  const sessionFile = canonicalPath(canonicalize(sandbox.worktree, String(fresh.sessionFile ?? "")));
  assert.ok(sessionFile.length > 0);
  // Persist what a real turn would have left behind, at that exact location.
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({
    type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: worktree,
  })}\n`, "utf8");
  await writePiSessionReference(sandbox.artifactDir, { id: sessionId, file: sessionFile, cwd: worktree });

  // From the ORIGINAL workspace the id resolves the recorded session…
  const here = await readState(["--mode", "rpc", "--session-id", sessionId], sandbox.env, sandbox.worktree, target);
  assert.equal(canonicalPath(canonicalize(sandbox.worktree, String(here.sessionFile ?? ""))), sessionFile,
    "a bare id resolves the recorded session only while the workspace still matches");

  // …but from a CHANGED workspace Pi reports the same id with a DIFFERENT file:
  // a second, empty session. Reusing a bare id is therefore never a resume.
  const there = await readState(["--mode", "rpc", "--session-id", sessionId], sandbox.env, sandbox.movedWorktree, target);
  assert.equal(there.sessionId, sessionId, "Pi reports the requested id even in the changed workspace");
  const thereFile = canonicalize(sandbox.movedWorktree, String(there.sessionFile ?? ""));
  assert.notEqual(canonicalPath(thereFile), sessionFile,
    "Pi answers a bare --session-id in a changed cwd with a second same-id session — the silent context loss this design refuses");

  // The gate refuses that resume instead of repointing the reference.
  const relocated = await resolveVerifiedPiSessionFile({
    ownerArtifactDir: sandbox.artifactDir,
    sessionId,
    cwd: canonicalPath(sandbox.movedWorktree),
  });
  assert.equal(relocated.ok, false);
  assert.match(relocated.ok ? "" : relocated.message, /workspace/);
  assert.equal((await readPiSessionReference(sandbox.artifactDir, sessionId))?.file, sessionFile,
    "a changed workspace never repoints the recorded reference");

  // The verified absolute path still reopens the recorded session from anywhere.
  const resolved = await resolveVerifiedPiSessionFile({ ownerArtifactDir: sandbox.artifactDir, sessionId, cwd: worktree });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const byPath = await readState(["--mode", "rpc", "--session", resolved.reference.file], sandbox.env, sandbox.movedWorktree, target);
  assert.equal(canonicalPath(canonicalize(sandbox.movedWorktree, String(byPath.sessionFile ?? ""))), sessionFile,
    "exact-path continuation is what survives a moved workspace");
});

test("the reviewer adapter derives the reporter extension from its own compiled directory", async () => {
  // The reviewer child loads `--extension <compiled file>`; a wrong derivation
  // would silently leave reviewer passes with no canonical reference.
  const adapterSource = await readFile(join(RUNNER_ROOT, "src", "adapters", "pi-model.ts"), "utf8");
  assert.match(adapterSource, /SESSION_REPORTER_EXTENSION\s*=\s*resolve\(__dirname,\s*"\.\.",\s*"pi-session-reference-reporter\.js"\)/);
  assert.ok(!/"--session-dir"/.test(adapterSource), "the reviewer never redirects the native session store");
  assert.match(adapterSource, /"--no-extensions"/, "reviewer extension discovery stays off");
});

// ---------------------------------------------------------------------------
// Installed-native turn proof with an OWNED scripted local provider
// ---------------------------------------------------------------------------

const SCRIPTED_PROVIDER = "prg533";
const SCRIPTED_MODEL = "scripted-1";
const SCRIPTED_MODEL_REF = `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL}`;
const SCRIPTED_FINAL_TEXT = "SCRIPTED-FINAL-ANSWER";
const SCRIPTED_REVIEW_MARKER = "PRG533-SCRIPTED-REVIEW";
const SCRIPTED_USAGE_TOTAL_TOKENS = 133;

interface ScriptedProvider {
  url: string;
  requests: () => number;
  close: () => Promise<void>;
}

/**
 * A loopback OpenAI-compatible endpoint owned by this test. It answers one tool
 * call, then plain text, so Pi executes a real tool and records real usage
 * without any credential or upstream.
 */
async function startScriptedProvider(): Promise<ScriptedProvider> {
  let requests = 0;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: "prg533", object: "chat.completion.chunk", created: 1, model: SCRIPTED_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: SCRIPTED_USAGE_TOTAL_TOKENS },
  });
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (piece) => { body += String(piece); });
    req.on("end", () => {
      requests += 1;
      if (!req.url?.includes("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (payload: unknown): void => { res.write(`data: ${JSON.stringify(payload)}\n\n`); };
      send(chunk({ role: "assistant", content: "" }));
      if (requests === 1) {
        send(chunk({ tool_calls: [{ index: 0, id: "prg533-call-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) } }] }, "tool_calls"));
      } else if (body.includes(SCRIPTED_REVIEW_MARKER)) {
        send(chunk({ content: JSON.stringify({ verdict: "pass", summary: "SCRIPTED REVIEW PASSED", guidance: "", findings: [] }) }, "stop"));
      } else {
        send(chunk({ content: SCRIPTED_FINAL_TEXT }, "stop"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    close: () => new Promise<void>((resolvePromise) => {
      server.closeAllConnections?.();
      server.close(() => resolvePromise());
    }),
  };
}

/** Register the scripted endpoint as Pi's only provider in the sandbox. */
async function writeScriptedProviderConfig(agentDir: string, url: string): Promise<void> {
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [SCRIPTED_PROVIDER]: {
        baseUrl: url,
        api: "openai-completions",
        apiKey: "scripted-local-key",
        models: [{
          id: SCRIPTED_MODEL,
          name: "Scripted local provider",
          reasoning: true,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
          contextWindow: 32_000,
          maxTokens: 2_048,
        }],
      },
    },
  }, null, 2), "utf8");
  // Force the explicit recovery command to compact this short synthetic history
  // rather than correctly reporting "nothing to compact" under native defaults.
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 0 },
  }), "utf8");
}

/** PATH-independent `pi` command that runs the installed CLI. */
async function writeInstalledPiShim(root: string, target: { cliEntry: string } | { bin: string }): Promise<string> {
  const bin = join(root, "scripted-bin");
  await mkdir(bin, { recursive: true });
  const shim = join(bin, "pi");
  const exec = "cliEntry" in target ? `"${process.execPath}" "${target.cliEntry}"` : `"${target.bin}"`;
  await writeFile(shim, `#!/usr/bin/env bash\nexec ${exec} "$@"\n`, "utf8");
  await chmod(shim, 0o755);
  return shim;
}

/** Adapters build the child env from `process.env`, so apply the sandbox there. */
async function withSandboxProcessEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of new Set([...Object.keys(process.env), ...Object.keys(env)])) {
    const wanted = env[key];
    if (process.env[key] !== wanted) {
      saved.set(key, process.env[key]);
      if (wanted === undefined) delete process.env[key];
      else process.env[key] = wanted;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

interface NativeUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface NativeRecord {
  type?: string;
  usage?: NativeUsage;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    content?: Array<{ type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }>;
    usage?: NativeUsage;
  };
}

async function nativeRecords(file: string): Promise<NativeRecord[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as NativeRecord);
}

const recordKey = (record: NativeRecord): string => `${record.type}|${record.message?.role ?? ""}`;

async function nativeStoreFiles(agentDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  await walk(join(agentDir, "sessions"));
  return found;
}

const executorToolCatalog = { allowedToolCatalog: ["read"], initialActiveTools: ["read"] };

// The changed adapters must retain REAL history: Pi's own tool execution and
// usage records, then keep appending to the same referenced transcript across
// the exact-path continuation and an interrupted-compaction recovery.
test("installed Pi: tool, usage, and compaction records stay in one referenced transcript across exact-path continuation", async (t) => {
  const target = locateInstalledPi();
  if (!target) {
    t.skip("installed pi-coding-agent unavailable (PI_REVIEW_GATE_INSTALLED_PI_BIN or a global install)");
    return;
  }
  const provider = await startScriptedProvider();
  t.after(() => provider.close());
  const sandbox = await createSandbox("turns");
  t.after(async () => { await rm(sandbox.root, { recursive: true, force: true }); });
  const shim = await writeInstalledPiShim(sandbox.root, target);
  await writeScriptedProviderConfig(sandbox.agentDir, provider.url);
  await writeFile(join(sandbox.worktree, "note.txt"), "NATIVE-TOOL-MARKER\n", "utf8");

  const turnObservations: Array<{ turn: ExecutorTurn; label: string }> = [];
  await withSandboxProcessEnv(sandbox.env, async () => {
    const adapter = new PiExecutorAdapter({
      command: shim,
      model: SCRIPTED_MODEL_REF,
      timeoutMs: 120_000,
      settlementTimeoutMs: 20_000,
    });
    const first = await adapter.run({
      cwd: sandbox.worktree,
      prompt: "read note.txt and report what it says",
      artifactDir: sandbox.artifactDir,
      turn: 1,
      executorToolCatalog,
    });
    turnObservations.push({ turn: first, label: "turn 1" });
    assert.equal(first.failure, undefined, `the scripted tool turn must complete: ${first.failure?.message ?? ""}`);
    assert.equal(first.text, SCRIPTED_FINAL_TEXT);
    assert.ok(provider.requests() >= 2, "the tool call and its follow-up are two real provider round trips");
    // #533: the turn reports IDENTITY only — the transcript path and workspace
    // live solely in this owner's canonical reference.
    assert.deepEqual(Object.keys(first.session).sort(), ["adapter", "id"],
      `a turn's session carries no duplicate path state: ${JSON.stringify(first.session)}`);

    // The canonical reference verifies against the native header it names.
    const reference = await readPiSessionReference(sandbox.artifactDir, first.session.id);
    assert.ok(reference, "the executor turn records exactly one canonical reference");
    assert.equal(reference.id, first.session.id);
    const verified = verifyPiSessionReference(reference, { cwd: canonicalPath(sandbox.worktree) });
    assert.equal(verified.ok, true, `the recorded transcript must verify: ${verified.ok ? "" : verified.message}`);

    const records = await nativeRecords(reference.file);
    const toolCall = records.find((record) => recordKey(record) === "message|assistant"
      && (record.message?.content ?? []).some((block) => block.type === "toolCall"));
    assert.ok(toolCall, `Pi must record the executed tool call: ${records.map(recordKey).join(", ")}`);
    assert.deepEqual(toolCall.message?.content?.find((block) => block.type === "toolCall")?.arguments, { path: "note.txt" });
    assert.equal(toolCall.message?.provider, SCRIPTED_PROVIDER);
    assert.equal(toolCall.message?.model, SCRIPTED_MODEL);
    assert.equal(toolCall.message?.usage?.input, 111);
    assert.equal(toolCall.message?.usage?.output, 22);
    assert.equal(toolCall.message?.usage?.totalTokens, SCRIPTED_USAGE_TOTAL_TOKENS,
      "the scripted provider usage is recorded verbatim in the native transcript");
    assert.ok((toolCall.message?.usage?.cost?.total ?? 0) > 0, "Pi's native cost record is retained");
    assert.ok(records.some((record) => recordKey(record) === "message|system"), "the native prompt/tool declaration is retained");
    assert.ok(records.some((record) => recordKey(record) === "message|user" && JSON.stringify(record.message?.content).includes("read note.txt")));
    const toolResult = records.find((record) => recordKey(record) === "message|toolResult");
    assert.ok(toolResult, "the tool result is recorded in the native transcript");
    assert.ok((toolResult.message?.content ?? []).some((block) => (block.text ?? "").includes("NATIVE-TOOL-MARKER")),
      "the real tool output is retained, not a stdout summary");

    // Exact-path continuation: same file, history retained and appended.
    const second = await adapter.run({
      cwd: sandbox.worktree,
      prompt: "second scripted turn",
      artifactDir: sandbox.artifactDir,
      turn: 2,
      session: first.session,
      executorToolCatalog,
    });
    turnObservations.push({ turn: second, label: "turn 2" });
    assert.equal(second.failure, undefined, `the exact-path continuation must complete: ${second.failure?.message ?? ""}`);
    // The continuation resolves the SAME transcript through the canonical
    // reference this owner recorded — never through a path copied onto the session.
    const resumedReference = await resolveVerifiedPiSessionFile({
      ownerArtifactDir: sandbox.artifactDir,
      sessionId: second.session.id,
      cwd: sandbox.worktree,
    });
    assert.equal(resumedReference.ok, true, `the continuation's session stays verifiable: ${resumedReference.ok ? "" : resumedReference.message}`);
    assert.ok(samePath(resumedReference.reference.file, reference.file),
      `continuation appends to the referenced transcript, got ${resumedReference.reference.file}`);
    const afterResume = await nativeRecords(reference.file);
    assert.ok(afterResume.some((record) => recordKey(record) === "message|assistant"
      && (record.message?.content ?? []).some((block) => block.type === "toolCall")),
      "the earlier tool call survives the continuation");
    assert.ok(afterResume.filter((record) => recordKey(record) === "message|user").length >= 2,
      "the continuation prompt is appended to the same history");

    // Interrupted-compaction recovery reopens the SAME absolute path.
    const third = await adapter.run({
      cwd: sandbox.worktree,
      prompt: "third scripted turn",
      artifactDir: sandbox.artifactDir,
      turn: 3,
      session: second.session,
      recovery: { kind: "compaction", compactBeforePrompt: true },
      executorToolCatalog,
    });
    turnObservations.push({ turn: third, label: "compaction recovery" });
    assert.equal(third.failure, undefined, `compaction recovery must complete: ${third.failure?.message ?? ""}`);
    const recoveredReference = await resolveVerifiedPiSessionFile({
      ownerArtifactDir: sandbox.artifactDir,
      sessionId: third.session.id,
      cwd: sandbox.worktree,
    });
    assert.equal(recoveredReference.ok, true, `compaction recovery keeps a verifiable session: ${recoveredReference.ok ? "" : recoveredReference.message}`);
    assert.ok(samePath(recoveredReference.reference.file, reference.file),
      `compaction recovery continues the same transcript, got ${recoveredReference.reference.file}`);
    const afterCompaction = await nativeRecords(reference.file);
    const compaction = afterCompaction.find((record) => record.type === "compaction");
    assert.ok(compaction, "native compaction is an appended record, not a summary replacing raw history");
    assert.ok((compaction.usage?.totalTokens ?? 0) >= SCRIPTED_USAGE_TOTAL_TOKENS, "native summary-generation usage is retained");
    assert.equal((compaction.usage?.totalTokens ?? 0) % SCRIPTED_USAGE_TOTAL_TOKENS, 0, "summary usage comes from the scripted provider calls");
    assert.ok((compaction.usage?.cost?.total ?? 0) > 0, "native compaction cost is retained");
    assert.ok(afterCompaction.some((record) => recordKey(record) === "message|toolResult"),
      "compaction never discards the recorded tool history from the transcript");
    assert.ok(afterCompaction.filter((record) => recordKey(record) === "message|user").length >= 3);
  });

  assert.equal(turnObservations.length, 3);
  // One session, one native file: no forked same-id transcript anywhere.
  const files = await nativeStoreFiles(sandbox.agentDir);
  assert.equal(files.length, 1, `exactly one native transcript must exist, got ${files.join(", ")}`);
  assert.ok(canonicalPath(files[0]).startsWith(join(canonicalPath(sandbox.agentDir), "sessions") + "/"),
    `the transcript lives in the disposable standard store, got ${files[0]}`);
  const references = await readdir(join(sandbox.artifactDir, PI_SESSION_REFERENCE_DIRNAME));
  assert.deepEqual(references, [`${turnObservations[0].turn.session.id}.json`],
    "one owner artifact, one canonical reference — never a per-turn duplicate");
});

// The reviewer stays a fresh JSON `--print` pass; its reporter records the
// reference while the mutable transcript never enters the bundle.
test("installed Pi: a completed JSON --print reviewer pass records one canonical reference and no transcript copy", async (t) => {
  const target = locateInstalledPi();
  if (!target) {
    t.skip("installed pi-coding-agent unavailable (PI_REVIEW_GATE_INSTALLED_PI_BIN or a global install)");
    return;
  }
  const provider = await startScriptedProvider();
  t.after(() => provider.close());
  const sandbox = await createSandbox("reviewer");
  t.after(async () => { await rm(sandbox.root, { recursive: true, force: true }); });
  await writeFile(join(sandbox.worktree, "note.txt"), "REVIEWER-NATIVE-TOOL-MARKER\n", "utf8");
  const shim = await writeInstalledPiShim(sandbox.root, target);
  await writeScriptedProviderConfig(sandbox.agentDir, provider.url);
  const bundleDir = join(sandbox.root, "reviewer-bundle");
  await mkdir(bundleDir, { recursive: true });

  let reported: { adapter: string; id: string } | undefined;
  const result = await withSandboxProcessEnv(sandbox.env, () => {
    const reviewer = new PiModelAdapter({
      id: "prg533-reviewer",
      adapter: "pi-model",
      model: SCRIPTED_MODEL_REF,
      command: shim,
      timeoutMs: 120_000,
    });
    return reviewer.run({
      id: "prg533-reviewer",
      cwd: sandbox.worktree,
      prompt: `${SCRIPTED_REVIEW_MARKER}: review this workspace`,
      bundleDir,
      timeoutMs: 120_000,
      onSession: (session) => { reported = session; },
    });
  });

  assert.equal(result.error, undefined, `the reviewer pass must complete: ${result.error ?? ""}`);
  assert.equal(result.verdict, "pass");
  assert.match(result.summary, /SCRIPTED REVIEW PASSED/);
  assert.ok(reported, "the reporter must hand back the pass identity");
  assert.deepEqual(Object.keys(reported).sort(), ["adapter", "id"],
    `a reviewer pass reports identity only, never a copied session path: ${JSON.stringify(reported)}`);
  // The transcript is locatable through exactly one place: this bundle's canonical
  // reference for the reported id.
  const reference = await readPiSessionReference(bundleDir, reported.id);
  assert.ok(reference, `the bundle must record the canonical reference for ${reported.id}`);
  const nativeFile = reference.file;
  const verified = verifyPiSessionReference(reference, { cwd: canonicalPath(sandbox.worktree) });
  assert.equal(verified.ok, true, `the reviewer reference must verify: ${verified.ok ? "" : verified.message}`);
  assert.ok(canonicalPath(nativeFile).startsWith(join(canonicalPath(sandbox.agentDir), "sessions") + "/"),
    `the reviewer transcript stays in the native standard store, got ${nativeFile}`);

  const recorded = await readdir(join(bundleDir, PI_SESSION_REFERENCE_DIRNAME));
  assert.deepEqual(recorded, [`${reported.id}.json`], "the reviewer bundle carries exactly its canonical reference");
  // The bundle keeps its own captures (raw stream, usage, result) — never the
  // mutable native transcript. The transcript's own name and header must not
  // appear anywhere inside it.
  const bundled = (await readdir(bundleDir, { recursive: true })).map(String);
  const nativeContent = await readFile(nativeFile, "utf8");
  assert.ok(!bundled.some((name) => name.endsWith(basename(nativeFile))),
    `the native transcript itself is never copied into the reviewer bundle, got ${bundled.join(", ")}`);
  for (const name of bundled.filter((entry) => entry.endsWith(".jsonl"))) {
    const content = await readFile(join(bundleDir, name), "utf8");
    assert.notEqual(content, nativeContent, `${name} must not be a copy of the mutable native transcript`);
  }
  const records = await nativeRecords(nativeFile);
  assert.ok(records.some((record) => recordKey(record) === "message|assistant"),
    "the completed response lives in the native transcript");
  const call = records.find((record) => recordKey(record) === "message|assistant"
    && record.message?.content?.some((block) => block.type === "toolCall"));
  assert.deepEqual(call?.message?.content?.find((block) => block.type === "toolCall")?.arguments, { path: "note.txt" });
  assert.equal(call?.message?.usage?.totalTokens, SCRIPTED_USAGE_TOTAL_TOKENS);
  assert.ok((call?.message?.usage?.cost?.total ?? 0) > 0);
  assert.ok(records.some((record) => recordKey(record) === "message|toolResult"
    && record.message?.content?.some((block) => (block.text ?? "").includes("REVIEWER-NATIVE-TOOL-MARKER"))),
  "the reviewer native history keeps its tool result as well as its final verdict");
});
