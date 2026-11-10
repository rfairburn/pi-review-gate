package io.github.rfairburn.pireviewgate.core.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InputEligibilityTest {
	private fun eligible() = InputEligibility(
		attached = true,
		viewVisible = true,
		windowVisible = true,
		windowFocused = true,
		focused = true,
	)

	@Test
	fun `every condition holding is the only way to be eligible`() {
		val state = eligible()
		assertNull(state.blockReason())
		assertTrue(state.isEligible)
	}

	@Test
	fun `each unmet condition is reported`() {
		assertEquals(InputBlockReason.DETACHED, blocked { it.attached = false })
		assertEquals(InputBlockReason.NOT_VISIBLE, blocked { it.viewVisible = false })
		assertEquals(InputBlockReason.WINDOW_NOT_VISIBLE, blocked { it.windowVisible = false })
		assertEquals(InputBlockReason.WINDOW_NOT_FOCUSED, blocked { it.windowFocused = false })
		assertEquals(InputBlockReason.NOT_FOCUSED, blocked { it.focused = false })
		assertEquals(InputBlockReason.MODAL_SUSPENDED, blocked { it.modalSuspended = true })
		assertEquals(InputBlockReason.USER_INPUT_DISABLED, blocked { it.userInputEnabled = false })
	}

	private fun blocked(change: (InputEligibility) -> Unit): InputBlockReason? {
		val state = eligible()
		change(state)
		return state.blockReason()
	}

	@Test
	fun `a detached surface is not excused by being focused`() {
		val state = InputEligibility(
			attached = false,
			viewVisible = true,
			windowVisible = true,
			windowFocused = true,
			focused = true,
		)
		assertFalse(state.isEligible)
	}
}

class CommittedFrameGateEligibilityTest {
	private fun bound(): CommittedFrameGate {
		val gate = CommittedFrameGate()
		gate.rebind()
		return gate
	}

	private fun commit(gate: CommittedFrameGate, eligible: Boolean): FrameCommitRecord? =
		gate.onFrameCommit(gate.beginDraw(), eligible)

	@Test
	fun `an eligible commit is recorded`() {
		val gate = bound()
		val record = commit(gate, eligible = true)
		assertTrue(gate.isCurrent(record))
	}

	@Test
	fun `a commit that landed while ineligible records nothing`() {
		val gate = bound()
		assertNull(commit(gate, eligible = false))
		assertNull(gate.committedRecord)
	}

	@Test
	fun `resuming input cannot revive a commit drawn during the suspension`() {
		val gate = bound()
		// Drawn while a modal covered the surface.
		assertNull(commit(gate, eligible = false))
		// Input comes back with no new draw: there is still nothing to attest to.
		assertNull(gate.committedRecord)
		// Only a fresh draw, made while eligible, establishes a receipt.
		val record = commit(gate, eligible = true)
		assertTrue(gate.isCurrent(record))
	}

	@Test
	fun `an ineligible commit also retires the previous receipt`() {
		val gate = bound()
		val first = commit(gate, eligible = true)
		assertTrue(gate.isCurrent(first))
		assertNull(commit(gate, eligible = false))
		assertFalse(gate.isCurrent(first))
		assertNull(gate.committedRecord)
	}
}
