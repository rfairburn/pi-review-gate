import { createHash } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type {
  ActiveReviewerSelection,
  ExternalAgentConfig,
  ExternalAgentRoleConfig,
  ReviewGateConfig,
} from "../config";
import { resolvedExternalAgent } from "../config";
import type { ProtectionLevel } from "./config";
import { TOOL_PROTECTION_POLICY_VERSION } from "./policy";
import { isRecord } from "../record-guard";
import {
  reviewerEnv,
  runPromptProcess,
  type ProcessRunResult,
} from "../adapters/process";

/**
 * Decision-only auditor invocation for the pre-execution tool gate (#536).
 *
 * This module deliberately owns a narrow transport/lifecycle boundary: it
 * launches one configured auditor, sends it the code-generated prompt, and
 * returns the raw final decision text. It does not parse the decision, retry,
 * fall back, cache, launch a subtask, or consume the delegated-worker
 * scheduler. Deciding what a returned text means belongs to the gate's
 * decision parser, not here.
 *
 * Route capability is honest rather than aspirational:
 * - Pi: supported in-process through a coordinator-supplied model registry
 *   (`streamSimple` with no tools in the context). Without that registry the
 *   route fails closed before launch: the CLI cannot currently guarantee
 *   invocation-local retry disabling, so it is not used as a silent fallback.
 * - Claude CLI-backed: fail-closed capability error until invocation-local API
 *   retry disabling is proven. No SDK or child-process launch path is retained
 *   for this route.
 * - Codex CLI-backed: fail-closed capability error. Current source evidence
 *   has no proven supplied-context-only/no-tools launch contract.
 * - generic-cli / run-as-binary: trusted executable transport using a new
 *   versioned JSON stdin request. This is not an OS sandbox; the external
 *   implementation remains responsible for honouring the no-investigation
 *   contract.
 */

/** Exact protocol marker for the external binary decision transport. */
export const PROTECTION_AUDITOR_PROTOCOL = "pi-tool-protection-json-v1";

/**
 * Route-level instruction, followed by the caller's unchanged code-owned
 * auditor instructions. Quoted governing/proposal/evidence data stays user-role.
 */
const DECISION_ONLY_SYSTEM_PROMPT = [
  "You are an isolated decision-only tool-protection auditor.",
  "You have no tools and must not inspect the workspace, files, commands, sessions, or network.",
  "Decide only from the supplied context and return exactly the requested output with no added commentary.",
].join(" ");

export interface ProtectionAuditorRequest {
  selection: ActiveReviewerSelection;
  config: ReviewGateConfig;
  /** Code-generated decision prompt. It is the complete supplied context. */
  prompt: string;
  /**
   * Exact code-owned instruction-prefix length from buildProtectionContext.fixedChars.
   * Pi places that prefix in systemPrompt and the remainder in one user message,
   * letting native adapters own caching. Omitted means no supplied fixed prefix;
   * an unusable supplied length is refused before any provider dispatch and is
   * never resized. External transports still receive the complete canonical
   * prompt unchanged.
   */
  fixedInstructionChars?: number;
  /** Model-neutral structured context for the external binary transport. */
  input: unknown;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Optional live Pi model registry supplied by the coordinator, for an
   * in-process decision call through `streamSimple()`. Used only for a Pi
   * selection. When omitted, a Pi selection fails closed before launch because
   * the CLI cannot currently guarantee invocation-local retry disabling.
   */
  modelRegistry?: ProtectionAuditorPiModelRegistry;
  /**
   * Optional stable prompt-cache identity for this auditor profile (#590), as
   * produced by {@link protectionAuditorCacheKey}. On the in-process Pi route
   * the runner forwards it as the installed SDK's provider-neutral `sessionId`
   * stream option, which each provider maps to whatever session-scoped caching
   * it actually supports and otherwise ignores. It always accompanies the full
   * self-contained request context the runner already sends: a cache key never
   * carries previous responses, transcript material, or a previous verdict,
   * and it is not proof that any provider hit its cache. Its absence changes
   * nothing about the request's controls, the decision, or a refusal.
   */
  cacheKey?: string;
  /**
   * Optional retention sink (#536). When present the runner reports the exact
   * transport data this invocation produced. It is called after the decision
   * wait has already ended, so recording never extends the decision deadline,
   * and it receives data only: nothing it does changes the result.
   */
  observe?: ProtectionAuditorObserver;
}

export interface ProtectionAuditorResult {
  /** Raw final decision text, for the caller's decision parser. */
  output?: string;
  /** Launch/transport/route failure. Never a policy decision. */
  error?: string;
  durationMs: number;
  /** Present only when an owned process was launched. */
  settlement?: "confirmed" | "unconfirmed";
  /**
   * Positive evidence that this attempt ended on the auditor's own decision
   * deadline: the in-process wait's deadline won the race, or the owned-process
   * primitive reported its own timeout and was not aborted. It is never inferred
   * from error wording, and it is absent for a launch failure, an abort, an
   * unsupported route, malformed output, or a returned decision. The admission
   * seam uses it to tell a timed-out audit attempt apart from every other audit
   * failure; it changes nothing about the refusal, the record, or the reported
   * transport facts, which stay exactly as they were.
   */
  timedOut?: true;
}

interface ProtectionAuditorEnvelope {
  version: typeof PROTECTION_AUDITOR_PROTOCOL;
  prompt: string;
  input: unknown;
}

/**
 * The exact text written to the auditor's stdin. The envelope carries the
 * generated request text and the bounded host metadata only: the working
 * directory is set on the child process itself, and repeating it here would
 * transmit host text that the context budget never accounted for.
 */
export function serializeProtectionAuditorEnvelope(prompt: string, input: unknown): string {
  const envelope: ProtectionAuditorEnvelope = {
    version: PROTECTION_AUDITOR_PROTOCOL,
    prompt,
    // JSON has no undefined value; keep the field present for a stable wire shape.
    input: input === undefined ? null : input,
  };
  return JSON.stringify(envelope);
}

/** Structural subset of the installed Pi `Model`/`ModelRegistry` contract. */
export interface ProtectionAuditorPiModel {
  id: string;
  provider: string;
  /**
   * The stream API the live registry resolved for this model, when exposed. It is
   * host metadata only: this runner never selects a control from it.
   */
  api?: string;
}

/** User message shape accepted by the Pi `Context` request envelope. */
export interface ProtectionAuditorPiUserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

/** The complete in-process request context: no tools and no session history. */
export interface ProtectionAuditorPiContext {
  systemPrompt: string;
  messages: ProtectionAuditorPiUserMessage[];
}

/** Provider-neutral stream controls used by the decision call. */
export interface ProtectionAuditorPiStreamOptions {
  signal?: AbortSignal;
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  toolChoice?: "none";
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Session-scoped cache identity from {@link ProtectionAuditorRequest.cacheKey}.
   * The installed SDK's provider-neutral session option: a provider maps it to
   * the session-aware cache or routing signal it supports and ignores it
   * otherwise.
   */
  sessionId?: string;
  /**
   * Published SDK transport option, requested the same way for every in-process
   * Pi audit: `"sse"` asks for the full body to be posted per request instead of
   * a pooled connection or a continued previous response. It is not selected per
   * model, provider, resolved api, or cache identity, and whether a given API
   * supports it or translates it is the installed SDK's decision, never this
   * runner's.
   */
  transport?: "sse";
}

/** Namespaced tag so a policy revision or profile change rotates the identity. */
export const PROTECTION_AUDITOR_CACHE_KEY_TAG = "pi-tool-protection-auditor-cache-v1";

/**
 * Deterministic prompt-cache identity for one auditor profile (#590): the
 * versioned tag, the code-owned policy revision, the enabled level, the
 * configured Pi model selector, and a caller-supplied namespaced scope.
 *
 * It is a pure derivation with no cache, counter, persisted identity, or new
 * configuration: the same inputs always give the same 64-hex key, and the
 * scope text itself is hashed rather than transmitted. Callers must supply a
 * scope that is stable across the audits that are meant to share a provider
 * cache (an acting conversation, or one tester configuration), never an
 * invocation id or a per-audit record id.
 */
export function protectionAuditorCacheKey(
  scope: string,
  model: string,
  level: Exclude<ProtectionLevel, "off">,
): string {
  return createHash("sha256")
    .update(PROTECTION_AUDITOR_CACHE_KEY_TAG)
    .update("\0").update(TOOL_PROTECTION_POLICY_VERSION)
    .update("\0").update(level)
    .update("\0").update(model)
    .update("\0").update(scope)
    .digest("hex");
}

/**
 * Structural subset of Pi's `ModelRegistry`. The coordinator supplies this
 * live host object; it is not the review-gate configuration and this runner
 * never constructs or persists one.
 */
export interface ProtectionAuditorPiModelRegistry {
  find(provider: string, modelId: string): ProtectionAuditorPiModel | undefined;
  getAll(): readonly ProtectionAuditorPiModel[];
  streamSimple(
    model: ProtectionAuditorPiModel,
    context: ProtectionAuditorPiContext,
    options?: ProtectionAuditorPiStreamOptions,
  ): AsyncIterable<unknown>;
}

export interface ProtectionAuditorDependencies {
  /** Test/integration seam; production uses the shared process primitive. */
  runPromptProcess?: typeof runPromptProcess;
}

/**
 * Which transport one auditor invocation actually used. `route-refused` means
 * the invocation ended before any transport ran (invalid request, cancellation
 * before launch, an unresolvable model, an unsupported route, or a launch that
 * threw), so no request bytes and no reply exist to report.
 */
export type ProtectionAuditorTransport = "pi-in-process" | "external-binary" | "route-refused";

/**
 * What the runner actually put on one transport, reported back verbatim for
 * optional auditor-session retention (#536). Nothing here is parsed,
 * summarized, or repaired: the Pi fields are the exact in-process request
 * context and the terminal message the stream produced, and the external
 * fields are the exact stdin envelope, the captured stdout, and the host
 * process facts, including whether the host confirmed that the stdin write
 * actually reached the program's pipe. An external binary produced no Pi
 * provider call, so it reports no provider, api, model, usage, or stop reason —
 * those are absent rather than invented. Transport configuration (executable
 * path, arguments, environment) is never part of an observation: a launch
 * failure reports the syscall and the host error code only, because the caller
 * may retain what it is given.
 */
export interface ProtectionAuditorObservation {
  transport: ProtectionAuditorTransport;
  /** Why the invocation refused before any transport ran, when it did. */
  refusal?: string;
  /**
   * Structured, record-safe facts about a program that could not be started.
   * Node quotes the configured executable in spawn errors (`spawn /path/bin
   * ENOENT`), and transport configuration is never retained, so a launch
   * failure reports an honest category plus the host error code here, and the
   * record never receives the verbatim exception text. `syscall` is reduced to
   * the syscall name alone for the same reason.
   */
  launchFailure?: { syscall: string; code: string };
  pi?: {
    /**
     * The system text actually sent: the route-level instruction followed, when a
     * boundary was supplied, by the caller's unchanged code-owned instruction
     * prefix. Quoted governing instructions, evidence, and the proposed call are
     * never part of it.
     */
    systemPrompt: string;
    /**
     * The one user message actually sent: the generated prompt from the supplied
     * boundary onward, or the complete generated prompt when no boundary was
     * supplied. It is stored exactly, including the separator that attaches it to
     * the fixed blocks.
     */
    prompt: string;
    /** The effective reasoning request for this call. */
    thinkingLevel: string;
    /** The model the live registry resolved, as the request used it. */
    model: { provider: string; id: string };
    /**
     * The terminal `AssistantMessage` the stream produced, kept as-is. Absent
     * when the stream produced no terminal message (deadline, abort, or a
     * stream that ended without one).
     */
    assistant?: unknown;
  };
  external?: {
    /** Exact bytes written to the auditor's stdin. */
    requestText: string;
    /** Captured stdout exactly as captured (empty when there was none). */
    outputText: string;
    truncated: boolean;
    exitCode: number | null;
    timedOut: boolean;
    aborted: boolean;
    stdinError?: string;
    /**
     * Whether the host reported the stdin write flushing to the program's pipe
     * (the shared process primitive's own delivery seam). `false` means the
     * program may have read none or only part of `requestText` — an early exit,
     * an EPIPE, a timeout, or a cancellation before delivery — so a record must
     * describe the envelope as supplied, not as confirmed delivered.
     */
    deliveredToStdin: boolean;
    /**
     * What the host reported about process settlement. Absent means the
     * transport reported nothing, which the runner already treats as
     * unconfirmed; the record leaves it absent rather than inventing a claim.
     */
    settlement?: "confirmed" | "unconfirmed";
  };
}

/**
 * Optional retention sink. The runner calls it at most once per invocation
 * with what it observed, and a sink that throws is ignored: reporting the
 * transport can never change the auditor's result.
 */
export type ProtectionAuditorObserver = (observation: ProtectionAuditorObservation) => void;

/**
 * Run one decision-only auditor invocation. Every timeout, abort, nonzero
 * exit, missing output, malformed transport, unsupported route, or unknown
 * process settlement is returned as an error; nothing is retried or routed to
 * a different auditor.
 */
export async function runProtectionAuditor(
  request: ProtectionAuditorRequest,
  dependencies: ProtectionAuditorDependencies = {},
): Promise<ProtectionAuditorResult> {
  const startedAt = Date.now();
  const outcome = await routeProtectionAuditor(request, dependencies, startedAt);
  if (request.observe) {
    try {
      request.observe(outcome.observation);
    } catch {
      // A retention sink is an observer, never a decision input or a failure source.
    }
  }
  return outcome.result;
}

interface RouteOutcome {
  result: ProtectionAuditorResult;
  observation: ProtectionAuditorObservation;
}

/** The route itself: every return path also reports what its transport saw. */
async function routeProtectionAuditor(
  request: ProtectionAuditorRequest,
  dependencies: ProtectionAuditorDependencies,
  startedAt: number,
): Promise<RouteOutcome> {
  const invalid = validateRequest(request);
  if (invalid) return refused(failure(invalid, startedAt), invalid);
  if (request.signal?.aborted) {
    const error = "Auditor was aborted before launch.";
    return refused(failure(error, startedAt), error);
  }

  if (request.selection.source === "pi") {
    if (!request.modelRegistry) {
      const error = "Pi auditor route requires a coordinator-supplied model registry to guarantee a single-attempt, no-tool decision; no process was started.";
      return refused(failure(error, startedAt), error);
    }
    return await runPiInProcessDecision(request, request.modelRegistry, startedAt);
  }

  const agent = resolvedExternalAgent(request.config, request.selection.id);
  if (!agent) {
    const error = `Auditor external agent not found: ${request.selection.id}`;
    return refused(failure(error, startedAt), error);
  }
  // Execution role when present, otherwise review; shared agent-level fields
  // are inherited exactly as existing executor/reviewer resolution does.
  const role = agent.execution ?? agent.review;
  if (!role) {
    const error = `Auditor external agent has no usable role: ${request.selection.id}`;
    return refused(failure(error, startedAt), error);
  }

  switch (agent.adapter) {
    case "claude-cli":
      const claude = "Claude auditor route is unsupported: invocation-local API retry disabling has not been established. No process was started.";
      return refused(failure(claude, startedAt), claude);
    case "generic-cli":
    case "run-as-binary":
      return await runBinaryDecision(request, agent, role, dependencies, startedAt);
    case "codex-cli":
      const codex = "Codex auditor route is unsupported: the pinned Codex CLI has no proven supplied-context-only/no-tools launch contract. No process was started.";
      return refused(
        failure(codex, startedAt),
        codex,
      );
    default:
      const unsupported = `Unsupported auditor adapter: ${String((agent as { adapter?: unknown }).adapter)}`;
      return refused(failure(unsupported, startedAt), unsupported);
  }
}

/** A refusal that never reached a transport, reported honestly as such. */
function refused(
  result: ProtectionAuditorResult,
  refusal: string,
  launchFailure?: { syscall: string; code: string },
): RouteOutcome {
  return {
    result,
    observation: { transport: "route-refused", refusal, ...(launchFailure === undefined ? {} : { launchFailure }) },
  };
}

/**
 * The record-safe shape of a launch exception. Node reports a spawn failure as
 * `spawn /configured/executable ENOENT` with the path in `syscall` and `path`,
 * so both are reduced here: the syscall name and the error code are honest host
 * facts, the executable is configured transport detail that is never retained.
 */
function launchFailureFacts(error: unknown): { syscall: string; code: string } {
  const detail = error as { syscall?: unknown; code?: unknown } | undefined;
  const syscall = typeof detail?.syscall === "string" ? detail.syscall.split(/\s+/)[0] ?? "spawn" : "spawn";
  const code = typeof detail?.code === "string" && detail.code.length > 0 && !/\s/.test(detail.code)
    ? detail.code
    : "unknown";
  return { syscall: syscall.length > 0 ? syscall : "spawn", code };
}

function validateRequest(request: ProtectionAuditorRequest): string | undefined {
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    return "Auditor timeoutMs must be a positive safe integer.";
  }
  if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
    return "Auditor prompt must be a non-empty string.";
  }
  if (typeof request.cwd !== "string" || request.cwd.trim().length === 0) {
    return "Auditor cwd must be a non-empty string.";
  }
  if (!request.selection || (request.selection.source !== "pi" && request.selection.source !== "external")) {
    return "Auditor selection must be a pi or external reviewer selection.";
  }
  if (request.selection.source === "pi" && (typeof request.selection.model !== "string" || request.selection.model.trim().length === 0)) {
    return "Auditor pi selection requires a model.";
  }
  if (request.selection.source === "external" && (typeof request.selection.id !== "string" || request.selection.id.trim().length === 0)) {
    return "Auditor external selection requires an agent id.";
  }
  return undefined;
}

/**
 * In-process transport through the coordinator's live model registry. The
 * context contains only the route system instruction, the caller's unchanged
 * code-owned instruction prefix (up to the supplied boundary), and the remaining
 * generated prompt as one user message, so there are no tools or session/project
 * resources. The same shape is sent for every model and provider: the runner
 * never rewrites a provider payload or selects a control from a model name. The
 * deadline bounds this decision wait; aborting the provider request is
 * best-effort and is not process-teardown evidence, so this route reports no
 * process settlement.
 */
async function runPiInProcessDecision(
  request: ProtectionAuditorRequest,
  registry: ProtectionAuditorPiModelRegistry,
  startedAt: number,
): Promise<RouteOutcome> {
  if (request.selection.source !== "pi") throw new Error("unreachable");
  const selection = request.selection;
  // Existing Pi reviewer resolution defaults an absent selection level to high.
  const thinkingLevel = selection.thinkingLevel ?? "high";
  const resolved = resolvePiModel(registry, selection.model);
  if ("error" in resolved) return refused(failure(resolved.error, startedAt), resolved.error);

  // The boundary is host-supplied, so an unusable one is refused here, before
  // any provider dispatch: only an absent boundary means "no supplied fixed
  // text", and a boundary at or past the end of the prompt is refused rather
  // than resized, because that would move quoted data into the system role.
  const suppliedBoundary = request.fixedInstructionChars;
  if (suppliedBoundary !== undefined
    && (!Number.isInteger(suppliedBoundary) || suppliedBoundary < 0 || suppliedBoundary >= request.prompt.length)) {
    const message = "Pi auditor received an invalid fixed-instruction boundary.";
    return refused(failure(message, startedAt), message);
  }
  const fixedInstructionChars = suppliedBoundary ?? 0;

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) controller.abort();

  const context = {
    // One native system/user shape for every model. Only the code-owned fixed
    // prefix is system-role; all quoted governing instructions, evidence and
    // proposal data remain user-role. No tools, transcript or session history.
    systemPrompt: [DECISION_ONLY_SYSTEM_PROMPT, request.prompt.slice(0, fixedInstructionChars)].filter(Boolean).join("\n\n"),
    messages: [{ role: "user" as const, content: request.prompt.slice(fixedInstructionChars), timestamp: Date.now() }],
  };
  // A cache identity is provider-neutral: `sessionId` is the installed SDK's
  // session option, which providers map to their own supported cache/routing
  // signal and ignore otherwise. It is only ever sent with the self-contained
  // context above, so it can never select a previous response, transcript, or
  // verdict. Its presence or absence never changes the other controls: every
  // audit asks for the SDK's per-request streaming transport and no retries, and
  // no raw payload, header, retention/TTL flag, or provider-specific option is
  // supplied for any model.
  const cacheKey = typeof request.cacheKey === "string" && request.cacheKey.length > 0
    ? request.cacheKey
    : undefined;
  let stream: AsyncIterable<unknown>;
  try {
    stream = registry.streamSimple(resolved.model, context, {
      signal: controller.signal,
      toolChoice: "none",
      // No runner-orchestrated or provider-SDK client retry attempts.
      maxRetries: 0,
      timeoutMs: request.timeoutMs,
      // One transport safeguard for the common native request shape, applied to
      // every audit regardless of model, provider, resolved api, or cache
      // identity: the published SDK option asks for the full body to be posted
      // per request instead of a pooled or continuing connection, and the SDK
      // decides what a given API supports. This runner never inspects the
      // resolved model to choose a transport.
      transport: "sse",
      ...(thinkingLevel !== "off"
        ? { reasoning: thinkingLevel }
        : {}),
      ...(cacheKey === undefined ? {} : { sessionId: cacheKey }),
    });
  } catch (error) {
    request.signal?.removeEventListener("abort", onAbort);
    // A launch that threw can carry an upstream HTTP failure inside its message
    // (#623), so only an evidenced HTTP failure is reduced here. Any other
    // launch diagnostic keeps the wording the host registry reported.
    const detail = piTransportLine("in-process launch failed", error, errorMessage(error));
    return refused(failure(detail, startedAt), detail);
  }

  // Every path below already reached the host's dispatch, so the record can
  // truthfully carry the exact request context and, when the stream produced
  // one, the terminal message. `assistant` is passed through untouched: a
  // provider error message is recorded as the error message it is.
  const observed = (result: ProtectionAuditorResult, assistant?: unknown): RouteOutcome => ({
    result,
    observation: {
      transport: "pi-in-process",
      pi: {
        systemPrompt: context.systemPrompt,
        prompt: context.messages[0]!.content,
        thinkingLevel,
        model: { provider: resolved.model.provider, id: resolved.model.id },
        ...(assistant === undefined ? {} : { assistant }),
      },
    },
  });

  const consumption = consumePiDecisionStream(stream);
  // The deadline may win the race below; keep rejection ownership without a
  // retry, fallback launch, or claim that the provider stopped.
  void consumption.catch(() => undefined);
  const outcome = await awaitBounded(consumption, request.timeoutMs, request.signal);
  request.signal?.removeEventListener("abort", onAbort);

  // A deadline or abort that wins the race has no terminal message to report;
  // the record says so instead of inventing one.
  if (outcome.kind === "aborted") return observed(failure("Auditor was aborted.", startedAt));
  if (outcome.kind === "timeout") {
    controller.abort();
    return observed(timeoutFailure(`Auditor timed out after ${request.timeoutMs}ms.`, startedAt));
  }
  if (outcome.kind === "error") {
    controller.abort();
    // Same boundary as the provider error event: an evidenced HTTP failure
    // never forwards the thrown value's text; everything else keeps it.
    return observed(
      failure(piTransportLine("in-process decision failed", outcome.error, errorMessage(outcome.error)), startedAt),
    );
  }
  if (outcome.value.error) return observed(failure(outcome.value.error, startedAt), outcome.value.message);
  if (outcome.value.toolCall || messageHasToolCall(outcome.value.message)) {
    return observed(
      failure("Pi auditor attempted a tool call despite receiving no tools; the decision was discarded.", startedAt),
      outcome.value.message,
    );
  }
  if (!outcome.value.message) return observed(failure("Pi auditor produced no terminal result.", startedAt));
  const stopReason = assistantStopReason(outcome.value.message);
  if (stopReason !== undefined && stopReason !== "stop") {
    if (stopReason === "length") {
      return observed(failure("Pi auditor output was truncated by the model token limit.", startedAt), outcome.value.message);
    }
    if (stopReason === "toolUse") {
      return observed(
        failure("Pi auditor attempted a tool call despite receiving no tools; the decision was discarded.", startedAt),
        outcome.value.message,
      );
    }
    if (stopReason === "aborted") return observed(failure("Auditor was aborted.", startedAt), outcome.value.message);
    return observed(
      failure(`Pi auditor finished without a complete decision (${stopReason}).`, startedAt),
      outcome.value.message,
    );
  }
  const text = assistantText(outcome.value.message);
  if (text.length === 0) return observed(failure("Auditor produced no output.", startedAt), outcome.value.message);
  if (request.signal?.aborted) return observed(failure("Auditor was aborted.", startedAt), outcome.value.message);
  // In-process decision calls have no owned child process, so there is no
  // process-settlement claim to report.
  return observed({ output: text, durationMs: Date.now() - startedAt }, outcome.value.message);
}

type PiModelResolution =
  | { model: ProtectionAuditorPiModel }
  | { error: string };

/**
 * Resolve the selected model without fuzzy matching, auth-based preference, or
 * provider fallback. An explicit provider/model selector is authoritative and
 * is resolved before any bare-id match, so a different provider's model whose
 * id happens to contain the slash cannot be selected. Ambiguous unqualified
 * ids fail explicitly so the coordinator can name the provider.
 */
function resolvePiModel(registry: ProtectionAuditorPiModelRegistry, selected: string): PiModelResolution {
  let all: readonly ProtectionAuditorPiModel[];
  try {
    all = registry.getAll();
  } catch (error) {
    return { error: piTransportLine("model registry is unavailable", error, errorMessage(error)) };
  }

  const separator = selected.indexOf("/");
  const hasQualifier = separator > 0 && separator < selected.length - 1;
  const provider = hasQualifier ? selected.slice(0, separator) : undefined;
  const modelId = hasQualifier ? selected.slice(separator + 1) : undefined;
  const providerIsKnown = provider !== undefined && all.some((model) => model.provider === provider);

  // An explicit provider/model is authoritative. Once a known provider
  // qualifies the selector, require that exact pair; never fall through to a
  // slash-bearing bare id that names a different model.
  if (provider !== undefined && modelId !== undefined && providerIsKnown) {
    try {
      const found = registry.find(provider, modelId);
      if (found) return { model: found };
    } catch (error) {
      return { error: piTransportLine("model registry lookup failed", error, errorMessage(error)) };
    }
    return {
      error: `Pi auditor model was not found for explicit provider/model: ${selected}. No other model was chosen.`,
    };
  }

  const exact = all.filter((model) => model.id === selected);
  if (exact.length === 1) {
    const match = exact[0]!;
    // A slash-bearing id whose owner is a different provider must not satisfy
    // an explicit provider/model request.
    if (provider !== undefined && match.provider !== provider) {
      return {
        error: `Pi auditor model was not found for explicit provider/model: ${selected}. No other model was chosen.`,
      };
    }
    return { model: match };
  }
  if (exact.length > 1) {
    return { error: `Pi auditor model is ambiguous in the supplied registry: ${selected}. Select an exact model or provider/model.` };
  }

  if (provider !== undefined && modelId !== undefined) {
    try {
      const found = registry.find(provider, modelId);
      if (found) return { model: found };
    } catch (error) {
      return { error: piTransportLine("model registry lookup failed", error, errorMessage(error)) };
    }
  }
  return { error: `Pi auditor model was not found in the supplied registry: ${selected}.` };
}

interface PiDecisionConsumption {
  message?: unknown;
  /**
   * Model-facing failure text for a terminal provider error event. The terminal
   * message itself is reported to the retention sink separately and untouched.
   */
  error?: string;
  toolCall: boolean;
}

async function consumePiDecisionStream(stream: AsyncIterable<unknown>): Promise<PiDecisionConsumption> {
  let toolCall = false;
  for await (const event of stream) {
    if (!isRecord(event)) continue;
    const type = typeof event.type === "string" ? event.type : "";
    if (type.startsWith("toolcall")) toolCall = true;
    if (type === "done") return { message: event.message, toolCall };
    if (type === "error") {
      // The terminal message goes to the retention sink untouched, so a private
      // record keeps whatever detail the transport actually exposed. Only the
      // model-facing text is reduced, and only for an evidenced HTTP failure
      // (#623): any other provider diagnostic keeps its own wording.
      if (nativeAbortReason(event)) {
        // The installed SDK marks an aborted stream with `reason: "aborted"`,
        // and its terminal message carries the same value in `stopReason`. That
        // host metadata — never an upstream word — is what classifies a
        // cancellation, and it is the same host line every other confirmed
        // cancellation of this audit uses.
        return { message: event.error, toolCall, error: "Auditor was aborted." };
      }
      const http = readHttpTransportFailure(event.error);
      return {
        message: event.error,
        toolCall,
        error: http === undefined
          ? piStreamErrorMessage(event.error)
          : httpFailureLine("provider request failed", http.status),
      };
    }
  }
  return { toolCall };
}

/**
 * Whether one native terminal event says this request was cancelled.
 *
 * Evidence (Pi 1.5.0, `@earendil-works/pi-ai`): `api/pi-messages.js`
 * `createErrorEvent()` sets `reason: "aborted"` together with the terminal
 * message's `stopReason: "aborted"`, and the Anthropic route reaches the same
 * shape from its own `APIUserAbortError`. Only those two explicit fields are
 * read; a message that merely mentions an abort, or an opaque word such as
 * `terminated`, proves nothing and stays an ordinary diagnostic.
 */
function nativeAbortReason(event: Record<string, unknown>): boolean {
  if (event.reason === "aborted") return true;
  // A host-supplied registry may omit the event reason; the terminal message's
  // own `stopReason` carries the same value.
  return event.reason === undefined && assistantStopReason(event.error) === "aborted";
}

function piStreamErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.errorMessage === "string" && value.errorMessage.trim().length > 0) {
    return value.errorMessage.trim();
  }
  return "Pi auditor provider ended with an error.";
}

/**
 * An evidenced provider HTTP failure. `status` is present only when the
 * transport reported one as a number.
 */
interface HttpTransportFailure {
  status?: number;
}

/**
 * Decide whether one provider failure came from a failed HTTP response, and take
 * its status when the transport reported one (#623). Each accepted shape below is
 * read from the installed runtime (Pi 1.5.0, `@earendil-works/pi-ai` and the SDKs
 * it pins); nothing is guessed.
 *
 * - A thrown SDK error carries a structured status: `statusCode` (Mistral),
 *   `status` (`openai`, `@google/genai`), `$metadata.httpStatusCode`, or
 *   `$response.statusCode` (Bedrock) — the fields `utils/error-body.js` probes.
 * - `api/pi-messages.js` and `api/bedrock-converse-stream.js` attach a
 *   `*_response_failure` diagnostic whose `details.status` is the numeric response
 *   status. Only that diagnostic counts: the SDK's other diagnostics
 *   (`provider_transport_failure`, `anthropic_input_transformations`, …) describe
 *   a fallback or a transformation, not a failed response, and must never silence
 *   a useful diagnostic.
 * - The failed body also reaches the message text in the shape the producing route
 *   composes it — `${status} ${statusText}: ${body}` (`pi-messages`),
 *   `${status}: ${body}` or `${prefix} (${status}): ${body}` (`error-body.js`),
 *   `${status} ${msg}` and its provider-prefixed wrapper (the native SDK composed
 *   message, see `nativeApiFailure`), or the `@google/genai`
 *   `{error:{message,code,status}}` envelope. Each anchored shape is read only where
 *   it is produced — a reason phrase must match Node's own HTTP registry
 *   (punctuation ignored, since the registry and the wire differ on hyphens) and a
 *   route tag must name the route that composes it — and only its status is taken.
 *
 * Deliberately not inferred: no number is read out of the middle of a message
 * (`429 requests queued: …` on a route that composes no status line stays the
 * diagnostic it is), an absent status is never guessed, and no upstream word is
 * read as a cause. The acknowledged limit is a bare-prose body on a route that
 * composes no status and attaches no failure diagnostic: it is indistinguishable
 * from a provider diagnostic and is forwarded, which is the trade that keeps
 * ordinary diagnostics intact. `undefined` means "not evidenced as an HTTP
 * failure", which leaves the caller's existing diagnostic exactly as useful as
 * it was.
 */
function readHttpTransportFailure(source: unknown): HttpTransportFailure | undefined {
  if (!isRecord(source)) return undefined;
  const status = structuredHttpStatus(source);
  if (status !== undefined) return { status };
  if (Array.isArray(source.diagnostics)) {
    for (const entry of source.diagnostics) {
      if (!isRecord(entry) || typeof entry.type !== "string" || !RESPONSE_FAILURE_DIAGNOSTIC.test(entry.type)) continue;
      const details = entry.details;
      // The diagnostic proves the failed response; its status is read for that
      // one number only. Its other fields carry a request URL and body text,
      // which are never read here.
      return { status: isRecord(details) ? structuredHttpStatus(details) : undefined };
    }
  }
  const text = nonEmptyText(source.errorMessage) ?? nonEmptyText(source.message);
  if (text === undefined) return undefined;
  const envelope = googleHttpErrorEnvelope(source.api, text);
  if (envelope !== undefined) return envelope;
  const native = nativeApiFailure(source.api, source.provider, text);
  if (native !== undefined) return native;
  const composed = composedHttpFailure(text);
  if (composed !== undefined) return composed;
  // An HTML document inside the text is a gateway's error page: an HTTP
  // response body even when no status survived alongside it.
  return HTML_ERROR_PAGE.test(text) ? {} : undefined;
}

/**
 * The `@google/genai` HTTP error envelope, honoured only on the two terminal
 * messages that route produces.
 *
 * Evidence (installed `@google/genai` 2.21.0, `throwErrorIfNotOK()`): for any
 * non-2xx response the SDK serializes `{error:{message,code,status}}` — taking
 * `code` from `response.status` and `status` from `response.statusText` when the
 * body is not JSON — and throws it as `ApiError.message`. pi-ai's
 * `api/google-generative-ai.js` and `api/google-vertex.js` then set
 * `errorMessage = formatProviderError(normalizeProviderError(error))`, which
 * returns that JSON text unchanged because the SDK error carries no body field,
 * so the outer numeric status is dropped and the envelope is all that remains.
 * The `api` tag is what makes this narrow: the same JSON text on any other
 * route, or an incomplete envelope, stays the diagnostic it is.
 */
const GOOGLE_HTTP_API_IDS = new Set(["google-generative-ai", "google-vertex"]);

function googleHttpErrorEnvelope(api: unknown, text: string): HttpTransportFailure | undefined {
  if (typeof api !== "string" || !GOOGLE_HTTP_API_IDS.has(api)) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Not the SDK's serialized envelope: ordinary wording continues unchanged.
    return undefined;
  }
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const code = body.error.code;
  if (!isHttpStatusCode(code) || code < 400) return undefined;
  if (typeof body.error.status !== "string" || typeof body.error.message !== "string") return undefined;
  return { status: code };
}

/** `api/pi-messages.js` and `api/bedrock-converse-stream.js` failure diagnostics. */
const RESPONSE_FAILURE_DIAGNOSTIC = /^[a-z0-9_]*response_failure$/;

/** An nginx-style gateway error page, as `pi-messages` embeds a raw body. */
const HTML_ERROR_PAGE = /<(!doctype\s+)?html[\s>/]|<\/html\s*>/i;

/**
 * `api/pi-messages.js`: `${status} ${statusText}: ${body}`. The phrase is only
 * accepted when it is Node's own reason phrase for that status, so a provider
 * sentence that happens to open with a number and a colon is not read as a
 * gateway status line.
 */
const GATEWAY_STATUS_LINE = /^(\d{3}) ([^:\r\n]{1,48}):(?=\s)/;

/**
 * `utils/error-body.js`: `${status}: ${body}`, or with its optional provider
 * prefix `${prefix} (${status}): ${body}`.
 */
const NORMALIZED_STATUS_LINE = /^(?:([A-Za-z][A-Za-z .+-]{0,47}) \((\d{3})\)|(\d{3})):(?=\s)/;

/**
 * A JSON response body folded in right after a leading status, which `pi-messages`
 * keeps raw and `APIError.makeMessage()` stringifies. The document marker proves
 * the fold on any route; prose there is not evidence.
 */
const FOLDED_RESPONSE_BODY = /^(\d{3}) (?=[<{\[])/;

/**
 * The routes whose terminal `errorMessage` copies the native SDK composed message:
 * `api/anthropic-messages.js` assigns `error.message` verbatim, and the OpenAI
 * routes keep it through `formatProviderError()` — unchanged where they pass no
 * prefix (`openai-completions`), or wrapped as `<prefix> (${status}): …` where they
 * do (`openai-responses`, `azure-openai-responses`). `openai-codex-responses`
 * composes its own wording and is deliberately absent.
 */
const NATIVE_API_ERROR_API_IDS = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
]);

/**
 * The leading status of `@anthropic-ai/sdk` 0.129.0 and `openai` 7.19.0
 * `APIError.makeMessage()`: `${status} ${msg}`, where `msg` is a non-JSON
 * response body copied verbatim — arbitrary plain text with no document marker.
 * The number is the failed response's own status (`makeStatusError()` is reached
 * only for a `!response.ok` response), so it is reliable and the text after it is
 * never read. A failed response reports 400 or above, so a lower number sitting at
 * the start of prose is not evidence of one.
 */
const NATIVE_STATUS_LINE = /^(\d{3}) /;

/**
 * `api/openai-responses.js` prefixes its message with
 * `${provider === "openai" ? "OpenAI" : provider} API error`, and
 * `formatProviderError()` applies that prefix even when the SDK message already
 * carries the body — `proxy2 API error (504): 504 <raw body>` — so a provider tag
 * with a digit or an underscore, or longer than `NORMALIZED_STATUS_LINE` allows,
 * is not read there. The prefix is rebuilt from the terminal message's own
 * `provider` tag; no provider-name pattern is guessed. Azure's constant prefix is
 * already accepted by `NORMALIZED_STATUS_LINE`.
 */
function openaiResponsesErrorPrefix(api: unknown, provider: unknown): string | undefined {
  if (api !== "openai-responses") return undefined;
  if (typeof provider !== "string" || provider.length === 0) return undefined;
  return `${provider === "openai" ? "OpenAI" : provider} API error`;
}

/** The `(<status>):` the route composes right after its provider prefix. */
const NATIVE_WRAPPED_STATUS = /^\((\d{3})\):(?=\s)/;

/**
 * The native SDK composed message on the routes proven to copy it, in both forms
 * they produce: `${status} ${msg}`, and — where the route supplies a provider
 * prefix — `<provider prefix> (${status}): …`, whose number is pi-ai's own
 * composition of the SDK's structured status field. Only the status is read.
 */
function nativeApiFailure(api: unknown, provider: unknown, text: string): HttpTransportFailure | undefined {
  if (typeof api !== "string" || !NATIVE_API_ERROR_API_IDS.has(api)) return undefined;
  const prefix = openaiResponsesErrorPrefix(api, provider);
  if (prefix !== undefined && text.startsWith(`${prefix} `)) {
    const wrapped = NATIVE_WRAPPED_STATUS.exec(text.slice(prefix.length + 1));
    if (wrapped !== null && isHttpStatusCode(Number(wrapped[1]))) return { status: Number(wrapped[1]) };
  }
  const bare = NATIVE_STATUS_LINE.exec(text);
  const status = bare === null ? undefined : Number(bare[1]);
  if (status !== undefined && isHttpStatusCode(status) && status >= 400) return { status };
  return undefined;
}

/** One of the SDK-composed status lines, or nothing. */
function composedHttpFailure(text: string): HttpTransportFailure | undefined {
  const gateway = GATEWAY_STATUS_LINE.exec(text);
  if (gateway !== null) {
    const status = Number(gateway[1]);
    if (isHttpStatusCode(status) && isKnownReasonPhrase(status, gateway[2] ?? "")) return { status };
  }
  const normalized = NORMALIZED_STATUS_LINE.exec(text);
  if (normalized !== null) {
    const status = Number(normalized[2] ?? normalized[3]);
    if (isHttpStatusCode(status)) return { status };
  }
  const folded = FOLDED_RESPONSE_BODY.exec(text);
  if (folded !== null) {
    const status = Number(folded[1]);
    if (isHttpStatusCode(status)) return { status };
  }
  return undefined;
}

/**
 * Node's own HTTP reason phrases, which is what a real status line carries.
 * Compared with punctuation ignored, because the registry and the wire differ
 * on trivia: Node reports `"Gateway Timeout"` where HTTP/1.1 and nginx emit
 * `"Gateway Time-out"`. This still rejects a provider sentence that merely
 * follows a number.
 */
function isKnownReasonPhrase(status: number, phrase: string): boolean {
  const expected = (STATUS_CODES as Record<number, string | undefined>)[status];
  if (expected === undefined) return false;
  const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalize(expected) === normalize(phrase);
}

/** The SDK's own status fields, in the order `utils/error-body.js` probes them. */
function structuredHttpStatus(source: Record<string, unknown>): number | undefined {
  const candidates: unknown[] = [source.statusCode, source.status];
  const metadata = source.$metadata;
  if (isRecord(metadata)) candidates.push(metadata.httpStatusCode);
  const response = source.$response;
  if (isRecord(response)) candidates.push(response.statusCode);
  for (const candidate of candidates) {
    if (isHttpStatusCode(candidate)) return candidate;
  }
  return undefined;
}

function isHttpStatusCode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** The compact host-authored phrase for one evidenced provider HTTP failure. */
function httpFailurePhrase(status: number | undefined): string {
  return status === undefined
    ? "the provider returned an error response but reported no HTTP status"
    : `HTTP ${status}`;
}

function httpFailureLine(stage: string, status: number | undefined): string {
  return `Pi auditor ${stage} (${httpFailurePhrase(status)}).`;
}

/**
 * One model-facing line for a Pi transport problem. An evidenced provider HTTP
 * failure becomes the compact host summary — the upstream error message,
 * response body and headers never appear, in whole or in part, because that
 * payload would otherwise land in the acting model's context, in a nested
 * refusal, and in the next audit's evidence. Every other failure keeps the
 * caller's own detail text, so an ordinary provider, registry, or launch
 * diagnostic stays exactly as useful as it was.
 */
function piTransportLine(stage: string, error: unknown, detail: string): string {
  const http = readHttpTransportFailure(error);
  return http === undefined ? `Pi auditor ${stage}: ${detail}` : httpFailureLine(stage, http.status);
}

/**
 * The same single rule for a model-facing catch outside this module (#623): the
 * replacement phrase for an evidenced provider HTTP failure, or `undefined` when
 * the value is not evidenced as one and keeps its own message.
 */
export function httpFailureSummary(error: unknown): string | undefined {
  const http = readHttpTransportFailure(error);
  return http === undefined ? undefined : httpFailurePhrase(http.status);
}

function assistantText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const item of message.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("").trim();
}

function messageHasToolCall(message: unknown): boolean {
  if (!isRecord(message) || !Array.isArray(message.content)) return false;
  return message.content.some((item) => isRecord(item) && item.type === "toolCall");
}

function assistantStopReason(message: unknown): string | undefined {
  if (!isRecord(message) || typeof message.stopReason !== "string") return undefined;
  return message.stopReason;
}

type BoundedDecisionOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" };

/** Bound the wait for an in-process stream; this is a decision deadline, not proof provider work stopped. */
function awaitBounded<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<BoundedDecisionOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: BoundedDecisionOutcome<T>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: "aborted" });
    if (signal?.aborted) {
      finish({ kind: "aborted" });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    work.then(
      (value) => finish({ kind: "value", value }),
      (error: unknown) => finish({ kind: "error", error }),
    );
  });
}

async function runBinaryDecision(
  request: ProtectionAuditorRequest,
  agent: ExternalAgentConfig,
  role: ExternalAgentRoleConfig,
  dependencies: ProtectionAuditorDependencies,
  startedAt: number,
): Promise<RouteOutcome> {
  const merged = mergedRole(agent, role);
  return await runProcessDecision({
    command: agent.command ?? "",
    args: merged.args,
    cwd: request.cwd,
    prompt: serializeProtectionAuditorEnvelope(request.prompt, request.input),
    timeoutMs: request.timeoutMs,
    env: reviewerEnv({
      ...process.env,
      ...merged.env,
      PI_REVIEW_AGENT_PROTOCOL: PROTECTION_AUDITOR_PROTOCOL,
    }),
    signal: request.signal,
  }, dependencies, startedAt);
}

interface ProcessDecisionInput {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

async function runProcessDecision(
  input: ProcessDecisionInput,
  dependencies: ProtectionAuditorDependencies,
  startedAt: number,
): Promise<RouteOutcome> {
  if (!input.command) {
    const error = "Auditor external agent has no command.";
    return refused(failure(error, startedAt), error);
  }
  // The shared primitive reports delivery only when the stdin write actually
  // flushed, so an early exit, an EPIPE, a timeout, or a cancellation before
  // delivery leaves this false instead of claiming bytes arrived.
  let deliveredToStdin = false;
  let output: ProcessRunResult;
  try {
    output = await (dependencies.runPromptProcess ?? runPromptProcess)({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      env: input.env,
      signal: input.signal,
      onPromptDelivery: () => { deliveredToStdin = true; },
    });
  } catch (error) {
    // The user keeps the full launch diagnostic, which is the only place the
    // configured executable appears. The retained refusal and the structured
    // facts carry the honest category and the host error code instead, because
    // an opted-in record retains what it is given.
    const launch = launchFailureFacts(error);
    return refused(
      failure(`Auditor launch failed: ${errorMessage(error)}`, startedAt),
      `Auditor launch failed: the configured auditor program could not be started (${launch.syscall} ${launch.code}). Its command, arguments, and environment are not reported.`,
      { syscall: launch.syscall, code: launch.code },
    );
  }
  const settlement = output.processSettlement;
  // The process ran, so the record carries the exact bytes of both directions
  // plus the host facts. This is external-binary I/O: no provider, api, model,
  // usage, or stop reason exists for it and none is implied.
  const observed = (result: ProtectionAuditorResult): RouteOutcome => ({
    result,
    observation: {
      transport: "external-binary",
      external: {
        requestText: input.prompt,
        outputText: output.stdout,
        truncated: output.stdoutTruncated,
        exitCode: output.code,
        timedOut: output.timedOut,
        aborted: output.aborted,
        deliveredToStdin,
        ...(output.stdinError === undefined ? {} : { stdinError: output.stdinError }),
        ...(settlement === undefined ? {} : { settlement }),
      },
    },
  });
  const problems: string[] = [];
  if (output.aborted) problems.push("Auditor was aborted.");
  if (output.timedOut) problems.push(`Auditor timed out after ${input.timeoutMs}ms.`);
  if (output.stdinError) problems.push("Auditor could not receive its request.");
  if (output.stdoutTruncated) problems.push("Auditor output was truncated; the decision was discarded.");
  if (output.code !== 0) problems.push(`Auditor exited with status ${String(output.code)}.`);
  if (settlement !== "confirmed") problems.push("Auditor process settlement is unconfirmed.");
  const text = output.stdout.trim();
  if (text.length === 0) problems.push("Auditor produced no output.");
  if (problems.length > 0) {
    // The primitive's own deadline firing is the timeout evidence. An abort is a
    // separate, uncertain end (the caller cancelled), so a run that was aborted —
    // even one that also passed its deadline — reports no confirmed timeout.
    const confirmedTimeout = output.timedOut && !output.aborted;
    return observed({
      error: problems.join(" "),
      durationMs: Date.now() - startedAt,
      settlement,
      ...(confirmedTimeout ? { timedOut: true as const } : {}),
    });
  }
  if (input.signal?.aborted) {
    return observed({ error: "Auditor was aborted.", durationMs: Date.now() - startedAt, settlement });
  }
  return observed({ output: text, durationMs: Date.now() - startedAt, settlement });
}

/** Merge shared agent settings with the selected role, for binary transport. */
function mergedRole(agent: ExternalAgentConfig, role: ExternalAgentRoleConfig): {
  args: string[];
  env: Record<string, string>;
} {
  return {
    args: [...(agent.args ?? []), ...(role.args ?? [])],
    env: { ...(agent.env ?? {}), ...(role.env ?? {}) },
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim();
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 2_000)}…`;
}

function failure(error: string, startedAt: number, settlement?: "confirmed" | "unconfirmed"): ProtectionAuditorResult {
  return {
    error,
    durationMs: Date.now() - startedAt,
    ...(settlement ? { settlement } : {}),
  };
}

/** A failure the transport itself ended on its decision deadline. */
function timeoutFailure(error: string, startedAt: number, settlement?: "confirmed" | "unconfirmed"): ProtectionAuditorResult {
  return { ...failure(error, startedAt, settlement), timedOut: true };
}
