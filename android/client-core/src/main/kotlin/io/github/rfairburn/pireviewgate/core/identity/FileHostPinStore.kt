package io.github.rfairburn.pireviewgate.core.identity

import io.github.rfairburn.pireviewgate.core.hosts.DocumentRead
import io.github.rfairburn.pireviewgate.core.hosts.DocumentWriteResult
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.SingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason

/**
 * [HostPinStore] over one private document, with the same fail-closed lifecycle as
 * the settings store and a deliberately separate file.
 *
 * Loading distinguishes the three observations that matter:
 *
 * - no dedicated directory at all: no pins, nothing created;
 * - the directory exists but the document does not: initialized trust that cannot
 *   be read, so the store refuses ([StorageFailureReason.MISSING_INITIALIZED]) and
 *   every byte stays as it is. It is never treated as "no pins", because that would
 *   turn unreadable trust into a first-use acceptance;
 * - a malformed, unknown-version, or unsafe document: refused untouched.
 *
 * Every mutation publishes the whole document atomically and fenced: this handle may
 * replace only the document revision it last read, so two handles that both opened an
 * uninitialized store cannot both record a key, and a handle whose view went stale is
 * refused with [StorageFailureReason.CHANGED] instead of overwriting newer trust. A
 * failure at or after the commit poisons this handle permanently. There is no reset,
 * repair, backup search, or key rotation.
 */
public class FileHostPinStore(
    private val storage: SingleDocumentStorage,
) : HostPinStore {

    private val monitor = Any()

    private var pins: LinkedHashMap<HostId, HostPin>? = null
    private var closed = false
    private var poisoned = false

    init {
        synchronized(monitor) { load() }
    }

    override fun read(hostId: HostId, endpoint: Endpoint): PinRead = synchronized(monitor) {
        val current = pins ?: return@synchronized PinRead.Refused(StorageFailureReason.UNAVAILABLE)
        val stored = current[hostId] ?: return@synchronized PinRead.NoPin
        PinRead.Remembered(stored.key)
    }

    override fun record(hostId: HostId, endpoint: Endpoint, observed: PeerKey): PinRecordResult =
        synchronized(monitor) {
            val current = pins
                ?: return@synchronized PinRecordResult.Refused(StorageFailureReason.UNAVAILABLE)
            val stored = current[hostId]
            if (stored != null) {
                // The first-pinned endpoint is provenance, not identity. Known
                // hosts prove the exact same SPKI at every configured locator.
                // A changed key is refused before any write is even
                // attempted, so an explicit Connect can never adopt a different identity.
                if (stored.key.contentEquals(observed)) return@synchronized PinRecordResult.Unchanged
                return@synchronized PinRecordResult.RejectedChangedKey
            }
            if (current.size >= HostPinDocumentCodec.MAX_PINNED_HOSTS) {
                return@synchronized PinRecordResult.Refused(StorageFailureReason.WRITE_FAILED)
            }
            val next = LinkedHashMap(current)
            next[hostId] = HostPin(hostId, endpoint, observed)
            val refusal = publish(next)
            if (refusal != null) return@synchronized PinRecordResult.Refused(refusal)
            pins = next
            PinRecordResult.Recorded
        }

    override fun clear(hostId: HostId): PinClearResult = synchronized(monitor) {
        val current = pins ?: return@synchronized PinClearResult.Refused(StorageFailureReason.UNAVAILABLE)
        if (!current.containsKey(hostId)) return@synchronized PinClearResult.NothingStored
        // Only this association's pin is dropped. Other hosts, and this device's own
        // identity, are untouched by construction.
        val next = LinkedHashMap(current)
        next.remove(hostId)
        val refusal = publish(next)
        if (refusal != null) return@synchronized PinClearResult.Refused(refusal)
        pins = next
        PinClearResult.Cleared
    }

    /**
     * Fresh display-only projection of every remembered host.
     *
     * @throws StorageException when this handle is closed or poisoned.
     */
    override fun snapshot(): List<HostPin> = synchronized(monitor) {
        val current = pins ?: throw StorageException(StorageFailureReason.UNAVAILABLE)
        current.values.toList()
    }

    override fun close(): Unit = synchronized(monitor) {
        closed = true
        pins = null
    }

    private fun load() {
        when (val observed = storage.read()) {
            DocumentRead.Uninitialized -> pins = LinkedHashMap()
            DocumentRead.MissingInitialized -> throw StorageException(StorageFailureReason.MISSING_INITIALIZED)
            is DocumentRead.Refused -> throw StorageException(observed.reason)
            is DocumentRead.Present -> when (val decoded = HostPinDocumentCodec.decode(observed.bytes)) {
                is PinDecodeResult.Valid -> pins = LinkedHashMap(decoded.pins)
                is PinDecodeResult.Invalid -> throw StorageException(decoded.reason)
            }
        }
    }

    /** Publish one complete candidate set. `null` means the publication landed. */
    private fun publish(next: Map<HostId, HostPin>): StorageFailureReason? {
        val bytes = try {
            HostPinDocumentCodec.encode(next).toByteArray(Charsets.UTF_8)
        } catch (_: StorageException) {
            // Oversized or invalid candidate: nothing on disk was disturbed.
            return StorageFailureReason.WRITE_FAILED
        }
        return when (val outcome = storage.write(bytes)) {
            DocumentWriteResult.Published -> null
            is DocumentWriteResult.Refused -> {
                if (outcome.commitAttempted) {
                    // The move may or may not be visible: this handle can no longer
                    // claim memory equals disk.
                    poisoned = true
                    pins = null
                }
                outcome.reason
            }
        }
    }
}
