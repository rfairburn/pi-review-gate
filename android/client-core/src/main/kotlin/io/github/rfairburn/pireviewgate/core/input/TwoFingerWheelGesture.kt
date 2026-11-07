package io.github.rfairburn.pireviewgate.core.input

import kotlin.math.abs

/** One touchscreen pointer as the platform reported it: its stable id and its position. */
data class TouchPointer(val id: Int, val x: Float, val y: Float)

/** Where one touchscreen gesture stands. */
enum class TouchGesturePhase {
	/** No gesture is in progress. */
	IDLE,

	/** One finger is down: the existing press, drag, and release path owns it. */
	SINGLE,

	/** Exactly two fingers are down and their vertical travel becomes wheel steps. */
	WHEEL,

	/** The gesture can no longer report anything; only a fresh first finger starts another. */
	DORMANT,
}

/** One bounded batch of wheel reports: the terminal wheel button and how many of them. */
data class TouchWheelSteps(val button: Int, val count: Int)

/**
 * The pointer bookkeeping behind a two-finger vertical swipe on the terminal.
 *
 * A one-finger gesture stays exactly what it was: this type only records that it is
 * one, and the caller keeps reporting its press, drag, and release. When a second
 * finger joins, the gesture becomes a wheel: the two fingers are tracked by their
 * platform pointer ids — never by the volatile index a motion event lists them at —
 * and the vertical travel of their centroid is turned into whole wheel steps, one per
 * measured cell height, with the leftover fraction carried to the next move.
 *
 * Anything else ends it for good: a third finger, either finger lifting, a cancel, a
 * pointer list that no longer names exactly the two tracked fingers, a position that
 * is not a number, or the caller abandoning it because its own fences moved. A
 * finished wheel never turns back into a one-finger press or drag, and it never
 * revives: the gesture waits, dormant, for every finger to lift and a fresh first
 * finger to arrive.
 *
 * Direction follows the touchscreen convention: fingers moving down pull earlier
 * content into view, which is wheel up ([WHEEL_UP], the same button a physical wheel
 * scrolled away from the user produces), and fingers moving up are wheel down.
 *
 * Bounds: a single move yields at most [MAX_STEPS_PER_MOVE] steps, any whole steps
 * beyond that are dropped rather than queued, and the carried fraction is always
 * smaller than one cell. Moves that are not mostly vertical carry no wheel evidence at
 * all, so horizontal noise and zero travel never scroll.
 *
 * Pure bookkeeping: no clock, no thread, no platform type, and no input proof. Which
 * receipt a step may be reported against is entirely the caller's decision.
 */
class TwoFingerWheelGesture {
	/** Where the gesture stands now. */
	var phase: TouchGesturePhase = TouchGesturePhase.IDLE
		private set

	private var firstId = NO_POINTER
	private var secondId = NO_POINTER
	private var lastX = 0f
	private var lastY = 0f
	private var cellHeightPx = 0
	private var residuePx = 0f

	/** The carried vertical travel, in pixels; always within one cell of zero. */
	val residue: Float get() = residuePx

	/** The two tracked fingers' centroid at the last accepted observation, x then y. */
	val centroidX: Float get() = lastX
	val centroidY: Float get() = lastY

	/** True once [arm] gave the wheel a usable cell height. */
	val isArmed: Boolean get() = phase == TouchGesturePhase.WHEEL && cellHeightPx > 0

	/** The first finger touched down: a new gesture, and a one-finger one so far. */
	fun down() {
		clear()
		phase = TouchGesturePhase.SINGLE
	}

	/**
	 * Another finger touched down; [pointers] are every finger now on the screen.
	 *
	 * True when this began a wheel: the gesture was one finger, exactly two distinct
	 * fingers are now down at finite positions, and their centroid becomes the
	 * starting point. Anything else makes the gesture dormant.
	 */
	fun pointerDown(pointers: List<TouchPointer>): Boolean {
		if (phase != TouchGesturePhase.SINGLE || pointers.size != 2 || pointers[0].id == pointers[1].id ||
			pointers.any { !it.x.isFinite() || !it.y.isFinite() }
		) {
			abandon()
			return false
		}
		clear()
		phase = TouchGesturePhase.WHEEL
		firstId = pointers[0].id
		secondId = pointers[1].id
		lastX = (pointers[0].x + pointers[1].x) / 2f
		lastY = (pointers[0].y + pointers[1].y) / 2f
		return true
	}

	/**
	 * Give a begun wheel the measured cell height one step stands for.
	 *
	 * False, and dormant, when there is no wheel to arm or the height is not positive:
	 * a step size that was not measured is never guessed.
	 */
	fun arm(measuredCellHeightPx: Int): Boolean {
		if (phase != TouchGesturePhase.WHEEL || cellHeightPx > 0 || measuredCellHeightPx <= 0) {
			abandon()
			return false
		}
		cellHeightPx = measuredCellHeightPx
		return true
	}

	/**
	 * The fingers moved; [pointers] are every finger now on the screen.
	 *
	 * Returns the whole wheel steps this move completed, or null when it completed
	 * none. Only an armed wheel produces steps, and a pointer list that is not exactly
	 * the two tracked fingers ends the wheel.
	 */
	fun move(pointers: List<TouchPointer>): TouchWheelSteps? {
		if (!isArmed) return null
		if (pointers.size != 2) {
			abandon()
			return null
		}
		val first = pointers.firstOrNull { it.id == firstId }
		val second = pointers.firstOrNull { it.id == secondId }
		if (first == null || second == null ||
			!first.x.isFinite() || !first.y.isFinite() || !second.x.isFinite() || !second.y.isFinite()
		) {
			abandon()
			return null
		}
		val x = (first.x + second.x) / 2f
		val y = (first.y + second.y) / 2f
		val dx = x - lastX
		val dy = y - lastY
		lastX = x
		lastY = y
		// Only mostly-vertical travel is wheel evidence; zero travel never is.
		if (abs(dy) <= abs(dx)) return null
		val travel = residuePx + dy
		val whole = (travel / cellHeightPx).toInt() // Truncates toward zero.
		residuePx = travel - whole * cellHeightPx.toFloat()
		// Float rounding must never leave a carried fraction of a whole cell or more.
		if (abs(residuePx) >= cellHeightPx) residuePx = 0f
		if (whole == 0) return null
		val count = minOf(abs(whole), MAX_STEPS_PER_MOVE)
		return TouchWheelSteps(if (whole > 0) WHEEL_UP else WHEEL_DOWN, count)
	}

	/** One of several fingers lifted: a one-finger gesture never resumes from a wheel. */
	fun pointerUp() {
		abandon()
	}

	/**
	 * The last finger lifted, or the platform cancelled the gesture.
	 *
	 * True when the gesture was the one-finger kind — or never started — so its
	 * existing release path applies. A wheel or dormant gesture ends with nothing.
	 */
	fun end(): Boolean {
		val single = phase == TouchGesturePhase.SINGLE || phase == TouchGesturePhase.IDLE
		clear()
		phase = TouchGesturePhase.IDLE
		return single
	}

	/** Stop reporting anything until a fresh first finger starts a new gesture. */
	fun abandon() {
		clear()
		phase = TouchGesturePhase.DORMANT
	}

	private fun clear() {
		firstId = NO_POINTER
		secondId = NO_POINTER
		lastX = 0f
		lastY = 0f
		cellHeightPx = 0
		residuePx = 0f
	}

	companion object {
		/** The terminal button code for one wheel-up report. */
		const val WHEEL_UP = 64

		/** The terminal button code for one wheel-down report. */
		const val WHEEL_DOWN = 65

		/** The most wheel reports a single move may produce. */
		const val MAX_STEPS_PER_MOVE = 4

		private const val NO_POINTER = -1
	}
}
