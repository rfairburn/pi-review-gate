/**
 * Generic lifecycle controls for the owned Windows ConPTY reader settlement
 * adapter (#666).
 *
 * Truthful scope: these cases run the production default PTY factory and the
 * production instance manager against a SYNTHETIC handle shaped like the pinned
 * `@lydell/node-pty` ConPTY-DLL agent, with a real `node:worker_threads` Worker
 * as the owned reader. They prove the adapter's ownership, ordering,
 * exactly-once, and confirmation rules on any host. They load no native addon,
 * spawn no Windows process, and prove nothing about a real ConPTY: the real
 * Windows proof is `tests/session-host-native-windows-conpty-reader.test.ts`.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  DEFAULT_INSTANCE_COLS,
  DEFAULT_INSTANCE_ROWS,
  DEFAULT_SHUTDOWN_KILL_MS,
  InstanceManager,
  createDefaultPtyFactory,
  __test as instanceTestSeam,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusRegistration,
  type PtyFactory,
  type StatusRegistrar,
} from "../src/session-host/instances";
import {
  captureOwnedConptyReader,
  ownedConptyReaderRecord,
  type OwnedConptyReaderSettlement,
} from "../src/session-host/windows-conpty-reader";
import { ProfileRegistry } from "../src/session-host/profiles";

/** The pinned addon's documented post-exit drain before it terminates its reader. */
const PINNED_ADDON_DRAIN_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeTestRoot(label: string): string {
  return realpathSync(mkdtempSync(join(process.cwd(), `.prg-conpty-${label}-`)));
}

function writeText(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
}

/** Synthetic package root satisfying the launch descriptor's package and skill checks. */
function makePackageFixture(root: string): { packageRoot: string; piExecutable: string } {
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  writeText(join(packageRoot, "dist", "src", "index.js"), "// Synthetic fixture; never imported or executed.\n");
  writeText(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic fixture; never imported or executed.\n");
  writeText(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic fixture; never imported or executed.\n");
  for (const [skill, files] of [
    ["pi-review-gate-orchestrator", ["SKILL.md", "references/recovery.md"]],
    ["pi-review-gate-execution", ["SKILL.md"]],
    ["pi-review-gate-research", ["SKILL.md"]],
    ["pi-review-gate-completion", ["SKILL.md"]],
  ] as const) {
    for (const file of files) {
      const path = join(packageRoot, "skills", skill, ...file.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      writeText(path, `${skill}/${file}\n`);
    }
  }
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeText(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n// Synthetic inert Node CLI fixture.\n");
  chmodSync(piExecutable, 0o755);
  return { packageRoot, piExecutable };
}

class MinimalRegistrar implements StatusRegistrar {
  readonly released: string[] = [];

  register(instanceId: string): InstanceStatusRegistration {
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: `tok-${instanceId}`,
        instanceId,
        generation: `gen-${instanceId}`,
      },
      release: () => { this.released.push(instanceId); },
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

/**
 * The pinned addon's ConPTY-DLL reader shape, with the real owned Worker. The
 * returned object is deliberately mutable, because the addon's own slots are.
 */
interface MutableAgentShape {
  _useConptyDll: boolean;
  _conoutSocketWorker: { _worker: unknown; dispose: () => void };
}

function dllAgentShape(fixture: OwnedReaderFixture): MutableAgentShape {
  return {
    _useConptyDll: true,
    _conoutSocketWorker: { _worker: fixture.worker, dispose: () => fixture.connection.dispose() },
  };
}

/**
 * A public handle shaped like the pinned addon's WindowsTerminal. The agent
 * shape is supplied per spawn so foreign, replaced, and unrecognized ownership
 * can be exercised without loading any real native module.
 */
class SyntheticConptyPty implements InstancePty {
  readonly pid = 424242;
  cols: number;
  rows: number;
  readonly killSignals: (string | undefined)[] = [];
  exited = false;
  #agentShape: unknown;
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

  /** Models the addon's mutable internal slot: ownership can be replaced after spawn. */
  replaceAgent(shape: unknown): void {
    this.#agentShape = shape;
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
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }
}

function remove<T>(list: T[], value: T): void {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
}

interface DefaultFactoryHarness {
  root: string;
  manager: InstanceManager;
  spawned: SyntheticConptyPty[];
  spawnOptions: unknown[];
}

/**
 * A manager built with NO injected `ptyFactory`, so the production default
 * factory — and therefore the #666 adapter — is the only spawn path, while the
 * pinned native module itself stays replaced by an inert loader.
 */
function makeDefaultFactoryHarness(label: string, agentShapeFor: () => unknown): DefaultFactoryHarness {
  const root = makeTestRoot(label);
  const pkg = makePackageFixture(root);
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  const spawned: SyntheticConptyPty[] = [];
  const spawnOptions: unknown[] = [];
  instanceTestSeam.setNodePtyLoaderForTests(() => ({
    spawn(file, args, options) {
      spawnOptions.push({ ...options });
      const descriptor: InstanceSpawnDescriptor = {
        file,
        args,
        env: options.env,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
      };
      const pty = new SyntheticConptyPty(descriptor, agentShapeFor());
      spawned.push(pty);
      return pty as unknown as import("@lydell/node-pty").IPty;
    },
  }));
  const manager = new InstanceManager({
    packageRoot: pkg.packageRoot,
    piExecutable: pkg.piExecutable,
    statusRegistrar: new MinimalRegistrar(),
    nativeSetup: false,
    profileRegistry: new ProfileRegistry({ stateRoot }),
    args: [],
    env: { PATH: "/usr/bin" },
    cols: DEFAULT_INSTANCE_COLS,
    rows: DEFAULT_INSTANCE_ROWS,
  });
  return { root, manager, spawned, spawnOptions };
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

async function createRow(harness: DefaultFactoryHarness): Promise<string> {
  const workspace = join(harness.root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return await harness.manager.create({ workspace });
}

test("the default factory captures the exact owned reader at spawn and returns the identical public handle", async () => {
  const fixture = makeOwnedReaderFixture();
  const harness = makeDefaultFactoryHarness("capture", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      const factory: PtyFactory = createDefaultPtyFactory();
      const returned = factory({
        file: "C:\\synthetic\\node.exe",
        args: ["--offline"],
        env: { PATH: "C:\\synthetic" },
        cwd: harness.root,
        cols: 91,
        rows: 37,
      });
      const pty = harness.spawned[0];
      assert.ok(pty);
      assert.equal(returned, pty, "the exact public PTY handle is returned, never wrapped or replaced");
      assert.deepEqual(harness.spawnOptions, [{
        name: "xterm-256color",
        cols: 91,
        rows: 37,
        cwd: harness.root,
        env: { PATH: "C:\\synthetic" },
        useConptyDll: true,
      }], "the public spawn arguments are unchanged by the adapter");
      const record = ownedConptyReaderRecord(pty);
      assert.ok(record?.captured, "the exact owned reader was captured from the handle this factory just created");
      const settlement = settlementOf(pty);
      assert.equal(settlement.state, "pending", "capture alone confirms nothing and settles nothing");
      assert.equal(settlement.disposalRequested, false, "capture alone never disposes");
      assert.deepEqual(fixture.disposeCalls, [], "the owned connection was not touched at spawn");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("reader release refuses to precede the exact PTY's genuine exit and stays bounded while pending", async () => {
  const fixture = makeOwnedReaderFixture();
  const harness = makeDefaultFactoryHarness("pre-exit", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      const factory = createDefaultPtyFactory();
      factory({ file: "node", args: [], env: {}, cwd: harness.root, cols: 80, rows: 24 });
      const pty = harness.spawned[0];
      const settlement = settlementOf(pty);
      // A row that is still running owes no reader release, and asking whether it
      // has settled must answer "not confirmed" at once: no release is due yet, so
      // there is no window to wait inside.
      assert.equal(await settlement.confirmSettlement(), false,
        "an undisposed owned reader is never reported as settled");
      assert.equal(settlement.disposalRequested, false, "nothing requested a release before the exit event");
      assert.deepEqual(fixture.disposeCalls, [], "the owned reader connection is untouched before the exit");
      assert.deepEqual(pty.killSignals, [], "no native kill was attempted on the live handle");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a genuine exit releases the owned reader exactly once and the manager confirms real settlement", async () => {
  const fixture = makeOwnedReaderFixture();
  const harness = makeDefaultFactoryHarness("settled", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      const id = await createRow(harness);
      const pty = harness.spawned[0];
      assert.ok(pty, "the production default factory spawned the row");
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

      // Disposal must wait for the real Worker exit inside the existing
      // confirmation window, then resolve on positive evidence.
      await harness.manager.dispose();
      const waitedMs = Date.now() - exitedAt;
      assert.equal(settlement.state, "settled", "truthful terminal state");
      assert.ok(settlement.settled, "settlement is confirmed only from the captured Worker's own exit");
      assert.equal(typeof await fixture.exitCode, "number", "the owned reader Worker actually exited");
      assert.ok(waitedMs >= PINNED_ADDON_DRAIN_MS - 50,
        "disposal waited for the actual reader drain instead of assuming success");
      assert.ok(waitedMs <= DEFAULT_SHUTDOWN_KILL_MS + 5_000,
        "the existing confirmation window bounds the wait; no new deadline was introduced");
      assert.equal(harness.manager.list().find((row) => row.id === id)?.exitCode, 0,
        "the child's real exit code is preserved through the settlement path");
      assert.deepEqual(pty.killSignals, [], "disposal added no native kill after the exit");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a reader whose disposal never settles keeps manager disposal an explicit failure", async () => {
  const fixture = makeOwnedReaderFixture({ settle: false });
  const harness = makeDefaultFactoryHarness("unsettled", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      await createRow(harness);
      const pty = harness.spawned[0];
      const settlement = settlementOf(pty);
      pty.emitExit(0);
      assert.deepEqual(fixture.disposeCalls, [1], "the owned release was attempted exactly once");
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/,
        "an unconfirmed required cleanup is never reported as success");
      assert.equal(settlement.settled, false, "the adapter never claims a settlement it did not observe");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an unavailable adapter exit subscription cannot hide a required cleanup failure", async () => {
  const fixture = makeOwnedReaderFixture();
  const harness = makeDefaultFactoryHarness("trigger-unavailable", () => dllAgentShape(fixture));
  const originalOnExit = SyntheticConptyPty.prototype.onExit;
  let refusedAdapterSubscription = false;
  SyntheticConptyPty.prototype.onExit = function (this: SyntheticConptyPty, listener) {
    if (!refusedAdapterSubscription) {
      refusedAdapterSubscription = true;
      throw new Error("synthetic adapter subscription failure");
    }
    return originalOnExit.call(this, listener);
  };
  try {
    await withPlatform("win32", async () => {
      const id = await createRow(harness);
      const pty = harness.spawned[0];
      const settlement = settlementOf(pty);
      assert.equal(settlement.refusal, "trigger-unavailable");
      pty.emitExit(0);
      assert.equal(harness.manager.list().find((row) => row.id === id)?.exitCode, 0,
        "the manager independently received the genuine public PTY exit");
      assert.equal(settlement.exitObserved, false, "the failed adapter trigger is not fabricated");
      await assert.rejects(harness.manager.dispose(), /owned Windows ConPTY reader settlement was not confirmed/,
        "a missing adapter trigger cannot turn required cleanup into success");
      assert.deepEqual(fixture.disposeCalls, [], "no unconfirmed disposal trigger was guessed");
      assert.deepEqual(pty.killSignals, [], "no native kill was used after the actual exit");
    });
  } finally {
    SyntheticConptyPty.prototype.onExit = originalOnExit;
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("closing an exited row cannot hide an unconfirmed owned reader release", async () => {
  const fixture = makeOwnedReaderFixture({ settle: false });
  const harness = makeDefaultFactoryHarness("closed-row", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      const id = await createRow(harness);
      const pty = harness.spawned[0];
      pty.emitExit(0);
      assert.equal(harness.manager.closeExited(id), true, "the exited row is closed by its owner");
      assert.equal(harness.manager.list().some((row) => row.id === id), false, "the row is gone from the roster");
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/,
        "row removal never launders an unconfirmed required release into success");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("foreign, replaced, and unrecognized reader ownership is never touched and stays a failure", async () => {
  let touched = 0;
  const foreignReader = {
    terminate: async () => { touched += 1; return 0; },
    once: () => { touched += 1; },
  };
  const shapes: { label: string; shape: unknown }[] = [
    { label: "no-agent", shape: undefined },
    { label: "non-dll-backend", shape: { _useConptyDll: false, _conoutSocketWorker: { _worker: foreignReader, dispose: () => { touched += 1; } } } },
    { label: "no-connection", shape: { _useConptyDll: true } },
    { label: "connection-without-dispose", shape: { _useConptyDll: true, _conoutSocketWorker: { _worker: foreignReader } } },
    { label: "foreign-reader", shape: { _useConptyDll: true, _conoutSocketWorker: { _worker: foreignReader, dispose: () => { touched += 1; } } } },
    { label: "throwing-getter", shape: { get _useConptyDll(): never { throw new Error("foreign getter"); } } },
  ];
  for (const candidate of shapes) {
    const harness = makeDefaultFactoryHarness(`foreign-${candidate.label}`, () => candidate.shape);
    try {
      await withPlatform("win32", async () => {
        await createRow(harness);
        const pty = harness.spawned[0];
        const record = ownedConptyReaderRecord(pty);
        assert.ok(record, "a bundled-ConPTY spawn always records what it could and could not own");
        assert.equal(record.captured, false, `${candidate.label}: ownership was not established, so nothing is owned`);
        assert.equal(record.settlement.state, "failed",
          `${candidate.label}: an unidentified owner is already an explicit failure`);
        assert.equal(record.settlement.refusal, "ownership-unidentified",
          `${candidate.label}: the reason is recorded truthfully`);
        assert.equal(record.settlement.exitObserved, false, `${candidate.label}: no release is due before the exit`);
        pty.emitExit(0);
        assert.equal(record.settlement.exitObserved, true,
          `${candidate.label}: the real exit makes the unconfirmable release due`);
        assert.equal(touched, 0, `${candidate.label}: the foreign or replaced reader was never touched`);
        await assert.rejects(harness.manager.dispose(),
          /owned Windows ConPTY reader settlement was not confirmed/,
          `${candidate.label}: an unidentified required cleanup stays an explicit failure`);
      });
    } finally {
      instanceTestSeam.setNodePtyLoaderForTests(undefined);
      rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test("POSIX default-factory handles have no owned addon reader record and keep unchanged behavior", async () => {
  const fixture = makeOwnedReaderFixture();
  const harness = makeDefaultFactoryHarness("posix", () => dllAgentShape(fixture));
  try {
    await withPlatform("darwin", async () => {
      const factory = createDefaultPtyFactory();
      const returned = factory({ file: "node", args: [], env: { PATH: "/usr/bin" }, cwd: harness.root, cols: 80, rows: 24 });
      const pty = harness.spawned[0];
      assert.equal(returned, pty, "the POSIX public handle is returned unchanged");
      assert.equal(Object.hasOwn(harness.spawnOptions[0] as object, "useConptyDll"), false,
        "the Windows-only bundled ConPTY selection is still never set on a POSIX host");
      assert.equal(ownedConptyReaderRecord(pty), undefined,
        "a POSIX handle is never registered as owning a Windows ConPTY reader");
      assert.deepEqual(fixture.disposeCalls, [], "the POSIX path never touches a reader");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an injected custom PTY factory is invisible to the reader adapter and disposes unchanged", async () => {
  const root = makeTestRoot("custom-factory");
  const pkg = makePackageFixture(root);
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  const fixture = makeOwnedReaderFixture();
  const handle = new SyntheticConptyPty(
    { file: "node", args: [], env: {}, cwd: root, cols: 80, rows: 24 },
    dllAgentShape(fixture),
  );
  const manager = new InstanceManager({
    packageRoot: pkg.packageRoot,
    piExecutable: pkg.piExecutable,
    statusRegistrar: new MinimalRegistrar(),
    nativeSetup: false,
    profileRegistry: new ProfileRegistry({ stateRoot }),
    args: [],
    env: { PATH: "/usr/bin" },
    ptyFactory: () => handle,
  });
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    await manager.create({ workspace });
    assert.equal(ownedConptyReaderRecord(handle), undefined,
      "an injected factory's handle is never treated as an owned addon reader");
    handle.emitExit(0);
    await manager.dispose();
    assert.deepEqual(fixture.disposeCalls, [], "a custom factory keeps full ownership of its own resources");
    assert.deepEqual(handle.killSignals, [], "disposal of a settled custom row used no native kill");
  } finally {
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replaced handle, agent, connection, Worker, or dispose slot is refused at exit and never called", async () => {
  // Every slot the pinned addon reaches its reader through is mutable, so any of
  // them can be replaced between spawn and exit. Each case proves the adapter
  // invokes nothing — neither the captured method nor any replacement — records
  // the refusal truthfully, and keeps the required cleanup an explicit failure
  // instead of rebinding to whatever the handle points at now.
  interface ReplacementContext {
    readonly pty: SyntheticConptyPty;
    readonly shape: MutableAgentShape;
    readonly calls: string[];
    /** Extra checks run after the refused exit, while the foreign resource is still live. */
    readonly verify: (() => Promise<void>)[];
  }
  interface ReplacementCase {
    readonly label: string;
    readonly replace: (context: ReplacementContext) => void;
  }
  const cases: ReplacementCase[] = [
    { label: "agent", replace: (ctx) => ctx.pty.replaceAgent({ replacement: "agent" }) },
    { label: "agent-throwing-getter", replace: (ctx) => ctx.pty.replaceAgent({ get _useConptyDll(): never { throw new Error("replaced getter"); } }) },
    { label: "non-dll-agent", replace: (ctx) => ctx.pty.replaceAgent({ _useConptyDll: false, _conoutSocketWorker: {} }) },
    { label: "connection", replace: (ctx) => {
      ctx.shape._conoutSocketWorker = {
        _worker: ctx.shape._conoutSocketWorker._worker,
        dispose: () => ctx.calls.push("replacement-connection-dispose"),
      };
    } },
    { label: "worker", replace: (ctx) => {
      // Same connection object, replaced Worker slot: the captured Worker must
      // stay untouched, and so must the foreign one that took its place.
      const other = new Worker("setInterval(() => {}, 1000);", { eval: true });
      const otherExited = new Promise<number>((resolve) => other.once("exit", resolve));
      ctx.shape._conoutSocketWorker._worker = other;
      ctx.verify.push(async () => {
        assert.equal(typeof await other.terminate(), "number",
          "the foreign Worker was still live, so the adapter never touched it");
      });
    } },
    { label: "dispose-slot", replace: (ctx) => {
      ctx.shape._conoutSocketWorker.dispose = () => ctx.calls.push("replacement-dispose");
    } },
  ];
  for (const candidate of cases) {
    const fixture = makeOwnedReaderFixture();
    const shape = dllAgentShape(fixture);
    const harness = makeDefaultFactoryHarness(`replaced-${candidate.label}`, () => shape);
    const calls: string[] = [];
    const verify: (() => Promise<void>)[] = [];
    try {
      await withPlatform("win32", async () => {
        await createRow(harness);
        const pty = harness.spawned[0];
        const settlement = settlementOf(pty);
        candidate.replace({ pty, shape, calls, verify });
        // The exit now happens against a chain this adapter no longer owns.
        pty.emitExit(0);
        assert.deepEqual(fixture.disposeCalls, [], `${candidate.label}: the captured dispose never ran`);
        assert.deepEqual(calls, [], `${candidate.label}: no replacement method was called`);
        assert.equal(settlement.disposalRequested, false, `${candidate.label}: nothing was invoked, so nothing was requested`);
        assert.equal(settlement.refusal, "ownership-replaced", `${candidate.label}: the replacement is recorded truthfully`);
        assert.equal(await settlement.confirmSettlement(), false, `${candidate.label}: no settlement is claimed`);
        assert.deepEqual(pty.killSignals, [], `${candidate.label}: no native kill was substituted for the refused release`);
        for (const check of verify) await check();
        await assert.rejects(harness.manager.dispose(),
          /owned Windows ConPTY reader settlement was not confirmed/,
          `${candidate.label}: a refused release stays an explicit failure`);
      });
    } finally {
      instanceTestSeam.setNodePtyLoaderForTests(undefined);
      await fixture.worker.terminate().catch(() => undefined);
      rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test("capturing the identical handle again is idempotent and can never schedule a second drain", async () => {
  const fixture = makeOwnedReaderFixture({ drainMs: 10 });
  const harness = makeDefaultFactoryHarness("idempotent", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      await createRow(harness);
      const pty = harness.spawned[0];
      const first = ownedConptyReaderRecord(pty);
      const again = captureOwnedConptyReader(pty, { confirmationWindowMs: DEFAULT_SHUTDOWN_KILL_MS });
      assert.equal(again, first, "repeat capture returns the existing record: no second subscription");
      assert.equal(captureOwnedConptyReader(pty, { confirmationWindowMs: DEFAULT_SHUTDOWN_KILL_MS }), first,
        "and stays idempotent no matter how often it is called");
      pty.emitExit(0);
      assert.deepEqual(fixture.disposeCalls, [1], "exactly one drain/dispose ran for the identical handle");
      await harness.manager.dispose();
      assert.equal(settlementOf(pty).settled, true, "the single owned release is the one that settled");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an expired confirmation window is never restarted and a late settlement is never timely success", async () => {
  const fixture = makeOwnedReaderFixture({ settle: false });
  const harness = makeDefaultFactoryHarness("expired-window", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      await createRow(harness);
      const pty = harness.spawned[0];
      const settlement = settlementOf(pty);
      pty.emitExit(0);
      assert.deepEqual(fixture.disposeCalls, [1], "the release was triggered at the real exit");
      // Let the window anchored at that exit elapse entirely before disposal runs.
      await sleep(DEFAULT_SHUTDOWN_KILL_MS + 250);
      // The reader really does end late. A late positive signal must not become
      // timely success that disposal would then skip as already clean.
      await fixture.worker.terminate();
      assert.equal(typeof await fixture.exitCode, "number", "the owned reader ended after its deadline");
      assert.equal(await settlement.confirmSettlement(), false,
        "an actual Worker exit after expiry cannot become timely success");
      assert.equal(settlement.refusal, "settlement-timeout", "the late ending is recorded as an explicit failure");
      const firstStartedAt = Date.now();
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/,
        "an unconfirmed release is still a failure once its own window passed");
      const firstWaitMs = Date.now() - firstStartedAt;
      assert.ok(firstWaitMs < 500,
        `an expired deadline must fail at once instead of granting a fresh window (waited ${firstWaitMs}ms)`);
      assert.equal(settlement.settled, false, "no settlement was observed, so none is claimed");
      const secondStartedAt = Date.now();
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/,
        "a repeat disposal cannot buy the release more time");
      assert.ok(Date.now() - secondStartedAt < 500, "and it must not wait again either");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a late PTY exit cannot renew an exhausted shutdown budget", async () => {
  const fixture = makeOwnedReaderFixture({ settle: false });
  const harness = makeDefaultFactoryHarness("exhausted-stop", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      await createRow(harness);
      // Spend the whole stop ladder first: it forces, never confirms, and returns.
      await harness.manager.shutdown({ graceMs: 0, killMs: 0 });
      const pty = harness.spawned[0];
      pty.emitExit(0);
      const signals = [...pty.killSignals];
      const startedAt = Date.now();
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/);
      assert.ok(Date.now() - startedAt < 500,
        "disposal must not grant a fresh exit-local confirmation window");
      assert.deepEqual(pty.killSignals, signals, "no native kill after exit");
      assert.deepEqual(fixture.disposeCalls, [1], "the release still ran exactly once at the real exit");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a provisional early Worker exit past the stop budget fails instead of settling", async () => {
  const fixture = makeOwnedReaderFixture({ settle: false });
  const harness = makeDefaultFactoryHarness("provisional-expired", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      await createRow(harness);
      const pty = harness.spawned[0];
      const settlement = settlementOf(pty);
      await fixture.worker.terminate();
      assert.equal(typeof await fixture.exitCode, "number", "the owned reader ended before the PTY did");
      assert.equal(settlement.settled, false, "provisional until the handle's own exit validates the chain");
      // The stop ladder runs and exhausts after that provisional ending.
      await harness.manager.shutdown({ graceMs: 0, killMs: 0 });
      pty.emitExit(0);
      assert.equal(settlement.settled, false, "a provisional exit past the stop budget is never settlement");
      assert.equal(settlement.refusal, "settlement-timeout", "and it is recorded as an explicit failure");
      assert.deepEqual(fixture.disposeCalls, [], "nothing was drained: the owned reader had already ended");
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/);
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("concurrent and later disposal all observe the same unconfirmed-reader rejection", async () => {
  const fixture = makeOwnedReaderFixture({ settle: false });
  const harness = makeDefaultFactoryHarness("concurrent-dispose", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      await createRow(harness);
      const pty = harness.spawned[0];
      pty.emitExit(0);
      const first = harness.manager.dispose();
      // Started while the first disposal is still inside the reader confirmation,
      // after its owned-resource cleanup already flipped the disposed flag.
      const second = harness.manager.dispose();
      await assert.rejects(first, /owned Windows ConPTY reader settlement was not confirmed/);
      await assert.rejects(second, /owned Windows ConPTY reader settlement was not confirmed/,
        "a concurrent dispose cannot resolve while the required cleanup is unconfirmed");
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/,
        "and a later dispose cannot report success either");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a reader that dies before its PTY exit is provisional until the captured chain validates", async () => {
  const calls: string[] = [];
  const fixture = makeOwnedReaderFixture({ settle: false });
  const shape = dllAgentShape(fixture);
  const harness = makeDefaultFactoryHarness("early-exit-replaced", () => shape);
  try {
    await withPlatform("win32", async () => {
      await createRow(harness);
      const pty = harness.spawned[0];
      const settlement = settlementOf(pty);
      await fixture.worker.terminate();
      assert.equal(typeof await fixture.exitCode, "number", "the owned reader ended before the PTY did");
      assert.equal(settlement.settled, false, "an early Worker exit is provisional, never settled");
      // Replace the chain while the record is still provisional, then exit the PTY.
      shape._conoutSocketWorker = { _worker: {}, dispose: () => calls.push("replacement-dispose") };
      pty.emitExit(0);
      // Another row spawning here must not prune the provisional record away.
      await createRow(harness);
      harness.spawned[1]?.emitExit(0);
      assert.equal(settlement.settled, false, "the replaced chain was never validated as owned");
      assert.equal(settlement.refusal, "ownership-replaced", "the replacement is recorded truthfully");
      assert.deepEqual(fixture.disposeCalls, [], "the captured dispose never ran");
      assert.deepEqual(calls, [], "the replacement dispose never ran");
      await assert.rejects(harness.manager.dispose(),
        /owned Windows ConPTY reader settlement was not confirmed/,
        "a provisional early exit plus replaced ownership is never success");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an early owned-reader exit with an intact chain settles at the real exit without a drain", async () => {
  const fixture = makeOwnedReaderFixture();
  const harness = makeDefaultFactoryHarness("early-exit-intact", () => dllAgentShape(fixture));
  try {
    await withPlatform("win32", async () => {
      await createRow(harness);
      const pty = harness.spawned[0];
      const settlement = settlementOf(pty);
      await fixture.worker.terminate();
      assert.equal(typeof await fixture.exitCode, "number", "the owned reader ended before the PTY did");
      assert.equal(settlement.settled, false, "provisional until the handle's own exit validates the chain");
      pty.emitExit(0);
      assert.equal(settlement.settled, true, "the validated chain plus the observed Worker exit is real settlement");
      assert.deepEqual(fixture.disposeCalls, [], "nothing was drained: the owned reader had already ended");
      await harness.manager.dispose();
      assert.equal(settlement.settled, true, "disposal confirms the settled reader without waiting");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
    await fixture.worker.terminate().catch(() => undefined);
    rmSync(harness.root, { recursive: true, force: true });
  }
});
