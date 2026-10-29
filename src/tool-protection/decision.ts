/**
 * Shared model-neutral decision format for the pre-execution tool-protection
 * gate (issue #536).
 *
 * One proposal produces one machine-readable verdict: `PASS` or `FAIL`, with an
 * optional reason. The reason is optional in the shared format so that a
 * decision-only binary or classification model can answer validly without
 * producing prose, while a full LLM auditor is prompted for a reason. A supplied
 * reason is preserved verbatim and a missing one is never filled in: an absent
 * reason stays absent, and any "no reason supplied" wording is host status text
 * produced by the caller, never fabricated auditor reasoning.
 *
 * Parsing is strict and throws on anything ambiguous, because the caller maps a
 * throw to the fail-closed path (the proposed tool callback does not run). No
 * retry, fallback auditor, cache, or truthy-string coercion lives here.
 */

import { isRecord } from "../record-guard";

/** Verdict values in the shared format. Exact, case-sensitive, no coercion. */
export const PROTECTION_DECISION_VALUES = ["PASS", "FAIL"] as const;
export type ProtectionDecisionValue = (typeof PROTECTION_DECISION_VALUES)[number];

/**
 * Upper bound on a supplied reason. An oversized payload is rejected as
 * malformed rather than silently truncated, so a justification is never cut off
 * while still being presented as the auditor's complete statement.
 */
export const PROTECTION_DECISION_MAX_REASON_CHARS = 4_000;

export interface ProtectionDecision {
  decision: ProtectionDecisionValue;
  /** Present when the auditor supplied a string, preserved verbatim; never synthesized. */
  reason?: string;
}

/**
 * Parse one decision object from an auditor response.
 *
 * Accepted: one JSON object, optionally wrapped in a single fenced code block
 * (the fenced form must be the whole payload, and the fence language, when
 * present, must be `json`), surrounded only by whitespace and an optional byte
 * order mark.
 *
 * Accepted shapes:
 * - `{"decision":"PASS","reason":"..."}` and `{"decision":"FAIL","reason":"..."}`
 * - `{"decision":"PASS"}` and `{"decision":"FAIL"}` — a valid reasonless decision
 * - `"reason"` omitted entirely — a valid reasonless decision; nothing is
 * supplied, so nothing is displayed as auditor reasoning
 *
 * An empty or whitespace-only string reason is preserved verbatim: it was
 * supplied, and only an absent field counts as omission.
 *
 * Rejected (all fail closed): empty or non-object payloads, surrounding prose,
 * more than one JSON value, duplicate top-level fields (including JSON-escaped
 * spellings such as `\u0064ecision`), any field other than `decision`/`reason`
 * (an unexpected envelope is a different contract, not a subset of this one),
 * lowercase or alternative verdict words, a `null` or otherwise non-string
 * reason, and oversized reasons.
 *
 * @throws {Error} when the text is not exactly one valid decision object.
 */
export function parseProtectionDecision(text: string): ProtectionDecision {
  if (typeof text !== "string") {
    throw new Error("tool protection decision must be read from a string payload");
  }
  const unwrapped = stripSingleJsonFence(text.replace(/^\uFEFF/, ""));
  if (unwrapped.trim().length === 0) {
    throw new Error("tool protection decision payload is empty");
  }
  // Duplicate keys must be detected before JSON.parse silently keeps the last
  // one, and the scan has to decode escapes: {"decision":"FAIL",
  // "\u0064ecision":"PASS"} is a contradictory payload, not a PASS.
  const keys = scanTopLevelKeys(unwrapped);
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped) as unknown;
  } catch {
    throw new Error("tool protection decision must be exactly one JSON object with no surrounding prose");
  }
  if (!isRecord(parsed)) {
    throw new Error("tool protection decision must be a JSON object");
  }
  if (!keys.ok) {
    throw new Error("tool protection decision payload could not be checked for duplicate fields");
  }
  const duplicate = keys.keys.filter((field, index) => keys.keys.indexOf(field) !== index)[0];
  if (duplicate !== undefined) {
    throw new Error(`tool protection decision payload states field "${duplicate}" more than once`);
  }
  for (const field of Object.keys(parsed)) {
    if (field !== "decision" && field !== "reason") {
      throw new Error(`tool protection decision has unsupported field "${field}"`);
    }
  }
  const decision = parsed.decision;
  if (decision !== "PASS" && decision !== "FAIL") {
    throw new Error(`tool protection decision must be exactly "PASS" or "FAIL"`);
  }
  const reason = parsed.reason;
  if (reason === undefined) {
    return { decision };
  }
  if (typeof reason !== "string") {
    throw new Error("tool protection decision reason must be a string when present");
  }
  if (reason.length > PROTECTION_DECISION_MAX_REASON_CHARS) {
    throw new Error(`tool protection decision reason exceeds ${PROTECTION_DECISION_MAX_REASON_CHARS} characters`);
  }
  // The supplied reason is preserved byte-for-byte, including empty or padded
  // strings: only an absent field is an omission.
  return { decision, reason };
}

/**
 * Remove one complete fenced code block wrapper. A fence that does not span the
 * whole payload, or that declares a language other than `json`, is returned
 * unchanged so the parse below reports the real problem instead of guessing
 * which part of a mixed payload was meant to be the decision.
 */
function stripSingleJsonFence(text: string): string {
  const match = /^\s*```[ \t]*([A-Za-z0-9+!-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*\s*$/.exec(text);
  if (!match) return text;
  const language = (match[1] ?? "").toLowerCase();
  if (language.length > 0 && language !== "json") return text;
  return match[2] ?? "";
}

type TopLevelKeyScan = { ok: true; keys: string[] } | { ok: false };

/**
 * Decode the top-level property names of one JSON object in source order,
 * before `JSON.parse` collapses duplicate keys to its last value. A scan that
 * cannot tokenize the text reports `ok: false`; the caller then fails closed
 * rather than trusting a payload whose field set it cannot enumerate.
 */
function scanTopLevelKeys(text: string): TopLevelKeyScan {
  const keys: string[] = [];
  let at = skipJsonWhitespace(text, 0);
  if (text[at] !== "{") return { ok: false };
  at += 1;
  at = skipJsonWhitespace(text, at);
  if (text[at] === "}") {
    at += 1;
    return skipJsonWhitespace(text, at) === text.length ? { ok: true, keys } : { ok: false };
  }
  for (;;) {
    at = skipJsonWhitespace(text, at);
    const key = readJsonString(text, at);
    if (!key) return { ok: false };
    keys.push(key.value);
    at = skipJsonWhitespace(text, key.next);
    if (text[at] !== ":") return { ok: false };
    at = skipJsonWhitespace(text, at + 1);
    const value = skipJsonValue(text, at);
    if (value < 0) return { ok: false };
    at = skipJsonWhitespace(text, value);
    if (text[at] === ",") {
      at += 1;
      continue;
    }
    if (text[at] === "}") {
      at += 1;
      break;
    }
    return { ok: false };
  }
  return skipJsonWhitespace(text, at) === text.length ? { ok: true, keys } : { ok: false };
}

function skipJsonWhitespace(text: string, start: number): number {
  let at = start;
  while (at < text.length && /[ \t\n\r]/.test(text[at]!)) at += 1;
  return at;
}

/** Read one JSON string with escape decoding, so aliased spellings collide. */
function readJsonString(text: string, start: number): { value: string; next: number } | undefined {
  if (text[start] !== '"') return undefined;
  let value = "";
  let at = start + 1;
  while (at < text.length) {
    const char = text[at]!;
    if (char === '"') return { value, next: at + 1 };
    if (char !== "\\") {
      value += char;
      at += 1;
      continue;
    }
    const escaped = text[at + 1];
    if (escaped === "u") {
      const hex = text.slice(at + 2, at + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      value += String.fromCharCode(parseInt(hex, 16));
      at += 6;
      continue;
    }
    if (escaped === undefined) return undefined;
    const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    const decoded = simple[escaped];
    if (decoded === undefined) return undefined;
    value += decoded;
    at += 2;
  }
  return undefined;
}

/** Index just past one JSON value, or -1 when the text is not scannable. */
function skipJsonValue(text: string, start: number): number {
  const char = text[start];
  if (char === undefined) return -1;
  if (char === '"') {
    const read = readJsonString(text, start);
    return read ? read.next : -1;
  }
  if (char === "{" || char === "[") {
    const closing = char === "{" ? "}" : "]";
    let at = start + 1;
    let inString = false;
    while (at < text.length) {
      const current = text[at]!;
      if (inString) {
        if (current === "\\") at += 1;
        else if (current === '"') inString = false;
      } else if (current === '"') {
        inString = true;
      } else if (current === "{" || current === "[") {
        const nested = skipJsonValue(text, at);
        if (nested < 0) return -1;
        at = nested - 1;
      } else if (current === closing) {
        return at + 1;
      }
      at += 1;
    }
    return -1;
  }
  if (text.startsWith("true", start)) return start + 4;
  if (text.startsWith("false", start)) return start + 5;
  if (text.startsWith("null", start)) return start + 4;
  const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(text.slice(start));
  return number ? start + number[0].length : -1;
}
