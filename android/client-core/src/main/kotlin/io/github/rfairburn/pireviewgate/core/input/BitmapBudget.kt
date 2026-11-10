package io.github.rfairburn.pireviewgate.core.input

/**
 * An aggregate cap on retained decoded bitmaps.
 *
 * A per-image limit is not enough: one frame can carry many placements, and a
 * surface that decoded each of them without a shared ceiling can retain enough
 * pixels to be killed while every individual image looked affordable. Reserving
 * before a bitmap is kept, and releasing when it goes away, is what makes the
 * whole surface bounded rather than each piece of it.
 */
class BitmapBudget(private val maxBytes: Long) {
	private var reserved = 0L

	/** Bytes currently held. */
	val reservedBytes: Long
		get() = reserved

	/** Bytes still available. */
	val availableBytes: Long
		get() = (maxBytes - reserved).coerceAtLeast(0L)

	/**
	 * Reserve [bytes] for a bitmap that is about to be retained. False when the
	 * request is not a positive size, exceeds the whole budget on its own, or no
	 * longer fits — in which case the caller draws the frame's fallback instead.
	 */
	fun tryReserve(bytes: Long): Boolean {
		if (bytes <= 0L) return false
		if (bytes > maxBytes - reserved) return false
		reserved += bytes
		return true
	}

	/** Return [bytes] when a retained bitmap is recycled. */
	fun release(bytes: Long) {
		if (bytes <= 0L) return
		reserved = (reserved - bytes).coerceAtLeast(0L)
	}

	/** Return everything, for example when a frame or binding is replaced. */
	fun releaseAll() {
		reserved = 0L
	}
}
