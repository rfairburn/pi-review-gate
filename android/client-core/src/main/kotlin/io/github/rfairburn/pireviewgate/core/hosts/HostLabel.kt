package io.github.rfairburn.pireviewgate.core.hosts

/**
 * Bounded, line-safe display alias for one configured host, and the label used as
 * the subject of this client's own peer certificate.
 *
 * A label is never identity and is never compared as identity: trust is the exact
 * remembered server key. The admitted character set and the 64 UTF-8 byte bound
 * follow the source `isValidPeerLabel` so a label survives both the wire header and
 * a certificate `CN=` without quoting or truncation surprises.
 */
@JvmInline
public value class HostLabel private constructor(public val value: String) {

    public companion object {
        /** Bound for one display label, measured in UTF-8 bytes. */
        public const val MAX_LABEL_BYTES: Int = 64

        private val ALLOWED: Regex = Regex("^[0-9A-Za-z ._@:()\\-]+$")

        /** Structural admission for one candidate label. */
        public fun isValid(value: String): Boolean {
            if (value.isEmpty()) return false
            if (value.toByteArray(Charsets.UTF_8).size > MAX_LABEL_BYTES) return false
            return ALLOWED.matches(value)
        }

        /** Parsed label, or `null` when [value] is not an admitted display label. */
        public fun parseOrNull(value: String): HostLabel? = if (isValid(value)) HostLabel(value) else null

        /**
         * Parsed label.
         *
         * @throws IllegalArgumentException when [value] is not an admitted display label.
         */
        public fun parse(value: String): HostLabel =
            parseOrNull(value) ?: throw IllegalArgumentException("host label is invalid")
    }
}
