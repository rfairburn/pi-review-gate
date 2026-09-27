/* Durable parent-review checkpoints. No live second read is used for comparison.
 * Git uses the pinned commit/patch backend; non-Git uses the same raw-entry
 * representation as Git's non-ignored untracked entries for EVERY eligible file.
 * This module does not restore or write a target index.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { promisify } from "node:util";
import {
  armGitCheckpoint, loadGitCheckpoint, compareGitCheckpoints, releaseGitCheckpointPin,
  isSafeWindowId, type GitCheckpointDescriptor, type GitCheckpointOptions,
  type GitCheckpointResult, type GitCheckpointRecord, type GitCheckpointUntrackedEntry,
} from "./git-checkpoint";

const exec = promisify(execFile);
const FORMAT = "prg-parent-raw/v1";
const STORE = join(".pi-review-gate", "checkpoints");
const MAX_BYTES = 512 * 1024 * 1024;

export type ReviewCheckpointDescriptor =
  | { kind: "git"; checkpoint: GitCheckpointDescriptor }
  | { kind: "raw"; format: typeof FORMAT; root: string; windowId: string; owner: string; digest: string };
export type ReviewCheckpointResult<T> = GitCheckpointResult<T> | { status: "failed"; reason: "raw_checkpoint_failed"; detail: string };
export interface ReviewCheckpointState { kind: "file" | "symlink"; mode: number; bytes?: Buffer; target?: string }
export interface ReviewCheckpointChange { path: string; old?: ReviewCheckpointState; new?: ReviewCheckpointState }
export interface ReviewCheckpointComparison { changes: ReviewCheckpointChange[] }
interface RawRecord { format: typeof FORMAT; owner: string; entries: GitCheckpointUntrackedEntry[] }

function fail(detail: string): ReviewCheckpointResult<never> { return { status: "failed", reason: "raw_checkpoint_failed", detail }; }
function errorOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safePath(path: string): boolean {
  return path.length > 0 && !path.includes("\0") && !path.includes("\uFFFD")
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}
function selectedPath(path: string, selectors: ReadonlySet<string>): boolean {
  if (selectors.has(path)) return true;
  let slash = path.indexOf("/");
  while (slash >= 0) {
    if (selectors.has(path.slice(0, slash))) return true;
    slash = path.indexOf("/", slash + 1);
  }
  return false;
}
function identity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function checkAbort(options: GitCheckpointOptions): void {
  if (options.signal?.aborted) throw new Error("checkpoint aborted");
}
async function command(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  try {
    const out = await exec("git", args, { cwd, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: out.stdout };
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    if (typeof e.code === "number") return { code: e.code, stdout: e.stdout ?? "" };
    throw error;
  }
}
async function ensureRoot(root: string): Promise<string> {
  const absolute = resolve(root);
  const s = await lstat(absolute);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("root must be a real directory");
  return realpath(absolute);
}
async function storePath(root: string): Promise<string> {
  const top = join(root, ".pi-review-gate");
  const dir = join(root, STORE);
  for (const path of [top, dir]) {
    try { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`unsafe checkpoint directory ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(path); }
  }
  // This namespace is excluded from captures to avoid including our own
  // records. Reject user content there instead of silently omitting it.
  if ((await readdir(top)).some((name) => name !== "checkpoints")) throw new Error("checkpoint namespace contains unrelated content");
  if (!(await readdir(dir)).every((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}-[0-9a-f]{32}$/.test(name)))
    throw new Error("checkpoint store contains unrelated content");
  return dir;
}
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Persist each directory entry created for the raw record, through root. */
async function syncAncestorChain(owned: string, root: string): Promise<void> {
  let current = dirname(owned);
  while (true) {
    await syncDirectory(current);
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) throw new Error("checkpoint directory escaped root");
    current = parent;
  }
}

async function existingStore(root: string): Promise<string> {
  const dir = join(root, STORE);
  for (const path of [join(root, ".pi-review-gate"), dir]) {
    const s = await lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("checkpoint store is not an owned directory");
  }
  return dir;
}
type GitRoot = { kind: "git"; root: string } | { kind: "raw" | "broken" };
async function gitRoot(root: string): Promise<GitRoot> {
  const out = await command(root, ["rev-parse", "--show-toplevel"]);
  if (out.code === 0) {
    const top = out.stdout.endsWith("\r\n") ? out.stdout.slice(0, -2)
      : out.stdout.endsWith("\n") ? out.stdout.slice(0, -1)
        : out.stdout;
    if (!top) return { kind: "broken" };
    return { kind: "git", root: await realpath(resolve(top)) };
  }
  if (process.env.GIT_DIR) return { kind: "broken" };
  // A failed rev-parse is not evidence of a non-Git root: broken or
  // unreadable metadata may be in an ancestor, not only at this root.
  // Respect Git's explicit discovery ceilings (also used by isolated tests).
  const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? "").split(":").map((part) => resolve(part)));
  let dir = root;
  while (true) {
    try { await lstat(join(dir, ".git")); return { kind: "broken" }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(dir);
    if (parent === dir || ceilings.has(parent)) break;
    dir = parent;
  }
  return { kind: "raw" };
}
async function gitCheckpointRoot(root: string): Promise<string> {
  const dir = await ensureRoot(root);
  const repository = await gitRoot(dir);
  return repository.kind === "git" ? repository.root : dir;
}

/** Resolve the review-tree root without changing the selected Pi/session cwd. */
export async function reviewCheckpointWorkspaceRoot(root: string, descriptor: ReviewCheckpointDescriptor): Promise<string> {
  return descriptor.kind === "git" ? gitCheckpointRoot(root) : ensureRoot(root);
}

async function walk(root: string, path: string, files: string[], ignores: string[], options: GitCheckpointOptions): Promise<void> {
  checkAbort(options);
  const dir = join(root, path);
  const before = await lstat(dir);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`directory changed: ${path}`);
  for (const name of (await readdir(dir)).sort()) {
    if (path === "" && (name === ".git" || name === ".pi-review-gate")) continue;
    const rel = path ? `${path}/${name}` : name;
    if (!safePath(rel) || Buffer.from(rel).toString("utf8") !== rel) throw new Error("unrepresentable path");
    const s = await lstat(join(root, rel));
    if (s.isDirectory()) await walk(root, rel, files, ignores, options);
    else if (s.isFile() || s.isSymbolicLink()) {
      files.push(rel);
      if (name === ".gitignore" && s.isFile()) ignores.push(rel);
    } else throw new Error(`unsupported filesystem entry: ${rel}`);
  }
  if (!identity(before, await lstat(dir))) throw new Error(`directory changed during enumeration: ${path}`);
}
async function ignoredPaths(root: string, candidates: string[], hasIgnore: boolean, store: string): Promise<Set<string>> {
  if (!hasIgnore) return new Set();
  // Git's own wildmatch and hierarchy semantics, using an isolated metadata
  // directory, not a .git in the target. The global excludes are enabled only
  // when at least one project .gitignore exists anywhere in the root.
  const scratch = await mkdtemp(join(store, "ignore-"));
  try {
    const repo = join(scratch, "repo.git");
    // Ambient templates can install info/exclude, which is not part of the
    // non-Git root's eligible project/global ignore policy.
    const template = join(scratch, "empty-template");
    await mkdir(template);
    const init = await command(root, ["init", "--bare", "-q", `--template=${template}`, repo]);
    if (init.code !== 0) throw new Error("cannot initialize ignore matcher");
    const ignored = new Set<string>();
    // Batch bounded NUL-delimited requests. One process per path scales
    // quadratically on large roots and makes capture needlessly slow.
    let batch: string[] = [], length = 0;
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const output = await new Promise<Buffer>((done, reject) => {
        const child = spawn("git", [`--git-dir=${repo}`, `--work-tree=${root}`, "check-ignore", "--no-index", "-z", "--stdin"],
          { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
        const parts: Buffer[] = [];
        let size = 0, stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) child.kill("SIGKILL");
          else parts.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 2048); });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (size > 4 * 1024 * 1024 || (code !== 0 && code !== 1)) reject(new Error(`ignore matching failed: ${stderr || code}`));
          else done(Buffer.concat(parts));
        });
        child.stdin.on("error", (error) => { child.kill("SIGKILL"); reject(error); });
        child.stdin.end(Buffer.from(batch.join("\0") + "\0"));
      });
      for (const entry of output.toString("utf8").split("\0")) if (entry) {
        if (!batch.includes(entry)) throw new Error("ignore matcher returned unknown path");
        ignored.add(entry);
      }
      batch = []; length = 0;
    };
    for (const path of candidates) {
      if (Buffer.byteLength(path) > 1024 * 1024) throw new Error("path exceeds ignore matcher cap");
      if (length + Buffer.byteLength(path) > 1024 * 1024) await flush();
      batch.push(path); length += Buffer.byteLength(path) + 1;
    }
    await flush();
    return ignored;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
async function rawEntry(root: string, path: string, options: GitCheckpointOptions): Promise<GitCheckpointUntrackedEntry> {
  checkAbort(options);
  let parent = root;
  const parents: Stats[] = [];
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    const s = await lstat(parent);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`unsafe parent for ${path}`);
    parents.push(s);
  }
  const absolute = join(root, path);
  const pre = await lstat(absolute);
  if (!pre.isFile() && !pre.isSymbolicLink()) throw new Error(`unsupported entry ${path}`);
  if (pre.size > MAX_BYTES) throw new Error(`entry too large: ${path}`);
  let contentB64: string | undefined;
  let target: string | undefined;
  if (pre.isFile()) {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!identity(pre, await handle.stat())) throw new Error(`file raced: ${path}`);
      const bytes = Buffer.alloc(pre.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error(`short read: ${path}`);
        offset += bytesRead;
      }
      if (!identity(pre, await handle.stat())) throw new Error(`file raced: ${path}`);
      contentB64 = bytes.toString("base64");
    } finally { await handle.close(); }
  } else {
    target = await readlink(absolute);
    if (!target || target.includes("\uFFFD") || Buffer.from(target).toString("utf8") !== target) throw new Error(`unrepresentable symlink: ${path}`);
  }
  if (!identity(pre, await lstat(absolute))) throw new Error(`entry raced: ${path}`);
  parent = root;
  let i = 0;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    const s = await lstat(parent);
    if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== parents[i]!.dev || s.ino !== parents[i]!.ino || s.mode !== parents[i]!.mode) throw new Error(`parent raced: ${path}`);
    i++;
  }
  return { path, kind: pre.isFile() ? "file" : "symlink", mode: pre.mode, dev: pre.dev, ino: pre.ino,
    size: pre.size, mtimeMs: pre.mtimeMs, ctimeMs: pre.ctimeMs, ...(contentB64 === undefined ? { target } : { contentB64 }) };
}

/** Capture a Git pin/patch record or a durable raw record (never a WorkspaceSnapshot). */
export async function captureReviewCheckpoint(root: string, windowId: string, options: GitCheckpointOptions = {}): Promise<ReviewCheckpointResult<ReviewCheckpointDescriptor>> {
  try {
    if (!isSafeWindowId(windowId)) return fail("unsafe window id");
    const dir = await ensureRoot(root);
    const strategy = await gitRoot(dir);
    if (strategy.kind === "broken") return fail("broken Git metadata; refusing raw fallback");
    if (strategy.kind === "git") {
      const armed = await armGitCheckpoint(strategy.root, windowId, options);
      return armed.status === "ok" ? { status: "ok", value: { kind: "git", checkpoint: armed.value.descriptor } } : armed;
    }
    const store = await storePath(dir);
    const owner = randomBytes(16).toString("hex");
    const owned = join(store, `${windowId}-${owner}`);
    await mkdir(owned);
    let published = false;
    try {
      // mkdir(owned) and storePath may have created directory entries in
      // store, .pi-review-gate and root. Sync their parents before publishing
      // a descriptor, just as the Git checkpoint arm syncs its scratch chain.
      await syncAncestorChain(owned, dir);
      const files: string[] = [], ignores: string[] = [];
      await walk(dir, "", files, ignores, options);
      const ignoreEntries = await Promise.all(ignores.map((path) => rawEntry(dir, path, options)));
      const excluded = await ignoredPaths(dir, files, ignores.length > 0, store);
      const entries: GitCheckpointUntrackedEntry[] = [];
      let bytes = 0;
      for (const path of files) {
        if (excluded.has(path)) continue;
        const entry = await rawEntry(dir, path, options);
        bytes += entry.size;
        if (bytes > MAX_BYTES) throw new Error("raw checkpoint exceeds byte cap");
        entries.push(entry);
      }
      // Fail closed when ignore rules, included entries, or the enumerated
      // path set shifted while the capture was in flight. No second content
      // read is performed at comparison time; these checks are capture-only.
      for (let i = 0; i < ignores.length; i++) {
        const current = await rawEntry(dir, ignores[i]!, options);
        if (JSON.stringify(current) !== JSON.stringify(ignoreEntries[i])) throw new Error("ignore rule changed during capture");
      }
      for (const entry of entries) {
        const s = await lstat(join(dir, entry.path));
        if (s.dev !== entry.dev || s.ino !== entry.ino || s.mode !== entry.mode || s.size !== entry.size
          || s.mtimeMs !== entry.mtimeMs || s.ctimeMs !== entry.ctimeMs) throw new Error(`entry changed during capture: ${entry.path}`);
      }
      const filesAfter: string[] = [], ignoresAfter: string[] = [];
      await walk(dir, "", filesAfter, ignoresAfter, options);
      if (JSON.stringify(filesAfter) !== JSON.stringify(files) || JSON.stringify(ignoresAfter) !== JSON.stringify(ignores)) throw new Error("path enumeration changed during capture");
      const payload = Buffer.from(JSON.stringify({ format: FORMAT, owner, entries } satisfies RawRecord));
      const record = join(owned, "record.json");
      const tmp = join(owned, "record.tmp");
      const handle = await open(tmp, "wx", 0o600);
      try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
      await rename(tmp, record);
      const dh = await open(owned, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await dh.sync(); } finally { await dh.close(); }
      published = true;
      return { status: "ok", value: { kind: "raw", format: FORMAT, root: dir, windowId, owner, digest: sha(payload) } };
    } finally { if (!published) await rm(owned, { recursive: true, force: true }); }
  } catch (error) { return fail(errorOf(error)); }
}

/** Compose verified old raw entries with a frozen capture of selected live paths.
 * The old descriptor remains intact; unrelated live bytes are never read. */
export async function advanceRawReviewCheckpoint(
  root: string, descriptor: Extract<ReviewCheckpointDescriptor, { kind: "raw" }>,
  landedPaths: readonly string[], checkpointId: string, options: GitCheckpointOptions = {},
): Promise<ReviewCheckpointResult<Extract<ReviewCheckpointDescriptor, { kind: "raw" }>>> {
  let owned: string | undefined;
  let published = false;
  try {
    if (!isSafeWindowId(checkpointId)) throw new Error("unsafe checkpoint id");
    if (!Array.isArray(landedPaths) || landedPaths.some((path) => typeof path !== "string" || !safePath(path)
      || Buffer.from(path).toString("utf8") !== path)) throw new Error("unsafe landed path");
    const selected = new Set(landedPaths);
    const old = await loadReviewCheckpoint(root, descriptor, options);
    if (old.status !== "ok") return old;
    if (old.value.kind !== "raw") throw new Error("expected raw checkpoint");
    const dir = await ensureRoot(root);
    if ((await gitRoot(dir)).kind !== "raw") throw new Error("raw root became a Git repository during advancement");
    const store = await existingStore(dir);
    const files: string[] = [], ignores: string[] = [];
    await walk(dir, "", files, ignores, options);
    const ignoreEntries = await Promise.all(ignores.map((path) => rawEntry(dir, path, options)));
    // Enumerate the entire path set for consistency, but read bytes only for
    // selected eligible entries; unrelated large files never consume the cap.
    const selectedFiles = files.filter((path) => selectedPath(path, selected));
    const excluded = await ignoredPaths(dir, selectedFiles, ignores.length > 0, store);
    const liveEntries: GitCheckpointUntrackedEntry[] = [];
    for (const path of selectedFiles) {
      if (!excluded.has(path)) liveEntries.push(await rawEntry(dir, path, options));
    }
    for (let i = 0; i < ignores.length; i++) {
      if (JSON.stringify(await rawEntry(dir, ignores[i]!, options)) !== JSON.stringify(ignoreEntries[i]))
        throw new Error("ignore rule changed during selected capture");
    }
    for (const entry of liveEntries) {
      const s = await lstat(join(dir, entry.path));
      if (s.dev !== entry.dev || s.ino !== entry.ino || s.mode !== entry.mode || s.size !== entry.size
        || s.mtimeMs !== entry.mtimeMs || s.ctimeMs !== entry.ctimeMs) throw new Error(`selected entry changed: ${entry.path}`);
    }
    const filesAfter: string[] = [], ignoresAfter: string[] = [];
    await walk(dir, "", filesAfter, ignoresAfter, options);
    if (JSON.stringify(filesAfter) !== JSON.stringify(files) || JSON.stringify(ignoresAfter) !== JSON.stringify(ignores))
      throw new Error("path enumeration changed during selected capture");
    const entries = [
      ...old.value.entries.filter((entry) => !selectedPath(entry.path, selected)),
      ...liveEntries,
    ].sort((a, b) => a.path.localeCompare(b.path));
    let bytes = 0;
    for (let i = 0; i < entries.length; i++) {
      const path = entries[i]!.path;
      if (i > 0 && (path === entries[i - 1]!.path || path.startsWith(`${entries[i - 1]!.path}/`)))
        throw new Error(`selected paths conflict with retained baseline: ${path}`);
      bytes += entries[i]!.size;
      if (bytes > MAX_BYTES) throw new Error("advanced raw checkpoint exceeds byte cap");
    }
    // Recheck ownership before publishing a composite of the two sources.
    const verified = await loadReviewCheckpoint(root, descriptor, options);
    if (verified.status !== "ok") return verified;
    checkAbort(options);
    const owner = randomBytes(16).toString("hex");
    owned = join(store, `${checkpointId}-${owner}`);
    await mkdir(owned);
    await syncAncestorChain(owned, dir);
    const payload = Buffer.from(JSON.stringify({ format: FORMAT, owner, entries } satisfies RawRecord));
    const handle = await open(join(owned, "record.tmp"), "wx", 0o600);
    try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
    await rename(join(owned, "record.tmp"), join(owned, "record.json"));
    await syncDirectory(owned);
    const result: Extract<ReviewCheckpointDescriptor, { kind: "raw" }> = { kind: "raw", format: FORMAT, root: dir, windowId: checkpointId, owner, digest: sha(payload) };
    const finalOld = await loadReviewCheckpoint(root, descriptor, options);
    if (finalOld.status !== "ok") return finalOld;
    checkAbort(options);
    published = true;
    return { status: "ok", value: result };
  } catch (error) { return fail(errorOf(error)); }
  finally {
    if (!published && owned) await rm(owned, { recursive: true, force: true });
  }
}

/** Read-only pre-task guard for raw checkpoints. Metadata drift conservatively
 * counts as a parent change, including unreadable/oversized unselected files;
 * no current content is ever substituted for a parent checkpoint entry. */
export async function changedRawCheckpointPaths(root: string, descriptor: Extract<ReviewCheckpointDescriptor, { kind: "raw" }>, options: GitCheckpointOptions = {}): Promise<ReviewCheckpointResult<Set<string>>> {
  try {
    const old = await loadReviewCheckpoint(root, descriptor, options);
    if (old.status !== "ok") return old;
    if (old.value.kind !== "raw") throw new Error("expected raw checkpoint");
    const dir = await ensureRoot(root);
    if ((await gitRoot(dir)).kind !== "raw") throw new Error("raw root became a Git repository");
    const files: string[] = [], ignores: string[] = [];
    await walk(dir, "", files, ignores, options);
    const store = await existingStore(dir);
    const excluded = await ignoredPaths(dir, files, ignores.length > 0, store);
    const current = new Set(files.filter((path) => !excluded.has(path)));
    const changed = new Set<string>();
    const previous = new Map(old.value.entries.map((entry) => [entry.path, entry]));
    for (const path of current) {
      const prior = previous.get(path);
      if (!prior) { changed.add(path); continue; }
      const s = await lstat(join(dir, path));
      if (s.dev !== prior.dev || s.ino !== prior.ino || s.mode !== prior.mode || s.size !== prior.size
        || s.mtimeMs !== prior.mtimeMs || s.ctimeMs !== prior.ctimeMs) changed.add(path);
    }
    for (const path of previous.keys()) if (!current.has(path)) changed.add(path);
    const filesAfter: string[] = [], ignoresAfter: string[] = [];
    await walk(dir, "", filesAfter, ignoresAfter, options);
    if (JSON.stringify(filesAfter) !== JSON.stringify(files) || JSON.stringify(ignoresAfter) !== JSON.stringify(ignores))
      throw new Error("path enumeration changed during pre-task guard");
    const verified = await loadReviewCheckpoint(root, descriptor, options);
    if (verified.status !== "ok") return verified;
    return { status: "ok", value: changed };
  } catch (error) { return fail(errorOf(error)); }
}

function validateDescriptor(value: ReviewCheckpointDescriptor): asserts value is Extract<ReviewCheckpointDescriptor, { kind: "raw" }> {
  if (value?.kind !== "raw" || value.format !== FORMAT || !isSafeWindowId(value.windowId)
    || !/^[0-9a-f]{32}$/.test(value.owner) || !/^[0-9a-f]{64}$/.test(value.digest)
    || typeof value.root !== "string" || !value.root.startsWith("/")) throw new Error("malformed raw descriptor");
}
/** Verify owner, root, stored digest, record schema and each raw entry before use. */
export async function loadReviewCheckpoint(root: string, descriptor: ReviewCheckpointDescriptor, options: GitCheckpointOptions = {}): Promise<ReviewCheckpointResult<{ kind: "git"; record: GitCheckpointRecord } | { kind: "raw"; entries: GitCheckpointUntrackedEntry[] }>> {
  if (descriptor?.kind === "git") {
    let checkpointRoot: string;
    try { checkpointRoot = await gitCheckpointRoot(root); }
    catch { checkpointRoot = resolve(root); }
    const result = await loadGitCheckpoint(checkpointRoot, descriptor.checkpoint, options);
    return result.status === "ok" ? { status: "ok", value: { kind: "git", record: result.value.record } } : result;
  }
  try {
    validateDescriptor(descriptor);
    checkAbort(options);
    const dir = await ensureRoot(root);
    if (dir !== descriptor.root) throw new Error("wrong root");
    const store = await existingStore(dir);
    const owned = join(store, `${descriptor.windowId}-${descriptor.owner}`);
    const os = await lstat(owned);
    if (!os.isDirectory() || os.isSymbolicLink()) throw new Error("unsafe owner directory");
    const path = join(owned, "record.json");
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_BYTES * 2 + 1024 * 1024) throw new Error("unsafe record");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      if (!identity(s, await handle.stat())) throw new Error("record raced");
      bytes = await handle.readFile();
      if (!identity(s, await handle.stat()) || bytes.length !== s.size) throw new Error("record raced");
    } finally { await handle.close(); }
    if (!identity(s, await lstat(path)) || sha(bytes) !== descriptor.digest) throw new Error("record digest/identity mismatch");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("record is not valid UTF-8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid record");
    const record = parsed as RawRecord;
    if (record.format !== FORMAT || record.owner !== descriptor.owner || !Array.isArray(record.entries)) throw new Error("record owner/format mismatch");
    const paths = new Set<string>();
    let size = 0;
    for (const entry of record.entries) {
      if (!entry || typeof entry.path !== "string" || !safePath(entry.path) || Buffer.from(entry.path).toString("utf8") !== entry.path
        || paths.has(entry.path) || entry.path === ".pi-review-gate" || entry.path.startsWith(".pi-review-gate/")
        || typeof entry.mode !== "number" || !Number.isInteger(entry.mode) || !Number.isFinite(entry.size) || entry.size < 0
        || ![entry.dev, entry.ino, entry.mtimeMs, entry.ctimeMs].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error("invalid raw entry");
      paths.add(entry.path);
      if (entry.kind === "file") {
        if ((entry.mode & 0o170000) !== 0o100000 || typeof entry.contentB64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.contentB64)
          || Buffer.byteLength(entry.contentB64, "base64") !== entry.size) throw new Error("invalid file content");
      } else if (entry.kind === "symlink") {
        if ((entry.mode & 0o170000) !== 0o120000 || typeof entry.target !== "string" || !entry.target.length
          || entry.target.includes("\uFFFD") || Buffer.from(entry.target).toString("utf8") !== entry.target
          || Buffer.byteLength(entry.target) !== entry.size) throw new Error("invalid symlink target");
      } else throw new Error("invalid entry kind");
      size += entry.size;
      if (size > MAX_BYTES) throw new Error("raw byte cap exceeded");
    }
    return { status: "ok", value: { kind: "raw", entries: record.entries } };
  } catch (error) { return fail(errorOf(error)); }
}
function state(entry: GitCheckpointUntrackedEntry): ReviewCheckpointState {
  return entry.kind === "file" ? { kind: "file", mode: entry.mode, bytes: Buffer.from(entry.contentB64!, "base64") }
    : { kind: "symlink", mode: entry.mode, target: entry.target };
}
function sameState(old: ReviewCheckpointState | undefined, next: ReviewCheckpointState | undefined): boolean {
  if (!old || !next || old.kind !== next.kind || old.mode !== next.mode) return false;
  if (old.kind === "file") return Buffer.isBuffer(old.bytes) && Buffer.isBuffer(next.bytes) && old.bytes.equals(next.bytes);
  return typeof old.target === "string" && old.target === next.target;
}
/** Compare two independently verified frozen records, never the current worktree. */
export async function compareReviewCheckpoints(root: string, before: ReviewCheckpointDescriptor, after: ReviewCheckpointDescriptor, options: GitCheckpointOptions = {}): Promise<ReviewCheckpointResult<ReviewCheckpointComparison>> {
  if (before.kind === "git" && after.kind === "git") {
    let checkpointRoot: string;
    try { checkpointRoot = await gitCheckpointRoot(root); }
    catch (error) { return fail(errorOf(error)); }
    const compared = await compareGitCheckpoints(checkpointRoot, before.checkpoint, after.checkpoint, options, true);
    if (compared.status !== "ok") return compared;
    // Tracked symlinks are Git blobs, not necessarily UTF-8 text. Refuse a
    // lossy decode before sameState can collapse distinct targets to U+FFFD.
    for (const item of compared.value.trackedChanges) {
      for (const [kind, bytes] of [[item.oldKind, item.oldBytes], [item.newKind, item.newBytes]] as const) {
        if (kind === "symlink" && (!bytes || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)))
          return fail(`tracked symlink target is not valid UTF-8: ${item.path}`);
      }
    }
    const changes: ReviewCheckpointChange[] = compared.value.trackedChanges.map((item) => ({ path: item.path,
      old: item.oldKind ? { kind: item.oldKind, mode: item.oldKind === "file" ? 0o100000 | (item.oldMode ?? 0) : 0o120777, ...(item.oldKind === "file" ? { bytes: item.oldBytes } : { target: item.oldBytes?.toString("utf8") }) } : undefined,
      new: item.newKind ? { kind: item.newKind, mode: item.newKind === "file" ? 0o100000 | (item.newMode ?? 0) : 0o120777, ...(item.newKind === "file" ? { bytes: item.newBytes } : { target: item.newBytes?.toString("utf8") }) } : undefined }));
    const merged = new Map(changes.map((change) => [change.path, change]));
    for (const item of compared.value.untrackedChanges) {
      const existing = merged.get(item.path);
      const old = item.old && { kind: item.old.kind, mode: item.old.mode, bytes: item.old.content, target: item.old.target };
      const next = item.new && { kind: item.new.kind, mode: item.new.mode, bytes: item.new.content, target: item.new.target };
      merged.set(item.path, { path: item.path, old: old ?? existing?.old, new: next ?? existing?.new });
    }
    return { status: "ok", value: { changes: [...merged.values()].filter((item) => !sameState(item.old, item.new)).sort((a, b) => a.path.localeCompare(b.path)) } };
  }
  if (before.kind !== "raw" || after.kind !== "raw") return fail("mixed Git/raw checkpoints cannot be compared");
  const a = await loadReviewCheckpoint(root, before, options);
  if (a.status !== "ok") return a;
  const b = await loadReviewCheckpoint(root, after, options);
  if (b.status !== "ok") return b;
  if (a.value.kind !== "raw" || b.value.kind !== "raw") return fail("unexpected checkpoint kind");
  const old = new Map(a.value.entries.map((entry) => [entry.path, entry]));
  const next = new Map(b.value.entries.map((entry) => [entry.path, entry]));
  const changes: ReviewCheckpointChange[] = [];
  for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const left = old.get(path), right = next.get(path);
    if (left && right && left.kind === right.kind && left.mode === right.mode
      && (left.kind === "file" ? left.contentB64 === right.contentB64 : left.target === right.target)) continue;
    changes.push({ path, old: left && state(left), new: right && state(right) });
  }
  return { status: "ok", value: { changes } };
}
/** Release only the descriptor's verified owner. A failed verification deletes nothing. */
export async function releaseReviewCheckpoint(root: string, descriptor: ReviewCheckpointDescriptor, options: GitCheckpointOptions = {}): Promise<ReviewCheckpointResult<void>> {
  if (descriptor.kind === "git") {
    const loaded = await loadReviewCheckpoint(root, descriptor, options);
    if (loaded.status !== "ok") return loaded;
    let checkpointRoot: string;
    try { checkpointRoot = await gitCheckpointRoot(root); }
    catch (error) { return fail(errorOf(error)); }
    const released = await releaseGitCheckpointPin(checkpointRoot, descriptor.checkpoint.windowId, { ...options, expectedBase: descriptor.checkpoint.base, armId: descriptor.checkpoint.armId });
    return released.status === "ok" ? { status: "ok", value: undefined } : released;
  }
  const loaded = await loadReviewCheckpoint(root, descriptor, options);
  if (loaded.status !== "ok") return loaded;
  try {
    validateDescriptor(descriptor);
    const dir = await ensureRoot(root);
    const store = await existingStore(dir);
    const owned = join(store, `${descriptor.windowId}-${descriptor.owner}`);
    // No recursive parent deletion; the validated owner directory is this
    // generation's only removal target.
    if (relative(store, owned).startsWith("..")) throw new Error("unsafe owner path");
    await rm(owned, { recursive: true });
    return { status: "ok", value: undefined };
  } catch (error) { return fail(errorOf(error)); }
}
