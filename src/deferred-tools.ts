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

/**
 * Native Pi tool that runs codemode scripts (Pi 1.0 `builtin:codemode`).
 * Issue #224: the wrapper can opt in to a registered-but-inactive codemode as
 * an authorized, discoverable tool via the manager constructor flag.
 * The ordinary toggle requires tool_search when deferred tools are on and
 * selects permitted tools normally when off. Plan/research disables it;
 * the wrapper default never overrides an explicit
 * native registry restriction, and no builtin is ever re-registered by this
 * extension.
 */
export const CODEMODE_TOOL_NAME = "codemode";

/**
 * Canonical ToolExposure values Pi 1.0 reports in `getAllTools()` metadata.
 * `codemode-deferred` is a documented alias carried over from MCP server
 * configuration; the registry itself resolves it to `codemode`.
 */
const TOOL_EXPOSURES = new Set(["direct", "model-only", "codemode", "deferred", "hidden"]);
/**
 * Exposures Pi keeps callable from `ctx.executeTool()` while the tool is
 * inactive: codemode scripts may call a registered `codemode` or `deferred`
 * tool without it ever being declared to the model (`direct` tools stay
 * callable from scripts only while active; `model-only` and `hidden` are
 * never callable from scripts).
 */
const NATIVE_CALLABLE_EXPOSURES = new Set(["codemode", "deferred"]);
const NATIVE_MCP_RESOURCE_HELPER_NAMES = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

interface ToolMetadata {
  name: string;
  description: string;
  /** Resolved native exposure; "direct" is the registry default. */
  exposure: string;
}

interface DeferredToolHost {
  registerTool(tool: Record<string, unknown>): unknown;
  getActiveTools(): unknown;
  getAllTools(): unknown;
  setActiveTools(names: string[]): unknown;
}

interface RegistryRead {
  /** True: Pi answered (an empty answer is a valid, authoritative read). False: the registry is unreadable. */
  ok: boolean;
  metadata: ToolMetadata[];
}

function readRegistryMetadata(pi: DeferredToolHost): RegistryRead {
  try {
    return { ok: true, metadata: toolMetadata(pi.getAllTools()) };
  } catch {
    // An unreadable registry discloses nothing; callers fail closed while
    // retaining the captured state for recovery.
    return { ok: false, metadata: [] };
  }
}

interface AuthorizationBoundary {
  /** Metadata for the live-visible authorized tools (reconciled registry intersection). */
  catalog: readonly ToolMetadata[];
  /**
   * Dynamic (top-level): the current host-derived authority; reconciled live so
   * late registrations join and removed/hidden/withdrawn ones leave. Frozen
   * (configured worker): the immutable `allowedToolCatalog` ceiling, never
   * expanded, never mutated.
   */
  authorizedNames: ReadonlySet<string>;
  /** Frozen initial-active baseline for the role (top-level conservative subset / worker durable subset). */
  initialActiveNames: readonly string[];
  /** True: dynamic host authority reconciled live. False: frozen worker ceiling. */
  dynamic: boolean;
  /** Captured wrapper default intent (#224 codemode). Sticky across reloads. */
  codemodeDefault: boolean;
  /** Registry names present at the first authoritative capture; launch exclusions stay excluded. */
  registryBaselineNames: ReadonlySet<string>;
  /** False only when top-level capture happened while the host registry was unreadable. */
  registryBaselineCaptured: boolean;
  /**
   * Last successful full registry snapshot (name + resolved exposure) and
   * the exposure lookup for the loader's own live gate. Preserved across
   * unreadable reads for recovery.
   */
  registryEntries: ReadonlyMap<string, ToolMetadata>;
  /** Names withdrawn after capture, plus hidden canonical native MCP names whose later Pi exposure change may grant dynamic authority. */
  withdrawnNames: ReadonlySet<string>;
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

/**
 * MCP tools are all off for plan/research (#224): no exposure class, native
 * deferred reachability, or annotation marks an MCP tool read-only, and
 * research never gains an MCP opt-in through the manager. The documented
 * `mcp__<server>__<tool>` registration prefix is the stable registry surface.
 */
function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

function planningToolVisible(name: string): boolean {
  if (isMcpToolName(name)) return false;
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
// cannot inherit one another's authorization. v4: the boundary shape gained
// a stable registry baseline so temporary disappearance/outages cannot turn
// ordinary capture-time exclusions into late registrations; only an explicit
// hidden-to-visible canonical native MCP exposure transition is also adopted.
// Old-shape retained boundaries fail closed instead of being reinterpreted.
const BOUNDARY_REGISTRY_KEY = Symbol.for("pi-review-gate.deferred-tool-authorization-boundaries.v4");

/**
 * Top-level Pi-native deferred activation. Authorization is captured once from
 * the launch-active set plus the registry's native-callable exposures, while
 * getAllTools contributes metadata only. Top-level (dynamic) boundaries
 * reconcile against the live registry afterward: Pi-permitted tools registered
 * after capture become authorized and discoverable, and removed, hidden, or
 * withdrawn entries disappear from discovery and lose activation. Configured
 * worker (frozen) boundaries remain an immutable ceiling: the live visible set
 * is its intersection with the current registry, so initially unavailable
 * (late MCP) ceiling names stay retained but only become usable once the
 * registry actually provides them.
 *
 * #279: this manager's loader is registered under Pi's replaceable builtin
 * name `tool_search`, so the native tool-search extension is not loaded and
 * there is no second discovery/declaration owner. Every authorized match —
 * including codemode/deferred-exposure and MCP tools — is declared for the
 * next model call by this loader; native script callability of those exposures
 * is unchanged.
 */
export class DeferredToolManager {
  private boundary: AuthorizationBoundary | undefined;
  private sessionIdentity: object | undefined;
  private desiredActiveNames: string[] = [];
  /**
   * Names this loader explicitly activated in the current incarnation (#279).
   * Kept separate from the full desired list so a deferred-mode transition
   * retains only deliberate search activations, never the previous mode's
   * whole base set.
   */
  private loaderSelectionNames: string[] = [];
  private failClosedAuthorized: ReadonlySet<string> | undefined;
  private registryUnreadable = false;
  private activeSetEstablished = false;
  private sessionDeferred = true;
  private registered = false;
  private lastSearchDescription: string | undefined;
  private lastSearchSnippet: string | undefined;
  constructor(
    private readonly pi: unknown,
    private readonly getOperatingMode: () => OperatingMode = () => DEFAULT_OPERATING_MODE,
    // #224 wrapper default: when true, an inactive registered codemode joins
    // the top-level authorization and discovery sets. The ordinary toggle
    // controls selection: tool_search when on, normal loading when off. Only for
    // wrapper-launched sessions (the parent passes the captured
    // PI_REVIEW_GATE_CODEMODE_DEFAULT=1 flag); never applied to configured
    // worker ceilings and never overriding explicit registry restrictions.
    private readonly enableCodemodeDefault = false,
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
    this.sessionIdentity = undefined;
    this.desiredActiveNames = [];
    this.loaderSelectionNames = [];
    this.failClosedAuthorized = undefined;
    this.registryUnreadable = false;
    this.activeSetEstablished = false;
    this.sessionDeferred = deferredEnabled;
    if (!isDeferredToolHost(this.pi)) return false;
    if (!isObjectIdentity(sessionIdentity)) return this.failClosed(this.pi);
    const registry = authorizationBoundaryRegistry();
    if (!registry) return this.failClosed(this.pi);
    const retained = registry.get(sessionIdentity);
    if (retained !== undefined && !isAuthorizationBoundary(retained)) return this.failClosed(this.pi);
    // Executor reloads may reuse a retained frozen worker boundary after the
    // one-shot environment bootstrap has been scrubbed. A missing or dynamic
    // host boundary is not a worker ceiling and must never authorize one.
    if (requireConfiguredCatalog && configuredCatalog === undefined && (!retained || retained.dynamic)) {
      return this.failClosed(this.pi);
    }
    if (retained && configuredCatalog !== undefined && !configuredCatalogMatchesBoundary(configuredCatalog, retained)) {
      return this.failClosed(this.pi);
    }
    const configured = retained || configuredCatalog === undefined
      ? undefined
      : captureConfiguredAuthorizationBoundary(this.pi, configuredCatalog, this.enableCodemodeDefault);
    if (!retained && configuredCatalog !== undefined && !configured) return this.failClosed(this.pi);
    // Sticky wrapper default (#224): a retained boundary keeps its previously
    // captured intent — a constructor false on reload must never erase it —
    // while a constructor true upgrades the retained boundary permanently.
    const boundary = retained
      ? withCodemodeDefault(retained, retained.codemodeDefault || this.enableCodemodeDefault)
      : configured ?? captureAuthorizationBoundary(this.pi, this.enableCodemodeDefault);
    registry.set(sessionIdentity, boundary);
    this.sessionIdentity = sessionIdentity;
    this.boundary = boundary;
    // Reconcile the live registry before building the desired base so a
    // retained boundary also adopts registrations that happened between
    // incarnations (and applies a newly upgraded codemode intent immediately).
    this.reconcile();
    this.desiredActiveNames = this.computeDesiredBase();
    this.activeSetEstablished = true;
    this.applyActiveSet();
    return true;
  }

  startupGuidance(): string | undefined {
    this.reconcile();
    // An unreadable registry denies live discovery surfaces; the retained
    // boundary stays available for recovery.
    if (!this.boundary || this.registryUnreadable) return undefined;
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
    // A withdrawn (removed/hidden) GitRead is not live anywhere.
    if (!this.boundary.catalog.some((tool) => tool.name === GIT_READ_TOOL_NAME)) return false;
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
    // Rebuild the base for the new setting against a fresh registry snapshot.
    // Only explicit native codemode/deferred loader selections survive the
    // transition in both directions (#279: they are the sole declaration path
    // for those exposures). Ordinary search activations reset to the existing
    // conservative baseline: switching ON demotes them back to discovery, and
    // switching OFF rejoins them through the full authorized base.
    this.reconcile();
    const nativeSelections = this.loaderSelectionNames.filter((name) =>
      isNativeCallableExposure(this.boundary!.registryEntries.get(name)?.exposure));
    const base = this.computeDesiredBase();
    const baseSet = new Set(base);
    this.desiredActiveNames = [...base, ...nativeSelections.filter((name) => !baseSet.has(name))];
    // The selection record tracks declarations that survive the transition:
    // demoted ordinary selections are forgotten so a later exposure change
    // cannot resurrect them without a new search.
    const surviving = new Set(this.desiredActiveNames);
    this.loaderSelectionNames = this.loaderSelectionNames.filter((name) => surviving.has(name));
    this.applyActiveSet();
    return true;
  }

  private computeDesiredBase(): string[] {
    const boundary = this.boundary!;
    const nativeCallableNames = new Set(boundary.catalog
      .filter((tool) => isNativeCallableExposure(tool.exposure))
      .map((tool) => tool.name));
    const baseNames = this.sessionDeferred ? boundary.initialActiveNames : [...boundary.authorizedNames];
    // Reloads and deferred-setting changes never reintroduce a name the live
    // registry does not currently provide: the base intersection keeps a
    // withdrawn baseline tool out of every rebuilt desired set. Native
    // codemode/deferred exposures stay outside the base in both settings —
    // they join the declared set only through this loader's search activation.
    const live = new Set([...boundary.catalog].map((tool) => tool.name));
    return baseNames.filter((name) => live.has(name)
      && !nativeCallableNames.has(name))
      .concat(DEFERRED_TOOL_SEARCH_NAME);
  }

  /**
   * Reassert the manager-owned active set after another component syncs.
   * The reconciled desired set is the authoritative write: removed or hidden
   * tools never survive a managed write (no stale successful activation),
   * and every write is a full replacement the host records as a loadout.
   */
  reapply(): void {
    this.applyActiveSet();
  }

  private applyActiveSet(): void {
    if (!this.activeSetEstablished || !isDeferredToolHost(this.pi)) return;
    this.reconcile();
    this.syncSearchToolDescription();
    const names = this.computeActiveNames();
    this.pi.setActiveTools(names);
  }

  /** The exact array reapply would write, without performing the write. */
  private computeActiveNames(): string[] {
    const pi = this.pi;
    if (!isDeferredToolHost(pi) || this.registryUnreadable) return [];
    // #review-0004: the operating-mode policy applies regardless of boundary
    // existence, so fail-closed and unreadable states never write a
    // write-capable tool into a read-only mode.
    const planning = this.getOperatingMode() === "plan-research";
    const names = planning
      ? this.desiredActiveNames.filter(planningToolVisible)
      : [...this.desiredActiveNames];
    let modeNames = names;
    // #73: GitRead is mode/catalog-pinned, not baseline. Add it while visible
    // (so deferred-on plan/research and catalog-initial research workers keep
    // it active from the first request) and remove it everywhere else so a
    // prior activation, a full-active desired set, or the fail-closed set can
    // never leak it into a mode that does not expose it.
    if (this.gitReadVisible()) {
      if (!modeNames.includes(GIT_READ_TOOL_NAME)) modeNames = [...modeNames, GIT_READ_TOOL_NAME];
    } else {
      modeNames = modeNames.filter((name) => name !== GIT_READ_TOOL_NAME);
    }
    // Retained authority is not live availability. A captured boundary has
    // just been reconciled against the current registry by its caller; use
    // that single authoritative snapshot for every managed write. Failed
    // startup has no boundary, so it takes a fresh live intersection here.
    let available: Set<string>;
    if (this.boundary) {
      available = new Set([...this.boundary.registryEntries.values()]
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => tool.name));
    } else {
      const read = readRegistryMetadata(pi);
      if (!read.ok) return [];
      available = new Set(read.metadata
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => tool.name));
    }
    const authorized = this.boundary
      ? new Set(this.boundary.catalog.map((tool) => tool.name))
      : undefined;
    return modeNames.filter((name) => available.has(name)
      && (!authorized || name === DEFERRED_TOOL_SEARCH_NAME || authorized.has(name)));
  }

  /** Names visible at the live mode ceiling (authority boundary, not activation). */
  private modeVisibleAuthorizedNames(): ReadonlySet<string> {
    if (!this.boundary) return new Set<string>();
    const planning = this.getOperatingMode() === "plan-research";
    // The captured catalog is the reconciled live-visible authorized set
    // (authority ∩ registry, hidden/withdrawn excluded), so live reconciliation
    // applies on every surface derived from it.
    let visible = this.boundary.catalog
      .map((tool) => tool.name)
      .filter((name) => planning ? planningToolVisible(name) : true);
    // #73: an invisible GitRead is not part of the live ceiling at all — it
    // must not reach the startup inventory, the tool_search description,
    // or any match result outside the modes/roles that expose it.
    if (!this.gitReadVisible()) {
      return new Set(visible.filter((name) => name !== GIT_READ_TOOL_NAME));
    }
    visible = [...new Set(visible)];
    return new Set(visible);
  }

  /**
   * Stable deferred discovery set: the authorized catalog at the live
   * permission ceiling minus the role's baseline automatically-loaded tools
   * (tool_search itself is baseline and excluded). Derived from the captured
   * boundary's frozen initialActiveNames — never from mutable activation
   * state — so search activations cannot change startup guidance or the
   * tool_search description (no needless prompt-cache invalidation). Only
   * role/mode/permission boundary changes (and live registry reconciliation)
   * recompute this set.
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
   * The tool_search description must itself disclose the deferred discovery
   * set — compact comma-delimited names only, never per-name usage prose —
   * filtered by the live operating-mode permission and excluding the
   * baseline-loaded tools. It is byte-identical across search activations;
   * before a boundary is captured (or when startup failed closed) it lists
   * no names, so it can never disclose an unauthorized or stale set.
   */
  private renderSearchToolDescription(): string {
    const base = "Activate authorized tools. If names are known, query only exact tool names; otherwise use capability terms. Loading never performs the operation.";
    if (!this.boundary || this.registryUnreadable) return base;
    const names = [...this.deferredDiscoveryNames()].sort(compareToolNames);
    return names.length === 0 ? base : `${base} Authorized tool names: ${names.join(", ")}.`;
  }

  private renderSearchToolSnippet(): string {
    const rules = "Search only exact tool names when known, without descriptive words; use capability terms only for unknown names. Call the loaded tool next turn.";
    // The system-prompt inventory exists only when a boundary is captured and
    // a stable discovery set remains after baseline exclusion. Deferred-off
    // and fail-closed sessions must not be promised an inventory that is not
    // injected.
    if (!this.boundary || this.registryUnreadable || this.deferredDiscoveryNames().size === 0) {
      return `No system-prompt inventory is provided; tool_search only activates authorized tools. ${rules}`;
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
   * Re-register tool_search only when the rendered description or snippet
   * changed (mode switch, deferred toggle, boundary capture, or live
   * registry reconciliation). Same-name registerTool replacement is the
   * documented Pi override path; no invented host API. Registration is
   * metadata only — authority stays with reapply's active-set write.
   */
  private syncSearchToolDescription(): void {
    if (!this.registered || !isDeferredToolHost(this.pi)) return;
    // Do not resurrect or re-expose the loader when the latest authoritative
    // registry read says it is absent, hidden, or no longer directly exposed.
    // An unreadable registry also cannot authorize a replacement write.
    const currentLoader = this.boundary?.registryEntries.get(DEFERRED_TOOL_SEARCH_NAME);
    if (this.registryUnreadable || !currentLoader || currentLoader.exposure !== "direct") return;
    const description = this.renderSearchToolDescription();
    const snippet = this.renderSearchToolSnippet();
    if (this.lastSearchDescription === description && this.lastSearchSnippet === snippet) return;
    this.lastSearchDescription = description;
    this.lastSearchSnippet = snippet;
    this.pi.registerTool(this.buildSearchToolDefinition());
  }

  /**
   * Authoritative session catalog, reconciled against the live registry.
   * Dynamic authority returns empty while unreadable; configured workers keep
   * returning their immutable ceiling for recovery, while calls stay blocked.
   */
  authorizedToolNames(): string[] | undefined {
    this.reconcile();
    if (!this.boundary) return undefined;
    // The dynamic host catalog is not live authority while the registry is
    // unreadable. Keep its captured record internally for recovery, but do
    // not hand stale names to discovery or delegated-task construction.
    // Configured workers continue exposing their immutable ceiling; live call
    // gates still require the current registry intersection.
    if (this.registryUnreadable && this.boundary.dynamic) return [];
    return [...this.boundary.authorizedNames];
  }

  /**
   * Narrow public authorization query (#224, consumed by the caller-side
   * preflight/parent wiring): whether a tool call may proceed.
   *
   * - `nested=false` (model-issued): the tool must be in the manager's current
   *   declared (written) active set at the live mode ceiling, which keeps the
   *   baseline and search-activated direct tools usable and fails closed for
   *   undeclared direct calls.
   * - `nested=true` (issued by codemode scripts): registered `codemode` or
   *   `deferred` exposure is callable while inactive without direct
   *   declaration; `direct` exposure is callable while active; `model-only`
   *   and `hidden` are never calls. This mirrors Pi's native callable set and
   *   never promotes a native tool into direct declaration by the loader.
   *
   * Registry reconciliation runs first, so removed/hidden/withdrawn names return
   * false live and unknown/absent names are never permitted. In plan/research
   * the existing read-only allow policy applies to every callee (unknown MCP
   * tools are not presumed read-only) and codemode is disabled there, so the
   * wrapper-default tool and its transport use require a write-capable mode.
   */
  toolCallAllowed(name: string, nested = false): boolean {
    this.reconcile();
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return false;
    // tool_search is the loader itself: startup must have succeeded and the
    // loader must still answer every live rule below — registry-visible,
    // non-hidden, exposure-legal for the mode of the call, and currently part
    // of the manager's selection (#review-0003). A removed, hidden, replaced,
    // or deselected loader is not callable.
    if (trimmed === DEFERRED_TOOL_SEARCH_NAME) {
      if (!this.registered || !this.boundary || this.registryUnreadable) return false;
      return this.registryEntryGate(trimmed, nested);
    }
    if (!this.boundary) return this.failClosedToolCallAllowed(trimmed, nested);
    // An unreadable registry denies live calls while the retained boundary is
    // preserved for recovery (#review-0001).
    if (this.registryUnreadable) return false;
    const planning = this.getOperatingMode() === "plan-research";
    if (planning && !planningToolVisible(trimmed)) return false;
    if (!this.boundary.authorizedNames.has(trimmed)) return false;
    const entry = this.boundary.catalog.find((tool) => tool.name === trimmed);
    if (!entry) return false;
    if (entry.exposure === "hidden" || entry.exposure === "model-only" && nested) {
      return false;
    }
    const declared = this.computeActiveNames();
    if (nested) {
      // Native callable rule: codemode/deferred stay callable while inactive.
      if (NATIVE_CALLABLE_EXPOSURES.has(entry.exposure)) return true;
      return declared.includes(trimmed);
    }
    return declared.includes(trimmed);
  }

  /**
   * Live registry-entry gate for the loader's own calls: current registry
   * presence, hidden exposure, model-only never nested, and — for every
   * exposure, with no native-callable bypass — the loader's currently live
   * selection state (replacements may change the exposure but never waive
   * the selected requirement).
   */
  private registryEntryGate(name: string, nested: boolean): boolean {
    if (!isDeferredToolHost(this.pi)) return false;
    const entry = this.boundary!.registryEntries.get(name);
    if (!entry || entry.exposure === "hidden") return false;
    if (entry.exposure === "model-only" && nested) return false;
    return activeToolNamesOf(this.pi).includes(name);
  }

  /** Narrow fail-closed authority: the conservative retained set under the live mode policy. */
  private failClosedToolCallAllowed(name: string, nested: boolean): boolean {
    if (!this.failClosedAuthorized || !isDeferredToolHost(this.pi)) return false;
    if (!this.failClosedAuthorized.has(name)) return false;
    // #review-0004: failed startup bypasses nothing — plan/research still
    // rejects every write-capable or execution-control name here.
    if (this.getOperatingMode() === "plan-research" && !planningToolVisible(name)) return false;
    const read = readRegistryMetadata(this.pi);
    if (!read.ok) return false;
    const entry = read.metadata.find((tool) => tool.name === name);
    if (!entry || entry.exposure === "hidden") return false;
    if (nested) {
      if (entry.exposure === "model-only") return false;
      if (NATIVE_CALLABLE_EXPOSURES.has(entry.exposure)) return true;
    }
    return this.desiredActiveNames.includes(name);
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
    this.failClosedAuthorized = new Set(this.desiredActiveNames);
    this.activeSetEstablished = true;
    this.reapply();
    return false;
  }

  /**
   * Reconcile the captured boundary with the current live registry.
   *
   * - Successful reads are authoritative: an empty registry collapses live
   *   availability for both boundary kinds. A failing read denies live
   *   discovery and calls while the captured boundary and wrapper intent are
   *   retained for recovery.
   * - Dynamic (top-level): registry-present names that appeared after capture
   *   (or reappeared after a withdrawal) are adopted into authority; names
   *   that vanished from the registry or flipped to `hidden` exposure are
   *   dropped from authority, discovery, and the desired active set, so no
   *   stale successful activation survives. Names the registry already knew
   *   but never authorized at capture stay excluded, except a canonical
   *   native MCP name captured as hidden: Pi's later permitted visible
   *   exposure is an explicit transition that can add the name to authority.
   * - Frozen (configured worker): the ceiling never changes authority; the
   *   live visible set (and every catalog derived from it) is the ceiling's
   *   intersection with the current non-hidden registry, withdrawn selections
   *   are pruned, and baseline tools resume when a permitted re-enable makes
   *   them live.
   * - Sticky #224 wrapper default: a dynamic boundary re-authorizes the
   *   codemode registration (discovery only, never the base active set)
   *   whenever the captured wrapper intent applies and the registry currently
   *   provides one.
   *
   * There is no public tools-changed event in Pi; registry diffs on these
   * entry points are the reconciliation channel and the parent owns wiring
   * that calls them (the manager reads the registry itself otherwise).
   */
  private reconcile(): void {
    if (!this.boundary || this.sessionIdentity === undefined || !isDeferredToolHost(this.pi)) return;
    const boundary = this.boundary;
    const read = readRegistryMetadata(this.pi);
    if (!read.ok) {
      // An unreadable registry cannot be trusted for adoption, removal, or
      // availability: deny live discovery and calls while retaining the
      // captured boundary and wrapper intent, and let an authoritative read
      // recover normally.
      this.registryUnreadable = true;
      return;
    }
    // A successful read is authoritative: an empty registry means every tool
    // is absent or withdrawn, so live availability collapses for both
    // boundary kinds while the retained ceiling and wrapper intent stay
    // recoverable from the withdrawn record and registry snapshot.
    this.registryUnreadable = false;
    const metadata = read.metadata;
    const registryEntries = new Map(metadata.map((tool) => [tool.name, tool]));
    const liveAvailable = (name: string): boolean => {
      const entry = registryEntries.get(name);
      return entry !== undefined && entry.exposure !== "hidden";
    };

    let authorizedNames = boundary.authorizedNames;
    let registryBaselineNames = new Set(boundary.registryBaselineNames);
    let registryBaselineCaptured = boundary.registryBaselineCaptured;
    if (!registryBaselineCaptured) {
      // If capture happened during an outage, the first successful snapshot
      // establishes the baseline rather than being mistaken for a batch of
      // post-start registrations. Only launch-captured names and the explicit
      // wrapper codemode default may recover immediately; a hidden canonical
      // native MCP name gets only the later hidden-to-visible transition marker.
      registryBaselineNames = new Set(registryEntries.keys());
      registryBaselineCaptured = true;
    }
    const initialActiveNames = boundary.initialActiveNames;
    const withdrawnNames = new Set(boundary.withdrawnNames);
    if (!boundary.registryBaselineCaptured) {
      for (const tool of registryEntries.values()) {
        if (isCanonicalNativeMcpToolName(tool.name) && tool.exposure === "hidden") {
          withdrawnNames.add(tool.name);
        }
      }
    }
    let desired = this.desiredActiveNames;

    // Withdrawal reconciles live for both boundary kinds: names the registry
    // no longer provides (absent or removed) or that flipped to hidden
    // exposure lose loaded deferred selections, discovery, and any managed
    // write. The frozen worker ceiling stays immutable; the dynamic authority
    // drops the names and records them for re-adoption on a permitted
    // re-registration.
    const drops = [...authorizedNames].filter((name) => !liveAvailable(name));
    if (drops.length > 0) {
      const dropSet = new Set(drops);
      desired = desired.filter((name) => !dropSet.has(name));
      this.loaderSelectionNames = this.loaderSelectionNames.filter((name) => !dropSet.has(name));
      if (boundary.dynamic) {
        authorizedNames = new Set([...authorizedNames].filter((name) => !dropSet.has(name)));
        for (const name of drops) withdrawnNames.add(name);
      }
    }

    if (boundary.dynamic) {
      const adopted = [...registryEntries.keys()].filter((name) =>
        !authorizedNames.has(name)
        && (name !== CODEMODE_TOOL_NAME || withdrawnNames.has(name))
        && liveAvailable(name)
        // Baseline names need a recorded withdrawal, except for the narrowly
        // seeded hidden-native-MCP marker described at capture. The loader
        // itself is baseline-registered and special-cased outside authority.
        && (!registryBaselineNames.has(name) || withdrawnNames.has(name)));
      if (adopted.length > 0) {
        authorizedNames = new Set([...authorizedNames, ...adopted]);
        for (const name of adopted) withdrawnNames.delete(name);
        // Deferred-off loads newly adopted ordinary tools, but native
        // codemode/deferred callees stay undeclared until this loader's search
        // activates them. Deferred-on keeps every adopted tool in discovery.
        if (!this.sessionDeferred) {
          const ordinaryAdopted = adopted.filter((name) =>
            !isNativeCallableExposure(registryEntries.get(name)?.exposure)
          );
          desired = desireAdd(desired, ordinaryAdopted);
        }
      }
      if (
        boundary.codemodeDefault
        && liveAvailable(CODEMODE_TOOL_NAME)
        && !authorizedNames.has(CODEMODE_TOOL_NAME)
      ) {
        // Wrapper default authorizes discovery only (#224 correction): the
        // codemode registration joins authority and the deferred discovery
        // set, but never the initial/base active set and never a default
        // activation — tool_search is required before use in deferred-on
        // sessions. A native auto activation is likewise not promoted: the
        // next managed write strips it. Deferred-off runs the ordinary
        // full-active set, so the newly authorized codemode joins the
        // declared set like any other adopted authority.
        authorizedNames = new Set([...authorizedNames, CODEMODE_TOOL_NAME]);
        if (!this.sessionDeferred) desired = desireAdd(desired, [CODEMODE_TOOL_NAME]);
      }
    }

    // Rebuilt base plus retained selections: the live-intersected base
    // (baseline initial-active tools, or any live authorized tool while
    // deferred tools are off) resumes its normal state, the loader follows
    // the base as always, and retained non-base selections re-append after it
    // in their existing order. A retained name is either an ordinary tool
    // (existing search/toggle behavior) or an explicit loader selection for a
    // native codemode/deferred exposure (#279: the loader is their sole
    // declaration path). A name whose live exposure became native-callable
    // after it was auto-declared by a previous mode or exposure state must
    // not be re-declared here — only tool_search may declare it, and its
    // native script callability is unaffected by the strip. Loaded deferred
    // selections that were withdrawn are never auto-reenabled — restoration
    // requires search loading again — and consecutive reconciles never churn
    // the managed write layout.
    const nativeCallableNames = new Set([...registryEntries.values()]
      .filter((tool) => isNativeCallableExposure(tool.exposure))
      .map((tool) => tool.name));
    const rebuiltBase = (this.sessionDeferred ? initialActiveNames : [...authorizedNames])
      .filter((name) => liveAvailable(name)
        && !nativeCallableNames.has(name))
      .concat(DEFERRED_TOOL_SEARCH_NAME);
    const rebuiltSet = new Set(rebuiltBase);
    desired = [...rebuiltBase, ...desired.filter((name) =>
      !rebuiltSet.has(name)
      && (!nativeCallableNames.has(name) || this.loaderSelectionNames.includes(name)))];

    const catalog = [...authorizedNames]
      .filter(liveAvailable)
      .map((name) => registryEntries.get(name) ?? { name, description: "", exposure: "direct" })
      .sort((left, right) => compareToolNames(left.name, right.name));

    const next = createAuthorizationBoundary({
      catalog,
      authorizedNames,
      initialActiveNames,
      dynamic: boundary.dynamic,
      codemodeDefault: boundary.codemodeDefault,
      registryBaselineNames,
      registryBaselineCaptured,
      registryEntries,
      withdrawnNames,
    });
    this.boundary = next;
    this.desiredActiveNames = desired;
    authorizationBoundaryRegistry()?.set(this.sessionIdentity, next);
  }

  private search(params: unknown): Record<string, unknown> {
    this.reconcile();
    if (!this.boundary || !isDeferredToolHost(this.pi) || this.registryUnreadable) {
      // Startup never completed, or the registry is unreadable: live
      // discovery is denied while the retained boundary waits for recovery.
      return textResult("Tool search is unavailable until session startup completes.", true, {
        outcome: "unavailable",
      });
    }
    // Reassert the captured boundary on every loader call. Pi activates newly
    // registered tools by default in some configurations; the reconciled
    // desired set reasserted here keeps registration, withdrawal, and mode
    // state authoritative across reloads and idle boundaries.
    this.reapply();
    const query = searchQuery(params);
    if (!query) {
      return textResult(`Invalid tool_search request: query must contain 1-${MAX_QUERY_CHARS} characters.`, true, {
        outcome: "invalid",
      });
    }
    const terms = searchTerms(query);
    if (terms.length === 0) {
      return textResult("Invalid tool_search request: query must contain searchable terms.", true, {
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

    const active = new Set(this.computeActiveNames());
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
      // Every authorized match — ordinary, codemode/deferred-exposure, and MCP
      // tools alike — is declared for the next model call by this loader. The
      // activation never executes the matched operation, and native script
      // callability of codemode/deferred exposures is unchanged by it.
      active.add(match.name);
      if (!this.desiredActiveNames.includes(match.name)) {
        this.desiredActiveNames.push(match.name);
        this.loaderSelectionNames.push(match.name);
      } else if (!this.loaderSelectionNames.includes(match.name)) {
        this.loaderSelectionNames.push(match.name);
      }
      activated.push(match.name);
    }
    this.reapply();

    const matchedNames = selected.map((match) => match.name);
    const lines: string[] = [`Matched authorized tools: ${matchedNames.join(", ")}.`];
    if (activated.length > 0) {
      lines.push(
        `Activated: ${activated.join(", ")}. Call the required tool on the next turn; tool_search did not perform the operation.`,
      );
    } else if (alreadyActive.length > 0) {
      lines.push("All matched authorized tools were already active. tool_search did not perform the operation.");
    }
    return textResult(lines.join("\n"), false, {
      activated,
      alreadyActive,
      matched: matchedNames,
      omitted: 0,
      outcome: activated.length > 0 ? "activated" : "already-active",
    });
  }
}

/** Add names to a desired list once, preserving insertion order. */
function desireAdd(desired: readonly string[], additions: readonly string[]): string[] {
  const merged = [...desired];
  const seen = new Set(merged);
  for (const name of additions) {
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  return merged;
}

function withCodemodeDefault(boundary: AuthorizationBoundary, codemodeDefault: boolean): AuthorizationBoundary {
  if (boundary.codemodeDefault === codemodeDefault) return boundary;
  return createAuthorizationBoundary({
    catalog: boundary.catalog,
    authorizedNames: boundary.authorizedNames,
    initialActiveNames: boundary.initialActiveNames,
    dynamic: boundary.dynamic,
    codemodeDefault,
    registryBaselineNames: boundary.registryBaselineNames,
    registryBaselineCaptured: boundary.registryBaselineCaptured,
    registryEntries: boundary.registryEntries,
    withdrawnNames: boundary.withdrawnNames,
  });
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
    && Array.isArray(value.initialActiveNames)
    && typeof value.dynamic === "boolean"
    && typeof value.codemodeDefault === "boolean"
    && value.registryBaselineNames instanceof Set
    && typeof value.registryBaselineCaptured === "boolean"
    && value.registryEntries instanceof Map
    && value.withdrawnNames instanceof Set;
}

function createAuthorizationBoundary(input: {
  catalog: readonly ToolMetadata[];
  authorizedNames: ReadonlySet<string>;
  initialActiveNames: readonly string[];
  dynamic: boolean;
  codemodeDefault: boolean;
  registryBaselineNames: ReadonlySet<string>;
  registryBaselineCaptured: boolean;
  registryEntries: ReadonlyMap<string, ToolMetadata>;
  withdrawnNames: ReadonlySet<string>;
}): AuthorizationBoundary {
  return {
    catalog: Object.freeze(input.catalog.map((tool) => Object.freeze({ ...tool }))),
    authorizedNames: new Set(input.authorizedNames),
    initialActiveNames: Object.freeze([...input.initialActiveNames]),
    dynamic: input.dynamic,
    codemodeDefault: input.codemodeDefault,
    registryBaselineNames: new Set(input.registryBaselineNames),
    registryBaselineCaptured: input.registryBaselineCaptured,
    registryEntries: new Map(input.registryEntries),
    withdrawnNames: new Set(input.withdrawnNames),
  };
}

/**
 * Top-level capture: the launch-active set is the authority, plus the
 * registry's native-callable exposures (codemode/deferred stay callable from
 * scripts while inactive, so a registry-present match without activation is
 * authorization metadata — never promoted to declaration here), plus
 * launch-known native discovery and GitRead. The loader itself (#279) is
 * registered under Pi's replaceable builtin `tool_search` name before capture,
 * stays outside authority like every other loader, and is special-cased in the
 * active-set write and call gate instead. A wrapper codemode default adds an
 * inactive registered codemode to authorization (discovery only — it never
 * joins the initial/base active set and tool_search is required before use);
 * an already-active codemode is captured as usual regardless of the flag, and
 * a registry-absent codemode is never force-enabled (explicit restrictions
 * win).
 */
function captureAuthorizationBoundary(pi: DeferredToolHost, codemodeDefault: boolean): AuthorizationBoundary {
  const active = normalizedActiveNames(pi.getActiveTools());
  const activeNames = new Set(active);
  const read = readRegistryMetadata(pi);
  const registryBaselineCaptured = read.ok;
  const metadata = read.metadata;
  const metadataByName = new Map(metadata.map((tool) => [tool.name, tool]));
  const authorizedNames = new Set(active.filter((name) => name !== DEFERRED_TOOL_SEARCH_NAME));
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
  // #224: native-callable exposures without launch activation join the
  // authority (script-callable regardless of declaration), with codemode the
  // tool itself reserved for the explicit wrapper default below.
  for (const [name, entry] of metadataByName) {
    if (authorizedNames.has(name) || name === CODEMODE_TOOL_NAME) continue;
    if (isNativeCallableExposure(entry.exposure)) authorizedNames.add(name);
  }
  const initialActiveNames: string[] = DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER
    .filter((name) => name !== GIT_READ_TOOL_NAME)
    .filter((name) => authorizedNames.has(name));
  // #224: only an inactive registered codemode joins the base when the
  // wrapper default is enabled; a launch-active codemode stays captured as
  // usual regardless of the flag.
  const codemodeEntry = metadataByName.get(CODEMODE_TOOL_NAME);
  if (codemodeDefault && codemodeEntry && codemodeEntry.exposure !== "hidden" && !activeNames.has(CODEMODE_TOOL_NAME)) {
    // Wrapper default authorizes discovery only (#224 correction): codemode
    // stays outside the initial/base active set — tool_search is required
    // before use, and a native auto activation is never promoted either.
    authorizedNames.add(CODEMODE_TOOL_NAME);
  }
  const catalog = [...authorizedNames]
    .map((name) => metadataByName.get(name) ?? { name, description: "", exposure: "direct" })
    .sort((left, right) => compareNames(left.name, right.name));
  return createAuthorizationBoundary({
    catalog,
    authorizedNames,
    initialActiveNames,
    dynamic: true,
    codemodeDefault,
    registryBaselineNames: new Set(metadataByName.keys()),
    registryBaselineCaptured,
    // Names the registry already knew at capture: re-registrations of the
    // same name later are not "new" authorities (a disabled ordinary name
    // never gains access); only new registrations, withdrawal reversals, and
    // explicit hidden-to-visible native MCP exposure changes adopt.
    registryEntries: metadataByName,
    withdrawnNames: new Set([...metadataByName.values()]
      .filter((tool) => isCanonicalNativeMcpToolName(tool.name) && tool.exposure === "hidden")
      .map((tool) => tool.name)),
  });
}

/**
 * Configured worker capture: the durable catalog is the immutable ceiling.
 *
 * Every ordinary ceiling name must have been launch-active at capture, except
 * names the registry does not provide (or has withdrawn to `hidden`) that are
 * ceiling-only: those stay retained as initially unavailable entries (late
 * MCP servers) instead of rejecting the entire legitimate catalog. A narrow
 * pending-slot exception also permits standard native MCP names from the same
 * ceiling in `initialActiveTools` while their asynchronous registration is
 * absent or hidden; live registry intersection still withholds them. Native
 * codemode/deferred exposures are callable ceiling names, not model
 * declarations, so they may legitimately be inactive at launch even when the
 * CLI allowlist includes them; this loader declares them only on an explicit
 * tool_search activation (#279).
 * A missing ordinary tool promised by
 * `initialActiveTools` remains a broken bootstrap and fails closed, as does
 * any missing `tool_search` activation.
 */
function captureConfiguredAuthorizationBoundary(
  pi: DeferredToolHost,
  configuredCatalog: ExecutorToolCatalog,
  codemodeDefault: boolean,
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
  const read = readRegistryMetadata(pi);
  // An unreadable registry at worker capture cannot be validated: fail closed.
  if (!read.ok) return undefined;
  const metadata = read.metadata;
  const metadataByName = new Map(metadata.map((tool) => [tool.name, tool]));
  const initialActive = new Set(normalized.initialActiveTools);
  for (const name of normalized.allowedToolCatalog) {
    if (!metadataByName.has(name)) {
      // Native MCP catalog membership can precede asynchronous server
      // registration. Keep such names pending within this exact ceiling, but
      // ordinary startup-active promises still fail closed when absent.
      if (initialActive.has(name) && !isNativeMcpCeilingSlot(name)) return undefined;
      continue;
    }
    const entry = metadataByName.get(name)!;
    if (entry.exposure === "hidden") {
      // Hidden native MCP slots may be retained as pending ceiling entries;
      // the live catalog below excludes them until Pi exposes them again.
      if (initialActive.has(name) && !isNativeMcpCeilingSlot(name)) return undefined;
      continue;
    }
    // Native codemode/deferred exposure is a callable ceiling, not an
    // instruction to Pi to declare a model tool. The CLI `--tools` list may
    // authorize these worker callees while Pi correctly keeps them inactive.
    if (!launchActive.has(name)
      && !isNativeCallableExposure(entry.exposure)) return undefined;
  }
  const authorizedNames = new Set(normalized.allowedToolCatalog);
  const catalog = normalized.allowedToolCatalog
    .filter((name) => metadataByName.has(name)
      && metadataByName.get(name)!.exposure !== "hidden")
    .map((name) => metadataByName.get(name)!)
    .sort((left, right) => compareNames(left.name, right.name));
  return createAuthorizationBoundary({
    catalog,
    authorizedNames,
    initialActiveNames: normalized.initialActiveTools,
    // The configured ceiling is frozen authority: reconciliation never
    // expands it; the visible set below is the registry intersection.
    dynamic: false,
    codemodeDefault,
    registryBaselineNames: new Set(metadataByName.keys()),
    registryBaselineCaptured: true,
    registryEntries: metadataByName,
    withdrawnNames: new Set(),
  });
}

function configuredCatalogMatchesBoundary(
  configuredCatalog: ExecutorToolCatalog,
  boundary: AuthorizationBoundary,
): boolean {
  if (boundary.dynamic) return false;
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

/** Live active-set read; an unreadable host discloses nothing. */
function activeToolNamesOf(pi: DeferredToolHost): string[] {
  try {
    return normalizedActiveNames(pi.getActiveTools());
  } catch {
    return [];
  }
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
      exposure: resolveExposure(item.exposure),
    });
  }
  return result;
}

function resolveExposure(value: unknown): string {
  if (typeof value === "string" && TOOL_EXPOSURES.has(value)) return value;
  if (value === "codemode-deferred") return "codemode";
  return "direct";
}

function isNativeCallableExposure(exposure: string | undefined): boolean {
  return exposure !== undefined && NATIVE_CALLABLE_EXPOSURES.has(exposure);
}

function isCanonicalNativeMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

function isNativeMcpCeilingSlot(name: string): boolean {
  return isCanonicalNativeMcpToolName(name) || NATIVE_MCP_RESOURCE_HELPER_NAMES.has(name);
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