package io.github.rfairburn.pireviewgate.core.input

/**
 * The bounded bookkeeping between handing an input off and hearing how it settled.
 *
 * At most [limit] inputs are being admitted or awaiting settlement at once. Past that,
 * the next one is refused as busy rather than queued. A settlement can arrive before the
 * admission that names it has been recorded. While its scope still has admissions in
 * progress, it is held as early and handed to that admission. Once nothing in the scope is
 * being admitted, early settlements for it are dropped, since nothing could claim them.
 *
 * Each accepted input carries a [Notice], which its caller uses to hear how that input
 * settled. The book never runs a notice itself.
 *
 * Not thread-safe: the caller uses it from one thread.
 */
class InputSettlementBook<Scope, Key, Outcome, Notice>(
	private val limit: Int,
	private val scopeOf: (Key) -> Scope,
) {
	private val admitting = mutableMapOf<Scope, Int>()
	private val accepted = LinkedHashMap<Key, Notice>()
	private val early = LinkedHashMap<Key, Outcome>()

	/** True, and counted as admitting, unless [limit] inputs are already outstanding. */
	fun reserve(scope: Scope): Boolean {
		if (accepted.size + admitting.values.sum() >= limit) return false
		admitting[scope] = (admitting[scope] ?: 0) + 1
		return true
	}

	/**
	 * [key] was admitted. Returns the settlement that already arrived for it, or null
	 * after recording [notice] for the settlement that is still to come.
	 */
	fun admitted(key: Key, notice: Notice): Outcome? {
		val settled = early.remove(key)
		if (settled == null) accepted[key] = notice
		return settled
	}

	/** One admission in [scope] finished, however it ended. */
	fun release(scope: Scope) {
		val remaining = (admitting[scope] ?: 1) - 1
		if (remaining <= 0) {
			admitting.remove(scope)
			early.keys.removeAll { scopeOf(it) == scope }
		} else {
			admitting[scope] = remaining
		}
	}

	/**
	 * [key] settled with [outcome]. Returns the notice of the accepted input it settles,
	 * or null when it is held as early or names nothing outstanding.
	 */
	fun settle(key: Key, outcome: Outcome): Notice? {
		if (accepted.containsKey(key)) return accepted.remove(key)
		if ((admitting[scopeOf(key)] ?: 0) > 0) {
			check(early.size < limit)
			early[key] = outcome
		}
		return null
	}

	/** How many inputs are being admitted or awaiting settlement. */
	val outstanding: Int
		get() = accepted.size + admitting.values.sum()
}
