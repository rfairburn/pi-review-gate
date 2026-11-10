package io.github.rfairburn.pireviewgate.core.input

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One input-method commit, or one repeated editing key, as the packets it means.
 *
 * The interesting cases are the ones a phone screen cannot fake its way through: a
 * commit that carries a supplementary character, a commit with an embedded newline,
 * a held Ctrl that has to survive into every scalar of what was committed, and a
 * commit part of which this child cannot be given. The rule under test is that the
 * owner's own encoder decides every spelling, and that a commit is delivered whole
 * or not at all.
 */
class ImeCommitEncoderTest {
	private fun bytes(text: String): ByteArray = text.toByteArray(java.nio.charset.StandardCharsets.UTF_8)

	private fun key(codepoint: Int, modifiers: Int): ByteArray? =
		KeyboardEncoder.encode(TerminalKey(codepoint = codepoint, modifiers = modifiers), modes())

	@Test
	fun aCommitWithNoChipHeldLeavesAsText() {
		val packets = ImeCommitEncoder.encode("hello", 0, modes()) ?: error("plain text always encodes")
		assertEquals(1, packets.size)
		assertArrayEquals(bytes("hello"), packets[0])
		assertArrayEquals(KeyboardEncoder.encodeTypedText("hello"), packets[0])
	}

	@Test
	fun anEmptyCommitIsNothingRatherThanAnEmptyPacket() {
		assertNull(ImeCommitEncoder.encode("", 0, modes()))
		assertNull(ImeCommitEncoder.encode("", KeyboardModifiers.CTRL, modes()))
	}

	@Test
	fun anEmbeddedNewlineIsTheEnterKeystrokeNotALineFeed() {
		val packets = ImeCommitEncoder.encode("a\nb", 0, modes()) ?: error("this commit encodes")
		assertEquals(3, packets.size)
		assertArrayEquals(bytes("a"), packets[0])
		assertArrayEquals(bytes("\r"), packets[1])
		assertArrayEquals(bytes("b"), packets[2])
	}

	@Test
	fun aHeldCtrlTurnsEveryScalarOfTheCommitIntoItsOwnKeystroke() {
		val packets = ImeCommitEncoder.encode(
			"ab",
			KeyboardModifiers.CTRL,
			modes(),
		) ?: error("Ctrl+A and Ctrl+B encode")
		assertEquals(2, packets.size)
		assertArrayEquals(bytes("\u0001"), packets[0])
		assertArrayEquals(bytes("\u0002"), packets[1])
	}

	@Test
	fun aHeldCtrlStillTurnsAnEmbeddedNewlineIntoModifiedEnter() {
		val packets = ImeCommitEncoder.encode(
			"a\nb",
			KeyboardModifiers.CTRL,
			modes(),
		) ?: error("this commit encodes")
		assertEquals(3, packets.size)
		assertArrayEquals(bytes("\u0001"), packets[0])
		assertArrayEquals(key(13, KeyboardModifiers.CTRL), packets[1])
		assertArrayEquals(bytes("\u0002"), packets[2])
	}

	@Test
	fun aSupplementaryCharacterIsOneKeystrokeAndNeverTwoSurrogates() {
		val grinning = "\uD83D\uDE00"
		val modified = ImeCommitEncoder.encode(
			grinning,
			KeyboardModifiers.CTRL,
			modes(),
		) ?: error("a modified scalar always reaches the encoder")
		assertEquals("one codepoint, one keystroke", 1, modified.size)
		assertArrayEquals(key(0x1F600, KeyboardModifiers.CTRL), modified[0])

		val plain = ImeCommitEncoder.encode(grinning, 0, modes()) ?: error("text always encodes")
		assertEquals(1, plain.size)
		assertArrayEquals(bytes(grinning), plain[0])
	}

	@Test
	fun anUnrepresentablePartRefusesTheWholeCommit() {
		val held = KeyboardModifiers.CTRL
		assertNotNull("the first scalar of the commit does encode", key(0x61, held))
		// A bare suspend control inside a commit has no modified spelling, so nothing
		// of this commit goes out — not the representable prefix of it.
		assertNull(ImeCommitEncoder.encode("a\u001a", held, modes()))
	}

	@Test
	fun theSuspendFloorStaysWhereTheOwnerPutIt() {
		// With no chip held the plain-text path drops the suspend control and keeps the
		// rest of the burst, exactly as before. With Ctrl held, every spelling of
		// Ctrl+Z is refused, so the commit is refused.
		assertArrayEquals(
			bytes("a"),
			(ImeCommitEncoder.encode("a\u001a", 0, modes()) ?: error("text keeps its non-suspend part"))[0],
		)
		assertNull(ImeCommitEncoder.encode("z", KeyboardModifiers.CTRL, modes()))
		assertNull(
			ImeCommitEncoder.encode(
				"z",
				KeyboardModifiers.CTRL or KeyboardModifiers.SHIFT,
				modes(),
			),
		)
		assertNull(ImeCommitEncoder.encode("\u001a", KeyboardModifiers.CTRL, modes()))
	}

	@Test
	fun aHeldShiftUsesTheEncodersOwnShiftedSpelling() {
		val packets = ImeCommitEncoder.encode(
			"a",
			KeyboardModifiers.SHIFT,
			modes(),
		) ?: error("Shift+A encodes")
		assertEquals(1, packets.size)
		assertArrayEquals(bytes("A"), packets[0])
	}

	@Test
	fun aDisambiguatingChildGetsTheKittySpellingOfTheSameCommit() {
		val kitty = modes(kittyFlags = 1)
		val packets = ImeCommitEncoder.encode("a", KeyboardModifiers.CTRL, kitty) ?: error("Ctrl+A encodes")
		assertArrayEquals(
			KeyboardEncoder.encode(TerminalKey(codepoint = 0x61, modifiers = KeyboardModifiers.CTRL), kitty),
			packets[0],
		)
		assertArrayEquals(bytes("\u001b[97;5u"), packets[0])
	}

	@Test
	fun everySpellingComesFromTheOwnersEncoderRatherThanFromThisClass() {
		// The encoder adds no translation of its own: for one scalar and one modifier
		// mask it produces exactly the packet KeyboardEncoder produces.
		val held = KeyboardModifiers.CTRL or KeyboardModifiers.ALT
		val packets = ImeCommitEncoder.encode("q", held, modes(kittyFlags = 0, modifyOtherKeys = 2))
			?: error("this keystroke encodes")
		assertArrayEquals(
			KeyboardEncoder.encode(TerminalKey(codepoint = 0x71, modifiers = held), modes(modifyOtherKeys = 2)),
			packets[0],
		)
	}

	@Test
	fun backspacesAreRepeatedOnlyAsLongAsTheKeystrokeHasASpelling() {
		val plain = ImeCommitEncoder.encodeBackspaces(3, 0, modes()) ?: error("Backspace always encodes")
		assertEquals(3, plain.size)
		for (packet in plain) assertArrayEquals(bytes("\u007f"), packet)

		val modified = ImeCommitEncoder.encodeBackspaces(
			2,
			KeyboardModifiers.CTRL,
			modes(),
		) ?: error("this keystroke encodes")
		assertEquals(2, modified.size)
		for (packet in modified) assertArrayEquals(key(127, KeyboardModifiers.CTRL), packet)
	}

	@Test
	fun aKeystrokeWithNoSpellingSendsNoBackspaceAtAll() {
		// An out-of-range mode bundle refuses every keystroke. The point of the batch
		// is that the user does not end up with some of the deletions they asked for.
		assertNull(ImeCommitEncoder.encodeBackspaces(3, KeyboardModifiers.CTRL, modes(kittyFlags = 8)))
		assertNull(ImeCommitEncoder.encodeBackspaces(0, 0, modes()))
		assertNull(ImeCommitEncoder.encodeBackspaces(-1, 0, modes()))
	}

	@Test
	fun enterCarriesTheHeldChipAndStaysDistinctFromAPlainEnter() {
		val plain = ImeCommitEncoder.encodeEnter(0, modes()) ?: error("Enter always encodes")
		assertArrayEquals(bytes("\r"), plain)
		val held = ImeCommitEncoder.encodeEnter(KeyboardModifiers.CTRL, modes()) ?: error("Ctrl+Enter encodes")
		assertArrayEquals(key(13, KeyboardModifiers.CTRL), held)
		assertNotNull(held)
	}

	@Test
	fun aCommittedScalarThatAliasesAFunctionalKeyRefusesTheWholeCommit() {
		// U+E037 is keypad 0 and U+E00E is Escape in the owner's reserved functional
		// range. Handing one to the encoder with a chip held would press a key rather
		// than send the glyph the user committed, so the whole commit is refused. With
		// no chip held they leave as text, which is what they are.
		val held = KeyboardModifiers.SHIFT
		assertNotNull(ImeCommitEncoder.encode("a\uE037", 0, modes()))
		assertNull(ImeCommitEncoder.encode("a\uE037", held, modes()))
		assertNotNull(ImeCommitEncoder.encode("\uE00E", 0, modes()))
		assertNull(ImeCommitEncoder.encode("a\uE00E", held, modes()))
		assertTrue(KeyboardEncoder.isReservedFunctionalCodepoint(0xE037))
		assertFalse(KeyboardEncoder.isReservedFunctionalCodepoint(0x61))
	}

	@Test
	fun malformedUtf16IsRefusedRatherThanReplacedWithSomethingElse() {
		// A lone surrogate would otherwise leave as a replacement character on the wire,
		// which is a silent rewrite of what the user committed.
		assertNull(ImeCommitEncoder.encode("a\uD83D", 0, modes()))
		assertNull(ImeCommitEncoder.encode("a\uD83D", KeyboardModifiers.CTRL, modes()))
		assertNull(ImeCommitEncoder.encode("\uDC00b", 0, modes()))
		assertNull(ImeCommitEncoder.encode("\uDC00b", KeyboardModifiers.ALT, modes()))
		assertNotNull(ImeCommitEncoder.encode("\uD83D\uDE00", 0, modes()))
	}

	@Test
	fun aCommitAboveTheCeilingIsRefusedWhole() {
		val atTheCeiling = "a".repeat(ImeCommitEncoder.MAX_COMMIT_CODEPOINTS)
		val above = "a".repeat(ImeCommitEncoder.MAX_COMMIT_CODEPOINTS + 1)
		assertFalse(ImeCommitEncoder.isOversized(atTheCeiling))
		assertTrue(ImeCommitEncoder.isOversized(above))
		val packets = ImeCommitEncoder.encode(atTheCeiling, KeyboardModifiers.CTRL, modes())
			?: error("a commit at the ceiling is not oversized")
		assertEquals(ImeCommitEncoder.MAX_COMMIT_CODEPOINTS, packets.size)
		assertNull(ImeCommitEncoder.encode(above, KeyboardModifiers.CTRL, modes()))
		assertNull(ImeCommitEncoder.encode(above, 0, modes()))
	}

	@Test
	fun theCeilingCountsScalarsNotUtf16Units() {
		// Supplementary characters are one scalar each, so a ceiling measured in
		// characters would refuse half as much text as it claims to allow.
		val face = "\uD83D\uDE00"
		val atTheCeiling = face.repeat(ImeCommitEncoder.MAX_COMMIT_CODEPOINTS)
		assertFalse(ImeCommitEncoder.isOversized(atTheCeiling))
		assertTrue(ImeCommitEncoder.isOversized(face.repeat(ImeCommitEncoder.MAX_COMMIT_CODEPOINTS + 1)))
	}

	@Test
	fun aDeletionRequestAboveTheCeilingIsRefusedWhole() {
		// The adapter boundary, at the packet level: a request the surface will accept
		// encodes every deletion, and one more than that encodes none. It is never
		// shortened to the largest prefix that fits, because the caller would then have
		// to report a deletion that did not happen.
		val atTheCeiling = ImeCommitEncoder.encodeBackspaces(ImeCommitEncoder.MAX_DELETION_REQUEST, 0, modes())
			?: error("a request at the ceiling always has a spelling")
		assertEquals(ImeCommitEncoder.MAX_DELETION_REQUEST, atTheCeiling.size)
		assertNull(
			"one above the ceiling is not delivered as a prefix",
			ImeCommitEncoder.encodeBackspaces(ImeCommitEncoder.MAX_DELETION_REQUEST + 1, 0, modes()),
		)
		assertNull(
			"and not with a chip held either",
			ImeCommitEncoder.encodeBackspaces(ImeCommitEncoder.MAX_DELETION_REQUEST + 1, KeyboardModifiers.CTRL, modes()),
		)
	}
}
