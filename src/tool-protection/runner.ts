import type {
  ActiveReviewerSelection,
  ExternalAgentConfig,
  ExternalAgentRoleConfig,
  ReviewGateConfig,
} from "../config";
import { resolvedExternalAgent } from "../config";
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
 * Route-level system instruction only. The decision instructions and all
 * governing/proposal/evidence context belong to the caller-generated prompt.
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
}

interface ProtectionAuditorEnvelope {
  version: typeof PROTECTION_AUDITOR_PROTOCOL;
  prompt: string;
  input: unknown;
  cwd: string;
}

/** Structural subset of the installed Pi `Model`/`ModelRegistry` contract. */
export interface ProtectionAuditorPiModel {
  id: string;
  provider: string;
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
    /** The route-level system instruction actually sent. */
    systemPrompt: string;
    /** The one user message actually sent — the complete generated prompt. */
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
 * context contains only the route system instruction and generated prompt, so
 * there are no tools or session/project resources. The deadline bounds this
 * decision wait; aborting the provider request is best-effort and is not
 * process-teardown evidence, so this route reports no process settlement.
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

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) controller.abort();

  const context = {
    // Complete supplied context: one route-level system instruction and the
    // code-generated prompt. No tools, transcript, project resources, or
    // session history are part of this request.
    systemPrompt: DECISION_ONLY_SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: request.prompt, timestamp: Date.now() }],
  };
  let stream: AsyncIterable<unknown>;
  try {
    stream = registry.streamSimple(resolved.model, context, {
      signal: controller.signal,
      toolChoice: "none",
      // No runner-orchestrated or provider-SDK client retry attempts.
      maxRetries: 0,
      timeoutMs: request.timeoutMs,
      ...(thinkingLevel !== "off"
        ? { reasoning: thinkingLevel }
        : {}),
    });
  } catch (error) {
    request.signal?.removeEventListener("abort", onAbort);
    return refused(
      failure(`Pi auditor in-process launch failed: ${errorMessage(error)}`, startedAt),
      `Pi auditor in-process launch failed: ${errorMessage(error)}`,
    );
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
        prompt: request.prompt,
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
    return observed(failure(`Auditor timed out after ${request.timeoutMs}ms.`, startedAt));
  }
  if (outcome.kind === "error") {
    controller.abort();
    return observed(failure(`Pi auditor in-process decision failed: ${errorMessage(outcome.error)}`, startedAt));
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
    return { error: `Pi auditor model registry is unavailable: ${errorMessage(error)}` };
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
      return { error: `Pi auditor model registry lookup failed: ${errorMessage(error)}` };
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
      return { error: `Pi auditor model registry lookup failed: ${errorMessage(error)}` };
    }
  }
  return { error: `Pi auditor model was not found in the supplied registry: ${selected}.` };
}

interface PiDecisionConsumption {
  message?: unknown;
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
      return { message: event.error, toolCall, error: piStreamErrorMessage(event.error) };
    }
  }
  return { toolCall };
}

function piStreamErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.errorMessage === "string" && value.errorMessage.trim().length > 0) {
    return value.errorMessage.trim();
  }
  return "Pi auditor provider ended with an error.";
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
  const envelope: ProtectionAuditorEnvelope = {
    version: PROTECTION_AUDITOR_PROTOCOL,
    prompt: request.prompt,
    // JSON has no undefined value; keep the field present for a stable wire shape.
    input: request.input === undefined ? null : request.input,
    cwd: request.cwd,
  };
  const merged = mergedRole(agent, role);
  return await runProcessDecision({
    command: agent.command ?? "",
    args: merged.args,
    cwd: request.cwd,
    prompt: JSON.stringify(envelope),
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
    return observed({ error: problems.join(" "), durationMs: Date.now() - startedAt, settlement });
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
