package io.github.rfairburn.pireviewgate.ui.terminal

import io.github.rfairburn.pireviewgate.core.input.InputSourceFence
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes

/**
 * The one stable identity of what a terminal surface is currently showing.
 *
 * Every field is carried forward verbatim from the content lane so a receipt can
 * be checked against the caller's own state without re-deriving anything:
 *  - [hostId], [connectionGeneration], and [selectionGeneration] say which host,
 *    which connection to it, and which user selection this surface belongs to;
 *  - [subscriptionId], [ownerRun], and [rowId] name the subscription and the
 *    owner row it publishes;
 *  - [publishSequence] is the publish this frame came from, so a later publish
 *    can never be mistaken for an earlier one;
 *  - [geometry] is the owner's session geometry including its revision, because
 *    equal dimensions alone never identify a viewport;
 *  - [source] is the host-written input source of this publish, and is what an
 *    input frame must echo. It carries no authority by itself. It is null when the
 *    publish states no source at all, which is a display-only view of the same
 *    complete frame — see [isDisplayOnly];
 *  - [modes] is the input state observed on this very frame, which is what
 *    keyboard and mouse packets must be encoded against;
 *  - [policyGeneration] is the caller's policy snapshot stamp, so a policy change
 *    retires the frame without the surface having to know what a policy is;
 *  - [frame] is the validated viewport content itself;
 *  - [inputGeneration] is the content lane's monotonic semantic input generation
 *    (source, modes, geometry), so an A → B → A return — even one whose intermediate
 *    B publication was never installed here — is a different input context;
 *  - [resizeEpoch] is the content lane's viewer resize epoch the frame was observed
 *    under, so a resize request retires input attribution before any reflow arrives.
 *
 * ## Input context
 *
 * [sameInputContextAs] is the one rule for "ordinary output": a newer publish of the
 * same target with an identical source, geometry, modes, policy, frame extents, input
 * generation, and resize epoch only changes what is displayed. A surface keeps the
 * input proof it genuinely committed for that context and keeps drawing the newer
 * frames; anything else is a new context that retires the proof.
 *
 * The surface never sends a byte for this binding and never writes a clipboard:
 * it renders and reports. A later integration owns the socket and the copy path.
 *
 * A binding with no [source] is not a degraded or partial binding: the frame, its
 * geometry, and [modes] describe everything the surface draws, so a source-less
 * publish is laid out, drawn, and reported exactly like any other. What a source
 * governs is input attribution, so a source-less binding is drawn and denies every
 * keystroke, paste, pointer report, and copy — the surface never invents a source,
 * a receipt, or any other stand-in for one it was not given.
 */
data class TerminalViewBinding(
	val hostId: String,
	val connectionGeneration: Long,
	val selectionGeneration: Long,
	val subscriptionId: String,
	/** The owner run hosting the session; the source's own host run. */
	val ownerRun: String,
	/** Owner row id of the session, never a native conversation id. */
	val rowId: String,
	val publishSequence: Long,
	val geometry: SessionGeometry,
	val source: NativeIoInputSource?,
	val modes: TerminalInputModes,
	val policyGeneration: Long,
	val frame: TerminalFrame,
	/** Monotonic semantic input generation of the content lane this frame came from. */
	val inputGeneration: Long = 0L,
	/** Viewer resize epoch of the content lane this frame was observed under. */
	val resizeEpoch: Long = 0L,
) {
	init {
		require(hostId.isNotEmpty()) { "a binding needs its host" }
		require(subscriptionId.isNotEmpty()) { "a binding needs its subscription" }
		require(ownerRun.isNotEmpty()) { "a binding needs its owner run" }
		require(rowId.isNotEmpty()) { "a binding needs its owner row" }
		require(publishSequence > 0L) { "publish sequences are positive" }
		require(connectionGeneration >= 0L) { "connection generations are non-negative" }
		require(selectionGeneration >= 0L) { "selection generations are non-negative" }
		require(policyGeneration >= 0L) { "policy generations are non-negative" }
		require(inputGeneration >= 0L) { "input generations are non-negative" }
		require(resizeEpoch >= 0L) { "resize epochs are non-negative" }
		require(frame.cols > 0 && frame.rows > 0) { "a viewport has positive dimensions" }
		require(frame.lines.size == frame.rows) { "a viewport carries one line per row" }
	}

	/**
	 * True when this publish states no input source, so the surface may draw it and
	 * nothing may be typed against it.
	 */
	val isDisplayOnly: Boolean
		get() = source == null

	/**
	 * True when the binding's own source agrees with its host run and owner row.
	 *
	 * A binding with no source agrees with itself: there is nothing stated, so there
	 * is nothing to contradict, and the frame stays renderable. A non-null source
	 * that names another run or row never agrees, and such a binding is refused
	 * exactly as before.
	 */
	fun sourceMatches(): Boolean {
		val stated = source ?: return true
		return stated.hostRunId == ownerRun && stated.sessionId == rowId
	}

	/**
	 * True when [other] is the same target: the same host, connection, selection,
	 * subscription, owner run, and owner row, with a source that is the same source
	 * — including both being absent.
	 *
	 * A later publish of the same target is not a new target, which is what keeps
	 * state the user set down (a latched modifier chip, say) across a re-publication
	 * of the same viewport, while a switch of session, native tuple, or source state
	 * is a new target and retires it.
	 */
	fun sameTargetAs(other: TerminalViewBinding?): Boolean {
		if (this === other) return true
		if (other == null) return false
		return hostId == other.hostId &&
			connectionGeneration == other.connectionGeneration &&
			selectionGeneration == other.selectionGeneration &&
			subscriptionId == other.subscriptionId &&
			ownerRun == other.ownerRun &&
			rowId == other.rowId &&
			InputSourceFence.isSameSource(source, other.source)
	}

	/**
	 * True when [other] is the same semantic input context: the same target and
	 * source ([sameTargetAs]) with identical geometry, modes, policy generation, frame
	 * extents, input generation, and resize epoch. Only [publishSequence] and the
	 * frame's displayed content may differ — that is ordinary output.
	 */
	fun sameInputContextAs(other: TerminalViewBinding?): Boolean {
		if (other == null || !sameTargetAs(other)) return false
		return geometry == other.geometry &&
			modes == other.modes &&
			policyGeneration == other.policyGeneration &&
			frame.cols == other.frame.cols &&
			frame.rows == other.frame.rows &&
			inputGeneration == other.inputGeneration &&
			resizeEpoch == other.resizeEpoch
	}

	companion object {
		/**
		 * The source a binding should carry for one published view.
		 *
		 * This is the codec's own tri-state read as the surface needs it: the exact
		 * host-written source when the publish stated one, and null — display only,
		 * never a stand-in — when the wire key was absent or the owner stated it has
		 * none. No new wire field is involved.
		 */
		fun sourceOf(published: OptionalNativeIoSource): NativeIoInputSource? =
			(published as? OptionalNativeIoSource.Stated)?.source
	}
}
