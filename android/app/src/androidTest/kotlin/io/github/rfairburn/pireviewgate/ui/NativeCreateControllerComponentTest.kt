package io.github.rfairburn.pireviewgate.ui

import android.os.Build
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.rfairburn.pireviewgate.client.application.ClientApplicationController
import io.github.rfairburn.pireviewgate.client.platform.AndroidClientPlatform
import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.platform.CachedLocalNetworkAdmission
import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.runtime.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.*
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationOrderCoordinator
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliTarget
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicReference

/**
 * The production controller's owner-change rule for the additive native provider
 * choice. Synthetic registry/runtime observations only: no host, transport, or owner
 * operation is installed.
 */
@RunWith(AndroidJUnit4::class)
class NativeCreateControllerComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private var controller: ClientApplicationController? = null
    private var platform: AndroidClientPlatform? = null

    @After fun tearDown() {
        controller?.let { c ->
            runCatching {
                val field = ClientApplicationController::class.java.getDeclaredField("scope")
                field.isAccessible = true
                (field.get(c) as CoroutineScope).cancel()
            }
            runCatching { runBlocking { c.runtime.close() } }
        }
        platform?.let { p -> runCatching { compose.runOnIdle { p.close() } } }
    }

    @Test fun ownerChangesPreserveSameOwnerAndInvalidateNativeToNoProvider() {
        val start = start()
        compose.runOnIdle { start.intent(ClientIntent.RequestSessionCreate) }
        assertEquals("a fresh form defaults to Pi", CreateProviderChoice.Pi,
            start.ui.value.dialogs.createSession?.provider)

        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        val form = requireNotNull(start.ui.value.dialogs.createSession)
        val native = form.providerOptions.filterIsInstance<CreateProviderChoice.Native>().single()
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateProvider(native)) }
        assertEquals(native, start.ui.value.dialogs.createSession?.provider)

        // Reselecting the same owner preserves the exact native choice.
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        assertEquals(native, start.ui.value.dialogs.createSession?.provider)

        // A Pi-only destination invalidates the native choice to "choose again" and
        // keeps the provider control representable rather than silently restoring Pi.
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostC)) }
        assertNull(start.ui.value.dialogs.createSession?.provider)
        assertEquals(listOf(CreateProviderChoice.Pi), start.ui.value.dialogs.createSession?.providerOptions)

        // Returning to a native owner while no provider is chosen stays "choose again"
        // (never an automatic Pi), and the operator can explicitly choose native again.
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        assertNull(start.ui.value.dialogs.createSession?.provider)
        val nativeAgain = requireNotNull(start.ui.value.dialogs.createSession)
            .providerOptions.filterIsInstance<CreateProviderChoice.Native>().single()
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateProvider(nativeAgain)) }
        assertEquals(nativeAgain, start.ui.value.dialogs.createSession?.provider)

        // Another native-capable destination invalidates to "choose again", never Pi.
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostB)) }
        assertNull(start.ui.value.dialogs.createSession?.provider)
        assertTrue(start.ui.value.dialogs.createSession?.providerOptions
            ?.any { it is CreateProviderChoice.Native } == true)

        // An already-chosen Pi provider remains Pi on a destination change.
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostC)) }
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateProvider(CreateProviderChoice.Pi)) }
        assertEquals(CreateProviderChoice.Pi, start.ui.value.dialogs.createSession?.provider)
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostB)) }
        assertEquals(CreateProviderChoice.Pi, start.ui.value.dialogs.createSession?.provider)
    }

    @Test fun legacyOwnerUnknownAvailabilityOffersNoNativeChoiceAndUnadoptedChannelIsNeverRefreshed() {
        val start = start()
        compose.runOnIdle { start.intent(ClientIntent.RequestSessionCreate) }
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostD)) }
        val legacyForm = requireNotNull(start.ui.value.dialogs.createSession)
        // Its catalog is configuration-only (availability unknown), so only Pi is offered,
        // and Pi stays the fresh-form default on the owner's own create capability.
        assertEquals(listOf(CreateProviderChoice.Pi), legacyForm.providerOptions)
        assertEquals(CreateProviderChoice.Pi, legacyForm.provider)
        assertTrue(legacyForm.selectedOwner?.createEligible == true)
        assertFalse(legacyForm.selectedOwner?.nativeCreateEligible == true)

        // A described-availability owner offers its native kind; leaving it for the
        // legacy owner invalidates that choice to "choose again", never Pi.
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        val native = requireNotNull(start.ui.value.dialogs.createSession)
            .providerOptions.filterIsInstance<CreateProviderChoice.Native>().single()
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateProvider(native)) }
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostD)) }
        assertNull(start.ui.value.dialogs.createSession?.provider)
        assertEquals(listOf(CreateProviderChoice.Pi), start.ui.value.dialogs.createSession?.providerOptions)

        // This scenario adopted no channel, so the refresh fence never reaches a lane:
        // selecting owners neither connects nor retires anything.
        val field = ClientApplicationController::class.java.getDeclaredField("createRefresh")
        field.isAccessible = true
        val refresh = field.get(start) as io.github.rfairburn.pireviewgate.core.client.application.CreateOwnerRefresh
        assertFalse(refresh.isRefreshing(ObservedState.hostA))
        assertFalse(refresh.isRefreshing(ObservedState.hostD))
    }

    private fun start(): ClientApplicationController {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = AndroidClientStorage.settingsStore(context)
        val pins = AndroidClientStorage.pinStore(context)
        val identity = AndroidClientStorage.identityStore(context)
        val presentation = AndroidClientStorage.presentationOrderStore(context)
        val registry = HostConnectionRegistry(settings, pins, identity, { false })
        runBlocking { withContext(Dispatchers.IO) { registry.start() } }
        val platformCtor = AndroidClientPlatform::class.java.declaredConstructors.single {
            it.parameterCount == 7 && !it.isSynthetic
        }
        platformCtor.isAccessible = true
        val builtPlatform = platformCtor.newInstance(
            context.applicationContext, settings, pins, identity, presentation,
            CachedLocalNetworkAdmission(Build.VERSION.SDK_INT), registry,
        ) as AndroidClientPlatform
        val controllerCtor = ClientApplicationController::class.java.declaredConstructors.single {
            it.parameterCount == 3 && !it.isSynthetic
        }
        controllerCtor.isAccessible = true
        val built = controllerCtor.newInstance(
            builtPlatform,
            RemotePresentationOrderCoordinator(),
            AtomicReference<ClientApplicationController.PromptStanding?>(null),
        ) as ClientApplicationController
        installRuntimeObservation(built.runtime, ObservedState.runtime())
        setRegistrySnapshot(registry, ObservedState.registry())
        compose.runOnIdle { refresh(built) }
        controller = built
        platform = builtPlatform
        return built
    }

    private fun setRegistrySnapshot(registry: HostConnectionRegistry, snapshot: ConnectionRegistrySnapshot) {
        val field = HostConnectionRegistry::class.java.getDeclaredField("_snapshot")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        (field.get(registry) as MutableStateFlow<ConnectionRegistrySnapshot>).value = snapshot
    }

    private fun refresh(controller: ClientApplicationController) {
        val method = ClientApplicationController::class.java.getDeclaredMethod("refresh")
        method.isAccessible = true
        method.invoke(controller)
    }

    /**
     * Publish the synthetic lane observation on the flow the controller reads, and keep it
     * there for the whole scenario.
     *
     * `ClientRuntime.publishState()` rebuilds the published state from the host lanes that
     * are actually attached, and both [ClientApplicationController.intent] and
     * `refresh()` report terminal coverage through
     * [ClientRuntime.setTerminalInputCoverage], which republishes on every call. So one
     * write to the runtime's own flow is rebuilt away during the very first refresh, and
     * the next projection honestly sees three hosts with no roster, no acknowledged
     * capability, and no advertised catalog — the create form then offers only Pi and the
     * native choice can never be admitted or preserved.
     *
     * This scenario installs no lane by contract (no transport and no owner operation),
     * so the runtime's internal publication target is pointed at a separate flow nothing
     * reads, and the observation above stays the only thing the controller projects. Only
     * where the observation comes from changes: the controller still projects, mints and
     * invalidates proofs, admits, and reconciles the provider choice through production
     * code, and no owner, catalog, capability, proof, or timing rule is relaxed.
     */
    private fun installRuntimeObservation(runtime: ClientRuntime, state: ClientRuntimeState) {
        val field = ClientRuntime::class.java.getDeclaredField("stateFlow")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val published = field.get(runtime) as MutableStateFlow<ClientRuntimeState>
        // `ClientRuntime.state` is this same object, and it is what the controller reads.
        published.value = state
        // Production republishes land here instead, and nothing reads this one.
        field.set(runtime, MutableStateFlow(state))
    }

    private object ObservedState {
        val hostA = HostId.parse("native-controller-a")
        val hostB = HostId.parse("native-controller-b")
        val hostC = HostId.parse("native-controller-c")
        /** A legacy owner: native lane and catalog, but no described availability (#493). */
        val hostD = HostId.parse("native-controller-d")
        val runA = "11111111-1111-4111-8111-111111111111"
        val runB = "22222222-2222-4222-8222-222222222222"
        val runC = "33333333-3333-4333-8333-333333333333"
        val runD = "44444444-4444-4444-8444-444444444444"
        val target = NativeCliTarget("claude", NativeCliBackend.CLAUDE, "Claude default")
        val scopeA = NativeCatalogScope(runA, 1L, 1L)
        val scopeB = NativeCatalogScope(runB, 1L, 1L)
        val scopeD = NativeCatalogScope(runD, 1L, 1L)
        val availability = listOf(
            RosterWire.CLOSE_CAPABILITY,
            RosterWire.CREATE_CAPABILITY,
            RosterWire.NATIVE_CAPABILITY,
            RosterWire.NATIVE_NAME_CAPABILITY,
            RosterWire.NATIVE_AVAILABILITY_CAPABILITY,
        )
        val legacy = availability - RosterWire.NATIVE_AVAILABILITY_CAPABILITY

        fun registry() = ConnectionRegistrySnapshot(
            generation = 1,
            settingsGeneration = 1,
            foreground = true,
            autoReconnectEnabled = false,
            viewerRemoteInputEnabled = false,
            identity = DeviceIdentityObservation.NeverInitialized,
            storage = StorageObservation(StorageHandleState(available = true), StorageHandleState(available = true)),
            hosts = listOf(hostA, hostB, hostC, hostD).mapIndexed { index, hostId ->
                HostConnectionSnapshot(
                    hostId, Endpoint("native-controller-$index.invalid", 8443), "Native owner $index",
                    HostConnectionPhase.CONNECTED, HostConnectionReason.NONE,
                    generation = 1, previouslyConnected = true, reconnectSuppressed = false,
                    autoEligible = false, peerFingerprint = null,
                )
            },
            pendingConsents = emptyList(),
            notice = null,
        )

        fun runtime() = ClientRuntimeState(
            hosts = listOf(
                HostRuntimeState(hostA, 1, HostLanePhase.ATTACHED, roster(
                    hostA, runA, scopeA, listOf(target),
                )),
                HostRuntimeState(hostB, 1, HostLanePhase.ATTACHED, roster(
                    hostB, runB, scopeB, listOf(target),
                )),
                // Pi-only: it holds create but advertises no native catalog.
                HostRuntimeState(hostC, 1, HostLanePhase.ATTACHED, roster(hostC, runC, null, emptyList())),
                HostRuntimeState(hostD, 1, HostLanePhase.ATTACHED, roster(
                    hostD, runD, scopeD, listOf(target), capabilities = legacy,
                )),
            ),
            selection = null,
            pendingSelection = null,
            rememberedTarget = null,
            restoreArmed = false,
            visibility = VisibilitySnapshot(appForeground = true, terminalInputCovered = true),
            viewport = null,
            inputPolicy = io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy(false, 0),
            terminalInputAdmissionOpen = false,
            closed = false,
        )

        private fun roster(
            hostId: HostId,
            run: String,
            scope: NativeCatalogScope?,
            targets: List<NativeCliTarget>,
            capabilities: List<String> = availability,
        ): RosterClientState = RosterClientState(
            hostId = hostId.value,
            generation = 1,
            phase = RosterClientPhase.SUBSCRIBED,
            projection = RosterProjection(
                state = RosterProjectionState.CURRENT,
                rows = listOf(RemoteSessionMetadata(
                    id = "native-row",
                    label = "Synthetic native row",
                    workspace = "/synthetic/native",
                    lifecycle = RosterLifecycle.ALIVE,
                    hasLiveProcess = true,
                    inputSurface = false,
                )),
                hostRunId = run,
                revision = 1L,
                subscriptionId = "synthetic-native-$run",
                reason = null,
                nativeCliTargets = targets,
                nativeCatalogScope = scope,
            ),
            subscriptionId = "synthetic-native-$run",
            subscriptionRunId = run,
            capabilities = capabilities,
            savedPolicy = null,
            savedOwnership = null,
            pending = emptyList(),
            inFlightTransfer = null,
            retiringSubscriptionId = null,
            stopRequested = false,
            createSequence = 0,
            renameSequence = 0,
            savedSequence = 0,
            armedCloseConfirmationRows = emptyList(),
        )
    }
}
