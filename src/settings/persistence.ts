import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  externalAgentCatalog,
  normalizeConfig,
  type ActiveReviewerSelection,
  type ExecutorPoolEntry,
  type WorkerRouteEntry,
  type ExecutionRetryPolicy,
  type RetainBundles,
  type ReviewGateConfig,
  type SubtaskNotificationMode,
} from "../config";

export interface ReviewSettingsSelection {
  workerResources?: ExecutorPoolEntry[];
  executeRoute?: WorkerRouteEntry[];
  researchRoute?: WorkerRouteEntry[];
  /** @deprecated Compatibility for direct callers compiled against the former settings shape. */
  executorPool?: ExecutorPoolEntry[];
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
}

const configUpdateTails = new Map<string, Promise<void>>();

export async function persistReviewSettings(
  configPath: string,
  selection: ReviewSettingsSelection,
): Promise<ReviewGateConfig> {
  return updateReviewGateConfig(configPath, (parsed) => {
    const catalog = externalAgentCatalog(normalizeConfig(parsed));
    const execution = isRecord(parsed.execution) ? { ...parsed.execution } : {};
    const resources = selection.workerResources ?? selection.executorPool ?? [];
    const defaultRoute = resources.map((entry) => ({
      resourceId: entry.entryId,
      ...(entry.selection.source === "pi" && entry.selection.thinkingLevel
        ? { thinkingLevel: entry.selection.thinkingLevel }
        : {}),
    }));
    execution.workerResources = resources.map((entry) => ({
      resourceId: entry.entryId,
      selection: { ...entry.selection },
      maxConcurrent: entry.maxConcurrent,
    }));
    execution.routes = {
      execute: (selection.executeRoute ?? defaultRoute).map((entry) => ({ ...entry })),
      research: (selection.researchRoute ?? defaultRoute).map((entry) => ({ ...entry })),
    };
    delete execution.executorPool;
    delete execution.activeExecutor;
    execution.maxWorkers = selection.maxWorkers;
    execution.retryPolicy = { ...selection.retryPolicy };
    execution.subtaskNotifications = selection.subtaskNotifications;
    execution.deferredPiTools = selection.deferredPiTools
      ?? (typeof execution.deferredPiTools === "boolean" ? execution.deferredPiTools : true);
    delete execution.parallelEnabled;
    delete execution.externalExecutors;
    parsed.execution = execution;
    const review = isRecord(parsed.review) ? { ...parsed.review } : {};
    review.activeReviewers = selection.activeReviewers.map((reviewer) => ({ ...reviewer }));
    parsed.review = review;
    parsed.reviewerTimeoutMs = selection.reviewerTimeoutMs;
    parsed.executorTimeoutMs = selection.executorTimeoutMs;
    parsed.maxCorrectionCycles = selection.maxCorrectionCycles;
    parsed.implementationGuidanceAfterCorrectionAttempts = selection.implementationGuidanceAfterCorrectionAttempts;
    parsed.retainBundles = selection.retainBundles;
    const ui = isRecord(parsed.ui) ? { ...parsed.ui } : {};
    ui.subtasksViewExpanded = selection.subtasksViewExpanded;
    parsed.ui = ui;
    if (selection.webMaxDownloadBytes !== undefined) {
      const web = isRecord(parsed.web) ? { ...parsed.web } : {};
      const fetch = isRecord(web.fetch) ? { ...web.fetch } : {};
      fetch.maxDownloadBytes = selection.webMaxDownloadBytes;
      web.fetch = fetch;
      parsed.web = web;
    }
    parsed.externalAgents = catalog;
    delete parsed.decider;
    delete parsed.reviewers;
    delete parsed.enabledReviewerIds;
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
