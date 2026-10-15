/*
 * Publication-stage parity pins for the settings configuration save boundary
 * (#244 groundwork): updateReviewGateConfig -> writeConfigAtomically.
 *
 * These tests exercise the production save path only — no copy of the writer's
 * algorithm — and pin the contract #244 must preserve while equivalent atomic
 * publication mechanics are consolidated elsewhere:
 *   - stage order write -> chmod -> fsync -> close -> rename -> parent-directory
 *     open/sync/close, and the config-specific `chmod` step that forces the
 *     target mode (the other writers have no chmod);
 *   - the config target-mode policy: a tightened existing mode is preserved
 *     exactly (0400 stays 0400) while any group/other-readable mode is tightened
 *     to 0600 (0640, 0644 become 0600), and the forced chmod defeats the process
 *     umask (pinned under a temporarily restrictive umask, restored in finally,
 *     with a plain-write control in the same directory proving the mask is
 *     active — this file's tests run sequentially in their own process, so the
 *     scoped umask cannot overlap another suite);
 *   - every pre-publication fault (write, chmod, fsync, close, rename) leaves the
 *     previous committed bytes byte-identical, removes exactly the owned temp
 *     name once, propagates the original error object unchanged, and never
 *     touches another writer's temp files;
 *   - error precedence: the publication error wins over a failing best-effort
 *     close (the opposite of the session-state sidecar's close-wins precedence,
 *     so a shared helper must keep precedence explicit);
 *   - the parent-directory stage: open and sync failures are tolerated after the
 *     committed rename, while a directory close failure IS reported as a save
 *     failure even though the rename already committed. That asymmetry is
 *     recorded here as current behavior — it is the reason the config writer
 *     keeps its own directory sync and is not an endorsement of it;
 *   - a collision at the chosen temp name currently gets unlinked by the
 *     unconditional failure-path cleanup. That is recorded as a known gap
 *     (parity with today's writer, deliberately NOT an endorsed ownership
 *     contract, and deliberately not fixed by #244);
 *   - no-mkdir: the save never creates a missing parent directory.
 *
 * Faults are injected without adding any production seam: the compiled writer
 * resolves fs/promises open, rename, unlink and crypto.randomUUID per call, so
 * for the duration of one awaited save the test wraps those builtins and
 * delegates everything else (real handles, real fsyncs, real rename, real
 * EEXIST) to the genuine implementations. The wrapper records the observed
 * stage sequence, the exact exclusive-create request (flags and mode), every
 * handle.chmod request, and every path production passed to unlink.
 *
 * Handle hygiene: an injected close fault throws before the real handle closes,
 * so the helper tracks every real handle it hands out and closes any handle
 * production did not already close — bypassing the fault wrapper — once the save
 * settles. No descriptor is left to GC-closing (DEP0137).
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { updateReviewGateConfig } from "../src/settings/persistence";

type FspModule = Record<string, any>;

interface InjectionPlan {
  failWrite?: Error;
  failChmod?: Error;
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
  /** Physical mode of the staged temp observed when chmod was requested. */
  stagedModeAtChmod?: number;
  /** Modes production passed to the staged handle's chmod. */
  chmodRequests: number[];
  /** Stages that completed (in order). */
  stages: string[];
  /** Stages that were attempted, including the one that faulted. */
  attempts: string[];
  /** Every path production passed to fs/promises unlink, in attempt order. */
  unlinkAttempts: string[];
}

/**
 * Run one awaited save with production-path fault injection. fs/promises open,
 * rename and unlink are wrapped (plus crypto.randomUUID for a deterministic
 * temp name); the staged FileHandle is wrapped so the planned stage rejects and
 * the read-only directory handle is wrapped for the post-rename sync stage.
 * Everything else delegates to the real implementations, and patches are
 * restored only after the save settles.
 */
async function withInjectedFault(
  directory: string,
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
          outcome.attempts.push("chmod");
          // Observe what the create mode actually produced before the forced
          // chmod runs, so a umask test can tell "created at mode" from
          // "chmod-ed to mode" apart.
          if (outcome.tempPath) {
            try {
              outcome.stagedModeAtChmod = statSync(outcome.tempPath).mode & 0o777;
            } catch {
              outcome.stagedModeAtChmod = undefined;
            }
          }
          outcome.chmodRequests.push(chmodMode);
          if (plan.failChmod) throw plan.failChmod;
          await real.chmod(chmodMode);
          outcome.stages.push("chmod");
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
    if (flags === "r" && path === directory) {
      // The post-rename parent-directory sync open.
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
    const result = renameBinding(from, to);
    return result.then((value: unknown) => {
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

const PRIOR_CONFIG_BYTES = '{"enabled":true,"marker":"prior"}\n';
const FOREIGN_TEMPS = [
  ".config.json.999998.foreign-writer.tmp",
  ".config.json.older-crashed-writer.tmp",
];

function setupFixture(label: string, targetMode?: number): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `pi-review-244-config-${label}-`));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(configPath, PRIOR_CONFIG_BYTES, "utf8");
    if (targetMode !== undefined) chmodSync(configPath, targetMode);
    for (const name of FOREIGN_TEMPS) {
      writeFileSync(join(dir, name), `another writer's temp: ${name}\n`, "utf8");
    }
    return { dir, configPath };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
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
  assert.deepEqual(readdirSync(dir).sort(), ["config.json", ...FOREIGN_TEMPS, ...extras].sort(),
    "only this invocation's owned unpublished temp may be removed; everything else must remain");
}

/** The config writer's own temp naming shape: `<dir>/.config.json.<pid>.<uuid>.tmp`. */
function assertTempNaming(dir: string, configPath: string, tempPath: string | undefined): asserts tempPath is string {
  assert.ok(tempPath, "the production writer must have attempted its exclusive temp open");
  const prefix = `.${basename(configPath)}.`;
  assert.equal(dirname(tempPath), dir, "the temp file must be staged in the target's own directory");
  const name = basename(tempPath);
  assert.ok(name.startsWith(prefix) && name.endsWith(".tmp") && name.length > prefix.length + ".tmp".length,
    `temp name must keep the production .config.json.<pid>.<uuid>.tmp shape: ${tempPath}`);
}

function assertPrePublicationContract(
  dir: string,
  configPath: string,
  outcome: InjectionOutcome,
  injected: Error,
  requestedMode: number,
): void {
  assertTempNaming(dir, configPath, outcome.tempPath);
  assert.equal(outcome.openFlags, "wx", "the exclusive create must request the wx flag");
  assert.equal(outcome.openMode, requestedMode, "the exclusive create must request the config target mode");
  assert.equal(exists(outcome.tempPath), false, "the owned unpublished temp must be cleaned after the failure");
  assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
    "cleanup must attempt exactly one unlink of exactly the owned temp path (never the final or foreign path)");
  assert.ok(readFileSync(configPath).equals(Buffer.from(PRIOR_CONFIG_BYTES, "utf8")),
    "previous committed config bytes must be unchanged");
  assert.equal(outcome.error, injected, "the original publication error object must propagate unchanged");
  assert.ok(!outcome.stages.includes("rename"), "the commit must never complete for a pre-publication failure");
  assertSurvivalSet(dir);
}

function save(configPath: string, marker: string): Promise<unknown> {
  return updateReviewGateConfig(configPath, (config) => {
    config.marker = marker;
  });
}

test("successful config save publishes write -> chmod -> fsync -> close -> rename -> directory sync with no temp litter", async () => {
  const { dir, configPath } = setupFixture("success");
  try {
    const outcome = await withInjectedFault(dir, {}, () => save(configPath, "committed"));
    assert.equal(outcome.error, undefined, "the save must succeed");
    assert.deepEqual(outcome.stages,
      ["write", "chmod", "sync", "close", "rename", "dir-sync", "dir-close"],
      "config stage order must stay write, chmod, fsync, close, rename, then the parent-directory sync and close");
    assertTempNaming(dir, configPath, outcome.tempPath);
    assert.equal(outcome.openFlags, "wx", "the config temp must be created exclusively");
    assert.equal(outcome.openMode, 0o600, "a default-mode config target is published as 0600");
    assert.deepEqual(outcome.chmodRequests, [0o600], "config must chmod the staged file to the target mode exactly once");
    assert.deepEqual(outcome.unlinkAttempts, [], "a successful rename must never attempt an unlink");
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as { marker: string; enabled: boolean };
    assert.equal(saved.marker, "committed");
    assert.equal(saved.enabled, true, "unrelated stored fields survive");
    if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assertSurvivalSet(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

type PrePublicationKey = "failWrite" | "failChmod" | "failSync" | "failRename";

const prePublicationFaults: Array<{ label: string; key: PrePublicationKey; stage: string; injected: Error }> = [
  { label: "write", key: "failWrite", stage: "write", injected: Object.assign(new Error("disk full while staging config"), { code: "EIO" }) },
  { label: "chmod", key: "failChmod", stage: "chmod", injected: Object.assign(new Error("chmod refused for the staged config"), { code: "EPERM" }) },
  { label: "sync", key: "failSync", stage: "sync", injected: Object.assign(new Error("fsync refused while staging config"), { code: "EIO" }) },
  { label: "rename", key: "failRename", stage: "rename", injected: Object.assign(new Error("rename refused while publishing config"), { code: "EXDEV" }) },
];

for (const fault of prePublicationFaults) {
  test(`config ${fault.label} failure: owned temp cleaned, prior committed bytes unchanged, original error propagated`, async () => {
    const { dir, configPath } = setupFixture(`fail-${fault.label}`);
    try {
      const outcome = await withInjectedFault(dir, { [fault.key]: fault.injected } as InjectionPlan, () => save(configPath, "rejected"));
      assertPrePublicationContract(dir, configPath, outcome, fault.injected, 0o600);
      if (fault.stage !== "write") {
        assert.ok(outcome.attempts.includes("write"), "the staged write must precede the faulted stage");
      }
      if (fault.stage === "rename") {
        assert.deepEqual(outcome.stages, ["write", "chmod", "sync", "close"],
          "every stage before the commit must have completed before the rename fault");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("config close failure: the close error propagates, no rename is attempted, prior bytes survive, owned temp is cleaned", async () => {
  const { dir, configPath } = setupFixture("fail-close");
  const injected = Object.assign(new Error("close refused while staging config"), { code: "EIO" });
  try {
    const outcome = await withInjectedFault(dir, { failClose: injected }, () => save(configPath, "rejected"));
    assertPrePublicationContract(dir, configPath, outcome, injected, 0o600);
    assert.deepEqual(outcome.stages, ["write", "chmod", "sync"],
      "write, chmod and fsync must all complete before the failing close");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config double fault: a failing close never replaces the publication error (config precedence is close-swallowing, unlike the sidecar)", async () => {
  const { dir, configPath } = setupFixture("double-fault");
  const staged = Object.assign(new Error("disk full while staging config"), { code: "EIO" });
  const closeInjected = Object.assign(new Error("close refused after a failing staging write"), { code: "EIO" });
  try {
    const outcome = await withInjectedFault(dir, { failWrite: staged, failClose: closeInjected }, () => save(configPath, "rejected"));
    assert.equal(outcome.error, staged,
      "the config writer reports the publication error; its catch-path close is best-effort");
    assert.notEqual(outcome.error, closeInjected,
      "config precedence must not drift to the sidecar's close-wins contract");
    assert.deepEqual(outcome.attempts.filter((stage) => stage === "close"), ["close"],
      "the best-effort close is still attempted exactly once");
    assertPrePublicationContract(dir, configPath, outcome, staged, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config cleanup unlink failure: the publication error escapes unchanged and the owned temp legitimately remains", async () => {
  const { dir, configPath } = setupFixture("unlink-fault");
  const injected = Object.assign(new Error("disk full while staging config"), { code: "EIO" });
  const unlinkInjected = Object.assign(new Error("unlink refused for the owned unpublished temp"), { code: "EPERM" });
  try {
    const outcome = await withInjectedFault(dir, { failWrite: injected, failUnlink: unlinkInjected }, () => save(configPath, "rejected"));
    assert.equal(outcome.error, injected, "the original publication error must escape unchanged");
    assert.notEqual(outcome.error, unlinkInjected, "a best-effort cleanup failure must never replace the publication error");
    assertTempNaming(dir, configPath, outcome.tempPath);
    assert.equal(exists(outcome.tempPath), true,
      "the owned unpublished temp legitimately remains when the best-effort cleanup unlink itself fails");
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
      "cleanup must attempt only the owned temp path, exactly once");
    assert.ok(readFileSync(configPath).equals(Buffer.from(PRIOR_CONFIG_BYTES, "utf8")),
      "previous committed config bytes must be unchanged");
    assertSurvivalSet(dir, [basename(outcome.tempPath)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config target-mode policy: tightened modes are preserved exactly while group/other-readable modes are tightened to 0600", { skip: process.platform === "win32" }, async () => {
  for (const [existingMode, expectedMode] of [[0o400, 0o400], [0o600, 0o600], [0o640, 0o600], [0o644, 0o600]] as const) {
    const { dir, configPath } = setupFixture(`mode-${existingMode.toString(8)}`, existingMode);
    try {
      const outcome = await withInjectedFault(dir, {}, () => save(configPath, "committed"));
      assert.equal(outcome.error, undefined, `save must succeed for an existing 0o${existingMode.toString(8)} target`);
      assert.equal(outcome.openMode, expectedMode,
        `the exclusive create must request 0o${expectedMode.toString(8)} for an existing 0o${existingMode.toString(8)} target`);
      assert.deepEqual(outcome.chmodRequests, [expectedMode],
        `config must force the published mode with exactly one chmod to 0o${expectedMode.toString(8)}`);
      assert.equal(statSync(configPath).mode & 0o777, expectedMode,
        `published config must carry mode 0o${expectedMode.toString(8)}`);
      assert.equal((JSON.parse(readFileSync(configPath, "utf8")) as { marker: string }).marker, "committed");
      assertSurvivalSet(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("config save forces the preserved mode through chmod even when a restrictive umask would mask the create mode", { skip: process.platform === "win32" }, async () => {
  // Scoped, serial and restored in finally: node runs each test file in its own
  // process and this file's top-level tests sequentially, so the mask cannot
  // overlap another suite. 0o400 masks the owner-read bit the create requests.
  const { dir, configPath } = setupFixture("umask-chmod", 0o400);
  const previousMask = process.umask(0o400);
  try {
    const control = join(dir, "plain-write-control");
    writeFileSync(control, "control\n", "utf8");
    const controlMode = statSync(control).mode & 0o777;
    assert.equal(controlMode & 0o400, 0,
      `the restricted mask must genuinely suppress the read bit on this filesystem (plain write observed 0o${controlMode.toString(8)})`);

    const outcome = await withInjectedFault(dir, {}, () => save(configPath, "committed"));
    assert.equal(outcome.error, undefined, "the save must succeed under the restrictive umask");
    assert.equal(outcome.openMode, 0o400, "the create must still request the preserved 0400 mode");
    assert.equal(outcome.stagedModeAtChmod, 0o000,
      "the staged file is physically narrower than requested under the restrictive umask, so the published mode cannot come from the create");
    assert.deepEqual(outcome.chmodRequests, [0o400], "config must chmod the staged file to 0400");
    assert.equal(statSync(configPath).mode & 0o777, 0o400,
      "the published config must carry exactly 0400 — the forced chmod defeats the umask, unlike the receipt writer's requested-only mode");
    assert.deepEqual(outcome.stages,
      ["write", "chmod", "sync", "close", "rename", "dir-sync", "dir-close"],
      "the chmod stays between the write and the fsync");
    rmSync(control, { force: true });
    assertSurvivalSet(dir);
  } finally {
    process.umask(previousMask);
    assert.equal(process.umask(), previousMask, "the test must restore the process umask");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config collision at the chosen temp name: current unconditional cleanup removes the unowned temp (recorded known gap, not an endorsed contract) while prior bytes survive", async () => {
  const { dir, configPath } = setupFixture("collision");
  const fixedUuid = "123e4567-0000-4000-8000-000000000001";
  const tempName = `.config.json.${process.pid}.${fixedUuid}.tmp`;
  const collisionPath = join(dir, tempName);
  try {
    writeFileSync(collisionPath, "a file this invocation never created\n", "utf8");
    const outcome = await withInjectedFault(dir, {}, () => save(configPath, "rejected"), () => fixedUuid);
    assert.equal(outcome.tempPath, collisionPath, "production must target exactly the colliding temp name");
    assert.equal(outcome.openFlags, "wx", "the failed create must still request the exclusive-create flag");
    const error = outcome.error as NodeJS.ErrnoException | undefined;
    assert.equal(error?.code, "EEXIST", "the genuine exclusive-create EEXIST must propagate");
    assert.equal(exists(collisionPath), false,
      "RECORDED CURRENT BEHAVIOR (#244 gap, deliberately unchanged and not endorsed): the config writer's failure path unlinks the temp name unconditionally, so a pre-existing collision is deleted even though this invocation never owned it");
    assert.deepEqual(outcome.unlinkAttempts, [collisionPath],
      "the unconditional cleanup attempt must still be scoped to the single temp path");
    assert.ok(readFileSync(configPath).equals(Buffer.from(PRIOR_CONFIG_BYTES, "utf8")),
      "previous committed config bytes must be unchanged");
    assertSurvivalSet(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, plan] of [
  ["open", { failDirOpen: Object.assign(new Error("directory open refused"), { code: "EPERM" }) }],
  ["sync", { failDirSync: Object.assign(new Error("directory fsync refused"), { code: "EINVAL" }) }],
] as const) {
  test(`config parent-directory ${label} failure is tolerated after the committed rename`, async () => {
    const { dir, configPath } = setupFixture(`dir-${label}`);
    try {
      const outcome = await withInjectedFault(dir, plan, () => save(configPath, "committed"));
      assert.equal(outcome.error, undefined,
        `a parent-directory ${label} failure must never fail a save whose rename already committed`);
      assert.ok(outcome.stages.includes("rename"), "the commit must have happened");
      assert.equal((JSON.parse(readFileSync(configPath, "utf8")) as { marker: string }).marker, "committed");
      assert.deepEqual(outcome.unlinkAttempts, [],
        "a tolerated directory-sync failure must not trigger temp cleanup for a rename-consumed temp");
      assertSurvivalSet(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("config parent-directory close failure after the committed rename is reported as a save failure (recorded current behavior; why config keeps its own directory sync)", async () => {
  const { dir, configPath } = setupFixture("dir-close");
  const injected = Object.assign(new Error("directory close refused after the committed rename"), { code: "EIO" });
  try {
    const outcome = await withInjectedFault(dir, { failDirClose: injected }, () => save(configPath, "committed"));
    assert.equal(outcome.error, injected,
      "RECORDED CURRENT BEHAVIOR: unlike the execution, receipt and sidecar writers, config does not catch the directory close, so a save can report failure after its rename already committed. #244 preserves this and keeps config's directory sync separate; this pin is not an endorsement.");
    assert.ok(outcome.stages.includes("rename"), "the rename must have committed before the close fault");
    assert.deepEqual(outcome.stages, ["write", "chmod", "sync", "close", "rename", "dir-sync"],
      "the directory close is the last stage and the only one that can fail a committed save");
    assert.equal((JSON.parse(readFileSync(configPath, "utf8")) as { marker: string }).marker, "committed",
      "the new bytes stay committed even though the save reports failure");
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
      "the failure path still attempts to unlink the temp name the rename already consumed (best-effort, harmless)");
    assertSurvivalSet(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config save never creates a missing parent directory and never reaches its writer (no-mkdir refusal)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-244-config-no-mkdir-"));
  const missingDir = join(dir, "missing-namespace");
  const configPath = join(missingDir, "config.json");
  try {
    const outcome = await withInjectedFault(dir, {}, () => save(configPath, "rejected"));
    const error = outcome.error as NodeJS.ErrnoException | undefined;
    assert.ok(error, "the save must fail when the parent directory does not exist");
    assert.equal(error?.code, "ENOENT", "the failure must be the genuine missing-path error");
    assert.equal(exists(missingDir), false, "the config save path must never create a missing parent directory");
    assert.equal(outcome.tempPath, undefined, "no temp create may be attempted for a save that cannot read its target");
    assert.deepEqual(outcome.unlinkAttempts, [], "nothing may be unlinked when nothing was created");
    assert.deepEqual(readdirSync(dir).sort(), [], "the fixture directory must stay empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
