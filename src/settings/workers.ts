/**
 * Worker resources (the shared-capacity executor pool) and the explicit
 * execute/research role routes, plus the root menu's Worker resources
 * visit with its visit-scoped enrollment and model-reasoning re-pairing
 * bookkeeping (moved verbatim from the root dispatch, including both
 * enrollment paths). Also home to the executor/resource display summaries
 * shared with the root rows and the scheduled-task worker overrides.
 */
import {
  executorEntryId,
  executorSelectionKey,
  externalAgentSupportsExecution,
  MAX_EXECUTION_WORKERS,
  resolvedExternalAgent,
  workerResourceSupportsResearch,
  type ExecutorSelection,
  type ExternalAgentConfig,
  type ReviewGateConfig,
  type WorkerResourceCatalog,
  type WorkerResourceValue,
  type WorkerRouteEntry,
} from "../config";
import type { ScopedModelChoice } from "./models";
import { alignedSettingsRows, notify, type UiContext } from "./ui";
import { effectiveThinkingLevel, selectThinkingLevel, thinkingLevelLabel } from "./thinking";
import { setCatalogKey } from "./catalog-key";
import { type DraftSlot } from "./draft";
import { retainedChoice, retainedSelect } from "./menu";

/**
 * The shared draft's worker sub-holder (issue #723): the staged pool catalog
 * plus the two explicit role routes. The resources visit edits this holder in
 * place, so an accepted Add, edit, or enrollment is part of the draft — and of
 * the one dirty comparison — while its own screen is still drawn.
 */
export interface WorkerResourceDraft {
  workerResources: WorkerResourceCatalog;
  executeRoute: WorkerRouteEntry[];
  researchRoute: WorkerRouteEntry[];
}

/**
 * The root menu's Worker resources visit: pool editing plus the visit-scoped
 * enrollment and re-pairing bookkeeping that previously lived in the root
 * dispatch (moved verbatim). Its explicit-Add enrollment rule is implemented
 * once in enrollResourceInRoleRoutes and invoked at both the Add action and
 * the changed-final-model reconciliation. It stages into the shared `workers`
 * sub-holder it is given, so the root has no returned slice to adopt.
 */
export async function visitWorkerResources(
  ui: UiContext,
  workers: WorkerResourceDraft,
  agents: ExternalAgentConfig[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  /**
   * Target-switch opt-in: a PASSIVE visit (the pool catalog came back
   * unchanged, i.e. no resource edit) leaves the stored routes exactly as they
   * were instead of reconciling them. Reconciling silently drops a stored entry
   * this catalog excludes (a research entry on a non-research-capable
   * resource), which would make an untouched draft look edited; the owner-side
   * Save still validates the stored entry normally. An actual resource edit
   * keeps the existing reconciliation. Default off keeps existing callers
   * unchanged.
   */
  preserveStoredRoutes = false,
): Promise<void> {
  // Stored route slices and the catalog's identity at the visit start: a
  // passive Back must leave the routes exactly as they were.
  const routesAtVisitStart = {
    execute: workers.executeRoute.map((entry) => ({ ...entry })),
    research: workers.researchRoute.map((entry) => ({ ...entry })),
  };
  const resourcesAtVisitStart = workerCatalogKey(workers.workerResources);
  // Selection keys at the start of this visit. Reasoning re-pairing and
  // added-resource enrollment re-derivation run only for resources whose model
  // actually changed during this visit, so explicit per-route thinking levels
  // set between visits survive untouched.
  const keysAtVisitStart = new Map(
    Object.entries(workers.workerResources).map(([id, value]) => [id, executorSelectionKey(value.selection)]),
  );
  // Enrollment bookkeeping is scoped to this one visit: resources present when
  // the pool editor opened are never enrolled into a route they were excluded
  // from just because their model changed now; only resources added during this
  // visit keep Add's enrollment semantics against their final selection.
  const priorResourceIds = new Set(Object.keys(workers.workerResources));
  const enrolledSelectionKeys = new Map<string, string>();
  await selectExecutorPool(ui, workers, agents, config, scoped, (id, value) => {
    // Explicit Add enrolls the new resource in each supported role priority
    // directly at the action as the first (highest-priority) entry — successive
    // Adds therefore appear most-recent-first — with the model's default
    // reasoning. Passive load/save never enrolls: missing or empty routes stay
    // empty.
    enrollResourceInRoleRoutes(id, value.selection, workers.executeRoute, workers.researchRoute, config, scoped);
    enrolledSelectionKeys.set(id, executorSelectionKey(value.selection));
  });
  // An explicit re-add of an OPENING resource is a real edit even when the
  // final catalog key matches the opening one (same id, selection, and
  // capacity): the Add handler already enrolled it into the role priorities,
  // and that enrollment must not be restored away. A brand-new resource that
  // was added and then removed again leaves no enrollment behind and is still
  // passive.
  const readdedOpeningResource = [...enrolledSelectionKeys.keys()].some((id) => priorResourceIds.has(id));
  if (preserveStoredRoutes && !readdedOpeningResource && workerCatalogKey(workers.workerResources) === resourcesAtVisitStart) {
    workers.executeRoute = routesAtVisitStart.execute;
    workers.researchRoute = routesAtVisitStart.research;
    return;
  }
  workers.executeRoute = reconcileWorkerRoute(workers.executeRoute, workers.workerResources);
  workers.researchRoute = reconcileWorkerRoute(
    workers.researchRoute,
    filterResearchCapableCatalog(config, workers.workerResources),
  );
  for (const [id, value] of Object.entries(workers.workerResources)) {
    const currentKey = executorSelectionKey(value.selection);
    // Baseline: this visit's starting key; for resources added during this
    // visit, the key they were enrolled under (Add time or last
    // re-derivation). Equal means the model did not change during this visit,
    // so explicit per-route thinking levels are left alone.
    const baselineKey = keysAtVisitStart.get(id) ?? enrolledSelectionKeys.get(id);
    if (baselineKey === currentKey) continue;
    if (!priorResourceIds.has(id)) {
      // Added by explicit Add during this visit: enrollment follows the final
      // selection, not the model chosen at Add time.
      enrollResourceInRoleRoutes(id, value.selection, workers.executeRoute, workers.researchRoute, config, scoped);
      enrolledSelectionKeys.set(id, currentKey);
    }
    // Re-pair retained entries with the new model's reasoning; this runs only
    // when the model changed during this visit.
    workers.executeRoute = normalizeWorkerRouteAfterModelSwitch(workers.executeRoute, id, value.selection, scoped);
    workers.researchRoute = normalizeWorkerRouteAfterModelSwitch(workers.researchRoute, id, value.selection, scoped);
  }
}

/**
 * Display-only ordering: alphabetical by the displayed resource/model label
 * (case-insensitive), with a stable resource-ID tie-break. The key, not the
 * row order, is identity; saved catalogs are never reordered.
 */
export function sortedCatalogKeys(catalog: WorkerResourceCatalog, config: ReviewGateConfig, scoped: ScopedModelChoice[]): string[] {
  return Object.keys(catalog).sort((a, b) => {
    const labelA = executorSelectionLabel(catalog[a]!.selection, config, scoped).toLowerCase();
    const labelB = executorSelectionLabel(catalog[b]!.selection, config, scoped).toLowerCase();
    if (labelA < labelB) return -1;
    if (labelA > labelB) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

async function selectExecutorPool(
  ui: UiContext,
  workers: WorkerResourceDraft,
  agents: ExternalAgentConfig[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  onAdd?: (resourceId: string, value: WorkerResourceValue) => void,
): Promise<void> {
  // Caller-local last selection for this loop only: entry keys are the stable
  // resource ids, so a re-shown list after add/edit/re-sort keeps the same
  // resource highlighted even when its label or position changed (issue #140).
  let lastKey: string | undefined;
  while (true) {
    // The staged pool, read fresh from the shared holder on every show: an Add
    // writes into it in place and an edit replaces it on the holder, so either
    // is staged before this pool editor leaves (issue #723).
    const catalog = workers.workerResources;
    const keys = sortedCatalogKeys(catalog, config, scoped);
    const entryRows = keys.map((key, index) => `${index + 1}. ${executorPoolEntrySummary(catalog[key]!, config, scoped)}`);
    const choice = await retainedSelect(ui, {
      title: "Worker resources — shared capacity",
      rows: [
        ...keys.map((key, index) => ({ key, label: entryRows[index]! })),
        { key: "add", label: "Add worker resource" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return;
    lastKey = choice;
    if (choice === "add") {
      const selection = await selectExecutorModel(ui, undefined, Object.values(catalog), agents, scoped);
      if (!selection) continue;
      const createdId = executorEntryId(selection);
      // The generated id can collide with a resource that kept its stable key
      // after switching away from this selection. Overwriting it would replace
      // an existing identity, capacity, and route references, so fail the Add.
      if (Object.prototype.hasOwnProperty.call(catalog, createdId)) {
        await notify(ui, `Cannot add: generated resource id ${createdId} already belongs to another resource whose model was switched away from it; existing resources are unchanged.`, "error");
        continue;
      }
      const maxConcurrent = await selectExecutorCapacity(ui, 1);
      const createdValue: WorkerResourceValue = { selection, maxConcurrent };
      setCatalogKey(catalog, createdId, createdValue);
      onAdd?.(createdId, createdValue);
      continue;
    }
    // Resource ids can never equal the action keys above (they are prefixed
    // external-/pi-), so an unknown value is a no-op re-show as before.
    if (!Object.prototype.hasOwnProperty.call(catalog, choice)) continue;
    // The editor stages into the shared pool in place (issue #723): an accepted
    // model or capacity change is part of the draft — and of the one dirty
    // comparison — while the resource screen still shows the new value.
    await editExecutorPoolEntry(ui, workers, choice, agents, config, scoped);
  }
}

/** Routes initialize exactly as stored; a missing or empty route stays empty. */
export function initialWorkerRoute(
  config: ReviewGateConfig,
  kind: "execute" | "research",
): WorkerRouteEntry[] {
  const configured = config.execution?.routes?.[kind];
  return configured ? configured.map((entry) => ({ ...entry })) : [];
}

/** Route equality by resource identity, order, and stored reasoning level. */
function sameRouteEntries(a: WorkerRouteEntry[], b: WorkerRouteEntry[]): boolean {
  return a.length === b.length
    && a.every((entry, index) => entry.resourceId === b[index]!.resourceId && entry.thinkingLevel === b[index]!.thinkingLevel);
}

/**
 * Stable identity of one worker catalog, for the "did this visit change it"
 * check: ids, full selections, and capacities, with ids sorted.
 */
function workerCatalogKey(catalog: WorkerResourceCatalog): string {
  return JSON.stringify(Object.keys(catalog).sort().map((id) => [
    id,
    catalog[id]!.selection,
    catalog[id]!.maxConcurrent,
  ]));
}

function reconcileWorkerRoute(route: WorkerRouteEntry[], resources: WorkerResourceCatalog): WorkerRouteEntry[] {
  return route.filter((entry) => Object.prototype.hasOwnProperty.call(resources, entry.resourceId));
}

/** Catalog subset of the research-capable resources, keyed as before. */
export function filterResearchCapableCatalog(config: ReviewGateConfig, catalog: WorkerResourceCatalog): WorkerResourceCatalog {
  const out: WorkerResourceCatalog = {};
  for (const [id, value] of Object.entries(catalog)) {
    if (!workerResourceSupportsResearch(config, value.selection)) continue;
    setCatalogKey(out, id, { selection: { ...value.selection }, maxConcurrent: value.maxConcurrent });
  }
  return out;
}

/**
 * A worker resource's reasoning goes hand in hand with its selected model, so a
 * manual model replacement discards the previous model's level for every retained
 * route entry — even when the new model supports it. Each entry takes the new
 * model's own configured or pinned reasoning, otherwise its supported default,
 * so displayed, persisted, routed, and effective values all stay paired with the
 * model. External agents own their configuration; a Pi reasoning override no
 * longer applies.
 */
function normalizeWorkerRouteAfterModelSwitch(
  route: WorkerRouteEntry[],
  resourceId: string,
  selection: ExecutorSelection,
  scoped: ScopedModelChoice[],
): WorkerRouteEntry[] {
  if (selection.source !== "pi") {
    return route.map((entry) => entry.resourceId === resourceId
      ? { resourceId }
      : entry);
  }
  const choice = scoped.find((candidate) => candidate.model === selection.model);
  if (!choice) return route;
  const level = effectiveThinkingLevel(undefined, choice);
  return route.map((entry) => entry.resourceId === resourceId
    ? { resourceId, thinkingLevel: level }
    : entry);
}

function defaultWorkerRouteEntry(resourceId: string, selection: ExecutorSelection, scoped: ScopedModelChoice[]): WorkerRouteEntry {
  const choice = selection.source === "pi"
    ? scoped.find((candidate) => candidate.model === selection.model)
    : undefined;
  return {
    resourceId,
    thinkingLevel: choice ? effectiveThinkingLevel(undefined, choice) : undefined,
  };
}

/**
 * The explicit-Add enrollment rule shared by the Add action and the
 * changed-final-model reconciliation: list the resource in each role route it
 * is not already listed in — execute unconditionally, research only when its
 * selection supports research — with the model's default reasoning. A newly
 * inserted entry takes slot 1 (issue #370), so successive explicit Adds appear
 * most-recent-first while preexisting entries preserve their relative order;
 * the membership guards keep add/remove/re-add of one identity duplicate-free
 * and never promote an already-present entry.
 */
function enrollResourceInRoleRoutes(
  resourceId: string,
  selection: ExecutorSelection,
  executeRoute: WorkerRouteEntry[],
  researchRoute: WorkerRouteEntry[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): void {
  if (!executeRoute.some((entry) => entry.resourceId === resourceId)) {
    executeRoute.unshift({ ...defaultWorkerRouteEntry(resourceId, selection, scoped) });
  }
  if (workerResourceSupportsResearch(config, selection)
      && !researchRoute.some((entry) => entry.resourceId === resourceId)) {
    researchRoute.unshift({ ...defaultWorkerRouteEntry(resourceId, selection, scoped) });
  }
}

export async function selectWorkerRoute(
  ui: UiContext,
  title: string,
  /**
   * This route's slot on the transaction's shared worker sub-holder (issue
   * #723). Every accepted Add, move, exclude, and reasoning change is written
   * through it before the screen redraws, so the route the operator is looking
   * at IS the staged route, and the one dirty comparison sees it while this
   * editor is still open. Leaving the editor publishes the final route, which
   * is exactly the value the caller used to adopt from the return value.
   */
  routeSlot: DraftSlot<WorkerRouteEntry[]>,
  resources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  /**
   * Keep an entry's stored reasoning representation when its reasoning edit is
   * a no-op (Escape, or the row marked current). Without it, an omitted level
   * becomes the displayed fallback. Default off keeps existing callers
   * unchanged.
   */
  preserveCurrentThinking = false,
  /**
   * Target-switch opt-in: when this visit changes nothing (Back/Escape without
   * an edit), leave the STORED route exactly as it was rather than the
   * reconciled one, so an entry this route's eligible catalog excludes is not
   * silently dropped. Any real edit keeps the existing reconciliation. Default
   * off keeps existing callers unchanged.
   */
  preserveStoredRoutes = false,
): Promise<void> {
  const storedRoute = routeSlot.get().map((entry) => ({ ...entry }));
  let route = reconcileWorkerRoute(storedRoute.map((entry) => ({ ...entry })), resources);
  // The route as reconciled when the editor opened: if the visit leaves it
  // unchanged, nothing about this route was edited.
  const openingRoute = route.map((entry) => ({ ...entry }));
  // Publish the working route on the shared holder after an accepted action,
  // while the editor is still drawn: whenever the visit matches the route as it
  // opened, the STORED route stays staged, so an edit the operator undoes (Add
  // then Exclude) never leaves behind a phantom staged change — for every
  // caller, target-controlled or not (issue #723).
  const publish = (): void => {
    routeSlot.set(sameRouteEntries(route, openingRoute) ? storedRoute : route);
  };
  // Leaving the editor keeps its existing boundary: only the target-switch
  // opt-in keeps the stored route on an unchanged visit; every other caller
  // adopts the reconciled route at Back, exactly as before.
  const publishOnExit = (): void => {
    routeSlot.set(preserveStoredRoutes && sameRouteEntries(route, openingRoute) ? storedRoute : route);
  };
  // Caller-local last selection for this loop only: entry keys are the stable
  // resource ids, so the edited entry stays highlighted when the list re-shows
  // after an add, exclude, or move (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const rows = route.map((entry, index) => `${index + 1}. ${workerRouteEntrySummary(entry, resources, config, scoped)}`);
    const choice = await retainedSelect(ui, {
      title,
      rows: [
        ...route.map((entry, index) => ({ key: entry.resourceId, label: rows[index]! })),
        { key: "add", label: "Add resource" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") {
      publishOnExit();
      return;
    }
    lastKey = choice;
    if (choice === "add") {
      const used = new Set(route.map((entry) => entry.resourceId));
      const availableKeys = sortedCatalogKeys(resources, config, scoped).filter((key) => !used.has(key));
      const labels = availableKeys.map((key) => executorSelectionLabel(resources[key]!.selection, config, scoped));
      const selected = await retainedChoice(ui, `${title} — add`, labels.length ? [...labels, "Back"] : ["No additional resources", "Back"]);
      const index = labels.indexOf(selected ?? "");
      if (index >= 0) {
        const key = availableKeys[index]!;
        const selection = resources[key]!.selection;
        const modelChoice = selection.source === "pi"
          ? scoped.find((candidate) => candidate.model === selection.model)
          : undefined;
        // An explicit Add inserts the new entry at slot 1 (issue #370);
        // existing entries keep their order and reasoning.
        route.unshift({
          resourceId: key,
          thinkingLevel: selection.source === "pi" && modelChoice
            ? effectiveThinkingLevel(selection.thinkingLevel, modelChoice)
            : undefined,
        });
        publish();
      }
      continue;
    }
    let index = route.findIndex((candidate) => candidate.resourceId === choice);
    if (index < 0) continue;
    // The per-entry editor re-shows after every action (Move up/down
    // deliberately keeps editing the moved entry), so it retains its own last
    // action by key (issue #140).
    let editLastKey: string | undefined;
    while (route[index]) {
      const entry = route[index]!;
      const resource = Object.prototype.hasOwnProperty.call(resources, entry.resourceId)
        ? resources[entry.resourceId]
        : undefined;
      if (!resource) break;
      const [thinkingRow] = alignedSettingsRows([
        ["Thinking", routeThinkingSummary(entry, resource, scoped)],
      ]);
      const edit = await retainedSelect(ui, {
        title: `${title} — ${executorSelectionLabel(resource.selection, config, scoped)}`,
        rows: [
          ...(resource.selection.source === "pi" ? [{ key: "thinking", label: thinkingRow }] : []),
          ...(index > 0 ? [{ key: "moveUp", label: "Move up" }] : []),
          ...(index < route.length - 1 ? [{ key: "moveDown", label: "Move down" }] : []),
          { key: "exclude", label: "Exclude from this route" },
          { key: "back", label: "Back" },
        ],
        initialKey: editLastKey,
      });
      if (!edit || edit === "back") break;
      editLastKey = edit;
      if (edit === "thinking" && resource.selection.source === "pi") {
        const selection = resource.selection;
        const model = scoped.find((candidate) => candidate.model === selection.model);
        if (model) {
          const current = effectiveThinkingLevel(entry.thinkingLevel ?? selection.thinkingLevel, model);
          const next = await selectThinkingLevel(ui, model, current);
          // A no-op edit never materializes the displayed level: the entry keeps
          // exactly the representation it had (including an omitted level).
          if (!preserveCurrentThinking || next !== current) {
            entry.thinkingLevel = next;
            publish();
          }
        }
      } else if (edit === "moveUp" && index > 0) {
        [route[index - 1], route[index]] = [route[index]!, route[index - 1]!];
        index -= 1;
        publish();
      } else if (edit === "moveDown" && index < route.length - 1) {
        [route[index], route[index + 1]] = [route[index + 1]!, route[index]!];
        index += 1;
        publish();
      } else if (edit === "exclude") {
        route.splice(index, 1);
        publish();
        break;
      }
    }
  }
}

/**
 * Edit one catalog resource by its stable key. The catalog is unordered: there
 * are no reorder controls; ordering lives in the explicit role routes.
 *
 * The edit lands in the shared pool holder as it is accepted (issue #723): the
 * editor works on the staged catalog object itself rather than a private clone,
 * so a redrawn Model or Maximum concurrency value is already the draft's value
 * and the one dirty comparison sees it before Back. There is no discard in this
 * editor — Back keeps the edits, exactly as when the edited clone was returned
 * to the caller — so staging in place changes no outcome, only when the draft
 * learns about it.
 */
async function editExecutorPoolEntry(
  ui: UiContext,
  workers: WorkerResourceDraft,
  key: string,
  agents: ExternalAgentConfig[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): Promise<void> {
  const catalog = workers.workerResources;
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (Object.prototype.hasOwnProperty.call(catalog, key)) {
    const entry = catalog[key]!;
    const [modelRow, capacityRow] = alignedSettingsRows([
      ["Model", executorSelectionLabel(entry.selection, config, scoped)],
      ["Maximum concurrency", String(entry.maxConcurrent)],
    ]);
    const choice = await retainedSelect(ui, {
      title: `Worker resource ${key}`,
      rows: [
        { key: "model", label: modelRow },
        { key: "capacity", label: capacityRow },
        { key: "remove", label: "Remove" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return;
    lastKey = choice;
    if (choice === "model") {
      const others = Object.entries(catalog)
        .filter(([candidateKey]) => candidateKey !== key)
        .map(([, value]) => value);
      const selection = await selectExecutorModel(ui, entry.selection, others, agents, scoped);
      if (selection) setCatalogKey(catalog, key, { ...entry, selection });
      continue;
    }
    if (choice === "capacity") {
      setCatalogKey(catalog, key, { ...entry, maxConcurrent: await selectExecutorCapacity(ui, entry.maxConcurrent) });
      continue;
    }
    if (choice === "remove") {
      delete catalog[key];
      return;
    }
  }
}

async function selectExecutorModel(
  ui: UiContext,
  current: ExecutorSelection | undefined,
  existing: WorkerResourceValue[],
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<ExecutorSelection | undefined> {
  const unavailable = new Set(existing.map((entry) => executorSelectionKey(entry.selection)));
  const choices: Array<{ label: string; selection: ExecutorSelection; model?: ScopedModelChoice }> = [
    ...scoped.map((model) => ({
      label: model.label,
      selection: { source: "pi" as const, model: model.model },
      model,
    })),
    ...agents.filter(externalAgentSupportsExecution).map((agent) => ({
      label: `${agent.id} [${agent.adapter}]`,
      selection: { source: "external" as const, id: agent.id },
    })),
  ].filter((choice) => !unavailable.has(executorSelectionKey(choice.selection)));
  const rows = choices.map((choice) => `${choice.label}${current && executorSelectionKey(current) === executorSelectionKey(choice.selection) ? "  current" : ""}`);
  const selected = await retainedChoice(ui, "Executor model", rows.length > 0 ? [...rows, "Back"] : ["No additional executors available", "Back"]);
  if (!selected || selected === "Back") return undefined;
  const found = choices.find((_choice, index) => selected === rows[index]);
  if (!found) return undefined;
  return { ...found.selection };
}

async function selectExecutorCapacity(ui: UiContext, current: number): Promise<number> {
  const values = Array.from({ length: MAX_EXECUTION_WORKERS }, (_, index) => index + 1);
  const rows = values.map((value) => `${value}${value === current ? "  current" : ""}`);
  const selected = await retainedChoice(ui, `Maximum concurrency (1–${MAX_EXECUTION_WORKERS})`, rows);
  return values.find((_value, index) => selected === rows[index]) ?? current;
}

export function executorPoolSummary(catalog: WorkerResourceCatalog): string {
  const values = Object.values(catalog);
  const slots = values.reduce((total, entry) => total + entry.maxConcurrent, 0);
  return `${values.length} ${values.length === 1 ? "model" : "models"} · ${slots} ${slots === 1 ? "slot" : "slots"}`;
}

export function workerRouteSummary(
  route: WorkerRouteEntry[],
  resources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): string {
  if (route.length === 0) return "Disabled (no resources)";
  return route.map((entry) => {
    const resource = Object.prototype.hasOwnProperty.call(resources, entry.resourceId)
      ? resources[entry.resourceId]
      : undefined;
    return resource ? executorSelectionLabel(resource.selection, config, scoped).split(" [")[0] : `${entry.resourceId} [missing]`;
  }).join(" → ");
}

function workerRouteEntrySummary(
  route: WorkerRouteEntry,
  resources: WorkerResourceCatalog,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): string {
  const resource = Object.prototype.hasOwnProperty.call(resources, route.resourceId)
    ? resources[route.resourceId]
    : undefined;
  if (!resource) return `${route.resourceId} [missing]`;
  return `${executorSelectionLabel(resource.selection, config, scoped)} · ${routeThinkingSummary(route, resource, scoped)} · shared max ${resource.maxConcurrent}`;
}

function routeThinkingSummary(route: WorkerRouteEntry, resource: WorkerResourceValue, scoped: ScopedModelChoice[]): string {
  if (resource.selection.source === "external") return "Configured by agent";
  const selection = { ...resource.selection, thinkingLevel: route.thinkingLevel ?? resource.selection.thinkingLevel };
  return executorThinkingSummary(selection, scoped);
}

function executorPoolEntrySummary(entry: WorkerResourceValue, config: ReviewGateConfig, scoped: ScopedModelChoice[]): string {
  return `${executorSelectionLabel(entry.selection, config, scoped)} · shared max ${entry.maxConcurrent}`;
}

export function executorSelectionLabel(selection: ExecutorSelection, config: ReviewGateConfig, scoped: ScopedModelChoice[]): string {
  if (selection.source === "pi") {
    return scoped.find((candidate) => candidate.model === selection.model)?.label ?? `${selection.model} [unavailable]`;
  }
  const agent = resolvedExternalAgent(config, selection.id);
  return agent && externalAgentSupportsExecution(agent) ? `${agent.id} [${agent.adapter}]` : `${selection.id} [unavailable]`;
}

function executorThinkingSummary(selection: ExecutorSelection, scoped: ScopedModelChoice[]): string {
  if (selection.source === "external") return "Configured by agent";
  const model = scoped.find((candidate) => candidate.model === selection.model);
  return model
    ? thinkingLevelLabel(effectiveThinkingLevel(selection.thinkingLevel, model))
    : selection.thinkingLevel ? thinkingLevelLabel(selection.thinkingLevel) : "Unavailable";
}

export function withoutResourceThinkingCatalog(catalog: WorkerResourceCatalog): WorkerResourceCatalog {
  const out: WorkerResourceCatalog = {};
  for (const [resourceId, entry] of Object.entries(catalog)) {
    const selection = { ...entry.selection };
    if (selection.source === "pi") delete selection.thinkingLevel;
    setCatalogKey(out, resourceId, { selection, maxConcurrent: entry.maxConcurrent });
  }
  return out;
}
