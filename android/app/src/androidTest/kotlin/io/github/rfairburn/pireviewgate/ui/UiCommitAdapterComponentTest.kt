package io.github.rfairburn.pireviewgate.ui

import android.app.Dialog
import android.widget.Button as AndroidButton
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.ui.client.UiActionGuard
import io.github.rfairburn.pireviewgate.ui.client.UiCommitScope
import io.github.rfairburn.pireviewgate.ui.client.rememberUiActionGuard
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/** Platform adapter tests. No fixture calls beginDraw/markCommitted/readability setters. */
@RunWith(AndroidJUnit4::class)
class UiCommitAdapterComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun compositionAndPostedWorkCannotAuthorizeUnplacedControlAndLayoutRetiresOldActionEpoch() {
        val proof = NativeUiFixtures.rowProof()
        var visible by mutableStateOf(false)
        var shift by mutableStateOf(0)
        lateinit var guard: UiActionGuard
        val capturedEpochs = CopyOnWriteArrayList<Long>()
        val queuedRan = AtomicBoolean(false)
        var initialComposition = true
        compose.setContent {
            UiCommitScope {
                guard = rememberUiActionGuard(proof, semanticKey = proof.target)
                val view = LocalView.current
                SideEffect {
                    if (initialComposition) {
                        initialComposition = false
                        assertFalse("Composition must not certify a frame", proof.grantsAction())
                        guard.attempt { capturedEpochs.add(proof.epoch) }
                        view.post {
                            // Still clipped to zero. Queued work is not placement or a commit.
                            guard.attempt { capturedEpochs.add(proof.epoch) }
                            queuedRan.set(true)
                        }
                    }
                }
                Box(Modifier.size(if (visible) 220.dp else 0.dp).clipToBounds()) {
                    Button(
                        onClick = { guard.attempt { capturedEpochs.add(proof.epoch) } },
                        modifier = Modifier.offset(y = shift.dp).then(guard.modifier),
                    ) { Text("Guarded control") }
                }
            }
        }
        compose.waitUntil(10_000) { queuedRan.get() }
        compose.runOnIdle {
            assertFalse(proof.grantsAction())
            assertTrue(capturedEpochs.isEmpty())
            visible = true
        }
        compose.waitUntil(10_000) { proof.grantsAction() }
        compose.onNodeWithText("Guarded control").assertIsDisplayed().performClick()
        val oldEpoch = capturedEpochs.single()
        compose.runOnIdle { shift = 40 }
        compose.waitUntil(10_000) { proof.epoch != oldEpoch && proof.grantsAction() }
        // This proof is live again, but an async consumer must spend the epoch it
        // froze in the synchronous callback, not the newly committed generation.
        assertNotEquals(oldEpoch, proof.epoch)
        assertFalse(oldEpoch == proof.epoch && proof.grantsAction())
        compose.onNodeWithText("Guarded control").performClick()
        assertEquals(2, capturedEpochs.size)
        assertEquals(proof.epoch, capturedEpochs.last())
    }

    @Test fun rearmDuringAuthorizationCannotReviveCapturedIntent() {
        val proof = NativeUiFixtures.rowProof()
        val actionTarget = SessionActionTarget.of(NativeUiFixtures.row())
        var shift by mutableStateOf(0)
        val rearmOnTargetRead = AtomicBoolean(false)
        val interleaved = AtomicBoolean(false)
        var captured: CapturedUiIntent? = null
        var capturedEpoch = 0L
        // Only the reader is wrapped. The Android adapter receives the real machine,
        // and only an actual placement change and platform commit can re-arm it.
        val reader = object : UiActionProof {
            override val target: UiActionTargetToken
                get() {
                    if (rearmOnTargetRead.compareAndSet(true, false)) {
                        // grantsFor reads target before its own epoch-bracketed check.
                        // Force a fully committed newer epoch at precisely that point,
                        // after an unsafe caller's initial captured-epoch comparison.
                        compose.runOnIdle { shift = 40 }
                        compose.waitUntil(10_000) { proof.epoch > capturedEpoch && proof.grantsAction() }
                        interleaved.set(true)
                    }
                    return proof.target
                }
            override val epoch: Long get() = proof.epoch
            override val isCurrent: Boolean get() = proof.isCurrent
            override val hasCommittedFrame: Boolean get() = proof.hasCommittedFrame
            override val criticalIdentityReadable: Boolean get() = proof.criticalIdentityReadable
        }
        compose.setContent {
            UiCommitScope {
                val guard = rememberUiActionGuard(proof, semanticKey = actionTarget)
                // Leave real placed space for the shifted control; a root sized
                // only to its button clips the offset instead of re-arming it.
                Box(Modifier.size(220.dp)) {
                    Button(
                        onClick = {
                            guard.attempt {
                                capturedEpoch = proof.epoch
                                captured = CapturedUiIntent(
                                    ClientIntent.EnterTerminal(actionTarget, reader), reader, capturedEpoch, proof.target,
                                )
                            }
                        },
                        modifier = Modifier.offset(y = shift.dp).then(guard.modifier),
                    ) { Text("Capture action") }
                }
            }
        }
        compose.waitUntil(10_000) { proof.grantsAction() }
        compose.onNodeWithText("Capture action").performClick()
        val action = compose.runOnIdle { requireNotNull(captured) }
        assertTrue(action.authorizedAtCapture)
        assertTrue(action.stillAuthorized)
        rearmOnTargetRead.set(true)
        assertFalse("A fresh commit during grantsFor must not revive the captured epoch", action.stillAuthorized)
        assertTrue("Controlled interleaving must have run", interleaved.get())
        assertTrue("The newer epoch really committed", proof.grantsAction())
        assertTrue(proof.epoch > capturedEpoch)
    }

    @Test fun realFocusLossWithdrawsControlAndFreshCommitCannotReauthorizeAnOldQueuedIntent() {
        val proof = NativeUiFixtures.rowProof()
        val fixture = NativeUiFixture(NativeUiFixtures.sessions(proofA = proof))
        compose.setContent { fixture.Content() }
        compose.waitUntil(10_000) { proof.grantsAction() }
        compose.onAllNodesWithText("Open terminal").onFirst().performClick()
        val captured = fixture.intents.single { it.intent is ClientIntent.EnterTerminal }
        assertTrue(captured.stillAuthorized)
        val cover = compose.runOnIdle {
            Dialog(compose.activity).apply {
                setContentView(AndroidButton(context).apply { text = "Focus owner" })
                show()
            }
        }
        try {
            compose.waitUntil(10_000) { !proof.grantsAction() }
            assertFalse(captured.stillAuthorized)
        } finally {
            compose.runOnIdle { cover.dismiss() }
        }
        compose.waitUntil(10_000) { proof.grantsAction() }
        assertTrue(proof.isCurrent)
        assertFalse("A newer control epoch must not revive the queued action", captured.stillAuthorized)
    }

    @Test fun semanticAndCoverageRetirementSurviveSubsequentRealFrames() {
        val proof = NativeUiFixtures.rowProof()
        var semantic by mutableStateOf("target-a")
        var covered by mutableStateOf(false)
        var activeProof by mutableStateOf(proof)
        lateinit var guard: UiActionGuard
        var grants = 0
        compose.setContent {
            UiCommitScope {
                guard = rememberUiActionGuard(activeProof, semanticKey = semantic, covered = covered)
                Button(onClick = { guard.attempt { grants++ } }, modifier = guard.modifier) { Text("Choose") }
            }
        }
        compose.waitUntil(10_000) { proof.grantsAction() }
        compose.runOnIdle { semantic = "target-b" }
        compose.waitForIdle()
        compose.runOnIdle {
            assertFalse(proof.isCurrent)
            guard.attempt { grants++ }
            assertEquals(0, grants)
            activeProof = NativeUiFixtures.rowProof(generation = 2)
        }
        compose.waitUntil(10_000) { activeProof.grantsAction() }
        compose.runOnIdle { covered = true }
        compose.waitForIdle()
        compose.runOnIdle {
            assertFalse(activeProof.isCurrent)
            covered = false
        }
        compose.waitForIdle()
        compose.onNodeWithText("Choose").performClick()
        compose.runOnIdle {
            assertFalse(activeProof.grantsAction())
            assertFalse(proof.grantsAction())
            assertEquals(0, grants)
        }
    }

    @Test fun closeConfirmationUsesItsOwnDialogWindowCommitAndExactFrozenTarget() {
        val row = NativeUiFixtures.row()
        val target = SessionActionTarget.of(row)
        val proof = NativeUiFixtures.rowProof()
        val fixture = NativeUiFixture(NativeUiFixtures.sessions().copy(
            dialogs = ClientDialogs(closeSession = CloseSessionDialog(target, proof)),
        ))
        assertFalse(proof.grantsAction())
        compose.setContent { fixture.Content() }
        compose.waitUntil(10_000) { proof.grantsAction() }
        compose.onNodeWithText("Close session").assertIsDisplayed().performClick()
        compose.runOnIdle {
            val captured = fixture.intents.single { it.intent is ClientIntent.ConfirmSessionClose }
            assertEquals(target, (captured.intent as ClientIntent.ConfirmSessionClose).target)
            assertSame(proof, captured.proof)
            assertTrue(captured.stillAuthorized)
            // Intent only: no close result or session mutation is synthesized.
            assertEquals(row.metadata, fixture.state.sessions.first().metadata)
        }
    }
}
