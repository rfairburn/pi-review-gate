package io.github.rfairburn.pireviewgate.core.client.ui.placement

import io.github.rfairburn.pireviewgate.core.hosts.DocumentRead
import io.github.rfairburn.pireviewgate.core.hosts.DocumentWriteResult
import io.github.rfairburn.pireviewgate.core.hosts.FileSingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.SingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import java.io.File

/** What one read of the private UI placement document observed. */
public sealed interface TerminalOverlayPlacementRead {
    /** No placement has ever been saved; the caller uses existing layout defaults. */
    public data object Fresh : TerminalOverlayPlacementRead

    /** A validated placement was read. */
    public data class Saved(public val placement: TerminalOverlayPlacement) : TerminalOverlayPlacementRead

    /**
     * The document exists but is not usable as placement data. The caller uses
     * defaults and reports a warning. A later deliberate save may normally replace
     * this UI-only document; nothing here repairs or resets any other private file.
     */
    public data class Defaulted(public val reason: StorageFailureReason) : TerminalOverlayPlacementRead
}

/** Outcome of one placement publication. */
public sealed interface TerminalOverlayPlacementWriteResult {
    /** The complete six-slot state is published and verifiable on disk. */
    public data object Published : TerminalOverlayPlacementWriteResult

    /** Publication did not land; the in-memory position is not claimed as saved. */
    public data class Refused(
        public val reason: StorageFailureReason,
        public val commitAttempted: Boolean = false,
    ) : TerminalOverlayPlacementWriteResult
}

/**
 * Durable, UI-only terminal overlay placement.
 *
 * A fresh read creates no container, document, or lock file. Every explicit slot is
 * cosmetic; there is no host, trust, identity, order, session, viewport, input, or
 * proof value in this document.
 *
 * A malformed or text-unreadable document (bounded bytes that exist but do not form a
 * valid placement) reports [TerminalOverlayPlacementRead.Defaulted] and stays
 * writable through the normal single-document fence, so the next deliberate completed
 * drag can replace only this placement document. A zero-byte regular document, or one
 * above the bounded read size, is the one storage-level size refusal this UI-only
 * document adds a narrow normal repair for: [FileTerminalOverlayPlacementEmptyRepair]
 * atomically replaces it under the same lock only while it is still size-invalid and
 * never reads the rejected bytes. An unsafe path or refused read stays refused:
 * normal path, ownership, lock, and permission protections are never bypassed.
 */
public interface TerminalOverlayPlacementStore : AutoCloseable {
    /** Observe the placement document without creating, repairing, or replacing anything. */
    public fun read(): TerminalOverlayPlacementRead

    /** Publish one complete placement state through the normal single-document fence. */
    public fun write(placement: TerminalOverlayPlacement): TerminalOverlayPlacementWriteResult

    /** Release this handle. A later read or write refuses. */
    override fun close()
}

/**
 * [TerminalOverlayPlacementStore] over one private document.
 *
 * A failure at or after the atomic commit poisons this handle for good, like the
 * client's other durable documents. The application holder discards a poisoned handle
 * and opens a fresh one for a later drag, so a genuine write failure never leaves the
 * UI permanently unable to save its cosmetic positions.
 */
public class FileTerminalOverlayPlacementStore(
    private val storage: SingleDocumentStorage,
    private val emptyDocumentRepair: TerminalOverlayPlacementEmptyRepair? = null,
) : TerminalOverlayPlacementStore {

    private val monitor = Any()
    private var closed = false
    private var poisoned = false
    private var loaded: TerminalOverlayPlacementRead? = null
    private var repairInvalidPending = false

    init {
        synchronized(monitor) {
            // Observe on open, as the other private single-document stores do, so a
            // fresh handle may perform its first deliberate write. A malformed
            // bounded document stays writable through this same normal fence.
            val observed = loadLocked()
            loaded = observed
            repairInvalidPending = observed is TerminalOverlayPlacementRead.Defaulted &&
                observed.reason == StorageFailureReason.MALFORMED &&
                emptyDocumentRepair?.canRepairInvalidDocument() == true
        }
    }

    override fun read(): TerminalOverlayPlacementRead = synchronized(monitor) {
        assertUsable()
        loaded ?: loadLocked().also { loaded = it }
    }

    override fun write(placement: TerminalOverlayPlacement): TerminalOverlayPlacementWriteResult =
        synchronized(monitor) {
            assertUsable()
            val bytes = try {
                TerminalOverlayPlacementDocumentCodec.encode(placement).toByteArray(Charsets.UTF_8)
            } catch (error: StorageException) {
                return@synchronized TerminalOverlayPlacementWriteResult.Refused(error.reason)
            }
            val outcome = if (repairInvalidPending) {
                val repair = emptyDocumentRepair
                if (repair == null) {
                    DocumentWriteResult.Refused(StorageFailureReason.CHANGED)
                } else {
                    repair.repair(bytes).also { repaired ->
                        repairInvalidPending = repaired is DocumentWriteResult.Refused &&
                            repaired.reason == StorageFailureReason.WRITE_FAILED &&
                            !repaired.commitAttempted
                    }
                }
            } else {
                storage.write(bytes)
            }
            when (outcome) {
                DocumentWriteResult.Published -> {
                    if (loaded is TerminalOverlayPlacementRead.Defaulted) {
                        // A narrow invalid-size repair publishes through its own
                        // writer; re-observe so this handle's normal fence reflects the
                        // new valid revision for the next completed drag.
                        try {
                            storage.read()
                        } catch (_: Exception) {
                            // The repaired bytes are already verified on disk.
                        }
                    }
                    loaded = TerminalOverlayPlacementRead.Saved(placement)
                    TerminalOverlayPlacementWriteResult.Published
                }
                is DocumentWriteResult.Refused -> {
                    if (outcome.commitAttempted) {
                        // The move may or may not be visible: this handle can no
                        // longer claim memory equals disk. A later drag opens a fresh
                        // handle instead of inheriting this one's uncertainty.
                        poisoned = true
                        repairInvalidPending = false
                    }
                    TerminalOverlayPlacementWriteResult.Refused(outcome.reason, outcome.commitAttempted)
                }
            }
        }

    private fun loadLocked(): TerminalOverlayPlacementRead {
        return when (val observed = storage.read()) {
            DocumentRead.Uninitialized -> TerminalOverlayPlacementRead.Fresh
            DocumentRead.MissingInitialized ->
                TerminalOverlayPlacementRead.Defaulted(StorageFailureReason.MISSING_INITIALIZED)
            is DocumentRead.Refused ->
                TerminalOverlayPlacementRead.Defaulted(observed.reason)
            is DocumentRead.Present -> when (
                val decoded = TerminalOverlayPlacementDocumentCodec.decode(observed.bytes)
            ) {
                is TerminalOverlayPlacementDecodeResult.Valid ->
                    TerminalOverlayPlacementRead.Saved(decoded.placement)
                is TerminalOverlayPlacementDecodeResult.Invalid ->
                    TerminalOverlayPlacementRead.Defaulted(decoded.reason)
            }
        }
    }

    override fun close(): Unit = synchronized(monitor) {
        closed = true
    }

    private fun assertUsable() {
        if (closed || poisoned) throw StorageException(StorageFailureReason.UNAVAILABLE)
    }
}

/**
 * Private storage layout for terminal overlay placement.
 *
 * The caller supplies the app-private no-backup root. This is a dedicated container,
 * never the host settings, trust, identity, or remote-presentation-order document.
 */
public object TerminalOverlayPlacementStorage {
    /** Dedicated directory holding only the UI placement document. */
    public const val CONTAINER_DIR_NAME: String = "terminal-overlay-placement"

    /** Fixed placement document name. Never derived from stored data. */
    public const val DOCUMENT_NAME: String = "placement.json"

    /** Bound for the whole published placement document. */
    public const val MAX_DOCUMENT_BYTES: Int = TerminalOverlayPlacementDocumentCodec.MAX_DOCUMENT_BYTES

    /** Placement document seam rooted at one app-private directory. */
    public fun storage(rootDir: File): FileSingleDocumentStorage = FileSingleDocumentStorage(
        container = File(rootDir, CONTAINER_DIR_NAME),
        fileName = DOCUMENT_NAME,
        maxDocumentBytes = MAX_DOCUMENT_BYTES,
    )

    /** Store handle over [storage]. The caller owns the returned handle. */
    public fun openStore(rootDir: File): TerminalOverlayPlacementStore {
        val container = File(rootDir, CONTAINER_DIR_NAME)
        return FileTerminalOverlayPlacementStore(
            storage = FileSingleDocumentStorage(
                container = container,
                fileName = DOCUMENT_NAME,
                maxDocumentBytes = MAX_DOCUMENT_BYTES,
            ),
            emptyDocumentRepair = FileTerminalOverlayPlacementEmptyRepair(
                container = container,
                fileName = DOCUMENT_NAME,
                maxDocumentBytes = MAX_DOCUMENT_BYTES,
            ),
        )
    }
}
