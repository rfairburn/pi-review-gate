import {
  DEFERRED_TOOL_SEARCH_NAME,
  DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER,
  NATIVE_DISCOVERY_TOOLS,
  createExecutorToolCatalog,
  type ExecutorToolCatalog,
} from "./execution/tool-catalog";
import { RESEARCH_ALLOWED_TOOLS } from "./execution/tool";
import { GIT_READ_TOOL_NAME } from "./git-read/tool";
import { DEFAULT_OPERATING_MODE, type OperatingMode } from "./config";
import { renderAuthorizedToolInventory } from "./tool-inventory";
import { deferredToolSearchRenderResult } from "./deferred-tools-result-renderer";

const MAX_QUERY_CHARS = 256;

interface ToolMetadata {
  name: string;
  description: string;
}

interface DeferredToolHost {
  registerTool(tool: Record<string, unknown>): unknown;
  getActiveTools(): unknown;
  getAllTools(): unknown;
  setActiveTools(names: string[]): unknown;
}

interface AuthorizationBoundary {
  catalog: readonly ToolMetadata[];
  authorizedNames: ReadonlySet<string>;
  initialActiveNames: readonly string[];
}

interface SearchMatch extends ToolMetadata {
  tier: 0 | 1 | 2;
  matchCount: number;
}

/**
 * Read-only subtask observation controls retained in plan/research mode. The
 * planning visibility otherwise reuses the research role allow policy verbatim:
 * anything not explicitly read-only (write-capable tools, shell execution,
 * execution start/add/continue/steer/interrupt/force-merge/mark-clean) is
 * absent from the active set, the inventory, and search results.
 */
const PLANNING_OBSERVATION_TOOLS = new Set(["SubtasksInspect", "SubtasksWatch"]);

function planningToolVisible(name: string): boolean {
  return name === DEFERRED_TOOL_SEARCH_NAME
    || RESEARCH_ALLOWED_TOOLS.has(name)
    || PLANNING_OBSERVATION_TOOLS.has(name)
    // #73: GitRead is the structured read-only Git-history tool of the
    // plan/research role. It passes the planning visibility filter so a
    // mode switch can never unload it while the mode is applied; its
    // always-active (never deferred) behavior is owned by gitReadVisible.
    || name === GIT_READ_TOOL_NAME;
}

// Pi recreates ExtensionAPI wrappers when extension modules reload, while the
// sessionManager object remains stable for the AgentSession. Keep the registry
// itself process-scoped so it survives module cache replacement, but key each
// captured boundary by that session identity so concurrent AgentSessions
// cannot inherit one another's authorization.
const BOUNDARY_REGISTRY_KEY = Symbol.for("pi-review-gate.deferred-tool-authorization-boundaries.v2");

/**
 * Top-level Pi-native deferred activation. Authorization is captured exactly
 * once from the active tools, while getAllTools contributes metadata only.
 */
export class DeferredToolManager {
  private boundary: AuthorizationBoundary | undefined;
  private desiredActiveNames: string[] = [];
  private activeSetEstablished = false;
  private sessionDeferred = true;
  private registered = false;
  private lastSearchDescription: string | undefined;
  private lastSearchSnippet: string | undefined;
  constructor(
    private readonly pi: unknown,
    private readonly getOperatingMode: () => OperatingMode = () => DEFAULT_OPERATING_MODE,
  ) {}

  register(): boolean {
    if (this.registered || !isDeferredToolHost(this.pi)) return false;
    const definition = this.buildSearchToolDefinition();
    this.lastSearchDescription = definition.description;
    this.lastSearchSnippet = definition.promptSnippet;
    this.pi.registerTool(definition);
    this.registered = true;
    return true;
  }

  /** Capture authorization before the first shrink, or install a durable worker boundary. */
  sessionStart(
    sessionIdentity: unknown,
    configuredCatalog?: ExecutorToolCatalog,
    requireConfiguredCatalog = false,
    deferredEnabled = configuredCatalog === undefined
      || configuredCatalog.initialActiveTools.length < configuredCatalog.allowedToolCatalog.length,
  ): boolean {
    // Never retain a prior session's authority if this manager is reused and
    // the new hook does not provide a stable WeakMap-compatible identity.
    this.boundary = undefined;
    this.desiredActiveNames = [];
    this.activeSetEstablished = false;
    this.sessionDeferred = deferredEnabled;
    if (!isDeferredToolHost(this.pi)) return false;
    if (!isObjectIdentity(sessionIdentity)) return this.failClosed(this.pi);
    const registry = authorizationBoundaryRegistry();
    if (!registry) return this.failClosed(this.pi);
    const retained = registry.get(sessionIdentity);
    if (retained !== undefined && !isAuthorizationBoundary(retained)) return this.failClosed(this.pi);
    // Executor extension reloads reuse the session-keyed boundary after the
    // one-shot environment bootstrap has been scrubbed. A fresh executor with
    // no durable bootstrap must never capture the full launch-active set.
    if (!retained && requireConfiguredCatalog && configuredCatalog === undefined) {
      return this.failClosed(this.pi);
    }
    if (retained && configuredCatalog !== undefined && !configuredCatalogMatchesBoundary(configuredCatalog, retained)) {
      return this.failClosed(this.pi);
    }
    const configured = retained || configuredCatalog === undefined
      ? undefined
      : captureConfiguredAuthorizationBoundary(this.pi, configuredCatalog);
    if (!retained && configuredCatalog !== undefined && !configured) return this.failClosed(this.pi);
    const boundary = retained ?? configured ?? captureAuthorizationBoundary(this.pi);
    if (!retained) registry.set(sessionIdentity, boundary);
    this.boundary = boundary;
    this.desiredActiveNames = this.computeDesiredBase();
    this.activeSetEstablished = true;
    this.reapply();
    return true;
  }

  startupGuidance(): string | undefined {
    if (!this.boundary) return undefined;
    const discovery = this.deferredDiscoveryNames();
    if (discovery.size === 0) return undefined;
    const entries = this.boundary.catalog
      .filter((tool) => discovery.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description }));
    return renderAuthorizedToolInventory(entries, { deferred: this.sessionDeferred });
  }

  /**
   * #73 GitRead visibility, reasserted on every active-set write:
   *
   * - Top level: visible exactly while the operating mode is plan/research.
   *   It is never a baseline or deferred tool there — it is active from the
   *   first request in that mode (even with deferred tools enabled) and is
   *   neither active, inventoried, listed, nor searchable in any other mode.
   * - Worker runtimes: visible when the durable catalog admits it as
   *   initially active (Pi research workers). The worker's default role never
   *   hides it; execute-kind catalogs simply do not contain it. Catalogs that
   *   admit GitRead in the allowed ceiling without the initial subset are
   *   rejected fail-closed at capture, so an authorized GitRead can never be
   *   silently unusable.
   *
   * In neither case is GitRead a deferred discovery target: while visible it
   * is already active, and while invisible it must not be disclosed or
   * activatable at all (no stale name leakage across mode switches).
   */
  private gitReadVisible(): boolean {
    if (!this.boundary) return false;
    if (!this.boundary.authorizedNames.has(GIT_READ_TOOL_NAME)) return false;
    return this.getOperatingMode() === "plan-research"
      || this.boundary.initialActiveNames.includes(GIT_READ_TOOL_NAME);
  }

  /** Apply a local settings change immediately within the captured boundary. */
  setDeferredEnabled(enabled: boolean): boolean {
    if (!this.boundary || !isDeferredToolHost(this.pi)) return false;
    if (this.sessionDeferred === enabled) {
      this.reapply();
      return true;
    }
    this.sessionDeferred = enabled;
    this.desiredActiveNames = this.computeDesiredBase();
    this.reapply();
    return true;
  }

  private computeDesiredBase(): string[] {
    return [
      ...(this.sessionDeferred ? this.boundary!.initialActiveNames : [...this.boundary!.authorizedNames]),
      DEFERRED_TOOL_SEARCH_NAME,
    ];
  }

  /** Reassert the manager-owned active set after another component syncs. */
  reapply(): void {
    if (!this.activeSetEstablished || !isDeferredToolHost(this.pi)) return;
    this.syncSearchToolDescription();
    const planning = this.getOperatingMode() === "plan-research";
    let names = planning
      ? this.desiredActiveNames.filter(planningToolVisible)
      : [...this.desiredActiveNames];
    // #73: GitRead is mode/catalog-pinned, not baseline. Add it while visible
    // (so deferred-on plan/research and catalog-initial research workers keep
    // it active from the first request) and remove it everywhere else so a
    // prior activation or full-active desired set can never leak it into a
    // mode that does not expose it.
    if (this.gitReadVisible()) {
      if (!names.includes(GIT_READ_TOOL_NAME)) names.push(GIT_READ_TOOL_NAME);
    } else {
      names = names.filter((name) => name !== GIT_READ_TOOL_NAME);
    }
    this.pi.setActiveTools(names);
  }

  /** Names visible at the live mode ceiling (authority boundary, not activation). */
  private modeVisibleAuthorizedNames(): ReadonlySet<string> {
    if (!this.boundary) return new Set<string>();
    const planning = this.getOperatingMode() === "plan-research";
    const visible = planning
      ? [...this.boundary.authorizedNames].filter((name) => planningToolVisible(name))
      : [...this.boundary.authorizedNames];
    // #73: an invisible GitRead is not part of the live ceiling at all — it
    // must not reach the startup inventory, the search_tools description,
    // or any match result outside the modes/roles that expose it.
    if (!this.gitReadVisible()) {
      return new Set(visible.filter((name) => name !== GIT_READ_TOOL_NAME));
    }
    return new Set(visible);
  }

  /**
   * Stable deferred discovery set: the authorized catalog at the live
   * permission ceiling minus the role's baseline automatically-loaded tools
   * (search_tools itself is baseline and excluded). Derived from the captured
   * boundary's frozen initialActiveNames — never from mutable activation
   * state — so search activations cannot change startup guidance or the
   * search_tools description (no needless prompt-cache invalidation). Only
   * role/mode/permission boundary changes recompute this set.
   */
  private deferredDiscoveryNames(): ReadonlySet<string> {
    if (!this.boundary || !this.sessionDeferred) return new Set<string>();
    const baseline = new Set(this.boundary.initialActiveNames);
    // #73: a visible GitRead is active from the first request, so it is
    // excluded from the deferred discovery set exactly like baseline tools —
    // the inventory and search description never promise an activation step
    // that cannot happen.
    if (this.gitReadVisible()) baseline.add(GIT_READ_TOOL_NAME);
    return new Set([...this.modeVisibleAuthorizedNames()].filter((name) => !baseline.has(name)));
  }

  /**
   * The search_tools description must itself disclose the deferred discovery
   * set — compact comma-delimited names only, never per-name usage prose —
   * filtered by the live operating-mode permission and excluding the
   * baseline-loaded tools. It is byte-identical across search activations;
   * before a boundary is captured (or when startup failed closed) it lists
   * no names, so it can never disclose an unauthorized or stale set.
   */
  private renderSearchToolDescription(): string {
    const base = "Activate authorized tools. If names are known, query only exact tool names; otherwise use capability terms. Loading never performs the operation.";
    if (!this.boundary) return base;
    const names = [...this.deferredDiscoveryNames()].sort(compareToolNames);
    return names.length === 0 ? base : `${base} Authorized tool names: ${names.join(", ")}.`;
  }

  private renderSearchToolSnippet(): string {
    const rules = "Search only exact tool names when known, without descriptive words; use capability terms only for unknown names. Call the loaded tool next turn.";
    // The system-prompt inventory exists only when a boundary is captured and
    // a stable discovery set remains after baseline exclusion. Deferred-off
    // and fail-closed sessions must not be promised an inventory that is not
    // injected.
    if (!this.boundary || this.deferredDiscoveryNames().size === 0) {
      return `No system-prompt inventory is provided; search_tools only activates authorized tools. ${rules}`;
    }
    return `Authorized names are listed in the system prompt. ${rules}`;
  }

  private buildSearchToolDefinition() {
    return {
      name: DEFERRED_TOOL_SEARCH_NAME,
      label: DEFERRED_TOOL_SEARCH_NAME,
      description: this.renderSearchToolDescription(),
      promptSnippet: this.renderSearchToolSnippet(),
      executionMode: "sequential" as const,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUERY_CHARS,
            description: "Known: exact tool name(s) only. Unknown: capability terms. Never mix known names with descriptive words.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      renderResult: deferredToolSearchRenderResult,
      execute: async (_toolCallId: string, params: unknown) => this.search(params),
    };
  }

  /**
   * Re-register search_tools only when the rendered description or snippet
   * changed (mode switch, deferred toggle, or first boundary capture).
   * Same-name registerTool replacement is the documented Pi override path; no
   * invented host API. Registration is metadata only — authority stays with
   * reapply's active-set write.
   */
  private syncSearchToolDescription(): void {
    if (!this.registered || !isDeferredToolHost(this.pi)) return;
    const description = this.renderSearchToolDescription();
    const snippet = this.renderSearchToolSnippet();
    if (this.lastSearchDescription === description && this.lastSearchSnippet === snippet) return;
    this.lastSearchDescription = description;
    this.lastSearchSnippet = snippet;
    this.pi.registerTool(this.buildSearchToolDefinition());
  }

  /** Full launch-authorized parent catalog; worker activation remains unchanged. */
  authorizedToolNames(): string[] | undefined {
    return this.boundary ? [...this.boundary.authorizedNames] : undefined;
  }

  private failClosed(pi: DeferredToolHost): false {
    let active: unknown = [];
    try {
      active = pi.getActiveTools();
    } catch {
      // If the host cannot disclose authorization, no tool name is trusted.
    }
    const activeNames = new Set(normalizedActiveNames(active));
    this.desiredActiveNames = DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER.filter((name) => activeNames.has(name));
    this.activeSetEstablished = true;
    this.reapply();
    return false;
  }

  private search(params: unknown): Record<string, unknown> {
    if (!this.boundary || !isDeferredToolHost(this.pi)) {
      return textResult("Tool search is unavailable until session startup completes.", true, {
        outcome: "unavailable",
      });
    }
    // Reassert the captured boundary on every loader call. Pi activates newly
    // registered tools by default in some configurations; registration after
    // capture is metadata, never authority.
    this.reapply();
    const query = searchQuery(params);
    if (!query) {
      return textResult(`Invalid search_tools request: query must contain 1-${MAX_QUERY_CHARS} characters.`, true, {
        outcome: "invalid",
      });
    }
    const terms = searchTerms(query);
    if (terms.length === 0) {
      return textResult("Invalid search_tools request: query must contain searchable terms.", true, {
        outcome: "invalid",
      });
    }

    // Planning mode makes forbidden tools absent from discovery as well: they
    // cannot be matched, reported, or activated while the mode is applied.
    // #73: GitRead follows its own visibility rule in every mode — searchable
    // (and already active) where visible, and unmatchable everywhere else so
    // search can never activate it outside plan/research or a research catalog.
    const planning = this.getOperatingMode() === "plan-research";
    const catalog = this.boundary.catalog.filter((tool) => {
      if (tool.name === GIT_READ_TOOL_NAME) return this.gitReadVisible();
      return planning ? planningToolVisible(tool.name) : true;
    });
    const matches = catalog
      .map((tool) => matchTool(tool, query, terms))
      .filter((match): match is SearchMatch => match !== undefined)
      .sort((left, right) =>
        left.tier - right.tier
        || right.matchCount - left.matchCount
        || compareNames(left.name, right.name)
      );
    // Activate only the strongest match tier. Exact tool names outrank all
    // descriptive terms; otherwise tools matching the most name terms outrank
    // description-only matches. This keeps match-any discovery useful without
    // activating every tool that shares one generic word.
    const selected = matches.length === 0
      ? []
      : matches.filter((match) =>
        match.tier === matches[0]!.tier && match.matchCount === matches[0]!.matchCount
      );
    if (selected.length === 0) {
      return textResult("No authorized tools matched. No tools were activated.", false, {
        activated: [],
        matched: [],
        alreadyActive: [],
        outcome: "no-match",
      });
    }

    const active = new Set(this.desiredActiveNames);
    // #73: a visible GitRead is host-active by the mode/catalog pin, not by
    // search activation; report it as already active instead of mutating the
    // desired set with a no-op "activation".
    if (this.gitReadVisible()) active.add(GIT_READ_TOOL_NAME);
    const activated: string[] = [];
    const alreadyActive: string[] = [];
    for (const match of selected) {
      // The catalog is already authorization-filtered. Keep this explicit
      // guard so a future catalog refactor cannot turn metadata into authority.
      if (!this.boundary.authorizedNames.has(match.name)) continue;
      if (active.has(match.name)) {
        alreadyActive.push(match.name);
        continue;
      }
      active.add(match.name);
      this.desiredActiveNames.push(match.name);
      activated.push(match.name);
    }
    this.reapply();

    const matchedNames = selected.map((match) => match.name);
    const status = activated.length > 0
      ? `Activated: ${activated.join(", ")}. Call the required tool on the next turn; search_tools did not perform the operation.`
      : "All matched authorized tools were already active. search_tools did not perform the operation.";
    return textResult([
      `Matched authorized tools: ${matchedNames.join(", ")}.`,
      status,
    ].join("\n"), false, {
      activated,
      alreadyActive,
      matched: matchedNames,
      omitted: 0,
      outcome: activated.length > 0 ? "activated" : "already-active",
    });
  }
}

function authorizationBoundaryRegistry(): WeakMap<object, AuthorizationBoundary> | undefined {
  const processState = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = processState[BOUNDARY_REGISTRY_KEY];
  if (existing instanceof WeakMap) {
    return existing as WeakMap<object, AuthorizationBoundary>;
  }
  if (existing !== undefined) return undefined;
  const registry = new WeakMap<object, AuthorizationBoundary>();
  try {
    Object.defineProperty(processState, BOUNDARY_REGISTRY_KEY, {
      value: registry,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    return undefined;
  }
  return registry;
}

function isObjectIdentity(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isAuthorizationBoundary(value: unknown): value is AuthorizationBoundary {
  return isRecord(value)
    && Array.isArray(value.catalog)
    && value.authorizedNames instanceof Set
    && Array.isArray(value.initialActiveNames);
}

function captureAuthorizationBoundary(pi: DeferredToolHost): AuthorizationBoundary {
  const active = normalizedActiveNames(pi.getActiveTools());
  const authorizedNames = new Set(active.filter((name) => name !== DEFERRED_TOOL_SEARCH_NAME));
  const metadata = toolMetadata(pi.getAllTools());
  const metadataByName = new Map(metadata.map((tool) => [tool.name, tool]));
  // Pi registers native discovery even when initially inactive. Its registry
  // already excludes tools withheld by --tools/--exclude-tools/--no-tools.
  for (const name of NATIVE_DISCOVERY_TOOLS) {
    if (metadataByName.has(name)) authorizedNames.add(name);
  }
  // #73: GitRead is an extension-registered tool. Whenever the host registry
  // carries it (an explicit --tools exclusion removes it from the registry
  // and stays authoritative), the top-level boundary authorizes it; its
  // activity is then pinned to plan/research by gitReadVisible, never to the
  // baseline below.
  if (metadataByName.has(GIT_READ_TOOL_NAME)) authorizedNames.add(GIT_READ_TOOL_NAME);
  const catalog = [...authorizedNames]
    .map((name) => metadataByName.get(name) ?? { name, description: "" })
    .sort((left, right) => compareNames(left.name, right.name));
  // #73: top-level baseline excludes GitRead on purpose — it is mode-pinned
  // (active in plan/research only), while the same ORDER entry still makes it
  // part of durable research-worker initial-active catalogs.
  const initialActiveNames = DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER
    .filter((name) => name !== GIT_READ_TOOL_NAME)
    .filter((name) => authorizedNames.has(name));
  return createAuthorizationBoundary(catalog, authorizedNames, initialActiveNames);
}

function captureConfiguredAuthorizationBoundary(
  pi: DeferredToolHost,
  configuredCatalog: ExecutorToolCatalog,
): AuthorizationBoundary | undefined {
  let normalized: ExecutorToolCatalog;
  try {
    normalized = createExecutorToolCatalog(
      configuredCatalog.allowedToolCatalog,
      configuredCatalog.initialActiveTools,
    );
  } catch {
    return undefined;
  }
  if (
    normalized.allowedToolCatalog.includes(DEFERRED_TOOL_SEARCH_NAME)
    || normalized.initialActiveTools.includes(DEFERRED_TOOL_SEARCH_NAME)
  ) return undefined;
  // #73: a durable catalog that admits GitRead in the allowed ceiling must also
  // place it in the initial subset. Worker visibility keys on the initial set,
  // so a contradictory shape would make an authorized tool neither active nor
  // discoverable — machine-generated catalogs always satisfy this, and anything
  // else is rejected fail-closed rather than silently hiding authority.
  if (normalized.allowedToolCatalog.includes(GIT_READ_TOOL_NAME)
    && !normalized.initialActiveTools.includes(GIT_READ_TOOL_NAME)) {
    return undefined;
  }

  const launchActive = new Set(normalizedActiveNames(pi.getActiveTools()));
  if (!launchActive.has(DEFERRED_TOOL_SEARCH_NAME)) return undefined;
  const metadata = toolMetadata(pi.getAllTools());
  const metadataByName = new Map(metadata.map((tool) => [tool.name, tool]));
  if (normalized.allowedToolCatalog.some((name) => !launchActive.has(name) || !metadataByName.has(name))) {
    return undefined;
  }
  const authorizedNames = new Set(normalized.allowedToolCatalog);
  const catalog = normalized.allowedToolCatalog
    .map((name) => metadataByName.get(name)!)
    .sort((left, right) => compareNames(left.name, right.name));
  return createAuthorizationBoundary(catalog, authorizedNames, normalized.initialActiveTools);
}

function createAuthorizationBoundary(
  catalog: readonly ToolMetadata[],
  authorizedNames: ReadonlySet<string>,
  initialActiveNames: readonly string[],
): AuthorizationBoundary {
  return {
    catalog: Object.freeze(catalog.map((tool) => Object.freeze({ ...tool }))),
    authorizedNames: new Set(authorizedNames),
    initialActiveNames: Object.freeze([...initialActiveNames]),
  };
}

function configuredCatalogMatchesBoundary(
  configuredCatalog: ExecutorToolCatalog,
  boundary: AuthorizationBoundary,
): boolean {
  try {
    const normalized = createExecutorToolCatalog(
      configuredCatalog.allowedToolCatalog,
      configuredCatalog.initialActiveTools,
    );
    return !normalized.allowedToolCatalog.includes(DEFERRED_TOOL_SEARCH_NAME)
      && boundary.authorizedNames.size === normalized.allowedToolCatalog.length
      && normalized.allowedToolCatalog.every((name) => boundary.authorizedNames.has(name))
      && boundary.initialActiveNames.length === normalized.initialActiveTools.length
      && boundary.initialActiveNames.every((name, index) => name === normalized.initialActiveTools[index]);
  } catch {
    return false;
  }
}

function normalizedActiveNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function toolMetadata(value: unknown): ToolMetadata[] {
  if (!Array.isArray(value)) return [];
  const result: ToolMetadata[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const name = item.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      description: typeof item.description === "string" ? item.description : "",
    });
  }
  return result;
}

function matchTool(tool: ToolMetadata, query: string, terms: readonly string[]): SearchMatch | undefined {
  const name = tool.name.toLocaleLowerCase("en-US");
  const description = tool.description.toLocaleLowerCase("en-US");
  const nameTerms = splitToolName(tool.name);
  if (name === query || terms.includes(name)) return { ...tool, tier: 0, matchCount: 1 };

  const nameMatches = terms.filter((term) =>
    nameTerms.some((nameTerm) => nameTerm.includes(term))
  ).length;
  if (nameMatches > 0) return { ...tool, tier: 1, matchCount: nameMatches };

  const descriptionMatches = terms.filter((term) => description.includes(term)).length;
  if (descriptionMatches === 0) return undefined;
  return { ...tool, tier: 2, matchCount: descriptionMatches };
}

function splitToolName(name: string): string[] {
  return name
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function searchQuery(params: unknown): string | undefined {
  if (!isRecord(params) || typeof params.query !== "string") return undefined;
  const query = params.query.trim().toLocaleLowerCase("en-US");
  return query && query.length <= MAX_QUERY_CHARS ? query : undefined;
}

function searchTerms(query: string): string[] {
  return [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

function textResult(text: string, isError: boolean, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { content: [{ type: "text", text }], details, isError };
}

function compareToolNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDeferredToolHost(value: unknown): value is DeferredToolHost {
  return isRecord(value)
    && typeof value.registerTool === "function"
    && typeof value.getActiveTools === "function"
    && typeof value.getAllTools === "function"
    && typeof value.setActiveTools === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
