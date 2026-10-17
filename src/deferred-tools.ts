import { dirname, join } from "node:path";
import {
  DEFERRED_TOOL_SEARCH_NAME,
  DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER,
  createExecutorToolCatalog,
  type ExecutorToolCatalog,
} from "./execution/tool-catalog";
import { loadHostPeerModule, resolveHostPeerFile } from "./host-peer-loader";
import { RESEARCH_ALLOWED_TOOLS } from "./execution/tool";
import { GIT_READ_TOOL_NAME } from "./git-read/tool";
import { DEFAULT_OPERATING_MODE, type OperatingMode } from "./config";
import { renderAuthorizedToolInventory } from "./tool-inventory";
import { deferredToolSearchRenderResult } from "./deferred-tools-result-renderer";
import { isNativePowerShellBuiltinEntry, probeNativePowerShellHostSupport } from "./native-powershell-support";

const MAX_QUERY_CHARS = 256;
/**
 * The approved native limit for one search call: the host's own
 * tool_search default (Pi 1.0), applied when no positive integer is supplied.
 */
const DEFAULT_SEARCH_LIMIT = 8;
/** The running host package resolved through the existing peer loader. */
const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * Native Pi tool that runs codemode scripts (Pi 1.0 `builtin:codemode`).
 * #421: at the top level a registered, non-hidden codemode is an ordinary
 * discovery candidate like every other registered tool (no launch or
 * transcript observation); it is never part of the baseline. The ordinary
 * toggle requires tool_search when deferred tools are on and selects
 * permitted tools normally when off. Plan/research disables it, explicit
 * native registry restrictions remove it, and no builtin is ever
 * re-registered by this extension.
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
  /**
   * True only for Pi's own `powershell` builtin, identified from the public
   * `sourceInfo` provenance (`builtin:powershell`); never inferred from the
   * name alone (#421).
   */
  nativePowerShell?: boolean;
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
   * Dynamic (top-level, #421): derived afresh from Pi's CURRENT permitted
   * registry on every reconciliation — every registered non-hidden tool
   * except the loader itself (codemode included, #421) — so nothing the
   * session transcript restored, activated, or omitted decides authority.
   * Registered is not the same as declarable: Pi's own activation policy
   * still decides what setActiveTools() declares, and tool_search confirms
   * that from Pi's public active set rather than presuming it.
   * Frozen (configured worker): the immutable `allowedToolCatalog` ceiling,
   * never expanded, never mutated.
   */
  authorizedNames: ReadonlySet<string>;
  /**
   * Frozen worker initial-active subset (durable catalog). Unused for dynamic
   * boundaries, whose baseline is recomputed from the live authority.
   */
  initialActiveNames: readonly string[];
  /** True: dynamic host authority reconciled live. False: frozen worker ceiling. */
  dynamic: boolean;
  /**
   * Last successful full registry snapshot (name + resolved exposure) and
   * the exposure lookup for the loader's own live gate. Preserved across
   * unreadable reads for recovery.
   */
  registryEntries: ReadonlyMap<string, ToolMetadata>;
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

/**
 * Issue #434: the one concise policy explanation shared by every primary-agent
 * settings-denial diagnostic, so direct-call blocks, early not-found
 * clarifications, and nested wrapper clarifications stay consistent. It names
 * the role and the exact settings location, states that no operation was
 * performed, and states that the direct, discovery/activation, and wrapper
 * invocation paths cannot bypass the restriction.
 */
const PRIMARY_DENIAL_POLICY = (name?: string): string =>
  `${name === undefined ? "It" : `\"${name}\"`} is denied for the primary agent by the review-gate \"Top-level tools\" list (Settings > Tools), and no operation was performed. `
  + "Calling it directly, discovering or activating it with tool_search, and reaching it through codemode or another wrapper cannot bypass the denial.";

/** Stable idempotency marker inside the shared primary policy text. */
const PRIMARY_DENIAL_MARKER = "by the review-gate \"Top-level tools\" list";

// Pi recreates ExtensionAPI wrappers when extension modules reload, while the
// sessionManager object remains stable for the AgentSession. Keep the registry
// itself process-scoped so it survives module cache replacement, but key each
// captured boundary by that session identity so concurrent AgentSessions
// cannot inherit one another's authorization. v5 (#421): top-level authority
// is no longer a capture-time record at all (no launch-active set, registry
// baseline, or withdrawal memory); it is recomputed from the live registry.
// Old-shape retained boundaries fail closed instead of being reinterpreted.
const BOUNDARY_REGISTRY_KEY = Symbol.for("pi-review-gate.deferred-tool-authorization-boundaries.v5");

/**
 * Top-level Pi-native deferred activation (#421). Top-level (dynamic)
 * authority is never captured from the session's active set — Pi restores a
 * resumed, switched, or forked transcript's previous declarations before
 * session_start, so activity is not permission. Instead, every reconciliation
 * derives authority afresh from Pi's CURRENT registry: every registered
 * non-hidden tool is a discovery candidate (explicit `--tools`,
 * `--exclude-tools`, and `--no-tools` restrictions remove names from that
 * registry and stay authoritative), bounded at every surface by the live
 * operating mode and feature settings. Registered-but-inactive tools still
 * require this loader's tool_search activation; tools appearing later join,
 * and removed or hidden ones leave, at the next seam. Nothing is persisted
 * or restored. Configured
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
 *
 * #279 follow-up: registration happens at session start (registerWithNativeSchema),
 * never at factory time, so Pi's load-time replaceable-builtin collision pass
 * sees no competing definition. The descriptor reuses the host-native
 * tool_search parameter schema by exact object reference — borrowed from the
 * live registry when the builtin is loaded, otherwise captured from the
 * running install's own bundled factory — and honors the native limit
 * contract (default 8 or a supplied positive integer) capping strongest-tier
 * matched/activated results per call; the discovery inventory surfaces stay
 * complete and uncapped. When no running Pi host resolves (fake hosts, unit
 * tests), the local fallback schema is kept and startup proceeds unchanged;
 * when a host DOES resolve but its native schema cannot be acquired, session
 * start fails explicitly — a concrete compatibility failure, never a silent
 * registration of the known-incompatible fallback.
 *
 * #388: Pi 1.2 no longer recognizes a replacement tool_search by schema
 * identity; its MCP extension activates (and stops warning about) a
 * replacement only when the definition declares `reachesTools`, and uses it to
 * wait for the servers a call may reach. The descriptor therefore declares
 * `reachesTools: () => "all"` (the builtin's contract) while keeping the
 * native schema identity Pi 1.0.4/1.1.x still require. Both are recognition
 * metadata only; authority remains the reconciled boundary and search()'s
 * fail-closed gates.
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
  /**
   * The exact host-native tool_search parameter schema reference, resolved
   * once at late registration and reused by every descriptor re-registration
   * (never cloned or mutated); undefined keeps the local fallback schema.
   */
  private nativeSearchParameters: Record<string, unknown> | undefined;
  constructor(
    private readonly pi: unknown,
    private readonly getOperatingMode: () => OperatingMode = () => DEFAULT_OPERATING_MODE,
    /** Additional live feature-availability filter; it can only narrow captured authority. */
    private readonly isToolEnabledBySettings: (name: string) => boolean = () => true,
    /**
     * Native host support for Pi's builtin `powershell` (#421/#94). Consulted
     * lazily, at most once per refresh (session start and operating-mode
     * transitions), and only when the live registry actually carries the
     * native builtin: for top-level (dynamic) authority and to narrow a
     * failed startup's retained set. Frozen worker ceilings never consult it.
     * A throwing probe counts as unsupported.
     */
    private readonly probeNativePowerShellHost: () => boolean = probeNativePowerShellHostSupport,
    /**
     * Issue #434: the primary agent's own live deny list (config.tools.
     * topLevelDeny). It narrows only the dynamic (top-level) role view —
     * declarations, startup inventory, discovery, search, activation, and
     * direct/nested calls — and is never consulted by a frozen captured worker
     * ceiling: executor-only denials are applied once, at executor admission,
     * and a worker never re-reads live preferences to shrink captured
     * authority. A throwing provider denies (fail closed).
     */
    private readonly isToolDeniedForPrimaryRole: (name: string) => boolean = () => false,
  ) {}

  /** Cached probe answer; undefined until first needed after the latest refresh. */
  private nativePowerShellSupported: boolean | undefined;

  /**
   * Discard the cached native PowerShell host-support answer so the next
   * reconciliation that meets Pi's builtin `powershell` probes again. The
   * parent calls this on operating-mode transitions; sessionStart refreshes
   * on its own. It never probes eagerly and never widens a frozen ceiling.
   */
  refreshNativeHostSupport(): void {
    this.nativePowerShellSupported = undefined;
  }

  /**
   * Issue #434: whether the primary agent's own settings deny list covers
   * `name`. Only a dynamic (top-level) boundary consults it: a frozen worker
   * boundary is captured authority and never re-reads live deny preferences,
   * and executor-only denials are applied at executor admission instead. A
   * thrown provider denies (fail closed).
   */
  private primaryRoleDeniesTool(name: string): boolean {
    if (this.boundary && !this.boundary.dynamic) return false;
    try {
      return this.isToolDeniedForPrimaryRole(name) === true;
    } catch {
      return true;
    }
  }

  /**
   * Issue #434: the exact role-specific settings denial covering one exact
   * name, for the model-visible policy diagnostic. It returns undefined when
   * the role's own deny list does not cover the name, so unrelated refusals
   * keep the generic boundary wording and are never attributed to settings.
   * The wording is the shared {@link PRIMARY_DENIAL_POLICY} explanation: role
   * and settings location, no operation performed, and no direct, discovery/
   * activation, or wrapper bypass.
   */
  primaryRoleDenialReason(name: string, nested = false): string | undefined {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || !this.primaryRoleDeniesTool(trimmed) || !this.registeredLiveCandidate(trimmed)) return undefined;
    const subject = nested ? "This nested/scripted call to" : "This call to";
    return `review gate: ${subject} "${trimmed}" was blocked. ${PRIMARY_DENIAL_POLICY()} `
      + "The denial applies to the primary agent only; newly launched executor subtasks use their own independent deny list.";
  }

  /**
   * Issue #434: honest clarification for Pi's own early unknown-tool result.
   *
   * A tool the primary role denies is removed from the model-visible
   * declarations, so Pi's native tool lookup fails before the `tool_call`
   * blocking hook can run and the model would otherwise see only
   * `Tool <name> not found`. Pi's documented `message_end` seam can replace a
   * finalized message while preserving its role, so the primary runtime appends
   * the exact settings explanation there instead of leaving that generic text.
   *
   * The conversion is deliberately narrow: only a name this role denies, only
   * Pi's exact not-found wording for that same toolResult name, and only while
   * the name is still a registered, non-hidden discovery candidate. A name
   * that is merely absent, or refused by a genuine global/role restriction, or
   * denied for executors only, keeps Pi's own message and is never attributed
   * to the primary deny selector. Frozen worker boundaries never reach this
   * path (primaryRoleDeniesTool is false there), so a worker never re-reads
   * live deny preferences.
   */
  clarifyPrimaryDenialResult(message: unknown): Record<string, unknown> | undefined {
    const record = isRecord(message) ? message : undefined;
    if (!record || record.role !== "toolResult") return undefined;
    const name = typeof record.toolName === "string" ? record.toolName.trim() : "";
    if (name && record.isError === true && this.primaryRoleDeniesTool(name)) {
      const content = Array.isArray(record.content) ? record.content : undefined;
      const text = content !== undefined && content.length === 1
        && isRecord(content[0]) && content[0].type === "text" && typeof content[0].text === "string"
        ? content[0].text
        : undefined;
      // Prove the absence is this role's applied denial for a real discovery
      // candidate before naming the setting.
      if (text === `Tool ${name} not found` && this.registeredLiveCandidate(name)) {
        return {
          ...record,
          content: [{
            type: "text",
            text: `Tool ${name} not found — it is unavailable in the current tool set. ${PRIMARY_DENIAL_POLICY(name)}`,
          }],
        };
      }
    }
    // A permitted wrapper (codemode or another tool) that issued ctx.executeTool()
    // for a denied direct-exposure tool gets Pi's early lookup failure too: an
    // inactive direct tool is outside the callable set, so the `tool_call` hook
    // never ran. Pi records that nested call (name, status, error) on the outer
    // tool result, so the wrapper's actual outcome can be preserved and the
    // nested denial explained from that supported record.
    return this.clarifyPrimaryNestedDenialResult(record);
  }

  /**
   * Issue #434: append the primary settings explanation to a wrapper's tool
   * result when Pi's own record proves the wrapper issued a nested call to a
   * denied name and that nested call failed with the exact early unknown-tool
   * error. The wrapper's returned content is preserved verbatim; only an
   * additional explanatory block is appended, and only from the host's
   * recorded nested-call evidence (never by text-matching arbitrary output).
   */
  private clarifyPrimaryNestedDenialResult(record: Record<string, unknown>): Record<string, unknown> | undefined {
    const nested = isRecord(record.nestedCalls) ? record.nestedCalls : undefined;
    const calls = nested !== undefined && Array.isArray(nested.calls) ? nested.calls : undefined;
    if (calls === undefined) return undefined;
    let deniedName: string | undefined;
    for (const call of calls) {
      if (!isRecord(call)) continue;
      const name = typeof call.name === "string" ? call.name.trim() : "";
      // Eligibility is checked per candidate: an unrelated global/mode exclusion
      // for one nested name must never suppress an attributable denial for a
      // later one in the same wrapper result.
      if (!name || !this.primaryRoleDeniesTool(name) || !this.registeredLiveCandidate(name)) continue;
      const error = typeof call.error === "string" ? call.error : "";
      if (call.status === "error" && error.includes(`Tool ${name} not found`)) {
        deniedName = name;
        break;
      }
    }
    if (deniedName === undefined) return undefined;
    const blocks = Array.isArray(record.content) ? record.content : [];
    if (blocks.some((block) => isRecord(block) && block.type === "text" && typeof block.text === "string"
      && block.text.includes(PRIMARY_DENIAL_MARKER))) {
      return undefined;
    }
    return {
      ...record,
      content: [...blocks, {
        type: "text",
        text: `review gate: the nested tool call above, "Tool ${deniedName} not found", did not execute. ${PRIMARY_DENIAL_POLICY(deniedName)}`,
      }],
    };
  }

  /**
   * Issue #434: the model-visible policy reason for a delegated executor call
   * whose frozen captured ceiling genuinely omits the exact name, or undefined
   * for every other refusal.
   *
   * A worker's live gate refuses for unrelated reasons: a name the durable
   * `allowedToolCatalog` ceiling never contained, but also a ceiling name that
   * is currently inactive, withdrawn, hidden, or exposure-incompatible, an
   * unreadable registry, or an empty name. Only the ceiling omission is a fixed
   * captured fact, so only that refusal may state that the captured permissions
   * omit the tool. Every other refusal returns undefined and keeps the caller's
   * generic live-boundary wording, which never claims a fixed catalog omission
   * nor the settings deny selector. The loader and dynamic (top-level)
   * boundaries never use this reason, and live deny preferences are never
   * consulted (a frozen boundary already ignores them).
   */
  executorToolAuthorizationReason(name: string, nested = false): string | undefined {
    const trimmed = typeof name === "string" ? name.trim() : "";
    const boundary = this.boundary;
    if (!trimmed || !boundary || boundary.dynamic || this.registryUnreadable) return undefined;
    if (trimmed === DEFERRED_TOOL_SEARCH_NAME) return undefined;
    if (boundary.authorizedNames.has(trimmed)) return undefined;
    return `review gate: this ${nested ? "nested " : ""}tool call to "${trimmed}" is not in this executor's captured tool permissions for this admitted task, `
      + "so nothing was executed. That captured permission ceiling is fixed when the task is admitted and cannot be widened: retrying it, "
      + "searching or activating it with tool_search, or reaching it through codemode or another wrapper cannot grant a tool the ceiling omits. "
      + "If this capability is genuinely required, the primary agent must decide how to authorize it in a new task.";
  }

  /**
   * Issue #434: honest clarification for Pi's own early unknown-tool result in a
   * delegated executor. A worker's captured catalog is its sole authority, so
   * this derives only from the frozen ceiling: when the requested exact name is
   * outside that captured catalog and Pi answered with the native not-found
   * result, the model learns why the call could not proceed. It never consults
   * live deny preferences and never attributes the omission to the settings deny
   * selector (the cause may be a genuine global/mode/role restriction, or a task
   * admitted without the capability).
   */
  clarifyExecutorMissingToolResult(message: unknown): Record<string, unknown> | undefined {
    const record = isRecord(message) ? message : undefined;
    const boundary = this.boundary;
    if (!record || record.role !== "toolResult") return undefined;
    // Only a frozen captured worker ceiling has this honest, re-read-free context.
    if (!boundary || boundary.dynamic || this.registryUnreadable) return undefined;
    // Native nested early-lookup records come first: the outer result names the
    // (allowed) wrapper and may even report success, so the outer error flag
    // cannot gate this. Only the captured ceiling decides, and the wrapper's own
    // outcome is preserved verbatim.
    const nested = isRecord(record.nestedCalls) ? record.nestedCalls : undefined;
    const calls = nested !== undefined && Array.isArray(nested.calls) ? nested.calls : [];
    const omitted = new Set<string>();
    for (const call of calls) {
      if (!isRecord(call) || typeof call.name !== "string") continue;
      const nestedName = call.name.trim();
      if (nestedName && !boundary.authorizedNames.has(nestedName)
        && call.status === "error" && call.error === `Tool ${nestedName} not found`) {
        omitted.add(nestedName);
      }
    }
    const content = Array.isArray(record.content) ? record.content : [];
    const additions = [...omitted]
      .map((nestedName) => this.executorOmittedNestedExplanation(nestedName))
      .filter((text) => !content.some((block) => isRecord(block) && block.type === "text" && block.text === text));
    if (additions.length > 0) {
      return { ...record, content: [...content, ...additions.map((text) => ({ type: "text", text }))] };
    }
    if (record.isError !== true) return undefined;
    const name = typeof record.toolName === "string" ? record.toolName.trim() : "";
    if (!name || boundary.authorizedNames.has(name)) return undefined;
    const text = content.length === 1
      && isRecord(content[0]) && content[0].type === "text" && typeof content[0].text === "string"
      ? content[0].text
      : undefined;
    if (text !== `Tool ${name} not found`) return undefined;
    return {
      ...record,
      content: [{
        type: "text",
        text: `Tool ${name} not found — this executor's captured tool permissions for this admitted task do not include it, so nothing was executed `
          + "and Pi did not run it. The captured permission ceiling is fixed when the task is admitted; retrying it, or searching or activating "
          + "it with tool_search, cannot grant a tool the ceiling omits, and neither can codemode or another wrapper. If this capability is genuinely "
          + "required, the primary agent must decide how to authorize it in a new task.",
      }],
    };
  }

  /** The appended executor explanation for one omitted nested name (idempotency key). */
  private executorOmittedNestedExplanation(name: string): string {
    return `review gate: nested tool "${name}" is absent from this executor's captured tool permissions for this admitted task. `
      + "That nested tool did not execute; retrying, searching, activating, or using another wrapper cannot grant it. "
      + "If required, the primary agent must decide how to authorize it in a new task.";
  }

  /**
   * Whether `name` is an otherwise-discoverable pre-role-deny candidate: present
   * in the live reconciled catalog at the current mode/feature ceiling. Role
   * attribution is only honest for a name the primary could genuinely discover,
   * so globally hidden/removed, feature-disabled, and mode-forbidden names never
   * receive a role-specific settings disclosure.
   */
  private registeredLiveCandidate(name: string): boolean {
    this.reconcile();
    if (!this.boundary || !this.boundary.dynamic || this.registryUnreadable) return false;
    return this.modeVisibleAuthorizedNames(true).has(name);
  }

  /**
   * Issue #434: the authoritative pre-role-deny discovery inventory for the
   * settings deny pickers. It lists every tool otherwise discoverable at the
   * live mode/feature/registry ceiling — the same catalog the startup
   * inventory and tool_search expose, including the conservative baseline and
   * deferred names — and deliberately ignores this role's OWN deny list so a
   * checked row stays reversible without activating anything. Display-only:
   * reading it activates and authorizes nothing. Empty while the boundary is
   * unavailable or the registry is unreadable; the settings menu then keeps
   * every saved name as a reversible row. The loader itself is never a
   * candidate, and globally hidden or feature-disabled names are not
   * enumerated.
   */
  toolDenyChoices(): { name: string; description?: string }[] {
    this.reconcile();
    if (!this.boundary || this.registryUnreadable) return [];
    const visible = this.modeVisibleAuthorizedNames(true);
    return this.boundary.catalog
      .filter((tool) => tool.name !== DEFERRED_TOOL_SEARCH_NAME && visible.has(tool.name))
      .sort((left, right) => compareToolNames(left.name, right.name))
      .map((tool) => (tool.description ? { name: tool.name, description: tool.description } : { name: tool.name }));
  }

  private nativePowerShellHostSupported(): boolean {
    if (this.nativePowerShellSupported === undefined) {
      let supported = false;
      try {
        supported = this.probeNativePowerShellHost() === true;
      } catch {
        supported = false;
      }
      this.nativePowerShellSupported = supported;
    }
    return this.nativePowerShellSupported;
  }

  register(parameters?: Record<string, unknown>): boolean {
    if (this.registered || !isDeferredToolHost(this.pi)) return false;
    if (parameters !== undefined) this.nativeSearchParameters = parameters;
    const definition = this.buildSearchToolDefinition();
    this.lastSearchDescription = definition.description;
    this.lastSearchSnippet = definition.promptSnippet;
    this.pi.registerTool(definition);
    this.registered = true;
    return true;
  }

  /**
   * Session-start registration with the host-native parameter schema (#279
   * follow-up). Resolving the exact native reference is asynchronous (the
   * bundled-factory fallback loads a module), so the parent owns the await in
   * its session_start handler before authorization capture. When no running
   * Pi host resolves, the local fallback schema is kept and startup proceeds
   * unchanged; when a host resolves but its native schema cannot be acquired,
   * this rejects with an explicit compatibility failure instead of registering
   * the known-incompatible fallback (which would fail Pi <= 1.1's
   * identity-based tool_search recognition and restore the false discovery
   * warning there).
   */
  async registerWithNativeSchema(): Promise<boolean> {
    if (this.registered || !isDeferredToolHost(this.pi)) return false;
    this.nativeSearchParameters = await this.resolveNativeSearchParameters();
    return this.register();
  }

  private async resolveNativeSearchParameters(): Promise<Record<string, unknown> | undefined> {
    const live = this.liveToolSearchParameters();
    if (live !== undefined) return live;
    return this.factoryToolSearchParameters();
  }

  /** The exact `parameters` object of the tool_search entry currently in the host registry. */
  private liveToolSearchParameters(): Record<string, unknown> | undefined {
    if (!isDeferredToolHost(this.pi)) return undefined;
    let tools: unknown;
    try {
      tools = this.pi.getAllTools();
    } catch {
      return undefined;
    }
    if (!Array.isArray(tools)) return undefined;
    for (const entry of tools) {
      if (!isRecord(entry) || entry.name !== DEFERRED_TOOL_SEARCH_NAME) continue;
      const parameters = entry.parameters;
      return isRecord(parameters) ? parameters : undefined;
    }
    return undefined;
  }

  /**
   * The host-native schema captured from the running install's own bundled
   * SDK entry: the existing peer loader resolves the package (it follows
   * realpath(process.argv[1]) and validates the host), the bundled entry is
   * derived next to it, and the exported tool-search factory is invoked with
   * a tiny registerTool capture to obtain its exact parameters reference.
   * No resolved host yields undefined (the caller keeps the local fallback
   * schema); a RESOLVED host whose bundle, factory, or captured schema cannot
   * be acquired throws — registering the incompatible fallback there would
   * fail Pi <= 1.1's identity-based recognition and restore the false
   * discovery warning, so this is an explicit compatibility failure instead
   * (kept on Pi 1.2+, which recognizes reachesTools, so one fail-closed rule
   * covers every supported host).
   */
  private async factoryToolSearchParameters(): Promise<Record<string, unknown> | undefined> {
    const sdkFile = resolveHostPeerFile(PI_AGENT_PACKAGE_NAME, { packageMainFallback: true });
    if (!sdkFile) return undefined;
    const entry = join(dirname(sdkFile), "bundle", "index.js");
    const sdk = await loadHostPeerModule(entry);
    if (!isRecord(sdk)) {
      throw new Error(
        `tool_search native schema unavailable: the running host resolved to ${sdkFile} ` +
        `but its bundled SDK entry could not be loaded: ${entry}`,
      );
    }
    const factory = sdk.createToolSearchExtension;
    if (typeof factory !== "function") {
      throw new Error(
        `tool_search native schema unavailable: the running host's bundled SDK entry ${entry} ` +
        "exports no createToolSearchExtension factory",
      );
    }
    let captured: unknown;
    try {
      (factory as () => (api: { registerTool: (definition: unknown) => void }) => void)()({
        registerTool: (definition: unknown) => { captured = definition; },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `tool_search native schema unavailable: the running host's tool-search factory threw: ${reason}`,
      );
    }
    const parameters = isRecord(captured) ? captured.parameters : undefined;
    if (!isRecord(parameters)) {
      throw new Error(
        `tool_search native schema unavailable: the running host's tool-search factory registered ` +
        "no valid parameters schema",
      );
    }
    return parameters;
  }

  /** Install the live-derived top-level boundary (#421), or a durable worker boundary, before the first managed write. */
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
    this.nativePowerShellSupported = undefined;
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
      : captureConfiguredAuthorizationBoundary(this.pi, configuredCatalog);
    if (!retained && configuredCatalog !== undefined && !configured) return this.failClosed(this.pi);
    const boundary = retained ?? configured ?? createDynamicBoundary();
    registry.set(sessionIdentity, boundary);
    this.sessionIdentity = sessionIdentity;
    this.boundary = boundary;
    // Reconcile the live registry before building the desired base: a dynamic
    // boundary derives its whole authority here, and a retained one adopts
    // registrations that happened between incarnations.
    this.reconcile();
    this.desiredActiveNames = this.computeDesiredBase();
    this.activeSetEstablished = true;
    this.applyActiveSet();
    return true;
  }

  /**
   * Whether a tool is eligible for live discovery at the current authorized
   * role/mode/launch ceiling. This deliberately ignores current activation:
   * authorized deferred tools can still be advertised before tool_search loads
   * them. Unreadable registry state and unavailable settings fail closed.
   */
  isToolDiscoveryEligible(name: string): boolean {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return false;
    this.reconcile();
    return Boolean(
      this.boundary
      && !this.registryUnreadable
      && this.modeVisibleAuthorizedNames().has(trimmed),
    );
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
  private gitReadVisible(includeRoleDenied = false): boolean {
    if (!this.boundary) return false;
    // Issue #434: a top-level denial of GitRead removes it from the primary
    // role everywhere, exactly like any other denied name.
    if (!includeRoleDenied && this.primaryRoleDeniesTool(GIT_READ_TOOL_NAME)) return false;
    // A withdrawn (removed/hidden) GitRead is not live anywhere.
    if (!this.boundary.catalog.some((tool) => tool.name === GIT_READ_TOOL_NAME)) return false;
    if (!this.boundary.authorizedNames.has(GIT_READ_TOOL_NAME)) return false;
    return this.getOperatingMode() === "plan-research"
      || this.boundary.initialActiveNames.includes(GIT_READ_TOOL_NAME);
  }

  /**
   * The role's conservative baseline (automatically loaded while deferred
   * tools are on). Dynamic top-level boundaries recompute it from the live
   * authority (#421), so a restored transcript can neither drop a baseline
   * tool Pi currently permits nor keep one Pi no longer provides; frozen
   * worker boundaries keep their durable initial subset.
   */
  private baselineNames(): readonly string[] {
    const boundary = this.boundary;
    if (!boundary) return [];
    if (!boundary.dynamic) return boundary.initialActiveNames;
    return dynamicBaselineNames(boundary.authorizedNames);
  }

  /** Apply a local settings change immediately within the current boundary. */
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
    const baseNames = this.sessionDeferred ? this.baselineNames() : [...boundary.authorizedNames];
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
    this.pruneDeclinedSelections(names);
  }

  /**
   * Post-write confirmation (#421): an explicit loader selection that this
   * write requested but Pi's public active set does not contain was declined
   * by Pi's own policy (for example an exposure that became `direct` under a
   * `--tools` allowlist naming no `mcp__` entry). It is not loaded: drop the
   * selection — whenever it was made — and its non-base desired entry, so no
   * later write keeps requesting it and a reappearance needs tool_search
   * again. Base names stay as the rebuilt base defines them (the call gate
   * still requires actual native activity). An unreadable active set or
   * registry proves nothing and prunes nothing.
   */
  private pruneDeclinedSelections(requested: readonly string[]): void {
    if (!this.boundary || this.registryUnreadable || this.loaderSelectionNames.length === 0) return;
    const active = nativeActiveSet(this.pi);
    if (!active) return;
    const requestedSet = new Set(requested);
    const declined = new Set(this.loaderSelectionNames.filter((name) => requestedSet.has(name) && !active.has(name)));
    if (declined.size === 0) return;
    const base = new Set(this.computeDesiredBase());
    this.loaderSelectionNames = this.loaderSelectionNames.filter((name) => !declined.has(name));
    this.desiredActiveNames = this.desiredActiveNames.filter((name) => !declined.has(name) || base.has(name));
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
      && (!authorized || name === DEFERRED_TOOL_SEARCH_NAME || authorized.has(name))
      && this.settingAllowsTool(name)
      && !this.primaryRoleDeniesTool(name));
  }

  private settingAllowsTool(name: string): boolean {
    try {
      return this.isToolEnabledBySettings(name) === true;
    } catch {
      return false;
    }
  }

  /** Names visible at the live mode ceiling (authority boundary, not activation). */
  private modeVisibleAuthorizedNames(includeRoleDenied = false): ReadonlySet<string> {
    if (!this.boundary) return new Set<string>();
    const planning = this.getOperatingMode() === "plan-research";
    // The captured catalog is the reconciled live-visible authorized set
    // (authority ∩ registry, hidden/withdrawn excluded), so live reconciliation
    // applies on every surface derived from it. Issue #434: the primary role's
    // own deny list narrows every derived surface; the settings picker passes
    // includeRoleDenied to compute the reversible, pre-role-deny inventory.
    let visible = this.boundary.catalog
      .map((tool) => tool.name)
      .filter((name) => (includeRoleDenied || !this.primaryRoleDeniesTool(name))
        && (planning ? planningToolVisible(name) : true)
        && this.settingAllowsTool(name));
    // #73: an invisible GitRead is not part of the live ceiling at all — it
    // must not reach the startup inventory, the tool_search description,
    // or any match result outside the modes/roles that expose it.
    if (!this.gitReadVisible(includeRoleDenied)) {
      return new Set(visible.filter((name) => name !== GIT_READ_TOOL_NAME));
    }
    visible = [...new Set(visible)];
    return new Set(visible);
  }

  /**
   * Stable deferred discovery set: the authorized catalog at the live
   * permission ceiling minus the role's baseline automatically-loaded tools
   * (tool_search itself is baseline and excluded). Derived from the role
   * baseline (live authority at the top level, the durable subset for
   * workers) — never from mutable activation state — so search activations cannot change startup guidance or the
   * tool_search description (no needless prompt-cache invalidation). Only
   * role/mode/permission boundary changes (and live registry reconciliation)
   * recompute this set.
   */
  private deferredDiscoveryNames(): ReadonlySet<string> {
    if (!this.boundary || !this.sessionDeferred) return new Set<string>();
    const baseline = new Set(this.baselineNames());
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
      // #388: Pi 1.2 recognizes a replacement tool_search (MCP activation,
      // the "neither is active" discovery warning, and server readiness waits
      // before a call) only when the definition declares `reachesTools`; like
      // the builtin, a query may match any not-yet-declared tool, so every
      // call reaches "all". Earlier hosts ignore the field. It is recognition
      // metadata only: authorization, mode filtering, and the fail-closed
      // activation gates in search() are unchanged.
      reachesTools: () => "all" as const,
      // The host-native schema reference when one was resolved at late
      // registration (identity Pi <= 1.1's tool_search recognition requires,
      // retained alongside reachesTools); the local fallback otherwise.
      // Never cloned or mutated.
      parameters: this.nativeSearchParameters ?? {
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
   *
   * Issue #434: this is the GENUINE pre-role-deny authority used as the base
   * for delegated-executor catalogs, so the primary agent's own deny list does
   * NOT narrow it. A top-level-only denial leaves a new eligible executor
   * eligible; executor denials are applied once, at executor admission.
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
    return [...this.boundary.authorizedNames].filter((name) => this.settingAllowsTool(name));
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
   * codemode tool and its transport use require a write-capable mode.
   */
  toolCallAllowed(name: string, nested = false): boolean {
    this.reconcile();
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || !this.settingAllowsTool(trimmed) || this.primaryRoleDeniesTool(trimmed)) return false;
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
    // Native callable rule: codemode/deferred stay callable while inactive.
    if (nested && NATIVE_CALLABLE_EXPOSURES.has(entry.exposure)) return true;
    // Declared means both requested by the managed write AND actually in
    // Pi's public active set: a name Pi's own policy declined (deferred-off
    // base included) is not loaded, and an unreadable active set denies.
    if (!this.computeActiveNames().includes(trimmed)) return false;
    return nativeActiveSet(this.pi)?.has(trimmed) === true;
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
    if (!this.failClosedAuthorized.has(name) || !this.settingAllowsTool(name) || this.primaryRoleDeniesTool(name)) return false;
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
    // Failed startup retains only conservative already-active names, and
    // never a native powershell builtin this host cannot run (#421/#94).
    const read = readRegistryMetadata(pi);
    if (read.ok && read.metadata.some((tool) => tool.nativePowerShell === true)
      && !this.nativePowerShellHostSupported()) {
      for (const tool of read.metadata) {
        if (tool.nativePowerShell === true) activeNames.delete(tool.name);
      }
    }
    this.desiredActiveNames = DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER.filter((name) => activeNames.has(name));
    this.failClosedAuthorized = new Set(this.desiredActiveNames);
    this.activeSetEstablished = true;
    this.reapply();
    return false;
  }

  /**
   * Reconcile the boundary with the current live registry.
   *
   * - Successful reads are authoritative: an empty registry collapses live
   *   availability for both boundary kinds. A failing read denies live
   *   discovery and calls while the boundary is retained for recovery.
   * - Dynamic (top-level, #421): authority is recomputed from this snapshot —
   *   every registered non-hidden tool except the loader itself, codemode
   *   included. Nothing from a previous snapshot, the session transcript, or
   *   the active set widens or narrows it: a tool Pi registers later joins,
   *   and a removed, hidden, or excluded one leaves. Withdrawn names lose any
   *   loaded selection, so a later reappearance needs tool_search again.
   * - Frozen (configured worker): the ceiling never changes authority; the
   *   live visible set (and every catalog derived from it) is the ceiling's
   *   intersection with the current non-hidden registry, withdrawn selections
   *   are pruned, and baseline tools resume when a permitted re-enable makes
   *   them live.
   * - Plan/research (#421): names the mode forbids are removed from the
   *   retained selections, not merely hidden, so leaving the mode rebuilds
   *   the loadout from the registry as it is at that moment rather than from
   *   pre-mode selections.
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
      // boundary, and let an authoritative read recover.
      this.registryUnreadable = true;
      return;
    }
    this.registryUnreadable = false;
    const registryEntries = new Map(read.metadata.map((tool) => [tool.name, tool]));
    const liveAvailable = (name: string): boolean => {
      const entry = registryEntries.get(name);
      return entry !== undefined && entry.exposure !== "hidden";
    };

    // The host-support probe runs only when the dynamic registry actually
    // carries Pi's native powershell builtin, and then at most once per
    // refresh (cached), never per reconciliation.
    const authorizedNames = boundary.dynamic
      ? dynamicAuthorizedNames(
        registryEntries,
        [...registryEntries.values()].some((entry) => entry.nativePowerShell === true)
          && this.nativePowerShellHostSupported(),
      )
      : boundary.authorizedNames;
    let desired = this.desiredActiveNames;

    // Withdrawal reconciles live for both boundary kinds: names the registry
    // no longer provides (absent or removed) or that flipped to hidden
    // exposure lose loaded deferred selections, discovery, and any managed
    // write. The frozen worker ceiling stays immutable.
    const dropped = new Set([...boundary.authorizedNames, ...desired, ...this.loaderSelectionNames]
      .filter((name) => name !== DEFERRED_TOOL_SEARCH_NAME && (!authorizedNames.has(name) || !liveAvailable(name))));
    if (dropped.size > 0) {
      desired = desired.filter((name) => !dropped.has(name));
      this.loaderSelectionNames = this.loaderSelectionNames.filter((name) => !dropped.has(name));
    }

    // Rebuilt base plus retained selections: the live-intersected base
    // (the role baseline, or every live authorized tool while deferred tools
    // are off) resumes its normal state, the loader follows the base as
    // always, and retained non-base selections re-append after it in their
    // existing order. A retained name is either an ordinary tool (existing
    // search/toggle behavior) or an explicit loader selection for a native
    // codemode/deferred exposure (#279: the loader is their sole declaration
    // path). A name whose live exposure became native-callable after it was
    // auto-declared must not be re-declared here — only tool_search may
    // declare it, and its native script callability is unaffected.
    const nativeCallableNames = new Set([...registryEntries.values()]
      .filter((tool) => isNativeCallableExposure(tool.exposure))
      .map((tool) => tool.name));
    const baseline = boundary.dynamic
      ? dynamicBaselineNames(authorizedNames)
      : boundary.initialActiveNames;
    const rebuiltBase = (this.sessionDeferred ? baseline : [...authorizedNames])
      .filter((name) => liveAvailable(name)
        && !nativeCallableNames.has(name))
      .concat(DEFERRED_TOOL_SEARCH_NAME);
    const rebuiltSet = new Set(rebuiltBase);
    const planning = this.getOperatingMode() === "plan-research";
    desired = [...rebuiltBase, ...desired.filter((name) =>
      !rebuiltSet.has(name)
      // Plan/research removes forbidden selections outright (#421).
      && (!planning || planningToolVisible(name))
      && (!nativeCallableNames.has(name) || this.loaderSelectionNames.includes(name)))];
    if (planning) this.loaderSelectionNames = this.loaderSelectionNames.filter(planningToolVisible);

    const catalog = [...authorizedNames]
      .filter(liveAvailable)
      .map((name) => registryEntries.get(name) ?? { name, description: "", exposure: "direct" })
      .sort((left, right) => compareToolNames(left.name, right.name));

    const next = createAuthorizationBoundary({
      catalog,
      authorizedNames,
      initialActiveNames: boundary.initialActiveNames,
      dynamic: boundary.dynamic,
      registryEntries,
    });
    this.boundary = next;
    this.desiredActiveNames = desired;
    authorizationBoundaryRegistry()?.set(this.sessionIdentity, next);
  }

  /** Exact-name catalog entries denied for this role, matched case-insensitively against query terms. */
  /** A denied exact-name search result: the settings denial, nothing activated. */
  private deniedSearchResult(names: readonly string[]): Record<string, unknown> {
    return textResult(
      `Denied for the primary agent by review-gate settings (Settings > Tools > "Top-level tools"): ${names.join(", ")}. `
      + "No operation was performed: a denied tool cannot be discovered, activated, or called, and tool_search, codemode, and every other wrapper cannot bypass the denial.",
      true,
      { activated: [], matched: [], alreadyActive: [], denied: [...names], outcome: "denied" },
    );
  }

  /**
   * Issue #434: a denied catalog name whose exact spelling is the entire
   * normalized query. This is checked before any allowed match so a denied name
   * that overlaps an allowed name's terms (for example a denied "read" beside a
   * visible GitRead) can never activate or report an unrelated tool.
   */
  private deniedWholeQueryName(query: string): string | undefined {
    if (!this.boundary) return undefined;
    const visible = this.modeVisibleAuthorizedNames(true);
    return this.boundary.catalog
      .map((tool) => tool.name)
      .find((name) => visible.has(name)
        && name.toLocaleLowerCase("en-US") === query && this.primaryRoleDeniesTool(name));
  }

  private deniedExactQueryNames(terms: readonly string[]): string[] {
    if (!this.boundary || terms.length === 0) return [];
    const termSet = new Set(terms);
    const visible = this.modeVisibleAuthorizedNames(true);
    return this.boundary.catalog
      .map((tool) => tool.name)
      .filter((name) => visible.has(name)
        && termSet.has(name.toLocaleLowerCase("en-US")) && this.primaryRoleDeniesTool(name))
      .sort(compareToolNames);
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
    // The approved native limit contract: a supplied positive integer or the
    // native default of 8; anything else fails explicitly like an invalid query.
    const limit = searchLimit(params);
    if (limit === undefined) {
      return textResult("Invalid tool_search request: limit must be a positive integer.", true, {
        outcome: "invalid",
      });
    }

    // Issue #434: a whole-query exact denied name is answered with the settings
    // denial before any allowed candidate is matched, so it cannot select or
    // activate an unrelated tool.
    const wholeQueryDenied = this.deniedWholeQueryName(query);
    if (wholeQueryDenied !== undefined) return this.deniedSearchResult([wholeQueryDenied]);

    // Planning mode makes forbidden tools absent from discovery as well: they
    // cannot be matched, reported, or activated while the mode is applied.
    // #73: GitRead follows its own visibility rule in every mode — searchable
    // (and already active) where visible, and unmatchable everywhere else so
    // search can never activate it outside plan/research or a research catalog.
    const planning = this.getOperatingMode() === "plan-research";
    const catalog = this.boundary.catalog.filter((tool) => {
      if (!this.settingAllowsTool(tool.name) || this.primaryRoleDeniesTool(tool.name)) return false;
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
      // Issue #434: an exact-name query for a tool this role denies gets the
      // precise policy answer instead of a bare no-match, so the model learns
      // the denial is a settings decision on every invocation path rather than
      // guessing that a retry or a different query might work.
      const deniedExact = this.deniedExactQueryNames(terms);
      if (deniedExact.length > 0) return this.deniedSearchResult(deniedExact);
      return textResult("No authorized tools matched. No tools were activated.", false, {
        activated: [],
        matched: [],
        alreadyActive: [],
        outcome: "no-match",
      });
    }
    // The limit caps the strongest-tier results of this call only (matching
    // and tiering above are untouched): the withheld strongest-tier matches
    // are reported truthfully through the omitted count, while the discovery
    // inventory surfaces stay complete and uncapped.
    const limited = selected.slice(0, limit);
    const omittedCount = selected.length - limited.length;

    // A name is active only when it is both in this manager's declared write
    // AND in Pi's own public active set (`getActiveTools()`, the tools Pi
    // declares to the model — hidden declarations included). The managed
    // write alone is a request, not proof: Pi's native policy may decline it
    // (Pi 1.3: a `--tools` allowlist naming no `mcp__` entry keeps
    // direct-exposure MCP tools registered but never declarable). #73: a
    // visible GitRead is active through the mode/catalog pin, so it reports
    // already active here without a no-op "activation".
    const nativeActive = nativeActiveSet(this.pi) ?? new Set<string>();
    const declaredBefore = new Set(this.computeActiveNames());
    const activated: string[] = [];
    const alreadyActive: string[] = [];
    const refused: string[] = [];
    const requested: string[] = [];
    for (const match of limited) {
      // The catalog is already authorization-filtered. Keep this explicit
      // guard so a future catalog refactor cannot turn metadata into authority.
      if (!this.boundary.authorizedNames.has(match.name)) continue;
      if (declaredBefore.has(match.name) && nativeActive.has(match.name)) {
        alreadyActive.push(match.name);
        continue;
      }
      // Every authorized match — ordinary, codemode/deferred-exposure, and MCP
      // tools alike — is requested for the next model call by this loader.
      // The activation never executes the matched operation, and native
      // script callability of codemode/deferred exposures is unchanged by it.
      if (!this.desiredActiveNames.includes(match.name)) this.desiredActiveNames.push(match.name);
      if (!this.loaderSelectionNames.includes(match.name)) this.loaderSelectionNames.push(match.name);
      requested.push(match.name);
    }
    // The managed write prunes every selection Pi declines (see
    // pruneDeclinedSelections), so a failed activation is never retained.
    this.reapply();
    if (requested.length > 0) {
      // Confirm the outcome from Pi's actual post-write active set (public
      // API; no host internals, policy replica, or argv parsing). A name the
      // host declined is a genuine refusal and is reported as such; an
      // unreadable active set confirms nothing.
      const nativeAfter = nativeActiveSet(this.pi) ?? new Set<string>();
      const declaredAfter = new Set(this.computeActiveNames());
      for (const name of requested) {
        if (nativeAfter.has(name) && declaredAfter.has(name)) activated.push(name);
        else refused.push(name);
      }
    }

    const matchedNames = limited.map((match) => match.name);
    const lines: string[] = [`Matched authorized tools: ${matchedNames.join(", ")}.`];
    if (omittedCount > 0) {
      lines.push(`${omittedCount} additional strongest-tier match(es) were omitted by the limit.`);
    }
    if (activated.length > 0) {
      lines.push(
        `Activated: ${activated.join(", ")}. Call the required tool on the next turn; tool_search did not perform the operation.`,
      );
    }
    if (refused.length > 0) {
      lines.push(
        `Not activated: ${refused.join(", ")}. Pi's tool policy for this session declined to declare ${refused.length === 1 ? "it" : "them"} `
        + `(for example, a --tools allowlist that names no mcp__ entry never declares direct-exposure MCP tools); `
        + `${refused.length === 1 ? "it is" : "they are"} unavailable, so do not call ${refused.length === 1 ? "it" : "them"}.`,
      );
    }
    if (alreadyActive.length > 0 && activated.length === 0 && refused.length === 0) {
      lines.push("All matched authorized tools were already active. tool_search did not perform the operation.");
    } else if (alreadyActive.length > 0 && refused.length > 0) {
      lines.push(`Already active: ${alreadyActive.join(", ")}.`);
    }
    const outcome = activated.length > 0 ? "activated" : refused.length > 0 ? "refused" : "already-active";
    // Only refusals and nothing usable: the request failed and must not read
    // as success.
    const failed = refused.length > 0 && activated.length === 0 && alreadyActive.length === 0;
    return textResult(lines.join("\n"), failed, {
      activated,
      alreadyActive,
      refused,
      matched: matchedNames,
      omitted: omittedCount,
      outcome,
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
    && Array.isArray(value.initialActiveNames)
    && typeof value.dynamic === "boolean"
    && value.registryEntries instanceof Map;
}

function createAuthorizationBoundary(input: {
  catalog: readonly ToolMetadata[];
  authorizedNames: ReadonlySet<string>;
  initialActiveNames: readonly string[];
  dynamic: boolean;
  registryEntries: ReadonlyMap<string, ToolMetadata>;
}): AuthorizationBoundary {
  return {
    catalog: Object.freeze(input.catalog.map((tool) => Object.freeze({ ...tool }))),
    authorizedNames: new Set(input.authorizedNames),
    initialActiveNames: Object.freeze([...input.initialActiveNames]),
    dynamic: input.dynamic,
    registryEntries: new Map(input.registryEntries),
  };
}

/**
 * Top-level (dynamic) authority from one registry snapshot (#421): every
 * registered non-hidden tool is a discovery candidate — Pi's registry already
 * excludes names withheld by `--tools`/`--exclude-tools`/`--no-tools` or a
 * disabled builtin extension — regardless of whether it is currently active,
 * and with no per-name launch or transcript observation (codemode included).
 * One native nuance stays Pi-owned: a `--tools` allowlist naming no `mcp__`
 * entry keeps MCP tools registered (for codemode and tool_search) while Pi
 * declines to declare the direct-exposure ones. Pi exposes no public
 * per-tool activatability query, so such names remain candidates and
 * tool_search reports Pi's refusal from the actual post-write active set. The
 * loader itself stays outside authority (special-cased in the active-set
 * write and call gate). Operating-mode and settings filters apply on top of
 * this at every surface.
 *
 * Native host support (#421/#94): Pi registers its builtin `powershell` on
 * every platform although it can only run it on Windows with `pwsh.exe` or
 * `powershell.exe` available. The builtin (identified by Pi's public
 * `sourceInfo`, never by name alone) is therefore authorized only when
 * `nativePowerShellSupported` is true; extension or SDK tools that share the
 * name are untouched.
 */
function dynamicAuthorizedNames(
  registryEntries: ReadonlyMap<string, ToolMetadata>,
  nativePowerShellSupported: boolean,
): Set<string> {
  const names = new Set<string>();
  for (const [name, entry] of registryEntries) {
    if (entry.exposure === "hidden" || name === DEFERRED_TOOL_SEARCH_NAME) continue;
    if (entry.nativePowerShell === true && !nativePowerShellSupported) continue;
    names.add(name);
  }
  return names;
}

/**
 * Top-level conservative baseline from the live authority: the shared
 * initial-active order, never GitRead (its activity is pinned to
 * plan/research by gitReadVisible) and never codemode (absent from the order;
 * tool_search loads it). Shells keep historical parity (#94/#421): `bash` and
 * `powershell` are both baseline wherever the live authority carries them,
 * and that authority already withholds a native `powershell` builtin the
 * host cannot run.
 */
function dynamicBaselineNames(authorizedNames: ReadonlySet<string>): string[] {
  return DEFAULT_EXECUTOR_INITIAL_TOOL_ORDER
    .filter((name) => name !== GIT_READ_TOOL_NAME && authorizedNames.has(name));
}

/**
 * Top-level boundary shell. Nothing is captured here — not the active set,
 * which Pi has already restored from a resumed, switched, or forked
 * transcript — so the immediate reconciliation in sessionStart (and every
 * later seam) derives the whole authority from the live registry.
 */
function createDynamicBoundary(): AuthorizationBoundary {
  return createAuthorizationBoundary({
    catalog: [],
    authorizedNames: new Set(),
    initialActiveNames: [],
    dynamic: true,
    registryEntries: new Map(),
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
    registryEntries: metadataByName,
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

/**
 * Pi's public active set (`getActiveTools()`, the tools declared to the
 * model), or undefined when the host cannot disclose it — callers then
 * confirm nothing and prune nothing.
 */
function nativeActiveSet(pi: unknown): Set<string> | undefined {
  if (!isDeferredToolHost(pi)) return undefined;
  let value: unknown;
  try {
    value = pi.getActiveTools();
  } catch {
    return undefined;
  }
  return Array.isArray(value) ? new Set(normalizedActiveNames(value)) : undefined;
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
      ...(isNativePowerShellBuiltinEntry(item) ? { nativePowerShell: true } : {}),
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

/** The approved native limit: a supplied positive integer, else the native default of 8. */
function searchLimit(params: unknown): number | undefined {
  if (!isRecord(params) || params.limit === undefined) return DEFAULT_SEARCH_LIMIT;
  const value = params.limit;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
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

/**
 * The narrow host capability the deferred manager needs (exported so the
 * entrypoint can preserve its unsupported-host early return without a
 * factory-time tool registration).
 */
export function isDeferredToolHost(value: unknown): value is DeferredToolHost {
  return isRecord(value)
    && typeof value.registerTool === "function"
    && typeof value.getActiveTools === "function"
    && typeof value.getAllTools === "function"
    && typeof value.setActiveTools === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}