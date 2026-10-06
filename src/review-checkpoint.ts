/* Durable parent-review checkpoints. No live second read is used for comparison.
 * Git uses the pinned commit/patch backend; non-Git uses the same raw-entry
 * representation as Git's non-ignored untracked entries for EVERY eligible file.
 * This module does not restore or write a target index.
 *
 * Raw (non-Git) records never live inside a workspace (#301). Every raw record
 * is stored in the live Pi session's external namespace under the Pi-resolved
 * agent-data directory:
 *
 *   <agentDir>/sessions/pi-review-gate/<sessionId>/checkpoints/<workspace-key>/<windowId>-<owner>/record.json
 *
 * for persisted and in-memory (`--no-session`) sessions alike. The location is
 * derived only from the trusted caller scope (live session id + agent dir) and
 * the canonical workspace root, never from a stored descriptor path or the
 * conversation file's directory.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { promisify } from "node:util";
import {
  armGitCheckpoint, loadGitCheckpoint, compareGitCheckpoints, releaseGitCheckpointPin,
  gitCheckpointDiscoveryEnv, isSafeWindowId, type GitCheckpointDescriptor, type GitCheckpointOptions,
  type GitCheckpointResult, type GitCheckpointRecord, type GitCheckpointUntrackedEntry,
} from "./git-checkpoint";
import { piAgentDir, type ConfigPathResolution } from "./config-path";

const exec = promisify(execFile);
const FORMAT = "prg-parent-raw/v2";
/** Current raw descriptor format. Earlier raw formats are not accepted. */
export const RAW_REVIEW_CHECKPOINT_FORMAT = FORMAT;
const MAX_BYTES = 512 * 1024 * 1024;
/** Pi's conversation-session directory name inside the agent-data directory. */
const SESSIONS_DIRECTORY = "sessions";
/** This extension's namespace inside `<agentDir>/sessions`. */
const SESSION_NAMESPACE = "pi-review-gate";
const CHECKPOINTS_DIRECTORY = "checkpoints";
/** Detail prefix for owned-record damage (missing/corrupt record data) that a
 * restart may treat as recoverable. Identity, scope, and storage-location
 * failures never carry it. */
export const RAW_CHECKPOINT_DAMAGE_PREFIX = "checkpoint record damaged: ";

/**
 * Trusted live-session storage scope supplied by the caller (never read from a
 * descriptor). `sessionId` is the live Pi session id (present for persisted
 * and in-memory sessions); `agentDir` is Pi's resolved agent-data directory.
 */
export interface ReviewCheckpointScope {
  readonly agentDir: string;
  readonly sessionId: string;
}
export type ReviewCheckpointOptions = GitCheckpointOptions & { scope?: ReviewCheckpointScope };

export type ReviewCheckpointDescriptor =
  | { kind: "git"; checkpoint: GitCheckpointDescriptor }
  | { kind: "raw"; format: typeof FORMAT; sessionId: string; root: string; windowId: string; owner: string; digest: string };
export type ReviewCheckpointResult<T> = GitCheckpointResult<T> | { status: "failed"; reason: "raw_checkpoint_failed"; detail: string };
export interface ReviewCheckpointState { kind: "file" | "symlink"; mode: number; bytes?: Buffer; target?: string }
export interface ReviewCheckpointChange { path: string; old?: ReviewCheckpointState; new?: ReviewCheckpointState }
export interface ReviewCheckpointComparison { changes: ReviewCheckpointChange[] }
interface RawRecord { format: typeof FORMAT; sessionId: string; root: string; windowId: string; owner: string; entries: GitCheckpointUntrackedEntry[] }
type RawDescriptor = Extract<ReviewCheckpointDescriptor, { kind: "raw" }>;

/** Owned-record damage: carries the recoverable-damage prefix. */
class RawCheckpointDamage extends Error {
  constructor(detail: string) { super(`${RAW_CHECKPOINT_DAMAGE_PREFIX}${detail}`); }
}

function fail(detail: string): ReviewCheckpointResult<never> { return { status: "failed", reason: "raw_checkpoint_failed", detail }; }
function errorOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
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
function fileHandleIdentity(pathStat: Stats, handleStat: Stats): boolean {
  // NTFS path lstat can omit the volume ID while fstat reports it. Normalize
  // only that cross-API mismatch; path/path checks and every other field stay strict.
  return identity(pathStat, process.platform === "win32" && pathStat.dev === 0
    ? { ...handleStat, dev: 0 } : handleStat);
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

/** Windows reserved device names are invalid as path segments on every host. */
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
/** A live session id usable as one private directory name on every platform. */
export function isSafeCheckpointSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && isSafeWindowId(sessionId) && !WINDOWS_RESERVED_SEGMENT.test(sessionId);
}

/**
 * Resolve the trusted raw-checkpoint scope from a live Pi event context: the
 * session manager's live session id (available for persisted and in-memory
 * sessions; a missing session file is irrelevant) plus Pi's agent-data
 * directory resolved with Pi-native environment/platform semantics. Pi's
 * conversation session-directory override never selects this location.
 */
export function reviewCheckpointScopeFromContext(
  ctx: unknown, env: NodeJS.ProcessEnv = process.env, resolution?: Partial<ConfigPathResolution>,
): ReviewCheckpointScope | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const manager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (!manager || typeof manager !== "object") return undefined;
  const getSessionId = (manager as { getSessionId?: unknown }).getSessionId;
  if (typeof getSessionId !== "function") return undefined;
  const sessionId: unknown = getSessionId.call(manager);
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  return { agentDir: piAgentDir(env, resolution), sessionId };
}

/** Canonical session checkpoint namespace for display/tests: never created here. */
export function reviewCheckpointSessionDirectory(scope: ReviewCheckpointScope): string {
  return join(resolve(scope.agentDir), SESSIONS_DIRECTORY, SESSION_NAMESPACE, scope.sessionId, CHECKPOINTS_DIRECTORY);
}

/** Lexical record location for a raw descriptor under a trusted scope and
 * canonical root (diagnostics/tests). Loading never trusts this from storage:
 * the loader re-derives and verifies the same location from the live scope. */
export function rawReviewCheckpointRecordPath(scope: ReviewCheckpointScope, canonicalRoot: string, descriptor: { windowId: string; owner: string }): string {
  return join(reviewCheckpointSessionDirectory(scope), workspaceKey(canonicalRoot), `${descriptor.windowId}-${descriptor.owner}`, "record.json");
}

function workspaceKey(root: string): string {
  return createHash("sha256").update(`prg-raw-workspace\0${root}`).digest("hex").slice(0, 32);
}
function validateScope(scope: ReviewCheckpointScope | undefined): ReviewCheckpointScope {
  if (!scope) throw new Error("raw checkpoint requires the live Pi session scope; no session id is available");
  if (!isSafeCheckpointSessionId(scope.sessionId)) throw new Error("raw checkpoint session id is not a safe directory name");
  if (typeof scope.agentDir !== "string" || !scope.agentDir || scope.agentDir.includes("\0"))
    throw new Error("raw checkpoint agent directory is invalid");
  return scope;
}
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
/** Records must stay outside the capture root, and the root outside the store. */
function assertOutsideRoot(store: string, root: string): void {
  if (within(root, store) || within(store, root)) {
    throw new Error(`raw checkpoint storage ${store} overlaps the capture workspace ${root}; this Pi agent-data directory configuration is unsupported for non-Git review checkpoints`);
  }
}
/** Canonical form of a possibly not-yet-existing path: realpath of the deepest
 * existing ancestor plus the remaining lexical segments. */
async function canonicalProspective(path: string): Promise<string> {
  const rest: string[] = [];
  let current = path;
  while (true) {
    try { return join(await realpath(current), ...rest.reverse()); }
    catch (error) { if (!isMissing(error)) throw error; }
    const parent = dirname(current);
    if (parent === current) throw new Error("raw checkpoint storage has no existing ancestor");
    rest.push(basename(current));
    current = parent;
  }
}
/** Private-directory/file check for checkpoint-owned storage (POSIX only:
 * Windows modes are not ACLs and process.getuid is unavailable there). */
function assertPrivate(s: Stats, what: string): void {
  if (process.platform === "win32") return;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((s.mode & 0o077) !== 0 || (uid !== undefined && s.uid !== uid)) throw new Error(`${what} is not private to the current user`);
}

interface SessionStore {
  /** Canonical workspace store directory. */
  store: string;
  /** Canonical `<agentDir>/sessions` directory: the top of the owned chain. */
  base: string;
  /** Canonical Pi agent-data directory. */
  agentDir: string;
}
/**
 * Resolve (and on capture, create) the workspace store inside the live
 * session namespace. The agent directory and its `sessions` directory are
 * Pi-owned and may be symlinked; everything this extension owns below them
 * must be a real private directory. Nothing is created when the prospective
 * location overlaps the capture root. Creation is bounded: at most the agent
 * directory itself (when its parent exists) and `sessions` are created above
 * the extension namespace, so every directory entry this extension can ever
 * create is inside the chain that each publication re-flushes.
 */
async function sessionStore(scopeInput: ReviewCheckpointScope | undefined, root: string, create: boolean): Promise<SessionStore> {
  const scope = validateScope(scopeInput);
  const lexicalAgentDir = resolve(scope.agentDir);
  const owned = [SESSION_NAMESPACE, scope.sessionId, CHECKPOINTS_DIRECTORY, workspaceKey(root)];
  assertOutsideRoot(join(await canonicalProspective(join(lexicalAgentDir, SESSIONS_DIRECTORY)), ...owned), root);
  const missing = (what: string): Error => create ? new Error(`raw checkpoint storage missing: ${what}`) : new RawCheckpointDamage(`missing ${what}`);
  const createDirectory = async (path: string): Promise<void> => {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  };
  if (create) {
    try { await lstat(lexicalAgentDir); }
    catch (error) {
      if (!isMissing(error)) throw error;
      try { await lstat(dirname(lexicalAgentDir)); }
      catch (parentError) {
        if (isMissing(parentError)) throw new Error("raw checkpoint storage missing: the Pi agent-data directory and its parent do not exist");
        throw parentError;
      }
      await createDirectory(lexicalAgentDir);
    }
  }
  let agentDir: string;
  try { agentDir = await realpath(lexicalAgentDir); }
  catch (error) { if (isMissing(error)) throw missing("agent-data directory"); throw error; }
  if (!(await lstat(agentDir)).isDirectory()) throw new Error("raw checkpoint agent-data directory is not a directory");
  const sessions = join(agentDir, SESSIONS_DIRECTORY);
  if (create) {
    try { await lstat(sessions); }
    catch (error) { if (!isMissing(error)) throw error; await createDirectory(sessions); }
  }
  let base: string;
  try { base = await realpath(sessions); }
  catch (error) { if (isMissing(error)) throw missing("session storage"); throw error; }
  const baseStat = await lstat(base);
  if (!baseStat.isDirectory()) throw new Error("raw checkpoint session storage is not a directory");
  let store = base;
  for (const name of owned) {
    store = join(store, name);
    let s: Stats;
    try { s = await lstat(store); }
    catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) throw missing("checkpoint namespace");
      await createDirectory(store);
      s = await lstat(store);
    }
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`unsafe raw checkpoint directory ${store}`);
    assertPrivate(s, "raw checkpoint directory");
  }
  // The final location is canonical by construction (canonical base plus
  // verified non-symlink components); recheck it against the root.
  assertOutsideRoot(store, root);
  return { store, base, agentDir };
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    try { await handle.sync(); }
    catch (error) {
      // Windows rejects directory fsync; only that observed unsupported flush
      // is best-effort. Opening directories and flushing files remain strict.
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally { await handle.close(); }
}

/** Persist every directory entry the raw record depends on before any
 * descriptor is published, on EVERY publication regardless of which
 * invocation created the entry (a failed earlier attempt or a concurrent
 * first capture may have left it unflushed): each directory from the owned
 * generation's parent up to the canonical sessions directory, then the
 * directories holding the `sessions` entry and the agent-data directory
 * entry. These are the only entries this extension ever creates. */
async function syncChain(store: SessionStore, owned: string): Promise<void> {
  const seen = new Set<string>();
  const sync = async (dir: string): Promise<void> => {
    if (seen.has(dir)) return;
    seen.add(dir);
    await syncDirectory(dir);
  };
  for (let dir = dirname(owned); ; dir = dirname(dir)) {
    await sync(dir);
    if (dir === store.base) break;
    if (dirname(dir) === dir) throw new Error("checkpoint directory escaped its session storage");
  }
  await sync(dirname(store.base));
  await sync(store.agentDir);
  await sync(dirname(store.agentDir));
}

/** Durable atomic publication of one private record inside its owned directory. */
async function publishRecord(owned: string, payload: Buffer): Promise<void> {
  const tmp = join(owned, "record.tmp");
  const handle = await open(tmp, "wx", 0o600);
  try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
  await rename(tmp, join(owned, "record.json"));
  await syncDirectory(owned);
}

type GitRoot = { kind: "git"; root: string } | { kind: "raw" | "broken" };
async function gitRoot(root: string): Promise<GitRoot> {
  const out = await command(root, ["rev-parse", "--show-toplevel"], gitCheckpointDiscoveryEnv());
  if (out.code === 0) {
    const top = out.stdout.endsWith("\r\n") ? out.stdout.slice(0, -2)
      : out.stdout.endsWith("\n") ? out.stdout.slice(0, -1)
        : out.stdout;
    if (!top) return { kind: "broken" };
    const canonicalTop = await realpath(resolve(top));
    const withinRepository = relative(canonicalTop, root);
    // A misleading discovery result must never redirect a parent checkpoint
    // to a different checkout and silently report local edits as unchanged.
    if (withinRepository === ".." || withinRepository.startsWith(`..${sep}`) || isAbsolute(withinRepository))
      return { kind: "broken" };
    return { kind: "git", root: canonicalTop };
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
    // Ordinary project content named .pi-review-gate stays eligible: raw
    // records never live inside the workspace (#301).
    if (path === "" && name === ".git") continue;
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
async function ignoredPaths(root: string, candidates: string[], hasIgnore: boolean): Promise<Set<string>> {
  if (!hasIgnore) return new Set();
  // Git's own wildmatch and hierarchy semantics, using an isolated metadata
  // directory, not a .git in the target. The global excludes are enabled only
  // when at least one project .gitignore exists anywhere in the root. The
  // matcher scratch is a private OS temporary directory, never inside the
  // workspace or the checkpoint store, so concurrent captures cannot see it.
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-gate-ignore-"));
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
      if (!fileHandleIdentity(pre, await handle.stat())) throw new Error(`file raced: ${path}`);
      const bytes = Buffer.alloc(pre.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error(`short read: ${path}`);
        offset += bytesRead;
      }
      if (!fileHandleIdentity(pre, await handle.stat())) throw new Error(`file raced: ${path}`);
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

function gitOptions(options: ReviewCheckpointOptions): GitCheckpointOptions {
  const { scope: _scope, ...git } = options;
  return git;
}
function rawPayload(scope: ReviewCheckpointScope, root: string, windowId: string, owner: string, entries: GitCheckpointUntrackedEntry[]): Buffer {
  return Buffer.from(JSON.stringify({ format: FORMAT, sessionId: scope.sessionId, root, windowId, owner, entries } satisfies RawRecord));
}

/** Capture a Git pin/patch record or a durable raw record (never a WorkspaceSnapshot).
 * Raw records require the trusted live session scope and are published only
 * in that session's external checkpoint namespace. */
export async function captureReviewCheckpoint(root: string, windowId: string, options: ReviewCheckpointOptions = {}): Promise<ReviewCheckpointResult<ReviewCheckpointDescriptor>> {
  try {
    if (!isSafeWindowId(windowId)) return fail("unsafe window id");
    const dir = await ensureRoot(root);
    const strategy = await gitRoot(dir);
    if (strategy.kind === "broken") return fail("broken Git metadata; refusing raw fallback");
    if (strategy.kind === "git") {
      const armed = await armGitCheckpoint(strategy.root, windowId, gitOptions(options));
      return armed.status === "ok" ? { status: "ok", value: { kind: "git", checkpoint: armed.value.descriptor } } : armed;
    }
    const scope = validateScope(options.scope);
    const location = await sessionStore(scope, dir, true);
    const owner = randomBytes(16).toString("hex");
    const owned = join(location.store, `${windowId}-${owner}`);
    await mkdir(owned, { mode: 0o700 });
    let published = false;
    try {
      // Flush the owned directory entry and every storage directory created
      // for it before publishing a descriptor, as the Git arm syncs its chain.
      await syncChain(location, owned);
      const files: string[] = [], ignores: string[] = [];
      await walk(dir, "", files, ignores, options);
      const ignoreEntries = await Promise.all(ignores.map((path) => rawEntry(dir, path, options)));
      const excluded = await ignoredPaths(dir, files, ignores.length > 0);
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
      const payload = rawPayload(scope, dir, windowId, owner, entries);
      await publishRecord(owned, payload);
      published = true;
      return { status: "ok", value: { kind: "raw", format: FORMAT, sessionId: scope.sessionId, root: dir, windowId, owner, digest: sha(payload) } };
    } finally { if (!published) await rm(owned, { recursive: true, force: true }); }
  } catch (error) { return fail(errorOf(error)); }
}

/** Compose verified old raw entries with a frozen capture of selected live paths.
 * The old descriptor remains intact; unrelated live bytes are never read. */
export async function advanceRawReviewCheckpoint(
  root: string, descriptor: RawDescriptor,
  landedPaths: readonly string[], checkpointId: string, options: ReviewCheckpointOptions = {},
): Promise<ReviewCheckpointResult<RawDescriptor>> {
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
    const scope = validateScope(options.scope);
    const dir = await ensureRoot(root);
    if ((await gitRoot(dir)).kind !== "raw") throw new Error("raw root became a Git repository during advancement");
    const location = await sessionStore(scope, dir, false);
    const files: string[] = [], ignores: string[] = [];
    await walk(dir, "", files, ignores, options);
    const ignoreEntries = await Promise.all(ignores.map((path) => rawEntry(dir, path, options)));
    // Enumerate the entire path set for consistency, but read bytes only for
    // selected eligible entries; unrelated large files never consume the cap.
    const selectedFiles = files.filter((path) => selectedPath(path, selected));
    const excluded = await ignoredPaths(dir, selectedFiles, ignores.length > 0);
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
    owned = join(location.store, `${checkpointId}-${owner}`);
    await mkdir(owned, { mode: 0o700 });
    await syncChain(location, owned);
    const payload = rawPayload(scope, dir, checkpointId, owner, entries);
    await publishRecord(owned, payload);
    const result: RawDescriptor = { kind: "raw", format: FORMAT, sessionId: scope.sessionId, root: dir, windowId: checkpointId, owner, digest: sha(payload) };
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
export async function changedRawCheckpointPaths(root: string, descriptor: RawDescriptor, options: ReviewCheckpointOptions = {}): Promise<ReviewCheckpointResult<Set<string>>> {
  try {
    const old = await loadReviewCheckpoint(root, descriptor, options);
    if (old.status !== "ok") return old;
    if (old.value.kind !== "raw") throw new Error("expected raw checkpoint");
    const dir = await ensureRoot(root);
    if ((await gitRoot(dir)).kind !== "raw") throw new Error("raw root became a Git repository");
    const files: string[] = [], ignores: string[] = [];
    await walk(dir, "", files, ignores, options);
    const excluded = await ignoredPaths(dir, files, ignores.length > 0);
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

const DESCRIPTOR_KEYS = ["digest", "format", "kind", "owner", "root", "sessionId", "windowId"].join(",");
const RECORD_KEYS = ["entries", "format", "owner", "root", "sessionId", "windowId"].join(",");
function validateDescriptor(value: ReviewCheckpointDescriptor): asserts value is RawDescriptor {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== DESCRIPTOR_KEYS
    || value.kind !== "raw" || value.format !== FORMAT || !isSafeWindowId(value.windowId)
    || !isSafeCheckpointSessionId(value.sessionId)
    || typeof value.owner !== "string" || !/^[0-9a-f]{32}$/.test(value.owner)
    || typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest)
    || typeof value.root !== "string" || !isAbsolute(value.root)) throw new Error("malformed raw descriptor");
}
/** Locate a raw descriptor's owned generation from the trusted scope and the
 * caller's canonical root only; the descriptor never supplies a path. */
async function ownedRawLocation(root: string, descriptor: ReviewCheckpointDescriptor, options: ReviewCheckpointOptions): Promise<{ owned: string; store: string; descriptor: RawDescriptor }> {
  validateDescriptor(descriptor);
  const scope = validateScope(options.scope);
  if (descriptor.sessionId !== scope.sessionId) throw new Error("wrong session");
  checkAbort(options);
  const dir = await ensureRoot(root);
  if (dir !== descriptor.root) throw new Error("wrong root");
  const { store } = await sessionStore(scope, dir, false);
  const owned = join(store, `${descriptor.windowId}-${descriptor.owner}`);
  if (dirname(owned) !== store) throw new Error("unsafe owner path");
  return { owned, store, descriptor };
}
/** Verify session/workspace binding, owner, stored digest, record schema and
 * each raw entry before use. */
export async function loadReviewCheckpoint(root: string, descriptor: ReviewCheckpointDescriptor, options: ReviewCheckpointOptions = {}): Promise<ReviewCheckpointResult<{ kind: "git"; record: GitCheckpointRecord } | { kind: "raw"; entries: GitCheckpointUntrackedEntry[] }>> {
  if (descriptor?.kind === "git") {
    let checkpointRoot: string;
    try { checkpointRoot = await gitCheckpointRoot(root); }
    catch { checkpointRoot = resolve(root); }
    const result = await loadGitCheckpoint(checkpointRoot, descriptor.checkpoint, gitOptions(options));
    return result.status === "ok" ? { status: "ok", value: { kind: "git", record: result.value.record } } : result;
  }
  try {
    const location = await ownedRawLocation(root, descriptor, options);
    const raw = location.descriptor;
    let os: Stats;
    try { os = await lstat(location.owned); }
    catch (error) { if (isMissing(error)) throw new RawCheckpointDamage("owner record missing"); throw error; }
    if (!os.isDirectory() || os.isSymbolicLink()) throw new Error("unsafe owner directory");
    assertPrivate(os, "raw checkpoint owner directory");
    const path = join(location.owned, "record.json");
    let s: Stats;
    try { s = await lstat(path); }
    catch (error) { if (isMissing(error)) throw new RawCheckpointDamage("record missing"); throw error; }
    if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_BYTES * 2 + 1024 * 1024) throw new RawCheckpointDamage("unsafe record");
    assertPrivate(s, "raw checkpoint record");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      if (!fileHandleIdentity(s, await handle.stat())) throw new RawCheckpointDamage("record raced");
      bytes = await handle.readFile();
      if (!fileHandleIdentity(s, await handle.stat()) || bytes.length !== s.size) throw new RawCheckpointDamage("record raced");
    } finally { await handle.close(); }
    if (!identity(s, await lstat(path)) || sha(bytes) !== raw.digest) throw new RawCheckpointDamage("record digest/identity mismatch");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new RawCheckpointDamage("record is not valid UTF-8");
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new RawCheckpointDamage("invalid record"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RawCheckpointDamage("invalid record");
    const record = parsed as RawRecord;
    // The digest already binds these bytes to the descriptor. A record whose
    // own session/workspace/window/owner binding disagrees is an identity
    // mismatch, never recoverable damage.
    if (Object.keys(record).sort().join(",") !== RECORD_KEYS || record.format !== FORMAT
      || record.sessionId !== raw.sessionId || record.root !== raw.root || record.windowId !== raw.windowId
      || record.owner !== raw.owner || !Array.isArray(record.entries)) throw new Error("record binding mismatch");
    const paths = new Set<string>();
    let size = 0;
    for (const entry of record.entries) {
      if (!entry || typeof entry.path !== "string" || !safePath(entry.path) || Buffer.from(entry.path).toString("utf8") !== entry.path
        || paths.has(entry.path)
        || typeof entry.mode !== "number" || !Number.isInteger(entry.mode) || !Number.isFinite(entry.size) || entry.size < 0
        || ![entry.dev, entry.ino, entry.mtimeMs, entry.ctimeMs].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new RawCheckpointDamage("invalid raw entry");
      paths.add(entry.path);
      if (entry.kind === "file") {
        if ((entry.mode & 0o170000) !== 0o100000 || typeof entry.contentB64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.contentB64)
          || Buffer.byteLength(entry.contentB64, "base64") !== entry.size) throw new RawCheckpointDamage("invalid file content");
      } else if (entry.kind === "symlink") {
        if ((entry.mode & 0o170000) !== 0o120000 || typeof entry.target !== "string" || !entry.target.length
          || entry.target.includes("\uFFFD") || Buffer.from(entry.target).toString("utf8") !== entry.target
          || Buffer.byteLength(entry.target) !== entry.size) throw new RawCheckpointDamage("invalid symlink target");
      } else throw new RawCheckpointDamage("invalid entry kind");
      size += entry.size;
      if (size > MAX_BYTES) throw new RawCheckpointDamage("raw byte cap exceeded");
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
export async function compareReviewCheckpoints(root: string, before: ReviewCheckpointDescriptor, after: ReviewCheckpointDescriptor, options: ReviewCheckpointOptions = {}): Promise<ReviewCheckpointResult<ReviewCheckpointComparison>> {
  if (before.kind === "git" && after.kind === "git") {
    let checkpointRoot: string;
    try { checkpointRoot = await gitCheckpointRoot(root); }
    catch (error) { return fail(errorOf(error)); }
    const compared = await compareGitCheckpoints(checkpointRoot, before.checkpoint, after.checkpoint, gitOptions(options), true);
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
/** Release only the descriptor's verified owner. A failed verification deletes
 * nothing; the session namespace, workspace store and unrelated content are
 * never removed. */
export async function releaseReviewCheckpoint(root: string, descriptor: ReviewCheckpointDescriptor, options: ReviewCheckpointOptions = {}): Promise<ReviewCheckpointResult<void>> {
  if (descriptor.kind === "git") {
    const loaded = await loadReviewCheckpoint(root, descriptor, options);
    if (loaded.status !== "ok") return loaded;
    let checkpointRoot: string;
    try { checkpointRoot = await gitCheckpointRoot(root); }
    catch (error) { return fail(errorOf(error)); }
    const released = await releaseGitCheckpointPin(checkpointRoot, descriptor.checkpoint.windowId, { ...gitOptions(options), expectedBase: descriptor.checkpoint.base, armId: descriptor.checkpoint.armId });
    return released.status === "ok" ? { status: "ok", value: undefined } : released;
  }
  const loaded = await loadReviewCheckpoint(root, descriptor, options);
  if (loaded.status !== "ok") return loaded;
  try {
    // Re-derive the location from the trusted scope (never a stored path) and
    // re-verify the owned generation immediately before removal.
    const { owned } = await ownedRawLocation(root, descriptor, options);
    const s = await lstat(owned);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("unsafe owner directory");
    assertPrivate(s, "raw checkpoint owner directory");
    // No recursive parent deletion; the validated owner directory is this
    // generation's only removal target.
    await rm(owned, { recursive: true });
    return { status: "ok", value: undefined };
  } catch (error) { return fail(errorOf(error)); }
}
