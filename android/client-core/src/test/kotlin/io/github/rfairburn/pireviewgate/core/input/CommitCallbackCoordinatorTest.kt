package io.github.rfairburn.pireviewgate.core.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommitCallbackCoordinatorTest {
	private val reported = mutableListOf<Long>()
	private val coordinator = CommitCallbackCoordinator { reported += it }

	@Test
	fun `a registration reports its own epoch once`() {
		val registration = coordinator.begin(7L)
		registration.report()
		assertEquals(listOf(7L), reported)
		registration.report()
		assertEquals(listOf(7L), reported)
		assertFalse(coordinator.hasActiveRegistration)
	}

	@Test
	fun `a superseded registration reports nothing`() {
		val first = coordinator.begin(1L)
		val second = coordinator.begin(2L)
		first.report()
		// The late callback for the retired pass must not consume the newer request.
		assertEquals(emptyList<Long>(), reported)
		assertTrue(coordinator.hasActiveRegistration)
		assertEquals(2L, coordinator.activeDrawEpoch)
		second.report()
		assertEquals(listOf(2L), reported)
	}

	@Test
	fun `a withdrawn registration reports nothing`() {
		val registration = coordinator.begin(3L)
		coordinator.withdraw()
		registration.report()
		assertEquals(emptyList<Long>(), reported)
		assertNull(coordinator.activeDrawEpoch)
	}

	@Test
	fun `rebind then draw leaves the newest draw able to report`() {
		// The exact ordering that used to strand a surface with no live callback:
		// draw A pending, the binding or layout changes, draw B happens, and only
		// then does callback A arrive.
		val gate = CommittedFrameGate()
		gate.rebind()
		val drawA = gate.beginDraw()
		val registrationA = coordinator.begin(drawA)
		gate.rebind()
		val drawB = gate.beginDraw()
		val registrationB = coordinator.begin(drawB)

		registrationA.report()
		assertEquals(emptyList<Long>(), reported)
		assertNull(gate.onFrameCommit(drawA))

		registrationB.report()
		assertEquals(listOf(drawB), reported)
		assertTrue(gate.isCurrent(gate.onFrameCommit(drawB, eligible = true)))
	}
}
