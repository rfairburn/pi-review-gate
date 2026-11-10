package io.github.rfairburn.pireviewgate.core.protocol.content

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Contract coverage for the optional native input and text-copy frames: every
 * inline and paged variant round-trips, the startup and conversation source
 * domains stay distinct, a frame whose source and snapshot describe different
 * native tuples is refused rather than merged, and no payload is clipped or
 * repaired.
 */
class NativeIoCodecTest {

	private val bounds = ContentBounds.DEFAULT

	private fun b64(text: String): String = Base64Wire.encodeCanonical(text.toByteArray())

	private fun sourceJson(
		hostRunId: String = "\"run-1\"",
		sessionId: String = "\"instance-1\"",
		nativeSession: String? = """{"sessionId":"native-session-1","epoch":3}""",
		geometry: String = """{"cols":80,"rows":24,"revision":7}""",
		viewerRevision: String = "2",
		sourceToken: String = "\"host-source-token-1\"",
		extra: String = "",
	): String {
		val tuple = if (nativeSession == null) "" else "\"nativeSession\":$nativeSession,"
		return """{"hostRunId":$hostRunId,"sessionId":$sessionId,$tuple""" +
			""""geometry":$geometry,"viewerRevision":$viewerRevision,"sourceToken":$sourceToken$extra}"""
	}

	private fun startupSourceJson(
		hostRunId: String = "\"run-1\"",
		sessionId: String = "\"instance-1\"",
		geometry: String = """{"cols":80,"rows":24,"revision":7}""",
		viewerRevision: String = "2",
		sourceToken: String = "\"host-source-token-1\"",
		phase: String = "\"startup\"",
		extra: String = "",
	): String = """{"hostRunId":$hostRunId,"sessionId":$sessionId,"phase":$phase,""" +
		""""geometry":$geometry,"viewerRevision":$viewerRevision,"sourceToken":$sourceToken$extra}"""

	private fun inputModesJson(): String =
		"""{"kittyFlags":7,"applicationCursorKeys":true,"applicationKeypad":false,"bracketedPaste":true,""" +
			""""mouseTracking":"any","modifyOtherKeys":2,"mouseEncoding":"sgr-pixels"}"""

	private fun inputJson(source: String, kind: String = "keyboard", data: String = b64("\u001b[A"), extra: String = ""): String =
		"""{"type":"input","subscriptionId":"sub-1","inputId":"input-1","ordinal":1,"source":$source,""" +
			""""inputModes":${inputModesJson()},"kind":"$kind","data":"$data"$extra}"""

	private fun copyJson(source: String, event: String, extra: String = ""): String =
		"""{"type":"copy","subscriptionId":"sub-1","copyId":"copy-1","sequence":1,"source":$source,""" +
			""""dispatchId":1,"event":$event$extra}"""

	private fun copyEventJson(encoded: String = b64("copied text"), sessionId: String = "\"native-session-1\"", sessionEpoch: String = "3"): String =
		"""{"kind":"copy","encoded":"$encoded","sessionId":$sessionId,"sessionEpoch":$sessionEpoch}"""

	private fun unavailableEventJson(reason: String = "\"unverified-native-origin\""): String =
		"""{"kind":"unavailable","reason":$reason,"sessionId":"native-session-1","sessionEpoch":3}"""

	private fun inputBeginJson(
		source: String = sourceJson(),
		byteLength: String = "40000",
		chunkCount: String = "2",
		kind: String = "paste",
	): String =
		"""{"type":"input_begin","subscriptionId":"sub-1","inputId":"input-1","ordinal":1,"source":$source,""" +
			""""inputModes":${inputModesJson()},"kind":"$kind","byteLength":$byteLength,"chunkCount":$chunkCount}"""

	private fun copyBeginJson(
		source: String = sourceJson(),
		byteLength: String = "100000",
		chunkCount: String = "4",
	): String =
		"""{"type":"copy_begin","subscriptionId":"sub-1","copyId":"copy-1","sequence":1,"source":$source,""" +
			""""dispatchId":1,"byteLength":$byteLength,"chunkCount":$chunkCount}"""

	private fun beginWithSource(nativeSession: String, source: String): String =
		"""{"type":"content_begin","subscriptionId":"sub-1","transferId":"t-1","hostRunId":"run-1",""" +
			""""sessionId":"instance-1","nativeSession":$nativeSession,"sequence":1,""" +
			""""geometry":{"cols":12,"rows":3,"revision":0},"inputModes":${inputModesJson()},""" +
			""""byteLength":16,"chunkCount":1,"inputSource":$source}"""

	@Test
	fun everyNativeIoVariantRoundtripsThroughOneMessage() {
		val startup = startupSource()
		val frames = listOf<ContentFrame>(
			InputFrame("sub-1", "input-1", 1L, nativeSource(), INPUT_MODES, NativeIoInputKind.KEYBOARD, "\u001b[A".toByteArray()),
			InputFrame("sub-1", "input-2", 2L, nativeSource(), INPUT_MODES, NativeIoInputKind.MOUSE, "\u001b[<0;13;4M".toByteArray()),
			InputFrame("sub-1", "input-3", 3L, nativeSource(), INPUT_MODES, NativeIoInputKind.PASTE, "ls -la\r世界".toByteArray()),
			InputFrame("sub-1", "input-4", 4L, startup, INPUT_MODES, NativeIoInputKind.KEYBOARD, "\r".toByteArray()),
			InputBeginFrame("sub-1", "input-5", 5L, nativeSource(), INPUT_MODES, NativeIoInputKind.PASTE, 40_000, 2),
			InputChunkFrame("sub-1", "input-5", 0L, ByteArray(1_024)),
			InputEndFrame("sub-1", "input-5", 5L),
			CopyFrame("sub-1", "copy-1", 1L, nativeSource(), 1L, copyEvent(b64("copied text"))),
			CopyFrame("sub-1", "copy-2", 2L, nativeSource(), 7L, unavailableEvent()),
			CopyFrame(
				"sub-1",
				"copy-3",
				3L,
				nativeSource(),
				7L,
				unavailableEvent(NativeIoCopyUnavailableReason.UNSUPPORTED_RUNTIME),
			),
			CopyBeginFrame("sub-1", "copy-4", 4L, nativeSource(), 9L, 100_000, 4),
			CopyChunkFrame("sub-1", "copy-4", 3L, "c2xpY2U=".toByteArray()),
			CopyEndFrame("sub-1", "copy-4", 4L),
		)
		for (frame in frames) {
			val bytes = ContentProtocol.encode(frame)
			assertTrue(bytes.size <= bounds.maxFrameBytes, "one message bound for ${frame.wireType}")
			assertEquals(frame, ContentProtocol.decode(bytes), "roundtrip of ${frame.wireType}")
		}
	}

	@Test
	fun aStartupSourceStaysTupleLessAndAConversationSourceAlwaysCarriesItsTuple() {
		val decoded = assertIs<InputFrame>(decodeText(inputJson(startupSourceJson())))
		assertIs<NativeIoStartupSource>(decoded.source)

		val conversation = assertIs<InputFrame>(decodeText(inputJson(sourceJson())))
		assertIs<NativeIoSource>(conversation.source)

		// A startup source is never readable as a copy source.
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(copyJson(startupSourceJson(), copyEventJson()))
		}
		// A phase of its own never turns a conversation source into a startup one.
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(inputJson(sourceJson(extra = ",\"phase\":\"startup\"")))
		}
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(inputJson(startupSourceJson(phase = "\"boot\"")))
		}
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(inputJson(startupSourceJson(extra = ",\"nativeSession\":{\"sessionId\":\"n\",\"epoch\":3}")))
		}
	}

	@Test
	fun nativeIoSourceIdentityIsExactAndNeverAnEqualDimensionsAssumption() {
		val original = nativeSource()
		assertTrue(nativeIoSourceEquals(original, nativeSource()))
		assertFalse(
			nativeIoSourceEquals(original, nativeSource(geometry = SessionGeometry(cols = 80, rows = 24, revision = 8))),
			"the same dimensions with a new geometry revision are a different source",
		)
		assertFalse(nativeIoSourceEquals(original, nativeSource(viewerRevision = 3)))
		assertFalse(
			nativeIoSourceEquals(original, nativeSource(nativeSession = NativeSessionRef("native-session-1", 4))),
		)
		assertFalse(nativeIoSourceEquals(original, nativeSource(sourceToken = "host-source-token-2")))
		assertFalse(nativeIoSourceEquals(original, startupSource()), "a startup source never equals a conversation source")
	}

	@Test
	fun aSourceShapeOutsideTheClosedSchemaIsRefusedBeforeCoherence() {
		for (source in listOf(
			sourceJson(nativeSession = null),
			sourceJson(nativeSession = """{"sessionId":"native-session-1","epoch":0}"""),
			sourceJson(nativeSession = """{"sessionId":"native-session-1","epoch":3,"extra":true}"""),
			sourceJson(nativeSession = """{"sessionId":"native-session-1"}"""),
			sourceJson(viewerRevision = "0"),
			sourceJson(geometry = """{"cols":12,"rows":3}"""),
			sourceJson(geometry = """{"cols":12,"rows":3,"revision":-1}"""),
			sourceJson(geometry = """{"cols":0,"rows":3,"revision":0}"""),
			sourceJson(sourceToken = "\"\""),
			sourceJson(sourceToken = "\"" + "x".repeat(129) + "\""),
			sourceJson(sourceToken = "\"host source token\""),
			sourceJson(sourceToken = "\"token\u007f\""),
			sourceJson(hostRunId = "\"run 1\""),
			sourceJson(extra = ",\"agentPath\":\"/tmp/agent\""),
			sourceJson(extra = ",\"inputGrant\":true"),
			sourceJson(extra = ",\"lease\":\"granted\""),
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(inputJson(source)) }
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(copyJson(source, copyEventJson())) }
		}
	}

	@Test
	fun contentBeginCarriesANativeIoSourceOnlyForItsOwnSnapshot() {
		val coherent = beginWithSource(
			"""{"sessionId":"native-session-1","epoch":3}""",
			sourceJson(geometry = """{"cols":12,"rows":3,"revision":0}"""),
		)
		val decoded = assertIs<ContentBeginFrame>(decodeText(coherent))
		val stated = assertIs<OptionalNativeIoSource.Stated>(decoded.inputSource)
		assertIs<NativeIoSource>(stated.source)
		assertEquals(NativeSessionRef("native-session-1", 3), stated.source.nativeSession)

		for (source in listOf(
			sourceJson(hostRunId = "\"run-2\"", geometry = """{"cols":12,"rows":3,"revision":0}"""),
			sourceJson(sessionId = "\"instance-2\"", geometry = """{"cols":12,"rows":3,"revision":0}"""),
			sourceJson(
				nativeSession = """{"sessionId":"native-session-2","epoch":3}""",
				geometry = """{"cols":12,"rows":3,"revision":0}""",
			),
			sourceJson(
				nativeSession = """{"sessionId":"native-session-1","epoch":4}""",
				geometry = """{"cols":12,"rows":3,"revision":0}""",
			),
			sourceJson(geometry = """{"cols":12,"rows":3,"revision":1}"""),
			sourceJson(geometry = """{"cols":13,"rows":3,"revision":0}"""),
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(beginWithSource("""{"sessionId":"native-session-1","epoch":3}""", source)) }
		}

		// A frame that reports no native session cannot be handed a live tuple.
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(beginWithSource("null", sourceJson(geometry = """{"cols":12,"rows":3,"revision":0}""")))
		}
		// A startup source describes ONLY a publish that names no native conversation.
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(beginWithSource("""{"sessionId":"native-session-1","epoch":3}""", startupSourceJson(geometry = """{"cols":12,"rows":3,"revision":0}""")))
		}
		val startupPublish = assertIs<ContentBeginFrame>(
			decodeText(beginWithSource("null", startupSourceJson(geometry = """{"cols":12,"rows":3,"revision":0}"""))),
		)
		assertIs<NativeIoStartupSource>(assertIs<OptionalNativeIoSource.Stated>(startupPublish.inputSource).source)
	}

	@Test
	fun malformedNativeInputPayloadsAreNeverRepairedLocally() {
		// A viewer SGR mouse packet in content coordinates is the only mouse form.
		for (data in listOf(
			b64("\u001b[<0;13M"),
			b64("\u001b[<0;0;4M"),
			b64("\u001b[<0;13;4X"),
			b64("\u001b[<1000;13;4M"),
			b64("\u001b[0;13;4M"),
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(inputJson(sourceJson(), kind = "mouse", data = data)) }
		}
		// Invalid UTF-8 stays invalid.
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(inputJson(sourceJson(), kind = "keyboard", data = Base64Wire.encodeCanonical(byteArrayOf(0x61.toByte(), 0xff.toByte()))))
		}
		// Non-canonical base64 is refused rather than normalized.
		for (data in listOf("YQ", "a b=", "_abc==")) {
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(inputJson(sourceJson(), data = data)) }
		}
		// An inline frame is chunk-bounded; a larger payload must page instead.
		val oversized = Base64Wire.encodeCanonical(ByteArray(bounds.maxChunkPayloadBytes + 1))
		assertRefused(ContentFailureCode.FRAME_TOO_LARGE) { decodeText(inputJson(sourceJson(), kind = "paste", data = oversized)) }
	}

	@Test
	fun pagedNativeDeclarationsStayInsideTheirOwnBounds() {
		assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(inputBeginJson(byteLength = "1048577", chunkCount = "33")) }
		assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(inputBeginJson(byteLength = "40000", chunkCount = "1")) }
		assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(inputBeginJson(kind = "keyboard")) }
		assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(copyBeginJson(byteLength = "100001", chunkCount = "4")) }
		assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(copyBeginJson(byteLength = "100000", chunkCount = "1")) }
		// The producer's own bound is accepted whole, not reduced to a message size.
		val accepted = assertIs<CopyBeginFrame>(decodeText(copyBeginJson(byteLength = "100000", chunkCount = "4")))
		assertEquals(100_000, accepted.byteLength)
		val paste = assertIs<InputBeginFrame>(decodeText(inputBeginJson(byteLength = "1048576", chunkCount = "33")))
		assertEquals(1_048_576, paste.byteLength)
	}

	@Test
	fun aCopyNamesOneAuthenticatedNativeTupleInBothItsSourceAndItsEvent() {
		val decoded = assertIs<CopyFrame>(decodeText(copyJson(sourceJson(), copyEventJson())))
		assertIs<NativeIoCopyEvent.Copy>(decoded.event)
		assertEquals(nativeSource().nativeSession.sessionId, decoded.event.sessionId)
		assertEquals(nativeSource().nativeSession.epoch, decoded.event.sessionEpoch)

		for (event in listOf(
			copyEventJson(sessionId = "\"native-session-2\""),
			copyEventJson(sessionEpoch = "4"),
			copyEventJson(encoded = "YQ"),
			copyEventJson(encoded = Base64Wire.encodeCanonical(byteArrayOf(0x41.toByte(), 0xff.toByte()))),
			copyEventJson().replace("\"sessionEpoch\":3", "\"sessionEpoch\":0"),
			"""{"kind":"copy","encoded":"Y29weQ==","sessionId":"native-session-1","sessionEpoch":3,"extra":true}""",
			"""{"kind":"unavailable","reason":"unsupported-runtime","sessionId":"native-session-1","sessionEpoch":3,"encoded":"Y29weQ=="}""",
			"""{"kind":"unavailable","reason":"because","sessionId":"native-session-1","sessionEpoch":3}""",
			"""{"kind":"copy","sessionId":"native-session-1","sessionEpoch":3}""",
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(copyJson(sourceJson(), event)) }
		}
		val unavailable = assertIs<CopyFrame>(decodeText(copyJson(sourceJson(), unavailableEventJson())))
		assertEquals(
			NativeIoCopyUnavailableReason.UNVERIFIED_NATIVE_ORIGIN,
			assertIs<NativeIoCopyEvent.Unavailable>(unavailable.event).reason,
		)
	}

	@Test
	fun aLeadingByteOrderMarkSurvivesInsteadOfBeingRewritten() {
		val withBom = "\uFEFFtyped text"
		val frame = InputFrame(
			"sub-1",
			"input-1",
			1L,
			nativeSource(),
			INPUT_MODES,
			NativeIoInputKind.PASTE,
			withBom.toByteArray(),
		)
		val decoded = assertIs<InputFrame>(ContentProtocol.decode(ContentProtocol.encode(frame)))
		assertTrue(String(decoded.data, Charsets.UTF_8).startsWith("\uFEFF"), "the peer's text is preserved byte for byte")
	}

	@Test
	fun largeOrdinalsAndSequencesStayInsideTheSafeIntegerRange() {
		val frame = InputEndFrame("sub-1", "input-1", 9_007_199_254_740_991L)
		assertEquals(frame, ContentProtocol.decode(ContentProtocol.encode(frame)))
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText("""{"type":"input_end","subscriptionId":"sub-1","inputId":"input-1","ordinal":9007199254740992}""")
		}
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText("""{"type":"input_end","subscriptionId":"sub-1","inputId":"input-1","ordinal":0}""")
		}
	}

	@Test
	fun nativeInputModesAreClosedToo() {
		for (modes in listOf(
			"""{"kittyFlags":8,"applicationCursorKeys":true,"applicationKeypad":false,"bracketedPaste":true,""" +
				""""mouseTracking":"any","modifyOtherKeys":2,"mouseEncoding":"sgr-pixels"}""",
			"""{"kittyFlags":7,"applicationCursorKeys":true,"applicationKeypad":false,"bracketedPaste":true,""" +
				""""mouseTracking":"sgr","modifyOtherKeys":2,"mouseEncoding":"sgr-pixels"}""",
			"""{"kittyFlags":7,"applicationCursorKeys":true,"applicationKeypad":false,"bracketedPaste":true,""" +
				""""mouseTracking":"any","modifyOtherKeys":3,"mouseEncoding":"sgr-pixels"}""",
			"""{"kittyFlags":7,"applicationCursorKeys":true,"applicationKeypad":false,"bracketedPaste":true,""" +
				""""mouseTracking":"any","modifyOtherKeys":2,"mouseEncoding":"default","extra":1}""",
			"""{"kittyFlags":7,"applicationCursorKeys":true,"applicationKeypad":false,"bracketedPaste":true,""" +
				""""mouseTracking":"any","modifyOtherKeys":2}""",
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) {
				decodeText(
					"""{"type":"input","subscriptionId":"sub-1","inputId":"input-1","ordinal":1,""" +
						""""source":${sourceJson()},"inputModes":$modes,"kind":"keyboard","data":"${b64("a")}"}""",
				)
			}
		}
	}
}
