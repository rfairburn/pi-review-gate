package io.github.rfairburn.pireviewgate.core.identity

import io.github.rfairburn.pireviewgate.core.hosts.ClientStoragePaths
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.ExclusiveLock
import io.github.rfairburn.pireviewgate.core.hosts.FileExclusiveLock
import io.github.rfairburn.pireviewgate.core.hosts.FileNetworkSettingsStore
import io.github.rfairburn.pireviewgate.core.hosts.FileSingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.HostCatalog
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.hosts.InProcessLock
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.hosts.SingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.TempTree
import java.io.File
import java.security.cert.X509Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.X509ExtendedKeyManager
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Initialization policy for this device's own identity: two independent facts decide
 * presence, nothing regenerates a lost identity, and one serialized section makes
 * "check then generate" safe against a second concurrent Connect.
 */
class PeerIdentityLifecycleTest {

    private lateinit var tree: TempTree

    @BeforeTest
    fun setUp() {
        tree = TempTree()
    }

    @AfterTest
    fun tearDown() {
        tree.close()
    }

    private val label = HostLabel.parse("Pixel in the kitchen")

    private class FakeHandle(override val key: PeerKey) : PeerIdentityHandle {
        override val certificateChain: List<X509Certificate> = emptyList()
        override fun newKeyManager(): X509ExtendedKeyManager =
            throw UnsupportedOperationException("no transport exists yet")
    }

    /** A key store that counts generations and can be made slow on purpose. */
    private class FakeMaterial : PeerIdentityMaterialSeam {
        val entries = java.util.concurrent.ConcurrentHashMap<String, PeerIdentityHandle>()
        val generations = AtomicInteger(0)
        var generationDelayMs = 0L

        override fun observe(alias: String): MaterialObservation =
            entries[alias]?.let { MaterialObservation.Present(it) } ?: MaterialObservation.Absent

        override fun generate(alias: String, label: HostLabel) {
            val taken = generations.incrementAndGet()
            if (generationDelayMs > 0L) Thread.sleep(generationDelayMs)
            entries[alias] = FakeHandle(TestKeys.key(500 + taken))
        }
    }

    private class FakeEvidence : PeerIdentityEvidenceStore {
        var stored: PeerIdentityEvidence? = null
        var readRefusal: StorageFailureReason? = null
        val publishes = AtomicInteger(0)

        override fun read(): EvidenceRead {
            readRefusal?.let { return EvidenceRead.Refused(it) }
            return stored?.let { EvidenceRead.Present(it) } ?: EvidenceRead.Absent
        }

        override fun publishExclusive(evidence: PeerIdentityEvidence): EvidencePublishResult {
            if (stored != null) return EvidencePublishResult.Refused(StorageFailureReason.CHANGED)
            stored = evidence
            publishes.incrementAndGet()
            return EvidencePublishResult.Published
        }
    }

    private fun newLifecycle(
        material: FakeMaterial,
        evidence: FakeEvidence,
        lock: ExclusiveLock = InProcessLock(),
    ): PeerIdentityStore = PeerIdentityLifecycle(ALIAS, material, evidence, lock)

    @Test
    fun `file-backed observations create no storage paths`() {
        val root = File(tree.root, "fresh-storage")
        val material = FakeMaterial()
        val settings = FileNetworkSettingsStore(ClientStoragePaths.settingsStorage(root))
        val pins = FileHostPinStore(ClientStoragePaths.pinStorage(root))
        val identity = PeerIdentityLifecycle(
            ALIAS,
            material,
            FilePeerIdentityEvidenceStore(ClientStoragePaths.identityEvidenceStorage(root)),
            ClientStoragePaths.identityInitializationLock(root),
        )

        assertEquals(null, settings.read())
        assertTrue(pins.snapshot().isEmpty())
        assertEquals(PeerIdentityStatus.NeverInitialized, identity.status())
        assertFailsWith<IdentityException> { identity.current() }
        assertEquals(0, material.generations.get())

        settings.close()
        pins.close()
        identity.close()
        assertFalse(root.exists(), "observations must not create even lock files")
    }

    @Test
    fun `a deliberate write is what first creates storage`() {
        val root = File(tree.root, "written-storage")
        val settings = FileNetworkSettingsStore(ClientStoragePaths.settingsStorage(root))
        assertFalse(root.exists())

        val host = ConfiguredHost(
            id = HostId.parse("a"),
            label = HostLabel.parse("A"),
            endpoint = Endpoint("10.0.0.1", 8443),
        )
        settings.write(NetworkSettings(hosts = HostCatalog.of(listOf(host))))

        assertTrue(root.exists())
        settings.close()
    }

    @Test
    fun `a fresh device generates once and records evidence`() {
        val material = FakeMaterial()
        val evidence = FakeEvidence()
        val store = newLifecycle(material, evidence)

        assertEquals(PeerIdentityStatus.NeverInitialized, store.status())
        assertEquals(0, material.generations.get())

        val handle = store.initialize(label)
        assertEquals(1, material.generations.get())
        assertEquals(1, evidence.publishes.get())
        assertEquals(handle.key, evidence.stored?.key)
        assertEquals(PeerIdentityStatus.Ready, store.status())
        assertEquals(handle.key, store.current().key)
    }

    @Test
    fun `a second initialize never generates a replacement identity`() {
        val material = FakeMaterial()
        val evidence = FakeEvidence()
        val store = newLifecycle(material, evidence)
        val first = store.initialize(label)

        val failure = assertFailsWith<IdentityException> { store.initialize(label) }
        assertEquals(IdentityFailureReason.ALREADY_INITIALIZED, failure.reason)
        assertEquals(1, material.generations.get())
        assertEquals(first.key, store.current().key)
    }

    @Test
    fun `a lost key entry is refused, never regenerated`() {
        val material = FakeMaterial()
        val evidence = FakeEvidence()
        val store = newLifecycle(material, evidence)
        val initialized = store.initialize(label)

        // The platform entry disappears while the evidence remains.
        material.entries.clear()

        assertEquals(
            PeerIdentityStatus.Refused(IdentityFailureReason.MISSING_INITIALIZED),
            store.status(),
        )
        assertEquals(
            IdentityFailureReason.MISSING_INITIALIZED,
            assertFailsWith<IdentityException> { store.initialize(label) }.reason,
        )
        assertEquals(
            IdentityFailureReason.MISSING_INITIALIZED,
            assertFailsWith<IdentityException> { store.current() }.reason,
        )
        assertEquals(1, material.generations.get(), "no replacement key may be minted")
        assertEquals(initialized.key, evidence.stored?.key)
    }

    @Test
    fun `a key entry with no recorded initialization is refused`() {
        val material = FakeMaterial()
        material.entries[ALIAS] = FakeHandle(TestKeys.key(777))
        val evidence = FakeEvidence()
        val store = newLifecycle(material, evidence)

        assertEquals(
            PeerIdentityStatus.Refused(IdentityFailureReason.INCONSISTENT_EVIDENCE),
            store.status(),
        )
        assertEquals(
            IdentityFailureReason.INCONSISTENT_EVIDENCE,
            assertFailsWith<IdentityException> { store.initialize(label) }.reason,
        )
        assertEquals(0, material.generations.get())
    }

    @Test
    fun `evidence naming another key is refused rather than adopted`() {
        val material = FakeMaterial()
        val evidence = FakeEvidence()
        val store = newLifecycle(material, evidence)
        store.initialize(label)

        // The entry now proves a different key than the one recorded.
        material.entries[ALIAS] = FakeHandle(TestKeys.key(888))

        assertEquals(
            PeerIdentityStatus.Refused(IdentityFailureReason.INCONSISTENT_EVIDENCE),
            store.status(),
        )
        assertEquals(
            IdentityFailureReason.INCONSISTENT_EVIDENCE,
            assertFailsWith<IdentityException> { store.current() }.reason,
        )
        assertEquals(1, material.generations.get())
    }

    @Test
    fun `unreadable evidence is refused rather than treated as fresh`() {
        val material = FakeMaterial()
        val evidence = FakeEvidence().apply { readRefusal = StorageFailureReason.MALFORMED }
        val store = newLifecycle(material, evidence)

        assertEquals(
            PeerIdentityStatus.Refused(IdentityFailureReason.INCONSISTENT_EVIDENCE),
            store.status(),
        )
        assertEquals(
            IdentityFailureReason.INCONSISTENT_EVIDENCE,
            assertFailsWith<IdentityException> { store.initialize(label) }.reason,
        )
        assertEquals(0, material.generations.get())
    }

    @Test
    fun `concurrent initialization generates exactly once`() {
        val material = FakeMaterial().apply { generationDelayMs = 80L }
        val evidence = FakeEvidence()
        val lock = InProcessLock()
        val first = newLifecycle(material, evidence, lock)
        val second = newLifecycle(material, evidence, lock)

        val start = CountDownLatch(1)
        val outcomes = java.util.concurrent.ConcurrentLinkedQueue<String>()
        val threads = listOf(first, second).map { store ->
            Thread {
                start.await()
                outcomes.add(
                    try {
                        store.initialize(label).key.keyId
                    } catch (error: IdentityException) {
                        "refused:${error.reason.name}"
                    },
                )
            }.apply { start() }
        }
        start.countDown()
        threads.forEach { it.join(10_000) }

        assertEquals(2, outcomes.size)
        assertEquals(1, material.generations.get(), "only one generation may occur")
        assertEquals(1, evidence.publishes.get())
        val succeeded = outcomes.filterNot { it.startsWith("refused:") }
        assertEquals(1, succeeded.size)
        assertTrue(outcomes.contains("refused:${IdentityFailureReason.ALREADY_INITIALIZED.name}"))
        // Both callers now agree on one identity.
        assertEquals(succeeded.single(), first.current().key.keyId)
        assertEquals(succeeded.single(), second.current().key.keyId)
    }

    @Test
    fun `a file lock serializes separate adapter instances on the same path`() {
        val lockFile = File(tree.root, "identity-initialization.lock")
        val concurrent = AtomicInteger(0)
        val maxObserved = AtomicInteger(0)

        val threads = (1..4).map { index ->
            Thread {
                // Each thread uses its own adapter-shaped lock instance: only the
                // shared path can serialize them.
                FileExclusiveLock(lockFile).withLock {
                    val now = concurrent.incrementAndGet()
                    maxObserved.updateAndGet { if (it > now) it else now }
                    Thread.sleep(25L)
                    concurrent.decrementAndGet()
                }
            }.apply { start() }
        }
        threads.forEach { it.join(10_000) }

        assertEquals(1, maxObserved.get(), "holders must not overlap")
    }

    @Test
    fun `file evidence publication is exclusive and the document is public identity only`() {
        val storage: SingleDocumentStorage = FileSingleDocumentStorage(
            container = File(tree.root, ClientStoragePaths.IDENTITY_CONTAINER_DIR_NAME),
            fileName = ClientStoragePaths.IDENTITY_EVIDENCE_DOCUMENT_NAME,
            maxDocumentBytes = PeerIdentityEvidenceCodec.MAX_EVIDENCE_DOCUMENT_BYTES,
        )
        val store = FilePeerIdentityEvidenceStore(storage)

        assertEquals(EvidenceRead.Absent, store.read())
        assertFalse(tree.file(ClientStoragePaths.IDENTITY_CONTAINER_DIR_NAME).exists())

        val key = TestKeys.key(991)
        assertEquals(
            EvidencePublishResult.Published,
            store.publishExclusive(PeerIdentityEvidence(key)),
        )
        val read = assertIs<EvidenceRead.Present>(store.read())
        assertEquals(key, read.evidence.key)

        assertEquals(
            EvidencePublishResult.Refused(StorageFailureReason.CHANGED),
            store.publishExclusive(PeerIdentityEvidence(TestKeys.key(992))),
        )
        assertEquals(key, assertIs<EvidenceRead.Present>(FilePeerIdentityEvidenceStore(storage).read()).evidence.key)

        val text = tree.file(
            ClientStoragePaths.IDENTITY_CONTAINER_DIR_NAME,
            ClientStoragePaths.IDENTITY_EVIDENCE_DOCUMENT_NAME,
        ).readText()
        assertTrue(text.contains("\"keyId\""))
        assertTrue(!text.contains("PRIVATE") && !text.contains("BEGIN") && !text.contains("pkcs"))
    }

    @Test
    fun `evidence schema is closed and versioned`() {
        val key = TestKeys.key(993)
        val encoded = PeerIdentityEvidenceCodec.encode(PeerIdentityEvidence(key))
        val decoded = assertIs<EvidenceDecodeResult.Valid>(PeerIdentityEvidenceCodec.decode(encoded))
        assertEquals(key, decoded.evidence.key)

        assertEquals(
            StorageFailureReason.MALFORMED,
            PeerIdentityEvidenceCodec.decode("{\"version\":1,\"keyId\":\"${key.keyId}\"}").reason(),
        )
        assertEquals(
            StorageFailureReason.MALFORMED,
            PeerIdentityEvidenceCodec.decode(encoded.trim() + ",\"extra\":1}").reason(),
        )
        assertEquals(
            StorageFailureReason.UNSUPPORTED_VERSION,
            PeerIdentityEvidenceCodec.decode(encoded.replace("\"version\":1", "\"version\":2")).reason(),
        )
    }

    private fun EvidenceDecodeResult.reason(): StorageFailureReason = when (this) {
        is EvidenceDecodeResult.Invalid -> reason
        is EvidenceDecodeResult.Valid -> throw AssertionError("expected refused evidence")
    }

    private companion object {
        const val ALIAS = "test-peer-identity"
    }
}
