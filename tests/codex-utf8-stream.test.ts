import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import type { ExecutorToolObservation, ExecutorTurn } from "../src/execution/types";

// #238: the Codex app-server adapter decoded each stdout/stderr `data` chunk
// independently with Buffer.toString("utf8"). A valid multibyte UTF-8 sequence
// straddling a chunk boundary was replaced by U+FFFD in the retained captures
// and in the JSON-RPC line buffer. These regressions drive the real production
// adapter against a controlled child that emits the same protocol content
// either split at multibyte byte boundaries — released only after the parent
// has observed each first half as its own data event (a deterministic
// chunk-boundary barrier, no timing) — or as intact chunks, and require the
// retained results to be byte-identical.

const AGENT_TEXT = "héllo wörld 日本語 🚀 café";
const NON_ASCII_PATH = "/tmp/café/日本語-notes.txt";
const DIAGNOSTIC = "警告: modèle 🚀 chargé";
const THREAD_ID = "thread-u8";
const TURN_ID = "turn-u8";

// Exact byte fixtures the controlled child emits, in protocol order. The RPC
// ids are deterministic for this flow: initialize=1, thread/start=2,
// turn/start=3, and (only when an abort follows) turn/interrupt=4.
const initResponseLine = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userAgent: "codex-u8-test/1.0" } }) + "\n");
const threadResponseLine = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: THREAD_ID } } }) + "\n");
const turnResponseLine = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { turn: { id: TURN_ID } } }) + "\n");
const interruptResponseLine = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 4, result: {} }) + "\n");
const agentMessageLine = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text: AGENT_TEXT } } }) + "\n");
const fileChangeLine = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "fileChange", id: "change-1", changes: [{ path: NON_ASCII_PATH, kind: "add" }] } } }) + "\n");
const turnCompletedLine = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" } } }) + "\n");
const diagnosticBytes = Buffer.from(DIAGNOSTIC, "utf8");

function splitAfterMarker(line: Buffer, marker: string, afterBytes: number): number {
  const start = line.indexOf(Buffer.from(marker, "utf8"));
  if (start < 0) throw new Error(`marker ${marker} not found in UTF-8 stream fixture`);
  return start + afterBytes;
}

// Split points land strictly inside multibyte sequences: 日 (3 bytes) cut
// after byte 1, 本 (3 bytes) cut after byte 2, 🚀 (4 bytes) cut after byte 2.
const AGENT_SPLIT = splitAfterMarker(agentMessageLine, "日", 1);
const FILE_SPLIT = splitAfterMarker(fileChangeLine, "本", 2);
const DIAGNOSTIC_SPLIT = splitAfterMarker(diagnosticBytes, "🚀", 2);

const agentPart1 = agentMessageLine.subarray(0, AGENT_SPLIT);
const agentPart2 = agentMessageLine.subarray(AGENT_SPLIT);
const filePart1 = fileChangeLine.subarray(0, FILE_SPLIT);
const filePart2 = fileChangeLine.subarray(FILE_SPLIT);
const diagnosticPart1 = diagnosticBytes.subarray(0, DIAGNOSTIC_SPLIT);
const diagnosticPart2 = diagnosticBytes.subarray(DIAGNOSTIC_SPLIT);

const EXPECTED_STDOUT_TEXT = Buffer.concat([
  initResponseLine, threadResponseLine, turnResponseLine, agentMessageLine, fileChangeLine, turnCompletedLine,
]).toString("utf8");
const EXPECTED_STDOUT_BYTES = initResponseLine.length + threadResponseLine.length + turnResponseLine.length
  + agentMessageLine.length + fileChangeLine.length + turnCompletedLine.length;

type StreamName = "stdout" | "stderr";

interface ChunkObserver {
  fifo: Buffer[];
  strict: boolean;
  popped: number;
  observed: Buffer[];
  mismatch?: { index: number; expectedHex: string | null; gotHex: string };
  waiters: Array<() => void>;
}

type ObserverState = Record<StreamName, ChunkObserver>;

function createObserver(fifo: Buffer[], strict: boolean): ChunkObserver {
  return { fifo, strict, popped: 0, observed: [], waiters: [] };
}

/** Records every parent-side data chunk; in strict mode each chunk must equal the next expected exact chunk. */
function observeChunk(stream: StreamName, chunk: Buffer, state: ObserverState): void {
  const observer = state[stream];
  const copy = Buffer.from(chunk);
  observer.observed.push(copy);
  if (!observer.strict) return;
  const expected: Buffer | undefined = observer.fifo[observer.popped];
  if (expected === undefined || !copy.equals(expected)) {
    observer.mismatch ??= { index: observer.popped, expectedHex: expected === undefined ? null : expected.toString("hex"), gotHex: copy.toString("hex") };
    return;
  }
  observer.popped += 1;
  for (const wake of observer.waiters.splice(0)) wake();
}

function waitForPopped(observer: ChunkObserver, index: number): Promise<void> {
  if (observer.popped > index) return Promise.resolve();
  return new Promise<void>((resolve) => {
    // observeChunk splices every waiter before invoking it, so a premature
    // wake (condition not yet met) must re-register itself for the next chunk.
    const wake = (): void => {
      if (observer.popped <= index) {
        observer.waiters.push(wake);
        return;
      }
      resolve();
    };
    observer.waiters.push(wake);
  });
}

function assertObservedExactly(stream: StreamName, state: ObserverState): void {
  const observer = state[stream];
  assert.equal(
    observer.mismatch,
    undefined,
    `${stream} chunk stream diverged from the expected exact chunks at index ${observer.mismatch?.index}: expected ${observer.mismatch?.expectedHex} got ${observer.mismatch?.gotHex}`,
  );
  assert.equal(observer.popped, observer.fifo.length, `${stream}: expected all ${observer.fifo.length} exact chunks observed, saw ${observer.popped}`);
}

async function withTimeout<T>(work: Promise<T>, label: string, ms = 20_000): Promise<T> {
  let guard: NodeJS.Timeout | undefined;
  const guardPromise = new Promise<never>((_, reject) => {
    guard = setTimeout(() => reject(new Error(`${label} did not settle within the bounded guard`)), ms);
    guard.unref?.();
  });
  try {
    return await Promise.race([work, guardPromise]);
  } finally {
    clearTimeout(guard);
  }
}

/**
 * Ephemeral loopback TCP barrier (portable on Windows/macOS/Linux; Node's net
 * module has no Unix-domain sockets on Windows): the child tags each half-write
 * with (stream, fifoIndex) and blocks until the parent confirms that exact
 * chunk was observed as its own data event. The deterministic byte-barrier
 * semantics are unchanged — no timing, no release past the observed index.
 *
 * Every connection is tracked from tag registration through close: a tag must
 * match the exact grammar (stdout|stderr):<index> with an in-range index, and
 * only one registration per socket and one connection per tag are accepted.
 * The raw go ACK for the registered connection of a valid tag is written only
 * after that tag's exact index has been observed as its own parent-side data
 * event, and the resulting clean close (ACK sent, consumed by the child,
 * orderly end/close on both sides, no socket error) can be awaited per tag via
 * waitForCleanClose — settlement is bound to the registered record, so a
 * duplicate or unidentifiable connection can never satisfy another tag's proof.
 * All server and per-socket errors — including ECONNRESET — are recorded in
 * `errors` for the calling test to assert instead of being thrown from
 * callbacks or left as unhandled rejections. Invalid or out-of-range tags,
 * duplicate tags, extra tagged data on a registered connection, and
 * connections that close without a successful valid ACK all fail closed:
 * invalid/duplicate connections are dropped without an ACK (so the child fails
 * promptly) and every pending proof waiter is rejected immediately — never
 * hung, never satisfied by another tag or connection. The first failure is
 * persistent: no further ACKs issue, later proof requests for any tag reject
 * with that failure, and close() joins every socket's close handler before
 * returning so recorded failures are visible to the caller.
 */
interface BarrierConnectionRecord {
  tag: string;
  stream: StreamName | undefined;
  index: number | undefined;
  registered: boolean;
  valid: boolean;
  observedBeforeAck: boolean;
  ackSent: boolean;
  endObserved: boolean;
  closed: boolean;
  error: Error | undefined;
}

interface BarrierServerHandle {
  endpoint: string;
  errors: Error[];
  waitForCleanClose(tag: string): Promise<void>;
  close(): Promise<void>;
}

async function startBarrierServer(state: ObserverState): Promise<BarrierServerHandle> {
  const openSockets = new Set<net.Socket>();
  const errors: Error[] = [];
  let barrierFailure: Error | undefined;
  const byTag = new Map<string, BarrierConnectionRecord>();
  const settledTags = new Map<string, boolean>();
  const tagWaiters = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>();

  const isClean = (record: BarrierConnectionRecord): boolean =>
    barrierFailure === undefined && record.valid && record.observedBeforeAck && record.ackSent && record.endObserved && record.error === undefined;

  // Terminal per-tag outcome: first settle wins (an errored or non-cleanly
  // closed connection can never become clean later), and dispatches exactly
  // the waiters registered for that tag — never another connection's close.
  const settleTag = (tag: string, clean: boolean, detail: string): void => {
    if (settledTags.has(tag)) return;
    settledTags.set(tag, clean);
    const waiters = tagWaiters.get(tag);
    if (waiters === undefined) return;
    tagWaiters.delete(tag);
    for (const waiter of waiters.splice(0)) {
      if (clean) waiter.resolve();
      else waiter.reject(new Error(detail));
    }
  };

  // Fatal barrier failure: once recorded, the failure is persistent — no proof
  // is trustworthy, every pending tag waiter is rejected immediately, and any
  // later proof request for any tag rejects with the same failure.
  const failAllPendingWaiters = (detail: string): void => {
    barrierFailure ??= new Error(detail);
    for (const [tag, waiters] of tagWaiters) {
      tagWaiters.delete(tag);
      settledTags.set(tag, false);
      for (const waiter of waiters.splice(0)) waiter.reject(barrierFailure);
    }
  };

  const failBarrier = (error: Error): void => {
    errors.push(error);
    failAllPendingWaiters(error.message);
  };

  const server = net.createServer((socket) => {
    openSockets.add(socket);
    let record: BarrierConnectionRecord | undefined;
    let tag = "";

    socket.on("error", (error) => {
      // Record, never throw: an unhandled 'error' event would crash the test
      // process instead of failing the asserting test.
      failBarrier(error);
      if (record !== undefined && record.error === undefined) record.error = error;
      if (record !== undefined && record.registered) settleTag(record.tag, false, `barrier tag "${record.tag}" hit a socket error before clean close: ${errorMessage(error)}`);
    });

    socket.on("data", (data) => {
      if (barrierFailure !== undefined) {
        socket.destroy();
        return;
      }
      tag += data.toString("utf8");
      if (!tag.includes("\n")) return;
      if (record !== undefined) {
        // One registration per socket: any further tagged line is a protocol
        // violation — fail the barrier fatally and drop this connection so no
        // further ACK or proof can issue.
        failBarrier(new Error(`barrier connection "${record.tag}" received additional tag data`));
        socket.destroy();
        return;
      }
      const line = tag.trim();
      const rec: BarrierConnectionRecord = {
        tag: line,
        stream: undefined,
        index: undefined,
        registered: false,
        valid: false,
        observedBeforeAck: false,
        ackSent: false,
        endObserved: false,
        closed: false,
        error: undefined,
      };
      const match = /^(stdout|stderr):(\d+)$/.exec(line);
      if (match !== null) {
        const stream: StreamName = match[1] === "stdout" ? "stdout" : "stderr";
        const index = Number(match[2]);
        rec.stream = stream;
        rec.index = index;
        // In-range: the tagged index must be observable in this run's FIFO, so
        // the go ACK can never wait on an impossible observation.
        rec.valid = index < state[stream].fifo.length;
      }
      record = rec;
      if (!rec.valid) {
        // Unidentifiable or out-of-range tag: fatal barrier failure. Record it,
        // reject every pending proof waiter immediately (no proof can be
        // trusted), and drop the connection so the child fails promptly instead
        // of hanging on a release that is never ACKed.
        failBarrier(new Error(`barrier received invalid tag "${line}"`));
        socket.destroy();
        return;
      }
      if (byTag.has(line)) {
        // Duplicate tag: never ACK this connection and never let its close
        // settle the registered record's tag; drop it so the child fails
        // promptly.
        failBarrier(new Error(`barrier received duplicate tag "${line}"`));
        socket.destroy();
        return;
      }
      byTag.set(line, rec);
      rec.registered = true;
      void (async () => {
        try {
          // The tag's exact index must be observed as its own parent-side data
          // event before the raw go ACK is written.
          if (rec.stream !== undefined && rec.index !== undefined) {
            await waitForPopped(state[rec.stream], rec.index);
            rec.observedBeforeAck = true;
          }
          // Never ACK a connection that already errored or was destroyed: the
          // recorded error already fails the test, and writing to a dead
          // socket would only add noise.
          if (barrierFailure !== undefined || rec.error !== undefined || socket.destroyed) return;
          socket.write("go\n");
          rec.ackSent = true;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          failBarrier(err);
          if (rec.error === undefined) rec.error = err;
          settleTag(line, false, `barrier tag "${line}" failed before the go ACK: ${err.message}`);
        }
      })();
    });

    socket.on("end", () => {
      if (record !== undefined) record.endObserved = true;
      // The child ended its side after consuming the go ACK; end ours so the
      // connection completes an orderly close instead of lingering until
      // cleanup destroys it.
      if (!socket.destroyed) socket.end();
    });

    socket.on("close", () => {
      openSockets.delete(socket);
      if (record === undefined) {
        failBarrier(new Error("barrier connection closed before registering a tag"));
        return;
      }
      record.closed = true;
      if (!record.registered) return; // duplicate/invalid: registration-time error already fails the test
      const clean = isClean(record);
      if (!clean) {
        failBarrier(new Error(
          `barrier tag "${record.tag}" closed without a clean valid ACK (observed=${record.observedBeforeAck} ackSent=${record.ackSent} endObserved=${record.endObserved} error=${record.error === undefined ? "none" : errorMessage(record.error)})`,
        ));
      }
      settleTag(record.tag, clean, `barrier tag "${record.tag}" closed without a clean valid ACK`);
    });
  });

  // Permanent server-level error sink: the bind promise below still rejects on
  // listen failure; anything later is recorded instead of thrown unhandled.
  server.on("error", failBarrier);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("barrier server did not bind a loopback TCP endpoint");

  return {
    endpoint: `127.0.0.1:${address.port}`,
    errors,
    waitForCleanClose(tag: string): Promise<void> {
      if (barrierFailure !== undefined) return Promise.reject(barrierFailure);
      const settled = settledTags.get(tag);
      if (settled === true) return Promise.resolve();
      if (settled === false) return Promise.reject(new Error(`barrier tag "${tag}" already failed before a clean valid ACK`));
      return new Promise<void>((resolve, reject) => {
        let waiters = tagWaiters.get(tag);
        if (waiters === undefined) {
          waiters = [];
          tagWaiters.set(tag, waiters);
        }
        waiters.push({ resolve, reject });
      });
    },
    close: async (): Promise<void> => {
      // Destroy held barrier connections first: a child blocked on a release
      // must not keep the server (and the test) open. Join each socket's
      // asynchronous close handler before returning so its early-close failure
      // is recorded before the caller inspects the errors.
      const socketCloses = [...openSockets].map((socket) =>
        new Promise<void>((resolve) => socket.once("close", () => resolve())),
      );
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(socketCloses);
      // Fail any tag waiter that can never complete now that the barrier is
      // gone: a pending waiter must not hang silently or borrow another
      // connection's close as proof.
      for (const [tag, waiters] of tagWaiters) {
        tagWaiters.delete(tag);
        settledTags.set(tag, false);
        for (const waiter of waiters.splice(0)) {
          waiter.reject(new Error(`barrier server closed before tag "${tag}" completed a clean valid ACK`));
        }
      }
    },
  };
}

/** Fail-closed barrier hygiene check for every exit path after cleanup: any recorded socket or protocol error fails the test; when a primary failure already exists it is preserved (in the message and as cause) rather than replaced, and the check itself is never skipped. */
function throwIfBarrierErrors(server: BarrierServerHandle, label: string, primaryFailure: unknown): void {
  if (server.errors.length === 0) return;
  const detail = `${label} barrier recorded errors: ${server.errors.map(errorMessage).join("; ")}`;
  if (primaryFailure === undefined) throw new Error(detail);
  throw new Error(`${errorMessage(primaryFailure)} | ${detail}`, { cause: primaryFailure instanceof Error ? primaryFailure : undefined });
}

/** Captured live identity of the fixture child: the actual ChildProcess handle, its spawn-time pid, the process-group id (non-Windows detached leader), the launched cwd, and our own exit observation on that handle. */
interface CapturedChild {
  proc: ChildProcess | undefined;
  pid: number | undefined;
  processGroupId: number | undefined;
  expectedCwd: string;
  settled: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function createCapturedChild(expectedCwd: string): CapturedChild {
  return { proc: undefined, pid: undefined, processGroupId: undefined, expectedCwd, settled: false, code: null, signal: null };
}

/** Capture the first spawned child's live identity and observe its settlement on that handle. */
function attachCapture(captured: CapturedChild, proc: ChildProcess): void {
  if (captured.proc !== undefined || proc.pid === undefined) return;
  captured.proc = proc;
  captured.pid = proc.pid;
  // The adapter spawns detached on non-Windows, so the child leads its own
  // process group: group id == pid (the identity the adapter reports via
  // onProcessStart).
  if (process.platform !== "win32") captured.processGroupId = proc.pid;
  // Our own settlement observation, attached before the adapter's close
  // observer: once it fires, cleanup must never signal this child.
  proc.once("exit", (code, signal) => {
    captured.settled = true;
    captured.code = code;
    captured.signal = signal;
  });
}

type CleanupOutcome =
  | { action: "no-child" }
  | { action: "already-settled"; code: number | null; signal: NodeJS.Signals | null }
  | { action: "unverified-identity"; detail: string }
  | { action: "signaled"; verification: string; groupSignalSent: boolean; childSignalSent: boolean };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Query the OS for a live pid's current identity, platform-specifically: Linux reads /proc (ppid/pgrp from stat, cwd from the symlink); macOS/BSD use `ps` for pid/ppid/pgid and `lsof` for cwd. Never throws: an unqueryable or gone pid yields a detail so cleanup can fail closed instead of signaling. */
function queryLiveIdentity(pid: number): { ok: true; ppid: number; pgid: number; cwd?: string } | { ok: false; detail: string } {
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      return { ok: false, detail: `cannot read /proc/${pid}/stat: ${errorMessage(error)}` };
    }
    // The comm field may contain spaces and parentheses; anchor after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return { ok: false, detail: `unparseable /proc/${pid}/stat` };
    let cwd: string | undefined;
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* cwd stays unverified */ }
    return { ok: true, ppid, pgid, cwd };
  }
  let raw: string;
  try {
    raw = execFileSync("ps", ["-o", "pid=,ppid=,pgid=", "-p", String(pid)], { timeout: 5_000, encoding: "utf8" });
  } catch (error) {
    return { ok: false, detail: `ps query failed for pid ${pid}: ${errorMessage(error)}` };
  }
  const match = raw.trim().match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
  if (!match || Number(match[1]) !== pid) return { ok: false, detail: `ps returned no row for pid ${pid}` };
  let cwd: string | undefined;
  try {
    const lsofOut = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { timeout: 5_000, encoding: "utf8" });
    const nameLine = lsofOut.split("\n").find((line) => line.startsWith("n"));
    if (nameLine) cwd = nameLine.slice(1);
  } catch { /* cwd stays unverified */ }
  return { ok: true, ppid: Number(match[2]), pgid: Number(match[3]), cwd };
}

/**
 * Fail-closed cleanup for a fixture child whose run did not settle. Never
 * signals an already settled, recycled, or unverified identity: after observed
 * settlement nothing is signaled; on POSIX the direct child is only signaled
 * through the captured ChildProcess handle (a reaped handle cannot be
 * signaled, so a recycled pid is unreachable), and a process-group signal is
 * sent only after the OS confirms the captured pid is still alive with this
 * test's ppid, the fixture cwd, and the captured group id; on Windows the
 * required current cwd verification is not portably available, so cleanup
 * fails closed without signaling rather than terminating on handle ownership
 * alone.
 */
function settleFixtureChild(captured: CapturedChild): CleanupOutcome {
  const { proc, pid } = captured;
  if (proc === undefined || pid === undefined) return { action: "no-child" };
  if (captured.settled || proc.exitCode !== null || proc.signalCode !== null) {
    return { action: "already-settled", code: proc.exitCode ?? captured.code, signal: proc.signalCode ?? captured.signal };
  }
  if (process.platform === "win32") {
    // Windows: a live process's current working directory is not portably
    // queryable (tasklist/wmic/CIM expose no cwd; only an NtQueryInformationFile
    // P/Invoke probe would read it), so the required cwd verification cannot be
    // obtained. Fail closed like the POSIX path: report unverified identity and
    // send no signal instead of terminating on handle ownership alone. (The
    // adapter spawns without a detached group on win32, so there is no group to
    // verify or signal.) Not exercised natively unless run on Windows.
    return {
      action: "unverified-identity",
      detail: `win32: required live cwd verification unavailable for pid ${pid} (no portable cwd query); no signal sent`,
    };
  }
  const query = queryLiveIdentity(pid);
  if (!query.ok) return { action: "unverified-identity", detail: query.detail };
  if (query.ppid !== process.pid) {
    return { action: "unverified-identity", detail: `pid ${pid} parent is ${query.ppid}, not this test process (${process.pid})` };
  }
  // The OS reports the resolved cwd (macOS resolves /tmp to /private/tmp and
  // other symlinked prefixes); compare against the resolved expected form too
  // so verified cleanup still works when the fixture dir sits under a symlink.
  let expectedCwdReal = captured.expectedCwd;
  try { expectedCwdReal = realpathSync.native(captured.expectedCwd); } catch { /* keep raw form */ }
  if (query.cwd === undefined || (query.cwd !== captured.expectedCwd && query.cwd !== expectedCwdReal)) {
    return { action: "unverified-identity", detail: `pid ${pid} cwd is ${String(query.cwd)}, expected fixture cwd ${captured.expectedCwd}` };
  }
  const group = captured.processGroupId ?? pid;
  if (query.pgid !== group) {
    return { action: "unverified-identity", detail: `pid ${pid} process group is ${query.pgid}, captured group is ${group}` };
  }
  let groupSignalSent = false;
  try {
    process.kill(-group, "SIGKILL");
    groupSignalSent = true;
  } catch { /* settled between verification and signal */ }
  let childSignalSent = false;
  try { childSignalSent = proc.kill("SIGKILL") === true; } catch { /* already gone */ }
  return {
    action: "signaled",
    verification: `${process.platform}: pid ${pid} ppid ${query.ppid} cwd ${query.cwd} pgid ${query.pgid}`,
    groupSignalSent,
    childSignalSent,
  };
}

/** The controlled fake app-server child. Emits the shared fixtures in mode "intact" (one write each), "split" (halves gated by the barrier), or "hold" (first half of the agent line, then blocks until terminated). */
function fakeAppServerSource(): string {
  return [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');const net=require('node:net');",
    "const mode=process.env.PRG_U8_MODE||'intact';",
    "setTimeout(()=>process.exit(95),15000); // finite invocation-owned fixture lifetime",
    "const barrierEndpoint=process.env.PRG_U8_BARRIER||'';",
    "const capturePath=process.env.PRG_U8_CAPTURE||'';",
    `const splits=${JSON.stringify({ agent: AGENT_SPLIT, file: FILE_SPLIT, diagnostic: DIAGNOSTIC_SPLIT })};`,
    `const AGENT_TEXT=${JSON.stringify(AGENT_TEXT)};`,
    `const NON_ASCII_PATH=${JSON.stringify(NON_ASCII_PATH)};`,
    `const DIAGNOSTIC=${JSON.stringify(DIAGNOSTIC)};`,
    "const agentMessageLine=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'item/completed',params:{item:{type:'agentMessage',text:AGENT_TEXT}}})+'\\n');",
    "const fileChangeLine=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'item/completed',params:{item:{type:'fileChange',id:'change-1',changes:[{path:NON_ASCII_PATH,kind:'add'}]}}})+'\\n');",
    "const turnCompletedLine=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-u8',turn:{id:'turn-u8',status:'completed'}}})+'\\n');",
    "const diagnosticBytes=Buffer.from(DIAGNOSTIC,'utf8');",
    "function release(stream,index){if(!barrierEndpoint)return Promise.resolve();const sep=barrierEndpoint.lastIndexOf(':');return new Promise((resolve,reject)=>{const client=net.connect({host:barrierEndpoint.slice(0,sep),port:Number(barrierEndpoint.slice(sep+1))});let settled=false;let acked=false;const finish=(fn,value)=>{if(settled)return;settled=true;fn(value);};client.once('data',()=>{acked=true;client.end();});client.once('close',()=>{if(acked)finish(resolve,undefined);else finish(reject,new Error('barrier '+stream+':'+index+' closed before the go ACK'));});client.once('error',(error)=>finish(reject,error));client.write(stream+':'+index+'\\n');});}",
    "let input='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',(chunk)=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;if(capturePath)fs.appendFileSync(capturePath,raw+'\\n');const c=JSON.parse(raw);if(!c.id)continue;",
    "if(c.method==='initialize')process.stdout.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{userAgent:'codex-u8-test/1.0'}}) +'\\n'));",
    "else if(c.method==='thread/start')process.stdout.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-u8'}}})+'\\n'));",
    "else if(c.method==='turn/start')handleTurnStart(c).catch(()=>{process.exit(1);});",
    "else if(c.method==='turn/interrupt'&&mode!=='hold')process.stdout.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{}})+'\\n'));",
    "}});",
    "async function emitSplit(stream,buffer,splitAt,name,base){stream.write(buffer.subarray(0,splitAt));await release(name,base);stream.write(buffer.subarray(splitAt));await release(name,base+1);}",
    "async function handleTurnStart(c){process.stdout.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id:'turn-u8'}}})+'\\n'));",
    "if(mode==='hold'){process.stderr.write(diagnosticBytes.subarray(0,splits.diagnostic));await release('stderr',0);await new Promise(()=>{});return;}",
    "if(mode==='intact'){process.stdout.write(agentMessageLine);process.stdout.write(fileChangeLine);process.stderr.write(diagnosticBytes);process.stdout.write(turnCompletedLine);return;}",
    "await release('stdout',2);",
    "await emitSplit(process.stdout,agentMessageLine,splits.agent,'stdout',3);",
    "await emitSplit(process.stdout,fileChangeLine,splits.file,'stdout',5);",
    "process.stderr.write(diagnosticBytes.subarray(0,splits.diagnostic));await release('stderr',0);",
    "process.stderr.write(diagnosticBytes.subarray(splits.diagnostic));await release('stderr',1);",
    "process.stdout.write(turnCompletedLine);}",
  ].join("\n");
}

type TestSpawn = (file: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;
// The raw CJS exports object (not a namespace import, whose bindings are
// getter-only): the adapter resolves spawn through this shared module at call
// time, so a scoped wrapper observes the real child it spawns.
const childProcessExports = require("node:child_process") as { spawn: TestSpawn };

interface FixtureRun {
  result: ExecutorTurn;
  rawStream: string;
  stderrText: string;
  processResult: Record<string, unknown>;
  starts: Array<{ pid: number; processGroupId?: number }>;
  exits: Array<{ pid: number; code: number | null; signal: NodeJS.Signals | null }>;
  observations: ExecutorToolObservation[];
  state: ObserverState;
  spawnedPid: number | undefined;
  cleanup: CleanupOutcome;
  calls: Array<Record<string, unknown>>;
}

async function runFixture(root: string, mode: "split" | "intact", fifo: { stdout: Buffer[]; stderr: Buffer[] }): Promise<FixtureRun> {
  const dir = join(root, mode);
  const artifactDir = join(dir, "artifacts");
  const capture = join(dir, "capture.jsonl");
  const childScript = join(dir, "fake-app-server.cjs");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(childScript, fakeAppServerSource(), "utf8");

  const state: ObserverState = {
    stdout: createObserver(fifo.stdout, mode === "split"),
    stderr: createObserver(fifo.stderr, mode === "split"),
  };
  const barrierServer = mode === "split" ? await startBarrierServer(state) : undefined;

  const realSpawn = childProcessExports.spawn;
  const captured = createCapturedChild(dir);
  let cleanupOutcome: CleanupOutcome | undefined;
  childProcessExports.spawn = ((file: string, args?: readonly string[], options?: SpawnOptions) => {
    const proc = realSpawn(file, args ?? [], options ?? {});
    attachCapture(captured, proc);
    proc.stdout?.on("data", (chunk: Buffer) => observeChunk("stdout", chunk, state));
    proc.stderr?.on("data", (chunk: Buffer) => observeChunk("stderr", chunk, state));
    return proc;
  }) as TestSpawn;

  const starts: FixtureRun["starts"] = [];
  const exits: FixtureRun["exits"] = [];
  const observations: ExecutorToolObservation[] = [];
  let result: ExecutorTurn | undefined;
  let primaryFailure: unknown;
  try {
    const adapter = new CodexExecutorAdapter({
      id: "codex",
      adapter: "codex-cli",
      command: process.execPath,
      args: [childScript],
      model: "gpt-test",
      env: {
        PRG_U8_MODE: mode,
        PRG_U8_BARRIER: barrierServer ? barrierServer.endpoint : "",
        PRG_U8_CAPTURE: capture,
      },
    });
    result = await withTimeout(adapter.run({
      cwd: dir,
      prompt: "work",
      artifactDir,
      turn: 1,
      onProcessStart: (identity) => { starts.push(identity); },
      onProcessExit: (exit) => { exits.push(exit); },
      onToolObservation: (observation) => { observations.push(observation); },
    }), `Codex ${mode} UTF-8 fixture`);
  } catch (error) {
    primaryFailure = error;
  } finally {
    // Restore spawn before cleanup so no later code sees the wrapper, then run
    // fail-closed identity-verified cleanup: a child that already settled on
    // the captured handle is never signaled.
    childProcessExports.spawn = realSpawn;
    cleanupOutcome = settleFixtureChild(captured);
    if (barrierServer) await barrierServer.close();
  }

  // Barrier hygiene on every exit path after cleanup: recorded socket or
  // protocol errors are combined with, never replaced by or skipped past, the
  // primary failure.
  if (barrierServer) throwIfBarrierErrors(barrierServer, "split-mode", primaryFailure);

  if (result === undefined) {
    // On the error path rethrow the original failure captured above; the
    // fallback message only narrows for TypeScript on the impossible clean path.
    throw primaryFailure ?? new Error("fixture run did not settle; see cleanup outcome");
  }

  const turnDir = join(artifactDir, "executor", "0001");
  const [rawStream, stderrText, processResultJson] = await Promise.all([
    readFile(join(turnDir, "raw-stream.txt"), "utf8"),
    readFile(join(turnDir, "stderr.txt"), "utf8"),
    readFile(join(turnDir, "process-result.json"), "utf8"),
  ]);
  const callsRaw = (await readFile(capture, "utf8")).trim();
  return {
    result,
    rawStream,
    stderrText,
    processResult: JSON.parse(processResultJson) as Record<string, unknown>,
    starts,
    exits,
    observations,
    state,
    spawnedPid: captured.pid,
    cleanup: cleanupOutcome ?? { action: "no-child" },
    calls: callsRaw ? callsRaw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [],
  };
}

test("chunk observer waiters survive premature wakes until their index is reached (#238)", async () => {
  // Deterministic fixture for the barrier waiter mechanics: a waiter
  // registered for a later index must stay pending (and registered) across
  // every premature wake, then resolve exactly when its index is popped.
  const chunks = [
    Buffer.from('{"a":1}\n', "utf8"),
    Buffer.from('{"b":2}\n', "utf8"),
    Buffer.from('{"c":3}\n', "utf8"),
    Buffer.from('{"d":4}\n', "utf8"),
  ];
  const observer = createObserver(chunks, true);
  const state: ObserverState = { stdout: observer, stderr: createObserver([], false) };

  let settled = false;
  const promise = waitForPopped(observer, 3).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "waiter must not resolve before any chunk arrives");
  assert.equal(observer.waiters.length, 1, "waiter must be registered before the first chunk");

  for (const chunk of chunks.slice(0, 3)) {
    observeChunk("stdout", chunk, state);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, `waiter must stay unresolved through premature wakes (popped=${observer.popped})`);
    assert.equal(observer.waiters.length, 1, "a premature wake must leave the waiter registered for the next chunk");
  }

  observeChunk("stdout", chunks[3], state);
  await withTimeout(promise, "later-index waiter");
  assert.equal(settled, true, "waiter must resolve once its index is popped");
  assert.equal(observer.popped, 4);
  assert.equal(observer.waiters.length, 0, "a resolved waiter must be removed");
});

test("Codex app-server decodes split multibyte stdout/stderr byte-accurately (#238)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-utf8-"));
  try {
    // Establish that every split lands strictly inside a multibyte sequence:
    // a per-chunk decode of each first half ends in a replacement character,
    // and each second half begins with a UTF-8 continuation byte. This is the
    // exact input shape the original per-chunk decoder corrupted.
    for (const [name, part1, part2] of [
      ["agentMessage", agentPart1, agentPart2],
      ["fileChange", filePart1, filePart2],
      ["diagnostic", diagnosticPart1, diagnosticPart2],
    ] as const) {
      assert.ok(part1.toString("utf8").endsWith("\uFFFD"), `${name} first half must end inside a multibyte sequence`);
      assert.equal((part2[0] ?? 0) & 0xc0, 0x80, `${name} second half must begin with a continuation byte`);
    }

    const split = await runFixture(root, "split", {
      stdout: [initResponseLine, threadResponseLine, turnResponseLine, agentPart1, agentPart2, filePart1, filePart2, turnCompletedLine],
      stderr: [diagnosticPart1, diagnosticPart2],
    });
    const intact = await runFixture(root, "intact", {
      stdout: [initResponseLine, threadResponseLine, turnResponseLine, agentMessageLine, fileChangeLine, turnCompletedLine],
      stderr: [diagnosticBytes],
    });

    // The barrier protocol proves the split halves really arrived as separate
    // parent-side data events at multibyte byte boundaries (no coalescing).
    assertObservedExactly("stdout", split.state);
    assertObservedExactly("stderr", split.state);
    assert.ok(
      Buffer.concat(intact.state.stdout.observed).equals(Buffer.concat([initResponseLine, threadResponseLine, turnResponseLine, agentMessageLine, fileChangeLine, turnCompletedLine])),
      "intact control run must deliver the complete stdout byte stream",
    );

    // Split and intact runs must be indistinguishable in every retained result:
    // protocol text, retained stdout, retained stderr, and byte accounting.
    assert.equal(split.result.text, AGENT_TEXT);
    assert.equal(intact.result.text, AGENT_TEXT);
    assert.equal(split.rawStream, EXPECTED_STDOUT_TEXT);
    assert.equal(intact.rawStream, EXPECTED_STDOUT_TEXT);
    assert.equal(split.stderrText, DIAGNOSTIC);
    assert.equal(intact.stderrText, DIAGNOSTIC);
    assert.equal(Buffer.byteLength(split.rawStream), EXPECTED_STDOUT_BYTES);
    assert.equal(Buffer.byteLength(split.stderrText), diagnosticBytes.length);

    // RPC ids/routing and completion are preserved through the split stream.
    assert.deepEqual(
      split.calls.map((call) => [call.method, call.id]),
      [["initialize", 1], ["initialized", undefined], ["thread/start", 2], ["turn/start", 3]],
    );
    const threadStartParams = (split.calls.find((call) => call.method === "thread/start")?.params ?? {}) as Record<string, unknown>;
    assert.equal(threadStartParams.sandbox, "workspace-write");
    assert.equal(threadStartParams.model, "gpt-test");
    assert.equal(threadStartParams.approvalPolicy, "never");
    const turnStartParams = (split.calls.find((call) => call.method === "turn/start")?.params ?? {}) as Record<string, unknown>;
    assert.deepEqual(turnStartParams.input, [{ type: "text", text: "work" }]);
    assert.equal(split.result.failure, undefined);
    assert.equal(split.result.code, 0);
    assert.equal(split.result.timedOut, false);
    assert.equal(split.result.aborted, false);
    assert.equal(split.result.session.id, THREAD_ID);

    // Retained-cap accounting stays intact: nothing truncated, exact session.
    assert.equal(split.processResult.stdoutTruncated, false);
    assert.equal(split.processResult.stderrTruncated, false);
    assert.equal(split.processResult.code, 0);
    assert.equal(split.processResult.sessionId, THREAD_ID);

    // PID persistence and start/exit callback counts are preserved.
    assert.ok(split.spawnedPid !== undefined, "the fixture must observe the real spawned child");
    assert.equal(split.starts.length, 1);
    assert.equal(split.starts[0]?.pid, split.spawnedPid);
    assert.equal(split.exits.length, 1);
    assert.equal(split.exits[0]?.pid, split.spawnedPid);
    assert.equal(split.exits[0]?.code, null);
    assert.equal(split.exits[0]?.signal, "SIGTERM");

    // Cleanup must never signal an already settled child: both runs observed
    // the SIGTERM exit on the captured handle before cleanup ran, so no PID or
    // process-group signal may be sent (fail-closed settlement check).
    for (const [name, run] of [["split", split], ["intact", intact]] as const) {
      assert.equal(run.cleanup.action, "already-settled", `${name} cleanup must not signal an already settled child`);
      if (run.cleanup.action === "already-settled") {
        assert.equal(run.cleanup.code, null);
        assert.equal(run.cleanup.signal, "SIGTERM");
      }
    }

    // The non-ASCII path field survives structured parsing intact.
    const fileObservation = split.observations.find((event) => event.toolName === "write" && event.observationId === "change-1");
    assert.ok(fileObservation, "the fileChange observation must be published");
    assert.equal(fileObservation.stage, "end");
    assert.ok(Array.isArray(fileObservation.toolInput?.files) && fileObservation.toolInput.files.includes(NON_ASCII_PATH));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex app-server torn stream tails keep replacement-character final decoding (#238)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-utf8-torn-"));
  try {
    const artifactDir = join(root, "artifacts");
    const childScript = join(root, "torn-child.cjs");
    await mkdir(artifactDir, { recursive: true });
    // A partial JSON line ending mid-way through a 3-byte sequence on stdout
    // (a lone E8 lead byte) and a diagnostic ending mid-way through a 4-byte
    // sequence on stderr (F0 9F), each in one write; the child then exits
    // normally with the streams still torn.
    const tornStdout = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","method":"item/started","params":{"item":{"type":"agentMessage","text":"héllo 日本', "utf8"),
      Buffer.from([0xe8]),
    ]);
    const tornStderr = Buffer.concat([
      Buffer.from("警告: modèle wor", "utf8"),
      Buffer.from([0xf0, 0x9f]),
    ]);
    await writeFile(childScript, [
      "#!/usr/bin/env node",
      `process.stdout.write(Buffer.from("${tornStdout.toString("hex")}", "hex"));`,
      `process.stderr.write(Buffer.from("${tornStderr.toString("hex")}", "hex"));`,
      "",
    ].join("\n"), "utf8");

    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    const adapter = new CodexExecutorAdapter({ id: "codex", adapter: "codex-cli", command: process.execPath, args: [childScript], model: "gpt-test" });
    const result = await withTimeout(adapter.run({
      cwd: root,
      prompt: "work",
      artifactDir,
      turn: 1,
      onProcessExit: (exit) => { exits.push(exit); },
    }), "Codex torn-tail fixture");

    assert.equal(result.code, 1);
    assert.equal(result.failure?.category, "protocol");
    // Existing contract for a genuinely torn final sequence: replacement
    // characters, exactly matching a full-buffer decode of the bytes sent —
    // no silent loss, no hang.
    const turnDir = join(artifactDir, "executor", "0001");
    const [rawStream, stderrText] = await Promise.all([
      readFile(join(turnDir, "raw-stream.txt"), "utf8"),
      readFile(join(turnDir, "stderr.txt"), "utf8"),
    ]);
    assert.equal(rawStream, tornStdout.toString("utf8"));
    assert.ok(rawStream.endsWith("\uFFFD"), "torn stdout tail must decode to a replacement character");
    assert.equal(stderrText, tornStderr.toString("utf8"));
    assert.ok(stderrText.endsWith("\uFFFD"), "torn stderr tail must decode to a replacement character");
    assert.equal(exits.length, 1);
    assert.equal(exits[0]?.code, 0);
    assert.equal(exits[0]?.signal, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex app-server skips malformed multibyte lines without derailing later records (#238)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-utf8-malformed-"));
  try {
    const artifactDir = join(root, "artifacts");
    const childScript = join(root, "malformed-child.cjs");
    await mkdir(artifactDir, { recursive: true });
    const recoveredLine = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text: "recovered" } } }) + "\n");
    await writeFile(childScript, [
      "#!/usr/bin/env node",
      "let input='';process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',(chunk)=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);if(!c.id)continue;",
      "if(c.method==='initialize')process.stdout.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{userAgent:'codex-u8-test/1.0'}}) +'\\n'));",
      "else if(c.method==='thread/start')process.stdout.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{thread:{id:'thread-u8'}}})+'\\n'));",
      `else if(c.method==='turn/start'){process.stdout.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:c.id,result:{turn:{id:'turn-u8'}}})+'\\n'));`,
      "process.stdout.write(Buffer.from('not valid json but has 日本語 🚀\\n','utf8'));",
      "process.stdout.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',id:99,result:{ignored:true}})+'\\n'));",
      `process.stdout.write(Buffer.from("${recoveredLine.toString("hex")}", "hex"));`,
      "process.stdout.write(Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-u8',turn:{id:'turn-u8',status:'completed'}}})+'\\n'));}",
      "}});",
    ].join("\n"), "utf8");

    const adapter = new CodexExecutorAdapter({ id: "codex", adapter: "codex-cli", command: process.execPath, args: [childScript], model: "gpt-test" });
    const result = await withTimeout(adapter.run({ cwd: root, prompt: "work", artifactDir, turn: 1 }), "Codex malformed-line fixture");

    // The malformed line (multibyte content, invalid JSON) and the unknown-id
    // response are skipped; later records still parse and route correctly.
    assert.equal(result.text, "recovered");
    assert.equal(result.failure, undefined);
    assert.equal(result.session.id, THREAD_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows failure cleanup fails closed without portable live cwd verification (#238)", () => {
  // Instrument both signaling paths without creating an OS child that would
  // itself require verified teardown. This is not a native-Windows test.
  let childSignalCalls = 0;
  let osSignalCalls = 0;
  const captured = createCapturedChild("unused");
  captured.pid = 12345;
  captured.proc = {
    pid: captured.pid,
    exitCode: null,
    signalCode: null,
    kill: () => { childSignalCalls += 1; return true; },
  } as unknown as ChildProcess;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const realKill = process.kill;
  let outcome: CleanupOutcome | undefined;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.kill = (() => { osSignalCalls += 1; return true; }) as typeof process.kill;
    outcome = settleFixtureChild(captured);
  } finally {
    process.kill = realKill;
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  assert.ok(
    outcome !== undefined && outcome.action === "unverified-identity" && outcome.detail.includes("win32"),
    `win32 cleanup must fail closed without portable cwd verification (got ${JSON.stringify(outcome)})`,
  );
  assert.equal(childSignalCalls, 0, "unavailable verification must not signal the child handle");
  assert.equal(osSignalCalls, 0, "unavailable verification must not signal a PID or group");
});

test("Codex abort while holding a split multibyte tail settles with torn-tail decoding (#238)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-codex-utf8-abort-"));
  try {
    const dir = join(root, "hold");
    const artifactDir = join(dir, "artifacts");
    const capture = join(dir, "capture.jsonl");
    const childScript = join(dir, "fake-app-server.cjs");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(childScript, fakeAppServerSource(), "utf8");

    // The child writes the first half of the diagnostic (ending mid-sequence)
    // to stderr and then holds; the abort lands while that torn tail is the
    // last byte on the stream. Stderr carries no line protocol, so the torn
    // tail cannot swallow a following record the way an unterminated stdout
    // line would (pre-existing framing behavior, out of scope for #238). The
    // hold mode deliberately sends no interrupt reply: terminal teardown no
    // longer waits for one (#425). Only the three startup replies are assured.
    const state: ObserverState = {
      stdout: createObserver([initResponseLine, threadResponseLine, turnResponseLine], true),
      stderr: createObserver([diagnosticPart1], true),
    };
    const barrierServer = await startBarrierServer(state);

    const realSpawn = childProcessExports.spawn;
    const captured = createCapturedChild(dir);
    let cleanupOutcome: CleanupOutcome | undefined;
    childProcessExports.spawn = ((file: string, args?: readonly string[], options?: SpawnOptions) => {
      const proc = realSpawn(file, args ?? [], options ?? {});
      attachCapture(captured, proc);
      proc.stdout?.on("data", (chunk: Buffer) => observeChunk("stdout", chunk, state));
      proc.stderr?.on("data", (chunk: Buffer) => observeChunk("stderr", chunk, state));
      return proc;
    }) as TestSpawn;

    const starts: Array<{ pid: number }> = [];
    const exits: Array<{ pid: number; code: number | null; signal: NodeJS.Signals | null }> = [];
    const controller = new AbortController();
    let primaryFailure: unknown;
    try {
      const adapter = new CodexExecutorAdapter({
        id: "codex",
        adapter: "codex-cli",
        command: process.execPath,
        args: [childScript],
        model: "gpt-test",
        env: { PRG_U8_MODE: "hold", PRG_U8_BARRIER: barrierServer.endpoint, PRG_U8_CAPTURE: capture },
      });
      const runPromise = adapter.run({
        cwd: dir,
        prompt: "work",
        artifactDir,
        turn: 1,
        signal: controller.signal,
        onProcessStart: (identity) => { starts.push(identity); },
        onProcessExit: (exit) => { exits.push(exit); },
      });
      // Deterministic barrier under one existing-budget guard: abort only
      // after (1) the split first half has been observed as its own parent-side
      // data event and (2) that existing stderr:0 barrier connection has
      // already completed its raw go ACK — sent by the server, consumed by the
      // child, and closed cleanly on both sides. The child is then past every
      // barrier socket when SIGTERM lands, so no reset can reach a held
      // connection (previously the abort raced the ACK and could reset the
      // still-open barrier socket).
      await withTimeout((async () => {
        await waitForPopped(state.stderr, 0);
        await barrierServer.waitForCleanClose("stderr:0");
      })(), "held diagnostic first half and stderr:0 clean close", 10_000);
      controller.abort();
      const result = await withTimeout(runPromise, "Codex abort fixture");

      assertObservedExactly("stdout", state);
      assertObservedExactly("stderr", state);
      assert.equal(result.aborted, true);
      assert.equal(result.failure, undefined);
      assert.equal(result.code, 1);
      const turnDir = join(artifactDir, "executor", "0001");
      const [rawStream, stderrText] = await Promise.all([
        readFile(join(turnDir, "raw-stream.txt"), "utf8"),
        readFile(join(turnDir, "stderr.txt"), "utf8"),
      ]);
      // The protocol stream stays clean without requiring a native reply
      // before terminal signaling; retained UTF-8 bytes remain exact.
      assert.equal(rawStream, Buffer.concat([initResponseLine, threadResponseLine, turnResponseLine]).toString("utf8"));
      assert.ok(!rawStream.includes("\uFFFD"), "the intact protocol stream must not gain replacement characters");
      // The held torn tail decodes to a replacement character exactly as a
      // full-buffer decode of the bytes actually written does.
      assert.equal(stderrText, diagnosticPart1.toString("utf8"));
      assert.ok(stderrText.endsWith("\uFFFD"), "held torn tail must decode to a replacement character");
      assert.ok(captured.pid !== undefined, "the fixture must observe the real spawned child");
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.pid, captured.pid);
      assert.equal(exits.length, 1);
      assert.equal(exits[0]?.code, null);
      assert.equal(exits[0]?.signal, "SIGTERM");
    } catch (error) {
      primaryFailure = error;
    } finally {
      childProcessExports.spawn = realSpawn;
      // Fail-closed identity-verified cleanup: the abort path settles the
      // child with SIGTERM, so this must observe settlement and send no signal.
      cleanupOutcome = settleFixtureChild(captured);
      await barrierServer.close();
    }

    // Barrier hygiene on every exit path after cleanup: recorded socket or
    // protocol errors (including ECONNRESET) are combined with, never replaced
    // by or skipped past, the primary failure.
    throwIfBarrierErrors(barrierServer, "abort", primaryFailure);

    // The abort run settled the child with SIGTERM before cleanup ran: no PID
    // or process-group signal may be sent after observed settlement.
    assert.ok(
      cleanupOutcome !== undefined && cleanupOutcome.action === "already-settled",
      `abort cleanup must not signal an already settled child (got ${cleanupOutcome === undefined ? "no outcome" : cleanupOutcome.action})`,
    );
    if (cleanupOutcome !== undefined && cleanupOutcome.action === "already-settled") {
      assert.equal(cleanupOutcome.code, null);
      assert.equal(cleanupOutcome.signal, "SIGTERM");
    }
    // Rethrow the original body failure after all post-cleanup checks ran.
    if (primaryFailure !== undefined) throw primaryFailure;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ===== #239: Codex JSON-RPC line framing accumulation =====
//
// The adapter formerly appended every decoded stdout event to one pending
// string and searched it for LF from offset zero on every event, so a long
// incomplete line was rescanned (and recopied) once per data event. These
// regressions drive the real production adapter against fixture-owned,
// finite children (reusing the captured-identity cleanup and the chunk
// barrier above) and check framing compatibility plus a deterministic work
// oracle: across a run, the adapter's newline searches must examine exactly
// as many characters as the decoded stdout contains — each character once.
// The former whole-buffer rescan exceeds that by the sum of the pending
// prefix lengths at every data event, so it fails whenever a line spans
// events, independent of timing, memory, or machine speed.
//
// Nothing here establishes a frame-size or total-memory bound: none exists,
// and an unterminated line is still retained in full until its LF arrives.

/** One fixture-child write: exact bytes (`hex`) or a generated `prefix + fill×count + suffix` UTF-8 text; optionally gated on the barrier (`release` = strict stdout FIFO index) or followed by a normal child exit once flushed. */
interface FrameStep {
  hex?: string;
  prefix?: string;
  fill?: string;
  count?: number;
  suffix?: string;
  release?: number;
  exit?: boolean;
}

/** Child script: per-request response steps (written only when that request arrives) and turn steps played after the turn/start response steps. */
interface FramePlan {
  responses: Partial<Record<"initialize" | "thread/start" | "turn/start", FrameStep[]>>;
  turn: FrameStep[];
}

function exactStep(bytes: Buffer, options: { release?: number; exit?: boolean } = {}): FrameStep {
  return { hex: bytes.toString("hex"), ...options };
}

/** Framing-child stdout ceiling: fits the fixed plans here (at most two 17 MiB frames plus small records); the child enforces it independently and the runner refuses a larger plan before spawning. */
const FRAMING_CHILD_STDOUT_BUDGET = 40 * 1024 * 1024;

function plannedStdoutBytes(plan: FramePlan): number {
  const steps = [...Object.values(plan.responses).flatMap((list) => list ?? []), ...plan.turn];
  return steps.reduce((total, step) => total + (step.hex !== undefined
    ? step.hex.length / 2
    : Buffer.byteLength(step.prefix ?? "") + Buffer.byteLength(step.fill ?? "") * (step.count ?? 0) + Buffer.byteLength(step.suffix ?? "")), 0);
}

/** A #239 fixture root. It is removed only when every child launched from it has an observed close; otherwise it is retained and the run's failure names it. */
interface FramingRoot {
  path: string;
  retained: string[];
}

async function withFramingRoot(prefix: string, body: (root: FramingRoot) => Promise<void>): Promise<void> {
  const root: FramingRoot = { path: await mkdtemp(join(tmpdir(), prefix)), retained: [] };
  try {
    await body(root);
  } finally {
    if (root.retained.length === 0) await rm(root.path, { recursive: true, force: true });
  }
}

type ChildClose = { code: number | null; signal: NodeJS.Signals | null };

/** Bounded join: the observed value, or undefined when the work did not settle within the bound. Used for the captured handle's actual 'close' (attached at spawn) and the adapter run; never fabricates an exit. */
async function boundedJoin<T>(work: Promise<T>, boundMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), boundMs); });
  try {
    return await Promise.race([work, bound]);
  } finally {
    clearTimeout(timer);
  }
}

function framingChildSource(): string {
  return [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');const net=require('node:net');",
    "const plan=JSON.parse(fs.readFileSync(process.env.PRG_FRAME_PLAN,'utf8'));",
    "const barrierEndpoint=process.env.PRG_FRAME_BARRIER||'';",
    // Independent finite lifetime and output ceiling: the child ends itself
    // (exit 124) at its watchdog even if no parent signal ever reaches it, and
    // refuses (exit 125) any write that would exceed its stdout byte budget.
    "const watchdogMs=Number(process.env.PRG_FRAME_WATCHDOG_MS);const stdoutBudget=Number(process.env.PRG_FRAME_STDOUT_BUDGET);",
    "if(!(watchdogMs>0)||!(stdoutBudget>0))process.exit(2);",
    "setTimeout(()=>process.exit(124),watchdogMs).unref();",
    "let written=0;",
    "function release(index){if(!barrierEndpoint)return Promise.resolve();const sep=barrierEndpoint.lastIndexOf(':');return new Promise((resolve,reject)=>{const client=net.connect({host:barrierEndpoint.slice(0,sep),port:Number(barrierEndpoint.slice(sep+1))});let settled=false;let acked=false;const finish=(fn,value)=>{if(settled)return;settled=true;fn(value);};client.once('data',()=>{acked=true;client.end();});client.once('close',()=>{if(acked)finish(resolve,undefined);else finish(reject,new Error('barrier stdout:'+index+' closed before the go ACK'));});client.once('error',(error)=>finish(reject,error));client.write('stdout:'+index+'\\n');});}",
    "function bytes(step){return step.hex!==undefined?Buffer.from(step.hex,'hex'):Buffer.from(step.prefix+step.fill.repeat(step.count)+step.suffix,'utf8');}",
    "function write(buffer){if(written+buffer.length>stdoutBudget)process.exit(125);written+=buffer.length;return new Promise((resolve,reject)=>{process.stdout.write(buffer,(error)=>error?reject(error):resolve());});}",
    "async function play(steps){for(const step of steps){await write(bytes(step));if(step.release!==undefined)await release(step.release);if(step.exit)process.exit(0);}}",
    "let input='';process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',(chunk)=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);if(!c.id||typeof c.method!=='string')continue;",
    "const steps=[...(plan.responses[c.method]||[]),...(c.method==='turn/start'?plan.turn:[])];play(steps).catch(()=>process.exit(1));}});",
  ].join("\n");
}

/** Scoped observation of the adapter's newline-search workload: counts characters examined by String.prototype.indexOf("\n") calls made directly from the Codex adapter module, and nothing else. Installed only for one run in this per-file test process (top-level tests run sequentially) and always restored. */
interface NewlineSearchProbe {
  calls: number;
  examined: number;
  restore(): void;
}

const ADAPTER_MODULE_FRAME = /[\\/]execution[\\/]adapters[\\/]codex-cli\.(?:js|ts):\d+:\d+\)?$/;

function installAdapterNewlineSearchProbe(): NewlineSearchProbe {
  const original = String.prototype.indexOf;
  let inside = false;
  const probe: NewlineSearchProbe = {
    calls: 0,
    examined: 0,
    restore: () => { String.prototype.indexOf = original; },
  };
  function observedIndexOf(this: string, search: string, position?: number): number {
    const found = Reflect.apply(original, this, [search, position]) as number;
    if (search !== "\n" || inside) return found;
    inside = true;
    try {
      const site: { stack?: string } = {};
      Error.captureStackTrace(site, observedIndexOf);
      const caller = (site.stack ?? "").split("\n")[1]?.trim() ?? "";
      if (ADAPTER_MODULE_FRAME.test(caller)) {
        const length = String(this).length;
        const from = Math.min(Math.max(Math.trunc(Number(position ?? 0)) || 0, 0), length);
        probe.calls += 1;
        probe.examined += found >= 0 ? found - from + 1 : length - from;
      }
    } finally {
      inside = false;
    }
    return found;
  }
  String.prototype.indexOf = observedIndexOf as typeof String.prototype.indexOf;
  return probe;
}

interface FramingRun {
  result: ExecutorTurn;
  rawStream: string;
  processResult: Record<string, unknown>;
  exits: Array<{ pid: number; code: number | null; signal: NodeJS.Signals | null }>;
  observations: ExecutorToolObservation[];
  stdoutChunks: Buffer[];
  newlineSearch: { calls: number; examined: number };
  spawnedPid: number | undefined;
  cleanup: CleanupOutcome;
  childClose: ChildClose | undefined;
}

/**
 * Run the real adapter against the framing child. With `strictStdout`, every
 * stdout data event must equal the next listed chunk and gated steps are
 * released only after their chunk was observed as its own event (the #238
 * barrier); otherwise chunking is whatever the pipe delivers and is only
 * recorded. Bounds, innermost first: the adapter's own timeout, the outer
 * guard, and the child's independent watchdog and stdout budget. On every
 * path the shared identity-verified fail-closed settle runs (it never signals
 * a settled, foreign, recycled, or unverified identity), then the actual
 * 'close' of the captured handle — observed from spawn — is joined with a
 * bound past the child watchdog, followed by the adapter run itself (which
 * settles once its child closed). A child or run still unsettled fails the
 * run and keeps its fixture root; a primary failure is reported together with
 * the cleanup outcome and close evidence.
 */
async function runFramingFixture(
  root: FramingRoot,
  name: string,
  plan: FramePlan,
  options: { strictStdout?: Buffer[]; adapterTimeoutMs?: number; guardMs?: number } = {},
): Promise<FramingRun> {
  const plannedBytes = plannedStdoutBytes(plan);
  if (plannedBytes > FRAMING_CHILD_STDOUT_BUDGET) {
    throw new Error(`${name} plan writes ${plannedBytes} stdout bytes, above the ${FRAMING_CHILD_STDOUT_BUDGET}-byte fixture budget`);
  }
  const guardMs = options.guardMs ?? 20_000;
  const childWatchdogMs = guardMs + 5_000;
  const closeJoinMs = childWatchdogMs + 5_000;
  const dir = join(root.path, name);
  const artifactDir = join(dir, "artifacts");
  const childScript = join(dir, "framing-child.cjs");
  const planPath = join(dir, "plan.json");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(childScript, framingChildSource(), "utf8");
  await writeFile(planPath, JSON.stringify(plan), "utf8");

  const state: ObserverState = {
    stdout: createObserver(options.strictStdout ?? [], options.strictStdout !== undefined),
    stderr: createObserver([], false),
  };
  const barrierServer = options.strictStdout !== undefined ? await startBarrierServer(state) : undefined;
  const realSpawn = childProcessExports.spawn;
  const captured = createCapturedChild(dir);
  let closed: Promise<ChildClose> | undefined;

  const exits: FramingRun["exits"] = [];
  const observations: ExecutorToolObservation[] = [];
  let probe: NewlineSearchProbe | undefined;
  let result: ExecutorTurn | undefined;
  let primaryFailure: unknown;
  let cleanup: CleanupOutcome = { action: "no-child" };
  let childClose: ChildClose | undefined;
  let runPromise: Promise<ExecutorTurn> | undefined;
  let runSettled = true;
  try {
    childProcessExports.spawn = ((file: string, args?: readonly string[], spawnOptions?: SpawnOptions) => {
      const proc = realSpawn(file, args ?? [], spawnOptions ?? {});
      if (closed === undefined && captured.proc === undefined && proc.pid !== undefined) {
        // Actual close of this captured handle, observed before any adapter
        // listener or await.
        closed = new Promise<ChildClose>((resolve) => { proc.once("close", (code, signal) => resolve({ code, signal })); });
      }
      attachCapture(captured, proc);
      proc.stdout?.on("data", (chunk: Buffer) => observeChunk("stdout", chunk, state));
      proc.stderr?.on("data", (chunk: Buffer) => observeChunk("stderr", chunk, state));
      return proc;
    }) as TestSpawn;
    const adapter = new CodexExecutorAdapter({
      id: "codex",
      adapter: "codex-cli",
      command: process.execPath,
      args: [childScript],
      model: "gpt-test",
      timeoutMs: options.adapterTimeoutMs ?? 15_000,
      env: {
        PRG_FRAME_PLAN: planPath,
        PRG_FRAME_BARRIER: barrierServer ? barrierServer.endpoint : "",
        PRG_FRAME_WATCHDOG_MS: String(childWatchdogMs),
        PRG_FRAME_STDOUT_BUDGET: String(FRAMING_CHILD_STDOUT_BUDGET),
      },
    });
    probe = installAdapterNewlineSearchProbe();
    runPromise = adapter.run({
      cwd: dir,
      prompt: "work",
      artifactDir,
      turn: 1,
      onProcessExit: (exit) => { exits.push(exit); },
      onToolObservation: (observation) => { observations.push(observation); },
    });
    result = await withTimeout(runPromise, `Codex ${name} framing fixture`, guardMs);
  } catch (error) {
    primaryFailure = error;
  } finally {
    probe?.restore();
    childProcessExports.spawn = realSpawn;
    cleanup = settleFixtureChild(captured);
    // Closing the barrier first releases a child held on a gate promptly.
    if (barrierServer) await barrierServer.close();
    if (closed !== undefined) childClose = await boundedJoin(closed, closeJoinMs);
    // An abandoned run (outer guard fired) still settles after its child
    // closes; join it so nothing writes into the root after removal.
    if (runPromise !== undefined && (closed === undefined || childClose !== undefined)) {
      runSettled = (await boundedJoin(runPromise.then(() => true, () => true), 10_000)) === true;
    }
  }
  const closeUnproven = closed !== undefined && childClose === undefined;
  if (closeUnproven || !runSettled) {
    root.retained.push(dir);
    const detail = closeUnproven
      ? `${name} fixture child pid ${String(captured.pid)} has no observed close within ${closeJoinMs}ms `
        + `(cleanup: ${JSON.stringify(cleanup)}); fixture root retained at ${root.path}`
      : `${name} adapter run did not settle after child close ${JSON.stringify(childClose)}; fixture root retained at ${root.path}`;
    throw new Error(primaryFailure === undefined ? detail : `${errorMessage(primaryFailure)} | ${detail}`, {
      cause: primaryFailure instanceof Error ? primaryFailure : undefined,
    });
  }
  if (barrierServer) throwIfBarrierErrors(barrierServer, name, primaryFailure);
  if (primaryFailure !== undefined || result === undefined) {
    throw new Error(`${errorMessage(primaryFailure)} | ${name} fixture cleanup: ${JSON.stringify(cleanup)}; child close: ${JSON.stringify(childClose ?? "no child spawned")}`, {
      cause: primaryFailure instanceof Error ? primaryFailure : undefined,
    });
  }
  if (options.strictStdout !== undefined) assertObservedExactly("stdout", state);

  const turnDir = join(artifactDir, "executor", "0001");
  const [rawStream, processResultJson] = await Promise.all([
    readFile(join(turnDir, "raw-stream.txt"), "utf8"),
    readFile(join(turnDir, "process-result.json"), "utf8"),
  ]);
  return {
    result,
    rawStream,
    processResult: JSON.parse(processResultJson) as Record<string, unknown>,
    exits,
    observations,
    stdoutChunks: state.stdout.observed,
    newlineSearch: { calls: probe?.calls ?? 0, examined: probe?.examined ?? 0 },
    spawnedPid: captured.pid,
    cleanup,
    childClose,
  };
}

function frameLine(value: unknown): string {
  return JSON.stringify(value);
}

function agentMessageFrame(text: string): string {
  return frameLine({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text } } });
}

const turnCompletedFrame = frameLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" } } });

function assertSettledBy(run: FramingRun, expected: { code: number | null; signal: NodeJS.Signals | null }, label: string): void {
  assert.ok(run.spawnedPid !== undefined, `${label}: the fixture must observe the real spawned child`);
  assert.equal(run.exits.length, 1, `${label}: exactly one real child close`);
  assert.equal(run.exits[0]?.pid, run.spawnedPid);
  assert.equal(run.exits[0]?.code, expected.code);
  assert.equal(run.exits[0]?.signal, expected.signal);
  assert.equal(run.cleanup.action, "already-settled", `${label}: cleanup must find the child settled and send no signal`);
  assert.deepEqual(run.childClose, expected, `${label}: the captured handle's actual close must be observed`);
}

test("Codex app-server frames split, glued, CRLF, blank, and malformed lines while searching each character once (#239)", async () => {
  await withFramingRoot("pi-review-codex-framing-", async (root) => {
    const alpha = agentMessageFrame("alpha 日本語 🚀");
    const command = frameLine({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "cmd-1", command: "echo hi", aggregatedOutput: "hi 🚀\n", exitCode: 0, status: "completed" } },
    });
    const bravo = agentMessageFrame("bravo");
    const charlie = agentMessageFrame("charlie ✓");
    const unknownResponse = frameLine({ jsonrpc: "2.0", id: 99, result: { ignored: true } });

    // Many tiny events for the first line (5-byte pieces, several cutting a
    // multibyte sequence), then events carrying blank and CRLF lines, several
    // records, an LF-straddling record, a malformed line followed by a valid
    // record that spans two more events, an LF arriving alone, and finally an
    // ignored unknown-id response glued to turn/completed.
    const alphaBytes = Buffer.from(`${alpha}\n`, "utf8");
    const turnChunks: Buffer[] = [];
    for (let offset = 0; offset < alphaBytes.length; offset += 5) turnChunks.push(alphaBytes.subarray(offset, offset + 5));
    turnChunks.push(
      Buffer.from(`\n  \r\n${command}\r\n${bravo.slice(0, 10)}`, "utf8"),
      Buffer.from(`${bravo.slice(10)}\nnot json {日本語\n${charlie.slice(0, 20)}`, "utf8"),
      Buffer.from(charlie.slice(20), "utf8"),
      Buffer.from("\n", "utf8"),
      Buffer.from(`${unknownResponse}\n${turnCompletedFrame}\n`, "utf8"),
    );
    const base = [initResponseLine, threadResponseLine, turnResponseLine];
    const plan: FramePlan = {
      responses: {
        initialize: [exactStep(initResponseLine)],
        "thread/start": [exactStep(threadResponseLine)],
        "turn/start": [exactStep(turnResponseLine, { release: 2 })],
      },
      // The final chunk is not gated: the adapter terminates the child once
      // turn/completed routes, so it must not be left waiting on the barrier.
      turn: turnChunks.map((chunk, index) => exactStep(chunk, index === turnChunks.length - 1 ? {} : { release: base.length + index })),
    };
    const run = await runFramingFixture(root, "split", plan, { strictStdout: [...base, ...turnChunks] });

    const expectedStdout = Buffer.concat([...base, ...turnChunks]).toString("utf8");
    assert.equal(run.rawStream, expectedStdout);
    assert.equal(run.result.failure, undefined);
    assert.equal(run.result.code, 0);
    assert.equal(run.result.session.id, THREAD_ID);
    assert.equal(run.result.text, "alpha 日本語 🚀\nbravo\ncharlie ✓");
    const commandEnd = run.observations.find((event) => event.observationId === "cmd-1" && event.stage === "end");
    assert.ok(commandEnd, "the CRLF-terminated commandExecution record must route as a tool observation");
    assert.equal(commandEnd.toolName, "bash");
    assert.deepEqual(commandEnd.result, { output: "hi 🚀\n", exitCode: 0, status: "completed" });
    assert.equal(run.processResult.stdoutTruncated, false);

    // Deterministic work oracle: each decoded character examined exactly once.
    // The strict barrier (asserted inside the runner) proves the first line
    // alone arrived as this many separate data events, so a rescan of the
    // pending prefix on any of them cannot satisfy the equality below.
    assert.ok(turnChunks.length - 5 >= 10, "the first line must span many separate data events");
    assert.ok(run.newlineSearch.calls > 0, "the scoped probe must observe the adapter's newline searches");
    assert.equal(run.newlineSearch.examined, expectedStdout.length,
      "newline search must examine each decoded stdout character exactly once, never rescanning a pending prefix");
    assertSettledBy(run, { code: null, signal: "SIGTERM" }, "split framing");
  });
});

test("Codex app-server routes valid frames above 16 MiB unchanged with linear newline search (#239)", async () => {
  await withFramingRoot("pi-review-codex-framing-large-", async (root) => {
    // Synthetic valid wire shapes the adapter consumes — a thread/start
    // response and an agentMessage completion, each a single 17 MiB line —
    // not claimed real-world maxima. There is no frame cap to cross; this
    // pins that both still route completely.
    const size = 17 * 1024 * 1024;
    const threadPrefix = `{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"${THREAD_ID}"},"padding":"`;
    const agentPrefix = '{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"type":"agentMessage","text":"';
    const agentSuffix = " — fin 🚀";
    const plan: FramePlan = {
      responses: {
        initialize: [exactStep(initResponseLine)],
        "thread/start": [{ prefix: threadPrefix, fill: "p", count: size, suffix: '"}}\n' }],
        "turn/start": [exactStep(turnResponseLine)],
      },
      turn: [
        { prefix: agentPrefix, fill: "x", count: size, suffix: `${agentSuffix}"}}}\n` },
        exactStep(Buffer.from(`${turnCompletedFrame}\n`, "utf8")),
      ],
    };
    const run = await runFramingFixture(root, "large", plan, { adapterTimeoutMs: 45_000, guardMs: 60_000 });

    const expectedText = `${"x".repeat(size)}${agentSuffix}`;
    assert.equal(run.result.failure, undefined);
    assert.equal(run.result.code, 0);
    assert.equal(run.result.session.id, THREAD_ID, "the 17 MiB thread/start response must resolve its pending request");
    assert.equal(run.result.text.length, expectedText.length);
    assert.ok(run.result.text === expectedText, "the 17 MiB agent message must be the final text, intact");
    const expectedStdoutLength = initResponseLine.toString("utf8").length
      + threadPrefix.length + size + '"}}\n'.length
      + turnResponseLine.toString("utf8").length
      + agentPrefix.length + size + `${agentSuffix}"}}}\n`.length
      + turnCompletedFrame.length + 1;
    assert.equal(run.rawStream.length, expectedStdoutLength);
    assert.equal(run.processResult.stdoutTruncated, false);
    assert.ok(run.stdoutChunks.length > 2, "the large frames must arrive across multiple data events");
    assert.equal(run.newlineSearch.examined, expectedStdoutLength,
      "newline search must examine each decoded stdout character exactly once across large frames");
    assertSettledBy(run, { code: null, signal: "SIGTERM" }, "large framing");
  });
});

test("Codex app-server leaves a final line without LF unparsed and settles pending work at close (#239)", async () => {
  await withFramingRoot("pi-review-codex-framing-tail-", async (root) => {
    // Pending request: the thread/start response arrives complete except for
    // its LF, then the child exits normally. The request must reject through
    // the existing close path, not resolve from the unterminated tail.
    const threadNoLf = frameLine({ jsonrpc: "2.0", id: 2, result: { thread: { id: THREAD_ID } } });
    const requestRun = await runFramingFixture(root, "request-tail", {
      responses: {
        initialize: [exactStep(initResponseLine)],
        "thread/start": [exactStep(Buffer.from(threadNoLf, "utf8"), { exit: true })],
      },
      turn: [],
    });
    assert.equal(requestRun.result.code, 1);
    assert.equal(requestRun.result.failure?.category, "protocol");
    assert.equal(requestRun.result.failure?.message, "Codex app-server exited before completing pending protocol work (0).");
    assert.equal(requestRun.result.session.id, "missing");
    assert.equal(requestRun.rawStream, `${initResponseLine.toString("utf8")}${threadNoLf}`);
    assertSettledBy(requestRun, { code: 0, signal: null }, "request tail");

    // Pending turn wait: a complete agent message routes, then a valid
    // turn/completed line padded to span several data events arrives without
    // LF and the child exits. The retained fragments are never parsed, so the
    // turn wait rejects at close rather than completing.
    const paddedCompletion = frameLine({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" }, padding: "z".repeat(512 * 1024) },
    });
    const turnRun = await runFramingFixture(root, "turn-tail", {
      responses: {
        initialize: [exactStep(initResponseLine)],
        "thread/start": [exactStep(threadResponseLine)],
        "turn/start": [exactStep(turnResponseLine)],
      },
      turn: [
        exactStep(Buffer.from(`${agentMessageFrame("delivered")}\n`, "utf8")),
        exactStep(Buffer.from(paddedCompletion, "utf8"), { exit: true }),
      ],
    });
    assert.equal(turnRun.result.code, 1);
    assert.equal(turnRun.result.failure?.category, "protocol");
    assert.equal(turnRun.result.failure?.message, "Codex app-server exited before completing pending protocol work (0).");
    assert.equal(turnRun.result.text, "delivered");
    assert.ok(turnRun.rawStream.endsWith(paddedCompletion), "the unterminated tail is retained in the capture");
    assert.ok(turnRun.stdoutChunks.length > 4, "the unterminated tail must span multiple data events");
    assert.equal(turnRun.newlineSearch.examined, turnRun.rawStream.length);
    assertSettledBy(turnRun, { code: 0, signal: null }, "turn tail");
  });
});

test("Codex framing fixture settles and joins a hung child's actual close before removing its root (#239)", async () => {
  // Fixture failure path, not adapter behavior: the child never answers
  // thread/start, the outer guard fires first, and the shared fail-closed
  // settle must run before the captured handle's actual close and the
  // abandoned adapter run are joined. The root is removed only afterwards.
  let observedRoot: FramingRoot | undefined;
  await withFramingRoot("pi-review-codex-framing-hung-", async (root) => {
    observedRoot = root;
    await assert.rejects(
      runFramingFixture(root, "hung", { responses: { initialize: [exactStep(initResponseLine)] }, turn: [] }, { adapterTimeoutMs: 60_000, guardMs: 500 }),
      (error: unknown) => {
        const message = errorMessage(error);
        assert.match(message, /did not settle within the bounded guard/);
        if (process.platform === "win32") {
          // No portable cwd verification: no signal; the child's own watchdog ends it.
          assert.match(message, /"action":"unverified-identity"/);
          assert.match(message, /child close: \{"code":124,"signal":null\}/);
        } else {
          assert.match(message, /"action":"signaled"/);
          assert.match(message, /child close: \{"code":null,"signal":"SIGKILL"\}/);
        }
        return true;
      },
    );
    assert.deepEqual(root.retained, [], "a joined close must not retain the fixture root");
  });
  assert.ok(observedRoot !== undefined);
  await assert.rejects(readFile(join(observedRoot.path, "hung", "plan.json")), { code: "ENOENT" }, "the fixture root is removed after settlement");
});
