/**
 * #682 dormant native Windows Claude custody — instance-manager composition tests.
 *
 * These tests compose the REAL {@linkcode InstanceManager} with portable fakes:
 * an in-memory supervisor `ChildProcess` (PassThrough pipes, real `Close`/`Exit`
 * events), a synthetic PTY that is both the node-pty handle and the adapter's
 * wrapper handle, and the REAL landed custody adapter for the end-to-end paths.
 * An injected lifecycle-only adapter covers the invariants that need precise
 * interleavings.
 *
 * Nothing is spawned at the OS level, no PowerShell is run, no provider is
 * contacted, and no real Windows path is touched. The Windows host is simulated
 * through the manager's EXISTING platform seam, exactly as its shutdown tests do.
 *
 * EVIDENCE SCOPE: this proves manager composition and bounded ownership
 * invariants only. It does not prove real ConPTY/job behavior, a real Claude
 * child, or any production activation — no production host passes the injection.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_SHUTDOWN_KILL_MS,
  InstanceManager,
  __test,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunch,
  type NativeWindowsClaudeCustodyManagerRequest,
  type NativeWindowsClaudeCustodyManagerSelection,
  type StatusRegistrar,
} from "../src/session-host/instances";
import {
  createNativeWindowsClaudeCustodyAdapter,
  type NativeWindowsClaudeCustodyAdapter,
  type NativeWindowsClaudeCustodyAdapterDeadlines,
  type NativeWindowsClaudeCustodyAdapterOptions,
  type NativeWindowsClaudeCustodyLaunchResult,
  type NativeWindowsClaudeCustodyStopResult,
} from "../src/session-host/native-windows-claude-custody-adapter";
import { NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES } from "../src/session-host/native-windows-claude-custody-protocol";
import { captureOwnedConptyReader, ownedConptyReaderRecord } from "../src/session-host/windows-conpty-reader";
import {
  WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC,
  type WindowsClaudeCustodySupervisorLaunch,
  type WindowsClaudeCustodyWrapperLaunch,
} from "../src/session-host/native-windows-claude-custody-scripts";

const POWERSHELL_PATH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const TARGET_PATH = String.raw`C:\Program Files\Claude\claude.exe`;
const CODEX_TARGET_PATH = String.raw`C:\Program Files\Codex\codex.exe`;
/** Fixed epoch used to assert the exact absolute reader cap without wall-clock timing. */
const FIXED_NOW = 1_900_000_000_000;
const SUP_PID = 7400;
const WRAP_PID = 7504;
const CHILD_PID = 7608;

/** Short bounded deadlines: every wait in these tests is inside a millisecond budget. */
const TEST_DEADLINES: NativeWindowsClaudeCustodyAdapterDeadlines = Object.freeze({
  readyMs: 300,
  peerMs: 300,
  childMs: 300,
  settleMs: 300,
  wrapperPidMs: 500,
  closeMs: 150,
});

/* ------------------------------------------------------------- fake handles */

class FakeSupervisor extends EventEmitter {
  pid: number | undefined = SUP_PID;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  /** When true, `kill()` still exits the process but withholds Node's `close`. */
  closeSuppressed = false;
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
    void this.exit(null, "SIGTERM");
    return true;
  }

  async line(text: string): Promise<void> {
    this.stdout.write(`${text}\n`);
    await settleIo();
  }

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

/** One synthetic owned child that records exactly what its owner did to it. */
class SpyPty implements InstancePty {
  static #nextPid = 770_000;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  cols: number;
  rows: number;
  onDataThrows = false;
  onExitThrows = false;
  /** Emit the exact handle's one-shot exit synchronously while subscribing. */
  exitOnSubscribe = false;
  exited = false;
  readonly killSignals: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  readonly writes: (string | Buffer)[] = [];
  #pid: number;
  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor, pid = SpyPty.#nextPid += 1) {
    this.spawnDescriptor = descriptor;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.#pid = pid;
  }

  get pid(): number {
    return this.#pid;
  }

  setPid(pid: number): void {
    this.#pid = pid;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    if (this.onDataThrows) throw new Error("synthetic data surface unavailable");
    this.#dataListeners.push(listener);
    return { dispose: () => { const index = this.#dataListeners.indexOf(listener); if (index >= 0) this.#dataListeners.splice(index, 1); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    if (this.onExitThrows) throw new Error("synthetic exit surface unavailable");
    this.#exitListeners.push(listener);
    if (this.exitOnSubscribe && !this.exited) {
      this.exited = true;
      listener({ exitCode: 1 });
    }
    return { dispose: () => { const index = this.#exitListeners.indexOf(listener); if (index >= 0) this.#exitListeners.splice(index, 1); } };
  }

  on(_eventName: "error", _listener: (error: Error) => void): void {
    // No synthetic stream errors are produced by these fixtures.
  }

  removeListener(_eventName: "error", _listener: (error: Error) => void): void {
    // No synthetic stream errors are produced by these fixtures.
  }

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ cols: columns, rows });
    this.cols = columns;
    this.rows = rows;
  }

  kill(signal?: string): void {
    // Deliberately never exits by itself: a test that observes a kill can then
    // decide exactly when the exit receipt arrives.
    this.killSignals.push(signal ?? "SIGHUP");
  }

  pause(): void {}
  resume(): void {}

  emitData(data: string): void {
    for (const listener of [...this.#dataListeners]) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }
}

/** A lifecycle-only adapter for precise stop interleavings (no protocol traffic). */
class FakeCustodyAdapter implements NativeWindowsClaudeCustodyAdapter {
  launchCalls = 0;
  stopCalls = 0;
  readonly launchResult = deferred<NativeWindowsClaudeCustodyLaunchResult>();
  readonly stopResult = deferred<NativeWindowsClaudeCustodyStopResult>();

  launch(): Promise<NativeWindowsClaudeCustodyLaunchResult> {
    this.launchCalls += 1;
    return this.launchResult.promise;
  }

  stop(): Promise<NativeWindowsClaudeCustodyStopResult> {
    this.stopCalls += 1;
    return this.stopResult.promise;
  }
}

const LAUNCHED_RESULT: NativeWindowsClaudeCustodyLaunchResult = Object.freeze({
  status: "launched",
  supervisorPid: SUP_PID,
  wrapperPid: WRAP_PID,
  childPid: CHILD_PID,
});

const NO_CHILD_POSSIBLE: NativeWindowsClaudeCustodyStopResult = Object.freeze({
  status: "no-child-possible",
  witness: null,
  supervisorSpawned: true,
  supervisorClosed: true,
  wrapperSpawned: false,
  wrapperExited: false,
  childEstablished: false,
  confirmMayHaveBeenWritten: false,
  settleAttempted: false,
});

/** A closed proof for a fake row that spawned a wrapper through the manager's port. */
const NO_CHILD_POSSIBLE_WITH_WRAPPER: NativeWindowsClaudeCustodyStopResult = Object.freeze({
  status: "no-child-possible",
  witness: null,
  supervisorSpawned: true,
  supervisorClosed: true,
  wrapperSpawned: true,
  wrapperExited: true,
  childEstablished: false,
  confirmMayHaveBeenWritten: false,
  settleAttempted: false,
});

const WITNESSED_EMPTY: NativeWindowsClaudeCustodyStopResult = Object.freeze({
  status: "witnessed-empty",
  witness: Object.freeze({ supervisorPid: SUP_PID, jobActive: 0, jobListed: 0, exitCode: 0 }),
  supervisorSpawned: true,
  supervisorClosed: true,
  wrapperSpawned: true,
  wrapperExited: true,
  childEstablished: true,
  confirmMayHaveBeenWritten: true,
  settleAttempted: true,
});

const UNPROVEN_SETTLEMENT: NativeWindowsClaudeCustodyStopResult = Object.freeze({
  status: "unproven",
  reason: "settlement-failed",
  witness: null,
  supervisorSpawned: true,
  supervisorClosed: false,
  wrapperSpawned: true,
  wrapperExited: true,
  childEstablished: true,
  confirmMayHaveBeenWritten: true,
  settleAttempted: true,
});

/* ----------------------------------------------------------------- harness */

class RecordingRegistrar implements StatusRegistrar {
  registrations = 0;

  register(instanceId: string, _handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    this.registrations += 1;
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: "0".repeat(64),
        instanceId,
        generation: `synthetic-${instanceId}`,
      },
      release: () => undefined,
    };
  }
}

interface HarnessOptions {
  /** Absent leaves the manager exactly as production composes it. */
  readonly composition?: boolean;
  /** The host platform the manager sees; `null` uses the ambient platform. */
  readonly platform?: NodeJS.Platform | null;
  readonly select?: (request: NativeWindowsClaudeCustodyManagerRequest) => NativeWindowsClaudeCustodyManagerSelection | undefined;
  readonly adapterMode?: "real" | "fake" | "factory-throw" | "factory-shutdown";
  readonly provider?: NativeCliLaunch;
  /** Applied to every synthetic PTY this fixture's factory creates. */
  readonly ptyOnDataThrows?: boolean;
  readonly ptyOnExitThrows?: boolean;
  readonly ptyExitOnSubscribe?: boolean;
  /** Capture an intentionally unconfirmable #666 reader for the spawned handle. */
  readonly ptyOwnedReaderUnconfirmed?: boolean;
}

interface Harness {
  readonly workspace: string;
  readonly manager: InstanceManager;
  readonly registrar: RecordingRegistrar;
  readonly supervisor: FakeSupervisor;
  readonly spawned: SpyPty[];
  readonly selectorCalls: NativeWindowsClaudeCustodyManagerRequest[];
  readonly supervisorLaunches: WindowsClaudeCustodySupervisorLaunch[];
  readonly wrapperLaunches: WindowsClaudeCustodyWrapperLaunch[];
  readonly adapterOptions: NativeWindowsClaudeCustodyAdapterOptions[];
  readonly fakeAdapters: FakeCustodyAdapter[];
  readonly providerCalls: { backend: string; file: string }[];
  readonly providerDescriptors: { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[];
  /** True when a throwing adapter factory's early spawn attempt was refused. */
  factoryThrowRefused: boolean;
  /** True once the real adapter's wrapper port has returned its exact handle. */
  readonly wrapperPortReturned: boolean;
  dispose(): Promise<void>;
  /** End fixtures without disposing the manager (for intentionally retained custody). */
  discard(): Promise<void>;
}

function makeHarness(label: string, options: HarnessOptions = {}): Harness {
  __test.setShutdownPlatform(options.platform === undefined ? "win32" : options.platform ?? undefined);
  const root = realpathSync(mkdtempSync(join(tmpdir(), `.prg-custody-mgr-${label}-`)));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic fixture; never imported.\n", "utf8");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n", "utf8");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), PI_CODING_AGENT_DIR: agentDir };

  const registrar = new RecordingRegistrar();
  const supervisor = new FakeSupervisor();
  const spawned: SpyPty[] = [];
  const selectorCalls: NativeWindowsClaudeCustodyManagerRequest[] = [];
  const supervisorLaunches: WindowsClaudeCustodySupervisorLaunch[] = [];
  const wrapperLaunches: WindowsClaudeCustodyWrapperLaunch[] = [];
  const adapterOptions: NativeWindowsClaudeCustodyAdapterOptions[] = [];
  const fakeAdapters: FakeCustodyAdapter[] = [];
  const providerCalls: { backend: string; file: string }[] = [];
  const providerDescriptors: { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  let factoryThrowRefused = false;
  let wrapperPortReturned = false;
  let managerRef: InstanceManager | undefined;

  const provider: NativeCliLaunch = options.provider ?? ((backend, request) => {
    const file = backend === "codex" ? CODEX_TARGET_PATH : TARGET_PATH;
    providerCalls.push({ backend, file });
    const descriptor = {
      file,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin", HOME: env.HOME, PROVIDER_CONFIG_DIR: join(root, "provider-config") },
      cwd: request.workspace,
    };
    providerDescriptors.push(descriptor);
    return descriptor;
  });

  const select = options.select ?? ((request: NativeWindowsClaudeCustodyManagerRequest) => {
    selectorCalls.push(request);
    return {
      powershellPath: POWERSHELL_PATH,
      spawnSupervisor: (launch: WindowsClaudeCustodySupervisorLaunch): ChildProcess => {
        supervisorLaunches.push(launch);
        return supervisor as unknown as ChildProcess;
      },
    };
  });

  const composition = options.composition !== true
    ? undefined
    : {
      select: (request: NativeWindowsClaudeCustodyManagerRequest) => {
        if (options.select === undefined) return select(request);
        // A caller-supplied selector is still recorded, so "never consulted" is provable.
        const answer = options.select(request);
        selectorCalls.push(request);
        return answer;
      },
      createAdapter: (adapterOptionSet: NativeWindowsClaudeCustodyAdapterOptions): NativeWindowsClaudeCustodyAdapter => {
        adapterOptions.push(adapterOptionSet);
        if (options.adapterMode === "factory-throw") {
          // A factory that reaches for a spawn port before it has returned its adapter
          // must be refused, and the throw must never become a direct-spawn fallback.
          try {
            adapterOptionSet.spawnWrapper({
              file: POWERSHELL_PATH,
              args: ["-NoLogo"],
              script: "synthetic",
              encoded: "synthetic",
              commandLineLength: 1,
            });
          } catch {
            factoryThrowRefused = true;
          }
          throw new Error("synthetic adapter factory failure");
        }
        if (options.adapterMode === "factory-shutdown") {
          // Foreign synchronous reentry from INSIDE adapter construction.
          void managerRef?.shutdown();
          const fake = new FakeCustodyAdapter();
          fakeAdapters.push(fake);
          return fake;
        }
        const spawnWrapper = adapterOptionSet.spawnWrapper;
        const intercepted: NativeWindowsClaudeCustodyAdapterOptions = {
          ...adapterOptionSet,
          spawnWrapper: (launch: WindowsClaudeCustodyWrapperLaunch) => {
            wrapperLaunches.push(launch);
            try {
              return spawnWrapper(launch);
            } finally {
              wrapperPortReturned = true;
            }
          },
        };
        if (options.adapterMode === "fake") {
          const fake = new FakeCustodyAdapter();
          fakeAdapters.push(fake);
          return fake;
        }
        return createNativeWindowsClaudeCustodyAdapter({ ...intercepted, deadlines: TEST_DEADLINES });
      },
    };

  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: registrar,
    env,
    args: [],
    nativeCliLaunch: provider,
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      if (options.ptyOnDataThrows === true) pty.onDataThrows = true;
      if (options.ptyOnExitThrows === true) pty.onExitThrows = true;
      if (options.ptyExitOnSubscribe === true) pty.exitOnSubscribe = true;
      if (options.ptyOwnedReaderUnconfirmed === true) {
        // An ownership-unidentified capture is the required-but-unconfirmable reader.
        captureOwnedConptyReader(pty, { confirmationWindowMs: 50 });
      }
      spawned.push(pty);
      return pty;
    },
    ...(composition === undefined ? {} : { nativeWindowsClaudeCustody: composition }),
  });
  managerRef = manager;

  return {
    workspace,
    manager,
    registrar,
    supervisor,
    spawned,
    selectorCalls,
    supervisorLaunches,
    wrapperLaunches,
    adapterOptions,
    fakeAdapters,
    providerCalls,
    providerDescriptors,
    get factoryThrowRefused(): boolean {
      return factoryThrowRefused;
    },
    get wrapperPortReturned(): boolean {
      return wrapperPortReturned;
    },
    async dispose(): Promise<void> {
      try {
        await manager.dispose();
      } catch {
        // Contained: a fixture never owns an unconfirmed reader.
      }
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        await supervisor.exit(0).catch(() => undefined);
      }
      rmSync(root, { recursive: true, force: true });
      __test.setShutdownPlatform(undefined);
    },
    async discard(): Promise<void> {
      // For tests that intentionally leave UNPROVEN custody retained: a full dispose
      // would spend its default stop budget on a row that can never prove closure.
      // A tiny bounded shutdown settles every owned ladder first, then the fixtures
      // (all in-memory) are ended without touching the retained record.
      try {
        await manager.shutdown({ graceMs: 10, killMs: 10 });
      } catch {
        // Contained.
      }
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.closeSuppressed = false;
        await supervisor.exit(0).catch(() => undefined);
      } else {
        supervisor.closeSuppressed = false;
        supervisor.emit("close", supervisor.exitCode, supervisor.signalCode);
      }
      await settleIo();
      rmSync(root, { recursive: true, force: true });
      __test.setShutdownPlatform(undefined);
    },
  };
}

/* --------------------------------------------------------------- utilities */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}

async function settleIo(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

/** Driver bytes AFTER the fixed boot frame. */
function commandsWritten(supervisor: FakeSupervisor): string {
  const text = supervisor.writtenText;
  if (!text.startsWith(WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC)) return "";
  const digits = WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC.length;
  const length = Number(text.slice(digits, digits + 8));
  if (!Number.isSafeInteger(length)) return "";
  return text.slice(NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES + length);
}

/** The one row id this fixture's manager currently owns. */
function onlyRowId(manager: InstanceManager): string {
  const rows = manager.list();
  assert.equal(rows.length, 1);
  return rows[0].id;
}

/* ------------------------------------------------------------------- tests */

test("without injection a Claude direct .exe row keeps the unchanged direct spawn", async (t) => {
  const harness = makeHarness("default");
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  const id = await creating;

  assert.equal(harness.selectorCalls.length, 0);
  assert.equal(harness.adapterOptions.length, 0);
  assert.deepEqual(harness.providerCalls, [{ backend: "claude", file: TARGET_PATH }]);
  assert.equal(harness.spawned.length, 1, "one direct PTY, no supervisor");
  assert.equal(harness.registrar.registrations, 0, "a native row never registers a Pi status source");
  const [row] = harness.manager.list();
  assert.equal(row.id, id);
  assert.equal(row.lifecycle, "alive");
  assert.equal(row.hasLiveProcess, true);

  // The injected provider's descriptor is applied verbatim: same file/argv/env/cwd
  // and the row's own canonical geometry, with no `commandLine` field.
  const descriptor = harness.spawned[0].spawnDescriptor;
  const providerDescriptor = harness.providerDescriptors[0];
  assert.deepEqual(
    { file: descriptor.file, args: descriptor.args, env: descriptor.env, cwd: descriptor.cwd, cols: descriptor.cols, rows: descriptor.rows },
    {
      file: TARGET_PATH,
      args: providerDescriptor.args,
      env: providerDescriptor.env,
      cwd: harness.workspace,
      cols: 80,
      rows: 24,
    },
  );
  assert.equal(Object.prototype.hasOwnProperty.call(descriptor, "commandLine"), false);

  harness.spawned[0].emitExit(0);
  await settleIo();
  assert.equal(harness.manager.list()[0].lifecycle, "exited");
  assert.equal(harness.manager.closeExited(id), true);
});

test("the injected selection is never consulted for ineligible rows or hosts", async (t) => {
  // Codex, a non-Windows host, and a Windows command-line target each keep the
  // unchanged direct spawn and never reach the composition.
  const codex = makeHarness("codex", { composition: true });
  t.after(() => codex.dispose());
  const codexId = await codex.manager.create({ workspace: codex.workspace, backend: "codex" });
  assert.equal(codex.selectorCalls.length, 0, "Codex never consults custody");
  assert.deepEqual(codex.providerCalls, [{ backend: "codex", file: CODEX_TARGET_PATH }]);
  assert.equal(codex.spawned.length, 1);
  assert.equal(codex.spawned[0].spawnDescriptor.file, CODEX_TARGET_PATH);
  codex.spawned[0].emitExit(0);
  await settleIo();
  assert.equal(codex.manager.closeExited(codexId), true);

  const posix = makeHarness("posix", { composition: true, platform: "linux" });
  t.after(() => posix.dispose());
  const posixId = await posix.manager.create({ workspace: posix.workspace, backend: "claude" });
  assert.equal(posix.selectorCalls.length, 0, "a non-Windows host never consults custody");
  assert.equal(posix.spawned.length, 1);
  assert.equal(posix.spawned[0].spawnDescriptor.file, TARGET_PATH);
  posix.spawned[0].emitExit(0);
  await settleIo();
  assert.equal(posix.manager.closeExited(posixId), true);

  const batch = makeHarness("batch", {
    composition: true,
    provider: (_backend, request) => ({
      file: TARGET_PATH,
      args: ["--interactive"],
      commandLine: `"${TARGET_PATH}" --interactive`,
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
    }),
  });
  t.after(() => batch.dispose());
  const batchId = await batch.manager.create({ workspace: batch.workspace, backend: "claude" });
  assert.equal(batch.selectorCalls.length, 0, "a Windows command line never consults custody");
  assert.equal(batch.spawned.length, 1);
  assert.equal(batch.spawned[0].spawnDescriptor.commandLine, `"${TARGET_PATH}" --interactive`);
  batch.spawned[0].emitExit(0);
  await settleIo();
  assert.equal(batch.manager.closeExited(batchId), true);
});

test("an ineligible decline keeps the unchanged direct spawn", async (t) => {
  let expectedWorkspace = "";
  const harness = makeHarness("decline", {
    composition: true,
    select: (request) => {
      assert.equal(request.backend, "claude");
      assert.equal(request.target, TARGET_PATH);
      assert.deepEqual(request.args, ["--interactive"]);
      assert.equal(request.workspace, expectedWorkspace);
      return undefined;
    },
  });
  expectedWorkspace = harness.workspace;
  t.after(() => harness.dispose());
  const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  assert.equal(harness.selectorCalls.length, 1);
  assert.equal(harness.adapterOptions.length, 0);
  assert.equal(harness.spawned.length, 1);
  assert.equal(harness.spawned[0].spawnDescriptor.file, TARGET_PATH);
  harness.spawned[0].emitExit(0);
  await settleIo();
  assert.equal(harness.manager.closeExited(id), true);
});

test("custody keeps the row starting, captures output, wires the wrapper, and stops through one settlement", async (t) => {
  const harness = makeHarness("settle", { composition: true });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.supervisor.writtenText.length > 0, "supervisor boot frame");
  const id = onlyRowId(harness.manager);

  // The admitted row owns custody before its wrapper exists: no PTY, still owned.
  assert.equal(harness.manager.list()[0].lifecycle, "starting");
  assert.equal(harness.manager.list()[0].hasLiveProcess, true);
  assert.equal(harness.manager.hasLiveProcesses(), true);
  assert.equal(harness.spawned.length, 0);

  await harness.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => harness.spawned.length === 1, "wrapper spawn");

  // The wrapper port retains the ORIGINAL terminal facts and the exact renderer argv.
  const wrapperLaunch = harness.wrapperLaunches[0];
  const wrapper = harness.spawned[0];
  assert.equal(wrapperLaunch.file, POWERSHELL_PATH);
  assert.equal(wrapper.spawnDescriptor.file, POWERSHELL_PATH);
  assert.deepEqual(wrapper.spawnDescriptor.args, [...wrapperLaunch.args]);
  assert.deepEqual(wrapper.spawnDescriptor.env, harness.providerDescriptors[0].env);
  assert.equal(wrapper.spawnDescriptor.cwd, harness.workspace);
  assert.equal(wrapper.spawnDescriptor.cols, 80);
  assert.equal(wrapper.spawnDescriptor.rows, 24);
  assert.equal(Object.prototype.hasOwnProperty.call(wrapper.spawnDescriptor, "commandLine"), false);
  assert.equal(harness.supervisorLaunches.length, 1);

  // The child is not established yet, so the row must still be starting — but its
  // output is already parsed into the retained surface.
  wrapper.emitData("custody-output-before-child\r\n");
  const surface = harness.manager.surface(id);
  assert.ok(surface, "the terminal surface exists from the same synchronous spawn turn");
  await surface.flush();
  assert.match(surface.frame().lines.join("\n"), /custody-output-before-child/);
  assert.equal(harness.manager.list()[0].lifecycle, "starting");

  // The reported provisional PID must be the exact live handle's own PID.
  const wrapperPid = wrapper.pid;
  await harness.supervisor.line(`SUP_WRAPPER ${wrapperPid} PROVISIONAL`);
  await waitFor(() => commandsWritten(harness.supervisor).includes(`CONFIRM ${wrapperPid}\n`), "CONFIRM write");
  await harness.supervisor.line(`SUP_GO ${wrapperPid}`);
  await harness.supervisor.line(`SUP_CHILD ${CHILD_PID}`);
  assert.equal(await creating, id);
  assert.equal(harness.manager.list()[0].lifecycle, "alive");
  assert.equal(harness.manager.list()[0].hasLiveProcess, true);

  const stopping = harness.manager.stop(id, { confirmed: true });
  await waitFor(() => commandsWritten(harness.supervisor).includes("SETTLE\n"), "SETTLE write");
  wrapper.emitExit(0);
  await harness.supervisor.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await harness.supervisor.line("SUP_BYE");
  await harness.supervisor.exit(0);
  const result = await stopping;

  assert.deepEqual(result, { status: "exited", forced: false });
  assert.deepEqual(wrapper.killSignals, [], "the manager never kills a custody wrapper directly");
  assert.equal(harness.supervisor.kills, 0, "a witnessed settlement needs no supervisor kill");
  assert.equal(harness.manager.hasLiveProcesses(), false);
  // One idempotent slot stop already happened; a later stop observes its result.
  assert.deepEqual(await harness.manager.stop(id, { confirmed: true }), { status: "exited", forced: false });
  assert.equal(harness.manager.closeExited(id), true);
});

test("a supervisor-only pending custody row is owned work that Stop releases only on adapter proof", async (t) => {
  const harness = makeHarness("pending-stop", { composition: true });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.supervisor.writtenText.length > 0, "supervisor boot frame");
  const id = onlyRowId(harness.manager);

  assert.deepEqual(
    await harness.manager.stop(id, { confirmed: false }),
    { status: "confirmation-required", forced: false },
  );
  const result = await harness.manager.stop(id, { confirmed: true });

  assert.equal(result.status, "exited");
  assert.equal(result.forced, false);
  assert.equal(harness.spawned.length, 0, "nothing is spawned directly and no wrapper is created");
  assert.ok(harness.supervisor.kills >= 1, "the adapter's one stop disposes the exact supervisor");
  assert.equal(await creating, id);
  assert.equal(harness.manager.list()[0].lifecycle, "error");
  assert.equal(harness.manager.hasLiveProcesses(), false);
  assert.equal(harness.manager.closeError(id), true);
  assert.equal(harness.manager.list().length, 0);
});

test("shutdown drives a pending custody row through the same slot stop and reports no remaining ids", async (t) => {
  const harness = makeHarness("pending-shutdown", { composition: true });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.supervisor.writtenText.length > 0, "supervisor boot frame");
  const id = onlyRowId(harness.manager);

  const result = await harness.manager.shutdown();
  assert.equal(await creating, id);
  assert.deepEqual(result, { forcedIds: [], remainingIds: [] });
  assert.equal(harness.spawned.length, 0);
  assert.equal(harness.manager.list()[0].lifecycle, "error");
});

test("an early PTY exit before the child is established is a closed failed launch with no direct fallback", async (t) => {
  const harness = makeHarness("early-exit", { composition: true });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.supervisor.writtenText.length > 0, "supervisor boot frame");
  await harness.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => harness.spawned.length === 1, "wrapper spawn");
  const wrapper = harness.spawned[0];

  wrapper.emitExit(1);
  const id = await creating;

  assert.equal(harness.spawned.length, 1, "no second/direct PTY ever appears");
  assert.deepEqual(wrapper.killSignals, [], "an exited wrapper is never killed again");
  assert.equal(harness.manager.list()[0].lifecycle, "exited");
  assert.equal(harness.manager.hasLiveProcesses(), false);
  assert.equal(harness.manager.closeExited(id), true);
});

test("cancellation before any wrapper spawn never publishes or falls back", async (t) => {
  const harness = makeHarness("cancel", { composition: true });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.supervisor.writtenText.length > 0, "supervisor boot frame");
  const id = onlyRowId(harness.manager);

  await harness.manager.dispose();
  assert.equal(await creating, id);
  assert.equal(harness.spawned.length, 0, "a cancelled custody launch spawns no wrapper and no direct child");
  assert.equal(harness.adapterOptions.length, 1);
  assert.equal(harness.manager.list()[0].lifecycle, "error");
  assert.equal(harness.manager.hasLiveProcesses(), false);
});

test("overlapping stops share exactly one adapter stop and one single-use launch", async (t) => {
  const harness = makeHarness("one-stop", { composition: true, adapterMode: "fake" });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
  const id = onlyRowId(harness.manager);
  const fake = harness.fakeAdapters[0];

  const first = harness.manager.stop(id, { confirmed: true });
  const second = harness.manager.stop(id, { confirmed: true });
  await settleIo();
  fake.stopResult.resolve(NO_CHILD_POSSIBLE);
  const [left, right] = await Promise.all([first, second]);

  assert.equal(fake.launchCalls, 1);
  assert.equal(fake.stopCalls, 1, "both stops observe the same single-flight slot stop");
  assert.deepEqual(left, { status: "exited", forced: false });
  assert.deepEqual(right, { status: "exited", forced: false });

  // A late "launched" answer can never publish over the cancelled row.
  fake.launchResult.resolve(LAUNCHED_RESULT);
  assert.equal(await creating, id);
  assert.equal(harness.spawned.length, 0);
  assert.equal(harness.manager.list()[0].lifecycle, "error");
  assert.equal(harness.manager.hasLiveProcesses(), false);
});

test("an unproven custody stop stays retained after the PTY exited", async (t) => {
  const harness = makeHarness("retained", { composition: true, adapterMode: "fake" });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
  const id = onlyRowId(harness.manager);
  const fake = harness.fakeAdapters[0];
  harness.adapterOptions[0].spawnWrapper({
    file: POWERSHELL_PATH,
    args: ["-NoLogo", "-NoProfile"],
    script: "synthetic",
    encoded: "synthetic",
    commandLineLength: 1,
  });
  const wrapper = harness.spawned[0];

  fake.launchResult.resolve(LAUNCHED_RESULT);
  assert.equal(await creating, id);
  assert.equal(harness.manager.list()[0].lifecycle, "alive");

  wrapper.emitExit(0);
  await waitFor(() => fake.stopCalls === 1, "slot stop after the early exit");
  fake.stopResult.resolve(UNPROVEN_SETTLEMENT);
  await settleIo();

  // The PTY exit is not custody proof: the row keeps its slot, its liveness, and
  // its removal refusal even though the exact wrapper handle already exited.
  assert.equal(harness.manager.hasLiveProcesses(), true);
  assert.equal(harness.manager.list()[0].hasLiveProcess, true);
  // The public lifecycle is NOT published as exited while custody is unproven:
  // existing consumers read `exited` as positive Stop evidence.
  assert.notEqual(harness.manager.list()[0].lifecycle, "exited");
  assert.equal(harness.manager.list()[0].lifecycle, "alive");
  assert.equal(harness.manager.closeExited(id), false);
  assert.deepEqual(await harness.manager.stop(id, { confirmed: true }), { status: "unconfirmed", forced: false });
  const shutdown = await harness.manager.shutdown();
  assert.deepEqual(shutdown.forcedIds, []);
  assert.deepEqual(shutdown.remainingIds, [id]);
  assert.deepEqual(wrapper.killSignals, [], "an unproven stop never kills the PTY directly either");
});

test("a same-turn wiring failure keeps the exact handle and routes the one slot stop", async (t) => {
  const harness = makeHarness("wiring", { composition: true, adapterMode: "fake", ptyOnDataThrows: true });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
  const id = onlyRowId(harness.manager);
  const fake = harness.fakeAdapters[0];
  const adapterOptions = harness.adapterOptions[0];

  // The manager's own PTY factory returns a handle whose data surface refuses to
  // register, so the same-turn wiring throws AFTER the exact handle (and its exit
  // listener) already exist. The adapter's own exit subscription still succeeds.
  const handle = adapterOptions.spawnWrapper({
    file: POWERSHELL_PATH,
    args: ["-NoLogo"],
    script: "synthetic",
    encoded: "synthetic",
    commandLineLength: 1,
  });
  const rawPty = harness.spawned[0];
  assert.equal(handle.pid, rawPty.pid, "the adapter still receives the exact live handle even though wiring threw");

  fake.launchResult.resolve(Object.freeze({ status: "failed", code: "unexpected" }));
  await waitFor(() => fake.stopCalls === 1, "the wiring failure routes the slot stop");
  assert.equal(harness.manager.list()[0].lifecycle, "error");
  assert.equal(harness.manager.list()[0].hasLiveProcess, true, "custody is retained until the adapter proves closure");

  // The adapter's own proof arrives only after the exact handle's exit receipt.
  // The failed launch waits on that same single stop, never on a second one.
  rawPty.emitExit(0);
  fake.stopResult.resolve(NO_CHILD_POSSIBLE_WITH_WRAPPER);
  assert.equal(await creating, id);
  await settleIo();
  assert.equal(harness.manager.hasLiveProcesses(), false);
  assert.equal(harness.manager.closeExited(id), true);
  assert.deepEqual(rawPty.killSignals, []);
});

test("an adapter factory that throws after a valid selection is a closed admission with no direct fallback", async (t) => {
  const harness = makeHarness("factory-throw", { composition: true, adapterMode: "factory-throw" });
  t.after(() => harness.dispose());
  const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });

  assert.equal(harness.selectorCalls.length, 1, "the valid selection admitted custody");
  assert.equal(harness.adapterOptions.length, 1);
  assert.equal(harness.factoryThrowRefused, true, "a spawn port reached before installation stays closed");
  assert.equal(harness.spawned.length, 0, "neither a supervisor wrapper nor a direct PTY was spawned");
  assert.equal(harness.providerCalls.length, 1, "the provider descriptor was still the only launch input");
  assert.equal(harness.manager.list()[0].lifecycle, "error");
  assert.equal(harness.manager.hasLiveProcesses(), false);
  assert.equal(harness.manager.closeError(id), true);
});

test("incomplete closure receipts never release custody", async () => {
  const cases: { readonly label: string; readonly result: NativeWindowsClaudeCustodyStopResult }[] = [
    { label: "witnessed without a witness", result: Object.freeze({ ...WITNESSED_EMPTY, witness: null }) },
    { label: "witnessed without supervisor close", result: Object.freeze({ ...WITNESSED_EMPTY, supervisorClosed: false }) },
    { label: "witnessed without wrapper exit", result: Object.freeze({ ...WITNESSED_EMPTY, wrapperExited: false }) },
    {
      label: "no-child-possible with an unclosed supervisor",
      result: Object.freeze({ ...NO_CHILD_POSSIBLE_WITH_WRAPPER, supervisorClosed: false }),
    },
    {
      label: "no-child-possible that admits an established child",
      result: Object.freeze({ ...NO_CHILD_POSSIBLE_WITH_WRAPPER, childEstablished: true }),
    },
    {
      label: "no-child-possible after a positive launch receipt",
      result: NO_CHILD_POSSIBLE_WITH_WRAPPER,
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const harness = makeHarness(`proof-${index}`, { composition: true, adapterMode: "fake" });
    try {
      const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
      await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
      const id = onlyRowId(harness.manager);
      const fake = harness.fakeAdapters[0];
      harness.adapterOptions[0].spawnWrapper({
        file: POWERSHELL_PATH,
        args: ["-NoLogo"],
        script: "synthetic",
        encoded: "synthetic",
        commandLineLength: 1,
      });
      const wrapper = harness.spawned[0];
      fake.launchResult.resolve(LAUNCHED_RESULT);
      assert.equal(await creating, id);
      wrapper.emitExit(0);
      await waitFor(() => fake.stopCalls === 1, "slot stop after the exit");
      fake.stopResult.resolve(entry.result);
      await settleIo();

      assert.equal(harness.manager.hasLiveProcesses(), true, `${entry.label}: custody stays retained`);
      assert.equal(harness.manager.list()[0].hasLiveProcess, true, `${entry.label}: row stays owned`);
      assert.notEqual(harness.manager.list()[0].lifecycle, "exited", `${entry.label}: no terminal lifecycle`);
      assert.equal(harness.manager.closeExited(id), false, `${entry.label}: removal stays refused`);
    } finally {
      await harness.discard();
    }
  }
});

test("an unconfirmed #666 owned reader keeps custody retained", async () => {
  const harness = makeHarness("reader", {
    composition: true,
    adapterMode: "fake",
    ptyOwnedReaderUnconfirmed: true,
  });
  try {
    const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
    const id = onlyRowId(harness.manager);
    const fake = harness.fakeAdapters[0];
    harness.adapterOptions[0].spawnWrapper({
      file: POWERSHELL_PATH,
      args: ["-NoLogo"],
      script: "synthetic",
      encoded: "synthetic",
      commandLineLength: 1,
    });
    const wrapper = harness.spawned[0];
    fake.launchResult.resolve(LAUNCHED_RESULT);
    assert.equal(await creating, id);

    wrapper.emitExit(0);
    await waitFor(() => fake.stopCalls === 1, "slot stop after the exit");
    fake.stopResult.resolve(WITNESSED_EMPTY);
    await settleIo();

    // The adapter's closure proof and the PTY exit are complete, but the required
    // owned reader never positively settled, so the row keeps its custody.
    assert.equal(harness.manager.hasLiveProcesses(), true);
    assert.notEqual(harness.manager.list()[0].lifecycle, "exited");
    assert.equal(harness.manager.closeExited(id), false);
  } finally {
    await harness.discard();
  }
});

test("custody publishes the terminal exited lifecycle only after its own proof", async (t) => {
  const harness = makeHarness("proven", { composition: true, adapterMode: "fake" });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
  const id = onlyRowId(harness.manager);
  const fake = harness.fakeAdapters[0];
  harness.adapterOptions[0].spawnWrapper({
    file: POWERSHELL_PATH,
    args: ["-NoLogo"],
    script: "synthetic",
    encoded: "synthetic",
    commandLineLength: 1,
  });
  const wrapper = harness.spawned[0];
  fake.launchResult.resolve(LAUNCHED_RESULT);
  assert.equal(await creating, id);
  assert.equal(harness.manager.list()[0].lifecycle, "alive");

  wrapper.emitExit(0);
  await waitFor(() => fake.stopCalls === 1, "slot stop after the exit");
  assert.equal(harness.manager.list()[0].lifecycle, "alive", "a bare PTY exit publishes no terminal lifecycle");
  fake.stopResult.resolve(WITNESSED_EMPTY);
  await settleIo();

  assert.equal(harness.manager.list()[0].lifecycle, "exited");
  assert.equal(harness.manager.hasLiveProcesses(), false);
  assert.equal(harness.manager.closeExited(id), true);
});

test("a one-shot exit during same-turn wiring is shared with the adapter and never killed", async (t) => {
  const harness = makeHarness("one-shot", { composition: true, ptyExitOnSubscribe: true });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.adapterOptions.length === 1, "adapter construction");
  let abortSeen = false;
  let abortBeforePortReturn = false;
  harness.adapterOptions[0].signal?.addEventListener("abort", () => {
    abortSeen = true;
    abortBeforePortReturn = harness.wrapperPortReturned !== true;
  });
  await waitFor(() => harness.supervisor.writtenText.length > 0, "supervisor boot frame");
  await harness.supervisor.line(`SUP_READY ${SUP_PID}`);
  const id = await creating;

  // The manager's cancellation is delivered only AFTER the synchronous wrapper port
  // returned its exact handle, even though the exit fired inside registration.
  assert.equal(abortSeen, true, "the one custody stop dispatched cancellation");
  assert.equal(abortBeforePortReturn, false, "cancellation never precedes the handle receipt");
  assert.equal(harness.spawned.length, 1, "exactly one wrapper, never a direct fallback");
  const wrapper = harness.spawned[0];
  assert.equal(wrapper.exited, true);
  assert.deepEqual(wrapper.killSignals, [], "a known-exited wrapper is never killed by either observer");
  assert.equal(harness.manager.hasLiveProcesses(), false);
  assert.equal(harness.manager.list()[0].lifecycle, "exited");
  assert.equal(harness.manager.closeExited(id), true);
});

test("a failed manager exit subscription never lets closure be claimed", async () => {
  const harness = makeHarness("unobservable", { composition: true, adapterMode: "fake", ptyOnExitThrows: true });
  try {
    const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
    const id = onlyRowId(harness.manager);
    const fake = harness.fakeAdapters[0];
    harness.adapterOptions[0].spawnWrapper({
      file: POWERSHELL_PATH,
      args: ["-NoLogo"],
      script: "synthetic",
      encoded: "synthetic",
      commandLineLength: 1,
    });
    fake.launchResult.resolve(LAUNCHED_RESULT);
    await waitFor(() => fake.stopCalls === 1, "the broken wiring routes the slot stop");
    // Even an optimistic closure claim cannot release a handle whose exit this
    // manager could never observe: the exact PTY exit fact is required as well.
    fake.stopResult.resolve(NO_CHILD_POSSIBLE_WITH_WRAPPER);
    assert.equal(await creating, id);
    await settleIo();
    assert.equal(harness.manager.list()[0].lifecycle, "error");
    assert.equal(harness.manager.hasLiveProcesses(), true);
    assert.equal(harness.manager.closeExited(id), false);
    assert.equal(harness.manager.closeError(id), false);
  } finally {
    await harness.discard();
  }
});

test("a short-budget shutdown withholds closure and reports the row as remaining", async () => {
  const harness = makeHarness("shutdown-budget", { composition: true });
  try {
    const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    await waitFor(() => harness.supervisor.writtenText.length > 0, "supervisor boot frame");
    const id = onlyRowId(harness.manager);
    harness.supervisor.closeSuppressed = true;

    const started = performance.now();
    const result = await harness.manager.shutdown({ graceMs: 50, killMs: 50 });
    const elapsed = performance.now() - started;

    assert.equal(await creating, id);
    assert.deepEqual(result.forcedIds, []);
    assert.deepEqual(result.remainingIds, [id]);
    assert.equal(harness.spawned.length, 0);
    assert.ok(elapsed < 2_000, `shutdown stayed inside its own budget (${elapsed.toFixed(0)}ms)`);
    assert.equal(harness.manager.list()[0].lifecycle, "error");
  } finally {
    await harness.discard();
  }
});

test("a declining selector that shuts the manager down cannot let a direct spawn happen", async (t) => {
  let harness!: Harness;
  harness = makeHarness("reentrant-decline", {
    composition: true,
    select: () => {
      // Foreign synchronous reentry: the decline happens AFTER cancellation began.
      void harness.manager.shutdown();
      return undefined;
    },
  });
  t.after(() => harness.dispose());
  const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });

  assert.equal(harness.selectorCalls.length, 1, "the eligible row consulted the selection exactly once");
  assert.equal(harness.adapterOptions.length, 0, "no custody adapter was created");
  assert.equal(harness.spawned.length, 0, "neither a custody port nor the direct PTY factory spawned");
  assert.equal(harness.manager.list()[0].id, id);
  assert.equal(harness.manager.list()[0].lifecycle, "error");
});

test("a confirmed Stop of a provisional wrapper does not hold the launch, and a short shutdown keeps its own budget", async () => {
  const harness = makeHarness("provisional-stop", { composition: true, adapterMode: "fake" });
  try {
    const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
    const id = onlyRowId(harness.manager);
    const fake = harness.fakeAdapters[0];
    const wrapperLaunch = {
      file: POWERSHELL_PATH,
      args: ["-NoLogo"],
      script: "synthetic",
      encoded: "synthetic",
      commandLineLength: 1,
    } as const;
    harness.adapterOptions[0].spawnWrapper(wrapperLaunch);
    assert.equal(harness.manager.list()[0].lifecycle, "starting", "the wrapper is provisional");

    const stopping = harness.manager.stop(id, { confirmed: true });
    // The launch-publication wait ends on the confirmed Stop even though the adapter's
    // stop proof is still deferred.
    assert.equal(await creating, id);
    assert.equal(fake.stopCalls, 1, "the row owns exactly one adapter stop");
    assert.equal(harness.manager.list()[0].lifecycle, "error");

    // A short-budget shutdown overlapping that operator Stop observes the SAME single
    // custody operation under its own budget, not the operator's ten-second window.
    const started = performance.now();
    const shutdown = await harness.manager.shutdown({ graceMs: 40, killMs: 40 });
    const elapsed = performance.now() - started;
    assert.deepEqual(shutdown.forcedIds, []);
    assert.deepEqual(shutdown.remainingIds, [id]);
    assert.ok(elapsed < 2_000, `shutdown stayed inside its own budget (${elapsed.toFixed(0)}ms)`);
    assert.equal(fake.stopCalls, 1);

    // Release the deferred proof; the operator ladder then finishes truthfully.
    harness.spawned[0].emitExit(0);
    fake.stopResult.resolve(UNPROVEN_SETTLEMENT);
    assert.deepEqual(await stopping, { status: "unconfirmed", forced: false });
    assert.equal(fake.stopCalls, 1);
  } finally {
    await harness.discard();
  }
});

test("both spawn ports are single-use and disarm when the launch result is observed", async (t) => {
  const harness = makeHarness("single-use", { composition: true, adapterMode: "fake" });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
  const id = onlyRowId(harness.manager);
  const fake = harness.fakeAdapters[0];
  const options = harness.adapterOptions[0];
  const supervisorLaunch = {} as WindowsClaudeCustodySupervisorLaunch;
  const wrapperLaunch: WindowsClaudeCustodyWrapperLaunch = {
    file: POWERSHELL_PATH,
    args: ["-NoLogo"],
    script: "synthetic",
    encoded: "synthetic",
    commandLineLength: 1,
  };

  options.spawnSupervisor(supervisorLaunch);
  assert.equal(harness.supervisorLaunches.length, 1);
  assert.throws(() => options.spawnSupervisor(supervisorLaunch), /not armed for a supervisor spawn/);
  options.spawnWrapper(wrapperLaunch);
  assert.equal(harness.spawned.length, 1);
  assert.throws(() => options.spawnWrapper(wrapperLaunch), /not armed for a wrapper spawn/);
  assert.equal(harness.spawned.length, 1, "a duplicate request never replaces the exact handle");

  fake.launchResult.resolve(LAUNCHED_RESULT);
  assert.equal(await creating, id);
  assert.equal(harness.manager.list()[0].lifecycle, "alive");
  assert.throws(() => options.spawnWrapper(wrapperLaunch), /not armed for a wrapper spawn/);
  assert.throws(() => options.spawnSupervisor(supervisorLaunch), /not armed for a supervisor spawn/);
  assert.equal(harness.spawned.length, 1);

  harness.spawned[0].emitExit(0);
  await waitFor(() => fake.stopCalls === 1, "slot stop after the exit");
  fake.stopResult.resolve(WITNESSED_EMPTY);
  await settleIo();
  assert.equal(harness.manager.closeExited(id), true);
});

test("the wrapper facade reports only actual force attempts", async () => {
  const harness = makeHarness("force", { composition: true, adapterMode: "fake" });
  try {
    const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
    const id = onlyRowId(harness.manager);
    const fake = harness.fakeAdapters[0];
    const facade = harness.adapterOptions[0].spawnWrapper({
      file: POWERSHELL_PATH,
      args: ["-NoLogo"],
      script: "synthetic",
      encoded: "synthetic",
      commandLineLength: 1,
    });
    fake.launchResult.resolve(LAUNCHED_RESULT);
    assert.equal(await creating, id);
    const raw = harness.spawned[0];

    facade.kill();
    assert.equal(raw.killSignals.length, 1, "the facade is the one exact-handle signal path");
    raw.emitExit(0);
    await waitFor(() => fake.stopCalls === 1, "slot stop after the exit");
    fake.stopResult.resolve(UNPROVEN_SETTLEMENT);
    await settleIo();

    // The attempt is historical truth even though custody stays unproven.
    assert.deepEqual(await harness.manager.stop(id, { confirmed: true }), { status: "unconfirmed", forced: true });
    const shutdown = await harness.manager.shutdown({ graceMs: 20, killMs: 20 });
    assert.deepEqual(shutdown.forcedIds, [id]);
    assert.deepEqual(shutdown.remainingIds, [id]);

    // A kill after a known exit is never sent again and is never a second attempt.
    facade.kill();
    assert.equal(raw.killSignals.length, 1);
  } finally {
    await harness.discard();
  }
});

test("a selector that shuts the manager down and then admits custody installs nothing", async (t) => {
  let harness!: Harness;
  harness = makeHarness("reentrant-admit", {
    composition: true,
    select: () => {
      // Foreign synchronous reentry, then an otherwise valid admission.
      void harness.manager.shutdown();
      return {
        powershellPath: POWERSHELL_PATH,
        spawnSupervisor: () => harness.supervisor as unknown as ChildProcess,
      };
    },
  });
  t.after(() => harness.dispose());
  const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });

  assert.equal(harness.selectorCalls.length, 1);
  assert.equal(harness.adapterOptions.length, 0, "no adapter factory ran after admission closed");
  assert.equal(harness.spawned.length, 0, "neither custody port nor the direct PTY factory spawned");
  assert.equal(harness.supervisorLaunches.length, 0);
  assert.equal(harness.manager.list()[0].id, id);
  assert.equal(harness.manager.list()[0].lifecycle, "error");
});

test("a factory that closes admission installs the slot, stops once, and never launches", async (t) => {
  const harness = makeHarness("factory-shutdown", { composition: true, adapterMode: "factory-shutdown" });
  t.after(() => harness.dispose());
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  const id = await creating;

  assert.equal(harness.fakeAdapters.length, 1);
  const fake = harness.fakeAdapters[0];
  await waitFor(() => fake.stopCalls === 1, "the canceled slot takes its one stop");
  assert.equal(fake.launchCalls, 0, "a canceled admission runs no injected launch lifecycle");
  assert.equal(fake.stopCalls, 1, "exactly one stop");
  assert.equal(harness.spawned.length, 0);
  assert.equal(harness.supervisorLaunches.length, 0);
  assert.equal(harness.manager.list()[0].lifecycle, "error");

  fake.stopResult.resolve(NO_CHILD_POSSIBLE);
  await settleIo();
  assert.equal(harness.manager.hasLiveProcesses(), false);
  assert.equal(harness.manager.closeError(id), true);
});

test("dispose frees an exited wrapper's surface without dropping unproven custody", async () => {
  const harness = makeHarness("dispose-surface", { composition: true, adapterMode: "fake" });
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
  const id = onlyRowId(harness.manager);
  const fake = harness.fakeAdapters[0];
  harness.adapterOptions[0].spawnWrapper({
    file: POWERSHELL_PATH,
    args: ["-NoLogo"],
    script: "synthetic",
    encoded: "synthetic",
    commandLineLength: 1,
  });
  fake.launchResult.resolve(LAUNCHED_RESULT);
  assert.equal(await creating, id);
  const surface = harness.manager.surface(id);
  assert.ok(surface);
  let surfaceDisposals = 0;
  const disposeSurface = surface.dispose.bind(surface);
  surface.dispose = (): void => {
    surfaceDisposals += 1;
    disposeSurface();
  };

  harness.spawned[0].emitExit(0);
  await waitFor(() => fake.stopCalls === 1, "slot stop after the exit");
  fake.stopResult.resolve(UNPROVEN_SETTLEMENT);
  await settleIo();

  await harness.dispose();
  assert.equal(surfaceDisposals, 1, "the exited wrapper's surface is disposed exactly once");
  assert.equal(harness.manager.hasLiveProcesses(), true, "unproven custody is still owned");
});

interface CappedReaderOrdering {
  readonly harness: Harness;
  readonly order: string[];
  readonly deadlines: number[];
  readonly fake: FakeCustodyAdapter;
}

/**
 * One live custody wrapper with the EXACT captured #666 reader record, a fake
 * adapter whose deferred stop is released from its own abort listener, and a
 * synchronous exit emitted from that listener. The recorded order proves WHEN the
 * manager capped the reader, with no dependence on wall-clock timing.
 */
async function armCappedReaderOrdering(label: string): Promise<CappedReaderOrdering> {
  const harness = makeHarness(label, { composition: true, adapterMode: "fake", ptyOwnedReaderUnconfirmed: true });
  const creating = harness.manager.create({ workspace: harness.workspace, backend: "claude" });
  await waitFor(() => harness.fakeAdapters.length === 1, "adapter admission");
  const fake = harness.fakeAdapters[0];
  harness.adapterOptions[0].spawnWrapper({
    file: POWERSHELL_PATH,
    args: ["-NoLogo"],
    script: "synthetic",
    encoded: "synthetic",
    commandLineLength: 1,
  });
  fake.launchResult.resolve(LAUNCHED_RESULT);
  assert.equal(await creating, onlyRowId(harness.manager));
  const record = ownedConptyReaderRecord(harness.spawned[0]);
  assert.ok(record, "the manager owns the exact captured reader record");

  const order: string[] = [];
  const deadlines: number[] = [];
  const settlement = record.settlement;
  const limitDeadline = settlement.limitConfirmationDeadline.bind(settlement);
  settlement.limitConfirmationDeadline = (deadline: number): void => {
    order.push("cap");
    deadlines.push(deadline);
    limitDeadline(deadline);
  };
  const confirmSettlement = settlement.confirmSettlement.bind(settlement);
  settlement.confirmSettlement = (maxWaitMs?: number): Promise<boolean> => {
    order.push("confirm");
    return confirmSettlement(maxWaitMs);
  };
  harness.adapterOptions[0].signal?.addEventListener("abort", () => {
    // Foreign synchronous reaction to the manager's cancellation: report the exact
    // wrapper exit (which anchors the reader's natural deadline) before returning.
    order.push("abort-exit");
    harness.spawned[0].emitExit(0);
    // A complete stop proof: the settlement then consults the capped #666 reader,
    // which is required-but-unconfirmable for this synthetic handle.
    fake.stopResult.resolve(WITNESSED_EMPTY);
  });
  return { harness, order, deadlines, fake };
}

/** Every observed cap must precede the abort-reported exit; the first event is the cap. */
function assertCappedBeforeExit(order: string[]): void {
  assert.equal(order[0], "cap", "the reader deadline is capped before the custody stop is queued");
  assert.ok(order.includes("abort-exit"), "the adapter reported the exact wrapper exit from abort");
  assert.ok(
    order.indexOf("cap") < order.indexOf("abort-exit"),
    `cap must precede the synchronous exit (observed: ${order.join(",")})`,
  );
  assert.ok(order.includes("confirm"), "the settlement observed the capped reader");
}

test("shutdown caps the exact live custody reader deadline before its stop can report an exit", async (t) => {
  const setup = await armCappedReaderOrdering("cap-shutdown");
  // Freeze the clock AFTER fixture setup: the cap under test is then an exact value,
  // independent of event-loop timing before or after the shutdown await.
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
  try {
    const result = await setup.harness.manager.shutdown({ graceMs: 40, killMs: 40 });
    assertCappedBeforeExit(setup.order);
    assert.equal(
      setup.deadlines[0],
      FIXED_NOW + 40 + 40,
      "the first cap is exactly this shutdown's graceMs + killMs window",
    );
    assert.equal(result.remainingIds.length, 1, "the unconfirmable reader keeps the row retained");
    assert.equal(setup.fake.stopCalls, 1, "the early stop was queued exactly once");
  } finally {
    t.mock.timers.reset();
    await setup.harness.discard();
  }
});

test("disposal caps the exact live custody reader deadline before its stop can report an exit", async (t) => {
  const setup = await armCappedReaderOrdering("cap-dispose");
  // Freeze the clock AFTER fixture setup, then assert the exact disposal default cap.
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW });
  try {
    // The unidentifiable captured reader is a required-but-unconfirmable release, so
    // the existing #666 disposal confirmation rejects after the teardown ran.
    await assert.rejects(
      setup.harness.manager.dispose(),
      /owned Windows ConPTY reader settlement was not confirmed/,
    );
    assertCappedBeforeExit(setup.order);
    assert.equal(
      setup.deadlines[0],
      FIXED_NOW + DEFAULT_SHUTDOWN_GRACE_MS + DEFAULT_SHUTDOWN_KILL_MS,
      "the first cap is exactly the disposal default window",
    );
    assert.equal(setup.fake.stopCalls, 1, "the early stop was queued exactly once");
    assert.equal(setup.harness.manager.hasLiveProcesses(), true, "unproven custody stays owned");
  } finally {
    t.mock.timers.reset();
    await setup.harness.discard();
  }
});
