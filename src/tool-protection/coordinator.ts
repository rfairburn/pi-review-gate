/**
 * Native Pi admission coordinator for the pre-execution tool-protection gate
 * (issue #536).
 *
 * One proposal is held at the blocking `tool_call` seam until one fresh auditor
 * decision exists for that exact invocation. The coordinator owns only that
 * added layer:
 *
 * - It runs only after the existing native authority, role/ceiling,
 *   duplicate/liveness, readiness, trust and evidence guards have already
 *   admitted the call. It never grants authority, resets a guard, or converts a
 *   policy refusal into an execution error (`markPolicyBlocked` on the preflight
 *   records a refusal, not a failure).
 * - `off` (or no block at all) returns `undefined`: the native result and
 *   authority are untouched. There is no annotation, no extra turn, and no
 *   audit.
 * - `scope: "selected"` records `NOT AUDITED` for the exact names outside the
 *   list. That annotation is attached to the same tool result and never claims
 *   PASS or safety.
 * - The canonical `tool_search` discovery loader is the one infrastructure
 *   exemption (`isToolProtectionDiscoveryLoaderExempt`): it is never sent to the
 *   auditor at any scope or level, and it never waits on the auditor's
 *   availability, the context budget, or a configuration load error, because
 *   discovery is how a model reaches the tools this gate would otherwise judge.
 *   The exemption records `NOT AUDITED — discovery loader` on the same result,
 *   never a PASS, and it bypasses nothing that native Pi already enforces: the
 *   live authorization, mode/role ceiling, registry/ownership, reserved-name,
 *   duplicate/liveness and cancellation guards run before this seam and stay
 *   authoritative, so a removed, replaced, or unauthorized loader call is still
 *   blocked by them.
 * - A decision is bound to call id, tool name, argument fingerprint, parent and
 *   root identity, session generation, cwd and the exact configuration
 *   snapshot. A policy change, session/branch change, reload or cancellation
 *   during the wait invalidates a late PASS, so nothing stale is dispatched.
 * - Transport/parse failures, timeouts, malformed or unknown results, and
 *   cancellation all block. Nothing is retried, replayed, cached or routed to a
 *   different auditor.
 *
 * Presentation is inline on the same tool interaction: a FAIL reason is the
 * native admission block reason (blocked calls never reach `tool_result`), and
 * PASS/NOT AUDITED are model-visible annotations prepended to the same
 * `tool_result` content. `structuredContent`, `details`, `isError`, `usage`,
 * images and the original native content are preserved. Nested child calls are
 * audited individually, but their returned values are never rewritten: their
 * decisions are correlated to the root and aggregated into the outer call's
 * model-visible result. Auditor text is untrusted display data.
 *
 * Honest limitations (source-backed, not guarantees):
 * - Pi permits later `tool_call` handlers and provider-request hooks to rewrite
 *   input or instructions after this handler returns. This gate audits what it
 *   was given at its own hook position; it is not a sandbox and does not prove
 *   the final byte-identical dispatch.
 * - A custom tool renderer may ignore result `content`. A thin renderer
 *   decoration is registered when the host exposes `registerToolRenderer`, but
 *   a renderer that draws neither the content nor the decoration is outside this
 *   gate's reach.
 * - Auditing is awaited at admission, so a batch's admissions serialize and a
 *   long audit delays that batch (host scheduling behavior, not a gate promise).
 */

import { createHash } from "node:crypto";
import {
  resolvedExternalAgent,
  type ExternalAgentAdapter,
  type ExternalAgentRoleConfig,
  type ExternalAgentValue,
  type ReviewGateConfig,
} from "../config";
import {
  effectiveToolProtectionSettings,
  isToolProtectionDiscoveryLoaderExempt,
  normalizeToolProtectionConfig,
  toolProtectionAppliesTo,
  type EffectiveToolProtectionSettings,
  type ProtectionLevel,
} from "./config";
import { buildProtectionContext, type ProtectionEvidence } from "./context";
import { parseProtectionDecision } from "./decision";
import { TOOL_PROTECTION_POLICY_VERSION } from "./policy";
import {
  runProtectionAuditor,
  type ProtectionAuditorObservation,
  type ProtectionAuditorPiModelRegistry,
  type ProtectionAuditorResult,
} from "./runner";
import {
  actingSessionIdentity,
  auditorRecordNotSavedWarning,
  openAuditorSessionRecord,
  type AuditorRecordDependencies,
  type AuditorRecordHandle,
  type AuditorRecordIdentity,
  type AuditorRecordOpenDraft,
  type AuditorRecordOutcome,
} from "./session-record";
import { extractContext, extractInputSource, extractInputText, extractSignal, extractToolArgs, extractToolCallId, extractToolName, registerHook } from "../pi";
import { isToolCallFingerprint, toolCallFingerprint } from "../tool-call-fingerprint";
import { isRecord } from "../record-guard";
import { wrapPreserving } from "../tool-result-wrap";
import { visibleTerminalText } from "../tool-result-text";

/** Private one-shot transport for the parent-pinned delegated Pi executor gate. */
export const TOOL_PROTECTION_BOOTSTRAP_ENV = "PI_REVIEW_GATE_TOOL_PROTECTION";
const TOOL_PROTECTION_BOOTSTRAP_VERSION = 1;

/** Bounds that keep admission state and evidence small; not policy budgets. */
const MAX_RECENT_EVIDENCE = 12;
/**
 * The latest live ingress inputs kept OUTSIDE the mixed ring above: both the
 * genuine current-session user inputs and the extension/RPC deliveries that
 * carry an acting session's actual task (a delegated Pi executor receives its
 * task over the RPC input path). A tool-heavy task can produce far more captured
 * tool results than the ring holds, and the active-branch read only walks back
 * until its own small record budget is full, so an ordinary 15-call task would
 * otherwise lose the very instruction the alignment and authorization rules must
 * judge. Two records is the minimum that keeps both the task and a later input
 * visible; this is a context-sufficiency bound, not a grant, cache, or authority
 * of any kind. Each retained record keeps the provenance label it was captured
 * with — `user` only for input the host reports as user-authored, `extension`
 * for extension/RPC delivery — so retention never presents an RPC task or an
 * RPC-delivered "approval" as a human authorization.
 */
const MAX_RETAINED_LIVE_INPUTS = 2;
/**
 * Hard retention bound for one live evidence record. Causal records are
 * retained outside the ordinary history bound until consumed; a causal record
 * larger than this cannot be reproduced for a fair audit, so admission fails
 * closed instead of silently dropping it.
 */
const MAX_RETAINED_EVIDENCE_TEXT = 200_000;
const MAX_BRANCH_EVIDENCE = 8;
const MAX_BRANCH_MESSAGE_CHARS = 4_000;
const MAX_PENDING_CALLS = 128;
const MAX_ROOTS = 32;
const MAX_NESTED_PER_ROOT = 32;
const MAX_NESTED_LINES = 12;
const MAX_BLOCK_REASON_CHARS = 6_000;

/**
 * One pinned protection snapshot for a delegated Pi executor. It carries the
 * shared level/fields, any load diagnostic, and — when the selected auditor is
 * an external agent — the parent's resolved definition for that exact id.
 *
 * The external definition travels only through the same one-shot bootstrap as
 * the settlement identity: the child captures and erases it synchronously
 * before its first await, tool registration or model request, and it is never
 * written to a transcript, artifact or log. This is what makes a session-only
 * (in-memory) definition change the parent's actual auditor boundary instead of
 * re-resolving the same id against a possibly different child configuration.
 */
export interface ToolProtectionLaunchPin {
  settings: EffectiveToolProtectionSettings;
  loadError?: string;
  /** Resolved parent definition for the selected external auditor, when any. */
  auditorDefinition?: ExternalAgentValue;
  /** The parent could not resolve the selected external auditor definition. */
  auditorDefinitionError?: string;
}

/** Serialize the parent-issued pin for the child's one-shot bootstrap. */
export function createToolProtectionBootstrap(pin: ToolProtectionLaunchPin): string {
  return JSON.stringify({
    version: TOOL_PROTECTION_BOOTSTRAP_VERSION,
    ...(pin.loadError === undefined ? {} : { loadError: pin.loadError }),
    ...(pin.auditorDefinition === undefined ? {} : { auditorDefinition: pin.auditorDefinition }),
    ...(pin.auditorDefinitionError === undefined ? {} : { auditorDefinitionError: pin.auditorDefinitionError }),
    settings: {
      level: pin.settings.level,
      auditor: pin.settings.auditor,
      scope: pin.settings.scope,
      toolNames: [...pin.settings.toolNames],
      timeoutMs: pin.settings.timeoutMs,
      maxContextChars: pin.settings.maxContextChars,
      retainAuditorSessions: pin.settings.retainAuditorSessions,
    },
  });
}

/**
 * Capture and erase the child's bootstrap before the first await, tool
 * registration or model request. A malformed bootstrap throws: the caller
 * records that error and blocks protected admissions rather than trusting an
 * ambient configuration file.
 */
export function captureToolProtectionBootstrap(env: NodeJS.ProcessEnv = process.env): ToolProtectionLaunchPin | undefined {
  const raw = env[TOOL_PROTECTION_BOOTSTRAP_ENV];
  if (raw === undefined) return undefined;
  delete env[TOOL_PROTECTION_BOOTSTRAP_ENV];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Pi executor tool-protection bootstrap is not valid JSON.");
  }
  if (!isRecord(parsed) || parsed.version !== TOOL_PROTECTION_BOOTSTRAP_VERSION || !isRecord(parsed.settings)) {
    throw new Error("Pi executor tool-protection bootstrap has an unsupported shape or version.");
  }
  let normalized;
  try {
    normalized = normalizeToolProtectionConfig({
      level: parsed.settings.level,
      auditor: parsed.settings.auditor,
      scope: parsed.settings.scope,
      toolNames: parsed.settings.toolNames,
      timeoutMs: parsed.settings.timeoutMs,
      maxContextChars: parsed.settings.maxContextChars,
      // A pin from a parent that predates retention simply omits the field,
      // which normalizes to Off: an older launch never gains a new side effect.
      retainAuditorSessions: parsed.settings.retainAuditorSessions,
    });
  } catch (error) {
    throw new Error(`Pi executor tool-protection bootstrap is invalid: ${errorMessage(error)}`);
  }
  const loadError = parsed.loadError;
  if (loadError !== undefined && typeof loadError !== "string") {
    throw new Error("Pi executor tool-protection bootstrap has an invalid load diagnostic.");
  }
  const definitionError = parsed.auditorDefinitionError;
  if (definitionError !== undefined && typeof definitionError !== "string") {
    throw new Error("Pi executor tool-protection bootstrap has an invalid auditor-definition diagnostic.");
  }
  const auditorDefinition = parsed.auditorDefinition === undefined
    ? undefined
    : normalizePinnedExternalAgent(parsed.auditorDefinition);
  return {
    settings: effectiveToolProtectionSettings({ toolProtection: normalized }),
    ...(typeof loadError === "string" ? { loadError } : {}),
    ...(auditorDefinition ? { auditorDefinition } : {}),
    ...(typeof definitionError === "string" ? { auditorDefinitionError: definitionError } : {}),
  };
}

const EXTERNAL_AGENT_ADAPTERS: readonly ExternalAgentAdapter[] = ["codex-cli", "claude-cli", "generic-cli", "run-as-binary"];

/**
 * Structural validation of a parent-pinned external auditor definition. The
 * parent built it from already-validated configuration; this check keeps a
 * malformed or truncated bootstrap from being trusted, without importing the
 * root configuration's full schema into this module.
 */
function normalizePinnedExternalAgent(value: unknown): ExternalAgentValue {
  if (!isRecord(value)) {
    throw new Error("Pi executor tool-protection bootstrap auditor definition must be an object.");
  }
  if (typeof value.adapter !== "string" || !(EXTERNAL_AGENT_ADAPTERS as readonly string[]).includes(value.adapter)) {
    throw new Error("Pi executor tool-protection bootstrap auditor definition has an unsupported adapter.");
  }
  if (typeof value.command !== "string" || value.command.length === 0) {
    throw new Error("Pi executor tool-protection bootstrap auditor definition requires a command.");
  }
  const review = normalizePinnedExternalRole(value.review, "review");
  const execution = normalizePinnedExternalRole(value.execution, "execution");
  if (!review && !execution) {
    throw new Error("Pi executor tool-protection bootstrap auditor definition requires a review or execution role.");
  }
  const model = typeof value.model === "string" && value.model.length > 0 ? value.model : undefined;
  const adapter = value.adapter as ExternalAgentAdapter;
  return {
    adapter,
    command: value.command,
    args: stringArrayFromBootstrap(value.args, "args"),
    ...(value.env === undefined ? {} : { env: stringRecordFromBootstrap(value.env, "env") }),
    ...(model ? { model } : {}),
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort as ExternalAgentValue["reasoningEffort"] } : {}),
    ...(review ? { review } : {}),
    ...(execution ? { execution } : {}),
  };
}

function normalizePinnedExternalRole(value: unknown, role: "review" | "execution"): ExternalAgentRoleConfig | undefined {
  if (value === undefined || value === false) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Pi executor tool-protection bootstrap auditor ${role} role must be an object.`);
  }
  const protocol = value.protocol === undefined
    ? undefined
    : value.protocol === "pi-review-executor-jsonl-v1" || value.protocol === "pi-reviewer-json-v1"
      ? value.protocol
      : "invalid";
  if (protocol === "invalid") {
    throw new Error(`Pi executor tool-protection bootstrap auditor ${role} protocol is unsupported.`);
  }
  const timeoutMs = value.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`Pi executor tool-protection bootstrap auditor ${role} timeoutMs must be a positive whole number.`);
  }
  return {
    args: stringArrayFromBootstrap(value.args, `${role} args`),
    ...(value.env === undefined ? {} : { env: stringRecordFromBootstrap(value.env, `${role} env`) }),
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort as ExternalAgentRoleConfig["reasoningEffort"] } : {}),
  };
}

function stringArrayFromBootstrap(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Pi executor tool-protection bootstrap auditor ${field} must be an array of strings.`);
  }
  return [...value];
}

function stringRecordFromBootstrap(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`Pi executor tool-protection bootstrap auditor ${field} must be an object.`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`Pi executor tool-protection bootstrap auditor ${field} values must be strings.`);
    }
    result[key] = item;
  }
  return result;
}

/**
 * Resolve the parent's current definition for an external auditor selection so
 * the delegated child runs exactly that boundary. A session-only (Escape)
 * definition change is included because this reads the live configuration
 * object at launch time.
 */
function pinnedAuditorDefinition(
  settings: EffectiveToolProtectionSettings,
  config: ReviewGateConfig,
): Pick<ToolProtectionLaunchPin, "auditorDefinition" | "auditorDefinitionError"> {
  const auditor = settings.auditor;
  if (!auditor || auditor.source !== "external") return {};
  const resolved = resolvedExternalAgent(config, auditor.id);
  if (!resolved) {
    return {
      auditorDefinitionError: `the selected external auditor "${auditor.id}" is not resolvable in the parent configuration`,
    };
  }
  // Drop the id: the catalog key carries it, matching ExternalAgentValue.
  const definition = { ...resolved } as ExternalAgentValue & { id?: string };
  delete definition.id;
  return { auditorDefinition: definition };
}

/**
 * Runtime availability of the gate when the stored block could not be
 * validated at load time. This is a derived diagnostic, not configuration: it
 * holds no settings and is cleared by an explicit valid settings apply.
 */
let activeLoadError: string | undefined;

export function noteToolProtectionLoadError(message: string | undefined): void {
  activeLoadError = message;
}

export function clearToolProtectionLoadError(): void {
  activeLoadError = undefined;
}

export function configuredToolProtectionLoadError(): string | undefined {
  return activeLoadError;
}

/** Why a delegated acting executor cannot be admitted under a non-Off level. */
export interface ExecutorProtectionRefusal {
  blocked: true;
  reason: string;
}

/**
 * Decide whether one executor launch is admissible under the live (or pinned)
 * protection state. Pi executors receive the pinned pin; external acting
 * executors have no proven pre-effect tool seam, so a non-Off level refuses the
 * launch before that executor starts rather than pretending to cover it.
 */
export function executorProtectionAdmission(
  config: ReviewGateConfig,
  selection: { source: "pi" | "external"; id?: string } | undefined,
): { pin: ToolProtectionLaunchPin } | ExecutorProtectionRefusal {
  const loadError = configuredToolProtectionLoadError();
  if (loadError) {
    return {
      blocked: true,
      reason: `Tool protection is unavailable (${loadError}); no executor was started. Save a valid toolProtection configuration before delegating work.`,
    };
  }
  const settings = effectiveToolProtectionSettings(config);
  if (!settings.enabled) {
    // Off is pinned explicitly, so an ambient child configuration file cannot
    // silently turn the added gate on or off inside a delegated worker.
    return { pin: { settings } };
  }
  if (selection?.source !== "pi") {
    const target = selection?.source === "external" ? `external executor "${selection.id ?? "unknown"}"` : "this executor";
    return {
      blocked: true,
      reason: `Tool protection (level "${settings.level}") cannot audit tool calls inside ${target}: this project has no proven pre-effect seam for a non-Pi acting executor. The execution was refused before it started, not silently left unprotected. Use a Pi executor/resource or explicitly set toolProtection.level to "off".`,
    };
  }
  return { pin: { settings, ...pinnedAuditorDefinition(settings, config) } };
}

interface ToolCallShape {
  callId: string;
  toolName: string;
  input: Record<string, unknown>;
  parentToolCallId?: string;
  ctx?: unknown;
  signal?: AbortSignal;
}

/** One invocation's recording input, shared by the open and finish steps. */
interface AuditorRecordRequest {
  call: ToolCallShape;
  settings: EffectiveToolProtectionSettings;
  fingerprint: string;
  prompt: string;
  policyVersion?: string;
  /** Absent when the auditor invocation itself threw, so nothing was returned. */
  result?: ProtectionAuditorResult;
  observation?: ProtectionAuditorObservation;
}

interface AnnotationRecord {
  kind: "pass" | "not-audited" | "not-audited-discovery" | "blocked";
  toolName: string;
  reason?: string;
  /**
   * Honest disclosure that this invocation's optional saved auditor session is
   * incomplete (#536). It accompanies the verdict; it never replaces it.
   */
  recordWarning?: string;
  level: ProtectionLevel;
  policyVersion?: string;
  durationMs?: number;
  invocationId: string;
}

interface CausalChain {
  toolName: string;
  refusalId: string;
  assistantId?: string;
  userId?: string;
}

interface NestedAggregate {
  decisions: AnnotationRecord[];
  /** Total decisions observed, including records no longer retained. */
  total: number;
  /**
   * Recording failures observed, counted independently of the retained and
   * displayed sets. Bounded summary state may drop a decision's own line, but a
   * save failure must never go silent, so its count survives eviction.
   */
  recordWarningCount: number;
}

interface ToolProtectionState {
  settings: EffectiveToolProtectionSettings;
  loadError?: string;
  /** True when this runtime uses a parent-issued pin rather than ambient config. */
  pinned: boolean;
  auditorDefinition?: ExternalAgentValue;
  auditorDefinitionError?: string;
}

export interface ToolProtectionCoordinatorOptions {
  /** Live configuration; derived group configs share the same nested block. */
  config: () => ReviewGateConfig;
  cwd: () => string;
  /** Role label reproduced as a fact in the auditor context. */
  role: string;
  /** Derived load diagnostic for this activation, cleared by a valid apply. */
  loadError?: () => string | undefined;
  /** Parent-issued pin for a delegated Pi executor, when one was captured. */
  pinned?: () => ToolProtectionLaunchPin | undefined;
  /** Malformed parent bootstrap; blocks protected admissions. */
  pinnedError?: () => string | undefined;
  taskId?: () => string | undefined;
  now?: () => number;
  /** Test seam; production uses the shared runner. */
  runAuditor?: typeof runProtectionAuditor;
  /**
   * Test seam for the optional auditor-session retention writer (#536).
   * Production uses the host-peer `SessionManager` writer; a test can capture
   * the draft without a host Pi install. The seam opens a record (everything
   * except the outcome entry) and returns a handle whose `complete()` is
   * synchronous, because the caller must be able to finish the record after its
   * final admission revalidation without awaiting again.
   */
  openAuditorRecord?: (
    draft: AuditorRecordOpenDraft,
    dependencies: AuditorRecordDependencies,
  ) => Promise<AuditorRecordHandle>;
  /** Test seam passed straight through to the retention writer. */
  auditorRecordDependencies?: AuditorRecordDependencies;
  maxRecentEvidence?: number;
  /**
   * Monotonic policy revision for this activation, incremented on every
   * explicit settings application (including an Off → On → Off change that
   * restores the same final values). A delegated child uses a pinned snapshot
   * instead, so its revision is constant.
   */
  revision?: () => number;
  /**
   * Is the `tool_search` entry in the live tool registry the discovery loader THIS
   * extension registered? The host's deferred-tool manager answers this from the
   * registration references it holds plus the provenance the host assigned to its own
   * registration (`DeferredToolManager.ownsDiscoveryLoader`), so metadata copied from
   * this loader's published entry does not carry the treatment.
   *
   * The never-audited infrastructure treatment is granted only to the loader this
   * extension built. A different definition registered under the same reserved name
   * is an ordinary tool proposal and is handled like one, so an unrelated
   * replacement can never escape the auditor by borrowing the reserved name. An
   * absent probe answers "not owned": the exemption is never the default.
   */
  discoveryLoaderOwned?: () => boolean;
}

/**
 * Admission coordinator. One instance per activated runtime (primary or one Pi
 * executor); it holds only bounded, current-session runtime state.
 */
export class ToolProtectionCoordinator {
  private pending = new Map<string, { token: number; stateKey: string; bindingKey: string }>();
  private tokens = 0;
  private byCall = new Map<string, AnnotationRecord>();
  private byRoot = new Map<string, NestedAggregate>();
  private recent: ProtectionEvidence[] = [];
  private evidenceSequence = 0;
  /**
   * The latest live ingress inputs, retained separately from `recent` so
   * tool-result traffic cannot evict the task under audit. Live ingress only —
   * assistant text and tool results stay in the ordinary ring — and it reuses
   * the same evidence objects and ids; never a second copy or a promotion.
   */
  private retainedLiveInputs: ProtectionEvidence[] = [];
  private chain: CausalChain | undefined;
  /** Causal records retained outside the ordinary bounded history until consumed. */
  private chainEvidence = new Map<string, ProtectionEvidence>();
  /**
   * Required causal records that could not be retained, tracked independently
   * per slot. Recovering one slot must never clear another slot's loss; every
   * missing required record keeps protected admissions blocked.
   */
  private missingCausalEvidence = new Map<ProtectionEvidence["origin"], string>();
  private readonly now: () => number;
  private readonly maxRecentEvidence: number;

  constructor(private readonly options: ToolProtectionCoordinatorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxRecentEvidence = Math.max(1, options.maxRecentEvidence ?? MAX_RECENT_EVIDENCE);
  }

  /** Reset all current-session admission/approval state. */
  reset(): void {
    // A cleared pending set is what invalidates a decision still in flight: a
    // late PASS can no longer find its admission token and is never dispatched.
    this.pending.clear();
    this.byCall.clear();
    this.byRoot.clear();
    this.recent = [];
    this.retainedLiveInputs = [];
    this.chain = undefined;
    this.chainEvidence.clear();
    this.missingCausalEvidence.clear();
  }

  /**
   * Register the presentation/evidence/lifecycle hooks. These hooks never gate
   * or mutate native authority; the blocking decision is returned from
   * `admitToolCall` at the composed `tool_call` seam.
   */
  registerHooks(pi: unknown): void {
    this.registerEvidenceHooks(pi);
    this.registerPresentationHooks(pi);
  }

  /**
   * Register only the live-ingress evidence capture. The host must call this
   * BEFORE any handler that can consume an `input` event, because Pi stops
   * dispatching input handlers after one returns `action: "handled"`. In the
   * extension entrypoint this is registered before the review gate's own
   * handler, so a queued interactive approval keeps its original provenance.
   */
  registerEvidenceHooks(pi: unknown): void {
    registerHook(pi, "input", (...args) => {
      this.observeInput(args);
    });
    registerHook(pi, "message_end", (...args) => {
      this.observeAssistantMessage(args);
    });
    registerHook(pi, "tool_result", (...args) => {
      this.observeToolResult(args);
    });
  }

  /**
   * Register result presentation and session-scoped reset/seeding. Registered
   * last in the entrypoint so annotation runs after the existing result
   * transforms and evidence capture.
   */
  registerPresentationHooks(pi: unknown): void {
    registerHook(pi, "tool_result", (...args) => this.annotateToolResult(args));
    registerHook(pi, "tool_execution_end", (...args) => this.retireToolExecution(args));
    registerHook(pi, "session_start", (...args) => {
      this.reset();
      this.seedBranchEvidence(extractContext(args));
    });
    registerHook(pi, "session_tree", () => {
      this.reset();
    });
    registerHook(pi, "session_shutdown", () => {
      this.reset();
    });
    this.registerRendererDecoration(pi);
  }

  /**
   * Audit one already-admitted native tool proposal.
   *
   * Returns `undefined` when the native callback may run (Off, outside a
   * `selected` scope with a NOT AUDITED annotation recorded, or a current valid
   * PASS) and a native `{block:true,reason}` otherwise. This method never
   * throws: every internal failure blocks the proposed call.
   */
  async admitToolCall(args: unknown[]): Promise<{ block: true; reason: string } | undefined> {
    let event: ToolCallShape | undefined;
    try {
      event = readToolCall(args);
      const state = this.currentState();
      const settings = state.settings;
      const loadError = state.loadError;
      if (!settings.enabled && loadError === undefined) {
        // Off removes only this added gate. Native authority and the native
        // result are untouched, including any tool outside a later scope.
        return undefined;
      }
      // The canonical discovery loader is infrastructure, not audited work, so it
      // is checked before the auditor, the auditor's availability, the load
      // diagnostic, the context budget and the audit subset: tool discovery must
      // never wait on this added gate (see `isToolProtectionDiscoveryLoaderExempt`).
      // Nothing here grants or widens authority — every native guard that already
      // ran stays authoritative — and the record says NOT AUDITED rather than PASS.
      // Two things must both hold: the proposal is a fully bound call of the exact
      // canonical loader name, AND the live registry entry under that name is the
      // loader this extension registered. A proposal whose identity cannot be bound
      // keeps the existing fail-closed refusal, and a foreign definition that took
      // over the reserved name is audited like any other tool instead of gaining a
      // weaker path under a borrowed name.
      if (event
        && isToolProtectionDiscoveryLoaderExempt(event.toolName)
        && this.options.discoveryLoaderOwned?.() === true) {
        this.recordDecision(event, event.parentToolCallId ? rootCallId(event.parentToolCallId) : event.callId, {
          kind: "not-audited-discovery",
          toolName: event.toolName,
          level: settings.level,
          invocationId: event.callId,
        });
        return undefined;
      }
      if (!event) {
        return block(
          "Tool protection: audit unavailable — a native tool proposal could not be bound to a call identity, tool name and argument object. The proposed call was not run.",
        );
      }
      const call = event;
      const rootId = call.parentToolCallId ? rootCallId(call.parentToolCallId) : call.callId;
      // A blocked nested child cannot carry its own annotation (its returned
      // value must stay untouched), so the refusal is aggregated into the
      // outer call's model-visible result as well.
      // `disclosure` accompanies the refusal for the user only. It is never part
      // of the refusal evidence supplied to a later audit, and it never changes
      // the verdict or the reason the call was refused.
      const refuse = (reason: string, disclosure?: string): { block: true; reason: string } => {
        if (call.parentToolCallId) {
          this.recordDecision(call, rootId, {
            kind: "blocked",
            toolName: call.toolName,
            reason,
            ...(disclosure === undefined ? {} : { recordWarning: disclosure }),
            level: this.currentState().settings.level,
            invocationId: call.callId,
          });
        }
        return block(disclosure === undefined ? reason : `${reason}\n${disclosure}`);
      };
      if (loadError !== undefined) {
        return refuse(
          `Tool protection: unavailable — ${loadError} The proposed ${event.toolName} call was not run.`,
        );
      }
      if (!toolProtectionAppliesTo(settings, event.toolName)) {
        this.recordDecision(event, rootId, {
          kind: "not-audited",
          toolName: event.toolName,
          level: settings.level,
          invocationId: event.callId,
        });
        return undefined;
      }
      if (!settings.auditor) {
        return refuse(
          `Tool protection: unavailable — the enabled level "${settings.level}" has no resolved auditor. The proposed ${event.toolName} call was not run.`,
        );
      }
      if (state.pinned && settings.auditor.source === "external") {
        const auditorId = settings.auditor.id;
        if (state.auditorDefinitionError !== undefined) {
          return refuse(
            `Tool protection: auditor unavailable — ${state.auditorDefinitionError}, so the delegated audit boundary for "${auditorId}" is not established. The proposed ${event.toolName} call was not run.`,
          );
        }
        if (!state.auditorDefinition) {
          return refuse(
            `Tool protection: auditor unavailable — the parent launch did not pin a definition for external auditor "${auditorId}", and this executor does not resolve auditor definitions from its own configuration. The proposed ${event.toolName} call was not run.`,
          );
        }
      }
      if (this.missingCausalEvidence.size > 0) {
        const missing = [...this.missingCausalEvidence.values()].join(" ");
        const message = `Tool protection: required causal evidence unavailable — ${missing} A fair audit of this proposal is not possible, so the ${event.toolName} call was not run.`;
        this.noteGateRefusalEvidence(event.toolName, event.callId, message, false);
        return refuse(message);
      }
      const fingerprint = toolCallFingerprint(event.toolName, event.input);
      if (!isToolCallFingerprint(fingerprint)) {
        return refuse(
          `Tool protection: audit unavailable — the ${event.toolName} proposal's arguments could not be reduced to a stable identity, so no decision can be bound to it. The proposed call was not run.`,
        );
      }
      const ctx = event.ctx;
      const systemPrompt = readSystemPrompt(ctx);
      const evidence = this.evidenceFor(event.toolName, ctx);
      const proposedCall = {
        invocationId: event.callId,
        toolName: event.toolName,
        args: event.input,
        cwd: this.options.cwd(),
        role: this.options.role,
        ...(this.options.taskId?.() ? { taskId: this.options.taskId!() } : {}),
        ...(event.parentToolCallId ? { lineage: lineageOf(event.parentToolCallId) } : {}),
      };
      const built = buildProtectionContext({
        level: settings.level as Exclude<ProtectionLevel, "off">,
        governingSystemPrompt: systemPrompt?.prompt ?? "",
        governingPromptOrigin: systemPrompt?.origin ?? "Pi ctx.getSystemPrompt() unavailable",
        proposedCall,
        evidence: evidence.items,
        maxContextChars: settings.maxContextChars,
      });
      if (!built.ok) {
        this.noteGateRefusalEvidence(event.toolName, event.callId, built.message, false);
        return refuse(built.message);
      }

      const stateKey = this.stateKey();
      // The decision is bound to this exact proposal, not merely to its call
      // id: the argument fingerprint, parent/root identity and active policy
      // snapshot all participate in the pending-admission key.
      const bindingKey = JSON.stringify([stateKey, fingerprint, event.parentToolCallId ?? null, rootId]);
      const token = ++this.tokens;
      this.pending.set(event.callId, { token, stateKey, bindingKey });
      this.boundPending();
      let result: ProtectionAuditorResult;
      // What the runner's transport actually carried, captured for optional
      // retention only. Retention Off never installs this sink, so an ordinary
      // audit touches no session storage at all.
      let observation: ProtectionAuditorObservation | undefined;
      const signal = event.signal ?? readContextSignal(ctx);
      try {
        result = await (this.options.runAuditor ?? runProtectionAuditor)({
          ...(settings.retainAuditorSessions
            ? { observe: (value: ProtectionAuditorObservation) => { observation = value; } }
            : {}),
          selection: settings.auditor,
          config: this.auditorRuntimeConfig(state),
          prompt: built.prompt,
          input: auditorWireInput(settings, proposedCall, built.includedEvidenceIds, built.omittedEvidence.map((item) => item.id)),
          cwd: proposedCall.cwd,
          timeoutMs: settings.timeoutMs,
          ...(signal ? { signal } : {}),
          ...(readModelRegistry(ctx) ? { modelRegistry: readModelRegistry(ctx)! } : {}),
        });
      } catch (error) {
        // An auditor invocation that threw is still an actual invocation: with
        // retention On it is recorded too, keeping any transport observation the
        // runner managed to report, and the refusal keeps its real reason.
        this.pending.delete(event.callId);
        const detail = errorMessage(error);
        this.noteGateRefusalEvidence(event.toolName, event.callId, `auditor invocation threw: ${detail}`, false);
        const warning = await this.retainAuditorSession({
          call,
          settings,
          fingerprint,
          prompt: built.prompt,
          ...(built.policyVersion === undefined ? {} : { policyVersion: built.policyVersion }),
          ...(observation === undefined ? {} : { observation }),
          outcome: transportRecordOutcome(detail),
        });
        return refuse(
          `Tool protection: audit unavailable — the auditor invocation failed (${detail}). The proposed ${event.toolName} call was not run.`,
          warning,
        );
      }
      // Everything one record needs for this invocation, shared by every outcome
      // branch below so a record never describes a different call than the one
      // the auditor answered.
      const recordRequest = {
        call,
        settings,
        fingerprint,
        prompt: built.prompt,
        ...(built.policyVersion === undefined ? {} : { policyVersion: built.policyVersion }),
        result,
        ...(observation === undefined ? {} : { observation }),
      };
      const invalidation = this.invalidationOf(event.callId, token, stateKey, bindingKey, signal);
      if (invalidation) {
        this.pending.delete(event.callId);
        this.noteGateRefusalEvidence(event.toolName, event.callId, invalidation, false);
        const warning = await this.retainAuditorSession({
          ...recordRequest,
          outcome: {
            status: signal?.aborted === true ? "cancelled" : "invalidated",
            error: invalidation,
          },
        });
        return refuse(invalidation, warning);
      }
      // The host input object is mutable. Bind to what is still proposed when
      // the await finishes, not merely to the fingerprint stored before it.
      // Later extension mutations remain the separate documented host limit.
      const drift = this.proposalDrifted(args, event, fingerprint, systemPrompt?.prompt);
      if (drift !== undefined) {
        this.pending.delete(event.callId);
        this.noteGateRefusalEvidence(event.toolName, event.callId, drift, false);
        const warning = await this.retainAuditorSession({
          ...recordRequest,
          outcome: { status: "invalidated", error: drift },
        });
        return refuse(drift, warning);
      }

      if (result.error !== undefined) {
        this.pending.delete(event.callId);
        this.noteGateRefusalEvidence(event.toolName, event.callId, result.error, false);
        const warning = await this.retainAuditorSession({
          ...recordRequest,
          outcome: transportRecordOutcome(result.error),
        });
        return refuse(
          `Tool protection: audit unavailable — ${result.error} The proposed ${event.toolName} call was not run.`,
          warning,
        );
      }
      let decision;
      try {
        decision = parseProtectionDecision(result.output ?? "");
      } catch (error) {
        this.pending.delete(event.callId);
        const detail = `invalid auditor response: ${errorMessage(error)}`;
        this.noteGateRefusalEvidence(event.toolName, event.callId, detail, false);
        const warning = await this.retainAuditorSession({
          ...recordRequest,
          outcome: { status: "malformed", error: detail },
        });
        return refuse(
          `Tool protection: invalid auditor response — ${errorMessage(error)} The proposed ${event.toolName} call was not run.`,
          warning,
        );
      }
      if (evidence.consumedChain) {
        this.chain = undefined;
        this.chainEvidence.clear();
      }

      if (decision.decision === "PASS") {
        const audited = decision;
        // Recording is an observer of an approved call, never a gate in front of
        // it. Its one asynchronous step happens first; the admission binding is
        // then re-asserted, and both the record's outcome entry and the returned
        // admission are produced synchronously afterwards. Retention therefore
        // can never grant a stale approval, and with retention Off nothing here
        // awaits at all, leaving the final check exactly where it stood before
        // recording existed.
        const opened = settings.retainAuditorSessions
          ? await this.openAuditorRecord(recordRequest)
          : undefined;
        const lateBreak = this.invalidationOf(event.callId, token, stateKey, bindingKey, signal)
          ?? this.proposalDrifted(args, event, fingerprint, systemPrompt?.prompt);
        this.pending.delete(event.callId);
        if (lateBreak !== undefined) {
          this.noteGateRefusalEvidence(event.toolName, event.callId, lateBreak, false);
          // The record says what the gate actually did: invalidated or cancelled,
          // never a pass the call did not get.
          const warning = this.completeAuditorRecord(opened, {
            status: /audit cancelled/i.test(lateBreak) ? "cancelled" : "invalidated",
            error: lateBreak,
          });
          return refuse(lateBreak, warning);
        }
        const annotation: AnnotationRecord = {
          kind: "pass",
          toolName: event.toolName,
          ...(audited.reason !== undefined ? { reason: audited.reason } : {}),
          level: settings.level,
          policyVersion: built.policyVersion,
          durationMs: result.durationMs,
          invocationId: event.callId,
        };
        const written = this.completeAuditorRecord(opened, {
          status: "decision",
          decision: "PASS",
          ...(audited.reason === undefined ? {} : { reason: audited.reason }),
        });
        if (written !== undefined) annotation.recordWarning = written;
        // Admission is granted here, with no await between the binding check
        // above and this return.
        this.recordDecision(event, rootId, annotation);
        return undefined;
      }
      this.pending.delete(event.callId);
      const reason = decision.reason !== undefined
        ? `Tool protection: FAIL — ${decision.reason} The ${event.toolName} call did not run.`
        : `Tool protection: FAIL — the auditor denied this ${event.toolName} call. The call did not run.`;
      this.noteGateRefusalEvidence(event.toolName, event.callId, reason);
      const warning = await this.retainAuditorSession({
        ...recordRequest,
        outcome: {
          status: "decision",
          decision: "FAIL",
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        },
      });
      return refuse(reason, warning);
    } catch (error) {
      // Fail closed on any unexpected coordinator defect. Never dispatch a call
      // this layer could not evaluate.
      if (event) this.pending.delete(event.callId);
      return block(
        `Tool protection: audit unavailable — the gate could not evaluate this proposal (${errorMessage(error)}). The proposed call was not run.`,
      );
    }
  }

  /** The live protection state for this runtime (pinned child or ambient parent). */
  private currentState(): ToolProtectionState {
    const pinnedError = this.options.pinnedError?.();
    const pinned = this.options.pinned?.();
    if (pinnedError !== undefined) {
      return {
        settings: effectiveToolProtectionSettings({ toolProtection: undefined }),
        loadError: pinnedError,
        pinned: true,
      };
    }
    if (pinned) {
      return {
        settings: pinned.settings,
        pinned: true,
        ...(pinned.loadError !== undefined ? { loadError: pinned.loadError } : {}),
        ...(pinned.auditorDefinition !== undefined ? { auditorDefinition: pinned.auditorDefinition } : {}),
        ...(pinned.auditorDefinitionError !== undefined ? { auditorDefinitionError: pinned.auditorDefinitionError } : {}),
      };
    }
    return {
      settings: effectiveToolProtectionSettings(this.options.config()),
      pinned: false,
      ...(this.options.loadError?.() !== undefined ? { loadError: this.options.loadError!() } : {}),
    };
  }

  private stateKey(): string {
    const state = this.currentState();
    return JSON.stringify([
      state.settings.level,
      state.settings.auditor,
      state.settings.scope,
      state.settings.toolNames,
      state.settings.timeoutMs,
      state.settings.maxContextChars,
      state.settings.retainAuditorSessions,
      state.loadError ?? "",
      // A monotonic revision catches Off → On → Off and any other apply that
      // restores the same final values while an audit was in flight.
      this.options.revision?.() ?? 0,
      this.auditorDefinitionKey(state),
      this.options.cwd(),
    ]);
  }

  /**
   * Fingerprint of the exact auditor definition in force. For a delegated child
   * that is the pinned definition; for the parent it is the live resolved
   * definition, so a same-id definition change invalidates a stale decision.
   */
  private auditorDefinitionKey(state: ToolProtectionState): string {
    const auditor = state.settings.auditor;
    if (!auditor || auditor.source !== "external") return "pi";
    const definition = state.pinned
      ? state.auditorDefinition
      : resolvedExternalAgent(this.options.config(), auditor.id);
    if (!definition) return "missing";
    return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
  }

  /**
   * The configuration handed to the auditor runner. A pinned child exposes only
   * the parent's exact definition for the selected id, so re-resolution can
   * never select a different executable or environment from ambient files.
   */
  private auditorRuntimeConfig(state: ToolProtectionState): ReviewGateConfig {
    const live = this.options.config();
    const auditor = state.settings.auditor;
    if (!state.pinned || !auditor || auditor.source !== "external" || !state.auditorDefinition) return live;
    return {
      ...live,
      externalAgents: { [auditor.id]: state.auditorDefinition },
    };
  }

  private invalidationOf(
    callId: string,
    token: number,
    stateKey: string,
    bindingKey: string,
    signal: AbortSignal | undefined,
  ): string | undefined {
    const pending = this.pending.get(callId);
    if (!pending || pending.token !== token || pending.bindingKey !== bindingKey) {
      return "Tool protection: audit invalidated — the session, branch or native batch this proposal belonged to changed while the auditor was deciding. The proposed call was not run.";
    }
    if (signal?.aborted) {
      return "Tool protection: audit cancelled — the operation was cancelled while the auditor was deciding. The proposed call was not run.";
    }
    if (this.stateKey() !== stateKey) {
      return "Tool protection: audit invalidated — the protection configuration or working directory changed while the auditor was deciding, so the decision no longer applies to the current policy. The proposed call was not run; a fresh proposal will be audited under the new policy.";
    }
    return undefined;
  }

  /**
   * The proposal half of the admission binding: the host input object and the
   * governing prompt are mutable, so a decision is bound to what is still
   * proposed, not merely to the fingerprint stored before the await.
   */
  private proposalDrifted(
    args: unknown[],
    event: ToolCallShape,
    fingerprint: string,
    governingPrompt: string | undefined,
  ): string | undefined {
    const currentCall = readToolCall(args);
    if (currentCall && currentCall.callId === event.callId
      && currentCall.parentToolCallId === event.parentToolCallId
      && toolCallFingerprint(currentCall.toolName, currentCall.input) === fingerprint
      && readSystemPrompt(currentCall.ctx)?.prompt === governingPrompt) {
      return undefined;
    }
    return "Tool protection: audit invalidated — the proposed call or governing instructions changed while the auditor was deciding. The proposed call was not run.";
  }

  /**
   * Optional auditor-session retention (#536) — the open phase. With the setting
   * Off this is never called, so an ordinary audit awaits nothing extra and
   * touches no session storage. With it On, everything except the outcome entry
   * is written here, which is the only asynchronous part of recording.
   *
   * The returned handle finishes the record synchronously. That is deliberate:
   * the caller re-asserts its admission binding after this await and must then
   * write the outcome and decide admission without awaiting anything else, so a
   * recording problem can neither hold a stale approval open nor save a verdict
   * the gate did not actually grant.
   */
  private async openAuditorRecord(args: AuditorRecordRequest): Promise<AuditorRecordHandle | undefined> {
    if (!args.settings.retainAuditorSessions) return undefined;
    const draft = this.auditorRecordDraft(args);
    if (!draft) return undefined;
    try {
      const open = this.options.openAuditorRecord ?? openAuditorSessionRecord;
      return await open(draft, this.options.auditorRecordDependencies ?? {});
    } catch (error) {
      // Recording is an observer, never a decision input or a failure source.
      const detail = errorMessage(error);
      return {
        complete: () => ({ saved: "none", detail, warning: auditorRecordNotSavedWarning(detail) }),
      };
    }
  }

  /**
   * Open and finish one record in a single step. Used only by paths that are
   * already refusing the call, where an extra await cannot widen an approval.
   */
  private async retainAuditorSession(args: AuditorRecordRequest & { outcome: AuditorRecordOutcome }): Promise<string | undefined> {
    const opened = await this.openAuditorRecord(args);
    return this.completeAuditorRecord(opened, args.outcome);
  }

  /**
   * Finish one record. `complete()` is synchronous by contract, and a writer
   * defect is only ever disclosed: it never changes the verdict the caller
   * already reached and never becomes the reason a call is refused.
   */
  private completeAuditorRecord(handle: AuditorRecordHandle | undefined, outcome: AuditorRecordOutcome): string | undefined {
    if (!handle) return undefined;
    try {
      return handle.complete(outcome).warning;
    } catch (error) {
      const detail = errorMessage(error);
      return auditorRecordNotSavedWarning(detail);
    }
  }

  /** Assemble one record's identity, prompt, and transport content. */
  private auditorRecordDraft(args: AuditorRecordRequest): AuditorRecordOpenDraft | undefined {
    const auditor = args.settings.auditor;
    if (!auditor) return undefined;
    const cwd = this.options.cwd();
    const acting = actingSessionIdentity(args.call.ctx, cwd);
    const identity: AuditorRecordIdentity = {
      invocationId: args.call.callId,
      toolName: args.call.toolName,
      argumentFingerprint: args.fingerprint,
      ...(args.call.parentToolCallId === undefined
        ? {}
        : { parentToolCallId: args.call.parentToolCallId, lineage: lineageOf(args.call.parentToolCallId) }),
      role: this.options.role,
      ...(this.options.taskId?.() === undefined ? {} : { taskId: this.options.taskId!() }),
      cwd,
      level: args.settings.level,
      ...(args.policyVersion === undefined ? {} : { policyVersion: args.policyVersion }),
      auditor: auditor.source === "pi"
        ? {
          source: "pi",
          label: auditor.thinkingLevel === undefined ? auditor.model : `${auditor.model} (thinking ${auditor.thinkingLevel})`,
        }
        : { source: "external", label: auditor.id },
      ...(acting === undefined ? {} : { actingSessionId: acting.sessionId, actingSessionFile: acting.sessionFile }),
      ...(args.result?.durationMs === undefined ? {} : { durationMs: args.result.durationMs }),
    };
    return {
      identity,
      prompt: args.prompt,
      ...(args.observation === undefined ? {} : { observation: args.observation }),
    };
  }

  private recordDecision(event: ToolCallShape, rootId: string, record: AnnotationRecord): void {
    if (event.parentToolCallId) {
      // Nested decisions never rewrite the child's returned value; they are
      // aggregated into the outer call's model-visible result instead.
      const aggregate = this.byRoot.get(rootId) ?? { decisions: [], total: 0, recordWarningCount: 0 };
      aggregate.total += 1;
      // Counted before any retention limit, so a dropped or undisplayed line still
      // leaves its save failure visible in the outer annotation.
      if (record.recordWarning !== undefined) aggregate.recordWarningCount += 1;
      aggregate.decisions.push(record);
      if (aggregate.decisions.length > MAX_NESTED_PER_ROOT) {
        // Retention loss is disclosed in the outer annotation; prefer keeping
        // refusals over passes so an earlier denial is not the record dropped.
        const dropIndex = aggregate.decisions.findIndex((candidate) => candidate.kind !== "blocked");
        aggregate.decisions.splice(dropIndex >= 0 ? dropIndex : 0, 1);
      }
      this.byRoot.set(rootId, aggregate);
      while (this.byRoot.size > MAX_ROOTS) {
        const oldest = this.byRoot.keys().next().value;
        if (oldest === undefined) break;
        this.byRoot.delete(oldest);
      }
      return;
    }
    this.byCall.set(event.callId, record);
    this.boundPending();
  }

  private boundPending(): void {
    while (this.byCall.size > MAX_PENDING_CALLS) {
      const oldest = this.byCall.keys().next().value;
      if (oldest === undefined) break;
      this.byCall.delete(oldest);
    }
    // A bounded pending set keeps memory predictable. An evicted in-flight
    // admission loses its token and is therefore invalidated (blocked) when its
    // auditor returns; eviction never dispatches a stale decision.
    while (this.pending.size > MAX_PENDING_CALLS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  /** Attach the decision to the same tool result; never rewrite nested values. */
  private annotateToolResult(args: unknown[]): { content: unknown[] } & Record<string, unknown> | undefined {
    try {
      const event = args[0];
      if (!isRecord(event)) return undefined;
      const callId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (!callId) return undefined;
      if (typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0) {
        // A nested result is programmatic input to its caller; its text and
        // structured value must stay exactly as the tool returned them.
        return undefined;
      }
      const own = this.byCall.get(callId);
      const nested = this.byRoot.get(callId);
      if (!own && !nested) return undefined;
      this.byCall.delete(callId);
      this.byRoot.delete(callId);
      const text = [own ? statusLine(own) : undefined, nested && nested.total > 0 ? nestedLines(nested.decisions, nested.total, nested.recordWarningCount) : undefined]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n");
      if (text.length === 0) return undefined;
      const existing = Array.isArray(event.content) ? event.content : [];
      const result: Record<string, unknown> = {
        // The model-visible content carries the annotation; images and any
        // native text are preserved in order after it.
        content: [{ type: "text", text }, ...existing],
        isError: event.isError === true,
      };
      // Replacing content without this field drops structured content.
      if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
      if (event.details !== undefined) result.details = event.details;
      if (event.usage !== undefined) result.usage = event.usage;
      return result as { content: unknown[] } & Record<string, unknown>;
    } catch {
      // A presentation defect must never replace a real execution outcome with
      // a no-effect claim. Leave the native result exactly as it was.
      return undefined;
    }
  }

  /** Retire annotation/aggregation state on every terminal path, including aborted calls. */
  private retireToolExecution(args: unknown[]): void {
    try {
      const event = args[0];
      if (!isRecord(event)) return;
      const callId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (!callId) return;
      this.byCall.delete(callId);
      const nested = typeof event.parentToolCallId === "string" && event.parentToolCallId.length > 0;
      if (!nested) this.byRoot.delete(callId);
      this.pending.delete(callId);
    } catch {
      // Lifecycle cleanup must never break a run.
    }
  }

  private observeInput(args: unknown[]): void {
    try {
      const text = extractInputText(args);
      if (!text.trim()) return;
      const source = extractInputSource(args);
      // Pi reports interactive human input as `interactive`; `user` is accepted
      // for legacy/test hosts. RPC and extension deliveries reach the model in
      // the user role but are integration origins, not proof of a human
      // principal, so they are labelled as extension data.
      const origin: ProtectionEvidence["origin"] = source === "interactive" || source === "user"
        ? "user"
        : source === "extension" || source === "rpc"
          ? "extension"
          : "unknown";
      this.recordCausalEvidence(origin, text);
    } catch {
      // Evidence capture must never break input delivery.
    }
  }

  private observeAssistantMessage(args: unknown[]): void {
    try {
      const message = findAssistantMessage(args);
      if (!message) return;
      if (typeof message.content === "string") {
        const text = message.content.trim();
        if (!text) return;
        this.recordCausalEvidence("assistant", text);
        return;
      }
      if (!Array.isArray(message.content)) return;
      const hasToolCall = message.content.some((item) => isRecord(item) && item.type === "toolCall");
      if (hasToolCall) return;
      const text = message.content
        .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "text" && typeof item.text === "string")
        .map((item) => item.text as string)
        .join("")
        .trim();
      if (!text) return;
      this.recordCausalEvidence("assistant", text);
    } catch {
      // Evidence capture must never break a run.
    }
  }

  /** Retain actual supplied tool evidence, never promote its text to approval. */
  private observeToolResult(args: unknown[]): void {
    try {
      const event = args[0];
      if (!isRecord(event)) return;
      const text = toolResultEvidenceText(event);
      if (!text) return;
      this.pushEvidence({
        origin: "tool-result",
        text: text.length <= MAX_RETAINED_EVIDENCE_TEXT
          ? text
          : `[Host omission: the ${extractToolName(args) || "tool"} result exceeded the retained evidence budget; its contents were not supplied.]`,
        ...(typeof event.toolCallId === "string" ? { invocationId: event.toolCallId } : {}),
      });
    } catch {
      // Evidence observation must not replace the outcome of an executed tool.
    }
  }

  /**
   * Record live ingress text. A causal slot that cannot be retained sets an
   * explicit missing-evidence marker: the next audit then blocks with a
   * capacity diagnostic instead of proceeding without the required chain.
   */
  private recordCausalEvidence(origin: ProtectionEvidence["origin"], text: string): void {
    const record = this.pushEvidence({ origin, text });
    // The task and any later input outlive the ordinary ring. Live ingress
    // qualifies whatever the host-reported source is (genuine user input and
    // extension/RPC delivery alike); assistant text is not ingress, and an
    // unlabelled source stays ordinary evidence. The record is the same object
    // already in `recent`, never a relabelled copy, and retention below is
    // provenance-preserving: only a `user` record can fill a causal slot.
    if (record && (origin === "user" || origin === "extension")) this.retainLiveInput(record);
    // Only genuine-user and acting-assistant text can fill a causal slot.
    // Extension/RPC/unknown deliveries remain ordinary untrusted evidence.
    if (!this.chain || (origin !== "user" && origin !== "assistant")) return;
    const fillsSlot = origin === "user" ? this.chain.userId === undefined : this.chain.assistantId === undefined;
    if (!record) {
      if (fillsSlot) {
        this.missingCausalEvidence.set(origin,
          `the ${origin === "user" ? "genuine user message" : "assistant inability message"} required as causal evidence exceeded the ${MAX_RETAINED_EVIDENCE_TEXT}-character retention bound and could not be reproduced in full.`);
      }
      return;
    }
    if (origin === "user" && this.chain.userId === undefined) {
      this.chain.userId = record.id;
      this.chainEvidence.set(record.id, record);
      this.missingCausalEvidence.delete("user");
    } else if (origin === "assistant" && this.chain.assistantId === undefined) {
      this.chain.assistantId = record.id;
      this.chainEvidence.set(record.id, record);
      this.missingCausalEvidence.delete("assistant");
    }
  }

  private pushEvidence(item: Omit<ProtectionEvidence, "id">): ProtectionEvidence | undefined {
    const id = `tp-${++this.evidenceSequence}`;
    // Live user/assistant evidence is included whole or not at all, so a
    // partial quote is never presented as a complete statement. A gate record
    // is this module's own diagnostic and is kept (explicitly marked truncated
    // when huge) so a causal refusal chain cannot be silently lost.
    let text = item.text;
    if (text.length > MAX_RETAINED_EVIDENCE_TEXT) {
      if (item.origin !== "gate") return undefined;
      text = `${text.slice(0, MAX_RETAINED_EVIDENCE_TEXT)}\n[gate record truncated to the evidence budget]`;
    }
    const record: ProtectionEvidence = { ...item, text, id, createdAt: this.now() };
    this.recent.push(record);
    while (this.recent.length > this.maxRecentEvidence) {
      this.recent.shift();
    }
    return record;
  }

  private noteGateRefusalEvidence(toolName: string, invocationId: string, text: string, startChain = true): void {
    const record = this.pushEvidence({ origin: "gate", text, invocationId });
    // Only a policy refusal starts the causal approval chain. A transport,
    // context, malformed-response, cancellation or invalidation record is host
    // status: it stays evidence, but it must not discard a genuine approval.
    if (!startChain) return;
    this.chain = undefined;
    this.chainEvidence.clear();
    this.missingCausalEvidence.clear();
    if (!record) {
      this.missingCausalEvidence.set("gate",
        "this gate's own refusal record exceeded the retained-evidence bound and could not be reproduced in full.");
      return;
    }
    this.chain = { toolName, refusalId: record.id };
    this.chainEvidence.set(record.id, record);
  }

  /**
   * Keep the latest live ingress inputs within their own small bound. Records
   * are retained exactly as captured, so an extension/RPC task keeps
   * `origin: "extension"` and never occupies a genuine-user causal slot.
   */
  private retainLiveInput(record: ProtectionEvidence): void {
    if (this.retainedLiveInputs.some((item) => item.id === record.id)) return;
    this.retainedLiveInputs.push(record);
    while (this.retainedLiveInputs.length > MAX_RETAINED_LIVE_INPUTS) {
      this.retainedLiveInputs.shift();
    }
  }

  /**
   * Assemble the bounded evidence for one proposal: the session's active branch
   * (host in-memory only; restored text is labelled unknown), then this
   * activation's own live-ingress records. The causal refusal → assistant
   * inability → genuine user approval chain is marked causal only for a later
   * proposal of the same tool name, and it is consumed once it informs a
   * completed decision. Quoted approval text is never matched or promoted.
   */
  private evidenceFor(toolName: string, ctx: unknown): { items: ProtectionEvidence[]; consumedChain: boolean } {
    const live = [...this.recent];
    // Causal records are retained outside the ordinary history bound until the
    // decision consumes them, so eviction cannot silently drop the chain.
    const retainedCausal = [...this.chainEvidence.values()].filter((record) => !live.some((item) => item.id === record.id));
    // The retained live inputs live outside the ring, so they join here once,
    // by identity, with the provenance they were captured with. Their texts are
    // part of the branch exclusion set, so an older branch copy of the same
    // message (labelled `unknown` because the branch does not preserve the live
    // input source) cannot duplicate or replace the record that carries the
    // live `user` or `extension` provenance.
    const retainedInputs = this.retainedLiveInputs.filter((record) => !live.some((item) => item.id === record.id)
      && !retainedCausal.some((item) => item.id === record.id));
    const liveTexts = new Set([...live, ...retainedCausal, ...retainedInputs].map((item) => item.text));
    const branch = collectBranchEvidence(ctx, liveTexts);
    const combined = [...branch, ...[...retainedInputs, ...live, ...retainedCausal].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))];
    const chain = this.chain;
    if (!chain || chain.toolName !== toolName) return { items: combined, consumedChain: false };
    const causal = new Set([chain.refusalId, chain.assistantId, chain.userId].filter((id): id is string => Boolean(id)));
    let matched = false;
    const items = combined.map((item) => {
      if (!causal.has(item.id)) return item;
      matched = true;
      return { ...item, causal: true };
    });
    return { items, consumedChain: matched };
  }

  private seedBranchEvidence(ctx: unknown): void {
    const branch = collectBranchEvidence(ctx, new Set());
    this.recent = branch.slice(-this.maxRecentEvidence);
    // `retainedLiveInputs` deliberately stays empty after a reset: branch text
    // cannot prove live ingress provenance, so a restored message is never
    // relabelled as current-session user or extension ingress. It stays
    // available as `unknown`-origin branch evidence instead.
  }

  private registerRendererDecoration(pi: unknown): void {
    if (!isRecord(pi) || typeof pi.registerToolRenderer !== "function") return;
    const register = pi.registerToolRenderer.bind(pi) as (
      resolver: (toolName: string, next: () => unknown) => unknown,
    ) => void;
    try {
      register((_toolName, next) => {
        const base = next();
        if (!isRecord(base) || typeof base.renderResult !== "function") return base;
        const baseRender = base.renderResult.bind(base) as (...callArgs: any[]) => unknown;
        return {
          ...base,
          // Thin decoration only: draw the safely encoded gate lines above the
          // remaining renderer, and give that renderer an immutable copy without
          // the same lines so native result content is not shown twice. Display
          // spacing only — no model-visible text changes here.
          renderResult: (...callArgs: any[]) => {
            const result = callArgs[0];
            const annotation = annotationDisplayFromResult(result);
            const component = baseRender(annotation ? annotation.view : result, ...callArgs.slice(1));
            if (!annotation || !isRecord(component) || typeof component.render !== "function") return component;
            // Pi's native renderResult signature is (result, options, theme,
            // context); the collapsed view is everything that is not explicitly
            // expanded.
            const expanded = isRecord(callArgs[1]) && callArgs[1].expanded === true;
            const inner = component as unknown as {
              render(width: number): string[];
              invalidate?(): void;
              handleInput?(data: string): void;
            };
            return {
              render(width: number): string[] {
                return [
                  // Collapsed only: one blank line so the gate status does not
                  // start on the row directly under the tool-call/argument
                  // preview above. An expanded render keeps its existing spacing,
                  // and an unannotated result never gets this separator.
                  ...(expanded ? [] : [""]),
                  ...annotation.lines.flatMap((line) => wrapPreserving(visibleTerminalText(line), width)),
                  ...inner.render(width),
                ];
              },
              invalidate(): void {
                inner.invalidate?.();
              },
              ...(typeof inner.handleInput === "function"
                ? { handleInput: (data: string) => inner.handleInput!(data) }
                : {}),
            };
          },
        };
      });
    } catch {
      // A host without a usable renderer registry keeps the native fallback;
      // model-visible content still carries every decision.
    }
  }
}

/** Construct the admission coordinator for one activated runtime. */
export function createToolProtectionCoordinator(options: ToolProtectionCoordinatorOptions): ToolProtectionCoordinator {
  return new ToolProtectionCoordinator(options);
}

/**
 * How a transport-level auditor failure is described in a saved record. The
 * host status text is kept verbatim; the status label only classifies it.
 */
function transportRecordOutcome(error: string): AuditorRecordOutcome {
  if (/timed out/i.test(error)) return { status: "timeout", error };
  if (/aborted|cancelled/i.test(error)) return { status: "cancelled", error };
  return { status: "transport-error", error };
}

function block(reason: string): { block: true; reason: string } {
  return { block: true, reason: reason.length > MAX_BLOCK_REASON_CHARS ? `${reason.slice(0, MAX_BLOCK_REASON_CHARS)}…` : reason };
}

function readToolCall(args: unknown[]): ToolCallShape | undefined {
  const toolName = extractToolName(args);
  const callId = extractToolCallId(args);
  const input = extractToolArgs(args);
  if (!toolName || !callId || !input) return undefined;
  let parentToolCallId: string | undefined;
  for (const value of args) {
    if (!isRecord(value)) continue;
    if (!parentToolCallId && typeof value.parentToolCallId === "string" && value.parentToolCallId.length > 0) {
      parentToolCallId = value.parentToolCallId;
    }
  }
  const ctx = extractContext(args);
  const signal = extractSignal(args);
  return {
    callId,
    toolName,
    input,
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(ctx !== undefined ? { ctx } : {}),
    ...(signal ? { signal } : {}),
  };
}

function readContextSignal(ctx: unknown): AbortSignal | undefined {
  if (!isRecord(ctx)) return undefined;
  const signal = ctx.signal;
  if (isRecord(signal) && typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function") {
    return signal as unknown as AbortSignal;
  }
  return undefined;
}

function readSystemPrompt(ctx: unknown): { prompt: string; origin: string } | undefined {
  if (!isRecord(ctx) || typeof ctx.getSystemPrompt !== "function") return undefined;
  try {
    const prompt = (ctx.getSystemPrompt as () => unknown)();
    if (typeof prompt !== "string" || prompt.trim().length === 0) return undefined;
    return { prompt, origin: "Pi ctx.getSystemPrompt()" };
  } catch {
    return undefined;
  }
}

function readModelRegistry(ctx: unknown): ProtectionAuditorPiModelRegistry | undefined {
  if (!isRecord(ctx) || !isRecord(ctx.modelRegistry)) return undefined;
  const registry = ctx.modelRegistry;
  if (typeof registry.find !== "function" || typeof registry.getAll !== "function" || typeof registry.streamSimple !== "function") {
    return undefined;
  }
  return registry as unknown as ProtectionAuditorPiModelRegistry;
}

function findAssistantMessage(args: unknown[]): { content?: unknown } | undefined {
  for (const value of args) {
    if (!isRecord(value)) continue;
    if (value.role === "assistant") return value;
    if (isRecord(value.message) && value.message.role === "assistant") return value.message;
  }
  return undefined;
}

/**
 * Read the active in-memory branch (never a saved session file). Restored or
 * projection-derived text is labelled `unknown` because the branch does not
 * preserve the live input source; hidden thinking is never included.
 */
function collectBranchEvidence(ctx: unknown, exclude: Set<string>): ProtectionEvidence[] {
  if (!isRecord(ctx) || !isRecord(ctx.sessionManager)) return [];
  const manager = ctx.sessionManager;
  let entries: unknown;
  try {
    entries = typeof manager.buildContextEntries === "function"
      ? (manager.buildContextEntries as () => unknown)()
      : typeof manager.getBranch === "function"
        ? (manager.getBranch as () => unknown)()
        : undefined;
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const collected: ProtectionEvidence[] = [];
  for (let index = entries.length - 1; index >= 0 && collected.length < MAX_BRANCH_EVIDENCE; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry)) continue;
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      if (!summary || summary.length > MAX_BRANCH_MESSAGE_CHARS || exclude.has(summary)) continue;
      collected.unshift({ id: `branch-summary-${index}`, origin: "summary", text: summary });
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
    const text = message.role === "toolResult" ? toolResultEvidenceText(message) : typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
          .filter((item): item is Record<string, unknown> =>
            isRecord(item) && item.type === "text" && typeof item.text === "string")
          .map((item) => item.text as string)
          .join("")
        : "";
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_BRANCH_MESSAGE_CHARS || exclude.has(trimmed)) continue;
    // A branch user message may have arrived from an extension or RPC path and
    // is never treated as authenticated approval.
    collected.unshift({
      id: `branch-${index}`,
      origin: message.role === "user" ? "unknown" : message.role === "toolResult" ? "tool-result" : "assistant",
      text: trimmed,
    });
  }
  return collected;
}

function toolResultEvidenceText(message: Record<string, unknown>): string {
  const text = Array.isArray(message.content)
    ? message.content.filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
      .map((item) => (item as Record<string, unknown>).text as string).join("")
    : "";
  if (!text.trim()) return "";
  return `Native ${typeof message.toolName === "string" ? message.toolName : "tool"} result (call ${typeof message.toolCallId === "string" ? message.toolCallId : "unknown"}):\n${text}`;
}

function rootCallId(parentToolCallId: string): string {
  const separator = parentToolCallId.indexOf("/");
  return separator > 0 ? parentToolCallId.slice(0, separator) : parentToolCallId;
}

function lineageOf(parentToolCallId: string): string[] {
  const segments = parentToolCallId.split("/");
  const lineage: string[] = [];
  let current = segments[0] ?? parentToolCallId;
  lineage.push(current);
  for (let index = 1; index < segments.length; index += 1) {
    current = `${current}/${segments[index]}`;
    lineage.push(current);
  }
  return lineage;
}

function statusLine(record: AnnotationRecord): string {
  if (record.kind === "not-audited-discovery") {
    return `Tool protection: NOT AUDITED — ${record.toolName} is the tool-discovery loader, which this gate never audits. No auditor was consulted and no audit approval was needed for this call; the existing native authorization, permission, and liveness guards still applied and could still refuse it. This is not a pass.`;
  }
  if (record.kind === "not-audited") {
    return `Tool protection: NOT AUDITED — ${record.toolName} is outside the configured toolProtection.scope "selected" audit subset, so the auditor did not evaluate it. The gate did not check this call; only the existing native guards applied.`;
  }
  const warning = record.recordWarning === undefined ? "" : ` ${record.recordWarning}`;
  if (record.kind === "blocked") {
    return `Tool protection: FAIL — ${record.reason ?? `${record.toolName} was refused before execution`}${warning}`;
  }
  const timing = record.durationMs !== undefined ? `, ${record.durationMs} ms` : "";
  const head = `Tool protection: PASS — the auditor approved this ${record.toolName} call before execution (level "${record.level}"${timing}). This is an audit decision, not a claim that the tool succeeded.`;
  const body = record.reason !== undefined
    ? `${head} Auditor reason: ${record.reason}`
    : `${head} The auditor supplied no reason (host status, not auditor reasoning).`;
  return `${body}${warning}`;
}

function nestedLines(records: AnnotationRecord[], total: number, recordWarningCount: number): string {
  // Keep every retained refusal visible even when the summary line budget is
  // smaller than the retained set; an earlier denial must not be hidden behind
  // later passes.
  const blocked = records.filter((record) => record.kind === "blocked");
  const passBudget = Math.max(0, MAX_NESTED_LINES - blocked.length);
  const shownSet = new Set<AnnotationRecord>([
    ...blocked.slice(0, MAX_NESTED_LINES),
    ...(passBudget > 0 ? records.filter((record) => record.kind !== "blocked").slice(-passBudget) : []),
  ]);
  const shown = records.filter((record) => shownSet.has(record));
  // A save failure whose own decision line is omitted or evicted is disclosed on the
  // summary header instead of disappearing with the line. The decision summary bounds
  // and the verdicts themselves are unchanged.
  const hiddenRecordWarnings = recordWarningCount - shown.filter((record) => record.recordWarning !== undefined).length;
  const saveWarning = hiddenRecordWarnings > 0
    ? ` WARNING: ${hiddenRecordWarnings} auditor session(s) could not be fully saved; their decision lines are omitted here. The gate decisions are unchanged.`
    : "";
  const lines = [
    `Tool protection: ${total} nested call decision(s) in this tool's execution:${saveWarning}`,
    ...shown.map((record) => {
      if (record.kind === "not-audited") {
        return `- nested ${record.toolName}: NOT AUDITED — outside the configured audit subset; not checked by the gate.`;
      }
      if (record.kind === "not-audited-discovery") {
        return `- nested ${record.toolName}: NOT AUDITED — discovery loader, never audited by this gate; native guards still applied.`;
      }
      const warning = record.recordWarning === undefined ? "" : ` ${record.recordWarning}`;
      if (record.kind === "blocked") {
        return `- nested ${record.toolName}: FAIL/BLOCKED before execution — ${record.reason ?? "no reason supplied"}${warning}`;
      }
      const reason = record.reason !== undefined
        ? `auditor reason: ${record.reason}`
        : "the auditor supplied no reason (host status, not auditor reasoning)";
      return `- nested ${record.toolName}: PASS — approved before execution; ${reason}${warning}`;
    }),
  ];
  if (records.length > shown.length) {
    lines.push(`- ${records.length - shown.length} earlier nested decision(s) omitted from this summary.`);
  }
  if (total > records.length) {
    lines.push(`- RETENTION LOSS: ${total - records.length} nested decision record(s) are not retained in this summary (bounded runtime state). Refusals are retained preferentially; this count is disclosed rather than presented as complete.`);
  }
  return lines.join("\n");
}

/**
 * The gate's own bounded lines plus an immutable renderer-only view with those
 * lines removed from the gate text block.
 */
interface AnnotationDisplay {
  lines: string[];
  /** Shallow result copy; the original model-visible result is never mutated. */
  view: unknown;
}

/**
 * The gate's own auditor-session recording failures, in each form they take: a
 * per-call warning, and the bounded nested summary's aggregate count.
 */
const SAVE_WARNING_PATTERN = /Tool protection: the auditor session (?:could not be saved|was only partially saved)|WARNING: \d+ auditor session\(s\) could not be fully saved/;

/**
 * Extract this gate's own annotation from an already-annotated result, for the
 * thin renderer decoration. The base renderer receives a copy without the
 * drawn lines so a native renderer does not show the same refusal or status
 * twice, while a custom renderer that ignores `content` still gets the lines
 * above its own output. The original result is left untouched.
 */
function annotationDisplayFromResult(result: unknown): AnnotationDisplay | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  for (let index = 0; index < result.content.length; index += 1) {
    const item = result.content[index];
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string" || !item.text.startsWith("Tool protection:")) continue;
    const text = item.text;
    // A recording failure must stay visible even when a custom renderer ignores
    // the content left outside this decoration's ordinary display budget. Ordinary
    // annotations keep the existing line and character limits; a warning-bearing
    // annotation is drawn whole, and the removal logic below then prevents any
    // duplicate from the native block.
    const lines = SAVE_WARNING_PATTERN.test(text)
      ? text.split("\n")
      : text
        .slice(0, MAX_RETAINED_EVIDENCE_TEXT)
        .split("\n")
        .slice(0, MAX_NESTED_LINES + 1);
    const drawn = lines.join("\n");
    // Remove only whole lines this decoration draws. A retention truncation
    // that cut a line in half cannot be reproduced by the header, so in that
    // case the native block stays intact rather than losing visible text.
    if (text !== drawn && !text.startsWith(`${drawn}\n`)) return { lines, view: result };
    const remainder = text === drawn ? "" : text.slice(drawn.length + 1);
    const content = remainder.length === 0
      ? result.content.filter((_block, blockIndex) => blockIndex !== index)
      : result.content.map((block, blockIndex) => blockIndex === index ? { ...item, text: remainder } : block);
    return { lines, view: { ...result, content } };
  }
  return undefined;
}

function auditorWireInput(
  settings: EffectiveToolProtectionSettings,
  proposedCall: {
    invocationId: string;
    toolName: string;
    args: unknown;
    cwd: string;
    role: string;
    taskId?: string;
    lineage?: string[];
  },
  includedEvidenceIds: readonly string[],
  omittedEvidenceIds: readonly string[],
): unknown {
  return {
    version: "pi-tool-protection-input-v1",
    policyVersion: TOOL_PROTECTION_POLICY_VERSION,
    level: settings.level,
    invocation: proposedCall,
    context: {
      includedEvidenceIds: [...includedEvidenceIds],
      omittedEvidenceIds: [...omittedEvidenceIds],
    },
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.trim() || "unknown error";
  return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}…`;
}
