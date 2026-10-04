import assert from "node:assert/strict";
import test from "node:test";
import { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processFailureResult, processTelemetry, runPromptProcess, terminateProcessTree } from "../src/adapters/process";

test("review process telemetry records stream, tool-result, and compaction volume without imposing a budget", async () => {
  const script = [
    "const events=[",
    "{type:'message',message:{role:'assistant',content:[{type:'toolCall',name:'read'}]}},",
    "{type:'message',message:{role:'toolResult',content:[{type:'text',text:'file contents'}]}},",
    "{type:'compaction_start',reason:'manual'},",
    "{type:'message',message:{role:'assistant',content:[{type:'text',text:'done'}]}}",
    "];",
    "for(const event of events)process.stdout.write(JSON.stringify(event)+'\\n');",
  ].join("");
  const output = await runPromptProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    prompt: "review",
    timeoutMs: 15000,
  });
  const telemetry = processTelemetry(output);

  assert.equal(output.code, 0);
  assert.equal(telemetry.streamEvents, 4);
  assert.equal(telemetry.toolCalls, 1);
  assert.ok((telemetry.toolResultBytes ?? 0) > 0);
  assert.equal(telemetry.compactions, 1);
  assert.equal(telemetry.stdoutBytes, Buffer.byteLength(output.stdout));
  assert.equal(telemetry.stdoutTruncated, false);
});

test("review process telemetry counts repeated lifecycle representations as one tool call", async () => {
  const call = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } };
  const events = [
    { type: "message_start", message: { role: "assistant", content: [call] } },
    { type: "message_end", message: { role: "assistant", content: [call] } },
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "read" },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "read" },
    { type: "message", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "payload" }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "payload" }] } },
  ];
  const script = `for(const event of ${JSON.stringify(events)})process.stdout.write(JSON.stringify(event)+'\\n')`;
  const output = await runPromptProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    prompt: "review",
    timeoutMs: 15000,
  });

  assert.equal(output.code, 0);
  assert.equal(processTelemetry(output).toolCalls, 1);
  const oneResult = events[4]?.message;
  assert.equal(processTelemetry(output).toolResultBytes, Buffer.byteLength(JSON.stringify(oneResult)));
});

test("runPromptProcess reports early stdin closure instead of crashing the host", async () => {
  const output = await runPromptProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.destroy();process.exitCode=7"],
    cwd: process.cwd(),
    prompt: "x".repeat(2_000_000),
    timeoutMs: 15_000,
  });

  assert.equal(output.aborted, false);
  assert.equal(output.timedOut, false);
  assert.ok(output.code !== 0 || output.stdinError);
});

test("runPromptProcess remains abortable while a large prompt is being written", async () => {
  const controller = new AbortController();
  const running = runPromptProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.pause();setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    prompt: "x".repeat(8 * 1024 * 1024),
    timeoutMs: 15_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);
  const output = await running;
  assert.equal(output.aborted, true);
  assert.equal(output.timedOut, false);
});

test("POSIX kill exceptions are contained through SIGKILL escalation without releasing live-child ownership", { skip: process.platform === "win32" }, async () => {
  const childKillDescriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, "kill");
  const processKillDescriptor = Object.getOwnPropertyDescriptor(process, "kill");
  assert.ok(childKillDescriptor?.value);
  assert.ok(processKillDescriptor?.value);
  const originalChildKill = childKillDescriptor.value as typeof ChildProcess.prototype.kill;
  const originalProcessKill = processKillDescriptor.value as typeof process.kill;
  const killAttempts: Array<NodeJS.Signals | number | undefined> = [];
  let childPid: number | undefined;
  let processExited = false;
  let announceEscalation!: () => void;
  const escalationAttempted = new Promise<void>((resolve) => { announceEscalation = resolve; });
  const awaitBounded = async (promise: Promise<void>, label: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 15_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const started = (() => {
    let announce!: () => void;
    const promise = new Promise<void>((resolve) => { announce = resolve; });
    return { promise, announce };
  })();
  const einval = (): NodeJS.ErrnoException => Object.assign(new Error("kill EINVAL"), { code: "EINVAL" });
  const recordFailure = (signal: NodeJS.Signals | number | undefined): never => {
    killAttempts.push(signal);
    if (signal === "SIGKILL") announceEscalation();
    throw einval();
  };
  const patchedChildKill = function (this: ChildProcess, signal?: NodeJS.Signals | number): boolean {
    if (this.pid === childPid) return recordFailure(signal);
    return Reflect.apply(originalChildKill, this, [signal]) as boolean;
  };
  const patchedProcessKill = (pid: number | string, signal?: NodeJS.Signals | number): boolean => {
    if (typeof pid === "number" && childPid !== undefined && pid === -childPid) return recordFailure(signal);
    return Reflect.apply(originalProcessKill, process, [pid, signal]) as boolean;
  };
  Object.defineProperty(ChildProcess.prototype, "kill", { ...childKillDescriptor, value: patchedChildKill });
  Object.defineProperty(process, "kill", { ...processKillDescriptor, value: patchedProcessKill });

  const controller = new AbortController();
  let running: Promise<Awaited<ReturnType<typeof runPromptProcess>>> | undefined;
  try {
    running = runPromptProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      prompt: "keep child alive",
      timeoutMs: 10_000,
      terminationEscalationMs: 25,
      signal: controller.signal,
      onProcessStart: ({ pid }) => {
        childPid = pid;
        started.announce();
      },
      onProcessExit: () => { processExited = true; },
    });
    void running.catch(() => undefined);
    await awaitBounded(started.promise, "child startup");
    controller.abort();
    await awaitBounded(escalationAttempted, "SIGKILL escalation");

    assert.ok(killAttempts.includes("SIGTERM"));
    assert.ok(killAttempts.includes("SIGKILL"));
    assert.equal(processExited, false, "kill failures must not report process exit while the child is still running");
  } finally {
    Object.defineProperty(ChildProcess.prototype, "kill", childKillDescriptor);
    Object.defineProperty(process, "kill", processKillDescriptor);
    if (childPid !== undefined) {
      try { Reflect.apply(originalProcessKill, process, [childPid, "SIGKILL"]); } catch { /* Child already closed. */ }
    }
    if (running) await awaitBounded(running.then(() => undefined, () => undefined), "child cleanup");
  }

  assert.ok(running);
  const output = await running;
  assert.equal(output.aborted, true);
  assert.equal(output.timedOut, false);
  assert.match(output.terminationError ?? "", /SIGTERM termination failed .*EINVAL/);
  assert.match(output.terminationError ?? "", /SIGKILL termination failed .*EINVAL/);
  assert.equal(processExited, true, "ownership exit is reported only after the child closes");
  const failure = processFailureResult({
    reviewerId: "test",
    output,
    rawOutputPath: "raw-output.txt",
    timeoutMs: 10_000,
  });
  assert.equal(failure?.error, "aborted", "termination diagnostics must not change abort classification");
  assert.match(failure?.diagnostic ?? "", /SIGKILL termination failed/);
});

test("termination skips an already-exited child without surfacing a spurious kill failure", () => {
  let killCalls = 0;
  const exitedChild = {
    pid: undefined,
    exitCode: 0,
    signalCode: null,
    kill: () => {
      killCalls += 1;
      throw Object.assign(new Error("kill EINVAL"), { code: "EINVAL" });
    },
  } as unknown as ChildProcess;

  assert.equal(terminateProcessTree(exitedChild, "SIGTERM"), undefined);
  assert.equal(killCalls, 0);
});

test("POSIX termination still signals an exited leader's live process group", { skip: process.platform === "win32" }, () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
  assert.ok(descriptor?.value);
  let signaledGroup = false;
  const child = {
    pid: 43210,
    exitCode: 0,
    signalCode: null,
    kill: () => assert.fail("an exited leader must not be signaled directly"),
  } as unknown as ChildProcess;
  Object.defineProperty(process, "kill", {
    ...descriptor,
    value: (pid: number, signal: NodeJS.Signals) => {
      assert.equal(pid, -43210);
      assert.equal(signal, "SIGTERM");
      signaledGroup = true;
      return true;
    },
  });
  try {
    assert.equal(terminateProcessTree(child, "SIGTERM"), undefined);
    assert.equal(signaledGroup, true);
  } finally {
    Object.defineProperty(process, "kill", descriptor);
  }
});

test("POSIX direct-child fallback reports failed group signaling", { skip: process.platform === "win32" }, () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
  assert.ok(descriptor?.value);
  let childKillCalls = 0;
  const child = {
    pid: 43211,
    exitCode: null,
    signalCode: null,
    kill: () => { childKillCalls++; return true; },
  } as unknown as ChildProcess;
  Object.defineProperty(process, "kill", {
    ...descriptor,
    value: (pid: number) => {
      assert.equal(pid, -43211);
      throw Object.assign(new Error("group signal denied"), { code: "EPERM" });
    },
  });
  try {
    const diagnostic = terminateProcessTree(child, "SIGTERM");
    assert.match(diagnostic ?? "", /process-group attempt also failed.*EPERM/);
    assert.equal(childKillCalls, 1);
  } finally {
    Object.defineProperty(process, "kill", descriptor);
  }
});

test("POSIX abort escalates after the leader exits while a descendant holds stdio open", { skip: process.platform === "win32" }, async () => {
  const controller = new AbortController();
  let groupId: number | undefined;
  let stdout = "";
  let ready!: () => void;
  const descendantReady = new Promise<void>((resolve) => { ready = resolve; });
  const parentScript = [
    "const {spawn}=require('node:child_process');",
    "spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});console.log(\"descendant-ready\");setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});",
    "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);",
  ].join("");
  const running = runPromptProcess({
    command: process.execPath,
    args: ["-e", parentScript],
    cwd: process.cwd(),
    prompt: "abort tree",
    timeoutMs: 10_000,
    terminationEscalationMs: 50,
    signal: controller.signal,
    onProcessStart: ({ pid }) => { groupId = pid; },
    onStdoutChunk: (chunk) => {
      stdout += chunk;
      if (stdout.includes("descendant-ready")) ready();
    },
  });
  void running.catch(() => undefined);
  const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let closed = false;
  try {
    await bounded(descendantReady, "descendant startup");
    controller.abort();
    const result = await bounded(running, "process group close after escalation");
    closed = true;
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
  } finally {
    if (!closed && groupId !== undefined) {
      try { process.kill(-groupId, "SIGKILL"); } catch { /* The group may already have closed. */ }
    }
    await bounded(running.then(() => undefined, () => undefined), "test child cleanup");
  }
});

test("runPromptProcess keeps timeout distinct from abort when the child closes after SIGTERM", async () => {
  const output = await runPromptProcess({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    prompt: "wait for timeout",
    timeoutMs: 25,
  });

  assert.equal(output.timedOut, true);
  assert.equal(output.aborted, false);
});

test("runPromptProcess durably announces ownership before sending the prompt and reports exit", async () => {
  const events: string[] = [];
  let releaseStart!: () => void;
  let announceStart!: () => void;
  const startAnnounced = new Promise<void>((resolve) => { announceStart = resolve; });
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let completed = false;
  const running = runPromptProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('done'))"],
    cwd: process.cwd(),
    prompt: "begin",
    timeoutMs: 15_000,
    onProcessStart: async ({ pid, processGroupId }) => {
      assert.ok(pid > 0);
      if (process.platform !== "win32") assert.equal(processGroupId, pid);
      events.push("start-begin");
      announceStart();
      await startGate;
      events.push("start-durable");
    },
    onProcessExit: ({ code }) => {
      events.push(`exit-${code}`);
    },
  }).then((result) => {
    completed = true;
    return result;
  });

  await startAnnounced;
  assert.equal(completed, false, "the child must not receive its prompt before ownership is durable");
  releaseStart();
  const output = await running;
  assert.equal(output.stdout, "done");
  assert.deepEqual(events, ["start-begin", "start-durable", "exit-0"]);
});

test("an ownership-publication failure quiesces the child and records exit before rejecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-process-owner-failure-"));
  const marker = join(root, "prompt-received");
  const events: string[] = [];
  try {
    await assert.rejects(
      runPromptProcess({
        command: process.execPath,
        args: ["-e", [
          "const fs=require('node:fs');",
          "process.stdin.resume();",
          `process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(marker)},'yes'));`,
          "setInterval(()=>{},1000);",
        ].join("")],
        cwd: root,
        prompt: "must not be delivered",
        timeoutMs: 15_000,
        onProcessStart: async () => {
          events.push("start");
          throw new Error("ownership publication failed");
        },
        onProcessExit: () => { events.push("exit"); },
      }),
      /ownership publication failed/,
    );
    assert.deepEqual(events, ["start", "exit"]);
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPromptProcess bounds a never-settling start callback without prompting or inventing exit persistence", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-process-owner-pending-"));
  const exitPath = join(root, "actual-exit-code");
  const promptPath = join(root, "prompt-received");
  const readyPath = join(root, "child-ready");
  const script = [
    "const fs=require('node:fs');const [exitPath,promptPath,readyPath]=process.argv.slice(1);",
    "process.on('SIGTERM',()=>{fs.writeFileSync(exitPath,'23');process.exit(23)});",
    "process.stdin.on('data',()=>fs.writeFileSync(promptPath,'yes'));process.stdin.resume();fs.writeFileSync(readyPath,'ready');setInterval(()=>{},1000);",
  ].join("");
  let exitCallbackCalled = false;
  const startedAt = Date.now();
  try {
    let guardTimer: NodeJS.Timeout | undefined;
    const running = runPromptProcess({
      command: process.execPath,
      args: ["-e", script, exitPath, promptPath, readyPath],
      cwd: root,
      prompt: "must not be delivered",
      timeoutMs: 2_000,
      terminationEscalationMs: 25,
      onProcessStart: async () => {
        const readyDeadline = Date.now() + 1_500;
        while (!existsSync(readyPath)) {
          if (Date.now() >= readyDeadline) throw new Error("owned process fixture did not become ready");
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        await new Promise<void>(() => {});
      },
      onProcessExit: () => { exitCallbackCalled = true; },
    });
    await assert.rejects(Promise.race([
      running,
      new Promise<never>((_, rejectPromise) => {
        guardTimer = setTimeout(() => rejectPromise(new Error("runPromptProcess exceeded the bounded lifecycle test guard")), 9_000);
      }),
    ]), /lifecycle callbacks did not settle.*persistence is unconfirmed/s);
    if (guardTimer) clearTimeout(guardTimer);
    assert.ok(Date.now() - startedAt < 9_000, "the never-settling callback must not defeat the process and lifecycle bounds");
    assert.equal(await readFile(exitPath, "utf8"), "23", "the child itself records the status observed before bounded return");
    assert.equal(exitCallbackCalled, false, "exit persistence must not run before the pending start callback settles");
    await assert.rejects(access(promptPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPromptProcess does not signal a naturally closed child when late startup persistence crosses the deadline", { skip: process.platform === "win32" }, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-process-late-start-close-"));
  const exitMarker = join(fixtureRoot, "closed");
  const processKillDescriptor = Object.getOwnPropertyDescriptor(process, "kill");
  const childKillDescriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, "kill");
  assert.ok(processKillDescriptor?.value);
  assert.ok(childKillDescriptor?.value);
  const originalProcessKill = processKillDescriptor.value as typeof process.kill;
  const originalChildKill = childKillDescriptor.value as typeof ChildProcess.prototype.kill;
  const terminationAttempts: Array<NodeJS.Signals | number | undefined> = [];
  let rootPid: number | undefined;
  const processKill = (pid: number | string, signal?: NodeJS.Signals | number): boolean => {
    if (typeof pid === "number" && rootPid !== undefined && pid === -rootPid) terminationAttempts.push(signal);
    return Reflect.apply(originalProcessKill, process, [pid, signal]) as boolean;
  };
  const childKill = function (this: ChildProcess, signal?: NodeJS.Signals | number): boolean {
    if (this.pid === rootPid) terminationAttempts.push(signal);
    return Reflect.apply(originalChildKill, this, [signal]) as boolean;
  };
  Object.defineProperty(process, "kill", { ...processKillDescriptor, value: processKill });
  Object.defineProperty(ChildProcess.prototype, "kill", { ...childKillDescriptor, value: childKill });

  let announceStart!: () => void;
  let releaseStart!: () => void;
  const startEntered = new Promise<void>((resolvePromise) => { announceStart = resolvePromise; });
  const startGate = new Promise<void>((resolvePromise) => { releaseStart = resolvePromise; });
  let observedExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let running: ReturnType<typeof runPromptProcess> | undefined;
  const startedAt = Date.now();
  try {
    running = runPromptProcess({
      command: process.execPath,
      args: ["-e", `const fs=require('node:fs');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(exitMarker)},'closed');process.exit(0)},25)`],
      cwd: process.cwd(),
      prompt: "must not be delivered after the natural root exit",
      timeoutMs: 100,
      onProcessStart: ({ pid }) => {
        rootPid = pid;
        announceStart();
        return startGate;
      },
      onProcessExit: ({ code, signal }) => { observedExit = { code, signal }; },
    });
    void running.catch(() => undefined);
    let startupGuard: NodeJS.Timeout | undefined;
    await Promise.race([
      startEntered,
      new Promise<never>((_, rejectPromise) => {
        startupGuard = setTimeout(() => rejectPromise(new Error("natural-exit fixture did not enter lifecycle startup")), 2_000);
      }),
    ]).finally(() => { if (startupGuard) clearTimeout(startupGuard); });
    const markerDeadline = Date.now() + 2_000;
    for (;;) {
      try {
        await access(exitMarker);
        break;
      } catch {
        if (Date.now() >= markerDeadline) assert.fail("the owned child did not record its natural exit");
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
    const processExitDeadline = Date.now() + 2_000;
    for (;;) {
      try {
        process.kill(rootPid!, 0);
        if (Date.now() >= processExitDeadline) assert.fail("the owned child did not close after its exit marker");
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        break;
      }
    }
    const untilPastDeadline = startedAt + 150 - Date.now();
    if (untilPastDeadline > 0) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, untilPastDeadline));
    assert.ok(Date.now() - startedAt > 100, "startup persistence resolves after the model deadline");
    releaseStart();
    let guardTimer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      running,
      new Promise<never>((_, rejectPromise) => {
        guardTimer = setTimeout(() => rejectPromise(new Error("closed child lifecycle did not settle after start persistence")), 2_000);
      }),
    ]).finally(() => { if (guardTimer) clearTimeout(guardTimer); });
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.deepEqual(observedExit, { code: 0, signal: null });
    assert.deepEqual(terminationAttempts, [], "a settled lifecycle must not signal a possibly recycled process-group id");
  } finally {
    releaseStart();
    await running?.catch(() => undefined);
    Object.defineProperty(process, "kill", processKillDescriptor);
    Object.defineProperty(ChildProcess.prototype, "kill", childKillDescriptor);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("runPromptProcess preserves an argumentless startup rejection after a zero-exit close", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-process-falsy-start-rejection-"));
  const exitMarker = join(root, "closed");
  const promptMarker = join(root, "prompt-received");
  const script = [
    "const fs=require('node:fs');const [exitMarker,promptMarker]=process.argv.slice(1);",
    "process.stdin.on('data',()=>fs.writeFileSync(promptMarker,'received'));process.stdin.resume();",
    "setTimeout(()=>{fs.writeFileSync(exitMarker,'closed');process.exit(0)},25);",
  ].join("");
  let observedExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  try {
    const running = runPromptProcess({
      command: process.execPath,
      args: ["-e", script, exitMarker, promptMarker],
      cwd: root,
      prompt: "must not be delivered after failed startup persistence",
      timeoutMs: 3_000,
      onProcessStart: async ({ pid }) => {
        const markerDeadline = Date.now() + 2_000;
        while (!existsSync(exitMarker)) {
          if (Date.now() >= markerDeadline) throw new Error("zero-exit startup fixture did not reach its close marker");
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        for (;;) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            break;
          }
          if (Date.now() >= markerDeadline) throw new Error("zero-exit startup fixture remained alive after its marker");
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
        return Promise.reject();
      },
      onProcessExit: ({ code, signal }) => { observedExit = { code, signal }; },
    });

    await assert.rejects(running, /Process lifecycle start callback failed: undefined/);
    assert.deepEqual(observedExit, { code: 0, signal: null }, "the rejection must not erase the child's real zero exit");
    await assert.rejects(access(promptMarker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPromptProcess does not prompt after abort while async start persistence is pending", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-process-owner-abort-"));
  const exitPath = join(root, "actual-exit-code");
  const promptPath = join(root, "prompt-received");
  const readyPath = join(root, "child-ready");
  const controller = new AbortController();
  const script = [
    "const fs=require('node:fs');const [exitPath,promptPath,readyPath]=process.argv.slice(1);",
    "process.on('SIGTERM',()=>{fs.writeFileSync(exitPath,'23');process.exit(23)});",
    "process.stdin.on('data',()=>fs.writeFileSync(promptPath,'yes'));process.stdin.resume();fs.writeFileSync(readyPath,'ready');setInterval(()=>{},1000);",
  ].join("");
  let announceStart!: () => void;
  let releaseStart!: () => void;
  const startEntered = new Promise<void>((resolvePromise) => { announceStart = resolvePromise; });
  const startGate = new Promise<void>((resolvePromise) => { releaseStart = resolvePromise; });
  const events: string[] = [];
  const startedAt = Date.now();
  let running: ReturnType<typeof runPromptProcess> | undefined;
  try {
    running = runPromptProcess({
      command: process.execPath,
      args: ["-e", script, exitPath, promptPath, readyPath],
      cwd: root,
      prompt: "must not be delivered after abort",
      timeoutMs: 10_000,
      signal: controller.signal,
      onProcessStart: async () => {
        const readyDeadline = Date.now() + 5_000;
        while (!existsSync(readyPath)) {
          if (Date.now() >= readyDeadline) throw new Error("owned process fixture did not become ready");
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        events.push("start-entered");
        announceStart();
        await startGate;
        events.push("start-persisted");
      },
      onProcessExit: ({ code, signal }) => { events.push(`exit-${code}-${signal}`); },
    });
    let startupGuard: NodeJS.Timeout | undefined;
    await Promise.race([
      startEntered,
      new Promise<never>((_, rejectPromise) => {
        startupGuard = setTimeout(() => rejectPromise(new Error("owned process fixture did not reach lifecycle startup")), 6_000);
      }),
    ]).finally(() => { if (startupGuard) clearTimeout(startupGuard); });
    controller.abort();
    const exitDeadline = Date.now() + 5_000;
    for (;;) {
      try {
        await access(exitPath);
        break;
      } catch {
        if (Date.now() >= exitDeadline) assert.fail("the aborted child did not handle termination");
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
    releaseStart();
    const output = await running;
    assert.ok(Date.now() - startedAt < 5_000, "abort during ownership persistence must terminate and close finitely");
    assert.equal(output.aborted, true);
    assert.equal(output.code, 23);
    assert.deepEqual(events, ["start-entered", "start-persisted", "exit-23-null"]);
    assert.equal(await readFile(exitPath, "utf8"), "23");
    await assert.rejects(access(promptPath), { code: "ENOENT" });
  } finally {
    controller.abort();
    releaseStart();
    await running?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("runPromptProcess immediately terminates an already-aborted startup without prompting", { skip: process.platform === "win32" }, async () => {
  const controller = new AbortController();
  controller.abort();
  let startCallbackCalled = false;
  let exitCallbackCalled = false;
  let promptDelivered = false;
  const result = await runPromptProcess({
    command: "must-not-spawn",
    args: [],
    cwd: process.cwd(),
    prompt: "must not be delivered",
    timeoutMs: 10_000,
    signal: controller.signal,
    onProcessStart: () => { startCallbackCalled = true; },
    onProcessExit: () => { exitCallbackCalled = true; },
    onPromptDelivery: () => { promptDelivered = true; },
  });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(startCallbackCalled, false, "a pre-aborted request does not spawn or persist a root");
  assert.equal(exitCallbackCalled, false, "no exit callback runs when no child was spawned");
  assert.equal(promptDelivered, false);
});

test("runPromptProcess reports a never-settling exit callback instead of successful completion", async () => {
  let actualExit: number | null | undefined;
  const startedAt = Date.now();
  let guardTimer: NodeJS.Timeout | undefined;
  const running = runPromptProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],
    cwd: process.cwd(),
    prompt: "complete",
    timeoutMs: 10_000,
    onProcessExit: async ({ code }) => {
      actualExit = code;
      await new Promise<void>(() => {});
    },
  });
  await assert.rejects(Promise.race([
    running,
    new Promise<never>((_, rejectPromise) => {
      guardTimer = setTimeout(() => rejectPromise(new Error("runPromptProcess exceeded the bounded exit-callback test guard")), 9_000);
    }),
  ]), /lifecycle callbacks did not settle.*persistence is unconfirmed/s).finally(() => {
    if (guardTimer) clearTimeout(guardTimer);
  });
  assert.ok(Date.now() - startedAt < 9_000, "the exit callback wait must use the bounded terminal grace");
  assert.equal(actualExit, 0, "the callback receives the observed root status before its persistence stalls");
});
