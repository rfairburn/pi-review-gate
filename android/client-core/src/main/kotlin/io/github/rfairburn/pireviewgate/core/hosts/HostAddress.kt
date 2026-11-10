package io.github.rfairburn.pireviewgate.core.hosts

/** A validated operator-provided locator, with no port and no identity authority. */
@JvmInline
public value class HostAddress private constructor(public val value: String) {
    public companion object {
        /** Uses the same structural admission as [Endpoint], without discovery or normalization. */
        public fun parseOrNull(value: String): HostAddress? =
            if (Endpoint.isValidHost(value)) HostAddress(value) else null

        /** @throws IllegalArgumentException when [value] is not an admitted address. */
        public fun parse(value: String): HostAddress =
            parseOrNull(value) ?: throw IllegalArgumentException("host address is invalid")
    }
}
