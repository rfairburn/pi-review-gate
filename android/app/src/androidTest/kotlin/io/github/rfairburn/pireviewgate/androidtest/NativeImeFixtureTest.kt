package io.github.rfairburn.pireviewgate.androidtest

import android.graphics.Rect
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Regressions for the two typing rules [NativeDeviceAcceptanceTest] relies on: which
 * pane the OS keyboard is bound to, and which IME node a tap may target.
 *
 * Pure rules over hand-built facts, no UI: each negative is a situation the acceptance
 * driver must not act on, and the positives keep those negatives from passing by
 * construction.
 */
@RunWith(AndroidJUnit4::class)
class NativeImeFixtureTest {

    private val keyBounds = Rect(100, 1_800, 190, 1_900)

    private fun node(
        text: String? = null,
        description: String? = "z",
        visible: Boolean = true,
        enabled: Boolean = true,
        click: Boolean = true,
        bounds: Rect = Rect(keyBounds),
    ) = ImeNodeFacts(text, description, visible, enabled, click, bounds)

    @Test
    fun aKeyboardLeftVisibleByAnEarlierPaneDoesNotSkipTheNewPanesOwnShowAction() {
        // The toggle offers Hide: take it, then Show — never "already visible, done".
        assertEquals(
            PaneKeyboardStep.HIDE_THEN_SHOW,
            paneKeyboardStep(boundToThisPane = false, imeVisible = true, offer = KeyboardControlOffer.HIDE),
        )
        // The toggle offers Show despite the visible IME: Show directly, no Hide first.
        assertEquals(
            PaneKeyboardStep.SHOW,
            paneKeyboardStep(boundToThisPane = false, imeVisible = true, offer = KeyboardControlOffer.SHOW),
        )
        assertEquals(
            PaneKeyboardStep.SHOW,
            paneKeyboardStep(boundToThisPane = false, imeVisible = false, offer = KeyboardControlOffer.SHOW),
        )
    }

    @Test
    fun theSamePaneIsNotCycledAgainWhileItsKeyboardIsUp() {
        for (offer in KeyboardControlOffer.values()) {
            assertEquals(
                "a bound pane with its keyboard up needs no action whatever the toggle offers ($offer)",
                PaneKeyboardStep.NONE,
                paneKeyboardStep(boundToThisPane = true, imeVisible = true, offer = offer),
            )
        }
        // Gone within the same pane: the toggle's own Show, nothing more.
        assertEquals(
            PaneKeyboardStep.SHOW,
            paneKeyboardStep(boundToThisPane = true, imeVisible = false, offer = KeyboardControlOffer.SHOW),
        )
    }

    @Test
    fun theOneExactEligibleKeyYieldsItsOwnBoundsUnaltered() {
        val selection = selectImeKey(listOf(node()), "z", complete = true)
        assertEquals(ImeKeySelection.Unique(keyBounds), selection)
        // A label carried as text instead of a description is the same key identity.
        assertEquals(
            ImeKeySelection.Unique(keyBounds),
            selectImeKey(listOf(node(text = "z", description = null)), "z", complete = true),
        )
    }

    @Test
    fun aWrongLabelAuthorizesNoTap() {
        for (label in listOf("Z", "zz", " z", "s")) {
            assertEquals(
                "label '$label' must not stand in for 'z'",
                ImeKeySelection.Refused(eligible = 0, labelMatches = 0, complete = true),
                selectImeKey(listOf(node(description = label)), "z", complete = true),
            )
        }
    }

    @Test
    fun aNonActionablePreviewSharingTheLabelAuthorizesNoTap() {
        val preview = node(click = false, bounds = Rect(100, 1_650, 190, 1_790))
        assertEquals(ImeKeySelection.Refused(eligible = 0, labelMatches = 1, complete = true), selectImeKey(listOf(preview), "z", complete = true))
        // Beside the real key, the preview neither wins nor makes the choice ambiguous.
        assertEquals(ImeKeySelection.Unique(keyBounds), selectImeKey(listOf(preview, node()), "z", complete = true))
    }

    @Test
    fun disabledHiddenOrUnlaidKeysAuthorizeNoTap() {
        for (candidate in listOf(node(enabled = false), node(visible = false), node(bounds = Rect()))) {
            assertEquals(
                "$candidate must not be tapped",
                ImeKeySelection.Refused(eligible = 0, labelMatches = 1, complete = true),
                selectImeKey(listOf(candidate), "z", complete = true),
            )
        }
    }

    @Test
    fun twoEligibleKeysWithTheSameLabelAreRefusedRatherThanGuessed() {
        val other = node(bounds = Rect(300, 1_800, 390, 1_900))
        assertEquals(ImeKeySelection.Refused(eligible = 2, labelMatches = 2, complete = true), selectImeKey(listOf(node(), other), "z", complete = true))
    }

    @Test
    fun aTruncatedScanWithOneEligibleKeyAuthorizesNoTap() {
        // A second matching key could lie beyond the walk budget, so one found is not unique.
        assertEquals(
            ImeKeySelection.Refused(eligible = 1, labelMatches = 1, complete = false),
            selectImeKey(listOf(node()), "z", complete = false),
        )
    }
}
