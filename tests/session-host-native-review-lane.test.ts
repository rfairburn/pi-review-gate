import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstanceManagerOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunch,
  type NativeCliLaunchDescriptor,
  type NativeCliLaunchRequest,
  type NativeReviewCoordinatorHandle,
  type NativeReviewLaneOwner,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
  type StatusRegistrar,
} from "../src/session-host/instances";
import type {
  NativeHookSourceHandlers,
  NativeReviewRegistration,
  NativeReviewSourceHandlers,
} from "../src/session-host/broker";
import {
  NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV,
  type NativeReviewBootstrap,
  type NativeReviewRequest,
  type NativeReviewVerdict,
} from "../src/session-host/native-review-hook-protocol";
import { isClaudeReadOnlyTool } from "../src/session-host/native-review-tool-classifier";
import type { NativeHookBootstrap, NativeHookEvent } from "../src/session-host/native-hook-protocol";
import type { NativeCliBackend } from "../src/session-host/session-backend";

/**
 * Focused coverage of the OPTIONAL automatic review lane of `InstanceManager`
 * (#736 slice 3b).
 *
 * EVIDENCE SCOPE: synthetic PTYs, an injected fake launch provider, one fake
 * broker registrar shaped like the real broker's TWO native families (observer
 * hooks plus review), and a fake review-coordinator factory. No provider binary,
 * relay, reviewer, or real broker runs; this proves the manager's arming,
 * forwarding, retirement, degradation, and private-directory ownership.
 */

const UUID_A = "4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

class SpyPty implements InstancePty {
  static #nextPid = 820_000;
  readonly pid: number;
  cols: number;
  rows: number;
  exited = false;
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = SpyPty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
  }

  onData(_listener: (data: string) => void): { dispose(): void } { return { dispose: () => undefined }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => undefined };
  }
  on(_eventName: "error", _listener: (error: Error) => void): void { /* unused */ }
  removeListener(_eventName: "error", _listener: (error: Error) => void): void { /* unused */ }
  write(_data: string | Buffer): void { /* unused */ }
  resize(_cols: number, _rows: number): void { /* unused */ }
  pause(): void { /* unused */ }
  resume(): void { /* unused */ }
  kill(signal?: string): void {
    if (!this.exited && (signal ?? "SIGHUP") === "SIGTERM") this.emitExit(15);
  }
  emitExit(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode });
  }
}

class RecordingPiRegistrar implements StatusRegistrar {
  register(instanceId: string, _handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/pi/${instanceId}.sock`,
        token: randomBytes(32).toString("hex"),
        instanceId,
        generation: randomUUID(),
      },
      release: () => undefined,
    };
  }
}

class SpyObserver implements NativeStatusObserver {
  readonly hooks: NativeHookEvent[] = [];
  disposed = false;
  constructor(readonly context: NativeStatusObserverContext) {}
  acceptHook(event: NativeHookEvent): void { this.hooks.push(event); }
  acceptFailure(): void { /* unused */ }
  dispose(): void { this.disposed = true; }
}

/** The staged review plugin directory this fake provider hands the manager. */
class SpyReviewLease {
  cleanupCount = 0;
  readonly root = "/synthetic/review-root";
  cleanup(): Promise<unknown> {
    this.cleanupCount += 1;
    return Promise.resolve({ removed: [this.root], preserved: [] });
  }
}

interface FakeReviewSource {
  readonly instanceId: string;
  readonly backend: NativeCliBackend;
  readonly handlers: NativeReviewSourceHandlers;
  releaseCount: number;
}

/**
 * One fake broker object implementing BOTH native families the way the production
 * broker does: `registerNativeHookSource` for the observe-only lane and
 * `registerNativeReviewSource` for the blocking review lane, on one endpoint.
 */
class FakeBrokerRegistrar {
  readonly hookHandlers = new Map<string, NativeHookSourceHandlers>();
  readonly reviewSources: FakeReviewSource[] = [];
  reviewMode: "ok" | "throw" | "foreign" | "no-bootstrap" | "null-bootstrap" | "malformed-bootstrap" = "ok";

  registerNativeHookSource(instanceId: string, backend: NativeCliBackend, handlers: NativeHookSourceHandlers) {
    this.hookHandlers.set(instanceId, handlers);
    const bootstrap: NativeHookBootstrap = {
      version: 1,
      socketPath: `/synthetic/native/${instanceId}.sock`,
      generation: randomUUID(),
      instanceId,
      backend,
      token: randomBytes(32).toString("hex"),
    };
    return { bootstrap, release: () => undefined };
  }

  registerNativeReviewSource(
    instanceId: string,
    backend: NativeCliBackend,
    handlers: NativeReviewSourceHandlers,
  ): NativeReviewRegistration {
    if (this.reviewMode === "throw") throw new Error("synthetic review registrar refusal");
    const source: FakeReviewSource = { instanceId, backend, handlers, releaseCount: 0 };
    this.reviewSources.push(source);
    const bootstrap: NativeReviewBootstrap = {
      version: 1,
      socketPath: `/synthetic/native/${instanceId}.sock`,
      generation: randomUUID(),
      instanceId: this.reviewMode === "foreign" ? randomUUID() : instanceId,
      backend,
      token: randomBytes(32).toString("hex"),
    };
    // A registration whose bootstrap the manager must refuse on its own terms: absent,
    // null, or shaped like this row's but with a token or socket no relay could ever use.
    const handed = this.reviewMode === "no-bootstrap"
      ? {}
      : this.reviewMode === "null-bootstrap"
        ? { bootstrap: null }
        : this.reviewMode === "malformed-bootstrap"
          ? { bootstrap: { ...bootstrap, token: "not-a-64-hex-token", socketPath: "relative.sock" } }
          : { bootstrap };
    return {
      ...(handed as { bootstrap: NativeReviewBootstrap }),
      release: () => { source.releaseCount += 1; },
    };
  }
}

/** A coordinator handle whose every call the test observes. */
class SpyReviewHandle implements NativeReviewCoordinatorHandle {
  readonly requests: { request: NativeReviewRequest; signal: AbortSignal }[] = [];
  readonly activity: { sessionId: string; toolName: string; readOnly: boolean }[] = [];
  disposeCount = 0;
  /** When set, `dispose()` waits on this gate, so the test drives the settle order. */
  disposeGate: Promise<void> | undefined;
  verdict: NativeReviewVerdict = { action: "allow" };

  async onReviewRequest(request: NativeReviewRequest, signal: AbortSignal): Promise<NativeReviewVerdict> {
    this.requests.push({ request, signal });
    return this.verdict;
  }

  noteToolActivity(sessionId: string, activity: { toolName: string; readOnly: boolean }): void {
    this.activity.push({ sessionId, toolName: activity.toolName, readOnly: activity.readOnly });
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    if (this.disposeGate !== undefined) await this.disposeGate;
  }
}

interface Harness {
  root: string;
  agentDir: string;
  workspace: string;
  manager: InstanceManager;
  registrar: FakeBrokerRegistrar;
  observers: Map<string, SpyObserver>;
  spawned: SpyPty[];
  providerCalls: NativeCliLaunchRequest[];
  creates: { rowId: string; backend: NativeCliBackend; workspace: string; checkpointAgentDir: string }[];
  handles: SpyReviewHandle[];
  leases: SpyReviewLease[];
  reviewOutcome: "prepared" | "unavailable" | "silent";
  setCreate(next: NativeReviewLaneOwner["create"] | undefined): void;
  /** The provider calls this harness is holding open, in the order they were made. */
  readonly gatedCalls: number;
  /** Release one held provider call so its descriptor finally reaches the manager. */
  releaseGated(index?: number): void;
}

interface HarnessOptions {
  reviewLane?: "on" | "off";
  /** What the fake factory answers: a handle, `undefined` (toggle off), or a throw. */
  create?: "handle" | "undefined" | "throw";
  /** Make the private directory creation fail. */
  breakDirectory?: boolean;
  /** What the provider answers a review-armed request with. */
  reviewOutcome?: "prepared" | "unavailable" | "silent";
  /**
   * Hold every provider call open on a gate the test controls, so a fulfillment can be
   * delivered AFTER this row was stopped — the only way to prove a late descriptor's
   * staged files are still adopted and released exactly once.
   */
  gateProvider?: boolean;
}

function makeHarness(label: string, options: HarnessOptions = {}): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `prg-native-review-lane-${label}-`)));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic fixture; never executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic fixture.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic fixture.\n", "utf8");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n// Synthetic inert fixture.\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  for (const dir of [home, agentDir, workspace]) mkdirSync(dir, { recursive: true, mode: 0o755 });
  // The agent directory is the OUTERMOST level of a review lane's ownership chain, so
  // its protection is asserted, not assumed. A process umask of 002 would otherwise make
  // every fixture here model a group-writable Pi directory, which the chain rule refuses;
  // the mode is set outright so the fixture says what a real `~/.pi/agent` says.
  if (process.platform !== "win32") {
    for (const dir of [home, agentDir, workspace]) chmodSync(dir, 0o755);
  }
  if (options.breakDirectory === true) {
    // The lane's parent becomes a symlink standing where a real directory must be:
    // the store rules refuse it, exactly as they refuse one to the roster store.
    const stateDir = join(agentDir, "session-host");
    mkdirSync(stateDir, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(stateDir, "native-review"), process.platform === "win32" ? "junction" : "dir");
  }

  const registrar = new FakeBrokerRegistrar();
  const observers = new Map<string, SpyObserver>();
  const spawned: SpyPty[] = [];
  const providerCalls: NativeCliLaunchRequest[] = [];
  const creates: Harness["creates"] = [];
  const handles: SpyReviewHandle[] = [];
  const leases: SpyReviewLease[] = [];
  let reviewOutcome = options.reviewOutcome ?? "prepared";
  /** One gated provider call, held until the test hands it its descriptor. */
  interface GatedCall {
    readonly request: NativeCliLaunchRequest;
    readonly descriptor: unknown;
    resolve(): void;
  }
  const gated: GatedCall[] = [];
  const releaseGate = (index: number): void => { gated[index]?.resolve(); };
  let create: NativeReviewLaneOwner["create"] | undefined = (input) => {
    creates.push(input);
    if (options.create === "undefined") return undefined;
    if (options.create === "throw") throw new Error("synthetic coordinator factory refusal");
    const handle = new SpyReviewHandle();
    handles.push(handle);
    return handle;
  };

  const provider: NativeCliLaunch = (backend, request) => {
    const seen: NativeCliLaunchRequest = { ...request, env: {} };
    providerCalls.push(seen);
    let nativeReview: unknown;
    if (request.nativeReview !== undefined) {
      if (reviewOutcome === "prepared") {
        const lease = new SpyReviewLease();
        leases.push(lease);
        nativeReview = { review: "prepared", backend, route: "claude-plugin-dir", args: ["--plugin-dir", "/synthetic/plugin"], environment: {}, lease };
      } else if (reviewOutcome === "unavailable") {
        nativeReview = { review: "unavailable", backend, reason: "artifact-staging-failed" };
      }
    }
    const descriptor = {
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin", HOME: home },
      cwd: request.workspace,
      ...(nativeReview === undefined ? {} : { nativeReview }),
    } as NativeCliLaunchDescriptor;
    if (options.gateProvider === true) {
      return new Promise<NativeCliLaunchDescriptor>((resolve) => {
        gated.push({ request: seen, descriptor, resolve: () => resolve(descriptor) });
      });
    }
    return descriptor;
  };

  const options_: InstanceManagerOptions = {
    packageRoot,
    piExecutable,
    statusRegistrar: new RecordingPiRegistrar(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    nativeCliLaunch: (backend, request) => provider(backend, request),
    nativeHookRegistrar: registrar,
    nativeStatusObserverFactory: (context: NativeStatusObserverContext) => {
      const observer = new SpyObserver(context);
      observers.set(context.rowId, observer);
      return observer;
    },
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      spawned.push(pty);
      return pty;
    },
    ...(options.reviewLane === "off" ? {} : { nativeReviewLane: { create: (input) => create?.(input) } }),
  };
  let manager: InstanceManager;
  try {
    manager = new InstanceManager(options_);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    agentDir,
    workspace,
    manager,
    registrar,
    observers,
    spawned,
    providerCalls,
    creates,
    handles,
    leases,
    get reviewOutcome() { return reviewOutcome; },
    set reviewOutcome(next: Harness["reviewOutcome"]) { reviewOutcome = next; },
    setCreate: (next) => { create = next; },
    get gatedCalls() { return gated.length; },
    releaseGated: (index = 0) => { releaseGate(index); },
  };
}

async function withHarness(
  label: string,
  body: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  const harness = makeHarness(label, options);
  try {
    await body(harness);
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
}

const settle = async (): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
const settleMany = async (n = 4): Promise<void> => { for (let i = 0; i < n; i += 1) await settle(); };

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for: ${what}`);
    await settle();
  }
}

async function createClaude(harness: Harness): Promise<string> {
  return harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
}

async function createCodex(harness: Harness): Promise<string> {
  return harness.manager.create({ workspace: harness.workspace, backend: "codex" } as CreateInstanceOptions);
}

function reviewSourceFor(harness: Harness, id: string): FakeReviewSource {
  const source = harness.registrar.reviewSources.find((candidate) => candidate.instanceId === id);
  assert.ok(source, "the row registered exactly one native review source");
  return source;
}

/** The private directory this manager should have created for one row. */
function reviewDirFor(harness: Harness, rowId: string): string {
  const digest = createHash("sha256").update(rowId, "utf8").digest("hex");
  return join(harness.agentDir, "session-host", "native-review", digest);
}

const hook = (fields: Record<string, unknown>): NativeHookEvent => ({ backend: "claude", ...fields }) as unknown as NativeHookEvent;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test("construction refuses a review lane without the status pair, without a factory, or without the review family", () => {
  const harness = makeHarness("construction");
  try {
    const base = {
      packageRoot: join(harness.root, "package"),
      piExecutable: join(harness.root, "bin", "mock-pi"),
      statusRegistrar: new RecordingPiRegistrar(),
      // The harness's own agent directory: without it construction resolves the
      // runner's real ~/.pi/agent, which a CI machine does not have, and fails
      // before the review-lane checks this test is about.
      env: { PATH: "/bin", PI_CODING_AGENT_DIR: harness.agentDir },
      args: [],
    } as unknown as InstanceManagerOptions;
    assert.throws(
      () => new InstanceManager({ ...base, nativeReviewLane: { create: () => undefined } }),
      /nativeReviewLane requires the nativeHookRegistrar\/nativeStatusObserverFactory pair/,
    );
    const pair = {
      nativeHookRegistrar: { registerNativeHookSource: () => ({ bootstrap: {}, release: () => undefined }) },
      nativeStatusObserverFactory: () => ({}),
    } as unknown as InstanceManagerOptions;
    assert.throws(
      () => new InstanceManager({ ...base, ...pair, nativeReviewLane: {} as never }),
      /nativeReviewLane\.create must be a function/,
    );
    assert.throws(
      () => new InstanceManager({ ...base, ...pair, nativeReviewLane: { create: () => undefined } }),
      /requires a registrar that provides registerNativeReviewSource/,
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

test("a Claude row with a toggle-on factory arms one lane, registers it, and hands the provider its bootstrap", async () => {
  await withHarness("arm", async (harness) => {
    const id = await createClaude(harness);
    assert.equal(harness.creates.length, 1, "the factory is consulted once for the row");
    const created = harness.creates[0]!;
    assert.equal(created.rowId, id);
    assert.equal(created.backend, "claude");
    assert.equal(created.workspace, harness.workspace);
    assert.equal(created.checkpointAgentDir, reviewDirFor(harness, id));
    assert.ok(existsSync(created.checkpointAgentDir), "the lane's private directory exists before the child does");
    if (process.platform !== "win32") {
      assert.equal(statSync(created.checkpointAgentDir).mode & 0o777, 0o700, "the private directory is private");
    } else {
      // Windows protects this directory with a private DACL, not with a POSIX mode bit,
      // so the claim checked here is the one that platform can actually answer.
      assert.ok(statSync(created.checkpointAgentDir).isDirectory(), "the private directory exists");
    }
    assert.equal(harness.registrar.reviewSources.length, 1);
    assert.equal(reviewSourceFor(harness, id).backend, "claude");
    const request = harness.providerCalls.find((call) => call.nativeHook !== undefined)!;
    assert.ok(request.nativeReview !== undefined, "the launch request carries the review option");
    assert.equal(request.nativeReview!.bootstrap.instanceId, id);
    assert.equal(request.nativeReview!.bootstrap.backend, "claude");
    assert.equal(request.nativeReview!.bootstrap.version, 1);
    assert.equal(harness.providerCalls.length, 1);
  });
});

test("the review bootstrap is a SEPARATE family from the observer bootstrap of the same row", async () => {
  await withHarness("families", async (harness) => {
    const id = await createClaude(harness);
    const request = harness.providerCalls[0]!;
    assert.ok(request.nativeHook !== undefined && request.nativeReview !== undefined);
    assert.notEqual(request.nativeHook!.bootstrap.token, request.nativeReview.bootstrap.token);
    assert.notEqual(request.nativeHook!.bootstrap.generation, request.nativeReview.bootstrap.generation);
  });
});

test("a Codex row arms its lane and gains the option with the host's stable private hook directory", {
  skip: process.platform === "win32" ? "POSIX mode assertion" : false,
}, async () => {
  await withHarness("codex", async (harness) => {
    const id = await createCodex(harness);
    assert.equal(harness.creates.length, 1, "the factory is consulted for an owned-capable Codex row");
    assert.equal(harness.creates[0]!.backend, "codex");
    assert.equal(typeof (harness.creates[0] as { backgroundCensus?: unknown }).backgroundCensus, "function",
      "the lane owner can read this run's current background census");
    assert.equal(harness.registrar.reviewSources.length, 1);
    const option = harness.providerCalls[0]!.nativeReview as { bootstrap: { backend: string }; codexHookDirectory?: string } | undefined;
    assert.equal(option?.bootstrap.backend, "codex");
    const expected = join(harness.agentDir, "session-host", "native-review", "codex-hook");
    assert.equal(option?.codexHookDirectory, realpathSync(expected), "the one stable directory every Codex row shares");
    assert.equal(statSync(expected).mode & 0o777, 0o700, "and it is private");
    assert.equal(harness.providerCalls[0]!.nativeHook !== undefined, true, "its own status source is untouched");
    await harness.manager.dispose();
    assert.equal(existsSync(reviewDirFor(harness, id)), false, "the row's own lane directory goes with it");
    assert.ok(existsSync(expected), "retiring a lane never removes the shared stable hook directory");
  });
});

test("a Codex lane's background census is the row's observed active task and shell counts", async () => {
  // Live acceptance: reading the host's ownership pair left every Codex Stop
  // "unknown", because native observations carry no ownership count.
  await withHarness("codex-census", async (harness) => {
    const id = await createCodex(harness);
    const census = (harness.creates[0] as unknown as { backgroundCensus: () => { tasks: number | null; shells: number | null } }).backgroundCensus;
    assert.deepEqual(census(), { tasks: null, shells: null }, "nothing observed yet is unknown");
    harness.observers.get(id)!.context.emit({ busy: true, activeTasks: 1, activeShells: 2 });
    assert.deepEqual(census(), { tasks: 1, shells: 2 });
    harness.observers.get(id)!.context.emit({ busy: false, activeTasks: 0, activeShells: 0 });
    assert.deepEqual(census(), { tasks: 0, shells: 0 }, "read fresh, as the sidebar shows it");
  });
});

test("an owned Codex run's root tool activity reaches only its own review lane, classified by category", async () => {
  await withHarness("codex-activity", async (harness) => {
    const id = await createCodex(harness);
    const context = harness.observers.get(id)!.context;
    assert.equal(typeof context.emitRootToolActivity, "function", "the run offers the owned consumer an activity channel");
    context.emitRootToolActivity!("thread-1", "file-change");
    context.emitRootToolActivity!("thread-1", "web-search");
    context.emitRootToolActivity!("", "command");
    assert.deepEqual(harness.handles[0]!.activity, [
      { sessionId: "thread-1", toolName: "file-change", readOnly: false },
      { sessionId: "thread-1", toolName: "web-search", readOnly: true },
    ]);
    harness.handles[0]!.noteToolActivity = () => { throw new Error("synthetic coordinator failure"); };
    assert.doesNotThrow(() => context.emitRootToolActivity!("thread-1", "command"), "a throwing coordinator is contained");
  });
});

test("a manager without the lane option arms nothing and its launch request is byte-unchanged", async () => {
  await withHarness("unwired", async (harness) => {
    const id = await createClaude(harness);
    assert.equal(harness.creates.length, 0);
    assert.equal(harness.registrar.reviewSources.length, 0);
    assert.equal(harness.providerCalls[0]!.nativeReview, undefined);
    assert.equal(existsSync(join(harness.agentDir, "session-host", "native-review")), false);
    void id;
  }, { reviewLane: "off" });
});

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

test("the broker's review callback reaches this run's coordinator and answers with its verdict", async () => {
  await withHarness("forward", async (harness) => {
    const id = await createClaude(harness);
    const source = reviewSourceFor(harness, id);
    const handle = harness.handles[0]!;
    const request: NativeReviewRequest = { backend: "claude", event: "Stop", sessionId: "session-1", lastAssistantMessage: "text" };
    const signal = new AbortController().signal;
    const verdict = await source.handlers.onReviewRequest(request, signal);
    assert.deepEqual(verdict, { action: "allow" });
    assert.equal(handle.requests.length, 1);
    assert.equal(handle.requests[0]!.request, request, "the sanitized request travels verbatim");
    assert.equal(handle.requests[0]!.signal, signal);
    handle.verdict = { action: "block", reason: "because" };
    assert.deepEqual(await source.handlers.onReviewRequest(request, signal), { action: "block", reason: "because" });
  });
});

test("a retired lane answers its broker callback with a rejection the broker contains as `failed`", async () => {
  await withHarness("retired-callback", async (harness) => {
    const id = await createClaude(harness);
    const source = reviewSourceFor(harness, id);
    harness.spawned[0]!.emitExit(0);
    await until(() => harness.handles[0]!.disposeCount === 1, "the lane retired with the run");
    const request: NativeReviewRequest = { backend: "claude", event: "Stop", sessionId: "session-1" };
    await assert.rejects(
      () => source.handlers.onReviewRequest(request, new AbortController().signal),
      /native review lane is retired/,
    );
    assert.equal(harness.handles[0]!.requests.length, 0, "a dead lane never reaches its coordinator");
  });
});

// ---------------------------------------------------------------------------
// Retirement
// ---------------------------------------------------------------------------

test("the child's exit releases the registration, disposes the handle once, and removes the private directory", async () => {
  await withHarness("retire", async (harness) => {
    const id = await createClaude(harness);
    const source = reviewSourceFor(harness, id);
    const dir = reviewDirFor(harness, id);
    const lease = harness.leases[0]!;
    assert.ok(existsSync(dir));
    harness.spawned[0]!.emitExit(0);
    await until(() => source.releaseCount === 1, "the review registration was released");
    assert.equal(harness.handles[0]!.disposeCount, 1, "the coordinator was disposed exactly once");
    await until(() => !existsSync(dir), "the private directory went after disposal settled");
    harness.spawned[0]!.emitExit(0);
    await settleMany();
    assert.equal(source.releaseCount, 1, "retirement is idempotent");
    assert.equal(harness.handles[0]!.disposeCount, 1, "and so is the disposal");
    assert.equal(lease.cleanupCount, 1, "the staged review plugin directory is released once, with the other artifacts");
  });
});

test("a slow coordinator keeps manager disposal waiting, and its directory survives until it settles", async () => {
  await withHarness("slow-dispose", async (harness) => {
    const id = await createClaude(harness);
    const handle = harness.handles[0]!;
    const dir = reviewDirFor(harness, id);
    let release: () => void = () => undefined;
    handle.disposeGate = new Promise<void>((resolve) => { release = resolve; });
    harness.spawned[0]!.emitExit(0);
    await until(() => handle.disposeCount === 1, "disposal started");
    await settleMany();
    assert.ok(existsSync(dir), "the directory survives while the coordinator is still disposing");
    let disposed = false;
    const disposal = harness.manager.dispose().then(() => { disposed = true; });
    await settleMany(6);
    assert.equal(disposed, false, "manager disposal does not report done past an outstanding lane disposal");
    release();
    await disposal;
    await until(() => !existsSync(dir), "the directory goes once the coordinator settled");
  });
});

// ---------------------------------------------------------------------------
// Degradation: every failure means only "no review lane"
// ---------------------------------------------------------------------------

test("a factory that answers undefined (the host's toggle is off) registers nothing and adds no launch field", async () => {
  await withHarness("toggle-off", async (harness) => {
    const id = await createClaude(harness);
    assert.equal(harness.creates.length, 1, "the factory WAS consulted — it is the host that declined");
    assert.equal(harness.registrar.reviewSources.length, 0);
    assert.equal(harness.providerCalls[0]!.nativeReview, undefined, "the launch request is exactly the request it always was");
    assert.equal(harness.leases.length, 0);
    assert.equal(existsSync(reviewDirFor(harness, id)), false, "the directory this call made went back with the refusal");
    // The row itself is a normal, observed, running row.
    assert.ok(harness.observers.get(id) !== undefined);
    harness.registrar.hookHandlers.get(id)!.onEvent(hook({ hook_event_name: "SessionStart", session_id: "s-1" }));
    assert.equal(harness.observers.get(id)!.hooks.length, 1, "the status source still observes this row");
  }, { create: "undefined" });
});

test("a throwing factory, a throwing review registrar, and a foreign registration all leave the row intact", async () => {
  for (const mode of ["factory", "registrar", "foreign", "no-bootstrap"] as const) {
    const harness = makeHarness(`degrade-${mode}`, { create: mode === "factory" ? "throw" : "handle" });
    try {
      if (mode === "registrar") harness.registrar.reviewMode = "throw";
      if (mode === "foreign") harness.registrar.reviewMode = "foreign";
      if (mode === "no-bootstrap") harness.registrar.reviewMode = "no-bootstrap";
      const id = await createClaude(harness);
      assert.equal(harness.providerCalls[0]!.nativeReview, undefined, `${mode}: no review field reached the provider`);
      assert.ok(harness.spawned.length === 1, `${mode}: the row still spawned its child`);
      assert.ok(harness.observers.get(id) !== undefined, `${mode}: the status source is still armed`);
      harness.registrar.hookHandlers.get(id)!.onEvent(hook({ hook_event_name: "SessionStart", session_id: "s-1" }));
      assert.equal(harness.observers.get(id)!.hooks.length, 1, `${mode}: observation still lands`);
      if (mode === "registrar") {
        assert.equal(harness.handles.length, 1);
        await until(() => harness.handles[0]!.disposeCount === 1, `${mode}: the created handle was disposed`);
        assert.equal(existsSync(reviewDirFor(harness, id)), false, `${mode}: its directory went with it`);
      }
    } finally {
      await harness.manager.dispose();
      rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test("a refused private directory means no lane, and every other row behavior is unchanged", async () => {
  await withHarness("bad-dir", async (harness) => {
    const id = await createClaude(harness);
    assert.equal(harness.creates.length, 0, "the factory is never consulted without a usable directory");
    assert.equal(harness.handles.length, 0);
    assert.equal(harness.registrar.reviewSources.length, 0);
    assert.equal(harness.providerCalls[0]!.nativeReview, undefined);
    assert.ok(harness.spawned.length === 1, "the row still spawned");
    harness.registrar.hookHandlers.get(id)!.onEvent(hook({ hook_event_name: "SessionStart", session_id: "s-1" }));
    assert.equal(harness.observers.get(id)!.hooks.length, 1, "observation still lands");
  }, { breakDirectory: true });
});

test("a review preparation the provider declined drops ONLY the lane: status, launch, and lease all stand", async () => {
  await withHarness("prep-declined", async (harness) => {
    harness.reviewOutcome = "unavailable";
    const id = await createClaude(harness);
    const source = reviewSourceFor(harness, id);
    await until(() => source.releaseCount === 1, "the lane was dropped at the launch outcome");
    assert.equal(harness.handles[0]!.disposeCount, 1, "its coordinator was disposed");
    await until(() => !existsSync(reviewDirFor(harness, id)), "and its private directory removed");
    // The status run is NOT retired: the observer still receives authenticated events.
    harness.registrar.hookHandlers.get(id)!.onEvent(hook({ hook_event_name: "Stop", session_id: "s-1" }));
    assert.equal(harness.observers.get(id)!.hooks.length, 1, "the status source survived the declined review lane");
    assert.equal(harness.handles[0]!.requests.length, 0, "and no later request reaches the dead coordinator");
    assert.ok(harness.spawned[0] !== undefined && !harness.spawned[0]!.exited, "the child is untouched");
  });
});

test("a provider silent about a lane this manager armed drops the lane the same way", async () => {
  await withHarness("prep-silent", async (harness) => {
    harness.reviewOutcome = "silent";
    const id = await createClaude(harness);
    await until(() => reviewSourceFor(harness, id).releaseCount === 1, "the lane was dropped");
    harness.registrar.hookHandlers.get(id)!.onEvent(hook({ hook_event_name: "Stop", session_id: "s-1" }));
    assert.equal(harness.observers.get(id)!.hooks.length, 1, "the status source survived");
  });
});

// ---------------------------------------------------------------------------
// Root tool activity
// ---------------------------------------------------------------------------

test("root Claude post-tool activity is noted with the closed read-only classification; child scope is not", async () => {
  await withHarness("activity", async (harness) => {
    const id = await createClaude(harness);
    const handle = harness.handles[0]!;
    const onEvent = harness.registrar.hookHandlers.get(id)!.onEvent.bind(harness.registrar.hookHandlers.get(id)!);
    onEvent(hook({ hook_event_name: "PostToolUse", session_id: "s-1", tool_name: "Read" }));
    onEvent(hook({ hook_event_name: "PostToolUse", session_id: "s-1", tool_name: "Edit" }));
    onEvent(hook({ hook_event_name: "PostToolUseFailure", session_id: "s-1", tool_name: "Bash" }));
    onEvent(hook({ hook_event_name: "PostToolUse", session_id: "s-1", tool_name: "mcp__server__thing" }));
    onEvent(hook({ hook_event_name: "PostToolUse", session_id: "s-1", tool_name: "SomeNewTool" }));
    // Not root, not a post-tool event, or missing a usable name or session: never noted.
    onEvent(hook({ hook_event_name: "PostToolUse", session_id: "s-1", tool_name: "Read", agent_id: "child-1" }));
    onEvent(hook({ hook_event_name: "PreToolUse", session_id: "s-1", tool_name: "Read" }));
    onEvent(hook({ hook_event_name: "PostToolUse", session_id: "s-1" }));
    onEvent(hook({ hook_event_name: "PostToolUse", tool_name: "Read" }));
    assert.deepEqual(handle.activity, [
      { sessionId: "s-1", toolName: "Read", readOnly: true },
      { sessionId: "s-1", toolName: "Edit", readOnly: false },
      { sessionId: "s-1", toolName: "Bash", readOnly: false },
      { sessionId: "s-1", toolName: "mcp__server__thing", readOnly: false },
      { sessionId: "s-1", toolName: "SomeNewTool", readOnly: false },
    ]);
    for (const noted of handle.activity) {
      assert.equal(noted.readOnly, isClaudeReadOnlyTool(noted.toolName));
    }
  });
});

test("a throwing activity note cannot disturb the row, its delivery, or its observer", async () => {
  await withHarness("activity-throws", async (harness) => {
    const id = await createClaude(harness);
    const handle = harness.handles[0]!;
    handle.noteToolActivity = () => { throw new Error("synthetic coordinator failure"); };
    const observer = harness.observers.get(id)!;
    harness.registrar.hookHandlers.get(id)!.onEvent(hook({ hook_event_name: "PostToolUse", session_id: "s-1", tool_name: "Read" }));
    assert.equal(observer.hooks.length, 1, "the observer still received the event");
    assert.ok(harness.spawned[0] !== undefined && !harness.spawned[0]!.exited, "the row is unaffected");
  });
});

test("a row without a lane notes nothing and observes everything it always did", async () => {
  await withHarness("activity-no-lane", async (harness) => {
    const id = await createClaude(harness);
    harness.registrar.hookHandlers.get(id)!.onEvent(hook({ hook_event_name: "PostToolUse", session_id: "s-1", tool_name: "Read" }));
    assert.equal(harness.handles.length, 0);
    assert.equal(harness.observers.get(id)!.hooks.length, 1);
  }, { create: "undefined" });
});

// ---------------------------------------------------------------------------
// The private directory is owned by identity, never by its name
// ---------------------------------------------------------------------------

test("a checkpoint directory replaced while disposal is pending is preserved, not deleted", async () => {
  await withHarness("replaced-leaf", async (harness) => {
    const id = await createClaude(harness);
    const handle = harness.handles[0]!;
    const dir = reviewDirFor(harness, id);
    const marker = join(dir, "coordinator-checkpoint.json");
    writeFileSync(marker, "{}\n", "utf8");
    let release: () => void = () => undefined;
    handle.disposeGate = new Promise<void>((resolve) => { release = resolve; });

    harness.spawned[0]!.emitExit(0);
    await until(() => handle.disposeCount === 1, "disposal started");
    // Somebody else's directory now stands at this name, with a different inode. The
    // name is the same; the directory is not the one this manager created.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    const replacement = join(dir, "not-the-lanes-file");
    writeFileSync(replacement, "someone else's\n", "utf8");

    release();
    await until(() => existsSync(replacement) && handle.disposeCount === 1, "disposal settled");
    await settleMany(6);
    assert.ok(existsSync(replacement), "a replacement this manager never made is preserved, not removed");
    assert.equal(existsSync(marker), false, "the lane's own file was gone before the replacement anyway");
  });
});

test("a symlinked checkpoint parent is never deleted through, and its target survives", async () => {
  await withHarness("symlink-parent", async (harness) => {
    const id = await createClaude(harness);
    const handle = harness.handles[0]!;
    const dir = reviewDirFor(harness, id);
    const leafName = basename(dir);
    // The tree OUTSIDE this lane, holding a directory with the lane's own leaf name:
    // the exact shape that turns a name-only recursive delete into destroying
    // somebody else's files.
    const elsewhere = join(harness.root, "outside-target");
    const imposter = join(elsewhere, leafName);
    mkdirSync(imposter, { recursive: true });
    const outsideFile = join(imposter, "priceless.json");
    writeFileSync(outsideFile, "not yours\n", "utf8");

    let release: () => void = () => undefined;
    handle.disposeGate = new Promise<void>((resolve) => { release = resolve; });
    harness.spawned[0]!.emitExit(0);
    await until(() => handle.disposeCount === 1, "disposal started");

    // Replace the shared parent with a symlink to that outside tree, so the recorded
    // leaf path now resolves — by following the symlink — into files this manager
    // never created.
    rmSync(join(harness.agentDir, "session-host", "native-review"), { recursive: true, force: true });
    symlinkSync(
      elsewhere,
      join(harness.agentDir, "session-host", "native-review"),
      process.platform === "win32" ? "junction" : "dir",
    );

    release();
    await settleMany(10);
    assert.ok(existsSync(outsideFile), "a symlinked ancestor never turns this removal into a delete outside the lane");
    assert.ok(existsSync(imposter), "and the imposter directory itself is untouched");
  });
});

test("a world-readable checkpoint parent is refused at arming, and the row is unchanged", async () => {
  const harness = makeHarness("foreign-mode-parent");
  try {
    // A pre-existing `native-review` this manager did not create, with group and
    // world access: the lane refuses to arm inside it rather than repair or adopt it.
    const root = join(harness.agentDir, "session-host", "native-review");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);
    const id = await createClaude(harness);
    assert.equal(harness.creates.length, 0, "the factory is never consulted for a parent this lane cannot own");
    assert.equal(harness.registrar.reviewSources.length, 0);
    assert.equal(harness.providerCalls[0]!.nativeReview, undefined, "the launch request is the request it always was");
    assert.ok(harness.spawned.length === 1, "the row still spawned");
    harness.registrar.hookHandlers.get(id)!.onEvent(hook({ hook_event_name: "SessionStart", session_id: "s-1" }));
    assert.equal(harness.observers.get(id)!.hooks.length, 1, "observation still lands");
    assert.equal(existsSync(join(root, id)), false, "nothing was created inside the foreign parent");
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A late provider fulfillment still owns what it staged
// ---------------------------------------------------------------------------

test("a provider that answers after shutdown has its review plugin directory released and never spawns", async () => {
  await withHarness("late-fulfillment", async (harness) => {
    const created = harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    await until(() => harness.gatedCalls === 1, "the provider to be invoked");
    assert.ok(harness.providerCalls[0]!.nativeReview !== undefined, "this launch asked for a review lane");
    assert.equal(harness.leases.length, 1, "the preparation already staged its plugin directory");
    const lease = harness.leases[0]!;

    // Shutdown abandons this launch: its lane is retired NOW, long before the
    // provider answers. Adoption may not ask whether the lane is still live.
    await harness.manager.shutdown();
    await created.catch(() => undefined);
    await settleMany();
    assert.equal(lease.cleanupCount, 0, "nothing has arrived to adopt yet");
    assert.equal(harness.spawned.length, 0, "no child of this launch exists");

    harness.releaseGated();
    await settleMany(8);
    assert.equal(lease.cleanupCount, 1, "the late fulfillment's staged files are released exactly once");
    assert.equal(harness.spawned.length, 0, "and they are released without ever spawning a child");
    harness.releaseGated();
    await settleMany();
    assert.equal(lease.cleanupCount, 1, "a second look changes nothing");
  }, { gateProvider: true });
});

// ---------------------------------------------------------------------------
// A registration this manager cannot fully parse is never trusted
// ---------------------------------------------------------------------------

test("a null or malformed review bootstrap degrades to no lane, releasing and disposing cleanly", async () => {
  for (const mode of ["null-bootstrap", "malformed-bootstrap"] as const) {
    const harness = makeHarness(`bad-bootstrap-${mode}`);
    try {
      harness.registrar.reviewMode = mode;
      const id = await createClaude(harness);
      assert.equal(harness.creates.length, 1, `${mode}: the factory ran, then its registration was refused`);
      assert.equal(harness.providerCalls[0]!.nativeReview, undefined, `${mode}: no bootstrap reached the provider`);
      assert.equal(harness.registrar.reviewSources.length, 1, `${mode}: the broker did register, and this manager refused it`);
      const source = harness.registrar.reviewSources[0]!;
      await until(() => source.releaseCount === 1, `${mode}: the refused registration was released`);
      assert.equal(harness.handles[0]!.disposeCount, 1, `${mode}: the handle this run created was disposed`);
      await until(() => !existsSync(reviewDirFor(harness, id)), `${mode}: and its private directory removed`);
      assert.ok(harness.spawned.length === 1, `${mode}: the row still launched`);
      harness.registrar.hookHandlers.get(id)!.onEvent(hook({ hook_event_name: "SessionStart", session_id: "s-1" }));
      assert.equal(harness.observers.get(id)!.hooks.length, 1, `${mode}: observation still lands`);
    } finally {
      await harness.manager.dispose();
      rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

test("the validated bootstrap is read from the foreign registration exactly once", async () => {
  await withHarness("single-read", async (harness) => {
    let reads = 0;
    let issued: NativeReviewBootstrap | undefined;
    // The registration is a foreign object, so this manager reads it once, validates
    // what it read, and never reaches back through a getter it has no idea about.
    harness.registrar.registerNativeReviewSource = (instanceId: string, backend: NativeCliBackend) => {
      const bootstrap: NativeReviewBootstrap = {
        version: 1,
        socketPath: `/synthetic/native/${instanceId}.sock`,
        generation: randomUUID(),
        instanceId,
        backend,
        token: randomBytes(32).toString("hex"),
      };
      issued = bootstrap;
      return {
        instanceId,
        backend,
        // Reads are counted, and the SECOND read throws: a manager that reached back
        // through this foreign object on the launch path would fail a launch it had
        // already armed, over a value it had already validated and stored.
        get bootstrap() {
          reads += 1;
          if (reads > 1) throw new Error("the registration changed after arming");
          return bootstrap;
        },
        release: () => undefined,
      };
    };
    await createClaude(harness);
    const launch = harness.providerCalls.find((call) => call.nativeReview !== undefined)!;
    assert.ok(launch.nativeReview !== undefined, "the launch still carries its review lane");
    assert.deepEqual(launch.nativeReview!.bootstrap, issued, "carrying the copy this manager validated");
    assert.equal(reads, 1, "the foreign registration was read exactly once, not again on the launch path");
  });
});

test("an agent directory moved and replaced by a link is never deleted through", async () => {
  await withHarness("moved-agent-dir", async (harness) => {
    const id = await createClaude(harness);
    const handle = harness.handles[0]!;
    const dir = reviewDirFor(harness, id);
    const laneLeaf = basename(dir);
    const originalAgentDir = harness.agentDir;
    const moved = join(harness.root, "moved-agent");
    // Something precious inside the operator's own Pi directory, to make "we deleted
    // through a link" an observable catastrophe rather than a silent one.
    writeFileSync(join(originalAgentDir, "credentials.json"), "the operator's own\n", "utf8");

    let release: () => void = () => undefined;
    handle.disposeGate = new Promise<void>((resolve) => { release = resolve; });
    harness.spawned[0]!.emitExit(0);
    await until(() => handle.disposeCount === 1, "disposal started");

    // The whole Pi directory was relocated: the tree now lives somewhere else and a
    // LINK stands where it used to be. Every directory inside that link kept its inode,
    // so a chain recorded below the agent directory still matches perfectly — which is
    // precisely why the chain has to start at the agent directory itself.
    renameSync(originalAgentDir, moved);
    symlinkSync(moved, originalAgentDir, process.platform === "win32" ? "junction" : "dir");

    release();
    await until(() => handle.disposeCount === 1, "disposal finished");

    assert.ok(existsSync(join(moved, "credentials.json")),
      "the operator's own file inside the moved tree survives an unprovable chain");
    assert.ok(existsSync(join(moved, "session-host", "native-review", laneLeaf)),
      "an unprovable chain removes nothing at all, even inside a directory this lane made");
    assert.equal(handle.disposeCount, 1, "the lane was still disposed exactly once");
    assert.equal(harness.registrar.reviewSources.length, 1, "and this row's review source is still the only one");
    await harness.manager.dispose();
  });
});

test("a group-writable agent directory yields no review lane, because the chain cannot be proven", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits");
    return;
  }
  await withHarness("agent-dir-group-writable", async (harness) => {
    chmodSync(harness.agentDir, 0o775);
    const id = await createClaude(harness);
    assert.equal(harness.handles.length, 0, "the lane never armed: its outermost level is not provably private");
    const request = harness.providerCalls.find((call) => call.nativeHook !== undefined)!;
    assert.equal(request.nativeReview, undefined, "the launch carries no review option");
    assert.equal(existsSync(reviewDirFor(harness, id)), false, "and no directory of ours was made");
    assert.equal(harness.spawned.length, 1, "the row launched normally");
    await harness.manager.dispose();
  });
});

// ---------------------------------------------------------------------------
// A returned coordinator is as foreign as anything else the host injects
// ---------------------------------------------------------------------------

test("a coordinator whose method getter throws degrades to no lane, disposed once, checkpoint removed after it settles", async () => {
  await withHarness("throwing-accessor", async (harness) => {
    let checkpointDir = "";
    const handle = {
      disposeCount: 0,
      // Reading a method off the returned object is not a safe operation: a class
      // instance or a proxy can expose any of these as a throwing getter, and this
      // read happens AFTER the lane's private checkpoint directory was already made.
      get onReviewRequest(): never {
        throw new Error("synthetic accessor failure");
      },
      noteToolActivity: () => undefined,
      dispose(): Promise<void> {
        handle.disposeCount += 1;
        return gate;
      },
    };
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    harness.setCreate((input) => {
      checkpointDir = input.checkpointAgentDir;
      return handle as unknown as NativeReviewCoordinatorHandle;
    });

    const id = await createClaude(harness);
    const request = harness.providerCalls.find((call) => call.nativeHook !== undefined)!;

    assert.notEqual(checkpointDir, "", "the checkpoint was created before the handle was ever read");
    assert.equal(harness.spawned.length, 1, "the row launched normally");
    assert.equal(request.nativeHook !== undefined, true, "and it still observes status");
    assert.equal(request.nativeReview, undefined, "the launch carries no review option");
    assert.equal(harness.registrar.reviewSources.length, 0, "no review source was ever registered");
    assert.equal(handle.disposeCount, 1, "the unusable coordinator was disposed exactly once");
    assert.ok(existsSync(checkpointDir),
      "the checkpoint is still there while disposal has not settled — removal is tracked, not immediate");

    releaseGate();
    await until(() => !existsSync(checkpointDir), "the checkpoint goes only after disposal settles");
    assert.equal(handle.disposeCount, 1, "and never a second time");
    assert.equal(harness.manager === undefined, false, "the row is untouched by its lane's failure");
    void id;
  });
});

// ---------------------------------------------------------------------------
// macOS extended ACLs: mode bits are only half the proof
// ---------------------------------------------------------------------------

const ACL_SKIP = process.platform === "darwin"
  ? false
  : "extended-ACL fixtures require a macOS host, the one ACL dialect this policy parses";

function applyAclEntry(target: string, entry: string): void {
  execFileSync("/bin/chmod", ["+a", entry, target], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function aclListing(target: string): string {
  return execFileSync("/bin/ls", ["-lde", target], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
}

test("an agent directory whose ACL grants another principal write rights never arms a review lane", { skip: ACL_SKIP }, async () => {
  await withHarness("agent-dir-acl-grant", async (harness) => {
    // The mode stays exactly 0755: the mode bits go on saying nothing has changed.
    // Only the ACL knows that another principal may now create and delete entries.
    applyAclEntry(harness.agentDir, "group:everyone allow add_file,delete_child");
    const listing = aclListing(harness.agentDir);
    assert.match(listing, /group:everyone allow .*(add_file|write)/u, "the fixture really applied");
    assert.equal(statSync(harness.agentDir).mode & 0o777, 0o755, "and the mode bits are unchanged");

    const id = await createClaude(harness);
    const request = harness.providerCalls.find((call) => call.nativeHook !== undefined)!;
    assert.equal(harness.handles.length, 0, "the factory was never consulted for a lane");
    assert.equal(harness.creates.length, 0, "the review factory is not called");
    assert.equal(harness.spawned.length, 1, "the row still spawns");
    assert.equal(request.nativeHook !== undefined, true, "and it still observes status");
    assert.equal(request.nativeReview, undefined, "with no review option on the launch");
    assert.equal(existsSync(reviewDirFor(harness, id)), false, "and no directory of ours was made");
    await harness.manager.dispose();
  });
});
