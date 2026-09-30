/**
 * The save-time cross-domain validation for the staged settings selection
 * (reviewer duplicates, scoped Pi models, executor/route constraints,
 * executable availability), kept whole so the root save path and the
 * scheduled-task reviewer overrides resolve reviewers by one shared
 * contract.
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  MAX_EXECUTION_WORKERS,
  externalAgentSupportsExecution,
  externalAgentSupportsReview,
  executorSelectionKey,
  resolvedExternalAgent,
  workerResourceSupportsResearch,
  type ActiveReviewerSelection,
  type ReviewGateConfig,
  type WorkerResourceCatalog,
  type WorkerRouteEntry,
} from "../config";
import type { ScopedModelChoice } from "./models";
import { reviewerKey } from "./review";

export async function validateSelection(
  workerResources: WorkerResourceCatalog,
  reviewers: ActiveReviewerSelection[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  executeRoute: WorkerRouteEntry[] = [],
  researchRoute: WorkerRouteEntry[] = [],
): Promise<string | undefined> {
  const duplicateReviewer = duplicate(reviewers.map(reviewerKey));
  if (duplicateReviewer) return `Duplicate enabled reviewer: ${duplicateReviewer}`;
  const scopedModels = new Set(scoped.map((choice) => choice.model));
  const duplicateExecutor = duplicate(Object.values(workerResources).map((entry) => executorSelectionKey(entry.selection)));
  if (duplicateExecutor) return `Duplicate executor pool selection: ${duplicateExecutor}`;
  for (const [kind, route] of [["Execution", executeRoute], ["Research", researchRoute]] as const) {
    const duplicateResource = duplicate(route.map((entry) => entry.resourceId));
    if (duplicateResource) return `${kind} priority contains duplicate resource: ${duplicateResource}`;
    for (const entry of route) {
      const resource = Object.prototype.hasOwnProperty.call(workerResources, entry.resourceId)
        ? workerResources[entry.resourceId]
        : undefined;
      if (!resource) return `${kind} priority references missing worker resource: ${entry.resourceId}`;
      if (kind === "Research" && !workerResourceSupportsResearch(config, resource.selection)) {
        return `Research priority resource is not research-capable: ${entry.resourceId}`;
      }
      if (entry.thinkingLevel && resource.selection.source !== "pi") {
        return `${kind} priority cannot override thinking for external resource: ${entry.resourceId}`;
      }
      if (entry.thinkingLevel && resource.selection.source === "pi") {
        const selection = resource.selection;
        const model = scoped.find((candidate) => candidate.model === selection.model);
        if (!model?.supportedThinkingLevels.includes(entry.thinkingLevel)) {
          return `${kind} priority reasoning is unsupported for ${selection.model}: ${entry.thinkingLevel}`;
        }
      }
    }
  }
  for (const [resourceId, entry] of Object.entries(workerResources)) {
    if (!Number.isInteger(entry.maxConcurrent) || entry.maxConcurrent < 1 || entry.maxConcurrent > MAX_EXECUTION_WORKERS) {
      return `Executor maximum concurrency must be between 1 and ${MAX_EXECUTION_WORKERS}: ${resourceId}`;
    }
    const selection = entry.selection;
    if (selection.source === "pi") {
      const choice = scoped.find((candidate) => candidate.model === selection.model);
      if (!choice) return `Pi executor model is not currently scoped: ${selection.model}`;
      if (selection.thinkingLevel && !choice.supportedThinkingLevels.includes(selection.thinkingLevel)) {
        return `Pi executor reasoning is unsupported for ${selection.model}: ${selection.thinkingLevel}`;
      }
      if (config.enabled && !await commandAvailable("pi")) return "Executor executable is unavailable: pi";
      continue;
    }
    const agent = resolvedExternalAgent(config, selection.id);
    if (!agent || !externalAgentSupportsExecution(agent)) return `External executor is unavailable: ${selection.id}`;
    if (!await commandAvailable(agent.command!)) return `Executor executable is unavailable: ${agent.command}`;
  }
  for (const reviewer of reviewers) {
    if (reviewer.source === "pi") {
      const choice = scoped.find((candidate) => candidate.model === reviewer.model);
      if (!scopedModels.has(reviewer.model) || !choice) return `Pi reviewer model is not currently scoped: ${reviewer.model}`;
      if (reviewer.thinkingLevel && !choice.supportedThinkingLevels.includes(reviewer.thinkingLevel)) {
        return `Pi reviewer reasoning is unsupported for ${reviewer.model}: ${reviewer.thinkingLevel}`;
      }
      if (config.enabled && !await commandAvailable("pi")) return "Reviewer executable is unavailable: pi";
      continue;
    }
    const agent = resolvedExternalAgent(config, reviewer.id);
    if (!agent || !externalAgentSupportsReview(agent)) return `External reviewer is unavailable: ${reviewer.id}`;
    if (config.enabled && !await commandAvailable(agent.command!)) return `Reviewer executable is unavailable: ${agent.command} (${agent.id})`;
  }
  return undefined;
}

async function commandAvailable(command: string): Promise<boolean> {
  if (isAbsolute(command) || command.includes("/")) {
    return access(command, constants.X_OK).then(() => true, () => false);
  }
  for (const path of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (await access(join(path, command), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

function duplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => seen.has(value) || !seen.add(value));
}
