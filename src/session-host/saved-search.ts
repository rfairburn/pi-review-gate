/**
 * Shared saved-conversation search grammar and matching (issue #463, Pi 1.5
 * alignment for issue #603).
 *
 * This module is the single home of the pure text-query helpers. The grammar
 * (the parser below) is shared by every caller; the MATCHING is deliberately
 * split into two distinct matchers, because the two surfaces search different
 * things:
 *
 * - {@link matchSavedSearchText} / {@link filterBySavedSearch} match ONE text
 *   per record. The settings deny pickers use it with the tool NAME only, and
 *   they keep Pi-style fuzzy matching over that single text: every token may
 *   match as a scattered subsequence of the name. This intentional
 *   single-text tool-name matcher is deliberately separate from the
 *   saved-catalog matcher.
 * - {@link matchSavedSessionFields} matches a saved conversation FIELD BY
 *   FIELD (name, id, message text, cwd) with Pi 1.5's native tiers. The
 *   saved-conversation catalog uses it, and the two matchers are never
 *   conflated: a session token never matches across a field boundary, ids and
 *   message text match only as exact substrings, and names and working
 *   directories still match fuzzily.
 *
 * The parser is unchanged from the previous implementation in
 * src/session-host/saved-sessions.ts and from Pi 1.5's native
 * `parseSearchQuery`; the grammar, including quoted phrases, `re:` patterns,
 * and the unbalanced-quote fallback, is byte-equivalent to the native one.
 * Search parsing and scoring are adapted from Pi Coding Agent (MIT;
 * attribution in NOTICE and LICENSES/MIT-pi-session-search.txt). The native
 * selector's threaded/recent UI modes, name filter, and controls are
 * intentionally not part of this data API.
 *
 * The grammar:
 *
 * - `re:<pattern>` is a case-insensitive regular expression. An empty or
 *   invalid pattern is a parse error. For saved conversations the pattern is
 *   tested per field, so it never spans a field boundary; for the deny
 *   pickers it is tested against the single searched text.
 * - Otherwise the query is whitespace-separated fuzzy tokens; a `"quoted
 *   phrase"` is an exact (whitespace-normalized, case-insensitive) phrase.
 *   An unbalanced quote falls back to plain whitespace tokenization.
 * - Every token must match (AND). Different tokens may match different
 *   fields; one token or phrase never matches across a field boundary.
 *
 * Scoring keeps the native meaning: lower is better. For saved
 * conversations, a token is scored by the BEST field it matches and the tier
 * dominates the fuzzy score (name literal < other literal < name/cwd fuzzy).
 * For the single-text deny matcher, a regex or phrase scores its first-match
 * index times 0.1 and a fuzzy token scores pi-tui's fuzzy score. Equal scores
 * keep the caller's incoming order (stable).
 *
 * This module is deliberately text-only. It knows nothing about sessions,
 * tools, catalogs, or the UI, and it never touches the filesystem, the
 * network, or any configuration.
 */

import { fuzzyMatch } from "pi-session-host-tui";

/** One parsed query token: a fuzzy token or an exact quoted phrase. */
export interface SavedSearchToken {
  kind: "fuzzy" | "phrase";
  value: string;
}

/** A parsed query: token mode, or regular-expression mode. */
export interface ParsedSavedSearchQuery {
  mode: "tokens" | "regex";
  tokens: SavedSearchToken[];
  regex: RegExp | null;
  error?: string;
}

/** The result of matching one text against one parsed query. */
export interface SavedSearchMatch {
  matches: boolean;
  score: number;
}

/**
 * The private per-field text of one saved conversation, in the shape Pi 1.5's
 * native session matcher reads. Every field is a plain string (an absent name
 * is the empty string, exactly like the native `session.name ?? ""`).
 *
 * This record is private indexed state. It is never a display row, never an
 * IPC/roster/log field, and never persisted: full names and full message text
 * exist only here, keyed to the exact minted catalog row.
 */
export interface SavedSessionSearchFields {
  /** SDK session ID. Matched only as an exact (case-insensitive) substring. */
  readonly id: string;
  /** Persisted session name ("" when the session has no name). */
  readonly name: string;
  /** Complete, non-truncated user/assistant message text. Exact substrings only. */
  readonly messages: string;
  /** Session working directory. Fuzzy-matchable, like the name. */
  readonly cwd: string;
}

/**
 * Parse a search query into its tokens or regular expression. A nonempty
 * query that cannot be parsed (an empty or invalid `re:` pattern) yields an
 * `error`; every other query is usable.
 */
export function parseSavedSearchQuery(query: string): ParsedSavedSearchQuery {
  const trimmed = query.trim();
  if (!trimmed) return { mode: "tokens", tokens: [], regex: null };

  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
    } catch (error) {
      return {
        mode: "regex",
        tokens: [],
        regex: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const tokens: SavedSearchToken[] = [];
  let buffer = "";
  let inQuote = false;
  let hadUnclosedQuote = false;
  const flush = (kind: SavedSearchToken["kind"]): void => {
    const value = buffer.trim();
    buffer = "";
    if (value) tokens.push({ kind, value });
  };

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character === '"') {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }
    if (!inQuote && /\s/.test(character)) {
      flush("fuzzy");
      continue;
    }
    buffer += character;
  }

  if (inQuote) hadUnclosedQuote = true;
  if (hadUnclosedQuote) {
    return {
      mode: "tokens",
      tokens: trimmed.split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
        .map((value) => ({ kind: "fuzzy" as const, value })),
      regex: null,
    };
  }

  flush(inQuote ? "phrase" : "fuzzy");
  return { mode: "tokens", tokens, regex: null };
}

/** Lowercase and collapse whitespace runs so phrases compare literally. */
function normalizeSearchWhitespace(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Match one text against one parsed query. Every token must match; the score
 * is the sum of the per-token scores (lower is better) and is only
 * meaningful when `matches` is true.
 *
 * This is the GENERIC single-text matcher: the whole searched text is one
 * string, so a token may match scattered anywhere in it (and a regex may
 * match across what would be field boundaries in a session record). The
 * settings deny pickers use it with the tool NAME as that text and keep
 * fuzzy tool-name matching; the saved-conversation catalog uses
 * {@link matchSavedSessionFields} instead.
 */
export function matchSavedSearchText(text: string, parsed: ParsedSavedSearchQuery): SavedSearchMatch {
  if (parsed.mode === "regex") {
    if (!parsed.regex) return { matches: false, score: 0 };
    const index = text.search(parsed.regex);
    return index < 0 ? { matches: false, score: 0 } : { matches: true, score: index * 0.1 };
  }
  if (parsed.tokens.length === 0) return { matches: true, score: 0 };

  let totalScore = 0;
  let normalizedText: string | null = null;
  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      normalizedText ??= normalizeSearchWhitespace(text);
      const phrase = normalizeSearchWhitespace(token.value);
      if (!phrase) continue;
      const index = normalizedText.indexOf(phrase);
      if (index < 0) return { matches: false, score: 0 };
      totalScore += index * 0.1;
      continue;
    }
    const match = fuzzyMatch(token.value, text);
    if (!match.matches) return { matches: false, score: 0 };
    totalScore += match.score;
  }
  return { matches: true, score: totalScore };
}

/**
 * Filter an ordered list of records by one search query using the GENERIC
 * single-text matcher.
 *
 * `textOf` supplies the searched text of each record (for the deny pickers:
 * the tool NAME only). An empty or whitespace-only query returns the records
 * unchanged and in their original order. A parse error matches nothing.
 * Otherwise the matching records are ordered by score (lower is better) with
 * the incoming order preserved for equal scores, so the result is stable.
 */
export function filterBySavedSearch<T>(
  records: readonly T[],
  query: string,
  textOf: (record: T) => string,
): T[] {
  if (!Array.isArray(records)) return [];
  if (typeof query !== "string" || query.trim().length === 0) return [...records];
  const parsed = parseSavedSearchQuery(query);
  if (parsed.error) return [];
  const scored: Array<{ record: T; score: number; order: number }> = [];
  records.forEach((record, order) => {
    const match = matchSavedSearchText(textOf(record), parsed);
    if (match.matches) scored.push({ record, score: match.score, order });
  });
  scored.sort((left, right) => (left.score !== right.score ? left.score - right.score : left.order - right.order));
  return scored.map((entry) => entry.record);
}

// ---------------------------------------------------------------------------
// Pi 1.5 native per-field saved-conversation matching
// ---------------------------------------------------------------------------

/** Match tiers, best first. Tiers dominate fuzzy scores. */
const TIER_NAME = 0; // the query text appears in the session name
const TIER_TEXT = 1; // the query text appears in the session id, messages, or cwd
const TIER_FUZZY = 2; // the query characters appear scattered in the name or cwd
const TIER_WEIGHT = 1_000_000;

function tierScore(tier: number, score = 0): number {
  return tier * TIER_WEIGHT + score;
}

/**
 * Lowercased/whitespace-normalized views of one field record. Message text can
 * be megabytes, so it is lowered once per record instead of on every keystroke
 * (the same caching shape the native selector uses).
 */
interface SavedSessionFieldText {
  lowerId?: string;
  lowerName?: string;
  lowerMessages?: string;
  lowerCwd?: string;
  normalizedName?: string;
  normalizedMessages?: string;
  normalizedCwd?: string;
}

const fieldTextCache = new WeakMap<SavedSessionSearchFields, SavedSessionFieldText>();

function fieldText(fields: SavedSessionSearchFields): SavedSessionFieldText {
  let cached = fieldTextCache.get(fields);
  if (cached === undefined) {
    cached = {};
    fieldTextCache.set(fields, cached);
  }
  return cached;
}

function lowerId(fields: SavedSessionSearchFields): string {
  const cached = fieldText(fields);
  cached.lowerId ??= fields.id.toLowerCase();
  return cached.lowerId;
}

function lowerName(fields: SavedSessionSearchFields): string {
  const cached = fieldText(fields);
  cached.lowerName ??= fields.name.toLowerCase();
  return cached.lowerName;
}

function lowerMessages(fields: SavedSessionSearchFields): string {
  const cached = fieldText(fields);
  cached.lowerMessages ??= fields.messages.toLowerCase();
  return cached.lowerMessages;
}

function lowerCwd(fields: SavedSessionSearchFields): string {
  const cached = fieldText(fields);
  cached.lowerCwd ??= fields.cwd.toLowerCase();
  return cached.lowerCwd;
}

function normalizedName(fields: SavedSessionSearchFields): string {
  const cached = fieldText(fields);
  cached.normalizedName ??= normalizeSearchWhitespace(fields.name);
  return cached.normalizedName;
}

function normalizedMessages(fields: SavedSessionSearchFields): string {
  const cached = fieldText(fields);
  cached.normalizedMessages ??= normalizeSearchWhitespace(lowerMessages(fields));
  return cached.normalizedMessages;
}

function normalizedCwd(fields: SavedSessionSearchFields): string {
  const cached = fieldText(fields);
  cached.normalizedCwd ??= normalizeSearchWhitespace(fields.cwd);
  return cached.normalizedCwd;
}

/**
 * Exact (case-insensitive) text match. Messages and ids are only matched
 * exactly: scattered matches in them are noise (the Pi 1.5 `/resume` fix —
 * e.g. `1024` no longer matching inside a session UUID).
 */
function matchLiteralFieldToken(fields: SavedSessionSearchFields, lowerValue: string): number | undefined {
  const name = lowerName(fields);
  if (name.includes(lowerValue)) return tierScore(TIER_NAME, fuzzyMatch(lowerValue, name).score);
  if (lowerId(fields).includes(lowerValue)) return tierScore(TIER_TEXT);
  if (lowerMessages(fields).includes(lowerValue)) return tierScore(TIER_TEXT);
  if (lowerCwd(fields).includes(lowerValue)) return tierScore(TIER_TEXT);
  return undefined;
}

/** A fuzzy token: its literal match first, otherwise scattered in the name or cwd only. */
function matchFuzzyFieldToken(fields: SavedSessionSearchFields, value: string): number | undefined {
  const literal = matchLiteralFieldToken(fields, value.toLowerCase());
  if (literal !== undefined) return literal;
  let best: number | undefined;
  for (const field of [fields.name, fields.cwd]) {
    const match = fuzzyMatch(value, field);
    if (match.matches && (best === undefined || match.score < best)) best = match.score;
  }
  return best === undefined ? undefined : tierScore(TIER_FUZZY, best);
}

/** A quoted phrase: exact, whitespace-normalized, per field. */
function matchPhraseFieldToken(fields: SavedSessionSearchFields, phrase: string): number | undefined {
  const name = normalizedName(fields);
  if (name.includes(phrase)) return tierScore(TIER_NAME, fuzzyMatch(phrase, name).score);
  if (lowerId(fields).includes(phrase)) return tierScore(TIER_TEXT);
  if (normalizedMessages(fields).includes(phrase)) return tierScore(TIER_TEXT);
  if (normalizedCwd(fields).includes(phrase)) return tierScore(TIER_TEXT);
  return undefined;
}

/** A regular expression, tested per field: it never spans a field boundary. */
function matchFieldRegex(fields: SavedSessionSearchFields, regex: RegExp): number | undefined {
  if (fields.name && regex.test(fields.name)) return tierScore(TIER_NAME);
  if (regex.test(fields.id) || regex.test(fields.messages) || regex.test(fields.cwd)) return tierScore(TIER_TEXT);
  return undefined;
}

/**
 * Match one saved conversation against one parsed query with Pi 1.5's native
 * per-field semantics.
 *
 * Each field is matched separately, so a token, phrase, or regular expression
 * never matches across field boundaries; different tokens may match different
 * fields. A token scores its best field's tier, and the tier dominates the
 * fuzzy score, so an exact hit anywhere ranks above a scattered subsequence.
 * Every token must match (AND) and the total score is the sum of the per-token
 * scores (lower is better); it is only meaningful when `matches` is true.
 */
export function matchSavedSessionFields(
  fields: SavedSessionSearchFields,
  parsed: ParsedSavedSearchQuery,
): SavedSearchMatch {
  if (parsed.mode === "regex") {
    if (!parsed.regex) return { matches: false, score: 0 };
    const score = matchFieldRegex(fields, parsed.regex);
    return score === undefined ? { matches: false, score: 0 } : { matches: true, score };
  }
  let totalScore = 0;
  for (const token of parsed.tokens) {
    let score: number | undefined;
    if (token.kind === "phrase") {
      const phrase = normalizeSearchWhitespace(token.value);
      if (!phrase) continue;
      score = matchPhraseFieldToken(fields, phrase);
    } else {
      score = matchFuzzyFieldToken(fields, token.value);
    }
    if (score === undefined) return { matches: false, score: 0 };
    totalScore += score;
  }
  return { matches: true, score: totalScore };
}
