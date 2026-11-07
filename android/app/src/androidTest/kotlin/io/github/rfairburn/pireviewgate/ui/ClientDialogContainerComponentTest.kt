package io.github.rfairburn.pireviewgate.ui

import androidx.compose.material3.AlertDialogDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.surfaceColorAtElevation
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Synthetic component UI only: real dialog windows/commits, no owner or storage effects. */
@OptIn(ExperimentalMaterial3Api::class)
@RunWith(AndroidJUnit4::class)
class ClientDialogContainerComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()
    private var expectedContainerColor = Color.Unspecified

    @Test fun closeConfirmationPaintsOpaqueMaterialInteriorAndKeepsItsCommittedTarget() {
        val state = savedScreen()
        val target = SessionActionTarget.of(state.sessions.first())
        val proof = NativeUiFixtures.rowProof(generation = 4)
        val fixture = NativeUiFixture(state.copy(
            dialogs = ClientDialogs(closeSession = CloseSessionDialog(target, proof)),
        ))
        assertFalse(proof.grantsAction())
        show(fixture)
        compose.waitUntil(10_000) { proof.grantsAction() }
        assertOpaqueInterior("close-confirmation-opaque-container")

        dialogControl("Close session").assertIsDisplayed().performClick()
        val captured = compose.runOnIdle {
            fixture.intents.single { it.intent is ClientIntent.ConfirmSessionClose }.also {
                val request = it.intent as ClientIntent.ConfirmSessionClose
                assertEquals(target, request.target)
                assertSame(proof, request.proof)
                assertTrue(it.stillAuthorized)
            }
        }
        dismiss(fixture, proof, ClientDialogKind.CLOSE_SESSION)
        compose.runOnIdle { assertFalse(captured.stillAuthorized) }
    }

    @Test fun ownerConfirmationRequiredShowsASeparateSecondInAppStageAndTap() {
        val state = savedScreen()
        val target = SessionActionTarget.of(state.sessions.first())
        val proof = NativeUiFixtures.rowProof(generation = 4)
        val fixture = NativeUiFixture(state.copy(
            dialogs = ClientDialogs(closeSession = CloseSessionDialog(
                target = target,
                proof = proof,
                confirmationRequestId = "opaque-owner-request",
                connectionGeneration = 4,
            )),
        ))
        assertFalse(proof.grantsAction())
        show(fixture)
        compose.waitUntil(10_000) { proof.grantsAction() }
        dialogControl("Host confirmation required").assertIsDisplayed()
        dialogControl("Ask host to close").assertIsDisplayed()
        dialogControl("Close session").assertDoesNotExist()
        compose.waitForIdle()
        assertTrue("the second stage arms only a fresh deliberate tap",
            fixture.intents.none { it.intent is ClientIntent.ConfirmSessionClose })
        dialogControl("Ask host to close").performClick()
        compose.runOnIdle {
            val captured = fixture.intents.single { it.intent is ClientIntent.ConfirmSessionClose }
            val request = captured.intent as ClientIntent.ConfirmSessionClose
            assertEquals(target, request.target)
            assertSame(proof, request.proof)
            assertTrue(captured.stillAuthorized)
        }
    }

    @Test fun savedDeletePaintsOpaqueMaterialInteriorAndKeepsItsCommittedTarget() {
        val state = savedScreen()
        val target = requireNotNull(SavedEntryTarget.of(state.saved, state.saved.entries.single()))
        val proof = NativeUiFixtures.savedProof(4, target.entryId)
        val fixture = NativeUiFixture(state.copy(
            dialogs = ClientDialogs(savedDelete = SavedDeleteDialog(target, proof)),
        ))
        assertFalse(proof.grantsAction())
        show(fixture)
        compose.waitUntil(10_000) { proof.grantsAction() }
        assertOpaqueInterior("saved-delete-confirmation-opaque-container")

        dialogControl("Delete").assertIsDisplayed().performClick()
        compose.runOnIdle {
            val request = fixture.intents.single { it.intent is ClientIntent.ConfirmSavedDelete }.intent
                as ClientIntent.ConfirmSavedDelete
            assertEquals(target, request.target)
            assertSame(proof, request.proof)
            assertTrue(request.proof.grantsAction())
            // Intent only: the synthetic Saved entry remains untouched.
            assertEquals(state.saved.entries, fixture.state.saved.entries)
        }
        dismiss(fixture, proof, ClientDialogKind.SAVED_DELETE)
    }

    private fun savedScreen() = NativeUiFixtures.saved(
        NativeUiFixtures.savedProof(1),
        NativeUiFixtures.savedProof(2),
        NativeUiFixtures.savedProof(3, "entry-a"),
    )

    private fun show(fixture: NativeUiFixture) {
        compose.setContent {
            // Keep the default Material theme, including its content/semantics behavior.
            MaterialTheme {
                val container = AlertDialogDefaults.containerColor
                expectedContainerColor = if (container == MaterialTheme.colorScheme.surface) {
                    MaterialTheme.colorScheme.surfaceColorAtElevation(AlertDialogDefaults.TonalElevation)
                } else {
                    container
                }
                fixture.Content()
            }
        }
    }

    private fun dialogControl(text: String) =
        compose.onNode(hasText(text) and hasAnyAncestor(isDialog()))

    private fun dismiss(fixture: NativeUiFixture, proof: UiActionProof, kind: ClientDialogKind) {
        dialogControl("Dismiss").performClick()
        compose.runOnIdle {
            assertEquals(ClientIntent.DismissDialog(kind), fixture.intents.last().intent)
            // The fixture echoes dismissal, not a fabricated commit or owner response.
            fixture.state = fixture.state.copy(dialogs = ClientDialogs.NONE)
        }
        compose.waitForIdle()
        compose.runOnIdle {
            assertFalse(proof.isCurrent)
            assertFalse(proof.grantsAction())
        }
    }

    private fun assertOpaqueInterior(screenshotName: String) {
        compose.waitForIdle()
        // Existing opt-in full-screen evidence includes the synthetic Saved content behind it.
        captureSyntheticScreen(screenshotName)
        // Capture actual pixels from the dialog window, not a Surface/semantics assertion.
        val image = compose.onNode(isDialog()).captureToImage()
        val pixels = image.toPixelMap()
        val inset = with(compose.density) { 10.dp.roundToPx() }
        assertTrue("Expected a full dialog image", image.width > inset * 8 && image.height > inset * 8)
        assertEquals("Default dialog container must be opaque", 1f, expectedContainerColor.alpha, 0f)

        // 3x3 patches in the unchanged 20dp padding: no glyphs or buttons. The side
        // patches use the middle third and the top/bottom patches the central width,
        // deliberately avoiding the rounded corners and their antialiased boundary.
        val centers = listOf(0.4f, 0.5f, 0.6f).flatMap { fraction ->
            listOf(
                inset to (image.height * fraction).toInt(),
                (image.width - 1 - inset) to (image.height * fraction).toInt(),
                (image.width * fraction).toInt() to inset,
                (image.width * fraction).toInt() to (image.height - 1 - inset),
            )
        }
        val tolerance = 2f / 255f
        centers.forEach { (centerX, centerY) ->
            for (y in centerY - 1..centerY + 1) {
                for (x in centerX - 1..centerX + 1) {
                    val actual = pixels[x, y]
                    val point = "$screenshotName interior ($x,$y)"
                    // Alpha alone is insufficient if a capture composites the window:
                    // RGB must also be the Material container, never Saved text/scrim.
                    assertEquals("$point alpha", 1f, actual.alpha, tolerance)
                    assertEquals("$point red", expectedContainerColor.red, actual.red, tolerance)
                    assertEquals("$point green", expectedContainerColor.green, actual.green, tolerance)
                    assertEquals("$point blue", expectedContainerColor.blue, actual.blue, tolerance)
                }
            }
        }
    }
}
