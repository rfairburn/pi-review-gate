package io.github.rfairburn.pireviewgate.core.input

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The receipt fence, with the platform's commit callback replaced by direct
 * calls. What is being proven is that a receipt only ever names the frame that
 * is really on screen, and stops naming it the moment anything changes.
 */
class CommittedFrameGateTest {

	@Test
	fun aCommitOnlyCountsForTheDrawPassThatReportedIt() {
		val gate = CommittedFrameGate()
		val draw = gate.beginDraw()
		assertTrue(gate.hasPendingDraw)
		val record = assertNotNull(gate.onFrameCommit(draw))
		assertFalse(gate.hasPendingDraw)
		assertTrue(gate.isCurrent(record))
		assertEquals(1, record.commitSequence)

		// A late report from an older pass is ignored.
		assertNull(gate.onFrameCommit(draw))
	}

	@Test
	fun onlyTheNewestPendingPassCanCommit() {
		val gate = CommittedFrameGate()
		val first = gate.beginDraw()
		val second = gate.beginDraw()
		assertNull(gate.onFrameCommit(first))
		assertNotNull(gate.onFrameCommit(second))
	}

	@Test
	fun aLayoutChangeRetiresTheReceipt() {
		val gate = CommittedFrameGate()
		val record = assertNotNull(gate.onFrameCommit(gate.beginDraw()))
		gate.invalidateLayout()
		assertNull(gate.committedRecord)
		assertFalse(gate.isCurrent(record))
	}

	@Test
	fun equalDimensionsAfterAResizeNeverReviveTheOldReceipt() {
		val gate = CommittedFrameGate()
		val first = assertNotNull(gate.onFrameCommit(gate.beginDraw()))
		// 80x24 again is a different viewport: the layout epoch moved.
		gate.invalidateLayout()
		val second = assertNotNull(gate.onFrameCommit(gate.beginDraw()))
		assertFalse(gate.isCurrent(first))
		assertTrue(gate.isCurrent(second))
		assertTrue(second.layoutEpoch > first.layoutEpoch)
		assertFalse(first == second)
	}

	@Test
	fun rebindingRetiresEverythingIncludingAPendingDraw() {
		val gate = CommittedFrameGate()
		val pending = gate.beginDraw()
		gate.rebind()
		assertNull(gate.committedRecord)
		assertFalse(gate.hasPendingDraw)
		assertNull(gate.onFrameCommit(pending))
	}

	@Test
	fun lifecycleLossRetiresTheCommitWithoutMovingEpochs() {
		val gate = CommittedFrameGate()
		val binding = gate.currentBindingEpoch
		val layout = gate.currentLayoutEpoch
		val record = assertNotNull(gate.onFrameCommit(gate.beginDraw()))
		gate.invalidateCommit(FrameInvalidationReason.FOCUS_LOST)
		assertNull(gate.committedRecord)
		assertFalse(gate.isCurrent(record))
		assertEquals(binding, gate.currentBindingEpoch)
		assertEquals(layout, gate.currentLayoutEpoch)
	}

	@Test
	fun aDrawThatNeverReportsLeavesNothingCommitted() {
		val gate = CommittedFrameGate()
		gate.beginDraw()
		assertNull(gate.committedRecord)
		assertTrue(gate.hasPendingDraw)
	}

	@Test
	fun invalidatingThroughLayoutOrBindingBehavesLikeTheDirectCalls() {
		val gate = CommittedFrameGate()
		val record = assertNotNull(gate.onFrameCommit(gate.beginDraw()))
		val layout = gate.currentLayoutEpoch
		gate.invalidateCommit(FrameInvalidationReason.LAYOUT_CHANGED)
		assertFalse(gate.isCurrent(record))
		assertEquals(layout + 1, gate.currentLayoutEpoch)
		// Only a new binding moves the binding epoch; invalidating through the
		// reason enum retires the commit without pretending a rebinding happened.
		val binding = gate.currentBindingEpoch
		gate.invalidateCommit(FrameInvalidationReason.BINDING_CHANGED)
		assertEquals(binding, gate.currentBindingEpoch)
		assertNull(gate.committedRecord)
	}
}
