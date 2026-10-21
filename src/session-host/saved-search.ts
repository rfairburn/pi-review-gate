/**
 * Shared saved-conversation search grammar and matching (issue #463).
 *
 * This module is the single home of the pure text-query helpers the
 * saved-conversation catalog search and the settings deny pickers share. The
 * grammar, scoring, and ordering are UNCHANGED from the previous
 * implementation in src/session-host/saved-sessions.ts: the parser, the
 * matcher, and the fuzzy matcher import are the same code, moved here so a
 * second caller can reuse them without duplicating the semantics. The
 * saved-session caller's behavior is therefore byte-identical.
 *
 * Search parsing and scoring are adapted from Pi 1.1.0's native
 * `session-selector-search.ts` (MIT; attribution in NOTICE and
 * docs/development.md). The selector's threaded/recent UI modes and controls
 * are intentionally not part of this data API.
 *
 * The grammar:
 *
 * - `re:<pattern>` is a case-insensitive regular expression over the whole
 *   searched text. An empty or invalid pattern is a parse error.
 * - Otherwise the query is whitespace-separated fuzzy tokens; a `"quoted
 *   phrase"` is an exact (whitespace-normalized, case-insensitive) phrase.
 *   An unbalanced quote falls back to plain whitespace tokenization.
 * - Every token must match (AND). A fuzzy token uses pi-tui's public
 *   `fuzzyMatch`; a phrase matches on the whitespace-normalized text.
 *
 * Scoring keeps the native meaning: lower is better. A regex or phrase match
 * scores its first-match index times 0.1; a fuzzy token scores pi-tui's
 * fuzzy score. Equal scores keep the caller's incoming order (stable).
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
 * Filter an ordered list of records by one search query.
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
