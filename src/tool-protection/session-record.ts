/**
 * Optional auditor-session retention for the pre-execution tool gate (issue #536).
 *
 * When `toolProtection.retainAuditorSessions` is explicitly enabled, one actual
 * auditor invocation is written as one ordinary saved Pi session, in the same
 * standard session store every other Pi conversation uses, so the user can
 * inspect the exact request that was supplied and the reply that actually came
 * back. This module is the whole feature's storage half:
 *
 * - It is write-only. It uses the host's own `SessionManager` static
 *   `create()` plus the append APIs, and never `open()`, `continueRecent()`,
 *   `list()`, `listAll()`, or `buildSessionContext()`: an audit record is never
 *   read back, so a stored history can never become input to a later decision,
 *   and no existing user session is enumerated or touched here.
 * - It never repoints the acting conversation. `ctx.sessionManager` is only
 *   read for its session identity (lineage); the record gets a fresh manager
 *   and a fresh file per invocation. The instance methods that would switch or
 *   replace the live session (`newSession()`, `setSessionFile()`) are not part
 *   of the surface used here.
 * - It preserves what each supported transport actually did. The Pi route
 *   records the route system instruction, the one user prompt, the effective
 *   reasoning request, and the terminal `AssistantMessage` verbatim (a provider
 *   error message stays an error message). The external binary route records
 *   the exact stdin envelope and the captured stdout as clearly labelled host
 *   process I/O, and deliberately reports no provider, api, model, usage, or
 *   stop reason, because an external binary performed no Pi provider call. The
 *   external envelope is described as what the gate supplied, with the host's
 *   own stdin-flush report saying whether it was confirmed delivered: an early
 *   exit, an EPIPE, a timeout, or a cancellation before delivery means the
 *   program may have read none or only part of it.
 * - It fails visibly instead of changing the gate. Every Pi persistence call
 *   can throw synchronously, so a failure here is returned as an honest
 *   "not saved"/"partially saved" outcome for the caller to surface inline.
 *   Retention is not a safety control, so a recording problem never blocks a
 *   call on its own and never rewrites the auditor's decision; the audit
 *   verdict itself keeps its existing fail-closed semantics untouched.
 * - It records no transport configuration. No command, arguments, environment,
 *   bootstrap value, or credential is ever written into a record; the external
 *   record carries the process's own stdin/stdout bytes and exit facts only.
 *   A launch exception is reduced to its syscall and host error code, because
 *   Node quotes the configured executable in that message, and any other
 *   retained host status has path-shaped tokens withheld.
 *
 * - It never decides an outcome the gate did not reach. The write is split: the
 *   request entries are written first, and the synchronous `complete()` appends
 *   the outcome entry only after the caller has re-asserted its admission
 *   binding. A cancellation, settings change, or mutated proposal that lands
 *   while the record is being written is therefore recorded as the invalidation
 *   it became, and the call is blocked instead of admitted on a stale approval.
 *
 * With retention Off nothing in this module runs at all: no host-peer load, no
 * session directory, no file.
 */

import { existsSync } from "node:fs";
import { loadHostPeerModule } from "../host-peer-loader";
import { PROTECTION_AUDITOR_PROTOCOL, type ProtectionAuditorObservation } from "./runner";

/** The Pi package whose own SDK writes the record (host peer, never a dependency). */
const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Custom-entry marker for one audit outcome. Custom entries never enter model context. */
export const TOOL_PROTECTION_RECORD_CUSTOM_TYPE = "pi-review-gate.tool-protection";

/**
 * Displayable custom-message marker for the external binary's captured output.
 * A custom message is the standard in-session way to show extension-supplied
 * content, which is what an external program's stdout is.
 */
export const TOOL_PROTECTION_EXTERNAL_CUSTOM_TYPE = "pi-review-gate.tool-protection.output";

/** Current shape marker stored in every outcome entry. */
const RECORD_SCHEMA = 1;

/** Honest framing for the verdict stored in a record. */
const DECISION_MEANING = "PASS/FAIL is this gate's pre-execution audit verdict, not a claim that the tool ran or succeeded.";

/** How one auditor invocation ended, as recorded. */
export type AuditorRecordStatus =
  | "decision"
  | "transport-error"
  | "timeout"
  | "cancelled"
  | "invalidated"
  | "malformed";

/** The host outcome the coordinator knows only after the invocation returns. */
export interface AuditorRecordOutcome {
  status: AuditorRecordStatus;
  /** The parsed verdict, when the auditor produced one. */
  decision?: "PASS" | "FAIL";
  /** The auditor's own supplied reason, verbatim, only when one was supplied. */
  reason?: string;
  /** Host status text for a non-decision (transport error, timeout, abort, invalidation). */
  error?: string;
}

/**
 * A record whose request entries are already written and whose outcome entry is
 * still pending. Splitting the write this way is what keeps admission safe:
 * `complete()` is synchronous, so the caller can run its final authoritative
 * binding check and then finish the record and grant admission with no await in
 * between. An outcome is therefore never saved for a call the gate did not
 * grant, and recording never holds an approval open across its own I/O.
 */
export interface AuditorRecordHandle {
  /** Append the outcome entry. Never throws; returns the honest write result. */
  complete(outcome: AuditorRecordOutcome): AuditorRecordWriteResult;
}

/** Everything one record needs before its outcome, assembled by the coordinator. */
export interface AuditorRecordOpenDraft {
  identity: AuditorRecordIdentity;
  /** The exact generated auditor prompt for this invocation. */
  prompt: string;
  /** What the runner's transport actually carried, when it carried anything. */
  observation?: ProtectionAuditorObservation;
}

/** Everything one record needs, assembled by the coordinator. */
export interface AuditorRecordDraft extends AuditorRecordOpenDraft {
  outcome: AuditorRecordOutcome;
}

export interface AuditorRecordIdentity {
  invocationId: string;
  toolName: string;
  argumentFingerprint?: string;
  parentToolCallId?: string;
  lineage?: string[];
  role: string;
  taskId?: string;
  cwd: string;
  level: string;
  policyVersion?: string;
  /** Auditor identity only (selection source plus model or id) — never its definition. */
  auditor: { source: "pi" | "external"; label: string };
  /** Acting session identity when the acting conversation is itself persisted. */
  actingSessionId?: string;
  actingSessionFile?: string;
  durationMs?: number;
}

export interface AuditorRecordWriteResult {
  /** `full` saved everything; `partial` left a valid prefix; `none` saved nothing. */
  saved: "full" | "partial" | "none";
  /** Real failure detail, never a guess. */
  detail?: string;
  /** Inline warning to surface, present only when the record is not complete. */
  warning?: string;
}

/** Structural view of the host `SessionManager` instance this module appends to. */
export interface HostAuditorSessionManager {
  appendSessionInfo(name: string): unknown;
  appendThinkingLevelChange(thinkingLevel: string): unknown;
  appendMessage(message: unknown): unknown;
  appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): unknown;
  appendCustomEntry(customType: string, data?: unknown): unknown;
  /** Used only to report honestly whether a partial file exists. */
  getSessionFile?(): string | undefined;
}

/** Structural view of the host `SessionManager` static factory. */
export interface HostAuditorSessionManagerConstructor {
  create(
    cwd: string,
    sessionDir?: string,
    options?: { id?: string; parentSession?: string },
  ): HostAuditorSessionManager;
}

export interface AuditorRecordDependencies {
  /** Test seam for resolving the host `SessionManager`; production loads the host peer. */
  loadSessionManager?: () => Promise<HostAuditorSessionManagerConstructor | undefined>;
  /** Test seam for the host-peer loader's Pi entry discovery. */
  hostEntryProvider?: () => string | undefined;
}

/**
 * Read the acting conversation's persisted identity for record lineage. This
 * mirrors `sessionPersistenceIdentity` (same duck-typing, same "no file means
 * no identity" answer for `--no-session`) without importing that module's
 * review-state graph into this leaf. An absent identity is recorded as absent:
 * an ephemeral acting conversation stays ephemeral, while an opted-in audit
 * record is still its own independent saved session.
 */
export function actingSessionIdentity(ctx: unknown, fallbackCwd: string): { sessionId: string; sessionFile: string; cwd: string } | undefined {
  const manager = isRecordLike(ctx) ? (ctx as { sessionManager?: unknown }).sessionManager : undefined;
  const sessionId = callString(manager, "getSessionId");
  const sessionFile = callString(manager, "getSessionFile");
  const cwd = callString(manager, "getCwd") ?? fallbackCwd;
  if (!sessionId || !sessionFile) return undefined;
  return { sessionId, sessionFile, cwd };
}

/** The picker caption for one audit record. */
export function auditorRecordCaption(identity: AuditorRecordIdentity): string {
  const parts = [
    "Tool protection audit",
    identity.toolName,
    `level ${identity.level}`,
    identity.auditor.source === "pi" ? `pi ${identity.auditor.label}` : `external ${identity.auditor.label}`,
  ];
  if (identity.parentToolCallId) parts.push(`nested under ${identity.parentToolCallId}`);
  else if (identity.actingSessionId) parts.push(`session ${identity.actingSessionId}`);
  return parts.join(" · ").replace(/[\r\n]+/g, " ").slice(0, 240);
}

/**
 * Write one auditor invocation as one fresh saved session. Never throws: a
 * failure returns the honest partial/not-saved outcome plus the real detail, so
 * the caller keeps the auditor's decision and discloses the recording problem.
 */
export async function writeAuditorSessionRecord(
  draft: AuditorRecordDraft,
  dependencies: AuditorRecordDependencies = {},
): Promise<AuditorRecordWriteResult> {
  const opened = await openAuditorSessionRecord(draft, dependencies);
  return opened.complete(draft.outcome);
}

/**
 * Create the record and write everything except the outcome entry. The returned
 * handle's `complete()` is synchronous by contract, which is what lets the
 * caller keep its final admission revalidation immediately before the grant.
 */
export async function openAuditorSessionRecord(
  draft: AuditorRecordOpenDraft,
  dependencies: AuditorRecordDependencies = {},
): Promise<AuditorRecordHandle> {
  // Shared with complete(): a failure anywhere is remembered rather than
  // re-thrown, so a recording problem can only ever become a warning.
  const state: { detail?: string } = {};
  let manager: HostAuditorSessionManager | undefined;
  try {
    const load = dependencies.loadSessionManager ?? defaultLoadSessionManager(dependencies.hostEntryProvider);
    const SessionManager = await load();
    if (!SessionManager) {
      state.detail = "the host Pi session SDK is unavailable in this runtime";
    } else {
      // A fresh manager and a fresh file per invocation, in the ordinary store.
      // Nothing is opened, listed, or continued, and the acting session's own
      // manager is never used.
      manager = SessionManager.create(
        draft.identity.cwd,
        undefined,
        draft.identity.actingSessionFile ? { parentSession: draft.identity.actingSessionFile } : {},
      );
    }
  } catch (error) {
    state.detail = errorMessage(error);
  }

  const append = (write: () => void): void => {
    if (state.detail !== undefined || manager === undefined) return;
    try {
      write();
    } catch (error) {
      state.detail = errorMessage(error);
    }
  };

  if (manager !== undefined) {
    append(() => { manager.appendSessionInfo(auditorRecordCaption(draft.identity)); });
    for (const step of transportEntries(manager, draft)) append(step);
  }

  return {
    complete: (outcome: AuditorRecordOutcome): AuditorRecordWriteResult => {
      // The outcome entry goes last, so a record without one means the outcome
      // was not recorded rather than that no outcome existed.
      if (manager !== undefined) {
        append(() => { manager.appendCustomEntry(TOOL_PROTECTION_RECORD_CUSTOM_TYPE, outcomeData(draft, outcome)); });
      }
      if (state.detail === undefined) return { saved: "full" };
      // The file is created on the first user/assistant entry, so its existence
      // is what distinguishes a truncated record from no record at all.
      let exists = false;
      try {
        const file = manager?.getSessionFile?.();
        exists = typeof file === "string" && existsSync(file);
      } catch {
        exists = false;
      }
      return exists ? warn("partial", state.detail) : warn("none", state.detail);
    },
  };
}

/** The ordered entries describing what the transport actually carried. */
function transportEntries(manager: HostAuditorSessionManager, draft: AuditorRecordOpenDraft): Array<() => void> {
  const observation = draft.observation;
  const timestamp = Date.now();
  if (observation?.transport === "pi-in-process" && observation.pi) {
    const pi = observation.pi;
    return [
      // The effective reasoning request is otherwise unrecoverable: the
      // assistant message does not carry the Pi thinking level outside the
      // agent loop, and "off" is recorded as the deliberate absence of one.
      () => { manager.appendThinkingLevelChange(pi.thinkingLevel); },
      () => { appendSystem(manager, pi.systemPrompt, timestamp); },
      // Byte-identical to the one user message that was sent.
      () => { appendUser(manager, pi.prompt, timestamp); },
      ...(pi.assistant === undefined
        ? []
        : [() => {
          manager.appendMessage(pi.assistant);
        }]),
    ];
  }
  if (observation?.transport === "external-binary" && observation.external) {
    const external = observation.external;
    const facts = externalFacts(external);
    return [
      () => { appendUser(manager, externalRequestText(external.requestText, externalDeliveryNote(external)), timestamp); },
      () => {
        manager.appendCustomMessageEntry(TOOL_PROTECTION_EXTERNAL_CUSTOM_TYPE, externalOutputText(external, facts), true, {
          protocol: PROTECTION_AUDITOR_PROTOCOL,
          ...facts,
        });
      },
    ];
  }
  // Nothing reached a transport (unsupported route, unavailable model or agent,
  // cancellation before launch, invalid request). Record the generated request
  // and say plainly that it was never sent. The refusal is host status text, so it
  // passes through the same path withholding as the outcome entry: a registry or
  // dispatch exception that quotes a bootstrap or executable path must not persist
  // it here either. The generated prompt itself is stored byte-for-byte.
  const refusal = withholdTransportPaths(observation?.refusal ?? "the auditor was never invoked");
  return [() => { appendUser(manager, refusedRequestText(draft.prompt, refusal), timestamp); }];
}

function appendSystem(manager: HostAuditorSessionManager, content: string, timestamp: number): void {
  // The route instruction as one leading system message with no tool
  // declarations: exactly the shape the in-process request used, so inspecting
  // or resuming the record restores no tools.
  manager.appendMessage({ role: "system", content, timestamp });
}

function appendUser(manager: HostAuditorSessionManager, content: string, timestamp: number): void {
  manager.appendMessage({ role: "user", content, timestamp });
}

function externalRequestText(requestText: string, deliveryNote: string): string {
  return [
    `External auditor transport request — the JSON the gate supplied to the auditor's stdin under the ${PROTECTION_AUDITOR_PROTOCOL} protocol.`,
    "This is host process input for an external binary, not a Pi model request.",
    deliveryNote,
    "",
    requestText,
  ].join("\n");
}

/**
 * Honest delivery framing for the external envelope. The gate authored these
 * bytes, but only the host's own stdin-flush report confirms they reached the
 * program, and an early exit, an EPIPE, a timeout, or a cancellation can stop
 * delivery. A record never claims more than the host reported.
 */
function externalDeliveryNote(external: NonNullable<ProtectionAuditorObservation["external"]>): string {
  if (external.deliveredToStdin && external.stdinError === undefined) {
    return "The host reported that this write flushed to the program's stdin pipe.";
  }
  if (external.stdinError !== undefined) {
    return `Delivery is NOT confirmed: the host reported a stdin write error (${external.stdinError}), so the program may have read none or only part of this envelope.`;
  }
  const why = external.aborted
    ? "the run was cancelled before the write completed"
    : external.timedOut
      ? "the run reached its deadline before the write completed"
      : "the host never reported the write flushing";
  return `Delivery is NOT confirmed: ${why}, so the program may have read none or only part of this envelope.`;
}

function externalOutputText(external: NonNullable<ProtectionAuditorObservation["external"]>, facts: Record<string, unknown>): string {
  // The captured stdout is shown once, in full, below the summary line.
  const outcome = Object.entries(facts)
    .filter(([key]) => key !== "stdout")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const body = external.outputText.length === 0 ? "(no output was captured)" : external.outputText;
  return [
    "External auditor binary output — captured stdout of the external auditor process.",
    "This is program output, not an assistant message from a Pi provider: no provider, model, usage, or stop reason exists for it.",
    `Host outcome: ${outcome}`,
    "",
    body,
  ].join("\n");
}

function refusedRequestText(prompt: string, refusal: string): string {
  return [
    `Generated auditor request for this call. It was never sent to any transport (${refusal}).`,
    "No auditor reply exists for it.",
    "",
    prompt,
  ].join("\n");
}

function externalFacts(external: NonNullable<ProtectionAuditorObservation["external"]>): Record<string, unknown> {
  // The captured stdout is stored exactly as the transport retained it. The
  // only truncation marker is the one the shared process primitive already
  // reported for this invocation; no second cap is applied here.
  return {
    exitCode: external.exitCode,
    timedOut: external.timedOut,
    aborted: external.aborted,
    stdoutTruncated: external.truncated,
    stdinDelivered: external.deliveredToStdin,
    ...(external.settlement === undefined ? {} : { settlement: external.settlement }),
    ...(external.stdinError === undefined ? {} : { stdinError: external.stdinError }),
    stdout: external.outputText,
  };
}

function outcomeData(draft: AuditorRecordOpenDraft, outcome: AuditorRecordOutcome): Record<string, unknown> {
  const { identity, observation } = draft;
  // A launch exception quotes the configured executable (`spawn /path/bin
  // ENOENT`), so its retained text is replaced by the structured category and
  // code the runner reported; the user-facing refusal keeps the full diagnostic.
  const launch = observation?.launchFailure;
  const hostError = launch !== undefined
    ? observation?.refusal ?? `the configured auditor program could not be started (${launch.syscall} ${launch.code})`
    : outcome.error;
  return {
    schema: RECORD_SCHEMA,
    invocationId: identity.invocationId,
    toolName: identity.toolName,
    ...(identity.argumentFingerprint === undefined ? {} : { argumentFingerprint: identity.argumentFingerprint }),
    ...(identity.parentToolCallId === undefined ? {} : { parentToolCallId: identity.parentToolCallId }),
    ...(identity.lineage === undefined || identity.lineage.length === 0 ? {} : { lineage: [...identity.lineage] }),
    role: identity.role,
    ...(identity.taskId === undefined ? {} : { taskId: identity.taskId }),
    cwd: identity.cwd,
    ...(identity.actingSessionId === undefined ? {} : { actingSessionId: identity.actingSessionId }),
    ...(identity.actingSessionFile === undefined ? {} : { actingSessionFile: identity.actingSessionFile }),
    level: identity.level,
    ...(identity.policyVersion === undefined ? {} : { policyVersion: identity.policyVersion }),
    auditor: { source: identity.auditor.source, label: identity.auditor.label },
    transport: observation?.transport ?? "route-refused",
    ...(observation?.launchFailure === undefined
      ? {}
      : { launchFailure: { syscall: observation.launchFailure.syscall, code: observation.launchFailure.code } }),
    ...(observation?.transport === "pi-in-process" && observation.pi
      ? { requestedModel: observation.pi.model, thinkingLevel: observation.pi.thinkingLevel }
      : {}),
    ...(identity.durationMs === undefined ? {} : { durationMs: identity.durationMs }),
    status: outcome.status,
    ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
    ...(outcome.reason === undefined ? {} : { suppliedReason: outcome.reason }),
    ...(outcome.decision === undefined ? {} : { decisionMeaning: DECISION_MEANING }),
    ...(hostError === undefined ? {} : { hostError: withholdTransportPaths(hostError) }),
    ...(observation?.refusal === undefined ? {} : { refusal: withholdTransportPaths(observation.refusal) }),
  };
}

/**
 * Backstop for retained host status text. The launch path is already reduced to
 * a syscall and code above; this keeps any other host exception that quotes an
 * absolute or home-relative path (a configured executable, a bootstrap file) out
 * of a saved record, and says so instead of silently rewriting the failure.
 */
function withholdTransportPaths(text: string): string {
  // Only path-shaped tokens (absolute, home-relative, or dot-relative) are
  // withheld, so an ordinary "model/provider" identifier or a quoted decision
  // stays intact instead of being shredded by a bare-slash match.
  const withheld = text.replace(/(^|[^\w.~/-])((?:~|\.{1,2})?\/[^\s'",;:()\[\]{}]+)/g, "$1<path>");
  return withheld === text ? text : `${withheld} [paths withheld from saved records]`;
}

function warn(saved: "partial" | "none", detail: string): AuditorRecordWriteResult {
  const warning = saved === "partial"
    ? `Tool protection: the auditor session was only partially saved (${detail}); the saved session may be missing its later entries. The gate decision is unchanged.`
    : `Tool protection: the auditor session could not be saved (${detail}), so this audit is not in your saved sessions. The gate decision is unchanged.`;
  return { saved, detail, warning };
}

/** The honest disclosure used when a record could not be started at all. */
export function auditorRecordNotSavedWarning(detail: string): string {
  return `Tool protection: the auditor session could not be saved (${detail}), so this audit is not in your saved sessions. The gate decision is unchanged.`;
}

function defaultLoadSessionManager(
  hostEntryProvider: (() => string | undefined) | undefined,
): () => Promise<HostAuditorSessionManagerConstructor | undefined> {
  return async () => {
    const mod = await loadHostPeerModule(PI_AGENT_PACKAGE_NAME, {
      packageMainFallback: true,
      ...(hostEntryProvider ? { entryProvider: hostEntryProvider } : {}),
    });
    const manager = mod?.SessionManager;
    // A class is a function; both shapes are acceptable if the static create exists.
    if (manager === null || (typeof manager !== "object" && typeof manager !== "function")) return undefined;
    const create = (manager as { create?: unknown }).create;
    if (typeof create !== "function") return undefined;
    return manager as unknown as HostAuditorSessionManagerConstructor;
  };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFunctionLike(value: unknown): boolean {
  return typeof value === "function";
}

function callString(target: unknown, method: string): string | undefined {
  if (!isRecordLike(target) && !isFunctionLike(target)) return undefined;
  const candidate = (target as Record<string, unknown>)[method];
  if (typeof candidate !== "function") return undefined;
  try {
    const value = (candidate as () => unknown).call(target);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim() || "unknown error";
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}…`;
}
