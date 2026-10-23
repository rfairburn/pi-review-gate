// Bounded owner liveness for the cleanup lock.
//
// The cleanup lock waits two seconds for a holder that may be finishing a short
// state transition. A foreign owner's targeted birth query is a native `ps` or
// PowerShell call that has been observed to take hundreds of milliseconds on a
// busy host, and it used to run inline in that retry loop: several of them could
// consume the whole budget, and a contender whose query spanned the holder's
// release could miss the vacancy that appeared in the middle of that query and so
// report busy coordination.
//
// These regressions pin the replacement contract:
//   * the production cleanup entry point is what is exercised, never a generic
//     helper behind a test-only flag;
//   * a foreign birth query runs as an owned asynchronous helper, so the original
//     cadence keeps trying atomic publication while it is running, and the
//     vacancy a releasing holder leaves is won inside the budget;
//   * lock success is handed back only after EVERY helper this wait started has
//     positively closed — including one cancelled because its record was replaced
//     — and an unknown, busy, late, or unconfirmed answer always preserves the
//     observed record;
//   * one absolute two-second deadline governs every branch, a stale reclaim and
//     the hand-back of success included, and every helper signal, escalation, and
//     confirmation deadline is derived from it;
//   * a confirmation deadline that has passed makes the one owned helper
//     UNCONFIRMED at the status boundary itself — in the same turn the deadline is
//     crossed, before the confirmation timer dispatches — so neither a new helper
//     nor handed-back lock success can slip into that window, and only a real
//     close ends it;
//   * a closed verdict is consumed once for the exact record it asked about and
//     then retired, so a transient unknown can recover while budget remains.
//
// Everything here is event-driven: real holder, coordinator, and helper processes
// report real `close` events over IPC, so no test paces itself with a sleep or
// rescues itself with a larger budget. The narrow seams these tests override
// (`coordinationInternals.startOwnerIdentityProbe`, `ownerProbeSlotState`, and
// `ownerStartIdentity`) are the same mutable objects the production wait consults,
// and every override is restored only after the owned helper has really closed.
//
// Counter-mutation control: restoring the old synchronous wait in production makes
// "takes a cleanup lock that is freed while a birth query is running" fail at its
// acquisition assertion, not merely at an instrumentation assertion, because the
// separately owned coordinator releases the holder while the contender is blocked.
// Reverting the slot-status reading to the raw stored state makes the two
// clock-expiry regressions fail at their first status and acquisition assertions,
// because their clock moves inside a single turn and no timer is dispatched.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import test from "node:test";

const requireCjs = createRequire(join(process.cwd(), "tests", "prepare-application-cleanup-probe.test.ts"));

interface ProbeVerdict {
  identity: string;
  reason: string;
}

interface ProbeStart {
  status: string;
  identity?: string;
  probe?: ProbeHandle;
}

interface ProbeHandle {
  readonly state: string;
  readonly verdict: ProbeVerdict | undefined;
  readonly close: Promise<ProbeVerdict>;
  cancel(): void;
}

/** The absolute deadlines the production wait hands to one owned helper. */
interface ProbeDeadlines {
  queryDeadlineMs: number;
  confirmDeadlineMs: number;
}

interface LockHandle {
  file: string;
  identity: unknown;
  release(): void;
}

interface OwnerRecord {
  pid: number;
  birth: string;
  nonce: string;
}

interface PrepareModule {
  APPLICATION_SCHEMA: number;
  __test: {
    acquireCleanupLock(stateRoot: string, options?: Record<string, unknown>): Promise<LockHandle | null>;
  };
}

interface GenerationsModule {
  coordinationInternals: Record<string, unknown>;
}

const prepare = requireCjs("../scripts/prepare-application.cjs") as PrepareModule;
const generations = requireCjs("../scripts/managed-generations.cjs") as GenerationsModule;
const internals = generations.coordinationInternals;

const HELPER = resolve("tests/fixtures/cleanup-lock-probe-holder.cjs");
/** The unchanged production cleanup budget, asserted rather than configured. */
const CLEANUP_LOCK_WAIT_MS = 2_000;
/** The unchanged cleanup poll cadence, asserted rather than configured. */
const CLEANUP_LOCK_POLL_MS = 50;
/**
 * What one synchronous native birth query costs the retry loop, and deliberately
 * more than the whole cleanup budget: a holder released during such a query must
 * be winnable inside the budget, which the inline query cannot do.
 */
const SYNCHRONOUS_QUERY_COST_MS = 2_500;
/** A pid no live process can be holding on any supported platform. */
const ABANDONED_PID = 2 ** 22 + 7;
/** Bound on every event-driven wait in this file, so a failure cannot hang. */
const GUARD_MS = 30_000;
/**
 * The unchanged bound on the natural-exit regression's wait for its own contender
 * process to close. It REJECTS (see `boundedClose`), so a process whose close was
 * never observed fails that test instead of being reported as a clean exit.
 */
const PROCESS_CLOSE_GUARD_MS = 5_000;
/**
 * Clock slack for comparing an absolute deadline against a timestamp observed in
 * the test process: the wait computes its own deadline a moment after the test
 * recorded `startedAt`. Observation slack only, never extra budget.
 */
const DEADLINE_OBSERVATION_SLACK_MS = 25;
const FIXTURE_PARENT = join(process.cwd(), "node_modules", ".cleanup-lock-probe-fixtures");
mkdirSync(FIXTURE_PARENT, { recursive: true });

let fixtureCounter = 0;
function makeStateRoot(prefix: string): string {
  fixtureCounter += 1;
  const root = join(FIXTURE_PARENT, `cleanup-probe-${prefix}-${process.pid}-${fixtureCounter}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function lockPath(stateRoot: string): string {
  return join(stateRoot, "cleanup.lock");
}

/** Written by a contender the instant it enters a foreign birth query. */
function sentinelPath(stateRoot: string): string {
  return join(stateRoot, "birth-query-entered");
}

function readOwnerRecord(stateRoot: string): OwnerRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(stateRoot), "utf8")) as Record<string, unknown>;
    if (typeof parsed.pid !== "number" || typeof parsed.nonce !== "string") return null;
    return { pid: parsed.pid, birth: typeof parsed.birth === "string" ? parsed.birth : "", nonce: parsed.nonce };
  } catch {
    return null;
  }
}

/** A genuinely new record for the same live owner, published over the old entry. */
function writeReplacementRecord(stateRoot: string, owner: OwnerRecord, nonce: string): void {
  writeFileSync(lockPath(stateRoot), `${JSON.stringify({
    schema: prepare.APPLICATION_SCHEMA,
    pid: owner.pid,
    birth: owner.birth,
    nonce,
    createdAt: new Date().toISOString(),
  })}\n`, "utf8");
}

/** Private publication candidates must never outlive a wait. */
function publicationResidue(stateRoot: string): string[] {
  try {
    return readdirSync(stateRoot).filter((name) => name.startsWith(".cleanup.lock."));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Typed access to the live coordination seams (read at call time, so an
// installed driver is what production actually consults)
// ---------------------------------------------------------------------------

const seam = {
  startProbe(pid: number, deadlines?: ProbeDeadlines): ProbeStart {
    return (internals.startOwnerIdentityProbe as (pid: number, opts?: unknown) => ProbeStart)(pid, deadlines);
  },
  slotState(): string {
    return (internals.ownerProbeSlotState as () => string)();
  },
  ownerStart(pid: number): string {
    return (internals.ownerStartIdentity as (pid: number) => string)(pid);
  },
};

/** Bounded, event-driven observation of a slot transition (never a fixed sleep). */
async function waitForSlotState(expected: string, timeoutMs = GUARD_MS): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (seam.slotState() === expected) return;
    if (Date.now() >= until) throw new Error(`the helper slot never became "${expected}"`);
    await new Promise((resolveTick) => { setTimeout(resolveTick, 5); });
  }
}

// ---------------------------------------------------------------------------
// Owned helper processes
// ---------------------------------------------------------------------------

interface IpcChild {
  pid: number | undefined;
  connected: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "close", listener: () => void): void;
  send(message: string, callback?: (error: Error | null) => void): void;
}

function spawnOwnedHelper(args: string[]): IpcChild {
  return spawn(process.execPath, args, { stdio: ["ignore", "ignore", "ignore", "ipc"] }) as unknown as IpcChild;
}

interface OwnedProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "close", listener: () => void): void;
}

/**
 * An owned process with NO IPC channel, so that its natural exit is measurable:
 * a connected channel holds a Node process open by itself, which would hide a
 * referenced timer behind an equally long wait.
 */
function spawnOwnedProcess(args: string[]): OwnedProcess {
  return spawn(process.execPath, args, { stdio: "ignore" }) as unknown as OwnedProcess;
}

/** Bounded observation of a file an owned process writes on its own. */
async function waitForFile(file: string, timeoutMs = GUARD_MS): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) return;
    if (Date.now() >= until) throw new Error(`${file} was never written`);
    await new Promise((resolveTick) => { setTimeout(resolveTick, 5); });
  }
}

/**
 * The real `close` of an owned process, observed from the moment it is spawned.
 *
 * It carries NO timer of its own on purpose: the bound is applied where the close
 * is actually awaited (`boundedClose`), so a close that never lands fails the test
 * that is waiting, and no guard stays referenced after that test stops caring.
 */
function closedProcess(child: OwnedProcess): Promise<void> {
  return new Promise((resolveClosed) => {
    child.on("close", () => {
      resolveClosed();
    });
  });
}

/**
 * Await an already-armed close observation under a bound that REJECTS.
 *
 * Racing a timer that merely RESOLVES is not a cleanup proof: it reports success
 * for a close that was never observed, and `Promise.race` never cancels its loser,
 * so the unresolved guard stays referenced and holds this runner open for the rest
 * of the bound. This helper fails instead, and it clears its own timer whichever
 * side settles, so a prompt close leaves nothing behind.
 */
async function boundedClose<T>(closing: Promise<T>, timeoutMs: number, failureMessage: string): Promise<T> {
  const observed = Promise.resolve(closing);
  // A guard that wins the race must not turn a later rejection of the observation
  // itself into an unhandled rejection.
  observed.catch(() => undefined);
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observed,
      new Promise<T>((_resolveGuard, rejectGuard) => {
        guard = setTimeout(() => {
          rejectGuard(new Error(failureMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (guard !== undefined) clearTimeout(guard);
  }
}

/**
 * Send on an owned helper's channel without ever throwing into the caller: a
 * helper whose channel is already gone simply ignores the instruction, and the
 * real `close` event is what the tests act on. A disconnected channel reports the
 * failure ASYNCHRONOUSLY unless a callback is supplied, so the connection check
 * and the callback are both required: `try/catch` alone cannot suppress it.
 */
function safeSend(child: IpcChild, message: string): void {
  if (!child.connected) return;
  try {
    child.send(message, () => {
      // Disconnection can still race the connection check; the real close event
      // stays the authoritative signal for every test here.
    });
  } catch {
    // The channel failed synchronously.
  }
}

interface MessageStream {
  child: IpcChild;
  send(message: string): void;
  /** Resolves on the next unconsumed message of this type, or rejects if it never arrives. */
  waitFor(type: string): Promise<Record<string, unknown>>;
}

function messageStream(child: IpcChild): MessageStream {
  const messages: Record<string, unknown>[] = [];
  const consumed = new Map<string, number>();
  const waiters: (() => void)[] = [];
  let closed = false;
  child.on("message", (message) => {
    messages.push(message as Record<string, unknown>);
    for (const wake of waiters.splice(0)) wake();
  });
  child.on("close", () => {
    closed = true;
    for (const wake of waiters.splice(0)) wake();
  });
  child.on("exit", () => {
    closed = true;
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    child,
    send: (message: string) => {
      safeSend(child, message);
    },
    waitFor: (type: string) => new Promise<Record<string, unknown>>((resolveMessage, rejectMessage) => {
      const guard = setTimeout(() => rejectMessage(new Error(`no "${type}" message ever arrived`)), GUARD_MS);
      const check = (): void => {
        const seen = consumed.get(type) ?? 0;
        let matches = 0;
        for (const message of messages) {
          if (message.type !== type) continue;
          matches += 1;
          if (matches > seen) {
            consumed.set(type, matches);
            clearTimeout(guard);
            resolveMessage(message);
            return;
          }
        }
        if (closed) {
          clearTimeout(guard);
          rejectMessage(new Error(`the helper exited before sending "${type}"`));
          return;
        }
        waiters.push(check);
      };
      check();
    }),
  };
}

/**
 * A real foreign holder, and when `sentinel` is given its own release
 * coordinator: it releases through the production release path as soon as the
 * sentinel appears, which is the only way a contender blocked inside a
 * synchronous query can ever be released.
 */
function startHolder(stateRoot: string, sentinel?: string): MessageStream {
  const args = [HELPER, "holder", stateRoot];
  if (sentinel !== undefined) args.push(sentinel);
  return messageStream(spawnOwnedHelper(args));
}

// ---------------------------------------------------------------------------
// The owned async probe, driven by a real helper process
// ---------------------------------------------------------------------------

/**
 * How the fake helper reacts to being cancelled. Each mode is a faithful model of
 * a distinct state of the real primitive: a helper that really dies, one that is
 * still alive (so its slot is still `pending`, NOT `unconfirmed`), and one whose
 * caller's confirmation deadline expired while it stayed alive.
 */
type HelperBehavior = "closes" | "ignores-cancel" | "confirmation-expires";

class FakeProbe implements ProbeHandle {
  state: "pending" | "closed" = "pending";
  verdict: ProbeVerdict | undefined;
  /** True once the caller's confirmation deadline expired with this helper alive. */
  unconfirmed = false;
  /** The verdict the owning test publishes with the real close, if any. */
  published: ProbeVerdict | undefined;
  readonly close: Promise<ProbeVerdict>;
  readonly child: IpcChild;
  private settle!: (verdict: ProbeVerdict) => void;

  constructor(
    readonly pid: number,
    readonly deadlines: ProbeDeadlines,
    private readonly behavior: HelperBehavior,
    private readonly events: string[],
    private readonly onClosed: (probe: FakeProbe) => void,
  ) {
    this.close = new Promise<ProbeVerdict>((resolveClose) => {
      this.settle = resolveClose;
    });
    this.child = spawnOwnedHelper([HELPER, "probe"]);
    // The real `close` event, not `exit`: stdout and the IPC channel must be gone,
    // which is exactly the evidence the production wait requires before it will
    // hand back a lock.
    this.child.on("close", () => {
      // A real close is the only thing that produces a verdict. A close the test
      // never armed with an explicit verdict is a canceled/unknown one.
      const verdict = this.published ?? { identity: "", reason: "canceled" };
      this.verdict = verdict;
      this.state = "closed";
      this.events.push("probe-closed");
      this.onClosed(this);
      this.settle(verdict);
    });
  }

  cancel(): void {
    if (this.state === "closed") return;
    this.events.push("probe-canceled");
    if (this.behavior === "closes") {
      safeSend(this.child, "finish");
      return;
    }
    if (this.behavior === "confirmation-expires") {
      // The helper is still alive when the caller's confirmation deadline expires.
      this.unconfirmed = true;
      this.events.push("probe-unconfirmed");
    }
    // "ignores-cancel": the helper stays alive and the slot stays pending.
  }
}

interface ProbeCall {
  pid: number;
  deadlines: ProbeDeadlines;
}

interface ProbeDriver {
  events: string[];
  probes: FakeProbe[];
  calls: ProbeCall[];
  /** Highest number of this wait's helpers that were alive at the same moment. */
  maxConcurrent(): number;
  syncQueries(): number;
  slotState(): string;
  /** Resolves once this wait has allocated `target` helpers. */
  allocations(target: number): Promise<void>;
  /** The live probe's real helper closes, publishing `verdict` with it. */
  closeLiveProbe(verdict: ProbeVerdict): Promise<void>;
  /** The real close of a helper whose close could not be confirmed. */
  forceClose(): Promise<void>;
  /** Completes only after every owned helper has really closed. */
  restore(): Promise<void>;
}

function installProbeDriver(options: { behavior?: HelperBehavior; sentinel?: string } = {}): ProbeDriver {
  const behavior: HelperBehavior = options.behavior ?? "closes";
  const realProbe = internals.startOwnerIdentityProbe;
  const realSlotState = internals.ownerProbeSlotState;
  const realOwnerStartIdentity = internals.ownerStartIdentity;
  const events: string[] = [];
  const probes: FakeProbe[] = [];
  const calls: ProbeCall[] = [];
  const allocationWaiters: (() => void)[] = [];
  let live: FakeProbe | undefined;
  let concurrent = 0;
  let maxConcurrent = 0;
  let syncQueries = 0;

  /** Handed back only once nothing this driver owns is still alive. */
  const restoreSeams = (): void => {
    internals.startOwnerIdentityProbe = realProbe;
    internals.ownerProbeSlotState = realSlotState;
    internals.ownerStartIdentity = realOwnerStartIdentity;
  };

  /**
   * A contender entering a foreign birth query — synchronous or not — records it
   * here, where the holder's own coordinator process can observe it. A contender
   * blocked inside a query cannot ask for the release it is waiting for.
   */
  const markQueryEntered = (): void => {
    const sentinel = options.sentinel;
    if (typeof sentinel !== "string" || sentinel.length === 0) return;
    if (existsSync(sentinel)) return;
    writeFileSync(sentinel, "entered\n", "utf8");
  };

  internals.startOwnerIdentityProbe = (pid: number, probeOptions?: ProbeDeadlines) => {
    const deadlines: ProbeDeadlines = {
      queryDeadlineMs: Number(probeOptions?.queryDeadlineMs),
      confirmDeadlineMs: Number(probeOptions?.confirmDeadlineMs),
    };
    calls.push({ pid, deadlines });
    markQueryEntered();
    if (live !== undefined) {
      events.push("probe-busy");
      return { status: "busy" };
    }
    const probe = new FakeProbe(pid, deadlines, behavior, events, (closed) => {
      if (live === closed) {
        live = undefined;
      }
      concurrent -= 1;
    });
    probes.push(probe);
    live = probe;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    events.push("probe-started");
    for (const wake of allocationWaiters.splice(0)) wake();
    return { status: "started", probe };
  };
  const slotState = (): string => {
    if (live === undefined) return "free";
    return live.unconfirmed ? "unconfirmed" : "pending";
  };
  internals.ownerProbeSlotState = slotState;
  internals.ownerStartIdentity = (pid: number) => {
    // The old path's entry into a foreign birth query, observed by the holder's
    // coordinator. Everything after this point occupies THIS process for the
    // whole span of a native query, which is precisely what the wait may not do.
    syncQueries += 1;
    markQueryEntered();
    // A real owned helper that sits in its own process for the query's span: a
    // genuine query cost rather than a CPU spin.
    spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${SYNCHRONOUS_QUERY_COST_MS})`], { timeout: 30_000 });
    return (realOwnerStartIdentity as (ownerPid: number) => string)(pid);
  };

  return {
    events,
    probes,
    calls,
    maxConcurrent: () => maxConcurrent,
    syncQueries: () => syncQueries,
    slotState,
    allocations: (target: number) => new Promise<void>((resolveAllocations, rejectAllocations) => {
      if (probes.length >= target) {
        resolveAllocations();
        return;
      }
      const guard = setTimeout(() => {
        rejectAllocations(new Error(`the wait never allocated ${target} helper(s); it made ${probes.length}`));
      }, GUARD_MS);
      allocationWaiters.push(() => {
        clearTimeout(guard);
        resolveAllocations();
      });
    }),
    closeLiveProbe: async (verdict: ProbeVerdict) => {
      const probe = live;
      if (probe === undefined) throw new Error("the cleanup wait allocated no probe to close");
      probe.published = verdict;
      safeSend(probe.child, "finish");
      // The real close under the existing bound: a close that never lands fails
      // here instead of being reported as a helper that closed.
      await boundedClose(probe.close, GUARD_MS, "the owned helper never closed when asked to finish");
    },
    forceClose: async () => {
      const probe = live;
      if (probe === undefined) return;
      probe.published = { identity: "", reason: "canceled" };
      safeSend(probe.child, "finish");
      await boundedClose(probe.close, GUARD_MS, "the owned helper never closed when forced to");
    },
    restore: async () => {
      const closing = live;
      if (closing === undefined) {
        restoreSeams();
        return;
      }
      // Restoration is not complete while a helper this test owns is still alive:
      // the child is terminated through the handle that owns it, and both the
      // production seams and this driver's own helper state stay in place until
      // that real close lands. Restoring on a race the guard could resolve would
      // claim a close that was never observed.
      closing.child.kill("SIGKILL");
      await boundedClose(closing.close, GUARD_MS, "the owned helper never closed during restoration");
      live = undefined;
      restoreSeams();
    },
  };
}

/** Event-driven observation of the production wait's own poll cadence. */
function createWaitCounter(): { count(): number; onWait(): void; atLeast(target: number): Promise<void> } {
  let waits = 0;
  const waiters: { target: number; resolve: () => void }[] = [];
  return {
    count: () => waits,
    onWait: () => {
      waits += 1;
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waits >= waiters[index].target) waiters.splice(index, 1)[0].resolve();
      }
    },
    atLeast: (target: number) => new Promise<void>((resolveAtLeast, rejectAtLeast) => {
      if (waits >= target) {
        resolveAtLeast();
        return;
      }
      const guard = setTimeout(() => {
        rejectAtLeast(new Error(`the wait never reached poll ${target}; it made ${waits}`));
      }, GUARD_MS);
      waiters.push({
        target,
        resolve: () => {
          clearTimeout(guard);
          resolveAtLeast();
        },
      });
    }),
  };
}

function countEvent(events: string[], name: string): number {
  return events.filter((entry) => entry === name).length;
}

function indexOfEvent(events: string[], name: string): number {
  return events.indexOf(name);
}

// ---------------------------------------------------------------------------
// A real foreign holder, through the production entry point
// ---------------------------------------------------------------------------

test("a real foreign holder acquires and normally releases the production cleanup lock", async () => {
  const stateRoot = makeStateRoot("holder");
  const holder = startHolder(stateRoot);
  try {
    const held = await holder.waitFor("held");
    const holderPid = held.pid as number;
    const birth = held.birth as string;
    assert.equal(typeof holderPid, "number", "the holder reported its own pid");
    assert.notEqual(birth, "", "the holder published a real owner birth identity");
    const record = readOwnerRecord(stateRoot);
    assert.ok(record !== null, "the canonical entry exists while the holder owns it");
    assert.equal(record?.pid, holderPid, "the canonical entry names the holder");
    assert.equal(record?.birth, birth, "the canonical entry carries the holder's recorded birth");
    assert.equal(seam.ownerStart(holderPid), birth, "the recorded birth is what the native query reports");
    holder.send("release");
    const released = await holder.waitFor("released");
    assert.equal(released.present, false, "an ordinary release removes exactly the holder's record");
    assert.equal(existsSync(lockPath(stateRoot)), false, "the canonical entry is gone after the release");
    assert.deepEqual(publicationResidue(stateRoot), [], "no publication candidate is left behind");
  } finally {
    holder.child.kill();
  }
});

// ---------------------------------------------------------------------------
// The regression the inline query used to lose: vacancy during a birth query
// ---------------------------------------------------------------------------

test("a cleanup lock freed while a birth query is running is won inside the budget", async () => {
  const stateRoot = makeStateRoot("responsive");
  const sentinel = sentinelPath(stateRoot);
  // The holder is also its own release coordinator, in its own process: it frees
  // the lock the moment a contender enters a foreign birth query, which is the
  // only moment that can be observed at all when the contender is blocked.
  const holder = startHolder(stateRoot, sentinel);
  const driver = installProbeDriver({ sentinel });
  const waits = createWaitCounter();
  let lock: LockHandle | null = null;
  let startedAt = 0;
  try {
    await holder.waitFor("held");
    startedAt = Date.now();
    lock = await prepare.__test.acquireCleanupLock(stateRoot, { onWait: () => waits.onWait() });
    const elapsed = Date.now() - startedAt;

    // The acquisition assertion first: on the old inline path the contender is
    // still blocked inside its first query when the coordinator frees the lock, so
    // it comes back unavailable here rather than later in this list.
    assert.notEqual(lock, null, "the freed cleanup lock is acquired");
    assert.ok(
      elapsed < CLEANUP_LOCK_WAIT_MS,
      `the wait stayed inside its own ${CLEANUP_LOCK_WAIT_MS}ms budget instead of spending it on queries (took ${elapsed}ms)`,
    );
    assert.equal(driver.syncQueries(), 0, "no synchronous foreign birth query ran inside the cleanup wait");
    assert.equal(driver.probes.length, 1, "exactly one owned birth probe was allocated for this wait");
    assert.equal(driver.maxConcurrent(), 1, "never more than one helper is alive at a time");
    assert.equal(countEvent(driver.events, "probe-busy"), 0, "no second allocation was attempted");
    assert.ok(indexOfEvent(driver.events, "probe-started") >= 0, "the foreign owner was probed");
    assert.ok(
      indexOfEvent(driver.events, "probe-canceled") > indexOfEvent(driver.events, "probe-started"),
      "the probe was still running when the freed lock was won",
    );
    assert.ok(
      indexOfEvent(driver.events, "probe-closed") > indexOfEvent(driver.events, "probe-canceled"),
      "the owned helper positively closed before the lock was handed back",
    );
    assert.equal(waits.count() >= 1, true, "the wait actually used its retry cadence");

    // Every helper deadline is derived from this wait's own absolute deadline, so
    // its signal, escalation, and confirmation cannot land outside the budget.
    const call = driver.calls[0];
    assert.ok(Number.isFinite(call.deadlines.queryDeadlineMs), "the helper was given an absolute query deadline");
    assert.ok(Number.isFinite(call.deadlines.confirmDeadlineMs), "the helper was given an absolute confirmation deadline");
    assert.ok(call.deadlines.queryDeadlineMs < call.deadlines.confirmDeadlineMs, "confirmation outlives the query cap");
    assert.ok(
      call.deadlines.confirmDeadlineMs - startedAt <= CLEANUP_LOCK_WAIT_MS + DEADLINE_OBSERVATION_SLACK_MS,
      "the helper's confirmation deadline stays inside the unchanged cleanup budget",
    );
    assert.ok(
      call.deadlines.confirmDeadlineMs - call.deadlines.queryDeadlineMs <= CLEANUP_LOCK_POLL_MS * 2 + 10,
      "the escalation window fits inside the wait's own reserve",
    );
    assert.equal(seam.slotState(), "free", "no helper is left allocated after success");
  } finally {
    lock?.release();
    await driver.restore();
    holder.child.kill();
  }
});

test("several poll ticks with a live owner allocate no more than one helper at a time", async () => {
  const stateRoot = makeStateRoot("single-probe");
  const holder = startHolder(stateRoot);
  const driver = installProbeDriver();
  const waits = createWaitCounter();
  let lock: LockHandle | null = null;
  try {
    await holder.waitFor("held");
    const acquisition = prepare.__test.acquireCleanupLock(stateRoot, {
      onWait: () => {
        waits.onWait();
        // Several poll ticks pass with the record still owned, then it is freed.
        if (waits.count() === 3) holder.send("release");
      },
    });
    lock = await acquisition;
    assert.notEqual(lock, null, "the lock is taken once the holder releases");
    assert.equal(driver.probes.length, 1, "a pending probe is never replaced by a second allocation");
    assert.equal(driver.maxConcurrent(), 1, "never more than one helper is alive at a time");
    assert.equal(driver.syncQueries(), 0, "the retry loop never ran the query inline");
    assert.equal(countEvent(driver.events, "probe-busy"), 0, "no redundant allocation was attempted");
  } finally {
    lock?.release();
    await driver.restore();
    holder.child.kill();
  }
});

// ---------------------------------------------------------------------------
// Unknown, obsolete, and unconfirmed verdicts
// ---------------------------------------------------------------------------

test("an unknown birth verdict preserves a live holder and never suppresses the next query", async () => {
  const stateRoot = makeStateRoot("unknown");
  const holder = startHolder(stateRoot);
  const driver = installProbeDriver();
  try {
    const held = await holder.waitFor("held");
    const startedAt = Date.now();
    const acquisition = prepare.__test.acquireCleanupLock(stateRoot);
    await driver.allocations(1);
    await driver.closeLiveProbe({ identity: "", reason: "unparseable" });
    await driver.allocations(2);
    await driver.closeLiveProbe({ identity: "", reason: "canceled" });
    // Two consumed unknowns are not a verdict and never a suppression: the wait
    // keeps asking while its budget lasts, so this test does not encode a limit.
    await driver.allocations(3);
    const lock = await acquisition;
    const elapsed = Date.now() - startedAt;
    assert.equal(lock, null, "an unknown birth never takes a live holder's lock");
    assert.equal(
      readOwnerRecord(stateRoot)?.nonce,
      held.nonce as string,
      "the live holder's record survives unknown verdicts untouched",
    );
    assert.ok(elapsed >= CLEANUP_LOCK_WAIT_MS, "the wait used the full unchanged budget rather than giving up early");
    assert.ok(
      elapsed < CLEANUP_LOCK_WAIT_MS + CLEANUP_LOCK_POLL_MS * 4,
      `the wait stopped at its deadline instead of overrunning it (took ${elapsed}ms)`,
    );
    assert.ok(
      driver.probes.length >= 3,
      "two transient unknowns do not suppress another query while budget remains",
    );
    assert.equal(driver.maxConcurrent(), 1, "a retry never runs beside the helper it replaces");
    assert.equal(driver.syncQueries(), 0, "no synchronous query gated the wait");
    assert.deepEqual(publicationResidue(stateRoot), [], "no publication candidate is left behind");
  } finally {
    await driver.restore();
    holder.send("release");
    holder.child.kill();
  }
});

test("a mismatch verdict for a replaced record never unlinks the replacement", async () => {
  const stateRoot = makeStateRoot("replaced");
  const holder = startHolder(stateRoot);
  const driver = installProbeDriver();
  const waits = createWaitCounter();
  let lock: LockHandle | null = null;
  try {
    const held = await holder.waitFor("held");
    const acquisition = prepare.__test.acquireCleanupLock(stateRoot, { onWait: () => waits.onWait() });
    await driver.allocations(1);
    // A different record for the same live owner takes the canonical entry while
    // the helper is still running. It is a genuinely new publication, so the
    // verdict about the record that was probed is obsolete.
    const owner = readOwnerRecord(stateRoot);
    assert.ok(owner !== null, "the holder's record is present to be replaced");
    writeReplacementRecord(stateRoot, owner, "replacement-nonce-value");
    // The helper now closes with a positive mismatch against the record it asked
    // about — the one that is no longer there.
    await driver.closeLiveProbe({ identity: "stale-reused-pid-identity", reason: "ok" });
    // The obsolete verdict can only be replaced by a new allocation after that
    // helper really closed, and the replacement stays untouched throughout.
    await driver.allocations(2);
    assert.equal(
      readOwnerRecord(stateRoot)?.nonce,
      "replacement-nonce-value",
      "the replacement record is never unlinked on an obsolete verdict",
    );
    assert.equal(driver.maxConcurrent(), 1, "the obsolete helper closed before the next one was allocated");
    assert.equal(driver.syncQueries(), 0, "the retry loop never ran the query inline");
    // The replacement's owner goes away, exactly as a real release would look.
    rmSync(lockPath(stateRoot), { force: true });
    lock = await acquisition;
    assert.notEqual(lock, null, "the wait still acquires the lock once the entry is genuinely free");
    assert.equal(held.pid !== process.pid, true, "the probed owner really was a foreign process");
  } finally {
    lock?.release();
    await driver.restore();
    holder.child.kill();
  }
});

test("a cancelled helper is joined before a later success instead of being discarded", async () => {
  const stateRoot = makeStateRoot("retired-join");
  const holder = startHolder(stateRoot);
  // A helper that is still alive after being cancelled: its slot is genuinely
  // "pending", which is the state that used to be dropped on the floor.
  const driver = installProbeDriver({ behavior: "ignores-cancel" });
  const waits = createWaitCounter();
  try {
    const held = await holder.waitFor("held");
    const acquisition = prepare.__test.acquireCleanupLock(stateRoot, { onWait: () => waits.onWait() });
    await driver.allocations(1);
    const owner = readOwnerRecord(stateRoot);
    assert.ok(owner !== null, "the holder's record is present to be replaced");
    // The record this helper asked about is replaced, so its verdict is obsolete
    // and the helper is cancelled...
    writeReplacementRecord(stateRoot, owner, "obsolete-verdict-nonce");
    await waits.atLeast(2);
    // ...and only then does the replacement go away, so publication can win while
    // the cancelled helper is still alive.
    rmSync(lockPath(stateRoot), { force: true });
    const lock = await acquisition;
    assert.equal(lock, null, "success is refused while a helper this wait cancelled is still alive");
    assert.equal(
      existsSync(lockPath(stateRoot)), false,
      "the record this wait published for itself is released again rather than held past its deadline",
    );
    assert.equal(countEvent(driver.events, "probe-canceled") >= 1, true, "the obsolete helper was cancelled");
    assert.equal(driver.probes.length, 1, "an alive helper is never replaced by a second allocation");
    assert.deepEqual(publicationResidue(stateRoot), [], "no publication candidate is left behind");
    assert.ok(held.pid !== process.pid, "the probed owner really was a foreign process");

    await driver.forceClose();
    await waitForSlotState("free");
    const retry = await prepare.__test.acquireCleanupLock(stateRoot);
    assert.notEqual(retry, null, "the same entry becomes acquirable once the real close has landed");
    retry?.release();
  } finally {
    await driver.restore();
    holder.send("release");
    holder.child.kill();
  }
});

test("an unconfirmed close refuses reentry and success until the helper really closes", async () => {
  const stateRoot = makeStateRoot("unconfirmed");
  const holder = startHolder(stateRoot);
  // The caller's confirmation deadline expires while the helper is still alive:
  // the state in which this process must stop presenting itself as an owner.
  const driver = installProbeDriver({ behavior: "confirmation-expires" });
  try {
    await holder.waitFor("held");
    const first = await prepare.__test.acquireCleanupLock(stateRoot);
    assert.equal(first, null, "a wait whose helper never confirmed reports unavailable coordination");
    assert.equal(seam.slotState(), "unconfirmed", "the unconfirmed close stays visible after the deadline");
    assert.equal(
      seam.startProbe(process.pid, {
        queryDeadlineMs: Date.now() + 500,
        confirmDeadlineMs: Date.now() + 600,
      }).status,
      "busy",
      "no new helper is allocated while an unconfirmed helper is alive",
    );

    // The holder goes away through its ordinary release protocol, so the entry is
    // genuinely free: this is exactly the moment an unfenced wait would take it.
    holder.send("release");
    assert.equal((await holder.waitFor("released")).present, false, "the holder released normally");
    const refused = await prepare.__test.acquireCleanupLock(stateRoot);
    assert.equal(refused, null, "lock success stays refused while a helper of this process is unconfirmed");
    assert.equal(existsSync(lockPath(stateRoot)), false, "the record published by the refused attempt is released");
    assert.equal(driver.probes.length, 1, "a fenced wait allocates nothing new");
    assert.deepEqual(publicationResidue(stateRoot), [], "no publication candidate is left behind");

    await driver.forceClose();
    await waitForSlotState("free");
    const lock = await prepare.__test.acquireCleanupLock(stateRoot);
    assert.notEqual(lock, null, "the real close, and nothing else, clears the fence");
    lock?.release();
  } finally {
    await driver.restore();
    holder.send("release");
    holder.child.kill();
  }
});

// ---------------------------------------------------------------------------
// The reclaim paths that must stay cheap and must never steal
// ---------------------------------------------------------------------------

test("a record whose owner pid is gone is reclaimed without any birth query", async () => {
  const stateRoot = makeStateRoot("dead-owner");
  const driver = installProbeDriver();
  let lock: LockHandle | null = null;
  try {
    writeFileSync(lockPath(stateRoot), `${JSON.stringify({
      schema: prepare.APPLICATION_SCHEMA,
      pid: ABANDONED_PID,
      birth: "darwin:Thu Jan  1 00:00:00 1970",
      nonce: "abandoned-nonce-value",
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");
    const startedAt = Date.now();
    lock = await prepare.__test.acquireCleanupLock(stateRoot);
    const elapsed = Date.now() - startedAt;
    assert.notEqual(lock, null, "the abandoned entry is reclaimed");
    assert.ok(elapsed < CLEANUP_LOCK_POLL_MS * 4, "a dead owner costs no more than the existing cheap reclaim guard");
    assert.equal(driver.probes.length, 0, "a dead pid never allocates a birth query");
    assert.equal(driver.syncQueries(), 0, "a dead pid never runs the query inline either");
    assert.equal(readOwnerRecord(stateRoot)?.pid, process.pid, "the reclaimed entry names the new owner");
  } finally {
    lock?.release();
    await driver.restore();
  }
});

test("this process's own record never consumes a birth query", async () => {
  const stateRoot = makeStateRoot("own-pid");
  const driver = installProbeDriver();
  let own: LockHandle | null = null;
  let lock: LockHandle | null = null;
  try {
    own = await prepare.__test.acquireCleanupLock(stateRoot);
    assert.notEqual(own, null, "this process can hold the cleanup lock");
    assert.equal(readOwnerRecord(stateRoot)?.pid, process.pid, "the entry names this process");
    const acquisition = prepare.__test.acquireCleanupLock(stateRoot, {
      onWait: () => {
        // The holder releases on the first observed poll, so the second wait has
        // to decide about its own record at least once.
        own?.release();
        own = null;
      },
    });
    lock = await acquisition;
    assert.notEqual(lock, null, "the entry is taken once this process releases it");
    assert.equal(driver.probes.length, 0, "a foreign query is never asked about this process");
    assert.equal(driver.syncQueries(), 0, "and the memoized own identity is never re-queried");
  } finally {
    own?.release();
    lock?.release();
    await driver.restore();
  }
});

test("a live record naming this process without a usable birth is honored, not reclaimed", async () => {
  const stateRoot = makeStateRoot("own-empty-birth");
  const driver = installProbeDriver();
  let own: LockHandle | null = null;
  try {
    own = await prepare.__test.acquireCleanupLock(stateRoot);
    assert.notEqual(own, null, "this process can hold the cleanup lock");
    const held = readOwnerRecord(stateRoot);
    assert.ok(held !== null, "the entry names this process");
    // A record that cannot state a usable owner birth: an unavailable identity is
    // never a mismatch, THIS pid included, exactly as in the generic owner decision.
    writeFileSync(lockPath(stateRoot), `${JSON.stringify({
      schema: prepare.APPLICATION_SCHEMA,
      pid: process.pid,
      birth: "",
      nonce: held?.nonce ?? "",
      createdAt: new Date().toISOString(),
    })}\n`, "utf8");
    const startedAt = Date.now();
    const lock = await prepare.__test.acquireCleanupLock(stateRoot);
    const elapsed = Date.now() - startedAt;
    assert.equal(lock, null, "an unrecorded owner birth is honored rather than guessed away");
    assert.equal(existsSync(lockPath(stateRoot)), true, "the record is left in place");
    assert.equal(readOwnerRecord(stateRoot)?.birth, "", "and its recorded birth is untouched");
    assert.equal(readOwnerRecord(stateRoot)?.nonce, held?.nonce, "and its nonce is untouched");
    assert.equal(driver.probes.length, 0, "no foreign query is asked about this process");
    assert.equal(driver.syncQueries(), 0, "and no synchronous query runs either");
    assert.ok(elapsed >= CLEANUP_LOCK_WAIT_MS, "the wait spent its unchanged budget rather than stealing the entry");
  } finally {
    own?.release();
    rmSync(lockPath(stateRoot), { force: true });
    await driver.restore();
  }
});

test("a successful early join leaves nothing that delays the process's own exit", async () => {
  const stateRoot = makeStateRoot("natural-exit");
  const sentinel = sentinelPath(stateRoot);
  const outcome = join(stateRoot, "contender-outcome.json");
  const holder = startHolder(stateRoot, sentinel);
  let contender: OwnedProcess | undefined;
  let contenderClosed: Promise<void> = Promise.resolve();
  try {
    // The holder confirms ownership first: a contender that won a still-vacant
    // entry would create no helper, join nothing, and pass this assertion even if
    // the timer defect came back.
    await holder.waitFor("held");
    // A contender in its own process, with no IPC channel: the acquisition promise
    // resolves promptly whether or not the join's deadline timer was cleared, so the
    // measurement has to be how long that process takes to drain and exit.
    contender = spawnOwnedProcess([HELPER, "contender", stateRoot, sentinel, outcome]);
    // Registered at spawn time so the real `close` can never be missed. This is the
    // observation ITSELF, with nothing swallowed into it and no timer of its own:
    // the unchanged bound is applied to this same promise in `finally`, so a
    // contender that never closes fails this test instead of being reported as a
    // clean exit.
    contenderClosed = closedProcess(contender);
    await waitForFile(outcome);
    const drained = JSON.parse(readFileSync(outcome, "utf8")) as { acquired: boolean; drainMs: number };
    assert.equal(drained.acquired, true, "the contender took the lock once the holder released it");
    assert.ok(
      drained.drainMs < CLEANUP_LOCK_POLL_MS * 10,
      `the contender exited on its own instead of waiting out a stale join timer (${drained.drainMs}ms)`,
    );
  } finally {
    contender?.kill();
    await boundedClose(contenderClosed, PROCESS_CLOSE_GUARD_MS, "the contender process never closed");
    holder.child.kill();
  }
});

// ---------------------------------------------------------------------------
// The real primitive: one slot, a verdict only after a real close, and a cancel
// that only ever touches its own helper
// ---------------------------------------------------------------------------

const usesOwnedHelper = process.platform === "darwin" || process.platform === "win32";

test("the owned probe answers from one helper, matches the synchronous token, and frees its slot", async () => {
  assert.equal(seam.slotState(), "free", "no helper is allocated at rest");
  if (!usesOwnedHelper) {
    // Linux answers from one /proc entry and an unknown platform has no query:
    // neither allocates a helper, and neither may fall back to the synchronous
    // query, which is the gating this primitive exists to remove.
    const settled = seam.startProbe(process.pid);
    assert.equal(settled.status, "settled", "no helper is allocated on a childless platform");
    assert.equal(seam.slotState(), "free", "a childless answer consumes no helper slot");
    return;
  }
  const started = seam.startProbe(process.pid, {
    queryDeadlineMs: Date.now() + 4_000,
    confirmDeadlineMs: Date.now() + 4_500,
  });
  assert.equal(started.status, "started", "one owned helper was allocated");
  const probe = started.probe as ProbeHandle;
  assert.equal(seam.slotState(), "pending", "the slot is held while the helper is alive");
  assert.equal(probe.verdict, undefined, "no verdict exists before the helper has closed");
  assert.equal(
    seam.startProbe(process.pid, {
      queryDeadlineMs: Date.now() + 4_000,
      confirmDeadlineMs: Date.now() + 4_500,
    }).status,
    "busy",
    "a second helper is never allocated beside a live one",
  );
  const verdict = await probe.close;
  assert.equal(probe.state, "closed", "the positive close is terminal");
  assert.equal(verdict.identity, seam.ownerStart(process.pid), "the helper reports the exact native token format");
  assert.equal(seam.slotState(), "free", "the close is what frees the slot");
  const followUp = seam.startProbe(process.pid, {
    queryDeadlineMs: Date.now() + 4_000,
    confirmDeadlineMs: Date.now() + 4_500,
  });
  assert.equal(followUp.status, "started", "a new probe is allowed after the close");
  const follow = followUp.probe as ProbeHandle;
  follow.cancel();
  await follow.close;
  assert.equal(seam.slotState(), "free", "the follow-up helper is reaped by its own close too");
});

test("cancelling the owned probe yields an unknown verdict and only its real close frees the slot", async () => {
  if (!usesOwnedHelper) {
    const settled = seam.startProbe(process.pid);
    assert.equal(settled.status, "settled");
    assert.equal(seam.slotState(), "free", "a childless answer leaves nothing to cancel");
    return;
  }
  const probe = (seam.startProbe(process.pid, {
    queryDeadlineMs: Date.now() + 4_000,
    confirmDeadlineMs: Date.now() + 4_500,
  }).probe as ProbeHandle);
  probe.cancel();
  const verdict = await probe.close;
  assert.equal(verdict.identity, "", "a canceled helper never produces a stale verdict");
  assert.equal(probe.state, "closed", "the verdict exists only because the helper really closed");
  assert.equal(seam.slotState(), "free", "the slot is freed by that close");
});

test("an expired helper budget returns unknown without allocating a helper", () => {
  if (!usesOwnedHelper) {
    const settled = seam.startProbe(process.pid);
    assert.equal(settled.status, "settled", "a childless platform has no helper to hold");
    assert.equal(seam.slotState(), "free");
    return;
  }
  const expired = Date.now() - 1;
  const started = seam.startProbe(process.pid, {
    queryDeadlineMs: expired,
    confirmDeadlineMs: expired,
  });
  assert.equal(started.status, "settled", "an expired budget cannot start a query");
  assert.equal(started.identity, "", "an expired budget supplies no identity authority");
  assert.equal(started.probe, undefined, "and no helper handle exists to cancel or join");
  assert.equal(seam.slotState(), "free", "no helper resource was allocated");
  // A confirmation deadline that cannot cover its own query is the same refusal:
  // neither deadline is stretched to make room for the other.
  const inconsistent = seam.startProbe(process.pid, {
    queryDeadlineMs: Date.now() + 5_000,
    confirmDeadlineMs: Date.now() + 10,
  });
  assert.equal(inconsistent.status, "settled", "an inconsistent deadline pair allocates nothing");
  assert.equal(inconsistent.identity, "", "and supplies no identity authority");
  assert.equal(seam.slotState(), "free", "the slot was never occupied");
});

// ---------------------------------------------------------------------------
// Absolute confirmation expiry at the status boundary
//
// The confirmation timer is what signals and escalates a helper, so a status that
// only changes when that callback runs is a statement about dispatch order, not
// about the caller's absolute deadline. A busy machine can cross the deadline
// during synchronous work and answer a caller in that same turn. These two
// regressions move the clock to a live helper's own confirmation deadline WITHOUT
// yielding to the event loop — no sleep, no spin, no blocking wait — so the timer
// provably has not dispatched, first at the status boundary and then through the
// production cleanup wait itself.
// ---------------------------------------------------------------------------

test("a helper whose confirmation deadline passed is unconfirmed before its timer dispatches", async () => {
  assert.equal(seam.slotState(), "free", "no helper is allocated at rest");
  if (!usesOwnedHelper) {
    const settled = seam.startProbe(process.pid);
    assert.equal(settled.status, "settled", "a childless platform starts no helper whose confirmation can expire");
    assert.equal(seam.slotState(), "free", "and holds no slot to expire");
    return;
  }
  const confirmAt = Date.now() + 4_500;
  const started = seam.startProbe(process.pid, {
    queryDeadlineMs: Date.now() + 4_000,
    confirmDeadlineMs: confirmAt,
  });
  assert.equal(started.status, "started", "one real owned helper was allocated");
  const probe = started.probe as ProbeHandle;
  assert.equal(seam.slotState(), "pending", "the real helper holds the slot while it is alive");
  const realNow = Date.now;
  try {
    try {
      // The clock moves to the deadline this test itself handed the primitive, and
      // nothing below yields: the confirmation timer cannot have run.
      Date.now = () => confirmAt;
      assert.equal(
        seam.slotState(),
        "unconfirmed",
        "an expired confirmation deadline reads as unconfirmed at the status boundary itself",
      );
      assert.equal(probe.verdict, undefined, "expiry creates no verdict: only the real close can");
      assert.equal(
        seam.startProbe(process.pid, {
          queryDeadlineMs: confirmAt + 500,
          confirmDeadlineMs: confirmAt + 600,
        }).status,
        "busy",
        "expiry grants no acquisition authority: the alive helper keeps the single slot busy",
      );
    } finally {
      // Restored before anything is awaited, so no timer of this process ever runs
      // against a moved clock.
      Date.now = realNow;
    }
    assert.equal(
      seam.slotState(),
      "pending",
      "the expiry reading is derived from the clock: nothing was rewritten, cleared, or signalled early",
    );
    probe.cancel();
    const verdict = await boundedClose(probe.close, GUARD_MS, "the owned helper never closed after its confirmation expired");
    assert.equal(
      verdict.identity,
      "",
      "the canceled helper's own close is the only thing that produced a verdict",
    );
    assert.equal(seam.slotState(), "free", "that positive close is what frees the slot");
  } finally {
    Date.now = realNow;
    probe.cancel();
    // The primitive terminates its own helper at its own deadlines, so this can
    // only ever wait on a helper this test really started.
    await boundedClose(probe.close, GUARD_MS, "the owned helper outlived its own deadlines");
  }
});

test("production cleanup refuses success when a helper's confirmation expired before its timer dispatched", async () => {
  assert.equal(seam.slotState(), "free", "no helper is allocated at rest");
  if (!usesOwnedHelper) {
    const settled = seam.startProbe(process.pid);
    assert.equal(settled.status, "settled", "a childless platform starts no helper whose confirmation can expire");
    assert.equal(seam.slotState(), "free", "and its cleanup wait has no owned helper to be fenced by");
    return;
  }
  const stateRoot = makeStateRoot("expired-confirm");
  // One real helper of THIS process, on a deadline the test controls. It belongs to
  // no cleanup wait, which is the point: the slot is process-global, so a later
  // wait on an unrelated state root is fenced by it.
  const confirmAt = Date.now() + 4_500;
  const started = seam.startProbe(process.pid, {
    queryDeadlineMs: Date.now() + 4_000,
    confirmDeadlineMs: confirmAt,
  });
  assert.equal(started.status, "started", "this process really owns one live helper");
  const probe = started.probe as ProbeHandle;
  const realNow = Date.now;
  let refused: LockHandle | null = null;
  let retry: LockHandle | null = null;
  try {
    try {
      Date.now = () => confirmAt;
      // The production wait runs with this process's helper past its confirmation
      // deadline and that helper's confirmation timer NOT dispatched. A vacant
      // entry publishes immediately, so the helper fence is the only thing between
      // this process and handed-back ownership, and the await below never yields to
      // the event loop: publication, the fence, and the release are one turn.
      refused = await prepare.__test.acquireCleanupLock(stateRoot);
      assert.equal(
        refused,
        null,
        "an expired, unconfirmed helper refuses lock success instead of reporting a clean acquisition",
      );
      assert.equal(
        existsSync(lockPath(stateRoot)),
        false,
        "the record the refused attempt published for itself is released again",
      );
      assert.deepEqual(publicationResidue(stateRoot), [], "no publication candidate is left behind");
      assert.equal(seam.slotState(), "unconfirmed", "this process's helper is still unconfirmed afterwards");
    } finally {
      Date.now = realNow;
    }
    assert.equal(
      seam.slotState(),
      "pending",
      "the fence is a reading of the clock, and the untouched helper is still alive",
    );
    probe.cancel();
    await boundedClose(probe.close, GUARD_MS, "the owned helper never closed after its confirmation expired");
    assert.equal(seam.slotState(), "free", "the helper's positive close is what frees the global slot");
    retry = await prepare.__test.acquireCleanupLock(stateRoot);
    assert.notEqual(retry, null, "the real close, and nothing else, clears the production fence");
  } finally {
    Date.now = realNow;
    probe.cancel();
    // Anything this wait took goes back before the join below, which is the step
    // allowed to fail: with the old status reading the acquisition above SUCCEEDS,
    // and its record must not stay held by a failing test.
    retry?.release();
    refused?.release();
    await boundedClose(probe.close, GUARD_MS, "the owned helper outlived its own deadlines");
  }
});
