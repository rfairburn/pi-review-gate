/**
 * Native Windows Claude hook forwarding client (#682), portable tests.
 *
 * The module is inactive. These tests drive it against a local fake socket
 * (and once against a real local Node socket in an owned scratch directory)
 * to pin the fixed HELLO1/PROOF grammar (LF or CRLF terminator) and HMAC
 * dialect, proof-before-record
 * ordering on the same connection, the synchronous currency fence, bounded
 * time and output, closed results, single settlement, and cleanup. All keys,
 * run ids, and records are inert test values. This is NOT Windows evidence.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer, connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as forwarderModule from "../src/session-host/native-windows-claude-hook-forwarder";
import {
  WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS,
  WINDOWS_CLAUDE_HOOK_NOT_SENT_REASONS,
  WINDOWS_CLAUDE_HOOK_PIPE_PREFIX,
  WINDOWS_CLAUDE_HOOK_PROOF_CONTEXT,
  WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES,
  WINDOWS_CLAUDE_HOOK_UNKNOWN_REASONS,
  forwardWindowsClaudeHookRecordOnce,
  type WindowsClaudeHookForwardRequest,
  type WindowsClaudeHookForwardResult,
  type WindowsClaudeHookForwardSeams,
} from "../src/session-host/native-windows-claude-hook-forwarder";

const PROJECT_ROOT = join(__dirname, "..", "..");
const MODULE_SOURCE_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-hook-forwarder.ts");

const PIPE = `${WINDOWS_CLAUDE_HOOK_PIPE_PREFIX}0123456789abcdef0123456789abcdef`;
const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const RUN_ID = "run-1.test:a_b";
const RECORD = Buffer.from('{"inert":"record"}\n', "utf8");

/* -------------------------------------------------------------- fixtures */

class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  readonly pendingWriteCallbacks: Array<(error?: Error | null) => void> = [];
  autoCompleteWrites = true;
  ended = 0;
  destroyed = 0;
  throwOnWrite = false;
  emitErrorOnDestroy = false;

  write(data: string | Uint8Array, callback: (error?: Error | null) => void): boolean {
    if (this.throwOnWrite) throw new Error("fake write throw");
    this.writes.push(Buffer.from(typeof data === "string" ? Buffer.from(data, "utf8") : data));
    if (this.autoCompleteWrites) queueMicrotask(() => callback(null));
    else this.pendingWriteCallbacks.push(callback);
    return true;
  }

  end(): this {
    this.ended += 1;
    return this;
  }

  destroy(): this {
    this.destroyed += 1;
    if (this.emitErrorOnDestroy) this.emit("error", new Error("late destroy error"));
    return this;
  }
}

interface Harness {
  readonly promise: Promise<WindowsClaudeHookForwardResult>;
  readonly sockets: FakeSocket[];
  readonly connectCalls: string[];
  readonly counters: { record: number; fence: number };
  readonly timers: Array<{ callback: () => void; ms: number; cleared: boolean }>;
  settledCount(): number;
}

interface HarnessOptions {
  readonly request?: Partial<Record<keyof WindowsClaudeHookForwardRequest, unknown>>;
  readonly fence?: (call: number) => unknown;
  readonly record?: () => unknown;
  readonly prepare?: (socket: FakeSocket) => void;
  readonly connect?: (pipe: string) => unknown;
  readonly now?: () => number;
}

function start(options: HarnessOptions = {}): Harness {
  const sockets: FakeSocket[] = [];
  const connectCalls: string[] = [];
  const counters = { record: 0, fence: 0 };
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  let settled = 0;
  const seams: WindowsClaudeHookForwardSeams = {
    connect: (pipe: string) => {
      connectCalls.push(pipe);
      if (options.connect) return options.connect(pipe) as FakeSocket;
      const socket = new FakeSocket();
      options.prepare?.(socket);
      sockets.push(socket);
      return socket;
    },
    setTimer: (callback, ms) => {
      const entry = { callback, ms, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    ...(options.now ? { now: options.now } : {}),
  };
  const request = {
    pipe: PIPE,
    runId: RUN_ID,
    key: KEY,
    isCurrent: () => {
      counters.fence += 1;
      return options.fence ? options.fence(counters.fence) : true;
    },
    record: () => {
      counters.record += 1;
      return options.record ? options.record() : RECORD;
    },
    ...options.request,
  } as unknown as WindowsClaudeHookForwardRequest;
  const promise = forwardWindowsClaudeHookRecordOnce(request, seams);
  promise.then(() => {
    settled += 1;
  });
  return { promise, sockets, connectCalls, counters, timers, settledCount: () => settled };
}

function proofFor(nonce: string, runId = RUN_ID, key: string | Buffer = KEY): string {
  const mac = createHmac("sha256", typeof key === "string" ? Buffer.from(key, "ascii") : key)
    .update(`prg682-hook-v1|${runId}|${nonce}`, "ascii")
    .digest("hex");
  return `PROOF ${mac}\n`;
}

function helloNonce(socket: FakeSocket): string {
  assert.ok(socket.writes.length >= 1, "HELLO1 was written");
  const hello = socket.writes[0].toString("latin1");
  assert.match(hello, /^HELLO1 [0-9a-f]{32}\n$/u);
  return hello.slice(7, 39);
}

function connectAndGetNonce(h: Harness): { socket: FakeSocket; nonce: string } {
  assert.equal(h.sockets.length, 1);
  const socket = h.sockets[0];
  socket.emit("connect");
  return { socket, nonce: helloNonce(socket) };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function assertCleaned(socket: FakeSocket): void {
  assert.equal(socket.destroyed, 1, "socket destroyed exactly once");
  for (const event of ["connect", "data", "end", "close"]) assert.equal(socket.listenerCount(event), 0, `${event} listener removed`);
  assert.equal(socket.listenerCount("error"), 1, "only the swallowing error listener remains");
  // A late error after teardown is never unhandled.
  assert.doesNotThrow(() => socket.emit("error", new Error("late")));
}

function assertNoRecordBytes(h: Harness, socket: FakeSocket | undefined): void {
  if (socket) {
    assert.ok(socket.writes.length <= 1, "at most the HELLO1 frame was written");
    for (const chunk of socket.writes) {
      assert.equal(chunk.indexOf(RECORD), -1, "no record bytes written");
      assert.equal(chunk.toString("latin1").includes(KEY), false, "key never written");
    }
  }
}

/* --------------------------------------------------------------- success */

test("valid same-connection proof hands the record off exactly once", async () => {
  const h = start();
  assert.deepEqual(h.connectCalls, [PIPE]);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS);
  const { socket, nonce } = connectAndGetNonce(h);
  assert.equal(h.counters.record, 0, "no record materialization before proof");
  assert.equal(socket.writes[0].toString("latin1").includes(RUN_ID), false, "run id is not sent");
  socket.emit("data", Buffer.from(proofFor(nonce), "latin1"));
  await tick(); // the proof stays provisional until the I/O turn ends
  assert.equal(h.counters.record, 1);
  assert.equal(h.counters.fence, 3, "fence checked at start, before materialization, and before write");
  const result = await h.promise;
  assert.deepEqual(result, { disposition: "handed-off", reason: "write-completed" });
  assert.ok(Object.isFrozen(result));
  assert.equal(socket.writes.length, 2);
  assert.deepEqual(socket.writes[1], RECORD);
  assert.equal(socket.ended, 1);
  assert.equal(h.timers[0].cleared, true);
  assertCleaned(socket);
  // Later peer events change nothing.
  socket.emit("data", Buffer.from("PROOF x\n"));
  socket.emit("end");
  socket.emit("close");
  await tick();
  assert.equal(h.settledCount(), 1);
  assert.equal(h.counters.record, 1);
  assert.equal(h.connectCalls.length, 1, "no retry");
});

test("a proof split byte by byte is accepted", async () => {
  const h = start();
  const { socket, nonce } = connectAndGetNonce(h);
  for (const byte of Buffer.from(proofFor(nonce), "latin1")) {
    assert.equal(h.counters.record, 0);
    socket.emit("data", Buffer.from([byte]));
  }
  assert.deepEqual(await h.promise, { disposition: "handed-off", reason: "write-completed" });
});

test("a CRLF-terminated proof is accepted, whole or with CR and LF in separate chunks", async () => {
  const splits: Array<(frame: string) => string[]> = [
    (frame) => [frame],
    (frame) => [frame.slice(0, -1), frame.slice(-1)],
    (frame) => [frame.slice(0, -2), frame.slice(-2, -1), frame.slice(-1)],
  ];
  for (const split of splits) {
    const h = start();
    const { socket, nonce } = connectAndGetNonce(h);
    const frame = proofFor(nonce).replace("\n", "\r\n");
    const parts = split(frame);
    for (const [index, part] of parts.entries()) {
      if (index < parts.length - 1) {
        socket.emit("data", Buffer.from(part, "latin1"));
        assert.equal(h.counters.record, 0, "no materialization before the terminator completes");
      } else socket.emit("data", Buffer.from(part, "latin1"));
    }
    assert.deepEqual(await h.promise, { disposition: "handed-off", reason: "write-completed" });
    assert.deepEqual(socket.writes[1], RECORD);
  }
  for (const event of ["end", "close"] as const) {
    // CR received but the LF never arrives.
    const h = start();
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce).replace("\n", "\r"), "latin1"));
    socket.emit(event);
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "proof-malformed" }, event);
    assert.equal(h.counters.record, 0);
    assertNoRecordBytes(h, socket);
    assertCleaned(socket);
  }
  {
    // CR received, then the deadline fires before any LF.
    const h = start();
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce).replace("\n", "\r"), "latin1"));
    assert.equal(h.counters.record, 0);
    h.timers[0].callback();
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "timeout" });
    assert.equal(h.counters.record, 0);
    assertNoRecordBytes(h, socket);
    assertCleaned(socket);
  }
});

test("each invocation uses a fresh nonce", async () => {
  const nonces = new Set<string>();
  for (let i = 0; i < 4; i += 1) {
    const h = start();
    const { socket, nonce } = connectAndGetNonce(h);
    nonces.add(nonce);
    socket.emit("end");
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "proof-absent" });
  }
  assert.equal(nonces.size, 4);
});

test("record exactly at the shared bound is written; one root SessionStart-sized record fits", async () => {
  const max = Buffer.alloc(WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES, 0x61);
  const h = start({ record: () => max });
  const { socket, nonce } = connectAndGetNonce(h);
  socket.emit("data", Buffer.from(proofFor(nonce)));
  assert.equal((await h.promise).disposition, "handed-off");
  assert.equal(socket.writes[1].length, WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES);

  const longPath = `C:\\${"p".repeat(1024)}`;
  const sessionStart = JSON.stringify({
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: longPath,
    cwd: longPath,
    hook_event_name: "SessionStart",
    source: "startup",
    token: "t".repeat(4096),
  });
  assert.ok(Buffer.byteLength(sessionStart) + 1 <= WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES);
});

/* --------------------------------------------------------- HMAC dialect */

test("only the exact HMAC dialect is accepted; foreign, stale, and variant proofs are refused", async () => {
  const variants: Array<[string, (nonce: string) => string]> = [
    ["hex-decoded key", (n) => proofFor(n, RUN_ID, Buffer.from(KEY, "hex"))],
    ["foreign key", (n) => proofFor(n, RUN_ID, "f".repeat(64))],
    ["foreign run", (n) => proofFor(n, "run-2")],
    ["stale nonce", () => proofFor("0".repeat(32))],
    [
      "other context",
      (n) => `PROOF ${createHmac("sha256", KEY).update(`prg682-hook-v2|${RUN_ID}|${n}`).digest("hex")}\n`,
    ],
    [
      "other separator",
      (n) => `PROOF ${createHmac("sha256", KEY).update(`prg682-hook-v1:${RUN_ID}:${n}`).digest("hex")}\n`,
    ],
    ["sha1-length padded", (n) => `PROOF ${createHmac("sha1", KEY).update(`prg682-hook-v1|${RUN_ID}|${n}`).digest("hex")}${"0".repeat(24)}\n`],
  ];
  for (const [label, make] of variants) {
    const h = start();
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(make(nonce), "latin1"));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "proof-mismatch" }, label);
    assert.equal(h.counters.record, 0, label);
    assertNoRecordBytes(h, socket);
    assertCleaned(socket);
  }
});

test("a proof replayed from an earlier connection is refused on a new connection", async () => {
  const first = start();
  const a = connectAndGetNonce(first);
  const replay = proofFor(a.nonce);
  a.socket.emit("data", Buffer.from(replay));
  assert.equal((await first.promise).disposition, "handed-off");
  const second = start();
  const b = connectAndGetNonce(second);
  b.socket.emit("data", Buffer.from(replay));
  assert.deepEqual(await second.promise, { disposition: "not-sent", reason: "proof-mismatch" });
  assert.equal(second.counters.record, 0);
  assertNoRecordBytes(second, b.socket);
});

/* -------------------------------------------------------- malformed frames */

test("malformed, terminated-wrong, or oversized proof frames send nothing", async () => {
  const good = (n: string): string => proofFor(n);
  const cases: Array<[string, (nonce: string) => Buffer[]]> = [
    ["uppercase hex", (n) => [Buffer.from(good(n).toUpperCase())]],
    ["bare CR inside the hex", (n) => [Buffer.from(`${good(n).slice(0, 40)}\r`)]],
    ["CR then non-LF", (n) => [Buffer.from(good(n).replace("\n", "\rx"))]],
    ["CRCRLF", (n) => [Buffer.from(good(n).replace("\n", "\r\r\n"))]],
    ["LFCR", (n) => [Buffer.from(good(n).replace("\n", "\n\r"))]],
    ["CRLF then trailing byte", (n) => [Buffer.from(good(n).replace("\n", "\r\nx"))]],
    ["CRLF then trailing byte next chunk", (n) => [Buffer.from(good(n).replace("\n", "\r")), Buffer.from("\nx")]],
    ["trailing byte same turn", (n) => [Buffer.from(`${good(n)}x`)]],
    ["LF followed by a separate same-turn chunk", (n) => [Buffer.from(good(n)), Buffer.from("x")]],
    ["CRLF followed by a separate same-turn chunk", (n) => [Buffer.from(good(n).replace("\n", "\r\n")), Buffer.from("x")]],
    ["second line same turn", (n) => [Buffer.from(`${good(n)}${good(n)}`)]],
    ["63 hex", (n) => [Buffer.from(`${good(n).slice(0, 69)}\n`)]],
    ["65 hex", (n) => [Buffer.from(`${good(n).slice(0, 70)}0\n`)]],
    ["lowercase verb", (n) => [Buffer.from(good(n).replace("PROOF", "proof"))]],
    ["double space", (n) => [Buffer.from(good(n).replace("PROOF ", "PROOF  "))]],
    ["leading space", (n) => [Buffer.from(` ${good(n)}`)]],
    ["empty line", () => [Buffer.from("\n")]],
    ["NUL", (n) => [Buffer.from(good(n).replace("PROOF ", "PROOF\0"))]],
    ["multibyte", () => [Buffer.from("PROOF \u00e9", "utf8")]],
    ["oversized garbage", () => [Buffer.alloc(1024 * 1024, 0x41)]],
    ["string chunk", (n) => [good(n) as unknown as Buffer]],
    ["trailing after split frame", (n) => [Buffer.from(good(n).slice(0, 10)), Buffer.from(`${good(n).slice(10)}\n`)]],
  ];
  for (const [label, frames] of cases) {
    const h = start();
    const { socket, nonce } = connectAndGetNonce(h);
    for (const frame of frames(nonce)) socket.emit("data", frame);
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "proof-malformed" }, label);
    assert.equal(h.counters.record, 0, label);
    assertNoRecordBytes(h, socket);
    assertCleaned(socket);
  }
});

test("a partial proof followed by EOF, close, or error sends nothing", async () => {
  for (const event of ["end", "close"] as const) {
    const h = start();
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce).slice(0, 70)));
    socket.emit(event);
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "proof-malformed" }, event);
    assert.equal(h.counters.record, 0);
    assertCleaned(socket);
  }
  const h = start();
  const { socket, nonce } = connectAndGetNonce(h);
  socket.emit("data", Buffer.from(proofFor(nonce).slice(0, 30)));
  socket.emit("error", new Error("secret-bearing raw error text"));
  const result = await h.promise;
  assert.deepEqual(result, { disposition: "not-sent", reason: "connection-lost" });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assertCleaned(socket);
});

test("absent proof: EOF/close without bytes, data before HELLO1, connect failures", async () => {
  for (const event of ["end", "close"] as const) {
    const h = start();
    const { socket } = connectAndGetNonce(h);
    socket.emit(event);
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "proof-absent" }, event);
    assertCleaned(socket);
  }
  {
    const h = start();
    h.sockets[0].emit("data", Buffer.from("PROOF "));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "proof-malformed" });
    assert.equal(h.sockets[0].writes.length, 0, "nothing written before connect");
  }
  for (const event of ["error", "close"] as const) {
    const h = start();
    h.sockets[0].emit(event, new Error("refused"));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "connect-failed" }, event);
    assert.equal(h.sockets[0].writes.length, 0);
    assertCleaned(h.sockets[0]);
  }
  {
    const h = start({ connect: () => {
      throw new Error("connect throw");
    } });
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "connect-failed" });
    assert.equal(h.counters.record, 0);
    assert.equal(h.timers[0].cleared, true);
  }
  {
    // HELLO1 write failure before any proof.
    const h = start({ prepare: (s) => {
      s.autoCompleteWrites = false;
    } });
    const socket = h.sockets[0];
    socket.emit("connect");
    socket.pendingWriteCallbacks[0](new Error("hello failed"));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "connection-lost" });
    assertCleaned(socket);
  }
  {
    const h = start({ prepare: (s) => {
      s.throwOnWrite = true;
    } });
    h.sockets[0].emit("connect");
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "connection-lost" });
  }
});

/* ------------------------------------------------------------------ fence */

test("the synchronous currency fence gates connection, materialization, and write", async () => {
  {
    const h = start({ fence: () => false });
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "stale" });
    assert.equal(h.connectCalls.length, 0, "stale before connect: no connection");
    assert.equal(h.timers.length, 0);
  }
  for (const verdict of [false, 1, "true", undefined, "throw"] as const) {
    const h = start({
      fence: (call) => {
        if (call < 2) return true;
        if (verdict === "throw") throw new Error("fence");
        return verdict;
      },
    });
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce)));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "stale" }, String(verdict));
    assert.equal(h.counters.record, 0, "no materialization when stale before it");
    assertNoRecordBytes(h, socket);
    assertCleaned(socket);
  }
  {
    // Stale between materialization and write: materialized but never written.
    const h = start({ fence: (call) => call < 3 });
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce)));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "stale" });
    assert.equal(h.counters.record, 1);
    assertNoRecordBytes(h, socket);
    assertCleaned(socket);
  }
});

/* ----------------------------------------------------------------- record */

test("an invalid or oversized record is never written", async () => {
  const cases: Array<[string, () => unknown]> = [
    ["throws", () => {
      throw new Error("record secret");
    }],
    ["string", () => RECORD.toString("utf8")],
    ["empty", () => Buffer.alloc(0)],
    ["oversized", () => Buffer.alloc(WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES + 1, 0x61)],
    ["array", () => Array.from(RECORD)],
    ["undefined", () => undefined],
  ];
  for (const [label, record] of cases) {
    const h = start({ record });
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce)));
    const result = await h.promise;
    assert.deepEqual(result, { disposition: "not-sent", reason: "record-invalid" }, label);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(socket.writes.length, 1, label);
    assertCleaned(socket);
  }
});

test("record brand and length come from internal slots, not shadowable properties", async () => {
  const shadowedSmall = new Uint8Array(WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES + 1).fill(0x61);
  Object.defineProperty(shadowedSmall, "byteLength", { value: 10 });
  Object.defineProperty(shadowedSmall, "length", { value: 10 });
  const fakeReceiver = Object.create(Uint8Array.prototype) as Uint8Array;
  const throwingLength = new Uint8Array(4);
  Object.defineProperty(throwingLength, "byteLength", {
    get() {
      throw new Error("getter");
    },
  });
  const tagged = { [Symbol.toStringTag]: "Uint8Array", byteLength: 4 };
  const cases: Array<[string, () => unknown, boolean]> = [
    ["shadowed byteLength over the bound", () => shadowedSmall, false],
    ["inherited prototype without a typed array", () => fakeReceiver, false],
    ["Uint16Array", () => new Uint16Array(4), false],
    ["DataView", () => new DataView(new ArrayBuffer(4)), false],
    ["toStringTag impostor", () => tagged, false],
    ["throwing public byteLength on a genuine array", () => throwingLength, true],
  ];
  for (const [label, record, accepted] of cases) {
    const h = start({ record });
    const { socket, nonce } = connectAndGetNonce(h);
    assert.doesNotThrow(() => socket.emit("data", Buffer.from(proofFor(nonce))), label);
    const result = await h.promise;
    if (accepted) {
      assert.deepEqual(result, { disposition: "handed-off", reason: "write-completed" }, label);
      assert.equal(socket.writes[1].length, 4, label);
    } else {
      assert.deepEqual(result, { disposition: "not-sent", reason: "record-invalid" }, label);
      assert.equal(socket.writes.length, 1, label);
    }
    assertCleaned(socket);
  }
});

test("the written record is a private copy of the true view contents", async () => {
  const backing = new Uint8Array([0x78, 0x41, 0x42, 0x43, 0x79]);
  const view = backing.subarray(1, 4);
  Object.defineProperty(view, "byteOffset", { value: 0 });
  Object.defineProperty(view, "buffer", { value: new Uint8Array([0x5a, 0x5a, 0x5a, 0x5a, 0x5a]).buffer });
  const h = start({ prepare: (s) => {
    s.autoCompleteWrites = false;
  }, record: () => view });
  const socket = h.sockets[0];
  socket.emit("connect");
  socket.emit("data", Buffer.from(proofFor(helloNonce(socket))));
  await tick(); // the proof stays provisional until the I/O turn ends
  assert.equal(socket.writes.length, 2);
  assert.deepEqual([...socket.writes[1]], [0x41, 0x42, 0x43]);
  socket.pendingWriteCallbacks[1](null);
  assert.deepEqual(await h.promise, { disposition: "handed-off", reason: "write-completed" });
});

test("a fence or producer that cancels is honoured before materialization and write", async () => {
  {
    // The initial fence cancels and still answers true: no connection.
    const controller = new AbortController();
    const h = start({
      request: { signal: controller.signal },
      fence: () => {
        controller.abort();
        return true;
      },
    });
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "cancelled" });
    assert.equal(h.connectCalls.length, 0);
  }
  for (const abortOnCall of [2, 3]) {
    // Pre-materialization (2) or pre-write (3) fence cancels and still answers true.
    const controller = new AbortController();
    const h = start({
      request: { signal: controller.signal },
      fence: (call) => {
        if (call === abortOnCall) controller.abort();
        return true;
      },
    });
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce)));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "cancelled" }, String(abortOnCall));
    assert.equal(h.counters.record, abortOnCall === 2 ? 0 : 1, String(abortOnCall));
    assert.equal(socket.writes.length, 1, "only HELLO1 was written");
    assertNoRecordBytes(h, socket);
    assertCleaned(socket);
  }
});

test("a monotonic deadline is enforced after synchronous call-outs even if the timer has not fired", async () => {
  const START = 1000;
  const cases: Array<[string, number | "producer" | "before-proof", number]> = [
    ["clock passes the deadline before the proof arrives", "before-proof", 0],
    ["pre-materialization fence overruns", 2, 0],
    ["record producer overruns", "producer", 1],
    ["pre-write fence overruns", 3, 1],
  ];
  for (const [label, when, expectedRecordCalls] of cases) {
    let clock = START;
    const overrun = (): void => {
      clock = START + WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS;
    };
    const h = start({
      now: () => clock,
      fence: (call) => {
        if (call === when) overrun();
        return true;
      },
      record: () => {
        if (when === "producer") overrun();
        return RECORD;
      },
    });
    const { socket, nonce } = connectAndGetNonce(h);
    if (when === "before-proof") overrun();
    socket.emit("data", Buffer.from(proofFor(nonce)));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "timeout" }, label);
    assert.equal(h.counters.record, expectedRecordCalls, label);
    assert.equal(h.timers[0].cleared, true, `${label}: timer never fired and is cleared`);
    assertNoRecordBytes(h, socket);
    assertCleaned(socket);
  }
  {
    // Just inside the deadline still hands off.
    let calls = 0;
    const h = start({ now: () => (calls++ === 0 ? START : START + WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS - 1) });
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce)));
    assert.equal((await h.promise).disposition, "handed-off");
  }
  for (const bad of [() => Number.NaN, () => Number.POSITIVE_INFINITY, () => "1" as unknown as number]) {
    const h = start({ now: bad });
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "input-invalid" });
    assert.equal(h.connectCalls.length, 0);
  }
  {
    // A clock that later fails counts as expired.
    let calls = 0;
    const h = start({ now: () => {
      calls += 1;
      if (calls > 1) throw new Error("clock");
      return START;
    } });
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce)));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "timeout" });
    assert.equal(h.counters.record, 0);
  }
});

/* ------------------------------------------------- timer and cancellation */

test("synchronous timer settlement clears the returned handle without subscribing or connecting", async () => {
  const { signal } = new AbortController();
  const handle = {};
  const cleared: unknown[] = [];
  let connects = 0;
  let records = 0;
  const result = await forwardWindowsClaudeHookRecordOnce(
    {
      pipe: PIPE,
      runId: RUN_ID,
      key: KEY,
      isCurrent: () => true,
      record: () => {
        records += 1;
        return RECORD;
      },
      signal,
    },
    {
      connect: () => {
        connects += 1;
        return new FakeSocket();
      },
      setTimer: (callback) => {
        callback();
        return handle;
      },
      clearTimer: (timer) => {
        cleared.push(timer);
      },
    },
  );
  assert.deepEqual(result, { disposition: "not-sent", reason: "timeout" });
  assert.equal(connects, 0);
  assert.equal(records, 0);
  assert.deepEqual(cleared, [handle]);
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

test("settlement during the provisional proof turn cancels the pending handoff", async () => {
  for (const settle of ["end", "close", "error", "timer"] as const) {
    const h = start();
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce)));
    if (settle === "timer") h.timers[0].callback();
    else socket.emit(settle, new Error("x"));
    const result = await h.promise;
    assert.equal(result.disposition, "not-sent", settle);
    await tick();
    assert.equal(h.counters.record, 0, settle);
    assertNoRecordBytes(h, socket);
    assertCleaned(socket);
  }
});

test("one deadline: before proof is not-sent, during the record write is unknown", async () => {
  {
    const h = start();
    h.timers[0].callback();
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "timeout" });
    assert.equal(h.sockets[0].writes.length, 0);
    assertCleaned(h.sockets[0]);
  }
  {
    const h = start();
    const { socket } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from("PROOF 0123"));
    h.timers[0].callback();
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "timeout" });
    assert.equal(h.counters.record, 0);
    assertCleaned(socket);
  }
  {
    const h = start({ prepare: (s) => {
      s.autoCompleteWrites = false;
    } });
    const socket = h.sockets[0];
    socket.emit("connect");
    socket.pendingWriteCallbacks.shift()?.(null);
    socket.emit("data", Buffer.from(proofFor(helloNonce(socket))));
    await tick(); // the proof stays provisional until the I/O turn ends
    assert.equal(socket.writes.length, 2, "record write began");
    h.timers[0].callback();
    assert.deepEqual(await h.promise, { disposition: "unknown", reason: "timeout" });
    // A late write completion does not change the single result.
    socket.pendingWriteCallbacks.shift()?.(null);
    await tick();
    assert.equal(h.settledCount(), 1);
    assert.equal(socket.ended, 0);
    assertCleaned(socket);
  }
});

test("cancellation: before start, while awaiting proof, during materialization, during the write", async () => {
  {
    const controller = new AbortController();
    controller.abort();
    const h = start({ request: { signal: controller.signal } });
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "cancelled" });
    assert.equal(h.connectCalls.length, 0);
  }
  {
    // Shadowed listener methods are never used, and an earlier caller listener
    // that stops propagation on the shared signal cannot suppress cancellation.
    const controller = new AbortController();
    const signal = controller.signal;
    signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
    signal.addEventListener = () => {
      throw new Error("shadowed add");
    };
    signal.removeEventListener = () => {
      throw new Error("shadowed remove");
    };
    const h = start({ request: { signal } });
    assert.equal(getEventListeners(signal, "abort").length, 1, "only the caller's listener is on the shared signal");
    const { socket } = connectAndGetNonce(h);
    controller.abort();
    assert.equal(socket.destroyed, 1, "abort tears the socket down immediately despite stopped propagation");
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "cancelled" });
    assert.equal(h.counters.record, 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(h.timers[0].cleared, true);
    assertCleaned(h.sockets[0]);
  }
  {
    // Settlement for another reason also unsubscribes, even with a throwing shadowed remove.
    const controller = new AbortController();
    const signal = controller.signal;
    signal.removeEventListener = () => {
      throw new Error("shadowed remove");
    };
    const h = start({ request: { signal } });
    const { socket } = connectAndGetNonce(h);
    socket.emit("end");
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "proof-absent" });
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assertCleaned(socket);
  }
  {
    // A shadowed `aborted` property cannot hide a real cancellation.
    const controller = new AbortController();
    const signal = controller.signal;
    Object.defineProperty(signal, "aborted", { value: false });
    controller.abort();
    const h = start({ request: { signal } });
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "cancelled" });
    assert.equal(h.connectCalls.length, 0);
  }
  {
    // The record producer itself aborts: the materialized record is not written.
    const controller = new AbortController();
    const h = start({
      request: { signal: controller.signal },
      record: () => {
        controller.abort();
        return RECORD;
      },
    });
    const { socket, nonce } = connectAndGetNonce(h);
    socket.emit("data", Buffer.from(proofFor(nonce)));
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "cancelled" });
    assertNoRecordBytes(h, socket);
  }
  {
    // Cancellation while the record write is pending, with propagation stopped on the shared signal.
    const controller = new AbortController();
    controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
    const h = start({ request: { signal: controller.signal }, prepare: (s) => {
      s.autoCompleteWrites = false;
    } });
    const socket = h.sockets[0];
    socket.emit("connect");
    socket.emit("data", Buffer.from(proofFor(helloNonce(socket))));
    await tick(); // the proof stays provisional until the I/O turn ends
    assert.equal(socket.writes.length, 2);
    controller.abort();
    assert.equal(socket.destroyed, 1, "abort tears down the pending write immediately");
    // A later successful write completion cannot turn the interrupted write into a handoff.
    socket.pendingWriteCallbacks[1](null);
    assert.deepEqual(await h.promise, { disposition: "unknown", reason: "cancelled" });
    assert.equal(socket.ended, 0);
    assertCleaned(socket);
  }
});

/* -------------------------------------------------------- uncertain writes */

test("a record write that does not complete cleanly is unknown, never retried", async () => {
  const outcomes: Array<[string, (s: FakeSocket) => void, WindowsClaudeHookForwardResult]> = [
    ["write callback error", (s) => s.pendingWriteCallbacks[1](new Error("EPIPE")), { disposition: "unknown", reason: "write-failed" }],
    ["error event", (s) => s.emit("error", new Error("reset")), { disposition: "unknown", reason: "connection-lost" }],
    ["close", (s) => s.emit("close"), { disposition: "unknown", reason: "connection-lost" }],
    ["end", (s) => s.emit("end"), { disposition: "unknown", reason: "connection-lost" }],
  ];
  for (const [label, disrupt, expected] of outcomes) {
    const h = start({ prepare: (s) => {
      s.autoCompleteWrites = false;
    } });
    const socket = h.sockets[0];
    socket.emit("connect");
    socket.emit("data", Buffer.from(proofFor(helloNonce(socket))));
    await tick(); // the proof stays provisional until the I/O turn ends
    disrupt(socket);
    assert.deepEqual(await h.promise, expected, label);
    assert.equal(h.counters.record, 1);
    assert.equal(h.connectCalls.length, 1, "no retry");
    assert.equal(socket.writes.length, 2, "record written at most once");
    assertCleaned(socket);
  }
  {
    // A write that throws synchronously is conservatively unknown.
    const h = start();
    const { socket, nonce } = connectAndGetNonce(h);
    socket.throwOnWrite = true;
    socket.emit("data", Buffer.from(proofFor(nonce)));
    assert.deepEqual(await h.promise, { disposition: "unknown", reason: "write-failed" });
  }
});

test("an error emitted during teardown is not unhandled", async () => {
  const h = start({ prepare: (s) => {
    s.emitErrorOnDestroy = true;
  } });
  const { socket } = connectAndGetNonce(h);
  assert.doesNotThrow(() => socket.emit("end"));
  assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "proof-absent" });
  assert.equal(socket.destroyed, 1);
});

/* ------------------------------------------------------------------ input */

test("strict input validation refuses before any connection", async () => {
  const bad: Array<Partial<Record<keyof WindowsClaudeHookForwardRequest, unknown>>> = [
    { pipe: PIPE.toUpperCase() },
    { pipe: `${PIPE}\n` },
    { pipe: PIPE.slice(0, -1) },
    { pipe: `${PIPE}0` },
    { pipe: PIPE.replace("0123456789abcdef0", "0123456789ABCDEF0") },
    { pipe: PIPE.replace("prg682-hook-", "prg682-ctl-") },
    { pipe: PIPE.replace("\\\\.\\pipe\\", "\\\\.\\pipe\\LOCAL\\") },
    { pipe: PIPE.replace("\\\\.\\", "\\\\?\\") },
    { pipe: PIPE.replace(/\\/gu, "/") },
    { pipe: 42 },
    { key: KEY.toUpperCase() },
    { key: KEY.slice(1) },
    { key: `${KEY}0` },
    { key: `${KEY.slice(1)}\n` },
    { key: Buffer.from(KEY) },
    { runId: "" },
    { runId: ".run" },
    { runId: "a|b" },
    { runId: "a\n" },
    { runId: "a b" },
    { runId: "r".repeat(129) },
    { runId: 7 },
    { record: RECORD },
    { isCurrent: true },
    { signal: { aborted: false } },
    { signal: Object.create(AbortSignal.prototype) },
    { signal: null },
  ];
  for (const override of bad) {
    const h = start({ request: override });
    assert.deepEqual(await h.promise, { disposition: "not-sent", reason: "input-invalid" }, JSON.stringify(Object.keys(override)));
    assert.equal(h.connectCalls.length, 0);
    assert.equal(h.counters.record, 0);
    assert.equal(h.timers.length, 0);
  }
  assert.deepEqual(await forwardWindowsClaudeHookRecordOnce(null as unknown as WindowsClaudeHookForwardRequest), {
    disposition: "not-sent",
    reason: "input-invalid",
  });
  const r = "r".repeat(128);
  const ok = start({ request: { runId: r } });
  const { socket, nonce } = connectAndGetNonce(ok);
  socket.emit("data", Buffer.from(proofFor(nonce, r)));
  assert.equal((await ok.promise).disposition, "handed-off");
});

test("results are closed codes only and never reflect inputs", async () => {
  assert.deepEqual([...WINDOWS_CLAUDE_HOOK_NOT_SENT_REASONS].sort(), [
    "cancelled",
    "connect-failed",
    "connection-lost",
    "input-invalid",
    "proof-absent",
    "proof-malformed",
    "proof-mismatch",
    "record-invalid",
    "stale",
    "timeout",
  ]);
  assert.deepEqual([...WINDOWS_CLAUDE_HOOK_UNKNOWN_REASONS].sort(), ["cancelled", "connection-lost", "timeout", "write-failed"]);
  const h = start();
  const { socket, nonce } = connectAndGetNonce(h);
  socket.emit("data", Buffer.from(proofFor(nonce)));
  const result = await h.promise;
  assert.deepEqual(Object.keys(result).sort(), ["disposition", "reason"]);
  const text = JSON.stringify(result);
  for (const secret of [KEY, RUN_ID, nonce, PIPE]) assert.equal(text.includes(secret), false);
});

/* ---------------------------------------------------- real local socket */

// POSIX only: Node listens on a filesystem socket path here; Windows would need a named-pipe path.
test("a real local Node socket round trip: one connection, proof, record, teardown", { skip: process.platform === "win32" }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "prg682-hook-fwd-"));
  const sockPath = join(scratch, "s");
  const serverSockets: Socket[] = [];
  const received: Buffer[] = [];
  let connections = 0;
  const server = createServer((peer) => {
    connections += 1;
    serverSockets.push(peer);
    let hello = "";
    let proved = false;
    peer.on("error", () => {});
    peer.on("data", (chunk) => {
      if (proved) {
        received.push(chunk);
        return;
      }
      hello += chunk.toString("latin1");
      if (hello.endsWith("\n")) {
        proved = true;
        peer.write(proofFor(hello.slice(7, 39)));
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });
    let client: Socket | undefined;
    const result = await forwardWindowsClaudeHookRecordOnce(
      {
        pipe: PIPE,
        runId: RUN_ID,
        key: KEY,
        isCurrent: () => true,
        record: () => RECORD,
      },
      {
        connect: () => {
          client = netConnect({ path: sockPath });
          return client;
        },
      },
    );
    assert.deepEqual(result, { disposition: "handed-off", reason: "write-completed" });
    assert.equal(connections, 1);
    assert.ok(client?.destroyed, "client socket destroyed");
    await new Promise<void>((resolve) => {
      const peer = serverSockets[0];
      if (peer.destroyed || peer.readableEnded) resolve();
      else peer.once("close", () => resolve());
    });
    assert.deepEqual(Buffer.concat(received), RECORD);
  } finally {
    for (const peer of serverSockets) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(existsSync(scratch), false, "owned scratch removed");
});

/* ------------------------------------------------- inactive module surface */

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

test("inactive: closed export surface, no logging or environment, no product caller", () => {
  assert.deepEqual(Object.keys(forwarderModule).sort(), [
    "WINDOWS_CLAUDE_HOOK_FORWARD_TIMEOUT_MS",
    "WINDOWS_CLAUDE_HOOK_NOT_SENT_REASONS",
    "WINDOWS_CLAUDE_HOOK_PIPE_PREFIX",
    "WINDOWS_CLAUDE_HOOK_PROOF_CONTEXT",
    "WINDOWS_CLAUDE_HOOK_RECORD_MAX_BYTES",
    "WINDOWS_CLAUDE_HOOK_UNKNOWN_REASONS",
    "forwardWindowsClaudeHookRecordOnce",
  ]);
  assert.equal(WINDOWS_CLAUDE_HOOK_PIPE_PREFIX, "\\\\.\\pipe\\prg682-hook-");
  assert.equal(WINDOWS_CLAUDE_HOOK_PROOF_CONTEXT, "prg682-hook-v1");
  assert.ok(Object.isFrozen(WINDOWS_CLAUDE_HOOK_NOT_SENT_REASONS) && Object.isFrozen(WINDOWS_CLAUDE_HOOK_UNKNOWN_REASONS));
  const moduleText = readFileSync(MODULE_SOURCE_PATH, "utf8");
  assert.ok(moduleText.endsWith("\n") && !moduleText.endsWith("\n\n"));
  const imports = [...moduleText.matchAll(/^import .* from "([^"]+)";$/gmu)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["node:crypto", "node:net"]);
  assert.doesNotMatch(moduleText, /\brequire\(|\bimport\(/u);
  assert.doesNotMatch(moduleText, /console\.|process\.|child_process|node:fs|\bspawn\(|\bfetch\(|new Function|\beval\(/u);
  // The one product caller is the #682 Windows root hook relay helper, which
  // runs only for a marked Windows Claude root SessionStart (no active code
  // issues that marker); its own tests pin that gating.
  const srcRoot = join(PROJECT_ROOT, "src");
  const relayHelper = join(srcRoot, "session-host", "native-windows-claude-hook-relay.ts");
  for (const file of listTs(srcRoot)) {
    if (file === MODULE_SOURCE_PATH || file === relayHelper) continue;
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("native-windows-claude-hook-forwarder"), `${file} must not import the inactive module`);
    assert.ok(!text.includes("forwardWindowsClaudeHookRecordOnce"), `${file} must not call the forwarder`);
  }
});
