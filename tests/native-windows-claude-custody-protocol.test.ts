/**
 * Private Windows Claude custody supervisor transport (#682), portable tests.
 *
 * Fake owned processes (an EventEmitter with PassThrough stdio) stand in for
 * the supervisor; two tests use a real `node -e` child speaking the same
 * closed protocol, so the transport is exercised against a genuine
 * ChildProcess on any platform. No PowerShell, PTY, provider, setting, or
 * filesystem scratch is used, and every real child is drained to `close`
 * before its test ends.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import {
  NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDERR_BYTES,
  attachNativeWindowsClaudeCustodyTransport,
  type NativeWindowsClaudeCustodyTransport,
  type NativeWindowsClaudeCustodyTransportOptions,
} from "../src/session-host/native-windows-claude-custody-protocol";

const SUP_PID = 4100;
const WRAPPER_PID = 4204;
const CHILD_PID = 4308;
const RUN = Object.freeze({ runId: "run-682-a", generation: 3 });
const SOURCE = "$ErrorActionPreference = 'Stop'\r\n# synthetic boot source\r\n";
const SECRET = "RAW-SENTINEL-682-do-not-surface";

/* -------------------------------------------------------- fake process */

class FakeSupervisor extends EventEmitter {
  pid: number | undefined = SUP_PID;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  /** When false, kill() is recorded but the process never exits. */
  killExits = true;
  private written = Buffer.alloc(0);
  stdinEnded = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written = Buffer.concat([this.written, chunk]);
    });
    this.stdin.on("end", () => {
      this.stdinEnded = true;
    });
  }

  get writtenText(): string {
    return this.written.toString("latin1");
  }

  get writtenBytes(): Buffer {
    return this.written;
  }

  kill(): boolean {
    this.kills += 1;
    if (this.killExits) void this.exit(null, "SIGTERM");
    return true;
  }

  async line(text: string): Promise<void> {
    this.stdout.write(`${text}\n`);
    await settleIo();
  }

  async raw(bytes: string | Buffer): Promise<void> {
    this.stdout.write(bytes);
    await settleIo();
  }

  /** Exit, end both output pipes, then emit `close` (as Node does). */
  async exit(code: number | null, signal: NodeJS.Signals | null = null): Promise<void> {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    await settleIo();
    this.stdout.end();
    this.stderr.end();
    await settleIo();
    this.emit("close", code, signal);
    await settleIo();
  }
}

async function settleIo(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function attach(
  fake: FakeSupervisor,
  overrides: Partial<NativeWindowsClaudeCustodyTransportOptions> = {},
): NativeWindowsClaudeCustodyTransport {
  const result = attachNativeWindowsClaudeCustodyTransport({
    child: fake as unknown as ChildProcess,
    run: RUN,
    isRunCurrent: () => true,
    deadlines: { readyMs: 200, peerMs: 200, childMs: 200, settleMs: 200 },
    ...overrides,
  });
  assert.equal(result.status, "attached");
  return result.status === "attached" ? result.transport : (undefined as never);
}

function bootBytes(source: string): string {
  return `PRG-WCS1 ${String(source.length).padStart(8, "0")}\n${source}`;
}

/** Drive a fake to the `child` phase. */
async function toChild(fake: FakeSupervisor, transport: NativeWindowsClaudeCustodyTransport): Promise<void> {
  const started = transport.start(SOURCE);
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  assert.deepEqual(await started, { status: "ready-for-pty-spawn", supervisorPid: SUP_PID });
  await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const confirmed = transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  assert.ok(fake.writtenText.endsWith(`CONFIRM ${WRAPPER_PID}\n`));
  await fake.line(`SUP_GO ${WRAPPER_PID}`);
  assert.deepEqual(await confirmed, { status: "peer-confirmed", wrapperPid: WRAPPER_PID });
  await fake.line(`SUP_CHILD ${CHILD_PID}`);
  assert.deepEqual(await transport.awaitChild(), { status: "child-established", childPid: CHILD_PID });
}

function assertNoRaw(...values: unknown[]): void {
  for (const value of values) assert.ok(!JSON.stringify(value).includes(SECRET), "raw sensitive bytes surfaced");
}

/* -------------------------------------------------------------- attach */

test("attach refuses malformed options, non-running children, shared stdio, and double attachment", () => {
  const base = (): NativeWindowsClaudeCustodyTransportOptions => ({
    child: new FakeSupervisor() as unknown as ChildProcess,
    run: RUN,
    isRunCurrent: () => true,
  });
  const refuse = (options: unknown, code: string): void => {
    const result = attachNativeWindowsClaudeCustodyTransport(options as NativeWindowsClaudeCustodyTransportOptions);
    assert.deepEqual(result, { status: "refused", code });
  };
  refuse(null, "options-invalid");
  refuse({ ...base(), run: { runId: "", generation: 1 } }, "options-invalid");
  refuse({ ...base(), run: { runId: "bad id", generation: 1 } }, "options-invalid");
  refuse({ ...base(), run: { runId: "ok", generation: 0 } }, "options-invalid");
  refuse({ ...base(), isRunCurrent: true }, "options-invalid");
  refuse({ ...base(), deadlines: { readyMs: 0 } }, "options-invalid");
  refuse({ ...base(), deadlines: { settleMs: 10_000_000 } }, "options-invalid");
  refuse({ ...base(), signal: {} }, "options-invalid");

  const noPid = new FakeSupervisor();
  noPid.pid = undefined;
  refuse({ ...base(), child: noPid }, "child-not-running");
  const exited = new FakeSupervisor();
  exited.exitCode = 0;
  refuse({ ...base(), child: exited }, "child-not-running");

  const flowing = new FakeSupervisor();
  flowing.stdout.on("data", () => undefined);
  refuse({ ...base(), child: flowing }, "stdio-unavailable");
  const encoded = new FakeSupervisor();
  encoded.stderr.setEncoding("utf8");
  refuse({ ...base(), child: encoded }, "stdio-unavailable");
  const endedStdin = new FakeSupervisor();
  endedStdin.stdin.end();
  refuse({ ...base(), child: endedStdin }, "stdio-unavailable");

  const once = new FakeSupervisor();
  const first = attach(once);
  refuse({ ...base(), child: once }, "already-attached");
  first.dispose();
});

/* ----------------------------------------------------------- handshake */

test("verified handshake and witnessed settlement write only the closed frames", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  assert.equal(transport.phase, "attached");
  await toChild(fake, transport);

  const settled = transport.settle();
  await settleIo();
  await fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  assert.equal(transport.phase, "settled-record");
  await fake.raw("SUP_BYE\r\n");
  assert.equal(fake.stdinEnded, true, "driver ends stdin after SUP_BYE");
  await fake.exit(0);
  assert.deepEqual(await settled, {
    status: "settled",
    witness: { supervisorPid: SUP_PID, jobActive: 0, jobListed: 0, exitCode: 0 },
  });
  assert.equal(transport.phase, "settled");
  assert.equal(fake.kills, 0);
  assert.equal(
    fake.writtenText,
    `${bootBytes(SOURCE)}CONFIRM ${WRAPPER_PID}\nSETTLE\n`,
  );
  assert.equal(fake.writtenBytes.subarray(0, NATIVE_WINDOWS_CLAUDE_CUSTODY_BOOT_HEADER_BYTES).toString("ascii"), `PRG-WCS1 ${String(SOURCE.length).padStart(8, "0")}\n`);
  const diag = transport.diagnostics();
  assert.equal(diag.phase, "settled");
  assert.equal(diag.poisonCode, null);
  assert.equal(diag.recordsAccepted, 6);
  assert.deepEqual(await transport.drain(), { status: "closed" });
  assert.equal(transport.phase, "settled", "drain after settlement does not poison");
});

test("settlement is allowed before any wrapper connected (PTY never spawned)", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const started = transport.start(SOURCE);
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  await started;
  const settled = transport.settle();
  await settleIo();
  await fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await fake.line("SUP_BYE");
  await fake.exit(0);
  assert.equal((await settled).status, "settled");
});

test("an invalid boot source is refused without writing or changing state", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  for (const bad of ["", "café", "nul\u0000byte", "x".repeat(NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_SOURCE_BYTES + 1), 42 as unknown as string]) {
    assert.deepEqual(await transport.start(bad), { status: "failed", code: "source-invalid", poisoned: false });
  }
  await settleIo();
  assert.equal(fake.writtenBytes.length, 0);
  assert.equal(transport.phase, "attached");
  const started = transport.start(SOURCE);
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  assert.equal((await started).status, "ready-for-pty-spawn");
  transport.dispose();
});

test("SUP_READY naming a different PID poisons and kills the owned process", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const started = transport.start(SOURCE);
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID + 4}`);
  assert.deepEqual(await started, { status: "failed", code: "pid-mismatch", poisoned: true });
  assert.equal(fake.kills, 1);
  assert.equal(fake.stdin.destroyed, true);
  assert.deepEqual(await transport.drain(), { status: "closed" });
});

/* ---------------------------------------------------------------- peer */

test("a missing provisional peer poisons without writing CONFIRM", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake, { deadlines: { peerMs: 30 } });
  const started = transport.start(SOURCE);
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  await started;
  const before = fake.writtenText;
  assert.deepEqual(await transport.confirmPeer(() => WRAPPER_PID), { status: "failed", code: "peer-missing", poisoned: true });
  assert.equal(fake.writtenText, before);
  assert.equal(fake.kills, 1);
});

for (const [label, reading] of [
  ["undefined", () => undefined],
  ["zero", () => 0],
  ["negative", () => -WRAPPER_PID],
  ["fractional", () => WRAPPER_PID + 0.5],
  ["string", () => String(WRAPPER_PID)],
  ["throwing", () => {
    throw new Error(SECRET);
  }],
] as const) {
  test(`an unavailable node-pty PID (${label}) poisons without writing CONFIRM`, async () => {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    const started = transport.start(SOURCE);
    await settleIo();
    await fake.line(`SUP_READY ${SUP_PID}`);
    await started;
    await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
    const result = await transport.confirmPeer(reading);
    assert.deepEqual(result, { status: "failed", code: "pty-pid-unavailable", poisoned: true });
    assert.ok(!fake.writtenText.includes("CONFIRM"));
    assertNoRaw(result, transport.diagnostics());
  });
}

test("a mismatched provisional peer poisons without writing CONFIRM", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const started = transport.start(SOURCE);
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  await started;
  // The wrapper report may arrive while confirmPeer is already waiting.
  const confirmed = transport.confirmPeer(() => WRAPPER_PID + 4);
  await settleIo();
  await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  assert.deepEqual(await confirmed, { status: "failed", code: "peer-mismatch", poisoned: true });
  assert.ok(!fake.writtenText.includes("CONFIRM"));
  assert.equal(fake.kills, 1);
});

test("the node-pty PID is read at the write fence, not before the wrapper report", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const started = transport.start(SOURCE);
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  await started;
  let reads = 0;
  let current: number | undefined;
  const confirmed = transport.confirmPeer(() => {
    reads += 1;
    return current;
  });
  await settleIo();
  assert.equal(reads, 0);
  current = WRAPPER_PID;
  await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  assert.equal(reads, 1);
  await fake.line(`SUP_GO ${WRAPPER_PID}`);
  assert.equal((await confirmed).status, "peer-confirmed");
  transport.dispose();
});

test("a wrapper PID equal to the supervisor PID, or a GO for another PID, poisons", async () => {
  const self = new FakeSupervisor();
  const t1 = attach(self);
  const s1 = t1.start(SOURCE);
  await settleIo();
  await self.line(`SUP_READY ${SUP_PID}`);
  await s1;
  await self.line(`SUP_WRAPPER ${SUP_PID} PROVISIONAL`);
  assert.equal(t1.diagnostics().poisonCode, "peer-mismatch");

  const go = new FakeSupervisor();
  const t2 = attach(go);
  const s2 = t2.start(SOURCE);
  await settleIo();
  await go.line(`SUP_READY ${SUP_PID}`);
  await s2;
  await go.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const confirmed = t2.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  await go.line(`SUP_GO ${WRAPPER_PID + 4}`);
  assert.deepEqual(await confirmed, { status: "failed", code: "pid-mismatch", poisoned: true });
});

test("a CHILD naming the supervisor or wrapper PID poisons", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const started = transport.start(SOURCE);
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  await started;
  await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const confirmed = transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  await fake.line(`SUP_GO ${WRAPPER_PID}`);
  await confirmed;
  const child = transport.awaitChild();
  await fake.line(`SUP_CHILD ${WRAPPER_PID}`);
  assert.deepEqual(await child, { status: "failed", code: "pid-mismatch", poisoned: true });
});

/* -------------------------------------------------------------- frames */

async function startedFake(): Promise<{ fake: FakeSupervisor; transport: NativeWindowsClaudeCustodyTransport }> {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const started = transport.start(SOURCE);
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  assert.equal((await started).status, "ready-for-pty-spawn");
  return { fake, transport };
}

for (const [label, line, code] of [
  ["garbage", `hello ${SECRET}`, "frame-invalid"],
  ["lowercase", `sup_wrapper ${WRAPPER_PID} provisional`, "frame-invalid"],
  ["missing PROVISIONAL", `SUP_WRAPPER ${WRAPPER_PID}`, "frame-invalid"],
  ["double space", `SUP_WRAPPER  ${WRAPPER_PID} PROVISIONAL`, "frame-invalid"],
  ["leading zero pid", `SUP_WRAPPER 0${WRAPPER_PID} PROVISIONAL`, "frame-invalid"],
  ["pid beyond DWORD", "SUP_WRAPPER 9999999999 PROVISIONAL", "frame-invalid"],
  ["trailing space", `SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL `, "frame-invalid"],
  ["empty line", "", "frame-invalid"],
  ["tab", `SUP_WRAPPER\t${WRAPPER_PID} PROVISIONAL`, "frame-invalid"],
  ["non-ASCII", `SUP_WRAPPER ${WRAPPER_PID} PROVISIONALé`, "frame-invalid"],
  ["unsolicited CHILD before GO", `SUP_CHILD ${CHILD_PID}`, "frame-unsolicited"],
  ["unsolicited BYE", "SUP_BYE", "frame-unsolicited"],
  ["unsolicited SETTLED", "SUP_SETTLED ACTIVE=0 LISTED=0", "frame-unsolicited"],
  ["duplicate READY", `SUP_READY ${SUP_PID}`, "frame-duplicate"],
  ["oversized", `SUP_WRAPPER ${"9".repeat(200)} ${SECRET}`, "frame-oversized"],
] as const) {
  test(`a ${label} record poisons fail-closed with no raw bytes surfaced`, async () => {
    const { fake, transport } = await startedFake();
    const pending = transport.confirmPeer(() => WRAPPER_PID);
    await settleIo();
    await fake.line(line);
    const result = await pending;
    assert.deepEqual(result, { status: "failed", code, poisoned: true });
    assert.equal(transport.phase, "poisoned");
    assert.equal(fake.kills, 1);
    assert.ok(!fake.writtenText.includes("CONFIRM"));
    assertNoRaw(result, transport.diagnostics());
    // Every later step reports the same poison and writes nothing.
    const written = fake.writtenBytes.length;
    assert.deepEqual(await transport.settle(), { status: "failed", code, poisoned: true });
    assert.equal(fake.writtenBytes.length, written);
    assert.deepEqual(await transport.drain(), { status: "closed" });
  });
}

test("a duplicate WRAPPER while unconfirmed poisons", async () => {
  const { fake, transport } = await startedFake();
  await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  assert.equal(transport.diagnostics().poisonCode, "frame-duplicate");
  assert.deepEqual(await transport.confirmPeer(() => WRAPPER_PID), { status: "failed", code: "frame-duplicate", poisoned: true });
});

test("any stdout before the bootstrap is unsolicited", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  await fake.line(`SUP_READY ${SUP_PID}`);
  assert.equal(transport.diagnostics().poisonCode, "frame-unsolicited");
  assert.deepEqual(await transport.start(SOURCE), { status: "failed", code: "frame-unsolicited", poisoned: true });
  assert.equal(fake.writtenBytes.length, 0);
});

test("an unterminated over-long partial line and a total stdout overflow poison", async () => {
  const a = await startedFake();
  await a.fake.raw(`SUP_WRAPPER ${"1".repeat(120)}`);
  assert.equal(a.transport.diagnostics().poisonCode, "frame-oversized");

  const b = await startedFake();
  // An admissible fragment, then one chunk past the lifetime bound.
  await b.fake.raw("SUP_WRAP");
  assert.equal(b.transport.diagnostics().poisonCode, null);
  await b.fake.raw(Buffer.alloc(1100, 0x0d));
  assert.equal(b.transport.diagnostics().poisonCode, "stdout-overflow");
});

test("stdout ending mid-line is truncation; stderr is discarded, counted, and bounded", async () => {
  const a = await startedFake();
  await a.fake.stderr.write(`${SECRET}\n`);
  await settleIo();
  await a.fake.raw(`SUP_WRAPPER ${WRAPPER_PID}`);
  a.fake.stdout.end();
  await settleIo();
  const diag = a.transport.diagnostics();
  assert.equal(diag.poisonCode, "stdout-truncated");
  assert.equal(diag.stderrBytes, SECRET.length + 1);
  assertNoRaw(diag);

  const b = await startedFake();
  b.fake.stderr.write(Buffer.alloc(NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_STDERR_BYTES + 1, 0x41));
  await settleIo();
  assert.equal(b.transport.diagnostics().poisonCode, "stderr-overflow");
});

/* ------------------------------------------------------- process faults */

test("process death, process error, and stdin error mid-handshake poison", async () => {
  const dead = await startedFake();
  const pending = dead.transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  await dead.fake.exit(0);
  assert.deepEqual(await pending, { status: "failed", code: "process-exited", poisoned: true });
  assert.equal(dead.fake.kills, 0, "an exited process is not killed");

  const errored = await startedFake();
  errored.fake.emit("error", new Error(SECRET));
  await settleIo();
  assert.equal(errored.transport.diagnostics().poisonCode, "process-error");

  const pipe = await startedFake();
  pipe.fake.stdin.emit("error", new Error(`EPIPE ${SECRET}`));
  await settleIo();
  assert.equal(pipe.transport.diagnostics().poisonCode, "stdin-error");
  assertNoRaw(dead.transport.diagnostics(), errored.transport.diagnostics(), pipe.transport.diagnostics());
});

/* ---------------------------------------------------------- settlement */

async function settling(): Promise<{
  fake: FakeSupervisor;
  transport: NativeWindowsClaudeCustodyTransport;
  settled: ReturnType<NativeWindowsClaudeCustodyTransport["settle"]>;
}> {
  const fake = new FakeSupervisor();
  const transport = attach(fake, { deadlines: { settleMs: 60 } });
  await toChild(fake, transport);
  const settled = transport.settle();
  await settleIo();
  assert.ok(fake.writtenText.endsWith("SETTLE\n"));
  return { fake, transport, settled };
}

test("a nonzero job count is not settlement", async () => {
  for (const record of ["SUP_SETTLED ACTIVE=1 LISTED=0", "SUP_SETTLED ACTIVE=0 LISTED=2"]) {
    const { fake, settled } = await settling();
    await fake.line(record);
    assert.deepEqual(await settled, { status: "failed", code: "job-not-empty", poisoned: true });
    assert.equal(fake.kills, 1);
  }
});

test("BYE without the job-empty record, or exit before it, is not settlement", async () => {
  const noRecord = await settling();
  await noRecord.fake.line("SUP_BYE");
  assert.deepEqual(await noRecord.settled, { status: "failed", code: "frame-unsolicited", poisoned: true });

  const early = await settling();
  await early.fake.exit(0);
  assert.deepEqual(await early.settled, { status: "failed", code: "stdout-closed", poisoned: true });

  const afterRecord = await settling();
  await afterRecord.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await afterRecord.fake.exit(0);
  assert.deepEqual(await afterRecord.settled, { status: "failed", code: "stdout-closed", poisoned: true });
});

test("an abnormal exit or trailing bytes after BYE are not settlement", async () => {
  const abnormal = await settling();
  await abnormal.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await abnormal.fake.line("SUP_BYE");
  await abnormal.fake.exit(1);
  assert.deepEqual(await abnormal.settled, { status: "failed", code: "exit-abnormal", poisoned: true });

  const signalled = await settling();
  await signalled.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await signalled.fake.line("SUP_BYE");
  await signalled.fake.exit(null, "SIGKILL");
  assert.deepEqual(await signalled.settled, { status: "failed", code: "exit-abnormal", poisoned: true });

  const trailing = await settling();
  await trailing.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await trailing.fake.line("SUP_BYE");
  await trailing.fake.line("SUP_BYE");
  assert.deepEqual(await trailing.settled, { status: "failed", code: "frame-duplicate", poisoned: true });

  const partial = await settling();
  await partial.fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await partial.fake.line("SUP_BYE");
  await partial.fake.raw("x");
  // After BYE no fragment is admissible: poisoned at once, before any close.
  assert.deepEqual(await partial.settled, { status: "failed", code: "frame-unsolicited", poisoned: true });
});

test("records buffered before the exit event are still accepted in the settlement tail", async () => {
  const { fake, settled } = await settling();
  // Node may report `exit` before the final stdout bytes are read.
  fake.exitCode = 0;
  fake.emit("exit", 0, null);
  await settleIo();
  await fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await fake.line("SUP_BYE");
  fake.stdout.end();
  fake.stderr.end();
  await settleIo();
  fake.emit("close", 0, null);
  assert.equal((await settled).status, "settled");
});

test("a supervisor that never closes after BYE times out (unknown is not settlement)", async () => {
  const { fake, transport, settled } = await settling();
  fake.killExits = false;
  await fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await fake.line("SUP_BYE");
  assert.deepEqual(await settled, { status: "failed", code: "timeout", poisoned: true });
  assert.equal(fake.kills, 1);
  assert.deepEqual(await transport.drain({ timeoutMs: 20 }), { status: "not-closed", code: "timeout" });
  fake.killExits = true;
  await fake.exit(null, "SIGTERM");
  assert.deepEqual(await transport.drain({ timeoutMs: 20 }), { status: "closed" });
});

/* --------------------------------------------- cancellation and misuse */

test("deadlines, transport aborts, and step aborts poison as timeout/cancelled", async () => {
  const slow = new FakeSupervisor();
  const t1 = attach(slow, { deadlines: { readyMs: 20 } });
  assert.deepEqual(await t1.start(SOURCE), { status: "failed", code: "timeout", poisoned: true });
  assert.equal(slow.kills, 1);

  const controller = new AbortController();
  const aborted = new FakeSupervisor();
  const t2 = attach(aborted, { signal: controller.signal });
  const s2 = t2.start(SOURCE);
  await settleIo();
  controller.abort();
  assert.deepEqual(await s2, { status: "failed", code: "cancelled", poisoned: true });

  const stepFake = new FakeSupervisor();
  const t3 = attach(stepFake);
  const step = new AbortController();
  const s3 = t3.start(SOURCE, { signal: step.signal });
  await settleIo();
  step.abort();
  assert.deepEqual(await s3, { status: "failed", code: "cancelled", poisoned: true });

  const pre = new FakeSupervisor();
  const t4 = attach(pre, { signal: AbortSignal.abort() });
  assert.equal(t4.phase, "poisoned");
  assert.deepEqual(await t4.start(SOURCE), { status: "failed", code: "cancelled", poisoned: true });
  assert.equal(pre.writtenBytes.length, 0);
});

test("concurrent and out-of-order calls are refused without writing or poisoning", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  assert.deepEqual(await transport.awaitChild(), { status: "failed", code: "out-of-order", poisoned: false });
  assert.deepEqual(await transport.settle(), { status: "failed", code: "out-of-order", poisoned: false });
  const started = transport.start(SOURCE);
  assert.deepEqual(await transport.start(SOURCE), { status: "failed", code: "busy", poisoned: false });
  await settleIo();
  await fake.line(`SUP_READY ${SUP_PID}`);
  await started;
  assert.deepEqual(await transport.start(SOURCE), { status: "failed", code: "out-of-order", poisoned: false });
  assert.deepEqual(await transport.awaitChild(), { status: "failed", code: "out-of-order", poisoned: false });
  assert.equal(fake.writtenText, bootBytes(SOURCE));
  assert.equal(transport.diagnostics().poisonCode, null);
  transport.dispose();
  transport.dispose();
  assert.equal(transport.diagnostics().poisonCode, "disposed");
  assert.equal(fake.kills, 1);
});

/* --------------------------------------------------------- send bridge */

test("send bridge: exact-run two-phase prepare/commit never materializes the payload in this slice", async () => {
  let current = true;
  const fake = new FakeSupervisor();
  const transport = attach(fake, { isRunCurrent: () => current });
  let materialized = 0;
  const payload = (): string => {
    materialized += 1;
    return SECRET;
  };

  assert.deepEqual(transport.prepareSend(RUN), { status: "refused", code: "custody-not-current" });
  await toChild(fake, transport);
  assert.deepEqual(transport.prepareSend({ runId: RUN.runId, generation: RUN.generation + 1 }), { status: "refused", code: "run-not-current" });
  assert.deepEqual(transport.prepareSend({ runId: "run-682-b", generation: RUN.generation }), { status: "refused", code: "run-not-current" });

  const first = transport.prepareSend(RUN);
  assert.equal(first.status, "prepared");
  if (first.status !== "prepared") return;
  assert.deepEqual(transport.prepareSend(RUN), { status: "refused", code: "attempt-in-flight" });
  const written = fake.writtenBytes.length;
  assert.deepEqual(first.attempt.commit(payload), { status: "not-sent", code: "lane-unavailable" });
  assert.deepEqual(first.attempt.commit(payload), { status: "not-sent", code: "attempt-spent" });

  // Host revokes the run between prepare and commit: rejected without materializing.
  const second = transport.prepareSend(RUN);
  assert.equal(second.status, "prepared");
  if (second.status !== "prepared") return;
  current = false;
  assert.deepEqual(second.attempt.commit(payload), { status: "not-sent", code: "run-not-current" });
  current = true;

  // Abandon releases the slot.
  const third = transport.prepareSend(RUN);
  assert.equal(third.status, "prepared");
  if (third.status !== "prepared") return;
  third.attempt.abandon();
  assert.deepEqual(third.attempt.commit(payload), { status: "not-sent", code: "attempt-spent" });

  // Poison between prepare and commit: rejected without materializing.
  const fourth = transport.prepareSend(RUN);
  assert.equal(fourth.status, "prepared");
  if (fourth.status !== "prepared") return;
  await fake.line("SUP_BYE");
  assert.equal(transport.phase, "poisoned");
  assert.deepEqual(fourth.attempt.commit(payload), { status: "not-sent", code: "custody-not-current" });
  assert.deepEqual(transport.prepareSend(RUN), { status: "refused", code: "custody-not-current" });

  assert.equal(materialized, 0);
  assert.equal(fake.writtenBytes.length, written);
});

test("send commit keeps its slot while rechecking the current run", async () => {
  const fake = new FakeSupervisor();
  let onCheck: (() => void) | undefined;
  let materialized = 0;
  const transport = attach(fake, {
    isRunCurrent: () => {
      const check = onCheck;
      onCheck = undefined;
      check?.();
      return true;
    },
  });
  await toChild(fake, transport);
  const prepared = transport.prepareSend(RUN);
  if (prepared.status !== "prepared") assert.fail("expected a prepared attempt");
  let nested: unknown;
  onCheck = () => {
    nested = transport.prepareSend(RUN);
  };
  assert.deepEqual(prepared.attempt.commit(() => {
    materialized += 1;
    return SECRET;
  }), { status: "not-sent", code: "lane-unavailable" });
  assert.deepEqual(nested, { status: "refused", code: "attempt-in-flight" });
  assert.equal(materialized, 0);
  // Released after the commit finished.
  const next = transport.prepareSend(RUN);
  assert.equal(next.status, "prepared");
  if (next.status === "prepared") next.attempt.abandon();
  transport.dispose();
});

/* ------------------------------------------------- real child process */

const REAL_SUPERVISOR = String.raw`
"use strict";
const MODE = process.argv[1];
let buf = Buffer.alloc(0);
let booted = false;
const out = (s, done) => process.stdout.write(s, done);
process.stderr.write("synthetic-supervisor-stderr " + ${JSON.stringify(SECRET)} + "\n");
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!booted) {
    if (buf.length < 18) return;
    const header = buf.subarray(0, 18).toString("ascii");
    const m = /^PRG-WCS1 ([0-9]{8})\n$/.exec(header);
    if (!m) process.exit(3);
    const len = Number(m[1]);
    if (buf.length < 18 + len) return;
    buf = buf.subarray(18 + len);
    booted = true;
    if (MODE === "die-after-ready") {
      out("SUP_READY " + process.pid + "\n", () => process.exit(0));
      return;
    }
    if (MODE === "garbage") {
      out("SUP_READY " + process.pid + "\n");
      out(${JSON.stringify(SECRET)} + "\n");
      setInterval(() => {}, 1000);
      return;
    }
    out("SUP_READY " + process.pid + "\r\n");
    out("SUP_WRAPPER 424242 PROVISIONAL\r\n");
  }
  let nl;
  while ((nl = buf.indexOf(10)) >= 0) {
    const line = buf.subarray(0, nl).toString("ascii");
    buf = buf.subarray(nl + 1);
    if (line === "CONFIRM 424242") out("SUP_GO 424242\r\nSUP_CHILD 434343\r\n");
    else if (line === "SETTLE") out("SUP_SETTLED ACTIVE=0 LISTED=0\r\nSUP_BYE\r\n");
    else process.exit(4);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function spawnReal(t: TestContext, mode: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", REAL_SUPERVISOR, mode], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("close", resolve));
  });
  return child;
}

test("real child: verified handshake and witnessed settlement over genuine pipes", async (t) => {
  const child = spawnReal(t, "happy");
  const attached = attachNativeWindowsClaudeCustodyTransport({
    child,
    run: RUN,
    isRunCurrent: () => true,
    deadlines: { readyMs: 20_000, peerMs: 20_000, childMs: 20_000, settleMs: 20_000 },
  });
  assert.equal(attached.status, "attached");
  if (attached.status !== "attached") return;
  const transport = attached.transport;
  assert.deepEqual(await transport.start(SOURCE), { status: "ready-for-pty-spawn", supervisorPid: child.pid });
  assert.deepEqual(await transport.confirmPeer(() => 424242), { status: "peer-confirmed", wrapperPid: 424242 });
  assert.deepEqual(await transport.awaitChild(), { status: "child-established", childPid: 434343 });
  const settled = await transport.settle();
  assert.deepEqual(settled, {
    status: "settled",
    witness: { supervisorPid: child.pid, jobActive: 0, jobListed: 0, exitCode: 0 },
  });
  const diag = transport.diagnostics();
  assert.ok(diag.stderrBytes > 0, "stderr was drained");
  assertNoRaw(settled, diag);
  assert.equal(child.exitCode, 0);
});

test("real child: death after READY and a raw garbage line both poison; the process is settled", async (t) => {
  const dying = spawnReal(t, "die-after-ready");
  const a = attachNativeWindowsClaudeCustodyTransport({
    child: dying,
    run: RUN,
    isRunCurrent: () => true,
    deadlines: { readyMs: 20_000, peerMs: 20_000 },
  });
  assert.equal(a.status, "attached");
  if (a.status !== "attached") return;
  const started = await a.transport.start(SOURCE);
  // READY may be accepted before the exit is observed; either way custody fails closed.
  if (started.status === "ready-for-pty-spawn") {
    const confirmed = await a.transport.confirmPeer(() => 424242);
    assert.equal(confirmed.status, "failed");
    assert.ok(confirmed.status === "failed" && ["process-exited", "stdout-closed"].includes(confirmed.code));
  } else {
    assert.ok(["process-exited", "stdout-closed"].includes(started.code));
  }
  assert.deepEqual(await a.transport.drain({ timeoutMs: 20_000 }), { status: "closed" });

  const garbage = spawnReal(t, "garbage");
  const b = attachNativeWindowsClaudeCustodyTransport({ child: garbage, run: RUN, isRunCurrent: () => true });
  assert.equal(b.status, "attached");
  if (b.status !== "attached") return;
  // READY and the garbage line may arrive in one stdout chunk, in which case
  // start() itself must already report the poison (never a stale success).
  const startedB = await b.transport.start(SOURCE);
  const confirmed = startedB.status === "ready-for-pty-spawn" ? await b.transport.confirmPeer(() => 424242) : startedB;
  assert.deepEqual(confirmed, { status: "failed", code: "frame-invalid", poisoned: true });
  assert.deepEqual(await b.transport.drain({ timeoutMs: 20_000 }), { status: "closed" });
  assert.ok(garbage.exitCode !== null || garbage.signalCode !== null, "poison killed the owned process");
  assertNoRaw(confirmed, b.transport.diagnostics());
});

/* ---------------------------------------- provisional waits (review #1) */

/** Deliver bytes to the transport's stdout listener synchronously, in one chunk. */
function chunk(fake: FakeSupervisor, text: string): void {
  fake.stdout.emit("data", Buffer.from(text, "ascii"));
}

test("READY followed by a duplicate READY in one chunk never reports ready", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const started = transport.start(SOURCE);
  await settleIo();
  chunk(fake, `SUP_READY ${SUP_PID}\nSUP_READY ${SUP_PID}\n`);
  assert.deepEqual(await started, { status: "failed", code: "frame-duplicate", poisoned: true });
  assert.equal(fake.kills, 1);
});

test("GO or CHILD followed by an invalid record in one chunk never reports success", async () => {
  const a = await startedFake();
  await a.fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const confirmed = a.transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  chunk(a.fake, `SUP_GO ${WRAPPER_PID}\n${SECRET}\n`);
  const confirmResult = await confirmed;
  assert.deepEqual(confirmResult, { status: "failed", code: "frame-invalid", poisoned: true });
  assertNoRaw(confirmResult, a.transport.diagnostics());

  const b = await startedFake();
  await b.fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const c2 = b.transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  await b.fake.line(`SUP_GO ${WRAPPER_PID}`);
  await c2;
  const child = b.transport.awaitChild();
  await settleIo();
  chunk(b.fake, `SUP_CHILD ${CHILD_PID}\nSUP_CHILD ${CHILD_PID}\n`);
  assert.deepEqual(await child, { status: "failed", code: "frame-duplicate", poisoned: true });
});

test("a poison from a later close listener before settle resumes is not settlement", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  await toChild(fake, transport);
  // Registered after the transport's own close listener, so it runs after the
  // settlement waiter resolved but before the continuation.
  fake.on("close", () => transport.dispose());
  const settled = transport.settle();
  await settleIo();
  await fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await fake.line("SUP_BYE");
  await fake.exit(0);
  assert.deepEqual(await settled, { status: "failed", code: "disposed", poisoned: true });
  assert.equal(transport.phase, "poisoned");
});

test("transport abort from a later close listener prevents settlement", async () => {
  const fake = new FakeSupervisor();
  const controller = new AbortController();
  // An earlier consumer of the shared signal stops propagation.
  controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
  const transport = attach(fake, { signal: controller.signal });
  await toChild(fake, transport);
  fake.once("close", () => controller.abort());
  const settled = transport.settle();
  await settleIo();
  await fake.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await fake.line("SUP_BYE");
  await fake.exit(0);
  assert.deepEqual(await settled, { status: "failed", code: "cancelled", poisoned: true });
  assert.equal(transport.phase, "poisoned");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("aborting right after WRAPPER resolves, before the continuation, writes no CONFIRM", async () => {
  const { fake, transport } = await startedFake();
  const step = new AbortController();
  let reads = 0;
  const confirmed = transport.confirmPeer(() => {
    reads += 1;
    return WRAPPER_PID;
  }, { signal: step.signal });
  await settleIo();
  chunk(fake, `SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL\n`);
  step.abort();
  assert.deepEqual(await confirmed, { status: "failed", code: "cancelled", poisoned: true });
  assert.equal(reads, 0);
  assert.ok(!fake.writtenText.includes("CONFIRM"));
  assert.equal(getEventListeners(step.signal, "abort").length, 0);
});

test("aborting during the node-pty PID read (wrapper already buffered) writes no CONFIRM", async () => {
  const { fake, transport } = await startedFake();
  await fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const step = new AbortController();
  const result = await transport.confirmPeer(() => {
    step.abort();
    return WRAPPER_PID;
  }, { signal: step.signal });
  assert.deepEqual(result, { status: "failed", code: "cancelled", poisoned: true });
  assert.ok(!fake.writtenText.includes("CONFIRM"));
});

test("the transport abort hook is released on poison and close; drain registrations are released", async () => {
  const shared = new AbortController();
  const fake = new FakeSupervisor();
  const transport = attach(fake, { signal: shared.signal });
  assert.equal(getEventListeners(shared.signal, "abort").length, 1);
  await fake.line("SUP_BYE"); // unsolicited before boot: poison
  assert.equal(transport.diagnostics().poisonCode, "frame-unsolicited");
  assert.equal(getEventListeners(shared.signal, "abort").length, 0);
  assert.deepEqual(await transport.drain(), { status: "closed" });

  const hung = new FakeSupervisor();
  hung.killExits = false;
  const t2 = attach(hung, { signal: shared.signal });
  assert.equal(getEventListeners(shared.signal, "abort").length, 1);
  const drainAbort = new AbortController();
  assert.deepEqual(await t2.drain({ timeoutMs: 10 }), { status: "not-closed", code: "timeout" });
  assert.equal(getEventListeners(shared.signal, "abort").length, 0, "poisoned by drain: hook released");
  assert.equal(t2.diagnostics().pendingDrains, 0);
  const cancelled = t2.drain({ timeoutMs: 10_000, signal: drainAbort.signal });
  assert.equal(t2.diagnostics().pendingDrains, 1);
  drainAbort.abort();
  assert.deepEqual(await cancelled, { status: "not-closed", code: "cancelled" });
  assert.equal(t2.diagnostics().pendingDrains, 0);
  assert.equal(getEventListeners(drainAbort.signal, "abort").length, 0);
  const closing = t2.drain({ timeoutMs: 10_000 });
  await hung.exit(null, "SIGTERM");
  assert.deepEqual(await closing, { status: "closed" });
  assert.equal(t2.diagnostics().pendingDrains, 0);

  // A witnessed settlement releases the hook as well.
  const fine = new FakeSupervisor();
  const t3 = attach(fine, { signal: shared.signal });
  await toChild(fine, t3);
  const settled = t3.settle();
  await settleIo();
  await fine.line("SUP_SETTLED ACTIVE=0 LISTED=0");
  await fine.line("SUP_BYE");
  await fine.exit(0);
  assert.equal((await settled).status, "settled");
  assert.equal(getEventListeners(shared.signal, "abort").length, 0);
});

test("stopped propagation on shared attach and step signals still cancels before CONFIRM", async () => {
  const shared = new AbortController();
  shared.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
  const a = new FakeSupervisor();
  const ta = attach(a, { signal: shared.signal });
  const started = ta.start(SOURCE);
  await settleIo();
  await a.line(`SUP_READY ${SUP_PID}`);
  await started;
  await a.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const ra = await ta.confirmPeer(() => {
    shared.abort();
    return WRAPPER_PID;
  });
  assert.deepEqual(ra, { status: "failed", code: "cancelled", poisoned: true });
  assert.ok(!a.writtenText.includes("CONFIRM"));

  const step = new AbortController();
  step.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
  const { fake: b, transport: tb } = await startedFake();
  const confirming = tb.confirmPeer(() => WRAPPER_PID, { signal: step.signal });
  await settleIo();
  step.abort();
  assert.deepEqual(await confirming, { status: "failed", code: "cancelled", poisoned: true });
  assert.ok(!b.writtenText.includes("CONFIRM"));

  const drainStep = new AbortController();
  drainStep.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true });
  const hung = new FakeSupervisor();
  hung.killExits = false;
  const tc = attach(hung);
  const draining = tc.drain({ timeoutMs: 10_000, signal: drainStep.signal });
  drainStep.abort();
  assert.deepEqual(await draining, { status: "not-closed", code: "cancelled" });
  assert.equal(tc.diagnostics().pendingDrains, 0);
  await hung.exit(null, "SIGTERM");
});

/* ---------------------------------- buffered partial lines (cycle 4) */

test("an illegal fragment right after READY in the same chunk never reports ready", async () => {
  for (const [tail, code] of [
    [`SUP_GO ${WRAPPER_PID}`, "frame-unsolicited"],
    [`SUP_READY ${SUP_PID}`, "frame-duplicate"],
    ["SUP_SETTLED ACTIVE=0", "frame-unsolicited"],
    [`SUP_WR\u00e9`, "frame-invalid"],
    ["SUP_WRAPPER\r4204", "frame-invalid"],
    ["junk", "frame-invalid"],
    [`SUP_WRAPPER ${"1".repeat(100)}`, "frame-oversized"],
    // Header matches, but no continuation can become a valid wrapper record.
    ["SUP_WRAPPER x", "frame-invalid"],
    ["SUP_WRAPPER 0", "frame-invalid"],
    ["SUP_WRAPPER 04204", "frame-invalid"],
    ["SUP_WRAPPER 4294967296", "frame-invalid"],
    ["SUP_WRAPPER 12345678901", "frame-invalid"],
    [`SUP_WRAPPER ${WRAPPER_PID}  `, "frame-invalid"],
    [`SUP_WRAPPER ${WRAPPER_PID} PROVISIONALX`, "frame-invalid"],
    [`SUP_WRAPPER ${WRAPPER_PID} provisional`, "frame-invalid"],
    // CR may only follow a complete record.
    ["\r", "frame-invalid"],
    [`SUP_WRAPPER ${WRAPPER_PID}\r`, "frame-invalid"],
    [`SUP_WRAPPER ${WRAPPER_PID} PROV\r`, "frame-invalid"],
  ] as const) {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    const started = transport.start(SOURCE);
    await settleIo();
    fake.stdout.emit("data", Buffer.from(`SUP_READY ${SUP_PID}\n${tail}`, "latin1"));
    assert.deepEqual(await started, { status: "failed", code, poisoned: true }, tail);
    assert.equal(fake.kills, 1);
  }
});

test("a GO fragment before CONFIRM poisons; a late LF cannot authorize it and CONFIRM is never written", async () => {
  // Fragment after the wrapper report, before confirmPeer is even called.
  const a = await startedFake();
  await a.fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  await a.fake.raw(`SUP_GO ${WRAPPER_PID}`);
  assert.equal(a.transport.diagnostics().poisonCode, "frame-unsolicited");
  await a.fake.raw("\n");
  assert.deepEqual(await a.transport.confirmPeer(() => WRAPPER_PID), { status: "failed", code: "frame-unsolicited", poisoned: true });
  assert.ok(!a.fake.writtenText.includes("CONFIRM"));

  // Fragment in the same chunk as the wrapper report, while confirmPeer waits.
  const b = await startedFake();
  const confirming = b.transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  b.fake.stdout.emit("data", Buffer.from(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL\nSUP_GO ${WRAPPER_PID}`, "ascii"));
  assert.deepEqual(await confirming, { status: "failed", code: "frame-unsolicited", poisoned: true });
  assert.ok(!b.fake.writtenText.includes("CONFIRM"));
});

test("a SETTLED fragment before SETTLE poisons; settle never writes and never settles", async () => {
  // In the child phase nothing is admissible.
  const a = new FakeSupervisor();
  const ta = attach(a);
  await toChild(a, ta);
  await a.raw("SUP_SETTLED ACTIVE=0 LISTED=0");
  assert.equal(ta.diagnostics().poisonCode, "frame-unsolicited");
  await a.raw("\n");
  assert.deepEqual(await ta.settle(), { status: "failed", code: "frame-unsolicited", poisoned: true });
  assert.ok(!a.writtenText.includes("SETTLE"));

  // In the go phase only a CHILD fragment is admissible.
  const b = await startedFake();
  await b.fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const confirmed = b.transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  await b.fake.line(`SUP_GO ${WRAPPER_PID}`);
  await confirmed;
  await b.fake.raw("SUP_SETTLED ACTIVE=0 LISTED=0\r");
  assert.equal(b.transport.diagnostics().poisonCode, "frame-unsolicited");
  assert.ok(!b.fake.writtenText.includes("SETTLE"));
});

test("no command is written while an admissible fragment is still pending", async () => {
  // READY phase admits a WRAPPER fragment, but SETTLE must not be written past it.
  const a = await startedFake();
  await a.fake.raw(`SUP_WRAPPER ${WRAPPER_PID} PROV`);
  assert.equal(a.transport.diagnostics().poisonCode, null);
  assert.deepEqual(await a.transport.settle(), { status: "failed", code: "frame-unsolicited", poisoned: true });
  assert.ok(!a.fake.writtenText.includes("SETTLE"));

  // GO phase admits a CHILD fragment, but SETTLE must not be written past it.
  const b = await startedFake();
  await b.fake.line(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`);
  const confirmed = b.transport.confirmPeer(() => WRAPPER_PID);
  await settleIo();
  await b.fake.line(`SUP_GO ${WRAPPER_PID}`);
  await confirmed;
  await b.fake.raw(`SUP_CHILD ${CHILD_PID}`);
  assert.deepEqual(await b.transport.settle(), { status: "failed", code: "frame-unsolicited", poisoned: true });
  assert.ok(!b.fake.writtenText.includes("SETTLE"));
});

test("valid byte-by-byte fragmentation (with CRLF) still completes the full handshake and settlement", async () => {
  const fake = new FakeSupervisor();
  const transport = attach(fake);
  const drip = async (text: string): Promise<void> => {
    for (const ch of text) {
      fake.stdout.emit("data", Buffer.from(ch, "ascii"));
      assert.equal(transport.diagnostics().poisonCode, null, `poisoned at ${JSON.stringify(ch)}`);
    }
    await settleIo();
  };
  const started = transport.start(SOURCE);
  await settleIo();
  await drip(`SUP_READY ${SUP_PID}\r\n`);
  assert.equal((await started).status, "ready-for-pty-spawn");
  const confirmed = transport.confirmPeer(() => WRAPPER_PID);
  await drip(`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL\r\n`);
  await settleIo();
  assert.ok(fake.writtenText.endsWith(`CONFIRM ${WRAPPER_PID}\n`));
  await drip(`SUP_GO ${WRAPPER_PID}\r\nSUP_CHILD ${CHILD_PID}\r\n`);
  assert.equal((await confirmed).status, "peer-confirmed");
  assert.deepEqual(await transport.awaitChild(), { status: "child-established", childPid: CHILD_PID });
  const settled = transport.settle();
  await settleIo();
  await drip("SUP_SETTLED ACTIVE=0 LISTED=0\r\nSUP_BYE\r\n");
  await fake.exit(0);
  assert.equal((await settled).status, "settled");
  assert.equal(fake.writtenText, `${bootBytes(SOURCE)}CONFIRM ${WRAPPER_PID}\nSETTLE\n`);
});

test("every proper prefix of each valid record is admissible in its own phase", async () => {
  const prefixes = (line: string): string[] => [...Array.from({ length: line.length }, (_, n) => line.slice(0, n + 1)), `${line}\r`];
  const probe = async (
    open: () => Promise<{ fake: FakeSupervisor; transport: NativeWindowsClaudeCustodyTransport; done?: Promise<unknown> }>,
    fragment: string,
    expected: string | null,
  ): Promise<void> => {
    const { fake, transport, done } = await open();
    fake.stdout.emit("data", Buffer.from(fragment, "ascii"));
    assert.equal(transport.diagnostics().poisonCode, expected, JSON.stringify(fragment));
    transport.dispose();
    await done;
  };
  const booting = async () => {
    const fake = new FakeSupervisor();
    const transport = attach(fake);
    const done = transport.start(SOURCE);
    await settleIo();
    return { fake, transport, done };
  };
  for (const fragment of prefixes(`SUP_READY ${SUP_PID}`)) await probe(booting, fragment, null);
  for (const line of [`SUP_WRAPPER ${WRAPPER_PID} PROVISIONAL`, "SUP_WRAPPER 4294967295 PROVISIONAL"]) {
    for (const fragment of prefixes(line)) await probe(startedFake, fragment, null);
  }
  // Settlement tail: SETTLED with any well-formed counts is a viable fragment;
  // a nonzero count is rejected only as job-not-empty once its LF arrives.
  const inSettling = async () => {
    const { fake, transport, settled } = await settling();
    return { fake, transport, done: settled };
  };
  for (const line of ["SUP_SETTLED ACTIVE=0 LISTED=0", "SUP_SETTLED ACTIVE=12 LISTED=3"]) {
    for (const fragment of prefixes(line)) await probe(inSettling, fragment, null);
  }
  for (const bad of ["SUP_SETTLED ACTIVE=00", "SUP_SETTLED ACTIVE=0 LISTED=0 ", "SUP_SETTLED ACTIVE=0\r", "SUP_SETTLED  "]) {
    await probe(inSettling, bad, "frame-invalid");
  }
});
