package io.github.rfairburn.pireviewgate.core.hosts

import java.io.File
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Durable behavior of the settings store: fresh reads create nothing, saved state
 * survives, anything unreadable fails closed with the bytes left untouched, and a
 * handle whose view of the document is stale is refused instead of overwriting.
 */
class FileNetworkSettingsStoreTest {

    private lateinit var tree: TempTree

    @BeforeTest
    fun setUp() {
        tree = TempTree()
    }

    @AfterTest
    fun tearDown() {
        tree.close()
    }

    private fun host(id: String, label: String = "Host $id", port: Int = 8443): ConfiguredHost =
        ConfiguredHost(
            id = HostId.parse(id),
            label = HostLabel.parse(label),
            endpoint = Endpoint("192.168.1.20", port),
        )

    private fun settingsWith(vararg ids: String): NetworkSettings =
        NetworkSettings(hosts = HostCatalog.of(ids.map(::host)))

    @Test
    fun `a fresh client reads nothing and creates no file or directory`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        assertNull(store.read())
        assertFalse(tree.settingsContainer.exists(), "reading defaults must create nothing")
        assertFalse(tree.settingsDocument.exists())
        // Not even a sibling lock file: observation is read-only.
        assertTrue(
            tree.root.listFiles().isNullOrEmpty(),
            "reading defaults must create nothing, found ${tree.root.listFiles()?.map { it.name }}",
        )
        store.close()
    }

    @Test
    fun `defaults are shown in memory and only an explicit mutation persists`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        assertNull(store.read())
        assertFalse(tree.settingsContainer.exists())

        store.write(NetworkSettings.DEFAULTS)
        assertTrue(tree.settingsContainer.exists())
        assertTrue(tree.settingsDocument.exists())
        assertEquals(NetworkSettings.DEFAULTS, store.read())
        store.close()
    }

    @Test
    fun `many hosts with their own facts survive a reopen`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        val settings = NetworkSettings(
            autoReconnect = true,
            viewerRemoteInputEnabled = false,
            hosts = HostCatalog.of(
                listOf(
                    host("a").withPreviouslyConnected(true),
                    host("b", port = 9001).withReconnectSuppressed(true),
                    host("c", port = 9002),
                ),
            ),
        )
        store.write(settings)
        store.close()

        val reopened = FileNetworkSettingsStore(tree.settingsStorage())
        assertEquals(settings, reopened.read())
        reopened.close()
    }

    @Test
    fun `duplicate endpoints stay separate associations across a reopen`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        val shared = Endpoint("10.0.0.5", 9000)
        val settings = NetworkSettings(
            hosts = HostCatalog.of(
                listOf(
                    ConfiguredHost(HostId.parse("one"), HostLabel.parse("One"), shared),
                    ConfiguredHost(HostId.parse("two"), HostLabel.parse("Two"), shared, previouslyConnected = true),
                ),
            ),
        )
        store.write(settings)
        store.close()

        val loaded = FileNetworkSettingsStore(tree.settingsStorage()).read()!!
        assertEquals(2, loaded.hosts.size)
        assertEquals(2, loaded.hosts.findByEndpoint(shared).size)
        assertTrue(loaded.findHost(HostId.parse("two"))!!.previouslyConnected)
        assertFalse(loaded.findHost(HostId.parse("one"))!!.previouslyConnected)
    }

    @Test
    fun `explicit disconnect suppression persists and explicit connect clears it`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        store.write(settingsWith("a", "b"))

        val suppressed = store.read()!!
            .updatingHost(HostId.parse("a")) { it.withReconnectSuppressed(true) }
            .mustSettings()
        store.write(suppressed)
        store.close()

        val reopened = FileNetworkSettingsStore(tree.settingsStorage())
        assertTrue(reopened.read()!!.findHost(HostId.parse("a"))!!.reconnectSuppressed)
        assertFalse(reopened.read()!!.findHost(HostId.parse("b"))!!.reconnectSuppressed)

        val reconnected = reopened.read()!!
            .updatingHost(HostId.parse("a")) { it.withReconnectSuppressed(false) }
            .mustSettings()
        reopened.write(reconnected)
        reopened.close()

        val final = FileNetworkSettingsStore(tree.settingsStorage())
        assertFalse(final.read()!!.findHost(HostId.parse("a"))!!.reconnectSuppressed)
        final.close()
    }

    @Test
    fun `removal clears only that association`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        store.write(settingsWith("a", "b", "c"))

        val afterRemove = store.read()!!.removingHost(HostId.parse("b")).mustSettings()
        store.write(afterRemove)
        store.close()

        val loaded = FileNetworkSettingsStore(tree.settingsStorage()).read()!!
        assertNull(loaded.findHost(HostId.parse("b")))
        assertEquals(HostId.parse("a"), loaded.hosts.hosts[0].id)
        assertEquals(HostId.parse("c"), loaded.hosts.hosts[1].id)
    }

    @Test
    fun `an id-changing update is refused and nothing is written`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        store.write(settingsWith("a", "b"))
        val saved = tree.settingsDocument.readText()

        val mutation = assertIs<SettingsMutation.Failed>(
            store.read()!!.updatingHost(HostId.parse("a")) { it.copy(id = HostId.parse("b")) },
        )
        assertEquals(CatalogFailureReason.INVALID_UPDATE, mutation.reason)
        assertEquals(saved, tree.settingsDocument.readText(), "a refused mutation must not write")
        store.close()
    }

    @Test
    fun `an initialized container without its document fails closed and creates nothing`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        store.write(settingsWith("a"))
        store.close()
        assertTrue(tree.settingsDocument.delete())

        val failure = assertFailsWith<StorageException> { FileNetworkSettingsStore(tree.settingsStorage()) }
        assertEquals(StorageFailureReason.MISSING_INITIALIZED, failure.reason)
        assertFalse(tree.settingsDocument.exists(), "a refused open must not create a document")
    }

    @Test
    fun `a fresh stale handle cannot replace lost initialized configuration`() {
        val stale = FileNetworkSettingsStore(tree.settingsStorage())
        val writer = FileNetworkSettingsStore(tree.settingsStorage())
        writer.write(settingsWith("a"))
        assertTrue(tree.settingsDocument.delete())

        val failure = assertFailsWith<StorageException> { stale.write(settingsWith("b")) }
        assertEquals(StorageFailureReason.MISSING_INITIALIZED, failure.reason)
        assertFalse(tree.settingsDocument.exists(), "a refused publication must not recreate the document")
    }

    @Test
    fun `a malformed document is refused and left byte for byte untouched`() {
        val garbage = "{\"version\":1,\"autoReconnect\":false,\"hosts\":\"not a list\"}"
        tree.settingsContainer.mkdirs()
        tree.settingsDocument.writeText(garbage)

        val failure = assertFailsWith<StorageException> { FileNetworkSettingsStore(tree.settingsStorage()) }
        assertEquals(StorageFailureReason.MALFORMED, failure.reason)
        assertEquals(garbage, tree.settingsDocument.readText())
    }

    @Test
    fun `an old document without the saved timeout reads as sixty and is not rewritten`() {
        val old = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]}\n"
        tree.settingsContainer.mkdirs()
        tree.settingsDocument.writeText(old)

        val store = FileNetworkSettingsStore(tree.settingsStorage())
        val loaded = store.read()!!
        store.close()

        assertEquals(60, loaded.savedFirstReplyTimeoutSeconds)
        assertEquals(old, tree.settingsDocument.readText(), "reading defaults must not create a migration")
    }

    @Test
    fun `an old document without the debug flag reads as off and is not rewritten`() {
        val old = "{\"version\":1,\"autoReconnect\":false,\"hosts\":[]}\n"
        tree.settingsContainer.mkdirs()
        tree.settingsDocument.writeText(old)

        val store = FileNetworkSettingsStore(tree.settingsStorage())
        val loaded = store.read()!!
        store.close()

        assertFalse(loaded.debugInputMessagingEnabled, "an absent key is off, never an inferred on")
        assertEquals(old, tree.settingsDocument.readText(), "reading defaults must not create a migration")
    }

    @Test
    fun `an enabled debug flag survives a reopen and turning it off again stays sparse`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        val enabled = NetworkSettings(
            autoReconnect = true,
            viewerRemoteInputEnabled = false,
            hosts = HostCatalog.of(
                listOf(
                    host("a").withPreviouslyConnected(true),
                    host("b", port = 9001).withReconnectSuppressed(true),
                ),
            ),
            savedFirstReplyTimeoutSeconds = 120,
            debugInputMessagingEnabled = true,
        )
        store.write(enabled)
        store.close()

        val reopened = FileNetworkSettingsStore(tree.settingsStorage())
        assertEquals(enabled, reopened.read())
        assertTrue(
            tree.settingsDocument.readText().contains("\"debugInputMessagingEnabled\":true"),
            tree.settingsDocument.readText(),
        )

        val disabled = reopened.read()!!.withDebugInputMessagingEnabled(false)
        reopened.write(disabled)
        reopened.close()

        val final = FileNetworkSettingsStore(tree.settingsStorage())
        assertEquals(disabled, final.read())
        assertFalse(
            tree.settingsDocument.readText().contains("debugInputMessagingEnabled"),
            "returning to the off default writes no key at all: ${tree.settingsDocument.readText()}",
        )
        // Every sibling fact survived both publications.
        assertTrue(final.read()!!.autoReconnect)
        assertFalse(final.read()!!.viewerRemoteInputEnabled)
        assertEquals(120, final.read()!!.savedFirstReplyTimeoutSeconds)
        assertEquals(listOf(HostId.parse("a"), HostId.parse("b")), final.read()!!.hosts.ids)
        assertTrue(final.read()!!.findHost(HostId.parse("a"))!!.previouslyConnected)
        assertTrue(final.read()!!.findHost(HostId.parse("b"))!!.reconnectSuppressed)
        final.close()
    }

    @Test
    fun `an empty document is malformed rather than empty defaults`() {
        tree.settingsContainer.mkdirs()
        tree.settingsDocument.writeText("")

        val failure = assertFailsWith<StorageException> { FileNetworkSettingsStore(tree.settingsStorage()) }
        assertEquals(StorageFailureReason.MALFORMED, failure.reason)
    }

    @Test
    fun `an unknown version is refused and left untouched`() {
        val newer = "{\"version\":2,\"autoReconnect\":false,\"hosts\":[]}"
        tree.settingsContainer.mkdirs()
        tree.settingsDocument.writeText(newer)

        val failure = assertFailsWith<StorageException> { FileNetworkSettingsStore(tree.settingsStorage()) }
        assertEquals(StorageFailureReason.UNSUPPORTED_VERSION, failure.reason)
        assertEquals(newer, tree.settingsDocument.readText())
    }

    @Test
    fun `an oversized document is refused as malformed`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        store.write(settingsWith("a", "b", "c"))
        store.close()
        val saved = tree.settingsDocument.readText()

        val failure = assertFailsWith<StorageException> { FileNetworkSettingsStore(tree.settingsStorage(maxBytes = 32)) }
        assertEquals(StorageFailureReason.MALFORMED, failure.reason)
        assertEquals(saved, tree.settingsDocument.readText())
    }

    @Test
    fun `a closed handle refuses instead of inventing state`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        store.write(settingsWith("a"))
        store.close()

        assertEquals(StorageFailureReason.UNAVAILABLE, assertFailsWith<StorageException> { store.read() }.reason)
        assertEquals(
            StorageFailureReason.UNAVAILABLE,
            assertFailsWith<StorageException> { store.write(NetworkSettings.DEFAULTS) }.reason,
        )
    }

    @Test
    fun `two handles opened before any save cannot both publish`() {
        val first = FileNetworkSettingsStore(tree.settingsStorage())
        val second = FileNetworkSettingsStore(tree.settingsStorage())

        first.write(settingsWith("a"))
        val failure = assertFailsWith<StorageException> { second.write(settingsWith("b")) }
        assertEquals(StorageFailureReason.CHANGED, failure.reason)

        val loaded = FileNetworkSettingsStore(tree.settingsStorage()).read()!!
        assertEquals(listOf(HostId.parse("a")), loaded.hosts.ids)
    }

    @Test
    fun `a handle whose view went stale cannot overwrite newer configuration`() {
        val first = FileNetworkSettingsStore(tree.settingsStorage())
        first.write(settingsWith("a"))
        val second = FileNetworkSettingsStore(tree.settingsStorage())
        assertEquals(1, second.read()!!.hosts.size)

        first.write(settingsWith("a", "b"))

        val failure = assertFailsWith<StorageException> { second.write(settingsWith("a", "b", "c")) }
        assertEquals(StorageFailureReason.CHANGED, failure.reason)

        val loaded = FileNetworkSettingsStore(tree.settingsStorage()).read()!!
        assertEquals(listOf(HostId.parse("a"), HostId.parse("b")), loaded.hosts.ids)
    }

    @Test
    fun `a document replaced by someone else is never written over`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        store.write(settingsWith("a"))

        val foreign = "{\"version\":1,\"autoReconnect\":true,\"hosts\":[]}\n"
        tree.settingsDocument.writeText(foreign)

        val failure = assertFailsWith<StorageException> { store.write(settingsWith("a", "b")) }
        assertEquals(StorageFailureReason.CHANGED, failure.reason)
        assertEquals(foreign, tree.settingsDocument.readText())
    }

    @Test
    fun `a document removed by someone else is never written over`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        store.write(settingsWith("a"))
        assertTrue(tree.settingsDocument.delete())

        val failure = assertFailsWith<StorageException> { store.write(settingsWith("a", "b")) }
        assertEquals(StorageFailureReason.CHANGED, failure.reason)
        assertFalse(tree.settingsDocument.exists())
    }

    @Test
    fun `a failure at the commit poisons the handle permanently`() {
        val fake = FakeDocumentStorage()
        val store = FileNetworkSettingsStore(fake)
        assertNull(store.read())

        fake.outcome = DocumentWriteResult.Published
        store.write(settingsWith("a"))
        assertEquals(1, store.read()!!.hosts.size)

        // A commit whose visibility cannot be established: memory may not equal disk.
        fake.outcome = DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted = true)
        assertEquals(
            StorageFailureReason.WRITE_FAILED,
            assertFailsWith<StorageException> { store.write(NetworkSettings.DEFAULTS) }.reason,
        )

        assertEquals(StorageFailureReason.UNAVAILABLE, assertFailsWith<StorageException> { store.read() }.reason)
        assertEquals(
            StorageFailureReason.UNAVAILABLE,
            assertFailsWith<StorageException> { store.write(NetworkSettings.DEFAULTS) }.reason,
        )
    }

    @Test
    fun `a refusal before the commit leaves the handle usable and the document intact`() {
        val fake = FakeDocumentStorage()
        val store = FileNetworkSettingsStore(fake)
        fake.outcome = DocumentWriteResult.Published
        store.write(settingsWith("a"))

        fake.outcome = DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED)
        assertFailsWith<StorageException> { store.write(NetworkSettings.DEFAULTS) }

        // The previous document still stands, and the handle keeps working.
        assertEquals(1, store.read()!!.hosts.size)
        fake.outcome = DocumentWriteResult.Published
        store.write(settingsWith("a", "b"))
        assertEquals(2, store.read()!!.hosts.size)
    }

    @Test
    fun `a symlinked document is refused as unsafe`() {
        val store = FileNetworkSettingsStore(tree.settingsStorage())
        store.write(settingsWith("a"))
        store.close()

        val real = File(tree.root, "real-settings.json")
        tree.settingsDocument.copyTo(real)
        if (!tree.settingsDocument.delete()) return
        if (!tree.settingsDocument.createNewSymlinkTo(real.absolutePath)) {
            real.copyTo(tree.settingsDocument, overwrite = true)
            return
        }

        val failure = assertFailsWith<StorageException> { FileNetworkSettingsStore(tree.settingsStorage()) }
        assertEquals(StorageFailureReason.UNSAFE_OBJECT, failure.reason)
        assertTrue(real.exists(), "the refusal must not disturb anything")
    }

    private fun SettingsMutation.mustSettings(): NetworkSettings = when (this) {
        is SettingsMutation.Ok -> settings
        is SettingsMutation.Failed -> fail("settings mutation refused: ${reason.name}")
    }

    private class FakeDocumentStorage : SingleDocumentStorage {
        val writes = mutableListOf<ByteArray>()
        var outcome: DocumentWriteResult = DocumentWriteResult.Published

        override fun read(): DocumentRead = DocumentRead.Uninitialized

        override fun write(bytes: ByteArray): DocumentWriteResult {
            writes.add(bytes)
            return outcome
        }
    }
}

/** Creates a POSIX symlink, or reports that this platform cannot. */
private fun File.createNewSymlinkTo(target: String): Boolean = try {
    java.nio.file.Files.createSymbolicLink(toPath(), java.nio.file.Paths.get(target))
    true
} catch (_: Exception) {
    false
}
