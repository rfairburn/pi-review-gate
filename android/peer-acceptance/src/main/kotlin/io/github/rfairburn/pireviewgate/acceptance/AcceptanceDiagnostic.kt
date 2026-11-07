package io.github.rfairburn.pireviewgate.acceptance

import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.json.*

/** Closed fixture-only vocabulary. Never derive a code from exception text or causes. */
enum class AcceptanceDiagnosticCode {
    HANDOFF_OVERFLOW, APP_ATTACH_REFUSED, APP_LOST, ROSTER_SUBSCRIBE_REFUSED,
    ROSTER_RETIREMENT, CONTENT_OPEN_FAILED, UNEXPECTED_FIRST_CONTACT, COROUTINE_ERROR,
    TIMEOUT, ASSERTION, UNKNOWN,
}

enum class AcceptanceCheckpoint {
    GRAPH_CREATED, PROVISIONING, PERMISSION_WAIT, PERMISSION_GRANT,
    MEASUREMENT_WAIT, GRID_ASSERTION, VIEWPORT_ADMISSION, CONNECT_ADMISSION,
    REGISTRY_WAIT, ROSTER_REVISION2_WAIT, ATTACHED64_ASSERTION, MATRIX_REVISION2_ASSERTION,
    PRESENTATION_ORDER, CONTENT_SELECTION, CONTENT_WAIT, CONTENT_ASSERTION,
    ROSTER_REVISION3_WAIT, MATRIX_REVISION3_ASSERTION, CONTINUITY_ASSERTION, CAPACITY_ASSERTION,
}

private val diagnosticPhases = setOf(
    "prepareIdentity", "runSixtyFourHosts", "cleanupFixture", "connect_action",
    "native_connect_ready", "provisioning", "permission", "permission_GRANTED_requested",
    "permission_GRANTED_existing", "permission_NOT_REQUIRED_existing", "rosters64_revision2",
    "presentation_order", "content64_and_APP_continuity", "capacity65_no_transport",
    "channel_cleanup", "nonce_cleanup",
)

/** Counts only, sampled from published immutable observations; no host/row data. */
data class AcceptanceDiagnosticCounts(
    val registryConfigured: Int,
    val registryNever: Int,
    val registryConnecting: Int,
    val registryPairing: Int,
    val registryConnected: Int,
    val registryRetrying: Int,
    val registryDisconnected: Int,
    val registryError: Int,
    val runtimeAttached: Int,
    val rosterCurrent: Int,
    val rosterCurrentRevision2: Int,
    val rosterCurrentRevision3: Int,
    val rosterEmpty: Int,
    val rosterStale: Int,
    val rosterAwaitingAck: Int,
    val rosterFailed: Int,
    val rosterHandshakeTimeout: Int,
    val transportAttempts: Int,
) {
    internal fun json(): JsonObject = buildJsonObject {
        fun count(key: String, value: Int) = put(key, value.coerceIn(0, 1_000_000))
        count("registryConfigured", registryConfigured)
        count("registryNever", registryNever)
        count("registryConnecting", registryConnecting)
        count("registryPairing", registryPairing)
        count("registryConnected", registryConnected)
        count("registryRetrying", registryRetrying)
        count("registryDisconnected", registryDisconnected)
        count("registryError", registryError)
        count("runtimeAttached", runtimeAttached)
        count("rosterCurrent", rosterCurrent)
        count("rosterCurrentRevision2", rosterCurrentRevision2)
        count("rosterCurrentRevision3", rosterCurrentRevision3)
        count("rosterEmpty", rosterEmpty)
        count("rosterStale", rosterStale)
        count("rosterAwaitingAck", rosterAwaitingAck)
        count("rosterFailed", rosterFailed)
        count("rosterHandshakeTimeout", rosterHandshakeTimeout)
        count("transportAttempts", transportAttempts)
    }
}

data class AcceptanceDiagnosticEvidence(
    val firstFailureCode: AcceptanceDiagnosticCode?,
    val checkpoint: AcceptanceCheckpoint,
    val channelClosureProven: Boolean,
    val counts: AcceptanceDiagnosticCounts,
)

/** Only failure catch sites call this. Construction and delivery are best-effort. */
object AcceptanceDiagnostic {
    const val BUNDLE_KEY = "peerAcceptanceDiagnostic"
    const val MAX_BYTES = 4096

    fun code(error: Throwable): AcceptanceDiagnosticCode = when (error) {
        is TimeoutCancellationException -> AcceptanceDiagnosticCode.TIMEOUT
        is AssertionError -> AcceptanceDiagnosticCode.ASSERTION
        else -> AcceptanceDiagnosticCode.UNKNOWN
    }

    fun packet(
        nonce: String,
        phase: String,
        code: AcceptanceDiagnosticCode,
        evidence: AcceptanceDiagnosticEvidence? = null,
    ): String = buildJsonObject {
        put("event", BUNDLE_KEY)
        put("version", 1)
        put("nonce", checkedNonce(nonce))
        put("phase", phase.takeIf { it in diagnosticPhases } ?: "unknown")
        put("code", code.name)
        evidence?.let {
            // Distinct observations, never a reconstructed causal chain.
            it.firstFailureCode?.let { first -> put("firstFailureCode", first.name) }
            put("checkpoint", it.checkpoint.name)
            put("channelClosureProven", it.channelClosureProven)
            put("counts", it.counts.json())
        }
    }.toString().also { check(it.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) }

    /** No callback on success; even a broken failure reporter cannot alter the outcome. */
    inline fun <T> observeFailure(crossinline report: (Throwable) -> Unit, block: () -> T): T {
        try {
            return block()
        } catch (error: Throwable) {
            try { report(error) } catch (_: Throwable) { }
            throw error
        }
    }

    fun reportFailure(
        nonce: String,
        phase: String,
        error: Throwable,
        evidence: () -> AcceptanceDiagnosticEvidence? = { null },
        emit: (String) -> Unit,
    ) {
        try {
            emit(packet(nonce, phase, code(error), evidence()))
        } catch (_: Throwable) {
            // Diagnostics must never replace, suppress, or turn the original failure into a pass.
        }
    }
}
