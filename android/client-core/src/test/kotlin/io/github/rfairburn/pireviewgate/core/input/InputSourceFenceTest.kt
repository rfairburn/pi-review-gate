package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoStartupSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeSessionRef
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a published view may be shown for, and what may be typed at it.
 *
 * The cases are the ones the phone cannot see from its own screen: a publish that
 * states no source at all, a publish whose source names somebody else, and the
 * transitions in between. A viewport snapshot is complete on its own, so a
 * source-less publish stays a drawn terminal; what it loses is input attribution,
 * and that loss has to be exact — including the fact that an A → B → A change is
 * never the original A again.
 */
class InputSourceFenceTest {
	private fun source(
		hostRunId: String = "run-1",
		sessionId: String = "row-1",
		nativeSession: NativeSessionRef = NativeSessionRef("native-1", 3L),
		geometry: SessionGeometry = SessionGeometry(cols = 80, rows = 24, revision = 7L),
		viewerRevision: Long = 1L,
		sourceToken: String = "token-a",
	): NativeIoSource = NativeIoSource(
		hostRunId = hostRunId,
		sessionId = sessionId,
		nativeSession = nativeSession,
		geometry = geometry,
		viewerRevision = viewerRevision,
		sourceToken = sourceToken,
	)

	private fun startupSource(
		hostRunId: String = "run-1",
		sessionId: String = "row-1",
		geometry: SessionGeometry = SessionGeometry(cols = 80, rows = 24, revision = 7L),
		viewerRevision: Long = 1L,
		sourceToken: String = "token-a",
	): NativeIoStartupSource = NativeIoStartupSource(
		hostRunId = hostRunId,
		sessionId = sessionId,
		geometry = geometry,
		viewerRevision = viewerRevision,
		sourceToken = sourceToken,
	)

	@Test
	fun aPublishThatStatesNoSourceIsDisplayOnlyRatherThanRefused() {
		assertEquals(InputSourceState.DISPLAY_ONLY, InputSourceFence.state(null, "run-1", "row-1"))
		assertFalse(InputSourceFence.authorizesInput(null))
	}

	@Test
	fun aSourceThatNamesItsOwnTargetIsStatedAndCarriesInput() {
		val stated = source()
		assertEquals(InputSourceState.STATED, InputSourceFence.state(stated, "run-1", "row-1"))
		assertTrue(InputSourceFence.authorizesInput(stated))
	}

	@Test
	fun aSourceNamingAnotherRunOrRowIsContradictory() {
		assertEquals(
			InputSourceState.CONTRADICTORY,
			InputSourceFence.state(source(hostRunId = "run-2"), "run-1", "row-1"),
		)
		assertEquals(
			InputSourceState.CONTRADICTORY,
			InputSourceFence.state(source(sessionId = "row-2"), "run-1", "row-1"),
		)
	}

	@Test
	fun aStartupPhaseSourceIsStatedExactlyLikeAConversationSource() {
		assertEquals(InputSourceState.STATED, InputSourceFence.state(startupSource(), "run-1", "row-1"))
		assertTrue(InputSourceFence.authorizesInput(startupSource()))
	}

	@Test
	fun twoPublishesWithoutASourceAgree() {
		assertTrue(InputSourceFence.isSameSource(null, null))
	}

	@Test
	fun aSourceAppearingOrDisappearingIsNeverTheSameSource() {
		val stated = source()
		assertFalse(InputSourceFence.isSameSource(stated, null))
		assertFalse(InputSourceFence.isSameSource(null, stated))
	}

	@Test
	fun anExactRepeatOfTheSameSourceStillAgrees() {
		assertTrue(InputSourceFence.isSameSource(source(), source()))
	}

	@Test
	fun everyDifferenceInASourceIsANewSource() {
		val original = source()
		val variants = listOf(
			source(hostRunId = "run-2"),
			source(sessionId = "row-2"),
			source(nativeSession = NativeSessionRef("native-2", 3L)),
			source(nativeSession = NativeSessionRef("native-1", 4L)),
			source(geometry = SessionGeometry(cols = 80, rows = 24, revision = 8L)),
			source(geometry = SessionGeometry(cols = 90, rows = 24, revision = 7L)),
			source(viewerRevision = 2L),
			source(sourceToken = "token-b"),
		)
		for (variant in variants) {
			assertFalse("a changed source is a different source", InputSourceFence.isSameSource(original, variant))
		}
	}

	@Test
	fun aRoundTripBackToTheOlderSourceIsNotTheOlderSource() {
		val a = source(sourceToken = "token-a", viewerRevision = 1L)
		val b = source(sourceToken = "token-b", viewerRevision = 2L)
		assertFalse(InputSourceFence.isSameSource(a, b))
		assertFalse(InputSourceFence.isSameSource(b, a))
		// The rule is structural, not "different from the last one seen": a later
		// publish that repeats A's exact facts is A, and the phone's own staleness
		// checks against the publish sequence stay in charge of ordering.
		assertTrue(InputSourceFence.isSameSource(a, source(sourceToken = "token-a", viewerRevision = 1L)))
	}

	@Test
	fun aStartupSourceIsNeverAConversationSource() {
		assertFalse(InputSourceFence.isSameSource(source(), startupSource()))
		assertFalse(InputSourceFence.isSameSource(startupSource(), source()))
	}
}
