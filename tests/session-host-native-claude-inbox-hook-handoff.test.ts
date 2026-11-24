/**
 * #682: native Claude inbox announcement handoff through the existing
 * authenticated native hook lane.
 *
 * The relay selects the announcement from its own hook environment with the
 * landed helper, attaches it to the one authenticated frame it already sends,
 * and the real local status broker hands only the opaque candidate to the
 * registration's optional owner callback after authentication. All values are
 * synthetic, non-secret fixtures; the announced inbox socket is never connected.
 * No provider CLI, account, configuration, or production callback is involved.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Readable } from "node:stream";
import { inspect } from "node:util";
import test, { afterEach } from "node:test";

import {
  __test as brokerTest,
  createStatusBroker,
  type NativeHookSourceHandlers,
  type NativeHookStatusBroker,
} from "../src/session-host/broker";
import {
  CLAUDE_INBOX_SOCKET_ENV,
  CLAUDE_INBOX_TOKEN_ENV,
  readClaudeInboxAnnouncement,
  type ClaudeInboxAnnouncementCandidate,
} from "../src/session-host/native-claude-inbox-announcement";
import { CLAUDE_INBOX_MAX_HOOK_TOKEN_BYTES, CLAUDE_INBOX_PROVABLE_PLATFORMS } from "../src/session-host/native-claude-inbox-delivery";
import {
  MAX_NATIVE_HOOK_FRAME_BYTES,
  NATIVE_HOOK_BOOTSTRAP_ENV,
  decodeNativeHookAck,
  decodeNativeHookFrame,
  readNativeHookClaudeInboxAttachment,
  type NativeHookAckFrame,
  type NativeHookBootstrap,
  type NativeHookEvent,
  type NativeHookFailure,
} from "../src/session-host/native-hook-protocol";
import { runNativeHookRelay, type NativeHookRelayOutcome } from "../src/session-host/native-hook-relay";

const INSTANCE = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "0f6b3c9e-1d2a-4b5c-8d7e-9f0a1b2c3d4e";
const INBOX_SOCKET = "/tmp/claude-1000/messaging-fixture.sock";
const INBOX_TOKEN = "fixture-hook-token-not-a-secret";
const ANNOUNCED_ENV = Object.freeze({ [CLAUDE_INBOX_SOCKET_ENV]: INBOX_SOCKET, [CLAUDE_INBOX_TOKEN_ENV]: INBOX_TOKEN });
const ATTACHMENT = "claude_inbox_announcement";
// #682: the candidate is selected on Linux and macOS (the host proves the endpoint later).
const ANNOUNCING_PLATFORM = CLAUDE_INBOX_PROVABLE_PLATFORMS.includes(process.platform) ? false : "the inbox announcement is selected on Linux and macOS only";

// Keep every real broker socket inode under the (owned) working directory and
// express only an over-long bind/connect address relatively, as the existing
// native hook suite does.
function shortAddress(address: string): string {
  const relative = path.relative(process.cwd(), address);
  if (path.isAbsolute(address) && relative && !relative.startsWith("..") && Buffer.byteLength(address, "utf8") > 100) {
    return `./${relative}`;
  }
  return address;
}
function shortArgument(value: unknown): unknown {
  if (typeof value === "string") return shortAddress(value);
  if (Array.isArray(value) && value.length > 0) {
    value[0] = shortArgument(value[0]);
    return value;
  }
  if (value && typeof value === "object" && typeof (value as { path?: unknown }).path === "string") {
    return { ...(value as object), path: shortAddress((value as { path: string }).path) };
  }
  return value;
}
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]): net.Server {
  args[0] = shortArgument(args[0]);
  return Reflect.apply(originalListen, this, args) as net.Server;
} as typeof net.Server.prototype.listen;
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  args[0] = shortArgument(args[0]);
  return Reflect.apply(originalConnect, this, args) as net.Socket;
} as typeof net.Socket.prototype.connect;

const brokers = new Set<NativeHookStatusBroker>();
const roots = new Set<string>();

async function makeBroker(): Promise<NativeHookStatusBroker> {
  brokerTest.setSocketPathLimitForTests(4096);
  const root = fs.mkdtempSync(path.join(process.cwd(), ".prg-inbox-hk-"));
  roots.add(root);
  const broker = await createStatusBroker({ socketRoot: root });
  brokers.add(broker);
  return broker;
}

afterEach(async () => {
  brokerTest.setSocketPathLimitForTests(undefined);
  for (const broker of brokers) {
    try {
      await broker.dispose();
    } catch {
      // Cleanup never masks a test assertion.
    }
  }
  brokers.clear();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

interface Recorded {
  readonly order: string[];
  readonly events: NativeHookEvent[];
  readonly failures: NativeHookFailure[];
  readonly candidates: ClaudeInboxAnnouncementCandidate[];
  readonly handlers: NativeHookSourceHandlers;
}

function recording(options: { announce?: boolean } = {}): Recorded {
  const recorded: Recorded = {
    order: [],
    events: [],
    failures: [],
    candidates: [],
    handlers: {
      onEvent: (event) => {
        recorded.order.push("event");
        recorded.events.push(event);
      },
      onFailure: (failure) => {
        recorded.order.push("failure");
        recorded.failures.push(failure);
      },
    },
  };
  if (options.announce !== false) {
    (recorded.handlers as { onClaudeInboxAnnouncement?: (candidate: ClaudeInboxAnnouncementCandidate) => void })
      .onClaudeInboxAnnouncement = (candidate) => {
        recorded.order.push("announcement");
        recorded.candidates.push(candidate);
      };
  }
  return recorded;
}

const ROOT_START = Object.freeze({
  hook_event_name: "SessionStart",
  session_id: SESSION_ID,
  source: "startup",
  model: "fixture-model-label",
});

/** Runs the real relay and captures the exact bytes it wrote to the local socket. */
async function relay(
  bootstrap: NativeHookBootstrap,
  input: unknown,
  env: NodeJS.ProcessEnv,
): Promise<{ outcome: NativeHookRelayOutcome; wire: string }> {
  const written: string[] = [];
  const outcome = await runNativeHookRelay({
    env: { ...env, [NATIVE_HOOK_BOOTSTRAP_ENV]: JSON.stringify(bootstrap) },
    stdin: Readable.from([Buffer.from(JSON.stringify(input), "utf8")]),
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
  return { outcome, wire: written.join("") };
}

/** Sends one raw line and returns the decoded fixed ACK, or undefined on a silent close. */
async function sendRaw(socketPath: string, frame: Record<string, unknown>): Promise<NativeHookAckFrame | undefined> {
  const socket = net.connect({ path: socketPath });
  socket.on("error", () => undefined);
  return new Promise((resolve) => {
    let raw = "";
    let settled = false;
    const finish = (ack: NativeHookAckFrame | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ack);
    };
    const timer = setTimeout(() => finish(undefined), 4000);
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      const newline = raw.indexOf("\n");
      if (newline !== -1) finish(decodeNativeHookAck(raw.slice(0, newline)));
    });
    socket.once("close", () => finish(undefined));
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
  });
}

function authFields(bootstrap: NativeHookBootstrap): Record<string, unknown> {
  return {
    version: 1,
    type: "native_hook_event",
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    backend: bootstrap.backend,
    token: bootstrap.token,
  };
}

function assertRedacted(rendered: string, label: string): void {
  assert.equal(rendered.includes(INBOX_TOKEN), false, `${label}: no hook token`);
  assert.equal(rendered.includes(INBOX_SOCKET), false, `${label}: no inbox socket path`);
}

test("a relayed Claude root SessionStart hands one exact candidate to the owner only after the ordinary event", { skip: ANNOUNCING_PLATFORM }, async () => {
  const broker = await makeBroker();
  const recorded = recording();
  const registration = broker.registerNativeHookSource(INSTANCE, "claude", recorded.handlers);
  const { outcome, wire } = await relay(registration.bootstrap, ROOT_START, { ...ANNOUNCED_ENV, UNRELATED: "x" });

  assert.deepEqual(outcome, { status: "accepted", delivered: "event" });
  assertRedacted(JSON.stringify(outcome), "relay outcome");
  // The ordinary event is byte-for-byte the pre-existing projection.
  assert.deepEqual(recorded.events, [{
    backend: "claude",
    hook_event_name: "SessionStart",
    session_id: SESSION_ID,
    source: "startup",
  }]);
  assert.deepEqual(recorded.failures, []);
  assert.deepEqual(recorded.order, ["event", "announcement"]);
  assert.equal(recorded.candidates.length, 1);
  const candidate = recorded.candidates[0]!;
  assert.deepEqual(readClaudeInboxAnnouncement(candidate), {
    sessionId: SESSION_ID,
    socketPath: INBOX_SOCKET,
    hookToken: INBOX_TOKEN,
  });
  for (const [label, rendered] of [
    ["events", JSON.stringify(recorded.events)],
    ["event inspect", inspect(recorded.events, { showHidden: true, depth: 8 })],
    ["candidate json", JSON.stringify({ candidate })],
    ["candidate inspect", inspect(candidate, { showHidden: true, customInspect: false, depth: 8 })],
    ["candidate string", String(candidate)],
  ] as const) {
    assertRedacted(rendered, label);
  }
  // The values ride only inside the one authenticated frame, within the
  // unchanged bound and with no other unexpected field.
  const lines = wire.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(`${lines[0]}\n`, "utf8") <= MAX_NATIVE_HOOK_FRAME_BYTES);
  const frame = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual(frame[ATTACHMENT], { socket_path: INBOX_SOCKET, hook_token: INBOX_TOKEN });
  assert.equal(frame.model, undefined);
  registration.release();
});

test("the decoder keeps the attachment out of the rebuilt frame and the callback event", () => {
  const bootstrap: NativeHookBootstrap = {
    version: 1,
    socketPath: "/tmp/prg-fixture/broker.sock",
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    instanceId: INSTANCE,
    backend: "claude",
    token: "a".repeat(64),
  };
  const decoded = decodeNativeHookFrame(JSON.stringify({
    ...authFields(bootstrap),
    hook_event_name: "SessionStart",
    session_id: SESSION_ID,
    [ATTACHMENT]: { socket_path: INBOX_SOCKET, hook_token: INBOX_TOKEN },
  }));
  assert.ok(decoded && decoded.kind === "event");
  assert.equal(Object.prototype.hasOwnProperty.call(decoded.frame, ATTACHMENT), false);
  assert.equal(Object.prototype.hasOwnProperty.call(decoded.event, ATTACHMENT), false);
  assertRedacted(JSON.stringify(decoded), "decoded frame");
  assertRedacted(inspect(decoded, { showHidden: true, depth: 8 }), "decoded inspect");
  assert.deepEqual(Object.keys(decoded).sort(), ["event", "frame", "kind"]);
  // Only the broker-side accessor reveals the shape-checked values.
  assert.deepEqual(readNativeHookClaudeInboxAttachment(decoded), {
    socket_path: INBOX_SOCKET,
    hook_token: INBOX_TOKEN,
  });
  const plain = decodeNativeHookFrame(JSON.stringify({
    ...authFields(bootstrap),
    hook_event_name: "SessionStart",
    session_id: SESSION_ID,
  }));
  assert.ok(plain);
  assert.equal(readNativeHookClaudeInboxAttachment(plain), undefined);
  // A malformed attachment shape never costs the ordinary event: the base frame
  // still decodes exactly, and nothing is stored for the broker to read.
  for (const malformed of [
    "not-an-object",
    null,
    [INBOX_SOCKET, INBOX_TOKEN],
    { socket_path: INBOX_SOCKET },
    { socket_path: INBOX_SOCKET, hook_token: INBOX_TOKEN, session_id: SESSION_ID },
    { socket_path: INBOX_SOCKET, hook_token: 7 },
  ]) {
    const ignored = decodeNativeHookFrame(JSON.stringify({
      ...authFields(bootstrap),
      hook_event_name: "SessionStart",
      session_id: SESSION_ID,
      [ATTACHMENT]: malformed,
    }));
    assert.ok(ignored && ignored.kind === "event", JSON.stringify(malformed));
    assert.deepEqual(ignored.event, { backend: "claude", hook_event_name: "SessionStart", session_id: SESSION_ID });
    assert.equal(readNativeHookClaudeInboxAttachment(ignored), undefined, JSON.stringify(malformed));
  }
  // The base event keeps its strict validation regardless of the attachment.
  assert.equal(decodeNativeHookFrame(JSON.stringify({
    ...authFields(bootstrap),
    hook_event_name: "SessionStart",
    session_id: SESSION_ID,
    unexpected_field: true,
    [ATTACHMENT]: { socket_path: INBOX_SOCKET, hook_token: INBOX_TOKEN },
  })), undefined);
});

test("an authenticated frame with a malformed attachment keeps its ordinary event and yields no candidate", async () => {
  const broker = await makeBroker();
  const recorded = recording();
  const registration = broker.registerNativeHookSource(INSTANCE, "claude", recorded.handlers);
  for (const malformed of [
    "not-an-object",
    { socket_path: INBOX_SOCKET },
    { socket_path: INBOX_SOCKET, hook_token: INBOX_TOKEN, extra: "x" },
  ]) {
    const ack = await sendRaw(broker.socketPath, {
      ...authFields(registration.bootstrap),
      hook_event_name: "SessionStart",
      session_id: SESSION_ID,
      [ATTACHMENT]: malformed,
    });
    assert.deepEqual(ack, { version: 1, type: "native_hook_ack", accepted: true }, JSON.stringify(malformed));
  }
  assert.equal(recorded.events.length, 3);
  for (const event of recorded.events) {
    assert.deepEqual(event, { backend: "claude", hook_event_name: "SessionStart", session_id: SESSION_ID });
  }
  assert.deepEqual(recorded.candidates, []);
  assert.deepEqual(recorded.failures, []);
});

test("an onEvent handler that mutates its event cannot rebind or rescope the candidate", { skip: ANNOUNCING_PLATFORM }, async () => {
  const broker = await makeBroker();
  const OTHER_SESSION = "11111111-2222-4333-8444-555555555555";
  const candidates: ClaudeInboxAnnouncementCandidate[] = [];
  const registration = broker.registerNativeHookSource(INSTANCE, "claude", {
    onEvent: (event) => {
      const mutable = event as unknown as Record<string, unknown>;
      if (mutable.agent_id === undefined) mutable.session_id = OTHER_SESSION;
      else delete mutable.agent_id;
    },
    onFailure: () => undefined,
    onClaudeInboxAnnouncement: (candidate) => candidates.push(candidate),
  });
  const attachment = { [ATTACHMENT]: { socket_path: INBOX_SOCKET, hook_token: INBOX_TOKEN } };
  // A root SessionStart whose event is rewritten to another session id.
  await sendRaw(broker.socketPath, {
    ...authFields(registration.bootstrap), hook_event_name: "SessionStart", session_id: SESSION_ID, ...attachment,
  });
  // A child SessionStart whose event has its agent_id removed.
  await sendRaw(broker.socketPath, {
    ...authFields(registration.bootstrap),
    hook_event_name: "SessionStart",
    session_id: OTHER_SESSION,
    agent_id: "agent-1",
    ...attachment,
  });
  assert.equal(candidates.length, 1);
  assert.deepEqual(readClaudeInboxAnnouncement(candidates[0]!), {
    sessionId: SESSION_ID,
    socketPath: INBOX_SOCKET,
    hookToken: INBOX_TOKEN,
  });
});

test("the owner callback is bound once at registration and cannot be redirected later", { skip: ANNOUNCING_PLATFORM }, async () => {
  const broker = await makeBroker();
  const registered: ClaudeInboxAnnouncementCandidate[] = [];
  const intruder: ClaudeInboxAnnouncementCandidate[] = [];
  const handlers: NativeHookSourceHandlers = {
    onEvent: () => {
      // Replacement during onEvent is ignored too.
      handlers.onClaudeInboxAnnouncement = (candidate) => intruder.push(candidate);
    },
    onFailure: () => undefined,
    onClaudeInboxAnnouncement: (candidate) => registered.push(candidate),
  };
  const registration = broker.registerNativeHookSource(INSTANCE, "claude", handlers);
  let result = await relay(registration.bootstrap, ROOT_START, ANNOUNCED_ENV);
  assert.deepEqual(result.outcome, { status: "accepted", delivered: "event" });
  // A throwing getter installed after registration is never consulted.
  Object.defineProperty(handlers, "onClaudeInboxAnnouncement", {
    configurable: true,
    get: () => {
      throw new Error("getter intentionally threw");
    },
  });
  handlers.onEvent = () => undefined;
  result = await relay(registration.bootstrap, ROOT_START, ANNOUNCED_ENV);
  assert.deepEqual(result.outcome, { status: "accepted", delivered: "event" });
  assert.equal(registered.length, 2);
  assert.deepEqual(intruder, []);
});

test("absent, invalid, child-scope, non-root, and Codex cases never attach and never suppress the event", async () => {
  const cases: readonly {
    label: string;
    backend: "claude" | "codex";
    input: Record<string, unknown>;
    env: NodeJS.ProcessEnv;
    event: Record<string, unknown>;
  }[] = [
    { label: "absent", backend: "claude", input: ROOT_START, env: {},
      event: { hook_event_name: "SessionStart", session_id: SESSION_ID, source: "startup" } },
    { label: "token only", backend: "claude", input: ROOT_START, env: { [CLAUDE_INBOX_TOKEN_ENV]: INBOX_TOKEN },
      event: { hook_event_name: "SessionStart", session_id: SESSION_ID, source: "startup" } },
    { label: "relative socket", backend: "claude", input: ROOT_START,
      env: { [CLAUDE_INBOX_SOCKET_ENV]: "tmp/inbox.sock", [CLAUDE_INBOX_TOKEN_ENV]: INBOX_TOKEN },
      event: { hook_event_name: "SessionStart", session_id: SESSION_ID, source: "startup" } },
    { label: "empty token", backend: "claude", input: ROOT_START,
      env: { [CLAUDE_INBOX_SOCKET_ENV]: INBOX_SOCKET, [CLAUDE_INBOX_TOKEN_ENV]: "" },
      event: { hook_event_name: "SessionStart", session_id: SESSION_ID, source: "startup" } },
    { label: "non-conversation session id", backend: "claude",
      input: { hook_event_name: "SessionStart", session_id: "session-1" }, env: ANNOUNCED_ENV,
      event: { hook_event_name: "SessionStart", session_id: "session-1" } },
    { label: "child scope", backend: "claude",
      input: { hook_event_name: "SessionStart", session_id: SESSION_ID, agent_id: "agent-1" }, env: ANNOUNCED_ENV,
      event: { hook_event_name: "SessionStart", session_id: SESSION_ID, agent_id: "agent-1" } },
    { label: "other event", backend: "claude",
      input: { hook_event_name: "UserPromptSubmit", session_id: SESSION_ID, prompt: "fixture prompt" }, env: ANNOUNCED_ENV,
      event: { hook_event_name: "UserPromptSubmit", session_id: SESSION_ID } },
    { label: "codex source", backend: "codex", input: ROOT_START, env: ANNOUNCED_ENV,
      event: { hook_event_name: "SessionStart", session_id: SESSION_ID, source: "startup" } },
  ];
  for (const entry of cases) {
    const broker = await makeBroker();
    const recorded = recording();
    const registration = broker.registerNativeHookSource(INSTANCE, entry.backend, recorded.handlers);
    const { outcome, wire } = await relay(registration.bootstrap, entry.input, entry.env);
    assert.deepEqual(outcome, { status: "accepted", delivered: "event" }, entry.label);
    assert.equal(wire.includes(ATTACHMENT), false, `${entry.label}: nothing attached`);
    assertRedacted(wire, entry.label);
    assert.deepEqual(recorded.events, [{ backend: entry.backend, ...entry.event }], entry.label);
    assert.deepEqual(recorded.candidates, [], entry.label);
    assert.deepEqual(recorded.failures, [], entry.label);
    registration.release();
    await broker.dispose();
  }
});

test("an announcement that would overflow the unchanged frame bound is dropped, never the event", { skip: ANNOUNCING_PLATFORM }, async () => {
  const broker = await makeBroker();
  const recorded = recording();
  const registration = broker.registerNativeHookSource(INSTANCE, "claude", recorded.handlers);
  // Valid by the sender's own token rule, but too large for the existing frame.
  const largeToken = "t".repeat(CLAUDE_INBOX_MAX_HOOK_TOKEN_BYTES);
  const { outcome, wire } = await relay(registration.bootstrap, ROOT_START, {
    [CLAUDE_INBOX_SOCKET_ENV]: INBOX_SOCKET,
    [CLAUDE_INBOX_TOKEN_ENV]: largeToken,
  });
  assert.deepEqual(outcome, { status: "accepted", delivered: "event" });
  assert.equal(wire.includes(ATTACHMENT), false);
  assert.equal(wire.includes(largeToken), false);
  assert.ok(Buffer.byteLength(wire, "utf8") <= MAX_NATIVE_HOOK_FRAME_BYTES);
  assert.deepEqual(recorded.events, [{
    backend: "claude",
    hook_event_name: "SessionStart",
    session_id: SESSION_ID,
    source: "startup",
  }]);
  assert.deepEqual(recorded.candidates, []);
  assert.deepEqual(recorded.failures, []);
});

test("only an authenticated frame reaches the owner; scope is rechecked after authentication", { skip: ANNOUNCING_PLATFORM }, async () => {
  const broker = await makeBroker();
  const recorded = recording();
  const registration = broker.registerNativeHookSource(INSTANCE, "claude", recorded.handlers);
  const bootstrap = registration.bootstrap;
  const attachment = { [ATTACHMENT]: { socket_path: INBOX_SOCKET, hook_token: INBOX_TOKEN } };
  const rootStart = { hook_event_name: "SessionStart", session_id: SESSION_ID };

  // Wrong token, stale generation, wrong backend, unknown instance: silent close, nothing observed.
  for (const overrides of [
    { token: "b".repeat(64) },
    { generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { backend: "codex" },
    { instanceId: "99999999-9999-4999-8999-999999999999" },
  ]) {
    const ack = await sendRaw(broker.socketPath, { ...authFields(bootstrap), ...overrides, ...rootStart, ...attachment });
    assert.equal(ack, undefined, JSON.stringify(overrides));
  }
  assert.deepEqual(recorded.order, []);

  // Authenticated, but outside root SessionStart scope: the event is delivered,
  // the attachment is never handed to the owner.
  for (const metadata of [
    { hook_event_name: "SessionStart", session_id: SESSION_ID, agent_id: "agent-1" },
    { hook_event_name: "UserPromptSubmit", session_id: SESSION_ID },
    { hook_event_name: "SessionStart", session_id: "session-1" },
  ]) {
    const ack = await sendRaw(broker.socketPath, { ...authFields(bootstrap), ...metadata, ...attachment });
    assert.deepEqual(ack, { version: 1, type: "native_hook_ack", accepted: true }, JSON.stringify(metadata));
  }
  // Authenticated root SessionStart, but invalid announced values.
  for (const invalid of [
    { socket_path: "relative.sock", hook_token: INBOX_TOKEN },
    { socket_path: INBOX_SOCKET, hook_token: "" },
  ]) {
    const ack = await sendRaw(broker.socketPath, { ...authFields(bootstrap), ...rootStart, [ATTACHMENT]: invalid });
    assert.deepEqual(ack, { version: 1, type: "native_hook_ack", accepted: true });
  }
  assert.equal(recorded.events.length, 5);
  assert.deepEqual(recorded.candidates, []);

  // The exact authenticated root SessionStart is handed off once.
  const ack = await sendRaw(broker.socketPath, { ...authFields(bootstrap), ...rootStart, ...attachment });
  assert.deepEqual(ack, { version: 1, type: "native_hook_ack", accepted: true });
  assert.equal(recorded.candidates.length, 1);
  assert.deepEqual(readClaudeInboxAnnouncement(recorded.candidates[0]!), {
    sessionId: SESSION_ID,
    socketPath: INBOX_SOCKET,
    hookToken: INBOX_TOKEN,
  });
  assertRedacted(JSON.stringify(recorded.events), "events");
  assert.deepEqual(recorded.failures, []);
});

test("a Codex registration never receives a candidate even for an authenticated attached frame", async () => {
  const broker = await makeBroker();
  const recorded = recording();
  const registration = broker.registerNativeHookSource(INSTANCE, "codex", recorded.handlers);
  const ack = await sendRaw(broker.socketPath, {
    ...authFields(registration.bootstrap),
    hook_event_name: "SessionStart",
    session_id: SESSION_ID,
    [ATTACHMENT]: { socket_path: INBOX_SOCKET, hook_token: INBOX_TOKEN },
  });
  assert.deepEqual(ack, { version: 1, type: "native_hook_ack", accepted: true });
  assert.deepEqual(recorded.events, [{ backend: "codex", hook_event_name: "SessionStart", session_id: SESSION_ID }]);
  assert.deepEqual(recorded.candidates, []);
});

test("the owner callback is optional, validated, contained, and skipped after release", { skip: ANNOUNCING_PLATFORM }, async () => {
  const broker = await makeBroker();
  assert.throws(() => broker.registerNativeHookSource(INSTANCE, "claude", {
    onEvent: () => undefined,
    onFailure: () => undefined,
    onClaudeInboxAnnouncement: "not-a-function" as unknown as () => void,
  }), /inbox announcement callback must be a function/);

  // Without the optional callback, the ordinary event and ACK are unchanged.
  const plain = recording({ announce: false });
  let registration = broker.registerNativeHookSource(INSTANCE, "claude", plain.handlers);
  let result = await relay(registration.bootstrap, ROOT_START, ANNOUNCED_ENV);
  assert.deepEqual(result.outcome, { status: "accepted", delivered: "event" });
  assert.deepEqual(plain.order, ["event"]);
  registration.release();

  // A throwing owner is contained; the event and fixed ACK are unaffected.
  const throwing = recording();
  const originalOwner = throwing.handlers.onClaudeInboxAnnouncement!;
  (throwing.handlers as { onClaudeInboxAnnouncement?: unknown }).onClaudeInboxAnnouncement = (
    candidate: ClaudeInboxAnnouncementCandidate,
  ) => {
    originalOwner(candidate);
    throw new Error("owner intentionally threw");
  };
  registration = broker.registerNativeHookSource(INSTANCE, "claude", throwing.handlers);
  result = await relay(registration.bootstrap, ROOT_START, ANNOUNCED_ENV);
  assert.deepEqual(result.outcome, { status: "accepted", delivered: "event" });
  assert.deepEqual(throwing.order, ["event", "announcement"]);
  registration.release();

  // A rejected async owner is also contained without changing the ACK; the
  // test runner reports any unhandled rejection as a failure.
  const rejecting = recording();
  const recordRejecting = rejecting.handlers.onClaudeInboxAnnouncement!;
  registration = broker.registerNativeHookSource(INSTANCE, "claude", {
    ...rejecting.handlers,
    onClaudeInboxAnnouncement: async (candidate) => {
      recordRejecting(candidate);
      await Promise.resolve();
      throw new Error(`async owner intentionally rejected ${INBOX_SOCKET}`);
    },
  });
  result = await relay(registration.bootstrap, ROOT_START, ANNOUNCED_ENV);
  assert.deepEqual(result.outcome, { status: "accepted", delivered: "event" });
  assert.deepEqual(rejecting.order, ["event", "announcement"]);
  await new Promise((resolve) => setImmediate(resolve));
  registration.release();

  // A release inside onEvent drops the candidate.
  const releasing = recording();
  const record = releasing.handlers.onEvent;
  registration = broker.registerNativeHookSource(INSTANCE, "claude", {
    ...releasing.handlers,
    onEvent: (event) => {
      record(event);
      registration.release();
    },
  });
  await relay(registration.bootstrap, ROOT_START, ANNOUNCED_ENV);
  assert.deepEqual(releasing.order, ["event"]);
  assert.deepEqual(releasing.candidates, []);
});
