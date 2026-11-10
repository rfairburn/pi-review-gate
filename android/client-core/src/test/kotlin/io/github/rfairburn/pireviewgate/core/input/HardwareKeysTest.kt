package io.github.rfairburn.pireviewgate.core.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Physical-key translation with the key map's answers supplied by hand.
 *
 * What a key code means belongs to the user's active layout, so the suite can
 * present a Cyrillic press, a Ctrl-folded byte, or shifted punctuation without a
 * device — and without pretending a table of key codes knows what a keyboard types.
 */
class HardwareKeysTest {
	private fun facts(
		vararg candidates: Int,
		shifted: Int? = null,
		modifiers: Int = KeyboardModifiers.CTRL,
		eventType: TerminalKeyEventType = TerminalKeyEventType.PRESS,
		baseLayout: Int? = null,
	) = HardwareKeyFacts(
		unicodeCandidates = candidates.toList(),
		shiftedUnicode = shifted,
		modifiers = modifiers,
		eventType = eventType,
		baseLayoutCodepoint = baseLayout,
	)

	private fun code(text: String): Int = text.codePointAt(0)

	@Test
	fun `a ctrl-folded byte yields the key map's letter plus the mask`() {
		// The system reports SOH for Ctrl+A; the identity is the letter.
		val key = HardwareKeys.printableKey(facts(0x01, code("a"), baseLayout = code("a")))
		assertEquals(code("a"), key?.codepoint)
		assertEquals(KeyboardModifiers.CTRL, key?.modifiers)
		assertNull(key?.shiftedCodepoint)
	}

	@Test
	fun `a non-latin layout types its own letter`() {
		// Cyrillic 'б' under Ctrl: the key map says б, and nothing ASCII is invented.
		val key = HardwareKeys.printableKey(facts(0x02, code("б"), baseLayout = code("b")))
		assertEquals(code("б"), key?.codepoint)
	}

	@Test
	fun `shifted punctuation keeps the alternate the map offers`() {
		val key = HardwareKeys.printableKey(
			facts(
				code("/"),
				shifted = code("?"),
				modifiers = KeyboardModifiers.CTRL or KeyboardModifiers.SHIFT,
				baseLayout = code("/"),
			),
		)
		assertEquals(code("/"), key?.codepoint)
		assertEquals(code("?"), key?.shiftedCodepoint)
	}

	@Test
	fun `shift with no distinct alternate is not invented`() {
		val key = HardwareKeys.printableKey(
			facts(
				code("ф"),
				shifted = code("ф"),
				modifiers = KeyboardModifiers.CTRL or KeyboardModifiers.SHIFT,
			),
		)
		assertNull(key?.shiftedCodepoint)
	}

	@Test
	fun `supplementary characters survive`() {
		val musical = "𝄞"
		val key = HardwareKeys.printableKey(facts(code(musical), modifiers = KeyboardModifiers.ALT))
		assertEquals(code(musical), key?.codepoint)
		assertEquals(musical, KeyboardEncoder.textOfScalar(code(musical)))
	}

	@Test
	fun `an unmodified printable key is left to the input method`() {
		assertNull(HardwareKeys.printableKey(facts(code("a"), modifiers = 0)))
		assertNull(HardwareKeys.printableKey(facts(code("a"), modifiers = KeyboardModifiers.SHIFT)))
		assertNull(HardwareKeys.printableKey(facts(code("a"), modifiers = KeyboardModifiers.CAPS_LOCK)))
	}

	@Test
	fun `a dead key or non-character is declined rather than typed`() {
		// Dead-key flags and control values are reported as integers that are not text.
		assertNull(HardwareKeys.printableKey(facts(0, 0x7f, 0x80, modifiers = KeyboardModifiers.CTRL)))
		assertNull(HardwareKeys.printableKey(facts(0xd83d, modifiers = KeyboardModifiers.ALT)))
		assertNull(HardwareKeys.printableKey(facts(-1, 0x110000, modifiers = KeyboardModifiers.CTRL)))
	}

	@Test
	fun `lock state travels to the encoder untouched`() {
		val key = HardwareKeys.printableKey(
			facts(
				code("B"),
				modifiers = KeyboardModifiers.CTRL or KeyboardModifiers.CAPS_LOCK,
				baseLayout = code("b"),
			),
		)
		assertEquals(KeyboardModifiers.CTRL or KeyboardModifiers.CAPS_LOCK, key?.modifiers)
	}

	@Test
	fun `releases keep their event type`() {
		val key = HardwareKeys.printableKey(
			facts(code("j"), modifiers = KeyboardModifiers.CTRL, eventType = TerminalKeyEventType.RELEASE),
		)
		assertEquals(TerminalKeyEventType.RELEASE, key?.eventType)
	}

	@Test
	fun `the translated keys encode as the packets the child expects`() {
		val kitty = modes(kittyFlags = 7)
		// A Ctrl-folded LF byte from the event still encodes as Ctrl+J, and stays
		// distinct from Enter.
		val ctrlJ = assertNotNull(
			HardwareKeys.printableKey(
				facts(0x0a, code("j"), modifiers = KeyboardModifiers.CTRL, baseLayout = code("j")),
			),
		)
		// The base-layout identity travels in the packet's fifth field, which is what
		// lets a layout-independent refusal such as Ctrl+Z still work.
		assertEquals("$ESC[106::106;5u", packetText(ctrlJ, kitty))
		assertNotEquals("$ESC[106::106;5u", packetText(TerminalKey(codepoint = 13), kitty))

		// The layout's letter reaches the packet, not an ASCII stand-in.
		val altCyrillic = assertNotNull(
			HardwareKeys.printableKey(facts(code("б"), modifiers = KeyboardModifiers.ALT)),
		)
		assertTrue(packetText(altCyrillic, kitty), packetText(altCyrillic, kitty).contains("1073"))
	}

	@Test
	fun shiftedKeysKeepTheirUnshiftedIdentityInThePacket() {
		// Exactly what the adapter queries: the key map's unmodified answer is the
		// identity, its shift answer is the alternate, and the event's own folded
		// value — which would be "?" and "J" here — never enters the picture.
		val kitty = modes(kittyFlags = 7)
		val shiftCtrl = KeyboardModifiers.CTRL or KeyboardModifiers.SHIFT

		val question = HardwareKeys.facts(
			unmodifiedUnicodeChar = code("/"),
			shiftedUnicodeChar = code("?"),
			modifiers = shiftCtrl,
			eventType = TerminalKeyEventType.PRESS,
			baseLayoutCodepoint = code("/"),
		)
		assertEquals("$ESC[47:63:47;6u", packetText(assertNotNull(HardwareKeys.printableKey(question)), kitty))

		val capitalJ = HardwareKeys.facts(
			unmodifiedUnicodeChar = code("j"),
			shiftedUnicodeChar = code("J"),
			modifiers = shiftCtrl,
			eventType = TerminalKeyEventType.PRESS,
			baseLayoutCodepoint = code("j"),
		)
		assertEquals("$ESC[106:74:106;6u", packetText(assertNotNull(HardwareKeys.printableKey(capitalJ)), kitty))

		// Without shift held, the alternate stays empty while the base-layout
		// identity still travels, so a refusal such as Ctrl+Z holds on any layout.
		val cyrillic = HardwareKeys.facts(
			unmodifiedUnicodeChar = code("ф"),
			shiftedUnicodeChar = code("Ф"),
			modifiers = KeyboardModifiers.CTRL,
			eventType = TerminalKeyEventType.PRESS,
			baseLayoutCodepoint = code("f"),
		)
		assertEquals("$ESC[1092::102;5u", packetText(assertNotNull(HardwareKeys.printableKey(cyrillic)), kitty))
	}

	private fun packetText(key: TerminalKey, modes: io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes): String =
		String(assertNotNull(KeyboardEncoder.encode(key, modes)), Charsets.UTF_8)

	private fun <T> assertNotNull(value: T?): T = value ?: error("expected a value")
}
