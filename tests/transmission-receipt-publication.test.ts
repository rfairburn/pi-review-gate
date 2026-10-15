/*
 * Publication-stage parity pins for the review-delivery receipt writer (#244
 * groundwork): writeReviewDeliveryReceipt -> writeReviewDeliveryReceiptAtomically.
 *
 * These tests exercise the production receipt path only — no copy of the
 * writer's algorithm — and pin the contract #244 must preserve while equivalent
 * atomic publication mechanics are consolidated elsewhere:
 *   - stage order write -> fsync -> close -> rename -> parent-directory
 *     open/sync/close, with NO chmod step (the receipt asks for a mode and never
 *     forces one — the deliberate difference from the settings writer);
 *   - mode policy: the existing target's raw mode is requested verbatim, with no
 *     tightening (0644 stays 0644 where config would tighten it to 0600, and
 *     0400 stays 0400), and an absent target is tolerated so a first receipt is
 *     published at the platform default mode;
 *   - because the mode is only requested, a restrictive umask narrows it (pinned
 *     in a scoped, serial, finally-restored umask window with a plain-write
 *     control in the same directory): this is recorded current behavior, not an
 *     endorsed guarantee, and it is why the receipt cannot share the settings
 *     writer's chmod-forced mode policy;
 *   - every pre-publication fault (write, fsync, close, rename) leaves the
 *     previous committed receipt byte-identical, attempts exactly one unlink of
 *     the owned temp name, propagates the original error object unchanged, and
 *     never touches another writer's temp files;
 *   - error precedence: the publication error wins over a failing best-effort
 *     close (unlike the session-state sidecar's close-wins contract);
 *   - the whole parent-directory stage is tolerated after the committed rename —
 *     open, sync AND close failures never fail a committed receipt (the settings
 *     writer is the one writer whose directory close can still report failure);
 *   - a collision at the chosen temp name currently gets unlinked by the
 *     unconditional failure-path cleanup. Recorded as a known gap (parity with
 *     today's writer, deliberately NOT an endorsed ownership contract, and
 *     deliberately not fixed by #244);
 *   - no-mkdir: the receipt writer never creates a missing invocation directory.
 *
 * Faults are injected without adding any production seam: the compiled writer
 * resolves fs/promises open, rename, unlink and crypto.randomUUID per call, so
 * for the duration of one awaited receipt write the test wraps those builtins
 * and delegates everything else (real handles, real fsyncs, real rename, real
 * EEXIST, real stat) to the genuine implementations. The wrapper records the
 * observed stage sequence, the exact exclusive-create request, every chmod
 * request (which must stay empty), and every path production passed to unlink.
 *
 * Handle hygiene: an injected close fault throws before the real handle closes,
 * so the helper tracks every real handle it hands out and closes any handle
 * production did not already close — bypassing the fault wrapper — once the
 * receipt write settles. No descriptor is left to GC-closing (DEP0137).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  __testOnly_getReviewDeliveryReceiptTailCount,
  writeReviewDeliveryReceipt,
} from "../src/transmission";

type FspModule = Record<string, any>;

interface InjectionPlan {
  failWrite?: Error;
  failSync?: Error;
  failClose?: Error;
  failRename?: Error;
  /** Fault for the failure-path cleanup unlink only. */
  failUnlink?: Error;
  /** Faults for the post-rename parent-directory sync stage. */
  failDirOpen?: Error;
  failDirSync?: Error;
  failDirClose?: Error;
}

interface InjectionOutcome {
  error?: unknown;
  /** Exact temp path the production writer created (or attempted). */
  tempPath?: string;
  /** Flags/mode production requested for its exclusive create. */
  openFlags?: string | number;
  openMode?: number | undefined;
  /** Physical mode of the staged temp observed right after the create. */
  stagedModeAfterCreate?: number;
  /** Modes production passed to the staged handle's chmod (must stay empty). */
  chmodRequests: number[];
  /** Stages that completed (in order). */
  stages: string[];
  /** Stages that were attempted, including the one that faulted. */
  attempts: string[];
  /** Every path production passed to fs/promises unlink, in attempt order. */
  unlinkAttempts: string[];
  /** Directory production opened read-only for the post-rename sync. */
  dirPath?: string;
}

/**
 * Run one awaited receipt write with production-path fault injection.
 * fs/promises open, rename and unlink are wrapped (plus crypto.randomUUID for a
 * deterministic temp name); the staged FileHandle and the read-only directory
 * handle are wrapped so planned stages reject. Everything else delegates to the
 * real implementations, and patches are restored only after the write settles.
 */
async function withInjectedFault(
  plan: InjectionPlan,
  run: () => Promise<unknown>,
  randomUuid?: () => string,
): Promise<InjectionOutcome> {
  const bareRequire = createRequire(__filename);
  const fsp = bareRequire("node:fs/promises") as FspModule;
  const crypto = bareRequire("node:crypto") as FspModule;
  const realOpen = fsp.open;
  const realRename = fsp.rename;
  const realUnlink = fsp.unlink;
  const realRandomUuid = crypto.randomUUID;
  const outcome: InjectionOutcome = {
    chmodRequests: [], stages: [], attempts: [], unlinkAttempts: [],
  };
  const openBinding = realOpen.bind(fsp);
  const renameBinding = realRename.bind(fsp);
  const unlinkBinding = realUnlink.bind(fsp);
  /** Every real handle handed to production this run, for guaranteed close. */
  const trackedHandles: Array<{ real: any; productionClosed: boolean }> = [];

  fsp.open = async (path: string, flags: string | number, mode?: number) => {
    if (flags === "wx") {
      // The only exclusive create in this window is the writer's own temp
      // staging open; record the requested create contract before wrapping.
      outcome.tempPath = path;
      outcome.openFlags = flags;
      outcome.openMode = mode;
      const real = await openBinding(path, flags, mode);
      try {
        outcome.stagedModeAfterCreate = statSync(path).mode & 0o777;
      } catch {
        outcome.stagedModeAfterCreate = undefined;
      }
      const tracked = { real, productionClosed: false };
      trackedHandles.push(tracked);
      return {
        writeFile: async (data: unknown, encoding?: string) => {
          outcome.attempts.push("write");
          if (plan.failWrite) throw plan.failWrite;
          await real.writeFile(data as any, encoding);
          outcome.stages.push("write");
        },
        chmod: async (chmodMode: number) => {
          // The receipt writer must never force a mode; record any request so
          // the "requested-only mode" contract stays observable.
          outcome.chmodRequests.push(chmodMode);
          return real.chmod(chmodMode);
        },
        sync: async () => {
          outcome.attempts.push("sync");
          if (plan.failSync) throw plan.failSync;
          await real.sync();
          outcome.stages.push("sync");
        },
        close: async () => {
          outcome.attempts.push("close");
          if (plan.failClose) throw plan.failClose;
          const value = await real.close();
          tracked.productionClosed = true;
          outcome.stages.push("close");
          return value;
        },
      };
    }
    if (flags === "r") {
      // The post-rename parent-directory sync open.
      outcome.dirPath = path;
      outcome.attempts.push("dir-open");
      if (plan.failDirOpen) throw plan.failDirOpen;
      // Windows directory handles/fsync are not portable. On that host this
      // tests call ordering and fault tolerance with a mock, not native fsync.
      const real = process.platform === "win32"
        ? { sync: async () => undefined, close: async () => undefined }
        : await openBinding(path, flags, mode);
      const tracked = { real, productionClosed: false };
      trackedHandles.push(tracked);
      return {
        sync: async () => {
          outcome.attempts.push("dir-sync");
          if (plan.failDirSync) throw plan.failDirSync;
          await real.sync();
          outcome.stages.push("dir-sync");
        },
        close: async () => {
          outcome.attempts.push("dir-close");
          if (plan.failDirClose) throw plan.failDirClose;
          const value = await real.close();
          tracked.productionClosed = true;
          outcome.stages.push("dir-close");
          return value;
        },
      };
    }
    return openBinding(path, flags, mode);
  };
  fsp.rename = (from: string, to: unknown) => {
    outcome.attempts.push("rename");
    if (plan.failRename) throw plan.failRename;
    return renameBinding(from, to).then((value: unknown) => {
      outcome.stages.push("rename");
      return value;
    });
  };
  fsp.unlink = (path: string) => {
    outcome.unlinkAttempts.push(path);
    if (plan.failUnlink) return Promise.reject(plan.failUnlink);
    return unlinkBinding(path);
  };
  if (randomUuid) crypto.randomUUID = randomUuid;
  try {
    await run();
    return outcome;
  } catch (error) {
    return { ...outcome, error };
  } finally {
    fsp.open = realOpen;
    fsp.rename = realRename;
    fsp.unlink = realUnlink;
    crypto.randomUUID = realRandomUuid;
    await Promise.all(trackedHandles.map((tracked) => {
      if (tracked.productionClosed) return Promise.resolve();
      tracked.productionClosed = true; // one genuine close attempt, success or not
      return tracked.real.close().catch(() => undefined);
    }));
  }
}

const PRIOR_RECEIPT_BYTES = '{"recipient":"implementing_model","deliveries":[{"sequence":1,"deliveredAt":"2020-01-01T00:00:00.000Z","action":"passed","idempotencyKey":"prior","content":"implementing-model-transmission.md"}]}\n';
const FOREIGN_TEMPS = [
  ".delivery.json.999998.foreign-writer.tmp",
  ".delivery.json.older-crashed-writer.tmp",
];

function setupFixture(label: string, options: { targetMode?: number; priorReceipt?: boolean } = {}): { dir: string; targetPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `pi-review-244-receipt-${label}-`));
  const targetPath = join(dir, "delivery.json");
  try {
    if (options.priorReceipt !== false) {
      writeFileSync(targetPath, PRIOR_RECEIPT_BYTES, "utf8");
    }
    if (options.targetMode !== undefined) chmodSync(targetPath, options.targetMode);
    for (const name of FOREIGN_TEMPS) {
      writeFileSync(join(dir, name), `another writer's temp: ${name}\n`, "utf8");
    }
    return { dir, targetPath };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function writeReceipt(dir: string, key = "next"): Promise<void> {
  return writeReviewDeliveryReceipt(dir, "deferred", "pinned message", key);
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertSurvivalSet(dir: string, extras: string[] = []): void {
  assert.deepEqual(readdirSync(dir).sort(), ["delivery.json", ...FOREIGN_TEMPS, ...extras].sort(),
    "only this invocation's owned unpublished temp may be removed; everything else must remain");
}

/** The receipt writer's own temp naming shape: `.delivery.json.<pid>.<uuid>.tmp`. */
function assertTempNaming(dir: string, tempPath: string | undefined): asserts tempPath is string {
  assert.ok(tempPath, "the production writer must have attempted its exclusive temp open");
  assert.equal(dirname(tempPath), resolve(dir), "the temp file must be staged in the target's own directory");
  const name = basename(tempPath);
  const prefix = ".delivery.json.";
  assert.ok(name.startsWith(prefix) && name.endsWith(".tmp") && name.length > prefix.length + ".tmp".length,
    `temp name must keep the production .delivery.json.<pid>.<uuid>.tmp shape: ${tempPath}`);
}

function assertPrePublicationContract(
  dir: string,
  targetPath: string,
  outcome: InjectionOutcome,
  injected: Error,
): void {
  assertTempNaming(dir, outcome.tempPath);
  assert.equal(outcome.openFlags, "wx", "the exclusive create must request the wx flag");
  assert.deepEqual(outcome.chmodRequests, [], "the receipt writer must never chmod: its mode is requested, not forced");
  assert.equal(exists(outcome.tempPath), false, "the owned unpublished temp must be cleaned after the failure");
  assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
    "cleanup must attempt exactly one unlink of exactly the owned temp path (never the final or foreign path)");
  assert.ok(readFileSync(targetPath).equals(Buffer.from(PRIOR_RECEIPT_BYTES, "utf8")),
    "previous committed receipt bytes must be unchanged");
  assert.equal(outcome.error, injected, "the original publication error object must propagate unchanged");
  assert.ok(!outcome.stages.includes("rename"), "the commit must never complete for a pre-publication failure");
  assertSurvivalSet(dir);
  assert.equal(__testOnly_getReviewDeliveryReceiptTailCount(), 0,
    "a failed receipt write must not wedge the per-directory serialization tail");
}

test("successful receipt write publishes write -> fsync -> close -> rename -> directory sync with no chmod and no temp litter", async () => {
  const { dir, targetPath } = setupFixture("success");
  try {
    const outcome = await withInjectedFault({}, () => writeReceipt(dir));
    assert.equal(outcome.error, undefined, "the receipt write must succeed");
    assert.deepEqual(outcome.stages, ["write", "sync", "close", "rename", "dir-sync", "dir-close"],
      "receipt stage order must stay write, fsync, close, rename, then the parent-directory sync and close");
    assertTempNaming(dir, outcome.tempPath);
    assert.equal(outcome.openFlags, "wx", "the receipt temp must be created exclusively");
    assert.deepEqual(outcome.chmodRequests, [], "the receipt writer must not force a mode");
    assert.equal(outcome.dirPath, resolve(dir), "the directory sync must target the receipt's own directory");
    assert.deepEqual(outcome.unlinkAttempts, [], "a successful rename must never attempt an unlink");
    if (process.platform !== "win32") {
      // The fixture's own mode was produced under this process umask, so the
      // published mode must equal the requested prior-target mode exactly.
      assert.equal(statSync(targetPath).mode & 0o777, outcome.openMode,
        "the published receipt carries the prior target's mode, requested and preserved");
    }
    const receipt = JSON.parse(readFileSync(targetPath, "utf8")) as {
      deliveries: Array<{ idempotencyKey: string; sequence: number }>;
    };
    assert.deepEqual(receipt.deliveries.map((entry) => entry.idempotencyKey), ["prior", "next"]);
    assert.deepEqual(receipt.deliveries.map((entry) => entry.sequence), [1, 2]);
    assertSurvivalSet(dir);
    assert.equal(__testOnly_getReviewDeliveryReceiptTailCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const prePublicationFaults: Array<{ label: string; key: "failWrite" | "failSync" | "failRename"; stage: string; injected: Error }> = [
  { label: "write", key: "failWrite", stage: "write", injected: Object.assign(new Error("disk full while staging receipt"), { code: "EIO" }) },
  { label: "sync", key: "failSync", stage: "sync", injected: Object.assign(new Error("fsync refused while staging receipt"), { code: "EIO" }) },
  { label: "rename", key: "failRename", stage: "rename", injected: Object.assign(new Error("rename refused while publishing receipt"), { code: "EXDEV" }) },
];

for (const fault of prePublicationFaults) {
  test(`receipt ${fault.label} failure: owned temp cleaned, prior committed bytes unchanged, original error propagated`, async () => {
    const { dir, targetPath } = setupFixture(`fail-${fault.label}`);
    try {
      const outcome = await withInjectedFault({ [fault.key]: fault.injected } as InjectionPlan, () => writeReceipt(dir));
      assertPrePublicationContract(dir, targetPath, outcome, fault.injected);
      if (fault.stage !== "write") {
        assert.ok(outcome.attempts.includes("write"), "the staged write must precede the faulted stage");
      }
      if (fault.stage === "rename") {
        assert.deepEqual(outcome.stages, ["write", "sync", "close"],
          "every stage before the commit must have completed before the rename fault");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("receipt close failure: the close error propagates, no rename is attempted, prior bytes survive, owned temp is cleaned", async () => {
  const { dir, targetPath } = setupFixture("fail-close");
  const injected = Object.assign(new Error("close refused while staging receipt"), { code: "EIO" });
  try {
    const outcome = await withInjectedFault({ failClose: injected }, () => writeReceipt(dir));
    assertPrePublicationContract(dir, targetPath, outcome, injected);
    assert.deepEqual(outcome.stages, ["write", "sync"],
      "write and fsync must both complete before the failing close");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt double fault: a failing close never replaces the publication error (receipt precedence is close-swallowing, unlike the sidecar)", async () => {
  const { dir, targetPath } = setupFixture("double-fault");
  const staged = Object.assign(new Error("disk full while staging receipt"), { code: "EIO" });
  const closeInjected = Object.assign(new Error("close refused after a failing staging write"), { code: "EIO" });
  try {
    const outcome = await withInjectedFault({ failWrite: staged, failClose: closeInjected }, () => writeReceipt(dir));
    assert.equal(outcome.error, staged,
      "the receipt writer reports the publication error; its catch-path close is best-effort");
    assert.notEqual(outcome.error, closeInjected,
      "receipt precedence must not drift to the sidecar's close-wins contract");
    assert.deepEqual(outcome.attempts.filter((stage) => stage === "close"), ["close"],
      "the best-effort close is still attempted exactly once");
    assertPrePublicationContract(dir, targetPath, outcome, staged);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt cleanup unlink failure: the publication error escapes unchanged and the owned temp legitimately remains", async () => {
  const { dir, targetPath } = setupFixture("unlink-fault");
  const injected = Object.assign(new Error("disk full while staging receipt"), { code: "EIO" });
  const unlinkInjected = Object.assign(new Error("unlink refused for the owned unpublished temp"), { code: "EPERM" });
  try {
    const outcome = await withInjectedFault({ failWrite: injected, failUnlink: unlinkInjected }, () => writeReceipt(dir));
    assert.equal(outcome.error, injected, "the original publication error must escape unchanged");
    assert.notEqual(outcome.error, unlinkInjected, "a best-effort cleanup failure must never replace the publication error");
    assertTempNaming(dir, outcome.tempPath);
    assert.equal(exists(outcome.tempPath), true,
      "the owned unpublished temp legitimately remains when the best-effort cleanup unlink itself fails");
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
      "cleanup must attempt only the owned temp path, exactly once");
    assert.ok(readFileSync(targetPath).equals(Buffer.from(PRIOR_RECEIPT_BYTES, "utf8")),
      "previous committed receipt bytes must be unchanged");
    assertSurvivalSet(dir, [basename(outcome.tempPath)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt mode policy: the existing target's raw mode is requested and preserved without tightening", { skip: process.platform === "win32" }, async () => {
  const mask = process.umask();
  for (const existingMode of [0o400, 0o600, 0o640, 0o644] as const) {
    const { dir, targetPath } = setupFixture(`mode-${existingMode.toString(8)}`, { targetMode: existingMode });
    // The receipt only *requests* a mode, so the observable result is the
    // requested mode under the running process umask (see the dedicated umask
    // pin below for the explicit narrowing evidence).
    const expectedMode = existingMode & ~mask;
    try {
      const outcome = await withInjectedFault({}, () => writeReceipt(dir));
      assert.equal(outcome.error, undefined, `the receipt write must succeed for a 0o${existingMode.toString(8)} target`);
      assert.equal(outcome.openMode, existingMode,
        `the exclusive create must request the raw existing mode 0o${existingMode.toString(8)} — the receipt never tightens (config does)`);
      assert.deepEqual(outcome.chmodRequests, [], "the receipt must not force the mode with chmod");
      assert.equal(statSync(targetPath).mode & 0o777, expectedMode,
        `published receipt must carry the requested 0o${existingMode.toString(8)} mode unmodified under this process umask (0o${mask.toString(8)}), i.e. no tightening`);
      assertSurvivalSet(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("receipt tolerates an absent target and publishes the platform default mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-244-receipt-absent-"));
  const targetPath = join(dir, "delivery.json");
  try {
    for (const name of FOREIGN_TEMPS) writeFileSync(join(dir, name), `another writer's temp: ${name}\n`, "utf8");
    const control = join(dir, "plain-write-control");
    writeFileSync(control, "control\n", "utf8");
    const platformMode = statSync(control).mode & 0o777;
    const outcome = await withInjectedFault({}, () => writeReceipt(dir));
    assert.equal(outcome.error, undefined, "the first receipt must publish even with no prior target to stat");
    assert.equal(outcome.openMode, undefined,
      "an absent target must be tolerated: the create requests no mode at all (config fails closed instead)");
    assert.equal(statSync(targetPath).mode & 0o777, platformMode,
      "a first receipt carries exactly the mode a plain write would produce");
    rmSync(control, { force: true });
    assertSurvivalSet(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt mode is requested, not enforced: a restrictive umask narrows it because the receipt never chmods", { skip: process.platform === "win32" }, async () => {
  // Scoped, serial and restored in finally: node runs each test file in its own
  // process and this file's top-level tests sequentially, so the mask cannot
  // overlap another suite.
  const { dir, targetPath } = setupFixture("umask", { targetMode: 0o644 });
  const previousMask = process.umask(0o077);
  try {
    const control = join(dir, "plain-write-control");
    writeFileSync(control, "control\n", "utf8");
    assert.equal(statSync(control).mode & 0o777, 0o600,
      "the restricted mask must genuinely suppress group/other bits on this filesystem");

    const outcome = await withInjectedFault({}, () => writeReceipt(dir));
    assert.equal(outcome.error, undefined, "the receipt write must succeed under the restrictive umask");
    assert.equal(outcome.openMode, 0o644, "the create must still request the raw existing 0644 mode");
    assert.deepEqual(outcome.chmodRequests, [], "the receipt must not chmod, so nothing restores the masked bits");
    assert.equal(statSync(targetPath).mode & 0o777, 0o600,
      "RECORDED CURRENT BEHAVIOR: the published receipt is umask-narrowed (0600), i.e. receipt mode preservation is requested-only. #244 neither fixes nor worsens this; the settings writer's forced chmod is what makes its preserved mode exact.");
    assert.equal(outcome.stagedModeAfterCreate, 0o600,
      "the staged file itself is created narrower than requested, proving the published mode comes from the umask and not from a chmod");
    rmSync(control, { force: true });
    assertSurvivalSet(dir);
  } finally {
    process.umask(previousMask);
    assert.equal(process.umask(), previousMask, "the test must restore the process umask");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipt collision at the chosen temp name: current unconditional cleanup removes the unowned temp (recorded known gap, not an endorsed contract) while prior bytes survive", async () => {
  const { dir, targetPath } = setupFixture("collision");
  const fixedUuid = "123e4567-0000-4000-8000-000000000002";
  const collisionPath = join(resolve(dir), `.delivery.json.${process.pid}.${fixedUuid}.tmp`);
  try {
    writeFileSync(collisionPath, "a file this invocation never created\n", "utf8");
    const outcome = await withInjectedFault({}, () => writeReceipt(dir), () => fixedUuid);
    assert.equal(outcome.tempPath, collisionPath, "production must target exactly the colliding temp name");
    assert.equal(outcome.openFlags, "wx", "the failed create must still request the exclusive-create flag");
    const error = outcome.error as NodeJS.ErrnoException | undefined;
    assert.equal(error?.code, "EEXIST", "the genuine exclusive-create EEXIST must propagate");
    assert.equal(exists(collisionPath), false,
      "RECORDED CURRENT BEHAVIOR (#244 gap, deliberately unchanged and not endorsed): the receipt writer's failure path unlinks the temp name unconditionally, so a pre-existing collision is deleted even though this invocation never owned it");
    assert.deepEqual(outcome.unlinkAttempts, [collisionPath],
      "the unconditional cleanup attempt must still be scoped to the single temp path");
    assert.ok(readFileSync(targetPath).equals(Buffer.from(PRIOR_RECEIPT_BYTES, "utf8")),
      "previous committed receipt bytes must be unchanged");
    assertSurvivalSet(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, plan] of [
  ["open", { failDirOpen: Object.assign(new Error("directory open refused"), { code: "EPERM" }) }],
  ["sync", { failDirSync: Object.assign(new Error("directory fsync refused"), { code: "EINVAL" }) }],
  ["close", { failDirClose: Object.assign(new Error("directory close refused"), { code: "EIO" }) }],
] as const) {
  test(`receipt parent-directory ${label} failure is tolerated after the committed rename`, async () => {
    const { dir, targetPath } = setupFixture(`dir-${label}`);
    try {
      const outcome = await withInjectedFault(plan, () => writeReceipt(dir));
      assert.equal(outcome.error, undefined,
        `a parent-directory ${label} failure must never fail a receipt whose rename already committed`);
      assert.ok(outcome.stages.includes("rename"), "the commit must have happened");
      assert.ok(readFileSync(targetPath, "utf8").includes("\"next\""), "the new receipt content is committed");
      assert.deepEqual(outcome.unlinkAttempts, [],
        "a tolerated directory-sync failure must not trigger temp cleanup for a rename-consumed temp");
      assertSurvivalSet(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("receipt write never creates a missing invocation directory (no-mkdir refusal)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-244-receipt-no-mkdir-"));
  const missingDir = join(dir, "missing-invocation");
  try {
    const outcome = await withInjectedFault({}, () => writeReceipt(missingDir));
    const error = outcome.error as NodeJS.ErrnoException | undefined;
    assert.ok(error, "the receipt write must fail when the invocation directory does not exist");
    assert.equal(error?.code, "ENOENT", "the failure must be the genuine missing-directory error");
    assert.equal(exists(missingDir), false, "the receipt writer must never create a missing invocation directory");
    assertTempNaming(missingDir, outcome.tempPath);
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
      "the unconditional failure-path cleanup still attempts the temp name it never created (best-effort ENOENT)");
    assert.deepEqual(readdirSync(dir).sort(), [], "the fixture directory must stay empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
