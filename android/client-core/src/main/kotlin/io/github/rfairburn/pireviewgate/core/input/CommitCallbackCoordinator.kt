package io.github.rfairburn.pireviewgate.core.input

/**
 * Which draw pass the platform still owes a commit callback for.
 *
 * The Android frame-commit callback is one-shot and arrives whenever the render
 * thread gets to it, so a surface that draws repeatedly can easily have an old
 * pass report after a newer one began, or a canceled pass report after its frame
 * was retired. Each [begin] hands back an immutable [Registration]; only the
 * newest one is live, a withdrawn or superseded registration reports nothing, and
 * a live one reports exactly once. The Android side registers a callback that
 * closes over its own registration, so a captured callback can never consume a
 * later request's draw epoch.
 */
class CommitCallbackCoordinator(private val onCommit: (drawEpoch: Long) -> Unit) {
	private var active: Registration? = null

	/** One draw pass awaiting its platform confirmation. */
	inner class Registration(val drawEpoch: Long) {
		/** Deliver the platform's confirmation, if this pass is still the live one. */
		fun report() {
			if (active !== this) return
			active = null
			onCommit(drawEpoch)
		}
	}

	/** Begin a pass; any earlier registration stops being able to report. */
	fun begin(drawEpoch: Long): Registration {
		val registration = Registration(drawEpoch)
		active = registration
		return registration
	}

	/** Withdraw the live registration, for example when a frame is retired. */
	fun withdraw() {
		active = null
	}

	/** True while a pass is awaiting confirmation. */
	val hasActiveRegistration: Boolean
		get() = active != null

	/** The draw epoch currently owed a confirmation, if any. */
	val activeDrawEpoch: Long?
		get() = active?.drawEpoch
}
