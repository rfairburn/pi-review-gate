/**
 * Owned Windows ConPTY reader settlement on the NATIVE CLI launch path
 * (#666 ownership, #277 native CLI rows).
 *
 * Why this file exists: #666 made the default PTY factory capture the exact
 * reader the pinned `@lydell/node-pty` addon creates for a bundled-ConPTY spawn,
 * and made the instance manager track that capture so an unconfirmed required
 * release can never disappear. The manager has TWO spawn stretches — the Pi row
 * launch and the separate native CLI launch — and a native provider child is the
 * same kind of ConPTY child, so it owns the same kind of leaked reader. These
 * cases pin the native branch into the same fail-closed contract: the exact
 * default-factory reader is registered for a native row, it survives closing the
 * native row, a positive settlement is confirmed by the manager's own disposal,
 * and a native reader that never settles keeps disposal an explicit failure.
 *
 * Truthful scope: like the generic controls in
 * `tests/session-host-conpty-reader-settlement.test.ts`, these cases run the
 * PRODUCTION default PTY factory and the PRODUCTION instance manager against a
 * SYNTHETIC handle shaped like the pinned ConPTY-DLL agent, with a real
 * `node:worker_threads` Worker as the owned reader, under a platform override,
 * and with that manager's native agent registry pinned to a synthetic Pi agent
 * directory the fixture owns and removes — never an ambient `~/.pi/agent`.
 * They load no native addon, spawn no Windows process, and prove nothing about a
 * real ConPTY; the real Windows proof is
 * `tests/session-host-native-cli-windows-pty.test.ts`, which runs the same
 * manager path against real ConPTY children. The native launch provider here is
 * a fixture descriptor, because the provider's own composition is covered by the
 * launch-adapter and Windows delivery suites; what is under test is the one
 * integration seam — what the manager hands the pinned public spawn, and what it
 * does with the reader that spawn created.
 *
 * The last case pins a rule the real Windows acceptance harness depends on: a
 * disposal that ran while a handle had not exited confirms nothing, and no later
 * disposal can confirm it retroactively, so observing every owned exit first is
 * the only way a clean disposal can mean the owned readers settled.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  DEFAULT_INSTANCE_COLS,
  DEFAULT_INSTANCE_ROWS,
  DEFAULT_SHUTDOWN_KILL_MS,
  InstanceManager,
  __test as instanceTestSeam,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusRegistration,
  type NativeCliLaunch,
  type StatusRegistrar,
} from "../src/session-host/instances";
import {
  ownedConptyReaderRecord,
  type OwnedConptyReaderSettlement,
} from "../src/session-host/windows-conpty-reader";

/** The pinned addon's documented post-exit drain before it terminates its reader. */
const PINNED_ADDON_DRAIN_MS = 1_000;

function makeTestRoot(label: string): string {
  // Canonicalized up front: the native launch path resolves the row's workspace
  // and requires the descriptor's cwd to be that same canonical identity.
  return realpathSync(mkdtempSync(join(tmpdir(), `prg-native-cli-conpty-${label}-`)));
}

function writeText(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
}

/** Minimal package fixture; a native row never consumes it, but the manager requires the root. */
function makePackageFixture(root: string): { packageRoot: string; piExecutable: string } {
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeText(join(packageRoot, "dist", "src", "index.js"), "// Synthetic fixture; never imported or executed.\n");
  writeText(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture; never imported or executed.\n");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeText(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n// Synthetic inert Node CLI fixture.\n");
  chmodSync(piExecutable, 0o755);
  return { packageRoot, piExecutable };
}

/**
 * A native row owns no status registration, so this registrar exists only to
 * prove that: a provider child must never make the manager register one.
 */
class RecordingRegistrar implements StatusRegistrar {
  readonly requests: string[] = [];

  register(instanceId: string): InstanceStatusRegistration {
    this.requests.push(instanceId);
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: `tok-${instanceId}`,
        instanceId,
        generation: `gen-${instanceId}`,
      },
      release: () => undefined,
    };
  }
}

/**
 * One owned reader: a real Worker plus a connection that counts every drain or
 * dispose call the adapter makes and, unless told otherwise, mirrors the pinned
 * addon by draining first and only then terminating the Worker.
 */
interface OwnedReaderFixture {
  readonly connection: { dispose(): void };
  readonly worker: Worker;
  readonly disposeCalls: number[];
  readonly exitCode: Promise<number>;
}

function makeOwnedReaderFixture(options: { drainMs?: number; settle?: boolean } = {}): OwnedReaderFixture {
  const worker = new Worker("setInterval(() => {}, 1000);", { eval: true });
  const exitCode = new Promise<number>((resolve) => worker.once("exit", resolve));
  const disposeCalls: number[] = [];
  const settle = options.settle ?? true;
  const drainMs = options.drainMs ?? PINNED_ADDON_DRAIN_MS;
  const connection = {
    dispose(): void {
      disposeCalls.push(disposeCalls.length + 1);
      if (!settle) return; // a reader that never settles: the explicit-failure control
      setTimeout(() => { void worker.terminate(); }, drainMs);
    },
  };
  return { connection, worker, disposeCalls, exitCode };
}

/** The pinned addon's ConPTY-DLL reader shape, with the real owned Worker. */
function dllAgentShape(fixture: OwnedReaderFixture): {
  _useConptyDll: boolean;
  _conoutSocketWorker: { _worker: unknown; dispose: () => void };
} {
  return {
    _useConptyDll: true,
    _conoutSocketWorker: { _worker: fixture.worker, dispose: () => fixture.connection.dispose() },
  };
}

/**
 * A public handle shaped like the pinned addon's WindowsTerminal. The agent
 * shape is supplied per spawn because these controls exercise both the recognized
 * bundled-ConPTY chain and a foreign one.
 */
class SyntheticNativePty implements InstancePty {
  readonly pid = 424242;
  cols: number;
  rows: number;
  readonly killSignals: (string | undefined)[] = [];
  readonly #agentShape: unknown;
  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  readonly #errorListeners: ((error: Error) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor, agentShape: unknown) {
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.#agentShape = agentShape;
  }

  get _agent(): unknown {
    return this.#agentShape;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.push(listener);
    return { dispose: () => { remove(this.#dataListeners, listener); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => { remove(this.#exitListeners, listener); } };
  }

  /** The pinned handle's inherited EventEmitter error channel, as `subscribePtyReadErrors` requires. */
  on(eventName: "error", listener: (error: Error) => void): unknown {
    assert.equal(eventName, "error");
    this.#errorListeners.push(listener);
    return this;
  }

  removeListener(eventName: "error", listener: (error: Error) => void): unknown {
    assert.equal(eventName, "error");
    remove(this.#errorListeners, listener);
    return this;
  }

  write(): void { /* not used by these controls */ }

  resize(columns: number, rows: number): void { this.cols = columns; this.rows = rows; }

  kill(signal?: string): void { this.killSignals.push(signal); }

  pause(): void { /* not used by these controls */ }

  resume(): void { /* not used by these controls */ }

  /** Dispatch like the addon does: from a snapshot, so a duplicate exit is possible. */
  emitExit(exitCode: number, signal?: number): void {
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }
}

function remove<T>(list: T[], value: T): void {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
}

interface NativeHarness {
  root: string;
  workspace: string;
  manager: InstanceManager;
  registrar: RecordingRegistrar;
  spawned: SyntheticNativePty[];
  spawnCalls: { file: string; args: string[] | string; options: Record<string, unknown> }[];
}

/**
 * A manager with NO injected `ptyFactory`, so the production default factory —
 * and therefore the #666 adapter — is the only spawn path, plus a native CLI
 * launch provider that composes the two delivery shapes a real provider child
 * uses: one pre-escaped `cmd.exe` batch command line and one direct executable.
 */
function makeNativeHarness(
  label: string,
  harnessOptions: { readonly fixture?: OwnedReaderFixture; readonly agentShape?: unknown } = {},
): NativeHarness {
  const root = makeTestRoot(label);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const pkg = makePackageFixture(root);
  // With no injected preparer the manager builds the production native agent
  // registry, which resolves the canonical Pi agent directory AT CONSTRUCTION.
  // Point it at a directory this fixture owns inside its own temp root, so a
  // control neither reads nor creates an ambient `~/.pi/agent`: on a host with
  // no Pi home at all the construction below would fail closed for the wrong
  // reason, and here it always resolves inside `root` and is removed with it.
  const agentDir = join(root, "native-agent");
  mkdirSync(agentDir, { recursive: true });
  const spawned: SyntheticNativePty[] = [];
  const spawnCalls: NativeHarness["spawnCalls"] = [];
  instanceTestSeam.setNodePtyLoaderForTests(() => ({
    spawn(file, args, options) {
      spawnCalls.push({ file, args, options: { ...options } });
      const descriptor: InstanceSpawnDescriptor = {
        file,
        args: Array.isArray(args) ? args : [],
        ...(Array.isArray(args) ? {} : { commandLine: args }),
        env: options.env,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
      };
      const pty = new SyntheticNativePty(descriptor, harnessOptions.agentShape ?? dllAgentShape(harnessOptions.fixture!));
      spawned.push(pty);
      return pty as unknown as import("@lydell/node-pty").IPty;
    },
  }));
  const registrar = new RecordingRegistrar();
  const nativeCliLaunch: NativeCliLaunch = (_backend, request) => {
    // Two delivery shapes, one per backend: the batch shape a `.cmd`/`.bat` shim
    // gets (no argv, one pre-escaped command line appended verbatim after cmd.exe)
    // and the direct executable shape, which keeps its argv array.
    return _backend === "claude"
      ? {
        file: "C:\\synthetic\\System32\\cmd.exe",
        args: [],
        commandLine: '/d /s /v:off /c "C:\\fixture\\bin\\claude.cmd" "--profile" "host profile"',
        env: { Path: "C:\\fixture\\bin" },
        cwd: request.workspace,
      }
      : {
        file: "C:\\synthetic\\node.exe",
        args: ["C:\\fixture\\synth\\codex wrapper.js", "--no-daemon"],
        env: { Path: "C:\\fixture\\bin" },
        cwd: request.workspace,
      };
  };
  const manager = new InstanceManager({
    packageRoot: pkg.packageRoot,
    piExecutable: pkg.piExecutable,
    statusRegistrar: registrar,
    nativeCliLaunch,
    args: [],
    env: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: agentDir },
  });
  return { root, workspace: realpathSync(workspace), manager, registrar, spawned, spawnCalls };
}

function withPlatform<T>(platform: NodeJS.Platform, body: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(original);
  Object.defineProperty(process, "platform", { ...original, value: platform });
  return body().finally(() => Object.defineProperty(process, "platform", original));
}

function settlementOf(handle: object): OwnedConptyReaderSettlement {
  const settlement = ownedConptyReaderRecord(handle)?.settlement;
  assert.ok(settlement, "this control expects an owned reader settlement");
  return settlement;
}

async function createNativeRow(harness: NativeHarness, backend: "claude" | "codex"): Promise<string> {
  return await harness.manager.create({ workspace: harness.workspace, backend });
}

/**
 * Release everything one control owns, in the order that can never strand the
 * test host: the loader seam first (a harness that threw mid-construction may
 * already have registered one), then the owned reader Worker — AWAITED, because
 * a live Worker is exactly what keeps a finished test file's process alive —
 * then the fixture tree. Both resources are optional because every control
 * reaches this before either one exists; a teardown that fails or never returns
 * is reported through the control, never swallowed into a false pass.
 */
async function cleanup(
  fixture: OwnedReaderFixture | undefined,
  harness: NativeHarness | undefined,
): Promise<void> {
  instanceTestSeam.setNodePtyLoaderForTests(undefined);
  if (fixture !== undefined) await fixture.worker.terminate();
  if (harness !== undefined) rmSync(harness.root, { recursive: true, force: true });
}

test("a native CLI row's batch command line and public spawn arguments reach the pinned spawn unchanged, and its exact reader is captured", async () => {
  // The owned Worker and the harness are both created INSIDE the try, with the
  // cleanup below already reachable: a harness whose construction throws must
  // still terminate the Worker it never got to use.
  let ownedFixture: OwnedReaderFixture | undefined;
  let ownedHarness: NativeHarness | undefined;
  try {
    const fixture = makeOwnedReaderFixture();
    ownedFixture = fixture;
    const harness = makeNativeHarness("capture", { fixture });
    ownedHarness = harness;
    await withPlatform("win32", async () => {
      const id = await createNativeRow(harness, "claude");
      assert.equal(harness.spawned.length, 1, "the production default factory spawned the native row");
      const pty = harness.spawned[0];
      assert.ok(pty);
      const call = harness.spawnCalls[0];
      assert.ok(call);
      // The pre-escaped batch string is the pinned spawn's second argument, never
      // an argv array the addon would re-escape, and the public option shape —
      // including the bundled ConPTY DLL choice — is unchanged by the adapter.
      assert.equal(call.file, "C:\\synthetic\\System32\\cmd.exe");
      assert.equal(call.args, '/d /s /v:off /c "C:\\fixture\\bin\\claude.cmd" "--profile" "host profile"');
      assert.deepEqual(call.options, {
        name: "xterm-256color",
        cols: DEFAULT_INSTANCE_COLS,
        rows: DEFAULT_INSTANCE_ROWS,
        cwd: harness.workspace,
        env: { Path: "C:\\fixture\\bin" },
        useConptyDll: true,
      }, "the public spawn arguments are exactly what the native launch path composed");

      const record = ownedConptyReaderRecord(pty);
      assert.ok(record?.captured, "the exact owned reader was captured from the handle this factory just created");
      const settlement = settlementOf(pty);
      assert.equal(settlement.state, "pending", "capture alone confirms nothing and settles nothing");
      assert.equal(settlement.disposalRequested, false, "capture alone never disposes");
      assert.deepEqual(fixture.disposeCalls, [], "the owned connection was not touched at spawn");
      assert.deepEqual(pty.killSignals, [], "no native kill was attempted on the live handle");
      assert.equal(harness.manager.list().find((row) => row.id === id)?.lifecycle, "alive");
      assert.deepEqual(harness.registrar.requests, [], "a native CLI row owns no status registration");
    });
  } finally {
    await cleanup(ownedFixture, ownedHarness);
  }
});

test("a native CLI row's direct executable keeps its argv array and still captures its exact owned reader", async () => {
  let ownedFixture: OwnedReaderFixture | undefined;
  let ownedHarness: NativeHarness | undefined;
  try {
    const fixture = makeOwnedReaderFixture();
    ownedFixture = fixture;
    const harness = makeNativeHarness("direct-exe", { fixture });
    ownedHarness = harness;
    await withPlatform("win32", async () => {
      await createNativeRow(harness, "claude");
      await createNativeRow(harness, "codex");
      assert.equal(harness.spawned.length, 2);
      const direct = harness.spawned[1];
      const call = harness.spawnCalls[1];
      assert.ok(direct && call);
      assert.equal(Object.hasOwn(call.options, "commandLine"), false,
        "the command line is never added to the public spawn options");
      assert.equal(Array.isArray(call.args), true, "a direct executable is delivered as an argv array");
      assert.deepEqual(call.args, ["C:\\fixture\\synth\\codex wrapper.js", "--no-daemon"]);
      assert.equal(call.options.useConptyDll, true);
      assert.ok(ownedConptyReaderRecord(direct)?.captured, "the second native row captures its own exact reader");
      assert.notEqual(settlementOf(direct), settlementOf(harness.spawned[0]), "each native row tracks its own reader");
    });
  } finally {
    await cleanup(ownedFixture, ownedHarness);
  }
});

test("a native CLI row's owned reader is confirmed by manager disposal after the native row is closed", async () => {
  let ownedFixture: OwnedReaderFixture | undefined;
  let ownedHarness: NativeHarness | undefined;
  try {
    const fixture = makeOwnedReaderFixture();
    ownedFixture = fixture;
    const harness = makeNativeHarness("confirmed", { fixture });
    ownedHarness = harness;
    await withPlatform("win32", async () => {
      const id = await createNativeRow(harness, "codex");
      const pty = harness.spawned[0];
      assert.ok(pty);
      const settlement = settlementOf(pty);
      assert.equal(settlement.disposalRequested, false, "no release before the real exit event");

      const exitedAt = Date.now();
      pty.emitExit(0);
      // A duplicate public exit event (the addon can reach 'exit' twice) must not
      // re-arm the addon's drain.
      pty.emitExit(0);
      assert.equal(settlement.disposalRequested, true, "the exact handle's exit triggered the owned release");
      assert.deepEqual(fixture.disposeCalls, [1], "the addon's drain/dispose path ran exactly once");
      assert.deepEqual(pty.killSignals, [], "no native kill was used to make the reader settle");

      // Closing the native row must not launder the tracked release away: the
      // manager keeps the settlement, and its disposal waits for the real Worker.
      assert.equal(harness.manager.closeExited(id), true, "the exited native row is closed by its owner");
      assert.equal(harness.manager.list().some((row) => row.id === id), false, "the row is gone from the roster");
      await harness.manager.dispose();
      const waitedMs = Date.now() - exitedAt;
      assert.equal(settlement.state, "settled", "truthful terminal state");
      assert.ok(settlement.settled, "settlement is confirmed only from the captured Worker's own exit");
      assert.equal(typeof await fixture.exitCode, "number", "the owned reader Worker actually exited");
      assert.ok(waitedMs >= PINNED_ADDON_DRAIN_MS - 50,
        "disposal waited for the actual reader drain instead of assuming success");
      assert.ok(waitedMs <= DEFAULT_SHUTDOWN_KILL_MS + 5_000,
        "the existing confirmation window bounds the wait; no new deadline was introduced");
    });
  } finally {
    await cleanup(ownedFixture, ownedHarness);
  }
});

test("an unconfirmed native CLI reader keeps manager disposal an explicit failure, even after its row is closed", async () => {
  let ownedFixture: OwnedReaderFixture | undefined;
  let ownedHarness: NativeHarness | undefined;
  try {
    const fixture = makeOwnedReaderFixture({ settle: false });
    ownedFixture = fixture;
    const harness = makeNativeHarness("unsettled", { fixture });
    ownedHarness = harness;
    await withPlatform("win32", async () => {
      const id = await createNativeRow(harness, "claude");
      const pty = harness.spawned[0];
      assert.ok(pty);
      pty.emitExit(0);
      assert.deepEqual(fixture.disposeCalls, [1], "the owned release was attempted exactly once");
      assert.equal(harness.manager.closeExited(id), true, "the exited native row closes normally");
      assert.equal(harness.manager.list().some((row) => row.id === id), false);
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/,
        "row removal never launders an unconfirmed native release into success");
      assert.equal(settlementOf(pty).settled, false, "the adapter never claims a settlement it did not observe");
    });
  } finally {
    await cleanup(ownedFixture, ownedHarness);
  }
});

test("a native CLI reader whose ownership was never identified still reports an unconfirmed release at disposal", async () => {
  // A handle the pinned addon did not build with the bundled-ConPTY agent: the
  // adapter records it as not captured, and the native path must still treat the
  // resulting required release as a failure rather than as nothing owned.
  let ownedHarness: NativeHarness | undefined;
  try {
    const harness = makeNativeHarness("unidentified", { agentShape: { _useConptyDll: false } });
    ownedHarness = harness;
    await withPlatform("win32", async () => {
      const id = await createNativeRow(harness, "codex");
      const pty = harness.spawned[0];
      assert.ok(pty);
      const record = ownedConptyReaderRecord(pty);
      assert.ok(record, "the default factory still recorded what it could not identify");
      assert.equal(record.captured, false, "a foreign agent chain is never claimed as owned");
      pty.emitExit(0);
      assert.equal(harness.manager.list().find((row) => row.id === id)?.lifecycle, "exited",
        "the manager independently received the genuine public PTY exit");
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/,
        "an unidentified native release is required cleanup, not an absent one");
    });
  } finally {
    await cleanup(undefined, ownedHarness);
  }
});

/**
 * Why the Windows acceptance harness must observe every owned exit BEFORE it asks
 * the manager to dispose.
 *
 * Disposal owes a native reader nothing while its handle has not exited, so a
 * disposal that runs first resolves clean — and a later exit, however it is
 * produced, makes that release due only afterwards. Nothing in that run can ever
 * confirm it: the manager caches its disposal promise, so a second `dispose()`
 * re-offers the same clean outcome instead of a fresh confirmation. This control
 * pins that asymmetry so a fixture can never mistake "disposal resolved" for
 * "every owned reader settled".
 */
test("a native CLI reader whose handle exits after disposal was never confirmed by that disposal", async () => {
  let ownedFixture: OwnedReaderFixture | undefined;
  let ownedHarness: NativeHarness | undefined;
  try {
    const fixture = makeOwnedReaderFixture();
    ownedFixture = fixture;
    const harness = makeNativeHarness("late-exit", { fixture });
    ownedHarness = harness;
    await withPlatform("win32", async () => {
      const id = await createNativeRow(harness, "claude");
      const pty = harness.spawned[0];
      assert.ok(pty);
      const settlement = settlementOf(pty);
      assert.equal(settlement.exitObserved, false, "the child is still running");

      await harness.manager.dispose();
      assert.equal(settlement.exitObserved, false, "disposal triggered no release for a handle that never exited");
      assert.equal(settlement.settled, false, "a clean disposal confirmed nothing here");
      assert.deepEqual(fixture.disposeCalls, [], "the owned reader was never released");

      // A repeated disposal is the cached outcome, not a second confirmation.
      await harness.manager.dispose();
      assert.equal(settlement.settled, false, "repeating disposal cannot confirm what already resolved");

      pty.emitExit(0);
      assert.equal(settlement.exitObserved, true, "the handle's own exit is what makes the release due");
      assert.equal(settlement.disposalRequested, true, "the release is triggered only now, after disposal ended");
      assert.equal(harness.manager.list().find((row) => row.id === id)?.exitCode, 0,
        "the child's real exit is still recorded truthfully");
      await fixture.exitCode;
      // And the late release is not a late pass either. The stop ladder this
      // disposal ran already spent the confirmation window, and that cap is
      // shortening-only, so a Worker exit that arrives afterwards is an explicit
      // `settlement-timeout` failure. A fixture that disposed before observing the
      // exit therefore has no confirmation to report at all — only a cleanup that
      // came due too late to be confirmed, which is why the acceptance harness
      // observes every owned exit first and fails on any handle still pending.
      assert.equal(settlement.settled, false, "a release that came due after disposal is never a late pass");
      assert.equal(settlement.state, "failed", "the late release stays an explicit failure");
      assert.equal(settlement.refusal, "settlement-timeout",
        "the exhausted stop budget, not a missing exit, is what left this unconfirmed");
    });
  } finally {
    await cleanup(ownedFixture, ownedHarness);
  }
});
