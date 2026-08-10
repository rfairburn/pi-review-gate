import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promises as fs, readlink as fsReadlink, Stats } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const readlinkBuffer = promisify(fsReadlink);

const execFileAsync = promisify(execFile);

const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0" };

/** Spawn a git command with stdin input and capture stdout. */
async function gitSpawn(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input: string | Buffer,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env,
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`git ${args.join(" ")} exited with code ${code} signal ${signal}: ${stderr.trim()}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

export type WaveSourceType = "git-committed" | "git-unborn" | "non-git";

// ── typed capture errors ─────────────────────────────────────────────────────

export type WaveCaptureErrorCode = "workspace_changing_during_capture" | "capture_failed";

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
export async function discoverWaveSource(cwd: string): Promise<WaveSourceDiscovery> {
  const resolvedCwd = await fs.realpath(cwd);

  let gitResult: GitProbeResult | null;
  try {
    gitResult = await probeGit(resolvedCwd);
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
  const headInfo = await probeHead(topLevel);

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

async function probeGit(cwd: string): Promise<GitProbeResult | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir"],
      { cwd, env: { ...process.env, ...GIT_ENV }, timeout: 10_000 },
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
    if (message.includes("not a git repository")) {
      return null;
    }
    // Re-throw for non-"not a git repository" errors (malformed config, etc.)
    throw err;
  }
}

async function probeHead(topLevel: string): Promise<HeadInfo> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: topLevel, env: { ...process.env, ...GIT_ENV }, timeout: 10_000 },
    );
    return { commit: stdout.trim(), unborn: false };
  } catch {
    // HEAD resolution failure in a valid repo is treated as unborn.
    return { commit: undefined, unborn: true };
  }
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
export async function enumerateWaveSourcePaths(discovery: WaveSourceDiscovery): Promise<string[]> {
  if (discovery.isGit) {
    return enumerateGitPaths(discovery);
  }
  return enumerateNonGitPaths(discovery);
}

async function enumerateGitPaths(discovery: WaveSourceDiscovery): Promise<string[]> {
  const root = discovery.gitTopLevel!;
  const paths = new Set<string>();

  // 1. Paths from HEAD (if born)
  if (discovery.headCommit) {
    const headPaths = await gitNulList("ls-tree", ["-r", "--name-only", "HEAD"], root);
    for (const p of headPaths) paths.add(p);
  }

  // 2. Paths from the real index
  const indexPaths = await gitNulList("ls-files", ["--cached"], root);
  for (const p of indexPaths) paths.add(p);

  // 3. Non-ignored untracked paths
  const untracked = await gitNulList("ls-files", ["--others", "--exclude-standard"], root);
  for (const p of untracked) paths.add(p);

  return filterAndSort([...paths]);
}

async function enumerateNonGitPaths(discovery: WaveSourceDiscovery): Promise<string[]> {
  const root = discovery.captureRoot;
  const tmpDir = await fs.mkdtemp(join(tmpdir(), "pi-wave-enum-"));

  try {
    // Initialize a minimal Git repo in the temp directory.
    await execFileAsync(
      "git",
      ["init", "--quiet"],
      { cwd: tmpDir, env: { ...process.env, ...GIT_ENV }, timeout: 10_000 },
    );

    // Configure the worktree so Git can find .gitignore files in the source.
    await execFileAsync(
      "git",
      ["config", "core.worktree", root],
      { cwd: tmpDir, env: { ...process.env, ...GIT_ENV }, timeout: 10_000 },
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
      { cwd: root, env, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
    );

    return filterAndSort(stdout.split("\0").filter(Boolean).map(normalizeRelative));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run a git command that outputs NUL-delimited paths. */
async function gitNulList(cmd: string, args: string[], cwd: string): Promise<string[]> {
  // For ls-tree and ls-files, -z goes before the rest.
  const orderedArgs = cmd === "ls-tree"
    ? [cmd, "-z", ...args]
    : [cmd, ...args, "-z"];

  const { stdout } = await execFileAsync(
    "git",
    orderedArgs,
    { cwd, env: { ...process.env, ...GIT_ENV }, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
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
  /** Maximum total bytes allowed across all blobs. */
  maxSnapshotBytes: number;
  /** Wave identifier (generated if omitted). */
  waveId?: string;
  /** Parent artifact directory for the wave root. */
  artifactDir?: string;
  /** Maximum number of capture attempts before giving up on consistency. Default 3. */
  maxCaptureAttempts?: number;
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
  const { cwd, maxSnapshotBytes, waveId: givenWaveId, artifactDir, maxCaptureAttempts: givenMaxAttempts } = options;

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

  // 4. Retry loop with torn-snapshot detection.
  //    Discovery and path enumeration happen inside the loop so each retry
  //    sees the current source state.
  const waveId = givenWaveId ?? generateWaveId();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Re-discover the source on each attempt.
    const discovery = await discoverWaveSource(cwd);
    const allPaths = await enumerateWaveSourcePaths(discovery);

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
      await fs.mkdir(repoPath, { recursive: true });
      await gitCmd("init", ["--bare", "--quiet"], repoPath);

      // For committed Git sources, import the HEAD commit object so we can
      // use it as the parent of our synthetic base commit.
      let parentCommit: string | undefined;
      if (discovery.sourceType === "git-committed" && discovery.headCommit && discovery.gitDir) {
        parentCommit = await importCommitObject(discovery.gitDir, repoPath, discovery.headCommit);
      }

      // Build the tree from current filesystem state (first observation).
      const { entries, totalBytes } = await buildTreeFromPaths(
        repoPath,
        discovery.captureRoot,
        allPaths,
        maxSnapshotBytes,
      );

      // ── Test seam: allow injection of mutations between capture and verify ──
      await __testOnly_mutateSourceBetweenCaptureAndVerify?.(discovery, entries);
      // ────────────────────────────────────────────────────────────────────────

      // Verify consistency with a second observation before pinning.
      const verification = await verifyCaptureConsistency(
        cwd,
        discovery,
        allPaths,
        entries,
        repoPath,
      );
      if (!verification.consistent) {
        // Consistency mismatch — clean up and retry.
        throw new Error(`Capture consistency check failed: ${verification.reason}`);
      }

      // 6. Create the synthetic base commit.
      const baseCommit = await createCommit(repoPath, entries, parentCommit);

      // 7. Pin the ref.
      const baseRef = `refs/pi-review-gate/waves/${waveId}/base`;
      await gitCmd("update-ref", [baseRef, baseCommit], repoPath);

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
        entries,
        totalBytes,
        paths: entries.map((e) => e.path),
        sourceIdentity,
      };
    } catch (err) {
      // Clean up wave root on any failure after creation.
      if (waveRoot) {
        await fs.rm(waveRoot, { recursive: true, force: true }).catch(() => {});
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

// ── internal: consistency verification ───────────────────────────────────────

/**
 * Verify that the captured entries still match the current filesystem state.
 * Re-reads all eligible paths and compares against the first observation.
 * Also re-discovers the source to detect identity drift (e.g., unborn→committed).
 */
async function verifyCaptureConsistency(
  cwd: string,
  discovery: WaveSourceDiscovery,
  allPaths: string[],
  capturedEntries: WaveEntry[],
  repoPath: string,
): Promise<{ consistent: true } | { consistent: false; reason: string }> {
  const captureRoot = discovery.captureRoot;

  // Re-discover the source to detect identity drift.
  const reDiscovery = await discoverWaveSource(cwd);
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
  const reEnumeratedPaths = await enumerateWaveSourcePaths(reDiscovery);
  if (reEnumeratedPaths.length !== allPaths.length) {
    return { consistent: false, reason: "path count changed" };
  }
  for (let i = 0; i < allPaths.length; i += 1) {
    if (reEnumeratedPaths[i] !== allPaths[i]) {
      return { consistent: false, reason: `path at index ${i} changed: ${allPaths[i]} -> ${reEnumeratedPaths[i]}` };
    }
  }

  // Re-read each captured entry and compare.
  const capturedMap = new Map(capturedEntries.map((e) => [e.path, e]));
  for (const relPath of allPaths) {
    // ── Symlinked-ancestor check before reading/verifying any bytes ──
    await assertNoSymlinkedAncestors(captureRoot, relPath);

    const fullPath = join(captureRoot, relPath);

    // Check existence.
    let lstat: Stats;
    try {
      lstat = await fs.lstat(fullPath);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT" || nodeErr?.code === "ENOTDIR") {
        // File disappeared — if it was in captured entries, inconsistent.
        if (capturedMap.has(relPath)) {
          return { consistent: false, reason: `file disappeared: ${relPath}` };
        }
        continue;
      }
      throw err;
    }

    // Any unsupported entry type (directory, special file) is a mismatch.
    if (!lstat.isFile() && !lstat.isSymbolicLink()) {
      return { consistent: false, reason: `unsupported entry type at ${relPath}` };
    }

    const captured = capturedMap.get(relPath);

    if (lstat.isSymbolicLink()) {
      // Verify symlink target.
      const targetBuffer = (await readlinkBuffer(fullPath, { encoding: null })) as unknown as Buffer;
      if (!captured) {
        return { consistent: false, reason: `symlink appeared: ${relPath}` };
      }
      if (captured.mode !== "120000") {
        return { consistent: false, reason: `mode changed for ${relPath}: ${captured.mode} -> 120000` };
      }
      // Re-hash to verify content.
      const newBlobId = await hashObject(repoPath, targetBuffer);
      if (newBlobId !== captured.blobId) {
        return { consistent: false, reason: `symlink target changed: ${relPath}` };
      }
    } else {
      // Regular file: verify bytes and mode.
      const data = await fs.readFile(fullPath);
      if (!captured) {
        return { consistent: false, reason: `file appeared: ${relPath}` };
      }
      // Re-hash to verify content.
      const newBlobId = await hashObject(repoPath, data);
      if (newBlobId !== captured.blobId) {
        return { consistent: false, reason: `file content changed: ${relPath}` };
      }
      // Verify mode.
      const isExecutable = (lstat.mode & 0o111) !== 0;
      const newMode = isExecutable ? "100755" : "100644";
      if (newMode !== captured.mode) {
        return { consistent: false, reason: `mode changed for ${relPath}: ${captured.mode} -> ${newMode}` };
      }
    }
  }

  return { consistent: true };
}

const DEFAULT_MAX_CAPTURE_ATTEMPTS = 3;

// ── test seam: internal / test-only ──────────────────────────────────────────

/**
 * INTERNAL / TEST-ONLY: Inject a mutation between capture and verification.
 * Set this function from tests to mutate source files between the two
 * observations. Clear it (set to undefined) to disable.
 */
export let __testOnly_mutateSourceBetweenCaptureAndVerify: (
  discovery: WaveSourceDiscovery,
  entries: WaveEntry[],
) => Promise<void> | void | undefined;

// ── internal: object import ──────────────────────────────────────────────────

/**
 * Import a commit object (and its reachable tree/blob objects) from the
 * source Git directory into the private bare repository.
 * Returns the SHA of the imported commit (same as source SHA).
 */
async function importCommitObject(
  sourceGitDir: string,
  targetRepoPath: string,
  commitSha: string,
): Promise<string> {
  // Import only the objects reachable from the given commit using git fetch.
  // This avoids bundling the entire repository history.
  await execFileAsync(
    "git",
    ["fetch", sourceGitDir, commitSha],
    {
      cwd: targetRepoPath,
      env: { ...process.env, ...GIT_ENV, GIT_DIR: targetRepoPath },
      timeout: 60_000,
    },
  );

  return commitSha;
}

// ── internal: tree construction ──────────────────────────────────────────────

/**
 * Reject paths whose ancestor directories are symlinks or non-directories.
 * This prevents following symlinked ancestors that could resolve outside
 * the capture root. Called before reading any file bytes.
 */
async function assertNoSymlinkedAncestors(captureRoot: string, relPath: string): Promise<void> {
  const segments = relPath.split("/");
  const ancestorCount = segments.length - 1;
  for (let i = 0; i < ancestorCount; i++) {
    const ancestor = segments[i];
    if (!ancestor) continue;
    const ancestorPath = join(captureRoot, ...segments.slice(0, i + 1));
    let st: Stats;
    try {
      st = await fs.lstat(ancestorPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") {
        // Ancestor doesn't exist — the file can't exist either.
        return;
      }
      throw err;
    }
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
 * Hash files into the private repo and build a tree.
 * Returns entries and total bytes.
 */
async function buildTreeFromPaths(
  repoPath: string,
  captureRoot: string,
  paths: string[],
  maxSnapshotBytes: number,
): Promise<{ entries: WaveEntry[]; totalBytes: number }> {
  const entries: WaveEntry[] = [];
  let totalBytes = 0;

  for (const relPath of paths) {
    const fullPath = join(captureRoot, relPath);

    // ── Symlinked-ancestor check: lstat every ancestor from captureRoot ──
    await assertNoSymlinkedAncestors(captureRoot, relPath);

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

    let blobId: string;
    let mode: string;
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

      // Check size limit before hashing.
      totalBytes += size;
      if (totalBytes > maxSnapshotBytes) {
        throw new Error(
          `Snapshot size limit exceeded: ${totalBytes} bytes exceeds maxSnapshotBytes of ${maxSnapshotBytes}. ` +
          `The file "${relPath}" (${size} bytes) pushed the total over the limit.`,
        );
      }

      blobId = await hashObject(repoPath, targetBuffer);
      mode = "120000";
    } else {
      // Regular file: read the data and count actual bytes.
      const data = await fs.readFile(fullPath);
      size = data.length;

      // Check size limit using actual bytes read.
      totalBytes += size;
      if (totalBytes > maxSnapshotBytes) {
        throw new Error(
          `Snapshot size limit exceeded: ${totalBytes} bytes exceeds maxSnapshotBytes of ${maxSnapshotBytes}. ` +
          `The file "${relPath}" (${size} bytes) pushed the total over the limit.`,
        );
      }

      blobId = await hashObject(repoPath, data);

      // Determine mode: check executable bit.
      const isExecutable = (lstat.mode & 0o111) !== 0;
      mode = isExecutable ? "100755" : "100644";
    }

    entries.push({ path: relPath, mode, blobId, size });
  }

  return { entries, totalBytes };
}

/** Hash a blob into the repository and return its SHA. */
async function hashObject(repoPath: string, data: Buffer): Promise<string> {
  return gitSpawn(
    ["hash-object", "--stdin", "--literal", "-w"],
    repoPath,
    { ...process.env, ...GIT_ENV, GIT_DIR: repoPath },
    data,
  );
}

// ── internal: commit creation ────────────────────────────────────────────────

/**
 * Create a commit object with a tree built through a private temporary index.
 */
async function createCommit(
  repoPath: string,
  entries: WaveEntry[],
  parentCommit?: string,
): Promise<string> {
  // Use a private temporary index file under the wave root.
  const indexFile = join(repoPath, ".wave-index.tmp");
  const env = {
    ...process.env,
    ...GIT_ENV,
    GIT_DIR: repoPath,
    GIT_INDEX_FILE: indexFile,
  };

  try {
    // Populate the index with entries using --cacheinfo (path-safe, no mktree parsing).
    for (const entry of entries) {
      await gitSpawn(
        ["update-index", "--add", "--cacheinfo", entry.mode, entry.blobId, entry.path],
        repoPath,
        env,
        "",
      );
    }

    // Write the tree from the temporary index.
    const treeSha = await gitSpawn(["write-tree"], repoPath, env, "");

    // Build commit message.
    const message = "Synthetic wave base commit";

    // Create the commit.
    const args: string[] = ["commit-tree", treeSha];
    if (parentCommit) {
      args.push("-p", parentCommit);
    }

    const commitEnv = {
      ...env,
      GIT_AUTHOR_NAME: "pi-review-gate",
      GIT_AUTHOR_EMAIL: "pi-review-gate@local",
      GIT_COMMITTER_NAME: "pi-review-gate",
      GIT_COMMITTER_EMAIL: "pi-review-gate@local",
    };

    const commitSha = await gitSpawn(args, repoPath, commitEnv, message);
    return commitSha;
  } finally {
    await fs.rm(indexFile, { force: true }).catch(() => {});
  }
}

// ── internal: git command helper ─────────────────────────────────────────────

async function gitCmd(cmd: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(
    "git",
    [cmd, ...args],
    {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      timeout: 30_000,
    },
  );
}

// ── internal: wave ID generation ─────────────────────────────────────────────

function generateWaveId(): string {
  return randomBytes(6).toString("hex");
}

/** Validate that a waveId is a single safe ref/path segment. */
function validateWaveId(waveId: string): void {
  if (typeof waveId !== "string" || waveId.length === 0) {
    throw new Error(`Invalid waveId: must be a non-empty string.`);
  }
  // Reject characters git check-ref-format forbids in a ref component:
  // control chars, space, slash, ~ ^ : ? * [ \ @{ and dot forms git rejects.
  if (
    /[~^:?*[\\@{}\/]/.test(waveId) ||
    /[\x00-\x20\x7F]/.test(waveId) ||
    waveId === "." || waveId === ".." || waveId === "@" ||
    waveId.startsWith(".") || waveId.endsWith(".") ||
    waveId.endsWith(".lock") || waveId.includes("..") ||
    waveId.includes("@{")
  ) {
    throw new Error(
      `Invalid waveId: "${waveId}". Must be a single safe ref/path segment.`,
    );
  }
}
