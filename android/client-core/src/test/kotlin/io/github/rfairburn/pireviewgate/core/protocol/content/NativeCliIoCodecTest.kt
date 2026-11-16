package io.github.rfairburn.pireviewgate.core.protocol.content

import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Wire coverage for the hosted provider CLI input and TEXT COPY variants of the
 * native IO extension: both backends decode exactly, the source and event shapes stay
 * closed (no tuple, PID, path, command, registration, lease, or incarnation field ever
 * rides along), the two producer families never mix inside one frame, a startup source
 * is never a copy source, and the two capabilities are negotiated only beside the
 * capabilities they depend on.
 */
class NativeCliIoCodecTest {

	private val bounds = ContentBounds.DEFAULT

	private fun b64(text: String): String = Base64Wire.encodeCanonical(text.toByteArray())

	private fun cliSourceJson(
		backend: String = "\"claude\"",
		hostRunId: String = "\"run-1\"",
		sessionId: String = "\"instance-1\"",
		geometry: String = """{"cols":80,"rows":24,"revision":7}""",
		viewerRevision: String = "2",
		sourceToken: String = "\"host-source-token-1\"",
		phase: String = "\"native-cli\"",
		extra: String = "",
	): String {
		val backendField = if (backend.isEmpty()) "" else "\"backend\":$backend,"
		val phaseField = if (phase.isEmpty()) "" else "\"phase\":$phase,"
		return """{"hostRunId":$hostRunId,"sessionId":$sessionId,$phaseField$backendField""" +
			""""geometry":$geometry,"viewerRevision":$viewerRevision,"sourceToken":$sourceToken$extra}"""
	}

	private fun conversationSourceJson(): String =
		"""{"hostRunId":"run-1","sessionId":"instance-1",""" +
			""""nativeSession":{"sessionId":"native-session-1","epoch":3},""" +
			""""geometry":{"cols":80,"rows":24,"revision":7},"viewerRevision":2,"sourceToken":"host-source-token-1"}"""

	private fun startupSourceJson(): String =
		"""{"hostRunId":"run-1","sessionId":"instance-1","phase":"startup",""" +
			""""geometry":{"cols":80,"rows":24,"revision":7},"viewerRevision":2,"sourceToken":"host-source-token-1"}"""

	private fun inputModesJson(): String =
		"""{"kittyFlags":7,"applicationCursorKeys":true,"applicationKeypad":false,"bracketedPaste":true,""" +
			""""mouseTracking":"any","modifyOtherKeys":2,"mouseEncoding":"sgr-pixels"}"""

	private fun inputJson(source: String, kind: String = "keyboard", data: String = b64("a"), extra: String = ""): String =
		"""{"type":"input","subscriptionId":"sub-1","inputId":"input-1","ordinal":1,"source":$source,""" +
			""""inputModes":${inputModesJson()},"kind":"$kind","data":"$data"$extra}"""

	private fun copyJson(source: String, event: String, extra: String = ""): String =
		"""{"type":"copy","subscriptionId":"sub-1","copyId":"copy-1","sequence":1,"source":$source,""" +
			""""dispatchId":1,"event":$event$extra}"""

	private fun cliCopyEventJson(encoded: String = b64("copied text"), backend: String = "\"claude\""): String =
		"""{"kind":"copy","encoded":"$encoded","backend":$backend}"""

	private fun conversationCopyEventJson(): String =
		"""{"kind":"copy","encoded":"${b64("copied text")}","sessionId":"native-session-1","sessionEpoch":3}"""

	private fun copyBeginJson(source: String, byteLength: String, chunkCount: String): String =
		"""{"type":"copy_begin","subscriptionId":"sub-1","copyId":"copy-1","sequence":1,"source":$source,""" +
			""""dispatchId":1,"byteLength":$byteLength,"chunkCount":$chunkCount}"""

	private fun beginWithSource(nativeSession: String, source: String): String =
		"""{"type":"content_begin","subscriptionId":"sub-1","transferId":"t-1","hostRunId":"run-1",""" +
			""""sessionId":"instance-1","nativeSession":$nativeSession,"sequence":1,""" +
			""""geometry":{"cols":12,"rows":3,"revision":0},"inputModes":${inputModesJson()},""" +
			""""byteLength":16,"chunkCount":1,"inputSource":$source}"""

	@Test
	fun aNativeCliSourceRoundTripsForBothBackendsWithNoTupleOnTheWire() {
		for (backend in listOf(NativeCliBackend.CLAUDE, NativeCliBackend.CODEX)) {
			val input = InputFrame(
				"sub-1",
				"input-1",
				1L,
				nativeCliSource(backend = backend),
				INPUT_MODES,
				NativeIoInputKind.KEYBOARD,
				"ls\r".toByteArray(),
			)
			val text = encodedText(input)
			assertTrue("\"phase\":\"native-cli\"" in text, "the phase is stated for $backend")
			assertTrue("\"backend\":\"${backend.wireName}\"" in text, "the backend is stated for $backend")
			assertFalse("nativeSession" in text, "a hosted provider child has no conversation: $backend")
			val decoded = assertIs<InputFrame>(ContentProtocol.decode(ContentProtocol.encode(input)))
			assertEquals(input, decoded)
			assertEquals(backend, assertIs<NativeIoNativeCliSource>(decoded.source).backend)

			val copy = CopyFrame(
				"sub-1",
				"copy-1",
				1L,
				nativeCliSource(backend = backend),
				9L,
				cliCopyEvent(b64("copied 世界"), backend),
			)
			val copyText = encodedText(copy)
			assertFalse("sessionEpoch" in copyText, "a hosted copy carries no tuple: $backend")
			val decodedCopy = assertIs<CopyFrame>(ContentProtocol.decode(ContentProtocol.encode(copy)))
			assertEquals(copy, decodedCopy)
			assertEquals(backend, assertIs<NativeIoNativeCliCopyEvent>(decodedCopy.event).backend)

			val begin = CopyBeginFrame("sub-1", "copy-2", 2L, nativeCliSource(backend = backend), 9L, 12, 1)
			assertEquals(begin, ContentProtocol.decode(ContentProtocol.encode(begin)))
		}
	}

	@Test
	fun aNativeCliSourceShapeIsClosedToItsExactKeys() {
		val missingBackend = cliSourceJson(backend = "")
		val missingPhase = cliSourceJson(phase = "")
		for (source in listOf(
			missingBackend,
			missingPhase,
			cliSourceJson(backend = "\"Claude\""),
			cliSourceJson(backend = "\"pi\""),
			cliSourceJson(backend = "\"claude codex\""),
			cliSourceJson(backend = "\"\""),
			cliSourceJson(phase = "\"startup\""),
			cliSourceJson(phase = "\"native_cli\""),
			cliSourceJson(extra = ",\"nativeSession\":null"),
			cliSourceJson(extra = ",\"nativeSession\":{\"sessionId\":\"n\",\"epoch\":3}"),
			cliSourceJson(extra = ",\"pid\":4242"),
			cliSourceJson(extra = ",\"path\":\"/usr/local/bin/claude\""),
			cliSourceJson(extra = ",\"command\":\"claude --continue\""),
			cliSourceJson(extra = ",\"registration\":\"reg-1\""),
			cliSourceJson(extra = ",\"lease\":\"held\""),
			cliSourceJson(extra = ",\"incarnation\":7"),
			cliSourceJson(extra = ",\"displayLabel\":\"Claude\""),
			cliSourceJson(sourceToken = "\"\""),
			cliSourceJson(sourceToken = "\"" + "x".repeat(129) + "\""),
			cliSourceJson(sourceToken = "\"host source token\""),
			cliSourceJson(viewerRevision = "0"),
			cliSourceJson(geometry = """{"cols":80,"rows":24}"""),
			cliSourceJson(hostRunId = "\"run 1\""),
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME, "input with source $source") {
				decodeText(inputJson(source))
			}
			assertRefused(ContentFailureCode.BAD_FRAME, "copy with source $source") {
				decodeText(copyJson(source, cliCopyEventJson()))
			}
		}
	}

	@Test
	fun aNativeCliCopyNamesItsBackendInBothItsSourceAndItsEvent() {
		val frame = assertIs<CopyFrame>(decodeText(copyJson(cliSourceJson(), cliCopyEventJson())))
		val event = assertIs<NativeIoNativeCliCopyEvent>(frame.event)
		assertEquals(NativeCliBackend.CLAUDE, event.backend)
		assertEquals(NativeCliBackend.CLAUDE, assertIs<NativeIoNativeCliSource>(frame.source).backend)
		assertTrue(isNativeIoNativeCliCopyEvent(event))
		assertFalse(isNativeIoNativeCliCopyEvent(NativeIoCopyEvent.Copy(b64("x"), "n", 1)))

		val codex = assertIs<CopyFrame>(
			decodeText(copyJson(cliSourceJson(backend = "\"codex\""), cliCopyEventJson(backend = "\"codex\""))),
		)
		assertEquals(NativeCliBackend.CODEX, assertIs<NativeIoNativeCliCopyEvent>(codex.event).backend)

		for (eventJson in listOf(
			// A different backend in the event than in the source describes two producers.
			cliCopyEventJson(backend = "\"codex\""),
			// A conversation tuple on a hosted provider copy is a fabricated attribution.
			"""{"kind":"copy","encoded":"${b64("x")}","backend":"claude","sessionId":"native-session-1","sessionEpoch":3}""",
			// A hosted provider child has no unavailable reason to report.
			"""{"kind":"unavailable","reason":"unsupported-runtime","backend":"claude"}""",
			// The closed key set, in both directions.
			"""{"kind":"copy","backend":"claude"}""",
			"""{"kind":"copy","encoded":"${b64("x")}","backend":"claude","extra":true}""",
			// Non-canonical or non-text payloads are refused, never normalized.
			cliCopyEventJson(encoded = "YQ"),
			cliCopyEventJson(encoded = ""),
			cliCopyEventJson(encoded = Base64Wire.encodeCanonical(byteArrayOf(0x41, 0xff.toByte()))),
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME, "event $eventJson") {
				decodeText(copyJson(cliSourceJson(), eventJson))
			}
		}
	}

	@Test
	fun theTwoProducerFamiliesNeverMixInsideOneCopyFrame() {
		// A hosted provider event on a conversation source, and the reverse.
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(copyJson(conversationSourceJson(), cliCopyEventJson()))
		}
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(copyJson(cliSourceJson(), conversationCopyEventJson()))
		}
		// A startup source is never a copy source, whatever event it is paired with.
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(copyJson(startupSourceJson(), cliCopyEventJson()))
		}
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(copyJson(startupSourceJson(), conversationCopyEventJson()))
		}
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(copyBeginJson(startupSourceJson(), "12", "1"))
		}
	}

	@Test
	fun aNativeCliSourceDescribesOnlyATupleLessPublishOfItsOwnRunRowAndGeometry() {
		val coherent = beginWithSource(
			"null",
			cliSourceJson(geometry = """{"cols":12,"rows":3,"revision":0}"""),
		)
		val decoded = assertIs<ContentBeginFrame>(decodeText(coherent))
		assertEquals(null, decoded.nativeSession)
		val stated = assertIs<OptionalNativeIoSource.Stated>(decoded.inputSource)
		assertEquals(NativeCliBackend.CLAUDE, assertIs<NativeIoNativeCliSource>(stated.source).backend)

		for (source in listOf(
			cliSourceJson(geometry = """{"cols":12,"rows":3,"revision":0}""", extra = ",\"nativeSession\":null"),
			cliSourceJson(
				hostRunId = "\"run-2\"",
				geometry = """{"cols":12,"rows":3,"revision":0}""",
			),
			cliSourceJson(
				sessionId = "\"instance-2\"",
				geometry = """{"cols":12,"rows":3,"revision":0}""",
			),
			cliSourceJson(geometry = """{"cols":12,"rows":3,"revision":1}"""),
			cliSourceJson(geometry = """{"cols":13,"rows":3,"revision":0}"""),
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME, "publish source $source") {
				decodeText(beginWithSource("null", source))
			}
		}

		// A publish that DOES name a Pi conversation is never a hosted provider publish.
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(
				beginWithSource(
					"""{"sessionId":"native-session-1","epoch":3}""",
					cliSourceJson(geometry = """{"cols":12,"rows":3,"revision":0}"""),
				),
			)
		}
	}

	@Test
	fun sourceEqualitySeparatesEveryVariantAndEachBackend() {
		val cli = nativeCliSource()
		assertTrue(nativeIoSourceEquals(cli, nativeCliSource()))
		assertFalse(nativeIoSourceEquals(cli, nativeCliSource(backend = NativeCliBackend.CODEX)), "backend is identity")
		assertFalse(nativeIoSourceEquals(cli, nativeCliSource(sourceToken = "host-source-token-2")), "the token is identity")
		assertFalse(
			nativeIoSourceEquals(cli, nativeCliSource(geometry = SessionGeometry(cols = 80, rows = 24, revision = 8))),
			"a new geometry revision is a different source",
		)
		assertFalse(nativeIoSourceEquals(cli, nativeCliSource(viewerRevision = 3)))
		assertFalse(nativeIoSourceEquals(cli, nativeCliSource(hostRunId = "run-2")))
		assertFalse(nativeIoSourceEquals(cli, nativeCliSource(sessionId = "instance-2")))
		assertFalse(nativeIoSourceEquals(cli, startupSource()), "a hosted provider source is not a startup source")
		assertFalse(nativeIoSourceEquals(cli, nativeSource()), "a hosted provider source is not a Pi conversation source")
	}

	@Test
	fun aPagedHostedCopyDeclaresTheWholeProducerBoundAndNeverMore() {
		val accepted = assertIs<CopyBeginFrame>(
			decodeText(copyBeginJson(cliSourceJson(), "100000", "4")),
		)
		assertEquals(100_000, accepted.byteLength)
		assertEquals(NativeCliBackend.CLAUDE, assertIs<NativeIoNativeCliSource>(accepted.source).backend)
		assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(copyBeginJson(cliSourceJson(), "100001", "5")) }
		assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(copyBeginJson(cliSourceJson(), "100000", "1")) }
	}

	@Test
	fun theHostedProviderCapabilitiesAreImplementableButNeverOfferedByDefault() {
		assertEquals(
			listOf(
				ContentProtocol.NATIVE_IO_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_CLI_CAPABILITY,
				ContentProtocol.NATIVE_COPY_CLI_CAPABILITY,
			),
			ContentProtocol.IMPLEMENTABLE_OPTIONAL_CAPABILITIES,
		)
		assertTrue(ContentProtocol.KNOWN_OPTIONAL_CAPABILITIES.isEmpty())

		val hello = HelloFrame(
			service = ContentProtocol.SERVICE,
			major = ContentProtocol.MAJOR,
			minor = ContentProtocol.MINOR,
			capabilities = listOf(
				ContentProtocol.REQUIRED_CAPABILITY,
				ContentProtocol.NATIVE_IO_CAPABILITY,
				ContentProtocol.NATIVE_INPUT_CLI_CAPABILITY,
				ContentProtocol.NATIVE_COPY_CLI_CAPABILITY,
			),
		)
		assertEquals(
			ContentHelloDecision.Accepted(ContentProtocol.MAJOR, ContentProtocol.MINOR, emptyList()),
			ContentProtocol.negotiateHello(hello),
			"knowing an identifier never offers or accepts it",
		)
		val all = listOf(
			ContentProtocol.NATIVE_IO_CAPABILITY,
			ContentProtocol.NATIVE_INPUT_CLI_CAPABILITY,
			ContentProtocol.NATIVE_COPY_CLI_CAPABILITY,
		)
		assertEquals(
			ContentHelloDecision.Accepted(ContentProtocol.MAJOR, ContentProtocol.MINOR, all),
			ContentProtocol.negotiateHello(hello, ContentNegotiationOptions(all)),
		)
	}

	@Test
	fun aPartialHostedProviderOptInOrAcknowledgementIsRefusedWhole() {
		val required = ContentProtocol.REQUIRED_CAPABILITY
		val nativeIo = ContentProtocol.NATIVE_IO_CAPABILITY
		val cliInput = ContentProtocol.NATIVE_INPUT_CLI_CAPABILITY
		val cliCopy = ContentProtocol.NATIVE_COPY_CLI_CAPABILITY
		val hello = HelloFrame(ContentProtocol.SERVICE, ContentProtocol.MAJOR, ContentProtocol.MINOR, listOf(required))

		// Each extension depends on the capability before it; a partial opt-in fails.
		for (options in listOf(
			listOf(cliInput),
			listOf(cliCopy),
			listOf(nativeIo, cliCopy),
			listOf(ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY, cliInput),
		)) {
			assertRefused(ContentFailureCode.INVALID_BOUNDS, "opt-in $options") {
				ContentProtocol.negotiateHello(hello, ContentNegotiationOptions(options))
			}
		}

		val ack = { capabilities: List<String> ->
			HelloAckFrame(ContentProtocol.SERVICE, ContentProtocol.MAJOR, ContentProtocol.MINOR, capabilities)
		}
		assertEquals(
			ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION),
			ContentProtocol.reviewHelloAck(ack(listOf(required, cliInput)), listOf(required, cliInput)),
			"hosted input without the native IO capability it depends on cannot exist",
		)
		assertEquals(
			ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION),
			ContentProtocol.reviewHelloAck(ack(listOf(required, nativeIo, cliCopy)), listOf(required, nativeIo, cliCopy)),
			"hosted copy without hosted input describes an extension that cannot exist",
		)
		assertEquals(
			ContentAckDecision.Accepted(ContentProtocol.MINOR, listOf(required, nativeIo, cliInput, cliCopy)),
			ContentProtocol.reviewHelloAck(
				ack(listOf(required, nativeIo, cliInput, cliCopy)),
				listOf(required, nativeIo, cliInput, cliCopy),
			),
		)
	}

	@Test
	fun aHelloThatOffersOnlyHostedCopyWithoutItsDependencyNeverGetsIt() {
		val required = ContentProtocol.REQUIRED_CAPABILITY
		val cliCopy = ContentProtocol.NATIVE_COPY_CLI_CAPABILITY
		val hello = HelloFrame(
			ContentProtocol.SERVICE,
			ContentProtocol.MAJOR,
			ContentProtocol.MINOR,
			listOf(required, cliCopy),
		)
		// Enabling the dependency pair is legal, but a peer that does not offer hosted
		// input cannot be acknowledged into it.
		val decision = ContentProtocol.negotiateHello(
			hello,
			ContentNegotiationOptions(
				listOf(
					ContentProtocol.NATIVE_IO_CAPABILITY,
					ContentProtocol.NATIVE_INPUT_CLI_CAPABILITY,
					cliCopy,
				),
			),
		)
		assertEquals(
			ContentHelloDecision.Accepted(ContentProtocol.MAJOR, ContentProtocol.MINOR, emptyList()),
			decision,
		)
	}
}
