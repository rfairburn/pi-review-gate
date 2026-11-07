package io.github.rfairburn.pireviewgate.storage

import android.content.Context
import io.github.rfairburn.pireviewgate.core.hosts.ClientStoragePaths
import io.github.rfairburn.pireviewgate.core.hosts.ExclusiveLock
import io.github.rfairburn.pireviewgate.core.hosts.FileNetworkSettingsStore
import io.github.rfairburn.pireviewgate.core.hosts.FileSingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettingsDocumentCodec
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettingsStore
import io.github.rfairburn.pireviewgate.core.hosts.SingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.identity.FileHostPinStore
import io.github.rfairburn.pireviewgate.core.identity.FilePeerIdentityEvidenceStore
import io.github.rfairburn.pireviewgate.core.identity.HostPinDocumentCodec
import io.github.rfairburn.pireviewgate.core.identity.HostPinStore
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityEvidenceStore
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStore
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationOrderStorage
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationOrderStore
import java.io.File

/**
 * Platform binding for the client's private durable state.
 *
 * Everything lives below [Context.getNoBackupFilesDir], which the platform excludes
 * from cloud backup and device-to-device transfer. That is deliberate and doubles the
 * manifest's `android:allowBackup="false"`: saved hosts, endpoints, connection history,
 * remembered server keys, and identity initialization evidence are private local state.
 * Replicating them to another device would move trust material off this device without
 * the operator's knowledge, and restoring an older copy would silently roll back a pin
 * the operator already acted on.
 *
 * Settings, trust, identity evidence, and remote presentation order each keep their
 * own dedicated directory and separate lifecycle: saving a display preference never
 * touches trust, forgetting a host never disturbs this device's key-store identity,
 * and a refused reorder save never changes saved hosts or trust.
 *
 * The platform's app-private storage is the real protection boundary; the core stores
 * additionally refuse an unsafe, unreadable, or changed document instead of treating it
 * as empty, and serialize publication through a lock file beside each document.
 */
public object AndroidClientStorage {
    /** Dedicated subdirectory of app no-backup storage owned by this client. */
    private const val ROOT_DIR_NAME = "peer-client"

    /** Durable network configuration for every configured host. */
    public fun settingsStore(context: Context): NetworkSettingsStore =
        FileNetworkSettingsStore(settingsStorage(context))

    /** Remembered exact server identities, one endpoint-bound slot per configured host. */
    public fun pinStore(context: Context): HostPinStore =
        FileHostPinStore(pinStorage(context))

    /** This device's peer identity: key store entry plus its own initialization evidence. */
    public fun identityStore(
        context: Context,
        alias: String = AndroidKeyStorePeerIdentityStore.DEFAULT_IDENTITY_ALIAS,
    ): PeerIdentityStore = AndroidKeyStorePeerIdentityStore(
        alias = alias,
        evidenceStore = identityEvidenceStore(context),
        initializationLock = identityInitializationLock(context),
    )

    /** Settings document seam, for callers that own their own store instance. */
    public fun settingsStorage(context: Context): FileSingleDocumentStorage =
        FileSingleDocumentStorage(
            container = File(rootDir(context), ClientStoragePaths.SETTINGS_CONTAINER_DIR_NAME),
            fileName = ClientStoragePaths.SETTINGS_DOCUMENT_NAME,
            maxDocumentBytes = NetworkSettingsDocumentCodec.MAX_SETTINGS_DOCUMENT_BYTES,
        )

    /** Pin document seam, for callers that own their own store instance. */
    public fun pinStorage(context: Context): FileSingleDocumentStorage =
        FileSingleDocumentStorage(
            container = File(rootDir(context), ClientStoragePaths.TRUST_CONTAINER_DIR_NAME),
            fileName = ClientStoragePaths.TRUST_DOCUMENT_NAME,
            maxDocumentBytes = HostPinDocumentCodec.MAX_PIN_DOCUMENT_BYTES,
        )

    /** Initialization-evidence seam, for callers that own their own store instance. */
    public fun identityEvidenceStorage(context: Context): SingleDocumentStorage =
        ClientStoragePaths.identityEvidenceStorage(rootDir(context))

    /** Initialization evidence document store. Public identity only, never key material. */
    public fun identityEvidenceStore(context: Context): PeerIdentityEvidenceStore =
        FilePeerIdentityEvidenceStore(identityEvidenceStorage(context))

    /**
     * Durable identity-only presentation order for remote session cards.
     *
     * The document holds the saved host handle and owner-side presentation identity
     * only: never a viewport, transcript, label, workspace, status, or action target.
     * It lives under no-backup storage like the client's other private documents.
     */
    public fun presentationOrderStore(context: Context): RemotePresentationOrderStore =
        RemotePresentationOrderStorage.openStore(rootDir(context))

    /**
     * Lock serializing identity initialization for this app.
     *
     * Every adapter instance shares it, so two Connect actions cannot both observe "no
     * identity" and both generate into the same alias.
     */
    public fun identityInitializationLock(context: Context): ExclusiveLock =
        ClientStoragePaths.identityInitializationLock(rootDir(context))

    private fun rootDir(context: Context): File = File(context.noBackupFilesDir, ROOT_DIR_NAME)
}
