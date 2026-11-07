package io.github.rfairburn.pireviewgate.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.espresso.Espresso
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The session list's one entry point for New session and Saved conversations.
 *
 * Invented component inputs only: no transport, owner, controller, or storage is
 * installed. Where a test shows what follows an intent (the create form, the Saved
 * route), the next state is set here by hand to mirror the existing controller; it is
 * not evidence that a real host served anything.
 */
@RunWith(AndroidJUnit4::class)
class SessionsEntryComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private companion object {
        const val NEW = "New session"
        const val SAVED = "Saved conversations"
        const val CHOOSER_TITLE = "Choose a host to browse its saved conversations"
        const val NO_HOSTS = "No hosts are configured. Add a host on the Hosts screen first."
        const val AVAILABLE = "Saved conversations available"
        const val RUN_D = "55555555-5555-4555-8555-555555555555"
        val hostA = NativeUiFixtures.hostA
        val hostB = NativeUiFixtures.hostB
        val unknownCaps: HostId = HostId.parse("entry-unknown-caps")
        val noSaved: HostId = HostId.parse("entry-no-saved")
        val dragHost: HostId = HostId.parse("entry-drag")
    }

    // -- local fixture adaptation (shared NativeUiFixtures stay untouched) ----------------

    private fun choice(host: HostUiState) = "${host.host.label.value} — ${host.host.endpoint.displayText()}"
    private fun choiceA() = "Owner A — fixture-a.invalid:8443"

    private fun connectedHost(id: HostId, label: String, capabilities: HostCapabilities) = HostUiState(
        host = ConfiguredHost(id, HostLabel.parse(label), Endpoint("${id.value}.invalid", 8443)),
        connection = HostConnectionState.CONNECTED,
        capabilities = capabilities,
    )

    private fun dragRow(id: String) = SessionUiState(
        hostId = dragHost, hostLabel = "Drag owner", hostRunId = RUN_D, stale = false, rosterRevision = 1,
        metadata = RemoteSessionMetadata(
            id = id, label = "Entry card $id", workspace = "/synthetic/entry/$id",
            lifecycle = RosterLifecycle.ALIVE, hasLiveProcess = true, inputSurface = false,
            rosterSlotId = "slot-entry-$id", busy = null, pendingInput = null,
        ),
    )

    private fun dragState(): ClientUiState {
        val rows = listOf(dragRow("d1"), dragRow("d2"))
        return ClientUiState(hostStates = listOf(HostUiState(
            host = ConfiguredHost(dragHost, HostLabel.parse("Drag owner"), Endpoint("entry-drag.invalid", 8443)),
            connection = HostConnectionState.CONNECTED,
            roster = RosterSnapshot(RosterFreshness.CURRENT, RUN_D, 1, rows),
            capabilities = HostCapabilities.fromAcknowledged(listOf(RosterWire.SAVED_CAPABILITY), 1),
        )))
    }

    private fun show(state: ClientUiState): NativeUiFixture {
        val fixture = NativeUiFixture(state)
        compose.setContent { fixture.Content() }
        compose.waitForIdle()
        return fixture
    }

    private fun setState(fixture: NativeUiFixture, next: ClientUiState) {
        compose.runOnIdle { fixture.state = next.copy(coverage = fixture.state.coverage) }
        compose.waitForIdle()
    }

    private fun NativeUiFixture.actions(): List<ClientIntent> =
        intents.map { it.intent }.filterNot { it is ClientIntent.UiCoverageChanged }

    private fun NativeUiFixture.coverages(): List<UiCoverage> =
        intents.map { it.intent }.filterIsInstance<ClientIntent.UiCoverageChanged>().map { it.coverage }

    private fun navItem(label: String) = compose.onNode(hasText(label) and isSelectable())

    private fun assertPairedControls() {
        compose.onNodeWithText(NEW).assertIsDisplayed().assertIsEnabled().assertHasClickAction()
        compose.onNodeWithText(SAVED).assertIsDisplayed().assertIsEnabled().assertHasClickAction()
    }

    private fun openChooser(fixture: NativeUiFixture) {
        compose.onNodeWithText(SAVED).performClick()
        compose.waitForIdle()
        compose.onNodeWithText(CHOOSER_TITLE).assertIsDisplayed()
        compose.runOnIdle { assertEquals(UiCoverage.OPEN_MENU, fixture.coverages().last()) }
    }

    private fun dismissChooser(fixture: NativeUiFixture) {
        // Back only while the chooser is up, so it can never leave the activity.
        if (compose.onAllNodesWithText(CHOOSER_TITLE).fetchSemanticsNodes().isNotEmpty()) Espresso.pressBack()
        compose.waitForIdle()
        compose.onAllNodesWithText(CHOOSER_TITLE).assertCountEquals(0)
        compose.runOnIdle {
            assertEquals(UiCoverage.NONE, fixture.coverages().last())
            assertEquals(UiCoverage.NONE, fixture.state.coverage)
        }
    }

    /** Nothing but navigation may come out of the header: no owner request at all. */
    private fun assertNoOwnerOperation(fixture: NativeUiFixture) {
        compose.runOnIdle {
            assertTrue(fixture.actions().none {
                it is ClientIntent.RequestSavedList || it is ClientIntent.RequestSavedWindow ||
                    it is ClientIntent.ResumeSavedEntry || it is ClientIntent.PrepareSavedDelete ||
                    it is ClientIntent.ConfirmSavedDelete || it is ClientIntent.SubmitSessionCreate ||
                    it is ClientIntent.SelectCreateOwner || it is ClientIntent.SelectSavedOwner ||
                    it is ClientIntent.EnterTerminal || it is ClientIntent.MoveSessionRow ||
                    it is ClientIntent.ConnectHost
            })
        }
    }

    // -- discoverability -----------------------------------------------------------------

    @Test fun pairedControlsStayVisibleWithRowsWithNoRowsAndWithNoHosts() {
        val fixture = show(NativeUiFixtures.sessions())
        compose.onNodeWithText("Conversation A").assertIsDisplayed()
        assertPairedControls()
        captureSyntheticScreen("entry-with-rows")

        setState(fixture, ClientUiState(hostStates = listOf(
            NativeUiFixtures.host(hostA, "Owner A", NativeUiFixtures.RUN_A, emptyList()),
        )))
        compose.onNodeWithText("This host reported no sessions.").assertIsDisplayed()
        assertPairedControls()

        setState(fixture, ClientUiState())
        compose.onNodeWithText("No sessions to show. Add a host to get started.").assertIsDisplayed()
        assertPairedControls()
        captureSyntheticScreen("entry-no-hosts")
        compose.runOnIdle { assertTrue(fixture.actions().isEmpty()) }
    }

    @Test fun pairedControlsKeepTheirClickTargetsInANarrowLargeFontWindow() {
        val fixture = NativeUiFixture(NativeUiFixtures.sessions())
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                Box(Modifier.width(240.dp)) { fixture.Content() }
            }
        }
        compose.waitForIdle()
        captureSyntheticScreen("entry-narrow-large-font")
        val newBounds = compose.onNodeWithText(NEW).assertIsDisplayed().assertHasClickAction()
            .fetchSemanticsNode().boundsInRoot
        val savedBounds = compose.onNodeWithText(SAVED).assertIsDisplayed().assertHasClickAction()
            .fetchSemanticsNode().boundsInRoot
        // Wrapped, never overlapped or clipped away.
        assertFalse(newBounds.overlaps(savedBounds))
        assertTrue(newBounds.width > 0f && savedBounds.width > 0f)
        compose.onNodeWithText(SAVED).performClick()
        compose.onNodeWithText(choiceA()).assertIsDisplayed().assertIsEnabled()
        dismissChooser(fixture)
    }

    // -- New session ---------------------------------------------------------------------

    @Test fun newSessionOpensTheExistingCreateFormWithNoGuessedOwner() {
        val fixture = show(NativeUiFixtures.sessions())
        compose.onNodeWithText(NEW).performClick()
        compose.runOnIdle { assertEquals(listOf<ClientIntent>(ClientIntent.RequestSessionCreate), fixture.actions()) }

        // Mirror the controller's create form: every configured host offered, none chosen.
        val state = fixture.state
        setState(fixture, state.copy(dialogs = ClientDialogs(createSession = CreateSessionDialog(
            owners = state.hostStates.map {
                OwnerChoice(it.host.id, it.host.label.value, it.host.endpoint.displayText(), it.connection, it.canCreateSession)
            },
            proof = MutableUiActionProof(UiActionTargetToken(UiProofScreen.SESSION_CREATE, HostId.parse("local-form"), generation = 1)),
        ))))
        compose.onNodeWithText("No host chosen").assertIsDisplayed()
        compose.runOnIdle {
            assertNull(fixture.state.dialogs.createSession?.selectedHostId)
            assertEquals(listOf<ClientIntent>(ClientIntent.RequestSessionCreate), fixture.actions())
        }
        assertNoOwnerOperation(fixture)
    }

    // -- Saved conversations -------------------------------------------------------------

    @Test fun eligibleHostChoiceEmitsOnlyShowSavedForThatIdThenTheDedicatedRoute() {
        val fixture = show(NativeUiFixtures.sessions())
        openChooser(fixture)
        compose.onNodeWithText(choiceA()).assertIsDisplayed().assertIsEnabled()
        compose.onAllNodesWithText(AVAILABLE).onFirst().assertExists()
        compose.onNodeWithText(choiceA()).performClick()
        compose.waitForIdle()
        compose.onAllNodesWithText(CHOOSER_TITLE).assertCountEquals(0)
        compose.runOnIdle {
            assertEquals(listOf<ClientIntent>(ClientIntent.ShowSaved(hostA)), fixture.actions())
            assertEquals(listOf(UiCoverage.OPEN_MENU, UiCoverage.NONE), fixture.coverages())
        }

        // Mirror the controller's showSaved: route only, nothing requested.
        setState(fixture, fixture.state.copy(
            route = ClientRoute.Saved(hostA),
            saved = SavedUiState(selectedHostId = hostA, hostRunId = NativeUiFixtures.RUN_A),
        ))
        compose.onNodeWithText("Nothing requested yet.").assertIsDisplayed()
        compose.onAllNodesWithText("Owner A").onFirst().assertIsDisplayed()
        navItem("Sessions").assertIsSelected()
        navItem("Hosts").assertIsNotSelected()
        compose.onAllNodesWithText(NEW).assertCountEquals(0)
        compose.onNodeWithText("Back").performClick()
        compose.runOnIdle {
            assertEquals(
                listOf(ClientIntent.ShowSaved(hostA), ClientIntent.ShowDestination(NavigationDestination.SESSIONS)),
                fixture.actions(),
            )
        }
        assertNoOwnerOperation(fixture)
    }

    @Test fun ineligibleHostsAreLabelledAndRefuseWithoutAnInventedCatalog() {
        val unknown = connectedHost(unknownCaps, "Unconfirmed owner", HostCapabilities.UNKNOWN)
        val unsupported = connectedHost(noSaved, "No-saved owner",
            HostCapabilities.fromAcknowledged(listOf(RosterWire.CLOSE_CAPABILITY), 1))
        val base = NativeUiFixtures.sessions()
        val fixture = show(base.copy(hostStates = base.hostStates + unknown + unsupported))
        openChooser(fixture)

        val stale = base.hostStates.single { it.host.id == hostB }
        compose.onNodeWithText(choice(stale)).assertIsNotEnabled()
        compose.onNodeWithText("Not connected (Disconnected)").assertExists()
        compose.onNodeWithText(choice(unknown)).assertIsNotEnabled()
        compose.onNodeWithText("Saved support not confirmed by this host yet").assertExists()
        compose.onNodeWithText(choice(unsupported)).assertIsNotEnabled()
        compose.onNodeWithText("This host does not offer saved conversations").assertExists()

        listOf(choice(stale), choice(unknown), choice(unsupported)).forEach {
            compose.onNodeWithText(it).performClick()
        }
        compose.waitForIdle()
        compose.runOnIdle {
            assertTrue(fixture.actions().isEmpty())
            assertEquals(ClientRoute.Sessions, fixture.state.route)
            assertNull(fixture.state.saved.selectedHostId)
        }
        dismissChooser(fixture)
        assertNoOwnerOperation(fixture)
    }

    @Test fun noHostsChooserSaysSoAndOffersNothingToChoose() {
        val fixture = show(ClientUiState())
        openChooser(fixture)
        compose.onNodeWithText(NO_HOSTS).assertIsDisplayed().assertHasNoClickAction()
        compose.onNodeWithText(CHOOSER_TITLE).assertHasNoClickAction()
        compose.onNodeWithText(NO_HOSTS).performClick()
        compose.runOnIdle { assertTrue(fixture.actions().isEmpty()) }
        dismissChooser(fixture)
        compose.runOnIdle {
            assertTrue(fixture.actions().isEmpty())
            assertEquals(ClientRoute.Sessions, fixture.state.route)
        }
    }

    @Test fun hostListChangesWhileTheChooserIsOpenNeverReachTheWrongOwner() {
        val base = NativeUiFixtures.sessions()
        val fixture = show(base)
        openChooser(fixture)

        // Reorder and relabel mid-menu: the item stays bound to its own host id.
        val relabelled = base.hostStates.map {
            if (it.host.id == hostA) it.copy(host = it.host.copy(label = HostLabel.parse("Owner A renamed"))) else it
        }.reversed()
        setState(fixture, base.copy(hostStates = relabelled))
        val renamed = "Owner A renamed — fixture-a.invalid:8443"
        compose.onNodeWithText(renamed).assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf<ClientIntent>(ClientIntent.ShowSaved(hostA)), fixture.actions()) }

        // Eligibility lost mid-menu: the item says so and refuses.
        setState(fixture, base)
        openChooser(fixture)
        setState(fixture, base.copy(hostStates = base.hostStates.map {
            if (it.host.id == hostA) it.copy(connection = HostConnectionState.RETRYING) else it
        }))
        compose.onNodeWithText(choiceA()).assertIsNotEnabled().performClick()
        compose.onNodeWithText("Not connected (Retrying)").assertExists()
        compose.runOnIdle { assertEquals(1, fixture.actions().count { it is ClientIntent.ShowSaved }) }

        // Host removed mid-menu: its item is gone and nothing is sent for it.
        setState(fixture, base.copy(hostStates = base.hostStates.filterNot { it.host.id == hostA }))
        compose.onAllNodesWithText(choiceA()).assertCountEquals(0)
        dismissChooser(fixture)
        compose.runOnIdle { assertEquals(listOf<ClientIntent>(ClientIntent.ShowSaved(hostA)), fixture.actions()) }
        assertNoOwnerOperation(fixture)
    }

    // -- canonical location --------------------------------------------------------------

    @Test fun rowActionsNoLongerOfferSavedButKeepTheirOtherActions() {
        val fixture = show(NativeUiFixtures.sessions())
        compose.onAllNodesWithText("Actions").onFirst().performClick()
        compose.waitForIdle()
        listOf("Rename", "Close", "Show details").forEach { compose.onNodeWithText(it).assertExists() }
        // Only the header's own button carries the label.
        compose.onAllNodesWithText(SAVED).assertCountEquals(1)
        compose.onAllNodesWithText(CHOOSER_TITLE).assertCountEquals(0)
        Espresso.pressBack()
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(listOf(UiCoverage.OPEN_MENU, UiCoverage.NONE), fixture.coverages())
            assertTrue(fixture.actions().isEmpty())
        }
    }

    @Test fun hostsOverflowNoLongerOffersNewOrSavedButKeepsHostActions() {
        val fixture = show(NativeUiFixtures.sessions().copy(route = ClientRoute.Hosts))
        compose.onAllNodesWithText("Actions").onFirst().performClick()
        compose.waitForIdle()
        listOf("Edit address", "Forget host").forEach { compose.onNodeWithText(it).assertExists() }
        // Connect/Disconnect are both in the menu and on the card itself.
        assertTrue(compose.onAllNodesWithText("Connect").fetchSemanticsNodes().size >= 2)
        assertTrue(compose.onAllNodesWithText("Disconnect").fetchSemanticsNodes().size >= 2)
        compose.onAllNodesWithText(NEW).assertCountEquals(0)
        compose.onAllNodesWithText(SAVED).assertCountEquals(0)
        navItem("Hosts").assertIsSelected()
        Espresso.pressBack()
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(UiCoverage.NONE, fixture.state.coverage)
            assertTrue(fixture.actions().none { it is ClientIntent.ShowSaved || it is ClientIntent.RequestSessionCreate })
        }
    }

    // -- coverage and drag ---------------------------------------------------------------

    @Test fun aDragDisablesTheHeaderAndAnOpenChooserBlocksADrag() {
        val fixture = show(dragState())
        val list = compose.onNode(hasScrollToNodeAction())
        fun inList(title: String): Offset =
            compose.onNodeWithText(title).fetchSemanticsNode().boundsInRoot.center -
                list.fetchSemanticsNode().boundsInRoot.topLeft

        // A held drag disables both header controls; cancelling it re-enables them.
        list.performTouchInput {
            down(inList("Entry card d1"))
            advanceEventTime(viewConfiguration.longPressTimeoutMillis * 2)
            moveBy(Offset(0f, 2f))
        }
        compose.waitForIdle()
        compose.onNodeWithText(NEW).assertIsNotEnabled()
        compose.onNodeWithText(SAVED).assertIsNotEnabled()
        list.performTouchInput { cancel() }
        compose.waitForIdle()
        assertPairedControls()
        compose.runOnIdle {
            assertTrue(fixture.intents.none { it.intent is ClientIntent.MoveSessionRow })
            assertTrue(fixture.coverages().isEmpty())
        }

        // An open chooser is menu coverage: no drag starts under it, and closing it
        // leaves no coverage behind.
        openChooser(fixture)
        list.performTouchInput {
            down(inList("Entry card d1"))
            advanceEventTime(viewConfiguration.longPressTimeoutMillis * 2)
            moveBy(Offset(0f, 2f))
        }
        compose.waitForIdle()
        list.performTouchInput { cancel() }
        dismissChooser(fixture)
        assertPairedControls()
        compose.runOnIdle {
            assertTrue(fixture.intents.none { it.intent is ClientIntent.MoveSessionRow })
            assertEquals(listOf(UiCoverage.OPEN_MENU, UiCoverage.NONE), fixture.coverages())
        }
        assertNoOwnerOperation(fixture)
    }
}
