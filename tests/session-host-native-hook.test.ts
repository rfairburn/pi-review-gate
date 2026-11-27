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
  MAX_NATIVE_HOOK_MEMBER_ID_BYTES,
  MAX_NATIVE_HOOK_MEMBERS_ID_BYTES,
  deriveNativeHookBackgroundSnapshot,
  decodeNativeHookAck,
  decodeNativeHookFrame,
  encodeNativeHookBootstrapEnv,
  encodeNativeHookFrame,
  parseNativeHookBootstrap,
  parseNativeHookBootstrapEnv,
  sanitizeNativeHookProviderInput,
  type NativeHookAckFrame,
  type NativeHookBackgroundMember,
  type NativeHookBootstrap,
  type NativeHookEvent,
  type NativeHookEventFrame,
  type NativeHookFailure,
  type NativeHookFailureFrame,
  type NativeHookFailureReason,
} from "../src/session-host/native-hook-protocol";
import {
  NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV,
  sanitizeNativeReviewProviderInput,
} from "../src/session-host/native-review-hook-protocol";
import { runNativeHookRelay } from "../src/session-host/native-hook-relay";
import { NativeClaudeBackgroundLedger } from "../src/session-host/native-claude-background";
import { createNativeStatusObserver } from "../src/session-host/native-observer-factory";
import type { NativeStatusObservation } from "../src/session-host/native-status";
import { nativeReviewLaneBackgroundState } from "../src/session-host/native-review-lane-owner";
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

test("a rejected-snapshot failure frame carries closed boundary metadata and nothing else", () => {
  const bootstrap: NativeHookBootstrap = {
    version: 1,
    socketPath: "/tmp/broker.sock",
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    instanceId: INSTANCE_NATIVE,
    backend: "claude",
    token: "a".repeat(64),
  };
  const base = nativeFailureFrame(bootstrap, "background-snapshot-rejected");
  const decode = (frame: unknown) => decodeNativeHookFrame(`${JSON.stringify(frame)}\n`);
  const withBoundary = (boundary: unknown) => decode({ ...base, rejectedSnapshotBoundary: boundary });

  // The admitted shape: the established kind plus that boundary's own bindings.
  const root = {
    hook_event_name: "Stop",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    prompt_id: "prompt-1",
  };
  assert.deepEqual(decode({ ...base, rejectedSnapshotBoundary: root }), {
    kind: "failure",
    frame: { ...base, rejectedSnapshotBoundary: root },
    failure: { backend: "claude", reason: "background-snapshot-rejected", rejectedSnapshotBoundary: root },
  });
  // A `SubagentStop` may name its child and that child's named transcript.
  assert.equal(withBoundary({
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    agent_id: "aaacc46163",
    agent_transcript_path: "/tmp/child.jsonl",
  })?.kind, "failure");

  // Nothing of the refused array, and no other provider field, is boundary
  // metadata: a smuggled count, member, kind gap, or piece of provider text
  // refuses the whole frame.
  for (const smuggled of [
    { background_counts: { tasks: 1, shells: 1 } },
    { background_members: [{ id: "aaacc46163", kind: "task" }] },
    { background_unidentified_kinds: ["task"] },
    { background_started: { id: "b8k3n1p4q", kind: "shell" } },
    { tool_name: "AskUserQuestion" },
    { tool_use_id: "toolu-1" },
    { description: "SECRET" },
    { hook_event_name: "Stop", background_counts: { tasks: 0, shells: 0 } },
  ]) {
    assert.equal(withBoundary({ ...root, ...smuggled }), undefined,
      `a refused snapshot never smuggles ${Object.keys(smuggled).join(",")}`);
  }

  // Only the Stop-family kind the selector actually established, and only the
  // bindings that kind can name.
  for (const kind of ["PreToolUse", "PostToolUseFailure", "SubagentStart", "made-up", "", 7, null]) {
    assert.equal(withBoundary({ ...root, hook_event_name: kind }), undefined,
      "a boundary of another kind was never established by the selector");
  }
  // A named child transcript belongs to the one kind whose producer names it.
  assert.equal(withBoundary({ ...root, agent_transcript_path: "/tmp/child.jsonl" }), undefined,
    "a child transcript on a root Stop is a mismatched combination");
  // `agent_id` is a binding either kind may carry, so the wire does not second-guess
  // it: the kind the selector established is what arrives, and the observer's own
  // ownership fences decide which lane it can speak for.
  assert.equal(withBoundary({ ...root, agent_id: "aaacc46163" })?.kind, "failure");
  assert.equal(withBoundary({ session_id: "session-1" }), undefined,
    "a boundary with no kind is not a boundary");
  assert.equal(withBoundary({ ...root, session_id: "" }), undefined,
    "an empty binding is not a binding");
  assert.equal(withBoundary(root.session_id), undefined, "a boundary is a closed record");
  assert.equal(withBoundary(undefined), undefined, "the reason with no boundary is refused");
  assert.equal(decode(base), undefined, "a refused snapshot must say which boundary it refused");

  // The reason and its metadata are Claude-only, and the metadata belongs to that
  // reason alone.
  const codexBase = nativeFailureFrame({ ...bootstrap, backend: "codex" }, "background-snapshot-rejected");
  assert.equal(decode({ ...codexBase, rejectedSnapshotBoundary: root }), undefined);
  assert.equal(decode(codexBase), undefined);
  assert.equal(decode({
    ...nativeFailureFrame(bootstrap, "input-malformed"),
    rejectedSnapshotBoundary: root,
  }), undefined, "no other closed reason describes a refused snapshot");
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

test("an agent's named child transcript is selected only on that agent's own boundary", () => {
  // Claude Code 2.1.325 names the closing child's own transcript on `SubagentStop`
  // and nowhere else. It is selected as a bounded absolute path and nothing more:
  // no filename is derived, no directory is searched, and an event that was not
  // given one is not given a guess.
  const child = sanitizeNativeHookProviderInput({
    hook_event_name: "SubagentStop",
    session_id: "session-child",
    transcript_path: "/tmp/session-root.jsonl",
    agent_transcript_path: "/tmp/session-child-agent.jsonl",
    agent_id: "agent-child-1",
  });
  assert.deepEqual(child, {
    ok: true,
    metadata: {
      hook_event_name: "SubagentStop",
      session_id: "session-child",
      transcript_path: "/tmp/session-root.jsonl",
      agent_transcript_path: "/tmp/session-child-agent.jsonl",
      agent_id: "agent-child-1",
    },
  });

  // Anywhere else it is not a field this trusted producer emits, so a frame that
  // carries it is refused rather than quietly given a path to open.
  for (const name of ["Stop", "PostToolUse", "UserPromptSubmit", "SessionStart"]) {
    assert.deepEqual(
      sanitizeNativeHookProviderInput({ hook_event_name: name, agent_transcript_path: "/tmp/x.jsonl" }),
      { ok: false, reason: "input-invalid" },
      `${name} never selects a child transcript`,
    );
  }

  // On the one event that may carry it, the same path rules apply: relative, empty,
  // control-character, and oversized values fail the event instead of becoming a
  // path a consumer would have to second-guess.
  for (const bad of ["relative.jsonl", "", "/tmp/bad\u0001.jsonl", `/tmp/${"p".repeat(4096)}.jsonl`]) {
    assert.equal(
      sanitizeNativeHookProviderInput({
        hook_event_name: "SubagentStop",
        agent_id: "agent-child-1",
        agent_transcript_path: bad,
      }).ok,
      false,
      `an unusable child transcript path is refused: ${bad.slice(0, 24)}`,
    );
  }
});

test("a SessionStart cwd is selected only from that boundary, as a bounded absolute path, and never from any other event", () => {
  // `cwd` is a generic provider hook base field. It is root-context proof material
  // for the row's selected workspace and is selected from a SessionStart alone.
  const start = sanitizeNativeHookProviderInput({
    hook_event_name: "SessionStart",
    session_id: "11111111-1111-4111-8111-111111111111",
    transcript_path: "/tmp/session.jsonl",
    source: "resume",
    cwd: "/tmp/workspace",
    model: "SECRET MODEL",
    prompt: "SECRET PROMPT",
  });
  assert.deepEqual(start, {
    ok: true,
    metadata: {
      hook_event_name: "SessionStart",
      session_id: "11111111-1111-4111-8111-111111111111",
      transcript_path: "/tmp/session.jsonl",
      source: "resume",
      cwd: "/tmp/workspace",
    },
  });

  // Every other event carries cwd too, and it is simply not selected: the event
  // keeps its pre-existing shape and does not fail.
  for (const name of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "SessionEnd"]) {
    const selected = sanitizeNativeHookProviderInput({ hook_event_name: name, session_id: "s-1", cwd: "/tmp/workspace" });
    assert.equal(selected.ok, true, `${name} still selects`);
    assert.equal(selected.ok && "cwd" in selected.metadata, false, `${name} never selects cwd`);
  }

  // On a SessionStart an unusable cwd proves nothing and is omitted rather than
  // failing the boundary (its scope rebind must survive).
  for (const bad of ["relative/dir", "", "/tmp/bad\u0001dir", "/tmp/bad\u2028dir", `/${"d".repeat(4096)}`, 7, null, { path: "/tmp" }]) {
    const selected = sanitizeNativeHookProviderInput({ hook_event_name: "SessionStart", session_id: "s-1", cwd: bad });
    assert.deepEqual(selected, { ok: true, metadata: { hook_event_name: "SessionStart", session_id: "s-1" } });
  }
});

test("the wire decoder carries a SessionStart cwd only for Claude and refuses it anywhere else", () => {
  const claude: NativeHookBootstrap = {
    version: 1,
    socketPath: "/tmp/broker.sock",
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    instanceId: INSTANCE_NATIVE,
    backend: "claude",
    token: "a".repeat(64),
  };
  const start = nativeEventFrame(claude, {
    hook_event_name: "SessionStart",
    session_id: "11111111-1111-4111-8111-111111111111",
    transcript_path: "/tmp/session.jsonl",
    source: "resume",
    cwd: "/tmp/workspace",
  });
  const decoded = decodeNativeHookFrame(encodeNativeHookFrame(start));
  assert.equal(decoded?.kind, "event");
  assert.deepEqual(decoded?.kind === "event" ? decoded.frame : undefined, start);
  assert.deepEqual(decoded?.kind === "event" ? decoded.event : undefined, {
    backend: "claude",
    hook_event_name: "SessionStart",
    session_id: "11111111-1111-4111-8111-111111111111",
    transcript_path: "/tmp/session.jsonl",
    source: "resume",
    cwd: "/tmp/workspace",
  });

  // A frame carrying cwd on another event, or an unusable one, is not relay output.
  const prompt = nativeEventFrame(claude, { hook_event_name: "UserPromptSubmit", session_id: "s-1" });
  assert.equal(decodeNativeHookFrame(`${JSON.stringify({ ...prompt, cwd: "/tmp/workspace" })}\n`), undefined);
  for (const bad of ["relative", "", "/tmp/bad\u0001", 7, null]) {
    assert.equal(decodeNativeHookFrame(`${JSON.stringify({ ...start, cwd: bad })}\n`), undefined);
  }
  // The fixed frame bound still applies: a combination that cannot fit is refused.
  const oversized = { ...start, transcript_path: `/${"t".repeat(2040)}`, cwd: `/${"c".repeat(2040)}` };
  assert.throws(() => encodeNativeHookFrame(oversized), RangeError);
  assert.equal(decodeNativeHookFrame(`${JSON.stringify(oversized)}\n`), undefined);

  // A Codex frame keeps its pre-existing callback shape: the shared relay may have
  // framed cwd, but it never reaches a Codex callback.
  const codex = nativeEventFrame({ ...claude, backend: "codex" }, {
    hook_event_name: "SessionStart",
    session_id: "s-codex",
    source: "startup",
    cwd: "/tmp/workspace",
  });
  const codexDecoded = decodeNativeHookFrame(encodeNativeHookFrame(codex));
  assert.equal(codexDecoded?.kind, "event");
  assert.deepEqual(codexDecoded?.kind === "event" ? codexDecoded.event : undefined, {
    backend: "codex",
    hook_event_name: "SessionStart",
    session_id: "s-codex",
    source: "startup",
  });
  assert.equal(codexDecoded?.kind === "event" && "cwd" in codexDecoded.frame, false);
});

test("an empty Claude agent_type is omitted as descriptive metadata without erasing the same hook's facts", () => {
  // Claude Code 2.1.325's SubagentStop producer writes
  // `agent_type: contextType ?? mainAgentType ?? ''`, and the field's own schema
  // has no minimum length. The label is descriptive only: `agent_id` alone is
  // scope, so the empty value is omitted instead of failing the whole raw hook
  // and discarding the identity, session, and background facts beside it.
  const child = sanitizeNativeHookProviderInput({
    hook_event_name: "SubagentStop",
    session_id: "session-child",
    transcript_path: "/tmp/session-child.jsonl",
    agent_id: "agent-child-1",
    agent_type: "",
    prompt_id: "prompt-1",
    tool_name: "Task",
    tool_use_id: "toolu-1",
    background_tasks: [
      { id: "a1a2b3c4d", type: "subagent", status: "running", description: "SECRET DESCRIPTION" },
      { id: "b8k3n1p4q", type: "shell", status: "running", command: "SECRET COMMAND" },
    ],
  });
  assert.deepEqual(child, {
    ok: true,
    metadata: {
      hook_event_name: "SubagentStop",
      session_id: "session-child",
      transcript_path: "/tmp/session-child.jsonl",
      agent_id: "agent-child-1",
      prompt_id: "prompt-1",
      tool_name: "Task",
      tool_use_id: "toolu-1",
      background_counts: { tasks: 1, shells: 1 },
      background_members: [
        { id: "a1a2b3c4d", kind: "task" },
        { id: "b8k3n1p4q", kind: "shell" },
      ],
    },
  });
  assert.ok(!JSON.stringify(child).includes("SECRET"), "the raw background fields are never projected");

  // Absent agent_id, never the type label, is what leaves an event at root
  // scope; an empty label must not invent an identity or withdraw one.
  assert.deepEqual(sanitizeNativeHookProviderInput({
    hook_event_name: "SubagentStop",
    session_id: "session-root",
    agent_type: "",
  }), {
    ok: true,
    metadata: { hook_event_name: "SubagentStop", session_id: "session-root" },
  });

  // A nonempty named type is descriptive metadata and stays unchanged.
  assert.deepEqual(sanitizeNativeHookProviderInput({
    hook_event_name: "SubagentStop",
    agent_id: "agent-child-1",
    agent_type: "worker",
  }), {
    ok: true,
    metadata: {
      hook_event_name: "SubagentStop",
      agent_id: "agent-child-1",
      agent_type: "worker",
    },
  });

  // Only the exactly-empty descriptive label is normalized. Empty identities
  // and paths, plus wrong-typed or oversized labels, still fail the whole event
  // closed under the existing validation.
  const stillInvalid: unknown[] = [
    { hook_event_name: "SubagentStop", agent_id: "", agent_type: "" },
    { hook_event_name: "SubagentStop", session_id: "", agent_type: "" },
    { hook_event_name: "SubagentStop", transcript_path: "", agent_type: "" },
    { hook_event_name: "SubagentStop", agent_id: "agent-child-1", agent_type: 7 },
    { hook_event_name: "SubagentStop", agent_id: "agent-child-1", agent_type: "x".repeat(129) },
  ];
  for (const payload of stillInvalid) {
    assert.deepEqual(sanitizeNativeHookProviderInput(payload), { ok: false, reason: "input-invalid" });
  }

  // The wire contract stays strict: the trusted relay omits the empty label,
  // so a frame that still carries it present-empty is not relay output.
  const bootstrap: NativeHookBootstrap = {
    version: 1,
    socketPath: "/tmp/broker.sock",
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    instanceId: INSTANCE_NATIVE,
    backend: "claude",
    token: "a".repeat(64),
  };
  assert.equal(decodeNativeHookFrame(encodeNativeHookFrame(nativeEventFrame(bootstrap, {
    hook_event_name: "SubagentStop",
    agent_id: "agent-child-1",
    agent_type: "",
  }))), undefined);
  const named = decodeNativeHookFrame(encodeNativeHookFrame(nativeEventFrame(bootstrap, {
    hook_event_name: "SubagentStop",
    agent_id: "agent-child-1",
    agent_type: "worker",
  })));
  assert.deepEqual(named?.kind === "event" ? named.event : undefined, {
    backend: "claude",
    hook_event_name: "SubagentStop",
    agent_id: "agent-child-1",
    agent_type: "worker",
  });
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
    // Two active tasks and one shell were counted, but only the shell carried an
    // id: the projection names the TASK category as unkeyable and nothing else,
    // so a consumer withdraws its task coverage while its shell coverage stands.
    background_unidentified_kinds: ["task"],
  });
  assert.ok(!JSON.stringify(selected).includes("SECRET"), "no raw snapshot field reaches the selected metadata");

  assert.deepEqual(sanitizeNativeHookProviderInput({ hook_event_name: "Stop" }), {
    ok: true,
    metadata: { hook_event_name: "Stop" },
  });
  assert.deepEqual(sanitizeNativeHookProviderInput({ hook_event_name: "Stop", background_tasks: [] }), {
    ok: true,
    metadata: {
      hook_event_name: "Stop",
      background_counts: { tasks: 0, shells: 0 },
      // An empty provider array is a complete snapshot, so membership is known
      // to be empty rather than merely unobserved.
      background_members: [],
    },
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

test("a relayed SessionStart delivers the provider cwd to a Claude source and nothing else new", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);
  const transcriptPath = path.join(process.cwd(), "transcript.jsonl");
  const outcome = await runRelay(registration.bootstrap, {
    hook_event_name: "SessionStart",
    session_id: "11111111-1111-4111-8111-111111111111",
    transcript_path: transcriptPath,
    source: "resume",
    cwd: process.cwd(),
    model: "SECRET MODEL",
    permission_mode: "SECRET MODE",
  });
  assert.equal(outcome.status, "accepted");
  assert.deepEqual(recorded.events, [{
    backend: "claude",
    hook_event_name: "SessionStart",
    session_id: "11111111-1111-4111-8111-111111111111",
    transcript_path: transcriptPath,
    source: "resume",
    cwd: process.cwd(),
  }]);
  assert.ok(!JSON.stringify(recorded.events).includes("SECRET"));
  assert.deepEqual(recorded.failures, []);
});

test("the relay's raw wire frame carries a SessionStart cwd for Claude only, before any broker decoding", async () => {
  for (const backend of ["claude", "codex"] as const) {
    const broker = await makeBroker();
    const recorded = recordingNative();
    const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, backend, recorded.handlers);
    const written: string[] = [];
    const outcome = await runNativeHookRelay({
      env: { [NATIVE_HOOK_BOOTSTRAP_ENV]: JSON.stringify(registration.bootstrap) },
      stdin: relayInput({
        hook_event_name: "SessionStart",
        session_id: "11111111-1111-4111-8111-111111111111",
        source: "resume",
        cwd: process.cwd(),
      }),
      // Observe the exact bytes the relay writes to the local socket; the real
      // connection and the real broker decoder are otherwise untouched.
      connect: (socketPath) => {
        const socket = net.createConnection({ path: socketPath });
        const write = socket.write.bind(socket) as (chunk: unknown, ...rest: unknown[]) => boolean;
        (socket as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk, ...rest) => {
          written.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
          return write(chunk, ...rest);
        };
        return socket;
      },
    });
    assert.equal(outcome.status, "accepted", backend);
    const raw = written.join("");
    const frames = raw.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(frames.length, 1, `${backend}: one event frame was written`);
    const metadata = JSON.stringify(frames[0]);
    if (backend === "claude") {
      assert.ok(metadata.includes(JSON.stringify(process.cwd())), "the Claude frame keeps the proof cwd");
    } else {
      assert.equal(raw.includes(JSON.stringify(process.cwd()).slice(1, -1)), false,
        "the Codex frame never carries the provider cwd on the local socket");
      assert.equal(metadata.includes("\"cwd\""), false);
    }
    assert.equal(recorded.events.length, 1, `${backend}: the event is still delivered`);
    registration.release();
  }
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
      // None of these active entries carried an id, so the projection names both
      // categories as unkeyable and publishes no shortened membership set.
      background_unidentified_kinds: ["shell", "task"],
    },
    { backend: "claude", hook_event_name: "Stop" },
    {
      backend: "claude",
      hook_event_name: "Stop",
      background_counts: { tasks: 0, shells: 0 },
      background_members: [],
    },
    {
      backend: "claude",
      hook_event_name: "SubagentStop",
      agent_id: "agent-child-1",
      agent_type: "worker",
      background_counts: { tasks: 1, shells: 1 },
      background_unidentified_kinds: ["task", "shell"],
    },
  ]);
  assert.deepEqual(recorded.failures, []);
  const serialized = JSON.stringify(recorded.events);
  assert.ok(!serialized.includes("SECRET"), "raw snapshot fields are never projected or echoed");
  assert.ok(!serialized.includes("background_tasks"), "the raw provider array never crosses the wire");
});

test("a relay-delivered empty Claude agent_type keeps the hook's identity and membership facts", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);
  const transcriptPath = path.join(process.cwd(), "child-transcript.jsonl");

  const child = await runRelay(registration.bootstrap, {
    hook_event_name: "SubagentStop",
    session_id: "session-child",
    transcript_path: transcriptPath,
    agent_id: "agent-child-1",
    agent_type: "",
    prompt_id: "prompt-1",
    tool_name: "Task",
    tool_use_id: "toolu-1",
    background_tasks: [
      { id: "a1a2b3c4d", type: "subagent", status: "running", description: "SECRET DESCRIPTION" },
    ],
  });
  assert.equal(child.status, "accepted");
  assert.equal(child.delivered, "event");

  // The same empty descriptive label at root scope must not invent an
  // identity: only an absent agent_id keeps this event at root.
  const root = await runRelay(registration.bootstrap, {
    hook_event_name: "SubagentStop",
    session_id: "session-root",
    agent_type: "",
  });
  assert.equal(root.status, "accepted");
  assert.equal(root.delivered, "event");

  assert.deepEqual(recorded.events, [{
    backend: "claude",
    hook_event_name: "SubagentStop",
    session_id: "session-child",
    transcript_path: transcriptPath,
    agent_id: "agent-child-1",
    prompt_id: "prompt-1",
    tool_name: "Task",
    tool_use_id: "toolu-1",
    background_counts: { tasks: 1, shells: 0 },
    background_members: [{ id: "a1a2b3c4d", kind: "task" }],
  }, {
    backend: "claude",
    hook_event_name: "SubagentStop",
    session_id: "session-root",
  }]);
  assert.deepEqual(recorded.failures, []);
  const serialized = JSON.stringify(recorded.events);
  assert.ok(!serialized.includes("agent_type"), "the empty descriptive label never crosses the wire");
  assert.ok(!serialized.includes("SECRET"), "the raw snapshot description is never projected");
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
  // The event was established as a Stop boundary before its own array was refused,
  // so the Claude source reports that one closed reason instead of a generic
  // invalid input. The array is still refused whole and nothing is delivered.
  assert.equal(malformed.failure, "background-snapshot-rejected");

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
  assert.equal(oversized.failure, "background-snapshot-rejected");

  assert.deepEqual(recorded.events, []);
  assert.deepEqual(recorded.failures, [
    // The reason arrives beside the refused boundary's own metadata: the kind the
    // selector established plus the boundary's bindings. These two inputs named no
    // session, prompt, transcript, or child, so nothing else is carried, and no
    // part of the refused array is.
    {
      backend: "claude",
      reason: "background-snapshot-rejected",
      rejectedSnapshotBoundary: { hook_event_name: "Stop" },
    },
    {
      backend: "claude",
      reason: "background-snapshot-rejected",
      rejectedSnapshotBoundary: { hook_event_name: "Stop" },
    },
  ]);

  // The reason is Claude-only. A Codex source whose array is refused the same way
  // keeps the ordinary closed reason it reported before this field existed.
  const codexRecorded = recordingNative();
  const codex = broker.registerNativeHookSource(INSTANCE_NATIVE_OTHER, "codex", codexRecorded.handlers);
  const codexRejected = await runRelay(codex.bootstrap, {
    hook_event_name: "Stop",
    session_id: "session-codex",
    background_tasks: [{ status: "running", backgrounded: true }],
  });
  assert.equal(codexRejected.delivered, "failure");
  assert.deepEqual(codexRecorded.failures, [{ backend: "codex", reason: "input-invalid" }]);
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
    // #736: the SEPARATE review-family marker is no more ordinary launch input.
    [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: "native-review-secret",
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
  assert.equal(working[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "the review-family marker is stripped by the one sanitizer");
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
    [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: "native-review-secret",
  };
  assert.throws(() => rejectAndStripInheritedHostCapabilities(roleEnvironment), /refusing to prepare a native launch/);
  assert.equal(roleEnvironment[RUNTIME_ROLE_ENV], "executor", "a genuine worker-role marker is never silently cleared");
  assert.equal(roleEnvironment[NATIVE_HOOK_BOOTSTRAP_ENV], "native-secret");
  assert.equal(roleEnvironment[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], "native-review-secret");

  assert.deepEqual(
    snapshotNativeEnvironment({
      pi_review_gate_native_hook_bootstrap: "case-variant",
      [NATIVE_HOOK_BOOTSTRAP_ENV]: "exact",
      pi_review_gate_native_review_bootstrap: "case-variant",
      [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: "exact",
      PATH: "/bin",
    }, "win32"),
    { PATH: "/bin" },
    "Windows snapshot drops every native-marker casing of BOTH families before composition",
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

// --- background membership and launch metadata (live-count counter core) -----
//
// These fixtures use the field shapes verified in the installed Claude Code
// 2.1.325 binary: a Stop `background_tasks` entry is
// `{id, type, status, description, …type extras}` (producer `$Qn`, schema `aC`)
// already pre-filtered by the provider to running/pending backgrounded work, and
// a background launch is a `PostToolUse` `tool_response` carrying either
// `backgroundTaskId` (Bash) or `status:"async_launched"` plus `agentId`
// (Task/Agent). Ids are the provider's own task-registry keys, so a launch id
// and a later snapshot member id are the same namespace.

const REAL_STOP_SNAPSHOT = [
  { id: "b8k3n1p4q", type: "shell", status: "running", description: "SECRET DESCRIPTION", command: "SECRET COMMAND" },
  { id: "a1a2b3c4d", type: "subagent", status: "running", description: "SECRET DESCRIPTION", agent_type: "worker" },
  { id: "m22222222", type: "monitor", status: "pending", description: "SECRET DESCRIPTION", server: "SECRET SERVER", tool: "SECRET TOOL" },
];

test("a real-shaped Stop snapshot projects closed membership alongside counts, without any provider text", () => {
  const selected = sanitizeNativeHookProviderInput({
    hook_event_name: "Stop",
    session_id: "session-root",
    stop_hook_active: false,
    last_assistant_message: "SECRET FINAL MESSAGE",
    background_tasks: REAL_STOP_SNAPSHOT,
    session_crons: [{ id: "c1", schedule: "SECRET CRON", prompt: "SECRET PROMPT" }],
  });
  assert.equal(selected.ok, true);
  if (!selected.ok) assert.fail("the real-shaped Stop snapshot must be admitted");
  assert.deepEqual(selected.metadata, {
    hook_event_name: "Stop",
    session_id: "session-root",
    background_counts: { tasks: 2, shells: 1 },
    background_members: [
      { id: "b8k3n1p4q", kind: "shell" },
      { id: "a1a2b3c4d", kind: "task" },
      { id: "m22222222", kind: "task" },
    ],
  });
  const serialized = JSON.stringify(selected);
  assert.ok(!serialized.includes("SECRET"), "no description, command, cron, prompt, or message is projected");
  assert.ok(!serialized.includes("background_tasks"), "the raw provider array never crosses the wire");

  // An empty provider array is a positively observed empty set, not an absence.
  const empty = sanitizeNativeHookProviderInput({ hook_event_name: "Stop", background_tasks: [] });
  assert.deepEqual(empty, {
    ok: true,
    metadata: {
      hook_event_name: "Stop",
      background_counts: { tasks: 0, shells: 0 },
      background_members: [],
    },
  });

  // The shared derivation pass is what keeps counts and membership consistent.
  const derived = deriveNativeHookBackgroundSnapshot(REAL_STOP_SNAPSHOT);
  assert.equal(derived.ok, true);
  if (!derived.ok) assert.fail("the snapshot should derive");
  assert.deepEqual(derived.counts, { tasks: 2, shells: 1 });
  assert.deepEqual(derived.members, [
    { id: "b8k3n1p4q", kind: "shell" },
    { id: "a1a2b3c4d", kind: "task" },
    { id: "m22222222", kind: "task" },
  ]);
});

test("an unidentified active entry makes membership unknown instead of a shortened set", () => {
  const selected = sanitizeNativeHookProviderInput({
    hook_event_name: "Stop",
    background_tasks: [
      { id: "b8k3n1p4q", type: "shell", status: "running", description: "SECRET" },
      { type: "subagent", status: "pending", description: "SECRET" },
    ],
  });
  assert.equal(selected.ok, true);
  if (!selected.ok) assert.fail("counts are still derivable");
  assert.deepEqual(selected.metadata, {
    hook_event_name: "Stop",
    background_counts: { tasks: 1, shells: 1 },
    // The unkeyable active entry was a task, so ONLY the task category is named:
    // the counts stay exact and the identified shell is not implicated.
    background_unidentified_kinds: ["task"],
  });
  assert.ok(!("background_members" in selected.metadata), "a partial membership view is never published");

  // The inverse: an unkeyable SHELL names only the shell category.
  const shellGap = sanitizeNativeHookProviderInput({
    hook_event_name: "Stop",
    background_tasks: [
      { id: "a1a2b3c4d", type: "subagent", status: "running", description: "SECRET" },
      { type: "shell", status: "running", description: "SECRET" },
    ],
  });
  assert.equal(shellGap.ok, true);
  if (!shellGap.ok) assert.fail("counts are still derivable");
  assert.deepEqual(shellGap.metadata, {
    hook_event_name: "Stop",
    background_counts: { tasks: 1, shells: 1 },
    background_unidentified_kinds: ["shell"],
  });

  // Both categories unkeyable: both are named, once each, in first-seen order.
  const bothGaps = sanitizeNativeHookProviderInput({
    hook_event_name: "Stop",
    background_tasks: [
      { type: "subagent", status: "running", description: "SECRET" },
      { type: "shell", status: "running", description: "SECRET" },
      { type: "monitor", status: "pending", description: "SECRET" },
    ],
  });
  assert.equal(bothGaps.ok, true);
  if (!bothGaps.ok) assert.fail("counts are still derivable");
  assert.deepEqual(bothGaps.metadata, {
    hook_event_name: "Stop",
    background_counts: { tasks: 2, shells: 1 },
    background_unidentified_kinds: ["task", "shell"],
  });

  // A FOREGROUND entry that happens to carry no id is not membership at all, so
  // it never becomes a kind gap: the projection's claim is about ACTIVE members.
  const foregroundOnly = sanitizeNativeHookProviderInput({
    hook_event_name: "Stop",
    background_tasks: [
      { type: "shell", status: "running", backgrounded: false, description: "SECRET" },
      { type: "subagent", status: "completed", description: "SECRET" },
    ],
  });
  assert.deepEqual(foregroundOnly, {
    ok: true,
    metadata: {
      hook_event_name: "Stop",
      background_counts: { tasks: 0, shells: 0 },
      background_members: [],
    },
  });

  // Foreground entries stay excluded exactly as before: an explicit
  // `backgrounded: false` is the provider's own foreground marker.
  const foreground = sanitizeNativeHookProviderInput({
    hook_event_name: "Stop",
    background_tasks: [
      { id: "b8k3n1p4q", type: "shell", status: "running", backgrounded: false, description: "SECRET" },
      { id: "a1a2b3c4d", type: "subagent", status: "running", backgrounded: true, description: "SECRET" },
    ],
  });
  assert.deepEqual(foreground, {
    ok: true,
    metadata: {
      hook_event_name: "Stop",
      background_counts: { tasks: 1, shells: 0 },
      background_members: [{ id: "a1a2b3c4d", kind: "task" }],
    },
  });
});

test("malformed membership ids and snapshots are closed failures, never partial counts or a fake empty", () => {
  const malformed: unknown[] = [
    // Duplicate ids: the set would silently lose a member.
    [
      { id: "b8k3n1p4q", type: "shell", status: "running", description: "SECRET" },
      { id: "b8k3n1p4q", type: "subagent", status: "running", description: "SECRET" },
    ],
    // A non-text id, an empty id, and an oversized id are not opaque ids.
    [{ id: 7, type: "shell", status: "running", description: "SECRET" }],
    [{ id: "", type: "shell", status: "running", description: "SECRET" }],
    [{ id: "x".repeat(MAX_NATIVE_HOOK_MEMBER_ID_BYTES + 1), type: "shell", status: "running", description: "SECRET" }],
    // A control character is refused by the existing text guard.
    [{ id: "bad\u0001id", type: "shell", status: "running", description: "SECRET" }],
    // The existing whole-array guards are preserved unchanged.
    [{ status: "running", backgrounded: "yes", type: "shell" }],
    [{ id: "b8k3n1p4q", status: "", type: "shell", description: "SECRET" }],
    Array.from({ length: MAX_NATIVE_HOOK_BACKGROUND_TASKS + 1 }, () => ({
      id: "b8k3n1p4q",
      status: "completed",
      backgrounded: false,
      type: "shell",
    })),
  ];
  for (const snapshot of malformed) {
    const result = sanitizeNativeHookProviderInput({ hook_event_name: "Stop", background_tasks: snapshot });
    assert.equal(result.ok, false, "malformed membership fails closed instead of counting partially");
    if (result.ok) assert.fail("expected an explicit snapshot failure");
    assert.ok(result.reason === "input-invalid" || result.reason === "input-too-large");
  }
});

test("only an actual successful launch result projects background_started", () => {
  const bashBackground = sanitizeNativeHookProviderInput({
    hook_event_name: "PostToolUse",
    session_id: "session-root",
    tool_name: "Bash",
    tool_use_id: "toolu-1",
    tool_input: { command: "SECRET COMMAND", run_in_background: true },
    tool_response: {
      stdout: "SECRET OUTPUT",
      stderr: "",
      interrupted: false,
      backgroundTaskId: "b8k3n1p4q",
      backgroundOutputPath: "/tmp/SECRET-OUTPUT-PATH",
    },
  });
  assert.equal(bashBackground.ok, true);
  if (!bashBackground.ok) assert.fail("the Bash background result should be admitted");
  assert.deepEqual(bashBackground.metadata, {
    hook_event_name: "PostToolUse",
    session_id: "session-root",
    tool_name: "Bash",
    tool_use_id: "toolu-1",
    background_started: { id: "b8k3n1p4q", kind: "shell" },
  });

  const asyncAgent = sanitizeNativeHookProviderInput({
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_use_id: "toolu-2",
    tool_input: { prompt: "SECRET PROMPT", subagent_type: "worker" },
    tool_response: {
      status: "async_launched",
      agentId: "a1a2b3c4d",
      description: "SECRET DESCRIPTION",
      prompt: "SECRET PROMPT",
      outputFile: "/tmp/SECRET-OUTPUT-PATH",
    },
  });
  assert.equal(asyncAgent.ok, true);
  if (!asyncAgent.ok) assert.fail("the async agent result should be admitted");
  assert.deepEqual(asyncAgent.metadata.background_started, { id: "a1a2b3c4d", kind: "task" });
  assert.ok(!JSON.stringify(asyncAgent.metadata).includes("SECRET"), "no prompt, description, or path is projected");

  // The provider's own name dispatch accepts both spellings of the subagent
  // tool, so both are verified task-launch tools.
  const agentAlias = sanitizeNativeHookProviderInput({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu-2b",
    tool_response: { status: "async_launched", agentId: "a9z9z9z9z" },
  });
  assert.equal(agentAlias.ok, true);
  if (!agentAlias.ok) assert.fail("the Agent alias should be admitted");
  assert.deepEqual(agentAlias.metadata.background_started, { id: "a9z9z9z9z", kind: "task" });

  const notBackground: unknown[] = [
    // A backgrounding INTENT is not a launch: the tool may still be denied.
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu-3", tool_input: { command: "SECRET", run_in_background: true } },
    // A foreground agent that ran to completion is not background work.
    { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: "toolu-4", tool_response: { status: "completed", report: "SECRET REPORT" } },
    // A failed tool result never launches anything, even with the field present.
    { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu-5", tool_response: { backgroundTaskId: "b8k3n1p4q" } },
    // An unusable id is unknown, never a guessed member.
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu-6", tool_response: { backgroundTaskId: 7 } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu-7", tool_response: { backgroundTaskId: "" } },
    { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: "toolu-8", tool_response: { status: "async_launched" } },
    // A prose or partial status match is not the provider's own result shape.
    { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: "toolu-9", tool_response: { status: "async_launched by the user", agentId: "a1a2b3c4d" } },
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu-10", tool_response: "SECRET STRING RESULT" },
    // An unrelated tool carrying a lifecycle-looking field is not evidence.
    { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu-11", tool_response: { backgroundTaskId: "b8k3n1p4q" } },
    { hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_use_id: "toolu-12", tool_response: { backgroundTaskId: "b8k3n1p4q" } },
    { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "toolu-13", tool_response: { status: "async_launched", agentId: "a1a2b3c4d" } },
    { hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_use_id: "toolu-14", tool_response: { status: "async_launched", agentId: "a1a2b3c4d" } },
    { hook_event_name: "PostToolUse", tool_use_id: "toolu-15", tool_response: { backgroundTaskId: "b8k3n1p4q" } },
    // Each id belongs to one verified tool, so a cross-kind pairing claims nothing.
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu-16", tool_response: { status: "async_launched", agentId: "a1a2b3c4d" } },
    { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: "toolu-17", tool_response: { backgroundTaskId: "b8k3n1p4q" } },
  ];
  for (const input of notBackground) {
    const result = sanitizeNativeHookProviderInput(input);
    assert.equal(result.ok, true, `the event itself stays admissible: ${JSON.stringify(input).slice(0, 40)}`);
    if (!result.ok) assert.fail("expected the event to be admitted");
    assert.ok(!("background_started" in result.metadata), "no launch is claimed");
  }
});

test("the wire family admits the closed membership and launch fields and refuses every forged combination", () => {
  const bootstrap: NativeHookBootstrap = {
    version: 1,
    socketPath: "/tmp/broker.sock",
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    instanceId: INSTANCE_NATIVE,
    backend: "claude",
    token: "a".repeat(64),
  };
  const members: readonly NativeHookBackgroundMember[] = [
    { id: "b8k3n1p4q", kind: "shell" },
    { id: "a1a2b3c4d", kind: "task" },
  ];

  const stop = nativeEventFrame(bootstrap, {
    hook_event_name: "Stop",
    background_counts: { tasks: 1, shells: 1 },
    background_members: members,
  });
  const decodedStop = decodeNativeHookFrame(encodeNativeHookFrame(stop));
  assert.equal(decodedStop?.kind, "event");
  assert.deepEqual(decodedStop?.kind === "event" ? decodedStop.event : undefined, {
    backend: "claude",
    hook_event_name: "Stop",
    background_counts: { tasks: 1, shells: 1 },
    background_members: members,
  });

  // The unkeyable form of the same snapshot: counts plus the closed kind gap,
  // and no membership set.
  const gapFrame = nativeEventFrame(bootstrap, {
    hook_event_name: "Stop",
    background_counts: { tasks: 2, shells: 1 },
    background_unidentified_kinds: ["task"],
  });
  const decodedGap = decodeNativeHookFrame(encodeNativeHookFrame(gapFrame));
  assert.deepEqual(decodedGap?.kind === "event" ? decodedGap.event : undefined, {
    backend: "claude",
    hook_event_name: "Stop",
    background_counts: { tasks: 2, shells: 1 },
    background_unidentified_kinds: ["task"],
  });

  const refused: unknown[] = [
    // Counts and membership are one snapshot: they must agree.
    { ...stop, background_counts: { tasks: 2, shells: 0 } },
    { ...stop, background_counts: { tasks: 0, shells: 0 } },
    // Membership is a Stop-family snapshot only.
    { ...stop, hook_event_name: "PostToolUse" },
    // Closed member objects only.
    { ...stop, background_members: [{ id: "b8k3n1p4q", kind: "shell", command: "SECRET" }, { id: "a1a2b3c4d", kind: "task" }] },
    { ...stop, background_members: [{ id: "b8k3n1p4q", kind: "agent" }, { id: "a1a2b3c4d", kind: "task" }] },
    { ...stop, background_members: [{ id: "b8k3n1p4q" }, { id: "a1a2b3c4d", kind: "task" }] },
    { ...stop, background_members: [{ id: "b8k3n1p4q", kind: "shell" }, { id: "b8k3n1p4q", kind: "task" }] },
    { ...stop, background_members: [{ id: "bad\u0001id", kind: "shell" }] },
    { ...stop, background_members: { 0: { id: "b8k3n1p4q", kind: "shell" } } },
    // The aggregate id budget keeps a maximum set inside the fixed frame bound.
    {
      ...stop,
      background_counts: { tasks: 0, shells: 40 },
      background_members: Array.from({ length: 40 }, (_unused, index) => ({
        // 40 ids, each inside the per-id bound but past the aggregate budget.
        id: `b${"y".repeat(MAX_NATIVE_HOOK_MEMBER_ID_BYTES - 3)}${index}`,
        kind: "shell",
      })),
    },
    // A launch edge exists only on the event with a real tool result, and only
    // for the backend whose provider issues those ids.
    { ...stop, background_started: { id: "b8k3n1p4q", kind: "shell" } },
    { ...nativeEventFrame(bootstrap, { hook_event_name: "PostToolUse", background_started: { id: "b8k3n1p4q", kind: "shell" } }), backend: "codex" },
    // Membership is Claude-only projection data as well.
    { ...stop, backend: "codex" },
    // A launch kind must be paired with the tool that can actually report it.
    nativeEventFrame(bootstrap, { hook_event_name: "PostToolUse", background_started: { id: "b8k3n1p4q", kind: "shell" } }),
    nativeEventFrame(bootstrap, { hook_event_name: "PostToolUse", tool_name: "Read", background_started: { id: "b8k3n1p4q", kind: "shell" } }),
    nativeEventFrame(bootstrap, { hook_event_name: "PostToolUse", tool_name: "Task", background_started: { id: "b8k3n1p4q", kind: "shell" } }),
    nativeEventFrame(bootstrap, { hook_event_name: "PostToolUse", tool_name: "Bash", background_started: { id: "a1a2b3c4d", kind: "task" } }),
    // The raw provider payload fields are still refused outright.
    { ...stop, background_tasks: REAL_STOP_SNAPSHOT },
    { ...nativeEventFrame(bootstrap, { hook_event_name: "PostToolUse", tool_name: "Bash" }), tool_response: { backgroundTaskId: "b8k3n1p4q" } },
    // A complete membership view and a kind gap are mutually exclusive claims
    // about one snapshot.
    { ...stop, background_unidentified_kinds: ["task"] },
    // The kind gap is the same Stop-family snapshot, Claude-only.
    { ...gapFrame, hook_event_name: "PostToolUse" },
    { ...gapFrame, backend: "codex" },
    // Only the closed kind set, distinct, nonempty, and no wider than that set.
    { ...gapFrame, background_unidentified_kinds: [] },
    { ...gapFrame, background_unidentified_kinds: ["agent"] },
    { ...gapFrame, background_unidentified_kinds: ["task", "task"] },
    { ...gapFrame, background_unidentified_kinds: ["task", "shell", "task"] },
    { ...gapFrame, background_unidentified_kinds: "task" },
    // A gap claims an ACTIVE member of that kind, so that kind's own stated
    // count cannot be zero.
    { ...gapFrame, background_counts: { tasks: 0, shells: 1 } },
  ];
  for (const frame of refused) {
    assert.equal(decodeNativeHookFrame(encodeNativeHookFrame(frame as NativeHookEventFrame)), undefined,
      `refused: ${JSON.stringify(frame).slice(0, 60)}`);
  }

  const launched = nativeEventFrame(bootstrap, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu-1",
    background_started: { id: "b8k3n1p4q", kind: "shell" },
  });
  const decodedLaunch = decodeNativeHookFrame(encodeNativeHookFrame(launched));
  assert.deepEqual(decodedLaunch?.kind === "event" ? decodedLaunch.event : undefined, {
    backend: "claude",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu-1",
    background_started: { id: "b8k3n1p4q", kind: "shell" },
  });
});

test("a genuine broker delivery carries membership and launch metadata to the registered native source", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", recorded.handlers);

  // A real background shell launch, then a real async agent launch.
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "PostToolUse",
    session_id: "session-root",
    tool_name: "Bash",
    tool_use_id: "toolu-shell",
    tool_input: { command: "SECRET COMMAND", run_in_background: true },
    tool_response: { stdout: "SECRET OUTPUT", interrupted: false, backgroundTaskId: "b8k3n1p4q" },
  })).status, "accepted");
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "PostToolUse",
    session_id: "session-root",
    tool_name: "Task",
    tool_use_id: "toolu-agent",
    tool_input: { prompt: "SECRET PROMPT" },
    tool_response: { status: "async_launched", agentId: "a1a2b3c4d", prompt: "SECRET PROMPT", outputFile: "/tmp/SECRET" },
  })).status, "accepted");
  // A backgrounding intent and a foreground agent carry no launch edge.
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "PreToolUse",
    session_id: "session-root",
    tool_name: "Bash",
    tool_use_id: "toolu-intent",
    tool_input: { command: "SECRET COMMAND", run_in_background: true },
  })).status, "accepted");
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "PostToolUse",
    session_id: "session-root",
    tool_name: "Task",
    tool_use_id: "toolu-foreground",
    tool_response: { status: "completed", report: "SECRET REPORT" },
  })).status, "accepted");
  // Then the root Stop snapshot of that same moment, plus the later empty one.
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "Stop",
    session_id: "session-root",
    last_assistant_message: "SECRET FINAL MESSAGE",
    background_tasks: REAL_STOP_SNAPSHOT,
  })).status, "accepted");
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "Stop",
    session_id: "session-root",
    background_tasks: [{ id: "b8k3n1p4q", type: "shell", status: "completed", description: "SECRET" }],
  })).status, "accepted");

  assert.deepEqual(recorded.failures, []);
  assert.deepEqual(recorded.events, [
    {
      backend: "claude",
      hook_event_name: "PostToolUse",
      session_id: "session-root",
      tool_name: "Bash",
      tool_use_id: "toolu-shell",
      background_started: { id: "b8k3n1p4q", kind: "shell" },
    },
    {
      backend: "claude",
      hook_event_name: "PostToolUse",
      session_id: "session-root",
      tool_name: "Task",
      tool_use_id: "toolu-agent",
      background_started: { id: "a1a2b3c4d", kind: "task" },
    },
    {
      backend: "claude",
      hook_event_name: "PreToolUse",
      session_id: "session-root",
      tool_name: "Bash",
      tool_use_id: "toolu-intent",
    },
    {
      backend: "claude",
      hook_event_name: "PostToolUse",
      session_id: "session-root",
      tool_name: "Task",
      tool_use_id: "toolu-foreground",
    },
    {
      backend: "claude",
      hook_event_name: "Stop",
      session_id: "session-root",
      background_counts: { tasks: 2, shells: 1 },
      background_members: [
        { id: "b8k3n1p4q", kind: "shell" },
        { id: "a1a2b3c4d", kind: "task" },
        { id: "m22222222", kind: "task" },
      ],
    },
    {
      backend: "claude",
      hook_event_name: "Stop",
      session_id: "session-root",
      background_counts: { tasks: 0, shells: 0 },
      background_members: [],
    },
  ]);

  const serialized = JSON.stringify(recorded.events);
  assert.ok(!serialized.includes("SECRET"), "no provider content reaches the registered source");
  assert.ok(!serialized.includes("tool_response"), "the raw tool response never crosses the wire");
  assert.ok(!serialized.includes("background_tasks"), "the raw snapshot array never crosses the wire");
  assert.ok(!serialized.includes(registration.bootstrap.token), "the token never reaches the callback");

  // The delivered metadata is exactly what the membership ledger consumes: the
  // known fresh owned-run baseline plus these launch edges gives live 0 → 1 → 2,
  // and the root snapshot resync and its later empty snapshot stay exact.
  const ledger = new NativeClaudeBackgroundLedger();
  const progression: Array<{ tasks: number; shells: number } | null> = [];
  assert.deepEqual(ledger.initializeFreshOwnedRun("owned-run-1").counts, { tasks: 0, shells: 0 });
  for (const event of recorded.events) {
    const launch = event.background_started;
    if (launch !== undefined) ledger.observeStarted("owned-run-1", launch);
    const members = event.background_members;
    if (members !== undefined) ledger.replaceFullRootMembers("owned-run-1", members);
    progression.push(ledger.counts());
  }
  assert.deepEqual(progression, [
    { tasks: 0, shells: 1 },
    { tasks: 1, shells: 1 },
    { tasks: 1, shells: 1 },
    { tasks: 1, shells: 1 },
    { tasks: 2, shells: 1 },
    { tasks: 0, shells: 0 },
  ]);
  assert.equal(ledger.counts() === null, false);
  assert.equal(ledger.snapshot().membershipKnown, true);
});

test("the membership and launch projections do not change the Codex projection", async () => {
  const broker = await makeBroker();
  const recorded = recordingNative();
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "codex", recorded.handlers);

  const outcome = await runRelay(registration.bootstrap, {
    hook_event_name: "PostToolUse",
    session_id: "session-codex",
    tool_name: "bash",
    tool_use_id: "call-1",
    // A Claude-shaped result field on a Codex run is not a Codex launch witness.
    tool_response: { backgroundTaskId: "b8k3n1p4q" },
  });
  assert.equal(outcome.status, "accepted");
  // A Codex Stop keeps its pre-existing shape: the counts projection it already
  // had, and none of the new Claude-only membership field — not even `[]`.
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "Stop",
    session_id: "session-codex",
    background_tasks: [
      { id: "b8k3n1p4q", type: "shell", status: "running", description: "SECRET" },
    ],
  })).status, "accepted");
  assert.equal((await runRelay(registration.bootstrap, {
    hook_event_name: "SubagentStop",
    session_id: "session-codex",
    agent_id: "child-1",
    background_tasks: [],
  })).status, "accepted");
  assert.deepEqual(recorded.events, [{
    backend: "codex",
    hook_event_name: "PostToolUse",
    session_id: "session-codex",
    tool_name: "bash",
    tool_use_id: "call-1",
  }, {
    backend: "codex",
    hook_event_name: "Stop",
    session_id: "session-codex",
    background_counts: { tasks: 0, shells: 1 },
  }, {
    backend: "codex",
    hook_event_name: "SubagentStop",
    session_id: "session-codex",
    agent_id: "child-1",
    background_counts: { tasks: 0, shells: 0 },
  }]);
  assert.deepEqual(recorded.failures, []);
});

// ---------------------------------------------------------------------------
// #775 census recovery through the real selection → broker → observer pipeline
// ---------------------------------------------------------------------------

/**
 * One owned Claude row's status source, composed exactly as the host composes it:
 * the production observer factory (`createNativeStatusObserver`, which wraps the
 * real acquisition controller and its membership ledger) behind a real broker
 * native-hook registration. Every provider payload below enters through the
 * exported relay runner, so it crosses the genuine selection pass
 * (`sanitizeNativeHookProviderInput`), the authenticated local socket, the broker
 * decoder, and the registered source callbacks before the observer sees it. No
 * projection state is hand-built here.
 */
interface ComposedClaudeRow {
  readonly observations: NativeStatusObservation[];
  readonly delivered: { events: number; failures: number };
  relay(input: Record<string, unknown>): ReturnType<typeof runNativeHookRelay>;
  counts(): { tasks: number | null | undefined; shells: number | null | undefined };
  dispose(): void;
}

const CENSUS_SESSION = "44444444-4444-4444-8444-444444444444";

async function composedClaudeRow(): Promise<ComposedClaudeRow> {
  const broker = await makeBroker();
  // The bound transcript is a real, already-written file inside a root this test
  // owns (removed by `afterEach`): an unbound or never-created transcript is its
  // own coverage hole, which would mask the hook-lane evidence under test.
  const transcript = path.join(makeSocketRoot(), "transcript.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "older prompt" } })}\n`, "utf8");
  const observations: NativeStatusObservation[] = [];
  const delivered = { events: 0, failures: 0 };
  const observer = createNativeStatusObserver({
    rowId: "row-census",
    backend: "claude",
    emit: (observation) => observations.push(observation),
  });
  const registration = broker.registerNativeHookSource(INSTANCE_NATIVE, "claude", {
    onEvent: (event) => {
      delivered.events += 1;
      observer.acceptHook(event);
    },
    onFailure: (failure) => {
      delivered.failures += 1;
      observer.acceptFailure(failure);
    },
  });
  // The host's own spawn baseline: a fresh owned run with no background work.
  const observeOwnedStartup = (observer as { observeOwnedStartup?: () => void }).observeOwnedStartup;
  assert.equal(typeof observeOwnedStartup, "function", "the Claude source can state the owned spawn baseline");
  observeOwnedStartup?.();
  return {
    observations,
    delivered,
    relay: (input) => runRelay(registration.bootstrap, {
      session_id: CENSUS_SESSION,
      transcript_path: transcript,
      ...input,
    }),
    counts: () => {
      const latest = observations[observations.length - 1];
      return { tasks: latest?.activeTasks, shells: latest?.activeShells };
    },
    dispose: () => {
      observer.dispose();
      registration.release();
    },
  };
}

// Synthetic provider-shaped snapshots. Ids are fixture-only; the SECRET fields
// prove that nothing but the closed projection crosses.
const KEYED_CENSUS = [
  { id: "bcensus01", type: "shell", status: "running", description: "SECRET", command: "SECRET COMMAND" },
  { id: "acensus01", type: "subagent", status: "running", description: "SECRET" },
];
const UNKEYABLE_TASK_CENSUS = [
  { id: "bcensus01", type: "shell", status: "running", description: "SECRET", command: "SECRET COMMAND" },
  // An active task the provider listed without an id: counts derive, keying does not.
  { type: "subagent", status: "running", description: "SECRET" },
];
const LATER_KEYED_CENSUS = [
  { id: "bcensus01", type: "shell", status: "running", description: "SECRET", command: "SECRET COMMAND" },
  { id: "acensus02", type: "subagent", status: "pending", description: "SECRET" },
];

async function beginCensusTurn(row: ComposedClaudeRow): Promise<void> {
  assert.equal((await row.relay({ hook_event_name: "SessionStart", source: "startup" })).delivered, "event");
  assert.equal((await row.relay({
    hook_event_name: "UserPromptSubmit",
    prompt_id: "prompt-census",
    prompt: "SECRET PROMPT",
  })).delivered, "event");
}

async function relayStop(row: ComposedClaudeRow, backgroundTasks?: unknown) {
  return row.relay({
    hook_event_name: "Stop",
    prompt_id: "prompt-census",
    last_assistant_message: "SECRET FINAL MESSAGE",
    ...(backgroundTasks === undefined ? {} : { background_tasks: backgroundTasks }),
  });
}

test("a relayed start without an agent id leaves task coverage unknown", async () => {
  const row = await composedClaudeRow();
  try {
    await beginCensusTurn(row);
    assert.equal((await row.relay({ hook_event_name: "SubagentStart", agent_id: "acensus01" })).delivered, "event");
    assert.equal((await relayStop(row, KEYED_CENSUS)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 });

    // The relay accepts a start that names no child. An execution began on this
    // run's own lane, and nobody can say whose: that agent is outside every
    // in-flight snapshot this run will ever be handed, so the task axis is withdrawn
    // even though the same keyed census still states the shell exactly.
    assert.equal((await row.relay({ hook_event_name: "SubagentStart" })).delivered, "event");
    assert.equal((await relayStop(row, KEYED_CENSUS)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: null, shells: 1 });
  } finally {
    row.dispose();
  }
});

test("#775 an unkeyable census withdraws only its category, and the first later keyed census restores it", async () => {
  const row = await composedClaudeRow();
  try {
    await beginCensusTurn(row);

    // 1. A valid keyed root census: both categories exact.
    const valid = await relayStop(row, KEYED_CENSUS);
    assert.equal(valid.delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 });

    // 2. The same moment with the task unkeyable. Selection still admits it as a
    // counts-only event naming ONLY the task category; the observer withdraws
    // tasks while the independent shell category keeps its exact number.
    const unkeyable = await relayStop(row, UNKEYABLE_TASK_CENSUS);
    assert.equal(unkeyable.delivered, "event", "an unkeyable census is admitted, not a shape rejection");
    assert.deepEqual(row.counts(), { tasks: null, shells: 1 });

    // 3. An absent census (no background_tasks at all) is neither a rejection nor
    // a recovery: it restores nothing and erases nothing the run still knows.
    const absent = await relayStop(row);
    assert.equal(absent.delivered, "event");
    assert.deepEqual(row.counts(), { tasks: null, shells: 1 });

    // 4. The VERY FIRST later keyed census restores the withdrawn category in the
    // same delivery: the observation published by that one relay is exact.
    const before = row.observations.length;
    const recovered = await relayStop(row, LATER_KEYED_CENSUS);
    assert.equal(recovered.delivered, "event");
    assert.ok(row.observations.length > before, "the recovering census publishes immediately");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 });

    // That 1/1 must be restored KEYED membership, not the counts-only totals
    // fallback the same Stop also carries: a following absent census clears the
    // totals fallback, so only a genuinely recovered census keeps both exact.
    assert.equal((await relayStop(row)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 }, "the recovery is keyed membership, not last-reported totals");
    assert.deepEqual(row.delivered, { events: 7, failures: 0 });
    assert.ok(!JSON.stringify(row.observations).includes("SECRET"), "no provider text reaches an observation");
  } finally {
    row.dispose();
  }
});

test("#775 an unkeyable shell is the mirror image: tasks stay exact, shells recover on the first keyed census", async () => {
  const row = await composedClaudeRow();
  try {
    await beginCensusTurn(row);
    assert.equal((await relayStop(row, KEYED_CENSUS)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 });
    assert.equal((await relayStop(row, [
      { type: "shell", status: "running", description: "SECRET" },
      { id: "acensus01", type: "subagent", status: "running", description: "SECRET" },
    ])).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: null });
    assert.equal((await relayStop(row, LATER_KEYED_CENSUS)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 });
    // An absent census clears the totals fallback; only keyed recovery survives it.
    assert.equal((await relayStop(row)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 }, "the recovery is keyed membership, not last-reported totals");
  } finally {
    row.dispose();
  }
});

test("#775 strict malformed, duplicate, and over-bound censuses stay closed failures, and the first later keyed census restores both categories", async () => {
  const row = await composedClaudeRow();
  try {
    await beginCensusTurn(row);
    assert.equal((await relayStop(row, KEYED_CENSUS)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 });

    const rejected: Array<[unknown, string]> = [
      // Malformed: an entry without its type is not a countable entry.
      [[{ id: "bcensus01", status: "running", description: "SECRET" }], "background-snapshot-rejected"],
      // Duplicate ids: the keyed set would silently lose a member.
      [[
        { id: "bcensus01", type: "shell", status: "running", description: "SECRET" },
        { id: "bcensus01", type: "subagent", status: "running", description: "SECRET" },
      ], "background-snapshot-rejected"],
      // Over the entry bound: never a partial count.
      [Array.from({ length: MAX_NATIVE_HOOK_BACKGROUND_TASKS + 1 }, () => ({
        status: "completed",
        backgrounded: false,
        type: "shell",
      })), "background-snapshot-rejected"],
    ];
    for (const [snapshot, reason] of rejected) {
      const outcome = await relayStop(row, snapshot);
      assert.equal(outcome.delivered, "failure", "a shape rejection is never delivered as an event");
      // The relay had already established this event as a Stop boundary before it
      // refused that boundary's own array, so the closed reason says which field
      // was refused. The array is still refused whole and nothing is delivered.
      assert.equal(outcome.failure, reason);
      // A refusal names no category, so the WHOLE census withdraws — wider than an
      // unkeyable census, which names its own category only.
      assert.deepEqual(row.counts(), { tasks: null, shells: null });
      // The withdrawal stops at that snapshot. This observer DID see the Stop it
      // arrived on, so the independently observed foreground stays Running, the
      // question census stays known-empty, and the run's own scope admission
      // survives: only the two background counts go.
      const after = row.observations[row.observations.length - 1];
      assert.equal(after?.busy, true, "a rejected census does not erase observed Running");
      assert.equal(after?.pendingInput, false, "a rejected census cannot hide a question edge");
    }

    // An absent census after the rejections still restores nothing.
    assert.equal((await relayStop(row)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: null, shells: null });

    // The very first later keyed census restores BOTH categories, in this same
    // conversation. A refused snapshot is a known boundary loss, not a hole whose
    // event kind was never seen: the observer did see this Stop, and a Stop is
    // never the edge that makes an agent identity known, so no start could have
    // gone unobserved inside it. The counted set is still the whole set it holds,
    // so a census that keys every member states it again immediately.
    assert.equal((await relayStop(row, LATER_KEYED_CENSUS)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 }, "the first keyed census after a refused snapshot restores both axes");
    // An absent census clears the totals fallback; only keyed recovery survives it.
    assert.equal((await relayStop(row)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 }, "the recovery is keyed membership, not last-reported totals");
    // What does NOT recover this way is an untyped lane loss, whose event kind was
    // never established: that hole can hide a start, and its own regressions in the
    // acquisition suite stay the negative control for this distinction.
    assert.deepEqual(row.delivered, { events: 6, failures: 3 });
  } finally {
    row.dispose();
  }
});

test("#784 a rejected child census withdraws nothing the root observed, and that child's own close still recovers exactly", async () => {
  const row = await composedClaudeRow();
  try {
    await beginCensusTurn(row);
    assert.equal((await row.relay({ hook_event_name: "SubagentStart", agent_id: "acensus01" })).delivered, "event");
    assert.equal((await relayStop(row, KEYED_CENSUS)).delivered, "event");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 });
    const question = { agent_id: "acensus01", tool_name: "AskUserQuestion", tool_use_id: "toolu-child-784" };
    const latest = () => row.observations[row.observations.length - 1];
    assert.equal((await row.relay({ ...question, hook_event_name: "PreToolUse" })).delivered, "event");
    assert.equal(latest()?.pendingInput, true, "the child's open question is observed");

    // That child's own turn boundary arrives with a refused snapshot array. The
    // boundary is admitted as the SubagentStop it is, so the child falls back to
    // its existing unreadable-boundary semantics: it is not ended, and the root
    // census, the root shells, and the open question that array says nothing about
    // all stay exactly as they were.
    const rejected = await row.relay({
      hook_event_name: "SubagentStop",
      agent_id: "acensus01",
      background_tasks: [{ status: "running" }],
    });
    assert.equal(rejected.delivered, "failure");
    assert.equal(rejected.failure, "background-snapshot-rejected");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 }, "a child's refused array never invalidates the root census");
    assert.equal(latest()?.busy, true, "the observed foreground survives");
    assert.equal(latest()?.pendingInput, true, "the child's open question survives");

    // The refused boundary ended nothing and admitted nothing else: that request's
    // own exact close still lands, and the question census returns to known-empty.
    assert.equal((await row.relay({ ...question, hook_event_name: "PostToolUse" })).delivered, "event");
    assert.equal(latest()?.pendingInput, false, "the exact close recovers the census");
    assert.deepEqual(row.counts(), { tasks: 1, shells: 1 });
  } finally {
    row.dispose();
  }
});

test("#775 the same unkeyable census stays unavailable to automatic review while the keyed one is countable", () => {
  // The review lane selects the same provider array through its own sanitizer;
  // this only observes the existing mapping and changes neither lane.
  const reviewState = (backgroundTasks: unknown) => {
    const selected = sanitizeNativeReviewProviderInput({
      hook_event_name: "Stop",
      session_id: CENSUS_SESSION,
      background_tasks: backgroundTasks,
    });
    if (!selected.ok) return { rejected: selected.reason };
    return nativeReviewLaneBackgroundState("claude", { backend: "claude", ...selected.selection });
  };
  assert.equal((reviewState(UNKEYABLE_TASK_CENSUS) as { state?: string }).state, "unknown",
    "an unkeyable member never becomes a shortened or idle review census");
  assert.deepEqual(reviewState(KEYED_CENSUS), { state: "running", count: 2 });
  assert.deepEqual(reviewState(LATER_KEYED_CENSUS), { state: "running", count: 2 });
  assert.deepEqual(reviewState([
    { id: "bcensus01", type: "shell", status: "running" },
    { id: "bcensus01", type: "subagent", status: "running" },
  ]), { rejected: "input-invalid" }, "the review lane's duplicate rejection is unchanged");
  // The array shapes the hook lane reports as a refused snapshot are refused here
  // too, by the review lane's own independent pass: confining what the hook
  // OBSERVER withdraws never widened what automatic review will accept.
  for (const [refused, closed] of [
    [[{ id: "bcensus01", status: "running", description: "SECRET" }], "input-invalid"],
    [Array.from({ length: MAX_NATIVE_HOOK_BACKGROUND_TASKS + 1 }, () => ({
      status: "completed",
      backgrounded: false,
      type: "shell",
    })), "input-too-large"],
  ] as [unknown[], string][]) {
    assert.deepEqual(reviewState(refused), { rejected: closed },
      "automatic review still refuses the same array whole");
  }
});
