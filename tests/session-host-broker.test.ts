/**
 * Focused real-socket tests for the authenticated bounded local status broker
 * (src/session-host/broker.ts, issue #323).
 *
 * These tests exercise real local net server/client Unix sockets against the
 * candidate broker together with the shared session-host protocol contract
 * (src/session-host/protocol module). These tests are focused broker checks;
 * they do not claim completion of native-host integration.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach } from "node:test";
import { __test as brokerTest, createStatusBroker as createStatusBrokerImpl, type StatusBroker, type StatusBrokerOptions } from "../src/session-host/broker";
import {
  type SessionHostBootstrap,
  type SessionHostNativeSession,
  type SessionHostStatus,
  MAX_STATUS_FRAME_BYTES,
  decodeFrame,
  parseBootstrap,
} from "../src/session-host/protocol";

const INSTANCE_A = "11111111-1111-4111-8111-111111111111";
const INSTANCE_B = "22222222-2222-4222-8222-222222222222";
const INSTANCE_C = "33333333-3333-4333-8333-333333333333";

const SOCKET_CLOSE_DEADLINE_MS = 4000;
const ALLOWED_REJECTION_ERROR_CODES = ["EPIPE", "ECONNRESET"] as const;

interface TrackedClient {
  errors: Error[];
  expectedErrors: Set<Error>;
  errorWaiters: Set<(error: Error) => void>;
  closeWaiters: Set<(hadError: boolean) => void>;
  closePromise: Promise<void>;
  resolveClose: () => void;
  closed: boolean;
  closedWithError: boolean;
  cleanupStarted: boolean;
}

const clients = new Map<net.Socket, TrackedClient>();
const brokers = new Set<StatusBroker>();
const replacementServers = new Set<net.Server>();
const replacementServerErrors = new Map<net.Server, Error[]>();
const replacementServerCleanupStarted = new Set<net.Server>();
interface OwnedEntryIdentity { dev: number; ino: number; }
const ownedFiles = new Map<string, OwnedEntryIdentity>();
const ownedDirectories = new Map<string, OwnedEntryIdentity>();

function trackClient(socket: net.Socket): net.Socket {
  let resolveClose!: () => void;
  const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
  const state: TrackedClient = {
    errors: [],
    expectedErrors: new Set(),
    errorWaiters: new Set(),
    closeWaiters: new Set(),
    closePromise,
    resolveClose,
    closed: false,
    closedWithError: false,
    cleanupStarted: false,
  };
  clients.set(socket, state);
  socket.on("error", (error: Error) => {
    if (!state.cleanupStarted) state.errors.push(error);
    for (const waiter of [...state.errorWaiters]) waiter(error);
  });
  socket.on("close", (hadError: boolean) => {
    state.closed = true;
    state.closedWithError = hadError;
    state.resolveClose();
    for (const waiter of [...state.closeWaiters]) waiter(hadError);
  });
  return socket;
}

function expectClientClose(
  socket: net.Socket,
  write?: () => void,
  allowedErrorCodes: readonly string[] = [],
  timeoutMs = SOCKET_CLOSE_DEADLINE_MS,
): Promise<void> {
  const state = clients.get(socket);
  if (!state) throw new Error("test helper: socket was not registered for cleanup");
  const allowed = new Set(allowedErrorCodes);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      state.errorWaiters.delete(onError);
      state.closeWaiters.delete(onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && allowed.has(code)) {
        state.expectedErrors.add(error);
        return;
      }
      finish(new Error(`test helper: unexpected socket error ${code ?? "unknown"}`, { cause: error }));
    };
    const onClose = (hadError: boolean) => {
      if (hadError && state.expectedErrors.size === 0) {
        finish(new Error("test helper: socket closed with an unclassified error"));
      } else {
        finish();
      }
    };
    state.errorWaiters.add(onError);
    state.closeWaiters.add(onClose);
    for (const error of state.errors) {
      if (!state.expectedErrors.has(error)) onError(error);
      if (settled) return;
    }
    if (state.closed) {
      if (write) finish(new Error("test helper: socket closed before the expected write"));
      else if (state.closedWithError && state.expectedErrors.size === 0) {
        finish(new Error("test helper: socket closed with an unclassified error"));
      } else finish();
      return;
    }
    timer = setTimeout(() => finish(new Error("test helper: socket did not close before its deadline")), timeoutMs);
    if (write) {
      try {
        write();
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code && allowed.has(code) && error instanceof Error) state.expectedErrors.add(error);
        else finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}

function expectBrokerRejection(socket: net.Socket, write: () => void): Promise<void> {
  return expectClientClose(socket, write, ALLOWED_REJECTION_ERROR_CODES);
}

function ownFile(file: string): string {
  const stats = fs.lstatSync(file);
  if (stats.isDirectory()) throw new Error(`test fixture expected an owned file: ${file}`);
  ownedFiles.set(file, { dev: stats.dev, ino: stats.ino });
  return file;
}

function ownDirectory(directory: string): string {
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory()) throw new Error(`test fixture expected an owned directory: ${directory}`);
  ownedDirectories.set(directory, { dev: stats.dev, ino: stats.ino });
  return directory;
}

function trackReplacementServer(server: net.Server): net.Server {
  replacementServers.add(server);
  replacementServerErrors.set(server, []);
  server.on("error", (error: Error) => {
    if (!replacementServerCleanupStarted.has(server)) replacementServerErrors.get(server)?.push(error);
  });
  return server;
}

async function createStatusBroker(options?: StatusBrokerOptions): Promise<StatusBroker> {
  const broker = await createStatusBrokerImpl(options);
  brokers.add(broker);
  ownDirectory(path.dirname(broker.socketPath));
  ownFile(broker.socketPath);
  return broker;
}

async function withDeadline<T>(promise: Promise<T>, label: string, timeoutMs = SOCKET_CLOSE_DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`test cleanup: ${label} exceeded its deadline`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(async () => {
  const unexpectedErrors = [
    ...[...clients.values()].flatMap((state) => {
      const errors = state.errors.filter((error) => !state.expectedErrors.has(error));
      if (state.closedWithError && state.expectedErrors.size === 0) {
        errors.push(new Error("client socket closed with an unclassified error"));
      }
      return errors;
    }),
    ...[...replacementServerErrors.values()].flat(),
  ];
  for (const state of clients.values()) state.cleanupStarted = true;
  for (const server of replacementServers) replacementServerCleanupStarted.add(server);

  const cleanupErrors: Error[] = [];
  for (const broker of brokers) {
    try { await withDeadline(broker.dispose(), "broker dispose"); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  for (const socket of clients.keys()) {
    if (!socket.destroyed) socket.destroy();
  }
  for (const server of replacementServers) {
    if (!server.listening) continue;
    try {
      await withDeadline(new Promise<void>((resolve, reject) => {
        try {
          server.close((error) => error ? reject(error) : resolve());
        } catch (error) {
          reject(error);
        }
      }), "replacement server close");
    } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  try {
    await withDeadline(Promise.all([...clients.values()].map((state) => state.closePromise)).then(() => undefined), "client close");
  } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }

  for (const [file, identity] of ownedFiles) {
    try {
      const stats = fs.lstatSync(file);
      if (stats.dev === identity.dev && stats.ino === identity.ino && !stats.isDirectory()) fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  for (const [directory, identity] of [...ownedDirectories].sort(([left], [right]) => right.length - left.length)) {
    try {
      const stats = fs.lstatSync(directory);
      if (stats.dev === identity.dev && stats.ino === identity.ino && stats.isDirectory()) fs.rmdirSync(directory);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  clients.clear();
  brokers.clear();
  replacementServers.clear();
  replacementServerErrors.clear();
  replacementServerCleanupStarted.clear();
  ownedFiles.clear();
  ownedDirectories.clear();
  if (unexpectedErrors.length > 0 || cleanupErrors.length > 0) {
    throw new AggregateError([...unexpectedErrors, ...cleanupErrors], "test fixture errors or cleanup failures");
  }
});

function disposeBroker(broker: StatusBroker, label = "broker dispose"): Promise<void> {
  return withDeadline(broker.dispose(), label);
}

async function listenReplacementServer(server: net.Server, socketPath: string): Promise<void> {
  const listening = once(server, "listening");
  server.listen(socketPath);
  await withDeadline(listening.then(() => undefined), "replacement server listen");
}

function statusFrame(bootstrap: SessionHostBootstrap, fields: {
  sequence: number;
  instanceId?: string;
  generation?: string;
  busy?: boolean | null;
  pendingInput?: boolean | null;
  inputSurface?: boolean;
  activity?: string[];
  nativeSession?: SessionHostNativeSession | null;
}): SessionHostStatus {
  return {
    version: 1,
    type: "status",
    instanceId: fields.instanceId ?? bootstrap.instanceId,
    generation: fields.generation ?? bootstrap.generation,
    sequence: fields.sequence,
    busy: fields.busy ?? null,
    pendingInput: fields.pendingInput ?? null,
    inputSurface: fields.inputSurface ?? false,
    activity: fields.activity ?? [],
    ...(fields.nativeSession === undefined ? {} : { nativeSession: fields.nativeSession }),
  };
}

function helloFrame(bootstrap: SessionHostBootstrap, overrides?: { instanceId?: string; generation?: string; token?: string }) {
  return {
    version: 1 as const,
    type: "hello" as const,
    instanceId: overrides?.instanceId ?? bootstrap.instanceId,
    generation: overrides?.generation ?? bootstrap.generation,
    token: overrides?.token ?? bootstrap.token,
  };
}

interface Recorded {
  statuses: SessionHostStatus[];
  disconnects: number;
  throwOnStatusOnce: boolean;
  throwOnDisconnect: boolean;
  handlers: { onStatus: (status: SessionHostStatus) => void; onDisconnect: () => void };
}

function recording(): Recorded {
  const recorded: Recorded = {
    statuses: [],
    disconnects: 0,
    throwOnStatusOnce: false,
    throwOnDisconnect: false,
    handlers: { onStatus: () => undefined, onDisconnect: () => undefined },
  };
  recorded.handlers.onStatus = (status) => {
    recorded.statuses.push(status);
    if (recorded.throwOnStatusOnce) {
      recorded.throwOnStatusOnce = false;
      throw new Error("callback intentionally threw");
    }
  };
  recorded.handlers.onDisconnect = () => {
    recorded.disconnects += 1;
    if (recorded.throwOnDisconnect) throw new Error("disconnect callback intentionally threw");
  };
  return recorded;
}

async function connectClient(socketPath: string): Promise<net.Socket> {
  const socket = trackClient(net.connect(socketPath));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("test helper: socket closed before connecting"));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
    timer = setTimeout(() => finish(new Error("test helper: socket connection timed out")), SOCKET_CLOSE_DEADLINE_MS);
  });
  return socket;
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("test helper: waitFor exceeded its deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A unique, test-owned socket root directory (name kept short for the macOS socket limit). */
function makeSocketRoot(): string {
  return ownDirectory(fs.mkdtempSync(path.join(os.tmpdir(), "prg-bt-")));
}

test("rename acknowledgement policy fences request, host generation, and current native epoch", () => {
  const expected = {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expectedSessionId: "native-one",
    expectedSessionEpoch: 7,
  };
  const ack = {
    version: 1 as const,
    type: "rename_result" as const,
    instanceId: INSTANCE_A,
    generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ...expected,
    sessionId: "native-one",
    sessionEpoch: 7,
    outcome: "renamed" as const,
    reason: "none" as const,
  };
  const current = { sessionId: "native-one", epoch: 7, name: "title" };
  assert.equal(brokerTest.classifyRenameAck(ack, expected, INSTANCE_A, ack.generation, current), "matching");
  assert.equal(brokerTest.classifyRenameAck(ack, expected, INSTANCE_A, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", current), "invalid");
  assert.equal(brokerTest.classifyRenameAck({ ...ack, expectedSessionEpoch: 8 }, expected, INSTANCE_A, ack.generation, current), "invalid");
  assert.equal(brokerTest.classifyRenameAck({ ...ack, requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, expected, INSTANCE_A, ack.generation, current), "invalid");
  assert.equal(
    brokerTest.classifyRenameAck(ack, expected, INSTANCE_A, ack.generation, { sessionId: "native-two", epoch: 8, name: "other" }),
    "stale-session",
  );
});

test("broker creates a private 0700 transport, owns its 0600 socket, and cleans up while preserving unknown files", async () => {
  const root = makeSocketRoot();
  const marker = path.join(root, "unknown-sibling-entry.txt");
  fs.writeFileSync(marker, "untouched");
  ownFile(marker);
  const broker = await createStatusBroker({ socketRoot: root });

  // The transport dir lives inside the supplied root and is private.
  const transportDir = path.dirname(broker.socketPath);
  const transportStats = fs.statSync(transportDir);
  assert.equal(transportStats.mode & 0o777, 0o700);
  const socketStats = fs.lstatSync(broker.socketPath);
  assert.equal(socketStats.isSocket(), true);
  assert.equal(socketStats.mode & 0o777, 0o600);
  // Bootstrap validates against the shared contract.
  const registration = broker.register(INSTANCE_A, recording().handlers);
  assert.deepEqual(parseBootstrap(registration.bootstrap), registration.bootstrap);
  // Unknown concurrent file inside the broker's own transport directory.
  const unknownInTransport = path.join(transportDir, "concurrent-unknown");
  fs.writeFileSync(unknownInTransport, "keep me");
  ownFile(unknownInTransport);

  await disposeBroker(broker);
  assert.equal(fs.existsSync(broker.socketPath), false, "own socket file removed");
  assert.equal(fs.existsSync(transportDir), true, "unknown transport-dir entry preserved");
  assert.equal(fs.readFileSync(unknownInTransport, "utf8"), "keep me");
  assert.equal(fs.existsSync(marker), true, "unknown sibling entry preserved");
  assert.throws(() => broker.register(INSTANCE_B, recording().handlers), /disposed/);
  await disposeBroker(broker, "idempotent broker dispose");
});

test("broker cleanup preserves a different socket inode that appears at its former path", async () => {
  const root = makeSocketRoot();
  const broker = await createStatusBroker({ socketRoot: root });
  const socketPath = broker.socketPath;
  const transportDir = path.dirname(socketPath);
  const replacement = trackReplacementServer(net.createServer());
  // Simulate a concurrent owner replacing the pathname after our socket was
  // unlinked. Cleanup must compare inode ownership, not merely socket type.
  fs.unlinkSync(socketPath);
  await listenReplacementServer(replacement, socketPath);
  ownFile(socketPath);

  await disposeBroker(broker);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true, "the replacement socket remains untouched");
  assert.equal(fs.existsSync(transportDir), true, "the directory stays while it contains the replacement");
});

test("broker cleanup preserves an unknown directory at the socket pathname", async () => {
  const root = makeSocketRoot();
  const broker = await createStatusBroker({ socketRoot: root });
  const socketPath = broker.socketPath;
  fs.unlinkSync(socketPath);
  fs.mkdirSync(socketPath);
  ownDirectory(socketPath);
  const marker = path.join(socketPath, "keep.txt");
  fs.writeFileSync(marker, "preserve directory");
  ownFile(marker);

  await disposeBroker(broker);
  assert.equal(fs.lstatSync(socketPath).isDirectory(), true);
  assert.equal(fs.readFileSync(marker, "utf8"), "preserve directory");
});

test("broker restoration never overwrites a concurrent destination", async () => {
  const root = makeSocketRoot();
  const broker = await createStatusBroker({ socketRoot: root });
  const socketPath = broker.socketPath;
  const transportDir = path.dirname(socketPath);
  const concurrentMarker = path.join(socketPath, "concurrent.txt");
  let quarantineEntry: string | undefined;
  try {
    fs.unlinkSync(socketPath);
    fs.writeFileSync(socketPath, "quarantined replacement");
    ownFile(socketPath);

    // dispose stages the replacement synchronously and leaves its directory
    // guard in place until the server's asynchronous close callback.
    const beforeTeardown = new Set(fs.readdirSync(transportDir));
    const disposing = disposeBroker(broker, "concurrent broker dispose");
    const quarantineDirs = fs.readdirSync(transportDir)
      .filter((name) => name.startsWith(".dispose-") && !beforeTeardown.has(name));
    for (const name of quarantineDirs) {
      const entry = path.join(transportDir, name, "entry");
      ownDirectory(path.dirname(entry));
      if (fs.existsSync(entry)) {
        const ownedEntry = ownFile(entry);
        if (quarantineDirs.length === 1) quarantineEntry = ownedEntry;
      }
    }
    assert.equal(quarantineDirs.length, 1, "staging created one owned quarantine directory");
    assert.equal(fs.lstatSync(socketPath).isDirectory(), true, "teardown guard is installed");
    fs.rmdirSync(socketPath);
    fs.mkdirSync(socketPath);
    ownDirectory(socketPath);
    fs.writeFileSync(concurrentMarker, "concurrent destination");
    ownFile(concurrentMarker);

    await disposing;
    assert.equal(fs.readFileSync(concurrentMarker, "utf8"), "concurrent destination");
    assert.ok(quarantineEntry, "the displaced test entry remains in its owned quarantine");
    assert.equal(
      fs.readFileSync(quarantineEntry, "utf8"),
      "quarantined replacement",
    );
  } finally {
    try { await disposeBroker(broker, "broker dispose in test finally"); } catch { /* afterEach also reports failed fixture disposal */ }
  }
});

test("broker authenticates a valid hello then delivers bounded status snapshots without extra fields", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);

  // Status before hello must be rejected.
  await expectBrokerRejection(client, () => {
    client.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 })) + "\n");
  });
  assert.equal(recorded.statuses.length, 0);
  assert.equal(recorded.disconnects, 0);

  // A fresh client with the exact bootstrap hello authenticates.
  const good = await connectClient(broker.socketPath);
  good.write(JSON.stringify({
    version: 1,
    type: "hello",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    token: registration.bootstrap.token,
  }) + "\n");
  good.write(JSON.stringify({
    ...statusFrame(registration.bootstrap, { sequence: 2 }),
    toolArgs: "never exposed to snapshot consumers",
  }) + "\n");
  await waitFor(() => recorded.statuses.length === 1);
  const status = recorded.statuses[0];
  assert.equal(status.sequence, 2);
  assert.equal(status.instanceId, INSTANCE_A);
  assert.equal(status.type, "status");
  assert.deepEqual(Object.keys(status).sort(), [
    "activity", "busy", "generation", "inputSurface", "instanceId", "pendingInput", "sequence", "type", "version",
  ], "snapshot callbacks never carry raw frames or unknown fields");
  assert.equal(recorded.disconnects, 0);
});

test("registration rename is identity-fenced, authenticated, acknowledged, and bounded", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const unavailable = await registration.rename({
    expectedSessionId: "native-one",
    expectedSessionEpoch: 1,
    name: "title",
  });
  assert.equal(unavailable.status, "unavailable", "rename cannot guess before native metadata is observed");

  const client = await connectClient(broker.socketPath);
  const outbound: Record<string, unknown>[] = [];
  let buffer = "";
  client.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      const decoded = decodeFrame(line);
      if (decoded) outbound.push(decoded as unknown as Record<string, unknown>);
    }
  });
  const nativeSession = { sessionId: "native-one", epoch: 4, name: "original title" };
  client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  client.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1, nativeSession })) + "\n");
  await waitFor(() => recorded.statuses.length === 1);

  const overLimit = await registration.rename({
    expectedSessionId: nativeSession.sessionId,
    expectedSessionEpoch: nativeSession.epoch,
    name: "x".repeat(1025),
  });
  assert.equal(overLimit.status, "invalid-name", "oversized persisted input is rejected rather than clipped");
  assert.equal(outbound.some((frame) => frame.type === "rename_request"), false, "invalid names never enter the wire queue");

  const renamedPromise = registration.rename({
    expectedSessionId: nativeSession.sessionId,
    expectedSessionEpoch: nativeSession.epoch,
    name: "persisted native title",
  });
  await waitFor(() => outbound.some((frame) => frame.type === "rename_request"));
  const request = outbound.find((frame) => frame.type === "rename_request")!;
  assert.equal(request.instanceId, INSTANCE_A);
  assert.equal(request.generation, registration.bootstrap.generation);
  assert.equal(request.token, registration.bootstrap.token, "only the authenticated command carries the capability");
  assert.equal(request.expectedSessionId, nativeSession.sessionId);
  assert.equal(request.expectedSessionEpoch, nativeSession.epoch);
  assert.equal(request.name, "persisted native title", "the full bounded name is not clipped");

  const ack = {
    version: 1,
    type: "rename_result",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    requestId: request.requestId,
    expectedSessionId: nativeSession.sessionId,
    expectedSessionEpoch: nativeSession.epoch,
    sessionId: nativeSession.sessionId,
    sessionEpoch: nativeSession.epoch,
    outcome: "renamed",
    reason: "none",
  };
  client.write(JSON.stringify(ack) + "\n");
  const result = await renamedPromise;
  assert.equal(result.status, "renamed");
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.observedSessionId, nativeSession.sessionId);
  assert.equal(result.observedSessionEpoch, nativeSession.epoch);
  assert.equal("name" in result, false, "the asynchronous result does not echo title content");
  assert.equal("token" in result, false, "the capability never reaches callback results");
});

test("rename rejects stale broker metadata and fails closed on a mismatched acknowledgement tuple", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  const outbound: Record<string, unknown>[] = [];
  let buffer = "";
  client.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      const decoded = decodeFrame(line);
      if (decoded) outbound.push(decoded as unknown as Record<string, unknown>);
    }
  });
  client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  client.write(JSON.stringify(statusFrame(registration.bootstrap, {
    sequence: 1,
    nativeSession: { sessionId: "native-one", epoch: 5, name: "title" },
  })) + "\n");
  await waitFor(() => recorded.statuses.length === 1);
  const stale = await registration.rename({
    expectedSessionId: "native-one",
    expectedSessionEpoch: 4,
    name: "must not be sent",
  });
  assert.equal(stale.status, "stale-session");
  assert.equal(outbound.some((frame) => frame.type === "rename_request"), false, "stale expected epoch is rejected locally");

  const pending = registration.rename({
    expectedSessionId: "native-one",
    expectedSessionEpoch: 5,
    name: "pending title",
  });
  await waitFor(() => outbound.some((frame) => frame.type === "rename_request"));
  const request = outbound.find((frame) => frame.type === "rename_request")!;
  const mismatchedAck = JSON.stringify({
    version: 1,
    type: "rename_result",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    requestId: request.requestId,
    expectedSessionId: "native-one",
    expectedSessionEpoch: 6,
    sessionId: "native-one",
    sessionEpoch: 6,
    outcome: "rejected",
    reason: "stale-session",
  }) + "\n";
  const closed = expectBrokerRejection(client, () => client.write(mismatchedAck));
  const failed = await pending;
  await closed;
  assert.equal(failed.status, "disconnected", "an acknowledgement for a different expected tuple cannot satisfy the request");
  assert.equal(failed.requestId, request.requestId);
});

test("a successful rename acknowledgement cannot outlive the broker's current session epoch", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  const outbound: Record<string, unknown>[] = [];
  let buffer = "";
  client.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      const decoded = decodeFrame(line);
      if (decoded) outbound.push(decoded as unknown as Record<string, unknown>);
    }
  });
  client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  client.write(JSON.stringify(statusFrame(registration.bootstrap, {
    sequence: 1,
    nativeSession: { sessionId: "native-one", epoch: 5, name: "title" },
  })) + "\n");
  await waitFor(() => recorded.statuses.length === 1);
  const pending = registration.rename({
    expectedSessionId: "native-one",
    expectedSessionEpoch: 5,
    name: "persisted title",
  });
  await waitFor(() => outbound.some((frame) => frame.type === "rename_request"));
  const request = outbound.find((frame) => frame.type === "rename_request")!;

  client.write(JSON.stringify(statusFrame(registration.bootstrap, {
    sequence: 2,
    nativeSession: { sessionId: "native-two", epoch: 6, name: "new session" },
  })) + "\n");
  await waitFor(() => recorded.statuses.length === 2);
  client.write(JSON.stringify({
    version: 1,
    type: "rename_result",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    requestId: request.requestId,
    expectedSessionId: "native-one",
    expectedSessionEpoch: 5,
    sessionId: "native-one",
    sessionEpoch: 5,
    outcome: "renamed",
    reason: "none",
  }) + "\n");
  const result = await pending;
  assert.equal(result.status, "stale-session", "late success is not accepted for a replaced native session");
  assert.equal(result.observedSessionId, "native-two");
  assert.equal(result.observedSessionEpoch, 6);
});

test("rename has a per-registration in-flight cap and disposal resolves pending work", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  client.write(JSON.stringify(statusFrame(registration.bootstrap, {
    sequence: 1,
    nativeSession: { sessionId: "native-one", epoch: 1, name: "title" },
  })) + "\n");
  await waitFor(() => recorded.statuses.length === 1);

  const pending = Array.from({ length: 4 }, (_, index) => registration.rename({
    expectedSessionId: "native-one",
    expectedSessionEpoch: 1,
    name: `title ${index}`,
  }));
  const capped = await registration.rename({
    expectedSessionId: "native-one",
    expectedSessionEpoch: 1,
    name: "fifth title",
  });
  assert.equal(capped.status, "busy");
  const closed = expectClientClose(client);
  await disposeBroker(broker);
  await closed;
  assert.deepEqual((await Promise.all(pending)).map((result) => result.status), ["disconnected", "disconnected", "disconnected", "disconnected"]);
});

test("wrong token, wrong generation, and cross-instance tokens are rejected without disconnect callbacks", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recordedA = recording();
  const registrationA = broker.register(INSTANCE_A, recordedA.handlers);
  const recordedB = recording();
  const registrationB = broker.register(INSTANCE_B, recordedB.handlers);

  const wrongToken = await connectClient(broker.socketPath);
  await expectBrokerRejection(wrongToken, () => {
    wrongToken.write(JSON.stringify(helloFrame(registrationA.bootstrap, { token: registrationB.bootstrap.token })) + "\n");
  });

  const wrongGeneration = await connectClient(broker.socketPath);
  await expectBrokerRejection(wrongGeneration, () => {
    wrongGeneration.write(JSON.stringify(helloFrame(registrationA.bootstrap, { generation: "99999999-9999-4999-8999-999999999999" })) + "\n");
  });

  const crossInstance = await connectClient(broker.socketPath);
  await expectBrokerRejection(crossInstance, () => {
    crossInstance.write(JSON.stringify(helloFrame(registrationB.bootstrap, { instanceId: INSTANCE_A })) + "\n");
  });

  const unknownInstance = await connectClient(broker.socketPath);
  await expectBrokerRejection(unknownInstance, () => {
    unknownInstance.write(JSON.stringify(helloFrame({ ...registrationA.bootstrap, instanceId: INSTANCE_C })) + "\n");
  });

  assert.equal(recordedA.statuses.length, 0);
  assert.equal(recordedA.disconnects, 0);
  assert.equal(recordedB.statuses.length, 0);
  assert.equal(recordedB.disconnects, 0);

  // The broker remains fully usable afterwards.
  const good = await connectClient(broker.socketPath);
  good.write(JSON.stringify(helloFrame(registrationA.bootstrap)) + "\n");
  good.write(JSON.stringify(statusFrame(registrationA.bootstrap, { sequence: 1 })) + "\n");
  await waitFor(() => recordedA.statuses.length === 1);
});

test("repeated hello after authentication is rejected as a protocol violation", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  await expectBrokerRejection(client, () => {
    client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
    client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  });
  // The connection actually went away, so its disconnect is reported.
  await waitFor(() => recorded.disconnects === 1);
  assert.equal(recorded.statuses.length, 0);
});

test("non-monotonic sequences are rejected; the last sequence is retained across reconnect and reload", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const first = await connectClient(broker.socketPath);
  first.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  first.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 })) + "\n");
  first.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 2 })) + "\n");
  await waitFor(() => recorded.statuses.length === 2);
  assert.deepEqual(recorded.statuses.map((s) => s.sequence), [1, 2]);

  // Stale duplicates: sequence 2 again, then an older reload frame (1).
  await expectBrokerRejection(first, () => {
    first.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 2 })) + "\n");
    first.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 })) + "\n");
  });
  await waitFor(() => recorded.disconnects === 1);
  assert.equal(recorded.statuses.length, 2);

  // Reconnect: the retained lastSequence (2) governs; 3 is fresh, 2 is stale.
  const second = await connectClient(broker.socketPath);
  second.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  second.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 3 })) + "\n");
  await waitFor(() => recorded.statuses.length === 3);
  const third = await connectClient(broker.socketPath);
  await expectBrokerRejection(third, () => {
    third.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
    third.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 3 })) + "\n");
  });
  assert.equal(recorded.statuses.length, 3);
  assert.equal(recorded.disconnects, 2);
});

test("status identity and generation mismatches are rejected", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  await expectBrokerRejection(client, () => {
    client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
    client.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1, instanceId: INSTANCE_B })) + "\n");
  });
  const client2 = await connectClient(broker.socketPath);
  await expectBrokerRejection(client2, () => {
    client2.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
    client2.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 2, generation: "44444444-4444-4444-8444-444444444444" })) + "\n");
  });
  assert.equal(recorded.statuses.length, 0);
  assert.equal(recorded.disconnects, 2, "the currently-owned connection really did go away");
});

test("a fresh valid hello supersedes the old authenticated socket silently", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const first = await connectClient(broker.socketPath);
  first.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  first.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 })) + "\n");
  await waitFor(() => recorded.statuses.length === 1, 1000);
  // Replacement arrives on a separate socket.
  const second = await connectClient(broker.socketPath);
  second.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  await expectClientClose(first);
  assert.equal(recorded.disconnects, 0, "replacement never reports a disconnect");

  // The current owner continues monotonically from the replaced connection.
  second.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 2 })) + "\n");
  await waitFor(() => recorded.statuses.length === 2);
  assert.deepEqual(recorded.statuses.map((status) => status.sequence), [1, 2]);
  assert.equal(recorded.disconnects, 0);

  // Closing the current owner reports the real disconnect exactly once.
  second.destroy();
  await waitFor(() => recorded.disconnects === 1);
});

test("intentional release closes the active connection without a disconnect callback and rejects later hellos", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  client.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 })) + "\n");
  await waitFor(() => recorded.statuses.length === 1, 1000);
  registration.release();
  await expectClientClose(client);
  assert.equal(recorded.disconnects, 0, "intentional release is not a disconnect");
  assert.equal(recorded.statuses.length, 1, "the connection was authenticated before release");

  // New hellos after release are stale; the released peer is already closed.
  const stale = await connectClient(broker.socketPath);
  await expectBrokerRejection(stale, () => {
    stale.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  });
  assert.equal(recorded.disconnects, 0);

  // Re-registering after release works and authenticates independently.
  const recorded2 = recording();
  const registration2 = broker.register(INSTANCE_A, recorded2.handlers);
  assert.notEqual(registration2.bootstrap.token, registration.bootstrap.token);
  const fresh = await connectClient(broker.socketPath);
  fresh.write(JSON.stringify(helloFrame(registration2.bootstrap)) + "\n");
  fresh.write(JSON.stringify(statusFrame(registration2.bootstrap, { sequence: 1 })) + "\n");
  await waitFor(() => recorded2.statuses.length === 1);
});

test("duplicate active registration fails before the token is overwritten", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  assert.throws(
    () => broker.register(INSTANCE_A, recording().handlers),
    /already exists/,
  );
  // The first registration's token still authenticates: nothing was overwritten.
  const client = await connectClient(broker.socketPath);
  client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  client.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 })) + "\n");
  await waitFor(() => recorded.statuses.length === 1);
});

test("unauthenticated connections are dropped after a short auth deadline", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  await expectClientClose(client, undefined, [], SOCKET_CLOSE_DEADLINE_MS);
  assert.equal(client.destroyed, true, "unauth connection was closed by the auth deadline");
  assert.equal(recorded.statuses.length, 0);
  assert.equal(recorded.disconnects, 0, "never-authenticated sockets never report disconnects");
  // The broker still accepts a fresh authenticated client.
  const recordedC = recording();
  const registration = broker.register(INSTANCE_C, recordedC.handlers);
  const fresh = await connectClient(broker.socketPath);
  fresh.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  fresh.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1, instanceId: INSTANCE_C })) + "\n");
  await waitFor(() => recordedC.statuses.length === 1);
});

test("the unauthenticated backlog is bounded (32 pending beyond active authenticated connections)", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  // One authenticated connection stays active (not counted against the bound).
  const authed = await connectClient(broker.socketPath);
  authed.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  authed.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 })) + "\n");
  await waitFor(() => recorded.statuses.length === 1);
  const pending: net.Socket[] = [];
  for (let index = 0; index < 32; index += 1) {
    pending.push(await connectClient(broker.socketPath));
  }
  const overCap = await connectClient(broker.socketPath);
  await expectClientClose(overCap);
  assert.equal(overCap.destroyed, true, "the 33rd pending unauth connection is rejected");
  const closing = [authed, ...pending].map((socket) => expectClientClose(socket));
  await disposeBroker(broker);
  await Promise.all(closing);
  assert.equal(authed.destroyed, true);
  for (const socket of pending) assert.equal(socket.destroyed, true);
});

test("bounded byte framing handles partial and coalesced frames across multibyte boundaries", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  const hello = JSON.stringify(helloFrame(registration.bootstrap)) + "\n";
  const emojiActivity = "🚀🚀🚀"; // multibyte code points inside one bounded line
  const frame1 = JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1, activity: [emojiActivity] })) + "\n";
  const frame2 = JSON.stringify(statusFrame(registration.bootstrap, { sequence: 2 })) + "\n";
  const frame3 = JSON.stringify(statusFrame(registration.bootstrap, { sequence: 3 })) + "\n";

  // Partial delivery: split the status frame exactly inside a multibyte code point.
  const helloBytes = Buffer.from(hello, "utf8");
  client.write(helloBytes.subarray(0, 10));
  client.write(helloBytes.subarray(10));
  const frame1Bytes = Buffer.from(frame1, "utf8");
  const frame2Bytes = Buffer.from(frame2, "utf8");
  const frame3Bytes = Buffer.from(frame3, "utf8");
  const emojiOffset = frame1Bytes.indexOf(Buffer.from("🚀", "utf8"));
  assert.ok(emojiOffset > 0, "the encoded activity contains the expected multibyte code point");
  client.write(frame1Bytes.subarray(0, emojiOffset + 2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Coalesce two complete frames and a partial third frame in one large chunk.
  // The broker must retain only the bounded trailing fragment, not this chunk.
  client.write(Buffer.concat([
    frame1Bytes.subarray(emojiOffset + 2),
    frame2Bytes,
    frame3Bytes.subarray(0, frame3Bytes.length - 1),
  ]));
  await waitFor(() => recorded.statuses.length === 2);
  client.write(Buffer.from("\n"));
  await waitFor(() => recorded.statuses.length === 3);
  assert.deepEqual(recorded.statuses.map((s) => s.sequence), [1, 2, 3]);
  assert.deepEqual(recorded.statuses[0].activity, [emojiActivity]);
});

test("the frame byte limit includes the newline for complete and partial frames", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const exact = await connectClient(broker.socketPath);
  exact.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");

  const validBody = JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 }));
  const maxBody = MAX_STATUS_FRAME_BYTES - 1;
  const exactBody = validBody + " ".repeat(maxBody - Buffer.byteLength(validBody, "utf8"));
  assert.equal(Buffer.byteLength(exactBody, "utf8") + 1, MAX_STATUS_FRAME_BYTES);
  exact.write(exactBody + "\n");
  await waitFor(() => recorded.statuses.length === 1);

  const tooLargeComplete = await connectClient(broker.socketPath);
  const overBody = JSON.stringify(statusFrame(registration.bootstrap, { sequence: 2 }));
  const overCompleteBody = overBody + " ".repeat(MAX_STATUS_FRAME_BYTES - Buffer.byteLength(overBody, "utf8"));
  assert.equal(Buffer.byteLength(overCompleteBody, "utf8") + 1, MAX_STATUS_FRAME_BYTES + 1);
  await expectBrokerRejection(tooLargeComplete, () => {
    tooLargeComplete.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
    tooLargeComplete.write(overCompleteBody + "\n");
  });

  const tooLargePartial = await connectClient(broker.socketPath);
  const partialBody = JSON.stringify(statusFrame(registration.bootstrap, { sequence: 3 }));
  const maxPartialBody = partialBody + " ".repeat(MAX_STATUS_FRAME_BYTES - Buffer.byteLength(partialBody, "utf8"));
  assert.equal(Buffer.byteLength(maxPartialBody, "utf8") + 1, MAX_STATUS_FRAME_BYTES + 1);
  await expectBrokerRejection(tooLargePartial, () => {
    tooLargePartial.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
    tooLargePartial.write(maxPartialBody);
  });

  assert.deepEqual(recorded.statuses.map((status) => status.sequence), [1]);
});

test("malformed, control-carrying, and oversized frames are rejected without snapshot callbacks", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);

  const malformed = await connectClient(broker.socketPath);
  await expectBrokerRejection(malformed, () => malformed.write("definitely not json\n"));

  const invalidUtf8 = await connectClient(broker.socketPath);
  await expectBrokerRejection(invalidUtf8, () => invalidUtf8.write(Buffer.from([0xff, 0x0a])));

  // Forbidden terminal controls (C0/DEL/C1) in activity are rejected through
  // the shared protocol validator, never stripped silently.
  const controls = await connectClient(broker.socketPath);
  await expectBrokerRejection(controls, () => {
    controls.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
    controls.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1, activity: ["bad\x1b[31mcolor\u009bdark\x7f"] })) + "\n");
  });

  // An oversized unterminated frame is bounded in bytes before decoding.
  const oversized = await connectClient(broker.socketPath);
  await expectBrokerRejection(oversized, () => {
    oversized.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
    oversized.write("x".repeat(MAX_STATUS_FRAME_BYTES + 1));
  });

  // An oversized-assembled frame arriving in two writes is rejected too.
  const oversizedSplit = await connectClient(broker.socketPath);
  await expectBrokerRejection(oversizedSplit, () => {
    oversizedSplit.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
    oversizedSplit.write("y".repeat(10000));
    oversizedSplit.write("y".repeat(10000));
  });

  assert.equal(recorded.statuses.length, 0);
  // Authenticated, protocol-violating connections did go away.
});

test("snapshot consumer throws are contained; the broker keeps serving", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  recorded.throwOnStatusOnce = true;
  recorded.throwOnDisconnect = true;
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  client.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 })) + "\n");
  client.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 2 })) + "\n");
  await waitFor(() => recorded.statuses.length === 2);
  assert.deepEqual(recorded.statuses.map((s) => s.sequence), [1, 2], "both frames delivered despite the throwing consumer");

  // A throwing disconnect handler must not disturb the broker either.
  const client2 = await connectClient(broker.socketPath);
  client2.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  client2.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 3 })) + "\n");
  await waitFor(() => recorded.statuses.length === 3);
  client2.destroy();
  await waitFor(() => recorded.disconnects === 1);
  const after = await connectClient(broker.socketPath);
  after.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  after.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 4 })) + "\n");
  await waitFor(() => recorded.statuses.length === 4);
});

test("dispose clears pending unauth clients, timers, and the transport without touching unknown files", async () => {
  const root = makeSocketRoot();
  const broker = await createStatusBroker({ socketRoot: root });
  const registration = broker.register(INSTANCE_A, recording().handlers);
  const authed = await connectClient(broker.socketPath);
  authed.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  const pending1 = await connectClient(broker.socketPath);
  const pending2 = await connectClient(broker.socketPath);
  const unknown = path.join(path.dirname(broker.socketPath), "unknown-concurrent-entry");
  fs.writeFileSync(unknown, "preserve");
  ownFile(unknown);
  const closed = Promise.all([authed, pending1, pending2].map((socket) => expectClientClose(socket)));
  await disposeBroker(broker);
  await closed;
  assert.equal(authed.destroyed, true);
  assert.equal(pending1.destroyed, true);
  assert.equal(pending2.destroyed, true);
  assert.equal(fs.existsSync(broker.socketPath), false);
  assert.equal(fs.existsSync(unknown), true, "unknown concurrent entry preserved");
  assert.equal(fs.existsSync(path.dirname(broker.socketPath)), true, "non-empty owned dir preserved");
  await disposeBroker(broker, "idempotent broker dispose");
});

test("invalid socket roots fail clearly without adopting or unlinking anything", async () => {
  const missingRoot = path.join(os.tmpdir(), `prg-broker-missing-${Date.now()}`);
  await assert.rejects(
    createStatusBroker({ socketRoot: missingRoot }),
    /must already exist/,
  );
  await assert.rejects(
    createStatusBroker({ socketRoot: "relative/socket/root" }),
    /absolute/,
  );
  // A root path too long for a real Unix socket fails clearly.
  const root = makeSocketRoot();
  const deepRoot = path.join(root, "x".repeat(110));
  fs.mkdirSync(deepRoot);
  ownDirectory(deepRoot);
  await assert.rejects(
    createStatusBroker({ socketRoot: deepRoot }),
    /Unix-socket limit/,
  );
  assert.equal(fs.readdirSync(deepRoot).length, 0, "the failed attempt left nothing behind");
});