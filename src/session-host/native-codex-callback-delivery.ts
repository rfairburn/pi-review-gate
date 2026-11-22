/**
 * Busy-turn callback delivery primitive for one HOST-OWNED native Codex
 * app-server (issue #682): ONE expected-turn `turn/steer` on a dedicated call
 * lane, plus closed classification of what the provider said back.
 *
 * ## Scope (what this module is and is not)
 *
 * This is the BUSY-delivery half only. When the host already knows — from its
 * own trusted state — that one exact thread has one exact active turn, a callback
 * text can be offered to that turn with the provider's stable `turn/steer`
 * request carrying `expectedTurnId` and `clientUserMessageId`. Nothing else is
 * expressible here:
 *
 * - no turn start, queue, interrupt, resume, fork, or idle-wake choice. When the
 *   thread is idle, or the turn moved on, the result says so and the caller's
 *   separate activation/idle policy decides what (if anything) happens next;
 * - no subscription, no notification sink, and no reply path for server
 *   requests. Native approvals and elicitations stay with the native TUI;
 * - no retry and no retarget. A send is attempted at most once per
 *   `clientUserMessageId` per sender, against exactly the target the caller
 *   named, and only if the host's trusted current target still equals it at the
 *   moment of the write;
 * - no socket, handshake, or JSON-RPC framing. The transport is an INJECTED
 *   narrow lane ({@linkcode NativeCodexCallbackSteerLane}) whose single method
 *   writes exactly one `turn/steer` request. The read-only observer transport in
 *   `native-codex-rpc.ts` deliberately exposes no generic request method and is
 *   not widened here; only its endpoint validator is reused.
 *
 * ## Acceptance is not placement
 *
 * A successful `turn/steer` answer means the provider ACCEPTED the input as
 * pending for that turn. It does not mean the model saw it. Against the Codex
 * 0.171 app-server contract an accepted steer can be held until the next tool
 * boundary or approval resolution, carried into a later turn, or dropped when
 * the operator interrupts the turn. The send result therefore reports
 * `placement: "unconfirmed"`, and {@linkcode classifyNativeCodexCallbackPlacement}
 * turns separately gathered, caller-supplied evidence into a closed placed /
 * missing / mismatch / uncertain verdict. How that evidence is gathered (and
 * whether a given provider build echoes `clientUserMessageId` on the resulting
 * user-message item) is outside this module.
 *
 * ## Fail-closed result taxonomy
 *
 * - `refused`: nothing was written (bad input, untrusted or unsupported lane,
 *   unknown or stale target, duplicate submission, a send already in flight,
 *   sender capacity reached, or the lane positively reporting it did not write
 *   — including a write-edge guard that found the target no longer current).
 * - `rejected`: the provider answered with an error. Not accepted, definitively.
 *   The sub-reason is a best-effort classification of the provider's error and
 *   never carries its message.
 * - `accepted`: the provider accepted the steer for exactly the expected turn.
 * - `uncertain`: the frame was (or may have been) written but there is no
 *   trustworthy answer — timeout, lane closed, lane fault, a malformed success
 *   or error answer, or an answer naming a different turn. The input may or may not be pending; it
 *   must NOT be resent blindly. The sender keeps the id burned.
 *
 * ## Privacy
 *
 * The callback text crosses this module only into the lane's single request.
 * It is never placed in a result, an error, or a log. Provider error objects are
 * reduced to a closed code before they leave the classifier.
 */

import { isRecord } from "../record-guard";
import {
  NATIVE_CODEX_RPC_MAX_ID_CHARS,
  readNativeCodexRpcEndpoint,
  type NativeCodexRpcEndpoint,
} from "./native-codex-rpc";

/* ------------------------------------------------------------------ bounds */

/** The only provider method this module can cause to be written. */
export const NATIVE_CODEX_CALLBACK_STEER_METHOD = "turn/steer";

/** Brand a host-constructed lane must carry; anything else is not trusted. */
export const NATIVE_CODEX_CALLBACK_LANE_OWNERSHIP = "host-owned-dedicated-call-lane";

/** One callback text, UTF-8 bytes. A larger callback is not a busy steer. */
export const NATIVE_CODEX_CALLBACK_MAX_TEXT_BYTES = 64 * 1024;

/** Caller-minted stable submission id (e.g. a durable callback record id). */
export const NATIVE_CODEX_CALLBACK_MAX_CLIENT_MESSAGE_ID_CHARS = 128;

/**
 * Submission ids one sender remembers to refuse a resend. This is a per-sender,
 * in-memory guard against blind retry, not durable idempotency: durable
 * once-only semantics belong to the caller's storage. An id that was (or may
 * have been) written is never forgotten: at capacity the sender refuses NEW ids
 * (`submission-capacity`) instead of evicting old ones, and the host replaces
 * the sender (with its own durable record of what was offered) to continue.
 */
export const NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS = 1_024;

const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/* ------------------------------------------------------------------- lane */

/** One exact thread and turn the host trusts as current. */
export interface NativeCodexCallbackSteerTarget {
  readonly threadId: string;
  readonly turnId: string;
}

/** The exact params of the one request a lane may write. */
export interface NativeCodexCallbackSteerParams {
  readonly threadId: string;
  readonly expectedTurnId: string;
  readonly clientUserMessageId: string;
  readonly input: readonly [{ readonly type: "text"; readonly text: string }];
}

/**
 * What the lane observed for its one write. The lane must be honest about the
 * difference between "never written" and "written, no answer":
 *
 * - `not-sent`: positively nothing reached the socket (lane not ready, closed
 *   beforehand, or the write-edge guard said the target is no longer current).
 * - `result` / `error`: the correlated JSON-RPC answer, raw. The lane must not
 *   interpret it; classification happens here. An `error` whose payload is not
 *   a JSON-RPC error object (integer `code`, string `message`) is read as
 *   uncertain, not as a refusal.
 * - `no-response`: written (or possibly written) and no correlated answer
 *   arrived before the lane's own bound or close.
 */
export type NativeCodexCallbackSteerWireOutcome =
  | { readonly kind: "not-sent" }
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "no-response"; readonly reason: "timeout" | "closed" };

/**
 * The narrow, host-constructed call lane. Composition contract for the real
 * implementation (not provided here):
 *
 * - its own connection to the SAME host-owned endpoint the observer uses, never
 *   the observer's connection and never the TUI relay's;
 * - never subscribes to a thread and never answers a server request (approval,
 *   question, elicitation, auth refresh) — it drops them unanswered;
 * - `steer` writes exactly one `turn/steer` request with exactly `params`,
 *   correlates by an id it minted, and resolves (never rejects, ideally) with a
 *   {@linkcode NativeCodexCallbackSteerWireOutcome}. It never retries;
 * - WRITE EDGE: a ready lane hands the frame to its socket synchronously inside
 *   the `steer` call, before returning or awaiting anything. A lane that is not
 *   ready (still connecting, handshaking, or reconnecting) returns `not-sent`
 *   instead of waiting. Any implementation that nonetheless defers the write
 *   MUST call `writeEdge.isTargetStillCurrent()` immediately before the socket
 *   write and return `not-sent` when it is false. The guard re-reads the host's
 *   trusted current target, and it is permanently false once `steer` has
 *   settled, so a late or retried write after a host rebind is refused even
 *   when the old provider turn is still active and would match
 *   `expectedTurnId`.
 *
 * `capability.expectedTurnSteer` is the host's own attestation that this exact
 * backend build supports expected-turn steering with `clientUserMessageId`
 * (verified against Codex 0.171.0). Anything but literal `true` is refused.
 */
export interface NativeCodexCallbackSteerLane {
  readonly ownership: typeof NATIVE_CODEX_CALLBACK_LANE_OWNERSHIP;
  readonly endpoint: NativeCodexRpcEndpoint;
  readonly capability: { readonly expectedTurnSteer: true };
  steer(
    params: NativeCodexCallbackSteerParams,
    writeEdge: NativeCodexCallbackSteerWriteEdge,
  ): Promise<NativeCodexCallbackSteerWireOutcome>;
}

/** Handed to the lane with each frame; see the WRITE EDGE rule on the lane. */
export interface NativeCodexCallbackSteerWriteEdge {
  /** True only while the host's trusted current target equals the frame's target and `steer` has not settled. */
  isTargetStillCurrent(): boolean;
}

/* ---------------------------------------------------------------- results */

export type NativeCodexCallbackSteerRefusalCode =
  /** Target ids, submission id, or text failed validation. */
  | "input-invalid"
  /** The lane is not a branded host-owned call lane with a `steer` method. */
  | "lane-untrusted"
  /** The lane's endpoint is not one the host could own. */
  | "endpoint-unsupported"
  /** The host did not attest expected-turn steer support for this backend. */
  | "capability-unsupported"
  /** The host has no trusted current busy target (idle, unknown, or reader failed). */
  | "target-unknown"
  /** The host's trusted current target differs from the requested one. */
  | "target-stale"
  /** This sender already handed this submission id to the lane. */
  | "duplicate-submission"
  /** Another send on this sender has not settled. */
  | "in-flight"
  /** This sender already remembers its maximum number of written submissions. */
  | "submission-capacity"
  /** The lane positively reported it wrote nothing. */
  | "lane-not-sent";

export type NativeCodexCallbackSteerRejectionReason =
  /** The provider's active turn is not the expected one. */
  | "turn-mismatch"
  /** The provider has no active turn on the thread. */
  | "no-active-turn"
  /** The active turn kind does not accept steering (e.g. review/compact). */
  | "not-steerable"
  /** The provider does not know the thread. */
  | "thread-not-found"
  /** An error the classifier does not recognize. Still a definitive refusal. */
  | "unclassified";

export type NativeCodexCallbackSteerUncertaintyReason =
  | "timeout"
  | "closed-after-send"
  /** The lane threw or resolved with something that is not a wire outcome. */
  | "lane-fault"
  /** A success answer without a usable `turnId`. */
  | "malformed-acceptance"
  /** An error answer that is not a JSON-RPC error object; not proof of refusal. */
  | "malformed-error"
  /** A success answer naming a different turn than the expected one. */
  | "acceptance-turn-mismatch";

/** Proof of RPC acceptance for one exact target and submission. Not placement. */
export interface NativeCodexCallbackSteerAcceptance {
  readonly threadId: string;
  readonly turnId: string;
  readonly clientUserMessageId: string;
}

export type NativeCodexCallbackSteerOutcome =
  | { readonly status: "refused"; readonly code: NativeCodexCallbackSteerRefusalCode; readonly sent: false }
  | { readonly status: "rejected"; readonly reason: NativeCodexCallbackSteerRejectionReason; readonly sent: true }
  | {
      readonly status: "accepted";
      readonly sent: true;
      readonly acceptance: NativeCodexCallbackSteerAcceptance;
      readonly placement: "unconfirmed";
    }
  | { readonly status: "uncertain"; readonly reason: NativeCodexCallbackSteerUncertaintyReason; readonly sent: "unknown" };

export interface NativeCodexCallbackSteerRequest {
  readonly target: NativeCodexCallbackSteerTarget;
  readonly clientUserMessageId: string;
  readonly text: string;
}

export interface NativeCodexCallbackSteerSenderOptions {
  readonly lane: NativeCodexCallbackSteerLane;
  /**
   * The host's trusted current busy target for this row, read synchronously
   * immediately before the write. `null` means not busy or not known. This is
   * the host's own state (e.g. the owned observer's active-turn evidence), never
   * a value taken from the callback payload.
   */
  readonly readCurrentTarget: () => NativeCodexCallbackSteerTarget | null;
}

export interface NativeCodexCallbackSteerSender {
  /** At most one lane write per call; never retries, never rejects. */
  send(request: NativeCodexCallbackSteerRequest): Promise<NativeCodexCallbackSteerOutcome>;
}

/* ------------------------------------------------------------- validation */

function exactId(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > maxChars) return null;
  // Exactness: surrounding whitespace or any control character means this is
  // not the provider's opaque id, and it is refused rather than normalized.
  if (value.trim() !== value) return null;
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;
  return value;
}

function readTarget(value: unknown): NativeCodexCallbackSteerTarget | null {
  if (!isRecord(value)) return null;
  const threadId = exactId(value.threadId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
  const turnId = exactId(value.turnId, NATIVE_CODEX_RPC_MAX_ID_CHARS);
  if (threadId === null || turnId === null) return null;
  return { threadId, turnId };
}

function readClientMessageId(value: unknown): string | null {
  const id = exactId(value, NATIVE_CODEX_CALLBACK_MAX_CLIENT_MESSAGE_ID_CHARS);
  return id !== null && CLIENT_MESSAGE_ID_PATTERN.test(id) ? id : null;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.trim().length === 0 || value.includes("\u0000")) return null;
  if (Buffer.byteLength(value, "utf8") > NATIVE_CODEX_CALLBACK_MAX_TEXT_BYTES) return null;
  return value;
}

function sameTarget(a: NativeCodexCallbackSteerTarget, b: NativeCodexCallbackSteerTarget): boolean {
  return a.threadId === b.threadId && a.turnId === b.turnId;
}

type LaneRead =
  | { readonly ok: true; readonly steer: NativeCodexCallbackSteerLane["steer"] }
  | { readonly ok: false; readonly code: NativeCodexCallbackSteerRefusalCode };

function readLane(lane: unknown): LaneRead {
  if (!isRecord(lane) || lane.ownership !== NATIVE_CODEX_CALLBACK_LANE_OWNERSHIP || typeof lane.steer !== "function") {
    return { ok: false, code: "lane-untrusted" };
  }
  if (readNativeCodexRpcEndpoint(lane.endpoint).status !== "valid") {
    return { ok: false, code: "endpoint-unsupported" };
  }
  if (!isRecord(lane.capability) || lane.capability.expectedTurnSteer !== true) {
    return { ok: false, code: "capability-unsupported" };
  }
  const steer = lane.steer as NativeCodexCallbackSteerLane["steer"];
  return { ok: true, steer: (params, writeEdge) => steer.call(lane, params, writeEdge) };
}

/* --------------------------------------------------------- classification */

function refused(code: NativeCodexCallbackSteerRefusalCode): NativeCodexCallbackSteerOutcome {
  return Object.freeze({ status: "refused", code, sent: false });
}

function uncertain(reason: NativeCodexCallbackSteerUncertaintyReason): NativeCodexCallbackSteerOutcome {
  return Object.freeze({ status: "uncertain", reason, sent: "unknown" });
}

/** A JSON-RPC error object: integer `code` and string `message`. */
export function isNativeCodexCallbackJsonRpcError(error: unknown): boolean {
  return isRecord(error) && Number.isSafeInteger(error.code) && typeof error.message === "string";
}

/**
 * Best-effort closed reason for one provider error answer, or `null` when the
 * payload is not a JSON-RPC error object: a malformed reply does not establish
 * that the provider refused the input. The structured `codexErrorInfo` marker
 * is preferred; the message patterns follow the 0.171 app-server wording and
 * may drift, which only degrades the reason to `unclassified` — every
 * well-formed error is a definitive non-acceptance either way. The message
 * itself is matched in place and never returned.
 */
export function classifyNativeCodexCallbackSteerError(error: unknown): NativeCodexCallbackSteerRejectionReason | null {
  if (!isNativeCodexCallbackJsonRpcError(error) || !isRecord(error)) return null;
  const data = isRecord(error.data) ? error.data : null;
  const info = data === null ? undefined : data.codexErrorInfo;
  if (info === "activeTurnNotSteerable" || (isRecord(info) && info.activeTurnNotSteerable !== undefined)) {
    return "not-steerable";
  }
  const message = typeof error.message === "string" ? error.message.slice(0, 1_024) : "";
  if (/activeTurnNotSteerable|not steerable/i.test(message)) return "not-steerable";
  if (/expected active turn id/i.test(message)) return "turn-mismatch";
  if (/no active turn/i.test(message)) return "no-active-turn";
  if (/thread not found/i.test(message)) return "thread-not-found";
  return "unclassified";
}

function classifyWireOutcome(
  outcome: unknown,
  target: NativeCodexCallbackSteerTarget,
  clientUserMessageId: string,
): NativeCodexCallbackSteerOutcome | "not-sent" {
  if (!isRecord(outcome)) return uncertain("lane-fault");
  switch (outcome.kind) {
    case "not-sent":
      return "not-sent";
    case "error": {
      const reason = classifyNativeCodexCallbackSteerError(outcome.error);
      if (reason === null) return uncertain("malformed-error");
      return Object.freeze({ status: "rejected", reason, sent: true });
    }
    case "no-response":
      return uncertain(outcome.reason === "timeout" ? "timeout" : "closed-after-send");
    case "result": {
      const result = outcome.result;
      const turnId = isRecord(result) ? exactId(result.turnId, NATIVE_CODEX_RPC_MAX_ID_CHARS) : null;
      if (turnId === null) return uncertain("malformed-acceptance");
      // The provider names the turn it attached the input to. Anything but the
      // exact expected turn is a finding, never silently adopted as a retarget.
      if (turnId !== target.turnId) return uncertain("acceptance-turn-mismatch");
      return Object.freeze({
        status: "accepted",
        sent: true,
        acceptance: Object.freeze({ threadId: target.threadId, turnId, clientUserMessageId }),
        placement: "unconfirmed",
      });
    }
    default:
      return uncertain("lane-fault");
  }
}

/* ----------------------------------------------------------------- sender */

/**
 * Builds one sender over one trusted lane. The lane is validated once here; an
 * untrusted lane yields a sender that refuses every send without calling it.
 */
export function createNativeCodexCallbackSteerSender(
  options: NativeCodexCallbackSteerSenderOptions,
): NativeCodexCallbackSteerSender {
  const lane = readLane(isRecord(options) ? options.lane : undefined);
  const readCurrentTarget = isRecord(options) && typeof options.readCurrentTarget === "function"
    ? options.readCurrentTarget
    : null;
  const submitted = new Set<string>();
  let inFlight = false;

  const send = async (request: NativeCodexCallbackSteerRequest): Promise<NativeCodexCallbackSteerOutcome> => {
    if (!lane.ok) return refused(lane.code);
    if (!isRecord(request)) return refused("input-invalid");
    const target = readTarget(request.target);
    const clientUserMessageId = readClientMessageId(request.clientUserMessageId);
    const text = readText(request.text);
    if (target === null || clientUserMessageId === null || text === null) return refused("input-invalid");
    if (submitted.has(clientUserMessageId)) return refused("duplicate-submission");
    if (inFlight) return refused("in-flight");
    // Never evict: forgetting a written id would re-enable a blind resend.
    if (submitted.size >= NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS) return refused("submission-capacity");

    // Trusted current-target check, synchronously adjacent to the write: there
    // is no await between this read and handing the frame to the lane.
    let current: NativeCodexCallbackSteerTarget | null;
    try {
      current = readCurrentTarget === null ? null : readTarget(readCurrentTarget());
    } catch {
      current = null;
    }
    if (current === null) return refused("target-unknown");
    if (!sameTarget(current, target)) return refused("target-stale");

    const params: NativeCodexCallbackSteerParams = Object.freeze({
      threadId: target.threadId,
      expectedTurnId: target.turnId,
      clientUserMessageId,
      input: Object.freeze([Object.freeze({ type: "text" as const, text })]) as NativeCodexCallbackSteerParams["input"],
    });

    let settled = false;
    const writeEdge: NativeCodexCallbackSteerWriteEdge = Object.freeze({
      isTargetStillCurrent: (): boolean => {
        if (settled) return false;
        try {
          const now = readCurrentTarget === null ? null : readTarget(readCurrentTarget());
          return now !== null && sameTarget(now, target);
        } catch {
          return false;
        }
      },
    });

    inFlight = true;
    submitted.add(clientUserMessageId);
    let wire: unknown;
    try {
      wire = await lane.steer(params, writeEdge);
    } catch {
      wire = undefined;
    } finally {
      settled = true;
      inFlight = false;
    }
    const outcome = classifyWireOutcome(wire, target, clientUserMessageId);
    if (outcome === "not-sent") {
      // Positively never written, so this id has not reached the provider and
      // the caller may offer it again under its own policy.
      submitted.delete(clientUserMessageId);
      return refused("lane-not-sent");
    }
    return outcome;
  };

  return Object.freeze({ send });
}

/* -------------------------------------------------------------- placement */

/** One observed user message correlated to a submission, at one exact location. */
export interface NativeCodexCallbackPlacementObservation {
  readonly threadId: string;
  readonly turnId: string;
  readonly clientUserMessageId: string;
}

/**
 * Caller-gathered evidence about ONE accepted submission. The caller decides
 * how a user message is correlated to `clientUserMessageId`; this module only
 * reasons over what it reports. The evidence names the exact submission it was
 * gathered for, and every observation carries its own submission id, so
 * evidence about one callback can never establish placement for another one
 * accepted in the same turn.
 */
export interface NativeCodexCallbackPlacementEvidence {
  /** The exact acceptance (thread, turn, and submission id) this evidence was gathered for. */
  readonly submission: NativeCodexCallbackSteerAcceptance;
  /** Every location where a user message correlated to `submission.clientUserMessageId` was observed. */
  readonly observedIn: readonly NativeCodexCallbackPlacementObservation[];
  /**
   * The accepted turn's terminal state, when the host saw it end. Only an end
   * whose observation was complete (no gap in the evidence stream) can prove a
   * submission missing.
   */
  readonly acceptedTurnEnded:
    | null
    | {
        readonly status: "completed" | "interrupted" | "failed";
        readonly observationComplete: boolean;
      };
}

export type NativeCodexCallbackPlacement =
  /** Observed exactly once, in exactly the accepted thread and turn. */
  | { readonly verdict: "placed" }
  /** Observed somewhere other than the accepted turn (e.g. carried into a later turn). */
  | { readonly verdict: "mismatch" }
  /** The accepted turn ended under complete observation without it (e.g. dropped on interrupt). */
  | { readonly verdict: "missing"; readonly turnStatus: "completed" | "interrupted" | "failed" }
  | {
      readonly verdict: "uncertain";
      readonly reason:
        | "pending"
        | "observation-incomplete"
        | "duplicate-observation"
        | "evidence-identity-mismatch"
        | "evidence-invalid";
    };

function readAcceptance(value: unknown): NativeCodexCallbackSteerAcceptance | null {
  if (!isRecord(value)) return null;
  const target = readTarget(value);
  const clientUserMessageId = readClientMessageId(value.clientUserMessageId);
  if (target === null || clientUserMessageId === null) return null;
  return { ...target, clientUserMessageId };
}

function sameAcceptance(a: NativeCodexCallbackSteerAcceptance, b: NativeCodexCallbackSteerAcceptance): boolean {
  return sameTarget(a, b) && a.clientUserMessageId === b.clientUserMessageId;
}

/** Pure verdict over one acceptance and caller evidence. Defaults to uncertain. */
export function classifyNativeCodexCallbackPlacement(
  acceptance: NativeCodexCallbackSteerAcceptance,
  evidence: NativeCodexCallbackPlacementEvidence,
): NativeCodexCallbackPlacement {
  const accepted = readAcceptance(acceptance);
  if (accepted === null || !isRecord(evidence) || !Array.isArray(evidence.observedIn)) {
    return { verdict: "uncertain", reason: "evidence-invalid" };
  }
  const submission = readAcceptance(evidence.submission);
  if (submission === null) return { verdict: "uncertain", reason: "evidence-invalid" };
  if (!sameAcceptance(submission, accepted)) return { verdict: "uncertain", reason: "evidence-identity-mismatch" };
  let exact = 0;
  let elsewhere = 0;
  for (const raw of evidence.observedIn as unknown[]) {
    const observation = readAcceptance(raw);
    if (observation === null) return { verdict: "uncertain", reason: "evidence-invalid" };
    // An observation of a different submission is not evidence about this one.
    if (observation.clientUserMessageId !== accepted.clientUserMessageId) {
      return { verdict: "uncertain", reason: "evidence-identity-mismatch" };
    }
    if (sameTarget(observation, accepted)) exact += 1;
    else elsewhere += 1;
  }
  if (elsewhere > 0) return { verdict: "mismatch" };
  if (exact > 1) return { verdict: "uncertain", reason: "duplicate-observation" };
  if (exact === 1) return { verdict: "placed" };
  const ended = evidence.acceptedTurnEnded;
  if (ended === null || ended === undefined) return { verdict: "uncertain", reason: "pending" };
  if (!isRecord(ended) || (ended.status !== "completed" && ended.status !== "interrupted" && ended.status !== "failed")) {
    return { verdict: "uncertain", reason: "evidence-invalid" };
  }
  if (ended.observationComplete !== true) return { verdict: "uncertain", reason: "observation-incomplete" };
  return { verdict: "missing", turnStatus: ended.status };
}
