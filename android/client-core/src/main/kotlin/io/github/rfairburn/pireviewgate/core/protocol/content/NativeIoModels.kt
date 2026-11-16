package io.github.rfairburn.pireviewgate.core.protocol.content

import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend

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
) : NativeIoInputSource, NativeIoCopySource

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

/**
 * Exact host-written NATIVE CLI source: one hosted provider CLI row its owner runs
 * as a plain PTY process. The same run, owner row, geometry, viewer revision, and
 * opaque token facts as [NativeIoSource], plus the explicit `native-cli` phase and
 * the owner's recorded backend of that row, and NO native tuple, registration, PID,
 * path, or command — a hosted provider child has no Pi conversation, and the owner
 * binds this source to the child process only through its own private
 * per-incarnation key behind [sourceToken].
 */
data class NativeIoNativeCliSource(
	override val hostRunId: String,
	override val sessionId: String,
	/** The owner's recorded backend of this row; never inferred from output or a label. */
	val backend: NativeCliBackend,
	override val geometry: SessionGeometry,
	override val viewerRevision: Long,
	override val sourceToken: String,
) : NativeIoInputSource, NativeIoCopySource

/**
 * The closed source shape one copy frame may carry: the unchanged Pi conversation
 * source, or the tuple-less hosted provider CLI source of a channel that negotiated
 * the hosted copy capability. A startup source is never a copy source on either side,
 * and the type says so rather than relying on a runtime check.
 */
sealed interface NativeIoCopySource : NativeIoInputSource

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
sealed interface NativeIoCopyEvent : NativeIoCopyFrameEvent {
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
 * The copy event union: an unchanged Pi conversation event carrying the producer's
 * own tuple, or a hosted provider CLI event carrying that row's recorded backend.
 */
sealed interface NativeIoCopyFrameEvent

/**
 * Copy payload of one hosted provider TEXT copy: canonical base64 UTF-8 text plus
 * the row's own recorded backend, and NO tuple at all. A hosted provider child has
 * no Pi conversation, so stating one here would be a fabricated attribution; the
 * child process it rode in on is bound only through the owner's private
 * per-incarnation key behind the source's opaque token.
 */
data class NativeIoNativeCliCopyEvent(
	val encoded: String,
	val backend: NativeCliBackend,
) : NativeIoCopyFrameEvent

/** True only for the hosted provider variant of a copy event. */
fun isNativeIoNativeCliCopyEvent(event: NativeIoCopyFrameEvent): Boolean = event is NativeIoNativeCliCopyEvent

/**
 * Exact structural, variant-aware equality of two sources.
 *
 * Equal dimensions are never enough: the epoch, the geometry revision, the viewer
 * revision, and the host token must all agree, so an A-to-B-to-A viewport change
 * is never treated as the original A, and a startup source never equals a
 * conversation source or a hosted provider CLI source. Two hosted provider CLI
 * sources also have to name the same backend. This is a comparison only; it grants
 * and implies no authority.
 */
fun nativeIoSourceEquals(left: NativeIoInputSource, right: NativeIoInputSource): Boolean {
	val leftVariant = nativeIoSourceVariant(left)
	if (leftVariant != nativeIoSourceVariant(right)) return false
	if (leftVariant == NativeIoSourceVariant.CONVERSATION) {
		val leftTuple = (left as NativeIoSource).nativeSession
		val rightTuple = (right as NativeIoSource).nativeSession
		if (leftTuple.sessionId != rightTuple.sessionId || leftTuple.epoch != rightTuple.epoch) return false
	}
	if (leftVariant == NativeIoSourceVariant.NATIVE_CLI) {
		if ((left as NativeIoNativeCliSource).backend != (right as NativeIoNativeCliSource).backend) return false
	}
	return left.hostRunId == right.hostRunId &&
		left.sessionId == right.sessionId &&
		left.geometry.cols == right.geometry.cols &&
		left.geometry.rows == right.geometry.rows &&
		left.geometry.revision == right.geometry.revision &&
		left.viewerRevision == right.viewerRevision &&
		left.sourceToken == right.sourceToken
}

/** The closed variant of one source, for the variant-aware comparison. */
internal enum class NativeIoSourceVariant { STARTUP, NATIVE_CLI, CONVERSATION }

internal fun nativeIoSourceVariant(source: NativeIoInputSource): NativeIoSourceVariant = when (source) {
	is NativeIoStartupSource -> NativeIoSourceVariant.STARTUP
	is NativeIoNativeCliSource -> NativeIoSourceVariant.NATIVE_CLI
	is NativeIoSource -> NativeIoSourceVariant.CONVERSATION
}
