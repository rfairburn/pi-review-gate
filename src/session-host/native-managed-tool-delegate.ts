/**
 * #682: the production-intended native MCP lane delegate that serves the
 * canonical managed Subtasks tools.
 *
 * It is an ADAPTER, not an engine. A native MCP `tools/call` reaches it only
 * after `InstanceManager` proved the call's {@linkcode NativeMcpLaneContext}
 * (exact row, backend, canonical workspace, bound conversation, live
 * incarnation). It maps that host-proved context plus the MCP tool name and
 * freshly decoded arguments onto `ExecutionToolManager.sharedManagedTool`, so
 * validation, owner scoping, exposure, live call policy, controller admission,
 * and result/failure shaping all stay in the one canonical handler Pi uses.
 *
 * Authority comes from exactly two places, both host-side:
 * - the frozen lane context the instance manager built from its own records;
 * - an injected, trusted {@linkcode NativeManagedToolScopeResolver} that maps
 *   that exact context to the EXISTING, already-restored, host-scoped manager
 *   plus the authoritative set of actions this call may use.
 * The JSON-RPC id, `_meta`, client info, and every argument value are request
 * data only; an argument naming a row, conversation, or owner changes nothing.
 *
 * Lane freshness and durable effects. The lane can be revoked at any time
 * (identity change, cancellation, exit). The delegate fences at the one-use
 * admission callback, which the canonical binding calls synchronously, after
 * its exposure, pool, policy, and owner-scope checks and immediately before
 * entering the handler. Withholding a result afterwards is NOT cancellation,
 * so an action is offered on the lane only when the lane is re-proved before
 * each effect: Watch and Steer commit synchronously after admission, and
 * Start, Add, Inspect, and Continue carry the lane's own `isCurrent`/`signal`
 * into the controller as the canonical effect guard, which re-checks it
 * before each effect that follows an await (Add: on entry and immediately
 * before its tasks attach to the existing group; Continue: on entry, at each
 * continuation admission recheck, and before its first recovery update). See
 * {@linkcode NATIVE_LANE_FENCED_ACTIONS} and the manager construction contract
 * on {@linkcode NativeManagedToolScope}. Every other action (Interrupt,
 * ForceMerge, MarkClean) stays unavailable here even when the owner exposes
 * it.
 *
 * Per call, the delegate is the owner admission the shared boundary requires:
 * - it assigns its own one-use call id (never caller supplied);
 * - it snapshots the decoded arguments once and admits exactly that snapshot;
 * - the admission answers one `resolveCall` for that id and tool name, and
 *   re-proves the lane context at that moment;
 * - nothing is retried or replayed: a repeated MCP call is a new call;
 * - Start admits the raw snapshot's `toolCallFingerprint` as its identity, and
 *   only when no identical Start is active (the manager's `startLiveness`) or
 *   still in flight through this delegate for the same manager;
 * - an admitted Start carries exactly one fresh settings snapshot (review-gate
 *   configuration plus parent tool ceiling) read at that admission from the
 *   scope's trusted `readStartSettings`; when the owner cannot supply one, the
 *   Start is refused before the handler and never falls back to live reads;
 * - an admitted Add carries its own fresh snapshot from that same reader, under
 *   the same rules, as `addSettings`. It sets only the new tasks' admission
 *   policy (whether the group's kind is still routed, tool catalog, and
 *   captured evidence policy). The target group is
 *   resolved by the canonical handler inside the owner's own manager, so only
 *   work that manager holds can be topped off, and the group keeps its own
 *   settings (its Start snapshot, or the manager's base configuration) for
 *   route selection, worker/reviewer launch configuration, and continuation.
 *   Add has no duplicate fence, exactly as in Pi: a repeated call is a new
 *   top-off.
 *
 * Absence is the default: without a resolver every lane lists no tools and
 * answers every call as "not exposed". Nothing here launches, registers, or
 * persists anything, and no Pi host is synthesized.
 */
import { randomUUID } from "node:crypto";
import { isPromise } from "node:util/types";
import { normalizeConfig, type ReviewGateConfig } from "../config";
import {
  EFFECT_GUARDED_ACTIONS,
  EXECUTION_TOOL_NAMES,
  SHARED_MANAGED_TOOL_ACTIONS,
  type ExecutionToolManager,
  type ManagedToolAdmission,
  type ManagedToolAdmittedCall,
  type ManagedToolDefinition,
  type ManagedStartSettings,
  type SharedManagedToolAction,
} from "../execution/tool";
import type { NativeMcpLaneContext, NativeMcpLaneDelegate, NativeMcpLaneToolCall } from "./instances";
import type { NativeMcpCallToolResult, NativeMcpToolDescriptor } from "./native-mcp-stdio";
import type { NativeCliBackend } from "./session-backend";
import { toolCallFingerprint } from "../tool-call-fingerprint";

/**
 * The part of the real `ExecutionToolManager` contract this delegate uses: the
 * canonical shared binding. The owner hands over its actual manager; this is a
 * narrowing, not a second implementation.
 */
export type NativeManagedToolManager = Pick<ExecutionToolManager, "sharedManagedTool" | "startLiveness">;

/**
 * Shared actions the native lane may offer under the scope contract on
 * {@linkcode NativeManagedToolScope}. Start, Add, Inspect, and Continue
 * receive the lane as their canonical effect guard (`EFFECT_GUARDED_ACTIONS`).
 * Watch validates and arms its
 * subscription synchronously after admission, with no await, but the
 * controller reads the owner's `cwd()` between admission and arming. That read
 * is the only owner code on the path, and it must not re-enter host lifecycle
 * code (see `NativeManagedToolScope.manager`). The later checkpoint still
 * travels through the owner manager's notification delivery, which the owner
 * composes and must route to the correct owner.
 *
 * Steer resolves its task in the owner's own manager and records its command
 * synchronously after admission, with no await and no owner callback in
 * between; its durable save and any live delivery follow that commit and
 * finish even if the lane falls (withholding the result is not cancellation).
 * Continue admits only a task the owner's manager already holds: an explicit
 * reattachment bundle stays refused by the canonical boundary before the
 * controller, and an admitted continuation is saved and pumped as on Pi.
 */
export const NATIVE_LANE_FENCED_ACTIONS: readonly SharedManagedToolAction[] = Object.freeze(["start", "add", "inspect", "watch", "continue", "steer"]);

/** The exact lane identity a scope was resolved for, echoed back by the resolver. */
export interface NativeManagedToolOwnerIdentity {
  readonly rowId: string;
  readonly backend: NativeCliBackend;
  readonly workspace: string;
  readonly conversationId: string;
}

/**
 * What the trusted resolver returns for ONE proved lane call. Every field is
 * read once and validated per call.
 */
export interface NativeManagedToolScope {
  /**
   * The exact identity this scope belongs to. It must equal the lane context's
   * row, backend, workspace, and conversation; any difference refuses the call.
   */
  readonly owner: NativeManagedToolOwnerIdentity;
  /**
   * The existing host-scoped manager for that identity: constructed with
   * `pi: undefined` and `hostExposure`, associations already restored (a live
   * owner scope), and synced. To offer Watch, the manager must have been
   * constructed with a side-effect-free `cwd: () => capturedWorkspace` for the
   * exact owner workspace (a plain data property, not an accessor), never a
   * callback that refreshes workspace, ownership, or lane lifetime: the
   * controller calls it after admission and before arming, where no further
   * lane check is possible. If the resolver cannot establish this from the
   * manager's construction, it must omit Watch from `actions` or return no
   * scope. To offer Start, it must also expose its own `startLiveness`. The
   * delegate never constructs, restores, syncs, detaches, or reconfigures it.
   */
  readonly manager: NativeManagedToolManager;
  /**
   * The authoritative intersection of that manager's fixed `hostExposure` and
   * this call's request policy, composed by the owner from the same host data
   * that configured the manager: non-empty and duplicate-free. When the owner
   * cannot compose it, the resolver must return no scope. The delegate narrows
   * it further to {@linkcode NATIVE_LANE_FENCED_ACTIONS}, and the canonical
   * binding still applies its own exposure and live policy on every call.
   */
  readonly actions: readonly SharedManagedToolAction[];
  /**
   * Read only for Start and Add: the trusted owner's synchronous settings read
   * for this exact lane identity (see {@linkcode NativeManagedStartSettingsReader}).
   * Without a callable reader neither Start nor Add is offered on the lane
   * (never listed, and a call is answered as not exposed); the scope's other
   * actions are unaffected and never invoke it.
   */
  readonly readStartSettings?: NativeManagedStartSettingsReader;
}

/**
 * Trusted, synchronous settings read for one owner identity, used by Start and
 * Add admission only. The delegate calls it exactly once per Start that its
 * admission actually admits (after the duplicate check) and once per Add that
 * its admission reaches, never for discovery, a refused admission, or any other
 * action, and forwards the answer as that call's canonical
 * `ManagedToolAdmittedCall.startSettings` or `addSettings`. Each call must take one fresh,
 * consistent snapshot: the review-gate configuration and the authoritative
 * parent tool ceiling from the same read. Returning `undefined` means the owner
 * cannot supply settings for this call, which refuses it; so do a throw, a
 * malformed answer, and a lane revoked while it ran. It must not await, and it
 * must not re-enter host lifecycle code: it runs inside the canonical
 * admission callback, after the lane was re-proved and before it is re-proved
 * again.
 */
export type NativeManagedStartSettingsReader = () => ManagedStartSettings | undefined;

/**
 * Trusted owner resolver: the frozen, host-proved lane context in, the exact
 * owner's scope out, or `undefined` when no managed tools are available for
 * it. It is synchronous on purpose, so no await separates the context proof
 * from admission; restoring or persisting a manager is the owner's job and
 * must be complete before it is returned here.
 */
export type NativeManagedToolScopeResolver = (context: NativeMcpLaneContext) => NativeManagedToolScope | undefined;

/** The default resolver: no owner scope, so no managed tools are exposed on any lane. */
export const unavailableNativeManagedToolScope: NativeManagedToolScopeResolver = () => undefined;

export interface NativeManagedToolDelegateOptions {
  /** Defaults to {@linkcode unavailableNativeManagedToolScope}. */
  readonly resolveScope?: NativeManagedToolScopeResolver;
}

/** A validated per-call scope, already narrowed to lane-fenced actions. */
interface ResolvedScope {
  readonly manager: NativeManagedToolManager;
  readonly actionsByName: ReadonlyMap<string, SharedManagedToolAction>;
  /** The manager's `startLiveness`, read once; present whenever Start is offered. */
  readonly startLiveness?: NativeManagedToolManager["startLiveness"];
  /** The scope's `readStartSettings`, read once; present whenever Start or Add is offered. */
  readonly readStartSettings?: NativeManagedStartSettingsReader;
}

/** Why a Start admission was withheld as a duplicate. */
type StartDuplicate = { readonly state: "active"; readonly identity?: string } | { readonly state: "unknown" | "in-flight" };

/**
 * The non-optional top-level `ReviewGateConfig` fields. `normalizeConfig`
 * defaults each when absent, so a snapshot missing one is incomplete rather
 * than merely unset, and is refused instead of silently repaired.
 */
const REQUIRED_CONFIG_FIELDS = Object.freeze([
  "enabled",
  "operatingMode",
  "modeCycleShortcut",
  "reviewerTimeoutMs",
  "executorTimeoutMs",
  "maxCorrectionCycles",
  "implementationGuidanceAfterCorrectionAttempts",
  "maxPatchBytes",
  "maxFileBytes",
  "maxSnapshotBytes",
  "retainBundles",
] as const satisfies readonly (keyof ReviewGateConfig)[]);

/** Why an otherwise admissible Start or Add was withheld for lack of trusted settings. */
type StartSettingsRefusal = "unavailable" | "invalid";

const STALE_CONTEXT = "session-host: the native managed-tool call has no current proved lane context";
const INVALID_SCOPE = "session-host: the native managed-tool owner scope is invalid for this lane";
const UNAVAILABLE_SCOPE = "session-host: the native managed-tool owner scope could not be resolved";
const UNBOUND_SCOPE = "session-host: the native managed-tool owner session is not live";
const INVALID_RESULT = "session-host: the managed tool returned a result the native lane cannot forward";
const CALL_ID_PREFIX = "native-mcp-call-";
/** `sharedManagedTool`'s refusal when every check passed but the owner admitted nothing. */
const MISSING_ADMISSION_DIAGNOSTIC = "no owner admission for this call and tool";

/**
 * Builds the delegate. Pass it as `NativeMcpLaneOwner.delegate`; with no
 * resolver it exposes nothing.
 */
export function createNativeManagedToolDelegate(options: NativeManagedToolDelegateOptions = {}): NativeMcpLaneDelegate {
  const resolveScope = options.resolveScope ?? unavailableNativeManagedToolScope;
  if (typeof resolveScope !== "function") {
    throw new Error("session-host: a native managed-tool delegate requires a scope resolver function");
  }

  // Start fingerprints admitted through this delegate whose call has not
  // settled, per owner manager: the window before the controller attaches a
  // group that `startLiveness` can see.
  const startsInFlight = new WeakMap<NativeManagedToolManager, Set<string>>();

  // `includeSettings` is false only for a call that is neither Start nor Add:
  // such a call never looks up the settings reader (see `validateScope`).
  const resolve = (context: NativeMcpLaneContext, includeSettings = true): ResolvedScope | undefined => {
    let raw: unknown;
    try {
      raw = resolveScope(context);
    } catch {
      throw new Error(UNAVAILABLE_SCOPE);
    }
    const scope = raw === undefined ? undefined : validateScope(raw, context, includeSettings);
    // The resolver is owner code: re-prove the lane before the manager is queried.
    assertCurrent(context);
    return scope;
  };

  return Object.freeze({
    async listTools(context: NativeMcpLaneContext): Promise<readonly NativeMcpToolDescriptor[]> {
      assertCurrent(context);
      const scope = resolve(context);
      if (scope === undefined) return [];
      const tools: NativeMcpToolDescriptor[] = [];
      for (const action of scope.actionsByName.values()) {
        const definition = await canonicallyExposedDefinition(scope.manager, action);
        assertCurrent(context);
        if (definition === undefined) continue;
        tools.push({
          name: definition.name,
          description: definition.description,
          inputSchema: structuredClone(definition.parameters),
        });
      }
      return tools;
    },

    async callTool(context: NativeMcpLaneContext, call: NativeMcpLaneToolCall): Promise<NativeMcpCallToolResult | undefined> {
      assertCurrent(context);
      const name: unknown = isRecord(call) ? call.name : undefined;
      const scope = resolve(context, name === EXECUTION_TOOL_NAMES.start || name === EXECUTION_TOOL_NAMES.add);
      const action = scope !== undefined && typeof name === "string" ? scope.actionsByName.get(name) : undefined;
      if (scope === undefined || action === undefined) return undefined;
      const toolName = EXECUTION_TOOL_NAMES[action];

      // The owner's own snapshot of exactly what was submitted, taken once.
      const params: unknown = structuredClone((call as NativeMcpLaneToolCall).arguments);
      // Start's identity is the raw snapshot's, before canonical coercion. An
      // unrepresentable request has none; the canonical handler refuses it.
      const fingerprint = action === "start" ? toolCallFingerprint(toolName, params) : undefined;
      const toolCallId = `${CALL_ID_PREFIX}${randomUUID()}`;
      let pending: { readonly params: unknown } | undefined = { params };
      let duplicate: StartDuplicate | undefined;
      let settingsRefusal: StartSettingsRefusal | undefined;
      let reserved: Set<string> | undefined;
      const effectGuard = EFFECT_GUARDED_ACTIONS.includes(action)
        ? Object.freeze({ isCurrent: () => isCurrent(context) })
        : undefined;
      const admission: ManagedToolAdmission = {
        // Called by the canonical binding after its exposure, pool, live
        // policy, and owner-scope checks, synchronously before the handler.
        resolveCall(id: string, resolvedName: string): ManagedToolAdmittedCall | undefined {
          const admitted = pending;
          pending = undefined;
          if (admitted === undefined || id !== toolCallId || resolvedName !== toolName || !isCurrent(context)) {
            return undefined;
          }
          if (fingerprint !== undefined) {
            let inFlight = startsInFlight.get(scope.manager);
            duplicate = inFlight?.has(fingerprint) === true
              ? { state: "in-flight" }
              : startDuplicate(scope, fingerprint);
            if (duplicate !== undefined) return undefined;
            // Reserve before any owner code runs, so a settings read that
            // re-enters admission for the same request sees it in flight.
            if (inFlight === undefined) startsInFlight.set(scope.manager, inFlight = new Set());
            inFlight.add(fingerprint);
            reserved = inFlight;
          }
          const release = (): undefined => {
            if (reserved !== undefined && fingerprint !== undefined) reserved.delete(fingerprint);
            reserved = undefined;
            return undefined;
          };
          let settings: ManagedStartSettings | undefined;
          if (action === "start" || action === "add") {
            const read = readAdmissionSettings(scope);
            if (typeof read === "string") {
              settingsRefusal = read;
              return release();
            }
            // The read is owner code: re-prove the lane before admitting.
            if (!isCurrent(context)) return release();
            settings = read;
          }
          return {
            params: structuredClone(admitted.params),
            ...(action === "start" ? { startCallFingerprint: fingerprint, startSettings: settings } : {}),
            ...(action === "add" ? { addSettings: settings } : {}),
            ...(effectGuard ? { effectGuard } : {}),
          };
        },
      };
      const definition = bind(scope.manager, action, admission);
      try {
        assertCurrent(context);
        const envelope = await definition.invoke({ toolCallId });
        // Withheld once the lane fell while the call ran; the instance manager
        // discards it too. Withholding is not cancellation (see the module note).
        assertCurrent(context);
        if (duplicate !== undefined && isMissingAdmission(envelope)) return duplicateResult(toolName, duplicate);
        if (settingsRefusal !== undefined && isMissingAdmission(envelope)) return settingsRefusalResult(action, toolName, settingsRefusal);
        return toMcpResult(envelope);
      } finally {
        pending = undefined;
        if (reserved !== undefined && fingerprint !== undefined) reserved.delete(fingerprint);
      }
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCurrent(context: NativeMcpLaneContext): boolean {
  try {
    return isRecord(context)
      && context.signal instanceof AbortSignal
      && !context.signal.aborted
      && typeof context.isCurrent === "function"
      && context.isCurrent() === true;
  } catch {
    return false;
  }
}

function assertCurrent(context: NativeMcpLaneContext): void {
  if (!isCurrent(context)) throw new Error(STALE_CONTEXT);
}

/**
 * Validates one resolver answer against the exact lane context and narrows it
 * to lane-fenced actions. Each field is read once; the action list is copied
 * in one indexed pass so a hole or an accessor cannot validate one value and
 * expose another. The settings reader is looked up only when
 * `includeSettings` (discovery and Start or Add calls); otherwise neither
 * Start nor Add is offered for this call and the reader property is never read.
 */
function validateScope(raw: unknown, context: NativeMcpLaneContext, includeSettings: boolean): ResolvedScope {
  if (!isRecord(raw)) throw new Error(INVALID_SCOPE);
  const owner: unknown = raw.owner;
  const manager: unknown = raw.manager;
  const actions: unknown = raw.actions;
  if (!isRecord(owner)
    || owner.rowId !== context.rowId
    || owner.backend !== context.backend
    || owner.workspace !== context.workspace
    || owner.conversationId !== context.conversationId) {
    throw new Error(INVALID_SCOPE);
  }
  if (typeof manager !== "object" || manager === null
    || typeof (manager as NativeManagedToolManager).sharedManagedTool !== "function") {
    throw new Error(INVALID_SCOPE);
  }
  if (!Array.isArray(actions) || actions.length === 0) throw new Error(INVALID_SCOPE);
  const length = actions.length;
  const seen = new Set<SharedManagedToolAction>();
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(actions, index)) throw new Error(INVALID_SCOPE);
    const action: unknown = actions[index];
    if (!(SHARED_MANAGED_TOOL_ACTIONS as readonly unknown[]).includes(action)) throw new Error(INVALID_SCOPE);
    if (seen.has(action as SharedManagedToolAction)) throw new Error(INVALID_SCOPE);
    seen.add(action as SharedManagedToolAction);
  }
  let startLiveness: unknown;
  let readStartSettings: unknown;
  if (seen.has("start")) {
    startLiveness = (manager as NativeManagedToolManager).startLiveness;
    if (typeof startLiveness !== "function") throw new Error(INVALID_SCOPE);
  }
  if (seen.has("start") || seen.has("add")) {
    // Start and Add only: without a callable settings reader neither is
    // offered on this lane; the scope's other actions are unaffected. A
    // throwing lookup is an unavailable reader, not an invalid scope.
    if (includeSettings) {
      try {
        readStartSettings = raw.readStartSettings;
      } catch {
        readStartSettings = undefined;
      }
    }
    if (typeof readStartSettings !== "function") {
      readStartSettings = undefined;
      startLiveness = undefined;
      seen.delete("start");
      seen.delete("add");
    }
  }
  const actionsByName = new Map<string, SharedManagedToolAction>();
  for (const action of NATIVE_LANE_FENCED_ACTIONS) {
    if (seen.has(action)) actionsByName.set(EXECUTION_TOOL_NAMES[action], action);
  }
  return {
    manager: manager as NativeManagedToolManager,
    actionsByName,
    ...(startLiveness ? { startLiveness: startLiveness as NativeManagedToolManager["startLiveness"] } : {}),
    ...(readStartSettings ? { readStartSettings: readStartSettings as NativeManagedStartSettingsReader } : {}),
  };
}

/**
 * One fresh settings read for one admitted Start or Add. The answer is owner data:
 * each field is read once and copied into a new frozen record of plain data,
 * so a later edit to the owner's object or an accessor cannot swap what is
 * validated for what is admitted. The configuration must already carry every
 * required top-level runtime field (`normalizeConfig` is a parser that would
 * default a missing one) and must pass that same strict schema every settings
 * Save validates against; the parsed result is what is forwarded. The
 * canonical boundary still applies its own checks (tool names, digestible
 * configuration) and refuses a snapshot it cannot honor.
 */
function readAdmissionSettings(scope: ResolvedScope): ManagedStartSettings | StartSettingsRefusal {
  let raw: unknown;
  try {
    raw = scope.readStartSettings === undefined ? undefined : Reflect.apply(scope.readStartSettings, undefined, []);
  } catch {
    return "unavailable";
  }
  if (raw === undefined) return "unavailable";
  try {
    if (isPromise(raw)) {
      // An async reader cannot supply synchronous policy. Consume its
      // rejection, without waiting for it or using its result, so a refused
      // Start never becomes an unhandled rejection in the host process.
      void Promise.prototype.then.call(raw, undefined, () => undefined);
      return "invalid";
    }
    if (!isRecord(raw)) return "invalid";
    const config: unknown = raw.config;
    const authorizedTools: unknown = raw.authorizedTools;
    if (!isRecord(config) || !Array.isArray(authorizedTools)) return "invalid";
    const copiedConfig: unknown = structuredClone(config);
    const copiedTools: unknown = structuredClone(authorizedTools);
    if (!isRecord(copiedConfig) || !Array.isArray(copiedTools)) return "invalid";
    // The parser below reads records loosely; give it only plain settings data.
    if (!isPlainSettingsData(copiedConfig, new Set())) return "invalid";
    if (REQUIRED_CONFIG_FIELDS.some((field) => !Object.hasOwn(copiedConfig, field) || copiedConfig[field] === undefined)) {
      return "invalid";
    }
    const validatedConfig = normalizeConfig(copiedConfig);
    return Object.freeze({
      config: validatedConfig,
      authorizedTools: copiedTools as readonly string[],
    });
  } catch {
    return "invalid";
  }
}

/**
 * Whether a structured clone is plain, acyclic settings data: primitives,
 * plain arrays, and objects whose prototype is `Object.prototype` or null with
 * string keys only. A clone keeps types such as `Map`, `Set`, and `Date`, and
 * keeps cycles; the settings parser treats any non-array object as a record,
 * so it would read a `Map` as an empty section. `undefined` stays allowed so
 * the required-field check decides it. Shared, non-cyclic references are fine.
 */
function isPlainSettingsData(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || value === undefined) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return true;
  if (type !== "object") return false;
  const object = value as object;
  if (ancestors.has(object)) return false;
  const prototype: unknown = Object.getPrototypeOf(object);
  const isArray = Array.isArray(object);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(object).length > 0) return false;
  ancestors.add(object);
  try {
    for (const key of Object.keys(object)) {
      if (!isPlainSettingsData((object as Record<string, unknown>)[key], ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * The manager's liveness for this exact Start identity, read synchronously at
 * admission. Anything but a well-formed `inactive` answer (active, unknown, a
 * throw, a malformed value) withholds admission: duplicates fail closed.
 */
function startDuplicate(scope: ResolvedScope, fingerprint: string): StartDuplicate | undefined {
  let status: unknown;
  try {
    status = scope.startLiveness === undefined ? undefined : Reflect.apply(scope.startLiveness, scope.manager, [fingerprint]);
  } catch {
    status = undefined;
  }
  const state: unknown = isRecord(status) ? status.state : undefined;
  if (state === "inactive") return undefined;
  if (state !== "active") return { state: "unknown" };
  const identity: unknown = (status as Record<string, unknown>).identity;
  return typeof identity === "string" ? { state: "active", identity } : { state: "active" };
}

/** Whether a canonical envelope is the refusal for an admission that admitted nothing. */
function isMissingAdmission(envelope: unknown): boolean {
  const details: unknown = isRecord(envelope) ? envelope.details : undefined;
  return isRecord(details) && details.diagnostic === MISSING_ADMISSION_DIAGNOSTIC;
}

/** A withheld duplicate Start, in the canonical refusal's shape. Nothing is replayed. */
function duplicateResult(toolName: string, duplicate: StartDuplicate): NativeMcpCallToolResult {
  const diagnostic = duplicate.state === "active"
    ? `an identical ${toolName} request is already active${duplicate.identity === undefined ? "" : ` as ${duplicate.identity}`}`
    : duplicate.state === "in-flight"
      ? `an identical ${toolName} request from this session is still in flight; wait for its result instead of starting it again`
      : `whether an identical ${toolName} request is already active could not be verified`;
  return { content: [{ type: "text", text: `${toolName} failed closed: ${diagnostic}; nothing was started or read.` }], isError: true };
}

/** A Start or Add withheld because the owner supplied no usable settings, in the canonical refusal's shape. */
function settingsRefusalResult(action: SharedManagedToolAction, toolName: string, refusal: StartSettingsRefusal): NativeMcpCallToolResult {
  const label = action === "add" ? "Add" : "Start";
  const diagnostic = refusal === "invalid"
    ? `the owner ${label} settings snapshot is invalid`
    : `the owner ${label} settings for this request could not be read`;
  return { content: [{ type: "text", text: `${toolName} failed closed: ${diagnostic}; nothing was started or read.` }], isError: true };
}

/** The canonical binding; a manager whose owner scope is not live refuses to bind. */
function bind(manager: NativeManagedToolManager, action: SharedManagedToolAction, admission: ManagedToolAdmission): ManagedToolDefinition {
  try {
    return manager.sharedManagedTool(action, admission);
  } catch {
    throw new Error(UNBOUND_SCOPE);
  }
}

/**
 * Discovery proof without effects: binding alone proves only owner lifetime,
 * so the action is invoked once with an admission that admits nothing. The
 * canonical binding reaches that admission only after its exposure, pool,
 * live-policy, and owner-scope checks pass, and never enters the handler. It
 * re-checks its owner scope after the admission returns, so only a reached
 * probe whose canonical result is the missing-admission refusal proves the
 * action available. That diagnostic is read internally and never forwarded.
 */
async function canonicallyExposedDefinition(
  manager: NativeManagedToolManager,
  action: SharedManagedToolAction,
): Promise<ManagedToolDefinition | undefined> {
  let reached = false;
  const probe: ManagedToolAdmission = {
    resolveCall: () => {
      reached = true;
      return undefined;
    },
  };
  const definition = bind(manager, action, probe);
  const envelope = await definition.invoke({ toolCallId: `${CALL_ID_PREFIX}discovery-${randomUUID()}` });
  return reached && isMissingAdmission(envelope) ? definition : undefined;
}

/**
 * The canonical envelope as an MCP CallToolResult: the same text content items
 * and error flag. The Pi-side `details` are renderer data, not model content,
 * and are not forwarded; nothing is added.
 */
function toMcpResult(envelope: unknown): NativeMcpCallToolResult {
  if (!isRecord(envelope) || !Array.isArray(envelope.content) || envelope.content.length === 0) {
    throw new Error(INVALID_RESULT);
  }
  const content = envelope.content.map((item: unknown) => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") throw new Error(INVALID_RESULT);
    return { type: "text", text: item.text };
  });
  return { content, isError: envelope.isError === true };
}
