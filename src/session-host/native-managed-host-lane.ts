/**
 * #682 startup composition: the production sidebar host's native MCP lane owner
 * for the canonical managed Subtasks Start, Add, Inspect, Continue, Steer,
 * Interrupt, ForceMerge, and MarkClean tools, the canonical one-shot Watch
 * on runs with a current delivery sender, and, when the host
 * supplies its session-tool facts, the canonical SessionHosts and SessionSpawn
 * tools.
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
 * may pass the selectors of its offline settings catalog for the same Pi
 * facts (no authenticated availability claim and no Pi process), forwarded to
 * every owner; without them the controller's default scope is empty, so a Pi
 * model reviewer selection stays unresolvable (fails closed) and only
 * configured external reviewers resolve. Pi workers and in-scope Pi
 * reviewers launch through the owner's admitted Pi executable. Native
 * codemode availability is not owner-confirmed here, so it stays withheld.
 *
 * Supported configurations only. The lane is armed only on a platform whose
 * native MCP launch preparation can arm a relay (Linux, macOS, and Windows;
 * any other platform declines), and only when the host's startup settings snapshot is
 * available and its worker catalog is non-empty and every external worker
 * resolves to an execution-capable agent by the same rule `ExecutionToolManager.sync()` uses
 * to expose the tools. Otherwise no lane is armed, no server name is minted,
 * and every launch stays exactly as without one. The owner still re-reads and
 * re-checks the settings at construction and at every Start.
 *
 * Session tools. SessionHosts and SessionSpawn ride the same armed lane (the
 * activation policy above is unchanged) through
 * {@linkcode createNativeSessionToolDelegate}, resolved by the host's trusted
 * `InstanceManager.nativeSessionToolScope`. A session-tool call never touches
 * the managed owner: no hold, slot, restore, or execution manager is consulted,
 * and the delegate receives the ORIGINAL proved lane context the manager issued
 * (never the slot-keyed owner view), because the manager honors only its own
 * in-flight context object. Each list and call re-resolves the exact row's
 * current routed authority, so nothing is granted before proof. A proved
 * `tools/list` is ONE response that also carries Start/Add/Inspect, so it keeps the
 * managed rule above: on a slot-bound row it answers once that run's single
 * preparation settles (or the request is cancelled), whatever the outcome; the
 * session entries depend on that settling, never on a successful restore. Their
 * early discovery entries come from the canonical metadata builders
 * ({@linkcode sessionHostsToolMetadata}, {@linkcode sessionSpawnToolMetadata})
 * for the host's startup facts: the same declarations Main gives the manager and
 * its title-space snapshot at startup, worded as such (see
 * {@linkcode nativeSessionToolPreProofTools}). Like the managed entries, they are
 * metadata only and admit no call.
 *
 * Claude completion delivery. Given the host's trusted, owner-only Claude
 * inbox accessor ({@linkcode NativeManagedHostLaneClaudeInbox}, Main passes
 * `InstanceManager.nativeClaudeInboxSender`), each Claude hold's owner receives
 * ONE run-bound `nativeEventSink` (no new event abstraction: the canonical
 * {@linkcode ManagedNativeEventSink}), which then is the sole transport for that
 * owner's canonical outcome events. The sink is scoped to the subscription, not
 * to the MCP request that acquired the hold: it captures the trusted RUNTIME row
 * id, the exact run object, and the bound conversation at acquisition (never the
 * persisted slot as a target), and per event re-proves, in order, that the run
 * is current, the runtime row still resolves to the hold's slot, and the
 * manager's sender for THAT runtime row is current and bound to the same
 * conversation. Anything else sends nothing: a successor run, another row, a
 * different conversation, or a revoked binding is never targeted instead, and
 * there is no PTY fallback. One send attempt per event, serialized per run and
 * cancelled by the run's own revocation signal; its result is never a delivery
 * claim (`sent_unconfirmed` is the best outcome), a refused or unknown attempt
 * is a sink failure (the canonical one-shot diagnostic, which reaches only an
 * owner `notify`, and this lane wires none), and nothing is retried or replayed.
 * Every hold without the accessor gets no sink and stays exactly as before.
 *
 * Codex completion delivery. Given the host's trusted, owner-only Codex
 * callback accessor ({@linkcode NativeManagedHostLaneCodexCallback}, Main
 * passes `InstanceManager.nativeCodexCallbackSender`), each Codex hold's owner
 * receives ONE run-bound `nativeEventSink` of the same canonical shape. It
 * captures the trusted runtime row id, the exact run object, and the bound
 * conversation at acquisition, exactly like the Claude sink, and per event
 * re-proves, in order: the run is current, the runtime row still resolves to
 * the hold's slot, and the manager's sender for THAT row is current and bound
 * to the same conversation (the owned root thread). The first such sender is
 * pinned: a later different sender (another lane, lease, or generation) is
 * never targeted. Canonical outcomes (completion, failure, and the existing
 * eligible state wakes) and one-shot Watch checkpoints are delivered alike,
 * under the same fences. Each event makes one attempt
 * through the sender's landed transport and composer (busy steer or idle
 * queue, re-proved at the write edge, closed right after), serialized per run
 * and cancelled by the run's own revocation. `sent-unconfirmed` and
 * `turn-started` are the best outcomes and never a read receipt; a
 * not-delivered or unknown attempt is a sink failure, never retried, and
 * there is no PTY, approval-reply, or `turn/start` fallback.
 *
 * Watch. Given either accessor, the lane's fixed `deliveryTools` catalog is
 * the canonical Watch metadata ({@linkcode nativeManagedHostLaneDeliveryTools}),
 * which the instance manager appends to metadata-only discovery only for a run
 * that kept its lane and its own verified delivery receipt (and, on the Codex
 * handshake seam only, to the owner's own proved answer while the lane is bound
 * to the candidate thread before its root binds). Every call, and otherwise
 * proved discovery, are the owner's: each hold that receives a sink also receives
 * that sink's run-bound `watchDeliveryCurrent` predicate, which re-proves, in
 * the sink's own order and without side effects, that the run is current, the
 * runtime row still resolves to the hold's slot, and the row's sender is
 * current and bound to the same conversation (Codex: and is the pinned sender
 * once one is pinned). The owner's live call policy reads it for discovery and
 * synchronously immediately before each Watch admission, so a run without a
 * live sender neither lists nor arms Watch, and a refused call leaves an
 * already armed watch untouched. An armed watch reuses the controller's single
 * per-execution timer and supersession; its checkpoint takes the sink's one
 * attempt (never a guaranteed turn), with no retry. Watch never rides the
 * session tools, and a hold without a sink has no Watch.
 *
 * Managed activity projection. The lane's optional `activity` view
 * ({@linkcode NativeMcpLaneActivity}) reports each exact held run's managed task
 * contribution from the owning controller's canonical census
 * (`ExecutionToolManager.activityCensus()`); this module keeps no task counter,
 * only the last fresh census read per run, re-read on every census signal.
 * Per run: no hold is `none`. A preparation that did not settle `ready`
 * (failed, unavailable, stale, or refused, with or without a retained manager)
 * is `unknown` for good: no census but a ready one is read, and a clean custody
 * settlement without a ready manager never proves the restore found no work.
 * A ready, non-retiring run keeps its last published count during a refresh,
 * including a `settling` read (the owner's own pending save or admission,
 * which signals again when it settles; never a count, never zero).
 * An unsuperseded incomplete read makes it `unknown`, as do pending preparation,
 * an absent census, or retirement with its handoff still under way. A ready
 * run's clean handoff is `none` (its work
 * was handed back to the durable store); a failed one stays `unknown`. A transition notifies with the exact run object,
 * so the manager redraws only the row whose current run it is. Nothing here
 * polls or changes Stop, ownership, or any handoff.
 *
 * Out of scope: new settings, delivery retry, and any launch approval change.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

import { externalAgentCatalog, externalAgentSupportsExecution, resolvedWorkerResources, type ReviewGateConfig } from "../config";
import type { HostActivityCensus, HostActivityCensusRead } from "../execution/background-controller";
import { sharedManagedToolDescriptor, type SharedManagedToolAction } from "../execution/tool";
import { SESSION_HOSTS_TOOL_NAME, sessionHostsToolMetadata } from "./hosts-tool";
import type { ManagedNativeEvent, ManagedNativeEventSink } from "../execution/wake-delivery";
import type {
  NativeClaudeInboxSender,
  NativeCodexCallbackSender,
  NativeMcpLaneActivity,
  NativeMcpLaneActivityContribution,
  NativeMcpLaneContext,
  NativeMcpLaneDelegate,
  NativeMcpLaneOwner,
  NativeMcpLaneRunScope,
  NativeMcpLaneToolCall,
  NativeMcpSourceRegistrar,
} from "./instances";
import { sendClaudeInboxMessage } from "./native-claude-inbox-delivery";
import type {
  NativeManagedConversationOwnerOptions,
  NativeManagedConversationPiHost,
} from "./native-managed-conversation-owner";
import {
  createNativeManagedOwnerCustody,
  type NativeManagedOwnerCustody,
  type NativeManagedOwnerCustodyDrainResult,
  type NativeManagedOwnerCustodyOptions,
  type NativeManagedOwnerCustodyPrepareResult,
  type NativeManagedOwnerHandoff,
  type NativeManagedOwnerHold,
} from "./native-managed-owner-custody";
import { readOrCreateNativeMcpServerName, type NativeMcpServerNameResult } from "./native-mcp-server-name";
import type { NativeMcpCallToolResult, NativeMcpToolDescriptor } from "./native-mcp-stdio";
import type { NativeWorkerToolPolicyDependencies } from "./native-worker-tool-policy";
import { createNativeSessionToolDelegate, type NativeSessionToolHostResolver } from "./native-session-tool-delegate";
import { readPersistedReviewGateSnapshot, type PersistedReviewGateSource } from "./persisted-review-gate-snapshot";
import { sessionHostStateDir } from "./roster-store";
import { SESSION_SPAWN_TOOL_NAME, sessionSpawnToolMetadata } from "./spawn-tool";

/** The shared actions the native owner serves on its lane (Start, Add, Inspect, Continue, Steer, Interrupt, ForceMerge, and MarkClean only). */
export const NATIVE_MANAGED_HOST_LANE_ACTIONS: readonly SharedManagedToolAction[] = Object.freeze([
  "start", "add", "inspect", "continue", "steer", "interrupt", "force_merge", "mark_clean",
]);

/**
 * The shared actions offered only on runs with a current delivery sender
 * (Watch only), listed through the receipt-gated `deliveryTools` catalog.
 */
export const NATIVE_MANAGED_HOST_LANE_DELIVERY_ACTIONS: readonly SharedManagedToolAction[] = Object.freeze(["watch"]);

const STALE_REQUEST = "session-host: the native managed-tool request ended before its owner was prepared";

/** Why the host armed no native managed lane; every launch then stays unchanged. */
export type NativeManagedHostLaneUnavailableReason =
  /** Native MCP launch preparation declines this platform (anything but Linux, macOS, or Windows). */
  | "platform-unsupported"
  /** The broker carries no native MCP family. */
  | "no-registrar"
  /** The persisted stable server name was refused; no fixed or fresh name is substituted. */
  | "server-name-refused"
  /** The canonical session-host state root could not be established. */
  | "state-root-unavailable"
  /** The saved settings are disabled, unavailable, or invalid. */
  | "settings-unavailable"
  /** The worker catalog is empty or names an external agent that cannot execute. */
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

/**
 * The host's descriptive startup facts for the native session tools. They must be
 * the same declarations the host gives the `InstanceManager` whose
 * `nativeSessionToolScope` is the resolver; they shape early discovery only and
 * grant nothing.
 */
export interface NativeManagedHostLaneSessionToolFacts {
  /** The host's sidebar title-space snapshot at startup (`getSidebarTitleColumns`). */
  readonly titleColumns: number;
  /** The manager receives `onSessionHostsRequest` beside its routed spawn handler. */
  readonly inspection: boolean;
  /** The manager receives `routedSpawnCreateWorkspace: true`. */
  readonly createWorkspace: boolean;
}

/**
 * The OPTIONAL Claude inbox accessor for canonical completion delivery. It must
 * be the host manager's own `InstanceManager.nativeClaudeInboxSender`: trusted,
 * synchronous, side-effect free, and keyed by the RUNTIME row id. Undefined
 * means no sender for that row right now.
 */
export interface NativeManagedHostLaneClaudeInbox {
  readonly senderFor: (rowId: string) => NativeClaudeInboxSender | undefined;
}

/**
 * The OPTIONAL Codex callback accessor for canonical completion delivery. It
 * must be the host manager's own `InstanceManager.nativeCodexCallbackSender`:
 * trusted, synchronous, side-effect free, and keyed by the RUNTIME row id.
 * Undefined means no sender for that row right now.
 */
export interface NativeManagedHostLaneCodexCallback {
  readonly senderFor: (rowId: string) => NativeCodexCallbackSender | undefined;
}

/** The OPTIONAL native SessionHosts/SessionSpawn wiring of the armed lane. */
export interface NativeManagedHostLaneSessionTools {
  /**
   * Trusted, synchronous resolver: the host manager's own
   * `InstanceManager.nativeSessionToolScope`, called with the original proved
   * lane context. Undefined means neither tool exists for that call.
   */
  readonly resolveScope: NativeSessionToolHostResolver;
  /** Descriptive startup facts for the early discovery catalog. */
  readonly startup: NativeManagedHostLaneSessionToolFacts;
}

export interface NativeManagedHostLaneInput {
  /** The host's platform; only Linux, macOS, and Windows native launches can arm the relay. */
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
  /**
   * OPTIONAL host model scope selectors (offline catalog of the same Pi
   * facts), forwarded to every owner for scoped worker and reviewer routing.
   * Absence keeps owners without a scope.
   */
  readonly scopedModels?: readonly string[];
  /**
   * OPTIONAL SessionHosts/SessionSpawn wiring on the same armed lane. Absence (or
   * an invalid value) keeps the lane exactly Start/Add/Inspect.
   */
  readonly sessionTools?: NativeManagedHostLaneSessionTools;
  /**
   * OPTIONAL Claude completion delivery through the exact run's inbox sender.
   * Absence (or an invalid value) gives no hold a sink: every owner stays
   * exactly as without one.
   */
  readonly claudeInbox?: NativeManagedHostLaneClaudeInbox;
  /**
   * OPTIONAL Codex completion delivery through the exact run's callback sender.
   * Absence (or an invalid value) gives no Codex hold a sink.
   */
  readonly codexCallback?: NativeManagedHostLaneCodexCallback;
  /** Test-only seams; production callers never pass hooks. */
  readonly testHooks?: {
    readonly ceiling?: NativeWorkerToolPolicyDependencies;
    readonly createOwner?: NonNullable<NativeManagedOwnerCustodyOptions["testHooks"]>["createOwner"];
    readonly readOrCreateServerName?: (agentDir: string) => NativeMcpServerNameResult;
  };
}

/**
 * The canonical pre-proof catalog of exactly the actions the owner serves, then,
 * given the host's session-tool startup facts, the session tools those facts
 * describe ({@linkcode nativeSessionToolPreProofTools}).
 */
export function nativeManagedHostLanePreProofTools(sessionTools?: NativeManagedHostLaneSessionToolFacts): NativeMcpToolDescriptor[] {
  const managed = NATIVE_MANAGED_HOST_LANE_ACTIONS.map((action) => {
    const descriptor = sharedManagedToolDescriptor(action);
    return { name: descriptor.name, description: descriptor.description, inputSchema: descriptor.parameters };
  });
  return sessionTools === undefined ? managed : [...managed, ...nativeSessionToolPreProofTools(sessionTools)];
}

/**
 * The canonical metadata of the delivery-gated actions, for the lane's
 * receipt-gated `deliveryTools` discovery catalog. Metadata only; it admits no
 * call.
 */
export function nativeManagedHostLaneDeliveryTools(): NativeMcpToolDescriptor[] {
  return NATIVE_MANAGED_HOST_LANE_DELIVERY_ACTIONS.map((action) => {
    const descriptor = sharedManagedToolDescriptor(action);
    return { name: descriptor.name, description: descriptor.description, inputSchema: descriptor.parameters };
  });
}

/**
 * The canonical early metadata of the session tools a native lane scope carries
 * for these host facts, in the delegate's listing order: SessionHosts only with
 * the inspection, SessionSpawn (always routed on a native lane) only with a valid
 * title-space snapshot. Metadata only; it admits no call.
 *
 * Two bounded differences from the proved definitions, both forced by the
 * manager's constructor-fixed pre-proof catalog:
 * - SessionSpawn's title-space wording names the HOST-STARTUP snapshot (the
 *   catalog cannot follow a resize before a later launch); exact launch-time
 *   wording would need a per-launch metadata source in `InstanceManager`.
 * - SessionHosts carries name, description, and input schema only:
 *   `copyNativeMcpPreProofTools` accepts no `outputSchema` or `annotations`.
 *   The proved listing carries both.
 */
export function nativeSessionToolPreProofTools(facts: NativeManagedHostLaneSessionToolFacts): NativeMcpToolDescriptor[] {
  const tools: NativeMcpToolDescriptor[] = [];
  if (facts.inspection === true) {
    const hosts = sessionHostsToolMetadata();
    tools.push({ name: hosts.name, description: hosts.description, inputSchema: structuredClone(hosts.parameters) });
  }
  const spawn = sessionSpawnToolMetadata({
    titleColumns: facts.titleColumns,
    routing: true,
    inspection: facts.inspection === true,
    createWorkspace: facts.createWorkspace === true,
    // Fixed once at host startup and answered for every later launch: the
    // wording names the startup snapshot, never a launch it cannot describe.
    titleSnapshot: "host-startup",
  });
  if (spawn !== undefined) {
    tools.push({ name: spawn.name, description: spawn.description, inputSchema: structuredClone(spawn.parameters) });
  }
  return tools;
}

/** The two session-tool names, routed only to the session-tool delegate. */
const SESSION_TOOL_NAMES: ReadonlySet<string> = new Set([SESSION_HOSTS_TOOL_NAME, SESSION_SPAWN_TOOL_NAME]);

/** The session-tool wiring bound once, or undefined when absent or invalid (fails closed). */
function bindSessionTools(value: unknown): NativeManagedHostLaneSessionTools | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const { resolveScope, startup } = value as Partial<NativeManagedHostLaneSessionTools>;
    if (typeof resolveScope !== "function" || typeof startup !== "object" || startup === null) return undefined;
    const { titleColumns, inspection, createWorkspace } = startup;
    if (typeof titleColumns !== "number" || typeof inspection !== "boolean" || typeof createWorkspace !== "boolean") return undefined;
    return Object.freeze({ resolveScope, startup: Object.freeze({ titleColumns, inspection, createWorkspace }) });
  } catch {
    return undefined;
  }
}

/** The Claude inbox accessor bound once, or undefined when absent or invalid (fails closed). */
function bindClaudeInbox(value: unknown): NativeManagedHostLaneClaudeInbox | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const { senderFor } = value as Partial<NativeManagedHostLaneClaudeInbox>;
    return typeof senderFor === "function" ? Object.freeze({ senderFor }) : undefined;
  } catch {
    return undefined;
  }
}

/** The Codex callback accessor bound once, or undefined when absent or invalid (fails closed). */
function bindCodexCallback(value: unknown): NativeManagedHostLaneCodexCallback | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const { senderFor } = value as Partial<NativeManagedHostLaneCodexCallback>;
    return typeof senderFor === "function" ? Object.freeze({ senderFor }) : undefined;
  } catch {
    return undefined;
  }
}

/** The exact current Codex sender of one runtime row for one conversation, or undefined. Fails closed. */
function currentCodexSender(
  callback: NativeManagedHostLaneCodexCallback,
  rowId: string,
  conversationId: string,
): NativeCodexCallbackSender | undefined {
  try {
    const sender = callback.senderFor(rowId);
    if (typeof sender !== "object" || sender === null) return undefined;
    return sender.conversationId === conversationId && sender.isCurrent() === true && typeof sender.deliver === "function"
      ? sender
      : undefined;
  } catch {
    return undefined;
  }
}

/** The run scope's own currency, never a request's. Fails closed. */
function runCurrent(run: NativeMcpLaneRunScope): boolean {
  try {
    return !run.signal.aborted && run.isCurrent() === true;
  } catch {
    return false;
  }
}

/** The exact bound sender of one runtime row, or undefined. Fails closed. */
function currentSender(inbox: NativeManagedHostLaneClaudeInbox, rowId: string, conversationId: string): NativeClaudeInboxSender | undefined {
  try {
    const sender = inbox.senderFor(rowId);
    if (typeof sender !== "object" || sender === null) return undefined;
    return sender.conversationId === conversationId && sender.isCurrent() === true ? sender : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Platforms whose native MCP launch preparation can arm the relay. Windows
 * arms through the same staging (the existing permission policy and the
 * broker's local named pipe), conversation proof, owner, and tool policy as
 * POSIX. This gate admits the lane only: completion delivery and Watch stay
 * governed by the host's callback accessors, whose own platform gates are
 * separate and unchanged, so a Windows lane carries no sender and no Watch.
 */
export const NATIVE_MANAGED_HOST_LANE_SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = Object.freeze(["linux", "darwin", "win32"]);

/**
 * Whether a settings snapshot names at least one worker, and every external
 * worker resolves to an execution-capable agent: the same pool rule
 * `ExecutionToolManager.sync()` applies before it exposes the tools. Pi
 * workers are supported: the native owner launches them through the host's
 * admitted Pi executable. Fails closed.
 */
function supportedWorkers(config: Readonly<ReviewGateConfig>): boolean {
  try {
    const workers = resolvedWorkerResources(config as ReviewGateConfig);
    const agents = externalAgentCatalog(config as ReviewGateConfig);
    return workers.length > 0 && workers.every(({ selection }) => selection.source === "pi"
      || (selection.source === "external"
        && agents.some((agent) => agent.id === selection.id && externalAgentSupportsExecution(agent))));
  } catch {
    return false;
  }
}

/** A frozen copy of the host's scope selectors; absent or invalid gives no scope. */
function scopedModelsOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const copy = [...value as unknown[]];
  return copy.every((model) => typeof model === "string") ? Object.freeze(copy as string[]) : undefined;
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

const CONTRIBUTION_NONE: NativeMcpLaneActivityContribution = Object.freeze({ status: "none" });
const CONTRIBUTION_UNKNOWN: NativeMcpLaneActivityContribution = Object.freeze({ status: "unknown" });

/** One census read as a contribution: only a complete, in-domain count is known. */
function contributionOfRead(read: HostActivityCensusRead): NativeMcpLaneActivityContribution {
  if (read.status !== "complete") return CONTRIBUTION_UNKNOWN;
  const { count } = read;
  return Number.isSafeInteger(count) && count >= 0 ? Object.freeze({ status: "known", count }) : CONTRIBUTION_UNKNOWN;
}

function sameContribution(a: NativeMcpLaneActivityContribution, b: NativeMcpLaneActivityContribution): boolean {
  return a.status === b.status && (a.status !== "known" || (b.status === "known" && a.count === b.count));
}

/**
 * The census of a READY preparation's manager only. A failed, stale, refused, or
 * unavailable preparation never restored every durable reference, so even a
 * retained manager's census (which sees only its live groups) is no proof of
 * this run's managed work.
 */
function readyCensus(result: NativeManagedOwnerCustodyPrepareResult): HostActivityCensus | undefined {
  return result.status === "ready" ? censusOfManager(result.manager) : undefined;
}

/** The manager's own host census, or undefined when it exposes none. Fails closed. */
function censusOfManager(manager: unknown): HostActivityCensus | undefined {
  try {
    if (typeof manager !== "object" || manager === null) return undefined;
    const accessor = (manager as { activityCensus?: unknown }).activityCensus;
    if (typeof accessor !== "function") return undefined;
    const census: unknown = accessor.call(manager);
    if (typeof census !== "object" || census === null) return undefined;
    const candidate = census as Partial<HostActivityCensus>;
    return typeof candidate.read === "function" && typeof candidate.subscribe === "function"
      ? census as HostActivityCensus
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One held run's managed contribution (see the module note). It stores only the
 * last published census read and the hold's lifecycle facts. Every census
 * signal starts (or marks dirty) a read without blanking the count. Only a
 * complete or incomplete result that no later signal superseded replaces the
 * last published reading; a settling result is followed by another signal.
 */
function trackRunActivity(
  run: NativeMcpLaneRunScope,
  hold: NativeManagedOwnerHold,
  changed: () => void,
): { contribution(): NativeMcpLaneActivityContribution } {
  /** `ready` once the preparation settled ready, `not-ready` for any other outcome. */
  let preparation: "pending" | "ready" | "not-ready" = "pending";
  let handoff: NativeManagedOwnerHandoff | undefined;
  /** Retirement began (run revocation or host drain): the handoff is under way until it settles. */
  let retiring = run.signal.aborted;
  let census: HostActivityCensus | undefined;
  let unsubscribe: (() => void) | undefined;
  let reading: NativeMcpLaneActivityContribution = CONTRIBUTION_UNKNOWN;
  let current: NativeMcpLaneActivityContribution = CONTRIBUTION_UNKNOWN;
  let reads = false;
  let dirty = false;

  const compute = (): NativeMcpLaneActivityContribution => {
    // A not-ready preparation stays unknown for good, even after a clean custody
    // settlement: that settlement never proved the restore found no work.
    if (preparation !== "ready") return CONTRIBUTION_UNKNOWN;
    if (handoff === "clean") return CONTRIBUTION_NONE;
    if (handoff !== undefined || retiring || census === undefined) return CONTRIBUTION_UNKNOWN;
    return reading;
  };
  const publish = (): void => {
    const next = compute();
    if (sameContribution(next, current)) return;
    current = next;
    try {
      changed();
    } catch {
      // Contained: an observer never affects the census or the hold.
    }
  };
  const refresh = async (): Promise<void> => {
    if (reads) {
      dirty = true;
      return;
    }
    reads = true;
    try {
      do {
        dirty = false;
        const source = census;
        if (handoff !== undefined || source === undefined) return;
        let read: HostActivityCensusRead;
        try {
          read = await source.read();
        } catch {
          read = { status: "incomplete" };
        }
        // A read a later signal superseded is never applied; the loop re-reads.
        // A settling read carries no count and its gate signals again when it
        // settles, so the last published reading stands until that read lands.
        if (!dirty && read.status !== "settling") {
          reading = contributionOfRead(read);
          publish();
        }
      } while (dirty);
    } finally {
      reads = false;
    }
  };
  /** Refresh the display without withdrawing its last count while the read is in flight. */
  const refreshDisplay = (): void => { void refresh(); };
  const markRetiring = (): void => {
    retiring = true;
    publish();
  };

  if (!retiring) run.signal.addEventListener("abort", markRetiring, { once: true });
  void hold.retiring.then(markRetiring, markRetiring);
  void hold.prepare().then((result) => {
    preparation = result.status === "ready" ? "ready" : "not-ready";
    const source = handoff === undefined && preparation === "ready" ? readyCensus(result) : undefined;
    if (source !== undefined) {
      try {
        const stop: unknown = source.subscribe(refreshDisplay);
        if (typeof stop === "function") unsubscribe = stop as () => void;
        census = source;
      } catch {
        census = undefined;
      }
    }
    publish();
    if (census !== undefined) void refresh();
  }, () => {
    preparation = "not-ready";
    publish();
  });
  void hold.handoff.then((outcome) => outcome, (): NativeManagedOwnerHandoff => "failed").then((outcome) => {
    handoff = outcome;
    const stop = unsubscribe;
    unsubscribe = undefined;
    try {
      stop?.();
    } catch {
      // Contained.
    }
    publish();
  });

  return { contribution: () => current };
}

/**
 * Resolve the host's native managed lane from its own startup facts, or the
 * reason none is armed. Never throws.
 */
export function createNativeManagedHostLane(input: NativeManagedHostLaneInput): NativeManagedHostLaneResult {
  if (!NATIVE_MANAGED_HOST_LANE_SUPPORTED_PLATFORMS.includes(input.platform)) return { status: "unavailable", reason: "platform-unsupported" };
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
  const scopedModels = scopedModelsOf(input.scopedModels);

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
  const claudeInbox = bindClaudeInbox(input.claudeInbox);
  const codexCallback = bindCodexCallback(input.codexCallback);
  /** Each held run's managed contribution, keyed by the exact run object. */
  const runActivity = new WeakMap<NativeMcpLaneRunScope, { contribution(): NativeMcpLaneActivityContribution }>();
  const activityListeners = new Set<(run: NativeMcpLaneRunScope) => void>();
  const activityChanged = (run: NativeMcpLaneRunScope): void => {
    for (const listener of [...activityListeners]) {
      try {
        listener(run);
      } catch {
        // Contained: one observer never affects another.
      }
    }
  };
  const activity: NativeMcpLaneActivity = Object.freeze({
    contributionFor: (run: NativeMcpLaneRunScope): NativeMcpLaneActivityContribution =>
      runActivity.get(run)?.contribution() ?? CONTRIBUTION_NONE,
    subscribe: (listener: (run: NativeMcpLaneRunScope) => void): (() => void) => {
      if (typeof listener !== "function") throw new TypeError("session-host: a lane activity listener must be a function");
      const entry = (run: NativeMcpLaneRunScope): void => listener(run);
      activityListeners.add(entry);
      return () => { activityListeners.delete(entry); };
    },
  });

  const slotOf = (rowId: string): string | undefined => {
    try {
      const slotId = resolveSlotId(rowId);
      return typeof slotId === "string" && slotId !== "" ? slotId : undefined;
    } catch {
      return undefined;
    }
  };

  /** One hold's run-bound sink and its side-effect-free Watch sender predicate. */
  interface RunDelivery {
    readonly sink: ManagedNativeEventSink;
    readonly current: () => boolean;
  }

  /**
   * One Claude hold's run-bound sink (see the module note). Every target fact is
   * captured here, at acquisition, from the trusted runtime row and exact run;
   * each event re-proves them and makes at most one send attempt, after the
   * previous event's attempt settled. A throw is a sink failure: it never changes
   * the work's outcome and is never retried. `current` re-proves the same facts
   * without sending.
   */
  const claudeSink = (
    inbox: NativeManagedHostLaneClaudeInbox,
    run: NativeMcpLaneRunScope,
    rowId: string,
    slotId: string,
    conversationId: string,
  ): RunDelivery => {
    let tail: Promise<unknown> = Promise.resolve();
    const deliver = async (event: ManagedNativeEvent): Promise<void> => {
      if (!runCurrent(run) || slotOf(rowId) !== slotId) {
        throw new Error("session-host: the Claude run this event belongs to is no longer current; nothing was sent");
      }
      const sender = currentSender(inbox, rowId, conversationId);
      if (sender === undefined) {
        throw new Error("session-host: the Claude run has no current inbox sender for its conversation; nothing was sent");
      }
      const result = await sendClaudeInboxMessage(sender.capability, event.content, { signal: run.signal });
      if (result.disposition === "refused") {
        throw new Error(`session-host: the Claude inbox refused the send (${result.reason}); nothing was sent`);
      }
      if (result.disposition === "unknown") {
        throw new Error(`session-host: the Claude inbox send outcome is unknown (${result.reason}); it is not resent`);
      }
      // `sent_unconfirmed`: handed to the endpoint; delivery, placement, and
      // acknowledgment are never claimed.
    };
    return Object.freeze({
      sink: (event: ManagedNativeEvent): Promise<void> => {
        const attempt = tail.then(() => deliver(event));
        tail = attempt.catch(() => undefined);
        return attempt;
      },
      current: () => runCurrent(run) && slotOf(rowId) === slotId && currentSender(inbox, rowId, conversationId) !== undefined,
    });
  };

  /**
   * One Codex hold's run-bound sink (see the module note). The runtime row, run,
   * and conversation are captured at acquisition; the first current sender found
   * for them is pinned. Each event (an outcome or a Watch checkpoint) makes at
   * most one attempt after the previous one settled; a throw is a sink failure
   * and is never retried. `current` re-proves the same facts without sending or
   * pinning.
   */
  const codexSink = (
    callback: NativeManagedHostLaneCodexCallback,
    run: NativeMcpLaneRunScope,
    rowId: string,
    slotId: string,
    conversationId: string,
  ): RunDelivery => {
    let tail: Promise<unknown> = Promise.resolve();
    let pinned: NativeCodexCallbackSender | undefined;
    const deliver = async (event: ManagedNativeEvent): Promise<void> => {
      if (event.customType !== "pi-review-subtask-event" && event.customType !== "pi-review-subtask-watch") {
        throw new Error("session-host: a Codex run receives canonical managed events only; nothing was sent");
      }
      if (!runCurrent(run) || slotOf(rowId) !== slotId) {
        throw new Error("session-host: the Codex run this event belongs to is no longer current; nothing was sent");
      }
      const sender = currentCodexSender(callback, rowId, conversationId);
      if (sender === undefined || (pinned !== undefined && sender !== pinned)) {
        throw new Error("session-host: the Codex run has no current verified callback sender for its root thread; nothing was sent");
      }
      pinned = sender;
      const result = await sender.deliver({
        clientUserMessageId: `pi-managed-${randomUUID()}`,
        text: event.content,
        signal: run.signal,
      });
      if (result.delivery === "not-delivered") {
        const reason = result.route === "precheck-declined"
          ? result.reason
          : result.route === "transport-unavailable"
            ? result.code
            : result.outcome.route === "declined" ? result.outcome.reason : result.outcome.route;
        throw new Error(`session-host: the Codex callback was not delivered (${reason}); nothing is pending`);
      }
      if (result.delivery === "unknown") {
        throw new Error("session-host: the Codex callback outcome is unknown; it is not resent");
      }
      // `sent-unconfirmed` (an accepted steer) or `turn-started` (our queued row
      // started a turn): never a read receipt, placement, or acknowledgment.
    };
    return Object.freeze({
      sink: (event: ManagedNativeEvent): Promise<void> => {
        const attempt = tail.then(() => deliver(event));
        tail = attempt.catch(() => undefined);
        return attempt;
      },
      current: () => {
        if (!runCurrent(run) || slotOf(rowId) !== slotId) return false;
        const sender = currentCodexSender(callback, rowId, conversationId);
        return sender !== undefined && (pinned === undefined || sender === pinned);
      },
    });
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
    // Claude only with its accessor, Codex only with its own: the exact runtime
    // row, run, and conversation captured now are the sink's only target, and
    // the same captured facts gate Watch.
    const delivery = claudeInbox !== undefined && backend === "claude"
      ? claudeSink(claudeInbox, run, rowId, slotId, conversationId)
      : codexCallback !== undefined && backend === "codex"
        ? codexSink(codexCallback, run, rowId, slotId, conversationId)
        : undefined;
    const options: Omit<NativeManagedConversationOwnerOptions, "stateRoot"> = {
      run,
      // The owner keys its durable associations by this id: the roster slot.
      identity: { rowId: slotId, backend, workspace, conversationId },
      settings,
      pi,
      ...(scopedModels === undefined ? {} : { scopedModels }),
      ...(delivery === undefined ? {} : { nativeEventSink: delivery.sink, watchDeliveryCurrent: delivery.current }),
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
    runActivity.set(run, trackRunActivity(run, hold, () => activityChanged(run)));
    // The run's contribution moved from none (no hold) to unknown (preparing).
    activityChanged(run);
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

  const managedDelegate: NativeMcpLaneDelegate = Object.freeze({
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
    // #682: only the run's EXISTING hold answers (nothing is acquired here), and
    // only while the context is current and its runtime row still resolves to
    // the hold's slot; the owner then decides with the owner-facing context.
    discoveryAwaitsDeliverySender(context: NativeMcpLaneContext): boolean {
      try {
        const run = provedRun(context);
        const binding = run === undefined ? undefined : holds.get(run);
        if (binding === undefined || binding.rowId !== context.rowId || slotOf(binding.rowId) !== binding.slotId
          || !contextCurrent(context)) {
          return false;
        }
        return binding.hold.delegate.discoveryAwaitsDeliverySender?.(ownerContext(context, binding)) === true;
      } catch {
        return false;
      }
    },
  });

  // The session tools receive the ORIGINAL proved context: the resolver is the
  // manager's own scope, which honors only the exact object it issued.
  const sessionTools = bindSessionTools(input.sessionTools);
  const sessionDelegate = sessionTools === undefined
    ? undefined
    : createNativeSessionToolDelegate({ resolveHost: sessionTools.resolveScope });
  const delegate: NativeMcpLaneDelegate = sessionDelegate === undefined ? managedDelegate : Object.freeze({
    async listTools(context: NativeMcpLaneContext): Promise<readonly NativeMcpToolDescriptor[]> {
      const [managed, session] = await Promise.all([managedDelegate.listTools(context), sessionDelegate.listTools(context)]);
      return [...managed, ...session];
    },
    async callTool(context: NativeMcpLaneContext, call: NativeMcpLaneToolCall): Promise<NativeMcpCallToolResult | undefined> {
      let name: unknown;
      try {
        name = typeof call === "object" && call !== null ? call.name : undefined;
      } catch {
        name = undefined;
      }
      // A session tool never reaches the managed owner, its hold, or its restore.
      return typeof name === "string" && SESSION_TOOL_NAMES.has(name)
        ? sessionDelegate.callTool(context, call)
        : managedDelegate.callTool(context, call);
    },
    // Watch is the managed owner's alone; the session tools have no say.
    discoveryAwaitsDeliverySender: (context: NativeMcpLaneContext): boolean =>
      managedDelegate.discoveryAwaitsDeliverySender?.(context) === true,
  });

  const lane: NativeMcpLaneOwner = Object.freeze({
    registrar,
    serverName: named.serverName,
    delegate,
    preProofTools: Object.freeze(nativeManagedHostLanePreProofTools(sessionTools?.startup)),
    // Receipt-gated metadata only: listed by the instance manager solely for a
    // run holding its own verified delivery receipt; the owner decides calls.
    ...(claudeInbox === undefined && codexCallback === undefined
      ? {}
      : { deliveryTools: Object.freeze(nativeManagedHostLaneDeliveryTools()) }),
    activity,
  });
  return {
    status: "armed",
    host: Object.freeze({ lane, drain: (options?: { readonly signal?: AbortSignal }) => custody.drain(options) }),
  };
}
