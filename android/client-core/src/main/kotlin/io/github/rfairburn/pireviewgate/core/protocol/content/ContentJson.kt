package io.github.rfairburn.pireviewgate.core.protocol.content

/**
 * The compact JSON tree this codec writes.
 *
 * A tree is built explicitly so that key presence, key order, and the difference
 * between an absent key and an explicit null are decided by the codec instead of
 * by a serializer's default-value policy.
 */
internal sealed interface WireNode {
	/** An explicit JSON null. */
	object WireNull : WireNode {
		override fun toString(): String = "null"
	}

	data class WireBoolean(val value: Boolean) : WireNode

	data class WireNumber(val value: Long) : WireNode

	data class WireText(val value: String) : WireNode

	data class WireArray(val items: List<WireNode>) : WireNode

	data class WireObject(val members: List<Pair<String, WireNode>>) : WireNode
}

/**
 * One object member whose value is null is omitted entirely; pass
 * [WireNode.WireNull] to write an explicit null.
 */
internal fun wireObject(vararg members: Pair<String, WireNode?>): WireNode.WireObject {
	val kept = ArrayList<Pair<String, WireNode>>(members.size)
	for (member in members) {
		val value = member.second
		if (value != null) kept.add(Pair(member.first, value))
	}
	return WireNode.WireObject(kept)
}

/** One array of already-built nodes. */
internal fun wireArray(vararg items: WireNode): WireNode.WireArray = wireArray(items.toList())

/** One array of already-built nodes. */
internal fun wireArray(items: List<WireNode>): WireNode.WireArray = WireNode.WireArray(items)

/** Serialize one tree as compact JSON text. */
internal fun writeWireNode(node: WireNode): String {
	val out = StringBuilder()
	appendWireNode(node, out)
	return out.toString()
}

private fun appendWireNode(node: WireNode, out: StringBuilder) {
	when (node) {
		WireNode.WireNull -> out.append("null")
		is WireNode.WireBoolean -> out.append(if (node.value) "true" else "false")
		is WireNode.WireNumber -> out.append(node.value.toString())
		is WireNode.WireText -> appendWireString(node.value, out)
		is WireNode.WireArray -> {
			out.append('[')
			var first = true
			for (item in node.items) {
				if (!first) out.append(',')
				first = false
				appendWireNode(item, out)
			}
			out.append(']')
		}

		is WireNode.WireObject -> {
			out.append('{')
			var first = true
			for (member in node.members) {
				if (!first) out.append(',')
				first = false
				appendWireString(member.first, out)
				out.append(':')
				appendWireNode(member.second, out)
			}
			out.append('}')
		}
	}
}

/**
 * Quote one string exactly as the native serializer does: control characters and
 * the two JSON structural characters are escaped, and an unpaired surrogate is
 * written as an explicit six-character Unicode escape so no byte encoding can replace
 * it with a different character.
 */
internal fun appendWireString(text: String, out: StringBuilder) {
	out.append('"')
	var index = 0
	while (index < text.length) {
		val code = text[index].code
		if (code in 0xD800..0xDBFF && index + 1 < text.length && text[index + 1].code in 0xDC00..0xDFFF) {
			out.append(text[index])
			out.append(text[index + 1])
			index += 2
			continue
		}
		when (code) {
			0x22 -> out.append("\\\"")
			0x5c -> out.append("\\\\")
			0x08 -> out.append("\\b")
			0x09 -> out.append("\\t")
			0x0a -> out.append("\\n")
			0x0c -> out.append("\\f")
			0x0d -> out.append("\\r")
			in 0xD800..0xDFFF -> {
				appendUnicodeEscape(out, code)
			}

			else -> {
				if (code < 0x20) {
					appendUnicodeEscape(out, code)
				} else {
					out.append(text[index])
				}
			}
		}
		index += 1
	}
	out.append('"')
}

private fun appendUnicodeEscape(out: StringBuilder, code: Int) {
	out.append('\\')
	out.append('u')
	appendHex4(out, code)
}

private fun appendHex4(out: StringBuilder, code: Int) {
	val digits = "0123456789abcdef"
	out.append(digits[(code shr 12) and 0xf])
	out.append(digits[(code shr 8) and 0xf])
	out.append(digits[(code shr 4) and 0xf])
	out.append(digits[code and 0xf])
}
