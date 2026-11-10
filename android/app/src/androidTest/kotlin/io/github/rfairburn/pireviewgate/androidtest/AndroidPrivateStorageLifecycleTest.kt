package io.github.rfairburn.pireviewgate.androidtest

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.hosts.DocumentRead
import io.github.rfairburn.pireviewgate.core.hosts.DocumentWriteResult
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettingsDocumentCodec
import io.github.rfairburn.pireviewgate.core.hosts.SettingsMutation
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.identity.EvidenceRead
import io.github.rfairburn.pireviewgate.core.identity.IdentityException
import io.github.rfairburn.pireviewgate.core.identity.IdentityFailureReason
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.identity.PeerKey
import io.github.rfairburn.pireviewgate.core.identity.PinRead
import io.github.rfairburn.pireviewgate.core.identity.PinRecordResult
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationIdentity
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationOrderWriteResult
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.UUID

/**
 * Instrumented lifecycle checks for the landed app-private storage adapters.
 *
 * Everything is rooted in a unique fixture child of the target app's cache
 * directory through [FixtureEnvironment], so no production document, no-backup
 * root, or configured host is read or written. "Fresh" observations must create
 * nothing; every deliberate write must be visible to a reopened handle on the
 * real Android filesystem.
 */
@RunWith(AndroidJUnit4::class)
class AndroidPrivateStorageLifecycleTest {

    private lateinit var base: Context
    private lateinit var root: File
    private lateinit var context: Context
    private lateinit var nonce: String
    private lateinit var alias: String

    @Before
    fun setUp() {
        base = FixtureEnvironment.targetContext()
        nonce = "storage-" + UUID.randomUUID().toString()
        root = FixtureEnvironment.rootFor(base, nonce)
        FixtureEnvironment.deleteOwnedRoot(base, root)
        context = FixtureEnvironment.contextWithRoot(base, root)
        alias = FixtureEnvironment.aliasFor(nonce)
    }

    @After
    fun tearDown() {
        try {
            FixtureEnvironment.deleteOwnedAlias(alias)
            assertFalse("fixture alias remains after cleanup", FixtureEnvironment.keyStoreContains(alias))
        } finally {
            FixtureEnvironment.deleteOwnedRoot(base, root)
            assertFalse("fixture root remains after cleanup", root.exists())
        }
    }

    @Test
    fun freshReadsCreateNoDirectoryDocumentOrKey() {
        val hostId = HostId.generate()
        val endpoint = Endpoint("fixture.invalid", 443)

        assertNull(AndroidClientStorage.settingsStore(context).read())
        assertEquals(PinRead.NoPin, AndroidClientStorage.pinStore(context).read(hostId, endpoint))
        assertNull(AndroidClientStorage.presentationOrderStore(context).read())
        assertEquals(EvidenceRead.Absent, AndroidClientStorage.identityEvidenceStore(context).read())
        assertEquals(
            PeerIdentityStatus.NeverInitialized,
            AndroidClientStorage.identityStore(context, alias).status(),
        )

        assertFalse("a fresh observation created the fixture root", root.exists())
        assertFalse("a fresh observation created a key entry", FixtureEnvironment.keyStoreContains(alias))
    }

    @Test
    fun settingsDocumentUsesFencedFileStorageAndReopens() {
        val hostId = HostId.generate()
        val settings = NetworkSettings.DEFAULTS
            .addingHost(
                ConfiguredHost(
                    id = hostId,
                    label = HostLabel.parse("Fixture Host"),
                    endpoint = Endpoint("fixture.invalid", 443),
                ),
            )
            .let { mutation ->
                val ok = mutation as? SettingsMutation.Ok
                    ?: throw AssertionError("fixture host was refused: $mutation")
                ok.settings
            }
            .withAutoReconnect(true)

        val firstStorage = AndroidClientStorage.settingsStorage(context)
        val staleStorage = AndroidClientStorage.settingsStorage(context)
        assertEquals(DocumentRead.Uninitialized, firstStorage.read())
        assertEquals(DocumentRead.Uninitialized, staleStorage.read())

        val bytes = NetworkSettingsDocumentCodec.encode(settings).toByteArray(Charsets.UTF_8)
        assertEquals(DocumentWriteResult.Published, firstStorage.write(bytes))

        // A second handle that observed "absent" must not clobber the document
        // that appeared. This exercises the production FileExclusiveLock plus
        // revision fence, not a process-local test lock.
        val refused = staleStorage.write(bytes)
        assertTrue("stale publication must be refused", refused is DocumentWriteResult.Refused)
        assertEquals(
            StorageFailureReason.CHANGED,
            (refused as DocumentWriteResult.Refused).reason,
        )

        assertEquals(settings, AndroidClientStorage.settingsStore(context).read())
        assertTrue(
            "production file lock was not materialized",
            File(root, "peer-client/network-settings.lock").isFile,
        )
    }

    @Test
    fun pinAndPresentationOrderDocumentsPersistAcrossReopen() {
        val pinHostId = HostId.generate()
        val endpoint = Endpoint("fixture.invalid", 443)
        val observed = fixturePeerKey()

        val firstPins = AndroidClientStorage.pinStore(context)
        assertEquals(PinRead.NoPin, firstPins.read(pinHostId, endpoint))
        assertEquals(PinRecordResult.Recorded, firstPins.record(pinHostId, endpoint, observed))

        val reopenedPins = AndroidClientStorage.pinStore(context)
        val remembered = reopenedPins.read(pinHostId, endpoint)
        assertTrue(remembered is PinRead.Remembered)
        assertTrue(observed.contentEquals((remembered as PinRead.Remembered).key))
        assertEquals(PinRecordResult.Unchanged, reopenedPins.record(pinHostId, endpoint, observed))
        assertEquals(
            PinRecordResult.RejectedChangedKey,
            reopenedPins.record(pinHostId, endpoint, fixturePeerKey()),
        )

        val orderHostId = HostId.generate()
        val item = RemotePresentationIdentity.slot(orderHostId, "fixture-slot")
            ?: throw AssertionError("fixture presentation identity was refused")
        val firstOrder = AndroidClientStorage.presentationOrderStore(context)
        assertNull(firstOrder.read())
        assertEquals(
            RemotePresentationOrderWriteResult.Published,
            firstOrder.write(listOf(item)),
        )
        assertEquals(
            listOf(item),
            AndroidClientStorage.presentationOrderStore(context).read(),
        )

        assertTrue(File(root, "peer-client/host-trust/pins.json").isFile)
        assertTrue(File(root, "peer-client/session-presentation-order/order.json").isFile)
        assertTrue(File(root, "peer-client/host-trust.lock").isFile)
        assertTrue(File(root, "peer-client/session-presentation-order.lock").isFile)
    }

    @Test
    fun malformedEvidenceFailsClosedWithoutGeneratingAKey() {
        val malformed = "{not-a-valid-evidence-document".toByteArray(Charsets.UTF_8)
        val evidenceStorage = AndroidClientStorage.identityEvidenceStorage(context)
        assertEquals(DocumentRead.Uninitialized, evidenceStorage.read())
        assertEquals(DocumentWriteResult.Published, evidenceStorage.write(malformed))

        val store = AndroidClientStorage.identityStore(context, alias)
        val status = store.status()
        assertTrue(status is PeerIdentityStatus.Refused)
        assertEquals(
            IdentityFailureReason.INCONSISTENT_EVIDENCE,
            (status as PeerIdentityStatus.Refused).reason,
        )
        val failure = assertThrows(IdentityException::class.java) {
            store.initialize(HostLabel.parse(FixtureEnvironment.IDENTITY_LABEL))
        }
        assertEquals(IdentityFailureReason.INCONSISTENT_EVIDENCE, failure.reason)
        assertFalse("malformed evidence triggered key generation", FixtureEnvironment.keyStoreContains(alias))

        val reread = AndroidClientStorage.identityEvidenceStorage(context).read()
        assertTrue(reread is DocumentRead.Present)
        assertArrayEquals(malformed, (reread as DocumentRead.Present).bytes)
    }

    @Test
    fun missingInitializedKeyFailsClosedWithoutRegeneration() {
        val label = HostLabel.parse(FixtureEnvironment.IDENTITY_LABEL)
        val first = AndroidClientStorage.identityStore(context, alias)
        assertEquals(PeerIdentityStatus.NeverInitialized, first.status())
        val initialized = first.initialize(label)
        assertTrue(FixtureEnvironment.keyStoreContains(alias))

        FixtureEnvironment.deleteOwnedAlias(alias)
        assertFalse(FixtureEnvironment.keyStoreContains(alias))

        val reopened = AndroidClientStorage.identityStore(context, alias)
        val status = reopened.status()
        assertTrue(status is PeerIdentityStatus.Refused)
        assertEquals(
            IdentityFailureReason.MISSING_INITIALIZED,
            (status as PeerIdentityStatus.Refused).reason,
        )
        val failure = assertThrows(IdentityException::class.java) {
            reopened.initialize(label)
        }
        assertEquals(IdentityFailureReason.MISSING_INITIALIZED, failure.reason)
        assertFalse("a missing initialized key was regenerated", FixtureEnvironment.keyStoreContains(alias))

        // The evidence document remains the original init-time record.
        assertTrue(
            File(root, "peer-client/device-identity/initialization.json").isFile,
        )
        assertTrue(initialized.key.keyId.isNotEmpty())
    }

    private fun fixturePeerKey(): PeerKey {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        return PeerKey.fromSpki(generator.generateKeyPair().public.encoded)
    }
}
