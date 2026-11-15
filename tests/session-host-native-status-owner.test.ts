import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunch,
  type NativeCliLaunchDescriptor,
  type NativeCliLaunchRequest,
  type NativeHookSourceRegistrar,
  type NativeInstanceView,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
  type StatusRegistrar,
} from "../src/session-host/instances";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import type {
  NativeHookRegistration,
  NativeHookSourceHandlers,
} from "../src/session-host/broker";
import { captureOwnedConptyReader } from "../src/session-host/windows-conpty-reader";
import type {
  NativeHookArtifactCleanup,
  NativeHookArtifactLease,
} from "../src/session-host/native-hook-launch-prep";
import type {
  NativeHookBootstrap,
  NativeHookEvent,
  NativeHookFailure,
} from "../src/session-host/native-hook-protocol";
import type {
  NativeStatusObservation,
  NativeStatusSubmitResult,
  NativeStatusSupportMap,
} from "../src/session-host/native-status";

/**
 * Focused component coverage for the OPTIONAL owner-side native status source in
 * `InstanceManager` (issue 277 native status owner slice).
 *
 * EVIDENCE SCOPE: every child here is a synthetic PTY, every launch descriptor
 * comes from an injected test provider, the hook source is a synthetic
 * registrar shaped exactly like the broker's `registerNativeHookSource`, and the
 * observer is a synthetic reader. Nothing in this file runs a real Claude or
 * Codex binary, opens a real socket, reads any provider's real configuration,
 * credentials, or conversations, or proves a real provider TUI's rendering.
 *
 * What it does prove is the manager contract: with the optional pair absent every
 * Pi and native launch is exactly what it was; with the pair present the source is
 * registered and the observer created BEFORE the provider runs and therefore
 * before any child exists; only that registration's fresh bootstrap reaches the
 * provider; observations land only on the exact live record/PTY/incarnation
 * through the existing status-capture seam; a source can never touch Pi ownership
 * fields or a stop decision; every retirement stops callbacks immediately; and
 * staged artifacts are released only once this run's own settlement is observed.
 */

/** One synthetic owned child that records exactly what its owner did to it. */
class SpyPty implements InstancePty {
  static #nextPid = 910_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly killSignals: string[] = [];
  /** Provider children in these fixtures settle on SIGTERM unless a case says otherwise. */
  exitsOnSignal: "SIGTERM" | "SIGKILL" | "none" = "SIGTERM";
  /**
   * A real addon may report an exit while its listener is still being registered.
   * Set before the owner attaches its own listener to reproduce that exactly.
   */
  exitOnRegister = false;
  /** A child that exists but cannot be fully wired: its owner's onData() throws. */
  throwOnData = false;
  exited = false;
  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = SpyPty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.spawnDescriptor = descriptor;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    if (this.throwOnData) throw new Error("synthetic wiring failure");
    this.#dataListeners.push(listener);
    return { dispose: () => { const i = this.#dataListeners.indexOf(listener); if (i >= 0) this.#dataListeners.splice(i, 1); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    if (this.exitOnRegister) this.emitExit(17);
    return { dispose: () => { const i = this.#exitListeners.indexOf(listener); if (i >= 0) this.#exitListeners.splice(i, 1); } };
  }

  on(_eventName: "error", _listener: (error: Error) => void): void { /* recorded by absence */ }
  removeListener(_eventName: "error", _listener: (error: Error) => void): void { /* no-op */ }
  write(_data: string | Buffer): void { /* native rows are not written to here */ }
  resize(_cols: number, _rows: number): void { /* not exercised */ }
  pause(): void { /* not exercised */ }
  resume(): void { /* not exercised */ }

  kill(signal?: string): void {
    const name = signal ?? "SIGHUP";
    this.killSignals.push(name);
    if (!this.exited && this.exitsOnSignal === name) this.emitExit(name === "SIGKILL" ? 9 : 15);
  }

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }
}

/** A Pi registrar that only records, so a native row's silence is provable. */
class RecordingPiRegistrar implements StatusRegistrar {
  readonly requests: string[] = [];

  register(instanceId: string, _handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    this.requests.push(instanceId);
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/pi/${instanceId}.sock`,
        token: randomBytes(32).toString("hex"),
        instanceId,
        generation: randomUUID(),
      },
      release: () => { /* not exercised */ },
    };
  }
}

/**
 * A synthetic native hook source with the broker's exact
 * `registerNativeHookSource` shape. `emitEvent`/`emitFailure` stand in for a
 * relay's already-authenticated delivery; the manager cannot tell the difference.
 */
class SpyNativeRegistrar implements NativeHookSourceRegistrar {
  readonly requests: { instanceId: string; backend: NativeCliBackend }[] = [];
  readonly releases: string[] = [];
  readonly handlers = new Map<string, NativeHookSourceHandlers>();
  /** The most recent registration, for a case that delivers during launch preparation. */
  lastInstanceId: string | undefined;
  /** Lets a case hand back a bootstrap that is not this row's own. */
  forge: ((requested: { instanceId: string; backend: NativeCliBackend }) => NativeHookBootstrap) | undefined;
  throwOnRegister = false;

  registerNativeHookSource(
    instanceId: string,
    backend: NativeCliBackend,
    handlers: NativeHookSourceHandlers,
  ): NativeHookRegistration {
    this.requests.push({ instanceId, backend });
    this.lastInstanceId = instanceId;
    if (this.throwOnRegister) {
      throw new Error("synthetic broker refused the native source");
    }
    this.handlers.set(instanceId, handlers);
    return {
      bootstrap: this.forge?.({ instanceId, backend }) ?? {
        version: 1,
        socketPath: `/synthetic/native/${instanceId}.sock`,
        generation: randomUUID(),
        instanceId,
        backend,
        token: randomBytes(32).toString("hex"),
      },
      release: () => {
        this.releases.push(instanceId);
        this.handlers.delete(instanceId);
      },
    };
  }

  emitEvent(instanceId: string, event: NativeHookEvent): void {
    this.handlers.get(instanceId)?.onEvent(event);
  }

  emitFailure(instanceId: string, failure: NativeHookFailure): void {
    this.handlers.get(instanceId)?.onFailure(failure);
  }
}

/** The synthetic host reader. Its only write path is the context's `emit`. */
class SpyObserver implements NativeStatusObserver {
  readonly hooks: NativeHookEvent[] = [];
  readonly failures: NativeHookFailure[] = [];
  /** One entry per launch-baseline call the owner made, in the order it made them. */
  readonly startupCalls: number[] = [];
  disposeCount = 0;
  readonly support: NativeStatusSupportMap;
  /**
   * What this source states for a run the host launched itself. `null` keeps the
   * observer exactly as it was: the manager's optional call changes nothing.
   */
  startupBaseline: NativeStatusObservation | null = null;

  constructor(
    readonly context: NativeStatusObserverContext,
    support: NativeStatusSupportMap = {},
  ) {
    this.support = support;
  }

  acceptHook(event: NativeHookEvent): void { this.hooks.push(event); }
  acceptFailure(failure: NativeHookFailure): void { this.failures.push(failure); }
  dispose(): void { this.disposeCount += 1; }
  emit(observation: NativeStatusObservation): NativeStatusSubmitResult { return this.context.emit(observation); }

  observeOwnedStartup(): void {
    this.startupCalls.push(this.hooks.length);
    if (this.startupBaseline !== null) void this.emit(this.startupBaseline);
  }
}

/** A staged-artifact handle that only counts how often it was asked to clean up. */
class SpyLease implements NativeHookArtifactLease {
  readonly root = "/synthetic/native-artifacts";
  cleanupCount = 0;

  cleanup(): Promise<NativeHookArtifactCleanup> {
    this.cleanupCount += 1;
    return Promise.resolve({ removed: [this.root], preserved: [] });
  }
}

interface OwnerHarness {
  root: string;
  workspace: string;
  workspace2: string;
  manager: InstanceManager;
  piRegistrar: RecordingPiRegistrar;
  nativeRegistrar: SpyNativeRegistrar;
  observers: SpyObserver[];
  spawned: SpyPty[];
  providerCalls: { backend: NativeCliBackend; request: NativeCliLaunchRequest }[];
  /** Shared ordering of the steps a launch may take, for before/after proofs. */
  order: string[];
  setProvider(provider: NativeCliLaunch | undefined): void;
  setPtyFactory(factory: (descriptor: InstanceSpawnDescriptor) => InstancePty): void;
  setObserverFactory(factory: (context: NativeStatusObserverContext) => NativeStatusObserver | Promise<NativeStatusObserver>): void;
}

interface OwnerHarnessOptions {
  /** Supply `null` to build a manager WITHOUT the optional pair at all. */
  pair?: "present" | "absent";
  support?: NativeStatusSupportMap;
  prepared?: boolean;
}

const ownedFixtureRoots: { path: string; dev: bigint; ino: bigint }[] = [];

after(() => {
  for (const owned of ownedFixtureRoots) {
    let current;
    try {
      current = lstatSync(owned.path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (current.isDirectory() && current.dev === owned.dev && current.ino === owned.ino) {
      rmSync(owned.path, { recursive: true });
    }
  }
});

/** A real InstanceManager over synthetic fixtures. */
function makeOwnerHarness(label: string, options: OwnerHarnessOptions = {}): OwnerHarness {
  const pair = options.pair ?? "present";
  const root = realpathSync(mkdtempSync(join(tmpdir(), `prg-native-status-owner-${label}-`)));
  const identity = lstatSync(root, { bigint: true });
  ownedFixtureRoots.push({ path: root, dev: identity.dev, ino: identity.ino });
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate-extension fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic inert preload fixture; not the production preload.\n", "utf8");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n// Synthetic inert Node CLI fixture for descriptor-only manager tests.\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const agentDir = join(root, "native-agent");
  mkdirSync(agentDir, { recursive: true });
  const workspace = join(root, "workspace");
  const workspace2 = join(root, "workspace-beta");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(workspace2, { recursive: true });

  const order: string[] = [];
  const piRegistrar = new RecordingPiRegistrar();
  const nativeRegistrar = new SpyNativeRegistrar();
  const spawned: SpyPty[] = [];
  const observers: SpyObserver[] = [];
  const providerCalls: { backend: NativeCliBackend; request: NativeCliLaunchRequest }[] = [];

  let provider: NativeCliLaunch | undefined = (backend, request): NativeCliLaunchDescriptor => {
    providerCalls.push({ backend, request: { ...request, env: { ...request.env } } });
    order.push("provider");
    const descriptor: NativeCliLaunchDescriptor = {
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin", HOME: home },
      cwd: request.workspace,
    };
    if (options.prepared === true) {
      return { ...descriptor, nativeHook: { observation: "prepared", backend, route: "claude-settings-file", args: [], environment: {}, lease: new SpyLease() } };
    }
    return descriptor;
  };
  let ptyFactory: (descriptor: InstanceSpawnDescriptor) => InstancePty = (descriptor) => {
    order.push("spawn");
    const pty = new SpyPty(descriptor);
    spawned.push(pty);
    return pty;
  };
  let observerFactory: (context: NativeStatusObserverContext) => NativeStatusObserver | Promise<NativeStatusObserver> = (context) => {
    order.push("observer");
    const observer = new SpyObserver(context, options.support ?? {});
    observers.push(observer);
    return observer;
  };

  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: piRegistrar,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    nativeCliLaunch: (backend, request) => provider?.(backend, request) as NativeCliLaunchDescriptor,
    ...(pair === "absent"
      ? {}
      : {
        nativeHookRegistrar: {
          registerNativeHookSource: (instanceId, backend, handlers) => {
            order.push("register");
            return nativeRegistrar.registerNativeHookSource(instanceId, backend, handlers);
          },
        } satisfies NativeHookSourceRegistrar,
        nativeStatusObserverFactory: (context) => observerFactory(context),
      }),
    ptyFactory: (descriptor) => ptyFactory(descriptor),
  });

  return {
    root,
    workspace,
    workspace2,
    manager,
    piRegistrar,
    nativeRegistrar,
    observers,
    spawned,
    providerCalls,
    order,
    setProvider: (next) => { provider = next; },
    setPtyFactory: (next) => { ptyFactory = next; },
    setObserverFactory: (next) => { observerFactory = next; },
  };
}

const settle = async (): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for a fact that arrives on a later turn, without asserting on a race. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  for (;;) {
    if (condition()) return;
    assert.ok(Date.now() < deadline, `timed out waiting for: ${what}`);
    await sleep(5);
  }
}

function viewOf(manager: InstanceManager, id: string): NativeInstanceView {
  const view = manager.list().find((row) => row.id === id);
  assert.ok(view, "the row must exist");
  return view;
}

function lastPty(harness: OwnerHarness): SpyPty {
  const pty = harness.spawned.at(-1);
  assert.ok(pty, "a launched row owns its PTY");
  return pty;
}

function lastObserver(harness: OwnerHarness): SpyObserver {
  const observer = harness.observers.at(-1);
  assert.ok(observer, "an armed row owns its observer");
  return observer;
}

async function createNative(harness: OwnerHarness, backend: NativeCliBackend = "claude"): Promise<string> {
  return harness.manager.create({ workspace: harness.workspace, backend } as CreateInstanceOptions);
}

/* -------------------------------------------------------------------------- *
 * Absence of the optional pair is the unchanged existing behavior             *
 * -------------------------------------------------------------------------- */

test("without the optional pair: no native source, no hook option, and every provider field stays unknown", async () => {
  const harness = makeOwnerHarness("absent", { pair: "absent" });
  try {
    const id = await createNative(harness);

    assert.deepEqual(harness.nativeRegistrar.requests, [], "no native source is ever registered");
    assert.equal(harness.observers.length, 0, "no observer is ever created");
    assert.equal(harness.providerCalls.length, 1);
    assert.ok(!("nativeHook" in harness.providerCalls[0]!.request), "the provider request carries no hook option");

    const view = viewOf(harness.manager, id);
    assert.equal(view.busy, null);
    assert.equal(view.activeTasks, null);
    assert.equal(view.activeShells, null);
    assert.deepEqual(view.activity, []);
    assert.ok(!("statusSupport" in view), "an unobserved row declares nothing");

    // The existing manual capture seam is untouched and still works.
    const capture = harness.manager.nativeStatusCapture(id);
    assert.ok(capture, "the host's own recovery capture still mints");
    assert.equal(capture.submit({ busy: true }).accepted, true);
    assert.equal(viewOf(harness.manager, id).busy, true);
    capture.invalidate();
    assert.equal(viewOf(harness.manager, id).busy, null);
  } finally {
    await harness.manager.dispose();
  }
});

test("a manager rejects a half-configured optional pair instead of silently arming nothing", () => {
  const registrar = new SpyNativeRegistrar();
  const observerFactory = (context: NativeStatusObserverContext): NativeStatusObserver => new SpyObserver(context);
  assert.throws(() => new InstanceManager({
    packageRoot: "/nonexistent",
    piExecutable: "/nonexistent",
    statusRegistrar: new RecordingPiRegistrar(),
    env: {},
    args: [],
    nativeCliLaunch: () => { throw new Error("unused"); },
    nativeHookRegistrar: registrar,
  } as never), /supplied together or not at all/);
  assert.throws(() => new InstanceManager({
    packageRoot: "/nonexistent",
    piExecutable: "/nonexistent",
    statusRegistrar: new RecordingPiRegistrar(),
    env: {},
    args: [],
    nativeCliLaunch: () => { throw new Error("unused"); },
    nativeStatusObserverFactory: observerFactory,
  } as never), /supplied together or not at all/);
});

/* -------------------------------------------------------------------------- *
 * Before-spawn registration, and the exact bootstrap the provider receives    *
 * -------------------------------------------------------------------------- */

test("the source and observer are armed for a hosted row BEFORE the provider and the raw spawn", async () => {
  const harness = makeOwnerHarness("order");
  try {
    const id = await createNative(harness, "codex");

    assert.deepEqual(harness.order, ["register", "observer", "provider", "spawn"],
      "registration and observer precede the provider, which precedes the spawn");
    assert.deepEqual(harness.nativeRegistrar.requests, [{ instanceId: id, backend: "codex" }]);
    assert.equal(harness.observers.length, 1);
    assert.equal(harness.observers[0]!.context.rowId, id);
    assert.equal(harness.observers[0]!.context.backend, "codex");

    // A Pi row on the same manager never touches the native source.
    const piId = await harness.manager.create({ workspace: harness.workspace } as CreateInstanceOptions);
    assert.ok(harness.piRegistrar.requests.includes(piId), "the Pi row keeps its own registration");
    assert.equal(harness.nativeRegistrar.requests.length, 1, "a Pi row never registers a native source");
    assert.equal(harness.observers.length, 1, "a Pi row never creates a native observer");
  } finally {
    await harness.manager.dispose();
  }
});

test("the provider receives ONLY that registration's bootstrap for its own backend", async () => {
  const harness = makeOwnerHarness("bootstrap");
  try {
    const id = await createNative(harness, "claude");
    const request = harness.providerCalls.at(-1)!.request;

    assert.deepEqual(Object.keys(request).sort(), ["env", "nativeHook", "workspace"],
      "the request grows by exactly one field, and nothing else");
    assert.deepEqual(Object.keys(request.nativeHook!), ["bootstrap"]);
    assert.equal(request.nativeHook!.bootstrap.backend, "claude");
    assert.equal(request.nativeHook!.bootstrap.instanceId, id);
    assert.equal(request.nativeHook!.bootstrap.version, 1);

    // The spawn itself is still exactly the provider's descriptor: a hook option
    // never becomes an argument, an environment entry, or a different cwd.
    const pty = lastPty(harness);
    assert.deepEqual(pty.spawnDescriptor.args, ["--interactive"]);
    assert.equal(pty.spawnDescriptor.file, "/synthetic/bin/claude");
    assert.equal(pty.spawnDescriptor.cwd, harness.workspace);
  } finally {
    await harness.manager.dispose();
  }
});

test("a foreign or cross-backend registration is released and the launch proceeds unobserved", async () => {
  const harness = makeOwnerHarness("foreign");
  harness.nativeRegistrar.forge = ({ backend }) => ({
    version: 1,
    socketPath: "/synthetic/native/other.sock",
    generation: randomUUID(),
    // A bootstrap for somebody else's row, on the other native backend.
    instanceId: "some-other-row",
    backend: backend === "claude" ? "codex" : "claude",
    token: randomBytes(32).toString("hex"),
  });
  try {
    const id = await createNative(harness, "claude");

    assert.equal(harness.nativeRegistrar.releases.length, 1, "the foreign registration was released");
    assert.equal(harness.providerCalls.at(-1)!.request.nativeHook, undefined, "no bootstrap reaches the provider");
    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "alive");
    assert.equal(view.busy, null);
    assert.ok(!("statusSupport" in view));
    assert.ok(lastPty(harness), "the interactive child still launched");
  } finally {
    await harness.manager.dispose();
  }
});

test("a registrar that throws leaves the row unobserved and its interactive launch unchanged", async () => {
  const harness = makeOwnerHarness("registrar-throws");
  harness.nativeRegistrar.throwOnRegister = true;
  try {
    const id = await createNative(harness, "claude");

    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "alive", "an unavailable source is never a launch failure");
    assert.equal(harness.observers.length, 0);
    assert.equal(harness.providerCalls.at(-1)!.request.nativeHook, undefined);
    assert.ok(lastPty(harness));
  } finally {
    await harness.manager.dispose();
  }
});

/* -------------------------------------------------------------------------- *
 * Observation routing and its fences                                          *
 * -------------------------------------------------------------------------- */

test("hook events dispatch synchronously to the observer and its observation lands on this row", async () => {
  const harness = makeOwnerHarness("route", { support: { agent: "supported", tasks: "supported" } });
  try {
    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);

    harness.nativeRegistrar.emitEvent(id, { backend: "claude", hook_event_name: "UserPromptSubmit", session_id: "synthetic-session" });
    assert.equal(observer.hooks.length, 1, "dispatch is direct, not queued");
    assert.equal(observer.hooks[0]!.session_id, "synthetic-session");

    const result = observer.emit({
      busy: true,
      pendingInput: false,
      activeTasks: 2,
      activeShells: 1,
      activity: ["running the synthetic suite"],
    });
    assert.equal(result.accepted, true);

    const view = viewOf(harness.manager, id);
    assert.equal(view.busy, true);
    assert.equal(view.pendingInput, false);
    assert.equal(view.activeTasks, 2);
    assert.equal(view.activeShells, 1);
    assert.deepEqual(view.activity, ["running the synthetic suite"]);
    assert.deepEqual(view.statusSupport, { agent: "supported", tasks: "supported" });
  } finally {
    await harness.manager.dispose();
  }
});

test("a static unsupported declaration is published at activation, and no declaration stays legacy unknown", async () => {
  const declaring = makeOwnerHarness("declared", { support: { input: "unsupported", tasks: "unsupported", shells: "unsupported" } });
  try {
    const id = await createNative(declaring, "codex");
    const view = viewOf(declaring.manager, id);
    // The declaration is stated, and every observed value is still unknown — an
    // unsupported category is never rendered as a fabricated zero.
    assert.deepEqual(view.statusSupport, { input: "unsupported", tasks: "unsupported", shells: "unsupported" });
    assert.equal(view.activeTasks, null);
    assert.equal(view.activeShells, null);
    assert.equal(view.busy, null);
  } finally {
    await declaring.manager.dispose();
  }

  const silent = makeOwnerHarness("silent");
  try {
    const id = await createNative(silent, "codex");
    const view = viewOf(silent.manager, id);
    assert.ok(!("statusSupport" in view), "an observer that declares nothing publishes nothing");
    assert.equal(view.activeTasks, null);
  } finally {
    await silent.manager.dispose();
  }
});

test("a malformed observation is rejected whole and changes nothing", async () => {
  const harness = makeOwnerHarness("malformed");
  try {
    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);
    assert.equal(observer.emit({ busy: true, activeTasks: 3 }).accepted, true);

    const before = viewOf(harness.manager, id);
    const rejected = observer.emit({ busy: "yes" as unknown as boolean, activeTasks: 9 });
    assert.equal(rejected.accepted, false);

    const after = viewOf(harness.manager, id);
    assert.equal(after.busy, true, "a rejected observation leaves the previous facts intact");
    assert.equal(after.activeTasks, 3);
    assert.equal(before.activeTasks, after.activeTasks);
  } finally {
    await harness.manager.dispose();
  }
});

test("a recoverable gap publishes unknown on the same capture, and a later positive replaces it", async () => {
  const harness = makeOwnerHarness("gap");
  try {
    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);

    assert.equal(observer.emit({ busy: true, activeTasks: 4 }).accepted, true);
    assert.equal(viewOf(harness.manager, id).busy, true);

    // The source's own fence detected a stale internal generation: it reports what
    // it now knows, which is nothing. That is a complete all-unknown snapshot, NOT
    // a retirement — the same capture and observer stay in service.
    assert.equal(observer.emit({}).accepted, true);
    const gap = viewOf(harness.manager, id);
    assert.equal(gap.busy, null);
    assert.equal(gap.activeTasks, null);
    assert.deepEqual(gap.activity, []);

    assert.equal(observer.emit({ busy: true, activeTasks: 1 }).accepted, true);
    assert.equal(viewOf(harness.manager, id).busy, true);
    assert.equal(observer.disposeCount, 0, "a data gap never disposes the observer");
  } finally {
    await harness.manager.dispose();
  }
});

test("a source can never touch Pi ownership fields or soften a stop decision", async () => {
  const harness = makeOwnerHarness("no-ownership");
  try {
    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);
    assert.equal(observer.emit({
      busy: true,
      activeTasks: 7,
      activeShells: 3,
      activity: ["synthetic"],
    }).accepted, true);

    const view = viewOf(harness.manager, id);
    assert.equal(view.activeTasks, 7);
    assert.equal(view.activeShells, 3);
    assert.equal(view.backgroundTasks, null, "host ownership stays unknown to a provider source");
    assert.equal(view.backgroundShells, null);

    // The stop contract is unchanged by an "active-looking" provider row.
    assert.deepEqual(await harness.manager.stop(id, { confirmed: false }), { status: "confirmation-required", forced: false });
  } finally {
    await harness.manager.dispose();
  }
});

test("a hook callback before native activation claims nothing and is never queued", async () => {
  const harness = makeOwnerHarness("pre-activation");
  let preActivation: NativeStatusSubmitResult | undefined;
  let preHookCount: number | undefined;
  harness.setProvider((backend, request) => {
    // The provider runs after registration and observer creation but before the
    // spawn. A relay that somehow delivered right now must land on nothing.
    const observer = harness.observers.at(-1);
    assert.ok(observer);
    harness.nativeRegistrar.emitEvent(observer.context.rowId, { backend, hook_event_name: "SessionStart" });
    preHookCount = observer.hooks.length;
    preActivation = observer.emit({ busy: true });
    return { file: `/synthetic/bin/${backend}`, args: [], env: { PATH: "/synthetic/bin" }, cwd: request.workspace };
  });
  try {
    const id = await createNative(harness, "claude");
    assert.equal(preHookCount, 1, "the callback still dispatches directly to the observer");
    assert.equal(preActivation?.accepted, false, "but its write claims nothing before activation");
    assert.equal(viewOf(harness.manager, id).busy, null, "and nothing was queued behind it");
  } finally {
    await harness.manager.dispose();
  }
});

test("a callback for another backend cannot route into this row", async () => {
  const harness = makeOwnerHarness("cross-backend");
  try {
    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);
    harness.nativeRegistrar.emitEvent(id, { backend: "codex", hook_event_name: "Stop" });
    assert.equal(observer.hooks.length, 0);
    assert.equal(viewOf(harness.manager, id).busy, null);
  } finally {
    await harness.manager.dispose();
  }
});

test("a throwing observer cannot disturb the row it reports on", async () => {
  const harness = makeOwnerHarness("throwing-observer");
  harness.setObserverFactory((context) => ({
    support: {},
    acceptHook: () => { throw new Error("synthetic observer exploded"); },
    acceptFailure: () => { throw new Error("synthetic observer exploded"); },
    dispose: () => { throw new Error("synthetic observer teardown exploded"); },
    emit: (observation: NativeStatusObservation) => context.emit(observation),
  }));
  try {
    const id = await createNative(harness, "claude");
    harness.nativeRegistrar.emitEvent(id, { backend: "claude", hook_event_name: "PreToolUse" });
    harness.nativeRegistrar.emitFailure(id, { backend: "claude", reason: "input-timeout" });
    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "alive");
    assert.equal(view.busy, null);
  } finally {
    await harness.manager.dispose();
  }
});

test("a late asynchronous observer for a row that already ended is disposed and never bound", async () => {
  const harness = makeOwnerHarness("late-observer");
  let resolveObserver: ((observer: NativeStatusObserver) => void) | undefined;
  harness.setObserverFactory((context) => new Promise<NativeStatusObserver>((resolve) => { resolveObserver = resolve; }));
  try {
    const id = await createNative(harness, "claude");
    assert.equal(harness.observers.length, 0, "the factory has not answered yet");

    lastPty(harness).emitExit(0);
    await settle();

    const late = new SpyObserver(harness.observers.at(-1)?.context ?? {
      rowId: id,
      backend: "claude",
      emit: () => ({ accepted: false, code: "no-live-run" }) as NativeStatusSubmitResult,
    });
    resolveObserver!(late);
    await settle();

    assert.equal(late.disposeCount, 1, "the late observer is disposed, not adopted");
    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "exited");
    assert.equal(view.busy, null);
  } finally {
    await harness.manager.dispose();
  }
});

/* -------------------------------------------------------------------------- *
 * Retirement                                                                  *
 * -------------------------------------------------------------------------- */

test("the child's own exit retires callbacks, and a later observation cannot restore them", async () => {
  const harness = makeOwnerHarness("exit");
  try {
    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);
    assert.equal(observer.emit({ busy: true, activeTasks: 2 }).accepted, true);

    lastPty(harness).emitExit(0);

    assert.deepEqual(harness.nativeRegistrar.releases, [id]);
    assert.equal(observer.disposeCount, 1);
    assert.equal(observer.emit({ busy: true }).accepted, false);
    harness.nativeRegistrar.emitEvent(id, { backend: "claude", hook_event_name: "Stop" });
    assert.equal(observer.hooks.length, 0, "a released source delivers nothing");

    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "exited");
    assert.equal(view.busy, null);
    assert.equal(view.activeTasks, null);
  } finally {
    await harness.manager.dispose();
  }
});

test("stop retires the source and observer immediately, before the child has settled", async () => {
  const harness = makeOwnerHarness("stop");
  try {
    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);
    assert.equal(observer.emit({ busy: true }).accepted, true);

    const result = await harness.manager.stop(id, { confirmed: true });
    assert.equal(result.status, "exited");

    assert.deepEqual(harness.nativeRegistrar.releases, [id]);
    assert.equal(observer.disposeCount, 1);
    assert.equal(observer.emit({ busy: true }).accepted, false);
  } finally {
    await harness.manager.dispose();
  }
});

test("removing a row retires its source, and a re-created workspace arms a fresh one", async () => {
  const harness = makeOwnerHarness("remove");
  try {
    const first = await createNative(harness, "claude");
    const firstObserver = lastObserver(harness);
    lastPty(harness).emitExit(0);
    harness.manager.closeExited(first);

    assert.deepEqual(harness.nativeRegistrar.releases, [first]);
    assert.equal(firstObserver.disposeCount, 1);

    const second = await createNative(harness, "claude");
    assert.notEqual(second, first);
    assert.equal(harness.nativeRegistrar.requests.length, 2);
    assert.equal(harness.observers.length, 2);
    const secondObserver = lastObserver(harness);
    assert.notEqual(secondObserver, firstObserver);
    assert.equal(secondObserver.emit({ busy: true }).accepted, true);
    assert.equal(viewOf(harness.manager, second).busy, true);
    assert.equal(firstObserver.emit({ busy: true }).accepted, false);
  } finally {
    await harness.manager.dispose();
  }
});

test("manager disposal retires every armed run, live child included", async () => {
  const harness = makeOwnerHarness("dispose");
  const id = await createNative(harness, "codex");
  const observer = lastObserver(harness);
  assert.equal(observer.emit({ busy: true }).accepted, true);

  await harness.manager.dispose();

  assert.deepEqual(harness.nativeRegistrar.releases, [id]);
  assert.equal(observer.disposeCount, 1);
  assert.equal(observer.emit({ busy: true }).accepted, false);
});

/* -------------------------------------------------------------------------- *
 * Preparation outcome and artifact-lease ownership                            *
 * -------------------------------------------------------------------------- */

test("an unavailable preparation releases the source and observer without changing the native launch", async () => {
  const harness = makeOwnerHarness("unavailable");
  harness.setProvider((backend, request) => ({
    file: `/synthetic/bin/${backend}`,
    args: ["--interactive", "--no-native-hooks"],
    env: { PATH: "/synthetic/bin", HOME: harness.root },
    cwd: request.workspace,
    nativeHook: { observation: "unavailable", backend, reason: "operator-hook-override" },
  }));
  try {
    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);

    assert.deepEqual(harness.nativeRegistrar.releases, [id], "the source is unarmed and released");
    assert.equal(observer.disposeCount, 1, "the observer is released");

    const pty = lastPty(harness);
    assert.deepEqual(pty.spawnDescriptor.args, ["--interactive", "--no-native-hooks"],
      "the provider's own argv is applied verbatim");
    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "alive");
    assert.equal(view.busy, null);
    assert.ok(!("statusSupport" in view), "supported metadata stays truthfully unknown");
  } finally {
    await harness.manager.dispose();
  }
});

test("a prepared launch keeps its artifacts while the child lives and releases them after its exit", async () => {
  const harness = makeOwnerHarness("prepared", { prepared: true });
  const leases: SpyLease[] = [];
  harness.setProvider((backend, request) => {
    const lease = new SpyLease();
    leases.push(lease);
    return {
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
      nativeHook: { observation: "prepared", backend, route: "claude-settings-file", args: [], environment: {}, lease },
    };
  });
  try {
    const id = await createNative(harness, "claude");
    assert.equal(leases[0]!.cleanupCount, 0, "a live child may still need the files it was told to read");

    const observer = lastObserver(harness);
    assert.equal(observer.emit({ busy: true }).accepted, true, "the run is fully observed");

    lastPty(harness).emitExit(0);
    await settle();
    assert.equal(leases[0]!.cleanupCount, 1, "the genuine exit is what permits cleanup");

    lastPty(harness).emitExit(0);
    await settle();
    assert.equal(leases[0]!.cleanupCount, 1, "release happens exactly once");
    assert.equal(viewOf(harness.manager, id).lifecycle, "exited");
  } finally {
    await harness.manager.dispose();
  }
});

test("a failed spawn before any child exists releases the lease that launch staged", async () => {
  const harness = makeOwnerHarness("spawn-fail", { prepared: true });
  const leases: SpyLease[] = [];
  harness.setProvider((backend, request) => {
    const lease = new SpyLease();
    leases.push(lease);
    return {
      file: `/synthetic/bin/${backend}`,
      args: [],
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
      nativeHook: { observation: "prepared", backend, route: "claude-settings-file", args: [], environment: {}, lease },
    };
  });
  harness.setPtyFactory(() => { throw new Error("synthetic spawn failure"); });
  try {
    const id = await createNative(harness, "claude");
    await settle();

    assert.equal(leases[0]!.cleanupCount, 1, "no child ever existed to read them");
    assert.deepEqual(harness.nativeRegistrar.releases, [id]);
    assert.equal(lastObserver(harness).disposeCount, 1);
    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "error");
    assert.equal(view.busy, null);
  } finally {
    await harness.manager.dispose();
  }
});

test("a child that never settles keeps its staged files instead of being treated as finished", async () => {
  const harness = makeOwnerHarness("unsettled");
  const leases: SpyLease[] = [];
  harness.setProvider((backend, request) => {
    const lease = new SpyLease();
    leases.push(lease);
    return {
      file: `/synthetic/bin/${backend}`,
      args: [],
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
      nativeHook: { observation: "prepared", backend, route: "claude-settings-file", args: [], environment: {}, lease },
    };
  });
  try {
    const id = await createNative(harness, "claude");
    const pty = lastPty(harness);
    pty.exitsOnSignal = "none";

    const result = await harness.manager.stop(id, { confirmed: true });
    await settle();

    assert.equal(result.status, "unconfirmed", "the child is still live");
    assert.equal(pty.exited, false);
    assert.equal(leases[0]!.cleanupCount, 0, "an uncertain live child is never cleaned as if settled");
    // Its callbacks are gone even though its files stay.
    assert.deepEqual(harness.nativeRegistrar.releases, [id]);
    assert.equal(lastObserver(harness).disposeCount, 1);
  } finally {
    await harness.manager.dispose();
  }
});

/* -------------------------------------------------------------------------- *
 * Resource ownership outlives callback retirement (review pass 1)             *
 * -------------------------------------------------------------------------- */

/**
 * A provider that stages one synthetic artifact bundle per launch and reports it as
 * `prepared`. The returned array records every lease in launch order.
 */
function withPreparedProvider(harness: OwnerHarness, options: { cwd?: string } = {}): SpyLease[] {
  const leases: SpyLease[] = [];
  harness.setProvider((backend, request) => {
    const lease = new SpyLease();
    leases.push(lease);
    return {
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: options.cwd ?? request.workspace,
      nativeHook: { observation: "prepared", backend, route: "claude-settings-file", args: [], environment: {}, lease },
    };
  });
  return leases;
}

test("a confirmed Stop retires callbacks at once but releases the staged files only at that child's exit", async () => {
  const harness = makeOwnerHarness("stop-lease");
  const leases = withPreparedProvider(harness);
  try {
    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);
    assert.equal(observer.emit({ busy: true }).accepted, true);
    assert.equal(leases[0]!.cleanupCount, 0);

    const result = await harness.manager.stop(id, { confirmed: true });
    assert.equal(result.status, "exited");
    await settle();

    // Callbacks went first; the files went only with the actual exit they waited for.
    assert.deepEqual(harness.nativeRegistrar.releases, [id]);
    assert.equal(observer.disposeCount, 1);
    assert.equal(leases[0]!.cleanupCount, 1, "the stop's retirement must not strand the lease");
  } finally {
    await harness.manager.dispose();
  }
});

test("an unconfirmed Stop preserves the files, and a later genuine exit releases them", async () => {
  const harness = makeOwnerHarness("late-exit-lease");
  const leases = withPreparedProvider(harness);
  try {
    const id = await createNative(harness, "claude");
    const pty = lastPty(harness);
    pty.exitsOnSignal = "none";

    const result = await harness.manager.stop(id, { confirmed: true });
    await settle();
    assert.equal(result.status, "unconfirmed");
    assert.equal(leases[0]!.cleanupCount, 0, "still live, still preserved");

    // The child settles long after every callback was retired.
    pty.emitExit(0);
    await settle();
    assert.equal(leases[0]!.cleanupCount, 1, "the late exit is still the only release witness");
  } finally {
    await harness.manager.dispose();
  }
});

test("manager disposal releases a prepared lease through that child's exit, not through retirement", async () => {
  const harness = makeOwnerHarness("dispose-lease");
  const leases = withPreparedProvider(harness);
  const id = await createNative(harness, "codex");
  const pty = lastPty(harness);

  await harness.manager.dispose();
  await settle();

  assert.deepEqual(harness.nativeRegistrar.releases, [id]);
  assert.equal(lastObserver(harness).disposeCount, 1);
  assert.equal(pty.exited, true);
  assert.equal(leases[0]!.cleanupCount, 1, "disposal must not strand what the launch staged");
});

test("a wiring failure after the child exists keeps its staged files until that child settles", async () => {
  const harness = makeOwnerHarness("wiring-fail-lease");
  const leases = withPreparedProvider(harness);
  harness.setPtyFactory((descriptor) => {
    const pty = new SpyPty(descriptor);
    pty.throwOnData = true;      // the child exists but cannot be fully wired
    pty.exitsOnSignal = "none";  // and it stays live until this case settles it by hand
    harness.spawned.push(pty);
    return pty;
  });
  try {
    const id = await createNative(harness, "claude");
    await settle();
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");
    const pty = lastPty(harness);
    assert.equal(pty.exited, false, "the owned stop is under way");
    assert.equal(leases[0]!.cleanupCount, 0, "a live child of this launch still needs them");

    pty.emitExit(0);
    await settle();
    assert.equal(leases[0]!.cleanupCount, 1);
  } finally {
    await harness.manager.dispose();
  }
});

test("a provider that answers after shutdown abandoned the launch still has its staged files released", async () => {
  const harness = makeOwnerHarness("abandoned-fulfillment");
  const lease = new SpyLease();
  let resolveProvider: ((descriptor: NativeCliLaunchDescriptor) => void) | undefined;
  harness.setProvider((backend, request) => new Promise<NativeCliLaunchDescriptor>((resolve) => {
    resolveProvider = resolve;
    void backend;
    void request;
  }));
  try {
    const created = harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    await until(() => resolveProvider !== undefined, "the provider to be invoked");
    await harness.manager.shutdown();
    await created;

    assert.equal(lease.cleanupCount, 0, "nothing was staged while the provider was still working");

    // The launch is long gone; this late fulfillment must still be accounted for.
    resolveProvider!({
      file: "/synthetic/bin/claude",
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: harness.workspace,
      nativeHook: { observation: "prepared", backend: "claude", route: "claude-settings-file", args: [], environment: {}, lease },
    });
    await settle();
    await settle();

    assert.equal(lease.cleanupCount, 1, "an abandoned launch releases what its preparation staged");
    assert.equal(harness.spawned.length, 0, "and it still never spawns after shutdown");
  } finally {
    await harness.manager.dispose();
  }
});

test("a prepared descriptor this manager refuses still has its staged files released", async () => {
  const harness = makeOwnerHarness("invalid-descriptor");
  const leases = withPreparedProvider(harness, { cwd: "/synthetic/not-this-workspace" });
  try {
    const id = await createNative(harness, "claude");
    await settle();

    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "error");
    assert.equal(view.error, "session-host: instance launch preparation failed");
    assert.equal(harness.spawned.length, 0, "a refused descriptor is never spawned");
    assert.equal(leases[0]!.cleanupCount, 1, "rejection is not a licence to strand staged files");
  } finally {
    await harness.manager.dispose();
  }
});

test("an observer factory that rejects cannot delete the files the child is about to read", async () => {
  const harness = makeOwnerHarness("factory-reject-lease");
  const lease = new SpyLease();
  harness.setObserverFactory(() => Promise.reject(new Error("synthetic observer factory failed")));
  let resolveProvider: ((descriptor: NativeCliLaunchDescriptor) => void) | undefined;
  harness.setProvider(() => new Promise<NativeCliLaunchDescriptor>((resolve) => { resolveProvider = resolve; }));
  try {
    const created = harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    await until(() => resolveProvider !== undefined, "the provider to be invoked");
    await settle();
    await settle();   // the factory rejection lands while the provider is still preparing

    resolveProvider!({
      file: "/synthetic/bin/claude",
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: harness.workspace,
      nativeHook: { observation: "prepared", backend: "claude", route: "claude-settings-file", args: [], environment: {}, lease },
    });
    const id = await created;

    // The observation source is gone, but this launch's child still spawns and is
    // the very thing told to read those files.
    assert.equal(lease.cleanupCount, 0, "a retired OBSERVER never implies an abandoned LAUNCH");
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive");
    assert.equal(harness.observers.length, 0, "no observer was ever adopted");

    lastPty(harness).emitExit(0);
    await settle();
    assert.equal(lease.cleanupCount, 1, "its own exit is what releases them");
  } finally {
    await harness.manager.dispose();
  }
});

test("a synchronous exit during listener registration still respects an unsettled owned reader", async () => {
  const harness = makeOwnerHarness("sync-exit-reader");
  const leases = withPreparedProvider(harness);
  harness.setPtyFactory((descriptor) => {
    const pty = new SpyPty(descriptor);
    // A real Windows ConPTY child whose reader this manager owns and which never
    // positively settles. It is registered FIRST, so the manager's own exit
    // listener — the one that reports the exit synchronously — attaches after it.
    captureOwnedConptyReader(pty, { confirmationWindowMs: 25 });
    pty.exitOnRegister = true;
    harness.spawned.push(pty);
    return pty;
  });
  try {
    const id = await createNative(harness, "claude");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, false);
    await settle();
    await sleep(80);   // well past the existing confirmation window

    assert.equal(leases[0]!.cleanupCount, 0,
      "an unsettled required reader preserves the files even on a synchronous exit");
  } finally {
    // Disposal correctly REJECTS here: this fixture's owned reader can never
    // positively settle, and an unconfirmed required release is reported as a
    // cleanup failure rather than skipped. That is the existing contract, and it is
    // exactly why the staged files above were preserved instead of presumed clean.
    await assert.rejects(() => harness.manager.dispose(), /ConPTY reader settlement was not confirmed/);
  }
});

/* -------------------------------------------------------------------------- *
 * A throwing observer cannot leave stale facts on the row                     *
 * -------------------------------------------------------------------------- */

interface ThrowingObserver extends NativeStatusObserver {
  boom: boolean;
  disposeCount: number;
  emit(observation: NativeStatusObservation): NativeStatusSubmitResult;
}

/** An observer that starts working and then throws from both dispatch methods. */
function installThrowingObserverFactory(
  harness: OwnerHarness,
  options: { throwFromStart?: boolean } = {},
): () => ThrowingObserver | undefined {
  let made: ThrowingObserver | undefined;
  harness.setObserverFactory((context) => {
    const observer: ThrowingObserver = {
      support: { tasks: "supported", activity: "supported" },
      boom: options.throwFromStart === true,
      disposeCount: 0,
      acceptHook: () => { if (observer.boom) throw new Error("synthetic observer exploded in acceptHook"); },
      acceptFailure: () => { if (observer.boom) throw new Error("synthetic observer exploded in acceptFailure"); },
      dispose: () => { observer.disposeCount += 1; },
      emit: (observation: NativeStatusObservation) => context.emit(observation),
    };
    made = observer;
    return observer;
  });
  return () => made;
}

function assertCollapsedToUnknown(manager: InstanceManager, id: string): void {
  const view = viewOf(manager, id);
  assert.equal(view.busy, null);
  assert.equal(view.pendingInput, null);
  assert.equal(view.activeTasks, null);
  assert.equal(view.activeShells, null);
  assert.deepEqual(view.activity, []);
}

test("an observer that throws in acceptHook collapses the row to unknown instead of keeping stale facts", async () => {
  const harness = makeOwnerHarness("throwing-accept-hook");
  const leases = withPreparedProvider(harness);
  const makeObserver = installThrowingObserverFactory(harness);
  try {
    const id = await createNative(harness, "claude");
    const observer = makeObserver();
    assert.ok(observer);
    assert.equal(observer.emit({ busy: true, activeTasks: 4, activity: ["working"] }).accepted, true);
    const positive = viewOf(harness.manager, id);
    assert.equal(positive.busy, true);
    assert.equal(positive.activeTasks, 4);

    observer.boom = true;
    harness.nativeRegistrar.emitEvent(id, { backend: "claude", hook_event_name: "Stop" });

    assertCollapsedToUnknown(harness.manager, id);
    assert.deepEqual(viewOf(harness.manager, id).statusSupport, { tasks: "supported", activity: "supported" },
      "the static declaration is not the observer's failure to clean up");
    assert.equal(observer.disposeCount, 1, "the throwing observer is retired");
    assert.equal(leases[0]!.cleanupCount, 0, "artifact ownership survives its observer");

    // Nothing it, or a later delivery, can put back.
    observer.boom = false;
    assert.equal(observer.emit({ busy: true }).accepted, false);
    harness.nativeRegistrar.emitEvent(id, { backend: "claude", hook_event_name: "UserPromptSubmit" });
    assertCollapsedToUnknown(harness.manager, id);

    lastPty(harness).emitExit(0);
    await settle();
    assert.equal(leases[0]!.cleanupCount, 1);
  } finally {
    await harness.manager.dispose();
  }
});

test("an observer that throws in acceptFailure collapses the row to unknown too", async () => {
  const harness = makeOwnerHarness("throwing-accept-failure");
  const makeObserver = installThrowingObserverFactory(harness);
  try {
    const id = await createNative(harness, "claude");
    const observer = makeObserver();
    assert.ok(observer);
    assert.equal(observer.emit({ busy: false, activeShells: 2 }).accepted, true);
    assert.equal(viewOf(harness.manager, id).activeShells, 2);

    observer.boom = true;
    harness.nativeRegistrar.emitFailure(id, { backend: "claude", reason: "input-timeout" });

    assertCollapsedToUnknown(harness.manager, id);
    assert.equal(observer.disposeCount, 1);
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive", "the row itself is untouched");
  } finally {
    await harness.manager.dispose();
  }
});

/* -------------------------------------------------------------------------- *
 * A pre-activation throw still ends the observation lifetime                   *
 * -------------------------------------------------------------------------- */

/**
 * A relay delivery that arrives WHILE the launch is still being prepared: the
 * observer is already bound, no capture exists yet, and no child exists yet. This is
 * the window in which an exception cannot be answered by invalidating a capture, so
 * the whole observation lifetime has to be retired instead.
 */
function deliverDuringPreparation(
  harness: OwnerHarness,
  what: "event" | "failure",
): void {
  harness.setProvider((backend, request) => {
    const rowId = harness.nativeRegistrar.lastInstanceId;
    assert.ok(rowId !== undefined, "the native source was registered before the provider ran");
    if (what === "event") {
      harness.nativeRegistrar.emitEvent(rowId, { backend, hook_event_name: "PreToolUse" });
    } else {
      harness.nativeRegistrar.emitFailure(rowId, { backend, reason: "input-timeout" });
    }
    return {
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
    };
  });
}

test("an observer that throws before activation cannot publish through the capture made afterwards", async () => {
  const harness = makeOwnerHarness("pre-activation-hook-throw");
  const makeObserver = installThrowingObserverFactory(harness, { throwFromStart: true });
  deliverDuringPreparation(harness, "event");
  try {
    const id = await createNative(harness, "claude");
    const observer = makeObserver();
    assert.ok(observer);

    // Activation refused to mint a capture for a retired run, so the callback this
    // observer kept from its context can never become accepted.
    assert.equal(observer.emit({ busy: true, activeTasks: 7 }).accepted, false);
    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "alive", "the row itself is untouched by its status source");
    assertCollapsedToUnknown(harness.manager, id);
    assert.ok(!("statusSupport" in view), "nothing was published, so nothing is claimed");
    assert.equal(observer.disposeCount, 1);
    assert.deepEqual(harness.nativeRegistrar.releases, [id], "its source is released too");

    // A later delivery claims nothing either, and cannot revive the lifetime.
    harness.nativeRegistrar.emitEvent(id, { backend: "claude", hook_event_name: "Stop" });
    assert.equal(observer.emit({ busy: true }).accepted, false);
    assertCollapsedToUnknown(harness.manager, id);
    assert.equal(observer.disposeCount, 1, "retirement is not repeated");

    // And the row keeps behaving normally: its child settles through the ordinary path.
    lastPty(harness).emitExit(0);
    await settle();
    assert.equal(viewOf(harness.manager, id).lifecycle, "exited");
  } finally {
    await harness.manager.dispose();
  }
});

test("an observer that throws in acceptFailure before activation cannot publish later either", async () => {
  const harness = makeOwnerHarness("pre-activation-failure-throw");
  const makeObserver = installThrowingObserverFactory(harness, { throwFromStart: true });
  deliverDuringPreparation(harness, "failure");
  try {
    const id = await createNative(harness, "claude");
    const observer = makeObserver();
    assert.ok(observer);

    assert.equal(observer.emit({ busy: true, activeShells: 3 }).accepted, false);
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive");
    assertCollapsedToUnknown(harness.manager, id);
    assert.equal(observer.disposeCount, 1);
    assert.deepEqual(harness.nativeRegistrar.releases, [id]);

    // Neither dispatch method can bring it back.
    harness.nativeRegistrar.emitFailure(id, { backend: "claude", reason: "input-timeout" });
    harness.nativeRegistrar.emitEvent(id, { backend: "claude", hook_event_name: "Stop" });
    assert.equal(observer.emit({ busy: true }).accepted, false);
    assertCollapsedToUnknown(harness.manager, id);
  } finally {
    await harness.manager.dispose();
  }
});

test("the owner states the launch baseline once the capture is live and no hook has arrived", async () => {
  const declared: NativeStatusSupportMap = {
    agent: "supported", input: "supported", tasks: "supported", shells: "supported", activity: "supported",
  };
  const harness = makeOwnerHarness("startup-baseline", { support: declared });
  try {
    harness.setObserverFactory((context) => {
      const observer = new SpyObserver(context, declared);
      observer.startupBaseline = {
        busy: false, pendingInput: false, activeTasks: 0, activeShells: 0, activity: ["Ready"],
      };
      harness.observers.push(observer);
      return observer;
    });

    const id = await createNative(harness, "claude");
    const observer = lastObserver(harness);

    // Exactly one statement, and it landed: a call before the run's capture
    // existed would have been refused by the capture, so the row carrying it is
    // the proof that activation had already bound this exact live handle.
    assert.equal(observer.startupCalls.length, 1);
    assert.equal(observer.startupCalls[0], 0, "no provider hook had been delivered when the baseline was stated");

    const view = viewOf(harness.manager, id);
    assert.equal(view.busy, false);
    assert.equal(view.pendingInput, false);
    assert.equal(view.activeTasks, 0);
    assert.equal(view.activeShells, 0);
    assert.deepEqual(view.activity, ["Ready"]);
    assert.deepEqual(view.statusSupport, declared);

    // Real provider observations then take over normally.
    harness.nativeRegistrar.emitEvent(id, { backend: "claude", hook_event_name: "UserPromptSubmit", session_id: "synthetic-session" });
    const result = observer.emit({ busy: true, pendingInput: null, activeTasks: null, activeShells: null, activity: ["Working"] });
    assert.equal(result.accepted, true);
    assert.equal(viewOf(harness.manager, id).busy, true);

    // Retirement still collapses the row to unknown; the baseline is not a hold-over.
    await harness.manager.stop(id, { confirmed: true });
    const stopped = viewOf(harness.manager, id);
    assert.equal(stopped.busy, null, "a retired run never keeps a launch baseline");
    assert.equal(stopped.activeTasks, null);
  } finally {
    await harness.manager.dispose();
  }
});

test("an observer that states no launch baseline keeps the row entirely unknown", async () => {
  const harness = makeOwnerHarness("no-startup-hook", { support: { agent: "supported" } });
  try {
    harness.setObserverFactory((context) => {
      const silent: NativeStatusObserver = {
        support: { agent: "supported" },
        acceptHook: () => undefined,
        acceptFailure: () => undefined,
        dispose: () => undefined,
      };
      return silent;
    });
    const id = await createNative(harness, "claude");
    const view = viewOf(harness.manager, id);
    assert.equal(view.busy, null, "no baseline hook means no baseline claim");
    assert.equal(view.pendingInput, null);
    assert.equal(view.activeTasks, null);
    assert.equal(view.activeShells, null);
    assert.deepEqual(view.activity, []);
  } finally {
    await harness.manager.dispose();
  }
});
