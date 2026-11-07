package io.github.rfairburn.pireviewgate.core.protocol.content

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Largest integer the wire can carry exactly. */
internal const val MAX_SAFE_INTEGER: Long = 9_007_199_254_740_991L

/** Largest unsigned 32-bit integer, the bound on negotiated versions. */
internal const val MAX_U32: Long = 4_294_967_295L

/** Largest PNG dimension a validated native graphics image can declare (u32). */
internal const val MAX_GRAPHICS_DIMENSION: Long = 4_294_967_295L

/** Bytes in one service identifier. */
private const val MAX_SERVICE_BYTES = 128

/** Throw the one fixed failure for anything this protocol cannot represent. */
internal fun fail(code: ContentFailureCode): Nothing = throw ContentProtocolException(code)

internal val IDENTIFIER_PATTERN = Regex("[A-Za-z0-9][A-Za-z0-9._:-]*")
private val INTEGER_LITERAL_PATTERN = Regex("-?(?:0|[1-9][0-9]*)")
private val SOURCE_TOKEN_PATTERN = Regex("[!-~]+")

/** One canonical viewer SGR mouse packet in CONTENT coordinates. */
private val MOUSE_PACKET_PATTERN =
	Regex("\u001b\\[<(?:0|[1-9][0-9]{0,2});(?:[1-9][0-9]{0,3});(?:[1-9][0-9]{0,3})[Mm]")

/** Only text and exactly the SGR forms the native serializer generates. */
private val SGR_PARAM_PATTERN = Regex("0|[1-9][0-9]{0,2}")

/** The only attribute parameters the native serializer emits, in its exact order. */
private val SGR_ATTRIBUTE_ORDER = listOf("1", "2", "3", "4", "5", "7", "8", "9", "53")

private val SGR_FOREGROUND_RANGES = listOf(30..37, 90..97)
private val SGR_BACKGROUND_RANGES = listOf(40..47, 100..107)

/* ------------------------------------------------------------------------- *
 * Closed-shape helpers
 * ------------------------------------------------------------------------- */

private fun JsonObject.element(key: String): JsonElement = this[key] ?: fail(ContentFailureCode.BAD_FRAME)

private fun JsonObject.string(key: String): String {
	val value = element(key)
	if (value !is JsonPrimitive || !value.isString) fail(ContentFailureCode.BAD_FRAME)
	return value.content
}

private fun JsonObject.integer(key: String, min: Long, max: Long): Long = readInteger(element(key), min, max)

private fun JsonObject.boolean(key: String): Boolean = readBoolean(element(key))

private fun readInteger(value: JsonElement, min: Long, max: Long): Long {
	if (value !is JsonPrimitive || value.isString) fail(ContentFailureCode.BAD_FRAME)
	val text = value.content
	if (!INTEGER_LITERAL_PATTERN.matches(text)) fail(ContentFailureCode.BAD_FRAME)
	val number = text.toLongOrNull() ?: fail(ContentFailureCode.BAD_FRAME)
	if (number < min || number > max) fail(ContentFailureCode.BAD_FRAME)
	return number
}

private fun readBoolean(value: JsonElement): Boolean {
	if (value !is JsonPrimitive || value.isString) fail(ContentFailureCode.BAD_FRAME)
	return when (value.content) {
		"true" -> true
		"false" -> false
		else -> fail(ContentFailureCode.BAD_FRAME)
	}
}

/** Refuse any key outside [allowed] and require every key in [required]. */
private fun readExactKeys(
	record: JsonObject,
	allowed: Set<String>,
	required: Set<String>,
	code: ContentFailureCode,
) {
	for (key in record.keys) {
		if (!allowed.contains(key)) fail(code)
	}
	for (key in required) {
		if (!record.containsKey(key)) fail(code)
	}
}

/** An opaque identifier never holds a control character or a line separator. */
private fun containsUnsafeText(value: String): Boolean {
	for (index in value.indices) {
		val code = value[index].code
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code == 0x2028 || code == 0x2029) return true
	}
	return false
}

private fun readIdentifierValue(value: String, maxBytes: Int): String {
	if (value.isEmpty()) fail(ContentFailureCode.BAD_FRAME)
	if (Utf8Wire.byteLength(value) > maxBytes) fail(ContentFailureCode.BAD_FRAME)
	if (!IDENTIFIER_PATTERN.matches(value)) fail(ContentFailureCode.BAD_FRAME)
	return value
}

private fun readOpaqueIdValue(value: String, maxBytes: Int): String {
	if (value.isEmpty()) fail(ContentFailureCode.BAD_FRAME)
	if (Utf8Wire.byteLength(value) > maxBytes) fail(ContentFailureCode.BAD_FRAME)
	if (containsUnsafeText(value)) fail(ContentFailureCode.BAD_FRAME)
	return value
}

private fun readServiceValue(value: String): String {
	if (value.isEmpty()) fail(ContentFailureCode.BAD_FRAME)
	if (Utf8Wire.byteLength(value) > MAX_SERVICE_BYTES) fail(ContentFailureCode.BAD_FRAME)
	if (containsUnsafeText(value)) fail(ContentFailureCode.BAD_FRAME)
	return value
}

private fun readCapabilitiesValue(value: JsonElement, bounds: ContentBounds): List<String> {
	if (value !is JsonArray) fail(ContentFailureCode.BAD_FRAME)
	if (value.size > bounds.maxCapabilities) fail(ContentFailureCode.BAD_FRAME)
	val seen = HashSet<String>()
	val capabilities = ArrayList<String>(value.size)
	for (entry in value) {
		if (entry !is JsonPrimitive || !entry.isString) fail(ContentFailureCode.BAD_FRAME)
		val capability = entry.content
		if (Utf8Wire.byteLength(capability) > bounds.maxCapabilityIdBytes) fail(ContentFailureCode.BAD_FRAME)
		if (!IDENTIFIER_PATTERN.matches(capability)) fail(ContentFailureCode.BAD_FRAME)
		if (!seen.add(capability)) fail(ContentFailureCode.BAD_FRAME)
		capabilities.add(capability)
	}
	return capabilities
}

/* ------------------------------------------------------------------------- *
 * Shared nested shapes
 * ------------------------------------------------------------------------- */

private val GEOMETRY_KEYS = setOf("cols", "rows", "revision")

private fun readGeometry(value: JsonElement, bounds: ContentBounds): SessionGeometry {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, GEOMETRY_KEYS, GEOMETRY_KEYS, ContentFailureCode.BAD_FRAME)
	return SessionGeometry(
		cols = value.integer("cols", 1L, bounds.maxCols.toLong()).toInt(),
		rows = value.integer("rows", 1L, bounds.maxRows.toLong()).toInt(),
		// The owning manager's geometry revision starts at zero.
		revision = value.integer("revision", 0L, MAX_SAFE_INTEGER),
	)
}

private val INPUT_MODE_KEYS = setOf(
	"kittyFlags",
	"applicationCursorKeys",
	"applicationKeypad",
	"bracketedPaste",
	"mouseTracking",
	"modifyOtherKeys",
	"mouseEncoding",
)

private fun readInputModes(value: JsonElement): TerminalInputModes {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, INPUT_MODE_KEYS, INPUT_MODE_KEYS, ContentFailureCode.BAD_FRAME)
	val mouseTracking = MouseTrackingMode.fromWireValue(value.string("mouseTracking"))
		?: fail(ContentFailureCode.BAD_FRAME)
	val mouseEncoding = MouseEncodingMode.fromWireValue(value.string("mouseEncoding"))
		?: fail(ContentFailureCode.BAD_FRAME)
	return TerminalInputModes(
		kittyFlags = value.integer("kittyFlags", 0L, 7L).toInt(),
		applicationCursorKeys = value.boolean("applicationCursorKeys"),
		applicationKeypad = value.boolean("applicationKeypad"),
		bracketedPaste = value.boolean("bracketedPaste"),
		mouseTracking = mouseTracking,
		modifyOtherKeys = value.integer("modifyOtherKeys", 0L, 2L).toInt(),
		mouseEncoding = mouseEncoding,
	)
}

private val NATIVE_SESSION_KEYS = setOf("sessionId", "epoch")

private fun readNativeSession(value: JsonElement, bounds: ContentBounds): NativeSessionRef? {
	if (value is JsonNull) return null
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, NATIVE_SESSION_KEYS, NATIVE_SESSION_KEYS, ContentFailureCode.BAD_FRAME)
	return NativeSessionRef(
		sessionId = readOpaqueIdValue(value.string("sessionId"), bounds.maxIdentifierBytes),
		epoch = value.integer("epoch", 1L, MAX_SAFE_INTEGER),
	)
}

/** Decode one canonical base64 chunk payload, bounded before allocation. */
private fun readChunkPayload(value: JsonElement, bounds: ContentBounds): ByteArray {
	if (value !is JsonPrimitive || !value.isString || value.content.isEmpty()) {
		fail(ContentFailureCode.BAD_FRAME)
	}
	val encoded = value.content
	if (!Base64Wire.isLooseBase64(encoded)) fail(ContentFailureCode.BAD_FRAME)
	// Base64 length alone already proves an oversized decoded payload, so the
	// budget is enforced before any decoded buffer is allocated.
	if ((encoded.length / 4.0) * 3.0 - 2.0 > bounds.maxChunkPayloadBytes) fail(ContentFailureCode.FRAME_TOO_LARGE)
	val bytes = Base64Wire.decodeCanonical(encoded) ?: fail(ContentFailureCode.BAD_FRAME)
	if (bytes.size > bounds.maxChunkPayloadBytes) fail(ContentFailureCode.FRAME_TOO_LARGE)
	return bytes
}

/* ------------------------------------------------------------------------- *
 * Optional native IO readers
 *
 * Every shape here is closed and bounded. These readers only establish what a
 * frame may express: they never decide that a capability was negotiated, that a
 * source is current, or that a write is allowed.
 * ------------------------------------------------------------------------- */

private val NATIVE_IO_SOURCE_KEYS = setOf(
	"hostRunId",
	"sessionId",
	"nativeSession",
	"geometry",
	"viewerRevision",
	"sourceToken",
)

/** Validate one exact native IO source; the native tuple is always present. */
private fun readNativeIoSource(value: JsonElement, bounds: ContentBounds): NativeIoSource {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, NATIVE_IO_SOURCE_KEYS, NATIVE_IO_SOURCE_KEYS, ContentFailureCode.BAD_FRAME)
	val nativeSession = readNativeSession(value.element("nativeSession"), bounds)
		?: fail(ContentFailureCode.BAD_FRAME)
	return NativeIoSource(
		hostRunId = readIdentifierValue(value.string("hostRunId"), bounds.maxIdentifierBytes),
		sessionId = readIdentifierValue(value.string("sessionId"), bounds.maxIdentifierBytes),
		nativeSession = nativeSession,
		geometry = readGeometry(value.element("geometry"), bounds),
		// A viewer revision is a positive count, never the zero a geometry starts at.
		viewerRevision = value.integer("viewerRevision", 1L, MAX_SAFE_INTEGER),
		sourceToken = readNativeIoSourceToken(value.string("sourceToken")),
	)
}

private val NATIVE_IO_STARTUP_SOURCE_KEYS = setOf(
	"hostRunId",
	"sessionId",
	"phase",
	"geometry",
	"viewerRevision",
	"sourceToken",
)

/**
 * Validate one exact startup source: closed keys, the one legal phase value, and
 * no native tuple key at all (a null or fabricated tuple is refused).
 */
private fun readNativeIoStartupSource(value: JsonElement, bounds: ContentBounds): NativeIoStartupSource {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, NATIVE_IO_STARTUP_SOURCE_KEYS, NATIVE_IO_STARTUP_SOURCE_KEYS, ContentFailureCode.BAD_FRAME)
	if (value.string("phase") != "startup") fail(ContentFailureCode.BAD_FRAME)
	return NativeIoStartupSource(
		hostRunId = readIdentifierValue(value.string("hostRunId"), bounds.maxIdentifierBytes),
		sessionId = readIdentifierValue(value.string("sessionId"), bounds.maxIdentifierBytes),
		geometry = readGeometry(value.element("geometry"), bounds),
		viewerRevision = value.integer("viewerRevision", 1L, MAX_SAFE_INTEGER),
		sourceToken = readNativeIoSourceToken(value.string("sourceToken")),
	)
}

/**
 * Validate one input-path source: a startup source when (and only when) the
 * object names a `phase`, otherwise the unchanged conversation source. Copy
 * paths never call this, so a startup source is never readable as a copy source.
 */
private fun readNativeIoInputSource(value: JsonElement, bounds: ContentBounds): NativeIoInputSource {
	if (value is JsonObject && value.containsKey("phase")) {
		return readNativeIoStartupSource(value, bounds)
	}
	return readNativeIoSource(value, bounds)
}

private fun readNativeIoSourceToken(value: String): String {
	if (value.isEmpty()) fail(ContentFailureCode.BAD_FRAME)
	if (value.length > ContentProtocol.NATIVE_IO_MAX_SOURCE_TOKEN_BYTES) fail(ContentFailureCode.BAD_FRAME)
	if (!SOURCE_TOKEN_PATTERN.matches(value)) fail(ContentFailureCode.BAD_FRAME)
	return value
}

/** One bounded native input payload slice, decoded by kind. */
private fun readNativeInputData(value: JsonElement, kind: NativeIoInputKind, bounds: ContentBounds): ByteArray {
	val bytes = readChunkPayload(value, bounds)
	if (kind == NativeIoInputKind.PASTE && bytes.size > ContentProtocol.NATIVE_TEXT_PASTE_MAX_BYTES) {
		fail(ContentFailureCode.TRANSFER_TOO_LARGE)
	}
	val text = Utf8Wire.decodeStrict(bytes) ?: fail(ContentFailureCode.BAD_FRAME)
	if (kind == NativeIoInputKind.MOUSE && !MOUSE_PACKET_PATTERN.matches(text)) fail(ContentFailureCode.BAD_FRAME)
	return bytes
}

/** Declared decoded byte length of one paged native text paste. */
private fun readNativePasteByteLength(value: JsonElement, bounds: ContentBounds): Int {
	val pasteMax = minOf(ContentProtocol.NATIVE_TEXT_PASTE_MAX_BYTES.toLong(), bounds.maxTransferBytes.toLong())
	return readInteger(value, 1L, pasteMax).toInt()
}

/**
 * One whole native text-copy payload: canonical base64 of UTF-8 text, bounded by
 * the unchanged producer limit. Binary or image clipboard data is refused here.
 */
private fun readNativeCopyEncoded(value: JsonElement): String {
	if (value !is JsonPrimitive || !value.isString || value.content.isEmpty()) {
		fail(ContentFailureCode.BAD_FRAME)
	}
	val encoded = value.content
	if (encoded.length > ContentProtocol.NATIVE_COPY_MAX_ENCODED_CHARS) fail(ContentFailureCode.TRANSFER_TOO_LARGE)
	if (!Base64Wire.isLooseBase64(encoded)) fail(ContentFailureCode.BAD_FRAME)
	val bytes = Base64Wire.decodeCanonical(encoded) ?: fail(ContentFailureCode.BAD_FRAME)
	Utf8Wire.decodeStrict(bytes) ?: fail(ContentFailureCode.BAD_FRAME)
	return encoded
}

private val NATIVE_IO_COPY_EVENT_KEYS = setOf("kind", "encoded", "sessionId", "sessionEpoch")
private val NATIVE_IO_COPY_UNAVAILABLE_KEYS = setOf("kind", "reason", "sessionId", "sessionEpoch")

private fun readNativeCopyEvent(value: JsonElement, bounds: ContentBounds): NativeIoCopyEvent {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	val kind = value.string("kind")
	if (kind != "copy" && kind != "unavailable") fail(ContentFailureCode.BAD_FRAME)
	// Closed keys first: nothing outside the producer's event shape rides along.
	val keys = if (kind == "copy") NATIVE_IO_COPY_EVENT_KEYS else NATIVE_IO_COPY_UNAVAILABLE_KEYS
	readExactKeys(value, keys, keys, ContentFailureCode.BAD_FRAME)
	val sessionId = readOpaqueIdValue(value.string("sessionId"), bounds.maxIdentifierBytes)
	val sessionEpoch = value.integer("sessionEpoch", 1L, MAX_SAFE_INTEGER)
	if (kind == "copy") {
		return NativeIoCopyEvent.Copy(
			encoded = readNativeCopyEncoded(value.element("encoded")),
			sessionId = sessionId,
			sessionEpoch = sessionEpoch,
		)
	}
	val reason = NativeIoCopyUnavailableReason.fromWireValue(value.string("reason"))
		?: fail(ContentFailureCode.BAD_FRAME)
	return NativeIoCopyEvent.Unavailable(reason = reason, sessionId = sessionId, sessionEpoch = sessionEpoch)
}

/**
 * A `content_begin` may describe a native IO source only for ITS OWN native
 * snapshot: the source must name the same owner run, the same owner row, the same
 * native tuple, and exactly the same geometry including its revision as the frame
 * that carries it, and a frame that reports no native session cannot be handed a
 * live tuple by its source. Two independently well-formed objects that describe
 * different snapshots are refused, never merged into one publish.
 *
 * This is a coherence check and nothing else: it creates no permission, gate, or
 * lease, and the source token remains non-authoritative.
 */
private fun checkInputSourceCoherence(
	inputSource: NativeIoInputSource,
	hostRunId: String,
	sessionId: String,
	nativeSession: NativeSessionRef?,
	geometry: SessionGeometry,
) {
	if (inputSource is NativeIoStartupSource) {
		// A startup source describes ONLY a publish that names no native
		// conversation; a frame with a tuple can never be paired with one.
		if (nativeSession != null) fail(ContentFailureCode.BAD_FRAME)
		if (inputSource.hostRunId != hostRunId) fail(ContentFailureCode.BAD_FRAME)
		if (inputSource.sessionId != sessionId) fail(ContentFailureCode.BAD_FRAME)
		if (inputSource.geometry.cols != geometry.cols ||
			inputSource.geometry.rows != geometry.rows ||
			inputSource.geometry.revision != geometry.revision
		) {
			fail(ContentFailureCode.BAD_FRAME)
		}
		return
	}
	val conversation = inputSource as NativeIoSource
	// No native session in the frame means there is no tuple a source may claim.
	if (nativeSession == null) fail(ContentFailureCode.BAD_FRAME)
	if (conversation.hostRunId != hostRunId) fail(ContentFailureCode.BAD_FRAME)
	if (conversation.sessionId != sessionId) fail(ContentFailureCode.BAD_FRAME)
	if (conversation.nativeSession.sessionId != nativeSession.sessionId) fail(ContentFailureCode.BAD_FRAME)
	if (conversation.nativeSession.epoch != nativeSession.epoch) fail(ContentFailureCode.BAD_FRAME)
	// Equal dimensions are not enough: the geometry revision is part of identity.
	if (conversation.geometry.cols != geometry.cols ||
		conversation.geometry.rows != geometry.rows ||
		conversation.geometry.revision != geometry.revision
	) {
		fail(ContentFailureCode.BAD_FRAME)
	}
}

/**
 * A copy names one authenticated native conversation twice: in the frame source
 * and in the producer's event. The two must agree, so an inline payload can never
 * be attributed to a different tuple. Coherence only; no permission, gate, or
 * lease is created here.
 */
private fun checkCopyTupleCoherence(source: NativeIoSource, event: NativeIoCopyEvent) {
	if (event.sessionId != source.nativeSession.sessionId) fail(ContentFailureCode.BAD_FRAME)
	if (event.sessionEpoch != source.nativeSession.epoch) fail(ContentFailureCode.BAD_FRAME)
}

/* ------------------------------------------------------------------------- *
 * Generated SGR snapshot validation
 * ------------------------------------------------------------------------- */

/** A single bounded color component parameter (0-255), or null. */
private fun sgrColorComponent(value: String?): Int? {
	if (value == null || !SGR_PARAM_PATTERN.matches(value)) return null
	val numeric = value.toIntOrNull() ?: return null
	return if (numeric <= 255) numeric else null
}

/**
 * Consume at most one palette/RGB color group, exactly as the native serializer
 * emits it. Returns the index after the group, or [start] when no such group is
 * present; an incomplete or out-of-range group is left unconsumed so the whole
 * parameter list is refused.
 */
private fun skipNativeColorGroup(
	parts: List<String>,
	start: Int,
	extended: String,
	simpleRanges: List<IntRange>,
): Int {
	if (start >= parts.size) return start
	if (parts[start] == extended) {
		if (parts.getOrNull(start + 1) == "5") {
			return if (sgrColorComponent(parts.getOrNull(start + 2)) == null) start else start + 3
		}
		if (parts.getOrNull(start + 1) == "2") {
			if (sgrColorComponent(parts.getOrNull(start + 2)) == null ||
				sgrColorComponent(parts.getOrNull(start + 3)) == null ||
				sgrColorComponent(parts.getOrNull(start + 4)) == null
			) {
				return start
			}
			return start + 5
		}
		return start
	}
	val value = sgrColorComponent(parts[start]) ?: return start
	if (simpleRanges.any { value in it }) return start + 1
	return start
}

/**
 * Whether one generated SGR parameter list is a form the native serializer can
 * produce: `0` alone, or the ascending allowlisted attributes followed by at most
 * one foreground and at most one background color group. Anything else —
 * unsupported attributes, out-of-range colors, reordered or incomplete groups,
 * and empty lists — is not native output.
 */
private fun isNativeSgrParams(params: String): Boolean {
	if (params == "0") return true
	if (params.isEmpty()) return false
	val parts = params.split(";")
	for (part in parts) {
		if (!SGR_PARAM_PATTERN.matches(part)) return false
	}
	var index = 0
	// Attributes must appear as an ascending subsequence of the serializer's own
	// order, so `\x1b[53m` (overline alone) and `\x1b[4;53m` are native forms while
	// `\x1b[9;8m` (reordered) and `\x1b[51m` (never emitted) are not.
	var attributeCursor = 0
	while (index < parts.size && attributeCursor < SGR_ATTRIBUTE_ORDER.size) {
		var nextAttribute = attributeCursor
		while (nextAttribute < SGR_ATTRIBUTE_ORDER.size && SGR_ATTRIBUTE_ORDER[nextAttribute] != parts[index]) {
			nextAttribute += 1
		}
		if (nextAttribute == SGR_ATTRIBUTE_ORDER.size) break
		attributeCursor = nextAttribute + 1
		index += 1
	}
	index = skipNativeColorGroup(parts, index, "38", SGR_FOREGROUND_RANGES)
	index = skipNativeColorGroup(parts, index, "48", SGR_BACKGROUND_RANGES)
	return index == parts.size
}

/**
 * Validate one frame row: visible text plus only SGR sequences generated by the
 * native serializer. No OSC/CSI/APC/DCS control, cursor, clipboard, or raw
 * attribute payload can pass; legitimate Unicode (combining marks, wide cells) is
 * preserved exactly.
 */
private fun isNativeFrameLine(line: String): Boolean {
	var index = 0
	while (index < line.length) {
		val code = line[index].code
		if (code == 0x1b) {
			if (index + 1 >= line.length || line[index + 1].code != 0x5b) return false
			val terminator = line.indexOf('m', index + 2)
			if (terminator < 0) return false
			if (!isNativeSgrParams(line.substring(index + 2, terminator))) return false
			index = terminator + 1
			continue
		}
		if (code < 0x20 || code == 0x7f || (code >= 0x80 && code <= 0x9f)) return false
		index += 1
	}
	return true
}

private fun isNativeVisibleText(text: String): Boolean {
	if (text.isEmpty()) return false
	for (index in text.indices) {
		val code = text[index].code
		if (code < 0x20 || code == 0x7f || (code >= 0x80 && code <= 0x9f)) return false
	}
	return true
}

private fun readVisibleText(value: JsonElement): String {
	if (value !is JsonPrimitive || !value.isString) fail(ContentFailureCode.BAD_FRAME)
	if (!isNativeVisibleText(value.content)) fail(ContentFailureCode.BAD_FRAME)
	return value.content
}

/* ------------------------------------------------------------------------- *
 * Native viewport payload
 * ------------------------------------------------------------------------- */

private val COLOR_KEYS = setOf("mode", "value")

private fun readColorSpec(value: JsonElement): TerminalColorSpec {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, COLOR_KEYS, COLOR_KEYS, ContentFailureCode.BAD_FRAME)
	val mode = TerminalColorMode.fromWireValue(value.string("mode")) ?: fail(ContentFailureCode.BAD_FRAME)
	return when (mode) {
		TerminalColorMode.DEFAULT -> {
			readInteger(value.element("value"), 0L, 0L)
			TerminalColorSpec(mode = mode, value = 0)
		}

		TerminalColorMode.PALETTE -> TerminalColorSpec(mode, value.integer("value", 0L, 255L).toInt())
		TerminalColorMode.RGB -> TerminalColorSpec(mode, value.integer("value", 0L, 0xffffffL).toInt())
	}
}

private val RUN_KEYS = setOf(
	"startColumn",
	"text",
	"fg",
	"bg",
	"bold",
	"dim",
	"italic",
	"underline",
	"inverse",
	"blink",
	"invisible",
	"strikethrough",
	"overline",
)
private val RUN_REQUIRED_KEYS = setOf("startColumn", "text")
private val RUN_ATTRIBUTE_KEYS =
	listOf("bold", "dim", "italic", "underline", "inverse", "blink", "invisible", "strikethrough", "overline")

private fun readCellRun(value: JsonElement, cols: Int): TerminalCellRun {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, RUN_KEYS, RUN_REQUIRED_KEYS, ContentFailureCode.BAD_FRAME)
	val startColumn = value.integer("startColumn", 0L, (cols - 1).toLong()).toInt()
	val text = readVisibleText(value.element("text"))
	val fg = if (value.containsKey("fg")) readColorSpec(value.element("fg")) else null
	val bg = if (value.containsKey("bg")) readColorSpec(value.element("bg")) else null
	var bold = false
	var dim = false
	var italic = false
	var underline = false
	var inverse = false
	var blink = false
	var invisible = false
	var strikethrough = false
	var overline = false
	for (key in RUN_ATTRIBUTE_KEYS) {
		if (!value.containsKey(key)) continue
		// The native serializer omits default attributes; it never emits false.
		if (!readBoolean(value.element(key))) fail(ContentFailureCode.BAD_FRAME)
		when (key) {
			"bold" -> bold = true
			"dim" -> dim = true
			"italic" -> italic = true
			"underline" -> underline = true
			"inverse" -> inverse = true
			"blink" -> blink = true
			"invisible" -> invisible = true
			"strikethrough" -> strikethrough = true
			else -> overline = true
		}
	}
	return TerminalCellRun(
		startColumn = startColumn,
		text = text,
		fg = fg,
		bg = bg,
		bold = bold,
		dim = dim,
		italic = italic,
		underline = underline,
		inverse = inverse,
		blink = blink,
		invisible = invisible,
		strikethrough = strikethrough,
		overline = overline,
	)
}

private val STYLE_LINE_KEYS = setOf("line", "runs")

private fun readStyleLine(value: JsonElement, cols: Int, rows: Int): TerminalLineStyles {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, STYLE_LINE_KEYS, STYLE_LINE_KEYS, ContentFailureCode.BAD_FRAME)
	val line = value.integer("line", 0L, (rows - 1).toLong()).toInt()
	val rawRuns = value.element("runs")
	if (rawRuns !is JsonArray || rawRuns.isEmpty()) fail(ContentFailureCode.BAD_FRAME)
	val runs = ArrayList<TerminalCellRun>(rawRuns.size)
	var previousColumn = -1
	for (rawRun in rawRuns) {
		val run = readCellRun(rawRun, cols)
		if (run.startColumn <= previousColumn) fail(ContentFailureCode.BAD_FRAME)
		previousColumn = run.startColumn
		runs.add(run)
	}
	return TerminalLineStyles(line = line, runs = runs)
}

private fun readStyles(value: JsonElement, cols: Int, rows: Int): List<TerminalLineStyles> {
	if (value !is JsonArray) fail(ContentFailureCode.BAD_FRAME)
	val styles = ArrayList<TerminalLineStyles>(value.size)
	var previousLine = -1
	for (entry in value) {
		val style = readStyleLine(entry, cols, rows)
		if (style.line <= previousLine) fail(ContentFailureCode.BAD_FRAME)
		previousLine = style.line
		styles.add(style)
	}
	return styles
}

private val CURSOR_KEYS = setOf("column", "row", "visible")

private fun readCursor(value: JsonElement, cols: Int, rows: Int): TerminalCursor {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, CURSOR_KEYS, CURSOR_KEYS, ContentFailureCode.BAD_FRAME)
	return TerminalCursor(
		column = value.integer("column", 0L, (cols - 1).toLong()).toInt(),
		row = value.integer("row", 0L, (rows - 1).toLong()).toInt(),
		visible = value.boolean("visible"),
	)
}

private val GRAPHICS_KEYS = setOf("images", "placements", "fallbacks")
private val IMAGE_KEYS = setOf("id", "mimeType", "widthPx", "heightPx", "base64")

private class NormalizedImages(
	val list: List<TerminalGraphicsImage>,
	val byId: Map<String, TerminalGraphicsImage>,
)

/**
 * Images reuse the exact native PNG subset: canonical base64, PNG signature,
 * per-chunk CRCs, IHDR depth/color/interlace rules, decoded and base64 byte
 * bounds, dimension and pixel bounds, and refusal of animated PNGs all come from
 * the shared validator, never from a weaker local copy.
 */
private fun readImages(value: JsonElement, bounds: ContentBounds): NormalizedImages {
	if (value !is JsonArray) fail(ContentFailureCode.BAD_FRAME)
	val list = ArrayList<TerminalGraphicsImage>(value.size)
	val byId = HashMap<String, TerminalGraphicsImage>()
	for (entry in value) {
		if (entry !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
		readExactKeys(entry, IMAGE_KEYS, IMAGE_KEYS, ContentFailureCode.BAD_FRAME)
		val id = readOpaqueIdValue(entry.string("id"), bounds.maxIdentifierBytes)
		if (byId.containsKey(id)) fail(ContentFailureCode.BAD_FRAME)
		if (entry.string("mimeType") != TERMINAL_GRAPHICS_PNG_MIME_TYPE) fail(ContentFailureCode.BAD_FRAME)
		val base64 = entry.string("base64")
		val validated = KittyPngValidator.validate(base64) ?: fail(ContentFailureCode.BAD_FRAME)
		val widthPx = entry.integer("widthPx", 1L, MAX_GRAPHICS_DIMENSION)
		val heightPx = entry.integer("heightPx", 1L, MAX_GRAPHICS_DIMENSION)
		if (widthPx != validated.widthPx.toLong() || heightPx != validated.heightPx.toLong()) {
			fail(ContentFailureCode.BAD_FRAME)
		}
		val image = TerminalGraphicsImage(
			id = id,
			mimeType = TERMINAL_GRAPHICS_PNG_MIME_TYPE,
			widthPx = validated.widthPx,
			heightPx = validated.heightPx,
			base64 = base64,
		)
		byId.put(id, image)
		list.add(image)
	}
	return NormalizedImages(list = list, byId = byId)
}

private val CROP_KEYS = setOf("x", "y", "width", "height")

private fun readCrop(value: JsonElement, image: TerminalGraphicsImage): TerminalGraphicsCrop {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, CROP_KEYS, CROP_KEYS, ContentFailureCode.BAD_FRAME)
	val x = value.integer("x", 0L, MAX_GRAPHICS_DIMENSION)
	val y = value.integer("y", 0L, MAX_GRAPHICS_DIMENSION)
	val width = value.integer("width", 1L, MAX_GRAPHICS_DIMENSION)
	val height = value.integer("height", 1L, MAX_GRAPHICS_DIMENSION)
	if (x + width > image.widthPx.toLong() || y + height > image.heightPx.toLong()) {
		fail(ContentFailureCode.BAD_FRAME)
	}
	return TerminalGraphicsCrop(x = x, y = y, width = width, height = height)
}

private val CLIP_KEYS = setOf("leftColumns", "topRows", "rightColumns", "bottomRows")

/**
 * The clip exactly as the peer stated it. Values are kept as read, so a number
 * too large for a cell count is compared honestly instead of narrowing its way
 * into a match.
 */
private class RawClip(
	val leftColumns: Long,
	val topRows: Long,
	val rightColumns: Long,
	val bottomRows: Long,
)

private fun readClip(value: JsonElement): RawClip {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, CLIP_KEYS, CLIP_KEYS, ContentFailureCode.BAD_FRAME)
	return RawClip(
		leftColumns = readInteger(value.element("leftColumns"), 0L, MAX_SAFE_INTEGER),
		topRows = readInteger(value.element("topRows"), 0L, MAX_SAFE_INTEGER),
		rightColumns = readInteger(value.element("rightColumns"), 0L, MAX_SAFE_INTEGER),
		bottomRows = readInteger(value.element("bottomRows"), 0L, MAX_SAFE_INTEGER),
	)
}

/** The exact viewport-edge clip the native graphics frame derives for a placement. */
private fun expectedClip(
	column: Int,
	row: Int,
	columns: Int,
	rows: Int,
	viewportCols: Int,
	viewportRows: Int,
): TerminalGraphicsClip = TerminalGraphicsClip(
	leftColumns = maxOf(0, -column),
	topRows = maxOf(0, -row),
	rightColumns = maxOf(0, column + columns - viewportCols),
	bottomRows = maxOf(0, row + rows - viewportRows),
)

private class Footprint(
	val column: Int,
	val row: Int,
	val columns: Int,
	val rows: Int,
	val clip: TerminalGraphicsClip,
)

private fun readFootprint(
	record: JsonObject,
	cols: Int,
	rows: Int,
	bounds: ContentBounds,
): Footprint {
	val columns = record.integer("columns", 1L, bounds.maxCols.toLong()).toInt()
	val placementRows = record.integer("rows", 1L, bounds.maxRows.toLong()).toInt()
	// Native cell-space anchors: a placement starts inside the viewport
	// horizontally, but its row may sit far above a short viewport as long as
	// the placement's own footprint still contributes a visible cell.
	val column = record.integer("column", 0L, (cols - 1).toLong()).toInt()
	val row = record.integer("row", (-(placementRows - 1)).toLong(), (rows - 1).toLong()).toInt()
	val clip = readClip(record.element("clip"))
	val expected = expectedClip(column, row, columns, placementRows, cols, rows)
	if (clip.leftColumns != expected.leftColumns.toLong() ||
		clip.topRows != expected.topRows.toLong() ||
		clip.rightColumns != expected.rightColumns.toLong() ||
		clip.bottomRows != expected.bottomRows.toLong()
	) {
		fail(ContentFailureCode.BAD_FRAME)
	}
	// Native clips refuse a placement that contributes no visible cell.
	if (expected.leftColumns >= columns ||
		expected.topRows >= placementRows ||
		expected.rightColumns >= columns ||
		expected.bottomRows >= placementRows ||
		expected.leftColumns + expected.rightColumns >= columns ||
		expected.topRows + expected.bottomRows >= placementRows
	) {
		fail(ContentFailureCode.BAD_FRAME)
	}
	// The peer's clip proved equal to the derived one in cell-sized integers, so the
	// derived value is what a caller of this codec sees.
	return Footprint(column = column, row = row, columns = columns, rows = placementRows, clip = expected)
}

private val PLACEMENT_KEYS =
	setOf("id", "imageId", "column", "row", "columns", "rows", "crop", "clip")

private fun readPlacements(
	value: JsonElement,
	images: NormalizedImages,
	cols: Int,
	rows: Int,
	bounds: ContentBounds,
): List<TerminalGraphicsPlacement> {
	if (value !is JsonArray) fail(ContentFailureCode.BAD_FRAME)
	val placements = ArrayList<TerminalGraphicsPlacement>(value.size)
	val seen = HashSet<String>()
	for (entry in value) {
		if (entry !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
		readExactKeys(entry, PLACEMENT_KEYS, PLACEMENT_KEYS, ContentFailureCode.BAD_FRAME)
		val id = readOpaqueIdValue(entry.string("id"), bounds.maxIdentifierBytes)
		if (!seen.add(id)) fail(ContentFailureCode.BAD_FRAME)
		val imageId = readOpaqueIdValue(entry.string("imageId"), bounds.maxIdentifierBytes)
		val image = images.byId[imageId] ?: fail(ContentFailureCode.BAD_FRAME)
		val footprint = readFootprint(entry, cols, rows, bounds)
		placements.add(
			TerminalGraphicsPlacement(
				id = id,
				imageId = imageId,
				column = footprint.column,
				row = footprint.row,
				columns = footprint.columns,
				rows = footprint.rows,
				crop = readCrop(entry.element("crop"), image),
				clip = footprint.clip,
			),
		)
	}
	return placements
}

private val FALLBACK_KEYS =
	setOf("id", "mimeType", "widthPx", "heightPx", "column", "row", "columns", "rows", "clip")
private val FALLBACK_REQUIRED_KEYS =
	setOf("id", "mimeType", "column", "row", "columns", "rows", "clip")

private fun readFallbacks(
	value: JsonElement,
	placements: List<TerminalGraphicsPlacement>,
	cols: Int,
	rows: Int,
	bounds: ContentBounds,
): List<TerminalGraphicsFallback> {
	if (value !is JsonArray) fail(ContentFailureCode.BAD_FRAME)
	val byId = HashMap<String, TerminalGraphicsPlacement>(placements.size)
	for (placement in placements) {
		byId.put(placement.id, placement)
	}
	val seen = HashSet<String>()
	val fallbacks = ArrayList<TerminalGraphicsFallback>(value.size)
	for (entry in value) {
		if (entry !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
		readExactKeys(entry, FALLBACK_KEYS, FALLBACK_REQUIRED_KEYS, ContentFailureCode.BAD_FRAME)
		val id = readOpaqueIdValue(entry.string("id"), bounds.maxIdentifierBytes)
		if (!seen.add(id)) fail(ContentFailureCode.BAD_FRAME)
		if (entry.string("mimeType") != TERMINAL_GRAPHICS_PNG_MIME_TYPE) fail(ContentFailureCode.BAD_FRAME)
		val footprint = readFootprint(entry, cols, rows, bounds)
		val widthPx = if (entry.containsKey("widthPx")) entry.integer("widthPx", 1L, MAX_GRAPHICS_DIMENSION) else null
		val heightPx = if (entry.containsKey("heightPx")) entry.integer("heightPx", 1L, MAX_GRAPHICS_DIMENSION) else null
		val placement = byId[id]
		if (placement != null) {
			// The native frame emits the payload-free alternative for the same
			// stored placement, so its footprint and clip must agree exactly.
			if (placement.column != footprint.column ||
				placement.row != footprint.row ||
				placement.columns != footprint.columns ||
				placement.rows != footprint.rows ||
				placement.clip.leftColumns != footprint.clip.leftColumns ||
				placement.clip.topRows != footprint.clip.topRows ||
				placement.clip.rightColumns != footprint.clip.rightColumns ||
				placement.clip.bottomRows != footprint.clip.bottomRows
			) {
				fail(ContentFailureCode.BAD_FRAME)
			}
		}
		fallbacks.add(
			TerminalGraphicsFallback(
				id = id,
				mimeType = TERMINAL_GRAPHICS_PNG_MIME_TYPE,
				widthPx = widthPx,
				heightPx = heightPx,
				column = footprint.column,
				row = footprint.row,
				columns = footprint.columns,
				rows = footprint.rows,
				clip = footprint.clip,
			),
		)
	}
	return fallbacks
}

private fun readGraphics(
	value: JsonElement,
	cols: Int,
	rows: Int,
	bounds: ContentBounds,
): TerminalGraphicsFrame {
	if (value !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(value, GRAPHICS_KEYS, GRAPHICS_KEYS, ContentFailureCode.BAD_FRAME)
	val images = readImages(value.element("images"), bounds)
	val placements = readPlacements(value.element("placements"), images, cols, rows, bounds)
	val fallbacks = readFallbacks(value.element("fallbacks"), placements, cols, rows, bounds)
	return TerminalGraphicsFrame(images = images.list, placements = placements, fallbacks = fallbacks)
}

/**
 * Validate one native viewport payload. Visible text is preserved exactly
 * (Unicode, combining marks, and wide cells included); only controls outside the
 * native serializer's allowlisted SGR are refused.
 */
internal fun normalizeTerminalFrame(record: JsonElement, bounds: ContentBounds): TerminalFrame {
	if (record !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(
		record,
		setOf("cols", "rows", "lines", "cursor", "styles", "graphics"),
		setOf("cols", "rows", "lines", "cursor"),
		ContentFailureCode.BAD_FRAME,
	)
	val cols = record.integer("cols", 1L, bounds.maxCols.toLong()).toInt()
	val rows = record.integer("rows", 1L, bounds.maxRows.toLong()).toInt()
	val rawLines = record.element("lines")
	if (rawLines !is JsonArray || rawLines.size != rows) fail(ContentFailureCode.BAD_FRAME)
	val lines = ArrayList<String>(rawLines.size)
	for (rawLine in rawLines) {
		if (rawLine !is JsonPrimitive || !rawLine.isString || !isNativeFrameLine(rawLine.content)) {
			fail(ContentFailureCode.BAD_FRAME)
		}
		lines.add(rawLine.content)
	}
	val cursor = readCursor(record.element("cursor"), cols, rows)
	val styles = if (record.containsKey("styles")) readStyles(record.element("styles"), cols, rows) else null
	val graphics = if (record.containsKey("graphics")) {
		readGraphics(record.element("graphics"), cols, rows, bounds)
	} else {
		null
	}
	return TerminalFrame(cols = cols, rows = rows, lines = lines, cursor = cursor, styles = styles, graphics = graphics)
}

/* ------------------------------------------------------------------------- *
 * One complete frame
 * ------------------------------------------------------------------------- */

private val FRAME_KEYS: Map<String, Set<String>> = mapOf(
	"hello" to setOf("type", "service", "major", "minor", "capabilities"),
	"hello_ack" to setOf("type", "service", "major", "minor", "capabilities"),
	"subscribe" to setOf("type", "subscriptionId", "hostRunId", "sessionId", "cols", "rows"),
	"subscribed" to setOf("type", "subscriptionId", "sessionId", "hostRunId"),
	"resize" to setOf("type", "subscriptionId", "cols", "rows"),
	"unsubscribe" to setOf("type", "subscriptionId"),
	"unsubscribed" to setOf("type", "subscriptionId"),
	"end" to setOf("type", "subscriptionId", "code"),
	"error" to setOf("type", "code", "subscriptionId"),
	"content_begin" to setOf(
		"type",
		"subscriptionId",
		"transferId",
		"hostRunId",
		"sessionId",
		"nativeSession",
		"sequence",
		"geometry",
		"inputModes",
		"byteLength",
		"chunkCount",
		"inputSource",
	),
	"content_chunk" to setOf("type", "subscriptionId", "transferId", "index", "data"),
	"content_end" to setOf("type", "subscriptionId", "transferId", "sequence"),
	"input" to setOf("type", "subscriptionId", "inputId", "ordinal", "source", "inputModes", "kind", "data"),
	"input_begin" to setOf(
		"type",
		"subscriptionId",
		"inputId",
		"ordinal",
		"source",
		"inputModes",
		"kind",
		"byteLength",
		"chunkCount",
	),
	"input_chunk" to setOf("type", "subscriptionId", "inputId", "index", "data"),
	"input_end" to setOf("type", "subscriptionId", "inputId", "ordinal"),
	"copy" to setOf("type", "subscriptionId", "copyId", "sequence", "source", "dispatchId", "event"),
	"copy_begin" to setOf(
		"type",
		"subscriptionId",
		"copyId",
		"sequence",
		"source",
		"dispatchId",
		"byteLength",
		"chunkCount",
	),
	"copy_chunk" to setOf("type", "subscriptionId", "copyId", "index", "data"),
	"copy_end" to setOf("type", "subscriptionId", "copyId", "sequence"),
)

private val REQUIRED_KEYS: Map<String, Set<String>> = mapOf(
	"hello" to setOf("service", "major", "minor", "capabilities"),
	"hello_ack" to setOf("service", "major", "minor", "capabilities"),
	"subscribe" to setOf("subscriptionId", "hostRunId", "sessionId", "cols", "rows"),
	"subscribed" to setOf("subscriptionId", "sessionId", "hostRunId"),
	"resize" to setOf("subscriptionId", "cols", "rows"),
	"unsubscribe" to setOf("subscriptionId"),
	"unsubscribed" to setOf("subscriptionId"),
	"end" to setOf("subscriptionId", "code"),
	"error" to setOf("code"),
	"content_begin" to setOf(
		"subscriptionId",
		"transferId",
		"hostRunId",
		"sessionId",
		"nativeSession",
		"sequence",
		"geometry",
		"inputModes",
		"byteLength",
		"chunkCount",
	),
	"content_chunk" to setOf("subscriptionId", "transferId", "index", "data"),
	"content_end" to setOf("subscriptionId", "transferId", "sequence"),
	"input" to setOf("subscriptionId", "inputId", "ordinal", "source", "inputModes", "kind", "data"),
	"input_begin" to setOf(
		"subscriptionId",
		"inputId",
		"ordinal",
		"source",
		"inputModes",
		"kind",
		"byteLength",
		"chunkCount",
	),
	"input_chunk" to setOf("subscriptionId", "inputId", "index", "data"),
	"input_end" to setOf("subscriptionId", "inputId", "ordinal"),
	"copy" to setOf("subscriptionId", "copyId", "sequence", "source", "dispatchId", "event"),
	"copy_begin" to setOf("subscriptionId", "copyId", "sequence", "source", "dispatchId", "byteLength", "chunkCount"),
	"copy_chunk" to setOf("subscriptionId", "copyId", "index", "data"),
	"copy_end" to setOf("subscriptionId", "copyId", "sequence"),
)

/**
 * Build one validated frame from one parsed JSON object. Unknown keys (including
 * any private owner field) are refused, so nothing outside this schema can ride
 * along on a content frame, and inherited object names are never frame types.
 */
internal fun buildFrame(record: JsonObject, bounds: ContentBounds): ContentFrame {
	val type = record.string("type")
	val allowed = FRAME_KEYS[type] ?: fail(ContentFailureCode.BAD_FRAME)
	val required = REQUIRED_KEYS[type] ?: fail(ContentFailureCode.BAD_FRAME)
	readExactKeys(record, allowed, required, ContentFailureCode.BAD_FRAME)
	return when (type) {
		"hello" -> HelloFrame(
			service = readServiceValue(record.string("service")),
			major = record.integer("major", 0L, MAX_U32),
			minor = record.integer("minor", 0L, MAX_U32),
			capabilities = readCapabilitiesValue(record.element("capabilities"), bounds),
		)

		"hello_ack" -> HelloAckFrame(
			service = readServiceValue(record.string("service")),
			major = record.integer("major", 0L, MAX_U32),
			minor = record.integer("minor", 0L, MAX_U32),
			capabilities = readCapabilitiesValue(record.element("capabilities"), bounds),
		)

		"subscribe" -> SubscribeFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			hostRunId = readIdentifierValue(record.string("hostRunId"), bounds.maxIdentifierBytes),
			sessionId = readIdentifierValue(record.string("sessionId"), bounds.maxIdentifierBytes),
			cols = record.integer("cols", 1L, bounds.maxCols.toLong()).toInt(),
			rows = record.integer("rows", 1L, bounds.maxRows.toLong()).toInt(),
		)

		"subscribed" -> SubscribedFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			sessionId = readIdentifierValue(record.string("sessionId"), bounds.maxIdentifierBytes),
			hostRunId = readIdentifierValue(record.string("hostRunId"), bounds.maxIdentifierBytes),
		)

		"resize" -> ResizeFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			cols = record.integer("cols", 1L, bounds.maxCols.toLong()).toInt(),
			rows = record.integer("rows", 1L, bounds.maxRows.toLong()).toInt(),
		)

		"unsubscribe" -> UnsubscribeFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
		)

		"unsubscribed" -> UnsubscribedFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
		)

		"end" -> EndFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			code = ContentEndCode.fromWireValue(record.string("code")) ?: fail(ContentFailureCode.BAD_FRAME),
		)

		"error" -> ErrorFrame(
			code = ContentErrorCode.fromWireValue(record.string("code")) ?: fail(ContentFailureCode.BAD_FRAME),
			subscriptionId = if (record.containsKey("subscriptionId")) {
				readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes)
			} else {
				null
			},
		)

		"content_begin" -> {
			val byteLength = record.integer("byteLength", 1L, bounds.maxTransferBytes.toLong()).toInt()
			val chunkCount = record.integer("chunkCount", 1L, byteLength.toLong()).toInt()
			if (chunkCount < ceilDiv(byteLength, bounds.maxChunkPayloadBytes)) fail(ContentFailureCode.BAD_FRAME)
			val hostRunId = readIdentifierValue(record.string("hostRunId"), bounds.maxIdentifierBytes)
			val sessionId = readIdentifierValue(record.string("sessionId"), bounds.maxIdentifierBytes)
			val nativeSession = readNativeSession(record.element("nativeSession"), bounds)
			val geometry = readGeometry(record.element("geometry"), bounds)
			val inputSource = readOptionalInputSource(record, bounds)
			if (inputSource is OptionalNativeIoSource.Stated) {
				// Mixed A-frame / B-source metadata is refused, not merged.
				checkInputSourceCoherence(
					inputSource.source,
					hostRunId = hostRunId,
					sessionId = sessionId,
					nativeSession = nativeSession,
					geometry = geometry,
				)
			}
			ContentBeginFrame(
				subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
				transferId = readIdentifierValue(record.string("transferId"), bounds.maxIdentifierBytes),
				hostRunId = hostRunId,
				sessionId = sessionId,
				nativeSession = nativeSession,
				sequence = record.integer("sequence", 1L, MAX_SAFE_INTEGER),
				geometry = geometry,
				inputModes = readInputModes(record.element("inputModes")),
				byteLength = byteLength,
				chunkCount = chunkCount,
				// Absent unless the wire actually carried it, so a legacy begin keeps
				// its exact key set and an old view is never handed a new field.
				inputSource = inputSource,
			)
		}

		"content_chunk" -> ContentChunkFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			transferId = readIdentifierValue(record.string("transferId"), bounds.maxIdentifierBytes),
			index = record.integer("index", 0L, MAX_SAFE_INTEGER),
			data = readChunkPayload(record.element("data"), bounds),
		)

		"content_end" -> ContentEndFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			transferId = readIdentifierValue(record.string("transferId"), bounds.maxIdentifierBytes),
			sequence = record.integer("sequence", 1L, MAX_SAFE_INTEGER),
		)

		"input" -> {
			val kind = NativeIoInputKind.fromWireValue(record.string("kind")) ?: fail(ContentFailureCode.BAD_FRAME)
			InputFrame(
				subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
				inputId = readIdentifierValue(record.string("inputId"), bounds.maxIdentifierBytes),
				ordinal = record.integer("ordinal", 1L, MAX_SAFE_INTEGER),
				source = readNativeIoInputSource(record.element("source"), bounds),
				inputModes = readInputModes(record.element("inputModes")),
				kind = kind,
				data = readNativeInputData(record.element("data"), kind, bounds),
			)
		}

		"input_begin" -> {
			val byteLength = readNativePasteByteLength(record.element("byteLength"), bounds)
			val chunkCount = record.integer("chunkCount", 1L, byteLength.toLong()).toInt()
			if (chunkCount < ceilDiv(byteLength, bounds.maxChunkPayloadBytes)) fail(ContentFailureCode.BAD_FRAME)
			if (record.string("kind") != NativeIoInputKind.PASTE.wireValue) fail(ContentFailureCode.BAD_FRAME)
			InputBeginFrame(
				subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
				inputId = readIdentifierValue(record.string("inputId"), bounds.maxIdentifierBytes),
				ordinal = record.integer("ordinal", 1L, MAX_SAFE_INTEGER),
				source = readNativeIoInputSource(record.element("source"), bounds),
				inputModes = readInputModes(record.element("inputModes")),
				kind = NativeIoInputKind.PASTE,
				byteLength = byteLength,
				chunkCount = chunkCount,
			)
		}

		"input_chunk" -> InputChunkFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			inputId = readIdentifierValue(record.string("inputId"), bounds.maxIdentifierBytes),
			index = record.integer("index", 0L, MAX_SAFE_INTEGER),
			data = readChunkPayload(record.element("data"), bounds),
		)

		"input_end" -> InputEndFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			inputId = readIdentifierValue(record.string("inputId"), bounds.maxIdentifierBytes),
			ordinal = record.integer("ordinal", 1L, MAX_SAFE_INTEGER),
		)

		"copy" -> {
			val source = readNativeIoSource(record.element("source"), bounds)
			val event = readNativeCopyEvent(record.element("event"), bounds)
			// The event tuple and the source tuple name the same conversation.
			checkCopyTupleCoherence(source, event)
			CopyFrame(
				subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
				copyId = readIdentifierValue(record.string("copyId"), bounds.maxIdentifierBytes),
				sequence = record.integer("sequence", 1L, MAX_SAFE_INTEGER),
				source = source,
				dispatchId = record.integer("dispatchId", 1L, MAX_SAFE_INTEGER),
				event = event,
			)
		}

		"copy_begin" -> {
			val byteLength =
				record.integer("byteLength", 1L, ContentProtocol.NATIVE_COPY_MAX_ENCODED_CHARS.toLong()).toInt()
			val chunkCount = record.integer("chunkCount", 1L, byteLength.toLong()).toInt()
			if (chunkCount < ceilDiv(byteLength, bounds.maxChunkPayloadBytes)) fail(ContentFailureCode.BAD_FRAME)
			CopyBeginFrame(
				subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
				copyId = readIdentifierValue(record.string("copyId"), bounds.maxIdentifierBytes),
				sequence = record.integer("sequence", 1L, MAX_SAFE_INTEGER),
				source = readNativeIoSource(record.element("source"), bounds),
				dispatchId = record.integer("dispatchId", 1L, MAX_SAFE_INTEGER),
				byteLength = byteLength,
				chunkCount = chunkCount,
			)
		}

		"copy_chunk" -> CopyChunkFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			copyId = readIdentifierValue(record.string("copyId"), bounds.maxIdentifierBytes),
			index = record.integer("index", 0L, MAX_SAFE_INTEGER),
			data = readChunkPayload(record.element("data"), bounds),
		)

		"copy_end" -> CopyEndFrame(
			subscriptionId = readIdentifierValue(record.string("subscriptionId"), bounds.maxIdentifierBytes),
			copyId = readIdentifierValue(record.string("copyId"), bounds.maxIdentifierBytes),
			sequence = record.integer("sequence", 1L, MAX_SAFE_INTEGER),
		)

		else -> fail(ContentFailureCode.BAD_FRAME)
	}
}

private fun readOptionalInputSource(record: JsonObject, bounds: ContentBounds): OptionalNativeIoSource {
	if (!record.containsKey("inputSource")) return OptionalNativeIoSource.Absent
	val raw = record["inputSource"]
	if (raw == null || raw is JsonNull) return OptionalNativeIoSource.NoSource
	return OptionalNativeIoSource.Stated(readNativeIoInputSource(raw, bounds))
}

/** The smallest number of [chunkBytes]-sized pieces that covers [total]. */
internal fun ceilDiv(total: Int, chunkBytes: Int): Int {
	if (total <= 0 || chunkBytes <= 0) return 0
	return (total + chunkBytes - 1) / chunkBytes
}
