package io.github.rfairburn.pireviewgate.core.protocol.roster.internal

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * Strict UTF-8 reading and canonical JSON writing for the roster lane.
 *
 * Reading is fatal: bytes that are not valid UTF-8 are refused, never replaced
 * with a placeholder, so a corrupted frame cannot smuggle a lookalike value past
 * a closed schema.
 *
 * Writing reproduces the source's JSON text exactly for every value this
 * contract can carry, so an encoded frame's byte size is the size the owner
 * measured against the same bound.
 */
object RosterJson {

    private const val HIGH_SURROGATE = 0xD800
    private const val HIGH_SURROGATE_LAST = 0xDBFF
    private const val LOW_SURROGATE = 0xDC00
    private const val LOW_SURROGATE_LAST = 0xDFFF

    /** True when [index] holds a high surrogate whose next unit completes a pair. */
    private fun isPairedHighSurrogate(value: String, index: Int): Boolean =
        value[index].code in HIGH_SURROGATE..HIGH_SURROGATE_LAST &&
            index + 1 < value.length &&
            value[index + 1].code in LOW_SURROGATE..LOW_SURROGATE_LAST

    private val json = Json {
        isLenient = false
        allowTrailingComma = false
        allowComments = false
    }

    /** Fatal UTF-8 decode, or `null` when the bytes are not valid UTF-8. */
    fun decodeUtf8Strict(bytes: ByteArray): String? = try {
        StandardCharsets.UTF_8
            .newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (ignored: CharacterCodingException) {
        null
    }

    /** Strict JSON read, or `null` for text that is not one JSON document. */
    fun parse(text: String): JsonElement? = try {
        json.parseToJsonElement(text)
    } catch (ignored: Exception) {
        null
    }

    /**
     * UTF-8 byte length of one string, matching the source's measurement exactly,
     * including for a code unit that is not part of a pair. Node replaces each
     * unpaired surrogate with U+FFFD and counts three bytes for it; a Java UTF-8
     * conversion would count one byte for a `?`, understating every bound the owner
     * applied to the same string.
     */
    fun utf8Length(value: String): Int {
        var bytes = 0
        var index = 0
        while (index < value.length) {
            val code = value[index].code
            when {
                code < 0x80 -> {
                    bytes += 1
                    index += 1
                }
                code < 0x800 -> {
                    bytes += 2
                    index += 1
                }
                code in HIGH_SURROGATE..HIGH_SURROGATE_LAST -> {
                    if (index + 1 < value.length && value[index + 1].code in LOW_SURROGATE..LOW_SURROGATE_LAST) {
                        bytes += 4
                        index += 2
                    } else {
                        bytes += 3
                        index += 1
                    }
                }
                code in LOW_SURROGATE..LOW_SURROGATE_LAST -> {
                    bytes += 3
                    index += 1
                }
                else -> {
                    bytes += 3
                    index += 1
                }
            }
        }
        return bytes
    }

    /**
     * Append one JSON string with the same escaping the source's serializer applies.
     *
     * A well-formed surrogate pair travels as itself. A code unit that is not part of
     * a pair is written as a lowercase `\uXXXX` escape, exactly as the source's
     * serializer does, so a native conversation id or a rename value survives the
     * round trip instead of being silently rewritten to `?`. Field rules stay
     * responsible for which strings this lane may carry at all; the writer never
     * invents a rejection of its own.
     */
    fun appendString(sb: StringBuilder, value: String) {
        sb.append('"')
        var index = 0
        while (index < value.length) {
            val code = value[index].code
            when {
                code == 0x22 -> {
                    sb.append("\\\"")
                    index += 1
                }
                code == 0x5c -> {
                    sb.append("\\\\")
                    index += 1
                }
                code == 0x08 -> {
                    sb.append("\\b")
                    index += 1
                }
                code == 0x0c -> {
                    sb.append("\\f")
                    index += 1
                }
                code == 0x0a -> {
                    sb.append("\\n")
                    index += 1
                }
                code == 0x0d -> {
                    sb.append("\\r")
                    index += 1
                }
                code == 0x09 -> {
                    sb.append("\\t")
                    index += 1
                }
                code < 0x20 -> {
                    sb.append("\\u").append(String.format("%04x", code))
                    index += 1
                }
                code in HIGH_SURROGATE..HIGH_SURROGATE_LAST -> {
                    if (isPairedHighSurrogate(value, index)) {
                        sb.append(value[index])
                        sb.append(value[index + 1])
                        index += 2
                    } else {
                        sb.append("\\u").append(String.format("%04x", code))
                        index += 1
                    }
                }
                code in LOW_SURROGATE..LOW_SURROGATE_LAST -> {
                    sb.append("\\u").append(String.format("%04x", code))
                    index += 1
                }
                else -> {
                    sb.append(value[index])
                    index += 1
                }
            }
        }
        sb.append('"')
    }

    /** The JSON text of one string, escaped the same way. */
    fun stringOf(value: String): String {
        val sb = StringBuilder()
        appendString(sb, value)
        return sb.toString()
    }

    /**
     * Append one number the way the source serializes it: an integral value loses
     * its fractional spelling, and `-0` becomes `0`.
     */
    fun appendNumber(sb: StringBuilder, value: Double) {
        if (value == Math.floor(value) && !value.isInfinite() && Math.abs(value) <= 9.007199254740991E15) {
            sb.append(value.toLong().toString())
        } else {
            sb.append(value.toString())
        }
    }

    /** The JSON text of one number, escaped the same way. */
    fun numberString(value: Double): String {
        val sb = StringBuilder()
        appendNumber(sb, value)
        return sb.toString()
    }
}
