package io.github.rfairburn.pireviewgate.core.input

/** The fixed reasons the surface itself is not in a state to carry input. */
enum class InputBlockReason {
	DETACHED,
	NOT_VISIBLE,
	WINDOW_NOT_VISIBLE,
	WINDOW_NOT_FOCUSED,
	NOT_FOCUSED,
	MODAL_SUSPENDED,
	USER_INPUT_DISABLED,
}

/**
 * The view-state half of the input fence, as plain state.
 *
 * One predicate answers for every decision the surface makes about input: whether
 * a platform commit may be recorded as a receipt, whether a keystroke may be
 * emitted, and whether the caller's [verifyReceipt] style check passes. Keeping it
 * as data rather than a chain of view callbacks is what makes the ordering
 * testable, and it is deliberately conservative: the surface only ever says yes
 * when every condition holds right now, never when one merely held before.
 *
 * Suspension matters in both directions. While a modal owns input, or the caller
 * turned input off, no commit is recorded — so resuming cannot hand back a receipt
 * drawn during the suspension. The surface has to be drawn again, while eligible,
 * before it can attest to anything.
 */
class InputEligibility(
	var attached: Boolean = false,
	var viewVisible: Boolean = false,
	var windowVisible: Boolean = false,
	var windowFocused: Boolean = false,
	var focused: Boolean = false,
	var modalSuspended: Boolean = false,
	var userInputEnabled: Boolean = true,
) {
	/** The first unmet condition, or null when input may be carried. */
	fun blockReason(): InputBlockReason? = when {
		!attached -> InputBlockReason.DETACHED
		!viewVisible -> InputBlockReason.NOT_VISIBLE
		!windowVisible -> InputBlockReason.WINDOW_NOT_VISIBLE
		!windowFocused -> InputBlockReason.WINDOW_NOT_FOCUSED
		!focused -> InputBlockReason.NOT_FOCUSED
		modalSuspended -> InputBlockReason.MODAL_SUSPENDED
		!userInputEnabled -> InputBlockReason.USER_INPUT_DISABLED
		else -> null
	}

	/** True when every condition for carrying input holds right now. */
	val isEligible: Boolean
		get() = blockReason() == null
}
