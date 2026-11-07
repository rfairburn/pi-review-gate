package io.github.rfairburn.pireviewgate.core.presentation

import io.github.rfairburn.pireviewgate.core.hosts.DocumentRead
import io.github.rfairburn.pireviewgate.core.hosts.DocumentWriteResult
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.SingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Durable behavior of the identity-only remote presentation order: fresh reads
 * create nothing, saved order round-trips, absent identities stay saved, malformed
 * or stale state fails closed, and an oversized save is refused rather than
 * shortened.
 */
class RemotePresentationOrderStoreTest {

    private lateinit var tree: TempTree

    @BeforeTest
    fun setUp() {
        tree = TempTree()
    }

    @AfterTest
    fun tearDown() {
        tree.close()
    }

    private fun host(id: String): HostId = HostId.parse(id)

    private fun slot(hostId: String, ownerId: String): RemotePresentationIdentity =
        assertNotNull(RemotePresentationIdentity.slot(host(hostId), ownerId))

    private fun runtime(hostId: String, runId: String?, rowId: String): RemotePresentationIdentity =
        assertNotNull(RemotePresentationIdentity.legacyRuntime(host(hostId), runId, rowId))

    /** A persisted (not wire-observed) durable-slot identity, up to the store bound. */
    private fun persistedSlot(hostId: String, ownerId: String): RemotePresentationIdentity =
        assertNotNull(
            RemotePresentationIdentity.parseOrNull(host(hostId), RemotePresentationOwnerKind.SLOT, ownerId),
        )

    private fun describe(identity: RemotePresentationIdentity): String =
        "${identity.hostId.value}/${identity.ownerKind.wireName}:${identity.ownerId}"

    @Test
    fun `a fresh store reads nothing and creates no file or directory`() {
        val store = RemotePresentationOrderStorage.openStore(tree.root)
        assertNull(store.read())
        assertFalse(tree.container.exists(), "reading order must create no container")
        assertFalse(tree.document.exists())
        assertTrue(
            tree.root.listFiles().isNullOrEmpty(),
            "reading order must create nothing, found ${tree.root.listFiles()?.map { it.name }}",
        )
        store.close()
    }

    @Test
    fun `identity-only order survives a reopen in its exact order`() {
        val saved = listOf(
            slot("host-1", "A"),
            runtime("host-2", "run-1", "row-1"),
            slot("host-2", "B"),
            runtime("host-1", null, "row-2"),
        )
        val store = RemotePresentationOrderStorage.openStore(tree.root)
        assertEquals(RemotePresentationOrderWriteResult.Published, store.write(saved))
        store.close()

        assertTrue(tree.document.exists())
        val text = tree.document.readText()
        assertEquals(
            setOf("version", "entries", "hostId", "owner", "kind", "id"),
            Regex("\"([A-Za-z]+)\"\\s*:").findAll(text).map { it.groupValues[1] }.toSet(),
            "the order document must express identity keys only",
        )
        assertFalse(text.contains("workspace"))
        assertFalse(text.contains("name"))
        assertFalse(text.contains("viewport"))
        assertFalse(text.contains("transcript"))

        val reopened = RemotePresentationOrderStorage.openStore(tree.root)
        assertEquals(saved.map(::describe), assertNotNull(reopened.read()).map(::describe))
        reopened.close()
    }

    @Test
    fun `more than 64 remote identities persist without a local-slot cap`() {
        val saved = (0 until 80).map { index -> slot("host-${index % 4}", "owner-$index") }
        val store = RemotePresentationOrderStorage.openStore(tree.root)
        assertEquals(RemotePresentationOrderWriteResult.Published, store.write(saved))
        store.close()

        val reopened = RemotePresentationOrderStorage.openStore(tree.root)
        val loaded = assertNotNull(reopened.read())
        assertEquals(80, loaded.size)
        assertEquals(saved.map(::describe), loaded.map(::describe))
        reopened.close()
    }

    @Test
    fun `malformed duplicated unknown-version or unsafe documents are refused untouched`() {
        val store = RemotePresentationOrderStorage.openStore(tree.root)
        store.write(listOf(slot("host-1", "A")))
        store.close()

        val valid = tree.document.readText()
        val rejected = listOf(
            // Unknown version is its own fixed refusal, not a fresh empty order.
            "{\"version\":2,\"entries\":[]}\n" to StorageFailureReason.UNSUPPORTED_VERSION,
            // Closed top-level, entry, and owner key sets.
            "{\"version\":1,\"entries\":[],\"extra\":true}\n" to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"entries\":[{\"hostId\":\"h\",\"owner\":{\"kind\":\"slot\",\"id\":\"x\"},\"extra\":1}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"entries\":[{\"hostId\":\"h\",\"owner\":{\"kind\":\"slot\",\"id\":\"x\",\"extra\":1}}]}\n"
                to StorageFailureReason.MALFORMED,
            // Missing or unknown owner kind, and missing id.
            "{\"version\":1,\"entries\":[{\"hostId\":\"h\",\"owner\":{\"id\":\"x\"}}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"entries\":[{\"hostId\":\"h\",\"owner\":{\"kind\":\"elsewhere\",\"id\":\"x\"}}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"entries\":[{\"hostId\":\"h\",\"owner\":{\"kind\":\"slot\"}}]}\n"
                to StorageFailureReason.MALFORMED,
            // Empty or long host/owner values, and a control character.
            "{\"version\":1,\"entries\":[{\"hostId\":\"\",\"owner\":{\"kind\":\"slot\",\"id\":\"x\"}}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"entries\":[{\"hostId\":\"h\",\"owner\":{\"kind\":\"slot\",\"id\":\"\"}}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"entries\":[{\"hostId\":\"${"h".repeat(129)}\",\"owner\":{\"kind\":\"slot\",\"id\":\"x\"}}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"entries\":[{\"hostId\":\"h\",\"owner\":{\"kind\":\"slot\",\"id\":\"${"o".repeat(647)}\"}}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"entries\":[{\"hostId\":\"h\\ntwo\",\"owner\":{\"kind\":\"slot\",\"id\":\"x\"}}]}\n"
                to StorageFailureReason.MALFORMED,
            // Duplicate presentation identity anywhere in the sequence.
            "{\"version\":1,\"entries\":[" +
                "{\"hostId\":\"h\",\"owner\":{\"kind\":\"slot\",\"id\":\"x\"}}," +
                "{\"hostId\":\"h\",\"owner\":{\"kind\":\"slot\",\"id\":\"x\"}}]}\n" to StorageFailureReason.MALFORMED,
            // Not a JSON object and not an array in the entries position.
            "[]\n" to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"entries\":\"nope\"}\n" to StorageFailureReason.MALFORMED,
            // Empty files are malformed, not an empty order.
            "" to StorageFailureReason.MALFORMED,
        )

        for ((body, reason) in rejected) {
            tree.document.writeText(body)
            val failure = assertFailsWith<StorageException> {
                RemotePresentationOrderStorage.openStore(tree.root)
            }
            assertEquals(reason, failure.reason, body.take(120))
            assertEquals(body, tree.document.readText(), "a refused read must leave the document untouched")
        }

        // Invalid UTF-8 is refused with the same fixed malformed reason and the
        // exact bytes stay in place.
        val invalidUtf8 = byteArrayOf(0x7b, 0xC3.toByte(), 0x28)
        tree.document.writeBytes(invalidUtf8)
        val failure = assertFailsWith<StorageException> { RemotePresentationOrderStorage.openStore(tree.root) }
        assertEquals(StorageFailureReason.MALFORMED, failure.reason)
        assertTrue(tree.document.readBytes().contentEquals(invalidUtf8))

        // Restore the valid document for the next check's clarity.
        tree.document.writeText(valid)
        assertEquals(listOf("host-1/slot:A"), assertNotNull(
            RemotePresentationOrderStorage.openStore(tree.root).use { it.read() },
        ).map(::describe))
    }

    @Test
    fun `isolated surrogates and replacement-like owner ids round-trip distinctly`() {
        val loneHigh = persistedSlot("host-1", "\uD800")
        val loneLow = persistedSlot("host-1", "\uDC00")
        val questionMark = persistedSlot("host-1", "?")
        val literalEscape = persistedSlot("host-1", "\\ud800")
        val pair = persistedSlot("host-1", "😀")
        val saved = listOf(loneHigh, loneLow, questionMark, literalEscape, pair)

        val store = RemotePresentationOrderStorage.openStore(tree.root)
        assertEquals(RemotePresentationOrderWriteResult.Published, store.write(saved))
        store.close()

        val text = tree.document.readText()
        assertTrue(text.contains("\"id\":\"\\ud800\""), "isolated high surrogate must be escaped")
        assertTrue(text.contains("\"id\":\"\\udc00\""), "isolated low surrogate must be escaped")
        assertTrue(text.contains("\"id\":\"?\""), "a literal question mark must remain literal")
        assertTrue(text.contains("\"id\":\"\\\\ud800\""), "literal escape text must stay distinct")

        val reopened = RemotePresentationOrderStorage.openStore(tree.root)
        val loaded = assertNotNull(reopened.read())
        assertEquals(saved.map(::describe), loaded.map(::describe))
        assertEquals("\uD800", loaded[0].ownerId)
        assertEquals("\uDC00", loaded[1].ownerId)
        assertEquals("?", loaded[2].ownerId)
        assertEquals("\\ud800", loaded[3].ownerId)
        assertEquals("😀", loaded[4].ownerId)
        assertEquals(5, loaded.map { it.canonicalKey }.toSet().size)
        reopened.close()
    }

    @Test
    fun `an initialized container without its document fails closed and creates nothing`() {
        val store = RemotePresentationOrderStorage.openStore(tree.root)
        store.write(listOf(slot("host-1", "A")))
        store.close()
        assertTrue(tree.document.delete())

        val failure = assertFailsWith<StorageException> { RemotePresentationOrderStorage.openStore(tree.root) }
        assertEquals(StorageFailureReason.MISSING_INITIALIZED, failure.reason)
        assertFalse(tree.document.exists(), "a refused open must not recreate the document")
    }

    @Test
    fun `a stale handle cannot overwrite newer order and the newer bytes stay intact`() {
        val first = RemotePresentationOrderStorage.openStore(tree.root)
        val second = RemotePresentationOrderStorage.openStore(tree.root)
        val newer = listOf(slot("host-1", "A"), runtime("host-2", "run", "row"))
        assertEquals(RemotePresentationOrderWriteResult.Published, first.write(newer))
        val newerBytes = tree.document.readText()

        val refusal = assertIs<RemotePresentationOrderWriteResult.Refused>(
            second.write(listOf(slot("host-1", "B"))),
        )
        assertEquals(StorageFailureReason.CHANGED, refusal.reason)
        assertFalse(refusal.commitAttempted)
        assertEquals(newerBytes, tree.document.readText(), "a stale handle must not overwrite newer order")
        val fresh = RemotePresentationOrderStorage.openStore(tree.root)
        assertEquals(newer.map(::describe), assertNotNull(fresh.read()).map(::describe))
        fresh.close()
        first.close()
        second.close()
    }

    @Test
    fun `a document replaced by another writer is never written over`() {
        val store = RemotePresentationOrderStorage.openStore(tree.root)
        store.write(listOf(slot("host-1", "A")))
        val foreign = RemotePresentationOrderDocumentCodec.encode(listOf(slot("host-2", "B")))
        tree.document.writeText(foreign)

        val refusal = assertIs<RemotePresentationOrderWriteResult.Refused>(
            store.write(listOf(slot("host-1", "C"))),
        )
        assertEquals(StorageFailureReason.CHANGED, refusal.reason)
        assertEquals(foreign, tree.document.readText())
        store.close()
    }

    @Test
    fun `an order over the source 64 KiB bound is refused without truncation or loss`() {
        val original = listOf(slot("host-1", "A"))
        val store = RemotePresentationOrderStorage.openStore(tree.root)
        store.write(original)
        val originalBytes = tree.document.readText()

        // Each owner id is near the source bound, so this order is larger than the
        // source roster file bound. It must fail truthfully, not publish a prefix.
        val oversized = (0 until 120).map { index ->
            persistedSlot("host-${index % 4}", "o${"x".repeat(600)}-$index")
        }
        val refusal = assertIs<RemotePresentationOrderWriteResult.Refused>(store.write(oversized))
        assertEquals(StorageFailureReason.WRITE_FAILED, refusal.reason)
        assertFalse(refusal.commitAttempted)
        assertEquals(originalBytes, tree.document.readText(), "an oversized save must leave the old order intact")
        assertEquals(original.map(::describe), assertNotNull(store.read()).map(::describe))
        assertEquals(120, oversized.size, "the caller's full in-memory order is not shortened")
        store.close()
    }

    @Test
    fun `a publication failure at the commit poisons the handle`() {
        val fake = FakeOrderStorage(DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted = true))
        val store = FileRemotePresentationOrderStore(fake)
        assertNull(store.read())

        val refusal = assertIs<RemotePresentationOrderWriteResult.Refused>(
            store.write(listOf(slot("host-1", "A"))),
        )
        assertEquals(StorageFailureReason.WRITE_FAILED, refusal.reason)
        assertTrue(refusal.commitAttempted)
        assertFailsWith<StorageException> { store.read() }
        assertFailsWith<StorageException> { store.write(listOf(slot("host-1", "B"))) }
        store.close()
    }

    @Test
    fun `the codec refuses oversized and duplicate input before storage`() {
        val oversized = (0 until 120).map { index ->
            persistedSlot("host-${index % 4}", "o${"x".repeat(600)}-$index")
        }
        assertEquals(
            StorageFailureReason.WRITE_FAILED,
            assertFailsWith<StorageException> {
                RemotePresentationOrderDocumentCodec.encode(oversized)
            }.reason,
        )
        val duplicate = listOf(slot("host-1", "A"), slot("host-1", "A"))
        assertEquals(
            StorageFailureReason.MALFORMED,
            assertFailsWith<StorageException> {
                RemotePresentationOrderDocumentCodec.encode(duplicate)
            }.reason,
        )
    }

    private class FakeOrderStorage(
        private val outcome: DocumentWriteResult,
    ) : SingleDocumentStorage {
        override fun read(): DocumentRead = DocumentRead.Uninitialized
        override fun write(bytes: ByteArray): DocumentWriteResult = outcome
    }

    private class TempTree : AutoCloseable {
        val root: File = Files.createTempDirectory("prg-presentation-store-").toFile()

        val container: File
            get() = File(root, RemotePresentationOrderStorage.CONTAINER_DIR_NAME)

        val document: File
            get() = File(container, RemotePresentationOrderStorage.DOCUMENT_NAME)

        override fun close() {
            root.deleteRecursively()
        }
    }
}
