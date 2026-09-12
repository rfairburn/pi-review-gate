import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { BackgroundProcessReadiness } from "../src/background-process-readiness";

test("background readiness follows a process group after its original leader exits", { skip: process.platform === "win32" }, async () => {
  const leader = spawn(process.execPath, [
    "-e",
    "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},600)'],{stdio:'ignore'});child.unref();",
  ], {
    detached: true,
    stdio: "ignore",
  });
  const pid = leader.pid;
  assert.ok(pid);
  const readiness = new BackgroundProcessReadiness();
  readiness.observeToolResult(
    "ShellStart",
    { content: [{ type: "text", text: `Started "descendant" as job1 (pid ${pid}).` }] },
  );
  try {
    await once(leader, "close");
    assert.equal(readiness.snapshot().running.length, 1, "the surviving descendant must keep its original process group blocked");
    const deadline = Date.now() + 3_000;
    while (readiness.snapshot().running.length > 0 && Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert.equal(readiness.snapshot().running.length, 0);
  } finally {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
  }
});

test("an unparseable ShellStart success fails closed", () => {
  const readiness = new BackgroundProcessReadiness();
  readiness.observeToolResult("ShellStart", "Started a background command but pid reporting changed.");
  const snapshot = readiness.snapshot();
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.unverifiable.length, 1);
});

test("current ShellStart prose is accepted when structured details are unavailable", () => {
  const readiness = new BackgroundProcessReadiness();
  const tracked = readiness.observeToolResult(
    "ShellStart",
    'Started "mysql-test" as job1 (pid 96410); currently running.\nFuture wake triggers (not current events): exit.',
  );
  assert.deepEqual(tracked, {
    id: "job1",
    label: "mysql-test",
    pid: 96410,
    processGroupId: 96410,
  });
  assert.equal(readiness.snapshot().unverifiable.length, 0);
});

test("structured ShellStart details are authoritative over display prose", () => {
  const readiness = new BackgroundProcessReadiness();
  const tracked = readiness.observeToolResult("ShellStart", {
    content: [{ type: "text", text: "Started output wording may change freely." }],
    details: {
      kind: "pi-review-bg-shell",
      event: "started",
      id: "job7",
      label: "structured",
      pid: 12345,
      processGroupId: 12345,
    },
  });
  assert.deepEqual(tracked, {
    id: "job7",
    label: "structured",
    pid: 12345,
    processGroupId: 12345,
  });
  assert.equal(readiness.snapshot().unverifiable.length, 0);
});

test("readiness revisions invalidate a previously observed idle state", { skip: process.platform === "win32" }, async () => {
  const readiness = new BackgroundProcessReadiness();
  const first = spawn(process.execPath, ["-e", "setTimeout(()=>{},150)"], {
    detached: true,
    stdio: "ignore",
  });
  const firstPid = first.pid;
  assert.ok(firstPid);
  readiness.observeToolResult("ShellStart", `Started "first" as job1 (pid ${firstPid}).`);
  const runningRevision = readiness.snapshot().revision;
  await once(first, "close");
  const idle = readiness.snapshot();
  assert.equal(idle.running.length, 0);
  assert.ok(idle.revision > runningRevision);

  const second = spawn(process.execPath, ["-e", "setTimeout(()=>{},150)"], {
    detached: true,
    stdio: "ignore",
  });
  const secondPid = second.pid;
  assert.ok(secondPid);
  readiness.observeToolResult("ShellStart", `Started "second" as job2 (pid ${secondPid}).`);
  try {
    const restarted = readiness.snapshot();
    assert.equal(restarted.running.length, 1);
    assert.ok(restarted.revision > idle.revision);
  } finally {
    try { process.kill(-secondPid, "SIGKILL"); } catch { /* already exited */ }
  }
});

/*
 * Windows ownership record contract (#99 follow-up). These run on every
 * platform — they exercise the verdict and record logic directly, which is
 * exactly what the harness readiness tracker and the in-process controller
 * apply on win32. The native end-to-end behavior (job object, watchdog, stop
 * file) is covered by background-shell-windows.test.ts on Windows CI.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createBackgroundJobOwnership,
  ownershipVerdict,
  readOwnershipRecord,
  requestWindowsOwnershipStop,
} from "../src/background-shell/ownership";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pid that is (for all practical purposes) dead right now. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},20)"], { stdio: "ignore" });
  assert.ok(child.pid);
  await once(child, "close");
  return child.pid;
}

test("ownership identity is unique per job and paths never collide", () => {
  const a = createBackgroundJobOwnership();
  const b = createBackgroundJobOwnership();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.markerPath, b.markerPath);
  assert.notEqual(a.stopPath, b.stopPath);
  assert.ok(a.markerPath.length > 0 && a.stopPath.length > 0);
});

test("ownership record parsing accepts only well-formed records", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-owner-rec-"));
  try {
    const p = join(dir, "rec.job");
    assert.equal(readOwnershipRecord(p), undefined, "missing file is absent evidence");
    writeFileSync(p, "1234 running\n");
    assert.deepEqual(readOwnershipRecord(p), { pid: 1234, state: "running" });
    writeFileSync(p, "0 failed");
    assert.deepEqual(readOwnershipRecord(p), { pid: 0, state: "failed" });
    for (const garbage of ["", "   ", "running", "abc running\n", "-5 running\n", "12 released-ish\n"]) {
      writeFileSync(p, garbage);
      assert.equal(readOwnershipRecord(p), undefined, `malformed record is absent evidence: ${JSON.stringify(garbage)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verdict: a live root always reports running, even with no record yet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-owner-v1-"));
  try {
    const marker = join(dir, "v.job");
    assert.equal(ownershipVerdict(marker, true, isAlive), "running", "startup window before the first record");
    writeFileSync(marker, "999 running\n");
    assert.equal(ownershipVerdict(marker, true, isAlive), "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verdict: after root exit, only verified completion clears the job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-owner-v2-"));
  try {
    const marker = join(dir, "v.job");
    const dead = await deadPid();
    // Missing or unreadable evidence after root exit is UNVERIFIABLE — it must
    // keep readiness blocked, never look like completion.
    assert.equal(ownershipVerdict(marker, false, isAlive), "unverifiable", "missing record");
    writeFileSync(marker, "nonsense\n");
    assert.equal(ownershipVerdict(marker, false, isAlive), "unverifiable", "malformed record");
    // A running record naming a LIVE watchdog keeps the job running...
    writeFileSync(marker, `${process.pid} running\n`);
    assert.equal(ownershipVerdict(marker, false, isAlive), "running", "live watchdog holds the job");
    // ...and a dead watchdog pid verifies it clear: KILL_ON_JOB_CLOSE made the
    // kernel kill every member when the sole handle closed.
    writeFileSync(marker, `${dead} running\n`);
    assert.equal(ownershipVerdict(marker, false, isAlive), "clear", "dead watchdog = verified completion");
    // Explicit terminal states are verified completion too.
    for (const state of ["released", "terminated", "failed"] as const) {
      writeFileSync(marker, `0 ${state}\n`);
      assert.equal(ownershipVerdict(marker, false, isAlive), "clear", `terminal state ${state}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop requests follow the contract", () => {
  const ownership = createBackgroundJobOwnership();
  requestWindowsOwnershipStop(ownership);
  assert.ok(require("node:fs").existsSync(ownership.stopPath), "stop file written");
  requestWindowsOwnershipStop(undefined); // no-op, must not throw
});

test("structured ShellStart details carry the ownership marker into tracking", () => {
  const readiness = new BackgroundProcessReadiness();
  const tracked = readiness.observeToolResult("ShellStart", {
    content: [{ type: "text", text: "Started \"win-job\" as job9 (pid 4242); currently running." }],
    details: {
      kind: "pi-review-bg-shell",
      event: "started",
      id: "job9",
      label: "win-job",
      pid: 4242,
      ownershipMarker: "C:\\Users\\ci\\AppData\\Local\\Temp\\pi-review-bg-abc123.job",
    },
  });
  assert.deepEqual(tracked, {
    id: "job9",
    label: "win-job",
    pid: 4242,
    processGroupId: 4242,
    ownershipMarker: "C:\\Users\\ci\\AppData\\Local\\Temp\\pi-review-bg-abc123.job",
  });
});
