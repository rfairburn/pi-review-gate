/**
 * #682: bounded native Claude inbox send primitive.
 *
 * Everything runs against owned mock Unix sockets in a private scratch
 * directory, plus an in-process fake transport for deadline, disconnect, and
 * reply-byte timing that a real socket cannot produce deterministically. No
 * Claude CLI, provider account, credential, or live prompt is used, and the
 * module is exercised standalone: it is not wired into any host.
 *
 * Wire bytes are asserted exactly against the proven Claude Code 2.1.330
 * inbox format: {"type":"auth","token"} then
 * {"type":"user","session_id","message":{"role":"user","content"}} as NDJSON.
 */
import assert from "node:assert/strict";
import { type BigIntStats, chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { inspect } from "node:util";
import test, { after, afterEach } from "node:test";

import {
  CLAUDE_INBOX_MAX_TEXT_BYTES,
  CLAUDE_INBOX_SUPPORTED_PLATFORMS,
  createClaudeInboxSendCapability,
  sendClaudeInboxMessage,
  setClaudeInboxConnectorForTests,
  setClaudeInboxLstatForTests,
  setClaudeInboxPlatformForTests,
  type ClaudeInboxCapabilityInput,
  type ClaudeInboxSendCapability,
  type ClaudeInboxSendResult,
} from "../src/session-host/native-claude-inbox-delivery";

// Mock transport tests run only where the sender supports the endpoint check.
const posix = CLAUDE_INBOX_SUPPORTED_PLATFORMS.includes(process.platform);
const SESSION_ID = "0f6b3c9e-1d2a-4b5c-8d7e-9f0a1b2c3d4e";
// Opaque fixture with whitespace, a newline, and non-ASCII: framing must
// preserve it exactly without assuming a provider token alphabet.
const HOOK_TOKEN = "HOOK-TOKEN-SECRET-682\n \u00e9 \u{1f511}";
const MESSAGE = "SECRET-MESSAGE-682\nsecond line é \u{1f600} \"quoted\"";


const scratch = posix ? mkdtempSync(join(tmpdir(), "pi-cib-")) : "";
let nameSeq = 0;
after(() => {
  if (posix) rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  setClaudeInboxConnectorForTests(undefined);
  setClaudeInboxLstatForTests(undefined);
  setClaudeInboxPlatformForTests(undefined);
});

interface MockInbox {
  readonly path: string;
  readonly server: Server;
  readonly received: Buffer[];
  connections: number;
  readonly ended: Promise<void>;
  readonly sockets: Set<Socket>;
  close(): Promise<void>;
}

/** Busy-wait synchronously, so no timer callback can run meanwhile. */
function spin(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* spin */ }
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Owned mock inbox: reads everything, writes zero bytes, like the evidenced endpoint. */
async function mockInbox(onConnection?: (socket: Socket) => void, directory = scratch): Promise<MockInbox> {
  const path = join(directory, `in${nameSeq++}.sock`);
  const received: Buffer[] = [];
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
  const sockets = new Set<Socket>();
  const inbox: MockInbox = {
    path,
    sockets,
    received,
    connections: 0,
    ended,
    server: createServer((socket) => {
      inbox.connections += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      if (onConnection !== undefined) {
        onConnection(socket);
        return;
      }
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.on("end", () => resolveEnded());
    }),
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      inbox.server.close(() => resolve());
    }),
  };
  await new Promise<void>((resolve) => inbox.server.listen(path, resolve));
  return inbox;
}

function identityOf(path: string): ClaudeInboxCapabilityInput["endpoint"] {
  const stats = lstatSync(path, { bigint: true });
  return { dev: stats.dev, ino: stats.ino, uid: Number(stats.uid) };
}

function inputFor(path: string, overrides: Partial<ClaudeInboxCapabilityInput> = {}): ClaudeInboxCapabilityInput {
  return {
    launchId: "launch-682",
    sessionId: SESSION_ID,
    socketPath: path,
    endpoint: identityOf(path),
    hookToken: HOOK_TOKEN,
    claudeVersion: "2.1.330",
    isCurrent: () => true,
    ...overrides,
  };
}

function capabilityFor(path: string, overrides: Partial<ClaudeInboxCapabilityInput> = {}): ClaudeInboxSendCapability {
  const result = createClaudeInboxSendCapability(inputFor(path, overrides));
  assert.equal(result.ok, true, `capability should build: ${JSON.stringify(result)}`);
  return (result as { capability: ClaudeInboxSendCapability }).capability;
}

function assertNoSecrets(value: unknown, path?: string): void {
  const text = `${JSON.stringify(value)} ${inspect(value, { depth: 10 })}`;
  assert.doesNotMatch(text, /HOOK-TOKEN-SECRET-682/);
  assert.doesNotMatch(text, /SECRET-MESSAGE-682/);
  if (path !== undefined) assert.equal(text.includes(path), false, "names no socket path");
}

/** Fake transport whose timing the test controls. */
class FakeSocket extends Duplex {
  readonly writes: Buffer[] = [];
  holdWrites = false;
  writeSpinMs = 0;
  /** Runs (on the next turn) after the first write reaches the transport. */
  afterFirstWrite: ((socket: FakeSocket) => void) | undefined;
  destroyedByClient = false;
  constructor() {
    super({ allowHalfOpen: false });
  }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk);
    if (this.writes.length === 1 && this.afterFirstWrite !== undefined) {
      const hook = this.afterFirstWrite;
      setImmediate(() => hook(this));
    }
    if (this.writeSpinMs > 0) spin(this.writeSpinMs);
    if (!this.holdWrites) callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.destroyedByClient = true;
    callback(error);
  }
}

test("sends one auth frame then one user frame with the exact session id and reports only sent_unconfirmed", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    const result = await sendClaudeInboxMessage(capabilityFor(inbox.path), MESSAGE);
    // Check the outcome first so a regression refuses visibly instead of
    // leaving the peer wait pending.
    assert.equal(result.disposition, "sent_unconfirmed", JSON.stringify(result));
    await within(inbox.ended, 5000, "peer end-of-stream");
    const wire = Buffer.concat(inbox.received).toString("utf8");
    assert.deepEqual(result, {
      disposition: "sent_unconfirmed",
      placement: "unconfirmed",
      launchId: "launch-682",
      bytesWritten: Buffer.byteLength(wire, "utf8"),
    });
    assert.equal(inbox.connections, 1);
    // Exact bytes, written out by hand (not via JSON.stringify): the auth frame
    // carries only type and token (no session_id); the user frame carries the
    // exact session id and the text as message content; newlines inside the
    // token and text stay escaped, so there are exactly two lines.
    const expected =
      '{"type":"auth","token":"HOOK-TOKEN-SECRET-682\\n \u00e9 \u{1f511}"}\n'
      + `{"type":"user","session_id":"${SESSION_ID}","message":{"role":"user","content":`
      + '"SECRET-MESSAGE-682\\nsecond line \u00e9 \u{1f600} \\"quoted\\""}}\n';
    assert.equal(wire, expected);
    assert.equal(wire.split("\n").length, 3, "exactly two newline-terminated frames");
    assertNoSecrets(result, inbox.path);
    assert.equal(Object.isFrozen(result), true);
  } finally {
    await inbox.close();
  }
});

test("capability construction refuses invalid or unsupported binding inputs", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    const good = inputFor(inbox.path);
    const cases: [string, Partial<ClaudeInboxCapabilityInput> | Record<string, unknown>, string][] = [
      ["empty launch id", { launchId: "" }, "invalid_launch_id"],
      ["launch id with spaces", { launchId: "a b" }, "invalid_launch_id"],
      ["session alias", { sessionId: "latest" }, "invalid_session_id"],
      ["braced session", { sessionId: `{${SESSION_ID}}` }, "invalid_session_id"],
      ["relative socket path", { socketPath: "inbox.sock" }, "invalid_socket_path"],
      ["non-normalized path", { socketPath: `${scratch}/../x.sock` }, "invalid_socket_path"],
      ["overlong path", { socketPath: `/${"a".repeat(200)}` }, "invalid_socket_path"],
      ["nul in path", { socketPath: "/tmp/a\0b" }, "invalid_socket_path"],
      ["numeric inode", { endpoint: { dev: 1, ino: 2, uid: 0 } }, "invalid_endpoint_identity"],
      ["missing endpoint", { endpoint: undefined }, "invalid_endpoint_identity"],
      ["empty token", { hookToken: "" }, "invalid_hook_token"],
      ["non-string token", { hookToken: 42 as unknown as string }, "invalid_hook_token"],
      ["lone surrogate in token", { hookToken: "\ud800" }, "invalid_hook_token"],
      ["oversize multibyte token", { hookToken: "\u00e9".repeat(2049) }, "invalid_hook_token"],
      ["unproven CLI version", { claudeVersion: "2.1.331" }, "unsupported_cli_version"],
      ["missing CLI version", { claudeVersion: undefined }, "unsupported_cli_version"],
      ["missing current predicate", { isCurrent: undefined }, "invalid_current_predicate"],
    ];
    for (const [label, override, reason] of cases) {
      const result = createClaudeInboxSendCapability({ ...good, ...override } as ClaudeInboxCapabilityInput);
      assert.deepEqual(result, { ok: false, reason }, label);
      assertNoSecrets(result);
    }
  } finally {
    await inbox.close();
  }
});

test("only a host-minted capability sends, and it never serializes its secret", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    const capability = capabilityFor(inbox.path);
    assertNoSecrets(capability, inbox.path);
    assert.deepEqual(Object.keys(capability), []);
    for (const forged of [{}, null, Object.create(Object.getPrototypeOf(capability)), inputFor(inbox.path)]) {
      const result = await sendClaudeInboxMessage(forged as ClaudeInboxSendCapability, MESSAGE);
      assert.deepEqual(result, { disposition: "refused", reason: "invalid_capability" });
    }
    assert.equal(inbox.connections, 0);
  } finally {
    await inbox.close();
  }
});

test("pre-I/O refusals never connect: message, limits, options, currency, cancellation, platform", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    let current = true;
    const capability = capabilityFor(inbox.path, { isCurrent: () => current });
    const aborted = new AbortController();
    aborted.abort();
    const expectRefused = async (label: string, run: () => Promise<ClaudeInboxSendResult>, reason: string) => {
      const result = await run();
      assert.deepEqual(result, { disposition: "refused", reason }, label);
      assertNoSecrets(result, inbox.path);
    };
    await expectRefused("empty", () => sendClaudeInboxMessage(capability, ""), "invalid_message");
    await expectRefused("non-string", () => sendClaudeInboxMessage(capability, 42 as unknown as string), "invalid_message");
    await expectRefused("lone surrogate", () => sendClaudeInboxMessage(capability, "a\ud800b"), "invalid_message");
    await expectRefused("oversize", () => sendClaudeInboxMessage(capability, "x".repeat(CLAUDE_INBOX_MAX_TEXT_BYTES + 1)), "message_too_large");
    await expectRefused("oversize before Unicode validation", () => sendClaudeInboxMessage(capability, "\ud800" + "x".repeat(CLAUDE_INBOX_MAX_TEXT_BYTES)), "message_too_large");
    await expectRefused("oversize multibyte", () => sendClaudeInboxMessage(capability, "é".repeat(CLAUDE_INBOX_MAX_TEXT_BYTES / 2 + 1)), "message_too_large");
    await expectRefused("escape-expanded frame", () => sendClaudeInboxMessage(capability, "\u0001".repeat(CLAUDE_INBOX_MAX_TEXT_BYTES)), "message_too_large");
    await expectRefused("deadline too small", () => sendClaudeInboxMessage(capability, MESSAGE, { deadlineMs: 1 }), "invalid_options");
    await expectRefused("deadline too large", () => sendClaudeInboxMessage(capability, MESSAGE, { deadlineMs: 10 * 60_000 }), "invalid_options");
    await expectRefused("fractional deadline", () => sendClaudeInboxMessage(capability, MESSAGE, { deadlineMs: 100.5 }), "invalid_options");
    await expectRefused("pre-aborted", () => sendClaudeInboxMessage(capability, MESSAGE, { signal: aborted.signal }), "cancelled");
    current = false;
    await expectRefused("not current", () => sendClaudeInboxMessage(capability, MESSAGE), "not_current");
    current = true;
    const throwing = capabilityFor(inbox.path, { isCurrent: () => { throw new Error(HOOK_TOKEN); } });
    await expectRefused("current predicate throws", () => sendClaudeInboxMessage(throwing, MESSAGE), "not_current");
    for (const platform of ["win32", "darwin", "aix", "freebsd"] as NodeJS.Platform[]) {
      setClaudeInboxPlatformForTests(platform);
      await expectRefused(`platform ${platform}`, () => sendClaudeInboxMessage(capability, MESSAGE), "unsupported_platform");
    }
    setClaudeInboxPlatformForTests(undefined);
    assert.equal(inbox.connections, 0, "no refusal opened a connection");
  } finally {
    await inbox.close();
  }
});

test("fails closed when the path no longer names the owned endpoint identity", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    const owned = identityOf(inbox.path);
    const send = (overrides: Partial<ClaudeInboxCapabilityInput>) =>
      sendClaudeInboxMessage(capabilityFor(inbox.path, overrides), MESSAGE);
    assert.deepEqual(await send({ endpoint: { ...owned, ino: owned.ino + 1n } }), { disposition: "refused", reason: "endpoint_mismatch" });
    assert.deepEqual(await send({ endpoint: { ...owned, dev: owned.dev + 1n } }), { disposition: "refused", reason: "endpoint_mismatch" });
    assert.deepEqual(await send({ endpoint: { ...owned, uid: owned.uid + 1 } }), { disposition: "refused", reason: "endpoint_mismatch" });

    const link = join(scratch, `ln${nameSeq++}.sock`);
    symlinkSync(inbox.path, link);
    const viaLink = await sendClaudeInboxMessage(capabilityFor(inbox.path, { socketPath: link }), MESSAGE);
    assert.deepEqual(viaLink, { disposition: "refused", reason: "endpoint_mismatch" }, "a symlink is never followed");

    const file = join(scratch, `f${nameSeq++}.sock`);
    writeFileSync(file, "");
    const regular = await sendClaudeInboxMessage(capabilityFor(inbox.path, { socketPath: file, endpoint: identityOf(file) }), MESSAGE);
    assert.deepEqual(regular, { disposition: "refused", reason: "endpoint_mismatch" });

    const missing = await sendClaudeInboxMessage(capabilityFor(inbox.path, { socketPath: join(scratch, "absent.sock") }), MESSAGE);
    assert.deepEqual(missing, { disposition: "refused", reason: "endpoint_unavailable" });
    assert.equal(inbox.connections, 0);
  } finally {
    await inbox.close();
  }
});

test("re-checks endpoint and currency after connect, before any byte is written", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    let current = true;
    let fake!: FakeSocket;
    setClaudeInboxConnectorForTests(() => {
      fake = new FakeSocket();
      setImmediate(() => { current = false; fake.emit("connect"); });
      return fake;
    });
    const stale = await sendClaudeInboxMessage(capabilityFor(inbox.path, { isCurrent: () => current }), MESSAGE);
    assert.deepEqual(stale, { disposition: "refused", reason: "not_current" });
    assert.equal(fake.writes.length, 0);

    const capability = capabilityFor(inbox.path);
    setClaudeInboxConnectorForTests(() => {
      fake = new FakeSocket();
      setImmediate(() => { unlinkSync(inbox.path); fake.emit("connect"); });
      return fake;
    });
    const swapped = await sendClaudeInboxMessage(capability, MESSAGE);
    assert.deepEqual(swapped, { disposition: "refused", reason: "endpoint_unavailable" });
    assert.equal(fake.writes.length, 0);
    assert.equal(fake.destroyedByClient, true);
  } finally {
    await inbox.close();
  }
});

test("deadline, disconnect, cancellation, and reply bytes map to refused before writing and unknown after", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    const capability = capabilityFor(inbox.path);
    let fake!: FakeSocket;
    const install = (script: (socket: FakeSocket) => void) => setClaudeInboxConnectorForTests(() => {
      fake = new FakeSocket();
      script(fake);
      return fake;
    });

    install(() => undefined); // never connects
    const started = Date.now();
    assert.deepEqual(await sendClaudeInboxMessage(capability, MESSAGE, { deadlineMs: 100 }), { disposition: "refused", reason: "deadline_exceeded" });
    assert.ok(Date.now() - started < 2000, "deadline bounds the attempt");
    assert.equal(fake.destroyedByClient, true);

    install((socket) => setImmediate(() => socket.destroy(new Error(`ECONNREFUSED ${HOOK_TOKEN}`))));
    const refusedConnect = await sendClaudeInboxMessage(capability, MESSAGE);
    assert.deepEqual(refusedConnect, { disposition: "refused", reason: "connect_failed" });
    assertNoSecrets(refusedConnect);

    install(() => { throw new Error("connector failure"); });
    assert.deepEqual(await sendClaudeInboxMessage(capability, MESSAGE), { disposition: "refused", reason: "connect_failed" });

    const unknown = (reason: string) => ({ disposition: "unknown", reason, launchId: "launch-682" });

    install((socket) => { socket.holdWrites = true; setImmediate(() => socket.emit("connect")); });
    assert.deepEqual(await sendClaudeInboxMessage(capability, MESSAGE, { deadlineMs: 100 }), unknown("deadline_exceeded"));
    assert.ok(fake.writes.length > 0, "bytes were handed over, so the outcome is unknown, not refused");

    install((socket) => {
      socket.holdWrites = true;
      socket.afterFirstWrite = (written) => written.destroy(new Error("EPIPE"));
      setImmediate(() => socket.emit("connect"));
    });
    assert.deepEqual(await sendClaudeInboxMessage(capability, MESSAGE), unknown("disconnected"));

    install((socket) => {
      socket.holdWrites = true;
      socket.afterFirstWrite = (written) => written.push(Buffer.from("ok\n"));
      setImmediate(() => socket.emit("connect"));
    });
    assert.deepEqual(await sendClaudeInboxMessage(capability, MESSAGE), unknown("unexpected_reply"));

    install((socket) => setImmediate(() => socket.push(Buffer.from("x"))));
    assert.deepEqual(await sendClaudeInboxMessage(capability, MESSAGE), { disposition: "refused", reason: "unexpected_reply" });

    const controller = new AbortController();
    // An earlier listener on a shared signal must not be able to suppress cancellation.
    controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
    install((socket) => {
      socket.holdWrites = true;
      socket.afterFirstWrite = () => controller.abort();
      setImmediate(() => socket.emit("connect"));
    });
    assert.deepEqual(await sendClaudeInboxMessage(capability, MESSAGE, { signal: controller.signal, deadlineMs: 1000 }), unknown("cancelled"));

    const early = new AbortController();
    install(() => setImmediate(() => early.abort()));
    assert.deepEqual(await sendClaudeInboxMessage(capability, MESSAGE, { signal: early.signal }), { disposition: "refused", reason: "cancelled" });
    assert.equal(fake.writes.length, 0);
    assert.equal(inbox.connections, 0, "fake transport never touched the real inbox");
  } finally {
    await inbox.close();
  }
});

test("a peer that drops the connection never yields a delivery claim and nothing is logged", { skip: !posix }, async () => {
  const inbox = await mockInbox((socket) => socket.destroy());
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  // Console only: the node:test reporter itself writes to process.stdout.
  let logged = 0;
  const count = () => { logged += 1; return true; };
  try {
    console.log = console.error = console.warn = console.info = console.debug = count;
    const result = await sendClaudeInboxMessage(capabilityFor(inbox.path), MESSAGE);
    Object.assign(console, originals);
    // Depending on when the drop is observed: before any byte (refused,
    // connect_failed), after bytes (unknown), or after the flush
    // (sent_unconfirmed, still unconfirmed). Never a delivery claim.
    assert.ok(
      result.disposition === "sent_unconfirmed"
        || result.disposition === "unknown"
        || (result.disposition === "refused" && result.reason === "connect_failed"),
      JSON.stringify(result),
    );
    if (result.disposition === "sent_unconfirmed") assert.equal(result.placement, "unconfirmed");
    assertNoSecrets(result, inbox.path);
    assert.equal(logged, 0, "the primitive logs nothing");
  } finally {
    Object.assign(console, originals);
    await inbox.close();
  }
});

test("refuses a matching socket whose namespace another user could replace, before any byte", { skip: !posix }, async () => {
  const cases: [string, number][] = [["world-writable parent", 0o777], ["group-writable parent", 0o770]];
  for (const [label, mode] of cases) {
    const directory = join(scratch, `open${nameSeq++}`);
    mkdirSync(directory);
    chmodSync(directory, mode);
    const inbox = await mockInbox(undefined, directory);
    try {
      const result = await sendClaudeInboxMessage(capabilityFor(inbox.path), MESSAGE);
      assert.deepEqual(result, { disposition: "refused", reason: "endpoint_unprotected" }, label);
      assert.equal(inbox.connections, 0, `${label}: no connection, so no token or message left the process`);
    } finally {
      await inbox.close();
    }
  }

  const real = join(scratch, `real${nameSeq++}`);
  mkdirSync(real, { mode: 0o700 });
  const aliased = join(scratch, `alias${nameSeq++}`);
  symlinkSync(real, aliased);
  const inbox = await mockInbox(undefined, real);
  try {
    const viaAlias = join(aliased, inbox.path.slice(real.length + 1));
    const result = await sendClaudeInboxMessage(capabilityFor(inbox.path, { socketPath: viaAlias }), MESSAGE);
    assert.deepEqual(result, { disposition: "refused", reason: "endpoint_unprotected" }, "a symlinked ancestor is refused");
    assert.equal(inbox.connections, 0);
  } finally {
    await inbox.close();
  }
});

test("accepts an owned socket under a sticky world-writable parent", { skip: !posix }, async () => {
  const directory = join(scratch, `sticky${nameSeq++}`);
  mkdirSync(directory);
  chmodSync(directory, 0o1777);
  const inbox = await mockInbox(undefined, directory);
  try {
    const result = await sendClaudeInboxMessage(capabilityFor(inbox.path), MESSAGE);
    assert.equal(result.disposition, "sent_unconfirmed", JSON.stringify(result));
    await within(inbox.ended, 5000, "peer end-of-stream");
    assert.equal(inbox.connections, 1);
  } finally {
    await inbox.close();
  }
});

test("an abort raised from either currency check is honored before any byte", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    const first = new AbortController();
    const abortOnFirst = capabilityFor(inbox.path, { isCurrent: () => { first.abort(); return true; } });
    assert.deepEqual(await sendClaudeInboxMessage(abortOnFirst, MESSAGE, { signal: first.signal }), { disposition: "refused", reason: "cancelled" });
    assert.equal(inbox.connections, 0, "the pre-connect abort is seen before connecting");

    let fake!: FakeSocket;
    setClaudeInboxConnectorForTests(() => {
      fake = new FakeSocket();
      setImmediate(() => fake.emit("connect"));
      return fake;
    });
    const second = new AbortController();
    let calls = 0;
    const abortOnSecond = capabilityFor(inbox.path, {
      isCurrent: () => { calls += 1; if (calls === 2) second.abort(); return true; },
    });
    assert.deepEqual(await sendClaudeInboxMessage(abortOnSecond, MESSAGE, { signal: second.signal }), { disposition: "refused", reason: "cancelled" });
    assert.equal(calls, 2);
    assert.equal(fake.writes.length, 0, "the post-connect abort stops the write");
    assert.equal(fake.writableEnded, false);
  } finally {
    await inbox.close();
  }
});

test("a deadline that expires during synchronous checks or the write is never reported as sent", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    let fake!: FakeSocket;
    let writeSpinMs = 0;
    let connectorCalls = 0;
    setClaudeInboxConnectorForTests(() => {
      connectorCalls += 1;
      fake = new FakeSocket();
      fake.writeSpinMs = writeSpinMs;
      setImmediate(() => fake.emit("connect"));
      return fake;
    });
    const slowFirstCheck = capabilityFor(inbox.path, { isCurrent: () => { spin(120); return true; } });
    assert.deepEqual(await sendClaudeInboxMessage(slowFirstCheck, MESSAGE, { deadlineMs: 50 }), { disposition: "refused", reason: "deadline_exceeded" });
    assert.equal(connectorCalls, 0, "expiry during preflight stops the connection");

    let calls = 0;
    const slowFinalCheck = capabilityFor(inbox.path, {
      isCurrent: () => { calls += 1; if (calls === 2) spin(120); return true; },
    });
    assert.deepEqual(await sendClaudeInboxMessage(slowFinalCheck, MESSAGE, { deadlineMs: 50 }), { disposition: "refused", reason: "deadline_exceeded" });
    assert.equal(fake.writes.length, 0, "expiry during the final validation stops the write");

    writeSpinMs = 120;
    const result = await sendClaudeInboxMessage(capabilityFor(inbox.path), MESSAGE, { deadlineMs: 50 });
    assert.deepEqual(result, { disposition: "unknown", reason: "deadline_exceeded", launchId: "launch-682" });
    assert.ok(fake.writes.length > 0, "bytes were handed over before expiry was observed");
    assert.equal(inbox.connections, 0);
  } finally {
    await inbox.close();
  }
});

test("a stalled endpoint lookup is bounded by the deadline and cancellation, and never continues later", { skip: !posix }, async () => {
  const inbox = await mockInbox();
  try {
    let connectorCalls = 0;
    let connected = false;
    let fake: FakeSocket | undefined;
    setClaudeInboxConnectorForTests(() => {
      connectorCalls += 1;
      const socket = new FakeSocket();
      fake = socket;
      setImmediate(() => { connected = true; socket.emit("connect"); });
      return socket;
    });
    const real = (path: string): Promise<BigIntStats> => lstat(path, { bigint: true });
    const pending: (() => void)[] = [];
    let lookupCalls = 0;
    let stallActive = true;
    /** When set, only a lookup of exactly this path stalls. */
    let stallAt: string | undefined;
    // A stalled lookup captures a real stat now and withholds it until released.
    const lookup = (path: string): Promise<BigIntStats> => {
      lookupCalls += 1;
      if (!stallActive || (stallAt !== undefined && path !== stallAt)) return real(path);
      const stats = lstatSync(path, { bigint: true });
      return new Promise((resolve) => { pending.push(() => resolve(stats)); });
    };
    // Deliver the withheld (successful) result after the attempt settled: the
    // walk must stop there and never start another lookup, connect, or write.
    const releaseAndSettle = async () => {
      assert.equal(pending.length, 1, "exactly one lookup was in flight");
      const calls = lookupCalls;
      stallActive = false;
      for (const release of pending.splice(0)) release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(lookupCalls, calls, "a settled attempt never starts another lookup");
    };

    // The first (pre-connect) lookup never completes in time.
    setClaudeInboxLstatForTests(lookup);
    let started = performance.now();
    assert.deepEqual(await sendClaudeInboxMessage(capabilityFor(inbox.path), MESSAGE, { deadlineMs: 100 }), { disposition: "refused", reason: "deadline_exceeded" });
    assert.ok(performance.now() - started < 1000, "the deadline bounds a stalled lookup");
    assert.equal(connectorCalls, 0);
    await releaseAndSettle();
    assert.equal(connectorCalls, 0, "a late lookup result never continues the attempt");

    // The post-connect recheck stalls on the first ancestor ("/"), covering the
    // stop check inside the namespace walk; the first case covers the socket stat.
    stallActive = true;
    stallAt = "/";
    setClaudeInboxLstatForTests((path) => (connected ? lookup(path) : real(path)));
    started = performance.now();
    assert.deepEqual(await sendClaudeInboxMessage(capabilityFor(inbox.path), MESSAGE, { deadlineMs: 100 }), { disposition: "refused", reason: "deadline_exceeded" });
    assert.ok(performance.now() - started < 1000);
    assert.equal(connectorCalls, 1);
    assert.equal(fake?.writes.length, 0, "no byte before the recheck completes");
    await releaseAndSettle();
    assert.equal(fake?.writes.length, 0, "a late recheck result never writes");

    // Cancellation also bounds a stalled lookup.
    connected = false;
    stallActive = true;
    stallAt = undefined;
    setClaudeInboxLstatForTests(lookup);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    started = performance.now();
    assert.deepEqual(await sendClaudeInboxMessage(capabilityFor(inbox.path), MESSAGE, { signal: controller.signal }), { disposition: "refused", reason: "cancelled" });
    assert.ok(performance.now() - started < 1000);
    await releaseAndSettle();
    assert.equal(connectorCalls, 1, "no connection after cancellation");
    assert.equal(inbox.connections, 0);
  } finally {
    await inbox.close();
  }
});
