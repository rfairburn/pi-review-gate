/**
 * #682 native Windows Claude custody — inactive launch lifecycle adapter tests.
 *
 * These tests compose the REAL supervisor transport with portable fakes: an
 * in-memory supervisor `ChildProcess` (PassThrough pipes, real `Close`/`Exit`
 * events) and an in-memory PTY handle exposing a live `pid` getter, `onExit`,
 * and `kill`. Nothing is spawned at the OS level, no PowerShell is run, no
 * provider is contacted, and no filesystem scratch is used.
 *
 * Every test uses short bounded deadlines and drains both fake handles before
 * it ends.
 *
 * The dormant opt-in hook channel is exercised the same way: the real renderer
 * (`hookPipe`) and the real transport (`hookCandidates`, private key frame) with
 * synthetic, inert pipe/key values. Real Windows behavior of the protected
 * listener and early hook delivery is NOT covered here.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { inspect } from "node:util";

import {
  DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES,
  createNativeWindowsClaudeCustodyAdapter,
  type NativeWindowsClaudeCustodyAdapter,
  type NativeWindowsClaudeCustodyAdapterDeadlines,
  type NativeWindowsClaudeCustodyAdapterOptions,
  type NativeWindowsClaudeCustodyControlAdapter,
  type NativeWindowsClaudeCustodyHookAdapter,
  type NativeWindowsClaudeCustodyLaunchResult,
  type NativeWindowsClaudeCustodyWrapperHandle,
} from "../src/session-host/native-windows-claude-custody-adapter";
import * as custodyProtocol from "../src/session-host/native-windows-claude-custody-protocol";
import {
  NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS,
  type NativeWindowsClaudeCustodyRun,
  type NativeWindowsClaudeCustodyStartOptions,
  type NativeWindowsClaudeCustodyTransportOptions,
} from "../src/session-host/native-windows-claude-custody-protocol";
import {
  WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC,
  WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS,
  buildWindowsClaudeCustodySupervisorLaunch,
  type WindowsClaudeCustodySupervisorLaunch,
  type WindowsClaudeCustodyWrapperLaunch,
} from "../src/session-host/native-windows-claude-custody-scripts";

const SUP_PID = 5400;
const WRAP_PID = 5504;
const CHILD_PID = 5608;
const RUN: NativeWindowsClaudeCustodyRun = Object.freeze({ runId: "run-682-adapter", generation: 2 });
const POWERSHELL_PATH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const TARGET_PATH = String.raw`C:\Program Files\Claude\claude.exe`;

const TEST_DEADLINES: NativeWindowsClaudeCustodyAdapterDeadlines = Object.freeze({
  readyMs: 300,
  peerMs: 300,
  childMs: 300,
  settleMs: 300,
  wrapperPidMs: 500,
  closeMs: 120,
});

/* ------------------------------------------------------- fake supervisor */

class FakeSupervisor extends EventEmitter {
  pid: number | undefined = SUP_PID;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  closeSuppressed = false;
  exitOnKill = true;
  /** Optional synchronous reentry hook invoked from kill(). */
  onKill: (() => void) | undefined;
  private written = Buffer.alloc(0);
  /** The exact Buffer objects handed to stdin.write (to observe post-write scrubbing). */
  readonly handed: Buffer[] = [];

  constructor() {
    super();
    // Copy at write time: the opt-in transport zero-fills its key-bearing
    // buffer once the write completes.
    const write = this.stdin.write.bind(this.stdin) as (...args: unknown[]) => boolean;
    (this.stdin as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
      if (Buffer.isBuffer(chunk)) {
        this.handed.push(chunk);
        this.written = Buffer.concat([this.written, chunk]);
      }
      return write(chunk, ...rest);
    };
    this.stdin.resume();
  }

  get writtenText(): string {
    return this.written.toString("latin1");
  }

  kill(): boolean {
    this.kills += 1;
    this.onKill?.();
    if (this.exitOnKill) void this.exit(null, "SIGTERM");
    return true;
  }

  async line(text: string): Promise<void> {
    this.stdout.write(`${text}\n`);
    await settleIo();
  }

  /** Exit, end both output pipes, then optionally emit `close` (as Node does). */
  async exit(code: number | null, signal: NodeJS.Signals | null = null): Promise<void> {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    await settleIo();
    this.stdout.end();
    this.stderr.end();
    await settleIo();
    if (!this.closeSuppressed) this.emit("close", code, signal);
    await settleIo();
  }
}

/* ------------------------------------------------------------ fake PTY */

interface FakeExit {
  readonly exitCode: number;
  readonly signal?: number;
}

class FakeWrapper implements NativeWindowsClaudeCustodyWrapperHandle {
  private currentPid: number;
  private readonly listeners = new Set<(event: FakeExit) => void>();
  private exited = false;
  pidReads = 0;
  exitRegistrations = 0;
  disposals = 0;
  killCount = 0;
  /** Optional hook invoked after every live getter read (fence tests). */
  onPidRead: (() => void) | undefined;
  /** When true, `onExit` throws instead of registering a receipt. */
  onExitThrows = false;

  constructor(pid = 0) {
    this.currentPid = pid;
  }

  get pid(): number {
    this.pidReads += 1;
    this.onPidRead?.();
    return this.currentPid;
  }

  setPid(pid: number): void {
    this.currentPid = pid;
  }

  onExit(listener: (event: FakeExit) => void): { dispose(): void } {
    this.exitRegistrations += 1;
    if (this.onExitThrows) throw new Error("exit unavailable");
    this.listeners.add(listener);
    return {
      dispose: (): void => {
        this.disposals += 1;
        this.listeners.delete(listener);
      },
    };
  }

  kill(): void {
    this.killCount += 1;
    this.emitExit({ exitCode: 0 });
  }

  emitExit(event: FakeExit = { exitCode: 0 }): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.listeners]) listener(event);
  }
}

/* --------------------------------------------------------------- harness */

interface HarnessOverrides {
  readonly signal?: AbortSignal;
  readonly isRunCurrent?: () => boolean;
  readonly powershellPath?: string;
  readonly target?: string;
  readonly deadlines?: Partial<NativeWindowsClaudeCustodyAdapterDeadlines>;
  readonly spawnSupervisorThrows?: boolean;
  readonly spawnWrapperThrows?: boolean;
  readonly wrapperPid?: number;
  /** Passed through verbatim (including malformed values) when the key is present. */
  readonly hookChannel?: unknown;
  readonly supervisorPid?: number | undefined;
}

interface Harness {
  /** Typed as the hook adapter; the runtime object is the same class either way. */
  readonly adapter: NativeWindowsClaudeCustodyHookAdapter;
  readonly supervisor: FakeSupervisor;
  readonly wrapper: FakeWrapper;
  readonly supervisorLaunches: WindowsClaudeCustodySupervisorLaunch[];
  readonly wrapperLaunches: WindowsClaudeCustodyWrapperLaunch[];
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const supervisor = new FakeSupervisor();
  if ("supervisorPid" in overrides) supervisor.pid = overrides.supervisorPid;
  const wrapper = new FakeWrapper(overrides.wrapperPid ?? 0);
  const supervisorLaunches: WindowsClaudeCustodySupervisorLaunch[] = [];
  const wrapperLaunches: WindowsClaudeCustodyWrapperLaunch[] = [];
  const options: NativeWindowsClaudeCustodyAdapterOptions = {
    powershellPath: overrides.powershellPath ?? POWERSHELL_PATH,
    target: overrides.target ?? TARGET_PATH,
    run: RUN,
    isRunCurrent: overrides.isRunCurrent ?? (() => true),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    deadlines: { ...TEST_DEADLINES, ...overrides.deadlines },
    spawnSupervisor: (launch) => {
      supervisorLaunches.push(launch);
      if (overrides.spawnSupervisorThrows === true) throw new Error("synthetic supervisor spawn throw");
      return supervisor as unknown as ChildProcess;
    },
    spawnWrapper: (launch) => {
      wrapperLaunches.push(launch);
      if (overrides.spawnWrapperThrows === true) throw new Error("synthetic wrapper spawn throw");
      return wrapper;
    },
    ...("hookChannel" in overrides ? { hookChannel: overrides.hookChannel as NativeWindowsClaudeCustodyAdapterOptions["hookChannel"] } : {}),
  };
  const adapter = createNativeWindowsClaudeCustodyAdapter(options) as NativeWindowsClaudeCustodyHookAdapter;
  return { adapter, supervisor, wrapper, supervisorLaunches, wrapperLaunches };
}

/* --------------------------------------------------------------- helpers */

async function settleIo(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

/** Driver bytes AFTER the fixed boot frame (the source itself may mention commands). */
function commandsWritten(supervisor: FakeSupervisor): string {
  const text = supervisor.writtenText;
  if (!text.startsWith(WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC)) return "";
  const digitStart = WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC.length;
  const length = Number(text.slice(digitStart, digitStart + 8));
  if (!Number.isSafeInteger(length)) return "";
  return text.slice(NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES + length);
}

async function startToReady(h: Harness): Promise<{ launching: Promise<NativeWindowsClaudeCustodyLaunchResult> }> {
  const launching = h.adapter.launch();
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => h.wrapperLaunches.length === 1, "wrapper spawn");
  return { launching };
}

async function driveToChild(h: Harness): Promise<void> {
  const { launching } = await startToReady(h);
  h.wrapper.setPid(WRAP_PID);
  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  await waitFor(() => commandsWritten(h.supervisor).includes(`CONFIRM ${WRAP_PID}\n`), "CONFIRM write");
  await h.supervisor.line(`SUP_GO ${WRAP_PID}`);
  await h.supervisor.line(`SUP_CHILD ${CHILD_PID}`);
  const result = await launching;
  assert.deepEqual(result, {
    status: "launched",
    supervisorPid: SUP_PID,
    wrapperPid: WRAP_PID,
    childPid: CHILD_PID,
  });
}

async function driveToGo(h: Harness): Promise<{ launching: Promise<NativeWindowsClaudeCustodyLaunchResult> }> {
  const { launching } = await startToReady(h);
  h.wrapper.setPid(WRAP_PID);
  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  await waitFor(() => commandsWritten(h.supervisor).includes(`CONFIRM ${WRAP_PID}\n`), "CONFIRM write");
  await h.supervisor.line(`SUP_GO ${WRAP_PID}`);
  await settleIo();
  return { launching };
}

/**
 * Run `action` inside a chosen microtask gap around the real transport's
 * SUP_CHILD step. The transport's stdout listener was registered first; this
 * listener is second. Two hops land after the transport step but before the
 * adapter records custody; three hops land after the adapter's candidate
 * result but before runLaunch() publishes it.
 */
function actInChildHandoff(h: Harness, action: () => void, hops = 2): void {
  const onData = (chunk: Buffer): void => {
    if (!chunk.toString("latin1").includes("SUP_CHILD")) return;
    h.supervisor.stdout.off("data", onData);
    const advance = (remaining: number): void => {
      if (remaining === 0) {
        action();
        return;
      }
      queueMicrotask(() => advance(remaining - 1));
    };
    queueMicrotask(() => advance(hops - 1));
  };
  h.supervisor.stdout.on("data", onData);
}

async function finishSettlement(
  h: Harness,
  stopping: Promise<unknown>,
): Promise<unknown> {
  await waitFor(() => commandsWritten(h.supervisor).includes("SETTLE\n"), "SETTLE write");
  h.wrapper.emitExit({ exitCode: 0 });
  await h.supervisor.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await h.supervisor.line("SUP_BYE");
  await h.supervisor.exit(0);
  return stopping;
}

/* --------------------------------------------------------------- startup */

test("adapter defaults stay inside the existing per-step cap and expose only bounded waits", () => {
  for (const value of Object.values(DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES)) {
    assert.ok(Number.isSafeInteger(value));
    assert.ok(value >= 1 && value <= NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS);
  }
});

test("launch waits for a deferred live PTY PID, establishes the child, and witnesses one exact settlement", async () => {
  const h = makeHarness();
  const launching = h.adapter.launch();

  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => h.wrapperLaunches.length === 1, "wrapper spawn");
  assert.equal(h.wrapper.pid, 0);
  assert.equal(commandsWritten(h.supervisor), "", "nothing is written before a positive PID");

  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(commandsWritten(h.supervisor), "", "PID 0 never produces CONFIRM");

  h.wrapper.setPid(WRAP_PID);
  await waitFor(() => commandsWritten(h.supervisor) === `CONFIRM ${WRAP_PID}\n`, "CONFIRM with the live PID");
  await h.supervisor.line(`SUP_GO ${WRAP_PID}`);
  await h.supervisor.line(`SUP_CHILD ${CHILD_PID}`);

  const launched = await launching;
  assert.deepEqual(launched, {
    status: "launched",
    supervisorPid: SUP_PID,
    wrapperPid: WRAP_PID,
    childPid: CHILD_PID,
  });
  assert.equal(
    commandsWritten(h.supervisor),
    `CONFIRM ${WRAP_PID}\n`,
    "GO and SUP_CHILD never trigger an early SETTLE",
  );
  assert.equal(h.supervisorLaunches.length, 1);
  assert.equal(h.wrapperLaunches.length, 1);

  const supervisorLaunch = h.supervisorLaunches[0]!;
  const wrapperLaunch = h.wrapperLaunches[0]!;
  assert.equal(supervisorLaunch.file, POWERSHELL_PATH);
  assert.equal(wrapperLaunch.file, POWERSHELL_PATH);
  assert.deepEqual(supervisorLaunch.spawnOptions, WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS);
  assert.equal(wrapperLaunch.args.length, 5);
  assert.ok(wrapperLaunch.script.includes(`$CusSup=${SUP_PID};`));
  assert.ok(wrapperLaunch.script.includes(String.raw`$Target='C:\Program Files\Claude\claude.exe'`));
  const pipe = /prg682-ctl-[0-9a-f]{32}/u.exec(wrapperLaunch.script)?.[0];
  const nonce = /\$CusNonce='([0-9a-f]{32})'/u.exec(wrapperLaunch.script)?.[1];
  assert.ok(pipe !== undefined && nonce !== undefined);
  assert.ok(supervisorLaunch.source.includes(`$CtlName='${pipe}'`));
  assert.ok(supervisorLaunch.source.includes(`$Nonce='${nonce}'`));

  const secondLaunch = h.adapter.launch();
  assert.deepEqual(await secondLaunch, { status: "failed", code: "already-used" });
  assert.equal(h.supervisorLaunches.length, 1);
  assert.equal(h.wrapperLaunches.length, 1);

  const firstStop = h.adapter.stop();
  const secondStop = h.adapter.stop();
  assert.equal(firstStop, secondStop, "stop is single-flight");

  const stopped = await finishSettlement(h, firstStop);
  assert.deepEqual(stopped, {
    status: "witnessed-empty",
    witness: { supervisorPid: SUP_PID, jobActive: 0, jobListed: 0, exitCode: 0 },
    supervisorSpawned: true,
    supervisorClosed: true,
    wrapperSpawned: true,
    wrapperExited: true,
    childEstablished: true,
    confirmMayHaveBeenWritten: true,
    settleAttempted: true,
  });
  assert.equal(h.adapter.stop(), firstStop);
  assert.equal(commandsWritten(h.supervisor), `CONFIRM ${WRAP_PID}\nSETTLE\n`);
  assert.equal((commandsWritten(h.supervisor).match(/SETTLE\n/gu) ?? []).length, 1);
  assert.equal(h.supervisor.kills, 0, "a witnessed settlement never kills the supervisor");
  assert.equal(h.wrapper.killCount, 0, "a witnessed settlement never signals the PTY");
});

test("cancellation during boot disposes the exact supervisor and never spawns the wrapper", async () => {
  const abort = new AbortController();
  const h = makeHarness({ signal: abort.signal });
  const launching = h.adapter.launch();
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");

  abort.abort();
  assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "no-child-possible");
  assert.equal(stopped.supervisorSpawned, true);
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(stopped.wrapperSpawned, false);
  assert.equal(stopped.confirmMayHaveBeenWritten, false);
  assert.equal(stopped.settleAttempted, false);
  assert.ok(h.supervisor.kills >= 1);
  assert.equal(h.wrapperLaunches.length, 0, "boot cancellation never spawns a wrapper");
  assert.equal(commandsWritten(h.supervisor), "", "no CONFIRM and no SETTLE");
});

test("a PTY PID that never becomes positive is cancelled without CONFIRM or SETTLE and leaves no child possible", async () => {
  const abort = new AbortController();
  const h = makeHarness({ signal: abort.signal });
  const { launching } = await startToReady(h);
  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(h.wrapper.pid, 0);
  assert.equal(commandsWritten(h.supervisor), "", "CONFIRM is never written for zero");

  abort.abort();
  assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "no-child-possible");
  assert.equal(stopped.witness, null);
  assert.equal(stopped.childEstablished, false);
  assert.equal(stopped.confirmMayHaveBeenWritten, false);
  assert.equal(stopped.settleAttempted, false);
  assert.equal(stopped.supervisorSpawned, true);
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(stopped.wrapperSpawned, true);
  assert.equal(stopped.wrapperExited, true);
  assert.ok(h.wrapper.killCount >= 1);
  assert.ok(h.supervisor.kills >= 1);
  assert.equal(commandsWritten(h.supervisor), "", "no CONFIRM and no SETTLE");
});

test("a run that goes stale at the CONFIRM write fence writes nothing and stays unproven", async () => {
  let current = true;
  const h = makeHarness({ isRunCurrent: () => current });
  const { launching } = await startToReady(h);
  h.wrapper.setPid(WRAP_PID);
  // Let the bounded positive-PID wait finish; arm the fence flip afterwards.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  h.wrapper.onPidRead = () => {
    h.wrapper.onPidRead = undefined;
    current = false;
  };

  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  assert.deepEqual(await launching, {
    status: "failed",
    code: "run-not-current",
  });
  assert.equal(commandsWritten(h.supervisor), "", "the stale fence never writes CONFIRM");

  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "confirmation-may-have-been-written");
  assert.equal(stopped.confirmMayHaveBeenWritten, true);
  assert.equal(stopped.childEstablished, false);
  assert.equal(stopped.settleAttempted, false);
  assert.equal(commandsWritten(h.supervisor), "", "no SETTLE");
});

test("a mismatched live PTY PID writes no CONFIRM and is never retried through a fallback", async () => {
  const h = makeHarness();
  const { launching } = await startToReady(h);
  h.wrapper.setPid(WRAP_PID + 8);

  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  assert.deepEqual(await launching, {
    status: "failed",
    code: "confirm-failed",
    detail: "peer-mismatch",
  });
  assert.equal(commandsWritten(h.supervisor), "", "no CONFIRM for a mismatched PID");
  assert.equal(h.supervisorLaunches.length, 1);
  assert.equal(h.wrapperLaunches.length, 1, "no fallback wrapper spawn");

  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "confirmation-may-have-been-written");
  assert.equal(stopped.confirmMayHaveBeenWritten, true);
  assert.equal(commandsWritten(h.supervisor), "", "no SETTLE and no retry command");
});

test("cancellation after CONFIRM but before GO never sends SETTLE and stays unproven", async () => {
  const abort = new AbortController();
  const h = makeHarness({ signal: abort.signal });
  const { launching } = await startToReady(h);
  h.wrapper.setPid(WRAP_PID);

  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  await waitFor(() => commandsWritten(h.supervisor) === `CONFIRM ${WRAP_PID}\n`, "CONFIRM write");
  abort.abort();

  assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "confirmation-may-have-been-written");
  assert.equal(stopped.confirmMayHaveBeenWritten, true);
  assert.equal(stopped.settleAttempted, false);
  assert.equal(stopped.childEstablished, false);
  assert.equal(commandsWritten(h.supervisor), `CONFIRM ${WRAP_PID}\n`, "no SETTLE");
});

test("cancellation after GO before the child never sends SETTLE and stays unproven", async () => {
  const abort = new AbortController();
  const h = makeHarness({ signal: abort.signal });
  const { launching } = await startToReady(h);
  h.wrapper.setPid(WRAP_PID);

  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  await waitFor(() => commandsWritten(h.supervisor) === `CONFIRM ${WRAP_PID}\n`, "CONFIRM write");
  await h.supervisor.line(`SUP_GO ${WRAP_PID}`);
  await settleIo();
  abort.abort();

  assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "confirmation-may-have-been-written");
  assert.equal(stopped.confirmMayHaveBeenWritten, true);
  assert.equal(stopped.childEstablished, false);
  assert.equal(stopped.settleAttempted, false);
  assert.equal(commandsWritten(h.supervisor), `CONFIRM ${WRAP_PID}\n`, "no SETTLE");
});

test("an earlier abort listener that stops immediate propagation cannot hide a post-GO cancellation", async () => {
  const abort = new AbortController();
  abort.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const h = makeHarness({ signal: abort.signal });
  const { launching } = await startToReady(h);
  h.wrapper.setPid(WRAP_PID);

  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  await waitFor(() => commandsWritten(h.supervisor) === `CONFIRM ${WRAP_PID}\n`, "CONFIRM write");
  await h.supervisor.line(`SUP_GO ${WRAP_PID}`);
  await settleIo();

  abort.abort();
  // Even a SUP_CHILD arriving after the cancellation must not be accepted as
  // custody or turn this into the settlement path.
  await h.supervisor.line(`SUP_CHILD ${CHILD_PID}`);

  assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "confirmation-may-have-been-written");
  assert.equal(stopped.confirmMayHaveBeenWritten, true);
  assert.equal(stopped.childEstablished, false);
  assert.equal(stopped.settleAttempted, false);
  assert.ok(!commandsWritten(h.supervisor).includes("SETTLE"), "pre-child cancellation never sends SETTLE");
});

test("single-flight stop settles once and caller cancellation during settlement cannot clobber the witness", async () => {
  const abort = new AbortController();
  const h = makeHarness({ signal: abort.signal });
  await driveToChild(h);

  const firstStop = h.adapter.stop();
  const secondStop = h.adapter.stop();
  assert.equal(firstStop, secondStop);
  await waitFor(() => commandsWritten(h.supervisor).includes("SETTLE\n"), "SETTLE write");

  // This arrives while settlement is running. It must not poison, dispose, or
  // preempt the one witness.
  abort.abort();
  await settleIo();
  assert.equal(h.supervisor.kills, 0);
  assert.equal(h.wrapper.killCount, 0);
  assert.equal((commandsWritten(h.supervisor).match(/SETTLE\n/gu) ?? []).length, 1);

  h.wrapper.emitExit({ exitCode: 0 });
  await h.supervisor.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await h.supervisor.line("SUP_BYE");
  await h.supervisor.exit(0);

  const stopped = await firstStop;
  assert.equal(stopped.status, "witnessed-empty");
  assert.deepEqual(stopped.witness, {
    supervisorPid: SUP_PID,
    jobActive: 0,
    jobListed: 0,
    exitCode: 0,
  });
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(stopped.wrapperExited, true);
  assert.equal(stopped.settleAttempted, true);
  assert.equal(h.adapter.stop(), firstStop);
  assert.equal(h.supervisor.kills, 0);
});

test("a PTY exit after custody automatically runs the same bounded stop/settle", async () => {
  const h = makeHarness();
  await driveToChild(h);

  h.wrapper.emitExit({ exitCode: 0 });
  await waitFor(() => commandsWritten(h.supervisor).includes("SETTLE\n"), "automatic SETTLE");

  await h.supervisor.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await h.supervisor.line("SUP_BYE");
  await h.supervisor.exit(0);

  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "witnessed-empty");
  assert.equal(stopped.wrapperExited, true);
  assert.equal(stopped.supervisorClosed, true);
  assert.equal((commandsWritten(h.supervisor).match(/SETTLE\n/gu) ?? []).length, 1);
});

test("a PTY exit in the SUP_CHILD handoff never publishes launch success and settles exactly once", async () => {
  const h = makeHarness();
  const { launching } = await driveToGo(h);
  actInChildHandoff(h, () => h.wrapper.emitExit({ exitCode: 0 }), 3);
  h.supervisor.stdout.write(`SUP_CHILD ${CHILD_PID}\n`);

  await waitFor(() => commandsWritten(h.supervisor).includes("SETTLE\n"), "SETTLE write");
  await h.supervisor.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await h.supervisor.line("SUP_BYE");
  await h.supervisor.exit(0);

  assert.deepEqual(await launching, { status: "failed", code: "wrapper-exited" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "witnessed-empty");
  assert.equal(stopped.childEstablished, true);
  assert.equal(stopped.wrapperExited, true);
  assert.equal(stopped.settleAttempted, true);
  assert.equal((commandsWritten(h.supervisor).match(/SETTLE\n/gu) ?? []).length, 1);
});

test("an explicit stop in the SUP_CHILD handoff settles exactly once after custody was recorded", async () => {
  const h = makeHarness();
  const { launching } = await driveToGo(h);
  actInChildHandoff(h, () => {
    void h.adapter.stop();
  });
  h.supervisor.stdout.write(`SUP_CHILD ${CHILD_PID}\n`);

  await waitFor(() => commandsWritten(h.supervisor).includes("SETTLE\n"), "SETTLE write");
  h.wrapper.emitExit({ exitCode: 0 });
  await h.supervisor.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await h.supervisor.line("SUP_BYE");
  await h.supervisor.exit(0);

  assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "witnessed-empty");
  assert.equal(stopped.childEstablished, true);
  assert.equal(stopped.wrapperExited, true);
  assert.equal(stopped.settleAttempted, true);
  assert.equal((commandsWritten(h.supervisor).match(/SETTLE\n/gu) ?? []).length, 1);
});

test("an explicit stop in the SUP_CHILD handoff sends no SETTLE when awaitChild failed", async () => {
  const h = makeHarness();
  const { launching } = await driveToGo(h);
  actInChildHandoff(h, () => {
    void h.adapter.stop();
  });
  // SUP_CHILD naming the wrapper itself is a transport poison, so the child
  // step fails even though the stop request lands in the handoff gap.
  h.supervisor.stdout.write(`SUP_CHILD ${WRAP_PID}\n`);

  assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "confirmation-may-have-been-written");
  assert.equal(stopped.childEstablished, false);
  assert.equal(stopped.settleAttempted, false);
  assert.equal(commandsWritten(h.supervisor), `CONFIRM ${WRAP_PID}\n`, "no SETTLE");
});

test("a supervisor failure after awaitChild but before publication refuses success and stays unproven", async () => {
  const h = makeHarness();
  const { launching } = await driveToGo(h);
  actInChildHandoff(h, () => h.supervisor.emit("error", new Error("post-child supervisor failure")), 3);
  h.supervisor.stdout.write(`SUP_CHILD ${CHILD_PID}\n`);

  assert.deepEqual(await launching, {
    status: "failed",
    code: "child-not-established",
    detail: "process-error",
  });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "settlement-failed");
  assert.equal(stopped.childEstablished, true);
  assert.equal(stopped.settleAttempted, true);
  assert.equal(stopped.wrapperExited, true);
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(commandsWritten(h.supervisor), `CONFIRM ${WRAP_PID}\n`, "no SETTLE after transport poison");
});

test("a missing supervisor close after the settlement tail leaves the stop unproven", async () => {
  const h = makeHarness({ deadlines: { settleMs: 80, closeMs: 50 } });
  await driveToChild(h);

  const stopping = h.adapter.stop();
  await waitFor(() => commandsWritten(h.supervisor).includes("SETTLE\n"), "SETTLE write");
  h.wrapper.emitExit({ exitCode: 0 });
  h.supervisor.closeSuppressed = true;
  await h.supervisor.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await h.supervisor.line("SUP_BYE");
  await h.supervisor.exit(0);

  const stopped = await stopping;
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "settlement-failed");
  assert.equal(stopped.witness, null);
  assert.equal(stopped.supervisorClosed, false);
  assert.equal(stopped.wrapperExited, true);
  assert.equal(stopped.settleAttempted, true);
  assert.equal(stopped.childEstablished, true);
});

test("a supervisor error at the wrapper-spawn fence prevents the PTY spawn", async () => {
  let h!: Harness;
  let calls = 0;
  let fired = false;
  h = makeHarness({
    isRunCurrent: () => {
      calls += 1;
      // Call 1 is before supervisor spawn, 2 after attach, 3 after READY, and
      // 4 is the host predicate immediately before the PTY spawn.
      if (!fired && calls === 4) {
        fired = true;
        h.supervisor.emit("error", new Error("supervisor failed after READY"));
      }
      return true;
    },
  });
  const launching = h.adapter.launch();
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);

  assert.deepEqual(await launching, {
    status: "failed",
    code: "supervisor-boot-failed",
    detail: "process-error",
  });
  assert.equal(h.wrapperLaunches.length, 0, "a poisoned boot never spawns the PTY");
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "no-child-possible");
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(stopped.wrapperSpawned, false);
  assert.equal(stopped.confirmMayHaveBeenWritten, false);
  assert.equal(commandsWritten(h.supervisor), "", "no CONFIRM and no SETTLE");
});

test("an attach refusal consumes asynchronous process and stdio errors and stops the exact supervisor handle", async () => {
  const h = makeHarness();
  h.supervisor.pid = undefined;
  h.supervisor.exitOnKill = false;
  const launching = h.adapter.launch();
  setImmediate(() => {
    // A real spawn can emit these after the transport has already refused the
    // handle for its missing PID. The transport never registers its stdio
    // listeners on that path, so each exact stream error must be consumed here.
    h.supervisor.stdout.destroy(new Error("synthetic asynchronous stdout error"));
    h.supervisor.emit("error", new Error("synthetic asynchronous spawn error"));
    void h.supervisor.exit(null, "SIGTERM");
  });

  assert.deepEqual(await launching, {
    status: "failed",
    code: "supervisor-attach-refused",
    detail: "child-not-running",
  });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "no-child-possible");
  assert.equal(stopped.supervisorSpawned, true);
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(stopped.wrapperSpawned, false);
  assert.equal(stopped.confirmMayHaveBeenWritten, false);
  assert.equal(h.supervisor.kills, 1);
  assert.equal(h.supervisor.stdout.destroyed, true, "the asynchronous stdout error was delivered");
  assert.equal(commandsWritten(h.supervisor), "", "no CONFIRM and no SETTLE");
});

test("a disposal exception still kills the exact supervisor and wrapper and observes both closures", async () => {
  const h = makeHarness();
  const { launching } = await startToReady(h);
  assert.equal(h.wrapper.pid, 0, "the PTY PID has not become positive yet");

  const stdin = h.supervisor.stdin as unknown as { destroy: (...args: never[]) => void };
  const originalDestroy = stdin.destroy;
  let threw = false;
  stdin.destroy = (() => {
    threw = true;
    throw new Error("synthetic stdin destroy failure");
  }) as typeof originalDestroy;

  try {
    const stopping = h.adapter.stop();
    assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
    const stopped = await stopping;
    assert.equal(threw, true, "the dispose fault was injected");
    assert.equal(stopped.status, "no-child-possible");
    assert.equal(stopped.supervisorSpawned, true);
    assert.equal(stopped.supervisorClosed, true);
    assert.equal(stopped.wrapperSpawned, true);
    assert.equal(stopped.wrapperExited, true);
    assert.equal(stopped.confirmMayHaveBeenWritten, false);
    assert.equal(stopped.childEstablished, false);
    assert.equal(h.supervisor.kills, 1, "the exact supervisor fallback kill happens once");
    assert.equal(h.wrapper.killCount, 1, "the exact wrapper is killed once");
    assert.equal(commandsWritten(h.supervisor), "", "no CONFIRM and no SETTLE");
  } finally {
    stdin.destroy = originalDestroy;
  }
});

test("stop stores its single-flight promise before abort can synchronously reenter it from kill", async () => {
  const h = makeHarness();
  let reentered: Promise<unknown> | null = null;
  h.supervisor.onKill = () => {
    reentered = h.adapter.stop();
  };
  const launching = h.adapter.launch();
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");

  const firstStop = h.adapter.stop();
  assert.equal(reentered, firstStop, "the synchronous kill reentry gets the same promise");
  assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
  const stopped = await firstStop;
  assert.equal(stopped.status, "no-child-possible");
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(stopped.wrapperSpawned, false);
  assert.equal(commandsWritten(h.supervisor), "", "no CONFIRM and no SETTLE");
});

test("synchronous spawn throws are closed, bounded, and retain uncertainty", async () => {
  const supervisorThrow = makeHarness({ spawnSupervisorThrows: true });
  assert.deepEqual(await supervisorThrow.adapter.launch(), {
    status: "failed",
    code: "supervisor-spawn-uncertain",
  });
  const supervisorStopped = await supervisorThrow.adapter.stop();
  assert.equal(supervisorStopped.status, "unproven");
  assert.equal(supervisorStopped.reason, "spawn-uncertain");
  assert.equal(supervisorStopped.supervisorSpawned, false);
  assert.equal(supervisorStopped.wrapperSpawned, false);

  const wrapperThrow = makeHarness({ spawnWrapperThrows: true });
  const launching = wrapperThrow.adapter.launch();
  await waitFor(() => wrapperThrow.supervisor.writtenText.length > 0, "supervisor boot frame");
  await wrapperThrow.supervisor.line(`SUP_READY ${SUP_PID}`);
  assert.deepEqual(await launching, {
    status: "failed",
    code: "wrapper-spawn-uncertain",
  });
  const wrapperStopped = await wrapperThrow.adapter.stop();
  assert.equal(wrapperStopped.status, "unproven");
  assert.equal(wrapperStopped.reason, "spawn-uncertain");
  assert.equal(wrapperStopped.supervisorClosed, true);
  assert.equal(wrapperStopped.wrapperSpawned, false);
  assert.equal(commandsWritten(wrapperThrow.supervisor), "", "no CONFIRM and no SETTLE");
});

test("a PTY exit after spawn but before CONFIRM closes the launch without a false ready and proves no child", async () => {
  const h = makeHarness();
  const { launching } = await startToReady(h);
  h.wrapper.setPid(WRAP_PID);
  h.wrapper.emitExit({ exitCode: 1 });

  assert.deepEqual(await launching, { status: "failed", code: "wrapper-exited" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "no-child-possible");
  assert.equal(stopped.childEstablished, false);
  assert.equal(stopped.confirmMayHaveBeenWritten, false);
  assert.equal(stopped.settleAttempted, false);
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(stopped.wrapperExited, true);
  assert.equal(commandsWritten(h.supervisor), "", "exit is never used as target/job proof");
});

test("an unobservable PTY exit surface fails closed and keeps stop unproven", async () => {
  const h = makeHarness();
  h.wrapper.onExitThrows = true;
  const launching = h.adapter.launch();
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => h.wrapperLaunches.length === 1, "wrapper spawn");
  assert.deepEqual(await launching, {
    status: "failed",
    code: "wrapper-unobservable",
  });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "handle-unobserved");
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(stopped.wrapperSpawned, true);
  assert.equal(stopped.wrapperExited, false);
  assert.equal(commandsWritten(h.supervisor), "", "no CONFIRM and no SETTLE");
});

test("a PTY PID first returned after the monotonic deadline never enters CONFIRM", async () => {
  const h = makeHarness({ wrapperPid: WRAP_PID, deadlines: { wrapperPidMs: 10 } });
  h.wrapper.onPidRead = () => {
    const until = performance.now() + 40;
    while (performance.now() < until) {
      // Synchronously cross the PID deadline before returning a positive value.
    }
  };
  const launching = h.adapter.launch();
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);

  assert.deepEqual(await launching, {
    status: "failed",
    code: "wrapper-pid-unavailable",
  });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "no-child-possible");
  assert.equal(stopped.confirmMayHaveBeenWritten, false);
  assert.equal(stopped.childEstablished, false);
  assert.equal(commandsWritten(h.supervisor), "", "the late positive PID is never confirmed");
});

test("rendering and a throwing/non-boolean run predicate are closed before any spawn", async () => {
  const badRenderer = makeHarness({ powershellPath: String.raw`C:\Temp\powershell.exe` });
  assert.deepEqual(await badRenderer.adapter.launch(), {
    status: "failed",
    code: "rendering-failed",
    detail: "supervisor",
  });
  const badRendererStop = await badRenderer.adapter.stop();
  assert.equal(badRendererStop.status, "no-child-possible");
  assert.equal(badRenderer.supervisorLaunches.length, 0);
  assert.equal(badRenderer.wrapperLaunches.length, 0);

  const throwing = makeHarness({
    isRunCurrent: () => {
      throw new Error("host predicate failed");
    },
  });
  assert.deepEqual(await throwing.adapter.launch(), { status: "failed", code: "run-not-current" });
  const throwingStop = await throwing.adapter.stop();
  assert.equal(throwingStop.status, "no-child-possible");
  assert.equal(throwing.supervisorLaunches.length, 0);

  const nonBoolean = makeHarness({ isRunCurrent: () => "yes" as unknown as boolean });
  assert.deepEqual(await nonBoolean.adapter.launch(), { status: "failed", code: "run-not-current" });
  assert.equal((await nonBoolean.adapter.stop()).status, "no-child-possible");
});

test("a non-empty job settlement stays unproven and stops both exact handles", async () => {
  const h = makeHarness();
  await driveToChild(h);
  const stopping = h.adapter.stop();
  await waitFor(() => commandsWritten(h.supervisor).includes("SETTLE\n"), "SETTLE write");
  // The real transport treats a nonzero job count as a poison, never settlement.
  await h.supervisor.line("SUP_SETTLED ACTIVE=1 LISTED=0");

  const failed = await stopping;
  assert.equal(failed.status, "unproven");
  assert.equal(failed.reason, "settlement-failed");
  assert.equal(failed.witness, null);
  assert.equal(failed.childEstablished, true);
  assert.equal(failed.supervisorClosed, true);
  assert.equal(failed.wrapperExited, true);
  assert.ok(h.supervisor.kills >= 1);
  assert.ok(h.wrapper.killCount >= 1);
  assert.equal(commandsWritten(h.supervisor), `CONFIRM ${WRAP_PID}\nSETTLE\n`);
});

/* ------------------------------------------------- opt-in hook channel */

/** Synthetic, inert values only. */
const HOOK_PIPE = "prg682-hook-00112233445566778899aabbccddeeff";
const HOOK_KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HOOK = Object.freeze({ pipe: HOOK_PIPE, key: HOOK_KEY });
const KEY_FRAME = `${WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC}${HOOK_KEY} ${RUN.runId}\n`;
const UUID_A = "01234567-89ab-cdef-0123-456789abcdef";
const UUID_B = "fedcba98-7654-3210-fedc-ba9876543210";

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * The returned object exposes no key holder and no key handoff entry point:
 * neither as an own property nor anywhere on its prototype chain, and the key
 * is absent from a full inspection.
 */
function assertNoKeySurface(adapter: NativeWindowsClaudeCustodyAdapter, label = ""): void {
  const forbidden = /takeHookKey|startTransport|hookKey/iu;
  for (let target: object | null = adapter; target !== null && target !== Object.prototype; target = Object.getPrototypeOf(target)) {
    for (const name of Reflect.ownKeys(target)) {
      assert.ok(!forbidden.test(String(name)), `${label}: ${String(name)} must not be reachable`);
    }
  }
  assert.ok(!("takeHookKey" in adapter) && !("startTransport" in adapter), label);
  assert.ok(!inspect(adapter, { showHidden: true, depth: Infinity }).includes(HOOK_KEY), label);
}

/** Every caller-visible rendering of a launch descriptor. */
function describeSupervisorLaunch(launch: WindowsClaudeCustodySupervisorLaunch): string {
  return [
    launch.file,
    ...launch.args,
    launch.bootstrap,
    launch.source,
    launch.encoded,
    Buffer.from(launch.encoded, "base64").toString("utf16le"),
    launch.startupFrame.toString("latin1"),
    launch.sourceSha256,
    JSON.stringify(launch.spawnOptions),
  ].join("\n");
}

function describeWrapperLaunch(launch: WindowsClaudeCustodyWrapperLaunch): string {
  return [JSON.stringify(launch), ...launch.args, Buffer.from(launch.args.at(-1) ?? "", "base64").toString("utf16le")].join("\n");
}

async function advanceToChild(h: Harness, launching: Promise<NativeWindowsClaudeCustodyLaunchResult>): Promise<void> {
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => h.wrapperLaunches.length === 1, "wrapper spawn");
  h.wrapper.setPid(WRAP_PID);
  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  await waitFor(() => commandsWritten(h.supervisor).includes(`CONFIRM ${WRAP_PID}\n`), "CONFIRM write");
  await h.supervisor.line(`SUP_GO ${WRAP_PID}`);
  await h.supervisor.line(`SUP_CHILD ${CHILD_PID}`);
  assert.deepEqual(await launching, { status: "launched", supervisorPid: SUP_PID, wrapperPid: WRAP_PID, childPid: CHILD_PID });
}

test("opt-in hook launch composes hookPipe, hookCandidates, and one private key frame, and retains no key", async () => {
  const h = makeHarness({ hookChannel: HOOK });
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "not-established" });
  const launching = h.adapter.launch();
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");

  assert.equal(h.supervisorLaunches.length, 1);
  const supervisorLaunch = h.supervisorLaunches[0]!;
  // Renderer opt-in: the nonsecret pipe name is rendered; the key never is.
  assert.ok(supervisorLaunch.source.includes(`$WckName='${HOOK_PIPE}'`));
  assert.ok(!describeSupervisorLaunch(supervisorLaunch).includes(HOOK_KEY), "no key in descriptor, source, argv, or frame");
  assert.ok(!("env" in supervisorLaunch.spawnOptions), "no environment is carried by the descriptor");
  // Transport opt-in: one write, boot frame then exactly one key frame for the pinned run.
  assert.equal(h.supervisor.handed.length, 1, "boot and key frames travel in ONE write");
  assert.equal(h.supervisor.writtenText, `${supervisorLaunch.startupFrame.toString("latin1")}${KEY_FRAME}`);
  await waitFor(() => h.supervisor.handed[0]!.every((byte) => byte === 0), "key-bearing write buffer scrubbed");
  assertNoKeySurface(h.adapter, "after the startup handoff");

  await advanceToChild(h, launching);
  const wrapperLaunch = h.wrapperLaunches[0]!;
  assert.ok(!describeWrapperLaunch(wrapperLaunch).includes(HOOK_KEY), "no key in the PTY launch");
  assert.ok(!describeWrapperLaunch(wrapperLaunch).includes("prg682-hook-"), "the wrapper render is unchanged");

  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "none" });
  await h.supervisor.line(`SUP_CAND 1 ${UUID_A}`);
  const observed = h.adapter.observeHookCandidate(RUN);
  assert.deepEqual(observed, { status: "candidate", candidate: { sequence: 1, sessionId: UUID_A } });
  assert.ok(Object.isFrozen(observed) && observed.status === "candidate" && Object.isFrozen(observed.candidate));
  assert.deepEqual(Object.keys(observed.status === "candidate" ? observed.candidate : {}).sort(), ["sequence", "sessionId"]);
  assert.notEqual(h.adapter.observeHookCandidate(RUN), observed, "each observation is a fresh copy");

  const stopping = h.adapter.stop();
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
  await waitFor(() => commandsWritten(h.supervisor).includes("SETTLE\n"), "SETTLE write");
  // A genuine in-flight candidate during settlement is tolerated, never published.
  await h.supervisor.line(`SUP_CAND 2 ${UUID_B}`);
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
  const stopped = await finishSettlement(h, stopping);
  assert.deepEqual(stopped, {
    status: "witnessed-empty",
    witness: { supervisorPid: SUP_PID, jobActive: 0, jobListed: 0, exitCode: 0 },
    supervisorSpawned: true,
    supervisorClosed: true,
    wrapperSpawned: true,
    wrapperExited: true,
    childEstablished: true,
    confirmMayHaveBeenWritten: true,
    settleAttempted: true,
  });
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
  assert.equal(commandsWritten(h.supervisor), `${KEY_FRAME}CONFIRM ${WRAP_PID}\nSETTLE\n`);
  assert.equal(occurrences(h.supervisor.writtenText, HOOK_KEY), 1, "the key crossed the private pipe exactly once");
  assert.ok(!JSON.stringify([stopped, observed]).includes(HOOK_KEY));
  assertNoKeySurface(h.adapter, "after settlement");
  assert.equal(h.supervisor.kills, 0);
  assert.equal(h.wrapper.killCount, 0);
});

test("a malformed opt-in hook channel refuses before any spawn and never falls back to the default", async () => {
  const throwing = new Proxy({}, { get: () => { throw new Error("hostile getter"); } });
  const cases: readonly unknown[] = [
    null,
    "prg682-hook",
    [],
    {},
    { pipe: HOOK_PIPE },
    { key: HOOK_KEY },
    { pipe: "prg682-ctl-00112233445566778899aabbccddeeff", key: HOOK_KEY },
    { pipe: HOOK_PIPE.toUpperCase(), key: HOOK_KEY },
    { pipe: `${HOOK_PIPE}0`, key: HOOK_KEY },
    { pipe: `\\\\.\\pipe\\${HOOK_PIPE}`, key: HOOK_KEY },
    { pipe: HOOK_PIPE, key: HOOK_KEY.toUpperCase() },
    { pipe: HOOK_PIPE, key: HOOK_KEY.slice(1) },
    { pipe: HOOK_PIPE, key: `${HOOK_KEY}\n` },
    { pipe: HOOK_PIPE, key: 0xa1b2 },
    { pipe: HOOK_PIPE, key: null },
    throwing,
  ];
  for (const hookChannel of cases) {
    const h = makeHarness({ hookChannel });
    const label = inspect(hookChannel);
    assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "not-established" }, label);
    const result = await h.adapter.launch();
    assert.deepEqual(result, { status: "failed", code: "options-invalid" }, label);
    assert.equal(h.supervisorLaunches.length, 0, `${label}: no supervisor spawn`);
    assert.equal(h.wrapperLaunches.length, 0, `${label}: no wrapper spawn`);
    assert.equal(h.supervisor.writtenText, "", `${label}: nothing written`);
    const stopped = await h.adapter.stop();
    assert.equal(stopped.status, "no-child-possible", label);
    assert.equal(stopped.supervisorSpawned, false, label);
    assertNoKeySurface(h.adapter, label);
    assert.ok(!JSON.stringify([result, stopped]).includes(HOOK_KEY), label);
  }
});

test("opt-in hook inputs are read once and pinned at construction", async () => {
  let pipeReads = 0;
  let keyReads = 0;
  const shifting = {
    get pipe(): string {
      pipeReads += 1;
      return pipeReads === 1 ? HOOK_PIPE : "not-a-pipe";
    },
    get key(): string {
      keyReads += 1;
      return keyReads === 1 ? HOOK_KEY : "f".repeat(64);
    },
  };
  const h = makeHarness({ hookChannel: shifting });
  assert.equal(pipeReads, 1);
  assert.equal(keyReads, 1);
  const launching = h.adapter.launch();
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  assert.equal(pipeReads, 1, "the launch never re-reads the caller's object");
  assert.equal(keyReads, 1, "the launch never re-reads the caller's object");
  assert.ok(h.supervisorLaunches[0]!.source.includes(`$WckName='${HOOK_PIPE}'`));
  assert.ok(h.supervisor.writtenText.endsWith(KEY_FRAME));

  const stopping = h.adapter.stop();
  assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
  const stopped = await stopping;
  assert.equal(stopped.status, "no-child-possible");
  assert.equal(h.wrapperLaunches.length, 0);
});

test("hook candidates are observable only for the exact current run of a published launch", async () => {
  let current = true;
  let throwPredicate = false;
  const h = makeHarness({
    hookChannel: HOOK,
    isRunCurrent: () => {
      if (throwPredicate) throw new Error("predicate fault");
      return current;
    },
  });
  const launching = h.adapter.launch();
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "not-established" });
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => h.wrapperLaunches.length === 1, "wrapper spawn");
  h.wrapper.setPid(WRAP_PID);
  await h.supervisor.line(`SUP_WRAPPER ${WRAP_PID} PROVISIONAL`);
  await waitFor(() => commandsWritten(h.supervisor).includes(`CONFIRM ${WRAP_PID}\n`), "CONFIRM write");
  await h.supervisor.line(`SUP_GO ${WRAP_PID}`);

  // An early candidate in the SAME chunk as SUP_CHILD: the transport credits
  // it at once, but the adapter has not published its launch yet.
  const early: unknown[] = [];
  const onData = (chunk: Buffer): void => {
    if (!chunk.toString("latin1").includes("SUP_CHILD")) return;
    h.supervisor.stdout.off("data", onData);
    early.push(h.adapter.observeHookCandidate(RUN));
  };
  h.supervisor.stdout.on("data", onData);
  h.supervisor.stdout.write(`SUP_CHILD ${CHILD_PID}\nSUP_CAND 1 ${UUID_A}\n`);
  assert.equal((await launching).status, "launched");
  assert.deepEqual(early, [{ status: "refused", code: "not-established" }]);
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "candidate", candidate: { sequence: 1, sessionId: UUID_A } });

  const foreign: readonly unknown[] = [
    { runId: "run-682-other", generation: RUN.generation },
    { runId: RUN.runId, generation: RUN.generation + 1 },
    { runId: "", generation: RUN.generation },
    { runId: RUN.runId, generation: 0 },
    { runId: RUN.runId },
    null,
    undefined,
    RUN.runId,
    new Proxy({}, { get: () => { throw new Error("hostile context"); } }),
  ];
  for (const context of foreign) {
    assert.deepEqual(
      h.adapter.observeHookCandidate(context as NativeWindowsClaudeCustodyRun),
      { status: "refused", code: "run-not-current" },
      inspect(context),
    );
  }
  assert.deepEqual(
    h.adapter.observeHookCandidate({ runId: RUN.runId, generation: RUN.generation }),
    { status: "candidate", candidate: { sequence: 1, sessionId: UUID_A } },
    "an equal (not identical) exact run context is accepted",
  );

  current = false;
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "run-not-current" });
  current = true;
  throwPredicate = true;
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "run-not-current" });
  throwPredicate = false;

  await h.supervisor.line(`SUP_CAND 2 ${UUID_B}`);
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "candidate", candidate: { sequence: 2, sessionId: UUID_B } });

  // A malformed (out-of-sequence) candidate poisons the real transport: the
  // held candidate is never published again.
  await h.supervisor.line(`SUP_CAND 4 ${UUID_A}`);
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
  const stopped = await h.adapter.stop();
  assert.equal(stopped.status, "unproven");
  assert.equal(stopped.reason, "settlement-failed");
  assert.equal(stopped.supervisorClosed, true);
  assert.equal(stopped.wrapperExited, true);
  assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
  assert.equal(occurrences(h.supervisor.writtenText, HOOK_KEY), 1);
});

test("caller cancellation, PTY exit, and a reentrant stop close candidate publication", async () => {
  // Caller abort after publication.
  {
    const abort = new AbortController();
    const h = makeHarness({ hookChannel: HOOK, signal: abort.signal });
    await advanceToChild(h, h.adapter.launch());
    await h.supervisor.line(`SUP_CAND 1 ${UUID_A}`);
    assert.equal(h.adapter.observeHookCandidate(RUN).status, "candidate");
    abort.abort();
    assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
    const stopped = await finishSettlement(h, h.adapter.stop());
    assert.equal((stopped as { status: string }).status, "witnessed-empty");
  }
  // PTY exit after publication triggers the same bounded stop/settle.
  {
    const h = makeHarness({ hookChannel: HOOK });
    await advanceToChild(h, h.adapter.launch());
    await h.supervisor.line(`SUP_CAND 1 ${UUID_A}`);
    h.wrapper.emitExit({ exitCode: 3 });
    assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
    const stopped = await finishSettlement(h, h.adapter.stop());
    assert.equal((stopped as { status: string }).status, "witnessed-empty");
    assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
  }
  // The host predicate is caller code: a stop requested from inside it wins.
  {
    let reenter = false;
    let adapter: NativeWindowsClaudeCustodyAdapter | undefined;
    let stopping: Promise<unknown> | undefined;
    const h = makeHarness({
      hookChannel: HOOK,
      isRunCurrent: () => {
        if (reenter && adapter !== undefined) {
          reenter = false;
          stopping = adapter.stop();
        }
        return true;
      },
    });
    adapter = h.adapter;
    await advanceToChild(h, h.adapter.launch());
    await h.supervisor.line(`SUP_CAND 1 ${UUID_A}`);
    reenter = true;
    assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "custody-not-current" });
    assert.ok(stopping !== undefined);
    const stopped = await finishSettlement(h, stopping);
    assert.equal((stopped as { status: string }).status, "witnessed-empty");
  }
});

test("opt-in boot cancellation, an early stop, and an attach refusal never hand out the key afterwards", async () => {
  // Stop before launch: nothing spawned, nothing written, key dropped.
  {
    const h = makeHarness({ hookChannel: HOOK });
    assertNoKeySurface(h.adapter, "before launch");
    const stopping = h.adapter.stop();
    assert.deepEqual(await h.adapter.launch(), { status: "failed", code: "cancelled" });
    assert.equal((await stopping).status, "no-child-possible");
    assert.equal(h.supervisorLaunches.length, 0);
  }
  // Attach refusal (no supervisor PID): the key is never written and is dropped.
  {
    const h = makeHarness({ hookChannel: HOOK, supervisorPid: undefined });
    const result = await h.adapter.launch();
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.code : "", "supervisor-attach-refused");
    assert.equal(h.supervisor.writtenText, "");
    assert.equal(h.wrapperLaunches.length, 0);
    assertNoKeySurface(h.adapter, "after an attach refusal");
    await h.adapter.stop();
  }
  // Cancellation during boot after the key frame: no wrapper, no CONFIRM.
  {
    const abort = new AbortController();
    const h = makeHarness({ hookChannel: HOOK, signal: abort.signal });
    const launching = h.adapter.launch();
    await waitFor(() => h.supervisor.writtenText.endsWith(KEY_FRAME), "key frame");
    abort.abort();
    assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
    const stopped = await h.adapter.stop();
    assert.equal(stopped.status, "no-child-possible");
    assert.equal(h.wrapperLaunches.length, 0);
    assert.equal(commandsWritten(h.supervisor), KEY_FRAME, "no CONFIRM and no SETTLE");
    assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "not-established" });
  }
});

test("the start options handed to the real transport no longer hold the key during the boot wait", async () => {
  type Attach = typeof custodyProtocol.attachNativeWindowsClaudeCustodyTransport;
  const exportsTable = custodyProtocol as unknown as Record<string, unknown>;
  const realAttach = exportsTable.attachNativeWindowsClaudeCustodyTransport as Attach;
  const seen: { attachOptions?: NativeWindowsClaudeCustodyTransportOptions; startOptions?: NativeWindowsClaudeCustodyStartOptions; keyAtCall?: boolean } = {};
  const wrapped: Attach = (options) => {
    seen.attachOptions = options;
    const attached = realAttach(options);
    if (attached.status !== "attached") return attached;
    const transport = attached.transport;
    const realStart = transport.start.bind(transport);
    (transport as { start: typeof transport.start }).start = (source, startOptions) => {
      seen.startOptions = startOptions;
      seen.keyAtCall = startOptions?.hookKey === HOOK_KEY;
      return realStart(source, startOptions);
    };
    return attached;
  };
  exportsTable.attachNativeWindowsClaudeCustodyTransport = wrapped;
  try {
    const h = makeHarness({ hookChannel: HOOK });
    const launching = h.adapter.launch();
    await waitFor(() => h.supervisor.writtenText.endsWith(KEY_FRAME), "key frame");
    assert.equal(seen.attachOptions?.hookCandidates, true, "the transport was attached in opt-in mode");
    assert.equal(TEST_DEADLINES.settleMs < DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES.settleMs, true);
    assert.equal(
      seen.attachOptions?.deadlines?.settleMs,
      DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES.settleMs,
      "hook mode floors a short settle override at the shipped default",
    );
    assert.equal(seen.attachOptions?.deadlines?.readyMs, TEST_DEADLINES.readyMs, "other overrides are unchanged");
    assert.equal(seen.keyAtCall, true, "the key was handed to the real start call");
    const startOptions = seen.startOptions as Record<string, unknown> | undefined;
    assert.ok(startOptions !== undefined);
    // Still waiting for SUP_READY: the transport's boot step keeps this object.
    assert.ok(!("hookKey" in startOptions), "the short-lived start options dropped the key synchronously");
    assert.ok(!Object.values(startOptions).includes(HOOK_KEY));
    assert.ok(!inspect(startOptions, { showHidden: true, depth: Infinity }).includes(HOOK_KEY));
    await advanceToChild(h, launching);
    assert.equal(occurrences(h.supervisor.writtenText, HOOK_KEY), 1);
    await finishSettlement(h, h.adapter.stop());
  } finally {
    exportsTable.attachNativeWindowsClaudeCustodyTransport = realAttach;
  }
  // The ordinary path still starts with exactly `{ signal }` and no attach opt-in.
  const ordinarySeen: { attach?: NativeWindowsClaudeCustodyTransportOptions; start?: NativeWindowsClaudeCustodyStartOptions } = {};
  exportsTable.attachNativeWindowsClaudeCustodyTransport = ((options) => {
    ordinarySeen.attach = options;
    const attached = realAttach(options);
    if (attached.status === "attached") {
      const transport = attached.transport;
      const realStart = transport.start.bind(transport);
      (transport as { start: typeof transport.start }).start = (source, startOptions) => {
        ordinarySeen.start = startOptions;
        return realStart(source, startOptions);
      };
    }
    return attached;
  }) as Attach;
  try {
    const h = makeHarness();
    const launching = h.adapter.launch();
    await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
    assert.ok(ordinarySeen.attach !== undefined && !("hookCandidates" in ordinarySeen.attach));
    assert.equal(ordinarySeen.attach.deadlines?.settleMs, TEST_DEADLINES.settleMs, "the ordinary path keeps the override");
    assert.deepEqual(Object.keys(ordinarySeen.start ?? {}), ["signal"]);
    const stopping = h.adapter.stop();
    assert.deepEqual(await launching, { status: "failed", code: "cancelled" });
    assert.equal((await stopping).status, "no-child-possible");
  } finally {
    exportsTable.attachNativeWindowsClaudeCustodyTransport = realAttach;
  }
});

test("a throwing top-level hookChannel read is a closed refusal, read once, with no spawn or disclosure", async () => {
  const marker = "raw-hook-getter-fault-682";
  let reads = 0;
  let supervisorSpawns = 0;
  let wrapperSpawns = 0;
  const options = {
    powershellPath: POWERSHELL_PATH,
    target: TARGET_PATH,
    run: RUN,
    isRunCurrent: () => true,
    deadlines: TEST_DEADLINES,
    spawnSupervisor: (): ChildProcess => {
      supervisorSpawns += 1;
      throw new Error("never called");
    },
    spawnWrapper: (): NativeWindowsClaudeCustodyWrapperHandle => {
      wrapperSpawns += 1;
      throw new Error("never called");
    },
    get hookChannel(): NativeWindowsClaudeCustodyAdapterOptions["hookChannel"] {
      reads += 1;
      throw new Error(marker);
    },
  };
  let adapter: NativeWindowsClaudeCustodyHookAdapter | undefined;
  assert.doesNotThrow(() => {
    adapter = createNativeWindowsClaudeCustodyAdapter(options as NativeWindowsClaudeCustodyAdapterOptions) as NativeWindowsClaudeCustodyHookAdapter;
  });
  assert.ok(adapter !== undefined);
  assert.equal(reads, 1);
  assert.deepEqual(adapter.observeHookCandidate(RUN), { status: "refused", code: "not-established" });
  const result = await adapter.launch();
  assert.deepEqual(result, { status: "failed", code: "options-invalid" });
  const stopped = await adapter.stop();
  assert.equal(stopped.status, "no-child-possible");
  assert.equal(reads, 1, "the getter is never re-read");
  assert.equal(supervisorSpawns, 0);
  assert.equal(wrapperSpawns, 0);
  assert.ok(!JSON.stringify([result, stopped]).includes(marker), "no raw exception text is disclosed");
  assertNoKeySurface(adapter, "throwing top-level getter");
});

test("without the opt-in, the adapter keeps the exact default composition and grammar", async () => {
  for (const overrides of [{}, { hookChannel: undefined }] as const) {
    const h = makeHarness(overrides);
    const launching = h.adapter.launch();
    await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
    const supervisorLaunch = h.supervisorLaunches[0]!;
    const ctlPipe = /\$CtlName='(prg682-ctl-[0-9a-f]{32})'/u.exec(supervisorLaunch.source)?.[1];
    const ctlNonce = /\$Nonce='([0-9a-f]{32})'/u.exec(supervisorLaunch.source)?.[1];
    assert.ok(ctlPipe !== undefined && ctlNonce !== undefined);
    const reference = buildWindowsClaudeCustodySupervisorLaunch({ powershellPath: POWERSHELL_PATH, ctlPipe, ctlNonce });
    assert.equal(supervisorLaunch.source, reference.source, "default supervisor, byte for byte");
    assert.deepEqual(supervisorLaunch.args, reference.args);
    assert.ok(!supervisorLaunch.source.includes("prg682-hook-"));
    assert.equal(h.supervisor.writtenText, reference.startupFrame.toString("latin1"), "no key frame");

    await advanceToChild(h, launching);
    assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "hook-disabled" });
    // The default transport grammar is unchanged: SUP_CAND is unsolicited.
    await h.supervisor.line(`SUP_CAND 1 ${UUID_A}`);
    assert.deepEqual(h.adapter.observeHookCandidate(RUN), { status: "refused", code: "hook-disabled" });
    const stopped = await h.adapter.stop();
    assert.equal(stopped.status, "unproven");
    assert.equal(commandsWritten(h.supervisor), `CONFIRM ${WRAP_PID}\n`, "a poisoned transport never sends SETTLE");
    assert.ok(!h.supervisor.writtenText.includes(WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC));
  }
  // The ordinary factory signature exposes no candidate surface at all.
  const ordinary = createNativeWindowsClaudeCustodyAdapter({
    powershellPath: POWERSHELL_PATH,
    target: TARGET_PATH,
    run: RUN,
    isRunCurrent: () => true,
    spawnSupervisor: () => { throw new Error("never called"); },
    spawnWrapper: () => { throw new Error("never called"); },
  });
  // @ts-expect-error observeHookCandidate exists only on the opt-in factory overload.
  assert.equal(typeof ordinary.observeHookCandidate, "function");
  assert.equal((await ordinary.stop()).status, "no-child-possible");
});

test("opt-in hook control composes the landed control mode and forwards exact bind, send, and drop", async () => {
  type Attach = typeof custodyProtocol.attachNativeWindowsClaudeCustodyTransport;
  const exportsTable = custodyProtocol as unknown as Record<string, unknown>;
  const realAttach = exportsTable.attachNativeWindowsClaudeCustodyTransport as Attach;
  let attachOptions: NativeWindowsClaudeCustodyTransportOptions | undefined;
  exportsTable.attachNativeWindowsClaudeCustodyTransport = ((options) => {
    attachOptions = options;
    return realAttach(options);
  }) as Attach;
  try {
    const h = makeHarness({ hookChannel: { ...HOOK, control: true } });
    const control = h.adapter as unknown as NativeWindowsClaudeCustodyControlAdapter;
    const binding = Object.freeze({ sequence: 1, sessionId: UUID_A });
    const fence = Object.freeze({ isBindingCurrent: () => true });
    assert.deepEqual(control.observeHookBinding(RUN), { status: "refused", code: "custody-not-current" }, "nothing before launch");

    const launching = h.adapter.launch();
    await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
    // Renderer and transport opt-ins are exactly the landed control mode.
    const supervisorLaunch = h.supervisorLaunches[0]!;
    const ctlPipe = /\$CtlName='(prg682-ctl-[0-9a-f]{32})'/u.exec(supervisorLaunch.source)?.[1];
    const ctlNonce = /\$Nonce='([0-9a-f]{32})'/u.exec(supervisorLaunch.source)?.[1];
    assert.ok(ctlPipe !== undefined && ctlNonce !== undefined);
    const reference = buildWindowsClaudeCustodySupervisorLaunch({
      powershellPath: POWERSHELL_PATH, ctlPipe, ctlNonce, hookPipe: HOOK_PIPE, hookControl: true,
    });
    assert.equal(supervisorLaunch.source, reference.source, "the control supervisor, byte for byte");
    assert.equal(attachOptions?.hookCandidates, true);
    assert.equal(attachOptions?.hookControl, true);
    assert.equal(attachOptions?.deadlines?.settleMs, NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS, "the paired control stop floor");
    assert.equal(h.supervisor.writtenText, `${reference.startupFrame.toString("latin1")}${KEY_FRAME}`);
    await advanceToChild(h, launching);

    // A foreign run never reaches the transport.
    assert.deepEqual(
      await control.bindHookCandidate({ runId: "run-682-other", generation: RUN.generation }, binding, fence),
      { status: "refused", code: "run-not-current" },
    );
    await h.supervisor.line(`SUP_CAND 1 ${UUID_A}`);
    const binding1 = control.bindHookCandidate(RUN, binding, fence);
    await waitFor(() => commandsWritten(h.supervisor).endsWith("BIND 1\n"), "BIND write");
    await h.supervisor.line("SUP_BIND 1 OK");
    assert.deepEqual(await binding1, { status: "bound", binding });
    assert.deepEqual(control.observeHookBinding(RUN), { status: "bound", binding });

    const commit = control.commitHookSend(RUN, () => "wake", { ...fence, binding });
    assert.equal(commit.status, "dispatched");
    const body = Buffer.from("wake", "utf8").toString("base64");
    await waitFor(() => commandsWritten(h.supervisor).endsWith(`SEND 1 1 ${body.length}\n${body}\n`), "SEND frame");
    await h.supervisor.line("SUP_SENT 1 SENT");
    assert.deepEqual(commit.status === "dispatched" ? await commit.outcome : undefined, { status: "sent-unconfirmed", attemptId: 1 });

    const dropping = control.dropHookCandidate(RUN, 1);
    assert.deepEqual(control.observeHookBinding(RUN), { status: "none" }, "local authority ends before the reply");
    await waitFor(() => commandsWritten(h.supervisor).endsWith("DROP 1\n"), "DROP write");
    await h.supervisor.line("SUP_DROP 1");
    assert.deepEqual(await dropping, { status: "dropped", sequence: 1 });
    let produced = 0;
    assert.deepEqual(
      control.commitHookSend(RUN, () => { produced += 1; return "late"; }, { ...fence, binding }),
      { status: "not-sent", code: "binding-not-current" },
    );
    // The host pre-write budget is checked LAST, after the final fence read: an
    // expiry crossed inside the final custody checks writes nothing.
    await h.supervisor.line(`SUP_CAND 2 ${UUID_A}`);
    const binding2 = Object.freeze({ sequence: 2, sessionId: UUID_A });
    const binding2Result = control.bindHookCandidate(RUN, binding2, fence);
    await waitFor(() => commandsWritten(h.supervisor).endsWith("BIND 2\n"), "BIND 2 write");
    await h.supervisor.line("SUP_BIND 2 OK");
    assert.equal((await binding2Result).status, "bound");
    const before = commandsWritten(h.supervisor);
    let reads = 0;
    const slowFence = {
      binding: binding2,
      isBindingCurrent: () => {
        reads += 1;
        if (reads >= 2) {
          const until = performance.now() + 40;
          while (performance.now() < until) { /* the final fence crosses the budget */ }
        }
        return true;
      },
      writeBudget: { expiresAt: performance.now() + 20 },
    };
    assert.deepEqual(control.commitHookSend(RUN, () => "late", slowFence), { status: "not-sent", code: "deadline-exceeded" });
    assert.ok(reads >= 2, "the expiry was crossed inside the final fence");
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(
      control.commitHookSend(RUN, () => "late", { ...fence, binding: binding2, writeBudget: { expiresAt: performance.now() + 10_000, signal: aborted.signal } }),
      { status: "not-sent", code: "cancelled" },
    );
    assert.deepEqual(
      control.commitHookSend(RUN, () => "late", { ...fence, binding: binding2, writeBudget: { expiresAt: Number.NaN } }),
      { status: "not-sent", code: "deadline-exceeded" },
    );
    assert.equal(commandsWritten(h.supervisor), before, "no SEND byte for any expired or cancelled budget");
    assert.deepEqual(control.observeHookBinding(RUN), { status: "bound", binding: binding2 }, "a pre-write refusal keeps the binding");

    const stopping = h.adapter.stop();
    assert.deepEqual(control.observeHookBinding(RUN), { status: "refused", code: "custody-not-current" });
    assert.deepEqual(
      control.commitHookSend(RUN, () => { produced += 1; return "late"; }, { ...fence, binding }),
      { status: "not-sent", code: "custody-not-current" },
    );
    assert.equal(produced, 0, "a refused attempt never materializes its payload");
    const stopped = await finishSettlement(h, stopping);
    assert.equal((stopped as { status: string }).status, "witnessed-empty");
    assert.equal(
      commandsWritten(h.supervisor),
      `${KEY_FRAME}CONFIRM ${WRAP_PID}\nBIND 1\nSEND 1 1 ${body.length}\n${body}\nDROP 1\nBIND 2\nSETTLE\n`,
    );
    assert.equal(occurrences(h.supervisor.writtenText, HOOK_KEY), 1, "the key crossed the private pipe exactly once");
    assertNoKeySurface(h.adapter, "control mode");
  } finally {
    exportsTable.attachNativeWindowsClaudeCustodyTransport = realAttach;
  }

  // Candidate-only and default adapters expose no control lane, and a malformed
  // control opt-in refuses before any spawn (never a fallback).
  for (const overrides of [{ hookChannel: HOOK }, {}] as const) {
    const h = makeHarness(overrides);
    const control = h.adapter as unknown as NativeWindowsClaudeCustodyControlAdapter;
    assert.deepEqual(
      await control.bindHookCandidate(RUN, { sequence: 1, sessionId: UUID_A }, { isBindingCurrent: () => true }),
      { status: "refused", code: "control-disabled" },
    );
    assert.deepEqual(
      control.commitHookSend(RUN, () => "x", { isBindingCurrent: () => true, binding: { sequence: 1, sessionId: UUID_A } }),
      { status: "not-sent", code: "lane-unavailable" },
    );
    assert.equal((await h.adapter.stop()).status, "no-child-possible");
  }
  const malformed = makeHarness({ hookChannel: { ...HOOK, control: "yes" } });
  assert.deepEqual(await malformed.adapter.launch(), { status: "failed", code: "options-invalid" });
  assert.equal(malformed.supervisorLaunches.length, 0);
});
