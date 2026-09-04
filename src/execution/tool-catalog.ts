/**
 * Durable tool authorization and activation contract for executor tasks.
 *
 * `allowedToolCatalog` is the complete set a child may load. The
 * `initialActiveTools` set durably records the future deferred-activation
 * intent, but adapters do not consume it for activation until a trusted
 * bootstrap channel exists. Keeping the two values in one validated contract
 * prevents a restored or retried task from widening authorization.
 */
export interface ExecutorToolCatalog {
  allowedToolCatalog: string[];
  initialActiveTools: string[];
}

/** Legacy fields retained on task/operation records during format migration. */
export interface ExecutorToolCatalogCarrier {
  executorToolCatalog?: ExecutorToolCatalog;
  executorAllowedTools?: string[];
  executorInitialActiveTools?: string[];
}

/** Stable first-seen normalization: trim names, reject blanks, and dedupe. */
export function normalizeToolNames(names: readonly string[], label = "tool set"): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of names) {
    if (typeof value !== "string") throw new Error(`Invalid ${label}: every tool name must be a string.`);
    const name = value.trim();
    if (!name) throw new Error(`Invalid ${label}: tool names must not be empty.`);
    if (seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

/** Build the canonical contract, defaulting to legacy full-active behavior. */
export function createExecutorToolCatalog(
  allowedToolCatalog: readonly string[],
  initialActiveTools?: readonly string[],
): ExecutorToolCatalog {
  const allowed = normalizeToolNames(allowedToolCatalog, "allowed tool catalog");
  const initial = normalizeToolNames(initialActiveTools ?? allowed, "initial active tool set");
  const authorized = new Set(allowed);
  if (initial.some((name) => !authorized.has(name))) {
    // Do not enumerate names here: callers may source tool names from private
    // extensions. The invariant itself is enough for a useful diagnostic.
    throw new Error("Invalid executor tool catalog: initial active tools must be a subset of the allowed tool catalog.");
  }
  return { allowedToolCatalog: allowed, initialActiveTools: initial };
}

/**
 * Resolve current and legacy persisted shapes. Older records containing only
 * executorAllowedTools retain the historical behavior where every authorized
 * tool starts active.
 */
export function resolveExecutorToolCatalog(carrier: ExecutorToolCatalogCarrier): ExecutorToolCatalog | undefined {
  const canonical = carrier.executorToolCatalog;
  if (canonical !== undefined) {
    if (!canonical || !Array.isArray(canonical.allowedToolCatalog) || !Array.isArray(canonical.initialActiveTools)) {
      throw new Error("Invalid executor tool catalog: both allowed and initial tool sets are required.");
    }
    return createExecutorToolCatalog(canonical.allowedToolCatalog, canonical.initialActiveTools);
  }
  if (carrier.executorAllowedTools === undefined) {
    if (carrier.executorInitialActiveTools !== undefined) {
      throw new Error("Invalid executor tool catalog: an initial active set requires an allowed tool catalog.");
    }
    return undefined;
  }
  if (!Array.isArray(carrier.executorAllowedTools)) {
    throw new Error("Invalid executor tool catalog: allowed tools must be an array.");
  }
  if (carrier.executorInitialActiveTools !== undefined && !Array.isArray(carrier.executorInitialActiveTools)) {
    throw new Error("Invalid executor tool catalog: initial active tools must be an array.");
  }
  return createExecutorToolCatalog(carrier.executorAllowedTools, carrier.executorInitialActiveTools);
}

/** Persist the canonical contract and compatibility fields together. */
export function assignExecutorToolCatalog(
  carrier: ExecutorToolCatalogCarrier,
  catalog: ExecutorToolCatalog | undefined,
): void {
  if (!catalog) {
    delete carrier.executorToolCatalog;
    delete carrier.executorAllowedTools;
    delete carrier.executorInitialActiveTools;
    return;
  }
  const normalized = createExecutorToolCatalog(catalog.allowedToolCatalog, catalog.initialActiveTools);
  carrier.executorToolCatalog = {
    allowedToolCatalog: [...normalized.allowedToolCatalog],
    initialActiveTools: [...normalized.initialActiveTools],
  };
  carrier.executorAllowedTools = [...normalized.allowedToolCatalog];
  carrier.executorInitialActiveTools = [...normalized.initialActiveTools];
}

/** Normalize a record in place after creation or durable restoration. */
export function normalizeExecutorToolCatalog(carrier: ExecutorToolCatalogCarrier): ExecutorToolCatalog | undefined {
  const catalog = resolveExecutorToolCatalog(carrier);
  assignExecutorToolCatalog(carrier, catalog);
  return catalog;
}

export function executorToolCatalogsEqual(left: ExecutorToolCatalog, right: ExecutorToolCatalog): boolean {
  return left.allowedToolCatalog.length === right.allowedToolCatalog.length
    && left.initialActiveTools.length === right.initialActiveTools.length
    && left.allowedToolCatalog.every((name, index) => name === right.allowedToolCatalog[index])
    && left.initialActiveTools.every((name, index) => name === right.initialActiveTools[index]);
}
