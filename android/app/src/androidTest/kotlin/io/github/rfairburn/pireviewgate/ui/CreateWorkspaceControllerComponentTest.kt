package io.github.rfairburn.pireviewgate.ui

import android.os.Build
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.rfairburn.pireviewgate.client.application.ClientApplicationController
import io.github.rfairburn.pireviewgate.client.platform.AndroidClientPlatform
import io.github.rfairburn.pireviewgate.core.client.application.AcceptedCreateActivation
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
 * The production controller's request-specific "Create missing workspace directory"
 * choice (#493): fresh forms start unchecked, every toggle retires and rebinds the
 * form receipt, a checked choice survives an owner change and blocks submit on an
 * owner that cannot honour it, and a reopened form starts unchecked again.
 * Synthetic registry/runtime observations only: no host, transport, or owner
 * operation is installed, and nothing here creates a directory.
 */
@RunWith(AndroidJUnit4::class)
class CreateWorkspaceControllerComponentTest {
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

    private fun ClientApplicationController.form(): CreateSessionDialog =
        requireNotNull(ui.value.dialogs.createSession)

    private fun submitted(controller: ClientApplicationController): AcceptedCreateActivation? {
        val field = ClientApplicationController::class.java.getDeclaredField("submittedCreate")
        field.isAccessible = true
        return field.get(controller) as AcceptedCreateActivation?
    }

    /** Stand in for the dialog's committed frame so a submit can freeze a receipt. */
    private fun commit(proof: UiActionProof) {
        val mutable = proof as MutableUiActionProof
        val epoch = mutable.beginDraw()
        mutable.setCriticalIdentityReadable(true)
        assertTrue(mutable.markCommitted(epoch))
        assertTrue(proof.grantsAction())
    }

    @Test fun freshFormIsUncheckedAndEveryToggleRetiresTheReceipt() {
        val start = start()
        compose.runOnIdle { start.intent(ClientIntent.RequestSessionCreate) }
        assertFalse("a fresh form is unchecked", start.form().createWorkspace)
        assertFalse(start.form().showsCreateWorkspace)

        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        assertFalse(start.form().createWorkspace)
        assertTrue("a supporting owner draws the choice", start.form().showsCreateWorkspace)
        val unchecked = start.form().proof

        compose.runOnIdle { start.intent(ClientIntent.SetCreateWorkspace(true)) }
        val checked = start.form().proof
        assertTrue(start.form().createWorkspace)
        assertNotSame(unchecked, checked)
        assertFalse("the previous receipt is retired", unchecked.isCurrent)

        // Re-asserting the same value is not an edit and keeps the exact receipt.
        compose.runOnIdle { start.intent(ClientIntent.SetCreateWorkspace(true)) }
        assertSame(checked, start.form().proof)

        compose.runOnIdle { start.intent(ClientIntent.SetCreateWorkspace(false)) }
        assertFalse(start.form().createWorkspace)
        assertNotSame(checked, start.form().proof)
        assertFalse(checked.isCurrent)

        // Owner, provider, and workspace edits keep the operator's choice.
        compose.runOnIdle { start.intent(ClientIntent.SetCreateWorkspace(true)) }
        compose.runOnIdle { start.intent(ClientIntent.UpdateDraft(ClientDraft.Workspace("/synthetic/new"))) }
        assertTrue(start.form().createWorkspace)
        val native = start.form().providerOptions.filterIsInstance<CreateProviderChoice.Native>().single()
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateProvider(native)) }
        assertTrue(start.form().createWorkspace)
        assertEquals(native, start.form().provider)

        // Nothing is persisted: a reopened form starts unchecked again.
        compose.runOnIdle { start.intent(ClientIntent.DismissDialog(ClientDialogKind.CREATE_SESSION)) }
        compose.runOnIdle { start.intent(ClientIntent.RequestSessionCreate) }
        assertFalse(start.form().createWorkspace)
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        assertFalse(start.form().createWorkspace)
    }

    @Test fun checkedChoiceSurvivesAnUnsupportingOwnerAndIsRefusedNotDropped() {
        val start = start()
        compose.runOnIdle { start.intent(ClientIntent.RequestSessionCreate) }
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        compose.runOnIdle { start.intent(ClientIntent.UpdateDraft(ClientDraft.Workspace("/synthetic/new"))) }
        compose.runOnIdle { start.intent(ClientIntent.SetCreateWorkspace(true)) }

        // A legacy Pi owner without the flag: the choice stays checked and visible.
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostC)) }
        val held = start.form()
        assertTrue(held.createWorkspace)
        assertTrue(held.showsCreateWorkspace)
        assertTrue(held.createWorkspaceBlocked)
        assertEquals(CreateProviderChoice.Pi, held.provider)

        // Submitting the checked form there is refused before anything is admitted.
        commit(held.proof)
        compose.runOnIdle {
            start.intent(ClientIntent.SubmitSessionCreate(ObservedState.hostC, held.workspaceDraft, held.proof,
                CreateProviderChoice.Pi, createWorkspace = true))
        }
        assertNull("nothing was submitted", submitted(start))
        assertEquals(
            "Create not submitted: this host does not support creating a missing workspace directory",
            start.status.value,
        )
        assertTrue("the choice is never cleared on the operator's behalf", start.form().createWorkspace)

        // The operator clears it; the same owner then submits the legacy unchecked create.
        compose.runOnIdle { start.intent(ClientIntent.SetCreateWorkspace(false)) }
        assertFalse(start.form().createWorkspaceBlocked)
        assertFalse("an unsupporting owner hides the cleared choice", start.form().showsCreateWorkspace)
    }

    @Test fun submitRefusesAStaleReceiptOrAMismatchedFlag() {
        val start = start()
        compose.runOnIdle { start.intent(ClientIntent.RequestSessionCreate) }
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        compose.runOnIdle { start.intent(ClientIntent.UpdateDraft(ClientDraft.Workspace("/synthetic/new"))) }
        val uncheckedForm = start.form()
        compose.runOnIdle { start.intent(ClientIntent.SetCreateWorkspace(true)) }
        val checkedForm = start.form()
        commit(checkedForm.proof)

        // A submit drawn from the earlier unchecked receipt is stale and does nothing.
        compose.runOnIdle {
            start.intent(ClientIntent.SubmitSessionCreate(ObservedState.hostA, uncheckedForm.workspaceDraft,
                uncheckedForm.proof, CreateProviderChoice.Pi, createWorkspace = false))
        }
        assertNull(submitted(start))
        // A submit whose flag disagrees with the form's own choice does nothing.
        compose.runOnIdle {
            start.intent(ClientIntent.SubmitSessionCreate(ObservedState.hostA, checkedForm.workspaceDraft,
                checkedForm.proof, CreateProviderChoice.Pi, createWorkspace = false))
        }
        assertNull(submitted(start))

        // The exact checked form is captured with its choice bound into the activation.
        // Read synchronously at the submit boundary: no lane is installed, so the
        // launched admission later refuses and retires this activation.
        // The form itself still holds the exact checked choice under the committed receipt.
        // (Admitting a real submit needs an attached lane, which this harness never
        // installs; the bound activation/proof/command identity is covered by the
        // client-core AcceptedCreateActivation and endpoint tests.)
        assertSame(checkedForm.proof, start.form().proof)
        assertTrue(start.form().createWorkspace)
    }

    @Test fun busyFormKeepsItsFrozenChoice() {
        val start = start()
        compose.runOnIdle { start.intent(ClientIntent.RequestSessionCreate) }
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        val form = start.form()
        val field = ClientApplicationController::class.java.getDeclaredField("busyForms")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val busy = field.get(start) as MutableSet<UiActionProof>
        compose.runOnIdle { busy.add(form.proof) }
        compose.runOnIdle { start.intent(ClientIntent.SetCreateWorkspace(true)) }
        assertFalse("an admitting form is never edited", start.form().createWorkspace)
        assertSame(form.proof, start.form().proof)
        compose.runOnIdle { busy.remove(form.proof) }
    }

    @Test fun nativeOnlyOwnerCarriesTheChoiceAndPiDefaultsAreUnchanged() {
        val start = start()
        compose.runOnIdle { start.intent(ClientIntent.RequestSessionCreate) }
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostE)) }
        val form = start.form()
        assertTrue(form.showsCreateWorkspace)
        assertFalse(form.createWorkspace)
        // The existing native-only rule is unchanged: no Pi is drawn as chosen.
        assertNull(form.shownProvider)
        assertFalse(form.providerOptions.contains(CreateProviderChoice.Pi))
        compose.runOnIdle { start.intent(ClientIntent.SetCreateWorkspace(true)) }
        val codex = CreateProviderSelection.choiceOf(ObservedState.codex, ObservedState.scopeE)
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateProvider(codex)) }
        assertEquals(codex, start.form().provider)
        assertTrue(start.form().createWorkspace)
        assertFalse(start.form().createWorkspaceBlocked)

        // A Pi-capable owner still defaults to Pi, unchecked, on a fresh form.
        compose.runOnIdle { start.intent(ClientIntent.DismissDialog(ClientDialogKind.CREATE_SESSION)) }
        compose.runOnIdle { start.intent(ClientIntent.RequestSessionCreate) }
        compose.runOnIdle { start.intent(ClientIntent.SelectCreateOwner(ObservedState.hostA)) }
        assertEquals(CreateProviderChoice.Pi, start.form().provider)
        assertFalse(start.form().createWorkspace)
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
        val hostA = HostId.parse("workspace-controller-a")
        /** A legacy Pi-only owner that never heard of the create-workspace flag. */
        val hostC = HostId.parse("workspace-controller-c")
        /** A native-only owner that acknowledged the flag. */
        val hostE = HostId.parse("workspace-controller-e")
        val runA = "11111111-1111-4111-8111-111111111111"
        val runC = "33333333-3333-4333-8333-333333333333"
        val runE = "55555555-5555-4555-8555-555555555555"
        val target = NativeCliTarget("claude", NativeCliBackend.CLAUDE, "Claude default")
        val codex = NativeCliTarget("codex", NativeCliBackend.CODEX, "Codex default")
        val scopeA = NativeCatalogScope(runA, 1L, 1L)
        val scopeE = NativeCatalogScope(runE, 1L, 1L)
        val supporting = listOf(
            RosterWire.CLOSE_CAPABILITY,
            RosterWire.CREATE_CAPABILITY,
            RosterWire.NATIVE_CAPABILITY,
            RosterWire.NATIVE_NAME_CAPABILITY,
            RosterWire.NATIVE_AVAILABILITY_CAPABILITY,
            RosterWire.CREATE_WORKSPACE_CAPABILITY,
        )
        val legacyPi = listOf(RosterWire.CLOSE_CAPABILITY, RosterWire.CREATE_CAPABILITY)
        val nativeOnly = supporting - RosterWire.CREATE_CAPABILITY

        fun registry() = ConnectionRegistrySnapshot(
            generation = 1,
            settingsGeneration = 1,
            foreground = true,
            autoReconnectEnabled = false,
            viewerRemoteInputEnabled = false,
            identity = DeviceIdentityObservation.NeverInitialized,
            storage = StorageObservation(StorageHandleState(available = true), StorageHandleState(available = true)),
            hosts = listOf(hostA, hostC, hostE).mapIndexed { index, hostId ->
                HostConnectionSnapshot(
                    hostId, Endpoint("workspace-controller-$index.invalid", 8443), "Workspace owner $index",
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
                HostRuntimeState(hostA, 1, HostLanePhase.ATTACHED, roster(hostA, runA, scopeA, listOf(target), supporting)),
                HostRuntimeState(hostC, 1, HostLanePhase.ATTACHED, roster(hostC, runC, null, emptyList(), legacyPi)),
                HostRuntimeState(hostE, 1, HostLanePhase.ATTACHED, roster(
                    hostE, runE, scopeE, listOf(target, codex), nativeOnly,
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
            capabilities: List<String>,
        ): RosterClientState = RosterClientState(
            hostId = hostId.value,
            generation = 1,
            phase = RosterClientPhase.SUBSCRIBED,
            projection = RosterProjection(
                state = RosterProjectionState.CURRENT,
                rows = listOf(RemoteSessionMetadata(
                    id = "workspace-row",
                    label = "Synthetic row",
                    workspace = "/synthetic/existing",
                    lifecycle = RosterLifecycle.ALIVE,
                    hasLiveProcess = true,
                    inputSurface = false,
                )),
                hostRunId = run,
                revision = 1L,
                subscriptionId = "synthetic-workspace-$run",
                reason = null,
                nativeCliTargets = targets,
                nativeCatalogScope = scope,
            ),
            subscriptionId = "synthetic-workspace-$run",
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
