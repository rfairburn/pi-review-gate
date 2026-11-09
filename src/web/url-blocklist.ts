/**
 * Shared URL blocklist for the acquisition tools (issue #620).
 *
 * One configurable list (`web.urlBlocklist`) is compiled once and consulted by
 * both `WebFetch` and `BrowserExtract` with identical semantics: each entry is
 * an ordinary JavaScript regular-expression SOURCE — no `/.../` delimiters and
 * no flags — tested with `RegExp.prototype.test`, which searches anywhere in
 * the URL. Nothing is implicitly anchored, so `aliyuncs` matches
 * `https://bucket.example.aliyuncs.com/object` while `^https://x\.test/` only
 * matches at the start. Surrounding whitespace is trimmed from every configured
 * entry before compilation (a space meant literally is written as `[ ]` or
 * `\x20`), and the trimmed source is matched with ordinary regex semantics and
 * no other transformation.
 *
 * What is judged is always the COMPLETE URL of one navigation: the URL exactly
 * as supplied, or the complete destination a redirect `Location` forms — a
 * relative `Location` resolved against the URL being redirected from, joined
 * with that navigation's fragment when the `Location` names none. There is
 * deliberately no second look at a fragmentless or otherwise normalized form —
 * regex rules are the whole contract, and no attempt is made to guess around
 * what a configured entry means. So `/object$` does NOT match
 * `https://fixture.test/object#top`, `#top$` does, and unanchored `/object`
 * matches both.
 *
 * This is a deliberately weak convenience guard against unwanted or
 * hallucinated requests. It is not a security boundary: shell commands,
 * codemode, and any other direct networking path are outside it by design.
 */

/** Where a URL entered an acquisition: the supplied URL or a later hop. */
export type UrlAccessStage = "initial" | "redirect";

/**
 * Thrown when a URL matches a configured entry. Callers must treat this as a
 * primary denied outcome — never a successful/partial extraction and never a
 * generic fetch failure with recovery advice.
 */
export class UrlBlocklistDeniedError extends Error {
  constructor(
    readonly deniedUrl: string,
    readonly pattern: string,
    readonly stage: UrlAccessStage,
  ) {
    super(
      `URL denied by the configured web.urlBlocklist: the pattern "${pattern}" matched the `
      + `${stage === "redirect" ? "redirect destination" : "requested URL"} ${deniedUrl}. `
      + "The denied destination was not requested.",
    );
    this.name = "UrlBlocklistDeniedError";
  }
}

/**
 * A guard callback consulted before each acquisition URL is used. It throws
 * {@link UrlBlocklistDeniedError} for a denied URL and returns normally for an
 * allowed one. Enforcement calls it exactly once per navigation with that
 * navigation's complete URL — the supplied URL, or a redirect destination
 * carrying a fragment only when its `Location` names one or the chain already
 * carries one — and never with a normalized or fragmentless derivative of it.
 * It is acquisition-only: interactive browser navigation never receives it.
 */
export type UrlGuard = (url: string, stage: UrlAccessStage) => void;

/** One compiled entry: the configured source plus its compiled expression. */
interface CompiledPattern {
  readonly source: string;
  readonly expression: RegExp;
}

/** One compiled `web.urlBlocklist`, shared by every acquisition route. */
export interface UrlBlocklist {
  /** The configured sources, in configuration order. */
  readonly sources: readonly string[];
  /** True when no entry is configured, so nothing is denied. */
  readonly empty: boolean;
  /** The matching configured source, or `undefined` when the URL is allowed. */
  match(url: string): string | undefined;
  /** Throws {@link UrlBlocklistDeniedError} when any entry matches `url`. */
  assertAllowed(url: string, stage: UrlAccessStage): void;
}

/** The shared no-op blocklist: an empty list denies nothing. */
export const EMPTY_URL_BLOCKLIST: UrlBlocklist = Object.freeze({
  sources: Object.freeze([]) as readonly string[],
  empty: true,
  match(): string | undefined {
    return undefined;
  },
  assertAllowed(): void {
    // An empty blocklist denies nothing.
  },
});

/**
 * Compiles the configured sources into one shared blocklist. Sources are
 * already validated by `normalizeConfig`; compilation still fails closed
 * rather than dropping an entry it cannot honor.
 */
export function compileUrlBlocklist(sources: readonly string[]): UrlBlocklist {
  if (sources.length === 0) return EMPTY_URL_BLOCKLIST;
  const compiled: CompiledPattern[] = sources.map((source) => {
    try {
      // No delimiters, no flags, no implicit anchoring: the source is used
      // exactly as configured and searched anywhere in the URL.
      return { source, expression: new RegExp(source) };
    } catch (error) {
      throw new Error(
        `web.urlBlocklist entry is not a valid JavaScript regular expression: ${source} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  });
  const match = (url: string): string | undefined => {
    for (const pattern of compiled) {
      if (pattern.expression.test(url)) return pattern.source;
    }
    return undefined;
  };
  return Object.freeze({
    sources: Object.freeze([...sources]),
    empty: false,
    match,
    // Detached from `this` on purpose: an acquisition route may hold the
    // assertion on its own without rebinding the blocklist.
    assertAllowed(url: string, stage: UrlAccessStage): void {
      const pattern = match(url);
      if (pattern !== undefined) throw new UrlBlocklistDeniedError(url, pattern, stage);
    },
  });
}

/** True when two blocklists carry exactly the same configured sources. */
export function urlBlocklistsEqual(left: UrlBlocklist, right: UrlBlocklist): boolean {
  if (left === right) return true;
  if (left.sources.length !== right.sources.length) return false;
  return left.sources.every((source, index) => source === right.sources[index]);
}
