package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings

/**
 * Local draft for the Saved LIST/SEARCH first-reply timeout.
 *
 * Editing changes only [draft]. Nothing is persisted and no intent is implied until
 * the screen's explicit Save control emits the parsed value. An empty, signed,
 * fractional, exponent, zero, or out-of-range value is not saveable; nothing is
 * clamped or treated as infinite.
 */
public data class SavedFirstReplyTimeoutEditor(
    public val currentSeconds: Int = NetworkSettings.DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_SECONDS,
    public val draft: String = currentSeconds.toString(),
) {
    /** The admitted whole-second value, or `null` while the draft is not valid. */
    public val parsedSeconds: Int? get() = NetworkSettings.parseSavedFirstReplyTimeoutSeconds(draft)

    /** True only while the draft names a value this setting can save. */
    public val isValid: Boolean get() = parsedSeconds != null

    /** Save is available exactly while the draft is valid; invalid text is never saved. */
    public val canSave: Boolean get() = parsedSeconds != null

    /** Report the invalid state without inventing a correction. */
    public val showsError: Boolean get() = !isValid

    public fun edited(text: String): SavedFirstReplyTimeoutEditor = copy(draft = text)

    public companion object {
        public fun of(currentSeconds: Int): SavedFirstReplyTimeoutEditor =
            SavedFirstReplyTimeoutEditor(currentSeconds = currentSeconds, draft = currentSeconds.toString())
    }
}
