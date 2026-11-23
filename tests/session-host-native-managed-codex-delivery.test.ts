/**
 * #682: canonical managed outcomes of an admitted native Codex task reach ONLY
 * that exact run's owned app-server backend and root thread, through the
 * production sidebar lane glue (`createNativeManagedHostLane` with its
 * `codexCallback` accessor) and `InstanceManager.nativeCodexCallbackSender`.
 *
 * EVIDENCE SCOPE: the end-to-end tests drive the REAL `InstanceManager` (with
 * the `nativeCodexCallback` opt-in), the real composed lane, custody, owner,
 * no-Pi `ExecutionToolManager`, controller, `WakeDelivery`, the real callback
 * transport and composer, through the MCP endpoint the manager registers. Only
 * the provider launch (which answers the version receipt), the PTY, the
 * observer, the owned backend lease, and its callback root facts are
 * synthetic; the "owned app-server" is an in-process bearer-checked RFC6455
 * server on an ephemeral 127.0.0.1 port that records the frames it receives.
 * The admitted task runs a deterministic external fake executor that lands one
 * file in a scratch Git workspace. No provider binary, prompt, relay, or peer is
 * involved. Every root, server, manager, and custody is removed or drained on
 * every exit.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import type { ExecutionToolManager } from "../src/execution/tool";
import type { ManagedNativeEvent } from "../src/execution/wake-delivery";
import type { NativeMcpRegistration } from "../src/session-host/broker";
import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type NativeCliLaunchDescriptor,
  type NativeCliLaunchRequest,
  type NativeCodexCallbackSender,
  type NativeMcpLaneContext,
  type NativeMcpLaneRunScope,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
  type OwnedCodexBackendFactory,
} from "../src/session-host/instances";
import { createRelayedOwnedCodexBackendFactory } from "../src/session-host/native-codex-owned-composite";
import type { NativeCodexCallbackRootFacts } from "../src/session-host/native-codex-callback-composition";
import type {
  OwnedCodexBackendLaunchIdentity,
  OwnedCodexBackendLease,
  OwnedCodexBackendReady,
  OwnedCodexBackendSettlement,
  OwnedCodexBackendStatus,
} from "../src/session-host/native-codex-backend";
import type { NativeCodexBackendVersionProof, NativeCodexTuiRootFactsSnapshot } from "../src/session-host/native-codex-tui-root-facts";
import type { NativeCodexOwnedLaunchPlan, NativeCodexOwnedTuiConnection } from "../src/session-host/native-cli-launch";
import {
  createNativeManagedConversationOwner,
  type NativeManagedConversationOwnerOptions,
} from "../src/session-host/native-managed-conversation-owner";
import { createNativeManagedHostLane, type NativeManagedHostLaneInput } from "../src/session-host/native-managed-host-lane";
import type { NativeMcpLaunchOutcome } from "../src/session-host/native-mcp-launch-prep";
import type { NativeMcpToolEndpoint } from "../src/session-host/native-mcp-stdio";
import { sessionHostStateDir } from "../src/session-host/roster-store";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import { initGitRepo, waitFor } from "./helpers/background-controller-fixtures";
import { queuedTask } from "./managed-tool-fixtures";

const SUPPORTED_CODEX = "0.171.0";
/** The fake lease's reserved TUI auth environment name; the relay derives its own TUI material from it. */
const TUI_AUTH_ENV = "PI_REVIEW_GATE_TEST_CODEX_AUTH";
const THREAD_A = "019a0000-0000-7000-8000-00000000c682";
const THREAD_B = "019a0000-0000-7000-8000-00000000d682";
const RELAY_GENERATION = "relay-generation-1";
const TURN_BUSY = "turn-busy-1";
const TURN_OLD = "turn-old-0";
const PI_FILE = "/synthetic/pi/dist/cli.js";
const linuxOnly = { skip: process.platform !== "linux" ? "the owned Codex callback probe is Linux-only" : false };

const CEILING = Object.freeze({
  loadSdk: () => ({
    parseArgs: () => ({ offline: true }),
    createReadToolDefinition: () => ({ name: "read", description: "Read files." }),
    createBashToolDefinition: () => ({ name: "bash", description: "Execute a command." }),
  }),
  nativePowerShellSupported: () => false,
});

const text = (result: { readonly content: readonly Record<string, unknown>[] } | undefined) =>
  String(result?.content.map((item) => item.text).join("\n"));
const settle = (ms = 150) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const request = () => ({ signal: new AbortController().signal });
const BASELINE_TOOLS = Object.freeze(["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);
/** The proved listing with Watch, in the canonical action order (Watch follows Inspect). */
const WITH_WATCH = Object.freeze(["SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean"]);

/* ------------------------------------------------------------------------- *
 * Owned scratch                                                              *
 * ------------------------------------------------------------------------- */

interface Scratch {
  readonly root: string;
  readonly agentDir: string;
  readonly home: string;
  readonly workspace: string;
  readonly release: string;
  defer(dispose: () => unknown): void;
}

interface TestHooks { after(fn: () => void | Promise<void>): void }

/** One owned scratch per test, removed (with TMPDIR restored) on every exit. */
function ownedScratch(t: TestHooks): Scratch {
  const disposers: Array<() => unknown> = [];
  const tempVars = ["TMPDIR", "TMP", "TEMP"] as const;
  let original: Array<string | undefined> | undefined;
  let created: string | undefined;
  t.after(async () => {
    try {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch {
          // Every later disposer and the root removal still run.
        }
      }
    } finally {
      if (original !== undefined) {
        for (const [index, key] of tempVars.entries()) {
          const value = original[index];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      if (created !== undefined) {
        rmSync(created, { recursive: true, force: true });
        assert.equal(existsSync(created), false, "the scratch is removed immediately");
      }
    }
  });
  const raw = mkdtempSync(join(tmpdir(), "prg-native-managed-codex-delivery-"));
  created = raw;
  const root = realpathSync(raw);
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  for (const dir of [agentDir, home, workspace, artifacts]) mkdirSync(dir, { mode: 0o700 });
  mkdirSync(sessionHostStateDir(agentDir), { mode: 0o700 });
  original = tempVars.map((key) => process.env[key]);
  for (const key of tempVars) process.env[key] = artifacts;
  return { root, agentDir, home, workspace, release: join(root, "release"), defer: (dispose) => { disposers.push(dispose); } };
}

/** Saved settings whose only worker is a fake executor that lands one file once `release` exists. */
function writeLandingSettings(scratch: Scratch): void {
  const executor = join(scratch.root, "executor.cjs");
  writeFileSync(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
    `const release=${JSON.stringify(scratch.release)};`,
    "const finish=()=>{fs.writeFileSync('landed.txt','landed\\n');",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));};",
    "const poll=setInterval(()=>{if(fs.existsSync(release)){clearInterval(poll);finish();}},20);",
    "});",
  ].join("\n"), "utf8");
  chmodSync(executor, 0o755);
  writeFileSync(join(scratch.agentDir, "review-gate.json"), JSON.stringify({
    enabled: true,
    executorTimeoutMs: 120_000,
    review: { activeReviewers: [] },
    externalAgents: { fake: { adapter: "run-as-binary", command: executor, execution: { protocol: "pi-review-executor-jsonl-v1" } } },
    execution: {
      maxWorkers: 1,
      workerResources: { default: { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
  }));
}

/* ------------------------------------------------------------------------- *
 * Synthetic owned app-server                                                 *
 * ------------------------------------------------------------------------- */

type Frame = Record<string, unknown>;

interface AppServer {
  readonly port: number;
  readonly frames: Frame[];
  upgrades: number;
  /** Bearers this server accepts: one per owned lease, so each backend is distinguishable. */
  readonly bearers: Set<string>;
  /** The bearer each accepted upgrade presented, in order. */
  readonly connectedBearers: string[];
  /** When set, the `initialize` answer waits for this promise. */
  initializeGate: Promise<void> | undefined;
  /** Server-side sockets still open. */
  openSockets(): number;
  methods(): string[];
  close(): Promise<void>;
}

/** One bearer-checked loopback app-server; its close is deferred the moment it listens. */
async function startAppServer(scratch: Scratch): Promise<AppServer> {
  const server = http.createServer((_req, res) => { res.writeHead(404).end(); });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const app: AppServer = {
    port: 0,
    frames: [],
    upgrades: 0,
    bearers: new Set<string>(),
    connectedBearers: [],
    initializeGate: undefined,
    openSockets: () => sockets.size,
    methods: () => app.frames.filter((frame) => frame.id !== undefined).map((frame) => String(frame.method)),
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const answer = (frame: Frame): Frame => {
    const params = (frame.params ?? {}) as Frame;
    switch (frame.method) {
      case "initialize":
        // Only the genuine TUI's own handshake is answered with a full Codex
        // user agent; every other client (the delivery transport) sees "synthetic".
        return { result: {
          codexHome: "/synthetic/codex-home",
          userAgent: (params.clientInfo as Frame | undefined)?.name === "codex-tui"
            ? `codex-tui/${SUPPORTED_CODEX} (Windows 10.0; x86_64)`
            : "synthetic",
          platformFamily: "unix",
        } };
      case "thread/start":
        return { result: { thread: { id: THREAD_A } } };
      case "turn/start":
        return { result: { turn: { id: TURN_BUSY, status: "inProgress" } } };
      case "turn/steer":
        return { result: { turnId: params.expectedTurnId } };
      case "thread/queue/add":
        return { result: { queuedSubmission: { id: "queued-row-1", input: params.input, clientUserMessageId: params.clientUserMessageId } } };
      case "thread/queue/start":
        return { result: { turn: { id: "turn-new-9", status: "inProgress" } } };
      default:
        return { error: { code: -32601, message: "method not found" } };
    }
  };
  server.on("upgrade", (req, socket, head) => {
    app.upgrades += 1;
    const presented = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined;
    if (req.url !== "/rpc" || presented === undefined || !app.bearers.has(presented)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    app.connectedBearers.push(presented);
    wss.handleUpgrade(req, socket as net.Socket, head, (client) => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Frame;
        app.frames.push(frame);
        if (frame.id === undefined) return;
        const reply = (): void => {
          if (client.readyState === client.OPEN) client.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...answer(frame) }));
        };
        if (frame.method === "initialize" && app.initializeGate !== undefined) void app.initializeGate.then(reply);
        else reply();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  scratch.defer(() => app.close());
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  (app as { port: number }).port = address.port;
  return app;
}

/* ------------------------------------------------------------------------- *
 * Synthetic owned lease, PTY, observer                                       *
 * ------------------------------------------------------------------------- */

/** An owned backend lease whose readiness names the synthetic app-server and carries the callback facts. */
class FakeOwnedLease {
  /** The real composite lease wrapping this fake, when the harness runs the real relay. */
  relayed?: OwnedCodexBackendLease;
  facts: NativeCodexCallbackRootFacts | null = null;
  /** #682 candidate seam: the relayed backend handshake proof this lease's reader answers. */
  backendVersion: NativeCodexBackendVersionProof | null = null;
  backendVersionReads = 0;
  snapshot: NativeCodexTuiRootFactsSnapshot = Object.freeze({ phase: "bound" as const, rootThreadId: THREAD_A });
  stopRequested = false;
  #settled = false;
  readonly readiness: Promise<OwnedCodexBackendReady>;
  readonly settlement: Promise<OwnedCodexBackendSettlement>;
  #resolveReady!: (ready: OwnedCodexBackendReady) => void;
  #resolveSettlement!: (settlement: OwnedCodexBackendSettlement) => void;
  /** This lease's own observer bearer; the synthetic server accepts it as THIS backend. */
  readonly token = `synthetic-bearer-${randomBytes(12).toString("hex")}`;
  constructor(readonly identity: OwnedCodexBackendLaunchIdentity, readonly port: () => number) {
    this.readiness = new Promise((resolve) => { this.#resolveReady = resolve; });
    this.settlement = new Promise((resolve) => { this.#resolveSettlement = resolve; });
  }
  status(): OwnedCodexBackendStatus {
    return {
      identity: { ...this.identity },
      phase: this.#settled ? "settled" : this.stopRequested ? "stopping" : "ready",
      ready: true,
      settled: this.#settled,
      stopRequested: this.stopRequested,
      exitObserved: this.#settled,
    } as unknown as OwnedCodexBackendStatus;
  }
  requestStop(): void { this.stopRequested = true; }
  fulfillReady(): void {
    const endpoint = `ws://127.0.0.1:${this.port()}`;
    this.#resolveReady({
      endpoint,
      readObserverBearer: () => this.token,
      createTuiConnection: () => ({
        endpoint,
        args: ["--remote", endpoint, "--remote-auth-token-env", TUI_AUTH_ENV],
        env: { PATH: "/synthetic/bin", [TUI_AUTH_ENV]: this.token },
      }),
      tuiRootFacts: {
        current: (): NativeCodexTuiRootFactsSnapshot => this.snapshot,
        watch: () => () => undefined,
      },
      tuiRootCallbackFacts: {
        callbackFacts: () => this.facts,
        callbackBackendVersion: () => {
          this.backendVersionReads += 1;
          return this.backendVersion;
        },
      },
    } as unknown as OwnedCodexBackendReady);
  }
  settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveSettlement({ status: "settled", child: "exited", code: 0, signal: null, stdout: "ended", stderr: "ended" } as unknown as OwnedCodexBackendSettlement);
  }
}

class SyntheticPty implements InstancePty {
  static #nextPid = 980_000;
  readonly pid: number;
  cols: number;
  rows: number;
  writes = 0;
  #exited = false;
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = SyntheticPty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
  }
  onData(): { dispose(): void } { return { dispose: () => undefined }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => undefined };
  }
  on(): void {}
  removeListener(): void {}
  write(): void { this.writes += 1; }
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(signal?: string): void {
    if (this.#exited || (signal ?? "SIGHUP") !== "SIGTERM") return;
    this.#exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode: 0, signal: 15 });
  }
}

class SyntheticObserver implements NativeStatusObserver {
  constructor(readonly context: NativeStatusObserverContext) {}
  acceptHook(): void {}
  acceptFailure(): void {}
  dispose(): void {}
}

function ownedPlan(cwd: string): NativeCodexOwnedLaunchPlan {
  return {
    backendEnv: { PATH: "/synthetic/bin" },
    renderBackend: (controlArgs: readonly string[], env: NodeJS.ProcessEnv) => ({ file: "/synthetic/bin/codex", args: ["app-server", ...controlArgs], env: { ...env }, cwd }),
    renderTui: (connection: NativeCodexOwnedTuiConnection) => ({ file: "/synthetic/bin/codex", args: ["--interactive", ...connection.args], env: { ...connection.env } as NodeJS.ProcessEnv, cwd }),
  } as unknown as NativeCodexOwnedLaunchPlan;
}

/* ------------------------------------------------------------------------- *
 * Real manager + real lane harness                                           *
 * ------------------------------------------------------------------------- */

type Receipt = "verified" | "declined" | "unsupported" | "platform-declined" | "platform-declined-bare" | "not-default-target";

interface Harness {
  readonly manager: InstanceManager;
  readonly app: AppServer;
  readonly endpoints: Map<string, NativeMcpToolEndpoint>;
  readonly leases: FakeOwnedLease[];
  readonly ptys: SyntheticPty[];
  readonly owners: { created: NativeManagedConversationOwnerOptions[]; managers: ExecutionToolManager[] };
  readonly sinkCalls: Array<{ readonly kind: string; outcome?: string }>;
  readonly providerCalls: NativeCliLaunchRequest[];
  setReceipt(receipt: Receipt): void;
  /** Launch one owned Codex row, make its lease ready, and prove `thread`. */
  createCodex(thread: string): Promise<{ id: string; lease: FakeOwnedLease }>;
  createClaude(): Promise<string>;
}

async function realHarness(
  scratch: Scratch,
  options: { readonly handshakeVersion?: boolean; readonly realRelay?: boolean } = {},
): Promise<Harness> {
  const packageRoot = join(scratch.root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  for (const file of ["index.js", "session-host/reporter.js", "session-host/bootstrap-preload.js"]) {
    writeFileSync(join(packageRoot, "dist", "src", file), "// Synthetic fixture; never executed.\n", "utf8");
  }
  const piExecutable = join(scratch.root, "bin", "mock-pi");
  mkdirSync(join(scratch.root, "bin"));
  writeFileSync(piExecutable, "#!/usr/bin/env node\n// Synthetic inert fixture.\n", "utf8");
  chmodSync(piExecutable, 0o755);

  const app = await startAppServer(scratch);
  const endpoints = new Map<string, NativeMcpToolEndpoint>();
  const observers = new Map<string, NativeStatusObserverContext>();
  const slots = new Map<string, string>();
  const leases: FakeOwnedLease[] = [];
  const ptys: SyntheticPty[] = [];
  const created: NativeManagedConversationOwnerOptions[] = [];
  const managers: ExecutionToolManager[] = [];
  const sinkCalls: Array<{ readonly kind: string; outcome?: string }> = [];
  const providerCalls: NativeCliLaunchRequest[] = [];
  let receipt: Receipt = "verified";
  let manager: InstanceManager | undefined;

  const hostBroker = {
    register() { throw new Error("no Pi child is registered in this test"); },
    registerNativeHookSource() { throw new Error("unused: the manager receives its own hook registrar"); },
    registerNativeMcpSource(instanceId: string, backend: NativeCliBackend, endpoint: NativeMcpToolEndpoint): NativeMcpRegistration {
      endpoints.set(instanceId, endpoint);
      return {
        bootstrap: {
          version: 1,
          type: "native_mcp_bootstrap",
          socketPath: `/synthetic/native-mcp/${instanceId}.sock`,
          generation: randomUUID(),
          instanceId,
          backend,
          token: randomBytes(32).toString("hex"),
        },
        release: () => undefined,
      };
    },
    async dispose() {},
  };
  const armed = createNativeManagedHostLane({
    platform: "linux",
    broker: hostBroker,
    ownedAgentDir: scratch.agentDir,
    resolveSlotId: (rowId) => slots.get(rowId),
    settings: { env: {}, agentDir: scratch.agentDir },
    pi: { executable: PI_FILE, version: "9.9.9", launchArgs: ["--offline"] },
    // The production accessor, exactly as Main passes it.
    codexCallback: { senderFor: (rowId) => manager?.nativeCodexCallbackSender(rowId) },
    testHooks: {
      ceiling: CEILING,
      createOwner: (options) => {
        created.push(options);
        const sink = options.nativeEventSink;
        const owner = createNativeManagedConversationOwner(sink === undefined ? options : {
          ...options,
          nativeEventSink: async (event) => {
            const call: { readonly kind: string; outcome?: string } = { kind: event.customType === "pi-review-subtask-event" ? event.kind : event.customType };
            sinkCalls.push(call);
            try {
              await sink(event);
              call.outcome = "sent";
            } catch (error) {
              call.outcome = error instanceof Error ? error.message : String(error);
              throw error;
            }
          },
        });
        return Object.freeze({
          delegate: owner.delegate,
          prepare: async () => {
            const result = await owner.prepare();
            const ready = result.status === "ready" ? result.manager : "retainedManager" in result ? result.retainedManager : undefined;
            if (ready !== undefined && !managers.includes(ready)) managers.push(ready);
            return result;
          },
        });
      },
    },
  } satisfies NativeManagedHostLaneInput);
  assert.equal(armed.status, "armed", JSON.stringify(armed));
  if (armed.status !== "armed") throw new Error("unreachable");
  const drainLane = armed.host.drain;
  scratch.defer(() => drainLane());

  const rawBackend: OwnedCodexBackendFactory = (launchRequest) => {
    const lease = new FakeOwnedLease(launchRequest.identity, () => app.port);
    app.bearers.add(lease.token);
    leases.push(lease);
    return lease as unknown as OwnedCodexBackendLease;
  };
  // The REAL composite and relay over the fake lease; only the pre-attach
  // census is stubbed (an empty backend), so no observer connection is opened.
  const relayedBackend = createRelayedOwnedCodexBackendFactory({
    backend: rawBackend,
    preAttachCensus: () => ({ threadIds: Promise.resolve([]), closed: Promise.resolve() }),
  });
  manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: { register() { throw new Error("no Pi child in this test"); } },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch.home, PI_CODING_AGENT_DIR: scratch.agentDir },
    args: [],
    nativeCliLaunch: (backend, launchRequest) => {
      providerCalls.push({ ...launchRequest, env: {} });
      const nativeMcp = launchRequest.nativeMcp === undefined ? undefined : {
        mcp: "prepared",
        backend,
        route: backend === "codex" ? "codex-owned-backend-config" : "claude-mcp-config-file",
        placement: backend === "codex" ? "codex-owned-backend" : "claude-tui",
        serverName: launchRequest.nativeMcp.serverName,
        args: [],
        lease: { root: "/synthetic/mcp-root", bootstrapFile: "/synthetic/mcp-root/bootstrap.json", cleanup: async () => ({ removed: true }) },
      } as unknown as NativeMcpLaunchOutcome;
      return {
        file: `/synthetic/bin/${backend}`,
        args: ["--interactive"],
        env: { PATH: "/synthetic/bin", HOME: scratch.home },
        cwd: launchRequest.workspace,
        ...(nativeMcp === undefined ? {} : { nativeMcp }),
        ...(backend === "codex" ? { ownedCodex: ownedPlan(launchRequest.workspace) } : {}),
        // Answers whatever the test chose, so the manager's OWN validation is
        // what keeps an unsupported or declined receipt from authorizing a sender.
        ...(launchRequest.codexCallbackCompatibility === true ? {
          codexCallbackCompatibility: receipt === "verified"
            ? Object.freeze({ compatibility: "verified", version: SUPPORTED_CODEX })
            : receipt === "unsupported"
              ? Object.freeze({ compatibility: "verified", version: "0.170.0" })
              : receipt === "platform-declined"
                // The launcher's platform-only decline: every non-platform check passed.
                ? Object.freeze({ compatibility: "declined", reason: "unsupported-platform", handshakeEligible: true })
                : receipt === "platform-declined-bare"
                  // The same code for a launch that failed a non-platform check (custom target, ...).
                  ? Object.freeze({ compatibility: "declined", reason: "unsupported-platform" })
                  : receipt === "not-default-target"
                    ? Object.freeze({ compatibility: "declined", reason: "not-default-target" })
                    : Object.freeze({ compatibility: "declined", reason: "version-unsupported" }),
        } : {}),
      } as NativeCliLaunchDescriptor;
    },
    nativeHookRegistrar: {
      registerNativeHookSource: (instanceId, backend) => ({
        bootstrap: { version: 1, socketPath: `/synthetic/native/${instanceId}.sock`, generation: randomUUID(), instanceId, backend, token: randomBytes(32).toString("hex") },
        release: () => undefined,
      }),
    },
    nativeStatusObserverFactory: (context) => {
      observers.set(context.rowId, context);
      return new SyntheticObserver(context);
    },
    nativeMcpLane: armed.host.lane,
    ownedCodexBackendFactory: options.realRelay === true
      ? (launchRequest) => {
        const relayed = relayedBackend(launchRequest);
        leases.at(-1)!.relayed = relayed;
        return relayed;
      }
      : rawBackend,
    // Exactly Main's opt-in.
    nativeCodexCallback: true,
    // #682: the off-by-default candidate seam; no production host passes it.
    ...(options.handshakeVersion === true ? { nativeCodexCallbackHandshakeVersion: true } : {}),
    ptyFactory: (descriptor) => {
      const pty = new SyntheticPty(descriptor);
      ptys.push(pty);
      return pty;
    },
  });
  const owned = manager;
  scratch.defer(async () => {
    for (const lease of leases) lease.settle();
    await owned.dispose();
  });

  return {
    manager: owned,
    app,
    endpoints,
    leases,
    ptys,
    owners: { created, managers },
    sinkCalls,
    providerCalls,
    setReceipt: (next) => { receipt = next; },
    createCodex: async (thread) => {
      const before = leases.length;
      const pending = owned.create({ workspace: scratch.workspace, backend: "codex" } as CreateInstanceOptions);
      await waitFor(() => leases.length === before + 1, 4000);
      const lease = leases.at(-1)!;
      lease.fulfillReady();
      const id = await pending;
      slots.set(id, `slot-${slots.size + 1}`);
      await waitFor(() => observers.has(id), 4000);
      assert.equal(observers.get(id)!.emitConversationIdentity?.(thread), true, "the root thread is proved");
      return { id, lease };
    },
    createClaude: async () => {
      const id = await owned.create({ workspace: scratch.workspace, backend: "claude" } as CreateInstanceOptions);
      slots.set(id, `slot-${slots.size + 1}`);
      return id;
    },
  };
}

const busy = (threadId = THREAD_A, turnId = TURN_BUSY): NativeCodexCallbackRootFacts => ({
  threadId, runId: RELAY_GENERATION, activity: { state: "busy", turnId }, userStop: "none",
});
const idle = (threadId = THREAD_A): NativeCodexCallbackRootFacts => ({
  threadId, runId: RELAY_GENERATION, activity: { state: "idle", lastTurnId: TURN_OLD }, userStop: "none",
});

/** Start one admitted gated task on a row and return its controller task record. */
async function startTask(harness: Harness, rowId: string, title: string) {
  const endpoint = harness.endpoints.get(rowId);
  assert.ok(endpoint);
  const acquiring = new AbortController();
  const listed = await endpoint.listTools({ signal: acquiring.signal });
  // Watch is listed only while this exact run has its current verified sender.
  assert.deepEqual(listed.map((tool) => tool.name), harness.manager.nativeCodexCallbackSender(rowId) === undefined ? BASELINE_TOOLS : WITH_WATCH);
  acquiring.abort();
  const starting = new AbortController();
  const started = await endpoint.callTool({ name: "SubtasksStart", arguments: { tasks: [queuedTask(title)] }, signal: starting.signal });
  assert.equal(started?.isError, false, text(started));
  starting.abort();
  const manager = harness.owners.managers.at(-1)!;
  const controller = (manager as unknown as { controller: { groups: Map<string, { tasks: Array<{ taskId: string; state: string }> }> } }).controller;
  const group = [...controller.groups.values()].at(-1);
  assert.ok(group);
  return group.tasks[0]!;
}

/** The owner manager's armed one-shot watches (the controller's single per-execution subscription). */
function armedWatches(manager: ExecutionToolManager): Map<string, { readonly subscription: { readonly dueAt: string } }> {
  return (manager as unknown as { controller: { wakes: { watches: Map<string, { subscription: { dueAt: string } }> } } }).controller.wakes.watches;
}

/** The execution id that owns one controller task in the owner's manager. */
function executionOf(manager: ExecutionToolManager, taskId: string): string {
  const controller = (manager as unknown as { controller: { groups: Map<string, { executionId: string; tasks: Array<{ taskId: string }> }> } }).controller;
  const group = [...controller.groups.values()].find((entry) => entry.tasks.some((task) => task.taskId === taskId));
  assert.ok(group);
  return group.executionId;
}

/* ------------------------------------------------------------------------- *
 * End to end through the production glue                                    *
 * ------------------------------------------------------------------------- */

test("end to end: a busy root receives the canonical completion as one expected-turn steer on its exact thread", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch);
  const a = await harness.createCodex(THREAD_A);
  const b = await harness.createCodex(THREAD_B);
  a.lease.facts = busy();
  b.lease.facts = busy(THREAD_B);

  const codexRequests = harness.providerCalls.filter((call) => call.codexCallbackCompatibility === true);
  assert.equal(codexRequests.length, 2, "each managed Codex launch asks for its version receipt beside its MCP option");
  assert.ok(codexRequests.every((call) => call.nativeMcp !== undefined));
  const senderA = harness.manager.nativeCodexCallbackSender(a.id);
  assert.ok(senderA);
  assert.equal(senderA.conversationId, THREAD_A);
  assert.equal(senderA.version, SUPPORTED_CODEX);
  assert.equal(senderA.leaseId, a.lease.identity.leaseId);
  assert.equal(harness.manager.nativeCodexCallbackSender(a.id), senderA, "one stable sender per lane");

  const task = await startTask(harness, a.id, "codex busy completion");
  const owner = harness.owners.created[0]!;
  assert.equal(typeof owner.nativeEventSink, "function", "the Codex hold's owner receives the run-bound sink");
  assert.equal(owner.notify, undefined);
  assert.equal(harness.app.upgrades, 0, "nothing is sent before the outcome");

  writeFileSync(scratch.release, "go\n");
  await waitFor(() => task.state === "landed", 20_000);
  await waitFor(() => harness.sinkCalls.some((call) => call.outcome !== undefined), 8000);
  await settle();

  assert.deepEqual(harness.sinkCalls, [{ kind: "completion", outcome: "sent" }], "only the completion; one attempt");
  assert.equal(harness.app.upgrades, 1, "one connection, never retried");
  assert.notEqual(a.lease.token, b.lease.token);
  assert.deepEqual(harness.app.connectedBearers, [a.lease.token],
    "only the owning row's backend (its own lease bearer) received a connection, never the sibling's");
  assert.deepEqual(harness.app.methods(), ["initialize", "turn/steer"]);
  const steer = harness.app.frames.find((frame) => frame.method === "turn/steer")!;
  const params = steer.params as { threadId: string; expectedTurnId: string; clientUserMessageId: string; input: Array<{ type: string; text: string }> };
  assert.equal(params.threadId, THREAD_A, "the exact owned root thread, never the sibling row's");
  assert.equal(params.expectedTurnId, TURN_BUSY);
  assert.match(params.clientUserMessageId, /^pi-managed-[0-9a-f-]{36}$/);
  assert.ok(params.input[0]!.text.startsWith(`Task ${task.taskId} landed independently`), params.input[0]!.text);
  assert.equal(harness.ptys.reduce((sum, pty) => sum + pty.writes, 0), 0, "no PTY write");
  await waitFor(() => harness.app.openSockets() === 0, 4000);
  assert.ok(!harness.app.methods().includes("turn/start"));
});

test("end to end: an idle root receives the completion through the atomic idle queue only", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch);
  const a = await harness.createCodex(THREAD_A);
  a.lease.facts = idle();
  const task = await startTask(harness, a.id, "codex idle completion");
  writeFileSync(scratch.release, "go\n");
  await waitFor(() => task.state === "landed", 20_000);
  await waitFor(() => harness.sinkCalls.some((call) => call.outcome !== undefined), 8000);
  await settle();
  assert.deepEqual(harness.sinkCalls, [{ kind: "completion", outcome: "sent" }]);
  assert.deepEqual(harness.app.methods(), ["initialize", "thread/queue/add", "thread/queue/start"]);
  for (const frame of harness.app.frames.filter((entry) => String(entry.method).startsWith("thread/queue/"))) {
    assert.equal((frame.params as { threadId: string }).threadId, THREAD_A);
  }
});

test("end to end: a current Codex run arms one Watch whose checkpoint takes the one-attempt callback path; completion supersedes a later watch", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch);
  const a = await harness.createCodex(THREAD_A);
  const b = await harness.createCodex(THREAD_B);
  a.lease.facts = busy();
  b.lease.facts = busy(THREAD_B);
  // startTask asserts the proved listing carries Watch after the baseline.
  assert.ok(harness.manager.nativeCodexCallbackSender(a.id));
  const task = await startTask(harness, a.id, "codex watch");
  const manager = harness.owners.managers.at(-1)!;
  const executionId = executionOf(manager, task.taskId);
  const endpoint = harness.endpoints.get(a.id)!;

  const armed = await endpoint.callTool({ name: "SubtasksWatch", arguments: { executionId, after: "1s" }, signal: request().signal });
  assert.equal(armed?.isError, false, text(armed));
  assert.match(text(armed), new RegExp(`^SubtasksWatch armed for ${executionId}; if work is still active after 1s, one checkpoint delivery to this conversation will be attempted once; it is not guaranteed to start a turn and is never retried\\.`));
  assert.doesNotMatch(text(armed), /will trigger a turn/, "the native result never promises a turn");
  assert.deepEqual([...armedWatches(manager).keys()], [executionId], "one watch, on the controller's own timer");

  await waitFor(() => harness.sinkCalls.some((call) => call.outcome !== undefined), 8000);
  await settle();
  assert.deepEqual(harness.sinkCalls, [{ kind: "pi-review-subtask-watch", outcome: "sent" }], "one checkpoint attempt, never retried");
  assert.equal(armedWatches(manager).size, 0, "one-shot: nothing stays armed after it fired");
  assert.deepEqual(harness.app.connectedBearers, [a.lease.token], "only the exact run's own backend");
  assert.deepEqual(harness.app.methods(), ["initialize", "turn/steer"]);
  const steer = harness.app.frames.find((frame) => frame.method === "turn/steer")!;
  const params = steer.params as { threadId: string; input: Array<{ text: string }> };
  assert.equal(params.threadId, THREAD_A, "the exact owned root thread");
  assert.ok(params.input[0]!.text.startsWith("[pi-review-subtask-watch]"), params.input[0]!.text);
  assert.match(params.input[0]!.text, new RegExp(executionId));
  assert.equal(task.state === "landed", false, "the checkpoint changed no work");

  // A later watch is superseded by the canonical completion: it never fires.
  const rearmed = await endpoint.callTool({ name: "SubtasksWatch", arguments: { executionId, after: "1h" }, signal: request().signal });
  assert.equal(rearmed?.isError, false, text(rearmed));
  assert.equal(armedWatches(manager).size, 1);
  writeFileSync(scratch.release, "go\n");
  await waitFor(() => task.state === "landed", 20_000);
  // The completion wake retires the armed watch: its timer is cleared, so it never fires.
  await waitFor(() => armedWatches(manager).size === 0, 1500);
  await waitFor(() => harness.sinkCalls.length === 2 && harness.sinkCalls[1]!.outcome !== undefined, 8000);
  await settle(300);
  assert.deepEqual(harness.sinkCalls, [
    { kind: "pi-review-subtask-watch", outcome: "sent" },
    { kind: "completion", outcome: "sent" },
  ], "only the checkpoint and the completion; the retired watch sends nothing");
  assert.equal(harness.ptys.reduce((sum, pty) => sum + pty.writes, 0), 0, "no PTY write");
  assert.ok(!harness.app.methods().includes("turn/start"));
});

test("end to end: a user stop, unknown activity, or stale facts send nothing and open nothing", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch);
  const a = await harness.createCodex(THREAD_A);
  a.lease.facts = { ...busy(), userStop: "stopped" };
  const task = await startTask(harness, a.id, "codex stopped root");
  writeFileSync(scratch.release, "go\n");
  await waitFor(() => task.state === "landed", 20_000);
  await waitFor(() => harness.sinkCalls.some((call) => call.outcome !== undefined), 8000);
  await settle(200);
  assert.equal(task.state, "landed", "a refused delivery never changes the worker outcome");
  assert.equal(harness.sinkCalls.length, 1, "one attempt, never retried");
  assert.match(harness.sinkCalls[0]!.outcome ?? "", /not delivered \(user-stopped\); nothing is pending/);
  assert.equal(harness.app.upgrades, 0, "a stopped root never even gets a connection");

  // The same captured sink, re-driven directly: unknown activity and facts
  // naming another thread are refused the same way.
  const sink = harness.owners.created[0]!.nativeEventSink!;
  const event: ManagedNativeEvent = Object.freeze({
    customType: "pi-review-subtask-event", kind: "completion", executionId: "exec", taskId: task.taskId, state: "landed",
    content: "late completion", diagnostic: undefined, delivery: { deliverAs: "steer" as const, triggerTurn: true },
  });
  a.lease.facts = { ...busy(), activity: { state: "unknown" } };
  await assert.rejects(Promise.resolve(sink(event)), /not delivered \(facts-unknown\)/);
  a.lease.facts = busy(THREAD_B);
  await assert.rejects(Promise.resolve(sink(event)), /no current verified callback sender/);
  assert.equal(harness.app.upgrades, 0);
});

test("end to end: a stop requested while the transport handshakes is fenced before any write", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch);
  const a = await harness.createCodex(THREAD_A);
  a.lease.facts = busy();
  let open: () => void = () => undefined;
  harness.app.initializeGate = new Promise<void>((resolve) => { open = resolve; });
  const task = await startTask(harness, a.id, "codex stop race");
  writeFileSync(scratch.release, "go\n");
  await waitFor(() => task.state === "landed", 20_000);
  await waitFor(() => harness.app.methods().includes("initialize"), 8000);
  // The owned backend is asked to stop while `initialize` is unanswered.
  a.lease.requestStop();
  open();
  await waitFor(() => harness.sinkCalls.some((call) => call.outcome !== undefined), 8000);
  assert.match(harness.sinkCalls[0]!.outcome ?? "", /not delivered/);
  assert.deepEqual(harness.app.methods(), ["initialize"], "no callback frame was written");
  assert.equal(harness.manager.nativeCodexCallbackSender(a.id), undefined, "a stopping backend has no sender");
});

test("end to end: a withdrawn root revokes the run; nothing is sent and no socket is opened", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch);
  const a = await harness.createCodex(THREAD_A);
  a.lease.facts = busy();
  const task = await startTask(harness, a.id, "codex revoked run");
  const sink = harness.owners.created[0]!.nativeEventSink!;
  const sender = harness.manager.nativeCodexCallbackSender(a.id);
  assert.ok(sender);

  // The owned root withdraws (a second connection, a closed generation, ...):
  // the lane and its run are revoked; the backend keeps running.
  a.lease.facts = null;
  a.lease.snapshot = Object.freeze({ phase: "withdrawn" as const, withdrawal: "second-connection" as const });
  assert.equal(sender.isCurrent(), false);
  assert.equal(harness.manager.nativeCodexCallbackSender(a.id), undefined);
  assert.equal(a.lease.stopRequested, false, "the backend itself is untouched");
  const event: ManagedNativeEvent = Object.freeze({
    customType: "pi-review-subtask-event", kind: "completion", executionId: "exec", taskId: task.taskId, state: "landed",
    content: "late completion", diagnostic: undefined, delivery: { deliverAs: "steer" as const, triggerTurn: true },
  });
  await assert.rejects(Promise.resolve(sink(event)), /no longer current; nothing was sent/);
  // A direct attempt on the captured sender object is refused before any socket.
  const direct = await sender.deliver({ clientUserMessageId: "direct-1", text: "late" });
  assert.equal(direct.delivery, "not-delivered");
  assert.equal(harness.app.upgrades, 0);

  // A Watch checkpoint of the revoked run is refused by the same fence.
  await assert.rejects(Promise.resolve(sink(Object.freeze({
    customType: "pi-review-subtask-watch", content: "watch", executions: [], delivery: { deliverAs: "steer" as const, triggerTurn: true },
  }) as unknown as ManagedNativeEvent)), /no longer current; nothing was sent/);
  assert.equal(harness.app.upgrades, 0);
});

test("an unverified or unsupported receipt authorizes no sender; Claude launches ask for nothing", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch);
  harness.setReceipt("declined");
  const declined = await harness.createCodex(THREAD_A);
  declined.lease.facts = busy();
  assert.equal(harness.manager.nativeCodexCallbackSender(declined.id), undefined);
  harness.setReceipt("unsupported");
  const unsupported = await harness.createCodex(THREAD_B);
  unsupported.lease.facts = busy(THREAD_B);
  assert.equal(harness.manager.nativeCodexCallbackSender(unsupported.id), undefined, "a version outside the verified set is not evidence");

  const sinkTask = await startTask(harness, declined.id, "unverified receipt");
  // Without a verified sender Watch is neither listed (startTask) nor armed.
  const declinedManager = harness.owners.managers.at(-1)!;
  const refused = await harness.endpoints.get(declined.id)!.callTool({
    name: "SubtasksWatch", arguments: { executionId: executionOf(declinedManager, sinkTask.taskId), after: "1s" }, signal: request().signal,
  });
  assert.equal(refused?.isError, true);
  assert.match(text(refused), /SubtasksWatch is not allowed by this owner's live call policy/);
  assert.equal(armedWatches(declinedManager).size, 0, "an unsupported run arms nothing");
  const sink = harness.owners.created[0]!.nativeEventSink!;
  await assert.rejects(Promise.resolve(sink(Object.freeze({
    customType: "pi-review-subtask-event", kind: "completion", executionId: "exec", taskId: sinkTask.taskId, state: "landed",
    content: "completion", diagnostic: undefined, delivery: { deliverAs: "steer" as const, triggerTurn: true },
  }))), /no current verified callback sender/);
  assert.equal(harness.app.upgrades, 0);

  const claude = await harness.createClaude();
  const claudeCall = harness.providerCalls.at(-1)!;
  assert.equal("codexCallbackCompatibility" in claudeCall, false, "a Claude launch is unchanged");
  assert.equal(harness.manager.nativeCodexCallbackSender(claude), undefined);
});

test("the Codex callback opt-in is refused when half wired", (t) => {
  const scratch = ownedScratch(t);
  const base = {
    packageRoot: "/synthetic",
    piExecutable: "/synthetic/pi",
    env: { HOME: scratch.home, PI_CODING_AGENT_DIR: scratch.agentDir },
    statusRegistrar: { register() { throw new Error("unused"); } },
    nativeHookRegistrar: { registerNativeHookSource() { throw new Error("unused"); } },
    nativeStatusObserverFactory: () => ({ acceptHook() {}, acceptFailure() {}, dispose() {} }),
  };
  assert.throws(() => new InstanceManager({ ...base, nativeCodexCallback: true }), /requires nativeMcpLane and ownedCodexBackendFactory/);
  assert.throws(() => new InstanceManager({ ...base, nativeCodexCallback: "yes" as unknown as boolean }), /must be a boolean or absent/);
  const manager = new InstanceManager({ ...base });
  assert.equal(manager.nativeCodexCallbackSender("any"), undefined, "no opt-in, no sender");
});

/* ------------------------------------------------------------------------- *
 * Lane-level sink selection                                                  *
 * ------------------------------------------------------------------------- */

function makeRun(): { run: NativeMcpLaneRunScope; revoke(): void } {
  const controller = new AbortController();
  let current = true;
  const run: NativeMcpLaneRunScope = Object.freeze({ signal: controller.signal, isCurrent: () => current && !controller.signal.aborted });
  return { run, revoke: () => { current = false; controller.abort(); } };
}

function laneContext(
  identity: { rowId: string; backend: "claude" | "codex"; workspace: string; conversationId: string },
  run: NativeMcpLaneRunScope,
): NativeMcpLaneContext {
  const signal = AbortSignal.any([new AbortController().signal, run.signal]);
  return Object.freeze({ ...identity, signal, isCurrent: () => !signal.aborted && run.isCurrent(), run });
}

test("the lane gives only Codex holds with the host accessor a Codex sink and pins the first sender", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  writeLandingSettings(scratch);
  await initGitRepo(scratch.workspace);
  const created: NativeManagedConversationOwnerOptions[] = [];
  const senders = new Map<string, NativeCodexCallbackSender>();
  const delivered: string[] = [];
  const fakeSender = (conversationId: string, label: string): NativeCodexCallbackSender => Object.freeze({
    conversationId,
    leaseId: `lease-${label}`,
    generation: 1,
    version: SUPPORTED_CODEX,
    isCurrent: () => true,
    deliver: async () => {
      delivered.push(label);
      return Object.freeze({
        route: "composed" as const,
        outcome: Object.freeze({ route: "fault" as const, delivery: "unknown" as const }),
        delivery: "sent-unconfirmed" as const,
        socketClosed: Promise.resolve(),
      }) as never;
    },
  });
  const input = (overrides: Partial<NativeManagedHostLaneInput>): NativeManagedHostLaneInput => ({
    platform: "linux",
    broker: {
      register() { throw new Error("unused"); },
      registerNativeHookSource() { throw new Error("unused"); },
      registerNativeMcpSource() { throw new Error("unused"); },
      async dispose() {},
    },
    ownedAgentDir: scratch.agentDir,
    resolveSlotId: (rowId) => ({ "row-a": "slot-a", "row-c": "slot-c" } as Record<string, string>)[rowId],
    settings: { env: {}, agentDir: scratch.agentDir },
    pi: { executable: PI_FILE, version: "9.9.9", launchArgs: ["--offline"] },
    testHooks: { ceiling: CEILING, createOwner: (options) => { created.push(options); return createNativeManagedConversationOwner(options); } },
    ...overrides,
  });
  const armed = createNativeManagedHostLane(input({ codexCallback: { senderFor: (rowId) => senders.get(rowId) } }));
  assert.equal(armed.status, "armed");
  if (armed.status !== "armed") return;
  const drainArmed = armed.host.drain;
  scratch.defer(() => drainArmed());
  const codex = { rowId: "row-a", backend: "codex" as const, workspace: scratch.workspace, conversationId: THREAD_A };

  // A Claude hold never gets the Codex sink.
  await armed.host.lane.delegate.listTools(laneContext({ ...codex, rowId: "row-c", backend: "claude" }, makeRun().run));
  assert.equal(created[0]!.nativeEventSink, undefined, "Claude stays unchanged without its own accessor");

  const first = makeRun();
  await armed.host.lane.delegate.listTools(laneContext(codex, first.run));
  const sink = created[1]!.nativeEventSink;
  assert.equal(typeof sink, "function");
  const EVENT: ManagedNativeEvent = Object.freeze({
    customType: "pi-review-subtask-event", kind: "completion", executionId: "exec-1", taskId: "task-1", state: "landed",
    content: "Task task-1 landed independently.", diagnostic: undefined, delivery: { deliverAs: "steer" as const, triggerTurn: true },
  });
  // No sender yet (the hold may be acquired at candidate time): refused.
  await assert.rejects(Promise.resolve(sink!(EVENT)), /no current verified callback sender/);
  // Another conversation's sender on the same row is never used.
  senders.set("row-a", fakeSender(THREAD_B, "other-thread"));
  await assert.rejects(Promise.resolve(sink!(EVENT)), /no current verified callback sender/);
  senders.set("row-a", fakeSender(THREAD_A, "first"));
  await sink!(EVENT);
  // A different sender later (another lane, lease, or generation) is never targeted.
  senders.set("row-a", fakeSender(THREAD_A, "successor"));
  await assert.rejects(Promise.resolve(sink!(EVENT)), /no current verified callback sender/);
  first.revoke();
  await assert.rejects(Promise.resolve(sink!(EVENT)), /no longer current/);
  assert.deepEqual(delivered, ["first"]);

  // Without (or with an invalid) accessor, a Codex hold gets no sink.
  for (const codexCallback of [undefined, { senderFor: "nope" }, null]) {
    const other = createNativeManagedHostLane(input({ codexCallback: codexCallback as never }));
    assert.equal(other.status, "armed");
    if (other.status !== "armed") continue;
    const drainOther = other.host.drain;
    scratch.defer(() => drainOther());
    const count = created.length;
    await other.host.lane.delegate.listTools(laneContext({ ...codex, rowId: "row-c", conversationId: THREAD_B }, makeRun().run));
    assert.equal(created.length, count + 1);
    assert.equal(created.at(-1)!.nativeEventSink, undefined);
  }
});

test("Codex Watch: listed and armed only from the exact current run with its current, pinned sender; a refused call never redirects an armed watch", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  writeLandingSettings(scratch);
  await initGitRepo(scratch.workspace);
  const managers: ExecutionToolManager[] = [];
  const senders = new Map<string, NativeCodexCallbackSender>();
  const delivered: Array<{ readonly label: string; readonly text: string }> = [];
  const fakeSender = (conversationId: string, label: string): NativeCodexCallbackSender & { revoke(): void } => {
    let current = true;
    return Object.freeze({
      conversationId,
      leaseId: `lease-${label}`,
      generation: 1,
      version: SUPPORTED_CODEX,
      isCurrent: () => current,
      revoke: () => { current = false; },
      deliver: async (input: { readonly text: string }) => {
        delivered.push({ label, text: input.text });
        return Object.freeze({
          route: "composed" as const,
          outcome: Object.freeze({ route: "fault" as const, delivery: "unknown" as const }),
          delivery: "sent-unconfirmed" as const,
          socketClosed: Promise.resolve(),
        }) as never;
      },
    });
  };
  const armed = createNativeManagedHostLane({
    platform: "linux",
    broker: {
      register() { throw new Error("unused"); },
      registerNativeHookSource() { throw new Error("unused"); },
      registerNativeMcpSource() { throw new Error("unused"); },
      async dispose() {},
    },
    ownedAgentDir: scratch.agentDir,
    resolveSlotId: (rowId) => (rowId === "row-a" ? "slot-a" : undefined),
    settings: { env: {}, agentDir: scratch.agentDir },
    pi: { executable: PI_FILE, version: "9.9.9", launchArgs: ["--offline"] },
    codexCallback: { senderFor: (rowId) => senders.get(rowId) },
    testHooks: {
      ceiling: CEILING,
      createOwner: (options) => {
        const owner = createNativeManagedConversationOwner(options);
        return Object.freeze({
          delegate: owner.delegate,
          prepare: async () => {
            const result = await owner.prepare();
            if (result.status === "ready" && !managers.includes(result.manager)) managers.push(result.manager);
            return result;
          },
        });
      },
    },
  });
  assert.equal(armed.status, "armed");
  if (armed.status !== "armed") return;
  const drainArmed = armed.host.drain;
  scratch.defer(() => drainArmed());
  const { lane } = armed.host;
  // The receipt-gated discovery catalog carries exactly the canonical Watch;
  // the baseline pre-proof catalog is unchanged.
  assert.deepEqual(lane.deliveryTools?.map((tool) => tool.name), ["SubtasksWatch"]);
  assert.deepEqual(lane.preProofTools?.map((tool) => tool.name), BASELINE_TOOLS);

  const codex = { rowId: "row-a", backend: "codex" as const, workspace: scratch.workspace, conversationId: THREAD_A };
  const first = makeRun();
  const names = async () => (await lane.delegate.listTools(laneContext(codex, first.run))).map((tool) => tool.name);
  assert.deepEqual(await names(), BASELINE_TOOLS, "no sender: no Watch");
  const started = await lane.delegate.callTool(laneContext(codex, first.run), { name: "SubtasksStart", arguments: { tasks: [queuedTask("lane watch")] } });
  assert.equal(started?.isError, false, text(started));
  const manager = managers[0]!;
  const controller = (manager as unknown as { controller: { groups: Map<string, { executionId: string; tasks: Array<{ state: string }> }> } }).controller;
  const [group] = [...controller.groups.values()];
  assert.ok(group);
  const executionId = group.executionId;
  const watch = (after: string) => lane.delegate.callTool(laneContext(codex, first.run), { name: "SubtasksWatch", arguments: { executionId, after } });
  const refusedByPolicy = async (label: string) => {
    const refused = await watch("1s");
    assert.equal(refused?.isError, true, label);
    assert.match(text(refused), /SubtasksWatch is not allowed by this owner's live call policy; nothing was started or read/, label);
  };

  // Unsupported: no sender, another thread's sender, or a revoked sender never arms.
  await refusedByPolicy("no sender");
  senders.set("row-a", fakeSender(THREAD_B, "other-thread"));
  assert.deepEqual(await names(), BASELINE_TOOLS);
  await refusedByPolicy("another thread");
  const revoked = fakeSender(THREAD_A, "revoked");
  revoked.revoke();
  senders.set("row-a", revoked);
  await refusedByPolicy("revoked sender");
  assert.equal(armedWatches(manager).size, 0);

  // The exact current sender: listed, armed, and its checkpoint takes one attempt.
  const pinned = fakeSender(THREAD_A, "pinned");
  senders.set("row-a", pinned);
  assert.deepEqual(await names(), WITH_WATCH);
  const ok = await watch("1s");
  assert.equal(ok?.isError, false, text(ok));
  assert.match(text(ok), /one checkpoint delivery to this conversation will be attempted once/);
  await waitFor(() => delivered.length === 1, 8000);
  assert.equal(delivered[0]!.label, "pinned");
  assert.ok(delivered[0]!.text.startsWith("[pi-review-subtask-watch]"), delivered[0]!.text);
  assert.equal(armedWatches(manager).size, 0, "one-shot");

  // An armed watch is never redirected: a different sender (now that one is
  // pinned) or a revoked sender cannot re-arm, and the armed one is untouched.
  assert.equal((await watch("1h"))?.isError, false);
  const dueAt = armedWatches(manager).get(executionId)!.subscription.dueAt;
  senders.set("row-a", fakeSender(THREAD_A, "successor"));
  assert.deepEqual(await names(), BASELINE_TOOLS, "a successor sender is never offered Watch");
  await refusedByPolicy("successor sender");
  senders.set("row-a", pinned);
  pinned.revoke();
  await refusedByPolicy("pinned sender revoked");
  assert.equal(armedWatches(manager).get(executionId)?.subscription.dueAt, dueAt, "the armed watch is unchanged");

  // A stale run reaches nothing.
  first.revoke();
  await assert.rejects(watch("1s"));
  assert.equal(armedWatches(manager).get(executionId)?.subscription.dueAt === dueAt || armedWatches(manager).size === 0, true,
    "a stale call never arms or replaces a watch");
  // Let the gated executor finish; the revoked run's sink sends nothing more.
  writeFileSync(scratch.release, "go\n");
  await settle(300);
  assert.deepEqual(delivered.map((entry) => entry.label), ["pinned"], "nothing else was sent");
});

/* ------------------------------------------------------------------------- *
 * #682 candidate seam: owned backend handshake version (off in production)  *
 * ------------------------------------------------------------------------- */

const handshakeProof = (overrides: Partial<NativeCodexBackendVersionProof> = {}): NativeCodexBackendVersionProof => Object.freeze({
  version: SUPPORTED_CODEX, runId: RELAY_GENERATION, threadId: THREAD_A, ...overrides,
});

test("candidate seam: a platform-declined run has no sender or Watch until its own backend handshake proves the exact generation and root; then one delivery", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch, { handshakeVersion: true });
  harness.setReceipt("platform-declined");
  const a = await harness.createCodex(THREAD_A);
  a.lease.facts = busy();

  // Before any proof: no sender, baseline listing (asserted by startTask), and Watch refused.
  assert.equal(harness.manager.nativeCodexCallbackSender(a.id), undefined);
  const task = await startTask(harness, a.id, "codex handshake completion");
  const manager = harness.owners.managers.at(-1)!;
  const endpoint = harness.endpoints.get(a.id)!;
  const executionId = executionOf(manager, task.taskId);
  const refused = await endpoint.callTool({ name: "SubtasksWatch", arguments: { executionId, after: "1s" }, signal: request().signal });
  assert.equal(refused?.isError, true);
  assert.match(text(refused), /SubtasksWatch is not allowed by this owner's live call policy/);
  assert.equal(armedWatches(manager).size, 0, "Watch is never armed before proof");

  // Wrong version, wrong root thread, a displaced generation, or a malformed proof prove nothing.
  for (const bad of [
    handshakeProof({ version: "0.170.0" }),
    handshakeProof({ version: "0.171.0-alpha.1" }),
    handshakeProof({ threadId: THREAD_B }),
    handshakeProof({ runId: "relay-generation-0" }),
    { version: SUPPORTED_CODEX } as unknown as NativeCodexBackendVersionProof,
  ]) {
    a.lease.backendVersion = bad;
    assert.equal(harness.manager.nativeCodexCallbackSender(a.id), undefined, JSON.stringify(bad));
    const listed = await endpoint.listTools({ signal: request().signal });
    assert.deepEqual(listed.map((tool) => tool.name), BASELINE_TOOLS, `no Watch for ${JSON.stringify(bad)}`);
  }
  assert.ok(a.lease.backendVersionReads > 0, "the lease's own reader was consulted");
  assert.equal(harness.app.upgrades, 0, "proof needs no connection of its own: the owned backend saw none");

  // The exact current proof: the sender exists, is pinned to it, and Watch lists.
  a.lease.backendVersion = handshakeProof();
  const sender = harness.manager.nativeCodexCallbackSender(a.id);
  assert.ok(sender);
  assert.equal(sender.version, SUPPORTED_CODEX);
  assert.equal(sender.conversationId, THREAD_A);
  assert.equal(sender.leaseId, a.lease.identity.leaseId);
  const listed = await endpoint.listTools({ signal: request().signal });
  assert.deepEqual(listed.map((tool) => tool.name), WITH_WATCH);
  assert.equal(harness.app.upgrades, 0, "still nothing sent before the outcome");

  writeFileSync(scratch.release, "go\n");
  await waitFor(() => task.state === "landed", 20_000);
  await waitFor(() => harness.sinkCalls.some((call) => call.outcome !== undefined), 8000);
  await settle();
  assert.deepEqual(harness.sinkCalls, [{ kind: "completion", outcome: "sent" }]);
  assert.equal(harness.app.upgrades, 1, "only the existing delivery transport connected, once");
  assert.deepEqual(harness.app.connectedBearers, [a.lease.token]);
  assert.deepEqual(harness.app.methods(), ["initialize", "turn/steer"]);
  const steer = harness.app.frames.find((frame) => frame.method === "turn/steer")!;
  assert.equal((steer.params as { threadId: string }).threadId, THREAD_A);
  assert.equal(harness.ptys.reduce((sum, pty) => sum + pty.writes, 0), 0, "no PTY write");
  await waitFor(() => harness.app.openSockets() === 0, 4000);

  // A displaced relay generation retires the pinned sender even if a fresh proof names the new one.
  a.lease.facts = { ...busy(), runId: "relay-generation-2" };
  assert.equal(sender.isCurrent(), false, "the facts moved off the proved generation");
  a.lease.backendVersion = handshakeProof({ runId: "relay-generation-2" });
  assert.equal(sender.isCurrent(), false, "a later generation never inherits the pinned proof");
  assert.equal(harness.manager.nativeCodexCallbackSender(a.id), undefined, "a sender is never retargeted");
  const direct = await sender.deliver({ clientUserMessageId: "direct-after-displace", text: "late" });
  assert.equal(direct.delivery, "not-delivered");
  assert.equal(harness.app.upgrades, 1, "nothing opened after displacement");
});

test("candidate seam: a proof withdrawn after the sender exists fences delivery before any socket", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch, { handshakeVersion: true });
  harness.setReceipt("platform-declined");
  const a = await harness.createCodex(THREAD_A);
  a.lease.facts = busy();
  a.lease.backendVersion = handshakeProof();
  const sender = harness.manager.nativeCodexCallbackSender(a.id);
  assert.ok(sender);
  a.lease.backendVersion = null;
  assert.equal(sender.isCurrent(), false);
  const result = await sender.deliver({ clientUserMessageId: "withdrawn-proof", text: "late" });
  assert.equal(result.delivery, "not-delivered");
  a.lease.backendVersion = handshakeProof({ version: "0.170.0" });
  assert.equal(sender.isCurrent(), false, "a changed version is not the pinned proof");
  assert.equal(harness.app.upgrades, 0);
});

test("candidate seam: off without the opt-in (the production shape)", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  // Production shape: the callback opt-in alone, as Main passes it.
  const off = await realHarness(scratch);
  off.setReceipt("platform-declined");
  const offRow = await off.createCodex(THREAD_A);
  offRow.lease.facts = busy();
  offRow.lease.backendVersion = handshakeProof();
  assert.equal(off.manager.nativeCodexCallbackSender(offRow.id), undefined, "the seam is off unless the host opts in");
  assert.equal(offRow.lease.backendVersionReads, 0, "an un-opted manager never reads the proof");
  const offListed = await off.endpoints.get(offRow.id)!.listTools({ signal: request().signal });
  assert.deepEqual(offListed.map((tool) => tool.name), BASELINE_TOOLS);
});

test("candidate seam: never replaces or follows any probe outcome other than the platform decline", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const on = await realHarness(scratch, { handshakeVersion: true });
  // Only the marked platform-only decline qualifies: a bare platform code (a
  // launch that failed a non-platform check, such as a custom command, args, or
  // env), a non-default target, or any other decline stays declined even with a
  // kept owned lane and a proof reporting the pinned version.
  for (const [index, receipt] of (["platform-declined-bare", "not-default-target", "declined"] as const).entries()) {
    on.setReceipt(receipt);
    const thread = `019a0000-0000-7000-8000-00000000e68${index}`;
    const declined = await on.createCodex(thread);
    declined.lease.facts = busy(thread);
    declined.lease.backendVersion = handshakeProof({ threadId: thread });
    assert.equal(on.manager.nativeCodexCallbackSender(declined.id), undefined, receipt);
    assert.equal(declined.lease.backendVersionReads, 0, `${receipt}: the proof is never consulted`);
    const listed = await on.endpoints.get(declined.id)!.listTools({ signal: request().signal });
    assert.deepEqual(listed.map((tool) => tool.name), BASELINE_TOOLS, `${receipt}: no Watch`);
  }
  // A verified probe receipt keeps the probe path exactly: the handshake is not consulted.
  on.setReceipt("verified");
  const verified = await on.createCodex(THREAD_B);
  verified.lease.facts = busy(THREAD_B);
  verified.lease.backendVersion = handshakeProof({ threadId: THREAD_B, version: "0.170.0" });
  const sender = on.manager.nativeCodexCallbackSender(verified.id);
  assert.ok(sender);
  assert.equal(sender.version, SUPPORTED_CODEX);
  verified.lease.backendVersion = null;
  assert.equal(sender.isCurrent(), true, "the receipt path never depends on the handshake proof");
  assert.equal(verified.lease.backendVersionReads, 0);
});

test("the handshake candidate opt-in is refused without the callback opt-in or as a non-boolean", (t) => {
  const scratch = ownedScratch(t);
  const base = {
    packageRoot: "/synthetic",
    piExecutable: "/synthetic/pi",
    env: { HOME: scratch.home, PI_CODING_AGENT_DIR: scratch.agentDir },
    statusRegistrar: { register() { throw new Error("unused"); } },
    nativeHookRegistrar: { registerNativeHookSource() { throw new Error("unused"); } },
    nativeStatusObserverFactory: () => ({ acceptHook() {}, acceptFailure() {}, dispose() {} }),
  };
  assert.throws(() => new InstanceManager({ ...base, nativeCodexCallbackHandshakeVersion: true }), /requires nativeCodexCallback/);
  assert.throws(() => new InstanceManager({ ...base, nativeCodexCallbackHandshakeVersion: 1 as unknown as boolean }), /must be a boolean or absent/);
});

test("candidate wiring reads the backend's own initialize reply through the real owned composite and relay; no proof connection", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch);
  const harness = await realHarness(scratch, { handshakeVersion: true, realRelay: true });
  harness.setReceipt("platform-declined");
  const row = await harness.createCodex(THREAD_A);
  const endpoint = harness.endpoints.get(row.id)!;
  const ready = await row.lease.relayed!.readiness;
  assert.ok(ready.tuiRootCallbackFacts, "the composite's own callback reader is wired");
  assert.equal(harness.manager.nativeCodexCallbackSender(row.id), undefined, "no TUI handshake yet");
  assert.deepEqual((await endpoint.listTools({ signal: request().signal })).map((tool) => tool.name), BASELINE_TOOLS);
  assert.equal(harness.app.upgrades, 0, "nothing has connected to the owned backend");

  // Play the genuine TUI over the relay endpoint the composite handed out.
  const tui = new WebSocket(`${ready.createTuiConnection().endpoint}/rpc`, {
    headers: { Authorization: `Bearer ${row.lease.token}` },
  });
  scratch.defer(() => tui.terminate());
  await once(tui, "open", { signal: AbortSignal.timeout(4000) });
  const rpc = async (id: number, method: string, params: Frame): Promise<void> => {
    const response = once(tui, "message", { signal: AbortSignal.timeout(4000) });
    tui.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const [data] = await response;
    const reply = JSON.parse(String(data)) as Frame;
    assert.equal(reply.id, id);
    assert.ok(reply.result, method);
  };
  await rpc(1, "initialize", { clientInfo: { name: "codex-tui", version: SUPPORTED_CODEX }, capabilities: { requiredHumanApproval: true } });
  assert.equal(harness.manager.nativeCodexCallbackSender(row.id), undefined, "the handshake alone has no bound root");
  assert.deepEqual((await endpoint.listTools({ signal: request().signal })).map((tool) => tool.name), BASELINE_TOOLS);
  await rpc(2, "thread/start", {});
  await rpc(3, "turn/start", { threadId: THREAD_A, input: [] });

  const sender = harness.manager.nativeCodexCallbackSender(row.id);
  assert.ok(sender, "the relayed handshake proves the bound generation");
  assert.equal(sender.version, SUPPORTED_CODEX);
  assert.equal(sender.conversationId, THREAD_A);
  assert.equal(sender.leaseId, row.lease.identity.leaseId);
  assert.equal(row.lease.backendVersionReads, 0, "the proof came from the composite's reader, never the raw lease");
  assert.deepEqual((await endpoint.listTools({ signal: request().signal })).map((tool) => tool.name), WITH_WATCH);
  assert.deepEqual(harness.app.connectedBearers, [row.lease.token]);
  assert.equal(harness.app.upgrades, 1, "only the TUI connected: no proof connection, no probe child");
  assert.deepEqual(harness.app.methods(), ["initialize", "thread/start", "turn/start"]);

  // The proving generation ends: the sender is retired, never carried over.
  tui.close();
  await waitFor(() => !sender.isCurrent(), 4000);
  assert.equal(harness.manager.nativeCodexCallbackSender(row.id), undefined);
});
