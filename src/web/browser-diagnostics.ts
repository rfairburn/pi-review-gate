import { redactSensitiveText } from "../redaction.js";
import { bounded } from "./browser-primitives.js";

/**
 * Bounded, memory-only diagnostic capture for the interactive browser
 * (issue #153): the shared session quota, the per-tab ring with a
 * never-reused cursor, and the fixed-token formatters that turn
 * page-controlled values into safe diagnostic fields. Nothing here retains
 * raw bodies or headers; every value is bounded and classified against
 * fixed allowlists before it can be reported.
 */

export type DiagnosticEvent = { sequence: number; textTruncated?: boolean };

/** Shared capture quota: tabs cannot multiply the session retention allowance. */
export class BrowserDiagnosticQuota {
  private retained: { owner: object; bytes: number; evict: () => void }[] = [];
  private bytes = 0;

  constructor(readonly capacity = 256, readonly maxBytes = 1024 * 1024) {}

  retain(owner: object, bytes: number, evict: () => void): void {
    this.retained.push({ owner, bytes, evict });
    this.bytes += bytes;
    while (this.retained.length > this.capacity || this.bytes > this.maxBytes) {
      const oldest = this.retained.shift()!;
      this.bytes -= oldest.bytes;
      oldest.evict();
    }
  }

  release(owner: object): void {
    this.retained = this.retained.filter((entry) => {
      if (entry.owner !== owner) return true;
      this.bytes -= entry.bytes;
      return false;
    });
  }
}

/** A capture-time-bounded, memory-only ring with a never-reused tab-local cursor. */
export class DiagnosticRing<T extends DiagnosticEvent> {
  private events: T[] = [];
  private nextSequence = 1;
  private dropped = 0;
  private captureTruncated = 0;

  constructor(readonly capacity: number, private readonly quota = new BrowserDiagnosticQuota(capacity)) {}

  push(event: Omit<T, "sequence">): void {
    const captured = { ...event, sequence: this.nextSequence++ } as T;
    if (captured.textTruncated) this.captureTruncated += 1;
    if (this.events.length >= this.capacity) {
      const oldest = this.events.shift()!;
      this.quota.release(oldest);
      this.dropped += 1;
    }
    this.events.push(captured);
    // Count the UTF-8 serialized safe capture, including metadata, not raw page
    // strings or UTF-16 code units. No bodies/headers are captured here.
    this.quota.retain(captured, Buffer.byteLength(JSON.stringify(captured), "utf8"), () => {
      const index = this.events.indexOf(captured);
      if (index >= 0) {
        this.events.splice(index, 1);
        this.dropped += 1;
      }
    });
  }

  read(after: number, maximum: number): {
    events: T[];
    requested: number;
    next: number;
    latest: number;
    oldestRetained: number;
    dropped: number;
    totalDropped: number;
    truncated: number;
    captureTruncated: number;
    totalCaptureTruncated: number;
  } {
    const latest = this.nextSequence - 1;
    if (!Number.isSafeInteger(after) || after < 0 || after > latest) {
      throw new Error(`Browser diagnostic cursor must be an integer from 0 through ${latest}.`);
    }
    const oldestRetained = this.events[0]?.sequence ?? this.nextSequence;
    const dropped = Math.max(0, oldestRetained - 1 - after);
    const eligible = this.events.filter((event) => event.sequence > after);
    const events = eligible.slice(0, maximum).map((event) => ({ ...event }));
    const next = events.at(-1)?.sequence ?? Math.max(after, oldestRetained - 1);
    return {
      events,
      requested: after,
      next,
      latest,
      oldestRetained,
      dropped,
      totalDropped: this.dropped,
      truncated: eligible.length - events.length,
      captureTruncated: events.filter((event) => event.textTruncated).length,
      totalCaptureTruncated: this.captureTruncated,
    };
  }

  clear(): void {
    for (const event of this.events) this.quota.release(event);
    this.events = [];
    this.nextSequence = 1;
    this.dropped = 0;
    this.captureTruncated = 0;
  }
}

export function boundedUntrustedText(raw: unknown, maxChars: number): { value: string; truncated: boolean } {
  const original = typeof raw === "string" ? raw : String(raw ?? "");
  // Strip terminal/control framing and bidi overrides before generic secret
  // redaction. The returned string is page-controlled evidence, never markup.
  const captured = original.slice(0, maxChars);
  const structural = captured
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "");
  const redacted = redactSensitiveText(structural);
  return {
    value: redacted.slice(0, maxChars),
    truncated: original.length > maxChars || redacted.length > maxChars,
  };
}

/** Console level classification; must stay equal to BrowserConsoleEvent["level"]. */
export type BrowserConsoleLevel = "debug" | "info" | "log" | "warning" | "error" | "other";

export function consoleLevel(raw: string): BrowserConsoleLevel {
  const normalized = raw.toLocaleLowerCase("en-US");
  if (normalized === "debug" || normalized === "info" || normalized === "log" || normalized === "error") return normalized;
  if (normalized === "warning" || normalized === "warn") return "warning";
  return "other";
}

export function diagnosticElapsed(now: number, createdAt: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(now - createdAt)));
}

export function boundedNonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
    : 0;
}

export function boundedHttpStatus(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 999 ? value : 0;
}

export function diagnosticMethod(raw: string): string {
  const upper = raw.toLocaleUpperCase("en-US");
  return /^[A-Z]{1,16}$/.test(upper) ? upper : "OTHER";
}

export function diagnosticResourceKind(raw: string): string {
  const normalized = raw.toLocaleLowerCase("en-US");
  const allowed = new Set([
    "document", "stylesheet", "script", "xhr", "fetch", "image", "font", "media",
    "websocket", "eventsource", "manifest", "texttrack", "other",
  ]);
  return allowed.has(normalized) ? normalized : "other";
}

export function diagnosticNetworkFailure(raw: string): string {
  // Browser failure strings occasionally embed the complete request URL.
  // Retain only Chromium's fixed error token, never free-form failure text.
  const code = /\b(?:net::)?ERR_[A-Z0-9_]{1,64}\b/u.exec(raw)?.[0];
  return code ? code.slice(0, 64) : "request_failed";
}

export function diagnosticOrigin(rawUrl: string, maxChars: number): string {
  const origin = diagnosticPublicOrigin(rawUrl);
  return bounded(origin ?? "[non-public or redacted origin]", maxChars);
}

export function diagnosticPublicOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return bounded(parsed.origin, 300);
  } catch {
    return null;
  }
}

/** Bounded origin for WebSocket diagnostics: scheme+host+port only. */
export function diagnosticWsOrigin(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return "[non-public or redacted origin]";
    return bounded(parsed.origin, 300);
  } catch {
    return "[non-public or redacted origin]";
  }
}

export function boundedWsCloseCode(code: unknown): number | undefined {
  return typeof code === "number" && Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : undefined;
}

/** Close reasons are page-channel data; bound them before they re-enter a route. */
export function boundedWsCloseReason(reason: unknown): string | undefined {
  return typeof reason === "string" && reason.length > 0 ? reason.slice(0, 123) : undefined;
}
