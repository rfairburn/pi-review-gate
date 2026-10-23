/**
 * Focused control for the Saved Main runner's parent release handshake.
 *
 * The owned outer Main runner keeps the owner alive after the real
 * `runSessionHost` return and its terminal-restoration record until the parent
 * writes an explicit release request, and the parent still requires the actual
 * public `onExit` of that exact outer PTY. The runner examined that durable
 * request only through the `fs.watch` notification path - once at startup, once
 * when the wait began, then on each event - so a lost or coalesced notification
 * could leave an already-written, fully validated release unseen and strand the
 * owner until the parent's unchanged outer-exit deadline expired.
 * `startParentControl` now also re-examines the actual validated release on the
 * same bounded cadence the harness durable-readiness waits use, while
 * `fs.watch` stays the fast path.
 *
 * Every control below calls the real fixture function over a real control file
 * written atomically exactly the way `SavedMainDriver` writes it, on `node:test`
 * mock timers, so no control waits on wall-clock time and none needs a 30 s
 * mutant batch. A "no notification" control simply never invokes the watcher
 * callback, which is exactly the missed/coalesced-event condition; the
 * notification controls invoke it and then assert that no timer ever fired.
 * The negative half is asserted in the same virtual clock: an absent, empty,
 * malformed, oversized, linked, unknown-action, or stale request never resolves
 * the wait, elapsed virtual time never releases, a pending `force` request is
 * never consumed or replayed by the periodic read, and dispose closes the watcher
 * and clears the pending re-arm so no handle outlives the wait. The fallback
 * recovers only a *silently* missed notification: an explicit watcher failure is
 * not clean proof, so it stays fail-closed - sticky failure accounting, no
 * release accepted over either observation path, and a live ref'd handle that
 * keeps the owner from exiting zero before the parent's failure path settles it.
 * A validated release only resolves the existing wait - it is not exit authority:
 * the runner still exits naturally with its own status, which the real native lane
 * asserts.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

const requireFromCheckout = createRequire(__filename);
/** The same builtin module instance the fixture captured, so this patch is visible to it. */
const fsRecord = requireFromCheckout("node:fs") as unknown as Record<string, unknown>;
/**
 * The exact shipped runner module the real driver spawns
 * (`process.cwd()/tests/fixtures/session-host-saved-main-runner.cjs`), not a
 * reimplementation of its release logic.
 */
const savedMainRunner = requireFromCheckout(join(process.cwd(), "tests", "fixtures", "session-host-saved-main-runner.cjs")) as {
  startParentControl(controlPath: string, journalPath: string, observation: PtyObservation): ParentControl;
};

interface ParentControl {
  waitForRelease(): Promise<void>;
  dispose(): void;
}

interface PtyObservation {
  noteObservationFailure(): void;
  forceExactReceipt(receipt: number, requestId: number): void;
}

const CONTROL_BASENAME = "saved-main-control.json";
const JOURNAL_BASENAME = "saved-main-pty-journal.jsonl";
/** Generous against the fixture's bounded cadence, tiny against the 30 s parent deadline. */
const OBSERVATION_BOUND_MS = 500;
/** Well past the parent's unchanged 30 s release deadline, in virtual time. */
const OWNER_RETENTION_BOUND_MS = 45_000;
const CLOCK_STEP_MS = 5;

/**
 * Virtual clock only: the fixture's re-arm is a `setTimeout` and its fail-closed
 * retention is a ref'd `setInterval`, so both are mocked and nothing waits on or
 * holds real time. Without the interval mock the retention handle would keep this
 * test process alive, which is exactly the retention the control asserts.
 */
function enableMockClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
}

/** Let a timer callback's promise settlement run before asserting its state. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

interface TrackedTimer {
  kind: "timeout" | "interval";
  handle: unknown;
  cleared: boolean;
  fired: boolean;
  unrefed: boolean;
}

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;

/**
 * Instrument the fixture's scheduling without changing it: every timer it creates
 * is observed for kind, `unref` (a waiting owner must not hold a ref handle),
 * firing, and clearing, so both the cleanup of a healthy wait and the deliberate
 * retention of a failed one are exact assertions instead of leak guesses.
 */
function trackTimers(t: TestContext): TrackedTimer[] {
  const tracked: TrackedTimer[] = [];
  const markCleared = (value: unknown) => {
    const entry = tracked.find((candidate) => candidate.handle === value);
    if (entry) entry.cleared = true;
  };
  const wrap = (kind: TrackedTimer["kind"], current: (...args: unknown[]) => unknown) =>
    ((callback: (...args: unknown[]) => void, delayMs?: number, ...args: unknown[]) => {
      const record: TrackedTimer = { kind, handle: undefined, cleared: false, fired: false, unrefed: false };
      tracked.push(record);
      const timer = current((...timerArgs: unknown[]) => {
        record.fired = true;
        callback(...timerArgs);
      }, delayMs, ...args) as unknown as { unref?: () => unknown };
      record.handle = timer;
      if (timer && typeof timer.unref === "function") {
        const originalUnref = timer.unref.bind(timer);
        timer.unref = () => {
          record.unrefed = true;
          return originalUnref();
        };
      }
      return timer;
    }) as unknown as (...args: unknown[]) => unknown;
  const currentSetTimeout = globalThis.setTimeout as unknown as (...args: unknown[]) => unknown;
  const currentSetInterval = globalThis.setInterval as unknown as (...args: unknown[]) => unknown;
  const currentClearTimeout = globalThis.clearTimeout as unknown as (value: unknown) => void;
  const currentClearInterval = globalThis.clearInterval as unknown as (value: unknown) => void;
  globalThis.setTimeout = wrap("timeout", currentSetTimeout) as typeof setTimeout;
  globalThis.clearTimeout = ((value: unknown) => {
    markCleared(value);
    currentClearTimeout(value);
  }) as typeof clearTimeout;
  globalThis.setInterval = wrap("interval", currentSetInterval) as typeof setInterval;
  globalThis.clearInterval = ((value: unknown) => {
    markCleared(value);
    currentClearInterval(value);
  }) as typeof clearInterval;
  // Restore the untouched builtins; `t.mock` resets the mocked timers themselves,
  // so this only removes this control's instrumentation layer.
  t.after(() => {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
    globalThis.setInterval = nativeSetInterval;
    globalThis.clearInterval = nativeClearInterval;
  });
  return tracked;
}

/** Timeouts the fixture scheduled that neither fired nor were cleared: live handles. */
function liveTimers(tracked: readonly TrackedTimer[]): number {
  return tracked.filter((entry) => entry.kind === "timeout" && !entry.fired && !entry.cleared).length;
}

/** Live ref'd intervals: the deliberate fail-closed owner retention, never a leak. */
function retentionHandles(tracked: readonly TrackedTimer[]): number {
  return tracked.filter((entry) => entry.kind === "interval" && !entry.unrefed && !entry.cleared).length;
}

/** A watcher that only delivers what a control explicitly emits: nothing arrives on its own. */
class FakeWatcher {
  closeCount = 0;
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return this;
  }

  close(): void {
    this.closeCount += 1;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
  }
}

interface ControlFixture {
  root: string;
  controlPath: string;
  journalPath: string;
  watcher: FakeWatcher;
  watchDirs: string[];
  observation: PtyObservation & { failures: number; forces: Array<{ receipt: number; requestId: number }> };
}

/** One owned control directory plus the real empty control/journal leaves the driver creates. */
function createControlFixture(t: TestContext, label: string): ControlFixture {
  const parent = join(process.cwd(), "node_modules", ".saved-main-parent-control");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, `${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controlPath = join(root, CONTROL_BASENAME);
  const journalPath = join(root, JOURNAL_BASENAME);
  writeFileSync(controlPath, "", { flag: "wx", mode: 0o600 });
  writeFileSync(journalPath, "", { flag: "wx", mode: 0o600 });
  const observation = {
    failures: 0,
    forces: [] as Array<{ receipt: number; requestId: number }>,
    noteObservationFailure(): void {
      observation.failures += 1;
    },
    forceExactReceipt(receipt: number, requestId: number): void {
      observation.forces.push({ receipt, requestId });
    },
  };
  const watcher = new FakeWatcher();
  const watchDirs: string[] = [];
  const originalWatch = fsRecord.watch;
  fsRecord.watch = (directory: unknown, listener?: unknown) => {
    watchDirs.push(String(directory));
    // `fs.watch(dir, listener)` delivers change events to that listener; the
    // fake delivers only what a control explicitly emits, which is exactly the
    // missed/coalesced-event condition when nothing is emitted.
    if (typeof listener === "function") watcher.on("change", listener as (...args: unknown[]) => void);
    return watcher;
  };
  t.after(() => {
    fsRecord.watch = originalWatch;
  });
  return { root, controlPath, journalPath, watcher, watchDirs, observation };
}

/** Exactly the driver's publication: a fresh temp leaf renamed onto the control path. */
function publishControl(fixture: ControlFixture, requestId: number, request: Record<string, unknown>): void {
  const tempPath = join(dirname(fixture.controlPath), `saved-main-control-${requestId}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(request)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(tempPath, fixture.controlPath);
}

function publishRelease(fixture: ControlFixture, requestId: number): void {
  publishControl(fixture, requestId, { requestId, action: "release" });
}

function publishForce(fixture: ControlFixture, requestId: number, receipts: unknown[]): void {
  publishControl(fixture, requestId, { requestId, action: "force", receipts });
}

/** One real directory-watch event for the control leaf, exactly as `fs.watch` delivers it. */
function notifyControl(fixture: ControlFixture): void {
  fixture.watcher.emit("change", "change", basename(fixture.controlPath));
}

interface PendingWait {
  settled(): boolean;
  resolutions(): number;
}

/** Begin the real wait without awaiting it, so a never-resolving wait can never hang a control. */
function beginWait(control: ParentControl): PendingWait {
  let done = false;
  let resolutions = 0;
  const waiter = control.waitForRelease().then(() => {
    resolutions += 1;
    done = true;
  });
  waiter.catch(() => undefined);
  return { settled: () => done, resolutions: () => resolutions };
}

/** Advance virtual time in small steps and stop as soon as the wait settles. */
async function advanceUntilSettled(t: TestContext, wait: PendingWait, boundMs: number): Promise<number> {
  let elapsed = 0;
  while (!wait.settled() && elapsed < boundMs) {
    t.mock.timers.tick(CLOCK_STEP_MS);
    await flushMicrotasks();
    elapsed += CLOCK_STEP_MS;
  }
  return elapsed;
}

function journalRecords(journalPath: string): Array<Record<string, unknown>> {
  return readFileSync(journalPath, "utf8").split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("the fixture exposes only the parent-control loop when required as a module", () => {
  assert.deepEqual(Object.keys(savedMainRunner), ["startParentControl"],
    "requiring the shipped runner exposes the actual release loop and nothing else");
  assert.equal(typeof savedMainRunner.startParentControl, "function");
});

test("importing the shipped runner module never starts Main", () => {
  const script = `const loaded = require(${JSON.stringify(join(process.cwd(), "tests", "fixtures", "session-host-saved-main-runner.cjs"))});
process.stdout.write(JSON.stringify(Object.keys(loaded)));`;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(child.error, undefined, `the import-only child run completed: ${String(child.error)}`);
  assert.equal(child.status, 0, "importing the module settles on its own; only the Node entrypoint runs Main");
  assert.equal(child.stdout, '["startParentControl"]');
});

test("a validated release written after the wait begins is observed with no watcher notification", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "durable-release");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  assert.deepEqual(fixture.watchDirs, [dirname(fixture.controlPath)],
    "the fs.watch fast path is still installed on the control directory");

  const wait = beginWait(control);
  await flushMicrotasks();
  assert.equal(wait.settled(), false, "no release exists yet, so the owner stays retained");

  publishRelease(fixture, 1);
  const elapsed = await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
  assert.equal(wait.settled(), true,
    "an explicit validated release must be observed by the bounded durable re-examination even though no fs.watch notification ever arrived");
  assert.ok(elapsed <= OBSERVATION_BOUND_MS, "the bounded re-examination stays far inside the unchanged parent deadline");
  assert.deepEqual(fixture.observation.forces, [], "a release observation never invokes force");
  assert.equal(fixture.observation.failures, 0, "observing a durable release is not an observation failure");
  assert.equal(readFileSync(fixture.journalPath, "utf8"), "", "the release path fabricates no journal history");
  assert.equal(wait.resolutions(), 1, "the release resolves the one existing wait exactly once");
  assert.ok(tracked.length > 0, "the wait scheduled its bounded re-examination");
  assert.ok(tracked.every((entry) => entry.unrefed), "a waiting owner never holds a ref handle");

  control.dispose();
  assert.equal(fixture.watcher.closeCount, 1, "dispose closes the watcher");
  assert.equal(liveTimers(tracked), 0, "no scheduled re-arm outlives dispose");
});

test("the release already durable before the wait begins still resolves without any notification or tick", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "startup-poll");
  publishRelease(fixture, 1);
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  const wait = beginWait(control);
  await flushMicrotasks();
  assert.equal(wait.settled(), true, "the unchanged startup and wait-entry polls still observe a durable release");
  assert.equal(tracked.filter((entry) => entry.fired).length, 0, "no re-arm is needed once the release is durable");
  control.dispose();
  assert.equal(liveTimers(tracked), 0);
});

test("the watcher notification remains the fast path ahead of any cadence tick", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "notify-fast");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  const wait = beginWait(control);
  await flushMicrotasks();
  assert.equal(wait.settled(), false);

  publishRelease(fixture, 4);
  notifyControl(fixture);
  await flushMicrotasks();
  assert.equal(wait.settled(), true, "the notification path releases immediately");
  assert.equal(tracked.filter((entry) => entry.fired).length, 0,
    "the notification arrived before a single cadence interval elapsed, so no timer had to re-read");
  control.dispose();
  assert.equal(fixture.watcher.closeCount, 1);
  assert.equal(liveTimers(tracked), 0, "dispose clears the pending re-arm");
});

test("no release request never resolves the wait, however long the owner is retained", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "never-released");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  const wait = beginWait(control);
  await flushMicrotasks();

  let elapsed = 0;
  while (elapsed < OWNER_RETENTION_BOUND_MS) {
    t.mock.timers.tick(CLOCK_STEP_MS);
    await flushMicrotasks();
    elapsed += CLOCK_STEP_MS;
  }
  assert.equal(wait.settled(), false,
    "elapsed time and mere file presence grant no exit authority: the owner stays retained fail-closed");
  assert.deepEqual(fixture.observation.forces, []);
  assert.equal(fixture.observation.failures, 0);
  assert.ok(tracked.filter((entry) => entry.kind === "timeout").every((entry) => entry.unrefed),
    "the unbounded retention never holds a ref handle");
  assert.equal(retentionHandles(tracked), 0, "a silent miss never creates a retention handle; only an explicit failure does");
  control.dispose();
  assert.equal(liveTimers(tracked), 0);
});

test("an absent, empty, malformed, oversized, linked, or stale request is never treated as a release", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const oversized = { requestId: 1, action: "release", pad: "x".repeat(17 * 1024) };
  const cases: Array<{ readonly label: string; readonly write: (fixture: ControlFixture) => void }> = [
    { label: "empty leaf", write: () => undefined },
    { label: "whitespace only", write: (fixture) => writeFileSync(fixture.controlPath, "   \n") },
    { label: "truncated JSON", write: (fixture) => writeFileSync(fixture.controlPath, '{"requestId":1,"action":"rel') },
    { label: "JSON array", write: (fixture) => writeFileSync(fixture.controlPath, '[{"requestId":1,"action":"release"}]\n') },
    { label: "JSON null", write: (fixture) => writeFileSync(fixture.controlPath, "null\n") },
    { label: "release without a request id", write: (fixture) => publishControl(fixture, 0, { action: "release" }) },
    { label: "zero request id", write: (fixture) => publishControl(fixture, 0, { requestId: 0, action: "release" }) },
    { label: "string request id", write: (fixture) => publishControl(fixture, 0, { requestId: "1", action: "release" }) },
    { label: "fractional request id", write: (fixture) => publishControl(fixture, 0, { requestId: 1.5, action: "release" }) },
    { label: "unsafe request id", write: (fixture) => publishControl(fixture, 0, { requestId: Number.MAX_SAFE_INTEGER + 1, action: "release" }) },
    { label: "unknown action", write: (fixture) => publishControl(fixture, 1, { requestId: 1, action: "approve" }) },
    { label: "release without an action", write: (fixture) => publishControl(fixture, 1, { requestId: 1 }) },
    { label: "oversized leaf", write: (fixture) => writeFileSync(fixture.controlPath, `${JSON.stringify(oversized)}\n`) },
    { label: "linked control leaf", write: (fixture) => {
      const target = join(fixture.root, "linked-target.json");
      writeFileSync(target, `${JSON.stringify({ requestId: 1, action: "release" })}\n`, { mode: 0o600 });
      rmSync(fixture.controlPath);
      symlinkSync(target, fixture.controlPath);
    } },
  ];

  for (const [index, testCase] of cases.entries()) {
    const fixture = createControlFixture(t, `held-${index}`);
    const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
    const wait = beginWait(control);
    await flushMicrotasks();
    testCase.write(fixture);
    // Both observation paths are held for the same content: the notification
    // path and a full bounded re-examination window.
    notifyControl(fixture);
    await flushMicrotasks();
    assert.equal(wait.settled(), false, `${testCase.label}: the notification path grants no release`);
    const elapsed = await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
    assert.equal(wait.settled(), false,
      `${testCase.label}: an invalid or stale request must stay held, not become an implicit release`);
    assert.ok(elapsed >= OBSERVATION_BOUND_MS, `${testCase.label}: the whole window was examined`);
    control.dispose();
  }

  // A stale id behind a consumed force request is held as well, and holding it
  // must not have consumed the force accounting for the watch path.
  const fixture = createControlFixture(t, "stale-id");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  const wait = beginWait(control);
  publishForce(fixture, 5, [7]);
  notifyControl(fixture);
  await flushMicrotasks();
  assert.deepEqual(fixture.observation.forces, [{ receipt: 7, requestId: 5 }]);
  publishRelease(fixture, 4);
  await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
  assert.equal(wait.settled(), false, "a request id at or behind the consumed watermark is stale");
  assert.deepEqual(fixture.observation.forces, [{ receipt: 7, requestId: 5 }], "holding a stale release never replays force");
  control.dispose();

  assert.equal(tracked.filter((entry) => entry.kind === "timeout").every((entry) => entry.unrefed), true,
    "every re-arm in every case was unref'd");
  assert.equal(retentionHandles(tracked), 0, "none of these cases failed the observation channel");
  assert.equal(liveTimers(tracked), 0, "every case disposed its watcher and re-arm");
});

test("the periodic re-examination never consumes or replays a pending force request", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "force-authority");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  const wait = beginWait(control);
  await flushMicrotasks();

  publishForce(fixture, 5, [1, 2]);
  let elapsed = await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
  assert.equal(wait.settled(), false, "a force request is not a release");
  assert.ok(elapsed >= OBSERVATION_BOUND_MS);
  assert.deepEqual(fixture.observation.forces, [],
    "the periodic read observes release authority only: an unnotified force request keeps its exact watch-path accounting");

  notifyControl(fixture);
  await flushMicrotasks();
  assert.deepEqual(fixture.observation.forces, [{ receipt: 1, requestId: 5 }, { receipt: 2, requestId: 5 }],
    "the watch path still addresses the exact receipts of the exact request id");

  // The same durable force leaf re-examined for another full window must not
  // fire a second time, and the later release must still be the only release.
  elapsed = await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
  assert.equal(wait.settled(), false);
  assert.deepEqual(fixture.observation.forces, [{ receipt: 1, requestId: 5 }, { receipt: 2, requestId: 5 }],
    "the recheck never replays an already-consumed force request id");

  publishRelease(fixture, 6);
  elapsed = await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
  assert.equal(wait.settled(), true, "the higher validated release is observed with no notification");
  assert.ok(elapsed < OBSERVATION_BOUND_MS);
  assert.deepEqual(fixture.observation.forces, [{ receipt: 1, requestId: 5 }, { receipt: 2, requestId: 5 }]);
  control.dispose();
  assert.equal(liveTimers(tracked), 0);
});

test("force request shapes keep their unchanged watch-path validation and idempotence", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "force-shapes");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  const wait = beginWait(control);
  await flushMicrotasks();

  const rejected: Array<Record<string, unknown>> = [
    { requestId: 1, action: "force" },
    { requestId: 2, action: "force", receipts: [] },
    { requestId: 3, action: "force", receipts: [0] },
    { requestId: 4, action: "force", receipts: [1.5] },
    { requestId: 5, action: "force", receipts: "6" },
    { requestId: 6, action: "force", receipts: Array.from({ length: 129 }, (_value, position) => position + 1) },
  ];
  for (const request of rejected) {
    publishControl(fixture, request.requestId as number, request);
    notifyControl(fixture);
    await flushMicrotasks();
    assert.deepEqual(fixture.observation.forces, [], `rejected shape ${JSON.stringify(Object.keys(request))} invokes no kill`);
    assert.equal(wait.settled(), false);
  }

  publishControl(fixture, 7, { requestId: 7, action: "force", receipts: [3, 3, 4] });
  notifyControl(fixture);
  await flushMicrotasks();
  assert.deepEqual(fixture.observation.forces, [{ receipt: 3, requestId: 7 }, { receipt: 4, requestId: 7 }],
    "exact receipts are deduplicated and addressed once per request");

  notifyControl(fixture);
  await flushMicrotasks();
  assert.deepEqual(fixture.observation.forces, [{ receipt: 3, requestId: 7 }, { receipt: 4, requestId: 7 }],
    "a repeated notification for the same request id is idempotent");

  // Rejected shapes must not have advanced the watermark: this release reuses
  // request id 7 semantics by being strictly higher than the consumed 7.
  publishRelease(fixture, 8);
  const elapsed = await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
  assert.equal(wait.settled(), true, "a validated release above the watermark is accepted with no notification");
  assert.ok(elapsed < OBSERVATION_BOUND_MS);
  control.dispose();
  assert.equal(liveTimers(tracked), 0);
});

test("an explicit watcher failure while waiting fails closed and is never rewritten into a release", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "watch-error-waiting");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  const wait = beginWait(control);
  await flushMicrotasks();

  fixture.watcher.emit("error", new Error("controlled owned watcher failure"));
  await flushMicrotasks();
  assert.equal(fixture.observation.failures, 1, "the observation failure is still reported to the runner owner");
  assert.deepEqual(journalRecords(fixture.journalPath), [{ type: "pty_observation_failed", operation: "parent-control-watch" }],
    "the failure stays recorded in the durable journal instead of being cleaned up");
  assert.equal(wait.settled(), false, "a broken observation channel grants no exit authority");
  assert.equal(retentionHandles(tracked), 1,
    "the failed owner stays retained on a live ref'd handle instead of closing every handle and exiting zero");

  let elapsed = 0;
  while (elapsed < OWNER_RETENTION_BOUND_MS) {
    t.mock.timers.tick(CLOCK_STEP_MS);
    await flushMicrotasks();
    elapsed += CLOCK_STEP_MS;
  }
  assert.equal(wait.settled(), false, "a failed channel retains the owner indefinitely, exactly as before");
  assert.deepEqual(fixture.observation.forces, []);

  // A silent missed notification is what the bounded re-examination recovers. An
  // explicit failure is not that condition, so neither observation path may accept
  // a release afterwards - not even a fully valid one that would otherwise prove
  // nothing about the broken channel.
  publishRelease(fixture, 1);
  notifyControl(fixture);
  await flushMicrotasks();
  assert.equal(wait.settled(), false, "a valid release over the failed channel still grants no exit authority");
  elapsed = await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
  assert.equal(wait.settled(), false, "the durable re-examination stays stopped after an explicit failure");
  assert.equal(fixture.observation.failures, 1, "retention does not multiply failure accounting");
  assert.deepEqual(journalRecords(fixture.journalPath), [{ type: "pty_observation_failed", operation: "parent-control-watch" }],
    "the recorded failure survives the release attempt so no clean history is fabricated");
  assert.deepEqual(fixture.observation.forces, [], "the failure path invents no force authority");

  fixture.watcher.emit("error", new Error("second controlled owned watcher failure"));
  await flushMicrotasks();
  assert.equal(fixture.observation.failures, 2, "every failure is accounted for");
  assert.equal(retentionHandles(tracked), 1, "one retained owner keeps exactly one retention handle");

  control.dispose();
  assert.equal(fixture.watcher.closeCount, 1, "the watcher is still closed");
  assert.equal(wait.settled(), false, "dispose never turns a failed observation into a release");
  assert.equal(retentionHandles(tracked), 1,
    "dispose leaves the fail-closed retention running for the parent's failure path to settle");
});

test("a watcher failure before the wait begins keeps even a durable release unseen", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "watch-error-before-wait");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  fixture.watcher.emit("error", new Error("controlled failure before the wait"));
  await flushMicrotasks();
  assert.equal(fixture.observation.failures, 1);
  assert.equal(retentionHandles(tracked), 1, "the owner is retained from the moment the channel fails");

  publishRelease(fixture, 1);
  const wait = beginWait(control);
  await flushMicrotasks();
  assert.equal(wait.settled(), false, "the wait-entry poll grants no release after a failed observation");
  const elapsed = await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
  assert.equal(wait.settled(), false, "no re-examination is scheduled for an owner whose observation failed");
  assert.ok(elapsed >= OBSERVATION_BOUND_MS);
  assert.equal(tracked.filter((entry) => entry.kind === "timeout").length, 0,
    "a failed observation schedules no fallback read at all");
  assert.equal(fixture.observation.failures, 1);
  control.dispose();
});

test("repeated validated releases are idempotent and stop the re-arm", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "idempotent");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  const wait = beginWait(control);
  await flushMicrotasks();

  publishRelease(fixture, 9);
  const elapsed = await advanceUntilSettled(t, wait, OBSERVATION_BOUND_MS);
  assert.equal(wait.settled(), true);
  assert.ok(elapsed < OBSERVATION_BOUND_MS);
  const scheduledAtRelease = tracked.length;

  publishRelease(fixture, 10);
  for (let turn = 0; turn < 40; turn += 1) {
    t.mock.timers.tick(CLOCK_STEP_MS);
    await flushMicrotasks();
  }
  assert.equal(wait.resolutions(), 1, "the settled wait resolves once and never again");
  assert.equal(tracked.length, scheduledAtRelease, "the re-arm stops once the release is observed");
  assert.deepEqual(fixture.observation.forces, []);
  assert.equal(readFileSync(fixture.journalPath, "utf8"), "");

  control.dispose();
  assert.equal(fixture.watcher.closeCount, 1, "dispose closes the watcher once");
  assert.equal(liveTimers(tracked), 0, "no timer handle outlives the released owner");
});

test("dispose closes the watcher and clears the pending re-arm so nothing observes later content", async (t) => {
  enableMockClock(t);
  const tracked = trackTimers(t);
  const fixture = createControlFixture(t, "dispose");
  const control = savedMainRunner.startParentControl(fixture.controlPath, fixture.journalPath, fixture.observation);
  const wait = beginWait(control);
  t.mock.timers.tick(CLOCK_STEP_MS);
  await flushMicrotasks();
  assert.equal(wait.settled(), false);
  assert.ok(tracked.length > 0, "the wait scheduled its re-examination");

  control.dispose();
  assert.equal(fixture.watcher.closeCount, 1, "the watcher is closed");
  assert.equal(liveTimers(tracked), 0, "the pending re-arm is cleared rather than left to fire");

  publishRelease(fixture, 1);
  for (let turn = 0; turn < 200; turn += 1) {
    t.mock.timers.tick(CLOCK_STEP_MS);
    await flushMicrotasks();
  }
  assert.equal(wait.settled(), false, "a disposed control observes nothing further, valid content included");
  assert.deepEqual(fixture.observation.forces, []);
});
