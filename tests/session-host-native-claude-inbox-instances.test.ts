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
import { CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES, sendClaudeInboxMessage } from "../src/session-host/native-claude-inbox-delivery";
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

type Receipt = "verified" | "declined" | "unsupported-claim" | "silent";

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
          else if (receipt === "unsupported-claim") claudeInboxCompatibility = Object.freeze({ compatibility: "verified", version: "9.9.9" });
        }
        return {
          file: `/synthetic/bin/${backend}`,
          args: ["--interactive"],
          env: { PATH: "/synthetic/bin", HOME: home },
          cwd: request.workspace,
          ...(claudeInboxCompatibility === undefined ? {} : { claudeInboxCompatibility }),
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

test("construction refuses a malformed or half-wired opt-in", () => {
  const base = { packageRoot: "/synthetic", piExecutable: "/synthetic/pi", statusRegistrar: new RecordingPiRegistrar() };
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
  for (const receipt of ["declined", "unsupported-claim", "silent"] as const) {
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
