import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WaveCaptureResult } from "./wave-repository";
import type { LandingPath, LandingPlan, TreeEntry } from "./wave-landing";
import { validatePathSafe } from "./wave-landing";

const execFileAsync = promisify(execFile);
const MAX_CONFLICT_BYTES = 32 * 1024 * 1024;
const MAX_MERGED_BYTES = MAX_CONFLICT_BYTES * 4;

export interface MaterializedConflictResult {
  paths: string[];
  appliedPaths: string[];
  recoveryDir: string;
  manifestPath: string;
  /**
   * #126 (approved binary handling): conflicted paths whose content cannot
   * carry text markers. The target is preserved in place and the worker
   * version is saved alongside at `sidecarPath` (collision-safe name, never
   * overwriting an existing file). The conflict stays unresolved — gated for
   * manual resolution (choose a side, then delete the sidecar) — until it is.
   */
  sidecars: Array<{ path: string; sidecarPath: string }>;
}

interface PreparedPath {
  path: string;
  /** For sidecar installs: the original conflicted path. */
  originalPath?: string;
  destination: string;
  staged?: string;
  backup?: string;
  backupLinkTarget?: string;
  existed: boolean;
  mode: number;
  backupMode: number;
  kind: "file" | "symlink" | "delete" | "sidecar";
  conflicted: boolean;
}

/**
 * Materialize ordinary diff3 conflict markers while preserving the exact
 * current source content as the "current workspace" side of the merge.
 * Everything is prepared before the first source mutation and rolled back if
 * a later installation fails.
 */
export async function materializeLandingConflicts(
  capture: WaveCaptureResult,
  plan: LandingPlan,
  label: string,
): Promise<MaterializedConflictResult> {
  if (plan.conflicts.length === 0) throw new Error("Landing plan has no conflicts to materialize.");
  const sourceRoot = await realSourceRoot(capture, plan);
  // #126: surface every unrepresentable conflict limit up front so the refusal
  // names all affected paths and their concrete limits instead of failing on
  // the first. This is a fail-closed report, not a fallback: nothing is
  // transferred and no destructive policy is invented for binary or oversized
  // content.
  // #126: classify every conflicted path up front so a refusal names all
  // affected paths and their concrete limits instead of failing on the first.
  // Ordinary text conflicts materialize markers; binary conflicts are
  // represented by preserving the target in place and saving the worker
  // version alongside (sidecar); symlink/type/oversized conflicts remain
  // fail-closed — nothing is transferred when any path cannot be represented.
  const representations = await classifyConflictRepresentations(capture, sourceRoot, plan);
  const blocked = [...representations.entries()].filter(([, representation]) => representation.kind === "blocked");
  if (blocked.length > 0) {
    throw new Error(
      `Cannot represent ${blocked.length} conflict(s); nothing was transferred. `
      + blocked.map(([path, representation]) => `${path}: ${representation.kind === "blocked" ? representation.limit : "unrepresentable"}`).join("; "),
    );
  }
  const recoveryDir = join(capture.waveRoot, `conflict-${randomUUID()}`);
  const stagedDir = join(recoveryDir, "staged");
  const backupDir = join(recoveryDir, "backups");
  await mkdir(stagedDir, { recursive: true, mode: 0o700 });
  await mkdir(backupDir, { recursive: true, mode: 0o700 });

  const prepared: PreparedPath[] = [];
  for (const entry of plan.paths) {
    if (entry.action === "already_applied") continue;
    prepared.push(entry.action === "conflict"
      ? await prepareConflictPath(capture, sourceRoot, entry, label, stagedDir, backupDir, representations.get(entry.path))
      : await prepareAppliedPath(capture, sourceRoot, entry, stagedDir, backupDir));
  }

  const installed: PreparedPath[] = [];
  try {
    for (const item of prepared) {
      await ensureSafeParent(sourceRoot, item.path);
      await mkdir(dirname(item.destination), { recursive: true });
      await installPrepared(item);
      installed.push(item);
    }
  } catch (error) {
    for (const item of installed.reverse()) {
      await restorePrepared(item).catch(() => undefined);
    }
    throw error;
  }

  const manifestPath = join(recoveryDir, "conflict-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    sourceRoot,
    waveId: capture.waveId,
    baseCommit: capture.baseCommit,
    integratedCommit: plan.integratedCommitSha,
    paths: prepared.map((item) => ({
      path: item.path,
      ...(item.originalPath ? { originalPath: item.originalPath } : {}),
      destination: item.destination,
      backup: item.backup,
      backupLinkTarget: item.backupLinkTarget,
      existed: item.existed,
      kind: item.kind,
      conflicted: item.conflicted,
    })),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    paths: prepared.filter((item) => item.conflicted).map((item) => item.path),
    appliedPaths: prepared.filter((item) => !item.conflicted).map((item) => item.path),
    recoveryDir,
    manifestPath,
    sidecars: prepared
      .filter((item) => item.kind === "sidecar")
      .map((item) => ({ path: item.originalPath ?? item.path, sidecarPath: item.destination })),
  };
}

export async function unresolvedConflictMarkers(sourceRoot: string, paths: readonly string[]): Promise<string[]> {
  const unresolved: string[] = [];
  for (const path of paths) {
    validatePathSafe(path);
    const destination = resolve(sourceRoot, path);
    if (!inside(sourceRoot, destination)) throw new Error(`Conflict path escapes source root: ${path}`);
    const text = await readFile(destination, "utf8").catch(() => "");
    if (/^(<<<<<<< |\|\|\|\|\|\|\| |=======|>>>>>>> )/m.test(text)) unresolved.push(path);
  }
  return unresolved;
}

/** Per-path representation for a conflicted landing path. Ordinary text
 * conflicts materialize diff3 markers; binary conflicts are represented by a
 * sidecar (target preserved in place, worker version saved alongside);
 * symlink, type, and oversized conflicts have no approved representation and
 * stay fail-closed with their concrete limit named. */
type ConflictRepresentation =
  | { kind: "text" }
  | { kind: "sidecar" }
  | { kind: "blocked"; limit: string };

async function classifyConflictRepresentations(
  capture: WaveCaptureResult,
  sourceRoot: string,
  plan: LandingPlan,
): Promise<Map<string, ConflictRepresentation>> {
  const out = new Map<string, ConflictRepresentation>();
  for (const entry of plan.paths) {
    if (entry.action !== "conflict") continue;
    try {
      validatePathSafe(entry.path);
    } catch (error) {
      out.set(entry.path, { kind: "blocked", limit: error instanceof Error ? error.message : "unsafe path" });
      continue;
    }
    const destination = resolve(sourceRoot, entry.path);
    if (!inside(sourceRoot, destination)) {
      out.set(entry.path, { kind: "blocked", limit: "destination escapes the source root" });
      continue;
    }
    const stat = await lstat(destination).catch(() => undefined);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      out.set(entry.path, { kind: "blocked", limit: "destination is not a regular file" });
      continue;
    }
    if (entry.base?.mode === "120000" || entry.result?.mode === "120000") {
      out.set(entry.path, { kind: "blocked", limit: "a symlink side cannot be represented alongside the target" });
      continue;
    }
    const oversized = new Set<string>();
    if (stat && stat.size > MAX_CONFLICT_BYTES) {
      oversized.add(`current workspace content is ${stat.size} bytes (limit ${MAX_CONFLICT_BYTES})`);
    }
    for (const side of ["base", "result"] as const) {
      const blobId = entry[side]?.blobId;
      if (!blobId) continue;
      const size = await blobSize(capture.repositoryPath, blobId);
      if (size > MAX_CONFLICT_BYTES) oversized.add(`${side} content is ${size} bytes (limit ${MAX_CONFLICT_BYTES})`);
    }
    if (oversized.size > 0) {
      out.set(entry.path, { kind: "blocked", limit: [...oversized].join("; ") });
      continue;
    }
    // Binary detection reads the full content within the size limit above.
    const binarySides: string[] = [];
    if (stat && (await readFile(destination)).includes(0)) binarySides.push("current workspace");
    for (const side of ["base", "result"] as const) {
      const treeEntry = entry[side];
      if (!treeEntry?.blobId) continue;
      if ((await blob(capture.repositoryPath, treeEntry)).includes(0)) binarySides.push(side);
    }
    if (binarySides.length > 0) {
      // #126 approved: preserve the target in place and save the worker
      // version alongside. A delete/modify conflict has no worker content to
      // save, so it stays fail-closed.
      if (!entry.result?.blobId) {
        out.set(entry.path, { kind: "blocked", limit: `binary ${binarySides.join(" and ")} content with a worker-side deletion cannot be represented` });
        continue;
      }
      out.set(entry.path, { kind: "sidecar" });
      continue;
    }
    out.set(entry.path, { kind: "text" });
  }
  return out;
}

/** Collision-safe sidecar location for a worker version saved alongside its
 * conflicted target. The name derives from the worker blob id (stable across
 * retries); an occupied name gets a numeric suffix instead of overwriting. */
async function chooseSidecarPath(sourceRoot: string, entryPath: string, resultBlobId: string): Promise<string> {
  const stem = `${entryPath}.worker-${resultBlobId.slice(0, 12)}`;
  for (let n = 0; n < 100; n++) {
    const candidate = resolve(sourceRoot, n === 0 ? stem : `${stem}-${n + 1}`);
    if (!inside(sourceRoot, candidate)) throw new Error(`Sidecar path escapes source root: ${entryPath}`);
    const stat = await lstat(candidate).catch(() => undefined);
    if (!stat) return candidate;
  }
  throw new Error(`No free sidecar name could be found alongside ${entryPath}.`);
}

/** Blob size in bytes via `git cat-file -s` (no content transfer). */
async function blobSize(repositoryPath: string, blobId: string): Promise<number> {
  const { stdout } = await execFileAsync("git", ["cat-file", "-s", blobId], {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  const size = Number(stdout.trim());
  return Number.isFinite(size) ? size : MAX_CONFLICT_BYTES + 1;
}

async function prepareConflictPath(
  capture: WaveCaptureResult,
  sourceRoot: string,
  entry: LandingPath,
  label: string,
  stagedDir: string,
  backupDir: string,
  representation?: ConflictRepresentation,
): Promise<PreparedPath> {
  validatePathSafe(entry.path);
  const destination = resolve(sourceRoot, entry.path);
  if (!inside(sourceRoot, destination)) throw new Error(`Conflict path escapes source root: ${entry.path}`);
  await ensureSafeParent(sourceRoot, entry.path);
  const stat = await lstat(destination).catch(() => undefined);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Cannot safely materialize text conflict markers over non-regular path: ${entry.path}`);
  }

  if (representation?.kind === "sidecar") {
    // #126 approved binary handling: never touch the target. Save the worker
    // version alongside at a collision-safe path; the gate keeps the conflict
    // unresolved until the sidecar is handled manually.
    if (!entry.result?.blobId) throw new Error(`Binary conflict without a worker version cannot be sidecarred for ${entry.path}.`);
    const content = await blob(capture.repositoryPath, entry.result);
    const token = randomUUID();
    const staged = join(stagedDir, `${token}.result`);
    await writeFile(staged, content, { mode: 0o600 });
    const sidecarDestination = await chooseSidecarPath(sourceRoot, entry.path, entry.result.blobId);
    return {
      path: entry.path,
      originalPath: entry.path,
      destination: sidecarDestination,
      staged,
      existed: false,
      mode: 0o644,
      backupMode: 0o644,
      kind: "sidecar",
      conflicted: true,
    };
  }

  const current = stat ? await readFile(destination) : Buffer.alloc(0);
  const base = await blob(capture.repositoryPath, entry.base);
  const result = await blob(capture.repositoryPath, entry.result);
  for (const [side, content] of [["current", current], ["base", base], ["result", result]] as const) {
    if (content.length > MAX_CONFLICT_BYTES) throw new Error(`${side} content is too large to materialize safely for ${entry.path}.`);
    if (content.includes(0)) throw new Error(`Binary ${side} content cannot carry text conflict markers for ${entry.path}.`);
  }
  if (entry.base?.mode === "120000" || entry.result?.mode === "120000") {
    throw new Error(`Symlink conflict cannot carry ordinary text markers for ${entry.path}.`);
  }

  const token = randomUUID();
  const currentPath = join(stagedDir, `${token}.current`);
  const basePath = join(stagedDir, `${token}.base`);
  const resultPath = join(stagedDir, `${token}.result`);
  const staged = join(stagedDir, `${token}.merged`);
  await Promise.all([
    writeFile(currentPath, current),
    writeFile(basePath, base),
    writeFile(resultPath, result),
  ]);
  let merged: Buffer;
  let hasConflicts = false;
  try {
    const output = await execFileAsync("git", [
      "merge-file", "-p", "--diff3",
      "-L", "current workspace",
      "-L", "subtask base",
      "-L", label,
      currentPath, basePath, resultPath,
    ], { encoding: "buffer", maxBuffer: MAX_MERGED_BYTES });
    merged = output.stdout;
  } catch (error) {
    const candidate = error as Error & { code?: number | string; stdout?: Buffer; killed?: boolean; signal?: string | null };
    // git-merge-file documents 0 for clean merges, 1..127 for conflict
    // counts (capped at 127), and negative values for errors. Do not treat
    // process failures or truncated maxBuffer output as conflict data.
    if (typeof candidate?.code !== "number" || !Number.isInteger(candidate.code)
      || candidate.code < 1 || candidate.code > 127 || candidate.killed || candidate.signal != null
      || !Buffer.isBuffer(candidate.stdout)) throw error;
    merged = candidate.stdout;
    hasConflicts = true;
  }
  if (!Buffer.isBuffer(merged) || merged.length > MAX_MERGED_BYTES || merged.includes(0)) {
    throw new Error(`Invalid git merge-file output for ${entry.path}.`);
  }
  const mergedText = merged.toString("utf8");
  if (hasConflicts && (!/^<<<<<<< current workspace$/m.test(mergedText)
    || !/^\|\|\|\|\|\|\| subtask base$/m.test(mergedText) || !/^=======$/m.test(mergedText)
    || !(mergedText.includes(`\n>>>>>>> ${label}\n`) || mergedText.includes(`\n>>>>>>> ${label}\r\n`)))) {
    throw new Error(`Missing conflict markers in git merge-file output for ${entry.path}.`);
  }
  if (!mergedText.includes("<<<<<<< current workspace")) {
    merged = Buffer.from([
      "<<<<<<< current workspace\n",
      current.toString("utf8"),
      current.length > 0 && current.at(-1) !== 10 ? "\n" : "",
      "||||||| subtask base\n",
      base.toString("utf8"),
      base.length > 0 && base.at(-1) !== 10 ? "\n" : "",
      "=======\n",
      result.toString("utf8"),
      result.length > 0 && result.at(-1) !== 10 ? "\n" : "",
      `>>>>>>> ${label}\n`,
    ].join(""), "utf8");
  }
  await writeFile(staged, merged, { mode: 0o600 });

  let backup: string | undefined;
  if (stat) {
    backup = join(backupDir, token);
    await copyFile(destination, backup, constants.COPYFILE_EXCL);
  }
  return {
    path: entry.path,
    destination,
    staged,
    backup,
    existed: Boolean(stat),
    mode: stat ? stat.mode & 0o777 : entry.result?.mode === "100755" ? 0o755 : 0o644,
    backupMode: stat ? stat.mode & 0o777 : 0o644,
    kind: "file",
    conflicted: true,
  };
}

async function prepareAppliedPath(
  capture: WaveCaptureResult,
  sourceRoot: string,
  entry: LandingPath,
  stagedDir: string,
  backupDir: string,
): Promise<PreparedPath> {
  validatePathSafe(entry.path);
  const destination = resolve(sourceRoot, entry.path);
  if (!inside(sourceRoot, destination)) throw new Error(`Landing path escapes source root: ${entry.path}`);
  await ensureSafeParent(sourceRoot, entry.path);
  const stat = await lstat(destination).catch(() => undefined);
  if (stat && !stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Cannot transactionally apply a clean file result over non-file path: ${entry.path}`);
  }
  const token = randomUUID();
  let backup: string | undefined;
  let backupLinkTarget: string | undefined;
  if (stat?.isSymbolicLink()) {
    backupLinkTarget = await readlink(destination);
  } else if (stat?.isFile()) {
    backup = join(backupDir, token);
    await copyFile(destination, backup, constants.COPYFILE_EXCL);
  }
  if (!entry.result) {
    return {
      path: entry.path,
      destination,
      backup,
      backupLinkTarget,
      existed: Boolean(stat),
      mode: stat ? stat.mode & 0o777 : 0o644,
      backupMode: stat ? stat.mode & 0o777 : 0o644,
      kind: "delete",
      conflicted: false,
    };
  }
  const content = await blob(capture.repositoryPath, entry.result);
  if (content.length > MAX_CONFLICT_BYTES) throw new Error(`Clean result is too large to apply transactionally for ${entry.path}.`);
  const staged = join(stagedDir, `${token}.result`);
  await writeFile(staged, content, { mode: 0o600 });
  return {
    path: entry.path,
    destination,
    staged,
    backup,
    backupLinkTarget,
    existed: Boolean(stat),
    mode: entry.result.mode === "100755" ? 0o755 : 0o644,
    backupMode: stat ? stat.mode & 0o777 : 0o644,
    kind: entry.result.mode === "120000" ? "symlink" : "file",
    conflicted: false,
  };
}

async function installPrepared(item: PreparedPath): Promise<void> {
  if (item.kind === "delete") {
    await rm(item.destination, { force: true });
    return;
  }
  if (!item.staged) throw new Error(`Prepared landing content is missing for ${item.path}.`);
  const install = join(dirname(item.destination), `.pi-review-conflict-${randomUUID()}`);
  if (item.kind === "symlink") {
    const target = await readFile(item.staged, "utf8");
    await symlink(target, install);
  } else {
    await copyFile(item.staged, install, constants.COPYFILE_EXCL);
    await chmod(install, item.mode);
  }
  await rename(install, item.destination);
}

async function restorePrepared(item: PreparedPath): Promise<void> {
  await rm(item.destination, { force: true });
  if (!item.existed) return;
  if (item.backupLinkTarget !== undefined) {
    await symlink(item.backupLinkTarget, item.destination);
    return;
  }
  if (!item.backup) throw new Error(`Conflict rollback backup is missing for ${item.path}.`);
  await copyFile(item.backup, item.destination);
  await chmod(item.destination, item.backupMode);
}

async function blob(repositoryPath: string, entry: TreeEntry | null): Promise<Buffer> {
  if (!entry?.blobId) return Buffer.alloc(0);
  const output = await execFileAsync("git", ["cat-file", "blob", entry.blobId], {
    cwd: repositoryPath,
    encoding: "buffer",
    maxBuffer: MAX_CONFLICT_BYTES + 1,
  });
  return output.stdout;
}

async function realSourceRoot(capture: WaveCaptureResult, plan: LandingPlan): Promise<string> {
  const root = resolve(plan.sourceRoot);
  if (root !== resolve(capture.discovery.captureRoot)) throw new Error("Landing plan source root does not match its capture.");
  return root;
}

async function ensureSafeParent(sourceRoot: string, path: string): Promise<void> {
  const parent = dirname(resolve(sourceRoot, path));
  const rel = relative(sourceRoot, parent);
  let cursor = sourceRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    const stat = await lstat(cursor).catch(() => undefined);
    if (!stat) break;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe conflict destination ancestor: ${cursor}`);
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/");
}
