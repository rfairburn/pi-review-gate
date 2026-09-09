/**
 * Durable tool authorization and activation contract for executor tasks.
 *
 * `allowedToolCatalog` is the complete set a child may load. The
 * `initialActiveTools` is the startup-visible subset used by Pi-native
 * workers. Keeping the two values in one validated contract prevents a
 * restored or retried task from widening authorization.
 */
export const EXECUTOR_TOOL_CATALOG_ENV = "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG";
export const DEFERRED_TOOL_SEARCH_NAME = "search_tools";
export const DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER = [
  "read", "bash", "edit", "ApplyPatch", "SubtasksStart",
] as const;

export interface ExecutorToolCatalog {
  allowedToolCatalog: string[];
  initialActiveTools: string[];
}

/** Records that carry the durable catalog contract (task and operation records). */
export interface ExecutorToolCatalogCarrier {
  executorToolCatalog?: ExecutorToolCatalog;
}

/**
 * Pre-cutover compatibility fields. They are never read, written, compared,
 * or migrated; their presence without the canonical contract marks an
 * unsupported old-format record or request.
 */
const LEGACY_RECORD_CATALOG_FIELDS = ["executorAllowedTools", "executorInitialActiveTools"] as const;
const LEGACY_REQUEST_CATALOG_FIELDS = ["allowedTools", "initialActiveTools"] as const;

function hasAnyField(value: object, fields: readonly string[]): boolean {
  return fields.some((field) => (value as Record<string, unknown>)[field] !== undefined);
}

function hasLegacyCatalogFields(carrier: object): boolean {
  return hasAnyField(carrier, LEGACY_RECORD_CATALOG_FIELDS);
}

/**
 * Reject executor requests that carry pre-cutover compatibility fields
 * without the canonical contract. A valid canonical catalog takes precedence
 * and stale copies are ignored; genuinely catalog-free requests remain
 * legitimate for adapters without a native allowlist surface.
 */
export function rejectPreCutoverRequestFields(request: ExecutorToolCatalogCarrier): void {
  if (request.executorToolCatalog === undefined && hasAnyField(request, LEGACY_REQUEST_CATALOG_FIELDS)) {
    throw new Error(
      "Unsupported pre-cutover executor request: the request carries legacy allowedTools/initialActiveTools fields without the canonical executorToolCatalog contract.",
    );
  }
}

/**
 * Remove pre-cutover compatibility keys from a newly created record so fresh
 * durable data never carries mirrors. Restoration paths deliberately do not
 * call this: existing doubled records are consumed, not rewritten.
 */
export function stripLegacyCatalogFields(carrier: object): void {
  for (const field of LEGACY_RECORD_CATALOG_FIELDS) {
    delete (carrier as Record<string, unknown>)[field];
  }
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

/** Conservative startup subset for newly delegated deferred-tool workers. */
export function defaultExecutorInitialActiveTools(allowedToolCatalog: readonly string[]): string[] {
  const allowed = new Set(normalizeToolNames(allowedToolCatalog, "allowed tool catalog"));
  return DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER.filter((name) => allowed.has(name));
}

/**
 * Derive the Pi executor-role catalog from the durable parent-authorized
 * contract. Subtasks* controls belong only to the top-level orchestrator; the
 * executor extension deliberately does not register recursive delegation.
 * External adapters continue consuming the unmodified durable catalog.
 */
export function createPiWorkerToolCatalog(catalog: ExecutorToolCatalog): ExecutorToolCatalog {
  const normalized = createExecutorToolCatalog(catalog.allowedToolCatalog, catalog.initialActiveTools);
  const allowedToolCatalog = normalized.allowedToolCatalog.filter((name) => !name.startsWith("Subtasks"));
  const allowed = new Set(allowedToolCatalog);
  return createExecutorToolCatalog(
    allowedToolCatalog,
    normalized.initialActiveTools.filter((name) => allowed.has(name)),
  );
}

/** Build the canonical contract, defaulting to full-active when no initial set is given. */
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
 * Read the canonical catalog from a persisted record.
 *
 * Doubled records consume the validated canonical contract and ignore any
 * stale pre-cutover copies without migration or rewrite-on-read. Records
 * carrying only pre-cutover fields are unsupported old-format catalogs and
 * fail explicitly instead of restoring historical full-active behavior;
 * records with no catalog fields at all remain legitimate no-catalog
 * contexts for callers that do not require one.
 */
export function resolveExecutorToolCatalog(carrier: ExecutorToolCatalogCarrier): ExecutorToolCatalog | undefined {
  const canonical = carrier.executorToolCatalog;
  if (canonical !== undefined) {
    if (!canonical || !Array.isArray(canonical.allowedToolCatalog) || !Array.isArray(canonical.initialActiveTools)) {
      throw new Error("Invalid executor tool catalog: both allowed and initial tool sets are required.");
    }
    return createExecutorToolCatalog(canonical.allowedToolCatalog, canonical.initialActiveTools);
  }
  if (hasLegacyCatalogFields(carrier)) {
    throw new Error(
      "Unsupported pre-cutover executor tool catalog: the record carries legacy executorAllowedTools/executorInitialActiveTools fields without the canonical executorToolCatalog contract.",
    );
  }
  return undefined;
}

/** Persist the canonical contract only; records never carry compatibility mirrors. */
export function assignExecutorToolCatalog(
  carrier: ExecutorToolCatalogCarrier,
  catalog: ExecutorToolCatalog | undefined,
): void {
  if (!catalog) {
    delete carrier.executorToolCatalog;
    return;
  }
  const normalized = createExecutorToolCatalog(catalog.allowedToolCatalog, catalog.initialActiveTools);
  carrier.executorToolCatalog = {
    allowedToolCatalog: [...normalized.allowedToolCatalog],
    initialActiveTools: [...normalized.initialActiveTools],
  };
}

/** Validate a record's canonical catalog in place after creation or durable restoration. */
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
