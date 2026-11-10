package io.github.rfairburn.pireviewgate.core.protocol.content

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Explicit optional-capability opt-in. The default (`null`, or an empty list)
 * offers and accepts nothing, so knowing a capability never enables it and an
 * existing host or client keeps its legacy, display-only behavior.
 */
data class ContentNegotiationOptions(val supportedOptionalCapabilities: List<String> = emptyList())

/** Owner-side decision on one hello. */
sealed interface ContentHelloDecision {
	/** The negotiated major, minor, and the capabilities actually recorded. */
	data class Accepted(val major: Long, val minor: Long, val capabilities: List<String>) : ContentHelloDecision

	/** One fixed reason this hello is not usable. */
	data class Refused(val code: ContentErrorCode) : ContentHelloDecision
}

/** Viewer-side decision on one `hello_ack`. */
sealed interface ContentAckDecision {
	/** The acknowledged minor and capability set. */
	data class Accepted(val minor: Long, val capabilities: List<String>) : ContentAckDecision

	/** One fixed reason this acknowledgement is not usable. */
	data class Refused(val code: ContentErrorCode) : ContentAckDecision
}

/**
 * The portable content wire codec of one native viewport lane: fixed frame
 * shapes, finite bounds, feature negotiation, message encode/decode, and the
 * complete-viewport payload encode/decode.
 *
 * This codec is a pure contract. It performs no IO, reads no ambient
 * configuration, opens no socket or listener, starts no timer, and creates no
 * permission, grant, view-only policy, identity, or authorization decision.
 * Reaching it at all already means the caller holds the directional grant the
 * application lane requires.
 *
 * One binary message carries exactly one complete UTF-8 JSON frame, so
 * [ContentBounds.maxFrameBytes] bounds ONE message, not a whole viewport. A
 * complete [TerminalFrame] — all rows, generated SGR styling, structured style
 * runs, cursor, input modes, and typed PNG images, placements, and fallbacks —
 * is serialized as one canonical UTF-8 JSON payload by
 * [encodeTerminalPayload] and carried as `content_begin` / sequential
 * `content_chunk` / `content_end`. Assembling those frames into a snapshot, and
 * packing a payload into them, is the caller's next step and deliberately not
 * part of this codec.
 *
 * Frame line text is restricted to the native serializer's visible text plus
 * exactly the SGR forms its own generator emits (allowlisted attributes and
 * bounded palette/RGB groups). There is no arbitrary VT or raw child PTY
 * passthrough anywhere here, and typing is validated by the same PNG subset the
 * native surface accepts rather than by a weaker duplicate.
 *
 * Every refusal carries one fixed code. No raw frame, path, peer text, or
 * exception detail is ever attached, and nothing partial is ever returned.
 */
object ContentProtocol {
	/** Service identity of the content channel; distinct from any roster lane. */
	const val SERVICE: String = "pi-peer-session-content-v1"

	/** Incompatible-change version. A mismatch is refused, never adapted. */
	const val MAJOR: Long = 1L

	/** Additive-change version. Grants no capability and enables no behavior. */
	const val MINOR: Long = 0L

	/** Required baseline capability. This is feature negotiation only. */
	const val REQUIRED_CAPABILITY: String = "native-viewport-v1"

	/**
	 * Optional capability naming the native input and text-copy frames.
	 *
	 * Knowing this identifier is never an offer and never an acknowledgement:
	 * negotiation requires an explicit supported set whose default is empty, so an
	 * existing host or client keeps its exact legacy behavior — display only, no
	 * input authority, no clipboard transport — until a real provider opts in.
	 */
	const val NATIVE_IO_CAPABILITY: String = "native-input-copy-v1"

	/**
	 * Optional capability naming startup-phase native INPUT: a publish whose
	 * `nativeSession` is null may state a tuple-less startup source, and an input
	 * frame may echo it. It depends on [NATIVE_IO_CAPABILITY]: it is offered and
	 * acknowledged only together with it, and it never extends copy, which keeps
	 * its conversation-only source.
	 */
	const val NATIVE_INPUT_STARTUP_CAPABILITY: String = "native-input-startup-v1"

	/**
	 * Optional capabilities negotiated without an explicit opt-in. There are none:
	 * the native IO extension can carry input and clipboard data, so offering it on
	 * the strength of a peer's hello alone would be an activation.
	 */
	val KNOWN_OPTIONAL_CAPABILITIES: List<String> = emptyList()

	/**
	 * Optional capabilities this build can implement once a provider explicitly
	 * enables them. Being implementable is never an offer.
	 */
	val IMPLEMENTABLE_OPTIONAL_CAPABILITIES: List<String> =
		listOf(NATIVE_IO_CAPABILITY, NATIVE_INPUT_STARTUP_CAPABILITY)

	/**
	 * Decoded UTF-8 bytes accepted by one atomic native text paste: exactly 1 MiB.
	 * This is a text bound, not a transport bound.
	 */
	const val NATIVE_TEXT_PASTE_MAX_BYTES: Int = 1_048_576

	/**
	 * Canonical encoded characters in one native text copy — the unchanged native
	 * producer bound, carried whole across bounded pages rather than reduced to a
	 * transport message size.
	 */
	const val NATIVE_COPY_MAX_ENCODED_CHARS: Int = 100_000

	/** Bytes in one host-issued native IO source token. */
	const val NATIVE_IO_MAX_SOURCE_TOKEN_BYTES: Int = 128

	/** One content subscription per channel; not configurable. */
	const val MAX_SUBSCRIPTIONS_PER_CHANNEL: Int = 1

	/** One viewport transfer in flight per channel; not configurable. */
	const val MAX_IN_FLIGHT_TRANSFERS: Int = 1

	/**
	 * Decode one complete binary message into one frame.
	 *
	 * Bytes that are not valid UTF-8, not a single JSON object, structurally
	 * invalid, oversized, or carrying any key outside this schema are refused with
	 * a fixed code; nothing partial is ever returned and no peer content is
	 * included in the failure.
	 */
	fun decode(bytes: ByteArray, bounds: ContentBounds = ContentBounds.DEFAULT): ContentFrame {
		if (bytes.isEmpty()) fail(ContentFailureCode.BAD_FRAME)
		if (bytes.size > bounds.maxFrameBytes) fail(ContentFailureCode.FRAME_TOO_LARGE)
		val text = Utf8Wire.decodeStrict(bytes) ?: fail(ContentFailureCode.BAD_FRAME)
		return buildFrame(parseJsonObject(text), bounds)
	}

	/**
	 * Encode one frame as the complete payload of one binary channel message.
	 *
	 * The frame is validated through the same reader that decodes it, and the
	 * encoded bytes must fit the per-message bound; an oversized message is an
	 * error, never a truncated or split message. A frame this side built wrongly is
	 * reported as [ContentFailureCode.INVALID_FRAME], not as a peer failure.
	 */
	fun encode(frame: ContentFrame, bounds: ContentBounds = ContentBounds.DEFAULT): ByteArray {
		val text = writeWireNode(frameNode(frame))
		validateEncoded(text, bounds)
		val bytes = Utf8Wire.encode(text)
		if (bytes.size > bounds.maxFrameBytes) fail(ContentFailureCode.FRAME_TOO_LARGE)
		return bytes
	}

	/**
	 * Encode the complete native viewport as the canonical UTF-8 JSON payload of a
	 * transfer. The payload is validated first and must fit the transfer ceiling;
	 * an oversized viewport is an honest error, never a trimmed or filtered frame.
	 */
	fun encodeTerminalPayload(frame: TerminalFrame, bounds: ContentBounds = ContentBounds.DEFAULT): ByteArray {
		val text = writeWireNode(terminalFrameNode(frame))
		try {
			normalizeTerminalFrame(parseJsonObject(text), bounds)
		} catch (error: ContentProtocolException) {
			// A frame this side built wrongly is a programming failure, not a peer one.
			if (error.code == ContentFailureCode.BAD_FRAME) fail(ContentFailureCode.INVALID_FRAME)
			throw error
		}
		val bytes = Utf8Wire.encode(text)
		if (bytes.size > bounds.maxTransferBytes) fail(ContentFailureCode.TRANSFER_TOO_LARGE)
		return bytes
	}

	/** Decode and validate one complete native viewport payload. */
	fun decodeTerminalPayload(bytes: ByteArray, bounds: ContentBounds = ContentBounds.DEFAULT): TerminalFrame {
		if (bytes.isEmpty()) fail(ContentFailureCode.BAD_FRAME)
		if (bytes.size > bounds.maxTransferBytes) fail(ContentFailureCode.TRANSFER_TOO_LARGE)
		val text = Utf8Wire.decodeStrict(bytes) ?: fail(ContentFailureCode.BAD_FRAME)
		return normalizeTerminalFrame(parseJsonObject(text), bounds)
	}

	/**
	 * Owner-side decision on one hello. A different service or major version is
	 * refused, and a hello without the native-viewport capability is refused.
	 * Optional capabilities are recorded only when they appear in the explicit
	 * enabled set — never merely because the peer offered a known identifier — so
	 * the default decision acknowledges the baseline alone. The negotiated minor is
	 * the lower of the two so a newer peer cannot imply behavior this
	 * implementation does not have.
	 */
	fun negotiateHello(hello: HelloFrame, options: ContentNegotiationOptions? = null): ContentHelloDecision {
		val enabled = enabledOptionalCapabilities(options)
		if (hello.service != SERVICE || hello.major != MAJOR) {
			return ContentHelloDecision.Refused(ContentErrorCode.UNSUPPORTED_VERSION)
		}
		if (!hello.capabilities.contains(REQUIRED_CAPABILITY)) {
			return ContentHelloDecision.Refused(ContentErrorCode.MISSING_CAPABILITY)
		}
		val offeredAndEnabled = hello.capabilities.filter { capability ->
			capability != REQUIRED_CAPABILITY && enabled.contains(capability)
		}
		// Startup input is acknowledged ONLY together with native IO: a peer that
		// offers startup without native IO simply does not get it.
		val negotiated = if (offeredAndEnabled.contains(NATIVE_IO_CAPABILITY)) {
			offeredAndEnabled
		} else {
			offeredAndEnabled.filter { capability -> capability != NATIVE_INPUT_STARTUP_CAPABILITY }
		}
		return ContentHelloDecision.Accepted(
			major = MAJOR,
			minor = minOf(hello.minor, MINOR),
			capabilities = negotiated,
		)
	}

	/**
	 * Viewer-side decision on one `hello_ack`. The owner must confirm this side's
	 * service and major version and must acknowledge the requested capability. An
	 * acknowledgement that claims a capability this side never offered, or one this
	 * build cannot implement, or a minor above the one offered, is a protocol
	 * violation: negotiation can only narrow what either side may assume, never
	 * widen it.
	 */
	fun reviewHelloAck(ack: HelloAckFrame, offeredCapabilities: List<String>): ContentAckDecision {
		if (ack.service != SERVICE || ack.major != MAJOR) {
			return ContentAckDecision.Refused(ContentErrorCode.UNSUPPORTED_VERSION)
		}
		if (!ack.capabilities.contains(REQUIRED_CAPABILITY)) {
			return ContentAckDecision.Refused(ContentErrorCode.MISSING_CAPABILITY)
		}
		if (ack.minor > MINOR) return ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION)
		for (capability in ack.capabilities) {
			// A capability this build cannot implement is never accepted, even when a
			// caller mistakenly listed it as offered.
			if (capability != REQUIRED_CAPABILITY && !IMPLEMENTABLE_OPTIONAL_CAPABILITIES.contains(capability)) {
				return ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION)
			}
			if (!offeredCapabilities.contains(capability)) {
				return ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION)
			}
		}
		// An acknowledgement of startup input without the native IO capability it
		// depends on describes an extension that cannot exist.
		if (ack.capabilities.contains(NATIVE_INPUT_STARTUP_CAPABILITY) &&
			!ack.capabilities.contains(NATIVE_IO_CAPABILITY)
		) {
			return ContentAckDecision.Refused(ContentErrorCode.PROTOCOL_VIOLATION)
		}
		return ContentAckDecision.Accepted(minor = ack.minor, capabilities = ack.capabilities.toList())
	}

	/**
	 * Validate one encoded frame text through the wire reader, mapping a local
	 * shape mistake onto the caller-facing [ContentFailureCode.INVALID_FRAME].
	 */
	private fun validateEncoded(text: String, bounds: ContentBounds) {
		try {
			buildFrame(parseJsonObject(text), bounds)
		} catch (error: ContentProtocolException) {
			if (error.code == ContentFailureCode.BAD_FRAME) fail(ContentFailureCode.INVALID_FRAME)
			throw error
		}
	}

	/**
	 * Resolve the explicitly enabled optional capabilities. Only identifiers this
	 * build implements may be enabled, and a malformed, duplicated, oversized, or
	 * unimplementable entry fails closed instead of being silently dropped.
	 */
	private fun enabledOptionalCapabilities(options: ContentNegotiationOptions?): List<String> {
		if (options == null) return emptyList()
		val raw = options.supportedOptionalCapabilities
		if (raw.size > ContentBounds.DEFAULT.maxCapabilities) fail(ContentFailureCode.INVALID_BOUNDS)
		val enabled = ArrayList<String>(raw.size)
		for (entry in raw) {
			if (entry.isEmpty()) fail(ContentFailureCode.INVALID_BOUNDS)
			if (Utf8Wire.byteLength(entry) > ContentBounds.DEFAULT.maxCapabilityIdBytes) {
				fail(ContentFailureCode.INVALID_BOUNDS)
			}
			if (!IDENTIFIER_PATTERN.matches(entry)) fail(ContentFailureCode.INVALID_BOUNDS)
			if (!IMPLEMENTABLE_OPTIONAL_CAPABILITIES.contains(entry)) fail(ContentFailureCode.INVALID_BOUNDS)
			if (enabled.contains(entry)) fail(ContentFailureCode.INVALID_BOUNDS)
			enabled.add(entry)
		}
		// Startup input depends on the native IO capability: enabling it alone is a
		// malformed opt-in, refused rather than silently narrowed.
		if (enabled.contains(NATIVE_INPUT_STARTUP_CAPABILITY) && !enabled.contains(NATIVE_IO_CAPABILITY)) {
			fail(ContentFailureCode.INVALID_BOUNDS)
		}
		return enabled
	}

	private fun parseJsonObject(text: String): JsonObject {
		val element = try {
			Json.parseToJsonElement(text)
		} catch (overflow: StackOverflowError) {
			// A pathologically nested document is a bounded refusal, not a crash.
			fail(ContentFailureCode.BAD_FRAME)
		} catch (error: Exception) {
			fail(ContentFailureCode.BAD_FRAME)
		}
		if (element !is JsonObject) fail(ContentFailureCode.BAD_FRAME)
		return element
	}
}
