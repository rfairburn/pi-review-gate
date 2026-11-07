package io.github.rfairburn.pireviewgate.core.protocol.content

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Contract coverage for the native viewport payload: only the serializer's own
 * generated SGR and visible text survive, structured styles and typed PNG
 * graphics keep native frame semantics, and nothing oversized or malformed is
 * silently trimmed, filtered, or repaired.
 */
class TerminalPayloadCodecTest {

	private val bounds = ContentBounds.DEFAULT

	private val png = pngBase64()

	private val zeroCursorJson = """{"column":0,"row":0,"visible":true}"""

	private val zeroClipJson = """{"leftColumns":0,"topRows":0,"rightColumns":0,"bottomRows":0}"""

	private fun linesJson(count: Int): String = buildString {
		append('[')
		for (index in 0 until count) {
			if (index > 0) append(',')
			append("\"x\"")
		}
		append(']')
	}

	private fun viewport(
		cols: Int = 1,
		rows: Int = 1,
		lines: String? = null,
		cursor: String = zeroCursorJson,
		styles: String? = null,
		graphics: String? = null,
		extra: String = "",
	): String = buildString {
		append('{')
		append("\"cols\":$cols,\"rows\":$rows,\"lines\":${lines ?: linesJson(rows)},\"cursor\":$cursor")
		if (styles != null) append(",\"styles\":$styles")
		if (graphics != null) append(",\"graphics\":$graphics")
		append(extra)
		append('}')
	}

	private fun lineJson(line: String): String = buildString { appendWireString(line, this) }

	private fun payloadOf(json: String): TerminalFrame =
		ContentProtocol.decodeTerminalPayload(Utf8Wire.encode(json))

	private fun frameWithLine(line: String): TerminalFrame = TerminalFrame(
		cols = 1,
		rows = 1,
		lines = listOf(line),
		cursor = TerminalCursor(column = 0, row = 0, visible = true),
	)

	private fun graphicsJson(images: String, placements: String, fallbacks: String): String =
		"""{"images":$images,"placements":$placements,"fallbacks":$fallbacks}"""

	private fun validImages(): String =
		"""[{"id":"kitty-7","mimeType":"image/png","widthPx":4,"heightPx":4,"base64":"$png"}]"""

	private fun validPlacement(
		column: Int = 2,
		row: Int = 1,
		columns: Int = 3,
		rows: Int = 2,
		clip: String = zeroClipJson,
	): String =
		"""[{"id":"placement-7","imageId":"kitty-7","column":$column,"row":$row,"columns":$columns,"rows":$rows,""" +
			""""crop":{"x":0,"y":0,"width":4,"height":4},"clip":$clip}]"""

	private fun validFallback(
		column: Int = 2,
		row: Int = 1,
		columns: Int = 3,
		rows: Int = 2,
		clip: String = zeroClipJson,
	): String =
		"""[{"id":"placement-7","mimeType":"image/png","widthPx":4,"heightPx":4,"column":$column,"row":$row,""" +
			""""columns":$columns,"rows":$rows,"clip":$clip}]"""

	/** The same JSON array with its single element repeated. */
	private fun duplicated(jsonArray: String): String = jsonArray.dropLast(1) + "," + jsonArray.removePrefix("[")

	private fun graphicsOf(
		images: String = validImages(),
		placements: String = validPlacement(),
		fallbacks: String = validFallback(),
	): String = graphicsJson(images, placements, fallbacks)

	private fun decodeGraphics(graphics: String): TerminalFrame =
		payloadOf(viewport(cols = 12, rows = 3, graphics = graphics))

	@Test
	fun aCompleteStyledUnicodeNativeViewportWithTypedGraphicsRoundtrips() {
		val frame = sampleFrame()
		val payload = ContentProtocol.encodeTerminalPayload(frame)
		assertTrue(payload.size <= bounds.maxTransferBytes, "the payload fits one transfer")
		val decoded = ContentProtocol.decodeTerminalPayload(payload)
		assertEquals(frame, decoded)
		assertEquals("hi 世界 e\u0301", decoded.styles?.get(0)?.runs?.get(0)?.text, "Unicode text is preserved exactly")
		assertEquals(png, decoded.graphics?.images?.get(0)?.base64, "the PNG payload is never rewritten")
		assertEquals(4, decoded.graphics?.images?.get(0)?.widthPx)
		assertEquals(1, decoded.graphics?.placements?.size)
		assertEquals(1, decoded.graphics?.fallbacks?.size)
	}

	@Test
	fun onlyAllowlistedGeneratedSgrAndVisibleTextReachAPublishedFrame() {
		val accepted = listOf(
			"\u001b[0mplain\u001b[0m",
			"\u001b[0m\u001b[1;2;3;4;5;7;8;9;53;38;5;196;48;2;1;2;3mstyled\u001b[0m\u001b[0m",
			"\u001b[0m世界 e\u0301 क्\u0937\u001b[0m",
			"\u001b[0m\u001b[1mfaint-bold\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[31mfg-simple\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[91mfg-bright\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[41mbg-simple\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[101mbg-bright\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[38;5;16mfg-indexed\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[1;48;5;255mbg-indexed\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[3mitalic-only\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[53moverline-only\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[4;53munderline-overline\u001b[0m\u001b[0m",
			"\u001b[0m\u001b[4;53;38;2;255;0;0;48;5;0mrgb-and-indexed\u001b[0m\u001b[0m",
		)
		for (line in accepted) {
			val encoded = ContentProtocol.encodeTerminalPayload(frameWithLine(line))
			assertEquals(line, ContentProtocol.decodeTerminalPayload(encoded).lines[0], "encoding ${lineJson(line)}")
			assertEquals(line, payloadOf(viewport(lines = """[${lineJson(line)}]""")).lines[0], "decoding ${lineJson(line)}")
		}
	}

	@Test
	fun controlAndNonNativeEscapePayloadsAreRefusedBothWays() {
		val rejected = listOf(
			"\u001b]0;window title\u0007",
			"\u001b]52;c;Y2xpcGJvYXJk\u0007",
			"\u001b[2J",
			"\u001b[1;1H",
			"bell\u0007",
			"c1\u009bcontrol",
			"del\u007f",
			"\u001b_Ga=T;payload\u001b\\",
			"\u001bP1\$r0m\u001b\\",
			// Not a form the native serializer can emit: no empty list, no unsupported
			// attributes, no reordered, incomplete, or out-of-range color groups.
			"\u001b[0m\u001b[memit-nothing\u001b[0m",
			"\u001b[0m\u001b[51moverlined-superscript\u001b[0m",
			"\u001b[0m\u001b[21mdouble-underline\u001b[0m",
			"\u001b[0m\u001b[2;1mreordered\u001b[0m",
			"\u001b[0m\u001b[9;8mreordered-attributes\u001b[0m",
			"\u001b[0m\u001b[0;1mreset-in-list\u001b[0m",
			"\u001b[0m\u001b[01mleading-zero\u001b[0m",
			"\u001b[0m\u001b[38;5;999mout-of-range-index\u001b[0m",
			"\u001b[0m\u001b[38;2;1;2mincomplete-rgb\u001b[0m",
			"\u001b[0m\u001b[38;9;1munknown-color-mode\u001b[0m",
			"\u001b[0m\u001b[1;;mempty-param\u001b[0m",
			"\u001b[0m\u001b[;1mempty-first-param\u001b[0m",
		)
		for (line in rejected) {
			assertRefused(ContentFailureCode.INVALID_FRAME, "encoding ${lineJson(line)}") {
				ContentProtocol.encodeTerminalPayload(frameWithLine(line))
			}
			assertRefused(ContentFailureCode.BAD_FRAME, "decoding ${lineJson(line)}") {
				payloadOf(viewport(lines = """[${lineJson(line)}]"""))
			}
		}
	}

	@Test
	fun aPayloadLargerThanOneMessageIsStillOneCompleteViewport() {
		val frame = styledFrame(rows = 200)
		val payload = ContentProtocol.encodeTerminalPayload(frame)
		assertTrue(payload.size > bounds.maxFrameBytes, "a normal pane exceeds one message: ${payload.size} bytes")
		val decoded = ContentProtocol.decodeTerminalPayload(payload)
		assertEquals(frame, decoded, "the whole viewport survives, untrimmed")
		assertEquals(200, decoded.styles?.size)
	}

	@Test
	fun anOversizedViewportIsRefusedHonestlyInsteadOfBeingTrimmed() {
		val tight = bounds.copy(maxTransferBytes = 32 * 1024)
		val frame = styledFrame(rows = 200)
		assertRefused(ContentFailureCode.TRANSFER_TOO_LARGE) {
			ContentProtocol.encodeTerminalPayload(frame, tight)
		}
		val payload = ContentProtocol.encodeTerminalPayload(frame)
		assertRefused(ContentFailureCode.TRANSFER_TOO_LARGE) { ContentProtocol.decodeTerminalPayload(payload, tight) }
	}

	@Test
	fun viewportShapeIsClosedAndBounded() {
		for (json in listOf(
			viewport(extra = ",\"currentFile\":\"/home/operator/secret.ts\""),
			viewport(rows = 2, lines = """["only-one"]"""),
			viewport(cols = 0),
			viewport(cols = 1001),
			viewport(rows = 1001),
			viewport(cursor = """{"column":1,"row":0,"visible":true}"""),
			viewport(cursor = """{"column":0,"row":1,"visible":true}"""),
			viewport(cursor = """{"column":0,"row":0,"visible":"yes"}"""),
			viewport(cursor = """{"column":0,"row":0}"""),
			viewport(cursor = """{"column":0,"row":0,"visible":true,"ownerNote":"private"}"""),
			viewport(lines = """[1]"""),
			viewport(lines = "[\"\u0007\"]"),
			"""{"rows":1,"lines":["x"],"cursor":${zeroCursorJson}}""",
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) { payloadOf(json) }
		}
	}

	@Test
	fun structuredStylesFollowTheNativeSerializerExactly() {
		val accepted = payloadOf(viewport(styles = """[{"line":0,"runs":[{"startColumn":0,"text":"x"}]}]"""))
		assertEquals(1, accepted.styles?.size)
		assertEquals(0, accepted.styles?.get(0)?.runs?.get(0)?.startColumn)
		// An empty style list is a valid native frame with no styled rows.
		assertEquals(emptyList<TerminalLineStyles>(), payloadOf(viewport(styles = "[]")).styles)

		for (styles in listOf(
			"""[{"line":0,"runs":[]}]""",
			"""[{"line":0,"runs":[{"startColumn":1,"text":"x"}]}]""",
			"""[{"line":0,"runs":[{"startColumn":0,"text":"x","bold":false}]}]""",
			"""[{"line":0,"runs":[{"startColumn":0,"text":"x","fg":{"mode":"palette","value":300}}]}]""",
			"""[{"line":0,"runs":[{"startColumn":0,"text":"x","fg":{"mode":"hsv","value":1}}]}]""",
			"""[{"line":0,"runs":[{"startColumn":0,"text":"x","fg":{"mode":"default","value":1}}]}]""",
			"""[{"line":0,"runs":[{"startColumn":0,"text":"x"},{"startColumn":0,"text":"y"}]}]""",
			"""[{"line":0,"runs":[{"startColumn":0,"text":"x"}]},{"line":0,"runs":[{"startColumn":0,"text":"y"}]}]""",
			"""[{"line":0,"runs":[{"startColumn":0,"text":"x","ownerPath":"/tmp/agent"}]}]""",
			"""[{"line":0,"runs":[{"startColumn":0,"text":"\u0007"}]}]""",
			"""[{"line":0,"runs":[{"startColumn":0}]}]""",
			"""[{"runs":[{"startColumn":0,"text":"x"}]}]""",
			"""[{"line":1,"runs":[{"startColumn":0,"text":"x"}]}]""",
			"{}"
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) { payloadOf(viewport(styles = styles)) }
		}
	}

	@Test
	fun sharedNativePngValidationIsReusedForEveryTypedImage() {
		val decoded = decodeGraphics(graphicsOf())
		assertEquals(4, decoded.graphics?.images?.get(0)?.widthPx)
		assertEquals(4, decoded.graphics?.images?.get(0)?.heightPx)
		assertTrue((decoded.graphics?.images?.get(0)?.base64?.length ?: 0) > 0)

		for (base64 in listOf(pngWithCorruptCrc(), pngBase64(8_193, 4), "$png\n", png.dropLast(1), "")) {
			val tampered = validImages().replace("\"base64\":\"$png\"", "\"base64\":\"$base64\"")
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeGraphics(graphicsOf(images = tampered)) }
		}
		// Declared dimensions must match the validated PNG.
		val wrongDimensions = validImages().replace("\"widthPx\":4,\"heightPx\":4", "\"widthPx\":8,\"heightPx\":8")
		assertRefused(ContentFailureCode.BAD_FRAME) { decodeGraphics(graphicsOf(images = wrongDimensions)) }
		// Duplicate image ids are refused.
		assertRefused(ContentFailureCode.BAD_FRAME) { decodeGraphics(graphicsOf(images = duplicated(validImages()))) }
	}

	@Test
	fun imagePlacementFallbackCropAndClipFollowNativeFrameSemantics() {
		val graphics = graphicsOf()
		val decoded = decodeGraphics(graphics)
		assertEquals(1, decoded.graphics?.placements?.size)
		assertEquals(1, decoded.graphics?.fallbacks?.size)

		// A fallback-only placement (rejected image payload) is native output.
		val fallbackOnly = graphicsOf(
			images = "[]",
			placements = "[]",
			fallbacks = validFallback(column = 4, row = 0, columns = 2, rows = 2),
		)
		assertEquals(1, decodeGraphics(fallbackOnly).graphics?.fallbacks?.size)

		val topClipped = """{"leftColumns":0,"topRows":2,"rightColumns":0,"bottomRows":0}"""
		for (tampered in listOf(
			graphicsOf(placements = validPlacement().replace("\"imageId\":\"kitty-7\"", "\"imageId\":\"kitty-8\"")),
			graphicsOf(placements = validPlacement().replace("\"width\":4,\"height\":4}", "\"width\":5,\"height\":4}")),
			graphicsOf(placements = validPlacement().replace("\"width\":4,\"height\":4}", "\"width\":4,\"height\":0}")),
			graphicsOf(placements = validPlacement(clip = topClipped), fallbacks = validFallback(clip = topClipped)),
			graphicsOf(placements = validPlacement(column = 12), fallbacks = validFallback(column = 12)),
			graphicsOf(placements = validPlacement(row = 3), fallbacks = validFallback(row = 3)),
			graphicsOf(
				placements = validPlacement(row = -2, rows = 2, clip = topClipped),
				fallbacks = validFallback(row = -2, rows = 2, clip = topClipped),
			),
			graphicsOf(placements = duplicated(validPlacement())),
			graphicsOf(fallbacks = validFallback().replace("\"row\":1", "\"row\":0")),
			graphicsOf(fallbacks = validFallback().replace("image/png", "image/jpeg")),
			graphicsOf(images = validImages().replace("image/png", "image/jpeg")),
			graphicsOf(
				placements = """[{"id":"placement-7","imageId":"kitty-7","column":2,"row":1,"columns":3,"rows":2,""" +
					""""clip":${zeroClipJson}}]""",
			),
			"""{"images":[],"placements":"none","fallbacks":[]}""",
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeGraphics(tampered) }
		}
	}

	@Test
	fun aClippedNativePlacementAtTheViewportEdgeIsPreserved() {
		val clip = """{"leftColumns":0,"topRows":0,"rightColumns":1,"bottomRows":0}"""
		val decoded = decodeGraphics(
			graphicsOf(
				placements = validPlacement(column = 10, row = 0, columns = 3, rows = 2, clip = clip),
				fallbacks = validFallback(column = 10, row = 0, columns = 3, rows = 2, clip = clip),
			),
		)
		val placement = decoded.graphics?.placements?.get(0)
		assertEquals(10, placement?.column)
		assertEquals(1, placement?.clip?.rightColumns)
		assertEquals(0, placement?.clip?.leftColumns)
	}

	@Test
	fun aTallTopClippedPlacementAnchoredAboveAShortViewportIsPreserved() {
		val clip = """{"leftColumns":0,"topRows":20,"rightColumns":0,"bottomRows":7}"""
		val decoded = decodeGraphics(
			graphicsOf(
				placements = validPlacement(column = 0, row = -20, columns = 4, rows = 30, clip = clip),
				fallbacks = validFallback(column = 0, row = -20, columns = 4, rows = 30, clip = clip),
			),
		)
		val placement = decoded.graphics?.placements?.get(0)
		assertEquals(-20, placement?.row, "a tall placement may start far above the viewport")
		assertEquals(30, placement?.rows)
		assertEquals(20, placement?.clip?.topRows)
		assertEquals(7, placement?.clip?.bottomRows)
	}

	@Test
	fun malformedPayloadBytesRefuseWithFixedCodes() {
		assertRefused(ContentFailureCode.BAD_FRAME) { ContentProtocol.decodeTerminalPayload(ByteArray(0)) }
		assertRefused(ContentFailureCode.BAD_FRAME) {
			ContentProtocol.decodeTerminalPayload(byteArrayOf(0x7b.toByte(), 0xc3.toByte(), 0x28.toByte(), 0x7d.toByte()))
		}
		assertRefused(ContentFailureCode.BAD_FRAME) { ContentProtocol.decodeTerminalPayload(Utf8Wire.encode("not json")) }
		assertRefused(ContentFailureCode.BAD_FRAME) { ContentProtocol.decodeTerminalPayload(Utf8Wire.encode("""[1,2]""")) }
	}

	@Test
	fun theEncoderNeverEmitsADefaultAttributeOrColor() {
		val text = encodedText(sampleFrame())
		assertFalse(text.contains("\"bold\":false"), "the native serializer never emits a false attribute")
		assertFalse(text.contains("\"dim\":false"), "the native serializer never emits a false attribute")
		assertFalse(text.contains("\"overline\":false"), "the native serializer never emits a false attribute")
		val plain = encodedText(
			TerminalFrame(
				cols = 1,
				rows = 1,
				lines = listOf("x"),
				cursor = TerminalCursor(column = 0, row = 0, visible = true),
				styles = listOf(TerminalLineStyles(line = 0, runs = listOf(TerminalCellRun(startColumn = 0, text = "x")))),
			),
		)
		assertFalse(plain.contains("\"fg\""), "a default foreground stays omitted")
		assertFalse(plain.contains("\"bg\""), "a default background stays omitted")
		assertFalse(plain.contains("\"graphics\""), "an absent graphics block stays omitted")
	}
}
