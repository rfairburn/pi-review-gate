package io.github.rfairburn.pireviewgate.ui.terminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Rect
import android.text.InputType
import android.util.AttributeSet
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import io.github.rfairburn.pireviewgate.core.input.AdaptiveTerminalGrid
import io.github.rfairburn.pireviewgate.core.input.BitmapBudget
import io.github.rfairburn.pireviewgate.core.input.CellGeometry
import io.github.rfairburn.pireviewgate.core.input.CellPosition
import io.github.rfairburn.pireviewgate.core.input.CommittedFrameGate
import io.github.rfairburn.pireviewgate.core.input.DrawableImage
import io.github.rfairburn.pireviewgate.core.input.FrameCommitRecord
import io.github.rfairburn.pireviewgate.core.input.FrameInvalidationReason
import io.github.rfairburn.pireviewgate.core.input.HardwareKeyFacts
import io.github.rfairburn.pireviewgate.core.input.HardwareKeys
import io.github.rfairburn.pireviewgate.core.input.ImeCommitEncoder
import io.github.rfairburn.pireviewgate.core.input.InputBatchDelivery
import io.github.rfairburn.pireviewgate.core.input.InputBlockReason
import io.github.rfairburn.pireviewgate.core.input.InputEligibility
import io.github.rfairburn.pireviewgate.core.input.InputProofPublication
import io.github.rfairburn.pireviewgate.core.input.InputSourceFence
import io.github.rfairburn.pireviewgate.core.input.InputSourceState
import io.github.rfairburn.pireviewgate.core.input.KeyDeliveryLedger
import io.github.rfairburn.pireviewgate.core.input.KeyboardEncoder
import io.github.rfairburn.pireviewgate.core.input.KeyboardModifiers
import io.github.rfairburn.pireviewgate.core.input.MobileModifierLatch
import io.github.rfairburn.pireviewgate.core.input.MouseEncoder
import io.github.rfairburn.pireviewgate.core.input.PasteEncoder
import io.github.rfairburn.pireviewgate.core.input.TerminalCell
import io.github.rfairburn.pireviewgate.core.input.TerminalCellLayout
import io.github.rfairburn.pireviewgate.core.input.TerminalFunctionKey
import io.github.rfairburn.pireviewgate.core.input.TerminalGraphicsGeometry
import io.github.rfairburn.pireviewgate.core.input.TerminalKey
import io.github.rfairburn.pireviewgate.core.input.TerminalKeyEventType
import io.github.rfairburn.pireviewgate.core.input.TerminalLayout
import io.github.rfairburn.pireviewgate.core.input.TerminalPointerEvent
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalGraphicsFallback
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalGraphicsImage
import io.github.rfairburn.pireviewgate.ui.render.DecodedImage
import io.github.rfairburn.pireviewgate.ui.render.FrameCommitWatcher
import io.github.rfairburn.pireviewgate.ui.render.TerminalImageDecoder
import kotlin.math.ceil

/**
 * The phone's native terminal surface: a custom [View] that draws the owner's
 * validated viewport snapshot with Canvas and turns real keyboard, IME, and
 * pointer activity into canonical packets.
 *
 * It is not a sidebar, not a text transcript, and not a terminal emulator. It
 * parses no raw byte stream, executes no control sequence, and keeps no scrollback
 * of its own: what is on screen is exactly the last laid-out [TerminalFrame], and
 * what leaves it is exactly what the user typed against that drawing.
 *
 * ## What it owns
 *
 *  - measurement: cell metrics from its own size and padding, reported upward as
 *    [TerminalSurfaceListener.onViewportRequested];
 *  - drawing: text, the allowlisted attributes, palette and RGB colors, the
 *    cursor, typed PNG placements, and payload-free image fallbacks;
 *  - the commit fence: a frame counts as drawn only when the platform's
 *    frame-commit callback confirms the pass that drew it, and every packet names
 *    the receipt for that commit;
 *  - encoding: keyboard, paste, and mouse packets built against the modes that
 *    arrived with the committed frame, with the root screen's latched modifier
 *    chips folded into the keystrokes they modify;
 *  - display-only frames: a publish that states no host-written input source is
 *    laid out and drawn in full, and every keystroke, paste, and pointer report
 *    against it is refused with a fixed reason.
 *
 * ## What it never does
 *
 * It opens no socket and sends no byte, reads and writes no clipboard, keeps no
 * local history, offers no automatic paste, and starts no service. Transport,
 * copy, screens, and navigation belong to the caller.
 *
 * ## Fences
 *
 * Input is refused — with a fixed reason, never silently — when nothing is bound,
 * when no frame is committed, when the committed publish stated no input source,
 * when the view is not focused, hidden, covered, or detached, when a modal surface
 * or the caller has taken input, when the platform cannot confirm commits for this
 * view, when the binding, layout, or policy epochs moved, or when an encoder
 * refuses the keystroke. A queued layout or recomposition is never treated as a
 * receipt, and nothing is buffered for a later one: a refused keystroke is over.
 *
 * A source-less frame never becomes a blank terminal, and a source is never
 * invented to make input possible: the frame, its geometry, and its modes are
 * everything drawing needs, and a source is only ever what a keystroke gets
 * attributed to.
 */
class TerminalSurfaceView @JvmOverloads constructor(
	context: Context,
	attrs: AttributeSet? = null,
) : View(context, attrs) {
	/** The caller's sink for viewport, commit, input, and fence reports. */
	var listener: TerminalSurfaceListener? = null

	/** Text color for cells the owner left at their default foreground. */
	var defaultForegroundColor: Int = DEFAULT_FOREGROUND
		set(value) {
			field = value
			invalidate()
		}

	/** Background color behind cells the owner left at their default background. */
	var defaultBackgroundColor: Int = DEFAULT_BACKGROUND
		set(value) {
			field = value
			invalidate()
		}

	/** Actual fitted size; assigning changes the preference, never the 80x25 floor. */
	var textSizePx: Float
		get() = paints.textSizePx
		set(value) {
			if (!value.isFinite()) return
			val clamped = value.coerceIn(AdaptiveTerminalGrid.MIN_TEXT_SIZE_PX, AdaptiveTerminalGrid.MAX_TEXT_SIZE_PX)
			if (preferredTextSizePx == clamped) return
			preferredTextSizePx = clamped
			recomputeMetrics()
		}

	// A 12dp monospace face is the density-aware desktop-like preference. Android
	// font-scale does not stretch terminal cells; small panes fit down uniformly.
	private var preferredTextSizePx = (12f * resources.displayMetrics.density)
		.coerceIn(AdaptiveTerminalGrid.MIN_TEXT_SIZE_PX, AdaptiveTerminalGrid.MAX_TEXT_SIZE_PX)

	private val gate = CommittedFrameGate()
	private val paints = TerminalPaints()

	/** Decoded bitmaps keyed by image id, so repeated placements share one decode. */
	private val decodedImages = HashMap<String, DecodedImage>()

	/** Image ids whose decode was requested and has not come back yet. */
	private val pendingImageIds = HashSet<String>()

	/** Image ids that will not render this generation: refused, bad, or over budget. */
	private val failedImageIds = HashSet<String>()

	/** The whole surface's ceiling on retained decoded pixels, not a per-image one. */
	private val bitmapBudget = BitmapBudget(MAX_SURFACE_BITMAP_BYTES)

	private var attachedToWindow = false

	private var binding: TerminalViewBinding? = null
	private var layout: TerminalLayout? = null
	private var geometry: CellGeometry? = null
	private var receipt: FrameCommitReceipt? = null

	private var watcher: FrameCommitWatcher? = null

	private class DrawCandidate(
		val epoch: Long,
		val binding: TerminalViewBinding,
		val layout: TerminalLayout,
		val geometry: CellGeometry,
		val bindingEpoch: Long,
		val layoutEpoch: Long,
	) {
		var drawn = false
	}

	private var pendingDraw: DrawCandidate? = null
	private var drawObserver: ViewTreeObserver? = null
	private val beforeDraw = ViewTreeObserver.OnPreDrawListener {
		prepareDrawCommit()
		true
	}
	private var imageDecoder: TerminalImageDecoder? = null
	private var imageGeneration = 0L

	private var cellWidthPx = 0
	private var cellHeightPx = 0
	private var requestedCols = 0
	private var requestedRows = 0
	private var frameRejected = false

	/** The single view-state predicate behind commit acceptance, input, and verify. */
	private val eligibility = InputEligibility()

	private val deliveredKeys = KeyDeliveryLedger()

	/** The modifier chips the root screen is holding down: Ctrl, Alt, and Shift. */
	private val mobileModifiers = MobileModifierLatch()

	/**
	 * The one input proof this surface stands behind, published for other threads.
	 *
	 * The UI thread publishes and retires it. [verifyReceipt] and
	 * [currentInputProof] read nothing else, which is what lets the caller's writer
	 * thread decide whether a queued write may still be attributed to these pixels
	 * without touching the view, the gate, or the eligibility state — none of which
	 * is safe to read away from the UI thread. A display-only commit is never
	 * published, so a source-less frame is drawn and publishes no input proof at all.
	 */
	private val publishedProof = InputProofPublication<FrameCommitReceipt>()

	private var activeConnection: TerminalInputConnection? = null
	private var inputConnectionEpoch = 0L

	init {
		// Every input path — hardware keys, the IME, mouse reports — needs focus,
		// and a plain View is not focusable in touch mode by default. Without this a
		// tap could never open a keyboard, and the surface would fence its own input.
		isFocusable = true
		isFocusableInTouchMode = true
		isClickable = true
	}

	/* -------------------------------------------------------------------- *
	 * Caller-facing controls
	 * -------------------------------------------------------------------- */

	/**
	 * Install [newBinding], or clear the surface with null.
	 *
	 * The previous frame and its receipt are retired before anything is drawn.
	 * The IME connection and composition survive a content-only publish of the same
	 * input context, but a target, source, geometry, modes, or policy change retires
	 * them too. Even a preserved connection must wait for a fresh platform commit
	 * before sending anything; refused input is never buffered.
	 *
	 * A binding whose source is null is not refused: its frame is drawn exactly like
	 * any other, and input against it is denied. A binding whose non-null source
	 * contradicts its own owner run or owner row is refused exactly as before.
	 */
	fun setBinding(newBinding: TerminalViewBinding?) {
		if (binding === newBinding) return
		// First, and before anything else about the switch is handled: the old
		// target's proof stops being valid here, on the publishing side, so a writer
		// thread checking it concurrently cannot be told "yes" for a frame that is on
		// its way out.
		publishedProof.retire()
		val previous = binding
		binding = newBinding
		// A different session, connection, native tuple, or source state is a
		// different target, and a modifier chip latched for the old one must never
		// travel to the new one. A later publish of the same target is not a switch,
		// so the chips the user is holding stay held across it.
		if (previous?.sameTargetAs(newBinding) != true) clearMobileModifiersForTarget()
		gate.rebind()
		receipt = null
		layout = null
		geometry = null
		frameRejected = false
		clearImages()
		// sameTargetAs alone is not an IME context: the encoding and geometry the
		// keyboard was composing against must also stay unchanged. Frame dimensions
		// participate because they determine layout even if session geometry agrees.
		val sameInputContext = previous != null && newBinding != null &&
			previous.sameTargetAs(newBinding) && previous.geometry == newBinding.geometry &&
			previous.modes == newBinding.modes && previous.policyGeneration == newBinding.policyGeneration &&
			previous.frame.cols == newBinding.frame.cols && previous.frame.rows == newBinding.frame.rows
		if (!sameInputContext) retireInputConnection()
		// A binding whose source contradicts its own owner run or owner row is a
		// caller mistake, and it is refused in [applyFrame] — the one path every
		// draw goes through — rather than only here.
		applyFrame()
	}

	/** The frame currently installed, or null. */
	fun currentBinding(): TerminalViewBinding? = binding

	/**
	 * The last commit this surface can attest to, or null. UI thread only.
	 *
	 * This is the display commit: a source-less publish has one, and it is not an
	 * input proof. Anything deciding whether input may ride on a frame reads
	 * [verifyReceipt] or [currentInputProof] instead.
	 */
	fun currentReceipt(): FrameCommitReceipt? = receipt

	/**
	 * The input proof published right now, or null. Safe from any thread.
	 *
	 * Non-null only for a committed frame that carries a host-written input source and
	 * is still standing: it is exactly the value [verifyReceipt] accepts.
	 */
	fun currentInputProof(): FrameCommitReceipt? = publishedProof.current()?.proof

	/**
	 * True when [candidate] is exactly the input proof this surface publishes now.
	 *
	 * Safe from any thread, including the caller's IO writer thread: the answer comes
	 * from a single atomic read of the published proof, never from the view, the gate,
	 * or the eligibility state. Callers check it immediately before a queued write.
	 *
	 * A proof stops being current as soon as the UI thread retires it, which it does
	 * before any other handling of a binding, source, subscription, layout, policy,
	 * focus, coverage, modal, or detach change — and a display-only commit is never
	 * published in the first place. So the answer needs no further fence to be honest,
	 * and it never says yes to a frame the surface has stopped standing behind.
	 */
	fun verifyReceipt(candidate: FrameCommitReceipt?): Boolean = publishedProof.isCurrent(candidate)

	/** Take input away from this surface for a modal (a session chooser, say). */
	fun setModalSuspended(suspended: Boolean) {
		if (eligibility.modalSuspended == suspended) return
		publishedProof.retire()
		eligibility.modalSuspended = suspended
		// Both edges: a chip held while a modal took over, or held into the moment it
		// came back, is a chip whose effect the user can no longer see.
		clearMobileModifiersForTarget()
		if (suspended) {
			retireCommit(InputUnavailableReason.MODAL_SUSPENDED)
			retireInputConnection()
		} else {
			scheduleDraw()
		}
	}

	/** Turn user input off or back on for this surface. */
	fun setUserInputEnabled(enabled: Boolean) {
		if (eligibility.userInputEnabled == enabled) return
		publishedProof.retire()
		eligibility.userInputEnabled = enabled
		if (!enabled) {
			retireCommit(InputUnavailableReason.USER_INPUT_DISABLED)
			retireInputConnection()
		} else {
			scheduleDraw()
		}
	}

	/**
	 * Retire the committed frame on the caller's behalf — a policy snapshot
	 * changed, the session paused, or anything else the surface cannot see. The
	 * next draw pass establishes a new receipt.
	 */
	fun invalidateCommittedFrame(reason: InputUnavailableReason) {
		publishedProof.retire()
		retireCommit(reason)
		// The caller's fence covers text already in flight too: a composition the
		// keyboard still holds must not arrive after a new frame is committed.
		retireInputConnection()
	}

	/**
	 * Encode [text] as one whole paste and report it through
	 * [TerminalSurfaceListener.onInput].
	 *
	 * This is the only paste path: the surface never reads the clipboard and
	 * never syncs it. The whole input is validated against the owner's 1 MiB
	 * bound first, and an oversized paste is refused rather than clipped.
	 *
	 * Latched modifier chips do not touch a paste. What the user pasted is the text
	 * they chose, and holding Ctrl is not a request to have it rewritten into control
	 * bytes: chips belong to keystrokes, and this path encodes none of them.
	 */
	fun submitPastedText(text: String): Boolean {
		if (!PasteEncoder.fits(text)) {
			reportUnavailable(InputUnavailableReason.PASTE_TOO_LARGE)
			return false
		}
		// The committed frame's own modes decide the wrapping, so a paste can never
		// be encoded against a publish that has not been drawn yet.
		val committed = currentInputReceipt() ?: return false
		val packet = PasteEncoder.encode(text, committed.modes.bracketedPaste) ?: run {
			reportUnavailable(InputUnavailableReason.ENCODER_REFUSED)
			return false
		}
		listener?.onInput(NativeIoInputKind.PASTE, packet, committed)
		return true
	}

	/**
	 * Focus the surface and ask the platform to show the soft keyboard.
	 *
	 * This is the explicit interaction a host screen calls when it wants the keyboard
	 * up; beyond a tap on itself the surface never raises one. True means the request
	 * reached the window's inset controller, not that a keyboard is on screen — only
	 * the platform decides that, and nothing here claims otherwise.
	 */
	fun openKeyboard(): Boolean {
		if (!attachedToWindow) return false
		if (!requestFocus()) return false
		val controller = windowInsetsController ?: return false
		controller.show(WindowInsets.Type.ime())
		return true
	}

	/**
	 * Send exactly [key] against the committed frame, and report whether it left.
	 *
	 * This is the public door for the keys a phone screen has to offer itself —
	 * Escape, Tab, the arrows, a function key — because a soft keyboard does not have
	 * them. The keystroke travels the same route as one the input method forwarded:
	 * the same fence, the modes recorded on the committed frame, the owner's own
	 * encoder, and [TerminalSurfaceListener.onInput] carrying the receipt that names
	 * the pixels it was typed against.
	 *
	 * [key] means exactly what the caller passed. Latched modifier chips are not
	 * folded in here, because the caller can see them with
	 * [selectedMobileModifiers] and a bar button that composes its own keystroke is
	 * the caller's decision, not a surprise the surface adds. Chips do fold into the
	 * text, Enter, and backspace the input method commits.
	 *
	 * False means nothing left and nothing is queued: the surface never holds a
	 * keystroke back for a frame it has not drawn yet, and it never reports a
	 * delivery it did not make. Why is reported through
	 * [TerminalSurfaceListener.onInputUnavailable], and a keystroke the owner's
	 * encoder refuses — every spelling of Ctrl+Z, among them — stays refused.
	 */
	fun submitKey(key: TerminalKey): Boolean = submitEncodedKey(key, quietOnRefusal = false)

	/**
	 * Hold exactly the modifier chips in [modifiers], from [SUPPORTED_MOBILE_MODIFIERS].
	 *
	 * The chips are not keystrokes: nothing is sent here, and what a chip does is
	 * change how the next committed text, Enter, or backspace is encoded. False, with
	 * nothing changed, when the request names a bit this surface does not offer — a
	 * half-applied latch would show a chip that lies about what it is doing.
	 *
	 * The change is reported through [TerminalSurfaceListener.onMobileModifiersChanged]
	 * so a root screen and the surface cannot drift apart.
	 */
	fun setMobileModifiers(modifiers: Int): Boolean {
		val before = mobileModifiers.modifiers
		if (!mobileModifiers.set(modifiers)) return false
		if (mobileModifiers.modifiers != before) reportMobileModifiers()
		return true
	}

	/** Flip the chips in [bits] on or off, under the same rules as [setMobileModifiers]. */
	fun toggleMobileModifier(bits: Int): Boolean {
		val before = mobileModifiers.modifiers
		if (!mobileModifiers.toggle(bits)) return false
		if (mobileModifiers.modifiers != before) reportMobileModifiers()
		return true
	}

	/**
	 * Let go of every chip.
	 *
	 * True when one was held. The surface also does this on its own whenever the
	 * target changes or the surface leaves the foreground, so a Ctrl meant for one
	 * session never arrives at the next.
	 */
	fun clearMobileModifiers(): Boolean {
		if (!mobileModifiers.clear()) return false
		reportMobileModifiers()
		return true
	}

	/** The chips being held, a subset of [SUPPORTED_MOBILE_MODIFIERS]. */
	fun selectedMobileModifiers(): Int = mobileModifiers.modifiers

	/** Close the image decode thread. The surface stays usable for text. */
	fun release() {
		publishedProof.retire()
		imageDecoder?.close()
		imageDecoder = null
		clearImages()
	}

	/* -------------------------------------------------------------------- *
	 * View lifecycle
	 * -------------------------------------------------------------------- */

	override fun onAttachedToWindow() {
		super.onAttachedToWindow()
		attachedToWindow = true
		watcher = FrameCommitWatcher(this) { drawEpoch -> handleFrameCommit(drawEpoch) }
		drawObserver = viewTreeObserver.also { it.addOnPreDrawListener(beforeDraw) }
		if (imageDecoder == null) imageDecoder = TerminalImageDecoder()
		recomputeMetrics()
	}

	override fun onDetachedFromWindow() {
		publishedProof.retire()
		attachedToWindow = false
		drawObserver?.takeIf { it.isAlive }?.removeOnPreDrawListener(beforeDraw)
		drawObserver = null
		pendingDraw = null
		watcher?.cancel()
		watcher = null
		retireInputConnection()
		clearMobileModifiersForTarget()
		imageDecoder?.close()
		imageDecoder = null
		retireCommit(InputUnavailableReason.DETACHED)
		clearImages()
		super.onDetachedFromWindow()
	}

	override fun onVisibilityAggregated(isVisible: Boolean) {
		super.onVisibilityAggregated(isVisible)
		if (!isVisible) {
			publishedProof.retire()
			// Hidden pixels cannot be attested to, and a composition left behind by
			// the input method must not survive into the next time this is shown.
			retireCommit(InputUnavailableReason.NOT_VISIBLE)
			retireInputConnection()
			clearMobileModifiersForTarget()
		} else {
			scheduleDraw()
		}
	}

	override fun onWindowVisibilityChanged(visibility: Int) {
		super.onWindowVisibilityChanged(visibility)
		if (visibility != VISIBLE) {
			publishedProof.retire()
			retireCommit(InputUnavailableReason.NOT_VISIBLE)
			retireInputConnection()
			clearMobileModifiersForTarget()
		} else {
			scheduleDraw()
		}
	}

	override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
		super.onWindowFocusChanged(hasWindowFocus)
		if (!hasWindowFocus) {
			publishedProof.retire()
			// Another window is on top: the pixels last drawn may be covered, and a
			// composition the input method still holds belongs to the other window.
			retireCommit(InputUnavailableReason.NOT_VISIBLE)
			retireInputConnection()
			// Same reason for a chip: whatever comes next may be for another app.
			clearMobileModifiersForTarget()
		} else {
			scheduleDraw()
		}
	}

	override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
		super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
		if (!gainFocus) {
			publishedProof.retire()
			retireCommit(InputUnavailableReason.NOT_FOCUSED)
			retireInputConnection()
			clearMobileModifiersForTarget()
		} else {
			scheduleDraw()
		}
	}

	override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
		super.onConfigurationChanged(newConfig)
		// A configuration change can swap font resources and insets, so the grid the
		// input method is composing against may change underneath it.
		retireInputConnection()
		recomputeMetrics()
	}

	override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
		super.onSizeChanged(width, height, oldWidth, oldHeight)
		updateGrid()
	}

	/* -------------------------------------------------------------------- *
	 * Measurement
	 * -------------------------------------------------------------------- */

	private fun recomputeMetrics() {
		cellWidthPx = 0
		cellHeightPx = 0
		updateGrid()
	}

	private fun updateGrid() {
		// Any viewport change retires the frame and the input method's connection,
		// including a resize too small to change the cell counts: the composition
		// the keyboard holds belongs to the geometry it was told about, and a
		// connection left alive across a resize could finish it against a newer
		// receipt.
		retireCommit(InputUnavailableReason.LAYOUT_RETIRED)
		retireInputConnection()
		val innerWidth = (width.toLong() - paddingStart - paddingEnd).coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
		val innerHeight = (height.toLong() - paddingTop - paddingBottom).coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
		val fitted = AdaptiveTerminalGrid.measure(innerWidth, innerHeight, preferredTextSizePx, paints::measureFont)
		cellWidthPx = fitted?.cell?.widthPx ?: 0
		cellHeightPx = fitted?.cell?.heightPx ?: 0
		if (fitted != null) paints.measureFont(fitted.textSizePx) // Restore the actual winning paint.
		val cols = fitted?.columns ?: 0
		val rows = fitted?.rows ?: 0
		if (cols != requestedCols || rows != requestedRows) {
			requestedCols = cols
			requestedRows = rows
			if (cols > 0 && rows > 0) listener?.onViewportRequested(cols, rows)
		}
		applyFrame()
	}

	/* -------------------------------------------------------------------- *
	 * Frame handling
	 * -------------------------------------------------------------------- */

	private fun applyFrame() {
		// Every path through here ends with the previous commit no longer standing, so
		// the published proof goes first. Only an actual platform commit restores it.
		publishedProof.retire()
		pendingDraw = null
		watcher?.cancel()
		val current = binding
		if (current == null) {
			layout = null
			geometry = null
			receipt = null
			frameRejected = false
			clearImages()
			gate.invalidateLayout()
			invalidate()
			return
		}
		// Checked here rather than only when a binding is installed: attachment and
		// resizing reach this path too, and a binding whose non-null source contradicts
		// its own owner run or owner row must never be laid out, drawn, or made
		// input-eligible by a later pass.
		//
		// A publish that states no source at all is the other case, and it is drawn in
		// full: the frame, its geometry, and the modes recorded on it are everything
		// layout needs, so a missing source denies input and never the frame itself.
		if (InputSourceFence.state(current.source, current.ownerRun, current.rowId) ==
			InputSourceState.CONTRADICTORY
		) {
			layout = null
			geometry = null
			receipt = null
			frameRejected = true
			clearImages()
			gate.invalidateLayout()
			watcher?.cancel()
			reportUnavailable(InputUnavailableReason.BINDING_RETIRED)
			invalidate()
			return
		}
		if (requestedCols <= 0 || requestedRows <= 0) {
			layout = null
			geometry = null
			receipt = null
			invalidate()
			return
		}
		val laidOut = TerminalCellLayout.layout(current.frame, requestedCols, requestedRows)
		if (laidOut == null) {
			layout = null
			geometry = null
			receipt = null
			frameRejected = true
			clearImages()
			gate.invalidateLayout()
			reportUnavailable(InputUnavailableReason.FRAME_REJECTED)
			invalidate()
			return
		}
		frameRejected = false
		layout = laidOut
		geometry = CellGeometry(
			originX = paddingStart,
			originY = paddingTop,
			cellWidthPx = cellWidthPx,
			cellHeightPx = cellHeightPx,
			columns = laidOut.drawnColumns,
			rows = laidOut.drawnRows,
		)
		receipt = null
		gate.invalidateLayout()
		prepareImages(current.frame)
		scheduleDraw()
	}

	private fun scheduleDraw() {
		if (!attachedToWindow) return
		invalidate()
	}

	/** Register before ViewRootImpl captures callbacks, not during display-list drawing. */
	private fun prepareDrawCommit() {
		if (!syncEligibility().isEligible) {
			retireDraw(FrameInvalidationReason.LIFECYCLE_SUSPENDED)
			return
		}
		// Unrelated root traversals must not supersede a captured callback for the
		// same pixels. Binding/layout/lifecycle changes explicitly retire this request.
		if (pendingDraw != null || receipt != null) return
		val current = binding ?: return
		val laidOut = layout ?: return
		val cellGeometry = geometry ?: return
		if (laidOut.rows.isEmpty() || pendingImageIds.isNotEmpty()) return
		val commitWatcher = watcher?.takeIf { it.isCommitReportingAvailable } ?: return
		pendingDraw = DrawCandidate(
			gate.beginDraw(), current, laidOut, cellGeometry,
			gate.currentBindingEpoch, gate.currentLayoutEpoch,
		).also { commitWatcher.awaitCommit(it.epoch) }
		// A root traversal alone is not evidence this View drew. Force its display
		// list to be recorded in this pass; only onDraw can mark the candidate drawn.
		invalidate()
	}

	private fun isCurrent(candidate: DrawCandidate): Boolean =
		pendingDraw === candidate && binding === candidate.binding &&
			layout === candidate.layout && geometry === candidate.geometry &&
			gate.currentBindingEpoch == candidate.bindingEpoch &&
			gate.currentLayoutEpoch == candidate.layoutEpoch

	override fun onDraw(canvas: Canvas) {
		val saved = canvas.save()
		try {
			// AndroidView may lend us a Canvas with the parent's clip. In particular,
			// drawColor fills that entire clip unless we bound it to our own pane.
			canvas.clipRect(0, 0, width, height)
			drawFrame(canvas)
		} finally {
			canvas.restoreToCount(saved)
		}
	}

	private fun drawFrame(canvas: Canvas) {
		super.onDraw(canvas)
		canvas.drawColor(defaultBackgroundColor)
		val laidOut = layout ?: return
		val cellGeometry = geometry ?: return
		if (laidOut.rows.isEmpty()) return
		val candidate = pendingDraw
		// Backgrounds first, then the graphics layer, then glyphs: a placement must
		// not be painted over by the cell backgrounds it sits on, while text still
		// reads on top of an image the way the owner's compositor intends.
		drawCellBackgrounds(canvas, laidOut, cellGeometry)
		drawGraphics(canvas, cellGeometry)
		drawGlyphs(canvas, laidOut, cellGeometry)
		drawCursor(canvas, laidOut, cellGeometry)
		if (pendingImageIds.isNotEmpty()) {
			// A visible image is still decoding, so this pass showed neither the
			// image nor its fallback. Acknowledging it would claim a complete frame
			// was presented, so the pass earns nothing: the decode callback
			// invalidates, and the next pass — with the image drawn, or the fallback
			// standing in honestly — is the one that can be attested to.
			retireDraw(FrameInvalidationReason.FRAME_INCOMPLETE)
			return
		}
		if (candidate != null && isCurrent(candidate) && syncEligibility().isEligible) {
			candidate.drawn = true
		}
	}

	private fun handleFrameCommit(drawEpoch: Long) {
		val candidate = pendingDraw ?: return
		if (candidate.epoch != drawEpoch || !candidate.drawn || !isCurrent(candidate)) {
			retireDraw(FrameInvalidationReason.FRAME_INCOMPLETE)
			return
		}
		pendingDraw = null
		// A commit is only attested when the surface is eligible right now. A pass
		// that landed while hidden, unfocused, or suspended records nothing, so
		// resuming input cannot hand back a receipt drawn during the suspension: the
		// surface has to be drawn again, while eligible, to earn one.
		val record = gate.onFrameCommit(drawEpoch, syncEligibility().isEligible)
		if (record == null) {
			// Nothing is attested by this pass. Retire rather than leave an older proof
			// standing behind pixels nobody confirmed.
			publishedProof.retire()
			return
		}
		val current = binding ?: run {
			publishedProof.retire()
			return
		}
		val laidOut = layout ?: return
		val cellGeometry = geometry ?: return
		val newReceipt = FrameCommitReceipt(
			hostId = current.hostId,
			connectionGeneration = current.connectionGeneration,
			selectionGeneration = current.selectionGeneration,
			subscriptionId = current.subscriptionId,
			ownerRun = current.ownerRun,
			rowId = current.rowId,
			publishSequence = current.publishSequence,
			geometry = current.geometry,
			source = current.source,
			modes = current.modes,
			policyGeneration = current.policyGeneration,
			frameCols = laidOut.frameCols,
			frameRows = laidOut.frameRows,
			drawnColumns = laidOut.drawnColumns,
			drawnRows = laidOut.drawnRows,
			contentRect = cellGeometry.contentRect,
			bindingEpoch = record.bindingEpoch,
			layoutEpoch = record.layoutEpoch,
			drawEpoch = record.drawEpoch,
			commitSequence = record.commitSequence,
		)
		receipt = newReceipt
		// Published before the listener hears about it: this is what a writer thread
		// on the other side of that callback checks. A display-only commit is never
		// published, so a source-less frame leaves no proof behind rather than a fake
		// one, while still being drawn and reported as a commit.
		if (newReceipt.authorizesInput) publishedProof.publish(newReceipt) else publishedProof.retire()
		listener?.onFrameCommitted(newReceipt)
	}

	private fun retireCommit(reason: InputUnavailableReason) {
		retireDraw(invalidationOf(reason))
	}

	private fun retireDraw(frameReason: FrameInvalidationReason) {
		publishedProof.retire()
		receipt = null
		gate.invalidateCommit(frameReason)
		pendingDraw = null
		watcher?.cancel()
	}

	private fun invalidationOf(reason: InputUnavailableReason): FrameInvalidationReason = when (reason) {
		InputUnavailableReason.BINDING_RETIRED -> FrameInvalidationReason.BINDING_CHANGED
		InputUnavailableReason.LAYOUT_RETIRED -> FrameInvalidationReason.LAYOUT_CHANGED
		InputUnavailableReason.POLICY_RETIRED -> FrameInvalidationReason.POLICY_STALE
		InputUnavailableReason.NOT_FOCUSED -> FrameInvalidationReason.FOCUS_LOST
		InputUnavailableReason.NOT_VISIBLE -> FrameInvalidationReason.HIDDEN
		InputUnavailableReason.DETACHED -> FrameInvalidationReason.DETACHED
		InputUnavailableReason.MODAL_SUSPENDED -> FrameInvalidationReason.MODAL_SUSPENDED
		InputUnavailableReason.USER_INPUT_DISABLED -> FrameInvalidationReason.USER_INPUT_DISABLED
		else -> FrameInvalidationReason.LIFECYCLE_SUSPENDED
	}

	/* -------------------------------------------------------------------- *
	 * Drawing
	 * -------------------------------------------------------------------- */

	/** Clip the canvas to the cells this viewport can actually show. */
	private fun clipToContent(canvas: Canvas, laidOut: TerminalLayout, cellGeometry: CellGeometry) {
		canvas.save()
		canvas.clipRect(
			cellGeometry.originX.toFloat(),
			cellGeometry.originY.toFloat(),
			(cellGeometry.originX + laidOut.drawnColumns * cellGeometry.cellWidthPx).toFloat(),
			(cellGeometry.originY + laidOut.drawnRows * cellGeometry.cellHeightPx).toFloat(),
		)
	}

	private fun drawCellBackgrounds(canvas: Canvas, laidOut: TerminalLayout, cellGeometry: CellGeometry) {
		val width = cellGeometry.cellWidthPx
		val height = cellGeometry.cellHeightPx
		clipToContent(canvas, laidOut, cellGeometry)
		for (row in laidOut.rows) {
			val rowTop = (cellGeometry.originY + row.row * height).toFloat()
			for (cell in row.cells) {
				val background = paints.colors(cell.style, defaultForegroundColor, defaultBackgroundColor).background ?: continue
				paints.blockPaint.color = background
				canvas.drawRect(
					(cellGeometry.originX + cell.column * width).toFloat(),
					rowTop,
					(cellGeometry.originX + cell.column * width + cell.span * width).toFloat(),
					rowTop + height.toFloat(),
					paints.blockPaint,
				)
			}
		}
		canvas.restore()
	}

	private fun drawGlyphs(canvas: Canvas, laidOut: TerminalLayout, cellGeometry: CellGeometry) {
		val width = cellGeometry.cellWidthPx
		val height = cellGeometry.cellHeightPx
		val baseline = -paints.textPaint.fontMetricsInt.ascent
		clipToContent(canvas, laidOut, cellGeometry)
		for (row in laidOut.rows) {
			val rowTop = (cellGeometry.originY + row.row * height).toFloat()
			for (cell in row.cells) {
				if (cell.style.invisible) continue
				val left = (cellGeometry.originX + cell.column * width).toFloat()
				paints.textPaint.color = paints.colors(cell.style, defaultForegroundColor, defaultBackgroundColor).foreground
				paints.textPaint.textSkewX = if (cell.style.italic) ITALIC_SKEW else 0f
				paints.textPaint.isFakeBoldText = cell.style.bold
				canvas.drawText(cell.text, left, rowTop + baseline, paints.textPaint)
				drawDecorations(canvas, cell, left, rowTop, width, height)
			}
		}
		canvas.restore()
	}

	private fun drawDecorations(canvas: Canvas, cell: TerminalCell, left: Float, rowTop: Float, width: Int, height: Int) {
		if (!cell.style.underline && !cell.style.strikethrough && !cell.style.overline) return
		val right = left + cell.span * width.toFloat()
		paints.rulePaint.color = paints.textPaint.color
		paints.rulePaint.strokeWidth = ruleWidth(height)
		val inset = minOf(UNDERLINE_INSET, height / 4f)
		if (cell.style.underline) {
			val y = rowTop + height - inset
			canvas.drawLine(left, y, right, y, paints.rulePaint)
		}
		if (cell.style.strikethrough) {
			val y = rowTop + height / 2f
			canvas.drawLine(left, y, right, y, paints.rulePaint)
		}
		if (cell.style.overline) {
			canvas.drawLine(left, rowTop + inset, right, rowTop + inset, paints.rulePaint)
		}
	}

	private fun drawCursor(canvas: Canvas, laidOut: TerminalLayout, cellGeometry: CellGeometry) {
		val cursor = laidOut.cursor ?: return
		val width = cellGeometry.cellWidthPx
		val height = cellGeometry.cellHeightPx
		val left = (cellGeometry.originX + cursor.column * width).toFloat()
		val top = (cellGeometry.originY + cursor.row * height).toFloat()
		if (hasFocus()) {
			paints.blockPaint.color = defaultForegroundColor
			canvas.drawRect(left, top, left + width.toFloat(), top + height.toFloat(), paints.blockPaint)
			return
		}
		paints.rulePaint.color = defaultForegroundColor
		paints.rulePaint.strokeWidth = ruleWidth(height)
		val half = paints.rulePaint.strokeWidth / 2f
		canvas.drawRect(left + half, top + half, left + width - half, top + height - half, paints.rulePaint)
	}

	/**
	 * Draw the graphics layer, giving each placement exactly one outcome.
	 *
	 * A placement whose image decoded is drawn; one whose decode is still running
	 * is left alone for a frame rather than shown twice; only the ones that
	 * genuinely cannot be shown — no payload, refused, bad, or over the surface's
	 * budget — get the frame's fallback. The owner ships fallbacks alongside
	 * successful placements too, so drawing every fallback would label working
	 * images as failures.
	 */
	private fun drawGraphics(canvas: Canvas, cellGeometry: CellGeometry) {
		val graphics = binding?.frame?.graphics ?: return
		val byImageId = HashMap<String, TerminalGraphicsImage>()
		for (image in graphics.images) byImageId[image.id] = image
		val shown = HashSet<String>()
		val waiting = HashSet<String>()
		val shownAnchors = HashSet<String>()
		val waitingAnchors = HashSet<String>()
		for (placement in graphics.placements) {
			val image = byImageId[placement.imageId] ?: continue
			// Nothing visible means nothing to draw and nothing to fall back for.
			val drawable = TerminalGraphicsGeometry.placement(
				placement = placement,
				imageWidthPx = image.widthPx,
				imageHeightPx = image.heightPx,
				geometry = cellGeometry,
			) ?: continue
			val anchor = anchorOf(placement.column, placement.row, placement.columns, placement.rows)
			val decoded = decodedImages[placement.imageId]
			if (decoded == null || decoded.generation != imageGeneration || decoded.bitmap.isRecycled) {
				if (placement.imageId in pendingImageIds) {
					waiting += placement.id
					waitingAnchors += anchor
				}
				continue
			}
			drawDecoded(canvas, decoded, image, drawable)
			shown += placement.id
			shownAnchors += anchor
		}
		// A fallback names the placement it stands for. Ids are the primary link;
		// the reserved cell anchor is honoured too, so a frame whose two id spaces
		// do not line up still cannot end up labelling a working image as a failure.
		for (fallback in graphics.fallbacks) {
			val anchor = anchorOf(fallback.column, fallback.row, fallback.columns, fallback.rows)
			if (fallback.id in shown || fallback.id in waiting) continue
			if (anchor in shownAnchors || anchor in waitingAnchors) continue
			drawFallback(canvas, cellGeometry, fallback)
		}
	}

	private fun anchorOf(column: Int, row: Int, columns: Int, rows: Int): String =
		"$column,$row,$columns,$rows"

	/**
	 * Blit the visible part of a decoded image.
	 *
	 * The source rectangle comes from the placement's crop and the viewport clip,
	 * in the original PNG's pixels, and is scaled into the downsampled bitmap —
	 * otherwise a cropped image would be stretched from its full frame instead of
	 * showing the part the owner asked for.
	 */
	private fun drawDecoded(
		canvas: Canvas,
		decoded: DecodedImage,
		image: TerminalGraphicsImage,
		drawable: DrawableImage,
	) {
		val destination = drawable.destination
		val scaleX = decoded.widthPx.toFloat() / image.widthPx.toFloat()
		val scaleY = decoded.heightPx.toFloat() / image.heightPx.toFloat()
		val source = Rect(
			(drawable.sourceLeft * scaleX).toInt().coerceIn(0, decoded.widthPx),
			(drawable.sourceTop * scaleY).toInt().coerceIn(0, decoded.heightPx),
			ceil((drawable.sourceLeft + drawable.sourceWidth) * scaleX).toInt().coerceIn(0, decoded.widthPx),
			ceil((drawable.sourceTop + drawable.sourceHeight) * scaleY).toInt().coerceIn(0, decoded.heightPx),
		)
		if (source.left >= source.right || source.top >= source.bottom) return
		canvas.save()
		canvas.clipRect(
			destination.left.toFloat(),
			destination.top.toFloat(),
			destination.right.toFloat(),
			destination.bottom.toFloat(),
		)
		canvas.drawBitmap(
			decoded.bitmap,
			source,
			Rect(destination.left, destination.top, destination.right, destination.bottom),
			null,
		)
		canvas.restore()
	}

	/**
	 * Draw the honest placeholder for a placement this build cannot show: an
	 * outlined box over the cells the owner reserved, labelled with what it was.
	 * Nothing about the image itself is invented.
	 */
	private fun drawFallback(canvas: Canvas, cellGeometry: CellGeometry, fallback: TerminalGraphicsFallback) {
		val left = cellGeometry.originX + (fallback.column + fallback.clip.leftColumns) * cellGeometry.cellWidthPx
		val top = cellGeometry.originY + (fallback.row + fallback.clip.topRows) * cellGeometry.cellHeightPx
		val right = cellGeometry.originX +
			(fallback.column + fallback.columns - fallback.clip.rightColumns) * cellGeometry.cellWidthPx
		val bottom = cellGeometry.originY +
			(fallback.row + fallback.rows - fallback.clip.bottomRows) * cellGeometry.cellHeightPx
		val rect = Rect(left, top, right, bottom)
		val content = cellGeometry.contentRect
		if (!rect.intersect(Rect(content.left, content.top, content.right, content.bottom))) return
		paints.rulePaint.color = defaultForegroundColor
		paints.rulePaint.strokeWidth = ruleWidth(cellGeometry.cellHeightPx)
		canvas.drawRect(rect.left.toFloat(), rect.top.toFloat(), rect.right.toFloat(), rect.bottom.toFloat(), paints.rulePaint)
		val label = StringBuilder(fallback.mimeType)
		if (fallback.widthPx != null && fallback.heightPx != null) {
			label.append(' ').append(fallback.widthPx).append('x').append(fallback.heightPx)
		}
		paints.textPaint.color = defaultForegroundColor
		paints.textPaint.textSkewX = 0f
		paints.textPaint.isFakeBoldText = false
		canvas.save()
		canvas.clipRect(rect.left.toFloat(), rect.top.toFloat(), rect.right.toFloat(), rect.bottom.toFloat())
		canvas.drawText(label.toString(), (rect.left + FALLBACK_PADDING).toFloat(), (rect.bottom - FALLBACK_PADDING).toFloat(), paints.textPaint)
		canvas.restore()
	}

	private fun prepareImages(frame: TerminalFrame) {
		clearImages()
		val decoder = imageDecoder ?: return
		val graphics = frame.graphics ?: return
		val cellGeometry = geometry ?: return
		if (graphics.placements.isEmpty()) return
		imageGeneration = decoder.nextGeneration()
		val generation = imageGeneration
		val byImageId = HashMap<String, TerminalGraphicsImage>()
		for (image in graphics.images) byImageId[image.id] = image
		// One decode per image id, sized to the largest visible placement that uses
		// it: repeated placements share the bitmap, and a placement that never
		// reaches the drawn content never asks for pixels at all.
		val targets = HashMap<String, IntArray>()
		for (placement in graphics.placements) {
			val image = byImageId[placement.imageId] ?: continue
			val visible = TerminalGraphicsGeometry.placement(
				placement = placement,
				imageWidthPx = image.widthPx,
				imageHeightPx = image.heightPx,
				geometry = cellGeometry,
			) ?: continue
			val target = targets[image.id]
			if (target == null) {
				targets[image.id] = intArrayOf(visible.destination.width, visible.destination.height)
			} else {
				target[0] = maxOf(target[0], visible.destination.width)
				target[1] = maxOf(target[1], visible.destination.height)
			}
		}
		for ((imageId, target) in targets) {
			val image = byImageId.getValue(imageId)
			pendingImageIds += imageId
			decoder.decode(
				generation = generation,
				imageId = imageId,
				base64 = image.base64,
				targetWidthPx = target[0],
				targetHeightPx = target[1],
			) { decoded -> onImageDecoded(generation, imageId, decoded) }
		}
	}

	private fun onImageDecoded(generation: Long, imageId: String, decoded: DecodedImage?) {
		if (generation != imageGeneration) {
			decoded?.bitmap?.recycle()
			return
		}
		pendingImageIds -= imageId
		if (decoded == null) {
			failedImageIds += imageId
			invalidate()
			return
		}
		// The surface-wide ceiling, not just the per-image one: a frame can carry
		// many placements, and retaining them all must not be able to get the client
		// killed. Over budget recycles the bitmap and lets the fallback show.
		if (!bitmapBudget.tryReserve(decoded.bitmap.byteCount.toLong())) {
			decoded.bitmap.recycle()
			failedImageIds += imageId
			invalidate()
			return
		}
		decodedImages[imageId] = decoded
		invalidate()
	}

	private fun clearImages() {
		val hadPending = pendingImageIds.isNotEmpty()
		for (decoded in decodedImages.values) decoded.bitmap.recycle()
		decodedImages.clear()
		bitmapBudget.releaseAll()
		pendingImageIds.clear()
		failedImageIds.clear()
		// A pass that withheld acknowledgment because a decode was outstanding can
		// only be acknowledged by a later one, so ask for it.
		if (hadPending) scheduleDraw()
	}

	/* -------------------------------------------------------------------- *
	 * Input
	 * -------------------------------------------------------------------- */

	override fun onCheckIsTextEditor(): Boolean = true

	override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
		// A new connection replaces the previous one outright: the old object must
		// stop delivering, or a stale one could commit latent text at the same epoch.
		activeConnection?.invalidate()
		val connection = TerminalInputConnection(this, inputConnectionEpoch)
		activeConnection = connection
		outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
			InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
			InputType.TYPE_TEXT_FLAG_MULTI_LINE
		outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
		outAttrs.initialSelStart = 0
		outAttrs.initialSelEnd = 0
		return connection
	}

	/**
	 * True while [connectionEpoch] is still the live input-method generation.
	 *
	 * The full eligibility predicate applies: a connection must stop delivering
	 * while the surface is hidden, unfocused, covered, or suspended, not only when
	 * its epoch was superseded.
	 */
	internal fun isConnectionCurrent(connectionEpoch: Long): Boolean =
		attachedToWindow && connectionEpoch == inputConnectionEpoch && syncEligibility().isEligible

	/**
	 * Send IME-committed text.
	 *
	 * An embedded newline from a soft keyboard means the Enter key, not a bare
	 * line feed: the text around it goes out as text and each newline goes out as
	 * Enter, so Enter, Ctrl+J, and Shift+Enter stay distinguishable the way the
	 * owner's own translation keeps them.
	 *
	 * A latched modifier chip folds into this commit: with a chip held, every Unicode
	 * scalar of the commit leaves as its own modified keystroke, and the commit is
	 * refused whole rather than half-delivered when any part of it has no spelling for
	 * this child. With no chip held, the text leaves as text exactly as before. Either
	 * way the whole commit is attributed to one receipt — the pixels the platform
	 * confirmed — and nothing is buffered for a frame not yet drawn.
	 */
	internal fun submitTypedText(text: String): Boolean {
		if (text.isEmpty()) return true
		if (ImeCommitEncoder.isOversized(text)) {
			// Whole-operation refusal, decided before anything is retained or encoded:
			// an oversized burst is not a commit, and none of it is sent.
			reportUnavailable(InputUnavailableReason.COMMIT_TOO_LARGE)
			return false
		}
		val committed = currentInputReceipt() ?: return false
		val packets = ImeCommitEncoder.encode(text, mobileModifiers.modifiers, committed.modes)
		if (packets == null) {
			// Truthful refusal: the whole commit is dropped and reported, never the
			// representable prefix of it.
			reportUnavailable(InputUnavailableReason.ENCODER_REFUSED)
			return false
		}
		return emitBatch(packets, committed)
	}

	/**
	 * Send [count] backspaces, or none at all.
	 *
	 * The batch is atomic for the same reason a commit is: a modified backspace this
	 * child cannot be given does not turn into a partial deletion of what the user
	 * asked to remove. A request beyond [ImeCommitEncoder.MAX_DELETION_REQUEST] is
	 * refused whole for the same reason — the deletions the owner can carry are sent,
	 * and the rest is never quietly dropped on the floor while the caller is told true.
	 */
	internal fun submitBackspace(count: Int): Boolean {
		if (count <= 0) return false
		if (count > ImeCommitEncoder.MAX_DELETION_REQUEST) {
			reportUnavailable(InputUnavailableReason.COMMIT_TOO_LARGE)
			return false
		}
		val committed = currentInputReceipt() ?: return false
		val packets = ImeCommitEncoder.encodeBackspaces(count, mobileModifiers.modifiers, committed.modes)
		if (packets == null) {
			reportUnavailable(InputUnavailableReason.ENCODER_REFUSED)
			return false
		}
		return emitBatch(packets, committed)
	}

	/** Send one Enter, with any latched chip folded in, against the committed frame. */
	internal fun submitEnter(): Boolean {
		val committed = currentInputReceipt() ?: return false
		val packet = ImeCommitEncoder.encodeEnter(mobileModifiers.modifiers, committed.modes)
		if (packet == null) {
			reportUnavailable(InputUnavailableReason.ENCODER_REFUSED)
			return false
		}
		listener?.onInput(NativeIoInputKind.KEYBOARD, packet, committed)
		return true
	}

	/**
	 * Carry one physical key event through, from whichever route it arrived.
	 *
	 * A key with a canonical spelling — functional, keypad, control, or printable
	 * under Ctrl, Alt, Meta, or Super — is encoded as that keystroke, because its
	 * meaning has to survive: on the text path Ctrl+C becomes plain text, or the
	 * keyboard's own copy gesture, rather than the byte the child is waiting for.
	 *
	 * An unmodified printable press is sent as text. Normally the input method takes
	 * those first, which is right: it owns dead keys, compose sequences, and Unicode
	 * entry. But an input method may decline a physical key, leaving Android to
	 * dispatch it straight to this view, and a plain View never turns such an event
	 * into committed text — so it is taken here rather than dropped. Only
	 * unmodified presses reach the text path, and both routes share one ledger so a
	 * press forwarded twice is typed once.
	 *
	 * [fromIme] says the input method forwarded the event rather than the platform
	 * dispatching it to this view. A forwarded event carries the platform's modifier
	 * bits only, which know nothing about the modifier chips the user is holding, so
	 * the chips are folded in: an IME-forwarded Enter or Backspace then means the same
	 * thing as the one the text path produces, instead of quietly losing the modifier
	 * the user is holding. A directly dispatched event already carries real hardware
	 * modifiers and is left exactly as it is.
	 */
	internal fun handleHardwareKey(event: KeyEvent, release: Boolean, fromIme: Boolean = false): Boolean {
		val key = hardwareKey(event, release, fromIme)
		if (key != null) {
			if (alreadyDelivered(event)) return true
			submitEncodedKey(key, quietOnRefusal = key.eventType == TerminalKeyEventType.RELEASE)
			return true
		}
		if (release || event.action != KeyEvent.ACTION_DOWN ||
			hardwareModifiers(event) and HardwareKeys.CONTROL_BEARING_MASK != 0
		) {
			return false
		}
		val text = KeyboardEncoder.textOfScalar(event.unicodeChar) ?: return false
		if (alreadyDelivered(event)) return true
		return submitTypedText(text)
	}

	private fun alreadyDelivered(event: KeyEvent): Boolean = deliveredKeys.alreadyDelivered(
		downTime = event.downTime,
		keyCode = event.keyCode,
		action = event.action,
		repeatCount = event.repeatCount,
	)

	private fun submitEncodedKey(key: TerminalKey, quietOnRefusal: Boolean): Boolean {
		val committed = currentInputReceipt() ?: return false
		val packet = KeyboardEncoder.encode(key, committed.modes)
		if (packet == null) {
			// A key release the child never asked for is not a fault: only the
			// encoder knows which event types the negotiated modes support.
			if (!quietOnRefusal) reportUnavailable(InputUnavailableReason.ENCODER_REFUSED)
			return false
		}
		listener?.onInput(NativeIoInputKind.KEYBOARD, packet, committed)
		return true
	}

	override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
		if (handleHardwareKey(event, release = false)) return true
		return super.onKeyDown(keyCode, event)
	}

	override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
		if (handleHardwareKey(event, release = true)) return true
		return super.onKeyUp(keyCode, event)
	}

	override fun onKeyMultiple(keyCode: Int, repeatCount: Int, event: KeyEvent): Boolean {
		if (handleHardwareKey(event, release = false)) return true
		return super.onKeyMultiple(keyCode, repeatCount, event)
	}

	private fun hardwareKey(event: KeyEvent, release: Boolean, fromIme: Boolean): TerminalKey? {
		val modifiers =
			if (fromIme) mobileModifiers.fold(hardwareModifiers(event)) else hardwareModifiers(event)
		val eventType = when {
			release -> TerminalKeyEventType.RELEASE
			event.repeatCount > 0 -> TerminalKeyEventType.REPEAT
			else -> TerminalKeyEventType.PRESS
		}
		FUNCTION_KEYS[event.keyCode]?.let {
			return TerminalKey(functionKey = it, modifiers = modifiers, eventType = eventType)
		}
		KEYPAD_CODEPOINTS[event.keyCode]?.let {
			return TerminalKey(codepoint = it, modifiers = modifiers, eventType = eventType)
		}
		CONTROL_KEYS[event.keyCode]?.let {
			return TerminalKey(codepoint = it, modifiers = modifiers, eventType = eventType)
		}
		if (modifiers and HardwareKeys.CONTROL_BEARING_MASK == 0) return null
		return HardwareKeys.printableKey(hardwareFacts(event, modifiers, eventType))
	}

	/**
	 * What the platform's key map says this physical key produces.
	 *
	 * The identity is the key map's answer with no modifiers applied, and the shift
	 * answer is kept separately as the alternate. The event's own character is
	 * deliberately not consulted: it folds the modifiers that were held, so
	 * Ctrl+Shift+/ would arrive as "?" and Ctrl+Shift+J as an uppercase letter,
	 * losing both the key the user pressed and the modifier mask that explains it.
	 * It is the key map — not a table of key codes — that decides what a Cyrillic,
	 * Greek, or shifted-symbol layout actually types.
	 */
	private fun hardwareFacts(
		event: KeyEvent,
		modifiers: Int,
		eventType: TerminalKeyEventType,
	): HardwareKeyFacts = HardwareKeys.facts(
		unmodifiedUnicodeChar = event.getUnicodeChar(0),
		shiftedUnicodeChar = event.getUnicodeChar(KeyEvent.META_SHIFT_ON),
		modifiers = modifiers,
		eventType = eventType,
		baseLayoutCodepoint = PRINTABLE_BASE_CODES[event.keyCode],
	)

	private fun hardwareModifiers(event: KeyEvent): Int {
		var modifiers = 0
		if (event.isShiftPressed) modifiers = modifiers or KeyboardModifiers.SHIFT
		if (event.isAltPressed) modifiers = modifiers or KeyboardModifiers.ALT
		if (event.isCtrlPressed) modifiers = modifiers or KeyboardModifiers.CTRL
		if (event.isMetaPressed) modifiers = modifiers or KeyboardModifiers.META
		if (event.isCapsLockOn) modifiers = modifiers or KeyboardModifiers.CAPS_LOCK
		if (event.isNumLockOn) modifiers = modifiers or KeyboardModifiers.NUM_LOCK
		return modifiers
	}

	override fun onTouchEvent(event: MotionEvent): Boolean {
		if (!event.isFromSource(InputDevice.SOURCE_TOUCHSCREEN)) return super.onTouchEvent(event)
		when (event.actionMasked) {
			MotionEvent.ACTION_DOWN -> {
				// A tap on the terminal means the user wants to type, so it takes
				// focus and raises the keyboard whether or not the child asked for
				// mouse events. A tap the child does not track consumes the gesture
				// without emitting an unsolicited report.
				openKeyboard()
				return pointerAt(event, button = 0, release = false) || super.onTouchEvent(event)
			}
			MotionEvent.ACTION_MOVE -> return pointerAt(event, button = 0, release = false, motion = true)
			MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
				return pointerAt(event, button = 3, release = true) || super.onTouchEvent(event)
			else -> return super.onTouchEvent(event)
		}
	}

	override fun onGenericMotionEvent(event: MotionEvent): Boolean {
		if (event.isFromSource(InputDevice.SOURCE_MOUSE)) {
			when (event.action) {
				MotionEvent.ACTION_SCROLL -> {
					val up = event.getAxisValue(MotionEvent.AXIS_VSCROLL) > 0f
					return pointerAt(event, button = if (up) 64 else 65, release = false, wheel = true)
				}
				MotionEvent.ACTION_BUTTON_PRESS, MotionEvent.ACTION_BUTTON_RELEASE -> {
					val release = event.action == MotionEvent.ACTION_BUTTON_RELEASE
					if (hasButton(event, MotionEvent.BUTTON_SECONDARY)) return pointerAt(event, button = 2, release = release)
					if (hasButton(event, MotionEvent.BUTTON_TERTIARY)) return pointerAt(event, button = 1, release = release)
					return false
				}
				else -> Unit
			}
		}
		return super.onGenericMotionEvent(event)
	}

	override fun onHoverEvent(event: MotionEvent): Boolean {
		if (event.isFromSource(InputDevice.SOURCE_MOUSE) &&
			pointerAt(event, button = 3, release = false, motion = true)
		) {
			return true
		}
		return super.onHoverEvent(event)
	}

	private fun pointerAt(
		event: MotionEvent,
		button: Int,
		release: Boolean,
		motion: Boolean = false,
		wheel: Boolean = false,
	): Boolean {
		val cellGeometry = geometry ?: return false
		val position = cellGeometry.cellOf(event.x, event.y)
		if (position == null) {
			if (!motion) reportUnavailable(InputUnavailableReason.POINTER_OUTSIDE_CONTENT)
			return false
		}
		return pointerReport(
			TerminalPointerEvent(
				button = if (motion) button or MOTION_BIT else button,
				column = position.column,
				row = position.row,
				release = release,
				motion = motion,
				wheel = wheel,
			),
		)
	}

	private fun pointerReport(pointer: TerminalPointerEvent): Boolean {
		val committed = currentInputReceipt() ?: return false
		if (!committed.covers(CellPosition(pointer.column, pointer.row))) {
			reportUnavailable(InputUnavailableReason.POINTER_OUTSIDE_CONTENT)
			return false
		}
		val packet = MouseEncoder.encode(pointer, committed.modes, committed.drawnColumns, committed.drawnRows)
		if (packet == null) {
			reportUnavailable(InputUnavailableReason.MOUSE_REPORTING_OFF)
			return false
		}
		listener?.onInput(NativeIoInputKind.MOUSE, packet, committed)
		return true
	}

	/**
	 * The receipt input may be attributed to, or null after reporting why not.
	 *
	 * Every fence is re-checked here rather than trusted from the last callback: a
	 * keystroke is only allowed against pixels the platform confirmed and that
	 * nothing has since replaced.
	 */
	private fun currentInputReceipt(): FrameCommitReceipt? {
		if (binding == null) {
			reportUnavailable(InputUnavailableReason.NOT_BOUND)
			return null
		}
		val blocked = syncEligibility().blockReason()
		if (blocked != null) {
			reportUnavailable(unavailableOf(blocked))
			return null
		}
		val commitWatcher = watcher
		if (commitWatcher == null || !commitWatcher.isCommitReportingAvailable) {
			reportUnavailable(InputUnavailableReason.COMMIT_REPORTING_UNAVAILABLE)
			return null
		}
		val committed = receipt
		if (committed == null) {
			reportUnavailable(
				if (frameRejected) InputUnavailableReason.FRAME_REJECTED else InputUnavailableReason.NO_COMMITTED_FRAME,
			)
			return null
		}
		if (!isBoundTo(committed)) {
			retireCommit(InputUnavailableReason.BINDING_RETIRED)
			return null
		}
		if (!gate.isCurrentBinding(committed.toRecord())) {
			retireCommit(InputUnavailableReason.BINDING_RETIRED)
			return null
		}
		if (committed.layoutEpoch != gate.currentLayoutEpoch) {
			retireCommit(InputUnavailableReason.LAYOUT_RETIRED)
			return null
		}
		if (!InputSourceFence.authorizesInput(committed.source)) {
			// The pixels are honest and the frame is complete; there is simply no
			// host-written source for a keystroke to be attributed to. Saying so is the
			// whole response: no source, no permission, and no stand-in receipt is
			// manufactured to get past this point.
			reportUnavailable(InputUnavailableReason.SOURCE_ABSENT)
			return null
		}
		if (!publishedProof.isCurrent(committed)) {
			// The display commit is not the published input proof, so nothing may be
			// attributed to it. This is a fail-closed net, not a normal path: every
			// retirement that could cause it already retired the proof with the frame.
			reportUnavailable(InputUnavailableReason.BINDING_RETIRED)
			return null
		}
		return committed
	}

	/** Mirror the live view state into the shared eligibility predicate. */
	private fun syncEligibility(): InputEligibility {
		eligibility.attached = attachedToWindow
		eligibility.viewVisible = visibility == VISIBLE && isShown
		eligibility.windowVisible = windowVisibility == VISIBLE
		eligibility.windowFocused = hasWindowFocus()
		eligibility.focused = hasFocus()
		return eligibility
	}

	private fun unavailableOf(reason: InputBlockReason): InputUnavailableReason = when (reason) {
		InputBlockReason.DETACHED -> InputUnavailableReason.DETACHED
		InputBlockReason.NOT_VISIBLE -> InputUnavailableReason.NOT_VISIBLE
		InputBlockReason.WINDOW_NOT_VISIBLE -> InputUnavailableReason.NOT_VISIBLE
		InputBlockReason.WINDOW_NOT_FOCUSED -> InputUnavailableReason.NOT_VISIBLE
		InputBlockReason.NOT_FOCUSED -> InputUnavailableReason.NOT_FOCUSED
		InputBlockReason.MODAL_SUSPENDED -> InputUnavailableReason.MODAL_SUSPENDED
		InputBlockReason.USER_INPUT_DISABLED -> InputUnavailableReason.USER_INPUT_DISABLED
	}

	/** True when [candidate] describes the binding this surface is showing now. */
	private fun isBoundTo(candidate: FrameCommitReceipt): Boolean {
		val current = binding ?: return false
		if (!current.sourceMatches()) return false
		// A source that moved — present to absent, absent to present, or one source
		// for another — is a different target for input even when every other field
		// still lines up, so the proof the earlier source carried stops being proof.
		if (!InputSourceFence.isSameSource(candidate.source, current.source)) return false
		return candidate.subscriptionId == current.subscriptionId &&
			candidate.hostId == current.hostId &&
			candidate.connectionGeneration == current.connectionGeneration &&
			candidate.selectionGeneration == current.selectionGeneration &&
			candidate.ownerRun == current.ownerRun &&
			candidate.rowId == current.rowId &&
			candidate.publishSequence == current.publishSequence &&
			candidate.policyGeneration == current.policyGeneration
	}

	/**
	 * Hand a prepared batch to the caller, one packet at a time, while the proof
	 * behind it stays current.
	 *
	 * The sink is the caller's own callback, and a caller is allowed to take the frame
	 * away from inside it — rebinding, suspending input, or installing a publish with
	 * no source. Continuing past that point would attribute the remaining packets to
	 * pixels this surface no longer stands behind, so the batch stops, the stop is
	 * reported, and the caller is told the batch did not complete.
	 */
	private fun emitBatch(packets: List<ByteArray>, committed: FrameCommitReceipt): Boolean {
		val delivered = InputBatchDelivery.emitInOrder(
			packets,
			stillCurrent = { proofStillCurrent(committed) },
			emit = { packet -> listener?.onInput(NativeIoInputKind.KEYBOARD, packet, committed) },
		)
		return delivered == packets.size
	}

	private fun proofStillCurrent(committed: FrameCommitReceipt): Boolean {
		if (publishedProof.isCurrent(committed)) return true
		// Whatever the cause, the frame this batch was attributed to is gone: the rest
		// of it is dropped rather than delivered against a retired proof.
		reportUnavailable(InputUnavailableReason.BINDING_RETIRED)
		return false
	}

	/** Report a burst too large for one commit, from a path that bounds it up front. */
	internal fun reportCommitTooLarge() {
		reportUnavailable(InputUnavailableReason.COMMIT_TOO_LARGE)
	}

	private fun reportUnavailable(reason: InputUnavailableReason) {
		listener?.onInputUnavailable(reason)
	}

	private fun reportMobileModifiers() {
		listener?.onMobileModifiersChanged(mobileModifiers.modifiers)
	}

	/**
	 * Let go of every latched chip because the surface can no longer say what they
	 * were meant for: another session, connection, native tuple, or source state took
	 * over, the surface left the foreground or the focus, or a modal came and went.
	 *
	 * Only a change the user could see is reported, and only the chips are dropped: the
	 * frame stays on screen, and a later publish of the same target never reaches here.
	 */
	private fun clearMobileModifiersForTarget() {
		if (mobileModifiers.clear()) reportMobileModifiers()
	}

	private fun retireInputConnection() {
		inputConnectionEpoch += 1
		val connection = activeConnection
		activeConnection = null
		if (connection != null) {
			connection.invalidate()
			context.getSystemService(InputMethodManager::class.java)?.restartInput(this)
		}
	}

	private fun hasButton(event: MotionEvent, button: Int): Boolean = (event.buttonState and button) != 0

	private fun ruleWidth(cellHeight: Int): Float = (cellHeight / RULE_DIVISOR).toFloat().coerceAtLeast(1f)

	companion object {
		/**
		 * The modifier bits a root screen may hold as chips: Ctrl, Alt, and Shift.
		 *
		 * Anything else has no phone-side spelling, so it is never offered, latched,
		 * or reported.
		 */
		const val SUPPORTED_MOBILE_MODIFIERS = MobileModifierLatch.SUPPORTED

		private const val DEFAULT_FOREGROUND = 0xFFE8E8E8.toInt()
		private const val DEFAULT_BACKGROUND = 0xFF101010.toInt()
		private const val ITALIC_SKEW = -0.25f
		private const val UNDERLINE_INSET = 3f
		private const val RULE_DIVISOR = 12
		private const val FALLBACK_PADDING = 4
		private const val MAX_SURFACE_BITMAP_BYTES = 32L * 1024 * 1024
		private const val LOWER_A = 97
		private const val MOTION_BIT = 32

		private val FUNCTION_KEYS: Map<Int, TerminalFunctionKey> = mapOf(
			KeyEvent.KEYCODE_DPAD_UP to TerminalFunctionKey.UP,
			KeyEvent.KEYCODE_DPAD_DOWN to TerminalFunctionKey.DOWN,
			KeyEvent.KEYCODE_DPAD_LEFT to TerminalFunctionKey.LEFT,
			KeyEvent.KEYCODE_DPAD_RIGHT to TerminalFunctionKey.RIGHT,
			KeyEvent.KEYCODE_MOVE_HOME to TerminalFunctionKey.HOME,
			KeyEvent.KEYCODE_MOVE_END to TerminalFunctionKey.END,
			KeyEvent.KEYCODE_PAGE_UP to TerminalFunctionKey.PAGE_UP,
			KeyEvent.KEYCODE_PAGE_DOWN to TerminalFunctionKey.PAGE_DOWN,
			KeyEvent.KEYCODE_INSERT to TerminalFunctionKey.INSERT,
			KeyEvent.KEYCODE_FORWARD_DEL to TerminalFunctionKey.DELETE,
			KeyEvent.KEYCODE_F1 to TerminalFunctionKey.F1,
			KeyEvent.KEYCODE_F2 to TerminalFunctionKey.F2,
			KeyEvent.KEYCODE_F3 to TerminalFunctionKey.F3,
			KeyEvent.KEYCODE_F4 to TerminalFunctionKey.F4,
			KeyEvent.KEYCODE_F5 to TerminalFunctionKey.F5,
			KeyEvent.KEYCODE_F6 to TerminalFunctionKey.F6,
			KeyEvent.KEYCODE_F7 to TerminalFunctionKey.F7,
			KeyEvent.KEYCODE_F8 to TerminalFunctionKey.F8,
			KeyEvent.KEYCODE_F9 to TerminalFunctionKey.F9,
			KeyEvent.KEYCODE_F10 to TerminalFunctionKey.F10,
			KeyEvent.KEYCODE_F11 to TerminalFunctionKey.F11,
			KeyEvent.KEYCODE_F12 to TerminalFunctionKey.F12,
		)

		private val KEYPAD_CODEPOINTS: Map<Int, Int> = mapOf(
			KeyEvent.KEYCODE_NUMPAD_0 to 57399,
			KeyEvent.KEYCODE_NUMPAD_1 to 57400,
			KeyEvent.KEYCODE_NUMPAD_2 to 57401,
			KeyEvent.KEYCODE_NUMPAD_3 to 57402,
			KeyEvent.KEYCODE_NUMPAD_4 to 57403,
			KeyEvent.KEYCODE_NUMPAD_5 to 57404,
			KeyEvent.KEYCODE_NUMPAD_6 to 57405,
			KeyEvent.KEYCODE_NUMPAD_7 to 57406,
			KeyEvent.KEYCODE_NUMPAD_8 to 57407,
			KeyEvent.KEYCODE_NUMPAD_9 to 57408,
			KeyEvent.KEYCODE_NUMPAD_DOT to 57409,
			KeyEvent.KEYCODE_NUMPAD_DIVIDE to 57410,
			KeyEvent.KEYCODE_NUMPAD_MULTIPLY to 57411,
			KeyEvent.KEYCODE_NUMPAD_SUBTRACT to 57412,
			KeyEvent.KEYCODE_NUMPAD_ADD to 57413,
			KeyEvent.KEYCODE_NUMPAD_ENTER to 57414,
			KeyEvent.KEYCODE_NUMPAD_EQUALS to 57415,
			KeyEvent.KEYCODE_NUMPAD_COMMA to 57416,
		)

		/**
		 * Base-layout identity of physical keys with a printable character.
		 *
		 * Metadata only, never the character to send: what a key types comes from the
		 * device key map. This table lets the encoder keep refusals such as Ctrl+Z
		 * intact on a layout where the same key reads as something else.
		 */
		private val PRINTABLE_BASE_CODES: Map<Int, Int> =
			(0 until 26).associate { KeyEvent.KEYCODE_A + it to LOWER_A + it } +
				(0 until 10).associate { KeyEvent.KEYCODE_0 + it to 48 + it } +
				mapOf(
					KeyEvent.KEYCODE_SPACE to 32,
					KeyEvent.KEYCODE_MINUS to 45,
					KeyEvent.KEYCODE_EQUALS to 61,
					KeyEvent.KEYCODE_LEFT_BRACKET to 91,
					KeyEvent.KEYCODE_RIGHT_BRACKET to 93,
					KeyEvent.KEYCODE_SEMICOLON to 59,
					KeyEvent.KEYCODE_APOSTROPHE to 39,
					KeyEvent.KEYCODE_COMMA to 44,
					KeyEvent.KEYCODE_PERIOD to 46,
					KeyEvent.KEYCODE_SLASH to 47,
					KeyEvent.KEYCODE_BACKSLASH to 92,
					KeyEvent.KEYCODE_GRAVE to 96,
				)

		private val CONTROL_KEYS: Map<Int, Int> = mapOf(
			KeyEvent.KEYCODE_ENTER to 13,
			KeyEvent.KEYCODE_TAB to 9,
			KeyEvent.KEYCODE_ESCAPE to 27,
			KeyEvent.KEYCODE_DEL to 127,
		)
	}
}

/** The commit epochs a receipt carries, as the gate sees them. */
private fun FrameCommitReceipt.toRecord(): FrameCommitRecord = FrameCommitRecord(
		bindingEpoch = bindingEpoch,
		layoutEpoch = layoutEpoch,
		drawEpoch = drawEpoch,
		commitSequence = commitSequence,
	)
