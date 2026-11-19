package io.github.rfairburn.pireviewgate.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Synthetic component rendering for the create form's "Create missing workspace
 * directory" checkbox (#493). Nothing here contacts an owner, proves a controller
 * behavior, or creates a directory: it checks what the form draws and which exact
 * intents a tap emits.
 */
@RunWith(AndroidJUnit4::class)
class CreateWorkspaceDialogComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    private val hostId = NativeUiFixtures.hostA
    private val run = NativeUiFixtures.RUN_A
    private val label = "Create missing workspace directory"

    private fun host(capabilities: List<String>): HostUiState = HostUiState(
        host = ConfiguredHost(hostId, HostLabel.parse("Owner A"), Endpoint("fixture-a.invalid", 8443)),
        connection = HostConnectionState.CONNECTED,
        roster = RosterSnapshot(RosterFreshness.CURRENT, run, 7, emptyList()),
        capabilities = HostCapabilities.fromAcknowledged(capabilities, 1),
    )

    private val supporting = host(listOf(RosterWire.CREATE_CAPABILITY, RosterWire.CREATE_WORKSPACE_CAPABILITY))
    private val legacy = host(listOf(RosterWire.CREATE_CAPABILITY))

    private fun proof() =
        MutableUiActionProof(UiActionTargetToken(UiProofScreen.SESSION_CREATE, hostId, hostRunId = run, generation = 1))

    private fun state(host: HostUiState, formProof: UiActionProof, createWorkspace: Boolean) = ClientUiState(
        hostStates = listOf(host),
        dialogs = ClientDialogs(createSession = CreateSessionDialog(
            owners = listOf(OwnerChoice.of(host)), selectedHostId = hostId,
            provider = CreateProviderChoice.Pi, workspaceDraft = "/synthetic/new", proof = formProof,
            createWorkspace = createWorkspace,
        )),
    )

    private fun show(fixture: NativeUiFixture, formProof: UiActionProof) {
        compose.setContent { fixture.Content() }
        compose.waitForIdle()
        compose.waitUntil(10_000) { formProof.grantsAction() }
    }

    private fun dialogControl(text: String) = compose.onNode(hasText(text) and hasAnyAncestor(isDialog()))

    @Test fun supportingOwnerDrawsAnUncheckedChoiceAndSubmitsTheCheckedOne() {
        val first = proof()
        val fixture = NativeUiFixture(state(supporting, first, createWorkspace = false))
        show(fixture, first)
        dialogControl(label).assertIsDisplayed().assertIsOff()
        dialogControl("Create session").assertIsEnabled()
        dialogControl(label).performClick()
        compose.runOnIdle {
            assertEquals(ClientIntent.SetCreateWorkspace(true),
                fixture.intents.last { it.intent is ClientIntent.SetCreateWorkspace }.intent)
        }

        // The controller's answer: the same form, checked, under a fresh receipt.
        val second = proof()
        compose.runOnIdle { fixture.state = state(supporting, second, createWorkspace = true) }
        compose.waitUntil(10_000) { second.grantsAction() }
        dialogControl(label).assertIsOn()
        compose.onAllNodesWithText("This host does not support", substring = true).assertCountEquals(0)
        dialogControl("Create session").assertIsEnabled().performClick()
        compose.runOnIdle {
            val submit = fixture.intents.last { it.intent is ClientIntent.SubmitSessionCreate }.intent
                as ClientIntent.SubmitSessionCreate
            assertTrue(submit.createWorkspace)
            assertSame(second, submit.proof)
            assertEquals(CreateProviderChoice.Pi, submit.provider)
        }
    }

    @Test fun unsupportingOwnerKeepsTheLegacyFormShape() {
        val formProof = proof()
        val fixture = NativeUiFixture(state(legacy, formProof, createWorkspace = false))
        show(fixture, formProof)
        compose.onAllNodesWithText(label).assertCountEquals(0)
        dialogControl("Create session").assertIsEnabled().performClick()
        compose.runOnIdle {
            val submit = fixture.intents.last { it.intent is ClientIntent.SubmitSessionCreate }.intent
                as ClientIntent.SubmitSessionCreate
            assertFalse(submit.createWorkspace)
        }
    }

    @Test fun heldChoiceOnAnUnsupportingOwnerStaysVisibleClearableAndBlocksSubmit() {
        val formProof = proof()
        val fixture = NativeUiFixture(state(legacy, formProof, createWorkspace = true))
        show(fixture, formProof)
        dialogControl(label).assertIsDisplayed().assertIsOn()
        compose.onNode(hasText("This host does not support", substring = true) and hasAnyAncestor(isDialog()))
            .assertIsDisplayed()
        dialogControl("Create session").assertIsNotEnabled()
        dialogControl(label).performClick()
        compose.runOnIdle {
            assertEquals(ClientIntent.SetCreateWorkspace(false),
                fixture.intents.last { it.intent is ClientIntent.SetCreateWorkspace }.intent)
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SubmitSessionCreate })
        }
    }
}
