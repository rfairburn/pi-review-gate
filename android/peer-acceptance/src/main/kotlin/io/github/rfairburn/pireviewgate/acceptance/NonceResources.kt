package io.github.rfairburn.pireviewgate.acceptance

import android.content.Context
import android.content.ContextWrapper
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.file.Files
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap

/** Owns exactly one fixture-UID root and one fixture-UID alias, never the app's. */
class NonceResources private constructor(context: Context, val nonce: String) : AutoCloseable {
    val root = File(context.noBackupFilesDir.canonicalFile, "peer-acceptance-$nonce")
    val alias = "pi-review-gate-acceptance-$nonce"
    private val marker get() = File(root, "ownership")
    private val markerText get() = "$FIXTURE_PACKAGE\n$nonce\n"
    private var lockFile: RandomAccessFile? = null
    private var lock: FileLock? = null
    val scopedContext: Context = object : ContextWrapper(context) {
        override fun getNoBackupFilesDir(): File = root
        override fun getApplicationContext(): Context = this
    }
    val identity get() = AndroidClientStorage.identityStore(scopedContext, alias)

    private fun acquire(create: Boolean) {
        check(!activeGraphs.contains(nonce)) { "fixture graph closure unverified" }
        check(!Files.isSymbolicLink(root.toPath())) { "unsafe fixture root" }
        if (!root.exists()) {
            check(create) { "fixture not prepared" }
            // Prove absence before writing ownership evidence; an orphan alias is not ours.
            val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            check(!keys.containsAlias(alias)) { "fixture alias ownership unverified" }
            check(root.mkdir()) { "fixture root creation refused" }
            // Missing/incomplete ownership is never repaired on a later invocation.
            check(marker.createNewFile())
            marker.writeText(markerText)
        }
        check(root.isDirectory && root.canonicalFile == root.absoluteFile)
        check(!Files.isSymbolicLink(marker.toPath()) && marker.isFile && marker.length() <= 128)
        check(marker.readText() == markerText) { "fixture ownership refused" }
        val path = File(root, "operation.lock")
        check(!Files.isSymbolicLink(path.toPath()))
        lockFile = RandomAccessFile(path, "rw")
        lock = lockFile!!.channel.tryLock() ?: error("fixture operation already active")
    }

    fun graphStarted() {
        check(lock?.isValid == true && activeGraphs.add(nonce))
    }

    fun graphClosed() {
        check(lock?.isValid == true && activeGraphs.remove(nonce))
    }

    /** Only after the caller positively awaited closure of its graph. */
    fun deleteOwned() {
        check(lock?.isValid == true && !activeGraphs.contains(nonce))
        check(marker.readText() == markerText)
        val entries = ArrayList<File>()
        fun inspect(file: File, depth: Int) {
            check(depth <= 8 && entries.size < 256) { "fixture cleanup bound exceeded" }
            check(!Files.isSymbolicLink(file.toPath())) { "fixture cleanup refuses links" }
            check(file.canonicalPath == file.absolutePath && file.toPath().startsWith(root.toPath()))
            check(file.isDirectory || file.isFile) { "fixture cleanup refuses special object" }
            entries.add(file)
            if (file.isDirectory) (file.listFiles() ?: error("fixture cleanup unreadable")).forEach {
                inspect(it, depth + 1)
            }
        }
        inspect(root, 0)
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        keys.deleteEntry(alias)
        check(!keys.containsAlias(alias)) { "fixture alias cleanup unverified" }
        // Bounded, no-follow inventory above; no traversal outside this exact owned root.
        for (file in entries.asReversed()) check(file.delete()) { "fixture root cleanup incomplete" }
        check(!root.exists())
    }

    override fun close() {
        try { lock?.release() } finally { lockFile?.close() }
    }

    companion object {
        // A failed close keeps this veto even after its operation lock is released.
        // Only verified close or fixture-process death (which closes its sockets)
        // ends that uncertainty; fallback never resets a live graph.
        private val activeGraphs = ConcurrentHashMap.newKeySet<String>()

        /** Explicit fallback only; a live operation's lock always refuses cleanup. */
        fun cleanup(context: Context, nonce: String) {
            check(context.packageName == FIXTURE_PACKAGE)
            checkedNonce(nonce)
            check(!activeGraphs.contains(nonce)) { "fixture graph closure unverified" }
            val owned = NonceResources(context, nonce)
            check(!Files.isSymbolicLink(owned.root.toPath()))
            if (!owned.root.exists()) {
                // A completed/partially completed cleanup deleted the alias FIRST.
                // A surviving alias with missing ownership evidence is uncertainty,
                // not permission to repair or delete unproven material.
                val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                check(!keys.containsAlias(owned.alias)) { "fixture alias ownership unverified" }
                return
            }
            open(context, nonce).use { it.deleteOwned() }
        }

        fun open(context: Context, nonce: String, create: Boolean = false): NonceResources {
            check(context.packageName == FIXTURE_PACKAGE) { "fixture UID context required" }
            checkedNonce(nonce)
            return NonceResources(context, nonce).also {
                try { it.acquire(create) } catch (error: Throwable) { it.close(); throw error }
            }
        }
    }
}
