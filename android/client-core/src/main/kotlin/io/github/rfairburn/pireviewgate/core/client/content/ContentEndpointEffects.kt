package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoCopyEvent
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes

/**
 * The per-MESSAGE dynamic guard the actual transport must consume before it
 * queues AND immediately before it dispatches one effect.
 *
 * Each effect names its OWN guard type and its own epoch. That is deliberate: an
 * input lifetime ending must never invalidate an unrelated hello, subscribe,
 * resize, or unsubscribe notice, and a resize epoch must never invalidate an
 * admitted input. A guard check is a cheap immutable comparison — no lock, no
 * socket, and no callback — so a transport can re-prove it at the exact moment it
 * would hand bytes over.
 */
sealed interface ContentSendGuard {
	/** The connection generation this effect belongs to. */
	val connectionGeneration: Long

	/** One hello: valid only while that connection generation is the live one. */
	data class Hello(override val connectionGeneration: Long) : ContentSendGuard

	/**
	 * One subscribe: valid only while that connection generation is live and this
	 * endpoint has not recorded stop intent for this subscription.
	 */
	data class Subscribe(
		override val connectionGeneration: Long,
		val subscriptionId: String,
	) : ContentSendGuard

	/**
	 * One resize: valid only for the newest resize epoch of this subscription. An
	 * older pending resize is dropped rather than delivered behind a newer one.
	 */
	data class Resize(
		override val connectionGeneration: Long,
		val subscriptionId: String,
		val resizeEpoch: Long,
	) : ContentSendGuard

	/**
	 * One retirement notice: valid only for the subscription this endpoint actually
	 * handed to the transport, and still attempted after stop intent is recorded.
	 */
	data class Unsubscribe(
		override val connectionGeneration: Long,
		val subscriptionId: String,
	) : ContentSendGuard

	/**
	 * One fixed protocol refusal: valid only while that connection generation is live.
	 *
	 * This is the one effect that stays dispatchable after the endpoint retires, because
	 * delivering it is what makes the failure observable to the owner.
	 */
	data class ProtocolError(override val connectionGeneration: Long) : ContentSendGuard

	/**
	 * One page of one admitted logical input: valid only while this exact input
	 * lifetime is uninvalidated. It carries no global epoch, so retiring one input
	 * never disturbs a control write.
	 */
	data class Input(
		override val connectionGeneration: Long,
		val subscriptionId: String,
		val inputId: String,
		val inputGeneration: Long,
	) : ContentSendGuard
}

/**
 * One outbound frame the caller must serialize over the real transport.
 *
 * The endpoint never writes anything itself: it produces effects, and the caller
 * (or its adapter) owns ordering, backpressure, and the actual socket. [effectId]
 * is the only handle the caller needs to report the truthful send phase back.
 *
 * The caller must report exactly one terminal phase for every effect it is given.
 * If re-checking [ContentSendGuard] says the effect is stale, the caller never
 * invokes the write and reports [ContentSendPhase.DROPPED]; silence would leave a
 * superseded resize slot or input page unreleased until a later step.
 */
data class ContentSendEffect(
	val effectId: Long,
	val frame: ContentFrame,
	val guard: ContentSendGuard,
)

/**
 * What the transport reports about one effect, at the moment each thing actually
 * happens. These are the callbacks that keep an outcome truthful:
 *
 * - `INVOKED` fires when the write was entered; after it, "definitely not sent"
 *   is no longer an honest answer.
 * - `COMPLETED` fires when the local write returned.
 * - `FAILED` fires when the write rejected, timed out, or the channel was lost
 *   with the result unknown.
 * - `DROPPED` fires when the transport re-consumed the guard and found it stale,
 *   so the write was NEVER invoked. This is how a superseded resize page or a
 *   blocked input page is released without inventing a send: the endpoint frees
 *   its bookkeeping and settles the operation truthfully.
 */
enum class ContentSendPhase { INVOKED, COMPLETED, FAILED, DROPPED }

/** Fixed reasons an input was refused before any write was even attempted. */
enum class ContentNotSentReason {
	/** The extension was never offered or never acknowledged. */
	NOT_NEGOTIATED,

	/** The subscription acknowledgement or a published view is missing. */
	NOT_READY,

	/** The expected source is not this endpoint's own current published source. */
	STALE_SOURCE,

	/** The expected modes are not the modes of that same published view. */
	STALE_MODES,

	/** The caller's dynamic written-source/focus/coverage proof refused. */
	UNAUTHORIZED,

	/** The live remote input/copy preference is Off. */
	POLICY_DISABLED,

	/** The written receipt was composed under an older preference generation. */
	POLICY_STALE,

	/** No frame the caller actually committed matches the current publication. */
	NO_WRITTEN_FRAME,

	/** A resize is pending, so what the caller last committed is no longer what it sees. */
	STALE_RESIZE,

	/** The bound of admitted-but-unsettled logical input operations is full. */
	BUSY,

	/** The payload is not a well-formed packet of the stated kind. */
	INVALID_INPUT,

	/** The payload exceeds a fixed bound; it is never truncated. */
	TOO_LARGE,

	/** The endpoint is stopping or retired. */
	STOPPED,
	;
}

/**
 * The truthful outcome of one admitted logical input.
 *
 * `SUBMITTED` means every local transport write of this logical input returned;
 * it says nothing about the child having processed a byte. `NOT_SENT` is only ever
 * produced before any write was invoked. `UNKNOWN` covers every case where a write
 * may already have happened and its full return is not known. There is no retry,
 * replay, reconnect, or optimistic success anywhere.
 */
sealed interface ContentSendOutcome {
	/** Every local write of this logical input returned. */
	data object Submitted : ContentSendOutcome

	/** Nothing was written, and this is known because no write was ever invoked. */
	data class NotSent(val reason: ContentNotSentReason) : ContentSendOutcome

	/** A write may have happened and its full return is not known. */
	data object Unknown : ContentSendOutcome
}

/** One atomically assembled native text copy, bound to this endpoint. */
data class ContentCopyReceipt(
	val hostId: HostId,
	val selectionGeneration: Long,
	val subscriptionId: String,
	val copyId: String,
	/** Emission order per binding; copies are ordered by this, never by [dispatchId]. */
	val sequence: Long,
	val source: NativeIoSource,
	/** Native input dispatch that caused this copy. Informational only. */
	val dispatchId: Long,
	/** Canonical base64 text or a fixed unavailable reason; never a raw OSC 52 byte. */
	val event: NativeIoCopyEvent,
)

/**
 * Something the caller should learn about one step.
 *
 * Events are returned to the caller and dispatched by the caller: the endpoint
 * holds no lock while anything outside it runs, and no event carries a callback.
 */
sealed interface ContentEndpointEvent {
	/** This endpoint's exact `hello_ack` was accepted with these capabilities. */
	data class HelloAccepted(val capabilities: List<String>) : ContentEndpointEvent

	/** This endpoint's exact `subscribed` acknowledgement was accepted. */
	data object Subscribed : ContentEndpointEvent

	/** One complete viewport became current. */
	data class SnapshotPublished(val snapshot: ContentSnapshot) : ContentEndpointEvent

	/** The published view stopped being current. */
	data class ViewCleared(val reason: ContentUnavailableReason) : ContentEndpointEvent

	/** One copy assembled atomically and is still this viewer's current source. */
	data class CopyDelivered(val copy: ContentCopyReceipt) : ContentEndpointEvent

	/** One copy's header source stopped being current; its pages stay consumed, unrouted. */
	data class CopyWithheld(val copyId: String) : ContentEndpointEvent

	/** One admitted logical input reached its final, truthful outcome. */
	data class InputSettled(val inputId: String, val ordinal: Long, val outcome: ContentSendOutcome) :
		ContentEndpointEvent

	/** The endpoint retired. Nothing after this can make it current again. */
	data class Retired(val reason: ContentUnavailableReason) : ContentEndpointEvent
}

/**
 * The result of one synchronous endpoint entrypoint: the new observation plus the
 * effects and events the caller must act on.
 *
 * [deadlines] is the complete armed-deadline set after the step. The coordinator
 * arms exactly these and cancels any kind it holds that is absent, which is how a
 * timer is guaranteed never to outlive the step that disarmed it.
 */
data class ContentEndpointStep(
	val observation: ContentEndpointObservation,
	val effects: List<ContentSendEffect>,
	val events: List<ContentEndpointEvent>,
	val deadlines: List<ContentDeadline>,
)

/** The caller's live remote input/copy preference. */
data class ContentInputPolicy(val enabled: Boolean, val generation: Long) {
	init {
		require(generation >= 0L) { "content input policy generation is invalid" }
	}
}

/** The rectangle inside the native pane one written frame actually filled. */
data class ContentPaneRect(
	val column: Int,
	val row: Int,
	val cols: Int,
	val rows: Int,
) {
	init {
		require(column >= 0 && row >= 0) { "content pane rect origin is invalid" }
		require(cols >= 0 && rows >= 0) { "content pane rect size is invalid" }
	}
}

/**
 * Immutable receipt of the ONE remote source a frame the caller committed ACTUALLY
 * drew.
 *
 * A receipt exists only through [ContentEndpoint.recordWrittenFrame]: the endpoint
 * never invents one, and a queued, held, or superseded candidate never becomes
 * one. It carries no permission by itself — every attempt re-proves the current
 * publication, the caller's proof, the live policy generation, and the pending
 * resize epoch.
 *
 * A receipt names the semantic input context it was drawn under ([inputGeneration]),
 * not merely one publish: a later publication with the same source, modes, and
 * geometry (ordinary terminal output) leaves it standing, while any semantic change
 * advances the generation and retires it for good — an exact A → B → A return
 * included.
 */
data class WrittenRemoteContent(
	val hostId: HostId,
	val hostRunId: String,
	val rowId: String,
	val selectionGeneration: Long,
	val subscriptionId: String,
	/** Publish sequence of the frame that was actually committed. */
	val sequence: Long,
	/** Exact host-written source of that drawn viewport. */
	val source: NativeIoInputSource,
	/** Exact observed input modes of that same drawn publish. */
	val inputModes: TerminalInputModes,
	/** Canonical size/revision the drawn content came from. */
	val geometry: SessionGeometry,
	/** The rectangle the written frame actually filled. */
	val nativeContent: ContentPaneRect,
	/** Resize epoch of the frame that was actually written. */
	val resizeEpoch: Long,
	/** Policy generation this frame was composed under. */
	val policyGeneration: Long,
	/** The endpoint's monotonic semantic input generation the drawn publish belonged to. */
	val inputGeneration: Long,
)

/**
 * The caller's proof that it committed one exact published frame.
 *
 * The caller supplies the thread-safe current focus, coverage, and lifecycle
 * facts; recording the commit registers a receipt and never invents authority.
 */
data class ContentWrittenFrameProof(
	val selectionGeneration: Long,
	val subscriptionId: String,
	/** Publish sequence of the frame the caller actually committed. */
	val sequence: Long,
	/** Canonical geometry the caller drew from. */
	val geometry: SessionGeometry,
	/** The caller's current resize epoch for this pane. */
	val resizeEpoch: Long,
	/** The policy generation the caller composed under. */
	val policyGeneration: Long,
	/** The rectangle inside the native pane the written frame actually filled. */
	val nativeContent: ContentPaneRect,
	/**
	 * The endpoint's semantic input generation the committed publish was observed
	 * under. A commit drawn under any other generation — an older context, even one
	 * that reads the same again after A → B → A — is never registered.
	 */
	val inputGeneration: Long,
)

/** Outcome of one written-frame registration attempt. */
sealed interface ContentWrittenFrameOutcome {
	/** The proof matched the exact current publication; this is the new receipt. */
	data class Registered(val receipt: WrittenRemoteContent) : ContentWrittenFrameOutcome

	/** One fixed reason this commit does not describe the current publication. */
	data class Rejected(val reason: ContentWrittenFrameRejectReason) : ContentWrittenFrameOutcome
}

/** Fixed reasons a written-frame commit does not describe the current publication. */
enum class ContentWrittenFrameRejectReason {
	/** No complete current view exists to have been drawn. */
	NO_VIEW,

	/**
	 * The proof names a publish outside the current semantic input context: a future
	 * sequence, one published before the current context began, or another input
	 * generation.
	 */
	SEQUENCE_MISMATCH,

	/** The proof names another selection, subscription, run, or row. */
	BINDING_MISMATCH,

	/** The proof's geometry is not the geometry of the current publish. */
	GEOMETRY_MISMATCH,

	/** A resize is pending, so this commit is not the newest thing the caller sees. */
	RESIZE_EPOCH_STALE,

	/** The proof's policy generation is not the live one. */
	POLICY_STALE,

	/** The endpoint is stopping or retired. */
	STOPPED,

	/** The current publish states no host-written source, so there is nothing to record. */
	NO_SOURCE,
	;
}

/** One caller-normalized native input submission against one exact source. */
data class ContentInputRequest(
	/** Exact expected source (conversation or startup) of the current published view. */
	val source: NativeIoInputSource,
	/** Exact expected observed input modes of that same current snapshot. */
	val inputModes: TerminalInputModes,
	val kind: NativeIoInputKind,
	/**
	 * Already-normalized payload: one protocol keyboard packet, the UTF-8 text body
	 * of a paste (at most 1 MiB decoded), or one canonical content-space SGR mouse
	 * report. Never a system clipboard read, a raw OSC byte stream, or an
	 * image/file payload.
	 */
	val text: String,
)

/** Result of admitting one logical input operation. */
sealed interface ContentInputAdmission {
	/**
	 * Admitted: [effects] are this operation's frames in wire order and must be
	 * serialized by the caller in that order, one operation at a time, so a paste's
	 * pages never interleave another input's pages. Its final outcome arrives later
	 * as [ContentEndpointEvent.InputSettled].
	 */
	data class Accepted(
		val inputId: String,
		val ordinal: Long,
		val effects: List<ContentSendEffect>,
	) : ContentInputAdmission

	/** Refused before anything was staged; no effect exists and none will. */
	data class Refused(val reason: ContentNotSentReason) : ContentInputAdmission
}
