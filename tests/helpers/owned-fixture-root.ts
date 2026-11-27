import type { ChildProcess } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { disposableFixtureBase } from "./scratch-fixture-base";
import { rmWithRetry } from "./temp-file-cleanup";

const { signalCleanupRefusal } = createRequire(__filename)(
  resolve(__dirname, "../../../scripts/test-scratch-refusal.cjs"),
) as {
  signalCleanupRefusal(reason?: string): () => void;
};

/** Filesystem-only evidence retention exported by scripts/test-scratch.cjs --preserve. */
export const PRESERVE_FIXTURE_FILES = process.env.PI_TEST_SCRATCH_PRESERVE === "1";

interface OwnedFixtureRecord {
  readonly root: string;
  readonly base: string;
  readonly baseReceipt: BigIntStats;
  readonly label: string;
  readonly receipt: BigIntStats;
  readonly resolveRefusal: () => void;
  readonly children: Map<ChildProcess, { closed: Promise<void>; mayHaveDescendants: () => boolean }>;
  readonly unconfirmed: string[];
  readonly onRefusal?: (reasons: readonly string[]) => void;
  disposed: boolean;
}

const CHILD_CLOSE_TIMEOUT_MS = 10_000;

/** A launcher gets a longer grace period than a plain child before it is forced. */
const LAUNCHER_CLOSE_TIMEOUT_MS = 20_000;

const ownedFixtures = new Set<OwnedFixtureRecord>();

export interface OwnedFixtureRoot {
  readonly root: string;
  /**
   * Track an owned child launched against this fixture; disposal waits for its
   * close. `mayHaveDescendants` marks a launcher: a launcher that is signaled,
   * or that has to be forced, leaves the refusal pending because its own close
   * event says nothing about the helpers it started.
   */
  trackChild(child: ChildProcess, mayHaveDescendants?: () => boolean): Promise<void>;
  /**
   * Record that a descendant of this fixture could not be positively confirmed
   * to have settled. Disposal then refuses to remove or report the root, so a
   * forced launcher exit never silently clears the invocation's refusal while a
   * descendant still uses the fixture.
   */
  reportUnconfirmedSettlement(reason: string): void;
  /** Remove this exact root by default, or report it under explicit preservation. */
  dispose(t?: TestContext): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function report(t: TestContext | undefined, line: string): void {
  if (t) t.diagnostic(line);
  process.stderr.write(`${line}\n`);
}

function observeChildClose(child: ChildProcess): Promise<void> {
  // `close` (not `exit`) is the settlement boundary: inherited output handles
  // and the child's own stdio must be gone before the fixture can be removed.
  return new Promise((resolve) => child.once("close", () => resolve()));
}

/** Wait for a previously observed close event under one finite deadline. */
export async function waitForProcessClose(closed: Promise<unknown>, timeoutMs = CHILD_CLOSE_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closed.then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Terminate one tracked child and join its close event under a finite deadline. */
export async function killProcessAndWait(
  child: ChildProcess,
  closed: Promise<unknown>,
  timeoutMs = CHILD_CLOSE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  } catch {
    // A close/timeout result below decides whether settlement was confirmed.
  }
  return waitForProcessClose(closed, timeoutMs);
}

/**
 * One ownership inspection answers all three questions disposal needs: is the
 * owned path simply gone, is this exact tree still ours, or is its ownership
 * unverified? A single lookup means a gap and a later replacement can never be
 * read as two separate, individually harmless observations.
 */
type Ownership =
  | { readonly kind: "absent" }
  | { readonly kind: "owned" }
  | { readonly kind: "refused"; readonly reason: string };

function inspectOwnership(root: string, receipt: BigIntStats): Ownership {
  let current: BigIntStats | undefined;
  try {
    current = lstatSync(root, { bigint: true, throwIfNoEntry: false });
  } catch (error) {
    return { kind: "refused", reason: `fixture root could not be verified; refusing removal: ${root}: ${message(error)}` };
  }
  if (current === undefined) return { kind: "absent" };
  try {
    if (current.isSymbolicLink() || !current.isDirectory()
      || current.dev !== receipt.dev || current.ino !== receipt.ino
      || realpathSync(root) !== root) {
      return { kind: "refused", reason: `fixture root changed identity or canonical path; refusing removal: ${root}` };
    }
  } catch (error) {
    return { kind: "refused", reason: `fixture root could not be verified; refusing removal: ${root}: ${message(error)}` };
  }
  return { kind: "owned" };
}

/** Signals that the owned tree vanished; the removal attempt must not run at all. */
class FixtureRootAlreadyAbsent extends Error {
  constructor() { super("fixture root is already absent"); }
}

async function disposeRecord(record: OwnedFixtureRecord, t?: TestContext): Promise<void> {
  if (record.disposed) return;
  record.disposed = true;
  const { root, label, receipt, base, baseReceipt, resolveRefusal } = record;
  const failures: string[] = [];

  // A root is never removed or reported as preserved until every child this
  // fixture owned has positively closed. A still-open child leaves the refusal
  // outstanding instead of letting file-level cleanup guess that it settled.
  for (const [child, { closed, mayHaveDescendants }] of record.children) {
    if (mayHaveDescendants()) {
      // A launcher is only settlement evidence when it finished on its own: a
      // signaled or forced launcher can leave a helper with redirected output
      // running inside this fixture, so the refusal stays pending.
      const closedNormally = await waitForProcessClose(closed, LAUNCHER_CLOSE_TIMEOUT_MS);
      if (!closedNormally || child.signalCode !== null) {
        failures.push(`launcher ${child.pid ?? "unknown"} did not close normally; its descendants are not confirmed settled`);
        if (!closedNormally && !(await killProcessAndWait(child, closed))) {
          failures.push(`launcher ${child.pid ?? "unknown"} did not close after termination`);
        }
      }
      continue;
    }
    const settled = child.exitCode === null && child.signalCode === null
      ? await killProcessAndWait(child, closed)
      : await waitForProcessClose(closed);
    if (!settled) {
      failures.push(`owned child ${child.pid ?? "unknown"} did not close within ${CHILD_CLOSE_TIMEOUT_MS}ms`);
    }
  }
  // An unconfirmed descendant is a settlement failure even when the launcher
  // itself closed: its own close event never proves the process tree stopped.
  failures.push(...record.unconfirmed);

  // The allocation base is fenced before the fixture path is interpreted at all:
  // a missing child is only safe to treat as absent while the base still matches
  // its device/inode receipt. Otherwise a moved base with an empty replacement
  // would read as "already absent" and disposal would report success.
  const inspectFixture = (): Ownership => {
    // The base is fenced on BOTH sides of the single fixture lookup: a base that
    // moves while that lookup is in flight would otherwise report the fixture as
    // absent and let disposal return success over a displaced tree and marker.
    const sameBase = (): boolean => inspectOwnership(base, baseReceipt).kind === "owned";
    const refused: Ownership = {
      kind: "refused", reason: `fixture allocation base changed identity or canonical path; refusing cleanup: ${base}`,
    };
    if (!sameBase()) return refused;
    const fixture = inspectOwnership(root, receipt);
    return sameBase() ? fixture : refused;
  };
  // One inspection decides existence AND identity, so a path that vanished and
  // was later replaced is never reported as this fixture's preserved root.
  const ownership = inspectFixture();
  if (ownership.kind === "refused") failures.push(ownership.reason);

  if (failures.length === 0) {
    // A missing root is already absent: there is no invocation-owned artifact to
    // remove and no unconfirmed occupant to report.
    if (ownership.kind === "absent") {
      resolveRefusal();
      return;
    }
    if (PRESERVE_FIXTURE_FILES) {
      report(t, `${label}: preserved fixture root (PI_TEST_SCRATCH_PRESERVE=1): ${root}`);
      resolveRefusal();
      return;
    }
    try {
      await rmWithRetry(root, {
        recursive: true,
        beforeAttempt: () => {
          const state = inspectFixture();
          if (state.kind === "refused") throw new Error(state.reason);
          // The owned tree vanished between attempts: stop instead of handing a
          // recursive removal to whatever may appear at that path next.
          if (state.kind === "absent") throw new FixtureRootAlreadyAbsent();
        },
      });
      if (lstatSync(root, { throwIfNoEntry: false }) !== undefined) {
        failures.push(`fixture root still exists after removal: ${root}`);
      }
    } catch (error) {
      if (!(error instanceof FixtureRootAlreadyAbsent)) {
        failures.push(`removing fixture root failed: ${root}: ${message(error)}`);
      }
    }
  }

  if (failures.length > 0) {
    // Disposal never writes a marker of its own. The marker directory lives under
    // the same base as the fixture, and disposal cannot verify that base: with a
    // replaced base and a missing fixture path, `inspectOwnership` answers
    // `absent` and a new write would land inside the replacement. The original
    // pre-allocation marker is left pending instead, and every detailed failure
    // is reported through stderr and the thrown error, so the invocation still
    // cannot be cleaned up.
    for (const failure of failures) report(t, `${label}: ${failure}`);
    record.onRefusal?.(failures);
    throw new Error(`${label} fixture cleanup failed:\n${failures.join("\n")}`);
  }
  resolveRefusal();
}

/**
 * Allocate one exclusively created fixture root outside the development
 * checkout. The root and its refusal entry are owned before any setup write;
 * `dispose()` removes only that exact directory after settlement, and explicit
 * preservation reports the same path without deleting it.
 */
export function createOwnedFixtureRoot(
  label: string,
  prefix: string,
  onRefusal?: (reasons: readonly string[]) => void,
): OwnedFixtureRoot {
  // Validate the external base before the first refusal write: a direct run
  // that inherited a checkout-local override must create nothing there.
  const base = disposableFixtureBase();
  // A canonical path is not an identity receipt: the allocation parent is
  // fenced by device/inode as well, before the refusal is registered, again
  // immediately before the exclusive allocation, and once more after the child
  // receipt is captured, so a real directory swapped into the base location can
  // never be adopted as this fixture's home.
  const baseReceipt = lstatSync(base, { bigint: true });
  const requireSameBase = (): void => {
    if (inspectOwnership(base, baseReceipt).kind !== "owned" || disposableFixtureBase() !== base) {
      throw new Error(`fixture allocation base changed identity or canonical path: ${base}`);
    }
  };
  requireSameBase();
  const resolveRefusal = signalCleanupRefusal(`${label} fixture cleanup pending`);
  const refuseSetup = (location: string, error: unknown): void => {
    const reason = `${label} fixture setup ownership is unconfirmed: ${location}: ${message(error)}`;
    report(undefined, reason);
    onRefusal?.([reason]);
  };
  try {
    requireSameBase();
  } catch (error) {
    refuseSetup(base, error);
    throw error;
  }
  let root: string;
  try {
    root = mkdtempSync(join(base, prefix));
  } catch (error) {
    resolveRefusal();
    throw error;
  }
  let receipt: BigIntStats;
  try {
    receipt = lstatSync(root, { bigint: true });
    if (receipt.isSymbolicLink() || !receipt.isDirectory() || realpathSync(root) !== root) {
      throw new Error(`allocated fixture root is not a canonical real directory: ${root}`);
    }
    requireSameBase();
  } catch (error) {
    // Same rule as disposal: the base's identity is exactly what failed here, so
    // a second marker write could land inside a replacement directory. The
    // original pre-allocation refusal is left pending and this is only reported.
    refuseSetup(root, error);
    throw error;
  }
  const record: OwnedFixtureRecord = {
    root, label, receipt, base, baseReceipt, resolveRefusal, onRefusal, children: new Map(), unconfirmed: [], disposed: false,
  };
  ownedFixtures.add(record);
  return {
    root,
    trackChild: (child: ChildProcess, mayHaveDescendants: () => boolean = () => false) => {
      let tracked = record.children.get(child);
      if (!tracked) {
        tracked = { closed: observeChildClose(child), mayHaveDescendants };
        record.children.set(child, tracked);
      }
      return tracked.closed;
    },
    reportUnconfirmedSettlement: (reason: string) => {
      if (!record.unconfirmed.includes(reason)) record.unconfirmed.push(reason);
    },
    dispose: (t?: TestContext) => disposeRecord(record, t),
  };
}

/** File-level finalizer for roots whose test body did not dispose them itself. */
export async function disposeOwnedFixtures(t?: TestContext): Promise<void> {
  const failures: unknown[] = [];
  for (const record of [...ownedFixtures]) {
    try {
      await disposeRecord(record, t);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "owned fixture cleanup failed");
}
