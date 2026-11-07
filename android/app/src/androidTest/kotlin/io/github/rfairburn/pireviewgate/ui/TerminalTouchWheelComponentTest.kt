package io.github.rfairburn.pireviewgate.ui

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.WindowInsets
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.rfairburn.pireviewgate.core.client.ui.ClientIntent
import io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute
import io.github.rfairburn.pireviewgate.core.input.TwoFingerWheelGesture
import io.github.rfairburn.pireviewgate.core.protocol.content.MouseEncodingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.MouseTrackingMode
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import io.github.rfairburn.pireviewgate.ui.terminal.FrameCommitReceipt
import io.github.rfairburn.pireviewgate.ui.terminal.InputUnavailableReason
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalSurfaceView
import io.github.rfairburn.pireviewgate.ui.terminal.TerminalViewBinding
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real Canvas commits and real touchscreen dispatch into the terminal pane, with
 * explicitly synthetic immutable snapshots: a two-finger vertical swipe becomes the
 * owner's own wheel reports against the standing committed anchor, one finger keeps
 * its exact press, drag, and release reports, a physical wheel is untouched, and no
 * pointer transition, refusal, or retirement ever produces a press, a release, or a
 * wheel report the user did not make against the proof they made it on.
 *
 * Every packet below is asserted by its exact bytes and the receipt it was attributed
 * to; the shared fixture's listener additionally refuses any packet whose receipt the
 * surface no longer verifies. Input sequences are synthesized deterministically on the
 * main thread; the only waits are for genuine platform commits.
 */
@RunWith(AndroidJUnit4::class)
class TerminalTouchWheelComponentTest {
    @get:Rule val compose = createAndroidComposeRule<UiVerificationActivity>()

    @Test fun twoFingerSwipesEmitWheelReportsAgainstTheStandingAnchorWithoutRaisingTheKeyboard() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitMouseProof(fixture)
        compose.runOnIdle {
            val grid = Grid(anchor)
            val touch = Touch(fixture.surface!!)
            touch.down(0, grid.x(1), grid.y(grid.midRow))
            touch.pointerDown(1, grid.x(3), grid.y(grid.midRow))
            // Down by two whole cells: wheel up, twice, at the centroid's cell.
            touch.moveAllBy(grid.cellHeight * 2f)
            // Up by one whole cell: wheel down, once.
            touch.moveAllBy(-grid.cellHeight.toFloat())
            touch.pointerUp(1)
            touch.up()
            val row = grid.midRow + 1
            assertPackets(fixture, anchor,
                // The first finger's press was already forwarded, so it is released, under
                // its own anchor and at its own cell, before the wheel begins.
                "\u001b[<0;2;${row}M", "\u001b[<3;2;${row}m",
                "\u001b[<64;3;${row}M", "\u001b[<64;3;${row}M",
                "\u001b[<65;3;${row}M",
            )
            // Neither the swipe nor its fingers asked for the keyboard.
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
            assertFalse(fixture.surface!!.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true)
        }
    }

    @Test fun repeatedSmallMovesCarryTheirFractionAndOneMoveIsBounded() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitMouseProof(fixture)
        compose.runOnIdle {
            val grid = Grid(anchor)
            val touch = Touch(fixture.surface!!)
            touch.down(0, grid.x(1), grid.y(grid.midRow))
            touch.pointerDown(1, grid.x(3), grid.y(grid.midRow))
            fixture.packets.clear()
            val small = maxOf(1, grid.cellHeight * 2 / 5)
            repeat(7) { touch.moveAllBy(-small.toFloat()) }
            val expected = (7 * small) / grid.cellHeight
            val row = grid.midRow + 1
            assertPackets(fixture, anchor, *Array(expected) { "\u001b[<65;3;${row}M" })
            fixture.packets.clear()
            // One huge move is at most the per-move bound; the excess is dropped, not queued.
            touch.moveAllBy(grid.cellHeight * 40f)
            touch.moveAllBy(0f)
            assertPackets(fixture, anchor,
                *Array(TwoFingerWheelGesture.MAX_STEPS_PER_MOVE) { "\u001b[<64;3;${row}M" })
            fixture.packets.clear()
            // Horizontal travel is not wheel evidence.
            repeat(4) { touch.moveAllBy(grid.cellHeight / 4f, dx = grid.cellWidth * 3f) }
            touch.pointerUp(0)
            touch.up()
            assertTrue(fixture.packets.isEmpty())
        }
    }

    @Test fun oneFingerDragTapAndThePhysicalWheelKeepTheirExactReports() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitMouseProof(fixture)
        compose.runOnIdle {
            val grid = Grid(anchor)
            val surface = fixture.surface!!
            val row = grid.midRow
            val drag = Touch(surface)
            drag.down(0, grid.x(1), grid.y(row))
            drag.moveTo(0, grid.x(4), grid.y(row + 1))
            drag.up()
            val tap = Touch(surface)
            tap.down(0, grid.x(2), grid.y(row))
            tap.up()
            assertPackets(fixture, anchor,
                "\u001b[<0;2;${row + 1}M", "\u001b[<32;5;${row + 2}M", "\u001b[<3;5;${row + 2}m",
                "\u001b[<0;3;${row + 1}M", "\u001b[<3;3;${row + 1}m",
            )
            fixture.packets.clear()
            assertTrue(scroll(surface, grid.x(6), grid.y(row), 1f))
            assertTrue(scroll(surface, grid.x(6), grid.y(row), -1f))
            assertPackets(fixture, anchor, "\u001b[<64;7;${row + 1}M", "\u001b[<65;7;${row + 1}M")
            assertTrue(fixture.intents.none { it.intent is ClientIntent.SetTerminalKeyboardVisible })
        }
    }

    @Test fun pointersAreFollowedByIdWhateverIndexTheEventListsThemAt() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitMouseProof(fixture)
        compose.runOnIdle {
            val grid = Grid(anchor)
            val touch = Touch(fixture.surface!!)
            // The second finger has the lower id and lands at index 0.
            touch.down(5, grid.x(1), grid.y(grid.midRow))
            touch.pointerDown(2, grid.x(3), grid.y(grid.midRow), order = listOf(2, 5))
            fixture.packets.clear()
            // Only finger 5 moves, by two cells: the centroid moves by one.
            touch.moveTo(5, grid.x(1), grid.y(grid.midRow) + grid.cellHeight * 2f, order = listOf(5, 2))
            // Same fingers listed in the other order; only finger 2 moves, by two cells down.
            touch.moveTo(2, grid.x(3), grid.y(grid.midRow) + grid.cellHeight * 2f, order = listOf(2, 5))
            touch.pointerUp(2)
            touch.up()
            val row = grid.midRow + 1
            assertPackets(fixture, anchor, "\u001b[<64;3;${row}M", "\u001b[<64;3;${row}M")
        }
    }

    @Test fun aThirdFingerALiftOrACancelNeverPressesReleasesOrReplays() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitMouseProof(fixture)
        compose.runOnIdle {
            val grid = Grid(anchor)
            val surface = fixture.surface!!
            val row = grid.midRow + 1
            val third = Touch(surface)
            third.down(0, grid.x(1), grid.y(grid.midRow))
            third.pointerDown(1, grid.x(3), grid.y(grid.midRow))
            fixture.packets.clear()
            third.moveAllBy(grid.cellHeight.toFloat())
            assertPackets(fixture, anchor, "\u001b[<64;3;${row}M")
            fixture.packets.clear()
            third.pointerDown(2, grid.x(5), grid.y(grid.midRow))
            third.moveAllBy(grid.cellHeight * 3f)
            third.pointerUp(2)
            third.moveAllBy(grid.cellHeight * 3f)
            third.pointerUp(1)
            // The remaining finger is not quietly restarted as a press or a drag.
            third.moveAllBy(grid.cellHeight * 3f)
            third.moveTo(0, grid.x(6), grid.y(grid.midRow))
            third.up()
            assertTrue("A finished wheel reports nothing: ${fixture.packets}", fixture.packets.isEmpty())

            val lifted = Touch(surface)
            lifted.down(0, grid.x(1), grid.y(grid.midRow))
            lifted.pointerDown(1, grid.x(3), grid.y(grid.midRow))
            fixture.packets.clear()
            lifted.pointerUp(0)
            lifted.moveAllBy(grid.cellHeight * 3f)
            lifted.up()
            assertTrue(fixture.packets.isEmpty())

            val cancelled = Touch(surface)
            cancelled.down(0, grid.x(1), grid.y(grid.midRow))
            cancelled.pointerDown(1, grid.x(3), grid.y(grid.midRow))
            fixture.packets.clear()
            cancelled.moveAllBy(grid.cellHeight / 2f)
            cancelled.cancel()
            assertTrue("A cancelled wheel neither releases nor replays", fixture.packets.isEmpty())

            // A fresh first finger is an ordinary press again.
            val fresh = Touch(surface)
            fresh.down(0, grid.x(2), grid.y(grid.midRow))
            fresh.up()
            assertPackets(fixture, anchor, "\u001b[<0;3;${row}M", "\u001b[<3;3;${row}m")
        }
    }

    @Test fun noMouseModeNoSourceOrNoCommittedProofMeansNoPacketsAndNoRevival() {
        // The fixture's own modes do not track the mouse at all.
        val untracked = terminalFixture()
        compose.setContent { untracked.Content() }
        val plain = awaitInput(untracked)
        compose.runOnIdle {
            assertEquals(MouseTrackingMode.NONE, plain.modes.mouseTracking)
            swipe(untracked.surface!!, Grid(plain), cells = 3)
            assertTrue(untracked.packets.isEmpty())
            assertTrue(untracked.refusals.contains(InputUnavailableReason.MOUSE_REPORTING_OFF))
        }
    }

    @Test fun aSourcelessFrameNeverCarriesWheelReports() {
        val fixture = NativeUiFixture(NativeUiFixtures.sessions().copy(
            route = ClientRoute.Terminal(NativeUiFixtures.terminal()),
        )).apply { binding = NativeUiFixtures.binding(sourced = false) }
        compose.setContent { fixture.Content() }
        // The display commit of a mouse-tracking snapshot that states no source.
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                val binding = fixture.binding
                if (binding != null && binding.modes != MOUSE) install(fixture, binding.copy(modes = MOUSE))
                fixture.surface?.currentReceipt()?.modes == MOUSE
            }
        }
        compose.runOnIdle {
            val display = requireNotNull(fixture.surface!!.currentReceipt())
            assertNull(fixture.surface!!.currentInputProof())
            swipe(fixture.surface!!, Grid(display), cells = 3)
            assertTrue(fixture.packets.isEmpty())
            assertTrue(fixture.refusals.contains(InputUnavailableReason.SOURCE_ABSENT))
        }
    }

    @Test fun aWheelBegunWithoutACommittedProofIsNotRevivedByTheNextCommit() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitMouseProof(fixture)
        val grid = Grid(anchor)
        val touch = compose.runOnIdle {
            val surface = fixture.surface!!
            surface.invalidateCommittedFrame(InputUnavailableReason.POLICY_RETIRED)
            Touch(surface).also {
                it.down(0, grid.x(1), grid.y(grid.midRow))
                it.pointerDown(1, grid.x(3), grid.y(grid.midRow))
                it.moveAllBy(grid.cellHeight * 2f)
                assertTrue(fixture.packets.isEmpty())
                // Ask for the pass that earns the fresh commit.
                surface.invalidate()
            }
        }
        val fresh = awaitMouseProof(fixture)
        compose.runOnIdle {
            assertNotEquals(anchor, fresh)
            touch.moveAllBy(grid.cellHeight * 2f)
            touch.pointerUp(1)
            touch.up()
            assertTrue("A fresh receipt does not license an earlier gesture", fixture.packets.isEmpty())
        }
    }

    @Test fun genuineChangesMidSwipeEndItAndAFreshCommitNeverRevivesIt() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        awaitMouseProof(fixture)
        val disruptions = listOf<Pair<String, (NativeUiFixture) -> Unit>>(
            "input context" to { f: NativeUiFixture -> install(f, f.binding!!.copy(inputGeneration = f.binding!!.inputGeneration + 1)) },
            "policy" to { f: NativeUiFixture ->
                f.surface!!.invalidateCommittedFrame(InputUnavailableReason.POLICY_RETIRED)
                install(f, f.binding!!.copy(policyGeneration = f.binding!!.policyGeneration + 1))
            },
            "focus" to { f: NativeUiFixture ->
                f.surface!!.clearFocus()
                assertTrue(f.surface!!.requestFocus())
            },
            "coverage" to { f: NativeUiFixture ->
                f.surface!!.setModalSuspended(true)
                f.surface!!.setModalSuspended(false)
            },
            "A-B-A" to { f: NativeUiFixture ->
                val a = f.binding!!
                install(f, a.copy(modes = a.modes.copy(mouseTracking = MouseTrackingMode.ANY)))
                install(f, a)
            },
            "layout" to { f: NativeUiFixture ->
                val surface = f.surface!!
                surface.layout(surface.left, surface.top, surface.right, surface.bottom - 1)
            },
        )
        for ((label, disrupt) in disruptions) {
            val anchor = awaitMouseProof(fixture)
            val grid = Grid(anchor)
            val row = grid.midRow + 1
            val touch = compose.runOnIdle {
                Touch(fixture.surface!!).also {
                    it.down(0, grid.x(1), grid.y(grid.midRow))
                    it.pointerDown(1, grid.x(3), grid.y(grid.midRow))
                    fixture.packets.clear()
                    it.moveAllBy(grid.cellHeight.toFloat())
                    assertPackets(fixture, anchor, "\u001b[<64;3;${row}M")
                    fixture.packets.clear()
                    disrupt(fixture)
                    assertFalse(label, fixture.surface!!.verifyReceipt(anchor))
                    it.moveAllBy(grid.cellHeight * 2f)
                    assertTrue("$label: retired mid-swipe", fixture.packets.isEmpty())
                }
            }
            val fresh = awaitMouseProof(fixture)
            compose.runOnIdle {
                assertNotEquals(label, anchor, fresh)
                touch.moveAllBy(grid.cellHeight * 2f)
                touch.pointerUp(1)
                touch.moveAllBy(grid.cellHeight * 2f)
                touch.up()
                assertTrue("$label: never revived by a fresh commit: ${fixture.packets}", fixture.packets.isEmpty())
            }
        }
    }

    @Test fun ordinarySameContextOutputAndItsNewCommitsKeepTheSwipeAndItsProgress() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        val anchor = awaitMouseProof(fixture)
        val grid = Grid(anchor)
        val row = grid.midRow + 1
        val half = grid.cellHeight / 2f
        val touch = compose.runOnIdle {
            Touch(fixture.surface!!).also {
                it.down(0, grid.x(1), grid.y(grid.midRow))
                it.pointerDown(1, grid.x(3), grid.y(grid.midRow))
                fixture.packets.clear()
                // Half a cell of progress, carried across the output below.
                it.moveAllBy(half)
                repeat(10) { install(fixture, output(fixture.binding!!)) }
                assertTrue(fixture.packets.isEmpty())
            }
        }
        val newest = compose.runOnIdle { fixture.binding!!.publishSequence }
        compose.waitUntil(10_000) { fixture.receipts.any { it.publishSequence == newest } }
        compose.runOnIdle {
            val surface = fixture.surface!!
            assertEquals(anchor, surface.currentInputProof())
            // The other half completes the carried cell, against the same anchor.
            touch.moveAllBy(grid.cellHeight - half)
            assertPackets(fixture, anchor, "\u001b[<64;3;${row}M")
            fixture.packets.clear()
            install(fixture, output(fixture.binding!!))
            touch.moveAllBy(grid.cellHeight * 2f)
            touch.pointerUp(1)
            touch.up()
            assertPackets(fixture, anchor, "\u001b[<64;3;${row}M", "\u001b[<64;3;${row}M")
        }
    }

    @Test fun aOneFingerGestureRetiredBeforeItEndsNeverReportsUnderTheNextProof() {
        val fixture = terminalFixture()
        compose.setContent { fixture.Content() }
        for (ending in listOf("second finger", "up", "cancel")) {
            val first = awaitMouseProof(fixture)
            val grid = Grid(first)
            val row = grid.midRow + 1
            val touch = compose.runOnIdle {
                val surface = fixture.surface!!
                fixture.packets.clear()
                Touch(surface).also {
                    it.down(0, grid.x(1), grid.y(grid.midRow))
                    assertPackets(fixture, first, "\u001b[<0;2;${row}M")
                    fixture.packets.clear()
                    // A genuine context change while the first finger is still down.
                    install(fixture, fixture.binding!!.copy(inputGeneration = fixture.binding!!.inputGeneration + 1))
                    assertFalse(ending, surface.verifyReceipt(first))
                }
            }
            // A real platform commit of the new context stands before the gesture goes on.
            val next = awaitMouseProof(fixture)
            compose.runOnIdle {
                val surface = fixture.surface!!
                assertNotEquals(ending, first, next)
                touch.moveTo(0, grid.x(2), grid.y(grid.midRow))
                when (ending) {
                    "second finger" -> {
                        touch.pointerDown(1, grid.x(4), grid.y(grid.midRow))
                        touch.moveAllBy(grid.cellHeight * 2f)
                        touch.pointerUp(1)
                        touch.up()
                    }
                    "up" -> touch.up()
                    else -> touch.cancel()
                }
                assertTrue("$ending: nothing against the next proof: ${fixture.packets}", fixture.packets.isEmpty())
                // Only a fresh first finger reports again, and against the new proof.
                val fresh = Touch(surface)
                fresh.down(0, grid.x(2), grid.y(grid.midRow))
                fresh.up()
                assertPackets(fixture, next, "\u001b[<0;3;${row}M", "\u001b[<3;3;${row}m")
                fixture.packets.clear()
            }
        }
    }

    /** Synthesized touchscreen pointers, dispatched straight into the pane by id. */
    private class Touch(private val surface: TerminalSurfaceView) {
        private class Finger(var x: Float, var y: Float)

        private val downTime = SystemClock.uptimeMillis()
        private var eventTime = downTime
        private val fingers = LinkedHashMap<Int, Finger>()

        fun down(id: Int, x: Float, y: Float) {
            fingers.clear()
            fingers[id] = Finger(x, y)
            send(MotionEvent.ACTION_DOWN, fingers.keys.toList(), id)
        }

        fun pointerDown(id: Int, x: Float, y: Float, order: List<Int>? = null) {
            fingers[id] = Finger(x, y)
            send(MotionEvent.ACTION_POINTER_DOWN, order ?: fingers.keys.toList(), id)
        }

        fun moveAllBy(dy: Float, dx: Float = 0f) {
            for (finger in fingers.values) {
                finger.x += dx
                finger.y += dy
            }
            send(MotionEvent.ACTION_MOVE, fingers.keys.toList(), null)
        }

        fun moveTo(id: Int, x: Float, y: Float, order: List<Int>? = null) {
            val finger = requireNotNull(fingers[id])
            finger.x = x
            finger.y = y
            send(MotionEvent.ACTION_MOVE, order ?: fingers.keys.toList(), null)
        }

        fun pointerUp(id: Int) {
            send(MotionEvent.ACTION_POINTER_UP, fingers.keys.toList(), id)
            fingers.remove(id)
        }

        fun up() {
            send(MotionEvent.ACTION_UP, fingers.keys.toList(), null)
            fingers.clear()
        }

        fun cancel() {
            send(MotionEvent.ACTION_CANCEL, fingers.keys.toList(), null)
            fingers.clear()
        }

        private fun send(action: Int, order: List<Int>, actionId: Int?) {
            require(order.toSet() == fingers.keys) { "every finger, each once" }
            val properties = Array(order.size) { index ->
                MotionEvent.PointerProperties().apply {
                    id = order[index]
                    toolType = MotionEvent.TOOL_TYPE_FINGER
                }
            }
            val coords = Array(order.size) { index ->
                val finger = fingers.getValue(order[index])
                MotionEvent.PointerCoords().apply {
                    x = finger.x
                    y = finger.y
                    pressure = 1f
                    size = 1f
                }
            }
            val index = actionId?.let { order.indexOf(it) } ?: 0
            eventTime += 8
            val event = MotionEvent.obtain(
                downTime, eventTime, action or (index shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                order.size, properties, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0,
            )
            try {
                surface.dispatchTouchEvent(event)
            } finally {
                event.recycle()
            }
        }
    }

    /** Pixel centres of the committed content's cells, from the receipt's own rectangle. */
    private class Grid(receipt: FrameCommitReceipt) {
        private val left = receipt.contentRect.left
        private val top = receipt.contentRect.top
        val cellWidth = receipt.contentRect.width / receipt.drawnColumns
        val cellHeight = receipt.contentRect.height / receipt.drawnRows
        val midRow = receipt.drawnRows / 2

        init {
            assertTrue("A measured grid", cellWidth > 0 && cellHeight > 0)
            assertTrue("Room for the fingers", receipt.drawnColumns >= 8)
        }

        fun x(column: Int): Float = left + cellWidth * column + cellWidth / 2f
        fun y(row: Int): Float = top + cellHeight * row + cellHeight / 2f
    }

    private fun swipe(surface: TerminalSurfaceView, grid: Grid, cells: Int) {
        val touch = Touch(surface)
        touch.down(0, grid.x(1), grid.y(grid.midRow))
        touch.pointerDown(1, grid.x(3), grid.y(grid.midRow))
        repeat(cells) { touch.moveAllBy(grid.cellHeight.toFloat()) }
        touch.pointerUp(1)
        touch.up()
    }

    /** One physical mouse wheel notch, dispatched the way the platform delivers it. */
    private fun scroll(surface: TerminalSurfaceView, x: Float, y: Float, vertical: Float): Boolean {
        val now = SystemClock.uptimeMillis()
        val properties = arrayOf(MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_MOUSE
        })
        val coords = arrayOf(MotionEvent.PointerCoords().apply {
            this.x = x
            this.y = y
            setAxisValue(MotionEvent.AXIS_VSCROLL, vertical)
        })
        val event = MotionEvent.obtain(now, now, MotionEvent.ACTION_SCROLL, 1, properties, coords, 0, 0, 1f, 1f, 0, 0,
            InputDevice.SOURCE_MOUSE, 0)
        try {
            return surface.dispatchGenericMotionEvent(event)
        } finally {
            event.recycle()
        }
    }

    private fun assertPackets(fixture: NativeUiFixture, anchor: FrameCommitReceipt, vararg expected: String) {
        val actual = fixture.packets.toList()
        assertEquals("packets ${actual.map { String(it.bytes, Charsets.UTF_8) }}", expected.size, actual.size)
        expected.forEachIndexed { index, bytes ->
            val packet = actual[index]
            assertEquals(NativeIoInputKind.MOUSE, packet.kind)
            assertArrayEquals("packet $index", bytes.toByteArray(Charsets.UTF_8), packet.bytes)
            assertEquals("packet $index", anchor, packet.receipt)
            assertTrue("packet $index", packet.verifiedAtCapture)
        }
    }

    private fun install(fixture: NativeUiFixture, binding: TerminalViewBinding) {
        fixture.surface!!.setBinding(binding)
        fixture.binding = binding
    }

    /** Ordinary output: same context, newer publish, different displayed text. */
    private fun output(binding: TerminalViewBinding): TerminalViewBinding {
        val sequence = binding.publishSequence + 1
        return binding.copy(
            publishSequence = sequence,
            frame = binding.frame.copy(lines = binding.frame.lines.mapIndexed { row, _ ->
                "\u001b[0m${"Output $sequence row $row".take(binding.frame.cols).padEnd(binding.frame.cols)}\u001b[0m"
            }),
        )
    }

    private fun terminalFixture() = NativeUiFixture(NativeUiFixtures.sessions().copy(
        route = ClientRoute.Terminal(NativeUiFixtures.terminal()),
    )).apply { binding = NativeUiFixtures.binding(sourced = true) }

    /**
     * The standing proof once the owner's snapshot asks for button and drag reports in
     * SGR encoding. The shared fixture answers every viewport request with its own
     * untracked modes, so the mouse modes are installed — as a genuine context change
     * that has to earn its own commit — whenever the standing proof lacks them.
     */
    private fun awaitMouseProof(fixture: NativeUiFixture): FrameCommitReceipt {
        var proof: FrameCommitReceipt? = null
        compose.waitUntil(10_000) {
            proof = compose.runOnIdle {
                val surface = fixture.surface ?: return@runOnIdle null
                val binding = fixture.binding ?: return@runOnIdle null
                if (binding.modes != MOUSE) install(fixture, binding.copy(modes = MOUSE))
                surface.currentInputProof()?.takeIf { it.modes == MOUSE && surface.verifyReceipt(it) }
            }
            proof != null
        }
        return requireNotNull(proof)
    }

    private fun awaitInput(fixture: NativeUiFixture): FrameCommitReceipt {
        var committed: FrameCommitReceipt? = null
        compose.waitUntil(10_000) {
            committed = compose.runOnIdle { fixture.surface?.currentInputProof() }
            committed != null
        }
        return requireNotNull(committed)
    }

    private companion object {
        val MOUSE = TerminalInputModes(0, false, false, true, MouseTrackingMode.DRAG, 0, MouseEncodingMode.SGR)
    }
}
