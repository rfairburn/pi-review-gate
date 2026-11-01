/**
 * Focused regression controls for the deterministic native-resume fixture
 * worker's release wait.
 *
 * The fixture worker waits for a durable, test-owned release file. Its only live
 * trigger used to be one `fs.watch` notification plus a single check made right
 * after the watcher was installed, so a coalesced or never-delivered watcher
 * event left an already-valid `{release:true}` file unexamined until the (then
 * correct) 240 s deadline failed the worker. The retained native witness showed
 * exactly that: the release file existed, no completion marker was written, and
 * the provider journal recorded the shutdown ~243 s later.
 *
 * The helper now keeps the notification fast path and the single original
 * absolute deadline, and adds a bounded reread of that same file plus one final
 * reread at the deadline. Every control below runs on `node:test` mock timers
 * over real task-created release files and the actual exported helper: virtual
 * time makes the cadence, the unchanged deadline, and the absence of activity
 * after settlement exact, and an injected watcher that never notifies is
 * precisely the missed/coalesced-event condition. Nothing here relaxes the
 * launch contract, invents a release, or turns a missing, malformed, or
 * unreadable file into worker success; the pre-change notification-only shape is
 * exercised with the same helper, file, predicate, and deadline, so the
 * regression is demonstrated rather than assumed.
 *
 * The other half of the retained failure was on the publishing side: the test
 * created the final release pathname with `flag: "wx"` and only then wrote bytes,
 * so the worker's unchanged strict reader could parse an empty or truncated
 * record. The publication controls below reproduce that old create-before-write
 * gap with the actual reader, and then publish with the repository's existing
 * durable exclusive writer (`atomicWriteExclusive`) under its real staged file,
 * real fsync, and real atomic commit, using its own hook seam to observe the
 * boundary deterministically instead of racing wall-clock time. The reader, its
 * predicate, and its deadline are the same objects in both halves, which is what
 * makes the before/after comparison meaningful.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";

import { atomicWriteExclusive } from "../src/execution/durable-write";

const WORKER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-native-resume-task-worker.cjs");
const RELEASE_NAMES = ["worker-release.json", "stopped-recoverable-release.json"] as const;
/** The exact release record the fixture worker's strict reader accepts. */
const RELEASE_BODY = '{"release":true}\n';

type WatchListener = (event: string, filename: string | null) => void;
type ErrorListener = (error: unknown) => void;

interface ControlledWatcher {
  on(event: "error", listener: ErrorListener): ControlledWatcher;
  close(): void;
}

interface ControlledWatch {
  readonly watch: (directory: string, listener: WatchListener) => ControlledWatcher;
  readonly directories: string[];
  readonly listeners: WatchListener[];
  readonly errorListeners: ErrorListener[];
  closeCount: number;
  notify(filename: string | null): void;
  fail(error: unknown): void;
}

interface FixtureWorkerModule {
  waitForRelease(
    targetReleasePath: string,
    options?: {
      readonly watch?: (directory: string, listener: WatchListener) => ControlledWatcher;
      readonly recheckIntervalMs?: number;
    },
  ): Promise<void>;
  readonly RELEASE_DEADLINE_MS: number;
  readonly RELEASE_RECHECK_INTERVAL_MS: number;
}

const fixtureWorker = require(WORKER_FIXTURE) as FixtureWorkerModule;

/** A watcher stand-in whose notifications are delivered only when a control says so. */
function controlledWatch(): ControlledWatch {
  const listeners: WatchListener[] = [];
  const errorListeners: ErrorListener[] = [];
  const directories: string[] = [];
  const control: ControlledWatch = {
    directories,
    listeners,
    errorListeners,
    closeCount: 0,
    watch(directory, listener) {
      directories.push(directory);
      listeners.push(listener);
      const watcher: ControlledWatcher = {
        on(event, errorListener) {
          assert.equal(event, "error");
          errorListeners.push(errorListener);
          return watcher;
        },
        close() {
          control.closeCount += 1;
        },
      };
      return watcher;
    },
    notify(filename) {
      for (const listener of [...listeners]) listener("rename", filename);
    },
    fail(error) {
      for (const listener of [...errorListeners]) listener(error);
    },
  };
  return control;
}

/** One fresh ignored directory for real release files; never captured by Git. */
function ownedReleaseDirectory(t: TestContext): string {
  const parent = join(process.cwd(), "node_modules", ".native-resume-worker-release");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, "r-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

interface TimerAudit {
  readonly liveTimeouts: Set<unknown>;
  readonly liveIntervals: Set<unknown>;
  restore(): void;
}

/**
 * Observe the exact timer handles the helper creates, so "cleaned up on settle"
 * is an assertion instead of an assumption. It wraps the mock timer functions
 * that are already installed by `node:test`.
 */
function auditTimers(t: TestContext): TimerAudit {
  const runtime = globalThis as unknown as {
    setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => unknown;
    clearTimeout: (handle: unknown) => void;
    setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  const original = {
    setTimeout: runtime.setTimeout,
    clearTimeout: runtime.clearTimeout,
    setInterval: runtime.setInterval,
    clearInterval: runtime.clearInterval,
  };
  const liveTimeouts = new Set<unknown>();
  const liveIntervals = new Set<unknown>();
  runtime.setTimeout = (callback: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
    let handle: unknown;
    // A timeout that actually fires is no longer armed, whether or not the
    // helper clears its own currently-executing handle.
    const observed = (...callbackArgs: unknown[]): void => {
      liveTimeouts.delete(handle);
      callback(...callbackArgs);
    };
    handle = original.setTimeout(observed, delay, ...rest);
    liveTimeouts.add(handle);
    return handle;
  };
  runtime.clearTimeout = (handle: unknown) => {
    liveTimeouts.delete(handle);
    original.clearTimeout(handle);
  };
  runtime.setInterval = (callback: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
    const handle = original.setInterval(callback, delay, ...rest);
    liveIntervals.add(handle);
    return handle;
  };
  runtime.clearInterval = (handle: unknown) => {
    liveIntervals.delete(handle);
    original.clearInterval(handle);
  };
  const restore = (): void => {
    runtime.setTimeout = original.setTimeout;
    runtime.clearTimeout = original.clearTimeout;
    runtime.setInterval = original.setInterval;
    runtime.clearInterval = original.clearInterval;
  };
  t.after(restore);
  return { liveTimeouts, liveIntervals, restore };
}

const SETTLED = { pending: "pending", resolved: "resolved", rejected: "rejected" } as const;
type Settled = (typeof SETTLED)[keyof typeof SETTLED];

interface TrackedWait {
  state: Settled;
  error: unknown;
}

function track(waiter: Promise<void>): TrackedWait {
  const tracked: TrackedWait = { state: SETTLED.pending, error: undefined };
  void waiter.then(
    () => { tracked.state = SETTLED.resolved; },
    (error: unknown) => {
      tracked.state = SETTLED.rejected;
      tracked.error = error;
    },
  );
  return tracked;
}

/** Let timer callbacks' promise settlements run before asserting their state. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function rejectedMessage(tracked: TrackedWait): string {
  assert.equal(tracked.state, SETTLED.rejected, "the release wait rejected");
  return tracked.error instanceof Error ? tracked.error.message : String(tracked.error);
}

function enableMockTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
}

function writeRelease(path: string, contents = RELEASE_BODY): void {
  writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
}

/**
 * What the publishing side of the fixture can observe at the atomic commit
 * boundary, captured inside the real writer's own hook seam.
 */
interface PublicationBoundary {
  finalExists: boolean;
  readerState: Settled;
  stagedListing: string[];
  stagedBytes: number;
  stagedMode: number;
}

test("the fixture worker module exports the actual release helper without running its entrypoint", () => {
  assert.equal(typeof fixtureWorker.waitForRelease, "function");
  assert.equal(fixtureWorker.RELEASE_DEADLINE_MS, 240_000,
    "the original single absolute release deadline is unchanged");
  assert.ok(Number.isFinite(fixtureWorker.RELEASE_RECHECK_INTERVAL_MS)
    && fixtureWorker.RELEASE_RECHECK_INTERVAL_MS > 0
    && fixtureWorker.RELEASE_RECHECK_INTERVAL_MS < 1_000,
  "the reread cadence is bounded and far below the deadline");
});

test("a genuine release written after the wait begins is observed without any notification", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const watcher = controlledWatch();

  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.pending, "an absent release file stays pending");
  assert.deepEqual(watcher.directories, [directory], "the helper watches the release file's own directory");

  writeRelease(release);
  // No watcher callback is ever invoked: this is the missed/coalesced event.
  t.mock.timers.tick(fixtureWorker.RELEASE_RECHECK_INTERVAL_MS - 1);
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.pending, "no cadence tick has run yet");

  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.resolved,
    "the bounded reread observes the validated durable release and settles the wait");
  assert.equal(watcher.closeCount, 1, "the watcher is closed exactly once on settle");
  assert.deepEqual([...timers.liveTimeouts], [], "the single absolute deadline timer is cleared on settle");
  assert.deepEqual([...timers.liveIntervals], [], "the reread interval is cleared on settle");
  assert.deepEqual(readdirSync(directory), ["worker-release.json"],
    "settling on the validated release creates no fixture marker of its own");
});

test("the pre-change notification-only shape leaves the same durable release unobserved until the deadline", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const watcher = controlledWatch();

  // The same actual helper with the periodic reread disabled is the pre-change
  // notification-only wait; nothing else about the file, predicate, or bound changes.
  const tracked = track(fixtureWorker.waitForRelease(release, {
    watch: watcher.watch,
    recheckIntervalMs: 0,
  }));
  await flushMicrotasks();
  writeRelease(release);
  t.mock.timers.tick(fixtureWorker.RELEASE_RECHECK_INTERVAL_MS * 4);
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.pending,
    "a notification-only wait never examines the valid release written after installation");

  t.mock.timers.tick(fixtureWorker.RELEASE_DEADLINE_MS - fixtureWorker.RELEASE_RECHECK_INTERVAL_MS * 4);
  await flushMicrotasks();
  assert.match(rejectedMessage(tracked), /deadline expired/u,
    "the pre-change shape fails at the unchanged absolute deadline instead of observing the file");
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);
});

test("a release already durable before the wait begins settles on the immediate check", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const watcher = controlledWatch();
  writeRelease(release);

  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.resolved);
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);
});

test("a delivered watcher notification remains the fast path before any cadence tick", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const watcher = controlledWatch();

  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  writeRelease(release);
  watcher.notify(basename(release));
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.resolved,
    "a notification naming the release path settles without waiting for the reread cadence");
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);

  const coalesced = controlledWatch();
  const secondRelease = join(directory, "second-release.json");
  const second = track(fixtureWorker.waitForRelease(secondRelease, { watch: coalesced.watch }));
  await flushMicrotasks();
  writeRelease(secondRelease);
  coalesced.notify(null);
  await flushMicrotasks();
  assert.equal(second.state, SETTLED.resolved, "a coalesced (unnamed) notification also re-reads the release file");
  assert.equal(coalesced.closeCount, 1);
});

test("an absent release still expires the original absolute 240000 ms deadline with no fabricated success", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const watcher = controlledWatch();

  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  t.mock.timers.tick(fixtureWorker.RELEASE_DEADLINE_MS - 1);
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.pending,
    "the wait stays pending immediately before the original deadline");

  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.match(rejectedMessage(tracked), /deadline expired/u,
    "a file that never appears rejects at the unchanged deadline; the final reread fabricates nothing");
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);
  assert.deepEqual(readdirSync(directory), [], "no completion or release marker is created by the wait");
});

test("the final deadline reread observes a release that appeared without a cadence tick", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const watcher = controlledWatch();

  // A cadence at or beyond the deadline isolates the deadline's own final
  // reread: the deadline timer was scheduled first, so it evaluates the actual
  // file before the unchanged "deadline expired" rejection.
  const tracked = track(fixtureWorker.waitForRelease(release, {
    watch: watcher.watch,
    recheckIntervalMs: fixtureWorker.RELEASE_DEADLINE_MS,
  }));
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.pending);
  writeRelease(release);
  // Jump straight to the absolute deadline; no notification is ever delivered.
  t.mock.timers.tick(fixtureWorker.RELEASE_DEADLINE_MS);
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.resolved,
    "the deadline's final reread still accepts only the actual validated release file");
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);
});

test("malformed release payloads fail closed immediately and never resolve", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const watcher = controlledWatch();

  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  writeRelease(release, '{"release":false}\n');
  t.mock.timers.tick(fixtureWorker.RELEASE_RECHECK_INTERVAL_MS);
  await flushMicrotasks();
  assert.match(rejectedMessage(tracked), /release record was malformed/u);
  assert.equal(tracked.state, SETTLED.rejected);
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);

  const alreadyMalformed = controlledWatch();
  writeFileSync(join(directory, "malformed-release.json"), "not-json\n", { mode: 0o600 });
  const immediate = track(fixtureWorker.waitForRelease(join(directory, "malformed-release.json"), {
    watch: alreadyMalformed.watch,
  }));
  await flushMicrotasks();
  assert.equal(immediate.state, SETTLED.rejected, "the immediate check rejects an already malformed payload");
  assert.equal(alreadyMalformed.closeCount, 1);
});

test("a release read error fails closed instead of resolving or faking a missing file", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  // A directory at the release path exists but cannot be read as release JSON.
  mkdirSync(release, { mode: 0o700 });
  const watcher = controlledWatch();

  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.rejected, "a read error rejects rather than staying pending or resolving");
  assert.notEqual(rejectedMessage(tracked), "", "the read failure is reported");
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);
});

test("the old create-before-write publication left an empty final record the actual strict reader rejects", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const watcher = controlledWatch();

  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.pending, "an absent release file stays pending");

  // The shape the fixture used before this fix: `flag: "wx"` makes the final
  // pathname visible before a single byte is written. This is the retained
  // recovery attempt's `Unexpected end of JSON input`, reproduced without a race.
  writeFileSync(release, "", { flag: "wx", mode: 0o600 });
  t.mock.timers.tick(fixtureWorker.RELEASE_RECHECK_INTERVAL_MS);
  await flushMicrotasks();
  assert.match(rejectedMessage(tracked), /Unexpected end of JSON input/u,
    "the unchanged strict reader fails closed on the empty file the old shape exposed");
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);

  // A partially written body is a different byte count with the same fail-closed
  // outcome, so the control is not an empty-file artifact.
  const partialDirectory = ownedReleaseDirectory(t);
  const partial = join(partialDirectory, "worker-release.json");
  const partialWatcher = controlledWatch();
  const partialTracked = track(fixtureWorker.waitForRelease(partial, { watch: partialWatcher.watch }));
  await flushMicrotasks();
  writeFileSync(partial, '{"release":tr', { flag: "wx", mode: 0o600 });
  t.mock.timers.tick(fixtureWorker.RELEASE_RECHECK_INTERVAL_MS);
  await flushMicrotasks();
  assert.match(rejectedMessage(partialTracked), /Unexpected end of JSON input/u,
    "an incomplete release body is rejected rather than retried into a release");
  assert.equal(partialWatcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);
});

test("the durable exclusive publisher stages the complete record before the final release name exists", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const staged = `${release}.tmp.controlled-publication`;
  const watcher = controlledWatch();

  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.pending, "an absent release file stays pending");

  const boundary: PublicationBoundary = {
    finalExists: true,
    readerState: SETTLED.resolved,
    stagedListing: [],
    stagedBytes: -1,
    stagedMode: -1,
  };
  const published = atomicWriteExclusive(release, RELEASE_BODY, {
    tempSuffixForTesting: "controlled-publication",
    hooks: {
      beforeRename: () => {
        // Everything a reader could see while the record is still staged.
        boundary.finalExists = existsSync(release);
        boundary.stagedListing = readdirSync(directory);
        boundary.readerState = tracked.state;
        const stagedStats = lstatSync(staged);
        boundary.stagedBytes = stagedStats.size;
        boundary.stagedMode = stagedStats.mode & 0o777;
        assert.throws(() => readFileSync(release, "utf8"),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
        "a strict reader during preparation still finds no final release record");
      },
    },
  });
  await published;

  assert.equal(boundary.finalExists, false, "the final release name is absent while the complete body is staged");
  assert.deepEqual(boundary.stagedListing, ["worker-release.json.tmp.controlled-publication"],
    "preparation stages the whole record in one owned private file inside the fixture's own state directory");
  assert.equal(boundary.readerState, SETTLED.pending,
    "the actual strict reader had nothing to read while the record was staged");
  assert.equal(boundary.stagedBytes, Buffer.byteLength(RELEASE_BODY),
    "the staged record already holds every byte before the commit");
  assert.equal(boundary.stagedMode, 0o600, "preparation keeps the owner-only staged mode");
  assert.equal(tracked.state, SETTLED.pending, "the commit itself does not settle the wait ahead of its bounded reread");

  t.mock.timers.tick(fixtureWorker.RELEASE_RECHECK_INTERVAL_MS);
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.resolved,
    "after the atomic commit the unchanged strict reader accepts the complete record");
  assert.equal(readFileSync(release, "utf8"), RELEASE_BODY,
    "the committed record is exactly the existing release JSON, with no partial prefix");
  assert.deepEqual(readdirSync(directory), ["worker-release.json"],
    "publication removes only its own staged name and leaves no partial record behind");
  assert.equal(lstatSync(release).mode & 0o777, 0o600,
    "the published release keeps the owner-only mode the fixture already required");
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);
});

test("release publication stays exclusive: an existing final record is never overwritten or adopted", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  writeRelease(release, '{"release":false}\n');
  const existingMode = lstatSync(release).mode & 0o777;

  await assert.rejects(
    () => atomicWriteExclusive(release, RELEASE_BODY, { tempSuffixForTesting: "controlled-collision" }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
    "a release pathname that already exists is somebody else's claim");
  assert.equal(readFileSync(release, "utf8"), '{"release":false}\n', "the pre-existing record's bytes are untouched");
  assert.equal(lstatSync(release).mode & 0o777, existingMode, "the pre-existing record's mode is untouched");
  assert.deepEqual(readdirSync(directory), ["worker-release.json"],
    "a refused publication unlinks only the staged file it created");

  const watcher = controlledWatch();
  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.rejected, "the retained non-release record still fails the strict reader");
  assert.match(rejectedMessage(tracked), /release record was malformed/u,
    "a refused publication never fabricates the release the reader is waiting for");
  assert.equal(watcher.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);
});

test("release publication refuses a symlinked final name instead of following or adopting it", async (t) => {
  const directory = ownedReleaseDirectory(t);
  const retained = join(directory, "retained-record.json");
  writeRelease(retained, '{"release":false}\n');
  const release = join(directory, "worker-release.json");
  symlinkSync(basename(retained), release);

  await assert.rejects(
    () => atomicWriteExclusive(release, RELEASE_BODY, { tempSuffixForTesting: "controlled-symlink" }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
    "a symlink at the release pathname is refused, not followed");
  assert.equal(lstatSync(release).isSymbolicLink(), true, "the existing symlink stays exactly where it was");
  assert.equal(readFileSync(retained, "utf8"), '{"release":false}\n', "nothing is written through the symlink");
  assert.deepEqual(readdirSync(directory).sort(), ["retained-record.json", "worker-release.json"],
    "the refused publication leaves no staged file behind");
});

test("watcher installation and runtime watcher errors fail closed even when a valid release exists", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "stopped-recoverable-release.json");

  const installFailure = track(fixtureWorker.waitForRelease(release, {
    watch: () => { throw new Error("controlled watcher installation failure"); },
  }));
  await flushMicrotasks();
  assert.match(rejectedMessage(installFailure), /release watcher failed/u,
    "a synchronous watcher installation failure rejects instead of falling back to timers");
  assert.deepEqual([...timers.liveTimeouts], [], "no deadline timer survives an installation failure");
  assert.deepEqual([...timers.liveIntervals], [], "no reread interval survives an installation failure");

  const failing = controlledWatch();
  const runtimeFailure = track(fixtureWorker.waitForRelease(release, { watch: failing.watch }));
  await flushMicrotasks();
  failing.fail(new Error("controlled watcher failure"));
  await flushMicrotasks();
  assert.match(rejectedMessage(runtimeFailure), /release watcher failed: controlled watcher failure/u);
  writeRelease(release);
  t.mock.timers.tick(fixtureWorker.RELEASE_RECHECK_INTERVAL_MS * 2);
  await flushMicrotasks();
  assert.equal(runtimeFailure.state, SETTLED.rejected,
    "a watcher error stays a failure; a later valid file cannot turn it into success");
  assert.equal(failing.closeCount, 1);
  assert.deepEqual([...timers.liveTimeouts], []);
  assert.deepEqual([...timers.liveIntervals], []);
});

test("settlement is idempotent and later notifications or ticks cannot re-settle the wait", async (t) => {
  enableMockTimers(t);
  const timers = auditTimers(t);
  const directory = ownedReleaseDirectory(t);
  const release = join(directory, "worker-release.json");
  const watcher = controlledWatch();

  const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
  await flushMicrotasks();
  writeRelease(release);
  watcher.notify(basename(release));
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.resolved);
  assert.equal(watcher.closeCount, 1);

  watcher.notify(basename(release));
  watcher.fail(new Error("late watcher failure"));
  t.mock.timers.tick(fixtureWorker.RELEASE_DEADLINE_MS * 2);
  await flushMicrotasks();
  assert.equal(tracked.state, SETTLED.resolved, "an already settled wait never changes state");
  assert.equal(watcher.closeCount, 1, "the watcher is closed exactly once");
  assert.deepEqual([...timers.liveTimeouts], [], "no timer is left armed after settlement");
  assert.deepEqual([...timers.liveIntervals], []);
});

test("both fixture release filenames used by the hold and stopped-recoverable paths are observed without notifications", async (t) => {
  for (const name of RELEASE_NAMES) {
    await t.test(name, async (subtest) => {
      enableMockTimers(subtest);
      const timers = auditTimers(subtest);
      const directory = ownedReleaseDirectory(subtest);
      const release = join(directory, name);
      const watcher = controlledWatch();

      const tracked = track(fixtureWorker.waitForRelease(release, { watch: watcher.watch }));
      await flushMicrotasks();
      writeRelease(release);
      subtest.mock.timers.tick(fixtureWorker.RELEASE_RECHECK_INTERVAL_MS);
      await flushMicrotasks();
      assert.equal(tracked.state, SETTLED.resolved, `${name} is observed on the bounded reread`);
      assert.equal(watcher.closeCount, 1);
      assert.deepEqual([...timers.liveTimeouts], []);
      assert.deepEqual([...timers.liveIntervals], []);
    });
  }
});

test("the real fixture entrypoint keeps its launch contract and writes no proof for a malformed release", (t) => {
  const directory = ownedReleaseDirectory(t);
  const stateDir = join(directory, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const release = join(stateDir, "worker-release.json");
  writeFileSync(release, '{"release":"yes"}\n', { flag: "wx", mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PRG_FIXTURE_STATE_DIR: stateDir,
    PRG_FIXTURE_OWNED_ROOT: directory,
    PRG_FIXTURE_OUTPUT_NAME: "resume-task-proof.txt",
    PRG_FIXTURE_WORKER_MODE: "hold",
    PI_REVIEW_EXECUTOR_PROTOCOL: "pi-review-executor-jsonl-v1",
    PI_REVIEW_EXECUTOR_SESSION_ID: "controlled-release-session",
    PI_REVIEW_EXECUTOR_OPERATION: "controlled-release-operation",
  };
  const result = spawnSync(process.execPath, [WORKER_FIXTURE], {
    cwd: directory,
    env: environment,
    input: "controlled controller prompt\n",
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined, "the actual fixture entrypoint ran without a bounded timeout");
  assert.equal(result.status, 1, "the worker exits nonzero for a malformed release record");
  assert.match(result.stderr, /native resume fixture worker failed: native resume fixture release record was malformed/u);
  assert.equal(existsSync(join(stateDir, "worker-started.json")), true,
    "the worker really started under the valid owned launch contract");
  assert.equal(existsSync(join(stateDir, "worker-completed.json")), false,
    "no completion marker is written from the deadline or from mere file presence");
  assert.equal(existsSync(join(directory, "resume-task-proof.txt")), false,
    "no proof output is written without a validated release");
  assert.equal(existsSync(join(stateDir, "executor-failure.json")), false,
    "a malformed release is not converted into an executor-failure record");
});
