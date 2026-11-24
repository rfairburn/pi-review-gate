/**
 * #682 native Windows Claude callback — the injected custody seam wired to the
 * current conversation's owned callback port.
 *
 * These tests compose the REAL {@linkcode InstanceManager}, the REAL custody
 * adapter (control opt-in), the REAL supervisor transport, and the REAL sender
 * module with portable fakes only: an in-memory supervisor `ChildProcess`
 * (PassThrough pipes, real `close`/`exit` events) that answers the landed
 * control grammar, a synthetic PTY, a fake hook registrar that captures the
 * authenticated-event handlers, a synthetic Claude observer, and a minimal
 * managed MCP lane owner. The Windows host is simulated through the existing
 * platform seams (manager shutdown platform, sender platform).
 *
 * EVIDENCE SCOPE: manager-side correlation, binding, revocation, and the one
 * send attempt over the transport's wire grammar. Nothing is spawned, no
 * PowerShell runs, no pipe or provider is contacted, and no credential is
 * used: the per-run key is derived from a synthetic bootstrap token. Real
 * Windows custody, the protected hook listener, a real Claude child, and
 * public activation still need integrated acceptance on a Windows host.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { inspect } from "node:util";

import {
  InstanceManager,
  __test,
  type InstanceManagerOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunchDescriptor,
  type NativeCliLaunchRequest,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
  type NativeWindowsClaudeCustodyManagerRequest,
  type NativeWindowsClaudeCustodyManagerSelection,
  type StatusRegistrar,
} from "../src/session-host/instances";
import type { NativeHookSourceHandlers } from "../src/session-host/broker";
import type { NativeHookBootstrap, NativeHookEvent } from "../src/session-host/native-hook-protocol";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import {
  createClaudeWindowsCustodyInboxSendCapability,
  sendClaudeInboxMessage,
  setClaudeInboxPlatformForTests,
} from "../src/session-host/native-claude-inbox-delivery";
import {
  createNativeWindowsClaudeCustodyAdapter,
  type NativeWindowsClaudeCustodyAdapter,
  type NativeWindowsClaudeCustodyAdapterDeadlines,
  type NativeWindowsClaudeCustodyAdapterOptions,
} from "../src/session-host/native-windows-claude-custody-adapter";
import { NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES } from "../src/session-host/native-windows-claude-custody-protocol";
import {
  WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC,
  WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC,
  type WindowsClaudeCustodySupervisorLaunch,
} from "../src/session-host/native-windows-claude-custody-scripts";
import {
  WINDOWS_CLAUDE_HOOK_MARKER_ENV,
  deriveWindowsClaudeHookProofKey,
  parseWindowsClaudeHookMarker,
} from "../src/session-host/native-windows-claude-hook-relay";

const POWERSHELL_PATH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const TARGET_PATH = String.raw`C:\Program Files\Claude\claude.exe`;
const SUP_PID = 8400;
const CHILD_PID = 8608;
const SUPPORTED = "2.1.330";
const SESSION_A = "1d6f2b9e-3c4a-4e5f-9a0b-1c2d3e4f5a6b";
const SESSION_B = "8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0";

const TEST_DEADLINES: NativeWindowsClaudeCustodyAdapterDeadlines = Object.freeze({
  readyMs: 400,
  peerMs: 400,
  childMs: 400,
  settleMs: 400,
  wrapperPidMs: 500,
  closeMs: 200,
});

/* --------------------------------------------------------- fake supervisor */

type BindReply = "OK" | "STALE";
type SentReply = "SENT" | "UNKNOWN" | "STALE" | "CUSTODY" | "LIMIT";

/**
 * An in-memory supervisor that answers the landed control grammar after the
 * boot and key frames: `BIND`, `DROP`, and `SEND` replies are automatic (the
 * reply words are configurable), and `SETTLE` completes a clean witnessed
 * settlement (after the harness's `onSettle`, which ends the wrapper).
 */
class ControlSupervisor extends EventEmitter {
  pid: number | undefined = SUP_PID;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  bindReply: BindReply = "OK";
  sentReply: SentReply = "SENT";
  /** Decoded SEND bodies, in order. */
  readonly sends: string[] = [];
  /** While true, DROP replies are withheld (the command stays unanswered). */
  holdDrops = false;
  private readonly heldDrops: string[] = [];
  /** While true, SEND replies are withheld (the attempt stays outstanding). */
  holdSends = false;
  private readonly heldSends: string[] = [];
  onSettle: (() => void) | undefined;
  private written = Buffer.alloc(0);
  private parsed = 0;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written = Buffer.concat([this.written, chunk]);
      this.answer();
    });
  }

  get writtenText(): string {
    return this.written.toString("latin1");
  }

  /** Driver bytes after the fixed boot frame (the key frame line included). */
  commands(): string {
    const text = this.writtenText;
    if (!text.startsWith(WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC)) return "";
    const digits = WINDOWS_CLAUDE_CUSTODY_BOOT_MAGIC.length;
    const length = Number(text.slice(digits, digits + 8));
    if (!Number.isSafeInteger(length)) return "";
    return text.slice(NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES + length);
  }

  private reply(line: string): void {
    setImmediate(() => {
      if (!this.stdout.writableEnded) this.stdout.write(`${line}\n`);
    });
  }

  private answer(): void {
    const text = this.commands();
    for (;;) {
      const end = text.indexOf("\n", this.parsed);
      if (end < 0) return;
      const line = text.slice(this.parsed, end);
      let consumed = end + 1;
      let match: RegExpExecArray | null;
      if ((match = /^BIND (\d+)$/u.exec(line)) !== null) {
        this.reply(`SUP_BIND ${match[1]} ${this.bindReply}`);
      } else if ((match = /^DROP (\d+)$/u.exec(line)) !== null) {
        if (this.holdDrops) this.heldDrops.push(`SUP_DROP ${match[1]}`);
        else this.reply(`SUP_DROP ${match[1]}`);
      } else if ((match = /^SEND (\d+) (\d+) (\d+)$/u.exec(line)) !== null) {
        const bodyEnd = text.indexOf("\n", consumed);
        if (bodyEnd < 0) return;
        this.sends.push(Buffer.from(text.slice(consumed, bodyEnd), "base64").toString("utf8"));
        consumed = bodyEnd + 1;
        if (this.holdSends) this.heldSends.push(`SUP_SENT ${match[1]} ${this.sentReply}`);
        else this.reply(`SUP_SENT ${match[1]} ${this.sentReply}`);
      } else if (line === "SETTLE") {
        setImmediate(() => {
          this.onSettle?.();
          this.stdout.write("SUP_SETTLED ACTIVE=0 LISTED=0\nSUP_BYE\n");
          setImmediate(() => void this.exit(0));
        });
      }
      this.parsed = consumed;
    }
  }

  releaseSends(): void {
    this.holdSends = false;
    for (const line of this.heldSends.splice(0)) this.reply(line);
  }

  releaseDrops(): void {
    this.holdDrops = false;
    for (const line of this.heldDrops.splice(0)) this.reply(line);
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
    this.emit("close", code, signal);
    await settleIo();
  }
}

/* -------------------------------------------------------------- fake PTY */

class SpyPty implements InstancePty {
  static #nextPid = 880_000;
  readonly pid: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  cols: number;
  rows: number;
  exited = false;
  readonly killSignals: string[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = SpyPty.#nextPid += 1;
    this.spawnDescriptor = descriptor;
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
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; }
  pause(): void { /* unused */ }
  resume(): void { /* unused */ }
  kill(signal?: string): void {
    // A direct row's teardown signal ends it at once (custody wrappers settle instead).
    this.killSignals.push(signal ?? "SIGHUP");
    this.emitExit(0);
  }
  emitExit(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode });
  }
}

/* --------------------------------------------------------------- observer */

/** Accepts identity like the real Claude observer: a root SessionStart in the row's workspace. */
/** Test-only: make the spy accept ANY existing CWD, isolating the manager's own CWD rule. */
let spyAcceptsAnyExistingCwd = false;

class SpyObserver implements NativeStatusObserver {
  /** The ONE current identity the owner refused (before activation), re-offered at readiness. */
  #refused: string | undefined;
  /** The identity the owner last accepted from this observer. */
  #accepted: string | undefined;
  constructor(readonly context: NativeStatusObserverContext) {}
  acceptHook(event: NativeHookEvent): void {
    if (event.agent_id !== undefined) return;
    // Like the real observer: a root end closes only its own session's candidate.
    if (event.hook_event_name === "SessionEnd" && event.session_id === this.#refused) this.#refused = undefined;
    // Like the real observer: a proved `/clear` end positively withdraws the ended identity.
    if (event.hook_event_name === "SessionEnd" && event.reason === "clear"
      && event.session_id !== undefined && event.session_id === this.#accepted) {
      this.#accepted = undefined;
      this.context.emitConversationIdentity?.(null);
    }
    if (event.hook_event_name === "SessionStart" && typeof event.session_id === "string"
      && typeof event.cwd === "string" && existsSync(event.cwd)
      && (spyAcceptsAnyExistingCwd || realpathSync(event.cwd) === this.context.workspace)) {
      const accepted = this.context.emitConversationIdentity?.(event.session_id) === true;
      this.#refused = accepted ? undefined : event.session_id;
      if (accepted) this.#accepted = event.session_id;
    }
  }
  /** Like the real Claude acquisition controller: re-offer the refused candidate at activation. */
  observeOwnedStartup(): void {
    const pending = this.#refused;
    this.#refused = undefined;
    if (pending !== undefined && this.context.emitConversationIdentity?.(pending) === true) this.#accepted = pending;
  }
  acceptFailure(): void { /* unused */ }
  dispose(): void { /* unused */ }
}

class RecordingPiRegistrar implements StatusRegistrar {
  register(instanceId: string, _handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    return {
      bootstrap: { version: 1, socketPath: `/synthetic/pi/${instanceId}.sock`, token: randomBytes(32).toString("hex"), instanceId, generation: randomUUID() },
      release: () => undefined,
    };
  }
}

/** A minimal managed MCP lane owner: registers, never dispatches a tool here. */
/** Per-harness managed lane accounting: registration releases and the one stable relay connection. */
interface LaneLedger {
  releases: number;
  readonly connection: object;
}

function laneOwner(ledger: LaneLedger): NonNullable<InstanceManagerOptions["nativeMcpLane"]> {
  return {
    serverName: `pi_review_gate_${"0123456789abcdef".repeat(2)}`,
    registrar: {
      registerNativeMcpSource: (instanceId: string, backend: NativeCliBackend) => ({
        bootstrap: {
          version: 1,
          type: "native_mcp_bootstrap",
          socketPath: `/synthetic/native-mcp/${instanceId}.sock`,
          generation: randomUUID(),
          instanceId,
          backend,
          token: randomBytes(32).toString("hex"),
        },
        release: () => { ledger.releases += 1; },
        // ONE authenticated relay connection, stable across a proved `/clear`.
        liveConnection: () => ledger.connection,
      }),
    },
    delegate: { listTools: async () => [], callTool: async () => undefined },
  } as unknown as NonNullable<InstanceManagerOptions["nativeMcpLane"]>;
}

/* ----------------------------------------------------------------- harness */

type Receipt = "verified" | "declined";

interface HarnessOptions {
  readonly receipt?: Receipt;
  /** Whether the provider reports the root status hook prepared (default true). */
  readonly hookPrepared?: boolean;
  /** Whether the manager has a managed MCP lane owner (default true). */
  readonly lane?: boolean;
  /** Whether the custody selection admits the row (default true). */
  readonly admit?: boolean;
  /** The host platform both seams see (default win32). */
  readonly platform?: NodeJS.Platform;
  /** The prepared hook receipt's backend (default: the launch backend). */
  readonly hookBackend?: string;
  /** The prepared hook receipt's route (default `claude-settings-file`). */
  readonly hookRoute?: string;
}

interface Harness {
  readonly workspace: string;
  readonly manager: InstanceManager;
  readonly supervisor: ControlSupervisor;
  readonly spawned: SpyPty[];
  readonly supervisorLaunches: WindowsClaudeCustodySupervisorLaunch[];
  readonly adapterOptions: NativeWindowsClaudeCustodyAdapterOptions[];
  readonly providerRequests: NativeCliLaunchRequest[];
  readonly hookHandlers: Map<string, NativeHookSourceHandlers>;
  readonly bootstraps: Map<string, NativeHookBootstrap>;
  readonly binds: string[];
  readonly lane: LaneLedger;
  dispose(): Promise<void>;
}

const roots = new Set<string>();

function makeHarness(options: HarnessOptions = {}): Harness {
  const platform = options.platform ?? "win32";
  __test.setShutdownPlatform(platform);
  setClaudeInboxPlatformForTests(platform);
  const binds: string[] = [];
  const lane: LaneLedger = { releases: 0, connection: Object.freeze({ relay: "synthetic-live-connection" }) };
  __test.setClaudeInboxBindListenerForTests((event) => { binds.push(event); });
  const root = realpathSync(mkdtempSync(join(tmpdir(), ".prg-wcb-")));
  roots.add(root);
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic fixture; never imported.\n", "utf8");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n", "utf8");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  for (const dir of [agentDir, workspace]) mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), PI_CODING_AGENT_DIR: agentDir };

  const supervisor = new ControlSupervisor();
  const spawned: SpyPty[] = [];
  const supervisorLaunches: WindowsClaudeCustodySupervisorLaunch[] = [];
  const adapterOptions: NativeWindowsClaudeCustodyAdapterOptions[] = [];
  const providerRequests: NativeCliLaunchRequest[] = [];
  const hookHandlers = new Map<string, NativeHookSourceHandlers>();
  const bootstraps = new Map<string, NativeHookBootstrap>();
  // The settlement ends the exact wrapper first, as the real job teardown would.
  supervisor.onSettle = () => spawned.at(-1)?.emitExit(0);

  const managerOptions: InstanceManagerOptions = {
    packageRoot,
    piExecutable,
    statusRegistrar: new RecordingPiRegistrar(),
    env,
    args: [],
    nativeCliLaunch: (backend: NativeCliBackend, request: NativeCliLaunchRequest) => {
      providerRequests.push(request);
      const nativeHook = request.nativeHook !== undefined && options.hookPrepared !== false
        ? {
          observation: "prepared",
          backend: options.hookBackend ?? backend,
          route: options.hookRoute ?? "claude-settings-file",
          args: [],
          environment: {},
          lease: { root: null, cleanup: async () => ({ removed: [], preserved: [] }) },
        }
        : undefined;
      const nativeMcp = request.nativeMcp === undefined
        ? undefined
        : {
          mcp: "prepared", backend, route: "claude-mcp-config-file", placement: "claude-tui",
          serverName: request.nativeMcp.serverName, args: [], lease: { cleanup: async () => undefined },
        };
      const claudeInboxCompatibility = request.claudeInboxCompatibility !== true
        ? undefined
        : (options.receipt ?? "verified") === "verified"
          ? Object.freeze({ compatibility: "verified", version: SUPPORTED })
          : Object.freeze({ compatibility: "declined", reason: "version-unsupported" });
      return {
        file: TARGET_PATH,
        args: ["--interactive"],
        env: { PATH: "/synthetic/bin", HOME: env.HOME, pi_review_gate_windows_claude_hook: "stale-inherited" },
        cwd: request.workspace,
        ...(nativeHook === undefined ? {} : { nativeHook: nativeHook as unknown as NativeCliLaunchDescriptor["nativeHook"] }),
        ...(nativeMcp === undefined ? {} : { nativeMcp: nativeMcp as unknown as NativeCliLaunchDescriptor["nativeMcp"] }),
        ...(claudeInboxCompatibility === undefined
          ? {}
          : { claudeInboxCompatibility: claudeInboxCompatibility as NativeCliLaunchDescriptor["claudeInboxCompatibility"] }),
      } satisfies NativeCliLaunchDescriptor;
    },
    nativeHookRegistrar: {
      registerNativeHookSource: (instanceId, backend, handlers) => {
        hookHandlers.set(instanceId, handlers);
        const bootstrap: NativeHookBootstrap = {
          version: 1,
          socketPath: `/synthetic/native/${instanceId}.sock`,
          generation: randomUUID(),
          instanceId,
          backend,
          token: randomBytes(32).toString("hex"),
        };
        bootstraps.set(instanceId, bootstrap);
        return { bootstrap, release: () => undefined };
      },
    },
    nativeStatusObserverFactory: (context: NativeStatusObserverContext) => new SpyObserver(context),
    nativeClaudeInbox: true,
    ...(options.lane === false ? {} : { nativeMcpLane: laneOwner(lane) }),
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      spawned.push(pty);
      return pty;
    },
    nativeWindowsClaudeCustody: {
      select: (_request: NativeWindowsClaudeCustodyManagerRequest): NativeWindowsClaudeCustodyManagerSelection | undefined =>
        options.admit === false
          ? undefined
          : {
            powershellPath: POWERSHELL_PATH,
            spawnSupervisor: (launch: WindowsClaudeCustodySupervisorLaunch): ChildProcess => {
              supervisorLaunches.push(launch);
              return supervisor as unknown as ChildProcess;
            },
          },
      createAdapter: (adapterOptionSet: NativeWindowsClaudeCustodyAdapterOptions): NativeWindowsClaudeCustodyAdapter => {
        adapterOptions.push(adapterOptionSet);
        return createNativeWindowsClaudeCustodyAdapter({ ...adapterOptionSet, deadlines: TEST_DEADLINES });
      },
    },
  };
  const manager = new InstanceManager(managerOptions);
  return {
    workspace: realpathSync(workspace),
    manager,
    supervisor,
    spawned,
    supervisorLaunches,
    adapterOptions,
    providerRequests,
    hookHandlers,
    bootstraps,
    binds,
    lane,
    async dispose(): Promise<void> {
      try {
        await manager.dispose();
      } catch {
        // Contained.
      }
      if (supervisor.exitCode === null && supervisor.signalCode === null) await supervisor.exit(0).catch(() => undefined);
      __test.setClaudeInboxBindListenerForTests(undefined);
      __test.setShutdownPlatform(undefined);
      setClaudeInboxPlatformForTests(undefined);
      rmSync(root, { recursive: true, force: true });
      roots.delete(root);
      assert.equal(existsSync(root), false, "the private fixture root is removed");
    },
  };
}

/* --------------------------------------------------------------- utilities */

async function settleIo(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

/** Create one Claude row and drive the real custody handshake to an established child. */
async function launchClaude(h: Harness): Promise<string> {
  const creating = h.manager.create({ workspace: h.workspace, backend: "claude" });
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => h.spawned.length === 1, "wrapper spawn");
  const wrapperPid = h.spawned[0]!.pid;
  await h.supervisor.line(`SUP_WRAPPER ${wrapperPid} PROVISIONAL`);
  await waitFor(() => h.supervisor.commands().includes(`CONFIRM ${wrapperPid}\n`), "CONFIRM write");
  await h.supervisor.line(`SUP_GO ${wrapperPid}`);
  await h.supervisor.line(`SUP_CHILD ${CHILD_PID}`);
  const id = await creating;
  assert.equal(h.manager.list()[0]!.lifecycle, "alive", "the row is ready only after the established child");
  return id;
}

function handlers(h: Harness, id: string): NativeHookSourceHandlers {
  const found = h.hookHandlers.get(id);
  assert.ok(found, "the row registered one native hook source");
  return found;
}

/** The ordinary authenticated broker dispatch of one Claude hook event. */
function deliver(h: Harness, id: string, event: Partial<NativeHookEvent> & Pick<NativeHookEvent, "hook_event_name">): void {
  handlers(h, id).onEvent({ backend: "claude", ...event } as NativeHookEvent);
}

function rootStart(h: Harness, id: string, session: string, extra: Partial<NativeHookEvent> = {}): void {
  deliver(h, id, { hook_event_name: "SessionStart", session_id: session, cwd: h.workspace, source: "startup", ...extra });
}

async function boundSender(h: Harness, id: string, session: string): Promise<NonNullable<ReturnType<InstanceManager["nativeClaudeInboxSender"]>>> {
  await waitFor(() => h.manager.nativeClaudeInboxSender(id)?.conversationId === session, `the ${session} sender binds`);
  const sender = h.manager.nativeClaudeInboxSender(id);
  assert.ok(sender);
  return sender;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- tests */

test("one correlated bind and one callback attempt; the derived key crosses only the private startup", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);

  // The run was eligible on its own facts: verified receipt, prepared hook, kept lane.
  const request = h.providerRequests[0]!;
  assert.equal(request.claudeInboxCompatibility, true);
  assert.ok(request.nativeMcp !== undefined && request.nativeHook !== undefined);
  assert.ok(!JSON.stringify(request.env ?? {}).includes(WINDOWS_CLAUDE_HOOK_MARKER_ENV), "the provider never sees a marker");

  // The identifiers-only marker reaches exactly the wrapper environment.
  const wrapperEnv = h.spawned[0]!.spawnDescriptor.env;
  const markerNames = Object.keys(wrapperEnv).filter((name) => name.toUpperCase() === WINDOWS_CLAUDE_HOOK_MARKER_ENV);
  assert.deepEqual(markerNames, [WINDOWS_CLAUDE_HOOK_MARKER_ENV], "an inherited spelling is never forwarded");
  const marker = parseWindowsClaudeHookMarker(wrapperEnv[WINDOWS_CLAUDE_HOOK_MARKER_ENV]);
  assert.ok(marker, "the marker is the exact canonical shape");
  const bootstrap = h.bootstraps.get(id)!;
  assert.equal(marker.instanceId, bootstrap.instanceId);
  assert.equal(marker.generation, bootstrap.generation);
  assert.notEqual(marker.runId, id, "a fresh private run identity, never the row id");
  const key = deriveWindowsClaudeHookProofKey({ token: bootstrap.token, ...marker });
  assert.ok(key);
  assert.ok(!wrapperEnv[WINDOWS_CLAUDE_HOOK_MARKER_ENV]!.includes(key) && !wrapperEnv[WINDOWS_CLAUDE_HOOK_MARKER_ENV]!.includes(bootstrap.token));
  const barePipe = marker.pipe.replace(/^\\\\\.\\pipe\\/u, "");
  assert.match(barePipe, /^prg682-hook-[0-9a-f]{32}$/u);
  assert.equal(h.adapterOptions[0]!.run.runId, marker.runId);
  assert.ok(h.supervisorLaunches[0]!.source.includes(`'${barePipe}'`), "the supervisor listens on the marker's pipe");
  assert.equal(count(h.supervisor.writtenText, `${WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC}${key} ${marker.runId}\n`), 1, "one key frame");
  assert.equal(count(h.supervisor.writtenText, key), 1, "the key crossed the private pipe exactly once");
  assert.ok(!h.supervisor.writtenText.includes(bootstrap.token), "the bootstrap token never crosses");

  // Root start first (an equivalent, non-canonical absolute spelling of the
  // workspace), candidate second.
  rootStart(h, id, SESSION_A, { cwd: `${h.workspace}${sep}.` });
  await settleIo();
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined, "no sender before the supervisor's candidate");
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const sender = await boundSender(h, id, SESSION_A);
  assert.ok(h.supervisor.commands().includes("BIND 1\n"));
  assert.equal(sender.isCurrent(), true);
  const surface = inspect(sender, { showHidden: true, depth: Infinity }) + JSON.stringify(sender);
  assert.ok(!surface.includes(key) && !surface.includes(bootstrap.token) && !surface.includes(marker.pipe));

  const result = await sendClaudeInboxMessage(sender.capability, "wake: managed work completed");
  assert.equal(result.disposition, "sent_unconfirmed");
  assert.deepEqual(h.supervisor.sends, ["wake: managed work completed"], "exactly one SEND carrying only the callback text");
  assert.equal(sender.isCurrent(), true, "a confirmed write keeps the same binding");
  assert.equal(h.manager.nativeClaudeInboxSender(id), sender, "the same frozen sender for the life of the binding");
});

test("a candidate that arrives before its root start binds once the start is accepted; a candidate alone never binds", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);

  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);
  assert.ok(!h.supervisor.commands().includes("BIND"), "no candidate alone is ever bound");

  rootStart(h, id, SESSION_A);
  const sender = await boundSender(h, id, SESSION_A);
  assert.equal((await sendClaudeInboxMessage(sender.capability, "wake")).disposition, "sent_unconfirmed");
  assert.deepEqual(h.binds, ["started", "bound"]);
});

test("/clear revokes the old authority at once; the successor binds only through its own hook", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);
  rootStart(h, id, SESSION_A);
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const first = await boundSender(h, id, SESSION_A);

  // The supervisor is still serving the old DROP when the successor's hook lands.
  h.supervisor.holdDrops = true;
  deliver(h, id, { hook_event_name: "SessionEnd", session_id: SESSION_A, cwd: h.workspace, reason: "clear" } as Partial<NativeHookEvent> & Pick<NativeHookEvent, "hook_event_name">);
  assert.equal(first.isCurrent(), false, "the old sender ends at the bound session's own end");
  await waitFor(() => h.supervisor.commands().includes("DROP 1\n"), "the supervisor-side authority is dropped");
  assert.deepEqual(await sendClaudeInboxMessage(first.capability, "late"), { disposition: "refused", reason: "not_current" });
  assert.deepEqual(h.supervisor.sends, [], "nothing was sent through revoked authority");

  // The successor's own start and its own candidate bind a fresh sender, once the
  // lane is free (a busy lane writes nothing and is waited out inside the window).
  rootStart(h, id, SESSION_B, { source: "clear" });
  await h.supervisor.line(`SUP_CAND 2 ${SESSION_B}`);
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.ok(!h.supervisor.commands().includes("BIND 2"), "no BIND while the DROP is unanswered");
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);
  h.supervisor.releaseDrops();
  const second = await boundSender(h, id, SESSION_B);
  assert.equal(count(h.supervisor.commands(), "BIND 2\n"), 1, "exactly one BIND for the successor");
  assert.notEqual(second, first);
  assert.notEqual(second.capability, first.capability);
  assert.ok(h.supervisor.commands().includes("BIND 2\n"));
  assert.equal(first.isCurrent(), false, "and the old sender never becomes current again");
  assert.equal((await sendClaudeInboxMessage(second.capability, "wake B")).disposition, "sent_unconfirmed");
  assert.deepEqual(h.supervisor.sends, ["wake B"]);

  // A newer, unrelated candidate supersedes the supervisor binding immediately.
  await h.supervisor.line(`SUP_CAND 3 ${SESSION_A}`);
  assert.equal(second.isCurrent(), false, "a newer candidate ends the old binding");
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);
  assert.deepEqual(await sendClaudeInboxMessage(second.capability, "late"), { disposition: "refused", reason: "not_current" });
  assert.ok(!h.supervisor.commands().includes("BIND 3"), "a candidate alone is never bound");
  assert.deepEqual(h.supervisor.sends, ["wake B"]);
});

test("wrong, unrelated, or unproved hooks never bind; STALE and UNKNOWN end authority without a retry", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);

  // A subagent start and a start in another directory are never correlated.
  rootStart(h, id, SESSION_A, { agent_id: "agent-1" } as Partial<NativeHookEvent>);
  rootStart(h, id, SESSION_A, { cwd: join(h.workspace, "elsewhere") });
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);
  assert.ok(!h.supervisor.commands().includes("BIND"));

  // A root start whose matching candidate never arrives (the latest names another
  // session) binds nothing and is dropped at the bounded correlation window.
  rootStart(h, id, SESSION_B);
  await waitFor(() => h.binds.includes("dropped"), "the bounded correlation ends", 8_000);
  assert.ok(!h.supervisor.commands().includes("BIND"), "a mismatched candidate is never bound");
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);

  // The unspent SESSION_A candidate is now older than the window: a later
  // same-session root hook whose own relay forwarded nothing never binds it, and
  // only that hook's own fresh candidate does.
  rootStart(h, id, SESSION_A);
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.ok(!h.supervisor.commands().includes("BIND"), "an expired candidate is never bound");
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);
  await h.supervisor.line(`SUP_CAND 2 ${SESSION_A}`);
  await boundSender(h, id, SESSION_A);
  assert.ok(h.supervisor.commands().includes("BIND 2\n") && !h.supervisor.commands().includes("BIND 1\n"));

  // The supervisor answers STALE: no sender, no retry.
  h.supervisor.bindReply = "STALE";
  const dropsBefore = h.binds.filter((event) => event === "dropped").length;
  rootStart(h, id, SESSION_B);
  await h.supervisor.line(`SUP_CAND 3 ${SESSION_B}`);
  await waitFor(() => h.supervisor.commands().includes("BIND 3\n"), "BIND 3");
  await waitFor(() => h.binds.filter((event) => event === "dropped").length === dropsBefore + 1, "the stale bind is dropped");
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);
  assert.equal(count(h.supervisor.commands(), "BIND 3\n"), 1, "a spent sequence is never bound again");

  // A bound sender whose one attempt ends UNKNOWN is never resent and loses authority.
  h.supervisor.bindReply = "OK";
  h.supervisor.sentReply = "UNKNOWN";
  rootStart(h, id, SESSION_B);
  await h.supervisor.line(`SUP_CAND 4 ${SESSION_B}`);
  const sender = await boundSender(h, id, SESSION_B);
  const unknown = await sendClaudeInboxMessage(sender.capability, "wake");
  assert.equal(unknown.disposition, "unknown");
  assert.equal(unknown.disposition === "unknown" ? unknown.reason : undefined, "disconnected");
  assert.equal(sender.isCurrent(), false, "an unknown outcome clears the binding");
  assert.deepEqual(await sendClaudeInboxMessage(sender.capability, "wake"), { disposition: "refused", reason: "not_current" });
  assert.deepEqual(h.supervisor.sends, ["wake"], "exactly one attempt, never retried");
});

test("a normal stop ends the callback authority before settlement and settles exactly once", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);
  rootStart(h, id, SESSION_A);
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const sender = await boundSender(h, id, SESSION_A);

  const stopping = h.manager.stop(id, { confirmed: true });
  assert.equal(sender.isCurrent(), false, "stop revokes local authority immediately");
  assert.deepEqual(await sendClaudeInboxMessage(sender.capability, "late"), { disposition: "refused", reason: "not_current" });
  assert.deepEqual(await stopping, { status: "exited", forced: false });
  assert.equal(count(h.supervisor.commands(), "SETTLE\n"), 1);
  assert.equal(h.supervisor.kills, 0, "a witnessed settlement needs no kill");
  assert.deepEqual(h.supervisor.sends, []);
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);
  assert.equal(h.manager.closeExited(id), true);
});

test("rows without every eligibility fact keep the default custody and ordinary non-callback access", async (t) => {
  const cases: Array<[string, HarnessOptions]> = [
    ["declined receipt", { receipt: "declined" }],
    ["unprepared hook", { hookPrepared: false }],
    ["no managed lane", { lane: false }],
  ];
  for (const [label, options] of cases) {
    const h = makeHarness(options);
    try {
      const id = await launchClaude(h);
      const source = h.supervisorLaunches[0]!.source;
      assert.ok(!source.includes("prg682-hook-"), `${label}: the default supervisor`);
      assert.ok(!h.supervisor.writtenText.includes(WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC), `${label}: no key frame`);
      assert.equal(h.adapterOptions[0]!.hookChannel, undefined, `${label}: no hook channel`);
      assert.equal(h.adapterOptions[0]!.run.runId, id, `${label}: the unchanged custody run`);
      const env = h.spawned[0]!.spawnDescriptor.env;
      assert.ok(!Object.keys(env).some((name) => name.toUpperCase() === WINDOWS_CLAUDE_HOOK_MARKER_ENV), `${label}: no marker`);
      rootStart(h, id, SESSION_A);
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      assert.equal(h.manager.nativeClaudeInboxSender(id), undefined, `${label}: no sender`);
      assert.ok(!h.supervisor.commands().includes("BIND"), `${label}: nothing bound`);
    } finally {
      await h.dispose();
    }
  }

  // A declined selection takes the unchanged direct spawn and offers no callback.
  const direct = makeHarness({ admit: false });
  t.after(() => direct.dispose());
  const directId = await direct.manager.create({ workspace: direct.workspace, backend: "claude" });
  assert.equal(direct.supervisorLaunches.length, 0);
  assert.equal(direct.spawned[0]!.spawnDescriptor.file, TARGET_PATH);
  const directEnv = direct.spawned[0]!.spawnDescriptor.env;
  assert.ok(!Object.keys(directEnv).some((name) => name.toUpperCase() === WINDOWS_CLAUDE_HOOK_MARKER_ENV),
    "a direct Windows Claude spawn forwards no inherited marker spelling");
  rootStart(direct, directId, SESSION_A);
  await settleIo();
  assert.equal(direct.manager.nativeClaudeInboxSender(directId), undefined);
  // End the direct child the way the existing custody tests do (its own exit receipt).
  direct.spawned[0]!.emitExit(0);
  await settleIo();
  assert.equal(direct.manager.closeExited(directId), true);
});

test("a non-Windows host never consults custody and keeps its own inbox path untouched", async (t) => {
  const h = makeHarness({ platform: "linux" });
  t.after(() => h.dispose());
  const id = await h.manager.create({ workspace: h.workspace, backend: "claude" });
  assert.equal(h.adapterOptions.length, 0);
  assert.equal(h.supervisorLaunches.length, 0);
  assert.equal(h.spawned[0]!.spawnDescriptor.file, TARGET_PATH);
  assert.ok(!(WINDOWS_CLAUDE_HOOK_MARKER_ENV in h.spawned[0]!.spawnDescriptor.env));
  assert.equal(typeof handlers(h, id).onClaudeInboxAnnouncement, "function", "the Linux announcement path is still registered");
});

test("a root start before child establishment binds only after readiness, through the observer's own re-offer", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const creating = h.manager.create({ workspace: h.workspace, backend: "claude" });
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => h.spawned.length === 1, "wrapper spawn");
  const wrapperPid = h.spawned[0]!.pid;
  await h.supervisor.line(`SUP_WRAPPER ${wrapperPid} PROVISIONAL`);
  await waitFor(() => h.supervisor.commands().includes(`CONFIRM ${wrapperPid}\n`), "CONFIRM write");
  await h.supervisor.line(`SUP_GO ${wrapperPid}`);
  const id = h.manager.list()[0]!.id;

  // Claude is already running: its authenticated root start lands before SUP_CHILD,
  // followed by a late root end of ANOTHER conversation, which must not discard it.
  rootStart(h, id, SESSION_A);
  deliver(h, id, { hook_event_name: "SessionEnd", session_id: SESSION_B });
  await settleIo();
  assert.equal(h.manager.list()[0]!.lifecycle, "starting");
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined, "no sender before readiness");

  await h.supervisor.line(`SUP_CHILD ${CHILD_PID}`);
  assert.equal(await creating, id);
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined, "readiness alone mints nothing");
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const sender = await boundSender(h, id, SESSION_A);
  assert.equal(count(h.supervisor.commands(), "BIND"), 1, "exactly one bind after readiness");
  assert.equal((await sendClaudeInboxMessage(sender.capability, "wake")).disposition, "sent_unconfirmed");
});

test("a deferred pre-readiness root start is ended by a superseding root boundary", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const creating = h.manager.create({ workspace: h.workspace, backend: "claude" });
  await waitFor(() => h.supervisor.writtenText.length > 0, "supervisor boot frame");
  await h.supervisor.line(`SUP_READY ${SUP_PID}`);
  await waitFor(() => h.spawned.length === 1, "wrapper spawn");
  const wrapperPid = h.spawned[0]!.pid;
  await h.supervisor.line(`SUP_WRAPPER ${wrapperPid} PROVISIONAL`);
  await waitFor(() => h.supervisor.commands().includes(`CONFIRM ${wrapperPid}\n`), "CONFIRM write");
  await h.supervisor.line(`SUP_GO ${wrapperPid}`);
  const id = h.manager.list()[0]!.id;
  rootStart(h, id, SESSION_A);
  deliver(h, id, { hook_event_name: "SessionEnd", session_id: SESSION_A, cwd: h.workspace } as Partial<NativeHookEvent> & Pick<NativeHookEvent, "hook_event_name">);
  await h.supervisor.line(`SUP_CHILD ${CHILD_PID}`);
  await creating;
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);
  assert.ok(!h.supervisor.commands().includes("BIND"), "a superseded start never binds");
});

test("a CUSTODY reply ends exactly the binding that sent it; a later send writes no frame", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);
  rootStart(h, id, SESSION_A);
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const sender = await boundSender(h, id, SESSION_A);
  h.supervisor.sentReply = "CUSTODY";
  assert.deepEqual(await sendClaudeInboxMessage(sender.capability, "wake"), { disposition: "refused", reason: "not_current" });
  assert.equal(sender.isCurrent(), false, "custody proof failure revokes the old sender");
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined, "no Watch-capable sender remains");
  await waitFor(() => h.supervisor.commands().includes("DROP 1\n"), "the supervisor-side binding is dropped");
  assert.deepEqual(await sendClaudeInboxMessage(sender.capability, "again"), { disposition: "refused", reason: "not_current" });
  assert.deepEqual(h.supervisor.sends, ["wake"], "the later send wrote no frame");

  // A successor still binds through its own hook and is untouched by the old failure.
  h.supervisor.sentReply = "SENT";
  rootStart(h, id, SESSION_B);
  await h.supervisor.line(`SUP_CAND 2 ${SESSION_B}`);
  const successor = await boundSender(h, id, SESSION_B);
  assert.equal((await sendClaudeInboxMessage(successor.capability, "wake B")).disposition, "sent_unconfirmed");
});

test("the shared send deadline holds on both sides of the commit boundary", async (t) => {
  // Before the commit can write: an attempt whose deadline passes inside the
  // host's synchronous checks is refused, and the commit port is never reached.
  setClaudeInboxPlatformForTests("win32");
  try {
    let commits = 0;
    const created = createClaudeWindowsCustodyInboxSendCapability({
      launchId: "claude-inbox-deadline",
      sessionId: SESSION_A,
      claudeVersion: SUPPORTED,
      isCurrent: () => {
        const until = performance.now() + 70;
        while (performance.now() < until) { /* a slow synchronous host fence */ }
        return true;
      },
      commit: () => {
        commits += 1;
        throw new Error("never reached");
      },
    });
    assert.ok(created.ok);
    assert.deepEqual(await sendClaudeInboxMessage(created.capability, "wake", { deadlineMs: 50 }), {
      disposition: "refused", reason: "deadline_exceeded",
    });
    assert.equal(commits, 0);
  } finally {
    setClaudeInboxPlatformForTests(undefined);
  }

  // After dispatch: the outstanding reply outlives the deadline, so the attempt is
  // unknown at once; the exact reply still drains and nothing is resent.
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);
  rootStart(h, id, SESSION_A);
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const sender = await boundSender(h, id, SESSION_A);
  h.supervisor.holdSends = true;
  const started = performance.now();
  const late = await sendClaudeInboxMessage(sender.capability, "wake", { deadlineMs: 60 });
  assert.equal(late.disposition, "unknown");
  assert.equal(late.disposition === "unknown" ? late.reason : undefined, "deadline_exceeded");
  assert.ok(performance.now() - started < 1_000, "the deadline, not the transport's reply timeout, ended the wait");
  assert.deepEqual(h.supervisor.sends, ["wake"], "one frame was handed over");
  h.supervisor.releaseSends();
  await settleIo();
  await settleIo();
  assert.deepEqual(h.supervisor.sends, ["wake"], "never resent");
  // The drained SENT reply kept the binding; a NEW attempt is a fresh send, not a retry.
  assert.equal(sender.isCurrent(), true);
  assert.equal((await sendClaudeInboxMessage(sender.capability, "next")).disposition, "sent_unconfirmed");
  assert.deepEqual(h.supervisor.sends, ["wake", "next"]);
});

test("a CUSTODY reply that arrives after the caller's deadline still revokes the binding that sent it", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);
  rootStart(h, id, SESSION_A);
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const sender = await boundSender(h, id, SESSION_A);
  h.supervisor.sentReply = "CUSTODY";
  h.supervisor.holdSends = true;
  const late = await sendClaudeInboxMessage(sender.capability, "wake", { deadlineMs: 60 });
  assert.equal(late.disposition, "unknown");
  assert.equal(late.disposition === "unknown" ? late.reason : undefined, "deadline_exceeded", "the caller stops waiting first");
  assert.equal(sender.isCurrent(), true, "the reply is still outstanding");
  h.supervisor.releaseSends();
  await waitFor(() => h.supervisor.commands().includes("DROP 1\n"), "the late CUSTODY reply revokes the binding");
  assert.equal(sender.isCurrent(), false);
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined);
  assert.deepEqual(await sendClaudeInboxMessage(sender.capability, "again"), { disposition: "refused", reason: "not_current" });
  assert.deepEqual(h.supervisor.sends, ["wake"], "no second SEND");
});

test("a supervisor LIMIT (writer timeout) is a deadline refusal, never a size diagnostic, and is not retried", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);
  rootStart(h, id, SESSION_A);
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const sender = await boundSender(h, id, SESSION_A);
  h.supervisor.sentReply = "LIMIT";
  assert.deepEqual(await sendClaudeInboxMessage(sender.capability, "ok"), { disposition: "refused", reason: "deadline_exceeded" });
  await settleIo();
  assert.deepEqual(h.supervisor.sends, ["ok"], "exactly one attempt");
});

test("a SENT reply processed at or after monotonic expiry, before the timer runs, is never credited", async () => {
  setClaudeInboxPlatformForTests("win32");
  try {
    let budgetSeen: { expiresAt: number } | undefined;
    const created = createClaudeWindowsCustodyInboxSendCapability({
      launchId: "claude-inbox-late-reply",
      sessionId: SESSION_A,
      claudeVersion: SUPPORTED,
      isCurrent: () => true,
      commit: (payload, writeBudget) => {
        budgetSeen = writeBudget;
        assert.equal(payload(), "wake");
        return {
          status: "dispatched",
          attemptId: 1,
          outcome: new Promise((resolve) => {
            setImmediate(() => {
              // Block the loop past expiry so the caller's timer cannot run first.
              while (performance.now() < writeBudget.expiresAt + 5) { /* busy */ }
              resolve({ status: "sent-unconfirmed", attemptId: 1 });
            });
          }),
        };
      },
    });
    assert.ok(created.ok);
    const result = await sendClaudeInboxMessage(created.capability, "wake", { deadlineMs: 50 });
    assert.ok(budgetSeen !== undefined && Number.isFinite(budgetSeen.expiresAt), "the absolute budget reached the commit port");
    assert.equal(result.disposition, "unknown");
    assert.equal(result.disposition === "unknown" ? result.reason : undefined, "deadline_exceeded");
  } finally {
    setClaudeInboxPlatformForTests(undefined);
  }
});

test("an observer-accepted CWD that resolves to another directory never binds", async (t) => {
  const h = makeHarness();
  const other = realpathSync(mkdtempSync(join(tmpdir(), ".prg-wcb-other-")));
  t.after(async () => {
    spyAcceptsAnyExistingCwd = false;
    rmSync(other, { recursive: true, force: true });
    await h.dispose();
  });
  const id = await launchClaude(h);
  spyAcceptsAnyExistingCwd = true;
  rootStart(h, id, SESSION_A, { cwd: other });
  assert.equal(h.manager.list()[0]!.id, id);
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined, "a different workspace never binds");
  assert.ok(!h.supervisor.commands().includes("BIND"));
  // A relative spelling is never resolved against anything.
  rootStart(h, id, SESSION_A, { cwd: "." });
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.ok(!h.supervisor.commands().includes("BIND"), "a relative CWD never binds");
});

/** One managed `/clear` over the SAME live relay connection: end A, then start B at `cwd`. */
function provedClear(h: Harness, id: string, successorCwd: string): void {
  deliver(h, id, { hook_event_name: "SessionEnd", session_id: SESSION_A, cwd: h.workspace, reason: "clear" } as Partial<NativeHookEvent> & Pick<NativeHookEvent, "hook_event_name">);
  rootStart(h, id, SESSION_B, { source: "clear", cwd: successorCwd });
}

test("a managed /clear successor at an equivalent workspace spelling keeps the MCP registration and binds afresh", async (t) => {
  const h = makeHarness();
  t.after(() => h.dispose());
  const id = await launchClaude(h);
  rootStart(h, id, SESSION_A);
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const first = await boundSender(h, id, SESSION_A);

  // The real recovery branch: a proved end over the stable live connection with the
  // observer's own withdrawal, then the successor at `<workspace>/.`.
  provedClear(h, id, `${h.workspace}${sep}.`);
  assert.equal(h.lane.releases, 0, "the existing managed MCP registration is preserved across the clear");
  assert.equal(first.isCurrent(), false, "the old authority is gone");
  await waitFor(() => h.supervisor.commands().includes("DROP 1\n"), "the old supervisor binding is dropped");
  assert.deepEqual(await sendClaudeInboxMessage(first.capability, "late"), { disposition: "refused", reason: "not_current" });

  await h.supervisor.line(`SUP_CAND 2 ${SESSION_B}`);
  const successor = await boundSender(h, id, SESSION_B);
  assert.notEqual(successor, first);
  assert.equal((await sendClaudeInboxMessage(successor.capability, "wake B")).disposition, "sent_unconfirmed");
  assert.deepEqual(h.supervisor.sends, ["wake B"]);
  assert.equal(h.lane.releases, 0, "and it is still the same registration");
});

test("discriminating: the same equivalent spelling still ends the lane where the exact comparison applies", async (t) => {
  // A different workspace on the Windows callback run is refused by resolution.
  const other = realpathSync(mkdtempSync(join(tmpdir(), ".prg-wcb-other-")));
  const win = makeHarness();
  t.after(async () => {
    rmSync(other, { recursive: true, force: true });
    await win.dispose();
  });
  const winId = await launchClaude(win);
  rootStart(win, winId, SESSION_A);
  await win.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  await boundSender(win, winId, SESSION_A);
  provedClear(win, winId, other);
  assert.equal(win.lane.releases, 1, "a successor in another directory ends the lane");

  // A run that is not the Windows callback run (Linux) keeps its exact comparison.
  const linux = makeHarness({ platform: "linux" });
  t.after(() => linux.dispose());
  const linuxId = await linux.manager.create({ workspace: linux.workspace, backend: "claude" });
  rootStart(linux, linuxId, SESSION_A);
  assert.equal(linux.lane.releases, 0);
  provedClear(linux, linuxId, `${linux.workspace}${sep}.`);
  assert.equal(linux.lane.releases, 1, "the unchanged exact comparison on other platforms");
  // And the exact spelling on that platform still recovers (the fixture enters the real branch).
  const linuxExact = makeHarness({ platform: "linux" });
  t.after(() => linuxExact.dispose());
  const exactId = await linuxExact.manager.create({ workspace: linuxExact.workspace, backend: "claude" });
  rootStart(linuxExact, exactId, SESSION_A);
  provedClear(linuxExact, exactId, linuxExact.workspace);
  assert.equal(linuxExact.lane.releases, 0, "the exact successor keeps the registration");
});

test("a prepared hook receipt that is not Claude's own Claude-route hook composes no callback channel", async (t) => {
  const cases: Array<[string, HarnessOptions]> = [
    ["Codex route", { hookRoute: "codex-session-start" }],
    ["Codex backend", { hookBackend: "codex" }],
    ["injected route", { hookRoute: "injected-other-route" }],
  ];
  for (const [label, options] of cases) {
    const h = makeHarness(options);
    try {
      const id = await launchClaude(h);
      assert.equal(h.adapterOptions[0]!.hookChannel, undefined, `${label}: no hook channel or key`);
      assert.ok(!h.supervisorLaunches[0]!.source.includes("prg682-hook-"), `${label}: the default supervisor`);
      assert.ok(!h.supervisor.writtenText.includes(WINDOWS_CLAUDE_CUSTODY_KEY_FRAME_MAGIC), `${label}: no key frame`);
      const env = h.spawned[0]!.spawnDescriptor.env;
      assert.ok(!Object.keys(env).some((name) => name.toUpperCase() === WINDOWS_CLAUDE_HOOK_MARKER_ENV),
        `${label}: no marker forwarded or issued`);
      assert.ok(!Object.values(env).some((value) => parseWindowsClaudeHookMarker(value) !== undefined), `${label}: no marker value anywhere`);
      assert.equal(h.adapterOptions[0]!.run.runId, id, `${label}: the unchanged custody run`);
      rootStart(h, id, SESSION_A);
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      assert.equal(h.manager.nativeClaudeInboxSender(id), undefined, `${label}: no managed inbox privilege`);
      assert.ok(!h.supervisor.commands().includes("BIND"), `${label}: nothing bound`);
    } finally {
      await h.dispose();
    }
  }
  t.diagnostic("negative hook receipts checked");
});

test("a managed /clear successor at the exact recorded spelling that no longer resolves to the workspace ends the lane and never binds", async (t) => {
  const h = makeHarness();
  t.after(async () => {
    spyAcceptsAnyExistingCwd = false;
    await h.dispose();
  });
  const id = await launchClaude(h);
  rootStart(h, id, SESSION_A);
  await h.supervisor.line(`SUP_CAND 1 ${SESSION_A}`);
  const first = await boundSender(h, id, SESSION_A);

  // Redirect the recorded workspace path to another directory (inside the fixture root).
  const root = dirname(h.workspace);
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  renameSync(h.workspace, join(root, "workspace-moved"));
  symlinkSync(elsewhere, h.workspace, process.platform === "win32" ? "junction" : "dir");
  assert.notEqual(realpathSync(h.workspace), h.workspace, "the recorded spelling now resolves elsewhere");

  // An observer that resolves both spellings alike still accepts the successor.
  spyAcceptsAnyExistingCwd = true;
  provedClear(h, id, h.workspace);
  assert.equal(h.lane.releases, 1, "the managed registration is released: no exact-spelling shortcut");
  assert.equal(first.isCurrent(), false);
  await h.supervisor.line(`SUP_CAND 2 ${SESSION_B}`);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(h.manager.nativeClaudeInboxSender(id), undefined, "no callback binds");
  assert.ok(!h.supervisor.commands().includes("BIND 2"), "the redirected successor is never bound");
});
