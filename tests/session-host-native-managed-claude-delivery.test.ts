/**
 * #682: canonical managed completion of an admitted native Claude task reaches
 * THAT exact run's own Claude inbox sender through the production sidebar lane
 * glue (`createNativeManagedHostLane` with its `claudeInbox` accessor).
 *
 * EVIDENCE SCOPE: the end-to-end tests drive the REAL `InstanceManager` (with
 * the `nativeClaudeInbox` opt-in), the real composed lane, the real custody,
 * owner, restore, association store, no-Pi `ExecutionToolManager`, controller,
 * `WakeDelivery`, and the real `sendClaudeInboxMessage`, through the MCP
 * endpoint the manager registers. Only the provider launch (which answers the
 * compatibility receipt), the PTY, the hook registrar, and the observer are
 * synthetic; the "Claude inbox" is a test-owned listening Unix socket in a
 * private directory that records the frames it receives. The admitted task runs
 * a deterministic external fake executor that lands one file in a scratch Git
 * workspace. No provider binary, prompt, relay, or peer is involved. The
 * lane-level tests capture the sink the lane hands each owner and exercise its
 * refusals directly with hand-built runs. Every root, server, manager, and
 * custody is removed or drained on every exit.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExecutionToolManager } from "../src/execution/tool";
import type { ManagedNativeEvent } from "../src/execution/wake-delivery";
import type { NativeHookSourceHandlers, NativeMcpRegistration } from "../src/session-host/broker";
import {
  __test as instancesTest,
  InstanceManager,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type NativeClaudeInboxSender,
  type NativeCliLaunchDescriptor,
  type NativeMcpLaneContext,
  type NativeMcpLaneRunScope,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
} from "../src/session-host/instances";
import {
  CLAUDE_INBOX_SOCKET_ENV,
  CLAUDE_INBOX_TOKEN_ENV,
  selectClaudeInboxAnnouncement,
} from "../src/session-host/native-claude-inbox-announcement";
import { CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES, createClaudeInboxSendCapability } from "../src/session-host/native-claude-inbox-delivery";
import {
  createNativeManagedConversationOwner,
  type NativeManagedConversationOwnerOptions,
} from "../src/session-host/native-managed-conversation-owner";
import { createNativeManagedHostLane, type NativeManagedHostLaneInput } from "../src/session-host/native-managed-host-lane";
import type { NativeHookEvent } from "../src/session-host/native-hook-protocol";
import type { NativeMcpLaunchOutcome } from "../src/session-host/native-mcp-launch-prep";
import type { NativeMcpToolEndpoint } from "../src/session-host/native-mcp-stdio";
import { sessionHostStateDir } from "../src/session-host/roster-store";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import { initGitRepo, waitFor } from "./helpers/background-controller-fixtures";
import { queuedTask } from "./managed-tool-fixtures";

const SUPPORTED_CLAUDE = "2.1.330";
const SESSION_A = "1d6f2b9e-3c4a-4e5f-9a0b-1c2d3e4f5a6b";
const SESSION_B = "8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0";
const PI_FILE = "/synthetic/pi/dist/cli.js";
const linuxOnly = { skip: process.platform !== "linux" ? "the Claude inbox endpoint is supported on Linux only" : false };

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

/* ------------------------------------------------------------------------- *
 * Owned scratch                                                              *
 * ------------------------------------------------------------------------- */

interface Scratch {
  /** Owned root for state, workspace, settings, executor, and controller artifacts. */
  readonly root: string;
  /** Short private root for the synthetic inbox sockets (portable Unix path bound). */
  readonly sockets: string;
  readonly agentDir: string;
  readonly home: string;
  readonly workspace: string;
  readonly release: string;
  /**
   * Register a disposer at once, right after the resource it releases exists.
   * Disposers run in reverse order before the roots are removed, on every exit.
   */
  defer(dispose: () => unknown): void;
}

interface TestHooks { after(fn: () => void | Promise<void>): void }

/**
 * One owned scratch per test. Its cleanup is registered BEFORE any fallible
 * setup and tracks each root as it is created, so a partial setup is removed
 * too. The real controller places artifacts under the platform temp directory,
 * so it points inside the root until removal.
 */
function ownedScratch(t: TestHooks): Scratch {
  const created: string[] = [];
  const disposers: Array<() => unknown> = [];
  const tempVars = ["TMPDIR", "TMP", "TEMP"] as const;
  let original: Array<string | undefined> | undefined;
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
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
      assert.equal(created.some((dir) => existsSync(dir)), false, "the scratch is removed immediately");
    }
  });
  const createdRoot = (prefix: string): string => {
    const raw = mkdtempSync(join(tmpdir(), prefix));
    created.push(raw);
    return realpathSync(raw);
  };
  const sockets = createdRoot("pmc-");
  const root = createdRoot("prg-native-managed-claude-delivery-");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  for (const dir of [agentDir, home, workspace, artifacts]) mkdirSync(dir, { mode: 0o700 });
  mkdirSync(sessionHostStateDir(agentDir), { mode: 0o700 });
  original = tempVars.map((key) => process.env[key]);
  for (const key of tempVars) process.env[key] = artifacts;
  return {
    root, sockets, agentDir, home, workspace, release: join(root, "release"),
    defer: (dispose) => { disposers.push(dispose); },
  };
}

/** Saved settings whose only worker is a fake executor that lands one file once `release` exists. */
function writeLandingSettings(scratch: Scratch, gated: boolean): void {
  const executor = join(scratch.root, "executor.cjs");
  writeFileSync(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
    `const release=${JSON.stringify(scratch.release)};const gated=${gated};`,
    "const finish=()=>{fs.writeFileSync('landed.txt','landed\\n');",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));};",
    "if(!gated){finish();return;}",
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
 * Synthetic owned inbox                                                      *
 * ------------------------------------------------------------------------- */

interface Inbox {
  readonly path: string;
  readonly token: string;
  /** Frames received per connection, parsed from NDJSON once the peer ends. */
  readonly connections: Array<readonly Record<string, unknown>[]>;
  readonly opened: () => number;
  readonly listening: () => boolean;
  close(): Promise<void>;
}

/** Listen on one synthetic inbox; its close is deferred the moment it listens. */
async function listenInbox(scratch: Scratch, name: string, path: string = join(scratch.sockets, `${name}.sock`)): Promise<Inbox> {
  assert.ok(Buffer.byteLength(path) <= CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES, "the synthetic socket path fits the Unix bound");
  const connections: Array<readonly Record<string, unknown>[]> = [];
  let opened = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    opened += 1;
    sockets.add(socket);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    socket.on("end", () => {
      const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter((line) => line !== "");
      connections.push(lines.map((line) => JSON.parse(line) as Record<string, unknown>));
      socket.end();
    });
  });
  const close = (): Promise<void> => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  scratch.defer(close);
  return {
    path,
    token: `tok-${randomBytes(24).toString("hex")}`,
    connections,
    opened: () => opened,
    listening: () => server.listening,
    close,
  };
}

/* ------------------------------------------------------------------------- *
 * Real manager harness                                                       *
 * ------------------------------------------------------------------------- */

class SyntheticPty implements InstancePty {
  static #nextPid = 970_000;
  readonly pid: number;
  cols: number;
  rows: number;
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
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(signal?: string): void {
    if (this.#exited || (signal ?? "SIGHUP") !== "SIGTERM") return;
    this.#exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode: 0, signal: 15 });
  }
}

/** Accepts identity like the real Claude observer: a root SessionStart in the row's workspace. */
class SyntheticClaudeObserver implements NativeStatusObserver {
  constructor(readonly context: NativeStatusObserverContext) {}
  acceptHook(event: NativeHookEvent): void {
    if (event.hook_event_name === "SessionStart" && event.agent_id === undefined
      && typeof event.session_id === "string" && event.cwd === this.context.workspace) {
      this.context.emitConversationIdentity?.(event.session_id);
    }
  }
  acceptFailure(): void {}
  dispose(): void {}
}

interface Harness {
  readonly manager: InstanceManager;
  readonly endpoints: Map<string, NativeMcpToolEndpoint>;
  readonly slots: Map<string, string>;
  readonly owners: { created: NativeManagedConversationOwnerOptions[]; managers: ExecutionToolManager[] };
  /** Every attempt of the lane's real sink and how it settled (the owner has no notify). */
  readonly sinkCalls: Array<{ readonly kind: string; outcome?: string }>;
  /** What each launch asked its provider for (inbox compatibility and its MCP scope). */
  readonly providerCalls: Array<{ readonly compatibility: boolean; readonly requiresMcp: boolean; readonly mcp: boolean }>;
  /** The managed MCP setup of the NEXT launches: prepared, unavailable at the provider, or never registered. */
  setMcp(mode: "prepared" | "unavailable" | "unregistered"): void;
  createClaude(): Promise<string>;
  /** Root SessionStart then the same dispatch's announcement, as the broker delivers them. */
  bindInbox(rowId: string, session: string, inbox: Inbox): Promise<NativeClaudeInboxSender>;
  /** The same delivery, for a run that must bind nothing: how many bind attempts started. */
  refusedBind(rowId: string, session: string, inbox: Inbox): Promise<number>;
  revokeConversation(rowId: string, session: string): void;
}

/** Real manager + real lane, wired the way Main wires them. */
function realHarness(scratch: Scratch): Harness {
  const packageRoot = join(scratch.root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  for (const file of ["index.js", "session-host/reporter.js", "session-host/bootstrap-preload.js"]) {
    writeFileSync(join(packageRoot, "dist", "src", file), "// Synthetic fixture; never executed.\n", "utf8");
  }
  const piExecutable = join(scratch.root, "bin", "mock-pi");
  mkdirSync(join(scratch.root, "bin"));
  writeFileSync(piExecutable, "#!/usr/bin/env node\n// Synthetic inert fixture.\n", "utf8");
  chmodSync(piExecutable, 0o755);

  const endpoints = new Map<string, NativeMcpToolEndpoint>();
  const hookHandlers = new Map<string, NativeHookSourceHandlers>();
  const observers = new Map<string, NativeStatusObserverContext>();
  const slots = new Map<string, string>();
  const created: NativeManagedConversationOwnerOptions[] = [];
  const managers: ExecutionToolManager[] = [];
  const sinkCalls: Array<{ readonly kind: string; outcome?: string }> = [];
  const providerCalls: Array<{ readonly compatibility: boolean; readonly requiresMcp: boolean; readonly mcp: boolean }> = [];
  let mcpMode: "prepared" | "unavailable" | "unregistered" = "prepared";
  let manager: InstanceManager | undefined;
  const binds: string[] = [];
  instancesTest.setClaudeInboxBindListenerForTests((event) => { binds.push(event); });
  scratch.defer(() => instancesTest.setClaudeInboxBindListenerForTests(undefined));

  const hostBroker = {
    register() { throw new Error("no Pi child is registered in this test"); },
    registerNativeHookSource() { throw new Error("unused: the manager receives its own hook registrar"); },
    registerNativeMcpSource(instanceId: string, backend: NativeCliBackend, endpoint: NativeMcpToolEndpoint): NativeMcpRegistration {
      if (mcpMode === "unregistered") throw new Error("synthetic MCP registration failure");
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
    claudeInbox: { senderFor: (rowId) => manager?.nativeClaudeInboxSender(rowId) },
    testHooks: {
      ceiling: CEILING,
      createOwner: (options) => {
        created.push(options);
        const sink = options.nativeEventSink;
        // Observe the lane's real sink without changing what it does.
        const owner = createNativeManagedConversationOwner(sink === undefined ? options : {
          ...options,
          nativeEventSink: async (event) => {
            const call: { readonly kind: string; outcome?: string } = { kind: event.customType === "pi-review-subtask-event" ? event.kind : event.customType };
            sinkCalls.push(call);
            try {
              await sink(event);
              call.outcome = "sent_unconfirmed";
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
  });
  assert.equal(armed.status, "armed", JSON.stringify(armed));
  if (armed.status !== "armed") throw new Error("unreachable");
  const drainLane = armed.host.drain;
  scratch.defer(() => drainLane());

  manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: { register() { throw new Error("no Pi child in this test"); } },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch.home, PI_CODING_AGENT_DIR: scratch.agentDir },
    args: [],
    nativeCliLaunch: (backend, request) => (providerCalls.push({
      compatibility: request.claudeInboxCompatibility === true,
      requiresMcp: request.claudeInboxRequiresNativeMcp === true,
      mcp: request.nativeMcp !== undefined,
    }), {
      file: `/synthetic/bin/${backend}`,
      args: ["--interactive"],
      env: { PATH: "/synthetic/bin", HOME: scratch.home },
      cwd: request.workspace,
      // Deliberately answers "verified" whenever asked, so the manager's OWN lane
      // fence is what keeps an unmanaged run from binding.
      ...(request.claudeInboxCompatibility === true
        ? { claudeInboxCompatibility: Object.freeze({ compatibility: "verified", version: SUPPORTED_CLAUDE }) }
        : {}),
      ...(request.nativeMcp === undefined ? {} : mcpMode === "unavailable" ? {
        nativeMcp: { mcp: "unavailable", backend, reason: "artifact-path-unprotected" } as unknown as NativeMcpLaunchOutcome,
      } : {
        nativeMcp: {
          mcp: "prepared",
          backend,
          route: "claude-mcp-config-file",
          placement: "claude-tui",
          serverName: request.nativeMcp.serverName,
          args: [],
          lease: { root: "/synthetic/mcp-root", bootstrapFile: "/synthetic/mcp-root/bootstrap.json", cleanup: async () => ({ removed: true }) },
        } as unknown as NativeMcpLaunchOutcome,
      }),
    } as NativeCliLaunchDescriptor),
    nativeHookRegistrar: {
      registerNativeHookSource: (instanceId, backend, handlers) => (hookHandlers.set(instanceId, handlers), {
        bootstrap: { version: 1, socketPath: `/synthetic/native/${instanceId}.sock`, generation: randomUUID(), instanceId, backend, token: randomBytes(32).toString("hex") },
        release: () => undefined,
      }),
    },
    nativeStatusObserverFactory: (context) => {
      observers.set(context.rowId, context);
      return new SyntheticClaudeObserver(context);
    },
    nativeMcpLane: armed.host.lane,
    // Exactly Main's opt-in: scoped to runs whose own managed MCP lane is kept.
    nativeClaudeInbox: true,
    nativeClaudeInboxRequiresMcpLane: true,
    ptyFactory: (descriptor) => new SyntheticPty(descriptor),
  });
  const owned = manager;
  scratch.defer(() => owned.dispose());

  const deliverStart = (rowId: string, session: string, inbox: Inbox): void => {
    const handlers = hookHandlers.get(rowId);
    assert.ok(handlers?.onClaudeInboxAnnouncement, "the opted-in Claude row registered the announcement callback");
    handlers.onEvent({ backend: "claude", hook_event_name: "SessionStart", session_id: session, cwd: scratch.workspace, source: "startup" });
    const candidate = selectClaudeInboxAnnouncement("claude", { hook_event_name: "SessionStart", session_id: session }, {
      [CLAUDE_INBOX_SOCKET_ENV]: inbox.path,
      [CLAUDE_INBOX_TOKEN_ENV]: inbox.token,
    }, "linux");
    assert.ok(candidate);
    handlers.onClaudeInboxAnnouncement(candidate);
  };
  const started = (): number => binds.filter((event) => event === "started").length;

  return {
    manager: owned,
    endpoints,
    slots,
    owners: { created, managers },
    sinkCalls,
    providerCalls,
    setMcp: (mode) => { mcpMode = mode; },
    createClaude: async () => {
      const id = await owned.create({ workspace: scratch.workspace, backend: "claude" } as CreateInstanceOptions);
      slots.set(id, `slot-${slots.size + 1}`);
      return id;
    },
    bindInbox: async (rowId, session, inbox) => {
      const startedBefore = started();
      deliverStart(rowId, session, inbox);
      await waitFor(() => started() > startedBefore
        && binds.filter((event) => event === "bound" || event === "dropped").length === started(), 4000);
      const sender = owned.nativeClaudeInboxSender(rowId);
      assert.ok(sender, "the row's inbox sender bound");
      assert.equal(sender.conversationId, session);
      return sender;
    },
    refusedBind: async (rowId, session, inbox) => {
      const startedBefore = started();
      deliverStart(rowId, session, inbox);
      await settle(50);
      assert.equal(owned.nativeClaudeInboxSender(rowId), undefined, "no inbox sender binds");
      return started() - startedBefore;
    },
    revokeConversation: (rowId, session) => {
      assert.equal(observers.get(rowId)?.emitConversationIdentity?.(session), true);
    },
  };
}

const request = () => ({ signal: new AbortController().signal });

/* ------------------------------------------------------------------------- *
 * End to end through the production glue                                    *
 * ------------------------------------------------------------------------- */

test("end to end: an admitted Claude task's canonical completion reaches only its exact run's inbox, once", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch, true);
  const harness = realHarness(scratch);
  const inboxA = await listenInbox(scratch, "a");
  const inboxB = await listenInbox(scratch, "b");

  const rowA = await harness.createClaude();
  const rowB = await harness.createClaude();
  await harness.bindInbox(rowA, SESSION_A, inboxA);
  // Another proved Claude row in the same workspace with its own live inbox.
  await harness.bindInbox(rowB, SESSION_B, inboxB);

  const endpoint = harness.endpoints.get(rowA);
  assert.ok(endpoint);
  assert.deepEqual(harness.providerCalls.slice(0, 2), [
    { compatibility: true, requiresMcp: true, mcp: true },
    { compatibility: true, requiresMcp: true, mcp: true },
  ], "each managed launch asks for its receipt scoped to its own prepared MCP option");
  // Start/Inspect stay canonical; the managed catalog is unchanged (no Watch).
  // The request that acquires the owner is aborted once it returns, as is the
  // Start request: the sink belongs to the run, never to either request.
  const acquiring = new AbortController();
  const listed = await endpoint.listTools({ signal: acquiring.signal });
  assert.deepEqual(listed.map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
  acquiring.abort();
  const starting = new AbortController();
  const started = await endpoint.callTool({ name: "SubtasksStart", arguments: { tasks: [queuedTask("claude completion")] }, signal: starting.signal });
  assert.equal(started?.isError, false, text(started));
  starting.abort();
  assert.equal(harness.owners.created.length, 1);
  const owner = harness.owners.created[0]!;
  assert.equal(owner.identity.rowId, harness.slots.get(rowA), "the owner is keyed by the durable slot");
  assert.equal(typeof owner.nativeEventSink, "function", "the Claude hold's owner receives the run-bound sink");
  assert.equal(owner.notify, undefined);

  const manager = harness.owners.managers[0]!;
  const controller = (manager as unknown as { controller: { groups: Map<string, { executionId: string; tasks: Array<{ taskId: string; state: string }> }> } }).controller;
  const [group] = [...controller.groups.values()];
  assert.ok(group);
  const task = group.tasks[0]!;
  assert.equal(inboxA.opened(), 0, "nothing is sent before the outcome");
  writeFileSync(scratch.release, "go\n");
  await waitFor(() => task.state === "landed");
  await waitFor(() => inboxA.connections.length === 1);
  await settle();

  assert.equal(inboxA.opened(), 1, "one send attempt; nothing is retried or replayed");
  assert.deepEqual(harness.sinkCalls, [{ kind: "completion", outcome: "sent_unconfirmed" }],
    "the quiet default sends only the completion; the result claims no delivery");
  assert.equal(inboxB.opened(), 0, "another row's inbox is never targeted");
  const [auth, user] = inboxA.connections[0]!;
  assert.deepEqual(auth, { type: "auth", token: inboxA.token });
  assert.equal(user?.type, "user");
  assert.equal(user?.session_id, SESSION_A, "the exact bound conversation");
  const message = user?.message as { role: string; content: string };
  assert.equal(message.role, "user");
  assert.ok(message.content.startsWith(`Task ${task.taskId} landed independently`), message.content);
  assert.match(message.content, /All requested task outputs have landed/);

  // Inspect stays canonical after the delivery.
  const inspected = await endpoint.callTool({ name: "SubtasksInspect", arguments: { taskId: task.taskId }, signal: request().signal });
  assert.equal(inspected?.isError, false, text(inspected));
  assert.match(text(inspected), /landed/);
});

test("end to end: a failed send leaves the landed outcome landed and is never retried or redirected", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch, true);
  const harness = realHarness(scratch);
  const inboxA = await listenInbox(scratch, "a");
  const inboxB = await listenInbox(scratch, "b");
  const rowA = await harness.createClaude();
  const rowB = await harness.createClaude();
  await harness.bindInbox(rowA, SESSION_A, inboxA);
  await harness.bindInbox(rowB, SESSION_B, inboxB);

  const started = await harness.endpoints.get(rowA)!.callTool({
    name: "SubtasksStart", arguments: { tasks: [queuedTask("unreachable inbox")] }, signal: request().signal,
  });
  assert.equal(started?.isError, false, text(started));
  // The endpoint disappears while the task runs: the sender stays bound, the send fails.
  await inboxA.close();
  if (existsSync(inboxA.path) && lstatSync(inboxA.path).isSocket()) unlinkSync(inboxA.path);
  writeFileSync(scratch.release, "go\n");

  const controller = (harness.owners.managers[0] as unknown as { controller: { groups: Map<string, { tasks: Array<{ state: string }> }> } }).controller;
  const task = [...controller.groups.values()][0]!.tasks[0]!;
  await waitFor(() => task.state === "landed");
  await settle(300);
  assert.equal(task.state, "landed", "a failed send never changes the worker outcome");
  assert.equal(harness.sinkCalls.length, 1, "one attempt, never retried");
  assert.equal(harness.sinkCalls[0]!.kind, "completion");
  assert.match(harness.sinkCalls[0]!.outcome ?? "", /refused the send \(endpoint_unavailable\); nothing was sent/);
  assert.equal(inboxA.opened(), 0);
  assert.equal(inboxB.opened(), 0, "no other row's inbox is used as a fallback");
});

test("end to end: a revoked run sends nothing, even to a successor sender on the same row", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch, true);
  const harness = realHarness(scratch);
  const inboxA = await listenInbox(scratch, "a");
  const successor = await listenInbox(scratch, "s");
  const rowA = await harness.createClaude();
  await harness.bindInbox(rowA, SESSION_A, inboxA);
  const started = await harness.endpoints.get(rowA)!.callTool({
    name: "SubtasksStart", arguments: { tasks: [queuedTask("revoked run")] }, signal: request().signal,
  });
  assert.equal(started?.isError, false, text(started));
  const sink = harness.owners.created[0]!.nativeEventSink!;
  const manager = harness.owners.managers[0]!;
  const controller = (manager as unknown as { controller: { groups: Map<string, { tasks: Array<{ taskId: string; state: string }> }> } }).controller;
  const task = [...controller.groups.values()][0]!.tasks[0]!;

  // The conversation changes: the lane (and its run) is revoked; the row then
  // proves a successor conversation with its own live inbox sender.
  harness.revokeConversation(rowA, SESSION_B);
  await harness.bindInbox(rowA, SESSION_B, successor);
  writeFileSync(scratch.release, "go\n");
  await settle(300);
  assert.notEqual(task.state, "landed", "the revoked run's custody handed its work off canonically");
  assert.ok(harness.sinkCalls.every((call) => call.outcome !== "sent_unconfirmed"), JSON.stringify(harness.sinkCalls));

  // A canonical event the old owner still emits is refused before any send.
  const event: ManagedNativeEvent = Object.freeze({
    customType: "pi-review-subtask-event", kind: "completion", executionId: "exec", taskId: task.taskId, state: "landed",
    content: "late completion", diagnostic: undefined, delivery: { deliverAs: "steer" as const, triggerTurn: true },
  });
  await assert.rejects(Promise.resolve(sink(event)), /no longer current; nothing was sent/);
  assert.equal(inboxA.opened(), 0, "the revoked run's own inbox gets nothing");
  assert.equal(successor.opened(), 0, "the successor's sender on the same row is never targeted");
});

/* ------------------------------------------------------------------------- *
 * The inbox opt-in is scoped to the run's own managed MCP lane               *
 * ------------------------------------------------------------------------- */

test("a Claude run without a kept managed MCP lane asks for nothing or binds nothing", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  await initGitRepo(scratch.workspace);
  writeLandingSettings(scratch, true);
  const harness = realHarness(scratch);
  const inbox = await listenInbox(scratch, "u");

  // Hooks armed but MCP registration failed: no receipt is requested (so the
  // real provider runs no probe), and the inbox slot never binds.
  harness.setMcp("unregistered");
  const unregistered = await harness.createClaude();
  assert.deepEqual(harness.providerCalls.at(-1), { compatibility: false, requiresMcp: false, mcp: false });
  assert.equal(harness.endpoints.has(unregistered), false);
  assert.equal(await harness.refusedBind(unregistered, SESSION_A, inbox), 0, "no bind attempt starts");

  // Hooks prepared, MCP registered but its preparation unavailable: the request
  // carries the MCP scope (the real provider declines without probing); even a
  // provider that answers "verified" anyway keeps no inbox for that run.
  harness.setMcp("unavailable");
  const unavailable = await harness.createClaude();
  assert.deepEqual(harness.providerCalls.at(-1), { compatibility: true, requiresMcp: true, mcp: true });
  assert.equal(await harness.refusedBind(unavailable, SESSION_B, inbox), 0, "no bind attempt starts");

  // A prepared lane on the same host still binds its own inbox.
  harness.setMcp("prepared");
  const managed = await harness.createClaude();
  const sender = await harness.bindInbox(managed, SESSION_A, inbox);
  assert.equal(sender.conversationId, SESSION_A);
  assert.equal(inbox.opened(), 0, "binding sends nothing");
});

test("the lane-scoped opt-in is refused when half wired; the standalone opt-in is unchanged", () => {
  const base = {
    packageRoot: "/synthetic",
    piExecutable: "/synthetic/pi",
    statusRegistrar: { register() { throw new Error("unused"); } },
    nativeHookRegistrar: { registerNativeHookSource() { throw new Error("unused"); } },
    nativeStatusObserverFactory: () => ({ acceptHook() {}, acceptFailure() {}, dispose() {} }),
  };
  assert.throws(() => new InstanceManager({ ...base, nativeClaudeInbox: true, nativeClaudeInboxRequiresMcpLane: true }),
    /requires nativeClaudeInbox and nativeMcpLane/);
  assert.throws(() => new InstanceManager({ ...base, nativeClaudeInboxRequiresMcpLane: "yes" as unknown as boolean }),
    /must be a boolean or absent/);
  assert.doesNotThrow(() => new InstanceManager({ ...base, nativeClaudeInbox: true }));
});

/* ------------------------------------------------------------------------- *
 * Test cleanup on a partial setup                                            *
 * ------------------------------------------------------------------------- */

test("a failed second inbox listen still closes the first server and removes both roots", linuxOnly, async (t) => {
  let first: Inbox | undefined;
  let roots: string[] = [];
  await t.test("partial setup", async (sub) => {
    const scratch = ownedScratch(sub);
    roots = [scratch.root, scratch.sockets];
    first = await listenInbox(scratch, "a");
    assert.equal(first.listening(), true);
    // The same path again: the second listen rejects mid-setup.
    await assert.rejects(listenInbox(scratch, "b", first.path), /EADDRINUSE/);
  });
  assert.ok(first);
  assert.equal(first.listening(), false, "the first server was closed by the deferred cleanup");
  assert.equal(roots.length, 2);
  assert.equal(roots.some((dir) => existsSync(dir)), false, "both roots are removed");
});

/* ------------------------------------------------------------------------- *
 * Lane-level sink refusals                                                   *
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

function laneBroker() {
  return {
    register() { throw new Error("unused"); },
    registerNativeHookSource() { throw new Error("unused"); },
    registerNativeMcpSource() { throw new Error("unused"); },
    async dispose() {},
  };
}

/** A real branded sender for `inbox`, current until `revoke`. */
function senderFor(inbox: Inbox, conversationId: string): { sender: NativeClaudeInboxSender; revoke(): void } {
  let current = true;
  const isCurrent = () => current;
  const minted = createClaudeInboxSendCapability({
    launchId: `launch-${randomUUID()}`,
    sessionId: conversationId,
    socketPath: inbox.path,
    endpoint: (() => {
      const stat = lstatSync(inbox.path, { bigint: true });
      return { dev: stat.dev, ino: stat.ino, uid: Number(stat.uid) };
    })(),
    hookToken: inbox.token,
    claudeVersion: SUPPORTED_CLAUDE,
    isCurrent,
  });
  assert.ok(minted.ok);
  return { sender: Object.freeze({ conversationId, capability: minted.capability, isCurrent }), revoke: () => { current = false; } };
}

const EVENT: ManagedNativeEvent = Object.freeze({
  customType: "pi-review-subtask-event", kind: "completion", executionId: "exec-1", taskId: "task-1", state: "landed",
  content: "Task task-1 landed independently.", diagnostic: undefined, delivery: { deliverAs: "steer" as const, triggerTurn: true },
});

test("the lane gives only Claude holds with the host accessor a sink, keyed by the runtime row", linuxOnly, async (t) => {
  const scratch = ownedScratch(t);
  writeLandingSettings(scratch, true);
  await initGitRepo(scratch.workspace);
  const inbox = await listenInbox(scratch, "l");
  const created: NativeManagedConversationOwnerOptions[] = [];
  const lookups: string[] = [];
  const senders = new Map<string, NativeClaudeInboxSender>();
  let slotOfRowA: string | undefined = "slot-a";
  const input = (overrides: Partial<NativeManagedHostLaneInput>): NativeManagedHostLaneInput => ({
    platform: "linux",
    broker: laneBroker(),
    ownedAgentDir: scratch.agentDir,
    resolveSlotId: (rowId) => (rowId === "row-a" ? slotOfRowA : rowId === "row-after-restart" ? "slot-a" : rowId === "row-c" ? "slot-c" : undefined),
    settings: { env: {}, agentDir: scratch.agentDir },
    pi: { executable: PI_FILE, version: "9.9.9", launchArgs: ["--offline"] },
    testHooks: { ceiling: CEILING, createOwner: (options) => { created.push(options); return createNativeManagedConversationOwner(options); } },
    ...overrides,
  });
  const armed = createNativeManagedHostLane(input({
    claudeInbox: { senderFor: (rowId) => { lookups.push(rowId); return senders.get(rowId); } },
  }));
  assert.equal(armed.status, "armed");
  if (armed.status !== "armed") return;
  const drainArmed = armed.host.drain;
  scratch.defer(() => drainArmed());
  const { delegate } = armed.host.lane;
  const claude = { rowId: "row-a", backend: "claude" as const, workspace: scratch.workspace, conversationId: SESSION_A };

  // A Codex hold never gets a sink, whatever the accessor.
  await delegate.listTools(laneContext({ ...claude, rowId: "row-c", backend: "codex" }, makeRun().run));
  assert.equal(created.length, 1);
  assert.equal(created[0]!.nativeEventSink, undefined, "Codex stays unchanged");

  // The Claude hold's sink delivers through the runtime row's own sender.
  const first = makeRun();
  await delegate.listTools(laneContext(claude, first.run));
  const sink = created[1]!.nativeEventSink;
  assert.equal(typeof sink, "function");
  assert.equal(created[1]!.identity.rowId, "slot-a");

  // No sender yet: refused, nothing sent.
  await assert.rejects(Promise.resolve(sink!(EVENT)), /no current inbox sender/);
  // A sender bound to another conversation on the same row is never used.
  senders.set("row-a", senderFor(inbox, SESSION_B).sender);
  await assert.rejects(Promise.resolve(sink!(EVENT)), /no current inbox sender/);
  // A revoked sender is never used.
  const revocable = senderFor(inbox, SESSION_A);
  senders.set("row-a", revocable.sender);
  revocable.revoke();
  await assert.rejects(Promise.resolve(sink!(EVENT)), /no current inbox sender/);
  assert.equal(inbox.opened(), 0);
  assert.deepEqual([...new Set(lookups)], ["row-a"], "the target is located by the trusted runtime row, never the slot");

  // The exact current sender: one attempt, never a delivery claim.
  senders.set("row-a", senderFor(inbox, SESSION_A).sender);
  await sink!(EVENT);
  await waitFor(() => inbox.connections.length === 1, 4000);
  assert.equal(inbox.connections[0]![1]!.session_id, SESSION_A);

  // The runtime row losing its slot binding refuses before any lookup.
  slotOfRowA = undefined;
  const before = lookups.length;
  await assert.rejects(Promise.resolve(sink!(EVENT)), /no longer current/);
  assert.equal(lookups.length, before);
  slotOfRowA = "slot-a";

  // Replacement: the old run is revoked; the successor row gets its own sink and
  // the old sink never drifts onto the successor's sender.
  first.revoke();
  senders.set("row-after-restart", senderFor(inbox, SESSION_A).sender);
  await assert.rejects(Promise.resolve(sink!(EVENT)), /no longer current/);
  const second = makeRun();
  await delegate.listTools(laneContext({ ...claude, rowId: "row-after-restart" }, second.run));
  const successorSink = created.at(-1)!.nativeEventSink;
  assert.ok(successorSink && successorSink !== sink);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inbox.opened(), 1, "nothing more was sent by the revoked run");

  // Without (or with an invalid) accessor, a Claude hold gets no sink.
  for (const claudeInbox of [undefined, { senderFor: "nope" }, null]) {
    const other = createNativeManagedHostLane(input({ claudeInbox: claudeInbox as never }));
    assert.equal(other.status, "armed");
    if (other.status !== "armed") continue;
    const drainOther = other.host.drain;
    scratch.defer(() => drainOther());
    const count: number = created.length;
    await other.host.lane.delegate.listTools(laneContext({ ...claude, rowId: "row-c", conversationId: SESSION_B }, makeRun().run));
    assert.equal(created.length, count + 1);
    assert.equal(created.at(-1)!.nativeEventSink, undefined);
  }
});
