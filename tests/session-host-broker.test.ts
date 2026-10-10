/**
 * Focused real-socket tests for the authenticated bounded local status broker
 * (src/session-host/broker.ts, issue #323).
 *
 * These tests exercise real local net server/client Unix sockets, scoped
 * transport-branch seams, and a guarded real Windows named pipe against the
 * broker and shared protocol. They are focused IPC checks; they do not claim
 * completion of native-host integration.
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
  encodeFrame,
  parseBootstrap,
  parseShutdownAck,
  type SessionSpawnInput,
  type SessionSpawnOutcome,
} from "../src/session-host/protocol";

const INSTANCE_A = "11111111-1111-4111-8111-111111111111";
const INSTANCE_B = "22222222-2222-4222-8222-222222222222";
const INSTANCE_C = "33333333-3333-4333-8333-333333333333";
const WINDOWS_PIPE_ADDRESS = /^\\\\\.\\pipe\\prg-st-[0-9a-f]{32}$/;

// The isolated worker root is deliberately longer than macOS's sun_path. The
// tests still create every socket inode below this root: only the address sent
// to bind/connect is expressed relative to the already-rooted process cwd.
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
    // Node normalizes net.connect(string) into an options array carrying a
    // private symbol marker; mutate only the path option to preserve it.
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
  brokerTest.setSocketPathLimitForTests(4096);
  const broker = await createStatusBrokerImpl(options);
  brokers.add(broker);
  if (!WINDOWS_PIPE_ADDRESS.test(broker.socketPath)) {
    ownDirectory(path.dirname(broker.socketPath));
    ownFile(broker.socketPath);
  }
  return broker;
}

async function withFilesystemCallSpy<T>(run: (calls: string[]) => Promise<T>): Promise<T> {
  const fsModule = require("node:fs") as Record<string, unknown>;
  const names = [
    "chmodSync", "linkSync", "lstatSync", "mkdirSync", "renameSync", "rmdirSync",
    "statSync", "unlinkSync", "mkdtempSync", "realpathSync",
  ];
  const calls: string[] = [];
  const originals = new Map<string, unknown>();
  for (const name of names) {
    const original = fsModule[name];
    if (typeof original !== "function") throw new Error(`test setup: node:fs.${name} is unavailable`);
    originals.set(name, original);
    fsModule[name] = (...args: unknown[]) => {
      calls.push(name);
      return Reflect.apply(original, fsModule, args);
    };
  }
  try {
    return await run(calls);
  } finally {
    for (const [name, original] of originals) fsModule[name] = original;
  }
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
  brokerTest.setSpawnTimeoutForTests(undefined);
  brokerTest.setSocketPathLimitForTests(undefined);
  brokerTest.setPlatformForTests(undefined);
  brokerTest.setCreateServerForTests(undefined);
  brokerTest.setWindowsPipeTimeoutsForTests(undefined, undefined);
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

test("shutdown acknowledgement policy binds the request and refuses stale session success", () => {
  const expected = {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expectedSessionId: "native-one",
    expectedSessionEpoch: 7,
  };
  const ack = {
    version: 1 as const,
    type: "shutdown_result" as const,
    instanceId: INSTANCE_A,
    generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ...expected,
    outcome: "requested" as const,
    reason: "none" as const,
  };
  assert.deepEqual(parseShutdownAck(ack), ack);
  assert.equal(brokerTest.classifyShutdownAck(ack, expected, INSTANCE_A, ack.generation, {
    sessionId: "native-one", epoch: 7, name: "title",
  }), "matching");
  assert.equal(brokerTest.classifyShutdownAck(ack, expected, INSTANCE_A, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
    sessionId: "native-one", epoch: 7, name: "title",
  }), "invalid");
  assert.equal(brokerTest.classifyShutdownAck(ack, { ...expected, expectedSessionEpoch: 8 }, INSTANCE_A, ack.generation, {
    sessionId: "native-one", epoch: 7, name: "title",
  }), "invalid");
  assert.equal(brokerTest.classifyShutdownAck(ack, expected, INSTANCE_A, ack.generation, {
    sessionId: "native-two", epoch: 8, name: "other",
  }), "stale-session");
});

test("Windows transport uses a fresh local pipe and disposes only its own listen handle", async () => {
  const server = new net.Server();
  let listenAddress = "";
  let closeCalls = 0;
  Object.defineProperty(server, "listen", {
    value: (...args: unknown[]) => {
      listenAddress = args[0] as string;
      setImmediate(() => (args[1] as () => void)());
      return server;
    },
  });
  Object.defineProperty(server, "close", {
    value: (callback?: (error?: Error) => void) => {
      closeCalls += 1;
      setImmediate(() => {
        server.emit("close");
        callback?.();
      });
      return server;
    },
  });
  brokerTest.setPlatformForTests("win32");
  brokerTest.setCreateServerForTests(() => server);

  await withFilesystemCallSpy(async (filesystemCalls) => {
    // A relative socketRoot would fail on POSIX. Windows must not consult it or
    // touch filesystem permission/path APIs for the named-pipe address.
    const broker = await createStatusBrokerImpl({ socketRoot: "relative/unused" });
    brokers.add(broker);
    assert.match(listenAddress, WINDOWS_PIPE_ADDRESS);
    assert.equal(broker.socketPath, listenAddress);
    const registration = broker.register(INSTANCE_A, recording().handlers);
    assert.deepEqual(parseBootstrap(registration.bootstrap), registration.bootstrap);

    await disposeBroker(broker);
    assert.equal(closeCalls, 1, "the broker closes its own successful listen handle exactly once");
    assert.deepEqual(filesystemCalls, [], "named-pipe bind and disposal never call filesystem permission or cleanup APIs");
  });
});

test("Windows named-pipe listen collision refuses adoption and never closes a foreign server", async () => {
  const server = new net.Server();
  let listenAddress = "";
  let closeCalls = 0;
  Object.defineProperty(server, "listen", {
    value: (...args: unknown[]) => {
      listenAddress = args[0] as string;
      setImmediate(() => server.emit("error", Object.assign(new Error("pipe already exists"), { code: "EADDRINUSE" })));
      return server;
    },
  });
  Object.defineProperty(server, "close", {
    value: () => {
      closeCalls += 1;
      return server;
    },
  });
  brokerTest.setPlatformForTests("win32");
  brokerTest.setCreateServerForTests(() => server);

  await withFilesystemCallSpy(async (filesystemCalls) => {
    await assert.rejects(
      createStatusBrokerImpl({ socketRoot: "relative/unused" }),
      /could not listen \(code EADDRINUSE\)/,
    );
    assert.match(listenAddress, WINDOWS_PIPE_ADDRESS);
    assert.equal(closeCalls, 0, "a failed bind never adopts or closes the existing endpoint");
    assert.deepEqual(filesystemCalls, [], "a collision performs no filesystem cleanup or permission calls");
  });
});

test("Windows pipe disposal reports a listen-handle close failure", async () => {
  const server = new net.Server();
  Object.defineProperty(server, "listen", {
    value: (...args: unknown[]) => {
      setImmediate(() => (args[1] as () => void)());
      return server;
    },
  });
  Object.defineProperty(server, "close", {
    value: (callback?: (error?: Error) => void) => {
      setImmediate(() => callback?.(Object.assign(new Error("close failed"), { code: "EIO" })));
      return server;
    },
  });
  brokerTest.setPlatformForTests("win32");
  brokerTest.setCreateServerForTests(() => server);

  const broker = await createStatusBrokerImpl();
  await assert.rejects(broker.dispose(), /listen handle could not be closed \(code EIO\)/);
});

test("Windows named-pipe listen timeout is bounded and does not claim an endpoint", async () => {
  const server = new net.Server();
  let closeCalls = 0;
  Object.defineProperty(server, "listen", { value: () => server });
  Object.defineProperty(server, "close", {
    value: () => {
      closeCalls += 1;
      return server;
    },
  });
  brokerTest.setPlatformForTests("win32");
  brokerTest.setCreateServerForTests(() => server);
  brokerTest.setWindowsPipeTimeoutsForTests(20, 20);

  await assert.rejects(
    createStatusBrokerImpl(),
    /named-pipe broker listen timed out after 20ms/,
  );
  assert.equal(closeCalls, 0, "without a successful listen callback no handle is assumed to be owned");
});

test("late Windows pipe listen success is fenced and its owned handle is closed", async () => {
  const server = new net.Server();
  let listenCallback: (() => void) | undefined;
  let closeCalls = 0;
  Object.defineProperty(server, "listen", {
    value: (_address: string, callback: () => void) => {
      listenCallback = callback;
      return server;
    },
  });
  Object.defineProperty(server, "close", {
    value: (callback?: (error?: Error) => void) => {
      closeCalls += 1;
      setImmediate(() => {
        server.emit("close");
        callback?.();
      });
      return server;
    },
  });
  brokerTest.setPlatformForTests("win32");
  brokerTest.setCreateServerForTests(() => server);
  brokerTest.setWindowsPipeTimeoutsForTests(20, 50);

  await assert.rejects(createStatusBrokerImpl(), /listen timed out after 20ms/);
  assert.equal(typeof listenCallback, "function");
  const closed = once(server, "close").then(() => undefined);
  listenCallback!();
  await withDeadline(closed, "late Windows pipe listener close");
  assert.equal(closeCalls, 1, "a late successful bind is closed using only its own server handle");
});

test("Windows pipe close timeout stays rejected when its callback arrives late", async () => {
  const server = new net.Server();
  let closeCallback: ((error?: Error) => void) | undefined;
  let closeCalls = 0;
  Object.defineProperty(server, "listen", {
    value: (_address: string, callback: () => void) => {
      setImmediate(callback);
      return server;
    },
  });
  Object.defineProperty(server, "close", {
    value: (callback?: (error?: Error) => void) => {
      closeCalls += 1;
      closeCallback = callback;
      return server;
    },
  });
  brokerTest.setPlatformForTests("win32");
  brokerTest.setCreateServerForTests(() => server);
  brokerTest.setWindowsPipeTimeoutsForTests(50, 20);

  const broker = await createStatusBrokerImpl();
  const disposal = broker.dispose();
  await assert.rejects(disposal, /listen handle close timed out after 20ms/);
  assert.equal(typeof closeCallback, "function");

  // A later close event is observed, but the already-timed-out promise and
  // its result are not rewritten by a stale close callback.
  server.emit("close");
  closeCallback!();
  await assert.rejects(broker.dispose(), /listen handle close timed out after 20ms/);
  assert.equal(closeCalls, 1, "late callback does not issue a second close");
});

test("real Windows Node named pipe accepts the authenticated protocol and closes on dispose", {
  skip: process.platform !== "win32",
}, async () => {
  const broker = await createStatusBrokerImpl();
  brokers.add(broker);
  assert.match(broker.socketPath, WINDOWS_PIPE_ADDRESS);
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(registration.bootstrap.socketPath);
  client.write(`${JSON.stringify(helloFrame(registration.bootstrap))}\n`);
  client.write(`${JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1 }))}\n`);
  await waitFor(() => recorded.statuses.length === 1);
  assert.equal(recorded.statuses[0]?.sequence, 1);

  const closed = expectClientClose(client);
  await disposeBroker(broker);
  await closed;
  await new Promise<void>((resolve, reject) => {
    const probe = net.connect(broker.socketPath);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("disposed Windows pipe accepted a new client"));
    });
    probe.once("error", () => resolve());
  });
});

test("broker creates a private 0700 transport, owns its 0600 socket, and cleans up while preserving unknown files", {
  skip: process.platform === "win32",
}, async () => {
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

test("broker cleanup preserves a different socket inode that appears at its former path", {
  skip: process.platform === "win32",
}, async () => {
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

test("broker cleanup preserves an unknown directory at the socket pathname", {
  skip: process.platform === "win32",
}, async () => {
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

test("broker restoration never overwrites a concurrent destination", {
  skip: process.platform === "win32",
}, async () => {
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

test("registration shutdown is authenticated, idempotent, session-fenced, and never an exit result", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  assert.equal((await registration.shutdown()).status, "unavailable", "unknown session metadata cannot be guessed");

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
  const nativeSession = { sessionId: "native-shutdown", epoch: 12, name: "private title" };
  client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");
  client.write(JSON.stringify(statusFrame(registration.bootstrap, { sequence: 1, nativeSession })) + "\n");
  await waitFor(() => recorded.statuses.length === 1);

  const pending = registration.shutdown();
  assert.equal(registration.shutdown(), pending, "repeated host Quit shares one terminal request/result");
  await waitFor(() => outbound.some((frame) => frame.type === "shutdown_request"));
  const request = outbound.find((frame) => frame.type === "shutdown_request")!;
  assert.equal(request.instanceId, INSTANCE_A);
  assert.equal(request.generation, registration.bootstrap.generation);
  assert.equal(request.token, registration.bootstrap.token, "only the authenticated command carries the capability");
  assert.equal(request.expectedSessionId, nativeSession.sessionId);
  assert.equal(request.expectedSessionEpoch, nativeSession.epoch);

  client.write(JSON.stringify({
    version: 1,
    type: "shutdown_result",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    requestId: request.requestId,
    expectedSessionId: nativeSession.sessionId,
    expectedSessionEpoch: nativeSession.epoch,
    outcome: "requested",
    reason: "none",
  }) + "\n");
  const result = await pending;
  assert.deepEqual(result, { requestId: request.requestId, status: "requested" });
  assert.deepEqual(Object.keys(result).sort(), ["requestId", "status"]);
  assert.equal(recorded.disconnects, 0, "request acknowledgement does not infer reporter or PTY exit");
  assert.equal(client.destroyed, false, "the request can be acknowledged while the reporter remains connected");
  client.destroy();
  await waitFor(() => recorded.disconnects === 1);
});

test("pending Stop fences new SessionSpawn requests until an idle-only rejection is confirmed", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  let spawnCalls = 0;
  let statuses = 0;
  const registration = broker.register(INSTANCE_A, {
    onStatus: () => { statuses += 1; },
    onDisconnect: () => undefined,
    onSpawnRequest: () => {
      spawnCalls += 1;
      return Promise.resolve("started");
    },
  });
  const client = await connectClient(broker.socketPath);
  const outbound: Record<string, unknown>[] = [];
  let buffer = "";
  client.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = decodeFrame(buffer.slice(0, newline + 1));
      buffer = buffer.slice(newline + 1);
      if (message) outbound.push(message as unknown as Record<string, unknown>);
    }
  });
  const nativeSession = { sessionId: "native-stop-fence", epoch: 3, name: "Parent" };
  client.write(encodeFrame(helloFrame(registration.bootstrap) as never)
    + encodeFrame(statusFrame(registration.bootstrap, { sequence: 1, nativeSession }) as never));
  await waitFor(() => statuses === 1);
  const stopping = registration.shutdown({ requireIdle: true });
  await waitFor(() => outbound.some((frame) => frame.type === "shutdown_request"));
  const shutdown = outbound.find((frame) => frame.type === "shutdown_request")!;
  const blockedSpawn = {
    version: 1,
    type: "spawn_request",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    token: registration.bootstrap.token,
    requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    workspace: "/existing workspace",
    title: "Blocked while stopping",
    prompt: "This must not launch during Stop.",
  };
  client.write(encodeFrame(blockedSpawn as never));
  await waitFor(() => outbound.some((frame) => frame.type === "spawn_result" && frame.requestId === blockedSpawn.requestId));
  assert.equal(outbound.find((frame) => frame.type === "spawn_result" && frame.requestId === blockedSpawn.requestId)?.outcome,
    "failed", "the broker refuses the request without invoking the host while shutdown is pending");
  assert.equal(spawnCalls, 0);

  client.write(encodeFrame({
    version: 1,
    type: "shutdown_result",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    requestId: shutdown.requestId,
    expectedSessionId: nativeSession.sessionId,
    expectedSessionEpoch: nativeSession.epoch,
    outcome: "rejected",
    reason: "not-idle",
  } as never));
  assert.equal((await stopping).status, "not-idle");

  const retry = { ...blockedSpawn, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
  client.write(encodeFrame(retry as never));
  await waitFor(() => outbound.some((frame) => frame.type === "spawn_result" && frame.requestId === retry.requestId));
  assert.equal(outbound.find((frame) => frame.type === "spawn_result" && frame.requestId === retry.requestId)?.outcome,
    "started", "a positively rejected idle-only preflight restores spawn admission");
  assert.equal(spawnCalls, 1);
  assert.equal(outbound.find((frame) => frame.type === "spawn_result" && frame.requestId === blockedSpawn.requestId)?.outcome,
    "failed", "the request rejected during Stop remains deduplicated after recovery");

  await disposeBroker(broker);
});

test("shutdown acknowledgements arriving after a session change are rejected", async () => {
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
    nativeSession: { sessionId: "native-one", epoch: 4, name: "title" },
  })) + "\n");
  await waitFor(() => recorded.statuses.length === 1);
  const pending = registration.shutdown();
  await waitFor(() => outbound.some((frame) => frame.type === "shutdown_request"));
  const request = outbound.find((frame) => frame.type === "shutdown_request")!;
  client.write(JSON.stringify(statusFrame(registration.bootstrap, {
    sequence: 2,
    nativeSession: { sessionId: "native-two", epoch: 5, name: "new title" },
  })) + "\n");
  await waitFor(() => recorded.statuses.length === 2);
  client.write(JSON.stringify({
    version: 1,
    type: "shutdown_result",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    requestId: request.requestId,
    expectedSessionId: "native-one",
    expectedSessionEpoch: 4,
    outcome: "requested",
    reason: "none",
  }) + "\n");
  assert.equal((await pending).status, "rejected", "a stale requested acknowledgement cannot cross conversation epochs");
});

test("real disconnect before shutdown acknowledgement returns disconnected", async () => {
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
  const pending = registration.shutdown();
  client.destroy();
  const result = await pending;
  assert.equal(result.status, "disconnected");
  assert.equal(recorded.disconnects, 1, "only the actual reporter socket disconnect is observed here");
});

test("shutdown acknowledgement timeout retires the silent authenticated connection", async () => {
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
  const result = await registration.shutdown();
  assert.equal(result.status, "timeout");
  await waitFor(() => recorded.disconnects === 1);
  assert.equal(recorded.disconnects, 1, "broker retired the silent authenticated connection");
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
  const shutdown = registration.shutdown();
  const capped = await registration.rename({
    expectedSessionId: "native-one",
    expectedSessionEpoch: 1,
    name: "fifth title",
  });
  assert.equal(capped.status, "busy");
  assert.equal((await shutdown).status, "busy", "shutdown shares the bounded four-frame control write queue");
  await disposeBroker(broker);
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

test("dispose clears pending unauth clients, timers, and the transport without touching unknown files", {
  skip: process.platform === "win32",
}, async () => {
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

test("invalid socket roots fail clearly without adopting or unlinking anything", {
  skip: process.platform === "win32",
}, async () => {
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
  brokerTest.setSocketPathLimitForTests(undefined);
  await assert.rejects(
    createStatusBrokerImpl({ socketRoot: deepRoot }),
    /Unix-socket limit/,
  );
  assert.equal(fs.readdirSync(deepRoot).length, 0, "the failed attempt left nothing behind");
});

test("authenticated status forwards bounded owned-work counts unchanged, degrading invalid values to unknown", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  const recorded = recording();
  const registration = broker.register(INSTANCE_A, recorded.handlers);
  const client = await connectClient(broker.socketPath);
  client.write(JSON.stringify(helloFrame(registration.bootstrap)) + "\n");

  client.write(JSON.stringify({
    ...statusFrame(registration.bootstrap, { sequence: 1 }),
    backgroundTasks: 2,
    backgroundShells: 0,
    activeTasks: 0,
    activeShells: 3,
  }) + "\n");
  await waitFor(() => recorded.statuses.length === 1);
  assert.equal(recorded.statuses[0]!.backgroundTasks, 2, "an observed count reaches the authenticated consumer");
  assert.equal(recorded.statuses[0]!.backgroundShells, 0);
  assert.equal(recorded.statuses[0]!.activeTasks, 0, "activity intent is forwarded independently of ownership");
  assert.equal(recorded.statuses[0]!.activeShells, 3);

  client.write(JSON.stringify({
    ...statusFrame(registration.bootstrap, { sequence: 2 }),
    backgroundTasks: -1,
    backgroundShells: "3",
    activeTasks: Number.NaN,
    activeShells: 1.5,
  }) + "\n");
  await waitFor(() => recorded.statuses.length === 2);
  assert.equal(recorded.statuses[1]!.backgroundTasks, null, "an invalid count is unknown, never zero");
  assert.equal(recorded.statuses[1]!.backgroundShells, null);
  assert.equal(recorded.statuses[1]!.activeTasks, null, "invalid intent is unknown, never zero");
  assert.equal(recorded.statuses[1]!.activeShells, null);

  await disposeBroker(broker);
});

test("authenticated SessionSpawn is routed once and returns only a correlated launch outcome", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  let resolveSpawn!: (outcome: SessionSpawnOutcome) => void;
  const hostOperation = new Promise<SessionSpawnOutcome>((resolve) => { resolveSpawn = resolve; });
  const received: SessionSpawnInput[] = [];
  let calls = 0;
  const registration = broker.register(INSTANCE_A, {
    onStatus: () => undefined,
    onDisconnect: () => undefined,
    onSpawnRequest: (input) => {
      calls += 1;
      received.push(input);
      return hostOperation;
    },
  });
  const client = await connectClient(broker.socketPath);
  const replies: Record<string, unknown>[] = [];
  let buffer = "";
  client.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      const message = decodeFrame(line);
      if (message) replies.push(message as unknown as Record<string, unknown>);
    }
  });
  const request = {
    version: 1 as const,
    type: "spawn_request" as const,
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    token: registration.bootstrap.token,
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspace: "/existing workspace",
    title: "A long friendly title " + "x".repeat(280),
    prompt: "--session must remain prompt text\nKeep this exact.\n",
  };
  const encoded = encodeFrame(request as never);
  client.write(encodeFrame(helloFrame(registration.bootstrap) as never) + encoded + encoded);
  await waitFor(() => calls === 1);
  assert.deepEqual(received, [{ workspace: request.workspace, title: request.title, prompt: request.prompt }]);
  assert.equal(Object.hasOwn(received[0]!, "token"), false, "the credential never reaches the host callback");
  assert.equal(replies.length, 0, "the broker waits for the host's actual launch decision");

  resolveSpawn("started");
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies[0], {
    version: 1,
    type: "spawn_result",
    instanceId: request.instanceId,
    generation: request.generation,
    requestId: request.requestId,
    outcome: "started",
  });
  assert.equal(JSON.stringify(replies).includes(request.prompt), false, "the reply never echoes prompt content");
  client.write(encoded); // A completed exact replay is acknowledged without launching twice.
  await waitFor(() => replies.length === 2);
  assert.equal(calls, 1);
  await disposeBroker(broker);
});

test("SessionSpawn rejects a spoofed token and deduplicates across connection supersession", async () => {
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  let resolveSpawn!: (outcome: SessionSpawnOutcome) => void;
  const hostOperation = new Promise<SessionSpawnOutcome>((resolve) => { resolveSpawn = resolve; });
  let calls = 0;
  const registration = broker.register(INSTANCE_A, {
    onStatus: () => undefined,
    onDisconnect: () => undefined,
    onSpawnRequest: () => { calls += 1; return hostOperation; },
  });
  const request = {
    version: 1 as const,
    type: "spawn_request" as const,
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    token: registration.bootstrap.token,
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workspace: "/existing workspace",
    title: "Hosted child",
    prompt: "Start.",
  };
  const spoofed = await connectClient(broker.socketPath);
  spoofed.write(encodeFrame(helloFrame(registration.bootstrap) as never) + encodeFrame({ ...request, token: "0".repeat(64) } as never));
  await expectClientClose(spoofed);
  assert.equal(calls, 0, "a valid hello does not authorize a forged per-request token");

  const first = await connectClient(broker.socketPath);
  first.write(encodeFrame(helloFrame(registration.bootstrap) as never) + encodeFrame(request as never));
  await waitFor(() => calls === 1);
  const second = await connectClient(broker.socketPath);
  const replies: Record<string, unknown>[] = [];
  let buffer = "";
  second.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = decodeFrame(buffer.slice(0, newline + 1));
      buffer = buffer.slice(newline + 1);
      if (message) replies.push(message as unknown as Record<string, unknown>);
    }
  });
  second.write(encodeFrame(helloFrame(registration.bootstrap) as never) + encodeFrame(request as never));
  await expectClientClose(first);
  assert.equal(calls, 1, "a replay on the replacement connection attaches to the in-flight request");
  resolveSpawn("started");
  await waitFor(() => replies.length === 1);
  assert.equal(replies[0]!.requestId, request.requestId);
  assert.equal(replies[0]!.outcome, "started");
  await disposeBroker(broker);
});

test("SessionSpawn timeout is an unknown result and permanently deduplicates that request id", async () => {
  brokerTest.setSpawnTimeoutForTests(25);
  const broker = await createStatusBroker({ socketRoot: makeSocketRoot() });
  let resolveSpawn!: (outcome: SessionSpawnOutcome) => void;
  const hostOperation = new Promise<SessionSpawnOutcome>((resolve) => { resolveSpawn = resolve; });
  let calls = 0;
  const registration = broker.register(INSTANCE_A, {
    onStatus: () => undefined,
    onDisconnect: () => undefined,
    onSpawnRequest: () => { calls += 1; return hostOperation; },
  });
  const client = await connectClient(broker.socketPath);
  const replies: Record<string, unknown>[] = [];
  let buffer = "";
  client.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = decodeFrame(buffer.slice(0, newline + 1));
      buffer = buffer.slice(newline + 1);
      if (message) replies.push(message as unknown as Record<string, unknown>);
    }
  });
  const request = {
    version: 1,
    type: "spawn_request",
    instanceId: registration.bootstrap.instanceId,
    generation: registration.bootstrap.generation,
    token: registration.bootstrap.token,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    workspace: "/existing workspace",
    title: "Hosted child",
    prompt: "Start.",
  };
  const frame = encodeFrame(helloFrame(registration.bootstrap) as never) + encodeFrame(request as never);
  client.write(frame);
  await waitFor(() => replies.length === 1);
  assert.equal(replies[0]!.outcome, "unknown");
  client.write(encodeFrame(request as never));
  await waitFor(() => replies.length === 2);
  assert.equal(replies[1]!.outcome, "unknown");
  resolveSpawn("started"); // Late completion cannot upgrade the unknown acknowledgement.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(replies.length, 2);
  assert.equal(calls, 1);
  await disposeBroker(broker);
});
