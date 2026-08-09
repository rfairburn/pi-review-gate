import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  externalAgentCatalog,
  normalizeConfig,
  type ActiveExecutorSelection,
  type ActiveReviewerSelection,
  type RetainBundles,
  type ReviewGateConfig,
} from "../config";

export interface ReviewSettingsSelection {
  activeExecutor: ActiveExecutorSelection;
  activeReviewers: ActiveReviewerSelection[];
  maxCorrectionCycles: number;
  implementationGuidanceAfterCorrectionAttempts: number;
  retainBundles: RetainBundles;
}

export async function persistReviewSettings(
  configPath: string,
  selection: ReviewSettingsSelection,
): Promise<ReviewGateConfig> {
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("review gate config must be a JSON object");
  }

  const catalog = externalAgentCatalog(normalizeConfig(parsed));
  const execution = isRecord(parsed.execution) ? { ...parsed.execution } : {};
  execution.activeExecutor = selection.activeExecutor;
  delete execution.externalExecutors;
  parsed.execution = execution;
  const review = isRecord(parsed.review) ? { ...parsed.review } : {};
  review.activeReviewers = selection.activeReviewers.map((reviewer) => ({ ...reviewer }));
  parsed.review = review;
  parsed.maxCorrectionCycles = selection.maxCorrectionCycles;
  parsed.implementationGuidanceAfterCorrectionAttempts = selection.implementationGuidanceAfterCorrectionAttempts;
  parsed.retainBundles = selection.retainBundles;
  parsed.externalAgents = catalog;
  delete parsed.decider;
  delete parsed.reviewers;
  delete parsed.enabledReviewerIds;

  const normalized = normalizeConfig(parsed);
  const tempPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
  return normalized;
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
