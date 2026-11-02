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
import { extractJsonCandidates } from "../schema";

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
 * Parse one decision from an auditor response.
 *
 * The response may contain a single decision object, or decision objects embedded
 * in surrounding commentary or JSON code fences. Candidate discovery is shared
 * with the review-result parser: the complete response, JSON fences, then balanced
 * JSON objects, in source order with exact-text deduplication. Unrelated prose and
 * metadata objects are skipped. Every discovered decision-bearing candidate must
 * pass the strict validation below, so a malformed decision object beside a valid
 * one makes the whole reply malformed. Contradictory `PASS` and `FAIL` decisions
 * are malformed too; agreeing decisions keep the extractor's first-candidate order.
 *
  * One structure-anchored safety pass then reads every top-level `{`/`[` container in
 * the reply, restarting string state at that container, because commentary can carry an
 * unmatched quote and the shared extractor tracks one string state across the whole
 * reply. That pass only refuses; it never supplies, re-ranks, or reconstructs a
 * decision. It rejects decision-shaped text that is not an accepted decision envelope:
 * a decision inside an array or inside a fenced block declaring another language, a
 * dangling `"decision": …` fragment between containers, a container that is not one
 * complete JSON value, or a complete decision envelope the shared extraction never
 * surfaced. A decoded `decision` name counts only in a key position: before a colon,
 * or — inside an object-shaped container that is not one complete JSON value — anywhere
 * that is neither a field value nor an element in a sequence. A string named `decision`
 * in an array or as a value, and a quoted `decision` word with no colon, is data.
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
 * Rejected (all fail closed): empty or non-object payloads, more than one
 * contradictory decision, duplicate top-level fields (including JSON-escaped
 * spellings such as `\u0064ecision`), any field other than `decision`/`reason`
 * on a decision object, lowercase or alternative verdict words, a `null` or
 * otherwise non-string reason, and oversized reasons. Malformed JSON is never
 * repaired into a decision.
 *
 * @throws {Error} when the text does not yield one unambiguous valid decision.
 */
export function parseProtectionDecision(text: string): ProtectionDecision {
  if (typeof text !== "string") {
    throw new Error("tool protection decision must be read from a string payload");
  }
  const payload = text.replace(/^\uFEFF/, "");
  if (payload.trim().length === 0) {
    throw new Error("tool protection decision payload is empty");
  }
  // One structure-anchored safety pass over the reply. It refuses decision-shaped
  // text that sits in an unaccepted envelope; it never contributes a decision.
  const regions = scanContainerRegions(payload);
  rejectDecisionOutsideEnvelope(payload, regions);
  rejectDanglingDecisionKeys(payload, regions);

  const decisions: ProtectionDecision[] = [];
  const validatedSpans: Array<{ start: number; end: number }> = [];

  // Decision parsing disables the review parser's control-character repair: an
  // embedded candidate must itself be valid JSON, never a repaired variant. These
  // candidates are the only source of a decision, in the extractor's own order.
  for (const candidate of extractJsonCandidates(payload, { repair: false })) {
    if (candidate.repaired) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.value) as unknown;
    } catch {
      // The region scan above already refused every malformed decision-shaped
      // container, so an unparseable candidate here carries no decision at all;
      // it is not a source of one and is not skipped in favour of a later object.
      continue;
    }
    if (!isRecord(parsed)) {
      // Do not mine a decision out of a non-object envelope. A complete response
      // that is not an object stays an invalid envelope.
      if (candidate.whole) {
        throw new Error("tool protection decision must be a JSON object");
      }
      continue;
    }
    const keys = scanTopLevelKeys(candidate.value);
    if (!keys.ok) {
      throw new Error("tool protection decision payload could not be checked for duplicate fields");
    }
    if (!keys.keys.includes("decision") && !candidate.whole) {
      // An unrelated metadata object may be skipped, but a complete response that
      // is not a decision object stays an invalid envelope.
      continue;
    }
    decisions.push(validateDecisionObject(parsed, keys.keys));
    accountValidatedCandidate(payload, candidate.value, validatedSpans);
  }

  // Every decision envelope present in the reply must be one the shared extractor
  // produced and validated. An envelope the extractor never surfaced — for example
  // after an unmatched quote in commentary — is never reconstructed into an approval
  // or a rejection on its own; the reply simply fails closed.
  for (const region of regions) {
    if (!region.envelope) continue;
    if (validatedSpans.some((span) => region.start >= span.start && region.start < span.end)) continue;
    throw new Error("tool protection decision must be exactly one JSON object with no surrounding prose");
  }

  if (decisions.length === 0) {
    throw new Error("tool protection decision must be exactly one JSON object with no surrounding prose");
  }
  const hasPass = decisions.some((decision) => decision.decision === "PASS");
  const hasFail = decisions.some((decision) => decision.decision === "FAIL");
  if (hasPass && hasFail) {
    throw new Error("tool protection decision payload contains contradictory PASS and FAIL objects");
  }
  return decisions[0]!;
}

function validateDecisionObject(parsed: Record<string, unknown>, keys: string[]): ProtectionDecision {
  const duplicate = keys.filter((field, index) => keys.indexOf(field) !== index)[0];
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

/** One top-level `{`/`[` container of the reply, as read by `scanContainerRegions`. */
interface ContainerRegion {
  kind: "{" | "[";
  /** Index of the opening bracket in the reply. */
  start: number;
  /** Exclusive: past the closing bracket, or the end of the reply when it never closes. */
  end: number;
  /** The container closed and its text is exactly one JSON value. */
  complete: boolean;
  /** The region is a complete JSON object with a top-level `decision` field. */
  envelope: boolean;
  /** A decoded `decision` property name appears in a key position inside the region. */
  decisionBearing: boolean;
  /** That key sits inside an array nested in the region, never in a decision envelope. */
  decisionInArray: boolean;
}

/**
 * Read every top-level `{`/`[` container in the reply for the fail-closed envelope
 * check. String state restarts at each container, so unmatched quotes in surrounding
 * commentary cannot hide what a container holds; the shared extractor tracks one string
 * state across the whole reply and cannot be the authority on malformed envelopes. An
 * unterminated container runs to the end of the reply: text after a broken envelope
 * belongs to that envelope and is never a nested decision to mine.
 */
function scanContainerRegions(payload: string): ContainerRegion[] {
  const regions: ContainerRegion[] = [];
  let coveredUntil = 0;
  for (let start = 0; start < payload.length; start += 1) {
    const kind = payload[start];
    if (kind !== "{" && kind !== "[") continue;
    if (start < coveredUntil) continue;
    const closed = matchContainerEnd(payload, start);
    const end = closed < 0 ? payload.length : closed;
    coveredUntil = end;
    const text = payload.slice(start, end);
    const decision = scanDecisionKeys(payload, start, end, kind);
    const parsed = closed >= 0 ? tryParseJsonValue(text) : undefined;
    const parsedObject = parsed !== undefined && isRecord(parsed) ? parsed : undefined;
    const keys = parsedObject === undefined ? undefined : scanTopLevelKeys(text);
    regions.push({
      kind,
      start,
      end,
      complete: parsed !== undefined,
      envelope: keys?.ok === true && keys.keys.includes("decision"),
      decisionBearing: decision.found,
      decisionInArray: decision.inArray,
    });
  }
  return regions;
}

/**
 * Refuse decision-shaped text that is not an accepted decision envelope, so a later
 * valid object cannot rescue it: a decision inside a fenced block that declares
 * another language, a decision inside an array (which is never a decision envelope
 * and whose nested object is never mined), or decision-shaped text in a container
 * that is not one complete JSON value. `rejectDanglingDecisionKeys` applies the same
 * rule to decision-shaped text between containers.
 */
function rejectDecisionOutsideEnvelope(payload: string, regions: ContainerRegion[]): void {
  const foreignFences = foreignLanguageFenceRanges(payload);
  for (const region of regions) {
    if (!region.decisionBearing) continue;
    if (foreignFences.some((range) => region.start >= range.start && region.start < range.end)) {
      throw new Error("tool protection decision must be exactly one JSON object with no surrounding prose");
    }
    if (region.kind === "[" || region.decisionInArray) {
      throw new Error("tool protection decision must be a JSON object");
    }
    if (!region.complete) {
      throw new Error("tool protection decision must be exactly one JSON object with no surrounding prose");
    }
  }
}

/** Bodies of fenced blocks that declare a language other than `json` or no language. */
function foreignLanguageFenceRanges(payload: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const fencePattern = /```[ \t]*([A-Za-z0-9+!-]*)[ \t]*(?:\r?\n)?([\s\S]*?)```/g;
  for (const match of payload.matchAll(fencePattern)) {
    const language = (match[1] ?? "").toLowerCase();
    const body = match[2] ?? "";
    if (language.length === 0 || language === "json" || body.length === 0) continue;
    // `match[0]` ends with the three-backtick closing fence, which is not part of
    // the body a decision may appear in.
    const bodyEnd = (match.index ?? 0) + match[0].length - 3;
    ranges.push({ start: bodyEnd - body.length, end: bodyEnd });
  }
  return ranges;
}

/**
 * Scan one region for decoded `decision` property names in a key position.
 * `found` is true when one appears anywhere in the region; `inArray` is true when it
 * appears inside an array nested in the region. The structural walk tracks strings and
 * containers from the region start, so a string named `decision` in an array or after
 * a colon is data and never a key, while a key with a missing colon inside an object
 * (`{"decision" "FAIL"}`) still counts. A second quote-independent pass recognizes
 * keys whose quotes were shifted by an unterminated string inside the same region,
 * which is how `{"reason":"unterminated\n"decision":"FAIL"}` and
 * `{"reason":"unterminated\n,"decision" "FAIL"}` still read as broken.
 */
function scanDecisionKeys(
  payload: string,
  start: number,
  end: number,
  root: "{" | "[",
): { found: boolean; inArray: boolean } {
  const containers: Array<"{" | "["> = [];
  let found = false;
  for (let at = start; at < end; at += 1) {
    const char = payload[at];
    if (char === '"') {
      const read = readJsonString(payload, at);
      if (!read) continue;
      if (read.value === "decision" && isDecisionKeyPosition(payload, at, read.next, containers)) {
        if (containers.slice(1).includes("[")) return { found: true, inArray: true };
        found = true;
      }
      at = Math.min(read.next, end) - 1;
      continue;
    }
    if (char === "{" || char === "[") {
      containers.push(char);
    } else if (char === "}" && containers[containers.length - 1] === "{") {
      containers.pop();
    } else if (char === "]" && containers[containers.length - 1] === "[") {
      containers.pop();
    }
  }
  if (found) return { found: true, inArray: false };
  // Quote-independent recovery: an unterminated string inside the region shifts the
  // quote parity, so the structural walk above never decodes the key at all.
  for (let at = start; at < end; at += 1) {
    if (payload[at] !== '"') continue;
    const read = readJsonString(payload, at);
    if (read?.value !== "decision") continue;
    const next = payload[skipJsonWhitespace(payload, read.next)];
    if (next === ":") return { found: true, inArray: false };
    if (root !== "{") continue;
    // Inside a broken object, a quoted `decision` is a decision key with broken
    // syntax (`{"decision" "FAIL"}`, `{"decision"}`, or one whose quotes were shifted
    // by an earlier unterminated string) unless it is plainly the value of another
    // field (a colon before it) or an element in a sequence (`,` or `]` after it).
    if (previousNonWhitespace(payload, at) === ":") continue;
    if (next === "]" || next === ",") continue;
    return { found: true, inArray: false };
  }
  return { found: false, inArray: false };
}

function isDecisionKeyPosition(
  payload: string,
  nameStart: number,
  afterName: number,
  containers: Array<"{" | "[">,
): boolean {
  if (payload[skipJsonWhitespace(payload, afterName)] === ":") return true;
  const previous = previousNonWhitespace(payload, nameStart);
  return containers[containers.length - 1] === "{" && (previous === "{" || previous === ",");
}

/** Index just past the bracket closing the container at `start`, or -1 when it never closes. */
function matchContainerEnd(text: string, start: number): number {
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"') {
      const read = readJsonString(text, at);
      if (!read) return -1;
      at = read.next - 1;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return at + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function tryParseJsonValue(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a decoded `decision` property name in a key position that sits outside every
 * container of the reply — a dangling `{"decision": …`-shaped fragment in commentary,
 * or one inside a fence that declares another language. Such text is never a decision
 * and is never mined for one, but it must not be waved past a valid decision either.
 * A quoted `decision` with no colon stays commentary, so ordinary prose and unrelated
 * metadata wording are unaffected.
 */
function rejectDanglingDecisionKeys(payload: string, regions: ContainerRegion[]): void {
  let cursor = 0;
  for (const region of regions) {
    rejectDanglingDecisionKey(payload, cursor, region.start);
    cursor = Math.max(cursor, region.end);
  }
  rejectDanglingDecisionKey(payload, cursor, payload.length);
}

function rejectDanglingDecisionKey(payload: string, start: number, end: number): void {
  // Commentary quotes are not reliable boundaries: an unmatched quote would consume
  // the opening quote of a later key, so every quote position is inspected on its own.
  for (let at = start; at < end; at += 1) {
    if (payload[at] !== '"') continue;
    const read = readJsonString(payload, at);
    if (!read) continue;
    if (read.value === "decision" && payload[skipJsonWhitespace(payload, read.next)] === ":") {
      throw new Error("tool protection decision must be exactly one JSON object with no surrounding prose");
    }
  }
}

/** Every occurrence of a validated candidate text, including repeats. */
function accountValidatedCandidate(payload: string, candidate: string, spans: Array<{ start: number; end: number }>): void {
  let from = 0;
  while (from <= payload.length - candidate.length) {
    const at = payload.indexOf(candidate, from);
    if (at < 0) return;
    spans.push({ start: at, end: at + candidate.length });
    from = at + candidate.length;
  }
}

function previousNonWhitespace(text: string, start: number): string | undefined {
  let at = start - 1;
  while (at >= 0 && /[ \t\n\r]/.test(text[at]!)) at -= 1;
  return text[at];
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
