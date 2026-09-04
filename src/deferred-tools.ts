import {
  DEFERRED_TOOL_SEARCH_NAME,
  DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER,
  createExecutorToolCatalog,
  type ExecutorToolCatalog,
} from "./execution/tool-catalog";
import { renderAuthorizedToolInventory } from "./tool-inventory";

const MAX_QUERY_CHARS = 256;
const MAX_QUERY_TERMS = 12;
const MAX_MATCHES = 8;

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
  rank: number;
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

  constructor(private readonly pi: unknown) {}

  register(): boolean {
    if (this.registered || !isDeferredToolHost(this.pi)) return false;
    this.pi.registerTool({
      name: DEFERRED_TOOL_SEARCH_NAME,
      label: DEFERRED_TOOL_SEARCH_NAME,
      description: "Find authorized tools by name or description and activate matching tools for the next model request. This only loads tools; it never performs the requested operation.",
      promptSnippet: "Use search_tools when a needed authorized tool is not currently available, then call the newly loaded tool on the next turn.",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: MAX_QUERY_CHARS,
            description: "Terms describing the tool needed. Matches captured authorized tool names and descriptions only.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: unknown) => this.search(params),
    });
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
    this.desiredActiveNames = [
      ...(this.sessionDeferred ? boundary.initialActiveNames : boundary.authorizedNames),
      DEFERRED_TOOL_SEARCH_NAME,
    ];
    this.pi.setActiveTools([...this.desiredActiveNames]);
    this.activeSetEstablished = true;
    return true;
  }

  startupGuidance(): string | undefined {
    if (!this.boundary) return undefined;
    return renderAuthorizedToolInventory(
      [...this.boundary.authorizedNames, DEFERRED_TOOL_SEARCH_NAME],
      { deferred: this.sessionDeferred },
    );
  }

  /** Apply a local settings change immediately within the captured boundary. */
  setDeferredEnabled(enabled: boolean): boolean {
    if (!this.boundary || !isDeferredToolHost(this.pi)) return false;
    if (this.sessionDeferred === enabled) {
      this.reapply();
      return true;
    }
    this.sessionDeferred = enabled;
    this.desiredActiveNames = [
      ...(enabled ? this.boundary.initialActiveNames : this.boundary.authorizedNames),
      DEFERRED_TOOL_SEARCH_NAME,
    ];
    this.pi.setActiveTools([...this.desiredActiveNames]);
    this.activeSetEstablished = true;
    return true;
  }

  /** Reassert the manager-owned active set after another component syncs. */
  reapply(): void {
    if (!this.activeSetEstablished || !isDeferredToolHost(this.pi)) return;
    this.pi.setActiveTools([...this.desiredActiveNames]);
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
    pi.setActiveTools([...this.desiredActiveNames]);
    this.activeSetEstablished = true;
    return false;
  }

  private search(params: unknown): Record<string, unknown> {
    if (!this.boundary || !isDeferredToolHost(this.pi)) {
      return textResult("Tool search is unavailable until session startup completes.", true);
    }
    // Reassert the captured boundary on every loader call. Pi activates newly
    // registered tools by default in some configurations; registration after
    // capture is metadata, never authority.
    this.pi.setActiveTools([...this.desiredActiveNames]);
    const query = searchQuery(params);
    if (!query) {
      return textResult(`Invalid search_tools request: query must contain 1-${MAX_QUERY_CHARS} characters.`, true);
    }
    const terms = searchTerms(query);
    if (terms.length === 0 || terms.length > MAX_QUERY_TERMS) {
      return textResult(`Invalid search_tools request: query must contain at most ${MAX_QUERY_TERMS} searchable terms.`, true);
    }

    const matches = this.boundary.catalog
      .map((tool) => matchTool(tool, query, terms))
      .filter((match): match is SearchMatch => match !== undefined)
      .sort((left, right) => left.rank - right.rank || compareNames(left.name, right.name));
    // Activate only the strongest match tier. Exact tool names outrank all
    // descriptive terms; otherwise tools matching the most name terms outrank
    // description-only matches. This keeps match-any discovery useful without
    // activating every tool that shares one generic word.
    const preferred = matches.length === 0
      ? []
      : matches.filter((match) => match.rank === matches[0]!.rank);
    const selected = preferred.slice(0, MAX_MATCHES);
    if (selected.length === 0) {
      return textResult("No authorized tools matched. No tools were activated.", false, {
        activated: [],
        matched: [],
      });
    }

    const active = new Set(this.desiredActiveNames);
    const activated: string[] = [];
    for (const match of selected) {
      // The catalog is already authorization-filtered. Keep this explicit
      // guard so a future catalog refactor cannot turn metadata into authority.
      if (!this.boundary.authorizedNames.has(match.name) || active.has(match.name)) continue;
      active.add(match.name);
      this.desiredActiveNames.push(match.name);
      activated.push(match.name);
    }
    this.pi.setActiveTools([...this.desiredActiveNames]);

    const matchedNames = selected.map((match) => match.name);
    const omitted = preferred.length - selected.length;
    const status = activated.length > 0
      ? `Activated: ${activated.join(", ")}. Call the required tool on the next turn; search_tools did not perform the operation.`
      : "All matched authorized tools were already active. search_tools did not perform the operation.";
    return textResult([
      `Matched authorized tools: ${matchedNames.join(", ")}.${omitted > 0 ? ` ${omitted} additional match(es) omitted by the ${MAX_MATCHES}-result limit.` : ""}`,
      status,
    ].join("\n"), false, {
      activated,
      matched: matchedNames,
      omitted,
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
  const catalog = [...authorizedNames]
    .map((name) => metadataByName.get(name) ?? { name, description: "" })
    .sort((left, right) => compareNames(left.name, right.name));
  const initialActiveNames = DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER.filter((name) => authorizedNames.has(name));
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
  if (name === query || terms.includes(name)) return { ...tool, rank: 0 };

  const nameMatches = terms.filter((term) =>
    nameTerms.some((nameTerm) => nameTerm.includes(term))
  ).length;
  if (nameMatches > 0) return { ...tool, rank: 100 - nameMatches };

  const descriptionMatches = terms.filter((term) => description.includes(term)).length;
  if (descriptionMatches === 0) return undefined;
  return { ...tool, rank: 200 - descriptionMatches };
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
