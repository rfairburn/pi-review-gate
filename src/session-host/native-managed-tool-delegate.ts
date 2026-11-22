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
 * (identity change, cancellation, exit), but the existing manager API carries
 * no freshness check into the controller: once the canonical handler is
 * entered, nothing re-proves the lane before the controller commits. The last
 * point this delegate can fence is the one-use admission callback, which the
 * canonical binding calls synchronously, after its exposure, pool, policy, and
 * owner-scope checks and immediately before entering the handler. Withholding
 * a result afterwards is NOT cancellation, so an action is offered on the lane
 * only when its handler commits the effect synchronously without re-entering
 * owner code that can revoke the lane. See {@linkcode NATIVE_LANE_FENCED_ACTIONS}
 * and the manager construction contract on {@linkcode NativeManagedToolScope}.
 * Every other action (Start,
 * Add, Continue, Steer, Interrupt, ForceMerge, MarkClean, and Inspect, whose
 * checkpoint backfill saves after an await) stays unavailable here even when
 * the owner exposes it, until a canonical pre-effect freshness guard exists.
 *
 * Per call, the delegate is the owner admission the shared boundary requires:
 * - it assigns its own one-use call id (never caller supplied);
 * - it snapshots the decoded arguments once and admits exactly that snapshot;
 * - the admission answers one `resolveCall` for that id and tool name, and
 *   re-proves the lane context at that moment;
 * - nothing is retried or replayed: a repeated MCP call is a new call.
 *
 * Absence is the default: without a resolver every lane lists no tools and
 * answers every call as "not exposed". Nothing here launches, registers, or
 * persists anything, and no Pi host is synthesized.
 */
import { randomUUID } from "node:crypto";
import {
  EXECUTION_TOOL_NAMES,
  SHARED_MANAGED_TOOL_ACTIONS,
  type ExecutionToolManager,
  type ManagedToolAdmission,
  type ManagedToolAdmittedCall,
  type ManagedToolDefinition,
  type SharedManagedToolAction,
} from "../execution/tool";
import type { NativeMcpLaneContext, NativeMcpLaneDelegate, NativeMcpLaneToolCall } from "./instances";
import type { NativeMcpCallToolResult, NativeMcpToolDescriptor } from "./native-mcp-stdio";
import type { NativeCliBackend } from "./session-backend";

/**
 * The part of the real `ExecutionToolManager` contract this delegate uses: the
 * canonical shared binding. The owner hands over its actual manager; this is a
 * narrowing, not a second implementation.
 */
export type NativeManagedToolManager = Pick<ExecutionToolManager, "sharedManagedTool">;

/**
 * Shared actions the native lane may offer under the scope contract on
 * {@linkcode NativeManagedToolScope}. Watch validates and arms its
 * subscription synchronously after admission, with no await, but the
 * controller reads the owner's `cwd()` between admission and arming. That read
 * is the only owner code on the path, and it must not re-enter host lifecycle
 * code (see `NativeManagedToolScope.manager`). The later checkpoint still
 * travels through the owner manager's notification delivery, which the owner
 * composes and must route to the correct owner.
 */
export const NATIVE_LANE_FENCED_ACTIONS: readonly SharedManagedToolAction[] = Object.freeze(["watch"]);

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
   * scope. The delegate never constructs, restores, syncs, detaches, or
   * reconfigures it.
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
}

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
}

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

  const resolve = (context: NativeMcpLaneContext): ResolvedScope | undefined => {
    let raw: unknown;
    try {
      raw = resolveScope(context);
    } catch {
      throw new Error(UNAVAILABLE_SCOPE);
    }
    const scope = raw === undefined ? undefined : validateScope(raw, context);
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
      const scope = resolve(context);
      const name: unknown = isRecord(call) ? call.name : undefined;
      const action = scope !== undefined && typeof name === "string" ? scope.actionsByName.get(name) : undefined;
      if (scope === undefined || action === undefined) return undefined;
      const toolName = EXECUTION_TOOL_NAMES[action];

      // The owner's own snapshot of exactly what was submitted, taken once.
      const params: unknown = structuredClone((call as NativeMcpLaneToolCall).arguments);
      const toolCallId = `${CALL_ID_PREFIX}${randomUUID()}`;
      let pending: { readonly params: unknown } | undefined = { params };
      const admission: ManagedToolAdmission = {
        // Called by the canonical binding after its exposure, pool, live
        // policy, and owner-scope checks, synchronously before the handler.
        resolveCall(id: string, resolvedName: string): ManagedToolAdmittedCall | undefined {
          const admitted = pending;
          pending = undefined;
          if (admitted === undefined || id !== toolCallId || resolvedName !== toolName || !isCurrent(context)) {
            return undefined;
          }
          return { params: structuredClone(admitted.params) };
        },
      };
      const definition = bind(scope.manager, action, admission);
      try {
        assertCurrent(context);
        const envelope = await definition.invoke({ toolCallId });
        // Withheld once the lane fell while the call ran; the instance manager
        // discards it too. Withholding is not cancellation (see the module note).
        assertCurrent(context);
        return toMcpResult(envelope);
      } finally {
        pending = undefined;
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
 * expose another.
 */
function validateScope(raw: unknown, context: NativeMcpLaneContext): ResolvedScope {
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
  const actionsByName = new Map<string, SharedManagedToolAction>();
  for (const action of NATIVE_LANE_FENCED_ACTIONS) {
    if (seen.has(action)) actionsByName.set(EXECUTION_TOOL_NAMES[action], action);
  }
  return { manager: manager as NativeManagedToolManager, actionsByName };
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
  const details: unknown = isRecord(envelope) ? envelope.details : undefined;
  return reached && isRecord(details) && details.diagnostic === MISSING_ADMISSION_DIAGNOSTIC ? definition : undefined;
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
