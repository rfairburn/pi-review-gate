package io.github.rfairburn.pireviewgate.core.client.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The Saved timeout field is a local draft with an explicit, validated save. */
class SettingsUIModelsTest {

    @Test
    fun `the field starts at the remembered whole-second value`() {
        val editor = SavedFirstReplyTimeoutEditor.of(60)

        assertEquals("60", editor.draft)
        assertEquals(60, editor.parsedSeconds)
        assertTrue(editor.isValid)
        assertFalse(editor.showsError)
        assertTrue(editor.canSave, "a valid value is explicitly saveable")
    }

    @Test
    fun `editing is local and every admitted value is saveable`() {
        val changed = SavedFirstReplyTimeoutEditor.of(60).edited("120")

        assertEquals("120", changed.draft)
        assertEquals(120, changed.parsedSeconds)
        assertTrue(changed.canSave)

        val unchanged = SavedFirstReplyTimeoutEditor.of(60).edited("060")
        assertEquals(60, unchanged.parsedSeconds)
        assertTrue(unchanged.canSave)
    }

    @Test
    fun `empty zero negative fractional exponent and unsafe values are not saveable`() {
        for (text in listOf("", " ", "0", "-1", "+1", "1.5", "1e2", "1000000000", "9999999999")) {
            val editor = SavedFirstReplyTimeoutEditor.of(60).edited(text)
            assertNull(editor.parsedSeconds, "must not parse '$text'")
            assertFalse(editor.canSave, "must not save '$text'")
            assertTrue(editor.showsError)
        }
    }
}
