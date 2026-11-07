package io.github.rfairburn.pireviewgate.acceptance

import io.github.rfairburn.pireviewgate.core.presentation.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.UUID

class AcceptanceContractTest {
    private val keyFactory = KeyPairGenerator.getInstance("EC").apply {
        initialize(ECGenParameterSpec("secp256r1"))
    }
    private fun key(): String = Base64.getEncoder().encodeToString(keyFactory.generateKeyPair().public.encoded)
    private fun document(): JsonObject = buildJsonObject {
        put("event", "ready"); put("version", 1); put("nonce", "0123456789abcdef")
        put("clientKeyId", key()); put("clientLabel", FIXTURE_LABEL); put("listenHost", "127.0.0.1")
        put("hosts", buildJsonArray {
            repeat(64) { i -> add(buildJsonObject {
                put("hostId", UUID.randomUUID().toString()); put("hostRunId", UUID.randomUUID().toString())
                put("hostKeyId", key()); put("hostLabel", FIXTURE_LABEL); put("port", 20000 + i)
            }) }
        })
    }
    private fun b64(text: String) = Base64.getEncoder().encodeToString(text.toByteArray())
    private fun parse(doc: JsonObject) = AcceptanceManifest.parse(b64(doc.toString()))
    private fun rejects(text: String) {
        try { AcceptanceManifest.parse(b64(text)); fail("accepted invalid manifest") }
        catch (_: Exception) { /* expected fixed validation refusal */ }
    }
    private fun change(root: JsonObject, key: String, value: JsonElement) = JsonObject(root + (key to value))
    private fun changeHost(root: JsonObject, index: Int, key: String, value: JsonElement): JsonObject {
        val hosts = (root.getValue("hosts") as JsonArray).toMutableList()
        hosts[index] = change(hosts[index] as JsonObject, key, value)
        return change(root, "hosts", JsonArray(hosts))
    }

    @Test fun canonicalManifestAndOnlyLoopbackMapping() {
        val parsed = parse(document())
        assertEquals(64, parsed.hosts.size)
        assertEquals("0123456789abcdef", parsed.nonce)
        assertEquals("10.0.2.2", parsed.hosts.first().endpoint.host)
        assertEquals(20000, parsed.hosts.first().endpoint.port)
        assertNotEquals(parsed.clientKey.keyId, parsed.clientKey.fingerprint)
        parsed.hosts.forEach { assertEquals(it.key, canonicalPublicKey(it.key.keyId)) }
    }

    @Test fun closedSchemaTypesCountsAndNonce() {
        val doc = document()
        val invalid = listOf(
            change(doc, "extra", JsonPrimitive(true)), change(doc, "event", JsonPrimitive("other")),
            change(doc, "version", JsonPrimitive("1")), change(doc, "version", JsonPrimitive(2)),
            change(doc, "nonce", JsonPrimitive("0123456789ABCDEf")),
            change(doc, "nonce", JsonPrimitive("../0123456789abc")),
            change(doc, "clientLabel", JsonPrimitive("Other")),
            change(doc, "listenHost", JsonPrimitive("10.0.2.2")),
            change(doc, "listenHost", JsonPrimitive("localhost")),
            change(doc, "hosts", JsonArray((doc.getValue("hosts") as JsonArray).dropLast(1))),
            change(doc, "hosts", JsonArray((doc.getValue("hosts") as JsonArray) + JsonNull)),
            changeHost(doc, 0, "extra", JsonPrimitive(0)),
            changeHost(doc, 0, "hostLabel", JsonPrimitive("Other")),
            changeHost(doc, 0, "port", JsonPrimitive("20000")),
            changeHost(doc, 0, "port", JsonPrimitive(0)),
            changeHost(doc, 0, "port", JsonPrimitive(65536)),
            changeHost(doc, 0, "hostId", JsonPrimitive("1-1-1-1-1")),
            changeHost(doc, 0, "hostRunId", JsonPrimitive(UUID.randomUUID().toString().uppercase())),
            JsonObject(doc - "clientKeyId"),
        )
        invalid.forEach { rejects(it.toString()) }
        rejects(doc.toString().replaceFirst("\"version\":1", "\"version\":1.0"))
    }

    @Test fun exactKeysAndAllUniquenessDimensions() {
        val doc = document()
        val first = (doc.getValue("hosts") as JsonArray).first() as JsonObject
        for (field in listOf("hostId", "hostRunId", "hostKeyId", "port")) {
            rejects(changeHost(doc, 1, field, first.getValue(field)).toString())
        }
        rejects(changeHost(doc, 1, "hostRunId", first.getValue("hostId")).toString())
        rejects(changeHost(doc, 0, "hostRunId", first.getValue("hostId")).toString())
        rejects(changeHost(doc, 0, "hostId", JsonPrimitive("00000000-0000-0000-0000-000000000000")).toString())
        rejects(changeHost(doc, 0, "hostKeyId", doc.getValue("clientKeyId")).toString())
        rejects(change(doc, "clientKeyId", JsonPrimitive(parse(doc).clientKey.fingerprint)).toString())
        rejects(changeHost(doc, 0, "hostKeyId", JsonPrimitive("AQID")).toString())
        val canonical = doc.string("clientKeyId")
        rejects(change(doc, "clientKeyId", JsonPrimitive(canonical.trimEnd('='))).toString())
    }

    @Test fun duplicateKeysIncludingEscapesAreNotCollapsed() {
        val text = document().toString()
        rejects(text.replaceFirst("\"version\":1", "\"version\":1,\"version\":1"))
        rejects(text.replaceFirst("\"version\":1", "\"version\":1,\"vers\\u0069on\":1"))
        rejects(text.replaceFirst("\"port\":20000", "\"port\":20000,\"port\":20000"))
    }

    @Test fun strictUtf8SizeAndCanonicalBase64Bounds() {
        fun refused(encoded: String) {
            try { AcceptanceManifest.parse(encoded); fail("accepted invalid bytes") }
            catch (_: Exception) { }
        }
        refused(Base64.getEncoder().encodeToString(byteArrayOf(0xc3.toByte(), 0x28)))
        refused(Base64.getEncoder().encodeToString(ByteArray(65537) { 32 }))
        refused(" "+ b64(document().toString()))
        refused("%%%")
        rejects("[".repeat(10) + "0" + "]".repeat(10))
    }

    @Test fun fullMatrixNullsIndependentCountsAndCrossHostIdentity() {
        val manifest = parse(document())
        val observed = manifest.hosts.flatMapIndexed { i, host ->
            val rows = MetadataMatrix.expected(i, host)
            MetadataMatrix.assertReceived(i, host, rows)
            assertEquals(2, rows.size)
            val live = rows.first()
            assertEquals(listOf(true, false, null)[i % 3], live.busy)
            assertEquals(listOf(false, null, true)[i % 3], live.pendingInput)
            if (i % 2 == 0) {
                assertEquals(0L, live.backgroundTasks); assertEquals(3L, live.backgroundShells)
                assertEquals(2L, live.activeTasks); assertEquals(0L, live.activeShells)
                assertNotNull(live.nativeSession)
            } else {
                assertNull(live.backgroundTasks); assertNull(live.backgroundShells)
                assertNull(live.activeTasks); assertNull(live.activeShells); assertNull(live.nativeSession)
            }
            assertNull(rows.last().busy); assertNull(rows.last().pendingInput)
            assertNull(rows.last().rosterSlotId); assertEquals(0.0, rows.last().exitCode)
            try {
                MetadataMatrix.assertReceived(i, host, listOf(live.copy(backgroundShells = 0)) + rows.drop(1))
                fail("independent count mismatch accepted")
            } catch (_: IllegalStateException) { }
            rows.map { RemotePresentationObservedRow(host.hostId, host.hostRunId, it.id, it.rosterSlotId) }
        }
        RemotePresentationOrderCoordinator().use {
            it.observe(observed)
            assertEquals(128, it.identities().size)
            assertEquals(128, it.visibleOrder(observed).toSet().size)
        }
    }
}
