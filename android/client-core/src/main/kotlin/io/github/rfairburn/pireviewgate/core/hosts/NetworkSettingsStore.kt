package io.github.rfairburn.pireviewgate.core.hosts

import java.io.File

/**
 * Durable client network configuration.
 *
 * `read()` returns `null` only while nothing has ever been saved. The caller then
 * shows [NetworkSettings.DEFAULTS] in memory: reading a fresh configuration creates
 * no directory, no document, and no key material.
 *
 * Once the dedicated container exists, its document is authoritative. A container
 * without a valid document, an unknown version, a schema deviation, or an unsafe
 * object fails closed with [StorageException] and leaves every byte untouched. It is
 * never reported as empty and never rewritten with defaults.
 *
 * A publication failure before the commit leaves the previous document intact and
 * the handle usable. A failure at or after the commit poisons the handle for good:
 * later reads and writes refuse instead of claiming memory equals disk. There is no
 * reset, repair, backup search, or key rotation anywhere in this lifecycle.
 *
 * Implementations are safe for concurrent callers: reads hand out immutable
 * snapshots and one handle owns its own model.
 */
public interface NetworkSettingsStore : AutoCloseable {
    /** Saved configuration, or `null` when nothing has ever been saved. */
    public fun read(): NetworkSettings?

    /**
     * Publish one complete configuration.
     *
     * @throws StorageException when the publication is refused.
     */
    public fun write(next: NetworkSettings)

    /** Release this handle. A later read or write refuses. */
    override fun close()
}

/**
 * [NetworkSettingsStore] over one private document.
 *
 * @param storage the document seam; a [FileSingleDocumentStorage] rooted in
 *   app-private storage is what the platform adapter supplies.
 */
public class FileNetworkSettingsStore(
    private val storage: SingleDocumentStorage,
) : NetworkSettingsStore {

    private val monitor = Any()

    private var model: NetworkSettings? = null
    private var closed = false
    private var poisoned = false

    init {
        synchronized(monitor) { load() }
    }

    override fun read(): NetworkSettings? = synchronized(monitor) {
        assertUsable()
        model
    }

    override fun write(next: NetworkSettings): Unit = synchronized(monitor) {
        assertUsable()
        // Encoding is validated before anything is touched, so an oversized or
        // internally invalid value never disturbs the stored document.
        val bytes = NetworkSettingsDocumentCodec.encode(next).toByteArray(Charsets.UTF_8)
        // The seam fences this publication on the document this handle last read:
        // a first save cannot clobber a document that appeared meanwhile, and a stale
        // handle cannot overwrite newer state.
        val outcome = storage.write(bytes)
        when (outcome) {
            DocumentWriteResult.Published -> model = next
            is DocumentWriteResult.Refused -> {
                if (outcome.commitAttempted) {
                    // The move may or may not be visible: this handle can no longer
                    // claim memory equals disk.
                    poisoned = true
                    model = null
                }
                throw StorageException(outcome.reason)
            }
        }
    }

    override fun close(): Unit = synchronized(monitor) {
        closed = true
        model = null
    }

    private fun load() {
        when (val observed = storage.read()) {
            DocumentRead.Uninitialized -> model = null
            DocumentRead.MissingInitialized -> throw StorageException(StorageFailureReason.MISSING_INITIALIZED)
            is DocumentRead.Refused -> throw StorageException(observed.reason)
            is DocumentRead.Present -> when (val decoded = NetworkSettingsDocumentCodec.decode(observed.bytes)) {
                is SettingsDecodeResult.Valid -> model = decoded.settings
                is SettingsDecodeResult.Invalid -> throw StorageException(decoded.reason)
            }
        }
    }

    private fun assertUsable() {
        if (closed || poisoned) throw StorageException(StorageFailureReason.UNAVAILABLE)
    }
}

/** Fixed private-storage layout for the client's durable configuration and trust. */
public object ClientStoragePaths {
    /** Dedicated directory holding only the settings document. */
    public const val SETTINGS_CONTAINER_DIR_NAME: String = "network-settings"

    /** Fixed settings document name. Never derived from stored data. */
    public const val SETTINGS_DOCUMENT_NAME: String = "settings.json"

    /** Dedicated directory holding only the host pin document: a separate lifecycle. */
    public const val TRUST_CONTAINER_DIR_NAME: String = "host-trust"

    /** Fixed pin document name. */
    public const val TRUST_DOCUMENT_NAME: String = "pins.json"

    /** Dedicated directory holding this device's identity initialization evidence. */
    public const val IDENTITY_CONTAINER_DIR_NAME: String = "device-identity"

    /** Fixed evidence document name. Public identity only, never key material. */
    public const val IDENTITY_EVIDENCE_DOCUMENT_NAME: String = "initialization.json"

    /** Shared lock serializing one alias's presence check, generation, and publication. */
    public const val IDENTITY_LOCK_FILE_NAME: String = "identity-initialization.lock"

    /** Settings document seam rooted at one app-private directory. */
    public fun settingsStorage(rootDir: File): SingleDocumentStorage = FileSingleDocumentStorage(
        container = File(rootDir, SETTINGS_CONTAINER_DIR_NAME),
        fileName = SETTINGS_DOCUMENT_NAME,
        maxDocumentBytes = NetworkSettingsDocumentCodec.MAX_SETTINGS_DOCUMENT_BYTES,
    )

    /** Pin document seam rooted at one app-private directory. */
    public fun pinStorage(rootDir: File): SingleDocumentStorage = FileSingleDocumentStorage(
        container = File(rootDir, TRUST_CONTAINER_DIR_NAME),
        fileName = TRUST_DOCUMENT_NAME,
        maxDocumentBytes = io.github.rfairburn.pireviewgate.core.identity.HostPinDocumentCodec
            .MAX_PIN_DOCUMENT_BYTES,
    )

    /** Identity evidence seam rooted at one app-private directory. */
    public fun identityEvidenceStorage(rootDir: File): SingleDocumentStorage = FileSingleDocumentStorage(
        container = File(rootDir, IDENTITY_CONTAINER_DIR_NAME),
        fileName = IDENTITY_EVIDENCE_DOCUMENT_NAME,
        maxDocumentBytes = io.github.rfairburn.pireviewgate.core.identity.PeerIdentityEvidenceCodec
            .MAX_EVIDENCE_DOCUMENT_BYTES,
    )

    /**
     * Lock serializing identity initialization for one app-private directory.
     *
     * Every adapter instance naming the same root shares it, so two Connect actions —
     * in one process or two — cannot both observe "no identity" and both generate.
     */
    public fun identityInitializationLock(rootDir: File): ExclusiveLock =
        FileExclusiveLock(File(rootDir, IDENTITY_LOCK_FILE_NAME))
}
