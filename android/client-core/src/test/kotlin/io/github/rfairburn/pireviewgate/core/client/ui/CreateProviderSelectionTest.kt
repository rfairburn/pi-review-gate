package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.client.roster.NativeCatalogScope
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliTarget
import io.github.rfairburn.pireviewgate.core.protocol.native.SessionBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.isNativeCliNewSessionTarget
import io.github.rfairburn.pireviewgate.core.protocol.native.isNewSessionTarget
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteNativeSession
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** Host-scoped provider selection and native card identity, with synthetic rows only. */
class CreateProviderSelectionTest {

    private val hostA = HostId.parse("provider-host-a")
    private val hostB = HostId.parse("provider-host-b")
    private val claude = NativeCliTarget("claude", NativeCliBackend.CLAUDE, "Claude default")
    private val codex = NativeCliTarget("codex", NativeCliBackend.CODEX, "Codex review")
    /** A named external worker profile an older owner may still advertise (#493). */
    private val namedProfile = NativeCliTarget("external:review-box", NativeCliBackend.CODEX, "review-box (Codex CLI)")
    private val scope = NativeCatalogScope("run-1", 1L, 1L)

    private fun owner(
        host: HostId = hostA,
        run: String? = "run-1",
        targets: List<NativeCliTarget> = listOf(claude, codex),
        createEligible: Boolean = true,
        nativeEligible: Boolean = true,
        catalogScope: NativeCatalogScope? = scope,
    ): OwnerChoice = OwnerChoice(
        hostId = host,
        label = "Owner ${host.value}",
        endpointDisplayText = "${host.value}.invalid:8443",
        connection = HostConnectionState.CONNECTED,
        createEligible = createEligible,
        hostRunId = run,
        nativeTargets = if (nativeEligible) targets else emptyList(),
        nativeCatalogScope = if (nativeEligible) catalogScope else null,
        nativeCreateEligible = nativeEligible,
    )

    private fun row(
        backend: SessionBackend? = SessionBackend.CLAUDE,
        label: String = "My caption",
        lifecycle: RosterLifecycle = RosterLifecycle.ALIVE,
        nativeName: String? = "Pi conversation",
    ): SessionUiState = SessionUiState(
        hostId = hostA,
        hostLabel = "Owner A",
        hostRunId = "run-1",
        stale = false,
        rosterRevision = 1L,
        metadata = RemoteSessionMetadata(
            id = "row-1",
            label = label,
            workspace = "/srv/owner/work",
            lifecycle = lifecycle,
            hasLiveProcess = true,
            inputSurface = false,
            nativeSession = nativeName?.let { RemoteNativeSession("conversation-1", 2L, it) },
            backend = backend,
        ),
    )

    @Test
    fun `native capabilities are projected independently of the Pi lanes`() {
        val nativeOnly = HostCapabilities.fromAcknowledged(
            listOf(RosterWire.REQUIRED_CAPABILITY, RosterWire.NATIVE_CAPABILITY),
            1,
        )
        assertEquals(CapabilityStatus.SUPPORTED, nativeOnly.native)
        assertEquals(CapabilityStatus.UNSUPPORTED, nativeOnly.nativeName)
        assertEquals(CapabilityStatus.UNSUPPORTED, nativeOnly.create)
        assertEquals(CapabilityStatus.UNSUPPORTED, nativeOnly.rename)
        val named = HostCapabilities.fromAcknowledged(
            listOf(RosterWire.NATIVE_CAPABILITY, RosterWire.NATIVE_NAME_CAPABILITY),
            1,
        )
        assertEquals(CapabilityStatus.SUPPORTED, named.statusOf(RosterWire.NATIVE_NAME_CAPABILITY))
        assertEquals(CapabilityStatus.UNKNOWN, HostCapabilities.UNKNOWN.statusOf(RosterWire.NATIVE_CAPABILITY))
    }

    @Test
    fun `owner choices carry only the current host run's advertised catalog`() {
        val host = HostUiState(
            host = io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost(
                hostA, io.github.rfairburn.pireviewgate.core.hosts.HostLabel.parse("Owner A"),
                io.github.rfairburn.pireviewgate.core.hosts.Endpoint("provider-host-a.invalid", 8443),
            ),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, "run-1", 3L, emptyList()),
            capabilities = HostCapabilities.fromAcknowledged(
                listOf(RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_CAPABILITY, RosterWire.NATIVE_AVAILABILITY_CAPABILITY), 1,
            ),
            nativeCliTargets = listOf(claude, codex),
            nativeCatalogScope = scope,
        )
        val choice = OwnerChoice.of(host)
        assertEquals(listOf(claude, codex), choice.nativeTargets)
        assertEquals("run-1", choice.hostRunId)
        assertEquals(true, choice.nativeCreateEligible)
        assertEquals(true, choice.createEligible)

        val noCatalog = OwnerChoice.of(host.copy(nativeCliTargets = null, nativeCatalogScope = null))
        assertEquals(emptyList<NativeCliTarget>(), noCatalog.nativeTargets)
        assertEquals(false, noCatalog.nativeCreateEligible)
        val stale = OwnerChoice.of(host.copy(roster = host.roster?.copy(freshness = RosterFreshness.STALE)))
        assertEquals(emptyList<NativeCliTarget>(), stale.nativeTargets)
        assertEquals(false, stale.nativeCreateEligible)
    }

    private fun availabilityHost(
        capabilities: List<String> = listOf(
            RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_CAPABILITY, RosterWire.NATIVE_AVAILABILITY_CAPABILITY,
        ),
        targets: List<NativeCliTarget>? = listOf(claude, codex),
        connection: HostConnectionState = HostConnectionState.CONNECTED,
    ): HostUiState = HostUiState(
        host = io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost(
            hostA, io.github.rfairburn.pireviewgate.core.hosts.HostLabel.parse("Owner A"),
            io.github.rfairburn.pireviewgate.core.hosts.Endpoint("provider-host-a.invalid", 8443),
        ),
        connection = connection,
        roster = RosterSnapshot(RosterFreshness.CURRENT, "run-1", 3L, emptyList()),
        capabilities = HostCapabilities.fromAcknowledged(capabilities, 1),
        nativeCliTargets = targets,
        nativeCatalogScope = targets?.let { scope },
    )

    @Test
    fun `native availability is a dependent capability projected from the acknowledgement`() {
        val described = HostCapabilities.fromAcknowledged(
            listOf(RosterWire.NATIVE_CAPABILITY, RosterWire.NATIVE_AVAILABILITY_CAPABILITY), 1,
        )
        assertEquals(CapabilityStatus.SUPPORTED, described.nativeAvailability)
        assertEquals(CapabilityStatus.SUPPORTED, described.statusOf(RosterWire.NATIVE_AVAILABILITY_CAPABILITY))
        val legacy = HostCapabilities.fromAcknowledged(listOf(RosterWire.NATIVE_CAPABILITY), 1)
        assertEquals(CapabilityStatus.UNSUPPORTED, legacy.nativeAvailability)
        // Without the lane it describes, the description is never projected as support.
        val orphan = HostCapabilities.fromAcknowledged(listOf(RosterWire.NATIVE_AVAILABILITY_CAPABILITY), 1)
        assertEquals(CapabilityStatus.UNSUPPORTED, orphan.nativeAvailability)
        assertEquals(CapabilityStatus.UNKNOWN, HostCapabilities.UNKNOWN.statusOf(RosterWire.NATIVE_AVAILABILITY_CAPABILITY))
    }

    @Test
    fun `a legacy owner's unknown native availability offers no native choice and keeps Pi`() {
        // The same catalog, but the owner never described it as a launch probe.
        val legacy = availabilityHost(capabilities = listOf(RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_CAPABILITY))
        assertEquals(false, legacy.canCreateNativeSession)
        val choice = OwnerChoice.of(legacy)
        assertEquals(emptyList<NativeCliTarget>(), choice.nativeTargets)
        assertNull(choice.nativeCatalogScope)
        assertEquals(false, choice.nativeCreateEligible)
        assertEquals(listOf(CreateProviderChoice.Pi), CreateProviderSelection.options(choice))
        assertEquals(true, CreateProviderSelection.admits(choice, CreateProviderChoice.Pi))
        // A native choice frozen from such an owner is refused, never converted to Pi.
        assertEquals(false, CreateProviderSelection.admits(choice, CreateProviderSelection.choiceOf(claude, scope)))
        assertNull(CreateProviderSelection.reconcile(choice, choice, CreateProviderSelection.choiceOf(claude, scope)))
        // Pi stays offered only on the owner's own current create capability.
        val noCreate = OwnerChoice.of(availabilityHost(capabilities = listOf(RosterWire.NATIVE_CAPABILITY)))
        assertEquals(false, noCreate.createEligible)
        assertEquals(false, CreateProviderSelection.admits(noCreate, CreateProviderChoice.Pi))
    }

    @Test
    fun `a described availability catalog offers exactly the advertised default kinds`() {
        val both = OwnerChoice.of(availabilityHost(targets = listOf(claude, codex)))
        assertEquals(
            listOf(CreateProviderChoice.Pi, CreateProviderSelection.choiceOf(claude, scope),
                CreateProviderSelection.choiceOf(codex, scope)),
            CreateProviderSelection.options(both),
        )
        val claudeOnly = OwnerChoice.of(availabilityHost(targets = listOf(claude)))
        assertEquals(
            listOf(CreateProviderChoice.Pi, CreateProviderSelection.choiceOf(claude, scope)),
            CreateProviderSelection.options(claudeOnly),
        )
        assertEquals(false, CreateProviderSelection.admits(claudeOnly, CreateProviderSelection.choiceOf(codex, scope)))
        val codexOnly = OwnerChoice.of(availabilityHost(targets = listOf(codex)))
        assertEquals(
            listOf(CreateProviderChoice.Pi, CreateProviderSelection.choiceOf(codex, scope)),
            CreateProviderSelection.options(codexOnly),
        )
        assertEquals(false, CreateProviderSelection.admits(codexOnly, CreateProviderSelection.choiceOf(claude, scope)))
        // The probe found nothing launchable: an empty catalog keeps the Pi-only form.
        val none = OwnerChoice.of(availabilityHost(targets = emptyList()))
        assertEquals(false, none.nativeCreateEligible)
        assertEquals(listOf(CreateProviderChoice.Pi), CreateProviderSelection.options(none))
        // A named profile in a described catalog is still never a NEW choice.
        val profiles = OwnerChoice.of(availabilityHost(targets = listOf(namedProfile, codex)))
        assertEquals(listOf(codex), profiles.nativeTargets)
        // A disconnected owner offers nothing native, whatever it last described.
        val offline = OwnerChoice.of(availabilityHost(connection = HostConnectionState.DISCONNECTED))
        assertEquals(false, offline.nativeCreateEligible)
        assertEquals(false, offline.createEligible)
    }

    @Test
    fun `a refreshed catalog that withdrew the chosen kind asks to choose again and never selects Pi`() {
        val before = OwnerChoice.of(availabilityHost(targets = listOf(claude, codex)))
        val chosen = CreateProviderSelection.choiceOf(claude, scope)
        val refreshed = OwnerChoice.of(availabilityHost(targets = listOf(codex)))
            .copy(nativeCatalogScope = scope.copy(epoch = 3L))
        assertNull(CreateProviderSelection.reconcile(before, refreshed, chosen))
        // Pi chosen before the refresh stays Pi; nothing switches it either way.
        assertEquals(CreateProviderChoice.Pi, CreateProviderSelection.reconcile(before, refreshed, CreateProviderChoice.Pi))
    }

    @Test
    fun `options come only from the selected owner's catalog and Pi is always the default`() {
        val a = owner()
        val b = owner(host = hostB, targets = listOf(NativeCliTarget("codex", NativeCliBackend.CODEX, "Other")))
        assertEquals(
            listOf(
                CreateProviderChoice.Pi,
                CreateProviderSelection.choiceOf(claude, scope),
                CreateProviderSelection.choiceOf(codex, scope),
            ),
            CreateProviderSelection.options(a),
        )
        assertEquals(
            listOf(CreateProviderChoice.Pi, CreateProviderChoice.Native(
                NativeCliBackend.CODEX, "codex", "Other", scope,
            )),
            CreateProviderSelection.options(b),
        )
        // An owner with no catalog keeps the Pi-only form.
        assertEquals(listOf(CreateProviderChoice.Pi), CreateProviderSelection.options(a.copy(nativeTargets = emptyList())))
        assertEquals(listOf(CreateProviderChoice.Pi), CreateProviderSelection.options(null))
    }

    @Test
    fun `a native choice is exact on host backend id and label and never falls back to Pi`() {
        val a = owner()
        assertNull(CreateProviderSelection.reconcile(a, a, null))
        assertEquals(CreateProviderChoice.Pi, CreateProviderSelection.reconcile(a, a, CreateProviderChoice.Pi))
        val choice = CreateProviderSelection.choiceOf(claude, scope)
        assertEquals(choice, CreateProviderSelection.reconcile(a, a, choice))

        // The same target under the OTHER host is not this form's host-scoped choice.
        assertNull(CreateProviderSelection.reconcile(a, owner(host = hostB), choice))
        // A replaced owner run invalidates rather than retargeting.
        assertNull(CreateProviderSelection.reconcile(a, a.copy(hostRunId = "run-2"), choice))
        // Any catalog change invalidates, including a label-only change.
        assertNull(CreateProviderSelection.reconcile(a, a.copy(nativeTargets = listOf(claude.copy(label = "Renamed"))), choice))
        // A new catalog observation with the same target content invalidates too.
        assertNull(CreateProviderSelection.reconcile(
            a, a.copy(nativeCatalogScope = scope.copy(epoch = 2L)), choice,
        ))
        // A reconnect is a fresh channel lifetime even with the same run and catalog.
        assertNull(CreateProviderSelection.reconcile(
            a, a.copy(nativeCatalogScope = scope.copy(channelGeneration = 2L)), choice,
        ))
        // The other backend cannot answer for this id.
        assertNull(CreateProviderSelection.reconcile(
            a, a, CreateProviderChoice.Native(NativeCliBackend.CODEX, claude.id, claude.label, scope),
        ))
        // Losing native eligibility invalidates the native choice; Pi is not substituted.
        assertNull(CreateProviderSelection.reconcile(a, a.copy(nativeCreateEligible = false), choice))
    }

    @Test
    fun `owner changes preserve only same-owner choice and never restore Pi from native`() {
        val native = CreateProviderSelection.choiceOf(claude, scope)
        // Same-owner reselection is handled by the controller preserving `form.provider`
        // without calling afterOwnerChange; that exact preservation is asserted here.
        assertEquals(native, CreateProviderSelection.reconcile(owner(), owner(), native))
        // A real destination change after a native choice invalidates to "choose again".
        assertNull(CreateProviderSelection.afterOwnerChange(native))
        // Pi remains the fresh-form default and survives a destination change as Pi.
        assertEquals(CreateProviderChoice.Pi, CreateProviderSelection.afterOwnerChange(CreateProviderChoice.Pi))
        assertNull(CreateProviderSelection.afterOwnerChange(null))
    }

    @Test
    fun `Pi and native eligibility remain distinct`() {
        val piOnly = owner(createEligible = true, nativeEligible = false, targets = emptyList())
        assertEquals(true, CreateProviderSelection.admits(piOnly, CreateProviderChoice.Pi))
        assertEquals(false, CreateProviderSelection.admits(piOnly, CreateProviderSelection.choiceOf(claude, scope)))
        val nativeOnly = owner(createEligible = false, nativeEligible = true)
        assertEquals(false, CreateProviderSelection.admits(nativeOnly, CreateProviderChoice.Pi))
        assertEquals(true, CreateProviderSelection.admits(nativeOnly, CreateProviderSelection.choiceOf(claude, scope)))
        assertEquals(false, CreateProviderSelection.admits(null, CreateProviderChoice.Pi))
    }

    @Test
    fun `only backend default targets are NEW-session choices`() {
        assertEquals(true, isNativeCliNewSessionTarget(NativeCliBackend.CLAUDE, "claude"))
        assertEquals(true, isNativeCliNewSessionTarget(NativeCliBackend.CODEX, "codex"))
        assertEquals(false, isNativeCliNewSessionTarget(NativeCliBackend.CODEX, "claude"))
        assertEquals(false, isNativeCliNewSessionTarget(NativeCliBackend.CLAUDE, "external:claude"))
        assertEquals(false, isNativeCliNewSessionTarget(NativeCliBackend.CODEX, "external:review-box"))
        assertEquals(true, codex.isNewSessionTarget)
        assertEquals(false, namedProfile.isNewSessionTarget)
    }

    @Test
    fun `an older owner's advertised named profile is never offered or admitted for NEW`() {
        val host = HostUiState(
            host = io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost(
                hostA, io.github.rfairburn.pireviewgate.core.hosts.HostLabel.parse("Owner A"),
                io.github.rfairburn.pireviewgate.core.hosts.Endpoint("provider-host-a.invalid", 8443),
            ),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, "run-1", 3L, emptyList()),
            capabilities = HostCapabilities.fromAcknowledged(
                listOf(RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_CAPABILITY, RosterWire.NATIVE_AVAILABILITY_CAPABILITY), 1,
            ),
            nativeCliTargets = listOf(claude, namedProfile, codex),
            nativeCatalogScope = scope,
        )
        // The committed wire catalog keeps the legacy entry; only the NEW view drops it.
        assertEquals(listOf(claude, namedProfile, codex), host.nativeCliTargets)
        val choice = OwnerChoice.of(host)
        assertEquals(listOf(claude, codex), choice.nativeTargets)
        assertEquals(
            listOf(
                CreateProviderChoice.Pi,
                CreateProviderSelection.choiceOf(claude, scope),
                CreateProviderSelection.choiceOf(codex, scope),
            ),
            CreateProviderSelection.options(choice),
        )
        // Even a directly constructed owner whose list carries the profile neither
        // offers nor admits it, so the controller's submit gate refuses it.
        val direct = owner(targets = listOf(claude, namedProfile))
        assertEquals(
            listOf(CreateProviderChoice.Pi, CreateProviderSelection.choiceOf(claude, scope)),
            CreateProviderSelection.options(direct),
        )
        assertEquals(false, CreateProviderSelection.admits(direct, CreateProviderSelection.choiceOf(namedProfile, scope)))
        assertEquals(false, CreateProviderSelection.admits(choice, CreateProviderSelection.choiceOf(namedProfile, scope)))

        // An owner advertising ONLY named profiles offers the Pi-only form.
        val namedOnly = OwnerChoice.of(host.copy(nativeCliTargets = listOf(namedProfile)))
        assertEquals(emptyList<NativeCliTarget>(), namedOnly.nativeTargets)
        assertEquals(false, namedOnly.nativeCreateEligible)
        assertNull(namedOnly.nativeCatalogScope)
        assertEquals(listOf(CreateProviderChoice.Pi), CreateProviderSelection.options(namedOnly))
        assertEquals(true, CreateProviderSelection.admits(namedOnly, CreateProviderChoice.Pi))
    }

    @Test
    fun `native card title is the owner caption provider fallback or unavailable grammar`() {
        assertEquals("My caption", row().displayTitle)
        assertEquals("Claude", row(label = "   ").displayTitle)
        assertEquals("Claude", row(label = "\u00A0").displayTitle, "the host JS-trim rule is the card rule")
        assertEquals("My caption (unavailable)", row(lifecycle = RosterLifecycle.ERROR).displayTitle)
        // A Pi row keeps the exact existing native-conversation title behavior.
        assertEquals("Pi conversation", row(backend = SessionBackend.PI).displayTitle)
        assertEquals("Pi conversation", row(backend = null).displayTitle)
        // The native row never borrows its Pi conversation name.
        assertEquals("My caption", row(nativeName = "Pi conversation that must not show").displayTitle)
        assertEquals("Claude", row(label = "", nativeName = "Pi name").displayTitle)
    }

    @Test
    fun `native caption target requires the owner-reported backend and no Pi tuple`() {
        val native = row()
        val target = assertNotNull(NativeRenameTarget.of(native))
        assertEquals(NativeCliBackend.CLAUDE, target.backend)
        assertEquals("My caption", target.currentCaption)
        assertEquals(
            NativeRenameTarget(SessionActionTarget.of(native), NativeCliBackend.CLAUDE, "My caption"),
            target,
        )
        val unavailable = row(lifecycle = RosterLifecycle.ERROR)
        assertEquals("My caption", unavailable.nativeCaption)
        assertEquals("My caption (unavailable)", unavailable.displayTitle)
        assertEquals("My caption", assertNotNull(NativeRenameTarget.of(unavailable)).currentCaption)
        assertNull(NativeRenameTarget.of(row(backend = SessionBackend.PI)))
        assertNull(NativeRenameTarget.of(row(backend = null)))
        assertEquals(SessionBackend.CLAUDE, native.metadata.backend)
        assertEquals("Claude", native.providerLabel)
    }
}
