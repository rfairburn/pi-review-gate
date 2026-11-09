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
import io.github.rfairburn.pireviewgate.core.input.TouchGesturePhase
import io.github.rfairburn.pireviewgate.core.input.TouchPointer
import io.github.rfairburn.pireviewgate.core.input.TouchWheelSteps
import io.github.rfairburn.pireviewgate.core.input.TwoFingerWheelGesture
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
 *  - touch: one finger is the existing press, drag, and release; a two-finger
 *    vertical swipe is the owner's own mouse wheel, one report per measured cell
 *    of travel, attributed to the input proof standing when the swipe began;
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
 * Ordinary output is not one of those changes. A newer binding in the same input
 * context ([TerminalViewBinding.sameInputContextAs]) is drawn, and may earn newer
 * display commits, while the input proof the platform genuinely committed for that
 * context keeps standing; only a genuine context, layout, or lifecycle change
 * retires it.
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
	private val publishedProof = InputProofPublication<CommittedInputProof>()

	/**
	 * The input proof standing for one input context.
	 *
	 * [anchor] is the first genuine platform commit of the context, and every
	 * keystroke is attributed to it. [latest] is the newest genuine commit of the same
	 * context, so a caller holding the receipt it was just told about can verify it.
	 * A newer same-context commit replaces [latest] in one atomic publication and never
	 * replaces [anchor], so a write queued against the anchor survives ordinary output
	 * and newer display commits alike; any retirement drops both at once.
	 */
	private data class CommittedInputProof(val anchor: FrameCommitReceipt, val latest: FrameCommitReceipt)

	private var activeConnection: TerminalInputConnection? = null
	private var inputConnectionEpoch = 0L

	/** Pointer bookkeeping for the two-finger wheel; one finger keeps its existing path. */
	private val touchGesture = TwoFingerWheelGesture()

	/**
	 * The input proof's anchor standing when the current touch gesture's first finger
	 * came down, or null when none stood. Every report the gesture makes — its drag,
	 * its release, the release ending it before a wheel, and the wheel itself — is
	 * attributed to exactly this anchor or not sent at all; a gesture that began with
	 * no proof never reports, even after a fresh commit arrives.
	 */
	private var touchAnchor: FrameCommitReceipt? = null

	/** The cell the gesture's forwarded press first went out at, or null when it never did. */
	private var touchOriginCell: CellPosition? = null

	/** True once this gesture forwarded a real cross-cell motion report. */
	private var touchMotionForwarded = false

	/**
	 * The cell the gesture's motion was last reported at, or null when no press was
	 * forwarded. A tap keeps its original [touchOriginCell] here; a real cross-cell
	 * drag advances it, and the release ending a wheel names it.
	 */
	private var touchPressCell: CellPosition? = null

	/**
	 * What a two-finger wheel captured when it began: the standing input proof's
	 * anchor, the drawn geometry that anchor was committed with, and the cell every
	 * one of its reports names. A wheel step is only ever reported while all three
	 * are still exactly what the surface stands behind.
	 */
	private class TouchWheelLease(val anchor: FrameCommitReceipt, val geometry: CellGeometry, val cell: CellPosition)

	private var touchWheelLease: TouchWheelLease? = null

	init {
		// Every input path — hardware keys, the IME, mouse reports — needs focus,
		// and a plain View is not focusable in touch mode by default. Without this a
		// tap could never take focus, and the surface would fence its own input.
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
	 * A binding in the same input context as the current one
	 * ([TerminalViewBinding.sameInputContextAs]) is ordinary output: it is laid out and
	 * drawn, and it may earn a newer display commit, but the input proof the platform
	 * already committed for that context keeps standing, and the IME connection, its
	 * composition, and any latched chips survive. A draw pass that already drew an
	 * earlier binding of the context still owes its commit and keeps it; one that has
	 * not drawn yet is withdrawn and can never be attested.
	 *
	 * Anything else — a target, source, geometry, modes, policy, frame extent, input
	 * generation, or resize epoch change — retires the previous frame, its receipt,
	 * and its input proof before anything is drawn, and nothing drawn before the switch
	 * can ever be revived. The IME connection and composition survive only when the
	 * input context was unchanged; refused input is never buffered.
	 *
	 * A binding whose source is null is not refused: its frame is drawn exactly like
	 * any other, and input against it is denied. A binding whose non-null source
	 * contradicts its own owner run or owner row is refused exactly as before.
	 */
	fun setBinding(newBinding: TerminalViewBinding?) {
		if (binding === newBinding) return
		val previous = binding
		if (previous != null && newBinding != null && previous.sameInputContextAs(newBinding) &&
			installSameContext(newBinding)
		) {
			return
		}
		// First, and before anything else about the switch is handled: the old
		// target's proof stops being valid here, on the publishing side, so a writer
		// thread checking it concurrently cannot be told "yes" for a frame that is on
		// its way out.
		retireInputProof()
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
		// The input method's connection belongs to an input context, never to one
		// publish: the composition the keyboard holds survives only when the target,
		// source, geometry, modes, policy, frame extents, input generation, and resize
		// epoch are all unchanged. Even then, nothing is sent until a fresh platform
		// commit stands behind it.
		if (previous == null || !previous.sameInputContextAs(newBinding)) retireInputConnection()
		// A binding whose source contradicts its own owner run or owner row is a
		// caller mistake, and it is refused in [applyFrame] — the one path every
		// draw goes through — rather than only here.
		applyFrame()
	}

	/**
	 * Install an ordinary-output binding of the current input context, or return
	 * false when the context cannot be kept and the full retirement path must run.
	 *
	 * The context is only kept when the current frame is laid out and the new frame
	 * lays out into exactly the same drawn grid: the cell geometry, the layout epoch,
	 * the binding epoch, and the standing input proof all stay what the platform
	 * committed. Nothing here publishes, revives, or invents a proof.
	 */
	private fun installSameContext(next: TerminalViewBinding): Boolean {
		val previousLayout = layout ?: return false
		if (geometry == null || frameRejected || requestedCols <= 0 || requestedRows <= 0) return false
		if (InputSourceFence.state(next.source, next.ownerRun, next.rowId) == InputSourceState.CONTRADICTORY) return false
		val laidOut = TerminalCellLayout.layout(next.frame, requestedCols, requestedRows) ?: return false
		if (laidOut.frameCols != previousLayout.frameCols || laidOut.frameRows != previousLayout.frameRows ||
			laidOut.drawnColumns != previousLayout.drawnColumns || laidOut.drawnRows != previousLayout.drawnRows
		) {
			return false
		}
		val previousFrame = binding?.frame
		binding = next
		layout = laidOut
		// The display receipt describes the binding it drew; the newer pixels have not
		// been committed yet. The standing input proof is untouched.
		receipt = null
		val candidate = pendingDraw
		if (candidate != null && !candidate.drawn) {
			// Not drawn yet, so it can never be attested; the next pass draws the newer
			// binding instead. A candidate that already drew keeps its owed commit.
			pendingDraw = null
			watcher?.cancel()
		}
		// Unchanged graphics keep their decodes, so steady output with an image on screen
		// does not withhold every pass behind a fresh decode.
		if (previousFrame?.graphics != next.frame.graphics) prepareImages(next.frame)
		scheduleDrawAfterTraversal()
		return true
	}

	/**
	 * Ask for a pass that draws the installed binding and can earn its own commit.
	 *
	 * Output may arrive while a traversal is already drawing — from a draw-time
	 * listener, say, after this pane's pre-draw step registered (and this install just
	 * withdrew) the pass's candidate. An invalidate issued then is folded into the pass
	 * already under way, which draws the new pixels with no candidate behind them, and
	 * the platform schedules nothing after it: the newer binding would never be
	 * attested. So the ordinary invalidate is paired with one posted for the next frame,
	 * which runs after the current traversal and, finding this view drawn, schedules a
	 * genuine fresh pass. When no traversal was under way it finds the view still dirty
	 * and costs nothing. Nothing here touches a commit: only a real platform commit of
	 * a real pass can ever be attested.
	 */
	private fun scheduleDrawAfterTraversal() {
		if (!attachedToWindow) return
		invalidate()
		postInvalidateOnAnimation()
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
	 * is still standing. It is the first genuine commit of the current input context,
	 * which every keystroke is attributed to, and it stays the same receipt across
	 * ordinary output and newer same-context commits.
	 */
	fun currentInputProof(): FrameCommitReceipt? = publishedProof.current()?.proof?.anchor

	/**
	 * True when [candidate] is exactly the input proof this surface publishes now.
	 *
	 * Safe from any thread, including the caller's IO writer thread: the answer comes
	 * from a single atomic read of the published proof, never from the view, the gate,
	 * or the eligibility state. Callers check it immediately before a queued write.
	 *
	 * A proof stops being current as soon as the UI thread retires it, which it does
	 * before any other handling of a binding context, source, subscription, layout,
	 * policy, focus, coverage, modal, or detach change — and a display-only commit is
	 * never published in the first place. So the answer needs no further fence to be
	 * honest, and it never says yes to a frame the surface has stopped standing behind.
	 *
	 * Exactly two values are accepted, both genuine platform commits of the standing
	 * input context: its anchor ([currentInputProof]) and its newest commit. Nothing
	 * structurally similar, older, or from another context is.
	 */
	fun verifyReceipt(candidate: FrameCommitReceipt?): Boolean {
		candidate ?: return false
		val standing = publishedProof.current()?.proof ?: return false
		return candidate == standing.anchor || candidate == standing.latest
	}

	/**
	 * Stop standing behind the published input proof. UI thread only.
	 *
	 * Every genuine retirement — a context, layout, policy, focus, coverage, or
	 * lifecycle change, or a commit nobody can attest to — comes through here, and a
	 * touch gesture begun under the retired proof ends with it: nothing more of it is
	 * reported, released, or revived by a later commit. Ordinary same-context output
	 * never retires the proof, so it never reaches here and never ends a gesture.
	 */
	private fun retireInputProof() {
		if (publishedProof.retire() != null) abandonTouchGesture()
	}

	/** True when [candidate] is the anchor of the standing input proof. Any thread. */
	private fun isStandingAnchor(candidate: FrameCommitReceipt): Boolean =
		publishedProof.current()?.proof?.anchor == candidate

	/** Take input away from this surface for a modal (a session chooser, say). */
	fun setModalSuspended(suspended: Boolean) {
		if (eligibility.modalSuspended == suspended) return
		retireInputProof()
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
		retireInputProof()
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
		retireInputProof()
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
		emitInput(NativeIoInputKind.PASTE, packet, committed)
		return true
	}

	/**
	 * Focus the surface and ask the platform to show the soft keyboard.
	 *
	 * This is the explicit interaction a host screen calls when it wants the keyboard
	 * up; the surface never raises one on its own, not even for a tap on itself. True
	 * means the request
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
		retireInputProof()
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
		retireInputProof()
		attachedToWindow = false
		drawObserver?.takeIf { it.isAlive }?.removeOnPreDrawListener(beforeDraw)
		drawObserver = null
		pendingDraw = null
		watcher?.cancel()
		watcher = null
		retireInputConnection()
		clearMobileModifiersForTarget()
		abandonTouchGesture()
		imageDecoder?.close()
		imageDecoder = null
		retireCommit(InputUnavailableReason.DETACHED)
		clearImages()
		super.onDetachedFromWindow()
	}

	override fun onVisibilityAggregated(isVisible: Boolean) {
		super.onVisibilityAggregated(isVisible)
		if (!isVisible) {
			retireInputProof()
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
			retireInputProof()
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
			retireInputProof()
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
			retireInputProof()
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
		retireInputProof()
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

	/**
	 * True while [candidate] can still be attested: it is the pending pass, and the
	 * surface is still in the input context, binding epoch, layout epoch, and cell
	 * geometry it drew under. A newer binding of the same context (ordinary output)
	 * does not stop an already drawn candidate from earning its commit — the receipt
	 * is built from what the candidate drew, never from the newest binding.
	 */
	private fun isCurrent(candidate: DrawCandidate): Boolean =
		pendingDraw === candidate && candidate.binding.sameInputContextAs(binding) &&
			geometry === candidate.geometry &&
			gate.currentBindingEpoch == candidate.bindingEpoch &&
			gate.currentLayoutEpoch == candidate.layoutEpoch

	/** True when this pass is drawing exactly [candidate]'s binding and layout. */
	private fun isDrawing(candidate: DrawCandidate): Boolean =
		isCurrent(candidate) && binding === candidate.binding && layout === candidate.layout

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
			withholdIncompletePass()
			return
		}
		if (candidate != null && isDrawing(candidate) && syncEligibility().isEligible) {
			candidate.drawn = true
		}
	}

	/**
	 * This pass is not a complete frame, so it earns no commit.
	 *
	 * An undrawn candidate is withdrawn and the display receipt stops describing the
	 * screen. Without a standing input proof that is the whole commit retirement, as
	 * before. With one, the proof is about the committed input context, not about this
	 * pass's pixels, so ordinary output carrying a still-decoding image does not revoke
	 * it — and a candidate that already drew a complete earlier pass of the context
	 * keeps the commit it is owed.
	 */
	private fun withholdIncompletePass() {
		if (publishedProof.current() == null) {
			val owed = pendingDraw?.takeIf { it.drawn && isCurrent(it) }
			if (owed == null) {
				retireDraw(FrameInvalidationReason.FRAME_INCOMPLETE)
				return
			}
		}
		receipt = null
		val candidate = pendingDraw ?: return
		if (candidate.drawn && isCurrent(candidate)) return
		pendingDraw = null
		watcher?.cancel()
	}

	private fun handleFrameCommit(drawEpoch: Long) {
		val candidate = pendingDraw ?: return
		if (candidate.epoch != drawEpoch || !candidate.drawn || !isCurrent(candidate)) {
			if (publishedProof.current() == null) {
				retireDraw(FrameInvalidationReason.FRAME_INCOMPLETE)
			} else {
				// A same-context pass that did not draw attests nothing, but it does not
				// unsay the context's earlier genuine commit either: every genuine
				// context or lifecycle change already retired that proof on its own path.
				pendingDraw = null
				watcher?.cancel()
			}
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
			retireInputProof()
			return
		}
		val current = binding ?: run {
			retireInputProof()
			return
		}
		// Everything below comes from what the candidate actually drew, never from a
		// newer binding of the same context that arrived after it drew.
		val drawn = candidate.binding
		val laidOut = candidate.layout
		val cellGeometry = candidate.geometry
		val newReceipt = FrameCommitReceipt(
			hostId = drawn.hostId,
			connectionGeneration = drawn.connectionGeneration,
			selectionGeneration = drawn.selectionGeneration,
			subscriptionId = drawn.subscriptionId,
			ownerRun = drawn.ownerRun,
			rowId = drawn.rowId,
			publishSequence = drawn.publishSequence,
			geometry = drawn.geometry,
			source = drawn.source,
			modes = drawn.modes,
			policyGeneration = drawn.policyGeneration,
			inputGeneration = drawn.inputGeneration,
			resizeEpoch = drawn.resizeEpoch,
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
		// The display receipt describes the installed binding only; a commit of an
		// earlier binding of the context leaves the newer pixels to earn their own.
		if (drawn === current) receipt = newReceipt else scheduleDraw()
		// Published before the listener hears about it: this is what a writer thread
		// on the other side of that callback checks. A display-only commit is never
		// published, so a source-less frame leaves no proof behind rather than a fake
		// one, while still being drawn and reported as a commit. A newer commit of the
		// same context only advances [CommittedInputProof.latest]; the anchor every
		// keystroke is attributed to stays, atomically, in the same publication.
		if (newReceipt.authorizesInput) {
			val standing = publishedProof.current()?.proof
			val anchor = standing?.anchor?.takeIf { it.sameInputContextAs(newReceipt) } ?: newReceipt
			// A new anchor replacing a standing one is a new context: a touch gesture begun
			// under the old anchor ends here, exactly as if it had been retired first.
			if (standing != null && anchor !== standing.anchor) abandonTouchGesture()
			publishedProof.publish(CommittedInputProof(anchor, newReceipt))
		} else {
			retireInputProof()
		}
		listener?.onFrameCommitted(newReceipt)
	}

	private fun retireCommit(reason: InputUnavailableReason) {
		retireDraw(invalidationOf(reason))
	}

	private fun retireDraw(frameReason: FrameInvalidationReason) {
		retireInputProof()
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

	/** How far one input-method edit got. */
	internal enum class ImeEditDelivery {
		/** Every packet was handed to the listener. */
		DELIVERED,

		/** Nothing left, and the reason was reported. */
		REFUSED,

		/** The batch stopped part-way. Some of it left and the rest never will. */
		PARTIAL,
	}

	/**
	 * Send [deletions] backspaces and then [text], as one prepared batch or not at all.
	 *
	 * This is the one path for input-method edits: commits, kept compositions, deletions,
	 * and corrections that delete a changed suffix before typing its replacement. Both
	 * parts are encoded against one committed receipt, with any latched chip folded in,
	 * before anything leaves. If a part is above its ceiling
	 * ([ImeCommitEncoder.MAX_DELETION_REQUEST] backspaces or a commit's code points) or has
	 * no spelling for this child, nothing leaves, and the refusal is reported exactly as a
	 * commit's or a deletion's always was. No representable prefix is sent.
	 *
	 * The packets then go out in order. The standing proof is re-checked before every
	 * packet after the first, and so is [stillValid]. A refusal the caller learns about
	 * mid-batch therefore stops the rest too. Handing a batch to the listener is not atomic
	 * remote execution. [ImeEditDelivery.PARTIAL] says that some of it left, and nothing is
	 * replayed.
	 */
	internal fun submitImeEdit(deletions: Int, text: String, stillValid: () -> Boolean): ImeEditDelivery {
		if (deletions <= 0 && text.isEmpty()) return ImeEditDelivery.DELIVERED
		if (ImeCommitEncoder.isOversized(text) || deletions > ImeCommitEncoder.MAX_DELETION_REQUEST) {
			reportUnavailable(InputUnavailableReason.COMMIT_TOO_LARGE)
			return ImeEditDelivery.REFUSED
		}
		val committed = currentInputReceipt() ?: return ImeEditDelivery.REFUSED
		val modifiers = mobileModifiers.modifiers
		val packets = ArrayList<ByteArray>()
		if (deletions > 0) {
			val backspaces = ImeCommitEncoder.encodeBackspaces(deletions, modifiers, committed.modes)
			if (backspaces == null) {
				reportUnavailable(InputUnavailableReason.ENCODER_REFUSED)
				return ImeEditDelivery.REFUSED
			}
			packets.addAll(backspaces)
		}
		if (text.isNotEmpty()) {
			val typed = ImeCommitEncoder.encode(text, modifiers, committed.modes)
			if (typed == null) {
				reportUnavailable(InputUnavailableReason.ENCODER_REFUSED)
				return ImeEditDelivery.REFUSED
			}
			packets.addAll(typed)
		}
		val delivered = emitPackets(packets, committed, stillValid)
		return if (delivered == packets.size) ImeEditDelivery.DELIVERED else ImeEditDelivery.PARTIAL
	}

	/** Send one Enter, with any latched chip folded in, against the committed frame. */
	internal fun submitEnter(): Boolean {
		val committed = currentInputReceipt() ?: return false
		val packet = ImeCommitEncoder.encodeEnter(mobileModifiers.modifiers, committed.modes)
		if (packet == null) {
			reportUnavailable(InputUnavailableReason.ENCODER_REFUSED)
			return false
		}
		emitInput(NativeIoInputKind.KEYBOARD, packet, committed)
		return true
	}

	/**
	 * True when [event] is a plain Backspace: no chip held and no Shift, Alt, Ctrl, or Meta.
	 * When one leaves, it removes exactly one character before the cursor, so the input
	 * method connection can account for it instead of forgetting its context.
	 */
	internal fun isPlainBackspace(event: KeyEvent): Boolean =
		event.keyCode == KeyEvent.KEYCODE_DEL && mobileModifiers.modifiers == 0 &&
			hardwareModifiers(event) and PLAIN_BACKSPACE_EXCLUDED_MODIFIERS == 0

	/**
	 * Tell the input method where the selection and composition now are.
	 *
	 * This is a notification only. It is never awaited, and nothing is sent because of it.
	 */
	internal fun updateImeSelection(selectionStart: Int, selectionEnd: Int, compositionStart: Int, compositionEnd: Int) {
		context.getSystemService(InputMethodManager::class.java)
			?.updateSelection(this, selectionStart, selectionEnd, compositionStart, compositionEnd)
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
		emitInput(NativeIoInputKind.KEYBOARD, packet, committed)
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

	/**
	 * Touchscreen input.
	 *
	 * One finger is the existing path: the first touch takes focus and is a press,
	 * moving it into another cell is a drag, and lifting it is the left release — each
	 * reported only when the child asked for mouse events. Motion that never leaves the
	 * pressed cell is jitter, not a drag, so it is not reported, and a tap releases at
	 * the cell it pressed even when the platform reports the lift at a nearby cell. A
	 * cancelled gesture ends as no button, never as a left click. The whole gesture
	 * belongs to the input proof that stood when its first finger came down: a genuine
	 * retirement of that proof ends the gesture on the spot, and no drag, release, or
	 * wheel of it is ever attributed to a newer proof, however soon one is committed.
	 * Only a fresh first finger reports again.
	 *
	 * A second finger turns the gesture into a two-finger wheel. A press the first
	 * finger already forwarded is released first, and only under the anchor it went
	 * out under; then the standing input proof, the drawn geometry, and the cell under
	 * the fingers' centroid are captured, and every whole cell of vertical centroid
	 * travel becomes one wheel report through the same encoder a physical wheel uses.
	 * Each report re-checks that the captured anchor and geometry are still exactly
	 * current, so ordinary output keeps the swipe going while any genuine context,
	 * layout, focus, policy, coverage, or lifecycle change ends it for good — a fresh
	 * commit never revives it. A third finger, a lifted finger, or a cancel ends it
	 * too, and nothing that remains is ever turned back into a press or a drag: the
	 * next report waits for a fresh first finger.
	 *
	 * Neither path raises the soft keyboard; [openKeyboard] is the only one that does.
	 */
	override fun onTouchEvent(event: MotionEvent): Boolean {
		if (!event.isFromSource(InputDevice.SOURCE_TOUCHSCREEN)) return super.onTouchEvent(event)
		when (event.actionMasked) {
			MotionEvent.ACTION_DOWN -> {
				// A fresh first finger is a fresh gesture: nothing from an earlier one
				// carries over.
				touchGesture.down()
				touchAnchor = null
				touchOriginCell = null
				touchMotionForwarded = false
				touchPressCell = null
				touchWheelLease = null
				// A tap takes focus, so hardware keys and mouse reports can reach the
				// terminal, whether or not the child asked for mouse events. It never
				// raises the soft keyboard: the explicit keyboard control is the only
				// path that does ([openKeyboard]). A tap the child does not track
				// consumes the gesture without emitting an unsolicited report.
				if (!hasFocus()) requestFocus()
				val delivered = deliverPointerAt(event.x, event.y, button = 0, release = false)
				// The gesture belongs to the proof standing now. A press that left names
				// it exactly; one that did not still binds the gesture to whatever stood —
				// or to nothing, and then the gesture never reports at all.
				if (touchGesture.phase == TouchGesturePhase.SINGLE) {
					touchAnchor = delivered?.receipt ?: publishedProof.current()?.proof?.anchor
					touchOriginCell = delivered?.cell
					touchPressCell = delivered?.cell
				}
				return delivered != null || super.onTouchEvent(event)
			}
			MotionEvent.ACTION_MOVE -> return when (touchGesture.phase) {
				TouchGesturePhase.WHEEL -> {
					touchGesture.move(touchPointers(event))?.let { emitTouchWheel(it) }
					true
				}
				TouchGesturePhase.DORMANT -> true
				TouchGesturePhase.SINGLE -> {
					// Jitter inside the cell the press or last drag reported is not motion the
					// owner asked to see: forwarding it would turn a tap into a drag before its
					// release. Only a genuine cell change is forwarded, and it advances the last
					// reported cell the release ending a later wheel stands on.
					val cell = geometry?.cellOf(event.x, event.y)
					if (cell != null && cell == touchPressCell) return true
					val anchor = touchAnchor
					val delivered = anchor?.let {
						deliverPointerAt(event.x, event.y, button = 0, release = false, motion = true, under = it)
					}
					if (delivered != null) {
						touchMotionForwarded = true
						if (touchPressCell != null) touchPressCell = delivered.cell
					}
					delivered != null
				}
				// A move with no first finger seen keeps its existing, unfenced report.
				TouchGesturePhase.IDLE -> pointerAt(event, button = 0, release = false, motion = true)
			}
			MotionEvent.ACTION_POINTER_DOWN -> {
				beginTouchWheel(event)
				return true
			}
			MotionEvent.ACTION_POINTER_UP -> {
				touchGesture.pointerUp()
				touchWheelLease = null
				return true
			}
			MotionEvent.ACTION_UP -> {
				val phase = touchGesture.phase
				val anchor = touchAnchor
				val origin = touchOriginCell
				val last = touchPressCell
				val motionForwarded = touchMotionForwarded
				touchWheelLease = null
				touchAnchor = null
				touchOriginCell = null
				touchMotionForwarded = false
				touchPressCell = null
				touchGesture.end()
				return when (phase) {
					// No first finger seen: the existing, unfenced release.
					TouchGesturePhase.IDLE -> pointerAt(event, button = 3, release = true) || super.onTouchEvent(event)
					// One finger: a left release, only under the proof the gesture began under and
					// only when its press actually left. Without forwarded motion the lift still
					// belongs to the pressed cell; after a real drag it names the lifted cell.
					TouchGesturePhase.SINGLE -> {
						val released = when {
							anchor == null || last == null -> null
							!motionForwarded && origin != null && last == origin -> deliverPointerAtCell(
								origin, button = 0, release = true, under = anchor,
							)
							else -> deliverPointerAt(event.x, event.y, button = 0, release = true, under = anchor)
						}
						released != null || super.onTouchEvent(event)
					}
					// A wheel, or a gesture that stopped reporting, ends with nothing: there is
					// no press of its own to release. The platform's own tap tracking still
					// sees the end, so a tap it was following is not left pressed.
					else -> {
						super.onTouchEvent(event)
						true
					}
				}
			}
			MotionEvent.ACTION_CANCEL -> {
				val phase = touchGesture.phase
				val anchor = touchAnchor
				val last = touchPressCell
				touchWheelLease = null
				touchAnchor = null
				touchOriginCell = null
				touchMotionForwarded = false
				touchPressCell = null
				touchGesture.end()
				return when (phase) {
					// No first finger seen: the existing, unfenced cancellation.
					TouchGesturePhase.IDLE -> pointerAt(event, button = 3, release = true) || super.onTouchEvent(event)
					// One finger: cancellation keeps its no-button release, never a left click,
					// and never invents a release for a press that did not leave.
					TouchGesturePhase.SINGLE -> {
						val released = if (anchor != null && last != null) {
							deliverPointerAt(event.x, event.y, button = 3, release = true, under = anchor)
						} else {
							null
						}
						released != null || super.onTouchEvent(event)
					}
					else -> {
						super.onTouchEvent(event)
						true
					}
				}
			}
			else -> return super.onTouchEvent(event)
		}
	}

	/**
	 * A further finger touched down: begin a two-finger wheel when this makes exactly
	 * two, and otherwise stop reporting until a fresh gesture.
	 */
	private fun beginTouchWheel(event: MotionEvent) {
		if (touchGesture.phase == TouchGesturePhase.SINGLE) {
			// The owner must not be left holding the first finger's press, and the
			// platform's own tap tracking must not turn this into a click.
			releaseHeldTouchPress()
			cancelPlatformTouch(event)
		}
		touchWheelLease = null
		if (!touchGesture.pointerDown(touchPointers(event))) return
		val anchor = touchAnchor
		if (anchor == null) {
			// The gesture began with no proof standing; a later commit is no licence.
			touchGesture.abandon()
			return
		}
		val lease = captureTouchWheelLease(touchGesture.centroidX, touchGesture.centroidY, anchor)
		if (lease == null || !touchGesture.arm(lease.geometry.cellHeightPx)) {
			touchGesture.abandon()
			return
		}
		touchWheelLease = lease
	}

	/**
	 * Release the first finger's forwarded press, under the anchor it was forwarded
	 * under and at the last cell it was reported at — or not at all. A release is
	 * never attributed to a newer proof than its press, and never replayed later.
	 */
	private fun releaseHeldTouchPress() {
		val anchor = touchAnchor ?: return
		val cell = touchPressCell ?: return
		touchPressCell = null
		pointerReportUnder(
			TerminalPointerEvent(button = 3, column = cell.column, row = cell.row, release = true),
			anchor,
		)
	}

	/**
	 * Capture what a two-finger wheel reports against — [anchor], the proof its first
	 * finger came down under, and only while that is still exactly the receipt input is
	 * attributed to — or null after reporting why not.
	 */
	private fun captureTouchWheelLease(x: Float, y: Float, anchor: FrameCommitReceipt): TouchWheelLease? {
		val committed = currentInputReceipt() ?: return null
		if (committed != anchor) {
			reportUnavailable(InputUnavailableReason.BINDING_RETIRED)
			return null
		}
		val cellGeometry = geometry
		if (cellGeometry == null || cellGeometry.contentRect != anchor.contentRect ||
			cellGeometry.columns != anchor.drawnColumns || cellGeometry.rows != anchor.drawnRows
		) {
			reportUnavailable(InputUnavailableReason.LAYOUT_RETIRED)
			return null
		}
		val cell = cellGeometry.cellOf(x, y)
		if (cell == null || !anchor.covers(cell)) {
			reportUnavailable(InputUnavailableReason.POINTER_OUTSIDE_CONTENT)
			return null
		}
		return TouchWheelLease(anchor, cellGeometry, cell)
	}

	/**
	 * Report [steps] wheel reports, each only while the wheel's captured anchor and
	 * geometry are still exactly current. The first one that is not ends the wheel,
	 * and the steps after it are dropped, never held for a later receipt.
	 */
	private fun emitTouchWheel(steps: TouchWheelSteps) {
		repeat(steps.count) {
			val lease = touchWheelLease ?: return
			if (geometry !== lease.geometry) {
				reportUnavailable(InputUnavailableReason.LAYOUT_RETIRED)
				abandonTouchGesture()
				return
			}
			val wheel = TerminalPointerEvent(
				button = steps.button,
				column = lease.cell.column,
				row = lease.cell.row,
				wheel = true,
			)
			if (!pointerReportUnder(wheel, lease.anchor)) {
				abandonTouchGesture()
				return
			}
		}
	}

	/** Stop the current touch gesture from reporting anything more. */
	private fun abandonTouchGesture() {
		touchAnchor = null
		touchOriginCell = null
		touchMotionForwarded = false
		touchPressCell = null
		touchWheelLease = null
		if (touchGesture.phase != TouchGesturePhase.IDLE) touchGesture.abandon()
	}

	/** Every finger on the screen, by its platform pointer id rather than its index. */
	private fun touchPointers(event: MotionEvent): List<TouchPointer> =
		List(event.pointerCount) { index -> TouchPointer(event.getPointerId(index), event.getX(index), event.getY(index)) }

	/** End the platform's own tap and press tracking for a gesture that is no longer a tap. */
	private fun cancelPlatformTouch(event: MotionEvent) {
		val cancel = MotionEvent.obtain(event)
		try {
			cancel.action = MotionEvent.ACTION_CANCEL
			super.onTouchEvent(cancel)
		} finally {
			cancel.recycle()
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
	): Boolean = deliverPointerAt(event.x, event.y, button, release, motion, wheel) != null

	/** The receipt a pointer report was attributed to, and the cell it named. */
	private class PointerDelivery(val receipt: FrameCommitReceipt, val cell: CellPosition)

	private fun deliverPointerAt(
		x: Float,
		y: Float,
		button: Int,
		release: Boolean,
		motion: Boolean = false,
		wheel: Boolean = false,
		under: FrameCommitReceipt? = null,
	): PointerDelivery? {
		val cellGeometry = geometry ?: return null
		val position = cellGeometry.cellOf(x, y)
		if (position == null) {
			if (!motion) reportUnavailable(InputUnavailableReason.POINTER_OUTSIDE_CONTENT)
			return null
		}
		return deliverPointerAtCell(position, button, release, motion, wheel, under)
	}

	/** The same report as [deliverPointerAt], for a cell already resolved above. */
	private fun deliverPointerAtCell(
		position: CellPosition,
		button: Int,
		release: Boolean,
		motion: Boolean = false,
		wheel: Boolean = false,
		under: FrameCommitReceipt? = null,
	): PointerDelivery? {
		val cellGeometry = geometry ?: return null
		if (position.column !in 0 until cellGeometry.columns || position.row !in 0 until cellGeometry.rows) {
			reportUnavailable(InputUnavailableReason.POINTER_OUTSIDE_CONTENT)
			return null
		}
		val pointer = TerminalPointerEvent(
			button = if (motion) button or MOTION_BIT else button,
			column = position.column,
			row = position.row,
			release = release,
			motion = motion,
			wheel = wheel,
		)
		// With [under], the report leaves only while that exact anchor still stands.
		val receipt = if (under == null) {
			pointerReport(pointer) ?: return null
		} else {
			if (!pointerReportUnder(pointer, under)) return null
			under
		}
		return PointerDelivery(receipt, position)
	}

	/** Report [pointer] against the current input receipt, and return that receipt. */
	private fun pointerReport(pointer: TerminalPointerEvent): FrameCommitReceipt? {
		val committed = currentInputReceipt() ?: return null
		return if (deliverPointer(pointer, committed)) committed else null
	}

	/**
	 * Report [pointer] only while [anchor] is still exactly the receipt input is
	 * attributed to; a newer proof — even a fresh one of an equal-looking context — is
	 * a different one, and nothing is reported against it on [anchor]'s behalf.
	 */
	private fun pointerReportUnder(pointer: TerminalPointerEvent, anchor: FrameCommitReceipt): Boolean {
		val committed = currentInputReceipt() ?: return false
		if (committed != anchor) {
			reportUnavailable(InputUnavailableReason.BINDING_RETIRED)
			return false
		}
		return deliverPointer(pointer, committed)
	}

	private fun deliverPointer(pointer: TerminalPointerEvent, committed: FrameCommitReceipt): Boolean {
		if (!committed.covers(CellPosition(pointer.column, pointer.row))) {
			reportUnavailable(InputUnavailableReason.POINTER_OUTSIDE_CONTENT)
			return false
		}
		val packet = MouseEncoder.encode(pointer, committed.modes, committed.drawnColumns, committed.drawnRows)
		if (packet == null) {
			reportUnavailable(InputUnavailableReason.MOUSE_REPORTING_OFF)
			return false
		}
		emitInput(NativeIoInputKind.MOUSE, packet, committed)
		return true
	}

	/**
	 * The receipt input may be attributed to, or null after reporting why not.
	 *
	 * Every fence is re-checked here rather than trusted from the last callback: a
	 * keystroke is only allowed against an input context the platform confirmed a
	 * commit of and that nothing has since retired. The receipt returned is the
	 * standing proof's anchor — the first genuine commit of the context — so newer
	 * same-context output or display commits never strand a keystroke.
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
		val standing = publishedProof.current()?.proof
		if (standing == null) {
			val display = receipt
			reportUnavailable(
				when {
					// The pixels are honest and the frame is complete; there is simply no
					// host-written source for a keystroke to be attributed to. Saying so is
					// the whole response: no source, no permission, and no stand-in receipt
					// is manufactured to get past this point.
					display != null && !display.authorizesInput -> InputUnavailableReason.SOURCE_ABSENT
					frameRejected -> InputUnavailableReason.FRAME_REJECTED
					else -> InputUnavailableReason.NO_COMMITTED_FRAME
				},
			)
			return null
		}
		val committed = standing.anchor
		if (!isInContext(committed)) {
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
			// Fail-closed net: a display-only commit is never published as a proof.
			reportUnavailable(InputUnavailableReason.SOURCE_ABSENT)
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

	/** True when [candidate] is a commit of the input context this surface shows now. */
	private fun isInContext(candidate: FrameCommitReceipt): Boolean {
		val current = binding ?: return false
		if (!current.sourceMatches()) return false
		// A source that moved — present to absent, absent to present, or one source
		// for another — is a different target for input even when every other field
		// still lines up, so the proof the earlier source carried stops being proof.
		// Only the publish sequence and displayed content may have moved on.
		return candidate.inContextOf(current)
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
	private fun emitBatch(packets: List<ByteArray>, committed: FrameCommitReceipt): Boolean =
		emitPackets(packets, committed) { true } == packets.size

	/** [emitBatch], also stopping once [stillValid] fails. Returns how many packets left. */
	private fun emitPackets(packets: List<ByteArray>, committed: FrameCommitReceipt, stillValid: () -> Boolean): Int =
		InputBatchDelivery.emitInOrder(
			packets,
			stillCurrent = { proofStillCurrent(committed) && stillValid() },
			emit = { packet -> emitInput(NativeIoInputKind.KEYBOARD, packet, committed) },
		)

	/**
	 * How many packets this surface has handed to its listener.
	 *
	 * The input method connection compares this with the packets it accounted for itself.
	 * A key, paste, pointer report, or Enter it did not produce makes it forget its context
	 * instead of trusting text the remote line may no longer hold. UI thread only.
	 */
	internal var inputEmissions: Long = 0L
		private set

	/**
	 * The only place a packet leaves the surface. It is counted, and it carries the notice
	 * that lets the caller tell the current input method connection the packet was not sent.
	 */
	private fun emitInput(kind: NativeIoInputKind, packet: ByteArray, committed: FrameCommitReceipt) {
		inputEmissions += 1
		val refusal = activeConnection?.refusalNotice() ?: TerminalInputRefusal.NONE
		listener?.onInput(kind, packet, committed, refusal)
	}

	private fun proofStillCurrent(committed: FrameCommitReceipt): Boolean {
		if (isStandingAnchor(committed)) return true
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

		/** Modifiers that make a Backspace mean something other than deleting one character. */
		private const val PLAIN_BACKSPACE_EXCLUDED_MODIFIERS = KeyboardModifiers.SHIFT or KeyboardModifiers.ALT or
			KeyboardModifiers.CTRL or KeyboardModifiers.META

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
