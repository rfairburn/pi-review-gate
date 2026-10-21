/**
 * Focused regression control for the shared durable-readiness signal.
 *
 * The real-host harnesses wait for durable readiness - an appended JSONL record
 * or a leaf an owned job creates - whose only live trigger is an `fs.watch`
 * notification. A missed or coalesced watcher event used to leave an
 * already-durable fact unexamined until the (correct) deadline rejected the
 * wait. `ChangeSignal.waitForRecheck` and `waitForDurableReadyLeaf` keep the
 * same absolute deadline, the same cancellation and predicate-exception
 * semantics, and keep `notify()` as the fast path, while adding a bounded
 * periodic re-evaluation and one final re-evaluation at the deadline.
 *
 * The controls cover the one shared core every adapter reuses (the Windows
 * harness and both launchers, and the public-Main harness through
 * `MainPtyDriver.waitForRecords`) plus the owned-job readiness-leaf helper path,
 * and the Saved/Resume acceptance family through the real `SavedMainDriver`
 * observer, PTY-journal and runner-result waits and its exported JSONL wrapper,
 * by calling the real adapter entry points with a real task-created file. Every
 * control runs on `node:test` mock timers with explicit state changes only.
 * Virtual time makes the recheck cadence, the single absolute deadline, and the
 * absence of post-settlement activity exact assertions instead of wall-clock or
 * scheduler observations, and nothing depends on actual `fs` event delivery: a
 * "no notification" control is exactly the missed/coalesced-event condition. In
 * each of them the notification-only wait (the pre-change path) is exercised
 * with the same predicate and the same bound, so the regression is demonstrated
 * rather than assumed, and a pending predicate still fails at the unchanged
 * deadline: re-evaluation never fabricates readiness.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  ChangeSignal,
  DURABLE_JOURNAL_RECHECK_INTERVAL_MS,
  waitForDurableReadyLeaf,
} from "./helpers/change-signal";
import { ChangeSignal as WindowsHarnessChangeSignal } from "./helpers/session-host-native-windows-harness";
import {
  EVENT_TIMEOUT_MS,
  ChangeSignal as MainHarnessChangeSignal,
  MainPtyDriver,
  type SessionRecord,
} from "./helpers/session-host-native-main-harness";
import { SavedMainDriver, readOwnedJsonl, waitForJsonl } from "./helpers/session-host-native-saved-main-harness";

const WORKSPACE = "/owned/temporary/workspace";
/** The driver's own captured frame text, used only by its failure diagnostic. */
const CONTROLLED_MAIN_FRAME = "PRG-CONTROLLED-MAIN-FRAME\nsecond owned Main row";

interface JournalRecord {
  readonly type: string;
  readonly pid: number;
  readonly cwd: string;
  readonly sessionId: string;
  readonly tty: boolean;
  readonly columns: number;
  readonly rows: number;
}

/** Virtual clock and timers: no control below waits on real time. */
function enableMockClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
}

/** Let timer callbacks' promise settlements run before asserting their state. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

/** Fresh ignored fixture root inside the checkout; never captured by Git. */
function createOwnedFixtureRoot(): string {
  const parent = join(process.cwd(), "node_modules", ".journal-signal");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, "r-"));
}

function ownedJournal(t: TestContext, name = "native-main.jsonl"): string {
  const root = createOwnedFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, name);
  writeFileSync(journal, "");
  return journal;
}

function appendReadyRecord(journal: string): void {
  const record: JournalRecord = {
    type: "session_start",
    pid: 49_736,
    cwd: WORKSPACE,
    sessionId: "87x49",
    tty: true,
    columns: 87,
    rows: 49,
  };
  appendFileSync(journal, `${JSON.stringify(record)}\n`);
}

/** The real readiness shape: one complete durable record for the owned workspace. */
function journalReady(journal: string): boolean {
  const text = readFileSync(journal, "utf8");
  return text.split("\n").filter((line) => line.length > 0).some((line) => {
    const record = JSON.parse(line) as JournalRecord;
    return record.type === "session_start" && record.cwd === WORKSPACE
      && typeof record.sessionId === "string" && record.sessionId.length > 0
      && record.tty === true;
  });
}

/** One owned service directory for the readiness-leaf helper controls. */
function ownedServiceDir(t: TestContext, name: string): string {
  const root = createOwnedFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const serviceDir = join(root, name);
  mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
  return serviceDir;
}

/**
 * The public-Main harness's own journal readiness predicate shape, unchanged:
 * a real `session_start` record for the owned workspace with its observed
 * metadata. Nothing here reads a screen or a cache.
 */
function mainSessionStartReady(records: SessionRecord[]): boolean {
  return records.some((record) => record.type === "session_start"
    && record.cwd === WORKSPACE
    && typeof record.sessionId === "string" && record.sessionId.length > 0
    && typeof record.displayName === "string");
}

function appendMainSessionStart(journal: string): void {
  const record: SessionRecord = {
    type: "session_start",
    pid: 49_736,
    cwd: WORKSPACE,
    sessionId: "87x49",
    displayName: "(no messages)",
    tty: true,
    columns: 87,
    rows: 49,
  };
  appendFileSync(journal, `${JSON.stringify(record)}\n`);
}

/**
 * Bind the real `MainPtyDriver.waitForRecords` to the state that method actually
 * reads. A real driver needs an owned PTY, so - exactly as
 * `tests/session-host-native-main.test.ts` binds other prototype methods - this
 * attaches a live shared `ChangeSignal`, a real task-created observer journal
 * read by the driver's own `records()`, and the driver's own captured frame text
 * for its failure diagnostic. No production state is synthesized and no screen
 * content is invented: the only journal content is what these controls append.
 */
function mainJournalDriver(journal: string): MainPtyDriver {
  const driver = Object.create(MainPtyDriver.prototype) as MainPtyDriver;
  Object.assign(driver, {
    journalSignal: new ChangeSignal(),
    observerFile: journal,
    currentFrame: CONTROLLED_MAIN_FRAME,
    parserError: undefined,
    exitEvent: undefined,
    frameRevision: 1,
  });
  return driver;
}

/** The message of a rejected promise, or "" when it resolved. */
async function rejectionMessage(waiter: Promise<unknown>): Promise<string> {
  return await waiter.then(() => "", (error: unknown) => (error instanceof Error ? error.message : String(error)));
}

/**
 * The Saved/Resume acceptance family's own durable-file waits, bound to the state
 * those methods actually read: the real `SavedMainDriver` prototype methods over
 * real task-created JSONL files read by the driver's own `records()`,
 * `ptyRecords()`, and runner-result reader, with a live shared `ChangeSignal` per
 * channel. A real driver needs an owned PTY and staged candidate, so - exactly as
 * the Main controls above bind prototype methods - nothing is invented here: the
 * only journal content is what these controls append, and no watcher callback is
 * ever invoked, which is precisely the missed/coalesced-event condition.
 */
type SavedMainAdapter = {
  journalSignal: ChangeSignal;
  ptySignal: ChangeSignal;
  observerFile: string;
  ptyJournalFile: string;
  resultFile: string;
  records(): Record<string, unknown>[];
  ptyRecords(): Record<string, unknown>[];
  waitForRecords(predicate: (records: Record<string, unknown>[]) => boolean, description: string,
    afterOffset?: number, timeoutMs?: number): Promise<Record<string, unknown>[]>;
  waitForPtyRecords(predicate: (records: Record<string, unknown>[]) => boolean, description: string,
    afterOffset?: number, timeoutMs?: number): Promise<Record<string, unknown>[]>;
  waitForRunnerResult(timeoutMs?: number): Promise<Record<string, unknown>>;
};

const SAVED_PID = 47_120;
const SAVED_SESSION = "019f0000-0000-7000-8000-000000000002";

function savedMainAdapter(t: TestContext): SavedMainAdapter {
  const root = createOwnedFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = Object.create(SavedMainDriver.prototype) as SavedMainAdapter;
  Object.assign(adapter, {
    journalSignal: new ChangeSignal(),
    ptySignal: new ChangeSignal(),
    observerFile: join(root, "observer.jsonl"),
    ptyJournalFile: join(root, "pty.jsonl"),
    resultFile: join(root, "result.jsonl"),
  });
  return adapter;
}

/** The epoch's earlier durable record, so `afterOffset` is genuinely exercised. */
function appendSavedSessionStart(adapter: SavedMainAdapter): void {
  appendFileSync(adapter.observerFile, `${JSON.stringify({
    type: "session_start", pid: SAVED_PID, cwd: WORKSPACE, sessionId: SAVED_SESSION, persistence: "saved",
  })}\n`);
}

function appendSavedAgentSettled(adapter: SavedMainAdapter, pid = SAVED_PID): void {
  appendFileSync(adapter.observerFile, `${JSON.stringify({
    type: "agent_settled", pid, cwd: WORKSPACE, sessionId: SAVED_SESSION,
  })}\n`);
}

/** The saved-resume acceptance predicate shape for the settled foreground turn. */
function savedTurnSettled(records: Record<string, unknown>[]): boolean {
  return records.some((record) => record.type === "agent_settled" && record.pid === SAVED_PID
    && record.cwd === WORKSPACE && record.sessionId === SAVED_SESSION);
}

test("every real-host adapter waits on the one shared durable signal core", () => {
  assert.equal(MainHarnessChangeSignal, ChangeSignal,
    "the public-Main harness waits on the shared core, not a private copy of the timing logic");
  assert.equal(WindowsHarnessChangeSignal, ChangeSignal,
    "the Windows harness (and through it both launchers) re-exports that same shared core");
});

test("the recheck cadence is a small bounded fraction of the harness event deadline", () => {
  assert.ok(Number.isInteger(DURABLE_JOURNAL_RECHECK_INTERVAL_MS));
  assert.ok(DURABLE_JOURNAL_RECHECK_INTERVAL_MS > 0);
  assert.ok(DURABLE_JOURNAL_RECHECK_INTERVAL_MS < 1_000,
    "a coalesced notification delays durable readiness by a small bound only");
});

test("a durable record that was never notified is missed by notification-only readiness and observed by the durable wait within the same bound", async (t) => {
  enableMockClock(t);
  const bound = 120;

  const missJournal = ownedJournal(t, "missed-notification.jsonl");
  const notificationOnly = new ChangeSignal();
  const notificationOnlyWait = notificationOnly.waitFor(() => journalReady(missJournal), bound,
    "pre-change notification-only readiness");
  // The durably complete record lands after the initial evaluation and its
  // watcher delivery is missed: no notify() call ever happens. This is exactly
  // the missed/coalesced event condition, not a synthetic production state.
  appendReadyRecord(missJournal);
  t.mock.timers.tick(bound);
  await assert.rejects(
    notificationOnlyWait,
    /pre-change notification-only readiness: deadline exceeded/,
    "the pre-change path fails the missed-notification condition with its original bound unchanged",
  );
  assert.equal(notificationOnly.pendingWaiterCount, 0);

  const durableJournal = ownedJournal(t, "durable-notification.jsonl");
  const durable = new ChangeSignal();
  const durableWait = durable.waitForRecheck(() => journalReady(durableJournal), bound, "durable journal readiness");
  appendReadyRecord(durableJournal);
  // The same bound, still no notification: one bounded recheck cadence observes it.
  t.mock.timers.tick(DURABLE_JOURNAL_RECHECK_INTERVAL_MS);
  await durableWait;
  assert.equal(durable.pendingWaiterCount, 0);
});

test("the periodic recheck alone observes un-notified durability well before the deadline", async (t) => {
  enableMockClock(t);
  const journal = ownedJournal(t);
  const signal = new ChangeSignal();
  let evaluations = 0;
  const waiter = signal.waitForRecheck(() => {
    evaluations += 1;
    return journalReady(journal);
  }, 1_000, "periodic durable readiness", undefined, 100);
  assert.equal(evaluations, 1, "the initial evaluation ran before any tick");

  appendReadyRecord(journal); // no notify(): only the cadence can observe this
  t.mock.timers.tick(100);
  await waiter;
  assert.equal(evaluations, 2, "the periodic recheck, not the deadline, observed the record");
  assert.equal(signal.pendingWaiterCount, 0);

  t.mock.timers.tick(2_000);
  await flushMicrotasks();
  assert.equal(evaluations, 2, "the settled wait kept no interval or listener behind");
});

test("an explicit notification still settles readiness immediately without waiting for a recheck tick", async (t) => {
  enableMockClock(t);
  const journal = ownedJournal(t);
  const signal = new ChangeSignal();
  let evaluations = 0;
  // The cadence is far beyond this control's virtual horizon, so only the
  // notification fast path can settle the wait.
  const waiter = signal.waitForRecheck(() => {
    evaluations += 1;
    return journalReady(journal);
  }, 5_000, "notified durable readiness", undefined, 60_000);
  assert.equal(evaluations, 1, "the wait evaluates the predicate once immediately");
  assert.equal(signal.pendingWaiterCount, 1);

  appendReadyRecord(journal);
  signal.notify();
  assert.equal(evaluations, 2, "the notification re-evaluated the predicate synchronously");

  await waiter;
  assert.equal(evaluations, 2, "settlement came from the notification, before any tick");
  assert.equal(signal.pendingWaiterCount, 0);
  t.mock.timers.tick(5_000);
  await flushMicrotasks();
  assert.equal(evaluations, 2, "no listener or recheck ran after settlement");
});

test("periodic re-evaluation stays bounded and never extends or re-arms the original deadline", async (t) => {
  enableMockClock(t);
  const signal = new ChangeSignal();
  let evaluations = 0;
  let settled = false;
  const waiter = signal.waitForRecheck(() => {
    evaluations += 1;
    return false;
  }, 450, "never-ready durable readiness", undefined, 100);
  waiter.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(evaluations, 1, "the initial evaluation ran");

  for (let ticks = 1; ticks <= 4; ticks += 1) {
    t.mock.timers.tick(100);
    await flushMicrotasks();
    assert.equal(evaluations, 1 + ticks, `virtual tick ${ticks} re-evaluated exactly once`);
    assert.equal(settled, false, "a false predicate never settles the wait early");
  }
  assert.equal(settled, false, "re-evaluation did not shorten, extend, or re-arm the deadline");

  // The single original deadline (450) fires with no periodic tick due at it.
  t.mock.timers.tick(50);
  await assert.rejects(waiter, /never-ready durable readiness: deadline exceeded/,
    "the predicate was still false at the original deadline");
  assert.equal(settled, true);
  assert.equal(evaluations, 6, "four periodic evaluations plus the final deadline evaluation");
  assert.equal(signal.pendingWaiterCount, 0);

  t.mock.timers.tick(1_000);
  await flushMicrotasks();
  assert.equal(evaluations, 6, "no listener or recheck ran after the deadline settlement");
});

test("the final deadline re-evaluation observes durability no periodic tick could reach", async (t) => {
  enableMockClock(t);
  const journal = ownedJournal(t);
  const signal = new ChangeSignal();
  let evaluations = 0;
  // The cadence is far beyond the deadline, so only the deadline's own final
  // evaluation can observe the record that lands before it.
  const waiter = signal.waitForRecheck(() => {
    evaluations += 1;
    return journalReady(journal);
  }, 200, "deadline final re-evaluation", undefined, 60_000);
  t.mock.timers.tick(50);
  appendReadyRecord(journal); // no notify(), and no periodic tick will occur
  assert.equal(evaluations, 1);

  t.mock.timers.tick(150);
  await waiter;
  assert.equal(evaluations, 2, "only the deadline's own final evaluation observed the record");
  assert.equal(signal.pendingWaiterCount, 0);

  const rejected = new ChangeSignal();
  let rejectEvaluations = 0;
  const rejectWaiter = rejected.waitForRecheck(() => {
    rejectEvaluations += 1;
    return false;
  }, 200, "deadline final rejection", undefined, 60_000);
  t.mock.timers.tick(200);
  await assert.rejects(rejectWaiter, /deadline final rejection: deadline exceeded/,
    "the final re-evaluation never turns a genuinely pending condition into success");
  assert.equal(rejectEvaluations, 2, "the false predicate got one extra bounded examination only");
  assert.equal(rejected.pendingWaiterCount, 0);
});

test("pre-aborted and mid-wait aborted readiness waits refuse even after the durable predicate becomes valid", async (t) => {
  enableMockClock(t);
  const journal = ownedJournal(t);
  const signal = new ChangeSignal();

  const preAborted = new AbortController();
  preAborted.abort();
  appendReadyRecord(journal);
  assert.equal(journalReady(journal), true, "the durable predicate is already satisfied at cancellation time");
  await assert.rejects(
    signal.waitForRecheck(() => journalReady(journal), 5_000, "pre-abort readiness", preAborted.signal),
    /pre-abort readiness: cancelled before completion/,
  );
  assert.equal(signal.pendingWaiterCount, 0);

  const lateJournal = ownedJournal(t, "late-native-main.jsonl");
  const midWait = new AbortController();
  let evaluations = 0;
  const waiter = signal.waitForRecheck(() => {
    evaluations += 1;
    return journalReady(lateJournal);
  }, 5_000, "mid-wait readiness", midWait.signal, 100);
  t.mock.timers.tick(100); // one periodic re-evaluation while still pending
  assert.equal(evaluations, 2, "the wait was still observing its journal before cancellation");

  midWait.abort();
  appendReadyRecord(lateJournal);
  signal.notify();
  await assert.rejects(waiter, /mid-wait readiness: cancelled before completion/);
  assert.equal(signal.pendingWaiterCount, 0);
  assert.equal(journalReady(lateJournal), true, "cancellation wins even though the later predicate is valid");

  t.mock.timers.tick(1_000);
  await flushMicrotasks();
  assert.equal(evaluations, 2, "cancellation cleared the interval and listener");
});

test("predicate exceptions keep a bounded typed failure on the initial evaluation and on a recheck tick", async (t) => {
  enableMockClock(t);
  const signal = new ChangeSignal();
  await assert.rejects(
    signal.waitForRecheck(() => {
      throw new Error("fixture predicate exploded");
    }, 5_000, "throwing durable readiness"),
    /throwing durable readiness: bounded event predicate failed/,
  );
  assert.equal(signal.pendingWaiterCount, 0);

  let evaluations = 0;
  const waiter = signal.waitForRecheck(() => {
    evaluations += 1;
    if (evaluations > 1) throw new Error("fixture predicate exploded on a recheck");
    return false;
  }, 1_000, "recheck throwing durable readiness", undefined, 100);
  t.mock.timers.tick(100);
  await assert.rejects(waiter, /recheck throwing durable readiness: bounded event predicate failed/);
  assert.equal(evaluations, 2);
  assert.equal(signal.pendingWaiterCount, 0);
  t.mock.timers.tick(1_000);
  await flushMicrotasks();
  assert.equal(evaluations, 2, "the typed failure cleared the interval");

  await assert.rejects(signal.waitForRecheck(() => true, 10, "invalid cadence readiness", undefined, 0),
    /invalid cadence readiness: recheck interval must be a positive finite duration/,
    "a non-positive cadence is refused instead of becoming a busy loop");
  assert.equal(signal.pendingWaiterCount, 0);
});

test("multiple waiters settle independently and leave no listener or interval behind", async (t) => {
  enableMockClock(t);
  const notifiedJournal = ownedJournal(t, "notified.jsonl");
  const recheckedJournal = ownedJournal(t, "rechecked.jsonl");
  const signal = new ChangeSignal();
  let notifiedEvaluations = 0;
  let recheckEvaluations = 0;
  const notifiedWaiter = signal.waitForRecheck(() => {
    notifiedEvaluations += 1;
    return journalReady(notifiedJournal);
  }, 10_000, "notified waiter", undefined, 10_000);
  const recheckWaiter = signal.waitForRecheck(() => {
    recheckEvaluations += 1;
    return journalReady(recheckedJournal);
  }, 10_000, "recheck waiter", undefined, 100);
  assert.equal(signal.pendingWaiterCount, 2);

  t.mock.timers.tick(100);
  await flushMicrotasks();
  assert.equal(recheckEvaluations, 2, "the recheck waiter's own cadence ran");
  assert.equal(notifiedEvaluations, 1, "the long-cadence waiter was not re-evaluated");

  // Only the notified waiter's own readiness flips, so a shared notification
  // must settle exactly one waiter and leave the other observing its journal.
  appendReadyRecord(notifiedJournal);
  signal.notify();
  await notifiedWaiter;
  assert.equal(notifiedEvaluations, 2);
  assert.equal(signal.pendingWaiterCount, 1, "the notified waiter settled without disturbing the other");

  // The second waiter's durable record appears with no notification at all.
  appendReadyRecord(recheckedJournal);
  t.mock.timers.tick(100);
  await recheckWaiter;
  assert.equal(signal.pendingWaiterCount, 0, "both waiters settled independently");

  const settled = { notifiedEvaluations, recheckEvaluations };
  signal.notify();
  t.mock.timers.tick(10_000);
  await flushMicrotasks();
  assert.equal(notifiedEvaluations, settled.notifiedEvaluations,
    "the settled notified waiter kept no listener behind");
  assert.equal(recheckEvaluations, settled.recheckEvaluations,
    "the settled recheck waiter kept neither listener nor interval behind");
});

test("the real Main journal wait observes a durable record no notification delivered while the notify-only baseline fails the same bound", async (t) => {
  // This is the actual `MainPtyDriver.waitForRecords` wiring: the driver's own
  // journal reader, the driver's own signal, and the harness event deadline it
  // defaults to. The awaited record lands with no watcher delivery at all.
  enableMockClock(t);
  const journal = ownedJournal(t, "main-observer-missed-notification.jsonl");
  const driver = mainJournalDriver(journal);
  let evaluations = 0;
  const durableWait = driver.waitForRecords((records) => {
    evaluations += 1;
    return mainSessionStartReady(records);
  }, "real native Pi session_start with observed metadata and selected workspace");
  const baselineWait = driver.journalSignal.waitFor(() => mainSessionStartReady(driver.records()),
    EVENT_TIMEOUT_MS, "pre-change notification-only Main journal readiness");
  assert.equal(evaluations, 1, "the real wait evaluated the unchanged predicate once immediately");
  assert.equal(driver.journalSignal.pendingWaiterCount, 2);

  appendMainSessionStart(journal); // durable, and `journalSignal.notify()` never runs
  t.mock.timers.tick(DURABLE_JOURNAL_RECHECK_INTERVAL_MS);
  const records = await durableWait;
  assert.equal(mainSessionStartReady(records), true, "the returned journal really carries the awaited record");
  assert.equal(evaluations, 2, "one bounded cadence re-evaluation, not the deadline, observed the record");
  assert.equal(driver.journalSignal.pendingWaiterCount, 1, "only the baseline waiter is still observing");

  t.mock.timers.tick(EVENT_TIMEOUT_MS);
  assert.match(await rejectionMessage(baselineWait),
    /pre-change notification-only Main journal readiness: deadline exceeded/,
    "the pre-change notification-only path still fails the same condition with its bound unchanged");
  assert.equal(driver.journalSignal.pendingWaiterCount, 0, "both waiters cleared their listeners");
});

test("the real Main journal wait still settles on its watcher notification with no recheck tick at all", async (t) => {
  enableMockClock(t);
  const journal = ownedJournal(t, "main-observer-notified.jsonl");
  const driver = mainJournalDriver(journal);
  let evaluations = 0;
  const waiter = driver.waitForRecords((records) => {
    evaluations += 1;
    return mainSessionStartReady(records);
  }, "notified real Main journal readiness");
  assert.equal(evaluations, 1);
  assert.equal(driver.journalSignal.pendingWaiterCount, 1);

  appendMainSessionStart(journal);
  driver.journalSignal.notify(); // exactly what the driver's fs.watch callback does
  await waiter;                  // resolves with no tick: only the fast path could
  assert.equal(evaluations, 2, "the notification re-evaluated the predicate synchronously");
  assert.equal(driver.journalSignal.pendingWaiterCount, 0);

  t.mock.timers.tick(EVENT_TIMEOUT_MS);
  await flushMicrotasks();
  assert.equal(evaluations, 2, "the settled real wait kept no listener or interval behind");
});

test("the real Main journal wait keeps its unchanged deadline failure, frame diagnostic, and typed predicate failure", async (t) => {
  enableMockClock(t);
  const journal = ownedJournal(t, "main-observer-never-ready.jsonl");
  const driver = mainJournalDriver(journal);
  let evaluations = 0;
  const pendingWait = driver.waitForRecords((records) => {
    evaluations += 1;
    return mainSessionStartReady(records);
  }, "never-published real native Pi session_start");
  let settledEarly = false;
  pendingWait.then(() => { settledEarly = true; }, () => { settledEarly = true; });

  t.mock.timers.tick(EVENT_TIMEOUT_MS - 1);
  await flushMicrotasks();
  assert.equal(settledEarly, false, "the unchanged deadline was not shortened by the cadence");
  t.mock.timers.tick(1);
  const deadlineMessage = await rejectionMessage(pendingWait);
  assert.match(deadlineMessage,
    /never-published real native Pi session_start: deadline exceeded/,
    "a journal that never received the record still fails, so re-evaluation fabricates nothing");
  assert.ok(deadlineMessage.includes(`Actual owned Main frame:\n${CONTROLLED_MAIN_FRAME}`),
    "the Main failure diagnostic keeps the driver's actual captured frame");
  assert.ok(evaluations > 2,
    "the unchanged predicate was re-examined on the bounded cadence while pending, and still failed");
  assert.equal(driver.journalSignal.pendingWaiterCount, 0);

  const exceptionMessage = await rejectionMessage(driver.waitForRecords(() => {
    throw new Error("fixture journal reader exploded");
  }, "exploding real Main journal predicate"));
  assert.match(exceptionMessage, /exploding real Main journal predicate: bounded event predicate failed/,
    "the predicate exception keeps its typed bounded failure");
  assert.ok(exceptionMessage.includes(`Actual owned Main frame:\n${CONTROLLED_MAIN_FRAME}`),
    "the typed failure keeps the same frame-preserving diagnostic");
  assert.equal(driver.journalSignal.pendingWaiterCount, 0, "the typed failure cleared the interval");
});

test("two real Main journal waits on one driver settle independently and leave nothing behind", async (t) => {
  enableMockClock(t);
  const journal = ownedJournal(t, "main-observer-two-waiters.jsonl");
  const driver = mainJournalDriver(journal);
  let startEvaluations = 0;
  let nameEvaluations = 0;
  const startWait = driver.waitForRecords((records) => {
    startEvaluations += 1;
    return records.some((record) => record.type === "session_start" && record.pid === 49_736);
  }, "owned native session_start");
  const nameWait = driver.waitForRecords((records) => {
    nameEvaluations += 1;
    return records.slice(1).some((record) => record.type === "native_session_name"
      && record.pid === 49_736 && record.sessionId === "87x49"
      && record.storedName === "Image proof B" && typeof record.displayName === "string");
  }, "the native public SessionManager freshly observes the exact replacement name");
  assert.equal(driver.journalSignal.pendingWaiterCount, 2);

  // Only the first waiter's record exists, and it arrives with a notification.
  appendMainSessionStart(journal);
  driver.journalSignal.notify();
  await startWait;
  assert.equal(nameEvaluations, 2,
    "the shared notification re-examined the other waiter too, and its own predicate stayed false");
  assert.equal(driver.journalSignal.pendingWaiterCount, 1, "one waiter settled without disturbing the other");

  // The second waiter's durable record lands with no notification at all.
  appendFileSync(journal, `${JSON.stringify({
    type: "native_session_name", pid: 49_736, sessionId: "87x49",
    storedName: "Image proof B", displayName: "Image proof B",
  } satisfies SessionRecord)}\n`);
  t.mock.timers.tick(DURABLE_JOURNAL_RECHECK_INTERVAL_MS);
  await nameWait;
  assert.equal(driver.journalSignal.pendingWaiterCount, 0, "both real waiters settled independently");

  const settled = { startEvaluations, nameEvaluations };
  driver.journalSignal.notify();
  t.mock.timers.tick(EVENT_TIMEOUT_MS);
  await flushMicrotasks();
  assert.equal(startEvaluations, settled.startEvaluations, "the settled session_start waiter left no listener behind");
  assert.equal(nameEvaluations, settled.nameEvaluations, "the settled name waiter left no listener or interval behind");
});

test("the owned job readiness-leaf wait observes a leaf no notification delivered while the notify-only baseline fails the same bound", async (t) => {
  // The same helper the owned background-job acceptance calls, with the same
  // `existsSync` predicate and the same harness event deadline.
  enableMockClock(t);
  const serviceDir = ownedServiceDir(t, "ready-leaf");
  const readyPath = join(serviceDir, "ready.json");
  const readySignal = new ChangeSignal();
  const published = waitForDurableReadyLeaf(readySignal, readyPath, EVENT_TIMEOUT_MS,
    "the owned job listener publishes its readiness leaf");
  const baseline = readySignal.waitFor(() => existsSync(readyPath), EVENT_TIMEOUT_MS,
    "pre-change notification-only readiness leaf");
  assert.equal(existsSync(readyPath), false, "the leaf does not pre-exist, so nothing is ready yet");

  // The job's own exclusive leaf write, observed with no service-directory event.
  writeFileSync(readyPath, JSON.stringify({ pid: 14_639, port: 62_450, status: "ready" }), { flag: "wx", mode: 0o600 });
  t.mock.timers.tick(DURABLE_JOURNAL_RECHECK_INTERVAL_MS);
  await published;
  assert.equal(existsSync(readyPath), true, "the readiness leaf the caller validates really exists");
  assert.equal(readySignal.pendingWaiterCount, 1);

  t.mock.timers.tick(EVENT_TIMEOUT_MS);
  assert.match(await rejectionMessage(baseline),
    /pre-change notification-only readiness leaf: deadline exceeded/,
    "the pre-change notification-only leaf wait fails the same condition with its bound unchanged");
  assert.equal(readySignal.pendingWaiterCount, 0);
});

test("the owned job readiness-leaf wait keeps the fast path, the final deadline examination, and a leaf that never arrives", async (t) => {
  enableMockClock(t);
  const notifiedDir = ownedServiceDir(t, "notified-leaf");
  const notifiedPath = join(notifiedDir, "ready.json");
  const notifiedSignal = new ChangeSignal();
  const notified = waitForDurableReadyLeaf(notifiedSignal, notifiedPath, EVENT_TIMEOUT_MS,
    "notified readiness leaf");
  writeFileSync(notifiedPath, JSON.stringify({ pid: 14_639, port: 62_450, status: "ready" }), { flag: "wx", mode: 0o600 });
  notifiedSignal.notify(); // exactly what the service-directory fs.watch callback does
  await notified;          // resolves with no tick at all
  assert.equal(notifiedSignal.pendingWaiterCount, 0);

  const deadlineDir = ownedServiceDir(t, "deadline-leaf");
  const deadlinePath = join(deadlineDir, "ready.json");
  const deadlineSignal = new ChangeSignal();
  const atDeadline = waitForDurableReadyLeaf(deadlineSignal, deadlinePath, EVENT_TIMEOUT_MS,
    "deadline final readiness leaf examination");
  t.mock.timers.tick(EVENT_TIMEOUT_MS - 1);
  writeFileSync(deadlinePath, JSON.stringify({ pid: 14_639, port: 62_450, status: "ready" }), { flag: "wx", mode: 0o600 });
  t.mock.timers.tick(1);
  await atDeadline;
  assert.equal(deadlineSignal.pendingWaiterCount, 0, "the deadline's own re-read observed the leaf");

  const missingDir = ownedServiceDir(t, "missing-leaf");
  const missingSignal = new ChangeSignal();
  const never = waitForDurableReadyLeaf(missingSignal, join(missingDir, "ready.json"), EVENT_TIMEOUT_MS,
    "the owned job listener never publishes its readiness leaf");
  let settledEarly = false;
  never.then(() => { settledEarly = true; }, () => { settledEarly = true; });
  t.mock.timers.tick(EVENT_TIMEOUT_MS - 1);
  await flushMicrotasks();
  assert.equal(settledEarly, false, "no cadence tick invents a leaf that was never created");
  t.mock.timers.tick(1);
  assert.match(await rejectionMessage(never),
    /the owned job listener never publishes its readiness leaf: deadline exceeded/,
    "a missing leaf still fails with the original deadline error");
  assert.equal(missingSignal.pendingWaiterCount, 0);
  t.mock.timers.tick(EVENT_TIMEOUT_MS);
  await flushMicrotasks();
  assert.equal(missingSignal.pendingWaiterCount, 0, "the failed wait cleared its interval and listener");
});

test("the shared class's negative witnesses kept their notification-driven semantics through the extraction", async (t) => {
  enableMockClock(t);
  const signal = new ChangeSignal();

  const quiet = signal.waitForQuiet(() => false, 300, "quiet window with no owned event");
  let quietSettled = false;
  quiet.then(() => { quietSettled = true; }, () => { quietSettled = true; });
  t.mock.timers.tick(299);
  await flushMicrotasks();
  assert.equal(quietSettled, false, "the quiet window still has to elapse");
  t.mock.timers.tick(1);
  await quiet;
  assert.equal(signal.pendingWaiterCount, 0);

  let eventArrived = false;
  const witness = signal.waitForQuiet(() => eventArrived, 300, "unexpected owned event witness");
  eventArrived = true;
  signal.notify();
  assert.match(await rejectionMessage(witness), /unexpected owned event witness: unexpected owned event/,
    "the negative witness still fails on the first notification that observes the event");
  assert.equal(signal.pendingWaiterCount, 0);

  const period = signal.waitForQuietPeriod(100, 5_000, "settled frame quiet period");
  t.mock.timers.tick(50);
  signal.notify(); // further output restarts the quiet window, unchanged
  t.mock.timers.tick(50);
  await flushMicrotasks();
  let periodSettled = false;
  period.then(() => { periodSettled = true; }, () => { periodSettled = true; });
  await flushMicrotasks();
  assert.equal(periodSettled, false, "the restarted window had not elapsed yet");
  t.mock.timers.tick(50);
  await period;
  assert.equal(signal.pendingWaiterCount, 0);

  const quietDeadline = signal.waitForQuietPeriod(100, 50, "frame quiet never reached");
  t.mock.timers.tick(50);
  assert.match(await rejectionMessage(quietDeadline),
    /frame quiet never reached: deadline exceeded before quiet/,
    "the quiet-period deadline failure text is unchanged");
  assert.equal(signal.pendingWaiterCount, 0);
});

test("the real Saved Main foreground-turn wait observes a settled turn no notification delivered while the notify-only baseline fails the same bound", async (t) => {
  // This is the actual `SavedMainDriver.waitForRecords` wiring behind the saved /
  // automatic-resume acceptance: the driver's own observer reader, its own journal
  // signal, its `afterOffset`, and the harness event deadline it defaults to.
  enableMockClock(t);
  const driver = savedMainAdapter(t);
  appendSavedSessionStart(driver);
  let evaluations = 0;
  const durableWait = driver.waitForRecords((records) => {
    evaluations += 1;
    return savedTurnSettled(records);
  }, "the exact public foreground turn settles before the held worker is released", 1);
  const baselineWait = driver.journalSignal.waitFor(() => savedTurnSettled(driver.records().slice(1)),
    EVENT_TIMEOUT_MS, "pre-change notification-only Saved Main turn settlement");
  assert.equal(evaluations, 1, "the real wait evaluated the unchanged predicate once immediately");
  assert.equal(driver.journalSignal.pendingWaiterCount, 2);

  appendSavedAgentSettled(driver); // durable, and `journalSignal.notify()` never runs
  t.mock.timers.tick(DURABLE_JOURNAL_RECHECK_INTERVAL_MS);
  const records = await durableWait;
  assert.equal(savedTurnSettled(records.slice(1)), true, "the awaited settlement record is really on disk");
  assert.equal(records.length, 2, "the wait still returns the full journal, not the offset slice it tested");
  assert.equal(records[0]!.type, "session_start", "the pre-offset record is still returned unchanged");
  assert.equal(evaluations, 2, "one bounded cadence re-evaluation, not the deadline, observed the record");
  assert.equal(driver.journalSignal.pendingWaiterCount, 1, "only the baseline waiter is still observing");

  t.mock.timers.tick(EVENT_TIMEOUT_MS);
  assert.match(await rejectionMessage(baselineWait),
    /pre-change notification-only Saved Main turn settlement: deadline exceeded/,
    "the pre-change notification-only path still fails the same condition with its bound unchanged");
  assert.equal(driver.journalSignal.pendingWaiterCount, 0, "both waiters cleared their listeners");
});

test("the real Saved Main observer wait cannot be authorized by pre-offset or wrong-owner records and keeps its unchanged deadline", async (t) => {
  enableMockClock(t);
  const staleDriver = savedMainAdapter(t);
  appendSavedAgentSettled(staleDriver); // the only settlement record sits before the snapshot offset
  let staleEvaluations = 0;
  const staleWait = staleDriver.waitForRecords((records) => {
    staleEvaluations += 1;
    return savedTurnSettled(records);
  }, "a settlement from before the submitted turn", 1);
  let staleSettled = false;
  staleWait.then(() => { staleSettled = true; }, () => { staleSettled = true; });
  t.mock.timers.tick(EVENT_TIMEOUT_MS - 1);
  await flushMicrotasks();
  assert.equal(staleSettled, false, "the unchanged deadline was not shortened by the cadence");
  assert.ok(staleEvaluations > 2,
    "the pre-offset fact was re-examined on the bounded cadence and still could not authorize the wait");
  t.mock.timers.tick(1);
  assert.match(await rejectionMessage(staleWait),
    /a settlement from before the submitted turn: deadline exceeded/,
    "a durable fact from before the offset still cannot authorize the wait");
  assert.equal(staleDriver.journalSignal.pendingWaiterCount, 0);

  const otherDriver = savedMainAdapter(t);
  appendSavedSessionStart(otherDriver);
  appendSavedAgentSettled(otherDriver, 99_999); // same turn shape, a different process incarnation
  let ownerEvaluations = 0;
  const wrongOwnerWait = otherDriver.waitForRecords((records) => {
    ownerEvaluations += 1;
    return savedTurnSettled(records);
  }, "the settlement for the exact owned process and conversation epoch", 1);
  t.mock.timers.tick(EVENT_TIMEOUT_MS - 1);
  await flushMicrotasks();
  assert.ok(ownerEvaluations > 2,
    "the unchanged identity predicate was re-examined on the bounded cadence, and still refused");
  t.mock.timers.tick(1);
  assert.match(await rejectionMessage(wrongOwnerWait),
    /the settlement for the exact owned process and conversation epoch: deadline exceeded/,
    "a wrong-owner durable record cannot authorize the wait either");
  assert.equal(otherDriver.journalSignal.pendingWaiterCount, 0, "the failed wait cleared its interval and listener");
});

test("the real Saved Main waits keep their notification fast path and the PTY-journal wait observes a missed onExit record", async (t) => {
  enableMockClock(t);
  const driver = savedMainAdapter(t);
  let evaluations = 0;
  const fastWait = driver.waitForRecords((records) => {
    evaluations += 1;
    return savedTurnSettled(records);
  }, "notified Saved Main turn settlement");
  appendSavedAgentSettled(driver);
  driver.journalSignal.notify(); // exactly what the driver's fs.watch callback does
  await fastWait;                // resolves with no tick: only the fast path could
  assert.equal(evaluations, 2, "the notification re-evaluated the predicate synchronously");
  assert.equal(driver.journalSignal.pendingWaiterCount, 0);

  let ptyEvaluations = 0;
  const ptyWait = driver.waitForPtyRecords((records) => {
    ptyEvaluations += 1;
    return records.some((record) => record.type === "pty_exit" && record.receipt === 7
      && record.pid === SAVED_PID && record.cwd === WORKSPACE);
  }, "the manager-owned public IPty onExit for receipt 7");
  const ptyBaseline = driver.ptySignal.waitFor(() => driver.ptyRecords().some((record) => record.type === "pty_exit"),
    EVENT_TIMEOUT_MS, "pre-change notification-only Saved Main PTY exit");
  assert.equal(driver.ptySignal.pendingWaiterCount, 2);

  appendFileSync(driver.ptyJournalFile, `${JSON.stringify({
    type: "pty_exit", receipt: 7, pid: SAVED_PID, cwd: WORKSPACE, exitCode: 0,
  })}\n`); // durable, no notification
  t.mock.timers.tick(DURABLE_JOURNAL_RECHECK_INTERVAL_MS);
  const ptyRecords = await ptyWait;
  assert.equal(ptyRecords.length, 1, "the PTY wait still returns the full PTY journal");
  assert.equal(ptyEvaluations, 2);
  assert.equal(driver.ptySignal.pendingWaiterCount, 1);

  t.mock.timers.tick(EVENT_TIMEOUT_MS);
  assert.match(await rejectionMessage(ptyBaseline),
    /pre-change notification-only Saved Main PTY exit: deadline exceeded/,
    "the PTY channel's pre-change path fails the same condition with its bound unchanged");
  assert.equal(driver.ptySignal.pendingWaiterCount, 0);
});

test("the real Saved Main runner-result and exported JSONL waits re-read durable files with no notification and still refuse pending ones", async (t) => {
  enableMockClock(t);
  const driver = savedMainAdapter(t);
  const resultWait = driver.waitForRunnerResult();
  const resultBaseline = driver.ptySignal.waitFor(() => readOwnedJsonl(driver.resultFile).length === 1,
    EVENT_TIMEOUT_MS, "pre-change notification-only runner result read");
  assert.equal(driver.ptySignal.pendingWaiterCount, 2);

  appendFileSync(driver.resultFile, `${JSON.stringify({ status: 0, threw: false })}\n`); // durable, no notification
  t.mock.timers.tick(DURABLE_JOURNAL_RECHECK_INTERVAL_MS);
  assert.equal((await resultWait).status, 0, "the runner result was read from disk by the bounded re-check");
  t.mock.timers.tick(EVENT_TIMEOUT_MS);
  assert.match(await rejectionMessage(resultBaseline),
    /pre-change notification-only runner result read: deadline exceeded/,
    "the pre-change runner-result read still fails the same bound");
  assert.equal(driver.ptySignal.pendingWaiterCount, 0);

  // Two result records are not the accepted durable fact, and re-checking must not
  // turn that into readiness.
  const doubledDriver = savedMainAdapter(t);
  appendFileSync(doubledDriver.resultFile, `${JSON.stringify({ status: 0 })}\n${JSON.stringify({ status: 0 })}\n`);
  const doubledWait = doubledDriver.waitForRunnerResult(EVENT_TIMEOUT_MS);
  t.mock.timers.tick(EVENT_TIMEOUT_MS);
  assert.match(await rejectionMessage(doubledWait),
    /the public runSessionHost return and terminal restoration record: deadline exceeded/,
    "a durable file that never matches the accepted shape still fails at the original deadline");

  // The exported Saved/Resume JSONL wrapper owns its watcher, so virtual time is
  // advanced synchronously: no event-loop turn happens, so no real watcher
  // delivery is possible and only the bounded re-check can observe the append.
  const providerDir = ownedServiceDir(t, "saved-provider-journal");
  const providerJournal = join(providerDir, "provider.jsonl");
  const scripted = waitForJsonl<Record<string, unknown>>(providerJournal,
    (records) => records.some((record) => record.model === "controlled-faux-provider"),
    EVENT_TIMEOUT_MS, "the scripted faux-provider request is durable");
  appendFileSync(providerJournal, `${JSON.stringify({ model: "controlled-faux-provider" })}\n`);
  t.mock.timers.tick(DURABLE_JOURNAL_RECHECK_INTERVAL_MS);
  const scriptedRecords = await scripted;
  assert.equal(scriptedRecords.length, 1, "the wrapper returned a fresh read of the durable file");
  assert.equal(scriptedRecords[0]!.model, "controlled-faux-provider");

  const silentJournal = join(providerDir, "silent.jsonl");
  const silent = waitForJsonl<Record<string, unknown>>(silentJournal, (records) => records.length > 0, 300,
    "a provider journal that is never written");
  let silentSettled = false;
  silent.then(() => { silentSettled = true; }, () => { silentSettled = true; });
  t.mock.timers.tick(299);
  await flushMicrotasks();
  assert.equal(silentSettled, false, "the caller's own bound is not shortened by the cadence");
  t.mock.timers.tick(1);
  assert.match(await rejectionMessage(silent), /a provider journal that is never written: deadline exceeded/,
    "an empty durable target still fails at the caller's original deadline");
});
