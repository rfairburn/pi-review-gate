import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import {
  __test as instancesTest,
  InstanceManager,
  type CreateInstanceOptions,
  type InstanceManagerOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunchDescriptor,
  type NativeCliLaunchRequest,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
  type StatusRegistrar,
} from "../src/session-host/instances";
import type { NativeHookSourceHandlers } from "../src/session-host/broker";
import type { NativeHookEvent } from "../src/session-host/native-hook-protocol";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import {
  CLAUDE_INBOX_SOCKET_ENV,
  CLAUDE_INBOX_TOKEN_ENV,
  selectClaudeInboxAnnouncement,
} from "../src/session-host/native-claude-inbox-announcement";
import {
  CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES,
  sendClaudeInboxMessage,
  setClaudeInboxConnectorForTests,
  setClaudeInboxDarwinProofSeamsForTests,
  setClaudeInboxPlatformForTests,
} from "../src/session-host/native-claude-inbox-delivery";
import type {
  ClaudeDarwinAclExecOptions,
  ClaudeDarwinAclExecResult,
  ClaudeDarwinFsProbe,
  ClaudeDarwinLstat,
} from "../src/session-host/native-claude-darwin-inbox-endpoint";
import { Duplex } from "node:stream";
import type { NativeClaudeInboxCompatibilityOutcome } from "../src/session-host/native-claude-version-probe";
import { createNativeStatusObserver } from "../src/session-host/native-observer-factory";

/**
 * Focused coverage of the OPTIONAL native Claude inbox binding of
 * `InstanceManager` (#682).
 *
 * EVIDENCE SCOPE: synthetic PTYs, an injected fake launch provider that answers
 * the compatibility receipt, a fake hook registrar that captures the handlers the
 * manager registers, a synthetic observer that accepts identity the way the real
 * Claude observer does for a root SessionStart in the row's workspace (plus cases
 * driven through the REAL Claude observer from `createNativeStatusObserver`), one
 * real listening Unix socket in a private temporary directory (for its genuine
 * device/inode/owner). Nothing ever connects to that socket: no provider, relay,
 * version probe, or delivery runs. Bind attempts are synchronized through the
 * manager's narrow test listener (started/bound/dropped), never a fixed delay.
 * This proves proof, refusal, invalidation, and cleanup of the manager-side
 * binding only.
 */

const SUPPORTED = "2.1.330";
const SESSION_A = "1d6f2b9e-3c4a-4e5f-9a0b-1c2d3e4f5a6b";
const SESSION_B = "8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0";

class SpyPty implements InstancePty {
  static #nextPid = 960_000;
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

/** `accept-any` proves identity for ANY SessionStart, isolating the manager's own root/cwd guards. */
type ObserverMode = "accept" | "accept-any" | "silent" | "throw";

/** Accepts identity like the real Claude observer: a root SessionStart in the row's workspace. */
class SpyObserver implements NativeStatusObserver {
  mode: ObserverMode = "accept";
  constructor(readonly context: NativeStatusObserverContext) {}
  acceptHook(event: NativeHookEvent): void {
    if (this.mode === "throw") throw new Error("synthetic observer failure");
    if (this.mode === "accept-any") {
      if (event.hook_event_name === "SessionStart" && typeof event.session_id === "string") {
        this.context.emitConversationIdentity?.(event.session_id);
      }
      return;
    }
    if (this.mode !== "accept") return;
    if (event.hook_event_name === "SessionStart" && event.agent_id === undefined
      && typeof event.session_id === "string" && event.cwd === this.context.workspace) {
      this.context.emitConversationIdentity?.(event.session_id);
    }
  }
  acceptFailure(): void { /* unused */ }
  dispose(): void { /* unused */ }
  identity(value: string | null): boolean {
    const emit = this.context.emitConversationIdentity;
    assert.ok(emit);
    return emit(value);
  }
}

type Receipt = "verified" | "newer-stable" | "declined" | "unsupported-claim" | "prerelease-claim" | "malformed-claim" | "silent";

interface Harness {
  root: string;
  workspace: string;
  socketPath: string;
  token: string;
  manager: InstanceManager;
  observers: Map<string, SpyObserver>;
  spawned: SpyPty[];
  providerCalls: NativeCliLaunchRequest[];
  hookHandlers: Map<string, NativeHookSourceHandlers>;
  connections: () => number;
  /** Every bind lifecycle notification, in order: "started", then "bound" or "dropped". */
  binds: string[];
  setReceipt(receipt: Receipt): void;
  /** How the fake provider answers a requested native MCP option (default prepared). */
  setProviderMcp(mode: "prepared" | "unavailable"): void;
}

/** One short private root, so the inbox socket path stays within the portable Unix bound. */
function privateRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "pci-")));
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function withHarness(
  body: (harness: Harness) => Promise<void>,
  overrides: { optIn?: boolean; observer?: "spy" | "real"; extra?: Partial<InstanceManagerOptions> } = {},
): Promise<void> {
  const root = privateRoot();
  const server = createServer((socket) => {
    connectionCount += 1;
    socket.destroy();
  });
  let connectionCount = 0;
  let manager: InstanceManager | undefined;
  const binds: string[] = [];
  instancesTest.setClaudeInboxBindListenerForTests((event) => { binds.push(event); });
  try {
    const socketPath = join(root, "i.sock");
    assert.ok(Buffer.byteLength(socketPath) <= CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES, "test socket path fits the Unix bound");
    await listen(server, socketPath);

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
    const workspace = join(root, "ws");
    for (const dir of [home, agentDir, workspace]) mkdirSync(dir, { recursive: true });

    const observers = new Map<string, SpyObserver>();
    const spawned: SpyPty[] = [];
    const providerCalls: NativeCliLaunchRequest[] = [];
    const hookHandlers = new Map<string, NativeHookSourceHandlers>();
    let receipt: Receipt = "verified";
    let providerMcp: "prepared" | "unavailable" = "prepared";

    const options: InstanceManagerOptions = {
      packageRoot,
      piExecutable,
      statusRegistrar: new RecordingPiRegistrar(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir },
      args: [],
      nativeCliLaunch: (backend: NativeCliBackend, request: NativeCliLaunchRequest) => {
        providerCalls.push({ ...request, env: {} });
        let claudeInboxCompatibility: NativeClaudeInboxCompatibilityOutcome | undefined;
        if (request.claudeInboxCompatibility === true) {
          if (receipt === "verified") claudeInboxCompatibility = Object.freeze({ compatibility: "verified", version: SUPPORTED });
          else if (receipt === "declined") claudeInboxCompatibility = Object.freeze({ compatibility: "declined", reason: "version-unsupported" });
          else if (receipt === "newer-stable") claudeInboxCompatibility = Object.freeze({ compatibility: "verified", version: "2.2.0" });
          else if (receipt === "unsupported-claim") claudeInboxCompatibility = Object.freeze({ compatibility: "verified", version: "2.1.329" });
          else if (receipt === "prerelease-claim") claudeInboxCompatibility = Object.freeze({ compatibility: "verified", version: "2.2.0-beta.1" });
          else if (receipt === "malformed-claim") claudeInboxCompatibility = Object.freeze({ compatibility: "verified", version: "2.02.0" });
        }
        // Only a manager armed with a lane owner requests MCP; nothing else changes.
        const nativeMcp = request.nativeMcp === undefined
          ? undefined
          : providerMcp === "prepared"
            ? {
              mcp: "prepared", backend, route: "claude-mcp-config-file", placement: "claude-tui",
              serverName: request.nativeMcp.serverName, args: [], lease: { cleanup: async () => undefined },
            }
            : { mcp: "unavailable", backend, reason: "platform-unsupported" };
        return {
          file: `/synthetic/bin/${backend}`,
          args: ["--interactive"],
          env: { PATH: "/synthetic/bin", HOME: home },
          cwd: request.workspace,
          ...(claudeInboxCompatibility === undefined ? {} : { claudeInboxCompatibility }),
          ...(nativeMcp === undefined ? {} : { nativeMcp: nativeMcp as unknown as NativeCliLaunchDescriptor["nativeMcp"] }),
        } satisfies NativeCliLaunchDescriptor;
      },
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
        if (overrides.observer === "real") return createNativeStatusObserver(context);
        const observer = new SpyObserver(context);
        observers.set(context.rowId, observer);
        return observer;
      },
      ...(overrides.optIn ?? true ? { nativeClaudeInbox: true } : {}),
      ptyFactory: (descriptor) => {
        const pty = new SpyPty(descriptor);
        spawned.push(pty);
        return pty;
      },
      ...overrides.extra,
    };
    manager = new InstanceManager(options);
    await body({
      root,
      workspace,
      socketPath,
      token: `tok-${randomBytes(24).toString("hex")}`,
      manager,
      observers,
      spawned,
      providerCalls,
      hookHandlers,
      connections: () => connectionCount,
      binds,
      setReceipt: (next) => { receipt = next; },
      setProviderMcp: (next) => { providerMcp = next; },
    });
    assert.equal(connectionCount, 0, "nothing ever connected to the inbox endpoint");
  } finally {
    await manager?.dispose();
    instancesTest.setClaudeInboxBindListenerForTests(undefined);
    await closeServer(server);
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(root), false, "the private test root is removed immediately");
}

async function createClaude(harness: Harness): Promise<string> {
  return harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
}

function handlersFor(harness: Harness, id: string): NativeHookSourceHandlers {
  const handlers = harness.hookHandlers.get(id);
  assert.ok(handlers, "the row registered one native hook source");
  return handlers;
}

function observerFor(harness: Harness, id: string): SpyObserver {
  const observer = harness.observers.get(id);
  assert.ok(observer);
  return observer;
}

interface Delivery {
  readonly session?: string;
  readonly announcedSession?: string;
  readonly cwd?: string;
  readonly socketPath?: string;
  readonly agentId?: string;
  readonly source?: string;
  readonly announce?: boolean;
}

/**
 * Mirrors the broker's dispatch: the ordinary authenticated event first, then —
 * synchronously, in the same dispatch — the opaque announcement candidate selected
 * from the same frame (here with the announcement's session made selectable).
 */
function deliverRootStart(harness: Harness, id: string, delivery: Delivery = {}): void {
  const handlers = handlersFor(harness, id);
  const session = delivery.session ?? SESSION_A;
  const event: NativeHookEvent = {
    backend: "claude",
    hook_event_name: "SessionStart",
    session_id: session,
    cwd: delivery.cwd ?? realpathSync(harness.workspace),
    source: delivery.source ?? "startup",
    ...(delivery.agentId === undefined ? {} : { agent_id: delivery.agentId }),
  };
  handlers.onEvent(event);
  if (delivery.announce === false) return;
  announce(harness, id, delivery.announcedSession ?? session, delivery.socketPath);
}

function announce(harness: Harness, id: string, session: string, socketPath?: string): void {
  const candidate = selectClaudeInboxAnnouncement("claude", { hook_event_name: "SessionStart", session_id: session }, {
    [CLAUDE_INBOX_SOCKET_ENV]: socketPath ?? harness.socketPath,
    [CLAUDE_INBOX_TOKEN_ENV]: harness.token,
  }, "linux");
  assert.ok(candidate, "the synthetic announcement is selectable");
  const callback = handlersFor(harness, id).onClaudeInboxAnnouncement;
  assert.equal(typeof callback, "function", "the opted-in row registered the announcement owner callback");
  callback!(candidate);
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for: ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** Wait until every started bind attempt reported its own settlement (bound or dropped). */
async function allSettled(harness: Harness): Promise<void> {
  const count = (event: string): number => harness.binds.filter((entry) => entry === event).length;
  await until(() => count("bound") + count("dropped") === count("started"), "every started bind attempt settles");
}

async function bound(harness: Harness, id: string): Promise<NonNullable<ReturnType<InstanceManager["nativeClaudeInboxSender"]>>> {
  deliverRootStart(harness, id);
  await until(() => harness.manager.nativeClaudeInboxSender(id) !== undefined, "the inbox sender binds");
  const sender = harness.manager.nativeClaudeInboxSender(id);
  assert.ok(sender);
  return sender;
}

const linuxOnly = { skip: process.platform !== "linux" ? "the inbox endpoint is supported on Linux only" : false };

test("construction refuses a malformed or half-wired opt-in", (t) => {
  const root = privateRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = {
    packageRoot: "/synthetic", piExecutable: "/synthetic/pi", statusRegistrar: new RecordingPiRegistrar(),
    env: { HOME: root, PI_CODING_AGENT_DIR: root },
  };
  assert.throws(() => new InstanceManager({ ...base, nativeClaudeInbox: true }), /nativeClaudeInbox requires/);
  assert.throws(() => new InstanceManager({ ...base, nativeClaudeInbox: "yes" as unknown as boolean }), /nativeClaudeInbox must be a boolean/);
});

test("without the opt-in nothing changes: no receipt request, no announcement callback, no sender", linuxOnly, async () => {
  await withHarness(async (harness) => {
    const id = await createClaude(harness);
    assert.equal("claudeInboxCompatibility" in harness.providerCalls[0]!, false);
    assert.equal(handlersFor(harness, id).onClaudeInboxAnnouncement, undefined);
    handlersFor(harness, id).onEvent({
      backend: "claude", hook_event_name: "SessionStart", session_id: SESSION_A, cwd: realpathSync(harness.workspace),
    });
    assert.deepEqual(harness.binds, [], "no bind attempt can start");
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined);
  }, { optIn: false });
});

test("an opted-in Codex row asks for nothing and registers no announcement callback", linuxOnly, async () => {
  await withHarness(async (harness) => {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "codex" } as CreateInstanceOptions);
    assert.equal("claudeInboxCompatibility" in harness.providerCalls[0]!, false);
    assert.equal(handlersFor(harness, id).onClaudeInboxAnnouncement, undefined);
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined);
  });
});

test("exact proof binds one opaque sender that exposes no token or endpoint and sends nothing", linuxOnly, async () => {
  await withHarness(async (harness) => {
    const id = await createClaude(harness);
    const request = harness.providerCalls[0]!;
    assert.equal(request.claudeInboxCompatibility, true, "the launch asked for its own compatibility receipt");
    assert.ok(request.nativeHook, "beside the unchanged hook arming");
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined, "nothing exists before proof");

    const sender = await bound(harness, id);
    assert.equal(sender.conversationId, SESSION_A);
    assert.equal(sender.isCurrent(), true);
    assert.ok(Object.isFrozen(sender));
    assert.equal(harness.manager.nativeClaudeInboxSender(id), sender, "the same object for the same binding");

    // The token and endpoint never surface through serialization, inspection, or views.
    const surfaces = [
      JSON.stringify(sender),
      inspect(sender, { showHidden: true, depth: 8 }),
      JSON.stringify(harness.manager.list()),
      inspect(harness.manager.list(), { depth: 8 }),
      JSON.stringify(Object.getOwnPropertyNames(sender.capability)),
    ];
    for (const text of surfaces) {
      assert.equal(text.includes(harness.token), false, "the hook token never appears");
      assert.equal(text.includes(harness.socketPath), false, "the socket path never appears");
    }
    assert.equal(harness.connections(), 0, "binding never connects");
  });
});

test("a declined, unsupported, or missing receipt exposes no sender even after full proof", linuxOnly, async () => {
  for (const receipt of ["declined", "unsupported-claim", "prerelease-claim", "malformed-claim", "silent"] as const) {
    await withHarness(async (harness) => {
      harness.setReceipt(receipt);
      const id = await createClaude(harness);
      assert.equal(harness.providerCalls[0]!.claudeInboxCompatibility, true);
      deliverRootStart(harness, id);
      assert.deepEqual(harness.binds, [], `${receipt} receipt starts no bind attempt`);
      assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined, `${receipt} receipt binds nothing`);
    });
  }
});

test("#682: a newer stable receipt binds only after the same full proof", linuxOnly, async () => {
  await withHarness(async (harness) => {
    harness.setReceipt("newer-stable");
    const id = await createClaude(harness);
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined, "nothing exists before proof");
    deliverRootStart(harness, id, { announcedSession: SESSION_B });
    await allSettled(harness);
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined, "a mismatched announcement still binds nothing");
    const sender = await bound(harness, id);
    assert.equal(sender.conversationId, SESSION_A);
    assert.equal(sender.isCurrent(), true);
    assert.equal(harness.connections(), 0, "binding never connects");
  });
});

test("mismatched or unproved announcements expose no sender", linuxOnly, async () => {
  const NONE: readonly string[] = [];
  const DROPPED: readonly string[] = ["started", "dropped"];
  const cases: { name: string; expect?: readonly string[]; act: (harness: Harness, id: string) => void }[] = [
    { name: "announced session differs", act: (h, id) => deliverRootStart(h, id, { announcedSession: SESSION_B }) },
    {
      name: "provider cwd is not the workspace",
      act: (h, id) => { observerFor(h, id).mode = "accept-any"; deliverRootStart(h, id, { cwd: h.root }); },
    },
    {
      name: "subagent SessionStart",
      act: (h, id) => { observerFor(h, id).mode = "accept-any"; deliverRootStart(h, id, { agentId: "agent-1" }); },
    },
    {
      name: "observer did not accept the identity",
      act: (h, id) => { observerFor(h, id).mode = "silent"; deliverRootStart(h, id); },
    },
    {
      name: "observer threw on the SessionStart",
      act: (h, id) => { observerFor(h, id).mode = "throw"; deliverRootStart(h, id); },
    },
    {
      name: "announcement without its SessionStart in the same dispatch",
      act: (h, id) => {
        deliverRootStart(h, id, { announce: false });
        handlersFor(h, id).onEvent({ backend: "claude", hook_event_name: "UserPromptSubmit", session_id: SESSION_A });
        announce(h, id, SESSION_A);
      },
    },
    {
      name: "a replayed announcement after the proof was consumed",
      expect: DROPPED,
      act: (h, id) => {
        deliverRootStart(h, id, { socketPath: join(h.root, "missing.sock") });
        announce(h, id, SESSION_A);
      },
    },
    { name: "endpoint is missing", expect: DROPPED, act: (h, id) => deliverRootStart(h, id, { socketPath: join(h.root, "missing.sock") }) },
    {
      name: "endpoint is not a socket",
      expect: DROPPED,
      act: (h, id) => {
        const file = join(h.root, "f.sock");
        writeFileSync(file, "not a socket\n", { mode: 0o600 });
        deliverRootStart(h, id, { socketPath: file });
      },
    },
    {
      name: "endpoint path is not canonical",
      expect: DROPPED,
      act: (h, id) => {
        symlinkSync(h.root, join(h.root, "l"));
        deliverRootStart(h, id, { socketPath: join(h.root, "l", "i.sock") });
      },
    },
  ];
  for (const { name, act, expect } of cases) {
    await withHarness(async (harness) => {
      const id = await createClaude(harness);
      act(harness, id);
      await allSettled(harness);
      assert.deepEqual(harness.binds, expect ?? NONE, `${name}: bind attempts`);
      assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined, name);
    });
  }
});

test("conversation loss, a different conversation, root SessionEnd, generation loss, exit, and disposal invalidate", linuxOnly, async () => {
  const losses: { name: string; lose: (harness: Harness, id: string) => Promise<void> | void }[] = [
    { name: "explicit identity loss", lose: (h, id) => { assert.equal(observerFor(h, id).identity(null), true); } },
    { name: "a different accepted conversation", lose: (h, id) => { assert.equal(observerFor(h, id).identity(SESSION_B), true); } },
    {
      name: "its own root SessionEnd",
      lose: (h, id) => handlersFor(h, id).onEvent({ backend: "claude", hook_event_name: "SessionEnd", session_id: SESSION_A, reason: "other" }),
    },
    {
      name: "observation generation loss",
      lose: (h, id) => { assert.equal(h.manager.nativeStatusCapture(id)?.invalidate().accepted, true); },
    },
    { name: "child exit", lose: (h) => h.spawned[0]!.emitExit(0) },
    { name: "confirmed stop", lose: async (h, id) => { await h.manager.stop(id, { confirmed: true }); } },
    { name: "manager disposal", lose: async (h) => { await h.manager.dispose(); } },
  ];
  for (const { name, lose } of losses) {
    await withHarness(async (harness) => {
      const id = await createClaude(harness);
      const sender = await bound(harness, id);
      await lose(harness, id);
      assert.equal(sender.isCurrent(), false, `${name}: the old sender is no longer current`);
      assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined, `${name}: no sender is exposed`);
      // The capability itself refuses before any endpoint I/O.
      const result = await sendClaudeInboxMessage(sender.capability, "wake");
      assert.deepEqual(result, { disposition: "refused", reason: "not_current" }, name);
    });
  }
});

test("a new root SessionStart replaces the binding; the old sender never becomes current again", linuxOnly, async () => {
  await withHarness(async (harness) => {
    const id = await createClaude(harness);
    const first = await bound(harness, id);
    deliverRootStart(harness, id, { session: SESSION_B });
    assert.equal(first.isCurrent(), false, "the earlier binding ends at the new root SessionStart");
    await until(() => harness.manager.nativeClaudeInboxSender(id) !== undefined, "the new binding forms");
    const second = harness.manager.nativeClaudeInboxSender(id);
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(second.conversationId, SESSION_B);
    assert.equal(first.isCurrent(), false);
  });
});

test("a stale in-flight binding never lands, and never on a successor run", linuxOnly, async () => {
  await withHarness(async (harness) => {
    const first = await createClaude(harness);
    // The endpoint capture is asynchronous: end the run in the same synchronous stretch.
    deliverRootStart(harness, first);
    harness.spawned[0]!.emitExit(0);
    const successor = await createClaude(harness);
    assert.notEqual(successor, first);
    await allSettled(harness);
    assert.deepEqual(harness.binds, ["started", "dropped"], "the stale attempt settled as dropped");
    assert.equal(harness.manager.nativeClaudeInboxSender(first), undefined, "the stale run binds nothing");
    assert.equal(harness.manager.nativeClaudeInboxSender(successor), undefined, "the successor inherits nothing");

    // A conversation change while a capture is in flight drops that attempt too.
    deliverRootStart(harness, successor);
    assert.equal(observerFor(harness, successor).identity(SESSION_B), true);
    await allSettled(harness);
    assert.deepEqual(harness.binds.slice(2), ["started", "dropped"], "the superseded attempt settled as dropped");
    assert.equal(harness.manager.nativeClaudeInboxSender(successor), undefined, "the superseded attempt binds nothing");

    // The successor's own fresh proof binds independently.
    deliverRootStart(harness, successor, { session: SESSION_B });
    await until(() => harness.manager.nativeClaudeInboxSender(successor) !== undefined, "the successor binds on its own proof");
    assert.equal(harness.manager.nativeClaudeInboxSender(successor)?.conversationId, SESSION_B);
    assert.equal(harness.manager.nativeClaudeInboxSender(first), undefined);
  });
});

test("a late root SessionEnd of another conversation leaves the binding, even mid-capture; its own end invalidates", linuxOnly, async () => {
  await withHarness(async (harness) => {
    const id = await createClaude(harness);
    const first = await bound(harness, id);
    const endA = (): void => handlersFor(harness, id).onEvent({
      backend: "claude", hook_event_name: "SessionEnd", session_id: SESSION_A, reason: "other",
    });
    // B's proof starts a capture; A's late end arrives while it is still pending.
    deliverRootStart(harness, id, { session: SESSION_B, source: "clear" });
    assert.equal(first.isCurrent(), false);
    endA();
    await allSettled(harness);
    const second = harness.manager.nativeClaudeInboxSender(id);
    assert.ok(second, "A's late end did not drop B's pending capture");
    assert.equal(second.conversationId, SESSION_B);
    endA();
    assert.equal(second.isCurrent(), true, "A's late end leaves B's bound sender current");
    assert.equal(harness.manager.nativeClaudeInboxSender(id), second);
    handlersFor(harness, id).onEvent({ backend: "claude", hook_event_name: "SessionEnd", session_id: SESSION_B, reason: "other" });
    assert.equal(second.isCurrent(), false, "B's own end invalidates it");
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined);
  });
});

test("real Claude observer: an accepted startup binds; a deduplicated repeat neither mints nor replaces", linuxOnly, async () => {
  await withHarness(async (harness) => {
    const id = await createClaude(harness);
    // The accepted original start, without an announcement: identity proved, nothing bound.
    deliverRootStart(harness, id, { announce: false });
    assert.equal(harness.manager.hasProvedNativeConversation(id), true, "the real observer proved the conversation");
    assert.deepEqual(harness.binds, []);
    // A repeated startup for the same session is refused by the observer: the
    // cached identity must not stand in for its verdict.
    deliverRootStart(harness, id);
    assert.deepEqual(harness.binds, [], "the duplicate startup starts no bind attempt");
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined);

    // A start the observer positively accepts (another conversation) binds.
    deliverRootStart(harness, id, { session: SESSION_B, source: "clear" });
    await allSettled(harness);
    assert.deepEqual(harness.binds, ["started", "bound"]);
    const sender = harness.manager.nativeClaudeInboxSender(id);
    assert.ok(sender);
    assert.equal(sender.conversationId, SESSION_B);

    // Repeats of B's startup, with and without an announcement, leave it unchanged.
    deliverRootStart(harness, id, { session: SESSION_B, announce: false });
    deliverRootStart(harness, id, { session: SESSION_B });
    await allSettled(harness);
    assert.deepEqual(harness.binds, ["started", "bound"], "no duplicate starts another attempt");
    assert.equal(sender.isCurrent(), true, "the bound sender stays current");
    assert.equal(harness.manager.nativeClaudeInboxSender(id), sender, "and is the same binding");
  }, { observer: "real" });
});

test("real Claude observer: a foreign late SessionEnd keeps the binding and the bound session's own end ends it", linuxOnly, async () => {
  await withHarness(async (harness) => {
    const id = await createClaude(harness);
    deliverRootStart(harness, id);
    await allSettled(harness);
    const first = harness.manager.nativeClaudeInboxSender(id);
    assert.ok(first, "the real observer's accepted startup binds A");
    deliverRootStart(harness, id, { session: SESSION_B, source: "clear" });
    assert.equal(first.isCurrent(), false, "A's binding ends at B's accepted start");
    handlersFor(harness, id).onEvent({ backend: "claude", hook_event_name: "SessionEnd", session_id: SESSION_A, reason: "other" });
    await allSettled(harness);
    const second = harness.manager.nativeClaudeInboxSender(id);
    assert.ok(second);
    assert.equal(second.conversationId, SESSION_B);
    assert.equal(second.isCurrent(), true);
    handlersFor(harness, id).onEvent({ backend: "claude", hook_event_name: "SessionEnd", session_id: SESSION_B, reason: "other" });
    assert.equal(second.isCurrent(), false);
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined);
  }, { observer: "real" });
});

/* ------------------------------------------------------------------------ *
 * #682: the macOS (Darwin) binding. Portable: the manager's Darwin rule is   *
 * selected through the sender's platform seam and the real Darwin endpoint   *
 * proof runs against an injected fake Darwin namespace (fixed /tmp alias,    *
 * owners, modes, ctimes, ACL listings). Nothing here proves real macOS.      *
 * ------------------------------------------------------------------------ */

const DARWIN_UID = 501;
const DARWIN_SOCKET = "/tmp/claude-501/i.sock";
const DARWIN_CANONICAL = `/private${DARWIN_SOCKET}`;
const S_TYPE = { dir: 0o040000n, link: 0o120000n, sock: 0o140000n, file: 0o100000n } as const;
let darwinIno = 70_000n;

class DarwinWorld {
  readonly stats = new Map<string, ClaudeDarwinLstat>();
  readonly links = new Map<string, string>();
  readonly acl = new Map<string, string[]>();
  readonly listed: string[] = [];
  /** When set, each listing waits for this gate before answering. */
  gate?: Promise<void>;

  readonly fs: ClaudeDarwinFsProbe = {
    lstat: async (path) => {
      const stats = this.stats.get(path);
      if (stats === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return stats;
    },
    readlink: async (path) => {
      const target = this.links.get(path);
      if (target === undefined) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      return target;
    },
  };

  readonly executor = async (_tool: string, args: readonly string[], _options: ClaudeDarwinAclExecOptions): Promise<ClaudeDarwinAclExecResult> => {
    const path = args[args.length - 1] as string;
    this.listed.push(path);
    if (this.gate !== undefined) await this.gate;
    const stats = this.stats.get(path);
    if (stats === undefined) return { status: "exited", exitCode: 1, stdout: Buffer.alloc(0) };
    const m = Number(stats.mode & 0o7777n);
    const t = (r: number, w: number, x: number, sb: number, on: string, off: string): string =>
      `${m & r ? "r" : "-"}${m & w ? "w" : "-"}${m & sb ? (m & x ? on : off) : (m & x ? "x" : "-")}`;
    const perm = t(0o400, 0o200, 0o100, 0o4000, "s", "S") + t(0o040, 0o020, 0o010, 0o2000, "s", "S") + t(0o004, 0o002, 0o001, 0o1000, "t", "T");
    const type = stats.mode & 0o170000n;
    const kind = type === S_TYPE.dir ? "d" : type === S_TYPE.link ? "l" : type === S_TYPE.sock ? "s" : "-";
    const entries = this.acl.get(path) ?? [];
    const name = kind === "l" ? `${path} -> ${this.links.get(path)}` : path;
    const lines = [`${stats.ino} ${kind}${perm}${entries.length > 0 ? "+" : ""} 1 someone  staff  0 Jan  1 00:00 ${name}`];
    entries.forEach((entry, index) => lines.push(` ${index}: ${entry}`));
    return { status: "exited", exitCode: 0, stdout: Buffer.from(`${lines.join("\n")}\n`, "utf8") };
  };

  set(path: string, kind: keyof typeof S_TYPE, uid: number, perm: number): void {
    darwinIno += 1n;
    this.stats.set(path, { dev: 16777220n, ino: darwinIno, uid: BigInt(uid), mode: S_TYPE[kind] | BigInt(perm), ctimeNs: 1_700_000_000_000_000_000n + darwinIno });
  }
}

function darwinWorld(): DarwinWorld {
  const w = new DarwinWorld();
  w.set("/", "dir", 0, 0o755);
  w.set("/bin/ls", "file", 0, 0o755);
  w.set("/tmp", "link", 0, 0o755);
  w.links.set("/tmp", "private/tmp");
  w.set("/private", "dir", 0, 0o755);
  w.set("/private/tmp", "dir", 0, 0o1777);
  w.set("/private/tmp/claude-501", "dir", DARWIN_UID, 0o700);
  w.set(DARWIN_CANONICAL, "sock", DARWIN_UID, 0o600);
  return w;
}

/** A minimal managed MCP lane owner: registers, never dispatches a tool here. */
function laneOwner(): NonNullable<InstanceManagerOptions["nativeMcpLane"]> {
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
        release: () => undefined,
        liveConnection: () => undefined,
      }),
    },
    delegate: {
      listTools: async () => [],
      callTool: async () => undefined,
    },
  } as unknown as NonNullable<InstanceManagerOptions["nativeMcpLane"]>;
}

/** The managed configuration Main uses on macOS: the lane plus the lane-scoped inbox. */
const MANAGED_DARWIN = { extra: { nativeMcpLane: laneOwner(), nativeClaudeInboxRequiresMcpLane: true } } as const;

/** Run `body` with this manager's Claude inbox on the Darwin rule, over `world`. */
async function withDarwin(world: DarwinWorld, body: () => Promise<void>): Promise<void> {
  setClaudeInboxPlatformForTests("darwin");
  setClaudeInboxDarwinProofSeamsForTests({ fs: world.fs, getuid: () => DARWIN_UID, aclExecutor: world.executor });
  try {
    await body();
  } finally {
    setClaudeInboxPlatformForTests(undefined);
    setClaudeInboxDarwinProofSeamsForTests(undefined);
    setClaudeInboxConnectorForTests(undefined);
  }
}

function withDarwinHarness(
  world: DarwinWorld,
  body: (harness: Harness) => Promise<void>,
  overrides: Parameters<typeof withHarness>[1] = MANAGED_DARWIN,
): Promise<void> {
  return withDarwin(world, () => withHarness(body, overrides));
}

async function boundDarwin(harness: Harness, id: string, session = SESSION_A): Promise<NonNullable<ReturnType<InstanceManager["nativeClaudeInboxSender"]>>> {
  deliverRootStart(harness, id, { session, socketPath: DARWIN_SOCKET });
  await until(() => harness.manager.nativeClaudeInboxSender(id)?.conversationId === session, "the Darwin inbox sender binds");
  const sender = harness.manager.nativeClaudeInboxSender(id);
  assert.ok(sender);
  return sender;
}

class RecordingSocket extends Duplex {
  readonly writes: Buffer[] = [];
  constructor() { super({ allowHalfOpen: false }); }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk);
    callback();
  }
}

const posixHost = { skip: process.platform === "win32" ? "the synthetic harness uses POSIX paths and a Unix socket" : false };

test("#682 Darwin: the announcement binds one opaque sender only after the ACL-aware endpoint proof, and that sender sends the same wire bytes", posixHost, async () => {
  const world = darwinWorld();
  await withDarwinHarness(world, async (harness) => {
    harness.setReceipt("newer-stable");
    const id = await createClaude(harness);
    assert.equal(harness.providerCalls[0]!.claudeInboxCompatibility, true);
    assert.equal(harness.providerCalls[0]!.claudeInboxRequiresNativeMcp, true, "the receipt is scoped to the managed lane");
    assert.ok(harness.providerCalls[0]!.nativeMcp, "beside this run's own MCP option");
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined, "nothing exists before proof");
    const sender = await boundDarwin(harness, id);
    assert.ok(world.listed.includes("/tmp") && world.listed.includes(DARWIN_CANONICAL), "the alias and the socket were proved");
    assert.equal(sender.isCurrent(), true);
    assert.ok(Object.isFrozen(sender));
    for (const text of [JSON.stringify(sender), inspect(sender, { showHidden: true, depth: 8 }), JSON.stringify(harness.manager.list())]) {
      assert.equal(text.includes(harness.token), false, "the hook token never appears");
      assert.equal(text.includes("claude-501"), false, "neither socket spelling appears");
    }

    // The bound capability re-proves around its own connect and writes the Linux frames.
    const sockets: RecordingSocket[] = [];
    const paths: string[] = [];
    setClaudeInboxConnectorForTests((path) => {
      const socket = new RecordingSocket();
      paths.push(path);
      sockets.push(socket);
      setImmediate(() => socket.emit("connect"));
      return socket;
    });
    const result = await sendClaudeInboxMessage(sender.capability, "wake");
    assert.equal(result.disposition, "sent_unconfirmed", JSON.stringify(result));
    assert.deepEqual(paths, [DARWIN_CANONICAL]);
    assert.equal(Buffer.concat(sockets[0]!.writes).toString("utf8"),
      `{"type":"auth","token":${JSON.stringify(harness.token)}}\n`
      + `{"type":"user","session_id":"${SESSION_A}","message":{"role":"user","content":"wake"}}\n`);
  });
});

test("#682 Darwin: an unproved endpoint binds nothing, and the Linux capture is never a fallback", posixHost, async () => {
  const cases: Array<[string, (world: DarwinWorld) => void, string?]> = [
    ["allow ACL on the socket", (w) => { w.acl.set(DARWIN_CANONICAL, ["user:mallory allow delete"]); }],
    ["allow ACL on a parent", (w) => { w.acl.set("/private/tmp/claude-501", ["group:staff allow add_file"]); }],
    ["socket owned by another account", (w) => { w.set(DARWIN_CANONICAL, "sock", 502, 0o600); }],
    ["parent owned by another account", (w) => { w.set("/private/tmp/claude-501", "dir", 502, 0o700); }],
    ["alias with a foreign target", (w) => { w.links.set("/tmp", "/Users/mallory/tmp"); }],
    ["missing socket", (w) => { w.stats.delete(DARWIN_CANONICAL); }],
    // The harness's real Linux socket would pass the Linux capture on this host;
    // on the Darwin rule only the Darwin proof counts, and it has no such object.
    ["a real socket outside the proved namespace", () => undefined, "harness"],
  ];
  for (const [label, mutate, socket] of cases) {
    const world = darwinWorld();
    mutate(world);
    await withDarwinHarness(world, async (harness) => {
      const id = await createClaude(harness);
      deliverRootStart(harness, id, { socketPath: socket === "harness" ? harness.socketPath : DARWIN_SOCKET });
      await allSettled(harness);
      assert.deepEqual(harness.binds, ["started", "dropped"], label);
      assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined, `${label}: no sender`);
    });
  }
});

test("#682 Darwin: a declined receipt starts no proof", posixHost, async () => {
  const world = darwinWorld();
  await withDarwinHarness(world, async (harness) => {
    harness.setReceipt("declined");
    const id = await createClaude(harness);
    deliverRootStart(harness, id, { socketPath: DARWIN_SOCKET });
    assert.deepEqual(harness.binds, []);
    assert.deepEqual(world.listed, [], "no endpoint proof without a verified receipt");
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined);
  });
});

test("#682 Darwin: a proof in flight when its binding goes stale never lands; /clear replaces and invalidates the old sender for good", posixHost, async () => {
  const world = darwinWorld();
  await withDarwinHarness(world, async (harness) => {
    const id = await createClaude(harness);
    // Hold the proof inside its listings while the conversation changes.
    let release!: () => void;
    world.gate = new Promise<void>((resolve) => { release = resolve; });
    deliverRootStart(harness, id, { socketPath: DARWIN_SOCKET });
    await until(() => world.listed.length > 0, "the Darwin proof is in flight");
    assert.equal(observerFor(harness, id).identity(SESSION_B), true);
    release();
    world.gate = undefined;
    await allSettled(harness);
    assert.deepEqual(harness.binds, ["started", "dropped"], "the stale proof settled as dropped");
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined);

    // A fresh proof for the current conversation binds; a proved /clear replaces it.
    const first = await boundDarwin(harness, id, SESSION_B);
    deliverRootStart(harness, id, { session: SESSION_A, source: "clear", socketPath: DARWIN_SOCKET });
    assert.equal(first.isCurrent(), false, "the old authority ends at the new root SessionStart");
    await until(() => harness.manager.nativeClaudeInboxSender(id)?.conversationId === SESSION_A, "the /clear binding forms");
    const second = harness.manager.nativeClaudeInboxSender(id);
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(first.isCurrent(), false, "and never becomes current again");
    const stale = await sendClaudeInboxMessage(first.capability, "wake");
    assert.deepEqual(stale, { disposition: "refused", reason: "not_current" });

    // Exit retires the run: the Darwin sender is gone with it.
    harness.spawned[0]!.emitExit(0);
    assert.equal(second.isCurrent(), false);
    assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined);
  });
});

test("#682 Darwin: without a prepared managed MCP lane there is no receipt request, no proof, and no sender", posixHost, async () => {
  const cases: Array<[string, Parameters<typeof withHarness>[1], "prepared" | "unavailable"]> = [
    // The standalone opt-in (hooks only), which still binds on Linux.
    ["hooks-only standalone opt-in", {}, "prepared"],
    ["lane registered but its preparation unavailable", { extra: { nativeMcpLane: laneOwner() } }, "unavailable"],
  ];
  for (const [label, overrides, mcp] of cases) {
    const world = darwinWorld();
    await withDarwinHarness(world, async (harness) => {
      harness.setProviderMcp(mcp);
      const id = await createClaude(harness);
      const request = harness.providerCalls[0]!;
      if (request.nativeMcp === undefined) {
        assert.equal(request.claudeInboxCompatibility, undefined, `${label}: no receipt is requested without a lane`);
      } else {
        assert.equal(request.claudeInboxRequiresNativeMcp, true, `${label}: the request is lane-scoped on macOS`);
      }
      deliverRootStart(harness, id, { socketPath: DARWIN_SOCKET });
      await allSettled(harness);
      assert.deepEqual(harness.binds, [], `${label}: no bind attempt`);
      assert.deepEqual(world.listed, [], `${label}: no endpoint proof`);
      assert.equal(harness.manager.nativeClaudeInboxSender(id), undefined, `${label}: no sender`);
    }, overrides);
  }
});
