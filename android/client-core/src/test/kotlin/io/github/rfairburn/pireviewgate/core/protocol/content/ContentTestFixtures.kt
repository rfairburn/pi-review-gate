package io.github.rfairburn.pireviewgate.core.protocol.content

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.zip.Deflater
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Synthetic fixtures shared by the codec suites.
 *
 * Everything here is hand-built and in-memory: no session, socket, credential,
 * or product state is touched. Frames mirror the native serializer's own output
 * (generated SGR, structured style runs, cursor, input modes, and typed PNG
 * graphics), and PNG payloads are generated locally so the shared PNG subset is
 * exercised rather than a test-local approximation.
 */

internal val INPUT_MODES: TerminalInputModes = TerminalInputModes(
	kittyFlags = 7,
	applicationCursorKeys = true,
	applicationKeypad = false,
	bracketedPaste = true,
	mouseTracking = MouseTrackingMode.ANY,
	modifyOtherKeys = 2,
	mouseEncoding = MouseEncodingMode.SGR_PIXELS,
)

internal val ZERO_CLIP: TerminalGraphicsClip = TerminalGraphicsClip(
	leftColumns = 0,
	topRows = 0,
	rightColumns = 0,
	bottomRows = 0,
)

internal const val ESC = "\u001b"

/* ------------------------------------------------------------------------- *
 * Generated PNGs
 * ------------------------------------------------------------------------- */

private val TEST_CRC_TABLE: IntArray = IntArray(256).also { table ->
	for (index in table.indices) {
		var value = index
		for (bit in 0 until 8) {
			value = if (value and 1 != 0) 0xEDB88320.toInt() xor (value ushr 1) else value ushr 1
		}
		table[index] = value
	}
}

private fun testCrc32(input: ByteArray): Long {
	var crc = -1
	for (byte in input) {
		crc = TEST_CRC_TABLE[(crc xor (byte.toInt() and 0xff)) and 0xff] xor (crc ushr 8)
	}
	return (crc xor -1).toLong() and 0xffffffffL
}

private fun writeUInt32BE(target: ByteArray, offset: Int, value: Long) {
	target[offset] = ((value ushr 24) and 0xff).toByte()
	target[offset + 1] = ((value ushr 16) and 0xff).toByte()
	target[offset + 2] = ((value ushr 8) and 0xff).toByte()
	target[offset + 3] = (value and 0xff).toByte()
}

private fun pngChunk(type: String, data: ByteArray): ByteArray {
	val body = type.toByteArray(StandardCharsets.ISO_8859_1) + data
	val length = ByteArray(4)
	// The declared length counts data bytes only; the CRC covers type plus data.
	writeUInt32BE(length, 0, data.size.toLong())
	val crc = ByteArray(4)
	writeUInt32BE(crc, 0, testCrc32(body))
	return length + body + crc
}

private fun pngHeader(width: Int, height: Int): ByteArray {
	val header = ByteArray(13)
	writeUInt32BE(header, 0, width.toLong())
	writeUInt32BE(header, 4, height.toLong())
	header[8] = 8
	header[9] = 6
	return header
}

private fun pngFromChunks(chunks: List<Pair<String, ByteArray>>): String {
	val signature = byteArrayOf(
		0x89.toByte(),
		0x50.toByte(),
		0x4e.toByte(),
		0x47.toByte(),
		0x0d.toByte(),
		0x0a.toByte(),
		0x1a.toByte(),
		0x0a.toByte(),
	)
	var all = signature
	for (chunk in chunks) {
		all = all + pngChunk(chunk.first, chunk.second)
	}
	return Base64Wire.encodeCanonical(all)
}

private fun deflate(data: ByteArray): ByteArray {
	val deflater = Deflater()
	deflater.setInput(data)
	deflater.finish()
	val out = ByteArrayOutputStream()
	val buffer = ByteArray(8192)
	while (!deflater.finished()) {
		val count = deflater.deflate(buffer)
		if (count > 0) out.write(buffer, 0, count)
	}
	deflater.end()
	return out.toByteArray()
}

/** A minimal valid RGBA PNG in the native subset. */
internal fun pngBase64(width: Int = 4, height: Int = 4): String = pngFromChunks(
	listOf(
		Pair("IHDR", pngHeader(width, height)),
		Pair("IDAT", deflate(ByteArray(height * (width * 4 + 1)))),
		Pair("IEND", ByteArray(0)),
	),
)

/** A PNG whose first IDAT data byte no longer matches its recorded CRC. */
internal fun pngWithCorruptCrc(): String {
	val bytes = checkNotNull(Base64Wire.decodeCanonical(pngBase64()))
	bytes[41] = (bytes[41].toInt() xor 0xff).toByte()
	return Base64Wire.encodeCanonical(bytes)
}

/* ------------------------------------------------------------------------- *
 * Native viewport fixtures
 * ------------------------------------------------------------------------- */

/** One styled pane mirroring the native serializer: Unicode text, runs, and PNGs. */
internal fun sampleFrame(): TerminalFrame = TerminalFrame(
	cols = 12,
	rows = 3,
	lines = listOf(
		"${ESC}[0mhi 世界 e\u0301${ESC}[0m${ESC}[0m",
		"${ESC}[0m${ESC}[1;38;5;196mred${ESC}[0m${ESC}[38;2;16;32;48mbg${ESC}[0m${ESC}[0m",
		"${ESC}[0m${ESC}[4;53munder${ESC}[0m${ESC}[0m",
	),
	cursor = TerminalCursor(column = 3, row = 1, visible = true),
	styles = listOf(
		TerminalLineStyles(
			line = 0,
			runs = listOf(TerminalCellRun(startColumn = 0, text = "hi 世界 e\u0301")),
		),
		TerminalLineStyles(
			line = 1,
			runs = listOf(
				TerminalCellRun(
					startColumn = 0,
					text = "red",
					fg = TerminalColorSpec(TerminalColorMode.PALETTE, 196),
					bold = true,
				),
				TerminalCellRun(
					startColumn = 3,
					text = "bg",
					bg = TerminalColorSpec(TerminalColorMode.RGB, 0x102030),
				),
			),
		),
		TerminalLineStyles(
			line = 2,
			runs = listOf(
				TerminalCellRun(
					startColumn = 0,
					text = "under",
					fg = TerminalColorSpec(TerminalColorMode.DEFAULT, 0),
					underline = true,
					overline = true,
				),
			),
		),
	),
	graphics = TerminalGraphicsFrame(
		images = listOf(
			TerminalGraphicsImage(
				id = "kitty-7",
				mimeType = TERMINAL_GRAPHICS_PNG_MIME_TYPE,
				widthPx = 4,
				heightPx = 4,
				base64 = pngBase64(),
			),
		),
		placements = listOf(
			TerminalGraphicsPlacement(
				id = "placement-7",
				imageId = "kitty-7",
				column = 2,
				row = 1,
				columns = 3,
				rows = 2,
				crop = TerminalGraphicsCrop(x = 0, y = 0, width = 4, height = 4),
				clip = ZERO_CLIP,
			),
		),
		fallbacks = listOf(
			TerminalGraphicsFallback(
				id = "placement-7",
				mimeType = TERMINAL_GRAPHICS_PNG_MIME_TYPE,
				widthPx = 4,
				heightPx = 4,
				column = 2,
				row = 1,
				columns = 3,
				rows = 2,
				clip = ZERO_CLIP,
			),
		),
	),
)

/** A normal styled pane whose JSON payload is comfortably larger than 64 KiB. */
internal fun styledFrame(rows: Int, cols: Int = 70): TerminalFrame {
	val text = "世界文字テクス"
	val runsPerLine = 10
	val lines = ArrayList<String>(rows)
	val styles = ArrayList<TerminalLineStyles>(rows)
	for (row in 0 until rows) {
		val serialized = StringBuilder("${ESC}[0m")
		val runs = ArrayList<TerminalCellRun>(runsPerLine)
		for (run in 0 until runsPerLine) {
			val value = (row * runsPerLine + run) % 256
			runs.add(
				TerminalCellRun(
					startColumn = run * text.length,
					text = text,
					fg = TerminalColorSpec(TerminalColorMode.PALETTE, value),
				),
			)
			serialized.append(ESC).append("[38;5;").append(value).append("m").append(text).append(ESC).append("[0m")
		}
		serialized.append(ESC).append("[0m")
		lines.add(serialized.toString())
		styles.add(TerminalLineStyles(line = row, runs = runs))
	}
	return TerminalFrame(
		cols = cols,
		rows = rows,
		lines = lines,
		cursor = TerminalCursor(column = 0, row = 0, visible = true),
		styles = styles,
	)
}

/* ------------------------------------------------------------------------- *
 * Native IO fixtures
 * ------------------------------------------------------------------------- */

internal fun nativeSource(
	hostRunId: String = "run-1",
	sessionId: String = "instance-1",
	nativeSession: NativeSessionRef = NativeSessionRef("native-session-1", 3),
	geometry: SessionGeometry = SessionGeometry(cols = 80, rows = 24, revision = 7),
	viewerRevision: Long = 2,
	sourceToken: String = "host-source-token-1",
): NativeIoSource = NativeIoSource(
	hostRunId = hostRunId,
	sessionId = sessionId,
	nativeSession = nativeSession,
	geometry = geometry,
	viewerRevision = viewerRevision,
	sourceToken = sourceToken,
)

/** The source of the `sampleBegin()` publish: same run, row, tuple, and geometry. */
internal fun contentSource(
	hostRunId: String = "run-1",
	sessionId: String = "instance-1",
	nativeSession: NativeSessionRef = NativeSessionRef("native-session-1", 3),
	geometry: SessionGeometry = SessionGeometry(cols = 12, rows = 3, revision = 0),
	viewerRevision: Long = 2,
	sourceToken: String = "host-source-token-1",
): NativeIoSource = NativeIoSource(
	hostRunId = hostRunId,
	sessionId = sessionId,
	nativeSession = nativeSession,
	geometry = geometry,
	viewerRevision = viewerRevision,
	sourceToken = sourceToken,
)

internal fun startupSource(
	hostRunId: String = "run-1",
	sessionId: String = "instance-1",
	geometry: SessionGeometry = SessionGeometry(cols = 80, rows = 24, revision = 7),
	viewerRevision: Long = 2,
	sourceToken: String = "host-source-token-1",
): NativeIoStartupSource = NativeIoStartupSource(
	hostRunId = hostRunId,
	sessionId = sessionId,
	geometry = geometry,
	viewerRevision = viewerRevision,
	sourceToken = sourceToken,
)

/** One begin whose metadata matches [sampleFrame] and [contentSource]. */
internal fun sampleBegin(
	nativeSession: NativeSessionRef? = NativeSessionRef("native-session-1", 3),
	inputSource: OptionalNativeIoSource = OptionalNativeIoSource.Absent,
): ContentBeginFrame =
	ContentBeginFrame(
		subscriptionId = "sub-1",
		transferId = "transfer-1",
		hostRunId = "run-1",
		sessionId = "instance-1",
		nativeSession = nativeSession,
		sequence = 1,
		geometry = SessionGeometry(cols = 12, rows = 3, revision = 0),
		inputModes = INPUT_MODES,
		byteLength = 4_096,
		chunkCount = 1,
		inputSource = inputSource,
	)

internal fun copyEvent(
	encoded: String,
	sessionId: String = "native-session-1",
	sessionEpoch: Long = 3,
): NativeIoCopyEvent = NativeIoCopyEvent.Copy(encoded = encoded, sessionId = sessionId, sessionEpoch = sessionEpoch)

internal fun unavailableEvent(
	reason: NativeIoCopyUnavailableReason = NativeIoCopyUnavailableReason.UNVERIFIED_NATIVE_ORIGIN,
	sessionId: String = "native-session-1",
	sessionEpoch: Long = 3,
): NativeIoCopyEvent = NativeIoCopyEvent.Unavailable(
	reason = reason,
	sessionId = sessionId,
	sessionEpoch = sessionEpoch,
)

/* ------------------------------------------------------------------------- *
 * Assertion helpers
 * ------------------------------------------------------------------------- */

internal fun assertRefused(code: ContentFailureCode, message: String? = null, block: () -> Unit): ContentProtocolException {
	val error = assertFailsWith(ContentProtocolException::class, message ?: "expected a $code refusal") { block() }
	assertEquals(code, error.code, "refusal code for ${message ?: code.name}")
	return error
}

internal fun decodeText(json: String): ContentFrame = ContentProtocol.decode(Utf8Wire.encode(json))

/** The exact JSON text of one encoded frame. */
internal fun encodedText(frame: ContentFrame): String =
	checkNotNull(Utf8Wire.decodeStrict(ContentProtocol.encode(frame)))

/** The exact JSON text of one encoded native viewport payload. */
internal fun encodedText(frame: TerminalFrame): String =
	checkNotNull(Utf8Wire.decodeStrict(ContentProtocol.encodeTerminalPayload(frame)))
