import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
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
   * #126 approved (explicit force-merge only): conflicted paths whose content
   * cannot carry text markers. The target is preserved in place; when the
   * worker side carries bytes they are saved alongside at `sidecarPath`
   * (collision-safe name, never overwriting an existing file). A worker-side
   * deletion has no bytes to save and is recorded without one — absence is
   * never fabricated into content. The conflict stays unresolved — gated for
   * manual resolution (choose a side, then delete the sidecar) — until it is;
   * preservation is not resolution.
   */
  sidecars: Array<{ path: string; sidecarPath?: string; limit?: string; workerMode?: string }>;
}

/**
 * Representation modes for conflicted landing paths. Both are granted only by
 * explicit force-merge (including its interrupt_with_merge delegation);
 * ordinary reviewed landing keeps the pre-#126 whole-transfer refusal for
 * every conflict that cannot carry text markers.
 */
export interface MaterializeLandingConflictsOptions {
  /** A conflicted binary path preserves its target in place and saves the
   * worker version alongside instead of refusing the transfer. */
  binarySidecars?: boolean;
  /** Unrepresentable conflicts (symlink/type change, oversized side,
   * worker-side deletion) are preserved — available worker bytes saved
   * alongside, deletions recorded — while the remaining identified work still
   * merges in the same call instead of aborting. */
  preserveUnrepresentable?: boolean;
}

/** @internal Per-invocation fault hooks used by landing regression tests. */
export interface MaterializeConflictHooks {
  /** Invoked immediately before a sidecar's final install step, with the
   * chosen destination. Throwing — or occupying the destination — simulates
   * a late collision so the no-overwrite guard and its rollback can be
   * exercised deterministically. */
  beforeSidecarInstall?: (destination: string) => Promise<void> | void;
  /** Invoked immediately before the sidecar's atomic hard-link install, with
   * the chosen destination. Throwing an error that carries a filesystem errno
   * code (EPERM, ENOTSUP, EXDEV) simulates a filesystem that cannot
   * hard-link so the unsupported-atomic-install refusal and its rollback can
   * be exercised deterministically; a normal return proceeds to the real
   * link, so the seam can never skip an install. */
  failSidecarLink?: (destination: string) => Promise<void> | void;
}

interface PreparedPath {
  path: string;
  /** For sidecar installs: the original conflicted path. */
  originalPath?: string;
  destination?: string;
  staged?: string;
  backup?: string;
  backupLinkTarget?: string;
  existed: boolean;
  mode: number;
  backupMode: number;
  kind: "file" | "symlink" | "delete" | "sidecar" | "preserve";
  conflicted: boolean;
  /** Worker-side tree mode for preserved non-text representations. */
  workerMode?: string;
  /** Concrete limit that kept this path from carrying text markers. */
  limit?: string;
}

/**
 * Materialize ordinary diff3 conflict markers while preserving the exact
 * current source content as the "current workspace" side of the merge.
 * Everything is prepared before the first source mutation and rolled back if
 * a later installation fails. Sidecar destinations are reserved planner-wide
 * (planned landings plus earlier sidecars, compared case-insensitively,
 * including ancestor/descendant file conflicts) and installed with an atomic
 * no-overwrite link, so a sidecar never overwrites another incoming path or
 * an unrelated existing file.
 *
 * With no options (ordinary reviewed landing), every conflict that cannot
 * carry text markers refuses the whole transfer before any mutation. Explicit
 * force-merge passes its approved representation modes: binary conflicts keep
 * their target in place with the worker version saved alongside, and other
 * unrepresentable conflicts are preserved — worker bytes alongside when they
 * exist, deletion intent recorded otherwise — while the remaining identified
 * work still merges in the same call.
 */
export async function materializeLandingConflicts(
  capture: WaveCaptureResult,
  plan: LandingPlan,
  label: string,
  options: MaterializeLandingConflictsOptions = {},
  hooks: MaterializeConflictHooks = {},
): Promise<MaterializedConflictResult> {
  if (plan.conflicts.length === 0) throw new Error("Landing plan has no conflicts to materialize.");
  const sourceRoot = await realSourceRoot(capture, plan);
  // #126: classify every conflicted path up front so a refusal or record names
  // all affected paths and their concrete limits instead of failing on the
  // first. Ordinary text conflicts materialize markers; with the approved
  // force-merge options, binary conflicts are represented by preserving the
  // target in place and saving the worker version alongside (sidecar), and
  // other unrepresentable conflicts are preserved with available worker bytes
  // or a recorded deletion intent. Without those options every non-text
  // conflict stays fail-closed — nothing is transferred when any path cannot
  // be represented.
  const representations = await classifyConflictRepresentations(capture, sourceRoot, plan, options);
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

  // Planner-level reservation: every incoming destination (including deletes)
  // is reserved before any installation, and each generated sidecar name is
  // reserved as soon as it is chosen. A sidecar candidate that collides with a
  // reserved path — exactly, or as an ancestor/descendant file conflict — is
  // never picked, so no two prepared entries can install at the same
  // destination and rename-overwrite each other's bytes. Existing target files
  // are not reserved: they stay on disk where lstat already sees them. Each
  // path is also reserved case-folded: on a case-insensitive target
  // filesystem two names differing only by case are the same file, so they
  // must collide (on case-sensitive filesystems this is merely conservative —
  // it can only pick a different free name, never lose content).
  const reserved = new Set<string>();
  for (const entry of plan.paths) {
    if (entry.action === "already_applied") continue;
    const destination = resolve(sourceRoot, entry.path);
    if (inside(sourceRoot, destination)) {
      reserved.add(destination);
      reserved.add(destination.toLowerCase());
    }
  }

  // #126 approved merge-all: an explicit force-merge transfers every
  // identified clean path, and a nonconflicting byte copy carries no text
  // markers — so its content is streamed to staging instead of being bounded
  // by the marker-materialization size limit. Ordinary reviewed landing (no
  // options) keeps the pre-#126 buffered read and its limit unchanged.
  const streamCleanBlobs = Boolean(options.binarySidecars || options.preserveUnrepresentable);

  const prepared: PreparedPath[] = [];
  for (const entry of plan.paths) {
    if (entry.action === "already_applied") continue;
    prepared.push(entry.action === "conflict"
      ? await prepareConflictPath(capture, sourceRoot, entry, label, stagedDir, backupDir, reserved, representations.get(entry.path))
      : await prepareAppliedPath(capture, sourceRoot, entry, stagedDir, backupDir, streamCleanBlobs));
  }

  const installed: PreparedPath[] = [];
  try {
    for (const item of prepared) {
      if (item.kind === "preserve") continue; // record-only: nothing is installed
      await ensureSafeParent(sourceRoot, item.path);
      await mkdir(dirname(item.destination!), { recursive: true });
      await installPrepared(item, hooks);
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
      ...(item.destination !== undefined ? { destination: item.destination } : {}),
      ...(item.backup ? { backup: item.backup } : {}),
      ...(item.backupLinkTarget ? { backupLinkTarget: item.backupLinkTarget } : {}),
      existed: item.existed,
      kind: item.kind,
      conflicted: item.conflicted,
      ...(item.workerMode ? { workerMode: item.workerMode } : {}),
      ...(item.limit ? { limit: item.limit } : {}),
    })),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    paths: prepared.filter((item) => item.conflicted).map((item) => item.path),
    appliedPaths: prepared.filter((item) => !item.conflicted).map((item) => item.path),
    recoveryDir,
    manifestPath,
    sidecars: prepared
      .filter((item) => item.kind === "sidecar" || item.kind === "preserve")
      .map((item) => ({
        path: item.originalPath ?? item.path,
        ...(item.destination !== undefined ? { sidecarPath: item.destination } : {}),
        ...(item.limit ? { limit: item.limit } : {}),
        ...(item.workerMode ? { workerMode: item.workerMode } : {}),
      })),
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
 * conflicts materialize diff3 markers. With the approved force-merge options,
 * binary modify/modify conflicts are represented by a sidecar (target
 * preserved in place, worker version saved alongside) and other
 * unrepresentable conflicts either keep their available worker bytes
 * alongside (`sidecar`) or record a worker-side deletion without fabricating
 * bytes (`preserve`). Without those options every non-text conflict stays
 * fail-closed (`blocked`) with its concrete limit named. */
type ConflictRepresentation =
  | { kind: "text" }
  | { kind: "sidecar"; limit: string; workerMode?: string }
  | { kind: "preserve"; limit: string; workerMode?: string }
  | { kind: "blocked"; limit: string };

async function classifyConflictRepresentations(
  capture: WaveCaptureResult,
  sourceRoot: string,
  plan: LandingPlan,
  options: MaterializeLandingConflictsOptions,
): Promise<Map<string, ConflictRepresentation>> {
  const out = new Map<string, ConflictRepresentation>();
  for (const entry of plan.paths) {
    if (entry.action !== "conflict") continue;
    try {
      validatePathSafe(entry.path);
    } catch (error) {
      // Unsafe or escaping paths are a safety boundary, not a representation
      // limit: no approved mode can represent them, so they always refuse.
      out.set(entry.path, { kind: "blocked", limit: error instanceof Error ? error.message : "unsafe path" });
      continue;
    }
    const destination = resolve(sourceRoot, entry.path);
    if (!inside(sourceRoot, destination)) {
      out.set(entry.path, { kind: "blocked", limit: "destination escapes the source root" });
      continue;
    }
    const stat = await lstat(destination).catch(() => undefined);

    // The first concrete limit found names the refusal or record; the order
    // is stable so reports are deterministic.
    let limit: string | undefined;
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      limit = "destination is not a regular file";
    } else if (entry.base?.mode === "120000" || entry.result?.mode === "120000") {
      limit = "a symlink side cannot be represented alongside the target";
    } else {
      const oversized: string[] = [];
      if (stat && stat.size > MAX_CONFLICT_BYTES) {
        oversized.push(`current workspace content is ${stat.size} bytes (limit ${MAX_CONFLICT_BYTES})`);
      }
      for (const side of ["base", "result"] as const) {
        const blobId = entry[side]?.blobId;
        if (!blobId) continue;
        const size = await blobSize(capture.repositoryPath, blobId);
        if (size > MAX_CONFLICT_BYTES) oversized.push(`${side} content is ${size} bytes (limit ${MAX_CONFLICT_BYTES})`);
      }
      if (oversized.length > 0) limit = oversized.join("; ");
    }

    // Binary detection reads the full content within the size limit above.
    const binarySides: string[] = [];
    if (!limit && stat && (await readFile(destination)).includes(0)) binarySides.push("current workspace");
    if (!limit) for (const side of ["base", "result"] as const) {
      const treeEntry = entry[side];
      if (!treeEntry?.blobId) continue;
      if ((await blob(capture.repositoryPath, treeEntry)).includes(0)) binarySides.push(side);
    }

    if (binarySides.length > 0) {
      // #126 approved: preserve the target in place and save the worker
      // version alongside. A delete/modify conflict has no worker content to
      // save, so it records the deletion intent instead of fabricating bytes.
      if (!entry.result?.blobId) {
        const limit = `binary ${binarySides.join(" and ")} content with a worker-side deletion cannot be represented`;
        out.set(entry.path, options.preserveUnrepresentable
          ? { kind: "preserve", limit }
          : { kind: "blocked", limit });
        continue;
      }
      const limit = `binary ${binarySides.join(" and ")} content cannot carry text conflict markers`;
      out.set(entry.path, options.binarySidecars
        ? { kind: "sidecar", limit, workerMode: entry.result.mode }
        : { kind: "blocked", limit });
      continue;
    }

    if (limit) {
      // #126 approved (explicit force-merge only): preserve the
      // unrepresentable conflict in place instead of aborting the whole
      // merge. Available worker bytes are saved alongside; a worker-side
      // deletion is recorded without fabricating content. Ordinary reviewed
      // landing keeps refusing before any mutation.
      if (!options.preserveUnrepresentable) {
        out.set(entry.path, { kind: "blocked", limit });
        continue;
      }
      if (entry.result?.blobId) {
        out.set(entry.path, { kind: "sidecar", limit, workerMode: entry.result.mode });
      } else {
        out.set(entry.path, { kind: "preserve", limit });
      }
      continue;
    }

    out.set(entry.path, { kind: "text" });
  }
  return out;
}

/** Collision-safe sidecar location for a worker version saved alongside its
 * conflicted target. The name derives from the worker blob id (stable across
 * retries); an occupied name gets a numeric suffix instead of overwriting.
 * A candidate is free only when it is absent on disk AND does not collide
 * with any planner-reserved path (a planned landing or an earlier sidecar):
 * reserved destinations are not on disk yet, so lstat alone would let two
 * prepared entries install at the same path and rename-overwrite each other.
 * An ancestor/descendant relationship also collides — a regular file cannot
 * coexist with a path nested inside it. Collisions are compared
 * case-insensitively (every reserved entry carries its lowercase twin) so a
 * case-variant name on a case-insensitive filesystem is never picked. */
async function chooseSidecarPath(
  sourceRoot: string,
  entryPath: string,
  resultBlobId: string,
  reserved: ReadonlySet<string>,
): Promise<string> {
  const stem = `${entryPath}.worker-${resultBlobId.slice(0, 12)}`;
  for (let n = 0; n < 100; n++) {
    const candidate = resolve(sourceRoot, n === 0 ? stem : `${stem}-${n}`);
    if (!inside(sourceRoot, candidate)) throw new Error(`Sidecar path escapes source root: ${entryPath}`);
    const folded = candidate.toLowerCase();
    if ([...reserved].some((path) => inside(folded, path) || inside(path, folded))) continue;
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
  reserved: Set<string>,
  representation?: ConflictRepresentation,
): Promise<PreparedPath> {
  validatePathSafe(entry.path);
  const destination = resolve(sourceRoot, entry.path);
  if (!inside(sourceRoot, destination)) throw new Error(`Conflict path escapes source root: ${entry.path}`);

  if (representation?.kind === "preserve") {
    // #126 approved (explicit force-merge only): no worker bytes exist to
    // save (worker-side deletion) — the target is kept exactly intact and the
    // unresolved operation is recorded in the conflict manifest only. Nothing
    // is installed, so no destination safety walk is needed or performed.
    return {
      path: entry.path,
      originalPath: entry.path,
      existed: false,
      mode: 0o644,
      backupMode: 0o644,
      kind: "preserve",
      conflicted: true,
      workerMode: representation.workerMode,
      limit: representation.limit,
    };
  }

  await ensureSafeParent(sourceRoot, entry.path);
  const stat = await lstat(destination).catch(() => undefined);
  if (representation?.kind !== "sidecar" && stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Cannot safely materialize text conflict markers over non-regular path: ${entry.path}`);
  }

  if (representation?.kind === "sidecar") {
    // #126 approved binary handling: never touch the target. Save the worker
    // version alongside at a collision-safe path; the gate keeps the conflict
    // unresolved until the sidecar is handled manually. The blob is streamed
    // to disk so preserved content is not capped at the text-materialization
    // size limit.
    if (!entry.result?.blobId) throw new Error(`Binary conflict without a worker version cannot be sidecarred for ${entry.path}.`);
    const token = randomUUID();
    const staged = join(stagedDir, `${token}.result`);
    await streamBlobToStaged(capture.repositoryPath, entry.result.blobId, staged);
    const sidecarDestination = await chooseSidecarPath(sourceRoot, entry.path, entry.result.blobId, reserved);
    // Reserve the chosen name (and its case-folded twin) immediately so a
    // later sidecar in this same call cannot pick it either.
    reserved.add(sidecarDestination);
    reserved.add(sidecarDestination.toLowerCase());
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
      workerMode: representation.workerMode,
      limit: representation.limit,
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
  streamCleanBlobs: boolean,
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
  const staged = join(stagedDir, `${token}.result`);
  // Symlink targets and ordinary reviewed landing keep the bounded read. For
  // explicit force-merge, a nonconflicting regular file is a plain byte copy
  // that carries no text markers, so stream it to staging without the
  // marker-materialization size limit (partial files are removed on failure).
  if (!streamCleanBlobs || entry.result.mode === "120000" || !entry.result.blobId) {
    const content = await blob(capture.repositoryPath, entry.result);
    if (content.length > MAX_CONFLICT_BYTES) throw new Error(`Clean result is too large to apply transactionally for ${entry.path}.`);
    await writeFile(staged, content, { mode: 0o600 });
  } else {
    await streamBlobToStaged(capture.repositoryPath, entry.result.blobId, staged);
  }
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

async function installPrepared(item: PreparedPath, hooks: MaterializeConflictHooks = {}): Promise<void> {
  if (item.kind === "preserve") return; // record-only: nothing is installed
  if (!item.destination) throw new Error(`Prepared landing destination is missing for ${item.path}.`);
  if (item.kind === "delete") {
    await rm(item.destination, { force: true });
    return;
  }
  if (!item.staged) throw new Error(`Prepared landing content is missing for ${item.path}.`);
  const install = join(dirname(item.destination), `.pi-review-conflict-${randomUUID()}`);
  try {
    if (item.kind === "symlink") {
      const target = await readFile(item.staged, "utf8");
      await symlink(target, install);
    } else {
      await copyFile(item.staged, install, constants.COPYFILE_EXCL);
      await chmod(install, item.mode);
    }
    if (item.kind === "sidecar") {
      // Late-collision safety: the destination was verified free when it was
      // chosen; if anything now occupies it, fail instead of overwriting it.
      // The item is not recorded as installed, so rollback leaves the unowned
      // occupant exactly in place.
      await hooks.beforeSidecarInstall?.(item.destination);
      try {
        // Atomic no-overwrite install: link fails with EEXIST when anything
        // occupies the destination — including a name differing only by case
        // on a case-insensitive filesystem — instead of renaming over it.
        // The test-only seam throws to simulate a link failure; a normal
        // return falls through to the real atomic link below.
        await hooks.failSidecarLink?.(item.destination);
        await link(install, item.destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          throw new Error(`Sidecar destination is occupied at install time: ${item.path}`);
        }
        // Hard links unsupported or refused by this filesystem: fail closed.
        // There is deliberately no lstat-then-rename fallback — a writer that
        // lands between the check and the rename would be overwritten, which
        // violates the never-overwrite-target/unrelated-files contract.
        if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
          throw new Error(
            `Atomic sidecar install is unsupported on this filesystem (${code}) for ${item.path}; ` +
            "refusing to fall back to a rename that could overwrite an unowned file.",
          );
        }
        throw error;
      }
      // Drop the temp name; the destination keeps the shared inode and mode.
      await rm(install, { force: true }).catch(() => undefined);
      return;
    }
    await rename(install, item.destination);
  } catch (error) {
    // Never leave the same-directory temp behind when an install fails.
    await rm(install, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function restorePrepared(item: PreparedPath): Promise<void> {
  // Record-only entries installed nothing; any other missing destination means
  // there is nothing to roll back either.
  if (item.kind === "preserve" || !item.destination) return;
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

/** Stream a blob straight to a staged file without buffering it in memory:
 * preserved worker content may exceed the text-materialization size limit.
 * Fails closed — the partial file is removed — on any git or I/O error. */
async function streamBlobToStaged(repositoryPath: string, blobId: string, destination: string): Promise<void> {
  const child = spawn("git", ["cat-file", "blob", blobId], { cwd: repositoryPath });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  // Register the exit-code promise before awaiting the stream so a signal- or
  // OOM-terminated git (no normal exit code) cannot fire `close` before the
  // listener attaches and hang the force-merge while it holds the source-mutation
  // lease. The listener is attached synchronously right after spawn, so no
  // `close` event can be missed.
  const exited = new Promise<number | null>((resolveCode) => {
    child.once("close", (code) => resolveCode(code));
  });
  try {
    await new Promise<void>((resolveStream, rejectStream) => {
      const out = createWriteStream(destination, { mode: 0o600 });
      let settled = false;
      const settle = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        child.kill();
        if (error) {
          void rm(destination, { force: true }).catch(() => undefined);
          rejectStream(error);
        } else {
          resolveStream();
        }
      };
      out.on("finish", () => resolveStream());
      out.on("error", (error) => settle(error));
      child.stdout.on("error", (error) => settle(error));
      child.on("error", (error) => settle(error));
      child.stdout.pipe(out);
    });
    // A non-zero or signal exit means git failed; the partial file must not be kept.
    const code = await exited;
    if (code !== 0) {
      throw new Error(`git cat-file blob ${blobId.slice(0, 12)} failed (exit ${code ?? "signal"}): ${stderr.trim() || "no diagnostic"}`);
    }
  } catch (error) {
    child.kill();
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
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
