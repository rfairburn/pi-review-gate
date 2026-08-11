import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promises as fs, readlink as fsReadlink, Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { GIT_NO_LOCKS_ENV as GIT_ENV, isAbortError, validateSafeId } from "./wave-validation";

const readlinkBuffer = promisify(fsReadlink);

const execFileAsync = promisify(execFile);

/** Spawn a git command with stdin input and capture stdout. */
async function gitSpawn(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input: string | Buffer,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hasInput = typeof input === "string" ? input.length > 0 : input.byteLength > 0;
    let stdinError: NodeJS.ErrnoException | undefined;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const child = spawn("git", args, {
      cwd,
      env,
      timeout: timeoutMs,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk; });
    child.on("error", fail);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // Commands such as update-index and write-tree do not consume stdin and
      // may close the pipe before Node finishes an empty write. That is benign.
      // For commands that require input, retain the error and report it after
      // the child closes so callers never receive an empty/partial object id.
      if (error.code !== "EPIPE" || hasInput) stdinError = error;
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0 || signal) {
        reject(new Error(`git ${args.join(" ")} exited with code ${code} signal ${signal}: ${stderr.trim()}`));
      } else if (stdinError) {
        reject(new Error(`git ${args.join(" ")} failed while writing stdin: ${stdinError.message}`));
      } else {
        resolve(stdout.trim());
      }
    });

    // A single end(input) avoids the write/end race seen on Linux when a Git
    // command exits quickly. Waiting for "close" above also ensures all stdio
    // events have settled before the promise completes.
    child.stdin.end(input);
  });
}

export type WaveSourceType = "git-committed" | "git-unborn" | "non-git";

// ── typed capture errors ─────────────────────────────────────────────────────

export type WaveCaptureErrorCode = "workspace_changing_during_capture" | "capture_failed" | "cancelled";

export class WaveCaptureError extends Error {
  constructor(
    message: string,
    public readonly code: WaveCaptureErrorCode,
    public readonly waveId?: string,
    public readonly phase?: string,
  ) {
    super(message);
    this.name = "WaveCaptureError";
  }
}

export interface WaveSourceDiscovery {
  /** Resolved absolute path of the requested cwd. */
  requestedCwd: string;
  /** Root directory used as the capture boundary. */
  captureRoot: string;
  /** Whether the source is inside a Git worktree. */
  isGit: boolean;
  /** Git top-level working-tree directory (only when isGit is true). */
  gitTopLevel?: string;
  /** Git common-dir (shared metadata directory; only when isGit is true). */
  gitCommonDir?: string;
  /** Git git-dir (.git or equivalent; only when isGit is true). */
  gitDir?: string;
  /** Normalized relative path from capture root to requested cwd. */
  relativeCwd: string;
  /** HEAD commit SHA (only when isGit is true and HEAD is not unborn). */
  headCommit?: string;
  /** Whether HEAD exists but points to no commit (empty repo). */
  headUnborn: boolean;
  /** Classification of the source. */
  sourceType: WaveSourceType;
}

/**
 * Discover the source workspace at `cwd` for wave capture.
 *
 * Performs only read-only Git invocations (no writes to source, index, HEAD, or metadata).
 */
export async function discoverWaveSource(cwd: string, signal?: AbortSignal): Promise<WaveSourceDiscovery> {
  throwIfAborted(signal);
  const resolvedCwd = await fs.realpath(cwd);

  let gitResult: GitProbeResult | null;
  try {
    gitResult = await probeGit(resolvedCwd, signal);
  } catch (err) {
    // Git probe error that is not "not a git repository" — fail capture.
    throw new WaveCaptureError(
      `Git discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      "capture_failed",
    );
  }

  if (!gitResult) {
    return {
      requestedCwd: resolvedCwd,
      captureRoot: resolvedCwd,
      isGit: false,
      relativeCwd: ".",
      headUnborn: false,
      sourceType: "non-git",
    };
  }

  const { topLevel, commonDir, gitDir } = gitResult;
  const headInfo = await probeHead(topLevel, signal);

  const relativeCwd = normalizeRelative(relative(topLevel, resolvedCwd));

  const sourceType: WaveSourceType = headInfo.unborn ? "git-unborn" : "git-committed";

  return {
    requestedCwd: resolvedCwd,
    captureRoot: topLevel,
    isGit: true,
    gitTopLevel: topLevel,
    gitCommonDir: commonDir,
    gitDir,
    relativeCwd,
    headCommit: headInfo.commit,
    headUnborn: headInfo.unborn,
    sourceType,
  };
}

// ── internal helpers ──────────────────────────────────────────────────────────

interface GitProbeResult {
  topLevel: string;
  commonDir: string;
  gitDir: string;
}

interface HeadInfo {
  commit: string | undefined;
  unborn: boolean;
}

async function probeGit(cwd: string, signal?: AbortSignal): Promise<GitProbeResult | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir"],
      { cwd, env: { ...process.env, ...GIT_ENV }, timeout: 10_000, signal },
    );

    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length < 3) {
      return null;
    }

    return {
      topLevel: lines[0],
      commonDir: resolve(cwd, lines[1]),
      gitDir: resolve(cwd, lines[2]),
    };
  } catch (err) {
    // Only classify the explicit "not a git repository" condition as non-Git.
    // Malformed/inaccessible Git metadata/config and other git probe errors
    // must fail capture, never fall back to filesystem enumeration.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not a git repository") && !(await hasGitMarker(cwd))) {
      return null;
    }
    // Re-throw for non-"not a git repository" errors (malformed config, etc.)
    throw err;
  }
}

async function hasGitMarker(cwd: string): Promise<boolean> {
  let current = resolve(cwd);
  for (;;) {
    if (await fs.lstat(join(current, ".git")).then(() => true, () => false)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function probeHead(topLevel: string, signal?: AbortSignal): Promise<HeadInfo> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: topLevel, env: { ...process.env, ...GIT_ENV }, timeout: 10_000, signal },
    );
    return { commit: stdout.trim(), unborn: false };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    // A repository is unborn only when HEAD is a valid symbolic ref whose
    // target does not exist. Detached/corrupt/inaccessible HEAD failures must
    // not be reclassified as an empty repository.
    let headRef: string;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["symbolic-ref", "-q", "HEAD"],
        { cwd: topLevel, env: { ...process.env, ...GIT_ENV }, timeout: 10_000, signal },
      );
      headRef = stdout.trim();
    } catch {
      throw error;
    }
    if (!headRef) throw error;
    try {
      await execFileAsync(
        "git",
        ["check-ref-format", headRef],
        { cwd: topLevel, env: { ...process.env, ...GIT_ENV }, timeout: 10_000, signal },
      );
    } catch {
      throw error;
    }
    try {
      await execFileAsync(
        "git",
        ["show-ref", "--verify", "--quiet", headRef],
        { cwd: topLevel, env: { ...process.env, ...GIT_ENV }, timeout: 10_000, signal },
      );
    } catch (showRefError) {
      if (signal?.aborted || isAbortError(showRefError)) throw showRefError;
      if (isExitCode(showRefError, 1)) return { commit: undefined, unborn: true };
      throw showRefError;
    }
    throw error;
  }
}

function isExitCode(error: unknown, code: number): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function normalizeRelative(p: string): string {
  if (!p || p === ".") {
    return ".";
  }
  return p.split(sep).join("/");
}

// ── source-path enumeration ──────────────────────────────────────────────────

/**
 * Enumerate the source paths eligible for a wave snapshot.
 *
 * Returns a deterministic sorted list of normalized repo-relative paths.
 * For Git sources this is the union of HEAD paths, index paths, and
 * non-ignored untracked paths.  For non-Git sources it uses a temporary
 * Git index to honour nested .gitignore files and global exclusions.
 * Git metadata directories (.git) are always omitted.
 */
export async function enumerateWaveSourcePaths(
  discovery: WaveSourceDiscovery,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await enumerateWaveSourcePathSet(discovery, signal)).paths;
}

interface EnumeratedWavePaths {
  paths: string[];
  /** Paths whose current contents are not represented by HEAD or the index. */
  untrackedPaths: Set<string>;
  /** Paths represented by the captured HEAD tree. */
  headPaths: Set<string>;
}

async function enumerateWaveSourcePathSet(
  discovery: WaveSourceDiscovery,
  signal?: AbortSignal,
): Promise<EnumeratedWavePaths> {
  throwIfAborted(signal);
  if (discovery.isGit) {
    return enumerateGitPaths(discovery, signal);
  }
  const paths = await enumerateNonGitPaths(discovery, signal);
  return { paths, untrackedPaths: new Set(paths), headPaths: new Set() };
}

async function enumerateGitPaths(
  discovery: WaveSourceDiscovery,
  signal?: AbortSignal,
): Promise<EnumeratedWavePaths> {
  const root = discovery.gitTopLevel!;
  const paths = new Set<string>();
  const headPaths = new Set<string>();

  // 1. Paths from HEAD (if born)
  if (discovery.headCommit) {
    const listedHeadPaths = await gitNulList("ls-tree", ["-r", "--name-only", "HEAD"], root, signal);
    for (const p of listedHeadPaths) {
      paths.add(p);
      headPaths.add(p);
    }
  }

  // 2. Paths from the real index
  const indexPaths = await gitNulList("ls-files", ["--cached"], root, signal);
  for (const p of indexPaths) paths.add(p);

  // 3. Non-ignored untracked paths
  const untracked = await gitNulList("ls-files", ["--others", "--exclude-standard"], root, signal);
  for (const p of untracked) paths.add(p);

  const sortedPaths = filterAndSort([...paths]);
  const includedPaths = new Set(sortedPaths);
  return {
    paths: sortedPaths,
    untrackedPaths: new Set(filterAndSort(untracked).filter((path) => includedPaths.has(path))),
    headPaths,
  };
}

async function enumerateNonGitPaths(
  discovery: WaveSourceDiscovery,
  signal?: AbortSignal,
): Promise<string[]> {
  const root = discovery.captureRoot;
  throwIfAborted(signal);
  const tmpDir = await fs.mkdtemp(join(tmpdir(), "pi-wave-enum-"));

  try {
    // Initialize a minimal Git repo in the temp directory.
    await execFileAsync(
      "git",
      ["init", "--quiet"],
      { cwd: tmpDir, env: { ...process.env, ...GIT_ENV }, timeout: 10_000, signal },
    );

    // Configure the worktree so Git can find .gitignore files in the source.
    await execFileAsync(
      "git",
      ["config", "core.worktree", root],
      { cwd: tmpDir, env: { ...process.env, ...GIT_ENV }, timeout: 10_000, signal },
    );

    // Use the temp repo env: empty index means --others lists every non-ignored
    // worktree file, honoring nested .gitignore and global excludes.
    const env = {
      ...process.env,
      ...GIT_ENV,
      GIT_DIR: join(tmpDir, ".git"),
      GIT_WORK_TREE: root,
    };

    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: root, env, timeout: 15_000, maxBuffer: 64 * 1024 * 1024, signal },
    );

    return filterAndSort(stdout.split("\0").filter(Boolean).map(normalizeRelative));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run a git command that outputs NUL-delimited paths. */
async function gitNulList(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // For ls-tree and ls-files, -z goes before the rest.
  const orderedArgs = cmd === "ls-tree"
    ? [cmd, "-z", ...args]
    : [cmd, ...args, "-z"];

  const { stdout } = await execFileAsync(
    "git",
    orderedArgs,
    { cwd, env: { ...process.env, ...GIT_ENV }, timeout: 15_000, maxBuffer: 64 * 1024 * 1024, signal },
  );
  return stdout.split("\0").filter(Boolean).map(normalizeRelative);
}

/** Remove git-metadata paths and return a sorted unique list. */
function filterAndSort(paths: string[]): string[] {
  const filtered = paths
    .filter((p) => !isGitMetadata(p))
    .sort();
  // Deduplicate while preserving sort order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of filtered) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function isGitMetadata(p: string): boolean {
  return p.split("/").some((part) => part === ".git");
}

// ── synthetic wave base capture ──────────────────────────────────────────────

/** Per-file provenance entry inside a wave capture. */
export interface WaveEntry {
  /** Normalized repo-relative path. */
  path: string;
  /** Git mode string: "100644" | "100755" | "120000". */
  mode: string;
  /** Blob object SHA-1 (hex). */
  blobId: string;
  /** Size in bytes of the blob content. */
  size: number;
}

/** Options for capturing a synthetic wave base. */
export interface WaveCaptureOptions {
  /** Working directory to capture from. */
  cwd: string;
  /** Maximum total bytes allowed across non-ignored untracked blobs. Tracked/indexed blobs are always captured. */
  maxSnapshotBytes: number;
  /** Wave identifier (generated if omitted). */
  waveId?: string;
  /** Parent artifact directory for the wave root. */
  artifactDir?: string;
  /** Maximum number of capture attempts before giving up on consistency. Default 3. */
  maxCaptureAttempts?: number;
  /** Garbage-collect completed non-recovery wave roots older than this age. Zero disables GC. */
  artifactTtlMs?: number;
  /** Abort signal used to cancel discovery, staging, verification, and checkout preparation. */
  signal?: AbortSignal;
  /** @internal Per-invocation capture fault hooks used by regression tests. */
  hooks?: WaveCaptureHooks;
}

/** @internal Per-invocation capture fault hooks used by regression tests. */
export interface WaveCaptureHooks {
  mutateSourceBetweenCaptureAndVerify?: (
    discovery: WaveSourceDiscovery,
    entries: WaveEntry[],
  ) => Promise<void> | void;
}

/** Immutable identity of the source capture root (dev + ino). */
export interface SourceIdentity {
  /** Device ID of the filesystem containing the capture root. */
  dev: number;
  /** Inode number of the capture root directory. */
  ino: number;
}

/** Provenance returned after a successful wave base capture. */
export interface WaveCaptureResult {
  /** The wave identifier. */
  waveId: string;
  /** Path to the private bare Git repository. */
  repositoryPath: string;
  /** Wave root directory (parent of the bare repo). */
  waveRoot: string;
  /** Base commit SHA. */
  baseCommit: string;
  /** Full ref name pinned to the base commit. */
  baseRef: string;
  /** Source discovery used for this capture. */
  discovery: WaveSourceDiscovery;
  /** Per-file provenance entries. */
  entries: WaveEntry[];
  /** Total bytes captured across all blobs. */
  totalBytes: number;
  /** Paths included in the snapshot. */
  paths: string[];
  /** Immutable identity of the source capture root (dev+ino). */
  sourceIdentity: SourceIdentity;
}

/**
 * Capture a synthetic wave base commit from the current filesystem state.
 *
 * Creates a private bare Git repository and a single commit whose tree
 * reflects the current filesystem. For committed Git sources the base
 * commit is parented by the captured source HEAD; unborn and non-Git
 * sources produce root commits.
 *
 * Uses torn-snapshot detection: after capturing eligible paths and bytes,
 * verifies a second observation before pinning. Retries on consistency
 * mismatch up to maxCaptureAttempts.
 */
export async function captureWaveBase(options: WaveCaptureOptions): Promise<WaveCaptureResult> {
  const {
    cwd,
    maxSnapshotBytes,
    waveId: givenWaveId,
    artifactDir,
    maxCaptureAttempts: givenMaxAttempts,
    artifactTtlMs = 30 * 24 * 60 * 60 * 1000,
    signal,
    hooks,
  } = options;
  if (signal?.aborted) {
    throw new WaveCaptureError("Wave capture cancelled.", "cancelled", givenWaveId, "capturing");
  }

  if (!Number.isSafeInteger(artifactTtlMs) || artifactTtlMs < 0) {
    throw new Error(`Invalid artifactTtlMs: ${artifactTtlMs}. Must be a non-negative safe integer.`);
  }

  // Validate maxSnapshotBytes: must be a non-negative finite integer.
  if (!Number.isFinite(maxSnapshotBytes) || maxSnapshotBytes < 0 || !Number.isInteger(maxSnapshotBytes)) {
    throw new Error(
      `Invalid maxSnapshotBytes: ${maxSnapshotBytes}. Must be a non-negative finite integer.`,
    );
  }

  // Validate maxCaptureAttempts: must be a positive integer.
  const maxAttempts = givenMaxAttempts ?? DEFAULT_MAX_CAPTURE_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `Invalid maxCaptureAttempts: ${givenMaxAttempts}. Must be a positive integer.`,
    );
  }

  // Validate caller-provided waveId: must be a single safe ref/path segment.
  if (givenWaveId !== undefined) {
    validateWaveId(givenWaveId);
  }

  // 3. Determine the effective artifact parent and validate it is outside the source.
  //    (This is done once before the retry loop — artifactDir is caller-controlled.)
  let artifactParent: string;
  if (artifactDir !== undefined) {
    if (typeof artifactDir !== "string" || artifactDir.length === 0) {
      throw new Error(`Invalid artifactDir: must be a non-empty string or undefined.`);
    }
    const resolved = resolve(artifactDir);
    // Resolve symlinks when the path exists; fall back to resolved path otherwise.
    try {
      artifactParent = await fs.realpath(resolved);
    } catch {
      artifactParent = resolved;
    }
  } else {
    artifactParent = await fs.realpath(resolve(tmpdir()));
  }
  throwIfAborted(signal);
  await pruneCompletedWaveRoots(artifactParent, artifactTtlMs, Date.now(), signal);

  // 4. Retry loop with torn-snapshot detection.
  //    Discovery and path enumeration happen inside the loop so each retry
  //    sees the current source state.
  const waveId = givenWaveId ?? generateWaveId();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    // Re-discover the source on each attempt.
    const discovery = await discoverWaveSource(cwd, signal);
    const enumeratedPaths = await enumerateWaveSourcePathSet(discovery, signal);
    // Containment check: reject if artifactParent is inside or equal to sourceRoot.
    const sourceRoot = await fs.realpath(discovery.captureRoot);
    const sourceRelative = relative(sourceRoot, artifactParent);
    const isOutsideSource =
      sourceRelative === ".." ||
      sourceRelative.startsWith(".." + sep) ||
      isAbsolute(sourceRelative);
    if (!isOutsideSource) {
      throw new Error(
        `Invalid artifactDir: "${artifactDir ?? artifactParent}" resolves inside the source capture root "${sourceRoot}".`,
      );
    }

    let waveRoot: string | undefined;
    try {
      waveRoot = await fs.mkdtemp(join(artifactParent, "wave-"));
      const repoPath = join(waveRoot, "wave-repo.git");
      if (discovery.isGit) {
        // Local clone lets Git reuse immutable object storage through hardlinks
        // instead of repacking the entire reachable history through fetch.
        // The clone is private: refs/index/worktrees are still independent.
        try {
          await gitCmd(
            "clone",
            ["--bare", "--local", "--quiet", discovery.captureRoot, repoPath],
            waveRoot,
            signal,
            120_000,
          );
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) throw error;
          // Hardlinks can be prohibited across filesystems or by a sandbox.
          // Fall back to Git's direct local object copy, which remains much
          // cheaper than fetch/repack and keeps the wave repository standalone.
          await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
          await gitCmd(
            "clone",
            ["--bare", "--no-hardlinks", "--quiet", discovery.captureRoot, repoPath],
            waveRoot,
            signal,
            120_000,
          );
        }
      } else {
        await fs.mkdir(repoPath, { recursive: true });
        await gitCmd("init", ["--bare", "--quiet"], repoPath, signal);
      }
      const parentCommit = discovery.sourceType === "git-committed"
        ? discovery.headCommit
        : undefined;

      // Build the current filesystem tree through one private Git index. HEAD
      // entries are reused, while current-different and eligible new paths are
      // handed to one native `git add -A` operation.
      const staged = await buildTreeWithGitIndex(
        repoPath,
        discovery,
        enumeratedPaths,
        maxSnapshotBytes,
        parentCommit,
        signal,
      );

      // ── Test seam: allow injection of mutations between capture and verify ──
      await hooks?.mutateSourceBetweenCaptureAndVerify?.(discovery, staged.entries);
      // ────────────────────────────────────────────────────────────────────────
      throwIfAborted(signal);

      // Verify consistency with a second observation before pinning.
      const verification = await verifyCaptureConsistency(
        cwd,
        discovery,
        enumeratedPaths,
        repoPath,
        maxSnapshotBytes,
        parentCommit,
        staged.treeSha,
        signal,
      );
      if (!verification.consistent) {
        // Consistency mismatch — clean up and retry.
        throw new Error(`Capture consistency check failed: ${verification.reason}`);
      }

      // Pin the already-created synthetic commit only after consistency passes.
      const baseCommit = staged.commitSha;
      const baseRef = `refs/pi-review-gate/waves/${waveId}/base`;
      await gitCmd("update-ref", [baseRef, baseCommit], repoPath, signal);
      await fs.rm(staged.indexFile, { force: true }).catch(() => {});

      // 8. Capture the immutable source identity (dev+ino).
      const rootStat = await fs.stat(discovery.captureRoot);
      // Explicit conservative fallback: on platforms without stable inode
      // (e.g., Windows where ino=0), refuse to capture rather than silently
      // weakening the identity binding.
      if (rootStat.ino === 0 || rootStat.dev === 0) {
        throw new Error(
          `Source root identity (dev=${rootStat.dev}, ino=${rootStat.ino}) is not stable on this platform. ` +
          `Refusing to capture without a strong directory identity.`,
        );
      }
      const sourceIdentity: SourceIdentity = {
        dev: rootStat.dev,
        ino: rootStat.ino,
      };

      return {
        waveId,
        repositoryPath: repoPath,
        waveRoot,
        baseCommit,
        baseRef,
        discovery,
        entries: staged.entries,
        totalBytes: staged.totalBytes,
        paths: staged.entries.map((e) => e.path),
        sourceIdentity,
      };
    } catch (err) {
      // Clean up wave root on any failure after creation.
      if (waveRoot) {
        await fs.rm(waveRoot, { recursive: true, force: true }).catch(() => {});
      }

      if (signal?.aborted || isAbortError(err)) {
        throw new WaveCaptureError("Wave capture cancelled.", "cancelled", waveId, "capturing");
      }

      // If this was a consistency mismatch and we have retries left, continue.
      if (err instanceof Error && err.message.startsWith("Capture consistency check failed")) {
        if (attempt < maxAttempts) {
          continue;
        }
        // Exhausted retries — return classified error.
        throw new WaveCaptureError(
          `Workspace changed during capture after ${maxAttempts} attempt(s). ` +
          `Source was not stable enough to produce a consistent snapshot.`,
          "workspace_changing_during_capture",
        );
      }

      // Non-consistency errors are immediate failures.
      throw err;
    }
  }

  // Should not be reached, but satisfy TypeScript.
  throw new WaveCaptureError(
    `Workspace changed during capture after ${maxAttempts} attempt(s).`,
    "workspace_changing_during_capture",
  );
}

/** Remove only old, terminal wave roots that are not needed for conflict recovery. */
export async function pruneCompletedWaveRoots(
  artifactParent: string,
  ttlMs: number,
  nowMs = Date.now(),
  signal?: AbortSignal,
): Promise<string[]> {
  if (ttlMs === 0) return [];
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new Error("ttlMs must be a non-negative safe integer");
  }
  const removed: string[] = [];
  const entries = await fs.readdir(artifactParent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    throwIfAborted(signal);
    if (!entry.isDirectory() || !entry.name.startsWith("wave-")) continue;
    const root = join(artifactParent, entry.name);
    const stat = await fs.lstat(root).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || nowMs - stat.mtimeMs < ttlMs) continue;
    const manifestPath = join(root, "wave-manifest.json");
    const manifestStat = await fs.lstat(manifestPath).catch(() => undefined);
    if (!manifestStat?.isFile() || manifestStat.size > 1024 * 1024) continue;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (manifest.version !== 1 || manifest.repositoryPath !== join(root, "wave-repo.git")) continue;
    if (manifest.phase !== "completed" && manifest.phase !== "aborted") continue;
    if (manifest.landingStatus === "recovery_required" || manifest.landingStatus === "conflicted") continue;
    if (manifest.integrationStatus === "conflicted" || manifest.integrationStatus === "error") continue;
    await fs.rm(root, { recursive: true, force: true });
    removed.push(root);
  }
  return removed;
}

// ── internal: consistency verification ───────────────────────────────────────

/**
 * Verify that the captured entries still match the current filesystem state.
 * Re-reads all eligible paths and compares against the first observation.
 * Also re-discovers the source to detect identity drift (e.g., unborn→committed).
 */
async function verifyCaptureConsistency(
  cwd: string,
  discovery: WaveSourceDiscovery,
  enumeration: EnumeratedWavePaths,
  repoPath: string,
  maxSnapshotBytes: number,
  parentCommit: string | undefined,
  capturedTreeSha: string,
  signal?: AbortSignal,
): Promise<{ consistent: true } | { consistent: false; reason: string }> {
  throwIfAborted(signal);

  // Re-discover the source to detect identity drift.
  const reDiscovery = await discoverWaveSource(cwd, signal);
  // Compare all identity fields — any difference means the source changed.
  for (const key of [
    "requestedCwd", "captureRoot", "isGit", "gitTopLevel", "gitCommonDir", "gitDir",
    "relativeCwd", "headCommit", "headUnborn", "sourceType",
  ] as const) {
    if (reDiscovery[key] !== discovery[key]) {
      return { consistent: false, reason: `${key} changed: ${discovery[key]} -> ${reDiscovery[key]}` };
    }
  }

  // Re-enumerate paths from the second discovery to detect path-set drift.
  const reEnumeration = await enumerateWaveSourcePathSet(reDiscovery, signal);
  const reEnumeratedPaths = reEnumeration.paths;
  if (reEnumeratedPaths.length !== enumeration.paths.length) {
    return { consistent: false, reason: "path count changed" };
  }
  for (let i = 0; i < enumeration.paths.length; i += 1) {
    if (reEnumeratedPaths[i] !== enumeration.paths[i]) {
      return { consistent: false, reason: `path at index ${i} changed: ${enumeration.paths[i]} -> ${reEnumeratedPaths[i]}` };
    }
  }
  if (reEnumeration.untrackedPaths.size !== enumeration.untrackedPaths.size) {
    return { consistent: false, reason: "untracked path count changed" };
  }
  for (const path of enumeration.untrackedPaths) {
    if (!reEnumeration.untrackedPaths.has(path)) {
      return { consistent: false, reason: `untracked path classification changed: ${path}` };
    }
  }

  try {
    await validateEligiblePaths(
      reDiscovery.captureRoot,
      reEnumeration.paths,
      reEnumeration.untrackedPaths,
      maxSnapshotBytes,
      signal,
    );
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return { consistent: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const verificationIndex = join(repoPath, ".wave-verify-index.tmp");
  try {
    const verifiedTreeSha = await stageFilesystemTree(
      repoPath,
      reDiscovery,
      reEnumeration,
      parentCommit,
      verificationIndex,
      signal,
    );
    if (verifiedTreeSha !== capturedTreeSha) {
      return { consistent: false, reason: "captured filesystem contents changed" };
    }
  } finally {
    await fs.rm(verificationIndex, { force: true }).catch(() => {});
  }
  return { consistent: true };
}

const DEFAULT_MAX_CAPTURE_ATTEMPTS = 3;

// ── internal: tree construction ──────────────────────────────────────────────

/**
 * Reject paths whose ancestor directories are symlinks or non-directories.
 * This prevents following symlinked ancestors that could resolve outside
 * the capture root. Called before reading any file bytes.
 */
async function assertNoSymlinkedAncestors(
  captureRoot: string,
  relPath: string,
  ancestorCache: Map<string, Stats | null>,
  signal?: AbortSignal,
): Promise<void> {
  const segments = relPath.split("/");
  const ancestorCount = segments.length - 1;
  for (let i = 0; i < ancestorCount; i++) {
    throwIfAborted(signal);
    const ancestor = segments[i];
    if (!ancestor) continue;
    const ancestorPath = join(captureRoot, ...segments.slice(0, i + 1));
    let st = ancestorCache.get(ancestorPath);
    if (st === undefined) {
      try {
        st = await fs.lstat(ancestorPath);
        ancestorCache.set(ancestorPath, st);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e?.code === "ENOENT" || e?.code === "ENOTDIR") {
          ancestorCache.set(ancestorPath, null);
          return;
        }
        throw err;
      }
    }
    if (st === null) return;
    if (st.isSymbolicLink()) {
      throw new Error(
        `Ancestor "${ancestor}" is a symbolic link; refusing to follow symlinks outside capture root.`,
      );
    }
    if (!st.isDirectory()) {
      throw new Error(
        `Ancestor "${ancestor}" is not a directory on the source filesystem.`,
      );
    }
  }
}

/**
 * Validate eligible filesystem entries without reading regular-file contents.
 * This protects the capture boundary and enforces only the untracked budget;
 * Git performs the actual content reads in one bulk staging operation.
 */
async function validateEligiblePaths(
  captureRoot: string,
  paths: string[],
  untrackedPaths: Set<string>,
  maxSnapshotBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  let untrackedBytes = 0;
  const ancestorCache = new Map<string, Stats | null>();

  for (const relPath of paths) {
    throwIfAborted(signal);
    const fullPath = join(captureRoot, relPath);

    await assertNoSymlinkedAncestors(captureRoot, relPath, ancestorCache, signal);

    // Check existence — omit paths absent from the filesystem (tracked deletions).
    let lstat: Stats;
    try {
      lstat = await fs.lstat(fullPath);
    } catch (err) {
      // Only omit ENOENT (missing file); rethrow other errors.
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT" || nodeErr?.code === "ENOTDIR") {
        continue;
      }
      throw err;
    }

    // Reject unsupported entry types.
    if (!lstat.isFile() && !lstat.isSymbolicLink()) {
      throw new Error(
        `Unsupported entry type at "${relPath}": ${lstat.isDirectory() ? "directory" : "special"}. ` +
        `Only regular files and symlinks are supported.`,
      );
    }

    let size: number;

    if (lstat.isSymbolicLink()) {
      // Symlink: read target as raw bytes to avoid UTF-8 round trip.
      const targetBuffer = (await readlinkBuffer(fullPath, { encoding: null })) as unknown as Buffer;
      const symlinkTarget = targetBuffer.toString("utf8");
      // Reject symlinks that escape the capture root.
      if (isAbsolute(symlinkTarget)) {
        throw new Error(
          `Symlink target is absolute and rejected: "${relPath}" -> ${symlinkTarget}`,
        );
      }
      const linkDir = fullPath.substring(0, fullPath.lastIndexOf(sep));
      const resolved = resolve(linkDir, symlinkTarget);
      if (!resolved.startsWith(captureRoot + sep) && resolved !== captureRoot) {
        throw new Error(
          `Symlink target escapes capture root and is rejected: "${relPath}" -> ${symlinkTarget} (resolves to ${resolved})`,
        );
      }
      size = targetBuffer.length;

    } else {
      size = lstat.size;
    }

    if (untrackedPaths.has(relPath)) {
      untrackedBytes += size;
      if (untrackedBytes > maxSnapshotBytes) {
        throw new Error(
          `Snapshot size limit exceeded for untracked files: ${untrackedBytes} bytes exceeds ` +
          `maxSnapshotBytes of ${maxSnapshotBytes}. The untracked file "${relPath}" ` +
          `(${size} bytes) pushed the untracked total over the limit.`,
        );
      }
    }
  }
}

interface StagedWaveTree {
  indexFile: string;
  treeSha: string;
  commitSha: string;
  entries: WaveEntry[];
  totalBytes: number;
}

/**
 * Build the synthetic tree with Git-native bulk operations. A committed source
 * starts from HEAD, so unchanged tracked blobs are reused without being read.
 */
async function buildTreeWithGitIndex(
  repoPath: string,
  discovery: WaveSourceDiscovery,
  enumeration: EnumeratedWavePaths,
  maxSnapshotBytes: number,
  parentCommit: string | undefined,
  signal?: AbortSignal,
): Promise<StagedWaveTree> {
  await validateEligiblePaths(
    discovery.captureRoot,
    enumeration.paths,
    enumeration.untrackedPaths,
    maxSnapshotBytes,
    signal,
  );

  const indexFile = join(repoPath, ".wave-index.tmp");
  const treeSha = await stageFilesystemTree(
    repoPath,
    discovery,
    enumeration,
    parentCommit,
    indexFile,
    signal,
  );
  const commitSha = await createCommitFromTree(repoPath, indexFile, treeSha, parentCommit, signal);
  const entries = await readTreeEntries(repoPath, commitSha, signal);
  return {
    indexFile,
    treeSha,
    commitSha,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}

async function stageFilesystemTree(
  repoPath: string,
  discovery: WaveSourceDiscovery,
  enumeration: EnumeratedWavePaths,
  parentCommit: string | undefined,
  indexFile: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  await fs.rm(indexFile, { force: true }).catch(() => {});
  const env = captureIndexEnv(repoPath, indexFile, discovery.captureRoot);

  if (parentCommit) {
    await gitSpawn(["read-tree", parentCommit], repoPath, env, "", 30_000, signal);
  } else {
    await gitSpawn(["read-tree", "--empty"], repoPath, env, "", 30_000, signal);
  }

  const overlayPaths = await determineOverlayPaths(discovery, enumeration, signal);
  if (overlayPaths.length > 0) {
    const pathspec = Buffer.from(`${overlayPaths.join("\0")}\0`, "utf8");
    await gitSpawn(
      [
        "--literal-pathspecs",
        "-c", "core.filemode=true",
        "add", "-A", "-f",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      repoPath,
      env,
      pathspec,
      120_000,
      signal,
    );
  }

  return gitSpawn(["write-tree"], repoPath, env, "", 30_000, signal);
}

async function determineOverlayPaths(
  discovery: WaveSourceDiscovery,
  enumeration: EnumeratedWavePaths,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!discovery.headCommit || !discovery.gitTopLevel) {
    return enumeration.paths;
  }

  const changed = await gitNulOutput(
    [
      "-c", "core.filemode=true",
      "diff", "--no-ext-diff", "--ignore-submodules=none",
      "--name-only", "-z", "HEAD", "--",
    ],
    discovery.gitTopLevel,
    { ...process.env, ...GIT_ENV },
    signal,
  );
  const overlay = new Set(changed);

  // New indexed and nonignored untracked files cannot appear in `git diff
  // HEAD` until they are represented by HEAD, so include them explicitly.
  for (const path of enumeration.paths) {
    if (!enumeration.headPaths.has(path)) overlay.add(path);
  }

  // Git intentionally hides assume-unchanged/skip-worktree content from normal
  // diff discovery. Capture current filesystem bytes for those paths anyway.
  const flagged = await gitNulOutput(
    ["ls-files", "-v", "-z"],
    discovery.gitTopLevel,
    { ...process.env, ...GIT_ENV },
    signal,
  );
  for (const record of flagged) {
    if (record.length < 3 || record[1] !== " ") continue;
    const tag = record[0];
    if (tag === "S" || tag === tag.toLowerCase()) {
      overlay.add(record.slice(2));
    }
  }

  return filterAndSort([...overlay]);
}

async function createCommitFromTree(
  repoPath: string,
  indexFile: string,
  treeSha: string,
  parentCommit: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const env = {
    ...captureIndexEnv(repoPath, indexFile),
    GIT_AUTHOR_NAME: "pi-review-gate",
    GIT_AUTHOR_EMAIL: "pi-review-gate@local",
    GIT_COMMITTER_NAME: "pi-review-gate",
    GIT_COMMITTER_EMAIL: "pi-review-gate@local",
  };
  const args = ["commit-tree", treeSha];
  if (parentCommit) args.push("-p", parentCommit);
  return gitSpawn(args, repoPath, env, "Synthetic wave base commit\n", 30_000, signal);
}

async function readTreeEntries(
  repoPath: string,
  treeish: string,
  signal?: AbortSignal,
): Promise<WaveEntry[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "-l", "-z", treeish],
    {
      cwd: repoPath,
      env: { ...process.env, ...GIT_ENV, GIT_DIR: repoPath },
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    },
  );
  const entries: WaveEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) (\S+) ([0-9a-f]+)\s+([0-9]+|-)\t([\s\S]*)$/.exec(record);
    if (!match || match[2] !== "blob" || match[4] === "-") {
      throw new Error(`Unsupported Git tree entry in wave capture: ${record}`);
    }
    entries.push({
      mode: match[1],
      blobId: match[3],
      size: Number(match[4]),
      path: normalizeRelative(match[5]),
    });
  }
  return entries;
}

function captureIndexEnv(
  repoPath: string,
  indexFile: string,
  workTree?: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...GIT_ENV,
    GIT_DIR: repoPath,
    GIT_INDEX_FILE: indexFile,
    ...(workTree ? { GIT_WORK_TREE: workTree } : {}),
  };
}

async function gitNulOutput(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string[]> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    signal,
  });
  return stdout.split("\0").filter(Boolean).map(normalizeRelative);
}

// ── internal: git command helper ─────────────────────────────────────────────

async function gitCmd(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 30_000,
): Promise<void> {
  await execFileAsync(
    "git",
    [cmd, ...args],
    {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      timeout,
      signal,
    },
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  throw error;
}

// ── internal: wave ID generation ─────────────────────────────────────────────

function generateWaveId(): string {
  return randomBytes(6).toString("hex");
}

/** Validate that a waveId is a single safe ref/path segment. */
function validateWaveId(waveId: string): void {
  validateSafeId(waveId, "waveId");
}
