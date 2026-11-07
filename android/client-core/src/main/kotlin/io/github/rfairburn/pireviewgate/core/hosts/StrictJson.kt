package io.github.rfairburn.pireviewgate.core.hosts

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Strict JSON element access shared by the client's closed document schemas.
 *
 * JSON string, number, and boolean are never interchangeable here: a quoted port, a
 * bare-word boolean, or a fractional count is refused instead of coerced, so a
 * hand-edited or partially written document cannot smuggle a value past validation.
 */

internal fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

internal fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

internal fun JsonElement?.asStringOrNull(): String? {
    val primitive = this as? JsonPrimitive ?: return null
    return if (primitive.isString) primitive.content else null
}

/** Non-negative JSON integer literal only; no sign, fraction, exponent, or quoting. */
internal fun JsonElement?.asNumberOrNull(): Int? {
    val primitive = this as? JsonPrimitive ?: return null
    if (primitive.isString) return null
    val content = primitive.content
    if (content.isEmpty() || content.length > 9) return null
    if (!content.all { it in '0'..'9' }) return null
    return content.toIntOrNull()
}

/** Real JSON boolean only. */
internal fun JsonElement?.asBooleanOrNull(): Boolean? {
    val primitive = this as? JsonPrimitive ?: return null
    if (primitive.isString) return null
    return when (primitive.content) {
        "true" -> true
        "false" -> false
        else -> null
    }
}
