package io.github.rfairburn.pireviewgate.core.protocol.content

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Contract coverage for the frame codec: every control and transfer variant
 * round-trips, closed schemas refuse anything outside them, bounds are relational
 * and fail closed, and capability negotiation never implies a grant.
 */
class ContentFrameCodecTest {

	private val defaultBounds = ContentBounds.DEFAULT

	private val helloJson =
		"""{"type":"hello","service":"pi-peer-session-content-v1","major":1,"minor":0,""" +
			""""capabilities":["native-viewport-v1"]}"""

	private fun inputModesJson(): String =
		"""{"kittyFlags":7,"applicationCursorKeys":true,"applicationKeypad":false,"bracketedPaste":true,""" +
			""""mouseTracking":"any","modifyOtherKeys":2,"mouseEncoding":"sgr-pixels"}"""

	private fun helloWithCapabilities(capabilities: String): String =
		"""{"type":"hello","service":"pi-peer-session-content-v1","major":1,"minor":0,""" +
			""""capabilities":$capabilities}"""

	private fun beginJson(fields: String): String =
		"""{"type":"content_begin","subscriptionId":"sub-1","transferId":"t-1","hostRunId":"run-1",""" +
			""""sessionId":"instance-1","nativeSession":null,"sequence":1,""" +
			""""geometry":{"cols":12,"rows":3,"revision":0},"inputModes":${inputModesJson()},""" +
			fields +
			"}"

	@Test
	fun everyControlVariantRoundtripsThroughOneMessage() {
		val frames: List<ContentFrame> = listOf(
			HelloFrame(
				service = ContentProtocol.SERVICE,
				major = ContentProtocol.MAJOR,
				minor = ContentProtocol.MINOR,
				capabilities = listOf(ContentProtocol.REQUIRED_CAPABILITY),
			),
			HelloAckFrame(
				service = ContentProtocol.SERVICE,
				major = ContentProtocol.MAJOR,
				minor = ContentProtocol.MINOR,
				capabilities = listOf(ContentProtocol.REQUIRED_CAPABILITY, ContentProtocol.NATIVE_IO_CAPABILITY),
			),
			SubscribeFrame("sub-1", "run-1", "instance-1", 80, 24),
			SubscribedFrame("sub-1", "instance-1", "run-1"),
			ResizeFrame("sub-1", 100, 30),
			UnsubscribeFrame("sub-1"),
			UnsubscribedFrame("sub-1"),
			EndFrame("sub-1", ContentEndCode.REPLACED),
			ErrorFrame(ContentErrorCode.TRANSFER_FAILED),
			ErrorFrame(ContentErrorCode.BAD_FRAME, "sub-1"),
		)
		for (frame in frames) {
			val bytes = ContentProtocol.encode(frame)
			assertTrue(bytes.size <= defaultBounds.maxFrameBytes, "one message bound for ${frame.wireType}")
			assertEquals(frame, ContentProtocol.decode(bytes), "roundtrip of ${frame.wireType}")
		}
	}

	@Test
	fun everyTransferVariantRoundtrips() {
		val begin = sampleBegin()
		val chunk = ContentChunkFrame("sub-1", "transfer-1", 0L, "the viewport payload".toByteArray())
		val end = ContentEndFrame("sub-1", "transfer-1", 1L)
		for (frame in listOf<ContentFrame>(begin, chunk, end)) {
			assertEquals(frame, ContentProtocol.decode(ContentProtocol.encode(frame)), "roundtrip of ${frame.wireType}")
		}
	}

	@Test
	fun aLegacyBeginKeepsItsExactKeySetAndAnExplicitNullStaysNull() {
		val legacy = encodedText(sampleBegin())
		assertFalse(legacy.contains("inputSource"), "a legacy publish states nothing about a source")

		val explicitNull = sampleBegin(inputSource = OptionalNativeIoSource.NoSource)
		assertTrue(encodedText(explicitNull).contains("\"inputSource\":null"), "an explicit null is written")
		val decodedNull = assertIs<ContentBeginFrame>(ContentProtocol.decode(ContentProtocol.encode(explicitNull)))
		assertIs<OptionalNativeIoSource.NoSource>(decodedNull.inputSource)

		val stated = sampleBegin(inputSource = OptionalNativeIoSource.Stated(contentSource()))
		val decodedStated = assertIs<ContentBeginFrame>(ContentProtocol.decode(ContentProtocol.encode(stated)))
		val statedField = assertIs<OptionalNativeIoSource.Stated>(decodedStated.inputSource)
		assertEquals(contentSource(), statedField.source, "the source roundtrips exactly, epoch and revisions included")
	}

	@Test
	fun aTuplelessPublishStillNamesItsRequiredNativeSessionKey() {
		val tupleless = sampleBegin(nativeSession = null)
		val text = encodedText(tupleless)
		assertTrue(
			text.contains("\"nativeSession\":null"),
			"a publish that names no native conversation still carries the required key as null",
		)
		assertEquals(tupleless, ContentProtocol.decode(ContentProtocol.encode(tupleless)))

		// A startup source is coherent with exactly this tuple-less publish.
		val startupGeometry = SessionGeometry(cols = 12, rows = 3, revision = 0)
		val startup = sampleBegin(
			nativeSession = null,
			inputSource = OptionalNativeIoSource.Stated(startupSource(geometry = startupGeometry)),
		)
		assertTrue(encodedText(startup).contains("\"nativeSession\":null"), "the key stays explicit here too")
		val decoded = assertIs<ContentBeginFrame>(ContentProtocol.decode(ContentProtocol.encode(startup)))
		val stated = assertIs<OptionalNativeIoSource.Stated>(decoded.inputSource)
		assertIs<NativeIoStartupSource>(stated.source)
		assertEquals(
			startupSource(geometry = startupGeometry),
			stated.source,
			"the startup source round-trips exactly, token and revisions included",
		)
		assertNull(decoded.nativeSession)
	}

	@Test
	fun transferDeclarationsStayBoundedAndSelfConsistent() {
		// A chunk count that cannot carry the declared bytes is not a transfer.
		for (fields in listOf(
			"\"byteLength\":4096,\"chunkCount\":0",
			"\"byteLength\":40000,\"chunkCount\":1",
			"\"byteLength\":${defaultBounds.maxTransferBytes + 1},\"chunkCount\":1",
			"\"byteLength\":0,\"chunkCount\":1",
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(beginJson(fields)) }
		}
		assertRefused(ContentFailureCode.BAD_FRAME) {
			decodeText(beginJson("\"byteLength\":16,\"chunkCount\":1").replace("\"sequence\":1", "\"sequence\":0"))
		}
		// The same declaration is accepted once it is representable.
		val accepted = assertIs<ContentBeginFrame>(decodeText(beginJson("\"byteLength\":4096,\"chunkCount\":4")))
		assertEquals(4_096, accepted.byteLength)
		assertEquals(4, accepted.chunkCount)
	}

	@Test
	fun unknownKeysWrongTypesAndForeignNamesAreRefused() {
		assertEquals(
			HelloFrame(ContentProtocol.SERVICE, 1L, 0L, listOf(ContentProtocol.REQUIRED_CAPABILITY)),
			decodeText(helloJson),
		)
		val rejected = listOf(
			// An unknown key, a private owner field, or a missing required key.
			"""{"type":"hello","service":"pi-peer-session-content-v1","major":1,"minor":0,""" +
				""""capabilities":["native-viewport-v1"],"extra":true}""",
			"""{"type":"hello","major":1,"minor":0,"capabilities":["native-viewport-v1"]}""",
			"""{"type":"hello","service":"pi-peer-session-content-v1","minor":0,""" +
				""""capabilities":["native-viewport-v1"]}""",
			"""{"type":"unsubscribe","subscriptionId":"sub-1","ownerSecret":"private"}""",
			// Inherited object names are never frame types.
			"""{"type":"toString"}""",
			"""{"type":"constructor"}""",
			"""{"type":"__proto__"}""",
			// Wrong types, unsafe integers, and identifiers outside their grammar.
			"""{"type":"hello","service":"pi-peer-session-content-v1","major":"1","minor":0,""" +
				""""capabilities":["native-viewport-v1"]}""",
			"""{"type":"hello","service":"pi-peer-session-content-v1","major":4294967296,"minor":0,""" +
				""""capabilities":["native-viewport-v1"]}""",
			"""{"type":"hello","service":"pi-peer-session-content-v1","major":1,"minor":0,""" +
				""""capabilities":["native-viewport-v1","native-viewport-v1"]}""",
			"""{"type":"hello","service":"pi-peer-session-content-v1","major":1,"minor":0,""" +
				""""capabilities":["not an identifier"]}""",
			"""{"type":"unsubscribe"}""",
			"""{"type":"unsubscribe","subscriptionId":""}""",
			"""{"type":"unsubscribe","subscriptionId":"sub 1"}""",
			"""{"type":"unsubscribe","subscriptionId":"${"x".repeat(65)}"}""",
			"""{"type":"end","subscriptionId":"sub-1","code":"because"}""",
			"""{"type":"error","code":"not_a_code"}""",
			"""{"type":"error"}""",
			"""{"type":"resize","subscriptionId":"sub-1","cols":1.5,"rows":24}""",
			"""{"type":"resize","subscriptionId":"sub-1","cols":1e2,"rows":24}""",
			"""{"type":"resize","subscriptionId":"sub-1","cols":0,"rows":24}""",
			"""{"type":"resize","subscriptionId":"sub-1","cols":1001,"rows":24}""",
			"""{"type":"resize","subscriptionId":"sub-1","cols":9007199254740992,"rows":24}""",
			"""{"type":"resize","subscriptionId":"sub-1","cols":-80,"rows":24}""",
			"""{"type":"resize","subscriptionId":"sub-1","cols":"80","rows":24}""",
			"""{"type":"resize","subscriptionId":"sub-1","cols":80,"rows":24,"revision":0}""",
			"""{"type":1}""",
			// Not a single JSON object at all.
			"""[]""",
			"""{}""",
			"""5""",
			"""null""",
			"""true""",
			"{\"type\":\"unsubscribe\",\"subscriptionId\":\"sub-1",
		)
		for (json in rejected) {
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(json) }
		}
	}

	@Test
	fun unsafeBytesAndOversizedMessagesRefuseWithFixedCodes() {
		assertRefused(ContentFailureCode.BAD_FRAME) { ContentProtocol.decode(ByteArray(0)) }
		assertRefused(ContentFailureCode.BAD_FRAME) {
			ContentProtocol.decode(byteArrayOf(0x7b.toByte(), 0xff.toByte(), 0xfe.toByte(), 0x7d.toByte()))
		}
		assertRefused(ContentFailureCode.FRAME_TOO_LARGE) {
			ContentProtocol.decode(ByteArray(defaultBounds.maxFrameBytes + 1))
		}
		val tightBounds = ContentBounds(
			maxFrameBytes = 64,
			maxTransferBytes = 4_096,
			maxChunkPayloadBytes = 16,
			maxIdentifierBytes = 64,
			maxCapabilities = 16,
			maxCapabilityIdBytes = 64,
			maxCols = 1_000,
			maxRows = 1_000,
		)
		val wide = SubscribeFrame("sub-1", "run-1", "instance-1", 80, 24)
		val encoded = ContentProtocol.encode(wide)
		assertTrue(encoded.size > tightBounds.maxFrameBytes, "the message exceeds the tight bound")
		assertRefused(ContentFailureCode.FRAME_TOO_LARGE) { ContentProtocol.decode(encoded, tightBounds) }
	}

	@Test
	fun encodingRefusesFramesThisSideBuiltWrongly() {
		assertRefused(ContentFailureCode.INVALID_FRAME) {
			ContentProtocol.encode(ContentChunkFrame("sub-1", "transfer-1", 0L, ByteArray(0)))
		}
		assertRefused(ContentFailureCode.FRAME_TOO_LARGE) {
			ContentProtocol.encode(
				ContentChunkFrame("sub-1", "transfer-1", 0L, ByteArray(defaultBounds.maxChunkPayloadBytes + 1)),
			)
		}
		// A paged paste frame that is not a paste is not a frame this codec can send.
		assertRefused(ContentFailureCode.INVALID_FRAME) {
			ContentProtocol.encode(
				InputBeginFrame(
					subscriptionId = "sub-1",
					inputId = "input-1",
					ordinal = 1L,
					source = nativeSource(),
					inputModes = INPUT_MODES,
					kind = NativeIoInputKind.KEYBOARD,
					byteLength = 4,
					chunkCount = 1,
				),
			)
		}
	}

	@Test
	fun capabilitiesAreClosedBoundedAndUnique() {
		val many = ArrayList<String>()
		for (index in 0 until 17) many.add("capability-$index")
		// This side built a frame it cannot send: a local mistake, never a peer failure.
		assertRefused(ContentFailureCode.INVALID_FRAME) {
			ContentProtocol.encode(HelloFrame(ContentProtocol.SERVICE, 1L, 0L, many))
		}
		assertRefused(ContentFailureCode.INVALID_FRAME) {
			ContentProtocol.encode(HelloFrame(ContentProtocol.SERVICE, 1L, 0L, listOf("a", "a")))
		}
		assertRefused(ContentFailureCode.INVALID_FRAME) {
			ContentProtocol.encode(HelloFrame(ContentProtocol.SERVICE, 1L, 0L, listOf("not an identifier")))
		}
		// The same three shapes arriving from a peer are refusals of the wire itself.
		val manyJson = buildString {
			append('[')
			for (index in 0 until 17) {
				if (index > 0) append(',')
				append("\"capability-").append(index).append('"')
			}
			append(']')
		}
		for (capabilities in listOf(
			manyJson,
			"""["native-viewport-v1","native-viewport-v1"]""",
			"""["not an identifier"]""",
		)) {
			assertRefused(ContentFailureCode.BAD_FRAME) { decodeText(helloWithCapabilities(capabilities)) }
		}
	}

	@Test
	fun boundsAreFiniteRelationalAndFailClosed() {
		assertEquals(65_536, defaultBounds.maxFrameBytes)
		assertEquals(64 * 1024 * 1024, defaultBounds.maxTransferBytes)
		assertEquals(32 * 1024, defaultBounds.maxChunkPayloadBytes)
		assertEquals(1_000, defaultBounds.maxCols)
		assertEquals(1_000, defaultBounds.maxRows)

		assertRefused(ContentFailureCode.INVALID_BOUNDS) { defaultBounds.copy(maxFrameBytes = 0) }
		assertRefused(ContentFailureCode.INVALID_BOUNDS) { defaultBounds.copy(maxChunkPayloadBytes = -1) }
		assertRefused(ContentFailureCode.INVALID_BOUNDS) { defaultBounds.copy(maxChunkPayloadBytes = 65_536) }
		assertRefused(ContentFailureCode.INVALID_BOUNDS) { defaultBounds.copy(maxChunkPayloadBytes = 49_152) }
		assertRefused(ContentFailureCode.INVALID_BOUNDS) { defaultBounds.copy(maxTransferBytes = 32 * 1024 - 1) }
	}

	@Test
	fun negotiationNarrowsToTheRequestedFeatureAndNeverImpliesAGrant() {
		val hello = HelloFrame(
			service = ContentProtocol.SERVICE,
			major = ContentProtocol.MAJOR,
			minor = 4L,
			capabilities = listOf(ContentProtocol.REQUIRED_CAPABILITY, ContentProtocol.NATIVE_IO_CAPABILITY),
		)
		assertTrue(ContentProtocol.KNOWN_OPTIONAL_CAPABILITIES.isEmpty())
		assertEquals(
			listOf(ContentProtocol.NATIVE_IO_CAPABILITY, ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY),
			ContentProtocol.IMPLEMENTABLE_OPTIONAL_CAPABILITIES,
		)
		assertEquals(
			ContentHelloDecision.Accepted(ContentProtocol.MAJOR, ContentProtocol.MINOR, emptyList()),
			ContentProtocol.negotiateHello(hello),
			"an implementable capability is never offered or accepted by default",
		)
		assertEquals(
			ContentHelloDecision.Accepted(ContentProtocol.MAJOR, ContentProtocol.MINOR, emptyList()),
			ContentProtocol.negotiateHello(hello, ContentNegotiationOptions(emptyList())),
		)
		assertEquals(
			ContentHelloDecision.Accepted(
				ContentProtocol.MAJOR,
				ContentProtocol.MINOR,
				listOf(ContentProtocol.NATIVE_IO_CAPABILITY),
			),
			ContentProtocol.negotiateHello(
				hello,
				ContentNegotiationOptions(listOf(ContentProtocol.NATIVE_IO_CAPABILITY)),
			),
			"only an explicit opt-in records the capability",
		)
		assertEquals(
			ContentHelloDecision.Refused(ContentErrorCode.UNSUPPORTED_VERSION),
			ContentProtocol.negotiateHello(hello.copy(service = "other-service")),
		)
		assertEquals(
			ContentHelloDecision.Refused(ContentErrorCode.UNSUPPORTED_VERSION),
			ContentProtocol.negotiateHello(hello.copy(major = 2L)),
		)
		assertEquals(
			ContentHelloDecision.Refused(ContentErrorCode.MISSING_CAPABILITY),
			ContentProtocol.negotiateHello(hello.copy(capabilities = listOf("native-viewport-v2"))),
		)
	}

	@Test
	fun aMalformedOptInFailsClosedInsteadOfBeingSilentlyDropped() {
		val hello = HelloFrame(
			service = ContentProtocol.SERVICE,
			major = ContentProtocol.MAJOR,
			minor = 0L,
			capabilities = listOf(ContentProtocol.REQUIRED_CAPABILITY),
		)
		val options = listOf(
			ContentNegotiationOptions(listOf("unimplemented")),
			ContentNegotiationOptions(
				listOf(ContentProtocol.NATIVE_IO_CAPABILITY, ContentProtocol.NATIVE_IO_CAPABILITY),
			),
			ContentNegotiationOptions(listOf("")),
			ContentNegotiationOptions(listOf("not an identifier")),
			ContentNegotiationOptions(listOf(ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY)),
		)
		for (option in options) {
			assertRefused(ContentFailureCode.INVALID_BOUNDS) { ContentProtocol.negotiateHello(hello, option) }
		}
	}

	@Test
	fun anAcknowledgementCanOnlyNarrowWhatEitherSideMayAssume() {
		val required = ContentProtocol.REQUIRED_CAPABILITY
		val nativeIo = ContentProtocol.NATIVE_IO_CAPABILITY
		val startup = ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY
		val ack = { capabilities: List<String> ->
			HelloAckFrame(ContentProtocol.SERVICE, ContentProtocol.MAJOR, ContentProtocol.MINOR, capabilities)
		}
		assertEquals(
			ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION),
			ContentProtocol.reviewHelloAck(ack(listOf(required, nativeIo)), listOf(required)),
			"an acknowledgement can never select a capability this side did not offer",
		)
		assertEquals(
			ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION),
			ContentProtocol.reviewHelloAck(ack(listOf(required, "future-optional")), listOf(required, "future-optional")),
			"a capability this build cannot implement is never accepted",
		)
		assertEquals(
			ContentAckDecision.Accepted(ContentProtocol.MINOR, listOf(required, nativeIo)),
			ContentProtocol.reviewHelloAck(ack(listOf(required, nativeIo)), listOf(required, nativeIo)),
		)
		assertEquals(
			ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION),
			ContentProtocol.reviewHelloAck(ack(listOf(required, startup)), listOf(required, startup)),
			"startup input without the capability it depends on cannot exist",
		)
		assertEquals(
			ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION),
			ContentProtocol.reviewHelloAck(
				HelloAckFrame(ContentProtocol.SERVICE, ContentProtocol.MAJOR, 1L, listOf(required)),
				listOf(required),
			),
			"a minor above the offered one is refused",
		)
	}

	@Test
	fun localFailuresMapOntoFixedWireCodesOnly() {
		assertEquals(ContentErrorCode.FRAME_TOO_LARGE, wireCodeForFailure(ContentFailureCode.FRAME_TOO_LARGE))
		assertEquals(ContentErrorCode.TRANSFER_FAILED, wireCodeForFailure(ContentFailureCode.TRANSFER_TOO_LARGE))
		assertEquals(ContentErrorCode.TRANSFER_FAILED, wireCodeForFailure(ContentFailureCode.TRANSFER_FAILED))
		assertEquals(ContentErrorCode.PROTOCOL_VIOLATION, wireCodeForFailure(ContentFailureCode.INVALID_BOUNDS))
		assertEquals(ContentErrorCode.BAD_FRAME, wireCodeForFailure(ContentFailureCode.BAD_FRAME))
		assertEquals(ContentErrorCode.BAD_FRAME, wireCodeForFailure(ContentFailureCode.INVALID_FRAME))
		assertNull(ContentErrorCode.fromWireValue("nope"))
		assertNull(ContentEndCode.fromWireValue("nope"))
	}
}
