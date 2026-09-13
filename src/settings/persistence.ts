import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  cloneWorkerCatalog,
  normalizeConfig,
  type ActiveReviewerSelection,
  type BrowserInteractionApproval,
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
  activeReviewers: ActiveReviewerSelection[];
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
  webMaxDownloadBytes?: number;
  browserInteractionApproval?: BrowserInteractionApproval;
  browserIdleExpiryMinutes?: number;
}

const configUpdateTails = new Map<string, Promise<void>>();

export async function persistReviewSettings(
  configPath: string,
  selection: ReviewSettingsSelection,
): Promise<ReviewGateConfig> {
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
    review.activeReviewers = selection.activeReviewers.map((reviewer) => ({ ...reviewer }));
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
    if (selection.webMaxDownloadBytes !== undefined || selection.browserInteractionApproval !== undefined || selection.browserIdleExpiryMinutes !== undefined) {
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
      parsed.web = web;
    }
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
