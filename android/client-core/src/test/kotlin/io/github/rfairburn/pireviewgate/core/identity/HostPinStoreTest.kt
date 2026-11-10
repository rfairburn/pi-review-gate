package io.github.rfairburn.pireviewgate.core.identity

import io.github.rfairburn.pireviewgate.core.hosts.DocumentRead
import io.github.rfairburn.pireviewgate.core.hosts.DocumentWriteResult
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.SingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.TempTree
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Synthetic public keys for the trust seams. No device or product key material. */
internal object TestKeys {
    fun key(seed: Int): PeerKey {
        val der = ByteArray(91)
        // A recognizable SPKI-shaped prefix plus a seed, so distinct seeds are
        // distinct keys and the same seed always reproduces the same identity.
        der[0] = 0x30
        der[1] = 0x59
        der[2] = 0x30
        der[3] = 0x13
        der[4] = 0x06
        for (index in 5 until der.size) {
            der[index] = ((index * 31 + seed * 7) and 0x7f).toByte()
        }
        return PeerKey.fromSpki(der)
    }
}

class PeerKeyTest {

    @Test
    fun `a canonical identity is derived from the exact spki`() {
        val der = TestKeys.key(1).spkiDer
        val key = PeerKey.fromSpki(der)

        assertTrue(PeerKey.isValidKeyId(key.keyId))
        assertEquals(43, key.fingerprint.length)
        assertTrue(PeerKey.isValidKeyPair(key.keyId, key.fingerprint))
        assertContentEquals(der, key.spkiDer)
    }

    @Test
    fun `identity equality is the exact key, nothing else`() {
        val left = TestKeys.key(2)
        val same = PeerKey.fromSpki(left.spkiDer)
        val other = TestKeys.key(3)

        assertTrue(left.contentEquals(same))
        assertFalse(left.contentEquals(other))
        assertEquals(left, same)
    }

    @Test
    fun `a fingerprint that is not the digest of the key id is refused`() {
        val key = TestKeys.key(4)
        val tampered = key.fingerprint.dropLast(1) + if (key.fingerprint.last() == 'A') 'B' else 'A'

        assertEquals(null, PeerKey.parseOrNull(key.keyId, tampered))
        assertFalse(PeerKey.isValidKeyPair(key.keyId, tampered))
        assertFalse(PeerKey.isValidKeyPair(key.keyId, key.fingerprint.dropLast(1)))
    }

    @Test
    fun `a malformed key id is refused`() {
        val key = TestKeys.key(5)
        assertFalse(PeerKey.isValidKeyId(""))
        assertFalse(PeerKey.isValidKeyId(key.keyId + "!"))
        assertFalse(PeerKey.isValidKeyId("@" + key.keyId.drop(1)))
        assertFalse(PeerKey.isValidKeyId(key.keyId + "="))
        assertFalse(PeerKey.isValidKeyId("a".repeat(PeerKey.MAX_KEY_ID_CHARS + 1)))
        // Over-long DER behind a well-formed alphabet is out of bounds.
        val oversized = java.util.Base64.getEncoder().encodeToString(ByteArray(PeerKey.MAX_SPKI_DER_BYTES + 1))
        assertFalse(PeerKey.isValidKeyId(oversized))
    }
}

/**
 * Exact-SPKI continuity for stable host ids: a changed key is never
 * adopted, a changed locator never replaces or drops trust, removal clears only one
 * association, unreadable trust never degrades into first-use acceptance, and a stale
 * handle cannot overwrite newer trust.
 */
class HostPinStoreTest {

    private lateinit var tree: TempTree

    private val endpoint = Endpoint("192.168.1.20", 8443)

    @BeforeTest
    fun setUp() {
        tree = TempTree()
    }

    @AfterTest
    fun tearDown() {
        tree.close()
    }

    private fun id(value: String) = HostId.parse(value)

    @Test
    fun `a fresh trust store has no pins and creates nothing`() {
        val store = FileHostPinStore(tree.pinStorage())
        assertEquals(PinRead.NoPin, store.read(id("a"), endpoint))
        assertTrue(store.snapshot().isEmpty())
        assertFalse(tree.pinContainer.exists(), "reading trust must create nothing")
        store.close()
    }

    @Test
    fun `a first observed key is remembered once and survives a reopen`() {
        val store = FileHostPinStore(tree.pinStorage())
        val key = TestKeys.key(10)

        assertEquals(PinRecordResult.Recorded, store.record(id("a"), endpoint, key))
        assertEquals(PinRead.Remembered(key), store.read(id("a"), endpoint))
        store.close()

        val reopened = FileHostPinStore(tree.pinStorage())
        val remembered = assertIs<PinRead.Remembered>(reopened.read(id("a"), endpoint))
        assertEquals(key, remembered.key)
        assertContentEquals(key.spkiDer, remembered.key.spkiDer)
        assertEquals(endpoint, reopened.snapshot().single().endpoint)
        reopened.close()
    }

    @Test
    fun `the same key is unchanged and a different key is never adopted`() {
        val store = FileHostPinStore(tree.pinStorage())
        val original = TestKeys.key(11)
        val changed = TestKeys.key(12)

        store.record(id("a"), endpoint, original)
        assertEquals(PinRecordResult.Unchanged, store.record(id("a"), endpoint, TestKeys.key(11)))
        assertEquals(PinRecordResult.RejectedChangedKey, store.record(id("a"), endpoint, changed))
        store.close()

        // The refusal persisted: the disk still holds the original identity.
        val remembered = assertIs<PinRead.Remembered>(
            FileHostPinStore(tree.pinStorage()).read(id("a"), endpoint),
        )
        assertEquals(original, remembered.key)
        assertFalse(remembered.key.contentEquals(changed))
    }

    @Test
    fun `a saved association at a new address must prove the same exact key without rewriting provenance`() {
        val store = FileHostPinStore(tree.pinStorage())
        val original = TestKeys.key(16)
        store.record(id("a"), endpoint, original)

        val bytesBefore = tree.pinDocument.readBytes()
        val moved = Endpoint("10.9.9.9", 8443)
        val rememberedAtNewAddress = assertIs<PinRead.Remembered>(store.read(id("a"), moved))
        assertContentEquals(original.spkiDer, rememberedAtNewAddress.key.spkiDer)
        assertEquals(PinRecordResult.Unchanged, store.record(id("a"), moved, original))
        assertEquals(PinRecordResult.RejectedChangedKey, store.record(id("a"), moved, TestKeys.key(18)))
        assertContentEquals(bytesBefore, tree.pinDocument.readBytes())
        store.close()

        val reopened = FileHostPinStore(tree.pinStorage())
        assertEquals(endpoint, reopened.snapshot().single().endpoint)
        val remembered = assertIs<PinRead.Remembered>(reopened.read(id("a"), moved))
        assertEquals(original, remembered.key)
        reopened.close()
    }

    @Test
    fun `a different locator port does not change durable host identity or provenance`() {
        val store = FileHostPinStore(tree.pinStorage())
        val original = TestKeys.key(17)
        store.record(id("a"), endpoint, original)

        val otherPort = Endpoint(endpoint.host, 9443)
        assertEquals(PinRead.Remembered(original), store.read(id("a"), otherPort))
        assertEquals(PinRecordResult.Unchanged, store.record(id("a"), otherPort, original))
        assertEquals(PinRecordResult.RejectedChangedKey, store.record(id("a"), otherPort, TestKeys.key(19)))

        val saved = tree.pinDocument.readText()
        assertTrue(saved.contains("\"port\":8443"), "the stored endpoint stays exactly as recorded: $saved")
        assertFalse(saved.contains("9443"))
        store.close()
    }

    @Test
    fun `same key at a new locator makes no write and never creates another hosts pin`() {
        val storage = FakePinStorage()
        val store = FileHostPinStore(storage)
        val key = TestKeys.key(16)
        val moved = Endpoint("10.0.0.45", endpoint.port)
        assertEquals(PinRecordResult.Recorded, store.record(id("a"), endpoint, key))
        storage.outcome = DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted = false)
        assertEquals(PinRead.Remembered(key), store.read(id("a"), moved))
        assertEquals(PinRecordResult.Unchanged, store.record(id("a"), moved, key))
        assertEquals(PinRecordResult.RejectedChangedKey, store.record(id("a"), moved, TestKeys.key(17)))
        assertEquals(PinRead.NoPin, store.read(id("b"), moved))
        assertEquals(1, storage.writes)
        assertEquals(listOf(HostPin(id("a"), endpoint, key)), store.snapshot())
        storage.outcome = DocumentWriteResult.Published
        assertEquals(PinRecordResult.Recorded, store.record(id("b"), moved, key))
        assertEquals(2, storage.writes)
        assertEquals(listOf(id("a"), id("b")), store.snapshot().map { it.hostId })
        store.close()
        assertIs<PinRead.Refused>(store.read(id("a"), moved))
        assertIs<PinRecordResult.Refused>(store.record(id("a"), moved, key))
    }

    @Test
    fun `removing one host clears only its pin`() {
        val store = FileHostPinStore(tree.pinStorage())
        val keyA = TestKeys.key(13)
        val keyB = TestKeys.key(14)
        store.record(id("a"), endpoint, keyA)
        store.record(id("b"), Endpoint("10.0.0.9", 9000), keyB)

        assertEquals(PinClearResult.Cleared, store.clear(id("a")))
        assertEquals(PinRead.NoPin, store.read(id("a"), endpoint))
        assertEquals(PinRead.Remembered(keyB), store.read(id("b"), Endpoint("10.0.0.9", 9000)))
        store.close()

        val reopened = FileHostPinStore(tree.pinStorage())
        assertEquals(PinRead.NoPin, reopened.read(id("a"), endpoint))
        assertEquals(PinRead.Remembered(keyB), reopened.read(id("b"), Endpoint("10.0.0.9", 9000)))
        reopened.close()
    }

    @Test
    fun `clearing an unknown host is not an error and changes nothing`() {
        val store = FileHostPinStore(tree.pinStorage())
        val keyA = TestKeys.key(15)
        store.record(id("a"), endpoint, keyA)

        assertEquals(PinClearResult.NothingStored, store.clear(id("missing")))
        assertEquals(PinRead.Remembered(keyA), store.read(id("a"), endpoint))
        store.close()
    }

    @Test
    fun `the slot bound refuses rather than dropping remembered trust`() {
        val store = FileHostPinStore(tree.pinStorage())
        for (index in 0 until HostPinDocumentCodec.MAX_PINNED_HOSTS) {
            val result = store.record(id("host-$index"), endpoint, TestKeys.key(100 + index))
            assertEquals(PinRecordResult.Recorded, result)
        }
        assertIs<PinRecordResult.Refused>(store.record(id("one-too-many"), endpoint, TestKeys.key(999)))
        store.close()

        val reopened = FileHostPinStore(tree.pinStorage())
        assertEquals(HostPinDocumentCodec.MAX_PINNED_HOSTS, reopened.snapshot().size)
        assertNotNull(reopened.read(id("host-0"), endpoint) as? PinRead.Remembered)
        reopened.close()
    }

    @Test
    fun `two handles opened before any record cannot both record`() {
        val first = FileHostPinStore(tree.pinStorage())
        val second = FileHostPinStore(tree.pinStorage())

        assertEquals(PinRecordResult.Recorded, first.record(id("a"), endpoint, TestKeys.key(30)))
        val refusal = second.record(id("a"), endpoint, TestKeys.key(31))
        assertIs<PinRecordResult.Refused>(refusal)
        assertEquals(StorageFailureReason.CHANGED, refusal.reason)

        val remembered = assertIs<PinRead.Remembered>(
            FileHostPinStore(tree.pinStorage()).read(id("a"), endpoint),
        )
        assertEquals(TestKeys.key(30), remembered.key)
    }

    @Test
    fun `a stale trust handle cannot overwrite newer pins`() {
        val first = FileHostPinStore(tree.pinStorage())
        first.record(id("a"), endpoint, TestKeys.key(32))
        val second = FileHostPinStore(tree.pinStorage())
        assertEquals(PinRead.Remembered(TestKeys.key(32)), second.read(id("a"), endpoint))

        first.record(id("b"), endpoint, TestKeys.key(33))
        val refusal = second.record(id("c"), endpoint, TestKeys.key(34))
        assertIs<PinRecordResult.Refused>(refusal)
        assertEquals(StorageFailureReason.CHANGED, refusal.reason)

        val loaded = FileHostPinStore(tree.pinStorage()).snapshot()
        assertEquals(2, loaded.size)
        assertTrue(loaded.any { it.hostId == id("a") })
        assertTrue(loaded.any { it.hostId == id("b") })
    }

    @Test
    fun `a trust document replaced by someone else is never written over`() {
        val store = FileHostPinStore(tree.pinStorage())
        store.record(id("a"), endpoint, TestKeys.key(35))

        val foreign = "{\"version\":1,\"pins\":[]}\n"
        tree.pinDocument.writeText(foreign)

        val refusal = store.record(id("b"), endpoint, TestKeys.key(36))
        assertIs<PinRecordResult.Refused>(refusal)
        assertEquals(StorageFailureReason.CHANGED, refusal.reason)
        assertEquals(foreign, tree.pinDocument.readText())
    }

    @Test
    fun `a fresh stale handle cannot replace lost initialized trust`() {
        // Opened before anything existed, so its fence says "absent". That is not a
        // licence to recreate trust that was initialized and then lost.
        val stale = FileHostPinStore(tree.pinStorage())
        val writer = FileHostPinStore(tree.pinStorage())
        assertEquals(
            PinRecordResult.Recorded,
            writer.record(id("a"), endpoint, TestKeys.key(40)),
        )
        assertTrue(tree.pinDocument.delete())

        val refusal = assertIs<PinRecordResult.Refused>(stale.record(id("a"), endpoint, TestKeys.key(41)))
        assertEquals(StorageFailureReason.MISSING_INITIALIZED, refusal.reason)
        assertFalse(tree.pinDocument.exists(), "a refused publication must not recreate the document")
        stale.close()
        writer.close()
    }

    @Test
    fun `an initialized trust directory without its document fails closed`() {
        val store = FileHostPinStore(tree.pinStorage())
        store.record(id("a"), endpoint, TestKeys.key(20))
        store.close()
        assertTrue(tree.pinDocument.delete())

        val failure = assertFailsWith<StorageException> { FileHostPinStore(tree.pinStorage()) }
        assertEquals(StorageFailureReason.MISSING_INITIALIZED, failure.reason)
        assertFalse(tree.pinDocument.exists(), "a refused open must not create a trust document")
    }

    @Test
    fun `a malformed trust document is refused and left untouched`() {
        val garbage = "{\"version\":1,\"pins\":[{\"hostId\":\"a\"}]}"
        tree.pinContainer.mkdirs()
        tree.pinDocument.writeText(garbage)

        val failure = assertFailsWith<StorageException> { FileHostPinStore(tree.pinStorage()) }
        assertEquals(StorageFailureReason.MALFORMED, failure.reason)
        assertEquals(garbage, tree.pinDocument.readText())
    }

    @Test
    fun `an inconsistent or unknown-version trust document is refused`() {
        val key = TestKeys.key(21)
        val brokenDigest = key.fingerprint.dropLast(1) + if (key.fingerprint.last() == 'A') 'B' else 'A'
        val tamperedDigest =
            "{\"version\":1,\"pins\":[{\"hostId\":\"a\",\"host\":\"10.0.0.1\",\"port\":443," +
                "\"keyId\":\"${key.keyId}\",\"fingerprint\":\"$brokenDigest\"}]}"
        tree.pinContainer.mkdirs()
        tree.pinDocument.writeText(tamperedDigest)
        assertEquals(
            StorageFailureReason.MALFORMED,
            assertFailsWith<StorageException> { FileHostPinStore(tree.pinStorage()) }.reason,
        )

        val missingEndpoint =
            "{\"version\":1,\"pins\":[{\"hostId\":\"a\",\"keyId\":\"${key.keyId}\",\"fingerprint\":\"${key.fingerprint}\"}]}"
        tree.pinDocument.writeText(missingEndpoint)
        assertEquals(
            StorageFailureReason.MALFORMED,
            assertFailsWith<StorageException> { FileHostPinStore(tree.pinStorage()) }.reason,
        )

        val newer = "{\"version\":2,\"pins\":[]}"
        tree.pinDocument.writeText(newer)
        assertEquals(
            StorageFailureReason.UNSUPPORTED_VERSION,
            assertFailsWith<StorageException> { FileHostPinStore(tree.pinStorage()) }.reason,
        )
    }

    @Test
    fun `a private key is never expressible in the trust document`() {
        val store = FileHostPinStore(tree.pinStorage())
        store.record(id("a"), endpoint, TestKeys.key(22))
        store.close()

        val text = tree.pinDocument.readText()
        assertTrue(text.contains("\"keyId\""))
        assertFalse(text.contains("PRIVATE"))
        assertFalse(text.contains("BEGIN"))
        assertFalse(text.contains("pkcs"))
        assertFalse(text.contains("secp256"))
        Regex("\"([A-Za-z]+)\"\\s*:").findAll(text).forEach { match ->
            assertTrue(
                match.groupValues[1] in
                    setOf("version", "pins", "hostId", "host", "port", "keyId", "fingerprint"),
                "unexpected key ${match.groupValues[1]} in the trust document",
            )
        }
    }

    @Test
    fun `a poisoned trust handle refuses rather than claiming memory equals disk`() {
        val fake = FakePinStorage()
        val store = FileHostPinStore(fake)
        assertEquals(PinRead.NoPin, store.read(id("a"), endpoint))

        fake.outcome = DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted = true)
        assertIs<PinRecordResult.Refused>(store.record(id("a"), endpoint, TestKeys.key(23)))

        assertIs<PinRead.Refused>(store.read(id("a"), endpoint))
        assertIs<PinRead.Refused>(store.read(id("a"), Endpoint("10.0.0.45", endpoint.port)))
        assertIs<PinRecordResult.Refused>(store.record(id("a"), Endpoint("10.0.0.45", endpoint.port), TestKeys.key(23)))
        assertIs<PinClearResult.Refused>(store.clear(id("a")))
        assertFailsWith<StorageException> { store.snapshot() }
    }

    private class FakePinStorage : SingleDocumentStorage {
        var outcome: DocumentWriteResult = DocumentWriteResult.Published
        var writes: Int = 0

        override fun read(): DocumentRead = DocumentRead.Uninitialized

        override fun write(
            bytes: ByteArray,
        ): DocumentWriteResult {
            writes += 1
            return outcome
        }
    }
}
