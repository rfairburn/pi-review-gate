import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  watch,
} from "node:fs";
import { basename, join } from "node:path";
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

interface MarkerObserver {
  wait(timeoutMs: number): Promise<string>;
  close(): void;
}

interface SignalChild {
  child: ChildProcess;
  marker: string;
  markerObserver: MarkerObserver;
  events: EventEmitter;
  records: RecordLine[];
  stderr: string;
  groupPid?: number;
  spawnError?: Error;
  streamError?: Error;
  stdoutClosed?: boolean;
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

function makeChild(
  root: string,
  scenario: "foreign-handler" | "default-signal",
  markerObserver: MarkerObserver,
): SignalChild {
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
  const events = new EventEmitter();
  const state: SignalChild = {
    child,
    marker,
    markerObserver,
    events,
    records: [],
    stderr: "",
    exit: new Promise<ChildExit>((resolve) => {
      child.once("close", (code, signal) => {
        state.closed = { code, signal };
        events.emit("closed");
        resolve(state.closed);
      });
    }),
  };
  let pending = "";
  const acceptLine = (line: string): void => {
    let record: RecordLine;
    try {
      record = JSON.parse(line) as RecordLine;
    } catch {
      record = { type: "invalid-output", line };
    }
    state.records.push(record);
    if (record.type === "ready" && typeof record.groupPid === "number") {
      state.groupPid = record.groupPid;
    }
    events.emit("record");
  };
  child.once("error", (error) => {
    state.spawnError = error;
    events.emit("child-error");
  });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      acceptLine(line);
    }
  });
  child.stdout!.on("error", (error) => {
    state.streamError = error;
    events.emit("stream-error");
  });
  child.stdout!.on("close", () => {
    state.stdoutClosed = true;
    events.emit("stdout-close");
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    state.stderr = (state.stderr + chunk).slice(-4000);
  });
  child.stderr!.on("error", (error) => {
    state.streamError = error;
    events.emit("stream-error");
  });
  return state;
}

function waitForRecord(
  state: SignalChild,
  predicate: (record: RecordLine) => boolean,
  timeoutMs: number,
  description: string,
): Promise<RecordLine> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const removeListeners = (): void => {
      state.events.off("record", inspect);
      state.events.off("closed", inspect);
      state.events.off("stdout-close", inspect);
      state.events.off("child-error", inspect);
      state.events.off("stream-error", inspect);
      if (timer) clearTimeout(timer);
    };
    const finish = (error?: Error, record?: RecordLine): void => {
      if (settled) return;
      settled = true;
      removeListeners();
      if (error) reject(error);
      else resolve(record!);
    };
    const inspect = (): void => {
      const found = state.records.find(predicate);
      if (found) {
        finish(undefined, found);
        return;
      }
      const childError = state.records.find((record) => record.type === "child-error");
      if (childError) {
        finish(new Error(`${description}: ${String(childError.message)}\n${state.stderr}`));
        return;
      }
      if (state.spawnError || state.streamError) {
        finish(new Error(
          `${description}: child I/O failed: ${String(state.spawnError ?? state.streamError)}\n${state.stderr}`,
        ));
        return;
      }
      if (state.stdoutClosed || state.closed) {
        finish(new Error(`${description}: stdout closed before the expected record\n${state.stderr}`));
      }
    };
    state.events.on("record", inspect);
    state.events.on("closed", inspect);
    state.events.on("stdout-close", inspect);
    state.events.on("child-error", inspect);
    state.events.on("stream-error", inspect);
    timer = setTimeout(() => {
      finish(new Error(
        `${description} timed out; records=${JSON.stringify(state.records)}\n${state.stderr}`,
      ));
    }, timeoutMs);
    inspect();
  });
}

function createMarkerObserver(root: string, marker: string): MarkerObserver {
  let watcher: ReturnType<typeof watch>;
  let waiter: {
    resolve(content: string): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | undefined;
  let watcherError: Error | undefined;
  let closed = false;
  const fail = (error: Error): void => {
    if (waiter) {
      const current = waiter;
      waiter = undefined;
      clearTimeout(current.timer);
      current.reject(error);
    } else {
      watcherError = error;
    }
  };
  const inspect = (): void => {
    if (!waiter) return;
    let stat;
    try {
      stat = lstatSync(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      fail(new Error(`cannot inspect owned signal marker ${marker} under ${root}: ${String(error)}`));
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64) {
      fail(new Error(`owned signal marker has an unexpected file type or size: ${marker} under ${root}`));
      return;
    }
    let content: string;
    try {
      content = readFileSync(marker, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      fail(new Error(`cannot read owned signal marker ${marker} under ${root}: ${String(error)}`));
      return;
    }
    if (content !== "caught") {
      if (content.length < "caught".length && "caught".startsWith(content)) return;
      fail(new Error(
        `owned signal marker content was not exactly "caught" at ${marker} under ${root}: ${JSON.stringify(content)}`,
      ));
      return;
    }
    const current = waiter;
    waiter = undefined;
    clearTimeout(current.timer);
    current.resolve(content);
  };
  watcher = watch(root, () => inspect());
  watcher.on("error", (error) => {
    fail(new Error(`filesystem watcher failed for owned signal root ${root}: ${String(error)}`));
  });
  return {
    wait(timeoutMs) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error(`filesystem watcher is closed for owned signal root ${root}`));
          return;
        }
        if (watcherError) {
          reject(watcherError);
          return;
        }
        if (waiter) {
          reject(new Error(`marker wait is already active for owned signal root ${root}`));
          return;
        }
        const timer = setTimeout(() => {
          const current = waiter;
          if (!current) return;
          waiter = undefined;
          current.reject(new Error(
            `complete "caught" marker did not arrive before the deadline: ${marker} under ${root}`,
          ));
        }, timeoutMs);
        waiter = { resolve, reject, timer };
        inspect();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      watcher.close();
      if (waiter) {
        const current = waiter;
        waiter = undefined;
        clearTimeout(current.timer);
        current.reject(new Error(`filesystem watcher closed before marker completion under ${root}`));
      }
    },
  };
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

function removeSuccessfulSignalRoot(root: string, marker: string): void {
  const allowedFiles = new Set([basename(marker)]);
  const files = readdirSync(root).map((name) => {
    if (!allowedFiles.has(name)) {
      throw new Error(`unexpected entry ${name} in owned signal-test root ${root}; preserving it`);
    }
    const path = join(root, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`unexpected non-regular entry ${path} in owned signal-test root; preserving it`);
    }
    return path;
  });
  for (const file of files) unlinkSync(file);
  rmdirSync(root);
}

async function withSignalChild(
  scenario: "foreign-handler" | "default-signal",
  run: (state: SignalChild) => Promise<void>,
): Promise<void> {
  const scratchParent = join(process.cwd(), "node_modules");
  const parentStat = lstatSync(scratchParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`signal-test scratch parent is not a real owned dependency directory: ${scratchParent}`);
  }
  const root = mkdtempSync(join(scratchParent, ".pi-review-gate-signal-"));
  const marker = join(root, "job-term-observed");
  let markerObserver: MarkerObserver | undefined;
  let state: SignalChild | undefined;
  let failure: unknown;
  let cleanupFailure: unknown;
  try {
    // Install the directory watcher before the isolated process can start the
    // job, become ready, or receive a signal.
    markerObserver = createMarkerObserver(root, marker);
    state = makeChild(root, scenario, markerObserver);
    await waitForRecord(state, (record) => record.type === "ready", 10_000, "signal child readiness");
    if (!state.groupPid) throw new Error("ShellStart did not report its owned POSIX process group");
    await run(state);
  } catch (error) {
    failure = error;
  }
  try {
    if (state) await cleanupChild(state);
  } catch (error) {
    cleanupFailure = error;
  } finally {
    markerObserver?.close();
  }
  if (failure || cleanupFailure) {
    console.error(
      `preserving owned signal-test root ${root}; group=${state?.groupPid ?? "unknown"}; ` +
        `closed=${state?.closed ? JSON.stringify(state.closed) : "no"}; ` +
        `records=${JSON.stringify(state?.records ?? [])}; stderr=${state?.stderr ?? ""}; ` +
        `failure=${String(failure ?? "none")}; cleanup=${String(cleanupFailure ?? "none")}`,
    );
    if (failure && cleanupFailure) {
      throw new AggregateError([failure, cleanupFailure], `signal test and owned cleanup failed; retained ${root}`);
    }
    throw failure ?? cleanupFailure;
  }
  try {
    removeSuccessfulSignalRoot(root, marker);
  } catch (error) {
    console.error(`preserving owned signal-test root ${root} after cleanup error: ${String(error)}`);
    throw error;
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
      expect(await state.markerObserver.wait(3000)).toBe("caught");
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
        expect(await state.markerObserver.wait(3000)).toBe("caught");
        expect(readFileSync(state.marker, "utf8")).toBe("caught");
      });
    });
  }
});
