package io.github.rfairburn.pireviewgate.core.hosts

/**
 * One explicit outbound endpoint: the address and port this client dials.
 *
 * There is no wildcard, no implicit port, and no fallback: an endpoint exists only
 * because the operator chose both parts. The admission rules follow the source
 * `isValidPeerEndpointHost` and `isSavedPort` — no whitespace, no path, and no URL
 * punctuation inside the host string, and a saved destination port in `1..65535`.
 *
 * An endpoint is data, not authority. Two saved hosts may legitimately name the
 * same endpoint; they stay distinct because their [HostId] values differ.
 */
public data class Endpoint(
    val host: String,
    val port: Int,
) {
    init {
        require(isValidHost(host)) { "endpoint host is invalid" }
        require(isValidPort(port)) { "endpoint port is invalid" }
    }

    /** Display form with an IPv6 literal bracketed, matching the source sidebar. */
    public fun displayText(): String = if (host.contains(':')) "[$host]:$port" else "$host:$port"

    public companion object {
        /** Bound for one saved host string. */
        public const val MAX_HOST_CHARS: Int = 255

        /** Largest admissible TCP port. */
        public const val MAX_PORT: Int = 65_535

        /** Structural admission for one saved host string. */
        public fun isValidHost(value: String): Boolean {
            if (value.isEmpty() || value.length > MAX_HOST_CHARS) return false
            return !value.any { it.isWhitespace() || it in "/\\?#@" }
        }

        /** Admission for a saved destination port; zero is never a dialable port. */
        public fun isValidPort(value: Int): Boolean = value in 1..MAX_PORT

        /**
         * Port parsed from operator text, following the source text rule: at most
         * five decimal digits, and zero only when [allowZero] is set.
         */
        public fun parsePortOrNull(text: String, allowZero: Boolean = false): Int? {
            val trimmed = text.trim()
            if (trimmed.isEmpty() || trimmed.length > 5) return null
            if (!trimmed.all { it in '0'..'9' }) return null
            val port = trimmed.toIntOrNull() ?: return null
            if (port > MAX_PORT) return null
            if (port == 0 && !allowZero) return null
            return port
        }

        /** Parsed endpoint, or `null` when either part is not admitted. */
        public fun parseOrNull(host: String, port: Int): Endpoint? =
            if (isValidHost(host) && isValidPort(port)) Endpoint(host, port) else null
    }
}
