import { isDeepStrictEqual } from "node:util";
import { cloneExternalAgentCatalog, effectiveReviewSettings, normalizeConfig, resolvedExternalAgent, resolvedWorkerCatalog, type ExternalAgentValue, type ReviewGateConfig } from "../config";
import { selectExternalAgentCreation, selectExternalAgentEdit } from "./external-agents";
import { retainedSelect } from "./menu";
import type { UiContext } from "./ui";

export interface ExternalAgentOperation {
  /** Opening identity and immutable definition; absent baseline means creation. */
  id: string;
  baseline?: ExternalAgentValue;
  nextId?: string;
  definition?: ExternalAgentValue;
}

export function stageExternalAgentOperation(operations: ExternalAgentOperation[], opening: ReviewGateConfig, id: string, nextId?: string, definition?: ExternalAgentValue): void {
  const prior = operations.find((operation) => operation.nextId === id);
  if (prior) { prior.nextId = nextId; prior.definition = definition && structuredClone(definition); }
  else operations.push({ id, baseline: Object.hasOwn(opening.externalAgents ?? {}, id) ? structuredClone(opening.externalAgents![id]) : undefined, nextId, definition: definition && structuredClone(definition) });
}

/** One isolated draft transaction, touching structured references only. */
export function changeExternalAgent(config: ReviewGateConfig, id: string, nextId?: string, definition?: ExternalAgentValue): { config: ReviewGateConfig; notices: string[] } {
  if (!Object.hasOwn(config.externalAgents ?? {}, id)) throw new Error("Worker no longer exists in this draft.");
  if (nextId !== undefined && nextId !== id && Object.hasOwn(config.externalAgents ?? {}, nextId)) throw new Error("Worker ID already exists in this draft.");
  if (nextId !== undefined) normalizeConfig({ externalAgents: Object.fromEntries([[nextId, definition]]) });
  const next = structuredClone(config);
  next.externalAgents = cloneExternalAgentCatalog(next.externalAgents ?? {});
  delete next.externalAgents[id];
  if (nextId !== undefined) Object.defineProperty(next.externalAgents, nextId, { value: structuredClone(definition), enumerable: true, writable: true, configurable: true });
  const notices = [`Staged ${nextId === undefined ? "deletion" : "edit"} of external worker ${id}${nextId && nextId !== id ? ` → ${nextId}` : ""}. Save applies; Cancel discards.`];
  const resources = resolvedWorkerCatalog(next);
  const removed = new Set<string>();
  for (const [key, resource] of Object.entries(resources)) {
    if (resource.selection.source !== "external" || resource.selection.id !== id) continue;
    if (nextId !== undefined) resource.selection.id = nextId;
    else { delete resources[key]; removed.add(key); notices.push(`Removed worker resource ${key}.`); }
  }
  next.execution = { ...next.execution, workerResources: resources };
  if (nextId === undefined) {
    for (const role of ["execute", "research"] as const) {
      const route = next.execution.routes?.[role];
      for (const entry of route ?? []) if (removed.has(entry.resourceId)) notices.push(`Removed ${role} route entry ${entry.resourceId}.`);
      if (route) next.execution.routes![role] = route.filter((entry) => !removed.has(entry.resourceId));
    }
  }
  const updateReviewers = (reviewers: ReturnType<typeof effectiveReviewSettings>["primaryReviewers"], label: string) => reviewers.flatMap((reviewer) => {
    if (reviewer.source !== "external" || reviewer.id !== id) return [reviewer];
    if (nextId !== undefined) return [{ ...reviewer, id: nextId }];
    notices.push(`Removed ${label} reviewer ${id}.`); return [];
  });
  const review = effectiveReviewSettings(next);
  next.review = { ...next.review, primaryReviewers: updateReviewers(review.primaryReviewers, "primary layer"), subtaskReviewers: updateReviewers(review.subtaskReviewers, "subtask layer") };
  delete next.review.activeReviewers;
  for (const [taskId, task] of Object.entries(next.scheduledTasks ?? {})) {
    let disabled = false;
    if (task.workerResourceId && removed.has(task.workerResourceId)) {
      notices.push(`Task ${taskId}: removed pin ${task.workerResourceId}; worker now inherits.`);
      delete task.workerResourceId; disabled = true;
    }
    if (task.review?.mode === "selected") {
      const reviewers = updateReviewers(task.review.reviewers, `task ${taskId} selected`);
      if (reviewers.length === 0 && task.review.reviewers.length !== 0) {
        delete task.review; disabled = true;
        notices.push(`Task ${taskId}: empty selected-reviewer override reset to inheritance.`);
      } else task.review.reviewers = reviewers;
    }
    if (disabled) { task.enabled = false; notices.push(`Task ${taskId} disabled. Later enabling uses configured defaults for reset references.`); }
  }
  return { config: next, notices };
}

/** A narrowly scoped optimistic guard, including dormant and foreign schedules. */
export function externalAgentReferences(config: ReviewGateConfig, id: string, extraResources: readonly string[] = []): unknown {
  const resources = resolvedWorkerCatalog(config);
  const affected = new Set([...extraResources, ...Object.entries(resources).filter(([, r]) => r.selection.source === "external" && r.selection.id === id).map(([key]) => key)]);
  const review = effectiveReviewSettings(config);
  const contains = (reviewers: typeof review.primaryReviewers) => Array.isArray(reviewers) && reviewers.some((r) => r && r.source === "external" && r.id === id);
  return {
    resources: Object.entries(resources).filter(([key]) => affected.has(key)),
    routes: ["execute", "research"].map((role) => (config.execution?.routes?.[role as "execute" | "research"] ?? []).map((entry, index) => ({ entry, index })).filter(({ entry }) => affected.has(entry.resourceId))),
    primary: contains(review.primaryReviewers) ? review.primaryReviewers : undefined,
    subtask: contains(review.subtaskReviewers) ? review.subtaskReviewers : undefined,
    schedules: Object.entries(config.scheduledTasks ?? {}).filter(([, task]) => task && (affected.has(typeof task.workerResourceId === "string" ? task.workerResourceId.trim() : "") || (task.review?.mode === "selected" && contains(task.review.reviewers)))).map(([key, task]) => {
      let reviewReference = task.review;
      // Match load-time normalization of just the affected references, never
      // validate foreign instructions/cron/workspace or unrelated entries.
      if (task.review?.mode === "selected") {
        try { reviewReference = { mode: "selected", reviewers: effectiveReviewSettings(normalizeConfig({ review: { primaryReviewers: task.review.reviewers, subtaskReviewers: [] } })).primaryReviewers }; }
        catch { /* A malformed affected reference conflicts conservatively. */ }
      } else if (task.review?.mode === "off") reviewReference = { mode: "off" };
      return [key, { workerResourceId: typeof task.workerResourceId === "string" ? task.workerResourceId.trim() : undefined, review: reviewReference, enabled: task.enabled ?? true }];
    }),
  };
}

export function guardExternalAgentReferences(opening: ReviewGateConfig, latest: ReviewGateConfig, id: string): void {
  const resourceIds = Object.entries(resolvedWorkerCatalog(opening)).filter(([, r]) => r.selection.source === "external" && r.selection.id === id).map(([key]) => key);
  if (!isDeepStrictEqual(externalAgentReferences(opening, id, resourceIds), externalAgentReferences(latest, id, resourceIds))) {
    throw new Error("External worker references changed on disk. Reopen settings to review the rename/deletion cascade before saving.");
  }
}

export async function manageExternalAgents(ui: UiContext, config: ReviewGateConfig, apply: (id: string, nextId?: string, definition?: ExternalAgentValue) => Promise<void>): Promise<void> {
  while (true) {
    const ids = Object.keys(config.externalAgents ?? {});
    const choice = await retainedSelect(ui, { title: "External workers — definitions only", rows: [
      ...ids.map((id, index) => ({ key: `worker:${index}`, label: `${id} [${config.externalAgents![id]!.adapter}]` })),
      { key: "action:create", label: "Create worker" }, { key: "action:back", label: "Back" },
    ] });
    if (!choice || choice === "action:back") return;
    if (choice === "action:create") {
      const created = await selectExternalAgentCreation(ui, config);
      if (created) { const { id, ...definition } = created; await apply(id, id, definition); }
      continue;
    }
    const id = ids.find((_, index) => choice === `worker:${index}`);
    if (id === undefined) continue;
    const agent = resolvedExternalAgent(config, id)!;
    if (agent.adapter === "claude-cli" || agent.adapter === "codex-cli") {
      const edited = await selectExternalAgentEdit(ui, config, agent);
      if (edited?.kind === "delete") await apply(edited.id);
      else if (edited?.kind === "apply") { const { id: nextId, ...definition } = edited.agent; await apply(id, nextId, definition); }
    } else {
      const action = await retainedSelect(ui, { title: `Worker ${id} — unsupported adapter`, rows: [
        { key: "delete", label: "Delete" }, { key: "back", label: "Back" },
      ] });
      if (action === "delete") await apply(id);
    }
  }
}
