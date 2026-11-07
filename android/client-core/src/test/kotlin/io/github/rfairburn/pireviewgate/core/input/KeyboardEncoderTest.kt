package io.github.rfairburn.pireviewgate.core.input

import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import java.nio.charset.StandardCharsets
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Canonical keyboard packets, ported from the owner's translator.
 *
 * The point of these cases is identity: Enter is not Ctrl+J, Shift+Enter is not
 * Enter, a modified arrow keeps its modifier, and a keystroke with no unambiguous
 * spelling is refused rather than approximated.
 */
class KeyboardEncoderTest {

	private fun packet(key: TerminalKey, targetModes: TerminalInputModes = modes()): String? =
		KeyboardEncoder.encode(key, targetModes)?.toString(StandardCharsets.ISO_8859_1)

	@Test
	fun plainKeysUseTheLegacySpellings() {
		assertEquals("\r", packet(TerminalKey(codepoint = 13)))
		assertEquals("\t", packet(TerminalKey(codepoint = 9)))
		assertEquals(ESC, packet(TerminalKey(codepoint = 27)))
		assertEquals("\u007f", packet(TerminalKey(codepoint = 127)))
		assertEquals("a", packet(TerminalKey(codepoint = 'a'.code)))
	}

	@Test
	fun enterCtrlJAndShiftEnterStayDistinct() {
		val kitty = modes(kittyFlags = 7)
		assertEquals("\r", packet(TerminalKey(codepoint = 13), kitty))
		assertEquals("$ESC[13;2u", packet(TerminalKey(codepoint = 13, modifiers = KeyboardModifiers.SHIFT), kitty))
		assertEquals("$ESC[106;5u", packet(TerminalKey(codepoint = 'j'.code, modifiers = KeyboardModifiers.CTRL), kitty))
		// A legacy child still gets CR for Enter and LF for Ctrl+J.
		assertEquals("\r", packet(TerminalKey(codepoint = 13)))
		assertEquals("\n", packet(TerminalKey(codepoint = 'j'.code, modifiers = KeyboardModifiers.CTRL)))
	}

	@Test
	fun modifiedControlKeysKeepTheirIdentity() {
		assertEquals("$ESC[Z", packet(TerminalKey(codepoint = 9, modifiers = KeyboardModifiers.SHIFT)))
		assertEquals("$ESC\r", packet(TerminalKey(codepoint = 13, modifiers = KeyboardModifiers.ALT)))
		// Ctrl+Backspace has no unambiguous legacy spelling, so identity wins.
		assertEquals("$ESC[127;5u", packet(TerminalKey(codepoint = 127, modifiers = KeyboardModifiers.CTRL)))
		// Ctrl+Alt+Esc has no legacy spelling, so it is carried as CSI-u.
		assertEquals(
			"$ESC[27;7u",
			packet(
				TerminalKey(
					codepoint = 27,
					modifiers = KeyboardModifiers.CTRL or KeyboardModifiers.ALT,
				),
			),
		)
	}

	@Test
	fun arrowsFollowTheObservedCursorMode() {
		assertEquals("$ESC[A", packet(TerminalKey(functionKey = TerminalFunctionKey.UP)))
		assertEquals(
			"${ESC}OA",
			packet(TerminalKey(functionKey = TerminalFunctionKey.UP), modes(applicationCursorKeys = true)),
		)
		assertEquals(
			"$ESC[1;5A",
			packet(TerminalKey(functionKey = TerminalFunctionKey.UP, modifiers = KeyboardModifiers.CTRL)),
		)
		assertEquals(
			"$ESC[1;3B",
			packet(TerminalKey(functionKey = TerminalFunctionKey.DOWN, modifiers = KeyboardModifiers.ALT)),
		)
	}

	@Test
	fun functionAndNavigationKeysUseTheirCanonicalForms() {
		assertEquals("$ESC[H", packet(TerminalKey(functionKey = TerminalFunctionKey.HOME)))
		assertEquals("$ESC[F", packet(TerminalKey(functionKey = TerminalFunctionKey.END)))
		assertEquals("$ESC[2~", packet(TerminalKey(functionKey = TerminalFunctionKey.INSERT)))
		assertEquals("$ESC[3~", packet(TerminalKey(functionKey = TerminalFunctionKey.DELETE)))
		assertEquals("$ESC[5~", packet(TerminalKey(functionKey = TerminalFunctionKey.PAGE_UP)))
		assertEquals("$ESC[6~", packet(TerminalKey(functionKey = TerminalFunctionKey.PAGE_DOWN)))
		assertEquals("${ESC}OP", packet(TerminalKey(functionKey = TerminalFunctionKey.F1)))
		assertEquals("$ESC[15~", packet(TerminalKey(functionKey = TerminalFunctionKey.F5)))
		assertEquals("$ESC[24~", packet(TerminalKey(functionKey = TerminalFunctionKey.F12)))
		// Modified F3 has its own number in the canonical table.
		assertEquals(
			"$ESC[13;2~",
			packet(TerminalKey(functionKey = TerminalFunctionKey.F3, modifiers = KeyboardModifiers.SHIFT)),
		)
	}

	@Test
	fun kittyAlternateKeyFieldsRideAlong() {
		// Alternate-key fields travel with a modified text key, where the child
		// needs them; a plain Shift+letter still leaves as the shifted glyph.
		val key = TerminalKey(
			codepoint = 'a'.code,
			modifiers = KeyboardModifiers.CTRL or KeyboardModifiers.SHIFT,
			shiftedCodepoint = 'A'.code,
			baseLayoutCodepoint = 'a'.code,
		)
		assertEquals("$ESC[97:65:97;6u", packet(key, modes(kittyFlags = 7)))
		// Without the alternate-keys flag the same packet stays short.
		assertEquals("$ESC[97;6u", packet(key, modes(kittyFlags = 1)))
		assertEquals(
			"A",
			packet(
				TerminalKey(
					codepoint = 'a'.code,
					modifiers = KeyboardModifiers.SHIFT,
					shiftedCodepoint = 'A'.code,
				),
				modes(kittyFlags = 7),
			),
		)
	}

	@Test
	fun shiftedSymbolsAreNeverGuessed() {
		// No shifted field: the identity is carried as CSI-u rather than guessed
		// into some other symbol.
		assertEquals("$ESC[47;2u", packet(TerminalKey(codepoint = '/'.code, modifiers = KeyboardModifiers.SHIFT)))
		// A reported shifted field is honoured.
		assertEquals(
			"?",
			packet(
				TerminalKey(
					codepoint = '/'.code,
					modifiers = KeyboardModifiers.SHIFT,
					shiftedCodepoint = '?'.code,
				),
			),
		)
	}

	@Test
	fun modifyOtherKeysPreservesModifiedTextIdentity() {
		assertEquals(
			"$ESC[27;5;97~",
			packet(TerminalKey(codepoint = 'a'.code, modifiers = KeyboardModifiers.CTRL), modes(modifyOtherKeys = 2)),
		)
		assertEquals(
			"$ESC[27;7;97~",
			packet(
				TerminalKey(codepoint = 'a'.code, modifiers = KeyboardModifiers.CTRL or KeyboardModifiers.ALT),
				modes(modifyOtherKeys = 2),
			),
		)
	}

	@Test
	fun eventReportingIsHonouredOrDropped() {
		val key = TerminalKey(codepoint = 'a'.code, modifiers = KeyboardModifiers.CTRL)
		val repeat = key.copy(eventType = TerminalKeyEventType.REPEAT)
		val release = key.copy(eventType = TerminalKeyEventType.RELEASE)
		// Without Kitty event reporting a repeat collapses to a press and a
		// release is not sent at all.
		assertEquals("\u0001", packet(repeat))
		assertNull(packet(release))
		assertEquals("$ESC[97;5:2u", packet(repeat, modes(kittyFlags = 3)))
		assertEquals("$ESC[97;5:3u", packet(release, modes(kittyFlags = 3)))
	}

	@Test
	fun suspendIsRefusedInEverySpelling() {
		val ctrl = KeyboardModifiers.CTRL
		assertNull(packet(TerminalKey(codepoint = 'z'.code, modifiers = ctrl)))
		assertNull(packet(TerminalKey(codepoint = 'Z'.code, modifiers = ctrl or KeyboardModifiers.SHIFT)))
		assertNull(packet(TerminalKey(codepoint = 'z'.code, modifiers = ctrl), modes(kittyFlags = 7)))
		// A non-Latin primary over a z base-layout key is the same suspend keystroke.
		assertNull(
			packet(
				TerminalKey(codepoint = 0x44f, modifiers = ctrl, baseLayoutCodepoint = 'z'.code),
			),
		)
		// Ctrl+K stays usable.
		assertEquals("\u000b", packet(TerminalKey(codepoint = 'k'.code, modifiers = ctrl)))
	}

	@Test
	fun typedTextPassesThroughExceptWhereItMustNot() {
		assertContentEquals(
			"hello".toByteArray(StandardCharsets.UTF_8),
			KeyboardEncoder.encodeTypedText("hello"),
		)
		assertContentEquals(
			"ab".toByteArray(StandardCharsets.UTF_8),
			KeyboardEncoder.encodeTypedText("a\u001ab"),
		)
		assertNull(KeyboardEncoder.encodeTypedText("\u001a"))
		assertNull(KeyboardEncoder.encodeTypedText(""))
		assertNull(KeyboardEncoder.encodeTypedText("a\u0085b"))
		assertNull(KeyboardEncoder.encodeTypedText("a\u001bb"))
	}

	@Test
	fun unicodeTextLeavesAsUtf8() {
		val encoded = assertNotNull(KeyboardEncoder.encode(TerminalKey(codepoint = 0x4e2d), modes()))
		assertContentEquals("\u4e2d".toByteArray(StandardCharsets.UTF_8), encoded)
		val emoji = assertNotNull(KeyboardEncoder.encode(TerminalKey(codepoint = 0x1f600), modes()))
		assertContentEquals("\uD83D\uDE00".toByteArray(StandardCharsets.UTF_8), emoji)
	}

	@Test
	fun aForwardedScalarBecomesCharactersNeverItsDigits() {
		// The text path converts by scalar value: a forwarded 'a' key is the letter,
		// and a supplementary character becomes its surrogate pair.
		assertEquals("a", KeyboardEncoder.textOfScalar('a'.code))
		assertEquals("\u4e2d", KeyboardEncoder.textOfScalar(0x4e2d))
		assertEquals("\uD83D\uDE00", KeyboardEncoder.textOfScalar(0x1f600))
		assertNotEquals("97", KeyboardEncoder.textOfScalar('a'.code))

		// And the bytes that leave are the UTF-8 the child expects.
		assertContentEquals(
			"a".toByteArray(StandardCharsets.UTF_8),
			assertNotNull(KeyboardEncoder.encodeTypedText(assertNotNull(KeyboardEncoder.textOfScalar('a'.code)))),
		)
		assertContentEquals(
			"\u4e2d".toByteArray(StandardCharsets.UTF_8),
			assertNotNull(KeyboardEncoder.encodeTypedText(assertNotNull(KeyboardEncoder.textOfScalar(0x4e2d)))),
		)
		assertContentEquals(
			"\uD83D\uDE00".toByteArray(StandardCharsets.UTF_8),
			assertNotNull(KeyboardEncoder.encodeTypedText(assertNotNull(KeyboardEncoder.textOfScalar(0x1f600)))),
		)
	}

	@Test
	fun nonTextScalarValuesAreNeverTurnedIntoCharacters() {
		// A dead-key flag, a bare control or C1 byte, a surrogate half, and an
		// out-of-range value are all reported as integers that are not text.
		for (value in listOf(0, 0x01, 0x0a, 0x1b, 0x7f, 0x80, 0x9f, 0xd800, 0xdbff, 0xe000 - 0x1, 0x110000, -1)) {
			assertFalse(KeyboardEncoder.isForwardableTextScalar(value), "0x${value.toString(16)}")
			assertNull(KeyboardEncoder.textOfScalar(value), "0x${value.toString(16)}")
		}
		for (value in listOf(0x20, 'a'.code, 0x4e2d, 0x10ffff, 0x1f600)) {
			assertTrue(KeyboardEncoder.isForwardableTextScalar(value), "0x${value.toString(16)}")
		}
	}

	@Test
	fun invalidModesAndCodepointsAreRefused() {
		assertNull(packet(TerminalKey(codepoint = 1), modes()))
		assertNull(packet(TerminalKey(codepoint = 'a'.code), modes(kittyFlags = 8)))
		assertNull(packet(TerminalKey()))
	}
}
