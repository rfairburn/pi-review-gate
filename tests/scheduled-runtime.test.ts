import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { cronMatchesLocalDate, parseCronExpression } from "../src/scheduling/cron";
import { CronMinuteSampler } from "../src/scheduling/dispatcher";
import type { LocalDateOf } from "../src/scheduling/dispatcher";
import { ScheduledTaskRuntime } from "../src/scheduling/dispatcher";
import { deliverScheduledEvent, formatScheduledDispatchFailure, formatScheduledOverdueDrop, formatScheduledSkipEvent, scheduledTaskDefinition } from "../src/scheduling/events";
import { getSchedulerRuntime, resetSchedulerRuntimeForTests } from "../src/scheduling/runtime";
import type { ScheduledTaskCatalog } from "../src/config";
import { BackgroundExecutionController, type BackgroundExecutionGroup } from "../src/execution/background-controller";
import { createState } from "../src/state";
import { awaitBounded, controllerInternals, initGitRepo } from "./helpers/background-controller-fixtures";

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// cronMatchesLocalDate: the standard Vixie day-matching rule over local fields.
// ---------------------------------------------------------------------------

test("cronMatchesLocalDate applies the Vixie day-of-month OR day-of-week rule", () => {
  // 2025-03-01 is a Saturday; 2025-03-03 is a Monday. All dates at 09:00 local.
  const both = parseCronExpression("0 9 1 * 1", "test");
  assert.equal(cronMatchesLocalDate(both, new Date(2025, 2, 1, 9, 0)), true, "dom=1 matches even though it is not a Monday");
  assert.equal(cronMatchesLocalDate(both, new Date(2025, 2, 3, 9, 0)), true, "Monday matches even though dom != 1");
  assert.equal(cronMatchesLocalDate(both, new Date(2025, 2, 4, 9, 0)), false, "neither restricted field matches");

  const starDom = parseCronExpression("0 9 * * 1", "test");
  assert.equal(cronMatchesLocalDate(starDom, new Date(2025, 2, 3, 9, 0)), true);
  assert.equal(cronMatchesLocalDate(starDom, new Date(2025, 2, 1, 9, 0)), false, "star dom: only the day-of-week restriction applies");

  const starDow = parseCronExpression("0 9 1 * *", "test");
  assert.equal(cronMatchesLocalDate(starDow, new Date(2025, 2, 1, 9, 0)), true);
  assert.equal(cronMatchesLocalDate(starDow, new Date(2025, 2, 3, 9, 0)), false, "star dow: only the day-of-month restriction applies");

  const allStars = parseCronExpression("0 9 * * *", "test");
  assert.equal(cronMatchesLocalDate(allStars, new Date(2025, 2, 4, 9, 0)), true);

  const steppedMinutes = parseCronExpression("*/15 * * * *", "test");
  assert.equal(cronMatchesLocalDate(steppedMinutes, new Date(2025, 0, 1, 0, 15)), true);
  assert.equal(cronMatchesLocalDate(steppedMinutes, new Date(2025, 0, 1, 0, 16)), false);

  const monthRestricted = parseCronExpression("30 2 * 6 *", "test");
  assert.equal(cronMatchesLocalDate(monthRestricted, new Date(2025, 5, 15, 2, 30)), true);
  assert.equal(cronMatchesLocalDate(monthRestricted, new Date(2025, 6, 15, 2, 30)), false);
});

// ---------------------------------------------------------------------------
// CronMinuteSampler: future-only, no catch-up, once per absolute minute, and
// the DST behavior that falls out of sampling the wall clock.
// ---------------------------------------------------------------------------

test("the sampler is future-only from beginAt and never catches up", () => {
  const base = 1_700_000_000 * MINUTE;
  const sampler = new CronMinuteSampler();
  const every = parseCronExpression("* * * * *", "test");

  // Mid-minute start: the in-progress minute is already sampled.
  sampler.beginAt(base + 7 * MINUTE + 30_000);
  assert.equal(sampler.sampleMinute(base + 7 * MINUTE + 10_000, [{ id: "t", enabled: true, cron: every }]), undefined);
  // The next absolute minute fires exactly once, no matter how often it is
  // ticked, and carries its exact due time for the dispatch to report.
  assert.deepEqual(sampler.sampleMinute(base + 8 * MINUTE, [{ id: "t", enabled: true, cron: every }]), {
    minuteMs: base + 8 * MINUTE,
    dueIds: ["t"],
  });
  assert.equal(sampler.sampleMinute(base + 8 * MINUTE + 45_000, [{ id: "t", enabled: true, cron: every }]), undefined);
  // A jump forward never replays the skipped minutes.
  assert.deepEqual(sampler.sampleMinute(base + 13 * MINUTE, [{ id: "t", enabled: true, cron: every }]), {
    minuteMs: base + 13 * MINUTE,
    dueIds: ["t"],
  });
});

test("a repeated fall-back local minute fires once per distinct absolute due minute", () => {
  const base = 1_700_000_000 * MINUTE;
  // Synthetic 2025-11-02 fall-back: wall clock 01:00–01:59 occurs twice.
  const localDateOf: LocalDateOf = (ms) => {
    const i = Math.floor((ms - base) / MINUTE);
    return new Date(2025, 10, 2, 1, i % 60);
  };
  const sampler = new CronMinuteSampler({ localDateOf });
  const atOneThirty = parseCronExpression("30 1 * * *", "test");
  const entry = { id: "t", enabled: true, cron: atOneThirty };

  let fires = 0;
  for (let i = 0; i < 120; i++) {
    const sampled = sampler.sampleMinute(base + i * MINUTE, [entry]);
    if (sampled && sampled.dueIds.length > 0) fires++;
  }
  assert.equal(fires, 2, "wall-clock 01:30 occurs at two distinct absolute minutes and fires at each");
});

test("nonexistent spring-forward local minutes are missed", () => {
  const base = 1_700_000_000 * MINUTE;
  // Synthetic 2025-03-09 spring-forward: wall clock jumps 01:59 -> 03:00.
  const localDateOf: LocalDateOf = (ms) => {
    const i = Math.floor((ms - base) / MINUTE);
    return i < 60 ? new Date(2025, 2, 9, 1, i) : new Date(2025, 2, 9, 3, i - 60);
  };
  const sampler = new CronMinuteSampler({ localDateOf });
  const atTwoThirty = parseCronExpression("30 2 * * *", "test");
  const entry = { id: "t", enabled: true, cron: atTwoThirty };

  let fires = 0;
  for (let i = 0; i < 120; i++) {
    const sampled = sampler.sampleMinute(base + i * MINUTE, [entry]);
    if (sampled && sampled.dueIds.length > 0) fires++;
  }
  assert.equal(fires, 0, "the host never displays 02:30 on the transition day, so it is missed");
});

// ---------------------------------------------------------------------------
// The process-local switch holder.
// ---------------------------------------------------------------------------

test("the scheduler switch holder is process-global, env-seeded, and setter-driven", () => {
  const previous = process.env.PI_REVIEW_GATE_SCHEDULER;
  try {
    delete process.env.PI_REVIEW_GATE_SCHEDULER;
    resetSchedulerRuntimeForTests();
    const off = getSchedulerRuntime();
    assert.equal(off.enabled, false);

    process.env.PI_REVIEW_GATE_SCHEDULER = "1";
    resetSchedulerRuntimeForTests();
    const on = getSchedulerRuntime();
    assert.equal(on.enabled, true);

    // The same holder is returned for the process lifetime (survives /reload).
    assert.equal(getSchedulerRuntime(), on);

    const seen: boolean[] = [];
    const unsubscribe = on.subscribe((value) => seen.push(value));
    on.setEnabled(false);
    assert.deepEqual(seen, [false], "subscribers are notified synchronously by the setter");
    unsubscribe();
    on.setEnabled(true);
    assert.deepEqual(seen, [false], "unsubscribed listeners are not called");
  } finally {
    if (previous === undefined) delete process.env.PI_REVIEW_GATE_SCHEDULER;
    else process.env.PI_REVIEW_GATE_SCHEDULER = previous;
    resetSchedulerRuntimeForTests();
  }
});

// ---------------------------------------------------------------------------
// ScheduledTaskRuntime: the session-scoped timer loop around the sampler.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await sleep(2);
  }
}

function runtimeFixture() {
  let nowMs = 1_700_000_000 * MINUTE;
  const clock = () => nowMs;
  resetSchedulerRuntimeForTests();
  delete process.env.PI_REVIEW_GATE_SCHEDULER;
  const switchState = getSchedulerRuntime();
  const catalog: ScheduledTaskCatalog = {
    every: { name: "Every minute", cron: "* * * * *", enabled: true, kind: "execute", instructions: "do the thing", workspace: "/tmp/ws" },
  };
  let catalogRef: ScheduledTaskCatalog | undefined = catalog;
  const dispatched: string[] = [];
  const errors: string[] = [];
  const runtime = new ScheduledTaskRuntime({
    switchState,
    catalog: () => catalogRef,
    onDue: (id) => {
      dispatched.push(id);
    },
    onError: (message) => errors.push(message),
    now: clock,
    tickIntervalMs: 2,
  });
  return {
    runtime,
    switchState,
    advanceMinutes: (n: number) => {
      nowMs += n * MINUTE;
    },
    setCatalog: (next: ScheduledTaskCatalog | undefined) => {
      catalogRef = next;
    },
    dispatched,
    errors,
  };
}

test("the runtime is Off at launch and dispatches only after the switch turns On", async () => {
  const fx = runtimeFixture();
  fx.runtime.attach();
  assert.equal(fx.runtime.running, false, "no timers while the process-local switch is Off");
  fx.advanceMinutes(3);
  await sleep(20);
  assert.deepEqual(fx.dispatched, [], "Off processes never dispatch");

  // Turning On mid-minute is future-only: the next full minute fires.
  fx.switchState.setEnabled(true);
  await until(() => fx.runtime.running);
  await sleep(20);
  assert.deepEqual(fx.dispatched, [], "the in-progress minute is not replayed on enable");
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.length === 1);
  assert.deepEqual(fx.dispatched, ["every"]);
  fx.runtime.detach();
});

test("disabling stops future dispatch without touching past or active work", async () => {
  const fx = runtimeFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.length === 1);

  fx.switchState.setEnabled(false);
  assert.equal(fx.runtime.running, false, "the setter stops the timers immediately");
  const count = fx.dispatched.length;
  fx.advanceMinutes(3);
  await sleep(20);
  assert.equal(fx.dispatched.length, count, "no dispatch while Off");
  fx.runtime.detach();
});

test("replan picks up catalog edits from the next minute without replay", async () => {
  const fx = runtimeFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.length === 1);

  // Swap the catalog mid-minute and replan (the Settings Save hook).
  fx.setCatalog({
    other: { name: "Other", cron: "* * * * *", enabled: true, kind: "execute", instructions: "other thing", workspace: "/tmp/ws" },
  });
  fx.runtime.replan();
  await sleep(20);
  assert.equal(fx.dispatched.length, 1, "replan does not replay the in-progress minute");
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.length === 2);
  assert.deepEqual(fx.dispatched, ["every", "other"], "the new catalog applies from the next due occurrence");
  fx.runtime.detach();
});

test("an invalid cron entry is reported once and does not block valid entries", async () => {
  const fx = runtimeFixture();
  fx.setCatalog({
    broken: { name: "Broken", cron: "not a cron", enabled: true, kind: "execute", instructions: "x", workspace: "/tmp/ws" },
    every: { name: "Every minute", cron: "* * * * *", enabled: true, kind: "execute", instructions: "do the thing", workspace: "/tmp/ws" },
  });
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.length === 1);
  const invalidReports = fx.errors.filter((message) => message.includes("broken"));
  assert.equal(invalidReports.length, 1, "the invalid entry is reported exactly once per replan");
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.length === 2);
  assert.equal(fx.errors.filter((message) => message.includes("broken")).length, 1, "still only one report while the loop runs");
  fx.runtime.detach();
});

test("detach stops the loop and re-attach resumes it", async () => {
  const fx = runtimeFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.length === 1);

  fx.runtime.detach();
  assert.equal(fx.runtime.running, false);
  const count = fx.dispatched.length;
  fx.advanceMinutes(2);
  await sleep(20);
  assert.equal(fx.dispatched.length, count, "detached sessions do not dispatch");

  fx.runtime.attach();
  await until(() => fx.runtime.running);
  fx.advanceMinutes(1);
  await until(() => fx.dispatched.length === count + 1);
  fx.runtime.detach();
});

// ---------------------------------------------------------------------------
// Due-time fidelity and independent dispatch: the exact sampled due minute,
// no cross-entry backlog, no same-entry double start, admission under
// disarm/detach, and fail-closed error reporting. All deterministic: a fake
// clock plus pending onDue promises hold each start in flight.
// ---------------------------------------------------------------------------

const DUE_BASE = 1_700_000_000 * MINUTE;

interface DueCall {
  id: string;
  dueAt: Date;
}

function dispatchFixture(options: { entries?: string[]; failing?: ReadonlySet<string> } = {}) {
  const ids = options.entries ?? ["slow", "fast"];
  let nowMs = DUE_BASE;
  resetSchedulerRuntimeForTests();
  delete process.env.PI_REVIEW_GATE_SCHEDULER;
  const switchState = getSchedulerRuntime();
  const catalog: ScheduledTaskCatalog = {};
  for (const id of ids) {
    catalog[id] = { name: `Entry ${id}`, cron: "* * * * *", enabled: true, kind: "execute", instructions: `do ${id}`, workspace: "/tmp/ws" };
  }
  let catalogRef: ScheduledTaskCatalog | undefined = catalog;
  const calls: DueCall[] = [];
  const errors: string[] = [];
  const holds = new Map<string, Array<() => void>>();
  const runtime = new ScheduledTaskRuntime({
    switchState,
    catalog: () => catalogRef,
    onDue: (id, _entry, dueAt) => {
      calls.push({ id, dueAt });
      if (options.failing?.has(id)) return Promise.reject(new Error("boom"));
      // Pending start: held until the test releases it, so a slow or
      // in-flight start stays in flight across as many fake minutes as needed.
      return new Promise<void>((resolve) => {
        const list = holds.get(id) ?? [];
        list.push(resolve);
        holds.set(id, list);
      });
    },
    onError: (message) => errors.push(message),
    now: () => nowMs,
    tickIntervalMs: 2,
  });
  return {
    runtime,
    switchState,
    calls,
    errors,
    advance: (ms: number) => {
      nowMs += ms;
    },
    /** Settle every held start of one entry (an admitted run completing). */
    release: (id: string) => {
      for (const resolve of holds.get(id) ?? []) resolve();
      holds.set(id, []);
    },
  };
}

test("dispatches carry the exact sampled due minute, not the dispatch instant", async () => {
  const fx = dispatchFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  // The next minute is sampled partway through it (the tick lands inside the
  // window), so a wall-clock timestamp would carry the offset — the due time
  // must still be exactly the minute's start.
  fx.advance(MINUTE + 40_000);
  await until(() => fx.calls.length === 2, 2_000);
  for (const call of fx.calls) {
    assert.equal(call.dueAt.getTime(), DUE_BASE + MINUTE, `${call.id} reports the sampled minute, not the dispatch instant`);
    assert.equal(call.dueAt.getUTCSeconds(), 0);
    assert.equal(call.dueAt.getUTCMilliseconds(), 0);
  }
  fx.runtime.detach();
});

test("a slow start never backlogs other entries across minute boundaries", async () => {
  const fx = dispatchFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  // Minute 1: both entries are admitted and their starts held in flight.
  fx.advance(MINUTE + 5_000);
  await until(() => fx.calls.length === 2, 2_000);
  assert.deepEqual(fx.calls.map((c) => c.id).sort(), ["fast", "slow"]);

  // fast's start settles; slow's is still in flight.
  fx.release("fast");

  // Minute 2 while slow is still starting: fast must dispatch at its own due
  // minute — no global backlog — and the tick loop keeps running (no timer
  // loss) even though a start is pending.
  fx.advance(MINUTE);
  await until(() => fx.calls.some((c) => c.id === "fast" && c.dueAt.getTime() === DUE_BASE + 2 * MINUTE), 2_000);
  assert.equal(
    fx.calls.filter((c) => c.id === "slow").length,
    1,
    "slow's second occurrence cannot start while its first is still starting",
  );

  // slow's start settles; the queued occurrence is then admitted with its own
  // exact due minute — nothing was dropped or replayed.
  fx.release("slow");
  await until(() => fx.calls.filter((c) => c.id === "slow").length === 2, 2_000);
  const slowCalls = fx.calls.filter((c) => c.id === "slow");
  assert.equal(slowCalls[0]!.dueAt.getTime(), DUE_BASE + MINUTE);
  assert.equal(slowCalls[1]!.dueAt.getTime(), DUE_BASE + 2 * MINUTE, "the deferred occurrence keeps its own sampled due minute");
  fx.runtime.detach();
});

test("concurrent ticks never start two runs of the same entry while one is still starting", async () => {
  const fx = dispatchFixture({ entries: ["solo"] });
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  // Minute 1 due: admitted, start held in flight.
  fx.advance(MINUTE);
  await until(() => fx.calls.length === 1, 2_000);

  // Minute 2 due while the minute-1 start is still starting: repeated ticks
  // must not admit a second run of the same entry.
  fx.advance(MINUTE);
  await sleep(40);
  assert.equal(fx.calls.length, 1, "no same-entry double start while a previous due is still starting");

  // The first start settles; the pending occurrence is admitted afterwards,
  // in order, each with its exact sampled due minute (observable, not lost).
  fx.release("solo");
  await until(() => fx.calls.length === 2, 2_000);
  assert.deepEqual(
    fx.calls.map((c) => c.dueAt.getTime()),
    [DUE_BASE + MINUTE, DUE_BASE + 2 * MINUTE],
  );
  fx.runtime.detach();
});

test("disarm and detach drop not-yet-admitted starts without touching admitted ones", async () => {
  // Switch Off: the occurrence merely waiting behind a pending start is
  // dropped when it would be admitted; re-enabling replans future-only.
  const off = dispatchFixture({ entries: ["solo"] });
  off.switchState.setEnabled(true);
  off.runtime.attach();
  await until(() => off.runtime.running);
  off.advance(MINUTE);
  await until(() => off.calls.length === 1, 2_000);
  off.advance(MINUTE); // second occurrence queued behind the pending start
  await sleep(40);
  assert.equal(off.calls.length, 1);

  off.switchState.setEnabled(false);
  assert.equal(off.runtime.running, false, "the setter stops the timers immediately");
  off.release("solo"); // the admitted minute-1 start settles anyway
  await sleep(40);
  assert.equal(off.calls.length, 1, "disarm drops the not-yet-admitted occurrence; the admitted run is untouched");

  // Re-enabling replans future-only: the in-progress (already sampled) minute
  // is not replayed while ticks keep firing at the same fake time.
  off.switchState.setEnabled(true);
  await until(() => off.runtime.running);
  await sleep(40);
  assert.equal(off.calls.length, 1, "re-enabling does not replay the in-progress minute");

  // The next full minute dispatches again, with its exact due time.
  off.advance(MINUTE);
  await until(() => off.calls.length === 2, 2_000);
  assert.equal(off.calls[1]!.dueAt.getTime(), DUE_BASE + 3 * MINUTE, "dispatch resumes at the next due occurrence");
  off.runtime.detach();

  // Detach: same admission guard for a session that is ending.
  const det = dispatchFixture({ entries: ["solo"] });
  det.switchState.setEnabled(true);
  det.runtime.attach();
  await until(() => det.runtime.running);
  det.advance(MINUTE);
  await until(() => det.calls.length === 1, 2_000);
  det.advance(MINUTE); // second occurrence queued behind the pending start
  await sleep(40);

  det.runtime.detach();
  assert.equal(det.runtime.running, false);

  // Re-attach first: the queued occurrence is then admitted in an attached,
  // enabled epoch where only the generation guard can drop it.
  det.runtime.attach();
  await until(() => det.runtime.running);
  det.release("solo");
  await sleep(40);
  assert.equal(det.calls.length, 1, "detach drops the not-yet-admitted occurrence; the admitted run is untouched");
});

test("a dispatch rejection is reported fail-closed and never breaks the loop or the entry's chain", async () => {
  const fx = dispatchFixture({ failing: new Set(["fast"]) });
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  // Minute 1: fast rejects (reported, not swallowed); slow is admitted and held.
  fx.advance(MINUTE);
  await until(() => fx.errors.length === 1 && fx.calls.some((c) => c.id === "slow"), 2_000);
  assert.match(fx.errors[0]!, /fast/);
  assert.match(fx.errors[0]!, /boom/);

  // Minute 2: the loop is still alive and fast's own chain is healthy — the
  // next due occurrence is evaluated independently (and reported again).
  fx.advance(MINUTE);
  await until(() => fx.calls.filter((c) => c.id === "fast").length === 2 && fx.errors.length === 2, 2_000);
  assert.equal(fx.calls.filter((c) => c.id === "slow").length, 1, "the healthy entry's pending start is unaffected by the failure");
  fx.release("slow");
  fx.runtime.detach();
});

// ---------------------------------------------------------------------------
// Temporal safety of queued occurrences: generation boundaries (Off, detach,
// Save/replan) drop not-yet-admitted occurrences; an admission delayed past
// the occurrence's own due minute is reported, never caught up; settled
// chains are tidied without losing same-entry serialization. All deterministic:
// a fake clock plus pending onDue promises hold each start in flight.
// ---------------------------------------------------------------------------

interface FakeScheduledRun {
  executionId: string;
  kind: "execute";
  tasks: Array<{ taskId: string; title: string; state: string }>;
}

/** The runtime's private per-entry chain map (test-only inspection). */
function inFlightMap(runtime: ScheduledTaskRuntime): Map<string, Promise<void>> {
  return (runtime as unknown as { inFlight: Map<string, Promise<void>> }).inFlight;
}

/**
 * A single-entry fixture whose onDue mirrors the production hook contract
 * (src/index.ts): while a run of the entry is active, every due occurrence is
 * recorded as an overlap skip with its exact due time and the active handles;
 * an overdue occurrence with no active run is recorded as a bounded not-run
 * report instead of starting a catch-up run; otherwise the start is admitted
 * and held until the test settles it. A successful release adds an active fake
 * group (a run that outlives its start promise); a failed one creates none,
 * like a fail-closed start, and records the hook's failure report.
 */
function overlapFixture() {
  let nowMs = DUE_BASE;
  resetSchedulerRuntimeForTests();
  delete process.env.PI_REVIEW_GATE_SCHEDULER;
  const switchState = getSchedulerRuntime();
  const catalog: ScheduledTaskCatalog = {
    solo: { name: "Solo", cron: "* * * * *", enabled: true, kind: "execute", instructions: "do solo", workspace: "/tmp/ws" },
  };
  let catalogRef: ScheduledTaskCatalog | undefined = catalog;
  const starts: Array<{ dueAt: Date; instructions: string }> = [];
  const skips: Array<{ dueAt: Date; runs: FakeScheduledRun[] }> = [];
  const drops: Array<{ dueAt: Date }> = [];
  const failures: Array<{ dueAt: Date }> = [];
  const groups: FakeScheduledRun[] = [];
  const pending: Array<{ dueAt: Date; resolve: () => void }> = [];
  let executionCounter = 0;
  const runtime = new ScheduledTaskRuntime({
    switchState,
    catalog: () => catalogRef,
    onDue: (_id, entry, dueAt, overdue) => {
      if (groups.length > 0) {
        skips.push({ dueAt, runs: groups.map((run) => ({ ...run })) });
        return Promise.resolve();
      }
      if (overdue) {
        drops.push({ dueAt });
        return Promise.resolve();
      }
      starts.push({ dueAt, instructions: entry.instructions });
      return new Promise<void>((resolve) => pending.push({ dueAt, resolve }));
    },
    now: () => nowMs,
    tickIntervalMs: 2,
  });
  return {
    runtime,
    switchState,
    starts,
    skips,
    drops,
    failures,
    groups,
    /** The live sampled entry object (test seam for in-place mutation). */
    entry: catalog.solo,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setCatalog: (next: ScheduledTaskCatalog | undefined) => {
      catalogRef = next;
    },
    /**
     * Settle every held start of the entry. Success adds an active fake group
     * (the run outlives its start promise); failure creates none and records
     * the hook's fail-closed report, like a rejected startScheduled.
     */
    release: (failed = false) => {
      for (const item of pending.splice(0)) {
        if (failed) {
          failures.push({ dueAt: item.dueAt });
        } else {
          executionCounter += 1;
          groups.push({
            executionId: `exec-${executionCounter}`,
            kind: "execute",
            tasks: [{ taskId: `task-${executionCounter}`, title: "Scheduled execute task solo: Solo", state: "running" }],
          });
        }
        item.resolve();
      }
    },
    /** Settle the entry's active runs (the ordinary lifecycle finished them). */
    settle: () => {
      groups.length = 0;
    },
  };
}

test("re-enabling never starts an occurrence queued before the switch went Off", async () => {
  const fx = overlapFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  // Minute 1: start admitted and held in flight.
  fx.advance(MINUTE + 5_000);
  await until(() => fx.starts.length === 1, 2_000);
  assert.equal(fx.starts[0]!.dueAt.getTime(), DUE_BASE + MINUTE);

  // Minute 2: due while minute 1's start is still pending — queued.
  fx.advance(MINUTE);
  await sleep(40);
  assert.equal(fx.starts.length, 1, "the queued occurrence cannot start while the previous is pending");
  assert.deepEqual([...inFlightMap(fx.runtime).keys()], ["solo"], "the minute-2 occurrence is queued behind the pending start");

  // Switch Off: timers stop; the queued minute-2 occurrence crosses the boundary.
  fx.switchState.setEnabled(false);
  assert.equal(fx.runtime.running, false, "the setter stops the timers immediately");

  // Re-enable first: the queued occurrence is then admitted in a re-enabled,
  // attached epoch where only the generation guard can drop it (not the
  // pre-existing enabled check).
  fx.switchState.setEnabled(true);
  await until(() => fx.runtime.running);
  fx.release(); // the admitted minute-1 start settles anyway
  await until(() => fx.groups.length === 1);
  await sleep(40);
  assert.equal(fx.starts.length, 1, "the pre-Off queued occurrence never starts after the start settles");
  assert.equal(fx.skips.length + fx.drops.length, 0, "a boundary drop is silent: no stale skip or overdue report");
  assert.equal(fx.groups.length, 1, "the admitted run is untouched by the Off toggle");
  assert.equal(fx.starts.length, 1, "re-enabling does not replay or start the stale occurrence");

  // The next full minute dispatches again with its exact due time.
  fx.settle();
  fx.advance(MINUTE);
  await until(() => fx.starts.length === 2, 2_000);
  assert.equal(fx.starts[1]!.dueAt.getTime(), DUE_BASE + 3 * MINUTE, "dispatch resumes at the next due occurrence");
  fx.runtime.detach();
});

test("a Save drops queued pre-Save occurrences and applies the saved catalog from the next due", async () => {
  const fx = overlapFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  fx.advance(MINUTE + 5_000);
  await until(() => fx.starts.length === 1, 2_000);
  assert.equal(fx.starts[0]!.instructions, "do solo");
  fx.advance(MINUTE); // minute-2 occurrence queued behind the pending start
  await sleep(40);

  // Save: swap in the edited catalog and replan (the Settings Save hook).
  fx.setCatalog({
    solo: { name: "Solo", cron: "* * * * *", enabled: true, kind: "execute", instructions: "do solo v2", workspace: "/tmp/ws" },
  });
  fx.runtime.replan();
  await sleep(40);
  assert.equal(fx.starts.length, 1, "replan does not replay the in-progress minute");

  fx.release(); // the minute-1 start settles (its run becomes active)
  await until(() => fx.groups.length === 1);
  await sleep(40);
  assert.equal(fx.starts.length, 1, "the pre-Save queued occurrence never starts with the edited definition");
  assert.equal(fx.skips.length + fx.drops.length, 0, "a Save drop is silent: no stale skip or overdue report");

  // The saved catalog applies from the very next due occurrence.
  fx.settle();
  fx.advance(MINUTE);
  await until(() => fx.starts.length === 2, 2_000);
  assert.equal(fx.starts[1]!.dueAt.getTime(), DUE_BASE + 3 * MINUTE);
  assert.equal(fx.starts[1]!.instructions, "do solo v2", "the next due occurrence runs the saved definition");
  fx.runtime.detach();
});

test("a queued occurrence carries the entry definition it was sampled with", async () => {
  const fx = overlapFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  fx.advance(MINUTE + 5_000);
  await until(() => fx.starts.length === 1, 2_000);
  fx.advance(MINUTE); // minute-2 occurrence queued behind the pending start
  await sleep(40);

  // In-place edit of the sampled entry object (a test-only path: production
  // catalog edits replace entries and replan). The queued occurrence must
  // still carry its shallow-copied sampled definition.
  fx.entry.instructions = "do solo v2";
  // The minute-1 start fails inside the minute-2 window: no group is created,
  // so the queued occurrence is admitted at-time and must not see the edit.
  fx.release(true);
  assert.equal(fx.failures.length, 1, "the failed start is reported fail-closed");
  await until(() => fx.starts.length === 2, 2_000);
  assert.equal(fx.starts[1]!.dueAt.getTime(), DUE_BASE + 2 * MINUTE);
  assert.equal(fx.starts[1]!.instructions, "do solo", "the queued occurrence holds its sampled copy");
  fx.runtime.detach();
});

test("an overdue due without an active run is reported as not-run, never caught up", async () => {
  const fx = overlapFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  // Minute 1: start admitted and held across two more due minutes.
  fx.advance(MINUTE + 5_000);
  await until(() => fx.starts.length === 1, 2_000);
  fx.advance(MINUTE); // minute-2 occurrence queued
  await sleep(40);
  fx.advance(MINUTE); // now past the minute-2 due minute; minute-3 also queued
  await sleep(40);

  // The held start fails: no group is created and the hook reports it.
  fx.release(true);
  assert.equal(fx.failures.length, 1, "the failed start is reported fail-closed");

  // Minute 2 is admitted overdue with no active run: bounded not-run report,
  // exact due minute, and NO catch-up start.
  await until(() => fx.drops.length === 1, 2_000);
  assert.equal(fx.drops[0]!.dueAt.getTime(), DUE_BASE + 2 * MINUTE, "the report names the exact due minute");

  // Minute 3 is admitted inside its own due minute and evaluated independently.
  await until(() => fx.starts.length === 2, 2_000);
  assert.equal(fx.starts[1]!.dueAt.getTime(), DUE_BASE + 3 * MINUTE, "the next due occurrence runs at its own minute");

  // Settled chains are tidied: only minute 3's still-pending chain remains.
  await until(() => inFlightMap(fx.runtime).size === 1);
  assert.deepEqual([...inFlightMap(fx.runtime).keys()], ["solo"]);
  fx.runtime.detach();
});

test("a delayed due with an active run skips with the exact due minute and handles", async () => {
  const fx = overlapFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  // Minute 1: start admitted and held past two more due minutes.
  fx.advance(MINUTE + 5_000);
  await until(() => fx.starts.length === 1, 2_000);
  fx.advance(MINUTE); // minute-2 occurrence queued (its due minute will pass)
  await sleep(40);
  fx.advance(MINUTE); // minute-3 occurrence queued too
  await sleep(40);

  // The held start succeeds: its run stays active (the run outlives the start).
  fx.release();
  await until(() => fx.groups.length === 1);

  // Both later dues are skips with actionable data — minute 2 even though it
  // was admitted late within the same enabled epoch. No catch-up starts.
  await until(() => fx.skips.length === 2, 2_000);
  assert.equal(fx.drops.length, 0, "an active run is reported as an overlap skip, not a drop");
  assert.deepEqual(
    fx.skips.map((skip) => skip.dueAt.getTime()),
    [DUE_BASE + 2 * MINUTE, DUE_BASE + 3 * MINUTE],
    "each skip names its own exact due minute",
  );
  for (const skip of fx.skips) {
    assert.equal(skip.runs.length, 1, "the skip carries the active execution");
    assert.match(skip.runs[0]!.executionId, /^exec-/, "active execution handle");
    assert.equal(skip.runs[0]!.tasks.length, 1);
    assert.match(skip.runs[0]!.tasks[0]!.taskId, /^task-/, "active task handle");
  }
  assert.equal(fx.starts.length, 1, "no catch-up start while the run is active");

  // After the run settles, the next due occurrence dispatches normally.
  fx.settle();
  fx.advance(MINUTE);
  await until(() => fx.starts.length === 2, 2_000);
  assert.equal(fx.starts[1]!.dueAt.getTime(), DUE_BASE + 4 * MINUTE);
  fx.runtime.detach();
});

test("settled chains are removed from inFlight without losing same-entry serialization", async () => {
  const fx = overlapFixture();
  fx.switchState.setEnabled(true);
  fx.runtime.attach();
  await until(() => fx.runtime.running);

  // A pending chain is retained while the start is in flight.
  fx.advance(MINUTE + 5_000);
  await until(() => fx.starts.length === 1, 2_000);
  assert.deepEqual([...inFlightMap(fx.runtime).keys()], ["solo"], "the pending chain stays");

  // It self-removes once settled — no settled chains linger.
  fx.release();
  await until(() => inFlightMap(fx.runtime).size === 0, 2_000);

  // Serialization is intact: a new start holds the entry's next due.
  fx.settle();
  fx.advance(MINUTE);
  await until(() => fx.starts.length === 2, 2_000);
  assert.equal(fx.starts[1]!.dueAt.getTime(), DUE_BASE + 2 * MINUTE);
  fx.advance(MINUTE); // minute-3 due while minute-2's start is still starting
  await sleep(40);
  assert.equal(fx.starts.length, 2, "no same-entry double start after cleanup");
  assert.deepEqual([...inFlightMap(fx.runtime).keys()], ["solo"], "the new pending chain is tracked");
  fx.runtime.detach();
});

// ---------------------------------------------------------------------------
// Scheduler owner-event wording and delivery.
// ---------------------------------------------------------------------------

function localDueLabel(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const minutes = -date.getTimezoneOffset();
  const offset = `${minutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${offset} (local)`;
}

test("overlap skip events carry identity, due time, and handles without implying completion", () => {
  const entry = { name: "Nightly build", cron: "0 9 * * *", enabled: true, kind: "execute" as const, instructions: "build", workspace: "/tmp/ws" };
  const text = formatScheduledSkipEvent(
    "nightly",
    entry,
    new Date(Date.UTC(2025, 4, 5, 9, 0)),
    [
      {
        executionId: "exec-1",
        kind: "execute",
        tasks: [{ taskId: "task-7", title: "Scheduled execute task nightly: Nightly build", state: "running" }],
      },
    ],
  );
  assert.ok(text.includes("nightly"), "schedule identity");
  assert.ok(text.includes("Nightly build"));
  assert.ok(text.includes("0 9 * * *"));
  assert.ok(text.includes(localDueLabel(new Date(Date.UTC(2025, 4, 5, 9, 0)))), "exact machine-local due minute and offset");
  assert.ok(!text.includes("2025-05-05T09:00:00.000Z"), "do not display UTC as the local cron time");
  assert.ok(text.includes("exec-1") && text.includes("task-7") && text.includes("running"), "active execution and task handles");
  assert.ok(/SKIPPED/.test(text), "the skip is explicit");
  assert.ok(!/completed/i.test(text.replace(/SKIPPED[^\n]*/i, "")), "no implied completion");
});

test("overdue drop events name the entry, due time, and state no run happened", () => {
  const entry = { name: "Nightly build", cron: "0 9 * * *", enabled: true, kind: "execute" as const, instructions: "build", workspace: "/tmp/ws" };
  const text = formatScheduledOverdueDrop("nightly", entry, new Date(Date.UTC(2025, 4, 5, 9, 0)));
  assert.ok(text.includes("nightly") && text.includes("Nightly build") && text.includes("0 9 * * *"));
  assert.ok(text.includes(localDueLabel(new Date(Date.UTC(2025, 4, 5, 9, 0)))), "exact local due time");
  assert.ok(/NOT RUN/.test(text), "the drop is explicit");
  assert.ok(/no catch-up run is started/i.test(text), "no catch-up is promised");
  const withoutDropLine = text.replace(/nothing was dispatched[^\n]*/i, "");
  assert.ok(!/completed|cancelled|canceled/i.test(withoutDropLine), "no implied completion or cancellation");
});

test("dispatch failure events name the entry, due time, and exact error", () => {
  const entry = { name: "Nightly build", cron: "0 9 * * *", enabled: true, kind: "execute" as const, instructions: "build", workspace: "/tmp/ws" };
  const text = formatScheduledDispatchFailure("nightly", entry, new Date(Date.UTC(2025, 4, 5, 9, 0)), "No execute worker route is configured.");
  assert.ok(text.includes("nightly") && text.includes("0 9 * * *"));
  assert.ok(text.includes(localDueLabel(new Date(Date.UTC(2025, 4, 5, 9, 0)))));
  assert.ok(text.includes("No execute worker route is configured."));
});

test("repeated fall-back local minutes show their different offsets", (t) => {
  // Windows does not reliably apply process.env.TZ to Date local getters.
  if (process.platform === "win32") {
    t.skip("runtime TZ switching is not portable to Windows");
    return;
  }
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const entry = { name: "DST", cron: "30 1 * * *", enabled: true, kind: "execute" as const, instructions: "check", workspace: "/tmp/ws" };
    const first = formatScheduledOverdueDrop("dst", entry, new Date("2025-11-02T05:30:00Z"));
    const second = formatScheduledOverdueDrop("dst", entry, new Date("2025-11-02T06:30:00Z"));
    assert.match(first, /2025-11-02 01:30 -04:00 \(local\)/);
    assert.match(second, /2025-11-02 01:30 -05:00 \(local\)/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("deliverScheduledEvent uses the steer-now lane and reports unavailable hosts", () => {
  const sent: Array<[unknown, unknown]> = [];
  const host = {
    sendMessage(message: unknown, delivery: unknown) {
      sent.push([message, delivery]);
    },
  };
  assert.equal(deliverScheduledEvent(host, "hello"), true);
  assert.deepEqual(sent[0]?.[1], { deliverAs: "steer", triggerTurn: true });
  const message = sent[0]?.[0] as { customType: string; content: string; display: boolean };
  assert.equal(message.customType, "pi-review-scheduled-task-event");
  assert.equal(message.content, "hello");
  assert.equal(message.display, true);

  assert.equal(deliverScheduledEvent({}, "hello"), false, "hosts without sendMessage fall back to a notice");
});

test("scheduledTaskDefinition makes the scheduled origin explicit", () => {
  const entry = { name: "Nightly build", cron: "0 9 * * *", enabled: true, kind: "research" as const, instructions: "investigate X", workspace: "/tmp/ws" };
  const definition = scheduledTaskDefinition("nightly", entry);
  assert.equal(definition.title, "Scheduled research task nightly: Nightly build");
  assert.equal(definition.instructions, "investigate X");
});

// ---------------------------------------------------------------------------
// Controller-level scheduled starts: persistence, fail-closed pins, overlap view.
// ---------------------------------------------------------------------------

interface ControllerFixtureOptions {
  /** Empty global execute route: only pinned entries can run (issue #26 independence). */
  emptyExecuteRoute?: boolean;
  /** A second execute resource so a pin is observable against the global route. */
  extraExecuteResource?: boolean;
}

async function controllerFixture(options: ControllerFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-review-scheduled-controller-"));
  const executor = join(root, "executor.cjs");
  await initGitRepo(root);
  await writeFile(executor, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));",
    "});",
  ].join("\n"), "utf8");
  await chmod(executor, 0o755);
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      fake: {
        adapter: "run-as-binary",
        command: executor,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      },
      ...(options.extraExecuteResource ? {
        second: {
          adapter: "run-as-binary",
          command: executor,
          execution: { protocol: "pi-review-executor-jsonl-v1" },
        },
      } : {}),
      researcher: {
        adapter: "codex-cli",
        command: executor,
        execution: {},
      },
    },
    execution: {
      maxWorkers: 2,
      workerResources: {
        default: { selection: { source: "external", id: "fake" }, maxConcurrent: 2 },
        ...(options.extraExecuteResource ? {
          second: { selection: { source: "external", id: "second" }, maxConcurrent: 1 },
        } : {}),
        researchCapable: { selection: { source: "external", id: "researcher" }, maxConcurrent: 1 },
      },
      routes: {
        execute: options.emptyExecuteRoute
          ? []
          : options.extraExecuteResource
            ? [{ resourceId: "default" }, { resourceId: "second" }]
            : [{ resourceId: "default" }],
        research: [{ resourceId: "researchCapable" }],
      },
    },
    retainBundles: "always",
  });
  const messages: string[] = [];
  const controller = new BackgroundExecutionController({
    pi: { sendMessage: (message: { content: string }) => messages.push(message.content) },
    config,
    state: createState(),
    cwd: () => root,
  });
  return { root, controller, config, messages };
}

const definition = {
  title: "Scheduled execute task t1: Nightly build",
  instructions: "build the thing",
  acceptanceCriteria: ["The task instructions are completed as written."],
};

test("scheduled starts persist identity and overrides on the durable group", async () => {
  const fx = await controllerFixture();
  try {
    const inspection = await awaitBounded(
      fx.controller.start([definition], "execute", fx.root, {
        scheduledTaskId: "t1",
        reviewOverride: { mode: "off" },
      }),
      30_000,
      "scheduled start",
    );
    const raw = JSON.parse(await readFile(join(inspection.root, "execution.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.scheduledTaskId, "t1", "the stable entry id is durable for overlap detection across restarts");
    assert.deepEqual(raw.scheduledReviewOverride, { mode: "off" }, "the task-local review choice is frozen per run");

    // While the task is unsettled the entry has an active run.
    const runs = fx.controller.scheduledRuns("t1");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.executionId, inspection.executionId);
    assert.ok(runs[0]!.tasks.length >= 1);

    // The fake executor completes immediately; once the real lifecycle settles
    // the task, the entry has no active overlap anymore.
    const deadline = Date.now() + 30_000;
    while (fx.controller.scheduledRuns("t1").length > 0) {
      assert.ok(Date.now() < deadline, "the scheduled run settled through its ordinary lifecycle");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(fx.controller.scheduledRuns("t1"), [], "settled runs no longer count as active overlap");
  } finally {
    fx.controller.shutdown().catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("scheduled worker pins fail closed at creation", async () => {
  const fx = await controllerFixture();
  try {
    await assert.rejects(
      awaitBounded(
        fx.controller.start([definition], "execute", fx.root, { scheduledTaskId: "t1", workerResourceId: "nope" }),
        30_000,
        "unknown pin",
      ),
      /no longer exists in \/review-settings/,
    );
    await assert.rejects(
      awaitBounded(
        fx.controller.start([definition], "research", fx.root, { scheduledTaskId: "t1", workerResourceId: "default" }),
        30_000,
        "research-ineligible pin",
      ),
      /cannot run research tasks/,
    );
    // A selected-reviewer override can never take effect on a research run
    // (there is no review stage), so it fails closed instead of being ignored.
    await assert.rejects(
      awaitBounded(
        fx.controller.start([definition], "research", fx.root, {
          scheduledTaskId: "t1",
          reviewOverride: { mode: "selected", reviewers: [{ source: "pi", model: "some-model" }] },
        }),
        30_000,
        "selected review override on research",
      ),
      /no review stage/,
    );
    // A rejected start leaves no group behind.
    assert.deepEqual(fx.controller.scheduledRuns("t1"), []);
  } finally {
    fx.controller.shutdown().catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("a pinned scheduled execute entry runs even when the global execute route is empty", async () => {
  const fx = await controllerFixture({ emptyExecuteRoute: true });
  try {
    // The pin resolves against the worker catalog alone; start() must not
    // require global-route membership, and the wave's executor-pool guard
    // must see the derived single-entry route instead of the empty global one.
    const inspection = await awaitBounded(
      fx.controller.start([definition], "execute", fx.root, {
        scheduledTaskId: "t1",
        workerResourceId: "default",
      }),
      30_000,
      "pinned start with an empty global execute route",
    );

    const deadline = Date.now() + 30_000;
    while (fx.controller.scheduledRuns("t1").length > 0) {
      assert.ok(Date.now() < deadline, "the pinned run settled through its ordinary lifecycle");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      !fx.messages.some((message) => message.includes("executor pool entry")),
      "no wave-guard failure: the derived route carried the pin into the wave",
    );
  } finally {
    fx.controller.shutdown().catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("a pinned group's derived config carries only the pin in its role route", async () => {
  const fx = await controllerFixture({ extraExecuteResource: true });
  try {
    const inspection = await awaitBounded(
      fx.controller.start([definition], "execute", fx.root, {
        scheduledTaskId: "t1",
        workerResourceId: "second",
      }),
      30_000,
      "pinned start with a non-empty global route",
    );
    const group = controllerInternals(fx.controller).groups.get(inspection.executionId)!;
    const derived = (fx.controller as unknown as {
      groupConfig(group: BackgroundExecutionGroup): ReviewGateConfig;
    }).groupConfig(group);

    // The wave guard and failover both read this route: it contains exactly
    // the pin, never the global route's other members.
    assert.deepEqual(derived.execution?.routes?.execute, [{ resourceId: "second" }]);
    // Review inheritance is untouched for a pinned group without an override.
    assert.deepEqual(derived.review, fx.config.review);
    // The shared base config is never mutated by the derivation (normalized
    // route entries carry an explicit undefined thinkingLevel).
    assert.deepEqual(fx.config.execution?.routes?.execute, [
      { resourceId: "default", thinkingLevel: undefined },
      { resourceId: "second", thinkingLevel: undefined },
    ]);

    const deadline = Date.now() + 30_000;
    while (fx.controller.scheduledRuns("t1").length > 0) {
      assert.ok(Date.now() < deadline, "the pinned run settled");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    fx.controller.shutdown().catch(() => undefined);
    await rm(fx.root, { recursive: true, force: true });
  }
});
