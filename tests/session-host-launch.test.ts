import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync as fsCloseSync, constants as fsFlags, existsSync, fstatSync, lstatSync, mkdirSync as fsMkdirSync, openSync as fsOpenSync, readdirSync, realpathSync, rmSync as fsRmSync, rmdirSync as fsRmdirSync, symlinkSync as fsSymlinkSync, unlinkSync as fsUnlinkSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { chmod, lstat, mkdir as fsMkdir, mkdtemp, open as fsOpen, readdir, readFile, realpath, rename as fsRename, rm as fsRm, stat, symlink as fsSymlink, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import test, { afterEach } from "node:test";
import {
  EXECUTOR_TOOL_CATALOG_ENV,
  MAX_NATIVE_CONFIG_BYTES,
  MAX_NATIVE_NODE_OPTIONS_BYTES,
  NATIVE_SKILL_PUBLISH_PLAN,
  NODE_OPTIONS_RESTORE_ENV,
  RUNTIME_ROLE_ENV,
  SESSION_HOST_BOOTSTRAP_ENV,
  composeFreshSessionSpawnArgs,
  prepareNativeLaunch as rawPrepareNativeLaunch,
  resolveNativePi,
  supportsSessionHostKittyGraphics,
} from "../src/session-host/launch";
import {
  admitSavedSession,
  listSavedSessions,
  SavedSessionAdmission,
} from "../src/session-host/saved-sessions";
import { disposableFixtureBase } from "./helpers/scratch-fixture-base";

const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-launch.test.ts"));
const { signalCleanupRefusal, REFUSAL_DIR } = requireCjs("../scripts/test-scratch-refusal.cjs") as {
  signalCleanupRefusal(reason?: string): () => void;
  REFUSAL_DIR: string;
};

/** Whether this fixture's own pre-registered refusal (matched by reason) is present. */
async function hasFixtureRefusal(root: string, reason: string): Promise<boolean> {
  const directory = join(root, REFUSAL_DIR);
  for (const entry of await readdir(directory)) {
    try {
      if (await readFile(join(directory, entry), "utf8") === `${reason}\n`) return true;
    } catch (error) {
      // An unrelated marker may disappear between enumeration and read.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

interface PiFixture {
  /** Real (symlink-resolved) root holding the fake pi executable. */
  root: string;
  /** Directory of a PATH-searchable fake pi printing the wanted version. */
  bin: string;
}

/**
 * Disposable fixture base: the test-scratch invocation root when the runner is
 * used, otherwise a validated external temporary directory. It is never the
 * checkout, so named fixtures do not become capturable project input even on
 * plain `test:run` or direct compiled invocations.
 */
const fixtureBase = disposableFixtureBase();

async function makePiFixture(
  version: string,
  prefix = "pi-native-host",
  behavior?: "exit1" | "garbage" | "huge" | "hang",
): Promise<PiFixture> {
  const root = await makeFixtureRoot(prefix, `native Pi fixture ${prefix}`);
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  // All fake pi executables are controlled Node-entry fixtures with an
  // execPath shebang (the real Node CLI form): no node entry is required on
  // the fake PATH, and none of these fixtures claims real native Pi runtime
  // compatibility — they only print the exact Pi version/handler behavior
  // each test needs.
  const output = behavior === "exit1"
    ? "process.stderr.write('boom\\n');\nprocess.exit(3);\n"
    : behavior === "garbage"
      ? "process.stdout.write('not-a-version-at-all');\n"
      : behavior === "huge"
        ? "process.stdout.write('1.0.4' + 'x'.repeat(20000));\n"
        : behavior === "hang"
          // The probe owns this exact Node process (its timeout kill is the
          // SIGKILL that ends it); no descendants are spawned and nothing
          // lingers. No cleanup claim is made for arbitrary custom wrappers.
          ? "setTimeout(() => {}, 60000);\n"
          : `process.stdout.write('pi ${version}\\n');\n`;
  await writeFile(join(bin, "pi"), `#!${process.execPath}\n${output}`, "utf8");
  await chmod(join(bin, "pi"), 0o755);
  return { root, bin };
}

// Per-entry receipts recorded when a fixture entry is created or intentionally replaced.
class FixtureOwnership {
  private readonly entries = new Map<string, import("node:fs").BigIntStats>();

  track(path: string, receipt = lstatSync(path, { bigint: true })): void { this.entries.set(resolve(path), receipt); }
  untrack(path: string): void { this.entries.delete(resolve(path)); }
  has(path: string): boolean { return this.entries.has(resolve(path)); }
  matches(path: string, current: import("node:fs").BigIntStats): boolean {
    const expected = this.entries.get(resolve(path));
    return expected !== undefined && current.dev === expected.dev && current.ino === expected.ino
      && (current.mode & 0o170000n) === (expected.mode & 0o170000n);
  }

  /** Receipt a created path and every still-untracked ancestor up to its fixture root. */
  trackWithRoot(root: string, path: string): void {
    const rootPath = resolve(root);
    const target = resolve(path);
    if (target !== rootPath && !isWithin(rootPath, target)) {
      throw new Error(`fixture entry is outside its owned root: ${target}`);
    }
    // An intentional create or replacement always refreshes the exact target
    // receipt; only ancestors that did not exist before are newly adopted.
    if (lstatSync(target, { bigint: true, throwIfNoEntry: false }) !== undefined) this.track(target);
    const created: string[] = [];
    if (target !== rootPath) {
      for (let current = dirname(target); current !== rootPath; current = dirname(current)) {
        if (!this.has(current) && lstatSync(current, { bigint: true, throwIfNoEntry: false }) !== undefined) {
          created.push(current);
        }
      }
    }
    for (const entry of created.reverse()) this.track(entry);
    if (!this.has(rootPath) && lstatSync(rootPath, { bigint: true, throwIfNoEntry: false }) !== undefined) {
      this.track(rootPath);
    }
  }

  /** Drop receipts for a path intentionally removed by the test. */
  untrackTree(path: string): void {
    const target = resolve(path);
    for (const entry of [...this.entries.keys()]) {
      if (entry === target || entry.startsWith(`${target}${sep}`)) this.entries.delete(entry);
    }
  }

  /** Transfer the receipts this tracker holds for a moved subtree; nothing new is adopted. */
  moveTree(from: string, to: string): void {
    const source = resolve(from);
    const destination = resolve(to);
    for (const [path, receipt] of [...this.entries]) {
      if (path !== source && !path.startsWith(`${source}${sep}`)) continue;
      this.entries.delete(path);
      this.entries.set(join(destination, relative(source, path)), receipt);
    }
  }

  /** Verify every receipted entry and parent without removing anything. */
  verify(root?: string): void {
    const failures: unknown[] = [];
    const rootPath = root === undefined ? undefined : resolve(root);
    const expectedChildren = new Map<string, Set<string>>();
    for (const path of this.entries.keys()) {
      const parent = dirname(path);
      if (!this.entries.has(parent)) continue;
      const children = expectedChildren.get(parent) ?? new Set<string>();
      children.add(basename(path));
      expectedChildren.set(parent, children);
    }
    const verify = (path: string, expected: import("node:fs").BigIntStats) => {
      const current = lstatSync(path, { bigint: true });
      assert.ok(current.dev === expected.dev && current.ino === expected.ino &&
        (current.mode & 0o170000n) === (expected.mode & 0o170000n), `changed fixture entry preserved: ${path}`);
    };
    for (const [path, entry] of [...this.entries].sort(([a], [b]) => b.length - a.length)) {
      try {
        let parentMissing = false;
        for (let parent = dirname(path); this.entries.has(parent); parent = dirname(parent)) {
          const currentParent = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
          if (currentParent === undefined) { parentMissing = true; break; }
          verify(parent, this.entries.get(parent)!);
        }
        if (parentMissing) continue; // an entry the test intentionally removed with its subtree
        const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (current === undefined) {
          if (path === rootPath) throw new Error(`fixture root is missing: ${path}`);
          continue; // an entry the test intentionally removed
        }
        verify(path, entry);
        if (current.isDirectory() && !current.isSymbolicLink()) {
          const expected = expectedChildren.get(path) ?? new Set<string>();
          const unexpected = readdirSync(path).filter((name) => !expected.has(name));
          assert.deepEqual(unexpected, [], `unexpected contents in retained fixture directory: ${path}`);
        }
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "fixture ownership verification failed");
  }

  cleanup(): void {
    const failures: unknown[] = [];
    const verify = (path: string, expected: import("node:fs").BigIntStats) => {
      const current = lstatSync(path, { bigint: true });
      assert.ok(current.dev === expected.dev && current.ino === expected.ino &&
        (current.mode & 0o170000n) === (expected.mode & 0o170000n), `changed fixture entry preserved: ${path}`);
    };
    for (const [path, entry] of [...this.entries].sort(([a], [b]) => b.length - a.length)) {
      try {
        try { verify(path, entry); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for (let parent = dirname(path); this.entries.has(parent); parent = dirname(parent)) {
          verify(parent, this.entries.get(parent)!);
        }
        if (entry.isDirectory()) rmdirSync(path); // Unknown contents remain and cause ENOTEMPTY.
        else unlinkSync(path); // Never follow a symlink target.
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "fixture ownership cleanup failed");
  }
}

async function runWithCleanup(body: () => Promise<void>, cleanup: () => void, resolveRefusal?: () => void): Promise<void> {
  const failures: unknown[] = [];
  try { await body(); } catch (error) { failures.push(error); }
  try {
    cleanup();
    resolveRefusal?.();
  } catch (error) {
    // The pre-registered refusal stays in place so the runner cannot delete a
    // fixture whose strict cleanup refused to confirm removal.
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "test body and cleanup failed", { cause: failures[0] });
}

interface FixtureLease {
  readonly root: string;
  readonly receipt: import("node:fs").BigIntStats;
  readonly label: string;
  readonly ownership: FixtureOwnership;
  readonly resolveRefusal: () => void;
  unsettledReason?: string;
}

const fixtureLeases: FixtureLease[] = [];

/** Explicit preservation is 1, default removal is 0/unset, anything else is refused. */
function fixturePreservationRequested(): boolean {
  const value = process.env.PI_TEST_SCRATCH_PRESERVE;
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`PI_TEST_SCRATCH_PRESERVE must be 1 or 0 when set; got ${JSON.stringify(value)}`);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function fixtureLeaseForPath(path: string): FixtureLease | undefined {
  const target = resolve(path);
  return [...fixtureLeases].reverse().find((lease) => isWithin(lease.root, target));
}

function trackFixtureCreatedPath(path: string): void {
  const lease = fixtureLeaseForPath(path);
  if (lease === undefined) return;
  lease.ownership.trackWithRoot(lease.root, path);
}

function trackFixtureRemovedPath(path: string): void {
  const lease = fixtureLeaseForPath(path);
  if (lease !== undefined) lease.ownership.untrackTree(path);
}

function reportFixtureNotice(
  report: { diagnostic?(message: string): void } | undefined,
  notice: string,
): void {
  report?.diagnostic?.(notice);
  process.stderr.write(`${notice}\n`);
}

function markFixtureUnsettled(path: string, reason: string): void {
  const lease = fixtureLeaseForPath(path);
  if (lease !== undefined) lease.unsettledReason = reason;
}

/**
 * Allocate one invocation-owned external fixture root. The refusal is reserved
 * before allocation, and the root and every later created entry receive a
 * receipt before fallible setup can fail.
 */
async function makeFixtureRoot(prefix: string, label = prefix): Promise<string> {
  const resolveRefusal = signalCleanupRefusal(`${label} cleanup pending`);
  let root: string;
  try {
    root = await mkdtemp(join(fixtureBase, `.${prefix}-`));
  } catch (error) {
    resolveRefusal(); // mkdtemp did not return a fixture
    throw error;
  }
  const receipt = lstatSync(root, { bigint: true });
  if (receipt.isSymbolicLink() || !receipt.isDirectory() || realpathSync(root) !== root) {
    // The allocated path is not a canonical real directory: keep the refusal
    // unresolved so the runner retains it instead of deleting uncertain content.
    throw new Error(`allocated fixture root is not a canonical real directory: ${root}`);
  }
  const ownership = new FixtureOwnership();
  ownership.track(root, receipt); // the allocation's own receipt, never a later lookup
  fixtureLeases.push({ root, receipt, label, ownership, resolveRefusal });
  return root;
}

function cleanupFixtureLease(
  lease: FixtureLease,
  preserve: boolean,
  report: { diagnostic?(message: string): void },
): void {
  if (lease.unsettledReason !== undefined) {
    const notice = `fixture retained without confirmed settlement: ${lease.root}: ${lease.unsettledReason}`.slice(0, 2_048);
    reportFixtureNotice(report, notice);
    throw new Error(notice);
  }
  const current = lstatSync(lease.root, { bigint: true, throwIfNoEntry: false });
  if (current === undefined) {
    const notice = `fixture cleanup refused; root is missing without confirmed removal: ${lease.root}`.slice(0, 2_048);
    reportFixtureNotice(report, notice);
    throw new Error(notice);
  }
  try {
    assert.ok(current.isDirectory() && !current.isSymbolicLink()
      && current.dev === lease.receipt.dev && current.ino === lease.receipt.ino,
    `fixture root changed identity: ${lease.root}`);
    assert.equal(realpathSync(lease.root), lease.root, `fixture root is no longer canonical: ${lease.root}`);
    lease.ownership.verify(lease.root);
    if (preserve) {
      reportFixtureNotice(report, `preserved fixture (PI_TEST_SCRATCH_PRESERVE=1): ${lease.root}`);
    } else {
      lease.ownership.cleanup();
      assert.equal(lstatSync(lease.root, { throwIfNoEntry: false }), undefined,
        `fixture root still exists after removal: ${lease.root}`);
    }
    lease.resolveRefusal();
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
    const notice = `fixture cleanup refused; retained ${lease.root}: ${detail}`.slice(0, 2_048);
    reportFixtureNotice(report, notice);
    throw new Error(notice, { cause: error });
  }
}

function finalizeOwnedFixture(ownership: FixtureOwnership, root: string, resolveRefusal: () => void): void {
  try {
    const current = lstatSync(root, { bigint: true, throwIfNoEntry: false });
    assert.ok(current?.isDirectory() && ownership.matches(root, current) && realpathSync(root) === root,
      `fixture root is missing or not a canonical owned directory: ${root}`);
    ownership.verify(root);
    if (fixturePreservationRequested()) {
      reportFixtureNotice(undefined, `preserved fixture (PI_TEST_SCRATCH_PRESERVE=1): ${root}`);
    } else {
      ownership.cleanup();
      assert.equal(lstatSync(root, { throwIfNoEntry: false }), undefined,
        `fixture root still exists after removal: ${root}`);
    }
    resolveRefusal();
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
    const notice = `fixture cleanup refused; retained ${root}: ${detail}`.slice(0, 2_048);
    reportFixtureNotice(undefined, notice);
    throw new Error(notice, { cause: error });
  }
}

function cleanupFixtureLeases(report: { diagnostic?(message: string): void }): void {
  const leases = fixtureLeases.splice(0).reverse();
  if (leases.length === 0) return;
  const preserve = fixturePreservationRequested();
  const failures: unknown[] = [];
  for (const lease of leases) {
    try {
      cleanupFixtureLease(lease, preserve, report);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "fixture cleanup failed");
}

afterEach((t) => {
  cleanupFixtureLeases(t as unknown as { diagnostic?(message: string): void });
});

// Every fixture directory creation is ONE EXCLUSIVE LEVEL at a time. An existing level is
// reused only when this lease already owns it, so a recursive create can never adopt an
// unexplained directory it did not create, and a receipt is recorded only for a level this
// call actually created.
async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  mkdirSync(path, options);
}

function mkdirSync(path: string, options?: { recursive?: boolean }): void {
  const lease = fixtureLeaseForPath(path);
  if (!lease) { fsMkdirSync(path, options); return; } // strict probes manage their own receipts
  const parent = dirname(path);
  if (options?.recursive && path !== lease.root) mkdirSync(parent, options);
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (options?.recursive && current !== undefined) {
    assert.ok(current.isDirectory() && lease.ownership.matches(path, current) && realpathSync(path) === path,
      `not an owned fixture directory: ${path}`);
    return;
  }
  mkdirOwnedLevel(path, lease.ownership);
}

/**
 * Create ONE directory level and record its receipt in the same synchronous step, against
 * either the lease's ledger or a probe's explicit ledger. Receipting by pathname after an
 * await would re-read whatever occupies the path in the meantime and could adopt — then
 * delete — an empty replacement directory instead of refusing it.
 */
function mkdirOwnedLevel(path: string, owner: FixtureOwnership): void {
  const parent = dirname(path);
  const parentReceipt = lstatSync(parent, { bigint: true });
  assert.ok(parentReceipt.isDirectory() && owner.matches(parent, parentReceipt) && realpathSync(parent) === parent,
    `not an owned fixture directory: ${parent}`);
  fsMkdirSync(path);
  owner.track(path);
}

type FixtureWriteOptions = BufferEncoding | { encoding?: BufferEncoding; flag?: "wx"; mode?: number };
/** The payload forms FileHandle.writeFile accepts at runtime (streams included). */
type FixtureWriteData = Parameters<typeof fsWriteFile>[1] | Parameters<import("node:fs/promises").FileHandle["writeFile"]>[0];

/**
 * The receipt comes from the OPENED DESCRIPTOR, never from whatever pathname happens
 * to exist afterwards. A fresh file is receipted from its successful exclusive open and
 * written through that same descriptor, so a payload failure can never leave an
 * unreceipted entry behind, and a replacement appearing mid-write is never adopted. An
 * existing entry is only truncated after its open descriptor matches an existing
 * receipt, so an unexplained file is refused instead of overwritten or receipted.
 */
async function writeFile(
  path: string,
  data: FixtureWriteData,
  options?: FixtureWriteOptions,
  owner = fixtureLeaseForPath(path)?.ownership,
): Promise<void> {
  if (!owner) return fsWriteFile(path, data, options);
  assert.equal(realpathSync(dirname(path)), dirname(path), `noncanonical fixture parent: ${path}`);
  const encoding = typeof options === "string" ? options : options?.encoding;
  const mode = typeof options === "object" ? options.mode : undefined;
  const exclusive = typeof options === "object" && options.flag === "wx";
  const create = exclusive || lstatSync(path, { throwIfNoEntry: false }) === undefined;
  const handle = await fsOpen(path, create ? "wx" : fsFlags.O_WRONLY | fsFlags.O_NOFOLLOW | fsFlags.O_NONBLOCK, mode);
  try {
    const receipt = await handle.stat({ bigint: true });
    assert.ok(receipt.isFile(), `not a fixture regular file: ${path}`);
    if (create) owner.track(path, receipt);
    else {
      assert.ok(owner.matches(path, receipt), `refusing to overwrite an unowned fixture file: ${path}`);
      await handle.truncate(0);
    }
    await handle.writeFile(data as Parameters<import("node:fs/promises").FileHandle["writeFile"]>[0], { encoding });
  } finally {
    await handle.close();
  }
}

/** Every synchronous fixture write creates a new file and receipts it from its descriptor. */
function writeFileSync(path: string, data: Parameters<typeof fsWriteFileSync>[1], encoding: BufferEncoding): void {
  const owner = fixtureLeaseForPath(path)?.ownership;
  assert.equal(realpathSync(dirname(path)), dirname(path), `noncanonical fixture parent: ${path}`);
  const fd = fsOpenSync(path, "wx");
  try {
    owner?.track(path, fstatSync(fd, { bigint: true }));
    fsWriteFileSync(fd, data, encoding);
  } finally {
    fsCloseSync(fd);
  }
}

/**
 * A fixture symlink needs an existing, canonical, ALREADY RECEIPTED parent before the link
 * is written, and afterwards only the link itself is receipted: creating a link never
 * adopts an unexplained ancestor.
 */
async function symlink(target: string, path: string, owner = fixtureLeaseForPath(path)?.ownership): Promise<void> {
  assert.ok(owner, `symlink has no fixture ownership ledger: ${path}`);
  const parent = dirname(path);
  const parentReceipt = lstatSync(parent, { bigint: true });
  assert.ok(parentReceipt.isDirectory() && owner.matches(parent, parentReceipt) && realpathSync(parent) === parent,
    `symlink parent is not an owned fixture directory: ${parent}`);
  fsSymlinkSync(target, path); // no await between creation and receipt
  const receipt = lstatSync(path, { bigint: true });
  assert.ok(receipt.isSymbolicLink(), `fixture symlink changed after creation: ${path}`);
  owner.track(path, receipt); // the link alone, never its ancestors
}

/**
 * Fixture copies traverse the SOURCE and create every destination entry EXCLUSIVELY,
 * receipting each creation as it happens. A copy that fails partway therefore leaves only
 * invocation-owned entries, and nothing is ever adopted at a destination the copy never
 * reached: the destination tree is never walked. An existing destination entry is reused
 * only when this lease already owns it exactly.
 */
async function cp(
  source: string,
  destination: string,
  options: { recursive?: boolean; filter?: (source: string, destination: string) => boolean | Promise<boolean> } = {},
): Promise<void> {
  const lease = fixtureLeaseForPath(destination);
  assert.ok(lease, `copy destination is outside an owned fixture: ${destination}`);
  if (options.filter && !(await options.filter(source, destination))) return;
  const entry = await lstat(source);
  assert.ok(entry.isFile() || entry.isDirectory(), `unsupported fixture copy entry: ${source}`);
  const existing = lstatSync(destination, { bigint: true, throwIfNoEntry: false });
  if (existing !== undefined) {
    assert.ok(entry.isDirectory() && existing.isDirectory() && lease.ownership.matches(destination, existing),
      `copy destination already exists and is not an owned directory: ${destination}`);
  } else if (entry.isDirectory()) {
    assert.ok(options.recursive, `fixture directory copy requires recursive: ${source}`);
    mkdirOwnedLevel(destination, lease.ownership); // create and receipt in one synchronous step
  } else {
    const parent = dirname(destination);
    const parentReceipt = lstatSync(parent, { bigint: true });
    assert.ok(parentReceipt.isDirectory() && lease.ownership.matches(parent, parentReceipt) && realpathSync(parent) === parent,
      `copy parent is not an owned directory: ${parent}`);
    const bytes = await readFile(source);
    const handle = await fsOpen(destination, "wx", entry.mode & 0o777);
    try {
      lease.ownership.track(destination, await handle.stat({ bigint: true }));
      await handle.writeFile(bytes);
      await handle.chmod(entry.mode & 0o777);
    } finally {
      await handle.close();
    }
  }
  if (entry.isDirectory()) {
    for (const name of await readdir(source)) await cp(join(source, name), join(destination, name), options);
  }
}

/**
 * A fixture rename MOVES EXISTING RECEIPTS. The source subtree is verified before it moves,
 * so an unexplained descendant travels with the source but is never receipted at the
 * destination: teardown still refuses instead of deleting content this call never owned.
 */
async function rename(from: string, to: string): Promise<void> {
  const lease = fixtureLeaseForPath(from);
  const destinationLease = fixtureLeaseForPath(to);
  if (!lease && !destinationLease) return fsRename(from, to); // strict probes manage their own receipts
  assert.ok(lease !== undefined && lease === destinationLease && lease.ownership.has(from), `rename source is not owned: ${from}`);
  lease.ownership.verify(lease.root);
  const parent = dirname(to);
  const parentReceipt = lstatSync(parent, { bigint: true });
  assert.ok(parentReceipt.isDirectory() && lease.ownership.matches(parent, parentReceipt) && realpathSync(parent) === parent,
    `rename destination parent is not owned: ${parent}`);
  assert.equal(lstatSync(to, { bigint: true, throwIfNoEntry: false }), undefined, `rename destination already exists: ${to}`);
  await fsRename(from, to);
  lease.ownership.moveTree(from, to);
}

async function rm(...args: Parameters<typeof fsRm>): Promise<void> {
  const result = await fsRm(...args);
  trackFixtureRemovedPath(String(args[0]));
  return result;
}

function rmSync(...args: Parameters<typeof fsRmSync>): void {
  const result = fsRmSync(...args);
  trackFixtureRemovedPath(String(args[0]));
  return result;
}

function rmdirSync(...args: Parameters<typeof fsRmdirSync>): void {
  const result = fsRmdirSync(...args);
  trackFixtureRemovedPath(String(args[0]));
  return result;
}

function unlinkSync(...args: Parameters<typeof fsUnlinkSync>): void {
  const result = fsUnlinkSync(...args);
  trackFixtureRemovedPath(String(args[0]));
  return result;
}

interface LauncherHelperModule {
  renameIntoPlaceWithContentionRetry(
    rename: () => void,
    options?: { destination?: string },
  ): { published: boolean; attempts: number; lastError?: { code?: string; message?: string } };
}

/** The same launcher helper module instance the production publisher loads for its rename. */
function launcherHelperModule(): LauncherHelperModule {
  return require(resolve("scripts/pi-review-gate-launcher.cjs")) as LauncherHelperModule;
}

/** Same inode and file type as a recorded receipt. */
function sameFixtureEntry(current: import("node:fs").BigIntStats, expected: import("node:fs").BigIntStats): boolean {
  return current.dev === expected.dev && current.ino === expected.ino
    && (current.mode & 0o170000n) === (expected.mode & 0o170000n);
}

/**
 * Whether opening `path` is an EXCLUSIVE CREATE inside one of the planned staging
 * directories — the only open that can make a staging entry invocation-owned. A plain
 * read, append, or shared open of a staging-named path adopts nothing, and a path
 * outside the planned staging directories is never publication staging.
 */
function isExclusiveStagingCreate(path: string, flags: unknown, stagingDirs: ReadonlySet<string>): boolean {
  if (!basename(path).startsWith(".skill-publish.") || !stagingDirs.has(dirname(path))) return false;
  if (typeof flags === "string") return flags.includes("x"); // "wx", "ax", "wx+", ...
  if (typeof flags === "number") return (flags & fsFlags.O_CREAT) !== 0 && (flags & fsFlags.O_EXCL) !== 0;
  return false;
}

function prepareNativeLaunch(
  options: Parameters<typeof rawPrepareNativeLaunch>[0],
): ReturnType<typeof rawPrepareNativeLaunch> {
  const agentDir = options.agentDir;
  const lease = fixtureLeaseForPath(agentDir);
  if (options.nativeSetup || !lease || !lease.ownership.has(agentDir)) return rawPrepareNativeLaunch(options);
  const owner = lease.ownership;
  owner.verify(lease.root);
  const plannedDirs: string[] = [];
  const plannedFiles = new Set<string>();
  for (const skill of NATIVE_SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const destination = join(agentDir, "skills", skill.name, ...file.destination);
      plannedFiles.add(destination);
      for (let dir = dirname(destination); dir !== agentDir; dir = dirname(dir)) {
        if (!plannedDirs.includes(dir)) plannedDirs.push(dir);
      }
    }
  }
  // Ownership is recorded at the mutation seams themselves — the exclusive staging create
  // and the publication rename — never inferred from a before/after snapshot of the tree.
  // A destination the publisher never reached therefore stays unowned, however plausible
  // its path looks, and teardown refuses to adopt it.
  const fsModule = require("node:fs") as typeof import("node:fs");
  const originalMkdir = fsModule.mkdirSync;
  const originalOpen = fsModule.openSync;
  const originalUnlink = fsModule.unlinkSync;
  const helper = launcherHelperModule();
  const originalRename = helper.renameIntoPlaceWithContentionRetry;
  const stagingDirs = new Set([...plannedFiles].map((file) => dirname(file)));
  // The identity taken from the descriptor at the exclusive staging create, carried to the
  // publication rename so the receipt follows those bytes rather than a pathname.
  let staged: { path: string; receipt: import("node:fs").BigIntStats } | undefined;
  // A planned mutation may only write through a parent this lease already owns and that
  // is still canonical. The check runs BEFORE the create (so nothing is written into an
  // already-displaced parent) and again after it (the descriptor then identifies the entry
  // that was actually created).
  const assertPublicationParent = (path: string) => {
    const parent = dirname(path);
    const parentReceipt = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    assert.ok(parentReceipt?.isDirectory() && owner.matches(parent, parentReceipt) && realpathSync(parent) === parent,
      `publication parent is not an owned directory: ${parent}`);
  };
  // The staging entry must still be the exclusively created inode. A replaced pathname
  // holds unknown bytes, so the check runs on every path that could remove or move the
  // staging entry: the publisher's failure-path unlink as well as each rename attempt.
  const assertStagingEntry = (pending: NonNullable<typeof staged>) => {
    const parent = dirname(pending.path);
    const directory = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    const current = lstatSync(pending.path, { bigint: true, throwIfNoEntry: false });
    assert.ok(directory?.isDirectory() && owner.matches(parent, directory) && realpathSync(parent) === parent
      && current !== undefined && sameFixtureEntry(current, pending.receipt),
    `publication staging entry changed after its exclusive open: ${pending.path}`);
  };
  fsModule.unlinkSync = ((path: Parameters<typeof originalUnlink>[0]) => {
    const pending = staged;
    if (typeof path === "string" && pending !== undefined && pending.path === path) assertStagingEntry(pending);
    return originalUnlink(path);
  }) as unknown as typeof originalUnlink;
  fsModule.mkdirSync = ((path: Parameters<typeof originalMkdir>[0], options?: Parameters<typeof originalMkdir>[1]) => {
    const planned = typeof path === "string" && plannedDirs.includes(path);
    if (planned) assertPublicationParent(path);
    const result = originalMkdir(path as string, options);
    if (planned) {
      assertPublicationParent(path);
      owner.track(path);
    }
    return result;
  }) as unknown as typeof originalMkdir;
  helper.renameIntoPlaceWithContentionRetry = (rename, helperOptions) => {
    const pending = staged;
    const destination = helperOptions?.destination;
    if (pending === undefined || destination === undefined || !plannedFiles.has(destination)) {
      return originalRename(rename, helperOptions);
    }
    // The refusal is raised outside the helper's retry loop, so it never becomes a
    // failed-rename outcome that would make the publisher unlink the replacement.
    assertStagingEntry(pending);
    const outcome = originalRename(() => {
      assertStagingEntry(pending);
      // Source identity alone cannot protect an unowned destination: immediately before
      // each real rename, the destination must be absent or still be its receipted entry.
      const current = lstatSync(destination, { bigint: true, throwIfNoEntry: false });
      assert.ok(current === undefined || owner.matches(destination, current),
        `publication destination is not owned: ${destination}`);
      rename();
    }, helperOptions);
    if (outcome.published) {
      // The receipt only moves to the destination once that path holds the same inode.
      const landed = lstatSync(destination, { bigint: true, throwIfNoEntry: false });
      assert.ok(landed !== undefined && sameFixtureEntry(landed, pending.receipt),
        `published destination is not the exclusively staged inode: ${destination}`);
      owner.untrack(pending.path);
      owner.track(destination, pending.receipt);
      staged = undefined;
    }
    return outcome;
  };
  // Exclusively staged publication bytes are receipted AT THE OPEN, from the descriptor: a
  // staging file that survives a failed publication (its best-effort unlink included) is
  // already invocation-owned, so teardown removes it instead of refusing over it. Only an
  // exclusive create confers ownership, and a receipt that cannot be taken closes the
  // descriptor it opened instead of leaking it.
  fsModule.openSync = ((path: Parameters<typeof originalOpen>[0], flags: Parameters<typeof originalOpen>[1], mode?: number) => {
    const staging = typeof path === "string" && isExclusiveStagingCreate(path, flags, stagingDirs);
    // No file is created at all until the parent is confirmed owned and canonical.
    if (staging) assertPublicationParent(path);
    const fd = (originalOpen as unknown as (p: unknown, f?: unknown, m?: number) => number)(path, flags, mode);
    if (!staging) return fd;
    try {
      assertPublicationParent(path);
      const created = fsModule.fstatSync(fd, { bigint: true });
      owner.track(path, created);
      staged = { path, receipt: created };
    } catch (error) {
      // The publisher never receives the descriptor when bookkeeping fails, so it can
      // never close it: close it here and let the unresolved refusal stand.
      try { fsCloseSync(fd); } catch { /* already closed */ }
      throw error;
    }
    return fd;
  }) as unknown as typeof originalOpen;
  try {
    return rawPrepareNativeLaunch(options);
  } finally {
    fsModule.mkdirSync = originalMkdir;
    fsModule.openSync = originalOpen;
    fsModule.unlinkSync = originalUnlink;
    helper.renameIntoPlaceWithContentionRetry = originalRename;
  }
}

interface PackageFixture {
  /** Real (symlink-resolved) root of the synthetic fixture tree. */
  root: string;
  packageRoot: string;
  agentDir: string;
  workspace: string;
  configPath: string;
  skillsRoot: string;
}

/**
 * Strict allocation for a fixture with an explicit ledger: the path `mkdtemp` returned is
 * recorded in `allocated` BEFORE its receipt is validated, so a caller can distinguish "no
 * path was ever returned" (nothing to finalize) from "a path exists whose receipt failed"
 * (which finalization must refuse and retain).
 */
async function allocateStrictFixtureRoot(prefix: string, ownership: FixtureOwnership, allocated: { path?: string }): Promise<string> {
  const path = await mkdtemp(join(fixtureBase, `.${prefix}-`));
  allocated.path = path;
  const receipt = lstatSync(path, { bigint: true });
  assert.ok(receipt.isDirectory() && realpathSync(path) === path,
    `allocated fixture root is not a canonical real directory: ${path}`);
  ownership.track(path, receipt);
  return path;
}

/**
 * Finalize a strict fixture: only a path that allocation actually returned can be finalized.
 * No path means nothing was created, so the marker is cleared rather than left pending.
 */
function finalizeStrictFixtureRoot(ownership: FixtureOwnership, allocated: { path?: string }, resolveRefusal: () => void): void {
  if (allocated.path === undefined) {
    resolveRefusal(); // allocation never returned a path: there is nothing to retain
    return;
  }
  finalizeOwnedFixture(ownership, allocated.path, resolveRefusal);
}

async function makePackageFixture(
  prefix = "pi-native-host-pkg",
  strict?: { root: string; ownership: FixtureOwnership },
  onRoot?: (root: string) => void | Promise<void>,
): Promise<PackageFixture> {
  const root = strict?.root ?? await makeFixtureRoot(prefix, `native package fixture ${prefix}`);
  const owner = strict?.ownership ?? fixtureLeaseForPath(root)!.ownership;
  await onRoot?.(root);
  const packageRoot = join(root, "package");
  const bin = join(root, "bin");
  const agentDir = join(root, "home", ".pi", "agent");
  const workspace = join(root, "workspace");
  const dirs = [
    packageRoot,
    join(packageRoot, "dist"),
    join(packageRoot, "dist", "src"),
    join(packageRoot, "dist", "src", "session-host"),
    join(root, "home"),
    join(root, "home", ".pi"),
    agentDir,
    workspace,
    bin,
    join(packageRoot, "skills"),
    join(packageRoot, "skills", "pi-review-gate-orchestrator"),
    join(packageRoot, "skills", "pi-review-gate-orchestrator", "references"),
    join(packageRoot, "skills", "pi-review-gate-execution"),
    join(packageRoot, "skills", "pi-review-gate-research"),
    join(packageRoot, "skills", "pi-review-gate-completion"),
  ];
  // Create one level at a time (exclusive) and record each receipt in that same synchronous
  // step, so a setup failure never leaves created entries untracked, an untracked
  // pre-existing directory is refused (EEXIST) rather than adopted, and no later lookup of
  // the pathname can swap in the identity of a replacement directory.
  for (const dir of dirs) mkdirOwnedLevel(dir, owner);
  await writeFile(join(bin, "pi"), `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4\\n');\n`, "utf8", owner);
  await chmod(join(bin, "pi"), 0o755);
  await writeFile(join(packageRoot, "dist", "src", "index.js"), "// gate extension\n", "utf8", owner);
  await writeFile(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// reporter\n", "utf8", owner);
  // Placeholder for the sibling's compiled bootstrap-preload (descriptor
  // tests only; early-env/spawn behavior belongs to the reporter sibling).
  await writeFile(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// preload placeholder\n", "utf8", owner);
  // Shipped skill sources, mirroring the packaged tree.
  await writeFile(join(packageRoot, "skills", "pi-review-gate-orchestrator", "SKILL.md"), "orchestrator skill\n", "utf8", owner);
  await writeFile(join(packageRoot, "skills", "pi-review-gate-orchestrator", "references", "recovery.md"), "recovery runbook\n", "utf8", owner);
  await writeFile(join(packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"), "execution skill\n", "utf8", owner);
  await writeFile(join(packageRoot, "skills", "pi-review-gate-research", "SKILL.md"), "research skill\n", "utf8", owner);
  await writeFile(join(packageRoot, "skills", "pi-review-gate-completion", "SKILL.md"), "completion skill\n", "utf8", owner);
  const configPath = join(agentDir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ enabled: true, review: { activeReviewers: [] } }), "utf8", owner);
  return {
    root,
    packageRoot,
    agentDir,
    workspace,
    configPath,
    skillsRoot: join(agentDir, "skills"),
  };
}

function baseOptions(
  fixture: PackageFixture,
  overrides: Partial<{
    nativeSetup: boolean;
    packageRoot: string;
    agentDir: string;
    workspace: string;
    piExecutable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    savedSession: SavedSessionAdmission;
    nativeInputOriginFraming: boolean;
  }> = {},
): Parameters<typeof prepareNativeLaunch>[0] {
  return {
    nativeSetup: false,
    packageRoot: fixture.packageRoot,
    agentDir: fixture.agentDir,
    workspace: fixture.workspace,
    piExecutable: join(fixture.root, "bin", "pi"),
    args: [],
    env: { PATH: process.env.PATH },
    ...overrides,
  };
}

test("resolveNativePi resolves a PATH pi by bare filename without shell interpretation", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  const resolved = resolveNativePi({ executable: "pi", env: { PATH: `${fixture.bin}:/nonexistent` } });
  assert.equal(resolved.version, "1.0.4");
  assert.ok(resolved.file.startsWith(fixture.bin), "resolved file should come from the searched PATH entry");
  assert.ok(resolved.file !== "pi" && resolve(resolved.file) === resolved.file, "file must be absolute (cwd independent)");
});

test("native executable validation checks caller access, not any execute bit", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("requires an unprivileged POSIX user");
    return;
  }
  const denied = await makePiFixture("1.0.4");
  const usable = await makePiFixture("1.0.4");
  const pkg = await makePackageFixture();
  const deniedFile = join(denied.bin, "pi");
  await chmod(deniedFile, 0o645);
  // PATH resolution must skip the denied entry and select the usable later one.
  const resolved = resolveNativePi({ env: { PATH: `${denied.bin}:${usable.bin}` } });
  assert.equal(resolved.file, join(usable.bin, "pi"));
  // Explicit-path preparation also rejects the denied file.
  assert.throws(
    () => resolveNativePi({ executable: deniedFile, env: { PATH: usable.bin } }),
    /not an executable regular file/,
  );
  // Descriptor preparation rejects the denied executable before anything runs.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { piExecutable: deniedFile })),
    /not an executable regular file/,
  );
  assert.equal(existsSync(pkg.skillsRoot), false);
});

test("resolveNativePi accepts an explicit actual Node Pi CLI entry path", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  const customDir = join(fixture.root, "custom-pi");
  await mkdir(customDir, { recursive: true });
  const explicit = join(customDir, "pi");
  await writeFile(explicit, `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4\\n');\n`, "utf8");
  await chmod(explicit, 0o755);
  const resolved = resolveNativePi({ executable: explicit, env: { PATH: "/nonexistent" } });
  assert.equal(resolved.file, explicit);
  assert.equal(resolved.version, "1.0.4");
});

test("resolveNativePi accepts the standard env Node shebang but rejects unproven interpreter flags", async (t) => {
  const fixture = await makePiFixture("1.0.4", "pi-native-host-shebang");

  const envEntry = join(fixture.root, "env-pi");
  await writeFile(envEntry, "#!/usr/bin/env node\nprocess.stdout.write('pi 1.0.4\\n');\n", "utf8");
  await chmod(envEntry, 0o755);
  const envPath = `${dirname(process.execPath)}:${process.env.PATH ?? ""}`;
  assert.equal(
    resolveNativePi({ executable: envEntry, env: { PATH: envPath } }).version,
    "1.0.4",
    "the standard '#!/usr/bin/env node' entry is positive Node evidence",
  );

  const unsupported = [
    `#!${process.execPath} --no-warnings\nprocess.stdout.write('pi 1.0.4\\n');\n`,
    "#!/usr/bin/env -S node\nprocess.stdout.write('pi 1.0.4\\n');\n",
    "#!/usr/bin/env node --no-warnings\nprocess.stdout.write('pi 1.0.4\\n');\n",
    `#!${process.execPath}${" ".repeat(600)}`,
  ];
  for (const [index, source] of unsupported.entries()) {
    const candidate = join(fixture.root, `unsupported-${index}`);
    await writeFile(candidate, source, "utf8");
    await chmod(candidate, 0o755);
    assert.throws(
      () => resolveNativePi({ executable: candidate, env: { PATH: envPath } }),
      /positive Node-entry shebang/,
      `entry ${index} has flags or dispatch syntax without positive evidence`,
    );
  }
});

test("resolveNativePi rejects shell command strings, metacharacters, and bare PATH misses", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  // A shell command string with a slash in it is never executed either: it
  // falls to explicit-path validation and fails as a nonpath (covered in the
  // explicit-path test below); only exact bare names reach PATH lookup.
  assert.throws(
    () => resolveNativePi({ executable: "pi touch tmpfile", env: { PATH: fixture.bin } }),
    /command string/,
  );
  assert.throws(() => resolveNativePi({ executable: "pi|touch", env: { PATH: fixture.bin } }), /command string/);
  assert.throws(() => resolveNativePi({ executable: "pi", env: { PATH: join(fixture.root, "missing-bin") } }), /was not found on PATH/);
});

test("resolveNativePi fails closed on exit failure, garbage version, oversize output, and timeout", async (t) => {
  const cases = [
    ["exit1", /exited with status 3/] as const,
    ["garbage", /official version format/] as const,
    ["huge", /probe limit/] as const,
    ["hang", /did not answer within/] as const,
  ] as const;
  for (const [behavior, pattern] of cases) {
    const fixture = await makePiFixture("1.0.4", "pi-native-host-probe", behavior);
    try {
      resolveNativePi({ executable: "pi", env: { PATH: `${fixture.bin}:${process.env.PATH}` } });
      assert.fail(`expected failure for behavior ${behavior}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, pattern, `behavior ${behavior} should match the diagnostic`);
      assert.doesNotMatch(message, /boom/, "diagnostics must never dump command output");
      assert.doesNotMatch(message, /xxxx/, "diagnostics must never dump oversized output");
    }
  }
});

test("resolveNativePi enforces the pinned 1.0.4 minimum with no old-compatibility scaffold", async (t) => {
  const fixture = await makePiFixture("1.0.3");
  assert.throws(
    () => resolveNativePi({ executable: "pi", env: { PATH: `${fixture.bin}:${process.env.PATH}` } }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return /requires Pi 1\.0\.4 or newer|found 1\.0\.3/.test(message);
    },
  );
});

test("prepareNativeLaunch composes the exact standalone-policy native descriptor", async (t) => {
  const pkg = await makePackageFixture();
  const pi = await makePiFixture("1.0.4");
  const forwarded = ["-p", "plan", "--tool", "read,edit", "commit;-ish;$(x)"];
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    piExecutable: join(pi.root, "bin", "pi"),
    args: forwarded,
  }));
  assert.equal(descriptor.file, join(pi.root, "bin", "pi"));
  const preloadPath = join(pkg.packageRoot, "dist", "src", "session-host", "bootstrap-preload.js");
  assert.deepEqual(descriptor.args, [
    "--extension",
    join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(pkg.packageRoot, "dist", "src", "index.js"),
    ...forwarded,
  ], "the reporter extension loads first, then the gate extension, then native args");
  assert.equal(descriptor.cwd, pkg.workspace);
  assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "none");
  assert.equal(descriptor.env.PI_REVIEW_GATE_CODEMODE_DEFAULT, "1");
  assert.equal(descriptor.env.PI_CODING_AGENT_DIR, pkg.agentDir);
  assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, pkg.configPath);
  assert.equal(descriptor.env.PI_REVIEW_GATE_DISABLED, undefined, "no kill switch is invented by preparation");
  // With no inherited NODE_OPTIONS: exactly the preload require clause, and a
  // null original in the one-shot restoration sidecar.
  assert.equal(descriptor.env.NODE_OPTIONS, `--require="${preloadPath}"`);
  assert.equal(descriptor.env[NODE_OPTIONS_RESTORE_ENV], JSON.stringify({ original: null }));
});

test("prepareNativeLaunch consumes explicit --scheduler opt-in and clears inherited scheduler state", async (t) => {
  const pkg = await makePackageFixture();
  // Without the flag: an inherited PI_REVIEW_GATE_SCHEDULER must not survive.
  const off = prepareNativeLaunch(baseOptions(pkg, {
    args: ["-p", "plan"],
    env: { PATH: process.env.PATH, PI_REVIEW_GATE_SCHEDULER: "1" },
  }));
  assert.equal(off.env.PI_REVIEW_GATE_SCHEDULER, undefined);
  assert.deepEqual(off.args.slice(4), ["-p", "plan"]);
  // With the flag: consumed exactly like the ordinary wrapper.
  const on = prepareNativeLaunch(baseOptions(pkg, { args: ["--scheduler", "-p", "plan"] }));
  assert.equal(on.env.PI_REVIEW_GATE_SCHEDULER, "1");
  assert.deepEqual(on.args.slice(4), ["-p", "plan"]);
  assert.ok(!on.args.includes("--scheduler"), "the consumed flag is never forwarded to pi");
});

test("prepareNativeLaunch strips status authorization from the descriptor without touching the caller env", async (t) => {
  const pkg = await makePackageFixture();
  const callerEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_OPTIONS: "--no-warnings",
    [SESSION_HOST_BOOTSTRAP_ENV]: "session-host-token",
    [NODE_OPTIONS_RESTORE_ENV]: '{"original":"stale"}',
    [RUNTIME_ROLE_ENV]: "",
    PI_REVIEW_GATE_SETTLEMENT_SECRET: "stale-secret",
    PI_REVIEW_GATE_SETTLEMENT_PATH: "stale-path",
    PI_REVIEW_GATE_SETTLEMENT_SESSION: "stale-session",
    PI_REVIEW_GATE_SETTLEMENT_CHILD: "1",
    PI_REVIEW_GATE_QUIESCENCE_SECRET: "stale-quiescence",
    processSentinel: "keep-me",
  };
  const sentinelBefore = "pi-native-host-sentinel";
  process.env[sentinelBefore] = sentinelBefore;
  try {
    const descriptor = prepareNativeLaunch(baseOptions(pkg, { env: callerEnv }));
    assert.equal(descriptor.env[SESSION_HOST_BOOTSTRAP_ENV], undefined, "bootstrap token is absent from the setup descriptor");
    assert.equal(descriptor.env.PI_REVIEW_GATE_SETTLEMENT_SECRET, undefined);
    assert.equal(descriptor.env.PI_REVIEW_GATE_SETTLEMENT_PATH, undefined);
    assert.equal(descriptor.env.PI_REVIEW_GATE_SETTLEMENT_SESSION, undefined);
    assert.equal(descriptor.env.PI_REVIEW_GATE_SETTLEMENT_CHILD, undefined);
    assert.equal(descriptor.env.PI_REVIEW_GATE_QUIESCENCE_SECRET, undefined);
    // The user's original NODE_OPTIONS is preserved exactly in the one-shot
    // restoration sidecar; the inherited stale sidecar is replaced, and the
    // preload require clause is PREPENDED before the original value.
    const preloadPath = join(pkg.packageRoot, "dist", "src", "session-host", "bootstrap-preload.js");
    assert.equal(descriptor.env[NODE_OPTIONS_RESTORE_ENV], JSON.stringify({ original: "--no-warnings" }));
    assert.equal(descriptor.env.NODE_OPTIONS, `--require="${preloadPath}" --no-warnings`);
    assert.equal(callerEnv[SESSION_HOST_BOOTSTRAP_ENV], "session-host-token", "the caller env object is never mutated");
    assert.equal(callerEnv.NODE_OPTIONS, "--no-warnings", "the caller NODE_OPTIONS is never mutated");
    assert.equal(callerEnv.PI_REVIEW_GATE_SETTLEMENT_SECRET, "stale-secret", "the caller env object is never mutated");
    assert.equal(process.env[sentinelBefore], sentinelBefore, "process.env is never mutated");
  } finally {
    delete process.env[sentinelBefore];
  }
});

test("prepareNativeLaunch rejects explicit worker/executor role input (actual flag names) and never elevates it", async (t) => {
  const pkg = await makePackageFixture();
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, [RUNTIME_ROLE_ENV]: "executor" } })),
    (error: unknown) => (error instanceof Error ? error.message.includes(RUNTIME_ROLE_ENV) : false),
    "executor runtime role input is rejected fail-closed",
  );
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, [RUNTIME_ROLE_ENV]: "worker" } })),
    /runtime role authorization comes only from the delegated execution adapter/,
    "worker runtime role input is also rejected",
  );
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, [EXECUTOR_TOOL_CATALOG_ENV]: "{}" } })),
    (error: unknown) => (error instanceof Error ? error.message.includes(EXECUTOR_TOOL_CATALOG_ENV) : false),
    "executor tool catalogs are executor-role-only",
  );
});

test("prepareNativeLaunch validates required compiled extension files before any publication", async (t) => {
  const pkg = await makePackageFixture();
  rmSync(join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"));
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), /compiled extension file that is missing/);
  assert.equal(existsSync(pkg.skillsRoot), false, "no skill publication may run when the compiled files are missing");
});

test("prepareNativeLaunch validates the profile: local config object and no global fallback", async (t) => {
  const pkg = await makePackageFixture();

  // A globally-inherited config path is overridden to the profile-local config.
  const withFallback = prepareNativeLaunch(baseOptions(pkg, {
    env: { PATH: process.env.PATH, PI_REVIEW_GATE_CONFIG: "/some/global/fallback.json" },
  }));
  assert.equal(withFallback.env.PI_REVIEW_GATE_CONFIG, pkg.configPath, "the profile-local config wins over any inherited value");

  // Invalid config shape: array, invalid JSON, missing — all reject; no compatibility fallback, no creation.
  await writeFile(pkg.configPath, JSON.stringify([1, 2]), "utf8");
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), /must be a JSON object/);
  await writeFile(pkg.configPath, "{not json", "utf8");
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), /is not valid JSON/);
  rmSync(pkg.configPath);
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH } })), /profile registry owns its creation/);
  assert.equal(
    existsSync(join(pkg.root, "home", ".config", "pi-review-gate", "config.json")),
    false,
    "no fallback config is created or consulted",
  );
});

test("nativeSetup retains native config, provider environment, resources, and skill locations", async (t) => {
  const pkg = await makePackageFixture();
  const nativeEnv = {
    HOME: join(pkg.root, "home"),
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: pkg.agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(pkg.root, "native-sessions"),
    PI_IMAGE_PROTOCOL: "native-image-selection",
    PI_REVIEW_GATE_CODEMODE_DEFAULT: "0",
    PI_REVIEW_GATE_SCHEDULER: "native-scheduler-setting",
    PI_REVIEW_GATE_DISABLED: "0",
    PI_PROVIDER_FIXTURE_KEY: "synthetic-provider-value",
  };
  const markers = [
    ["settings.json", "{\"theme\":\"native\"}\n"],
    ["keybindings.json", "{\"keys\":[]}\n"],
    ["models.json", "{\"provider\":\"native\"}\n"],
    ["mcp.json", "{\"servers\":{}}\n"],
    ["auth.json", "synthetic-fixture-auth-data\n"],
  ] as const;
  const originalConfig = await readFile(pkg.configPath);
  for (const [filename, bytes] of markers) await writeFile(join(pkg.agentDir, filename), bytes, "utf8");
  const nativeExtension = join(pkg.agentDir, "extensions", "native-extension.js");
  const nativeSkill = join(pkg.agentDir, "skills", "native-skill", "SKILL.md");
  const nativeSession = join(pkg.agentDir, "sessions", "saved.jsonl");
  await Promise.all([
    mkdir(dirname(nativeExtension), { recursive: true }),
    mkdir(dirname(nativeSkill), { recursive: true }),
    mkdir(dirname(nativeSession), { recursive: true }),
    mkdir(nativeEnv.PI_CODING_AGENT_SESSION_DIR, { recursive: true }),
  ]);
  await writeFile(nativeExtension, "native extension marker\n", "utf8");
  await writeFile(nativeSkill, "native skill marker\n", "utf8");
  await writeFile(nativeSession, "saved conversation marker\n", "utf8");
  const sessionMarker = join(nativeEnv.PI_CODING_AGENT_SESSION_DIR, "retained.jsonl");
  await writeFile(sessionMarker, "native session directory marker\n", "utf8");

  const descriptor = prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeEnv }));
  assert.equal(descriptor.env.PI_CODING_AGENT_DIR, realpathSync(pkg.agentDir));
  assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, undefined, "normal native config resolution is left to the extension");
  assert.equal(descriptor.env.PI_CODING_AGENT_SESSION_DIR, nativeEnv.PI_CODING_AGENT_SESSION_DIR);
  assert.equal(descriptor.env.PI_PROVIDER_FIXTURE_KEY, nativeEnv.PI_PROVIDER_FIXTURE_KEY);
  assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "native-image-selection");
  assert.equal(descriptor.env.PI_REVIEW_GATE_CODEMODE_DEFAULT, "0");
  assert.equal(descriptor.env.PI_REVIEW_GATE_SCHEDULER, "native-scheduler-setting");
  assert.equal(descriptor.env.PI_REVIEW_GATE_DISABLED, "0");
  assert.equal((await readFile(pkg.configPath)).equals(originalConfig), true);
  for (const [filename, bytes] of markers) {
    assert.equal((await readFile(join(pkg.agentDir, filename), "utf8")), bytes);
  }
  assert.equal(await readFile(nativeExtension, "utf8"), "native extension marker\n");
  assert.equal(await readFile(nativeSkill, "utf8"), "native skill marker\n");
  assert.equal(await readFile(nativeSession, "utf8"), "saved conversation marker\n");
  assert.equal(await readFile(sessionMarker, "utf8"), "native session directory marker\n");
  for (const skill of NATIVE_SKILL_PUBLISH_PLAN) {
    assert.equal(existsSync(join(pkg.skillsRoot, skill.name)), false, "native launches do not republish nested profile skills");
  }

  const overridePath = join(pkg.root, "explicit-native-review-gate.json");
  const overrideBytes = Buffer.from(JSON.stringify({ enabled: false, marker: "explicit override" }));
  await writeFile(overridePath, overrideBytes);
  const overridden = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: { ...nativeEnv, PI_REVIEW_GATE_CONFIG: overridePath },
  }));
  assert.equal(overridden.env.PI_REVIEW_GATE_CONFIG, overridePath, "explicit ordinary config overrides are preserved byte-for-byte");
  assert.equal((await readFile(overridePath)).equals(overrideBytes), true);

  // Malformed native JSON remains untouched so the ordinary extension loader
  // can emit its normal recovery warning instead of preparation hiding it.
  const malformed = Buffer.from("{native-invalid");
  await writeFile(pkg.configPath, malformed);
  prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeEnv }));
  assert.equal((await readFile(pkg.configPath)).equals(malformed), true);
});

test("host graphics gate matches native image environment overrides", () => {
  const ghostty = { TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" };
  for (const protocol of [undefined, "kitty", "KITTY", "auto", "AUTO", "", "unknown"]) {
    assert.equal(supportsSessionHostKittyGraphics({ ...ghostty, PI_IMAGE_PROTOCOL: protocol }), true,
      `native auto-detection or Kitty override remains available: ${String(protocol)}`);
  }
  for (const protocol of ["none", "NONE", "0", "iterm2", "ITERM2"]) {
    assert.equal(supportsSessionHostKittyGraphics({ ...ghostty, PI_IMAGE_PROTOCOL: protocol }), false,
      `explicit unsupported or disabled protocol stays off: ${protocol}`);
  }
  assert.equal(supportsSessionHostKittyGraphics({ ...ghostty, TMUX: "/tmp/tmux" }), false);
  assert.equal(supportsSessionHostKittyGraphics({ TERM_PROGRAM: "ghostty", TERM: "xterm-256color" }), false);
});

test("native image default selects direct Ghostty only and preserves explicit disable/multiplexer boundaries", async (t) => {
  const pkg = await makePackageFixture();
  const native = (env: NodeJS.ProcessEnv) => prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: {
      HOME: join(pkg.root, "home"),
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: pkg.agentDir,
      ...env,
    },
  }));
  const ghostty = native({ TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" });
  assert.equal(ghostty.env.PI_IMAGE_PROTOCOL, "kitty", "the hosted child may emit Kitty graphics for direct Ghostty");
  assert.equal(native({ TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty", PI_IMAGE_PROTOCOL: "none" }).env.PI_IMAGE_PROTOCOL, "none",
    "an explicit image-disable choice is passed through unchanged");
  assert.equal(native({ TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty", TMUX: "/tmp/tmux" }).env.PI_IMAGE_PROTOCOL, "none",
    "TERM_PROGRAM inherited inside tmux is not direct Ghostty evidence");
  assert.equal(native({ TERM_PROGRAM: "ghostty", TERM: "screen-256color", STY: "synthetic-screen" }).env.PI_IMAGE_PROTOCOL, "none",
    "screen TERM/STY does not opt into host Kitty output");
  const legacy = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: false,
    env: { PATH: process.env.PATH, TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" },
  }));
  assert.equal(legacy.env.PI_IMAGE_PROTOCOL, "none", "legacy profiles keep their existing no-image default");
});

test("nativeSetup supplies only absent ordinary defaults and resolves the native root from its explicit env", async (t) => {
  const pkg = await makePackageFixture();
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: {
      HOME: join(pkg.root, "home"),
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: pkg.agentDir,
      PI_IMAGE_PROTOCOL: "",
      PI_REVIEW_GATE_CODEMODE_DEFAULT: undefined,
    },
  }));
  assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "", "an explicit empty value is not replaced");
  assert.equal(descriptor.env.PI_REVIEW_GATE_CODEMODE_DEFAULT, "1");
  assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, undefined);
  assert.equal(existsSync(pkg.skillsRoot), false);
});

test("prepareNativeLaunch enforces the bounded config size cap", async (t) => {
  const pkg = await makePackageFixture();
  const big = " ".repeat(MAX_NATIVE_CONFIG_BYTES + 1);
  await writeFile(pkg.configPath, `{ "padding": "${big}" }`, "utf8");
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("size bound") && message.includes(pkg.configPath);
    },
  );
});

test("prepareNativeLaunch publishes shipped skills into the reserved profile locations with parity to the shipped map", async (t) => {
  const pkg = await makePackageFixture();
  prepareNativeLaunch(baseOptions(pkg));

  for (const skill of NATIVE_SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(pkg.packageRoot, ...file.source);
      const destination = join(pkg.skillsRoot, skill.name, ...file.destination);
      assert.equal(
        (await readFile(destination)).equals(await readFile(source)),
        true,
        `shipped bytes must land identical at ${destination}`,
      );
    }
  }
  // Parity with the ONE shared shipped manifest (issue 344). The POSIX wrapper
  // carries no second manifest of its own.
  const { createRequire } = await import("node:module");
  const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-launch.test.ts"));
  const shared = requireCjs("../scripts/prepare-application.cjs") as {
    SKILL_PUBLISH_PLAN: { name: string; files: { source: string[]; destination: string[] }[] }[];
  };
  const shSource = await readFile(resolve(__dirname, "../../scripts/pi-review-gate.sh"), "utf8");
  assert.doesNotMatch(shSource, /SKILL_PUBLISH_PLAN=/, "the POSIX wrapper must not carry its own manifest");
  const shippedPairs = shared.SKILL_PUBLISH_PLAN.flatMap((skill) =>
    skill.files.map((file) => `${file.source.join("/")}\t${skill.name}/${file.destination.join("/")}`),
  );
  const ownPairs = NATIVE_SKILL_PUBLISH_PLAN.flatMap((skill) =>
    skill.files.map((file) => `${file.source.join("/")}\t${skill.name}/${file.destination.join("/")}`),
  );
  assert.deepEqual(ownPairs.sort(), shippedPairs.sort(), "the native skill map must mirror the shared SKILL_PUBLISH_PLAN");
});

test("prepareNativeLaunch leaves byte-identical publications and unrelated files untouched", async (t) => {
  const pkg = await makePackageFixture();
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-execution"), { recursive: true });
  // Identical content is pre-published: must remain untouched (mtime unchanged).
  await cp(
    join(pkg.packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"),
    join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"),
  );
  const before = (await stat(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"))).mtimeMs;
  const sentinel = join(pkg.skillsRoot, "user-own-skill.md");
  await writeFile(sentinel, "user-owned unrelated content\n", "utf8");
  prepareNativeLaunch(baseOptions(pkg));
  const after = (await stat(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"))).mtimeMs;
  assert.equal(before, after, "byte-identical publications must not rewrite the file");
  assert.equal(await readFile(sentinel, "utf8"), "user-owned unrelated content\n", "unrelated skill files are preserved");
  // Stale content is refreshed while an unrelated file keeps its bytes.
  await writeFile(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"), "stale local edit\n", "utf8");
  prepareNativeLaunch(baseOptions(pkg));
  assert.equal(
    await readFile(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"), "utf8"),
    await readFile(join(pkg.packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"), "utf8"),
    "stale skill files are refreshed from shipped content",
  );
  assert.equal(await readFile(sentinel, "utf8"), "user-owned unrelated content\n");
});

test("prepareNativeLaunch rejects a directory skill destination with no partial publication", async (t) => {
  const pkg = await makePackageFixture();
  // A directory occupying a LATER plan destination must reject the whole
  // preparation before publishing ANY file (the orchestrator comes first).
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"), { recursive: true });
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), /not a replaceable regular file/);
  assert.equal(
    existsSync(join(pkg.skillsRoot, "pi-review-gate-orchestrator", "SKILL.md")),
    false,
    "the orchestrator skill must not be published when a later destination is invalid",
  );
});

test("prepareNativeLaunch follows the native symlink policy: leaf links replaced, external targets untouched", async (t) => {
  const pkg = await makePackageFixture();
  const external = join(pkg.root, "external-target.md");
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-execution"), { recursive: true });
  await writeFile(external, "external bytes\n", "utf8");
  await symlink(external, join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"));
  prepareNativeLaunch(baseOptions(pkg));
  const published = await readFile(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"));
  const shipped = await readFile(join(pkg.packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"));
  assert.deepEqual(published, shipped, "the leaf link is replaced by the shipped content");
  assert.equal((await lstat(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"))).isSymbolicLink(), false);
  // The external target never takes the published content and keeps its bytes.
  assert.equal(await readFile(external, "utf8"), "external bytes\n", "an external symlink target is never written through");

  // A symlinked ANCESTOR under the skills root refuses the whole preparation.
  const pkg2 = await makePackageFixture();
  const outside = join(pkg2.root, "outside");
  await mkdir(outside, { recursive: true });
  await mkdir(join(pkg2.skillsRoot, "pi-review-gate-orchestrator"), { recursive: true });
  await symlink(outside, join(pkg2.skillsRoot, "pi-review-gate-orchestrator", "references"));
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg2)),
    /refusing to publish the native skills through a symlinked path component/,
  );
  assert.equal(
    existsSync(join(pkg2.skillsRoot, "pi-review-gate-orchestrator", "SKILL.md")),
    false,
    "no file is published when a path component is a symlink",
  );
});

test("prepareNativeLaunch never rewrites native arguments or tool policy", async (t) => {
  const pkg = await makePackageFixture();
  const hostile = ["--tools", "read,bash;touch /tmp/pwned-launch", "payload|$(pwd);`ls`", "quote'quote"];
  const descriptor = prepareNativeLaunch(baseOptions(pkg, { args: hostile }));
  assert.deepEqual(descriptor.args.slice(4), hostile, "native arguments must be forwarded byte-for-byte in order");
  assert.ok((await readFile(pkg.configPath, "utf8")).startsWith("{"), "the profile config content is never rewritten by preparation");
});

test("prepareNativeLaunch stages the preload require with Node-parser-safe quoting and bounded, control-free values", async (t) => {
  const pkg = await makePackageFixture("pi-native-host-quote");
  // A package tree whose preload path carries spaces and a double quote
  // exercises the two escapes Node's NODE_OPTIONS parser needs.
  const weirdRoot = join(pkg.root, 'pkg with "quotes"');
  await cp(pkg.packageRoot, weirdRoot, { recursive: true });
  const quotedPreload = join(weirdRoot, "dist", "src", "session-host", "bootstrap-preload.js");
  // Same escape rule as the implementation, written out independently here:
  // backslashes doubled, then double quotes backslash-escaped, in one
  // --require="..." clause (no shell is ever involved).
  const escapedForNodeParser = quotedPreload.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    packageRoot: weirdRoot,
    env: { PATH: process.env.PATH, NODE_OPTIONS: "--no-warnings" },
  }));
  assert.equal(descriptor.env.NODE_OPTIONS, `--require="${escapedForNodeParser}" --no-warnings`);
  assert.ok(descriptor.env.NODE_OPTIONS!.includes('\\"'), "an embedded quote must be backslash-escaped for the NODE_OPTIONS parser");
  assert.equal(
    (JSON.parse(descriptor.env[NODE_OPTIONS_RESTORE_ENV]!) as { original: string }).original,
    "--no-warnings",
    "the restored original must be byte-exact",
  );
  // Control-character injection in the inherited value rejects fail-closed,
  // and the diagnostic never echoes the rejected value.
  for (const injected of ["--bad\nvalue", "--bad\rvalue", "--bad\u0000value"]) {
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: injected } })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return message.includes("control characters") && !message.slice(0, message.indexOf("NODE_OPTIONS") + 12).includes(injected.trim());
      },
    );
  }
  // Overlong inherited values reject within the bounded cap without echoing content.
  const oversized = "--x=" + "a".repeat(MAX_NATIVE_NODE_OPTIONS_BYTES + 1);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: oversized } })),
    (error: unknown) => !(error instanceof Error ? error.message : String(error)).includes(oversized),
  );
});

test("resolveNativePi probes a clean env: no inherited bootstrap/restore markers reach the child, user NODE_OPTIONS is preserved", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  // A fake pi Node-entry fixture (execPath shebang) that prints the
  // version (satisfying the probe) and captures the exact child
  // environment values of interest to a side file under the fixture root.
  const fake = join(fixture.bin, "pi");
  // The capture file is created and receipted BEFORE the child spawns, and the child
  // writes into that existing path: a child that writes and then fails the probe leaves a
  // settled, owned fixture instead of an unexplained entry teardown must refuse over.
  const capture = join(fixture.root, "env");
  await writeFile(capture, "", { flag: "wx" });
  await writeFile(fake, [
    `#!${process.execPath}`,
    `process.stdout.write(${JSON.stringify("pi 1.0.4\n")});`,
    'require("node:fs").writeFileSync(',
    '  process.env.CAPTURE_FILE,',
    '  "bootstrap=<" + (process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? "") + ">" +',
    '    "restore=<" + (process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? "") + ">" +',
    '    "nodeopts=<" + (process.env.NODE_OPTIONS ?? "") + ">",',
    ');',
  ].join("\u000a"), "utf8");
  await chmod(fake, 0o755);
  resolveNativePi({
    executable: "pi",
    env: {
      PATH: `${fixture.bin}:${process.env.PATH}`,
      CAPTURE_FILE: capture,
      PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "inherited-token",
      PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: '{"original":"stale"}',
      NODE_OPTIONS: "--no-warnings",
    },
  });
  const dump = (await readFile(capture, "utf8")).trim();
  assert.equal(dump, "bootstrap=<>restore=<>nodeopts=<--no-warnings>");
});

test("a capture written by a pi child whose version resolution fails still settles for teardown", async (t) => {
  const fixture = await makePiFixture("1.0.4", "pi-native-host-capture-fail");
  const capture = join(fixture.root, "env");
  await writeFile(capture, "", { flag: "wx" });
  const fake = join(fixture.bin, "pi");
  // The child writes its capture and then answers the version probe with garbage.
  await writeFile(fake, [
    `#!${process.execPath}`,
    `require("node:fs").writeFileSync(${JSON.stringify(capture)}, "wrote-before-failing");`,
    'process.stdout.write("not-a-version-at-all");',
  ].join("\n"), "utf8");
  await chmod(fake, 0o755);
  assert.throws(
    () => resolveNativePi({
      executable: "pi",
      env: { PATH: `${fixture.bin}:${process.env.PATH}`, CAPTURE_FILE: capture },
    }),
    /not an exact official version format/,
    "the original resolution error is reported, not a teardown complaint about the capture",
  );
  assert.equal(await readFile(capture, "utf8"), "wrote-before-failing",
    "the child wrote into the capture that was receipted before the spawn");
  // The settled fixture finalizes through its real lease in both teardown modes.
  const lease = fixtureLeases.pop()!;
  const preserve = fixturePreservationRequested();
  cleanupFixtureLease(lease, preserve, t);
  if (preserve) {
    assert.equal(existsSync(fixture.root), true, "explicit preservation retains the settled fixture");
    cleanupFixtureLease(lease, false, t);
  }
  assert.equal(existsSync(fixture.root), false,
    "teardown removes the fixture including the child's capture write");
});

test("resolveNativePi does not expose rejected spawn environment values", async (t) => {
  const fixture = await makePiFixture("1.0.4", "pi-native-host-env-error");
  const executionMarker = join(fixture.root, "pi-entry-executed");
  const secretMarker = "sk-spawn-env-private-marker";
  const fake = join(fixture.bin, "pi");
  await writeFile(fake, [
    `#!${process.execPath}`,
    `require("node:fs").writeFileSync(${JSON.stringify(executionMarker)}, "executed");`,
    `process.stdout.write(${JSON.stringify("pi 1.0.4\n")});`,
  ].join("\n"), "utf8");
  await chmod(fake, 0o755);

  assert.throws(
    () => resolveNativePi({
      executable: "pi",
      env: {
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: `${secretMarker}\u0000`,
      },
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("version probe") && !message.includes(secretMarker);
    },
    "spawn validation errors are generic and never echo environment contents",
  );
  assert.equal(existsSync(executionMarker), false, "the fixture is not executed with an invalid environment");
});

test("the alpha rejects native/SEA pi binaries fail-closed in resolution and preparation", async (t) => {
  const pkg = await makePackageFixture();
  const elf = join(pkg.root, "bin", "native-pi");
  await writeFile(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])); // ELF
  await chmod(elf, 0o755);
  assert.throws(
    () => resolveNativePi({ executable: elf, env: { PATH: "/nonexistent" } }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("native/SEA binary") && !message.includes("\u007f");
    },
  );
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { piExecutable: elf })), /native\/SEA binary/);
});

test("resolveNativePi ignores-SIGTERM wrappers fail within the bounded probe window (SIGKILL terminate)", async () => {
  // The owned Node process ignores SIGTERM itself; the probe's non-ignorable
  // SIGKILL must end that exact process within the bounded window.
  const bin = await makeFixtureRoot(`pi-native-host-sigterm-${process.pid}-${Date.now()}`, "native-host SIGTERM probe");
  const fake = join(bin, "pi");
  // No descendant is spawned; nothing lingers after the direct process is
  // SIGKILLed. No cleanup claim is made for arbitrary custom wrappers.
  writeFileSync(fake, `#!${process.execPath}\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 60000);\n`, "utf8");
  chmodSync(fake, 0o755);
  const started = Date.now();
  assert.throws(
    () => resolveNativePi({ executable: fake, env: { PATH: `/nonexistent:${process.env.PATH}` } }),
    /did not answer within/,
    "an unresponsive pi executable must fail with the bounded diagnostic",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20_000, `probe must return promptly (SIGKILL), not hang past the wrapper: ${elapsed}ms`);
});

test("resolveNativePi resolves explicit executable paths under directories with spaces, quotes, and parentheses", async () => {
  const base = await makeFixtureRoot(`pi-native-host-spq-${process.pid}-${Date.now()}`, "native-host spaced-path fixture");
  const dir = join(base, "pi tool dir (alpha) with 'quotes' & spaces");
  await mkdir(dir, { recursive: true });
  const fake = join(dir, "pi");
  writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4\\n');\n`, "utf8");
  chmodSync(fake, 0o755);
  const resolved = resolveNativePi({ executable: fake, env: { PATH: "/nonexistent" } });
  assert.equal(resolved.file, fake, "the exact path is canonicalized as a whole filename");
  assert.equal(resolved.version, "1.0.4");
  // A relative explicit path also resolves (without shell interpretation).
  const previousCwd = process.cwd();
  process.chdir(base);
  try {
    const relative = resolveNativePi({ executable: join("pi tool dir (alpha) with 'quotes' & spaces", "pi"), env: { PATH: "/nonexistent" } });
    assert.equal(relative.file, fake);
  } finally {
    process.chdir(previousCwd);
  }
  // A shell command string with a slash in it is still never executed: it
  // falls to path validation and fails as a nonpath.
  assert.throws(
    () => resolveNativePi({ executable: "pi --version; touch /tmp/pwned", env: { PATH: `/nonexistent:${process.env.PATH}` } }),
    /not an executable regular file/,
  );
  // Bare-command strings remain rejected.
  assert.throws(
    () => resolveNativePi({ executable: "pi touch", env: { PATH: `/nonexistent:${process.env.PATH}` } }),
    /command string/,
  );
});

test("prepareNativeLaunch rejects an oversized shipped skill source before any publication", async (t) => {
  const pkg = await makePackageFixture();
  // Pad the LAST plan source so failure cannot be a partial-publication accident.
  await writeFile(
    join(pkg.packageRoot, "skills", "pi-review-gate-research", "SKILL.md"),
    "x".repeat(1024 * 1024 * 2 + 1),
    "utf8",
  );
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    /publication size bound/,
  );
  assert.equal(existsSync(pkg.skillsRoot), false, "nothing is published when a shipped source is oversized");
});

test("prepareNativeLaunch publication reads are bounded and never block on special files", async (t) => {
  const pkg = await makePackageFixture();
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-execution"), { recursive: true });
  // A FIFO occupying a destination leaf rejects the whole preparation before
  // any publication (a read through it could otherwise block forever).
  const fifo = join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md");
  execFileSync("mkfifo", [fifo]);
  trackFixtureCreatedPath(fifo);
  const started = Date.now();
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    /not a replaceable regular file/,
  );
  assert.ok(Date.now() - started < 10_000, "the FIFO destination must be rejected without blocking");
  assert.equal(
    existsSync(join(pkg.skillsRoot, "pi-review-gate-orchestrator", "SKILL.md")),
    false,
    "no partial publication when a special-file destination is present",
  );

  // A symlink leaf pointing AT a FIFO is never read through: the leaf link is
  // replaced itself by the atomic rename and the FIFO target stays untouched.
  const fifoTarget = join(pkg.root, "target-fifo");
  execFileSync("mkfifo", [fifoTarget]);
  trackFixtureCreatedPath(fifoTarget);
  const execDir = join(pkg.skillsRoot, "pi-review-gate-execution");
  await mkdir(execDir, { recursive: true });
  rmSync(join(execDir, "SKILL.md")); // remove the FIFO occupying the leaf
  await symlink(fifoTarget, join(execDir, "SKILL.md"));
  prepareNativeLaunch(baseOptions(pkg));
  assert.equal((await lstat(join(execDir, "SKILL.md"))).isSymbolicLink(), false, "the symlink leaf is replaced");
  assert.equal((await stat(fifoTarget)).isFIFO(), true, "the FIFO target is untouched (never read through)");
  assert.equal(
    (await readFile(join(execDir, "SKILL.md"))).equals(await readFile(join(pkg.packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"))),
    true,
    "the leaf is republished from the shipped bytes",
  );
});

test("prepareNativeLaunch publishes (never hangs on) an over-cap stale destination without reading it whole", async (t) => {
  const pkg = await makePackageFixture();
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-research"), { recursive: true });
  // A stale destination larger than the bound: parity cannot be established
  // without an unbounded read, so it is simply republished whole.
  await writeFile(
    join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"),
    "y".repeat(1024 * 1024 * 2 + 1),
    "utf8",
  );
  prepareNativeLaunch(baseOptions(pkg));
  assert.equal(
    await readFile(join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"), "utf8"),
    await readFile(join(pkg.packageRoot, "skills", "pi-review-gate-research", "SKILL.md"), "utf8"),
    "the over-cap stale destination is refreshed from shipped content",
  );
});

test("prepareNativeLaunch republishes a symlink leaf whose target is byte-identical to the shipped content", async (t) => {
  const pkg = await makePackageFixture();
  // The target holds exactly the shipped bytes: parity must NOT be claimed
  // through the link (targets are never read); the link itself is replaced.
  const target = join(pkg.root, "identical-target.md");
  await cp(
    join(pkg.packageRoot, "skills", "pi-review-gate-research", "SKILL.md"),
    target,
  );
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-research"), { recursive: true });
  await symlink(target, join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"));
  prepareNativeLaunch(baseOptions(pkg));
  assert.equal((await lstat(join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"))).isSymbolicLink(), false, "the leaf link is replaced, not preserved via target parity");
  assert.equal(await readFile(target, "utf8"), "research skill\n", "the byte-identical target is untouched");
});

test("prepareNativeLaunch validates caller paths even though the caller passes pre-validated values", async (t) => {
  const pkg = await makePackageFixture();
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { workspace: join(pkg.root, "missing-workspace") })), /workspace is not a directory/);
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { agentDir: join(pkg.root, "missing-agent-dir") })), /selected registry owns its setup/);
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { piExecutable: join(pkg.root, "missing-bin", "pi") })), /executable regular file/);
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { packageRoot: join(pkg.root, "missing-package-root") })), /package root/);
});

test("publication genuinely uses the shipped launcher helper's production rename implementation", () => {
  // The shipped helper exports the same atomic-rename implementation the
  // publication path loads at runtime (resolved from the repository root,
  // like the other launcher tests).
  const helperPath = resolve("scripts/pi-review-gate-launcher.cjs");
  const helper = require(helperPath) as { renameIntoPlaceWithContentionRetry: unknown };
  assert.equal(typeof helper.renameIntoPlaceWithContentionRetry, "function");
});

test("a later skill publication rename failure still receipts earlier outputs for teardown", async () => {
  const pkg = await makePackageFixture("pi-native-host-late-failure");
  const helper = launcherHelperModule();
  const original = helper.renameIntoPlaceWithContentionRetry;
  let calls = 0;
  helper.renameIntoPlaceWithContentionRetry = (rename, options) => {
    calls += 1;
    if (calls === 2) return { published: false, attempts: 1, lastError: { code: "EIO", message: "injected" } };
    return original(rename, options);
  };
  try {
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg)),
      /unexpected failure publishing the native skill file/,
    );
  } finally {
    helper.renameIntoPlaceWithContentionRetry = original;
  }
  const first = NATIVE_SKILL_PUBLISH_PLAN[0]!.files[0]!;
  const earlierOutput = join(pkg.skillsRoot, NATIVE_SKILL_PUBLISH_PLAN[0]!.name, ...first.destination);
  assert.equal((await lstat(earlierOutput)).isFile(), true,
    "the earlier published output remains present until the lease finalizer removes it");
});

for (const reached of [false, true]) test(`publication retains an unowned leaf at a ${reached ? "reached" : "later"} destination`, async (t) => {
  const pkg = await makePackageFixture("pi-native-host-unreached");
  // A planned destination the publisher either never reaches, or reaches while an
  // unowned leaf already sits there: neither case may be overwritten or adopted.
  let injectedPath = join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md");
  const helper = launcherHelperModule();
  const original = helper.renameIntoPlaceWithContentionRetry;
  let calls = 0;
  // The identity of the injected file, recorded by the injector at its creation: the probe's
  // rollback uses this receipt instead of adopting whatever the tree happens to contain.
  let injectedReceipt: import("node:fs").BigIntStats | undefined;
  helper.renameIntoPlaceWithContentionRetry = (rename, options) => {
    calls += 1;
    if (calls === 2) {
      if (reached) {
        assert.ok(options?.destination);
        injectedPath = options.destination;
      }
      // Raw exclusive create on purpose: this regular file is unknown to the ownership receipts.
      const fd = fsOpenSync(injectedPath, "wx");
      try {
        injectedReceipt = fstatSync(fd, { bigint: true });
        fsWriteFileSync(fd, "not receipted\n", "utf8");
      } finally { fsCloseSync(fd); }
      if (!reached) return { published: false, attempts: 1, lastError: { code: "EIO", message: "injected" } };
    }
    return original(rename, options);
  };
  let detached: FixtureLease | undefined;
  let rolledBack = false;
  const rollback = () => {
    if (detached === undefined || rolledBack) return;
    if (injectedReceipt !== undefined) detached.ownership.track(injectedPath, injectedReceipt);
    cleanupFixtureLease(detached, false, t);
    rolledBack = true;
  };
  t.after(rollback);
  try {
    assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), reached
      ? /unexpected failure publishing the native skill file.*publication destination is not owned/
      : /unexpected failure publishing the native skill file/);
  } finally {
    helper.renameIntoPlaceWithContentionRetry = original;
  }
  // Detach only now: the wrapper only receipts what it publishes while its lease is registered.
  const lease = fixtureLeases.pop()!;
  detached = lease;
  assert.equal(await readFile(injectedPath, "utf8"), "not receipted\n", "publication did not replace the injected bytes");
  const diagnostics: string[] = [];
  assert.throws(
    () => cleanupFixtureLease(lease, fixturePreservationRequested(), { diagnostic: (message) => diagnostics.push(message) }),
    /fixture ownership verification failed/,
    "default and preserve teardown both refuse instead of adopting the unknown file",
  );
  assert.equal(await readFile(injectedPath, "utf8"), "not receipted\n", "teardown retained the injected bytes");
  assert.equal(existsSync(pkg.root), true, "the fixture is retained on the ownership refusal");
  assert.ok(diagnostics.some((line) => line.includes(pkg.root)), "the retained location is reported");
  rollback();
  assert.equal(existsSync(pkg.root), false, "rollback with the injector's creation receipt removes the probe fixture");
});

test("a displaced skill directory stops the staging create before any entry is written", async (t) => {
  // The interloper's target is a fixture lease of its own, allocated BEFORE the package
  // lease so the probe's pop() still detaches the package lease. Normal teardown verifies
  // and reports the target in both teardown modes; this test never deletes it recursively.
  const outside = await makeFixtureRoot("pi-native-host-displaced-outside", "native-host displaced target fixture");
  const pkg = await makePackageFixture("pi-native-host-displaced-dir");
  const fsModule = require("node:fs") as typeof import("node:fs");
  // Captured before the seam installs, so the injector's own raw mutations bypass it.
  const realRmdir = fsModule.rmdirSync;
  const realSymlink = fsModule.symlinkSync;
  const helper = launcherHelperModule();
  const original = helper.renameIntoPlaceWithContentionRetry;
  // The LAST planned directory: its files are staged after the first rename completes.
  const lastSkill = NATIVE_SKILL_PUBLISH_PLAN[NATIVE_SKILL_PUBLISH_PLAN.length - 1]!;
  const lastFile = lastSkill.files[lastSkill.files.length - 1]!;
  const displaced = join(pkg.skillsRoot, lastSkill.name, ...lastFile.destination.slice(0, -1));
  let calls = 0;
  let replacementReceipt: import("node:fs").BigIntStats | undefined;
  let detached: FixtureLease | undefined;
  let rolledBack = false;
  const rollback = () => {
    if (detached === undefined || rolledBack || replacementReceipt === undefined) return;
    detached.ownership.track(displaced, replacementReceipt); // only the interloper this injector created
    cleanupFixtureLease(detached, false, t);
    rolledBack = true;
  };
  t.after(rollback);
  try {
    // Installed only after every allocation succeeded, and restored in this same finally, so
    // a failed setup can never leave the shared rename hook in place for later tests.
    helper.renameIntoPlaceWithContentionRetry = (rename, options) => {
      calls += 1;
      const outcome = original(rename, options);
      if (calls === 1 && outcome.published) {
        // Displace a later skill directory with a link to the outside lease before its
        // bytes are staged. Identity comparison alone cannot catch this: the replacement is
        // a different kind of entry at a path the lease still believes is a directory.
        const current = lstatSync(displaced, { bigint: true });
        const owner = fixtureLeases[fixtureLeases.length - 1]!.ownership;
        assert.ok(current.isDirectory() && owner.matches(displaced, current),
          `displaced directory is not the receipted entry: ${displaced}`);
        realRmdir(displaced); // its file is published last, so this directory is still empty
        realSymlink(outside, displaced);
        replacementReceipt = lstatSync(displaced, { bigint: true });
      }
      return outcome;
    };
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg)),
      /could not stage the native skill file[\s\S]*publication parent is not an owned directory/,
      "the staging create refuses over the displaced parent instead of writing beneath it",
    );
  } finally {
    helper.renameIntoPlaceWithContentionRetry = original;
  }
  const lease = fixtureLeases.pop()!;
  detached = lease;
  assert.deepEqual(readdirSync(outside), [], "no staging entry was created through the displaced parent");
  const diagnostics: string[] = [];
  assert.throws(
    () => cleanupFixtureLease(lease, fixturePreservationRequested(), { diagnostic: (message) => diagnostics.push(message) }),
    /fixture ownership verification failed/,
    "default and preserve teardown both refuse instead of adopting the interloper",
  );
  assert.equal(lstatSync(displaced).isSymbolicLink(), true, "the interloper is retained as unknown evidence");
  assert.ok(diagnostics.some((line) => line.includes(pkg.root)), "the retained location is reported");
  rollback();
  assert.equal(existsSync(pkg.root), false, "rollback with the injector's own receipt removes the probe fixture");
  assert.equal(existsSync(outside), true, "rollback removed the link, not the outside lease root");
});

test("a publication failure whose staging cleanup also fails still leaves the staged bytes owned", async (t) => {
  const pkg = await makePackageFixture("pi-native-host-staging");
  const fsModule = require("node:fs") as typeof import("node:fs");
  const helper = launcherHelperModule();
  const originalRename = helper.renameIntoPlaceWithContentionRetry;
  const originalUnlink = fsModule.unlinkSync;
  // Publication fails at the rename itself, and the publisher's best-effort staging unlink
  // fails too, so the staged bytes survive inside the fixture.
  helper.renameIntoPlaceWithContentionRetry = (_rename, options) => ({ published: false, attempts: 1, lastError: { code: "EIO", message: "injected publication failure" } });
  fsModule.unlinkSync = ((path: Parameters<typeof originalUnlink>[0]) => {
    if (typeof path === "string" && basename(path).startsWith(".skill-publish.")) throw new Error("injected staging unlink failure");
    return originalUnlink(path);
  }) as unknown as typeof originalUnlink;
  let detached: FixtureLease | undefined;
  let rolledBack = false;
  const rollback = () => {
    if (detached === undefined || rolledBack) return;
    cleanupFixtureLease(detached, false, t);
    rolledBack = true;
  };
  t.after(rollback);
  try {
    assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), /unexpected failure publishing the native skill file/);
  } finally {
    helper.renameIntoPlaceWithContentionRetry = originalRename;
    fsModule.unlinkSync = originalUnlink;
  }
  const staged: string[] = [];
  const scan = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const entry = join(directory, name);
      if (name.startsWith(".skill-publish.")) staged.push(entry);
      else if (lstatSync(entry, { throwIfNoEntry: false })?.isDirectory()) scan(entry);
    }
  };
  scan(pkg.skillsRoot);
  assert.equal(staged.length, 1, "the failed publication left exactly one staging file behind");
  const staging = staged[0]!;
  const lease = fixtureLeases.pop()!;
  detached = lease;
  assert.ok(lease.ownership.has(staging), "the staged file is owned from its exclusive open, not from a later tree scan");
  const diagnostics: string[] = [];
  cleanupFixtureLease(lease, fixturePreservationRequested(), { diagnostic: (message) => diagnostics.push(message) });
  if (fixturePreservationRequested()) {
    assert.equal(existsSync(staging), true, "explicit preservation retains the staged bytes");
    assert.ok(diagnostics.some((line) => line.includes(pkg.root) && line.includes("PI_TEST_SCRATCH_PRESERVE=1")),
      "the exact retained staging location is reported");
    rollback();
    assert.equal(existsSync(pkg.root), false, "the test-owned preserved root is removed after the assertion");
  } else {
    rolledBack = true; // the call above already removed the fixture; the after hook must not repeat it
    assert.equal(existsSync(pkg.root), false, "default teardown removes the fixture including its surviving staging file");
  }
});

test("a staging receipt comes only from an exclusive create, and a refused receipt closes the descriptor it opened", async (t) => {
  // A nonexclusive open of a staging-named path confers nothing, inside a planned staging
  // directory or anywhere else.
  const plannedDir = join("/fixture/agent", "skills", NATIVE_SKILL_PUBLISH_PLAN[0]!.name);
  const stagingDirs = new Set([plannedDir]);
  const stagingPath = join(plannedDir, ".skill-publish.abc123");
  assert.equal(isExclusiveStagingCreate(stagingPath, "wx", stagingDirs), true);
  assert.equal(isExclusiveStagingCreate(stagingPath, fsFlags.O_WRONLY | fsFlags.O_CREAT | fsFlags.O_EXCL, stagingDirs), true);
  assert.equal(isExclusiveStagingCreate(stagingPath, "r", stagingDirs), false, "a plain read adopts nothing");
  assert.equal(isExclusiveStagingCreate(stagingPath, "a+", stagingDirs), false, "an append adopts nothing");
  assert.equal(isExclusiveStagingCreate(stagingPath, fsFlags.O_RDONLY | fsFlags.O_NONBLOCK, stagingDirs), false,
    "the bounded destination read adopts nothing");
  assert.equal(isExclusiveStagingCreate(join(plannedDir, "SKILL.md"), "wx", stagingDirs), false,
    "a published destination is not staging");
  assert.equal(isExclusiveStagingCreate(join("/elsewhere", ".skill-publish.abc123"), "wx", stagingDirs), false,
    "a staging name outside the planned directories is not this publication's staging");

  // And in the seam itself: a receipt that cannot be taken must not leak the descriptor.
  const pkg = await makePackageFixture("pi-native-host-staging-receipt");
  const fsModule = require("node:fs") as typeof import("node:fs");
  const originalOpen = fsModule.openSync;
  const originalFstat = fsModule.fstatSync;
  let stagingOpened = false;
  let openedFd: number | undefined;
  let created: { path: string; receipt: import("node:fs").BigIntStats } | undefined;
  fsModule.openSync = ((path: Parameters<typeof originalOpen>[0], flags: Parameters<typeof originalOpen>[1], mode?: number) => {
    const fd = originalOpen(path, flags, mode);
    if (typeof path === "string" && flags === "wx" && basename(path).startsWith(".skill-publish.")) {
      // The injector keeps the identity of the entry its own open created; the fixture
      // never sees this receipt.
      try { created = { path, receipt: originalFstat(fd, { bigint: true }) }; }
      catch (error) { fsCloseSync(fd); throw error; }
      stagingOpened = true;
    }
    return fd;
  }) as unknown as typeof originalOpen;
  fsModule.fstatSync = ((fd: Parameters<typeof originalFstat>[0], options?: Parameters<typeof originalFstat>[1]) => {
    if (stagingOpened) {
      stagingOpened = false;
      openedFd = Number(fd);
      throw new Error("injected staging receipt failure");
    }
    return originalFstat(fd, options);
  }) as unknown as typeof originalFstat;
  let detached: FixtureLease | undefined;
  let rolledBack = false;
  const rollback = () => {
    if (detached === undefined || rolledBack || created === undefined) return;
    detached.ownership.track(created.path, created.receipt);
    cleanupFixtureLease(detached, false, t);
    rolledBack = true;
  };
  t.after(rollback);
  try {
    assert.throws(() => prepareNativeLaunch(baseOptions(pkg)),
      /could not stage the native skill file.*injected staging receipt failure/);
  } finally {
    fsModule.openSync = originalOpen;
    fsModule.fstatSync = originalFstat;
  }
  assert.notEqual(openedFd, undefined, "the staging open succeeded before the receipt failed");
  assert.throws(() => originalFstat(openedFd!), (error: unknown) => (error as NodeJS.ErrnoException).code === "EBADF",
    "the descriptor the publisher never received is closed, not leaked");
  assert.ok(created !== undefined && existsSync(created.path), "the exclusive create left its staging entry behind");
  const lease = fixtureLeases.pop()!;
  detached = lease;
  assert.equal(lease.ownership.has(created.path), false,
    "a create whose receipt failed confers no ownership");
  const diagnostics: string[] = [];
  assert.throws(
    () => cleanupFixtureLease(lease, false, { diagnostic: (message) => diagnostics.push(message) }),
    /fixture ownership verification failed/,
    "the refusal stays unresolved: teardown refuses over the unowned staging bytes",
  );
  assert.equal(existsSync(pkg.root), true, "the fixture is retained on the ownership refusal");
  assert.ok(diagnostics.some((line) => line.includes(pkg.root)), "the retained location is reported");
  rollback();
  assert.equal(existsSync(pkg.root), false, "rollback with the probe's own receipt removes the fixture");
});

for (const failChmod of [false, true]) test(`a staging replacement is retained when chmod ${failChmod ? "fails" : "succeeds"}`, async (t) => {
  const pkg = await makePackageFixture("pi-native-host-staging-replaced");
  const fsModule = require("node:fs") as typeof import("node:fs");
  const originalOpen = fsModule.openSync;
  const originalFstat = fsModule.fstatSync;
  const originalChmod = fsModule.chmodSync;
  const originalUnlink = fsModule.unlinkSync;
  let stagingPath: string | undefined;
  let replaced = false;
  let replacementReceipt: import("node:fs").BigIntStats | undefined;
  fsModule.openSync = ((path: Parameters<typeof originalOpen>[0], flags: Parameters<typeof originalOpen>[1], mode?: number) => {
    if (typeof path === "string" && basename(path).startsWith(".skill-publish.")) stagingPath = path;
    return originalOpen(path, flags, mode);
  }) as unknown as typeof originalOpen;
  fsModule.chmodSync = ((path: Parameters<typeof originalChmod>[0], mode: Parameters<typeof originalChmod>[1]) => {
    // Between the exclusive open and the publication rename (or the publisher's
    // failure-path unlink), an unknown writer replaces the staging pathname.
    if (!replaced && typeof path === "string" && path === stagingPath) {
      replaced = true;
      originalUnlink(path);
      // The injector receipts its own exclusive create through the UNPATCHED open, so the
      // publication seam never sees it and the fixture never owns the replacement.
      const fd = originalOpen(path, "wx");
      try {
        replacementReceipt = originalFstat(fd, { bigint: true });
        fsWriteFileSync(fd, "not the staged bytes\n", "utf8");
      } finally { fsCloseSync(fd); }
      if (failChmod) throw new Error("injected chmod failure after staging replacement");
    }
    return originalChmod(path, mode);
  }) as unknown as typeof originalChmod;
  let detached: FixtureLease | undefined;
  let rolledBack = false;
  const rollback = () => {
    if (detached === undefined || rolledBack || stagingPath === undefined || replacementReceipt === undefined) return;
    detached.ownership.track(stagingPath, replacementReceipt); // only the entry this injector created
    cleanupFixtureLease(detached, false, t);
    rolledBack = true;
  };
  t.after(rollback);
  try {
    assert.throws(() => prepareNativeLaunch(baseOptions(pkg)),
      failChmod
        ? /could not write the staged native skill file.*injected chmod failure/
        : /publication staging entry changed after its exclusive open/,
      failChmod
        ? "the original staging failure is preserved while the replacement is refused"
        : "the ownership refusal is raised outside the publisher's rename-retry path");
  } finally {
    fsModule.openSync = originalOpen;
    fsModule.chmodSync = originalChmod;
  }
  assert.notEqual(stagingPath, undefined, "the publisher staged exclusively before the refusal");
  assert.equal(existsSync(stagingPath!), true, "the replacement is never unlinked by the publisher");
  assert.equal((await readFile(stagingPath!, "utf8")), "not the staged bytes\n",
    "the replacement bytes survive untouched");
  const lease = fixtureLeases.pop()!;
  detached = lease;
  assert.equal(lease.ownership.matches(stagingPath!, lstatSync(stagingPath!, { bigint: true })), false,
    "the replacement is not the exclusively created inode the receipt carries");
  const diagnostics: string[] = [];
  assert.throws(
    () => cleanupFixtureLease(lease, fixturePreservationRequested(), { diagnostic: (message) => diagnostics.push(message) }),
    /fixture ownership verification failed/,
    "default and preserve teardown both refuse instead of adopting the replacement",
  );
  assert.equal(existsSync(stagingPath!), true, "the replacement is retained as unknown evidence");
  assert.ok(diagnostics.some((line) => line.includes(pkg.root)), "the retained location is reported");
  rollback();
  assert.equal(existsSync(pkg.root), false, "rollback with the replacement's own receipt removes the probe fixture");
});

// The COLLECTED witness is written only when the nested child actually reached a terminal
// state (an exit status or a delivered signal) — a spawnSync call that merely returned is
// not settlement. The success marker is written only afterwards, so a nonzero nested exit
// fails the smoke assertion without pretending the fixture still holds a live process.
const PRELOAD_SMOKE_COLLECTED = "user-child-collected";
const PRELOAD_SMOKE_SUCCEEDED = "user-child-succeeded";
const NESTED_CHILD_SUCCEEDS = 'require("node:fs").appendFileSync(process.env.MARKS, "user-child\\n");';
const NESTED_CHILD_NONZERO = `${NESTED_CHILD_SUCCEEDS} process.exit(3);`;

interface PreloadSmokeRun {
  result: ReturnType<typeof spawnSync>;
  sequence: string[] | undefined;
  marksError: unknown;
  descriptor: ReturnType<typeof rawPrepareNativeLaunch>;
  userRequireFixture: string;
}

/**
 * One preload-order smoke run: the generated preload and user --require both mark themselves,
 * the user --require spawns a bounded nested child, and the preload records collection of
 * that child before asserting on its status. Settlement is recorded from the witness and the
 * observed process exit, never from the smoke run's success.
 */
async function runPreloadOrderSmoke(
  pkg: PackageFixture,
  nestedChild: string,
  omitCollectionWitness = false,
): Promise<PreloadSmokeRun> {
  // A marker-writing preload placeholder (tests own the fake package root;
  // the reporter sibling owns the real preload's early-env behavior).
  const preloadPath = join(pkg.packageRoot, "dist", "src", "session-host", "bootstrap-preload.js");
  await writeFile(preloadPath, 'require("node:fs").appendFileSync(process.env.MARKS, "preload\\n");\n', "utf8");
  // An original user --require that marks itself and spawns a descendant which also marks
  // itself (the class of startup that must never preempt the preload's auth scrub).
  const userRequireFixture = join(pkg.root, "user-require.cjs");
  await writeFile(
    userRequireFixture,
    [
      'require("node:fs").appendFileSync(process.env.MARKS, "user\\n");',
      "const child = require(\"node:child_process\").spawnSync(",
      "  process.execPath,",
      `  ["-e", ${JSON.stringify(nestedChild)}],`,
      '  { env: { ...process.env, NODE_OPTIONS: undefined }, stdio: "ignore", timeout: 10_000, killSignal: "SIGKILL" },',
      ");",
      // A returned spawnSync call is not settlement: the witness lands only once the child
      // reached a terminal state, and can be withheld entirely by the missing-witness probe.
      "if (child.status !== null || child.signal !== null) {",
      ...(omitCollectionWitness
        ? []
        : [`  require("node:fs").appendFileSync(process.env.MARKS, ${JSON.stringify(`${PRELOAD_SMOKE_COLLECTED}\n`)});`]),
      "}",
      "if (child.error || child.signal || child.status !== 0) throw child.error || new Error(`nested smoke child: ${child.signal ?? child.status}`);",
      `require("node:fs").appendFileSync(process.env.MARKS, ${JSON.stringify(`${PRELOAD_SMOKE_SUCCEEDED}\n`)});`,
      "",
    ].join("\n"),
    "utf8",
  );
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    env: { PATH: process.env.PATH, NODE_OPTIONS: `--require=${userRequireFixture}` },
  }));
  // String-level: the clause is the first entry of the descriptor.
  assert.equal(
    descriptor.env.NODE_OPTIONS!.indexOf("--require") === 0,
    true,
    "the preload require clause must be the first NODE_OPTIONS entry",
  );
  // Production parser: run real node with the exact descriptor value and assert the actual
  // execution order via markers.
  const marks = join(pkg.root, "marks");
  await writeFile(marks, "", "utf8");
  const result = spawnSync(
    process.execPath,
    ["-e", `require("node:fs").appendFileSync(process.env.MARKS, "main\\n");`],
    {
      env: { NODE_OPTIONS: descriptor.env.NODE_OPTIONS!, MARKS: marks, PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  );
  // The witness is inspected BEFORE the outer exit status is asserted: the smoke run's
  // success and the fixture's process settlement are different claims.
  let sequence: string[] | undefined;
  let marksError: unknown;
  try {
    sequence = (await readFile(marks, "utf8")).trim().split("\n");
  } catch (error) {
    marksError = error;
  }
  const settled = (result.status !== null || result.signal !== null)
    && sequence?.includes(PRELOAD_SMOKE_COLLECTED) === true;
  if (!settled) {
    markFixtureUnsettled(pkg.root,
      `preload-order smoke settlement unconfirmed (status=${String(result.status)}, signal=${String(result.signal)}, `
      + `error=${result.error === undefined ? "none" : result.error.message}, `
      + `collected=${sequence === undefined ? "unreadable" : String(sequence.includes(PRELOAD_SMOKE_COLLECTED))})`);
  }
  if (marksError !== undefined) throw marksError;
  return { result, sequence, marksError, descriptor, userRequireFixture };
}

test("production descriptor NODE_OPTIONS parses with the preload require FIRST, before an original --require that spawns a child", async () => {
  const pkg = await makePackageFixture("pi-native-host-order");
  const { result, sequence, descriptor, userRequireFixture } = await runPreloadOrderSmoke(pkg, NESTED_CHILD_SUCCEEDS);
  assert.equal(result.status, 0, `node must parse the descriptor NODE_OPTIONS successfully (${result.stderr ?? ""})`);
  assert.deepEqual(
    sequence,
    ["preload", "user", "user-child", PRELOAD_SMOKE_COLLECTED, PRELOAD_SMOKE_SUCCEEDED, "main"],
    "the preload always runs before any user --require startup, and before any descendant it spawns",
  );
  // The restoration sidecar still preserves the user's ORIGINAL value exactly.
  assert.equal(
    (JSON.parse(descriptor.env[NODE_OPTIONS_RESTORE_ENV]!) as { original: string }).original,
    `--require=${userRequireFixture}`,
  );
});

test("a nested smoke child that exits nonzero still settles its process so default teardown removes the fixture", async (t) => {
  const pkg = await makePackageFixture("pi-native-host-order-nonzero");
  const { result, sequence } = await runPreloadOrderSmoke(pkg, NESTED_CHILD_NONZERO);
  // The smoke assertion still fails: a nonzero nested child is never accepted.
  assert.notEqual(result.status, 0, "the smoke run fails when the nested child exits nonzero");
  assert.ok(sequence?.includes(PRELOAD_SMOKE_COLLECTED) === true,
    "the preload recorded collection of the nested child before asserting on it");
  assert.equal(sequence?.includes(PRELOAD_SMOKE_SUCCEEDED), false,
    "the success marker is never written for a failed nested child");
  // Collection is confirmed, so the owned processes have exited and default teardown must
  // remove the fixture instead of retaining it as unsettled evidence.
  const lease = fixtureLeases.pop()!;
  t.after(() => {
    if (lstatSync(pkg.root, { bigint: true, throwIfNoEntry: false }) === undefined) return;
    try {
      cleanupFixtureLease(lease, false, t);
    } catch {
      // The test already failed; the refusal and evidence stay in place.
    }
  });
  cleanupFixtureLease(lease, false, t);
  assert.equal(existsSync(pkg.root), false, "default teardown removes the settled fixture");
});

test("a missing settlement witness retains the fixture even when the smoke run succeeded", async (t) => {
  const pkg = await makePackageFixture("pi-native-host-order-unconfirmed");
  const { result, sequence } = await runPreloadOrderSmoke(pkg, NESTED_CHILD_SUCCEEDS, true);
  // Independent settlement evidence, asserted before any rollback is authorized: the outer
  // process exited on its own, and the nested child finished its own work.
  assert.equal(result.status, 0, "the smoke run itself succeeds");
  assert.ok(sequence?.includes(PRELOAD_SMOKE_SUCCEEDED) === true,
    "the nested child completed under the user --require's own collection");
  // Settlement is still unconfirmed: the witness that records the collection is absent.
  assert.equal(sequence?.includes(PRELOAD_SMOKE_COLLECTED), false, "the collection witness is missing");
  const lease = fixtureLeases.pop()!;
  let rolledBack = false;
  const rollback = () => {
    if (rolledBack || lease.unsettledReason === undefined) return;
    cleanupFixtureLease({ ...lease, unsettledReason: undefined }, false, t);
    lease.unsettledReason = undefined;
    rolledBack = true;
  };
  t.after(rollback);
  const diagnostics: string[] = [];
  assert.throws(
    () => cleanupFixtureLease(lease, false, { diagnostic: (message) => diagnostics.push(message) }),
    /retained without confirmed settlement/,
    "a missing witness refuses teardown even though the smoke run succeeded",
  );
  assert.equal(existsSync(pkg.root), true, "the unsettled fixture's evidence is retained");
  assert.ok(diagnostics.some((line) => line.includes(pkg.root)), "the retained location is reported");
  rollback();
  assert.equal(existsSync(pkg.root), false, "the independently authorized rollback removes the probe fixture");
});

test("resolveNativePi rejects noisy, pre-release, and multi-number --version output (strict official formats only)", async (t) => {
  // A runtime banner plus the CLI version: a loose first-number scan would
  // wrongly accept "24.1.0"; only exact official formats may parse.
  const cases = [
    "node 24.1.0\npi 1.0.4\n",
    "pi 1.0.4 (build 2024)\n",
    "1.0.4-beta\n",
    "pi 1.0.5-rc.1\n",
    "v1.0.4.1\n",
    "some noise\n1.0.4\n",
  ] as const;
  const fake = await makePiFixture("1.0.4");
  for (const output of cases) {
    await writeFile(join(fake.bin, "pi"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, "utf8");
    await chmod(join(fake.bin, "pi"), 0o755);
    try {
      resolveNativePi({ executable: "pi", env: { PATH: `${fake.bin}:${process.env.PATH}` } });
      assert.fail(`noisy output must be rejected: ${JSON.stringify(output)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /official version format/, `noise must be classified unparseable: ${JSON.stringify(output)}`);
      assert.doesNotMatch(message, /24\.1\.0/);
    }
  }
  // Exact official formats still parse: bare, v-prefixed, and CLI-prefixed.
  for (const [output, expected] of [["1.0.4\n", "1.0.4"], ["v1.0.4\n", "1.0.4"], ["pi 1.0.4\n", "1.0.4"]] as const) {
    await writeFile(join(fake.bin, "pi"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, "utf8");
    await chmod(join(fake.bin, "pi"), 0o755);
    assert.equal(resolveNativePi({ executable: "pi", env: { PATH: `${fake.bin}:${process.env.PATH}` } }).version, expected);
  }
  // Pre-release at the floor is never accepted as a stable >= 4 build.
  await writeFile(join(fake.bin, "pi"), `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4-beta\\n');\n`, "utf8");
  await chmod(join(fake.bin, "pi"), 0o755);
  assert.throws(() => resolveNativePi({ executable: "pi", env: { PATH: `${fake.bin}:${process.env.PATH}` } }), /official version format/);
});

test("resolveNativePi rejects unreadable, unknown, and opaque non-Node entries before probing", async (t) => {
  const root = await makeFixtureRoot(`pi-native-host-head-${process.pid}-${Date.now()}`, "native-host entry fixture");
  // An unreadable executable is rejected without probing.
  const unreadableDir = join(root, "unreadable");
  mkdirSync(unreadableDir, { recursive: true });
  const unreadable = join(unreadableDir, "pi");
  writeFileSync(unreadable, "binary-ish\n", "utf8");
  chmodSync(unreadable, 0o000);
  assert.throws(
    () => resolveNativePi({ executable: unreadable, env: { PATH: "/nonexistent" } }),
    /not an executable regular file/,
    "an X_OK-unreadable executable is rejected at file validation, before any probe",
  );
  // A non-shebang unknown executable is rejected without executing it: the
  // fake would create a marker if any probe ran.
  const unknownDir = join(root, "unknown");
  mkdirSync(unknownDir, { recursive: true });
  const unknown = join(unknownDir, "pi");
  writeFileSync(unknown, "plain custom blob without shebang and without binary magic\n", "utf8");
  const marker = join(root, "probe-marker");
  chmodSync(unknown, 0o755);
  try {
    resolveNativePi({ executable: unknown, env: { PATH: "/nonexistent", MARKER: marker } });
    assert.fail("unknown non-shebang executable must be rejected");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /does not start with a positive Node-entry shebang/);
  }
  assert.equal(existsSync(marker), false, "no probe is executed for an unknown executable format");

  // Opaque shell startup could spawn helpers before Node consumes the
  // NODE_OPTIONS scrubber. Reject it before probe or skill publication, and
  // prove its body never runs by leaving a marker if it does.
  const shimDir = join(root, "opaque-shim");
  await mkdir(shimDir, { recursive: true });
  const shim = join(shimDir, "pi");
  const shimMarker = join(root, "shim-body-ran");
  await writeFile(shim, "#!/bin/sh\nprintf 'ran' > \"$MARKER\"\nprintf 'pi 1.0.4\\n'\n", "utf8");
  await chmod(shim, 0o755);
  assert.throws(
    () => resolveNativePi({ executable: shim, env: { PATH: "/nonexistent", MARKER: shimMarker } }),
    /positive Node-entry shebang/,
    "opaque shell entrypoints are rejected rather than parsed or probed",
  );
  assert.equal(existsSync(shimMarker), false, "the rejected shim body never executes");

  const pkg = await makePackageFixture("pi-native-host-opaque");
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { piExecutable: shim })),
    /positive Node-entry shebang/,
    "descriptor preparation also rejects an opaque launcher before publication",
  );
  assert.equal(existsSync(pkg.skillsRoot), false, "rejected shell entrypoints publish no profile files");
});

test("prepareNativeLaunch enforces the NODE_OPTIONS bound in real UTF-8 bytes (unicode values)", async (t) => {
  const pkg = await makePackageFixture();
  // 2750 astral-plane chars = 11000 UTF-8 bytes, but only 2750 UTF-16 units:
  // a length-based check would wrongly accept this value.
  const unicodeOpts = "\u{1F600}".repeat(2750);
  assert.ok(Buffer.byteLength(unicodeOpts, "utf8") > MAX_NATIVE_NODE_OPTIONS_BYTES);
  assert.ok(unicodeOpts.length < MAX_NATIVE_NODE_OPTIONS_BYTES);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: unicodeOpts } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("UTF-8") && !message.includes(unicodeOpts.slice(0, 64));
    },
  );
});

test("prepareNativeLaunch role rejection diagnostics never echo the role flag value", async (t) => {
  const pkg = await makePackageFixture();
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, [RUNTIME_ROLE_ENV]: "secret-worker-token" } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes(RUNTIME_ROLE_ENV) && !message.includes("secret-worker-token");
    },
  );
});

test("prepareNativeLaunch validates the config through a bounded, non-blocking, secret-safe read", async (t) => {
  const pkg = await makePackageFixture();

  // A regular-target symlink is admitted (profile registry may stage it).
  const linkedTarget = join(pkg.root, "real-config.json");
  await writeFile(linkedTarget, JSON.stringify({ enabled: true, review: { activeReviewers: [] } }), "utf8");
  rmSync(pkg.configPath);
  await symlink(linkedTarget, pkg.configPath);
  const descriptor = prepareNativeLaunch(baseOptions(pkg));
  assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, pkg.configPath);

  // A malformed config containing a private API-key marker rejects with a
  // generic, path-only diagnostic: modern V8 JSON.parse errors embed input
  // snippets, which must never be echoed.
  const malformed = '{ "leaked": "sk-private-API-KEY-marker", invalid';
  await rm(pkg.configPath);
  await writeFile(pkg.configPath, malformed, "utf8");
  try {
    prepareNativeLaunch(baseOptions(pkg));
    assert.fail("malformed config must reject");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /not valid JSON/);
    assert.doesNotMatch(message, /sk-private-API-KEY-marker/, "config content is never echoed");
    assert.doesNotMatch(message, /leaked/);
    assert.ok(!message.includes("Unexpected token"), "no parser error snippet survives");
  }

  // A FIFO at the config path is rejected without blocking, through a direct
  // link or a symlink pointing at a FIFO.
  await rm(pkg.configPath);
  const fifo = join(pkg.root, "config-fifo");
  execFileSync("mkfifo", [fifo]);
  trackFixtureCreatedPath(fifo);
  await symlink(fifo, pkg.configPath);
  const started = Date.now();
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    (error: unknown) => (error instanceof Error ? /not a regular file/.test(error.message) : false),
    "a FIFO-target config symlink must be rejected",
  );
  assert.ok(Date.now() - started < 10_000, "the FIFO-target config must reject without blocking");
  assert.equal((await stat(fifo)).isFIFO(), true, "the FIFO target is untouched");
});

test("prepareNativeLaunch prevalidates symlinked skill directories before ANY mkdir (external tree untouched)", async (t) => {
  const pkg = await makePackageFixture();
  // Profile-registry-style setup: the skills root exists, and the orchestrator
  // skill directory is a symlink aliasing an EXTERNAL directory that does not
  // contain the expected "references" child. The earlier behavior (mkdir
  // before the symlink precheck) would have created <external>/references
  // before rejecting.
  const outside = join(pkg.root, "external-target");
  await mkdir(outside, { recursive: true });
  await mkdir(pkg.skillsRoot, { recursive: true });
  await symlink(outside, join(pkg.skillsRoot, "pi-review-gate-orchestrator"));
  const before = await (await import("node:fs/promises")).readdir(outside);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    /refusing to publish the native skills through a symlinked path component/,
  );
  assert.deepEqual(await (await import("node:fs/promises")).readdir(outside), before, "the external target tree is unchanged");
  assert.equal(existsSync(join(outside, "references")), false, "no references directory was created through the alias");
  assert.equal(existsSync(join(outside, "SKILL.md")), false, "no skill file leaked into the external target");
  // No partial publication: later plan members were not written either.
  assert.equal(existsSync(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md")), false);
  assert.equal(existsSync(join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md")), false);
});

test("the restoration-frame bound covers the SERIALIZED sidecar in UTF-8 bytes, at exact boundaries", async (t) => {
  const pkg = await makePackageFixture();

  // Boundary A: whitespace-only options — an accepted original produces a
  // frame that exactly reaches (never exceeds) the 8 KiB restore cap.
  // JSON overhead for {"original":""} is 15 bytes, value bytes plain.
  const fitsExactly = " ".repeat(MAX_NATIVE_NODE_OPTIONS_BYTES - 15);
  assert.equal(
    Buffer.byteLength(JSON.stringify({ original: fitsExactly }), "utf8"),
    MAX_NATIVE_NODE_OPTIONS_BYTES,
    "test precondition: the frame sits exactly at the cap",
  );
  const ok = prepareNativeLaunch(baseOptions(pkg, {
    env: { PATH: process.env.PATH, NODE_OPTIONS: fitsExactly },
  }));
  assert.equal(Buffer.byteLength(ok.env[NODE_OPTIONS_RESTORE_ENV]!, "utf8"), MAX_NATIVE_NODE_OPTIONS_BYTES);
  assert.ok(ok.env.NODE_OPTIONS!.startsWith(`--require="${join(pkg.packageRoot, "dist", "src", "session-host", "bootstrap-preload.js")}"`));
  const oneOver = " ".repeat(MAX_NATIVE_NODE_OPTIONS_BYTES - 14);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: oneOver } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("restore cap") && !message.includes(oneOver);
    },
  );

  // Boundary B: escape-heavy options — every quote/backslash grows the
  // serialized frame beyond the original's byte count.
  const escapesFit = Array.from({ length: 4088 }, () => "\\").join("");
  assert.equal(
    Buffer.byteLength(JSON.stringify({ original: escapesFit }), "utf8"),
    MAX_NATIVE_NODE_OPTIONS_BYTES - 1,
  );
  assert.equal(
    Buffer.byteLength(JSON.stringify({ original: `${escapesFit}\\` }), "utf8"),
    MAX_NATIVE_NODE_OPTIONS_BYTES + 1,
  );
  const okEscaped = prepareNativeLaunch(baseOptions(pkg, {
    env: { PATH: process.env.PATH, NODE_OPTIONS: escapesFit },
  }));
  assert.equal(
    (JSON.parse(okEscaped.env[NODE_OPTIONS_RESTORE_ENV]!) as { original: string }).original,
    escapesFit,
    "escape-heavy original is preserved byte-exact through the sidecar",
  );
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: `${escapesFit}\\` } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("restore cap") && !message.includes(escapesFit);
    },
  );
});

test("the version probe parses the official stdout format only; stderr never rescues an unsupported CLI", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  // An older-version (plus noise) stdout cannot be rescued by a valid-looking
  // newer version on stderr: the CLI's real version is the stdout identity.
  await writeFile(
    join(fixture.bin, "pi"),
    `#!${process.execPath}\nprocess.stdout.write('pi 1.0.3\\nnoise-output\\n'); process.stderr.write('pi 1.0.4\\n');\n`,
    "utf8",
  );
  await chmod(join(fixture.bin, "pi"), 0o755);
  try {
    resolveNativePi({ executable: "pi", env: { PATH: `${fixture.bin}:${process.env.PATH}` } });
    assert.fail("noisy stdout must never be rescued by stderr");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /official version format/);
    assert.doesNotMatch(message, /1\.0\.3/, "the stdout content is never echoed");
    assert.doesNotMatch(message, /1\.0\.4/, "the stderr content is never echoed");
    assert.doesNotMatch(message, /noise-output/);
  }
  // Empty stdout is likewise unparseable-strict, whatever stderr says.
  const fixture2 = await makePiFixture("1.0.4");
  await writeFile(join(fixture2.bin, "pi"), `#!${process.execPath}\nprocess.stderr.write('pi 1.0.4\\n');\n`, "utf8");
  await chmod(join(fixture2.bin, "pi"), 0o755);
  assert.throws(
    () => resolveNativePi({ executable: "pi", env: { PATH: `${fixture2.bin}:${process.env.PATH}` } }),
    /official version format/,
  );
});

test("prepareNativeLaunch rejects parent startup session overrides before any publication", async (t) => {
  const pkg = await makePackageFixture();
  const cases: Array<{ args: string[]; flag: string; secret?: string }> = [
    { args: ["--session", "/tmp/old.jsonl"], flag: "--session", secret: "/tmp/old.jsonl" },
    { args: ["--session=/sensitive/path"], flag: "--session", secret: "/sensitive/path" },
    { args: ["--continue"], flag: "--continue" },
    { args: ["-c"], flag: "-c" },
    { args: ["--resume"], flag: "--resume" },
    { args: ["-r"], flag: "-r" },
    { args: ["--session-id", "id-secret"], flag: "--session-id", secret: "id-secret" },
    { args: ["--fork", "id-secret"], flag: "--fork", secret: "id-secret" },
    { args: ["--session-dir", "/storage/secret"], flag: "--session-dir", secret: "/storage/secret" },
    { args: ["--no-session"], flag: "--no-session" },
    // --scheduler removal shifts native boundaries: Pi would see
    // `--system-prompt -- --session …` with a live session option.
    { args: ["--system-prompt", "--scheduler", "--", "--session", "/tmp/old.jsonl"], flag: "--session", secret: "/tmp/old.jsonl" },
  ];
  for (const entry of cases) {
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg, { args: entry.args })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(entry.flag));
        if (entry.secret) assert.ok(!message.includes(entry.secret), "diagnostic must not leak override content");
        return true;
      },
      entry.flag,
    );
  }
  assert.equal(existsSync(pkg.skillsRoot), false, "no skill publication for rejected startup overrides");
});

test("prepareNativeLaunch rejects a nonempty inherited session-dir env override before any publication", async (t) => {
  const pkg = await makePackageFixture();
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, PI_CODING_AGENT_SESSION_DIR: join(pkg.root, "private-storage") } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("PI_CODING_AGENT_SESSION_DIR") && !message.includes(join(pkg.root, "private-storage"));
    },
  );
  assert.equal(existsSync(pkg.skillsRoot), false, "no skill publication for a rejected session-dir override");
  // An empty inherited value is benign and passes through untouched.
  const descriptor = prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, PI_CODING_AGENT_SESSION_DIR: "" } }));
  assert.equal(descriptor.env.PI_CODING_AGENT_SESSION_DIR, "");
});

/**
 * Pi 1.7.0 applies `--agent-dir <dir>` with an early raw scan of the arguments
 * the child actually receives, before normal parsing. Every native Pi row of one
 * host shares that host's single validated agent directory, so the shared child
 * guard declines an effective hosted override before any preparation, while Pi's
 * own non-override spellings stay byte-for-byte native.
 */
test("prepareNativeLaunch declines a hosted --agent-dir profile override before preparing the child", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const profileB = join(pkg.root, "profile-B");
  await mkdir(profileB, { recursive: true });
  await writeFile(join(profileB, "auth.json"), "other profile\n", "utf8");
  for (const args of [
    ["--agent-dir", profileB],
    ["--agent-dir"],
    ["--model", "--agent-dir", profileB],
    ["--scheduler", "--agent-dir", profileB],
    // A pre-delimiter spelling survives composition as an option token, so the
    // shared child admission — not composition — is what stops the child.
    composeFreshSessionSpawnArgs(["--model", "--agent-dir", profileB], "child"),
    // The ambiguous reconstruction: `--` became the old title's VALUE, so
    // composition never stopped there and dropping the `--name` pair removed the
    // delimiter. The promoted tokens now sit in the child's raw early option
    // area, where Pi's own profile scan would honor them; this guard fails that
    // launch closed instead of spawning a child on a second profile.
    composeFreshSessionSpawnArgs(["--name", "--", "--agent-dir", profileB], "child"),
  ]) {
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg, { args })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /--agent-dir/);
        assert.match(message, /PI_CODING_AGENT_DIR/, "names the supported host-wide override");
        assert.ok(!message.includes(profileB), "diagnostic must not name the rejected profile");
        return true;
      },
      JSON.stringify(args),
    );
  }
  assert.equal(existsSync(pkg.skillsRoot), false, "no skill publication for a declined profile override");
  assert.deepEqual((await readdir(profileB)).sort(), ["auth.json"], "the named profile is not prepared or rewritten");
  assert.equal(await readFile(join(profileB, "auth.json"), "utf8"), "other profile\n");

  // After Pi's own `--` the tokens are message data, and Pi 1.7.0 recognizes no
  // attached spelling as a profile selection; both stay native and the child
  // keeps the host's one canonical agent-directory pin.
  for (const args of [["--", "--agent-dir", profileB], ["--agent-dir=" + profileB]]) {
    const admitted = prepareNativeLaunch(baseOptions(pkg, { args }));
    // Windows descriptors run the same CLI through Node, so they also prepend
    // the canonical Pi entry ahead of the two extension pairs.
    const nativeStart = process.platform === "win32" ? 5 : 4;
    assert.deepEqual(admitted.args.slice(nativeStart), args, "native arguments are forwarded byte-for-byte");
    assert.equal(admitted.env.PI_CODING_AGENT_DIR, pkg.agentDir, "the child keeps the host's canonical agent directory");
  }
});

test("prepareNativeLaunch admits value lookalikes and native -- data byte-for-byte", async (t) => {
  const pkg = await makePackageFixture();
  for (const args of [
    ["--model", "--session"],
    ["--system-prompt", "--session"],
    ["--", "--session", "/tmp/old.jsonl"],
  ]) {
    const descriptor = prepareNativeLaunch(baseOptions(pkg, { args }));
    assert.deepEqual(descriptor.args.slice(4), args, "native arguments are forwarded byte-for-byte");
  }
});

interface CompiledLaunchModule {
  prepareNativeLaunch(options: Record<string, unknown>): unknown;
}

// ---------------------------------------------------------------------------
// Deliberate per-child saved-session selection (issue 323)
// ---------------------------------------------------------------------------

/** Synthetic flat listAll for launch tests: .jsonl files of one directory only. */
async function flatListAll(sessionDir: string): Promise<{ path: string; id: string; cwd: string }[]> {
  const entries = await readdir(sessionDir, { withFileTypes: true });
  const rows: { path: string; id: string; cwd: string }[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl")) continue;
    const file = join(sessionDir, entry.name);
    const text = await readFile(file, "utf8");
    const firstLine = text.split("\n")[0];
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.cwd !== "string") continue;
    rows.push({ path: file, id: record.id, cwd: record.cwd });
  }
  return rows;
}

/** Create one saved conversation under the fixture agent dir and admit it. */
async function admitFixtureSavedSession(pkg: PackageFixture, id = "saved-1", ownership?: FixtureOwnership): Promise<{ savedFile: string; admission: SavedSessionAdmission }> {
  const sessionsDir = join(pkg.agentDir, "sessions");
  const projDir = join(sessionsDir, "proj");
  if (ownership) {
    // Exclusive one-level creation, receipted in that same synchronous step: refuse to
    // adopt an untracked existing dir, and record sessions before proj so a proj failure
    // never leaves sessions untracked.
    mkdirOwnedLevel(sessionsDir, ownership);
    mkdirOwnedLevel(projDir, ownership);
  } else {
    await mkdir(projDir, { recursive: true });
  }
  const savedFile = join(projDir, "saved.jsonl");
  await writeFile(savedFile, `${JSON.stringify({ type: "session", id, cwd: pkg.workspace })}\n`, "utf8", ownership);
  const catalog = await listSavedSessions({ agentDir: pkg.agentDir, listAll: flatListAll });
  const result = admitSavedSession(catalog, catalog.rows[0]);
  assert.equal(result.status, "admitted", "the fixture saved session must admit");
  if (result.status !== "admitted") throw new Error("unreachable");
  return { savedFile, admission: result.admission };
}

function nativeLaunchEnv(pkg: PackageFixture): NodeJS.ProcessEnv {
  return {
    HOME: join(pkg.root, "home"),
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: pkg.agentDir,
  };
}

test("prepareNativeLaunch composes the exact --session option for an admitted saved selection (native mode)", async (t) => {
  const pkg = await makePackageFixture();
  const { savedFile, admission } = await admitFixtureSavedSession(pkg);
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    savedSession: admission,
  }));
  assert.deepEqual(descriptor.args, [
    "--extension",
    join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(pkg.packageRoot, "dist", "src", "index.js"),
    "--session",
    savedFile,
  ], "the authorized --session <file> option follows the extensions and nothing else is injected");
  assert.equal(descriptor.cwd, pkg.workspace);
});

test("saved selection argument order snapshot: --session composes before any caller args", async (t) => {
  const pkg = await makePackageFixture();
  const { savedFile, admission } = await admitFixtureSavedSession(pkg);
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    args: ["-p", "plan", "--", "message data"],
    savedSession: admission,
  }));
  // Snapshot: extensions first, then the authorized --session option in a
  // position that is ALWAYS an option position for the native parser, then
  // the caller args byte-for-byte (a genuine `--` still terminates options).
  assert.deepEqual(descriptor.args, [
    "--extension",
    join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(pkg.packageRoot, "dist", "src", "index.js"),
    "--session",
    savedFile,
    "-p",
    "plan",
    "--",
    "message data",
  ]);
});

test("saved selection composes in option position regardless of caller args that look like separators or values", async (t) => {
  const pkg = await makePackageFixture();
  const { savedFile, admission } = await admitFixtureSavedSession(pkg);
  const extensions = [
    "--extension",
    join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(pkg.packageRoot, "dist", "src", "index.js"),
  ];

  // A `--` that is the VALUE of a value-taking flag is not the separator:
  // composing before the caller args keeps --session in option position.
  let descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    args: ["--model", "--", "message"],
    savedSession: admission,
  }));
  assert.deepEqual(descriptor.args, [...extensions, "--session", savedFile, "--model", "--", "message"]);

  // A trailing value-taking flag: our pair is never consumed as its value.
  descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    args: ["--model"],
    savedSession: admission,
  }));
  assert.deepEqual(descriptor.args, [...extensions, "--session", savedFile, "--model"]);

  // A genuine separator: everything after it stays message/file data.
  descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    args: ["--", "data"],
    savedSession: admission,
  }));
  assert.deepEqual(descriptor.args, [...extensions, "--session", savedFile, "--", "data"]);
});

test("legacy profile mode rejects the native saved selection (no cross-setup copies)", async (t) => {
  const pkg = await makePackageFixture();
  const { admission } = await admitFixtureSavedSession(pkg);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { savedSession: admission })),
    /legacy profile mode does not accept a native saved-session selection/,
  );
});

test("parent startup overrides, raw --session args, and role env still reject with a saved selection present", async (t) => {
  const pkg = await makePackageFixture();
  const { admission } = await admitFixtureSavedSession(pkg);
  // Parent resume flags are rejected by the startup guard before composition.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), args: ["--resume"], savedSession: admission })),
    /--resume/,
  );
  // A raw --session in caller args is never an admission path.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), args: ["--session", "/tmp/old.jsonl"], savedSession: admission })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("--session") && !message.includes("/tmp/old.jsonl");
    },
  );
  // Executor role input is still rejected fail-closed.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: { ...nativeLaunchEnv(pkg), [RUNTIME_ROLE_ENV]: "executor" }, savedSession: admission })),
    (error: unknown) => (error instanceof Error ? error.message.includes(RUNTIME_ROLE_ENV) : false),
  );
  // Legacy session-dir env override is still rejected before any selection work.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { savedSession: admission, env: { PATH: process.env.PATH, PI_CODING_AGENT_SESSION_DIR: join(pkg.root, "private-storage") } })),
    /PI_CODING_AGENT_SESSION_DIR|legacy profile mode/,
  );
});

test("alien receipts and foreign agent directories are refused at launch", async (t) => {
  const pkg = await makePackageFixture();
  const { admission } = await admitFixtureSavedSession(pkg);
  // A caller-fabricated receipt object (no brand) is refused.
  const alien = { ...admission };
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: alien })),
    /not a valid admission receipt/,
  );
  // A receipt minted under a DIFFERENT native agent directory is refused.
  const foreignAgent = join(pkg.root, "home2", ".pi", "agent");
  const foreignProj = join(foreignAgent, "sessions", "proj");
  await mkdir(foreignProj, { recursive: true });
  await writeFile(join(foreignProj, "saved.jsonl"), `${JSON.stringify({ type: "session", id: "foreign-1", cwd: pkg.workspace })}\n`, "utf8");
  const foreignCatalog = await listSavedSessions({ agentDir: foreignAgent, listAll: flatListAll });
  const foreignResult = admitSavedSession(foreignCatalog, foreignCatalog.rows[0]);
  assert.equal(foreignResult.status, "admitted");
  if (foreignResult.status !== "admitted") throw new Error("unreachable");
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: foreignResult.admission })),
    /different native agent directory/,
  );
});

test("launch revalidates the saved file before spawn: replacement, deletion, and identity change refuse", async () => {
  // Per-entry ownership receipts: teardown removes only the exact entries this
  // fixture/test created (identity-checked), never unknown or replaced content.
  // runWithCleanup aggregates a body failure with a cleanup failure so neither
  // masks the other (node:test suppresses an after-hook error when the body fails).
  // Pre-register the refusal before admitting the strict fixture: if the marker
  // cannot be created, this test fails without creating the fixture.
  const resolveRefusal = signalCleanupRefusal("native-host saved-file cleanup pending");
  const ownership = new FixtureOwnership();
  const allocated: { path?: string } = {};
  await runWithCleanup(async () => {
    const fixtureRoot = await allocateStrictFixtureRoot("pi-native-host-pkg", ownership, allocated);
    const pkg = await makePackageFixture("pi-native-host-pkg", { root: fixtureRoot, ownership });
    const { savedFile, admission } = await admitFixtureSavedSession(pkg, "saved-1", ownership);
    const requireOwnedIdentity = async (file: string, receipt: { dev: bigint; ino: bigint }): Promise<void> => {
      const current = await lstat(file, { bigint: true });
      assert.ok(current.isFile() && !current.isSymbolicLink());
      assert.equal(current.dev, receipt.dev);
      assert.equal(current.ino, receipt.ino);
    };

    // Replaced first line (different id): the live header no longer matches.
    await requireOwnedIdentity(savedFile, admission);
    await writeFile(savedFile, `${JSON.stringify({ type: "session", id: "replaced-1", cwd: pkg.workspace })}\n`, "utf8", ownership);
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
      /no longer matches its admission/,
    );

    // Allocate the replacement while the original inode still exists. Linux
    // may immediately reuse an inode after unlink, so unlink+write alone does
    // not establish the changed-identity precondition this assertion exercises.
    const replacement = join(pkg.root, "saved-replacement.jsonl");
    await writeFile(replacement, `${JSON.stringify({ type: "session", id: "saved-1", cwd: pkg.workspace })}\n`, { encoding: "utf8", flag: "wx" }, ownership);
    const replacementIdentity = await lstat(replacement, { bigint: true });
    assert.ok(replacementIdentity.dev !== admission.dev || replacementIdentity.ino !== admission.ino,
      "both simultaneously existing files demonstrably have different identities");

    // Deleted file: refused honestly. Check exact identity before unlink.
    await requireOwnedIdentity(savedFile, admission);
    await rm(savedFile);
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
      /saved-session file is missing/,
    );

    // Publish the separately created identical-content file at the now absent
    // path; verify the different identity survived before requiring refusal.
    await requireOwnedIdentity(replacement, replacementIdentity);
    assert.equal(existsSync(savedFile), false);
    await rename(replacement, savedFile);
    ownership.moveTree(replacement, savedFile); // transfer the existing receipt, never re-read the path
    await requireOwnedIdentity(savedFile, replacementIdentity);
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
      /changed since admission/,
    );

    // A symlink at the admitted path is refused.
    const target = join(pkg.root, "saved-target.jsonl");
    await writeFile(target, `${JSON.stringify({ type: "session", id: "saved-1", cwd: pkg.workspace })}\n`, { encoding: "utf8", flag: "wx" }, ownership);
    await requireOwnedIdentity(savedFile, replacementIdentity);
    await rm(savedFile);
    await symlink(target, savedFile, ownership); // the owned entry is now this symlink (its target stays external)
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
      /saved-session file is a symlink/,
    );
  }, () => finalizeStrictFixtureRoot(ownership, allocated, resolveRefusal), resolveRefusal);
});

test("strict allocation distinguishes no path returned from a path without a valid receipt", async (t) => {
  const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  const originalMkdtemp = fsPromises.mkdtemp;
  const invocationRoot = process.env.PI_TEST_SCRATCH_ROOT;
  const probe = async (failBeforePath: boolean, reason: string) => {
    const ownership = new FixtureOwnership(); // the strict ledger under test
    const allocated: { path?: string } = {};
    const created = new FixtureOwnership();   // this probe's own entries, receipted as they are created
    const failures: unknown[] = [];
    let holder: string | undefined;
    let link: string | undefined;
    // Registered before anything is created, and receipt-checked: rollback verifies the
    // creation receipts and removes ONLY the entries this probe created, then confirms their
    // absence by lstat. A replaced path fails the receipt instead of being deleted.
    const rollback = () => {
      try { created.verify(); } catch { /* the probe asserts the primary failure itself */ }
      try { created.cleanup(); } catch { /* as above */ }
      for (const path of [link, holder]) {
        if (path === undefined) continue;
        assert.equal(lstatSync(path, { bigint: true, throwIfNoEntry: false }), undefined,
          `the probe did not remove its own entry: ${path}`);
        created.untrack(path); // idempotent rollback
      }
    };
    t.after(rollback);
    const resolve = signalCleanupRefusal(reason);
    if (failBeforePath) {
      const injected = new Error("injected strict allocation rejection") as Error & { code?: string };
      injected.code = "ENOENT";
      fsPromises.mkdtemp = (async () => { throw injected; }) as unknown as typeof fsPromises.mkdtemp;
    } else {
      // A path is returned, but it is not a canonical real directory: the receipt fails.
      holder = join(fixtureBase, `.pi-native-host-pkg-holder-${process.pid}-${Date.now()}`);
      fsMkdirSync(holder);
      created.track(holder); // creation receipt, taken at creation
      link = `${holder}-link`;
      fsSymlinkSync(holder, link); // the returned path resolves away from itself
      created.track(link);
      fsPromises.mkdtemp = (async () => link) as unknown as typeof fsPromises.mkdtemp;
    }
    try {
      await allocateStrictFixtureRoot("pi-native-host-pkg", ownership, allocated);
    } catch (error) {
      failures.push(error);
    } finally {
      fsPromises.mkdtemp = originalMkdtemp;
    }
    try {
      finalizeStrictFixtureRoot(ownership, allocated, resolve); // the same decision the real caller makes
    } catch (error) {
      failures.push(error);
    }
    return { body: failures[0], cleanup: failures[1], path: allocated.path, rollback, resolve };
  };
  const marker = (reason: string) => invocationRoot === undefined
    ? Promise.resolve(false)
    : hasFixtureRefusal(invocationRoot, reason); // only THIS probe's reservation, not every marker

  // Refusal entries exist only under the test-scratch runner; a direct compiled run
  // exercises the same allocation and cleanup errors without inventing a marker.
  // (1) Allocation rejected before any path came back: the original error stays visible,
  // nothing is recorded, and this probe's wrapped refusal marker is cleared.
  const noPathReason = "native-host strict allocation probe: no path";
  const before = await probe(true, noPathReason);
  assert.equal((before.body as Error & { code?: string })?.code, "ENOENT", "the original allocation error remains visible");
  assert.match(String((before.body as Error).message), /injected strict allocation rejection/);
  assert.equal(before.cleanup, undefined, "no cleanup error is invented for an allocation that never returned a path");
  assert.equal(before.path, undefined, "no path is recorded when none was returned");
  if (invocationRoot !== undefined) {
    assert.equal(await marker(noPathReason), false, "this probe's wrapped refusal marker is cleared");
  }

  // (2) A path came back but had no valid receipt: it is reported and retained, and this
  // probe's wrapped refusal marker stays unresolved.
  const unverifiedReason = "native-host strict allocation probe: unverified path";
  const after = await probe(false, unverifiedReason);
  assert.match(String((after.body as Error).message), /allocated fixture root is not a canonical real directory/,
    "the receipt failure is visible");
  assert.ok(after.path !== undefined, "the returned path is recorded before its receipt");
  assert.match(String((after.cleanup as Error).message), /fixture cleanup refused; retained/,
    "a returned path without a valid receipt is refused, not reported as preserved");
  assert.match(String((after.cleanup as Error).message), /not a canonical owned directory/);
  assert.equal(existsSync(after.path!), true, "the unverified path is retained as evidence");
  if (invocationRoot !== undefined) {
    assert.equal(await marker(unverifiedReason), true, "this probe's wrapped refusal marker stays unresolved");
  }
  // Remove the probe's own entries first (receipt-checked), then clear the marker last: the
  // retained evidence can never be swept by wrapped cleanup while a refusal is still pending.
  after.rollback();
  if (invocationRoot !== undefined) {
    assert.equal(await marker(unverifiedReason), true, "the marker stays unresolved until this probe resolves it");
  }
  after.resolve();
  if (invocationRoot !== undefined) {
    assert.equal(await marker(unverifiedReason), false, "resolving this probe's reservation clears only it");
  }
});

test("owned fixture cleanup removes an owned symlink without touching its external target", async (t) => {
  const extRoot = await makeFixtureRoot("pi-native-host-ownext", "native-host external target fixture");
  const external = join(extRoot, "target.txt");
  await writeFile(external, "external bytes\n", "utf8");
  // The link root's refusal is reserved immediately before its own allocation, and only an
  // allocation failure clears it — validation runs outside that catch, so a refused receipt
  // never resolves the marker it just reserved.
  const resolveRefusal = signalCleanupRefusal("native-host owned-symlink cleanup pending");
  let root: string;
  try {
    root = await mkdtemp(join(fixtureBase, ".pi-native-host-ownlink-"));
  } catch (error) {
    resolveRefusal(); // the allocation never returned a root to retain
    throw error;
  }
  const ownership = new FixtureOwnership();
  const receipt = lstatSync(root, { bigint: true });
  assert.ok(receipt.isDirectory() && realpathSync(root) === root, `allocated link fixture is not canonical: ${root}`);
  ownership.track(root, receipt);
  let removalConfirmed = false;
  t.after(() => {
    // This test deliberately removes the owned root as the behavior under test, but the
    // refusal is cleared only after the probe positively confirmed that removal. Otherwise
    // the ownership finalizer reports the missing root and the refusal stays reserved.
    if (removalConfirmed && lstatSync(root, { bigint: true, throwIfNoEntry: false }) === undefined) {
      resolveRefusal();
      return;
    }
    finalizeOwnedFixture(ownership, root, resolveRefusal);
  });
  const link = join(root, "link.txt");
  await symlink(external, link, ownership);
  ownership.cleanup();
  assert.equal(existsSync(link), false, "the owned symlink is removed");
  assert.equal(lstatSync(root, { bigint: true, throwIfNoEntry: false }), undefined,
    "the cleanup under test positively removed the root");
  // Removal is positively confirmed here; the external target is asserted independently after.
  removalConfirmed = true;
  assert.equal(await readFile(external, "utf8"), "external bytes\n", "the external target is untouched");
  removalConfirmed = true;
});

test("owned fixture cleanup preserves an unknown entry and fails visibly", async () => {
  const resolveRefusal = signalCleanupRefusal("native-host unknown-entry cleanup pending");
  const root = await realpath(await mkdtemp(join(fixtureBase, ".pi-native-host-ownunknown-")));
  const ownership = new FixtureOwnership();
  ownership.track(root);
  const rollback = new FixtureOwnership();
  rollback.track(root);
  const unknown = join(root, "unknown.txt");
  await runWithCleanup(async () => {
    await writeFile(unknown, "not mine\n", { encoding: "utf8", flag: "wx" }, rollback);
    // Unknown to the tracker under test: rollback receipted it from its own creation.
    assert.throws(() => ownership.cleanup(),
      (error: unknown) => error instanceof Error && /failed/.test(error.message),
      "cleanup fails visibly on unknown content");
    assert.equal(existsSync(unknown), true, "the unknown entry survives the failed cleanup");
  }, () => rollback.cleanup(), resolveRefusal);
});

test("owned fixture cleanup preserves a replaced (different-identity) leaf and fails visibly", async () => {
  const resolveRefusal = signalCleanupRefusal("native-host replaced-leaf cleanup pending");
  const root = await realpath(await mkdtemp(join(fixtureBase, ".pi-native-host-ownrepl-")));
  const ownership = new FixtureOwnership();
  ownership.track(root);
  const rollback = new FixtureOwnership();
  rollback.track(root);
  const leaf = join(root, "leaf.txt");
  const other = join(root, "other.txt");
  await runWithCleanup(async () => {
    await writeFile(leaf, "original\n", { encoding: "utf8", flag: "wx" }, ownership);
    rollback.track(leaf);
    // Create the replacement while the original exists, guaranteeing a different inode.
    await writeFile(other, "replaced\n", { encoding: "utf8", flag: "wx" }, rollback);
    await rm(leaf);
    await rename(other, leaf);
    rollback.track(leaf);
    rollback.untrack(other);
    assert.throws(() => ownership.cleanup(), Error, "cleanup fails visibly on a replaced leaf");
    assert.equal(await readFile(leaf, "utf8"), "replaced\n", "the replaced leaf survives (not deleted)");
  }, () => rollback.cleanup(), resolveRefusal);
});

test("runWithCleanup aggregates a body failure and a cleanup failure into one reportable error", async () => {
  const resolveRefusal = signalCleanupRefusal("aggregate-error fixture cleanup pending");
  const root = await realpath(await mkdtemp(join(fixtureBase, ".pi-native-host-ownboth-")));
  const ownership = new FixtureOwnership();
  ownership.track(root);
  const rollback = new FixtureOwnership();
  rollback.track(root);
  const unknown = join(root, "unknown.txt");
  await runWithCleanup(async () => {
    await writeFile(unknown, "x\n", { encoding: "utf8", flag: "wx" }, rollback);
    const bodyError = new assert.AssertionError({ message: "deliberate body failure" });
    await assert.rejects(
      runWithCleanup(async () => { throw bodyError; }, () => ownership.cleanup()),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], bodyError);
        assert.equal(error.cause, bodyError);
        assert.match(error.errors[1].message, /cleanup failed/);
        return true;
      },
    );
  }, () => rollback.cleanup(), resolveRefusal);
});

test("an unexpected assertion failure inside a strict probe still rolls back and removes the root", async () => {
  const reason = "native-host strict-probe rollback pending";
  const resolveRefusal = signalCleanupRefusal(reason);
  const root = await realpath(await mkdtemp(join(fixtureBase, ".pi-native-host-strict-probe-")));
  const rollback = new FixtureOwnership();
  rollback.track(root);
  const probeEntry = join(root, "probe-entry.txt");
  const failure = new assert.AssertionError({ message: "deliberate strict-probe assertion failure" });
  await assert.rejects(
    runWithCleanup(async () => {
      await writeFile(probeEntry, "synthetic probe\n", { encoding: "utf8", flag: "wx" }, rollback);
      throw failure;
    }, () => rollback.cleanup(), resolveRefusal),
    (error: unknown) => error === failure,
  );
  assert.equal(existsSync(root), false, "successful rollback removes the root after an assertion failure");
  if (process.env.PI_TEST_SCRATCH_ROOT) {
    assert.equal(await hasFixtureRefusal(process.env.PI_TEST_SCRATCH_ROOT, reason), false,
      "the rollback clears its pre-registered refusal");
  }
});

test("owned fixture cleanup refuses to rmdir through a renamed-and-symlinked ancestor", async () => {
  const resolveRollbackRefusal = signalCleanupRefusal("native-host symlinked-ancestor rollback pending");
  const root = await realpath(await mkdtemp(join(fixtureBase, ".pi-native-host-ownanc-")));
  const rollback = new FixtureOwnership();
  rollback.track(root); // record immediately so a setup failure still has the root receipt
  await runWithCleanup(async () => {
    const ownership = new FixtureOwnership();
    ownership.track(root);
    const child = join(root, "child");
    await mkdir(child);
    ownership.track(child);
    rollback.track(child);
    // Rename the root away and replace it with a symlink to the moved root.
    const moved = `${root}-moved`;
    await rename(root, moved);
    rollback.untrack(root);
    rollback.untrack(child);
    rollback.track(moved);
    rollback.track(join(moved, "child"));
    await fsSymlink(moved, root); // deliberate interloper at the displaced fixture root
    rollback.track(root); // the replacement symlink (rollback only)
    assert.throws(() => ownership.cleanup(), Error, "cleanup fails visibly when an ancestor is replaced by a symlink");
    assert.equal(existsSync(join(root, "child")), true, "the tracked child is not removed through the symlinked ancestor");
  }, () => rollback.cleanup(), resolveRollbackRefusal);
});

test("entries created before a failed write or copy are invocation-owned in both teardown modes", async (t) => {
  const root = await makeFixtureRoot("pi-native-host-partial", "native-host partial write/copy fixture");
  const preserve = fixturePreservationRequested();
  let detached: FixtureLease | undefined;
  t.after(() => {
    if (detached === undefined) return;
    if (lstatSync(detached.root, { bigint: true, throwIfNoEntry: false }) === undefined) return;
    try {
      cleanupFixtureLease(detached, false, t);
    } catch {
      // The test already failed; the refusal and its evidence stay in place.
    }
  });
  // A fresh file whose payload write fails after the entry itself exists.
  const partial = join(root, "partial.txt");
  const registered = fixtureLeases[fixtureLeases.length - 1]!;
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let pushed = false;
  const stream = new Readable({
    read(): void {
      if (!pushed) {
        pushed = true;
        this.push("first chunk\n");
        return;
      }
      void writeGate.then(() => { this.destroy(new Error("injected payload failure")); });
    },
  });
  let writeSettled = false;
  const pendingWrite = writeFile(partial, stream, { encoding: "utf8", flag: "wx" });
  const settledFlag = pendingWrite.then(() => { writeSettled = true; }, () => { writeSettled = true; });
  // Poll for the RECEIPT, not the pathname: the gate is still closed, so a receipt that lands
  // now can only have come from the open descriptor, before the payload completed. A failing
  // check still releases the gate and awaits the write, so nothing stays in flight.
  try {
    const deadline = Date.now() + 10_000;
    while (!registered.ownership.has(partial)) {
      assert.ok(Date.now() < deadline, "the payload write never receipted its entry");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(writeSettled, false, "the fresh entry is receipted while its payload write is still in flight");
  } finally {
    releaseWrite();
    await settledFlag;
  }
  await assert.rejects(() => pendingWrite, /injected payload failure/);
  assert.equal(existsSync(partial), true, "the write created the entry before its payload failed");

  // A recursive copy that fails after creating some destination entries.
  const source = join(root, "copy-source");
  await mkdir(join(source, "nested"), { recursive: true });
  await writeFile(join(source, "first.txt"), "first\n", "utf8");
  await writeFile(join(source, "nested", "second.txt"), "second\n", "utf8");
  await writeFile(join(source, "third.txt"), "third\n", "utf8");
  const destination = join(root, "copy-destination");
  let walked = 0;
  await assert.rejects(
    () => cp(source, destination, {
      recursive: true,
      filter: () => {
        walked += 1;
        if (walked >= 3) throw new Error("injected copy failure");
        return true;
      },
    }),
    /injected copy failure/,
  );
  assert.ok(walked >= 3 && existsSync(destination), "the copy created destination entries before failing");

  // Detach only now: every entry above was created while the lease was registered, so each
  // received its receipt. The explicit teardown below is the behavior under test.
  const lease = fixtureLeases.pop()!;
  detached = lease;
  const diagnostics: string[] = [];
  if (preserve) {
    cleanupFixtureLease(lease, true, { diagnostic: (message) => diagnostics.push(message) });
    assert.equal(existsSync(root), true, "explicit preservation retains the partial artifacts");
    assert.ok(diagnostics.some((line) => line.includes(root) && line.includes("PI_TEST_SCRATCH_PRESERVE=1")),
      "the exact retained partial-artifact location is reported");
    cleanupFixtureLease(lease, false, t);
    assert.equal(existsSync(root), false, "the test-owned preserved root is removed after the assertion");
  } else {
    cleanupFixtureLease(lease, false, t);
    assert.equal(existsSync(root), false, "default teardown removes the entries a failed write and copy created");
  }
});

test("a successful copy still refuses a sibling its own filter created, and receipt-checked rollback removes it", async (t) => {
  const root = await makeFixtureRoot("pi-native-host-copy-sibling", "native-host copy sibling fixture");
  let lease: FixtureLease | undefined;
  let rolledBack = false;
  t.after(() => {
    if (rolledBack || lstatSync(root, { bigint: true, throwIfNoEntry: false }) === undefined) return;
    if (lease === undefined) return; // the ordinary lease finalizer still owns this fixture
    try {
      cleanupFixtureLease(lease, false, t);
    } catch {
      // The test already failed; the refusal and its evidence stay in place.
    }
  });
  const source = join(root, "copy-source");
  await mkdir(source);
  await writeFile(join(source, "first.txt"), "first\n", "utf8");
  const destination = join(root, "copy-destination");
  const injected = join(destination, "written-by-filter.txt");
  // The injector records the identity it created, so the probe can roll the entry back by
  // receipt instead of adoption.
  let injectedReceipt: import("node:fs").BigIntStats | undefined;
  await cp(source, destination, {
    recursive: true,
    filter: (src) => {
      if (basename(src) === "first.txt") {
        fsWriteFileSync(injected, "written by the copy filter\n", { encoding: "utf8", flag: "wx" });
        injectedReceipt = lstatSync(injected, { bigint: true }) as import("node:fs").BigIntStats;
      }
      return true;
    },
  });
  assert.ok(injectedReceipt !== undefined, "the filter created its sibling during a successful copy");
  assert.equal(await readFile(join(destination, "first.txt"), "utf8"), "first\n", "the copy itself completed");
  // Detach only now: the copy receipts its entries while the lease is registered.
  lease = fixtureLeases.pop()!;
  const owned = lease;
  const diagnostics: string[] = [];
  assert.throws(
    () => cleanupFixtureLease(owned, false, { diagnostic: (message) => diagnostics.push(message) }),
    /fixture ownership verification failed/,
    "the copy receipts no entry it did not create",
  );
  assert.equal(existsSync(root), true, "the filter-created sibling is retained as unexplained");
  assert.ok(diagnostics.some((line) => line.includes(root)), "the retained location is reported");
  owned.ownership.track(injected, injectedReceipt);
  cleanupFixtureLease(owned, false, t);
  rolledBack = true;
  assert.equal(existsSync(root), false, "rollback with the injector's receipt removes the copy fixture");
});

test("native fixture construction failures finalize through the real lease in both teardown modes", async (t) => {
  const preserve = fixturePreservationRequested();
  const prefix = "pi-native-host-constructed";
  const refusalReason = `native package fixture ${prefix} cleanup pending`;
  let partialRoot = "";
  await assert.rejects(
    makePackageFixture(prefix, undefined, async (root) => {
      partialRoot = root;
      await writeFile(join(root, "partial.txt"), "partial setup\n", { encoding: "utf8", flag: "wx" });
      throw new Error("injected native fixture construction failure");
    }),
    /injected native fixture construction failure/,
  );
  const leaseIndex = fixtureLeases.findIndex((lease) => lease.root === partialRoot);
  assert.ok(leaseIndex >= 0, "the failed constructor left its own lease registered");
  const lease = fixtureLeases.splice(leaseIndex, 1)[0]!;
  t.after(() => {
    if (!lstatSync(lease.root, { throwIfNoEntry: false })) return;
    cleanupFixtureLease(lease, false, t);
  });
  const diagnostics: string[] = [];
  if (preserve) {
    cleanupFixtureLease(lease, true, { diagnostic: (message) => diagnostics.push(message) });
    assert.equal(existsSync(partialRoot), true, "explicit preservation retains the partial construction");
    assert.ok(diagnostics.some((line) => line.includes(partialRoot)),
      "the exact retained partial-construction location is reported");
    cleanupFixtureLease(lease, false, t);
    assert.equal(existsSync(partialRoot), false, "the test-owned preserved root is removed after the assertion");
  } else {
    cleanupFixtureLease(lease, false, t);
    assert.equal(existsSync(partialRoot), false, "default cleanup removes the partial construction");
    if (process.env.PI_TEST_SCRATCH_ROOT) {
      assert.equal(await hasFixtureRefusal(process.env.PI_TEST_SCRATCH_ROOT, refusalReason), false,
        "the default finalizer resolves its refusal");
    }
  }
});

test("native fixture leases refuse unexplained content and retain evidence", async (t) => {
  const reason = "native-host unexplained fixture cleanup pending";
  const root = await makeFixtureRoot("pi-native-host-unexplained", "native-host unexplained fixture");
  const rollback = new FixtureOwnership();
  rollback.track(root);
  // The lease stays registered for every probe mutation, so each one runs through the real
  // fixture helpers. Only after the behavior under test is exercised is it detached.
  let detached: FixtureLease | undefined;
  t.after(() => {
    if (detached === undefined) return; // the ordinary lease finalizer still owns this fixture
    rollback.cleanup();
    detached.resolveRefusal();
  });
  const unknown = join(root, "unexpected.txt");
  fsWriteFileSync(unknown, "not receipted\n", { encoding: "utf8", flag: "wx" });
  rollback.track(unknown);
  // An exclusive write through the fixture helper refuses to adopt or overwrite the
  // unexplained entry it did not create.
  await assert.rejects(() => writeFile(unknown, "must not overwrite\n", { flag: "wx" }), { code: "EEXIST" });
  // A recursive mkdir cannot adopt an unexplained directory as its own creation.
  const unownedDir = join(root, "unowned-dir");
  await fsMkdir(unownedDir);
  rollback.track(unownedDir);
  await assert.rejects(() => mkdir(join(unownedDir, "nested"), { recursive: true }), /not an owned fixture directory/);
  await assert.rejects(() => symlink("target.txt", join(unownedDir, "link.txt")), /symlink parent is not an owned fixture directory/);
  assert.equal(existsSync(join(unownedDir, "link.txt")), false, "no link is written under an unowned parent");
  // A rename verifies its source instead of inventorying its destination: an unexplained
  // descendant travels with the directory and is still refused, never newly receipted.
  const moving = join(root, "moving");
  await mkdir(moving);
  rollback.track(moving);
  const unknownChild = join(moving, "unknown.txt");
  await writeFile(unknownChild, "not receipted by the lease\n", { flag: "wx" }, rollback);
  await assert.rejects(() => rename(moving, join(root, "moved")), /fixture ownership verification failed/);
  assert.equal(await readFile(unknownChild, "utf8"), "not receipted by the lease\n", "the unexplained descendant is never deleted");
  const lease = fixtureLeases.pop()!;
  detached = lease;
  const diagnostics: string[] = [];
  assert.throws(
    () => cleanupFixtureLease(lease, fixturePreservationRequested(), { diagnostic: (message) => diagnostics.push(message) }),
    /fixture ownership verification failed/,
  );
  assert.equal(existsSync(root), true, "the root with unexplained content is retained");
  assert.equal(await readFile(unknown, "utf8"), "not receipted\n", "the unexplained entry is never deleted");
  assert.ok(diagnostics.some((line) => line.includes(root)), "the retained root is reported");
  if (process.env.PI_TEST_SCRATCH_ROOT) {
    assert.equal(await hasFixtureRefusal(process.env.PI_TEST_SCRATCH_ROOT, reason), true,
      "the refusal remains unresolved while the evidence is retained");
  }
  rollback.cleanup();
  lease.resolveRefusal();
  assert.equal(existsSync(root), false, "receipt-checked rollback removes the probe root");
  if (process.env.PI_TEST_SCRATCH_ROOT) {
    assert.equal(await hasFixtureRefusal(process.env.PI_TEST_SCRATCH_ROOT, reason), false,
      "confirmed rollback resolves the refusal");
  }
});

test("an assertion failure with confirmed cleanup removes the strict fixture root", async () => {
  const reason = "native-host assertion-failure cleanup pending";
  const resolveRefusal = signalCleanupRefusal(reason);
  const root = await realpath(await mkdtemp(join(fixtureBase, ".pi-native-host-cleanup-assert-")));
  const ownership = new FixtureOwnership();
  ownership.track(root);
  const assertion = new assert.AssertionError({ message: "deliberate assertion failure" });
  await assert.rejects(
    runWithCleanup(async () => { throw assertion; }, () => ownership.cleanup(), resolveRefusal),
    (error: unknown) => error === assertion,
  );
  assert.equal(existsSync(root), false, "confirmed cleanup removes the root after an assertion failure");
  if (process.env.PI_TEST_SCRATCH_ROOT) {
    assert.equal(await hasFixtureRefusal(process.env.PI_TEST_SCRATCH_ROOT, reason), false,
      "this fixture's refusal is cleared after confirmed cleanup");
  }
});

test("an unconfirmed strict cleanup refusal survives an assertion failure", async () => {
  const reason = "native-host assertion-failure unsafe cleanup pending";
  const resolveRefusal = signalCleanupRefusal(reason);
  const root = await realpath(await mkdtemp(join(fixtureBase, ".pi-native-host-cleanup-refuse-")));
  const ownership = new FixtureOwnership();
  ownership.track(root);
  await writeFile(join(root, "unknown.txt"), "not mine\n", "utf8");
  try {
    await assert.rejects(
      runWithCleanup(
        async () => { throw new assert.AssertionError({ message: "deliberate assertion failure" }); },
        () => ownership.cleanup(),
        resolveRefusal,
      ),
      (error: unknown) => error instanceof AggregateError,
    );
    assert.equal(existsSync(join(root, "unknown.txt")), true, "unknown content is retained");
    if (process.env.PI_TEST_SCRATCH_ROOT) {
      assert.equal(await hasFixtureRefusal(process.env.PI_TEST_SCRATCH_ROOT, reason), true,
        "the unresolved refusal survives for the runner");
    }
  } finally {
    unlinkSync(join(root, "unknown.txt"));
    rmdirSync(root);
    resolveRefusal();
  }
});

test("saved selection is bound to its admitted workspace: mismatched and retargeted workspaces refuse before spawn", async (t) => {
  const pkg = await makePackageFixture();
  const { admission } = await admitFixtureSavedSession(pkg);

  // A receipt for workspace A never launches in workspace B.
  const otherWorkspace = join(pkg.root, "other-workspace");
  await mkdir(otherWorkspace, { recursive: true });
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), workspace: otherWorkspace, savedSession: admission })),
    /different workspace than this launch/,
  );

  // The admitted workspace retargeted to a different directory (symlink
  // swap) no longer resolves to the canonical workspace bound at admission.
  const target = join(pkg.root, "workspace-target");
  await mkdir(target, { recursive: true });
  await rm(pkg.workspace, { recursive: true });
  await symlink(target, pkg.workspace);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
    /changed since admission/,
  );
});

test("launch revalidates the sessions path structure: a project directory swapped for a symlink refuses before spawn", async (t) => {
  const pkg = await makePackageFixture();
  const { admission } = await admitFixtureSavedSession(pkg);

  // Move the project directory outside the sessions root and replace it with
  // a symlink: the file's inode and header identity are preserved, but the
  // canonical location now escapes the native sessions root.
  const projDir = join(pkg.agentDir, "sessions", "proj");
  const moved = join(pkg.root, "moved-proj");
  await rename(projDir, moved);
  await symlink(moved, projDir);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
    /outside the native agent sessions root/,
  );
});

test("the startup options helper resolves only the own compiled package scripts (no ancestor fallback)", async (t) => {
  const compiledLaunch = join(process.cwd(), "dist-test", "src", "session-host", "launch.js");
  const compiledConfigPath = join(process.cwd(), "dist-test", "src", "config-path.js");
  const compiledRecordGuard = join(process.cwd(), "dist-test", "src", "record-guard.js");
  const compiledSavedSessions = join(process.cwd(), "dist-test", "src", "session-host", "saved-sessions.js");
  const compiledSavedSearch = join(process.cwd(), "dist-test", "src", "session-host", "saved-search.js");
  const compiledNativeSessionSdk = join(process.cwd(), "dist-test", "src", "session-host", "native-session-sdk.js");
  const compiledStartupRequest = join(process.cwd(), "dist-test", "src", "session-host", "startup-request.js");
  const compiledPayload = join(process.cwd(), "dist-test", "src", "session-host", "payload.js");
  const compiledProtocol = join(process.cwd(), "dist-test", "src", "session-host", "protocol.js");
  const compiledNativeHookProtocol = join(process.cwd(), "dist-test", "src", "session-host", "native-hook-protocol.js");
  const compiledNativeReviewHookProtocol = join(process.cwd(), "dist-test", "src", "session-host", "native-review-hook-protocol.js");
  // The review protocol module's OWN compiled dependencies, so the fixture tree is
  // complete rather than accidentally reaching outside itself.
  const compiledNativeMcpProtocol = join(process.cwd(), "dist-test", "src", "session-host", "native-mcp-protocol.js");
  const compiledNativeMcpStdio = join(process.cwd(), "dist-test", "src", "session-host", "native-mcp-stdio.js");
  const compiledJsonl = join(process.cwd(), "dist-test", "src", "jsonl.js");
  const compiledSessionBackend = join(process.cwd(), "dist-test", "src", "session-host", "session-backend.js");
  const compiledPeerDestinationId = join(process.cwd(), "dist-test", "src", "session-host", "peer-destination-id.js");
  const compiledPeerLabelContract = join(process.cwd(), "dist-test", "src", "session-host", "network", "protocol.js");
  assert.ok(existsSync(compiledLaunch), "the compiled launch module under test must exist");
  assert.ok(existsSync(compiledConfigPath), "the compiled native config-path helper must exist");
  assert.ok(existsSync(compiledRecordGuard), "the compiled record guard must exist");
  assert.ok(existsSync(compiledSavedSessions), "the compiled saved-session catalog module must exist");
  assert.ok(existsSync(compiledSavedSearch), "the compiled shared saved-session search module must exist");
  assert.ok(existsSync(compiledNativeSessionSdk), "the compiled public SDK loader module must exist");
  assert.ok(existsSync(compiledStartupRequest), "the compiled startup-request module must exist");
  assert.ok(existsSync(compiledPayload), "the compiled startup payload transport must exist");
  assert.ok(existsSync(compiledProtocol), "the compiled session-host protocol module must exist");
  assert.ok(existsSync(compiledNativeHookProtocol), "the compiled native hook protocol module must exist");
  assert.ok(existsSync(compiledNativeReviewHookProtocol), "the compiled native review hook protocol module must exist");
  assert.ok(existsSync(compiledNativeMcpProtocol), "the compiled native MCP protocol module must exist");
  assert.ok(existsSync(compiledNativeMcpStdio), "the compiled native MCP stdio module must exist");
  assert.ok(existsSync(compiledJsonl), "the compiled JSONL module must exist");
  assert.ok(existsSync(compiledSessionBackend), "the compiled session backend identity module must exist");
  assert.ok(existsSync(compiledPeerDestinationId), "the compiled saved destination id contract module must exist");
  assert.ok(existsSync(compiledPeerLabelContract), "the compiled saved destination label contract module must exist");

  // Tree A: the own package scripts/ is missing, but a MALICIOUS ancestor
  // scripts/ helper exists. The loader must reject fail-closed without ever
  // loading it (no profile/skills work runs before the helper gate).
  const rootA = await makeFixtureRoot("pi-native-host-anchor-a", "native-host anchor-a");
  const markerA = join(rootA, "parent-helper-loaded");
  const pkgA = join(rootA, "node_modules", "pi-review-gate");
  const distA = join(pkgA, "dist", "src", "session-host");
  await mkdir(distA, { recursive: true });
  // Disposable resolution shim: the copied compiled modules resolve their real
  // runtime dependency from the fixture itself instead of an ancestor checkout.
  await symlink(join(process.cwd(), "node_modules", "pi-session-host-tui"), join(rootA, "node_modules", "pi-session-host-tui"));
  await cp(compiledLaunch, join(distA, "launch.js"));
  await cp(compiledSavedSessions, join(distA, "saved-sessions.js"));
  await cp(compiledSavedSearch, join(distA, "saved-search.js"));
  await cp(compiledNativeSessionSdk, join(distA, "native-session-sdk.js"));
  await cp(compiledStartupRequest, join(distA, "startup-request.js"));
  await cp(compiledPayload, join(distA, "payload.js"));
  await cp(compiledProtocol, join(distA, "protocol.js"));
  await cp(compiledNativeHookProtocol, join(distA, "native-hook-protocol.js"));
  await cp(compiledNativeReviewHookProtocol, join(distA, "native-review-hook-protocol.js"));
  await cp(compiledNativeMcpProtocol, join(distA, "native-mcp-protocol.js"));
  await cp(compiledNativeMcpStdio, join(distA, "native-mcp-stdio.js"));
  await cp(compiledJsonl, join(pkgA, "dist", "src", "jsonl.js"));
  await cp(compiledSessionBackend, join(distA, "session-backend.js"));
  await cp(compiledPeerDestinationId, join(distA, "peer-destination-id.js"));
  await mkdir(join(distA, "network"), { recursive: true });
  await cp(compiledPeerLabelContract, join(distA, "network", "protocol.js"));
  await cp(compiledConfigPath, join(pkgA, "dist", "src", "config-path.js"));
  await cp(compiledRecordGuard, join(pkgA, "dist", "src", "record-guard.js"));
  await mkdir(join(rootA, "scripts"), { recursive: true });
  await writeFile(
    join(rootA, "scripts", "session-host-startup-options.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(markerA)}, "loaded");\nmodule.exports = { assertSessionHostStartupOptions: () => undefined };\n`,
    "utf8",
  );
  const launchA = require(join(distA, "launch.js")) as CompiledLaunchModule;
  assert.throws(
    () => launchA.prepareNativeLaunch({ packageRoot: pkgA, agentDir: join(pkgA, "missing-agent-dir"), workspace: join(pkgA, "missing-workspace"), piExecutable: join(pkgA, "missing-bin", "pi"), args: [] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Bounded diagnostic: fixed filename only, never the fixture path.
      return message.includes("session-host-startup-options.cjs") && !message.includes(rootA);
    },
  );
  assert.equal(existsSync(markerA), false, "an ancestor scripts/ helper is never loaded");

  // Tree B: the own scripts/ is present -> the helper loads and admission runs.
  const rootB = await makeFixtureRoot("pi-native-host-anchor-b", "native-host anchor-b");
  const pkgB = join(rootB, "node_modules", "pi-review-gate");
  const distB = join(pkgB, "dist", "src", "session-host");
  await mkdir(distB, { recursive: true });
  // Same disposable resolution shim as tree A.
  await symlink(join(process.cwd(), "node_modules", "pi-session-host-tui"), join(rootB, "node_modules", "pi-session-host-tui"));
  await cp(compiledLaunch, join(distB, "launch.js"));
  await cp(compiledSavedSessions, join(distB, "saved-sessions.js"));
  await cp(compiledSavedSearch, join(distB, "saved-search.js"));
  await cp(compiledNativeSessionSdk, join(distB, "native-session-sdk.js"));
  await cp(compiledStartupRequest, join(distB, "startup-request.js"));
  await cp(compiledPayload, join(distB, "payload.js"));
  await cp(compiledProtocol, join(distB, "protocol.js"));
  await cp(compiledNativeHookProtocol, join(distB, "native-hook-protocol.js"));
  await cp(compiledNativeReviewHookProtocol, join(distB, "native-review-hook-protocol.js"));
  await cp(compiledNativeMcpProtocol, join(distB, "native-mcp-protocol.js"));
  await cp(compiledNativeMcpStdio, join(distB, "native-mcp-stdio.js"));
  await cp(compiledJsonl, join(pkgB, "dist", "src", "jsonl.js"));
  await cp(compiledSessionBackend, join(distB, "session-backend.js"));
  await cp(compiledPeerDestinationId, join(distB, "peer-destination-id.js"));
  await mkdir(join(distB, "network"), { recursive: true });
  await cp(compiledPeerLabelContract, join(distB, "network", "protocol.js"));
  await cp(compiledConfigPath, join(pkgB, "dist", "src", "config-path.js"));
  await cp(compiledRecordGuard, join(pkgB, "dist", "src", "record-guard.js"));
  await mkdir(join(pkgB, "scripts"), { recursive: true });
  await cp(join(process.cwd(), "scripts", "session-host-startup-options.cjs"), join(pkgB, "scripts", "session-host-startup-options.cjs"));
  const launchB = require(join(distB, "launch.js")) as CompiledLaunchModule;
  assert.throws(
    () => launchB.prepareNativeLaunch({ packageRoot: pkgB, agentDir: join(pkgB, "missing-agent-dir"), workspace: join(pkgB, "missing-workspace"), piExecutable: join(pkgB, "missing-bin", "pi"), args: ["--session", "/tmp/old.jsonl"] }),
    /startup override is not accepted: --session/,
  );
});

test("the native input-framing opt-in supplies the static capture flag to its own launch only", async (t) => {
  const pkg = await makePackageFixture();
  const nativeEnv: NodeJS.ProcessEnv = {
    HOME: join(pkg.root, "home"),
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: pkg.agentDir,
  };
  // A caller that already carries a value for the supported variable: the opt-in
  // replaces it in the launch descriptor it owns, and nowhere else.
  const callerEnv: NodeJS.ProcessEnv = { ...nativeEnv, PI_CLIPBOARD_OSC52: "caller-owned" };
  const callerSnapshot = JSON.stringify(callerEnv);
  const processValueBefore = process.env.PI_CLIPBOARD_OSC52;

  const framed = prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: callerEnv, nativeInputOriginFraming: true }));
  assert.equal(framed.env.PI_CLIPBOARD_OSC52, "1", "the opted-in native launch carries the supported static flag");
  assert.equal(JSON.stringify(callerEnv), callerSnapshot, "the caller's env object is never mutated");
  assert.equal(process.env.PI_CLIPBOARD_OSC52, processValueBefore, "the host process env is never mutated");

  const second = prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: callerEnv, nativeInputOriginFraming: true }));
  assert.equal(second.env.PI_CLIPBOARD_OSC52, "1");
  assert.notEqual(second.env, framed.env, "each launch composes its own environment copy");

  // Every path without the opt-in keeps the caller's value exactly as given.
  const ordinaryNative = prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: callerEnv }));
  assert.equal(ordinaryNative.env.PI_CLIPBOARD_OSC52, "caller-owned",
    "an ordinary native launch never gains the flag");
  const explicitFalse = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true, env: callerEnv, nativeInputOriginFraming: false,
  }));
  assert.equal(explicitFalse.env.PI_CLIPBOARD_OSC52, "caller-owned");
  const legacy = prepareNativeLaunch(baseOptions(pkg, { env: callerEnv }));
  assert.equal(legacy.env.PI_CLIPBOARD_OSC52, "caller-owned", "the legacy/private mode never gains the flag");
  const bareNative = prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeEnv }));
  assert.equal(Object.hasOwn(bareNative.env, "PI_CLIPBOARD_OSC52"), false,
    "a caller without the variable does not acquire it without the opt-in");
  const bareLegacy = prepareNativeLaunch(baseOptions(pkg, { env: nativeEnv }));
  assert.equal(Object.hasOwn(bareLegacy.env, "PI_CLIPBOARD_OSC52"), false);

  // The opt-in is closed: it requires the native setup and a real boolean.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: callerEnv, nativeInputOriginFraming: true })),
    /available only for native setup launches/,
    "the legacy/private mode cannot request input framing",
  );
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, {
      nativeSetup: true, env: callerEnv, nativeInputOriginFraming: "yes" as never,
    })),
    /must be a boolean or absent/,
    "a malformed opt-in is refused instead of guessing",
  );
});
