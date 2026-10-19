import {
  MAX_SESSION_SPAWN_TITLE_BYTES,
  isValidRenameName,
  parseSessionHostPayloadRef,
  type SessionHostPayloadRef,
} from "./protocol";
import {
  SessionHostPayloadError,
  parseSessionHostPayloadDirectoryIdentity as parseDirectoryIdentity,
  readSessionHostPayloadSync,
  stageSessionHostPayload,
  type SessionHostPayloadDirectoryIdentity,
  type SessionHostPayloadFailure,
  type StagedSessionHostPayload,
} from "./payload";

/** One-shot host-to-child initial request reference; the authenticated reporter verifies and consumes its payload. */
export const SESSION_HOST_STARTUP_REQUEST_ENV = "PI_REVIEW_GATE_SESSION_HOST_STARTUP_REQUEST";
/** Advisory title-width snapshot, separate from the reporter's authentication bootstrap. */
export const SESSION_HOST_TITLE_COLUMNS_ENV = "PI_REVIEW_GATE_SESSION_HOST_TITLE_COLUMNS";

const STARTUP_PENDING_KEY = Symbol.for("pi-review-gate.session-host.startup-pending.v1");
const STARTUP_FAILURE_KEY = Symbol.for("pi-review-gate.session-host.startup-failure.v1");
const TITLE_COLUMNS_KEY = Symbol.for("pi-review-gate.session-host.title-columns.v1");
/** The descriptor env itself remains a small bounded JSON frame. */
const MAX_STARTUP_REFERENCE_BYTES = 4096;

/** Deferred private read: primed without IO, verified/consumed after initialization. */
interface PendingStartupPayload {
  readonly payloadDir: string;
  readonly descriptor: SessionHostPayloadRef;
  readonly directoryIdentity: SessionHostPayloadDirectoryIdentity;
}

/** Startup reference additionally carries the producer-observed namespace inode. */
interface StagedStartupRequest extends StagedSessionHostPayload {
  readonly descriptor: SessionHostPayloadRef & {
    readonly directoryIdentity: SessionHostPayloadDirectoryIdentity;
  };
}

/** Test-only process-global hygiene for independent synthetic native children. */
export const __test = Object.freeze({
  clearProcessMetadata(): void {
    const scope = globalThis as Record<PropertyKey, unknown>;
    delete scope[STARTUP_PENDING_KEY];
    delete scope[STARTUP_FAILURE_KEY];
    delete scope[TITLE_COLUMNS_KEY];
  },
});

export interface SessionHostStartupRequest {
  readonly title: string;
  readonly prompt: string;
}

/**
 * Stages the exact startup request JSON in the child registration's private
 * namespace. The caller places only the returned reference in the one-shot
 * environment; the child verifies and consumes it before dispatch.
 */
export function stageSessionHostStartupRequest(
  payloadDir: string,
  request: SessionHostStartupRequest,
): StagedStartupRequest {
  const staged = stageSessionHostPayload(payloadDir, JSON.stringify({ title: request.title, prompt: request.prompt }));
  return {
    ...staged,
    descriptor: { ...staged.descriptor, directoryIdentity: staged.directoryIdentity },
  };
}

export type SessionHostStartupFailureReason =
  | "unauthorized"
  | "payload-unavailable"
  | "payload-verification-failed"
  | "request-invalid";

/** Truthful one-shot consumption result: delivered, absent, or failed with a bounded reason. */
export type SessionHostStartupConsumption =
  | { readonly status: "none" }
  | { readonly status: "ready"; readonly request: SessionHostStartupRequest }
  | { readonly status: "failed"; readonly reason: SessionHostStartupFailureReason };

/**
 * Consume both host-only environment values exactly once, without file IO.
 * The initial request is retained as a bounded private reference only when a
 * valid reporter bootstrap authorized this native child; the payload is
 * verified and consumed later by {@link consumeSessionHostStartupRequest} after
 * normal session/checkpoint initialization. Title width is presentation
 * metadata and never participates in authentication. The env values are
 * deleted synchronously, so descendants never inherit the descriptor.
 */
export function primeSessionHostStartupMetadata(authorized: boolean, payloadDir?: string): void {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const rawRequest = process.env[SESSION_HOST_STARTUP_REQUEST_ENV];
  const rawColumns = process.env[SESSION_HOST_TITLE_COLUMNS_ENV];
  delete process.env[SESSION_HOST_STARTUP_REQUEST_ENV];
  delete process.env[SESSION_HOST_TITLE_COLUMNS_ENV];

  if (!authorized) {
    if (rawRequest !== undefined && scope[STARTUP_FAILURE_KEY] === undefined) {
      scope[STARTUP_FAILURE_KEY] = "unauthorized" satisfies SessionHostStartupFailureReason;
    }
    return;
  }
  if (rawRequest !== undefined && scope[STARTUP_PENDING_KEY] === undefined
    && scope[STARTUP_FAILURE_KEY] === undefined) {
    primeStartupReference(rawRequest, payloadDir, scope);
  }
  if (rawColumns !== undefined && scope[TITLE_COLUMNS_KEY] === undefined) {
    const columns = Number(rawColumns);
    if (Number.isSafeInteger(columns) && columns >= 1 && columns <= 1000) {
      scope[TITLE_COLUMNS_KEY] = columns;
    }
  }
}

function primeStartupReference(
  rawReference: string,
  payloadDir: string | undefined,
  scope: Record<PropertyKey, unknown>,
): void {
  if (Buffer.byteLength(rawReference, "utf8") > MAX_STARTUP_REFERENCE_BYTES) {
    scope[STARTUP_FAILURE_KEY] = "request-invalid" satisfies SessionHostStartupFailureReason;
    return;
  }
  let reference: unknown;
  try {
    reference = JSON.parse(rawReference);
  } catch {
    scope[STARTUP_FAILURE_KEY] = "request-invalid" satisfies SessionHostStartupFailureReason;
    return;
  }
  const descriptor = parseSessionHostPayloadRef(reference);
  const directoryIdentity = parseDirectoryIdentity(
    typeof reference === "object" && reference !== null && !Array.isArray(reference)
      ? (reference as Record<string, unknown>).directoryIdentity
      : undefined,
  );
  if (!descriptor || !directoryIdentity) {
    scope[STARTUP_FAILURE_KEY] = "request-invalid" satisfies SessionHostStartupFailureReason;
    return;
  }
  if (typeof payloadDir !== "string" || payloadDir.length === 0) {
    // No host-owned namespace: withhold long-prompt delivery rather than
    // falling back to an inline prompt.
    scope[STARTUP_FAILURE_KEY] = "payload-unavailable" satisfies SessionHostStartupFailureReason;
    return;
  }
  scope[STARTUP_PENDING_KEY] = { payloadDir, descriptor, directoryIdentity } satisfies PendingStartupPayload;
}

function startupFailureFailureReason(error: unknown): SessionHostStartupFailureReason {
  if (error instanceof SessionHostPayloadError) {
    return payloadFailureReason(error.reason);
  }
  return "payload-unavailable";
}

function payloadFailureReason(reason: SessionHostPayloadFailure): SessionHostStartupFailureReason {
  switch (reason) {
    case "size-mismatch":
    case "digest-mismatch":
    case "not-regular-file":
    case "replaced":
    case "decode-failed":
      return "payload-verification-failed";
    case "invalid-descriptor":
      return "request-invalid";
    case "unsafe-directory":
    case "unavailable":
      return "payload-unavailable";
    default:
      return "payload-unavailable";
  }
}

/** Verify and consume the one-shot startup payload after session initialization. */
export function consumeSessionHostStartupRequest(): SessionHostStartupConsumption {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const pending = scope[STARTUP_PENDING_KEY];
  const failure = scope[STARTUP_FAILURE_KEY];
  delete scope[STARTUP_PENDING_KEY];
  delete scope[STARTUP_FAILURE_KEY];
  if (isPendingStartupPayload(pending)) {
    let text: string;
    try {
      text = readSessionHostPayloadSync(pending.payloadDir, pending.descriptor, pending.directoryIdentity);
    } catch (error) {
      return { status: "failed", reason: startupFailureFailureReason(error) };
    }
    const verified = parseStartupRequest(text);
    if (!verified) return { status: "failed", reason: "request-invalid" };
    return { status: "ready", request: verified };
  }
  if (failure === "unauthorized" || failure === "payload-unavailable"
    || failure === "payload-verification-failed" || failure === "request-invalid") {
    return { status: "failed", reason: failure };
  }
  return { status: "none" };
}

function isPendingStartupPayload(value: unknown): value is PendingStartupPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  return typeof pending.payloadDir === "string" && pending.payloadDir.length > 0
    && parseSessionHostPayloadRef(pending.descriptor) !== undefined
    && parseDirectoryIdentity(pending.directoryIdentity) !== undefined;
}

/** Width snapshot survives extension reloads for this one native child. */
export function getSessionHostTitleColumns(): number | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[TITLE_COLUMNS_KEY];
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1000
    ? value as number
    : undefined;
}

function parseStartupRequest(raw: string): SessionHostStartupRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseStartupRequestValue(parsed);
}

function parseStartupRequestValue(value: unknown): SessionHostStartupRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (keys.length !== 2 || !keys.includes("title") || !keys.includes("prompt")) return undefined;
  if (!isValidRenameName(request.title)
    || Buffer.byteLength(request.title, "utf8") > MAX_SESSION_SPAWN_TITLE_BYTES) return undefined;
  // Exact prompt text is not length-capped; only the unchanged NUL policy applies.
  if (typeof request.prompt !== "string" || request.prompt.length === 0
    || request.prompt.includes("\0")) return undefined;
  return { title: request.title, prompt: request.prompt };
}
