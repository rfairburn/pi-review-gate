import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./helpers/expect";

const POSIX_ONLY = { skip: process.platform === "win32" };
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

interface RecordLine {
  type: string;
  [key: string]: unknown;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface SignalChild {
  child: ChildProcess;
  marker: string;
  records: RecordLine[];
  stderr: string;
  groupPid?: number;
  exit: Promise<ChildExit>;
  closed?: ChildExit;
}

const CHILD_SCRIPT = String.raw`
const { registerBackgroundShell } = require(process.env.PRG_SIGNAL_GATE_MODULE);
const fs = require('node:fs');
const tools = Object.create(null);
const hooks = new Map();
const emit = (type, fields = {}) => fs.writeSync(1, JSON.stringify({ type, ...fields }) + '\n');
const pi = {
  registerTool(tool) { tools[tool.name] = tool; },
  on(name, handler) {
    const list = hooks.get(name) || [];
    list.push(handler);
    hooks.set(name, list);
  },
  sendMessage() {},
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scenario = process.env.PRG_SIGNAL_SCENARIO;

async function main() {
  if (scenario === 'foreign-handler') {
    let calls = 0;
    // Simulate the native host's independently installed asynchronous handler.
    // It owns session shutdown; the production observer must neither remove nor
    // redispatch this listener.
    process.on('SIGTERM', () => {
      calls += 1;
      emit('foreign-signal', { calls });
      if (calls !== 1) return;
      setTimeout(async () => {
        emit('session-shutdown-start', {});
        for (const handler of hooks.get('session_shutdown') || []) await handler();
        emit('session-shutdown-complete', {});
      }, 150);
    });
  }

  registerBackgroundShell(pi);
  if (scenario === 'default-signal') {
    // A second independent public observer must coexist with the production
    // observer and still let the original default signal disposition apply.
    const { onExit } = require('signal-exit');
    onExit((code, signal) => emit('additional-exit-observer', { code, signal }));
  }

  const command =
    '"$PRG_BG_SIGNAL_NODE_BIN" -e ' +
    '\'process.on("SIGTERM",()=>{require("node:fs").writeFileSync(process.env.PRG_BG_SIGNAL_MARKER,"caught");process.exit(0)});' +
    'console.log("JOB_READY");setInterval(()=>{},1000)\'';
  const started = await tools.ShellStart.execute('signal-test', { command, label: 'signal-owned-job' });
  if (started.isError) throw new Error(started.content?.[0]?.text || 'ShellStart failed');
  const jobId = started.details.id;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const log = await tools.ShellLog.execute('signal-test-log', { id: jobId, lines: 20 });
    if (log.content?.[0]?.text?.includes('JOB_READY')) {
      emit('ready', { groupPid: started.details.processGroupId, jobId });
      return;
    }
    await delay(25);
  }
  throw new Error('owned shell job did not become ready before its deadline');
}

main().catch((error) => {
  emit('child-error', { message: String(error && error.stack || error) });
  process.exitCode = 1;
});
`;

function makeChild(root: string, scenario: "foreign-handler" | "default-signal"): SignalChild {
  const marker = join(root, "job-term-observed");
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRG_SIGNAL_GATE_MODULE: require.resolve("../src/background-shell"),
      PRG_SIGNAL_SCENARIO: scenario,
      PRG_BG_SIGNAL_MARKER: marker,
      PRG_BG_SIGNAL_NODE_BIN: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state: SignalChild = {
    child,
    marker,
    records: [],
    stderr: "",
    exit: new Promise<ChildExit>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        state.closed = { code, signal };
        resolve(state.closed);
      });
    }),
  };
  let pending = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const record = JSON.parse(line) as RecordLine;
        state.records.push(record);
        if (record.type === "ready" && typeof record.groupPid === "number") {
          state.groupPid = record.groupPid;
        }
      } catch {
        state.records.push({ type: "invalid-output", line });
      }
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    state.stderr = (state.stderr + chunk).slice(-4000);
  });
  return state;
}

async function waitForRecord(
  state: SignalChild,
  predicate: (record: RecordLine) => boolean,
  timeoutMs: number,
  description: string,
): Promise<RecordLine> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = state.records.find(predicate);
    if (found) return found;
    const childError = state.records.find((record) => record.type === "child-error");
    if (childError) throw new Error(`${description}: ${String(childError.message)}\n${state.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${description} timed out\n${state.stderr}`);
}

async function waitForMarker(state: SignalChild, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(state.marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "the owned job did not observe the synchronous signal cleanup request before its watchdog deadline; " +
      `group=${state.groupPid}; records=${JSON.stringify(state.records)}; stderr=${state.stderr}`,
  );
}

async function waitForClose(state: SignalChild, timeoutMs: number): Promise<ChildExit> {
  if (state.closed) return state.closed;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      state.exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("isolated signal child did not exit before its deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function groupIsAlive(groupPid: number): boolean {
  try {
    process.kill(-groupPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForGroupExit(groupPid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupIsAlive(groupPid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !groupIsAlive(groupPid);
}

async function cleanupChild(state: SignalChild): Promise<void> {
  if (!state.closed) {
    try { state.child.kill("SIGTERM"); } catch { /* only this test-owned child handle */ }
    try {
      await waitForClose(state, 1500);
    } catch {
      // The group id came from this child's real ShellStart result; never scan
      // for or signal any process not created by this fixture.
      if (state.groupPid) {
        try { process.kill(-state.groupPid, "SIGKILL"); } catch { /* its group may already be gone */ }
      }
      try { state.child.kill("SIGKILL"); } catch { /* bounded escalation to the owned child handle */ }
      await waitForClose(state, 3000);
    }
  }
  if (state.groupPid && groupIsAlive(state.groupPid)) {
    try { process.kill(-state.groupPid, "SIGTERM"); } catch { /* the exact owned group may have exited */ }
    if (!(await waitForGroupExit(state.groupPid, 1000))) {
      try { process.kill(-state.groupPid, "SIGKILL"); } catch { /* bounded escalation to the exact owned group */ }
      if (!(await waitForGroupExit(state.groupPid, 2000))) {
        throw new Error(`test-owned background process group ${state.groupPid} did not exit after bounded cleanup`);
      }
    }
  }
}

async function withSignalChild(
  scenario: "foreign-handler" | "default-signal",
  run: (state: SignalChild) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(process.cwd(), ".background-shell-signal-"));
  const state = makeChild(root, scenario);
  try {
    await waitForRecord(state, (record) => record.type === "ready", 10_000, "signal child readiness");
    if (!state.groupPid) throw new Error("ShellStart did not report its owned POSIX process group");
    await run(state);
  } finally {
    try {
      await cleanupChild(state);
    } finally {
      if (existsSync(state.marker)) unlinkSync(state.marker);
      rmdirSync(root);
    }
  }
}

function countRecords(state: SignalChild, type: string): number {
  return state.records.filter((record) => record.type === type).length;
}

describe("background-shell signal-exit integration", () => {
  it("preserves an asynchronous foreign SIGTERM handler and its orderly shutdown", POSIX_ONLY, async () => {
    await withSignalChild("foreign-handler", async (state) => {
      expect(state.child.kill("SIGTERM")).toBe(true);
      const exit = await waitForClose(state, 8000);
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();
      expect(countRecords(state, "foreign-signal")).toBe(1);
      expect(countRecords(state, "session-shutdown-start")).toBe(1);
      expect(countRecords(state, "session-shutdown-complete")).toBe(1);
      await waitForMarker(state);
      expect(readFileSync(state.marker, "utf8")).toBe("caught");
    });
  });

  for (const signal of SIGNALS) {
    it(`keeps default ${signal} termination with an additional public observer`, POSIX_ONLY, async () => {
      await withSignalChild("default-signal", async (state) => {
        expect(state.child.kill(signal)).toBe(true);
        const exit = await waitForClose(state, 8000);
        expect(exit.code).toBeNull();
        expect(exit.signal).toBe(signal);
        const observers = state.records.filter((record) => record.type === "additional-exit-observer");
        expect(observers.length).toBe(1);
        expect(observers[0]).toMatchObject({ signal });
        await waitForMarker(state);
        expect(readFileSync(state.marker, "utf8")).toBe("caught");
      });
    });
  }
});
