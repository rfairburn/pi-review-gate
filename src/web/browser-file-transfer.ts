/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for host-side file-transfer state — the validated upload sources, the
 * download-save destination facts, the retained pending-download ledger
 * (an opaque map over the manager's delegated `pendingDownloads` substate),
 * and the private staging/atomic-commit mechanics for approved saves.
 * Every failure path still writes nothing to the destination, the retention
 * cap is taken from the live config through the caller, and destinations
 * retain their original host-write semantics (absolute destinations are not
 * fenced by the browser).
 */
import { createReadStream } from "node:fs";
import { constants as fsConstants, link, lstat, mkdir, open, realpath, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { Download } from "playwright";
import { nearestRealPath } from "../apply-patch/paths";
import type { EffectiveBrowserPolicy } from "./browser-capabilities.js";
import { BrowserCapabilityDeniedError, type BrowserFileTransferCapability } from "./browser-errors.js";
import { BROWSER_DOWNLOAD_DESTINATION_MAX_CHARS, BROWSER_DOWNLOAD_FILENAME_MAX_CHARS, BROWSER_UPLOAD_MAX_FILES, BROWSER_UPLOAD_PATH_MAX_CHARS } from "./browser-limits.js";
import type { OperationDeadline } from "./browser-operations.js";
import { asError } from "./browser-primitives.js";
import { redactedInteractionUrl } from "./browser-url-policy.js";

/** Issue #27 lifecycle of a retained pending download in this manager. */
export type BrowserDownloadState = "in_progress" | "completed" | "canceled" | "failed";

/**
 * One retained pending download (issue #27). The suggested filename and URL
 * are untrusted page metadata reported for context only; they never choose or
 * authorize a destination. Bytes stay in Playwright's private staged storage
 * until an approved save or a cancel/release.
 */
export interface BrowserPendingDownload {
  handle: string;
  suggestedFilename: string;
  url: string | null;
  state: BrowserDownloadState;
}

/** Observation-only listing of the pending downloads retained for one tab. */
export interface BrowserDownloadListResult {
  session: string;
  tab: string;
  generation: string;
  downloads: BrowserPendingDownload[];
}

/**
 * One retained pending download (issue #27). The Playwright Download object is
 * manager-private; only its bounded metadata leaves the manager, and bytes are
 * copied out only by an approved save.
 */
export interface PendingDownloadRecord {
  handle: string;
  tab: string;
  download: Download;
  suggestedFilename: string;
  url: string | null;
  state: BrowserDownloadState;
}

/** Delegated retained-download ledger of one session (the same map, same owner). */
export interface PendingDownloadLedger {
  pendingDownloads: Map<string, PendingDownloadRecord>;
}

export interface ValidatedUploadSource { path: string; size: number; mtimeMs: number; }
export interface ValidatedUploadSources {
  files: ValidatedUploadSource[];
  /** Verified real paths in request order; what setInputFiles receives. */
  realPaths: string[];
  totalBytes: number;
}

export interface SaveDestinationFacts { real: string; existed: boolean; }

export function invalidDownloadHandleError(): Error {
  return new Error(
    "Invalid or stale browser download handle: it was not retained by this session and tab, or it was already saved, canceled, or evicted. List pending downloads with BrowserDownloadSave without a destination.",
  );
}

export function enforceFileTransferCapability(policy: EffectiveBrowserPolicy, capability: BrowserFileTransferCapability): void {
  // The live effective policy is supplied by the caller at the gate point.
    if (capability === "model_uploads" && !policy.modelUploads) {
      throw new BrowserCapabilityDeniedError("model_uploads");
    }
    if (capability === "model_download_saving" && !policy.modelDownloadSaving) {
      throw new BrowserCapabilityDeniedError("model_download_saving");
    }
}

export function retainPendingDownload(
  ledger: PendingDownloadLedger,
  tabHandle: string,
  download: Download,
  options: { cap: number; newHandle: () => string },
): PendingDownloadRecord | undefined {
  const cap = options.cap;
    while (cap > 0 && ledger.pendingDownloads.size >= cap) {
      const oldest = ledger.pendingDownloads.values().next().value;
      if (!oldest) break;
      ledger.pendingDownloads.delete(oldest.handle);
      void releasePendingDownload(oldest).catch(() => undefined);
    }
    let suggestedFilename: string;
    try { suggestedFilename = download.suggestedFilename(); } catch { suggestedFilename = ""; }
    if (suggestedFilename.length > BROWSER_DOWNLOAD_FILENAME_MAX_CHARS) {
      suggestedFilename = suggestedFilename.slice(0, BROWSER_DOWNLOAD_FILENAME_MAX_CHARS);
    }
    let url: string | null = null;
    try {
      const raw = download.url();
      if (raw.length <= 4_096) url = redactedInteractionUrl(raw);
    } catch { url = null; }
    const record: PendingDownloadRecord = {
      handle: options.newHandle(),
      tab: tabHandle,
      download,
      suggestedFilename,
      url,
      state: "in_progress",
    };
    ledger.pendingDownloads.set(record.handle, record);
    // Track completion without ever retaining bytes: the staged artifact stays
    // in Playwright's private temporary storage until saved or released.
    void download.failure().then((failure) => {
      if (ledger.pendingDownloads.get(record.handle) !== record) return;
      record.state = failure ? "failed" : "completed";
    }, () => {
      if (ledger.pendingDownloads.get(record.handle) !== record) return;
      record.state = "failed";
    });
    return record;
  }

function pendingDownloadState(record: PendingDownloadRecord): BrowserDownloadState {
  return record.state;
}

/** Release one retained download: cancel in-progress, delete completed. */
export async function releasePendingDownload(record: PendingDownloadRecord): Promise<void> {
  try {
    if (pendingDownloadState(record) === "in_progress") await record.download.cancel();
    else await record.download.delete();
  } catch {
    // The artifact is private temporary storage; a failed release is
    // contained by the context close during teardown.
  }
}

/** Cancel and drop every retained pending download of a session. */
export function revokePendingDownloads(ledger: PendingDownloadLedger): void {
  for (const record of [...ledger.pendingDownloads.values()]) {
    ledger.pendingDownloads.delete(record.handle);
    void releasePendingDownload(record).catch(() => undefined);
  }
}

/** Release one tab's retained downloads when the tab goes away: its handles
 * are unusable once the tab is gone, and keeping them would count against
 * the session retention cap and hold staged bytes for no reachable save. */
export function releaseTabDownloads(ledger: PendingDownloadLedger, tabHandle: string): void {
  for (const record of [...ledger.pendingDownloads.values()]) {
    if (record.tab !== tabHandle) continue;
    ledger.pendingDownloads.delete(record.handle);
    void releasePendingDownload(record).catch(() => undefined);
  }
}

/** Bounded wait for an in-progress retained download to settle. */
export async function waitForDownloadCompletion(record: PendingDownloadRecord, operation: OperationDeadline): Promise<void> {
    while (pendingDownloadState(record) === "in_progress") {
      // remainingMs() is already live time against the shared deadline; it
      // throws once that deadline expires, which the caller reports bounded.
      const remaining = operation.remainingMs();
      await operation.run(new Promise<void>((resolveSleep) => setTimeout(resolveSleep, Math.min(25, remaining))), "download completion wait");
    }
    const state = pendingDownloadState(record);
    if (state !== "completed") {
      throw new Error(`BrowserDownloadSave not_started: the retained download is ${state}; nothing was written.`);
    }
  }

/**
 * Stage a completed download into a private same-directory temp file next
 * to the approved destination (the repository's staged-write convention,
   * cf. stageFile in src/apply-patch/request.ts). Every failure here wrote
   * nothing to the destination and removes the temp file, so it is reported
   * not_started. The staged bytes are verified against the artifact before any
   * commit.
 */
export async function stageSaveArtifact(record: PendingDownloadRecord, destination: SaveDestinationFacts): Promise<{ temp: string }> {
    const staged = await record.download.path();
    if (!staged) throw new Error("BrowserDownloadSave not_started: the staged download artifact is unavailable.");
    try {
      await mkdir(dirname(destination.real), { recursive: true });
    } catch (error) {
      // The host filesystem (permissions, read-only mounts, role restrictions)
      // decides write authority here; report its refusal honestly.
      throw saveFsFailure("create the destination directory", error);
    }
    // Same-directory temp file per the repository's staged-write convention;
    // O_EXCL on a manager-generated name keeps it private to this save.
    const temp = `${dirname(destination.real)}/${basename(destination.real)}.pi-download-${process.pid}-${randomUUID()}.tmp`;
    let handle: FileHandle;
    try {
      handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    } catch (error) {
      // The temp file may not exist yet; the force rm is a no-op then.
      await rm(temp, { force: true }).catch(() => undefined);
      throw saveFsFailure("stage the download artifact", error);
    }
    try {
      const writer = handle.createWriteStream();
      try {
        await pipeline(createReadStream(staged), writer);
      } catch (error) {
        writer.destroy();
        throw error;
      }
    } catch (error) {
      // A failed staging wrote nothing to the destination; drop the temp file
      // and report the host-filesystem refusal honestly.
      await handle.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
      throw saveFsFailure("stage the download artifact", error);
    }
    await handle.close().catch(() => undefined);
    const [tempSize, stagedSize] = await Promise.all([stat(temp).then((s) => s.size), stat(staged).then((s) => s.size)]);
    if (tempSize !== stagedSize) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new Error("BrowserDownloadSave not_started: the staged artifact changed during save; nothing was written.");
    }
    return { temp };
  }

/**
 * Atomically commit the staged temp file to the approved destination. A new
 * file uses link(2), which fails with EEXIST if the destination appeared
 * after approval — no-overwrite semantics without a check-then-commit
 * window, and a failed link creates nothing. An approved replacement uses
 * rename(2), which swaps the whole file atomically: there is no
 * truncate-then-write window, so a failure leaves the previous content
 * intact on standard filesystems (an exotic indeterminate rename failure is
 * reported as an unknown post-dispatch effect by the caller).
 */
export async function commitSaveTarget(staged: { temp: string }, destination: SaveDestinationFacts): Promise<number> {
    try {
      if (destination.existed) await rename(staged.temp, destination.real);
      else await link(staged.temp, destination.real);
    } catch (error) {
      // A failed atomic commit created nothing at the destination; drop the
      // private temp copy on every failure so artifact bytes do not linger.
      await rm(staged.temp, { force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (!destination.existed && code === "EEXIST") {
        throw new Error("BrowserDownloadSave not_started: the destination file appeared after approval; nothing was written.");
      }
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new Error("BrowserDownloadSave not_started: the destination path changed after approval; nothing was written.");
      }
      if (!destination.existed) {
        // A failed link created nothing; report the host-filesystem refusal
        // (permissions, read-only mounts, role restrictions) honestly.
        throw saveFsFailure("commit the saved file", error);
      }
      // An approved replacement uses rename(2): a failure here can be
      // indeterminate on exotic filesystems, so the caller reports it as a
      // possible post-dispatch effect rather than claiming not_started.
      throw error;
    }
    // The temp name is now the destination (rename) or a redundant hard link
    // (link); drop our name. A failed unlink leaves only a private temp file,
    // never destination data.
    await rm(staged.temp, { force: true }).catch(() => undefined);
    return (await stat(destination.real)).size;
  }


/**
 * Verify model-selected upload sources before any approval. Each path is
 * resolved to its real location and must be a regular file; the page never
 * sees or chooses these paths. Metadata only: no content is read.
 */
export async function validateUploadSources(files: unknown, workspaceRoot: string): Promise<ValidatedUploadSources> {
  if (!Array.isArray(files) || files.length < 1 || files.length > BROWSER_UPLOAD_MAX_FILES) {
    throw new Error("not_started: Browser upload file list is absent or exceeds its bounded size.");
  }
  const seen = new Set<string>();
  const out: ValidatedUploadSource[] = [];
  let totalBytes = 0;
  for (const entry of files) {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > BROWSER_UPLOAD_PATH_MAX_CHARS || entry.includes("\0")) {
      throw new Error("not_started: Browser upload file paths must be bounded non-empty strings.");
    }
    const absolute = isAbsolute(entry) ? resolve(entry) : resolve(workspaceRoot, entry);
    let real: string;
    try { real = await realpath(absolute); }
    catch { throw new Error("not_started: Browser upload source does not exist or cannot be resolved."); }
    let stats;
    try { stats = await lstat(real); }
    catch { throw new Error("not_started: Browser upload source is no longer available."); }
    if (!stats.isFile()) throw new Error("not_started: Browser upload source is not a regular file.");
    if (seen.has(real)) throw new Error("not_started: Browser upload file list contains duplicates.");
    seen.add(real);
    out.push({ path: real, size: stats.size, mtimeMs: stats.mtimeMs });
    totalBytes += stats.size;
  }
  return { files: out, realPaths: out.map((file) => file.path), totalBytes };
}

/** Re-verify approved sources against size/mtime before dispatch. */
export async function revalidateUploadSources(sources: ValidatedUploadSources): Promise<ValidatedUploadSources> {
  const out: ValidatedUploadSource[] = [];
  let totalBytes = 0;
  for (const source of sources.files) {
    let stats;
    try { stats = await lstat(source.path); }
    catch { throw new Error("not_started: Browser upload source is no longer available after approval."); }
    if (!stats.isFile() || stats.size !== source.size || stats.mtimeMs !== source.mtimeMs) {
      throw new Error("not_started: Browser upload source changed after approval; nothing was uploaded.");
    }
    out.push({ path: source.path, size: stats.size, mtimeMs: stats.mtimeMs });
    totalBytes += stats.size;
  }
  return { files: out, realPaths: out.map((file) => file.path), totalBytes };
}


/**
 * Verify a model-selected download-save destination against the model's
 * existing host write authority (issue #27). There is no browser-specific
 * workspace fence: relative paths resolve to the session working directory,
 * and absolute paths are eligible wherever the process can actually write,
 * exactly like the model's ordinary file tools. The real path (nearest-
 * existing-ancestor realpath) is what the approval binds to, so a destination
 * reached through symlinks is approved at its true location and re-verified
 * after approval. Page-suggested filenames are never consulted here. Nothing
 * here assumes a path is writable: actual platform/role write restrictions
 * are enforced by the filesystem at staging and commit time and reported
 * honestly, and a missing final component is allowed (its creation is what
 * the approval authorizes; O_EXCL at open time detects overwrite races).
 */
export async function resolveSaveDestination(raw: unknown, workspaceRoot: string): Promise<SaveDestinationFacts> {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > BROWSER_DOWNLOAD_DESTINATION_MAX_CHARS || raw.includes("\0")) {
    throw new Error("not_started: Browser download destination is absent or exceeds its bounded length.");
  }
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw);
  let real: string;
  try {
    real = await nearestRealPath(absolute);
  } catch (error) {
    throw new Error(`not_started: Browser download destination could not be resolved: ${asError(error).message}`);
  }
  let existed = false;
  try {
    const stats = await lstat(real);
    if (stats.isDirectory()) throw new Error("not_started: Browser download destination is an existing directory; choose a file path.");
    if (!stats.isFile()) throw new Error("not_started: Browser download destination is not a regular file path.");
    existed = true;
  } catch (error) {
    if (error instanceof Error && /existing directory|not a regular file/.test(error.message)) throw error;
    // ENOENT: the final component does not exist yet.
  }
  return { real, existed };
}

/** Fail closed on an unvalidated retention cap reaching the live manager. */
export function validateDownloadRetention(retention: number): void {
  if (typeof retention !== "number" || !Number.isSafeInteger(retention) || retention < 0) {
    throw new Error("web.browserDownloadRetention must be a non-negative safe integer");
  }
}

/**
 * Report a host-filesystem refusal at staging or commit honestly: the OS
 * error (errno and message) is what decides whether the model's existing
 * write authority reaches this path, so it is surfaced verbatim rather than
 * collapsed into a generic failure. Every caller of these paths has written
 * nothing to the destination.
 */
export function saveFsFailure(action: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`BrowserDownloadSave not_started: could not ${action}: ${detail}. Nothing was written to the destination.`);
}
