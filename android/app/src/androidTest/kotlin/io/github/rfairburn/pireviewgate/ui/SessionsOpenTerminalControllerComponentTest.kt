package io.github.rfairburn.pireviewgate.ui

import android.os.Build
import android.util.Log
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
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
import io.github.rfairburn.pireviewgate.core.protocol.roster.*
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import io.github.rfairburn.pireviewgate.ui.client.RootUIScreen
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

/**
 * The session card's Open terminal control must spend the committed proof of the
 * card that is drawn, not require a second tap because a roster revision advanced.
 *
 * These tests drive the production [ClientApplicationController.refresh] and the
 * production [RootUIScreen]/SessionCard guard with a synthetic registry observation
 * and real injected touch for the touch-path cases. The controller-admission case
 * calls the production intent directly. The controller is built through reflection
 * because production composition exposes no test seam. This is not a host connection, owner
 * session, terminal transport, or content proof: a route change only shows the
 * controller admitted the intent. The revision-only case freezes Compose's test
 * clock so the roster republish is observed before a replacement proof could draw.
 */
@RunWith(AndroidJUnit4::class)
class SessionsOpenTerminalControllerComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private var harness: ControllerHarness? = null

    @After fun tearDown() {
        compose.mainClock.autoAdvance = true
        harness?.close()
        harness = null
    }

    @Test fun stableCommittedProofFirstTouchEntersTheSameRowOnce() {
        val h = start()
        harness = h
        compose.setContent { h.Content() }
        val row = awaitRow()
        val proof = requireNotNull(row.selectProof) { "controller withheld the row proof" }
        compose.waitUntil(10_000) { proof.grantsAction() }

        openTerminal().assertIsDisplayed().assertIsEnabled().performTouchInput { click(center) }
        compose.waitUntil(10_000) { h.controller.ui.value.route is ClientRoute.Terminal }
        compose.waitForIdle()

        val entered = h.enterTerminals().single()
        assertEquals(ObservedState.hostId, entered.target.hostId)
        assertEquals(NativeUiFixtures.RUN_A, entered.target.hostRunId)
        assertEquals("churn-row", entered.target.rowId)
        assertEquals("stable committed proof must enter exactly once", 1, h.enterTerminals().size)
    }

    @Test fun revisionOnlyRepublishFirstTouchEntersTheSameRowOnce() {
        val h = start()
        harness = h
        compose.setContent { h.Content() }
        val firstRow = awaitRow()
        val firstProof = requireNotNull(firstRow.selectProof) { "controller withheld the first row proof" }
        compose.waitUntil(10_000) { firstProof.grantsAction() }

        // Hold the frame clock so the republished row exists before any replacement
        // proof could be certified by a new frame.
        compose.mainClock.autoAdvance = false
        compose.waitForIdle()
        h.setRoster(ObservedState.REVISION + 1L)
        awaitRoster(ObservedState.REVISION + 1L, ObservedState.TITLE)
        compose.waitForIdle()

        val refreshed = h.controller.ui.value.sessions.first()
        val refreshedProof = requireNotNull(refreshed.selectProof) { "controller withheld the republished proof" }
        Log.i(TAG, "revision-only before-first-touch sameProof=${firstProof === refreshedProof} " +
            "oldCurrent=${firstProof.isCurrent} oldCommitted=${firstProof.hasCommittedFrame} " +
            "newCurrent=${refreshedProof.isCurrent} newCommitted=${refreshedProof.hasCommittedFrame} " +
            "revision=${refreshed.rosterRevision} route=${h.controller.ui.value.route}")

        openTerminal().assertIsDisplayed().assertIsEnabled().performTouchInput { click(center) }
        compose.waitForIdle()

        // The baseline mints a new uncommitted proof and this first touch emits nothing.
        assertEquals("revision-only republish must not swallow the first touch", 1,
            h.enterTerminals().size)
        assertTrue("the first touch must enter the terminal", h.controller.ui.value.route is ClientRoute.Terminal)
        assertSame("revision-only republish must keep the drawn card's proof", firstProof, refreshedProof)
        val entered = h.enterTerminals().single()
        assertEquals(ObservedState.hostId, entered.target.hostId)
        assertEquals(NativeUiFixtures.RUN_A, entered.target.hostRunId)
        assertEquals("churn-row", entered.target.rowId)
        assertEquals(ObservedState.TITLE, entered.target.drawnTitle)
    }

    @Test fun revisionOnlyRepublishAdmitsTheDrawnTargetAfterTheRevisionAdvances() {
        val h = start()
        harness = h
        compose.setContent { h.Content() }
        val firstRow = awaitRow()
        val firstProof = requireNotNull(firstRow.selectProof) { "controller withheld the first row proof" }
        compose.waitUntil(10_000) { firstProof.grantsAction() }
        val drawnTarget = SessionActionTarget.of(firstRow)

        compose.mainClock.autoAdvance = false
        compose.waitForIdle()
        h.setRoster(ObservedState.REVISION + 1L)
        awaitRoster(ObservedState.REVISION + 1L, ObservedState.TITLE)
        compose.waitForIdle()
        val refreshedProof = requireNotNull(h.controller.ui.value.sessions.first().selectProof)
        Log.i(TAG, "revision-only admission sameProof=${firstProof === refreshedProof} " +
            "drawnRevision=${drawnTarget.rosterRevision} currentRevision=" +
            h.controller.ui.value.sessions.first().rosterRevision)

        // The card's frozen target still names revision 7 while the controller now
        // publishes revision 8. The same owner row and title must remain admissible.
        compose.runOnIdle { h.controller.intent(ClientIntent.EnterTerminal(drawnTarget, refreshedProof)) }
        compose.waitForIdle()

        assertTrue("the drawn target must stay admissible across a revision-only republish",
            h.controller.ui.value.route is ClientRoute.Terminal)
    }

    @Test fun titleChangeStillRetiresTheDrawnProofUntilAFreshFrameCommits() {
        val h = start()
        harness = h
        compose.setContent { h.Content() }
        val firstRow = awaitRow()
        val firstProof = requireNotNull(firstRow.selectProof) { "controller withheld the first row proof" }
        compose.waitUntil(10_000) { firstProof.grantsAction() }

        compose.mainClock.autoAdvance = false
        compose.waitForIdle()
        h.setRoster(ObservedState.REVISION + 1L, ObservedState.RETITLED)
        awaitRoster(ObservedState.REVISION + 1L, ObservedState.RETITLED)
        compose.waitForIdle()

        val refreshed = h.controller.ui.value.sessions.first()
        val refreshedProof = requireNotNull(refreshed.selectProof) { "controller withheld the retitled proof" }
        assertNotSame("a title change must mint a new proof", firstProof, refreshedProof)
        assertFalse("the pre-title proof must be retired", firstProof.isCurrent)
        assertTrue(refreshedProof.isCurrent)
        assertFalse("the replacement proof has no committed frame yet", refreshedProof.hasCommittedFrame)

        openTerminal().assertIsDisplayed().assertIsEnabled().performTouchInput { click(center) }
        compose.waitForIdle()
        assertEquals("a title change must not be spent before a fresh frame commits", 0,
            h.enterTerminals().size)
        assertTrue("the first touch after a title change must not navigate",
            h.controller.ui.value.route is ClientRoute.Sessions)

        compose.mainClock.autoAdvance = true
        compose.waitUntil(10_000) { refreshedProof.grantsAction() }
        openTerminal().assertIsDisplayed().assertIsEnabled().performTouchInput { click(center) }
        compose.waitUntil(10_000) { h.controller.ui.value.route is ClientRoute.Terminal }
        compose.waitForIdle()

        assertEquals(1, h.enterTerminals().size)
        val terminal = h.controller.ui.value.route as ClientRoute.Terminal
        assertEquals(ObservedState.RETITLED, terminal.terminal.sessionTitle)
    }

    private fun openTerminal() = compose.onAllNodesWithText("Open terminal").onFirst()

    private fun start(): ControllerHarness {
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
        val platform = platformCtor.newInstance(
            context.applicationContext, settings, pins, identity, presentation,
            CachedLocalNetworkAdmission(Build.VERSION.SDK_INT), registry,
        ) as AndroidClientPlatform
        val controllerCtor = ClientApplicationController::class.java.declaredConstructors.single {
            it.parameterCount == 3 && !it.isSynthetic
        }
        controllerCtor.isAccessible = true
        val controller = controllerCtor.newInstance(
            platform,
            RemotePresentationOrderCoordinator(),
            AtomicReference<ClientApplicationController.PromptStanding?>(null),
        ) as ClientApplicationController
        setRuntimeState(controller.runtime, ObservedState.runtime(ObservedState.REVISION, ObservedState.TITLE))
        setRegistrySnapshot(registry, ObservedState.registry())
        compose.runOnIdle { refreshController(controller) }
        return ControllerHarness(controller, platform, registry)
    }

    private fun awaitRow(): SessionUiState {
        val h = requireNotNull(harness)
        compose.waitUntil(10_000) { h.controller.ui.value.sessions.any { !it.stale } }
        return h.controller.ui.value.sessions.first { !it.stale }
    }

    private fun awaitRoster(revision: Long, title: String) {
        val h = requireNotNull(harness)
        runBlocking {
            withTimeout(10_000) {
                h.controller.ui.first { state ->
                    state.sessions.firstOrNull()?.let {
                        it.rosterRevision == revision && it.displayTitle == title
                    } == true
                }
            }
        }
    }

    private fun setRegistrySnapshot(registry: HostConnectionRegistry, snapshot: ConnectionRegistrySnapshot) {
        val field = HostConnectionRegistry::class.java.getDeclaredField("_snapshot")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        (field.get(registry) as MutableStateFlow<ConnectionRegistrySnapshot>).value = snapshot
    }

    private fun refreshController(controller: ClientApplicationController) {
        val method = ClientApplicationController::class.java.getDeclaredMethod("refresh")
        method.isAccessible = true
        method.invoke(controller)
    }

    private fun setRuntimeState(runtime: ClientRuntime, state: ClientRuntimeState) {
        val field = ClientRuntime::class.java.getDeclaredField("stateFlow")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        (field.get(runtime) as MutableStateFlow<ClientRuntimeState>).value = state
    }

    private inner class ControllerHarness(
        val controller: ClientApplicationController,
        private val platform: AndroidClientPlatform,
        val registry: HostConnectionRegistry,
    ) {
        val intents = CopyOnWriteArrayList<ClientIntent>()

        @androidx.compose.runtime.Composable
        fun Content() {
            val state by controller.ui.collectAsState()
            RootUIScreen(
                state = state,
                onIntent = { intent ->
                    intents += intent
                    // The synthetic runtime has no host lane to publish. Dispatching this
                    // initial NONE report would replace the observation this test owns.
                    if (intent !is ClientIntent.UiCoverageChanged) controller.intent(intent)
                },
                onTerminalKey = {},
                onTerminalPaste = {},
                terminalContent = {},
            )
        }

        fun setRoster(revision: Long, title: String = ObservedState.TITLE) {
            setRuntimeState(controller.runtime, ObservedState.runtime(revision, title))
            compose.runOnIdle { refreshController(controller) }
        }

        fun enterTerminals(): List<ClientIntent.EnterTerminal> =
            intents.filterIsInstance<ClientIntent.EnterTerminal>()

        fun close() {
            runCatching {
                val field = ClientApplicationController::class.java.getDeclaredField("scope")
                field.isAccessible = true
                (field.get(controller) as CoroutineScope).cancel()
            }
            runCatching { runBlocking { controller.runtime.close() } }
            runCatching { compose.runOnIdle { platform.close() } }
        }
    }

    private object ObservedState {
        const val REVISION = 7L
        const val TITLE = "Synthetic conversation"
        const val RETITLED = "Synthetic conversation, retitled"
        val hostId = HostId.parse("churn-owner")
        val run = NativeUiFixtures.RUN_A
        val endpoint = Endpoint("churn-owner.invalid", 8443)
        val label = HostLabel.parse("Churn owner")

        fun registry() = ConnectionRegistrySnapshot(
            generation = 1,
            settingsGeneration = 1,
            foreground = true,
            autoReconnectEnabled = false,
            viewerRemoteInputEnabled = false,
            identity = DeviceIdentityObservation.NeverInitialized,
            storage = StorageObservation(StorageHandleState(available = true), StorageHandleState(available = true)),
            hosts = listOf(HostConnectionSnapshot(
                hostId, endpoint, label.value, HostConnectionPhase.CONNECTED, HostConnectionReason.NONE,
                generation = 1, previouslyConnected = true, reconnectSuppressed = false,
                autoEligible = false, peerFingerprint = NativeUiFixtures.FINGERPRINT,
            )),
            pendingConsents = emptyList(),
            notice = null,
        )

        fun runtime(revision: Long, title: String) = ClientRuntimeState(
            hosts = listOf(HostRuntimeState(hostId, 1, HostLanePhase.ATTACHED, roster(revision, title))),
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

        private fun roster(revision: Long, title: String) = RosterClientState(
            hostId = hostId.value,
            generation = 1,
            phase = RosterClientPhase.SUBSCRIBED,
            projection = RosterProjection(
                state = RosterProjectionState.CURRENT,
                rows = listOf(RemoteSessionMetadata(
                    id = "churn-row",
                    label = title,
                    workspace = "/synthetic/churn",
                    lifecycle = RosterLifecycle.ALIVE,
                    hasLiveProcess = true,
                    inputSurface = false,
                    rosterSlotId = "slot-churn",
                    busy = false,
                    pendingInput = false,
                    activity = listOf("Synthetic roster revision $revision"),
                    nativeSession = RemoteNativeSession(
                        "native-churn", 3, title, RemoteNativePersistence.SAVED,
                    ),
                    backgroundTasks = 0,
                    backgroundShells = 2,
                    activeTasks = null,
                    activeShells = null,
                )),
                hostRunId = run,
                revision = revision,
                subscriptionId = "synthetic-subscription-$revision",
                reason = null,
            ),
            subscriptionId = "synthetic-subscription-$revision",
            subscriptionRunId = run,
            capabilities = listOf(
                RosterWire.CLOSE_CAPABILITY, RosterWire.CREATE_CAPABILITY,
                RosterWire.RENAME_CAPABILITY, RosterWire.SAVED_CAPABILITY,
                RosterWire.ROSTER_SLOT_CAPABILITY,
            ),
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

    private companion object {
        const val TAG = "OpenTerminalRevision"
    }
}
