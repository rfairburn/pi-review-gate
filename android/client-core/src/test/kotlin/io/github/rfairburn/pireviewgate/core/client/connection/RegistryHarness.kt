package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.ClientStoragePaths
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.FileNetworkSettingsStore
import io.github.rfairburn.pireviewgate.core.hosts.HostCatalog
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettingsStore
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.TempTree
import io.github.rfairburn.pireviewgate.core.identity.FileHostPinStore
import io.github.rfairburn.pireviewgate.core.identity.HostPinStore
import io.github.rfairburn.pireviewgate.core.identity.PeerKey
import io.github.rfairburn.pireviewgate.core.identity.PinClearResult
import io.github.rfairburn.pireviewgate.core.identity.PinRead
import io.github.rfairburn.pireviewgate.core.identity.PinRecordResult
import io.github.rfairburn.pireviewgate.core.transport.PeerEndpoint
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportBounds
import java.io.File
import kotlinx.coroutines.CoroutineDispatcher

/**
 * One real storage tree, one fake transport factory, and a registry wired the
 * way production wires it.
 *
 * Settings and trust are the actual file-backed stores over a throwaway private
 * directory, so these checks exercise the real SPKI pin round-trip and the real
 * durable settings document. Only the transport is fake, and only here: nothing
 * a test installs is reachable from a product default.
 */
internal class RegistryHarness(
    private val bounds: File = createTempDir("prg-registry-"),
) : AutoCloseable {
    private val tree = TempTreeAt(bounds)
    private val innerSettings = FileNetworkSettingsStore(tree.settingsStorage())
    private val innerPins = FileHostPinStore(tree.pinStorage())

    val settings = FlakySettingsStore(innerSettings)
    val pins = FlakyPinStore(innerPins)
    val identity = FakeIdentityStore()
    val listener = RecordingListener()

    /** The committed foreground frame. Tests set [FakeCommittedPrompt.presenting]. */
    val prompt = FakeCommittedPrompt()

    /** Every transport this registry created, in creation order. */
    val transports = java.util.concurrent.CopyOnWriteArrayList<FakeTransport>()

    private val serverKeys = HashMap<String, io.github.rfairburn.pireviewgate.core.transport.PeerKey>()
    private val defaults = HashMap<String, FakeTransport.() -> Unit>()

    private val factory = HostTransportFactory { endpoint: PeerEndpoint, _: PeerTransportBounds ->
        val created = FakeTransport(
            serverKeys.getOrPut(endpoint.host) { RegistryFixtures.transportKey() },
            endpoint,
        )
        defaults[endpoint.host]?.invoke(created)
        transports += created
        created
    }

    /** Make the peer at [endpoint] prove [key] on every future handshake. */
    fun peerKeyFor(endpoint: Endpoint, key: io.github.rfairburn.pireviewgate.core.transport.PeerKey) {
        serverKeys[endpoint.host] = key
    }

    /** Configure every transport for this endpoint the moment it is created. */
    fun onTransport(endpoint: Endpoint, configure: FakeTransport.() -> Unit) {
        defaults[endpoint.host] = configure
    }

    /** The peer identity the fake transport at [endpoint] proves. */
    fun peerKey(endpoint: Endpoint): io.github.rfairburn.pireviewgate.core.transport.PeerKey =
        serverKeys.getOrPut(endpoint.host) { RegistryFixtures.transportKey() }

    /** The same identity in the durable representation, mapped through exact SPKI. */
    fun storedPeerKey(endpoint: Endpoint): PeerKey = PeerKeyBridge.toStored(peerKey(endpoint))

    /** Remember a matching key for each host through the real pin store. */
    fun seedPins(hosts: List<ConfiguredHost>) {
        hosts.forEach { innerPins.record(it.id, it.endpoint, storedPeerKey(it.endpoint)) }
    }

    /** Publish a saved configuration before the registry starts. */
    fun seedSettings(next: NetworkSettings) = innerSettings.write(next)

    /**
     * A registry over freshly opened stores naming the same bytes: the closest
     * thing to a process restart that keeps durable state.
     */
    fun restartingRegistry(
        dispatcher: CoroutineDispatcher,
        policy: HostConnectionPolicy = RegistryFixtures.fastPolicy(),
    ): HostConnectionRegistry = HostConnectionRegistry(
        settingsStore = FlakySettingsStore(FileNetworkSettingsStore(tree.settingsStorage())),
        pinStore = FlakyPinStore(FileHostPinStore(tree.pinStorage())),
        identityStore = identity,
        promptValidator = prompt,
        transportFactory = factory,
        networkAccess = NetworkAccessAdmission.UNRESTRICTED,
        policy = policy,
        dispatcher = dispatcher,
    )

    fun registry(
        dispatcher: CoroutineDispatcher,
        policy: HostConnectionPolicy = RegistryFixtures.fastPolicy(),
        networkAccess: NetworkAccessAdmission = NetworkAccessAdmission.UNRESTRICTED,
    ): HostConnectionRegistry = HostConnectionRegistry(
        settingsStore = settings,
        pinStore = pins,
        identityStore = identity,
        promptValidator = prompt,
        transportFactory = factory,
        networkAccess = networkAccess,
        policy = policy,
        dispatcher = dispatcher,
    )

    /** Record a remembered key for one association through the real store. */
    fun seedPin(hostId: HostId, endpoint: Endpoint, key: PeerKey): PinRecordResult =
        innerPins.record(hostId, endpoint, key)

    fun readPin(hostId: HostId, endpoint: Endpoint): PinRead = innerPins.read(hostId, endpoint)

    fun savedSettings(): NetworkSettings? = innerSettings.read()

    fun savedCatalog(): HostCatalog = innerSettings.read()?.hosts ?: HostCatalog.EMPTY

    override fun close() {
        innerPins.close()
        innerSettings.close()
        bounds.deleteRecursively()
    }
}

/** A settings store that can be made to refuse, over the real one. */
internal class FlakySettingsStore(private val delegate: NetworkSettingsStore) : NetworkSettingsStore {
    var refuseReads: StorageFailureReason? = null
    var refuseWrites: StorageFailureReason? = null
    var writes: Int = 0
        private set

    /**
     * Invoked after a read has produced its document but before the caller sees it.
     * A test uses this to hold a reload with a stale document already in hand,
     * which is the only way to reproduce it adopting a copy older than a
     * concurrent publication.
     */
    var onRead: (() -> Unit)? = null

    /**
     * Invoked inside a write, before it reaches the real store. A test uses this
     * to hold one publication open while another is attempted, which is exactly
     * how a lost update would be produced.
     */
    var onWrite: (() -> Unit)? = null

    /** True if two publications were ever inside the store at the same time. */
    var overlapped: Boolean = false
        private set

    private val inside = java.util.concurrent.atomic.AtomicBoolean(false)

    override fun read(): NetworkSettings? {
        refuseReads?.let { throw StorageException(it) }
        val value = delegate.read()
        onRead?.invoke()
        return value
    }

    override fun write(next: NetworkSettings) {
        writes += 1
        if (inside.getAndSet(true)) overlapped = true
        try {
            onWrite?.invoke()
            refuseWrites?.let { throw StorageException(it) }
            delegate.write(next)
        } finally {
            inside.set(false)
        }
    }

    override fun close() = delegate.close()
}

/**
 * The foreground UI's committed-prompt state, as the registry sees it.
 *
 * This is the seam the real Activity adapter occupies: it answers whether the
 * snapshot frame presenting a given confirmation is the one actually on screen.
 * Tests flip it to model a dialog being replaced or dismissed while the app stays
 * in the foreground.
 */
internal class FakeCommittedPrompt : CommittedPromptValidator {
    /** The single prompt the committed frame presents, or `null` for none. */
    @Volatile
    var presenting: Long? = null

    var asked: Int = 0
        private set

    override fun isCommitted(consent: HostKeyConsent): Boolean {
        asked += 1
        return presenting == consent.consentId
    }
}

/** A pin store that can be made to refuse, over the real one. */
internal class FlakyPinStore(private val delegate: HostPinStore) : HostPinStore {
    var refuseReads: StorageFailureReason? = null
    var refuseRecords: StorageFailureReason? = null
    var refuseClears: StorageFailureReason? = null

    /**
     * Invoked inside a record, before it reaches the real store. A test uses this
     * to hold a pairing commit in flight while the association is removed or the
     * app is backgrounded — the race a pre-write check alone cannot see.
     */
    var onRecord: (() -> Unit)? = null

    /** How many records reached the real store, in arrival order. */
    val recorded = mutableListOf<String>()

    /** How many clears reached the real store. A pairing commit must never add one. */
    val clears = mutableListOf<String>()

    override fun read(hostId: HostId, endpoint: Endpoint): PinRead {
        refuseReads?.let { throw StorageException(it) }
        return delegate.read(hostId, endpoint)
    }

    override fun record(hostId: HostId, endpoint: Endpoint, observed: PeerKey): PinRecordResult {
        refuseRecords?.let { throw StorageException(it) }
        onRecord?.invoke()
        recorded += "${hostId.value}@${endpoint.host}:${endpoint.port}"
        return delegate.record(hostId, endpoint, observed)
    }

    override fun clear(hostId: HostId): PinClearResult {
        refuseClears?.let { throw StorageException(it) }
        clears += hostId.value
        return delegate.clear(hostId)
    }

    override fun snapshot(): List<io.github.rfairburn.pireviewgate.core.identity.HostPin> {
        refuseReads?.let { throw StorageException(it) }
        return delegate.snapshot()
    }

    override fun close() = delegate.close()
}

/** Records every channel handoff, so a test can assert on the typed events. */
internal class RecordingListener : HostConnectionListener {
    // Callbacks arrive on whatever thread opened or retired the channel, so the
    // recording has to be safe to read from a test thread as well.
    val available = java.util.concurrent.CopyOnWriteArrayList<HostAppChannel>()
    val content = java.util.concurrent.CopyOnWriteArrayList<HostContentChannel>()
    val lost = java.util.concurrent.CopyOnWriteArrayList<HostChannelLost>()

    override fun onAppChannelAvailable(channel: HostAppChannel) {
        available += channel
    }

    override fun onContentChannelAvailable(channel: HostContentChannel) {
        content += channel
    }

    override fun onChannelLost(lost: HostChannelLost) {
        this.lost += lost
    }
}

/**
 * The shipped [TempTree] layout, rooted at a directory the harness controls so
 * a "restart" can reopen the same bytes.
 */
private class TempTreeAt(val root: File) {
    fun file(vararg segments: String): File = segments.fold(root) { parent, segment -> File(parent, segment) }

    fun settingsStorage(): io.github.rfairburn.pireviewgate.core.hosts.FileSingleDocumentStorage =
        io.github.rfairburn.pireviewgate.core.hosts.FileSingleDocumentStorage(
            container = file(ClientStoragePaths.SETTINGS_CONTAINER_DIR_NAME),
            fileName = ClientStoragePaths.SETTINGS_DOCUMENT_NAME,
            maxDocumentBytes = io.github.rfairburn.pireviewgate.core.hosts.NetworkSettingsDocumentCodec
                .MAX_SETTINGS_DOCUMENT_BYTES,
        )

    fun pinStorage(): io.github.rfairburn.pireviewgate.core.hosts.FileSingleDocumentStorage =
        io.github.rfairburn.pireviewgate.core.hosts.FileSingleDocumentStorage(
            container = file(ClientStoragePaths.TRUST_CONTAINER_DIR_NAME),
            fileName = ClientStoragePaths.TRUST_DOCUMENT_NAME,
            maxDocumentBytes = io.github.rfairburn.pireviewgate.core.identity.HostPinDocumentCodec
                .MAX_PIN_DOCUMENT_BYTES,
        )
}

@Suppress("DEPRECATION")
private fun createTempDir(prefix: String): File =
    java.nio.file.Files.createTempDirectory(prefix).toFile()
