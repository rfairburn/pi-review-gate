package io.github.rfairburn.pireviewgate.core.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeCompositionModelTest {
	/** One supplementary character: two UTF-16 units, one thing a person typed. */
	private val face = "\uD83D\uDE00"

	@Test
	fun `commit replaces the composition instead of appending to it`() {
		val model = ImeCompositionModel()
		model.setComposing("hel")
		assertEquals("hello", model.commit("hello"))
		assertFalse(model.hasComposition)
	}

	@Test
	fun `a commit with no replacement sends nothing`() {
		val model = ImeCompositionModel()
		model.setComposing("hel")
		assertEquals("", model.commit(""))
		assertFalse(model.hasComposition)
	}

	@Test
	fun `finishing a composition sends the kept text once`() {
		val model = ImeCompositionModel()
		model.setComposing("你好")
		assertEquals("你好", model.finishComposition())
		assertEquals("", model.finishComposition())
	}

	@Test
	fun `deletion consumes the composition before it means a backspace`() {
		val model = ImeCompositionModel()
		model.setComposing("hel")
		assertEquals(0, model.deleteSurrounding(1, 0))
		assertEquals("he", model.composingText)
		assertEquals(0, model.deleteSurrounding(2, 0))
		assertEquals("", model.composingText)
		// Only now is a deletion a keystroke into the owner's screen.
		assertEquals(1, model.deleteSurrounding(1, 0))
	}

	@Test
	fun `a deletion longer than the composition leaves the remainder`() {
		val model = ImeCompositionModel()
		model.setComposing("ab")
		assertEquals(3, model.deleteSurrounding(5, 0))
		assertEquals("", model.composingText)
	}

	@Test
	fun `forward deletion is never invented`() {
		val model = ImeCompositionModel()
		model.setComposing("abc")
		assertEquals(0, model.deleteSurrounding(0, 4))
		assertEquals("abc", model.composingText)
	}

	@Test
	fun `discarding drops text that was never committed`() {
		val model = ImeCompositionModel()
		model.setComposing("latent")
		model.discard()
		assertFalse(model.hasComposition)
		assertEquals("", model.finishComposition())
	}

	@Test
	fun `setting an empty composition clears it`() {
		val model = ImeCompositionModel()
		model.setComposing("x")
		model.setComposing("")
		assertFalse(model.hasComposition)
		model.setComposing("y")
		model.setComposing(null)
		assertTrue(!model.hasComposition)
	}

	@Test
	fun `a composition larger than one commit may carry is refused rather than retained`() {
		val model = ImeCompositionModel()
		val atTheCeiling = "a".repeat(ImeCompositionModel.MAX_COMPOSING_CODEPOINTS)
		val above = "a".repeat(ImeCompositionModel.MAX_COMPOSING_CODEPOINTS + 1)
		assertTrue(model.setComposing(atTheCeiling))
		assertEquals(atTheCeiling, model.composingText)
		assertFalse(model.setComposing(above))
		assertFalse("nothing oversized is retained", model.hasComposition)
		assertEquals("and nothing is truncated to fit", "", model.composingText)
	}

	@Test
	fun `the composition ceiling counts unicode scalars`() {
		val model = ImeCompositionModel()
		assertTrue(model.setComposing(face.repeat(ImeCompositionModel.MAX_COMPOSING_CODEPOINTS)))
		assertFalse(model.setComposing(face.repeat(ImeCompositionModel.MAX_COMPOSING_CODEPOINTS + 1)))
	}

	@Test
	fun `the composition ceiling is the commit ceiling`() {
		// Whatever is retained has to be committable, so the two bounds can never
		// disagree and leave a composition that could only ever be refused later.
		assertEquals(
			ImeCommitEncoder.MAX_COMMIT_CODEPOINTS,
			ImeCompositionModel.MAX_COMPOSING_CODEPOINTS,
		)
	}

	@Test
	fun `deleting within a surrogate pair preserves the remaining composition`() {
		// The cut is counted in UTF-16 units, and a supplementary character is two of
		// them. Bisecting one would leave a lone high surrogate behind, and the rest of
		// the composition — the perfectly good 'A' — would then be unwireable.
		val model = ImeCompositionModel()
		assertTrue(model.setComposing("A$face"))
		assertEquals("nothing was owed to the host", 0, model.deleteSurrounding(1, 0))
		assertEquals("A", model.composingText)
		assertEquals("A", model.finishComposition())
	}

	@Test
	fun `deleting a whole supplementary character asks the host for nothing`() {
		val model = ImeCompositionModel()
		assertTrue(model.setComposing(face + face))
		assertEquals(0, model.deleteSurrounding(2, 0))
		assertEquals(face, model.composingText)
	}

	@Test
	fun `deleting beyond supplementary composition returns only the excess`() {
		val model = ImeCompositionModel()
		assertTrue(model.setComposing(face))
		assertEquals(1, model.deleteSurrounding(3, 0))
		assertEquals("", model.composingText)
		assertFalse(model.hasComposition)
	}

	@Test
	fun `code point deletion consumes each supplementary scalar once`() {
		val model = ImeCompositionModel()
		assertTrue(model.setComposing("A$face$face"))
		assertEquals(0, model.deleteSurroundingInCodePoints(1, 0))
		assertEquals("A$face", model.composingText)
		assertEquals(0, model.deleteSurroundingInCodePoints(1, 0))
		assertEquals("A", model.finishComposition())
		assertEquals(1, model.deleteSurroundingInCodePoints(1, 0))
	}

	@Test
	fun `code point deletion returns only the excess beyond mixed composition`() {
		val model = ImeCompositionModel()
		assertTrue(model.setComposing("A$face"))
		assertEquals(3, model.deleteSurroundingInCodePoints(5, 0))
		assertFalse(model.hasComposition)
		assertEquals("", model.finishComposition())
		assertTrue(model.setComposing(face))
		assertEquals(1, model.deleteSurroundingInCodePoints(2, 0))
		assertFalse(model.hasComposition)
	}

	@Test
	fun `code point deletion keeps existing nonpositive and forward deletion semantics`() {
		val model = ImeCompositionModel()
		assertTrue(model.setComposing("A$face"))
		assertEquals(0, model.deleteSurroundingInCodePoints(0, 4))
		assertEquals(0, model.deleteSurroundingInCodePoints(-1, 0))
		assertEquals("A$face", model.composingText)
		// afterLength has no effect, just as on the UTF-16 path.
		assertEquals(0, model.deleteSurroundingInCodePoints(1, -1))
		assertEquals("A", model.composingText)
	}

	@Test
	fun `code point deletion passes the full remainder through for surface bounds`() {
		val model = ImeCompositionModel()
		assertEquals(ImeCommitEncoder.MAX_DELETION_REQUEST,
			model.deleteSurroundingInCodePoints(ImeCommitEncoder.MAX_DELETION_REQUEST, 0))
		assertEquals(ImeCommitEncoder.MAX_DELETION_REQUEST + 1,
			model.deleteSurroundingInCodePoints(ImeCommitEncoder.MAX_DELETION_REQUEST + 1, 0))
		assertTrue(model.setComposing(face))
		assertEquals(Int.MAX_VALUE - 1, model.deleteSurroundingInCodePoints(Int.MAX_VALUE, 0))
		assertFalse(model.hasComposition)
	}

	@Test
	fun `a deletion request with nothing composed is passed through at any size`() {
		// The model never clamps. What it hands back is exactly what the surface is
		// asked to delete, so one place decides the ceiling and an oversized request is
		// refused whole instead of being quietly shortened.
		val model = ImeCompositionModel()
		assertEquals(ImeCommitEncoder.MAX_DELETION_REQUEST, model.deleteSurrounding(ImeCommitEncoder.MAX_DELETION_REQUEST, 0))
		assertEquals(ImeCommitEncoder.MAX_DELETION_REQUEST + 1, model.deleteSurrounding(ImeCommitEncoder.MAX_DELETION_REQUEST + 1, 0))
		assertEquals(0, model.deleteSurrounding(0, 0))
	}
}
