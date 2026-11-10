package io.github.rfairburn.pireviewgate.acceptance

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AcceptanceDiagnosticTest {
    private val nonce = "0123456789abcdef"
    private val countKeys = setOf(
        "registryConfigured", "registryNever", "registryConnecting", "registryPairing", "registryConnected",
        "registryRetrying", "registryDisconnected", "registryError", "runtimeAttached", "rosterCurrent",
        "rosterCurrentRevision2", "rosterCurrentRevision3", "rosterEmpty", "rosterStale", "rosterAwaitingAck",
        "rosterFailed", "rosterHandshakeTimeout", "transportAttempts",
    )
    private fun counts(n: Int = 64) = AcceptanceDiagnosticCounts(
        n, n, n, n, n, n, n, n, n, n, n, n, n, n, n, n, n, n,
    )
    private fun evidence(n: Int = 64, closed: Boolean = false) = AcceptanceDiagnosticEvidence(
        AcceptanceDiagnosticCode.APP_LOST, AcceptanceCheckpoint.ROSTER_REVISION2_WAIT, closed, counts(n),
    )
    private fun parse(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test fun closedKeysSeparateProducerCheckpointAndFallback() {
        val root = parse(AcceptanceDiagnostic.packet(nonce, "rosters64_revision2",
            AcceptanceDiagnosticCode.UNKNOWN, evidence()))
        assertEquals(setOf("event", "version", "nonce", "phase", "code", "firstFailureCode",
            "checkpoint", "channelClosureProven", "counts"), root.keys)
        assertEquals(JsonPrimitive("peerAcceptanceDiagnostic"), root["event"])
        assertEquals(JsonPrimitive(1), root["version"])
        assertEquals(JsonPrimitive(nonce), root["nonce"])
        assertEquals(JsonPrimitive("rosters64_revision2"), root["phase"])
        assertEquals(JsonPrimitive("UNKNOWN"), root["code"])
        assertEquals(JsonPrimitive("APP_LOST"), root["firstFailureCode"])
        assertEquals(JsonPrimitive("ROSTER_REVISION2_WAIT"), root["checkpoint"])
        assertEquals(JsonPrimitive(false), root["channelClosureProven"])
        val counts = root.getValue("counts").jsonObject
        assertEquals(countKeys, counts.keys)
        counts.values.forEach { assertEquals(JsonPrimitive(64), it) }
        val closed = parse(AcceptanceDiagnostic.packet(nonce, "channel_cleanup",
            AcceptanceDiagnosticCode.UNKNOWN, evidence(closed = true)))
        assertEquals(JsonPrimitive(true), closed["channelClosureProven"])
        assertEquals(JsonPrimitive("APP_LOST"), closed["firstFailureCode"])
        val noDeferredFailure = parse(AcceptanceDiagnostic.packet(nonce, "rosters64_revision2",
            AcceptanceDiagnosticCode.UNKNOWN, evidence().copy(firstFailureCode = null)))
        assertEquals(root.keys - "firstFailureCode", noDeferredFailure.keys)
    }

    @Test fun fixedCodeAllowlistAndPacketBoundsForEveryCheckpoint() {
        assertEquals(setOf("HANDOFF_OVERFLOW", "APP_ATTACH_REFUSED", "APP_LOST", "ROSTER_SUBSCRIBE_REFUSED",
            "ROSTER_RETIREMENT", "CONTENT_OPEN_FAILED", "UNEXPECTED_FIRST_CONTACT", "COROUTINE_ERROR",
            "TIMEOUT", "ASSERTION", "UNKNOWN"), AcceptanceDiagnosticCode.entries.map { it.name }.toSet())
        for (code in AcceptanceDiagnosticCode.entries) for (checkpoint in AcceptanceCheckpoint.entries) {
            for (n in listOf(Int.MIN_VALUE, 0, 64, Int.MAX_VALUE)) {
                val text = AcceptanceDiagnostic.packet(nonce, "content64_and_APP_continuity", code,
                    evidence(n).copy(firstFailureCode = code, checkpoint = checkpoint))
                assertTrue(text.toByteArray(Charsets.UTF_8).size <= AcceptanceDiagnostic.MAX_BYTES)
                val counts = parse(text).getValue("counts").jsonObject
                assertEquals(countKeys, counts.keys)
                counts.values.forEach {
                    assertEquals(JsonPrimitive(n.coerceIn(0, 1_000_000)), it)
                }
            }
        }
    }

    @Test fun unfamiliarThrowableAndPhaseCannotLeakArbitraryContent() {
        val secret = "/synthetic/private-key endpoint host-id session-text PUBLIC-KEY"
        val unknown = IllegalStateException(secret, AssertionError(secret))
        var text = ""
        AcceptanceDiagnostic.reportFailure(nonce, secret, unknown) { text = it }
        val root = parse(text)
        assertEquals(setOf("event", "version", "nonce", "phase", "code"), root.keys)
        assertEquals(JsonPrimitive("UNKNOWN"), root["code"])
        assertEquals(JsonPrimitive("unknown"), root["phase"])
        assertFalse(text.contains(secret))
        AcceptanceDiagnostic.reportFailure(nonce, "☃".repeat(5000), unknown) { text = it }
        assertEquals(JsonPrimitive("unknown"), parse(text)["phase"])
        assertTrue(text.toByteArray(Charsets.UTF_8).size <= AcceptanceDiagnostic.MAX_BYTES)
        var invalidNonceEmitted = false
        AcceptanceDiagnostic.reportFailure("invalid", "channel_cleanup", unknown) { invalidNonceEmitted = true }
        assertFalse(invalidNonceEmitted)
        val hostile = object : RuntimeException() {
            override val message: String get() = error("message accessed")
            override val cause: Throwable get() = error("cause accessed")
            override fun toString(): String = error("toString accessed")
        }
        assertEquals(AcceptanceDiagnosticCode.UNKNOWN, AcceptanceDiagnostic.code(hostile))
        AcceptanceDiagnostic.reportFailure(nonce, "channel_cleanup", hostile) { text = it }
        assertEquals(JsonPrimitive("UNKNOWN"), parse(text)["code"])
        assertEquals(AcceptanceDiagnosticCode.ASSERTION, AcceptanceDiagnostic.code(AssertionError(secret)))
    }

    @Test fun actualTimeoutHasOnlyFixedFallback() = runBlocking {
        val timeout = try {
            withTimeout(1) { awaitCancellation() }
        } catch (error: Throwable) { error }
        assertEquals(AcceptanceDiagnosticCode.TIMEOUT, AcceptanceDiagnostic.code(timeout))
    }

    @Test fun diagnosticConstructionAndEmissionCannotReplaceOriginalFailure() {
        val original = IllegalStateException("unpublished")
        for (brokenEvidence in listOf(false, true)) {
            val result = runCatching {
                AcceptanceDiagnostic.observeFailure({ failure ->
                    AcceptanceDiagnostic.reportFailure(nonce, "channel_cleanup", failure,
                        evidence = { if (brokenEvidence) error("construction failed") else evidence() },
                        emit = { error("delivery failed") })
                }) { throw original }
            }
            assertSame(original, result.exceptionOrNull())
        }
        val brokenReporter = runCatching {
            AcceptanceDiagnostic.observeFailure({ error("reporter failed") }) { throw original }
        }
        assertSame(original, brokenReporter.exceptionOrNull())
    }

    @Test fun successReturnsUnchangedAndNeverCallsDiagnosticReporter() {
        val statuses = mutableListOf<String>()
        var diagnostics = 0
        val result = AcceptanceDiagnostic.observeFailure({ diagnostics++ }) {
            statuses += "starting"
            statuses += "passed"
            64
        }
        assertEquals(64, result)
        assertEquals(listOf("starting", "passed"), statuses)
        assertEquals(0, diagnostics)
    }
}
