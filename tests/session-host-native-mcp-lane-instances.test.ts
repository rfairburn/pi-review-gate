import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type NativeMcpLaneContext,
  type NativeMcpLaneDelegate,
  type NativeMcpLaneOwner,
  type NativeMcpLaneToolCall,
  type NativeMcpSourceRegistrar,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
  type StatusRegistrar,
} from "../src/session-host/instances";
import { createStatusBroker, type NativeMcpRegistration } from "../src/session-host/broker";
import type { NativeMcpArtifactCleanup, NativeMcpLaunchOutcome } from "../src/session-host/native-mcp-launch-prep";
import type { NativeMcpCallToolResult, NativeMcpToolEndpoint } from "../src/session-host/native-mcp-stdio";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import type { NativeHookSourceHandlers } from "../src/session-host/broker";
import type { NativeHookEvent } from "../src/session-host/native-hook-protocol";
import type { NativeCodexTuiRootFactsSnapshot, NativeCodexTuiRootFactsSource } from "../src/session-host/native-codex-tui-root-facts";
import type { NativeCodexOwnedLaunchPlan, NativeCodexOwnedTuiConnection } from "../src/session-host/native-cli-launch";
import type {
  OwnedCodexBackendLaunchIdentity,
  OwnedCodexBackendLease,
  OwnedCodexBackendReady,
  OwnedCodexBackendSettlement,
  OwnedCodexBackendStatus,
} from "../src/session-host/native-codex-backend";

/**
 * Focused coverage of the OPTIONAL native MCP lane of `InstanceManager` (#682).
 *
 * EVIDENCE SCOPE: synthetic PTYs, an injected fake launch provider, a fake
 * registrar shaped like the broker's `registerNativeMcpSource` (plus one case on
 * the real broker), a fake owner delegate, and a synthetic observer that only
 * calls the context it was handed. No provider binary, relay, or real tool runs;
 * this proves the manager's arming, fencing, revocation, and artifact ownership.
 */

const SERVER_NAME = `pi_review_gate_${"a1".repeat(16)}`;
const UUID_B = "1d6f2b9e-3c4a-4e5f-9a0b-1c2d3e4f5a6b";
const UUID_C = "8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0";

class SpyPty implements InstancePty {
  static #nextPid = 940_000;
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
  constructor(readonly context: NativeStatusObserverContext) {}
  acceptHook(): void { /* unused */ }
  acceptFailure(): void { /* unused */ }
  dispose(): void { /* unused */ }
  identity(value: string | null): boolean {
    const emit = this.context.emitConversationIdentity;
    assert.ok(emit);
    return emit(value);
  }
}

class SpyMcpLease {
  cleanupCount = 0;
  readonly root = "/synthetic/mcp-root";
  readonly bootstrapFile = "/synthetic/mcp-root/bootstrap.json";
  cleanup(): Promise<NativeMcpArtifactCleanup> {
    this.cleanupCount += 1;
    return Promise.resolve({ removed: true } as unknown as NativeMcpArtifactCleanup);
  }
}

interface FakeSource {
  readonly instanceId: string;
  readonly backend: NativeCliBackend;
  readonly endpoint: NativeMcpToolEndpoint;
  releaseCount: number;
}

class FakeMcpRegistrar implements NativeMcpSourceRegistrar {
  readonly sources: FakeSource[] = [];
  mode: "ok" | "throw" | "foreign" | "bad-token" = "ok";
  registerNativeMcpSource(instanceId: string, backend: NativeCliBackend, endpoint: NativeMcpToolEndpoint): NativeMcpRegistration {
    if (this.mode === "throw") throw new Error("synthetic registrar refusal");
    const source: FakeSource = { instanceId, backend, endpoint, releaseCount: 0 };
    this.sources.push(source);
    return {
      bootstrap: {
        version: 1,
        type: "native_mcp_bootstrap",
        socketPath: `/synthetic/native-mcp/${instanceId}.sock`,
        generation: randomUUID(),
        instanceId: this.mode === "foreign" ? randomUUID() : instanceId,
        backend,
        token: this.mode === "bad-token" ? "not-a-token" : randomBytes(32).toString("hex"),
      },
      release: () => { source.releaseCount += 1; },
    };
  }
}

interface DelegateCall {
  readonly kind: "list" | "call";
  readonly context: NativeMcpLaneContext;
  readonly call?: NativeMcpLaneToolCall;
}

class FakeDelegate implements NativeMcpLaneDelegate {
  readonly calls: DelegateCall[] = [];
  /** When set, `callTool` waits for this promise before answering. */
  gate: Promise<void> | undefined;
  listTools(context: NativeMcpLaneContext): Promise<readonly { name: string; inputSchema: Record<string, unknown> }[]> {
    this.calls.push({ kind: "list", context });
    return Promise.resolve([{ name: "Echo", inputSchema: { type: "object" } }]);
  }
  async callTool(context: NativeMcpLaneContext, call: NativeMcpLaneToolCall): Promise<NativeMcpCallToolResult | undefined> {
    this.calls.push({ kind: "call", context, call });
    if (this.gate !== undefined) await this.gate;
    return { content: [{ type: "text", text: `result for ${context.conversationId}` }] };
  }
}

/** A minimal owned Codex backend lease whose readiness, exit, and settlement the test drives. */
class FakeBackendLease {
  /** Mutable retained root facts this lease's readiness carries. */
  rootFacts: NativeCodexTuiRootFactsSnapshot = Object.freeze({ phase: "bound" as const, rootThreadId: UUID_B });
  readonly readiness: Promise<OwnedCodexBackendReady>;
  readonly settlement: Promise<OwnedCodexBackendSettlement>;
  requestStopCount = 0;
  exited = false;
  #settled = false;
  #resolveReady!: (ready: OwnedCodexBackendReady) => void;
  #resolveSettlement!: (settlement: OwnedCodexBackendSettlement) => void;
  constructor(readonly identity: OwnedCodexBackendLaunchIdentity) {
    this.readiness = new Promise((resolve) => { this.#resolveReady = resolve; });
    this.settlement = new Promise((resolve) => { this.#resolveSettlement = resolve; });
  }
  status(): OwnedCodexBackendStatus {
    return {
      phase: this.#settled ? "settled" : this.exited ? "exited" : this.requestStopCount > 0 ? "stopping" : "ready",
      settled: this.#settled,
      stopRequested: this.requestStopCount > 0,
      exitObserved: this.exited,
    } as unknown as OwnedCodexBackendStatus;
  }
  requestStop(): void { this.requestStopCount += 1; }
  fulfillReady(): void {
    this.#resolveReady({
      endpoint: "ws://127.0.0.1:54321",
      readObserverBearer: () => "synthetic-bearer",
      createTuiConnection: () => ({ endpoint: "ws://127.0.0.1:54321", args: ["--remote", "ws://127.0.0.1:54321"], env: { PATH: "/synthetic/bin" } }),
      tuiRootFacts: {
        current: () => this.rootFacts,
        watch: () => () => undefined,
      } satisfies NativeCodexTuiRootFactsSource,
    } as unknown as OwnedCodexBackendReady);
  }
  settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveSettlement({ status: "settled", child: "exited", code: 0, signal: null, stdout: "ended", stderr: "ended" } as unknown as OwnedCodexBackendSettlement);
  }
}

function ownedPlan(cwd: string): NativeCodexOwnedLaunchPlan {
  return {
    backendEnv: { PATH: "/synthetic/bin" },
    renderBackend: (controlArgs: readonly string[], env: NodeJS.ProcessEnv) => ({ file: "/synthetic/bin/codex", args: ["app-server", ...controlArgs], env: { ...env }, cwd }),
    renderTui: (connection: NativeCodexOwnedTuiConnection) => ({ file: "/synthetic/bin/codex", args: ["--interactive", ...connection.args], env: { ...connection.env } as NodeJS.ProcessEnv, cwd }),
  } as unknown as NativeCodexOwnedLaunchPlan;
}

type ProviderMcp = "prepared" | "unavailable" | "silent" | "cross-backend";

interface Harness {
  root: string;
  workspace: string;
  manager: InstanceManager;
  registrar: FakeMcpRegistrar;
  delegate: FakeDelegate;
  observers: Map<string, SpyObserver>;
  spawned: SpyPty[];
  providerCalls: NativeCliLaunchRequest[];
  leases: SpyMcpLease[];
  backendLeases: FakeBackendLease[];
  hookHandlers: Map<string, NativeHookSourceHandlers>;
  setProviderMcp(mode: ProviderMcp): void;
  setProvider(next: NativeCliLaunch): void;
  setPtyFactory(next: (descriptor: InstanceSpawnDescriptor) => InstancePty): void;
}

function makeHarness(label: string, overrides: { lane?: "on" | "off"; pair?: boolean; laneOwner?: NativeMcpLaneOwner; owned?: boolean } = {}): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `prg-native-mcp-lane-${label}-`)));
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
  for (const dir of [home, agentDir, workspace]) mkdirSync(dir, { recursive: true });

  const registrar = new FakeMcpRegistrar();
  const delegate = new FakeDelegate();
  const observers = new Map<string, SpyObserver>();
  const spawned: SpyPty[] = [];
  const providerCalls: NativeCliLaunchRequest[] = [];
  const leases: SpyMcpLease[] = [];
  const backendLeases: FakeBackendLease[] = [];
  const hookHandlers = new Map<string, NativeHookSourceHandlers>();
  let providerMcp: ProviderMcp = "prepared";

  const defaultProvider: NativeCliLaunch = (backend, request) => {
    providerCalls.push({ ...request, env: {} });
    let nativeMcp: NativeMcpLaunchOutcome | undefined;
    if (request.nativeMcp !== undefined) {
      if (providerMcp === "prepared" || providerMcp === "cross-backend") {
        const lease = new SpyMcpLease();
        leases.push(lease);
        nativeMcp = {
          mcp: "prepared",
          backend: providerMcp === "cross-backend" ? (backend === "claude" ? "codex" : "claude") : backend,
          route: backend === "codex" ? "codex-owned-backend-config" : "claude-mcp-config-file",
          placement: backend === "codex" ? "codex-owned-backend" : "claude-tui",
          serverName: request.nativeMcp.serverName,
          args: [],
          lease,
        } as unknown as NativeMcpLaunchOutcome;
      } else if (providerMcp === "unavailable") {
        nativeMcp = { mcp: "unavailable", backend, reason: "platform-unsupported" } as unknown as NativeMcpLaunchOutcome;
      }
    }
    return {
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin", HOME: home },
      cwd: request.workspace,
      ...(nativeMcp === undefined ? {} : { nativeMcp }),
      ...(overrides.owned === true && backend === "codex" ? { ownedCodex: ownedPlan(request.workspace) } : {}),
    } satisfies NativeCliLaunchDescriptor;
  };
  let provider: NativeCliLaunch = defaultProvider;
  let ptyFactory = (descriptor: InstanceSpawnDescriptor): InstancePty => {
    const pty = new SpyPty(descriptor);
    spawned.push(pty);
    return pty;
  };

  const pair = overrides.pair ?? true;
  const options: InstanceManagerOptions = {
    packageRoot,
    piExecutable,
    statusRegistrar: new RecordingPiRegistrar(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    nativeCliLaunch: (backend, request) => provider(backend, request),
    ...(pair
      ? {
        nativeHookRegistrar: {
          registerNativeHookSource: (instanceId, backend, handlers) => (hookHandlers.set(instanceId, handlers), {
            bootstrap: {
              version: 1,
              socketPath: `/synthetic/native/${instanceId}.sock`,
              generation: randomUUID(),
              instanceId,
              backend,
              token: randomBytes(32).toString("hex"),
            },
            release: () => undefined,
          }),
        },
        nativeStatusObserverFactory: (context: NativeStatusObserverContext) => {
          const observer = new SpyObserver(context);
          observers.set(context.rowId, observer);
          return observer;
        },
      }
      : {}),
    ...((overrides.lane ?? "on") === "on"
      ? { nativeMcpLane: overrides.laneOwner ?? { registrar, serverName: SERVER_NAME, delegate } }
      : {}),
    ptyFactory: (descriptor) => ptyFactory(descriptor),
    ...(overrides.owned === true
      ? {
        ownedCodexBackendFactory: (request) => {
          const lease = new FakeBackendLease(request.identity);
          backendLeases.push(lease);
          return lease as unknown as OwnedCodexBackendLease;
        },
      }
      : {}),
  };
  let manager: InstanceManager;
  try {
    manager = new InstanceManager(options);
  } catch (error) {
    // A refused construction never reaches the caller's cleanup, so its fixture goes here.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    workspace,
    manager,
    registrar,
    delegate,
    observers,
    spawned,
    providerCalls,
    leases,
    backendLeases,
    hookHandlers,
    setProviderMcp: (mode) => { providerMcp = mode; },
    setProvider: (next) => { provider = next; },
    setPtyFactory: (next) => { ptyFactory = next; },
  };
}

async function withHarness(
  label: string,
  body: (harness: Harness) => Promise<void>,
  overrides: Parameters<typeof makeHarness>[1] = {},
): Promise<void> {
  const harness = makeHarness(label, overrides);
  try {
    await body(harness);
  } finally {
    for (const lease of harness.backendLeases) lease.settle();
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
}

const settle = async (): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for: ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function createClaude(harness: Harness): Promise<string> {
  return harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
}

function sourceFor(harness: Harness, id: string): FakeSource {
  const source = harness.registrar.sources.find((candidate) => candidate.instanceId === id);
  assert.ok(source, "the row registered one MCP source");
  return source;
}

function observerFor(harness: Harness, id: string): SpyObserver {
  const observer = harness.observers.get(id);
  assert.ok(observer);
  return observer;
}

const signal = (): AbortSignal => new AbortController().signal;
const list = (source: FakeSource): Promise<unknown> => source.endpoint.listTools({ signal: signal() });
const call = (source: FakeSource, name = "Echo", args: Record<string, unknown> = { text: "hi" }): Promise<NativeMcpCallToolResult | undefined> =>
  source.endpoint.callTool({ name, arguments: args, signal: signal() });

async function assertRefused(promise: Promise<unknown>, what: string): Promise<void> {
  await assert.rejects(promise, /native MCP lane/, what);
}

test("an unwired manager arms nothing and its launch request is unchanged", async () => {
  await withHarness("unwired", async (harness) => {
    const id = await createClaude(harness);
    assert.equal("nativeMcp" in harness.providerCalls[0]!, false, "no MCP option without a lane owner");
    assert.equal(harness.registrar.sources.length, 0);
    assert.equal(harness.manager.list().find((row) => row.id === id)?.lifecycle, "alive");
  }, { lane: "off" });
});

test("construction refuses a half-wired or malformed lane owner", () => {
  const registrar = new FakeMcpRegistrar();
  const delegate = new FakeDelegate();
  assert.throws(() => makeHarness("no-pair", { pair: false }), /requires the nativeHookRegistrar/);
  assert.throws(() => makeHarness("bad-name", { laneOwner: { registrar, delegate, serverName: "review_gate" } }), /serverName/);
  assert.throws(() => makeHarness("bad-delegate", {
    laneOwner: { registrar, serverName: SERVER_NAME, delegate: {} as unknown as NativeMcpLaneDelegate },
  }), /delegate/);
  assert.throws(() => makeHarness("bad-registrar", {
    laneOwner: { registrar: {} as unknown as NativeMcpSourceRegistrar, serverName: SERVER_NAME, delegate },
  }), /registrar/);
});

test("a wired launch hands the provider its own bootstrap and the injected name, and nothing reaches the delegate before proof", async () => {
  await withHarness("unproved", async (harness) => {
    const id = await createClaude(harness);
    const source = sourceFor(harness, id);
    assert.equal(source.backend, "claude");
    const option = harness.providerCalls[0]!.nativeMcp;
    assert.ok(option);
    assert.equal(option.serverName, SERVER_NAME);
    assert.equal(option.bootstrap.instanceId, id);
    assert.equal(option.bootstrap.backend, "claude");
    assert.ok(harness.providerCalls[0]!.nativeHook, "the hook arming is unchanged beside it");
    assert.deepEqual(harness.spawned.length, 1);

    await assertRefused(list(source), "listTools is refused before any proved conversation");
    await assertRefused(call(source), "callTool is refused before any proved conversation");
    assert.equal(harness.delegate.calls.length, 0, "no effect while unproved");
    assert.equal(source.releaseCount, 0, "an unproved lane is still armed");
  });
});

test("a proved lane reaches the delegate with host-proved context only, and binds once", async () => {
  await withHarness("proved", async (harness) => {
    const id = await createClaude(harness);
    const source = sourceFor(harness, id);
    const observer = observerFor(harness, id);
    assert.equal(observer.identity(UUID_B), true);

    assert.deepEqual(await list(source), [{ name: "Echo", inputSchema: { type: "object" } }]);
    const result = await call(source, "Echo", { text: "hi", conversationId: UUID_C, rowId: "forged" });
    assert.deepEqual(result, { content: [{ type: "text", text: `result for ${UUID_B}` }] });
    const [listed, called] = harness.delegate.calls;
    assert.ok(listed && called);
    for (const entry of [listed, called]) {
      assert.equal(entry.context.rowId, id);
      assert.equal(entry.context.backend, "claude");
      assert.equal(entry.context.workspace, realpathSync(harness.workspace));
      assert.equal(entry.context.conversationId, UUID_B, "model-claimed arguments never change the bound conversation");
      assert.ok(Object.isFrozen(entry.context));
      assert.equal(entry.context.isCurrent(), true);
    }
    assert.deepEqual(called.call, { name: "Echo", arguments: { text: "hi", conversationId: UUID_C, rowId: "forged" } });

    // A repeated identical proof keeps the binding.
    assert.equal(observer.identity(UUID_B), true);
    await list(source);
    assert.equal(source.releaseCount, 0);
  });
});

test("an observed identity change revokes the lane for good; it never follows the new conversation", async () => {
  await withHarness("change", async (harness) => {
    const id = await createClaude(harness);
    const source = sourceFor(harness, id);
    const observer = observerFor(harness, id);
    assert.equal(observer.identity(UUID_B), true);
    await list(source);
    const old = harness.delegate.calls[0]!.context;

    assert.equal(observer.identity(UUID_C), true, "the row itself still follows the provider");
    assert.equal(source.releaseCount, 1, "the broker registration is released");
    assert.equal(old.isCurrent(), false, "an old context no longer proves anything");
    assert.equal(old.signal.aborted, true);
    const before = harness.delegate.calls.length;
    await assertRefused(list(source), "a revoked lane refuses list");
    await assertRefused(call(source), "a revoked lane refuses call");

    // Even returning to the originally bound conversation does not revive it.
    assert.equal(observer.identity(UUID_B), true);
    await assertRefused(call(source), "revocation is terminal");
    assert.equal(harness.delegate.calls.length, before);
    assert.equal(source.releaseCount, 1, "release happens once");
  });
});

test("an observed identity loss or a lost observation generation revokes the lane", async () => {
  await withHarness("loss", async (harness) => {
    const id = await createClaude(harness);
    const source = sourceFor(harness, id);
    assert.equal(observerFor(harness, id).identity(UUID_B), true);
    await list(source);
    assert.equal(observerFor(harness, id).identity(null), true);
    assert.equal(source.releaseCount, 1);
    await assertRefused(call(source), "identity loss revokes");
  });
  await withHarness("invalidate", async (harness) => {
    const id = await createClaude(harness);
    const source = sourceFor(harness, id);
    assert.equal(observerFor(harness, id).identity(UUID_B), true);
    await list(source);
    const capture = harness.manager.nativeStatusCapture(id);
    assert.ok(capture);
    capture.invalidate();
    assert.equal(source.releaseCount, 1);
    await assertRefused(call(source), "a lost generation revokes");
  });
});

test("a result that completes after revocation is never exposed", async () => {
  await withHarness("stale-result", async (harness) => {
    const id = await createClaude(harness);
    const source = sourceFor(harness, id);
    const observer = observerFor(harness, id);
    assert.equal(observer.identity(UUID_B), true);
    let open: () => void = () => undefined;
    harness.delegate.gate = new Promise<void>((resolve) => { open = resolve; });
    const pending = call(source);
    await settle();
    const context = harness.delegate.calls.at(-1)!.context;
    assert.equal(context.isCurrent(), true);

    assert.equal(observer.identity(UUID_C), true);
    assert.equal(context.signal.aborted, true, "the delegate's signal is aborted on revocation");
    assert.equal(context.isCurrent(), false);
    open();
    await assertRefused(pending, "the old result is discarded");
  });
});

test("a client-cancelled signal reaches the delegate through the combined signal", async () => {
  await withHarness("client-cancel", async (harness) => {
    const id = await createClaude(harness);
    const source = sourceFor(harness, id);
    assert.equal(observerFor(harness, id).identity(UUID_B), true);
    const controller = new AbortController();
    let open: () => void = () => undefined;
    harness.delegate.gate = new Promise<void>((resolve) => { open = resolve; });
    const pending = source.endpoint.callTool({ name: "Echo", arguments: {}, signal: controller.signal });
    await settle();
    const context = harness.delegate.calls.at(-1)!.context;
    controller.abort();
    assert.equal(context.signal.aborted, true);
    assert.equal(context.isCurrent(), false);
    open();
    await assertRefused(pending, "a cancelled call's late result is discarded");
    assert.equal(source.releaseCount, 0, "a single cancelled call does not revoke the lane");
  });
});

test("lanes are per row: one row's proof or stop never reaches another", async () => {
  await withHarness("cross-row", async (harness) => {
    const a = await createClaude(harness);
    const b = await createClaude(harness);
    const sourceA = sourceFor(harness, a);
    const sourceB = sourceFor(harness, b);
    assert.notEqual(sourceA, sourceB);
    assert.equal(observerFor(harness, a).identity(UUID_B), true);

    await list(sourceA);
    await assertRefused(list(sourceB), "row B is not proved by row A's identity");
    assert.equal(observerFor(harness, b).identity(UUID_C), true);
    await call(sourceB);
    assert.equal(harness.delegate.calls.at(-1)!.context.rowId, b);
    assert.equal(harness.delegate.calls.at(-1)!.context.conversationId, UUID_C);

    const result = await harness.manager.stop(a, { confirmed: true });
    assert.equal(result.status, "exited");
    await until(() => sourceA.releaseCount === 1, "row A's registration to be released");
    await assertRefused(call(sourceA), "a stopped row's endpoint is dead");
    await call(sourceB);
    assert.equal(sourceB.releaseCount, 0, "row B is untouched");
    assert.equal(harness.leases[0]!.cleanupCount, 1, "row A's staged MCP files are released after its exit");
    assert.equal(harness.leases[1]!.cleanupCount, 0);
  });
});

test("the child's exit releases the registration, then the owned MCP artifact lease exactly once", async () => {
  await withHarness("exit", async (harness) => {
    const id = await createClaude(harness);
    const source = sourceFor(harness, id);
    assert.equal(observerFor(harness, id).identity(UUID_B), true);
    assert.equal(harness.leases.length, 1);
    assert.equal(harness.leases[0]!.cleanupCount, 0, "a live child keeps its staged files");
    harness.spawned[0]!.emitExit(0);
    await settle();
    assert.equal(source.releaseCount, 1);
    assert.equal(harness.leases[0]!.cleanupCount, 1);
    await assertRefused(call(source), "an exited row's endpoint is dead");
    await harness.manager.dispose();
    assert.equal(source.releaseCount, 1);
    assert.equal(harness.leases[0]!.cleanupCount, 1, "disposal never releases twice");
  });
});

test("a declined, silent, or cross-backend MCP preparation leaves the launch unchanged and revokes the lane", async () => {
  for (const mode of ["unavailable", "silent", "cross-backend"] as const) {
    await withHarness(`declined-${mode}`, async (harness) => {
      harness.setProviderMcp(mode);
      const id = await createClaude(harness);
      const source = sourceFor(harness, id);
      assert.equal(harness.manager.list().find((row) => row.id === id)?.lifecycle, "alive", `${mode}: the launch proceeds`);
      assert.equal(source.releaseCount, 1, `${mode}: the unused registration is released`);
      assert.equal(observerFor(harness, id).identity(UUID_B), true, `${mode}: status identity is unaffected`);
      await assertRefused(call(source), `${mode}: a declined lane never reaches the delegate`);
      assert.equal(harness.delegate.calls.length, 0);
      if (mode === "cross-backend") {
        // The staged files still belong to this launch and go with its settlement.
        harness.spawned[0]!.emitExit(0);
        await settle();
        assert.equal(harness.leases[0]!.cleanupCount, 1);
      }
    });
  }
});

test("a throwing, foreign, or malformed-bootstrap registrar arms no MCP option and never breaks the launch", async () => {
  for (const mode of ["throw", "foreign", "bad-token"] as const) {
    await withHarness(`registrar-${mode}`, async (harness) => {
      harness.registrar.mode = mode;
      const id = await createClaude(harness);
      assert.equal("nativeMcp" in harness.providerCalls[0]!, false, `${mode}: no MCP option`);
      assert.ok(harness.providerCalls[0]!.nativeHook, `${mode}: status arming is unchanged`);
      assert.equal(harness.manager.list().find((row) => row.id === id)?.lifecycle, "alive");
      if (mode !== "throw") assert.equal(harness.registrar.sources[0]!.releaseCount, 1, `${mode}: an unusable registration is released`);
    });
  }
});

test("a failed spawn releases the registration and the staged MCP files at once", async () => {
  await withHarness("spawn-fail", async (harness) => {
    harness.setPtyFactory(() => { throw new Error("synthetic spawn failure"); });
    const id = await createClaude(harness);
    await settle();
    assert.equal(harness.manager.list().find((row) => row.id === id)?.lifecycle, "error");
    assert.equal(sourceFor(harness, id).releaseCount, 1);
    assert.equal(harness.leases[0]!.cleanupCount, 1, "no child can read them, so they go now");
  });
});

test("a preparation that answers after the launch was abandoned has its MCP files released and its lane dead", async () => {
  await withHarness("stale-preparation", async (harness) => {
    let answer: (() => void) | undefined;
    let pendingRequest: NativeCliLaunchRequest | undefined;
    const lease = new SpyMcpLease();
    harness.setProvider((backend, request) => new Promise<NativeCliLaunchDescriptor>((resolve) => {
      pendingRequest = request;
      answer = () => resolve({
        file: `/synthetic/bin/${backend}`,
        args: ["--interactive"],
        env: { PATH: "/synthetic/bin" },
        cwd: request.workspace,
        nativeMcp: {
          mcp: "prepared", backend, route: "claude-mcp-config-file", placement: "claude-tui",
          serverName: SERVER_NAME, args: [], lease,
        } as unknown as NativeMcpLaunchOutcome,
      });
    }));
    const created = harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    await until(() => answer !== undefined, "the provider to be invoked");
    assert.ok(pendingRequest?.nativeMcp);
    const id = pendingRequest.nativeMcp.bootstrap.instanceId;
    const source = sourceFor(harness, id);
    await harness.manager.shutdown();
    await created;
    assert.equal(source.releaseCount, 1, "the abandoned launch's registration is released");

    answer!();
    await settle();
    await settle();
    assert.equal(lease.cleanupCount, 1, "a late preparation's staged files are released");
    assert.equal(harness.spawned.length, 0);
    await assertRefused(call(source), "the abandoned lane never reaches the delegate");
    assert.equal(harness.delegate.calls.length, 0);
  });
});

test("the real broker accepts the manager's lane endpoint and the source is gone after exit", async () => {
  const broker = await createStatusBroker();
  const delegate = new FakeDelegate();
  const harness = makeHarness("real-broker", { laneOwner: { registrar: broker, serverName: SERVER_NAME, delegate } });
  try {
    const id = await createClaude(harness);
    const option = harness.providerCalls[0]!.nativeMcp;
    assert.ok(option);
    assert.equal(option.bootstrap.instanceId, id);
    assert.equal(option.bootstrap.socketPath, broker.socketPath);
    const counts = (broker as unknown as { __nativeMcpLaneCountsForTests(): { sources: number } }).__nativeMcpLaneCountsForTests;
    assert.equal(counts.call(broker).sources, 1);
    harness.spawned[0]!.emitExit(0);
    await settle();
    assert.equal(counts.call(broker).sources, 0, "the broker source is released with the run");
    assert.equal(harness.leases[0]!.cleanupCount, 1);
  } finally {
    await harness.manager.dispose();
    await broker.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("an owned Codex lane is fenced on its exact backend and revoked when that backend settles", async () => {
  await withHarness("owned-codex", async (harness) => {
    const created = harness.manager.create({ workspace: harness.workspace, backend: "codex" } as CreateInstanceOptions);
    await until(() => harness.backendLeases.length === 1, "the owned backend to be created");
    const backendLease = harness.backendLeases[0]!;
    backendLease.fulfillReady();
    const id = await created;
    await until(() => harness.spawned.length === 1, "the TUI to spawn");
    assert.equal(harness.manager.list().find((row) => row.id === id)?.lifecycle, "alive");
    const option = harness.providerCalls[0]!.nativeMcp;
    assert.ok(option);
    assert.equal(option.bootstrap.backend, "codex");
    const source = sourceFor(harness, id);

    await assertRefused(call(source), "an unproved Codex lane is refused");
    assert.equal(observerFor(harness, id).identity(UUID_B), true);
    await call(source);
    assert.equal(harness.delegate.calls.at(-1)!.context.backend, "codex");
    assert.equal(harness.delegate.calls.at(-1)!.context.conversationId, UUID_B);

    // An in-flight call whose backend exits while the TUI stays alive.
    let open: () => void = () => undefined;
    harness.delegate.gate = new Promise<void>((resolve) => { open = resolve; });
    const pending = call(source);
    await settle();
    const context = harness.delegate.calls.at(-1)!.context;
    const before = harness.delegate.calls.length;
    backendLease.exited = true;
    assert.equal(harness.spawned[0]!.exited, false, "the TUI is still alive");
    assert.equal(context.isCurrent(), false, "a known-ended backend fails the fence");
    await assertRefused(call(source), "a new call never reaches the delegate");
    assert.equal(harness.delegate.calls.length, before);
    open();
    await assertRefused(pending, "the in-flight result is discarded");

    backendLease.settle();
    await until(() => source.releaseCount === 1, "the registration to be released on backend settlement");
    assert.equal(context.signal.aborted, true);
    assert.equal(harness.manager.readNativeConversationIdentity(id)?.conversationId, UUID_B, "the status identity is untouched");
  }, { owned: true });
});

async function launchOwnedCodex(harness: Harness): Promise<{ id: string; backendLease: FakeBackendLease }> {
  const created = harness.manager.create({ workspace: harness.workspace, backend: "codex" } as CreateInstanceOptions);
  await until(() => harness.backendLeases.length === 1, "the owned backend to be created");
  const backendLease = harness.backendLeases[0]!;
  backendLease.fulfillReady();
  const id = await created;
  await until(() => harness.spawned.length === 1, "the TUI to spawn");
  return { id, backendLease };
}

test("an authenticated root Claude SessionEnd for the bound conversation revokes only the lane", async () => {
  await withHarness("claude-session-end", async (harness) => {
    const id = await createClaude(harness);
    const source = sourceFor(harness, id);
    assert.equal(observerFor(harness, id).identity(UUID_B), true);
    const handlers = harness.hookHandlers.get(id);
    assert.ok(handlers);

    // A subagent's SessionEnd, or one for another session, changes nothing.
    handlers.onEvent({ backend: "claude", hook_event_name: "SessionEnd", session_id: UUID_B, agent_id: "child-agent" } as unknown as NativeHookEvent);
    handlers.onEvent({ backend: "claude", hook_event_name: "SessionEnd", session_id: UUID_C } as unknown as NativeHookEvent);
    assert.equal(source.releaseCount, 0);

    let open: () => void = () => undefined;
    harness.delegate.gate = new Promise<void>((resolve) => { open = resolve; });
    const pending = call(source);
    await settle();
    const context = harness.delegate.calls.at(-1)!.context;
    const before = harness.delegate.calls.length;

    handlers.onEvent({ backend: "claude", hook_event_name: "SessionEnd", session_id: UUID_B } as unknown as NativeHookEvent);
    assert.equal(harness.spawned[0]!.exited, false, "the PTY is still alive");
    assert.equal(source.releaseCount, 1, "the registration is released");
    assert.equal(context.signal.aborted, true);
    await assertRefused(call(source), "a new request never reaches the delegate");
    assert.equal(harness.delegate.calls.length, before);
    open();
    await assertRefused(pending, "the pending result is discarded");
    assert.equal(harness.manager.readNativeConversationIdentity(id)?.conversationId, UUID_B, "the saved UUID is intact");
  });
});

test("an owned Codex root withdrawal revokes the lane without backend exit or identity loss", async () => {
  await withHarness("codex-root-withdrawn", async (harness) => {
    const { id, backendLease } = await launchOwnedCodex(harness);
    const source = sourceFor(harness, id);
    const observer = observerFor(harness, id);
    assert.equal(observer.identity(UUID_B), true);
    await call(source);

    let open: () => void = () => undefined;
    harness.delegate.gate = new Promise<void>((resolve) => { open = resolve; });
    const pending = call(source);
    await settle();
    const context = harness.delegate.calls.at(-1)!.context;
    const before = harness.delegate.calls.length;

    backendLease.rootFacts = Object.freeze({ phase: "withdrawn" as const, withdrawal: "generation-closed" as const, closeReason: "client-closed" } as NativeCodexTuiRootFactsSnapshot);
    assert.equal(context.isCurrent(), false, "the endpoint fence reads the withdrawal");
    await assertRefused(call(source), "a new request never reaches the delegate");
    assert.equal(harness.delegate.calls.length, before);

    // The observer publishes its ordinary unknown snapshot; no identity loss.
    assert.equal(observer.context.emit({ busy: null, pendingInput: null, activeTasks: null, activeShells: null }).accepted, true);
    assert.equal(source.releaseCount, 1, "the registration is released when the observer publishes");
    assert.equal(context.signal.aborted, true);
    assert.equal(backendLease.exited, false, "the backend is still running");
    assert.equal(harness.spawned[0]!.exited, false, "the TUI is still running");
    open();
    await assertRefused(pending, "the pending result is discarded");
    assert.equal(harness.manager.readNativeConversationIdentity(id)?.conversationId, UUID_B, "the saved UUID is intact");
  }, { owned: true });
});

test("an ordinary unknown Codex status snapshot is not a withdrawal", async () => {
  await withHarness("codex-unknown-status", async (harness) => {
    const { id } = await launchOwnedCodex(harness);
    const source = sourceFor(harness, id);
    const observer = observerFor(harness, id);
    assert.equal(observer.identity(UUID_B), true);
    assert.equal(observer.context.emit({ busy: null, pendingInput: null, activeTasks: null, activeShells: null }).accepted, true);
    assert.equal(source.releaseCount, 0);
    await call(source);
  }, { owned: true });
});
