package io.github.rfairburn.pireviewgate.core.input

/**
 * Whether one physical key event has already been carried through.
 *
 * A hardware keystroke can reach a surface by more than one route: an input method
 * may forward it, and the same press may also be dispatched to the view directly.
 * Emitting both would type the character twice, so the surface keeps a one-event
 * ledger. It tracks only the most recent press rather than a history, because a
 * duplicate, if it comes at all, comes immediately — and an auto-repeat is a
 * distinct delivery, which is why the repeat count belongs to the identity.
 */
class KeyDeliveryLedger {
	private var downTime = -1L
	private var keyCode = -1
	private var action = -1
	private var repeatCount = -1

	/**
	 * True when this exact event was already accepted. The event is recorded either
	 * way, so a caller that accepts on the first call refuses the second.
	 */
	fun alreadyDelivered(downTime: Long, keyCode: Int, action: Int, repeatCount: Int): Boolean {
		val duplicate = downTime == this.downTime &&
			keyCode == this.keyCode &&
			action == this.action &&
			repeatCount == this.repeatCount
		this.downTime = downTime
		this.keyCode = keyCode
		this.action = action
		this.repeatCount = repeatCount
		return duplicate
	}
}
