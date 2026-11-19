/**
 * Focused component coverage for the OWNING manager's owned Codex backend wiring
 * in `InstanceManager` (issue #277 owning-manager slice).
 *
 * EVIDENCE SCOPE: every child here is synthetic. The TUI is an injected fake PTY,
 * the backend is an injected fake lease over a fake captured child handle, the
 * launch provider is a test provider that attaches a test rendering plan, and the
 * hook source and observer are the same synthetic shapes the owner-slice suite
 * uses. Nothing in this file runs a real Claude or Codex binary, opens a socket,
 * reads any provider configuration or credential, or proves a real provider TUI's
 * rendering or a real backend's readiness banner.
 *
 * What it does prove is the manager contract: the lease is created and retained on
 * the exact row synchronously, before readiness is awaited; the genuine TUI is
 * spawned from the SAME plan and the SAME fulfilled lease connection rather than the
 * standalone descriptor; the row owns both processes, so no authority calls it gone
 * while either is unsettled, and its staged private files wait for the backend too;
 * every cancellation edge, readiness rejection, late answer, and throwing observer
 * stays fail closed with zero new children; the private backend-ready observer seam
 * fires once, in order, and leaks nothing into a public snapshot; and a named-profile
 * refusal, a plan with no factory, and every non-owned row reach the fixed closed
 * error lane or the unchanged legacy path before any spawn.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  type NativeOwnedCodexBackendObservationSource,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
  type OwnedCodexBackendFactory,
  type OwnedCodexBackendLaunchRequest,
  type StatusRegistrar,
} from "../src/session-host/instances";
import {
  NativeCodexOwnedProfileUnsupportedError,
  type NativeCodexOwnedLaunchPlan,
  type NativeCodexOwnedTuiConnection,
} from "../src/session-host/native-cli-launch";
import type {
  OwnedCodexBackendLaunchIdentity,
  OwnedCodexBackendLease,
  OwnedCodexBackendReady,
  OwnedCodexBackendSettlement,
  OwnedCodexBackendStatus,
  OwnedCodexTuiConnection,
} from "../src/session-host/native-codex-backend";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import type {
  NativeHookArtifactCleanup,
  NativeHookArtifactLease,
} from "../src/session-host/native-hook-launch-prep";
import type {
  NativeHookRegistration,
  NativeHookSourceHandlers,
} from "../src/session-host/broker";
import type {
  NativeHookBootstrap,
  NativeHookEvent,
  NativeHookFailure,
} from "../src/session-host/native-hook-protocol";
import type { NativeStatusObservation, NativeStatusSupportMap } from "../src/session-host/native-status";
import type { NativeCodexTuiRootFactsSource } from "../src/session-host/native-codex-tui-root-facts";
import { decodeNativeInitialPromptFile } from "../src/session-host/native-initial-prompt";
import { createLocalOwningHostService } from "../src/session-host/owning-host-service";

/** The synthetic bearer, endpoint, and auth name every case shares. */
const SYNTHETIC_BEARER = "synthetic-observer-bearer-never-public";
const SYNTHETIC_AUTH_ENV = "PI_REVIEW_GATE_OWNED_CODEX_RPC_SYNTHETIC";
const SYNTHETIC_ENDPOINT = "ws://127.0.0.1:54321";
const LAUNCH_PREPARATION_ERROR = "session-host: instance launch preparation failed";

/**
 * The composite lease's retained fresh-root facts source. The manager must forward
 * THIS exact object to this run's observer and read nothing from it.
 */
const SYNTHETIC_ROOT_FACTS: NativeCodexTuiRootFactsSource = Object.freeze({
  current: () => Object.freeze({ phase: "empty" as const }),
  watch: () => () => undefined,
});

/* -------------------------------------------------------------------------- *
 * Synthetic fixtures                                                          *
 * -------------------------------------------------------------------------- */

/** One synthetic owned TUI child that records exactly what its owner did to it. */
class SpyPty implements InstancePty {
  static #nextPid = 810_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly killSignals: string[] = [];
  exitsOnSignal: "SIGTERM" | "SIGKILL" | "none" = "SIGTERM";
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
    this.#dataListeners.push(listener);
    return { dispose: () => { const i = this.#dataListeners.indexOf(listener); if (i >= 0) this.#dataListeners.splice(i, 1); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => { const i = this.#exitListeners.indexOf(listener); if (i >= 0) this.#exitListeners.splice(i, 1); } };
  }

  on(_eventName: "error", _listener: (error: Error) => void): void { /* not exercised */ }
  removeListener(_eventName: "error", _listener: (error: Error) => void): void { /* not exercised */ }
  write(_data: string | Buffer): void { /* not exercised */ }
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

class SpyNativeRegistrar implements NativeHookSourceRegistrar {
  readonly requests: { instanceId: string; backend: NativeCliBackend }[] = [];
  readonly releases: string[] = [];
  readonly handlers = new Map<string, NativeHookSourceHandlers>();

  registerNativeHookSource(
    instanceId: string,
    backend: NativeCliBackend,
    handlers: NativeHookSourceHandlers,
  ): NativeHookRegistration {
    this.requests.push({ instanceId, backend });
    this.handlers.set(instanceId, handlers);
    const bootstrap: NativeHookBootstrap = {
      version: 1,
      socketPath: `/synthetic/native/${instanceId}.sock`,
      generation: randomUUID(),
      instanceId,
      backend,
      token: randomBytes(32).toString("hex"),
    };
    return {
      bootstrap,
      release: () => {
        this.releases.push(instanceId);
        this.handlers.delete(instanceId);
      },
    };
  }

  emitEvent(instanceId: string, event: NativeHookEvent): void {
    this.handlers.get(instanceId)?.onEvent(event);
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

/**
 * The host reader for these cases. It records the order of the manager's optional
 * calls; the harness decides which shape (with or without the owned-backend seam)
 * it builds.
 */
class SpyObserver implements NativeStatusObserver {
  readonly events: string[] = [];
  readonly backendSources: NativeOwnedCodexBackendObservationSource[] = [];
  disposeCount = 0;
  invalidateCount = 0;
  support: NativeStatusSupportMap = {};
  /** When set, the owned-backend seam throws, exactly as a broken source would. */
  throwOnBackend = false;

  constructor(readonly context: NativeStatusObserverContext) {}

  acceptHook(_event: NativeHookEvent): void { /* not exercised here */ }
  acceptFailure(_failure: NativeHookFailure): void { /* not exercised here */ }
  invalidate(): void { this.invalidateCount += 1; }
  dispose(): void { this.disposeCount += 1; }
  observeOwnedStartup(): void { this.events.push("startup"); }

  emit(observation: NativeStatusObservation) { return this.context.emit(observation); }
}

/** The same reader, additionally accepting the owned-backend seam. */
class SpyBackendObserver extends SpyObserver {
  observeOwnedCodexBackend(source: NativeOwnedCodexBackendObservationSource): void {
    this.events.push("backend");
    this.backendSources.push(source);
    if (this.throwOnBackend) throw new Error("synthetic source failure carrying no secret");
  }
}

/** A fake captured backend child handle. The manager never touches it directly. */
class FakeBackendChild {
  readonly pid = 610_000;
  readonly stdout = { on(): void { /* captured */ }, removeListener(): void { /* captured */ } };
  readonly stderr = { on(): void { /* captured */ }, removeListener(): void { /* captured */ } };
}

/**
 * A fake owned backend lease with the exact shape the manager validates. Readiness,
 * settlement, and stop are all driven by the test.
 */
class FakeBackendLease implements OwnedCodexBackendLease {
  readonly identity: OwnedCodexBackendLaunchIdentity;
  readonly child = new FakeBackendChild();
  requestStopCount = 0;
  createTuiConnectionCount = 0;
  readBearerCount = 0;
  /** What this lease's readiness carries as the retained facts; a bare lease has none. */
  tuiRootFacts: NativeCodexTuiRootFactsSource | undefined = SYNTHETIC_ROOT_FACTS;
  readonly readiness: Promise<OwnedCodexBackendReady>;
  readonly settlement: Promise<OwnedCodexBackendSettlement>;
  #resolveReady!: (ready: OwnedCodexBackendReady) => void;
  #rejectReady!: (error: Error) => void;
  #resolveSettlement!: (settlement: OwnedCodexBackendSettlement) => void;
  #settled = false;
  /** This child's own `exit` event: readers may still be open, so settlement stays pending. */
  exitWitnessed = false;
  /** Sticky owned force-escalation report, as the real launcher sets it before SIGKILL. */
  forceEscalationAttempted = false;
  /** Model a lease whose status read fails. */
  statusThrows = false;
  /**
   * What every `status()` read observed, in order. A test uses this to PROVE where a
   * race landed: which check saw a live lease and which one saw the stop or the exit.
   */
  readonly statusSnapshots: { stopRequested: boolean; exitObserved: boolean; settled: boolean }[] = [];

  constructor(identity: OwnedCodexBackendLaunchIdentity) {
    this.identity = identity;
    this.readiness = new Promise<OwnedCodexBackendReady>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // A lease's readiness rejection is expected to be handled by its owner.
    void this.readiness.catch(() => undefined);
    this.settlement = new Promise<OwnedCodexBackendSettlement>((resolve) => {
      this.#resolveSettlement = resolve;
    });
  }

  status(): OwnedCodexBackendStatus {
    const snapshot = {
      stopRequested: this.requestStopCount > 0,
      exitObserved: this.exitWitnessed,
      settled: this.#settled,
    };
    this.statusSnapshots.push(snapshot);
    if (this.statusThrows) throw new Error("synthetic status read failure");
    return {
      identity: this.identity,
      phase: this.#settled ? "settled" : this.exitWitnessed ? "exited" : this.requestStopCount > 0 ? "stopping" : "starting",
      ready: false,
      readinessFailure: undefined,
      stopRequested: snapshot.stopRequested,
      childWitnessed: true,
      spawnObserved: true,
      spawnFailureObserved: false,
      exitObserved: snapshot.exitObserved,
      stdoutEnded: false,
      stderrEnded: false,
      settled: this.#settled,
      terminationAttempted: this.requestStopCount > 0,
      terminationFailed: false,
      forceEscalationAttempted: this.forceEscalationAttempted,
      childErrorObserved: false,
      readerErrorObserved: false,
    };
  }

  requestStop(): void { this.requestStopCount += 1; }

  /** Witness this child's own exit. It is NOT settlement: the readers may still be open. */
  markExited(): void { this.exitWitnessed = true; }

  /** Fulfill readiness exactly as the real lease would: fresh connection material. */
  fulfillReady(): void {
    const connection: OwnedCodexTuiConnection = {
      endpoint: SYNTHETIC_ENDPOINT,
      args: ["--remote", SYNTHETIC_ENDPOINT, "--remote-auth-token-env", SYNTHETIC_AUTH_ENV],
      env: { PATH: "/synthetic/bin", [SYNTHETIC_AUTH_ENV]: SYNTHETIC_BEARER },
    };
    const ready: OwnedCodexBackendReady = {
      endpoint: SYNTHETIC_ENDPOINT,
      readObserverBearer: () => {
        this.readBearerCount += 1;
        return SYNTHETIC_BEARER;
      },
      createTuiConnection: () => {
        this.createTuiConnectionCount += 1;
        return connection;
      },
      // A composite lease carries the retained facts; a bare backend lease does
      // not, and the manager must not invent one.
      ...(this.tuiRootFacts === undefined ? {} : { tuiRootFacts: this.tuiRootFacts }),
    };
    this.#resolveReady(ready);
  }

  rejectReady(): void { this.#rejectReady(new Error("synthetic readiness failure")); }

  /** Positive settlement only: the test decides when the proof exists. */
  settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveSettlement({
      status: "settled",
      child: "exited",
      code: 0,
      signal: null,
      stdout: "ended",
      stderr: "ended",
    });
  }
}

type RenderedChild = {
  file: string;
  args: string[];
  commandLine?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
};

/** A test rendering plan: both renderers are recorded and fully controllable. */
class SpyPlan implements NativeCodexOwnedLaunchPlan {
  readonly backendEnv: NodeJS.ProcessEnv = { PATH: "/synthetic/bin", CODEX_HOME: "/synthetic/home/.codex" };
  readonly backendRenders: { controlArgs: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  readonly tuiRenders: NativeCodexOwnedTuiConnection[] = [];
  /** The workspace both renderers report as the child cwd. */
  tuiCwd = "/synthetic/workspace";
  /** When set, `renderTui` returns this batch shape instead of the direct one. */
  batchTui: { file: string; args: string[]; commandLine: string } | undefined;

  renderBackend(controlArgs: readonly string[], environment: NodeJS.ProcessEnv): RenderedChild {
    this.backendRenders.push({ controlArgs, env: environment });
    return {
      file: "/synthetic/bin/codex",
      args: ["app-server", ...controlArgs],
      env: { ...environment },
      cwd: this.tuiCwd,
    };
  }

  renderTui(connection: NativeCodexOwnedTuiConnection): RenderedChild {
    this.tuiRenders.push(connection);
    if (this.batchTui !== undefined) {
      return {
        file: this.batchTui.file,
        args: this.batchTui.args,
        commandLine: this.batchTui.commandLine,
        env: { ...connection.env } as NodeJS.ProcessEnv,
        cwd: this.tuiCwd,
      };
    }
    return {
      file: "/synthetic/bin/codex",
      args: ["--interactive", ...connection.args],
      env: { ...connection.env } as NodeJS.ProcessEnv,
      cwd: this.tuiCwd,
    };
  }
}

/* -------------------------------------------------------------------------- *
 * The harness                                                                 *
 * -------------------------------------------------------------------------- */

interface Harness {
  root: string;
  workspace: string;
  manager: InstanceManager;
  piRegistrar: RecordingPiRegistrar;
  nativeRegistrar: SpyNativeRegistrar;
  observers: SpyObserver[];
  spawned: SpyPty[];
  plans: SpyPlan[];
  leases: FakeBackendLease[];
  factoryRequests: OwnedCodexBackendLaunchRequest[];
  abortSignals: AbortSignal[];
  providerCalls: NativeCliLaunchRequest[];
  /** Settle every backend this harness produced, the way a real child eventually exits. */
  settleAll(): void;
}

interface HarnessOptions {
  /** `absent` builds a manager with no owned-backend factory at all. */
  factory?: "present" | "absent";
  /** Replace the factory itself, for a case whose answer is deliberately wrong. */
  factoryImpl?: OwnedCodexBackendFactory;
  /** `absent` builds a manager with no status observer pair at all. */
  pair?: "present" | "absent";
  /** The provider to install; defaults to a Codex provider that attaches a plan. */
  provider?: NativeCliLaunch;
  /** Make the observer factory answer asynchronously. */
  asyncObserver?: boolean;
  /** Build observers without the optional owned-backend seam. */
  observerWithoutSeam?: boolean;
  /** Arm the seam's throw from construction, so the ordering is not a race. */
  observerThrows?: boolean;
  /**
   * Hold the observer factory's answer until the test releases it, so "late" means a
   * genuinely deferred arrival rather than a same-tick `Promise.resolve`.
   */
  observerGate?: Promise<void>;
}

function makeHarness(label: string, options: HarnessOptions = {}): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `prg-owned-codex-manager-${label}-`)));
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
  const agentDir = join(root, "native-agent");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const piRegistrar = new RecordingPiRegistrar();
  const nativeRegistrar = new SpyNativeRegistrar();
  const observers: SpyObserver[] = [];
  const spawned: SpyPty[] = [];
  const plans: SpyPlan[] = [];
  const leases: FakeBackendLease[] = [];
  const factoryRequests: OwnedCodexBackendLaunchRequest[] = [];
  const abortSignals: AbortSignal[] = [];
  const providerCalls: NativeCliLaunchRequest[] = [];

  const newPlan = (cwd: string): SpyPlan => {
    const plan = new SpyPlan();
    plan.tuiCwd = cwd;
    plans.push(plan);
    return plan;
  };

  const defaultProvider: NativeCliLaunch = (backend, request) => {
    providerCalls.push(request);
    const descriptor: NativeCliLaunchDescriptor = {
      file: "/synthetic/bin/codex",
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin", HOME: home },
      cwd: request.workspace,
      ...(backend === "codex" ? { ownedCodex: newPlan(request.workspace) as unknown as NativeCodexOwnedLaunchPlan } : {}),
    };
    return descriptor;
  };

  const provider: NativeCliLaunch = options.provider ?? defaultProvider;

  const factory: OwnedCodexBackendFactory = options.factoryImpl ?? ((request) => {
    factoryRequests.push(request);
    request.signal.addEventListener("abort", () => abortSignals.push(request.signal));
    const lease = new FakeBackendLease(request.identity);
    leases.push(lease);
    return lease;
  });

  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: piRegistrar,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    nativeCliLaunch: (backend, request) => provider(backend, request),
    ...(options.pair === "absent"
      ? {}
      : {
        nativeHookRegistrar: nativeRegistrar,
        nativeStatusObserverFactory: (context) => {
          // Recorded when the manager actually RECEIVES an answer, so a gated factory
          // really does model an observer that has not arrived yet.
          const build = (): SpyObserver => {
            const built = options.observerWithoutSeam === true
              ? new SpyObserver(context)
              : new SpyBackendObserver(context);
            if (options.observerThrows === true) built.throwOnBackend = true;
            observers.push(built);
            return built;
          };
          if (options.observerGate !== undefined) return options.observerGate.then(() => build());
          const observer = build();
          if (options.asyncObserver === true) return Promise.resolve(observer);
          return observer;
        },
      }),
    ...(options.factory === "absent" ? {} : { ownedCodexBackendFactory: factory }),
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      spawned.push(pty);
      return pty;
    },
  });

  return {
    root,
    workspace,
    manager,
    piRegistrar,
    nativeRegistrar,
    observers,
    spawned,
    plans,
    leases,
    factoryRequests,
    abortSignals,
    providerCalls,
    settleAll: () => {
      for (const lease of leases) lease.settle();
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

function lastPty(harness: Harness): SpyPty {
  const pty = harness.spawned.at(-1);
  assert.ok(pty, "a launched row owns its PTY");
  return pty;
}

function lastLease(harness: Harness): FakeBackendLease {
  const lease = harness.leases.at(-1);
  assert.ok(lease, "an owned launch owns its backend lease");
  return lease;
}

function lastObserver(harness: Harness): SpyObserver {
  const observer = harness.observers.at(-1);
  assert.ok(observer, "an armed row owns its observer");
  return observer;
}

function createCodex(harness: Harness): Promise<string> {
  return harness.manager.create({ workspace: harness.workspace, backend: "codex" } as CreateInstanceOptions);
}

/**
 * Start an owned launch, let the backend be created and retained, then fulfill its
 * readiness — the ordinary shape of a successful owned launch. Cases that need to
 * observe the pending window use {@linkcode createCodex} directly.
 */
async function launchCodex(harness: Harness): Promise<string> {
  const created = createCodex(harness);
  await until(() => harness.factoryRequests.length === 1, "the backend is created and retained");
  lastLease(harness).fulfillReady();
  return created;
}

/** Launch a further owned row in the same harness, once the previous ones exist. */
async function launchCodex2(harness: Harness): Promise<string> {
  const before = harness.factoryRequests.length;
  const created = createCodex(harness);
  await until(() => harness.factoryRequests.length === before + 1, "the next backend is created and retained");
  lastLease(harness).fulfillReady();
  return created;
}

/* -------------------------------------------------------------------------- *
 * The positive owned launch                                                   *
 * -------------------------------------------------------------------------- */

test("an owned plan creates one backend whose lease is retained before readiness is awaited, and the TUI is rendered from that same lease", async () => {
  const harness = makeHarness("positive");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend factory runs");

    // RETAINED, not merely created: while readiness is still pending and no PTY
    // exists yet, this row already owns an unsettled backend process.
    assert.equal(harness.spawned.length, 0, "no TUI exists before the backend is ready");
    assert.equal(harness.manager.hasLiveProcesses(), true, "the retained backend is owned work");

    // The factory got exactly this run's plan, an identity, and a cancellation signal.
    const request = harness.factoryRequests[0]!;
    assert.equal(request.plan, harness.plans[0], "the factory receives this launch's own plan");
    assert.ok(request.identity.leaseId.length > 0);
    assert.equal(request.identity.generation, 0);
    assert.equal(request.signal.aborted, false);

    lastLease(harness).fulfillReady();
    const id = await created;

    // The genuine TUI comes from the plan rendered with THIS lease's connection.
    assert.equal(harness.plans[0]!.tuiRenders.length, 1, "the TUI is rendered once from the lease");
    assert.equal(lastLease(harness).createTuiConnectionCount, 1, "one fresh set of connection material");
    const pty = lastPty(harness);
    assert.deepEqual(pty.spawnDescriptor.args, [
      "--interactive",
      "--remote", SYNTHETIC_ENDPOINT,
      "--remote-auth-token-env", SYNTHETIC_AUTH_ENV,
    ], "the rendered argv carries the lease's connection arguments in option position");
    assert.equal(pty.spawnDescriptor.env[SYNTHETIC_AUTH_ENV], SYNTHETIC_BEARER, "the bearer reaches only this child");
    assert.equal(pty.spawnDescriptor.cwd, realpathSync(harness.workspace));
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive");

    // The manager never renders the backend itself: the factory owns that call.
    assert.equal(harness.plans[0]!.backendRenders.length, 0);

    // Nothing private is published: no bearer, endpoint, or auth variable name.
    const publicSnapshot = JSON.stringify(harness.manager.list());
    assert.equal(publicSnapshot.includes(SYNTHETIC_BEARER), false);
    assert.equal(publicSnapshot.includes(SYNTHETIC_ENDPOINT), false);
    assert.equal(publicSnapshot.includes(SYNTHETIC_AUTH_ENV), false);

    // Positive settlement of both processes is what finally lets the row go.
    pty.emitExit(0);
    assert.equal(lastLease(harness).requestStopCount, 1, "the TUI's exit requests the backend's owned stop");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true, "a backend that has not settled is not gone");
    assert.equal(harness.manager.closeExited(id), false, "an unsettled backend keeps its row");
    lastLease(harness).settle();
    await until(() => viewOf(harness.manager, id).hasLiveProcess === false, "the settled backend releases the row");
    assert.equal(harness.manager.closeExited(id), true);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("the observer seam fires once, after the exact live PTY capture and before the startup baseline, and never again", async () => {
  const harness = makeHarness("observer-order");
  try {
    const id = await launchCodex(harness);
    const observer = lastObserver(harness);
    const lease = lastLease(harness);

    assert.deepEqual(observer.events, ["backend", "startup"], "ownership is qualified before any baseline claim");
    assert.equal(observer.backendSources.length, 1, "exactly one delivery per run");
    const source = observer.backendSources[0]!;
    assert.equal(source.leaseId, harness.factoryRequests[0]!.identity.leaseId);
    assert.equal(source.generation, 0);
    assert.equal(source.endpoint, SYNTHETIC_ENDPOINT, "the endpoint comes from this lease");
    assert.equal(source.readObserverBearer(), SYNTHETIC_BEARER);
    assert.equal(lease.readBearerCount, 1, "the accessor forwards on demand and caches nothing");
    assert.equal(source.tuiRootFacts, SYNTHETIC_ROOT_FACTS,
      "the lease's own retained root-facts source is forwarded verbatim, not re-minted");
    assert.equal(Object.isFrozen(source), true, "the private capability cannot be widened after delivery");

    // A stop cannot deliver a second time to this run. Its bounded settlement window
    // closes as soon as the backend's own proof arrives, which is what a real child does.
    const stopping = harness.manager.stop(id, { confirmed: true });
    await until(() => lease.requestStopCount === 1, "the backend was asked to stop");
    lease.settle();
    await stopping;
    assert.deepEqual(observer.events, ["backend", "startup"]);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a backend lease without retained root facts forwards a source that simply has none", async () => {
  const harness = makeHarness("lease-without-facts");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend is created and retained");
    const lease = lastLease(harness);
    // Exactly what a bare owned backend lease answers with: no relay, no facts.
    lease.tuiRootFacts = undefined;
    lease.fulfillReady();
    const id = await created;

    const observer = lastObserver(harness);
    assert.equal(observer.backendSources.length, 1, "the capability is still offered once");
    const source = observer.backendSources[0]!;
    assert.equal(source.endpoint, SYNTHETIC_ENDPOINT);
    assert.equal("tuiRootFacts" in source, false,
      "absence is forwarded as absence: the manager never invents a facts source");

    // Nothing about the missing observation detail touches the owned row.
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive");
    assert.equal(lease.createTuiConnectionCount, 1);
    harness.settleAll();
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an observer without the seam, and a manager without the observer pair, still own the backend", async () => {
  const noSeam = makeHarness("observer-without-seam", { observerWithoutSeam: true });
  try {
    const id = await launchCodex(noSeam);
    assert.equal(noSeam.leases.length, 1, "resource ownership does not require the seam");
    assert.equal(noSeam.spawned.length, 1, "the genuine TUI still launches from the lease");
    assert.deepEqual(lastObserver(noSeam).events, ["startup"], "the remaining optional call is unchanged");
    assert.equal(viewOf(noSeam.manager, id).lifecycle, "alive");
    noSeam.settleAll();
    await noSeam.manager.dispose();
  } finally {
    rmSync(noSeam.root, { recursive: true, force: true });
  }

  const noPair = makeHarness("no-observer-pair", { pair: "absent" });
  try {
    const id = await launchCodex(noPair);
    assert.equal(noPair.leases.length, 1, "resource ownership does not require an observer at all");
    assert.equal(noPair.spawned.length, 1, "the genuine TUI still launches from the lease");
    assert.equal(noPair.nativeRegistrar.requests.length, 0);
    assert.equal(viewOf(noPair.manager, id).lifecycle, "alive");
    assert.equal(viewOf(noPair.manager, id).busy, null, "no status is invented for an unobserved row");
    noPair.settleAll();
    await noPair.manager.dispose();
  } finally {
    rmSync(noPair.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- *
 * The observation source WITHOUT any status hook of ours                       *
 *                                                                            *
 * An owned Codex launch composes no native SessionStart hook of this host's   *
 * own, so its descriptor says NOTHING about a hook even when the manager      *
 * armed the broker pair for it. Saying nothing must never retire the run: the *
 * observer, its capture, and this run's one private backend capability still   *
 * arrive, and the two processes stay owned regardless of what the observation  *
 * path does.                                                                  *
 * -------------------------------------------------------------------------- */

test("an owned run whose descriptor says nothing about a hook keeps its source and receives its capability once", async () => {
  const harness = makeHarness("owned-no-hook-outcome");
  try {
    // This is exactly what a real owned Codex launch now composes: the pair armed the
    // registration, the provider planned the backend, and the descriptor carries no
    // hook outcome, no generated flag, and no staged artifact.
    const id = await launchCodex(harness);
    const observer = lastObserver(harness);

    assert.equal(harness.nativeRegistrar.requests.length, 1, "the broker registration still happened");
    assert.deepEqual(harness.nativeRegistrar.releases, [], "an absent hook outcome retires nothing");

    // The observation path is fully live without a hook: the private capability first,
    // then the run's baseline claim, exactly once each, and the observer is undisposed.
    assert.deepEqual(observer.events, ["backend", "startup"]);
    assert.equal(observer.backendSources.length, 1, "one delivery, after the live PTY capture");
    assert.equal(observer.backendSources[0]!.endpoint, SYNTHETIC_ENDPOINT);
    assert.equal(observer.disposeCount, 0, "the source was never retired for want of a hook");

    // And the row is an ordinary live owned row.
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive");
    assert.equal(lastLease(harness).requestStopCount, 0);
    harness.settleAll();
    await harness.manager.dispose();
    assert.ok(observer.disposeCount >= 1, "teardown, not a missing hook, retires the source");
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an explicit unavailable hook outcome still retires an owned run's callbacks while both processes stay owned", async () => {
  const harness = makeHarness("owned-explicit-unavailable", {
    provider: (backend, request) => ({
      file: "/synthetic/bin/codex",
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
      // An explicit refusal is a different fact from silence, and it keeps its existing
      // fail-closed meaning even for an owned plan.
      nativeHook: { observation: "unavailable", backend, reason: "operator-hook-override" },
      ownedCodex: (() => {
        const plan = new SpyPlan();
        plan.tuiCwd = request.workspace;
        harness.plans.push(plan);
        return plan as unknown as NativeCodexOwnedLaunchPlan;
      })(),
    }),
  });
  try {
    const id = await launchCodex(harness);
    const observer = lastObserver(harness);
    const lease = lastLease(harness);
    const pty = lastPty(harness);

    assert.equal(observer.disposeCount, 1, "the explicit refusal retires the callbacks");
    assert.deepEqual(observer.backendSources, [], "a retired run is offered no capability");
    assert.deepEqual(harness.nativeRegistrar.releases, [id], "and its registration is released");

    // Nothing about the refusal touches the two processes this row owns: the backend was
    // still created, still rendered this TUI, and is still owned.
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive");
    assert.equal(pty.exited, false);
    assert.equal(lease.createTuiConnectionCount, 1, "the TUI still came from this lease");
    assert.equal(lease.requestStopCount, 0, "retiring callbacks never stops the backend");

    harness.settleAll();
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a late observer answer is offered the run's backend once while it is still current, and never a second time", async () => {
  const harness = makeHarness("late-observer", { asyncObserver: true });
  try {
    const id = await launchCodex(harness);
    await until(() => harness.observers.length === 1, "the asynchronous observer answers");
    const observer = lastObserver(harness);
    // The observer existed only after activation; the fence still offers it once.
    await until(() => observer.backendSources.length === 1, "a late source is offered the current run");
    assert.equal(observer.backendSources[0]!.endpoint, SYNTHETIC_ENDPOINT);

    // Once the run ends, the same source can adopt nothing further.
    const lease = lastLease(harness);
    const stopping = harness.manager.stop(id, { confirmed: true });
    await until(() => lease.requestStopCount === 1, "the backend was asked to stop");
    lease.settle();
    await stopping;
    assert.equal(observer.backendSources.length, 1, "no second delivery");
    await harness.manager.dispose();
    assert.ok(observer.disposeCount >= 1);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an observer that throws in the backend seam retires only its own callbacks and never disturbs the run", async () => {
  const harness = makeHarness("throwing-observer", { observerThrows: true });
  try {
    const id = await launchCodex(harness);
    const lease = lastLease(harness);
    const pty = lastPty(harness);

    // The run stays live with both processes owned: only the observation path retired.
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true);
    assert.equal(lease.requestStopCount, 0, "a throwing observer never stops the backend");
    assert.equal(pty.exited, false);
    assert.equal(lastObserver(harness).disposeCount, 1, "the observer itself was retired");
    const publicSnapshot = JSON.stringify(harness.manager.list());
    assert.equal(publicSnapshot.includes("synthetic source failure"), false);
    assert.equal(publicSnapshot.includes(SYNTHETIC_BEARER), false);

    harness.settleAll();
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- *
 * The two-process barrier                                                     *
 * -------------------------------------------------------------------------- */

test("hook artifacts and row liveness wait for the backend's own settlement, not the TUI's exit", async () => {
  const staged = new SpyLease();
  const harness = makeHarness("two-process-barrier", {
    provider: (backend, request) => ({
      file: "/synthetic/bin/codex",
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
      nativeHook: {
        observation: "prepared",
        backend,
        route: "codex-session-start",
        args: [],
        environment: {},
        lease: staged,
      },
      ownedCodex: (() => {
        const plan = new SpyPlan();
        plan.tuiCwd = request.workspace;
        harness.plans.push(plan);
        return plan as unknown as NativeCodexOwnedLaunchPlan;
      })(),
    }),
  });
  try {
    const id = await launchCodex(harness);
    const pty = lastPty(harness);
    const lease = lastLease(harness);

    pty.emitExit(0);
    // The TUI is gone and its run is retired, but its second child is still live.
    assert.equal(staged.cleanupCount, 0, "the backend may still be reading these files");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true);
    assert.equal(harness.manager.hasLiveProcesses(), true);
    assert.equal(harness.manager.closeExited(id), false);

    lease.settle();
    await until(() => staged.cleanupCount === 1, "the backend's settlement makes cleanup safe");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, false);
    assert.equal(harness.manager.closeExited(id), true);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a backend that settles first keeps a live TUI row live and never fabricates its exit", async () => {
  const harness = makeHarness("backend-settles-first");
  try {
    const id = await launchCodex(harness);
    const pty = lastPty(harness);
    const lease = lastLease(harness);

    lease.settle();
    await sleep(5);
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive", "a backend exit is never a TUI exit");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true);
    assert.equal(pty.exited, false);
    assert.equal(harness.manager.closeExited(id), false);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- *
 * Cancellation and failure edges                                              *
 * -------------------------------------------------------------------------- */

test("shutdown while the provider is pending creates no backend and no TUI", async () => {
  let releaseProvider: ((descriptor: NativeCliLaunchDescriptor) => void) | undefined;
  const harness = makeHarness("stop-before-provider", {
    provider: (backend, request) => new Promise<NativeCliLaunchDescriptor>((resolve) => {
      releaseProvider = resolve;
      void backend;
      void request;
    }),
  });
  try {
    const created = createCodex(harness);
    await sleep(10);
    const shutdown = harness.manager.shutdown();
    const id = await created;
    assert.equal(harness.factoryRequests.length, 0, "no backend was ever created");
    assert.equal(harness.spawned.length, 0, "no TUI was ever created");
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");
    assert.equal(viewOf(harness.manager, id).error, LAUNCH_PREPARATION_ERROR);
    await shutdown;
    await harness.manager.dispose();
    releaseProvider?.({ file: "/synthetic/bin/codex", args: [], env: {}, cwd: harness.workspace });
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a confirmed Stop while the provider is still preparing cancels the owned launch before any backend or TUI can exist", async () => {
  let releaseProvider: ((descriptor: NativeCliLaunchDescriptor) => void) | undefined;
  let providerEntered = false;
  const harness = makeHarness("stop-during-provider", {
    provider: () => new Promise<NativeCliLaunchDescriptor>((resolve) => {
      providerEntered = true;
      releaseProvider = resolve;
    }),
  });
  try {
    const created = createCodex(harness);
    await until(() => providerEntered, "the provider is running");
    const id = harness.manager.list()[0]!.id;

    // Nothing of this launch exists yet — no PTY, no backend — and the row is still
    // stoppable: an unconfirmed stop is refused, and a CONFIRMED one is accepted as the
    // cancellation of the launch itself.
    assert.deepEqual(await harness.manager.stop(id, { confirmed: false }), { status: "confirmation-required", forced: false });
    assert.deepEqual(await harness.manager.stop(id, { confirmed: true }), { status: "unconfirmed", forced: false });
    assert.equal(harness.factoryRequests.length, 0, "no backend was ever created");

    // THE unblock: the launch is finished now, by the Stop, without waiting for the
    // provider it was awaiting, and its row reports the fixed preparation error.
    await created;
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");
    assert.equal(viewOf(harness.manager, id).error, LAUNCH_PREPARATION_ERROR);

    // The provider's later owned answer creates nothing at all: no backend, no plan
    // render, no TUI, and no live process this manager would then have to stop.
    const latePlan = new SpyPlan();
    latePlan.tuiCwd = harness.workspace;
    releaseProvider?.({
      file: "/synthetic/bin/codex",
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: harness.workspace,
      ownedCodex: latePlan as unknown as NativeCodexOwnedLaunchPlan,
    });
    await sleep(20);
    assert.equal(harness.factoryRequests.length, 0, "a stopped row's late provider answer creates no backend");
    assert.equal(latePlan.tuiRenders.length, 0, "and renders nothing from it");
    assert.equal(harness.spawned.length, 0, "and spawns no TUI");
    assert.equal(harness.manager.hasLiveProcesses(), false);

    // The Stop retired this run's observation path, once and deliberately.
    assert.equal(lastObserver(harness).disposeCount, 1, "the source was retired by the Stop");
    assert.deepEqual(harness.nativeRegistrar.releases, [id]);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("shutdown while readiness is pending requests the exact owned stop, spawns no TUI, and never hangs", async () => {
  const harness = makeHarness("stop-during-readiness");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend exists");
    const lease = lastLease(harness);

    const shutdown = harness.manager.shutdown();
    const started = Date.now();
    const id = await created;
    const elapsed = Date.now() - started;

    assert.equal(lease.requestStopCount, 1, "one owned stop request, exactly once");
    assert.equal(harness.abortSignals.length, 1, "the factory's signal was aborted too");
    assert.equal(harness.abortSignals[0]!.aborted, true);
    assert.equal(harness.spawned.length, 0, "a retired run never spawns a TUI");
    assert.ok(elapsed < 4_000, "the stopped launch is unblocked without waiting on its backend");
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");

    // A readiness answer that arrives afterwards adopts nothing.
    lease.fulfillReady();
    await sleep(20);
    assert.equal(harness.spawned.length, 0, "a late readiness answer starts no child");
    assert.equal(harness.plans[0]!.tuiRenders.length, 0, "and renders no TUI");

    // Ownership still holds until that backend positively settles, and the manager's
    // bounded settlement window ends on that same proof rather than on its timer.
    assert.equal(harness.manager.hasLiveProcesses(), true);
    lease.settle();
    await shutdown;
    await until(() => harness.manager.hasLiveProcesses() === false, "the settled backend releases ownership");
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a rejected readiness with the child still alive errors the row, spawns nothing, and keeps ownership", async () => {
  const staged = new SpyLease();
  const harness = makeHarness("ready-rejected", {
    provider: (backend, request) => ({
      file: "/synthetic/bin/codex",
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
      nativeHook: {
        observation: "prepared",
        backend,
        route: "codex-session-start",
        args: [],
        environment: {},
        lease: staged,
      },
      ownedCodex: (() => {
        const plan = new SpyPlan();
        plan.tuiCwd = request.workspace;
        harness.plans.push(plan);
        return plan as unknown as NativeCodexOwnedLaunchPlan;
      })(),
    }),
  });
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend exists");
    const lease = lastLease(harness);
    lease.rejectReady();

    const id = await created;
    assert.equal(harness.spawned.length, 0, "a backend that never became ready never gains a TUI");
    assert.equal(harness.plans[0]!.tuiRenders.length, 0, "no connection material is ever requested");
    assert.equal(lease.requestStopCount, 1, "the created child is asked to terminate exactly once");
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");
    assert.equal(viewOf(harness.manager, id).error, LAUNCH_PREPARATION_ERROR);
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true, "readiness rejection is not settlement");
    assert.equal(staged.cleanupCount, 0, "the live backend still owns the staged files");
    assert.equal(harness.manager.closeError(id), false, "an unsettled backend keeps the failed row");

    lease.settle();
    await until(() => staged.cleanupCount === 1, "its settlement releases the files");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, false);
    assert.equal(harness.manager.closeError(id), true);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a confirmed stop requests the owned backend stop once, alongside the existing PTY ladder", async () => {
  const harness = makeHarness("stop-row");
  try {
    const id = await launchCodex(harness);
    const pty = lastPty(harness);
    const lease = lastLease(harness);

    const stopping = harness.manager.stop(id, { confirmed: true });
    await until(() => lease.requestStopCount === 1, "the owned stop request");
    assert.ok(pty.killSignals.length >= 1, "the existing PTY ladder still runs");
    pty.emitExit(0);
    assert.equal(lease.requestStopCount, 1, "the TUI's exit never repeats it");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true);
    // The stop barrier ends on the backend's own settlement, and only then does it
    // report this row exited: one component's exit is never the other's proof.
    lease.settle();
    assert.deepEqual(await stopping, { status: "exited", forced: false });
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, false);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("manager disposal requests the owned stop of every unsettled backend and gives it the same bounded settlement window", async () => {
  const harness = makeHarness("dispose-owned");
  try {
    await launchCodex(harness);
    const lease = lastLease(harness);
    const disposing = harness.manager.dispose();
    await until(() => lease.requestStopCount === 1, "the owned stop was requested");
    assert.equal(harness.abortSignals.length, 1);
    // Until that backend settles, disposal does not declare it gone: the row keeps its
    // ownership, and the report a caller can act on stays truthful.
    assert.equal(harness.manager.hasLiveProcesses(), true, "an unsettled backend is still owned work");
    lease.settle();
    await disposing;
    assert.equal(harness.manager.hasLiveProcesses(), false, "its own settlement is what ends the window");
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a backend that never settles is reported as remaining, within a bounded window, and is never dropped", async () => {
  const harness = makeHarness("shutdown-remaining");
  try {
    const id = await launchCodex(harness);
    const lease = lastLease(harness);
    const started = Date.now();
    const result = await harness.manager.shutdown({ graceMs: 60, killMs: 40 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 40, `the settlement window was actually observed (${elapsed}ms)`);
    assert.ok(elapsed < 5_000, `the settlement window stays bounded (${elapsed}ms)`);
    assert.deepEqual(result.remainingIds, [id], "an unsettled backend is a remaining owned process");
    assert.equal(harness.manager.hasLiveProcesses(), true, "the report and the live-process authority agree");
    assert.equal(lease.requestStopCount, 1, "its exact owned termination was requested once");
    assert.equal(harness.manager.closeExited(id), false, "remaining means this manager still owns it");

    // An expired window never fabricates a settlement: the proof still arrives on its own.
    lease.settle();
    await until(() => harness.manager.hasLiveProcesses() === false, "the late settlement");
    assert.equal(harness.manager.closeExited(id), true);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a backend that settles inside the stop window is not reported as remaining", async () => {
  const harness = makeHarness("shutdown-settled-in-window");
  try {
    await launchCodex(harness);
    const lease = lastLease(harness);
    setTimeout(() => lease.settle(), 30);
    const result = await harness.manager.shutdown({ graceMs: 500, killMs: 100 });
    assert.deepEqual(result.remainingIds, [], "a settlement inside the window is not remaining");
    assert.equal(harness.manager.hasLiveProcesses(), false);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------- *
 * Forced reporting covers the owned backend's force escalation as well   *
 * -------------------------------------------------------------------- */

test("a graceful TUI exit with an owned backend force escalation reports forced, and remembers it after settlement", async () => {
  const harness = makeHarness("forced-backend-stop");
  try {
    const id = await launchCodex(harness);
    const pty = lastPty(harness);
    const lease = lastLease(harness);

    const stopping = harness.manager.stop(id, { confirmed: true });
    await until(() => lease.requestStopCount === 1, "the owned stop request");
    // The TUI exits on SIGTERM (no PTY escalation); only the backend needs its SIGKILL.
    await until(() => pty.exited, "the TUI's graceful exit");
    assert.equal(pty.killSignals.includes("SIGKILL"), false, "the PTY was never force-escalated");
    lease.forceEscalationAttempted = true;
    lease.markExited();
    lease.settle();
    assert.deepEqual(await stopping, { status: "exited", forced: true });
    // A repeated stop after both settled still reports the historical force attempt.
    assert.deepEqual(await harness.manager.stop(id, { confirmed: true }), { status: "exited", forced: true });
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, false);
    // A shutdown after that completed backend-forced stop still reports the row, with
    // no stop target left and nothing remaining.
    const shutdown = await harness.manager.shutdown({ graceMs: 40, killMs: 20 });
    assert.deepEqual(shutdown.forcedIds, [id]);
    assert.deepEqual(shutdown.remainingIds, []);
    assert.equal(lease.requestStopCount, 1);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a backend force attempt whose exit and readers are unconfirmed is forced and still remaining", async () => {
  const harness = makeHarness("forced-backend-unconfirmed");
  try {
    const id = await launchCodex(harness);
    const lease = lastLease(harness);
    const shutting = harness.manager.shutdown({ graceMs: 60, killMs: 40 });
    await until(() => lease.requestStopCount === 1, "the owned stop request");
    lease.forceEscalationAttempted = true;
    // No exit, no readers, no settlement: a force attempt is evidence, never proof.
    const result = await shutting;
    assert.deepEqual(result.forcedIds, [id]);
    assert.deepEqual(result.remainingIds, [id], "a reported force attempt never settles the row");
    assert.equal(harness.manager.hasLiveProcesses(), true);
    assert.equal(harness.manager.closeExited(id), false);

    // A repeated shutdown while the backend is still pending still reports both truths.
    const pending = await harness.manager.shutdown({ graceMs: 40, killMs: 20 });
    assert.deepEqual(pending.forcedIds, [id]);
    assert.deepEqual(pending.remainingIds, [id]);
    assert.equal(lease.requestStopCount, 1, "reporting never repeats the owned termination");

    lease.markExited();
    lease.settle();
    await until(() => harness.manager.hasLiveProcesses() === false, "the late settlement");
    // A repeated LIVE shutdown after settlement (before disposal) still remembers it,
    // though the row is no longer a stop target and nothing is remaining.
    const settledLive = await harness.manager.shutdown({ graceMs: 40, killMs: 20 });
    assert.deepEqual(settledLive.forcedIds, [id]);
    assert.deepEqual(settledLive.remainingIds, []);
    assert.equal(lease.requestStopCount, 1, "a settled row is never re-terminated for reporting");
    await harness.manager.dispose();
    // After settlement and disposal the retained resource still remembers the force attempt.
    const settled = await harness.manager.shutdown();
    assert.deepEqual(settled.forcedIds, [id]);
    assert.deepEqual(settled.remainingIds, []);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a SIGTERM-only backend stop is not forced, while a PTY escalation still is", async () => {
  const harness = makeHarness("forced-pty-vs-backend");
  try {
    const gracefulId = await launchCodex(harness);
    const gracefulLease = lastLease(harness);
    const forcedPtyId = await launchCodex2(harness);
    const forcedPtyLease = lastLease(harness);
    const forcedPty = lastPty(harness);
    forcedPty.exitsOnSignal = "SIGKILL";
    // Settle both backends gracefully: neither reports a force attempt.
    gracefulLease.settle();
    forcedPtyLease.settle();
    const result = await harness.manager.shutdown({ graceMs: 40, killMs: 40 });
    assert.equal(forcedPty.killSignals.includes("SIGKILL"), true);
    assert.deepEqual(result.forcedIds, [forcedPtyId], "only the PTY escalation is forced");
    assert.equal(result.forcedIds.includes(gracefulId), false, "a SIGTERM-only backend is never forced");
    assert.deepEqual(result.remainingIds, []);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("one row's backend force attempt never taints another row, and a failed status read reports nothing", async () => {
  const harness = makeHarness("forced-row-fencing");
  try {
    const forcedId = await launchCodex(harness);
    const forcedLease = lastLease(harness);
    const otherId = await launchCodex2(harness);
    const otherLease = lastLease(harness);
    assert.notEqual(forcedLease, otherLease);
    forcedLease.forceEscalationAttempted = true;
    forcedLease.settle();
    otherLease.settle();
    const result = await harness.manager.shutdown({ graceMs: 40, killMs: 40 });
    assert.deepEqual(result.forcedIds, [forcedId]);
    assert.equal(result.forcedIds.includes(otherId), false);
    assert.deepEqual(result.remainingIds, []);
    // The disposed path reports from the same per-row evidence.
    await harness.manager.dispose();
    const disposed = await harness.manager.shutdown();
    assert.deepEqual(disposed.forcedIds, [forcedId]);
    otherLease.statusThrows = true;
    assert.deepEqual((await harness.manager.shutdown()).forcedIds, [forcedId]);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------- *
 * Stop with no TUI yet: the backend alone is still owned, live work      *
 * -------------------------------------------------------------------- */

test("a confirmed Stop of a row whose TUI does not exist yet retires its backend and unblocks its launch", async () => {
  const harness = makeHarness("stop-before-tui");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend exists");
    const lease = lastLease(harness);

    // A row this host does not have is still unavailable.
    assert.deepEqual(await harness.manager.stop("no-such-row", { confirmed: true }), { status: "unavailable", forced: false });

    // The row exists and is listed while its launch is still awaiting readiness, so a
    // host that learned its id (from onChange, as the owning host does) can stop it now.
    const id = harness.manager.list()[0]!.id;
    const stopping = harness.manager.stop(id, { confirmed: true });
    await until(() => lease.requestStopCount === 1, "the owned stop was requested");
    assert.equal(harness.abortSignals.length, 1, "the factory's signal was aborted too");
    assert.equal(harness.abortSignals[0]!.aborted, true);

    // THE unblock: the launch that was awaiting readiness is finished, and it was the
    // stop that finished it — not the backend's settlement, which has not happened.
    await created;
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");
    assert.equal(viewOf(harness.manager, id).error, LAUNCH_PREPARATION_ERROR);
    assert.equal(harness.spawned.length, 0, "a stopped row spawns no TUI");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true, "the stop barrier does not declare the backend gone");
    assert.equal(harness.manager.hasLiveProcesses(), true);
    assert.equal(harness.manager.closeError(id), false, "the stopped row keeps its unsettled backend");

    lease.settle();
    assert.deepEqual(await stopping, { status: "exited", forced: false }, "both components settled is the honest exit");

    // A readiness answer that arrives after all of this still spawns and renders nothing.
    lease.fulfillReady();
    await sleep(20);
    assert.equal(harness.spawned.length, 0, "a late readiness answer starts no child");
    assert.equal(harness.plans[0]!.tuiRenders.length, 0, "and renders no TUI");
    assert.equal(harness.manager.closeError(id), true, "settled means the row is finally removable");
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a failed owned row whose backend is still live is stoppable, and is not reported exited until it settles", async () => {
  const harness = makeHarness("stop-error-row");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend exists");
    const lease = lastLease(harness);
    lease.rejectReady();
    const id = await created;

    // The launch failed, the child did not: the row is an error row that still owns it.
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true);
    assert.deepEqual(await harness.manager.stop(id, { confirmed: false }), { status: "confirmation-required", forced: false });

    const stopping = harness.manager.stop(id, { confirmed: true });
    // The stop gives this already-retired-but-unsettled backend its settlement window;
    // it never re-signals it, and it never claims a settlement the proof has not made.
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true, "an unsettled backend is not gone because a stop ran");
    assert.equal(lease.requestStopCount, 1, "one exact owned stop request; retirement is idempotent");
    lease.settle();
    assert.deepEqual(await stopping, { status: "exited", forced: false });
    assert.equal(harness.manager.closeError(id), true);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a backend that exits as its readiness arrives never gains a TUI, and stays owned until it settles", async () => {
  const harness = makeHarness("ready-then-exit");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend exists");
    const lease = lastLease(harness);

    // The banner arrives, and the very next thing this child does is exit — before the
    // launch continuation that would have spawned its TUI can run.
    lease.fulfillReady();
    lease.markExited();
    const id = await created;

    assert.equal(harness.spawned.length, 0, "a TUI is never attached to an endpoint that is gone");
    assert.equal(harness.plans[0]!.tuiRenders.length, 0, "no TUI is ever rendered from it");
    assert.equal(lease.createTuiConnectionCount, 0, "its private connection material is never even read");
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");
    // An exit is not a settlement: the readers may still be open, so ownership stays.
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true, "an exited, unsettled backend is still owned");
    assert.equal(harness.manager.hasLiveProcesses(), true);
    assert.equal(harness.manager.closeError(id), false);

    lease.settle();
    await until(() => harness.manager.hasLiveProcesses() === false, "the settlement");
    assert.equal(harness.manager.closeError(id), true);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a Stop landing after the readiness helper returned but before the launch continues still spawns no TUI", async () => {
  const harness = makeHarness("stop-in-readiness-gap");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend exists");
    const lease = lastLease(harness);
    const id = harness.manager.list()[0]!.id;

    // Land a confirmed Stop in the remaining gap: after the helper proved this resource
    // and returned, and before the launch's own continuation runs.
    void lease.readiness.then(() => {
      queueMicrotask(() => queueMicrotask(() => {
        void harness.manager.stop(id, { confirmed: true });
      }));
    });
    lease.fulfillReady();

    assert.equal(await created, id);
    assert.equal(lease.createTuiConnectionCount, 0, "the private connection material is never read");
    assert.equal(harness.plans[0]!.tuiRenders.length, 0, "no TUI is rendered");
    assert.equal(harness.spawned.length, 0, "no TUI is spawned behind a stopped row");
    // The gap really was crossed: the helper's check saw a lease nobody had stopped, and
    // the launch's own recheck is what refused.
    assert.ok(lease.statusSnapshots.length >= 1, "the helper consulted this lease's own facts");
    assert.equal(lease.statusSnapshots[0]!.stopRequested, false, "nothing was stopped when the helper checked");
    assert.ok(lease.requestStopCount >= 1, "the row's Stop did land in that gap");
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true, "the stopped row still owns its backend");

    lease.settle();
    await until(() => harness.manager.hasLiveProcesses() === false, "the settlement");
    assert.equal(harness.spawned.length, 0, "and settlement afterwards starts nothing");
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a backend exit landing after the readiness helper returned but before the launch continues still spawns no TUI", async () => {
  const harness = makeHarness("exit-in-readiness-gap");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend exists");
    const lease = lastLease(harness);

    // The same gap, this time crossed by the child's own exit rather than by a Stop: no
    // manager flag and no row change moves, only this lease's own reported facts.
    void lease.readiness.then(() => {
      queueMicrotask(() => queueMicrotask(() => lease.markExited()));
    });
    lease.fulfillReady();

    const id = await created;
    assert.equal(lease.createTuiConnectionCount, 0, "the private connection material is never read");
    assert.equal(harness.plans[0]!.tuiRenders.length, 0, "no TUI is rendered");
    assert.equal(harness.spawned.length, 0, "no TUI is attached to an endpoint that just died");
    assert.ok(lease.statusSnapshots.length >= 2, "the helper and the launch each consulted the lease");
    assert.equal(lease.statusSnapshots[0]!.exitObserved, false, "the child was alive when the helper checked");
    assert.equal(lease.statusSnapshots.at(-1)!.exitObserved, true, "the launch's recheck saw the exit");
    assert.equal(viewOf(harness.manager, id).lifecycle, "error");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true, "an exited, unsettled backend stays owned");

    lease.settle();
    await until(() => harness.manager.hasLiveProcesses() === false, "the settlement");
    assert.equal(harness.manager.closeError(id), true);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a backend that settles after manager disposal completes that disposal's deferred per-row teardown", async () => {
  const harness = makeHarness("dispose-then-settle");
  try {
    const id = await launchCodex(harness);
    const lease = lastLease(harness);
    const surface = harness.manager.surface(id);
    assert.ok(surface, "a live row owns a terminal surface");
    let surfaceDisposes = 0;
    const disposeSurface = surface.dispose.bind(surface);
    surface.dispose = (): void => {
      surfaceDisposes += 1;
      disposeSurface();
    };

    // The TUI goes first, so no future PTY exit can ever finish this row's teardown.
    lastPty(harness).emitExit(0);
    assert.equal(surfaceDisposes, 0, "an exited TUI keeps its frozen frame while the backend lives");
    assert.equal(viewOf(harness.manager, id).hasLiveProcess, true);

    // A stop window that expires with the backend still unsettled reports the truth and
    // completes nothing it cannot prove.
    const shutdown = await harness.manager.shutdown({ graceMs: 30, killMs: 10 });
    assert.deepEqual(shutdown.remainingIds, [id], "an unsettled backend is still owned work");
    assert.equal(surfaceDisposes, 0, "an expired window never completes a teardown");

    await harness.manager.dispose();
    assert.equal(surfaceDisposes, 0, "disposal preserves the surface while the backend is unsettled");
    assert.equal(harness.manager.hasLiveProcesses(), true);

    // The last outstanding proof now arrives: it must finish the deferred cleanup, once.
    lease.settle();
    await until(() => harness.manager.hasLiveProcesses() === false, "the settlement clears liveness");
    assert.equal(surfaceDisposes, 1, "the deferred disposal ran exactly once");
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an observer that arrives only after its backend settled is offered nothing", async () => {
  let releaseObserver!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseObserver = resolve;
  });
  const harness = makeHarness("late-observer-after-settlement", { observerGate: gate });
  try {
    const id = await launchCodex(harness);
    const lease = lastLease(harness);
    assert.equal(harness.observers.length, 0, "the observer genuinely has not arrived yet");

    // The TUI stays live; only its backend ends. A source that qualifies ownership now
    // would be handed the credentials of a process that is already gone.
    lease.settle();
    await until(() => viewOf(harness.manager, id).hasLiveProcess === true && lease.status().settled, "the settled backend");
    releaseObserver();
    await until(() => harness.observers.length === 1, "the deferred observer arrives");
    const observer = lastObserver(harness);
    assert.deepEqual(observer.backendSources, [], "no backend qualification for a settled backend");
    assert.deepEqual(observer.events, [], "and nothing else was claimed about a run it joined late");

    harness.settleAll();
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a late observer is offered no capability once its run's capture generation has been invalidated", async () => {
  let releaseObserver!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseObserver = resolve;
  });
  const harness = makeHarness("late-observer-after-invalidate", { observerGate: gate });
  try {
    const id = await launchCodex(harness);
    const lease = lastLease(harness);
    assert.equal(harness.observers.length, 0, "the observer genuinely has not arrived yet");

    // The run is live and its capture is bound to the exact handle and incarnation. Then
    // this run's own observer retires the generation that capture was minted against —
    // which leaves the capture OBJECT in place, so "a capture exists" is not the fence.
    const capture = harness.manager.nativeStatusCapture(id);
    assert.ok(capture, "the live run owns a status capture");
    assert.deepEqual(capture!.invalidate(), { accepted: true }, "the invalidation lands on the current generation");

    // Only now does the deferred observer arrive. Its run is still this row's current,
    // unretired, activated run and the backend is still live — the retired CAPTURE
    // GENERATION is what must refuse it.
    releaseObserver();
    await until(() => harness.observers.length === 1, "the deferred observer arrives");
    const observer = lastObserver(harness);
    assert.deepEqual(observer.backendSources, [], "no private capability on a retired capture generation");
    assert.deepEqual(observer.events, [], "and no other claim is made about the run");
    assert.equal(lease.readBearerCount, 0, "the observer bearer was never even read");
    assert.equal(lease.createTuiConnectionCount, 1, "the TUI itself was built earlier and is untouched");

    // A second invalidation attempt now reports the retired generation rather than
    // silently succeeding, which is the same fence the delivery used.
    assert.deepEqual(capture!.invalidate(), { accepted: false, code: "retired-capture" });

    // The row keeps running with both processes owned and unstopped.
    assert.equal(viewOf(harness.manager, id).lifecycle, "alive");
    assert.equal(lease.requestStopCount, 0);
    harness.settleAll();
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- *
 * Refusals, absence, and the unchanged legacy paths                           *
 * -------------------------------------------------------------------------- */

test("the typed owned-profile refusal reaches one fixed sanitized row error with zero resources", async () => {
  const harness = makeHarness("profile-refusal", {
    provider: () => {
      throw new NativeCodexOwnedProfileUnsupportedError();
    },
  });
  try {
    const id = await createCodex(harness);
    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "error");
    // One fixed existing message: no profile name, path, argument, or exception text.
    assert.equal(view.error, LAUNCH_PREPARATION_ERROR);
    assert.equal(harness.factoryRequests.length, 0, "no backend was ever created");
    assert.equal(harness.spawned.length, 0, "no TUI was ever created");
    assert.equal(harness.leases.length, 0);
    assert.equal(harness.manager.hasLiveProcesses(), false);
    assert.equal(harness.manager.closeError(id), true, "a refusal that owns nothing is removable");
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an owned plan this host has no factory for is refused before any child of any kind", async () => {
  const harness = makeHarness("plan-without-factory", { factory: "absent" });
  try {
    const id = await createCodex(harness);
    const view = viewOf(harness.manager, id);
    assert.equal(view.lifecycle, "error");
    assert.equal(view.error, LAUNCH_PREPARATION_ERROR);
    assert.equal(harness.spawned.length, 0, "no standalone fallback TUI is ever spawned");
    assert.equal(harness.manager.hasLiveProcesses(), false);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a factory answer with a foreign identity is refused and never leads to a TUI", async () => {
  const harness = makeHarness("foreign-lease", {
    factoryImpl: (request) => {
      harness.factoryRequests.push(request);
      // Same shape, foreign identity: it can never be this row's lease.
      return new FakeBackendLease({ leaseId: `${request.identity.leaseId}-foreign`, generation: 99 });
    },
  });
  try {
    const id = await createCodex(harness);
    assert.equal(harness.spawned.length, 0, "a foreign lease never leads to a TUI");
    assert.equal(viewOf(harness.manager, id).error, LAUNCH_PREPARATION_ERROR);
    assert.equal(harness.manager.hasLiveProcesses(), false);
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a present but unusable owned Codex plan is refused, and never becomes the standalone fallback", async () => {
  // Absence is the ordinary launch. A PRESENT value this manager cannot consume is a
  // provider that claimed an owned Codex launch and attached something broken to it, and
  // the only two honest answers are "refuse" or "lie". Every shape below must refuse.
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["a string", "owned"],
    ["an empty object", {}],
    ["no renderTui", { renderBackend: () => ({}), backendEnv: {} }],
    ["no renderBackend", { renderTui: () => ({}), backendEnv: {} }],
    ["renderers are not functions", { renderBackend: "render", renderTui: 0, backendEnv: {} }],
    ["null backendEnv", { renderBackend: () => ({}), renderTui: () => ({}), backendEnv: null }],
    ["array backendEnv", { renderBackend: () => ({}), renderTui: () => ({}), backendEnv: [] }],
  ];
  for (const [label, plan] of malformed) {
    const harness = makeHarness(`malformed-plan-${label.replace(/[^a-z]/gi, "-")}`, {
      provider: (backend, request) => ({
        file: "/synthetic/bin/codex",
        args: ["--interactive"],
        env: { PATH: "/synthetic/bin" },
        cwd: request.workspace,
        ownedCodex: plan as unknown as NativeCodexOwnedLaunchPlan,
      }),
    });
    try {
      const id = await createCodex(harness);
      assert.equal(viewOf(harness.manager, id).lifecycle, "error", `${label}: refused`);
      // One fixed, sanitized existing lane: no field name, value, path, or provider text.
      assert.equal(viewOf(harness.manager, id).error, LAUNCH_PREPARATION_ERROR, `${label}: fixed error`);
      assert.equal(harness.factoryRequests.length, 0, `${label}: the backend factory is never called`);
      assert.equal(harness.spawned.length, 0, `${label}: no standalone fallback TUI`);
      assert.equal(harness.plans.length, 0, `${label}: nothing is rendered`);
      assert.equal(harness.manager.hasLiveProcesses(), false, `${label}: zero resources`);
      // And nothing was ever published: no capability, no bearer, no source.
      assert.equal(lastObserver(harness).backendSources.length, 0, `${label}: no capability publication`);
      assert.equal(harness.leases.length, 0, `${label}: no lease was ever created`);
      await harness.manager.dispose();
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  }

  // The contrast that makes this a scope claim, in the same harness: a descriptor that
  // says NOTHING about an owned plan is still the unchanged standalone launch — one TUI,
  // spawned verbatim, with no backend and no refusal.
  const absent = makeHarness("owned-plan-absent-contrast", {
    provider: (backend, request) => ({
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
    }),
  });
  try {
    const id = await createCodex(absent);
    assert.equal(absent.factoryRequests.length, 0, "absence never reaches the backend factory");
    assert.equal(absent.spawned.length, 1, "absence is still exactly one standalone TUI");
    assert.deepEqual(absent.spawned[0]!.spawnDescriptor.args, ["--interactive"], "spawned verbatim");
    assert.equal(viewOf(absent.manager, id).lifecycle, "alive");
    await absent.manager.dispose();
  } finally {
    rmSync(absent.root, { recursive: true, force: true });
  }
});

test("a Windows batch plan's rendered command line reaches the pinned spawn verbatim with empty argv", async () => {
  const harness = makeHarness("windows-batch");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend exists");
    const plan = harness.plans[0]!;
    plan.batchTui = {
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [],
      commandLine: "/d /s /v:off /c \"C:\\tools\\codex.cmd --remote ws://127.0.0.1:54321\"",
    };
    lastLease(harness).fulfillReady();
    await created;

    const pty = lastPty(harness);
    assert.equal(pty.spawnDescriptor.file, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(pty.spawnDescriptor.args, [], "argv stays empty for a batch child");
    assert.equal(pty.spawnDescriptor.commandLine, plan.batchTui.commandLine, "the literal command line is delivered verbatim");
    harness.settleAll();
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a SessionSpawn whose owned backend readiness is refused before any TUI is unknown, and its prompt file waits for backend settlement (#493)", async () => {
  const harness = makeHarness("spawn-ready-rejected");
  try {
    const service = createLocalOwningHostService({
      createManager: () => harness.manager,
      teardownRequested: () => false,
    });
    service.openManager({} as Parameters<typeof service.openManager>[0]);
    const parentId = await harness.manager.create({ workspace: harness.workspace });
    assert.equal(viewOf(harness.manager, parentId).lifecycle, "alive", "a live Pi parent requests the spawn");
    const prompt = "exact startup prompt\r\nwith ünicode 😀";

    const outcome = service.spawnRequestedChild(parentId, {
      workspace: harness.workspace, title: "Spawned Codex", prompt, kind: "codex",
    });
    await until(() => harness.factoryRequests.length === 1, "the owned backend exists");
    const instruction = harness.providerCalls.at(-1)?.initialPrompt?.instruction ?? "";
    const quoted = /"(?:[^"\\]|\\.)*"/u.exec(instruction);
    assert.ok(quoted, "the provider received the generated instruction only");
    const path = JSON.parse(quoted[0]) as string;
    assert.equal(decodeNativeInitialPromptFile(readFileSync(path, "utf8")), prompt);
    const lease = lastLease(harness);
    lease.rejectReady();

    assert.equal(await outcome, "unknown",
      "an errored launch that still owns its backend is never reported as a started session");
    const childId = harness.manager.list().find((row) => row.id !== parentId)?.id ?? "";
    assert.equal(viewOf(harness.manager, childId).lifecycle, "error");
    assert.equal(viewOf(harness.manager, childId).hasLiveProcess, true, "readiness rejection is not settlement");
    assert.equal(harness.spawned.length, 1, "only the parent ever had a PTY: no TUI was spawned");
    assert.equal(harness.factoryRequests.length, 1, "nothing was retried");
    assert.ok(existsSync(path), "the unsettled backend keeps the owned prompt file");

    lease.settle();
    await until(() => !existsSync(path), "the backend's own settlement releases the prompt file");
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a descriptor with no plan is the unchanged standalone launch, and Claude and Pi never see the factory", async () => {
  const harness = makeHarness("legacy-shapes", {
    provider: (backend, request) => ({
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin" },
      cwd: request.workspace,
    }),
  });
  try {
    const codexId = await createCodex(harness);
    const claudeId = await harness.manager.create({ workspace: harness.workspace, backend: "claude" });
    const piId = await harness.manager.create({ workspace: harness.workspace });

    assert.equal(harness.factoryRequests.length, 0, "no plan means no backend for any backend");
    assert.equal(harness.spawned.length, 3);
    assert.deepEqual(harness.spawned[0]!.spawnDescriptor.args, ["--interactive"], "the ordinary descriptor is applied verbatim");
    assert.equal(viewOf(harness.manager, codexId).lifecycle, "alive");
    assert.equal(viewOf(harness.manager, claudeId).lifecycle, "alive");
    assert.equal(viewOf(harness.manager, piId).lifecycle, "alive");
    assert.deepEqual(harness.piRegistrar.requests, [piId], "only the Pi row is registered");
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an owned Codex restore intent reaches the provider, the backend factory, and the observer context as private metadata only", async () => {
  const harness = makeHarness("resume-intent");
  const resumeId = "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
  try {
    const created = harness.manager.create({ workspace: harness.workspace, backend: "codex", nativeResumeConversationId: resumeId } as CreateInstanceOptions);
    await until(() => harness.factoryRequests.length === 1, "the backend factory runs");
    const canonical = realpathSync(harness.workspace);
    assert.equal(harness.providerCalls[0]?.resumeConversationId, resumeId, "the provider receives the private intent");
    const request = harness.factoryRequests[0]!;
    assert.equal(request.workspace, canonical, "the factory receives the row's canonical workspace");
    assert.equal(request.resumeConversationId, resumeId, "the factory receives the private intent");
    assert.equal(harness.observers[0]?.context.resumeConversationId, resumeId);
    assert.equal(harness.observers[0]?.context.workspace, canonical);
    lastLease(harness).fulfillReady();
    const id = await created;
    // The rendered TUI argv is exactly the fresh owned argv: nothing here adds a resume argument.
    assert.deepEqual(lastPty(harness).spawnDescriptor.args, [
      "--interactive",
      "--remote", SYNTHETIC_ENDPOINT,
      "--remote-auth-token-env", SYNTHETIC_AUTH_ENV,
    ]);
    assert.equal(JSON.stringify(harness.manager.list()).includes(resumeId), false, "the intent never reaches a public view");
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "codex", conversationId: resumeId });
    lastPty(harness).emitExit(0);
    harness.settleAll();
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("a fresh owned Codex launch forwards its canonical workspace and no resume intent", async () => {
  const harness = makeHarness("fresh-workspace");
  try {
    const created = createCodex(harness);
    await until(() => harness.factoryRequests.length === 1, "the backend factory runs");
    const request = harness.factoryRequests[0]!;
    assert.equal(request.workspace, realpathSync(harness.workspace));
    assert.equal("resumeConversationId" in request, false);
    assert.equal("resumeConversationId" in harness.providerCalls[0]!, false);
    lastLease(harness).fulfillReady();
    const id = await created;
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "codex" });
    lastPty(harness).emitExit(0);
    harness.settleAll();
    await harness.manager.dispose();
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});
