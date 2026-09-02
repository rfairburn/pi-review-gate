/*
 * Test cases derived from Little Coder's bg-shell extension.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */
import { afterEach, describe, it } from "node:test";
import { expect } from "./helpers/expect";
import { execFileSync } from "node:child_process";
import registerBackgroundShell, { reapAll } from "../src/background-shell";
import { BackgroundProcessReadiness } from "../src/background-process-readiness";

// Drives the real extension against real processes. The pure-logic tests in
// jobs.test.ts cover the wake rules; everything that can only break against an
// actual OS — stream framing, exit plumbing, and killing a process TREE rather
// than just the shell we spawned — is covered here.

interface Sent {
  content: string;
  delivery: any;
}

function wire() {
  const sent: Sent[] = [];
  const tools: Record<string, any> = {};
  const handlers: Record<string, any> = {};
  const pi: any = {
    registerTool: (t: any) => { tools[t.name] = t; },
    on: (n: string, h: any) => { handlers[n] = h; },
    sendMessage: (msg: any, delivery: any) => { sent.push({ content: msg.content, delivery }); },
  };
  const controller = registerBackgroundShell(pi);
  const ctx = { hasUI: false, ui: {} };
  const call = (name: string, params: any) =>
    tools[name].execute("id", params, undefined, undefined, ctx);
  return { sent, tools, handlers, call, controller };
}

const textOf = (r: any) => r.content[0].text as string;

/** Poll until `fn()` is true or the deadline passes. `fn` may be async — the
 *  tools all return promises, and treating one as a value silently reads
 *  `undefined.content`. */
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    return await fn();
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  reapAll();
});

describe("bg-shell against real processes", () => {
  const T = 20_000;
  it("starts a job, buffers its output, and wakes on clean exit", async () => {
    const { sent, call } = wire();
    const readiness = new BackgroundProcessReadiness();
    const result = await call("ShellStart", {
      command: "echo first; echo second; sleep 0.5; exit 0",
      label: "quick",
    });
    const started = textOf(result);
    expect(started).toContain("Started \"quick\"");
    expect(started).toContain("currently running");
    expect(started).toContain("Future wake triggers (not current events): exit.");
    // The description promises the model it does not need to poll; the start
    // message must say so too or the model will poll anyway.
    expect(started).toContain("do not poll");
    readiness.observeToolResult("ShellStart", result);
    expect(readiness.snapshot().running.length).toBe(1);

    expect(await until(() => sent.length > 0)).toBe(true);
    const wake = sent[0];
    expect(wake.content).toContain("exited 0");
    expect(wake.content).toContain("second");
    // A clean exit is worth delivering, not worth interrupting a tool call for.
    expect(wake.delivery).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(await until(() => readiness.snapshot().running.length === 0, T)).toBe(true);
  });

  it("publishes authoritative typed lifecycle revisions", async () => {
    const { call, controller } = wire();
    const events: Array<{
      type: string;
      revision: number;
      running: string[];
      exitWakeScheduled: boolean;
    }> = [];
    const unsubscribe = controller.subscribe((event) => {
      events.push({
        type: event.type,
        revision: event.revision,
        running: event.running.map((job) => job.id),
        exitWakeScheduled: event.exitWakeScheduled,
      });
    });
    try {
      const started = await call("ShellStart", {
        command: "sleep 0.25",
        label: "lifecycle",
      });
      const id = textOf(started).match(/as (job\d+)/)![1];
      expect(controller.snapshot().running.map((job) => job.id)).toEqual([id]);
      expect(await until(() => controller.snapshot().running.length === 0)).toBe(true);

      expect(events.map((event) => event.type)).toEqual(["started", "settled"]);
      expect(events[0].running).toEqual([id]);
      expect(events[0].exitWakeScheduled).toBe(false);
      expect(events[1].running).toEqual([]);
      expect(events[1].exitWakeScheduled).toBe(true);
      expect(events[1].revision).toBe(events[0].revision + 1);
    } finally {
      unsubscribe();
    }
  });

  it("reports an idle transition without an exit wake when exit notification is disabled", async () => {
    const { call, controller, sent } = wire();
    const events: Array<{ type: string; running: number; exitWakeScheduled: boolean }> = [];
    const unsubscribe = controller.subscribe((event) => {
      events.push({
        type: event.type,
        running: event.running.length,
        exitWakeScheduled: event.exitWakeScheduled,
      });
    });
    try {
      await call("ShellStart", {
        command: "sleep 0.2",
        label: "silent-lifecycle",
        wake_on: { exit: false },
      });
      expect(await until(() => controller.snapshot().running.length === 0)).toBe(true);
      expect(sent).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "settled", running: 0, exitWakeScheduled: false });
    } finally {
      unsubscribe();
    }
  });

  it("gives a crash the urgent lane", async () => {
    const { sent, call } = wire();
    await call("ShellStart", { command: "echo boom >&2; exit 3", label: "crash" });
    expect(await until(() => sent.length > 0)).toBe(true);
    expect(sent[0].content).toContain("exited 3");
    expect(sent[0].delivery).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("stays silent for a job whose rules match nothing", async () => {
    const { sent, call } = wire();
    await call("ShellStart", {
      command: "echo tick; echo tock; sleep 0.2",
      label: "quiet",
      wake_on: { exit: false, match: ["Traceback"] },
    });
    await new Promise((r) => setTimeout(r, 900));
    // The core promise: routine output costs zero turns.
    expect(sent).toEqual([]);
  });

  it("wakes on a matched pattern while the job is still running", async () => {
    const { sent, call } = wire();
    await call("ShellStart", {
      command: "echo warming; echo 'Traceback (most recent call last)'; sleep 2",
      label: "trainer",
      wake_on: { exit: false, match: ["Traceback"] },
    });
    expect(await until(() => sent.length > 0)).toBe(true);
    expect(sent[0].content).toContain("matched");
    expect(sent[0].content).toContain("still running");
    expect(sent[0].delivery.deliverAs).toBe("steer"); // Traceback is error-ish
  });

  it("reads back a slice of the log on demand", async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command: "for i in 1 2 3 4 5; do echo line$i; done; exit 0",
      label: "counter",
    })).match(/as (job\d+)/)![1];

    await new Promise((r) => setTimeout(r, 600));

    const log = textOf(await call("ShellLog", { id, lines: 3 }));
    expect(log).toContain("line5");
    expect(log).not.toContain("line1"); // tail of 3 only
  });

  it("writes to a running job's stdin", async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command: "read x; echo got:$x; exit 0",
      label: "reader",
    })).match(/as (job\d+)/)![1];

    await new Promise((r) => setTimeout(r, 300));
    await call("ShellSend", { id, text: "hello" });
    await new Promise((r) => setTimeout(r, 500));
    expect(textOf(await call("ShellLog", { id }))).toContain("got:hello");
  });

  // Finding 3: a child that exits mid-write must not take the host down. The
  // payload far exceeds the 64KB pipe buffer, so most of it is still queued in
  // Node when the child exits and closes the read end — the resulting EPIPE
  // arrives asynchronously on the stdin stream, where a plain try/catch around
  // write() can never see it. Without a listener the test process would die
  // with an uncaught exception; reaching the assertions below at all proves the
  // host survived.
  it("ShellSend returns a controlled error when the child exits mid-write", async () => {
    const { sent, call } = wire();
    const id = textOf(await call("ShellStart", {
      // Still alive when the 4MB write is issued (which happens synchronously
      // after spawn, before any event-loop turn observes the exit); exits well
      // before WRITE_FLUSH_TIMEOUT_MS, so the EPIPE path is deterministic.
      command: "sleep 0.2",
      label: "exit-mid-write",
    })).match(/as (job\d+)/)![1];

    // Sent immediately, while the child is still alive.
    const result = await call("ShellSend", { id, text: "x".repeat(4 * 1024 * 1024) });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("stdin");
    expect(text).toContain("ShellLog"); // actionable: where to look next

    // The failure is recorded as exactly ONE bounded buffer note, even though
    // both the write callback and the stream 'error' event fire.
    expect(await until(() => sent.length > 0)).toBe(true); // exit wake = child gone
    const log = textOf(await call("ShellLog", { id }));
    expect(log).toContain("[stdin error]");
    expect(log.split("[stdin error]").length - 1).toBe(1);

    // A follow-up send hits the recorded stdin failure (EPIPE), which wins
    // over the exit flag — the precheck's "no longer writable (EPIPE)" error is
    // the precise answer, and recordStdinFailure is idempotent, so the log
    // still shows exactly one note.
    const retry = await call("ShellSend", { id, text: "again" });
    expect(retry.isError).toBe(true);
    expect(textOf(retry)).toContain("no longer writable");
    const logAfterRetry = textOf(await call("ShellLog", { id }));
    expect(logAfterRetry.split("[stdin error]").length - 1).toBe(1);

    // The host is demonstrably still alive and answering.
    expect(pidAlive(process.pid)).toBe(true);
  });

  // The other half of the timeout contract: when the write callback has not
  // fired within WRITE_FLUSH_TIMEOUT_MS (child alive but not reading, payload
  // stuck in Node's queue behind the full pipe), ShellSend must NOT claim the
  // bytes were written — and the later EPIPE from the eventual exit must land
  // as exactly one bounded note via the stdin 'error' listener, with the host
  // intact.
  it("ShellSend reports delivery unconfirmed when the child outlives the flush timeout", async () => {
    const { sent, call } = wire();
    const id = textOf(await call("ShellStart", {
      command: "sleep 2", // outlives WRITE_FLUSH_TIMEOUT_MS, never reads stdin
      label: "flush-timeout",
    })).match(/as (job\d+)/)![1];

    const result = await call("ShellSend", { id, text: "x".repeat(4 * 1024 * 1024) });
    expect(result.isError).toBe(false); // not a failure — but not a success claim either
    const text = textOf(result);
    expect(text).toContain("NOT confirmed");
    expect(text).not.toContain("Wrote ");

    // The child eventually exits; the queued write fails with EPIPE and the
    // listener records it. Exactly one note, no uncaught exception.
    expect(await until(() => sent.length > 0, 8000)).toBe(true);
    const log = textOf(await call("ShellLog", { id }));
    expect(log).toContain("[stdin error]");
    expect(log.split("[stdin error]").length - 1).toBe(1);
    expect(pidAlive(process.pid)).toBe(true);
  });

  // An exited job's stdin is destroyed by Node itself; that must NOT be
  // reported as a stdin failure. The definitive answer is "already exited",
  // and the log must stay free of [stdin error] notes.
  it("ShellSend against a cleanly exited job says so without a stdin note", async () => {
    const { sent, call } = wire();
    const id = textOf(await call("ShellStart", { command: "exit 0", label: "done" })).match(/as (job\d+)/)![1];
    expect(await until(() => sent.length > 0)).toBe(true); // exit wake = child gone
    const result = await call("ShellSend", { id, text: "hello" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("has already exited");
    expect(textOf(await call("ShellLog", { id }))).not.toContain("[stdin error]");
  });

  // The one that matters most. `python train.py` runs as a GRANDCHILD under the
  // bash we spawn — killing only the shell would orphan the process actually
  // holding the GPU. Spawning detached and signalling the group is what makes
  // this pass.
  it("ShellStop kills the whole process tree, not just the shell", async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command: "sleep 300 & echo GRANDCHILD=$!; wait",
      label: "tree",
    })).match(/as (job\d+)/)![1];

    expect(await until(async () => textOf(await call("ShellLog", { id })).includes("GRANDCHILD="))).toBe(true);
    const grandchild = Number(
      textOf(await call("ShellLog", { id })).match(/GRANDCHILD=(\d+)/)![1],
    );
    expect(pidAlive(grandchild)).toBe(true);

    await call("ShellStop", { id });
    expect(await until(() => !pidAlive(grandchild), 8000)).toBe(true);
  });

  it("ShellStop accepts a unique label", async () => {
    const { call } = wire();
    const started = textOf(await call("ShellStart", { command: "sleep 300", label: "unique-stop" }));
    const id = started.match(/as (job\d+)/)![1];

    const stopped = await call("ShellStop", { id: "unique-stop" });
    expect(stopped.isError).toBe(false);
    expect(textOf(stopped)).toContain(`Stopping ${id}`);
  });

  it("ShellStop lists every matching job ID when a label is ambiguous", async () => {
    const { call } = wire();
    const first = textOf(await call("ShellStart", { command: "sleep 300", label: "duplicate-stop" })).match(/as (job\d+)/)![1];
    const second = textOf(await call("ShellStart", { command: "sleep 300", label: "duplicate-stop" })).match(/as (job\d+)/)![1];

    const ambiguous = await call("ShellStop", { id: "duplicate-stop" });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain("is ambiguous");
    expect(textOf(ambiguous)).toContain(first);
    expect(textOf(ambiguous)).toContain(second);
    expect(textOf(ambiguous)).toContain(`{"id":"${first}"}`);

    const retry = await call("ShellStop", { id: first });
    expect(retry.isError).toBe(false);
    expect(textOf(retry)).toContain(`Stopping ${first}`);
    await call("ShellStop", { id: second });
  });

  it("reapAll leaves nothing running", async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command: "sleep 300 & echo GRANDCHILD=$!; wait",
      label: "leak",
    })).match(/as (job\d+)/)![1];
    expect(await until(async () => textOf(await call("ShellLog", { id })).includes("GRANDCHILD="))).toBe(true);
    const grandchild = Number(
      textOf(await call("ShellLog", { id })).match(/GRANDCHILD=(\d+)/)![1],
    );

    reapAll();
    expect(await until(() => !pidAlive(grandchild), 8000)).toBe(true);
  });

  it("refuses to start more than the job cap", async () => {
    const { call } = wire();
    for (let i = 0; i < 8; i++) await call("ShellStart", { command: "sleep 30", label: `j${i}` });
    const over = await call("ShellStart", { command: "sleep 30", label: "over" });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain("max 8");
  });

  it("reports unknown job ids rather than throwing", async () => {
    const { call } = wire();
    for (const tool of ["ShellLog", "ShellSend", "ShellStop"]) {
      const r = await call(tool, { id: "nope", text: "x" });
      expect(r.isError, tool).toBe(true);
      expect(textOf(r)).toContain("no such job");
    }
  });
});

describe("the parent watchdog", () => {
  // The backstop for SIGKILL, which no signal handler can catch. A job must die
  // when pi-review-gate dies by ANY means, or a training run keeps 8GB of VRAM.
  // Simulated with a throwaway parent so the test can SIGKILL it safely.
  it("kills the job when its parent disappears without warning", async () => {
    const { wrapWithParentWatchdog } = await import("../src/background-shell/jobs");

    // A stand-in "pi-review-gate" that does nothing but stay alive.
    const parent = execFileSync("bash", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!"])
      .toString().trim();
    const parentPid = Number(parent);

    const script = wrapWithParentWatchdog("sleep 120 & echo CHILD=$!; wait", parentPid, 1);
    const { spawn } = await import("node:child_process");
    const proc = spawn(script, { shell: "/bin/bash", detached: true, stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    expect(await until(() => /CHILD=\d+/.test(out))).toBe(true);
    const child = Number(out.match(/CHILD=(\d+)/)![1]);
    expect(pidAlive(child)).toBe(true);

    // Hard-kill the parent: no handler runs, nothing gets a chance to clean up.
    process.kill(parentPid, "SIGKILL");

    // The watchdog polls at 1s here, so this resolves quickly.
    expect(await until(() => !pidAlive(child), 15_000)).toBe(true);

    try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already gone */ }
  });
});

describe("wake coalescing", () => {
  // A crash prints its traceback and dies milliseconds later. Waking once for
  // the matched line and again for the exit costs two turns to learn one thing,
  // which is the exact waste this feature exists to remove.
  it("sends one message when a matched line is immediately followed by exit", async () => {
    const { sent, call } = wire();
    await call("ShellStart", {
      command: "echo 'Traceback (most recent call last)'; exit 1",
      label: "crasher",
      wake_on: { match: ["Traceback"] },
    });
    await new Promise((r) => setTimeout(r, 3000));
    expect(sent.length).toBe(1);
    expect(sent[0].content).toContain("exited 1"); // the exit wake, not the match
    expect(sent[0].content).toContain("Traceback"); // still carries the excerpt
  });

  // But a match on a job that keeps running must still arrive.
  it("still delivers a match wake when the job stays alive", async () => {
    const { sent, call } = wire();
    await call("ShellStart", {
      command: "echo 'Traceback here'; sleep 5",
      label: "survivor",
      wake_on: { match: ["Traceback"] },
    });
    await new Promise((r) => setTimeout(r, 3000));
    expect(sent.length).toBe(1);
    expect(sent[0].content).toContain("matched");
    expect(sent[0].content).toContain("still running");
  });

  // The observed production ordering: several nonurgent matches while the
  // agent is busy, a failed exit in between, then stale "still running" match
  // messages delivered after the exit steer. Nonurgent wakes must now be held
  // internally and superseded by the exit.
  it("a failed exit supersedes nonurgent matches that fired while the agent was busy", async () => {
    const { sent, call, handlers } = wire();
    handlers.agent_start?.(); // the agent stays busy for the whole window
    await call("ShellStart", {
      command:
        "echo checkpoint one; sleep 1.7; echo checkpoint two; sleep 1.7; " +
        "echo checkpoint three; sleep 0.6; exit 7",
      label: "stale-matches",
      wake_on: { match: ["checkpoint"] },
    });
    // Each match survives its 1.5s exit-coalesce window while the agent is
    // busy, so each one lands in the internal hold instead of Pi's queue.
    expect(await until(() => sent.length === 1 && sent[0].content.includes("exited 7"), 8000)).toBe(true);
    expect(sent[0].delivery).toEqual({ deliverAs: "steer", triggerTurn: true });
    // Settlement must not resurrect the stale matches.
    handlers.agent_settled?.();
    expect(sent.length).toBe(1);
    for (const message of sent) {
      expect(message.content).not.toContain("still running");
    }
  });

  it("sends a clean exit before settlement so Pi can drain its continuation first", async () => {
    const { sent, call, handlers } = wire();
    handlers.agent_start?.();
    await call("ShellStart", {
      command: "echo complete; exit 0",
      label: "clean-exit-before-settlement",
    });

    expect(await until(() => sent.length === 1)).toBe(true);
    expect(sent[0].content).toContain("exited 0");
    expect(sent[0].delivery).toEqual({ deliverAs: "followUp", triggerTurn: true });

    // The exit was queued while Pi was still processing the active run. It is
    // not held until agent_settled, where triggerTurn would start a competing
    // turn alongside the gate's automatic review.
    handlers.agent_settled?.();
    expect(sent.length).toBe(1);
  });

  it("delivers exactly one coalesced match wake at settlement while the job stays alive", async () => {
    const { sent, call, handlers } = wire();
    handlers.agent_start?.();
    const started = await call("ShellStart", {
      command: "for i in 1 2 3 4; do echo \"checkpoint $i\"; sleep 0.7; done",
      label: "live-coalesce",
      wake_on: { exit: false, match: ["checkpoint"] },
    });
    const id = textOf(started).match(/as (job\d+)/)![1];
    // Wait until several matches have fired while the agent is busy; none may
    // reach Pi yet.
    expect(await until(async () => textOf(await call("ShellLog", { id })).includes("checkpoint 3"))).toBe(true);
    expect(sent).toEqual([]);
    handlers.agent_settled?.();
    expect(sent.length).toBe(1);
    expect(sent[0].content).toContain("matched");
    expect(sent[0].content).toContain("coalesced");
    // The wake is current, not a replay of the first held match: it carries
    // the newest matching line still in the buffer.
    expect(sent[0].content).toContain("checkpoint 3");
    expect(sent[0].content).toContain("still running");
    expect(sent[0].delivery).toEqual({ deliverAs: "followUp", triggerTurn: true });
    // The job keeps running after settlement; nothing stale or duplicated may
    // follow the single coalesced wake.
    await new Promise((r) => setTimeout(r, 1200));
    expect(sent.length).toBe(1);
    await call("ShellStop", { id: "live-coalesce" });
  });

  it("keeps errorish matches urgent and lets them supersede held routine wakes", async () => {
    const { sent, call, handlers } = wire();
    handlers.agent_start?.();
    await call("ShellStart", {
      command: "echo checkpoint; sleep 0.2; echo 'Traceback (most recent call last)'; sleep 1.5",
      label: "busy-errorish",
      wake_on: { exit: false, match: ["checkpoint", "Traceback"] },
    });
    expect(await until(() => sent.length > 0)).toBe(true);
    expect(sent[0].delivery).toEqual({ deliverAs: "steer", triggerTurn: true });
    handlers.agent_settled?.(); // the older routine wake must not follow it
    expect(sent.length).toBe(1);
  });
});

describe("ShellStop races", () => {
  it("ShellStop on an already-exited job is an idempotent no-op", async () => {
    const { sent, call } = wire();
    const started = textOf(await call("ShellStart", { command: "exit 0", label: "stop-after-exit" }));
    const id = started.match(/as (job\d+)/)![1];
    expect(await until(() => sent.length > 0)).toBe(true); // natural exit observed
    const first = await call("ShellStop", { id });
    expect(first.isError).toBe(false);
    expect(textOf(first)).toContain("had already exited");
    const second = await call("ShellStop", { id });
    expect(second.isError).toBe(false);
    expect(textOf(second)).toContain("had already exited");
  });
});
