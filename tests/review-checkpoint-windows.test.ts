import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import {
  captureReviewCheckpoint, loadReviewCheckpoint, compareReviewCheckpoints,
  advanceRawReviewCheckpoint, releaseReviewCheckpoint, rawReviewCheckpointRecordPath,
  type ReviewCheckpointScope,
} from "../src/review-checkpoint";

const fsp = createRequire(__filename)("node:fs/promises");
const fault = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

interface Plan {
  platform?: NodeJS.Platform;
  directorySync?: string;
  directoryOpen?: string;
  fileSync?: string;
  failDirectoryAt?: number;
  /** Override file device IDs: path lstat reports `pathDeviceId` (default 0,
   * the NTFS cross-API shape) while every handle fstat reports HANDLE_DEVICE_ID. */
  windowsDeviceMismatch?: boolean;
  pathDeviceId?: number;
  statFault?: "dev" | "ino" | "mode" | "size" | "mtimeMs" | "ctimeMs";
  statFaultAt?: number;
  pathDeviceChanges?: boolean;
  /** Regression only: present Windows' synthetic permission surface on any host. */
  emulateWindowsHostStats?: boolean;
  /** Regression only: disable the target-platform stat model (negative control). */
  modelTargetPermissions?: false;
}

/** The host's own platform, captured before any test overrides process.platform. */
const HOST_PLATFORM = process.platform;
/** Synthetic volume ID every mocked file handle stat reports under `windowsDeviceMismatch`. */
const HANDLE_DEVICE_ID = 123;
/** Simulated NTFS file device surface: path lstat dev 0, handle fstat dev nonzero. */
const NTFS_DEVICE_SURFACE = { windowsDeviceMismatch: true } as const satisfies Plan;
/** Host-independent POSIX device surface: path lstat and handle fstat of every
 * file report the same synthetic volume, so a POSIX target never depends on
 * the host's own (possibly NTFS cross-API) device IDs. */
const UNIFORM_DEVICE_SURFACE = { windowsDeviceMismatch: true, pathDeviceId: HANDLE_DEVICE_ID } as const satisfies Plan;
/** Permission surface Node reports on a Windows host: no POSIX owner/mode
 * (directories read 0o777, files 0o666, uid 0) regardless of the requested mode. */
function windowsHostStat<T extends { mode: number; uid: number; gid: number; isDirectory(): boolean }>(stat: T): T {
  stat.mode = (stat.mode & 0o170000) | (stat.isDirectory() ? 0o777 : 0o666);
  stat.uid = 0;
  stat.gid = 0;
  return stat;
}
/**
 * Model the mocked target platform's permission facts for checkpoint-owned
 * storage. Production creates every owned directory 0o700 and the record
 * 0o600 as the current user; a POSIX target honors that, but a Windows host
 * has no POSIX modes to report. Only when the (real or emulated) host is
 * Windows and the target is POSIX, owned path and handle stats alike report
 * the owner-only bits production requested. Everything else is untouched: on
 * POSIX hosts the real modes stay enforced, source files keep their host
 * stats, and device/inode/size/time fields (and every injected fault) are
 * never altered here.
 */
function targetPermissionStat<T extends { mode: number; uid: number }>(stat: T, host: NodeJS.Platform, target: NodeJS.Platform, owned: boolean): T {
  if (!owned || host !== "win32" || target === "win32") return stat;
  stat.mode &= ~0o077;
  if (typeof process.getuid === "function") stat.uid = process.getuid();
  return stat;
}

// Wrap the production fs/promises binding, not a replacement checkpoint
// implementation. Directory handles are simulated on every host; file I/O,
// publication, reload, and cleanup use real disposable filesystem fixtures.
async function injected(plan: Plan, run: (events: string[]) => Promise<void>): Promise<void> {
  const realOpen = fsp.open;
  const realLstat = fsp.lstat;
  let samplePathStats = 0;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const events: string[] = [];
  let directories = 0;
  const targetPlatform: NodeJS.Platform = plan.platform ?? "win32";
  const host: NodeJS.Platform = plan.emulateWindowsHostStats ? "win32" : HOST_PLATFORM;
  // Checkpoint-owned storage: the extension namespace below the canonical
  // sessions directory (Pi-owned agent/sessions directories are excluded).
  const ownedRoot = scope ? join(await realpath(scope.agentDir), "sessions", "pi-review-gate") : undefined;
  const owned = (path: unknown): boolean => {
    if (!ownedRoot || typeof path !== "string") return false;
    const rel = relative(ownedRoot, resolve(path));
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  // Host surface first, then the target model; drift faults apply on top.
  const surface = <T extends { mode: number; uid: number; gid: number; isDirectory(): boolean }>(stat: T, path: unknown): T => {
    if (plan.emulateWindowsHostStats) windowsHostStat(stat);
    return plan.modelTargetPermissions === false ? stat : targetPermissionStat(stat, host, targetPlatform, owned(path));
  };
  Object.defineProperty(process, "platform", { ...platform, value: targetPlatform });
  fsp.lstat = async (...args: any[]) => {
    const stat = surface(await realLstat(...args), args[0]);
    if (!stat.isFile() || !plan.windowsDeviceMismatch) return stat;
    if (basename(String(args[0])) === "sample.txt") samplePathStats++;
    stat.dev = plan.pathDeviceChanges && samplePathStats === 3 ? 1 : (plan.pathDeviceId ?? 0);
    return stat;
  };
  fsp.open = async (path: string, flags: string | number, mode?: number) => {
    if ((await realLstat(path).catch(() => undefined))?.isDirectory()) {
      const index = ++directories;
      events.push(`dir-open:${basename(path)}`);
      if (plan.directoryOpen) throw fault(plan.directoryOpen);
      return {
        sync: async () => {
          events.push(`dir-sync:${basename(path)}`);
          if (plan.directorySync && (!plan.failDirectoryAt || index === plan.failDirectoryAt)) throw fault(plan.directorySync);
        },
        close: async () => { events.push(`dir-close:${basename(path)}`); },
      };
    }
    const handle = await realOpen(path, flags, mode);
    if (flags !== "wx") {
      let stats = 0;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "stat") return async () => {
            const stat = surface(await target.stat(), path);
            if (plan.windowsDeviceMismatch) stat.dev = HANDLE_DEVICE_ID;
            if (plan.statFault && ++stats === (plan.statFaultAt ?? 1)) {
              const previous = stat[plan.statFault];
              // NTFS inode numbers can exceed MAX_SAFE_INTEGER: +1 may round
              // back to the same Number. Prove the injected drift is distinct.
              stat[plan.statFault] += Math.max(1, Math.abs(previous) * Number.EPSILON * 2);
              assert.notEqual(stat[plan.statFault], previous, "stat fault must change the observed value");
            }
            return stat;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return {
      writeFile: async (...args: any[]) => { events.push("file-write"); return handle.writeFile(...args); },
      sync: async () => {
        events.push("file-sync");
        if (plan.fileSync) throw fault(plan.fileSync);
        return handle.sync();
      },
      close: async () => { events.push("file-close"); return handle.close(); },
    };
  };
  try { await run(events); }
  finally {
    fsp.open = realOpen;
    fsp.lstat = realLstat;
    Object.defineProperty(process, "platform", platform);
  }
}

// #301: raw records live in the live session's external namespace under a
// disposable Pi agent-data directory, outside the capture root.
let scope: ReviewCheckpointScope | undefined;
const opts = () => ({ scope });
const SESSION_ID = "windows-raw-session";
/** The workspace store directory holding this root's owned generations. */
async function workspaceStore(root: string): Promise<string> {
  return dirname(dirname(rawReviewCheckpointRecordPath(scope!, await realpath(root), { windowId: "w", owner: "o" })));
}
/** Directory flushes every raw publication performs before its descriptor. */
async function expectedChain(root: string): Promise<string[]> {
  const agentDir = await realpath(scope!.agentDir);
  return [
    `dir-sync:${basename(await workspaceStore(root))}`, "dir-sync:checkpoints", `dir-sync:${SESSION_ID}`,
    "dir-sync:pi-review-gate", "dir-sync:sessions", `dir-sync:${basename(agentDir)}`, `dir-sync:${basename(dirname(agentDir))}`,
  ];
}
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "prg-windows-raw-"));
  const agentDir = await mkdtemp(join(tmpdir(), "prg-windows-agent-"));
  scope = { agentDir, sessionId: SESSION_ID };
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  try { await run(root); }
  finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    scope = undefined;
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
}

for (const failDirectoryAt of [undefined, 8]) {
  test(`mocked Windows raw baseline tolerates directory sync EPERM (${failDirectoryAt ?? "all flushes"})`, async () => fixture(async (root) => {
    await writeFile(join(root, "sample.txt"), "baseline bytes");
    await injected({ directorySync: "EPERM", failDirectoryAt, windowsDeviceMismatch: true }, async (events) => {
      const before = await captureReviewCheckpoint(root, "before", opts());
      assert.equal(before.status, "ok", JSON.stringify(before));
      if (before.status !== "ok" || before.value.kind !== "raw") throw new Error("expected raw baseline");
      assert.equal((await loadReviewCheckpoint(root, before.value, opts())).status, "ok");
      // The owned chain is flushed up to the sessions directory, then the
      // directories holding the sessions and agent-dir entries, then the owned
      // generation after publication. The capture root is never flushed (#301).
      assert.deepEqual(events.filter((e) => e.startsWith("dir-sync:")), [
        ...await expectedChain(root), `dir-sync:before-${before.value.owner}`,
      ]);
      assert.ok(!events.includes(`dir-sync:${basename(root)}`), "the workspace is never flushed as a checkpoint parent");
      assert.equal(events.filter((e) => e.startsWith("dir-close:")).length, 8);
      assert.deepEqual(events.filter((e) => e.startsWith("file-")), ["file-write", "file-sync", "file-close"]);
      await writeFile(join(root, "sample.txt"), "frozen changed bytes");
      const after = await captureReviewCheckpoint(root, "after", opts());
      assert.equal(after.status, "ok", JSON.stringify(after));
      if (after.status !== "ok") throw new Error("expected after checkpoint");
      await writeFile(join(root, "sample.txt"), "later live bytes");
      const compared = await compareReviewCheckpoints(root, before.value, after.value, opts());
      assert.equal(compared.status, "ok", JSON.stringify(compared));
      if (compared.status !== "ok") throw new Error("expected frozen comparison");
      assert.deepEqual(compared.value.changes.map((c) => [c.path, c.old?.bytes?.toString(), c.new?.bytes?.toString()]),
        [["sample.txt", "baseline bytes", "frozen changed bytes"]]);
      const advanced = await advanceRawReviewCheckpoint(root, before.value, ["sample.txt"], "advanced", opts());
      assert.equal(advanced.status, "ok", JSON.stringify(advanced));
      if (advanced.status !== "ok") throw new Error("expected advanced checkpoint");
      assert.equal((await loadReviewCheckpoint(root, advanced.value, opts())).status, "ok");
      for (const descriptor of [before.value, after.value, advanced.value])
        assert.equal((await releaseReviewCheckpoint(root, descriptor, opts())).status, "ok");
    });
  }));
}

for (const [label, plan, code] of [
  ["directory open EPERM", { directoryOpen: "EPERM" }, "EPERM"],
  ["directory sync EIO", { directorySync: "EIO" }, "EIO"],
  ["final directory sync EIO", { directorySync: "EIO", failDirectoryAt: 8 }, "EIO"],
  ["file sync EPERM", { directorySync: "EPERM", fileSync: "EPERM" }, "EPERM"],
  ["non-Windows directory sync EPERM", { platform: "linux", directorySync: "EPERM" }, "EPERM"],
] as const) {
  test(`mocked raw baseline still fails closed on ${label}`, async () => fixture(async (root) => {
    await writeFile(join(root, "sample.txt"), "unchanged");
    await injected(plan, async (events) => {
      const result = await captureReviewCheckpoint(root, "failure", opts());
      assert.equal(result.status, "failed", JSON.stringify(result));
      if (result.status !== "failed") throw new Error("expected failure");
      assert.equal(result.reason, "raw_checkpoint_failed");
      assert.match(result.detail, new RegExp(`injected ${code}`));
      assert.deepEqual(await readdir(await workspaceStore(root)), [], "failed arm removes only its owned scratch");
      assert.deepEqual(await readdir(root), ["sample.txt"], "no checkpoint content is ever created in the workspace");
      assert.equal(await fsp.readFile(join(root, "sample.txt"), "utf8"), "unchanged");
      assert.equal(events.filter((e) => e.startsWith("dir-close:")).length,
        events.filter((e) => e.startsWith("dir-open:")).length - (plan.directoryOpen ? 1 : 0));
      if (plan.fileSync) assert.ok(events.includes("file-close"), "failed file flush still closes the file");
    });
  }));
}

for (const statFault of ["ino", "mode", "size", "mtimeMs", "ctimeMs"] as const) {
  for (const statFaultAt of [1, 2]) {
    test(`mocked Windows raw capture rejects ${statFault} drift at handle stat ${statFaultAt}`, async () => fixture(async (root) => {
      await writeFile(join(root, "sample.txt"), "baseline");
      await injected({ directorySync: "EPERM", windowsDeviceMismatch: true, statFault, statFaultAt }, async () => {
        const captured = await captureReviewCheckpoint(root, "race", opts());
        assert.equal(captured.status, "failed", JSON.stringify(captured));
        if (captured.status !== "failed") throw new Error("expected race failure");
        assert.match(captured.detail ?? "", /file raced: sample.txt/);
        assert.deepEqual(await readdir(await workspaceStore(root)), []);
      });
    }));
    test(`mocked Windows raw reload rejects ${statFault} drift at handle stat ${statFaultAt}`, async () => fixture(async (root) => {
      await writeFile(join(root, "sample.txt"), "baseline");
      let descriptor;
      await injected({ directorySync: "EPERM", windowsDeviceMismatch: true }, async () => {
        const captured = await captureReviewCheckpoint(root, "reload", opts());
        if (captured.status !== "ok") throw new Error(JSON.stringify(captured));
        descriptor = captured.value;
      });
      if (!descriptor) throw new Error("missing descriptor");
      await injected({ windowsDeviceMismatch: true, statFault, statFaultAt }, async () => {
        const loaded = await loadReviewCheckpoint(root, descriptor!, opts());
        assert.equal(loaded.status, "failed", JSON.stringify(loaded));
        if (loaded.status !== "failed") throw new Error("expected record race failure");
        assert.match(loaded.detail ?? "", /record raced/);
      });
    }));
  }
}

for (const plan of [
  { windowsDeviceMismatch: true, pathDeviceId: 123, statFault: "dev" },
  { windowsDeviceMismatch: true, pathDeviceChanges: true },
  { windowsDeviceMismatch: true, platform: "linux" },
] satisfies Plan[]) {
  test(`raw device normalization remains narrow: ${JSON.stringify(plan)}`, async () => fixture(async (root) => {
    await writeFile(join(root, "sample.txt"), "baseline");
    await injected({ directorySync: plan.platform === "linux" ? undefined : "EPERM", ...plan }, async () => {
      const captured = await captureReviewCheckpoint(root, "device-race", opts());
      assert.equal(captured.status, "failed", JSON.stringify(captured));
      if (captured.status !== "failed") throw new Error("expected device race failure");
      assert.match(captured.detail ?? "", /(?:file|entry) raced: sample.txt/);
    });
  }));
}

test("native Windows empty raw checkpoint captures, reloads and releases", { skip: process.platform !== "win32" }, async () => fixture(async (root) => {
  const captured = await captureReviewCheckpoint(root, "native-empty", opts());
  assert.equal(captured.status, "ok", JSON.stringify(captured));
  if (captured.status !== "ok" || captured.value.kind !== "raw") throw new Error("expected raw empty baseline");
  const loaded = await loadReviewCheckpoint(root, captured.value, opts());
  assert.equal(loaded.status, "ok", JSON.stringify(loaded));
  if (loaded.status !== "ok" || loaded.value.kind !== "raw") throw new Error("expected empty reload");
  assert.deepEqual(loaded.value.entries, []);
  assert.equal((await releaseReviewCheckpoint(root, captured.value, opts())).status, "ok");
  assert.equal((await loadReviewCheckpoint(root, captured.value, opts())).status, "failed");
}));

test("native Windows raw checkpoint captures, reloads, compares and advances exact frozen bytes", { skip: process.platform !== "win32" }, async () => fixture(async (root) => {
  await writeFile(join(root, "sample.txt"), Buffer.from([0, 255, 42]));
  const before = await captureReviewCheckpoint(root, "native-before", opts());
  assert.equal(before.status, "ok", JSON.stringify(before));
  if (before.status !== "ok" || before.value.kind !== "raw") throw new Error("expected raw baseline");
  assert.equal((await loadReviewCheckpoint(root, before.value, opts())).status, "ok");
  for (const invalidRoot of ["relative", "C:relative", "\\relative"]) {
    const result = await loadReviewCheckpoint(root, { ...before.value, root: invalidRoot }, opts());
    assert.equal(result.status, "failed", "noncanonical/relative roots must not load");
  }
  await writeFile(join(root, "sample.txt"), "after bytes");
  const after = await captureReviewCheckpoint(root, "native-after", opts());
  assert.equal(after.status, "ok", JSON.stringify(after));
  if (after.status !== "ok") throw new Error("expected after checkpoint");
  await writeFile(join(root, "sample.txt"), "later live bytes");
  const compared = await compareReviewCheckpoints(root, before.value, after.value, opts());
  assert.equal(compared.status, "ok", JSON.stringify(compared));
  if (compared.status !== "ok") throw new Error("expected comparison");
  assert.deepEqual(compared.value.changes.map((c) => c.path), ["sample.txt"]);
  assert.deepEqual(compared.value.changes[0]?.old?.bytes, Buffer.from([0, 255, 42]));
  assert.equal(compared.value.changes[0]?.new?.bytes?.toString(), "after bytes");
  const advanced = await advanceRawReviewCheckpoint(root, before.value, ["sample.txt"], "native-advanced", opts());
  assert.equal(advanced.status, "ok", JSON.stringify(advanced));
  if (advanced.status !== "ok") throw new Error("expected advancement");
  const loaded = await loadReviewCheckpoint(root, advanced.value, opts());
  assert.equal(loaded.status, "ok", JSON.stringify(loaded));
  if (loaded.status !== "ok" || loaded.value.kind !== "raw") throw new Error("expected raw reload");
  assert.equal(Buffer.from(loaded.value.entries[0]!.contentB64!, "base64").toString(), "later live bytes");
  assert.equal((await loadReviewCheckpoint(root, { ...before.value, digest: "0".repeat(64) }, opts())).status, "failed");
  for (const descriptor of [before.value, after.value, advanced.value])
    assert.equal((await releaseReviewCheckpoint(root, descriptor, opts())).status, "ok");
}));

// Durability target selection. These cases assert directory-flush ordering
// and retry/concurrency semantics, which are identical on every target (only
// a Windows directory-sync EPERM is ever tolerated, and none is injected
// here). They therefore run on the host's own platform, so a real NTFS host
// gets production's Windows identity rules instead of being forced into the
// POSIX path/handle device equality it cannot provide, while POSIX hosts keep
// real private-mode enforcement. The simulated NTFS variant replays the same
// cases on the Windows target with path-dev-0/handle-nonzero file data on
// every host: the bounded evidence that the Windows CI shape still flushes,
// fails, and retries exactly as asserted. (The same NTFS data on a POSIX target
// stays rejected by the device-normalization tests above.)
const DURABILITY_TARGETS = [
  { label: `host ${HOST_PLATFORM}`, plan: { platform: HOST_PLATFORM } },
  { label: "simulated NTFS win32", plan: { platform: "win32", ...NTFS_DEVICE_SURFACE } },
] as const satisfies readonly { label: string; plan: Plan }[];

for (const { label, plan: target } of DURABILITY_TARGETS) {
  test(`a retry after initialization failed before the ancestor flush re-flushes every storage entry (${label})`, async () => fixture(async (root) => {
    await writeFile(join(root, "sample.txt"), "baseline");
    // The sixth directory flush is the agent directory holding the newly
    // created sessions entry: fail exactly there, after creation.
    await injected({ ...target, directorySync: "EIO", failDirectoryAt: 6 }, async (events) => {
      const failed = await captureReviewCheckpoint(root, "init-failure", opts());
      assert.equal(failed.status, "failed", JSON.stringify(failed));
      assert.equal(events.filter((e) => e.startsWith("dir-sync:")).at(-1), `dir-sync:${basename(await realpath(scope!.agentDir))}`);
    });
    assert.deepEqual(await readdir(join(scope!.agentDir, "sessions")), ["pi-review-gate"], "the failed attempt left created storage entries behind");
    assert.deepEqual(await readdir(await workspaceStore(root)), [], "the failed generation was removed");
    await injected(target, async (events) => {
      const retried = await captureReviewCheckpoint(root, "init-retry", opts());
      assert.equal(retried.status, "ok", JSON.stringify(retried));
      if (retried.status !== "ok" || retried.value.kind !== "raw") throw new Error("expected raw retry");
      // The retry did not create those entries, yet still flushes all of them.
      assert.deepEqual(events.filter((e) => e.startsWith("dir-sync:")), [
        ...await expectedChain(root), `dir-sync:init-retry-${retried.value.owner}`,
      ]);
      assert.equal((await releaseReviewCheckpoint(root, retried.value, opts())).status, "ok");
    });
  }));

  test(`concurrent first captures each flush every storage entry before publishing (${label})`, async () => fixture(async (root) => {
    await writeFile(join(root, "sample.txt"), "baseline");
    await injected(target, async (events) => {
      const captured = await Promise.all(["first-a", "first-b", "first-c"].map((id) => captureReviewCheckpoint(root, id, opts())));
      for (const result of captured) assert.equal(result.status, "ok", JSON.stringify(result));
      const syncs = events.filter((e) => e.startsWith("dir-sync:"));
      for (const entry of await expectedChain(root)) {
        assert.equal(syncs.filter((e) => e === entry).length, 3, `${entry} flushed by every concurrent publication`);
      }
      if ("windowsDeviceMismatch" in target) {
        // The simulated NTFS surface really reached production: the source
        // entry recorded the path's dev 0 although its handle reported nonzero.
        const first = captured[0]!;
        if (first.status !== "ok") throw new Error("expected capture");
        const loaded = await loadReviewCheckpoint(root, first.value, opts());
        assert.equal(loaded.status, "ok", JSON.stringify(loaded));
        if (loaded.status !== "ok" || loaded.value.kind !== "raw") throw new Error("expected raw reload");
        assert.deepEqual(loaded.value.entries.map((e) => [e.path, e.dev]), [["sample.txt", 0]]);
      }
      for (const result of captured) if (result.status === "ok") assert.equal((await releaseReviewCheckpoint(root, result.value, opts())).status, "ok");
    });
  }));
}

// Target-platform stat model regressions: host-independent evidence that the
// mocks above model a POSIX target on a Windows host without bypassing privacy.
test("target permission model only privatizes owned storage when a Windows host stands in for a POSIX target", () => {
  const stat = (mode: number) => ({ mode, uid: 0, dev: 0, ino: 2 ** 60, size: 7, mtimeMs: 1.5, ctimeMs: 2.5 });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const ownerOnly = (s: { mode: number }) => (s.mode & 0o077) === 0;
  const directory = targetPermissionStat(stat(0o40777), "win32", "linux", true);
  assert.deepEqual(directory, { ...stat(0o40700), uid }, "owned directory reports the requested 0o700, other fields untouched");
  assert.ok(ownerOnly(directory));
  // The path stat and handle stat of one owned record map identically.
  assert.deepEqual(targetPermissionStat(stat(0o100666), "win32", "darwin", true), targetPermissionStat(stat(0o100666), "win32", "darwin", true));
  assert.deepEqual(targetPermissionStat(stat(0o100666), "win32", "linux", true), { ...stat(0o100600), uid });
  // Source files, POSIX hosts (real modes enforced), and Windows targets stay as observed.
  assert.deepEqual(targetPermissionStat(stat(0o100666), "win32", "linux", false), stat(0o100666));
  for (const host of ["linux", "darwin"] as const) assert.deepEqual(targetPermissionStat(stat(0o40755), host, "linux", true), stat(0o40755));
  assert.deepEqual(targetPermissionStat(stat(0o40777), "win32", "win32", true), stat(0o40777));
});

test("emulated Windows host stats reproduce the POSIX-target privacy failure without the model", async () => fixture(async (root) => {
  await writeFile(join(root, "sample.txt"), "baseline");
  await injected({ platform: "linux", emulateWindowsHostStats: true, modelTargetPermissions: false }, async () => {
    const captured = await captureReviewCheckpoint(root, "unmodeled", opts());
    assert.equal(captured.status, "failed", JSON.stringify(captured));
    if (captured.status !== "failed") throw new Error("expected privacy failure");
    assert.match(captured.detail ?? "", /raw checkpoint directory is not private to the current user/);
    assert.deepEqual(await readdir(root), ["sample.txt"]);
  });
}));

// The POSIX target needs POSIX path/handle device equality, which a real NTFS
// host may not provide; the uniform synthetic device surface supplies it on
// every host so this lifecycle exercises only the permission model. Device
// drift and the NTFS shape on a POSIX target stay rejected (tests above).
test("emulated Windows host stats with the POSIX-target model capture, reload and release with strict checks", async () => fixture(async (root) => {
  await writeFile(join(root, "sample.txt"), "baseline");
  await injected({ platform: "linux", emulateWindowsHostStats: true, ...UNIFORM_DEVICE_SURFACE }, async (events) => {
    const captured = await captureReviewCheckpoint(root, "modeled", opts());
    assert.equal(captured.status, "ok", JSON.stringify(captured));
    if (captured.status !== "ok" || captured.value.kind !== "raw") throw new Error("expected raw capture");
    assert.deepEqual(events.filter((e) => e.startsWith("dir-sync:")), [...await expectedChain(root), `dir-sync:modeled-${captured.value.owner}`]);
    assert.deepEqual(events.filter((e) => e.startsWith("file-")), ["file-write", "file-sync", "file-close"]);
    const loaded = await loadReviewCheckpoint(root, captured.value, opts());
    assert.equal(loaded.status, "ok", JSON.stringify(loaded));
    if (loaded.status !== "ok" || loaded.value.kind !== "raw") throw new Error("expected raw reload");
    // Source stats keep the host surface: only owned storage is modeled.
    assert.deepEqual(loaded.value.entries.map((e) => [e.path, e.mode]), [["sample.txt", 0o100666]]);
    // Identity came from the synthetic uniform volume, never the host's devices.
    assert.deepEqual(loaded.value.entries.map((e) => e.dev), [HANDLE_DEVICE_ID]);
    assert.equal((await releaseReviewCheckpoint(root, captured.value, opts())).status, "ok");
    assert.equal((await loadReviewCheckpoint(root, captured.value, opts())).status, "failed");
  });
}));

test("on a POSIX host the target model never masks a non-private checkpoint directory", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  await writeFile(join(root, "sample.txt"), "baseline");
  await injected({ platform: "linux" }, async () => {
    const first = await captureReviewCheckpoint(root, "posix-first", opts());
    assert.equal(first.status, "ok", JSON.stringify(first));
    if (first.status !== "ok") throw new Error("expected capture");
    assert.equal((await releaseReviewCheckpoint(root, first.value, opts())).status, "ok");
    await fsp.chmod(await workspaceStore(root), 0o755);
    const exposed = await captureReviewCheckpoint(root, "posix-exposed", opts());
    assert.equal(exposed.status, "failed", JSON.stringify(exposed));
    if (exposed.status !== "failed") throw new Error("expected privacy failure");
    assert.match(exposed.detail ?? "", /raw checkpoint directory is not private to the current user/);
  });
}));

test("injected restores the fs bindings and platform after success and failure", async () => fixture(async () => {
  const realOpen = fsp.open, realLstat = fsp.lstat;
  await injected({ platform: "linux", emulateWindowsHostStats: true }, async () => {
    assert.equal(process.platform, "linux");
    assert.notEqual(fsp.lstat, realLstat);
  });
  assert.equal(process.platform, HOST_PLATFORM);
  await assert.rejects(injected({ platform: "linux", emulateWindowsHostStats: true }, async () => { throw new Error("run failed"); }), /run failed/);
  assert.equal(process.platform, HOST_PLATFORM);
  assert.equal(fsp.open, realOpen);
  assert.equal(fsp.lstat, realLstat);
}));
