package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerSavedEntry
import io.github.rfairburn.pireviewgate.core.protocol.roster.internal.RosterJson

/**
 * Canonical Saved-entry wire text, used by this endpoint for one purpose only:
 * counting the UTF-8 bytes one entry actually occupies inside a window.
 *
 * The key order is the codec's own canonical order, published as
 * [OwnerSavedEntry.KEYS], and the escaping is the codec's own
 * [RosterJson.stringOf], so the count matches the bytes the owner sent rather than
 * an approximation of them. This adds no validation rule of its own: an entry
 * reached this point only by decoding successfully.
 */
internal object RosterSavedWire {

    /** The exact canonical JSON text of one entry, in the codec's key order. */
    fun canonicalEntryText(entry: OwnerSavedEntry): String = buildString {
        append('{')
        OwnerSavedEntry.KEYS.forEachIndexed { index, key ->
            if (index > 0) append(',')
            append(RosterJson.stringOf(key))
            append(':')
            append(RosterJson.stringOf(entryValue(entry, key)))
        }
        append('}')
    }

    /** UTF-8 bytes one entry occupies in a page or reassembled from fragments. */
    fun entryWireBytes(entry: OwnerSavedEntry): Long =
        canonicalEntryText(entry).toByteArray(Charsets.UTF_8).size.toLong()

    /** UTF-8 bytes one fragment's text occupies. */
    fun fragmentWireBytes(text: String): Long = text.toByteArray(Charsets.UTF_8).size.toLong()

    private fun entryValue(entry: OwnerSavedEntry, key: String): String = when (key) {
        "entryId" -> entry.entryId
        "sessionId" -> entry.sessionId
        "file" -> entry.file
        "caption" -> entry.caption
        "cwd" -> entry.cwd
        else -> error("unknown saved entry key")
    }
}
