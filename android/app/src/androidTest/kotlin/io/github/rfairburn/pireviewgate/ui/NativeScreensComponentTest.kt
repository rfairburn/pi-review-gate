package io.github.rfairburn.pireviewgate.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.*
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
        listOf("Owner label", "Workspace", "Live process", "Busy", "Pending input", "Input surface",
            "Background tasks", "Background shells", "Active tasks", "Active shells", "Exit code",
            "Error", "Native conversation", "Native epoch", "Native name", "Persistence",
            "Owner label A", "/synthetic/workspace/a", "native-a", "Synthetic activity one",
            "Synthetic activity two").forEach { value ->
            compose.onNodeWithText(value).assertExists()
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

    private fun scrollTo(text: String) {
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(text))
    }

    private fun awaitProof(proof: UiActionProof) {
        compose.waitUntil(10_000) { proof.grantsAction() }
    }
}
