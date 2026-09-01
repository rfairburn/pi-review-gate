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
