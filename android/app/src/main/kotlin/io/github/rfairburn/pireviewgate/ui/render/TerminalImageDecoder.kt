package io.github.rfairburn.pireviewgate.ui.render

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import io.github.rfairburn.pireviewgate.core.input.DeliverySlots
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** One decoded image, tagged with the generation and image it was decoded for. */
data class DecodedImage(
	val generation: Long,
	val imageId: String,
	val bitmap: Bitmap,
	val widthPx: Int,
	val heightPx: Int,
)

/**
 * Off-thread PNG decoding for typed image placements.
 *
 * Decoding never happens on the UI thread, never reads a URI, file, or network
 * resource, and never accepts bytes that were not handed to it: the payload is
 * the base64 the frame already carries. Every request is tagged with a
 * [generation]; a result whose generation is no longer wanted is dropped before
 * it reaches the caller, so a decode that finishes after a resize, a new frame,
 * or a new binding can never paint over a surface that stopped asking for it.
 *
 * Memory stays bounded three ways. The bitmap is downsampled to the placement's
 * own pixel size rather than decoded at full resolution; an image whose estimated
 * footprint still exceeds [maxBitmapBytesPerImage] is refused, and the caller then
 * draws the frame's payload-free fallback for that placement, which is the honest
 * outcome rather than a half-decoded image or an out-of-memory crash; and a
 * finished bitmap holds a [DeliverySlots] permit until the caller has taken it, so
 * a busy UI thread cannot end up with a queue full of allocations that no owner-side
 * budget has ever seen.
 *
 * [deliverOnMain] exists so the hand-off can be exercised with a stalled or failing
 * sink; it defaults to the main thread's handler.
 */
class TerminalImageDecoder(
	private val maxBitmapBytesPerImage: Long = DEFAULT_MAX_BITMAP_BYTES,
	deliverOnMain: ((Runnable) -> Boolean)? = null,
) {
	private val executor = Executors.newSingleThreadExecutor { runnable ->
		Thread(runnable, "terminal-image-decode").apply { isDaemon = true }
	}
	private val mainHandler = Handler(Looper.getMainLooper())
	private val deliver: (Runnable) -> Boolean = deliverOnMain ?: { runnable -> mainHandler.post(runnable) }
	private val deliverySlots = DeliverySlots()
	private val closed = AtomicBoolean(false)
	private val currentGeneration = AtomicLong(0)

	/** The next generation tag. */
	fun nextGeneration(): Long = currentGeneration.incrementAndGet()

	/**
	 * Decode [base64] for [imageId] at roughly [targetWidthPx] by
	 * [targetHeightPx], then deliver the result on the main thread with the same
	 * [generation] it was requested with. A null result means the payload could
	 * not be used and the caller must fall back.
	 */
	fun decode(
		generation: Long,
		imageId: String,
		base64: String,
		targetWidthPx: Int,
		targetHeightPx: Int,
		onReady: (DecodedImage?) -> Unit,
	) {
		if (closed.get()) return
		if (generation < currentGeneration.get()) return
		executor.execute {
			// The permit is held across the allocation and the hand-off, so at most
			// one finished bitmap can exist outside the caller's budget at a time.
			if (!deliverySlots.acquire()) return@execute
			var handedOff = false
			try {
				val decoded = if (closed.get() || generation < currentGeneration.get()) {
					null
				} else {
					runCatching {
						decodeNow(generation, imageId, base64, targetWidthPx, targetHeightPx)
					}.getOrNull()
				}
				if (closed.get() || generation < currentGeneration.get()) {
					decoded?.bitmap?.recycle()
					return@execute
				}
				handedOff = deliver {
					try {
						if (closed.get() || generation < currentGeneration.get()) {
							decoded?.bitmap?.recycle()
						} else {
							onReady(decoded)
						}
					} finally {
						deliverySlots.release()
					}
				}
			} finally {
				if (!handedOff) deliverySlots.release()
			}
		}
	}

	/** Stop accepting work and drop anything still queued. */
	fun close() {
		if (!closed.compareAndSet(false, true)) return
		executor.shutdownNow()
	}

	private fun decodeNow(
		generation: Long,
		imageId: String,
		base64: String,
		targetWidthPx: Int,
		targetHeightPx: Int,
	): DecodedImage? {
		if (base64.isEmpty() || base64.length % 4 != 0) return null
		val bytes = runCatching { java.util.Base64.getDecoder().decode(base64) }.getOrNull() ?: return null
		if (bytes.isEmpty()) return null

		val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
		BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
		val boundsWidth = bounds.outWidth
		val boundsHeight = bounds.outHeight
		if (boundsWidth <= 0 || boundsHeight <= 0) return null

		val sampleSize = sampleSizeFor(boundsWidth, boundsHeight, targetWidthPx, targetHeightPx) ?: return null
		val options = BitmapFactory.Options().apply {
			inJustDecodeBounds = false
			inSampleSize = sampleSize
			inPreferredConfig = Bitmap.Config.ARGB_8888
			inMutable = false
		}
		val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
		if (bitmap.byteCount.toLong() > maxBitmapBytesPerImage) {
			bitmap.recycle()
			return null
		}
		return DecodedImage(
			generation = generation,
			imageId = imageId,
			bitmap = bitmap,
			widthPx = bitmap.width,
			heightPx = bitmap.height,
		)
	}

	/**
	 * The power-of-two sample that keeps the decoded bitmap near the size the
	 * placement can show, or null when even the largest sample would not fit the
	 * memory bound.
	 */
	private fun sampleSizeFor(
		boundsWidth: Int,
		boundsHeight: Int,
		targetWidthPx: Int,
		targetHeightPx: Int,
	): Int? {
		var sample = 1
		val widthTarget = if (targetWidthPx > 0) targetWidthPx else boundsWidth
		val heightTarget = if (targetHeightPx > 0) targetHeightPx else boundsHeight
		while (boundsWidth / (sample * 2) >= widthTarget && boundsHeight / (sample * 2) >= heightTarget) {
			sample *= 2
		}
		while (sample <= MAX_SAMPLE &&
			(boundsWidth / sample).toLong() * (boundsHeight / sample).toLong() * BYTES_PER_PIXEL > maxBitmapBytesPerImage
		) {
			sample *= 2
		}
		if ((boundsWidth / sample).toLong() * (boundsHeight / sample).toLong() * BYTES_PER_PIXEL > maxBitmapBytesPerImage) {
			return null
		}
		return sample
	}

	private companion object {
		private const val BYTES_PER_PIXEL = 4L
		private const val MAX_SAMPLE = 128

		/** Two megapixels of ARGB, comfortably above any phone-sized placement. */
		const val DEFAULT_MAX_BITMAP_BYTES: Long = 8L * 1024L * 1024L
	}

}
