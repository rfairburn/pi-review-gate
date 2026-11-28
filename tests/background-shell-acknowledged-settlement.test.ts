/*
 * Root-exit settlement on an explicit job-object acknowledgement (#800).
 *
 * DETERMINISTIC FIXTURES: a fake ChildProcess (an EventEmitter with fake stdio
 * streams) drives the real attachStreams handlers, and real record files in a
 * test-owned directory stand in for the watchdog's ownership record. Nothing
 * is spawned. The case under test is the one the audit identified: the root
 * has exited, but a process OUTSIDE the job (for example one a nested Store
 * app activation started) still holds the job's stdout/stderr pipe, so the
 * stream `close` never arrives. A verified acknowledgement must settle the job
 * (and free its MAX_JOBS slot) without waiting on that close; missing,
 * unreadable, still-`running`, or partial evidence must not be treated the
 * same — and on the Store/MSIX route a closed pipe without an acknowledgement
 * must not be treated as completion either, by the host or by readiness. A job
 * reaped by a session change keeps its acknowledgement watcher, releases its
 * ownership and pipe ends on verified settlement, and never wakes the
 * replacement session. The native Store PowerShell evidence lives in
 * background-shell-windows.test.ts.
 *
 * The settlement path is Windows-only in production (POSIX process groups
 * already cover descendants), so these cases skip elsewhere.
 */
import { afterEach, after, describe, it } from "node:test";
import { expect } from "./helpers/expect";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerBackgroundShell, { __test as backgroundShellTest, reapAll } from "../src/background-shell";
import { LineBuffer, PendingLineBuffer, compileMatchers } from "../src/background-shell/jobs";
import { ownershipAcknowledgement, ownershipVerdict } from "../src/background-shell/ownership";
import { BackgroundProcessReadiness } from "../src/background-process-readiness";

const SKIP = { skip: process.platform !== "win32" };

/** A pid no Windows host assigns in practice; never signalled here. */
const DEAD_WATCHDOG_PID = 2_147_483_000;

const recordDir = mkdtempSync(join(tmpdir(), "pi-review-bg-ack-"));
let recordSeq = 0;
after(() => rmSync(recordDir, { recursive: true, force: true }));
afterEach(() => {
  reapAll();
  // Production keeps acknowledgement watchers across reapAll until the job
  // settles; this file stops the ones its unsettled fixtures started.
  backgroundShellTest.clearAcknowledgementWatchesForTests();
});

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

/** A synthetic Store-route job registered exactly as ShellStart registers a
 *  spawned one (jobs map, ownership token, unsettled ledger, real handlers). */
function fakeJob(id: string) {
  const markerPath = join(recordDir, `job-${recordSeq++}.job`);
  const sent: unknown[] = [];
  const proc = Object.assign(new EventEmitter(), {
    // Not a live pid on any host this suite runs on; never signalled here.
    pid: 2_000_000_000 + recordSeq,
    stdin: new FakeStream(),
    stdout: new FakeStream(),
    stderr: new FakeStream(),
  });
  const job = {
    id,
    label: id,
    command: "fixture",
    proc,
    buffer: new LineBuffer(),
    matchers: compileMatchers([]),
    rules: { exit: true, match: [] },
    wake: { matchCount: 0, lastWakeAt: 0, stallNotified: false },
    startedAt: Date.now(),
    lastOutputAt: null,
    exited: false,
    pending: new PendingLineBuffer(),
    ownership: { token: `ack${recordSeq}`, markerPath, stopPath: `${markerPath}.stop` },
    shellRoute: "msix",
  } as any;
  backgroundShellTest.registerJobForTests({ sendMessage: (message: unknown) => { sent.push(message); } } as never, job);
  return { job, proc, markerPath, sent };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

// The drain window is 1.5 s at a 0.5 s tick; 4 s comfortably covers settlement
// and is the bound used to show that missing evidence does NOT settle.
const SETTLE_BOUND_MS = 4_000;

describe("root exit + verified job-object acknowledgement with the pipe still open (#800)", () => {
  for (const acknowledgement of ["terminated", "released"] as const) {
    it(`settles on a '${acknowledgement}' acknowledgement while an outside process holds the pipe`, SKIP, async () => {
      const { job, proc, markerPath, sent } = fakeJob(`ack-${acknowledgement}`);
      proc.emit("exit", 1, null);
      writeFileSync(markerPath, `4242 ${acknowledgement} msix\n`);
      // No `close` is ever emitted: the pipe is held by a process outside the job.
      expect(await waitFor(() => job.exited, SETTLE_BOUND_MS), "settled without a stream close").toBe(true);
      expect(job.exitCode, "the root's own exit status").toBe(1);
      expect(job.settledOnAcknowledgement).toBe(acknowledgement);
      // The host releases its own pipe ends; nothing signals any process.
      expect(proc.stdout.destroyed && proc.stderr.destroyed && proc.stdin.destroyed, "host pipe ends released").toBe(true);
      expect(backgroundShellTest.ownershipHeldForTests(job.id), "ownership token released").toBe(false);
      expect(sent.length, "the active session receives the exit wake").toBe(1);
      const note = job.buffer.tail(2).join("\n");
      expect(note).toContain("every process in the job is gone");
      expect(note).toContain("not tracked, stopped, or reported");
    });
  }

  it("lets an ordinary close inside the drain window win, with no scoped note", SKIP, async () => {
    const { job, proc, markerPath } = fakeJob("ack-close-wins");
    proc.emit("exit", 0, null);
    writeFileSync(markerPath, "4242 released msix\n");
    await sleep(600);
    proc.emit("close", 0, null);
    expect(job.exited, "settled by the close").toBe(true);
    expect(job.settledOnAcknowledgement).toBeUndefined();
    expect(proc.stdout.destroyed, "an ordinary close never destroys streams").toBe(false);
    await sleep(2_000);
    expect(job.settledOnAcknowledgement, "the acknowledgement path stays out of a settled job").toBeUndefined();
  });

  const unacknowledged: Array<[string, string | null]> = [
    ["a missing record", null],
    ["a running record whose watchdog is gone", `${DEAD_WATCHDOG_PID} running msix\n`],
    ["a partial record", "4242"],
    ["an empty record", ""],
    ["a malformed state", "4242 terminat"],
  ];
  for (const [name, text] of unacknowledged) {
    it(`does not settle on ${name}`, SKIP, async () => {
      const { job, proc, markerPath } = fakeJob(`no-ack-${recordSeq}`);
      proc.emit("exit", 0, null);
      if (text !== null) writeFileSync(markerPath, text);
      expect(await waitFor(() => job.exited, SETTLE_BOUND_MS), "missing/failed acknowledgement keeps the job").toBe(false);
      expect(proc.stdout.destroyed, "pipes untouched").toBe(false);
      expect(backgroundShellTest.ownershipHeldForTests(job.id), "ownership still held").toBe(true);
    });
  }

  it("does not settle before the root itself has exited, whatever the record says", SKIP, async () => {
    const { job, markerPath } = fakeJob("ack-root-live");
    writeFileSync(markerPath, "4242 terminated msix\n");
    expect(await waitFor(() => job.exited, SETTLE_BOUND_MS)).toBe(false);
  });

  it("does not let a stale acknowledgement settle when it changes back to running", SKIP, async () => {
    const { job, proc, markerPath } = fakeJob("ack-flap");
    proc.emit("exit", 0, null);
    writeFileSync(markerPath, "4242 released msix\n");
    await sleep(700);
    writeFileSync(markerPath, `${DEAD_WATCHDOG_PID} running msix\n`);
    expect(await waitFor(() => job.exited, SETTLE_BOUND_MS)).toBe(false);
  });
});

describe("Store/MSIX route: a closed pipe without an acknowledgement is not completion (#800)", () => {
  it("ownershipVerdict: a gone watchdog is unverifiable on the Store route, clear only on the ordinary route", SKIP, () => {
    const store = join(recordDir, "verdict-store.job");
    const ordinary = join(recordDir, "verdict-ordinary.job");
    writeFileSync(store, `${DEAD_WATCHDOG_PID} running msix\n`);
    writeFileSync(ordinary, `${DEAD_WATCHDOG_PID} running\n`);
    const dead = () => false;
    expect(ownershipVerdict(store, false, dead), "Store route: missing terminal evidence").toBe("unverifiable");
    expect(ownershipVerdict(ordinary, false, dead), "ordinary route: unchanged").toBe("clear");
    // A live (possibly reused) pid never proves the Store job clear.
    expect(ownershipVerdict(store, false, () => true)).toBe("running");
    for (const state of ["released", "terminated"]) {
      writeFileSync(store, `${DEAD_WATCHDOG_PID} ${state} msix\n`);
      expect(ownershipVerdict(store, false, dead, "msix"), `explicit ${state}`).toBe("clear");
    }
    // The launcher's own failure record is the one untagged Store record.
    writeFileSync(store, "0 failed\n");
    expect(ownershipVerdict(store, false, dead, "msix"), "launcher-written 0 failed").toBe("clear");
  });

  it("validates a known Store job's record as a Store record, whatever its text claims", SKIP, () => {
    const store = join(recordDir, "verdict-store-strict.job");
    const dead = () => false;
    const invalid = [
      `${DEAD_WATCHDOG_PID} running`, // missing tag: never the ordinary pid-based clearance
      `${DEAD_WATCHDOG_PID} released`,
      `${DEAD_WATCHDOG_PID} terminated msi`, // truncated tag
      `${DEAD_WATCHDOG_PID} terminated msix extra`,
      "0 terminated msix", // a terminal record without a watchdog pid
      "0 running msix",
      "00 failed",
      "4242 failed msix", // only the launcher writes failed, and untagged
      `0${DEAD_WATCHDOG_PID} released msix`,
      "",
    ];
    for (const text of invalid) {
      writeFileSync(store, text);
      expect(ownershipVerdict(store, false, dead, "msix"), `invalid Store record: ${JSON.stringify(text)}`).toBe("unverifiable");
      expect(ownershipAcknowledgement(store, "msix"), `no acknowledgement from ${JSON.stringify(text)}`).toBeUndefined();
    }
    // Ordinary-route compatibility is unchanged when no Store route is expected.
    writeFileSync(store, `${DEAD_WATCHDOG_PID} running`);
    expect(ownershipVerdict(store, false, dead)).toBe("clear");
  });

  it("exit then close with only a running record and a gone watchdog keeps the job unverifiable", SKIP, async () => {
    const { job, proc, markerPath, sent } = fakeJob("close-no-ack");
    writeFileSync(markerPath, `${DEAD_WATCHDOG_PID} running msix\n`);
    proc.emit("exit", 0, null);
    proc.emit("close", 0, null);
    expect(await waitFor(() => job.exited, SETTLE_BOUND_MS), "no settlement on a bare close").toBe(false);
    expect(job.ownershipUnverifiable, "recorded as unverifiable").toBe(true);
    expect(backgroundShellTest.ownershipHeldForTests(job.id), "ownership still held").toBe(true);
    expect(sent.length, "no exit wake").toBe(0);
    // A later explicit terminal record settles it, with the workload's own status.
    writeFileSync(markerPath, `${DEAD_WATCHDOG_PID} terminated msix\n`);
    expect(await waitFor(() => job.exited, SETTLE_BOUND_MS), "settles on the explicit record").toBe(true);
    expect(job.exitCode, "the workload's own exit status, kept separate").toBe(0);
    expect(backgroundShellTest.ownershipHeldForTests(job.id)).toBe(false);
  });

  it("exit then close with an explicit released record settles through the ordinary close path", SKIP, async () => {
    const { job, proc, markerPath, sent } = fakeJob("close-ack");
    writeFileSync(markerPath, `${DEAD_WATCHDOG_PID} released msix\n`);
    proc.emit("exit", 3, null);
    proc.emit("close", 3, null);
    expect(job.exited).toBe(true);
    expect(job.exitCode).toBe(3);
    expect(job.settledOnAcknowledgement, "no out-of-job note on an ordinary close").toBeUndefined();
    expect(sent.length).toBe(1);
  });

  it("readiness keeps a Store job blocked until an explicit terminal record exists", SKIP, () => {
    const markerPath = join(recordDir, "readiness-store.job");
    const readiness = new BackgroundProcessReadiness();
    const started = {
      details: { kind: "pi-review-bg-shell", event: "started", id: "jobR", label: "store", pid: 2_000_000_999, ownershipMarker: markerPath, ownershipRoute: "msix" },
    };
    expect(readiness.observeToolResult("ShellStart", started) !== undefined, "tracked").toBe(true);
    writeFileSync(markerPath, `${DEAD_WATCHDOG_PID} running msix\n`);
    expect(readiness.snapshot().running.length, "a gone watchdog without a terminal record blocks").toBe(1);
    // A failed termination/accounting query never produces a terminal record;
    // an unreadable record blocks as well.
    writeFileSync(markerPath, `${DEAD_WATCHDOG_PID} terminat`);
    expect(readiness.snapshot().running.length, "partial evidence blocks").toBe(1);
    for (const text of [`${DEAD_WATCHDOG_PID} running`, `${DEAD_WATCHDOG_PID} terminated msi`, "0 terminated msix"]) {
      writeFileSync(markerPath, text);
      expect(readiness.snapshot().running.length, `invalid Store record blocks: ${text}`).toBe(1);
    }
    writeFileSync(markerPath, `${DEAD_WATCHDOG_PID} terminated msix\n`);
    expect(readiness.snapshot().running.length, "explicit terminated clears").toBe(0);
  });

  it("retains unresolved Store ownership when another start reports the same launcher pid", SKIP, () => {
    // The Node-facing launcher pid of an exited Store job can be reused by a
    // later start while the first job's record is still unresolved; the later
    // start must not overwrite the first job's readiness obligation.
    const readiness = new BackgroundProcessReadiness();
    const first = join(recordDir, "reused-launcher-first.job");
    const second = join(recordDir, "reused-launcher-second.job");
    const start = (id: string, ownershipMarker: string) => readiness.observeToolResult("ShellStart", {
      details: { kind: "pi-review-bg-shell", event: "started", id, label: id, pid: 2_000_000_998, ownershipMarker, ownershipRoute: "msix" },
    });
    start("first", first);
    expect(readiness.snapshot().running.map((job) => job.id), "missing first record blocks").toEqual(["first"]);
    start("second", second);
    expect(readiness.snapshot().running.map((job) => job.id), "both obligations tracked").toEqual(["first", "second"]);
    writeFileSync(second, `${DEAD_WATCHDOG_PID} released msix\n`);
    expect(readiness.snapshot().running.map((job) => job.id), "second clears, first still unresolved").toEqual(["first"]);
    writeFileSync(first, `${DEAD_WATCHDOG_PID} terminated msix\n`);
    expect(readiness.snapshot().running, "first clears only on its own terminal record").toEqual([]);
  });

  it("settles Store readiness on its own marker even while the shared launcher pid is live", SKIP, () => {
    // process.pid is a known-LIVE pid standing in for a launcher pid that an
    // unrelated process now holds. Each Store job's own marker decides; the
    // live pid neither holds a verified job open nor clears an unverified one.
    const readiness = new BackgroundProcessReadiness();
    const livePid = process.pid;
    const markers = {
      settled: join(recordDir, "live-pid-settled.job"),
      missing: join(recordDir, "live-pid-missing.job"),
      malformed: join(recordDir, "live-pid-malformed.job"),
      running: join(recordDir, "live-pid-running.job"),
    };
    for (const [id, ownershipMarker] of Object.entries(markers)) {
      readiness.observeToolResult("ShellStart", {
        details: { kind: "pi-review-bg-shell", event: "started", id, label: id, pid: livePid, ownershipMarker, ownershipRoute: "msix" },
      });
    }
    writeFileSync(markers.settled, `${DEAD_WATCHDOG_PID} terminated msix\n`);
    writeFileSync(markers.malformed, `${DEAD_WATCHDOG_PID} terminated\n`);
    writeFileSync(markers.running, `${livePid} running msix\n`);
    const running = () => readiness.snapshot().running.map((job) => job.id).sort();
    expect(running(), "verified job clears; missing, malformed, and running records block").toEqual(["malformed", "missing", "running"]);
    writeFileSync(markers.running, `${DEAD_WATCHDOG_PID} running msix\n`);
    expect(running(), "a running record with a dead watchdog still blocks").toEqual(["malformed", "missing", "running"]);
    writeFileSync(markers.missing, "0 failed\n");
    writeFileSync(markers.running, `${DEAD_WATCHDOG_PID} released msix\n`);
    expect(running(), "each clears only on its own strict terminal record").toEqual(["malformed"]);
    writeFileSync(markers.malformed, `${DEAD_WATCHDOG_PID} released msix\n`);
    expect(running(), "all settled").toEqual([]);
  });

  it("keeps ordinary-route readiness gated on the live root pid (unchanged)", SKIP, () => {
    const readiness = new BackgroundProcessReadiness();
    const markerPath = join(recordDir, "ordinary-live-root.job");
    readiness.observeToolResult("ShellStart", {
      details: { kind: "pi-review-bg-shell", event: "started", id: "ordinary", label: "ordinary", pid: process.pid, ownershipMarker: markerPath },
    });
    writeFileSync(markerPath, `${DEAD_WATCHDOG_PID} released\n`);
    expect(readiness.snapshot().running.map((job) => job.id), "a live ordinary root keeps the job running").toEqual(["ordinary"]);
  });
});

describe("a reaped Store job keeps its acknowledgement watcher until verified settlement (#800)", () => {
  it("delivers no output match and no close-driven exit wake after reaping", SKIP, async () => {
    const { job, proc, markerPath, sent } = fakeJob("reap-stream-events");
    job.matchers = compileMatchers(["old-session-output"]);
    job.rules.match = ["old-session-output"];
    reapAll();
    proc.stdout.emit("data", Buffer.from("old-session-output\n"));
    await sleep(1_700); // past the match-wake coalescing window
    expect(sent, "no match wake from a reaped job").toEqual([]);
    writeFileSync(markerPath, "4242 terminated msix\n");
    proc.emit("exit", 0, null);
    proc.emit("close", 0, null);
    expect(job.exited, "settled by the verified close").toBe(true);
    expect(backgroundShellTest.ownershipHeldForTests(job.id), "ownership released").toBe(false);
    expect(sent, "no exit wake into the replacement session").toEqual([]);
  });

  it("a live Store job still wakes on a match (the guard is reap-only)", SKIP, async () => {
    const { job, proc, sent } = fakeJob("live-match");
    job.matchers = compileMatchers(["live-session-output"]);
    job.rules.match = ["live-session-output"];
    proc.stdout.emit("data", Buffer.from("live-session-output\n"));
    expect(await waitFor(() => sent.length > 0, 3_000), "match wake delivered").toBe(true);
  });

  it("root exit, then reap, then acknowledgement: pipe ends and ownership released, no stale wake", SKIP, async () => {
    const { job, proc, markerPath, sent } = fakeJob("reap-after-exit");
    proc.emit("exit", 0, null);
    reapAll(); // session change: stop requested, job dropped from the active map
    expect(await waitFor(() => job.exited, 1_000), "nothing settles before the acknowledgement").toBe(false);
    writeFileSync(markerPath, "4242 terminated msix\n");
    // No `close`: an outside process still holds the pipe.
    expect(await waitFor(() => job.exited, SETTLE_BOUND_MS), "settled after the reap").toBe(true);
    expect(proc.stdout.destroyed && proc.stderr.destroyed && proc.stdin.destroyed, "host pipe ends released").toBe(true);
    expect(backgroundShellTest.ownershipHeldForTests(job.id), "ownership token released").toBe(false);
    expect(sent.length, "no wake reaches the replacement session").toBe(0);
  });

  it("reap, then root exit, then acknowledgement: settles without waking the replacement session", SKIP, async () => {
    const { job, proc, markerPath, sent } = fakeJob("reap-before-exit");
    reapAll();
    proc.emit("exit", 0, null);
    writeFileSync(markerPath, "4242 terminated msix\n");
    expect(await waitFor(() => job.exited, SETTLE_BOUND_MS), "settled").toBe(true);
    expect(proc.stdout.destroyed, "host pipe ends released").toBe(true);
    expect(backgroundShellTest.ownershipHeldForTests(job.id)).toBe(false);
    expect(sent.length, "no stale wake").toBe(0);
  });
});

function shellStartHarness() {
  const tools: Record<string, any> = {};
  const pi: any = { registerTool: (t: any) => { tools[t.name] = t; }, on: () => {}, sendMessage: () => {} };
  const controller = registerBackgroundShell(pi);
  const start = (label: string, signal?: AbortSignal) =>
    tools.ShellStart.execute("id", { command: "Write-Output never", label }, signal, undefined, { hasUI: false, ui: {} });
  return { controller, start };
}

describe("ShellStart cancellation and session change before spawn (#800)", () => {
  it("never starts a job when the call is already cancelled", async () => {
    const { controller, start } = shellStartHarness();
    const result = await start("cancelled", AbortSignal.abort());
    expect(result.isError, "cancelled start is an error result").toBe(true);
    expect(result.content[0].text).toContain("cancelled before the job started");
    expect(controller.snapshot().running).toEqual([]);
  });

  it("re-checks cancellation after the asynchronous shell discovery", SKIP, async () => {
    const { controller, start } = shellStartHarness();
    const abort = new AbortController();
    const pending = start("cancelled-during-discovery", abort.signal);
    abort.abort(); // lands while discovery is awaited
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cancelled before the job started");
    expect(controller.snapshot().running).toEqual([]);
  });

  it("never spawns into a new session when the session changes during discovery", SKIP, async () => {
    const { controller, start } = shellStartHarness();
    const pending = start("superseded");
    reapAll(); // session change while discovery is awaited
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("superseded by a session change");
    expect(controller.snapshot().running).toEqual([]);
  });
});
