package io.github.rfairburn.pireviewgate.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.roster.NativeCatalogScope
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliTarget
import io.github.rfairburn.pireviewgate.core.protocol.native.SessionBackend
import io.github.rfairburn.pireviewgate.core.protocol.roster.RemoteSessionMetadata
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterLifecycle
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Synthetic component rendering for the two additive native surfaces: the
 * Host -> Provider create choice and the separate native host-caption dialog.
 * Nothing here contacts an owner or proves a controller behavior.
 */
@RunWith(AndroidJUnit4::class)
class NativeProviderComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private val hostId = NativeUiFixtures.hostA
    private val run = NativeUiFixtures.RUN_A
    private val claude = NativeCliTarget("claude-default", NativeCliBackend.CLAUDE, "Claude default")
    private val codex = NativeCliTarget("codex-review", NativeCliBackend.CODEX, "Codex review")
    private val scope = NativeCatalogScope(run, 1L, 1L)

    private fun nativeRow() = SessionUiState(
        hostId = hostId, hostLabel = "Owner A", hostRunId = run, stale = false, rosterRevision = 7,
        metadata = RemoteSessionMetadata(
            id = "native-row", label = "My native caption", workspace = "/synthetic/native",
            lifecycle = RosterLifecycle.ALIVE, hasLiveProcess = true, inputSurface = false,
            backend = SessionBackend.CLAUDE,
        ),
    )

    private fun host(): HostUiState = HostUiState(
        host = ConfiguredHost(hostId, HostLabel.parse("Owner A"), Endpoint("fixture-a.invalid", 8443)),
        connection = HostConnectionState.CONNECTED,
        roster = RosterSnapshot(RosterFreshness.CURRENT, run, 7, listOf(nativeRow())),
        capabilities = HostCapabilities.fromAcknowledged(listOf(
            RosterWire.CREATE_CAPABILITY,
            RosterWire.NATIVE_CAPABILITY,
            RosterWire.NATIVE_NAME_CAPABILITY,
        ), 1),
        nativeCliTargets = listOf(claude, codex),
        nativeCatalogScope = scope,
    )

    private fun proof(screen: UiProofScreen = UiProofScreen.SESSION_CREATE, row: String? = null) =
        MutableUiActionProof(UiActionTargetToken(screen, hostId, hostRunId = run, rowId = row, generation = 1))

    private fun show(fixture: NativeUiFixture) {
        compose.setContent { fixture.Content() }
        compose.waitForIdle()
    }

    private fun waitProof(proof: UiActionProof) {
        compose.waitUntil(10_000) { proof.grantsAction() }
    }

    private fun dialogControl(text: String) =
        compose.onNode(hasText(text) and hasAnyAncestor(isDialog()))

    @Test fun createFormOffersOnlyTheSelectedOwnersCommittedNativeCatalog() {
        val owner = OwnerChoice.of(host())
        val formProof = proof()
        val state = ClientUiState(
            hostStates = listOf(host()),
            dialogs = ClientDialogs(createSession = CreateSessionDialog(
                owners = listOf(owner), selectedHostId = hostId,
                provider = CreateProviderChoice.Pi, proof = formProof,
            )),
        )
        val fixture = NativeUiFixture(state)
        show(fixture)
        waitProof(formProof)
        dialogControl("Provider: Pi").assertIsDisplayed()
        dialogControl("Choose provider").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Pi").assertIsDisplayed()
        compose.onNodeWithText("Claude default · Claude").assertIsDisplayed()
        compose.onNodeWithText("Codex review · Codex").assertIsDisplayed().performClick()
        compose.runOnIdle {
            val captured = fixture.intents.single { it.intent is ClientIntent.SelectCreateProvider }
            assertEquals(
                ClientIntent.SelectCreateProvider(CreateProviderChoice.Native(
                    NativeCliBackend.CODEX, "codex-review", "Codex review", scope,
                )),
                captured.intent,
            )
        }
    }

    @Test fun staleNativeChoiceShowsChooseAgainAndNeverSilentlyBecomesPi() {
        val owner = OwnerChoice.of(host())
        val formProof = proof()
        val state = ClientUiState(
            hostStates = listOf(host()),
            dialogs = ClientDialogs(createSession = CreateSessionDialog(
                owners = listOf(owner), selectedHostId = hostId,
                provider = null, workspaceDraft = "/synthetic/work", proof = formProof,
            )),
        )
        val fixture = NativeUiFixture(state)
        show(fixture)
        waitProof(formProof)
        dialogControl("Provider: No provider chosen").assertIsDisplayed()
        compose.onNodeWithText("The selected provider is no longer advertised by this host. Choose a provider again; " +
            "nothing was changed and nothing will be created until you do.").assertIsDisplayed()
        dialogControl("Create session").assertIsNotEnabled()
        compose.runOnIdle {
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SubmitSessionCreate })
            assertEquals(null, fixture.state.dialogs.createSession?.provider)
        }
    }

    @Test fun piOnlyDestinationKeepsTheProviderControlVisibleForAnExplicitRechoice() {
        val piOnly = host().copy(
            capabilities = HostCapabilities.fromAcknowledged(listOf(RosterWire.CREATE_CAPABILITY), 1),
            nativeCliTargets = null,
            nativeCatalogScope = null,
        )
        val owner = OwnerChoice.of(piOnly)
        val formProof = proof()
        val state = ClientUiState(
            hostStates = listOf(piOnly),
            dialogs = ClientDialogs(createSession = CreateSessionDialog(
                owners = listOf(owner), selectedHostId = hostId,
                provider = null, workspaceDraft = "/synthetic/work", proof = formProof,
            )),
        )
        val fixture = NativeUiFixture(state)
        show(fixture)
        waitProof(formProof)
        // The stale native choice is invalidated, but the provider control must not
        // disappear into a silent Pi form: the operator chooses again explicitly.
        dialogControl("Provider: No provider chosen").assertIsDisplayed()
        dialogControl("Choose provider").assertIsDisplayed().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Pi").assertIsDisplayed()
        compose.onAllNodesWithText("Claude default · Claude").assertCountEquals(0)
        dialogControl("Create session").assertIsNotEnabled()
    }

    @Test fun nativeRenameDialogNamesTheObservedProviderAndSubmitsNoPiTuple() {
        val target = requireNotNull(NativeRenameTarget.of(nativeRow()))
        val formProof = proof(UiProofScreen.SESSION_RENAME, row = target.base.rowId)
        val state = ClientUiState(
            hostStates = listOf(host()),
            dialogs = ClientDialogs(nativeRenameSession = NativeRenameSessionDialog(target, "Renamed caption", formProof)),
        )
        val fixture = NativeUiFixture(state)
        show(fixture)
        waitProof(formProof)
        dialogControl("Rename native row").assertIsDisplayed()
        dialogControl("Provider").assertIsDisplayed()
        dialogControl("Claude").assertExists()
        dialogControl("Current caption").assertExists()
        compose.runOnIdle {
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SubmitNativeSessionRename })
        }
        dialogControl("Rename").performClick()
        compose.runOnIdle {
            val request = fixture.intents.single { it.intent is ClientIntent.SubmitNativeSessionRename }.intent
                as ClientIntent.SubmitNativeSessionRename
            assertEquals(target, request.target)
            assertEquals("Renamed caption", request.name)
            assertSame(formProof, request.proof)
            assertTrue(!request.toString().contains("expectedSession"))
        }
    }
}
