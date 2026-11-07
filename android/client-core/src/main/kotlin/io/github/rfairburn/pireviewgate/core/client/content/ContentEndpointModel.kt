package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.IDENTIFIER_PATTERN
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeSessionRef
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import io.github.rfairburn.pireviewgate.core.protocol.content.Utf8Wire

/**
 * Identifier admission identical to the wire reader's own, so a value this lane
 * cannot encode is refused before any endpoint state exists.
 */
internal fun isValidContentIdentifier(value: String, maxBytes: Int): Boolean =
	value.isNotEmpty() && Utf8Wire.byteLength(value) <= maxBytes && IDENTIFIER_PATTERN.matches(value)

/**
 * The ONE target a content endpoint may ever serve.
 *
 * Every field is immutable for the endpoint's lifetime: another owner run, owner
 * row, transport connection, or selection generation means a different endpoint,
 * never a retarget. [hostId] is the local saved-destination handle only — it is
 * never an identity, a path, or a peer key, and the endpoint never resolves it.
 */
data class ContentEndpointTarget(
	val hostId: HostId,
	/** Transport connection generation this endpoint was created for. */
	val connectionGeneration: Long,
	/** Caller's monotonic selection generation; a stale one never wins. */
	val selectionGeneration: Long,
	/** Exact owner run id observed in that destination's current roster. */
	val ownerRunId: String,
	/** Exact owner row id within that run's current roster. */
	val rowId: String,
) {
	init {
		require(connectionGeneration >= 0L) { "content connection generation is invalid" }
		require(selectionGeneration >= 0L) { "content selection generation is invalid" }
		require(isValidContentIdentifier(ownerRunId, ContentBounds.DEFAULT.maxIdentifierBytes)) {
			"content owner run id is invalid"
		}
		require(isValidContentIdentifier(rowId, ContentBounds.DEFAULT.maxIdentifierBytes)) {
			"content owner row id is invalid"
		}
	}
}

/** One viewer-requested pane size. The owner always reports its own geometry. */
data class ContentViewportRequest(val cols: Int, val rows: Int) {
	init {
		require(cols in 1..ContentBounds.DEFAULT.maxCols) { "content viewport columns are invalid" }
		require(rows in 1..ContentBounds.DEFAULT.maxRows) { "content viewport rows are invalid" }
	}
}

/**
 * Explicit opt-in for the optional native input and text-copy extension.
 *
 * Omitting this option entirely keeps the exact legacy display-only behavior: no
 * optional capability is offered, acknowledged, or acted on. Listing a capability
 * here is an offer only — it grants nothing, and the extension turns on only when
 * the owner acknowledges it. A host that never acknowledges stays a truthful
 * display-only stream rather than an invented permission.
 */
data class ContentNativeIoOptions(
	/**
	 * Optional capabilities this viewer offers. Only identifiers the protocol can
	 * implement are admissible, and startup input is admissible only beside the
	 * native IO capability it depends on.
	 */
	val offeredCapabilities: List<String>,
) {
	init {
		for (capability in offeredCapabilities) {
			require(ContentProtocol.IMPLEMENTABLE_OPTIONAL_CAPABILITIES.contains(capability)) {
				"content optional capability is not implementable"
			}
		}
		require(
			!offeredCapabilities.contains(ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY) ||
				offeredCapabilities.contains(ContentProtocol.NATIVE_IO_CAPABILITY),
		) { "content startup input requires the native IO capability" }
	}
}

/**
 * The finite deadlines this endpoint applies, in whole milliseconds.
 *
 * The values mirror the existing source lane (handshake 5 s, first transfer 15 s,
 * in-flight transfer idle 30 s, stop acknowledgement 2 s). [transferIdleMs] also
 * bounds ONE invoked wire write, exactly as the source's per-send deadline reuses
 * the transfer bound. There is deliberately no idle expiry for a published
 * viewport: an unchanged current frame stays current forever, and no deadline of
 * any kind revives, retries, or reconnects.
 */
data class ContentDeadlineSettings(
	val handshakeMs: Long,
	val firstTransferMs: Long,
	val transferIdleMs: Long,
	val stopAckMs: Long,
) {
	init {
		require(handshakeMs > 0L) { "content handshake deadline is invalid" }
		require(firstTransferMs > 0L) { "content first-transfer deadline is invalid" }
		require(transferIdleMs > 0L) { "content transfer idle deadline is invalid" }
		require(stopAckMs > 0L) { "content stop acknowledgement deadline is invalid" }
	}

	companion object {
		/** The fixed source deadlines this lane is built with. */
		val DEFAULT: ContentDeadlineSettings = ContentDeadlineSettings(
			handshakeMs = 5_000L,
			firstTransferMs = 15_000L,
			transferIdleMs = 30_000L,
			stopAckMs = 2_000L,
		)
	}
}

/** Which finite wait one armed deadline covers. */
enum class ContentDeadlineKind {
	/** Waiting for this endpoint's own `hello_ack`. */
	HANDSHAKE,

	/** Waiting for the first admitted transfer of the subscription. */
	FIRST_TRANSFER,

	/** Waiting for the next frame of one in-flight viewport transfer. */
	TRANSFER_IDLE,

	/** Waiting for the acknowledgement of this endpoint's own unsubscribe. */
	STOP_ACK,

	/** Waiting for the next page of one in-flight native copy. */
	COPY_IDLE,

	/**
	 * Waiting for one invoked wire write to return.
	 *
	 * A write that was entered and never came back is bounded by the same finite
	 * transfer-idle bound the source lane uses, so a held control write cannot stall
	 * the endpoint forever and a held input page cannot pin a pending slot. This is
	 * NOT an idle expiry of published content: an unchanged current viewport arms
	 * nothing at all.
	 */
	SEND,
	;
}

/** One armed deadline as the coordinator must arm it: an absolute monotonic mark. */
data class ContentDeadline(val kind: ContentDeadlineKind, val dueAtNanos: Long)

/**
 * The metadata of one atomically assembled viewport transfer.
 *
 * Every fact came from the transfer itself; nothing is inferred from screen text,
 * a neighbouring row, or a previous publish.
 */
data class ContentTransferMeta(
	val subscriptionId: String,
	val transferId: String,
	val hostRunId: String,
	/** Owner row id; never derived from screen text. */
	val rowId: String,
	val nativeSession: NativeSessionRef?,
	val sequence: Long,
	val geometry: SessionGeometry,
	val inputModes: TerminalInputModes,
	/** Tri-state source: absent for a legacy publish, stated only when the wire said so. */
	val inputSource: OptionalNativeIoSource,
	val byteLength: Int,
	val chunkCount: Int,
)

/** One atomically complete, currently valid native viewport. */
data class ContentSnapshot(
	val meta: ContentTransferMeta,
	val frame: TerminalFrame,
)

/** Lifecycle phase of one endpoint. Retirement is terminal and never resumes. */
enum class ContentEndpointPhase {
	/** Not started yet: [ContentEndpoint.start] has not been called. */
	NONE,

	/** The hello was handed to the caller; no acknowledgement accepted yet. */
	AWAITING_ACK,

	/** The acknowledgement was accepted; the subscription acknowledgement is pending. */
	SUBSCRIBING,

	/** This endpoint's exact `subscribed` acknowledgement was accepted. */
	STREAMING,

	/** Local stop intent recorded; at most its own bounded unsubscribe notice remains. */
	STOPPING,

	/** Retired for good: detached, cleared, and never resumed by late data. */
	RETIRED,
	;
}

/**
 * Honest availability of the selected stream.
 *
 * `current` only while one complete validated viewport is published. `unavailable`
 * keeps the deliberate target and never pretends to be another host's content.
 */
enum class ContentViewStatus { NONE, CONNECTING, CURRENT, UNAVAILABLE }

/**
 * Fixed, display-safe reasons this endpoint's content is not available.
 *
 * Never peer content, key material, a path, a row label, or an exception detail.
 * Reasons that belong to a destination or a coordinator (a host that is not
 * connected, a missing remembered key, a refused upgrade) are deliberately absent:
 * this endpoint cannot observe them.
 */
enum class ContentUnavailableReason {
	/** The owner refused this exact subscription request. */
	OWNER_REFUSED,

	/** The owner did not acknowledge the hello or the subscription in its finite window. */
	SUBSCRIPTION_TIMEOUT,

	/** The published stream disagreed with this endpoint's own fenced tuple. */
	PROTOCOL_VIOLATION,

	/** A content control write could not be handed to the transport. */
	SEND_FAILED,

	/** A viewport transfer failed or was incomplete. */
	TRANSFER_FAILED,

	/** The published view stopped being current while the endpoint stayed selected. */
	CONTENT_LOST,

	/** The endpoint's own transport channel went away. */
	CONNECTION_LOST,

	/** Local stop or retirement. */
	STOPPED,
	;
}

/** The exact native input target of the currently published stream. */
data class ContentNativeInputTarget(
	/** Local saved-destination handle. Never a native instance id or identity. */
	val hostId: HostId,
	val selectionGeneration: Long,
	/** This endpoint's own subscription id; never chosen by the caller. */
	val subscriptionId: String,
	/**
	 * The exact host-written source of the currently published view: a conversation
	 * source, or the tuple-less startup source of a publish that named no
	 * conversation. It is descriptive only and never authority to write.
	 */
	val source: NativeIoInputSource,
	/** The exact observed input modes of that same published view. */
	val inputModes: TerminalInputModes,
)

/**
 * The immutable, thread-safe view of one endpoint.
 *
 * Callers never hold a live view of endpoint state: every read returns a snapshot
 * of the facts at the moment of the call, and no Android, coroutine, or transport
 * type appears here.
 */
data class ContentEndpointObservation(
	val target: ContentEndpointTarget,
	val subscriptionId: String,
	val phase: ContentEndpointPhase,
	val status: ContentViewStatus,
	/** The complete current view, `null` the moment it stops being current. */
	val view: ContentSnapshot?,
	/** A fixed code whenever content is not current, otherwise `null`. */
	val reason: ContentUnavailableReason?,
	/** Capabilities the owner actually acknowledged. */
	val acknowledgedCapabilities: List<String>,
	val nativeIoNegotiated: Boolean,
	val startupInputNegotiated: Boolean,
	/** Newest viewer-requested size; the owner reports its own geometry in frames. */
	val requestedViewport: ContentViewportRequest,
	/** Geometry of the currently published view, if any. */
	val publishedGeometry: SessionGeometry?,
	/** Receipt of the frame the caller actually committed, or `null`. */
	val writtenReceipt: WrittenRemoteContent?,
	/** Live remote input/copy preference this endpoint is under. */
	val inputPolicy: ContentInputPolicy,
	/** Logical input operations admitted and not yet settled. */
	val pendingInputCount: Int,
	/** Monotonic source/modes generation; the only proof that survives A → B → A. */
	val inputGeneration: Long,
	/**
	 * The live resize epoch. A caller composes a written-frame proof under it, and an
	 * A → B → A geometry return never revives a proof captured under an older value.
	 */
	val resizeEpoch: Long,
)
