/**
 * Focused native hook lane tests for the existing local status broker.
 *
 * These exercise real local sockets against the broker and the exported relay
 * runner, plus one genuine compiled child entrypoint. They cover authenticated
 * one-shot delivery, concurrent hooks beside an active Pi reporter, rejection
 * of wrong/stale/cross-family/backend tokens, closed provider-input selection,
 * callback containment, release/dispose invalidation, and the shared
 * capability sanitizer. No provider CLI, configuration, auth, model, or
 * permission state is used or changed.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Readable } from "node:stream";
import test, { afterEach } from "node:test";

import {
  __test as brokerTest,
  createStatusBroker,
  type NativeHookRegistration,
  type NativeHookSourceHandlers,
  type NativeHookStatusBroker,
  type StatusBrokerStatusHandlers,
} from "../src/session-host/broker";
import {
  MAX_NATIVE_HOOK_BACKGROUND_TASKS,
  MAX_NATIVE_HOOK_STDIN_BYTES,
  NATIVE_HOOK_BOOTSTRAP_ENV,
  decodeNativeHookAck,
  decodeNativeHookFrame,
  encodeNativeHookBootstrapEnv,
  encodeNativeHookFrame,
  parseNativeHookBootstrap,
  parseNativeHookBootstrapEnv,
  sanitizeNativeHookProviderInput,
  type NativeHookAckFrame,
  type NativeHookBootstrap,
  type NativeHookEvent,
  type NativeHookEventFrame,
  type NativeHookFailure,
  type NativeHookFailureFrame,
  type NativeHookFailureReason,
} from "../src/session-host/native-hook-protocol";
import { runNativeHookRelay } from "../src/session-host/native-hook-relay";
import {
  NODE_OPTIONS_RESTORE_ENV,
  RUNTIME_ROLE_ENV,
  SESSION_HOST_BOOTSTRAP_ENV,
  rejectAndStripInheritedHostCapabilities,
  snapshotNativeEnvironment,
} from "../src/session-host/launch";
import {
  encodeFrame,
  type SessionHostBootstrap,
  type SessionHostStatus,
} from "../src/session-host/protocol";

const INSTANCE_PI = "11111111-1111-4111-8111-111111111111";
const INSTANCE_NATIVE = "22222222-2222-4222-8222-222222222222";
const INSTANCE_RELEASED = "33333333-3333-4333-8333-333333333333";
const INSTANCE_NATIVE_OTHER = "55555555-5555-4555-8555-555555555555";

const WINDOWS_PIPE_ADDRESS = /^\\\\\.\\pipe\\prg-st-[0-9a-f]{32}$/;

// The worker root is longer than macOS's sun_path. Keep every real socket inode
// under this root and express only the bind/connect address relatively.
function rootRelativeSocketAddress(address: string): string {
  if (WINDOWS_PIPE_ADDRESS.test(address)) return address;
  const relative = path.relative(process.cwd(), address);
  if (path.isAbsolute(address) && relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && Buffer.byteLength(address, "utf8") > 100) return `./${relative}`;
  return address;
}

function rootRelativeSocketArgument(value: unknown): unknown {
  if (typeof value === "string") return rootRelativeSocketAddress(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const options = value as Record<string, unknown>;
    if (typeof options.path === "string") return { ...options, path: rootRelativeSocketAddress(options.path) };
  }
  return value;
}

function rootRelativeSocketConnectArgument(value: unknown): unknown {
  if (Array.isArray(value) && value.length > 0) {
    value[0] = rootRelativeSocketArgument(value[0]);
    return value;
  }
  if (typeof value === "string") return { path: rootRelativeSocketAddress(value) };
  return rootRelativeSocketArgument(value);
}

const originalServerListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]): net.Server {
  args[0] = rootRelativeSocketArgument(args[0]);
  return Reflect.apply(originalServerListen, this, args) as net.Server;
} as typeof net.Server.prototype.listen;

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  args[0] = rootRelativeSocketConnectArgument(args[0]);
  return Reflect.apply(originalSocketConnect, this, args) as net.Socket;
} as typeof net.Socket.prototype.connect;

const brokers = new Set<NativeHookStatusBroker>();
const socketRoots = new Set<string>();
const preloadDirectories = new Set<string>();
const sockets = new Set<net.Socket>();

function trackSocket(socket: net.Socket): net.Socket {
  sockets.add(socket);
  // The explicit wait helpers classify expected remote closes; this listener
  // only prevents an unhandled error from an intentionally rejected probe.
  socket.on("error", () => undefined);
  return socket;
}

function makeSocketRoot(): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".prg-hk-"));
  socketRoots.add(root);
  return root;
}

async function makeBroker(): Promise<NativeHookStatusBroker> {
  brokerTest.setSocketPathLimitForTests(4096);
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  brokers.add(broker);
  return broker;
}

afterEach(async () => {
  brokerTest.setNativeHookDeliveryLimitForTests(undefined);
  brokerTest.setSocketPathLimitForTests(undefined);
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const broker of brokers) {
    try {
      await broker.dispose();
    } catch {
      // Cleanup never masks a test assertion; the broker is idempotent.
    }
  }
  brokers.clear();
  for (const root of socketRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort test cleanup only.
    }
  }
  socketRoots.clear();
  for (const directory of preloadDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort test cleanup only.
    }
  }
  preloadDirectories.clear();
});

interface NativeRecorded {
  events: NativeHookEvent[];
  failures: NativeHookFailure[];
  handlers: NativeHookSourceHandlers;
  throwNextEvent: boolean;
  onEventExtra: (() => void) | undefined;
}

function recordingNative(): NativeRecorded {
  const recorded: NativeRecorded = {
    events: [],
    failures: [],
    handlers: { onEvent: () => undefined, onFailure: () => undefined },
    throwNextEvent: false,
    onEventExtra: undefined,
  };
  recorded.handlers.onEvent = (event) => {
    recorded.events.push(event);
    recorded.onEventExtra?.();
    if (recorded.throwNextEvent) {
      recorded.throwNextEvent = false;
      throw new Error("native event callback intentionally threw");
    }
  };
  recorded.handlers.onFailure = (failure) => {
    recorded.failures.push(failure);
  };
  return recorded;
}

interface PiRecorded {
  statuses: SessionHostStatus[];
  disconnects: number;
  reconnects: number;
  handlers: StatusBrokerStatusHandlers;
}

function recordingPi(): PiRecorded {
  const recorded: PiRecorded = {
    statuses: [],
    disconnects: 0,
    reconnects: 0,
    handlers: { onStatus: () => undefined, onDisconnect: () => undefined },
  };
  recorded.handlers.onStatus = (status) => recorded.statuses.push(status);
  recorded.handlers.onDisconnect = () => { recorded.disconnects += 1; };
  recorded.handlers.onReconnect = () => { recorded.reconnects += 1; };
  return recorded;
}

function piHello(bootstrap: SessionHostBootstrap, token = bootstrap.token) {
  return {
    version: 1 as const,
    type: "hello" as const,
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    token,
  };
}

function piStatus(bootstrap: SessionHostBootstrap, sequence: number): SessionHostStatus {
  return {
    version: 1,
    type: "status",
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    sequence,
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
  };
}

function nativeEventFrame(
  bootstrap: NativeHookBootstrap,
  metadata: Omit<NativeHookEventFrame, "version" | "type" | "instanceId" | "generation" | "backend" | "token">,
  overrides: Partial<Pick<NativeHookEventFrame, "instanceId" | "generation" | "backend" | "token">> = {},
): NativeHookEventFrame {
  return {
    version: 1,
    type: "native_hook_event",
    instanceId: overrides.instanceId ?? bootstrap.instanceId,
    generation: overrides.generation ?? bootstrap.generation,
    backend: overrides.backend ?? bootstrap.backend,
    token: overrides.token ?? bootstrap.token,
    ...metadata,
  };
}

function nativeFailureFrame(
  bootstrap: NativeHookBootstrap,
  reason: NativeHookFailureReason,
  overrides: Partial<Pick<NativeHookFailureFrame, "instanceId" | "generation" | "backend" | "token">> = {},
): NativeHookFailureFrame {
  return {
    version: 1,
    type: "native_hook_failure",
    instanceId: overrides.instanceId ?? bootstrap.instanceId,
    generation: overrides.generation ?? bootstrap.generation,
    backend: overrides.backend ?? bootstrap.backend,
    token: overrides.token ?? bootstrap.token,
    reason,
  };
}

async function connect(address: string, options: { allowHalfOpen?: boolean } = {}): Promise<net.Socket> {
  const socket = trackSocket(net.connect({
    path: address,
    allowHalfOpen: options.allowHalfOpen === true,
  }));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("test helper: socket connection timed out")), 3000);
    timer.unref?.();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onConnect = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error("test helper: socket closed before connecting"));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
  return socket;
}

async function connectPi(bootstrap: SessionHostBootstrap, token?: string): Promise<net.Socket> {
  const socket = await connect(bootstrap.socketPath);
  socket.write(encodeFrame(piHello(bootstrap, token)));
  return socket;
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`test helper: ${label} exceeded its deadline`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForClose(socket: net.Socket, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => finish(new Error(`test helper: ${label} did not close`)), timeoutMs);
    timer.unref?.();
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = (): void => finish();
    socket.once("close", onClose);
  });
}

interface RawNativeResult {
  ack: NativeHookAckFrame | undefined;
  raw: string;
}

async function sendRawNative(
  socketPath: string,
  frame: NativeHookEventFrame | NativeHookFailureFrame,
): Promise<RawNativeResult> {
  const socket = await connect(socketPath);
  return new Promise<RawNativeResult>((resolve) => {
    let settled = false;
    let raw = "";
    const timer = setTimeout(() => finish(undefined), 4000);
    timer.unref?.();
    const finish = (ack: NativeHookAckFrame | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      socket.destroy();
      resolve({ ack, raw });
    };
    const onData = (chunk: Buffer): void => {
      raw += chunk.toString("utf8");
      const newline = raw.indexOf("\n");
      if (newline !== -1) finish(decodeNativeHookAck(raw.slice(0, newline)));
    };
    const onClose = (): void => finish(undefined);
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.write(encodeNativeHookFrame(frame));
    if (socket.destroyed) finish(undefined);
  });
}

function relayInput(value: unknown): Readable {
  return Readable.from([Buffer.from(JSON.stringify(value), "utf8")]);
}

function runRelay(bootstrap: NativeHookBootstrap, value: unknown) {
  return runNativeHookRelay({
    env: { [NATIVE_HOOK_BOOTSTRAP_ENV]: JSON.stringify(bootstrap) },
    stdin: relayInput(value),
  });
}

function runRelayWithStdin(bootstrap: NativeHookBootstrap, stdin: NodeJS.ReadableStream) {
  return runNativeHookRelay({
    env: { [NATIVE_HOOK_BOOTSTRAP_ENV]: JSON.stringify(bootstrap) },
    stdin,
  });
}

interface NativeLaneCounts {
  refused: number;
  deliveries: number;
  activeConnections: number;
}

function nativeLaneCounts(broker: NativeHookStatusBroker): NativeLaneCounts {
  return (broker as unknown as { __nativeHookLaneCountsForTests(): NativeLaneCounts })
    .__nativeHookLaneCountsForTests();
}

/** Holds `count` authenticated one-shot deliveries open from this client side. */
async function holdNativeDeliveries(
  broker: NativeHookStatusBroker,
  bootstrap: NativeHookBootstrap,
  count: number,
): Promise<net.Socket[]> {
  const holders: net.Socket[] = [];
  for (let index = 0; index < count; index += 1) {
    const holder = await connect(broker.socketPath, { allowHalfOpen: true });
    holder.resume();
    holder.write(encodeNativeHookFrame(nativeEventFrame(bootstrap, {
      hook_event_name: "PreToolUse",
      tool_use_id: `held-${index}`,
    })));
    holders.push(holder);
  }
  await waitFor(
    () => nativeLaneCounts(broker).deliveries === count,
    "authenticated native delivery slots saturated",
  );
  return holders;
}

test("native protocol admits only closed metadata, rejects extra fields and controls, and keeps bootstrap shape strict", () => {
  const bootstrap: NativeHookBootstrap = {
    version: 1,
    socketPath: "/tmp/broker.sock",
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    instanceId: INSTANCE_NATIVE,
    backend: "claude",
    token: "a".repeat(64),
  };
  assert.deepEqual(parseNativeHookBootstrap(bootstrap), bootstrap);
  assert.deepEqual(parseNativeHookBootstrapEnv(encodeNativeHookBootstrapEnv(bootstrap)), bootstrap);
  assert.equal(parseNativeHookBootstrap({ ...bootstrap, token: "short" }), undefined);
  assert.equal(parseNativeHookBootstrap({ ...bootstrap, backend: "pi" }), undefined);
  assert.equal(parseNativeHookBootstrap({ ...bootstrap, extra: true }), undefined);
  assert.equal(parseNativeHookBootstrapEnv("{not-json"), undefined);

  const event = nativeEventFrame(bootstrap, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    tool_name: "Bash",
    tool_use_id: "toolu-1",
  });
  const decoded = decodeNativeHookFrame(encodeNativeHookFrame(event));
  assert.equal(decoded?.kind, "event");
  assert.deepEqual(decoded?.kind === "event" ? decoded.event : undefined, {
    backend: "claude",
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    tool_name: "Bash",
    tool_use_id: "toolu-1",
  });
  // The strict wire family refuses arbitrary provider payload fields even when
  // the frame otherwise authenticates.
  assert.equal(decodeNativeHookFrame(`${JSON.stringify({ ...event, prompt: "secret" })}\n`), undefined);
  assert.equal(decodeNativeHookFrame(`${JSON.stringify({ ...event, tool_input: { command: "secret" } })}\n`), undefined);
  assert.equal(decodeNativeHookFrame(`${JSON.stringify({ ...event, session_id: "bad\u0001id" })}\n`), undefined);
  assert.equal(decodeNativeHookFrame(`${JSON.stringify({ ...event, hook_event_name: "TaskCreated" })}\n`), undefined);

  const failure = decodeNativeHookFrame(encodeNativeHookFrame(nativeFailureFrame(bootstrap, "input-malformed")));
  assert.deepEqual(failure, {
    kind: "failure",
    frame: nativeFailureFrame(bootstrap, "input-malformed"),
    failure: { backend: "claude", reason: "input-malformed" },
  });
  assert.equal(decodeNativeHookFrame(encodeNativeHookFrame({ ...nativeFailureFrame(bootstrap, "input-malformed"), reason: "made-up" as never })), undefined);
});

test("provider input selection drops all sensitive and arbitrary fields before the wire", () => {
  const selected = sanitizeNativeHookProviderInput({
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    tool_name: "Bash",
    tool_use_id: "toolu-1",
    prompt: "SECRET PROMPT",
    answer: "SECRET ANSWER",
    tool_input: { command: "SECRET COMMAND" },
    tool_response: { stdout: "SECRET RESULT" },
    transcript: [{ role: "user", content: "SECRET TRANSCRIPT" }],
    cwd: "/tmp",
    permission_mode: "default",
  });
  assert.deepEqual(selected, {
    ok: true,
    metadata: {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      transcript_path: "/tmp/transcript.jsonl",
      tool_name: "Bash",
      tool_use_id: "toolu-1",
    },
  });
  assert.equal(sanitizeNativeHookProviderInput({ hook_event_name: "Stop", session_id: "x".repeat(257) }).ok, false);
  assert.equal(sanitizeNativeHookProviderInput({ hook_event_name: "Stop", session_id: "bad\u0001id" }).ok, false);
  assert.equal(sanitizeNativeHookProviderInput({ hook_event_name: "Stop", transcript_path: "relative.jsonl" }).ok, false);
  assert.deepEqual(sanitizeNativeHookProviderInput({ hook_event_name: "UnknownHook" }), {
    ok: false,
    reason: "unsupported-hook",
  });
  assert.deepEqual(sanitizeNativeHookProviderInput(null), { ok: false, reason: "input-invalid" });
});

test("Stop-family background snapshot projection is whole-array validated and count-only", () => {
  const entries = [
    { status: "running", backgrounded: true, type: "shell", description: "SECRET DESCRIPTION", command: "SECRET COMMAND", id: "secret-id" },
    { status: "pending", backgrounded: true, type: "local_agent", description: "SECRET DESCRIPTION" },
    { status: "running", backgrounded: true, type: "bash", session_crons: ["SECRET CRON"] },
    { status: "completed", backgrounded: true, type: "shell", output: "SECRET OUTPUT" },
    { status: "running", backgrounded: false, type: "shell", command: "SECRET FOREGROUND" },
  ];
  const selected = sanitizeNativeHookProviderInput({ hook_event_name: "Stop", background_tasks: entries });
  assert.equal(selected.ok, true);
  if (!selected.ok) assert.fail("the Stop background snapshot should be admitted");
  assert.deepEqual(selected.metadata, {
    hook_event_name: "Stop",
    background_counts: { tasks: 2, shells: 1 },
  });
  assert.ok(!JSON.stringify(selected).includes("SECRET"), "no raw snapshot field reaches the selected metadata");

  assert.deepEqual(sanitizeNativeHookProviderInput({ hook_event_name: "Stop" }), {
    ok: true,
    metadata: { hook_event_name: "Stop" },
  });
  assert.deepEqual(sanitizeNativeHookProviderInput({ hook_event_name: "Stop", background_tasks: [] }), {
    ok: true,
    metadata: { hook_event_name: "Stop", background_counts: { tasks: 0, shells: 0 } },
  });
  // The snapshot is established only for Stop/SubagentStop; another hook's
  // arbitrary background_tasks field is not reinterpreted as native counts.
  assert.deepEqual(sanitizeNativeHookProviderInput({ hook_event_name: "PreToolUse", background_tasks: entries }), {
    ok: true,
    metadata: { hook_event_name: "PreToolUse" },
  });

  const invalidSnapshots: unknown[] = [
    null,
    [{ status: "running", backgrounded: true }],
    [{ status: "running", backgrounded: "yes", type: "shell" }],
    [{ status: "", backgrounded: true, type: "shell" }],
    [{ status: "running", backgrounded: true, type: "x".repeat(129) }],
    Array.from({ length: MAX_NATIVE_HOOK_BACKGROUND_TASKS + 1 }, () => ({
      status: "completed",
      backgrounded: false,
      type: "shell",
    })),
  ];
  for (const snapshot of invalidSnapshots) {
    const result = sanitizeNativeHookProviderInput({ hook_event_name: "Stop", background_tasks: snapshot });
    assert.equal(result.ok, false, "malformed/oversized snapshots are explicit failures, never partial counts");
    if (result.ok) assert.fail("expected an explicit background snapshot failure");
    assert.ok(
      result.reason === "input-invalid" || result.reason === "input-too-large",
      "the failure is a closed source reason, not a zero-count event",
    );
  }

  const bootstrap: NativeHookBootstrap = {
    version: 1,
    socketPath: "/tmp/broker.sock",
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    instanceId: INSTANCE_NATIVE,
    backend: "claude",
    token: "a".repeat(64),
  };
  const event = nativeEventFrame(bootstrap, {
    hook_event_name: "Stop",
    background_counts: { tasks: 2, shells: 1 },
  });
  const decoded = decodeNativeHookFrame(encodeNativeHookFrame(event));
  assert.deepEqual(decoded?.kind === "event" ? decoded.event : undefined, {
    backend: "claude",
    hook_event_name: "Stop",
    background_counts: { tasks: 2, shells: 1 },
  });
  assert.equal(
    decodeNativeHookFrame(encodeNativeHookFrame({ ...event, hook_event_name: "PreToolUse" })),
    undefined,
    "background counts are not admitted on a non-Stop-family hook",
  );
  assert.equal(
    decodeNativeHookFrame(encodeNativeHookFrame({ ...event, background_counts: { tasks: -1, shells: 0 } as never })),
    undefined,
  );
  assert.equal(
    decodeNativeHookFrame(`${JSON.stringify({ ...event, background_counts: { tasks: 1, shells: 1, extra: true } })}\n`),
    undefined,
  );
});

test("authenticated native event is accepted once with closed metadata and no sensitive text", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);
  assert.equal(registration.bootstrap.socketPath, broker.socketPath);
  assert.equal(registration.bootstrap.backend, "claude");
  assert.equal(parseNativeHookBootstrap(registration.bootstrap)?.instanceId, INSTANCE_NATIVE);

  const transcriptPath = path.join(process.cwd(), "transcript.jsonl");
  const outcome = await runRelay(registration.bootstrap, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: "toolu-1",
    prompt: "SECRET PROMPT",
    tool_input: { command: "SECRET COMMAND" },
    tool_response: "SECRET RESULT",
    transcript: [{ text: "SECRET TRANSCRIPT" }],
  });
  assert.equal(outcome.status, "accepted");
  assert.equal(outcome.delivered, "event");
  assert.deepEqual(recorded.events, [{
    backend: "claude",
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: "toolu-1",
  }]);
  assert.deepEqual(recorded.failures, []);
  const serialized = JSON.stringify(recorded.events);
  assert.ok(!serialized.includes("SECRET"), "no sensitive provider field reaches the callback");
  assert.ok(!serialized.includes(registration.bootstrap.token), "the token never reaches the callback");
});

test("relay projects validated Stop/SubagentStop background counts and keeps absent distinct from zero", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);

  const snapshot = [
    { status: "running", backgrounded: true, type: "shell", command: "SECRET COMMAND" },
    { status: "pending", backgrounded: true, type: "local_agent", description: "SECRET DESCRIPTION" },
    { status: "running", backgrounded: true, type: "bash", tool_input: "SECRET TOOL INPUT" },
    { status: "completed", backgrounded: true, type: "shell", output: "SECRET OUTPUT" },
  ];
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "Stop",
    session_id: "session-stop",
    background_tasks: snapshot,
  })).status, "accepted");
  assert.equal((await runRelay(registration.bootstrap, { hook_event_name: "Stop" })).status, "accepted");
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "Stop",
    background_tasks: [],
  })).status, "accepted");
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "SubagentStop",
    agent_id: "agent-child-1",
    agent_type: "worker",
    background_tasks: [
      { status: "running", backgrounded: true, type: "local_agent" },
      { status: "running", backgrounded: true, type: "shell" },
    ],
  })).status, "accepted");

  assert.deepEqual(recorded.events, [
    {
      backend: "claude",
      hook_event_name: "Stop",
      session_id: "session-stop",
      background_counts: { tasks: 2, shells: 1 },
    },
    { backend: "claude", hook_event_name: "Stop" },
    { backend: "claude", hook_event_name: "Stop", background_counts: { tasks: 0, shells: 0 } },
    {
      backend: "claude",
      hook_event_name: "SubagentStop",
      agent_id: "agent-child-1",
      agent_type: "worker",
      background_counts: { tasks: 1, shells: 1 },
    },
  ]);
  assert.deepEqual(recorded.failures, []);
  const serialized = JSON.stringify(recorded.events);
  assert.ok(!serialized.includes("SECRET"), "raw snapshot fields are never projected or echoed");
  assert.ok(!serialized.includes("background_tasks"), "the raw provider array never crosses the wire");
});

test("invalid Stop background snapshots are authenticated closed failures, never fallback 0/0", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);

  const malformed = await runRelay(registration.bootstrap, {
    hook_event_name: "Stop",
    background_tasks: [{ status: "running", backgrounded: true }],
  });
  assert.equal(malformed.status, "accepted");
  assert.equal(malformed.delivered, "failure");
  assert.equal(malformed.failure, "input-invalid");

  const oversized = await runRelay(registration.bootstrap, {
    hook_event_name: "Stop",
    background_tasks: Array.from({ length: MAX_NATIVE_HOOK_BACKGROUND_TASKS + 1 }, () => ({
      status: "completed",
      backgrounded: false,
      type: "shell",
    })),
  });
  assert.equal(oversized.status, "accepted");
  assert.equal(oversized.delivered, "failure");
  assert.equal(oversized.failure, "input-too-large");

  assert.deepEqual(recorded.events, []);
  assert.deepEqual(recorded.failures, [
    { backend: "claude", reason: "input-invalid" },
    { backend: "claude", reason: "input-too-large" },
  ]);
});

test("concurrent native hooks do not supersede each other or evict the active Pi reporter", async () => {
  const broker = await makeBroker();
  const piRecorded = recordingPi();
  const piRegistration = broker.register(INSTANCE_PI, piRecorded.handlers);
  const piSocket = await connectPi(piRegistration.bootstrap);
  piSocket.write(encodeFrame(piStatus(piRegistration.bootstrap, 1)));
  await waitFor(() => piRecorded.statuses.length === 1, "first Pi status");

  const nativeRecorded = recordingNative();
  const nativeRegistration = broker.registerNativeHookSource(INSTANCE_NATIVE, "codex", nativeRecorded.handlers);
  const outcomes = await Promise.all(Array.from({ length: 6 }, (_, index) => runRelay(nativeRegistration.bootstrap, {
    hook_event_name: "PreToolUse",
    session_id: "session-concurrent",
    tool_name: "Bash",
    tool_use_id: `toolu-${index}`,
  })));
  assert.ok(outcomes.every((outcome) => outcome.status === "accepted"), "every concurrent native hook is admitted");
  assert.equal(nativeRecorded.events.length, 6);
  assert.deepEqual(nativeRecorded.failures, []);

  // The Pi reporter was never replaced by native traffic and its sequence
  // fence continues exactly where it left off.
  piSocket.write(encodeFrame(piStatus(piRegistration.bootstrap, 2)));
  await waitFor(() => piRecorded.statuses.length === 2, "second Pi status after native traffic");
  assert.deepEqual(piRecorded.statuses.map((status) => status.sequence), [1, 2]);
  assert.equal(piRecorded.disconnects, 0);
  assert.equal(piRecorded.reconnects, 0);
});

test("wrong, stale, cross-family, and backend-mismatched native frames mutate nothing", async () => {
  const broker = await makeBroker();
  const nativeRecorded = recordingNative();
  const nativeRegistration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", nativeRecorded.handlers);
  const piRecorded = recordingPi();
  const piRegistration = broker.register(INSTANCE_PI, piRecorded.handlers);
  const piSocket = await connectPi(piRegistration.bootstrap);

  const wrongToken = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(nativeRegistration.bootstrap, { hook_event_name: "SessionStart" }, { token: "0".repeat(64) }),
  );
  assert.equal(wrongToken.ack, undefined, "wrong token is closed without an ACK");

  const wrongBackend = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(nativeRegistration.bootstrap, { hook_event_name: "SessionStart" }, { backend: "codex" }),
  );
  assert.equal(wrongBackend.ack, undefined, "backend mismatch is closed without an ACK");

  const crossFamilyToken = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(nativeRegistration.bootstrap, { hook_event_name: "SessionStart" }, { token: piRegistration.bootstrap.token }),
  );
  assert.equal(crossFamilyToken.ack, undefined, "a Pi token cannot authenticate a native frame");

  const crossFamilyHello = await connect(piRegistration.bootstrap.socketPath);
  crossFamilyHello.write(encodeFrame(piHello(piRegistration.bootstrap, nativeRegistration.bootstrap.token)));
  await waitForClose(crossFamilyHello, "cross-family Pi hello");

  nativeRegistration.release();
  const stale = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(nativeRegistration.bootstrap, { hook_event_name: "SessionStart" }),
  );
  assert.equal(stale.ack, undefined, "a released native token is stale and closed without an ACK");

  assert.deepEqual(nativeRecorded.events, []);
  assert.deepEqual(nativeRecorded.failures, []);

  piSocket.write(encodeFrame(piStatus(piRegistration.bootstrap, 1)));
  await waitFor(() => piRecorded.statuses.length === 1, "Pi status after rejected native probes");
  assert.equal(piRecorded.disconnects, 0);
});

test("authenticated provider parse and overflow failures are explicit closed reasons", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);

  const cases: { label: string; stdin: NodeJS.ReadableStream; reason: NativeHookFailureReason }[] = [
    { label: "malformed JSON", stdin: Readable.from([Buffer.from("{not-json", "utf8")]), reason: "input-malformed" },
    { label: "invalid UTF-8", stdin: Readable.from([Buffer.from([0xff, 0xfe])]), reason: "input-not-utf8" },
    {
      label: "oversized document",
      stdin: Readable.from([Buffer.alloc(MAX_NATIVE_HOOK_STDIN_BYTES + 1, 0x20)]),
      reason: "input-too-large",
    },
    {
      label: "control character in allowlisted field",
      stdin: relayInput({ hook_event_name: "Stop", session_id: "bad\u0001id" }),
      reason: "input-invalid",
    },
    { label: "unsupported hook name", stdin: relayInput({ hook_event_name: "TaskCreated" }), reason: "unsupported-hook" },
  ];

  for (const testCase of cases) {
    const outcome = await runRelayWithStdin(registration.bootstrap, testCase.stdin);
    assert.equal(outcome.status, "accepted", `${testCase.label}: authenticated failure was acknowledged`);
    assert.equal(outcome.delivered, "failure", `${testCase.label}: failure frame family`);
    assert.equal(outcome.failure, testCase.reason);
  }
  assert.deepEqual(recorded.events, []);
  assert.deepEqual(recorded.failures.map((failure) => failure.reason), cases.map((testCase) => testCase.reason));
});

test("callback exceptions, release, dispose, and late frames stay contained", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);
  recorded.throwNextEvent = true;
  assert.equal((await runRelay(registration.bootstrap, { hook_event_name: "Stop" })).status, "accepted");
  assert.equal(recorded.events.length, 1);
  assert.equal((await runRelay(registration.bootstrap, { hook_event_name: "Stop" })).status, "accepted");
  assert.equal(recorded.events.length, 2);

  const releasingRecorded = recordingNative();
  let releasingRegistration!: NativeHookRegistration;
  releasingRecorded.onEventExtra = () => releasingRegistration.release();
  releasingRegistration = broker.registerNativeHookSource(INSTANCE_RELEASED, "codex", releasingRecorded.handlers);
  const duringRelease = await runRelay(releasingRegistration.bootstrap, { hook_event_name: "Stop" });
  assert.notEqual(duringRelease.status, "error");
  assert.equal(releasingRecorded.events.length, 1);
  const afterRelease = await runRelay(releasingRegistration.bootstrap, { hook_event_name: "Stop" });
  assert.notEqual(afterRelease.status, "accepted");
  assert.equal(releasingRecorded.events.length, 1);

  // A second frame in the same connection chunk is never a second callback.
  const secondRegistration = broker.registerNativeHookSource(
    "44444444-4444-4444-8444-444444444444",
    "claude",
    recorded.handlers,
  );
  const lateSocket = await connect(broker.socketPath);
  const frame = nativeEventFrame(secondRegistration.bootstrap, { hook_event_name: "PostToolUse", tool_use_id: "late" });
  const before = recorded.events.length;
  lateSocket.write(`${encodeNativeHookFrame(frame)}${encodeNativeHookFrame(frame)}`);
  await waitFor(() => recorded.events.length === before + 1, "first late-chunk frame");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(recorded.events.length, before + 1);

  await broker.dispose();
  assert.equal(recorded.events.length, before + 1);
  assert.equal(recorded.failures.length, 0);
});

test("a coalesced native frame cannot switch its socket into the Pi family", async () => {
  const broker = await makeBroker();
  const piRecorded = recordingPi();
  const piRegistration = broker.register(INSTANCE_PI, piRecorded.handlers);
  const piSocket = await connectPi(piRegistration.bootstrap);
  piSocket.write(encodeFrame(piStatus(piRegistration.bootstrap, 1)));
  await waitFor(() => piRecorded.statuses.length === 1, "initial Pi status before coalesced probe");

  const nativeRecorded = recordingNative();
  const nativeRegistration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", nativeRecorded.handlers);
  const attacker = await connect(broker.socketPath, { allowHalfOpen: true });
  attacker.write(
    `${encodeNativeHookFrame(nativeEventFrame(nativeRegistration.bootstrap, { hook_event_name: "Stop" }))}`
    + encodeFrame(piHello(piRegistration.bootstrap))
    + encodeFrame(piStatus(piRegistration.bootstrap, 99)),
  );
  await waitFor(() => nativeRecorded.events.length === 1, "native event from coalesced chunk");
  await new Promise((resolve) => setTimeout(resolve, 50));

  // The native one-shot frame must stop the whole chunk. The trailing valid Pi
  // hello/status never authenticates, so the original active reporter keeps its
  // socket and sequence fence.
  assert.equal(piRecorded.statuses.length, 1);
  assert.equal(piRecorded.disconnects, 0);
  assert.equal(piRecorded.reconnects, 0);
  piSocket.write(encodeFrame(piStatus(piRegistration.bootstrap, 2)));
  await waitFor(() => piRecorded.statuses.length === 2, "original Pi reporter after coalesced probe");
  assert.deepEqual(piRecorded.statuses.map((status) => status.sequence), [1, 2]);
  attacker.destroy();
});

test("admission-refused native half-open sockets are bounded and destroyed promptly", async () => {
  const broker = await makeBroker();
  const piRecorded = recordingPi();
  const piRegistration = broker.register(INSTANCE_PI, piRecorded.handlers);
  const piSocket = await connectPi(piRegistration.bootstrap);
  piSocket.write(encodeFrame(piStatus(piRegistration.bootstrap, 1)));
  await waitFor(() => piRecorded.statuses.length === 1, "initial Pi status before refusal burst");

  const nativeRecorded = recordingNative();
  const nativeRegistration = broker.registerNativeHookSource(INSTANCE_NATIVE, "codex", nativeRecorded.handlers);
  brokerTest.setNativeHookDeliveryLimitForTests(0);
  const frame = encodeNativeHookFrame(nativeEventFrame(nativeRegistration.bootstrap, { hook_event_name: "Stop" }));
  // Twenty authenticated refusals exceed the dedicated refusal cap. Every
  // client keeps its readable side open and never sends FIN; the broker must
  // still count and destroy them rather than leaving them outside both pools.
  const attackers = await Promise.all(Array.from({ length: 20 }, () => connect(broker.socketPath, { allowHalfOpen: true })));
  const terminated = new Set<net.Socket>();
  for (const attacker of attackers) {
    const finish = (): void => { terminated.add(attacker); };
    attacker.once("end", finish);
    attacker.once("close", finish);
    attacker.once("error", finish);
    // Start reading so remote FIN/RST and any refusal ACK are observed without
    // this client ever sending its own FIN.
    attacker.resume();
    attacker.write(frame);
  }
  // Do not inspect broker-side counts before every probe has actually been
  // processed and terminated remotely; otherwise the zero-initial counts could
  // satisfy the drainage predicate before the broker received anything.
  await waitFor(
    () => terminated.size === attackers.length,
    "all refusal probes processed",
    1000,
  );
  let maxActiveNativeConnections = 0;
  await waitFor(
    () => {
      const counts = nativeLaneCounts(broker);
      maxActiveNativeConnections = Math.max(maxActiveNativeConnections, counts.activeConnections);
      return counts.activeConnections === 0 && counts.refused === 0;
    },
    "refused half-open native sockets destroyed",
    1000,
  );
  assert.ok(
    maxActiveNativeConnections <= 8,
    `refused native sockets stayed within the dedicated bound (observed ${maxActiveNativeConnections})`,
  );
  assert.deepEqual(nativeRecorded.events, []);
  // Every authenticated delivery discarded at admission is one known
  // host-local loss for this exact source, never an accepted event.
  assert.equal(nativeRecorded.failures.length, attackers.length);
  assert.ok(nativeRecorded.failures.every(
    (failure) => failure.backend === "codex" && failure.reason === "delivery-refused",
  ));

  piSocket.write(encodeFrame(piStatus(piRegistration.bootstrap, 2)));
  await waitFor(() => piRecorded.statuses.length === 2, "Pi status after refused native burst");
  assert.deepEqual(piRecorded.statuses.map((status) => status.sequence), [1, 2]);
  assert.equal(piRecorded.disconnects, 0);
});

test("native post-auth admission is separately bounded and leaves Pi reporting untouched", async () => {
  const broker = await makeBroker();
  const piRecorded = recordingPi();
  const piRegistration = broker.register(INSTANCE_PI, piRecorded.handlers);
  const piSocket = await connectPi(piRegistration.bootstrap);
  piSocket.write(encodeFrame(piStatus(piRegistration.bootstrap, 1)));
  await waitFor(() => piRecorded.statuses.length === 1, "initial Pi status");

  const nativeRecorded = recordingNative();
  const nativeRegistration = broker.registerNativeHookSource(INSTANCE_NATIVE, "codex", nativeRecorded.handlers);
  brokerTest.setNativeHookDeliveryLimitForTests(0);
  const rejected = await runRelay(nativeRegistration.bootstrap, { hook_event_name: "Stop" });
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(nativeRecorded.events, []);
  assert.deepEqual(nativeRecorded.failures, [{ backend: "codex", reason: "delivery-refused" }]);

  piSocket.write(encodeFrame(piStatus(piRegistration.bootstrap, 2)));
  await waitFor(() => piRecorded.statuses.length === 2, "Pi status while native admission is closed");
  assert.equal(piRecorded.disconnects, 0);

  brokerTest.setNativeHookDeliveryLimitForTests(undefined);
  assert.equal((await runRelay(nativeRegistration.bootstrap, { hook_event_name: "Stop" })).status, "accepted");
  assert.equal(nativeRecorded.events.length, 1);
  assert.deepEqual(nativeRecorded.failures, [{ backend: "codex", reason: "delivery-refused" }]);
});

test("authenticated matching native admission loss reports one closed host-local failure to that source only", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);
  const otherRecorded = recordingNative();
  broker.registerNativeHookSource(INSTANCE_NATIVE_OTHER, "codex", otherRecorded.handlers);

  // Occupy every per-source authenticated slot with a delivery whose client
  // keeps its write side open, so its one-shot ACK close cannot free the slot.
  const holders = await holdNativeDeliveries(broker, registration.bootstrap, 8);
  const lost = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(registration.bootstrap, { hook_event_name: "UserPromptSubmit", prompt_id: "lost-under-load" }),
  );
  assert.equal(lost.ack?.accepted, false, "the discarded delivery is still acknowledged as rejected");
  // Only the eight held deliveries reached the event callback; the discarded
  // prompt event did not, and the loss was not relabelled as an event or state.
  assert.equal(recorded.events.length, 8);
  assert.deepEqual(recorded.failures, [{ backend: "claude", reason: "delivery-refused" }]);
  assert.deepEqual(otherRecorded.events, []);
  assert.deepEqual(otherRecorded.failures, []);

  for (const holder of holders) holder.destroy();
  await waitFor(
    () => {
      const counts = nativeLaneCounts(broker);
      return counts.deliveries === 0 && counts.refused === 0;
    },
    "held native deliveries drained",
  );
  // Admission recovers normally: the reported loss is not sticky and no retry
  // or replay is fabricated for the discarded event.
  const recovered = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }),
  );
  assert.equal(recovered.ack?.accepted, true);
  assert.equal(recorded.events.length, 9);
  assert.equal(recorded.failures.length, 1);
});

test("wrong, stale, cross-family, and unauthenticated traffic under admission loss cannot reach a valid source", async () => {
  const broker = await makeBroker();
  const valid = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", valid.handlers);
  const piRecorded = recordingPi();
  const piRegistration = broker.register(INSTANCE_PI, piRecorded.handlers);
  const releasedRecorded = recordingNative();
  const releasedRegistration = broker.registerNativeHookSource(INSTANCE_RELEASED, "codex", releasedRecorded.handlers);
  const releasedBootstrap = releasedRegistration.bootstrap;
  releasedRegistration.release();

  const holders = await holdNativeDeliveries(broker, registration.bootstrap, 8);
  const before = nativeLaneCounts(broker);
  const probes: NativeHookEventFrame[] = [
    nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }, { token: "0".repeat(64) }),
    nativeEventFrame(
      registration.bootstrap,
      { hook_event_name: "Stop" },
      { generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ),
    nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }, { backend: "codex" }),
    nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }, { token: piRegistration.bootstrap.token }),
    nativeEventFrame(releasedBootstrap, { hook_event_name: "Stop" }),
    nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }, { instanceId: INSTANCE_NATIVE_OTHER }),
  ];
  for (const probe of probes) {
    assert.equal((await sendRawNative(broker.socketPath, probe)).ack, undefined);
  }
  const malformed = await connect(broker.socketPath);
  const malformedClosed = waitForClose(malformed, "malformed native probe");
  malformed.write("{not-a-native-frame\n");
  await malformedClosed;

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(valid.events.length, 8);
  assert.deepEqual(valid.failures, []);
  assert.deepEqual(releasedRecorded.events, []);
  assert.deepEqual(releasedRecorded.failures, []);
  assert.deepEqual(piRecorded.statuses, []);
  assert.equal(piRecorded.disconnects, 0);
  const afterProbes = nativeLaneCounts(broker);
  assert.equal(afterProbes.deliveries, before.deliveries);
  assert.equal(afterProbes.refused, before.refused);

  // Freeing one held slot shows the same registration still accepts a normal
  // delivery after the rejected probes.
  holders[0].destroy();
  await waitFor(() => nativeLaneCounts(broker).deliveries === 7, "one held native delivery freed");
  const stillValid = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }),
  );
  assert.equal(stillValid.ack?.accepted, true);
  assert.equal(valid.events.length, 9);
  assert.deepEqual(valid.failures, []);

  // Releasing the valid registration under load stays silent: neither the
  // in-flight holders nor a later stale frame produces a late callback.
  registration.release();
  assert.equal(
    (await sendRawNative(
      broker.socketPath,
      nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }),
    )).ack,
    undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(valid.events.length, 9);
  assert.deepEqual(valid.failures, []);
  for (const holder of holders) holder.destroy();
  await waitFor(() => nativeLaneCounts(broker).deliveries === 0, "released native deliveries drained");

  const replacementRecorded = recordingNative();
  const replacement = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", replacementRecorded.handlers);
  assert.equal((await runRelay(replacement.bootstrap, { hook_event_name: "Stop" })).status, "accepted");
  assert.equal(replacementRecorded.events.length, 1);
  assert.deepEqual(replacementRecorded.failures, []);
  assert.deepEqual(valid.failures, []);
});

test("an admission-loss callback that throws is contained and the fixed ACK stays rejected", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  let calls = 0;
  recorded.handlers.onFailure = (failure) => {
    calls += 1;
    recorded.failures.push(failure);
    throw new Error("native admission-loss callback intentionally threw");
  };
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);
  brokerTest.setNativeHookDeliveryLimitForTests(0);

  const first = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }),
  );
  assert.equal(first.ack?.accepted, false, "a throwing callback cannot accept the discarded delivery");
  assert.equal(calls, 1);
  assert.deepEqual(recorded.events, []);
  assert.deepEqual(recorded.failures, [{ backend: "claude", reason: "delivery-refused" }]);
  await waitFor(
    () => {
      const counts = nativeLaneCounts(broker);
      return counts.activeConnections === 0 && counts.refused === 0 && counts.deliveries === 0;
    },
    "refused admission socket drained",
  );

  const second = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }),
  );
  assert.equal(second.ack?.accepted, false);
  assert.equal(calls, 2);
  assert.deepEqual(recorded.events, []);
});

test("an admission-loss callback may release its own source without a late failure", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  let registration!: NativeHookRegistration;
  recorded.handlers.onFailure = (failure) => {
    recorded.failures.push(failure);
    registration.release();
  };
  registration = broker.registerNativeHookSource(INSTANCE_RELEASED, "codex", recorded.handlers);
  brokerTest.setNativeHookDeliveryLimitForTests(0);

  const first = await sendRawNative(
    broker.socketPath,
    nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }),
  );
  // Release inside the callback destroys the refused one-shot socket before
  // its fixed ACK can be flushed; the loss is still reported exactly once.
  assert.equal(first.ack, undefined);
  assert.deepEqual(recorded.failures, [{ backend: "codex", reason: "delivery-refused" }]);
  assert.equal(
    (await sendRawNative(
      broker.socketPath,
      nativeEventFrame(registration.bootstrap, { hook_event_name: "Stop" }),
    )).ack,
    undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(recorded.failures.length, 1);
  assert.deepEqual(recorded.events, []);
  assert.equal(nativeLaneCounts(broker).activeConnections, 0);
});

test("the native wire protocol still rejects the host-local delivery-refused reason", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);
  const forgedReason = {
    ...nativeFailureFrame(registration.bootstrap, "input-malformed"),
    reason: "delivery-refused",
  } as unknown as NativeHookFailureFrame;
  assert.equal(decodeNativeHookFrame(encodeNativeHookFrame(forgedReason)), undefined);
  const forged = await sendRawNative(broker.socketPath, forgedReason);
  assert.equal(forged.ack, undefined, "the host-only reason is not a wire failure");
  assert.deepEqual(recorded.events, []);
  assert.deepEqual(recorded.failures, []);

  const legitimate = await sendRawNative(
    broker.socketPath,
    nativeFailureFrame(registration.bootstrap, "input-malformed"),
  );
  assert.equal(legitimate.ack?.accepted, true);
  assert.deepEqual(recorded.failures, [{ backend: "claude", reason: "input-malformed" }]);
});

test("native bootstrap rejection is silent and never reports an unauthenticated failure", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);
  const outcome = await runNativeHookRelay({
    env: { [NATIVE_HOOK_BOOTSTRAP_ENV]: JSON.stringify({ ...registration.bootstrap, token: "not-a-token" }) },
    stdin: relayInput({ hook_event_name: "Stop" }),
  });
  assert.equal(outcome.status, "unconfigured");
  assert.equal(outcome.delivered, undefined);
  assert.deepEqual(recorded.events, []);
  assert.deepEqual(recorded.failures, []);
});

test("duplicate native and cross-family registrations are refused before token generation", async () => {
  const broker = await makeBroker();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recordingNative().handlers);
  assert.throws(
    () => broker.registerNativeHookSource(INSTANCE_NATIVE, "codex", recordingNative().handlers),
    /active native hook source already exists/,
  );
  assert.throws(
    () => broker.register(INSTANCE_NATIVE, recordingPi().handlers),
    /active native hook source already exists/,
  );
  registration.release();

  const piRegistration = broker.register(INSTANCE_PI, recordingPi().handlers);
  assert.throws(
    () => broker.registerNativeHookSource(INSTANCE_PI, "claude", recordingNative().handlers),
    /active session-host registration already exists/,
  );
  piRegistration.release();
  // A fresh owned launch may reuse the id after explicit release.
  const replacement = broker.registerNativeHookSource(INSTANCE_NATIVE, "codex", recordingNative().handlers);
  assert.notEqual(replacement.bootstrap.token, registration.bootstrap.token);
  replacement.release();
});

test("the existing capability sanitizer strips the native hook marker and preserves provider/Pi environment", () => {
  const callerEnvironment: NodeJS.ProcessEnv = {
    [NATIVE_HOOK_BOOTSTRAP_ENV]: "native-secret",
    [SESSION_HOST_BOOTSTRAP_ENV]: "pi-secret",
    [NODE_OPTIONS_RESTORE_ENV]: '{"original":null}',
    [RUNTIME_ROLE_ENV]: "",
    NODE_OPTIONS: "--no-warnings",
    HOME: "/home/example",
    CLAUDE_CONFIG_DIR: "/home/example/.claude",
    CODEX_HOME: "/home/example/.codex",
    ANTHROPIC_API_KEY: "provider-secret",
    HERDR_ENV: "1",
    PI_REVIEW_GATE_SETTLEMENT_PATH: "stale-path",
    sentinel: "keep-me",
  };
  const original = { ...callerEnvironment };
  const working = { ...callerEnvironment };
  rejectAndStripInheritedHostCapabilities(working);
  assert.deepEqual(callerEnvironment, original, "the sanitizer contract is used on a clone; its caller's snapshot is untouched");
  assert.equal(working[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
  assert.equal(working[SESSION_HOST_BOOTSTRAP_ENV], undefined);
  assert.equal(working[NODE_OPTIONS_RESTORE_ENV], undefined);
  assert.equal(working.PI_REVIEW_GATE_SETTLEMENT_PATH, undefined);
  assert.equal(working.NODE_OPTIONS, "--no-warnings");
  assert.equal(working.HOME, "/home/example");
  assert.equal(working.CLAUDE_CONFIG_DIR, "/home/example/.claude");
  assert.equal(working.CODEX_HOME, "/home/example/.codex");
  assert.equal(working.ANTHROPIC_API_KEY, "provider-secret");
  assert.equal(working.HERDR_ENV, "1");
  assert.equal(working.sentinel, "keep-me");
  const roleEnvironment: NodeJS.ProcessEnv = {
    [RUNTIME_ROLE_ENV]: "executor",
    [NATIVE_HOOK_BOOTSTRAP_ENV]: "native-secret",
  };
  assert.throws(() => rejectAndStripInheritedHostCapabilities(roleEnvironment), /refusing to prepare a native launch/);
  assert.equal(roleEnvironment[RUNTIME_ROLE_ENV], "executor", "a genuine worker-role marker is never silently cleared");
  assert.equal(roleEnvironment[NATIVE_HOOK_BOOTSTRAP_ENV], "native-secret");

  assert.deepEqual(
    snapshotNativeEnvironment({
      pi_review_gate_native_hook_bootstrap: "case-variant",
      [NATIVE_HOOK_BOOTSTRAP_ENV]: "exact",
      PATH: "/bin",
    }, "win32"),
    { PATH: "/bin" },
    "Windows snapshot drops every native-marker casing before composition",
  );
});

interface ChildOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCompiledEntrypoint(env: NodeJS.ProcessEnv, stdin: Buffer): Promise<ChildOutcome> {
  const helper = path.join(__dirname, "..", "src", "session-host", "native-hook-relay.js");
  return new Promise<ChildOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, [helper], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function writeSocketPathPreload(): string {
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".prg-hk-pre-"));
  preloadDirectories.add(directory);
  const file = path.join(directory, "socket-path-shim.cjs");
  fs.writeFileSync(file, `
const net = require("node:net");
const path = require("node:path");
const original = net.Socket.prototype.connect;
function shorten(address) {
  if (typeof address !== "string" || !path.isAbsolute(address) || Buffer.byteLength(address, "utf8") <= 100) return address;
  const relative = path.relative(process.cwd(), address);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep)) return address;
  return "./" + relative;
}
net.Socket.prototype.connect = function (...args) {
  if (Array.isArray(args[0]) && args[0].length > 0) {
    const first = args[0][0];
    if (typeof first === "string") args[0][0] = { path: shorten(first) };
    else if (first && typeof first === "object" && typeof first.path === "string") {
      args[0][0] = { ...first, path: shorten(first.path) };
    }
  } else if (typeof args[0] === "string") args[0] = { path: shorten(args[0]) };
  else if (args[0] && typeof args[0] === "object" && typeof args[0].path === "string") {
    args[0] = { ...args[0], path: shorten(args[0].path) };
  }
  return original.apply(this, args);
};
`, { mode: 0o600 });
  return file;
}

test("the genuine compiled entrypoint stays silent, exits zero, and delivers one event or failure", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);
  const preload = writeSocketPathPreload();
  const childEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    NODE_OPTIONS: `--require=${preload}`,
    [NATIVE_HOOK_BOOTSTRAP_ENV]: JSON.stringify(registration.bootstrap),
  };

  const accepted = await runCompiledEntrypoint(
    childEnvironment,
    Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu-child", prompt: "SECRET" })),
  );
  assert.equal(accepted.code, 0);
  assert.equal(accepted.stdout, "", "a native hook observer never emits permission/control JSON or any stdout");
  assert.equal(accepted.stderr, "", "no secret or provider diagnostics are written");
  await waitFor(() => recorded.events.length === 1, "entrypoint event");
  assert.deepEqual(recorded.events[0], {
    backend: "claude",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu-child",
  });

  const failed = await runCompiledEntrypoint(childEnvironment, Buffer.from("{not-json"));
  assert.equal(failed.code, 0);
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "");
  await waitFor(() => recorded.failures.length === 1, "entrypoint failure");
  assert.deepEqual(recorded.failures[0], { backend: "claude", reason: "input-malformed" });
});
