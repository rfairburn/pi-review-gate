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
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./helpers/expect";

const POSIX_ONLY = { skip: process.platform === "win32" };
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
// Upper bound for a complete marker file ("caught" is six bytes). Applies to
// the observer's type/size validation and to the pre-cleanup snapshot's bounded
// read.
const MARKER_CONTENT_LIMIT_BYTES = 64;
// Period of the observer's bounded fallback inspection. Directory watch
// notifications can be coalesced or dropped by the platform, so the same
// inspection also runs on this schedule while a wait is pending.
const MARKER_POLL_INTERVAL_MS = 25;

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

/**
 * Private seam for this file's deterministic observation controls. No production
 * module reads it and it is not exported: it only lets a test deliberately drop
 * filesystem watch notifications for its own owned root and prove that a
 * completed marker is still observed without any watch delivery.
 */
interface MarkerObserverOptions {
  deliverWatchEvents?: boolean;
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

function createMarkerObserver(
  root: string,
  marker: string,
  options: MarkerObserverOptions = {},
): MarkerObserver {
  const deliverWatchEvents = options.deliverWatchEvents !== false;
  let watcher: ReturnType<typeof watch>;
  let waiter: {
    resolve(content: string): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    poll: ReturnType<typeof setInterval>;
  } | undefined;
  let watcherError: Error | undefined;
  let closed = false;
  // Every settle path releases both timers, so no inspection schedule can
  // outlive the wait it belongs to.
  const releaseTimers = (current: NonNullable<typeof waiter>): void => {
    clearTimeout(current.timer);
    clearInterval(current.poll);
  };
  const fail = (error: Error): void => {
    if (waiter) {
      const current = waiter;
      waiter = undefined;
      releaseTimers(current);
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MARKER_CONTENT_LIMIT_BYTES) {
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
    releaseTimers(current);
    current.resolve(content);
  };
  watcher = watch(root, () => {
    // Seam-only suppression: when a test disables watch delivery, the periodic
    // inspection below is the only remaining observation path.
    if (!deliverWatchEvents) return;
    inspect();
  });
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
        const deadline = Date.now() + timeoutMs;
        const expire = (): void => {
          const current = waiter;
          if (!current) return;
          // Timer delivery alone does not prove this clock's deadline passed.
          // If it arrived early, retain the same absolute deadline and ownership.
          const remaining = deadline - Date.now();
          if (remaining > 0) {
            current.timer = setTimeout(expire, remaining);
            return;
          }
          waiter = undefined;
          releaseTimers(current);
          current.reject(new Error(
            `complete "caught" marker did not arrive before the deadline: ${marker} under ${root}`,
          ));
        };
        const timer = setTimeout(expire, timeoutMs);
        // Second, equivalent observation path for exactly as long as this wait
        // is pending: a completed marker must not be missed solely because the
        // platform coalesced or dropped its watch notification. This never
        // extends the deadline above; it only re-inspects the same marker.
        const poll = setInterval(inspect, MARKER_POLL_INTERVAL_MS);
        waiter = { resolve, reject, timer, poll };
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
        releaseTimers(current);
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

interface PreCleanupMarkerFacts {
  markerExists: boolean;
  entryType?: "file" | "symlink" | "other";
  sizeBytes?: number;
  mtimeIso?: string;
  contentLength?: number;
  contentComplete?: boolean;
  groupPid?: number;
  groupAlive?: boolean;
  hostClosed: string;
  hostRecords: RecordLine[];
}

/**
 * Sample the facts that tell "the marker producer ran late" apart from "the
 * harness missed an already-completed marker".
 *
 * This must run before cleanupChild, because cleanup itself signals the owned
 * group and can therefore create the very marker under observation. For the
 * previously preserved historical failure this distinction is no longer
 * recoverable: that run's marker was inspected only after test cleanup, which
 * could itself have written it, so its original cause stays unknown (late
 * producer vs. missed watch notification remain indistinguishable there).
 * Captured here it is decisive only for a future occurrence.
 *
 * Only bounded metadata plus an exact-completeness boolean are recorded. The
 * marker's arbitrary bytes are never retained, stringified, or printed.
 */
function capturePreCleanupMarkerFacts(marker: string, state: SignalChild): PreCleanupMarkerFacts {
  const facts: PreCleanupMarkerFacts = {
    markerExists: false,
    hostClosed: state.closed ? JSON.stringify(state.closed) : "no",
    hostRecords: state.records.slice(),
  };
  let stat: Stats | undefined;
  try {
    stat = lstatSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stat) {
    facts.markerExists = true;
    facts.entryType = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
    facts.sizeBytes = stat.size;
    facts.mtimeIso = new Date(stat.mtimeMs).toISOString();
    if (facts.entryType === "file") {
      facts.contentLength = stat.size;
      facts.contentComplete =
        stat.size <= MARKER_CONTENT_LIMIT_BYTES &&
        readFileSync(marker).equals(Buffer.from("caught", "utf8"));
    }
  }
  // Group liveness is sampled after the marker facts so both describe the same
  // pre-cleanup moment.
  if (state.groupPid) {
    facts.groupPid = state.groupPid;
    facts.groupAlive = groupIsAlive(state.groupPid);
  }
  return facts;
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
  let failureCaptured = false;
  let cleanupFailure: unknown;
  let cleanupFailed = false;
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
    failureCaptured = true;
  }
  // Capture the marker/group facts before cleanupChild runs: cleanup signals the
  // owned group itself and can create the marker under observation. Any failure
  // while sampling is reported alongside the original failure, never in place
  // of it, and cleanup still runs below.
  let preCleanup: PreCleanupMarkerFacts | undefined;
  let preCleanupError: string | undefined;
  if (failureCaptured && state) {
    try {
      preCleanup = capturePreCleanupMarkerFacts(marker, state);
    } catch (error) {
      preCleanupError = String(error);
    }
  }
  try {
    if (state) await cleanupChild(state);
  } catch (error) {
    cleanupFailure = error;
    cleanupFailed = true;
  } finally {
    markerObserver?.close();
  }
  if (failureCaptured || cleanupFailed) {
    console.error(
      `preserving owned signal-test root ${root}; group=${state?.groupPid ?? "unknown"}; ` +
        `preCleanup=${preCleanup ? JSON.stringify(preCleanup) : "not-captured"}; ` +
        `preCleanupError=${preCleanupError ?? "none"}; ` +
        `closed=${state?.closed ? JSON.stringify(state.closed) : "no"}; ` +
        `records=${JSON.stringify(state?.records ?? [])}; stderr=${state?.stderr ?? ""}; ` +
        `failure=${failureCaptured ? String(failure) : "none"}; ` +
        `cleanup=${cleanupFailed ? String(cleanupFailure) : "none"}`,
    );
    if (failureCaptured && cleanupFailed) {
      throw new AggregateError([failure, cleanupFailure], `signal test and owned cleanup failed; retained ${root}`);
    }
    throw failureCaptured ? failure : cleanupFailure;
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

async function withMarkerObserverRoot(
  options: MarkerObserverOptions,
  run: (context: { root: string; marker: string; observer: MarkerObserver }) => Promise<void>,
): Promise<void> {
  const scratchParent = join(process.cwd(), "node_modules");
  const parentStat = lstatSync(scratchParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`signal-test scratch parent is not a real owned dependency directory: ${scratchParent}`);
  }
  const root = mkdtempSync(join(scratchParent, ".pi-review-gate-signal-"));
  const marker = join(root, "job-term-observed");
  const observer = createMarkerObserver(root, marker, options);
  let failure: unknown;
  let failed = false;
  try {
    await run({ root, marker, observer });
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    observer.close();
  }
  if (failed) {
    console.error(`preserving owned signal-marker observation root ${root}; failure=${String(failure)}`);
    throw failure;
  }
  try {
    removeSuccessfulSignalRoot(root, marker);
  } catch (error) {
    console.error(`preserving owned signal-marker observation root ${root} after cleanup error: ${String(error)}`);
    throw error;
  }
}

// These cases cover only this file's private observation seam. They are
// deliberately short and self-contained: the integration cases above keep their
// exact 3000 ms marker budget, and nothing here widens, retries, or replaces a
// wait deadline.
describe("background-shell signal marker observation", () => {
  const SEAM_DEADLINE_MS = 300;

  // Proves the negative direction: while watch delivery is suppressed, a marker
  // that never completes must reject at the deadline, never resolve before it.
  const expectDeadlineRejection = async (
    observer: MarkerObserver,
    marker: string,
    description: string,
  ): Promise<void> => {
    const started = Date.now();
    const rejected = await observer.wait(SEAM_DEADLINE_MS).then(() => undefined, (error: unknown) => error);
    if (!(rejected instanceof Error)) {
      throw new Error(`${description} must reject at its deadline instead of settling early`);
    }
    expect(rejected.message).toContain(
      `complete "caught" marker did not arrive before the deadline: ${marker}`,
    );
    if (Date.now() - started < SEAM_DEADLINE_MS) {
      throw new Error(`${description} must not settle the wait before its deadline`);
    }
  };

  it("observes a completed marker even when every filesystem watch notification is dropped", async () => {
    await withMarkerObserverRoot({ deliverWatchEvents: false }, async ({ marker, observer }) => {
      const pending = observer.wait(3000);
      // wait() already ran its immediate inspection synchronously, so the marker
      // written below can only be found by a later observation path. Every watch
      // notification for it is deliberately discarded by the seam.
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeFileSync(marker, "caught");
      expect(await pending).toBe("caught");
    });
  });

  it("does not report success for an absent marker before the deadline", async () => {
    await withMarkerObserverRoot({ deliverWatchEvents: false }, async ({ marker, observer }) => {
      await expectDeadlineRejection(observer, marker, "an absent marker");
    });
  });

  it("does not report success for a partial marker before the deadline", async () => {
    await withMarkerObserverRoot({ deliverWatchEvents: false }, async ({ marker, observer }) => {
      writeFileSync(marker, "cau");
      await expectDeadlineRejection(observer, marker, "a partial marker");
      // The retained partial-content semantics are unchanged: an incomplete
      // prefix is still pending, never completion, and the file is left alone.
      expect(readFileSync(marker, "utf8")).toBe("cau");
    });
  });

  it("still fails fast on marker content that can never complete", async () => {
    await withMarkerObserverRoot({}, async ({ marker, observer }) => {
      writeFileSync(marker, "not-the-marker");
      const rejected = await observer.wait(3000).then(() => undefined, (error: unknown) => error);
      if (!(rejected instanceof Error)) {
        throw new Error("invalid marker content must reject immediately instead of waiting for its deadline");
      }
      expect(rejected.message).toContain(
        `owned signal marker content was not exactly "caught" at ${marker}`,
      );
    });
  });
});
