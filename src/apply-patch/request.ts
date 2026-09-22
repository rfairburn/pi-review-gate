/// Sequential multi-file ApplyPatch request engine (Codex-compatible).
///
/// The complete canonical envelope is parsed before any filesystem mutation,
/// so malformed requests fail cleanly with no side effects. File operations
/// are then applied sequentially in envelope order, exactly like Codex's
/// apply_hunks_to_files loop: the first failing operation stops the request,
/// earlier successful operations remain applied, later operations are not
/// attempted, and the result explicitly reports the applied, failed, and
/// not-attempted operations plus any uncertain effects of the failed
/// operation (for example a move whose destination was created but whose
/// source removal failed).
///
/// Each individual file mutation keeps the existing staged-write safety:
/// same-directory staging, atomic no-overwrite link commits for create and
/// move destinations, and identity revalidation before overwriting or deleting
/// an existing source. Path access intentionally matches Pi's native
/// edit/write tools: paths resolve against the current working directory and
/// outside-workspace destinations (including authorized scratch paths) are
/// supported wherever the host filesystem allows; symlinked sources are
/// followed like native edit's write-through. There is deliberately no
/// cross-file rollback: POSIX provides no multi-file atomicity, so this module
/// reports the accumulated delta truthfully instead of pretending otherwise.

import { randomUUID } from "node:crypto";
import { chmod, lstat, link, mkdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ChangedFile } from "../capture";
import { buildUnifiedPatch } from "../diff";
import { applyDiff } from "./engine";
import type { ApplyPatchFileOp } from "./envelope";
import { resolveTargetPath, type ResolvedPath } from "./paths";

export type ApplyPatchOperationType = "create_file" | "update_file" | "delete_file";

/** A successfully applied file operation. */
export interface AppliedOperation {
  operation: ApplyPatchOperationType;
  path: string;
  moveTo?: string;
  absolutePath: string;
  changed: boolean;
  addedLines: number;
  removedLines: number;
  bytes: number;
  requestedDiff: string;
  finalDiff?: string;
  mutated: boolean;
}

/** The operation that stopped a sequential request. */
export interface ApplyPatchFailure {
  /** Zero-based position of the failed operation within the request. */
  index: number;
  operation: ApplyPatchOperationType;
  path: string;
  moveTo?: string;
  error: string;
  /** Observable effects the failed operation may have left behind, if any. */
  uncertainEffects: string[];
}

export interface ApplyPatchRequestResult {
  /** Operations applied before the failure (all of them on success). */
  applied: AppliedOperation[];
  /** Present when an operation failed and stopped the request. */
  failed?: ApplyPatchFailure;
  /** Display labels of operations that were never attempted after a failure. */
  notAttempted: string[];
  /** Combined bounded unified diff of every applied change (accumulated delta). */
  finalDiff?: string;
}

const MAX_REQUESTED_DIFF_CHARS = 4_000;
const MAX_FINAL_DIFF_BYTES = 8_000;
const MAX_DELETE_SOURCE_BYTES = 262_144;

interface FileIdentity {
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
}

interface SourceState {
  /** The operation path resolved against the cwd. */
  resolved: ResolvedPath;
  /**
   * Absolute path of the final regular file the mutation applies to. Equal to
   * `resolved.absolute` for regular sources; for a symlinked source it is the
   * resolved target, so updates write through the link exactly like native
   * edit's writeFile while the link itself is preserved.
   */
  target: string;
  /**
   * Identity of the symlink itself, present only when `target` differs from
   * `resolved.absolute`. Each filesystem object carries exactly one canonical
   * identity here: this entry for the link, `identity` for the file it
   * resolved to. Removal operations (delete_file and moveTo source removal)
   * unlink the named path, so they revalidate this identity in addition to
   * the target file's before removing anything.
   */
  linkIdentity?: FileIdentity;
  identity: FileIdentity;
  originalBytes: Buffer;
  /** Decoded text without BOM and with LF line endings. */
  body: string;
  hadBom: boolean;
  hadCrlf: boolean;
}

interface PreparedOperation {
  op: ApplyPatchFileOp;
  index: number;
  source?: SourceState;
  destination?: ResolvedPath;
  /** Final encoded content to write (create and changed/moved updates). */
  newContent?: string;
  /** Decoded updated text without BOM/CRLF conversion (changed/moved updates). */
  newBody?: string;
  changed?: boolean;
  /** Directory chain created by this operation (deepest first), if any. */
  createdDirs: string[];
  /** Observable effects recorded as commit steps complete; reported when the operation fails partway through. */
  effects: string[];
}

function displayLabel(op: ApplyPatchFileOp): string {
  return `${op.type} ${op.path}${op.moveTo ? ` (moveTo ${op.moveTo})` : ""}`;
}

/**
 * Applies the operations of one request sequentially in order, stopping at
 * the first failure. Earlier successes are retained and reported; later
 * operations are not attempted. The complete envelope was already parsed by
 * the caller before any mutation could happen.
 */
export async function performApplyPatchRequest(
  cwd: string,
  operations: ApplyPatchFileOp[],
  signal?: AbortSignal,
): Promise<ApplyPatchRequestResult> {
  if (operations.length === 0) throw new Error("ApplyPatch request contains no file operations");
  ensureNotAborted(signal);
  const rootLexical = resolve(cwd);

  const applied: AppliedOperation[] = [];
  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i]!;
    let entry: PreparedOperation | undefined;
    try {
      ensureNotAborted(signal);
      entry = await prepareOperation(rootLexical, op, i);
      applied.push(await commitOperation(rootLexical, entry, signal));
    } catch (error) {
      const uncertainEffects: string[] = [...(entry?.effects ?? [])];
      // Best-effort cleanup of the empty directory chain this operation
      // created before it failed. Cleanup problems are accumulated into the
      // failure report — never thrown out of this catch block — so the
      // applied / failed / not-attempted accounting always reaches the caller.
      for (const directory of entry?.createdDirs ?? []) {
        try {
          await rmdir(directory);
        } catch (cleanupError) {
          const code = (cleanupError as NodeJS.ErrnoException).code;
          if (code === "ENOENT") continue;
          if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
            uncertainEffects.push(`directory '${directory}' was left in place (not empty)`);
            continue; // ancestors cannot be empty while this one is not
          }
          uncertainEffects.push(`directory '${directory}' could not be removed: ${messageOf(cleanupError)}`);
        }
      }
      return {
        applied,
        failed: {
          index: i,
          operation: op.type,
          path: op.path,
          ...(op.moveTo ? { moveTo: op.moveTo } : {}),
          error: messageOf(error),
          uncertainEffects,
        },
        notAttempted: operations.slice(i + 1).map(displayLabel),
        finalDiff: renderCombinedFinalDiff(applied),
      };
    }
  }

  return { applied, notAttempted: [], finalDiff: renderCombinedFinalDiff(applied) };
}

// ---------------------------------------------------------------------------
// Per-operation validation (executed at the operation's turn, in order)
// ---------------------------------------------------------------------------

async function prepareOperation(
  rootLexical: string,
  op: ApplyPatchFileOp,
  index: number,
): Promise<PreparedOperation> {
  const entry: PreparedOperation = { op, index, createdDirs: [], effects: [] };

  if (op.type === "create_file") {
    const target = await resolveTargetPath(rootLexical, op.path, `operation ${index + 1} path`);
    await requireAbsent(target.absolute, op.path);
    entry.destination = target;
    // Canonical envelope adds carry the final content (each `+line`
    // contributes `line + "\n"`).
    const newContent = op.createContent ?? "";
    if (newContent.includes("\0")) {
      throw new Error(`create_file ${op.path}: refusing to write binary content (NUL byte)`);
    }
    entry.newContent = newContent;
    return entry;
  }

  if (op.type === "delete_file") {
    const source = await readSource(rootLexical, op.path, `operation ${index + 1} path`);
    if (source.body.includes("\0")) {
      throw new Error(`delete_file ${op.path}: refusing to delete binary content (NUL byte)`);
    }
    entry.source = source;
    return entry;
  }

  // update_file: patch the content now, at this operation's turn. A later
  // operation may legitimately target the same file again and will read the
  // state left by this one (Codex sequential semantics).
  const source = await readSource(rootLexical, op.path, `operation ${index + 1} path`);
  let updated: string;
  try {
    updated = applyDiff(source.body, op.diff ?? "");
  } catch (error) {
    throw new Error(`update_file ${op.path}: ${messageOf(error)}`);
  }
  if (updated.includes("\0") || source.body.includes("\0")) {
    throw new Error(`update_file ${op.path}: refusing to write binary content (NUL byte)`);
  }
  entry.source = source;
  entry.newContent = joinEncoding(updated, source.hadBom, source.hadCrlf);
  entry.newBody = updated;
  entry.changed = updated !== source.body;

  if (op.moveTo !== undefined) {
    const destination = await resolveTargetPath(rootLexical, op.moveTo, `operation ${index + 1} moveTo`);
    if (destination.absolute === source.resolved.absolute || destination.real === source.resolved.real) {
      throw new Error(`operation ${index + 1} moveTo ${op.moveTo} resolves to the same file as operation.path ${op.path}`);
    }
    await requireAbsent(destination.absolute, op.moveTo);
    entry.destination = destination;
  }
  return entry;
}

async function readSource(rootLexical: string, path: string, field: string): Promise<SourceState> {
  const resolved = await resolveTargetPath(rootLexical, path, field);
  let stats = await lstat(resolved.absolute).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${path} does not exist; only create_file may add a new file`);
    if (code === "ENOTDIR") throw new Error(`${path} cannot exist because an intermediate path component is not a directory`);
    throw new Error(`${path}: ${messageOf(error)}`);
  });
  // Native edit/write parity: a symlinked source is followed like native
  // edit's writeFile (write-through). The mutation is applied at the resolved
  // regular file so the link itself is preserved; a dangling symlink is
  // reported truthfully as a missing target.
  let target = resolved.absolute;
  let linkIdentity: FileIdentity | undefined;
  if (stats.isSymbolicLink()) {
    // Remember the link's own identity before following it: a removal
    // operation unlinks this named entry, so it must be able to verify at
    // commit time that it is still removing the very link that was validated.
    linkIdentity = { ino: stats.ino, mode: stats.mode, size: stats.size, mtimeMs: stats.mtimeMs };
    target = await realpath(resolved.absolute).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(`${path} is a dangling symlink; its target does not exist`);
      throw new Error(`${path}: ${messageOf(error)}`);
    });
    stats = await lstat(target).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(`${path} does not exist; only create_file may add a new file`);
      throw new Error(`${path}: ${messageOf(error)}`);
    });
  }
  if (!stats.isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
  // Validate the complete source before mutating: ApplyPatch only handles
  // UTF-8 text files, and a cancellation arriving during this read must not
  // lead to an unlink.
  const originalBytes = await readFile(target);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(originalBytes);
  } catch {
    throw new Error(`${path} is binary or not valid UTF-8; ApplyPatch only mutates UTF-8 text files`);
  }
  const { text: body, hadBom, hadCrlf } = splitEncoding(decoded);
  return {
    resolved,
    target,
    ...(linkIdentity !== undefined ? { linkIdentity } : {}),
    identity: { ino: stats.ino, mode: stats.mode, size: stats.size, mtimeMs: stats.mtimeMs },
    originalBytes,
    body,
    hadBom,
    hadCrlf,
  };
}

// ---------------------------------------------------------------------------
// Per-operation commit (staged-write safety)
// ---------------------------------------------------------------------------

async function commitOperation(
  rootLexical: string,
  entry: PreparedOperation,
  signal?: AbortSignal,
): Promise<AppliedOperation> {
  const op = entry.op;

  if (op.type === "create_file") {
    const target = entry.destination!;
    const content = entry.newContent!;
    const bytes = Buffer.from(content, "utf8");
    entry.createdDirs = await ensureDirectories(target.absolute, rootLexical);
    const temp = await stageFile(dirname(target.absolute), basename(target.absolute), bytes, undefined, signal);
    try {
      ensureNotAborted(signal);
      // Commit through the same atomic no-overwrite link as move destinations:
      // a target created between the absence check and the commit is rejected
      // with EEXIST instead of being overwritten.
      await commitStaged(temp, target.absolute, `${op.path} already exists; create_file refuses to overwrite an existing target`);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error instanceof Error ? error : new Error(String(error));
    }
    const diff = renderFinalDiff({ path: op.path, status: "added", newContent: content });
    return {
      operation: "create_file",
      path: op.path,
      absolutePath: target.absolute,
      changed: true,
      ...countDiffLines(diff),
      bytes: Buffer.byteLength(content, "utf8"),
      // Canonical adds have no headerless diff body; the requested envelope is
      // retained at request level.
      requestedDiff: "",
      finalDiff: diff,
      mutated: true,
    };
  }

  if (op.type === "delete_file") {
    const source = entry.source!;
    await revalidateSource(source, op.path);
    // The unlink removes the named path itself: for a symlinked source that is
    // the link, so verify it is still the validated link before removing it.
    await revalidateNamedLink(source, op.path);
    ensureNotAborted(signal);
    // Unlink the path the operation named: for a symlinked source this removes
    // the link itself (rm semantics) and leaves the target file untouched.
    await unlink(source.resolved.absolute);
    // Render a bounded deletion diff for reasonably sized sources. A delete
    // through a symlink removed only the link (the target file and its content
    // still exist at the resolved path), so no content diff is fabricated.
    let finalDiff: string | undefined;
    if (source.target === source.resolved.absolute && source.identity.size <= MAX_DELETE_SOURCE_BYTES) {
      finalDiff = renderFinalDiff({ path: op.path, status: "deleted", oldContent: source.body });
    }
    return {
      operation: "delete_file",
      path: op.path,
      absolutePath: source.resolved.absolute,
      changed: true,
      addedLines: 0,
      removedLines: finalDiff !== undefined ? countDiffLines(finalDiff).removedLines : 0,
      // Only the named link was removed for a symlinked source, so no file
      // content bytes were deleted through it.
      bytes: source.target === source.resolved.absolute ? source.identity.size : 0,
      requestedDiff: "",
      ...(finalDiff !== undefined ? { finalDiff } : {}),
      mutated: true,
    };
  }

  // update_file
  const source = entry.source!;
  await revalidateSource(source, op.path);
  if (op.moveTo === undefined && entry.changed === false) {
    // A patch that changes nothing must not replace the file: rewriting would
    // change the inode and timestamps and could discard hard-link identity or
    // extended metadata.
    ensureNotAborted(signal);
    return {
      operation: "update_file",
      path: op.path,
      absolutePath: source.resolved.absolute,
      changed: false,
      addedLines: 0,
      removedLines: 0,
      bytes: Buffer.byteLength(entry.newContent!, "utf8"),
      requestedDiff: clipText(op.diff ?? "", MAX_REQUESTED_DIFF_CHARS),
      mutated: false,
    };
  }

  const content = entry.newContent!;
  if (op.moveTo === undefined) {
    const bytes = Buffer.from(content, "utf8");
    const temp = await stageFile(dirname(source.target), basename(source.target), bytes, source.identity.mode, signal);
    try {
      // Revalidate after staging: an external edit or replacement that lands
      // during the staging window must not be overwritten by the rename.
      await revalidateSource(source, op.path);
      ensureNotAborted(signal);
      // rename() is atomic: a failure leaves the original file in place. For a
      // symlinked source the rename lands on the resolved target file, so the
      // link keeps resolving to the updated content (native write-through).
      await rename(temp, source.target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error instanceof Error ? error : new Error(String(error));
    }
    const diff = renderFinalDiff({ path: op.path, status: "modified", oldContent: source.body, newContent: entry.newBody! });
    return {
      operation: "update_file",
      path: op.path,
      absolutePath: source.target,
      changed: true,
      ...countDiffLines(diff),
      bytes: Buffer.byteLength(content, "utf8"),
      requestedDiff: clipText(op.diff ?? "", MAX_REQUESTED_DIFF_CHARS),
      finalDiff: diff,
      mutated: true,
    };
  }

  // update_file with moveTo: stage and commit the patched content at the
  // destination first; the source is removed only after the destination
  // exists. If the source removal fails, both files remain and the failure
  // reports them as uncertain effects (Codex-style truthfulness, no rollback).
  const destination = entry.destination!;
  entry.createdDirs = await ensureDirectories(destination.absolute, rootLexical);
  const bytes = Buffer.from(content, "utf8");
  const temp = await stageFile(dirname(destination.absolute), basename(destination.absolute), bytes, source.identity.mode, signal);
  try {
    ensureNotAborted(signal);
    await commitStaged(temp, destination.absolute, `${op.moveTo} already exists; refusing to overwrite an existing destination`);
  } catch (error) {
    // The source was never touched; only the staged temporary file remains.
    await unlink(temp).catch(() => undefined);
    throw new Error(`update_file ${op.path}: moving to ${op.moveTo} failed and the source was left unchanged: ${messageOf(error)}`);
  }
  entry.effects.push(`destination '${op.moveTo}' was created`);
  try {
    ensureNotAborted(signal);
    // Revalidate immediately before removing the source so a concurrent edit
    // in the staging window is not destroyed by the removal; for a symlinked
    // source the named link itself must still be the validated one.
    await revalidateSource(source, op.path);
    await revalidateNamedLink(source, op.path);
    await unlink(source.resolved.absolute);
  } catch (error) {
    entry.effects.push(`source '${op.path}' was left in place`);
    throw new Error(
      `update_file ${op.path}: moving to ${op.moveTo} failed after the destination was created; both files remain in place: ${messageOf(error)}`,
    );
  }
  const diff = renderFinalDiff({ path: op.moveTo, renamedFrom: op.path, status: "modified", oldContent: source.body, newContent: entry.newBody! });
  return {
    operation: "update_file",
    path: op.path,
    moveTo: op.moveTo,
    absolutePath: destination.absolute,
    changed: entry.changed === true,
    ...countDiffLines(diff),
    bytes: Buffer.byteLength(content, "utf8"),
    requestedDiff: clipText(op.diff ?? "", MAX_REQUESTED_DIFF_CHARS),
    finalDiff: diff,
    mutated: true,
  };
}

/**
 * Revalidates the identity observed during this operation's validation. A
 * mismatch means an external process edited the file in the meantime;
 * overwriting it would destroy concurrent work, so the operation fails and
 * (as one of possibly several operations) stops the request.
 */
async function revalidateSource(source: SourceState, display: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(source.target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${display} no longer exists; refusing to continue`);
    throw new Error(`${display}: ${messageOf(error)}`);
  }
  const identity = source.identity;
  if (stats.ino !== identity.ino || stats.size !== identity.size || stats.mtimeMs !== identity.mtimeMs || stats.mode !== identity.mode) {
    throw new Error(`${display} changed after validation; refusing to overwrite concurrent edits`);
  }
}

/**
 * Revalidates the symlink itself before an operation removes the named path.
 * revalidateSource protects the target file's content, but the unlink removes
 * whatever currently sits at the named path: if that link was replaced during
 * preparation — with a regular file or another link — removing the replacement
 * would destroy state ApplyPatch never validated (including the UTF-8 text
 * check), so the operation fails instead. Regular sources have no separate
 * link entry; their named path is the very file revalidateSource covered.
 */
async function revalidateNamedLink(source: SourceState, display: string): Promise<void> {
  if (source.linkIdentity === undefined) return;
  let stats;
  try {
    stats = await lstat(source.resolved.absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${display} no longer exists; refusing to continue`);
    throw new Error(`${display}: ${messageOf(error)}`);
  }
  if (!stats.isSymbolicLink()) {
    throw new Error(`${display} was replaced with a non-symlink after validation; refusing to remove the replacement`);
  }
  const identity = source.linkIdentity;
  if (stats.ino !== identity.ino || stats.size !== identity.size || stats.mtimeMs !== identity.mtimeMs || stats.mode !== identity.mode) {
    throw new Error(`${display} was replaced after validation; refusing to remove the replacement`);
  }
  // Inode reuse can in principle hand a fresh link the same identity fields,
  // so also require that the named path still resolves to the validated target.
  const currentTarget = await realpath(source.resolved.absolute).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${display} no longer exists; refusing to continue`);
    throw new Error(`${display}: ${messageOf(error)}`);
  });
  if (currentTarget !== source.target) {
    throw new Error(`${display} now points to a different target; refusing to remove the replacement link`);
  }
}

// ---------------------------------------------------------------------------
// Staging and commit primitives
// ---------------------------------------------------------------------------

/**
 * Writes the replacement content to a same-directory temporary file and
 * returns its path. When a mode is provided, chmod restores the exact original
 * permission bits: open(2) masks the requested mode with the process umask,
 * so writeFile alone would not preserve e.g. 0o666 under umask 022.
 */
async function stageFile(
  directory: string,
  fileName: string,
  bytes: Buffer,
  mode: number | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const temp = join(directory, `.${fileName}.apply-patch-${process.pid}-${randomUUID()}.tmp`);
  try {
    ensureNotAborted(signal);
    await writeFile(temp, bytes, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) await chmod(temp, mode & 0o7777);
    ensureNotAborted(signal);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
  return temp;
}

/**
 * Commits staged content at the destination using link(), which is atomic and
 * fails with EEXIST when the destination already exists — no-overwrite
 * semantics without a separate check-then-commit window. If hard links are
 * unavailable, fail safely rather than falling back to rename(), which could
 * overwrite a destination created after validation.
 */
async function commitStaged(temp: string, destination: string, existsMessage: string): Promise<void> {
  try {
    await link(temp, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(existsMessage);
    throw error instanceof Error ? error : new Error(String(error));
  }
  await unlink(temp).catch(() => undefined);
}

/**
 * Creates the missing directory chain for a target and returns it (deepest
 * first) so a failed operation can clean up or report the directories it
 * created. Directory creation is intentionally not limited to the workspace:
 * native write also creates parent directories wherever the host allows.
 */
async function ensureDirectories(targetAbsolute: string, rootLexical: string): Promise<string[]> {
  const missing: string[] = [];
  let dir = dirname(targetAbsolute);
  for (;;) {
    if (dir === rootLexical || dirname(dir) === dir) break;
    try {
      await lstat(dir);
      break; // exists (file or directory; checked below)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new Error(`cannot prepare directories for ${targetAbsolute}: ${messageOf(error)}`);
      missing.push(dir);
      dir = dirname(dir);
    }
  }
  // The first existing component must be a directory (symlinks are followed;
  // the final target was already resolved through resolveTargetPath).
  const stats = await stat(dir).catch((error: unknown) => {
    throw (error as NodeJS.ErrnoException).code === "ENOENT"
      ? new Error(`cannot prepare directories for ${targetAbsolute}: missing parent`)
      : error instanceof Error ? error : new Error(String(error));
  });
  if (!stats.isDirectory()) {
    throw new Error(`${basename(targetAbsolute)} cannot be created because an intermediate path component is not a directory`);
  }
  if (missing.length > 0) await mkdir(dirname(targetAbsolute), { recursive: true });
  return missing;
}

async function requireAbsent(absolute: string, display: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "ENOTDIR") {
      throw new Error(`${display} cannot exist because an intermediate path component is not a directory`);
    }
    throw new Error(`${display}: ${messageOf(error)}`);
  }
  if (stats.isDirectory()) {
    throw new Error(`${display} already exists and is a directory; create_file requires a non-existing file path`);
  }
  throw new Error(`${display} already exists; create_file and moveTo destinations must not exist`);
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("ApplyPatch was cancelled");
  }
}

// ---------------------------------------------------------------------------
// Content and rendering helpers
// ---------------------------------------------------------------------------

function splitEncoding(content: string): { text: string; hadBom: boolean; hadCrlf: boolean } {
  const hadBom = content.charCodeAt(0) === 0xfeff;
  const withoutBom = hadBom ? content.slice(1) : content;
  const hadCrlf = withoutBom.includes("\r\n");
  const text = hadCrlf ? withoutBom.replace(/\r\n/g, "\n") : withoutBom;
  return { text, hadBom, hadCrlf };
}

function joinEncoding(content: string, hadBom: boolean, hadCrlf: boolean): string {
  let result = hadCrlf ? content.replace(/\n/g, "\r\n") : content;
  if (hadBom) result = `\uFEFF${result}`;
  return result;
}

function renderFinalDiff(options: {
  path: string;
  renamedFrom?: string;
  status: "added" | "modified" | "deleted";
  oldContent?: string;
  newContent?: string;
}): string {
  const change: ChangedFile = {
    path: options.path,
    status: options.status,
    binary: false,
    oversized: false,
    ...(options.renamedFrom ? { renamedFrom: options.renamedFrom } : {}),
    ...(options.oldContent !== undefined ? { oldContent: options.oldContent } : {}),
    ...(options.newContent !== undefined ? { newContent: options.newContent } : {}),
  };
  const { patch } = buildUnifiedPatch([change], MAX_FINAL_DIFF_BYTES);
  return patch.trimEnd();
}

/** Renders one combined bounded unified diff covering every applied operation. */
function renderCombinedFinalDiff(applied: AppliedOperation[]): string | undefined {
  const parts = applied.map((outcome) => outcome.finalDiff).filter((diff): diff is string => typeof diff === "string" && diff.length > 0);
  if (parts.length === 0) return undefined;
  let combined = parts.join("\n");
  const maxBytes = Buffer.byteLength(combined, "utf8");
  if (maxBytes > MAX_FINAL_DIFF_BYTES) {
    // Bound the accumulated delta for rendering; per-operation diffs remain
    // individually bounded in the structured details.
    let truncated = "";
    for (const part of parts) {
      if (Buffer.byteLength(truncated + "\n" + part, "utf8") > MAX_FINAL_DIFF_BYTES - 32) break;
      truncated = truncated === "" ? part : `${truncated}\n${part}`;
    }
    combined = `${truncated}\n[... truncated ...]`;
  }
  return combined;
}

/**
 * Counts added/removed content lines in a unified patch. Only the first
 * `--- `/`+++ ` line of each file section is a header; later lines that start
 * with those sequences are content (e.g. a removed line reading `-- flag`).
 */
function countDiffLines(patch: string): { addedLines: number; removedLines: number } {
  let added = 0;
  let removed = 0;
  let sawOldHeader = false;
  let sawNewHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      sawOldHeader = false;
      sawNewHeader = false;
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) continue;
    if (!sawOldHeader && line.startsWith("--- ")) { sawOldHeader = true; continue; }
    if (!sawNewHeader && line.startsWith("+++ ")) { sawNewHeader = true; continue; }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { addedLines: added, removedLines: removed };
}

function clipText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[... truncated ...]`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
