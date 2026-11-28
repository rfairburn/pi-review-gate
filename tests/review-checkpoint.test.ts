import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, linkSync } from "node:fs";
import { closeSync, constants as fsFlags, existsSync, fstatSync, lstatSync, mkdirSync as fsMkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync as fsRenameSync, rmdirSync, rmSync, symlinkSync as fsSymlinkSync, unlinkSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { chmod, lstat, mkdir as fsMkdir, mkdtemp, open as fsOpen, readFile, readlink, realpath, rename as fsRename, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { deflateSync, inflateSync } from "node:zlib";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { captureReviewCheckpoint as rawCaptureReviewCheckpoint, compareReviewCheckpoints as rawCompareReviewCheckpoints, loadReviewCheckpoint, rawReviewCheckpointRecordPath, releaseReviewCheckpoint as rawReleaseReviewCheckpoint, type ReviewCheckpointDescriptor, type ReviewCheckpointScope } from "../src/review-checkpoint";
import { checkpointRefForWindow, SCRATCH_SUBDIR } from "../src/checkpoint/record";
import { disposableFixtureBase } from "./helpers/scratch-fixture-base";

const exec = promisify(execFile);
// The helper is resolved from the COMPILED test (dist-test/tests -> package root), never
// from the caller's working directory, so an absolute-path invocation from outside the
// checkout loads this repository's helper instead of an unrelated one.
const { signalCleanupRefusal, REFUSAL_DIR } = require(resolve(__dirname, "../../scripts/test-scratch-refusal.cjs")) as {
  signalCleanupRefusal(reason?: string): () => void;
  REFUSAL_DIR: string;
};
/** Whether this fixture's own pre-registered refusal (matched by reason) is present. */
function hasFixtureRefusal(reason: string): boolean {
  const root = process.env.PI_TEST_SCRATCH_ROOT;
  if (root === undefined) return false;
  const directory = join(root, REFUSAL_DIR);
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory)) {
    try { if (readFileSync(join(directory, entry), "utf8") === `${reason}\n`) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return false;
}
// #301: raw records live in the session's external namespace under a
// disposable Pi agent-data directory outside every capture root. The checkout
// fixture root uses a validated external base (the test-scratch invocation
// root when present) so generated repositories never become capturable input.
const fixtureBase = disposableFixtureBase();
let scope: ReviewCheckpointScope | undefined;
const opts = () => ({ scope });

interface FixtureRoot {
  readonly path: string;
  readonly receipt: import("node:fs").BigIntStats;
}

const NO_BODY_ERROR = Symbol("no review-checkpoint body error");
const NO_CLEANUP_ERROR = Symbol("no review-checkpoint cleanup error");

// Per-entry receipts recorded when a fixture entry is created or intentionally
// replaced. Teardown never adopts a snapshot of whatever happens to be present.
class FixtureOwnership {
  private readonly entries = new Map<string, import("node:fs").BigIntStats>();

  track(path: string, receipt = lstatSync(path, { bigint: true })): void { this.entries.set(path, receipt); }
  has(path: string): boolean { return this.entries.has(path); }

  /** True when `current` is exactly the entry recorded for `path`. */
  matches(path: string, current: import("node:fs").BigIntStats): boolean {
    const expected = this.entries.get(path);
    return expected !== undefined && expected.dev === current.dev && expected.ino === current.ino
      && (expected.mode & 0o170000n) === (current.mode & 0o170000n);
  }

  trackWithRoot(root: string, path: string): void {
    const rootPath = root;
    if (path !== root) assertInside(root, path);
    if (lstatSync(path, { bigint: true, throwIfNoEntry: false }) !== undefined) this.track(path);
    const created: string[] = [];
    if (path !== rootPath) {
      for (let current = dirname(path); current !== rootPath; current = dirname(current)) {
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

  untrackTree(path: string): void {
    for (const entry of [...this.entries.keys()]) {
      if (entry === path || entry.startsWith(`${path}${sep}`)) this.entries.delete(entry);
    }
  }

  /** Transfer the receipts held for a moved subtree; nothing new is adopted. */
  moveTree(from: string, to: string): void {
    for (const [path, receipt] of [...this.entries]) {
      if (path !== from && !path.startsWith(`${from}${sep}`)) continue;
      this.entries.delete(path);
      this.entries.set(join(to, relative(from, path)), receipt);
    }
  }

  verify(subtree?: string): void {
    const failures: unknown[] = [];
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
      if (subtree !== undefined && path !== subtree && !path.startsWith(`${subtree}${sep}`)) continue;
      try {
        let parentMissing = false;
        for (let parent = dirname(path); this.entries.has(parent); parent = dirname(parent)) {
          const currentParent = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
          if (currentParent === undefined) { parentMissing = true; break; }
          verify(parent, this.entries.get(parent)!);
        }
        if (parentMissing) continue; // an entry the test intentionally removed with its subtree
        const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (current === undefined) continue;
        verify(path, entry);
        if (current.isDirectory() && !current.isSymbolicLink()) {
          const expected = expectedChildren.get(path) ?? new Set<string>();
          const unexpected = readdirSync(path).filter((name) => !expected.has(name));
          assert.deepEqual(unexpected, [], `unexpected contents in retained fixture directory: ${path}: ${unexpected.join(", ")}`);
        }
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "fixture ownership verification failed");
  }

  cleanup(subtree?: string): void {
    const failures: unknown[] = [];
    const verify = (path: string, expected: import("node:fs").BigIntStats) => {
      const current = lstatSync(path, { bigint: true });
      assert.ok(current.dev === expected.dev && current.ino === expected.ino &&
        (current.mode & 0o170000n) === (expected.mode & 0o170000n), `changed fixture entry preserved: ${path}`);
    };
    for (const [path, entry] of [...this.entries].sort(([a], [b]) => b.length - a.length)) {
      if (subtree !== undefined && path !== subtree && !path.startsWith(`${subtree}${sep}`)) continue;
      try {
        try { verify(path, entry); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for (let parent = dirname(path); this.entries.has(parent); parent = dirname(parent)) {
          verify(parent, this.entries.get(parent)!);
        }
        if (entry.isDirectory()) rmdirSync(path); // unknown contents remain and cause ENOTEMPTY
        else unlinkSync(path); // never follow a symlink target
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "fixture ownership cleanup failed");
  }
}

interface CheckpointScopeEntry {
  readonly root: string;
  readonly ownership: FixtureOwnership;
}

const checkpointScopes: CheckpointScopeEntry[] = [];

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
  throw new Error(`fixture entry is outside its owned root: ${path}`);
}

function checkpointScopeForPath(path: string): CheckpointScopeEntry | undefined {
  return [...checkpointScopes].reverse().find((entry) => {
    const rel = relative(entry.root, path);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}

/**
 * `git init --template=` creates a known set of outputs. Receipt exactly those, parent
 * first: a recursive enrollment would adopt whatever an unrelated writer placed under
 * `.git` while the subprocess was running.
 */
function receiptGitInit(gitDir: string): void {
  const owner = checkpointScopeForPath(gitDir)?.ownership;
  if (!owner) return;
  const dirs = ['', 'objects', 'objects/info', 'objects/pack', 'refs', 'refs/heads', 'refs/tags'];
  for (const name of [...dirs, 'HEAD', 'config']) {
    const path = join(gitDir, name);
    const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!current) continue;
    const parent = dirname(path);
    const directory = lstatSync(parent, { bigint: true });
    assert.ok(directory.isDirectory() && owner.matches(parent, directory) && realpathSync(parent) === parent,
      `Git init output parent is not owned: ${parent}`);
    assert.ok(dirs.includes(name) ? current.isDirectory() : current.isFile(),
      `unexpected Git init output type: ${path}`);
    owner.track(path, current);
  }
}

function checkpointOutput(path: string, replace = false): void {
  const entry = checkpointScopeForPath(path);
  if (entry && (replace || !entry.ownership.has(path))) entry.ownership.trackWithRoot(entry.root, path);
}

/** Only an exclusive create can make a file invocation-owned at its open. */
function isExclusiveCreateOpen(flags: unknown): boolean {
  if (typeof flags === "string") return flags.includes("x") && (flags.includes("w") || flags.includes("a"));
  if (typeof flags === "number") return (flags & fsFlags.O_CREAT) !== 0 && (flags & fsFlags.O_EXCL) !== 0;
  return false;
}

/**
 * Paths that did not exist before a create. Tracking only these after the call
 * attributes exactly the levels that call made, never an unrelated ancestor that
 * happened to be present at a planned path.
 */
function assertCheckpointDirectory(path: string, owner: FixtureOwnership): void {
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  assert.ok(current?.isDirectory() && owner.matches(path, current) && realpathSync(path) === path,
    `not an owned fixture directory: ${path}`);
}

function assertCheckpointRemovalTarget(path: string, entry: CheckpointScopeEntry): void {
  assertCheckpointDirectory(dirname(path), entry.ownership);
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (current === undefined) return;
  assert.ok(entry.ownership.matches(path, current), `refusing to remove a replaced checkpoint entry: ${path}`);
}

/** Test seam: one shot immediately after removal verification reads the target subtree. */
let afterCheckpointRemovalVerification: ((path: string) => void) | undefined;
/** Test seam: after a successful update-ref deletion, before any attribution runs. */
let afterGitUpdateRefDeletion: ((gitDir: string, args: readonly string[]) => void | Promise<void>) | undefined;

function assertCheckpointRemoval(path: string): void {
  const entry = checkpointScopeForPath(path);
  if (entry === undefined) return;
  assertCheckpointRemovalTarget(path, entry);
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (current === undefined) return;
  entry.ownership.verify(path);
  afterCheckpointRemovalVerification?.(path);
}

function receiptCreatedEntries(paths: Iterable<string>): void {
  for (const path of paths) {
    const entry = checkpointScopeForPath(path);
    if (entry === undefined) continue;
    const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (current !== undefined) entry.ownership.track(path, current);
  }
}

function receiptCreatedPath(path: string, receipt?: import("node:fs").BigIntStats): void {
  const entry = checkpointScopeForPath(path);
  if (entry === undefined) return;
  const current = receipt ?? lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (current !== undefined) entry.ownership.track(path, current);
}

function receiptGitUpdateRef(gitDir: string, args: readonly string[], out: { code: number }): void {
  if (out.code !== 0 || args[0] !== "update-ref" || args.includes("-d")) return;
  const ref = args.slice(1).find((arg) => arg.startsWith("refs/"));
  if (ref === undefined) return;
  receiptCreatedPath(join(gitDir, ref));
  receiptCreatedPath(join(gitDir, "logs", ref));
}

function fixtureGitDir(path: string): string | undefined {
  const entry = checkpointScopeForPath(path);
  if (!entry) return undefined;
  for (let directory = path; ; directory = dirname(directory)) {
    const candidate = join(directory, ".git");
    const current = lstatSync(candidate, { throwIfNoEntry: false });
    if (current) return current.isDirectory() ? candidate : undefined;
    if (directory === entry.root) return undefined;
  }
}

/**
 * A loose object's bytes must hash to its own name for the object to be a real Git object
 * at all — a necessary check, but never proof of provenance: attribution comes from the
 * writer that reported the id (see `receiptObjectIds`).
 */
function isAuthenticLooseObject(path: string, objectId: string): boolean {
  try {
    return createHash(objectId.length === 64 ? "sha256" : "sha1")
      .update(inflateSync(readFileSync(path))).digest("hex") === objectId;
  } catch {
    return false; // unreadable, not zlib-compressed, or a hash mismatch: not a real object
  }
}

const gitRunner = require("../src/checkpoint/run-git") as {
  runGit: typeof import("../src/checkpoint/run-git").runGit;
  runGitWithInput: typeof import("../src/checkpoint/run-git").runGitWithInput;
};
/** The unpatched runner, so read-only attribution queries cannot recursively receipt. */
const queryGit = gitRunner.runGit;
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Receipt only the object ids a specific command reported or listed: an unrelated valid
 * object that merely appeared in the object store stays unowned and is retained.
 */
function receiptObjectIds(gitDir: string, ids: Iterable<string>): void {
  const objects = join(gitDir, "objects");
  const owner = checkpointScopeForPath(objects)?.ownership;
  if (!owner) return;
  const parent = lstatSync(objects, { bigint: true, throwIfNoEntry: false });
  assert.ok(parent?.isDirectory() && owner.matches(objects, parent) && realpathSync(objects) === objects);
  for (const id of new Set(ids)) {
    assert.match(id, objectIdPattern);
    const bucket = join(objects, id.slice(0, 2));
    const path = join(bucket, id.slice(2));
    if (owner.has(path)) continue;
    const directory = lstatSync(bucket, { bigint: true, throwIfNoEntry: false });
    if (!directory?.isDirectory() || realpathSync(bucket) !== bucket) continue;
    if (owner.has(bucket) && !owner.matches(bucket, directory)) continue;
    const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!entry?.isFile() || !isAuthenticLooseObject(path, id)) continue;
    if (!owner.has(bucket)) owner.track(bucket, directory);
    owner.track(path, entry);
  }
}

async function gitOutput(cwd: string, args: string[], index?: string): Promise<string> {
  const out = await queryGit("git", cwd, args, {
    timeoutMs: 10_000, maxBytes: 1024 * 1024,
    extraEnv: index === undefined ? undefined : { GIT_INDEX_FILE: index },
  });
  assert.equal(out.code, 0, out.stderr);
  return out.stdout.toString("utf8");
}

async function receiptTree(gitDir: string, cwd: string, tree: string): Promise<void> {
  assert.match(tree, objectIdPattern);
  const entries = await gitOutput(cwd, ["ls-tree", "-r", "-t", "-z", tree]);
  receiptObjectIds(gitDir, [tree, ...[...entries.matchAll(/(?:^|\x00)\d+ \w+ ([0-9a-f]+)\t/g)].map((row) => row[1]!)]);
}

async function receiptIndex(gitDir: string, cwd: string, index: string): Promise<void> {
  if (!existsSync(index)) return;
  const entries = await gitOutput(cwd, ["ls-files", "--stage", "-z"], index);
  receiptObjectIds(gitDir, [...entries.matchAll(/(?:^|\x00)\d+ ([0-9a-f]+) [0-3]\t/g)].map((row) => row[1]!));
}

/**
 * Attribute filesystem and Git writes to the exact operation that produced
 * them. A planned path is never adopted merely because it exists when a
 * capture finishes or fails.
 */
async function withCheckpointReceipts<T>(gitDir: string | undefined, run: () => Promise<T>): Promise<T> {
  const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  const originalMkdir = fsPromises.mkdir;
  const originalMkdtemp = fsPromises.mkdtemp;
  const originalOpen = fsPromises.open;
  const originalCopyFile = fsPromises.copyFile;
  const originalRename = fsPromises.rename;
  const originalRm = fsPromises.rm;
  const originalRmdir = fsPromises.rmdir;
  fsPromises.mkdir = (async (path: string | URL, options?: Parameters<typeof originalMkdir>[1]) => {
    const target = String(path);
    const entry = checkpointScopeForPath(target);
    if (entry === undefined) return originalMkdir(path, options);
    const recursive = typeof options === "object" && options !== null && options.recursive === true;
    const mode = typeof options === "object" && options !== null ? options.mode : options;
    const pending: string[] = [];
    if (recursive) {
      let current = target;
      while (current !== entry.root && lstatSync(current, { throwIfNoEntry: false }) === undefined) {
        pending.unshift(current);
        current = dirname(current);
      }
      assertCheckpointDirectory(current, entry.ownership);
    } else {
      pending.push(target);
    }
    for (const created of pending) {
      assertCheckpointDirectory(dirname(created), entry.ownership);
      fsMkdirSync(created, mode);
      assertCheckpointDirectory(dirname(created), entry.ownership);
      const receipt = lstatSync(created, { bigint: true });
      assert.ok(receipt.isDirectory() && realpathSync(created) === created);
      entry.ownership.track(created, receipt);
    }
    return recursive ? pending[0] : undefined;
  }) as typeof fsPromises.mkdir;
  fsPromises.mkdtemp = (async (prefix: string, options?: Parameters<typeof originalMkdtemp>[1]) => {
    const entry = options === undefined ? checkpointScopeForPath(prefix) : undefined;
    if (entry === undefined) return originalMkdtemp(prefix, options);
    assertCheckpointDirectory(dirname(prefix), entry.ownership);
    const created = mkdtempSync(prefix);
    assertCheckpointDirectory(dirname(created), entry.ownership);
    const receipt = lstatSync(created, { bigint: true });
    assert.ok(receipt.isDirectory() && realpathSync(created) === created);
    entry.ownership.track(created, receipt);
    return created;
  }) as typeof fsPromises.mkdtemp;
  fsPromises.open = (async (path: string | URL, flags: unknown, mode?: number) => {
    const target = String(path);
    const entry = isExclusiveCreateOpen(flags) ? checkpointScopeForPath(target) : undefined;
    if (entry !== undefined) assertCheckpointDirectory(dirname(target), entry.ownership);
    const handle = await (originalOpen as unknown as (p: unknown, f?: unknown, m?: number) => Promise<import("node:fs/promises").FileHandle>)(path, flags, mode);
    if (entry !== undefined) {
      try {
        assertCheckpointDirectory(dirname(target), entry.ownership);
        entry.ownership.track(target, fstatSync(handle.fd, { bigint: true }));
      } catch (error) {
        try { await handle.close(); }
        catch (closeError) {
          throw new AggregateError([error, closeError], `checkpoint receipt and close failed: ${target}`, { cause: error });
        }
        throw error;
      }
    }
    return handle;
  }) as typeof fsPromises.open;
  fsPromises.copyFile = (async (...args: Parameters<typeof originalCopyFile>) => {
    const destination = String(args[1]);
    const entry = checkpointScopeForPath(destination);
    if (entry === undefined) return originalCopyFile(...args);
    assertCheckpointDirectory(dirname(destination), entry.ownership);
    // Disposable index copies must never overwrite an existing entry.
    copyFileSync(args[0], args[1], (args[2] ?? 0) | fsFlags.COPYFILE_EXCL);
    assertCheckpointDirectory(dirname(destination), entry.ownership);
    const receipt = lstatSync(destination, { bigint: true });
    assert.ok(receipt.isFile(), `checkpoint index copy is not a regular file: ${destination}`);
    entry.ownership.track(destination, receipt);
  }) as typeof fsPromises.copyFile;
  fsPromises.rename = (async (from: string | URL, to: string | URL) => {
    const source = String(from);
    const destination = String(to);
    const sourceEntry = checkpointScopeForPath(source);
    const destinationEntry = checkpointScopeForPath(destination);
    if (sourceEntry === undefined && destinationEntry === undefined) return originalRename(from, to);
    assert.ok(sourceEntry !== undefined && sourceEntry === destinationEntry,
      `checkpoint rename crosses fixture scope: ${source} -> ${destination}`);
    const owner = sourceEntry.ownership;
    assertCheckpointDirectory(dirname(source), owner);
    assertCheckpointDirectory(dirname(destination), owner);
    assert.ok(owner.matches(source, lstatSync(source, { bigint: true })), `unowned checkpoint rename source: ${source}`);
    const current = lstatSync(destination, { bigint: true, throwIfNoEntry: false });
    assert.ok(current === undefined || owner.matches(destination, current), `unowned checkpoint rename destination: ${destination}`);
    const result = await originalRename(from, to);
    owner.moveTree(source, destination);
    return result;
  }) as typeof fsPromises.rename;
  fsPromises.rm = (async (...args: Parameters<typeof originalRm>) => {
    const path = String(args[0]);
    const entry = checkpointScopeForPath(path);
    assertCheckpointRemoval(path);
    if (entry !== undefined) {
      // Recheck after the test seam and immediately before the synchronous mutation.
      assertCheckpointRemovalTarget(path, entry);
      if (args[1]?.recursive) {
        assert.ok(args[1].force, `unsupported scoped recursive removal without force: ${path}`);
        entry.ownership.cleanup(path);
      } else {
        rmSync(path, args[1]);
      }
    } else {
      await originalRm(...args);
    }
    trackCheckpointRemovedPath(path);
  }) as typeof fsPromises.rm;
  fsPromises.rmdir = (async (...args: Parameters<typeof originalRmdir>) => {
    const path = String(args[0]);
    const entry = checkpointScopeForPath(path);
    assertCheckpointRemoval(path);
    if (entry !== undefined) {
      assertCheckpointRemovalTarget(path, entry);
      rmdirSync(path);
    } else {
      await originalRmdir(...args);
    }
    trackCheckpointRemovedPath(path);
  }) as typeof fsPromises.rmdir;

  const originalRun = gitRunner.runGit;
  const originalInput = gitRunner.runGitWithInput;
  if (gitDir !== undefined) {
    gitRunner.runGit = async (...args) => {
      let refAncestors = new Set<string>();
      const deleting = args[2][0] === "update-ref" && args[2].includes("-d");
      if (args[2][0] === "update-ref" && !deleting && fixtureGitDir(args[1]) === gitDir) {
        const ref = args[2].slice(1).find((arg) => arg.startsWith("refs/"));
        if (ref !== undefined) {
          for (const path of [join(gitDir, ref), join(gitDir, "logs", ref)]) {
            for (let current = dirname(path); current !== gitDir; current = dirname(current)) {
              if (lstatSync(current, { bigint: true, throwIfNoEntry: false }) === undefined) refAncestors.add(current);
              if (dirname(current) === current) break;
            }
          }
        }
      }
      const out = await originalRun(...args);
      if (out.code === 0 && deleting && fixtureGitDir(args[1]) === gitDir) {
        await afterGitUpdateRefDeletion?.(gitDir, args[2]);
      }
      if (out.code === 0 && fixtureGitDir(args[1]) === gitDir) {
        if (args[2][0] === "write-tree") await receiptTree(gitDir, args[1], out.stdout.toString("ascii").trim());
        else if (args[2].includes("commit-tree")) receiptObjectIds(gitDir, [out.stdout.toString("ascii").trim()]);
        // Git can replace a disposable index copy by atomic rename while writing
        // its tree; the final file is produced by this successful command.
        const index = args[3].extraEnv?.GIT_INDEX_FILE;
        if (typeof index === "string") receiptCreatedPath(index);
        receiptCreatedEntries(refAncestors);
        receiptGitUpdateRef(gitDir, args[2], out);
      }
      return out;
    };
    gitRunner.runGitWithInput = async (...args) => {
      const out = await originalInput(...args);
      if (fixtureGitDir(args[1]) === gitDir) {
        const index = args[5].GIT_INDEX_FILE ?? args[4].extraEnv?.GIT_INDEX_FILE;
        if (args[2][0] === "apply" && index) await receiptIndex(gitDir, args[1], index);
        if (out.code === 0 && args[2].includes("hash-object") && args[2].includes("-w")) {
          receiptObjectIds(gitDir, [out.stdout.toString("ascii").trim()]);
        }
        if (out.code === 0 && typeof index === "string") receiptCreatedPath(index);
        receiptGitUpdateRef(gitDir, args[2], out);
      }
      return out;
    };
  }
  try { return await run(); }
  finally {
    fsPromises.mkdir = originalMkdir;
    fsPromises.mkdtemp = originalMkdtemp;
    fsPromises.open = originalOpen;
    fsPromises.copyFile = originalCopyFile;
    fsPromises.rename = originalRename;
    fsPromises.rm = originalRm;
    fsPromises.rmdir = originalRmdir;
    if (gitDir !== undefined) {
      gitRunner.runGit = originalRun;
      gitRunner.runGitWithInput = originalInput;
    }
  }
}

function trackCheckpointRemovedPath(path: string): void {
  const entry = checkpointScopeForPath(path);
  if (entry !== undefined) entry.ownership.untrackTree(path);
}

/** Explicit preservation is 1, default removal is 0/unset, anything else is refused. */
function fixturePreservationRequested(): boolean {
  const value = process.env.PI_TEST_SCRATCH_PRESERVE;
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`PI_TEST_SCRATCH_PRESERVE must be 1 or 0 when set; got ${JSON.stringify(value)}`);
}

/** Remove only the exact directory this receipt proves, then confirm its absence. */
function removeCreatedDirectory(path: string, receipt: import("node:fs").BigIntStats): void {
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  assert.ok(current?.isDirectory() && !current.isSymbolicLink()
    && current.dev === receipt.dev && current.ino === receipt.ino,
  `refusing to remove a replaced allocation: ${path}`);
  rmdirSync(path);
  assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined,
    `removal of the allocated directory was not confirmed: ${path}`);
}

async function allocateFixtureRoot(
  prefix: string,
  roots: FixtureRoot[],
  ownership: FixtureOwnership,
  allocation: { unresolved: boolean; retainedPath?: string },
  afterAllocate?: (path: string, ownership: FixtureOwnership) => void,
): Promise<string> {
  const path = await mkdtemp(join(fixtureBase, prefix));
  // The exact returned path is recorded before any receipt is attempted: if the receipt
  // fails, cleanup can name it as refused and retained even though it is (deliberately)
  // absent from the ownership ledger until validation succeeds.
  allocation.retainedPath = path;
  let receipt: import("node:fs").BigIntStats;
  try {
    receipt = await lstat(path, { bigint: true });
  } catch (error) {
    // The root exists but has no receipt: retain the refusal and evidence.
    allocation.unresolved = true;
    throw error;
  }
  roots.push({ path, receipt }); // record immediately so a setup failure still has the root receipt
  checkpointScopes.push({ root: path, ownership });
  ownership.track(path, receipt); // the receipt already read, never a second lookup
  assert.ok(receipt.isDirectory() && !receipt.isSymbolicLink() && await realpath(path) === path,
    `review-checkpoint fixture root is not a canonical real directory: ${path}`);
  afterAllocate?.(path, ownership);
  return path;
}

async function lstatIfExists(path: string): Promise<import("node:fs").BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function cleanupFixture(
  ownership: FixtureOwnership,
  roots: readonly FixtureRoot[],
  preserve: boolean,
): Promise<void> {
  for (const root of roots) {
    const current = await lstatIfExists(root.path);
    if (current === undefined) {
      throw new Error(`review-checkpoint fixture root is missing without confirmed removal: ${root.path}`);
    }
    assert.ok(current.isDirectory() && !current.isSymbolicLink()
      && current.dev === root.receipt.dev && current.ino === root.receipt.ino,
    `review-checkpoint fixture root changed identity: ${root.path}`);
    assert.equal(await realpath(root.path), root.path, `review-checkpoint fixture root is no longer canonical: ${root.path}`);
  }
  ownership.verify();
  if (preserve) {
    for (const root of roots) {
      process.stderr.write(`preserved review-checkpoint fixture (PI_TEST_SCRATCH_PRESERVE=1): ${root.path}\n`);
    }
    return;
  }
  ownership.cleanup();
  for (const root of roots) {
    assert.equal(await lstatIfExists(root.path), undefined,
      `review-checkpoint fixture root still exists after removal: ${root.path}`);
  }
}

async function fixture(
  run: (root: string) => Promise<void>,
  afterFirstRoot?: (path: string, ownership: FixtureOwnership, resolveRefusal: () => void) => void,
  afterUnresolvedAllocation?: (path: string | undefined, resolveRefusal: () => void) => void,
): Promise<void> {
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  const resolveRefusal = signalCleanupRefusal("review-checkpoint fixture cleanup pending");
  const ownership = new FixtureOwnership();
  const roots: FixtureRoot[] = [];
  const allocation = { unresolved: false } as { unresolved: boolean; retainedPath?: string };
  let bodyError: unknown = NO_BODY_ERROR;
  let cleanupError: unknown = NO_CLEANUP_ERROR;
  try {
    const root = await allocateFixtureRoot(".review-checkpoint-test-", roots, ownership, allocation,
      (path, owner) => afterFirstRoot?.(path, owner, resolveRefusal));
    const agentDir = await allocateFixtureRoot("prg-review-checkpoint-agent-", roots, ownership, allocation);
    scope = { agentDir, sessionId: "review-checkpoint-session" };
    process.env.GIT_CEILING_DIRECTORIES = fixtureBase;
    await run(root);
  } catch (error) {
    bodyError = error;
  }
  try {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
    scope = undefined;
    const preserve = fixturePreservationRequested();
    await cleanupFixture(ownership, roots, preserve);
    if (!allocation.unresolved) resolveRefusal();
    else {
      // The allocation returned a path but its receipt failed, so that path was never in the
      // ledger and cleanup cannot have removed it. Name it explicitly and keep the refusal
      // reserved; the original allocation error stays the surfaced failure.
      const notice = `review-checkpoint fixture cleanup refused; retained ${allocation.retainedPath ?? "(unrecorded allocated root)"}: the allocated root had no receipt`;
      process.stderr.write(`${notice}\n`);
    }
  } catch (error) {
    const retained = roots.map((root) => root.path).join(", ") || "(unrecorded allocated root)";
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
    const notice = `review-checkpoint fixture cleanup refused; retained ${retained}: ${detail}`.slice(0, 2_048);
    process.stderr.write(`${notice}\n`);
    cleanupError = new Error(notice, { cause: error });
  } finally {
    for (const root of roots) {
      const index = checkpointScopes.findIndex((entry) => entry.root === root.path);
      if (index >= 0) checkpointScopes.splice(index, 1);
    }
  }
  // A returned-but-unreceipted path is outside the ledger, so only the caller that
  // removes that evidence can resolve its reservation.
  if (allocation.unresolved) afterUnresolvedAllocation?.(allocation.retainedPath, resolveRefusal);
  if (bodyError !== NO_BODY_ERROR && cleanupError !== NO_CLEANUP_ERROR) {
    throw new AggregateError([bodyError, cleanupError], "review-checkpoint body and fixture cleanup failed", { cause: bodyError });
  }
  if (bodyError !== NO_BODY_ERROR) throw bodyError;
  if (cleanupError !== NO_CLEANUP_ERROR) throw cleanupError;
}

// Every fixture directory creation is ONE EXCLUSIVE LEVEL at a time. An existing level is
// reused only when this scope already owns it, so a recursive create can never adopt an
// unexplained directory it did not create, and a receipt is recorded only for a level this
// call actually created.
async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  const entry = checkpointScopeForPath(path);
  if (!entry) { await fsMkdir(path, options); return; } // outside a scope: no receipts to move
  const parent = dirname(path);
  if (options?.recursive && path !== entry.root) await mkdir(parent, options);
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (options?.recursive && current !== undefined) {
    assert.ok(current.isDirectory() && entry.ownership.matches(path, current) && realpathSync(path) === path,
      `not an owned fixture directory: ${path}`);
    return;
  }
  const parentReceipt = lstatSync(parent, { bigint: true });
  assert.ok(parentReceipt.isDirectory() && entry.ownership.matches(parent, parentReceipt) && realpathSync(parent) === parent,
    `not an owned fixture directory: ${parent}`);
  fsMkdirSync(path); // no await between creation and receipt
  entry.ownership.track(path);
}

type FixtureWriteOptions = BufferEncoding | { encoding?: BufferEncoding; flag?: "wx"; mode?: number };
/** The payload forms FileHandle.writeFile accepts at runtime (streams included). */
type FixtureWriteData = Parameters<typeof fsWriteFile>[1] | Parameters<import("node:fs/promises").FileHandle["writeFile"]>[0];

/**
 * The receipt comes from the OPENED DESCRIPTOR, never from whatever pathname happens to
 * exist afterwards. A fresh file is receipted from its successful exclusive open and written
 * through that same descriptor, so a payload failure can never leave an unreceipted entry
 * behind, and a replacement appearing mid-write is never adopted. An existing entry is only
 * truncated after its open descriptor matches an existing receipt, so an unexplained file
 * is refused instead of overwritten or receipted.
 */
async function writeFile(
  path: string,
  data: FixtureWriteData,
  options?: FixtureWriteOptions,
  owner = checkpointScopeForPath(path)?.ownership,
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

/**
 * A fixture symlink needs an existing, canonical, ALREADY RECEIPTED parent before the link
 * is written, and afterwards only the link itself is receipted: creating a link never
 * adopts an unexplained ancestor.
 */
async function symlink(target: string, path: string): Promise<void> {
  const entry = checkpointScopeForPath(path);
  assert.ok(entry, `symlink has no fixture ownership ledger: ${path}`);
  const parent = dirname(path);
  const parentReceipt = lstatSync(parent, { bigint: true });
  assert.ok(parentReceipt.isDirectory() && entry.ownership.matches(parent, parentReceipt) && realpathSync(parent) === parent,
    `symlink parent is not an owned fixture directory: ${parent}`);
  fsSymlinkSync(target, path); // no await between creation and receipt
  const receipt = lstatSync(path, { bigint: true });
  assert.ok(receipt.isSymbolicLink(), `fixture symlink changed after creation: ${path}`);
  entry.ownership.track(path, receipt); // the link alone, never its ancestors
}

async function rm(...args: Parameters<typeof fsRm>): Promise<void> {
  const result = await fsRm(...args);
  trackCheckpointRemovedPath(String(args[0]));
  return result;
}

async function captureReviewCheckpoint(
  ...args: Parameters<typeof rawCaptureReviewCheckpoint>
): ReturnType<typeof rawCaptureReviewCheckpoint> {
  const [root] = args;
  checkpointScopeForPath(root)?.ownership.verify();
  // Outputs are receipted at the filesystem/Git operation that creates them, never
  // by inspecting a planned path after the fact (including on failure).
  return withCheckpointReceipts(fixtureGitDir(root), () => rawCaptureReviewCheckpoint(...args));
}

async function compareReviewCheckpoints(
  ...args: Parameters<typeof rawCompareReviewCheckpoints>
): ReturnType<typeof rawCompareReviewCheckpoints> {
  checkpointScopeForPath(args[0])?.ownership.verify();
  const gitDir = fixtureGitDir(args[0]);
  return withCheckpointReceipts(gitDir, () => rawCompareReviewCheckpoints(...args));
}

async function releaseReviewCheckpoint(
  ...args: Parameters<typeof rawReleaseReviewCheckpoint>
): ReturnType<typeof rawReleaseReviewCheckpoint> {
  const [root] = args;
  checkpointScopeForPath(root)?.ownership.verify();
  // Release removes the same owned pin/scratch/record entries, so route it through
  // the same write/removal seams as capture and comparison.
  return withCheckpointReceipts(fixtureGitDir(root), () => rawReleaseReviewCheckpoint(...args));
}

/** Test seam: run inside one Git write's window, between the operation and its attribution scan. */
let duringGitAttribution: ((gitDir: string) => Promise<void>) | undefined;

async function git(root: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  checkpointScopeForPath(root)?.ownership.verify();
  const gitDir = join(root, ".git");
  let stdout: string | undefined;
  if (args[0] === "init") assert.equal(lstatSync(gitDir, { throwIfNoEntry: false }), undefined);
  try {
    const command = args[0] === "init" ? [...args, "--template="] : args;
    // A caller's split-index default must not create unreceipted sharedindex files.
    const result = await exec("git", ["-c", "core.splitIndex=false", ...command], {
      cwd: root,
      env: {
        ...process.env,
        // `--template=` suppresses template contents but does not select the ref backend.
        // Pin the fixture to the files backend so a caller with GIT_DEFAULT_REF_FORMAT=
        // reftable still gets the bounded `.git/refs` layout the receipts below describe,
        // without requiring any minimum Git version (older Git ignores this variable).
        GIT_DEFAULT_REF_FORMAT: "files",
        GIT_AUTHOR_NAME: "Test",
        GIT_COMMITTER_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    stdout = result.stdout;
    return result;
  } finally {
    if (args[0] === "init") {
      if (duringGitAttribution !== undefined) await duringGitAttribution(gitDir);
      receiptGitInit(gitDir);
    } else {
      if (["add", "commit", "rm", "update-index"].includes(args[0]!)) checkpointOutput(join(gitDir, "index"), true);
      if (args[0] === "commit") {
        checkpointOutput(join(gitDir, "COMMIT_EDITMSG"), true);
        checkpointOutput(join(gitDir, "logs", "HEAD"), true);
        const branch = /^ref: (refs\/heads\/[^\r\n]+)\r?\n$/.exec(readFileSync(join(gitDir, "HEAD"), "utf8"))?.[1];
        if (branch) {
          checkpointOutput(join(gitDir, branch), true);
          checkpointOutput(join(gitDir, "logs", branch), true);
        }
      }
      if (args[0] === "checkout-index") checkpointOutput(join(root, "link"), true);
      if (duringGitAttribution !== undefined) await duringGitAttribution(gitDir);
      if (args[0] === "add" || args[0] === "commit") await receiptIndex(gitDir, root, join(gitDir, "index"));
      if (args[0] === "commit" && stdout !== undefined) {
        const [commit, tree] = (await gitOutput(root, ["rev-parse", "HEAD", "HEAD^{tree}"])).trim().split("\n");
        receiptObjectIds(gitDir, [commit!]);
        await receiptTree(gitDir, root, tree!);
      }
      if (args[0] === "hash-object" && args.includes("-w") && stdout !== undefined) {
        receiptObjectIds(gitDir, [stdout.trim()]);
      }
    }
  }
}
async function capture(root: string, id: string): Promise<ReviewCheckpointDescriptor> {
  const result = await captureReviewCheckpoint(root, id, opts());
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result.value;
}

test("nested Git review checkpoints cover repository-relative sibling changes without following live bytes", async () => fixture(async (root) => {
  const repository = join(root, "repo");
  const cwd = join(repository, "nested", "selected");
  await mkdir(cwd, { recursive: true });
  await git(repository, "init", "-q");
  await writeFile(join(repository, "sibling.txt"), "committed sibling baseline\n");
  await git(repository, "add", "sibling.txt");
  await git(repository, "commit", "-qm", "base");

  const before = await capture(cwd, "nested-before");
  assert.equal(before.kind, "git");
  assert.equal((await loadReviewCheckpoint(cwd, before, opts())).status, "ok");
  await writeFile(join(repository, "sibling.txt"), "frozen sibling after\n");
  await writeFile(join(repository, "eligible-sibling.txt"), Buffer.from([0, 255, 11]));
  const after = await capture(cwd, "nested-after");
  await writeFile(join(repository, "sibling.txt"), "later live sibling bytes\n");
  await writeFile(join(repository, "eligible-sibling.txt"), "later live untracked bytes\n");

  const compared = await compareReviewCheckpoints(cwd, before, after, opts());
  assert.equal(compared.status, "ok", JSON.stringify(compared));
  if (compared.status === "ok") {
    assert.deepEqual(compared.value.changes.map((change) => change.path), ["eligible-sibling.txt", "sibling.txt"]);
    assert.equal(compared.value.changes.find((change) => change.path === "sibling.txt")?.old?.bytes?.toString(), "committed sibling baseline\n");
    assert.equal(compared.value.changes.find((change) => change.path === "sibling.txt")?.new?.bytes?.toString(), "frozen sibling after\n");
    assert.deepEqual(compared.value.changes.find((change) => change.path === "eligible-sibling.txt")?.new?.bytes, Buffer.from([0, 255, 11]));
  }

  const otherRepository = join(root, "other-repo");
  await mkdir(otherRepository);
  await git(otherRepository, "init", "-q");
  await writeFile(join(otherRepository, "other.txt"), "other repository\n");
  await git(otherRepository, "add", "other.txt");
  await git(otherRepository, "commit", "-qm", "other");
  const other = await capture(otherRepository, "nested-other");
  assert.equal((await loadReviewCheckpoint(otherRepository, before, opts())).status, "failed");
  if (before.kind === "git" && other.kind === "git") {
    const tampered = { ...before, checkpoint: { ...before.checkpoint, gitDir: other.checkpoint.gitDir } };
    assert.equal((await loadReviewCheckpoint(cwd, tampered, opts())).status, "failed");
  }
  assert.equal((await releaseReviewCheckpoint(cwd, before, opts())).status, "ok");
  assert.equal((await releaseReviewCheckpoint(cwd, after, opts())).status, "ok");
  assert.equal((await releaseReviewCheckpoint(otherRepository, other, opts())).status, "ok");
}));

test("ambient Git repository redirects cannot hide nested parent-review changes", async () => fixture(async (root) => {
  const actual = join(root, "actual");
  const selected = join(actual, "nested");
  const unrelated = join(root, "unrelated");
  await mkdir(selected, { recursive: true });
  await mkdir(unrelated);
  for (const repository of [actual, unrelated]) {
    await git(repository, "init", "-q");
    await writeFile(join(repository, "tracked.txt"), "baseline\n");
    await git(repository, "add", "tracked.txt");
    await git(repository, "commit", "-qm", "baseline");
  }

  const priorDir = process.env.GIT_DIR;
  const priorWorktree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = join(unrelated, ".git");
    process.env.GIT_WORK_TREE = unrelated;
    const before = await capture(selected, "redirect-before");
    assert.equal(before.kind, "git");
    if (before.kind !== "git") throw new Error("expected Git checkpoint");
    assert.equal(before.checkpoint.gitDir, await realpath(join(actual, ".git")));
    await writeFile(join(actual, "tracked.txt"), "actual repository changed\n");
    const after = await capture(selected, "redirect-after");
    const compared = await compareReviewCheckpoints(selected, before, after, opts());
    assert.equal(compared.status, "ok", JSON.stringify(compared));
    if (compared.status === "ok") {
      assert.deepEqual(compared.value.changes.map((change) => change.path), ["tracked.txt"]);
      assert.equal(compared.value.changes[0]?.new?.bytes?.toString(), "actual repository changed\n");
    }
    assert.equal((await loadReviewCheckpoint(selected, before, opts())).status, "ok");
    assert.equal((await releaseReviewCheckpoint(selected, before, opts())).status, "ok");
    assert.equal((await releaseReviewCheckpoint(selected, after, opts())).status, "ok");
  } finally {
    if (priorDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = priorDir;
    if (priorWorktree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = priorWorktree;
  }
}));

test("Git clean tracked bytes are referenced, while staged, unstaged and untracked bytes are recoverable", async () => fixture(async (root) => {
  await git(root, "init", "-q");
  await writeFile(join(root, "clean"), Buffer.alloc(1024 * 1024, 0x51));
  await writeFile(join(root, "edited"), "base");
  await writeFile(join(root, "ignored-tracked"), "tracked");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  await writeFile(join(root, ".gitignore"), "ignored*\n");
  await writeFile(join(root, "edited"), "staged");
  await git(root, "add", "edited");
  await writeFile(join(root, "edited"), "unstaged");
  await writeFile(join(root, "new"), Buffer.from([0, 255, 1]));
  await writeFile(join(root, "ignored-untracked"), "secret");
  const first = await capture(root, "first");
  assert.equal(first.kind, "git");
  assert.ok(first.kind === "git" && first.checkpoint.digest.length === 64);
  const loaded = await loadReviewCheckpoint(root, first, opts());
  assert.equal(loaded.status, "ok");
  // The Git record contains patches/untracked content, but never the clean blob.
  const dir = first.kind === "git" ? first.checkpoint.gitDir : "";
  const record = await readFile(join(dir, "pi-review-gate", "checkpoints", "first", `arm-${first.kind === "git" ? first.checkpoint.armId : ""}`, "record.json"), "utf8");
  assert.ok(record.length < 100_000);
  assert.ok(!record.includes(Buffer.alloc(1024, 0x51).toString("base64")));
  await writeFile(join(root, "edited"), "later");
  await writeFile(join(root, "new"), "later");
  const second = await capture(root, "second");
  const result = await compareReviewCheckpoints(root, first, second, opts());
  assert.equal(result.status, "ok", JSON.stringify(result));
  if (result.status === "ok") {
    assert.equal(result.value.changes.find((c) => c.path === "edited")?.old?.bytes?.toString(), "unstaged");
    assert.deepEqual(result.value.changes.find((c) => c.path === "new")?.old?.bytes, Buffer.from([0, 255, 1]));
    assert.ok(!result.value.changes.some((c) => c.path === "clean" || c.path === "ignored-tracked" || c.path === "ignored-untracked"));
  }
  assert.equal((await releaseReviewCheckpoint(root, first, opts())).status, "ok");
  assert.equal((await loadReviewCheckpoint(root, first, opts())).status, "failed");
  assert.equal((await releaseReviewCheckpoint(root, second, opts())).status, "ok");
}));

test("Git tracked/untracked transitions with identical worktree content are not changes", async () => fixture(async (root) => {
  await git(root, "init", "-q");
  await writeFile(join(root, "file"), Buffer.from([0, 255, 42]));
  await chmod(join(root, "file"), 0o644);
  await git(root, "add", "file");
  await git(root, "commit", "-qm", "base");
  const tracked = await capture(root, "tracked");
  await git(root, "rm", "--cached", "--", "file");
  const untracked = await capture(root, "untracked");
  const toUntracked = await compareReviewCheckpoints(root, tracked, untracked, opts());
  assert.equal(toUntracked.status, "ok", JSON.stringify(toUntracked));
  if (toUntracked.status === "ok") assert.deepEqual(toUntracked.value.changes, []);
  await git(root, "add", "file");
  const trackedAgain = await capture(root, "tracked-again");
  const toTracked = await compareReviewCheckpoints(root, untracked, trackedAgain, opts());
  assert.equal(toTracked.status, "ok", JSON.stringify(toTracked));
  if (toTracked.status === "ok") assert.deepEqual(toTracked.value.changes, []);
  for (const checkpoint of [tracked, untracked, trackedAgain]) assert.equal((await releaseReviewCheckpoint(root, checkpoint, opts())).status, "ok");
}));

test("Git tracked symlinks retain valid targets and reject lossy non-UTF-8 parent comparisons", async () => fixture(async (root) => {
  await git(root, "init", "-q");
  await symlink("original", join(root, "link"));
  await git(root, "add", "link");
  await git(root, "commit", "-qm", "base");
  const original = await capture(root, "original");
  await rm(join(root, "link"));
  await symlink("updated", join(root, "link"));
  const valid = await capture(root, "valid");
  const validComparison = await compareReviewCheckpoints(root, original, valid, opts());
  assert.equal(validComparison.status, "ok", JSON.stringify(validComparison));
  if (validComparison.status === "ok") {
    assert.deepEqual(validComparison.value.changes.map((change) => change.path), ["link"]);
    assert.equal(validComparison.value.changes[0]?.old?.target, "original");
    assert.equal(validComparison.value.changes[0]?.new?.target, "updated");
  }

  // Install raw blob bytes through Git's index and checkout; no text decoding
  // by Node or the shell is involved in creating either actual symlink.
  const installTarget = async (byte: number): Promise<void> => {
    const blobPath = join(root, ".git", "target-bytes");
    await writeFile(blobPath, Buffer.from([byte]));
    const { stdout } = await git(root, "hash-object", "-w", blobPath);
    await git(root, "update-index", "--add", "--cacheinfo", `120000,${stdout.trim()},link`);
    await git(root, "checkout-index", "-f", "--", "link");
    assert.deepEqual(await readlink(join(root, "link"), { encoding: "buffer" }), Buffer.from([byte]));
  };
  await installTarget(0xff);
  const invalidFirst = await capture(root, "invalid-first");
  await installTarget(0xfe);
  const invalidSecond = await capture(root, "invalid-second");
  const compared = await compareReviewCheckpoints(root, invalidFirst, invalidSecond, opts());
  assert.equal(compared.status, "failed", JSON.stringify(compared));
  if (compared.status === "failed") {
    assert.equal(compared.reason, "raw_checkpoint_failed");
    assert.match(compared.detail, /tracked symlink target is not valid UTF-8: link/);
  }
  for (const checkpoint of [original, valid, invalidFirst, invalidSecond])
    assert.equal((await releaseReviewCheckpoint(root, checkpoint, opts())).status, "ok");
}));

test("raw global excludes only with any project .gitignore; nested patterns stay local", async () => fixture(async (root) => {
  const template = join(root, "custom-template");
  await mkdir(join(template, "info"), { recursive: true });
  await writeFile(join(template, "info", "exclude"), "template-only.txt\n");
  const previousTemplate = process.env.GIT_TEMPLATE_DIR;
  process.env.GIT_TEMPLATE_DIR = template;
  const config = join(root, "global-config");
  const excludes = join(root, "global-excludes");
  await writeFile(excludes, "global.txt\n");
  await writeFile(config, `[core]\n excludesFile = ${excludes}\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    await writeFile(join(root, "global.txt"), "included when no project ignore");
    await writeFile(join(root, "template-only.txt"), "must remain eligible");
    await writeFile(join(root, "ordinary"), "one");
    const noIgnore = await capture(root, "no-ignore");
    assert.equal(noIgnore.kind, "raw");
    const loaded = await loadReviewCheckpoint(root, noIgnore, opts());
    assert.equal(loaded.status, "ok");
    if (loaded.status === "ok") assert.ok(loaded.value.kind === "raw" && loaded.value.entries.some((e) => e.path === "global.txt"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", ".gitignore"), "local.txt\n");
    await writeFile(join(root, "nested", "local.txt"), "omitted");
    await writeFile(join(root, "local.txt"), "kept");
    for (let i = 0; i < 64; i++) await writeFile(join(root, "nested", `ordinary-${i}`), `value-${i}`);
    const withIgnore = await capture(root, "with-ignore");
    const other = await loadReviewCheckpoint(root, withIgnore, opts());
    assert.equal(other.status, "ok");
    if (other.status === "ok") {
      assert.equal(other.value.kind, "raw");
      const names = other.value.kind === "raw" ? other.value.entries.map((e) => e.path) : [];
      assert.ok(!names.includes("global.txt"));
      assert.ok(names.includes("template-only.txt"));
      assert.ok(!names.includes("nested/local.txt"));
      assert.ok(names.includes("local.txt"));
      assert.equal(names.filter((name) => name.startsWith("nested/ordinary-")).length, 64);
    }
    assert.equal((await releaseReviewCheckpoint(root, noIgnore, opts())).status, "ok");
    assert.equal((await releaseReviewCheckpoint(root, withIgnore, opts())).status, "ok");
  } finally {
    if (previousTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = previousTemplate;
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
}));

test("raw frozen comparison selects changed files only; mode, symlink, missing and corrupt records fail closed", async () => fixture(async (root) => {
  await writeFile(join(root, "same"), "unchanged");
  await writeFile(join(root, "changed"), Buffer.from([0, 255]));
  await writeFile(join(root, "mode"), "same bytes");
  await symlink("same", join(root, "link"));
  const before = await capture(root, "before");
  await writeFile(join(root, "changed"), "after");
  await chmod(join(root, "mode"), 0o755);
  await rm(join(root, "link"));
  await symlink("changed", join(root, "link"));
  const after = await capture(root, "after");
  await writeFile(join(root, "changed"), "live must not be compared");
  const result = await compareReviewCheckpoints(root, before, after, opts());
  assert.equal(result.status, "ok", JSON.stringify(result));
  if (result.status === "ok") {
    assert.deepEqual(result.value.changes.map((c) => c.path), ["changed", "link", "mode"]);
    assert.deepEqual(result.value.changes[0]?.old?.bytes, Buffer.from([0, 255]));
    assert.equal(result.value.changes[0]?.new?.bytes?.toString(), "after");
    assert.equal(result.value.changes[1]?.old?.target, "same");
    assert.equal(result.value.changes[1]?.new?.target, "changed");
  }
  assert.equal(before.kind, "raw");
  if (before.kind !== "raw") return;
  const record = rawReviewCheckpointRecordPath(scope!, await realpath(root), before);
  await writeFile(record, "corrupt");
  assert.equal((await loadReviewCheckpoint(root, before, opts())).status, "failed");
  assert.equal((await releaseReviewCheckpoint(root, before, opts())).status, "failed");
  assert.ok((await lstat(record)).isFile());
  await rm(record);
  assert.equal((await compareReviewCheckpoints(root, before, after, opts())).status, "failed");
  assert.equal((await releaseReviewCheckpoint(root, after, opts())).status, "ok");
}));

test("a failed comparison cleanup leaves its mkdtemp scratch receipted for teardown", async () => {
  const preserve = fixturePreservationRequested();
  let rootPath = "";
  let ownership: FixtureOwnership | undefined;
  let compareDir = "";
  const previousRemovalVerification = afterCheckpointRemovalVerification;
  await fixture(async (root) => {
    const repository = join(root, "repo");
    await mkdir(repository, { recursive: true });
    await git(repository, "init", "-q");
    await writeFile(join(repository, "tracked.txt"), "baseline\n");
    await git(repository, "add", "tracked.txt");
    await git(repository, "commit", "-qm", "base");
    const before = await capture(repository, "compare-cleanup-before");
    await writeFile(join(repository, "tracked.txt"), "after\n");
    const after = await capture(repository, "compare-cleanup-after");
    const checkpointDir = join(repository, ".git", SCRATCH_SUBDIR);
    // Fail the production compare-* removal after its verifier has read the tracked
    // subtree, so the mkdtemp-returned directory survives for fixture teardown.
    afterCheckpointRemovalVerification = (target) => {
      if (dirname(target) === checkpointDir && basename(target).startsWith("compare-")) {
        compareDir = target;
        throw new Error("injected comparison cleanup failure");
      }
    };
    try {
      const result = await compareReviewCheckpoints(repository, before, after, opts());
      assert.equal(result.status, "failed");
      assert.match(String((result as { detail?: string }).detail),
        /cannot remove disposable comparison indexes: injected comparison cleanup failure/);
    } finally {
      afterCheckpointRemovalVerification = previousRemovalVerification;
    }
    assert.notEqual(compareDir, "");
    assert.equal(existsSync(compareDir), true, "the failed production cleanup leaves the compare directory");
    assert.equal(ownership?.has(compareDir), true, "the mkdtemp-returned compare directory is fixture-owned");
  }, (path, current) => {
    rootPath = path;
    ownership = current;
  });
  if (preserve) {
    assert.equal(existsSync(rootPath), true, "preserve retains the comparison fixture");
    assert.equal(existsSync(compareDir), true, "preserve retains the receipted compare directory");
    ownership!.cleanup();
    assert.equal(existsSync(rootPath), false, "the test-owned preserved root is removable after the assertion");
  } else {
    assert.equal(existsSync(rootPath), false, "default teardown removes the receipted compare directory with its fixture");
  }
});

test("broken root or ancestor .git marker never falls back to raw capture", async () => fixture(async (root) => {
  const child = join(root, "child");
  await mkdir(child);
  await writeFile(join(root, ".git"), "gitdir: nowhere\n");
  assert.equal((await captureReviewCheckpoint(root, "broken-root", opts())).status, "failed");
  assert.equal((await captureReviewCheckpoint(child, "broken-parent", opts())).status, "failed");
}));

test("an early capture failure never adopts an unrelated planned pin path", async () => {
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    let rootPath = "";
    let ownership: FixtureOwnership | undefined;
    let resolveRefusal: (() => void) | undefined;
    let unrelatedPath = "";
    let unrelatedReceipt: import("node:fs").BigIntStats | undefined;
    const unrelatedBytes = Buffer.from("unrelated planned pin bytes\n");
    try {
      await assert.rejects(
        fixture(async (root) => {
          const repository = join(root, "repo");
          await mkdir(repository, { recursive: true });
          await git(repository, "init", "-q");
          const result = await captureReviewCheckpoint(repository, "early-failure", {
            ...opts(),
            faultHooks: {
              afterInitialAudit: async () => {
                unrelatedPath = join(repository, ".git", checkpointRefForWindow("early-failure"));
                // The parent chain is fixture-created and receipted; the file itself is
                // an injected unknown writer's output and must never join the ledger until
                // this probe's own receipt-checked rollback runs.
                await mkdir(dirname(unrelatedPath), { recursive: true });
                const fd = openSync(unrelatedPath, "wx");
                try {
                  unrelatedReceipt = fstatSync(fd, { bigint: true });
                  fsWriteFileSync(fd, unrelatedBytes);
                } finally {
                  closeSync(fd);
                }
                throw new Error("injected early capture failure");
              },
            },
          });
          assert.equal(result.status, "failed");
          assert.match(String((result as { detail?: string }).detail), /injected early capture failure/);
        }, (path, current, resolver) => {
          rootPath = path;
          ownership = current;
          resolveRefusal = resolver;
        }),
        /fixture ownership verification failed/,
      );
      assert.equal(rootPath !== "", true);
      assert.equal(existsSync(unrelatedPath), true,
        `the unrelated planned pin path survives ${preserve ? "preserve" : "default"} teardown`);
      assert.equal(await readFile(unrelatedPath, "utf8"), unrelatedBytes.toString(),
        "the unrelated planned pin bytes are retained exactly");
      assert.equal(ownership?.has(unrelatedPath), false,
        "the unrelated planned pin path is never receipted as invocation-owned");
    } finally {
      try {
        if (unrelatedReceipt !== undefined) ownership!.track(unrelatedPath, unrelatedReceipt);
        ownership?.verify();
        ownership?.cleanup();
        if (rootPath !== "") assert.equal(lstatSync(rootPath, { throwIfNoEntry: false }), undefined);
        resolveRefusal?.();
      } finally {
        if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
        else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
      }
    }
  }
});

test("a scoped mkdir collision is never receipted as an owned directory", async () => {
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    let rootPath = "";
    let ownership: FixtureOwnership | undefined;
    let resolveRefusal: (() => void) | undefined;
    let collisionPath = "";
    let collisionReceipt: import("node:fs").BigIntStats | undefined;
    try {
      await assert.rejects(
        fixture(async (root) => {
          const repository = join(root, "repo");
          await mkdir(repository, { recursive: true });
          await git(repository, "init", "-q");
          const result = await captureReviewCheckpoint(repository, "mkdir-collision", {
            ...opts(),
            faultHooks: {
              afterInitialAudit: async () => {
                const locksDir = join(repository, ".git", "pi-review-gate", "checkpoint-pin-locks");
                await mkdir(locksDir, { recursive: true });
                collisionPath = join(locksDir, "mkdir-collision");
                // An unowned contender at the exact non-recursive lock directory. The
                // production mkdir rejects with EEXIST; teardown must not adopt it.
                fsMkdirSync(collisionPath);
                collisionReceipt = lstatSync(collisionPath, { bigint: true });
              },
              onPinLockContended: async () => { throw new Error("injected mkdir collision contention"); },
            },
          });
          assert.equal(result.status, "failed");
          assert.match(String((result as { detail?: string }).detail), /injected mkdir collision contention/);
        }, (path, current, resolver) => {
          rootPath = path;
          ownership = current;
          resolveRefusal = resolver;
        }),
        /fixture ownership verification failed/,
      );
      assert.equal(existsSync(collisionPath), true,
        `the EEXIST contender survives ${preserve ? "preserve" : "default"} teardown`);
      assert.equal(ownership?.has(collisionPath), false, "the EEXIST contender is never receipted");
    } finally {
      try {
        if (collisionReceipt !== undefined) ownership!.track(collisionPath, collisionReceipt);
        ownership?.verify();
        ownership?.cleanup();
        if (rootPath !== "") assert.equal(lstatSync(rootPath, { throwIfNoEntry: false }), undefined);
        resolveRefusal?.();
      } finally {
        if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
        else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
      }
    }
  }
});

test("an unowned record injected before publication is retained in both outcomes", async () => {
  for (const preserve of [false, true]) {
    for (const throwEarly of [false, true]) {
      const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
      if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
      else delete process.env.PI_TEST_SCRATCH_PRESERVE;
      let rootPath = "";
      let ownership: FixtureOwnership | undefined;
      let resolveRefusal: (() => void) | undefined;
      let recordPath = "";
      let recordReceipt: import("node:fs").BigIntStats | undefined;
      const recordBytes = Buffer.from(`unowned record race ${throwEarly ? "throw" : "return"}\n`);
      try {
        await assert.rejects(
          fixture(async (root) => {
            const repository = join(root, "repo");
            await mkdir(repository, { recursive: true });
            await git(repository, "init", "-q");
            await writeFile(join(repository, "tracked.txt"), "baseline\n");
            await git(repository, "add", "tracked.txt");
            const windowId = throwEarly ? "record-race-throw" : "record-race-return";
            const result = await captureReviewCheckpoint(repository, windowId, {
              ...opts(),
              faultHooks: {
                afterUntrackedList: async () => {
                  const windowDir = join(repository, ".git", SCRATCH_SUBDIR, windowId);
                  const arms = readdirSync(windowDir).filter((name) => name.startsWith("arm-"));
                  assert.equal(arms.length, 1, "one owned arm exists before publication");
                  recordPath = join(windowDir, arms[0]!, "record.json");
                  const fd = openSync(recordPath, "wx");
                  try {
                    recordReceipt = fstatSync(fd, { bigint: true });
                    fsWriteFileSync(fd, recordBytes);
                  } finally {
                    closeSync(fd);
                  }
                  if (throwEarly) throw new Error("injected record race");
                },
              },
            });
            assert.equal(result.status, "failed");
            const detail = String((result as { detail?: string }).detail);
            if (throwEarly) assert.match(detail, /injected record race/);
            else assert.match(detail, /cannot durably publish checkpoint record: unowned checkpoint rename destination/);
          }, (path, current, resolver) => {
            rootPath = path;
            ownership = current;
            resolveRefusal = resolver;
          }),
          /fixture ownership verification failed/,
        );
        assert.equal(existsSync(recordPath), true,
          `the unowned record survives ${preserve ? "preserve" : "default"} ${throwEarly ? "throwing" : "returning"} teardown`);
        assert.deepEqual(readFileSync(recordPath), recordBytes, "the unowned record bytes are retained exactly");
        assert.equal(ownership?.has(recordPath), false, "the unowned record is never receipted");
      } finally {
        try {
          if (recordReceipt !== undefined) ownership!.track(recordPath, recordReceipt);
          ownership?.verify();
          ownership?.cleanup();
          if (rootPath !== "") assert.equal(lstatSync(rootPath, { throwIfNoEntry: false }), undefined);
          resolveRefusal?.();
        } finally {
          if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
          else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
        }
      }
    }
  }
});

test("an index-copy collision never overwrites independently receipted bytes", async () => {
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    let rootPath = "";
    let ownership: FixtureOwnership | undefined;
    let resolveRefusal: (() => void) | undefined;
    let collisionPath = "";
    let collisionReceipt: import("node:fs").BigIntStats | undefined;
    const collisionBytes = Buffer.from("independently receipted index diff bytes\n");
    try {
      await assert.rejects(
        fixture(async (root) => {
          const repository = join(root, "repo");
          await mkdir(repository, { recursive: true });
          await git(repository, "init", "-q");
          await writeFile(join(repository, "tracked.txt"), "baseline\n");
          await git(repository, "add", "tracked.txt");
          const result = await captureReviewCheckpoint(repository, "index-copy-collision", {
            ...opts(),
            faultHooks: {
              betweenPatchCaptures: async () => {
                const windowDir = join(repository, ".git", SCRATCH_SUBDIR, "index-copy-collision");
                const arms = readdirSync(windowDir).filter((name) => name.startsWith("arm-"));
                assert.equal(arms.length, 1, "one owned arm exists before the unstaged capture");
                collisionPath = join(windowDir, arms[0]!, "index-unstaged-diff");
                const fd = openSync(collisionPath, "wx");
                try {
                  collisionReceipt = fstatSync(fd, { bigint: true });
                  fsWriteFileSync(fd, collisionBytes);
                } finally {
                  closeSync(fd);
                }
              },
            },
          });
          assert.equal(result.status, "failed");
          assert.match(String((result as { detail?: string }).detail), /cannot snapshot the live index for worktree diff/);
        }, (path, current, resolver) => {
          rootPath = path;
          ownership = current;
          resolveRefusal = resolver;
        }),
        /fixture ownership verification failed/,
      );
      assert.equal(existsSync(collisionPath), true,
        `the independent index bytes survive ${preserve ? "preserve" : "default"} teardown`);
      assert.deepEqual(readFileSync(collisionPath), collisionBytes, "the independent index bytes are never overwritten");
      assert.equal(ownership?.has(collisionPath), false, "the independent index file is never receipted");
    } finally {
      try {
        if (collisionReceipt !== undefined) ownership!.track(collisionPath, collisionReceipt);
        ownership?.verify();
        ownership?.cleanup();
        if (rootPath !== "") assert.equal(lstatSync(rootPath, { throwIfNoEntry: false }), undefined);
        resolveRefusal?.();
      } finally {
        if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
        else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
      }
    }
  }
});

test("a displaced arm directory stops staging before creating a temporary record", async () => {
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    let rootPath = "";
    let ownership: FixtureOwnership | undefined;
    let resolveRefusal: (() => void) | undefined;
    let armPath = "";
    let outside = "";
    let replacementReceipt: import("node:fs").BigIntStats | undefined;
    try {
      await assert.rejects(
        fixture(async (root) => {
          const repository = join(root, "repo");
          await mkdir(repository, { recursive: true });
          await git(repository, "init", "-q");
          await writeFile(join(repository, "tracked.txt"), "baseline\n");
          await git(repository, "add", "tracked.txt");
          outside = join(root, "outside-staging-target");
          await mkdir(outside);
          const result = await captureReviewCheckpoint(repository, "staging-displaced", {
            ...opts(),
            faultHooks: {
              afterUntrackedList: async () => {
                const windowDir = join(repository, ".git", SCRATCH_SUBDIR, "staging-displaced");
                const arms = readdirSync(windowDir).filter((name) => name.startsWith("arm-"));
                assert.equal(arms.length, 1, "one owned arm exists before publication");
                armPath = join(windowDir, arms[0]!);
                const moved = `${armPath}-moved`;
                await fsRename(armPath, moved);
                ownership!.moveTree(armPath, moved);
                fsSymlinkSync(outside, armPath);
                replacementReceipt = lstatSync(armPath, { bigint: true });
              },
            },
          });
          assert.equal(result.status, "failed");
          assert.match(String((result as { detail?: string }).detail), /not an owned fixture directory|unowned checkpoint/);
          assert.deepEqual(readdirSync(outside), [], "no staging file is created through the displaced arm");
        }, (path, current, resolver) => {
          rootPath = path;
          ownership = current;
          resolveRefusal = resolver;
        }),
        /fixture ownership verification failed/,
      );
      assert.equal(existsSync(armPath), true, `the displaced arm replacement survives ${preserve ? "preserve" : "default"} teardown`);
      assert.equal(lstatSync(armPath).isSymbolicLink(), true, "the replacement remains the unowned symlink");
      assert.deepEqual(readdirSync(outside), [], "the outside staging target never receives a temporary record");
      assert.equal(ownership?.has(armPath), false, "the replacement symlink is never receipted");
    } finally {
      try {
        if (replacementReceipt !== undefined) ownership!.track(armPath, replacementReceipt);
        ownership?.verify();
        ownership?.cleanup();
        if (rootPath !== "") assert.equal(lstatSync(rootPath, { throwIfNoEntry: false }), undefined);
        resolveRefusal?.();
      } finally {
        if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
        else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
      }
    }
  }
});

test("a child added after removal verification survives and keeps the refusal pending", async () => {
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    const previousRemovalVerification = afterCheckpointRemovalVerification;
    let rootPath = "";
    let ownership: FixtureOwnership | undefined;
    let resolveRefusal: (() => void) | undefined;
    let latePath = "";
    let lateReceipt: import("node:fs").BigIntStats | undefined;
    const lateBytes = Buffer.from("late unowned child bytes\n");
    afterCheckpointRemovalVerification = (target) => {
      if (latePath === "" && basename(target).startsWith("arm-")) {
        latePath = join(target, "late-unknown.txt");
        const fd = openSync(latePath, "wx");
        try {
          lateReceipt = fstatSync(fd, { bigint: true });
          fsWriteFileSync(fd, lateBytes);
        } finally {
          closeSync(fd);
        }
        afterCheckpointRemovalVerification = undefined;
      }
    };
    try {
      await assert.rejects(
        fixture(async (root) => {
          const repository = join(root, "repo");
          await mkdir(repository, { recursive: true });
          await git(repository, "init", "-q");
          await writeFile(join(repository, "tracked.txt"), "baseline\n");
          await git(repository, "add", "tracked.txt");
          const result = await captureReviewCheckpoint(repository, "late-child", {
            ...opts(),
            faultHooks: {
              afterUntrackedList: async () => { throw new Error("injected late-child failure"); },
            },
          });
          assert.equal(result.status, "failed");
          assert.match(String((result as { detail?: string }).detail), /injected late-child failure/);
        }, (path, current, resolver) => {
          rootPath = path;
          ownership = current;
          resolveRefusal = resolver;
        }),
        /fixture ownership verification failed/,
      );
      assert.equal(existsSync(latePath), true, `the late child survives ${preserve ? "preserve" : "default"} teardown`);
      assert.deepEqual(readFileSync(latePath), lateBytes, "the late child bytes are retained exactly");
      assert.equal(ownership?.has(latePath), false, "the late child is never receipted");
    } finally {
      afterCheckpointRemovalVerification = previousRemovalVerification;
      try {
        if (lateReceipt !== undefined) ownership!.track(latePath, lateReceipt);
        ownership?.verify();
        ownership?.cleanup();
        if (rootPath !== "") assert.equal(lstatSync(rootPath, { throwIfNoEntry: false }), undefined);
        resolveRefusal?.();
      } finally {
        if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
        else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
      }
    }
  }
});

test("a late child during a successful release keeps the wrapped refusal pending", async () => {
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    const previousRemovalVerification = afterCheckpointRemovalVerification;
    let rootPath = "";
    let ownership: FixtureOwnership | undefined;
    let resolveRefusal: (() => void) | undefined;
    let latePath = "";
    let lateReceipt: import("node:fs").BigIntStats | undefined;
    let releaseStatus = "";
    const lateBytes = Buffer.from("late release child bytes\n");
    try {
      await assert.rejects(
        fixture(async (root) => {
          const repository = join(root, "repo");
          await mkdir(repository, { recursive: true });
          await git(repository, "init", "-q");
          await writeFile(join(repository, "tracked.txt"), "baseline\n");
          await git(repository, "add", "tracked.txt");
          await git(repository, "commit", "-qm", "base");
          const checkpoint = await capture(repository, "release-late-child");
          assert.equal(checkpoint.kind, "git");
          afterCheckpointRemovalVerification = (target) => {
            if (latePath === "" && basename(target).startsWith("arm-")) {
              latePath = join(target, "late-release.txt");
              const fd = openSync(latePath, "wx");
              try {
                lateReceipt = fstatSync(fd, { bigint: true });
                fsWriteFileSync(fd, lateBytes);
              } finally {
                closeSync(fd);
              }
              afterCheckpointRemovalVerification = undefined;
            }
          };
          const released = await releaseReviewCheckpoint(repository, checkpoint, opts());
          releaseStatus = released.status;
          assert.equal(released.status, "ok", "release's best-effort scratch cleanup still reports success");
          assert.equal(existsSync(latePath), true, "the late child remains after the release");
        }, (path, current, resolver) => {
          rootPath = path;
          ownership = current;
          resolveRefusal = resolver;
        }),
        /fixture ownership verification failed/,
      );
      assert.equal(releaseStatus, "ok");
      assert.equal(existsSync(latePath), true, `the late release child survives ${preserve ? "preserve" : "default"} teardown`);
      assert.deepEqual(readFileSync(latePath), lateBytes, "the late release child bytes are retained exactly");
      assert.equal(ownership?.has(latePath), false, "the late release child is never receipted");
      if (process.env.PI_TEST_SCRATCH_ROOT !== undefined) {
        assert.equal(hasFixtureRefusal("review-checkpoint fixture cleanup pending"), true,
          "the wrapped refusal remains pending while the late child is retained");
      }
    } finally {
      afterCheckpointRemovalVerification = previousRemovalVerification;
      try {
        if (lateReceipt !== undefined) ownership!.track(latePath, lateReceipt);
        ownership?.verify();
        ownership?.cleanup();
        if (rootPath !== "") assert.equal(lstatSync(rootPath, { throwIfNoEntry: false }), undefined);
        resolveRefusal?.();
        if (process.env.PI_TEST_SCRATCH_ROOT !== undefined) {
          assert.equal(hasFixtureRefusal("review-checkpoint fixture cleanup pending"), false,
            "the wrapped refusal clears only after receipt-checked rollback");
        }
      } finally {
        if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
        else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
      }
    }
  }
});

test("a replacement during release removal survives with a visible refusal", async () => {
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    const previousRemovalVerification = afterCheckpointRemovalVerification;
    let rootPath = "";
    let ownership: FixtureOwnership | undefined;
    let resolveRefusal: (() => void) | undefined;
    let ownedPath = "";
    let movedPath = "";
    let replacementReceipt: import("node:fs").BigIntStats | undefined;
    let releaseDetail = "";
    try {
      await assert.rejects(
        fixture(async (root) => {
          const control = await capture(root, "release-without-replacement");
          assert.equal(control.kind, "raw");
          const checkpoint = await capture(root, "release-replacement");
          assert.equal(checkpoint.kind, "raw");
          ownedPath = dirname(rawReviewCheckpointRecordPath(scope!, await realpath(root), checkpoint));
          movedPath = `${ownedPath}-moved`;
          afterCheckpointRemovalVerification = (target) => {
            if (target === ownedPath && replacementReceipt === undefined) {
              fsRenameSync(ownedPath, movedPath);
              ownership!.moveTree(ownedPath, movedPath);
              fsMkdirSync(ownedPath);
              replacementReceipt = lstatSync(ownedPath, { bigint: true });
              afterCheckpointRemovalVerification = undefined;
            }
          };
          // Any scoped removal that delegates to a queued promise primitive is a
          // regression: the synchronous path must never reach these wrappers.
          const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
          const originalRmAsync = fsPromises.rm;
          const originalRmdirAsync = fsPromises.rmdir;
          let asyncScopedRemoval = "";
          fsPromises.rm = (async (...args: Parameters<typeof originalRmAsync>) => {
            if (checkpointScopeForPath(String(args[0])) !== undefined) {
              asyncScopedRemoval = `rm ${String(args[0])}`;
              throw new Error("scoped removal delegated to async rm");
            }
            return originalRmAsync(...args);
          }) as typeof fsPromises.rm;
          fsPromises.rmdir = (async (...args: Parameters<typeof originalRmdirAsync>) => {
            if (checkpointScopeForPath(String(args[0])) !== undefined) {
              asyncScopedRemoval = `rmdir ${String(args[0])}`;
              throw new Error("scoped removal delegated to async rmdir");
            }
            return originalRmdirAsync(...args);
          }) as typeof fsPromises.rmdir;
          let released;
          try {
            const cleanRelease = await releaseReviewCheckpoint(root, control, opts());
            assert.equal(cleanRelease.status, "ok", JSON.stringify(cleanRelease));
            assert.equal(asyncScopedRemoval, "", "owned rm and rmdir never delegate");
            released = await releaseReviewCheckpoint(root, checkpoint, opts());
          } finally {
            fsPromises.rm = originalRmAsync;
            fsPromises.rmdir = originalRmdirAsync;
          }
          assert.equal(asyncScopedRemoval, "", "scoped removals stay on the synchronous path");
          assert.equal(released.status, "failed");
          releaseDetail = String((released as { detail?: string }).detail);
          assert.match(releaseDetail, /refusing to remove a replaced checkpoint entry/);
          assert.equal(existsSync(ownedPath), true, "the replacement directory survives the refused rmdir");
        }, (path, current, resolver) => {
          rootPath = path;
          ownership = current;
          resolveRefusal = resolver;
        }),
        /fixture ownership verification failed/,
      );
      assert.match(releaseDetail, /refusing to remove a replaced checkpoint entry/);
      assert.equal(existsSync(ownedPath), true,
        `the replacement survives ${preserve ? "preserve" : "default"} teardown`);
      assert.equal(lstatSync(ownedPath).isDirectory(), true, "the replacement remains a directory");
      assert.equal(ownership?.has(ownedPath), false, "the replacement is never receipted");
    } finally {
      afterCheckpointRemovalVerification = previousRemovalVerification;
      try {
        if (replacementReceipt !== undefined) ownership!.track(ownedPath, replacementReceipt);
        ownership?.verify();
        ownership?.cleanup();
        if (rootPath !== "") assert.equal(lstatSync(rootPath, { throwIfNoEntry: false }), undefined);
        resolveRefusal?.();
      } finally {
        if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
        else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
      }
    }
  }
});

test("a ref recreated after release deletion is retained with the refusal pending", async () => {
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    const previousDeletionSeam = afterGitUpdateRefDeletion;
    let rootPath = "";
    let ownership: FixtureOwnership | undefined;
    let resolveRefusal: (() => void) | undefined;
    let refPath = "";
    let recreatedReceipt: import("node:fs").BigIntStats | undefined;
    let releaseStatus = "";
    try {
      await assert.rejects(
        fixture(async (root) => {
          const repositoryPath = join(root, "repo");
          await mkdir(repositoryPath, { recursive: true });
          await git(repositoryPath, "init", "-q");
          await writeFile(join(repositoryPath, "tracked.txt"), "baseline\n");
          await git(repositoryPath, "add", "tracked.txt");
          await git(repositoryPath, "commit", "-qm", "base");
          const checkpoint = await capture(repositoryPath, "release-ref-recreate");
          assert.equal(checkpoint.kind, "git");
          const { ref: windowRef, base } = checkpoint.checkpoint;
          refPath = join(repositoryPath, ".git", windowRef);
          const parent = dirname(refPath);
          const staged = join(parent, "probe-sibling");
          await writeFile(staged, `${base}\n`, { flag: "wx" });
          const receipt = lstatSync(staged, { bigint: true });
          assert.ok(ownership!.matches(staged, receipt));
          afterGitUpdateRefDeletion = (_gitDir, args) => {
            if (!args.includes(windowRef)) return;
            assertCheckpointDirectory(parent, ownership!);
            assert.ok(ownership!.matches(staged, lstatSync(staged, { bigint: true })));
            // Create an exclusive link with the already-receipted identity.
            linkSync(staged, refPath);
            recreatedReceipt = receipt;
            afterGitUpdateRefDeletion = undefined;
          };
          const released = await releaseReviewCheckpoint(repositoryPath, checkpoint, opts());
          releaseStatus = released.status;
          assert.equal(released.status, "ok");
          assert.equal(existsSync(refPath), true, "the recreated ref remains after release");
        }, (path, current, resolver) => {
          rootPath = path;
          ownership = current;
          resolveRefusal = resolver;
        }),
        /fixture ownership verification failed/,
      );
      assert.equal(releaseStatus, "ok");
      assert.equal(existsSync(refPath), true, `the recreated ref survives ${preserve ? "preserve" : "default"} teardown`);
      assert.ok(recreatedReceipt !== undefined && !ownership!.matches(refPath, recreatedReceipt!),
        "the recreated ref is not attributed to the original receipt");
      if (process.env.PI_TEST_SCRATCH_ROOT !== undefined) {
        assert.equal(hasFixtureRefusal("review-checkpoint fixture cleanup pending"), true,
          "the wrapped refusal remains pending while the recreated ref is retained");
      }
    } finally {
      afterGitUpdateRefDeletion = previousDeletionSeam;
      try {
        if (recreatedReceipt !== undefined) ownership!.track(refPath, recreatedReceipt);
        ownership?.verify();
        ownership?.cleanup();
        if (rootPath !== "") assert.equal(lstatSync(rootPath, { throwIfNoEntry: false }), undefined);
        resolveRefusal?.();
        if (process.env.PI_TEST_SCRATCH_ROOT !== undefined) {
          assert.equal(hasFixtureRefusal("review-checkpoint fixture cleanup pending"), false,
            "the wrapped refusal clears only after receipt-checked rollback");
        }
      } finally {
        if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
        else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
      }
    }
  }
});

test("review-checkpoint fixture cleanup handles failure after the first root allocation", async (t) => {
  const preserve = fixturePreservationRequested();
  let rootPath = "";
  let ownership: FixtureOwnership | undefined;
  t.after(() => ownership?.cleanup());
  const reports: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    reports.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await assert.rejects(
      fixture(async () => {}, (root, current) => {
        rootPath = root;
        ownership = current;
        throw new Error("injected second-allocation failure");
      }),
      /injected second-allocation failure/,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
  if (preserve) {
    assert.ok(await lstatIfExists(rootPath), "explicit preservation retains the first root");
    assert.ok(reports.some((line) => line.includes(rootPath!) && line.includes("PI_TEST_SCRATCH_PRESERVE=1")),
      "the exact retained first-root path is reported");
    ownership!.cleanup();
    assert.equal(await lstatIfExists(rootPath), undefined, "the test-owned preserved root is removed after the assertion");
  } else {
    assert.equal(await lstatIfExists(rootPath), undefined, "default cleanup removes the first root after the injected failure");
  }
});

test("review-checkpoint entries left by a failed payload write are invocation-owned in both teardown modes", async (t) => {
  const preserve = fixturePreservationRequested();
  let rootPath = "";
  let partialPath = "";
  let ownership: FixtureOwnership | undefined;
  t.after(() => ownership?.cleanup());
  const reports: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    reports.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fixture(async (root) => {
      // A fresh entry whose payload write fails halfway: the entry must still be owned.
      const partial = join(root, "partial.txt");
      partialPath = partial;
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
      let writeError: unknown;
      const pendingWrite = writeFile(partial, stream, { encoding: "utf8", flag: "wx" })
        .catch((error: unknown) => { writeError = error; });
      // Poll for the RECEIPT, not the pathname: the gate is still closed, so a receipt that
      // lands now can only have come from the open descriptor, before the payload completed.
      try {
        const deadline = Date.now() + 10_000;
        while (!ownership?.has(partial)) {
          assert.ok(Date.now() < deadline, "the payload write never receipted its entry");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(writeError, undefined, "the fresh entry is receipted while its payload write is still in flight");
      } finally {
        releaseWrite();
        await pendingWrite;
      }
      assert.match(String(writeError), /injected payload failure/);
      assert.notEqual(await lstatIfExists(partial), undefined, "the entry exists before its payload write failed");
    }, (root, current) => {
      rootPath = root;
      ownership = current;
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  if (preserve) {
    assert.notEqual(await lstatIfExists(partialPath), undefined, "explicit preservation retains the partial entry");
    assert.ok(reports.some((line) => line.includes(rootPath) && line.includes("PI_TEST_SCRATCH_PRESERVE=1")),
      "the exact retained partial-write location is reported");
    ownership!.cleanup();
    assert.equal(await lstatIfExists(rootPath), undefined, "the test-owned preserved root is removed after the assertion");
  } else {
    assert.equal(await lstatIfExists(partialPath), undefined, "default teardown removes the entry a failed payload write left");
    assert.equal(await lstatIfExists(rootPath), undefined, "default teardown removes the root");
  }
});

test("review-checkpoint fixture refuses an unexplained descendant and retains evidence", async (t) => {
  let rootPath = "";
  let resolveRefusal: (() => void) | undefined;
  const rollback = new FixtureOwnership();
  t.after(() => { rollback.cleanup(); resolveRefusal?.(); });
  await assert.rejects(
    fixture(async (root) => {
      rollback.track(scope!.agentDir);
      const unknown = join(root, "unexpected.txt");
      await fsWriteFile(unknown, "not receipted\n", { encoding: "utf8", flag: "wx" });
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
    }, (path, _current, resolver) => {
      rootPath = path;
      resolveRefusal = resolver;
      rollback.track(path);
    }),
    /fixture ownership verification failed/,
  );
  assert.ok(await lstatIfExists(rootPath), "the root with an unexplained descendant is retained");
  assert.equal(await readFile(join(rootPath, "unexpected.txt"), "utf8"), "not receipted\n",
    "the unexplained descendant is never deleted");
});

test("a valid unrelated blob introduced during a checkpoint operation is never receipted and is retained", async (t) => {
  let rootPath = "";
  let foreignPath = "";
  let foreignBytes = Buffer.alloc(0);
  let ownership: FixtureOwnership | undefined;
  let bucketReceipt: import("node:fs").BigIntStats | undefined;
  let blobReceipt: import("node:fs").BigIntStats | undefined;
  let resolveRefusal: (() => void) | undefined;
  let rolledBack = false;
  const rollbackEvidence = () => {
    if (rolledBack || !ownership) return;
    // Only the entries this probe created join the fixture's own ledger; a recursive
    // inventory could adopt an entry the probe never created.
    if (bucketReceipt) ownership.track(dirname(foreignPath), bucketReceipt);
    if (blobReceipt) ownership.track(foreignPath, blobReceipt);
    ownership.verify(); // a second unexplained entry keeps the refusal unresolved
    ownership.cleanup();
    rolledBack = true;
    resolveRefusal?.();
  };
  t.after(rollbackEvidence);
  await assert.rejects(
    fixture(async (root) => {
      const repository = join(root, "repo");
      await mkdir(repository, { recursive: true });
      await git(repository, "init", "-q");
      await writeFile(join(repository, "tracked.txt"), "baseline\n");
      await git(repository, "add", "tracked.txt");
      const entry = checkpointScopeForPath(repository)!;
      const objects = join(repository, ".git", "objects");
      const injected = duringGitAttribution;
      // A concurrent writer lands a VALID loose blob with an unrelated id after the
      // operation's pre-check and before its receipts are taken: integrity alone must
      // never make it attributable to this fixture's command.
      duringGitAttribution = async () => {
        duringGitAttribution = undefined; // one shot
        for (let n = 0; ; n++) {
          const body = Buffer.from(`foreign fixture probe ${n}\n`);
          const blob = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
          const id = createHash("sha1").update(blob).digest("hex");
          const bucket = join(objects, id.slice(0, 2));
          if (existsSync(bucket)) continue; // a fresh bucket, never a genuine output's
          fsMkdirSync(bucket); // receipts are held by the injector, not the fixture
          bucketReceipt = lstatSync(bucket, { bigint: true });
          foreignPath = join(bucket, id.slice(2));
          foreignBytes = deflateSync(blob);
          // Synchronous raw write bypasses the production write-receipt seam; this
          // injector owns the receipt it records below, never the fixture.
          fsWriteFileSync(foreignPath, foreignBytes, { flag: "wx" });
          blobReceipt = lstatSync(foreignPath, { bigint: true });
          break;
        }
      };
      try {
        await git(repository, "commit", "-qm", "base");
      } finally {
        duringGitAttribution = injected;
      }
      assert.equal(entry.ownership.has(foreignPath), false, "a valid unrelated blob confers nothing");
      assert.equal(entry.ownership.has(dirname(foreignPath)), false, "its bucket is not attributable either");
      const head = (await gitOutput(repository, ["rev-parse", "HEAD"])).trim();
      assert.ok(entry.ownership.has(join(objects, head.slice(0, 2), head.slice(2))), "the new commit is attributable");
    }, (path, current, resolver) => {
      rootPath = path;
      ownership = current;
      resolveRefusal = resolver;
    }),
    /fixture ownership verification failed/,
  );
  assert.deepEqual(readFileSync(foreignPath), foreignBytes, "the valid foreign object survives teardown");
  rollbackEvidence();
  assert.equal(existsSync(rootPath), false, "the probe removes its own retained evidence after asserting");
});

test("an unrelated file under .git during init is never receipted and is retained", async (t) => {
  let rootPath = "";
  let ownership: FixtureOwnership | undefined;
  let unrelatedPath = "";
  let unrelatedBytes = Buffer.alloc(0);
  let unrelatedReceipt: import("node:fs").BigIntStats | undefined;
  let resolveRefusal: (() => void) | undefined;
  let rolledBack = false;
  const rollbackEvidence = () => {
    if (rolledBack || !ownership) return;
    // Only the file this probe created joins the fixture's own ledger.
    if (unrelatedReceipt) ownership.track(unrelatedPath, unrelatedReceipt);
    ownership.verify(); // a second unexplained entry keeps the refusal unresolved
    ownership.cleanup();
    rolledBack = true;
    resolveRefusal?.();
  };
  t.after(rollbackEvidence);
  await assert.rejects(
    fixture(async (root) => {
      const repository = join(root, "repo");
      await mkdir(repository, { recursive: true });
      const entry = checkpointScopeForPath(repository)!;
      const injected = duringGitAttribution;
      // An unrelated writer lands a file under .git while init is running, before the
      // bounded receipts are taken: enrolling the whole tree would adopt and delete it.
      duringGitAttribution = async (gitDir) => {
        duringGitAttribution = undefined; // one shot
        unrelatedPath = join(gitDir, "UNRELATED-BYTES");
        unrelatedBytes = Buffer.from("not the fixture's\n");
        // Raw synchronous write: the injector alone owns this receipt.
        fsWriteFileSync(unrelatedPath, unrelatedBytes, { flag: "wx" });
        unrelatedReceipt = lstatSync(unrelatedPath, { bigint: true });
      };
      try {
        await git(repository, "init", "-q");
      } finally {
        duringGitAttribution = injected;
      }
      assert.equal(entry.ownership.has(unrelatedPath), false, "an unrelated .git descendant confers nothing");
      assert.ok(entry.ownership.has(join(repository, ".git", "HEAD")), "the known init outputs are still receipted");
      assert.ok(entry.ownership.has(join(repository, ".git", "objects", "pack")),
        "the known init directories are still receipted");
    }, (path, current, resolver) => {
      rootPath = path;
      ownership = current;
      resolveRefusal = resolver;
    }),
    /fixture ownership verification failed/,
  );
  assert.deepEqual(readFileSync(join(rootPath, "repo", ".git", "UNRELATED-BYTES")), unrelatedBytes,
    "the unrelated .git file is retained with its bytes intact");
  rollbackEvidence();
  assert.equal(existsSync(rootPath), false, "the probe removes its own retained evidence after asserting");
});

test("ambient reftable and split-index defaults do not change the receipted Git layout", async () => {
  const prior = process.env.GIT_DEFAULT_REF_FORMAT;
  const priorConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_DEFAULT_REF_FORMAT = "reftable"; // the caller's own default, not the fixture's
  try {
    await fixture(async (root) => {
      // The caller's own global config turns split indexes on; the fixture's `-c` pin must
      // win, otherwise `git add` writes a .git/sharedindex.<hash> file no receipt covers.
      const callerConfig = join(scope!.agentDir, "caller-gitconfig");
      await writeFile(callerConfig, "[core]\n\tsplitIndex = true\n");
      checkpointOutput(callerConfig); // this file is fixture-created output, so it is receipted
      process.env.GIT_CONFIG_GLOBAL = callerConfig;
      await git(root, "init", "-q");
      // The fixture pins the backend, so the bounded init receipts stay exact and the
      // fixture's later operations never meet a legitimate-but-unlisted ref directory.
      assert.equal(existsSync(join(root, ".git", "reftable")), false,
        "the fixture init did not pin the files ref backend");
      assert.equal(lstatSync(join(root, ".git", "refs", "heads"), { bigint: true }).isDirectory(), true,
        "the receipted refs/heads directory exists");
      await writeFile(join(root, "a.txt"), "one\n");
      await git(root, "add", "a.txt");
      assert.deepEqual(readdirSync(join(root, ".git")).filter((name) => name.startsWith("sharedindex.")), [],
        "the fixture does not create an unreceipted shared index");
      await git(root, "commit", "-qm", "base");
      const first = await capture(root, "reftable-default-first");
      assert.equal(first.kind, "git");
      await writeFile(join(root, "a.txt"), "two\n");
      const second = await capture(root, "reftable-default-second");
      const result = await compareReviewCheckpoints(root, first, second, opts());
      assert.equal(result.status, "ok", JSON.stringify(result));
      if (result.status === "ok") {
        assert.equal(result.value.changes.find((c) => c.path === "a.txt")?.old?.bytes?.toString(), "one\n");
      }
      assert.equal((await releaseReviewCheckpoint(root, first, opts())).status, "ok");
      assert.equal((await releaseReviewCheckpoint(root, second, opts())).status, "ok");
    });
  } finally {
    if (prior === undefined) delete process.env.GIT_DEFAULT_REF_FORMAT;
    else process.env.GIT_DEFAULT_REF_FORMAT = prior;
    if (priorConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = priorConfig;
  }
});

test("an allocation whose receipt fails names the retained path in both teardown modes", async () => {
  const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  const originalLstat = fsPromises.lstat;
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    let retained = "";
    let createdReceipt: import("node:fs").BigIntStats | undefined;
    const notices: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      notices.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    let thrown: unknown;
    let resolveFailedAllocation: (() => void) | undefined;
    try {
      // The allocation returns a path; its first receipt then fails. Capture the
      // probe's own creation receipt at the allocation seam, before injecting that
      // failure, so rollback never trusts whatever later occupies the path.
      fsPromises.lstat = (async (path: unknown) => {
        retained = String(path);
        createdReceipt ??= lstatSync(retained, { bigint: true });
        throw new Error("injected receipt failure after allocation");
      }) as unknown as typeof fsPromises.lstat;
      await fixture(async () => { /* never reached: the first allocation receipt fails */ },
        undefined, (_path, resolve) => { resolveFailedAllocation = resolve; });
    } catch (error) {
      thrown = error;
    } finally {
      fsPromises.lstat = originalLstat;
      process.stderr.write = originalWrite;
      if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
      else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
    }
    const mode = preserve ? "preserve" : "default";
    assert.match(String((thrown as Error).message), /injected receipt failure after allocation/,
      `the original allocation error is preserved in ${mode} teardown`);
    const notice = notices.find((line) => line.includes("review-checkpoint fixture cleanup refused; retained"));
    assert.ok(notice !== undefined, `a refusal naming the retained path is reported in ${mode} teardown`);
    assert.ok(notice!.includes(retained), `the diagnostic names the exact allocated path in ${mode} teardown`);
    assert.match(notice!, /the allocated root had no receipt/);
    assert.equal(existsSync(retained), true, `the unverified path is retained in ${mode} teardown`);
    // Remove only the directory this probe created, identified by the receipt taken
    // before the fixture's receipt failed; a non-empty or replaced directory is refused.
    assert.ok(createdReceipt !== undefined, "the probe captured its own creation receipt");
    removeCreatedDirectory(retained, createdReceipt!);
    // Evidence is gone only after this probe positively confirmed its own removal, so
    // the wrapped runner no longer has a reason to retain the invocation root.
    resolveFailedAllocation?.();
  }
});

test("a receipt-failed allocation never removes a replaced empty directory", async () => {
  const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  const originalLstat = fsPromises.lstat;
  for (const preserve of [false, true]) {
    const priorPreserve = process.env.PI_TEST_SCRATCH_PRESERVE;
    if (preserve) process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    else delete process.env.PI_TEST_SCRATCH_PRESERVE;
    let retained = "";
    let createdReceipt: import("node:fs").BigIntStats | undefined;
    let resolveFailedAllocation: (() => void) | undefined;
    let thrown: unknown;
    try {
      fsPromises.lstat = (async (path: unknown) => {
        retained = String(path);
        createdReceipt ??= lstatSync(retained, { bigint: true });
        throw new Error("injected receipt failure after allocation");
      }) as unknown as typeof fsPromises.lstat;
      await fixture(async () => { /* never reached: the first allocation receipt fails */ },
        undefined, (_path, resolve) => { resolveFailedAllocation = resolve; });
    } catch (error) {
      thrown = error;
    } finally {
      fsPromises.lstat = originalLstat;
      if (priorPreserve === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
      else process.env.PI_TEST_SCRATCH_PRESERVE = priorPreserve;
    }
    const mode = preserve ? "preserve" : "default";
    assert.match(String((thrown as Error).message), /injected receipt failure after allocation/,
      `the original allocation error is preserved in ${mode} teardown`);
    assert.ok(createdReceipt !== undefined, "the probe captured its own creation receipt");
    // Replace the original empty allocation with another empty directory that has a
    // different identity. The original is moved aside while it still exists, so the
    // filesystem cannot reuse its inode for the replacement. The receipt-checked
    // rollback must leave the replacement in place.
    const originalPath = `${retained}-original`;
    await fsRename(retained, originalPath);
    fsMkdirSync(retained);
    const replacement = lstatSync(retained, { bigint: true });
    assert.ok(replacement.isDirectory() && !replacement.isSymbolicLink()
      && (replacement.dev !== createdReceipt!.dev || replacement.ino !== createdReceipt!.ino),
    "the replacement is a distinct empty directory");
    assert.throws(() => removeCreatedDirectory(retained, createdReceipt!),
      /refusing to remove a replaced allocation/,
      `the replaced allocation is never removed in ${mode} teardown`);
    assert.equal(existsSync(retained), true, "the replacement survives the receipt-checked rollback");
    if (process.env.PI_TEST_SCRATCH_ROOT !== undefined) {
      assert.equal(hasFixtureRefusal("review-checkpoint fixture cleanup pending"), true,
        "the reservation stays pending while the replacement is retained");
    }
    // Only each entry's own receipt authorizes its removal; confirm both absences before
    // clearing this probe's reservation.
    removeCreatedDirectory(retained, replacement);
    if (process.env.PI_TEST_SCRATCH_ROOT !== undefined) {
      assert.equal(hasFixtureRefusal("review-checkpoint fixture cleanup pending"), true,
        "the reservation stays pending while the displaced original is retained");
    }
    removeCreatedDirectory(originalPath, createdReceipt!);
    resolveFailedAllocation?.();
    if (process.env.PI_TEST_SCRATCH_ROOT !== undefined) {
      assert.equal(hasFixtureRefusal("review-checkpoint fixture cleanup pending"), false,
        "the reservation clears only after both directories' confirmed removal");
    }
  }
});

test("review-checkpoint load does not adopt an unreceipted sibling and teardown retains both", async (t) => {
  let rootPath = "";
  let agentPath = "";
  let captured: ReviewCheckpointDescriptor | undefined;
  let resolveRefusal: (() => void) | undefined;
  let ownership: FixtureOwnership | undefined;
  let injected: { path: string; receipt: import("node:fs").BigIntStats } | undefined;
  t.after(() => {
    if (!ownership) return;
    // Only the entry this probe created joins the fixture's own ledger.
    if (injected) ownership.track(injected.path, injected.receipt);
    ownership.verify(); // a second unexplained entry keeps the refusal unresolved
    ownership.cleanup();
    resolveRefusal?.();
  });
  await assert.rejects(
    fixture(async (root) => {
      await writeFile(join(root, "tracked.txt"), "baseline\n");
      const before = await capture(root, "unreceipted-sibling");
      captured = before;
      agentPath = scope!.agentDir;
      const unknown = join(root, "unexpected-sibling.txt");
      const handle = await fsOpen(unknown, "wx");
      try {
        injected = { path: unknown, receipt: await handle.stat({ bigint: true }) };
        await handle.writeFile("unowned\n");
      } finally { await handle.close(); }
      assert.equal((await loadReviewCheckpoint(root, before, opts())).status, "ok",
        "loading an existing checkpoint still returns its production result");
    }, (path, current, resolver) => {
      rootPath = path;
      ownership = current;
      resolveRefusal = resolver;
    }),
    /fixture ownership verification failed/,
  );
  assert.equal(await readFile(join(rootPath, "unexpected-sibling.txt"), "utf8"), "unowned\n",
    "the unreceipted sibling survives teardown");
  assert.equal(captured?.kind, "raw");
  const record = rawReviewCheckpointRecordPath(
    { agentDir: agentPath, sessionId: "review-checkpoint-session" },
    await realpath(rootPath),
    captured!,
  );
  assert.ok((await lstat(record)).isFile(), "the receipted checkpoint record is retained with the sibling");
});

test("review-checkpoint fixture cleanup keeps the original body failure and honors teardown mode", async (t) => {
  const preserve = fixturePreservationRequested();
  let rootPath = "";
  let agentPath = "";
  let ownership: FixtureOwnership | undefined;
  t.after(() => ownership?.cleanup());
  await assert.rejects(
    fixture(async (root) => {
      rootPath = root;
      agentPath = scope!.agentDir;
      await writeFile(join(root, "partial.txt"), "partial setup\n", { encoding: "utf8", flag: "wx" });
      throw new Error("deliberate review-checkpoint body failure");
    }, (_root, current) => { ownership = current; }),
    /deliberate review-checkpoint body failure/,
  );
  if (preserve) {
    assert.ok(await lstatIfExists(rootPath), "explicit preservation retains the failed body's worktree");
    assert.ok(await lstatIfExists(agentPath), "explicit preservation retains the failed body's agent directory");
    ownership!.cleanup();
    assert.equal(await lstatIfExists(rootPath), undefined, "the failed body's worktree is removed after the assertion");
    assert.equal(await lstatIfExists(agentPath), undefined, "the failed body's agent directory is removed after the assertion");
  } else {
    assert.equal(await lstatIfExists(rootPath), undefined, "the failed body's worktree is removed");
    assert.equal(await lstatIfExists(agentPath), undefined, "the failed body's agent directory is removed");
  }
});
