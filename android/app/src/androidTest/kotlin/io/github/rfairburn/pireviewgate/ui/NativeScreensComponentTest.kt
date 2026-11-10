package io.github.rfairburn.pireviewgate.ui

import android.content.res.Configuration
import android.view.WindowInsets
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.ui.client.NonTerminalStatusSlot
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Run the same fixtures on each owned phone profile; these are not connected-app tests. */
@RunWith(AndroidJUnit4::class)
class NativeScreensComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun sessionsKeepDuplicateOwnerRowsUnknownActivityAndAllMetadata() {
        val proof = NativeUiFixtures.rowProof()
        val fixture = NativeUiFixture(NativeUiFixtures.sessions(proofA = proof))
        compose.setContent { fixture.Content() }
        compose.onNodeWithText("Conversation A").assertIsDisplayed()
        compose.onAllNodesWithText("Agent state unknown").onFirst().assertIsDisplayed()
        compose.onAllNodesWithText("Agent idle").assertCountEquals(0)
        captureSyntheticScreen("sessions")

        compose.onAllNodesWithText("Actions").onFirst().performClick()
        compose.onNodeWithText("Show details").performClick()
        // All fields remain in the actual native card, including unknown versus zero.
        // A delivered activity line also appears on collapsed cards, so a value may be
        // drawn more than once; every one of them is still the same delivered fact.
        listOf("Owner label", "Workspace", "Live process", "Busy", "Pending input", "Input surface",
            "Background tasks", "Background shells", "Active tasks", "Active shells", "Exit code",
            "Error", "Native conversation", "Native epoch", "Native name", "Persistence",
            "Owner label A", "/synthetic/workspace/a", "native-a", "Synthetic activity one",
            "Synthetic activity two").forEach { value ->
            compose.onAllNodesWithText(value).onFirst().assertExists()
        }
        // The durable roster slot is an internal presentation identity, not card text.
        compose.onAllNodesWithText("Roster slot").assertCountEquals(0)
        compose.onAllNodesWithText("slot-a", substring = true).assertCountEquals(0)
        captureSyntheticScreen("expanded-metadata")
        // The expanded card is taller than a phone. The visible Open button, not
        // the clipped extent of the entire card, is the actionable placement.
        compose.onAllNodesWithText("Open terminal").onFirst().assertIsDisplayed()
        awaitProof(proof)
        compose.onAllNodesWithText("Open terminal").onFirst().performClick()
        compose.runOnIdle {
            val request = fixture.intents.single { it.intent is ClientIntent.EnterTerminal }
            assertTrue(request.stillAuthorized)
            assertEquals(SessionActionTarget.of(fixture.state.sessions.first()),
                (request.intent as ClientIntent.EnterTerminal).target)
        }
        scrollTo("Conversation B")
        compose.onNodeWithText("Conversation B").assertIsDisplayed()
        compose.onNodeWithText("On Owner B").assertIsDisplayed()
        compose.onNodeWithText("Stale").assertExists()
        scrollTo("This host reported no sessions.")
        compose.onNodeWithText("This host reported no sessions.").assertIsDisplayed()
        scrollTo("This host has not reported any sessions yet. Nothing is known about its sessions.")
        compose.onNodeWithText("This host has not reported any sessions yet. Nothing is known about its sessions.")
            .assertIsDisplayed()
    }

    @Test fun hostsAndSettingsRenderFullIdentityAndUnknownStorageWithoutReadingIt() {
        val fixture = NativeUiFixture(NativeUiFixtures.sessions().copy(route = ClientRoute.Hosts))
        compose.setContent { fixture.Content() }
        compose.onNodeWithText("Owner A").assertIsDisplayed()
        compose.onAllNodesWithText(NativeUiFixtures.FINGERPRINT).onFirst().assertIsDisplayed()
        compose.onNodeWithText("fixture-a.invalid:8443").assertIsDisplayed()
        captureSyntheticScreen("hosts")
        compose.runOnIdle { fixture.state = fixture.state.copy(route = ClientRoute.Settings) }
        compose.onNodeWithText("Identity state not read yet.").assertIsDisplayed()
        compose.onNodeWithText("Saved-state status not read yet.").assertExists()
        compose.onNodeWithText("Automatic reconnect").assertIsDisplayed()
        compose.onNodeWithText("Remote input and copy").assertIsDisplayed()
        captureSyntheticScreen("settings")
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.runOnIdle {
            assertEquals(ClientIntent.ShowDestination(NavigationDestination.SESSIONS), fixture.intents.last().intent)
        }
    }

    @Test fun hostsEditAddressNamesFrozenTargetAndHasOnlyAnAddressDraftWithCancel() {
        val fixture = NativeUiFixture(NativeUiFixtures.sessions().copy(route = ClientRoute.Hosts))
        compose.setContent { fixture.Content() }
        compose.onAllNodesWithText("Actions").onFirst().performClick()
        compose.onNodeWithText("Edit address").assertIsEnabled().performClick()
        val target = compose.runOnIdle {
            val request = fixture.intents.single { it.intent is ClientIntent.RequestEditHostAddress }.intent
                as ClientIntent.RequestEditHostAddress
            assertEquals(NativeUiFixtures.hostA, request.target.hostId)
            assertEquals(fixture.state.hostStates.first().host.endpoint, request.target.expectedOldEndpoint)
            request.target
        }
        val proof = MutableUiActionProof(UiActionTargetToken(
            UiProofScreen.HOST_EDIT_ADDRESS, target.hostId, generation = 1))
        val dialog = EditHostAddressDialog(target, "Owner A", proof = proof)
        compose.runOnIdle { fixture.state = fixture.state.copy(dialogs = ClientDialogs(editHostAddress = dialog)) }
        compose.onNodeWithText("Port 8443 (unchanged)").assertIsDisplayed()
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(1)
        compose.onNode(hasSetTextAction()).assertTextContains(target.expectedOldEndpoint.host)
        compose.onNode(hasSetTextAction()).performTextReplacement("bad address")
        val invalid = compose.runOnIdle {
            val draft = (fixture.intents.last { it.intent is ClientIntent.UpdateDraft }.intent as ClientIntent.UpdateDraft)
                .draft as ClientDraft.HostAddressForm
            assertEquals(target, draft.target)
            assertSame(proof, draft.proof)
            assertFalse(proof.isCurrent)
            draft
        }
        val replacement = MutableUiActionProof(proof.target.copy(generation = 2))
        compose.runOnIdle { fixture.state = fixture.state.copy(dialogs = ClientDialogs(editHostAddress =
            dialog.copy(addressDraft = invalid.value, proof = replacement))) }
        compose.onNodeWithText("Save and reconnect").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle {
            assertEquals(ClientIntent.DismissDialog(ClientDialogKind.EDIT_HOST_ADDRESS), fixture.intents.last().intent)
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SaveHostAddressAndReconnect })
        }
    }

    @Test fun saveAndReconnectUsesActualDialogCommitAndNeverRevivesAnEditedEpoch() {
        val host = NativeUiFixtures.sessions().hostStates.first().host
        val target = EditHostAddressTarget(host.id, host.endpoint)
        val proof = MutableUiActionProof(UiActionTargetToken(UiProofScreen.HOST_EDIT_ADDRESS, host.id, generation = 1))
        val dialog = EditHostAddressDialog(target, host.label.value, "10.0.0.45", proof)
        val fixture = NativeUiFixture(NativeUiFixtures.sessions().copy(route = ClientRoute.Hosts,
            dialogs = ClientDialogs(editHostAddress = dialog)))
        assertFalse(proof.grantsAction())
        compose.setContent { fixture.Content() }
        awaitProof(proof) // No fabricated commit or Looper bypass.
        compose.onNodeWithText("Save and reconnect").assertIsDisplayed().performClick()
        val captured = compose.runOnIdle {
            fixture.intents.single { it.intent is ClientIntent.SaveHostAddressAndReconnect }.also {
                assertTrue(it.stillAuthorized)
                val request = it.intent as ClientIntent.SaveHostAddressAndReconnect
                assertEquals(target, request.target)
                assertEquals("10.0.0.45", request.address)
                assertSame(proof, request.proof)
            }
        }
        compose.onNode(hasSetTextAction()).performTextReplacement("10.0.0.46")
        compose.runOnIdle { assertFalse(captured.stillAuthorized) }
        val fresh = MutableUiActionProof(proof.target.copy(generation = 2))
        compose.runOnIdle { fixture.state = fixture.state.copy(dialogs = ClientDialogs(editHostAddress =
            dialog.copy(addressDraft = "10.0.0.46", proof = fresh))) }
        awaitProof(fresh)
        compose.runOnIdle { assertFalse(captured.stillAuthorized) }
        compose.onNodeWithText("Save and reconnect").performClick()
        compose.runOnIdle {
            val requests = fixture.intents.filter { it.intent is ClientIntent.SaveHostAddressAndReconnect }
            assertEquals(2, requests.size)
            val latest = requests.last().intent as ClientIntent.SaveHostAddressAndReconnect
            assertEquals(target, latest.target)
            assertEquals("10.0.0.46", latest.address)
            assertSame(fresh, latest.proof)
            assertTrue(requests.last().stillAuthorized)
        }
        compose.runOnIdle { fixture.state = fixture.state.copy(dialogs = ClientDialogs.NONE) }
        compose.waitForIdle()
        compose.runOnIdle {
            assertFalse(fresh.grantsAction())
            assertTrue("the component emits only the combined intent, never a fabricated row Connect",
                fixture.intents.none { it.intent is ClientIntent.ConnectHost })
        }
    }

    @Test fun savedSearchEntryAndWindowRequireTheirOwnCommittedControl() {
        val list = NativeUiFixtures.savedProof(1)
        val window = NativeUiFixtures.savedProof(2)
        val resume = NativeUiFixtures.savedProof(3, "entry-a")
        val fixture = NativeUiFixture(NativeUiFixtures.saved(list, window, resume))
        assertFalse(list.grantsAction())
        assertFalse(resume.grantsAction())
        compose.setContent { fixture.Content() }
        awaitProof(list)
        compose.onNode(hasText("Search") and hasClickAction() and !hasSetTextAction()).performClick()
        val capturedList = compose.runOnIdle {
            fixture.intents.single { it.intent is ClientIntent.RequestSavedList }.also {
                assertTrue(it.stillAuthorized)
                val request = it.intent as ClientIntent.RequestSavedList
                assertEquals(SavedOwnerTarget(NativeUiFixtures.hostA, NativeUiFixtures.RUN_A), request.target)
                assertEquals("", request.query)
                assertSame(list, request.proof)
            }
        }
        scrollTo("Resume")
        awaitProof(resume)
        compose.onNodeWithText("Resume").performClick()
        compose.runOnIdle {
            val captured = fixture.intents.single { it.intent is ClientIntent.ResumeSavedEntry }
            assertTrue(captured.stillAuthorized)
            assertEquals(SavedEntryTarget(NativeUiFixtures.hostA, NativeUiFixtures.RUN_A,
                "catalog-a", "result-a", "entry-a", "Saved conversation A"),
                (captured.intent as ClientIntent.ResumeSavedEntry).target)
        }
        captureSyntheticScreen("saved")
        scrollTo("Load more")
        awaitProof(window)
        compose.onNodeWithText("Load more").performClick()
        compose.runOnIdle {
            val request = fixture.intents.single { it.intent is ClientIntent.RequestSavedWindow }.intent
                as ClientIntent.RequestSavedWindow
            assertEquals(SavedResultTarget.of(fixture.state.saved), request.target)
            assertEquals(1L, request.offset)
            assertEquals(50L, request.count)
        }

        // performTextInput drives Compose's editing semantics, NOT LatinIME typing.
        compose.onNode(hasSetTextAction()).performTextInput("changed")
        compose.runOnIdle {
            assertFalse(list.isCurrent)
            assertFalse(capturedList.stillAuthorized)
            assertEquals(ClientDraft.SavedSearch("changed"),
                (fixture.intents.last { it.intent is ClientIntent.UpdateDraft }.intent as ClientIntent.UpdateDraft).draft)
        }
        compose.onNode(hasText("Search") and hasClickAction() and !hasSetTextAction()).performClick()
        val freshList = NativeUiFixtures.savedProof(4)
        compose.runOnIdle {
            assertEquals(1, fixture.intents.count { it.intent is ClientIntent.RequestSavedList })
            fixture.state = fixture.state.copy(saved = fixture.state.saved.copy(query = "changed", listProof = freshList))
        }
        awaitProof(freshList)
        compose.onNode(hasText("Search") and hasClickAction() and !hasSetTextAction()).performClick()
        compose.runOnIdle {
            val fresh = fixture.intents.last { it.intent is ClientIntent.RequestSavedList }
            assertEquals("changed", (fresh.intent as ClientIntent.RequestSavedList).query)
            assertSame(freshList, fresh.proof)
            assertTrue(fresh.stillAuthorized)
            assertFalse(capturedList.stillAuthorized)
        }
    }

    @Test fun firstContactRequiresRealDialogCommitAndFullLongFingerprintAtLargeFont() {
        val proof = MutableUiActionProof(UiActionTargetToken(
            UiProofScreen.HOST_FIRST_CONTACT_CONSENT, NativeUiFixtures.hostA, generation = 1,
        ))
        val dialog = FirstContactConsentDialog(NativeUiFixtures.hostA, "Owner A",
            "fixture-a.invalid:8443", NativeUiFixtures.FINGERPRINT, proof = proof)
        val fixture = NativeUiFixture(NativeUiFixtures.sessions().copy(
            dialogs = ClientDialogs(firstContactConsent = dialog),
        ))
        assertFalse(proof.grantsAction())
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.4f)) { fixture.Content() }
        }
        compose.waitForIdle()
        captureSyntheticScreen("consent-large-font-before-guard")
        compose.onNodeWithText(dialog.serverFingerprint).assertIsDisplayed()
        compose.onNodeWithText("Approve key").assertIsDisplayed()
        // Timeout is a concrete layout/commit blocker, never bypassed by marking proof ourselves.
        awaitProof(proof)
        captureSyntheticScreen("consent-large-font")
        compose.onNodeWithText("Approve key").performClick()
        compose.runOnIdle {
            val captured = fixture.intents.single { it.intent is ClientIntent.ApproveFirstContactServerKey }
            assertTrue(captured.stillAuthorized)
            assertEquals(FirstContactConsentTarget(dialog.hostId, dialog.latchedLabel,
                dialog.endpointDisplayText, dialog.serverFingerprint),
                (captured.intent as ClientIntent.ApproveFirstContactServerKey).target)
        }
        // A replacement identity must retire the old proof even if text has the same length.
        val replacement = MutableUiActionProof(proof.target.copy(generation = 2))
        compose.runOnIdle {
            fixture.state = fixture.state.copy(dialogs = ClientDialogs(firstContactConsent =
                dialog.copy(serverFingerprint = dialog.serverFingerprint.replace('a', 'b'), proof = replacement)))
        }
        compose.waitForIdle()
        compose.runOnIdle {
            assertFalse(proof.isCurrent)
            assertFalse(fixture.intents.single { it.intent is ClientIntent.ApproveFirstContactServerKey }.stillAuthorized)
        }
        awaitProof(replacement)
    }

    @Test fun rowCommitDoesNotStarveOnUnrelatedMetadataAndNativeBackAndChooserAreFrozen() {
        val proof = NativeUiFixtures.rowProof()
        val fixture = NativeUiFixture(NativeUiFixtures.sessions(proofA = proof))
        compose.setContent { fixture.Content() }
        awaitProof(proof)
        val epoch = proof.epoch
        compose.runOnIdle {
            fixture.state = fixture.state.copy(hostStates = fixture.state.hostStates.map {
                if (it.host.id == NativeUiFixtures.hostB) it.copy(noticeText = "Synthetic unrelated status") else it
            })
        }
        compose.waitForIdle()
        compose.runOnIdle {
            assertEquals(epoch, proof.epoch)
            assertTrue(proof.grantsAction())
        }
        compose.onAllNodesWithText("Open terminal").onFirst().performClick()
        val selected = compose.runOnIdle {
            fixture.intents.single { it.intent is ClientIntent.EnterTerminal }.also {
                assertTrue(it.stillAuthorized)
                assertEquals(SessionActionTarget.of(fixture.state.sessions.first()),
                    (it.intent as ClientIntent.EnterTerminal).target)
            }
        }
        val chooserProof = NativeUiFixtures.rowProof(NativeUiFixtures.hostB, NativeUiFixtures.RUN_B, 2)
        compose.runOnIdle {
            val other = fixture.state.sessions[1]
            fixture.binding = NativeUiFixtures.binding(sourced = true)
            fixture.state = fixture.state.copy(route = ClientRoute.Terminal(NativeUiFixtures.terminal(
                mapOf(SessionRowKey.of(other) to chooserProof),
            )))
        }
        compose.waitUntil(10_000) { fixture.surface?.currentInputProof() != null }
        compose.onAllNodesWithText("Hosts").assertCountEquals(0)
        compose.onAllNodesWithText("Settings").assertCountEquals(0)
        compose.onAllNodesWithText("Open terminal").assertCountEquals(0)
        compose.runOnIdle { assertFalse(selected.stillAuthorized) }
        captureSyntheticScreen("fullscreen-terminal")
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.runOnIdle { assertEquals(ClientIntent.LeaveTerminal, fixture.intents.last().intent) }
        compose.onNodeWithText("Switch").performClick()
        compose.runOnIdle {
            val route = fixture.state.route as ClientRoute.Terminal
            fixture.state = fixture.state.copy(route = ClientRoute.Terminal(route.terminal.copy(quickSwitcherVisible = true)))
        }
        awaitProof(chooserProof)
        captureSyntheticScreen("cross-host-chooser")
        compose.onNode(hasText("Conversation B") and hasClickAction()).performClick()
        compose.runOnIdle {
            val chosen = fixture.intents.single { it.intent is ClientIntent.SwitchTerminalTarget }
            assertTrue(chosen.stillAuthorized)
            assertEquals(SessionActionTarget.of(fixture.state.sessions[1]),
                (chosen.intent as ClientIntent.SwitchTerminalTarget).target)
            assertSame(chooserProof, chosen.proof)
        }
    }

    @Test fun fullscreenBackAndChooserCommitIndependentlyOfBlockedTerminalReceipt() {
        // Keep the original end-to-end component check unchanged. Independently
        // exercise the sheet even when the renderer cannot produce its receipt.
        val other = NativeUiFixtures.sessions().sessions[1]
        val chooserProof = NativeUiFixtures.rowProof(NativeUiFixtures.hostB, NativeUiFixtures.RUN_B, 2)
        val fixture = NativeUiFixture(NativeUiFixtures.sessions().copy(
            route = ClientRoute.Terminal(NativeUiFixtures.terminal(
                mapOf(SessionRowKey.of(other) to chooserProof),
            )),
        )).apply { binding = NativeUiFixtures.binding(sourced = false) }
        assertFalse(chooserProof.grantsAction())
        compose.setContent { fixture.Content() }
        compose.onAllNodesWithText("Hosts").assertCountEquals(0)
        compose.onAllNodesWithText("Settings").assertCountEquals(0)
        compose.onAllNodesWithText("Open terminal").assertCountEquals(0)
        captureSyntheticScreen("fullscreen-independent")
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.runOnIdle { assertEquals(ClientIntent.LeaveTerminal, fixture.intents.last().intent) }
        compose.onNodeWithText("Switch").performClick()
        compose.runOnIdle {
            assertEquals(ClientIntent.ShowQuickSwitcher, fixture.intents.last().intent)
            val route = fixture.state.route as ClientRoute.Terminal
            fixture.state = fixture.state.copy(route = ClientRoute.Terminal(route.terminal.copy(quickSwitcherVisible = true)))
        }
        awaitProof(chooserProof)
        captureSyntheticScreen("cross-host-chooser-independent")
        compose.onNode(hasText("Conversation B") and hasClickAction()).performClick()
        compose.runOnIdle {
            val chosen = fixture.intents.single { it.intent is ClientIntent.SwitchTerminalTarget }
            assertTrue(chosen.stillAuthorized)
            assertEquals(SessionActionTarget.of(other), (chosen.intent as ClientIntent.SwitchTerminalTarget).target)
            assertSame(chooserProof, chosen.proof)
            assertTrue(fixture.packets.isEmpty())
        }
    }

    @Test
    fun debugOffRemovesTheNonTerminalStatusSlotIncludingItsReservedHeight() {
        var debug by mutableStateOf(false)
        var status by mutableStateOf<String?>(null)
        compose.setContent {
            Column(Modifier.fillMaxSize()) {
                NonTerminalStatusSlot(status = status, debugInputMessagingEnabled = debug)
                Box(Modifier.fillMaxWidth().height(120.dp)) {
                    Text("Synthetic content below the status slot")
                }
            }
        }
        val slotHeightPx = 40f * compose.activity.resources.displayMetrics.density
        fun belowTop(): Float = compose.onNodeWithText("Synthetic content below the status slot")
            .fetchSemanticsNode().boundsInRoot.top

        // Off composes nothing: no text node, no placeholder, and no reserved gap.
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
        assertTrue("Off must reserve no height at all: ${belowTop()}", belowTop() <= 1f)

        // On restores the existing fixed-height, noninteractive slot — including while
        // there is no notice text, which is what keeps a pending form from moving when
        // an admission or settlement arrives.
        compose.runOnIdle { debug = true }
        assertTrue("On must reserve the existing slot: ${belowTop()}", belowTop() >= slotHeightPx - 1f)
        compose.runOnIdle { status = "Synthetic status notice" }
        compose.onNodeWithText("Synthetic status notice").assertIsDisplayed()
        assertTrue("The slot keeps its height once a notice arrives: ${belowTop()}",
            belowTop() >= slotHeightPx - 1f)

        // Off again reclaims the whole gap, and the notice text is gone entirely.
        compose.runOnIdle { debug = false }
        assertTrue("Off must reclaim the whole slot: ${belowTop()}", belowTop() <= 1f)
        compose.onAllNodesWithText("Synthetic status notice").assertCountEquals(0)
    }

    @Test
    fun settingsShowsDebugMessagingOffByDefaultAndItsSwitchEmitsOnlyThatPreference() {
        val fixture = NativeUiFixture(NativeUiFixtures.sessions().copy(route = ClientRoute.Settings))
        compose.setContent { fixture.Content() }
        compose.onNodeWithText("Automatic reconnect").assertIsDisplayed()
        compose.onNodeWithText("Remote input and copy").assertIsDisplayed()
        compose.onNodeWithText("Debug input messaging").performScrollTo().assertIsDisplayed()

        // Three remembered switch preferences, in the order the screen draws them.
        val switches = compose.onAllNodes(isSwitch)
        assertEquals(3, switches.fetchSemanticsNodes().size)
        val debugSwitch = switches[2]
        debugSwitch.performScrollTo().assertIsOff()

        // A tap asks the controller to change that one saved preference and nothing else.
        debugSwitch.performClick()
        compose.runOnIdle {
            val requested = fixture.intents.filter { it.intent is ClientIntent.SetDebugInputMessagingEnabled }
            assertEquals(1, requested.size)
            assertEquals(ClientIntent.SetDebugInputMessagingEnabled(true), requested.single().intent)
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetAutoReconnectEnabled })
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetViewerRemoteInputEnabled })
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetSavedFirstReplyTimeoutSeconds })
        }
        // The switch shows the stored value, not the tap: it stays off until the
        // producer republishes the saved setting.
        compose.onAllNodes(isSwitch)[2].assertIsOff()
        compose.runOnIdle {
            fixture.state = fixture.state.copy(
                settings = fixture.state.settings.withDebugInputMessagingEnabled(true),
            )
        }
        compose.onAllNodes(isSwitch)[2].assertIsOn()
    }

    /**
     * The shared non-terminal header's own vertical band, read from drawn bounds.
     *
     * Each route's first content starts one leading content padding below the header, so the
     * distance between the header and that content is the header band's leftover plus the route's
     * own padding — plus whatever of a control's minimum interactive allocation lies outside its
     * drawn surface. A Material button may draw a smaller surface than the allocation it occupies,
     * so both insets are measured rather than assumed to be zero, and the route padding bounds the
     * resulting allocation-to-allocation gap, not the raw surface-to-surface one. Each route is
     * measured on its own composition against freshly drawn nodes — a disposed route's nodes are
     * never read again — and nothing here depends on a card's inner padding or on any text's font
     * height.
     */
    @Test
    fun sharedNonTerminalHeaderKeepsACompactBandAboveEveryRoutesContent() {
        val fixture = NativeUiFixture(NativeUiFixtures.sessions())
        compose.setContent { fixture.Content() }
        val px = compose.activity.resources.displayMetrics.density
        // Each route's own leading content padding, as its source declares it: the list routes
        // keep 12dp and Settings keeps 16dp. The shared header may leave the route's interactive
        // allocations no further apart than that padding already asks for.
        val listPadding = 12f * px
        val settingsPadding = 16f * px

        // The header's own control, drawn above the bottom navigation's Settings destination.
        val headerAction = topDrawnNode("Settings")
        compose.onAllNodesWithText("Settings").onFirst().assertIsDisplayed()
        assertTrue(
            "the header control keeps its full 48dp touch target: ${headerAction.touchBoundsInRoot.height}px",
            headerAction.touchBoundsInRoot.height >= 48f * px - 1f,
        )
        val statusBarPx = statusBarInsetPx()
        assertTrue(
            "the header still consumes the window's status bar inset: top=${headerAction.boundsInRoot.top}px, " +
                "inset=${statusBarPx}px",
            headerAction.boundsInRoot.top >= statusBarPx - 1f,
        )
        assertBandUnderHeader("Settings", "New session", listPadding, "Sessions")

        // Hosts shares the header and the same 12dp leading padding, and keeps its navigation
        // control's target on a route that draws one.
        compose.runOnIdle { fixture.state = fixture.state.copy(route = ClientRoute.Hosts) }
        assertBandUnderHeader("Settings", "Add host", listPadding, "Hosts")
        val back = topDrawnNode("Back")
        assertTrue(
            "the header's Back control keeps its full 48dp touch target: ${back.touchBoundsInRoot.height}px",
            back.touchBoundsInRoot.height >= 48f * px - 1f,
        )

        compose.runOnIdle {
            fixture.state = NativeUiFixtures.saved(
                NativeUiFixtures.savedProof(21), NativeUiFixtures.savedProof(22),
                NativeUiFixtures.savedProof(23),
            )
        }
        assertBandUnderHeader("Settings", "Owner A", listPadding, "Saved")

        // Settings draws no action, so its Back control is the only header control to measure
        // against, and its first content is plain text with no interactive allocation of its own.
        // The route keeps its own 16dp leading inset rather than the list routes' 12dp.
        compose.runOnIdle { fixture.state = fixture.state.copy(route = ClientRoute.Settings) }
        assertBandUnderHeader("Back", "Automatic reconnect", settingsPadding, "Settings", contentIsControl = false)
    }

    /**
     * The status-bar icons must always ask for the dark contrast that matches this app's fixed
     * light window background, never the light contrast the edge-to-edge helper derives from the
     * system night flag. The debug host applies the same window policy as the production root, so
     * this reads the flag back from the real window's own insets controller — the same per-window
     * request the platform is given. Nothing here claims anything about rendered pixels; the
     * reported night mask only shows whether the run actually exercised dark mode, which is the
     * configuration the contrast used to follow instead of the app's own background.
     */
    @Test
    fun statusBarContrastFollowsTheFixedLightWindowBackgroundAndNotSystemNightMode() {
        val window = compose.activity.window
        val lightStatusBars = WindowCompat.getInsetsController(window, window.decorView)
            .isAppearanceLightStatusBars
        val nightMask = compose.activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        assertTrue(
            "the fixed light window background always needs dark status icons: light-status flag = " +
                "$lightStatusBars, uiMode night mask = $nightMask",
            lightStatusBars,
        )
    }

    /**
     * Assert the route now composed starts no further than [routePadding] below the shared
     * header's own [headerControl], and that neither interactive allocation overlaps the other.
     *
     * Both nodes are read from the current composition. A control's drawn surface and the
     * allocation it occupies are different rectangles: a Material button may draw a smaller
     * surface than the minimum interactive allocation it fills, so the measured surface-to-surface
     * distance is converted to an allocation-to-allocation distance by subtracting the measured
     * inset on each side, and that is what the route's own leading padding bounds. Neither inset is
     * assumed to be zero, and neither is derived from a font or a control's nominal size.
     * [contentIsControl] is false where the route's first content is plain text, which has no
     * interactive allocation of its own. No card container, inner padding, or text font height
     * enters the arithmetic, because none of those is what the shared header controls.
     */
    private fun assertBandUnderHeader(
        headerControl: String,
        content: String,
        routePadding: Float,
        route: String,
        contentIsControl: Boolean = true,
    ) {
        val control = topDrawnNode(headerControl)
        val first = topDrawnNode(content)
        val band = first.boundsInRoot.top - control.boundsInRoot.bottom
        assertTrue("$route content must not overlap the shared header: ${band}px", band >= -1f)
        // Account for measured surface insets within minimum interactive allocations.
        val headerInset = (control.touchBoundsInRoot.bottom - control.boundsInRoot.bottom)
            .coerceAtLeast(0f)
        val contentInset = if (contentIsControl) {
            (first.boundsInRoot.top - first.touchBoundsInRoot.top).coerceAtLeast(0f)
        } else {
            0f
        }
        val allocationGap = band - headerInset - contentInset
        assertTrue(
            "$route interactive allocations must not overlap: ${allocationGap}px",
            allocationGap >= -1f,
        )
        assertTrue(
            "$route may sit no further than its own ${routePadding}px leading padding below the " +
                "shared header: ${allocationGap}px",
            allocationGap <= routePadding + 2f,
        )
    }

    /** The drawn node carrying [text] that sits closest to the top of the window. */
    private fun topDrawnNode(text: String): SemanticsNode =
        compose.onAllNodesWithText(text).fetchSemanticsNodes().minByOrNull { it.boundsInRoot.top }
            ?: throw AssertionError("no drawn node with text \"$text\"")

    /** The status bar inset the real window reports; read, never assumed. */
    private fun statusBarInsetPx(): Float =
        compose.activity.window.decorView.rootWindowInsets
            ?.getInsets(WindowInsets.Type.statusBars())?.top?.toFloat() ?: 0f

    /** Material's switch semantics: the only nodes carrying the Switch role. */
    private val isSwitch = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)

    private fun scrollTo(text: String) {
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(text))
    }

    private fun awaitProof(proof: UiActionProof) {
        compose.waitUntil(10_000) { proof.grantsAction() }
    }
}
