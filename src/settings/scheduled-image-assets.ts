/**
 * Durable managed copies for images pasted into scheduled-task instructions
 * through the native host editor.
 *
 * Pi's native image paste (Ctrl+V in the host's main-prompt editor) inserts a
 * path to a temporary clipboard file — a path, never image bytes. A temporary
 * file is routinely deleted, so a scheduled instruction that names one would
 * break silently on a later run. At Save, an observed native insert whose text
 * appears verbatim in the staged instructions and validates as a real,
 * bounded, supported image is copied once into a private managed store next
 * to the config file, and the staged path is replaced by the managed absolute
 * path before the ordinary atomic config persistence.
 *
 * Provenance and content boundaries (fail closed):
 *
 * - Provenance comes only from the bridge's observation-only
 *   {@link ../native-editor-bridge.ts: NativeEditorFieldOptions.onHostInsert}
 *   seam: exactly the text Pi's own handlers insert through the editor's
 *   public `insertTextAtCursor`. That observation alone is NOT proof of an
 *   image — plain clipboard text goes through the same seam, and a native
 *   paste may complete asynchronously (possibly after the field settles). So
 *   an observation is only a *candidate*, and only for text Pi's image paste
 *   could have produced: a single absolute path token under the OS temp
 *   directory named `pi-clipboard-<UUID>.<supported ext>` (Pi's own
 *   documented paste naming), appearing verbatim in the FINAL staged
 *   instructions at Save, and passing real content validation
 *   (PNG/JPEG/GIF/WebP magic bytes, regular file, bounded size). Any other
 *   observed insert — ordinary clipboard text, an absolute path to a real or
 *   nonexistent file, a sentence — is not an image candidate: it stays
 *   verbatim in the instructions and Save proceeds exactly as native text
 *   paste always behaved. Recognized candidates that were deleted or edited
 *   away are never copied; a recognized pasted temp path that fails
 *   validation fails the whole Save closed with an actionable notice, leaving
 *   the config untouched.
 * - A Pi-native clipboard temp path (`<tmpdir>/pi-clipboard-*`, Pi's own
 *   documented paste naming) that appears in the staged instructions WITHOUT
 *   matching native-paste provenance can never be verified as an image and
 *   would promise future image availability it cannot keep (Pi deletes its
 *   clipboard temp files). Such a reference fails the Save with an actionable
 *   message instead of being copied or persisted — including hand-edited or
 *   reopened configs and the non-interactive editor/input fallback, where no
 *   observation exists. Ordinary typed paths and commands are left untouched:
 *   recognition is bounded to Pi's own temp naming, never a scan for
 *   arbitrary file references.
 * - Nothing here touches the clipboard, the editor, or Pi's paste handler,
 *   and no heuristic path scan runs over free text: only provenance-carrying
 *   observed inserts are ever considered, and `@`-picker selections or
 *   terminal drops (whose image provenance is not observable through public
 *   native seams) are left as ordinary text.
 * - The managed store is private (0700 directories, 0600 files, fsynced
 *   before rename, directory fsync best-effort) and append-only across saves:
 *   assets are never auto-deleted when an entry is edited or removed, because
 *   active or other-process scheduled runs may still read them. Cleanup is
 *   manual, after every run that could reference the file has settled.
 * - At dispatch, a managed asset referenced by an entry must exist; a missing
 *   one fails the dispatch with an actionable report through the existing
 *   scheduler failure wake instead of silently starting a run against a dead
 *   path.
 */

import { randomUUID } from "node:crypto";
import { open, chmod, lstat, mkdir, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { cloneScheduledTaskCatalog, type ScheduledTaskCatalog } from "../config";

/** Hard upper bound for one managed scheduled-image asset. */
export const MAX_SCHEDULED_IMAGE_BYTES = 10 * 1024 * 1024;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Managed-store directory name, placed next to the config file. */
export const SCHEDULED_IMAGE_STORE_DIRNAME = "scheduled-image-assets";

/**
 * The managed store root for one config file: `<config dir>/scheduled-image-assets`.
 * The config path is resolved first, so the supported relative
 * `PI_REVIEW_GATE_CONFIG` spelling still yields a managed ABSOLUTE path that a
 * later scheduled run can read regardless of the worker's working directory.
 */
export function managedScheduledImageRoot(configPath: string): string {
  return join(dirname(resolve(configPath)), SCHEDULED_IMAGE_STORE_DIRNAME);
}

/** Actionable failure for the Save-time asset transaction (or a dispatch check). */
export class ScheduledImageAssetError extends Error {}

/** Pi's native clipboard paste names its temp files `pi-clipboard-<uuid>.<ext>`. */
const PI_CLIPBOARD_PREFIX = "pi-clipboard-";

/**
 * The exact basename Pi's native image paste produces:
 * `pi-clipboard-<UUID>.<ext>` — a `crypto.randomUUID()` UUID and one of the
 * extensions Pi's clipboard handler writes (`png`, `jpg`, `webp`, `gif`;
 * `jpeg` accepted defensively). Content is still validated after this path
 * recognition; this gate only decides whether an observed absolute path is
 * even a candidate for a pasted image. Ordinary clipboard text — any other
 * absolute path, real or nonexistent — never matches, so a plain text paste
 * is left as ordinary text and Save behaves exactly as it always did.
 */
const PI_CLIPBOARD_IMAGE_NAME = /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/i;

/**
 * True for a path inside the OS temp directory whose basename matches Pi's
 * native clipboard temp-image naming (`<tmpdir>/pi-clipboard-...`). This is
 * a bounded recognition of Pi's own documented temp naming — never a scan
 * for arbitrary file paths.
 */
export function isPiClipboardTempPath(path: string): boolean {
  return dirname(path) === tmpdir() && basename(path).startsWith(PI_CLIPBOARD_PREFIX) && basename(path).length > PI_CLIPBOARD_PREFIX.length;
}

/**
 * True for a path that Pi's native image paste itself could have inserted:
 * inside `tempDir` (the OS temp directory by default), named
 * `pi-clipboard-<UUID>.<supported ext>`. This is the strict managed-copy
 * recognition — the broader {@link isPiClipboardTempPath} stays reserved for
 * the fail-closed gate on unobserved temp references. A path that matches
 * still has to pass real content validation before anything is copied.
 * `tempDir` exists for direct whitespace-temp-directory tests; production
 * callers use the default.
 */
export function isPiClipboardTempImagePath(path: string, tempDir: string = tmpdir()): boolean {
  return dirname(path) === tempDir && PI_CLIPBOARD_IMAGE_NAME.test(basename(path));
}

/**
 * Characters that can be part of a path or word. A reference token must start
 * AFTER one of these ends: whitespace, quotes, backticks, brackets, and other
 * punctuation are legal boundaries; a glued segment (for example
 * "...-adjacent" or "xpi-clipboard-...") never starts a token.
 */
const NOT_A_TOKEN_BOUNDARY = /[A-Za-z0-9_./~\\-]/;

/**
 * Token scanner for one bounded prefix (Pi's clipboard temp naming, or this
 * config's managed store root). A token starts at any non-path-character
 * boundary (whitespace, quotes, backticks, brackets, or the string start),
 * extends to the next whitespace, and trailing sentence punctuation is
 * trimmed so a path followed by "," still compares equal to the inserted
 * path. When `requireSeparatorAfter` is set (the managed-root scan), the
 * prefix must be followed by a path separator, so text that merely begins
 * with the store path (for example "...-adjacent") never matches. Both slash
 * spellings are accepted there on every platform:
 * managed paths are produced with the platform separator, and accepting the
 * other spelling only widens the fail-closed dispatch existence check — it
 * never widens what Save copies.
 */
const TOKEN_TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", ")", "]", "}", "'", '"']);

function tokensAfter(instructions: string, prefix: string, requireSeparatorAfter: boolean): string[] {
  const found: string[] = [];
  let index = instructions.indexOf(prefix);
  while (index !== -1) {
    const before = index === 0 ? " " : instructions[index - 1]!;
    const after = index + prefix.length;
    const startsSegment = !NOT_A_TOKEN_BOUNDARY.test(before);
    // Accept both slash spellings on every platform; this only widens the
    // fail-closed dispatch existence check, never what Save copies.
    const separatorAfter = instructions[after] === "/" || instructions[after] === "\\";
    const continuesSegment = !requireSeparatorAfter || separatorAfter;
    if (startsSegment && continuesSegment && after < instructions.length) {
      let end = after;
      while (end < instructions.length && !/\s/.test(instructions[end]!)) end++;
      let token = instructions.slice(index, end);
      while (token.length > prefix.length + 1 && TOKEN_TRAILING_PUNCTUATION.has(token[token.length - 1]!)) {
        token = token.slice(0, -1);
      }
      if (!found.includes(token)) found.push(token);
    }
    index = instructions.indexOf(prefix, Math.max(after, index + 1));
  }
  return found;
}

/**
 * Every `pi-clipboard-...` temp token in an instruction string. Only Pi's own
 * temp naming under the OS temp directory is recognized; ordinary typed paths
 * and commands are never matched.
 */
export function findPiClipboardTempPaths(instructions: string): string[] {
  return tokensAfter(instructions, join(tmpdir(), PI_CLIPBOARD_PREFIX), false);
}

/**
 * The Pi-native clipboard temp references in an entry's staged instructions
 * that have NO matching native-paste provenance. These cannot be verified as
 * images and would silently promise image availability they cannot keep.
 */
export function findUnobservedPiClipboardTempPaths(
  instructions: string,
  observedInserts: readonly string[],
): string[] {
  const observed = new Set(observedInserts.map((insert) => insert.trim()));
  return findPiClipboardTempPaths(instructions).filter((token) => !observed.has(token));
}

/**
 * True for an observed insert that is a single absolute path token (no NUL).
 * Platform `isAbsolute` semantics apply: on POSIX a Windows path is not
 * path-shaped and is left as ordinary text.
 *
 * One trusted exception: an insert whose strict Pi clipboard temp image
 * naming matches is accepted even when it contains whitespace, because the
 * OS temp directory itself can contain spaces (a Windows user or home
 * directory name). There the strict `pi-clipboard-<UUID>.<ext>` basename
 * carries the recognition, the whitespace must lie inside the trusted temp
 * prefix, and the final-token boundaries are still enforced by the caller's
 * verbatim-presence and isolation checks.
 */
export function isPathShapedInsert(text: string, tempDir: string = tmpdir()): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return false;
  if (isPiClipboardTempImagePath(trimmed, tempDir)) return true;
  return !/\s/.test(trimmed) && isAbsolute(trimmed);
}

/**
 * The observed native inserts that are candidates for this save: path-shaped
 * inserts that are Pi's own clipboard temp image paths and appear VERBATIM in
 * the final staged instructions. Pi's native Ctrl+V inserts BOTH image temp
 * paths and ordinary clipboard text through the same `insertTextAtCursor`, so
 * provenance alone never copies anything and never turns a text paste into an
 * image: an observed plain absolute path (file, directory, real, missing), a
 * sentence, or `@` attachment text is left as ordinary text, and a token
 * edited away or a paste that does not appear in the value is skipped without
 * error.
 */
export function collectScheduledImageCandidates(
  instructions: string,
  observedInserts: readonly string[],
): string[] {
  const candidates: string[] = [];
  for (const insert of observedInserts) {
    if (!isPathShapedInsert(insert)) continue;
    const path = insert.trim();
    // Only Pi's own temp image paste output is ever a managed-copy candidate;
    // ordinary clipboard text pasted as an absolute path stays as text.
    if (!isPiClipboardTempImagePath(path)) continue;
    if (!instructions.includes(path)) continue;
    if (!candidates.includes(path)) candidates.push(path);
  }
  return candidates;
}

/** sniffImageType: content-based, never the source file's name or extension. */
export type ScheduledImageType = "png" | "jpeg" | "gif" | "webp";

/** Magic-byte sniffing for the supported image formats. */
export function sniffImageType(bytes: Uint8Array): ScheduledImageType | undefined {
  const startsWith = (prefix: readonly number[], offset = 0): boolean =>
    prefix.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith([0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith([...Buffer.from("GIF8")]) && (startsWith([0x37, 0x61], 4) || startsWith([0x39, 0x61], 4))) return "gif";
  if (startsWith([...Buffer.from("RIFF")]) && startsWith([...Buffer.from("WEBP")], 8)) return "webp";
  return undefined;
}

/** The outcome of one Save-time asset preparation. */
export interface PreparedScheduledImageAssets {
  /** The catalog to persist: entries with validated images carry managed paths. */
  catalog: ScheduledTaskCatalog;
  /** Managed files positively created by this preparation (rollback list). */
  createdFiles: string[];
  /** Managed directories positively created by this preparation (rollback list). */
  createdDirs: string[];
}

/**
 * The Save-time transaction for observed native image inserts in scheduled
 * instructions. Validates every candidate (recognized Pi clipboard temp
 * image path carrying paste provenance, verbatim in the staged instructions,
 * existing regular file, supported image content, bounded size), copies each
 * into the private managed store, and returns a catalog clone whose
 * instructions reference the managed absolute paths.
 *
 * On any failure the store is left exactly as it was — only copies this call
 * positively created are removed — and a {@link ScheduledImageAssetError}
 * with an actionable message is thrown; the caller must then abort the save
 * so the config is never mutated. Distinct task ids always get independent
 * assets, and every managed file name is a fresh UUID, so concurrent saves
 * (same or another process) never collide.
 */
export async function prepareScheduledImageAssets(
  configPath: string,
  catalog: ScheduledTaskCatalog,
  provenance: ReadonlyMap<string, readonly string[]>,
): Promise<PreparedScheduledImageAssets> {
  const prepared: PreparedScheduledImageAssets = { catalog: cloneScheduledTaskCatalog(catalog), createdFiles: [], createdDirs: [] };
  try {
    for (const [id, entry] of Object.entries(prepared.catalog)) {
      const observed = provenance.get(id) ?? [];
      // The candidate list is computed ONCE, before the provenance gate: the
      // recognized pasted temp paths that survive in the staged instructions
      // must be whitespace-isolated at EVERY occurrence BEFORE the gate runs
      // (the gate's token scan extends to whitespace, so a glued suffix — for
      // example `<temp>.bak` — would otherwise surface as a vague
      // unobserved-reference error instead of its precise glue diagnosis).
      const candidates = collectScheduledImageCandidates(entry.instructions, observed);
      for (const source of candidates) assertPastedTokenIsIsolated(id, entry.instructions, source);
      // Fail closed for Pi-native clipboard temp references that carry no
      // native-paste provenance in this session (hand-edited configs, reopened
      // entries, or the non-interactive fallback where nothing was observed):
      // Pi deletes its clipboard temp files, so persisting such a path would
      // save a promise of image availability it cannot keep. Checked for EVERY
      // staged entry, with or without provenance.
      const unobserved = findUnobservedPiClipboardTempPaths(entry.instructions, observed);
      if (unobserved.length > 0) {
        throw new ScheduledImageAssetError(
          `scheduled task ${id} instructions reference Pi's clipboard temp file ${unobserved[0]},`
          + " which was not inserted through the native editor in this session, so its"
          + " provenance cannot be verified and nothing will be copied for it. Pi deletes"
          + " its clipboard temp files, so the saved path would not work later. Re-paste"
          + " the image through the native editor (Ctrl+V) in the instructions field and"
          + " Save again, or remove the path from the instructions.",
        );
      }
      if (observed.length === 0) continue;
      if (candidates.length === 0) continue; // Nothing pasted survives to copy.
      let instructions = entry.instructions;
      for (const source of candidates) {
        const managedPath = await copyIntoManagedStore(configPath, id, source, prepared);
        // Every occurrence of the staged temporary path becomes the managed
        // absolute path; the managed path contains no whitespace, so the
        // verbatim-substring replacement is exact.
        instructions = instructions.split(source).join(managedPath);
      }
      setCatalogEntry(prepared.catalog, id, { ...entry, instructions });
    }
    return prepared;
  } catch (error) {
    await rollbackScheduledImageAssets(prepared);
    throw error;
  }
}

/**
 * Undo a failed Save: remove exactly the managed files this preparation
 * positively created, then the directories it positively created — each
 * directory removal succeeds only when empty, so nothing that already existed
 * (or that a concurrent process is using) is ever touched.
 */
export async function rollbackScheduledImageAssets(prepared: PreparedScheduledImageAssets): Promise<void> {
  await removeCreated(prepared, []);
}

/**
 * Rollback for a persistence failure that MIGHT have landed: the atomic config
 * write can reject after its rename replaced the file (for example a failing
 * directory close), in which case the new config already references the
 * just-created copies. The on-disk config is READ AND PARSED as JSON (raw
 * text matching would miss JSON-escaped Windows backslashes or quote
 * characters in managed paths): copies referenced by a parsed saved
 * instruction are kept, an unreadable or unparseable config keeps everything
 * (a failed read is ambiguous, and a leaked private copy is safer than
 * deleting a referenced asset), and everything else is rolled back.
 * Directory removal stays ownership-checked: a directory holding a kept file
 * is simply not empty and is never removed.
 */
export async function rollbackScheduledImageAssetsUnlessPersisted(
  configPath: string,
  prepared: PreparedScheduledImageAssets,
): Promise<void> {
  const onDisk = await readFile(configPath, "utf8").catch(() => undefined);
  if (onDisk === undefined) return; // Cannot verify: keep every created copy.
  let savedTasks: unknown;
  try {
    savedTasks = (JSON.parse(onDisk) as { scheduledTasks?: unknown }).scheduledTasks;
  } catch {
    return; // Unparseable: ambiguous, keep every created copy.
  }
  if (typeof savedTasks !== "object" || savedTasks === null) return;
  const referenced: string[] = [];
  for (const key of Object.keys(savedTasks as Record<string, unknown>)) {
    const entry = (savedTasks as Record<string, unknown>)[key];
    // Own enumerable keys only (JSON.parse cannot produce inherited ones), so
    // a `__proto__` id stays data and the instructions inspection is safe.
    const instructions = (entry as { instructions?: unknown } | null)?.instructions;
    if (typeof instructions === "string") referenced.push(instructions);
  }
  const kept = prepared.createdFiles.filter((file) => referenced.some((text) => text.includes(file)));
  await removeCreated(prepared, kept);
}

/** Remove the prepared copies EXCEPT the kept files, newest first. */
async function removeCreated(prepared: PreparedScheduledImageAssets, keepFiles: readonly string[]): Promise<void> {
  const kept = new Set(keepFiles);
  for (const file of [...prepared.createdFiles].reverse()) {
    if (!kept.has(file)) await unlink(file).catch(() => undefined);
  }
  for (const dir of [...prepared.createdDirs].reverse()) {
    await rmdir(dir).catch(() => undefined);
  }
}

/**
 * All managed-store paths referenced verbatim in an instruction string. The
 * scan only recognizes paths inside this config's own managed store — it is
 * never applied to arbitrary text — and stops each token at whitespace (a
 * managed path never contains whitespace).
 */
export function findManagedScheduledImagePaths(instructions: string, root: string): string[] {
  return tokensAfter(instructions, root, true);
}

/**
 * Dispatch-side fail-closed check: every managed asset an entry references
 * must exist as a readable regular file. A missing asset throws an actionable
 * {@link ScheduledImageAssetError}; callers surface it through the existing
 * dispatch-failure wake instead of starting a run against a dead path.
 */
export async function assertScheduledImagesPresent(instructions: string, root: string): Promise<void> {
  for (const path of findManagedScheduledImagePaths(instructions, root)) {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) {
      throw new ScheduledImageAssetError(
        `scheduled instructions reference a missing managed image: ${path}.`
        + " The image file was removed (or the store moved) after it was saved;"
        + " edit the task in /review-settings to re-paste the image or remove the reference.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Copy one validated source image into the private managed store. The source
 * is opened once and validated through its own file descriptor (regular file,
 * bounded size, supported image magic bytes), so the bytes written are the
 * bytes validated. Durability: file written at 0600, fsynced, then renamed
 * into place; the task directory is fsynced best-effort.
 */
async function copyIntoManagedStore(
  configPath: string,
  taskId: string,
  source: string,
  prepared: PreparedScheduledImageAssets,
): Promise<string> {
  // Catalog ids are validated (`[A-Za-z0-9_.-]+`, never "." or ".."), so the
  // per-task directory name is traversal-safe; the guard keeps a defensive
  // fail-closed boundary against any future caller that skips that validation.
  if (!/^[a-zA-Z0-9_.-]+$/.test(taskId) || taskId === "." || taskId === "..") {
    throw new ScheduledImageAssetError(`scheduled task id ${JSON.stringify(taskId)} is not usable as a managed image directory`);
  }
  const root = managedScheduledImageRoot(configPath);
  const taskDir = join(root, taskId);
  await ensurePrivateDir(root, prepared);
  await ensurePrivateDir(taskDir, prepared);

  const content = await readValidatedImage(source);
  const type = sniffImageType(content);
  if (!type) {
    throw new ScheduledImageAssetError(
      `${source} is not a supported image (PNG, JPEG, GIF, or WebP);`
      + " the native paste observation cannot be persisted. Re-paste the image"
      + " or remove the path from the task instructions.",
    );
  }
  const target = join(taskDir, `${randomUUID()}.${type}`);
  const tempPath = join(taskDir, `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", FILE_MODE);
    await handle.writeFile(content);
    await handle.chmod(FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error instanceof ScheduledImageAssetError ? error : new ScheduledImageAssetError(
      `copying the pasted image ${source} into the managed store failed: ${messageOf(error)}`,
    );
  }
  prepared.createdFiles.push(target);
  await fsyncDirectory(taskDir);
  return target;
}

/**
 * A provenance-carrying token must be whitespace-isolated in the final
 * instructions. A path glued to preceding word/path characters (a native
 * insert without padding, or an edit that removed the separating space) would
 * save a reference the dispatch-time boundary scan can never see, and a suffix
 * glued to the path corrupts the exact-string replacement; either fails the
 * Save closed with an actionable message instead of persisting an unusable
 * path. Trailing sentence punctuation is fine: the exact-token replacement
 * leaves it in place and the scanners trim it when comparing. Any OTHER
 * punctuation-glued suffix (for example `<temp>.bak`) also fails the Save:
 * the replacement would persist `<managed>.bak`, which the dispatch-time
 * token scan (which trims only sentence punctuation) can never resolve, so
 * the token is extended to its whitespace end, the same trailing punctuation
 * is trimmed, and a differing result fails closed.
 */
function assertPastedTokenIsIsolated(taskId: string, instructions: string, token: string): void {
  // Every occurrence must be isolated: one isolated and one glued occurrence
  // would otherwise persist `x<managed path>`, invisible to the dispatch scan.
  let index = instructions.indexOf(token);
  while (index !== -1) {
    const before = index === 0 ? " " : instructions[index - 1]!;
    const after = instructions[index + token.length] ?? " ";
    if (NOT_A_TOKEN_BOUNDARY.test(before) || /[A-Za-z0-9_~/\\-]/.test(after)) {
      throw new ScheduledImageAssetError(
        `scheduled task ${taskId} instructions contain the pasted image path ${token}`
        + " glued to adjacent text. Put a space before and after the pasted path"
        + " (and remove anything glued to it), then Save again.",
      );
    }
    // The token must also be the dispatch-visible token: extend the occurrence
    // to the next whitespace and trim the same trailing sentence punctuation
    // the dispatch scanners trim. What remains must be exactly the pasted
    // path; anything else glued to its end (for example `.bak`) would persist
    // a reference no dispatch scan can resolve.
    let end = index + token.length;
    while (end < instructions.length && !/\s/.test(instructions[end]!)) end++;
    let visible = instructions.slice(index, end);
    while (visible.length > token.length && TOKEN_TRAILING_PUNCTUATION.has(visible[visible.length - 1]!)) {
      visible = visible.slice(0, -1);
    }
    if (visible !== token) {
      throw new ScheduledImageAssetError(
        `scheduled task ${taskId} instructions contain the pasted image path ${token}`
        + ` with ${JSON.stringify(instructions.slice(index + token.length, end))} glued directly after it; that text would persist a reference the scheduled run can never resolve. Remove the text glued after the pasted path (or put a space after it), then Save again.`,
      );
    }
    index = instructions.indexOf(token, index + token.length);
  }
}

/**
 * Create (or tighten) one private 0700 directory of the managed store. The
 * mkdir runs first and an EEXIST loser of a concurrent-creation race re-checks
 * the directory and succeeds — two processes saving at once can interleave
 * safely, and only this call's own successful creation enters the rollback
 * list. Any other failure is an actionable ScheduledImageAssetError. The
 * re-check is an `lstat`, never a stat-followed lookup: a managed root or
 * per-task directory that exists as a SYMBOLIC LINK (for example a store path
 * pointed at a foreign directory) fails the Save closed with an actionable
 * message — nothing is ever chmod'ed or copied through the link into a
 * directory this config does not own.
 */
async function ensurePrivateDir(dir: string, prepared: PreparedScheduledImageAssets): Promise<void> {
  let created = false;
  try {
    await mkdir(dir, { mode: DIR_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
      throw new ScheduledImageAssetError(`creating the managed image store directory ${dir} failed: ${messageOf(error)}`);
    }
  }
  const existing = await lstat(dir).catch(() => undefined);
  if (!existing) {
    throw new ScheduledImageAssetError(`creating the managed image store directory ${dir} failed: the path vanished after creation`);
  }
  if (existing.isSymbolicLink()) {
    throw new ScheduledImageAssetError(
      `the managed image store path ${dir} is a symbolic link. The managed store`
      + " is never used through a symlink, so nothing was written through it;"
      + " remove the symlink (or point this config's directory elsewhere) and"
      + " Save again.",
    );
  }
  if (!existing.isDirectory()) {
    throw new ScheduledImageAssetError(`managed image store path is not a directory: ${dir}`);
  }
  if ((existing.mode & 0o777) !== DIR_MODE) {
    await chmod(dir, DIR_MODE).catch(() => undefined);
  }
  if (created) {
    prepared.createdDirs.push(dir);
    await fsyncDirectory(dirname(dir));
  }
}

/** Read the source image through one descriptor, bounded and validated. */
async function readValidatedImage(source: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(source, "r");
  } catch (error) {
    throw new ScheduledImageAssetError(
      `the pasted image source ${source} is not readable: ${messageOf(error)}.`
      + " If it is a native clipboard paste, Pi's temporary file may already be"
      + " gone — re-paste the image, then Save again.",
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new ScheduledImageAssetError(`the pasted path ${source} is not a regular file`);
    }
    if (info.size > MAX_SCHEDULED_IMAGE_BYTES) {
      throw new ScheduledImageAssetError(
        `the pasted image ${source} is ${info.size} bytes, above the`
        + ` ${MAX_SCHEDULED_IMAGE_BYTES}-byte managed-asset limit; remove the path`
        + " from the instructions or reference a smaller image.",
      );
    }
    // A source that grows between stat and read must not allocate unbounded
    // memory: read through the same descriptor, bounded at the limit.
    return await readBoundedImage(handle, source);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Read through an already-open descriptor, bounded at
 * {@link MAX_SCHEDULED_IMAGE_BYTES}: the read loop never accumulates more
 * than the limit, so a source that grows between the stat precheck and the
 * read (or that stat never measured honestly) fails closed instead of
 * allocating unbounded memory. Exported for direct race-boundary tests.
 */
export async function readBoundedImage(handle: Awaited<ReturnType<typeof open>>, source?: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead <= 0) break;
    total += bytesRead;
    if (total > MAX_SCHEDULED_IMAGE_BYTES) {
      throw new ScheduledImageAssetError(
        `the pasted image ${source ?? "source"} grew past the`
        + ` ${MAX_SCHEDULED_IMAGE_BYTES}-byte managed-asset limit between its`
        + " size check and its read; nothing was copied.",
      );
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks);
}

/** Best-effort directory fsync, mirroring the config writer's durability. */
async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r").catch(() => undefined);
  if (!handle) return;
  await handle.sync().catch(() => undefined);
  await handle.close().catch(() => undefined);
}

/**
 * Define a rewritten entry as an own enumerable, writable, configurable data
 * property — prototype-safe exactly like `defineOwnKey` (src/config.ts) and
 * `setCatalogKey` (src/settings/command.ts): a scheduled-task id of
 * `__proto__` (accepted by the config id grammar and created as an own JSON
 * key) must stay data, never become a prototype assignment that silently
 * drops the entry from the catalog Save persists.
 */
function setCatalogEntry(catalog: ScheduledTaskCatalog, id: string, entry: ScheduledTaskCatalog[string]): void {
  Object.defineProperty(catalog, id, { value: entry, enumerable: true, writable: true, configurable: true });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}