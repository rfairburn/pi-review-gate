package io.github.rfairburn.pireviewgate.core.hosts

/**
 * Fixed, display-safe storage reasons.
 *
 * A reason never carries a path, an errno, stored content, or raw exception text,
 * so it is safe to surface in a client notice.
 */
public enum class StorageFailureReason {
    /** The dedicated container exists but its document does not: storage is unavailable. */
    MISSING_INITIALIZED,

    /** An expected object is a symlink or is not the expected file type. */
    UNSAFE_OBJECT,

    /** The document is not decodable, or violates the closed schema. */
    MALFORMED,

    /** The document names a version this client does not understand. */
    UNSUPPORTED_VERSION,

    /** The object exists but could not be read. */
    UNREADABLE,

    /** The object changed underneath this handle, or an exclusive publication lost. */
    CHANGED,

    /** Publication failed before any commit was attempted. */
    WRITE_FAILED,

    /** This handle is closed, or was poisoned by a failure at or after a commit attempt. */
    UNAVAILABLE,
}

/**
 * One fixed storage refusal. The message is fixed text chosen from [reason]; no
 * path, content, or cause text is attached.
 */
public class StorageException(
    public val reason: StorageFailureReason,
) : IllegalStateException(messageOf(reason), null) {

    private companion object {
        fun messageOf(reason: StorageFailureReason): String = when (reason) {
            StorageFailureReason.MISSING_INITIALIZED -> "saved client state is unavailable"
            StorageFailureReason.UNSAFE_OBJECT -> "saved client state is unavailable"
            StorageFailureReason.MALFORMED -> "saved client state is unavailable"
            StorageFailureReason.UNSUPPORTED_VERSION -> "saved client state was written by a newer version"
            StorageFailureReason.UNREADABLE -> "saved client state is unavailable"
            StorageFailureReason.CHANGED -> "saved client state changed"
            StorageFailureReason.WRITE_FAILED -> "saved client state could not be saved"
            StorageFailureReason.UNAVAILABLE -> "saved client state is unavailable"
        }
    }
}

/** What a single-document storage seam observed on disk. */
public sealed interface DocumentRead {
    /** The dedicated container is genuinely absent: nothing is saved, and nothing was created. */
    public data object Uninitialized : DocumentRead

    /**
     * The dedicated container exists but its document does not.
     *
     * This is initialized-but-unreadable storage, never a fresh start: it fails
     * closed and is never overwritten with defaults.
     */
    public data object MissingInitialized : DocumentRead

    /** The document exists and was read. */
    public class Present(public val bytes: ByteArray) : DocumentRead

    /** The object exists but is refused: unsafe type, unreadable, or out of bounds. */
    public data class Refused(public val reason: StorageFailureReason) : DocumentRead
}

/** Outcome of one atomic publication attempt. */
public sealed interface DocumentWriteResult {
    /** The document is published and verifiable on disk. */
    public data object Published : DocumentWriteResult

    /**
     * Publication did not land.
     *
     * [commitAttempted] is true only when the failure happened at or after the
     * atomic commit: the document may or may not be visible, so the caller must
     * stop claiming that memory equals disk.
     */
    public data class Refused(
        public val reason: StorageFailureReason,
        public val commitAttempted: Boolean = false,
    ) : DocumentWriteResult
}

/**
 * Storage seam for exactly one private document inside one dedicated directory.
 *
 * The seam distinguishes "container absent" from "container present, document
 * absent" because those two observations carry different product meanings: the first
 * is a fresh client that must create nothing, the second is initialized storage that
 * fails closed. Implementations never search for backups, never sweep, never repair,
 * and never rotate or regenerate anything.
 *
 * Publication is fenced on what this handle last observed. A handle may replace only
 * the exact document it read, and a handle that observed no document may create one
 * only if none has appeared meanwhile. Two handles that both opened an uninitialized
 * store therefore cannot both publish: the second is refused rather than silently
 * overwriting the first, which is what keeps a remembered key or a saved host from
 * being replaced by a stale view.
 */
public interface SingleDocumentStorage {
    /** Observe the document without creating, repairing, or replacing anything. */
    public fun read(): DocumentRead

    /**
     * Publish [bytes], fenced on the state this handle last observed through [read].
     *
     * The check and the commit happen as one serialized step, so a document that
     * another handle or process changed in the meantime is refused with
     * [StorageFailureReason.CHANGED] and left exactly as it is.
     */
    public fun write(bytes: ByteArray): DocumentWriteResult
}
