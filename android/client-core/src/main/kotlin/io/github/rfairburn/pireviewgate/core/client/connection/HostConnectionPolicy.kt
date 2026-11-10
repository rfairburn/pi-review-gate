package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * The one local-network capability question the registry asks before dialing.
 *
 * Android 17 makes `ACCESS_LOCAL_NETWORK` a runtime requirement, and the
 * platform adapter owns asking for it. Asking is never this registry's job: it
 * has no Activity, no prompt, and no permission result. The adapter supplies a
 * probe that answers from the current grant only, so a dial can be refused
 * honestly instead of failing later as an unexplained timeout.
 *
 * Three rules make this seam safe:
 *
 * - It must be cheap and non-blocking, and it must never request a permission,
 *   open a socket, or resolve a name.
 * - A refusal here is reported as [HostConnectionReason.LOCAL_NETWORK_UNAVAILABLE]
 *   and is never inferred from a network timeout: a blocked connection can look
 *   like a timeout, and a timeout has many other causes.
 * - It gates only what actually needs local-network access. Public-internet
 *   traffic is not this permission's subject, so a missing grant must never turn
 *   into a general connection block.
 */
public fun interface NetworkAccessAdmission {
    /** Whether dialing [endpoint] may proceed right now. */
    public fun allows(endpoint: Endpoint): Boolean

    public companion object {
        /**
         * The default: no platform capability is wired, so nothing is refused on
         * permission grounds. A missing grant is then a fact the adapter reports
         * through its own UI, not something this registry invents.
         */
        public val UNRESTRICTED: NetworkAccessAdmission = NetworkAccessAdmission { true }
    }
}

/**
 * Per-destination connection policy.
 *
 * The transport's own defaults are low-level numbers. The two that matter for a
 * human flow do not fit a phone sidebar: a 15-second local confirmation window
 * and a 10-second pairing response are far too short for a person to read a
 * fingerprint on one device and type it near another.
 *
 * These values follow the source coordinator's human windows exactly:
 * [consentWindowMs] is the real approval window a person gets, and
 * [pairingResponseTimeoutMs] is that same window plus a bounded commit/reply
 * overhead, which is the deadline this side holds the remote answer to.
 */
public data class HostConnectionPolicy(
    public val consentWindowMs: Long,
    public val pairingResponseOverheadMs: Long,
    public val autoReconnectDelaysMs: List<Long>,
) {
    init {
        require(consentWindowMs > 0L) { "consent window must be positive" }
        require(pairingResponseOverheadMs > 0L) { "pairing response overhead must be positive" }
        require(autoReconnectDelaysMs.isNotEmpty()) { "the automatic schedule must not be empty" }
        require(autoReconnectDelaysMs.all { it > 0L }) { "automatic delays must be positive" }
    }

    /** The full deadline this side waits for a remote pairing answer. */
    public val pairingResponseTimeoutMs: Long get() = consentWindowMs + pairingResponseOverheadMs

    public companion object {
        /** The human approval window a phone sidebar gives an operator. */
        public const val DEFAULT_CONSENT_WINDOW_MS: Long = 120_000L

        /** Finite commit/reply overhead allowed after the remote window elapses. */
        public const val DEFAULT_PAIRING_RESPONSE_OVERHEAD_MS: Long = 30_000L

        /**
         * The finite automatic reconnect schedule: six bounded waits, then the
         * schedule stops and an explicit Connect is required. It does not repeat
         * the last value forever.
         */
        public val DEFAULT_AUTO_RECONNECT_DELAYS_MS: List<Long> =
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 30_000L)

        /** The shipped policy. */
        public val DEFAULT: HostConnectionPolicy = HostConnectionPolicy(
            consentWindowMs = DEFAULT_CONSENT_WINDOW_MS,
            pairingResponseOverheadMs = DEFAULT_PAIRING_RESPONSE_OVERHEAD_MS,
            autoReconnectDelaysMs = DEFAULT_AUTO_RECONNECT_DELAYS_MS,
        )
    }
}

/** One destination's saved association, captured for one attempt. */
internal data class HostAssociation(
    val hostId: HostId,
    val endpoint: Endpoint,
    val label: String,
)
