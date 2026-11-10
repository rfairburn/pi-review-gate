package io.github.rfairburn.pireviewgate.core.input

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The chips a phone screen holds down between taps.
 *
 * A soft keyboard has no Ctrl and no Alt, so a native terminal screen has to offer
 * them itself — and a chip that silently latched something the phone cannot spell,
 * or that outlived the session it was meant for, would be a modifier the user
 * cannot see and cannot get rid of. These are the rules that keep it honest.
 */
class MobileModifierLatchTest {
	@Test
	fun onlyCtrlAltAndShiftCanBeHeld() {
		val latch = MobileModifierLatch()
		assertTrue(latch.set(KeyboardModifiers.CTRL))
		assertTrue(latch.set(KeyboardModifiers.ALT))
		assertTrue(latch.set(KeyboardModifiers.SHIFT))
		assertTrue(latch.set(KeyboardModifiers.CTRL or KeyboardModifiers.ALT or KeyboardModifiers.SHIFT))
		assertEquals(
			"the offered chips are Ctrl, Alt, and Shift and nothing else",
			KeyboardModifiers.CTRL or KeyboardModifiers.ALT or KeyboardModifiers.SHIFT,
			MobileModifierLatch.SUPPORTED,
		)
	}

	@Test
	fun aRequestForAnUnsupportedChipChangesNothing() {
		val latch = MobileModifierLatch()
		assertTrue(latch.set(KeyboardModifiers.CTRL))
		for (unsupported in listOf(
			KeyboardModifiers.SUPER,
			KeyboardModifiers.META,
			KeyboardModifiers.CAPS_LOCK,
			KeyboardModifiers.NUM_LOCK,
			KeyboardModifiers.CTRL or KeyboardModifiers.SUPER,
		)) {
			assertFalse("a chip the phone cannot spell is refused", latch.set(unsupported))
			assertEquals("the held chips stay put", KeyboardModifiers.CTRL, latch.modifiers)
		}
	}

	@Test
	fun toggleFlipsOneChipAndRefusesAnyOther() {
		val latch = MobileModifierLatch()
		assertTrue(latch.toggle(KeyboardModifiers.CTRL))
		assertEquals(KeyboardModifiers.CTRL, latch.modifiers)
		assertTrue(latch.toggle(KeyboardModifiers.ALT))
		assertEquals(KeyboardModifiers.CTRL or KeyboardModifiers.ALT, latch.modifiers)
		assertTrue(latch.toggle(KeyboardModifiers.CTRL))
		assertEquals(KeyboardModifiers.ALT, latch.modifiers)
		assertFalse(latch.toggle(KeyboardModifiers.SUPER))
		assertFalse(latch.toggle(0))
		assertEquals(KeyboardModifiers.ALT, latch.modifiers)
	}

	@Test
	fun clearReportsWhetherAnythingWasActuallyHeld() {
		val latch = MobileModifierLatch()
		assertFalse("nothing was held, so there is nothing to report", latch.clear())
		assertTrue(latch.set(KeyboardModifiers.SHIFT))
		assertTrue(latch.clear())
		assertFalse("a second clear is not a change the user could see", latch.clear())
		assertEquals(0, latch.modifiers)
	}

	@Test
	fun nothingHeldIsThePlainTextCase() {
		val latch = MobileModifierLatch()
		assertTrue(latch.isPlain)
		assertTrue(latch.set(KeyboardModifiers.SHIFT))
		assertFalse(latch.isPlain)
		assertTrue(latch.clear())
		assertTrue(latch.isPlain)
	}

	@Test
	fun theLatchNeverProducesBytesSoItCannotTouchPaste() {
		// The latch is state only: nothing in it encodes anything, which is what keeps
		// an explicit paste the text the user chose rather than a control burst.
		val latch = MobileModifierLatch()
		val pasted = PasteEncoder.encode("echo hello", bracketedPaste = false) ?: error("a short paste always encodes")
		assertTrue(latch.set(KeyboardModifiers.CTRL))
		assertEquals("echo hello", String(pasted, java.nio.charset.StandardCharsets.UTF_8))
		assertTrue(latch.clear())
		val pastedAgain = PasteEncoder.encode("echo hello", bracketedPaste = false) ?: error("a short paste always encodes")
		assertEquals(
			"the same paste, byte for byte, before and after a chip was held",
			java.util.Arrays.toString(pasted),
			java.util.Arrays.toString(pastedAgain),
		)
	}

	@Test
	fun heldChipsFoldIntoAForwardedKeystrokesOwnModifiers() {
		val latch = MobileModifierLatch()
		assertEquals(0, latch.fold(0))
		assertTrue(latch.set(KeyboardModifiers.CTRL))
		assertEquals("an IME-forwarded Enter with no hardware modifiers", KeyboardModifiers.CTRL, latch.fold(0))
		assertEquals(
			KeyboardModifiers.CTRL or KeyboardModifiers.SHIFT,
			latch.fold(KeyboardModifiers.SHIFT),
		)
		assertEquals(
			"the event's own lock bits are left alone",
			KeyboardModifiers.CTRL or KeyboardModifiers.CAPS_LOCK,
			latch.fold(KeyboardModifiers.CAPS_LOCK),
		)
		assertTrue(latch.clear())
		assertEquals(KeyboardModifiers.META, latch.fold(KeyboardModifiers.META))
	}

	@Test
	fun aFoldedEditingKeyIsNotThePlainKeyAnymore() {
		// The route the input method forwards an editing key through must produce the
		// modified keystroke, not the bare one: Ctrl+Backspace and Ctrl+Enter have their
		// own spellings, and losing the chip would send the wrong one.
		val latch = MobileModifierLatch()
		assertTrue(latch.set(KeyboardModifiers.CTRL))
		for (codepoint in listOf(127, 13)) {
			val plain = KeyboardEncoder.encode(TerminalKey(codepoint = codepoint), modes())
			val folded = KeyboardEncoder.encode(
				TerminalKey(codepoint = codepoint, modifiers = latch.fold(0)),
				modes(),
			)
			assertNotNull(plain)
			assertNotNull(folded)
			assertFalse(
				"codepoint $codepoint with the chip held is not the same packet",
				java.util.Arrays.equals(plain, folded),
			)
			assertArrayEquals(key(codepoint, KeyboardModifiers.CTRL), folded)
		}
	}

	private fun key(codepoint: Int, modifiers: Int): ByteArray? =
		KeyboardEncoder.encode(TerminalKey(codepoint = codepoint, modifiers = modifiers), modes())
}
