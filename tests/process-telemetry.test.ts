import assert from "node:assert/strict";
import test from "node:test";
import { ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
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

test("termination kill exceptions are contained through SIGKILL escalation without releasing live-child ownership", async () => {
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
        onProcessStart: () => {
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
