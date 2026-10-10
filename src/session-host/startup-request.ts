import {
  MAX_SESSION_SPAWN_PROMPT_BYTES,
  MAX_SESSION_SPAWN_TITLE_BYTES,
  isValidRenameName,
} from "./protocol";

/** One-shot host-to-child initial request; the authenticated reporter validates and consumes its environment copy. */
export const SESSION_HOST_STARTUP_REQUEST_ENV = "PI_REVIEW_GATE_SESSION_HOST_STARTUP_REQUEST";
/** Advisory title-width snapshot, separate from the reporter's authentication bootstrap. */
export const SESSION_HOST_TITLE_COLUMNS_ENV = "PI_REVIEW_GATE_SESSION_HOST_TITLE_COLUMNS";

const STARTUP_REQUEST_KEY = Symbol.for("pi-review-gate.session-host.startup-request.v1");
const TITLE_COLUMNS_KEY = Symbol.for("pi-review-gate.session-host.title-columns.v1");
const MAX_STARTUP_REQUEST_BYTES = 65_536;

/** Test-only process-global hygiene for independent synthetic native children. */
export const __test = Object.freeze({
  clearProcessMetadata(): void {
    const scope = globalThis as Record<PropertyKey, unknown>;
    delete scope[STARTUP_REQUEST_KEY];
    delete scope[TITLE_COLUMNS_KEY];
  },
});

export interface SessionHostStartupRequest {
  readonly title: string;
  readonly prompt: string;
}

/**
 * Consume both host-only values exactly once. The initial prompt is retained
 * only when a valid reporter bootstrap authorized this native child; title
 * width is presentation metadata and never participates in authentication.
 */
export function primeSessionHostStartupMetadata(authorized: boolean): void {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const rawRequest = process.env[SESSION_HOST_STARTUP_REQUEST_ENV];
  const rawColumns = process.env[SESSION_HOST_TITLE_COLUMNS_ENV];
  delete process.env[SESSION_HOST_STARTUP_REQUEST_ENV];
  delete process.env[SESSION_HOST_TITLE_COLUMNS_ENV];

  if (!authorized) return;
  if (rawRequest !== undefined && scope[STARTUP_REQUEST_KEY] === undefined) {
    const parsed = parseStartupRequest(rawRequest);
    if (parsed) scope[STARTUP_REQUEST_KEY] = parsed;
  }
  if (rawColumns !== undefined && scope[TITLE_COLUMNS_KEY] === undefined) {
    const columns = Number(rawColumns);
    if (Number.isSafeInteger(columns) && columns >= 1 && columns <= 1000) {
      scope[TITLE_COLUMNS_KEY] = columns;
    }
  }
}

/** Take the initial request once, after review-gate session initialization is complete. */
export function consumeSessionHostStartupRequest(): SessionHostStartupRequest | undefined {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const raw = scope[STARTUP_REQUEST_KEY];
  delete scope[STARTUP_REQUEST_KEY];
  return parseStartupRequestValue(raw);
}

/** Width snapshot survives extension reloads for this one native child. */
export function getSessionHostTitleColumns(): number | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[TITLE_COLUMNS_KEY];
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1000
    ? value as number
    : undefined;
}

function parseStartupRequest(raw: string): SessionHostStartupRequest | undefined {
  if (Buffer.byteLength(raw, "utf8") > MAX_STARTUP_REQUEST_BYTES) return undefined;
  try {
    return parseStartupRequestValue(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function parseStartupRequestValue(value: unknown): SessionHostStartupRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (keys.length !== 2 || !keys.includes("title") || !keys.includes("prompt")) return undefined;
  if (!isValidRenameName(request.title)
    || Buffer.byteLength(request.title, "utf8") > MAX_SESSION_SPAWN_TITLE_BYTES) return undefined;
  if (typeof request.prompt !== "string" || request.prompt.length === 0
    || Buffer.byteLength(request.prompt, "utf8") > MAX_SESSION_SPAWN_PROMPT_BYTES
    || request.prompt.includes("\0")) return undefined;
  return { title: request.title, prompt: request.prompt };
}
