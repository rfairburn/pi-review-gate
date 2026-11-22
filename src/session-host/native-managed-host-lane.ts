/**
 * #682 startup composition: the production sidebar host's native MCP lane owner
 * for the canonical managed Subtasks Start and Inspect tools.
 *
 * Composition only; every rule lives in an existing module:
 * - the host's ONE existing broker is the lane registrar
 *   (`NativeMcpStatusBroker.registerNativeMcpSource`), never a second listener;
 * - the host's persisted stable MCP server name
 *   ({@linkcode readOrCreateNativeMcpServerName}); a refused name means no lane;
 * - the fixed pre-proof discovery catalog is the canonical metadata
 *   ({@linkcode sharedManagedToolDescriptor}) of exactly the actions the
 *   native owner serves; metadata only, it admits no call;
 * - {@linkcode createNativeManagedOwnerCustody} holds the native owner for each
 *   exact proved run, serializes same-tuple successors, and drains on host
 *   shutdown; the owner, its restore, the delegate, and the real
 *   `ExecutionToolManager` keep every admission, policy, and effect rule.
 *
 * One hold per proved run. The lane context's `run` object (identity, not
 * shape) keys exactly one custody hold, acquired at that run's first proved
 * call with the lane's own backend, workspace, and bound conversation.
 * A context without the run proof reaches nothing.
 *
 * Durable owner slot. The manager assigns a fresh runtime row id to every
 * launch, including the restart that resumes a remembered conversation into
 * its existing roster slot, so the runtime row id cannot key durable work.
 * The host's trusted resolver maps the runtime row to its CURRENT roster slot,
 * and that slot is the owner's association key (the owner treats its
 * `identity.rowId` as the store's slot id). A row with no slot binding reaches
 * nothing; the runtime id is never substituted. The hold stays pinned to the
 * runtime row that acquired it, so another row resolving to the same slot can
 * never use it, and every owner-facing call re-proves that the runtime row
 * still resolves to the same slot. Every call first awaits the
 * run's single preparation (bounded only by that request's own cancellation),
 * so a bound lane never lists an empty catalog while its restore is still
 * running; a preparation that is not ready lists nothing and answers every
 * call as not exposed.
 *
 * Host facts. Settings come from the host's own startup environment snapshot
 * and canonical native agent directory (the same source the local settings
 * editor reads), the Pi facts from the host's resolved Pi executable, admitted
 * version, and the exact arguments it forwards to Pi. Model scope: the host
 * runs no Pi model registry, so it has no verified Pi model scope and passes
 * none; the controller's default scope is empty, so a Pi model reviewer
 * selection stays unresolvable (fails closed) and only configured external
 * reviewers resolve. Native codemode availability is not owner-confirmed here,
 * so it stays withheld.
 *
 * Supported configurations only. The lane is armed only on a platform whose
 * native MCP launch preparation can arm a relay (Linux and macOS; Windows
 * always declines), and only when the host's startup settings snapshot is
 * available and its worker catalog is non-empty, holds no Pi-sourced worker
 * (the owner refuses those at every read, since the canonical executor would
 * launch the ambient `pi`), and every external worker resolves to an
 * execution-capable agent by the same rule `ExecutionToolManager.sync()` uses
 * to expose the tools. Otherwise no lane is armed, no server name is minted,
 * and every launch stays exactly as without one. The owner still re-reads and
 * re-checks the settings at construction and at every Start.
 *
 * Out of scope: Watch and wake/callback routing, SessionHosts/SessionSpawn,
 * new settings, and any launch approval change.
 */
import { realpathSync } from "node:fs";

import { externalAgentCatalog, externalAgentSupportsExecution, resolvedWorkerResources, type ReviewGateConfig } from "../config";
import { sharedManagedToolDescriptor, type SharedManagedToolAction } from "../execution/tool";
import type {
  NativeMcpLaneContext,
  NativeMcpLaneDelegate,
  NativeMcpLaneOwner,
  NativeMcpLaneRunScope,
  NativeMcpLaneToolCall,
  NativeMcpSourceRegistrar,
} from "./instances";
import type {
  NativeManagedConversationOwnerOptions,
  NativeManagedConversationPiHost,
} from "./native-managed-conversation-owner";
import {
  createNativeManagedOwnerCustody,
  type NativeManagedOwnerCustody,
  type NativeManagedOwnerCustodyDrainResult,
  type NativeManagedOwnerCustodyOptions,
  type NativeManagedOwnerHold,
} from "./native-managed-owner-custody";
import { readOrCreateNativeMcpServerName, type NativeMcpServerNameResult } from "./native-mcp-server-name";
import type { NativeMcpCallToolResult, NativeMcpToolDescriptor } from "./native-mcp-stdio";
import type { NativeWorkerToolPolicyDependencies } from "./native-worker-tool-policy";
import { readPersistedReviewGateSnapshot, type PersistedReviewGateSource } from "./persisted-review-gate-snapshot";
import { sessionHostStateDir } from "./roster-store";

/** The shared actions the native owner serves on its lane (Start and Inspect only). */
export const NATIVE_MANAGED_HOST_LANE_ACTIONS: readonly SharedManagedToolAction[] = Object.freeze(["start", "inspect"]);

const STALE_REQUEST = "session-host: the native managed-tool request ended before its owner was prepared";

/** Why the host armed no native managed lane; every launch then stays unchanged. */
export type NativeManagedHostLaneUnavailableReason =
  /** Native MCP launch preparation declines this platform (Windows and anything but Linux/macOS). */
  | "platform-unsupported"
  /** The broker carries no native MCP family. */
  | "no-registrar"
  /** The persisted stable server name was refused; no fixed or fresh name is substituted. */
  | "server-name-refused"
  /** The canonical session-host state root could not be established. */
  | "state-root-unavailable"
  /** The saved settings are disabled, unavailable, or invalid. */
  | "settings-unavailable"
  /** The worker catalog is empty, routes work to Pi workers, or names an agent that cannot execute. */
  | "unsupported-workers";

export interface NativeManagedHostLane {
  /** Pass as `InstanceManagerOptions.nativeMcpLane`. */
  readonly lane: NativeMcpLaneOwner;
  /** Host shutdown: close admissions, retire every hold, await every handoff. Never rejects. */
  drain(options?: { readonly signal?: AbortSignal }): Promise<NativeManagedOwnerCustodyDrainResult>;
}

export type NativeManagedHostLaneResult =
  | { readonly status: "armed"; readonly host: NativeManagedHostLane }
  | { readonly status: "unavailable"; readonly reason: NativeManagedHostLaneUnavailableReason };

export interface NativeManagedHostLaneInput {
  /** The host's platform; only Linux and macOS native launches can arm the relay. */
  readonly platform: NodeJS.Platform;
  /** The host's ONE status broker; armed only when it carries `registerNativeMcpSource`. */
  readonly broker: unknown;
  /**
   * Canonical real path of the agent directory this host exclusively owns
   * (`HostStateHandle.agentDir`). The server name and the owner association
   * store live in its private session-host state directory.
   */
  readonly ownedAgentDir: string;
  /**
   * Trusted host resolver: a runtime manager row id to its current durable
   * roster slot id, or undefined when the host holds no binding for it.
   * Synchronous and side-effect free.
   */
  readonly resolveSlotId: (rowId: string) => string | undefined;
  /** Host settings source: startup env snapshot and canonical native agent directory. */
  readonly settings: PersistedReviewGateSource;
  /** The host's resolved Pi executable, admitted version, and forwarded arguments. */
  readonly pi: NativeManagedConversationPiHost;
  /** Test-only seams; production callers never pass hooks. */
  readonly testHooks?: {
    readonly ceiling?: NativeWorkerToolPolicyDependencies;
    readonly createOwner?: NonNullable<NativeManagedOwnerCustodyOptions["testHooks"]>["createOwner"];
    readonly readOrCreateServerName?: (agentDir: string) => NativeMcpServerNameResult;
  };
}

/** The canonical pre-proof catalog of exactly the actions the owner serves. */
export function nativeManagedHostLanePreProofTools(): NativeMcpToolDescriptor[] {
  return NATIVE_MANAGED_HOST_LANE_ACTIONS.map((action) => {
    const descriptor = sharedManagedToolDescriptor(action);
    return { name: descriptor.name, description: descriptor.description, inputSchema: descriptor.parameters };
  });
}

/** Platforms whose native MCP launch preparation can arm the relay. */
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = Object.freeze(["linux", "darwin"]);

/**
 * Whether a settings snapshot names at least one worker, no Pi-sourced worker,
 * and only external workers that resolve to an execution-capable agent: the
 * same pool rule `ExecutionToolManager.sync()` applies before it exposes the
 * tools, minus Pi workers, which the native owner refuses. Fails closed.
 */
function supportedWorkers(config: Readonly<ReviewGateConfig>): boolean {
  try {
    const workers = resolvedWorkerResources(config as ReviewGateConfig);
    const agents = externalAgentCatalog(config as ReviewGateConfig);
    return workers.length > 0 && workers.every(({ selection }) => selection.source === "external"
      && agents.some((agent) => agent.id === selection.id && externalAgentSupportsExecution(agent)));
  } catch {
    return false;
  }
}

function registrarOf(broker: unknown): NativeMcpSourceRegistrar | undefined {
  if (typeof broker !== "object" || broker === null) return undefined;
  return typeof (broker as Partial<NativeMcpSourceRegistrar>).registerNativeMcpSource === "function"
    ? broker as NativeMcpSourceRegistrar
    : undefined;
}

function contextCurrent(context: NativeMcpLaneContext): boolean {
  try {
    return context.signal instanceof AbortSignal && !context.signal.aborted && context.isCurrent() === true;
  } catch {
    return false;
  }
}

function provedRun(context: NativeMcpLaneContext): NativeMcpLaneRunScope | undefined {
  const run: unknown = context?.run;
  if (typeof run !== "object" || run === null) return undefined;
  const candidate = run as Partial<NativeMcpLaneRunScope>;
  return candidate.signal instanceof AbortSignal && typeof candidate.isCurrent === "function"
    ? run as NativeMcpLaneRunScope
    : undefined;
}

/**
 * Resolve the host's native managed lane from its own startup facts, or the
 * reason none is armed. Never throws.
 */
export function createNativeManagedHostLane(input: NativeManagedHostLaneInput): NativeManagedHostLaneResult {
  if (!SUPPORTED_PLATFORMS.includes(input.platform)) return { status: "unavailable", reason: "platform-unsupported" };
  // Without the host's slot resolver no durable owner key exists.
  if (typeof input.resolveSlotId !== "function") return { status: "unavailable", reason: "state-root-unavailable" };
  const registrar = registrarOf(input.broker);
  if (registrar === undefined) return { status: "unavailable", reason: "no-registrar" };

  let stateRoot: string;
  try {
    stateRoot = sessionHostStateDir(input.ownedAgentDir);
    // The association store requires the canonical root; never substitute another.
    if (realpathSync(stateRoot) !== stateRoot) return { status: "unavailable", reason: "state-root-unavailable" };
  } catch {
    return { status: "unavailable", reason: "state-root-unavailable" };
  }

  // Bind every host fact once, so later caller mutation changes nothing.
  const settings: PersistedReviewGateSource = Object.freeze({
    env: Object.freeze({ ...input.settings.env }),
    agentDir: input.settings.agentDir,
    ...(input.settings.resolvedHomeDir === undefined ? {} : { resolvedHomeDir: input.settings.resolvedHomeDir }),
  });
  const pi: NativeManagedConversationPiHost = Object.freeze({
    executable: input.pi.executable,
    version: input.pi.version,
    launchArgs: Object.freeze([...input.pi.launchArgs]),
    ...(input.pi.nativeCodemodeAvailable === undefined ? {} : { nativeCodemodeAvailable: input.pi.nativeCodemodeAvailable }),
  });

  let snapshot: ReturnType<typeof readPersistedReviewGateSnapshot>;
  try {
    snapshot = readPersistedReviewGateSnapshot(settings);
  } catch {
    return { status: "unavailable", reason: "settings-unavailable" };
  }
  if (snapshot.status !== "available") return { status: "unavailable", reason: "settings-unavailable" };
  if (!supportedWorkers(snapshot.config)) return { status: "unavailable", reason: "unsupported-workers" };

  let named: NativeMcpServerNameResult;
  try {
    named = (input.testHooks?.readOrCreateServerName ?? readOrCreateNativeMcpServerName)(input.ownedAgentDir);
  } catch {
    return { status: "unavailable", reason: "server-name-refused" };
  }
  if (named.status !== "loaded" && named.status !== "created") return { status: "unavailable", reason: "server-name-refused" };

  const createOwner = input.testHooks?.createOwner;
  const custody: NativeManagedOwnerCustody = createNativeManagedOwnerCustody({
    stateRoot,
    ...(createOwner === undefined ? {} : { testHooks: { createOwner } }),
  });
  const ceiling = input.testHooks?.ceiling;
  const resolveSlotId = input.resolveSlotId;
  /** One run's hold, pinned to the runtime row that acquired it and that row's slot. */
  interface Binding {
    readonly rowId: string;
    readonly slotId: string;
    readonly hold: NativeManagedOwnerHold;
  }
  const holds = new WeakMap<NativeMcpLaneRunScope, Binding>();

  const slotOf = (rowId: string): string | undefined => {
    try {
      const slotId = resolveSlotId(rowId);
      return typeof slotId === "string" && slotId !== "" ? slotId : undefined;
    } catch {
      return undefined;
    }
  };

  /** The run's one hold, acquired at its first proved, current, slot-bound call; otherwise none. */
  const holdFor = (context: NativeMcpLaneContext): Binding | undefined => {
    const run = provedRun(context);
    if (run === undefined) return undefined;
    const { rowId, backend, workspace, conversationId } = context;
    const slotId = slotOf(rowId);
    if (slotId === undefined) return undefined;
    const existing = holds.get(run);
    if (existing !== undefined) return existing.rowId === rowId && existing.slotId === slotId ? existing : undefined;
    if (!contextCurrent(context)) return undefined;
    const options: Omit<NativeManagedConversationOwnerOptions, "stateRoot"> = {
      run,
      // The owner keys its durable associations by this id: the roster slot.
      identity: { rowId: slotId, backend, workspace, conversationId },
      settings,
      pi,
      ...(ceiling === undefined ? {} : { testHooks: { ceiling } }),
    };
    let hold: NativeManagedOwnerHold;
    try {
      hold = custody.acquire(options);
    } catch {
      return undefined;
    }
    const binding: Binding = Object.freeze({ rowId, slotId, hold });
    holds.set(run, binding);
    return binding;
  };

  /**
   * The owner-facing context: the same run, request signal, and runtime proof,
   * with the owner's slot as its row, re-proving the runtime row's slot binding.
   */
  const ownerContext = (context: NativeMcpLaneContext, binding: Binding): NativeMcpLaneContext => Object.freeze({
    ...context,
    rowId: binding.slotId,
    isCurrent: () => contextCurrent(context) && slotOf(binding.rowId) === binding.slotId,
  });

  /** Await the run's single preparation, never past this request's own cancellation. */
  const ready = async (hold: NativeManagedOwnerHold, context: NativeMcpLaneContext): Promise<boolean> => {
    const signal = context.signal;
    if (signal.aborted) throw new Error(STALE_REQUEST);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([hold.prepare(), aborted]);
      if (outcome === "aborted") throw new Error(STALE_REQUEST);
      return outcome.status === "ready";
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  };

  const delegate: NativeMcpLaneDelegate = Object.freeze({
    async listTools(context: NativeMcpLaneContext): Promise<readonly NativeMcpToolDescriptor[]> {
      const binding = holdFor(context);
      if (binding === undefined || !await ready(binding.hold, context)) return [];
      return binding.hold.delegate.listTools(ownerContext(context, binding));
    },
    async callTool(context: NativeMcpLaneContext, call: NativeMcpLaneToolCall): Promise<NativeMcpCallToolResult | undefined> {
      const binding = holdFor(context);
      if (binding === undefined || !await ready(binding.hold, context)) return undefined;
      return binding.hold.delegate.callTool(ownerContext(context, binding), call);
    },
  });

  const lane: NativeMcpLaneOwner = Object.freeze({
    registrar,
    serverName: named.serverName,
    delegate,
    preProofTools: Object.freeze(nativeManagedHostLanePreProofTools()),
  });
  return {
    status: "armed",
    host: Object.freeze({ lane, drain: (options?: { readonly signal?: AbortSignal }) => custody.drain(options) }),
  };
}
