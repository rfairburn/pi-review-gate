package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.MouseEncodingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.MouseTrackingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import java.nio.charset.StandardCharsets
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Two-finger wheel bookkeeping: pointer ids rather than indexes, whole measured-cell
 * steps with a bounded carried fraction, and transitions that never turn a finished
 * wheel back into a press, a drag, or a revived wheel. Steps are encoded with the
 * existing [MouseEncoder] so the bytes a step stands for are asserted, not only flags.
 */
class TwoFingerWheelGestureTest {

	@Test
	fun oneFingerStaysTheExistingPathAndEndsWithItsRelease() {
		val gesture = TwoFingerWheelGesture()
		assertEquals(TouchGesturePhase.IDLE, gesture.phase)
		gesture.down()
		assertEquals(TouchGesturePhase.SINGLE, gesture.phase)
		// A one-finger move is not wheel evidence; the caller's drag path owns it.
		assertNull(gesture.move(listOf(TouchPointer(0, 10f, 300f))))
		assertEquals(TouchGesturePhase.SINGLE, gesture.phase)
		assertTrue(gesture.end(), "a one-finger gesture keeps its existing release")
		assertEquals(TouchGesturePhase.IDLE, gesture.phase)
	}

	@Test
	fun twoFingersDownAndUpProduceWheelReportsAtTheCapturedCell() {
		val gesture = wheel(cellHeight = 20)
		// Fingers down by one cell: earlier content comes into view, which is wheel up.
		val down = gesture.move(pair(100f, 120f, 120f))
		assertEquals(TouchWheelSteps(TwoFingerWheelGesture.WHEEL_UP, 1), down)
		assertEquals(0f, gesture.residue)
		assertContentEquals(sgr("64;4;6M"), encode(down!!, column = 3, row = 5, modes(MouseTrackingMode.VT200)))
		// Fingers up by two cells: wheel down, twice.
		val up = gesture.move(pair(100f, 80f, 80f))
		assertEquals(TouchWheelSteps(TwoFingerWheelGesture.WHEEL_DOWN, 2), up)
		assertContentEquals(sgr("65;4;6M"), encode(up!!, column = 3, row = 5, modes(MouseTrackingMode.VT200)))
		// The same direction the physical wheel path already uses, in legacy encoding too.
		assertContentEquals(
			byteArrayOf(0x1b, 0x5b, 0x4d, (64 + 32).toByte(), (3 + 33).toByte(), (5 + 33).toByte()),
			encode(down, column = 3, row = 5, modes(MouseTrackingMode.ANY, MouseEncodingMode.DEFAULT)),
		)
	}

	@Test
	fun repeatedSmallMovesCarryABoundedFractionIntoWholeSteps() {
		val gesture = wheel(cellHeight = 20)
		var y = 100f
		val emitted = mutableListOf<TouchWheelSteps>()
		repeat(10) {
			y += 7f
			gesture.move(pair(100f, y, y))?.let(emitted::add)
			assertTrue(kotlin.math.abs(gesture.residue) < 20f, "carried fraction stays under one cell")
		}
		// 70 px of travel at 20 px per cell: exactly three whole steps, 10 px carried.
		assertEquals(3, emitted.sumOf { it.count })
		assertTrue(emitted.all { it.button == TwoFingerWheelGesture.WHEEL_UP })
		assertEquals(10f, gesture.residue)
		// Reversing direction spends the carried fraction before stepping the other way.
		assertNull(gesture.move(pair(100f, y - 15f, y - 15f)))
		assertEquals(-5f, gesture.residue)
		assertEquals(TouchWheelSteps(TwoFingerWheelGesture.WHEEL_DOWN, 1), gesture.move(pair(100f, y - 35f, y - 35f)))
		assertEquals(-5f, gesture.residue)
	}

	@Test
	fun oneMoveNeverYieldsMoreThanTheBoundAndTheExcessIsDroppedNotQueued() {
		val gesture = wheel(cellHeight = 10)
		val burst = gesture.move(pair(100f, 300f, 300f))
		assertEquals(TouchWheelSteps(TwoFingerWheelGesture.WHEEL_UP, TwoFingerWheelGesture.MAX_STEPS_PER_MOVE), burst)
		assertEquals(0f, gesture.residue)
		// Nothing left over is released by a later, motionless move.
		assertNull(gesture.move(pair(100f, 300f, 300f)))
		assertEquals(TouchGesturePhase.WHEEL, gesture.phase)
	}

	@Test
	fun zeroAndHorizontalTravelNeverScroll() {
		val gesture = wheel(cellHeight = 10)
		assertNull(gesture.move(pair(100f, 100f, 100f)))
		// Mostly horizontal: 60 px across, 9 px down — not wheel evidence, not carried.
		assertNull(gesture.move(pair(160f, 109f, 109f)))
		assertEquals(0f, gesture.residue)
		repeat(5) { step ->
			assertNull(gesture.move(pair(160f + 40f * (step + 1), 109f + 8f * (step + 1), 109f + 8f * (step + 1))))
		}
		assertEquals(0f, gesture.residue)
		assertEquals(TouchGesturePhase.WHEEL, gesture.phase)
	}

	@Test
	fun fingersAreTrackedByIdNotByTheirIndexInTheEvent() {
		val gesture = TwoFingerWheelGesture()
		gesture.down()
		assertTrue(gesture.pointerDown(listOf(TouchPointer(7, 100f, 100f), TouchPointer(3, 200f, 100f))))
		assertTrue(gesture.arm(20))
		// The platform may list the same two fingers in the other order.
		val reordered = listOf(TouchPointer(3, 200f, 120f), TouchPointer(7, 100f, 120f))
		assertEquals(TouchWheelSteps(TwoFingerWheelGesture.WHEEL_UP, 1), gesture.move(reordered))
		assertEquals(150f, gesture.centroidX)
		assertEquals(120f, gesture.centroidY)
		// Two fingers again, but one of them is not a tracked finger: the wheel ends.
		assertNull(gesture.move(listOf(TouchPointer(3, 200f, 200f), TouchPointer(9, 100f, 200f))))
		assertEquals(TouchGesturePhase.DORMANT, gesture.phase)
		assertNull(gesture.move(reordered))
	}

	@Test
	fun aThirdFingerEndsTheWheelForTheRestOfTheGesture() {
		val gesture = wheel(cellHeight = 20)
		assertFalse(gesture.pointerDown(listOf(TouchPointer(0, 100f, 100f), TouchPointer(1, 100f, 100f), TouchPointer(2, 1f, 1f))))
		assertEquals(TouchGesturePhase.DORMANT, gesture.phase)
		// Lifting the third finger does not bring the wheel back.
		assertNull(gesture.move(pair(100f, 200f, 200f)))
		gesture.pointerUp()
		assertNull(gesture.move(pair(100f, 300f, 300f)))
		assertFalse(gesture.end(), "a dormant gesture has no release of its own")
	}

	@Test
	fun liftingOneFingerNeverResumesAOneFingerPressOrDrag() {
		val gesture = wheel(cellHeight = 20)
		gesture.pointerUp()
		assertEquals(TouchGesturePhase.DORMANT, gesture.phase)
		assertNull(gesture.move(listOf(TouchPointer(0, 100f, 400f))))
		assertEquals(TouchGesturePhase.DORMANT, gesture.phase)
		// A second finger landing again is still not a new wheel inside the same gesture.
		assertFalse(gesture.pointerDown(pair(100f, 100f, 100f)))
		assertNull(gesture.move(pair(100f, 300f, 300f)))
		assertFalse(gesture.end())
		// Only a fresh first finger starts over.
		gesture.down()
		assertEquals(TouchGesturePhase.SINGLE, gesture.phase)
		assertEquals(0f, gesture.residue)
	}

	@Test
	fun cancelAndAbandonEndAWheelWithNothingToReleaseOrReplay() {
		val cancelled = wheel(cellHeight = 20)
		assertNull(cancelled.move(pair(100f, 115f, 115f)))
		assertFalse(cancelled.end(), "a cancelled wheel is not a one-finger release")
		assertEquals(TouchGesturePhase.IDLE, cancelled.phase)
		assertNull(cancelled.move(pair(100f, 300f, 300f)))

		val abandoned = wheel(cellHeight = 20)
		assertNull(abandoned.move(pair(100f, 115f, 115f)))
		abandoned.abandon()
		// The carried 15 px are dropped: completing the cell after abandoning reports nothing.
		assertNull(abandoned.move(pair(100f, 125f, 125f)))
		assertEquals(0f, abandoned.residue)
		assertEquals(TouchGesturePhase.DORMANT, abandoned.phase)
	}

	@Test
	fun aWheelWithoutAMeasuredCellNeverSteps() {
		val unarmed = TwoFingerWheelGesture()
		unarmed.down()
		assertTrue(unarmed.pointerDown(pair(100f, 100f, 100f)))
		assertFalse(unarmed.isArmed)
		assertNull(unarmed.move(pair(100f, 300f, 300f)))
		assertFalse(unarmed.arm(0))
		assertEquals(TouchGesturePhase.DORMANT, unarmed.phase)

		val rearmed = wheel(cellHeight = 20)
		assertFalse(rearmed.arm(10), "a step size is captured once, never swapped mid-gesture")
		assertEquals(TouchGesturePhase.DORMANT, rearmed.phase)
	}

	@Test
	fun malformedPointerReportsEndTheGesture() {
		val missingDown = TwoFingerWheelGesture()
		assertFalse(missingDown.pointerDown(pair(100f, 100f, 100f)), "no first finger, no wheel")
		assertEquals(TouchGesturePhase.DORMANT, missingDown.phase)

		val duplicate = TwoFingerWheelGesture()
		duplicate.down()
		assertFalse(duplicate.pointerDown(listOf(TouchPointer(0, 1f, 1f), TouchPointer(0, 2f, 2f))))

		val nonFinite = wheel(cellHeight = 20)
		assertNull(nonFinite.move(listOf(TouchPointer(0, 100f, Float.NaN), TouchPointer(1, 100f, 140f))))
		assertEquals(TouchGesturePhase.DORMANT, nonFinite.phase)
	}

	@Test
	fun stepsTheOwnerDidNotAskForAreRefusedByTheExistingEncoder() {
		val steps = TouchWheelSteps(TwoFingerWheelGesture.WHEEL_UP, 1)
		assertNull(encode(steps, column = 0, row = 0, modes(MouseTrackingMode.NONE)))
		assertNull(encode(steps, column = 0, row = 0, modes(MouseTrackingMode.X10)))
		assertNull(encode(steps, column = 0, row = 0, modes(MouseTrackingMode.ANY, MouseEncodingMode.SGR_PIXELS)))
		assertContentEquals(sgr("64;1;1M"), encode(steps, column = 0, row = 0, modes(MouseTrackingMode.DRAG)))
	}

	/** A wheel begun by fingers 0 and 1 at (100, 100), armed with [cellHeight]. */
	private fun wheel(cellHeight: Int): TwoFingerWheelGesture {
		val gesture = TwoFingerWheelGesture()
		gesture.down()
		assertTrue(gesture.pointerDown(pair(100f, 100f, 100f)))
		assertTrue(gesture.arm(cellHeight))
		assertTrue(gesture.isArmed)
		return gesture
	}

	/** Fingers 0 and 1, side by side at [x] and [x] + 40, at heights [y0] and [y1]. */
	private fun pair(x: Float, y0: Float, y1: Float) =
		listOf(TouchPointer(0, x - 20f, y0), TouchPointer(1, x + 20f, y1))

	private fun encode(steps: TouchWheelSteps, column: Int, row: Int, modes: TerminalInputModes): ByteArray? =
		MouseEncoder.encode(TerminalPointerEvent(button = steps.button, column = column, row = row, wheel = true), modes, 80, 24)

	private fun modes(tracking: MouseTrackingMode, encoding: MouseEncodingMode = MouseEncodingMode.SGR) =
		TerminalInputModes(0, false, false, false, tracking, 0, encoding)

	private fun sgr(body: String) = "\u001b[<$body".toByteArray(StandardCharsets.UTF_8)
}
