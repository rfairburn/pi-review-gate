package io.github.rfairburn.pireviewgate.core.hosts

import java.io.File
import java.nio.file.Files

/** One throwaway private tree for the durable-state checks. */
internal class TempTree(prefix: String = "prg-core-test-") : AutoCloseable {
    val root: File = Files.createTempDirectory(prefix).toFile()

    fun file(vararg segments: String): File = segments.fold(root) { parent, segment -> File(parent, segment) }

    fun settingsStorage(
        maxBytes: Int = NetworkSettingsDocumentCodec.MAX_SETTINGS_DOCUMENT_BYTES,
    ): FileSingleDocumentStorage = FileSingleDocumentStorage(
        container = file(ClientStoragePaths.SETTINGS_CONTAINER_DIR_NAME),
        fileName = ClientStoragePaths.SETTINGS_DOCUMENT_NAME,
        maxDocumentBytes = maxBytes,
    )

    fun pinStorage(
        maxBytes: Int = io.github.rfairburn.pireviewgate.core.identity.HostPinDocumentCodec.MAX_PIN_DOCUMENT_BYTES,
    ): FileSingleDocumentStorage = FileSingleDocumentStorage(
        container = file(ClientStoragePaths.TRUST_CONTAINER_DIR_NAME),
        fileName = ClientStoragePaths.TRUST_DOCUMENT_NAME,
        maxDocumentBytes = maxBytes,
    )

    val settingsDocument: File
        get() = file(ClientStoragePaths.SETTINGS_CONTAINER_DIR_NAME, ClientStoragePaths.SETTINGS_DOCUMENT_NAME)

    val settingsContainer: File
        get() = file(ClientStoragePaths.SETTINGS_CONTAINER_DIR_NAME)

    val pinDocument: File
        get() = file(ClientStoragePaths.TRUST_CONTAINER_DIR_NAME, ClientStoragePaths.TRUST_DOCUMENT_NAME)

    val pinContainer: File
        get() = file(ClientStoragePaths.TRUST_CONTAINER_DIR_NAME)

    override fun close() {
        root.deleteRecursively()
    }
}
