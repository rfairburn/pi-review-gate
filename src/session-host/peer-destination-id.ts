/**
 * The one canonical saved paired-destination identity contract (issue #493).
 *
 * A paired destination is remembered by the peer-preferences store under an
 * opaque LOCAL id. That id is data only: it never names a path component or a
 * property key, it is matched exactly as stored (no trimming, case folding, or
 * Unicode normalization), and surrounding whitespace is part of the value.
 *
 * This module is pure (no IO, no imports) so the local session-host protocol,
 * the SessionSpawn host selector, SessionHosts discovery, and the durable
 * preferences store can all share one predicate and one bound without the
 * protocol importing the filesystem-backed store (which would be circular:
 * the store reaches the protocol through the roster store).
 *
 * The preferences store, local protocol, and discovery tool all import this
 * single contract. It preserves the existing persisted bounds and introduces
 * no registry, new restriction, or alias.
 */

/** Bound for saved destinations; a document with more is refused by the store. */
export const MAX_PEER_DESTINATIONS = 64;

/** Bound for an opaque LOCAL destination id, in UTF-16 code units (JavaScript string length). */
export const MAX_PEER_DESTINATION_ID_CHARS = 128;

/**
 * UTF-8 byte bound derived from the character bound: one UTF-16 code unit
 * encodes to at most three UTF-8 bytes (a surrogate pair is two units and four
 * bytes; an unpaired surrogate is replaced by a three-byte sequence). Any id
 * the store accepts therefore fits; this is never a narrower limit.
 */
export const MAX_PEER_DESTINATION_ID_UTF8_BYTES = MAX_PEER_DESTINATION_ID_CHARS * 3;

/**
 * Admits exactly the ids the preferences store accepts: a nonempty string of at
 * most {@link MAX_PEER_DESTINATION_ID_CHARS} UTF-16 code units without C0/C1
 * controls, DEL, or line/paragraph separators. Nothing is trimmed or rewritten;
 * a padded id is a different, equally valid id. Shape-only: this claims nothing
 * about whether such a destination is saved or reachable.
 */
export function isValidPeerDestinationId(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PEER_DESTINATION_ID_CHARS
    && !/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(value)
  );
}
