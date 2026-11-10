package io.github.rfairburn.pireviewgate.core.hosts

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * One serialized critical section on a shared resource.
 *
 * The client's durable state is shared by every handle that names the same path, and
 * the app can hold several of them at once (a settings save and a trust write in the
 * same process, or two processes after an OS restart). A per-instance monitor cannot
 * order those writers, so any check-then-publish sequence that decides whether trust
 * or configuration may be written runs inside an [ExclusiveLock] instead.
 *
 * Implementations must be safe to call from several instances that name the same
 * resource, and must never degrade a refusal into "nobody else is writing".
 */
public interface ExclusiveLock {
    /** Run [action] while this lock is held. */
    public fun <R> withLock(action: () -> R): R

    /**
     * Run a read-only [action] without creating any persistent state.
     *
     * Observing storage must not itself be a mutation: a fresh client that has never
     * saved anything stays file-free until a deliberate write. Implementations that
     * materialize a lock file override this and still serialize against [withLock]
     * inside this process; cross-process ordering of observations is unnecessary
     * because publication is atomic.
     */
    public fun <R> withObservation(action: () -> R): R = withLock(action)
}

/**
 * Process-local [ExclusiveLock] for tests and for callers that own a single instance.
 *
 * It orders threads only. Anything that must also order separate processes uses
 * [FileExclusiveLock].
 */
public class InProcessLock : ExclusiveLock {
    private val monitor = Any()

    override fun <R> withLock(action: () -> R): R = synchronized(monitor, action)
}

/**
 * File-locked [ExclusiveLock]: one OS-level advisory lock on one lock file.
 *
 * Every adapter instance that names the same lock file — including instances in
 * another process — waits for the holder, so a presence check, a generation, and a
 * publication cannot interleave with another holder's.
 *
 * Callers inside this process first take a monitor keyed by the lock file's canonical
 * path, because a second file lock request on the same file from the same JVM would be
 * refused rather than queued. The monitor orders threads; the file lock orders processes.
 *
 * The lock file is created owner-only. It holds no state: it exists only to be locked,
 * and it is never deleted while any holder could still be using it.
 */
public class FileExclusiveLock(
    /** Path that names the shared resource. Created on first use. */
    private val lockFile: File,
) : ExclusiveLock {

    override fun <R> withObservation(action: () -> R): R =
        synchronized(inProcessLockFor(canonicalPathOf(lockFile)), action)

    override fun <R> withLock(action: () -> R): R =
        synchronized(inProcessLockFor(canonicalPathOf(lockFile))) {
            val parent = lockFile.absoluteFile.parentFile
            if (parent != null && !parent.isDirectory && !parent.mkdirs()) {
                throw StorageException(StorageFailureReason.WRITE_FAILED)
            }
            protect(lockFile)
            var channel: FileChannel? = null
            var lock: FileLock? = null
            try {
                channel = RandomAccessFile(lockFile, "rw").channel
                lock = channel.lock()
                return action()
            } catch (_: IOException) {
                throw StorageException(StorageFailureReason.UNAVAILABLE)
            } catch (_: SecurityException) {
                throw StorageException(StorageFailureReason.UNAVAILABLE)
            } finally {
                try {
                    lock?.release()
                } catch (_: Exception) {
                    // Releasing a lock the OS already dropped changes nothing.
                }
                try {
                    channel?.close()
                } catch (_: Exception) {
                    // Closing after release cannot change the published result.
                }
            }
        }

    private companion object {
        /** One monitor per canonical lock-file path, for this process only. */
        val inProcessLocks = ConcurrentHashMap<String, Any>()

        fun inProcessLockFor(path: String): Any = synchronized(inProcessLocks) {
            inProcessLocks[path] ?: Any().also { inProcessLocks[path] = it }
        }

        fun canonicalPathOf(file: File): String = try {
            file.canonicalPath
        } catch (_: IOException) {
            file.absolutePath
        }

        fun protect(file: File) {
            try {
                file.setReadable(false, false)
                file.setWritable(false, false)
                file.setExecutable(false, false)
                file.setReadable(true, true)
                file.setWritable(true, true)
            } catch (_: SecurityException) {
                // The platform's private-app storage stays the real boundary.
            }
        }
    }
}

/** SHA-256 hex of exact bytes, used as the publication fence token. */
internal fun revisionOf(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
