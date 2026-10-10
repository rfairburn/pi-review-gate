import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setCatalogKey } from "./catalog-key";
import { guardExternalAgentReferenceBaseline, guardExternalAgentReferences, type ExternalAgentOperation, type ExternalAgentReferenceBaseline } from "./external-agent-catalog";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  cloneScheduledTaskCatalog,
  cloneExternalAgentCatalog,
  type ExternalAgentCatalog,
  cloneWorkerCatalog,
  executorEntryId,
  normalizeConfig,
  externalAgentSupportsExecution,
  externalAgentSupportsReview,
  resolvedExternalAgent,
  workerResourceSupportsResearch,
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
  /** New definitions only; merged into the latest disk catalog at Save. */
  externalAgentAdditions?: ExternalAgentCatalog;
  externalAgentOperations?: ExternalAgentOperation[];
  externalAgentOpening?: ReviewGateConfig;
  /**
   * Pre-cascade reference baselines for session-only applied external-agent
   * operations (issue #294), keyed by the operation's original id. Save runs
   * the optimistic reference guard against these captured projections instead
   * of this session's opening snapshot, which is post-cascade for seeded
   * operations and would conflict with unchanged on-disk references.
   */
  externalAgentReferenceBaselines?: Record<string, ExternalAgentReferenceBaseline>;
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
  /**
   * Entry ids whose already-run state the caller EXPLICITLY toggled in its
   * staged session (issue #306). For every other entry, Save preserves the
   * latest on-disk alreadyRun instead of the staged snapshot's value, so a
   * stale or unrelated settings Save can never erase an alreadyRun the
   * scheduler recorded after the menu opened. An explicit toggle always wins.
   */
  scheduledTasksAlreadyRunEdited?: string[];
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

/**
 * The canonical staged-selection field assembly (issue #294): applies the
 * staged scalar and section selections to a raw config record. Shared by
 * Save (over the latest disk record) and the session-only Escape apply (over
 * the live config), so both paths stage identical fields through one code
 * path. Catalog-level merges — the external-agent cascade and the
 * scheduled-task foreign-entry preservation — stay at their respective
 * boundaries; this function never reads or writes the disk.
 */
function applyStagedSelectionFields(parsed: Record<string, unknown>, selection: ReviewSettingsSelection): void {
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
}

/**
 * Assemble a normalized config from staged selections over the current live
 * config (issue #294): the canonical selection assembly for the session-only
 * Escape apply, sharing {@link applyStagedSelectionFields} with Save. The
 * base supplies every non-staged field; the supplied catalogs replace the
 * base's catalogs wholesale (the menu draft already carries the staged
 * external-agent cascade, and the staged scheduled catalog is final). No disk
 * read or merge happens here: foreign-entry preservation and the
 * external-agent optimistic cascade stay at the persistence boundary.
 */
export function assembleStagedSelectionConfig(
  base: ReviewGateConfig,
  selection: ReviewSettingsSelection,
  catalogs: { externalAgents?: ExternalAgentCatalog; scheduledTasks?: ScheduledTaskCatalog } = {},
): ReviewGateConfig {
  const next: Record<string, unknown> = { ...base };
  applyStagedSelectionFields(next, selection);
  if (catalogs.externalAgents !== undefined) next.externalAgents = cloneExternalAgentCatalog(catalogs.externalAgents);
  if (catalogs.scheduledTasks !== undefined) next.scheduledTasks = cloneScheduledTaskCatalog(catalogs.scheduledTasks);
  return normalizeConfig(next);
}

export async function persistReviewSettings(
  configPath: string,
  selection: ReviewSettingsSelection,
): Promise<ReviewGateConfig> {
  let scheduledTasksResult: Record<string, unknown> | undefined;
  const latestAffectedPins = new Set<string>();
  return updateReviewGateConfig(configPath, (parsed) => {
    if (selection.externalAgentOperations?.length) {
      let latest: ReviewGateConfig;
      try {
        // Validate the stored catalog, not owned scalar settings that this
        // transaction may be repairing. The complete candidate is validated
        // after the staged settings have been applied below.
        latest = normalizeConfig({ externalAgents: parsed.externalAgents });
        if (selection.externalAgentOperations.some((operation) => operation.baseline !== undefined)) {
          const execution = isRecord(parsed.execution) ? parsed.execution : undefined;
          const review = isRecord(parsed.review) ? parsed.review : undefined;
          const references = normalizeConfig({
            execution: execution && { workerResources: execution.workerResources, routes: execution.routes },
            review: review && { activeReviewers: review.activeReviewers, primaryReviewers: review.primaryReviewers, subtaskReviewers: review.subtaskReviewers },
          });
          latest.execution = references.execution;
          latest.review = references.review;
        }
      }
      catch { throw new Error("External worker settings changed or are invalid on disk. Reopen settings before saving."); }
      // Foreign schedules remain unvalidated, but their structured references
      // must still participate in optimistic cascade safety.
      latest.scheduledTasks = (isRecord(parsed.scheduledTasks) ? parsed.scheduledTasks : {}) as ScheduledTaskCatalog;
      // Include latest resource identities, not only the opening snapshot:
      // preserved foreign schedules may pin resources appended meanwhile.
      const touchedIds = new Set(selection.externalAgentOperations.flatMap((operation) => [operation.id, ...(operation.nextId ? [operation.nextId] : [])]));
      const storedResources = isRecord(parsed.execution) ? parsed.execution.workerResources : undefined;
      const resourceEntries: [string, unknown][] = Array.isArray(storedResources)
        ? storedResources.flatMap((resource): [string, unknown][] => {
          if (!isRecord(resource) || !isRecord(resource.selection) || resource.selection.source !== "external" || typeof resource.selection.id !== "string") return [];
          // Match the legacy importer: resourceId, or its generated selection
          // identity when omitted. Agent catalog entries use a different id.
          const resourceId = typeof resource.resourceId === "string" && resource.resourceId.trim()
            ? resource.resourceId.trim()
            : executorEntryId({ source: "external", id: resource.selection.id.trim() });
          return [[resourceId, resource]];
        })
        : isRecord(storedResources) ? Object.entries(storedResources) : [];
      for (const [resourceId, resource] of resourceEntries) {
        if (isRecord(resource) && isRecord(resource.selection) && resource.selection.source === "external" && typeof resource.selection.id === "string" && touchedIds.has(resource.selection.id.trim())) {
          latestAffectedPins.add(resourceId.trim());
        }
      }
      const merged = cloneExternalAgentCatalog(latest.externalAgents ?? {});
      const releasedIds = new Set(selection.externalAgentOperations.filter((operation) => operation.baseline !== undefined && operation.nextId !== operation.id).map((operation) => operation.id));
      const finalIds = new Set<string>();
      for (const operation of selection.externalAgentOperations) {
        if (operation.nextId !== undefined) {
          if (finalIds.has(operation.nextId)) throw new Error("External worker draft IDs collide. Reopen settings before saving.");
          finalIds.add(operation.nextId);
        }
        const exists = Object.hasOwn(merged, operation.id);
        if (operation.baseline !== undefined) {
          if (!exists || !isDeepStrictEqual(merged[operation.id], operation.baseline)) {
            throw new Error("An edited external worker changed or disappeared on disk. Reopen settings before saving.");
          }
          // Same-ID role/option edits also must not erase newly added
          // related resources or break their preserved foreign schedules.
          const referenceBaseline = selection.externalAgentReferenceBaselines?.[operation.id];
          if (referenceBaseline !== undefined) {
            // Issue #294: this operation was applied session-only in an
            // earlier menu session; guard against its captured pre-cascade
            // baseline, not this session's post-cascade opening snapshot.
            guardExternalAgentReferenceBaseline(referenceBaseline, latest, operation.id);
          } else {
            if (!selection.externalAgentOpening) throw new Error("Missing external worker opening baseline. Reopen settings.");
            guardExternalAgentReferences(selection.externalAgentOpening, latest, operation.id);
          }
        } else if (operation.nextId !== undefined && exists && !releasedIds.has(operation.id)) {
          // A creation at an ID released by a baseline-guarded pending rename
          // is safe: that rename's definition and reference checks above
          // already cover the original on-disk entry, and it releases the ID
          // in this same transaction (issue #294). Unrelated disk collisions
          // remain blocking.
          throw new Error("An external worker ID created in this menu already exists on disk. Reopen settings.");
        }
        if (operation.nextId !== undefined && operation.nextId !== operation.id && Object.hasOwn(merged, operation.nextId) && !releasedIds.has(operation.nextId)) {
          throw new Error("External worker rename destination already exists on disk. Reopen settings and choose a different ID.");
        }
      }
      // Release opening keys before installing final keys, so valid staged
      // rename chains/swaps cannot delete a newly installed definition.
      for (const operation of selection.externalAgentOperations) if (operation.baseline !== undefined) delete merged[operation.id];
      for (const operation of selection.externalAgentOperations) {
        if (operation.nextId !== undefined) Object.defineProperty(merged, operation.nextId, { value: operation.definition, enumerable: true, writable: true, configurable: true });
      }
      parsed.externalAgents = merged;
    }
    applyStagedSelectionFields(parsed, selection);
    // Import the latest catalog (including legacy arrays), never the stale
    // menu snapshot. Existing definitions remain owned by disk; creation
    // cannot overwrite even an identical definition saved by another menu.
    if (selection.externalAgentAdditions && Object.keys(selection.externalAgentAdditions).length > 0) {
      const stored = normalizeConfig({ externalAgents: parsed.externalAgents }).externalAgents ?? {};
      const merged = cloneExternalAgentCatalog(stored);
      for (const [id, definition] of Object.entries(selection.externalAgentAdditions)) {
        if (Object.prototype.hasOwnProperty.call(stored, id)) {
          throw new Error("An external worker ID created in this menu already exists on disk. Reopen settings and create it with a different ID.");
        }
        Object.defineProperty(merged, id, { value: definition, enumerable: true, writable: true, configurable: true });
      }
      parsed.externalAgents = merged;
    }
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
      // Issue #306: the scheduler records alreadyRun=true on disk at actual
      // execution start. A staged snapshot opened before that record must not
      // erase it on an unrelated Save — and a stale snapshot that still carries
      // true must not resurrect a flag another save explicitly cleared. For
      // every EXISTING entry the caller did not explicitly toggle, the latest
      // on-disk value wins in BOTH directions; newly created entries keep
      // their staged state. An explicit manual re-arm/disarm always persists.
      const alreadyRunEdited = new Set(selection.scheduledTasksAlreadyRunEdited ?? []);
      for (const id of Object.keys(staged)) {
        if (alreadyRunEdited.has(id)) continue;
        const storedEntry = isRecord(stored[id]) ? stored[id] : undefined;
        if (storedEntry === undefined) continue;
        const stagedEntry = staged[id];
        if (storedEntry.alreadyRun === true && stagedEntry?.alreadyRun !== true) {
          setCatalogKey(staged, id, { ...stagedEntry, alreadyRun: true });
        } else if (storedEntry.alreadyRun !== true && stagedEntry?.alreadyRun === true) {
          const cleared = { ...stagedEntry };
          delete cleared.alreadyRun;
          setCatalogKey(staged, id, cleared);
        }
      }
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
  }, {
    afterValidate: (finalParsed, normalized) => {
      // Selection validation in the menu used its opening snapshot. Recheck
      // external references against the merged latest catalog before writing,
      // so concurrent removal/role changes cannot persist broken selections.
      const checkReviewers = (reviewers: readonly ActiveReviewerSelection[]): void => {
        for (const reviewer of reviewers) {
          if (reviewer.source !== "external") continue;
          const agent = resolvedExternalAgent(normalized, reviewer.id);
          if (!agent || !externalAgentSupportsReview(agent)) {
            throw new Error("A selected external reviewer no longer supports review on disk. Reopen settings and select an available reviewer.");
          }
        }
      };
      for (const resource of Object.values(selection.workerResources)) {
        if (resource.selection.source !== "external") continue;
        const agent = resolvedExternalAgent(normalized, resource.selection.id);
        if (!agent || !externalAgentSupportsExecution(agent)) {
          throw new Error("A selected external worker no longer supports execution on disk. Reopen settings and select an available worker.");
        }
      }
      for (const entry of selection.researchRoute ?? []) {
        const resource = selection.workerResources[entry.resourceId];
        if (!resource || !workerResourceSupportsResearch(normalized, resource.selection)) {
          throw new Error("A selected research worker is no longer research-capable on disk. Reopen settings and select a research-capable worker.");
        }
      }
      checkReviewers(selection.primaryReviewers);
      checkReviewers(selection.subtaskReviewers);
      for (const task of Object.values(selection.scheduledTasks ?? {})) {
        if ((task.destination ?? "subtask") !== "subtask") continue;
        if (task.review?.mode === "selected") checkReviewers(task.review.reviewers);
        if (task.kind === "research" && task.workerResourceId !== undefined) {
          const resource = selection.workerResources[task.workerResourceId];
          if (!resource || !workerResourceSupportsResearch(normalized, resource.selection)) {
            throw new Error("A scheduled research worker is no longer research-capable on disk. Reopen settings and select a research-capable worker.");
          }
        }
      }
      // Restored foreign entries are not generally revalidated. Check only
      // structured references affected by this catalog transaction, including
      // dormant orchestrator-turn overrides, before the atomic write.
      const touchedIds = new Set((selection.externalAgentOperations ?? []).flatMap((operation) => [operation.id, ...(operation.nextId ? [operation.nextId] : [])]));
      const affectedPins = new Set([...latestAffectedPins, ...Object.entries(selection.externalAgentOpening?.execution?.workerResources ?? {}).filter(([, resource]) => resource.selection.source === "external" && touchedIds.has(resource.selection.id)).map(([id]) => id)]);
      const finalSchedules = scheduledTasksResult ?? finalParsed.scheduledTasks;
      if (isRecord(finalSchedules)) {
        for (const rawTask of Object.values(finalSchedules)) {
          if (!isRecord(rawTask)) continue;
          if (typeof rawTask.workerResourceId === "string" && affectedPins.has(rawTask.workerResourceId.trim()) && !Object.hasOwn(selection.workerResources, rawTask.workerResourceId.trim())) {
            throw new Error("A preserved schedule still pins a removed worker resource. Reopen settings before saving.");
          }
          if (isRecord(rawTask.review) && rawTask.review.mode === "selected" && Array.isArray(rawTask.review.reviewers)) {
            checkReviewers(rawTask.review.reviewers.filter((reviewer): reviewer is ActiveReviewerSelection => isRecord(reviewer) && reviewer.source === "external" && typeof reviewer.id === "string" && touchedIds.has(reviewer.id)));
          }
        }
      }
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

/**
 * Live per-entry already-run state captured BEFORE an asynchronous save
 * starts (#306). The entry identity plus the flag let a later install tell a
 * newer live change (consumption or explicit re-arm) apart from the stale
 * result it is replacing.
 */
export type ScheduledAlreadyRunSnapshot = ReadonlyMap<string, {
  entry: ScheduledTaskCatalog[string];
  alreadyRun: boolean;
}>;

/** Capture the live scheduled entries' identity and already-run flags. */
export function captureScheduledAlreadyRun(config: ReviewGateConfig): ScheduledAlreadyRunSnapshot {
  return new Map<string, { entry: ScheduledTaskCatalog[string]; alreadyRun: boolean }>(
    Object.entries(config.scheduledTasks ?? {}).map(([id, entry]) =>
      [id, { entry, alreadyRun: entry.alreadyRun === true }]),
  );
}

/**
 * Install an asynchronous config result into the live in-memory config.
 *
 * #306: a scheduler-recorded alreadyRun=true in the LIVE catalog must survive
 * installing a result captured before the consumption write landed — such a
 * stale result would otherwise silently re-arm a consumed one-shot entry and
 * allow a second execution. Symmetrically, an explicit re-arm that installed
 * false while this save was still in flight must survive the older result
 * reinstalling true: when a pre-save baseline is supplied, a live flag that
 * CHANGED during the save wins in either direction. The protection is skipped
 * for entries whose Already-run field this result explicitly edited (a manual
 * re-arm/disarm always wins in both directions).
 */
export function replaceConfig(
  target: ReviewGateConfig,
  next: ReviewGateConfig,
  options?: {
    scheduledTasksAlreadyRunEdited?: Iterable<string>;
    scheduledTasksAlreadyRunBeforeSave?: ScheduledAlreadyRunSnapshot;
  },
): void {
  const mutable = target as unknown as Record<string, unknown>;
  const previousScheduledTasks = target.scheduledTasks;
  for (const key of Object.keys(mutable)) {
    delete mutable[key];
  }
  Object.assign(mutable, next);
  if (previousScheduledTasks === undefined || !isRecord(next.scheduledTasks)) return;
  const edited = new Set(options?.scheduledTasksAlreadyRunEdited ?? []);
  for (const [id, previousEntry] of Object.entries(previousScheduledTasks)) {
    if (edited.has(id)) continue;
    const alreadyRun = previousEntry.alreadyRun === true;
    const baseline = options?.scheduledTasksAlreadyRunBeforeSave?.get(id);
    const changedDuringSave = baseline !== undefined
      && (baseline.entry !== previousEntry || baseline.alreadyRun !== alreadyRun);
    // With a pre-save baseline, preserve only a newer live change. An
    // unchanged live true must not override the latest on-disk false returned
    // by Save (for example, another settings session explicitly re-armed it).
    // Without a baseline, retain the conservative live-consumption protection.
    if (!changedDuringSave && (options?.scheduledTasksAlreadyRunBeforeSave !== undefined || !alreadyRun)) continue;
    const nextEntry = next.scheduledTasks[id];
    if (isRecord(nextEntry)) {
      if (alreadyRun) nextEntry.alreadyRun = true;
      else delete nextEntry.alreadyRun;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
