import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  cloneScheduledTaskCatalog,
  cloneWorkerCatalog,
  normalizeConfig,
  type ActiveReviewerSelection,
  type BrowserInteractionApproval,
  type ScheduledTaskCatalog,
  type WebBrowserPermissions,
  type WorkerResourceCatalog,
  type WorkerRouteEntry,
  type ExecutionRetryPolicy,
  type OperatingMode,
  type RetainBundles,
  type ReviewGateConfig,
  type SubtaskNotificationMode,
} from "../config";

export interface ReviewSettingsSelection {
  operatingMode: OperatingMode;
  /** Direct operating-mode cycle hotkey (issue #20). */
  modeCycleShortcut: string;
  /** Canonical keyed worker catalog; always persisted as an object. */
  workerResources: WorkerResourceCatalog;
  executeRoute?: WorkerRouteEntry[];
  researchRoute?: WorkerRouteEntry[];
  /** Automatic review of the primary assistant's own changes (Execute + Orchestrate). */
  primaryReviewers: ActiveReviewerSelection[];
  /** Automatic review of subtask results before ordinary accepted landing. */
  subtaskReviewers: ActiveReviewerSelection[];
  /** Automatic primary review on; manual review commands are unaffected. */
  primaryEnabled: boolean;
  /** Automatic subtask review on. */
  subtaskEnabled: boolean;
  /** Landed-change re-review choice; inactive while automatic primary review is off. */
  reviewLandedChanges: boolean;
  reviewerTimeoutMs: number;
  executorTimeoutMs: number;
  maxCorrectionCycles: number;
  implementationGuidanceAfterCorrectionAttempts: number;
  retainBundles: RetainBundles;
  maxWorkers: number;
  retryPolicy: ExecutionRetryPolicy;
  subtaskNotifications: SubtaskNotificationMode;
  deferredPiTools?: boolean;
  subtasksViewExpanded: boolean;
  /** Complete scheduled-task catalog (issue #26); persisted as a whole. */
  scheduledTasks?: ScheduledTaskCatalog;
  /**
   * Entry ids the caller staged the catalog from (the ids visible when the
   * settings menu opened). Save uses it to tell the caller's own deletions
   * apart from entries another process appended after the staging point: ids
   * staged-then-removed are deleted, while ids present on disk but never seen
   * by the caller survive the save (issue #26: an off instance's Save must
   * never erase schedule entries it never knew about).
   */
  scheduledTasksStagedFrom?: string[];
  webMaxDownloadBytes?: number;
  browserInteractionApproval?: BrowserInteractionApproval;
  browserIdleExpiryMinutes?: number;
  /** Retained-unsaved-download cap per browser session; 0 disables count-based eviction. */
  browserDownloadRetention?: number;
  /** Interactive browser window visibility; applied to a live browser on save. */
  browserVisible?: boolean;
  /** Complete a-la-carte browser permission object (issue #27); persisted as a whole. */
  webBrowserPermissions?: WebBrowserPermissions;
}

const configUpdateTails = new Map<string, Promise<void>>();

/** Post-validation finalization hook for one config update. */
export interface UpdateReviewGateConfigOptions {
  /**
   * Invoked after the strict validation gate and catalog canonicalization but
   * before the atomic write, for saves that must persist raw content the gate
   * must not re-validate (issue #26: foreign schedule entries this save does
   * not own are preserved verbatim rather than validated).
   */
  afterValidate?: (parsed: Record<string, unknown>, normalized: ReviewGateConfig) => void;
}

export async function persistReviewSettings(
  configPath: string,
  selection: ReviewSettingsSelection,
): Promise<ReviewGateConfig> {
  let scheduledTasksResult: Record<string, unknown> | undefined;
  return updateReviewGateConfig(configPath, (parsed) => {
    const execution = isRecord(parsed.execution) ? { ...parsed.execution } : {};
    // Both catalogs persist in canonical keyed-object form; routes persist
    // exactly as selected. Missing or empty routes stay empty — the catalog
    // never infers role priorities.
    execution.workerResources = cloneWorkerCatalog(selection.workerResources);
    execution.routes = {
      execute: (selection.executeRoute ?? []).map((entry) => ({ ...entry })),
      research: (selection.researchRoute ?? []).map((entry) => ({ ...entry })),
    };
    execution.maxWorkers = selection.maxWorkers;
    execution.retryPolicy = { ...selection.retryPolicy };
    execution.subtaskNotifications = selection.subtaskNotifications;
    execution.deferredPiTools = selection.deferredPiTools
      ?? (typeof execution.deferredPiTools === "boolean" ? execution.deferredPiTools : true);
    delete execution.parallelEnabled;
    parsed.execution = execution;
    // externalAgents is intentionally untouched: agents are not editable in
    // this UI, and the save boundary canonicalizes the latest on-disk form.
    const review = isRecord(parsed.review) ? { ...parsed.review } : {};
    // The split reviewer fields are the only canonical reviewer state (issue
    // #175): every save persists them and removes the legacy single-set key,
    // even when no manual reviewer edit was staged, so the stored record
    // never keeps a second reviewer set after the first save.
    review.primaryReviewers = selection.primaryReviewers.map((reviewer) => ({ ...reviewer }));
    review.subtaskReviewers = selection.subtaskReviewers.map((reviewer) => ({ ...reviewer }));
    review.primaryEnabled = selection.primaryEnabled;
    review.subtaskEnabled = selection.subtaskEnabled;
    review.reviewLandedChanges = selection.reviewLandedChanges;
    delete review.activeReviewers;
    parsed.review = review;
    parsed.operatingMode = selection.operatingMode;
    parsed.modeCycleShortcut = selection.modeCycleShortcut;
    parsed.reviewerTimeoutMs = selection.reviewerTimeoutMs;
    parsed.executorTimeoutMs = selection.executorTimeoutMs;
    parsed.maxCorrectionCycles = selection.maxCorrectionCycles;
    parsed.implementationGuidanceAfterCorrectionAttempts = selection.implementationGuidanceAfterCorrectionAttempts;
    parsed.retainBundles = selection.retainBundles;
    const ui = isRecord(parsed.ui) ? { ...parsed.ui } : {};
    ui.subtasksViewExpanded = selection.subtasksViewExpanded;
    parsed.ui = ui;
    if (selection.scheduledTasks !== undefined) {
      // Entries are the single canonical copy of each schedule (issue #26), so
      // omitted fields stay absent and no inherited global setting is copied
      // into any entry. The merge is write-granularity, not a second copy:
      // staged entries win per id, entries the caller staged and then removed
      // are deleted, and on-disk entries the caller never staged are kept so
      // an off or stale instance cannot erase another process's schedules.
      const staged = cloneScheduledTaskCatalog(selection.scheduledTasks);
      const stagedIds = new Set(Object.keys(staged));
      const deletions = new Set(
        (selection.scheduledTasksStagedFrom ?? []).filter((id) => !stagedIds.has(id)),
      );
      const stored = isRecord(parsed.scheduledTasks) ? parsed.scheduledTasks : {};
      scheduledTasksResult = mergeScheduledTaskEntries(stored, staged, deletions);
      // The validation gate below runs on exactly the entries this save owns:
      // a preserved on-disk entry this snapshot cannot resolve (hand-edited, or
      // pinned to a worker resource another process created) must never abort
      // an unrelated Save — it is attached back after validation, verbatim and
      // unvalidated, and stays on disk for the process that can resolve it.
      // The returned normalized config (and the in-memory replacement) carries
      // the staged catalog: this process sees another process's saved edits
      // only on its own reload, which matches the documented visibility rule.
      parsed.scheduledTasks = staged;
    }
    if (selection.webMaxDownloadBytes !== undefined || selection.browserInteractionApproval !== undefined || selection.browserIdleExpiryMinutes !== undefined || selection.browserDownloadRetention !== undefined || selection.browserVisible !== undefined || selection.webBrowserPermissions !== undefined) {
      const web = isRecord(parsed.web) ? { ...parsed.web } : {};
      if (selection.webMaxDownloadBytes !== undefined) {
        const fetch = isRecord(web.fetch) ? { ...web.fetch } : {};
        fetch.maxDownloadBytes = selection.webMaxDownloadBytes;
        web.fetch = fetch;
      }
      if (selection.browserInteractionApproval !== undefined) {
        web.browserInteractionApproval = selection.browserInteractionApproval;
      }
      if (selection.browserIdleExpiryMinutes !== undefined) {
        web.browserIdleExpiryMinutes = selection.browserIdleExpiryMinutes;
      }
      if (selection.browserDownloadRetention !== undefined) {
        web.browserDownloadRetention = selection.browserDownloadRetention;
      }
      if (selection.browserVisible !== undefined) {
        web.browserVisible = selection.browserVisible;
      }
      if (selection.webBrowserPermissions !== undefined) {
        // Persist the complete object: YOLO is a master override that preserves
        // the individual values beneath it, so no field is dropped or invented.
        // Strict validation runs in normalizeConfig before the atomic write.
        web.browserPermissions = { ...selection.webBrowserPermissions };
      }
      parsed.web = web;
    }
  }, {
    afterValidate: (finalParsed) => {
      if (scheduledTasksResult !== undefined) finalParsed.scheduledTasks = scheduledTasksResult;
    },
  });
}

export async function persistSubtasksViewPreference(
  configPath: string,
  expanded: boolean,
): Promise<ReviewGateConfig> {
  return updateReviewGateConfig(configPath, (parsed) => {
    const ui = isRecord(parsed.ui) ? { ...parsed.ui } : {};
    ui.subtasksViewExpanded = expanded;
    parsed.ui = ui;
  });
}

export async function updateReviewGateConfig(
  configPath: string,
  mutate: (config: Record<string, unknown>) => void,
  options: UpdateReviewGateConfigOptions = {},
): Promise<ReviewGateConfig> {
  const key = resolve(configPath);
  const prior = configUpdateTails.get(key) ?? Promise.resolve();
  let normalized: ReviewGateConfig | undefined;
  const operation = prior.catch(() => undefined).then(async () => {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("review gate config must be a JSON object");
    }
    mutate(parsed);
    normalized = normalizeConfig(parsed);
    canonicalizeCatalogs(parsed, normalized);
    options.afterValidate?.(parsed, normalized);
    await writeConfigAtomically(configPath, parsed);
  });
  const tail = operation.catch(() => undefined);
  configUpdateTails.set(key, tail);
  try {
    await operation;
    return normalized!;
  } finally {
    if (configUpdateTails.get(key) === tail) configUpdateTails.delete(key);
  }
}

/**
 * The single save boundary that persists both catalogs in canonical
 * keyed-object form. The legacy array-to-keyed conversion also happens in
 * memory on load (normalizeConfig) — loading never writes to disk; this helper
 * serializes the normalized catalog at save time, after mutation and
 * validation, so an invalid conversion fails before the atomic write. Absent
 * fields stay absent, and every other raw field survives untouched, so a save
 * can never clobber newer on-disk agent definitions with a stale in-memory
 * snapshot.
 */
function canonicalizeCatalogs(parsed: Record<string, unknown>, normalized: ReviewGateConfig): void {
  if (parsed.externalAgents !== undefined) {
    parsed.externalAgents = normalized.externalAgents;
  }
  const execution = parsed.execution;
  const workerResources = normalized.execution?.workerResources;
  if (isRecord(execution) && execution.workerResources !== undefined && workerResources !== undefined) {
    execution.workerResources = workerResources;
  }
}

/**
 * Merge the staged scheduled-task entries over the on-disk catalog for one
 * save. This is write granularity, not a second canonical copy: staged entries
 * win per id, entries the caller staged and then removed are deleted, and
 * on-disk entries the caller never staged are kept verbatim (even if this
 * snapshot could not validate them) so an off or stale instance can never
 * erase another process's schedules. Prototype-safe for exotic ids.
 */
function mergeScheduledTaskEntries(
  stored: Record<string, unknown>,
  staged: Record<string, unknown>,
  deletions: ReadonlySet<string>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored };
  for (const id of deletions) delete merged[id];
  for (const [id, entry] of Object.entries(staged)) {
    // Own data property even for a key like "__proto__": the definition keeps
    // the merge prototype-safe for validated staged ids.
    Object.defineProperty(merged, id, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return merged;
}

async function writeConfigAtomically(configPath: string, parsed: Record<string, unknown>): Promise<void> {
  const existing = await stat(configPath);
  const mode = existing.mode & 0o777;
  const targetMode = mode !== 0 && (mode & 0o077) === 0 ? mode : 0o600;
  const tempPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", targetMode);
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.chmod(targetMode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, configPath);

    // Make the rename durable where directory fsync is supported.
    const directory = await open(dirname(configPath), "r").catch(() => undefined);
    if (directory) {
      await directory.sync().catch(() => undefined);
      await directory.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function replaceConfig(target: ReviewGateConfig, next: ReviewGateConfig): void {
  const mutable = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) {
    delete mutable[key];
  }
  Object.assign(mutable, next);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
