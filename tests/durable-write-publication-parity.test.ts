/*
 * Publication-stage parity pins for the execution durable writers (#244
 * groundwork): atomicWrite (replace/rename) and atomicWriteExclusive
 * (hard-link commit) in src/execution/durable-write.ts.
 *
 * #244 consolidates the duplicated owned-temp publication lifecycle behind these
 * two facade functions into one internal implementation with an explicit
 * replace/exclusive commit choice. These tests pin, through the production
 * facade functions only (no copy of the algorithm), exactly what the
 * consolidation must not change:
 *   - the ordered publication events for each facade, including where the
 *     before_rename / after_rename / before_dir_sync hooks fire relative to the
 *     commit, the post-commit staged cleanup, and the parent-directory open,
 *     sync and close;
 *   - the staged-mode mapping (0o600 by default, `useDefaultFileMode` -> no mode
 *     requested, i.e. the platform default that capture publication relies on)
 *     and the restrictive 0o700 recursive parent mkdir requested by both facades;
 *   - error precedence: the publication error wins over a failing close — the
 *     main-path close error is what propagates and the additional best-effort
 *     close in the catch path can never replace it (the opposite of the
 *     session-state sidecar's close-wins contract, so precedence must stay an
 *     explicit choice rather than a side effect of a shared helper);
 *   - commit semantics: rename replaces, hard-link refuses an existing target
 *     with EEXIST, and neither a post-commit cleanup unlink failure nor a
 *     post-commit hook failure may turn a committed claim into a false
 *     acquisition failure — while the replace facade still reports an
 *     after_rename hook failure;
 *   - ownership-gated cleanup: an unowned collision at the staged name is never
 *     even targeted by an unlink (unlike the settings/receipt writers' current
 *     unconditional cleanup);
 *   - the whole parent-directory stage is best-effort: open, sync and close
 *     failures never fail a committed publication, for either facade.
 *
 * Faults are injected without using the module's global test seam: the compiled
 * writers resolve fs/promises open, rename, link, unlink and mkdir per call, so
 * for the duration of one awaited write the test wraps those builtins and
 * delegates everything else (real handles, real fsyncs, real rename/link, real
 * EEXIST) to the genuine implementations. Handle hygiene: an injected close
 * fault throws before the real handle closes, so the helper tracks every real
 * handle it hands out and closes any handle production did not already close —
 * bypassing the fault wrapper — once the write settles (no DEP0137 GC-closing).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  atomicWrite,
  atomicWriteExclusive,
  type DurableWriteHooks,
  type DurableWriteOptions,
} from "../src/execution/durable-write";

type FspModule = Record<string, any>;
type Facade = "atomicWrite" | "atomicWriteExclusive";

interface InjectionPlan {
  failWrite?: Error;
  failSync?: Error;
  failClose?: Error;
  failRename?: Error;
  failLink?: Error;
  failUnlink?: Error;
  failDirOpen?: Error;
  failDirSync?: Error;
  failDirClose?: Error;
}

interface InjectionOutcome {
  error?: unknown;
  /** Publication events that completed, in order (hooks included as markers). */
  events: string[];
  /** Every attempted event, including the one that faulted. */
  attempts: string[];
  /** Exact staged path production created (or attempted). */
  tempPath?: string;
  openFlags?: string | number;
  openMode?: number | undefined;
  /** Modes production passed to a staged handle's chmod (must stay empty). */
  chmodRequests: number[];
  /** Every mkdir request production made, in order. */
  mkdirRequests: Array<{ path: string; recursive: boolean; mode: number | undefined }>;
  /** Every path production passed to unlink, in attempt order. */
  unlinkAttempts: string[];
  /** Directory production opened read-only for the post-commit sync. */
  dirPath?: string;
}

type HookKey = "afterTempWrite" | "afterFileSync" | "beforeRename" | "afterRename" | "beforeDirSync";

/**
 * Run one awaited durable write with production-path fault injection, plus
 * hook-order markers. Patches are restored only after the write settles.
 */
async function withInjectedFault(
  plan: InjectionPlan,
  hooks: DurableWriteHooks | undefined,
  run: (options: DurableWriteOptions) => Promise<unknown>,
): Promise<InjectionOutcome> {
  const bareRequire = createRequire(__filename);
  const fsp = bareRequire("node:fs/promises") as FspModule;
  const realOpen = fsp.open;
  const realRename = fsp.rename;
  const realLink = fsp.link;
  const realUnlink = fsp.unlink;
  const realMkdir = fsp.mkdir;
  const outcome: InjectionOutcome = {
    events: [], attempts: [], chmodRequests: [], mkdirRequests: [], unlinkAttempts: [],
  };
  const openBinding = realOpen.bind(fsp);
  const renameBinding = realRename.bind(fsp);
  const linkBinding = realLink.bind(fsp);
  const unlinkBinding = realUnlink.bind(fsp);
  const mkdirBinding = realMkdir.bind(fsp);
  const trackedHandles: Array<{ real: any; productionClosed: boolean }> = [];

  // Wrap the caller's hooks so their position in the publication order is
  // recorded in the same event stream as the filesystem calls.
  const wrapHook = (key: HookKey): (() => Promise<void>) | undefined => {
    const hook = hooks?.[key];
    if (!hook) return undefined;
    return async () => {
      outcome.events.push(`hook:${key}`);
      await hook();
    };
  };
  const wrappedHooks: DurableWriteHooks = {
    afterTempWrite: wrapHook("afterTempWrite"),
    afterFileSync: wrapHook("afterFileSync"),
    beforeRename: wrapHook("beforeRename"),
    afterRename: wrapHook("afterRename"),
    beforeDirSync: wrapHook("beforeDirSync"),
  };

  fsp.open = async (path: string, flags: string | number, mode?: number) => {
    if (flags === "wx") {
      outcome.tempPath = path;
      outcome.openFlags = flags;
      outcome.openMode = mode;
      outcome.attempts.push("open");
      const real = await openBinding(path, flags, mode);
      outcome.events.push("open");
      const tracked = { real, productionClosed: false };
      trackedHandles.push(tracked);
      return {
        writeFile: async (data: unknown, encoding?: string) => {
          outcome.attempts.push("write");
          if (plan.failWrite) throw plan.failWrite;
          await real.writeFile(data as any, encoding);
          outcome.events.push("write");
        },
        chmod: async (chmodMode: number) => {
          outcome.chmodRequests.push(chmodMode);
          return real.chmod(chmodMode);
        },
        sync: async () => {
          outcome.attempts.push("sync");
          if (plan.failSync) throw plan.failSync;
          await real.sync();
          outcome.events.push("sync");
        },
        close: async () => {
          outcome.attempts.push("close");
          if (plan.failClose) throw plan.failClose;
          const value = await real.close();
          tracked.productionClosed = true;
          outcome.events.push("close");
          return value;
        },
      };
    }
    if (flags === "r") {
      outcome.dirPath = path;
      outcome.attempts.push("dir-open");
      if (plan.failDirOpen) throw plan.failDirOpen;
      // Windows directory handles/fsync are not portable. On that host this
      // tests call ordering and fault tolerance with a mock, not native fsync.
      const real = process.platform === "win32"
        ? { sync: async () => undefined, close: async () => undefined }
        : await openBinding(path, flags, mode);
      outcome.events.push("dir-open");
      const tracked = { real, productionClosed: false };
      trackedHandles.push(tracked);
      return {
        sync: async () => {
          outcome.attempts.push("dir-sync");
          if (plan.failDirSync) throw plan.failDirSync;
          await real.sync();
          outcome.events.push("dir-sync");
        },
        close: async () => {
          outcome.attempts.push("dir-close");
          if (plan.failDirClose) throw plan.failDirClose;
          const value = await real.close();
          tracked.productionClosed = true;
          outcome.events.push("dir-close");
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
      outcome.events.push("rename");
      return value;
    });
  };
  fsp.link = (existingPath: string, newPath: string) => {
    outcome.attempts.push("link");
    if (plan.failLink) throw plan.failLink;
    return linkBinding(existingPath, newPath).then((value: unknown) => {
      outcome.events.push("link");
      return value;
    });
  };
  fsp.unlink = (path: string) => {
    outcome.unlinkAttempts.push(path);
    outcome.attempts.push("unlink");
    if (plan.failUnlink) return Promise.reject(plan.failUnlink);
    return unlinkBinding(path).then((value: unknown) => {
      outcome.events.push("unlink");
      return value;
    });
  };
  fsp.mkdir = (path: string, options?: { recursive?: boolean; mode?: number }) => {
    outcome.mkdirRequests.push({
      path: String(path),
      recursive: options?.recursive === true,
      mode: options?.mode,
    });
    return mkdirBinding(path, options);
  };
  try {
    await run({ hooks: wrappedHooks });
    return outcome;
  } catch (error) {
    return { ...outcome, error };
  } finally {
    fsp.open = realOpen;
    fsp.rename = realRename;
    fsp.link = realLink;
    fsp.unlink = realUnlink;
    fsp.mkdir = realMkdir;
    await Promise.all(trackedHandles.map((tracked) => {
      if (tracked.productionClosed) return Promise.resolve();
      tracked.productionClosed = true; // one genuine close attempt, success or not
      return tracked.real.close().catch(() => undefined);
    }));
  }
}

const PRIOR_BYTES = "prior committed record bytes\n";
const FOREIGN_TEMP = "record.json.tmp.a-foreign-writers-temp";

function setupFixture(label: string, options: { priorTarget?: boolean } = {}): { dir: string; target: string } {
  const dir = mkdtempSync(join(tmpdir(), `pi-review-244-durable-${label}-`));
  const target = join(dir, "record.json");
  try {
    if (options.priorTarget !== false) writeFileSync(target, PRIOR_BYTES, "utf8");
    writeFileSync(join(dir, FOREIGN_TEMP), "another writer's temp\n", "utf8");
    return { dir, target };
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

function listing(dir: string): string[] {
  return readdirSync(dir).sort();
}

/** The exclusive facade commits only onto an absent name, so it needs its own target. */
function commitTarget(facade: Facade, dir: string, target: string): string {
  return facade === "atomicWriteExclusive" ? join(dir, "lease.json") : target;
}

function writeThrough(facade: Facade): (target: string, body: string, options: DurableWriteOptions) => Promise<void> {
  return facade === "atomicWrite" ? atomicWrite : atomicWriteExclusive;
}

function assertStagedRequest(outcome: InjectionOutcome, dir: string, expectedMode: number | undefined): void {
  assert.ok(outcome.tempPath, "production must have attempted its exclusive staged open");
  assert.equal(dirname(outcome.tempPath), dir, "the staged file must live beside the target");
  assert.equal(outcome.openFlags, "wx", "the staged file must be created exclusively");
  assert.equal(outcome.openMode, expectedMode,
    "the staged mode must be 0600 by default and unspecified (platform default) only for the useDefaultFileMode opt-in");
  assert.deepEqual(outcome.chmodRequests, [], "neither durable facade may chmod: they request a mode and never force one");
  assert.deepEqual(outcome.mkdirRequests, [{ path: dir, recursive: true, mode: 0o700 }],
    "both facades must request exactly one recursive 0700 parent mkdir");
}

const ALL_HOOKS: DurableWriteHooks = {
  afterTempWrite: () => undefined,
  afterFileSync: () => undefined,
  beforeRename: () => undefined,
  afterRename: () => undefined,
  beforeDirSync: () => undefined,
};

const REPLACE_SUCCESS_EVENTS = [
  "open", "write", "hook:afterTempWrite", "sync", "hook:afterFileSync", "close",
  "hook:beforeRename", "rename", "hook:afterRename",
  "hook:beforeDirSync", "dir-open", "dir-sync", "dir-close",
];
const EXCLUSIVE_SUCCESS_EVENTS = [
  "open", "write", "hook:afterTempWrite", "sync", "hook:afterFileSync", "close",
  "hook:beforeRename", "link", "hook:afterRename", "unlink",
  "hook:beforeDirSync", "dir-open", "dir-sync", "dir-close",
];

test("atomicWrite publication order, staged mode, mkdir request and directory sync are pinned", async () => {
  const { dir, target } = setupFixture("replace-success");
  try {
    const outcome = await withInjectedFault({}, ALL_HOOKS, (hooks) => atomicWrite(target, "committed\n", hooks));
    assert.equal(outcome.error, undefined, "the write must succeed");
    assert.deepEqual(outcome.events, REPLACE_SUCCESS_EVENTS,
      "replace publication order must stay write -> fsync -> close -> before_rename -> rename -> after_rename -> before_dir_sync -> directory open/sync/close");
    assertStagedRequest(outcome, dir, 0o600);
    assert.equal(outcome.dirPath, dir, "the directory sync must target the record's own directory");
    assert.deepEqual(outcome.unlinkAttempts, [], "a successful rename must never unlink anything");
    assert.equal(readFileSync(target, "utf8"), "committed\n");
    assert.deepEqual(listing(dir), ["record.json", FOREIGN_TEMP]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteExclusive publication order, staged mode, mkdir request, post-commit cleanup and directory sync are pinned", async () => {
  const { dir } = setupFixture("exclusive-success", { priorTarget: false });
  const target = join(dir, "lease.json");
  try {
    const outcome = await withInjectedFault({}, ALL_HOOKS, (hooks) => atomicWriteExclusive(target, "claimed\n", hooks));
    assert.equal(outcome.error, undefined, "the exclusive publication must succeed");
    assert.deepEqual(outcome.events, EXCLUSIVE_SUCCESS_EVENTS,
      "exclusive publication order must stay write -> fsync -> close -> before_rename -> link -> after_rename -> staged cleanup -> before_dir_sync -> directory open/sync/close");
    assertStagedRequest(outcome, dir, 0o600);
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
      "the hard-linked staged name must be cleaned exactly once after the commit");
    assert.equal(readFileSync(target, "utf8"), "claimed\n");
    assert.deepEqual(listing(dir), ["lease.json", FOREIGN_TEMP]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable facades request no staged mode only for the useDefaultFileMode opt-in", async () => {
  const { dir } = setupFixture("staged-mode", { priorTarget: false });
  try {
    const restrictive = await withInjectedFault({}, undefined, (hooks) =>
      atomicWrite(join(dir, "restrictive.json"), "body\n", hooks));
    assert.equal(restrictive.error, undefined);
    assert.equal(restrictive.openMode, 0o600, "the default staged mode stays owner-only");

    const optIn = await withInjectedFault({}, undefined, (hooks) =>
      atomicWrite(join(dir, "opt-in.json"), "body\n", { ...hooks, useDefaultFileMode: true }));
    assert.equal(optIn.error, undefined);
    assert.equal(optIn.openMode, undefined,
      "the opt-in must keep requesting no mode at all so the platform default survives (capture publication depends on this)");

    const exclusiveOptIn = await withInjectedFault({}, undefined, (hooks) =>
      atomicWriteExclusive(join(dir, "exclusive-opt-in.json"), "body\n", { ...hooks, useDefaultFileMode: true }));
    assert.equal(exclusiveOptIn.error, undefined);
    assert.equal(exclusiveOptIn.openMode, undefined, "the opt-in applies to the exclusive facade too");

    assert.deepEqual(listing(dir), [
      "exclusive-opt-in.json",
      "opt-in.json",
      FOREIGN_TEMP,
      "restrictive.json",
    ].sort(), "no staged name may survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const facade of ["atomicWrite", "atomicWriteExclusive"] as const) {
  test(`${facade}: a failing close propagates as the publication error and never commits`, async () => {
    const { dir, target } = setupFixture(`${facade}-close-fault`);
    const injected = Object.assign(new Error("close refused while staging a record"), { code: "EIO" });
    try {
      const outcome = await withInjectedFault({ failClose: injected }, undefined, (hooks) =>
        writeThrough(facade)(commitTarget(facade, dir, target), "rejected\n", hooks));
      assert.equal(outcome.error, injected, "the close error is the publication error when staging succeeded");
      if (facade === "atomicWriteExclusive") {
        assert.equal(exists(join(dir, "lease.json")), false, "a failed claim leaves the final name absent");
      } else {
        assert.equal(readFileSync(target, "utf8"), PRIOR_BYTES, "the previous committed bytes must be untouched");
      }
      assert.equal(exists(outcome.tempPath!), false, "the owned staged file must be cleaned");
      assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath], "cleanup must target only the owned staged path");
      assert.deepEqual(outcome.attempts.filter((event) => event === "close"), ["close", "close"],
        "the writer closes once on the main path and once best-effort in its catch; the second failure is swallowed");
      assert.ok(!outcome.attempts.includes("rename") && !outcome.attempts.includes("link"),
        "a pre-commit failure must never reach either commit primitive");
      assert.ok(!outcome.attempts.includes("dir-sync"), "no directory sync may run for an uncommitted write");
      assert.deepEqual(listing(dir), ["record.json", FOREIGN_TEMP]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${facade}: a failing close never replaces the staging error (publication-error precedence stays explicit)`, async () => {
    const { dir, target } = setupFixture(`${facade}-double-fault`);
    const staged = Object.assign(new Error("disk full while staging a record"), { code: "EIO" });
    const closeInjected = Object.assign(new Error("close refused after a failing staging write"), { code: "EIO" });
    try {
      const outcome = await withInjectedFault({ failWrite: staged, failClose: closeInjected }, undefined,
        (hooks) => writeThrough(facade)(commitTarget(facade, dir, target), "rejected\n", hooks));
      assert.equal(outcome.error, staged,
        "the durable writers report the publication error; the catch-path close is best-effort");
      assert.notEqual(outcome.error, closeInjected,
        "precedence must not drift to the session-state sidecar's close-wins contract");
      assert.deepEqual(outcome.attempts.filter((event) => event === "close"), ["close"],
        "the best-effort close is still attempted exactly once");
      if (facade === "atomicWriteExclusive") {
        assert.equal(exists(join(dir, "lease.json")), false, "a failed claim leaves the final name absent");
      } else {
        assert.equal(readFileSync(target, "utf8"), PRIOR_BYTES, "the previous committed bytes must be untouched");
      }
      assert.equal(exists(outcome.tempPath!), false);
      assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [label, plan] of [
    ["open", { failDirOpen: Object.assign(new Error("directory open refused"), { code: "EPERM" }) }],
    ["sync", { failDirSync: Object.assign(new Error("directory fsync refused"), { code: "EINVAL" }) }],
    ["close", { failDirClose: Object.assign(new Error("directory close refused"), { code: "EIO" }) }],
  ] as const) {
    test(`${facade}: a parent-directory ${label} failure never fails a committed publication`, async () => {
      const { dir, target } = setupFixture(`${facade}-dir-${label}`);
      const commit = commitTarget(facade, dir, target);
      try {
        const outcome = await withInjectedFault(plan, { beforeDirSync: () => undefined }, (hooks) =>
          writeThrough(facade)(commit, "committed\n", hooks));
        assert.equal(outcome.error, undefined,
          `a parent-directory ${label} failure must be swallowed for both facades`);
        assert.ok(outcome.attempts.includes("rename") || outcome.attempts.includes("link"),
          "the commit must have happened before the directory stage");
        assert.equal(readFileSync(commit, "utf8"), "committed\n");
        assert.deepEqual(outcome.unlinkAttempts, facade === "atomicWriteExclusive" ? [outcome.tempPath] : [],
          "only the exclusive facade's post-commit staged cleanup may unlink");
        assert.deepEqual(listing(dir), facade === "atomicWriteExclusive"
          ? ["lease.json", "record.json", FOREIGN_TEMP]
          : ["record.json", FOREIGN_TEMP]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test(`${facade}: a throwing beforeDirSync hook is swallowed after the commit`, async () => {
    const { dir, target } = setupFixture(`${facade}-dir-hook-fault`);
    const commit = commitTarget(facade, dir, target);
    try {
      const outcome = await withInjectedFault({}, {
        beforeDirSync: () => { throw new Error("injected dir-sync hook failure"); },
      }, (hooks) => writeThrough(facade)(commit, "committed\n", hooks));
      assert.equal(outcome.error, undefined, "the directory sync stage is best-effort end to end");
      assert.ok(outcome.events.includes("hook:beforeDirSync"), "the hook must still run in its pinned position");
      assert.equal(readFileSync(commit, "utf8"), "committed\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("atomicWriteExclusive never reports a false acquisition failure after its link committed", async () => {
  const { dir } = setupFixture("exclusive-post-commit", { priorTarget: false });
  const target = join(dir, "lease.json");
  const unlinkInjected = Object.assign(new Error("unlink refused for the committed staged name"), { code: "EPERM" });
  try {
    const outcome = await withInjectedFault({ failUnlink: unlinkInjected }, {
      afterRename: () => undefined,
      beforeDirSync: () => undefined,
    }, (hooks) => atomicWriteExclusive(target, "claimed\n", hooks));
    assert.equal(outcome.error, undefined,
      "post-commit staged cleanup failure must never fail the call: the claim with this identity already exists");
    assert.equal(readFileSync(target, "utf8"), "claimed\n", "the published claim stays durable");
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
      "the post-commit cleanup attempt is still scoped to the staged name");
    assert.ok(outcome.events.includes("dir-sync"), "the directory sync must still run after a swallowed cleanup failure");
    assert.equal(exists(outcome.tempPath!), true, "an uncleanable staged name legitimately survives a best-effort cleanup");
    rmSync(outcome.tempPath!, { force: true });
    assert.deepEqual(listing(dir), ["lease.json", FOREIGN_TEMP]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteExclusive swallows a post-commit hook failure while keeping the claim and cleanup intact", async () => {
  const { dir } = setupFixture("exclusive-hook-swallow", { priorTarget: false });
  const target = join(dir, "lease.json");
  try {
    const outcome = await withInjectedFault({}, {
      afterRename: () => { throw new Error("injected post-link hook failure"); },
      beforeDirSync: () => undefined,
    }, (hooks) => atomicWriteExclusive(target, "claimed\n", hooks));
    assert.equal(outcome.error, undefined,
      "after link succeeds the write is committed: a later hook failure must not look like a failed acquisition");
    assert.equal(readFileSync(target, "utf8"), "claimed\n");
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath], "the staged name must still be cleaned");
    assert.ok(outcome.events.includes("hook:beforeDirSync"), "the publication must continue through the directory sync");
    assert.deepEqual(listing(dir), ["lease.json", FOREIGN_TEMP]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteExclusive reports a pre-commit link fault and cleans only its own staged file", async () => {
  const { dir } = setupFixture("exclusive-link-fault", { priorTarget: false });
  const target = join(dir, "lease.json");
  const injected = Object.assign(new Error("link refused by the filesystem"), { code: "EPERM" });
  try {
    const outcome = await withInjectedFault({ failLink: injected }, undefined, (hooks) =>
      atomicWriteExclusive(target, "ours\n", hooks));
    assert.equal(outcome.error, injected, "a pre-commit link failure propagates unchanged");
    assert.equal(exists(target), false, "a failed claim leaves no final record");
    assert.equal(exists(outcome.tempPath!), false, "the owned staged file must be cleaned");
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath],
      "cleanup must target only the owned staged path, never a target");
    assert.ok(!outcome.attempts.includes("dir-sync"), "no directory sync may run for an uncommitted claim");
    assert.deepEqual(listing(dir), [FOREIGN_TEMP]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteExclusive keeps EEXIST semantics for a pre-existing target and cleans only its own staged file", async () => {
  const { dir, target } = setupFixture("exclusive-eexist");
  try {
    const outcome = await withInjectedFault({}, undefined, (hooks) =>
      atomicWriteExclusive(target, "ours\n", hooks));
    const error = outcome.error as NodeJS.ErrnoException | undefined;
    assert.equal(error?.code, "EEXIST", "the genuine link EEXIST must propagate as the acquisition failure it is");
    assert.equal(readFileSync(target, "utf8"), PRIOR_BYTES, "the existing claim must stay byte-identical");
    assert.equal(exists(outcome.tempPath!), false, "the owned staged file must be cleaned");
    assert.deepEqual(outcome.unlinkAttempts, [outcome.tempPath], "cleanup must never target the claimed path");
    assert.deepEqual(listing(dir), ["record.json", FOREIGN_TEMP]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWrite still reports a post-rename hook failure while the new bytes stay durable and no cleanup runs", async () => {
  const { dir, target } = setupFixture("replace-hook-fault");
  try {
    const outcome = await withInjectedFault({}, {
      afterRename: () => { throw new Error("injected post-rename hook failure"); },
      beforeDirSync: () => undefined,
    }, (hooks) => atomicWrite(target, "committed\n", hooks));
    assert.ok(outcome.error, "the replace facade must report a post-rename hook failure");
    assert.match(String((outcome.error as Error).message), /injected post-rename hook failure/);
    assert.equal(readFileSync(target, "utf8"), "committed\n", "the committed bytes survive the reported failure");
    assert.deepEqual(outcome.unlinkAttempts, [],
      "the rename consumed the staged file, so the failure path must not unlink anything");
    assert.ok(!outcome.events.includes("dir-open"),
      "a post-rename hook failure short-circuits the best-effort directory sync");
    assert.deepEqual(listing(dir), ["record.json", FOREIGN_TEMP]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const facade of ["atomicWrite", "atomicWriteExclusive"] as const) {
  test(`${facade} leaves an unowned staged-name collision completely untouched (ownership-gated cleanup)`, async () => {
    const { dir } = setupFixture(`${facade}-collision`, { priorTarget: false });
    const target = join(dir, "record.json");
    const collision = `${target}.tmp.hostile-collision`;
    try {
      writeFileSync(collision, "not ours\n", "utf8");
      const outcome = await withInjectedFault({}, undefined, (hooks) =>
        writeThrough(facade)(target, "ours\n", { ...hooks, tempSuffixForTesting: "hostile-collision" }));
      const error = outcome.error as NodeJS.ErrnoException | undefined;
      assert.equal(error?.code, "EEXIST", "the exclusive create must fail on the collision");
      assert.equal(outcome.tempPath, collision, "production must target exactly the colliding staged name");
      assert.deepEqual(outcome.unlinkAttempts, [],
        "ownership-gated cleanup must not even attempt an unlink for a staged name it never acquired");
      assert.equal(exists(collision), true, "a pre-existing staged name is never this invocation's file to remove");
      assert.equal(readFileSync(collision, "utf8"), "not ours\n", "the unowned collision must stay byte-identical");
      assert.equal(exists(target), false, "a failed publication leaves no final record");
      assert.deepEqual(listing(dir), [FOREIGN_TEMP, "record.json.tmp.hostile-collision"].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
