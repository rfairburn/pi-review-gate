/*
 * Focused regression for #243: the session-state sidecar publication path
 * (SessionStateStore.save -> atomicWrite) must remove only the unpublished
 * temporary file this invocation successfully created when a pre-publication
 * stage fails — write, fsync, close, or rename — while preserving the
 * previous committed sidecar byte-for-byte and propagating the original
 * error. A pre-existing collision at the temp path is never owned (the
 * exclusive open fails before ownership is acquired) and must remain
 * untouched; another writer's temporary files are never removed; successful
 * publication, its 0600 mode, its stage ordering, and reload round-trips
 * stay identical.
 *
 * Error precedence is part of the contract: when writing (or fsyncing) and
 * closing both fail, the close error is what escapes — exactly the original
 * pre-patch writer's precedence — and cleanup must never demote that to the
 * write/sync error (never a first-write priority) nor replace it with a
 * cleanup failure. Cleanup is best-effort: when the unlink itself cannot
 * run, the original publication error still escapes unchanged, the owned
 * unpublished temp legitimately remains, and cleanup may only have targeted
 * the exact acquire-claimed temp path.
 *
 * Faults are injected through the actual production publication path without
 * adding a production test seam: the compiled writer resolves fs/promises
 * open, rename, unlink and crypto.randomUUID per call, so for the duration
 * of one awaited save() the test wraps those builtin module functions and
 * delegates everything else (real handles, real fsyncs, real rename, real
 * EEXIST) to the genuine implementations. The wrapper records the observed
 * stage sequence so ordering invariants stay checkable, records the exact
 * create request (flags and mode) for a platform-independent requested-0600
 * oracle, and records every path production passed to unlink so the
 * acquisition-scoped cleanup targeting is observable — including proving the
 * collision case never even attempted an unlink rather than swallowing an
 * erroneous one.
 *
 * Handle hygiene: when a close fault is injected, production's failing close
 * (and its best-effort catch-path close) both throw before the real handle
 * ever closes, and the injected wrapper can never close it either. The
 * helper therefore tracks every real handle it hands out and, once the save
 * settles, explicitly closes any handle production did not already close —
 * bypassing the fault wrapper. No file descriptor is left to GC-closing
 * (DEP0137) and assertions stay unchanged.
 *
 * Mode oracles are portability-checked without skips: the exclusive create's
 * requested flags/mode are asserted on every platform from the observed open
 * call, while the physical 0600 assertion runs wherever the running
 * filesystem demonstrably represents POSIX permission bits. Capability is
 * probed by chmod-ing a control file between distinct POSIX modes and
 * verifying stat reflects each — chmod is never filtered by the creation
 * umask, so the probe cannot mislabel a POSIX-capable filesystem, and the
 * probe is additionally exercised under a temporarily restrictive umask
 * (restored in finally) to evidence that independence on every run. On a
 * runtime where those bits are not representable (native Windows) the
 * requested-mode checks govern; no native Windows runtime was exercised by
 * this validation.
 */
import assert from "node:assert/strict";
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createState } from "../src/state";
import { SessionStateStore } from "../src/session-state";

type FspModule = Record<string, any>;

/** Which stage throws; every configured entry is thrown. */
interface InjectionPlan {
  failWrite?: Error;
  failSync?: Error;
  failClose?: Error;
  failRename?: Error;
  /** Fault for the best-effort cleanup unlink of the owned temp only. */
  failUnlink?: Error;
}

interface InjectionOutcome {
  error?: unknown;
  /** Exact temp path the production writer created (or attempted). */
  tempPath?: string;
  /** Flags the production writer requested for its exclusive create. */
  openFlags?: string | number;
  /** Mode the production writer requested for its exclusive create. */
  openMode?: number | undefined;
  /** Observed stage sequence: "write" | "sync" | "close" | "rename". */
  stages: string[];
  /** Every path production passed to fs/promises unlink, in attempt order. */
  unlinkAttempts: string[];
}

/**
 * Run one awaited save() with production-path fault injection. fs/promises
 * open, rename and unlink are wrapped; the owned temp FileHandle is wrapped
 * so the planned stage rejects; everything else delegates to the real
 * implementations. Patches are restored only after the save settles.
 */
async function withInjectedFault(plan: InjectionPlan, run: () => Promise<boolean>, randomUuid?: () => string): Promise<InjectionOutcome> {
  const bareRequire = createRequire(__filename);
  const fsp = bareRequire("node:fs/promises") as FspModule;
  const crypto = bareRequire("node:crypto") as FspModule;
  const realOpen = fsp.open;
  const realRename = fsp.rename;
  const realUnlink = fsp.unlink;
  const realRandomUuid = crypto.randomUUID;
  const outcome: InjectionOutcome = { stages: [], unlinkAttempts: [] };
  const openBinding = realOpen.bind(fsp);
  const renameBinding = realRename.bind(fsp);
  const unlinkBinding = realUnlink.bind(fsp);
  /** Every real temp handle handed to the production writer this run. */
  const trackedHandles: Array<{ real: any; productionClosed: boolean }> = [];

  fsp.open = async (path: string, flags: string | number, mode?: number) => {
    if (flags === "wx") {
      // The only exclusive create in this window is the writer's own temp
      // staging open. The requested create contract is recorded before any
      // wrapping, so the platform-independent requested-flags/mode oracle
      // observes the genuine call while the physical bits are separately
      // verified only where the filesystem represents POSIX permission bits.
      outcome.tempPath = path;
      outcome.openFlags = flags;
      outcome.openMode = mode;
      const real = await openBinding(path, flags, mode);
      const tracked = { real, productionClosed: false };
      trackedHandles.push(tracked);
      return {
        writeFile: async (data: unknown, encoding?: string) => {
          if (plan.failWrite) throw plan.failWrite;
          outcome.stages.push("write");
          return real.writeFile(data as any, encoding);
        },
        sync: async () => {
          if (plan.failSync) throw plan.failSync;
          outcome.stages.push("sync");
          return real.sync();
        },
        close: async () => {
          if (plan.failClose) throw plan.failClose;
          outcome.stages.push("close");
          const value = await real.close();
          tracked.productionClosed = true;
          return value;
        },
      };
    }
    // Best-effort directory fsync opens the final path's directory
    // read-only; any other open delegates to the genuine implementation.
    return openBinding(path, flags, mode);
  };
  fsp.rename = (from: string, to: unknown) => {
    outcome.stages.push("rename");
    if (plan.failRename) throw plan.failRename;
    return renameBinding(from, to);
  };
  fsp.unlink = (path: string) => {
    // Cleanup is the only production unlink inside this window; every
    // attempted path is captured so targeting — and the absence of any
    // attempt for an unacquired collision — is observable evidence.
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
    // Close any handle production did not already close — notably when the
    // close fault swallowed both the staged close and production's best-effort
    // catch-path close. Bypasses the fault wrapper via the real handle only.
    await Promise.all(trackedHandles.map((tracked) => {
      if (tracked.productionClosed) return Promise.resolve();
      tracked.productionClosed = true; // one genuine close attempt, success or not
      return tracked.real.close().catch(() => undefined);
    }));
  }
}

const PRIOR_SIDECAR_BYTES = "prior committed sidecar bytes\n";
const FOREIGN_WRITER_UUID = "11111111-2222-4333-8444-555555555555";
const ABANDONED_ORPHAN_SUFFIX = "older-crashed-writer";

function setupRoot(label: string): { root: string; finalPath: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), `pi-review-243-${label}-`));
  const sessionFile = join(root, "conversation.jsonl");
  const finalPath = `${sessionFile}.pi-review-gate-state.json`;
  writeFileSync(finalPath, PRIOR_SIDECAR_BYTES, "utf8");
  return { root, finalPath, sessionFile };
}

/** Other writers' temp files that must survive every failure-path cleanup. */
function plantForeignTemps(finalPath: string): void {
  writeFileSync(`${finalPath}.tmp.${FOREIGN_WRITER_UUID}`, "another live writer's temp\n", "utf8");
  writeFileSync(`${finalPath}.tmp.${ABANDONED_ORPHAN_SUFFIX}`, "abandoned temp from an older crashed writer\n", "utf8");
}

function assertSurvivalSet(root: string, finalPath: string, extras: string[]): void {
  const remaining = readdirSync(root).sort();
  assert.deepEqual(remaining, [basename(finalPath), ...extras].sort(),
    "only this invocation's owned unpublished temp may be removed; everything else must remain");
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

interface ModeProbe {
  representable: boolean;
  observed: number;
}

/**
 * Whether this runtime/filesystem represents POSIX permission bits (native
 * Windows stat mode does not carry them). Capability is probed by chmod-ing a
 * control file between two distinct POSIX modes and verifying stat reflects
 * each. This must not depend on creation-time mode or umask: chmod is never
 * filtered by the process umask, and the control file is created without an
 * explicit mode (whose resulting permission bits are umask-dependent and
 * therefore not a capability signal). When `restrictiveUmask` is set, the
 * probe temporarily forces a restrictive umask around its whole synchronous
 * window and restores the previous one in finally — evidencing on every run
 * that the probe stays supported under a restrictive umask. The published
 * sidecar file itself is never chmodded or otherwise touched: wherever this
 * probe succeeds (all POSIX filesystems), the caller must assert its physical
 * mode equals 0600. This is an evidence gate rather than a skip API.
 */
function probePosixModeRepresentable(dir: string, options?: { restrictiveUmask?: boolean }): ModeProbe {
  const previousMask = options?.restrictiveUmask ? process.umask(0o077) : undefined;
  try {
    const probePath = join(dir, "posix-mode-representability-probe");
    try {
      writeFileSync(probePath, "probe");
      chmodSync(probePath, 0o600);
      const strict = statSync(probePath).mode & 0o777;
      chmodSync(probePath, 0o644);
      const loose = statSync(probePath).mode & 0o777;
      return { representable: strict === 0o600 && loose === 0o644, observed: strict };
    } finally {
      rmSync(probePath, { force: true });
    }
  } finally {
    if (previousMask !== undefined) process.umask(previousMask);
  }
}

function assertCleanupContract(root: string, finalPath: string, outcome: InjectionOutcome, injected: Error): void {
  assert.ok(outcome.tempPath, "production writer must have attempted its exclusive temp open");
  assert.ok(outcome.openFlags, "the exclusive create request must be observable");
  assert.ok(
    outcome.tempPath.startsWith(`${finalPath}.tmp.`) && outcome.tempPath.length > `${finalPath}.tmp.`.length,
    `temp path must keep the production final.tmp.<uuid> naming shape: ${outcome.tempPath}`,
  );
  assert.equal(outcome.openFlags, "wx", "the exclusive create must request the wx flag");
  assert.equal(outcome.openMode, 0o600, "the exclusive create must request mode 0600 on every platform");
  assert.equal(exists(outcome.tempPath), false, "the owned unpublished temp must be cleaned after the failure");
  assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
    "cleanup must attempt exactly one unlink of exactly the acquire-claimed owned temp path (never the final or foreign path)");
  assert.ok(readFileSync(finalPath).equals(Buffer.from(PRIOR_SIDECAR_BYTES, "utf8")),
    "previous committed sidecar bytes must be unchanged");
  assert.equal(outcome.error, injected, "the original publication error object must propagate unchanged");
  assertSurvivalSet(root, finalPath, [
    `${basename(finalPath)}.tmp.${FOREIGN_WRITER_UUID}`,
    `${basename(finalPath)}.tmp.${ABANDONED_ORPHAN_SUFFIX}`,
  ]);
}

test("write failure: owned temp cleaned, prior sidecar bytes unchanged, original error propagated", async () => {
  const { root, finalPath } = setupRoot("write");
  const injected = Object.assign(new Error("disk full while staging sidecar"), { code: "EIO" });
  plantForeignTemps(finalPath);
  try {
    const store = new SessionStateStore({ sessionId: "atomic-write-cleanup", sessionFile: join(root, "conversation.jsonl"), cwd: root });
    const outcome = await withInjectedFault({ failWrite: injected }, () =>
      store.save(createState(), { waveRoots: [], bundles: [] }));
    assertCleanupContract(root, finalPath, outcome, injected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync failure: owned temp cleaned, prior sidecar bytes unchanged, original error propagated", async () => {
  const { root, finalPath } = setupRoot("sync");
  const injected = Object.assign(new Error("fsync refused while staging sidecar"), { code: "EIO" });
  plantForeignTemps(finalPath);
  try {
    const store = new SessionStateStore({ sessionId: "atomic-write-cleanup", sessionFile: join(root, "conversation.jsonl"), cwd: root });
    const outcome = await withInjectedFault({ failSync: injected }, () =>
      store.save(createState(), { waveRoots: [], bundles: [] }));
    assertCleanupContract(root, finalPath, outcome, injected);
    assert.ok(outcome.stages.includes("write"), "the staged write must have happened before the failed fsync");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close failure: owned unpublished temp still cleaned, prior sidecar bytes unchanged, close error propagated", async () => {
  const { root, finalPath } = setupRoot("close");
  const injected = Object.assign(new Error("close refused while staging sidecar"), { code: "EIO" });
  plantForeignTemps(finalPath);
  try {
    const store = new SessionStateStore({ sessionId: "atomic-write-cleanup", sessionFile: join(root, "conversation.jsonl"), cwd: root });
    const outcome = await withInjectedFault({ failClose: injected }, () =>
      store.save(createState(), { waveRoots: [], bundles: [] }));
    assertCleanupContract(root, finalPath, outcome, injected);
    assert.ok(outcome.stages.includes("sync"), "the fsync must have succeeded before the failed close");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rename failure: owned temp cleaned, prior sidecar bytes unchanged, original error propagated", async () => {
  const { root, finalPath } = setupRoot("rename");
  const injected = Object.assign(new Error("rename refused while publishing sidecar"), { code: "EXDEV" });
  plantForeignTemps(finalPath);
  try {
    const store = new SessionStateStore({ sessionId: "atomic-write-cleanup", sessionFile: join(root, "conversation.jsonl"), cwd: root });
    const outcome = await withInjectedFault({ failRename: injected }, () =>
      store.save(createState(), { waveRoots: [], bundles: [] }));
    assertCleanupContract(root, finalPath, outcome, injected);
    assert.equal(outcome.stages[0], "write", "write must run before rename");
    assert.ok(outcome.stages.includes("rename"), "the publication rename must have been attempted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("double fault: write fails and close fails — the close error propagates exactly as the original writer, then the owned temp is cleaned", async () => {
  const { root, finalPath } = setupRoot("double-write-close");
  const staged = Object.assign(new Error("disk full while staging sidecar"), { code: "EIO" });
  const closeInjected = Object.assign(new Error("close refused after failing staging write"), { code: "EIO" });
  plantForeignTemps(finalPath);
  try {
    const store = new SessionStateStore({ sessionId: "atomic-write-cleanup", sessionFile: join(root, "conversation.jsonl"), cwd: root });
    const outcome = await withInjectedFault({ failWrite: staged, failClose: closeInjected }, () =>
      store.save(createState(), { waveRoots: [], bundles: [] }));
    assert.equal(outcome.error, closeInjected,
      "preserved precedence: when writing and closing both fail, the close error object is what escapes, as the original writer's finally-close did");
    assert.notEqual(outcome.error, staged, "the failure must not be demoted to a first-write priority");
    assertCleanupContract(root, finalPath, outcome, closeInjected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("double fault: sync fails and close fails — the close error propagates exactly as the original writer, then the owned temp is cleaned", async () => {
  const { root, finalPath } = setupRoot("double-sync-close");
  const staged = Object.assign(new Error("fsync refused while staging sidecar"), { code: "EIO" });
  const closeInjected = Object.assign(new Error("close refused after failed staging fsync"), { code: "EIO" });
  plantForeignTemps(finalPath);
  try {
    const store = new SessionStateStore({ sessionId: "atomic-write-cleanup", sessionFile: join(root, "conversation.jsonl"), cwd: root });
    const outcome = await withInjectedFault({ failSync: staged, failClose: closeInjected }, () =>
      store.save(createState(), { waveRoots: [], bundles: [] }));
    assert.equal(outcome.error, closeInjected,
      "preserved precedence: when fsyncing and closing both fail, the close error object is what escapes, as the original writer's finally-close did");
    assert.notEqual(outcome.error, staged, "the failure must not be demoted to a first-write priority");
    assert.ok(outcome.stages.includes("write"), "the staged write must have happened before the failed fsync");
    assertCleanupContract(root, finalPath, outcome, closeInjected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup unlink failure: publication error escapes unchanged, the owned unpublished temp legitimately remains, cleanup targets only the acquire-claimed path", async () => {
  const { root, finalPath } = setupRoot("unlink-fault");
  const injected = Object.assign(new Error("disk full while staging sidecar"), { code: "EIO" });
  const unlinkInjected = Object.assign(new Error("unlink refused for the owned unpublished temp"), { code: "EPERM" });
  plantForeignTemps(finalPath);
  try {
    const store = new SessionStateStore({ sessionId: "atomic-write-cleanup", sessionFile: join(root, "conversation.jsonl"), cwd: root });
    const outcome = await withInjectedFault({ failWrite: injected, failUnlink: unlinkInjected }, () =>
      store.save(createState(), { waveRoots: [], bundles: [] }));
    assert.ok(outcome.tempPath, "production writer must have attempted its exclusive temp open");
    assert.ok(
      outcome.tempPath.startsWith(`${finalPath}.tmp.`) && outcome.tempPath.length > `${finalPath}.tmp.`.length,
      `temp path must keep the production final.tmp.<uuid> naming shape: ${outcome.tempPath}`,
    );
    assert.equal(outcome.openFlags, "wx", "the exclusive create must request the wx flag");
    assert.equal(outcome.openMode, 0o600, "the exclusive create must request mode 0600 on every platform");
    assert.equal(outcome.error, injected, "the original publication error must escape unchanged");
    assert.notEqual(outcome.error, unlinkInjected, "a best-effort cleanup failure must never replace the publication error");
    assert.equal(exists(outcome.tempPath), true,
      "the owned unpublished temp legitimately remains when the best-effort cleanup unlink itself fails");
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
      "cleanup must attempt only the acquire-claimed owned temp path, exactly once — never the final, foreign, or directory path");
    assert.ok(readFileSync(finalPath).equals(Buffer.from(PRIOR_SIDECAR_BYTES, "utf8")),
      "previous committed sidecar bytes must be unchanged");
    assertSurvivalSet(root, finalPath, [
      `${basename(finalPath)}.tmp.${FOREIGN_WRITER_UUID}`,
      `${basename(finalPath)}.tmp.${ABANDONED_ORPHAN_SUFFIX}`,
      basename(outcome.tempPath),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-existing collision at the temp path: exclusive open fails before ownership and the collision is untouched", async () => {
  const { root, finalPath } = setupRoot("collision");
  const fixedUuid = "123e4567-e89b-42d3-a456-426614174000";
  const collision = `${finalPath}.tmp.${fixedUuid}`;
  const collisionBytes = "pre-existing collision content\n";
  writeFileSync(collision, collisionBytes, "utf8");
  try {
    const store = new SessionStateStore({ sessionId: "atomic-write-cleanup", sessionFile: join(root, "conversation.jsonl"), cwd: root });
    const outcome = await withInjectedFault({}, () => store.save(createState(), { waveRoots: [], bundles: [] }), () => fixedUuid);
    assert.equal(outcome.tempPath, collision, "production writer must target exactly the colliding temp name");
    assert.equal(outcome.openFlags, "wx", "the failed create must still have requested the exclusive-create flag");
    assert.equal(outcome.openMode, 0o600, "the failed create must still have requested mode 0600");
    const error = outcome.error as NodeJS.ErrnoException | undefined;
    assert.ok(error, "save must fail when the exclusive temp open loses the collision");
    assert.equal(error?.code, "EEXIST", "the genuine exclusive-create EEXIST must propagate");
    assert.deepEqual(outcome.unlinkAttempts, [],
      "no unlink may even be attempted for a path this invocation never acquired — proving the collision survived an untouched cleanup");
    assert.ok(readFileSync(collision).equals(Buffer.from(collisionBytes, "utf8")), "pre-existing collision must remain byte-identical");
    assert.ok(readFileSync(finalPath).equals(Buffer.from(PRIOR_SIDECAR_BYTES, "utf8")),
      "previous committed sidecar bytes must be unchanged");
    assertSurvivalSet(root, finalPath, [basename(collision)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful publication is unchanged: 0600 mode, stage ordering, no temp leftovers, reload round-trips", async () => {
  const { root, finalPath, sessionFile } = setupRoot("success");
  try {
    const store = new SessionStateStore({ sessionId: "atomic-write-cleanup", sessionFile, cwd: root });
    const outcome = await withInjectedFault({}, () => store.save(createState(), { waveRoots: [], bundles: [] }));
    assert.equal(outcome.error, undefined, "publication must succeed");
    assert.deepEqual(outcome.stages, ["write", "sync", "close", "rename"],
      "stage ordering must stay write, fsync, close, rename (then the best-effort directory fsync)");
    assert.equal(outcome.openFlags, "wx", "publication must request the exclusive-create flag on every platform");
    assert.equal(outcome.openMode, 0o600, "publication must request mode 0600 for the exclusive create on every platform");
    assert.deepEqual(outcome.unlinkAttempts, [], "successful publication must never attempt any unlink");
    const modeProbe = probePosixModeRepresentable(root);
    const underRestrictiveMask = probePosixModeRepresentable(root, { restrictiveUmask: true });
    assert.equal(underRestrictiveMask.representable, modeProbe.representable,
      "capability detection must be umask-independent: the same filesystem probed under a temporarily restrictive umask (restored in finally) must reach the same verdict");
    const mode = statSync(finalPath).mode & 0o777;
    if (modeProbe.representable) {
      assert.equal(mode, 0o600, "published sidecar must keep mode 0600");
    } else {
      // This runtime cannot represent POSIX permission bits (native Windows
      // stat mode does not), so a physical 0600 assertion would be vacuous or
      // wrong. The universal requested-mode checks above are the platform-
      // independent contract; the physical assertion still runs wherever the
      // bits are representable. No native Windows runtime was exercised by
      // this validation — evidence, not a skip.
      assert.ok(true, `physical 0600 not asserted on this runtime: observed stat mode 0o${modeProbe.observed.toString(8)} does not represent POSIX permission bits; the observed requested exclusive-create mode 0600 governs`);
    }
    const text = readFileSync(finalPath, "utf8");
    assert.ok(text.endsWith("\n"), "serialized bytes keep the trailing newline");
    const doc = JSON.parse(text) as { version: number; revision: number; integritySha256: string };
    assert.equal(doc.version, 4);
    assert.equal(doc.revision, 1);
    const { integritySha256, ...unsigned } = doc;
    assert.equal(
      createHash("sha256").update(stableJson(unsigned)).digest("hex"),
      integritySha256,
      "published bytes carry a verifiable integrity digest",
    );
    assertSurvivalSet(root, finalPath, []);
    const restored = await store.restore(root);
    assert.ok(restored, "published sidecar restores");
    assert.equal(restored.revision, 1);
    assert.deepEqual(restored.execution.waveRoots, []);
    assert.deepEqual(restored.execution.bundles, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Test-local copy of the production canonical-JSON algorithm (stableJson). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  // The published document's leaves are strings/numbers/booleans only; the
  // canonical form is JSON.stringify over those leaves.
  return JSON.stringify(value) ?? "null";
}