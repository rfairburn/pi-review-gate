package io.github.rfairburn.pireviewgate.ui.terminal

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Compose wrapper around [TerminalSurfaceView].
 *
 * The terminal stays a Canvas view on purpose: it draws a whole viewport per
 * frame and needs the platform's frame-commit signal, neither of which a Compose
 * tree adds. This wrapper only hands the view what the caller already knows -
 * the current [TerminalViewBinding] and where to report - so a later screen can
 * place a terminal without owning its fences.
 *
 * The view reference arrives through [onViewCreated] because the controls that
 * belong to the caller - [TerminalSurfaceView.setModalSuspended],
 * [TerminalSurfaceView.setUserInputEnabled],
 * [TerminalSurfaceView.invalidateCommittedFrame],
 * [TerminalSurfaceView.verifyReceipt], [TerminalSurfaceView.submitPastedText],
 * [TerminalSurfaceView.submitKey], [TerminalSurfaceView.setMobileModifiers],
 * [TerminalSurfaceView.toggleMobileModifier],
 * [TerminalSurfaceView.clearMobileModifiers], and
 * [TerminalSurfaceView.openKeyboard] - are imperative, not state to be recomposed.
 * A binding with no input source is drawn in full and denies input; the wrapper
 * takes no part in that choice.
 *
 * The view is focusable, focusable in touch mode, and raises the keyboard when
 * tapped, so a screen that hosts it does not have to arrange input on its behalf.
 * A host that wants the keyboard up without a tap calls [openKeyboard].
 */
@Composable
fun TerminalSurface(
	binding: TerminalViewBinding?,
	modifier: Modifier = Modifier,
	listener: TerminalSurfaceListener? = null,
	onViewCreated: (TerminalSurfaceView) -> Unit = {},
) {
	AndroidView(
		factory = { context -> TerminalSurfaceView(context).also(onViewCreated) },
		modifier = modifier,
		update = { view ->
			view.listener = listener
			view.setBinding(binding)
		},
		onRelease = { view ->
			view.listener = null
			view.release()
		},
	)
}
