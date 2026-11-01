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
 *   list. That record is user-only presentation state and never claims PASS or
 *   safety; the acting model's result stays exactly what the tool returned.
 * - The canonical `tool_search` discovery loader is the one infrastructure
 *   exemption (`isToolProtectionDiscoveryLoaderExempt`): it is never sent to the
 *   auditor at any scope or level, and it never waits on the auditor's
 *   availability, the context budget, or a configuration load error, because
 *   discovery is how a model reaches the tools this gate would otherwise judge.
 *   The exemption records `NOT AUDITED — discovery loader` as user-only
 *   presentation state, never a PASS, and it bypasses nothing that native Pi
 *   already enforces: the
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
 * Presentation is fail-closed about what the acting model is told (issue #549).
 * A FAIL reason is the native admission block reason (blocked calls never reach
 * `tool_result`), and a nested refusal is aggregated into the outer call's
 * model-visible result. A PASS or NOT AUDITED decision adds nothing to the
 * acting model's result in either debug mode: the canonical native content,
 * `structuredContent`, `details`, `isError`, `usage` and images stay exactly as
 * the tool returned them. Those routine diagnostics are user-only presentation
 * state (see `display.ts`): the tool row draws them when `toolProtection.debug`
 * is On, and an auditor-session save failure stays visible for either value.
 * Nested child calls are audited individually, but their returned values are
 * never rewritten. Auditor text is untrusted display data.
 *
 * Honest limitations (source-backed, not guarantees):
 * - Pi permits later `tool_call` handlers and provider-request hooks to rewrite
 *   input or instructions after this handler returns. This gate audits what it
 *   was given at its own hook position; it is not a sandbox and does not prove
 *   the final byte-identical dispatch.
 * - A custom tool renderer may ignore result `content`. A thin renderer
 *   decoration is registered when the host exposes `registerToolRenderer`, but
 *   a renderer that draws neither the content nor the decoration is outside this
 *   gate's reach. A tool the host gives no result renderer keeps the host's own
 *   native result fallback untouched, and its user-only diagnostics come from
 *   the gate's non-context session-entry renderer instead.
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
import {
  auditDisplayModelLines,
  auditDisplayRows,
  auditDisplayTheme,
  auditDisplayUserLines,
  AuditDisplayState,
  boundAuditDisplayRecords,
  clampAuditDisplayReason,
  clampAuditDisplayText,
  clampAuditDisplayWarning,
  findAuditDisplayData,
  normalizeAuditDisplayData,
  TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE,
  TOOL_PROTECTION_DISPLAY_VERSION,
  type AuditDisplayColor,
  type AuditDisplayBackground,
  type AuditDisplayData,
  type AuditDisplayRecord,
  type AuditDisplayTheme,
} from "./display";
import { parseProtectionDecision } from "./decision";
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
import { wrapAtWordBoundaries } from "../tool-result-wrap";
import { visibleTerminalText } from "../tool-result-text";
import { expansionHint, nativeImageDisclosure, visibleLineWidth, wrapAnsiAwareRows } from "../presentation-hints";

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
      debug: pin.settings.debug,
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
      // Same for the #549 audit-diagnostic switch: a pin from a parent that
      // predates it omits the field, which normalizes to Off, so an older launch
      // gets the same quiet presentation as a new one instead of inventing
      // output that its policy never asked for.
      debug: parsed.settings.debug,
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

/**
 * One pre-execution refusal handed back from the composed `tool_call` seam.
 *
 * `block`/`reason` are exactly the native Pi block action. `auditTimeout` is
 * internal to this extension: it states that this refusal ended a confirmed
 * auditor decision deadline, which the native duplicate guard needs in order to
 * keep a proposal that never started from spending the tool's repeated-use
 * allowance. It grants nothing, and the entrypoint hands the host only the
 * `{block,reason}` action.
 */
export interface ToolProtectionRefusal {
  block: true;
  reason: string;
  auditTimeout?: true;
}

interface NestedAggregate {
  decisions: AnnotationRecord[];
  /** Total decisions observed, including records no longer retained. */
  total: number;
  /**
   * Refusals observed, counted independently of the retained set, so a bounded
   * model-visible summary never presents an all-call total as a failure total
   * and never hides a refusal behind retention.
   */
  refusalTotal: number;
  /**
   * Recording failures observed, counted independently of the retained and
   * displayed sets. Bounded summary state may drop a decision's own line, but a
   * save failure must never go silent, so its count survives eviction.
   */
  recordWarningCount: number;
  /**
   * Recording failures attached to a refused nested call. They are disclosed by
   * the model-visible refusal block; the user rows account for the remaining
   * population separately, so one failure is never counted in both places and a
   * failure on a call that ran never becomes model-visible content.
   */
  refusalWarningCount: number;
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
  /**
   * Durable-write seam for the user-only display state, captured from the host
   * that registered these hooks. Absent means the host has no session-entry API
   * (or none is wired in a test), and the rows stay in-memory only.
   */
  private appendDisplayEntry: ((customType: string, data: AuditDisplayData) => void) | undefined;
  /**
   * The host's own active-branch entry reader, captured from the session context
   * that rebuilt display state. It is used only to recover one call's recorded
   * presentation when the bounded lookup no longer retains that call: the active
   * branch stays the only source, no branch content is stored here, and the
   * recovered record re-enters the same bounded lookup.
   */
  private displayBranchReader: (() => unknown[]) | undefined;
  /**
   * Bounded user-only audit diagnostics keyed by the host's own tool call id.
   * This is presentation state only: no admission path reads it, and nothing
   * restored from a session entry is ever treated as a decision.
   */
  private readonly display = new AuditDisplayState({
    appendEntry: (customType, data) => this.appendDisplayEntry?.(customType, data),
  });

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
    // Display state follows the active branch, so it resets with the session and
    // is rebuilt from that branch only. Restoring it grants nothing: it is never
    // read as an approval, and no replayed entry can authorize a call.
    this.display.reset();
    this.displayBranchReader = undefined;
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
      const ctx = extractContext(args);
      this.restoreDisplayState(ctx);
      this.seedBranchEvidence(ctx);
    });
    registerHook(pi, "session_tree", (...args) => {
      this.reset();
      // A branch switch is exactly when restored UI state matters: only the new
      // active branch is read, never every file entry.
      this.restoreDisplayState(extractContext(args));
    });
    registerHook(pi, "session_shutdown", () => {
      this.reset();
    });
    this.registerDisplayHooks(pi);
    this.registerRendererDecoration(pi);
  }

  /**
   * Wire the user-only display surfaces. `pi.appendEntry()` is the host's own
   * durable, non-context session storage, and `pi.registerEntryRenderer()` is
   * the host's own renderer for it: no separate file, writer, or session is
   * created, and a plain custom entry never participates in model context.
   */
  private registerDisplayHooks(pi: unknown): void {
    if (isRecord(pi) && typeof pi.appendEntry === "function") {
      const append = pi.appendEntry as (customType: string, data: unknown) => void;
      this.appendDisplayEntry = (customType, data) => append(customType, data);
    }
    if (!isRecord(pi) || typeof pi.registerEntryRenderer !== "function") return;
    const register = pi.registerEntryRenderer as unknown as (customType: string, renderer: unknown) => void;
    try {
      register(TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE, (entry: unknown, _options: unknown, theme: unknown) => {
        const data = normalizeAuditDisplayData(isRecord(entry) ? entry.data : undefined);
        if (!data) return undefined;
        // The surface that owns this call is whichever one the host is using
        // now, not the one recorded when the call was audited: a result renderer
        // can be added or removed later. While this runtime has not resolved the
        // tool, the recorded surface is the fallback. Only one surface draws a
        // call, so no diagnostic appears twice and none is dropped.
        const surface = this.display.currentSurfaceFor(data.toolName) ?? data.surface;
        if (surface !== "entry") return undefined;
        const lines = auditDisplayUserLines(data, this.currentState().settings.debug === true, surface);
        if (lines.length === 0) return undefined;
        const displayTheme = auditDisplayTheme(theme);
        return {
          render(width: number): string[] {
            return auditDisplayRows(lines, displayTheme, width);
          },
          invalidate(): void {},
        };
      });
    } catch {
      // A host without an entry renderer keeps the rows it can draw; nothing
      // about a decision changes, and no diagnostic moves into model content.
    }
  }

  /** Rebuild display state from the active branch only (never a saved file read). */
  private restoreDisplayState(ctx: unknown): void {
    if (!isRecord(ctx) || !isRecord(ctx.sessionManager)) return;
    const manager = ctx.sessionManager;
    if (typeof manager.getBranch !== "function") return;
    // Keep the host's own reader for later on-demand recovery: the active branch
    // is re-read through the host each time, never copied into this gate.
    this.displayBranchReader = (manager.getBranch as () => unknown[]).bind(manager);
    try {
      const entries = (manager.getBranch as () => unknown)();
      if (Array.isArray(entries)) this.display.restore(entries);
    } catch {
      // Restored presentation is optional; a host that cannot answer stays quiet.
    }
  }

  /**
   * Audit one already-admitted native tool proposal.
   *
   * Returns `undefined` when the native callback may run (Off, outside a
   * `selected` scope with a NOT AUDITED annotation recorded, or a current valid
   * PASS) and a native `{block:true,reason}` otherwise, carrying the internal
   * `auditTimeout` marker only when the refusal ended a confirmed auditor
   * timeout. This method never throws: every internal failure blocks the
   * proposed call.
   */
  async admitToolCall(args: unknown[]): Promise<ToolProtectionRefusal | undefined> {
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
      const refuse = (reason: string, disclosure?: string, auditTimeout?: true): ToolProtectionRefusal =>
        this.refuseCall(call, reason, disclosure, auditTimeout);
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
        // Only the external envelope carries metadata beside the request text,
        // and that payload is paid for out of the same context budget. The
        // in-process Pi route carries the request text alone, so it reserves
        // nothing.
        ...(settings.auditor.source === "external"
          ? { wire: { argumentFingerprint: fingerprint } }
          : {}),
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
          input: built.wireInput,
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
        // The refusal, its evidence, and the reported transport facts are
        // unchanged. The marker only records that this attempt ended on the
        // auditor's own deadline, so the admission seam can keep a call that
        // never started out of the tool's duplicate-execution accounting.
        return refuse(
          `Tool protection: audit unavailable — ${result.error} The proposed ${event.toolName} call was not run.`,
          warning,
          result.timedOut === true ? true : undefined,
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
      const reason = `Tool protection: audit unavailable — the gate could not evaluate this proposal (${errorMessage(error)}). The proposed call was not run.`;
      if (!event) return block(reason);
      this.pending.delete(event.callId);
      return this.refuseCall(event, reason);
    }
  }

  /**
   * Refuse one bound call, and record how that refusal is presented.
   *
   * A nested refusal is aggregated onto its root, because a child's own returned
   * value must stay untouched. A root refusal never reaches a `tool_result` hook
   * at all, so a result renderer that ignores content would otherwise hide the
   * gate's diagnostic from the user: the exact text handed to the host is
   * recorded against the host's own call id, and the row decoration draws that
   * recorded text and removes it from the renderer's copy only when the content
   * carries it byte-for-byte. Recorded presentation is never read back as an
   * admission decision, and a tool result this gate has no provenance for is
   * never rewritten.
   */
  private refuseCall(
    call: ToolCallShape,
    reason: string,
    disclosure?: string,
    auditTimeout?: true,
  ): ToolProtectionRefusal {
    const refusal = block(disclosure === undefined ? reason : `${reason}\n${disclosure}`);
    const action: ToolProtectionRefusal = auditTimeout === true
      ? { block: true, reason: refusal.reason, auditTimeout: true }
      : refusal;
    const level = this.currentState().settings.level;
    if (call.parentToolCallId) {
      this.recordDecision(call, rootCallId(call.parentToolCallId), {
        kind: "blocked",
        toolName: call.toolName,
        reason,
        ...(disclosure === undefined ? {} : { recordWarning: disclosure }),
        level,
        invocationId: call.callId,
      });
      return action;
    }
    const toolName = clampAuditDisplayText(call.toolName, 120) || "tool";
    this.display.publish({
      version: TOOL_PROTECTION_DISPLAY_VERSION,
      callId: call.callId,
      toolName,
      surface: this.display.surfaceFor(call.toolName),
      nestedTotal: 0,
      refusalTotal: 1,
      nestedWarningCount: 0,
      nestedRefusalWarningCount: 0,
      rootRefusalText: refusal.reason,
      records: [{ kind: "blocked", toolName, level, nested: false }],
    });
    return action;
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
      const aggregate = this.byRoot.get(rootId)
        ?? { decisions: [], total: 0, refusalTotal: 0, recordWarningCount: 0, refusalWarningCount: 0 };
      aggregate.total += 1;
      if (record.kind === "blocked") aggregate.refusalTotal += 1;
      // Counted before any retention limit, so a dropped or undisplayed line still
      // leaves its save failure visible in the outer annotation.
      if (record.recordWarning !== undefined) {
        aggregate.recordWarningCount += 1;
        if (record.kind === "blocked") aggregate.refusalWarningCount += 1;
      }
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

  /**
   * Publish this call's user-only diagnostics, and add the model-visible half.
   *
   * The model-visible half is only ever a nested refusal: a PASS, a NOT AUDITED
   * record, or a save failure on either of them adds nothing to the acting
   * model's result, which stays byte-identical to what the tool returned. Never
   * a nested value rewrite: nested results are programmatic input to their
   * caller, so their text and structured value stay untouched.
   */
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
      const toolName = typeof event.toolName === "string" && event.toolName.length > 0
        ? event.toolName
        : own?.toolName ?? "tool";
      const records: AuditDisplayRecord[] = [];
      if (own) records.push(displayRecord(own, false));
      for (const record of nested?.decisions ?? []) records.push(displayRecord(record, true));
      const data: AuditDisplayData = {
        version: TOOL_PROTECTION_DISPLAY_VERSION,
        callId,
        toolName,
        surface: this.display.surfaceFor(toolName),
        nestedTotal: nested?.total ?? 0,
        refusalTotal: nested?.refusalTotal ?? 0,
        nestedWarningCount: nested?.recordWarningCount ?? 0,
        nestedRefusalWarningCount: nested?.refusalWarningCount ?? 0,
        records: boundAuditDisplayRecords(
          records.find((record) => !record.nested),
          records.filter((record) => record.nested),
        ),
      };
      // Durable UI state first: the rows survive a reload or branch switch, and
      // a restored entry is never read back as a decision.
      this.display.publish(data);
      const lines = auditDisplayModelLines(data);
      if (lines.length === 0) return undefined;
      const text = lines.join("\n");
      const existing = Array.isArray(event.content) ? event.content : [];
      const result: Record<string, unknown> = {
        // Only a refusal block is prepended; images and any native text are
        // preserved in order after it.
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
        text,
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
          `the ${origin === "user" ? "genuine user message" : "assistant inability message"} required as causal evidence could not be retained for this session.`);
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

  private pushEvidence(item: Omit<ProtectionEvidence, "id">): ProtectionEvidence {
    const id = `tp-${++this.evidenceSequence}`;
    // Oversized supplied text is retained as its leading bound and marked
    // partial rather than dropped (#590): an oversized genuine approval or
    // inability message is still the causal evidence a later proposal needs, and
    // the auditor receives it inside the configured context budget instead of
    // the call being refused for its size. The marker keeps a retained prefix
    // from ever reading as a complete statement. A gate record is this module's
    // own diagnostic and keeps its existing note.
    let text = item.text;
    let partial: true | undefined;
    if (text.length > MAX_RETAINED_EVIDENCE_TEXT) {
      text = boundedLeadingText(text, MAX_RETAINED_EVIDENCE_TEXT);
      partial = true;
      if (item.origin === "gate") text = `${text}\n[gate record truncated to the evidence budget]`;
    }
    const record: ProtectionEvidence = {
      ...item,
      text,
      id,
      createdAt: this.now(),
      ...(partial === undefined ? {} : { partial }),
    };
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
    // One merged list in host chronology, oldest first. Recency in the bounded
    // context is global, so a cached live record cannot outrank newer branch
    // content and newer branch content cannot be pushed behind an older live
    // record by source grouping; provenance stays on each record (#590).
    // Duplicates are already excluded above by identity and by text, and equal
    // or unknown times keep the order the host supplied them in.
    const combined = [...branch, ...retainedInputs, ...live, ...retainedCausal]
      .sort((a, b) => compareCreatedAt(a, b));
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
      register((toolName, next) => {
        const base = next();
        // Capability probe, learned from the host's own renderer resolution: is
        // this gate's row decoration the surface that draws this tool's rows?
        // With the current decoration the answer is every definition the host
        // resolves: the wrapper installed here draws the gate rows for any call
        // this gate has provenance for, including a definition with no result
        // renderer of its own, whose body this decoration draws through the
        // host's own native-fallback conventions (#547). Only a definition the
        // host does not resolve at all leaves the whole row to the host's
        // fallback with no gate rows, and its user-only rows then come from the
        // entry renderer instead. The probe records the effective row owner
        // rather than whether the original definition happened to carry a
        // method, so exactly one surface draws a call: neither a duplicate nor a
        // hidden refusal.
        this.display.noteToolRenderer(toolName, isRecord(base));
        if (!isRecord(base)) return base;
        const baseRender = typeof base.renderResult === "function"
          ? base.renderResult.bind(base) as (...callArgs: any[]) => unknown
          : undefined;
        // Pi picks the row shell from the resolved renderers
        // (tool-execution.js getRenderShell). `"self"` — the native edit tool —
        // means the tool draws its own framing and the host paints nothing
        // around it, so this decoration has to paint its own rows and the body
        // rows it emits; `"default"` means the host's Box pads and paints every
        // row of its children, including these, so the decoration must not add
        // a second padding or background layer.
        const selfShell = base.renderShell === "self";
        return {
          ...base,
          // Thin decoration only: draw the safely encoded gate rows above the
          // remaining renderer, and give that renderer an immutable copy without
          // the same lines so native result content is not shown twice. Display
          // spacing, wrapping and theme styling only — no model-visible text
          // changes here.
          renderResult: (...callArgs: any[]) => {
            const result = callArgs[0];
            const context = callArgs[3];
            const annotation = this.displayForRender(result, context);
            // Pi reuses the component a renderer returned last time as
            // `context.lastComponent`. Hand the native renderer its own
            // component rather than this decoration wrapper, so the native
            // incremental rendering (clear/setText/addChild) keeps working and
            // the gate rows are never nested or duplicated across redraws. A
            // lightweight context without a per-row state keeps the previous
            // pass-through behavior.
            const state = isRecord(context) && isRecord(context.state)
              ? context.state as Record<string | symbol, unknown>
              : undefined;
            let inner: AnnotationDisplayComponent | undefined;
            if (baseRender !== undefined) {
              const baseArgs = callArgs.slice(1);
              if (state !== undefined && baseArgs.length >= 3) {
                baseArgs[2] = { ...context, lastComponent: state[ANNOTATION_DISPLAY_INNER] };
              }
              const component = baseRender(annotation ? annotation.view : result, ...baseArgs);
              if (state !== undefined) state[ANNOTATION_DISPLAY_INNER] = component;
              if (!annotation || !isRecord(component) || typeof component.render !== "function") return component;
              inner = component as unknown as AnnotationDisplayComponent;
            } else if (annotation === undefined) {
              // A definition with no result renderer (the host's own text
              // fallback draws the row): an unannotated result keeps the host's
              // presentation exactly. Pi catches a renderer failure and renders
              // its native fallback, so handing the row back beats reproducing
              // that fallback here and cannot drift from it.
              throw new Error("pi-review-gate: the native result fallback owns this unannotated result");
            }
            // Pi's native renderResult signature is (result, options, theme,
            // context); the collapsed view is everything that is not explicitly
            // expanded.
            const expanded = isRecord(callArgs[1]) && callArgs[1].expanded === true;
            // Pi hands the live theme to renderResult as its third argument.
            // Use its ordinary semantic tokens so the audit rows read like
            // native status text; a lightweight host/mock without a theme keeps
            // the plain rows. The verdict comes from the gate's own row text,
            // so a nested refusal, a NOT AUDITED row, or a recording warning is
            // never shown as success merely because the tool returned normally.
            const theme = auditDisplayTheme(callArgs[2]);
            // A self-shell row is painted by whoever draws it, so the gate rows
            // and the body rows below them use the host's own semantic row
            // background — pending while the tool runs, error for a failed
            // result, success otherwise — exactly the tokens
            // ToolExecutionComponent picks for its default shell.
            const background = selfShell ? annotationDisplayBackground(theme, callArgs[1], context) : undefined;
            const padding = background === undefined ? 0 : annotationDisplayPadding(context);
            return {
              render(width: number): string[] {
                // The card's own horizontal inset, and the width the text has
                // to fit in: the host's Box already shrank the width for its
                // default shell, a self-shell row owns its own padding.
                const pad = Math.min(padding, Math.max(0, Math.floor((width - 1) / 2)));
                const contentWidth = Math.max(1, width - pad * 2);
                const auditRows = [
                  // Collapsed only: one blank line so the gate status does not
                  // start on the row directly under the tool-call/argument
                  // preview above. An expanded render keeps its existing spacing,
                  // and an unannotated result never gets this separator.
                  ...(expanded ? [] : [""]),
                  // Sanitize and wrap first, then style each physical row: theme
                  // escapes are never counted as printable width, and the row
                  // text and order are unchanged.
                  ...auditDisplayRows(annotation.lines, theme, contentWidth, pad),
                ];
                const bodyRows = inner !== undefined
                  ? inner.render(width)
                  : annotationFallbackRows(annotation.view, theme, expanded, context, contentWidth, pad);
                const rows = [...auditRows, ...bodyRows];
                // A self-shell row otherwise sits on the terminal's own
                // background, which breaks the card apart: paint every emitted
                // row — audit rows, the blank separator, and the body rows the
                // inner renderer emits — to the full row width so the themed
                // card stays continuous including its gaps.
                return background === undefined ? rows : rows.map((row) => paintAnnotationRow(row, width, background));
              },
              invalidate(): void {
                inner?.invalidate?.();
              },
              ...(typeof inner?.handleInput === "function"
                ? { handleInput: (data: string) => inner!.handleInput!(data) }
                : {}),
            };
          },
        };
      });
    } catch {
      // A host without a usable renderer registry keeps the native fallback;
      // model-visible content still carries every refusal this gate reports.
    }
  }

  /**
   * Draw a call's presentation from call-bound provenance only.
   *
   * Display state is keyed by the host's public `toolCallId`. A result this gate
   * has no provenance for — an older session, a tool whose own output happens to
   * look like an audit line, or a row that never drew these rows — is handed to
   * the renderer exactly as the tool returned it, and nothing is drawn above it.
   * Text is removed from the renderer's copy only when it is byte-for-byte one
   * of the blocks this gate recorded for this call.
   *
   * Provenance is call-bound and bounded: this gate's bounded display lookup
   * while it retains the call, then the provenance this very row already drew.
   * Pi keeps one `context.state` object per tool row, so an older row keeps
   * drawing its own rows after the bounded lookup evicts the call — on an
   * expansion, a redraw, or a later pass — without a wider cache, a second
   * writer, an extra audit, or any guess from the tool's own text. It stays
   * presentation only: restored or stashed state is never an approval.
   */
  private displayForRender(result: unknown, context: unknown): AnnotationDisplay | undefined {
    const callId = isRecord(context) && typeof context.toolCallId === "string" ? context.toolCallId : undefined;
    if (callId === undefined) return undefined;
    const rowState = isRecord(context) && isRecord(context.state)
      ? context.state as Record<symbol, unknown>
      : undefined;
    const canRecover = this.displayBranchReader !== undefined && this.display.publishedAny;
    const data = this.display.dataFor(callId)
      ?? stashedDisplayProvenance(rowState, callId)
      ?? (canRecover ? this.recoverDisplayProvenance(callId) : undefined);
    if (!data) return undefined;
    if (rowState !== undefined) rowState[ANNOTATION_DISPLAY_PROVENANCE] = data;
    // This decoration is the row surface: it only wraps a tool the host resolved
    // with a result renderer, so these rows are the route drawing this call now,
    // whatever surface was recorded when the call was audited.
    const userOnly = auditDisplayUserLines(data, this.currentState().settings.debug === true, "row");
    const carried = auditDisplayModelLines(data);
    const recorded = data.rootRefusalText === undefined ? [] : [data.rootRefusalText];
    const blocks = [...(carried.length === 0 ? [] : [carried.join("\n")]), ...recorded];
    if (blocks.length === 0) {
      return userOnly.length === 0 ? undefined : { lines: userOnly, view: result };
    }
    const stripped = stripRecordedBlocks(result, blocks);
    if (stripped === undefined || stripped.stripped === 0) {
      // None of this call's recorded blocks is in the content this renderer was
      // handed, so the content is left untouched and only the rows are drawn.
      return userOnly.length === 0 ? undefined : { lines: userOnly, view: result };
    }
    return { lines: [...userOnly, ...carried], view: stripped.view };
  }

  /**
   * Recover one call's recorded presentation from the entries the host reports
   * for the ACTIVE branch, when the bounded lookup no longer retains the call.
   * The record is found by the host's own call id among this gate's own entry
   * type: no tool text is pattern-matched, nothing is cached beyond the same
   * bounded lookup, no second writer or audit is added, and only the branch the
   * user is looking at is read. A recovered record is presentation only and can
   * never authorize a call.
   */
  private recoverDisplayProvenance(callId: string): AuditDisplayData | undefined {
    const readBranch = this.displayBranchReader;
    if (readBranch === undefined) return undefined;
    try {
      const entries = readBranch();
      if (!Array.isArray(entries)) return undefined;
      const data = findAuditDisplayData(entries, callId);
      if (data) this.display.remember(data);
      return data;
    } catch {
      // A host that cannot answer keeps the presentation quiet; no decision and
      // no model-visible content changes.
      return undefined;
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
 * The leading `limit` code units of one retained text, never split in the middle
 * of a non-BMP character: a lone surrogate would be quoted back as an escape the
 * host never sent.
 */
function boundedLeadingText(text: string, limit: number): string {
  let cut = limit;
  if (cut > 0 && cut < text.length) {
    const previous = text.charCodeAt(cut - 1);
    const next = text.charCodeAt(cut);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
  }
  return text.slice(0, cut);
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
      const rawSummary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      if (!rawSummary || exclude.has(rawSummary)) continue;
      // An oversized summary is kept as its leading portion and marked, instead
      // of disappearing while older material fills the budget (#590).
      const summary = boundedLeadingText(rawSummary, MAX_BRANCH_MESSAGE_CHARS);
      collected.unshift({
        id: `branch-summary-${index}`,
        origin: "summary",
        text: summary,
        ...(summary.length < rawSummary.length ? { partial: true } : {}),
        ...entryCreatedAt(entry),
      });
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
    const raw = text.trim();
    if (!raw || exclude.has(raw)) continue;
    // A branch user message may have arrived from an extension or RPC path and
    // is never treated as authenticated approval. An oversized message is kept
    // as its leading portion and marked, so the newest session content still
    // reaches the audit inside the retention bound (#590).
    const trimmed = boundedLeadingText(raw, MAX_BRANCH_MESSAGE_CHARS);
    collected.unshift({
      id: `branch-${index}`,
      origin: message.role === "user" ? "unknown" : message.role === "toolResult" ? "tool-result" : "assistant",
      text: trimmed,
      ...(trimmed.length < raw.length ? { partial: true } : {}),
      ...entryCreatedAt(entry),
    });
  }
  return collected;
}

/**
 * The recorded time of one session entry as `{ createdAt }`, for host
 * chronology. Branch entries carry their own timestamp; an entry without one
 * stays undated and sorts oldest, which keeps it from outranking content whose
 * time is known.
 */
function entryCreatedAt(entry: Record<string, unknown>): { createdAt?: number } {
  const value = entry.timestamp ?? entry.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return { createdAt: value };
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return { createdAt: parsed };
  }
  return {};
}

/**
 * Host chronology for merged evidence. A record with no recorded time sorts
 * oldest, so known times always win the ordering; equal times keep the order the
 * host supplied, which is how the session recorded them.
 */
function compareCreatedAt(a: ProtectionEvidence, b: ProtectionEvidence): number {
  const left = typeof a.createdAt === "number" && Number.isFinite(a.createdAt) ? a.createdAt : UNDATED_CREATED_AT;
  const right = typeof b.createdAt === "number" && Number.isFinite(b.createdAt) ? b.createdAt : UNDATED_CREATED_AT;
  return left < right ? -1 : left > right ? 1 : 0;
}

const UNDATED_CREATED_AT = Number.MIN_SAFE_INTEGER;

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

/**
 * One admission record as bounded user-only display metadata. A PASS or NOT
 * AUDITED record keeps no reason at all; only a refusal keeps its reason,
 * because that refusal is already model-visible in the outer call's result. The
 * reason is stored as supplied — the display path never trims it or cuts it
 * shorter than the auditor's own bound, and an empty supplied reason stays an
 * empty supplied reason.
 */
function displayRecord(record: AnnotationRecord, nested: boolean): AuditDisplayRecord {
  return {
    kind: record.kind,
    toolName: clampAuditDisplayText(record.toolName, 120) || "tool",
    level: record.level,
    nested,
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    ...(record.kind === "blocked" && record.reason !== undefined
      ? { reason: clampAuditDisplayReason(record.reason) }
      : {}),
    ...(record.recordWarning === undefined
      ? {}
      : { recordWarning: clampAuditDisplayWarning(record.recordWarning) }),
  };
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
 * Per-row slot holding the native component this decoration last returned, so
 * the native renderer is given its own `lastComponent` instead of the wrapper.
 */
const ANNOTATION_DISPLAY_INNER = Symbol("pi-review-gate.annotation-display-inner");

/**
 * Per-row slot holding the call-bound display provenance this row already drew.
 * Pi keeps one render-context `state` object per tool row, so this is bounded by
 * the rows on screen and never becomes a wider presentation cache.
 */
const ANNOTATION_DISPLAY_PROVENANCE = Symbol("pi-review-gate.annotation-display-provenance");

/** The structural component shape this decoration wraps or replaces. */
interface AnnotationDisplayComponent {
  render(width: number): string[];
  invalidate?(): void;
  handleInput?(data: string): void;
}

/**
 * The provenance this row already drew, accepted only when it is this gate's own
 * record for this exact call id. Anything else — a hand-edited context, another
 * call's record — is no provenance at all.
 */
function stashedDisplayProvenance(
  state: Record<symbol, unknown> | undefined,
  callId: string,
): AuditDisplayData | undefined {
  const stashed = state === undefined ? undefined : state[ANNOTATION_DISPLAY_PROVENANCE];
  if (!isRecord(stashed)) return undefined;
  if (stashed.version !== TOOL_PROTECTION_DISPLAY_VERSION) return undefined;
  if (stashed.callId !== callId || !Array.isArray(stashed.records)) return undefined;
  return stashed as unknown as AuditDisplayData;
}

/**
 * The row background for a tool that draws its own shell. These are the same
 * semantic tokens `ToolExecutionComponent.updateDisplay()` chooses for the
 * default shell — pending while the tool is still producing output, error for a
 * failed result, success otherwise — so the gate rows continue the card instead
 * of sitting on the terminal's own background. `PASS` still means the audit
 * decision, never that the tool succeeded: a failed tool keeps the error row
 * background while its `Tool protection: PASS` line keeps the success token.
 */
function annotationDisplayBackground(
  theme: AuditDisplayTheme | undefined,
  options: unknown,
  context: unknown,
): ((text: string) => string) | undefined {
  if (theme === undefined || typeof theme.bg !== "function") return undefined;
  const color: AuditDisplayBackground = isRecord(options) && options.isPartial === true
    ? "toolPendingBg"
    : isRecord(context) && context.isError === true
      ? "toolErrorBg"
      : "toolSuccessBg";
  try {
    const sample = theme.bg(color, "");
    if (typeof sample !== "string") return undefined;
  } catch {
    // A theme that cannot supply the token leaves the rows unpainted rather
    // than breaking the host's render path.
    return undefined;
  }
  return (text) => theme.bg!(color, text);
}

/**
 * The card's own horizontal inset, taken from the host's `outputPad` render
 * context (the same value the native edit header and body use). Rows are
 * painted to the full width, so only the leading inset is added here.
 */
function annotationDisplayPadding(context: unknown): number {
  const pad = isRecord(context) ? context.outputPad : undefined;
  return typeof pad === "number" && Number.isInteger(pad) && pad > 0 ? pad : 0;
}

/**
 * Pads one rendered row to the full row width and paints the row background
 * over the whole line, including the gap rows, the way Pi's own `Box` does.
 * Width is measured with the host's cell-width helper, so theme escapes and
 * wide glyphs never count as padding.
 */
function paintAnnotationRow(row: string, width: number, background: (text: string) => string): string {
  const cells = visibleLineWidth(row);
  const filler = Math.max(0, width - (Number.isFinite(cells) ? cells : row.length));
  return background(`${row}${" ".repeat(filler)}`);
}

/**
 * Pi's collapsed fallback preview height for a tool without a result renderer
 * (`tool-execution.js createResultFallback`). Mirrored, not imported: the agent
 * package does not export the fallback, and the bound is part of the
 * presentation this decoration has to match.
 */
const NATIVE_FALLBACK_PREVIEW_LINES = 10;

/**
 * The display rows for an audited result whose tool declares no result
 * renderer (the extension-owned `YouShouldKnow` notice is the shipped case).
 * Without a renderer here the host's own fallback would paint the whole text
 * block — including the gate's status line — as ordinary tool output, so the
 * decoration supplies the same native conventions itself: sanitized text in the
 * tool-output colour, the collapsed ten-line preview with its omission hint, the
 * complete text when expanded, nothing for empty output, and Pi's image
 * indicator when inline images are turned off. Only the gate's own lines are
 * re-styled with their semantic tokens; every other row keeps the native
 * colour, and the model-visible result is never touched.
 */
function annotationFallbackRows(
  view: unknown,
  theme: AuditDisplayTheme | undefined,
  expanded: boolean,
  context: unknown,
  width: number,
  pad: number,
): string[] {
  if (!isRecord(view) || !Array.isArray(view.content)) return [];
  const indent = " ".repeat(pad);
  const style = (color: AuditDisplayColor | "toolOutput", line: string): string => {
    if (theme === undefined) return line;
    try {
      return theme.fg(color as AuditDisplayColor, line);
    } catch {
      return line;
    }
  };
  const textBlocks = view.content.filter((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
  // Image blocks the host will not draw are named inside the text output, the
  // way Pi's own text output does (capability and toggle both considered).
  const imageIndicators = annotationImageIndicators(view, context);
  const rows: string[] = [];
  const text = [
    // The same display encoding the gate rows use: control bytes stay visible
    // as inert notation instead of reaching the terminal, and tabs are widened
    // the way the host's own text component widens them.
    ...textBlocks.map((item) => visibleTerminalText((item as { text: string }).text).replace(/\t/g, "   ")),
    ...imageIndicators,
  ].join("\n");
  if (text.length > 0) {
    const lines = text.split("\n");
    const shown = expanded ? lines : lines.slice(0, NATIVE_FALLBACK_PREVIEW_LINES);
    for (const line of shown) {
      for (const chunk of wrapAtWordBoundaries(line, width)) rows.push(`${indent}${style("toolOutput", chunk)}`);
    }
    const omitted = lines.length - shown.length;
    if (omitted > 0) {
      // One matching parenthesis pair, and the complete styled row wrapped
      // through the host's own ANSI-aware wrapper: a long configured expansion
      // binding can never emit a row wider than the card, and no dangling
      // parenthesis is left when the hint is unavailable.
      const hint = theme === undefined
        ? undefined
        : expansionHint(false, (color, hintText) => theme.fg(color as AuditDisplayColor, hintText));
      const label = style("muted", `... (${omitted} more lines)`);
      const hintRow = hint === undefined ? label : `${label} ${hint}`;
      for (const chunk of wrapAnsiAwareRows(hintRow, width)) rows.push(`${indent}${chunk}`);
    }
  }
  return rows;
}

/**
 * The image blocks this fallback has to name. Pi's own text output adds one
 * indicator per image block when the terminal cannot draw images at all or
 * inline images are turned off, and the host then draws nothing for them. Both
 * conditions come from the running host, and the indicator text is the host's
 * own (with the dimensions it can decode). Without a resolvable host peer the
 * capability is genuinely unknown, so only the toggle the host hands us applies
 * and the mime type alone is named — an audited image is never dropped from the
 * human view silently.
 */
function annotationImageIndicators(view: unknown, context: unknown): string[] {
  if (!isRecord(view) || !Array.isArray(view.content)) return [];
  const content = view.content as unknown[];
  const blocks = content.filter((item) => isRecord(item) && item.type === "image");
  if (blocks.length === 0) return [];
  const showImages = !(isRecord(context) && context.showImages === false);
  const disclosure = nativeImageDisclosure();
  if (disclosure === undefined) {
    return showImages ? [] : blocks.map((item) => `[Image: [${annotationImageMimeType(item)}]]`);
  }
  if (disclosure.imagesSupported && showImages) return [];
  return blocks.map((item) => disclosure.indicator(
    annotationImageMimeType(item),
    isRecord(item) && typeof item.data === "string" ? item.data : undefined,
  ));
}

function annotationImageMimeType(item: unknown): string {
  return isRecord(item) && typeof item.mimeType === "string" ? item.mimeType : "image/unknown";
}

/**
 * Remove exactly the blocks this gate recorded for this call, each identified by
 * the text this gate itself handed the host rather than by any text that merely
 * starts like an audit prefix. A content block that does not carry one of those
 * exact blocks is returned untouched, so a tool's own output is never rewritten
 * or hidden because it resembles a gate line.
 */
function stripRecordedBlocks(
  result: unknown,
  blocks: readonly string[],
): { view: unknown; stripped: number } | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  let content = result.content as unknown[];
  let stripped = 0;
  for (const block of blocks) {
    if (block.length === 0) continue;
    for (let index = 0; index < content.length; index += 1) {
      const item = content[index];
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      const text = item.text;
      if (text !== block && !text.startsWith(`${block}\n`)) continue;
      const remainder = text === block ? "" : text.slice(block.length + 1);
      content = remainder.length === 0
        ? content.filter((_block, blockIndex) => blockIndex !== index)
        : content.map((blockItem, blockIndex) => (blockIndex === index
          ? { ...(blockItem as Record<string, unknown>), text: remainder }
          : blockItem));
      stripped += 1;
      break;
    }
  }
  if (stripped === 0) return { view: result, stripped: 0 };
  return { view: { ...result, content }, stripped };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.trim() || "unknown error";
  return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}…`;
}
