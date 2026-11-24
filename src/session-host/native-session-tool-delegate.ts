/**
 * #682: native MCP lane delegate for the canonical SessionHosts and
 * SessionSpawn tools.
 *
 * It is an ADAPTER, not an engine. A native MCP `tools/list` or `tools/call`
 * reaches it only after `InstanceManager` proved the call's
 * {@linkcode NativeMcpLaneContext}. It binds the one canonical definition of
 * each tool ({@linkcode sessionHostsToolDefinition},
 * {@linkcode sessionSpawnToolDefinition}) to a host-supplied
 * {@linkcode SessionHostSpawnCapability}, so schemas, argument validation,
 * selector gating, the capability call, and result/error text all stay in the
 * code Pi registration uses.
 *
 * Authority comes from exactly two host-side places:
 * - the frozen lane context the instance manager built from its own records;
 * - an injected, trusted {@linkcode NativeSessionToolHostResolver} that maps
 *   that exact context (including its exact-run scope object) to an EXISTING
 *   capability, echoing the identity it resolved for.
 * Nothing here constructs, publishes, or widens a capability, and there is no
 * fallback: without a resolver answer neither tool is listed or callable. The
 * JSON-RPC id, `_meta`, client info, and argument values are request data
 * only.
 *
 * Lane freshness. Each list and call resolves the capability afresh under the
 * current proof. The capability the canonical definition binds is a fenced
 * view: it re-proves the lane immediately before invoking the real
 * `spawn`/`inspectHosts`, so a stale or revoked lane never reaches the
 * capability. The call's own `signal` (client cancellation or lane revocation)
 * is passed unchanged to the canonical handler and so to the capability. That
 * is a request to stop, NOT a rollback: a launch the capability already sent
 * may still start. A result produced after the lane fell is withheld (the
 * instance manager discards it too); withholding is not cancellation either.
 *
 * Errors. A canonical model-facing refusal (invalid arguments, an undeclared
 * selector, an unavailable SessionHosts inspection) is forwarded as an MCP
 * `isError` result with the canonical text. A capability that throws or
 * rejects, and a stale lane, reject instead, which the MCP transport answers
 * with its fixed "effects unknown" failure and never retries.
 *
 * Ordering. The canonical SessionSpawn definition is `executionMode:
 * "sequential"`, which Pi honors per session; here calls of a sequential tool
 * are serialized per exact lane run. A queued call that is cancelled or whose
 * lane falls never reaches the capability, and a queued call resolves its
 * capability afresh when its turn arrives: if the host no longer supplies one,
 * the call is not handled here (as for an unlisted tool).
 */
import { sessionHostsToolDefinition, type SessionHostsToolDefinition, SESSION_HOSTS_TOOL_NAME } from "./hosts-tool";
import { sessionSpawnToolDefinition, type SessionSpawnToolDefinition, SESSION_SPAWN_TOOL_NAME } from "./spawn-tool";
import type { SessionHostSpawnCapability } from "./spawn-capability";
import type { NativeMcpLaneContext, NativeMcpLaneDelegate, NativeMcpLaneRunScope, NativeMcpLaneToolCall } from "./instances";
import type { NativeMcpCallToolResult, NativeMcpToolDescriptor } from "./native-mcp-stdio";
import type { NativeCliBackend } from "./session-backend";

/** The exact lane identity a capability was resolved for, echoed back by the resolver. */
export interface NativeSessionToolOwnerIdentity {
  readonly rowId: string;
  readonly backend: NativeCliBackend;
  readonly workspace: string;
  readonly conversationId: string;
  /** The SAME exact-run scope object as the context's `run`; a different launch never matches. */
  readonly run: NativeMcpLaneRunScope;
}

/** What the trusted resolver returns for ONE proved lane request. */
export interface NativeSessionToolScope {
  /** Must equal the context's row, backend, workspace, conversation, and run object. */
  readonly owner: NativeSessionToolOwnerIdentity;
  /** The existing host-owned capability for exactly that lane; never constructed here. */
  readonly capability: SessionHostSpawnCapability;
}

/**
 * Trusted, synchronous owner resolver: the frozen, host-proved lane context
 * in, the exact lane's capability out, or `undefined` when neither tool is
 * available for it. Synchronous so no await separates the proof from use.
 */
export type NativeSessionToolHostResolver = (context: NativeMcpLaneContext) => NativeSessionToolScope | undefined;

/** The default resolver: no capability, so neither tool is exposed on any lane. */
export const unavailableNativeSessionToolHost: NativeSessionToolHostResolver = () => undefined;

export interface NativeSessionToolDelegateOptions {
  /** Defaults to {@linkcode unavailableNativeSessionToolHost}. */
  readonly resolveHost?: NativeSessionToolHostResolver;
}

type SessionToolDefinition = SessionHostsToolDefinition | SessionSpawnToolDefinition;

/** Per-call fence state shared between the fenced capability view and the delegate. */
interface CallFence {
  /**
   * The lane fell before a capability effect, or the real capability threw or
   * rejected (its effects are unknown): the error text is never forwarded.
   */
  withhold: boolean;
}

const STALE_CONTEXT = "session-host: the native session-tool call has no current proved lane context";
const INVALID_SCOPE = "session-host: the native session-tool host capability is invalid for this lane";
const UNAVAILABLE_SCOPE = "session-host: the native session-tool host capability could not be resolved";
const INVALID_RESULT = "session-host: the session tool returned a result the native lane cannot forward";

/** Builds the delegate. With no resolver it exposes nothing. */
export function createNativeSessionToolDelegate(options: NativeSessionToolDelegateOptions = {}): NativeMcpLaneDelegate {
  const resolveHost = options.resolveHost ?? unavailableNativeSessionToolHost;
  if (typeof resolveHost !== "function") {
    throw new Error("session-host: a native session-tool delegate requires a host resolver function");
  }
  // An entry means a sequential call is active on that exact lane run; its set
  // holds the live waiters in FIFO order.
  const sequentialWaiters = new WeakMap<NativeMcpLaneRunScope, Set<() => void>>();

  const definitions = (context: NativeMcpLaneContext, fence: CallFence): readonly SessionToolDefinition[] => {
    // Without an exact-run scope the lane cannot be tied to one launch: absent.
    if (!isRecord(context.run)) return [];
    let raw: unknown;
    try {
      raw = resolveHost(context);
    } catch {
      throw new Error(UNAVAILABLE_SCOPE);
    }
    const capability = raw === undefined ? undefined : fencedCapability(raw, context, fence);
    // The resolver is owner code: re-prove the lane before using its answer.
    assertCurrent(context);
    if (capability === undefined) return [];
    const tools: SessionToolDefinition[] = [];
    const hosts = sessionHostsToolDefinition(capability);
    if (hosts !== undefined) tools.push(hosts);
    const spawn = sessionSpawnToolDefinition(capability);
    if (spawn !== undefined) tools.push(spawn);
    return tools;
  };

  return Object.freeze({
    async listTools(context: NativeMcpLaneContext): Promise<readonly NativeMcpToolDescriptor[]> {
      assertCurrent(context);
      return definitions(context, { withhold: false }).map(descriptor);
    },

    async callTool(context: NativeMcpLaneContext, call: NativeMcpLaneToolCall): Promise<NativeMcpCallToolResult | undefined> {
      assertCurrent(context);
      const name: unknown = isRecord(call) ? call.name : undefined;
      if (name !== SESSION_HOSTS_TOOL_NAME && name !== SESSION_SPAWN_TOOL_NAME) return undefined;
      // Binds the tool under the proof current at this moment: a fresh resolver
      // answer, a fresh fence, and the canonical definition for that answer.
      const bind = (): { definition: SessionToolDefinition; fence: CallFence } | undefined => {
        const fence: CallFence = { withhold: false };
        const definition = definitions(context, fence).find((candidate) => candidate.name === name);
        return definition === undefined ? undefined : { definition, fence };
      };
      const initial = bind();
      if (initial === undefined) return undefined;
      // The owner's own snapshot of exactly what was submitted, taken once.
      const params: unknown = structuredClone((call as NativeMcpLaneToolCall).arguments);
      const execute = async ({ definition, fence }: { definition: SessionToolDefinition; fence: CallFence }): Promise<NativeMcpCallToolResult> => {
        assertCurrent(context);
        let envelope: unknown;
        try {
          envelope = await definition.execute(params, context.signal);
        } catch (error) {
          assertCurrent(context);
          if (fence.withhold || !(error instanceof Error)) throw error;
          // A canonical model-facing refusal, exactly as Pi would show it.
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
        // Withheld once the lane fell while the call ran (see the module note).
        assertCurrent(context);
        return toMcpResult(envelope);
      };
      if (!("executionMode" in initial.definition && initial.definition.executionMode === "sequential")) {
        return execute(initial);
      }
      // A queued call binds its capability only when its turn arrives, so a
      // capability the host stopped supplying while it waited is never invoked.
      return sequential(sequentialWaiters, context, async () => {
        assertCurrent(context);
        const bound = bind();
        return bound === undefined ? undefined : execute(bound);
      });
    },
  });
}

/**
 * Validates the resolver answer against the exact lane context and returns a
 * frozen capability view whose effects re-prove the lane first. Each field is
 * read once, so an accessor cannot validate one value and expose another.
 */
function fencedCapability(raw: unknown, context: NativeMcpLaneContext, fence: CallFence): SessionHostSpawnCapability {
  let real: unknown;
  let titleColumns: unknown;
  let routing: unknown;
  let createWorkspace: unknown;
  let spawn: unknown;
  let inspectHosts: unknown;
  try {
    if (!isRecord(raw)) throw new Error(INVALID_SCOPE);
    const owner: unknown = raw.owner;
    real = raw.capability;
    if (!isRecord(owner)
      || owner.rowId !== context.rowId
      || owner.backend !== context.backend
      || owner.workspace !== context.workspace
      || owner.conversationId !== context.conversationId
      || owner.run !== context.run
      || !isRecord(real)) {
      throw new Error(INVALID_SCOPE);
    }
    titleColumns = real.titleColumns;
    routing = real.routing;
    createWorkspace = real.createWorkspace;
    spawn = real.spawn;
    inspectHosts = real.inspectHosts;
  } catch {
    throw new Error(INVALID_SCOPE);
  }
  const spawnMethod = spawn;
  const inspectMethod = inspectHosts;
  if (typeof spawnMethod !== "function") throw new Error(INVALID_SCOPE);
  const invoke = <T>(method: Function, args: unknown[]): Promise<T> => {
    // Immediately before the effect: a stale lane never reaches the capability.
    if (!isCurrent(context)) {
      fence.withhold = true;
      return Promise.reject(new Error(STALE_CONTEXT));
    }
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(Reflect.apply(method, real, args) as T | Promise<T>);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.catch((error: unknown) => {
      fence.withhold = true;
      throw error;
    });
  };
  return Object.freeze({
    titleColumns: titleColumns as number,
    ...(routing === true ? { routing: true } : {}),
    ...(createWorkspace === true ? { createWorkspace: true } : {}),
    spawn: (input, signal) => invoke(spawnMethod, [input, signal]),
    ...(typeof inspectMethod === "function"
      ? { inspectHosts: (signal?: AbortSignal) => invoke(inspectMethod, [signal]) }
      : {}),
  } satisfies SessionHostSpawnCapability);
}

/**
 * Runs `task` after every earlier sequential call on the same exact lane run
 * settled, in arrival order. A wait ends early, without running `task`, when
 * the call's signal aborts (client cancellation or lane revocation); the
 * cancelled waiter and its abort listener are removed immediately, so retained
 * queue state is bounded by live requests, not by cancellations. `task`
 * itself re-proves the lane and re-binds the capability first. The active call
 * keeps the run entry until it settles and hands the turn to the oldest live
 * waiter, so cancellation never lets two calls run at once.
 */
async function sequential<T>(
  queues: WeakMap<NativeMcpLaneRunScope, Set<() => void>>,
  context: NativeMcpLaneContext,
  task: () => Promise<T>,
): Promise<T> {
  const run = context.run as NativeMcpLaneRunScope;
  const signal = context.signal;
  if (signal.aborted) throw new Error(STALE_CONTEXT);
  let waiters = queues.get(run);
  if (waiters === undefined) {
    waiters = new Set();
    queues.set(run, waiters);
  } else {
    const pending = waiters;
    await new Promise<void>((resolve, reject) => {
      const takeTurn = (): void => {
        pending.delete(takeTurn);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        pending.delete(takeTurn);
        signal.removeEventListener("abort", onAbort);
        reject(new Error(STALE_CONTEXT));
      };
      pending.add(takeTurn);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  try {
    return await task();
  } finally {
    const next: (() => void) | undefined = waiters.values().next().value;
    if (next === undefined) queues.delete(run);
    else next();
  }
}

function descriptor(definition: SessionToolDefinition): NativeMcpToolDescriptor {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: structuredClone(definition.parameters),
    ...("outputSchema" in definition ? { outputSchema: structuredClone(definition.outputSchema) } : {}),
    ...("annotations" in definition ? { annotations: { ...definition.annotations } } : {}),
  };
}

/**
 * The canonical envelope as an MCP CallToolResult: the same text content,
 * error flag, and structured content. The Pi-side `details` are renderer data,
 * not model content, and are not forwarded; nothing is added.
 */
function toMcpResult(envelope: unknown): NativeMcpCallToolResult {
  if (!isRecord(envelope) || !Array.isArray(envelope.content) || envelope.content.length === 0) {
    throw new Error(INVALID_RESULT);
  }
  const content = envelope.content.map((item: unknown) => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") throw new Error(INVALID_RESULT);
    return { type: "text", text: item.text };
  });
  const structured: unknown = envelope.structuredContent;
  if (structured !== undefined && !isRecord(structured)) throw new Error(INVALID_RESULT);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structuredClone(structured) } : {}),
    isError: envelope.isError === true,
  };
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
