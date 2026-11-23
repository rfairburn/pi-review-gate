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
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES,
  createNativeWindowsClaudeCustodyAdapter,
  type NativeWindowsClaudeCustodyAdapter,
  type NativeWindowsClaudeCustodyAdapterDeadlines,
  type NativeWindowsClaudeCustodyLaunchResult,
  type NativeWindowsClaudeCustodyWrapperHandle,
} from "../src/session-host/native-windows-claude-custody-adapter";
import {
  NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS,
  type NativeWindowsClaudeCustodyRun,
} from "../src/session-host/native-windows-claude-custody-protocol";
import {
  WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC,
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS,
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

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written = Buffer.concat([this.written, chunk]);
    });
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
}

interface Harness {
  readonly adapter: NativeWindowsClaudeCustodyAdapter;
  readonly supervisor: FakeSupervisor;
  readonly wrapper: FakeWrapper;
  readonly supervisorLaunches: WindowsClaudeCustodySupervisorLaunch[];
  readonly wrapperLaunches: WindowsClaudeCustodyWrapperLaunch[];
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const supervisor = new FakeSupervisor();
  const wrapper = new FakeWrapper(overrides.wrapperPid ?? 0);
  const supervisorLaunches: WindowsClaudeCustodySupervisorLaunch[] = [];
  const wrapperLaunches: WindowsClaudeCustodyWrapperLaunch[] = [];
  const adapter = createNativeWindowsClaudeCustodyAdapter({
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
  });
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
