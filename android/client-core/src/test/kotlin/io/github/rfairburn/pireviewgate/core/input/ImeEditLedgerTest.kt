package io.github.rfairburn.pireviewgate.core.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImeEditLedgerTest {
	private val face = "😀"

	/** Make [plan] leave, exactly as a connection would after a complete hand-off. */
	private fun ImeEditLedger.send(plan: ImeEditPlan?): Pair<Int, String> {
		requireNotNull(plan)
		assertTrue(apply(plan))
		return plan.deletions to plan.text
	}

	private fun typed(text: String) = ImeEditLedger().also { it.send(it.commitText(text)) }

	@Test
	fun `an empty ledger answers exactly what an empty editor does`() {
		val ledger = ImeEditLedger()
		assertEquals("", ledger.document)
		assertEquals("", ledger.textBeforeCursor(100))
		assertNull(ledger.selectedText())
		assertEquals(0, ledger.selectionStartOffset)
		assertEquals(0, ledger.selectionEnd)
		assertEquals(-1, ledger.compositionStart)
		assertEquals(-1, ledger.compositionEnd)
		assertEquals("" to 0, ledger.surroundingText(10))
	}

	@Test
	fun `ordinary commits send exactly the committed text`() {
		val ledger = ImeEditLedger()
		assertTrue(ledger.send(ledger.setComposingText("i")).let { it.first == 0 && it.second.isEmpty() })
		assertEquals(0 to "I", ledger.send(ledger.commitText("I")))
		assertEquals(0 to " ", ledger.send(ledger.commitText(" ")))
		assertEquals("I ", ledger.knownText)
		assertEquals("I ", ledger.textBeforeCursor(10))
		assertEquals(2, ledger.selectionEnd)
	}

	@Test
	fun `an unsent composition committed as a correction sends the correction once and no backspaces`() {
		val ledger = ImeEditLedger()
		for (prefix in listOf("d", "do", "don", "dont")) {
			assertEquals(0 to "", ledger.send(ledger.setComposingText(prefix)))
		}
		assertEquals("dont", ledger.textBeforeCursor(10))
		assertEquals(0, ledger.remarkedLength)
		assertEquals(0 to "don't", ledger.send(ledger.commitText("don't")))
		assertEquals(0 to " ", ledger.send(ledger.commitText(" ")))
		assertEquals("don't ", ledger.knownText)
	}

	@Test
	fun `a sent word re-marked and committed again sends only the changed suffix`() {
		val ledger = ImeEditLedger()
		ledger.send(ledger.setComposingText("dont"))
		assertEquals(0 to "dont", ledger.send(ledger.finishComposingText()))
		assertEquals(0 to "", ledger.send(ledger.setComposingRegion(0, 4)))
		assertEquals(4, ledger.remarkedLength)
		assertEquals(0, ledger.compositionStart)
		assertEquals(4, ledger.compositionEnd)
		assertEquals("dont", ledger.textBeforeCursor(10))
		assertEquals(1 to "'t ", ledger.send(ledger.commitText("don't ")))
		assertEquals("don't ", ledger.knownText)
		assertFalse(ledger.hasComposition)
	}

	@Test
	fun `a candidate replacing the sent word through every tail range api sends the same minimal edit`() {
		// replaceText over the sent word.
		typed("dont").let { assertEquals(1 to "'t", it.send(it.replaceText(0, 4, "don't"))) }
		// setComposingRegion then commitText.
		typed("dont").let {
			it.send(it.setComposingRegion(4, 0))
			assertEquals(1 to "'t", it.send(it.commitText("don't")))
		}
		// setSelection then commitText.
		typed("dont").let {
			assertTrue(it.setSelection(0, 4))
			assertEquals("dont", it.selectedText())
			assertEquals("", it.textBeforeCursor(10))
			assertEquals(1 to "'t", it.send(it.commitText("don't")))
			assertNull(it.selectedText())
		}
		// Deletion then commitText is the input method's own full retype.
		typed("dont").let {
			assertEquals(4 to "", it.send(it.deleteBefore(4, inCodePoints = false)))
			assertEquals(0 to "don't", it.send(it.commitText("don't")))
		}
	}

	@Test
	fun `re-marking after deleting the space and composing again extends the word`() {
		val ledger = typed("dont ")
		assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		ledger.send(ledger.setComposingRegion(0, 4))
		assertEquals(0 to "", ledger.send(ledger.setComposingText("donts")))
		assertEquals("donts", ledger.textBeforeCursor(10))
		assertEquals(0 to "s ", ledger.send(ledger.commitText("donts ")))
		assertEquals("donts ", ledger.knownText)
	}

	@Test
	fun `replacing only the local composition sends just the replacement`() {
		val ledger = typed("ab ")
		ledger.send(ledger.setComposingText("cd"))
		assertEquals(0 to "ce", ledger.send(ledger.replaceText(3, 5, "ce")))
		assertEquals("ab ce", ledger.knownText)
	}

	@Test
	fun `deleting inside the composition sends nothing and deleting past it reaches known then unknown text`() {
		val ledger = typed("ab")
		ledger.send(ledger.setComposingText("xyz"))
		assertEquals(0 to "", ledger.send(ledger.deleteBefore(2, inCodePoints = false)))
		assertEquals("abx", ledger.document)
		assertEquals(0 to "x", ledger.send(ledger.commitText("x")))
		ledger.send(ledger.setComposingText("q"))
		// One unit of composition, then "abx" is three known code points, then two unknown.
		assertEquals(5 to "", ledger.send(ledger.deleteBefore(6, inCodePoints = false)))
		assertEquals("", ledger.document)
		assertEquals(0, ledger.base)
	}

	@Test
	fun `a deletion with nothing known passes through unchanged`() {
		val ledger = ImeEditLedger()
		assertEquals(ImeCommitEncoder.MAX_DELETION_REQUEST + 1,
			ledger.deleteBefore(ImeCommitEncoder.MAX_DELETION_REQUEST + 1, inCodePoints = false)!!.deletions)
		assertEquals(3, ledger.deleteBefore(3, inCodePoints = true)!!.deletions)
		assertTrue(ledger.deleteBefore(0, inCodePoints = false)!!.sendsNothing)
		assertTrue(ledger.deleteBefore(-1, inCodePoints = true)!!.sendsNothing)
		assertEquals(Int.MAX_VALUE, ledger.deleteBefore(Int.MAX_VALUE, inCodePoints = false)!!.deletions)
	}

	@Test
	fun `a deletion before an active selection is refused in both units and changes nothing`() {
		for (inCodePoints in listOf(false, true)) {
			val ledger = typed("ab cd")
			assertTrue(ledger.setSelection(3, 5))
			// The platform would delete the space before the selection, not the "d" at the
			// cursor. Reaching it would mean retyping the selection, so nothing is planned.
			assertNull(ledger.deleteBefore(1, inCodePoints))
			assertEquals("cd", ledger.selectedText())
			assertEquals(3, ledger.selectionStartOffset)
			assertEquals("ab cd", ledger.knownText)
			// A collapsed cursor deletes normally again.
			assertTrue(ledger.setSelection(5, 5))
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints)))
			assertEquals("ab c", ledger.knownText)
		}
	}

	@Test
	fun `the commit ceiling applies to the supplied text even when the diff is short`() {
		val max = ImeCommitEncoder.MAX_COMMIT_CODEPOINTS
		val above = "a".repeat(max + 1)
		// commitText over a selection of known text sharing a long prefix.
		typed("a".repeat(max)).let { ledger ->
			assertTrue(ledger.setSelection(0, max))
			assertNull(ledger.commitText(above))
			assertEquals("a".repeat(max), ledger.knownText)
		}
		// commitText over a re-marked word: refused, and the composition is dropped as before.
		typed("a".repeat(max)).let { ledger ->
			ledger.send(ledger.setComposingRegion(0, max))
			assertNull(ledger.commitText(above))
			assertFalse(ledger.hasComposition)
			assertEquals("a".repeat(max), ledger.document)
		}
		// replaceText over the same tail: refused, nothing changes.
		typed("a".repeat(max)).let { ledger ->
			assertNull(ledger.replaceText(0, max, above))
			assertEquals("a".repeat(max), ledger.document)
		}
		// Exactly at the ceiling is still a commit, and only its changed suffix leaves.
		typed("a".repeat(max)).let { ledger ->
			assertEquals(0 to "", ledger.send(ledger.replaceText(0, max, "a".repeat(max))))
		}
	}

	@Test
	fun `a known emoji is one backspace however its deletion is counted`() {
		typed("a$face").let {
			assertEquals(1 to "", it.send(it.deleteBefore(2, inCodePoints = false)))
			assertEquals("a", it.knownText)
		}
		typed("a$face").let {
			assertEquals(1 to "", it.send(it.deleteBefore(1, inCodePoints = true)))
			assertEquals("a", it.knownText)
		}
		// A count that bisects the pair takes the whole character, never half of it.
		typed("a$face").let {
			assertEquals(1 to "", it.send(it.deleteBefore(1, inCodePoints = false)))
			assertEquals("a", it.knownText)
		}
		// Past the known text, the remainder keeps its old meaning.
		typed(face).let { assertEquals(2 to "", it.send(it.deleteBefore(3, inCodePoints = false))) }
	}

	@Test
	fun `a range that splits a surrogate pair or does not end at the cursor changes nothing`() {
		val ledger = typed("a$face")
		val before = ledger.document
		assertNull(ledger.setComposingRegion(2, 3))
		assertNull(ledger.replaceText(2, 3, "x"))
		assertFalse(ledger.setSelection(2, 3))
		assertNull("not tail-anchored", ledger.setComposingRegion(0, 1))
		assertNull("not tail-anchored", ledger.replaceText(0, 1, "x"))
		assertFalse("not tail-anchored", ledger.setSelection(0, 1))
		assertNull("past the end", ledger.replaceText(0, 9, "x"))
		assertNull("before the known text", ledger.setComposingRegion(-1, 3))
		assertEquals(before, ledger.document)
		assertFalse(ledger.hasComposition)
		assertNull(ledger.selectedText())
	}

	@Test
	fun `a selection mid-composition is not supported but a collapsed cursor at the end is`() {
		val ledger = typed("ab")
		ledger.send(ledger.setComposingText("cd"))
		assertFalse(ledger.setSelection(2, 4))
		assertTrue(ledger.setSelection(4, 4))
		assertEquals("cd", ledger.composingText)
	}

	@Test
	fun `an empty composing region finishes the composition`() {
		val ledger = ImeEditLedger()
		ledger.send(ledger.setComposingText("hi"))
		assertEquals(0 to "hi", ledger.send(ledger.setComposingRegion(1, 1)))
		assertFalse(ledger.hasComposition)
	}

	@Test
	fun `emptying a re-marked composition deletes the sent word`() {
		val ledger = typed("ab cd")
		ledger.send(ledger.setComposingRegion(3, 5))
		assertEquals(2 to "", ledger.send(ledger.setComposingText("")))
		assertEquals("ab ", ledger.knownText)
		assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		ledger.send(ledger.setComposingRegion(0, 2))
		// Shrinking a re-marked word past its sent tail deletes what fell out at once. The
		// backspace is a keystroke the input method already consumed locally: deferred, it is
		// lost outright when the composition ends at Enter, at a floor, or with a key.
		assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		assertEquals("a", ledger.composingText)
		assertEquals("the composition covers exactly the tail that is still sent", 1, ledger.remarkedLength)
		// The deletion already left, so keeping the composition sends nothing more for it.
		assertEquals(0 to "", ledger.send(ledger.finishComposingText()))
		assertEquals("a", ledger.knownText)
	}

	@Test
	fun `an explicit backspace on a re-marked sent word leaves once and is never lost or repeated`() {
		val ledger = typed("dont")
		ledger.send(ledger.setComposingRegion(0, 4))
		assertEquals(4, ledger.remarkedLength)
		// One backspace, no text, no Space, no Enter, nothing retyped.
		assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		assertEquals("don", ledger.knownText)
		assertEquals("don", ledger.composingText)
		assertEquals("don", ledger.document)
		assertEquals("don", ledger.textBeforeCursor(10))
		assertEquals(3, ledger.remarkedLength)
		// Keeping the composition now owes nothing: the deletion is not sent twice.
		assertEquals(0 to "", ledger.send(ledger.finishComposingText()))
		assertEquals("don", ledger.knownText)
		assertFalse(ledger.hasComposition)
	}

	@Test
	fun `shrinking a re-marked tail leaves the earlier word and its spacing alone`() {
		val ledger = typed("ab cd")
		ledger.send(ledger.setComposingRegion(3, 5))
		assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		assertEquals("ab c", ledger.knownText)
		assertEquals("ab c", ledger.document)
		assertEquals("ab c", ledger.textBeforeCursor(10))
		assertEquals(1, ledger.remarkedLength)
		// The Enter route drops the composition; the shortened line is what stays sent.
		ledger.dropComposition()
		assertFalse(ledger.hasComposition)
		assertEquals("ab c", ledger.document)
	}

	@Test
	fun `deleting only what a re-marked composition grew past the sent tail sends nothing`() {
		val ledger = typed("dont")
		ledger.send(ledger.setComposingRegion(0, 4))
		assertEquals(0 to "", ledger.send(ledger.setComposingText("donts")))
		assertEquals("donts", ledger.composingText)
		assertEquals(4, ledger.remarkedLength)
		// The grown 's' was never sent: deleting it sends nothing and the sent tail stays.
		assertEquals(0 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		assertEquals("dont", ledger.knownText)
		assertEquals("dont", ledger.composingText)
		assertEquals(4, ledger.remarkedLength)
		// The next backspace reaches the sent word and leaves as one backspace.
		assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		assertEquals("don", ledger.knownText)
		assertEquals(3, ledger.remarkedLength)
	}

	@Test
	fun `a candidate that shrinks the composition keeps deferring until the composition ends`() {
		val ledger = typed("dont")
		ledger.send(ledger.setComposingRegion(0, 4))
		// A candidate is text the input method may still change, not a keystroke: nothing
		// leaves while it composes, and the shortened word is taken from K when it ends.
		assertEquals(0 to "", ledger.send(ledger.setComposingText("don")))
		assertEquals("dont", ledger.knownText)
		assertEquals("don", ledger.composingText)
		assertEquals(1 to "", ledger.send(ledger.finishComposingText()))
		assertEquals("don", ledger.knownText)
	}

	@Test
	fun `a floor after the shrink neither repeats nor discards the deletion that already left`() {
		val ledger = typed("dont")
		ledger.send(ledger.setComposingRegion(0, 4))
		assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		val generation = ledger.generation
		ledger.floor()
		assertEquals(generation + 1, ledger.generation)
		assertFalse(ledger.hasComposition)
		assertEquals("", ledger.knownText)
		// A fresh context invents nothing for a word it no longer knows.
		assertTrue(ledger.deleteBefore(1, inCodePoints = false)!!.let { it.deletions == 1 && it.text.isEmpty() })
		assertEquals(0 to "ok", ledger.send(ledger.commitText("ok")))
		assertEquals("ok", ledger.knownText)
	}

	@Test
	fun `shrinking a re-marked word across a surrogate pair deletes whole characters in either unit`() {
		// The emoji is two UTF-16 units and one remote character: one backspace, counted right.
		typed("a$face").let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 3))
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = true)))
			assertEquals("a", ledger.knownText)
			assertEquals("a", ledger.composingText)
			assertEquals("a", ledger.document)
		}
		typed("a$face").let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 3))
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
			assertEquals("a", ledger.knownText)
			assertEquals("a", ledger.document)
		}
		// Only the trailing character falls out. The pair stays covered whole and unsplit.
		typed("$face" + "b").let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 3))
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
			assertEquals(face, ledger.knownText)
			assertEquals(face, ledger.composingText)
			assertEquals(face, ledger.document)
			assertEquals("reading back never splits the pair", face, ledger.textBeforeCursor(2))
		}
		// A count that bisects the pair takes the whole character and empties the composition.
		typed(face).let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 2))
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
			assertEquals("", ledger.knownText)
			assertFalse(ledger.hasComposition)
		}
	}

	@Test
	fun `a candidate that changed scalar widths is deleted by one backspace, not by its width`() {
		// The candidate "xab" re-marks the sent "😀ab": fewer UTF-16 units, same code points.
		// Its own change stays deferred, and one backspace deletes one sent character.
		typed("${face}ab").let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 4))
			assertEquals(0 to "", ledger.send(ledger.setComposingText("xab")))
			assertEquals("${face}ab", ledger.knownText)
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
			assertEquals("${face}a", ledger.knownText)
			assertEquals("xa", ledger.composingText)
			assertEquals("xa", ledger.document)
			// The candidate's own change is still owed, and only now that it is committed.
			assertEquals(2 to "xa", ledger.send(ledger.finishComposingText()))
			assertEquals("xa", ledger.knownText)
		}
		typed("${face}ab").let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 4))
			ledger.send(ledger.setComposingText("xab"))
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = true)))
			assertEquals("${face}a", ledger.knownText)
			assertEquals("xa", ledger.composingText)
		}
		// A candidate whose units are shorter than the sent pair's: the backspace is not lost.
		typed("${face}b").let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 3))
			assertEquals(0 to "", ledger.send(ledger.setComposingText("ab")))
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
			assertEquals(face, ledger.knownText)
			assertEquals("a", ledger.composingText)
			assertEquals("a", ledger.document)
		}
		typed("${face}b").let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 3))
			ledger.send(ledger.setComposingText("ab"))
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = true)))
			assertEquals(face, ledger.knownText)
			assertEquals("a", ledger.composingText)
		}
		// The other direction: a candidate wider than the sent text in UTF-16 units.
		typed("ab").let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 2))
			assertEquals(0 to "", ledger.send(ledger.setComposingText("${face}b")))
			assertEquals("ab", ledger.knownText)
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
			assertEquals("a", ledger.knownText)
			assertEquals(face, ledger.composingText)
			assertEquals(face, ledger.document)
			assertEquals(face, ledger.textBeforeCursor(4))
		}
		typed("ab").let { ledger ->
			ledger.send(ledger.setComposingRegion(0, 2))
			ledger.send(ledger.setComposingText("${face}b"))
			assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = true)))
			assertEquals("a", ledger.knownText)
			assertEquals(face, ledger.composingText)
		}
	}

	@Test
	fun `a deletion never flushes the deferred change a candidate left behind`() {
		val ledger = typed("dont")
		ledger.send(ledger.setComposingRegion(0, 4))
		assertEquals(0 to "", ledger.send(ledger.setComposingText("do")))
		assertEquals("dont", ledger.knownText)
		// One keystroke, one backspace: the candidate's shorter text is not sent along with it.
		assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		assertEquals("don", ledger.knownText)
		assertEquals("d", ledger.composingText)
		// Emptying the composition must not flush the candidate's earlier deferred change.
		assertEquals(1 to "", ledger.send(ledger.deleteBefore(1, inCodePoints = false)))
		assertEquals("do", ledger.knownText)
		assertTrue(ledger.finishComposingText().sendsNothing)
	}

	@Test
	fun `emptying a shortened candidate emits only the explicit deletion in either unit`() {
		for (inCodePoints in listOf(false, true)) {
			val ledger = typed("dont")
			ledger.send(ledger.setComposingRegion(0, 4))
			assertEquals(0 to "", ledger.send(ledger.setComposingText("do")))
			assertEquals(2 to "", ledger.send(ledger.deleteBefore(2, inCodePoints)))
			assertEquals("do", ledger.knownText)
			assertFalse(ledger.hasComposition)
			assertTrue(ledger.finishComposingText().sendsNothing)
			ledger.dropComposition()
			assertEquals("do", ledger.document)
		}
	}

	@Test
	fun `deleting past a shortened candidate does not flush its deferred change`() {
		for (inCodePoints in listOf(false, true)) {
			for (prefix in listOf("", "ab ")) {
				val ledger = typed(prefix + "dont")
				ledger.send(ledger.setComposingRegion(prefix.length, prefix.length + 4))
				assertEquals(0 to "", ledger.send(ledger.setComposingText("do")))
				assertEquals(3 to "", ledger.send(ledger.deleteBefore(3, inCodePoints)))
				assertEquals(prefix + "d", ledger.knownText)
				assertFalse(ledger.hasComposition)
				assertTrue(ledger.finishComposingText().sendsNothing)
				ledger.dropComposition()
				assertEquals(prefix + "d", ledger.document)
			}
		}
	}

	@Test
	fun `narrowing a composition sends the part that left it`() {
		val ledger = ImeEditLedger()
		ledger.send(ledger.setComposingText("abcd"))
		assertEquals(0 to "ab", ledger.send(ledger.setComposingRegion(2, 4)))
		assertEquals("ab", ledger.knownText)
		assertEquals("cd", ledger.composingText)
		assertEquals(0 to "cd", ledger.send(ledger.finishComposingText()))
	}

	@Test
	fun `an oversized composition is refused and dropped while sent text stays known`() {
		val ledger = typed("ok")
		ledger.send(ledger.setComposingRegion(0, 2))
		assertNull(ledger.setComposingText("a".repeat(ImeCompositionModel.MAX_COMPOSING_CODEPOINTS + 1)))
		assertFalse(ledger.hasComposition)
		assertEquals("ok", ledger.document)
		assertTrue(ledger.setComposingText("a".repeat(ImeCompositionModel.MAX_COMPOSING_CODEPOINTS)) != null)
	}

	@Test
	fun `a control character starts the context over after it`() {
		val ledger = typed("ls")
		assertEquals(0 to "\nab", ledger.send(ledger.commitText("\nab")))
		assertEquals("ab", ledger.knownText)
		assertEquals(5, ledger.selectionEnd)
		assertEquals(3, ledger.base)
		assertNull("text before the newline is not context", ledger.replaceText(2, 5, "x"))
	}

	@Test
	fun `trimming keeps logical offsets coherent`() {
		val ledger = ImeEditLedger()
		val max = ImeEditLedger.MAX_CONTEXT_CODEPOINTS
		ledger.send(ledger.commitText("a".repeat(max)))
		assertEquals(0, ledger.base)
		ledger.send(ledger.commitText(face + "bc"))
		assertEquals(max, ledger.knownText.codePointCount(0, ledger.knownText.length))
		assertEquals(3, ledger.base)
		assertEquals(max + 4, ledger.selectionEnd)
		assertTrue(ledger.knownText.endsWith(face + "bc"))
		// Offsets the input method was given still name the same text.
		assertEquals(1 to "d", ledger.send(ledger.replaceText(max + 3, max + 4, "d")))
		assertNull("trimmed text is no longer context", ledger.replaceText(2, max + 4, "x"))
		assertEquals("bd", ledger.textBeforeCursor(2))
		assertEquals("${face}bd", ledger.textBeforeCursor(4))
		assertEquals("bd", ledger.textBeforeCursor(3))
	}

	@Test
	fun `floor forgets known text but keeps the unsent composition and the cursor`() {
		val ledger = typed("dont ")
		ledger.send(ledger.setComposingText("ab"))
		val generation = ledger.generation
		val end = ledger.selectionEnd
		ledger.floor()
		assertEquals("", ledger.knownText)
		assertEquals("ab", ledger.composingText)
		assertEquals(end, ledger.selectionEnd)
		assertEquals(generation + 1, ledger.generation)
		assertNull("old offsets are not context any more", ledger.setComposingRegion(0, 4))
		assertEquals(0 to "ab", ledger.send(ledger.commitText("ab")))
	}

	@Test
	fun `a floor drops a re-marked word rather than retyping or deleting it`() {
		val ledger = typed("dont")
		ledger.send(ledger.setComposingRegion(0, 4))
		ledger.send(ledger.setComposingText("donts"))
		ledger.floor()
		assertFalse(ledger.hasComposition)
		assertEquals(0, ledger.remarkedLength)
		assertEquals("", ledger.document)
		assertEquals("the cursor moves past the sent word", 4, ledger.selectionEnd)
		// Nothing more is planned for the dropped word: a deletion is the plain unknown
		// pass-through, and a later commit is new text with no invented backspaces.
		assertTrue(ledger.deleteBefore(1, inCodePoints = false)!!.let { it.deletions == 1 && it.text.isEmpty() })
		assertEquals(0 to "ok", ledger.send(ledger.commitText("ok")))
		assertEquals("ok", ledger.knownText)
	}

	@Test
	fun `a plan from before a floor is not adopted`() {
		val ledger = typed("dont")
		val plan = requireNotNull(ledger.commitText("x"))
		ledger.floor()
		assertFalse(ledger.apply(plan))
		assertEquals("", ledger.knownText)
	}

	@Test
	fun `dropping a composition keeps what was sent`() {
		val ledger = typed("dont")
		ledger.send(ledger.setComposingRegion(0, 4))
		ledger.send(ledger.setComposingText("donts"))
		ledger.dropComposition()
		assertEquals("dont", ledger.document)
		assertEquals(-1, ledger.compositionStart)
	}

	@Test
	fun `a forwarded backspace trims one known code point`() {
		val ledger = typed("a$face")
		ledger.forwardedBackspace()
		assertEquals("a", ledger.knownText)
		ledger.forwardedBackspace()
		assertEquals("", ledger.knownText)
		assertEquals(0, ledger.base)
		ledger.forwardedBackspace()
		assertEquals(0, ledger.base)
	}

	@Test
	fun `unknown deletions move the start back without going negative`() {
		val ledger = typed("abc")
		ledger.floor()
		assertEquals(3, ledger.base)
		assertEquals(2 to "", ledger.send(ledger.deleteBefore(2, inCodePoints = false)))
		assertEquals(1, ledger.base)
		assertEquals(5 to "", ledger.send(ledger.deleteBefore(5, inCodePoints = true)))
		assertEquals(0, ledger.base)
	}

	@Test
	fun `discard drops everything and invalidates pending plans`() {
		val ledger = typed("abc")
		ledger.send(ledger.setComposingText("x"))
		val plan = ledger.finishComposingText()
		ledger.discard()
		assertFalse(ledger.apply(plan))
		assertEquals("", ledger.document)
	}
}
