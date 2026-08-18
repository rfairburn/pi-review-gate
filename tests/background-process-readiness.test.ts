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
