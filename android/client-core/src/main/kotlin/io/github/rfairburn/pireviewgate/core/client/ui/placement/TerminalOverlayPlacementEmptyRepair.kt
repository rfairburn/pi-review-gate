package io.github.rfairburn.pireviewgate.core.client.ui.placement

import io.github.rfairburn.pireviewgate.core.hosts.DocumentWriteResult
import io.github.rfairburn.pireviewgate.core.hosts.ExclusiveLock
import io.github.rfairburn.pireviewgate.core.hosts.FileExclusiveLock
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

/**
 * A deliberately narrow normal-write repair for an invalid-size UI placement document.
 *
 * [io.github.rfairburn.pireviewgate.core.hosts.FileSingleDocumentStorage] correctly
 * treats a zero-byte document, and a document above its byte bound, as malformed for
 * host settings, trust, identity, and order state. The bound exists so a read never
 * pulls an arbitrary large object into memory. Cosmetic overlay placement has the
 * separate product rule that the next completed drag must be able to replace such a
 * document instead of leaving it permanently unusable. This type performs that
 * replacement only when the dedicated regular-file document still has zero bytes or
 * more than its byte bound, under the same OS lock file, with the same owner-only
 * protections and atomic temp-file publication. It never reads the rejected bytes and
 * never follows a symlink, never removes the target, never changes permissions beyond
 * owner-only publication, and refuses a container or document that is not the expected
 * regular object. A valid replacement that is no longer size-invalid is newer state
 * and is refused as CHANGED rather than overwritten. Every other storage refusal keeps
 * its normal fail-closed path. The historical type name is retained;
 * [canRepairInvalidDocument] is the one predicate for both size-invalid cases.
 */
public interface TerminalOverlayPlacementEmptyRepair {
    /** True only when the dedicated document is currently zero bytes or above the bound. */
    public fun canRepairInvalidDocument(): Boolean

    /** Normally and atomically replace the still-size-invalid document with [bytes]. */
    public fun repair(bytes: ByteArray): DocumentWriteResult
}

/** File-backed [TerminalOverlayPlacementEmptyRepair] for one dedicated UI document. */
public class FileTerminalOverlayPlacementEmptyRepair(
    private val container: File,
    private val fileName: String,
    private val maxDocumentBytes: Int,
    private val lock: ExclusiveLock = FileExclusiveLock(
        File(container.absoluteFile.parentFile, "${container.name}.lock"),
    ),
) : TerminalOverlayPlacementEmptyRepair {

    init {
        require(fileName == File(fileName).name && fileName.isNotEmpty() && !fileName.contains('/')) {
            "document file name must be a single path segment"
        }
        require(maxDocumentBytes > 0) { "document bound must be positive" }
    }

    private val target: File get() = File(container, fileName)

    override fun canRepairInvalidDocument(): Boolean =
        observe(container, expectDirectory = true) == Observation.OK &&
            observe(target, expectDirectory = false) == Observation.OK &&
            hasInvalidSize()

    override fun repair(bytes: ByteArray): DocumentWriteResult = lock.withLock {
        if (bytes.isEmpty() || bytes.size > maxDocumentBytes) {
            return@withLock DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED)
        }
        if (!isInvalidSizeRegularDocument()) {
            return@withLock DocumentWriteResult.Refused(reasonForUnusableTarget())
        }

        val temporary = File(container, "$fileName.tmp.${UUID.randomUUID()}")
        if (temporary.exists()) {
            return@withLock DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED)
        }

        var commitAttempted = false
        try {
            FileOutputStream(temporary).use { stream ->
                stream.write(bytes)
                stream.flush()
                stream.fd.sync()
            }
            protect(temporary, directories = false)
            if (temporary.length() != bytes.size.toLong()) {
                return@withLock DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED)
            }
            // Re-check inside the same serialized section. A document that became a
            // valid replacement is newer state and must not be replaced.
            if (!isInvalidSizeRegularDocument()) {
                return@withLock DocumentWriteResult.Refused(reasonForUnusableTarget())
            }
            commitAttempted = true
            if (!temporary.renameTo(target)) {
                return@withLock DocumentWriteResult.Refused(
                    StorageFailureReason.WRITE_FAILED,
                    commitAttempted = true,
                )
            }
            if (observe(target, expectDirectory = false) != Observation.OK ||
                target.length() != bytes.size.toLong()
            ) {
                return@withLock DocumentWriteResult.Refused(
                    StorageFailureReason.WRITE_FAILED,
                    commitAttempted = true,
                )
            }
            DocumentWriteResult.Published
        } catch (_: IOException) {
            DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted)
        } catch (_: SecurityException) {
            DocumentWriteResult.Refused(StorageFailureReason.WRITE_FAILED, commitAttempted)
        } finally {
            try {
                if (temporary.exists()) temporary.delete()
            } catch (_: Exception) {
                // A leftover temporary is never renamed into place later.
            }
        }
    }

    private fun isInvalidSizeRegularDocument(): Boolean =
        observe(container, expectDirectory = true) == Observation.OK &&
            observe(target, expectDirectory = false) == Observation.OK &&
            hasInvalidSize()

    private fun hasInvalidSize(): Boolean {
        val length = target.length()
        return length == 0L || length > maxDocumentBytes.toLong()
    }

    private fun reasonForUnusableTarget(): StorageFailureReason = when (
        observe(container, expectDirectory = true)
    ) {
        Observation.UNSAFE -> StorageFailureReason.UNSAFE_OBJECT
        Observation.ABSENT -> StorageFailureReason.CHANGED
        Observation.OK -> when (observe(target, expectDirectory = false)) {
            Observation.UNSAFE -> StorageFailureReason.UNSAFE_OBJECT
            Observation.ABSENT, Observation.OK -> StorageFailureReason.CHANGED
        }
    }

    private enum class Observation { ABSENT, OK, UNSAFE }

    /** Absent, usable, or unsafe (symlink or wrong type). Never creates anything. */
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
        if (expectDirectory != file.isDirectory) return Observation.UNSAFE
        if (!expectDirectory && !file.isFile) return Observation.UNSAFE
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
