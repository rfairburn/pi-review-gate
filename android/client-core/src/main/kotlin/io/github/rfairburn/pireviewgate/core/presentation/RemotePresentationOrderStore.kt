package io.github.rfairburn.pireviewgate.core.presentation

import io.github.rfairburn.pireviewgate.core.hosts.DocumentRead
import io.github.rfairburn.pireviewgate.core.hosts.DocumentWriteResult
import io.github.rfairburn.pireviewgate.core.hosts.FileSingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.SingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import java.io.File

/**
 * Outcome of one presentation-order publication.
 *
 * [Refused] is a truthful save failure: the in-memory order may still be used for
 * display, but it is not claimed to equal disk. [Refused.commitAttempted] is true
 * only when the failure happened at or after the atomic commit, in which case the
 * document may or may not be visible and this handle must not claim either state.
 */
public sealed interface RemotePresentationOrderWriteResult {
    /** The complete order is published and verifiable on disk. */
    public data object Published : RemotePresentationOrderWriteResult

    /** Publication did not land; nothing was silently truncated or dropped. */
    public data class Refused(
        public val reason: StorageFailureReason,
        public val commitAttempted: Boolean = false,
    ) : RemotePresentationOrderWriteResult
}

/**
 * Durable identity-only presentation order for remote session cards.
 *
 * `read()` returns `null` only while nothing has ever been saved. The dedicated
 * container is created only by a deliberate write; a fresh read creates no
 * directory, document, or lock file. Once the container exists, its document is
 * authoritative: a missing document, an unknown version, a schema deviation, an
 * unsafe object, or an unreadable value fails closed with [StorageException] and
 * leaves every byte untouched. It is never reported as empty and never rewritten
 * with defaults.
 *
 * The document holds presentation identity only. It never holds a viewport,
 * transcript, label, workspace, status, selection, action target, or raw user data.
 *
 * A publication failure before the commit leaves the previous document intact and
 * the handle usable. A failure at or after the commit poisons this handle: later
 * reads and writes refuse instead of claiming memory equals disk. There is no reset,
 * repair, backup search, expiry, cleanup, or order regeneration.
 *
 * A loaded order is a snapshot for hydration and publication verification. The
 * caller's [RemotePresentationOrder] remains the one live order authority; this store
 * never derives a display list or resolves runtime cards.
 */
public interface RemotePresentationOrderStore : AutoCloseable {
    /**
     * Saved order, or `null` when nothing has ever been saved.
     *
     * @throws StorageException when this handle is closed or poisoned.
     */
    public fun read(): List<RemotePresentationIdentity>?

    /**
     * Publish one complete order in its exact presentation order.
     *
     * A refused order is returned, never silently shortened. An order over the
     * source 64 KiB compatibility bound is [StorageFailureReason.WRITE_FAILED]
     * before any write is attempted.
     *
     * @throws StorageException when this handle is closed or poisoned.
     */
    public fun write(identities: List<RemotePresentationIdentity>): RemotePresentationOrderWriteResult

    /** Release this handle. A later read or write refuses. */
    override fun close()
}

/**
 * [RemotePresentationOrderStore] over one private document.
 *
 * @param storage the document seam; [RemotePresentationOrderStorage.storage] roots
 *   one in app-private storage.
 */
public class FileRemotePresentationOrderStore(
    private val storage: SingleDocumentStorage,
) : RemotePresentationOrderStore {

    private val monitor = Any()

    private var order: List<RemotePresentationIdentity>? = null
    private var closed = false
    private var poisoned = false

    init {
        synchronized(monitor) { load() }
    }

    override fun read(): List<RemotePresentationIdentity>? = synchronized(monitor) {
        assertUsable()
        order?.toList()
    }

    override fun write(identities: List<RemotePresentationIdentity>): RemotePresentationOrderWriteResult =
        synchronized(monitor) {
            assertUsable()
            // Encoding is validated before anything is touched. An oversized order
            // fails here without shortening the list or disturbing the document.
            val bytes = try {
                RemotePresentationOrderDocumentCodec.encode(identities).toByteArray(Charsets.UTF_8)
            } catch (error: StorageException) {
                return@synchronized RemotePresentationOrderWriteResult.Refused(error.reason)
            }
            when (val outcome = storage.write(bytes)) {
                DocumentWriteResult.Published -> {
                    order = identities.toList()
                    RemotePresentationOrderWriteResult.Published
                }
                is DocumentWriteResult.Refused -> {
                    if (outcome.commitAttempted) {
                        // The move may or may not be visible: this handle can no
                        // longer claim memory equals disk.
                        poisoned = true
                        order = null
                    }
                    RemotePresentationOrderWriteResult.Refused(outcome.reason, outcome.commitAttempted)
                }
            }
        }

    override fun close(): Unit = synchronized(monitor) {
        closed = true
        order = null
    }

    private fun load() {
        when (val observed = storage.read()) {
            DocumentRead.Uninitialized -> order = null
            DocumentRead.MissingInitialized -> throw StorageException(StorageFailureReason.MISSING_INITIALIZED)
            is DocumentRead.Refused -> throw StorageException(observed.reason)
            is DocumentRead.Present -> when (
                val decoded = RemotePresentationOrderDocumentCodec.decode(observed.bytes)
            ) {
                is RemotePresentationOrderDecodeResult.Valid -> order = decoded.identities
                is RemotePresentationOrderDecodeResult.Invalid -> throw StorageException(decoded.reason)
            }
        }
    }

    private fun assertUsable() {
        if (closed || poisoned) throw StorageException(StorageFailureReason.UNAVAILABLE)
    }
}

/**
 * Private storage layout and seam factory for the remote presentation order.
 *
 * The caller supplies the app-private root. On Android that is
 * `Context.getNoBackupFilesDir`, so this document is excluded from backup and
 * device-to-device transfer by the same platform boundary as the client's other
 * private documents. The layout itself is platform-independent and creates nothing
 * until a deliberate write.
 */
public object RemotePresentationOrderStorage {
    /** Dedicated directory holding only this order document. */
    public const val CONTAINER_DIR_NAME: String = "session-presentation-order"

    /** Fixed order document name. Never derived from stored data. */
    public const val DOCUMENT_NAME: String = "order.json"

    /** Bound for the whole published order document. */
    public const val MAX_DOCUMENT_BYTES: Int = RemotePresentationOrderDocumentCodec.MAX_DOCUMENT_BYTES

    /** Order document seam rooted at one app-private directory. */
    public fun storage(rootDir: File): FileSingleDocumentStorage = FileSingleDocumentStorage(
        container = File(rootDir, CONTAINER_DIR_NAME),
        fileName = DOCUMENT_NAME,
        maxDocumentBytes = MAX_DOCUMENT_BYTES,
    )

    /** Store handle over [storage]. The caller owns the returned handle. */
    public fun openStore(rootDir: File): RemotePresentationOrderStore =
        FileRemotePresentationOrderStore(storage(rootDir))
}
