/**
 * The stored native row CAPTION versus its bounded published label (issue #493).
 *
 * A native row's caption is the one durable host-side name of that row. It has
 * two admitted sources, and they deliberately keep their own input rules:
 *
 * - an operator's MANUAL caption, typed in a host form, which keeps the
 *   unchanged {@linkcode isNativeDisplayName} rule (80 code units, trimmed);
 * - a SessionSpawn STARTUP title for a provider with no native title option of
 *   its own (Codex), which keeps the exact SessionSpawn title rule: the same
 *   1024-byte single-line bound the request was already admitted with, never
 *   trimmed, clipped, or rewritten.
 *
 * Either value is stored ONCE, exactly, as the row's caption (and as its
 * roster slot's remembered display name). What travels in the row's published
 * `label` is a separate read-time PROJECTION of that one stored value bounded by
 * the canonical published-label rule ({@linkcode isValidNativeDisplayName}), so
 * every surface that already carries `label` keeps its existing bound. The
 * projection is display only: it is never stored as a second copy, never
 * compared as a caption, and never sent to a provider.
 */

import {
  MAX_NATIVE_SESSION_NAME_LENGTH,
  MAX_SESSION_SPAWN_TITLE_BYTES,
  isValidNativeDisplayName,
  isValidRenameName,
} from "./protocol";

/**
 * True for a value a native row may hold and persist as its caption: the exact
 * SessionSpawn title rule (nonblank, single line, no controls, at most
 * {@linkcode MAX_SESSION_SPAWN_TITLE_BYTES} UTF-8 bytes). Every manual caption
 * that passes {@linkcode isNativeDisplayName} also passes this rule, so manual
 * captions persist exactly as before; the manual INPUT rule itself is unchanged.
 */
export function isNativeCaption(value: unknown): value is string {
  return isValidRenameName(value) && Buffer.byteLength(value, "utf8") <= MAX_SESSION_SPAWN_TITLE_BYTES;
}

/** The marker appended to a projected label that does not show the whole caption. */
export const NATIVE_CAPTION_ELLIPSIS = "…";

/**
 * The bounded published label of one admitted caption. A caption that already
 * satisfies the published-label rule is its own label, unchanged. Otherwise the
 * display text drops surrounding whitespace and, when still too long, keeps the
 * leading whole code points followed by {@linkcode NATIVE_CAPTION_ELLIPSIS}, so
 * the shortened display is visibly marked and the stored caption stays whole.
 */
export function projectNativeCaptionLabel(caption: string): string {
  // The guard is asked about a copy so a failed check never narrows `caption` away.
  const candidate: unknown = caption;
  if (isValidNativeDisplayName(candidate)) return candidate;
  const trimmed = caption.trim();
  if (isValidNativeDisplayName(trimmed)) return trimmed;
  const kept = Array.from(trimmed).slice(0, MAX_NATIVE_SESSION_NAME_LENGTH - 1).join("").trimEnd();
  return `${kept}${NATIVE_CAPTION_ELLIPSIS}`;
}
