package io.github.rfairburn.pireviewgate.core.protocol.content

/** Exact session geometry carried by a transfer; identical to the native session geometry. */
data class SessionGeometry(val cols: Int, val rows: Int, val revision: Long)

/** The only native conversation identity a content transfer may carry. */
data class NativeSessionRef(
	val sessionId: String,
	/** Positive conversation epoch; a new conversation is a different value. */
	val epoch: Long,
)

/**
 * The common facts of one host-written native IO source.
 *
 * Nothing in this package derives the source token or treats it — nor the tuple,
 * geometry, or modes — as authority for a write. There is deliberately no
 * bootstrap secret, agent path, current file, configuration, permission, or
 * lease field.
 */
sealed interface NativeIoInputSource {
	val hostRunId: String

	/** Owner row id of the session, never a native conversation id. */
	val sessionId: String

	val geometry: SessionGeometry

	/** Positive viewer revision: equal dimensions alone never identify a viewport. */
	val viewerRevision: Long

	/** Host-issued opaque commitment: bounded printable ASCII, never interpreted. */
	val sourceToken: String
}

/**
 * Exact host-written native IO source for one input or copy frame. Its native
 * tuple is always present.
 */
data class NativeIoSource(
	override val hostRunId: String,
	override val sessionId: String,
	val nativeSession: NativeSessionRef,
	override val geometry: SessionGeometry,
	override val viewerRevision: Long,
	override val sourceToken: String,
) : NativeIoInputSource

/**
 * Exact host-written STARTUP-phase input source. It describes one publish whose
 * `nativeSession` is null while the owner's row is in its explicit startup
 * phase: the same run, owner row, geometry, viewer revision, and opaque token
 * facts as [NativeIoSource], plus the explicit startup phase, and NO native
 * tuple at all — never a null or fabricated one. Input-only: no copy frame can
 * carry it.
 */
data class NativeIoStartupSource(
	override val hostRunId: String,
	override val sessionId: String,
	override val geometry: SessionGeometry,
	override val viewerRevision: Long,
	override val sourceToken: String,
) : NativeIoInputSource

/** True for the startup variant of an input-path source. */
fun isNativeIoStartupSource(source: NativeIoInputSource): Boolean = source is NativeIoStartupSource

/**
 * Tri-state presence of the optional `inputSource` wire key on a publish.
 *
 * A legacy publish keeps its exact key set with [Absent]; [NoSource] states that
 * the owner has no source to report; [Stated] carries one exact host-written
 * source. Collapsing these into a plain nullable field would let a legacy
 * publish claim a key it never carried.
 */
sealed interface OptionalNativeIoSource {
	/** The wire key is absent: a publish that states nothing about a source. */
	object Absent : OptionalNativeIoSource {
		override fun toString(): String = "OptionalNativeIoSource.Absent"
	}

	/** The wire key is present and null: the owner cannot state a source. */
	object NoSource : OptionalNativeIoSource {
		override fun toString(): String = "OptionalNativeIoSource.NoSource"
	}

	/** The wire key carries one exact host-written input-path source. */
	data class Stated(val source: NativeIoInputSource) : OptionalNativeIoSource
}

/** Native input payload kinds. Image and file payloads are not expressible. */
enum class NativeIoInputKind(val wireValue: String) {
	KEYBOARD("keyboard"),
	PASTE("paste"),
	MOUSE("mouse"),
	;

	companion object {
		/** The one kind named by [wireValue], or null when it is not a kind. */
		fun fromWireValue(value: String): NativeIoInputKind? = values().firstOrNull { it.wireValue == value }
	}
}

/**
 * Fixed reasons a native copy can be unavailable; mirrors the producer's closed
 * set without importing its runtime module.
 */
enum class NativeIoCopyUnavailableReason(val wireValue: String) {
	UNVERIFIED_NATIVE_ORIGIN("unverified-native-origin"),
	UNSUPPORTED_RUNTIME("unsupported-runtime"),
	;

	companion object {
		/** The one reason named by [wireValue], or null when it is not a reason. */
		fun fromWireValue(value: String): NativeIoCopyUnavailableReason? = values().firstOrNull { it.wireValue == value }
	}
}

/**
 * Copy payload carried by the wire: canonical base64 text, or a fixed reason,
 * always together with the authenticated native tuple of the copy that caused
 * it. Never a raw OSC 52 sequence and never image data.
 *
 * The tuple is the producer's own session id and epoch; it must agree with the
 * frame's source native tuple, so a payload can never be attributed to a
 * different native conversation than the one it was emitted for.
 */
sealed interface NativeIoCopyEvent {
	val sessionId: String
	val sessionEpoch: Long

	/** One canonical base64 text copy. */
	data class Copy(
		val encoded: String,
		override val sessionId: String,
		override val sessionEpoch: Long,
	) : NativeIoCopyEvent

	/** One fixed unavailable reason for the same native conversation. */
	data class Unavailable(
		val reason: NativeIoCopyUnavailableReason,
		override val sessionId: String,
		override val sessionEpoch: Long,
	) : NativeIoCopyEvent
}

/**
 * Exact structural, variant-aware equality of two sources.
 *
 * Equal dimensions are never enough: the epoch, the geometry revision, the viewer
 * revision, and the host token must all agree, so an A-to-B-to-A viewport change
 * is never treated as the original A, and a startup source never equals a
 * conversation source. This is a comparison only; it grants and implies no
 * authority.
 */
fun nativeIoSourceEquals(left: NativeIoInputSource, right: NativeIoInputSource): Boolean {
	val leftStartup = left is NativeIoStartupSource
	val rightStartup = right is NativeIoStartupSource
	if (leftStartup != rightStartup) return false
	if (!leftStartup && !rightStartup) {
		val leftTuple = (left as NativeIoSource).nativeSession
		val rightTuple = (right as NativeIoSource).nativeSession
		if (leftTuple.sessionId != rightTuple.sessionId || leftTuple.epoch != rightTuple.epoch) return false
	}
	return left.hostRunId == right.hostRunId &&
		left.sessionId == right.sessionId &&
		left.geometry.cols == right.geometry.cols &&
		left.geometry.rows == right.geometry.rows &&
		left.geometry.revision == right.geometry.revision &&
		left.viewerRevision == right.viewerRevision &&
		left.sourceToken == right.sourceToken
}
