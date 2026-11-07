package io.github.rfairburn.pireviewgate.core.hosts

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

/**
 * File-backed [SingleDocumentStorage] for one private document.
 *
 * Reads are read-only: a fresh client that has never saved anything creates nothing —
 * no container, no document, and no lock file. The container directory is created only
 * by a write, and only with owner-only protection applied before the first byte is
 * written.
 *
 * Publication is one whole document, serialized by an [ExclusiveLock] on a lock file
 * named after this document's location, and fenced on the exact bytes this handle last
 * observed:
 *
 * - a handle that observed no document may create one, and is refused if one has
 *   appeared meanwhile instead of clobbering it;
 * - a handle may replace only the document revision it read; a document that another
 *   handle or process changed, removed, or corrupted in the meantime is refused with
 *   [StorageFailureReason.CHANGED] and left untouched;
 * - a dedicated directory whose document is gone is initialized storage with lost
 *   state, never a blank slate: publication is refused with
 *   [StorageFailureReason.MISSING_INITIALIZED] before any temporary is created, even
 *   for a handle that opened before the document ever existed;
 * - a failure before the move removes only the temporary this call created; a failure
 *   at or after the move reports `commitAttempted` so the caller poisons its handle
 *   instead of claiming memory equals disk, and this handle can no longer publish
 *   without a fresh read.
 *
 * There is no backup search, no repair, no reset, and no stale-lock takeover.
 *
 * Protection uses `java.io.File` permission calls so the same code runs on a JVM and
 * on the platform, without POSIX-only attribute APIs. The platform's own private-app
 * storage remains the real boundary; these calls are defense in depth.
 */
public class FileSingleDocumentStorage(
    /** Dedicated directory holding only this document. Never a shared directory. */
    private val container: File,
    /** Fixed document name inside [container]. Never derived from stored data. */
    private val fileName: String,
    /** Hard bound on the published document size. */
    private val maxDocumentBytes: Int,
    /**
     * Serialize this document's check-and-publish with every other holder of the same
     * location. Defaults to an OS file lock beside the container, so separate handles
     * and separate processes share it.
     */
    private val lock: ExclusiveLock = FileExclusiveLock(
        File(container.absoluteFile.parentFile, "${container.name}.lock"),
    ),
) : SingleDocumentStorage {

    init {
        require(fileName == File(fileName).name && fileName.isNotEmpty() && !fileName.contains('/')) {
            "document file name must be a single path segment"
        }
        require(maxDocumentBytes > 0) { "document bound must be positive" }
    }

    private val target: File get() = File(container, fileName)

    /** What this handle last proved about the document on disk. */
    private sealed interface Fence {
        /** Nothing observed yet, or a commit whose visibility is unknown. */
        data object Unobserved : Fence

        /** The document was absent. */
        data object Absent : Fence

        /** The document was present with exactly this revision. */
        data class Present(val revision: String) : Fence
    }

    private var fence: Fence = Fence.Unobserved

    override fun read(): DocumentRead = lock.withObservation {
        val observed = readLocked()
        fence = when (observed) {
            // A genuinely uninitialized store may be created by this handle.
            DocumentRead.Uninitialized -> Fence.Absent
            // Initialized storage whose document is gone is never a blank slate:
            // this handle must not publish over it.
            DocumentRead.MissingInitialized -> Fence.Unobserved
            is DocumentRead.Present -> Fence.Present(revisionOf(observed.bytes))
            is DocumentRead.Refused -> Fence.Unobserved
        }
        observed
    }

    override fun write(bytes: ByteArray): DocumentWriteResult = lock.withLock { writeLocked(bytes) }

    private fun readLocked(): DocumentRead {
        val containerState = observe(container, expectDirectory = true)
        if (containerState == Observation.ABSENT) return DocumentRead.Uninitialized
        if (containerState != Observation.OK) {
            return DocumentRead.Refused(StorageFailureReason.UNSAFE_OBJECT)
        }

        val documentState = observe(target, expectDirectory = false)
        if (documentState == Observation.ABSENT) return DocumentRead.MissingInitialized
        if (documentState != Observation.OK) {
            return DocumentRead.Refused(StorageFailureReason.UNSAFE_OBJECT)
        }

        val size = target.length()
        if (size <= 0L || size > maxDocumentBytes.toLong()) {
            return DocumentRead.Refused(StorageFailureReason.MALFORMED)
        }
        val bytes = try {
            if (observe(target, expectDirectory = false) != Observation.OK) {
                return DocumentRead.Refused(StorageFailureReason.CHANGED)
            }
            target.readBytes()
        } catch (_: IOException) {
            return DocumentRead.Refused(StorageFailureReason.UNREADABLE)
        }
        if (bytes.isEmpty() || bytes.size > maxDocumentBytes) {
            return DocumentRead.Refused(StorageFailureReason.MALFORMED)
        }
        return DocumentRead.Present(bytes)
    }

    private fun writeLocked(bytes: ByteArray): DocumentWriteResult {
        if (bytes.isEmpty() || bytes.size > maxDocumentBytes) {
            return DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED)
        }

        // Fence first: this handle may replace only what it last observed.
        when (val expected = fence) {
            Fence.Unobserved -> return DocumentWriteResult.Refused(StorageFailureReason.CHANGED)
            Fence.Absent -> when (val current = readLocked()) {
                is DocumentRead.Present -> return DocumentWriteResult.Refused(StorageFailureReason.CHANGED)
                is DocumentRead.Refused -> return DocumentWriteResult.Refused(current.reason)
                // The dedicated directory exists but its document does not: that is
                // initialized storage with lost state, not a blank slate. Refuse
                // before creating any temporary.
                DocumentRead.MissingInitialized ->
                    return DocumentWriteResult.Refused(StorageFailureReason.MISSING_INITIALIZED)
                DocumentRead.Uninitialized -> Unit
            }
            is Fence.Present -> when (val current = readLocked()) {
                is DocumentRead.Present ->
                    if (revisionOf(current.bytes) != expected.revision) {
                        return DocumentWriteResult.Refused(StorageFailureReason.CHANGED)
                    }
                is DocumentRead.Refused -> return DocumentWriteResult.Refused(current.reason)
                else -> return DocumentWriteResult.Refused(StorageFailureReason.CHANGED)
            }
        }

        val containerState = observe(container, expectDirectory = true)
        // A handle that saw no container at all may only create one; a container that
        // appeared meanwhile belongs to somebody else's publication.
        if (fence == Fence.Absent && containerState != Observation.ABSENT) {
            return DocumentWriteResult.Refused(StorageFailureReason.CHANGED)
        }
        if (containerState == Observation.ABSENT) {
            if (!container.mkdirs()) {
                return DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED)
            }
            protect(container, directories = true)
        } else if (containerState != Observation.OK) {
            return DocumentWriteResult.Refused(StorageFailureReason.UNSAFE_OBJECT)
        }

        val temporary = File(container, "$fileName.tmp.${UUID.randomUUID()}")
        if (temporary.exists()) return DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED)

        var commitAttempted = false
        try {
            FileOutputStream(temporary).use { stream ->
                stream.write(bytes)
                stream.flush()
                stream.fd.sync()
            }
            protect(temporary, directories = false)
            if (temporary.length() != bytes.size.toLong()) {
                return DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED)
            }
            // Re-check inside the same serialized section: a writer that ignored the
            // lock must still not be able to slip a replacement past this handle.
            when (val expected = fence) {
                Fence.Absent -> when (val current = readLocked()) {
                    // Only this publication may have created the container above, so
                    // a still-missing document here is the intended first publication.
                    DocumentRead.MissingInitialized -> Unit
                    is DocumentRead.Refused -> return DocumentWriteResult.Refused(current.reason)
                    else -> return DocumentWriteResult.Refused(StorageFailureReason.CHANGED)
                }
                is Fence.Present -> {
                    val current = readLocked()
                    if (current !is DocumentRead.Present || revisionOf(current.bytes) != expected.revision) {
                        return DocumentWriteResult.Refused(StorageFailureReason.CHANGED)
                    }
                }
                Fence.Unobserved -> return DocumentWriteResult.Refused(StorageFailureReason.CHANGED)
            }

            commitAttempted = true
            if (!temporary.renameTo(target)) {
                fence = Fence.Unobserved
                return DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted = true)
            }
            if (observe(target, expectDirectory = false) != Observation.OK) {
                fence = Fence.Unobserved
                return DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted = true)
            }
            if (target.length() != bytes.size.toLong()) {
                fence = Fence.Unobserved
                return DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted = true)
            }
            fence = Fence.Present(revisionOf(bytes))
            return DocumentWriteResult.Published
        } catch (_: IOException) {
            if (commitAttempted) fence = Fence.Unobserved
            return DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted)
        } finally {
            if (temporary.exists()) {
                try {
                    temporary.delete()
                } catch (_: IOException) {
                    // A leftover temporary is never renamed into place later.
                }
            }
        }
    }

    private enum class Observation { ABSENT, OK, UNSAFE }

    /**
     * Absent, usable, or unsafe (symlink or wrong type). Never creates anything.
     *
     * The comparison canonicalizes the containing directory and re-attaches the
     * expected name, so a symlinked ancestor (a platform's own temporary or home
     * layout) is not mistaken for an unsafe object, while a symlink standing in for
     * this client's directory or document always is.
     */
    private fun observe(file: File, expectDirectory: Boolean): Observation {
        if (!file.exists()) return Observation.ABSENT
        val canonical = try {
            file.canonicalFile
        } catch (_: IOException) {
            return Observation.UNSAFE
        } ?: return Observation.UNSAFE
        val expected = try {
            val parent = file.absoluteFile.parentFile?.canonicalFile ?: return Observation.UNSAFE
            java.nio.file.Paths.get(parent.path, file.name).toFile()
        } catch (_: IOException) {
            return Observation.UNSAFE
        }
        if (canonical.path != expected.path) return Observation.UNSAFE
        val isDirectory = file.isDirectory
        if (expectDirectory != isDirectory) return Observation.UNSAFE
        return Observation.OK
    }

    /** Owner-only protection, best effort: no group or world access. */
    private fun protect(file: File, directories: Boolean) {
        try {
            file.setReadable(false, false)
            file.setWritable(false, false)
            file.setExecutable(false, false)
            file.setReadable(true, true)
            file.setWritable(true, true)
            if (directories) file.setExecutable(true, true)
        } catch (_: SecurityException) {
            // The platform's private-app storage stays the real boundary.
        }
    }
}
