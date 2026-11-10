package io.github.rfairburn.pireviewgate.core.input

/** Why the last drawn frame stopped being eligible to fence input. */
enum class FrameInvalidationReason {
	BINDING_CHANGED,
	LAYOUT_CHANGED,
	LIFECYCLE_SUSPENDED,
	HIDDEN,
	OBSCURED,
	FOCUS_LOST,
	DETACHED,
	POLICY_STALE,
	MODAL_SUSPENDED,
	USER_INPUT_DISABLED,

	/**
	 * The pass drew everything the surface could show right now, but the frame is
	 * not complete — a visible image is still being decoded, so neither the image
	 * nor its fallback was on screen. Such a pass is not acknowledged.
	 */
	FRAME_INCOMPLETE,
}

/**
 * One actual frame commit of one bound frame at one layout.
 *
 * [drawEpoch] is the draw pass the platform confirmed, [bindingEpoch] and
 * [layoutEpoch] are the epochs that were current when that pass began, and
 * [commitSequence] increases once per accepted commit. A record is a statement
 * about pixels the platform says it has taken back, not about pixels on a
 * physical display: Android's frame-commit callback means the render thread
 * finished submitting the frame to the swap chain, and nothing here claims more.
 */
data class FrameCommitRecord(
	val bindingEpoch: Long,
	val layoutEpoch: Long,
	val drawEpoch: Long,
	val commitSequence: Long,
)

/**
 * Epoch bookkeeping for "this frame was really drawn, and this is what replaced
 * it".
 *
 * The gate is the portable half of the phone's committed-frame fence: the view
 * feeds it a draw pass and the platform's commit callback, and everything that
 * decides whether input may ride on a frame reads the same epochs. It performs no
 * IO, starts no timer, and holds no reference to any view, so the rules are
 * testable without a device.
 *
 * The rules it enforces:
 *  - a commit only counts for the draw pass it belongs to, and only while the
 *    binding and layout epochs it recorded are still current;
 *  - rebinding, a layout change, or an invalidation retires the committed record
 *    immediately, so no queued work can validate against a frame that is gone;
 *  - identical dimensions after a resize are a new layout epoch, never a revival
 *    of the retired record, because equal sizes alone never identify a viewport;
 *  - a draw pass that never reports back leaves nothing committed.
 */
class CommittedFrameGate {
	private var bindingEpoch = 0L
	private var layoutEpoch = 0L
	private var drawEpoch = 0L
	private var commitSequence = 0L
	private var pendingDrawEpoch: Long? = null
	private var committed: FrameCommitRecord? = null

	/** The last commit the platform confirmed for what is on screen now. */
	val committedRecord: FrameCommitRecord?
		get() = committed

	/** The epoch a new binding must be recorded under. */
	val currentBindingEpoch: Long
		get() = bindingEpoch

	/** The epoch the current layout is recorded under. */
	val currentLayoutEpoch: Long
		get() = layoutEpoch

	/** True when a draw pass is waiting for the platform's commit callback. */
	val hasPendingDraw: Boolean
		get() = pendingDrawEpoch != null

	/**
	 * Record a new binding. The previous commit and any in-flight draw pass stop
	 * existing: a different host, connection, selection, subscription, source,
	 * policy generation, or frame is a different surface even when every visible
	 * dimension is the same.
	 */
	fun rebind() {
		bindingEpoch += 1
		layoutEpoch += 1
		pendingDrawEpoch = null
		committed = null
	}

	/**
	 * Record a layout change (measured size, insets, cell metrics, or a new
	 * frame laid out into a different grid) and retire the previous commit.
	 */
	fun invalidateLayout() {
		layoutEpoch += 1
		pendingDrawEpoch = null
		committed = null
	}

	/** Retire the commit without changing layout, for lifecycle or policy loss. */
	fun invalidateCommit(reason: FrameInvalidationReason) {
		if (reason == FrameInvalidationReason.LAYOUT_CHANGED ||
			reason == FrameInvalidationReason.BINDING_CHANGED
		) {
			invalidateLayout()
			return
		}
		pendingDrawEpoch = null
		committed = null
	}

	/**
	 * Begin a draw pass and return its epoch. The pass is the only thing a later
	 * commit can answer for; a pass that is superseded or invalidated never
	 * produces a record.
	 */
	fun beginDraw(): Long {
		drawEpoch += 1
		pendingDrawEpoch = drawEpoch
		return drawEpoch
	}

	/**
	 * Accept the platform's confirmation that draw pass [drawEpoch] was
	 * submitted, or null when that pass is no longer current.
	 *
	 * [eligible] carries the surface's own state: a commit that landed while the
	 * view is detached, hidden, unfocused, covered, or suspended records nothing
	 * and retires whatever was committed before. Otherwise a frame drawn behind a
	 * modal would be waiting there, valid, the moment input came back.
	 */
	fun onFrameCommit(drawEpoch: Long, eligible: Boolean = true): FrameCommitRecord? {
		if (pendingDrawEpoch != drawEpoch) return null
		pendingDrawEpoch = null
		if (!eligible) {
			committed = null
			return null
		}
		commitSequence += 1
		val record = FrameCommitRecord(
			bindingEpoch = bindingEpoch,
			layoutEpoch = layoutEpoch,
			drawEpoch = drawEpoch,
			commitSequence = commitSequence,
		)
		committed = record
		return record
	}

	/** True when [record] is exactly what is committed right now. */
	fun isCurrent(record: FrameCommitRecord?): Boolean = record != null && record == committed

	/** True when [record] was produced by the current binding. */
	fun isCurrentBinding(record: FrameCommitRecord?): Boolean =
		record != null && record.bindingEpoch == bindingEpoch
}
